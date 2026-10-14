import { db } from '../db.js';
import { config } from '../config.js';
import { HttpError, escapeHtml as e } from '../http.js';
import { Pdf } from '../pdf.js';
import { pdfLogo } from '../lib/logo.js';
import { amountInWords, formatDate, formatTime, rupees } from '../../shared/format.js';

// A receipt is frozen when the payment is confirmed: it keeps the student's
// details as they were that day, even if the student record changes later.
export function buildReceiptSnapshot({ student, items, amount, method, txnId, receiptNo, paidAt, collectedBy, gatewayOrderId, amountReceived = null, replacesReceiptNo = null }) {
  return {
    version: 1,
    school: {
      name: config.school.name,
      shortName: config.school.shortName,
      monogram: config.school.monogram,
      address: config.school.address,
      shortAddress: config.school.shortAddress,
      pin: config.school.pin,
    },
    receiptNo,
    paidAt,
    student: {
      id: student.id,
      code: student.code,
      name: student.name,
      admissionNo: student.admissionNo,
      rollNo: student.rollNo,
      grade: student.grade,
      section: student.section,
      className: student.className,
      classLabel: student.classLabel,
      fatherName: student.fatherName,
      motherName: student.motherName,
      parentNames: student.parentNames,
    },
    items: items.map((i) => ({ feeType: i.fee_type ?? i.feeType, title: i.title, amount: i.amount })),
    total: amount,
    method,
    txnId,
    gatewayOrderId: gatewayOrderId ?? null,
    collectedBy,
    amountReceived,
    replacesReceiptNo,
    status: 'PAID',
  };
}

export function receiptData(paymentId) {
  const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!row) throw new HttpError(404, 'Receipt not found.');
  const snapshot = JSON.parse(row.receipt_snapshot);
  return {
    ...snapshot,
    school: { ...config.school, ...snapshot.school },
    student: { code: `STU${String(row.student_id).padStart(5, '0')}`, ...snapshot.student },
    paymentId: row.id,
    studentId: row.student_id,
    token: row.receipt_token,
    status: row.status === 'confirmed' ? 'PAID' : 'CANCELLED',
    statusLabel: row.status === 'confirmed' ? 'PAID' : 'CANCELLED',
    reversedAt: row.reversed_at,
    reversalReason: row.reversal_reason,
    online: row.recorded_by === 'parent',
    reviewNote: row.review_note,
  };
}

export function paymentIdForToken(token) {
  const row = db.prepare('SELECT id FROM payments WHERE receipt_token = ?').get(String(token));
  if (!row) throw new HttpError(404, 'Receipt not found.');
  return row.id;
}

// A link parents can open without logging in (only when the server is public).
export const publicReceiptUrl = (data) => (config.publicBaseUrl && data.token ? `${config.publicBaseUrl}/r/${data.token}` : null);

// ---- The two copies ----------------------------------------------------------------
//
// Every payment has a SCHOOL COPY (kept in the school's records, with space
// for signatures) and a PARENT COPY (handed over, downloaded or sent on
// WhatsApp). Both are made from the same frozen snapshot, so they always
// carry the same receipt number, student, fees, amounts and payment details.

export const COPIES = {
  school: {
    key: 'school',
    name: 'School Copy',
    label: 'SCHOOL COPY',
    footer: 'School Copy – For School Record',
    note: null,
    signatures: ['Clerk Signature', 'Authorized Signature'],
    file: 'School-Copy',
  },
  parent: {
    key: 'parent',
    name: 'Parent Copy',
    label: 'PARENT COPY',
    footer: 'PARENT COPY',
    note: 'Please keep this receipt for your records.',
    signatures: ['Authorized Signature'],
    file: 'Parent-Copy',
  },
};

// 'school', 'parent' or 'both' (both copies on one A4 page: school copy on top).
export function parseCopy(value, fallback = 'parent') {
  const copy = String(value ?? '').toLowerCase();
  return copy === 'school' || copy === 'parent' || copy === 'both' ? copy : fallback;
}
const copyKeys = (copy) => (copy === 'both' ? ['school', 'parent'] : [copy]);
export const copyLabel = (copy) => (copy === 'both' ? 'School Copy and Parent Copy (one page)' : COPIES[copy].name);

export const receiptFilename = (data, copy = 'parent') =>
  `Receipt-${data.receiptNo.replace(/[^\w-]+/g, '-')}-${copy === 'both' ? 'School-and-Parent-Copies' : COPIES[copy].file}.pdf`;

const addressLines = (school) => school.addressLines ?? [school.address];

// ---- Fee heads --------------------------------------------------------------------------
//
// Every receipt prints the same fee heads in the same order. Each fee paid is
// added to its head (by fee type); any other kind of fee goes under Other Fee.
// A fixed table also keeps every copy to exactly one A4 page.

export const FEE_HEADS = [
  { head: 'Tuition Fee', match: /tuition/i },
  { head: 'Admission Fee', match: /admission/i },
  { head: 'Annual Charges', match: /annual/i },
  { head: 'Transport Fee', match: /transport|bus/i },
  { head: 'Examination Fee', match: /exam/i },
  { head: 'Other Fee', match: null },
];

// "Tuition · Term 1" under Tuition Fee reads "Term 1"; other fees keep their name.
function partLabel(item, head) {
  const title = String(item.title ?? item.feeType ?? '');
  if (head === 'Other Fee') return title;
  const short = title.includes(' · ') ? title.split(' · ').slice(1).join(' · ') : title;
  return short.toLowerCase() === head.toLowerCase() ? '' : short;
}

export function feeHeads(items) {
  const rows = FEE_HEADS.map((h) => ({ head: h.head, amount: 0, parts: [] }));
  for (const item of items) {
    const index = FEE_HEADS.findIndex((h) => h.match?.test(String(item.feeType ?? item.title ?? '')));
    const row = rows[index === -1 ? rows.length - 1 : index];
    row.amount += item.amount;
    row.parts.push(item);
  }
  return rows.map((row) => {
    const labels = row.parts.map((p) => ({ label: partLabel(p, row.head), amount: p.amount }));
    const detail =
      labels.length > 1
        ? labels.map((l) => `${l.label || row.head} (${rupees(l.amount)})`).join(', ')
        : labels[0]?.label ?? '';
    return { head: row.head, amount: row.amount, detail, paid: row.parts.length > 0 };
  });
}

// Cash handed over, when change was given back.
function extraLines(r) {
  if (!(r.amountReceived && r.amountReceived > r.total)) return [];
  return [['Cash Received / Change', `${rupees(r.amountReceived)} / ${rupees(r.amountReceived - r.total)}`]];
}

// The payment fields, in the order each copy lists them.
function paymentFields(r, key) {
  const status = r.statusLabel;
  const mode = ['Payment Mode', r.method];
  const reference = ['Transaction ID / Payment Reference', r.txnId || '—', { wide: true }];
  const collected = ['Collected By', r.collectedBy];
  const paymentStatus = ['Payment Status', status, { status: true }];
  const order = key === 'school' ? [mode, reference, collected, paymentStatus] : [mode, reference, paymentStatus, collected];
  return [...order, ...extraLines(r), ...(r.gatewayOrderId ? [['Gateway Order ID', r.gatewayOrderId]] : [])];
}

// On a half page the four payment details share one row; cash received and
// change (or an online order ID) go on the amount-in-words line instead.
function halfPayment(r, key) {
  const fields = paymentFields(r, key);
  return { fields: fields.slice(0, 4), extras: fields.slice(4) };
}

// One note at most (cancelled, and/or replacing an earlier receipt), so the
// copy always fits on its page.
function statusNote(r) {
  const replaces = r.replacesReceiptNo ? `This receipt replaces receipt ${r.replacesReceiptNo}.` : '';
  if (r.status === 'CANCELLED') return `This receipt was cancelled on ${formatDate(r.reversedAt)}.${replaces ? ` It had replaced receipt ${r.replacesReceiptNo}.` : ''} Reason: ${r.reversalReason ?? ''}`;
  return replaces;
}

// ---- Printable page: one A4 page per copy --------------------------------------------

const field = (label, value, { span = 1, strong = false } = {}) =>
  `<div class="f${span > 1 ? ` span-${span}` : ''}"><dt>${e(label)}</dt><dd>${strong ? `<strong>${value}</strong>` : value}</dd></div>`;
const signature = (label) => `<div class="sign"><span>${e(label)}:</span><span class="sign-line" aria-hidden="true"></span></div>`;
const letterhead = (r, logoSize) => `<header class="head-block">
    <img class="logo" src="/logo.png" alt="${e(r.school.name)} logo" width="${logoSize}" height="${logoSize}">
    <div class="school">
      <h1>${e(r.school.name.toUpperCase())}</h1>
      ${addressLines(r.school).map((line) => `<p>${e(line)}</p>`).join('')}
      <p>PIN – ${e(r.school.pin)}</p>
    </div>
  </header>`;
const titleBand = (copy) => `<div class="title-band">
    <h2>FEE RECEIPT</h2>
    <span class="copy-label">${e(copy.label)}</span>
  </div>`;
const noteHtml = (r) => (statusNote(r) ? `<p class="${r.status === 'CANCELLED' ? 'cancel-note' : 'replace-note'}">${e(statusNote(r))}</p>` : '');
const paymentHtml = (r, key, { half = false } = {}) =>
  (half ? halfPayment(r, key).fields : paymentFields(r, key))
    .map(([label, value, opts = {}]) =>
      field(label, opts.status ? `<span class="${r.status === 'CANCELLED' ? 'cancelled' : 'paid'}">${e(value)}</span>` : e(value), { span: opts.wide ? 2 : 1, strong: !opts.status }),
    )
    .join('');

function sheetHtml(r, key) {
  const copy = COPIES[key];
  const cancelled = r.status === 'CANCELLED';
  const heads = feeHeads(r.items)
    .map(
      (h) =>
        `<tr${h.paid ? '' : ' class="unpaid"'}><td><div class="head-cell"><span class="head">${e(h.head)}</span>${h.detail ? `<span class="detail" title="${e(h.detail)}">${e(h.detail)}</span>` : ''}</div></td><td class="num">${h.paid ? e(rupees(h.amount)) : '—'}</td></tr>`,
    )
    .join('');
  const payment = paymentHtml(r, key);

  return `<div class="paper">
<main class="sheet sheet--${key}${cancelled ? ' is-cancelled' : ''}" aria-label="${e(copy.name)}">
  ${cancelled ? `<div class="watermark" aria-hidden="true">CANCELLED</div>` : ''}
  ${letterhead(r, 84)}

  ${titleBand(copy)}

  ${noteHtml(r)}

  <dl class="fields">
    ${field('Receipt Number', e(r.receiptNo), { strong: true })}
    ${field('Date', e(formatDate(r.paidAt)), { strong: true })}
    ${field('Time', e(formatTime(r.paidAt)), { strong: true })}
    ${field('Student Name', e(r.student.name), { span: 2, strong: true })}
    ${field('Student ID', e(r.student.code), { strong: true })}
    ${field('Admission Number', e(r.student.admissionNo), { strong: true })}
    ${field('Class', e(r.student.grade), { strong: true })}
    ${field('Section', e(r.student.section), { strong: true })}
    ${field('Father/Mother Name', e(r.student.parentNames || '—'), { span: 3, strong: true })}
  </dl>

  <table class="heads">
    <caption>Fee Details</caption>
    <thead><tr><th scope="col">Fee Head</th><th scope="col" class="num">Amount</th></tr></thead>
    <tbody>${heads}</tbody>
    <tfoot><tr><th scope="row">Total Amount Paid</th><td class="num">${e(rupees(r.total))}</td></tr></tfoot>
  </table>
  <p class="words"><span>Amount in words:</span> ${e(amountInWords(r.total))}</p>

  <dl class="fields fields--payment">${payment}</dl>

  <footer class="foot">
    <div class="foot-mark foot-mark--${key}">
      <strong>${e(copy.footer)}</strong>${copy.note ? `<span>${e(copy.note)}</span>` : ''}
    </div>
    <div class="signs">
      ${key === 'parent' ? `<div class="stamp${cancelled ? ' stamp--cancelled' : ''}" aria-hidden="true">${cancelled ? 'CANCELLED' : 'PAID'}</div>` : ''}
      ${copy.signatures.map(signature).join('')}
    </div>
  </footer>
</main>
</div>`;
}

// ---- Both copies on one A4 page --------------------------------------------------------
//
// School Copy on the top half, Parent Copy on the bottom half, with a cut
// line between them. Same details as the full-page copies, laid out compactly:
// the six fee heads sit in two columns.

function halfSheetHtml(r, key) {
  const copy = COPIES[key];
  const cancelled = r.status === 'CANCELLED';
  const heads = feeHeads(r.items);
  const cell = (h) =>
    `<td class="${h.paid ? '' : 'unpaid'}"><div class="head-cell"><span class="head">${e(h.head)}</span>${h.detail ? `<span class="detail" title="${e(h.detail)}">${e(h.detail)}</span>` : ''}</div></td><td class="num${h.paid ? '' : ' unpaid'}">${h.paid ? e(rupees(h.amount)) : '—'}</td>`;
  const rows = [0, 2, 4].map((i) => `<tr>${cell(heads[i])}${cell(heads[i + 1])}</tr>`).join('');
  return `<main class="sheet sheet--half sheet--${key}${cancelled ? ' is-cancelled' : ''}" aria-label="${e(copy.name)}">
  ${cancelled ? `<div class="watermark" aria-hidden="true">CANCELLED</div>` : ''}
  ${letterhead(r, 52)}
  ${titleBand(copy)}
  ${noteHtml(r)}
  <dl class="fields">
    ${field('Receipt Number', e(r.receiptNo), { span: 2, strong: true })}
    ${field('Date', e(formatDate(r.paidAt)), { strong: true })}
    ${field('Time', e(formatTime(r.paidAt)), { strong: true })}
    ${field('Student ID', e(r.student.code), { strong: true })}
    ${field('Admission Number', e(r.student.admissionNo), { strong: true })}
    ${field('Student Name', e(r.student.name), { span: 2, strong: true })}
    ${field('Father/Mother Name', e(r.student.parentNames || '—'), { span: 2, strong: true })}
    ${field('Class', e(r.student.grade), { strong: true })}
    ${field('Section', e(r.student.section), { strong: true })}
  </dl>
  <table class="heads heads--pairs">
    <caption>Fee Details</caption>
    <thead><tr><th scope="col">Fee Head</th><th scope="col" class="num">Amount</th><th scope="col">Fee Head</th><th scope="col" class="num">Amount</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><th scope="row" colspan="3">Total Amount Paid</th><td class="num">${e(rupees(r.total))}</td></tr></tfoot>
  </table>
  <div class="words-row">
    <p class="words"><span>Amount in words:</span> ${e(amountInWords(r.total))}</p>
    ${halfPayment(r, key).extras.map(([label, value]) => `<p class="extra"><span>${e(label)}:</span> <strong>${e(value)}</strong></p>`).join('')}
  </div>
  <dl class="fields fields--payment">${paymentHtml(r, key, { half: true })}</dl>
  <footer class="foot foot--half">
    <div class="foot-mark foot-mark--${key}"><strong>${e(copy.footer)}</strong>${copy.note ? `<span>${e(copy.note)}</span>` : ''}</div>
    <div class="signs">${copy.signatures.map(signature).join('')}</div>
  </footer>
</main>`;
}

const bothOnOnePage = (r) => `<div class="paper paper--duo">
${halfSheetHtml(r, 'school')}
<div class="cut-line" aria-hidden="true"><span>✂ Cut here · School Copy above, Parent Copy below</span></div>
${halfSheetHtml(r, 'parent')}
</div>`;

// copy: 'school' | 'parent' (one full A4 page each) or 'both' (both copies on
// one A4 page). `links` adds the staff toolbar; parents get just their copy.
export function receiptHtml(r, { copy = 'parent', pdfUrl, links = null }) {
  const keys = copyKeys(copy);
  const tab = (key, label) =>
    `<a class="tb-tab" href="${e(links[key])}"${key === copy ? ' aria-current="page"' : ''}>${e(label)}</a>`;
  const pdfLinks = `<a class="tb-button" href="${e(pdfUrl)}" download>Download PDF</a>`;
  const printLabel = { school: 'Print school copy', parent: 'Print parent copy', both: 'Print both copies' }[copy];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fee receipt ${e(r.receiptNo)} · ${e(copyLabel(copy))} · ${e(r.school.shortName)}</title>
<link rel="icon" href="/logo-64.png" type="image/png">
<link rel="stylesheet" href="/css/receipt.css">
</head>
<body>
<div class="toolbar" role="toolbar" aria-label="Receipt actions">
  <span class="toolbar-title">Receipt ${e(r.receiptNo)}</span>
  ${links ? `<nav class="tb-tabs" aria-label="Copy">${tab('school', 'School copy')}${tab('parent', 'Parent copy')}${tab('both', 'Both on one page')}</nav>` : `<span class="tb-copy">${e(copyLabel(copy))}</span>`}
  ${pdfLinks}
  <button type="button" class="tb-button tb-primary" data-print>${e(printLabel)}</button>
</div>
${copy === 'both' ? bothOnOnePage(r) : keys.map((key) => sheetHtml(r, key)).join('\n')}
<script src="/js/receipt-page.js"></script>
</body>
</html>`;
}

// ---- PDF (downloads and WhatsApp attachments): true A4, one page per copy -------------

// School colours, from the logo.
const C = {
  ink: '#13203F',
  ink2: '#37425E',
  muted: '#5B6680',
  primary: '#0B3F91',
  navy: '#0A2A5E',
  gold: '#D4A537',
  goldBright: '#F2B632',
  goldSoft: '#FDF3D6',
  goldText: '#FFD66B',
  border: '#D5DCEA',
  rule: '#E3E8F2',
  bg: '#F4F6FB',
  ok: '#2F7D4F',
  danger: '#B42318',
};

const MM = 72 / 25.4; // points per millimetre

// Shortens text to fit a width, ending with "…".
function fit(pdf, text, width, size, bold = false) {
  let out = String(text);
  if (pdf.measure(out, size, bold) <= width) return out;
  while (out.length > 1 && pdf.measure(`${out}…`, size, bold) > width) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

function drawCopy(pdf, r, key) {
  const copy = COPIES[key];
  const cancelled = r.status === 'CANCELLED';
  // The receipt fills the A4 page inside a 10 mm margin.
  const X0 = 10 * MM;
  const Y0 = 10 * MM;
  const W0 = pdf.width - 20 * MM;
  const H0 = pdf.height - 20 * MM;
  const L = X0 + 22;
  const R = X0 + W0 - 22;
  const W = R - L;
  const bottom = Y0 + H0 - 20;

  pdf.strokeRect(X0, Y0, W0, H0, { color: C.primary, width: 1.5 });

  // Letterhead
  const logo = pdfLogo();
  if (logo) pdf.image(logo, L, Y0 + 18, 70, 70);
  else pdf.rect(L, Y0 + 22, 62, 62, { fill: C.primary });
  const tx = L + 84;
  pdf.text(r.school.name.toUpperCase(), tx, Y0 + 38, { size: 15.5, bold: true, color: C.primary });
  let y = Y0 + 56;
  for (const line of addressLines(r.school)) {
    pdf.text(line, tx, y, { size: 10.5, color: C.ink2 });
    y += 14;
  }
  pdf.text(`PIN – ${r.school.pin}`, tx, y, { size: 10.5, color: C.ink2 });

  // FEE RECEIPT with the large copy label
  const bandY = Y0 + 104;
  pdf.rect(L, bandY, W, 40, { fill: C.navy });
  pdf.rect(L, bandY + 40, W, 3, { fill: C.gold });
  pdf.text('FEE RECEIPT', L + 16, bandY + 27, { size: 17, bold: true, color: '#FFFFFF' });
  const labelW = 170;
  pdf.rect(R - labelW - 8, bandY + 6, labelW, 28, { fill: key === 'school' ? C.goldBright : '#FFFFFF' });
  pdf.text(copy.label, R - 8 - labelW / 2, bandY + 26, { size: 16, bold: true, color: C.navy, align: 'center' });

  y = bandY + 58;
  const note = statusNote(r);
  if (note) {
    pdf.text(fit(pdf, note, W, 10, true), L, y + 4, { size: 10, bold: true, color: cancelled ? C.danger : C.primary });
    y += 20;
  }

  // Fields in a three-column grid. [label, value, columns spanned]
  const grid = (cells, top, rowH = 33) => {
    const col = W / 3;
    let c = 0;
    let row = top;
    for (const [label, value, span = 1] of cells) {
      if (c + span > 3) {
        c = 0;
        row += rowH;
      }
      const x = L + c * col;
      const width = col * span - 14;
      pdf.text(label, x, row + 9, { size: 8.5, color: C.muted });
      pdf.text(fit(pdf, String(value ?? '—'), width, 11.5, true), x, row + 24, { size: 11.5, bold: true });
      pdf.line(x, row + 29, x + width, row + 29, { color: C.rule });
      c += span;
      if (c >= 3) {
        c = 0;
        row += rowH;
      }
    }
    return c === 0 ? row : row + rowH;
  };
  y = grid(
    [
      ['Receipt Number', r.receiptNo],
      ['Date', formatDate(r.paidAt)],
      ['Time', formatTime(r.paidAt)],
      ['Student Name', r.student.name, 2],
      ['Student ID', r.student.code],
      ['Admission Number', r.student.admissionNo],
      ['Class', r.student.grade],
      ['Section', r.student.section],
      ['Father/Mother Name', r.student.parentNames || '—', 3],
    ],
    y,
  );

  // Fee Head | Amount: one line per head, with what was paid under it.
  const rowH = 26;
  y += 6;
  pdf.text('FEE DETAILS', L, y + 9, { size: 9.5, bold: true, color: C.primary });
  y += 15;
  pdf.rect(L, y, W, 22, { fill: C.bg });
  pdf.strokeRect(L, y, W, 22 + FEE_HEADS.length * rowH + 28, { color: C.border, width: 0.8 });
  pdf.text('FEE HEAD', L + 12, y + 15, { size: 8.5, bold: true, color: C.muted });
  pdf.text('AMOUNT', R - 12, y + 15, { size: 8.5, bold: true, color: C.muted, align: 'right' });
  y += 22;
  for (const h of feeHeads(r.items)) {
    pdf.line(L, y, R, y, { color: C.border, width: 0.8 });
    pdf.text(h.head, L + 12, y + 17, { size: 11.5, bold: h.paid, color: h.paid ? C.ink : C.muted });
    if (h.detail) {
      const dx = L + 12 + pdf.measure(h.head, 11.5, h.paid) + 10;
      pdf.text(fit(pdf, h.detail, R - 110 - dx, 9), dx, y + 17, { size: 9, color: C.muted });
    }
    pdf.text(h.paid ? rupees(h.amount) : '—', R - 12, y + 17, { size: 11.5, bold: h.paid, color: h.paid ? C.ink : C.muted, align: 'right' });
    y += rowH;
  }
  pdf.rect(L + 0.4, y, W - 0.8, 28, { fill: C.goldSoft });
  pdf.line(L, y, R, y, { color: C.gold, width: 1.2 });
  pdf.text('Total Amount Paid', L + 12, y + 19, { size: 12.5, bold: true });
  pdf.text(rupees(r.total), R - 12, y + 19, { size: 13.5, bold: true, align: 'right' });
  y += 44;
  pdf.text('Amount in words:', L, y, { size: 9.5, color: C.muted });
  pdf.text(fit(pdf, amountInWords(r.total), W - 86, 10.5, true), L + 82, y, { size: 10.5, bold: true });
  y += 12;

  // Payment details
  y = grid(paymentFields(r, key).map(([label, value, opts = {}]) => [label, value, opts.wide ? 2 : 1]), y);

  // Footer, at the bottom of the page
  const footY = bottom - 92;
  if (key === 'school') {
    pdf.rect(L, footY, W, 30, { fill: C.navy });
    pdf.text(copy.footer, L + W / 2, footY + 20, { size: 13, bold: true, color: '#FFFFFF', align: 'center' });
  } else {
    pdf.rect(L, footY, W, 40, { fill: C.goldSoft });
    pdf.strokeRect(L, footY, W, 40, { color: C.gold, width: 1 });
    pdf.text(copy.footer, L + W / 2, footY + 17, { size: 13, bold: true, color: C.navy, align: 'center' });
    pdf.text(copy.note, L + W / 2, footY + 32, { size: 10, color: C.ink2, align: 'center' });
  }
  const signY = bottom - 14;
  if (key === 'school') {
    const half = W / 2;
    copy.signatures.forEach((label, i) => {
      const x = L + i * half;
      const text = `${label}:`;
      pdf.text(text, x, signY, { size: 10.5, color: C.ink2 });
      pdf.line(x + pdf.measure(text, 10.5) + 6, signY + 2, x + half - 18, signY + 2, { color: C.ink2, width: 0.8 });
    });
  } else {
    const stampColor = cancelled ? C.danger : C.ok;
    const stampW = cancelled ? 130 : 84;
    pdf.strokeRect(L, signY - 26, stampW, 32, { color: stampColor, width: 2 });
    pdf.text(cancelled ? 'CANCELLED' : 'PAID', L + stampW / 2, signY - 4, { size: 15, bold: true, color: stampColor, align: 'center' });
    const text = `${copy.signatures[0]}:`;
    const x = L + W / 2;
    pdf.text(text, x, signY, { size: 10.5, color: C.ink2 });
    pdf.line(x + pdf.measure(text, 10.5) + 6, signY + 2, R, signY + 2, { color: C.ink2, width: 0.8 });
  }
}

// One copy in half of an A4 page (both copies on one page). `top` is where it starts.
function drawHalf(pdf, r, key, top, height) {
  const copy = COPIES[key];
  const cancelled = r.status === 'CANCELLED';
  const X0 = 10 * MM;
  const W0 = pdf.width - 20 * MM;
  const L = X0 + 14;
  const R = X0 + W0 - 14;
  const W = R - L;

  pdf.strokeRect(X0, top, W0, height, { color: C.primary, width: 1.2 });

  // Letterhead
  const logo = pdfLogo();
  if (logo) pdf.image(logo, L, top + 9, 44, 44);
  else pdf.rect(L, top + 11, 40, 40, { fill: C.primary });
  const tx = L + 54;
  pdf.text(r.school.name.toUpperCase(), tx, top + 20, { size: 12.5, bold: true, color: C.primary });
  const lines = [...addressLines(r.school), `PIN – ${r.school.pin}`];
  lines.forEach((line, i) => pdf.text(line, tx, top + 31 + i * 10, { size: 8.5, color: C.ink2 }));

  // FEE RECEIPT with the copy label
  const bandY = top + 60;
  pdf.rect(L, bandY, W, 20, { fill: C.navy });
  pdf.rect(L, bandY + 20, W, 2, { fill: C.gold });
  pdf.text('FEE RECEIPT', L + 10, bandY + 14, { size: 11, bold: true, color: '#FFFFFF' });
  pdf.rect(R - 118, bandY + 3, 114, 14, { fill: key === 'school' ? C.goldBright : '#FFFFFF' });
  pdf.text(copy.label, R - 61, bandY + 13.5, { size: 10, bold: true, color: C.navy, align: 'center' });

  let y = bandY + 28;
  const note = statusNote(r);
  if (note) {
    pdf.text(fit(pdf, note, W, 8, true), L, y + 5, { size: 8, bold: true, color: cancelled ? C.danger : C.primary });
    y += 11;
  }

  // Fields in six columns. [label, value, columns spanned]
  const grid = (cells, start) => {
    const col = W / 6;
    let c = 0;
    let row = start;
    for (const [label, value, span = 1] of cells) {
      if (c + span > 6) {
        c = 0;
        row += 22;
      }
      const x = L + c * col;
      const width = col * span - 10;
      pdf.text(fit(pdf, label, width, 6.8), x, row + 7, { size: 6.8, color: C.muted });
      pdf.text(fit(pdf, String(value ?? '—'), width, 9.3, true), x, row + 17, { size: 9.3, bold: true });
      pdf.line(x, row + 20, x + width, row + 20, { color: C.rule, width: 0.6 });
      c += span;
      if (c >= 6) {
        c = 0;
        row += 22;
      }
    }
    return c === 0 ? row : row + 22;
  };
  y = grid(
    [
      ['Receipt Number', r.receiptNo, 2],
      ['Date', formatDate(r.paidAt)],
      ['Time', formatTime(r.paidAt)],
      ['Student ID', r.student.code],
      ['Admission Number', r.student.admissionNo],
      ['Student Name', r.student.name, 2],
      ['Father/Mother Name', r.student.parentNames || '—', 2],
      ['Class', r.student.grade],
      ['Section', r.student.section],
    ],
    y,
  );

  // Fee heads in two columns: Fee Head | Amount | Fee Head | Amount
  y += 3;
  pdf.text('FEE DETAILS', L, y + 7, { size: 7.5, bold: true, color: C.primary });
  y += 10;
  const half = W / 2;
  const rowH = 15;
  pdf.rect(L, y, W, 13, { fill: C.bg });
  pdf.strokeRect(L, y, W, 13 + 3 * rowH + 16, { color: C.border, width: 0.7 });
  for (const x of [L, L + half]) {
    pdf.text('FEE HEAD', x + 7, y + 9.5, { size: 6.8, bold: true, color: C.muted });
    pdf.text('AMOUNT', x + half - 7, y + 9.5, { size: 6.8, bold: true, color: C.muted, align: 'right' });
  }
  y += 13;
  const heads = feeHeads(r.items);
  for (let i = 0; i < heads.length; i += 2) {
    pdf.line(L, y, R, y, { color: C.border, width: 0.6 });
    [heads[i], heads[i + 1]].forEach((h, j) => {
      const x = L + j * half;
      pdf.text(h.head, x + 7, y + 10.5, { size: 8.6, bold: h.paid, color: h.paid ? C.ink : C.muted });
      if (h.detail) {
        const dx = x + 7 + pdf.measure(h.head, 8.6, h.paid) + 5;
        pdf.text(fit(pdf, h.detail, x + half - 62 - dx, 6.5), dx, y + 10.5, { size: 6.5, color: C.muted });
      }
      pdf.text(h.paid ? rupees(h.amount) : '—', x + half - 7, y + 10.5, { size: 8.6, bold: h.paid, color: h.paid ? C.ink : C.muted, align: 'right' });
    });
    y += rowH;
  }
  pdf.line(L + half, y - 3 * rowH - 13, L + half, y, { color: C.border, width: 0.6 });
  pdf.rect(L + 0.4, y, W - 0.8, 16, { fill: C.goldSoft });
  pdf.line(L, y, R, y, { color: C.gold, width: 1 });
  pdf.text('Total Amount Paid', L + 7, y + 11.5, { size: 9.5, bold: true });
  pdf.text(rupees(r.total), R - 7, y + 11.5, { size: 10.5, bold: true, align: 'right' });
  y += 26;
  const { fields: payFields, extras } = halfPayment(r, key);
  let extraWidth = 0;
  let ex = R;
  for (const [label, value] of [...extras].reverse()) {
    pdf.text(value, ex, y, { size: 8.5, bold: true, align: 'right' });
    ex -= pdf.measure(value, 8.5, true) + 4;
    pdf.text(`${label}:`, ex, y, { size: 7.5, color: C.muted, align: 'right' });
    ex -= pdf.measure(`${label}:`, 7.5) + 14;
    extraWidth = R - ex;
  }
  pdf.text('Amount in words:', L, y, { size: 7.5, color: C.muted });
  pdf.text(fit(pdf, amountInWords(r.total), W - 66 - extraWidth, 8.5, true), L + 64, y, { size: 8.5, bold: true });
  y += 5;

  // Payment details: one row
  grid(payFields.map(([label, value, opts = {}]) => [label, value, opts.wide ? 2 : 1]), y);

  // Footer
  const footY = top + height - 24;
  const markW = key === 'school' ? 170 : 250;
  if (key === 'school') {
    pdf.rect(L, footY, markW, 15, { fill: C.navy });
    pdf.text(copy.footer, L + markW / 2, footY + 10.5, { size: 8.5, bold: true, color: '#FFFFFF', align: 'center' });
  } else {
    pdf.rect(L, footY, markW, 15, { fill: C.goldSoft });
    pdf.strokeRect(L, footY, markW, 15, { color: C.gold, width: 0.8 });
    pdf.text(`${copy.footer} · ${copy.note}`, L + markW / 2, footY + 10.5, { size: 7.8, bold: true, color: C.navy, align: 'center' });
  }
  const signArea = R - (L + markW + 14);
  const each = signArea / copy.signatures.length;
  copy.signatures.forEach((label, i) => {
    const x = L + markW + 14 + i * each;
    const text = `${label}:`;
    pdf.text(text, x, footY + 12, { size: 8, color: C.ink2 });
    pdf.line(x + pdf.measure(text, 8) + 4, footY + 13, x + each - 10, footY + 13, { color: C.ink2, width: 0.7 });
  });
}

// A4 portrait. 'school' or 'parent': one full page. 'both': both copies on
// one page, school copy on top, with a cut line between them.
export function receiptPdf(r, { copy = 'parent' } = {}) {
  const pdf = new Pdf({ title: `Fee receipt ${r.receiptNo} – ${copyLabel(copy)}` });
  if (copy === 'both') {
    const top = 10 * MM;
    const gap = 22;
    const height = (pdf.height - 20 * MM - gap) / 2;
    drawHalf(pdf, r, 'school', top, height);
    const cutY = top + height + gap / 2;
    pdf.line(10 * MM, cutY, pdf.width - 10 * MM, cutY, { color: C.muted, width: 0.8, dash: [4, 3] });
    const label = 'Cut here · School Copy above, Parent Copy below';
    const lw = pdf.measure(label, 7) + 16;
    pdf.rect(pdf.width / 2 - lw / 2, cutY - 5, lw, 10, { fill: '#FFFFFF' });
    pdf.text(label, pdf.width / 2, cutY + 2.5, { size: 7, color: C.muted, align: 'center' });
    drawHalf(pdf, r, 'parent', top + height + gap, height);
  } else {
    drawCopy(pdf, r, copy);
  }
  return pdf.toBuffer();
}
