/**
 * Sends the verification e-mail through the first configured provider:
 *   SMTP_HOST set        -> SMTP through nodemailer (Gmail app password, Brevo, Mailgun, Outlook, ...)
 *   RESEND_API_KEY set   -> Resend HTTP API (no SMTP ports needed; https://resend.com)
 *   neither              -> "demo" delivery: the message is written to the server log, and (if EMAIL_DEMO_MODE is on)
 *                           the code is returned by the API so the demo deployment works without a mail provider.
 */
import nodemailer from 'nodemailer';
import { config } from '../config.js';

let transport = null;
let transportKey = null;
function smtpTransport() {
  const key = JSON.stringify(config.smtp);
  if (!transport || transportKey !== key) {
    transport = nodemailer.createTransport({
      ...config.smtp,
      // serverless functions have a few seconds only: fail fast instead of hanging the request
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
    });
    transportKey = key;
  }
  return transport;
}

/** 'smtp' | 'resend' | 'demo' — which provider sends the e-mails (no secrets). */
export function emailProvider() {
  if (config.smtp) return 'smtp';
  if (config.resendApiKey) return 'resend';
  return 'demo';
}

/** Sender address: MAIL_FROM, else the SMTP login when it is an e-mail address (Gmail requires that), else the default. */
export function senderAddress() {
  if (process.env.MAIL_FROM) return process.env.MAIL_FROM;
  const user = config.smtp?.auth?.user;
  if (config.smtp && user && user.includes('@')) return `Wayfarer <${user}>`;
  return config.mailFrom;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function verificationMessage({ to, name, code, link, minutes }) {
  const greeting = name ? `Hello ${name},` : 'Hello,';
  const text = `${greeting}

Your Wayfarer verification code is: ${code}

Enter it in the sign-up window, or open this link to confirm your e-mail address:
${link}

The code expires in ${minutes} minutes. If you did not create a Wayfarer account, ignore this e-mail.`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#202c24">
  <h2 style="font-family:Georgia,serif;font-weight:500">Confirm your e-mail</h2>
  <p>${escapeHtml(greeting)}</p>
  <p>Your Wayfarer verification code is</p>
  <p style="font-size:30px;letter-spacing:8px;font-weight:700;margin:12px 0">${code}</p>
  <p><a href="${escapeHtml(link)}" style="display:inline-block;background:#263d32;color:#fff;padding:12px 20px;border-radius:3px;text-decoration:none">Verify my e-mail</a></p>
  <p style="color:#788078;font-size:12px">The code expires in ${minutes} minutes. If you did not create a Wayfarer account, ignore this e-mail.</p>
</div>`;
  return { from: senderAddress(), to, subject: `Your Wayfarer code: ${code}`, text, html };
}

async function sendWithResend(message) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Resend API ${res.status}: ${body.message || res.statusText}`);
  }
}

/** Sends any message through the configured provider. Returns the provider used. */
export async function sendMail(message) {
  const provider = emailProvider();
  if (provider === 'smtp') await smtpTransport().sendMail(message);
  else if (provider === 'resend') await sendWithResend(message);
  else if (process.env.NODE_ENV !== 'test') console.log(`[mail:demo] to=${message.to} subject="${message.subject}"`);
  return provider;
}

/** Returns 'smtp' / 'resend' when the message was handed to a provider, 'demo' when it was only logged. */
export async function sendVerificationEmail(params) {
  const provider = await sendMail(verificationMessage(params));
  return provider === 'demo' ? 'demo' : 'email';
}

/** Checks the SMTP login without sending anything (used by `npm run email:test`). */
export async function verifyProvider() {
  if (emailProvider() === 'smtp') await smtpTransport().verify();
  return emailProvider();
}
