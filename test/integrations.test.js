// Tests for the pluggable integrations (without real accounts: each talks to a
// local mock of the provider's API) and for upgrading older databases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';

import { createRazorpay } from '../server/integrations/payments/razorpay.js';
import { createCloudApi } from '../server/integrations/whatsapp/cloud-api.js';
import { exportTable } from '../server/integrations/export/index.js';
import { MIGRATIONS } from '../server/migrations.js';
import { amountInWords } from '../shared/format.js';

// Starts a throwaway HTTP server; `handler` gets { method, url, headers, body }.
async function mockServer(handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
    calls.push(call);
    const { status = 200, json } = await handler(call);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(json));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() };
}

test('Razorpay provider: orders, payment lookup and signatures', async () => {
  const api = await mockServer(({ method, url }) => {
    if (method === 'POST' && url === '/v1/orders') return { json: { id: 'order_ABC', amount: 1550000, status: 'created' } };
    if (url === '/v1/payments/pay_XYZ') {
      return { json: { id: 'pay_XYZ', order_id: 'order_ABC', amount: 1550000, status: 'captured', method: 'netbanking', created_at: 1790000000 } };
    }
    if (url === '/v1/orders/order_ABC/payments') return { json: { items: [{ id: 'pay_XYZ', order_id: 'order_ABC', amount: 1550000, status: 'captured', method: 'upi', created_at: 1 }] } };
    return { status: 404, json: { error: { description: 'not found' } } };
  });
  const rzp = createRazorpay({ keyId: 'rzp_test_key', keySecret: 'secret', webhookSecret: 'whsec', apiBase: api.url });

  const order = await rzp.createOrder({ amountPaise: 1550000, receipt: 'r1', notes: { a: '1' } });
  assert.equal(order.id, 'order_ABC');
  const sent = JSON.parse(api.calls[0].body);
  assert.deepEqual([sent.amount, sent.currency, sent.receipt], [1550000, 'INR', 'r1']);
  assert.equal(api.calls[0].headers.authorization, `Basic ${Buffer.from('rzp_test_key:secret').toString('base64')}`);

  const payment = await rzp.fetchPayment('pay_XYZ');
  assert.deepEqual([payment.orderId, payment.amountPaise, payment.status, payment.method], ['order_ABC', 1550000, 'captured', 'Net banking']);
  assert.equal((await rzp.fetchOrderPayments('order_ABC')).length, 1);
  await assert.rejects(rzp.fetchPayment('pay_missing'), /not found/);

  const signature = crypto.createHmac('sha256', 'secret').update('order_ABC|pay_XYZ').digest('hex');
  assert.ok(rzp.verifyCheckoutSignature({ orderId: 'order_ABC', paymentId: 'pay_XYZ', signature }));
  assert.ok(!rzp.verifyCheckoutSignature({ orderId: 'order_ABC', paymentId: 'pay_OTHER', signature }));

  const body = Buffer.from('{"event":"payment.captured"}');
  const good = crypto.createHmac('sha256', 'whsec').update(body).digest('hex');
  assert.ok(rzp.verifyWebhook(body, { 'x-razorpay-signature': good }));
  assert.ok(!rzp.verifyWebhook(Buffer.from('{"event":"payment.captured "}'), { 'x-razorpay-signature': good }));
  assert.equal(rzp.parseWebhook(JSON.parse(body), { 'x-razorpay-event-id': 'evt_1' }, body).eventId, 'evt_1');
  api.close();
});

test('WhatsApp Cloud API provider: uploads the receipt PDF and sends the approved template', async () => {
  const api = await mockServer(({ url }) => {
    if (url.endsWith('/media')) return { json: { id: 'media-123' } };
    if (url.endsWith('/messages')) return { json: { messages: [{ id: 'wamid.ABC' }] } };
    return { status: 404, json: { error: { message: 'nope' } } };
  });
  const wa = createCloudApi({
    token: 'EAAG-token',
    phoneNumberId: '1098765',
    apiBase: api.url,
    apiVersion: 'v21.0',
    templateName: 'fee_receipt',
    templateLanguage: 'en',
  });
  const result = await wa.send({
    to: '919876543210',
    text: 'Dear Parent, ...',
    templateParams: ['Aarav Sharma', 'Class 6-B', '15,500', 'KBS/2026-27/00001', '29 Sep 2026'],
    document: { buffer: Buffer.from('%PDF-1.4 test'), filename: 'Receipt-KBS-2026-27-00001.pdf' },
  });
  assert.equal(result.providerMessageId, 'wamid.ABC');

  const [upload, message] = api.calls;
  assert.equal(upload.url, '/v21.0/1098765/media');
  assert.equal(upload.headers.authorization, 'Bearer EAAG-token');
  assert.match(upload.headers['content-type'], /^multipart\/form-data/);
  assert.ok(upload.body.includes('%PDF-1.4 test'));

  assert.equal(message.url, '/v21.0/1098765/messages');
  const payload = JSON.parse(message.body);
  assert.equal(payload.to, '919876543210');
  assert.equal(payload.type, 'template');
  assert.equal(payload.template.name, 'fee_receipt');
  assert.deepEqual(payload.template.components[0].parameters[0].document, { id: 'media-123', filename: 'Receipt-KBS-2026-27-00001.pdf' });
  assert.deepEqual(payload.template.components[1].parameters.map((p) => p.text), ['Aarav Sharma', 'Class 6-B', '15,500', 'KBS/2026-27/00001', '29 Sep 2026']);
  api.close();

  const failing = await mockServer(() => ({ status: 400, json: { error: { message: '(#131047) Re-engagement message' } } }));
  const wa2 = createCloudApi({ token: 't', phoneNumberId: '1', apiBase: failing.url, apiVersion: 'v21.0' });
  await assert.rejects(wa2.send({ to: '91', text: 'hi', templateParams: [] }), /Re-engagement/);
  failing.close();
});

test('Excel export is a well-formed workbook', () => {
  const { buffer } = exportTable('xlsx', {
    sheetName: 'Fee register',
    columns: [
      { key: 'name', header: 'Student Name' },
      { key: 'amount', header: 'Amount', type: 'money' },
      { key: 'date', header: 'Payment Date', type: 'date' },
    ],
    rows: [{ name: 'Aarav <& "Sharma">', amount: 15500, date: '2026-09-29' }],
  });
  // Walk the zip's central directory and inflate each part.
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const parts = {};
  for (let i = 0; i < count; i++) {
    const nameLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString();
    const local = buffer.readUInt32LE(offset + 42);
    const size = buffer.readUInt32LE(offset + 20);
    const crc = buffer.readUInt32LE(offset + 16);
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26);
    const data = zlib.inflateRawSync(buffer.subarray(dataStart, dataStart + size));
    assert.equal(zlib.crc32(data), crc, `${name} checksum`);
    parts[name] = data.toString();
    offset += 46 + nameLength;
  }
  assert.deepEqual(Object.keys(parts).sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
  const sheet = parts['xl/worksheets/sheet1.xml'];
  assert.ok(sheet.includes('Aarav &lt;&amp; &quot;Sharma&quot;&gt;'));
  assert.ok(sheet.includes('<v>15500</v>'));
  assert.ok(sheet.includes('<v>46294</v>'), '29 Sep 2026 as an Excel date');
});

test('amounts in words use Indian numbering', () => {
  assert.equal(amountInWords(15500), 'Rupees Fifteen Thousand Five Hundred Only');
  assert.equal(amountInWords(125000), 'Rupees One Lakh Twenty Five Thousand Only');
  assert.equal(amountInWords(10000000), 'Rupees One Crore Only');
});

test('a database from the previous version is upgraded without losing payments', () => {
  const db = new DatabaseSync(':memory:');
  MIGRATIONS[0].up(db);
  db.exec(`
    INSERT INTO classes (id, name) VALUES (1, '6-B');
    INSERT INTO students (id, name, class_id, roll_no, parent_name, parent_phone, created_at)
      VALUES (1, 'Aarav Sharma', 1, 14, 'Priya Sharma', '9876543210', '2026-04-01T00:00:00Z');
    INSERT INTO admins (id, email, name, password_hash) VALUES (1, 'office@school.test', 'Office', 'x');
    INSERT INTO payments (id, student_id, amount, method, receipt_no, txn_id, paid_at, recorded_by)
      VALUES (1, 1, 5000, 'Card', 'RCPT/2026-27/0001', 'pay_old', '2026-04-02T05:10:00Z', 'parent');
    INSERT INTO fee_items (student_id, title, amount, due_date, payment_id, created_at)
      VALUES (1, 'Annual charges', 5000, '2026-04-10', 1, '2026-04-01T00:00:00Z'),
             (1, 'Tuition · Term 2', 12500, '2026-10-10', NULL, '2026-09-01T00:00:00Z');
  `);
  MIGRATIONS[1].up(db);

  const cls = db.prepare('SELECT grade, section, name FROM classes').get();
  assert.deepEqual({ ...cls }, { grade: 'Class 6', section: 'B', name: '6-B' });
  assert.equal(db.prepare('SELECT admission_no FROM students').get().admission_no, 'KBS/2026/0001');
  assert.equal(db.prepare('SELECT role FROM staff').get().role, 'admin');
  assert.deepEqual(db.prepare('SELECT fee_type FROM fee_items ORDER BY id').all().map((r) => r.fee_type), ['Annual charges', 'Tuition']);

  const payment = db.prepare('SELECT * FROM payments').get();
  assert.equal(payment.status, 'confirmed');
  assert.equal(payment.gateway_payment_id, 'pay_old');
  const receipt = JSON.parse(payment.receipt_snapshot);
  assert.equal(receipt.receiptNo, 'RCPT/2026-27/0001');
  assert.equal(receipt.student.classLabel, 'Class 6-B');
  assert.equal(db.prepare('SELECT status FROM payment_orders WHERE id = ?').get(payment.order_id).status, 'paid');

  // The same gateway payment can never be recorded twice.
  assert.throws(() =>
    db.prepare("INSERT INTO payments (student_id, amount, method, receipt_no, paid_at, gateway, gateway_payment_id) VALUES (1, 1, 'UPI', 'R2', 'x', 'test', 'pay_old')").run(),
  /UNIQUE/);
});
