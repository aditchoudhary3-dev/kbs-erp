import { toCsv } from './csv.js';
import { toXlsx } from './xlsx.js';

// Export formats. A table is { title, sheetName, columns: [{ key, header, type, width }], rows, totals? }
// where type is 'text' (default), 'money', 'number' or 'date' (YYYY-MM-DD).
// Add a format (e.g. Google Sheets upload) by adding an entry here.
export const FORMATS = {
  xlsx: {
    extension: 'xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    write: (table) => toXlsx(table),
  },
  csv: {
    extension: 'csv',
    contentType: 'text/csv; charset=utf-8',
    write: (table) => toCsv({ columns: table.columns, rows: table.totals ? [...table.rows, table.totals] : table.rows }),
  },
};

export function exportTable(format, table) {
  const writer = FORMATS[format];
  if (!writer) throw new Error(`Unknown export format "${format}"`);
  return { buffer: writer.write(table), contentType: writer.contentType, extension: writer.extension };
}
