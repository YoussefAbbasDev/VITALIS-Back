/**
 * Vercel entry point.
 *
 * Vercel detects an Express app exported from `app.js` (project root) and runs
 * it as a single serverless function. Local development keeps using
 * `src/server.js`, which also starts Socket.IO and listens on PORT.
 */
import { createApp } from './src/app.js';

const app = createApp();

export default app;
