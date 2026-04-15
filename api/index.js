// api/index.js
//
// Vercel serverless entry point.
// The catch-all rewrite in vercel.json routes every external request
// to this file, and Vercel's @vercel/node runtime wraps the exported
// Express app automatically.

import app from '../src/app.js';

export default app;
