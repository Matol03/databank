import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { getDb } from './db.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import itemRoutes from './routes/items.js';
import interactionRoutes from './routes/interactions.js';
import { notFound, errorHandler } from './middleware/error.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', async (_req, res) => {
    await getDb().command({ ping: 1 });
    res.json({ status: 'ok', database: 'up', time: new Date().toISOString() });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/items', itemRoutes);
  app.use('/api/interactions', interactionRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
