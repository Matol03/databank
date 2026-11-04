import { ZodError } from 'zod';
import { AppError } from '../errors.js';

export function notFound(_req, res) {
  res.status(404).json({ error: 'NotFound', message: 'Route not found' });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'Invalid request',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.code || 'Error', message: err.message });
  }
  if (err?.code === 11000) {
    return res.status(409).json({ error: 'Conflict', message: 'A record with the same unique value already exists' });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'BadRequest', message: 'Malformed JSON body' });
  }
  console.error(err);
  res.status(500).json({ error: 'InternalError', message: 'Unexpected server error' });
}
