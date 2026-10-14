import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { exportTable } from '../integrations/export/index.js';
import { REGISTER_COLUMNS, registerRows } from './payment-history.js';

// Keeps an always-current copy of the fee register on disk, as Excel and CSV,
// rewritten shortly after every confirmed payment. Files are written to a
// temporary name and then renamed, so a reader never sees a half-written file.
// (If the file is open in Excel on Windows, the rename waits for the next payment.)

let dir = null;
let timer = null;

export function configureRegisterSync(dbFile) {
  dir = config.exports.registerSync && dbFile !== ':memory:' ? config.exports.dir || path.join(path.dirname(dbFile), 'exports') : null;
  return dir;
}

export function scheduleRegisterSync() {
  if (!dir) return;
  clearTimeout(timer);
  timer = setTimeout(() => writeRegister().catch((err) => console.error('[exports] fee register not updated:', err.message)), 1500);
  timer.unref();
}

export async function writeRegister() {
  if (!dir) return null;
  await fs.mkdir(dir, { recursive: true });
  const table = {
    sheetName: `Fee register ${config.academicYear.label}`,
    columns: REGISTER_COLUMNS,
    rows: registerRows({ status: 'PAID', from: `${config.academicYear.start}-01` }),
  };
  const base = path.join(dir, `KBS-fee-register-${config.academicYear.label.replace('–', '-')}`);
  for (const format of ['xlsx', 'csv']) {
    const file = exportTable(format, table);
    const target = `${base}.${file.extension}`;
    await fs.writeFile(`${target}.tmp`, file.buffer);
    await fs.rename(`${target}.tmp`, target);
  }
  return base;
}
