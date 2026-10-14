import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { decodePng } from './png.js';

// The school logo for PDFs (receipts, report cards), read once.
// Replace server/assets/logo-pdf.png to change it; PDFs still work without it.
let logo;

export function pdfLogo() {
  if (logo === undefined) {
    try {
      logo = decodePng(fs.readFileSync(path.join(ROOT, 'server', 'assets', 'logo-pdf.png')));
    } catch (err) {
      console.error('[logo] could not read server/assets/logo-pdf.png:', err.message);
      logo = null;
    }
  }
  return logo;
}
