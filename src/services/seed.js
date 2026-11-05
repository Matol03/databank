/**
 * Seeds a database with synthetic (non-personal) test data: the destination catalogue, an administrator,
 * a demo user, synthetic travellers and their interactions. Deterministic for a given `seed`.
 * Used by `npm run seed` and by the optional AUTO_SEED start-up of the deployment.
 */
import bcrypt from 'bcryptjs';
import destinations from '../../data/destinations.json' with { type: 'json' };
import { ensureIndexes } from '../db.js';
import { createItemSchema } from '../schemas.js';
import { buildItemDoc } from './items.js';
import { recomputeAll } from './stats.js';
import { weightOf } from '../constants.js';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// travellers' archetypes -> the categories they are interested in
const ARCHETYPES = {
  'adventure seeker': ['adventure', 'mountains', 'nature'],
  'culture lover': ['heritage', 'museum', 'religious', 'city'],
  'beach & relax': ['beach', 'wellness'],
  'foodie': ['gastronomy', 'city'],
  'nature family': ['nature', 'beach', 'wellness'],
  'pilgrim & historian': ['religious', 'heritage', 'museum'],
};
const FIRST = ['Aigerim', 'Nurlan', 'Dana', 'Arman', 'Madina', 'Timur', 'Aliya', 'Yerlan', 'Zhanna', 'Askar',
  'Laura', 'Daniyar', 'Saule', 'Marat', 'Anna', 'Ivan', 'Maria', 'John', 'Emma', 'Liam', 'Sofia', 'Omar', 'Leyla', 'Chen', 'Mina'];
const LAST = ['Akhmetov', 'Sadykova', 'Nurgaliyev', 'Karimova', 'Bekov', 'Omarova', 'Smith', 'Ivanov', 'Petrova',
  'Kim', 'Johnson', 'Yilmaz', 'Rakhimov', 'Abdullayev', 'Wang', 'Garcia', 'Muller', 'Tokayev', 'Sultanova', 'Esenov'];
const COUNTRIES = ['Kazakhstan', 'Kazakhstan', 'Kazakhstan', 'Kazakhstan', 'Uzbekistan', 'Kyrgyzstan', 'Turkey',
  'Germany', 'United Kingdom', 'United States', 'China', 'South Korea', 'India', 'Georgia'];
const SEASONS = ['spring', 'summer', 'autumn', 'winter'];
const STYLES = ['solo', 'couple', 'family', 'friends', 'business'];
const DAY = 86400000;

export async function seedDatabase(db, { users: USERS = 300, seed = 42, drop = true, log = () => {} } = {}) {
  let state = seed >>> 0;
  const rand = () => { // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const randint = (a, b) => a + Math.floor(rand() * (b - a + 1));

  if (drop) await Promise.all(['users', 'items', 'interactions'].map((c) => db.collection(c).drop().catch(() => {})));
  await ensureIndexes(db);

  /* ---------- items ---------- */
  const raw = destinations;
  const itemDocs = raw.map((r) => buildItemDoc(createItemSchema.parse(r)));
  const { insertedIds } = await db.collection('items').insertMany(itemDocs);
  itemDocs.forEach((d, i) => { d._id = insertedIds[i]; });
  log(`  items:        ${itemDocs.length}`);

  /* ---------- users ---------- */
  const sharedHash = await bcrypt.hash('Password123!', 10); // synthetic users share one password
  const now = Date.now();
  const userDocs = [];
  const makeUser = (email, role, hash, profile, extra = {}) => ({
    email, role, passwordHash: hash,
    profile: { interests: [], preferredSeasons: [], ...profile },
    tasteProfile: {}, recentActivity: [],
    createdAt: new Date(now - randint(30, 400) * DAY), ...extra,
  });

  userDocs.push(makeUser('admin@tourism.local', 'admin', await bcrypt.hash('Admin12345!', 10),
    { fullName: 'Site Administrator', country: 'Kazakhstan' }));
  const demoInterests = ['heritage', 'mountains', 'gastronomy'];
  userDocs.push(makeUser('demo@tourism.local', 'user', await bcrypt.hash('Demo12345!', 10), {
    fullName: 'Demo Traveller', age: 29, country: 'Kazakhstan', travelStyle: 'couple', budgetLevel: 2,
    interests: demoInterests, preferredSeasons: ['spring', 'autumn'], bio: 'Account used for the demonstration.',
  }));

  const traits = new Map(); // email -> hidden preferences used to generate behaviour
  for (let n = 1; n <= USERS; n++) {
    const arch = pick(Object.keys(ARCHETYPES));
    const pool = ARCHETYPES[arch];
    const interests = [...new Set([pick(pool), pick(pool), rand() < 0.3 ? pick(Object.values(ARCHETYPES).flat()) : pick(pool)])];
    const budgetLevel = clamp(randint(1, 4) + (rand() < 0.2 ? 1 : 0), 1, 4);
    const profile = {
      fullName: `${pick(FIRST)} ${pick(LAST)}`, age: randint(18, 70), country: pick(COUNTRIES),
      travelStyle: pick(STYLES), budgetLevel, interests,
      preferredSeasons: [...new Set([pick(SEASONS), pick(SEASONS)])],
    };
    const email = `traveller${n}@example.com`;
    traits.set(email, { interests, budgetLevel, family: profile.travelStyle === 'family' });
    userDocs.push(makeUser(email, 'user', sharedHash, profile));
  }
  const uRes = await db.collection('users').insertMany(userDocs);
  userDocs.forEach((u, i) => { u._id = uRes.insertedIds[i]; });
  traits.set('demo@tourism.local', { interests: demoInterests, budgetLevel: 2, family: false });
  log(`  users:        ${userDocs.length} (incl. admin and demo)`);

  /* ---------- interactions ---------- */
  const itemPrior = itemDocs.map(() => Math.pow(rand(), 2) * 1.6); // some places are simply more popular
  const interactions = [];
  for (const u of userDocs) {
    const t = traits.get(u.email);
    if (!t) continue; // admin has no history
    const weights = itemDocs.map((it, i) => {
      const match = t.interests.includes(it.category) ? 1 : 0;
      const pricePenalty = Math.max(0, it.priceLevel - t.budgetLevel) * 0.7;
      const fam = t.family && it.attributes?.familyFriendly ? 0.3 : 0;
      return { i, match, w: Math.exp(0.3 + 2.2 * match - pricePenalty + fam + itemPrior[i]) };
    });
    const k = u.email === 'demo@tourism.local' ? 14 : randint(8, 34);
    const chosen = [];
    const pool = [...weights];
    for (let c = 0; c < k && pool.length; c++) {
      const total = pool.reduce((s, x) => s + x.w, 0);
      let r = rand() * total;
      let idx = 0;
      while (idx < pool.length - 1 && (r -= pool[idx].w) > 0) idx++;
      chosen.push(pool.splice(idx, 1)[0]);
    }
    for (const { i, match } of chosen) {
      const item = itemDocs[i];
      const start = now - randint(50, 360) * DAY; // + up to 45 days of offsets stays in the past
      const ctx = () => ({ season: pick(SEASONS), device: pick(['web', 'mobile', 'mobile']) });
      const push = (type, offsetDays, extra = {}) => interactions.push({
        userId: u._id, itemId: item._id, type, weight: weightOf(type, extra.rating),
        context: ctx(), createdAt: new Date(start + offsetDays * DAY + randint(0, DAY - 1)), ...extra,
      });
      for (let v = randint(1, 3); v > 0; v--) push('view', randint(0, 3));
      if (rand() < 0.12 + 0.2 * match) push('bookmark', 3);
      const visited = rand() < 0.1 + 0.3 * match;
      if (visited) push('visit', randint(8, 40));
      if (visited && rand() < 0.2) push('booking', randint(4, 7));
      if (rand() < 0.2 + 0.5 * (visited ? 1 : 0)) {
        const mismatch = Math.max(0, item.priceLevel - t.budgetLevel) * 0.5;
        const rating = clamp(Math.round(2.7 + 1.7 * match + (rand() - 0.5) * 1.8 - mismatch), 1, 5);
        push('rating', 45, { rating, updatedAt: new Date(start + 45 * DAY) });
      }
    }
  }
  await db.collection('interactions').insertMany(interactions, { ordered: false });
  log(`  interactions: ${interactions.length}`);

  const r = await recomputeAll(db);
  log(`  counters:     recomputed for ${r.items} items / ${r.users} users`);

  return { items: itemDocs.length, users: userDocs.length, interactions: interactions.length };
}
