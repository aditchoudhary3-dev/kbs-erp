import { config } from '../../config.js';
import { createRazorpay } from './razorpay.js';
import { createTestGateway } from './test-gateway.js';

export { GatewayError } from './razorpay-format.js';

// The active payment gateway. Every provider offers the same functions:
//   createOrder, verifyCheckoutSignature, fetchPayment, fetchOrderPayments,
//   verifyWebhook, parseWebhook, checkoutConfig
// so another gateway (PayU, Cashfree...) can be added as one more file here.
let instance = null;

export function gateway() {
  if (instance) return instance;
  const choice = config.payments.gateway;
  if (choice === 'razorpay') {
    instance = createRazorpay(config.payments.razorpay);
  } else if (choice === 'test') {
    instance = createTestGateway({
      ...config.payments.test,
      webhookUrl: () => `${config.runtime.internalUrl}/api/webhooks/payments`,
      quiet: () => Boolean(process.env.QUIET),
    });
  } else {
    throw new Error(`Unknown PAYMENT_GATEWAY "${choice}". Use "razorpay" or "test".`);
  }
  return instance;
}

// For tests that switch gateways.
export function resetGateway() {
  instance = null;
}
