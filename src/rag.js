// src/rag.js
//
// Retrieval + generation:
//   1. embed the user's question with Voyage
//   2. cosine-search top-K chunks from data/chunks.json
//   3. ask Gemini to answer using only those chunks

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-004';
const TOP_K = parseInt(process.env.TOP_K || '4', 10);

// ---------- Load knowledge base ----------
const CHUNKS_PATH = path.join(ROOT, 'data', 'chunks.json');
let knowledge = [];
try {
  knowledge = JSON.parse(fs.readFileSync(CHUNKS_PATH, 'utf-8'));
  console.log(`[rag] Loaded ${knowledge.length} chunks from knowledge base`);
} catch (err) {
  console.warn(
    `[rag] WARNING: no knowledge base found at ${CHUNKS_PATH}. ` +
      `Run "npm run ingest" before starting the server.`,
  );
}

// ---------- Cosine similarity ----------
function cosineSim(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ---------- Embed a query (Gemini) ----------
// Must use the SAME outputDimensionality as ingest.js or the vectors
// will be different sizes and cosine similarity breaks.
async function embedQuery(text) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${EMBED_MODEL}:embedContent?key=${process.env.GEMINI_API_KEY}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${EMBED_MODEL}`,
      content: { parts: [{ text }] },
      taskType: 'RETRIEVAL_QUERY',
      outputDimensionality: 768,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Gemini embedding API ${resp.status}: ${body}`);
  }
  const data = await resp.json();
  return data.embedding.values;
}

// ---------- Top-K search ----------
function searchTopK(queryEmbed, k = TOP_K) {
  return knowledge
    .map((chunk) => ({
      id: chunk.id,
      text: chunk.text,
      score: cosineSim(queryEmbed, chunk.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// ---------- Generate answer (Gemini) ----------
// Important: Gemini 2.5 models use internal "thinking tokens" by
// default, which count against maxOutputTokens. With a small budget
// like 800, thinking can consume the entire allowance and leave no
// tokens for the actual answer — the response then has no text and
// finishReason: "MAX_TOKENS". For RAG Q&A we don't need thinking,
// so we disable it via thinkingConfig.thinkingBudget: 0 and give
// the visible answer plenty of room.
async function generateWithGemini(systemPrompt, userQuestion) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set. Add it to .env or Vercel env vars.');
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: userQuestion }],
        },
      ],
      generationConfig: {
        maxOutputTokens: 2048,
        temperature: 0.3,
        thinkingConfig: {
          thinkingBudget: 0,
        },
      },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Gemini API ${resp.status}: ${body}`);
  }

  const data = await resp.json();
  const candidate = data?.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text;

  if (!text) {
    const finishReason = candidate?.finishReason ?? 'unknown';
    const promptFeedback = data?.promptFeedback
      ? JSON.stringify(data.promptFeedback)
      : 'none';
    throw new Error(
      `Gemini returned no text (finishReason=${finishReason}, ` +
        `promptFeedback=${promptFeedback})`,
    );
  }
  return text;
}

// ---------- Main entry ----------
export async function answerQuestion(question) {
  if (!question || question.trim().length === 0) {
    return '질문을 입력해 주세요.';
  }
  if (knowledge.length === 0) {
    return '지식 베이스가 비어 있습니다. 관리자가 "npm run ingest"를 먼저 실행해야 합니다.';
  }

  // 1) Retrieve
  const qEmbed = await embedQuery(question);
  const top = searchTopK(qEmbed);
  const context = top
    .map((c, i) => `[자료 ${i + 1}]\n${c.text}`)
    .join('\n\n---\n\n');

  // 2) Generate
  const systemPrompt = `당신은 "오리엔테이션 사업자내기" 자료를 기반으로 답변하는 친절한 안내 챗봇입니다.

규칙:
1. 반드시 아래 [참고 자료]에 있는 내용만 근거로 답변하세요.
2. 자료에 없는 내용은 추측하지 말고 "해당 정보는 제공된 자료에 포함되어 있지 않습니다. 담당자에게 문의해 주세요."라고 답하세요.
3. 답변은 간결하게, 최대 500자 내외로 작성하세요.
4. 여러 항목이 있으면 번호 목록으로 정리하세요.
5. 한국어로 답변하세요.

[참고 자료]
${context}`;

  const text = await generateWithGemini(systemPrompt, question);
  return text.trim() || '답변을 생성하지 못했습니다. 다시 시도해 주세요.';
}
