// src/server.js
//
// Local development entry point. Starts the Express app on a port.
// On Vercel, this file is NOT used — api/index.js is the entry.

import app from './app.js';

const PORT = parseInt(process.env.PORT || '3000', 10);

app.listen(PORT, () => {
  console.log(`[server] Kakao ClassBot listening on http://localhost:${PORT}`);
  console.log(`[server]   sync:     POST /kakao/skill`);
  console.log(`[server]   callback: POST /kakao/skill/callback`);
});
