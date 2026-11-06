import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { profileUpdateSchema, historySchema } from '../schemas.js';
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

export default router;
