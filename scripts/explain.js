/**
 * Shows the query plan of the API's most frequent queries.
 * IXSCAN = index used, COLLSCAN = whole collection scanned.
 * The last block compares an indexed query with a forced collection scan.
 */
import { config } from '../src/config.js';
import { connect, close } from '../src/db.js';

const db = await connect(config.mongoUri, config.dbName);
const items = db.collection('items');
const inter = db.collection('interactions');
const users = db.collection('users');

const walk = (node, acc = { stages: [], indexes: [] }) => {
  if (Array.isArray(node)) node.forEach((n) => walk(n, acc));
  else if (node && typeof node === 'object') {
    if (typeof node.stage === 'string') acc.stages.push(node.stage);
    if (typeof node.indexName === 'string') acc.indexes.push(node.indexName);
    Object.values(node).forEach((v) => walk(v, acc));
  }
  return acc;
};
const summarise = (exp) => {
  const plan = exp.queryPlanner.winningPlan;
  const { stages, indexes } = walk(plan);
  const es = exp.executionStats;
  return {
    plan: [...new Set(stages)].filter((s) => !['PROJECTION_DEFAULT', 'PROJECTION_SIMPLE', 'PROJECTION_COVERED'].includes(s)).join(' > '),
    index: [...new Set(indexes)].join(', ') || '-',
    returned: es.nReturned, keysExamined: es.totalKeysExamined, docsExamined: es.totalDocsExamined, ms: es.executionTimeMillis,
  };
};

const someUser = await users.findOne({ email: 'demo@tourism.local' });
const someItem = await items.findOne({ category: 'heritage' });
const rows = [];
const run = async (label, cursor) => rows.push({ query: label, ...summarise(await cursor.explain('executionStats')) });

await run('login: users by e-mail', users.find({ email: 'demo@tourism.local' }));
await run('browse: category=nature by rating', items.find({ category: 'nature' }).sort({ 'stats.avgRating': -1 }).limit(10));
await run('filter: country+city', items.find({ countryLower: 'kazakhstan', cityLower: 'almaty' }));
await run('filter: tag in [hiking]', items.find({ tags: { $in: ['hiking'] } }));
await run('filter: season = winter', items.find({ bestSeasons: 'winter' }));
await run('popular: top 10 by popularity', items.find().sort({ 'stats.popularity': -1 }).limit(10));
await run('search: $text "lake mountains"', items.find({ $text: { $search: 'lake mountains' } }));
await run('search: name prefix "alma"', items.find({ $or: [{ nameLower: /^alma/ }, { cityLower: /^alma/ }] }));
await run('geo: within 300 km of Almaty', items.find({ location: { $geoWithin: { $centerSphere: [[76.95, 43.25], 300 / 6378.1] } } }));
await run('history: last 20 events of a user', inter.find({ userId: someUser._id }).sort({ createdAt: -1 }).limit(20));
await run('item-based CF: events of one item', inter.find({ itemId: someItem._id }));
await run('rating upsert lookup (user,item)', inter.find({ userId: someUser._id, itemId: someItem._id, type: 'rating' }));

const scan = (r) => (r.plan.includes('COLLSCAN') ? 'COLLSCAN' : 'IXSCAN');
console.log('\nQuery plans (explain "executionStats")\n');
console.log('query'.padEnd(37) + 'scan'.padEnd(9) + 'index'.padEnd(29) + 'ret'.padStart(4) + 'docs'.padStart(7) + '  ms');
console.log('-'.repeat(88));
for (const r of rows) {
  console.log(r.query.padEnd(37) + scan(r).padEnd(9) + r.index.replace(', ', '+').padEnd(29)
    + String(r.returned).padStart(4) + String(r.docsExamined).padStart(7) + String(r.ms).padStart(4));
}

const total = await inter.estimatedDocumentCount();
const withIx = summarise(await inter.find({ userId: someUser._id }).sort({ createdAt: -1 }).limit(20).explain('executionStats'));
const noIx = summarise(await inter.find({ userId: someUser._id }).sort({ createdAt: -1 }).limit(20).hint({ $natural: 1 }).explain('executionStats'));
console.log(`\nEffect of the index "user_history" on ${total} interactions (history of one user, 20 rows):\n`);
console.log('variant'.padEnd(20) + 'plan'.padEnd(26) + 'docsExamined'.padStart(13) + '  ms');
console.log('-'.repeat(88));
for (const [name, r] of [['with index', withIx], ['forced COLLSCAN', noIx]]) {
  console.log(name.padEnd(20) + r.plan.padEnd(26) + String(r.docsExamined).padStart(13) + String(r.ms).padStart(4));
}
await close();
