import { zip } from '../../lib/zip.js';

// Writes a real Excel workbook (.xlsx) with one sheet: bold header row, frozen
// header, filters on every column, rupee amounts as numbers and dates as dates.

const xml = (text) =>
  String(text)
    // Characters XML cannot hold at all.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function columnName(index) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

// Excel stores dates as days since 30 Dec 1899.
const excelDate = (isoDate) => Date.UTC(...isoDate.split('-').map((v, i) => Number(v) - (i === 1 ? 1 : 0))) / 86_400_000 + 25_569;

const STYLE = { text: 0, header: 1, money: 2, date: 3, number: 0, totalLabel: 4, totalMoney: 5 };

function cellXml(ref, value, column, { total = false } = {}) {
  if (value === null || value === undefined || value === '') return '';
  if (column.type === 'money' || column.type === 'number') {
    const n = Number(value);
    if (Number.isFinite(n)) return `<c r="${ref}" s="${total ? STYLE.totalMoney : column.type === 'money' ? STYLE.money : STYLE.number}"><v>${n}</v></c>`;
  }
  if (column.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `<c r="${ref}" s="${STYLE.date}"><v>${excelDate(value)}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr" s="${total ? STYLE.totalLabel : STYLE.text}"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

export function toXlsx({ sheetName = 'Sheet1', columns, rows, totals = null }) {
  const safeSheet = String(sheetName).replace(/[\[\]:*?/\\]/g, ' ').slice(0, 31) || 'Sheet1';
  const lastCol = columnName(columns.length - 1);
  const header = `<row r="1">${columns.map((c, i) => `<c r="${columnName(i)}1" t="inlineStr" s="${STYLE.header}"><is><t>${xml(c.header)}</t></is></c>`).join('')}</row>`;
  const body = rows
    .map((row, r) => `<row r="${r + 2}">${columns.map((c, i) => cellXml(`${columnName(i)}${r + 2}`, row[c.key], c)).join('')}</row>`)
    .join('');
  const totalRowIndex = rows.length + 2;
  const totalRow = totals
    ? `<row r="${totalRowIndex}">${columns.map((c, i) => cellXml(`${columnName(i)}${totalRowIndex}`, totals[c.key], c, { total: true })).join('')}</row>`
    : '';
  const lastDataRow = Math.max(1, rows.length + 1);

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 16}" customWidth="1"/>`).join('')}</cols>
<sheetData>${header}${body}${totalRow}</sheetData>
<autoFilter ref="A1:${lastCol}${lastDataRow}"/>
</worksheet>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${xml(safeSheet)}" sheetId="1" r:id="rId1"/></sheets>
<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${xml(safeSheet.replace(/'/g, "''"))}'!$A$1:$${lastCol}$${lastDataRow}</definedName></definedNames>
</workbook>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;₹&quot;#,##0"/><numFmt numFmtId="165" formatCode="[$-409]dd-mmm-yyyy"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDCEBE8"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  return zip([
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    },
    { name: 'xl/workbook.xml', data: workbook },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
    { name: 'xl/styles.xml', data: styles },
  ]);
}
