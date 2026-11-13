import { POPULARITY, tasteSignal } from '../constants.js';

/**
 * Rebuilds every denormalised value from the interactions collection:
 *   items.stats            (viewCount, ratingCount, ratingSum, avgRating, popularity)
 *   users.tasteProfile     (signed score per category)
 *   users.recentActivity   (last 20 events)
 * Used by the seed script and as a repair tool (`npm run recompute`).
 */
export async function recomputeAll(db) {
  const items = await db.collection('items').find({}, { projection: { category: 1 } }).toArray();
  const category = new Map(items.map((i) => [String(i._id), i.category]));
  const itemStats = new Map(items.map((i) => [String(i._id),
    { viewCount: 0, ratingCount: 0, ratingSum: 0, avgRating: 0, popularity: 0 }]));
  const users = new Map();

  const cursor = db.collection('interactions')
    .find({}, { projection: { userId: 1, itemId: 1, type: 1, rating: 1, createdAt: 1 } })
    .sort({ createdAt: 1 });

  for await (const x of cursor) {
    const key = String(x.itemId);
    const s = itemStats.get(key);
    const cat = category.get(key);
    if (!s) continue; // orphaned interaction
    if (x.type === 'view') s.viewCount += 1;
    if (x.type === 'rating') { s.ratingCount += 1; s.ratingSum += x.rating; }
    s.popularity += POPULARITY[x.type];

    const uKey = String(x.userId);
    if (!users.has(uKey)) users.set(uKey, { _id: x.userId, taste: {}, recent: [] });
    const u = users.get(uKey);
    u.taste[cat] = (u.taste[cat] || 0) + tasteSignal(x.type, x.rating);
    u.recent.push({ itemId: x.itemId, type: x.type, at: x.createdAt });
  }

  const itemOps = [...itemStats].map(([id, s]) => ({
    updateOne: {
      filter: { _id: items.find((i) => String(i._id) === id)._id },
      update: { $set: { stats: { ...s, avgRating: s.ratingCount ? Math.round((s.ratingSum / s.ratingCount) * 100) / 100 : 0 } } },
    },
  }));
  if (itemOps.length) await db.collection('items').bulkWrite(itemOps, { ordered: false });

  const userOps = [...users.values()].map((u) => ({
    updateOne: {
      filter: { _id: u._id },
      update: { $set: { tasteProfile: u.taste, recentActivity: u.recent.slice(-20) } },
    },
  }));
  if (userOps.length) await db.collection('users').bulkWrite(userOps, { ordered: false });

  return { items: itemOps.length, users: userOps.length };
}

/**
 * Recomputes items.stats for the given items only, from their remaining interactions
 * (used after the interactions of a deleted account have been removed).
 */
export async function recomputeItemStats(db, itemIds) {
  if (!itemIds.length) return 0;
  const branches = Object.entries(POPULARITY).map(([type, points]) => ({ case: { $eq: ['$type', type] }, then: points }));
  const rows = await db.collection('interactions').aggregate([
    { $match: { itemId: { $in: itemIds } } },
    {
      $group: {
        _id: '$itemId',
        viewCount: { $sum: { $cond: [{ $eq: ['$type', 'view'] }, 1, 0] } },
        ratingCount: { $sum: { $cond: [{ $eq: ['$type', 'rating'] }, 1, 0] } },
        ratingSum: { $sum: { $cond: [{ $eq: ['$type', 'rating'] }, '$rating', 0] } },
        popularity: { $sum: { $switch: { branches, default: 0 } } },
      },
    },
  ]).toArray();
  const byId = new Map(rows.map((r) => [String(r._id), r]));
  const ops = itemIds.map((id) => {
    const r = byId.get(String(id)) || { viewCount: 0, ratingCount: 0, ratingSum: 0, popularity: 0 };
    const avgRating = r.ratingCount ? Math.round((r.ratingSum / r.ratingCount) * 100) / 100 : 0;
    return {
      updateOne: {
        filter: { _id: id },
        update: { $set: { stats: { viewCount: r.viewCount, ratingCount: r.ratingCount, ratingSum: r.ratingSum, avgRating, popularity: r.popularity } } },
      },
    };
  });
  await db.collection('items').bulkWrite(ops, { ordered: false });
  return ops.length;
}
