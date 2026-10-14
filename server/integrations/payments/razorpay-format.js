import crypto from 'node:crypto';

// Helpers for Razorpay's formats, shared by the real Razorpay provider and the
// built-in test gateway (which speaks the same format).

export class GatewayError extends Error {
  constructor(message, { status = 502, code = 'GATEWAY_ERROR' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

export function safeEqualHex(expected, received) {
  if (typeof received !== 'string' || !/^[0-9a-f]+$/i.test(received)) return false;
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(received, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const METHODS = {
  upi: 'UPI',
  card: 'Card',
  netbanking: 'Net banking',
  wallet: 'Wallet',
  emi: 'EMI',
  cardless_emi: 'EMI',
  paylater: 'Pay later',
  bank_transfer: 'Bank transfer',
};
export const methodLabel = (code) => METHODS[code] ?? (code ? String(code) : 'Online');
export const methodCode = (label) => Object.entries(METHODS).find(([, v]) => v === label)?.[0] ?? 'upi';

// Normalised view of a Razorpay payment entity.
export function toPayment(entity) {
  return {
    id: entity.id,
    orderId: entity.order_id,
    amountPaise: entity.amount,
    status: entity.status, // created | authorized | captured | refunded | failed
    method: methodLabel(entity.method),
    createdAt: new Date((entity.created_at ?? Date.now() / 1000) * 1000).toISOString(),
    errorDescription: entity.error_description ?? null,
  };
}

// Normalised webhook event. `eventId` comes from the X-Razorpay-Event-Id header;
// without one we fall back to a hash of the body so repeats are still caught.
export function parseEvent(body, headers, rawBody) {
  const entity = body?.payload?.payment?.entity;
  const payment = entity ? toPayment(entity) : null;
  return {
    eventId: headers['x-razorpay-event-id'] || `sha256:${crypto.createHash('sha256').update(rawBody).digest('hex')}`,
    type: String(body?.event ?? 'unknown'),
    orderId: payment?.orderId ?? body?.payload?.order?.entity?.id ?? null,
    paymentId: payment?.id ?? null,
    payment,
  };
}
