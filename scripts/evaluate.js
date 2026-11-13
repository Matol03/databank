/**
 * Offline evaluation of the recommendation quality (hold-out test).
 *
 *   npm run evaluate                    -> uses the database from .env (DB_NAME)
 *   node scripts/evaluate.js --k=10 --seed=7
 *
 * Protocol: for every user with at least 4 "relevant" places (bookmarked, visited, booked or rated >= 4),
 * 20 % of those places (at least one) are hidden: all events of these (user, place) pairs are removed
 * from the training data. Each algorithm is trained on the remaining events and recommends k places the
 * user has not interacted with in training. A hit is a hidden place among the k recommendations.
 * Metrics: Precision@k, Recall@k, HitRate@k, NDCG@k, catalogue coverage. Baselines: most popular, random.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { config } from '../src/config.js';
import { connect, close } from '../src/db.js';
import { toPreferences, buildItemModel, scoreItemBased, scoreUserBased } from '../src/services/cf.js';

const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};
const K = Number(arg('k', 10));
let state = Number(arg('seed', 7)) >>> 0;
const rand = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

export async function evaluate(db, { k = K, log = console.log } = {}) {
  const events = await db.collection('interactions')
    .find({}, { projection: { _id: 0, userId: 1, itemId: 1, type: 1, weight: 1, rating: 1 } }).toArray();
  const allItems = (await db.collection('items').find({}, { projection: { _id: 1 } }).toArray()).map((x) => String(x._id));

  // relevant pairs per user
  const relevant = new Map();
  for (const e of events) {
    if (e.type === 'view' || (e.type === 'rating' && e.rating < 4)) continue;
    const u = String(e.userId);
    if (!relevant.has(u)) relevant.set(u, new Set());
    relevant.get(u).add(String(e.itemId));
  }
  const hidden = new Map();
  for (const [u, set] of relevant) {
    if (set.size < 4) continue;
    const list = [...set].sort();
    const n = Math.max(1, Math.round(list.length * 0.2));
    const chosen = new Set();
    while (chosen.size < n) chosen.add(list[Math.floor(rand() * list.length)]);
    hidden.set(u, chosen);
  }
  const train = events.filter((e) => !hidden.get(String(e.userId))?.has(String(e.itemId)));
  const prefs = toPreferences(train);
  const byUser = new Map();
  for (const p of prefs) {
    if (!byUser.has(p.u)) byUser.set(p.u, new Map());
    byUser.get(p.u).set(p.i, p.p);
  }
  const t0 = performance.now();
  const model = buildItemModel(prefs, { k: config.cfNeighbours });
  const buildMs = performance.now() - t0;

  // popularity baseline (training data)
  const pop = new Map();
  for (const p of prefs) if (p.p > 0) pop.set(p.i, (pop.get(p.i) || 0) + p.p);
  const popular = [...pop].sort((a, b) => b[1] - a[1]).map(([i]) => i);

  const algorithms = {
    'Item-based CF': (u, mine) => scoreItemBased(mine, (i) => model.get(i), { limit: k }).map((x) => x.i),
    'User-based CF': (u, mine) => scoreUserBased(u, mine, prefs, { limit: k }).map((x) => x.i),
    'Most popular': (u, mine) => popular.filter((i) => !mine.has(i)).slice(0, k),
    Random: (u, mine) => {
      const pool = allItems.filter((i) => !mine.has(i));
      for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
      return pool.slice(0, k);
    },
  };

  const results = [];
  for (const [name, recommend] of Object.entries(algorithms)) {
    let precision = 0; let recall = 0; let hits = 0; let ndcg = 0; let ms = 0;
    const covered = new Set();
    for (const [u, test] of hidden) {
      const mine = byUser.get(u) || new Map();
      const t = performance.now();
      let recs = recommend(u, mine);
      if (recs.length < k) recs = recs.concat(popular.filter((i) => !mine.has(i) && !recs.includes(i)).slice(0, k - recs.length));
      ms += performance.now() - t;
      recs.forEach((i) => covered.add(i));
      const hitPositions = recs.map((i, idx) => (test.has(i) ? idx : -1)).filter((x) => x >= 0);
      precision += hitPositions.length / k;
      recall += hitPositions.length / test.size;
      if (hitPositions.length) hits += 1;
      const dcg = hitPositions.reduce((s, idx) => s + 1 / Math.log2(idx + 2), 0);
      let idcg = 0;
      for (let idx = 0; idx < Math.min(k, test.size); idx++) idcg += 1 / Math.log2(idx + 2);
      ndcg += dcg / idcg;
    }
    const n = hidden.size;
    results.push({
      algorithm: name,
      [`precision@${k}`]: +(precision / n).toFixed(4),
      [`recall@${k}`]: +(recall / n).toFixed(4),
      [`hitRate@${k}`]: +(hits / n).toFixed(4),
      [`ndcg@${k}`]: +(ndcg / n).toFixed(4),
      coverage: +(covered.size / allItems.length).toFixed(3),
      msPerUser: +(ms / n).toFixed(3),
    });
  }
  const summary = { k, testUsers: hidden.size, hiddenPairs: [...hidden.values()].reduce((s, x) => s + x.size, 0), trainingEvents: train.length, modelBuildMs: Math.round(buildMs), results };
  log(`\nOffline evaluation, ${summary.testUsers} test users, ${summary.hiddenPairs} hidden places, k = ${k}\n`);
  console.table(results);
  return summary;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('evaluate.js')) {
  const db = await connect(config.mongoUri, config.dbName);
  const summary = await evaluate(db);
  await mkdir(new URL('../docs/perf/', import.meta.url), { recursive: true });
  await writeFile(new URL('../docs/perf/evaluation.json', import.meta.url), JSON.stringify({ database: config.dbName, ...summary }, null, 2));
  console.log('\nSaved docs/perf/evaluation.json');
  await close();
}
