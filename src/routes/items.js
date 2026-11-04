import { Router } from 'express';
import { getDb } from '../db.js';
import { toObjectId, AppError } from '../errors.js';
import { requireRole } from '../middleware/auth.js';
import {
  createItemSchema, updateItemSchema, listSchema, searchSchema, popularSchema,
} from '../schemas.js';
import { buildItemDoc, derivedFields, searchItems, getItem, popularItems } from '../services/items.js';

const router = Router();

// ---- read (public) ----
router.get('/', async (req, res) => {
  res.json(await searchItems(getDb(), listSchema.parse(req.query)));
});

router.get('/search', async (req, res) => {
  res.json(await searchItems(getDb(), searchSchema.parse(req.query)));
});

router.get('/popular', async (req, res) => {
  const data = await popularItems(getDb(), popularSchema.parse(req.query));
  res.json({ data });
});

router.get('/:id', async (req, res) => {
  res.json(await getItem(getDb(), req.params.id));
});

// ---- write (admin) ----
router.post('/', requireRole('admin'), async (req, res) => {
  const doc = buildItemDoc(createItemSchema.parse(req.body));
  const { insertedId } = await getDb().collection('items').insertOne(doc);
  res.status(201).json(await getItem(getDb(), String(insertedId)));
});

router.put('/:id', requireRole('admin'), async (req, res) => {
  const changes = updateItemSchema.parse(req.body);
  const _id = toObjectId(req.params.id, 'item id');
  const result = await getDb().collection('items').updateOne(
    { _id },
    { $set: { ...changes, ...derivedFields(changes), updatedAt: new Date() } },
  );
  if (!result.matchedCount) throw new AppError(404, 'Item not found', 'NotFound');
  res.json(await getItem(getDb(), req.params.id));
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  const db = getDb();
  const _id = toObjectId(req.params.id, 'item id');
  const result = await db.collection('items').deleteOne({ _id });
  if (!result.deletedCount) throw new AppError(404, 'Item not found', 'NotFound');
  // cascade: the interactions of a deleted item are meaningless
  const { deletedCount } = await db.collection('interactions').deleteMany({ itemId: _id });
  res.json({ deleted: true, removedInteractions: deletedCount });
});

export default router;
