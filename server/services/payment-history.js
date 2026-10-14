import { db } from '../db.js';
import { HttpError } from '../http.js';
import { receiptData } from './receipts.js';
import { messageFor, whatsappState } from './whatsapp.js';
import { getOrder } from './payments.js';
import { studentCode, parentNames } from './students.js';
import { classLabel, sectionName } from '../../shared/school.js';
import { formatTime, istDate } from '../../shared/format.js';

// Payment history: every attempt to pay (online checkout or counter), with
// status PAID, PENDING or FAILED, searchable and exportable.

export const STATUSES = ['PAID', 'PENDING', 'FAILED', 'CANCELLED'];

const BASE = `
  FROM payment_orders o
  JOIN students s ON s.id = o.student_id
  JOIN classes c ON c.id = s.class_id
  LEFT JOIN payments p ON p.order_id = o.id
  LEFT JOIN whatsapp_messages w ON w.payment_id = p.id`;

const like = (text) => `%${String(text).trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

// India-time day boundaries as UTC timestamps.
export const dayStart = (date) => new Date(`${date}T00:00:00+05:30`).toISOString();
export const dayEnd = (date) => new Date(new Date(`${date}T00:00:00+05:30`).getTime() + 86_400_000).toISOString();
const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''));

function filterSql(f = {}) {
  const where = ["o.status != 'cancelled'"];
  const args = [];
  const add = (sql, ...values) => {
    where.push(sql);
    args.push(...values);
  };

  if (f.q) {
    const text = like(f.q);
    add(
      `(s.name LIKE ? ESCAPE '\\' OR s.admission_no LIKE ? ESCAPE '\\' OR p.receipt_no LIKE ? ESCAPE '\\'
        OR p.txn_id LIKE ? ESCAPE '\\' OR o.gateway_order_id LIKE ? ESCAPE '\\')`,
      text, text, text, text, text,
    );
  }
  if (f.studentName) add("s.name LIKE ? ESCAPE '\\'", like(f.studentName));
  if (f.admissionNo) add("s.admission_no LIKE ? ESCAPE '\\'", like(f.admissionNo));
  if (f.receiptNo) add("p.receipt_no LIKE ? ESCAPE '\\'", like(f.receiptNo));
  if (f.txnId) add("(p.txn_id LIKE ? ESCAPE '\\' OR o.gateway_order_id LIKE ? ESCAPE '\\')", like(f.txnId), like(f.txnId));
  if (f.studentId) add('s.id = ?', Number(f.studentId));
  if (f.grade) add('c.grade = ?', String(f.grade));
  if (f.section) add('c.section = ?', String(f.section));
  if (f.classId) add('c.id = ?', Number(f.classId));
  if (f.mode) add('p.method = ?', String(f.mode));
  if (f.channel) add('o.channel = ?', String(f.channel));
  if (isDate(f.from)) add('COALESCE(p.paid_at, o.created_at) >= ?', dayStart(f.from));
  if (isDate(f.to)) add('COALESCE(p.paid_at, o.created_at) < ?', dayEnd(f.to));
  if (f.status === 'PAID') add("p.id IS NOT NULL AND p.status = 'confirmed'");
  else if (f.status === 'CANCELLED') add("p.status = 'reversed'");
  else if (f.status === 'FAILED') add("p.id IS NULL AND o.status = 'failed'");
  else if (f.status === 'PENDING') add("p.id IS NULL AND o.status = 'created'");
  if (f.receiptsOnly) add('p.id IS NOT NULL');
  if (f.collectedBy) add('p.collected_by_staff_id = ?', Number(f.collectedBy));
  return { where: where.join(' AND '), args };
}

const statusOf = (row) =>
  row.payment_id ? (row.payment_status === 'reversed' ? 'CANCELLED' : 'PAID') : row.order_status === 'failed' ? 'FAILED' : 'PENDING';

function toRow(row) {
  const paid = Boolean(row.payment_id);
  return {
    orderId: row.order_id,
    paymentId: row.payment_id,
    status: statusOf(row),
    channel: row.channel,
    amount: paid ? row.paid_amount : row.order_amount,
    receiptNo: row.receipt_no,
    txnId: row.txn_id ?? row.gateway_order_id,
    method: row.method ?? (row.channel === 'online' ? 'Online' : '—'),
    at: row.paid_at ?? row.created_at,
    collectedBy: row.collected_by ?? '',
    failureReason: row.failure_reason,
    reviewNote: row.review_note,
    whatsappStatus: row.wa_status,
    whatsapp: paid ? whatsappState(row.wa_status, row.wa_attempts ?? 0) : null,
    correctionPending: Boolean(row.correction_pending),
    reversalReason: row.reversal_reason,
    student: {
      id: row.student_id,
      name: row.student_name,
      admissionNo: row.admission_no,
      grade: row.grade,
      section: row.section,
      className: sectionName(row.grade, row.section),
      classLabel: classLabel(row.grade, row.section),
    },
  };
}

const SELECT = `
  SELECT o.id AS order_id, o.status AS order_status, o.channel, o.gateway, o.gateway_order_id, o.amount AS order_amount,
         o.created_at, o.failure_reason, o.fee_item_ids,
         p.id AS payment_id, p.receipt_no, p.txn_id, p.method, p.paid_at, p.collected_by, p.review_note,
         p.amount AS paid_amount, p.receipt_snapshot, p.status AS payment_status, p.reversal_reason,
         (SELECT 1 FROM payment_corrections pc WHERE pc.payment_id = p.id AND pc.status = 'pending') AS correction_pending,
         s.id AS student_id, s.name AS student_name, s.admission_no, s.father_name, s.mother_name, s.parent_name,
         c.grade, c.section, w.status AS wa_status, w.attempts AS wa_attempts`;

export function searchPayments(filters = {}, { limit = 50, offset = 0 } = {}) {
  const { where, args } = filterSql(filters);
  const rows = db
    .prepare(`${SELECT} ${BASE} WHERE ${where} ORDER BY COALESCE(p.paid_at, o.created_at) DESC, o.id DESC LIMIT ? OFFSET ?`)
    .all(...args, Math.min(Number(limit) || 50, 500), Number(offset) || 0)
    .map(toRow);
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN p.status = 'confirmed' THEN p.amount ELSE 0 END), 0) AS paid_amount,
              SUM(CASE WHEN p.status = 'confirmed' THEN 1 ELSE 0 END) AS paid_count ${BASE} WHERE ${where}`,
    )
    .get(...args);
  return { rows, total: totals.count, paidCount: totals.paid_count ?? 0, paidAmount: totals.paid_amount };
}

// Everything the clerk sees for one confirmed payment.
export function paymentDetails(paymentId) {
  const receipt = receiptData(paymentId);
  const row = db
    .prepare('SELECT order_id, verified_via, verified_at, gateway, gateway_payment_id, collected_by_staff_id, amount_received FROM payments WHERE id = ?')
    .get(paymentId);
  const order = getOrder(row.order_id);
  return {
    paymentId,
    status: receipt.status,
    statusLabel: receipt.statusLabel,
    reversedAt: receipt.reversedAt,
    reversalReason: receipt.reversalReason,
    replacesReceiptNo: receipt.replacesReceiptNo ?? null,
    collectedByStaffId: row.collected_by_staff_id,
    amountReceived: row.amount_received,
    change: row.amount_received ? row.amount_received - receipt.total : 0,
    receiptNo: receipt.receiptNo,
    amount: receipt.total,
    method: receipt.method,
    txnId: receipt.txnId,
    paidAt: receipt.paidAt,
    collectedBy: receipt.collectedBy,
    channel: order?.channel ?? 'counter',
    gateway: row.gateway,
    gatewayOrderId: receipt.gatewayOrderId,
    gatewayPaymentId: row.gateway_payment_id,
    verifiedVia: row.verified_via,
    verifiedAt: row.verified_at,
    reviewNote: receipt.reviewNote,
    items: receipt.items,
    student: { ...receipt.student, id: receipt.studentId },
    whatsapp: messageFor(paymentId),
    urls: {
      receipt: `/receipts/${paymentId}`,
      pdf: `/api/payments/${paymentId}/receipt.pdf`,
      schoolCopy: `/receipts/${paymentId}?copy=school`,
      parentCopy: `/receipts/${paymentId}?copy=parent`,
      schoolCopyPdf: `/api/payments/${paymentId}/receipt.pdf?copy=school`,
      parentCopyPdf: `/api/payments/${paymentId}/receipt.pdf?copy=parent`,
    },
  };
}

export function orderStatus(orderId) {
  const order = getOrder(orderId);
  if (!order) throw new HttpError(404, 'Payment order not found.');
  const payment = db.prepare('SELECT id FROM payments WHERE order_id = ?').get(orderId);
  return { orderId, status: payment ? 'PAID' : order.status === 'failed' ? 'FAILED' : 'PENDING', paymentId: payment?.id ?? null, failureReason: order.failureReason };
}

// ---- The Excel fee register ------------------------------------------------------------

export const REGISTER_COLUMNS = [
  { key: 'studentId', header: 'Student ID', width: 11 },
  { key: 'admissionNo', header: 'Admission Number', width: 17 },
  { key: 'studentName', header: 'Student Name', width: 22 },
  { key: 'parentNames', header: "Father's/Mother's Name", width: 30 },
  { key: 'grade', header: 'Class', width: 10 },
  { key: 'section', header: 'Section', width: 8 },
  { key: 'feeType', header: 'Fee Type', width: 15 },
  { key: 'feeDetails', header: 'Fee Details', width: 22 },
  { key: 'amount', header: 'Amount', type: 'money', width: 11 },
  { key: 'method', header: 'Payment Mode', width: 13 },
  { key: 'txnId', header: 'Transaction ID', width: 22 },
  { key: 'date', header: 'Payment Date', type: 'date', width: 13 },
  { key: 'time', header: 'Payment Time', width: 12 },
  { key: 'status', header: 'Payment Status', width: 15 },
  { key: 'receiptNo', header: 'Receipt Number', width: 20 },
  { key: 'collectedBy', header: 'Collected By', width: 22 },
];

// One row per fee line, oldest first. Paid rows use the frozen receipt, so the
// register always matches the receipts that were issued.
export function registerRows(filters = {}) {
  const { where, args } = filterSql(filters);
  const rows = db.prepare(`${SELECT} ${BASE} WHERE ${where} ORDER BY COALESCE(p.paid_at, o.created_at), o.id`).all(...args);
  const feeItem = db.prepare('SELECT title, fee_type, amount FROM fee_items WHERE id = ?');
  const lines = [];

  for (const row of rows) {
    if (row.payment_id) {
      const receipt = JSON.parse(row.receipt_snapshot);
      for (const item of receipt.items) {
        lines.push({
          studentId: studentCode(row.student_id),
          admissionNo: receipt.student.admissionNo,
          studentName: receipt.student.name,
          parentNames: receipt.student.parentNames,
          grade: receipt.student.grade,
          section: receipt.student.section,
          feeType: item.feeType,
          feeDetails: item.title,
          amount: item.amount,
          method: row.method,
          txnId: row.txn_id,
          date: istDate(row.paid_at),
          time: formatTime(row.paid_at),
          status: row.payment_status === 'reversed' ? 'CANCELLED' : 'PAID',
          receiptNo: row.receipt_no,
          collectedBy: row.collected_by,
        });
      }
    } else {
      const status = statusOf(row);
      for (const id of JSON.parse(row.fee_item_ids)) {
        const item = feeItem.get(id);
        if (!item) continue;
        lines.push({
          studentId: studentCode(row.student_id),
          admissionNo: row.admission_no,
          studentName: row.student_name,
          parentNames: parentNames({ fatherName: row.father_name, motherName: row.mother_name, parentName: row.parent_name }),
          grade: row.grade,
          section: row.section,
          feeType: item.fee_type,
          feeDetails: item.title,
          amount: item.amount,
          method: row.channel === 'online' ? 'Online' : '',
          txnId: row.gateway_order_id ?? '',
          date: istDate(row.created_at),
          time: formatTime(row.created_at),
          status,
          receiptNo: '',
          collectedBy: '',
        });
      }
    }
  }
  return lines;
}

// Confirmed payments for one student, newest first (parent app history).
export function studentPayments(studentId) {
  return db
    .prepare("SELECT id, amount, method, receipt_no, paid_at, receipt_snapshot FROM payments WHERE student_id = ? AND status = 'confirmed' ORDER BY paid_at DESC, id DESC")
    .all(studentId)
    .map((p) => {
      const items = JSON.parse(p.receipt_snapshot).items;
      return {
        id: p.id,
        amount: p.amount,
        method: p.method,
        receiptNo: p.receipt_no,
        paidAt: p.paid_at,
        items,
        description: items.map((i) => i.title).join(' + '),
      };
    });
}
