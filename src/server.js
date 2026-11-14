import http from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { pingDatabase } from './db/pool.js';
import { initSockets } from './sockets/index.js';

const app = createApp();

// Vercel imports the default export and runs it as one serverless function.
// A long-lived HTTP server and Socket.IO cannot run on Vercel; in that
// environment the client uses its polling fallback instead.
export default app;

if (!env.IS_VERCEL) {
  const server = http.createServer(app);
  initSockets(server);

  async function start() {
    try {
      await pingDatabase();
      console.log(`Database connected: ${env.DB_NAME} @ ${env.DB_HOST}:${env.DB_PORT}`);
    } catch (err) {
      console.error('Database connection failed:', err.message);
      console.error('Check server/.env and make sure MySQL is running.');
      process.exit(1);
    }

    server.listen(env.PORT, () => {
      console.log(`VITALIS API listening on http://localhost:${env.PORT}`);
      console.log(`Client origin: ${env.CLIENT_ORIGIN}`);
    });
  }

  function shutdown(signal) {
    console.log(`\n${signal} received, shutting down...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  start();
}
