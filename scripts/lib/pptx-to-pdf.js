// scripts/lib/pptx-to-pdf.js
//
// Thin Node wrapper that shells out to pptx-to-pdf.ps1, which drives
// Microsoft PowerPoint via COM to save a .pptx as .pdf.
//
// Why this exists: Gemini Files API does not accept PPTX MIME types
// (returns 400 "Unsupported MIME type"). Converting to PDF first
// lets the existing PDF OCR pipeline handle image-based / scanned
// PPTX content that officeparser can't extract directly.
//
// Requirements:
//   - Windows
//   - Microsoft PowerPoint installed
//   - PowerShell (built-in on Windows)

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.join(__dirname, 'pptx-to-pdf.ps1');

export async function convertPptxToPdf(pptxPath, pdfPath) {
  const absInput = path.resolve(pptxPath);
  const absOutput = path.resolve(pdfPath);

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-ExecutionPolicy', 'Bypass',
        '-NoProfile',
        '-NonInteractive',
        '-File', SCRIPT_PATH,
        '-InputPath', absInput,
        '-OutputPath', absOutput,
      ],
      {
        timeout: 5 * 60 * 1000, // 5 minutes
        windowsHide: true,
      },
    );
    return stdout.trim();
  } catch (err) {
    const stdout = (err.stdout || '').toString().trim();
    const stderr = (err.stderr || '').toString().trim();
    const exitCode = err.code;
    const msg = [stdout, stderr].filter(Boolean).join(' | ') || err.message;

    if (exitCode === 3) {
      throw new Error(
        'PowerPoint is not installed (or COM is unavailable). ' +
          'Install Microsoft PowerPoint, OR manually save the PPTX as PDF ' +
          'in PowerPoint (File > Save As > PDF) and drop the PDF into source-files/.',
      );
    }
    if (exitCode === 2) {
      throw new Error(`Input PPTX not found: ${absInput}`);
    }
    throw new Error(
      `PPTX → PDF conversion failed (exit ${exitCode}): ${msg}`,
    );
  }
}
