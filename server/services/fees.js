import { db, transaction } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../http.js';
import { sendSms } from '../sms.js';
import { formatDate, rupees, todayIso } from '../../shared/format.js';

// A student's dues. Fee items come from the fee structure (see
// fee-structure.js). An item is "due" once it is within the due window
// (config.fees.dueWindowDays) or overdue; later instalments are "upcoming".

const sum = (rows) => rows.reduce((total, r) => total + r.amount, 0);

export function dueHorizon(today = todayIso()) {
  return new Date(Date.parse(`${today}T00:00:00Z`) + config.fees.dueWindowDays * 86_400_000).toISOString().slice(0, 10);
}

const toItem = (f) => ({
  id: f.id,
  title: f.title,
  feeType: f.fee_type,
  amount: f.amount,
  dueDate: f.due_date,
  period: f.period,
  lateFeeFor: f.late_fee_for,
});

export function dueItems(studentId, { includeUpcoming = false } = {}) {
  return db
    .prepare(
      `SELECT id, title, fee_type, amount, due_date, period, late_fee_for FROM fee_items
       WHERE student_id = ? AND payment_id IS NULL AND (? OR due_date <= ?)
       ORDER BY due_date, late_fee_for IS NOT NULL, id`,
    )
    .all(studentId, includeUpcoming ? 1 : 0, dueHorizon())
    .map(toItem);
}

export function upcomingItems(studentId) {
  return db
    .prepare(
      `SELECT id, title, fee_type, amount, due_date, period, late_fee_for FROM fee_items
       WHERE student_id = ? AND payment_id IS NULL AND due_date > ? ORDER BY due_date, id`,
    )
    .all(studentId, dueHorizon())
    .map(toItem);
}

export function dueSummary(studentId) {
  const items = dueItems(studentId);
  const upcoming = upcomingItems(studentId);
  const dueDate = items[0]?.dueDate ?? null;
  return {
    items,
    total: sum(items),
    dueDate,
    overdue: dueDate !== null && dueDate < todayIso(),
    upcoming,
    upcomingTotal: sum(upcoming),
  };
}

// One row per active student with anything due, optionally for a class section or grade.
export function outstanding({ classId = null, grade = null } = {}) {
  return db
    .prepare(
      `SELECT s.id, s.name, s.roll_no, s.admission_no, s.parent_phone, c.id AS class_id, c.name AS class_name,
              c.grade, c.section, SUM(f.amount) AS total, MIN(f.due_date) AS due_date,
              GROUP_CONCAT(f.title, ' + ') AS titles
       FROM fee_items f
       JOIN students s ON s.id = f.student_id
       JOIN classes c ON c.id = s.class_id
       WHERE f.payment_id IS NULL AND f.due_date <= ? AND s.active = 1
         AND (? IS NULL OR s.class_id = ?) AND (? IS NULL OR c.grade = ?)
       GROUP BY s.id
       ORDER BY due_date, c.sort_order, s.roll_no`,
    )
    .all(dueHorizon(), classId, classId, grade, grade)
    .map((r) => ({
      studentId: r.id,
      name: r.name,
      rollNo: r.roll_no,
      admissionNo: r.admission_no,
      parentPhone: r.parent_phone,
      classId: r.class_id,
      className: r.class_name,
      grade: r.grade,
      section: r.section,
      total: r.total,
      dueDate: r.due_date,
      titles: r.titles,
      overdue: r.due_date < todayIso(),
    }));
}

export function classFeeBanner(classId) {
  const rows = outstanding({ classId });
  if (!rows.length) return null;
  return {
    families: new Set(rows.map((r) => r.parentPhone)).size,
    dueDate: rows.reduce((min, r) => (r.dueDate < min ? r.dueDate : min), rows[0].dueDate),
  };
}

export function sendReminders({ classId = null, grade = null } = {}) {
  const families = new Map();
  for (const row of outstanding({ classId, grade })) {
    const family = families.get(row.parentPhone) ?? [];
    family.push(row);
    families.set(row.parentPhone, family);
  }

  for (const [phone, rows] of families) {
    const total = rows.reduce((t, r) => t + r.total, 0);
    const dueDate = rows.reduce((min, r) => (r.dueDate < min ? r.dueDate : min), rows[0].dueDate);
    const names = rows.map((r) => `${r.name} (${r.className})`).join(' and ');
    const when = dueDate < todayIso() ? `were due on ${formatDate(dueDate)}` : `are due by ${formatDate(dueDate)}`;
    sendSms(
      phone,
      'reminder',
      `Reminder: fees of ${rupees(total)} for ${names} ${when}. Pay in the ${config.school.shortName} app. – ${config.school.name}`,
    );
  }
  return { families: families.size };
}

// Removes an unpaid fee item for one student (a waiver), with its late fee.
// Paid items can never be removed.
export function waiveFeeItem(feeItemId) {
  const item = db.prepare('SELECT * FROM fee_items WHERE id = ?').get(feeItemId);
  if (!item) throw new HttpError(404, 'Fee item not found.');
  if (item.payment_id !== null) throw new HttpError(409, 'This fee has been paid, so it cannot be removed.');
  return transaction(() => {
    const lateFee = db.prepare('SELECT id, payment_id FROM fee_items WHERE late_fee_for = ?').get(feeItemId);
    if (lateFee?.payment_id) {
      // The late fee was already paid: keep it, just unlink it from the waived item.
      db.prepare('UPDATE fee_items SET late_fee_for = NULL WHERE id = ?').run(lateFee.id);
    } else if (lateFee) {
      db.prepare('DELETE FROM fee_items WHERE id = ?').run(lateFee.id);
    }
    db.prepare('DELETE FROM fee_items WHERE id = ? AND payment_id IS NULL').run(feeItemId);
    return { id: item.id, studentId: item.student_id, title: item.title, amount: item.amount };
  });
}
