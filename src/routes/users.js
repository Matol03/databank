import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getDb } from '../db.js';
import { AppError } from '../errors.js';
import { requireAuth } from '../middleware/auth.js';
import { profileUpdateSchema, historySchema, deleteAccountSchema } from '../schemas.js';
import { recomputeItemStats } from '../services/stats.js';
import { invalidateUser } from '../services/recommendations.js';
import { publicUser } from './auth.js';
import { userHistory, rebuildFavoritePlaces } from '../services/interactions.js';

const router = Router();
router.use(requireAuth);

router.get('/me', async (req, res) => {
  const db = getDb();
  const users = db.collection('users');
  let user = await users.findOne({ _id: req.user._id });
  // Existing accounts are migrated lazily the first time their profile is read.
  if (user && !Array.isArray(user.favoritePlaces)) {
    await rebuildFavoritePlaces(db, user._id);
    user = await users.findOne({ _id: req.user._id });
  }
  res.json(publicUser(user));
});

router.put('/me', async (req, res) => {
  const changes = profileUpdateSchema.parse(req.body);
  const $set = Object.fromEntries(Object.entries(changes).map(([k, v]) => [`profile.${k}`, v]));
  const user = await getDb().collection('users').findOneAndUpdate(
    { _id: req.user._id }, { $set }, { returnDocument: 'after' },
  );
  res.json(publicUser(user));
});

router.get('/me/history', async (req, res) => {
  res.json(await userHistory(getDb(), req.user._id, historySchema.parse(req.query)));
});

/**
 * Deletes the signed-in account permanently: the user document, all of the user's interactions and cached
 * recommendations. The password is asked again so that a stolen or forgotten-open session cannot do it.
 * The counters of the places the user had interacted with are recomputed from the remaining interactions.
 */
router.delete('/me', async (req, res) => {
  const { password } = deleteAccountSchema.parse(req.body ?? {});
  const db = getDb();
  const users = db.collection('users');
  const user = await users.findOne({ _id: req.user._id });
  if (!(await bcrypt.compare(password, user.passwordHash))) {
    throw new AppError(403, 'The password is not correct', 'InvalidPassword');
  }
  if (user.role === 'admin' && (await users.countDocuments({ role: 'admin' })) <= 1) {
    throw new AppError(409, 'The last administrator account cannot be deleted', 'LastAdmin');
  }
  const interactions = db.collection('interactions');
  const itemIds = await interactions.distinct('itemId', { userId: user._id });
  const { deletedCount } = await interactions.deleteMany({ userId: user._id });
  await recomputeItemStats(db, itemIds);
  await invalidateUser(db, user._id);
  await users.deleteOne({ _id: user._id });
  res.json({ deleted: true, removedInteractions: deletedCount, updatedItems: itemIds.length });
});

export default router;
