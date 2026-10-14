// End-to-end API tests against a fresh in-memory database with the demo data.
// Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

process.env.QUIET = '1'; // keep simulated SMS and gateway logs out of the output
process.env.TEST_GATEWAY_KEY_SECRET = 'test-key-secret';
process.env.TEST_GATEWAY_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.TEST_GATEWAY_DUPLICATE_WEBHOOKS = 'off'; // duplicates are replayed explicitly below

const { startServer } = await import('../server/app.js');
const { DEMO } = await import('../server/seed.js');

let server;
let base;

before(async () => {
  const started = await startServer({ port: 0, host: '127.0.0.1', dbFile: ':memory:' });
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Aarav (the mockups' student) owes Term 2 tuition and transport, due 10 Oct.
// After that date their late fees (₹200 and ₹100) are added as well.
const { todayIso } = await import('../shared/format.js');
const LATE = todayIso() > '2026-10-10';
const AARAV_DUE = 15500 + (LATE ? 300 : 0);
const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

// A tiny client that remembers cookies, like a browser tab.
function client() {
  const jar = new Map();
  async function request(method, path, body, extraHeaders = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    for (const header of res.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const [name, value] = pair.split('=');
      if (value) jar.set(name, value);
      else jar.delete(name);
    }
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, type, data, headers: res.headers };
  }
  return {
    get: (path) => request('GET', path),
    post: (path, body = {}, headers) => request('POST', path, body, headers),
    put: (path, body) => request('PUT', path, body),
    del: (path) => request('DELETE', path),
    cookieHeader: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
  };
}

async function parentLogin(phone) {
  const c = client();
  const otp = await c.post('/api/auth/otp', { phone });
  assert.equal(otp.status, 200, otp.data.error);
  const verified = await c.post('/api/auth/verify', { phone, code: otp.data.demoCode });
  assert.equal(verified.status, 200);
  return c;
}

async function staffLogin(email, password) {
  const c = client();
  const res = await c.post('/api/admin/login', { email, password });
  assert.equal(res.status, 200, res.data.error);
  return c;
}
const adminLogin = () => staffLogin(DEMO.adminEmail, DEMO.adminPassword);
const clerkLogin = () => staffLogin(DEMO.clerkEmail, DEMO.clerkPassword);

async function childNamed(parent, name) {
  const me = await parent.get('/api/me');
  return me.data.children.find((c) => c.name === name);
}

// Starts an online payment and completes the test gateway's checkout.
async function payOnline(parent, student, { outcome = 'success', method = 'UPI' } = {}) {
  const due = (await parent.get(`/api/students/${student.id}/fees`)).data.due.total;
  const order = await parent.post(`/api/students/${student.id}/payment-orders`, { amount: due });
  assert.equal(order.status, 200, order.data.error);
  const checkout = await parent.post('/api/test-gateway/checkout', { orderId: order.data.order.gatewayOrderId, method, outcome });
  return { due, order: order.data.order, checkout: checkout.data };
}

function signedWebhook(event, payment, { eventId = `evt_${crypto.randomUUID()}`, secret = 'test-webhook-secret' } = {}) {
  const body = JSON.stringify({ entity: 'event', event, payload: { payment: { entity: payment } }, created_at: 1 });
  return fetch(`${base}/api/webhooks/payments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-razorpay-signature': hmac(secret, body), 'x-razorpay-event-id': eventId },
    body,
  }).then(async (res) => ({ status: res.status, data: await res.json() }));
}

// ---- Parents ------------------------------------------------------------------------------

test('parent login rejects unknown numbers and wrong codes', async () => {
  const c = client();
  assert.equal((await c.post('/api/auth/otp', { phone: '9000000000' })).status, 404);
  assert.equal((await c.post('/api/auth/otp', { phone: '12345' })).status, 400);

  const otp = await c.post('/api/auth/otp', { phone: '+91 98765 00018' });
  assert.equal(otp.status, 200);
  assert.match(otp.data.demoCode, /^\d{6}$/);
  assert.equal((await c.post('/api/auth/otp', { phone: '9876500018' })).status, 429, 'resend is rate limited');

  const wrongCode = otp.data.demoCode === '000000' ? '111111' : '000000';
  assert.equal((await c.post('/api/auth/verify', { phone: '9876500018', code: wrongCode })).status, 400);
  assert.equal((await c.get('/api/me')).status, 401);

  assert.equal((await c.post('/api/auth/verify', { phone: '9876500018', code: otp.data.demoCode })).status, 200);
  assert.equal((await c.get('/api/me')).status, 200);
  assert.equal((await c.post('/api/auth/verify', { phone: '9876500018', code: otp.data.demoCode })).status, 400, 'codes are single-use');
});

test('the parent app still shows the mockup figures for Aarav', async () => {
  const c = await parentLogin(DEMO.parentPhone);
  const aarav = await childNamed(c, 'Aarav Sharma');
  assert.equal(aarav.classLabel, 'Class 6-B');

  const home = await c.get(`/api/students/${aarav.id}/home`);
  assert.equal(home.data.fees.total, AARAV_DUE);
  assert.equal(home.data.fees.dueDate, '2026-10-10');
  assert.deepEqual([home.data.progress.avg, home.data.progress.attPct, home.data.progress.activities], [84, 92, 3]);

  const annual = await c.get(`/api/students/${aarav.id}/annual`);
  assert.deepEqual([annual.data.avgAll, annual.data.attAll, annual.data.activities], [82, 91, 10]);
  assert.deepEqual(
    annual.data.subjects.map((s) => [s.name, s.avg, s.trend]),
    [['English', 85, 6], ['Hindi', 79, 4], ['Maths', 73, 6], ['Science', 87, 6], ['Social Studies', 84, 3]],
  );

  const fees = await c.get(`/api/students/${aarav.id}/fees`);
  assert.deepEqual(fees.data.payments.map((p) => p.description), ['Tuition Fee · Term 1', 'Transport Fee · Jul–Sep', 'Annual Charges']);
  assert.deepEqual(fees.data.due.upcoming.map((i) => i.title), ['Transport Fee · Jan–Mar'], 'later instalments are upcoming, not due');
});

test('parents cannot see other families’ children or receipts', async () => {
  const c = await parentLogin(DEMO.parentPhone);
  const office = await clerkLogin();
  const other = (await office.get('/api/admin/payments?q=Kabir')).data.rows.find((r) => r.status === 'PAID');
  assert.equal((await c.get(`/api/students/${other.student.id}/home`)).status, 404);
  assert.equal((await c.get(`/api/payments/${other.paymentId}`)).status, 404);
  assert.equal((await c.get(`/api/payments/${other.paymentId}/receipt.pdf`)).status, 404);
  assert.equal((await c.get(`/receipts/${other.paymentId}`)).status, 404);
});

// ---- Online payments: verification and duplicates --------------------------------------------

test('fees cannot be marked paid from the browser', async () => {
  const c = await parentLogin(DEMO.parentPhone);
  const aarav = await childNamed(c, 'Aarav Sharma');
  assert.equal((await c.post(`/api/students/${aarav.id}/payments`, { method: 'UPI', amount: AARAV_DUE })).status, 404);

  const order = await c.post(`/api/students/${aarav.id}/payment-orders`, { amount: 100 });
  assert.equal(order.status, 409, 'refuses an amount the parent did not see');

  const real = await c.post(`/api/students/${aarav.id}/payment-orders`, { amount: AARAV_DUE });
  const forged = await c.post('/api/payments/verify', {
    gatewayOrderId: real.data.order.gatewayOrderId,
    gatewayPaymentId: 'pay_madeup',
    signature: hmac('wrong-secret', `${real.data.order.gatewayOrderId}|pay_madeup`),
  });
  assert.equal(forged.status, 400);

  const fakeWebhook = await signedWebhook(
    'payment.captured',
    { id: 'pay_fake', order_id: real.data.order.gatewayOrderId, amount: AARAV_DUE * 100, status: 'captured', method: 'upi' },
    { secret: 'not-the-secret' },
  );
  assert.equal(fakeWebhook.status, 401);
  assert.equal((await c.get(`/api/students/${aarav.id}/fees`)).data.due.total, AARAV_DUE, 'still due');
});

test('a verified online payment is confirmed once, however many confirmations arrive', async () => {
  const c = await parentLogin(DEMO.parentPhone);
  const aarav = await childNamed(c, 'Aarav Sharma');
  const office = await clerkLogin();
  const beforeBanner = (await office.get('/api/admin/classes')).data.grades.find((g) => g.grade === 'Class 6');

  const { order, checkout } = await payOnline(c, aarav);
  assert.ok(checkout.razorpay_signature);

  const verify = await c.post('/api/payments/verify', {
    gatewayOrderId: checkout.razorpay_order_id,
    gatewayPaymentId: checkout.razorpay_payment_id,
    signature: checkout.razorpay_signature,
  });
  assert.equal(verify.data.status, 'paid');
  const paymentId = verify.data.paymentId;

  // The same checkout response again, the same webhook event twice, and a
  // different event about the same payment: none may create another record.
  const again = await c.post('/api/payments/verify', {
    gatewayOrderId: checkout.razorpay_order_id,
    gatewayPaymentId: checkout.razorpay_payment_id,
    signature: checkout.razorpay_signature,
  });
  assert.equal(again.data.paymentId, paymentId);
  const entity = { id: checkout.razorpay_payment_id, order_id: order.gatewayOrderId, amount: AARAV_DUE * 100, status: 'captured', method: 'upi', created_at: 1 };
  assert.equal((await signedWebhook('payment.captured', entity, { eventId: 'evt_same' })).data.outcome, 'already_confirmed');
  assert.equal((await signedWebhook('payment.captured', entity, { eventId: 'evt_same' })).data.outcome, 'duplicate');
  assert.equal((await signedWebhook('order.paid', entity)).data.outcome, 'already_confirmed');
  await sleep(600); // the gateway's own webhook

  const history = await office.get(`/api/admin/payments?q=${checkout.razorpay_payment_id}`);
  assert.equal(history.data.total, 1);
  assert.equal(history.data.rows[0].status, 'PAID');

  const details = await office.get(`/api/admin/payments/${paymentId}`);
  assert.match(details.data.receiptNo, /^KBS\/2026-27\/\d{5}$/);
  assert.equal(details.data.statusLabel, 'PAID');
  assert.equal(details.data.method, 'UPI');
  assert.equal(details.data.collectedBy, 'Online (Test gateway)');
  assert.deepEqual(details.data.items.map((i) => i.feeType).sort(), ['Tuition Fee', 'Transport Fee', ...(LATE ? ['Late Fee', 'Late Fee'] : [])].sort());

  assert.equal((await c.get(`/api/students/${aarav.id}/fees`)).data.due.total, 0);
  const afterBanner = (await office.get('/api/admin/classes')).data.grades.find((g) => g.grade === 'Class 6');
  assert.equal(afterBanner.collected - beforeBanner.collected, AARAV_DUE, 'class-wise collection updated');
  assert.equal(beforeBanner.pending - afterBanner.pending, AARAV_DUE);
  assert.equal(afterBanner.paidStudents, beforeBanner.paidStudents + 1);
});

test('a webhook alone confirms a payment when the browser never reports back', async () => {
  const c = await parentLogin(DEMO.siblingsPhone);
  const kabir = await childNamed(c, 'Kabir Patel');
  const { order, checkout } = await payOnline(c, kabir);
  // No call to /api/payments/verify: the gateway's webhook arrives on its own.
  let status;
  for (let i = 0; i < 20; i++) {
    status = (await c.get(`/api/payment-orders/${order.id}`)).data;
    if (status.status === 'PAID') break;
    await sleep(100);
  }
  assert.equal(status.status, 'PAID');
  const payment = await c.get(`/api/payments/${status.paymentId}`);
  assert.equal(payment.data.txnId, checkout.razorpay_payment_id);
});

test('declined payments are recorded as FAILED and nothing is marked paid', async () => {
  const c = await parentLogin(DEMO.siblingsPhone);
  const diya = await childNamed(c, 'Diya Patel');
  const { order, due, checkout } = await payOnline(c, diya, { outcome: 'failure', method: 'Card' });
  assert.ok(checkout.error);
  let status;
  for (let i = 0; i < 20; i++) {
    status = (await c.get(`/api/payment-orders/${order.id}`)).data;
    if (status.status === 'FAILED') break;
    await sleep(100);
  }
  assert.equal(status.status, 'FAILED');
  assert.equal((await c.get(`/api/students/${diya.id}/fees`)).data.due.total, due);

  const office = await clerkLogin();
  const failed = await office.get(`/api/admin/payments?status=FAILED&q=Diya`);
  assert.ok(failed.data.rows.some((r) => r.orderId === order.id));
});

test('a webhook with the wrong amount is not confirmed', async () => {
  const c = await parentLogin(DEMO.siblingsPhone);
  const diya = await childNamed(c, 'Diya Patel');
  const due = (await c.get(`/api/students/${diya.id}/fees`)).data.due.total;
  const order = (await c.post(`/api/students/${diya.id}/payment-orders`, { amount: due })).data.order;
  const result = await signedWebhook('payment.captured', {
    id: 'pay_short', order_id: order.gatewayOrderId, amount: 100, status: 'captured', method: 'upi', created_at: 1,
  });
  assert.equal(result.data.outcome, 'amount_mismatch');
  assert.equal((await c.get(`/api/payment-orders/${order.id}`)).data.status, 'PENDING');
});

// ---- Counter collections and receipts ---------------------------------------------------------

test('clerk records a counter payment once, even if submitted twice', async () => {
  const clerk = await clerkLogin();
  const [student] = (await clerk.get('/api/admin/students?q=Ishaan%20Verma')).data.students;
  const dues = (await clerk.get(`/api/admin/students/${student.id}/dues`)).data.due;
  const tuition = dues.items.find((i) => i.feeType === 'Tuition Fee');

  assert.equal((await clerk.post(`/api/admin/students/${student.id}/payments`, { method: 'Cheque', feeItemIds: [tuition.id] })).status, 400, 'cheque number required');

  const body = { method: 'Cash', feeItemIds: [tuition.id], amount: tuition.amount, idempotencyKey: 'form-123' };
  const first = await clerk.post(`/api/admin/students/${student.id}/payments`, body);
  const second = await clerk.post(`/api/admin/students/${student.id}/payments`, body);
  assert.equal(first.status, 200, first.data.error);
  assert.equal(second.data.duplicate, true);
  assert.equal(second.data.payment.receiptNo, first.data.payment.receiptNo);
  assert.equal(first.data.payment.collectedBy, 'Sunita Rana');
  assert.equal(first.data.payment.amount, tuition.amount);
  assert.match(first.data.payment.txnId, /^KBS-C-/);

  const remaining = (await clerk.get(`/api/admin/students/${student.id}/dues`)).data.due;
  assert.ok(!remaining.items.some((i) => i.id === tuition.id), 'only the selected fee was paid');
  assert.equal(remaining.items.length, dues.items.length - 1);
});

test('receipts come as a School Copy and a Parent Copy, each one A4 page, and stay as issued', async () => {
  const admin = await adminLogin();
  const [student] = (await admin.get('/api/admin/students?q=Meera%20Iyer')).data.students;
  const paid = await admin.post(`/api/admin/students/${student.id}/payments`, { method: 'UPI', reference: 'UPI 123456789012' });
  const paymentId = paid.data.payment.paymentId;

  // Both copies carry the same details. "Both" puts them on one A4 page,
  // School Copy on top, Parent Copy below a cut line.
  const both = (await admin.get(`/receipts/${paymentId}?copy=both`)).data.toString();
  assert.equal(both.split('<div class="paper').length - 1, 1, 'both copies on one page');
  assert.ok(both.includes('class="cut-line"'));
  const sheets = both.split('<main class="sheet').slice(1);
  assert.equal(sheets.length, 2, 'two copies on the page');
  assert.ok(sheets.every((sheet) => sheet.startsWith(' sheet--half')));
  assert.ok(sheets[0].includes('<span class="copy-label">SCHOOL COPY</span>') && sheets[1].includes('<span class="copy-label">PARENT COPY</span>'));
  for (const text of [
    'MODERN K.B.S. SENIOR SECONDARY SCHOOL',
    '<p>45 Mile, Ladwara, Tehsil Shahpur,</p>',
    '<p>District Kangra, Himachal Pradesh – 176208</p>',
    'PIN – 176208',
    '<h2>FEE RECEIPT</h2>',
    paid.data.payment.receiptNo,
    student.admissionNo,
    student.code,
    '<dt>Class</dt><dd><strong>Class 6</strong></dd>',
    '<dt>Section</dt><dd><strong>B</strong></dd>',
    'Father/Mother Name',
    'Fee Head',
    'Tuition Fee',
    'Admission Fee',
    'Annual Charges',
    'Transport Fee',
    'Examination Fee',
    'Other Fee',
    'Total Amount Paid',
    'Transaction ID / Payment Reference',
    'UPI 123456789012',
    'Rupees',
  ]) {
    for (const sheet of sheets) assert.ok(sheet.includes(text), `both copies show ${text}`);
  }
  const school = (await admin.get(`/receipts/${paymentId}?copy=school`)).data.toString();
  for (const text of ['School Copy – For School Record', 'Clerk Signature:', 'Authorized Signature:', 'Collected By', 'Anil Thakur', 'Print school copy']) {
    assert.ok(school.includes(text), `school copy shows ${text}`);
  }
  assert.ok(!school.includes('PARENT COPY'));
  const parent = (await admin.get(`/receipts/${paymentId}?copy=parent`)).data.toString();
  for (const text of ['PARENT COPY', 'Please keep this receipt for your records.', 'Authorized Signature:', 'Payment Status', 'Print parent copy']) {
    assert.ok(parent.includes(text), `parent copy shows ${text}`);
  }
  assert.ok(!parent.includes('SCHOOL COPY') && !parent.includes('Clerk Signature'));
  assert.ok(both.includes('Print both copies'));
  // Full-page copies are still one A4 page each.
  assert.equal(school.split('<div class="paper').length - 1, 1);
  assert.ok(!school.includes('sheet--half'));
  const css = (await admin.get('/css/receipt.css')).data.toString();
  assert.match(css, /@page \{\s*size: A4 portrait;\s*margin: 10mm;\s*\}/);

  // PDFs: true A4 (595.28 × 841.89 pt), one page per copy, separate files.
  const pdfInfo = (buffer) => {
    const text = buffer.toString('latin1');
    return { pages: Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(text)[1]), boxes: [...new Set(text.match(/\/MediaBox \[[^\]]*\]/g))] };
  };
  for (const copy of ['school', 'parent']) {
    const pdf = await admin.get(`/api/payments/${paymentId}/receipt.pdf?copy=${copy}`);
    assert.equal(pdf.data.subarray(0, 5).toString(), '%PDF-');
    assert.deepEqual(pdfInfo(pdf.data), { pages: 1, boxes: ['/MediaBox [0 0 595.28 841.89]'] });
    assert.match(pdf.headers.get('content-disposition'), new RegExp(`Receipt-KBS-2026-27-\\d+-${copy === 'school' ? 'School' : 'Parent'}-Copy\\.pdf`));
  }
  const bothPdf = await admin.get(`/api/payments/${paymentId}/receipt.pdf?copy=both`);
  assert.deepEqual(pdfInfo(bothPdf.data), { pages: 1, boxes: ['/MediaBox [0 0 595.28 841.89]'] }, 'both copies on one A4 PDF page');
  await admin.get(`/api/payments/${paymentId}/receipt.pdf?copy=both`);

  // Downloads and prints are kept in the receipt's history.
  await admin.post(`/api/admin/payments/${paymentId}/printed`, { copy: 'school' });
  const history = (await admin.get(`/api/admin/payments/${paymentId}`)).data.activity.map((a) => `${a.action}:${a.details?.copy ?? ''}`);
  assert.ok(history.includes('payment.confirmed:'));
  assert.ok(history.includes('receipt.downloaded:school') && history.includes('receipt.downloaded:parent') && history.includes('receipt.printed:school'));

  // Renaming the student later does not rewrite the issued receipt.
  const renamed = await admin.put(`/api/admin/students/${student.id}`, { name: 'Meera S. Iyer' });
  assert.equal(renamed.status, 200, renamed.data.error);
  assert.ok((await admin.get(`/receipts/${paymentId}`)).data.toString().includes('>Meera Iyer<'));
  const audit = await admin.get('/api/admin/audit');
  assert.ok(audit.data.entries.some((e) => e.action === 'student.updated' && e.details.name?.to === 'Meera S. Iyer'));
});

test('parents only ever get the Parent Copy', async () => {
  const parent = await parentLogin('9876543210');
  const clerk = await clerkLogin();
  const [row] = (await clerk.get('/api/admin/payments?status=PAID&q=Aarav')).data.rows;
  const page = (await parent.get(`/receipts/${row.paymentId}?copy=school`)).data.toString();
  assert.ok(page.includes('<span class="copy-label">PARENT COPY</span>'));
  assert.ok(!page.includes('tb-tabs'), 'parents get no copy switcher');
  assert.ok(!page.includes('SCHOOL COPY') && !page.includes('Clerk Signature'));
  const pdf = await parent.get(`/api/payments/${row.paymentId}/receipt.pdf?copy=both`);
  assert.match(pdf.headers.get('content-disposition'), /Parent-Copy\.pdf/);
  const details = (await parent.get(`/api/payments/${row.paymentId}`)).data;
  assert.ok(details.urls.pdf.endsWith('copy=parent') && !JSON.stringify(details.urls).includes('school'));
});

test('WhatsApp sends the Parent Copy with the school’s wording', async () => {
  const clerk = await clerkLogin();
  const [row] = (await clerk.get('/api/admin/payments?status=PAID&q=Aarav')).data.rows;
  await clerk.post(`/api/admin/payments/${row.paymentId}/whatsapp`); // prepares the message in the current wording
  const details = (await clerk.get(`/api/admin/payments/${row.paymentId}`)).data;
  const amount = new Intl.NumberFormat('en-IN').format(details.amount);
  assert.deepEqual(details.whatsapp.body.split('\n'), [
    'Dear Parent,',
    '',
    'Your fee payment has been successfully received.',
    '',
    'Student: Aarav Sharma',
    'Class: Class 6-B',
    `Receipt No.: ${details.receiptNo}`,
    `Amount Paid: ₹${amount}`,
    `Payment Mode: ${details.method}`,
    `Date: ${details.whatsapp.body.match(/Date: (.*)/)[1]}`,
    '',
    'Please find your Parent Copy receipt attached.',
    '',
    'Thank you.',
    '',
    'Modern K.B.S. Senior Secondary School',
    '45 Mile, Ladwara, Tehsil Shahpur,',
    'District Kangra, Himachal Pradesh – 176208',
  ]);
  assert.ok(details.whatsapp.link.startsWith('https://wa.me/919876543210?text=Dear%20Parent'));
  assert.equal(details.whatsapp.state, 'SENT');
  assert.equal(details.whatsapp.openedBy, 'Sunita Rana');

  // Sending again is a re-send, and is recorded as one.
  const again = await clerk.post(`/api/admin/payments/${row.paymentId}/whatsapp`);
  assert.equal(again.data.mode, 'manual');
  const activity = (await clerk.get(`/api/admin/payments/${row.paymentId}`)).data.activity.map((a) => a.action);
  assert.ok(activity.includes('whatsapp.opened') && activity.includes('whatsapp.resent'));
});

test('clerks are told about confirmed payments as they happen', async () => {
  const clerk = await clerkLogin();
  const controller = new AbortController();
  const stream = await fetch(`${base}/api/admin/events`, { headers: { cookie: clerk.cookieHeader() }, signal: controller.signal });
  const reader = stream.body.getReader();
  const received = (async () => {
    let text = '';
    while (!text.includes('event: payment.confirmed')) text += new TextDecoder().decode((await reader.read()).value);
    return JSON.parse(/event: payment\.confirmed\ndata: (.*)/.exec(text)[1]);
  })();

  const [student] = (await clerk.get('/api/admin/students?q=Rohan%20Singh')).data.students;
  await clerk.post(`/api/admin/students/${student.id}/payments`, { method: 'Cash' });
  const card = await received;
  controller.abort();
  assert.equal(card.student.name, 'Rohan Singh');
  assert.equal(card.method, 'Cash');
  assert.match(card.receiptNo, /^KBS\//);
  assert.ok(card.urls.receipt && card.urls.pdf && card.urls.schoolCopyPdf && card.urls.parentCopyPdf && card.whatsapp.link);
  assert.equal(card.whatsapp.state, 'PENDING');
});

// ---- Roles ------------------------------------------------------------------------------------

test('clerks cannot change fees, students, users or confirmed payments', async () => {
  const clerk = await clerkLogin();
  const me = (await clerk.get('/api/admin/me')).data;
  assert.equal(me.staff.role, 'clerk');
  assert.ok(me.permissions.includes('payments.collect'));
  assert.ok(!me.permissions.includes('fees.manage'));

  const [student] = (await clerk.get('/api/admin/students?q=Aarav')).data.students;
  const forbidden = [
    await clerk.get('/api/admin/users'),
    await clerk.post('/api/admin/users', { name: 'X', email: 'x@kbs.test', role: 'admin', password: 'password1' }),
    await clerk.get('/api/admin/fee-structure'),
    await clerk.post('/api/admin/fee-structure', { name: 'X', amount: 1 }),
    await clerk.post('/api/admin/fee-types', { name: 'Hacked Fee' }),
    await clerk.post(`/api/admin/students/${student.id}/status`, { active: false, reason: 'test' }),
    await clerk.post('/api/admin/corrections/1/decision', { approve: true }),
    await clerk.get('/api/admin/system/health'),
    await clerk.post('/api/admin/system/backups'),
    await clerk.get('/api/admin/export/students'),
    await clerk.put(`/api/admin/students/${student.id}`, { name: 'Changed' }),
    await clerk.post('/api/admin/students', { name: 'New Kid' }),
    await clerk.get('/api/admin/audit'),
    await clerk.get('/api/admin/progress?classId=1'),
    await clerk.del('/api/admin/fee-items/1'),
  ];
  for (const res of forbidden) assert.equal(res.status, 403);
  assert.equal((await client().get('/api/admin/payments')).status, 401);
});

test('admins manage staff; switched-off accounts lose access', async () => {
  const admin = await adminLogin();
  const created = await admin.post('/api/admin/users', { name: 'Ravi Kumar', email: 'ravi@kbs.test', role: 'clerk', password: 'counter123' });
  assert.equal(created.status, 200, created.data.error);
  const ravi = await staffLogin('ravi@kbs.test', 'counter123');
  assert.equal((await ravi.get('/api/admin/payments')).status, 200);

  await admin.put(`/api/admin/users/${created.data.user.id}`, { active: false });
  assert.equal((await ravi.get('/api/admin/payments')).status, 401);
  assert.equal((await client().post('/api/admin/login', { email: 'ravi@kbs.test', password: 'counter123' })).status, 403);

  const self = (await admin.get('/api/admin/me')).data.staff;
  assert.equal((await admin.put(`/api/admin/users/${self.id}`, { role: 'clerk' })).status, 400, 'cannot demote yourself');
});

// ---- Reports and exports ----------------------------------------------------------------------

test('class-wise figures add up and match the payments ledger', async () => {
  const clerk = await clerkLogin();
  const { grades } = (await clerk.get('/api/admin/classes')).data;
  assert.deepEqual(grades.map((g) => g.grade), ['Nursery', 'LKG', 'UKG', ...Array.from({ length: 12 }, (_, i) => `Class ${i + 1}`)]);
  for (const g of grades) {
    assert.equal(g.paidStudents + g.pendingStudents, g.totalStudents, g.grade);
    assert.equal(g.sections.reduce((t, s) => t + s.totalStudents, 0), g.totalStudents);
  }
  const dash = (await clerk.get('/api/admin/dashboard')).data;
  assert.equal(grades.reduce((t, g) => t + g.collected, 0), dash.yearCollection.amount);
  assert.equal(grades.reduce((t, g) => t + g.pending, 0), dash.pendingFees.amount);
  assert.ok(dash.todayCollection.amount > 0);

  const pending = (await clerk.get('/api/admin/reports/pending?grade=Class%206&section=B')).data;
  assert.ok(pending.rows.every((r) => r.grade === 'Class 6' && r.section === 'B' && r.pending > 0));
});

test('exports are valid Excel and CSV with the register fields', async () => {
  const clerk = await clerkLogin();
  const xlsx = await clerk.get('/api/admin/export/payments?grade=Class%206&format=xlsx');
  assert.equal(xlsx.status, 200);
  assert.equal(xlsx.type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(xlsx.data.subarray(0, 4).toString('hex'), '504b0304', 'a zip file');

  const csv = (await clerk.get('/api/admin/export/payments?grade=Class%206&status=PAID&format=csv')).data.toString('utf8');
  const [header, ...rows] = csv.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(
    header,
    "Student ID,Admission Number,Student Name,Father's/Mother's Name,Class,Section,Fee Type,Fee Details,Amount,Payment Mode,Transaction ID,Payment Date,Payment Time,Payment Status,Receipt Number,Collected By",
  );
  assert.ok(rows.length > 0 && rows.every((r) => r.includes(',Class 6,') && r.includes(',PAID,')));

  for (const name of ['daily', 'monthly', 'class-wise', 'modes', 'pending']) {
    const res = await clerk.get(`/api/admin/export/${name}?format=xlsx`);
    assert.equal(res.status, 200, name);
  }
});
