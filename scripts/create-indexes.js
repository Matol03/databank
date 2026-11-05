// Creates the indexes without touching the data (the serverless deployment does not do it on start-up).
import { config } from '../src/config.js';
import { connect, close, ensureIndexes } from '../src/db.js';

const db = await connect(config.mongoUri, config.dbName);
await ensureIndexes(db);
console.log(`Indexes are in place in "${config.dbName}"`);
await close();
