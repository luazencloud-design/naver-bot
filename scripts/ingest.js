// scripts/ingest.js
//
// One-time job: get the source text (preferring OCR output if
// present, falling back to pdf-parse on the PDF), split it into
// chunks, embed each chunk with Voyage AI, and save the result to
// data/chunks.json.
//
// Usage:
//   npm run ingest
//
// If the source PDF is scanned (image-based), run "npm run ocr"
// first to produce data/extracted.txt.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

// pdf-parse's index.js contains debug code that tries to open a test
// file at import time. Importing the library file directly avoids it.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const PDF_PATH = process.env.PDF_PATH;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-004';

// ---------- Validate env ----------
function die(msg) {
  console.error(`[ingest] ERROR: ${msg}`);
  process.exit(1);
}
if (!GEMINI_API_KEY) die('GEMINI_API_KEY is not set.');

// ---------- Source text loading ----------
// Prefers OCR output (data/extracted.txt) over PDF text extraction.
async function loadSourceText() {
  const extractedPath = path.join(ROOT, 'data', 'extracted.txt');

  if (fs.existsSync(extractedPath)) {
    const text = fs.readFileSync(extractedPath, 'utf-8');
    console.log(
      `[ingest] Using OCR text from ${extractedPath} (${text.length} chars)`,
    );
    return text;
  }

  if (!PDF_PATH) {
    die(
      'No OCR text file found and PDF_PATH is not set. ' +
        'Either set PDF_PATH in .env or run "npm run ocr" first.',
    );
  }
  if (!fs.existsSync(PDF_PATH)) {
    die(`No OCR text file found and PDF not found at: ${PDF_PATH}`);
  }

  console.log(`[ingest] Reading PDF directly: ${PDF_PATH}`);
  const dataBuffer = fs.readFileSync(PDF_PATH);
  const pdf = await pdfParse(dataBuffer);
  console.log(`[ingest] Pages: ${pdf.numpages}, Chars: ${pdf.text.length}`);

  if (!pdf.text || pdf.text.trim().length < 50) {
    die(
      'Very little text extracted. The PDF appears to be scanned (image-based). ' +
        'Run "npm run ocr" first to OCR the PDF with Gemini, then try again.',
    );
  }

  return pdf.text;
}

// ---------- Chunking ----------
// Split by paragraphs, then merge adjacent paragraphs up to targetSize.
// If a single paragraph is bigger than targetSize, hard-split it with overlap.
function chunkText(text, targetSize = 800, overlap = 100) {
  const clean = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const paragraphs = clean
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks = [];
  let current = '';

  const flush = () => {
    if (current) {
      chunks.push(current);
      current = '';
    }
  };

  for (const para of paragraphs) {
    if ((current ? current.length + 2 : 0) + para.length <= targetSize) {
      current = current ? `${current}\n\n${para}` : para;
      continue;
    }
    flush();
    if (para.length > targetSize) {
      for (let i = 0; i < para.length; i += targetSize - overlap) {
        chunks.push(para.slice(i, i + targetSize));
      }
    } else {
      current = para;
    }
  }
  flush();

  return chunks;
}

// ---------- Embedding (Gemini single embedContent, looped) ----------
// gemini-embedding-001 does not support synchronous batchEmbedContents,
// only single embedContent calls. We loop over them sequentially.
// Fine for a few hundred chunks; slow for thousands.
async function embedOne(text) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${EMBED_MODEL}:embedContent?key=${GEMINI_API_KEY}`;

  const body = JSON.stringify({
    model: `models/${EMBED_MODEL}`,
    content: { parts: [{ text }] },
    taskType: 'RETRIEVAL_DOCUMENT',
    outputDimensionality: 768,
  });

  const maxAttempts = 5;
  let lastErr = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if ([429, 500, 502, 503, 504].includes(resp.status)) {
      const errText = await resp.text();
      lastErr = `Gemini embedding ${resp.status}: ${errText.slice(0, 200)}`;
      if (attempt < maxAttempts) {
        const waitMs = 10000 * attempt;
        console.warn(`[ingest] ${lastErr.slice(0, 120)}`);
        console.warn(
          `[ingest] attempt ${attempt}/${maxAttempts}, waiting ${waitMs / 1000}s...`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw new Error(`Gemini embedding failed after ${maxAttempts} attempts: ${lastErr}`);
    }

    if (!resp.ok) {
      throw new Error(`Gemini embedding API ${resp.status}: ${await resp.text()}`);
    }

    const data = await resp.json();
    return data.embedding.values;
  }

  throw new Error(`embedOne: exhausted retries. Last error: ${lastErr}`);
}

async function embedBatch(texts) {
  const results = [];
  for (const text of texts) {
    const vector = await embedOne(text);
    results.push(vector);
    // Small delay to avoid rate-limit bursts on the free tier.
    await new Promise((r) => setTimeout(r, 150));
  }
  return results;
}

// ---------- Main ----------
async function main() {
  const sourceText = await loadSourceText();

  console.log('[ingest] Chunking...');
  const chunks = chunkText(sourceText);
  console.log(`[ingest] Produced ${chunks.length} chunks`);

  console.log('[ingest] Embedding...');
  const BATCH = 32;
  const all = [];
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const vectors = await embedBatch(batch);
    all.push(...vectors);
    console.log(`[ingest]   ${Math.min(i + BATCH, chunks.length)}/${chunks.length}`);
  }

  const knowledge = chunks.map((text, i) => ({
    id: i,
    text,
    embedding: all[i],
  }));

  const outDir = path.join(ROOT, 'data');
  const outPath = path.join(outDir, 'chunks.json');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(knowledge));
  console.log(`[ingest] Saved ${knowledge.length} chunks to ${outPath}`);
}

main().catch((err) => {
  console.error('[ingest] FAILED:', err);
  process.exit(1);
});
