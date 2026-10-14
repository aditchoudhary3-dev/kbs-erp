import { db, nowIso } from '../db.js';
import { config } from '../config.js';
import { audit } from '../audit.js';
import { broadcast } from '../events.js';
import { getStudent } from './students.js';
import { publicReceiptUrl, receiptData, receiptFilename, receiptPdf } from './receipts.js';
import { clickToChatLink, receiptMessage, receiptTemplateParams, whatsapp, whatsappNumber } from '../integrations/whatsapp/index.js';

// Outbox of receipt messages to parents: one row per payment. Only the
// PARENT COPY of a receipt is ever sent to a parent.
// Statuses: queued → sent → delivered → read, or failed (retried), or
// ready → opened for click-to-chat, where a clerk presses Send in WhatsApp.
// Staff see these as SENT, PENDING or FAILED (whatsappState).

const DONE = new Set(['sent', 'delivered', 'read']);

const DETAIL = {
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read by parent',
  opened: 'Sent by clerk from WhatsApp',
  ready: 'Waiting for the clerk to send',
  queued: 'Queued',
  sending: 'Sending',
};

// SENT, PENDING or FAILED, with a short explanation. A failed attempt that
// will be retried automatically is still PENDING.
export function whatsappState(status, attempts = 0) {
  if (!status) return { state: 'PENDING', detail: 'Not sent yet' };
  if (DONE.has(status) || status === 'opened') return { state: 'SENT', detail: DETAIL[status] };
  if (status === 'failed') {
    return attempts >= config.whatsapp.maxAttempts
      ? { state: 'FAILED', detail: 'Could not be sent. Press Re-send to try again.' }
      : { state: 'PENDING', detail: `Last attempt failed; retrying automatically (attempt ${attempts} of ${config.whatsapp.maxAttempts})` };
  }
  return { state: 'PENDING', detail: DETAIL[status] ?? status };
}

function toMessage(row) {
  if (!row) return null;
  const provider = whatsapp();
  return {
    ...whatsappState(row.status, row.attempts),
    id: row.id,
    paymentId: row.payment_id,
    toPhone: row.to_phone,
    status: row.status,
    provider: row.provider,
    automatic: provider.automatic,
    attempts: row.attempts,
    error: row.error,
    sentAt: row.sent_at,
    openedBy: row.opened_by,
    body: row.body,
    link: clickToChatLink(whatsappNumber(row.to_phone), row.body),
  };
}

export function messageFor(paymentId) {
  return toMessage(db.prepare('SELECT * FROM whatsapp_messages WHERE payment_id = ?').get(paymentId));
}

// Prepares the receipt message for a payment (once; repeated calls return it).
export function prepareReceiptMessage(paymentId) {
  const existing = messageFor(paymentId);
  if (existing) return existing;

  const receipt = receiptData(paymentId);
  const student = getStudent(receipt.studentId);
  const provider = whatsapp();
  const now = nowIso();
  db.prepare(
    `INSERT OR IGNORE INTO whatsapp_messages (payment_id, to_phone, body, provider, status, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    paymentId,
    student.whatsappPhone,
    receiptMessage(receipt, { receiptUrl: publicReceiptUrl(receipt) }),
    provider.name,
    provider.automatic ? 'queued' : 'ready',
    now,
    now,
    now,
  );
  return messageFor(paymentId);
}

// Sends through the WhatsApp API (automatic providers only). Failures are
// retried by the worker with increasing gaps.
export async function deliver(paymentId, { force = false } = {}) {
  const provider = whatsapp();
  let message = prepareReceiptMessage(paymentId);
  if (!provider.automatic) return message;
  if (DONE.has(message.status) && !force) return message;
  if (message.attempts >= config.whatsapp.maxAttempts && !force) return message;

  db.prepare("UPDATE whatsapp_messages SET attempts = attempts + 1, status = 'sending', updated_at = ? WHERE id = ?").run(nowIso(), message.id);
  const receipt = receiptData(paymentId);
  try {
    const result = await provider.send({
      to: whatsappNumber(message.toPhone),
      text: message.body,
      templateParams: receiptTemplateParams(receipt),
      document: { buffer: receiptPdf(receipt, { copy: 'parent' }), filename: receiptFilename(receipt, 'parent') },
    });
    db.prepare(
      "UPDATE whatsapp_messages SET status = 'sent', provider_message_id = ?, error = NULL, sent_at = ?, updated_at = ? WHERE id = ?",
    ).run(result.providerMessageId, nowIso(), nowIso(), message.id);
  } catch (err) {
    const attempts = message.attempts + 1;
    const retryIn = Math.min(60, 2 ** attempts) * 60_000;
    db.prepare("UPDATE whatsapp_messages SET status = 'failed', error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?").run(
      err.message.slice(0, 300),
      new Date(Date.now() + retryIn).toISOString(),
      nowIso(),
      message.id,
    );
    console.error(`[whatsapp] receipt for payment ${paymentId} failed: ${err.message}`);
  }
  message = messageFor(paymentId);
  broadcast('whatsapp.updated', message);
  return message;
}

// "Send parent copy on WhatsApp" (or Re-send) pressed by a member of staff.
// With the Cloud API the server sends it; if WhatsApp cannot be reached the
// message stays in the retry queue and is sent automatically later.
export async function sendByStaff(paymentId, staff) {
  const provider = whatsapp();
  const before = prepareReceiptMessage(paymentId);
  const action = before.state === 'SENT' ? 'whatsapp.resent' : 'whatsapp.sent';
  const receipt = receiptData(paymentId);
  // Always the current wording, and a fresh set of retries.
  db.prepare('UPDATE whatsapp_messages SET body = ?, attempts = 0, updated_at = ? WHERE id = ?').run(
    receiptMessage(receipt, { receiptUrl: publicReceiptUrl(receipt) }),
    nowIso(),
    before.id,
  );
  const details = { receiptNo: receipt.receiptNo, copy: 'parent', to: before.toPhone };

  if (provider.automatic) {
    const result = await deliver(paymentId, { force: true });
    audit(staff, action, { entity: 'payment', entityId: paymentId, details: { ...details, result: result.state, error: result.error ?? undefined } });
    return { mode: 'automatic', queued: result.state !== 'SENT', message: result };
  }
  // Click to chat: the browser opens WhatsApp with the message; record who sent it.
  db.prepare("UPDATE whatsapp_messages SET status = 'opened', opened_by = ?, sent_at = ?, updated_at = ? WHERE id = ?").run(
    staff.name,
    nowIso(),
    nowIso(),
    before.id,
  );
  audit(staff, action === 'whatsapp.resent' ? 'whatsapp.resent' : 'whatsapp.opened', { entity: 'payment', entityId: paymentId, details });
  const updated = messageFor(paymentId);
  broadcast('whatsapp.updated', updated);
  return { mode: 'manual', message: updated };
}

// Delivery status callbacks from Meta.
export function handleStatusUpdates(body) {
  let updated = 0;
  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const status of change.value?.statuses ?? []) {
        const next = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' }[status.status];
        if (!next) continue;
        const { changes } = db
          .prepare('UPDATE whatsapp_messages SET status = ?, error = ?, updated_at = ? WHERE provider_message_id = ?')
          .run(next, status.errors?.[0]?.title ?? null, nowIso(), status.id);
        updated += changes;
      }
    }
  }
  return { updated };
}

let retryTimer = null;
export function startRetryWorker() {
  if (!whatsapp().automatic) return;
  retryTimer = setInterval(async () => {
    const due = db
      .prepare(
        `SELECT payment_id FROM whatsapp_messages
         WHERE attempts < ? AND ((status IN ('queued', 'failed') AND next_attempt_at <= ?)
           OR (status = 'sending' AND updated_at < ?))
         LIMIT 10`,
      )
      .all(config.whatsapp.maxAttempts, nowIso(), new Date(Date.now() - 5 * 60_000).toISOString());
    for (const { payment_id: paymentId } of due) await deliver(paymentId).catch(() => {});
  }, 60_000);
  retryTimer.unref();
}
export const stopRetryWorker = () => clearInterval(retryTimer);
