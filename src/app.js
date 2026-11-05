import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { config, configProblem } from './config.js';
import { connect, ensureIndexes, getDb, isConnected } from './db.js';
import { seedDatabase } from './services/seed.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import itemRoutes from './routes/items.js';
import interactionRoutes from './routes/interactions.js';
import { notFound, errorHandler } from './middleware/error.js';

let connecting = null;

/**
 * Opt-in (AUTO_SEED=true): fills a completely empty database with the demo data on the first request,
 * so a fresh deployment works without running the seed script by hand. Never touches a database that has data.
 */
async function autoSeed(db) {
  if (process.env.AUTO_SEED !== 'true') return;
  try {
    const counts = await Promise.all(['items', 'users', 'interactions'].map((c) => db.collection(c).estimatedDocumentCount()));
    if (counts.some((n) => n > 0)) return;
    const users = Number(process.env.AUTO_SEED_USERS || 100);
    const r = await seedDatabase(db, { users, drop: false });
    console.log(`AUTO_SEED: loaded ${r.items} items, ${r.users} users, ${r.interactions} interactions`);
  } catch (err) {
    console.error('AUTO_SEED failed:', err.message);
  }
}

/**
 * Serverless platforms (Vercel) load this module and call the app per request, there is no start-up hook.
 * So the database connection is opened lazily on the first request and then reused by the warm instance.
 * Misconfiguration is reported as readable JSON (HTTP 503) instead of a crash.
 */
async function ensureReady(_req, res, next) {
  if (isConnected()) return next();
  try {
    const problem = configProblem();
    if (problem) throw new Error(problem);
    connecting ??= connect(config.mongoUri, config.dbName, { exitOnFail: false })
      .then(async (db) => {
        // idempotent; makes search work even on an empty database (text/geo queries need their indexes)
        await ensureIndexes(db).catch((err) => console.error('Index creation failed:', err.message));
        await autoSeed(db);
      })
      .catch((err) => { connecting = null; throw err; });
    await connecting;
    next();
  } catch (err) {
    console.error('Start-up failed:', err.message);
    res.status(503).json({ error: 'ServiceUnavailable', message: err.message });
  }
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // behind a reverse proxy (Vercel, Render, ...) req.ip must come from X-Forwarded-For,
  // otherwise every visitor shares one rate-limit bucket
  if (process.env.VERCEL || process.env.TRUST_PROXY) app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));

  app.use(ensureReady);

  app.get('/', (_req, res) => {
    res.json({
      name: 'Tourism recommender platform API',
      status: 'running',
      try: ['/api/health', '/api/items/popular?limit=3', '/api/items/search?q=lake'],
      docs: 'https://github.com/Matol03/databank/blob/main/docs/API.md',
    });
  });

  app.get('/api/health', async (_req, res) => {
    const db = getDb();
    await db.command({ ping: 1 });
    const [items, users, interactions] = await Promise.all(
      ['items', 'users', 'interactions'].map((c) => db.collection(c).estimatedDocumentCount()),
    );
    const body = {
      status: 'ok', database: 'up', name: db.databaseName,
      counts: { items, users, interactions }, time: new Date().toISOString(),
    };
    if (items === 0) {
      body.hint = 'The database is empty. Run "npm run seed" with MONGO_URI (and DB_NAME) set to the same values as in this deployment.';
    }
    res.json(body);
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/items', itemRoutes);
  app.use('/api/interactions', interactionRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

// default export: the ready-to-use Express app (required by Vercel's Express runtime)
export default createApp();
