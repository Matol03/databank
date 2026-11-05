import { pathToFileURL } from 'node:url';
import { config, configProblem } from './config.js';
import { connect, close, ensureIndexes } from './db.js';
import app from './app.js';

// Serverless platforms import this file and use the default export; `npm start` runs it directly.
export default app;

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const problem = configProblem();
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  const db = await connect(config.mongoUri, config.dbName);
  await ensureIndexes(db);

  const server = app.listen(config.port, () => {
    console.log(`Tourism recommender API listening on http://localhost:${config.port}`);
    console.log(`Database: ${config.dbName} @ ${config.mongoUri}`);
  });

  const shutdown = (signal) => {
    console.log(`\n${signal} received, shutting down...`);
    server.close(async () => {
      await close();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
