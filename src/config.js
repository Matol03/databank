import 'dotenv/config';

const isProd = process.env.NODE_ENV === 'production';
const jwtSecret = process.env.JWT_SECRET || 'dev-only-secret-change-me';
if (isProd && jwtSecret === 'dev-only-secret-change-me') {
  throw new Error('JWT_SECRET must be set in production');
}

export const config = {
  port: Number(process.env.PORT || 3000),
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017',
  dbName: process.env.DB_NAME || 'tourism_recsys',
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '2h',
  authRateLimit: Number(process.env.AUTH_RATE_LIMIT || 50),
};
