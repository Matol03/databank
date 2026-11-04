import { toObjectId, AppError } from '../errors.js';
import { POPULARITY, weightOf, tasteSignal } from '../constants.js';

/**
 * Apply the effect of an interaction to the denormalised counters.
 * Counters are updated with a single atomic pipeline update per document.
 * (MongoDB standalone has no multi-document transactions; the counters can be
 *  rebuilt at any time with `npm run recompute`.)
 */
async function applyEffects(db, { itemId, userId, category }, e, pushActivity) {
  await db.collection('items').updateOne({ _id: itemId }, [
    {
      $set: {
        'stats.viewCount': { $add: ['$stats.viewCount', e.views] },
        'stats.ratingCount': { $add: ['$stats.ratingCount', e.ratingCount] },
        'stats.ratingSum': { $add: ['$stats.ratingSum', e.ratingSum] },
        'stats.popularity': { $add: ['$stats.popularity', e.popularity] },
      },
    },
    {
      $set: {
        'stats.avgRating': {
          $cond: [
            { $gt: ['$stats.ratingCount', 0] },
            { $round: [{ $divide: ['$stats.ratingSum', '$stats.ratingCount'] }, 2] },
            0,
          ],
        },
      },
    },
  ]);

  const update = {};
  if (e.signal) update.$inc = { [`tasteProfile.${category}`]: e.signal };
  if (pushActivity) {
    update.$push = { recentActivity: { $each: [pushActivity], $slice: -20 } };
  }
  if (Object.keys(update).length) await db.collection('users').updateOne({ _id: userId }, update);
}

export async function recordInteraction(db, userId, input) {
  const itemId = toObjectId(input.itemId, 'itemId');
  const item = await db.collection('items').findOne({ _id: itemId }, { projection: { category: 1 } });
  if (!item) throw new AppError(404, 'Item not found', 'NotFound');

  const col = db.collection('interactions');
  const now = new Date();
  const { type, rating, context } = input;
  let effects;
  let doc;

  if (type === 'rating') {
    // one rating per (user, item): upsert and look at the previous value
    const before = await col.findOneAndUpdate(
      { userId, itemId, type: 'rating' },
      {
        $set: { rating, weight: rating, updatedAt: now, ...(context && { context }) },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true, returnDocument: 'before' },
    );
    doc = await col.findOne({ userId, itemId, type: 'rating' });
    effects = before
      ? { views: 0, ratingCount: 0, ratingSum: rating - before.rating, popularity: 0, signal: rating - before.rating }
      : { views: 0, ratingCount: 1, ratingSum: rating, popularity: POPULARITY.rating, signal: tasteSignal('rating', rating) };
  } else {
    doc = { userId, itemId, type, weight: weightOf(type), createdAt: now, ...(context && { context }) };
    const { insertedId } = await col.insertOne(doc);
    doc._id = insertedId;
    effects = {
      views: type === 'view' ? 1 : 0, ratingCount: 0, ratingSum: 0,
      popularity: POPULARITY[type], signal: tasteSignal(type),
    };
  }

  await applyEffects(db, { itemId, userId, category: item.category }, effects, { itemId, type, at: now });
  return doc;
}

export async function removeInteraction(db, user, id) {
  const col = db.collection('interactions');
  const doc = await col.findOne({ _id: toObjectId(id, 'interaction id') });
  if (!doc) throw new AppError(404, 'Interaction not found', 'NotFound');
  if (!doc.userId.equals(user._id) && user.role !== 'admin') {
    throw new AppError(403, 'You can only remove your own interactions', 'Forbidden');
  }
  if (!['bookmark', 'rating'].includes(doc.type)) {
    throw new AppError(400, 'Only bookmarks and ratings can be removed (views, visits and bookings are an immutable log)', 'NotAllowed');
  }
  await col.deleteOne({ _id: doc._id });

  const item = await db.collection('items').findOne({ _id: doc.itemId }, { projection: { category: 1 } });
  if (item) {
    const isRating = doc.type === 'rating';
    await applyEffects(db, { itemId: doc.itemId, userId: doc.userId, category: item.category }, {
      views: 0,
      ratingCount: isRating ? -1 : 0,
      ratingSum: isRating ? -doc.rating : 0,
      popularity: -POPULARITY[doc.type],
      signal: -tasteSignal(doc.type, doc.rating),
    });
  }
}

export async function userHistory(db, userId, { type, page, limit }) {
  const match = { userId, ...(type && { type }) };
  const col = db.collection('interactions');
  const [data, total] = await Promise.all([
    col.aggregate([
      { $match: match },
      { $sort: { createdAt: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit },
      {
        $lookup: {
          from: 'items', localField: 'itemId', foreignField: '_id', as: 'item',
          pipeline: [{ $project: { name: 1, category: 1, city: 1, country: 1 } }],
        },
      },
      { $unwind: { path: '$item', preserveNullAndEmptyArrays: true } },
    ]).toArray(),
    col.countDocuments(match),
  ]);
  return { data, page, limit, total, totalPages: Math.ceil(total / limit) };
}
