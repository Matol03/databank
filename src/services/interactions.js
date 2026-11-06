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

async function storeFavoritePlace(db, userId, favoritePlace) {
  // Replace by itemId, not whole-object equality, so re-likes cannot create duplicates.
  await db.collection('users').updateOne({ _id: userId }, [
    {
      $set: {
        favoritePlaces: {
          $concatArrays: [
            {
              $filter: {
                input: { $ifNull: ['$favoritePlaces', []] },
                as: 'favorite',
                cond: { $ne: ['$favorite.itemId', { $literal: favoritePlace.itemId }] },
              },
            },
            [{ $literal: favoritePlace }],
          ],
        },
      },
    },
  ]);
}

function toFavoritePlace(interaction, item) {
  const snapshot = interaction.destinationSnapshot || item || {};
  return {
    itemId: interaction.itemId,
    interactionId: interaction._id,
    name: snapshot.name || 'Unknown destination',
    city: snapshot.city || '',
    country: snapshot.country || '',
    category: snapshot.category || '',
    likedAt: interaction.createdAt || new Date(),
  };
}

export async function recordInteraction(db, userId, input) {
  const itemId = toObjectId(input.itemId, 'itemId');
  const item = await db.collection('items').findOne(
    { _id: itemId },
    { projection: { name: 1, category: 1, city: 1, country: 1 } },
  );
  if (!item) throw new AppError(404, 'Item not found', 'NotFound');

  const col = db.collection('interactions');
  const now = new Date();
  const { type, rating, context } = input;
  let effects;
  let doc;

  if (type === 'bookmark') {
    // A like is a state, not a repeated event: keep one bookmark per user/place.
    const existing = await col.findOne({ userId, itemId, type: 'bookmark' });
    if (existing) {
      await storeFavoritePlace(db, userId, toFavoritePlace(existing, item));
      return existing;
    }

    doc = {
      userId, itemId, type, weight: weightOf(type), createdAt: now,
      ...(context && { context }),
      destinationSnapshot: {
        name: item.name,
        city: item.city,
        country: item.country,
        category: item.category,
      },
    };
    const { insertedId } = await col.insertOne(doc);
    doc._id = insertedId;
    await storeFavoritePlace(db, userId, toFavoritePlace(doc, item));
    effects = {
      views: 0, ratingCount: 0, ratingSum: 0,
      popularity: POPULARITY.bookmark, signal: tasteSignal('bookmark'),
    };
  } else if (type === 'rating') {
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
    doc = {
      userId, itemId, type, weight: weightOf(type), createdAt: now,
      ...(context && { context }),
    };
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

  const item = await db.collection('items').findOne(
    { _id: doc.itemId },
    { projection: { name: 1, category: 1, city: 1, country: 1 } },
  );
  if (doc.type === 'bookmark') {
    const remaining = await col.find({ userId: doc.userId, itemId: doc.itemId, type: 'bookmark' })
      .sort({ createdAt: -1 }).limit(1).next();
    if (remaining) {
      await storeFavoritePlace(db, doc.userId, toFavoritePlace(remaining, item));
    } else {
      await db.collection('users').updateOne(
        { _id: doc.userId },
        { $pull: { favoritePlaces: { itemId: doc.itemId } } },
      );
    }
  }
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

/**
 * Backfill the embedded user.favoritePlaces array from historical bookmark
 * interactions. The latest bookmark per destination is retained.
 */
export async function rebuildFavoritePlaces(db, onlyUserId = null) {
  const users = db.collection('users');
  const interactions = db.collection('interactions');
  const items = db.collection('items');
  const targets = await users.find(
    onlyUserId ? { _id: onlyUserId } : {},
    { projection: { _id: 1 } },
  ).toArray();

  for (const user of targets) {
    const bookmarks = await interactions.find({ userId: user._id, type: 'bookmark' })
      .sort({ createdAt: 1 }).toArray();
    const itemIds = [...new Map(bookmarks.map((x) => [String(x.itemId), x.itemId])).values()];
    const itemDocs = itemIds.length
      ? await items.find({ _id: { $in: itemIds } }, { projection: { name: 1, city: 1, country: 1, category: 1 } }).toArray()
      : [];
    const itemById = new Map(itemDocs.map((x) => [String(x._id), x]));
    const favoriteByItem = new Map();

    for (const bookmark of bookmarks) {
      const item = itemById.get(String(bookmark.itemId));
      const favorite = toFavoritePlace(bookmark, item);
      if (favorite.name !== 'Unknown destination') {
        favoriteByItem.set(String(bookmark.itemId), favorite);
      }
    }

    await users.updateOne(
      { _id: user._id },
      { $set: { favoritePlaces: [...favoriteByItem.values()] } },
    );
  }

  return { users: targets.length };
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
