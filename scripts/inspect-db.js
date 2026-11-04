import { inspect } from 'node:util';
import { config } from '../src/config.js';
import { connect, close } from '../src/db.js';

const db = await connect(config.mongoUri, config.dbName);
console.log(`Database: ${config.dbName}\n`);
for (const name of ['users', 'items', 'interactions']) {
  const col = db.collection(name);
  const count = await col.countDocuments();
  const stats = await db.command({ collStats: name }).catch(() => null);
  console.log(`== ${name}: ${count} documents${stats ? `, ${(stats.size / 1024).toFixed(0)} KB data` : ''}`);
  for (const ix of await col.indexes()) {
    const keys = Object.entries(ix.key).map(([k, v]) => `${k}:${v}`).join(', ');
    const flags = [ix.unique && 'unique', ix.partialFilterExpression && 'partial', ix.weights && 'text'].filter(Boolean).join(',');
    console.log(`   index ${ix.name.padEnd(22)} {${keys.length > 60 ? 'text fields...' : keys}} ${flags}`);
  }
  console.log();
}
const show = (title, doc) => {
  console.log(`--- sample ${title} ---`);
  console.log(inspect(doc, { depth: 5, breakLength: 92, compact: 3 }));
  console.log();
};
show('item', await db.collection('items').findOne(
  { 'stats.ratingCount': { $gt: 5 } },
  { projection: { nameLower: 0, countryLower: 0, cityLower: 0, description: 0, createdAt: 0, updatedAt: 0 } }));
show('user', await db.collection('users').findOne(
  { email: 'demo@tourism.local' }, { projection: { passwordHash: 0, recentActivity: { $slice: -2 } } }));
show('interaction', await db.collection('interactions').findOne({ type: 'rating' }));
await close();
