import { MongoClient } from 'mongodb';

let client = null;
let db = null;

export async function connect(uri, dbName) {
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
  } catch (err) {
    console.error(`Cannot connect to MongoDB at ${uri}: ${err.message}`);
    console.error('Start MongoDB first (see README.md) and check MONGO_URI in .env');
    process.exit(1);
  }
  db = client.db(dbName);
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not connected');
  return db;
}

export async function close() {
  if (client) await client.close();
  client = null;
  db = null;
}

/**
 * Index definitions. Every index is tied to a concrete query of the API
 * (see docs/PROPOSAL and scripts/explain.js).
 */
export async function ensureIndexes(database = getDb()) {
  const users = database.collection('users');
  const items = database.collection('items');
  const interactions = database.collection('interactions');

  // login + uniqueness of registration
  await users.createIndex({ email: 1 }, { unique: true, name: 'uniq_email' });

  // catalogue browsing: category filter, best-rated first
  await items.createIndex({ category: 1, 'stats.avgRating': -1 }, { name: 'category_rating' });
  // location filters (lower-cased helper fields => case-insensitive equality)
  await items.createIndex({ countryLower: 1, cityLower: 1 }, { name: 'country_city' });
  // "popular / trending" lists
  await items.createIndex({ 'stats.popularity': -1 }, { name: 'popularity' });
  // tag filter (multikey)
  await items.createIndex({ tags: 1 }, { name: 'tags' });
  // season filter (multikey)
  await items.createIndex({ bestSeasons: 1 }, { name: 'seasons' });
  // prefix / autocomplete search on the city (the name prefix is served by uniq_name_city)
  await items.createIndex({ cityLower: 1 }, { name: 'city_prefix' });
  // "near me" queries
  await items.createIndex({ location: '2dsphere' }, { name: 'geo' });
  // duplicates are not allowed in the catalogue; also serves prefix search / sorting on nameLower
  await items.createIndex({ nameLower: 1, cityLower: 1 }, { unique: true, name: 'uniq_name_city' });
  // full-text search with field weights
  await items.createIndex(
    { name: 'text', tags: 'text', city: 'text', country: 'text', description: 'text' },
    {
      name: 'text_search',
      weights: { name: 10, tags: 5, city: 3, country: 2, description: 1 },
      default_language: 'english',
    },
  );

  // a user's history, newest first (the most frequent read)
  await interactions.createIndex({ userId: 1, createdAt: -1 }, { name: 'user_history' });
  // all interactions of an item (item-based collaborative filtering)
  await interactions.createIndex({ itemId: 1, createdAt: -1 }, { name: 'item_interactions' });
  // one rating per user and item (ratings are upserted, other events are appended)
  await interactions.createIndex(
    { userId: 1, itemId: 1 },
    { unique: true, partialFilterExpression: { type: 'rating' }, name: 'uniq_user_item_rating' },
  );
}
