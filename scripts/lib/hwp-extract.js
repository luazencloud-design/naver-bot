// scripts/lib/hwp-extract.js
//
// Pure-local text extraction for HWP 5.x files using hwp.js.
// Walks HWPDocument -> Section.content -> Paragraph.content -> HWPChar
// and collects chars whose type is Char (= 0). Inline (1) and Extended
// (2) char types are control/structural markers with no displayable
// text, so they're skipped.
//
// Note: hwp.js parses HWP 5.x. Older HWP formats (2.x, 3.x) are not
// supported by the library and will throw. Image-based / scanned HWP
// files won't produce useful text either — only the embedded text
// layer is extracted, images are ignored.

import fs from 'node:fs';
import hwp from 'hwp.js';

const { parse } = hwp;

// hwp.js CharType enum:
//   Char     = 0  -> regular character (what we want)
//   Inline   = 1  -> inline control (skip)
//   Extened  = 2  -> extended control (skip)  (sic: typo is in hwp.js itself)
const CHAR_TYPE_TEXT = 0;

export function extractHwpText(filePath) {
  const buffer = fs.readFileSync(filePath);
  const doc = parse(buffer);

  const paragraphs = [];
  for (const section of doc.sections) {
    for (const paragraph of section.content) {
      const chars = [];
      for (const ch of paragraph.content) {
        if (ch.type !== CHAR_TYPE_TEXT) continue;
        if (typeof ch.value === 'string') {
          chars.push(ch.value);
        } else if (typeof ch.value === 'number') {
          // HWPChar.value can be a Unicode code point number.
          chars.push(String.fromCharCode(ch.value));
        }
      }
      const line = chars.join('').trim();
      if (line) paragraphs.push(line);
    }
  }

  return paragraphs.join('\n');
}
