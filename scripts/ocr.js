// scripts/ocr.js
//
// Multi-file extraction job. Walks source-files/ and processes each
// supported file into data/extracted/<basename>.txt:
//
//   .pdf / .pptx  -> Gemini Files API multimodal OCR (page text)
//   .mp3          -> Gemini Files API audio transcription
//   .mp4          -> Gemini Files API video transcription + on-screen text
//   .txt          -> direct copy (no API call needed)
//   .hwp          -> hwp.js local text extraction (no API call needed)
//   .vtt          -> WebVTT parser, strips timestamps/speaker tags (no API)
//
// Caching: if data/extracted/<basename>.txt already exists, the
// file is skipped. Pass --force to re-process everything.
//
// Single-file override: if SOURCE_FILE is set in .env, only that
// file is processed.
//
// Usage:
//   npm run ocr            # process new files only (uses cache)
//   npm run ocr -- --force # re-process everything

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

import { extractHwpText } from './lib/hwp-extract.js';
import { extractVttText } from './lib/vtt-extract.js';
import { convertPptxToPdf } from './lib/pptx-to-pdf.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
const SOURCE_FILE_OVERRIDE = process.env.SOURCE_FILE || process.env.PDF_PATH;

const SOURCE_DIR = path.join(ROOT, 'source-files');
const EXTRACTED_DIR = path.join(ROOT, 'data', 'extracted');

const force = process.argv.includes('--force');

// Map file extension -> Gemini-acceptable MIME type.
// null = handled locally (no Gemini upload needed).
// Note: Gemini Files API does NOT accept PPTX directly (400
// "Unsupported MIME type"). We auto-convert PPTX -> PDF before the
// main loop via PowerPoint COM (see preConvertPptxFiles below), so
// by the time OCR sees a file it's always already a format Gemini
// or a local parser can handle.
const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.txt': null,           // direct copy — no API call
  '.hwp': null,           // hwp.js local extraction — no API call
  '.vtt': null,           // WebVTT speech-only extraction — no API call
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
};

function die(msg) {
  console.error(`[ocr] ERROR: ${msg}`);
  process.exit(1);
}

if (!GEMINI_API_KEY) die('GEMINI_API_KEY is not set. Check your .env file.');

// ---------- Source file discovery ----------
function discoverSourceFiles() {
  // SOURCE_FILE override: legacy single-file mode
  if (SOURCE_FILE_OVERRIDE) {
    const abs = path.isAbsolute(SOURCE_FILE_OVERRIDE)
      ? SOURCE_FILE_OVERRIDE
      : path.resolve(ROOT, SOURCE_FILE_OVERRIDE);
    if (!fs.existsSync(abs)) {
      die(`SOURCE_FILE not found: ${abs}`);
    }
    return [abs];
  }

  // Default: walk source-files/
  if (!fs.existsSync(SOURCE_DIR)) {
    die(`source-files/ directory not found at ${SOURCE_DIR}`);
  }
  const entries = fs.readdirSync(SOURCE_DIR);

  // Stems that have a .pdf — if a .pptx shares a stem with an
  // existing .pdf, we skip the .pptx because the PDF (typically the
  // output of preConvertPptxFiles) will already carry that content.
  const pdfStems = new Set();
  for (const name of entries) {
    if (path.extname(name).toLowerCase() === '.pdf') {
      pdfStems.add(path.basename(name, path.extname(name)));
    }
  }

  const supported = entries
    .filter((name) => {
      // Skip Office lock files like ~$document.pptx
      if (name.startsWith('~$')) return false;
      const ext = path.extname(name).toLowerCase();
      if (ext === '.pptx') {
        const stem = path.basename(name, ext);
        if (pdfStems.has(stem)) return false; // PDF version takes precedence
        return true; // will be handled by preConvertPptxFiles before OCR
      }
      return ext in MIME_BY_EXT;
    })
    .sort()
    .map((name) => path.join(SOURCE_DIR, name));
  return supported;
}

// ---------- Gemini Files API: resumable upload ----------
async function uploadFile(filePath, mimeType) {
  const fileBuffer = fs.readFileSync(filePath);
  const fileSize = fileBuffer.length;
  const displayName = path.basename(filePath);

  console.log(
    `[ocr]   Uploading (${(fileSize / 1024 / 1024).toFixed(1)} MB, ${mimeType})...`,
  );

  const startResp = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(fileSize),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: displayName } }),
    },
  );

  if (!startResp.ok) {
    throw new Error(
      `Upload init failed ${startResp.status}: ${await startResp.text()}`,
    );
  }

  const uploadUrl = startResp.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('No upload URL in response headers');

  const uploadResp = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(fileSize),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: fileBuffer,
  });

  if (!uploadResp.ok) {
    throw new Error(
      `Upload failed ${uploadResp.status}: ${await uploadResp.text()}`,
    );
  }

  return (await uploadResp.json()).file;
}

// maxIterations: 60 = ~2 min for documents, 150 = ~5 min for audio/video
async function waitForActive(fileName, maxIterations = 60) {
  const url = `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${GEMINI_API_KEY}`;
  for (let i = 0; i < maxIterations; i++) {
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Poll failed ${resp.status}: ${await resp.text()}`);
    }
    const data = await resp.json();
    if (data.state === 'ACTIVE') return data;
    if (data.state === 'FAILED') throw new Error('File processing FAILED on Gemini side');
    await new Promise((r) => setTimeout(r, 2000));
  }
  const mins = Math.round((maxIterations * 2) / 60);
  throw new Error(`File did not become ACTIVE within ${mins} minutes`);
}

// ---------- Format-aware extraction prompts ----------
function buildPrompt(mimeType) {
  if (mimeType.startsWith('audio/')) {
    return `이 음성 파일의 내용을 한국어로 정확히 전사(transcribe)해 주세요.

규칙:
1. 음성에서 들리는 모든 말을 누락 없이 전사하세요.
2. 화자가 여러 명이면 "[화자 1]", "[화자 2]" 등으로 구분하세요.
3. 주요 주제가 바뀌는 지점에서 빈 줄을 넣어 단락을 구분하세요.
4. 전사 외에 다른 설명, 주석, 요약을 추가하지 마세요.
5. 들리지 않거나 불명확한 부분은 [불명확]으로 표시하세요.`;
  }

  if (mimeType.startsWith('video/')) {
    return `이 영상의 음성을 한국어로 전사하고, 화면에 표시되는 모든 텍스트도 함께 추출해 주세요.

규칙:
1. 음성 전사: 영상에서 들리는 모든 말을 누락 없이 전사하세요. 화자가 여러 명이면 "[화자 1]", "[화자 2]" 등으로 구분하세요.
2. 화면 텍스트: 슬라이드, 자막, 칠판, 화면 캡처 등에 표시되는 텍스트를 모두 추출하세요. 각 슬라이드/화면 전환 시 "=== 화면 N ===" 헤더를 넣으세요.
3. 음성 전사와 화면 텍스트를 시간 순서대로 통합하여 작성하세요.
4. 전사/추출 외에 다른 설명, 주석, 요약을 추가하지 마세요.
5. 들리지 않거나 읽을 수 없는 부분은 [불명확] 또는 [판독 불가]로 표시하세요.`;
  }

  // Default: document (pdf, pptx)
  return `이 문서의 모든 페이지 또는 슬라이드에 있는 텍스트를 순서대로 정확히 추출해 주세요.

규칙:
1. 각 페이지/슬라이드의 모든 텍스트(제목, 본문, 표, 목록, 이미지 속 한국어 텍스트 포함)를 누락 없이 추출하세요.
2. 표와 목록은 원본 구조를 최대한 유지하세요.
3. 각 페이지/슬라이드 시작 부분에 "=== 페이지 N ===" 헤더를 넣으세요.
4. 추출된 텍스트 외에는 다른 설명, 주석, 메타 정보를 추가하지 마세요.
5. 손상되거나 읽을 수 없는 부분은 [판독 불가]로 표시하세요.`;
}

async function extractText(fileUri, mimeType) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const prompt = buildPrompt(mimeType);

  const body = JSON.stringify({
    contents: [
      {
        role: 'user',
        parts: [
          { file_data: { mime_type: mimeType, file_uri: fileUri } },
          { text: prompt },
        ],
      },
    ],
    generationConfig: {
      maxOutputTokens: 60000,
      temperature: 0,
    },
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
      lastErr = `Gemini ${resp.status}: ${errText.slice(0, 200)}`;
      if (attempt < maxAttempts) {
        const waitMs = 15000 * attempt;
        console.warn(`[ocr]   ${lastErr.slice(0, 120)}`);
        console.warn(
          `[ocr]   attempt ${attempt}/${maxAttempts}, waiting ${waitMs / 1000}s...`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw new Error(`Gemini failed after ${maxAttempts} attempts: ${lastErr}`);
    }

    if (!resp.ok) {
      throw new Error(`Gemini API ${resp.status}: ${await resp.text()}`);
    }

    const data = await resp.json();
    const candidate = data?.candidates?.[0];
    if (!candidate) {
      throw new Error(`No candidates in response: ${JSON.stringify(data)}`);
    }

    const text = candidate?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error(
        `No text in candidate: ${JSON.stringify(candidate).slice(0, 500)}`,
      );
    }

    return { text, truncated: candidate.finishReason === 'MAX_TOKENS' };
  }

  throw new Error(`extractText: exhausted retries. Last error: ${lastErr}`);
}

// ---------- Process one source file ----------
async function ocrFile(filePath) {
  const basename = path.basename(filePath);
  const stem = path.basename(filePath, path.extname(filePath));
  const cachePath = path.join(EXTRACTED_DIR, `${stem}.txt`);

  if (!force && fs.existsSync(cachePath)) {
    const cachedSize = fs.statSync(cachePath).size;
    console.log(`[ocr] SKIP cached (${cachedSize}b): ${basename}`);
    return { status: 'skipped' };
  }

  console.log(`[ocr] Processing: ${basename}`);

  const ext = path.extname(filePath).toLowerCase();
  const mimeType = MIME_BY_EXT[ext];

  // .txt files: just copy the source text directly — no API needed.
  if (mimeType === null && ext === '.txt') {
    try {
      const text = fs.readFileSync(filePath, 'utf-8');
      fs.writeFileSync(cachePath, text, 'utf-8');
      console.log(`[ocr]   Copied ${text.length} chars (txt direct read)`);
      return { status: 'processed' };
    } catch (err) {
      console.error(`[ocr]   FAILED for ${basename}: ${err.message}`);
      return { status: 'failed', err };
    }
  }

  // .hwp files: parse locally via hwp.js — no API needed.
  if (mimeType === null && ext === '.hwp') {
    try {
      const text = extractHwpText(filePath);
      if (!text || text.trim().length < 50) {
        throw new Error(
          `Only ${text.length} chars extracted — HWP may be scanned/image-based ` +
            `or an older HWP format that hwp.js can't parse.`,
        );
      }
      fs.writeFileSync(cachePath, text, 'utf-8');
      console.log(`[ocr]   Extracted ${text.length} chars (hwp.js local parse)`);
      return { status: 'processed' };
    } catch (err) {
      console.error(`[ocr]   FAILED for ${basename}: ${err.message}`);
      return { status: 'failed', err };
    }
  }

  // .vtt files: strip timestamps and speaker tags — no API needed.
  if (mimeType === null && ext === '.vtt') {
    try {
      const text = extractVttText(filePath);
      if (!text || text.trim().length < 10) {
        throw new Error(
          `Only ${text.length} chars extracted — VTT file may be empty ` +
            `or malformed.`,
        );
      }
      fs.writeFileSync(cachePath, text, 'utf-8');
      console.log(`[ocr]   Extracted ${text.length} chars (VTT parse)`);
      return { status: 'processed' };
    } catch (err) {
      console.error(`[ocr]   FAILED for ${basename}: ${err.message}`);
      return { status: 'failed', err };
    }
  }

  if (!mimeType) {
    console.warn(`[ocr]   Unsupported extension ${ext}, skipping`);
    return { status: 'unsupported' };
  }

  // Audio/video files get a longer processing timeout (5 min vs 2 min).
  const isMedia = mimeType.startsWith('audio/') || mimeType.startsWith('video/');
  const pollIterations = isMedia ? 150 : 60;

  try {
    const file = await uploadFile(filePath, mimeType);
    await waitForActive(file.name, pollIterations);
    console.log(`[ocr]   Extracting text${isMedia ? ' (media — may take longer)' : ''}...`);
    const { text, truncated } = await extractText(file.uri, file.mimeType);

    if (truncated) {
      console.warn(
        `[ocr]   WARNING: ${basename} output truncated at max tokens. ` +
          `Consider splitting the file.`,
      );
    }

    fs.writeFileSync(cachePath, text, 'utf-8');
    console.log(`[ocr]   Saved ${text.length} chars to data/extracted/${stem}.txt`);
    return { status: 'processed' };
  } catch (err) {
    console.error(`[ocr]   FAILED for ${basename}: ${err.message}`);
    return { status: 'failed', err };
  }
}

// ---------- Pre-conversion: PPTX -> PDF via PowerPoint COM ----------
// Gemini rejects PPTX directly, and officeparser gives empty text
// for image-based slides. Running the user's PowerPoint via COM to
// save-as-PDF gives us a format both Gemini and pdf-parse handle.
// Skips conversions where the output PDF already exists.
async function preConvertPptxFiles() {
  // Skip if user is using single-file override mode on a non-pptx.
  if (SOURCE_FILE_OVERRIDE && path.extname(SOURCE_FILE_OVERRIDE).toLowerCase() !== '.pptx') {
    return;
  }
  if (!fs.existsSync(SOURCE_DIR)) return;

  const entries = fs.readdirSync(SOURCE_DIR);
  const pptxEntries = entries.filter(
    (n) => !n.startsWith('~$') && path.extname(n).toLowerCase() === '.pptx',
  );

  if (pptxEntries.length === 0) return;

  console.log(`[ocr] Found ${pptxEntries.length} .pptx file(s) — checking for PDF versions...`);
  for (const name of pptxEntries) {
    const stem = path.basename(name, path.extname(name));
    const pptxPath = path.join(SOURCE_DIR, name);
    const pdfPath = path.join(SOURCE_DIR, `${stem}.pdf`);

    if (fs.existsSync(pdfPath)) {
      console.log(`[ocr]   PDF exists, skipping convert: ${stem}.pdf`);
      continue;
    }

    console.log(`[ocr]   Converting ${name} -> ${stem}.pdf via PowerPoint...`);
    try {
      await convertPptxToPdf(pptxPath, pdfPath);
      console.log(`[ocr]   Converted: ${stem}.pdf`);
    } catch (err) {
      console.error(`[ocr]   Conversion FAILED: ${err.message}`);
      // Continue with other files — this pptx just won't be ingested.
    }
  }
  console.log('');
}

// ---------- Main ----------
async function main() {
  await preConvertPptxFiles();

  const sourceFiles = discoverSourceFiles();

  if (sourceFiles.length === 0) {
    die(
      'No source files found. Add .pdf, .pptx, .txt, .hwp, .vtt, .mp3, or .mp4 ' +
        'files to source-files/ or set SOURCE_FILE in .env.',
    );
  }

  fs.mkdirSync(EXTRACTED_DIR, { recursive: true });

  console.log(`[ocr] Found ${sourceFiles.length} source file(s)`);
  console.log(`[ocr] Model: ${GEMINI_MODEL}`);
  console.log(`[ocr] Force re-OCR: ${force}`);
  console.log('');

  const counts = { processed: 0, skipped: 0, failed: 0, unsupported: 0 };
  for (const filePath of sourceFiles) {
    const { status } = await ocrFile(filePath);
    counts[status] = (counts[status] || 0) + 1;
  }

  console.log('');
  console.log(
    `[ocr] Done: ${counts.processed} processed, ${counts.skipped} skipped (cached), ` +
      `${counts.failed} failed, ${counts.unsupported} unsupported`,
  );

  if (counts.processed > 0 || counts.skipped > 0) {
    console.log('[ocr] Next step: run "npm run ingest"');
  }

  if (counts.failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[ocr] FAILED:', err);
  process.exit(1);
});
