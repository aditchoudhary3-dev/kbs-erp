import { config } from '../config.js';
import { HttpError, sendDownload, sendHtml } from '../http.js';
import * as auth from '../auth.js';
import { can } from '../permissions.js';
import { gateway } from '../integrations/payments/index.js';
import { whatsapp } from '../integrations/whatsapp/index.js';
import { handleWebhook } from '../services/payments.js';
import { handleStatusUpdates } from '../services/whatsapp.js';
import { parseCopy, paymentIdForToken, receiptData, receiptFilename, receiptHtml, receiptPdf } from '../services/receipts.js';
import { getStudent } from '../services/students.js';

// Receipt pages may be shown inside this app's own print frame.
const FRAMEABLE = {
  'content-security-policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; object-src 'none'; frame-ancestors 'self'",
  'x-frame-options': 'SAMEORIGIN',
};

export function gatewayRoutes(router) {
  // Payment gateway webhooks. No login: authenticity comes from the signature.
  router.post('/api/webhooks/payments', (ctx) => handleWebhook({ rawBody: ctx.rawBody, headers: ctx.req.headers, body: ctx.body }));

  // The built-in test gateway's checkout. Only exists when no real gateway is set up.
  router.post('/api/test-gateway/checkout', (ctx) => {
    const provider = gateway();
    if (provider.name !== 'test') throw new HttpError(404, 'Not found');
    const { orderId, method, outcome } = ctx.body;
    try {
      return provider.simulateCheckout({ orderId: String(orderId ?? ''), method: String(method ?? 'UPI'), outcome });
    } catch (err) {
      throw new HttpError(err.status ?? 400, err.message);
    }
  });

  // WhatsApp Cloud API: webhook verification handshake and delivery statuses.
  router.get('/api/webhooks/whatsapp', (ctx) => {
    const { verifyToken } = config.whatsapp.cloud;
    if (!verifyToken || ctx.query.get('hub.mode') !== 'subscribe' || ctx.query.get('hub.verify_token') !== verifyToken) {
      throw new HttpError(403, 'Verification failed.');
    }
    ctx.res.writeHead(200, { 'content-type': 'text/plain' });
    ctx.res.end(ctx.query.get('hub.challenge') ?? '');
  });

  router.post('/api/webhooks/whatsapp', (ctx) => {
    const provider = whatsapp();
    if (!provider.verifyWebhook?.(ctx.rawBody, ctx.req.headers['x-hub-signature-256'])) {
      throw new HttpError(401, 'Invalid signature.');
    }
    return handleStatusUpdates(ctx.body);
  });

  // ---- Receipts ------------------------------------------------------------------------

  // Printable A4 receipt. Staff may open the School Copy, the Parent Copy or
  // both (?copy=school|parent|both, one page each). The student's parent
  // only ever gets the Parent Copy.
  router.get('/receipts/:id', (ctx) => {
    const receipt = receiptData(Number(ctx.params.id));
    const staff = auth.currentStaff(ctx);
    const parent = auth.parentPhone(ctx);
    const isStaff = Boolean(staff && can(staff.role, 'receipts.print'));
    if (!isStaff && !(parent && parent === getStudent(receipt.studentId)?.parentPhone)) throw new HttpError(404, 'Receipt not found.');
    const copy = isStaff ? parseCopy(ctx.query.get('copy'), 'both') : 'parent';
    const page = (c) => `/receipts/${receipt.paymentId}?copy=${c}`;
    sendHtml(
      ctx.res,
      receiptHtml(receipt, {
        copy,
        pdfUrl: `/api/payments/${receipt.paymentId}/receipt.pdf?copy=${copy}`,
        links: isStaff
          ? {
              school: page('school'),
              parent: page('parent'),
              both: page('both'),
              schoolPdf: `/api/payments/${receipt.paymentId}/receipt.pdf?copy=school`,
              parentPdf: `/api/payments/${receipt.paymentId}/receipt.pdf?copy=parent`,
            }
          : null,
      }),
      { headers: FRAMEABLE },
    );
  });

  // Link sent to parents on WhatsApp (when PUBLIC_BASE_URL is set): the Parent
  // Copy. The long random token is the only key, so it cannot be guessed.
  router.get('/r/:token', (ctx) => {
    const receipt = receiptData(paymentIdForToken(ctx.params.token));
    sendDownload(ctx.res, receiptPdf(receipt, { copy: 'parent' }), { type: 'application/pdf', filename: receiptFilename(receipt, 'parent'), inline: true });
  });
}
