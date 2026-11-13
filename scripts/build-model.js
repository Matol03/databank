/** Builds (or rebuilds) the item-item collaborative-filtering model in `item_similarities`. */
import { config } from '../src/config.js';
import { connect, close, ensureIndexes } from '../src/db.js';
import { buildModel } from '../src/services/recommendations.js';

const db = await connect(config.mongoUri, config.dbName);
await ensureIndexes(db);
const m = await buildModel(db);
console.log(`CF model built for "${config.dbName}":`);
console.log(`  ${m.interactions} interactions -> ${m.preferencePairs} (user, place) preferences of ${m.users} users`);
console.log(`  ${m.itemsWithNeighbours} places with up to ${m.neighboursPerItem} neighbours each`);
console.log(`  load ${m.timings.loadMs} ms + compute ${m.timings.computeMs} ms = ${m.timings.totalMs} ms (incl. writing)`);
await close();
