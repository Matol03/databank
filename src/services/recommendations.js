/**
 * Recommendation engine on top of MongoDB.
 *
 *  item-based CF (default) : item-item similarities are PRE-COMPUTED offline into `item_similarities`
 *                            (one document per item with its top-k neighbours); a request only reads
 *                            the user's own preferences (covered index query) and the neighbour lists
 *                            of those items (_id lookups).
 *  user-based CF           : computed on request from the users who share items with the target user
 *                            (candidate pruning keeps the most overlapping users only).
 *  cold start              : no positive history -> popular places in the user's declared interests.
 *
 * Results are cached in two levels: an in-process LRU (L1, per server instance) and the MongoDB
 * collection `recommendation_cache` (L2, shared by all serverless instances, TTL index). A user's cache is
 * invalidated when they record or remove an interaction, and a cache entry is ignored once a newer
 * model version has been built.
 */
import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { toObjectId, AppError } from '../errors.js';
import { toPreferences, buildItemModel, scoreItemBased, scoreUserBased, preferenceOf } from './cf.js';

const HIDDEN = { nameLower: 0, countryLower: 0, cityLower: 0 };
const CARD = { name: 1, category: 1, city: 1, country: 1, description: 1, imageUrl: 1, priceLevel: 1, avgDailyCostUSD: 1, bestSeasons: 1, stats: 1, location: 1, tags: 1, attributes: 1 };
const MODEL_ID = 'cf_model';

/* ------------------------------------------------------------------ model ------------------------------------------------------------------ */

let building = null;

/**
 * Reads the whole interaction log once, builds the item-item model and replaces `item_similarities`.
 * Only the fields needed are projected, so the scan reads small documents.
 */
export async function buildModel(db, { k = config.cfNeighbours, shrink = 10, minCommon = 2 } = {}) {
  const started = performance.now();
  const events = await db.collection('interactions')
    .find({}, { projection: { _id: 0, userId: 1, itemId: 1, type: 1, weight: 1 } })
    .toArray();
  const loadedMs = performance.now() - started;
  const prefs = toPreferences(events);
  const model = buildItemModel(prefs, { k, shrink, minCommon });
  const computedMs = performance.now() - started - loadedMs;

  const version = Date.now();
  const docs = [...model].map(([i, nbs]) => ({
    _id: new ObjectId(i),
    neighbours: nbs.map((n) => ({ itemId: new ObjectId(n.i), score: Math.round(n.s * 1e5) / 1e5, common: n.n })),
    version,
    updatedAt: new Date(version),
  }));
  const col = db.collection('item_similarities');
  if (docs.length) {
    await col.bulkWrite(docs.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })), { ordered: false });
  }
  await col.deleteMany({ version: { $ne: version } }); // items that no longer have neighbours
  const stats = {
    version,
    builtAt: new Date(version),
    interactions: events.length,
    users: new Set(prefs.map((p) => p.u)).size,
    preferencePairs: prefs.length,
    itemsWithNeighbours: docs.length,
    neighboursPerItem: k,
    timings: {
      loadMs: Math.round(loadedMs),
      computeMs: Math.round(computedMs),
      totalMs: Math.round(performance.now() - started),
    },
  };
  await db.collection('meta').replaceOne({ _id: MODEL_ID }, { _id: MODEL_ID, ...stats }, { upsert: true });
  l1.clear();
  return stats;
}

export async function modelInfo(db) {
  return db.collection('meta').findOne({ _id: MODEL_ID }, { projection: { _id: 0 } });
}

/** Returns the current model metadata; builds the model if there is none, refreshes it in the background when stale. */
export async function ensureModel(db) {
  const info = await modelInfo(db);
  const stale = info && Date.now() - new Date(info.builtAt).getTime() > config.cfModelTtlMs;
  if (info && !stale) return info;
  building ??= buildModel(db).finally(() => { building = null; });
  if (!info) return building; // first request ever: wait for the model
  building.catch((err) => console.error('CF model refresh failed:', err.message));
  return info; // stale: serve the current model, the new one replaces it shortly
}

/* ------------------------------------------------------------------ cache ------------------------------------------------------------------ */

/** Small LRU with TTL (Map keeps insertion order: re-inserting moves a key to the end). */
class Lru {
  constructor(max) { this.max = max; this.map = new Map(); }
  get(key) {
    const e = this.map.get(key);
    if (!e) return null;
    if (e.expires < Date.now()) { this.map.delete(key); return null; }
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }
  set(key, value, ttlMs) {
    this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + ttlMs });
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  deletePrefix(prefix) { for (const k of this.map.keys()) if (k.startsWith(prefix)) this.map.delete(k); }
  clear() { this.map.clear(); }
}
const l1 = new Lru(5000);

export function clearMemoryCache() { l1.clear(); }

export async function invalidateUser(db, userId) {
  l1.deletePrefix(`${userId}:`);
  await db.collection('recommendation_cache').deleteMany({ userId });
}

/* ------------------------------------------------------------------ queries ------------------------------------------------------------------ */

/** The user's preference per item. Served by the covering index `user_item_prefs` (no document fetch). */
export async function userPreferences(db, userId) {
  const events = await db.collection('interactions')
    .find({ userId }, { projection: { _id: 0, itemId: 1, type: 1, weight: 1 } })
    .hint('user_item_prefs')
    .toArray();
  const byItem = new Map();
  for (const e of events) {
    const key = String(e.itemId);
    if (!byItem.has(key)) byItem.set(key, []);
    byItem.get(key).push(e);
  }
  return new Map([...byItem].map(([i, ev]) => [i, preferenceOf(ev)]));
}

async function itemBased(db, prefs) {
  const liked = [...prefs].filter(([, p]) => p > 0).map(([i]) => new ObjectId(i));
  const docs = await db.collection('item_similarities')
    .find({ _id: { $in: liked } }, { projection: { neighbours: 1 } })
    .toArray();
  const map = new Map(docs.map((d) => [String(d._id), d.neighbours.map((n) => ({ i: String(n.itemId), s: n.score }))]));
  return scoreItemBased(prefs, (i) => map.get(i), { limit: 64 });
}

async function userBased(db, userId, prefs, { maxCandidates = config.cfUserCandidates } = {}) {
  const liked = [...prefs].filter(([, p]) => p > 0).map(([i]) => new ObjectId(i));
  const col = db.collection('interactions');
  // 1) users who touched the same places, ranked by overlap (served by the covering index item_user_prefs)
  const overlap = await col.aggregate([
    { $match: { itemId: { $in: liked }, userId: { $ne: userId } } },
    { $group: { _id: '$userId', common: { $addToSet: '$itemId' } } },
    { $project: { n: { $size: '$common' } } },
    { $sort: { n: -1, _id: 1 } },
    { $limit: maxCandidates },
  ], { hint: 'item_user_prefs' }).toArray();
  if (!overlap.length) return [];
  // 2) the full preference vectors of the candidate users (covering index user_item_prefs)
  const events = await col.find(
    { userId: { $in: overlap.map((o) => o._id) } },
    { projection: { _id: 0, userId: 1, itemId: 1, type: 1, weight: 1 } },
  ).hint('user_item_prefs').toArray();
  return scoreUserBased(String(userId), prefs, toPreferences(events), { limit: 64 });
}

async function popularFor(db, categories, excludeIds, limit) {
  const filter = { _id: { $nin: excludeIds }, ...(categories.length && { category: { $in: categories } }) };
  return db.collection('items').find(filter, { projection: CARD })
    .sort({ 'stats.popularity': -1, _id: 1 }).limit(limit).toArray();
}

/**
 * Personalised recommendations for one user.
 * options: { limit, algorithm: 'item' | 'user', category: string[] | undefined, cache: boolean }
 */
export async function recommendForUser(db, userId, { limit = 10, algorithm = 'item', category, cache = config.recCache } = {}) {
  const started = performance.now();
  const model = await ensureModel(db);
  const key = `${userId}:${algorithm}:${(category || []).join(',')}:${limit}`;

  if (cache) {
    const hit = l1.get(key);
    if (hit && hit.model.version === model.version) return { ...hit, cache: 'memory', tookMs: +(performance.now() - started).toFixed(2) };
    const doc = await db.collection('recommendation_cache').findOne({ _id: key, modelVersion: model.version });
    if (doc) {
      l1.set(key, doc.result, config.recCacheTtlMs);
      return { ...doc.result, cache: 'database', tookMs: +(performance.now() - started).toFixed(2) };
    }
  }

  const user = await db.collection('users').findOne({ _id: userId }, { projection: { 'profile.interests': 1 } });
  if (!user) throw new AppError(404, 'User not found', 'NotFound');
  const prefs = await userPreferences(db, userId);
  const positive = [...prefs.values()].filter((p) => p > 0).length;

  let scored = [];
  if (positive) scored = algorithm === 'user' ? await userBased(db, userId, prefs) : await itemBased(db, prefs);

  // join the candidate items, apply the optional category filter
  const ids = scored.map((s) => new ObjectId(s.i));
  const needed = new Set([...ids.map(String), ...scored.flatMap((s) => s.because || [])]);
  const docs = needed.size
    ? await db.collection('items').find({ _id: { $in: [...needed].map((i) => new ObjectId(i)) } }, { projection: CARD }).toArray()
    : [];
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  const maxScore = scored[0]?.score || 1;
  let data = scored
    .map((s) => ({ s, item: byId.get(s.i) }))
    .filter(({ item }) => item && (!category || category.includes(item.category)))
    .slice(0, limit)
    .map(({ s, item }) => ({
      item,
      score: Math.round((s.score / maxScore) * 1000) / 1000,
      source: algorithm === 'user' ? 'user-cf' : 'item-cf',
      ...(s.because && { because: s.because.map((i) => byId.get(i)).filter(Boolean).map((d) => ({ _id: d._id, name: d.name })) }),
      ...(s.neighbours && { similarTravellers: s.neighbours }),
    }));

  // cold start / top-up: popular places in the categories the user is interested in
  let strategy = positive ? 'collaborative' : 'cold-start';
  if (data.length < limit) {
    const interests = category || user.profile?.interests || [];
    const exclude = [...prefs.keys(), ...data.map((d) => String(d.item._id))].map((i) => new ObjectId(i));
    let fill = await popularFor(db, interests, exclude, limit - data.length);
    if (fill.length < limit - data.length && !category) {
      fill = fill.concat(await popularFor(db, [], exclude.concat(fill.map((f) => f._id)), limit - data.length - fill.length));
    }
    if (fill.length && data.length) strategy = 'collaborative+popular';
    data = data.concat(fill.map((item) => ({ item, score: 0, source: 'popular' })));
  }

  const result = {
    data,
    algorithm,
    strategy,
    model: { version: model.version, builtAt: model.builtAt },
    generatedAt: new Date(),
  };
  if (cache) {
    l1.set(key, result, config.recCacheTtlMs);
    await db.collection('recommendation_cache').replaceOne(
      { _id: key },
      { _id: key, userId, modelVersion: model.version, result, expiresAt: new Date(Date.now() + config.recCacheTtlMs) },
      { upsert: true },
    );
  }
  return { ...result, cache: cache ? 'miss' : 'off', tookMs: +(performance.now() - started).toFixed(2) };
}

/** "Travellers who liked this also liked": the pre-computed neighbours of one item. */
export async function similarItems(db, id, { limit = 6 } = {}) {
  const _id = toObjectId(id, 'item id');
  await ensureModel(db);
  const item = await db.collection('items').findOne({ _id }, { projection: { category: 1 } });
  if (!item) throw new AppError(404, 'Item not found', 'NotFound');
  const sim = await db.collection('item_similarities').findOne({ _id });
  const nbs = (sim?.neighbours || []).slice(0, limit);
  const docs = nbs.length
    ? await db.collection('items').find({ _id: { $in: nbs.map((n) => n.itemId) } }, { projection: HIDDEN }).toArray()
    : [];
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  let data = nbs.filter((n) => byId.has(String(n.itemId)))
    .map((n) => ({ item: byId.get(String(n.itemId)), similarity: n.score, commonUsers: n.common, source: 'item-cf' }));
  if (data.length < limit) { // not enough co-interactions yet: same category, most popular
    const exclude = [_id, ...data.map((d) => d.item._id)];
    const fill = await db.collection('items').find({ _id: { $nin: exclude }, category: item.category }, { projection: HIDDEN })
      .sort({ 'stats.popularity': -1, _id: 1 }).limit(limit - data.length).toArray();
    data = data.concat(fill.map((x) => ({ item: x, similarity: 0, commonUsers: 0, source: 'same-category' })));
  }
  return { data };
}
