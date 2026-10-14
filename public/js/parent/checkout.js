import { api } from '../lib/api.js';
import { html } from '../lib/html.js';
import { openSheet } from './components.js';
import { rupees } from '/shared/format.js';

// Paying fees online:
//   1. ask the server for a payment order (the server works out the amount)
//   2. the parent pays on the gateway's checkout (Razorpay, or the test gateway)
//   3. hand the gateway's response to the server, which verifies it
// The browser never marks anything as paid. If step 3 is interrupted, the
// gateway's webhook still confirms the payment, and we wait for that.

const METHOD_HINTS = {
  UPI: 'Google Pay, PhonePe, Paytm or any UPI app',
  Card: 'Debit or credit card',
  'Net banking': 'All major Indian banks',
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startOrder(student, due) {
  return api(`/api/students/${student.id}/payment-orders`, { method: 'POST', body: { amount: due.total } });
}

async function waitForConfirmation(orderId, timeoutMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = await api(`/api/payment-orders/${orderId}`);
    if (status.status === 'PAID') return status.paymentId;
    if (status.status === 'FAILED') throw new Error(status.failureReason || 'The payment did not go through.');
    await wait(1500);
  }
  throw new Error('The bank has not confirmed this payment yet. It will appear in your payment history as soon as it does.');
}

async function confirmWithServer(orderId, response) {
  const result = await api('/api/payments/verify', {
    method: 'POST',
    body: {
      gatewayOrderId: response.razorpay_order_id,
      gatewayPaymentId: response.razorpay_payment_id,
      signature: response.razorpay_signature,
    },
  });
  return result.status === 'paid' ? result.paymentId : waitForConfirmation(orderId);
}

// ---- Razorpay Checkout ------------------------------------------------------------

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) return resolve();
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Could not open the payment page. Check your internet connection.'));
    document.head.append(script);
  });
}

async function razorpayCheckout(start) {
  await loadScript(start.checkout.script);
  return new Promise((resolve, reject) => {
    const checkout = new window.Razorpay({
      key: start.checkout.keyId,
      order_id: start.order.gatewayOrderId,
      amount: start.order.amount * 100,
      currency: 'INR',
      name: start.schoolName,
      description: start.description,
      prefill: start.prefill,
      theme: { color: '#0B3F91' },
      handler: (response) => confirmWithServer(start.order.id, response).then(resolve, reject),
      modal: { ondismiss: () => resolve(null) },
    });
    checkout.open();
  });
}

// ---- Built-in test gateway --------------------------------------------------------

function testCheckout(first, { student, due }) {
  return new Promise((resolve) => {
    let start = first;
    let paying = false;
    let result = null;

    const sheet = openSheet(
      String(html`
        <span class="test-badge">Test payment · no money is charged</span>
        <div class="head-text">
          <h2 class="sheet-title">Pay ${rupees(due.total)}</h2>
          <div class="meta">${student.name} · ${due.items.map((i) => i.title).join(' + ')}</div>
        </div>
        <form class="options" data-checkout>
          <fieldset class="options">
            <legend class="field-label" style="margin-bottom: 10px">Pay with</legend>
            ${['UPI', 'Card', 'Net banking'].map(
              (method, i) => html`
                <label class="option">
                  <input type="radio" name="method" value="${method}" ${i === 0 ? 'checked' : ''} />
                  <span class="grow">
                    <span class="option-title">${method}</span>
                    <span class="option-sub">${METHOD_HINTS[method]}</span>
                  </span>
                </label>
              `,
            )}
          </fieldset>
          <p class="form-error" data-error role="alert" hidden></p>
          <div class="checkout-status" data-status hidden><span class="spinner" aria-hidden="true"></span><span data-status-text></span></div>
          <button type="submit" class="button" data-confirm>Pay ${rupees(due.total)}</button>
          <button type="button" class="button button--outline" data-cancel>Cancel</button>
          <button type="button" class="simulate-failure" data-fail>Try a declined payment (test)</button>
        </form>
      `),
      { label: 'Pay fees' },
    );

    const form = sheet.querySelector('[data-checkout]');
    const confirm = sheet.querySelector('[data-confirm]');
    const errorBox = sheet.querySelector('[data-error]');
    const status = sheet.querySelector('[data-status]');
    const statusText = sheet.querySelector('[data-status-text]');

    const setBusy = (message) => {
      paying = Boolean(message);
      status.hidden = !message;
      statusText.textContent = message ?? '';
      confirm.hidden = Boolean(message);
      sheet.querySelectorAll('button').forEach((b) => (b.disabled = Boolean(message)));
    };

    async function pay(outcome) {
      if (paying) return;
      errorBox.hidden = true;
      setBusy('Contacting the bank…');
      try {
        start ??= await startOrder(student, due);
        const method = new FormData(form).get('method');
        const [response] = await Promise.all([
          api('/api/test-gateway/checkout', { method: 'POST', body: { orderId: start.order.gatewayOrderId, method, outcome } }),
          wait(700),
        ]);
        if (response.error) throw new Error(response.error.description);
        setBusy('Confirming your payment…');
        result = await confirmWithServer(start.order.id, response);
        sheet.close();
      } catch (err) {
        start = null; // a new order is made for the next attempt
        setBusy(null);
        errorBox.textContent = err.message;
        errorBox.hidden = false;
      }
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      pay('success');
    });
    sheet.querySelector('[data-fail]').addEventListener('click', () => pay('failure'));
    sheet.querySelector('[data-cancel]').addEventListener('click', () => sheet.close());
    sheet.addEventListener('cancel', (event) => paying && event.preventDefault());
    sheet.addEventListener('close', () => resolve(result));
  });
}

// Resolves with the confirmed payment id, or null if the parent closed checkout.
export async function payDues({ student, due }) {
  const start = await startOrder(student, due);
  if (start.checkout.name === 'razorpay') return razorpayCheckout(start);
  return testCheckout(start, { student, due });
}
