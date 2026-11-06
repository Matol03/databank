import { config } from '../src/config.js';
import { connect, close } from '../src/db.js';
import { rebuildFavoritePlaces } from '../src/services/interactions.js';

const db = await connect(config.mongoUri, config.dbName);
try {
  const result = await rebuildFavoritePlaces(db);
  console.log(`Backfilled favoritePlaces for ${result.users} users`);
} finally {
  await close();
}
