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
};
