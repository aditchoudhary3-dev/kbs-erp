import { GatewayError, hmacHex, parseEvent, safeEqualHex, toPayment } from './razorpay-format.js';

// Razorpay (https://razorpay.com/docs/api/). Needs RAZORPAY_KEY_ID,
// RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET. In the Razorpay dashboard,
// point a webhook at <PUBLIC_BASE_URL>/api/webhooks/payments with the events
// payment.captured, payment.failed and order.paid.
export function createRazorpay({ keyId, keySecret, webhookSecret, apiBase }) {
  const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;

  async function call(method, path, body) {
    let response;
    try {
      response = await fetch(`${apiBase}${path}`, {
        method,
        headers: { authorization: auth, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new GatewayError(`Could not reach Razorpay: ${err.message}`);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new GatewayError(data?.error?.description || `Razorpay returned ${response.status}`, {
        status: response.status === 404 ? 404 : 502,
      });
    }
    return data;
  }

  return {
    name: 'razorpay',
    label: 'Razorpay',

    // What the browser needs to open Razorpay Checkout.
    checkoutConfig: () => ({ name: 'razorpay', keyId, script: 'https://checkout.razorpay.com/v1/checkout.js' }),

    async createOrder({ amountPaise, receipt, notes }) {
      const order = await call('POST', '/v1/orders', { amount: amountPaise, currency: 'INR', receipt, notes });
      return { id: order.id };
    },

    // Checkout returns order id, payment id and this signature to the browser.
    verifyCheckoutSignature: ({ orderId, paymentId, signature }) =>
      Boolean(orderId && paymentId) && safeEqualHex(hmacHex(keySecret, `${orderId}|${paymentId}`), signature),

    fetchPayment: async (paymentId) => toPayment(await call('GET', `/v1/payments/${encodeURIComponent(paymentId)}`)),

    async fetchOrderPayments(orderId) {
      const data = await call('GET', `/v1/orders/${encodeURIComponent(orderId)}/payments`);
      return (data.items ?? []).map(toPayment);
    },

    verifyWebhook: (rawBody, headers) =>
      Boolean(webhookSecret) && safeEqualHex(hmacHex(webhookSecret, rawBody), headers['x-razorpay-signature']),

    parseWebhook: parseEvent,
  };
}
