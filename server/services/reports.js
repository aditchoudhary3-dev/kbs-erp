import { db } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../http.js';
import { dayEnd, dayStart, searchPayments } from './payment-history.js';
import { dueHorizon, dueItems } from './fees.js';
import { getStudent, parentNames, studentCode } from './students.js';
import { GRADES, sectionName } from '../../shared/school.js';
import { academicMonths, addMonths, currentMonthKey, istDate, monthLongYear, todayIso } from '../../shared/format.js';

// Reports return one shape, used both on screen and for Excel/CSV export:
//   { title, filename, columns: [{ key, header, type }], rows, totals }
// Everything is computed from the payments ledger and fee items, so class-wise
// figures can never drift from the payments themselves.

const yearStartIso = () => dayStart(`${config.academicYear.start}-01`);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''));

function range({ from, to } = {}, defaultDays = 30) {
  const end = isDate(to) ? to : todayIso();
  const start = isDate(from) ? from : new Date(Date.parse(`${end}T00:00:00Z`) - (defaultDays - 1) * 86_400_000).toISOString().slice(0, 10);
  if (start > end) throw new HttpError(400, 'The start date is after the end date.');
  return { from: start, to: end, startIso: dayStart(start), endIso: dayEnd(end) };
}

const sumBy = (rows, key) => rows.reduce((t, r) => t + (Number(r[key]) || 0), 0);

// Each active student's money position for the academic year.
function studentMoney() {
  return db
    .prepare(
      `WITH dues AS (
         SELECT student_id, SUM(amount) AS pending, MIN(due_date) AS next_due,
                SUM(CASE WHEN due_date < :today THEN amount ELSE 0 END) AS overdue,
                GROUP_CONCAT(title, ' + ') AS titles
         FROM fee_items WHERE payment_id IS NULL AND due_date <= :horizon GROUP BY student_id),
       paid AS (
         SELECT student_id, SUM(amount) AS collected FROM payments
         WHERE status = 'confirmed' AND paid_at >= :yearStart GROUP BY student_id)
       SELECT s.id, s.name, s.admission_no, s.roll_no, s.parent_phone, s.father_name, s.mother_name, s.parent_name,
              c.id AS class_id, c.grade, c.section, c.sort_order,
              COALESCE(d.pending, 0) AS pending, d.next_due, COALESCE(d.overdue, 0) AS overdue, d.titles,
              COALESCE(p.collected, 0) AS collected
       FROM students s JOIN classes c ON c.id = s.class_id
       LEFT JOIN dues d ON d.student_id = s.id
       LEFT JOIN paid p ON p.student_id = s.id
       WHERE s.active = 1
       ORDER BY c.sort_order, s.roll_no`,
    )
    .all({ today: todayIso(), yearStart: yearStartIso(), horizon: dueHorizon() });
}

function tally(students) {
  return {
    totalStudents: students.length,
    paidStudents: students.filter((s) => s.pending === 0).length,
    pendingStudents: students.filter((s) => s.pending > 0).length,
    collected: sumBy(students, 'collected'),
    pending: sumBy(students, 'pending'),
    overdue: sumBy(students, 'overdue'),
  };
}

// ---- Class-wise summary ---------------------------------------------------------------

export function classSummary() {
  const students = studentMoney();
  const sections = db.prepare('SELECT id, grade, section FROM classes ORDER BY sort_order').all();
  return GRADES.map((grade) => {
    const inGrade = students.filter((s) => s.grade === grade);
    return {
      grade,
      ...tally(inGrade),
      sections: sections
        .filter((c) => c.grade === grade)
        .map((c) => ({
          classId: c.id,
          section: c.section,
          name: sectionName(c.grade, c.section),
          ...tally(inGrade.filter((s) => s.class_id === c.id)),
        })),
    };
  });
}

// ---- Dashboard ---------------------------------------------------------------------------

function collectedBetween(startIso, endIso) {
  const row = db
    .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount FROM payments WHERE status = 'confirmed' AND paid_at >= ? AND paid_at < ?")
    .get(startIso, endIso);
  return { count: row.count, amount: row.amount };
}

export function dashboard() {
  const today = todayIso();
  const month = currentMonthKey();
  const students = studentMoney();
  const money = tally(students);
  return {
    today,
    monthLabel: monthLongYear(month),
    todayCollection: collectedBetween(dayStart(today), dayEnd(today)),
    monthCollection: collectedBetween(dayStart(`${month}-01`), dayStart(`${addMonths(month, 1)}-01`)),
    yearCollection: collectedBetween(yearStartIso(), dayEnd(today)),
    students: { total: money.totalStudents, paid: money.paidStudents, pending: money.pendingStudents },
    pendingFees: { amount: money.pending, overdue: money.overdue, students: money.pendingStudents },
    recentPayments: searchPayments({}, { limit: 8 }).rows,
    classes: classSummary().map(({ sections, ...grade }) => grade),
  };
}

// ---- Reports ---------------------------------------------------------------------------

const MONEY = { type: 'money' };

export function dailyCollection(params) {
  const r = range(params, 30);
  const rows = db
    .prepare(
      `SELECT date(p.paid_at, '+330 minutes') AS day, COUNT(*) AS receipts,
              SUM(CASE WHEN o.channel = 'online' THEN p.amount ELSE 0 END) AS online,
              SUM(CASE WHEN o.channel = 'counter' THEN p.amount ELSE 0 END) AS counter,
              SUM(CASE WHEN p.method = 'Cash' THEN p.amount ELSE 0 END) AS cash,
              SUM(p.amount) AS total
       FROM payments p JOIN payment_orders o ON o.id = p.order_id
       WHERE p.status = 'confirmed' AND p.paid_at >= ? AND p.paid_at < ?
       GROUP BY day ORDER BY day DESC`,
    )
    .all(r.startIso, r.endIso);
  return {
    title: 'Daily collection',
    subtitle: `${r.from} to ${r.to}`,
    filename: `daily-collection-${r.from}-to-${r.to}`,
    range: r,
    columns: [
      { key: 'day', header: 'Date', type: 'date', width: 14 },
      { key: 'receipts', header: 'Receipts', type: 'number', width: 10 },
      { key: 'online', header: 'Online', ...MONEY, width: 14 },
      { key: 'counter', header: 'At counter', ...MONEY, width: 14 },
      { key: 'cash', header: 'of which cash', ...MONEY, width: 14 },
      { key: 'total', header: 'Total collected', ...MONEY, width: 16 },
    ],
    rows,
    totals: { day: 'Total', receipts: sumBy(rows, 'receipts'), online: sumBy(rows, 'online'), counter: sumBy(rows, 'counter'), cash: sumBy(rows, 'cash'), total: sumBy(rows, 'total') },
  };
}

export function monthlyCollection() {
  const data = new Map(
    db
      .prepare(
        `SELECT strftime('%Y-%m', p.paid_at, '+330 minutes') AS month, COUNT(*) AS receipts,
                SUM(CASE WHEN o.channel = 'online' THEN p.amount ELSE 0 END) AS online,
                SUM(CASE WHEN o.channel = 'counter' THEN p.amount ELSE 0 END) AS counter,
                SUM(p.amount) AS total
         FROM payments p JOIN payment_orders o ON o.id = p.order_id
         WHERE p.status = 'confirmed' AND p.paid_at >= ?
         GROUP BY month`,
      )
      .all(yearStartIso())
      .map((r) => [r.month, r]),
  );
  const current = currentMonthKey();
  const rows = academicMonths(config.academicYear.start)
    .filter((m) => m <= current)
    .map((m) => ({ month: monthLongYear(m), receipts: 0, online: 0, counter: 0, total: 0, ...(data.get(m) ?? {}), key: m }))
    .map(({ key, ...row }) => ({ ...row, month: monthLongYear(key) }))
    .reverse();
  return {
    title: 'Monthly collection',
    subtitle: `Academic year ${config.academicYear.label}`,
    filename: `monthly-collection-${config.academicYear.label.replace('–', '-')}`,
    columns: [
      { key: 'month', header: 'Month', width: 16 },
      { key: 'receipts', header: 'Receipts', type: 'number', width: 10 },
      { key: 'online', header: 'Online', ...MONEY, width: 14 },
      { key: 'counter', header: 'At counter', ...MONEY, width: 14 },
      { key: 'total', header: 'Total collected', ...MONEY, width: 16 },
    ],
    rows,
    totals: { month: 'Total', receipts: sumBy(rows, 'receipts'), online: sumBy(rows, 'online'), counter: sumBy(rows, 'counter'), total: sumBy(rows, 'total') },
  };
}

export function classCollection(params) {
  const r = range(params, 30);
  const collected = new Map(
    db
      .prepare(
        `SELECT s.class_id, COUNT(*) AS receipts, COUNT(DISTINCT p.student_id) AS students, SUM(p.amount) AS amount
         FROM payments p JOIN students s ON s.id = p.student_id
         WHERE p.status = 'confirmed' AND p.paid_at >= ? AND p.paid_at < ?
         GROUP BY s.class_id`,
      )
      .all(r.startIso, r.endIso)
      .map((row) => [row.class_id, row]),
  );
  const money = classSummary();
  const rows = money.flatMap((g) =>
    g.sections.map((sec) => ({
      grade: g.grade,
      section: sec.section,
      receipts: collected.get(sec.classId)?.receipts ?? 0,
      students: collected.get(sec.classId)?.students ?? 0,
      amount: collected.get(sec.classId)?.amount ?? 0,
      pending: sec.pending,
    })),
  );
  return {
    title: 'Class-wise collection',
    subtitle: `${r.from} to ${r.to}`,
    filename: `class-wise-collection-${r.from}-to-${r.to}`,
    range: r,
    columns: [
      { key: 'grade', header: 'Class', width: 12 },
      { key: 'section', header: 'Section', width: 9 },
      { key: 'receipts', header: 'Receipts', type: 'number', width: 10 },
      { key: 'students', header: 'Students who paid', type: 'number', width: 17 },
      { key: 'amount', header: 'Collected', ...MONEY, width: 14 },
      { key: 'pending', header: 'Still pending', ...MONEY, width: 14 },
    ],
    rows,
    totals: { grade: 'Total', receipts: sumBy(rows, 'receipts'), students: sumBy(rows, 'students'), amount: sumBy(rows, 'amount'), pending: sumBy(rows, 'pending') },
  };
}

export function modeReport(params) {
  const r = range(params, 30);
  const rows = db
    .prepare(
      `SELECT p.method AS mode,
              CASE WHEN o.channel = 'online' THEN 'Online' ELSE 'At counter' END AS channel,
              COUNT(*) AS receipts, SUM(p.amount) AS amount
       FROM payments p JOIN payment_orders o ON o.id = p.order_id
       WHERE p.status = 'confirmed' AND p.paid_at >= ? AND p.paid_at < ?
       GROUP BY p.method, o.channel ORDER BY amount DESC`,
    )
    .all(r.startIso, r.endIso);
  const total = sumBy(rows, 'amount');
  rows.forEach((row) => (row.share = total ? `${Math.round((row.amount / total) * 1000) / 10}%` : '0%'));
  return {
    title: 'Payment-mode report',
    subtitle: `${r.from} to ${r.to}`,
    filename: `payment-modes-${r.from}-to-${r.to}`,
    range: r,
    columns: [
      { key: 'mode', header: 'Payment mode', width: 16 },
      { key: 'channel', header: 'Where', width: 12 },
      { key: 'receipts', header: 'Receipts', type: 'number', width: 10 },
      { key: 'amount', header: 'Amount', ...MONEY, width: 14 },
      { key: 'share', header: 'Share', width: 9 },
    ],
    rows,
    totals: { mode: 'Total', receipts: sumBy(rows, 'receipts'), amount: total, share: rows.length ? '100%' : '' },
  };
}

export function pendingReport({ grade = '', section = '', overdueOnly = false } = {}) {
  const today = todayIso();
  const rows = studentMoney()
    .filter((s) => s.pending > 0)
    .filter((s) => !grade || s.grade === grade)
    .filter((s) => !section || s.section === section)
    .filter((s) => !overdueOnly || s.overdue > 0)
    .map((s) => ({
      studentId: studentCode(s.id),
      id: s.id,
      admissionNo: s.admission_no,
      name: s.name,
      className: sectionName(s.grade, s.section),
      grade: s.grade,
      section: s.section,
      parentNames: parentNames({ fatherName: s.father_name, motherName: s.mother_name, parentName: s.parent_name }),
      phone: s.parent_phone,
      details: s.titles,
      nextDue: s.next_due,
      pending: s.pending,
      overdue: s.overdue,
      status: s.next_due < today ? 'OVERDUE' : 'PENDING',
    }));
  const scope = [grade, section && `Section ${section}`].filter(Boolean).join(', ') || 'All classes';
  return {
    title: 'Pending fee report',
    subtitle: `${scope}${overdueOnly ? ' · overdue only' : ''} · as of ${today}`,
    filename: `pending-fees-${(grade || 'all').replace(/\s+/g, '-').toLowerCase()}${section ? `-${section}` : ''}-${today}`,
    columns: [
      // `screen: false` columns go to Excel/CSV only; `export: false` ones are screen only.
      { key: 'studentId', header: 'Student ID', width: 11, screen: false },
      { key: 'admissionNo', header: 'Admission Number', width: 17 },
      { key: 'name', header: 'Student Name', width: 22 },
      { key: 'className', header: 'Class', export: false },
      { key: 'grade', header: 'Class', width: 10, screen: false },
      { key: 'section', header: 'Section', width: 8, screen: false },
      { key: 'parentNames', header: "Father's/Mother's Name", width: 28 },
      { key: 'phone', header: 'Mobile', width: 13 },
      { key: 'details', header: 'Pending fees', width: 34 },
      { key: 'nextDue', header: 'Due date', type: 'date', width: 13 },
      { key: 'pending', header: 'Pending amount', ...MONEY, width: 15 },
      { key: 'overdue', header: 'Overdue amount', ...MONEY, width: 15 },
      { key: 'status', header: 'Status', width: 10 },
    ],
    rows,
    totals: { admissionNo: 'Total', name: `${rows.length} students`, pending: sumBy(rows, 'pending'), overdue: sumBy(rows, 'overdue') },
  };
}

export function studentHistory(studentId) {
  const student = getStudent(Number(studentId));
  if (!student) throw new HttpError(404, 'Student not found.');
  const { rows: payments } = searchPayments({ studentId: student.id }, { limit: 500 });
  const rows = payments.map((p) => ({
    day: istDate(p.at),
    at: p.at,
    receiptNo: p.receiptNo ?? '',
    method: p.method,
    txnId: p.txnId ?? '',
    amount: p.amount,
    status: p.status,
    collectedBy: p.collectedBy,
    paymentId: p.paymentId,
  }));
  const dues = dueItems(student.id);
  return {
    title: `Payment history: ${student.name}`,
    subtitle: `${student.admissionNo} · ${student.classLabel}`,
    filename: `payment-history-${student.admissionNo.replace(/\//g, '-')}`,
    student,
    dues,
    columns: [
      { key: 'day', header: 'Date', type: 'date', width: 13 },
      { key: 'receiptNo', header: 'Receipt Number', width: 20 },
      { key: 'method', header: 'Payment Mode', width: 13 },
      { key: 'txnId', header: 'Transaction ID', width: 22 },
      { key: 'amount', header: 'Amount', ...MONEY, width: 12 },
      { key: 'status', header: 'Payment Status', width: 14 },
      { key: 'collectedBy', header: 'Collected By', width: 22 },
    ],
    rows,
    totals: {
      day: 'Total paid',
      amount: sumBy(rows.filter((r) => r.status === 'PAID'), 'amount'),
      status: dues.length ? `${dues.length} fee(s) still due` : 'Nothing due',
    },
  };
}

// Every active student in a class (or all classes) with what they have paid
// this session and what is due: PAID, PENDING or OVERDUE.
export function classFeeStatus({ grade = '', section = '' } = {}) {
  if (grade && !GRADES.includes(grade)) throw new HttpError(400, 'Choose a class from Nursery to Class 12.');
  const today = todayIso();
  const rows = studentMoney()
    .filter((s) => !grade || s.grade === grade)
    .filter((s) => !section || s.section === section)
    .map((s) => ({
      studentId: studentCode(s.id),
      id: s.id,
      admissionNo: s.admission_no,
      name: s.name,
      className: sectionName(s.grade, s.section),
      grade: s.grade,
      section: s.section,
      parentNames: parentNames({ fatherName: s.father_name, motherName: s.mother_name, parentName: s.parent_name }),
      collected: s.collected,
      pending: s.pending,
      overdue: s.overdue,
      nextDue: s.next_due,
      status: s.pending === 0 ? 'PAID' : s.next_due < today ? 'OVERDUE' : 'PENDING',
    }));
  const scope = [grade || 'All classes', section && `Section ${section}`].filter(Boolean).join(', ');
  return {
    title: 'Class fee status',
    subtitle: `${scope} · session ${config.academicYear.label} · as of ${today}`,
    filename: `class-fee-status-${(grade || 'all').replace(/\s+/g, '-').toLowerCase()}${section ? `-${section}` : ''}-${today}`,
    columns: [
      { key: 'studentId', header: 'Student ID', width: 11, screen: false },
      { key: 'admissionNo', header: 'Admission Number', width: 17 },
      { key: 'name', header: 'Student Name', width: 22 },
      { key: 'className', header: 'Class', export: false },
      { key: 'grade', header: 'Class', width: 10, screen: false },
      { key: 'section', header: 'Section', width: 8, screen: false },
      { key: 'parentNames', header: "Father's/Mother's Name", width: 28 },
      { key: 'collected', header: 'Paid this session', ...MONEY, width: 16 },
      { key: 'pending', header: 'Pending', ...MONEY, width: 13 },
      { key: 'overdue', header: 'Overdue', ...MONEY, width: 13 },
      { key: 'nextDue', header: 'Due date', type: 'date', width: 13 },
      { key: 'status', header: 'Status', width: 10 },
    ],
    rows,
    totals: {
      admissionNo: 'Total',
      name: `${rows.length} students · ${rows.filter((r) => r.status === 'PAID').length} paid`,
      collected: sumBy(rows, 'collected'),
      pending: sumBy(rows, 'pending'),
      overdue: sumBy(rows, 'overdue'),
    },
  };
}

// Students who have not paid one kind of fee (for example Tuition Fee) that
// falls due in a month. If nothing of that kind falls due in the month, the
// instalments currently due are shown instead, and `note` says so.
export function unpaidFeeReport({ feeType = '', month = '', grade = '' } = {}) {
  const type = db.prepare('SELECT name FROM fee_types WHERE name = ?').get(String(feeType))?.name;
  if (!type) throw new HttpError(400, 'Choose a fee type.');
  const key = /^\d{4}-\d{2}$/.test(month) ? month : currentMonthKey();
  const from = `${key}-01`;
  const to = `${addMonths(key, 1)}-01`;
  const query = (dueClause) =>
    db
      .prepare(
        `SELECT f.title, f.amount, f.due_date, s.id, s.name, s.admission_no, s.father_name, s.mother_name, s.parent_name, c.grade, c.section
         FROM fee_items f JOIN students s ON s.id = f.student_id JOIN classes c ON c.id = s.class_id
         WHERE f.payment_id IS NULL AND s.active = 1 AND f.fee_type = ? AND ${dueClause} AND (? = '' OR c.grade = ?)
         ORDER BY c.sort_order, s.roll_no, f.due_date`,
      );
  let items = query('f.due_date >= ? AND f.due_date < ?').all(type, from, to, grade, grade);
  let note = '';
  if (!items.length) {
    const inMonth = db.prepare('SELECT 1 FROM fee_items WHERE fee_type = ? AND due_date >= ? AND due_date < ? LIMIT 1').get(type, from, to);
    if (!inMonth) {
      items = query('f.due_date <= ?').all(type, dueHorizon(), grade, grade);
      note = `No ${type} instalment falls due in ${monthLongYear(key)}, so this shows ${type} instalments due now.`;
    }
  }
  const today = todayIso();
  const rows = items.map((r) => ({
    studentId: studentCode(r.id),
    id: r.id,
    admissionNo: r.admission_no,
    name: r.name,
    className: sectionName(r.grade, r.section),
    grade: r.grade,
    section: r.section,
    parentNames: parentNames({ fatherName: r.father_name, motherName: r.mother_name, parentName: r.parent_name }),
    fee: r.title,
    dueDate: r.due_date,
    amount: r.amount,
    status: r.due_date < today ? 'OVERDUE' : 'PENDING',
  }));
  return {
    title: `${type} not paid`,
    subtitle: `${grade || 'All classes'} · ${note ? 'due now' : monthLongYear(key)}`,
    note,
    filename: `${type.replace(/\s+/g, '-').toLowerCase()}-not-paid-${(grade || 'all').replace(/\s+/g, '-').toLowerCase()}-${key}`,
    columns: [
      { key: 'studentId', header: 'Student ID', width: 11, screen: false },
      { key: 'admissionNo', header: 'Admission Number', width: 17 },
      { key: 'name', header: 'Student Name', width: 22 },
      { key: 'className', header: 'Class', export: false },
      { key: 'grade', header: 'Class', width: 10, screen: false },
      { key: 'section', header: 'Section', width: 8, screen: false },
      { key: 'parentNames', header: "Father's/Mother's Name", width: 28 },
      { key: 'fee', header: 'Fee', width: 26 },
      { key: 'dueDate', header: 'Due date', type: 'date', width: 13 },
      { key: 'amount', header: 'Amount', ...MONEY, width: 12 },
      { key: 'status', header: 'Status', width: 10 },
    ],
    rows,
    totals: { admissionNo: 'Total', name: `${new Set(rows.map((r) => r.id)).size} students`, amount: sumBy(rows, 'amount') },
  };
}

export const REPORTS = {
  daily: dailyCollection,
  monthly: monthlyCollection,
  'class-wise': classCollection,
  modes: modeReport,
  pending: pendingReport,
  'class-fees': classFeeStatus,
  'unpaid-fee': unpaidFeeReport,
};
