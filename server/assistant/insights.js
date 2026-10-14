import { db } from '../db.js';
import { config } from '../config.js';
import { can } from '../permissions.js';
import { dueHorizon } from '../services/fees.js';
import { dayEnd, dayStart } from '../services/payment-history.js';
import { whatsappState } from '../services/whatsapp.js';
import { rupees, todayIso } from '../../shared/format.js';

// "KBS AI Daily Summary": today's position, worked out from the database
// each time it is asked for. Every number comes from a query below.

const shift = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

function collection(date) {
  const rows = db
    .prepare(
      `SELECT p.amount, p.method, o.channel FROM payments p JOIN payment_orders o ON o.id = p.order_id
       WHERE p.status = 'confirmed' AND p.paid_at >= ? AND p.paid_at < ?`,
    )
    .all(dayStart(date), dayEnd(date));
  const total = (list) => list.reduce((t, r) => t + r.amount, 0);
  return {
    amount: total(rows),
    count: rows.length,
    cash: total(rows.filter((r) => r.method === 'Cash')),
    online: total(rows.filter((r) => r.channel === 'online')),
    otherCounter: total(rows.filter((r) => r.channel !== 'online' && r.method !== 'Cash')),
  };
}

export function dailySummary(staff) {
  const today = todayIso();
  const now = Date.now();
  const todays = collection(today);
  const yesterday = collection(shift(today, -1));

  const failedToday = db
    .prepare("SELECT COUNT(*) AS n FROM payment_orders WHERE channel = 'online' AND status = 'failed' AND updated_at >= ? AND updated_at < ?")
    .get(dayStart(today), dayEnd(today)).n;
  const unfinished = db
    .prepare("SELECT COUNT(*) AS n FROM payment_orders WHERE channel = 'online' AND status = 'created' AND created_at < ? AND created_at > ?")
    .get(new Date(now - config.payments.reconcileAfterMinutes * 60_000).toISOString(), new Date(now - 3 * 86_400_000).toISOString()).n;

  const accounts = db
    .prepare(
      `SELECT COUNT(DISTINCT f.student_id) AS students, COALESCE(SUM(f.amount), 0) AS amount,
              COUNT(DISTINCT CASE WHEN f.due_date < :today THEN f.student_id END) AS overdueStudents,
              COALESCE(SUM(CASE WHEN f.due_date < :today THEN f.amount ELSE 0 END), 0) AS overdue
       FROM fee_items f JOIN students s ON s.id = f.student_id
       WHERE f.payment_id IS NULL AND s.active = 1 AND f.due_date <= :horizon`,
    )
    .get({ today, horizon: dueHorizon() });

  // Parent copies of receipts from the last 7 days not yet sent on WhatsApp.
  const messages = db
    .prepare(
      `SELECT w.status, w.attempts FROM payments p LEFT JOIN whatsapp_messages w ON w.payment_id = p.id
       WHERE p.status = 'confirmed' AND p.paid_at >= ?`,
    )
    .all(new Date(now - 7 * 86_400_000).toISOString())
    .map((m) => whatsappState(m.status, m.attempts ?? 0).state);
  const whatsapp = { pending: messages.filter((s) => s === 'PENDING').length, failed: messages.filter((s) => s === 'FAILED').length };

  const seesCorrections = can(staff.role, 'corrections.approve');
  const corrections = seesCorrections
    ? db.prepare("SELECT COUNT(*) AS n FROM payment_corrections WHERE status = 'pending'").get().n
    : db.prepare("SELECT COUNT(*) AS n FROM payment_corrections WHERE status = 'pending' AND requested_by = ?").get(staff.id).n;
  const review = db.prepare("SELECT COUNT(*) AS n FROM payments WHERE review_note IS NOT NULL AND status = 'confirmed'").get().n;

  const issues = [];
  if (failedToday) issues.push({ tone: 'danger', text: `${plural(failedToday, 'online payment')} failed today`, href: `/admin/payments?status=FAILED&from=${today}&to=${today}` });
  if (unfinished) issues.push({ tone: 'warn', text: `${plural(unfinished, 'online payment')} started but not finished (checked with the gateway automatically)`, href: '/admin/payments?status=PENDING' });
  if (whatsapp.failed) issues.push({ tone: 'danger', text: `${plural(whatsapp.failed, 'WhatsApp receipt')} could not be sent`, href: '/admin/receipts' });
  if (whatsapp.pending) issues.push({ tone: 'warn', text: `${plural(whatsapp.pending, 'parent copy', 'parent copies')} not yet sent on WhatsApp (last 7 days)`, href: '/admin/receipts' });
  if (corrections) issues.push({ tone: 'warn', text: seesCorrections ? `${plural(corrections, 'payment correction')} waiting for your approval` : `${plural(corrections, 'correction request')} of yours waiting for the admin`, href: '/admin/corrections' });
  if (review) issues.push({ tone: 'warn', text: `${plural(review, 'payment')} paid twice for the same fees (needs review)`, href: '/admin/payments' });
  if (accounts.overdueStudents) issues.push({ tone: 'info', text: `${plural(accounts.overdueStudents, 'student')} with overdue fees (${rupees(accounts.overdue)})`, href: '/admin/reports?report=pending&overdueOnly=true' });

  const share = todays.amount ? Math.round((todays.online / todays.amount) * 100) : 0;
  const trend = yesterday.amount
    ? todays.amount >= yesterday.amount
      ? `, up from ${rupees(yesterday.amount)} yesterday`
      : `, against ${rupees(yesterday.amount)} yesterday`
    : '';
  const headline = todays.count
    ? `${rupees(todays.amount)} collected today from ${plural(todays.count, 'payment')} (${share}% online)${trend}. ${plural(accounts.students, 'student')} ${accounts.students === 1 ? 'has' : 'have'} fees pending.`
    : `No payments yet today. ${plural(accounts.students, 'student')} ${accounts.students === 1 ? 'has' : 'have'} fees pending (${rupees(accounts.amount)}).`;

  return {
    date: today,
    headline,
    collection: todays,
    yesterday: { amount: yesterday.amount, count: yesterday.count },
    failedPayments: failedToday,
    unfinishedPayments: unfinished,
    pendingAccounts: { students: accounts.students, amount: accounts.amount, overdueStudents: accounts.overdueStudents, overdue: accounts.overdue },
    whatsapp,
    corrections,
    issues,
  };
}
