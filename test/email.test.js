/**
 * E-mail delivery end to end: a real SMTP server runs inside the test, the API sends the verification e-mail
 * to it, and the code / link are read back from the received message. The Resend HTTP provider is tested with
 * a stubbed fetch. Uses its own database (tourism_recsys_mail_test), dropped afterwards.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SMTPServer } from 'smtp-server';
import { config } from '../src/config.js';
import { connect, close, ensureIndexes } from '../src/db.js';
import { createApp } from '../src/app.js';

config.authRateLimit = 10000;
let server;
let base;
let db;
let smtp;
const inbox = [];
const realFetch = globalThis.fetch;

const call = async (method, path, body) => {
  const res = await realFetch(base + path, {
    method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const register = (email) => call('POST', '/api/auth/register', {
  email, password: 'Secret123', profile: { fullName: 'Mail Tester', age: 25, city: 'Astana' },
});
// quoted-printable: soft line breaks and "=3D"
const decode = (raw) => raw.replace(/=\r?\n/g, '').replace(/=3D/g, '=');
const waitForMail = async (to) => {
  for (let i = 0; i < 100; i++) {
    const m = inbox.find((x) => x.to.includes(to));
    if (m) return m;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no e-mail for ${to}`);
};

before(async () => {
  smtp = new SMTPServer({
    authOptional: true, disabledCommands: ['STARTTLS'], logger: false,
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (c) => { raw += c; });
      stream.on('end', () => {
        inbox.push({ to: session.envelope.rcptTo.map((r) => r.address), from: session.envelope.mailFrom.address, raw: decode(raw) });
        cb();
      });
    },
  });
  await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
  config.smtp = { host: '127.0.0.1', port: smtp.server.address().port, secure: false, ignoreTLS: true };
  db = await connect(config.mongoUri, 'tourism_recsys_mail_test');
  await db.dropDatabase();
  await ensureIndexes(db);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((r) => server.close(r));
  await new Promise((r) => smtp.close(r));
  await db.dropDatabase();
  await close();
});

describe('verification e-mail over SMTP', () => {
  test('registration sends a real e-mail; the code is never returned by the API', async () => {
    const health = await call('GET', '/api/health');
    assert.equal(health.body.email, 'smtp');
    const r = await register('smtp.user@test.com');
    assert.equal(r.status, 201);
    assert.equal(r.body.delivery, 'email');
    assert.equal(r.body.demoCode, undefined);
    const mail = await waitForMail('smtp.user@test.com');
    assert.match(mail.raw, /Subject: Your Wayfarer code: \d{6}/);
    assert.match(mail.raw, /\/\?verify=[a-f0-9]{64}/);
  });

  test('the code from the e-mail verifies the account and signs the user in', async () => {
    const mail = await waitForMail('smtp.user@test.com');
    const code = mail.raw.match(/Your Wayfarer code: (\d{6})/)[1];
    assert.equal((await call('POST', '/api/auth/login', { email: 'smtp.user@test.com', password: 'Secret123' })).status, 403);
    const ok = await call('POST', '/api/auth/verify-email', { email: 'smtp.user@test.com', code });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.token);
    assert.equal((await call('POST', '/api/auth/login', { email: 'smtp.user@test.com', password: 'Secret123' })).status, 200);
  });

  test('the link from the e-mail verifies the account', async () => {
    await register('link.user@test.com');
    const mail = await waitForMail('link.user@test.com');
    const token = mail.raw.match(/\?verify=([a-f0-9]{64})/)[1];
    const ok = await call('POST', '/api/auth/verify-email', { token });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.emailVerified, true);
    assert.equal((await call('POST', '/api/auth/verify-email', { token })).status, 400); // single use
  });

  test('resend sends a new e-mail and the old code stops working', async () => {
    await register('resend.user@test.com');
    const first = await waitForMail('resend.user@test.com');
    const oldCode = first.raw.match(/Your Wayfarer code: (\d{6})/)[1];
    inbox.length = 0;
    await db.collection('users').updateOne({ email: 'resend.user@test.com' }, { $set: { 'emailVerification.sentAt': new Date(0) } });
    const r = await call('POST', '/api/auth/resend-verification', { email: 'resend.user@test.com' });
    assert.equal(r.status, 200);
    assert.equal(r.body.demoCode, undefined);
    const second = await waitForMail('resend.user@test.com');
    const newCode = second.raw.match(/Your Wayfarer code: (\d{6})/)[1];
    if (newCode !== oldCode) {
      assert.equal((await call('POST', '/api/auth/verify-email', { email: 'resend.user@test.com', code: oldCode })).status, 400);
    }
    assert.equal((await call('POST', '/api/auth/verify-email', { email: 'resend.user@test.com', code: newCode })).status, 200);
  });

  test('an unreachable SMTP server gives 502 and the address can be registered again', async () => {
    const saved = config.smtp;
    config.smtp = { host: '127.0.0.1', port: 1, secure: false, ignoreTLS: true };
    const r = await register('down.user@test.com');
    assert.equal(r.status, 502);
    assert.equal(await db.collection('users').countDocuments({ email: 'down.user@test.com' }), 0);
    config.smtp = saved;
    assert.equal((await register('down.user@test.com')).status, 201);
  });
});

describe('verification e-mail over the Resend API', () => {
  test('sends through the HTTP API; API errors give 502', async () => {
    const savedSmtp = config.smtp;
    config.smtp = null;
    config.resendApiKey = 're_test_key';
    const sent = [];
    let fail = false;
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('https://api.resend.com/')) {
        sent.push({ auth: init.headers.Authorization, body: JSON.parse(init.body) });
        return fail
          ? new Response(JSON.stringify({ message: 'domain not verified' }), { status: 403 })
          : new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 });
      }
      return realFetch(url, init);
    };
    try {
      assert.equal((await call('GET', '/api/health')).body.email, 'resend');
      const r = await register('resend.api@test.com');
      assert.equal(r.status, 201);
      assert.equal(r.body.delivery, 'email');
      assert.equal(r.body.demoCode, undefined);
      assert.equal(sent[0].auth, 'Bearer re_test_key');
      assert.deepEqual(sent[0].body.to, 'resend.api@test.com');
      const code = sent[0].body.subject.match(/(\d{6})$/)[1];
      assert.match(sent[0].body.html, new RegExp(code));
      assert.equal((await call('POST', '/api/auth/verify-email', { email: 'resend.api@test.com', code })).status, 200);
      fail = true;
      assert.equal((await register('resend.fail@test.com')).status, 502);
    } finally {
      globalThis.fetch = realFetch;
      config.smtp = savedSmtp;
      config.resendApiKey = null;
    }
  });

  test('without a provider and with demo mode off, registration is refused (503)', async () => {
    const savedSmtp = config.smtp;
    const savedDemo = config.emailDemoMode;
    config.smtp = null;
    config.emailDemoMode = false;
    try {
      assert.equal((await call('GET', '/api/health')).body.email, 'demo');
      const r = await register('nodemo@test.com');
      assert.equal(r.status, 503);
      assert.equal(await db.collection('users').countDocuments({ email: 'nodemo@test.com' }), 0);
    } finally {
      config.smtp = savedSmtp;
      config.emailDemoMode = savedDemo;
    }
  });
});
