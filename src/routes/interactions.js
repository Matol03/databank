import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { interactionSchema } from '../schemas.js';
import { recordInteraction, removeInteraction } from '../services/interactions.js';

const router = Router();
router.use(requireAuth);

router.post('/', async (req, res) => {
  const input = interactionSchema.parse(req.body);
  const doc = await recordInteraction(getDb(), req.user._id, input);
  res.status(201).json(doc);
});

router.delete('/:id', async (req, res) => {
  await removeInteraction(getDb(), req.user, req.params.id);
  res.status(204).end();
});

export default router;
