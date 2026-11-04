import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { profileUpdateSchema, historySchema } from '../schemas.js';
import { publicUser } from './auth.js';
import { userHistory } from '../services/interactions.js';

const router = Router();
router.use(requireAuth);

router.get('/me', async (req, res) => {
  const user = await getDb().collection('users').findOne({ _id: req.user._id });
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
