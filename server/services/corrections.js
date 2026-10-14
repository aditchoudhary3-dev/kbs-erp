import { db, nowIso, transaction } from '../db.js';
import { HttpError } from '../http.js';
import { audit } from '../audit.js';
import { COUNTER_METHODS, issueReplacementTx, reversePaymentTx } from './payments.js';

// Corrections to completed payments. A clerk cannot change a payment; they
// ask for a correction and an admin approves or rejects it. Approval never
// edits or deletes the original: it is reversed (kept, marked CANCELLED) and,
// for a change of details, a replacement receipt is issued.

export const KINDS = {
  cancel: 'Cancel this payment (fees become due again)',
  change_details: 'Correct the payment mode or reference',
};

function toCorrection(row) {
  return {
    id: row.id,
    paymentId: row.payment_id,
    receiptNo: row.receipt_no,
    amount: row.amount,
    method: row.method,
    studentName: row.student_name,
    kind: row.kind,
    kindLabel: KINDS[row.kind],
    reason: row.reason,
    requestedChanges: row.requested_changes ? JSON.parse(row.requested_changes) : null,
    status: row.status,
    requestedBy: row.requested_by_name,
    requestedById: row.requested_by,
    requestedAt: row.requested_at,
    decidedBy: row.decided_by_name,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
    replacementPaymentId: row.replacement_payment_id,
  };
}

const SELECT = `
  SELECT c.*, p.receipt_no, p.amount, p.method, s.name AS student_name,
         r.name AS requested_by_name, d.name AS decided_by_name
  FROM payment_corrections c
  JOIN payments p ON p.id = c.payment_id
  JOIN students s ON s.id = p.student_id
  JOIN staff r ON r.id = c.requested_by
  LEFT JOIN staff d ON d.id = c.decided_by`;

export function listCorrections({ status = '', requestedBy = null } = {}) {
  const where = ['1 = 1'];
  const args = [];
  if (status) {
    where.push('c.status = ?');
    args.push(status);
  }
  if (requestedBy) {
    where.push('c.requested_by = ?');
    args.push(requestedBy);
  }
  return db.prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY c.status = 'pending' DESC, c.id DESC LIMIT 200`).all(...args).map(toCorrection);
}

export const pendingCount = () => db.prepare("SELECT COUNT(*) AS n FROM payment_corrections WHERE status = 'pending'").get().n;

export function correctionsForPayment(paymentId) {
  return db.prepare(`${SELECT} WHERE c.payment_id = ? ORDER BY c.id DESC`).all(paymentId).map(toCorrection);
}

export function requestCorrection(paymentId, { kind, reason, method, reference }, staff) {
  const payment = db.prepare('SELECT id, status, method, receipt_no FROM payments WHERE id = ?').get(paymentId);
  if (!payment) throw new HttpError(404, 'Payment not found.');
  if (payment.status !== 'confirmed') throw new HttpError(409, 'This payment has already been cancelled.');
  if (!KINDS[kind]) throw new HttpError(400, 'Choose what needs correcting.');
  const why = String(reason ?? '').trim();
  if (why.length < 5 || why.length > 500) throw new HttpError(400, 'Explain what went wrong (at least a few words).');

  let changes = null;
  if (kind === 'change_details') {
    const newMethod = method ? String(method) : null;
    const newReference = String(reference ?? '').trim() || null;
    if (newMethod && !COUNTER_METHODS.includes(newMethod) && !['UPI', 'Card', 'Net banking'].includes(newMethod)) {
      throw new HttpError(400, 'Choose a valid payment mode.');
    }
    if (!newMethod && !newReference) throw new HttpError(400, 'Enter the correct payment mode or reference.');
    if (newReference && newReference.length > 40) throw new HttpError(400, 'The reference is too long.');
    changes = { method: newMethod, reference: newReference };
  }

  const open = db.prepare("SELECT id FROM payment_corrections WHERE payment_id = ? AND status = 'pending'").get(paymentId);
  if (open) throw new HttpError(409, 'A correction for this payment is already waiting for the admin.');

  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO payment_corrections (payment_id, kind, reason, requested_changes, status, requested_by, requested_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(paymentId, kind, why, changes ? JSON.stringify(changes) : null, staff.id, nowIso());
  audit(staff, 'correction.requested', { entity: 'payment', entityId: paymentId, details: { receiptNo: payment.receipt_no, kind, reason: why, changes } });
  return toCorrection(db.prepare(`${SELECT} WHERE c.id = ?`).get(Number(lastInsertRowid)));
}

export function decideCorrection(id, { approve, note }, admin) {
  const row = db.prepare('SELECT * FROM payment_corrections WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'Correction request not found.');
  if (row.status !== 'pending') throw new HttpError(409, 'This request has already been decided.');
  const decisionNote = String(note ?? '').trim().slice(0, 500) || null;

  return transaction(() => {
    let replacementId = null;
    if (approve) {
      const reason = `Correction #${id}: ${row.reason}`;
      const { payment, feeItemIds } = reversePaymentTx(row.payment_id, { reason, actor: admin });
      if (row.kind === 'change_details') {
        const changes = JSON.parse(row.requested_changes);
        replacementId = issueReplacementTx(payment, feeItemIds, { method: changes.method, reference: changes.reference, actor: admin }).paymentId;
      }
    }
    db.prepare(
      `UPDATE payment_corrections SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, replacement_payment_id = ? WHERE id = ?`,
    ).run(approve ? 'approved' : 'rejected', admin.id, nowIso(), decisionNote, replacementId, id);
    audit(admin, approve ? 'correction.approved' : 'correction.rejected', {
      entity: 'payment',
      entityId: row.payment_id,
      details: { correctionId: id, kind: row.kind, note: decisionNote, replacementPaymentId: replacementId },
    });
    return toCorrection(db.prepare(`${SELECT} WHERE c.id = ?`).get(id));
  });
}
