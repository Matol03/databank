/**
 * Performance test of the recommendation engine as the database grows.
 *
 *   npm run benchmark                                 -> sizes 300, 1000, 3000 users
 *   node scripts/benchmark.js --sizes=300,1000,3000,10000 --samples=100
 *
 * For every size the separate database "<DB_NAME>_bench" is re-seeded (deterministic synthetic data) and measured:
 *   1. the preference query of one user under three access paths: covering index, ordinary index, collection scan
 *   2. the time to build the item-item model
 *   3. the latency of one recommendation request for:
 *        naive item-CF     - similarities computed from the whole event log on every request (no pre-computation)
 *        item-CF           - pre-computed similarities, no cache
 *        item-CF + L2      - result read from the MongoDB cache collection
 *        item-CF + L1      - result read from the in-process LRU cache
 *        user-CF           - neighbours computed on request (candidate pruning)
 *        user-CF, no index - same, but the covering indexes are dropped (shows the cost of the missing index)
 * Results: docs/perf/benchmark.json (+ a Markdown table on stdout). Absolute numbers depend on the machine.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import { config } from '../src/config.js';
import { connect, close, ensureIndexes } from '../src/db.js';
import { seedDatabase } from '../src/services/seed.js';
import { toPreferences, buildItemModel, scoreItemBased } from '../src/services/cf.js';
import { buildModel, recommendForUser, clearMemoryCache, userPreferences } from '../src/services/recommendations.js';

const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};
const SIZES = arg('sizes', '300,1000,3000').split(',').map(Number);
const SAMPLES = Number(arg('samples', 100));
const NAIVE_SAMPLES = Number(arg('naive', 5));

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const stats = (arr) => ({
  n: arr.length,
  mean: +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2),
  p50: +pct(arr, 50).toFixed(2),
  p95: +pct(arr, 95).toFixed(2),
});
async function time(fn) {
  const t = performance.now();
  await fn();
  return performance.now() - t;
}

const walk = (node, acc = { stages: [], indexes: [] }) => {
  if (Array.isArray(node)) node.forEach((n) => walk(n, acc));
  else if (node && typeof node === 'object') {
    if (typeof node.stage === 'string') acc.stages.push(node.stage);
    if (typeof node.indexName === 'string') acc.indexes.push(node.indexName);
    Object.values(node).forEach((v) => walk(v, acc));
  }
  return acc;
};

const db = await connect(config.mongoUri, `${config.dbName}_bench`);
const runs = [];
for (const size of SIZES) {
  console.log(`\n=== ${size} synthetic users ===`);
  const seedMs = await time(() => seedDatabase(db, { users: size, seed: 42 }));
  const inter = db.collection('interactions');
  const counts = {
    users: await db.collection('users').estimatedDocumentCount(),
    items: await db.collection('items').estimatedDocumentCount(),
    interactions: await inter.estimatedDocumentCount(),
  };
  console.log(`seeded in ${(seedMs / 1000).toFixed(1)} s:`, counts);
  const users = (await db.collection('users').find({ role: 'user' }, { projection: { _id: 1 } }).toArray()).map((u) => u._id);
  let s = 12345;
  const sample = Array.from({ length: SAMPLES }, () => { s = (s * 1103515245 + 12345) % 2 ** 31; return users[s % users.length]; });

  /* 1) access paths of the user preference query */
  const prefQuery = (u) => inter.find({ userId: u }, { projection: { _id: 0, itemId: 1, type: 1, weight: 1 } });
  const paths = {};
  for (const [label, hint] of [['covering index (user_item_prefs)', 'user_item_prefs'], ['ordinary index (user_history)', 'user_history'], ['collection scan', { $natural: 1 }]]) {
    const exp = await prefQuery(sample[0]).hint(hint).explain('executionStats');
    const { stages } = walk(exp.queryPlanner.winningPlan);
    const lat = [];
    for (const u of sample.slice(0, label === 'collection scan' ? 20 : SAMPLES)) lat.push(await time(() => prefQuery(u).hint(hint).toArray()));
    paths[label] = {
      plan: [...new Set(stages)].join(' > '),
      keysExamined: exp.executionStats.totalKeysExamined,
      docsExamined: exp.executionStats.totalDocsExamined,
      returned: exp.executionStats.nReturned,
      latency: stats(lat),
    };
  }
  console.table(Object.fromEntries(Object.entries(paths).map(([k, v]) => [k, { plan: v.plan, keys: v.keysExamined, docs: v.docsExamined, p50: v.latency.p50, p95: v.latency.p95 }])));

  /* 2) model build */
  const model = await buildModel(db);
  console.log('model build:', model.timings);

  /* 3) request latency */
  const lat = {};
  // naive: rebuild the similarity matrix from the full log for each request
  lat['naive item-CF (no pre-computation)'] = [];
  for (const u of sample.slice(0, NAIVE_SAMPLES)) {
    lat['naive item-CF (no pre-computation)'].push(await time(async () => {
      const events = await inter.find({}, { projection: { _id: 0, userId: 1, itemId: 1, type: 1, weight: 1 } }).toArray();
      const m = buildItemModel(toPreferences(events));
      scoreItemBased(await userPreferences(db, u), (i) => m.get(i), { limit: 10 });
    }));
  }
  lat['item-CF, pre-computed, no cache'] = [];
  for (const u of sample) lat['item-CF, pre-computed, no cache'].push(await time(() => recommendForUser(db, u, { limit: 10, algorithm: 'item', cache: false })));
  // fill both cache levels, then read from L2 only (L1 cleared before every call) and from L1
  for (const u of sample) await recommendForUser(db, u, { limit: 10, algorithm: 'item', cache: true });
  lat['item-CF + database cache (L2)'] = [];
  for (const u of sample) { clearMemoryCache(); lat['item-CF + database cache (L2)'].push(await time(() => recommendForUser(db, u, { limit: 10, algorithm: 'item', cache: true }))); }
  for (const u of sample) await recommendForUser(db, u, { limit: 10, algorithm: 'item', cache: true });
  lat['item-CF + memory cache (L1)'] = [];
  for (const u of sample) lat['item-CF + memory cache (L1)'].push(await time(() => recommendForUser(db, u, { limit: 10, algorithm: 'item', cache: true })));
  lat['user-CF, on request'] = [];
  for (const u of sample) lat['user-CF, on request'].push(await time(() => recommendForUser(db, u, { limit: 10, algorithm: 'user', cache: false })));
  // the neighbour queries of user-based CF with and without the covering indexes (same code both times)
  const neighbourQueries = async (u) => {
    const mine = await inter.find({ userId: u }, { projection: { _id: 0, itemId: 1, type: 1, weight: 1 } }).toArray();
    const liked = [...new Set(mine.map((e) => e.itemId))];
    const overlap = await inter.aggregate([
      { $match: { itemId: { $in: liked }, userId: { $ne: u } } },
      { $group: { _id: '$userId', common: { $addToSet: '$itemId' } } },
      { $project: { n: { $size: '$common' } } }, { $sort: { n: -1, _id: 1 } }, { $limit: config.cfUserCandidates },
    ]).toArray();
    await inter.find({ userId: { $in: overlap.map((o) => o._id) } }, { projection: { _id: 0, userId: 1, itemId: 1, type: 1, weight: 1 } }).toArray();
  };
  const NQ = Math.min(30, SAMPLES);
  lat['user-CF queries, covering indexes'] = [];
  for (const u of sample.slice(0, NQ)) lat['user-CF queries, covering indexes'].push(await time(() => neighbourQueries(u)));
  await inter.dropIndex('user_item_prefs');
  await inter.dropIndex('item_user_prefs');
  lat['user-CF queries, no covering indexes'] = [];
  for (const u of sample.slice(0, NQ)) lat['user-CF queries, no covering indexes'].push(await time(() => neighbourQueries(u)));
  await ensureIndexes(db);
  const latency = Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, stats(v)]));
  console.table(latency);

  const storage = {};
  for (const c of ['interactions', 'item_similarities', 'recommendation_cache']) {
    const st = await db.command({ collStats: c });
    storage[c] = { documents: st.count, dataKB: Math.round(st.size / 1024), indexKB: Math.round(st.totalIndexSize / 1024), indexes: st.indexSizes && Object.fromEntries(Object.entries(st.indexSizes).map(([k, v]) => [k, Math.round(v / 1024)])) };
  }
  runs.push({ users: size, counts, seedSeconds: +(seedMs / 1000).toFixed(1), accessPaths: paths, model: { ...model.timings, itemsWithNeighbours: model.itemsWithNeighbours }, latency, storage });
}

const out = {
  generatedAt: new Date().toISOString(),
  machine: { platform: `${os.type()} ${os.release()}`, cpu: os.cpus()[0]?.model, cores: os.cpus().length, memoryGB: Math.round(os.totalmem() / 2 ** 30), node: process.version, mongodb: (await db.admin().serverInfo()).version },
  samples: SAMPLES,
  runs,
};
await mkdir(new URL('../docs/perf/', import.meta.url), { recursive: true });
await writeFile(new URL('../docs/perf/benchmark.json', import.meta.url), JSON.stringify(out, null, 2));

console.log('\n| users | interactions | model build ms | naive p50 | item-CF p50 | item-CF p95 | +L2 p50 | +L1 p50 | user-CF p50 | user-CF p95 |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const r of runs) {
  const l = r.latency;
  console.log(`| ${r.counts.users} | ${r.counts.interactions} | ${r.model.totalMs} | ${l['naive item-CF (no pre-computation)'].p50} | ${l['item-CF, pre-computed, no cache'].p50} | ${l['item-CF, pre-computed, no cache'].p95} | ${l['item-CF + database cache (L2)'].p50} | ${l['item-CF + memory cache (L1)'].p50} | ${l['user-CF, on request'].p50} | ${l['user-CF, on request'].p95} |`);
}
console.log('\nSaved docs/perf/benchmark.json');
await db.dropDatabase();
await close();
