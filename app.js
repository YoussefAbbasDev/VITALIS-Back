/**
 * Vercel entry point.
 *
 * Vercel detects an Express app exported from `app.js` (project root) and runs
 * it as a single serverless function. Local development keeps using
 * `src/server.js`, which also starts Socket.IO and listens on PORT.
 *
 * The factory itself lives in `src/create-app.js` on purpose: any file named
 * `app.js` under `src/` is also treated as a Vercel entry, and a named export
 * there would fail with "Invalid export found".
 */
import { createApp } from './src/create-app.js';

const app = createApp();

export default app;
