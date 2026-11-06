import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { config, configProblem } from './config.js';
import { connect, ensureIndexes, getDb, isConnected } from './db.js';
import { autoSeed } from './services/seed.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import itemRoutes from './routes/items.js';
import interactionRoutes from './routes/interactions.js';
import { notFound, errorHandler } from './middleware/error.js';

let connecting = null;
const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));

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
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        imgSrc: ["'self'", 'data:', 'https:'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
      },
    },
  }));
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));

  // Serve the website before database initialization so the static UI remains available
  // when MongoDB is temporarily offline or not configured.
  app.use(express.static(publicDirectory, {
    index: 'index.html',
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  }));

  // Only API requests need MongoDB; static frontend assets do not.
  app.use('/api', ensureReady);

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
    const marker = await db.collection('meta').findOne({ _id: 'seed' }, { projection: { status: 1, error: 1 } });
    const body = {
      status: 'ok', database: 'up', name: db.databaseName,
      counts: { items, users, interactions }, ...(marker && { seed: marker.status, ...(marker.error && { seedError: marker.error }) }),
      time: new Date().toISOString(),
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
