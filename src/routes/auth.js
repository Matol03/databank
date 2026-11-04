import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { getDb } from '../db.js';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { registerSchema, loginSchema } from '../schemas.js';
import { signToken } from '../middleware/auth.js';

const router = Router();

router.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.authRateLimit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'TooManyRequests', message: 'Too many attempts, try again later' },
}));

export const publicUser = ({ passwordHash, ...rest }) => rest;

router.post('/register', async (req, res) => {
  const { email, password, profile } = registerSchema.parse(req.body);
  const user = {
    email,
    passwordHash: await bcrypt.hash(password, 10),
    role: 'user',
    profile: { interests: [], preferredSeasons: [], ...profile },
    tasteProfile: {},
    recentActivity: [],
    createdAt: new Date(),
  };
  const { insertedId } = await getDb().collection('users').insertOne(user); // unique index -> 409 on duplicate
  user._id = insertedId;
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

router.post('/login', async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const users = getDb().collection('users');
  const user = await users.findOne({ email });
  // same message for unknown e-mail and wrong password
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new AppError(401, 'Invalid e-mail or password', 'Unauthorized');
  }
  await users.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
  res.json({ token: signToken(user), user: publicUser(user) });
});

export default router;
