import crypto from 'node:crypto';
import { afterCommit, db, nextCounter, nowIso, transaction } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../http.js';
import { events } from '../events.js';
import { audit } from '../audit.js';
import { gateway, GatewayError } from '../integrations/payments/index.js';
import { getStudent } from './students.js';
import { dueItems } from './fees.js';
import { buildReceiptSnapshot } from './receipts.js';

// The payment workflow:
//
//   online:  createOnlineOrder → gateway checkout → verifyCheckout / webhook
//   counter: recordCounterPayment (clerk receives cash, cheque, etc.)
//
// Both end in confirmOrderTx, the only place a payment becomes PAID. It runs in
// one transaction: ledger row, fee items marked paid, receipt number, frozen
// receipt, audit entry. "payment.confirmed" is announced after the commit, and
// listeners send the WhatsApp receipt, notify clerks and refresh the exports.
//
// Duplicates are stopped twice: by checks in code, and by unique indexes on
// payments(order_id) and payments(gateway, gateway_payment_id).

export const COUNTER_METHODS = ['Cash', 'UPI', 'Cheque', 'Bank transfer', 'Card', 'Other'];
const REFERENCE_LABEL = {
  Cheque: 'cheque number',
  UPI: 'UPI reference number',
  'Bank transfer': 'UTR / transfer reference',
  Card: 'card terminal reference',
  Other: 'reference or note',
};
const REUSE_OPEN_ORDER_MINUTES = 30;
const ABANDONED_AFTER_HOURS = 24;

const sum = (items) => items.reduce((t, i) => t + i.amount, 0);
const onlineCollector = (provider) => `Online (${provider.label})`;

function toOrder(row) {
  return {
    id: row.id,
    studentId: row.student_id,
    amount: row.amount,
    feeItemIds: JSON.parse(row.fee_item_ids),
    channel: row.channel,
    gateway: row.gateway,
    gatewayOrderId: row.gateway_order_id,
    status: row.status,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
  };
}

export function getOrder(id) {
  const row = db.prepare('SELECT * FROM payment_orders WHERE id = ?').get(id);
  return row ? toOrder(row) : null;
}

export function orderByGatewayId(gatewayOrderId) {
  const row = db.prepare('SELECT * FROM payment_orders WHERE gateway_order_id = ?').get(String(gatewayOrderId ?? ''));
  return row ? toOrder(row) : null;
}

export function paymentIdForOrder(orderId) {
  return db.prepare('SELECT id FROM payments WHERE order_id = ?').get(orderId)?.id ?? null;
}

export function insertOrder({ studentId, amount, feeItemIds, channel, gatewayName, gatewayOrderId = null, status = 'created', idempotencyKey = null, createdBy, createdAt = nowIso() }) {
  return Number(
    db
      .prepare(
        `INSERT INTO payment_orders (student_id, amount, fee_item_ids, channel, gateway, gateway_order_id, status,
           idempotency_key, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(studentId, amount, JSON.stringify(feeItemIds), channel, gatewayName, gatewayOrderId, status, idempotencyKey, createdBy, createdAt, createdAt)
      .lastInsertRowid,
  );
}

// ---- Confirmation: the single path to PAID ------------------------------------------

function receiptNumber() {
  return `${config.receiptPrefix}${String(nextCounter(`receipt:${config.receiptPrefix}`)).padStart(5, '0')}`;
}

// Must run inside a transaction. Returns { paymentId, duplicate }.
export function confirmOrderTx(
  orderId,
  { gatewayPaymentId = null, txnId = null, method, paidAt = nowIso(), via, collectedBy, staffId = null, amountReceived = null, replaces = null, actor, silent = false },
) {
  const order = db.prepare('SELECT * FROM payment_orders WHERE id = ?').get(orderId);
  if (!order) throw new HttpError(404, 'Payment order not found.');

  const existing =
    db.prepare('SELECT id FROM payments WHERE order_id = ?').get(order.id) ??
    (gatewayPaymentId
      ? db.prepare('SELECT id FROM payments WHERE gateway = ? AND gateway_payment_id = ?').get(order.gateway, gatewayPaymentId)
      : null);
  if (existing) return { paymentId: existing.id, duplicate: true };

  const itemIds = JSON.parse(order.fee_item_ids);
  const items = itemIds.length
    ? db.prepare(`SELECT * FROM fee_items WHERE id IN (${itemIds.map(() => '?').join(',')}) ORDER BY due_date, id`).all(...itemIds)
    : [];
  // Money that reached the gateway is always recorded. If some of these fees
  // were meanwhile paid another way, the payment is flagged for a refund.
  const alreadyPaid = items.filter((i) => i.payment_id !== null);
  const reviewNote = alreadyPaid.length
    ? `Paid twice: ${alreadyPaid.map((i) => i.title).join(', ')} already had a receipt. Refund or adjust ₹${sum(alreadyPaid)}.`
    : null;

  const student = getStudent(order.student_id);
  const receiptNo = receiptNumber();
  const snapshot = buildReceiptSnapshot({
    student,
    items,
    amount: order.amount,
    method,
    txnId,
    receiptNo,
    paidAt,
    collectedBy,
    gatewayOrderId: order.gateway_order_id,
    amountReceived,
    replacesReceiptNo: replaces?.receipt_no ?? null,
  });

  const paymentId = Number(
    db
      .prepare(
        `INSERT INTO payments (student_id, amount, method, receipt_no, txn_id, paid_at, recorded_by, order_id, gateway,
           gateway_payment_id, status, collected_by, verified_at, verified_via, receipt_snapshot, receipt_token, review_note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        order.student_id,
        order.amount,
        method,
        receiptNo,
        txnId,
        paidAt,
        order.channel === 'online' ? 'parent' : 'office',
        order.id,
        order.gateway,
        gatewayPaymentId,
        collectedBy,
        nowIso(),
        via,
        JSON.stringify(snapshot),
        crypto.randomBytes(18).toString('base64url'),
        reviewNote,
      ).lastInsertRowid,
  );

  db.prepare('UPDATE payments SET collected_by_staff_id = ?, amount_received = ?, replaces_payment_id = ? WHERE id = ?').run(
    staffId,
    amountReceived,
    replaces?.id ?? null,
    paymentId,
  );

  const markPaid = db.prepare('UPDATE fee_items SET payment_id = ? WHERE id = ? AND payment_id IS NULL');
  for (const item of items) markPaid.run(paymentId, item.id);
  db.prepare("UPDATE payment_orders SET status = 'paid', failure_reason = NULL, updated_at = ? WHERE id = ?").run(nowIso(), order.id);

  if (!silent) {
    audit(actor ?? 'system', 'payment.confirmed', {
      entity: 'payment',
      entityId: paymentId,
      details: { receiptNo, amount: order.amount, method, via, studentId: order.student_id, orderId: order.id, gatewayPaymentId, reviewNote },
    });
    afterCommit(() => events.emit('payment.confirmed', { paymentId }));
  }
  return { paymentId, duplicate: false };
}

export function confirmOrder(orderId, info) {
  return transaction(() => confirmOrderTx(orderId, info));
}

export function markOrderFailed(orderId, reason) {
  const { changes } = db
    .prepare("UPDATE payment_orders SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ? AND status = 'created'")
    .run(String(reason ?? 'Payment failed').slice(0, 200), nowIso(), orderId);
  if (changes) afterCommit(() => events.emit('payment.failed', { orderId }));
  return changes > 0;
}

// ---- Online payments (parent app) ---------------------------------------------------

export async function createOnlineOrder(studentId, { expectedAmount, createdBy }) {
  const items = dueItems(studentId);
  if (!items.length) throw new HttpError(409, 'There is nothing due right now.');
  const amount = sum(items);
  if (expectedAmount !== undefined && Number(expectedAmount) !== amount) {
    throw new HttpError(409, 'The amount due has changed. Please check the latest fees and try again.');
  }

  const provider = gateway();
  const feeItemIds = items.map((i) => i.id);

  // Pressing Pay again shortly afterwards reuses the same gateway order.
  const open = db
    .prepare(
      `SELECT * FROM payment_orders
       WHERE student_id = ? AND channel = 'online' AND gateway = ? AND status = 'created'
         AND fee_item_ids = ? AND amount = ? AND created_at > ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(studentId, provider.name, JSON.stringify(feeItemIds), amount, new Date(Date.now() - REUSE_OPEN_ORDER_MINUTES * 60_000).toISOString());
  if (open && (!provider.hasOrder || provider.hasOrder(open.gateway_order_id))) return toOrder(open);

  const student = getStudent(studentId);
  let remote;
  try {
    remote = await provider.createOrder({
      amountPaise: amount * 100,
      receipt: `KBS-S${studentId}-${Date.now()}`,
      notes: { student_id: String(studentId), admission_no: student.admissionNo, student_name: student.name },
    });
  } catch (err) {
    console.error('[payments] could not create gateway order:', err.message);
    throw new HttpError(502, 'Could not reach the payment gateway. Please try again in a minute.');
  }

  const id = insertOrder({
    studentId,
    amount,
    feeItemIds,
    channel: 'online',
    gatewayName: provider.name,
    gatewayOrderId: remote.id,
    createdBy,
  });
  return getOrder(id);
}

// Called with what the gateway's checkout returned to the browser. The browser
// is never trusted: the signature is checked with our secret and the payment is
// looked up with the gateway before anything is marked paid.
export async function verifyCheckout({ gatewayOrderId, gatewayPaymentId, signature }) {
  const order = orderByGatewayId(gatewayOrderId);
  if (!order) throw new HttpError(404, 'Payment order not found.');
  if (order.status === 'paid') return { status: 'paid', paymentId: paymentIdForOrder(order.id), orderId: order.id };

  const provider = gateway();
  if (order.gateway !== provider.name) throw new HttpError(409, 'This payment was started with a different gateway.');
  if (!provider.verifyCheckoutSignature({ orderId: order.gatewayOrderId, paymentId: gatewayPaymentId, signature })) {
    audit(`gateway:${provider.name}`, 'payment.signature_rejected', { entity: 'order', entityId: order.id, details: { gatewayPaymentId } });
    throw new HttpError(400, 'We could not verify this payment. If money was deducted, it will be confirmed automatically within a few minutes.');
  }

  let remote;
  try {
    remote = await provider.fetchPayment(gatewayPaymentId);
  } catch (err) {
    // The gateway could not be asked right now. The webhook will confirm it.
    console.error('[payments] could not fetch payment from gateway:', err.message);
    return { status: 'pending', orderId: order.id };
  }
  if (remote.orderId !== order.gatewayOrderId || remote.amountPaise !== order.amount * 100) {
    audit(`gateway:${provider.name}`, 'payment.mismatch', { entity: 'order', entityId: order.id, details: { remote } });
    throw new HttpError(400, 'The payment details from the gateway do not match this order. The school office has been notified.');
  }
  if (remote.status !== 'captured') return { status: 'pending', orderId: order.id };

  const result = confirmOrder(order.id, {
    gatewayPaymentId: remote.id,
    txnId: remote.id,
    method: remote.method,
    paidAt: remote.createdAt,
    via: 'checkout',
    collectedBy: onlineCollector(provider),
    actor: `gateway:${provider.name}`,
  });
  return { status: 'paid', paymentId: result.paymentId, orderId: order.id };
}

// ---- Webhooks --------------------------------------------------------------------------

const CONFIRMING_EVENTS = new Set(['payment.captured', 'order.paid']);

// Returns { outcome }. Throws 401 for a bad signature. Every delivery is logged
// in payment_events; a repeated event id is acknowledged without reprocessing.
export function handleWebhook({ rawBody, headers, body }) {
  const provider = gateway();
  const receivedAt = nowIso();
  const event = provider.parseWebhook(body, headers, rawBody);

  if (!provider.verifyWebhook(rawBody, headers)) {
    db.prepare(
      `INSERT INTO payment_events (gateway, event_id, event_type, gateway_order_id, gateway_payment_id, signature_valid,
         outcome, payload, received_at) VALUES (?, ?, ?, ?, ?, 0, 'rejected', ?, ?)`,
    ).run(provider.name, `rejected:${crypto.randomUUID()}`, event.type, event.orderId, event.paymentId, rawBody.toString('utf8'), receivedAt);
    audit(`gateway:${provider.name}`, 'webhook.rejected', { details: { type: event.type, orderId: event.orderId } });
    throw new HttpError(401, 'Invalid webhook signature.');
  }

  // Recording the event and acting on it happen together: if processing fails,
  // the event is not recorded and the gateway's retry is processed normally.
  return transaction(() => {
    const inserted = db
      .prepare(
        `INSERT OR IGNORE INTO payment_events (gateway, event_id, event_type, gateway_order_id, gateway_payment_id,
           signature_valid, payload, received_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(provider.name, event.eventId, event.type, event.orderId, event.paymentId, rawBody.toString('utf8'), receivedAt);
    if (!inserted.changes) return { outcome: 'duplicate' };

    const outcome = processEvent(event, provider);
    db.prepare('UPDATE payment_events SET outcome = ? WHERE gateway = ? AND event_id = ?').run(outcome, provider.name, event.eventId);
    return { outcome };
  });
}

function processEvent(event, provider) {
  if (!CONFIRMING_EVENTS.has(event.type) && event.type !== 'payment.failed') return 'ignored';
  const order = event.orderId ? orderByGatewayId(event.orderId) : null;
  if (!order) return 'unknown_order';

  if (event.type === 'payment.failed') {
    return markOrderFailed(order.id, event.payment?.errorDescription || 'Payment failed at the gateway') ? 'marked_failed' : 'ignored';
  }
  const payment = event.payment;
  if (!payment || payment.status !== 'captured') return 'ignored';
  if (payment.amountPaise !== order.amount * 100) {
    audit(`gateway:${provider.name}`, 'payment.mismatch', { entity: 'order', entityId: order.id, details: { payment } });
    return 'amount_mismatch';
  }
  const result = confirmOrderTx(order.id, {
    gatewayPaymentId: payment.id,
    txnId: payment.id,
    method: payment.method,
    paidAt: payment.createdAt,
    via: 'webhook',
    collectedBy: onlineCollector(provider),
    actor: `gateway:${provider.name}`,
  });
  return result.duplicate ? 'already_confirmed' : 'confirmed';
}

// ---- Reconciliation: asking the gateway directly ------------------------------------

// For an unfinished online payment: confirms it if the gateway captured the
// money (for example when a webhook was missed), or marks it failed.
export async function reconcileOrder(orderId, actor = 'system') {
  const order = getOrder(orderId);
  if (!order) throw new HttpError(404, 'Payment order not found.');
  if (order.status === 'paid') return { status: 'paid', paymentId: paymentIdForOrder(order.id) };
  if (order.channel !== 'online') return { status: order.status };

  const provider = gateway();
  if (order.gateway !== provider.name) throw new HttpError(409, 'This payment was made with a different gateway.');

  let remote;
  try {
    remote = await provider.fetchOrderPayments(order.gatewayOrderId);
  } catch (err) {
    throw new HttpError(err instanceof GatewayError ? 502 : 500, `Could not check with the gateway: ${err.message}`);
  }

  const captured = remote.find((p) => p.status === 'captured' && p.amountPaise === order.amount * 100);
  if (captured) {
    const result = confirmOrder(order.id, {
      gatewayPaymentId: captured.id,
      txnId: captured.id,
      method: captured.method,
      paidAt: captured.createdAt,
      via: 'reconcile',
      collectedBy: onlineCollector(provider),
      actor,
    });
    return { status: 'paid', paymentId: result.paymentId };
  }

  const failed = remote.find((p) => p.status === 'failed');
  const abandoned = !remote.length && Date.now() - Date.parse(order.createdAt) > ABANDONED_AFTER_HOURS * 3600_000;
  if (order.status === 'created' && (failed || abandoned)) {
    transaction(() => markOrderFailed(order.id, failed?.errorDescription || 'Payment was not completed'));
  }
  return { status: getOrder(order.id).status };
}

let reconcileTimer = null;
export function startReconcileWorker() {
  const run = async () => {
    const cutoff = new Date(Date.now() - config.payments.reconcileAfterMinutes * 60_000).toISOString();
    const stale = db
      .prepare(
        "SELECT id FROM payment_orders WHERE channel = 'online' AND gateway = ? AND status = 'created' AND created_at < ? ORDER BY id LIMIT 20",
      )
      .all(gateway().name, cutoff);
    for (const { id } of stale) {
      await reconcileOrder(id).catch((err) => console.error(`[payments] reconcile order ${id}: ${err.message}`));
    }
  };
  reconcileTimer = setInterval(run, 2 * 60_000);
  reconcileTimer.unref();
}
export const stopReconcileWorker = () => clearInterval(reconcileTimer);

// ---- Counter collections (clerk) ---------------------------------------------------------

// Money received in person (cash, or UPI/cheque/card at the office).
//   feeItemIds      the fees the parent is paying (due or upcoming)
//   expectedTotal   the total the clerk saw, to catch fees paid meanwhile
//   amountReceived  what was handed over. More than the total: the rest is
//                   change (cash only). Less: a part payment, applied to the
//                   selected fees in due-date order; the balance stays due.
// `idempotencyKey` is created by the clerk's screen for each attempt, so a
// double-click or a retried request cannot record the payment twice.
export function recordCounterPayment(studentId, { feeItemIds, method, reference, expectedTotal, amountReceived, amount, idempotencyKey, staff }) {
  if (!COUNTER_METHODS.includes(method)) throw new HttpError(400, 'Choose how the money was paid.');
  const ref = String(reference ?? '').trim();
  if (REFERENCE_LABEL[method] && method !== 'Other' && !ref) throw new HttpError(400, `Enter the ${REFERENCE_LABEL[method]}.`);
  if (ref.length > 40) throw new HttpError(400, 'The reference is too long.');
  const key = idempotencyKey ? String(idempotencyKey).slice(0, 80) : null;

  return transaction(() => {
    if (key) {
      const prior = db.prepare('SELECT o.id, p.id AS payment_id FROM payment_orders o LEFT JOIN payments p ON p.order_id = o.id WHERE o.idempotency_key = ?').get(key);
      if (prior?.payment_id) return { paymentId: prior.payment_id, duplicate: true };
    }

    const open = dueItems(studentId, { includeUpcoming: true });
    const wanted = Array.isArray(feeItemIds) && feeItemIds.length ? new Set(feeItemIds.map(Number)) : null;
    const selected = wanted ? open.filter((i) => wanted.has(i.id)) : dueItems(studentId);
    if (!selected.length) throw new HttpError(409, 'Nothing selected is due for this student.');
    if (wanted && selected.length !== wanted.size) {
      throw new HttpError(409, 'Some of the selected fees have just been paid. Please refresh and try again.');
    }
    const total = sum(selected);
    const seen = expectedTotal ?? amount;
    if (seen !== undefined && seen !== '' && Number(seen) !== total) {
      throw new HttpError(409, 'The amount due has changed. Please refresh and try again.');
    }

    const received = amountReceived === undefined || amountReceived === '' || amountReceived === null ? total : Number(amountReceived);
    if (!Number.isInteger(received) || received < 1) throw new HttpError(400, 'Enter the amount received in whole rupees.');
    if (received > total && method !== 'Cash') {
      throw new HttpError(400, `The amount is more than the fees selected (${total}). Only cash can have change returned.`);
    }

    // Part payment: the last fee reached is split into the paid part and the balance.
    let remaining = Math.min(received, total);
    const paidIds = [];
    for (const item of selected) {
      if (remaining <= 0) break;
      if (remaining >= item.amount) {
        paidIds.push(item.id);
        remaining -= item.amount;
        continue;
      }
      const row = db.prepare('SELECT * FROM fee_items WHERE id = ?').get(item.id);
      const base = row.title.replace(/ \((part|balance)\)$/, '');
      db.prepare('UPDATE fee_items SET amount = ?, title = ? WHERE id = ?').run(remaining, `${base} (part)`, row.id);
      db.prepare(
        `INSERT INTO fee_items (student_id, title, fee_type, amount, due_date, created_at, period)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(row.student_id, `${base} (balance)`, row.fee_type, row.amount - remaining, row.due_date, nowIso(), `${row.period ?? ''} balance ${row.id}`);
      paidIds.push(row.id);
      remaining = 0;
    }
    const paid = Math.min(received, total);

    const orderId = insertOrder({
      studentId,
      amount: paid,
      feeItemIds: paidIds,
      channel: 'counter',
      gatewayName: 'counter',
      idempotencyKey: key,
      createdBy: `staff:${staff.id}`,
    });
    const result = confirmOrderTx(orderId, {
      txnId: ref || `KBS-C-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      method,
      via: 'counter',
      collectedBy: staff.name,
      staffId: staff.id,
      amountReceived: method === 'Cash' ? received : null,
      actor: staff,
    });
    return { ...result, change: method === 'Cash' ? received - paid : 0, partPayment: paid < total, balance: total - paid };
  });
}

// ---- Reversals (approved corrections only) --------------------------------------------------

// Cancels a confirmed payment. Nothing is deleted: the payment and its receipt
// stay, marked REVERSED, and the fees it paid become due again.
export function reversePaymentTx(paymentId, { reason, actor }) {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!payment) throw new HttpError(404, 'Payment not found.');
  if (payment.status !== 'confirmed') throw new HttpError(409, 'This payment has already been reversed.');
  const items = db.prepare('SELECT id FROM fee_items WHERE payment_id = ?').all(paymentId).map((r) => r.id);
  db.prepare("UPDATE payments SET status = 'reversed', reversed_at = ?, reversal_reason = ? WHERE id = ?").run(nowIso(), reason, paymentId);
  db.prepare('UPDATE fee_items SET payment_id = NULL WHERE payment_id = ?').run(paymentId);
  audit(actor, 'payment.reversed', { entity: 'payment', entityId: paymentId, details: { receiptNo: payment.receipt_no, amount: payment.amount, reason } });
  afterCommit(() => events.emit('payment.reversed', { paymentId }));
  return { payment, feeItemIds: items };
}

// Issues a new receipt for the same money with corrected details (mode or
// reference), after the original has been reversed.
export function issueReplacementTx(original, feeItemIds, { method, reference, actor }) {
  const orderId = insertOrder({
    studentId: original.student_id,
    amount: original.amount,
    feeItemIds,
    channel: original.recorded_by === 'parent' ? 'online' : 'counter',
    gatewayName: 'correction',
    createdBy: typeof actor === 'string' ? actor : `staff:${actor.id}`,
  });
  return confirmOrderTx(orderId, {
    txnId: reference || original.txn_id,
    method: method || original.method,
    paidAt: original.paid_at,
    via: 'correction',
    collectedBy: original.collected_by,
    staffId: original.collected_by_staff_id,
    amountReceived: original.amount_received,
    replaces: original,
    actor,
  });
}
