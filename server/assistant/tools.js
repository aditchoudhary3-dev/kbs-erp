import { db } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../http.js';
import { can, ROLES } from '../permissions.js';
import { getStudent, searchStudents } from '../services/students.js';
import { dueSummary } from '../services/fees.js';
import * as reports from '../services/reports.js';
import { dayEnd, dayStart, paymentDetails, searchPayments } from '../services/payment-history.js';
import { applyLateFees, FREQUENCIES, currentSession, instalments, listFeeTypes, listStructures, sessionRange } from '../services/fee-structure.js';
import { COUNTER_METHODS } from '../services/payments.js';
import { createAction } from './actions.js';
import { absentees, daySummary } from '../services/attendance.js';
import { dailySummary } from './insights.js';
import { COUNTER_MODE, MODE_LABELS, MODES, modeFilter, PERIODS, periodRange, toGrade } from './parse.js';
import { GRADES } from '../../shared/school.js';
import { formatDate, formatTime, istDate, rupees, todayIso } from '../../shared/format.js';

// The KBS AI Assistant's tools: the only way it can reach school data.
//
// - Each tool names the permission it needs; the staff member's role is
//   checked on every call, on the server. Claude is only shown the tools the
//   user may use.
// - Inputs are validated against the tool's fields before it runs.
// - Read tools return only what is needed: student name, admission number,
//   class and parent name, never phone numbers, addresses or dates of birth.
// - Tools named propose_* change nothing. They prepare the exact change and
//   show it with CONFIRM and CANCEL; it runs only when the staff member who
//   asked presses Confirm (see actions.js).
// - There are no tools for deleting records, changing payment status,
//   transaction IDs, amounts or issued receipts, managing users, or reading
//   settings, keys or the database directly.

export class ToolError extends Error {}

// ---- Input fields ----------------------------------------------------------------------

const F = {
  text: (maxLength, description) => ({ type: 'string', maxLength, description }),
  int: (minimum, maximum, description) => ({ type: 'integer', minimum, maximum, description }),
  bool: (description) => ({ type: 'boolean', description }),
  oneOf: (values, description) => ({ type: 'string', enum: values, description }),
  date: (description) => ({ type: 'string', format: 'date', description: `${description} (YYYY-MM-DD)` }),
  month: (description) => ({ type: 'string', format: 'month', description: `${description} (YYYY-MM)` }),
  grade: (description = 'Class: Nursery, LKG, UKG or Class 1 to Class 12. Leave out for all classes.') => ({
    type: 'string',
    description,
    clean: (v) => (/^all/i.test(v) ? '' : toGrade(v)),
    invalid: 'Classes are Nursery, LKG, UKG and Class 1 to Class 12.',
  }),
  section: () => ({ type: 'string', description: 'Section letter, A to D', clean: (v) => (/^[a-d]$/i.test(v) ? v.toUpperCase() : null), invalid: 'Sections are single letters, like A or B.' }),
};

const PERIOD = F.oneOf(PERIODS, 'A period, used when no dates are given');
const STUDENT = {
  studentId: F.int(1, 10_000_000, 'Student number from an earlier result (preferred when known)'),
  name: F.text(60, 'Student name, admission number or student ID (STU…)'),
  grade: F.grade('Class, to narrow down the name search'),
  section: F.section(),
};

function jsonSchema(tool) {
  const properties = Object.fromEntries(
    Object.entries(tool.input).map(([key, { clean, invalid, format, ...field }]) => [
      key,
      format === 'date' ? { ...field, pattern: '^\\d{4}-\\d{2}-\\d{2}$' } : format === 'month' ? { ...field, pattern: '^\\d{4}-\\d{2}$' } : field,
    ]),
  );
  return { type: 'object', properties, required: tool.required ?? [], additionalProperties: false };
}

function validate(tool, input) {
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) throw new ToolError('The request was not understood.');
  const out = {};
  for (const [key, field] of Object.entries(tool.input)) {
    let value = input?.[key];
    if (value === undefined || value === null || value === '') continue;
    if (field.type === 'string') {
      if (typeof value !== 'string' && typeof value !== 'number') throw new ToolError(`“${key}” must be text.`);
      value = String(value).trim().slice(0, field.maxLength ?? 80);
      if (!value) continue;
      if (field.enum) {
        const hit = field.enum.find((option) => option.toLowerCase() === value.toLowerCase().replace(/\s+/g, '_') || option.toLowerCase() === value.toLowerCase());
        if (!hit) throw new ToolError(`“${key}” must be one of: ${field.enum.join(', ')}.`);
        value = hit;
      }
      if (field.format === 'date' && !(/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)))) throw new ToolError(`“${key}” must be a date like 2026-09-25.`);
      if (field.format === 'month' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new ToolError(`“${key}” must be a month like 2026-10.`);
    } else if (field.type === 'integer') {
      const n = typeof value === 'string' ? Number(value.replace(/[₹,\s]/g, '')) : value;
      if (!Number.isInteger(n)) throw new ToolError(`“${key}” must be a whole number.`);
      if (n < field.minimum || n > field.maximum) throw new ToolError(`“${key}” must be between ${field.minimum} and ${field.maximum}.`);
      value = n;
    } else if (field.type === 'boolean') {
      value = value === true || value === 'true';
    }
    if (field.clean) {
      const cleaned = field.clean(value);
      if (cleaned === null || cleaned === undefined) throw new ToolError(field.invalid ?? `“${value}” is not a valid ${key}.`);
      if (cleaned === '') continue;
      value = cleaned;
    }
    out[key] = value;
  }
  for (const key of tool.required ?? []) if (out[key] === undefined) throw new ToolError(`Please give the ${key}.`);
  return out;
}

// ---- Shared helpers --------------------------------------------------------------------------

// What the assistant may show about a student.
export const publicStudent = (s) => ({
  id: s.id,
  code: s.code,
  name: s.name,
  admissionNo: s.admissionNo,
  classLabel: s.classLabel,
  parentName: s.parentNames || '—',
});

const escapeLike = (text) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

// Every word must start a word of the name: "aman" finds "Aman Kumar" and "Amandeep Singh".
function findStudents(query, { grade = '', section = '', limit = 10 } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  if (/\d/.test(q)) return searchStudents({ q, grade, section, status: 'active', limit });
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length >= 2).slice(0, 4);
  if (!words.length) return [];
  const where = ['s.active = 1', ...words.map(() => "(' ' || lower(s.name)) LIKE ? ESCAPE '\\'")];
  const args = words.map((w) => `% ${escapeLike(w)}%`);
  if (grade) {
    where.push('c.grade = ?');
    args.push(grade);
  }
  if (section) {
    where.push('c.section = ?');
    args.push(section);
  }
  return db
    .prepare(`SELECT s.id FROM students s JOIN classes c ON c.id = s.class_id WHERE ${where.join(' AND ')} ORDER BY lower(s.name) = ? DESC, c.sort_order, s.name LIMIT ?`)
    .all(...args, q.toLowerCase(), limit)
    .map((r) => getStudent(r.id));
}

// One student, or a list to choose from (shown as a pick list that runs `tool` again).
function resolveStudent(args, tool) {
  if (args.studentId) {
    const student = getStudent(args.studentId);
    if (!student) throw new ToolError('No student has that number.');
    return { student };
  }
  if (!args.name) throw new ToolError('Which student? Give a name, admission number or student ID.');
  const matches = findStudents(args.name, { grade: args.grade, section: args.section, limit: 8 });
  if (matches.length === 1) return { student: matches[0] };
  const scope = args.grade ? ` in ${args.grade}${args.section ? `-${args.section}` : ''}` : '';
  if (!matches.length) throw new ToolError(`I could not find an active student called “${args.name}”${scope}. Check the spelling, or search by admission number.`);
  const students = matches.map(publicStudent);
  const { studentId, name, grade, section, ...rest } = args;
  return {
    pick: {
      text: `${matches.length} students found. Please select the correct student.`,
      data: { needsChoice: true, students },
      cards: [{ type: 'students', title: `${matches.length} students match “${args.name}”${scope}`, students, then: { tool, args: rest } }],
    },
  };
}

const sum = (rows, key) => rows.reduce((t, r) => t + (Number(r[key]) || 0), 0);
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const day = (date) => formatDate(date);
const when = (iso) => `${formatDate(iso, { year: false })}, ${formatTime(iso)}`;

function rangeOf({ period, from, to }, fallback = 'today') {
  if (from || to) {
    let [a, b] = [from ?? to, to ?? from];
    if (a > b) [a, b] = [b, a];
    return { from: a, to: b, label: a === b ? (a === todayIso() ? 'today' : `on ${day(a)}`) : `from ${day(a)} to ${day(b)}` };
  }
  return periodRange(period ?? fallback);
}

const exportLink = (staff, name, params) =>
  can(staff.role, 'reports.export')
    ? { href: `/api/admin/export/${name}?${new URLSearchParams({ ...Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v !== undefined && v !== null)), format: 'xlsx' })}`, label: 'Export Excel' }
    : null;

// Columns and fields never sent to the assistant or shown in its answers.
const PRIVATE = new Set(['phone', 'parentPhone', 'altPhone', 'whatsappPhone', 'address', 'dob']);
const strip = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => !PRIVATE.has(k)));

// A report (the same shape as the Reports page) as a table card and compact data.
function reportResult(report, { staff, exportName, exportParams, limit = 25, rowAction = null, text }) {
  const columns = report.columns.filter((c) => c.screen !== false && !PRIVATE.has(c.key)).map(({ key, header, type }) => ({ key, header, type }));
  const rows = report.rows.map(strip);
  return {
    text,
    data: { title: report.title, subtitle: report.subtitle, note: report.note || undefined, totals: report.totals, rowCount: rows.length, rows: rows.slice(0, 15) },
    cards: [
      {
        type: 'table',
        title: report.title,
        subtitle: report.subtitle,
        note: report.note || undefined,
        columns,
        rows: rows.slice(0, limit),
        totals: report.totals,
        more: Math.max(0, rows.length - limit),
        export: exportName ? exportLink(staff, exportName, exportParams) : null,
        rowAction,
      },
    ],
  };
}

// Money collected between two dates, split by how it was paid.
function collected(from, to) {
  const rows = db
    .prepare(
      `SELECT p.amount, p.method, o.channel FROM payments p JOIN payment_orders o ON o.id = p.order_id
       WHERE p.status = 'confirmed' AND p.paid_at >= ? AND p.paid_at < ?`,
    )
    .all(dayStart(from), dayEnd(to));
  const part = (test) => {
    const list = rows.filter(test);
    return { amount: sum(list, 'amount'), count: list.length };
  };
  const byMode = new Map();
  for (const r of rows) {
    const key = r.channel === 'online' ? `${r.method} (online)` : r.method;
    const entry = byMode.get(key) ?? { mode: key, count: 0, amount: 0 };
    entry.count += 1;
    entry.amount += r.amount;
    byMode.set(key, entry);
  }
  return {
    total: part(() => true),
    cash: part((r) => r.method === 'Cash'),
    online: part((r) => r.channel === 'online'),
    otherCounter: part((r) => r.channel !== 'online' && r.method !== 'Cash'),
    byMode: [...byMode.values()].sort((a, b) => b.amount - a.amount),
  };
}

// A payment as shown in the assistant: no phone numbers or message text.
export function cardPayment(p) {
  const { whatsapp, gatewayPaymentId, ...rest } = p;
  return { ...rest, whatsapp: whatsapp ? { status: whatsapp.status, state: whatsapp.state, detail: whatsapp.detail } : null };
}

function paymentRows(rows) {
  return rows.map((p) => ({
    paymentId: p.paymentId,
    when: when(p.at),
    receiptNo: p.receiptNo ?? '—',
    student: p.student.name,
    classLabel: p.student.classLabel,
    amount: p.amount,
    mode: p.paymentId ? `${p.method}${p.channel === 'online' ? ' (online)' : ''}` : 'Online checkout',
    status: p.status,
    whatsapp: p.whatsapp?.state ?? null,
  }));
}
const PAYMENT_COLUMNS = [
  { key: 'when', header: 'Date' },
  { key: 'receiptNo', header: 'Receipt No.' },
  { key: 'student', header: 'Student' },
  { key: 'classLabel', header: 'Class' },
  { key: 'amount', header: 'Amount', type: 'money' },
  { key: 'mode', header: 'Mode' },
  { key: 'status', header: 'Status', type: 'status' },
];

// ---- The tools ---------------------------------------------------------------------------

const TOOLS = [];
const tool = (definition) => TOOLS.push({ kind: 'read', ...definition });

tool({
  name: 'find_students',
  description:
    'Find active students by name (any part), admission number or student ID, optionally in one class. Returns name, admission number, class and parent name only. Use when the user asks to find or look up a student.',
  permission: 'students.view',
  deny: 'search students',
  input: { query: F.text(60, 'Name, admission number or student ID (STU…)'), grade: F.grade(), section: F.section() },
  required: ['query'],
  run(args) {
    const list = findStudents(args.query, { grade: args.grade, section: args.section, limit: 10 });
    const scope = args.grade ? ` in ${args.grade}${args.section ? `-${args.section}` : ''}` : '';
    if (!list.length && args.grade) {
      // Nobody of that name in the class: show matches elsewhere in the school.
      const elsewhere = findStudents(args.query, { limit: 10 }).map(publicStudent);
      if (elsewhere.length) {
        return {
          text: `No active student called “${args.query}”${scope}, but ${plural(elsewhere.length, 'student')} in other classes ${elsewhere.length === 1 ? 'matches' : 'match'}. Please select the correct student.`,
          data: { count: 0, inOtherClasses: elsewhere },
          cards: [{ type: 'students', title: `“${args.query}” in other classes`, students: elsewhere, then: null }],
        };
      }
    }
    if (!list.length) return { text: `No active student matches “${args.query}”${scope}.`, data: { count: 0, students: [] } };
    const students = list.map(publicStudent);
    return {
      text: list.length === 1 ? `1 student found: ${students[0].name}, ${students[0].classLabel}.` : `${list.length} students found. Please select the correct student.`,
      data: { count: list.length, students },
      cards: [{ type: 'students', title: `${plural(list.length, 'student')} found${scope}`, students, then: null }],
    };
  },
});

tool({
  name: 'student_fees',
  description:
    "One student's fee position: fees due now (with overdue amounts), upcoming instalments, amount paid this session and the last payment. Use for 'how much is pending for <student>'.",
  permission: 'payments.view',
  deny: 'view fee information',
  input: STUDENT,
  run(args, staff) {
    const found = resolveStudent(args, 'student_fees');
    if (found.pick) return found.pick;
    const s = found.student;
    applyLateFees();
    const due = dueSummary(s.id);
    const today = todayIso();
    const overdue = sum(due.items.filter((i) => i.dueDate < today), 'amount');
    const paid = db
      .prepare("SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count FROM payments WHERE student_id = ? AND status = 'confirmed' AND paid_at >= ?")
      .get(s.id, dayStart(`${config.academicYear.start}-01`));
    const last = db.prepare("SELECT id, receipt_no, amount, paid_at, method FROM payments WHERE student_id = ? AND status = 'confirmed' ORDER BY paid_at DESC LIMIT 1").get(s.id);
    const student = publicStudent(s);
    const items = due.items.map((i) => ({ title: i.title, feeType: i.feeType, amount: i.amount, dueDate: i.dueDate, overdue: i.dueDate < today }));
    const text = due.total
      ? `${s.name} (${s.classLabel}) has ${rupees(due.total)} pending${overdue ? `, of which ${rupees(overdue)} is overdue` : ''}. ` +
        `${due.upcoming.length ? `${rupees(due.upcomingTotal)} more falls due later. ` : ''}Paid this session: ${rupees(paid.total)}.`
      : `${s.name} (${s.classLabel}) has nothing pending right now. Paid this session: ${rupees(paid.total)}.${due.upcoming.length ? ` Next: ${due.upcoming[0].title}, ${rupees(due.upcoming[0].amount)} due ${day(due.upcoming[0].dueDate)}.` : ''}`;
    return {
      text,
      data: {
        student,
        pending: due.total,
        overdue,
        items,
        upcoming: { total: due.upcomingTotal, count: due.upcoming.length, next: due.upcoming[0] ? { title: due.upcoming[0].title, amount: due.upcoming[0].amount, dueDate: due.upcoming[0].dueDate } : null },
        paidThisSession: paid.total,
        lastPayment: last ? { receiptNo: last.receipt_no, amount: last.amount, date: istDate(last.paid_at), method: last.method } : null,
      },
      cards: [
        {
          type: 'student-fees',
          student,
          active: s.active,
          due: { total: due.total, overdue, items },
          upcoming: { total: due.upcomingTotal, count: due.upcoming.length },
          paidThisSession: paid.total,
          lastPayment: last ? { paymentId: last.id, receiptNo: last.receipt_no, amount: last.amount, date: istDate(last.paid_at) } : null,
          canCollect: can(staff.role, 'payments.collect'),
        },
      ],
    };
  },
});

tool({
  name: 'student_payments',
  description: "One student's payment history: every receipt with date, amount, mode and status (PAID or CANCELLED), and failed or pending online attempts.",
  permission: 'payments.view',
  deny: 'view payments',
  input: STUDENT,
  run(args, staff) {
    const found = resolveStudent(args, 'student_payments');
    if (found.pick) return found.pick;
    const s = found.student;
    const { rows, total } = searchPayments({ studentId: s.id }, { limit: 30 });
    const paid = rows.filter((r) => r.status === 'PAID');
    const list = paymentRows(rows);
    return {
      text: rows.length
        ? `${s.name} (${s.classLabel}): ${plural(paid.length, 'paid receipt')}, ${rupees(sum(paid, 'amount'))} in total. Latest: ${rows[0].receiptNo ?? 'an online attempt'} on ${day(istDate(rows[0].at))}.`
        : `${s.name} (${s.classLabel}) has no payments yet.`,
      data: { student: publicStudent(s), count: total, payments: list.slice(0, 15).map(({ paymentId, whatsapp, ...r }) => r) },
      cards: rows.length
        ? [
            {
              type: 'table',
              title: `Payment history: ${s.name}`,
              subtitle: `${s.admissionNo} · ${s.classLabel}`,
              columns: PAYMENT_COLUMNS.filter((c) => !['student', 'classLabel'].includes(c.key)),
              rows: list,
              more: Math.max(0, total - list.length),
              export: exportLink(staff, 'student', { studentId: s.id }),
              rowAction: 'receipt',
            },
          ]
        : [],
    };
  },
});

tool({
  name: 'find_receipt',
  description: 'Find a receipt by its number (full, like KBS/2026-27/01025, or just the last digits, like 1025). Returns the payment, its status and the WhatsApp status of the parent copy.',
  permission: 'payments.view',
  deny: 'view receipts',
  input: { receiptNo: F.text(40, 'Receipt number, full or the last digits') },
  required: ['receiptNo'],
  run(args) {
    const q = args.receiptNo.toUpperCase().replace(/\s+/g, '');
    let ids = [];
    if (/^\d+$/.test(q)) ids = db.prepare("SELECT id FROM payments WHERE receipt_no LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 5").all(`%/${q.padStart(5, '0')}`);
    if (!ids.length) ids = db.prepare("SELECT id FROM payments WHERE receipt_no LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 5").all(`%${escapeLike(q)}%`);
    if (!ids.length) return { text: `No receipt matches “${args.receiptNo}”.`, data: { found: 0 } };
    const payments = ids.map((r) => cardPayment(paymentDetails(r.id)));
    const p = payments[0];
    return {
      text:
        payments.length === 1
          ? `Receipt ${p.receiptNo}: ${rupees(p.amount)} for ${p.student.name} (${p.student.classLabel}), paid by ${p.method} on ${day(istDate(p.paidAt))}. Status: ${p.status}. WhatsApp (parent copy): ${p.whatsapp?.state ?? 'PENDING'}.`
          : `${payments.length} receipts match “${args.receiptNo}”.`,
      data: {
        receipts: payments.map((x) => ({
          receiptNo: x.receiptNo,
          student: x.student.name,
          classLabel: x.student.classLabel,
          amount: x.amount,
          method: x.method,
          transactionId: x.txnId,
          date: istDate(x.paidAt),
          time: formatTime(x.paidAt),
          collectedBy: x.collectedBy,
          status: x.status,
          fees: x.items.map((i) => `${i.title} ${rupees(i.amount)}`),
          whatsapp: x.whatsapp?.state ?? 'PENDING',
        })),
      },
      cards: payments.map((payment) => ({ type: 'receipt', payment })),
    };
  },
});

tool({
  name: 'collection_summary',
  description: 'Total fees collected in a period, with cash, online and other counter payments separated. Optional mode filter. Use for "how much was collected / received".',
  permission: 'reports.view',
  deny: 'view collection figures',
  input: { period: PERIOD, from: F.date('Start date'), to: F.date('End date'), mode: F.oneOf(MODES, 'Only this payment mode') },
  run(args) {
    const range = rangeOf(args);
    const c = collected(range.from, range.to);
    let text;
    if (args.mode === 'cash') text = `${rupees(c.cash.amount)} was collected in cash ${range.label} (${plural(c.cash.count, 'payment')}).`;
    else if (args.mode === 'online') text = `${rupees(c.online.amount)} was received online ${range.label} (${plural(c.online.count, 'payment')}).`;
    else if (args.mode) {
      const m = c.byMode.filter((x) => x.mode.toLowerCase().startsWith((COUNTER_MODE[args.mode] ?? args.mode).toLowerCase()));
      text = `${rupees(sum(m, 'amount'))} was received by ${MODE_LABELS[args.mode]} ${range.label} (${plural(sum(m, 'count'), 'payment')}).`;
    } else {
      text = `${rupees(c.total.amount)} was collected ${range.label} from ${plural(c.total.count, 'payment')}: cash ${rupees(c.cash.amount)}, online ${rupees(c.online.amount)}${c.otherCounter.amount ? `, other counter payments ${rupees(c.otherCounter.amount)}` : ''}.`;
    }
    return {
      text,
      data: { period: range, total: c.total, cash: c.cash, online: c.online, otherCounter: c.otherCounter, byMode: c.byMode },
      cards: [
        {
          type: 'stats',
          title: `Collection ${range.label}`,
          items: [
            { label: 'Total collected', value: c.total.amount, format: 'money', strong: true },
            { label: 'Cash', value: c.cash.amount, format: 'money', sub: plural(c.cash.count, 'payment') },
            { label: 'Online', value: c.online.amount, format: 'money', sub: plural(c.online.count, 'payment') },
            { label: 'Other at counter', value: c.otherCounter.amount, format: 'money', sub: 'UPI, cheque, card, bank' },
            { label: 'Payments', value: c.total.count, format: 'number' },
          ],
        },
      ],
    };
  },
});

tool({
  name: 'cash_vs_online',
  description: 'Compare cash, online and other counter collection side by side, for today, this week, this month and this session (or one period).',
  permission: 'reports.view',
  deny: 'view collection figures',
  input: { period: PERIOD },
  run(args, staff) {
    const periods = args.period ? [args.period] : ['today', 'this_week', 'this_month', 'this_session'];
    const rows = periods.map((p) => {
      const range = periodRange(p);
      const c = collected(range.from, range.to);
      const share = c.total.amount ? Math.round((c.online.amount / c.total.amount) * 100) : 0;
      return { period: range.label.replace(/^\w/, (x) => x.toUpperCase()), cash: c.cash.amount, online: c.online.amount, other: c.otherCounter.amount, total: c.total.amount, onlineShare: `${share}%` };
    });
    const first = rows[0];
    const range = periodRange(periods.at(-1));
    return {
      text: `${first.period}: cash ${rupees(first.cash)}, online ${rupees(first.online)} (${first.onlineShare} of ${rupees(first.total)}).`,
      data: { rows },
      cards: [
        {
          type: 'table',
          title: 'Cash vs online collection',
          columns: [
            { key: 'period', header: 'Period' },
            { key: 'cash', header: 'Cash', type: 'money' },
            { key: 'online', header: 'Online', type: 'money' },
            { key: 'other', header: 'Other counter', type: 'money' },
            { key: 'total', header: 'Total', type: 'money' },
            { key: 'onlineShare', header: 'Online %' },
          ],
          rows,
          export: exportLink(staff, 'modes', { from: range.from, to: range.to }),
        },
      ],
    };
  },
});

tool({
  name: 'list_payments',
  description: 'List payments in a period (default today), newest first, with optional mode, class and status filters. Includes receipt numbers and totals.',
  permission: 'payments.view',
  deny: 'view payments',
  input: {
    period: PERIOD,
    from: F.date('Start date'),
    to: F.date('End date'),
    mode: F.oneOf(MODES, 'Only this payment mode'),
    grade: F.grade(),
    section: F.section(),
    status: F.oneOf(['PAID', 'PENDING', 'FAILED', 'CANCELLED'], 'Only this status'),
  },
  run(args, staff) {
    const range = rangeOf(args);
    const filters = { from: range.from, to: range.to, ...modeFilter(args.mode), grade: args.grade ?? '', section: args.section ?? '', status: args.status ?? '' };
    const { rows, total, paidCount, paidAmount } = searchPayments(filters, { limit: 25 });
    const what = [args.status?.toLowerCase(), args.mode ? MODE_LABELS[args.mode] : '', 'payments'].filter(Boolean).join(' ');
    const scope = args.grade ? ` in ${args.grade}${args.section ? `-${args.section}` : ''}` : '';
    const list = paymentRows(rows);
    const unpaid = args.status && args.status !== 'PAID';
    return {
      text: !total
        ? `No ${what}${scope} ${range.label}.`
        : unpaid
          ? `${plural(total, what.replace(/s$/, ''), what)}${scope} ${range.label} (${rupees(sum(rows, 'amount'))}${total > rows.length ? ' in the latest 25' : ''}).`
          : `${plural(total, what.replace(/s$/, ''), what)}${scope} ${range.label}: ${paidCount} paid, ${rupees(paidAmount)} collected.`,
      data: { period: range, count: total, paidCount, paidAmount, payments: list.slice(0, 15).map(({ paymentId, ...r }) => r) },
      cards: total
        ? [
            {
              type: 'table',
              title: `${what.replace(/^\w/, (x) => x.toUpperCase())}${scope} ${range.label}`,
              subtitle: unpaid ? null : `${paidCount} paid · ${rupees(paidAmount)} collected`,
              columns: PAYMENT_COLUMNS,
              rows: list,
              more: Math.max(0, total - list.length),
              export: exportLink(staff, 'payments', filters),
              rowAction: 'receipt',
            },
          ]
        : [],
    };
  },
});

tool({
  name: 'pending_fees',
  description: 'Students with fees due now (pending and overdue), for one class/section or the whole school, with totals. Use for "Class 8 pending fees" or "students who have pending fees".',
  permission: 'reports.view',
  deny: 'view pending fees',
  input: { grade: F.grade(), section: F.section(), overdueOnly: F.bool('Only students with overdue fees') },
  run(args, staff) {
    const report = reports.pendingReport({ grade: args.grade ?? '', section: args.section ?? '', overdueOnly: Boolean(args.overdueOnly) });
    const n = report.rows.length;
    const scope = args.grade ? `${args.grade}${args.section ? `-${args.section}` : ''}` : 'the school';
    const result = reportResult(report, {
      staff,
      exportName: 'pending',
      exportParams: { grade: args.grade, section: args.section, overdueOnly: args.overdueOnly ? 'true' : '' },
      rowAction: 'student',
      text: n
        ? `${plural(n, 'student')} in ${scope} ${n === 1 ? 'has' : 'have'} ${rupees(report.totals.pending)} pending${report.totals.overdue ? `; ${rupees(report.totals.overdue)} of it is overdue` : ', none of it overdue yet'}.`
        : `No student in ${scope} has ${args.overdueOnly ? 'overdue' : 'pending'} fees right now.`,
    });
    if (!args.grade) {
      result.data.byClass = reports
        .classSummary()
        .filter((g) => g.pending)
        .map((g) => ({ grade: g.grade, students: g.pendingStudents, pending: g.pending, overdue: g.overdue }));
    }
    return result;
  },
});

tool({
  name: 'unpaid_fee',
  description: "Students who have not paid one kind of fee (for example Tuition Fee) that falls due in a month (default this month). Use for 'who has not paid this month's tuition fee'.",
  permission: 'reports.view',
  deny: 'view pending fees',
  input: { feeType: F.text(40, 'Fee type, for example Tuition Fee or Transport Fee'), month: F.month('Month'), grade: F.grade() },
  required: ['feeType'],
  run(args, staff) {
    const type = listFeeTypes().find((t) => t.name.toLowerCase() === args.feeType.toLowerCase()) ??
      listFeeTypes().find((t) => t.name.toLowerCase().startsWith(args.feeType.toLowerCase().split(' ')[0]));
    if (!type) throw new ToolError(`There is no fee type called “${args.feeType}”. Fee types: ${listFeeTypes().map((t) => t.name).join(', ')}.`);
    const report = reports.unpaidFeeReport({ feeType: type.name, month: args.month ?? '', grade: args.grade ?? '' });
    const students = new Set(report.rows.map((r) => r.id)).size;
    return reportResult(report, {
      staff,
      exportName: 'unpaid-fee',
      exportParams: { feeType: type.name, month: args.month, grade: args.grade },
      rowAction: 'student',
      text: `${report.note ? `${report.note} ` : ''}${students ? `${plural(students, 'student')} ${students === 1 ? 'has' : 'have'} not paid ${type.name} (${rupees(report.totals.amount)}).` : `Everyone has paid ${type.name}.`}`,
    });
  },
});

const REPORT_NAMES = ['daily', 'monthly', 'class-wise', 'modes', 'pending', 'class-fees'];

tool({
  name: 'run_report',
  description:
    'Prepare a report with an Excel export button. daily = fee collection for a day or period (a single day lists every receipt); monthly = month-wise collection this session; class-wise = collection by class; modes = cash vs online and other modes; pending = pending fees; class-fees = every student in a class with paid, pending and status.',
  permission: 'reports.view',
  deny: 'view reports',
  input: { report: F.oneOf(REPORT_NAMES, 'Which report'), period: PERIOD, from: F.date('Start date'), to: F.date('End date'), grade: F.grade(), section: F.section() },
  required: ['report'],
  run(args, staff) {
    const grade = args.grade ?? '';
    const section = args.section ?? '';
    switch (args.report) {
      case 'daily': {
        const range = rangeOf(args);
        if (range.from === range.to) {
          // One day: every receipt that day, with totals; exports as the fee register.
          const c = collected(range.from, range.to);
          const { rows, total } = searchPayments({ from: range.from, to: range.to, status: 'PAID', grade, section }, { limit: 200 });
          const list = paymentRows(rows);
          return {
            text: `Fee collection report ${range.label}: ${rupees(c.total.amount)} from ${plural(c.total.count, 'payment')} (cash ${rupees(c.cash.amount)}, online ${rupees(c.online.amount)}${c.otherCounter.amount ? `, other ${rupees(c.otherCounter.amount)}` : ''}).`,
            data: { period: range, total: c.total, cash: c.cash, online: c.online, otherCounter: c.otherCounter, byMode: c.byMode },
            cards: [
              {
                type: 'stats',
                title: `Fee collection report · ${range.label}`,
                items: [
                  { label: 'Total collected', value: c.total.amount, format: 'money', strong: true },
                  { label: 'Cash', value: c.cash.amount, format: 'money' },
                  { label: 'Online', value: c.online.amount, format: 'money' },
                  { label: 'Other at counter', value: c.otherCounter.amount, format: 'money' },
                  { label: 'Receipts', value: c.total.count, format: 'number' },
                ],
              },
              {
                type: 'table',
                title: `Receipts ${range.label}`,
                columns: PAYMENT_COLUMNS.filter((c2) => c2.key !== 'status'),
                rows: list.slice(0, 30),
                more: Math.max(0, total - 30),
                export: exportLink(staff, 'payments', { from: range.from, to: range.to, status: 'PAID', grade, section }),
                rowAction: 'receipt',
              },
            ],
          };
        }
        const report = reports.dailyCollection({ from: range.from, to: range.to });
        return reportResult(report, { staff, exportName: 'daily', exportParams: { from: range.from, to: range.to }, text: `Daily collection ${range.label}: ${rupees(report.totals.total)} from ${plural(report.totals.receipts, 'receipt')}.` });
      }
      case 'monthly': {
        const report = reports.monthlyCollection();
        return reportResult(report, { staff, exportName: 'monthly', exportParams: {}, text: `Monthly collection for ${config.academicYear.label}: ${rupees(report.totals.total)} in total (online ${rupees(report.totals.online)}, counter ${rupees(report.totals.counter)}).` });
      }
      case 'class-wise': {
        const range = rangeOf(args, 'this_month');
        const report = reports.classCollection({ from: range.from, to: range.to });
        return reportResult(report, { staff, exportName: 'class-wise', exportParams: { from: range.from, to: range.to }, limit: 40, text: `Class-wise collection ${range.label}: ${rupees(report.totals.amount)}; ${rupees(report.totals.pending)} still pending.` });
      }
      case 'modes': {
        const range = rangeOf(args, 'this_month');
        const report = reports.modeReport({ from: range.from, to: range.to });
        return reportResult(report, { staff, exportName: 'modes', exportParams: { from: range.from, to: range.to }, text: `Payment modes ${range.label}: ${rupees(report.totals.amount)} from ${plural(report.totals.receipts, 'receipt')}.` });
      }
      case 'pending': {
        const report = reports.pendingReport({ grade, section });
        return reportResult(report, { staff, exportName: 'pending', exportParams: { grade, section }, rowAction: 'student', text: `Pending fee report for ${grade || 'all classes'}${section ? `-${section}` : ''}: ${plural(report.rows.length, 'student')}, ${rupees(report.totals.pending)} pending, ${rupees(report.totals.overdue)} overdue.` });
      }
      case 'class-fees': {
        const report = reports.classFeeStatus({ grade, section });
        const paid = report.rows.filter((r) => r.status === 'PAID').length;
        return reportResult(report, { staff, exportName: 'class-fees', exportParams: { grade, section }, rowAction: 'student', limit: 40, text: `${grade || 'All classes'}${section ? `-${section}` : ''} fee report: ${report.rows.length} students, ${paid} fully paid, ${rupees(report.totals.collected)} collected this session, ${rupees(report.totals.pending)} pending.` });
      }
      default:
        throw new ToolError('Unknown report.');
    }
  },
});

tool({
  name: 'daily_summary',
  description: "Today's operational summary: collection (cash/online), payments, failed and unfinished online payments, pending fee accounts, WhatsApp receipts pending or failed, corrections waiting, and recent issues.",
  permission: 'dashboard.view',
  deny: 'view the summary',
  input: {},
  run(_args, staff) {
    const summary = dailySummary(staff);
    return { text: summary.headline, data: summary, cards: [{ type: 'insights', summary }] };
  },
});

tool({
  name: 'attendance_day',
  description: 'Attendance for a day (default today): how many classes are marked, present/absent/leave counts and percentage, and who is absent or on leave. Optional class.',
  permission: 'attendance.view',
  deny: 'view attendance',
  input: { date: F.date('Day'), period: F.oneOf(['today', 'yesterday'], 'today or yesterday'), grade: F.grade(), section: F.section() },
  run(args) {
    const range = args.date ? { from: args.date, label: `on ${day(args.date)}` } : periodRange(args.period ?? 'today');
    const summary = daySummary(range.from);
    // Class labels look like "Class 8-A" or "Nursery-A".
    const prefix = args.grade ? `${args.grade}-${args.section ?? ''}` : '';
    const inScope = (label) => label.startsWith(prefix);
    const classes = summary.classes.filter((c) => inScope(c.label));
    const away = absentees(range.from).filter((a) => inScope(a.classLabel));
    const marked = classes.filter((c) => c.marked);
    const attended = sum(marked, 'attended');
    const total = attended + sum(marked, 'absent') + sum(marked, 'leave');
    const scope = args.grade ? `${args.grade}${args.section ? `-${args.section}` : ''}` : 'the school';
    const pct = total ? Math.round((attended / total) * 100) : null;
    const notMarked = classes.filter((c) => !c.marked).map((c) => c.label);
    return {
      text: marked.length
        ? `Attendance ${range.label} in ${scope}: ${pct}% (${attended} present, ${sum(marked, 'absent')} absent, ${sum(marked, 'leave')} on leave). ${notMarked.length ? `Not marked yet: ${notMarked.slice(0, 6).join(', ')}${notMarked.length > 6 ? '…' : ''}.` : 'Every class is marked.'}`
        : `No attendance has been marked ${range.label} in ${scope} yet.`,
      data: { date: range.from, scope, pct, classesMarked: marked.length, classes: classes.length, notMarked, absent: away.map(({ id, ...a }) => a) },
      cards: !marked.length ? [] : [
        {
          type: 'table',
          title: `Absent or on leave ${range.label}${args.grade ? ` · ${scope}` : ''}`,
          subtitle: `${marked.length} of ${classes.length} classes marked${pct === null ? '' : ` · ${pct}% present`}`,
          columns: [
            { key: 'name', header: 'Student' },
            { key: 'classLabel', header: 'Class' },
            { key: 'statusLabel', header: 'Status' },
            { key: 'note', header: 'Reason' },
          ],
          rows: away.slice(0, 40).map((a) => ({ ...a, statusLabel: a.status === 'leave' ? 'Leave' : 'Absent', note: a.note ?? '' })),
          more: Math.max(0, away.length - 40),
          link: { href: `/admin/attendance?tab=today&date=${range.from}`, label: 'Open Attendance' },
        },
      ],
    };
  },
});

tool({
  name: 'list_fee_types',
  description: 'All fee types (Tuition Fee, Transport Fee, …) and how many active fees use each.',
  permission: 'fees.manage',
  deny: 'view or change the fee structure',
  input: {},
  run() {
    const types = listFeeTypes();
    return {
      text: `There are ${types.length} fee types: ${types.map((t) => t.name).join(', ')}.`,
      data: { feeTypes: types.map(({ name, structures }) => ({ name, activeFees: structures })) },
      cards: [{ type: 'table', title: 'Fee types', columns: [{ key: 'name', header: 'Fee type' }, { key: 'structures', header: 'Active fees', type: 'number' }], rows: types }],
    };
  },
});

tool({
  name: 'fee_structure',
  description: 'The fees set up for the current session, optionally for one class: name, type, class, amount, frequency, first due date, late fee, compulsory or optional.',
  permission: 'fees.manage',
  deny: 'view or change the fee structure',
  input: { grade: F.grade() },
  run(args) {
    const list = listStructures({ grade: args.grade ?? '' });
    const rows = list.map((s) => ({
      name: s.name,
      feeType: s.feeType,
      grade: s.grade ?? 'All classes',
      amount: s.amount,
      frequency: s.frequency,
      firstDueDate: s.firstDueDate,
      lateFee: s.lateFee,
      kind: `${s.compulsory ? 'Compulsory' : 'Optional'}${s.transportOnly ? ' · transport' : ''}${s.newAdmissionsOnly ? ' · new admissions' : ''}`,
    }));
    return {
      text: `${plural(rows.length, 'fee')} set up for ${args.grade ?? 'all classes'} in ${currentSession()}.`,
      data: { fees: rows },
      cards: [
        {
          type: 'table',
          title: `Fee structure ${currentSession()}${args.grade ? ` · ${args.grade}` : ''}`,
          columns: [
            { key: 'name', header: 'Fee' },
            { key: 'grade', header: 'Class' },
            { key: 'amount', header: 'Amount', type: 'money' },
            { key: 'frequency', header: 'Frequency' },
            { key: 'firstDueDate', header: 'First due', type: 'date' },
            { key: 'lateFee', header: 'Late fee', type: 'money' },
            { key: 'kind', header: 'Type' },
          ],
          rows: rows.slice(0, 40),
          more: Math.max(0, rows.length - 40),
          link: { href: '/admin/fee-structure', label: 'Open Fee Structure' },
        },
      ],
    };
  },
});

// ---- Proposals (nothing changes until the user confirms) ------------------------------------

tool({
  name: 'propose_cash_payment',
  kind: 'propose',
  description:
    "Prepare a counter payment (cash by default) that the parent has handed over, for the user to CONFIRM. The amount is applied to the student's oldest outstanding fees first. This does not record anything by itself.",
  permission: 'payments.collect',
  deny: 'record payments',
  input: {
    ...STUDENT,
    amount: F.int(1, 1_000_000, 'Amount received in rupees'),
    method: F.oneOf(COUNTER_METHODS, 'How it was paid (default Cash)'),
    reference: F.text(40, 'UPI reference, cheque number or other reference (needed for anything except cash)'),
    feeType: F.text(40, 'Only apply to this kind of fee, for example Tuition Fee'),
  },
  required: ['amount'],
  run(args, staff) {
    const found = resolveStudent(args, 'propose_cash_payment');
    if (found.pick) return found.pick;
    const s = found.student;
    if (!s.active) throw new ToolError(`${s.name} is inactive. An admin must reactivate them before fees can be collected.`);
    const method = args.method ?? 'Cash';
    if (method !== 'Cash' && method !== 'Other' && !args.reference) {
      return {
        text: `What is the ${method === 'Cheque' ? 'cheque number' : method === 'UPI' ? 'UPI reference (UTR)' : 'payment reference'} for this ${method} payment?`,
        data: { needs: 'reference' },
        followUp: { tool: 'propose_cash_payment', args: { ...args, studentId: s.id, name: undefined }, need: 'reference' },
      };
    }
    applyLateFees();
    const due = dueSummary(s.id);
    let open = [...due.items, ...due.upcoming];
    if (args.feeType) {
      const word = args.feeType.toLowerCase().split(' ')[0];
      open = open.filter((i) => i.feeType.toLowerCase().includes(word));
      if (!open.length) throw new ToolError(`${s.name} has no unpaid ${args.feeType}.`);
    }
    const outstanding = sum(open, 'amount');
    if (!outstanding) throw new ToolError(`${s.name} has nothing outstanding, so there is nothing to record.`);
    if (args.amount > outstanding) {
      throw new ToolError(`${rupees(args.amount)} is more than everything ${s.name} owes${args.feeType ? ` for ${args.feeType}` : ''} (${rupees(outstanding)}). Record ${rupees(outstanding)}, and give the rest back as change.`);
    }
    const selected = [];
    let covered = 0;
    for (const item of open) {
      if (covered >= args.amount) break;
      selected.push(item);
      covered += item.amount;
    }
    const expectedTotal = covered;
    const part = args.amount < expectedTotal;
    // What stays due now once this is applied (upcoming instalments are not "due" yet).
    let left = args.amount;
    let appliedToDue = 0;
    for (const item of selected) {
      const take = Math.min(left, item.amount);
      if (due.items.includes(item)) appliedToDue += take;
      left -= take;
    }
    const balanceAfter = due.total - appliedToDue;
    const lines = [
      ['Student', s.name],
      ['Class', s.classLabel],
      ['Admission No.', s.admissionNo],
      ['Amount', rupees(args.amount)],
      ['Payment Mode', method.toUpperCase()],
      ...(args.reference ? [['Reference', args.reference]] : []),
      ['Collected By', staff.name],
      ['Fees still due after this', rupees(Math.max(0, balanceAfter))],
    ];
    const items = selected.map((i, n) =>
      part && n === selected.length - 1
        ? [`${i.title} (part payment; ${rupees(expectedTotal - args.amount)} of this fee stays due)`, i.amount - (expectedTotal - args.amount)]
        : [i.title, i.amount],
    );
    const label = method === 'Cash' ? 'Cash payment' : `${method} payment`;
    const card = createAction(staff, 'cash_payment', { studentId: s.id, feeItemIds: selected.map((i) => i.id), expectedTotal, amountReceived: args.amount, method, reference: args.reference ?? '' }, {
      title: `${label} of ${rupees(args.amount)} for ${s.name}`,
      lines,
      items,
      confirmLabel: 'Confirm payment',
      note: 'Only press Confirm if the money has been received. Once confirmed, the receipt is issued and the payment can only be corrected through an admin.',
    });
    return {
      text: `${label} of ${rupees(args.amount)} is ready to be recorded for ${s.name}. Do you want to proceed?`,
      data: { status: 'awaiting confirmation by the user', actionId: card.actionId, lines, fees: items.map(([t, a]) => `${t} ${rupees(a)}`) },
      cards: [card],
    };
  },
});

tool({
  name: 'propose_fee_type',
  kind: 'propose',
  description: 'Prepare a new fee type (for example Activity Fee) for the admin to CONFIRM. Does not add anything by itself.',
  permission: 'fees.manage',
  deny: 'change the fee structure',
  input: { name: F.text(40, 'Name of the new fee type') },
  required: ['name'],
  run(args, staff) {
    const name = args.name.replace(/\s+/g, ' ').trim();
    if (name.length < 2) throw new ToolError('Give the fee type a name, like “Activity Fee”.');
    const existing = listFeeTypes().find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (existing) throw new ToolError(`“${existing.name}” already exists.`);
    const card = createAction(staff, 'fee_type', { name }, { title: 'Add a fee type', lines: [['Fee Type', name]], confirmLabel: 'Confirm', note: 'The new type can then be used for fees in the Fee Structure.' });
    return { text: `You are about to add the fee type “${name}”. Confirm?`, data: { status: 'awaiting confirmation by the user', actionId: card.actionId, feeType: name }, cards: [card] };
  },
});

// Next 10th of a month within the session.
function defaultDueDate(session) {
  const today = todayIso();
  const { start, end } = sessionRange(session);
  let date = `${today.slice(0, 8)}10`;
  if (date < today) {
    const [y, m] = today.split('-').map(Number);
    date = `${m === 12 ? y + 1 : y}-${String((m % 12) + 1).padStart(2, '0')}-10`;
  }
  return date < start ? `${start.slice(0, 8)}10` : date > end ? end : date;
}

tool({
  name: 'propose_fee',
  kind: 'propose',
  description:
    'Prepare a new fee in the fee structure (for example Class 8 monthly Tuition Fee of ₹2,000) for the admin to CONFIRM. Shows the exact fee, its instalments and how many students it will be charged to. Does not add anything by itself.',
  permission: 'fees.manage',
  deny: 'change the fee structure',
  input: {
    feeType: F.text(40, 'Fee type, existing or new, for example Tuition Fee'),
    name: F.text(60, 'Fee name shown on receipts (default: the fee type)'),
    grade: F.grade('Class the fee is for; leave out for all classes'),
    amount: F.int(1, 1_000_000, 'Amount in rupees for each instalment'),
    frequency: F.oneOf(FREQUENCIES.filter((f) => f !== 'Custom'), 'How often it is charged'),
    firstDueDate: F.date('First due date (default: the next 10th of a month)'),
    lateFee: F.int(0, 100_000, 'Late fee in rupees (default 0)'),
    compulsory: F.bool('Charged to every student (true, default) or optional (false)'),
    transportOnly: F.bool('Only for students who use school transport'),
  },
  required: ['feeType', 'amount', 'frequency'],
  run(args, staff) {
    const session = currentSession();
    const types = listFeeTypes();
    const type = types.find((t) => t.name.toLowerCase() === args.feeType.toLowerCase()) ?? types.find((t) => t.name.toLowerCase() === `${args.feeType.toLowerCase()} fee`);
    const typeName = type?.name ?? args.feeType.replace(/\s+/g, ' ').trim();
    const { start, end } = sessionRange(session);
    const firstDueDate = args.firstDueDate ?? defaultDueDate(session);
    if (firstDueDate < start || firstDueDate > end) throw new ToolError(`The first due date must be within the ${session} session (${day(start)} to ${day(end)}).`);
    const compulsory = args.compulsory ?? true;
    const plan = instalments({ frequency: args.frequency, firstDueDate, session, schedule: [] });
    const students = compulsory
      ? db.prepare(`SELECT COUNT(*) AS n FROM students s JOIN classes c ON c.id = s.class_id WHERE s.active = 1 AND (? IS NULL OR c.grade = ?) AND (? = 0 OR s.transport = 1)`).get(args.grade ?? null, args.grade ?? null, args.transportOnly ? 1 : 0).n
      : 0;
    const lines = [
      ...(type ? [] : [['New fee type', `${typeName} (will be added)`]]),
      ['Fee Name', args.name ?? typeName],
      ['Class', args.grade ?? 'All classes'],
      ['Session', session],
      ['Amount', rupees(args.amount)],
      ['Frequency', args.frequency],
      ['First due date', day(firstDueDate)],
      ['Instalments', `${plan.length} (${plan.map((p) => p.period).slice(0, 6).join(', ')}${plan.length > 6 ? ', …' : ''})`],
      ['Late fee', args.lateFee ? rupees(args.lateFee) : 'None'],
      ['Compulsory / optional', `${compulsory ? 'Compulsory' : 'Optional'}${args.transportOnly ? ', transport students only' : ''}`],
      ['Charged to', compulsory ? `${plural(students, 'current student')} (${rupees(students * plan.length * args.amount)} in total)` : 'Students you add it to, from their page'],
    ];
    const card = createAction(
      staff,
      'fee',
      { feeType: typeName, newFeeType: !type, name: args.name ?? typeName, grade: args.grade ?? null, session, amount: args.amount, frequency: args.frequency, firstDueDate, lateFee: args.lateFee ?? 0, compulsory, transportOnly: Boolean(args.transportOnly) },
      { title: 'You are about to add a fee', lines, confirmLabel: 'Confirm', note: 'Existing payments and receipts are not affected.' },
    );
    return {
      text: `You are about to add: ${args.name ?? typeName}, ${args.grade ?? 'all classes'}, ${rupees(args.amount)}, ${args.frequency}. Confirm?`,
      data: { status: 'awaiting confirmation by the user', actionId: card.actionId, lines },
      cards: [card],
    };
  },
});

// ---- Running a tool -------------------------------------------------------------------------

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export const toolNames = () => [...BY_NAME.keys()];

// The tools a staff member may use, as Claude tool definitions.
export function toolsFor(staff) {
  return TOOLS.filter((t) => can(staff.role, t.permission)).map((t) => ({ name: t.name, description: t.description, input_schema: jsonSchema(t) }));
}

// Validates, checks permission and runs one tool. Returns { text, data, cards, followUp }.
export function executeTool(staff, name, input) {
  const definition = BY_NAME.get(String(name));
  if (!definition) throw new ToolError('The assistant cannot do that.');
  if (!can(staff.role, definition.permission)) {
    throw new ToolError(`Your account (${ROLES[staff.role] ?? staff.role}) cannot ${definition.deny}. Please ask the school admin.`);
  }
  const args = validate(definition, input ?? {});
  try {
    const result = definition.run(args, staff);
    return { cards: [], ...result };
  } catch (err) {
    if (err instanceof HttpError) throw new ToolError(err.message);
    throw err;
  }
}

export const isGrade = (value) => GRADES.includes(value);
