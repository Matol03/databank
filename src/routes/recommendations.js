import { Router } from 'express';
import { getDb } from '../db.js';
import { toObjectId } from '../errors.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { recommendationSchema } from '../schemas.js';
import { recommendForUser, buildModel, ensureModel } from '../services/recommendations.js';

const router = Router();

/** Personalised recommendations for the signed-in user. */
router.get('/', requireAuth, async (req, res) => {
  const q = recommendationSchema.parse(req.query);
  res.json(await recommendForUser(getDb(), req.user._id, q));
});

/** Metadata of the current collaborative-filtering model (public). */
router.get('/model', async (_req, res) => {
  res.json(await ensureModel(getDb()));
});

/** Rebuild the item-item similarity model now (admin). */
router.post('/model/rebuild', requireRole('admin'), async (_req, res) => {
  res.json(await buildModel(getDb()));
});

/** Recommendations for any user (admin; used for inspection and the demo). */
router.get('/users/:id', requireRole('admin'), async (req, res) => {
  const q = recommendationSchema.parse(req.query);
  res.json(await recommendForUser(getDb(), toObjectId(req.params.id, 'user id'), q));
});

export default router;
