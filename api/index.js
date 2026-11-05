/**
 * Vercel serverless entry point. Every request to the site is rewritten to this function (vercel.json).
 * The MongoDB connection is created once per warm instance and reused.
 * Configuration errors are answered with a readable JSON message instead of a bare 500.
 */
let ready = null;
let app = null;

async function init() {
  // dynamic imports so that a configuration error (e.g. missing JWT_SECRET) is catchable below
  const { config } = await import('../src/config.js');
  const { connect } = await import('../src/db.js');
  const { createApp } = await import('../src/app.js');
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is not set. Add the MongoDB Atlas connection string in the Vercel project settings.');
  }
  await connect(config.mongoUri, config.dbName, { exitOnFail: false });
  app = createApp();
}

export default async function handler(req, res) {
  try {
    ready ??= init().catch((err) => { ready = null; throw err; });
    await ready;
    return app(req, res);
  } catch (err) {
    console.error('Start-up failed:', err.message);
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'ServiceUnavailable', message: err.message }));
  }
}
