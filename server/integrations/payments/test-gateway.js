import crypto from 'node:crypto';
import { GatewayError, hmacHex, methodCode, parseEvent, safeEqualHex, toPayment } from './razorpay-format.js';

// A stand-in for Razorpay that runs inside this server, used when no Razorpay
// keys are configured. It speaks Razorpay's formats: orders, checkout
// signatures, and signed webhooks delivered over HTTP to /api/webhooks/payments.
// The app verifies it exactly as it would verify Razorpay. No money moves.
export function createTestGateway({ keySecret, webhookSecret, duplicateWebhooks, webhookDelayMs, webhookUrl, quiet }) {
  const orders = new Map();
  const payments = new Map();
  const log = (...args) => quiet() || console.log('\x1b[35m[test gateway]\x1b[0m', ...args);

  const newId = (prefix) => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let id = `${prefix}_`;
    for (let i = 0; i < 14; i++) id += alphabet[crypto.randomInt(alphabet.length)];
    return id;
  };
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  // Delivers a signed webhook, like Razorpay's servers would. Sent twice when
  // duplicateWebhooks is on, because real gateways may deliver more than once.
  function deliverWebhook(event, paymentEntity) {
    const body = JSON.stringify({
      entity: 'event',
      account_id: 'acc_test',
      event,
      contains: ['payment'],
      payload: { payment: { entity: paymentEntity } },
      created_at: nowSeconds(),
    });
    const headers = {
      'content-type': 'application/json',
      'x-razorpay-signature': hmacHex(webhookSecret, body),
      'x-razorpay-event-id': newId('evt'),
    };
    // Like a real gateway, a failed delivery is retried a couple of times.
    const send = (attempt, tries = 0) =>
      fetch(webhookUrl(), { method: 'POST', headers, body })
        .then(async (res) => log(`webhook ${event} (delivery ${attempt}) → ${res.status} ${(await res.json().catch(() => ({}))).outcome ?? ''}`))
        .catch((err) => {
          if (tries < 2) setTimeout(() => send(attempt, tries + 1), 2000).unref();
          else log(`webhook ${event} could not be delivered: ${err.message}`);
        });
    setTimeout(() => send(1), webhookDelayMs).unref();
    if (duplicateWebhooks) setTimeout(() => send(2), webhookDelayMs + 1500).unref();
  }

  return {
    name: 'test',
    label: 'Test gateway',
    checkoutConfig: () => ({ name: 'test' }),

    async createOrder({ amountPaise, receipt, notes }) {
      const order = { id: newId('order'), amount: amountPaise, currency: 'INR', receipt, notes, status: 'created' };
      orders.set(order.id, order);
      return { id: order.id };
    },

    hasOrder: (orderId) => orders.has(orderId),

    verifyCheckoutSignature: ({ orderId, paymentId, signature }) =>
      Boolean(orderId && paymentId) && safeEqualHex(hmacHex(keySecret, `${orderId}|${paymentId}`), signature),

    async fetchPayment(paymentId) {
      const payment = payments.get(paymentId);
      if (!payment) throw new GatewayError('Payment not found at the gateway.', { status: 404 });
      return toPayment(payment);
    },

    async fetchOrderPayments(orderId) {
      return [...payments.values()].filter((p) => p.order_id === orderId).map(toPayment);
    },

    verifyWebhook: (rawBody, headers) => safeEqualHex(hmacHex(webhookSecret, rawBody), headers['x-razorpay-signature']),

    parseWebhook: parseEvent,

    // What Razorpay's hosted checkout does when the parent presses Pay.
    // Returns the same response Razorpay Checkout gives the browser.
    simulateCheckout({ orderId, method, outcome = 'success' }) {
      const order = orders.get(orderId);
      if (!order) throw new GatewayError('This payment session has expired. Please start again.', { status: 404 });
      if (order.status === 'paid') throw new GatewayError('This order has already been paid.', { status: 409 });

      const failed = outcome === 'failure';
      const payment = {
        id: newId('pay'),
        entity: 'payment',
        amount: order.amount,
        currency: 'INR',
        order_id: order.id,
        method: methodCode(method),
        status: failed ? 'failed' : 'captured',
        captured: !failed,
        created_at: nowSeconds(),
        error_description: failed ? 'The bank declined this payment (test).' : null,
      };
      payments.set(payment.id, payment);
      if (!failed) order.status = 'paid';
      log(`${failed ? 'declined' : 'captured'} ${payment.id} for ${order.id} (₹${order.amount / 100})`);
      deliverWebhook(failed ? 'payment.failed' : 'payment.captured', payment);

      if (failed) {
        return { error: { code: 'BAD_REQUEST_ERROR', description: payment.error_description, metadata: { order_id: order.id, payment_id: payment.id } } };
      }
      return {
        razorpay_order_id: order.id,
        razorpay_payment_id: payment.id,
        razorpay_signature: hmacHex(keySecret, `${order.id}|${payment.id}`),
      };
    },
  };
}
