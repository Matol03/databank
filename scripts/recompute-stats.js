import { config } from '../src/config.js';
import { connect, close } from '../src/db.js';
import { recomputeAll } from '../src/services/stats.js';

const db = await connect(config.mongoUri, config.dbName);
const r = await recomputeAll(db);
console.log(`Recomputed counters for ${r.items} items and ${r.users} users`);
await close();
