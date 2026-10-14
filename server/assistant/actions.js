import { db, nowIso, transaction } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../http.js';
import { audit, auditVia } from '../audit.js';
import { can } from '../permissions.js';
import { recordCounterPayment } from '../services/payments.js';
import { createFeeType, createStructure, listFeeTypes } from '../services/fee-structure.js';
import { paymentDetails } from '../services/payment-history.js';
import { prepareReceiptMessage } from '../services/whatsapp.js';
import { getStudent } from '../services/students.js';
import { rupees } from '../../shared/format.js';

// Changes prepared by the KBS AI Assistant ("proposals").
//
// A proposal stores exactly what will happen and is shown with CONFIRM and
// CANCEL. Only the staff member who asked can confirm it, only while it is
// fresh, and only if their role still allows it. The change then runs
// through the same services as the normal screens, in one transaction, and
// is written to the audit log as done by that person via the assistant.

export const AGENT = config.assistant.name;

const KINDS = {
  cash_payment: {
    permission: 'payments.collect',
    action: 'ai.payment_recorded',
    run(p, staff, actionId) {
      const student = getStudent(p.studentId);
      if (!student?.active) throw new HttpError(409, 'This student is inactive. An admin must reactivate them before fees can be collected.');
      const result = recordCounterPayment(p.studentId, {
        feeItemIds: p.feeItemIds,
        expectedTotal: p.expectedTotal,
        amountReceived: p.amountReceived,
        method: p.method,
        reference: p.reference,
        idempotencyKey: `assistant-action-${actionId}`,
        staff,
      });
      const payment = db.prepare('SELECT receipt_no, amount FROM payments WHERE id = ?').get(result.paymentId);
      return {
        result: { paymentId: result.paymentId, partPayment: result.partPayment, balance: result.balance },
        entity: 'payment',
        entityId: result.paymentId,
        details: { student: student.name, receiptNo: payment.receipt_no, amount: payment.amount, method: p.method },
      };
    },
    reply({ paymentId, partPayment, balance }) {
      prepareReceiptMessage(paymentId);
      const p = paymentDetails(paymentId);
      const { whatsapp, gatewayPaymentId, ...payment } = p;
      return {
        text: `Payment recorded. Receipt ${p.receiptNo} for ${rupees(p.amount)} is ready: print the School Copy and Parent Copy, or send the Parent Copy on WhatsApp.${partPayment ? ` This was a part payment: ${rupees(balance)} of that fee stays due.` : ''}`,
        cards: [{ type: 'payment', payment: { ...payment, whatsapp: whatsapp ? { status: whatsapp.status, state: whatsapp.state, detail: whatsapp.detail } : null } }],
      };
    },
  },

  fee_type: {
    permission: 'fees.manage',
    action: 'ai.fee_type_added',
    run(p, staff) {
      const type = createFeeType(p.name);
      audit(staff, 'fee_type.created', { details: type });
      return { result: type, entity: 'fee_type', entityId: type.id, details: { name: type.name } };
    },
    reply(type) {
      return { text: `Fee type “${type.name}” added. You can now use it in the Fee Structure.`, cards: [] };
    },
  },

  fee: {
    permission: 'fees.manage',
    action: 'ai.fee_added',
    run(p, staff) {
      let type = listFeeTypes().find((t) => t.name.toLowerCase() === p.feeType.toLowerCase());
      if (!type) {
        type = createFeeType(p.feeType);
        audit(staff, 'fee_type.created', { details: type });
      }
      const created = createStructure(
        {
          feeTypeId: type.id,
          name: p.name,
          grade: p.grade,
          session: p.session,
          amount: p.amount,
          frequency: p.frequency,
          firstDueDate: p.firstDueDate,
          lateFee: p.lateFee,
          compulsory: p.compulsory,
          transportOnly: p.transportOnly,
        },
        { applyToExisting: true },
      );
      audit(staff, 'fee_structure.created', {
        entity: 'fee_structure',
        entityId: created.structure.id,
        details: { ...created.structure, instalments: undefined, feeItemsAdded: created.added },
      });
      return {
        result: { structureId: created.structure.id, name: created.structure.name, grade: created.structure.grade, amount: created.structure.amount, frequency: created.structure.frequency, added: created.added },
        entity: 'fee_structure',
        entityId: created.structure.id,
        details: { name: created.structure.name, grade: created.structure.grade ?? 'All classes', amount: created.structure.amount, frequency: created.structure.frequency, feeItemsAdded: created.added },
      };
    },
    reply(r) {
      return {
        text: `Fee added: ${r.name} for ${r.grade ?? 'all classes'}, ${rupees(r.amount)} ${r.frequency.toLowerCase()}. ${r.added} fee items were added to students’ fee accounts.`,
        cards: [{ type: 'link', href: '/admin/fee-structure', label: 'Open Fee Structure' }],
      };
    },
  },
};

const STATUS_TEXT = { confirmed: 'Confirmed', cancelled: 'Cancelled', failed: 'Failed', expired: 'Expired' };

function toCard(row) {
  const summary = JSON.parse(row.summary);
  const expired = row.status === 'pending' && row.expires_at < nowIso();
  return {
    type: 'confirm',
    actionId: row.id,
    status: expired ? 'expired' : row.status,
    statusText: STATUS_TEXT[expired ? 'expired' : row.status] ?? null,
    expiresAt: row.expires_at,
    title: summary.title,
    lines: summary.lines,
    items: summary.items ?? null,
    note: summary.note ?? null,
    confirmLabel: summary.confirmLabel ?? 'Confirm',
    error: row.error,
  };
}

// Stores a proposal and returns its confirmation card.
export function createAction(staff, kind, payload, summary) {
  if (!KINDS[kind]) throw new Error(`Unknown assistant action ${kind}`);
  const now = new Date();
  const expires = new Date(now.getTime() + config.assistant.confirmMinutes * 60_000);
  const { lastInsertRowid } = db
    .prepare('INSERT INTO assistant_actions (staff_id, kind, payload, summary, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(staff.id, kind, JSON.stringify(payload), JSON.stringify(summary), 'pending', now.toISOString(), expires.toISOString());
  return toCard(db.prepare('SELECT * FROM assistant_actions WHERE id = ?').get(lastInsertRowid));
}

function ownAction(staff, id) {
  const row = db.prepare('SELECT * FROM assistant_actions WHERE id = ?').get(Number(id));
  // Someone else's proposal looks the same as a missing one.
  if (!row || row.staff_id !== staff.id) throw new HttpError(404, 'This request was not found.');
  return row;
}

// Runs a proposal the user has confirmed. Confirming twice returns the same result.
export function confirmAction(staff, id) {
  const row = ownAction(staff, id);
  const kind = KINDS[row.kind];
  if (row.status === 'confirmed') return { ...kind.reply(JSON.parse(row.result)), card: toCard(row) };
  if (row.status !== 'pending') throw new HttpError(409, `This request was already ${STATUS_TEXT[row.status].toLowerCase()}. Ask the assistant again.`);
  if (row.expires_at < nowIso()) {
    db.prepare("UPDATE assistant_actions SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'").run(nowIso(), row.id);
    throw new HttpError(409, 'This request has expired. Ask the assistant again so the figures are fresh.');
  }
  const record = (result, details) => audit(staff, kind.action, { entity: details.entity, entityId: details.entityId, details: { actionId: row.id, result, ...details.details } });

  if (!can(staff.role, kind.permission)) {
    db.prepare("UPDATE assistant_actions SET status = 'failed', error = ?, decided_at = ? WHERE id = ?").run('Not permitted', nowIso(), row.id);
    auditVia(AGENT, () => record('refused', { details: { reason: 'Not permitted for this role' } }));
    throw new HttpError(403, 'Your account does not have permission for this. Please ask the school admin.');
  }

  let outcome;
  try {
    outcome = auditVia(AGENT, () =>
      transaction(() => {
        const claimed = db.prepare("UPDATE assistant_actions SET status = 'confirmed', decided_at = ? WHERE id = ? AND status = 'pending'").run(nowIso(), row.id).changes;
        if (!claimed) throw new HttpError(409, 'This request has already been handled.');
        const done = kind.run(JSON.parse(row.payload), staff, row.id);
        db.prepare('UPDATE assistant_actions SET result = ? WHERE id = ?').run(JSON.stringify(done.result), row.id);
        record('success', done);
        return done;
      }),
    );
  } catch (err) {
    const message = err instanceof HttpError ? err.message : 'Something went wrong.';
    db.prepare("UPDATE assistant_actions SET status = 'failed', error = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(message, nowIso(), row.id);
    auditVia(AGENT, () => record('failed', { details: { error: message } }));
    throw err instanceof HttpError ? err : new HttpError(500, message);
  }
  const updated = db.prepare('SELECT * FROM assistant_actions WHERE id = ?').get(row.id);
  return { ...kind.reply(outcome.result), card: toCard(updated) };
}

export function cancelAction(staff, id) {
  const row = ownAction(staff, id);
  if (row.status === 'pending') {
    db.prepare("UPDATE assistant_actions SET status = 'cancelled', decided_at = ? WHERE id = ? AND status = 'pending'").run(nowIso(), row.id);
    auditVia(AGENT, () => audit(staff, 'ai.cancelled', { details: { actionId: row.id, kind: row.kind, result: 'cancelled', title: JSON.parse(row.summary).title } }));
  }
  const updated = db.prepare('SELECT * FROM assistant_actions WHERE id = ?').get(row.id);
  return { text: updated.status === 'cancelled' ? 'Cancelled. Nothing was changed.' : `This request was already ${STATUS_TEXT[updated.status]?.toLowerCase()}.`, card: toCard(updated) };
}
