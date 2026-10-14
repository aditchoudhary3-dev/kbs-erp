import { api } from '../lib/api.js';
import { html } from '../lib/html.js';
import { icon } from '../lib/icons.js';
import { toast } from '../lib/toast.js';
import { session } from './session.js';
import { openModal, payBadge, whatsappStatus } from './components.js';
import { formatDate, formatDateTime, formatTime, rupees } from '/shared/format.js';

// Receipt actions used across the staff app. Every payment has two copies:
//   SCHOOL COPY  for the school's records (with signature spaces)
//   PARENT COPY  for the parent: handed over, downloaded or sent on WhatsApp
// copy is 'school' or 'parent' (one full A4 page each) or 'both' (both on one A4 page).

export const COPY_NAMES = { school: 'School copy', parent: 'Parent copy', both: 'Both copies on one page' };

export const receiptUrl = (paymentId, copy = 'both') => `/receipts/${paymentId}?copy=${copy}`;
export const receiptPdfUrl = (paymentId, copy = 'parent') => `/api/payments/${paymentId}/receipt.pdf?copy=${copy}`;

// Opens the print dialog: one copy on a full A4 page, or both copies on one A4 page.
export function printReceipt(paymentId, copy = 'both') {
  document.querySelector('iframe[data-print-frame]')?.remove();
  const frame = document.createElement('iframe');
  frame.dataset.printFrame = '';
  frame.title = 'Receipt for printing';
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  frame.src = receiptUrl(paymentId, copy);
  frame.addEventListener('load', async () => {
    const win = frame.contentWindow;
    await win.document.fonts?.ready;
    win.focus();
    win.print();
    api(`/api/admin/payments/${paymentId}/printed`, { method: 'POST', body: { copy } }).catch(() => {});
  });
  document.body.append(frame);
}

function download(href) {
  const link = document.createElement('a');
  link.href = href;
  link.download = '';
  document.body.append(link);
  link.click();
  link.remove();
}

// A4 PDFs: Receipt-…-School-Copy.pdf and Receipt-…-Parent-Copy.pdf are one
// full page each; "both" is one page with the School Copy on top and the
// Parent Copy below.
export function downloadReceipt(paymentId, copy = 'parent') {
  download(receiptPdfUrl(paymentId, copy));
}

// "Send parent copy on WhatsApp" (only the Parent Copy ever goes to a parent).
// With the WhatsApp Business API the server sends it, or queues it for retry.
// Otherwise WhatsApp opens with the parent's number and the message filled in,
// and the Parent Copy PDF downloads so it can be attached.
export async function sendWhatsApp(paymentId, { details } = {}) {
  const automatic = session.meta.whatsapp.automatic;
  let win = null;
  if (!automatic) {
    // Open the window during the click so pop-up blockers allow it.
    win = window.open('', '_blank');
    if (win) win.opener = null;
  }
  try {
    const result = await api(`/api/admin/payments/${paymentId}/whatsapp`, { method: 'POST' });
    const message = result.message;
    if (automatic) {
      if (result.queued) toast('WhatsApp could not be reached just now. The parent copy is queued and will be sent automatically.', { duration: 6000 });
      else toast(`Parent copy sent to +91 ${message.toPhone} on WhatsApp.`);
    } else {
      const link = message.link ?? details?.whatsapp?.link;
      if (win) win.location.href = link;
      else window.location.href = link;
      downloadReceipt(paymentId, 'parent');
      toast('WhatsApp is open with the message. Attach the downloaded Parent Copy PDF and press Send.', { duration: 6000 });
    }
    document.dispatchEvent(new CustomEvent('kbs:whatsapp', { detail: message }));
    return result;
  } catch (err) {
    win?.close();
    toast(err.message, { tone: 'error' });
    throw err;
  }
}

// The receipt buttons: print and download each copy or both, and send the
// parent copy on WhatsApp. Handled by bindReceiptActions().
export function copyButtons(p, { compact = false } = {}) {
  const id = p.paymentId;
  const paid = (p.status ?? 'PAID') === 'PAID';
  const sent = p.whatsapp?.state === 'SENT';
  return html`
    <div class="copy-actions ${compact ? 'copy-actions--compact' : ''}">
      <button type="button" class="btn btn--primary" data-copy-print="school" data-payment-id="${id}">${icon('print', 16)} Print school copy</button>
      <button type="button" class="btn btn--primary" data-copy-print="parent" data-payment-id="${id}">${icon('print', 16)} Print parent copy</button>
      <button type="button" class="btn btn--primary btn--gold" data-copy-print="both" data-payment-id="${id}" title="School Copy and Parent Copy on one A4 page">${icon('print', 16)} Print both copies</button>
      <button type="button" class="btn" data-copy-download="school" data-payment-id="${id}">${icon('download', 16)} Download school copy</button>
      <button type="button" class="btn" data-copy-download="parent" data-payment-id="${id}">${icon('download', 16)} Download parent copy</button>
      <button type="button" class="btn" data-copy-download="both" data-payment-id="${id}" title="One A4 PDF page with both copies">${icon('download', 16)} Download both copies</button>
      ${paid && session.can('whatsapp.send')
        ? html`<button type="button" class="btn btn--whatsapp copy-actions-wide" data-whatsapp="${id}">${icon('chat', 16)} ${sent ? 'Re-send parent copy on WhatsApp' : 'Send parent copy on WhatsApp'}</button>`
        : ''}
    </div>
  `;
}

// Buttons for a table row: the receipt (both copies, archive), WhatsApp, correction.
export function receiptLinks(paymentId, { status = 'PAID', correctionPending = false, whatsapp = null } = {}) {
  const paid = status === 'PAID';
  return html`
    <span class="row-actions">
      <button type="button" class="link-button" data-receipt="${paymentId}">Receipt copies</button>
      ${paid && session.can('whatsapp.send')
        ? html`<button type="button" class="link-button" data-whatsapp="${paymentId}">${whatsapp?.state === 'SENT' ? 'Re-send' : 'WhatsApp'}</button>`
        : ''}
      ${paid && session.can('corrections.request')
        ? correctionPending
          ? html`<span class="muted" style="font-size: 12px">Correction pending</span>`
          : html`<button type="button" class="link-button link-button--danger" data-correct="${paymentId}">Request correction</button>`
        : ''}
    </span>
  `;
}

// ---- Receipt archive: one payment's copies and history --------------------------------------

const ACTIVITY = {
  'payment.confirmed': (d) => `Payment confirmed (${d.via === 'counter' ? 'at the counter' : d.via === 'correction' ? 'corrected receipt' : `online, ${d.via}`})`,
  'payment.reversed': (d) => `Receipt cancelled: ${d.reason}`,
  'receipt.printed': (d) => `Print opened: ${COPY_NAMES[d.copy] ?? d.copy}`,
  'receipt.downloaded': (d) => `Downloaded: ${COPY_NAMES[d.copy] ?? d.copy} PDF`,
  'whatsapp.sent': (d) => `Parent copy sent on WhatsApp${d.result && d.result !== 'SENT' ? ` (${d.result.toLowerCase()})` : ''}`,
  'whatsapp.resent': () => 'Parent copy re-sent on WhatsApp',
  'whatsapp.opened': () => 'WhatsApp opened with the parent copy message',
  'correction.requested': (d) => `Correction requested: “${d.reason}”`,
  'correction.approved': () => 'Correction approved',
  'correction.rejected': () => 'Correction rejected',
  'ai.payment_recorded': () => 'Recorded through KBS AI Assistant (confirmed by staff)',
};

const who = (actor) =>
  actor.startsWith('gateway:') ? 'Payment gateway' : actor.startsWith('staff:') ? actor.replace(/^staff:\d+ \((.*)\)$/, '$1') : actor === 'system' ? 'System' : actor;

function panelHtml(p) {
  const paid = p.status === 'PAID';
  const copyCard = (copy, title, use) => html`
    <section class="copy-card copy-card--${copy}">
      <div class="copy-card-head"><strong>${title}</strong><span>${use}</span></div>
      <div class="copy-card-actions">
        <a class="btn btn--small" href="${receiptUrl(p.paymentId, copy)}" target="_blank" rel="noopener">View</a>
        <button type="button" class="btn btn--small" data-copy-print="${copy}" data-payment-id="${p.paymentId}">${icon('print', 15)} Print</button>
        <button type="button" class="btn btn--small" data-copy-download="${copy}" data-payment-id="${p.paymentId}">${icon('download', 15)} A4 PDF</button>
      </div>
    </section>
  `;
  return html`
    <div class="receipt-panel">
      <div class="receipt-panel-head">
        <div>
          <h2 class="modal-title">Receipt ${p.receiptNo}</h2>
          <p class="muted" style="margin: 2px 0 0">${p.student.name} · ${p.student.classLabel} · ${p.student.admissionNo}</p>
        </div>
        ${payBadge(p.status)}
      </div>
      <dl class="confirm-table receipt-panel-facts">
        <dt>Amount</dt><dd>${rupees(p.amount)}</dd>
        <dt>Payment Mode</dt><dd>${p.method}${p.channel === 'online' ? ' (online)' : ''}</dd>
        <dt>Transaction ID</dt><dd class="mono">${p.txnId ?? '—'}</dd>
        <dt>Date &amp; time</dt><dd>${formatDate(p.paidAt)}, ${formatTime(p.paidAt)}</dd>
        <dt>Collected By</dt><dd>${p.collectedBy}</dd>
        <dt>Fees</dt><dd>${p.items.map((i) => html`${i.title} · ${rupees(i.amount)}<br />`)}</dd>
        ${p.status === 'CANCELLED' ? html`<dt>Cancelled</dt><dd>${formatDate(p.reversedAt)}: ${p.reversalReason}</dd>` : ''}
        ${p.replacesReceiptNo ? html`<dt>Replaces</dt><dd>${p.replacesReceiptNo}</dd>` : ''}
      </dl>
      <div class="copy-cards">
        ${copyCard('school', 'School Copy', 'For the school’s records, with signature spaces')}
        ${copyCard('parent', 'Parent Copy', 'For the parent: hand over, download or WhatsApp')}
      </div>
      <div class="receipt-panel-row">
        <button type="button" class="btn btn--primary" data-copy-print="both" data-payment-id="${p.paymentId}">${icon('print', 16)} Print both copies (one page)</button>
        <button type="button" class="btn" data-copy-download="both" data-payment-id="${p.paymentId}">${icon('download', 16)} Download both copies (one page)</button>
      </div>
      ${paid
        ? html`
            <div class="receipt-panel-row receipt-panel-wa">
              <span>WhatsApp Status: <span data-wa-status data-wa-plain>${whatsappStatus(p.whatsapp, { label: false })}</span>
                ${p.whatsapp?.detail ? html`<span class="sub muted">${p.whatsapp.detail}${p.whatsapp.sentAt ? ` · ${formatDateTime(p.whatsapp.sentAt)}` : ''}</span>` : ''}</span>
              ${session.can('whatsapp.send')
                ? html`<button type="button" class="btn btn--whatsapp btn--small" data-whatsapp="${p.paymentId}">${icon('chat', 15)} ${p.whatsapp?.state === 'SENT' ? 'Re-send parent copy' : 'Send parent copy'}</button>`
                : ''}
            </div>
          `
        : ''}
      ${p.activity?.length
        ? html`
            <details class="receipt-activity">
              <summary>Receipt history (${p.activity.length})</summary>
              <ol>
                ${p.activity.map(
                  (a) => html`<li><span class="muted">${formatDateTime(a.at)}</span> ${ACTIVITY[a.action]?.(a.details ?? {}) ?? a.action} · ${who(a.actor)}${a.via ? html` <span class="ai-chip">via ${a.via}</span>` : ''}</li>`,
                )}
              </ol>
            </details>
          `
        : ''}
      <div class="form-actions">
        ${paid && session.can('corrections.request') ? html`<button type="button" class="btn link-button--danger" data-correct="${p.paymentId}">Request correction</button>` : ''}
        <button type="button" class="btn" data-close>Close</button>
      </div>
    </div>
  `;
}

// Receipt archive for one payment: both copies, WhatsApp status, history.
export async function openReceiptPanel(paymentId, { onCorrection } = {}) {
  let p;
  try {
    p = await api(`/api/admin/payments/${paymentId}`);
  } catch (err) {
    toast(err.message, { tone: 'error' });
    return;
  }
  const dialog = openModal(String(panelHtml(p)), { label: `Receipt ${p.receiptNo}`, wide: true });
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  bindReceiptActions(dialog, {
    onCorrection: () => {
      dialog.close();
      onCorrection?.();
    },
  });
  // Refresh the panel after WhatsApp is sent from it.
  const refresh = async (event) => {
    if (Number(event.detail?.paymentId) !== Number(paymentId) || !dialog.open) return;
    const fresh = await api(`/api/admin/payments/${paymentId}`).catch(() => null);
    if (fresh) dialog.querySelector('.modal-body').innerHTML = String(panelHtml(fresh));
    dialog.querySelector('[data-close]')?.addEventListener('click', () => dialog.close());
  };
  document.addEventListener('kbs:whatsapp', refresh);
  dialog.addEventListener('close', () => document.removeEventListener('kbs:whatsapp', refresh));
}

// A completed payment cannot be edited. Staff ask for a correction and an
// admin approves it (Corrections page).
export function requestCorrection(paymentId, { onDone } = {}) {
  const modes = session.meta.paymentModes;
  const dialog = openModal(
    String(html`
      <h2 class="modal-title">Request payment correction</h2>
      <p class="muted" style="margin: 0; font-size: 14px">Completed payments cannot be changed directly. An admin will review this request. The original stays on record.</p>
      <form class="modal-body" style="padding: 0" novalidate>
        <fieldset class="field" style="border: 0; padding: 0; margin: 0; gap: 8px">
          <legend style="margin-bottom: 6px">What needs correcting?</legend>
          <label class="check-field"><input type="radio" name="kind" value="change_details" checked /> Wrong payment mode or reference (a new receipt is issued)</label>
          <label class="check-field"><input type="radio" name="kind" value="cancel" /> Cancel this payment (wrong amount, wrong student, or money not received)</label>
        </fieldset>
        <div class="form-grid" data-details>
          <label class="field">Correct payment mode<select class="control" name="method"><option value="">Keep as it is</option>${modes.map((m) => html`<option>${m}</option>`)}</select></label>
          <label class="field">Correct reference / transaction no.<input class="control" name="reference" maxlength="40" /></label>
        </div>
        <label class="field">Reason<textarea class="textarea" name="reason" rows="3" required placeholder="What went wrong? For example: parent paid by UPI, not cash."></textarea></label>
        <p class="form-error" role="alert" hidden></p>
        <div class="form-actions">
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="submit" class="btn btn--primary">Send to admin</button>
        </div>
      </form>
    `),
    { label: 'Request payment correction', wide: true },
  );
  const form = dialog.querySelector('form');
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  form.addEventListener('change', () => (dialog.querySelector('[data-details]').hidden = form.kind.value !== 'change_details'));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api(`/api/admin/payments/${paymentId}/corrections`, { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      dialog.close();
      toast('Correction request sent to the admin.');
      onDone?.();
    } catch (err) {
      const box = form.querySelector('.form-error');
      box.textContent = err.message;
      box.hidden = false;
    }
  });
}

// Handles clicks on receipt buttons inside root: copies, WhatsApp, archive, correction.
export function bindReceiptActions(root, { onCorrection } = {}) {
  root.addEventListener('click', (event) => {
    const target = event.target.closest('[data-copy-print], [data-copy-download], [data-receipt], [data-whatsapp], [data-correct], [data-print]');
    // A card inside a page can be bound as well as the page: act once.
    if (!target || !root.contains(target) || event.receiptHandled) return;
    event.receiptHandled = true;
    const d = target.dataset;
    if (d.copyPrint) printReceipt(d.paymentId, d.copyPrint);
    else if (d.copyDownload) downloadReceipt(d.paymentId, d.copyDownload);
    else if (d.receipt) openReceiptPanel(d.receipt, { onCorrection });
    else if (d.whatsapp) sendWhatsApp(d.whatsapp).catch(() => {});
    else if (d.correct) requestCorrection(d.correct, { onDone: onCorrection });
    else if (d.print) printReceipt(d.print, 'both');
  });
}

export const printIcon = () => icon('print', 16);
export const chatIcon = () => icon('chat', 16);
