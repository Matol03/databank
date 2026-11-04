import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { AppError } from '../errors.js';

export function signToken(user) {
  return jwt.sign({ role: user.role }, config.jwtSecret, {
    subject: String(user._id),
    expiresIn: config.jwtExpiresIn,
  });
}

async function resolveUser(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    throw new AppError(401, 'Invalid or expired token', 'Unauthorized');
  }
  // load the user so that deleted accounts / changed roles take effect immediately
  const user = await getDb().collection('users').findOne(
    { _id: new ObjectId(payload.sub) },
    { projection: { email: 1, role: 1 } },
  );
  if (!user) throw new AppError(401, 'User no longer exists', 'Unauthorized');
  return user;
}

export async function requireAuth(req, _res, next) {
  const user = await resolveUser(req);
  if (!user) throw new AppError(401, 'Authentication required', 'Unauthorized');
  req.user = user;
  next();
}

export const requireRole = (role) => async (req, res, next) => {
  await requireAuth(req, res, () => {});
  if (req.user.role !== role) throw new AppError(403, 'Insufficient permissions', 'Forbidden');
  next();
};
