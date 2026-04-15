// src/app.js
//
// Express app definition. Used by both the local dev server
// (src/server.js) and the Vercel serverless entry (api/index.js).

import 'dotenv/config';
import express from 'express';
import { answerQuestion } from './rag.js';
import {
  simpleText,
  useCallbackResponse,
  extractUtterance,
  extractCallbackUrl,
} from './kakao.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------- Health check ----------
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'kakao-class-bot' });
});

// ---------- Synchronous skill (<5s) ----------
app.post('/kakao/skill', async (req, res) => {
  const question = extractUtterance(req.body);
  console.log(`[sync] Q: ${question}`);

  try {
    const answer = await answerQuestion(question);
    console.log(`[sync] A: ${answer.slice(0, 80)}...`);
    res.json(simpleText(answer));
  } catch (err) {
    console.error('[sync] error:', err);
    res.json(
      simpleText('죄송합니다. 일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.'),
    );
  }
});

// ---------- Callback skill (>5s) ----------
// Requires "useCallback" to be enabled in OpenBuilder bot settings.
// NOTE: On Vercel serverless, the background task after res.json() is
// NOT guaranteed to run to completion because the function may be
// suspended. For reliable callback mode on Vercel, use `waitUntil`
// from `@vercel/functions`. On a long-running host (local dev,
// Railway, Render, Fly.io) this endpoint works as-is.
app.post('/kakao/skill/callback', async (req, res) => {
  const question = extractUtterance(req.body);
  const callbackUrl = extractCallbackUrl(req.body);
  console.log(`[callback] Q: ${question}`);
  console.log(`[callback] callbackUrl: ${callbackUrl ? 'yes' : 'no'}`);

  if (!callbackUrl) {
    try {
      const answer = await answerQuestion(question);
      return res.json(simpleText(answer));
    } catch (err) {
      console.error('[callback] sync-fallback error:', err);
      return res.json(simpleText('죄송합니다. 일시적인 오류가 발생했습니다.'));
    }
  }

  res.json(useCallbackResponse('답변을 생성하고 있습니다... (최대 30초)'));

  (async () => {
    try {
      const answer = await answerQuestion(question);
      await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(simpleText(answer)),
      });
      console.log(`[callback] delivered: ${answer.slice(0, 80)}...`);
    } catch (err) {
      console.error('[callback] background error:', err);
      try {
        await fetch(callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            simpleText('답변 생성 중 오류가 발생했습니다. 다시 시도해 주세요.'),
          ),
        });
      } catch (_) {
        /* swallow */
      }
    }
  })();
});

export default app;
