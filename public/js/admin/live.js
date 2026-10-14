import { html } from '../lib/html.js';
import { icon } from '../lib/icons.js';
import { bindReceiptActions, copyButtons } from './receipt-actions.js';
import { whatsappStatus } from './components.js';
import { formatTime, rupees } from '/shared/format.js';

// Live "PAYMENT SUCCESSFUL" cards for staff. The server pushes an event the
// moment a payment is confirmed (online or at the counter); each card offers
// the receipt copies (print / download the School Copy, Parent Copy or both)
// and sends the Parent Copy on WhatsApp. Pages can listen for "kbs:payment".

const shownHere = new Set(); // payments already shown on the current page

// Called by a page that shows the confirmation itself (Cash Collection, the
// assistant). The live event can arrive before the page's own response, so
// drop any card it made.
export function markShown(paymentId) {
  shownHere.add(Number(paymentId));
  document.querySelector(`.confirm-stack [data-payment="${Number(paymentId)}"]`)?.remove();
}

export function confirmationCard(p, { large = false, dismissible = !large } = {}) {
  const online = p.channel === 'online';
  return html`
    <section class="confirm-card ${large ? 'confirm-card--large' : ''}" data-payment="${p.paymentId}" aria-label="Payment successful">
      <div class="confirm-head">
        <span class="confirm-tick">${icon('check', 18, 3)}</span>
        <h2>PAYMENT SUCCESSFUL</h2>
        ${dismissible ? html`<button type="button" class="confirm-close" data-dismiss aria-label="Dismiss">${icon('x', 16, 2.5)}</button>` : ''}
      </div>
      <dl class="confirm-body">
        <dt>Student</dt><dd>${p.student.name}</dd>
        <dt>Class</dt><dd>${p.student.classLabel}</dd>
        <dt>Amount</dt><dd class="confirm-amount">${rupees(p.amount)}</dd>
        <dt>Receipt No</dt><dd>${p.receiptNo}</dd>
        <dt>Payment Mode</dt><dd>${p.method}${online ? ' (online)' : ''}</dd>
        ${p.change ? html`<dt>Change returned</dt><dd>${rupees(p.change)}</dd>` : ''}
      </dl>
      <p class="confirm-meta">
        ${online ? 'Paid online' : `Collected by ${p.collectedBy}`} at ${formatTime(p.paidAt)}
        <span data-wa-status>${whatsappStatus(p.whatsapp)}</span>
      </p>
      ${copyButtons(p, { compact: !large })}
      <p class="confirm-foot"><button type="button" class="link-button" data-receipt="${p.paymentId}">Receipt copies and history</button></p>
    </section>
  `;
}

// Wires the buttons of a card rendered from confirmationCard().
export function bindCard(card) {
  bindReceiptActions(card);
  card.querySelector('[data-dismiss]')?.addEventListener('click', () => card.remove());
}

function stack() {
  let el = document.querySelector('.confirm-stack');
  if (!el) {
    el = document.createElement('div');
    el.className = 'confirm-stack';
    el.setAttribute('aria-live', 'polite');
    document.body.append(el);
  }
  return el;
}

function showCard(details) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = String(confirmationCard(details));
  const card = wrapper.firstElementChild;
  bindCard(card);
  const list = stack();
  list.prepend(card);
  // Keep the newest two on screen; every payment stays in Payments and Receipts.
  [...list.children].slice(2).forEach((old) => old.remove());
  setTimeout(() => card.remove(), 3 * 60_000);
}

function updateWhatsapp(message) {
  for (const el of document.querySelectorAll(`[data-payment="${message.paymentId}"] [data-wa-status]`)) {
    el.innerHTML = String(whatsappStatus(message, { label: !el.hasAttribute('data-wa-plain') }));
  }
  // The button becomes "Re-send" once the parent copy has gone.
  if (message.state === 'SENT') {
    for (const button of document.querySelectorAll(`.copy-actions [data-whatsapp="${message.paymentId}"]`)) {
      button.innerHTML = `${icon('chat', 16)} Re-send parent copy on WhatsApp`;
    }
  }
}

export function startLiveUpdates() {
  if (!window.EventSource) return;
  const source = new EventSource('/api/admin/events');
  source.addEventListener('payment.confirmed', (event) => {
    const details = JSON.parse(event.data);
    if (!shownHere.has(details.paymentId)) showCard(details);
    document.dispatchEvent(new CustomEvent('kbs:payment', { detail: details }));
  });
  source.addEventListener('payment.failed', (event) => {
    document.dispatchEvent(new CustomEvent('kbs:payment-failed', { detail: JSON.parse(event.data) }));
  });
  source.addEventListener('whatsapp.updated', (event) => updateWhatsapp(JSON.parse(event.data)));
  document.addEventListener('kbs:whatsapp', (event) => updateWhatsapp(event.detail));
}
