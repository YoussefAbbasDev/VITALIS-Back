import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import { pingDatabase } from './db/pool.js';
import { AppError, errorHandler, notFoundHandler } from './utils/errors.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import astronautRoutes from './routes/astronauts.js';
import environmentRoutes from './routes/environment.js';
import alertRoutes from './routes/alerts.js';
import checkinRoutes from './routes/checkins.js';
import noteRoutes from './routes/notes.js';
import crewRoutes from './routes/crew.js';
import reportRoutes from './routes/reports.js';
import assistantRoutes from './routes/assistant.js';

export function createApp() {
  const app = express();

  // Vercel terminates TLS at its edge; trust its forwarding headers so rate
  // limiting sees the real client IP and secure cookies are detected.
  if (env.TRUST_PROXY || env.IS_VERCEL) app.set('trust proxy', 1);

  app.use(
    helmet({
      // The API only returns JSON; the client is served separately by Vite.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: false,
    }),
  );

  const allowedOrigins = env.CLIENT_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);
  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin/tooling requests have no Origin header.
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        // Reject with a clear 403 instead of letting a generic error become a 500.
        return callback(
          new AppError(403, 'origin_not_allowed', 'This origin is not allowed to call the API'),
        );
      },
      credentials: true,
    }),
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/api/health', async (req, res) => {
    try {
      await pingDatabase();
      res.json({ status: 'ok', db: 'up', timestamp: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'degraded', db: 'down' });
    }
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/astronauts', astronautRoutes);
  app.use('/api/environment', environmentRoutes);
  app.use('/api/alerts', alertRoutes);
  app.use('/api/checkins', checkinRoutes);
  app.use('/api/notes', noteRoutes);
  app.use('/api/crew', crewRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/assistant', assistantRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
