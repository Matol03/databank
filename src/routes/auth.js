import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { getDb } from '../db.js';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { registerSchema, loginSchema, verifyEmailSchema, resendSchema } from '../schemas.js';
import { signToken } from '../middleware/auth.js';
import { sendVerificationEmail } from '../services/mailer.js';

const router = Router();

router.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.authRateLimit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'TooManyRequests', message: 'Too many attempts, try again later' },
}));

export const publicUser = ({ passwordHash, emailVerification, ...rest }) => rest;

// Codes and link tokens are stored only as SHA-256 hashes (keyed with the JWT secret), like passwords.
const digest = (value) => crypto.createHmac('sha256', config.jwtSecret).update(value).digest('hex');
const sameHash = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Creates a new 6-digit code + link token, stores their hashes and sends the e-mail. */
async function issueVerification(user) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  await getDb().collection('users').updateOne({ _id: user._id }, {
    $set: {
      emailVerification: {
        codeHash: digest(code),
        tokenHash: digest(token),
        expiresAt: new Date(now + config.verificationTtlMs),
        sentAt: new Date(now),
        attempts: 0,
      },
    },
  });
  if (!config.smtp && !config.emailDemoMode) {
    throw new AppError(503, 'E-mail delivery is not configured on the server (SMTP_HOST)', 'EmailUnavailable');
  }
  const delivery = await sendVerificationEmail({
    to: user.email,
    name: user.profile?.fullName,
    code,
    link: `${config.appUrl}/?verify=${token}`,
    minutes: Math.round(config.verificationTtlMs / 60_000),
  });
  return {
    verificationRequired: true,
    email: user.email,
    delivery,
    expiresAt: new Date(now + config.verificationTtlMs),
    // demo delivery only (no SMTP server configured): the UI shows the code instead of an inbox
    ...(delivery === 'demo' && config.emailDemoMode && { demoCode: code }),
  };
}

router.post('/register', async (req, res) => {
  const { email, password, profile } = registerSchema.parse(req.body);
  const user = {
    email,
    passwordHash: await bcrypt.hash(password, 10),
    role: 'user',
    emailVerified: false,
    profile: { interests: [], preferredSeasons: [], ...profile },
    tasteProfile: {},
    recentActivity: [],
    favoritePlaces: [],
    createdAt: new Date(),
  };
  const users = getDb().collection('users');
  const { insertedId } = await users.insertOne(user); // unique index -> 409 on duplicate
  user._id = insertedId;
  try {
    // no token yet: the account becomes usable after the e-mail address is confirmed
    res.status(201).json({ ...(await issueVerification(user)), user: publicUser(user) });
  } catch (err) {
    await users.deleteOne({ _id: insertedId }); // the address can be registered again
    if (err instanceof AppError) throw err;
    console.error('Verification e-mail failed:', err.message);
    throw new AppError(502, 'The verification e-mail could not be sent, try again later', 'EmailFailed');
  }
});

router.post('/verify-email', async (req, res) => {
  const input = verifyEmailSchema.parse(req.body);
  const users = getDb().collection('users');
  const user = input.token
    ? await users.findOne({ 'emailVerification.tokenHash': digest(input.token) })
    : await users.findOne({ email: input.email });
  const v = user?.emailVerification;
  if (!user || user.emailVerified !== false) {
    throw new AppError(400, 'Invalid or expired verification code', 'InvalidCode');
  }
  if (!v || v.expiresAt < new Date()) {
    throw new AppError(400, 'The verification code has expired, request a new one', 'CodeExpired');
  }
  if (v.attempts >= config.verificationMaxAttempts) {
    throw new AppError(429, 'Too many wrong codes, request a new one', 'TooManyAttempts');
  }
  if (input.code && !sameHash(v.codeHash, digest(input.code))) {
    await users.updateOne({ _id: user._id }, { $inc: { 'emailVerification.attempts': 1 } });
    throw new AppError(400, 'Invalid or expired verification code', 'InvalidCode');
  }
  const verified = await users.findOneAndUpdate(
    { _id: user._id },
    { $set: { emailVerified: true, emailVerifiedAt: new Date(), lastLoginAt: new Date() }, $unset: { emailVerification: '' } },
    { returnDocument: 'after' },
  );
  res.json({ token: signToken(verified), user: publicUser(verified) });
});

router.post('/resend-verification', async (req, res) => {
  const { email } = resendSchema.parse(req.body);
  const user = await getDb().collection('users').findOne({ email });
  // the same answer whether or not the address exists (no account enumeration)
  const generic = { message: 'If the account exists and is not verified yet, a new code has been sent.' };
  if (!user || user.emailVerified !== false) return res.json(generic);
  const last = user.emailVerification?.sentAt;
  if (last && Date.now() - last.getTime() < config.verificationResendMs) {
    throw new AppError(429, 'Please wait a minute before requesting another code', 'TooManyRequests');
  }
  const issued = await issueVerification(user);
  res.json({ ...generic, ...(issued.demoCode && { delivery: issued.delivery, demoCode: issued.demoCode }) });
});

router.post('/login', async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const users = getDb().collection('users');
  const user = await users.findOne({ email });
  // same message for unknown e-mail and wrong password
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new AppError(401, 'Invalid e-mail or password', 'Unauthorized');
  }
  // accounts created before e-mail verification existed have no flag and stay valid
  if (user.emailVerified === false) {
    throw new AppError(403, 'Confirm your e-mail address first. Check your inbox for the code.', 'EmailNotVerified');
  }
  await users.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
  res.json({ token: signToken(user), user: publicUser(user) });
});

export default router;
