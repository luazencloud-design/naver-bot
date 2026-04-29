// scripts/lib/vtt-extract.js
//
// Extracts speech-only text from a WebVTT subtitle / transcript file
// (common output format for Zoom recordings, YouTube captions, etc).
//
// Strips:
//   - "WEBVTT" header
//   - blank lines
//   - cue numbers (lines that are only digits)
//   - timestamp lines (contain "-->")
//   - NOTE / STYLE / REGION blocks
//   - Speaker prefix at the start of a cue text line, e.g. "정용렬:" or
//     "Speaker 1:". Detected by a short (<=25 char) leading token
//     followed by a colon.
//
// Keeps the actual spoken content, one cue per line.
//
// Example input:
//   WEBVTT
//
//   1
//   00:10:26.280 --> 00:10:27.710
//   정용렬:하..나 어떻가냐 1건이 아니라 3건이나 접수되서...
//
//   2
//   00:10:27.910 --> 00:10:28.300
//   정용렬:존나 억울하네..내가 사기 친것도 아닌데...
//
// Example output:
//   하..나 어떻가냐 1건이 아니라 3건이나 접수되서...
//   존나 억울하네..내가 사기 친것도 아닌데...

import fs from 'node:fs';

// Speaker-prefix detector. Matches a short leading token (Korean,
// Latin, digits, spaces, underscore, hyphen) followed by ":" and
// optional whitespace at the very start of a line. 25-char cap stops
// it from accidentally eating real content that happens to contain
// an early colon.
const SPEAKER_PREFIX_RE = /^[가-힣A-Za-z][가-힣A-Za-z0-9\s_-]{0,24}:\s?/;

export function extractVttText(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const parts = [];

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    // Header
    if (trimmed === 'WEBVTT' || trimmed.startsWith('WEBVTT ')) continue;

    // Cue number (pure digits)
    if (/^\d+$/.test(trimmed)) continue;

    // Timestamp line (e.g. "00:10:26.280 --> 00:10:27.710")
    if (trimmed.includes('-->')) continue;

    // WebVTT block markers that aren't speech
    if (trimmed === 'NOTE' || trimmed.startsWith('NOTE ')) continue;
    if (trimmed === 'STYLE' || trimmed.startsWith('STYLE ')) continue;
    if (trimmed === 'REGION' || trimmed.startsWith('REGION ')) continue;

    // Cue text — strip speaker prefix if present.
    const text = trimmed.replace(SPEAKER_PREFIX_RE, '').trim();
    if (text) parts.push(text);
  }

  return parts.join('\n');
}
