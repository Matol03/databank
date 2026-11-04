import { config } from './config.js';
import { connect, close, ensureIndexes } from './db.js';
import { createApp } from './app.js';

const db = await connect(config.mongoUri, config.dbName);
await ensureIndexes(db);

const server = createApp().listen(config.port, () => {
  console.log(`Tourism recommender API listening on http://localhost:${config.port}`);
  console.log(`Database: ${config.dbName} @ ${config.mongoUri}`);
});

async function shutdown(signal) {
  console.log(`\n${signal} received, shutting down...`);
  server.close(async () => {
    await close();
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
