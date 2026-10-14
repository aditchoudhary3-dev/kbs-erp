// CSV that Excel opens correctly: UTF-8 with a byte-order mark (so ₹ and
// Hindi names survive), CRLF line endings, and every field quoted when needed.

// Cells starting with these could run as formulas when opened in Excel.
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value, column) {
  if (value === null || value === undefined) return '';
  if (column.type === 'money' || column.type === 'number') return String(value);
  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv({ columns, rows }) {
  const lines = [columns.map((c) => cell(c.header, {})).join(',')];
  for (const row of rows) lines.push(columns.map((c) => cell(row[c.key], c)).join(','));
  return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
}
