import 'dotenv/config';

const jwtSecret = process.env.JWT_SECRET || 'dev-only-secret-change-me';

/** Returns a human-readable message if the environment is not configured for production, else null. */
export function configProblem() {
  if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
    return 'JWT_SECRET must be set in production. Add it to the environment variables of the project.';
  }
  if (process.env.VERCEL && !process.env.MONGO_URI) {
    return 'MONGO_URI is not set. Add the MongoDB Atlas connection string to the environment variables of the project.';
  }
  return null;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017',
  dbName: process.env.DB_NAME || 'tourism_recsys',
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '2h',
  authRateLimit: Number(process.env.AUTH_RATE_LIMIT || 50),

  // public URL of the website, used in the verification e-mail link
  appUrl: (process.env.APP_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),
  // e-mail verification
  verificationTtlMs: Number(process.env.EMAIL_CODE_TTL_MINUTES || 15) * 60_000,
  verificationMaxAttempts: 5,
  verificationResendMs: 60_000,
  smtp: process.env.SMTP_HOST ? {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true' || Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  } : null,
  // HTTP e-mail API alternative to SMTP (https://resend.com); used when RESEND_API_KEY is set and SMTP_HOST is not
  resendApiKey: process.env.RESEND_API_KEY || null,
  mailFrom: process.env.MAIL_FROM || (process.env.RESEND_API_KEY && !process.env.SMTP_HOST ? 'Wayfarer <onboarding@resend.dev>' : 'Wayfarer <no-reply@wayfarer.local>'),
  // Without a mail provider the code cannot be delivered: in "demo" delivery the code is returned by the API and shown
  // in the UI. Set EMAIL_DEMO_MODE=false to forbid that (registration then requires a working provider).
  // As soon as a provider is configured, demo delivery is off unless EMAIL_DEMO_MODE=true is set explicitly.
  emailDemoMode: process.env.EMAIL_DEMO_MODE ? process.env.EMAIL_DEMO_MODE === 'true' : !(process.env.SMTP_HOST || process.env.RESEND_API_KEY),

  // recommendation engine
  cfModelTtlMs: Number(process.env.CF_MODEL_TTL_MINUTES || 60) * 60_000,
  cfNeighbours: Number(process.env.CF_NEIGHBOURS || 30),
  cfUserCandidates: Number(process.env.CF_USER_CANDIDATES || 300),
  recCache: process.env.REC_CACHE !== 'off',
  recCacheTtlMs: Number(process.env.REC_CACHE_TTL_SECONDS || 600) * 1000,
};
