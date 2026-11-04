import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { config } from '../src/config.js';
import { connect, close, ensureIndexes } from '../src/db.js';
import { createApp } from '../src/app.js';
import { buildItemDoc } from '../src/services/items.js';

process.env.AUTH_RATE_LIMIT = '10000';
config.authRateLimit = 10000;

let server;
let base;
let db;
let adminToken;
let userToken;

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const sampleItem = (over = {}) => ({
  name: 'Test Peak', description: 'A test mountain used by the automated tests.',
  category: 'mountains', country: 'Kazakhstan', city: 'Almaty',
  location: { lat: 43.2, lon: 76.9 }, tags: ['hiking', 'snow'],
  priceLevel: 2, avgDailyCostUSD: 80, bestSeasons: ['winter'], ...over,
});

before(async () => {
  db = await connect(config.mongoUri, 'tourism_recsys_test');
  await db.dropDatabase();
  await ensureIndexes(db);
  await db.collection('users').insertOne({
    email: 'admin@test.local', role: 'admin', passwordHash: await bcrypt.hash('Admin12345', 4),
    profile: { fullName: 'Admin' }, tasteProfile: {}, recentActivity: [], createdAt: new Date(),
  });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  adminToken = (await call('POST', '/api/auth/login', { body: { email: 'admin@test.local', password: 'Admin12345' } })).body.token;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await db.dropDatabase();
  await close();
});

describe('authentication and profiles', () => {
  test('registers a user and never returns the password hash', async () => {
    const r = await call('POST', '/api/auth/register', {
      body: { email: 'Ann@Test.com', password: 'Secret123', profile: { fullName: 'Ann Lee', interests: ['beach', 'beach'] } },
    });
    assert.equal(r.status, 201);
    assert.ok(r.body.token);
    assert.equal(r.body.user.email, 'ann@test.com');
    assert.equal(r.body.user.passwordHash, undefined);
    assert.deepEqual(r.body.user.profile.interests, ['beach']); // de-duplicated
    assert.equal(r.body.user.role, 'user');
    userToken = r.body.token;
  });

  test('rejects duplicate e-mail (409), weak password (400) and unknown fields (400)', async () => {
    const dup = await call('POST', '/api/auth/register', { body: { email: 'ann@test.com', password: 'Secret123', profile: { fullName: 'Ann' } } });
    assert.equal(dup.status, 409);
    const weak = await call('POST', '/api/auth/register', { body: { email: 'b@test.com', password: 'short', profile: { fullName: 'Bob' } } });
    assert.equal(weak.status, 400);
    assert.ok(weak.body.details.some((d) => d.path === 'password'));
    const extra = await call('POST', '/api/auth/register', { body: { email: 'c@test.com', password: 'Secret123', role: 'admin', profile: { fullName: 'Cy' } } });
    assert.equal(extra.status, 400); // mass-assignment of "role" is impossible
  });

  test('login succeeds with the right password and fails with the wrong one', async () => {
    const ok = await call('POST', '/api/auth/login', { body: { email: 'ann@test.com', password: 'Secret123' } });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.token);
    const bad = await call('POST', '/api/auth/login', { body: { email: 'ann@test.com', password: 'wrong-pass1' } });
    assert.equal(bad.status, 401);
    const unknown = await call('POST', '/api/auth/login', { body: { email: 'nobody@test.com', password: 'Secret123' } });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.message, bad.body.message);
  });

  test('profile endpoints require a token and update only the given fields', async () => {
    assert.equal((await call('GET', '/api/users/me')).status, 401);
    assert.equal((await call('GET', '/api/users/me', { token: 'garbage' })).status, 401);
    const upd = await call('PUT', '/api/users/me', { token: userToken, body: { age: 31, budgetLevel: 3, travelStyle: 'couple' } });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.profile.age, 31);
    assert.equal(upd.body.profile.fullName, 'Ann Lee'); // untouched
    const invalid = await call('PUT', '/api/users/me', { token: userToken, body: { budgetLevel: 9 } });
    assert.equal(invalid.status, 400);
  });
});

describe('item catalogue CRUD', () => {
  let id;
  test('only admins can create items', async () => {
    assert.equal((await call('POST', '/api/items', { body: sampleItem() })).status, 401);
    assert.equal((await call('POST', '/api/items', { token: userToken, body: sampleItem() })).status, 403);
    const r = await call('POST', '/api/items', { token: adminToken, body: sampleItem() });
    assert.equal(r.status, 201);
    assert.equal(r.body.stats.ratingCount, 0);
    assert.equal(r.body.nameLower, undefined);
    assert.deepEqual(r.body.location.coordinates, [76.9, 43.2]);
    id = r.body._id;
  });

  test('rejects duplicates and invalid data', async () => {
    assert.equal((await call('POST', '/api/items', { token: adminToken, body: sampleItem() })).status, 409);
    assert.equal((await call('POST', '/api/items', { token: adminToken, body: sampleItem({ name: 'X2', category: 'space' }) })).status, 400);
    assert.equal((await call('POST', '/api/items', { token: adminToken, body: sampleItem({ name: 'X3', location: { lat: 200, lon: 0 } }) })).status, 400);
  });

  test('reads, updates and deletes an item', async () => {
    const got = await call('GET', `/api/items/${id}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.name, 'Test Peak');
    assert.equal((await call('GET', '/api/items/not-an-id')).status, 400);
    assert.equal((await call('GET', '/api/items/000000000000000000000000')).status, 404);

    const upd = await call('PUT', `/api/items/${id}`, { token: adminToken, body: { name: 'Zhetysu Peak', priceLevel: 3 } });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.priceLevel, 3);
    // the lower-case helper field follows the name, so prefix search finds it
    const found = await call('GET', '/api/items/search?q=zhet');
    assert.equal(found.body.mode, 'prefix');
    assert.equal(found.body.data[0]._id, id);

    assert.equal((await call('DELETE', `/api/items/${id}`, { token: userToken })).status, 403);
    const del = await call('DELETE', `/api/items/${id}`, { token: adminToken });
    assert.equal(del.status, 200);
    assert.equal((await call('GET', `/api/items/${id}`)).status, 404);
  });
});

describe('interactions and history', () => {
  let itemId;
  before(async () => {
    const r = await call('POST', '/api/items', { token: adminToken, body: sampleItem({ name: 'Interaction Lake', category: 'nature' }) });
    itemId = r.body._id;
  });
  const stats = async () => (await call('GET', `/api/items/${itemId}`)).body.stats;

  test('views raise the view counter and popularity', async () => {
    assert.equal((await call('POST', '/api/interactions', { body: { itemId, type: 'view' } })).status, 401);
    const r = await call('POST', '/api/interactions', { token: userToken, body: { itemId, type: 'view', context: { device: 'mobile' } } });
    assert.equal(r.status, 201);
    assert.equal(r.body.weight, 1);
    const s = await stats();
    assert.equal(s.viewCount, 1);
    assert.equal(s.popularity, 1);
  });

  test('a rating is an upsert: re-rating changes the average, not the count', async () => {
    assert.equal((await call('POST', '/api/interactions', { token: userToken, body: { itemId, type: 'rating' } })).status, 400);
    assert.equal((await call('POST', '/api/interactions', { token: userToken, body: { itemId, type: 'rating', rating: 6 } })).status, 400);
    assert.equal((await call('POST', '/api/interactions', { token: userToken, body: { itemId, type: 'view', rating: 4 } })).status, 400);
    await call('POST', '/api/interactions', { token: userToken, body: { itemId, type: 'rating', rating: 5 } });
    let s = await stats();
    assert.equal(s.ratingCount, 1);
    assert.equal(s.avgRating, 5);
    await call('POST', '/api/interactions', { token: userToken, body: { itemId, type: 'rating', rating: 3 } });
    await call('POST', '/api/interactions', { token: adminToken, body: { itemId, type: 'rating', rating: 4 } });
    s = await stats();
    assert.equal(s.ratingCount, 2);
    assert.equal(s.ratingSum, 7);
    assert.equal(s.avgRating, 3.5);
    assert.equal(await db.collection('interactions').countDocuments({ itemId: new (await import('mongodb')).ObjectId(itemId), type: 'rating' }), 2);
  });

  test('user taste profile and recent activity are maintained', async () => {
    const me = (await call('GET', '/api/users/me', { token: userToken })).body;
    // view(+1) + rating 5(+2) then 5->3 (-2)  => 1
    assert.equal(me.tasteProfile.nature, 1);
    assert.ok(me.recentActivity.length >= 3);
    assert.ok(me.recentActivity.length <= 20);
  });

  test('bookmarks can be removed and counters are reverted; views cannot', async () => {
    const bm = await call('POST', '/api/interactions', { token: userToken, body: { itemId, type: 'bookmark' } });
    const before = (await stats()).popularity;
    assert.equal((await call('DELETE', `/api/interactions/${bm.body._id}`, { token: adminToken })).status, 204); // admin may delete
    assert.equal((await stats()).popularity, before - 3);
    const view = await call('POST', '/api/interactions', { token: userToken, body: { itemId, type: 'view' } });
    assert.equal((await call('DELETE', `/api/interactions/${view.body._id}`, { token: userToken })).status, 400);
    const other = await call('POST', '/api/interactions', { token: adminToken, body: { itemId, type: 'bookmark' } });
    assert.equal((await call('DELETE', `/api/interactions/${other.body._id}`, { token: userToken })).status, 403);
  });

  test('history is paginated, newest first, filterable and joined with item data', async () => {
    const h = await call('GET', '/api/users/me/history?limit=2', { token: userToken });
    assert.equal(h.status, 200);
    assert.equal(h.body.data.length, 2);
    assert.equal(h.body.data[0].item.name, 'Interaction Lake');
    assert.ok(new Date(h.body.data[0].createdAt) >= new Date(h.body.data[1].createdAt));
    const ratings = await call('GET', '/api/users/me/history?type=rating', { token: userToken });
    assert.equal(ratings.body.total, 1);
    assert.equal(ratings.body.data[0].rating, 3);
  });

  test('interaction with an unknown item is a 404', async () => {
    const r = await call('POST', '/api/interactions', { token: userToken, body: { itemId: '000000000000000000000000', type: 'view' } });
    assert.equal(r.status, 404);
  });
});

describe('search', () => {
  before(async () => {
    const mk = (o) => buildItemDoc({ tags: [], bestSeasons: [], ...o });
    await db.collection('items').insertMany([
      mk({ name: 'Almaty Green Market', description: 'Food market with dried fruit and spices.', category: 'gastronomy', country: 'Kazakhstan', city: 'Almaty', location: { lat: 43.26, lon: 76.95 }, tags: ['market', 'local-food'], priceLevel: 1, avgDailyCostUSD: 30, bestSeasons: ['summer'] }),
      mk({ name: 'Paris Louvre Test', description: 'Art museum in the centre of Paris.', category: 'museum', country: 'France', city: 'Paris', location: { lat: 48.86, lon: 2.34 }, tags: ['art'], priceLevel: 4, avgDailyCostUSD: 200, bestSeasons: ['winter'] }),
      mk({ name: 'Charyn Test Canyon', description: 'Red canyon, a great place for hiking near Almaty.', category: 'nature', country: 'Kazakhstan', city: 'Charyn', location: { lat: 43.35, lon: 79.08 }, tags: ['canyon', 'hiking'], priceLevel: 1, avgDailyCostUSD: 50, bestSeasons: ['spring'] }),
    ]);
  });
  const s = (qs) => call('GET', '/api/items/search?' + qs);

  test('full-text search ranks by relevance and reports its mode', async () => {
    const r = await s('q=hiking');
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'text');
    assert.ok(r.body.data.length >= 1);
    assert.ok(r.body.data[0].score > 0);
    assert.equal(r.body.data[0].name, 'Charyn Test Canyon'); // tag + description match
  });

  test('partial words fall back to prefix matching', async () => {
    const r = await s('q=Alma');
    assert.equal(r.body.mode, 'prefix');
    assert.ok(r.body.data.some((x) => x.city === 'Almaty'));
  });

  test('filters: category, country (case-insensitive), price range, season, rating', async () => {
    assert.deepEqual((await s('category=museum')).body.data.map((x) => x.city), ['Paris']);
    assert.ok((await s('country=kazakhstan&category=gastronomy,nature')).body.data.every((x) => x.country === 'Kazakhstan'));
    const cheap = await s('maxPrice=1&country=Kazakhstan');
    assert.ok(cheap.body.data.every((x) => x.priceLevel <= 1));
    assert.equal((await s('season=winter&category=museum')).body.total, 1);
    assert.equal((await s('minRating=4.5')).body.total, 0);
    assert.equal((await s('minPrice=3&maxPrice=1')).status, 400);
  });

  test('geo search returns distances, nearest first', async () => {
    const r = await s('lat=43.25&lon=76.9&radiusKm=300&category=gastronomy,nature');
    assert.equal(r.body.mode, 'geo');
    assert.ok(r.body.data[0].distanceKm < 20);
    const km = r.body.data.map((x) => x.distanceKm);
    assert.deepEqual(km, [...km].sort((a, b) => a - b));
    assert.equal((await s('lat=43.25')).status, 400);
    // text + geo together
    const both = await s('q=canyon&lat=43.25&lon=76.9&radiusKm=300');
    assert.equal(both.body.mode, 'text');
    assert.equal(both.body.data[0].name, 'Charyn Test Canyon');
  });

  test('pagination and listing endpoints', async () => {
    const p1 = await call('GET', '/api/items?limit=2&page=1&sort=name');
    assert.equal(p1.body.data.length, 2);
    assert.ok(p1.body.total >= 4);
    assert.equal(p1.body.totalPages, Math.ceil(p1.body.total / 2));
    assert.equal((await call('GET', '/api/items?limit=500')).status, 400);
    const pop = await call('GET', '/api/items/popular?limit=1');
    assert.equal(pop.body.data.length, 1);
    assert.equal(pop.body.data[0].name, 'Interaction Lake'); // the only item with interactions
  });
});

test('health check and unknown routes', async () => {
  assert.equal((await call('GET', '/api/health')).body.status, 'ok');
  assert.equal((await call('GET', '/api/nothing')).status, 404);
  const bad = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  assert.equal(bad.status, 400);
});
