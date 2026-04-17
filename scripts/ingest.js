// scripts/ingest.js
//
// Multi-file ingestion: walks source-files/, loads text for each
// supported file, chunks each, embeds every chunk with Gemini, and
// writes a unified data/chunks.json with source metadata so answers
// can cite which document they came from.
//
// Supported formats:
//   .pdf   -> OCR cache or pdf-parse direct extraction
//   .pptx  -> OCR cache or officeparser direct extraction
//   .txt   -> direct fs.readFileSync (no extraction library needed)
//   .hwp   -> hwp.js local extraction (no API call needed)
//   .mp3   -> OCR cache required (run "npm run ocr" first)
//   .mp4   -> OCR cache required (run "npm run ocr" first)
//
// Single-file override: if SOURCE_FILE is set in .env, only that
// file is processed.
//
// Usage:
//   npm run ingest

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { parseOffice } from 'officeparser';

import { extractHwpText } from './lib/hwp-extract.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const EMBED_MODEL = process.env.EMBED_MODEL || 'gemini-embedding-001';
const SOURCE_FILE_OVERRIDE = process.env.SOURCE_FILE || process.env.PDF_PATH;

const SOURCE_DIR = path.join(ROOT, 'source-files');
const EXTRACTED_DIR = path.join(ROOT, 'data', 'extracted');
const CHUNKS_PATH = path.join(ROOT, 'data', 'chunks.json');

const SUPPORTED_EXTS = new Set(['.pdf', '.pptx', '.txt', '.hwp', '.mp3', '.mp4']);

function die(msg) {
  console.error(`[ingest] ERROR: ${msg}`);
  process.exit(1);
}
if (!GEMINI_API_KEY) die('GEMINI_API_KEY is not set.');

// ---------- Source file discovery ----------
function discoverSourceFiles() {
  if (SOURCE_FILE_OVERRIDE) {
    const abs = path.isAbsolute(SOURCE_FILE_OVERRIDE)
      ? SOURCE_FILE_OVERRIDE
      : path.resolve(ROOT, SOURCE_FILE_OVERRIDE);
    if (!fs.existsSync(abs)) die(`SOURCE_FILE not found: ${abs}`);
    return [abs];
  }

  if (!fs.existsSync(SOURCE_DIR)) {
    die(`source-files/ directory not found at ${SOURCE_DIR}`);
  }
  return fs
    .readdirSync(SOURCE_DIR)
    .filter((name) => SUPPORTED_EXTS.has(path.extname(name).toLowerCase()))
    .sort()
    .map((name) => path.join(SOURCE_DIR, name));
}

// ---------- Load text for one file (OCR cache or direct extraction) ----------
async function loadTextForFile(filePath) {
  const stem = path.basename(filePath, path.extname(filePath));
  const cachePath = path.join(EXTRACTED_DIR, `${stem}.txt`);

  if (fs.existsSync(cachePath)) {
    const text = fs.readFileSync(cachePath, 'utf-8');
    return { text, source: 'ocr-cache' };
  }

  const ext = path.extname(filePath).toLowerCase();
  let text = '';

  if (ext === '.txt') {
    // Plain text: just read the file directly.
    text = fs.readFileSync(filePath, 'utf-8');
    return { text, source: 'direct' };
  } else if (ext === '.hwp') {
    // HWP 5.x: parse locally via hwp.js (no API call).
    text = extractHwpText(filePath);
  } else if (ext === '.mp3' || ext === '.mp4') {
    // Audio/video: no direct text extraction possible.
    // Must have been transcribed by "npm run ocr" first.
    throw new Error(
      `${ext} files require transcription. Run "npm run ocr" first to ` +
        `populate data/extracted/${stem}.txt, then re-run ingest.`,
    );
  } else if (ext === '.pdf') {
    const buf = fs.readFileSync(filePath);
    const pdf = await pdfParse(buf);
    text = pdf.text;
  } else if (ext === '.pptx') {
    // officeparser can return Buffer or non-string on some files.
    const raw = await parseOffice(filePath);
    text = typeof raw === 'string' ? raw : String(raw || '');
  } else {
    throw new Error(`Unsupported extension: ${ext}`);
  }

  if (!text || text.trim().length < 50) {
    throw new Error(
      `Direct extraction yielded only ${text.length} chars — file is likely ` +
        `scanned/image-based. Run "npm run ocr" first to populate ` +
        `data/extracted/${stem}.txt, then re-run ingest.`,
    );
  }

  return { text, source: 'direct' };
}

// ---------- Chunking ----------
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

// ---------- Embedding (single embedContent, looped) ----------
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

// ---------- Main ----------
async function main() {
  const sourceFiles = discoverSourceFiles();
  if (sourceFiles.length === 0) {
    die(
      'No source files found. Add .pdf, .pptx, .txt, .hwp, .mp3, or .mp4 files ' +
        'to source-files/ or set SOURCE_FILE in .env.',
    );
  }

  console.log(`[ingest] Found ${sourceFiles.length} source file(s)`);

  // Step 1: load text from each file
  const fileTexts = []; // [{ source: basename, text }]
  for (const filePath of sourceFiles) {
    const basename = path.basename(filePath);
    try {
      const { text, source } = await loadTextForFile(filePath);
      console.log(
        `[ingest] Loaded ${basename}: ${text.length} chars (${source})`,
      );
      fileTexts.push({ source: basename, text });
    } catch (err) {
      console.error(`[ingest] SKIP ${basename}: ${err.message}`);
    }
  }

  if (fileTexts.length === 0) {
    die('No source texts could be loaded. Aborting.');
  }

  // Step 2: chunk each file's text and tag with source
  console.log('');
  console.log('[ingest] Chunking...');
  const allChunks = []; // [{ source, text }]
  for (const { source, text } of fileTexts) {
    const chunks = chunkText(text);
    console.log(`[ingest]   ${source}: ${chunks.length} chunks`);
    for (const chunk of chunks) {
      allChunks.push({ source, text: chunk });
    }
  }
  console.log(`[ingest] Total: ${allChunks.length} chunks`);

  // Step 3: embed every chunk
  console.log('');
  console.log('[ingest] Embedding...');
  for (let i = 0; i < allChunks.length; i++) {
    allChunks[i].embedding = await embedOne(allChunks[i].text);
    if ((i + 1) % 10 === 0 || i === allChunks.length - 1) {
      console.log(`[ingest]   ${i + 1}/${allChunks.length}`);
    }
    if (i < allChunks.length - 1) {
      // Small delay to avoid rate-limit bursts on the free tier.
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  // Step 4: assemble final structure with stable IDs and save
  const knowledge = allChunks.map((c, i) => ({
    id: i,
    source: c.source,
    text: c.text,
    embedding: c.embedding,
  }));

  fs.mkdirSync(path.dirname(CHUNKS_PATH), { recursive: true });
  fs.writeFileSync(CHUNKS_PATH, JSON.stringify(knowledge));
  console.log('');
  console.log(`[ingest] Saved ${knowledge.length} chunks to ${CHUNKS_PATH}`);

  // Per-source breakdown
  const bySource = {};
  for (const k of knowledge) {
    bySource[k.source] = (bySource[k.source] || 0) + 1;
  }
  console.log('[ingest] Breakdown by source:');
  for (const [src, count] of Object.entries(bySource)) {
    console.log(`[ingest]   ${count} chunks  ${src}`);
  }
}

main().catch((err) => {
  console.error('[ingest] FAILED:', err);
  process.exit(1);
});
