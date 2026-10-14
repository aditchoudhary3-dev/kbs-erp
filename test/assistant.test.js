// Tests for the KBS AI Assistant: answers come from the database, clerks
// keep clerk limits, nothing changes without confirmation, every confirmed
// change is audited, and the Claude connection only ever sees tool results.
// Also: WhatsApp sends the Parent Copy, and payments never fail because of it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.QUIET = '1';
process.env.TEST_GATEWAY_DUPLICATE_WEBHOOKS = 'off';
process.env.ASSISTANT_MESSAGES_PER_MINUTE = '1000';

const { startServer } = await import('../server/app.js');
const { DEMO } = await import('../server/seed.js');
const { config } = await import('../server/config.js');
const database = await import('../server/db.js'); // read .db after the server opens it
const { resetWhatsapp } = await import('../server/integrations/whatsapp/index.js');

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

async function login(email, password) {
  const res = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  assert.equal(res.status, 200);
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const request = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };
  return {
    get: (path) => request('GET', path),
    post: (path, body = {}) => request('POST', path, body),
    ask: async (message, extra = {}) => (await request('POST', '/api/admin/assistant/chat', { message, ...extra })).data,
  };
}
const admin = () => login(DEMO.adminEmail, DEMO.adminPassword);
const clerk = () => login(DEMO.clerkEmail, DEMO.clerkPassword);

async function mockServer(handler) {
  const calls = [];
  const srv = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
    calls.push(call);
    const { status = 200, json } = await handler(call, calls.length);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(json));
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${srv.address().port}`, calls, close: () => srv.close() };
}

test('answers come from the database, not made up', async () => {
  const c = await clerk();
  const dashboard = (await c.get('/api/admin/dashboard')).data;

  const total = await c.ask('What was the total collection today?');
  assert.ok(total.reply.text.includes(`₹${new Intl.NumberFormat('en-IN').format(dashboard.todayCollection.amount)}`), total.reply.text);

  const aarav = await c.ask('How much fee is pending for Aarav Sharma?');
  const [{ id: aaravId }] = (await c.get('/api/admin/students?q=Aarav%20Sharma')).data.students;
  const due = (await c.get(`/api/admin/students/${aaravId}/dues`)).data.due.total;
  assert.match(aarav.reply.text, new RegExp(`Aarav Sharma \\(Class 6-B\\) has ₹${new Intl.NumberFormat('en-IN').format(due)} pending`));
  const fees = aarav.reply.cards[0];
  assert.equal(fees.type, 'student-fees');
  assert.equal(fees.due.total, due);

  const pending = await c.ask('Show Class 8 pending fees.');
  const report = (await c.get('/api/admin/reports/pending?grade=Class%208')).data;
  assert.equal(pending.reply.cards[0].totals.pending, report.totals.pending);
  assert.ok(pending.reply.cards[0].export.href.startsWith('/api/admin/export/pending?grade=Class+8'));

  const receipt = await c.ask('Find receipt number 25');
  assert.equal(receipt.reply.cards[0].type, 'receipt');
  assert.equal(receipt.reply.cards[0].payment.receiptNo, 'KBS/2026-27/00025');

  const nobody = await c.ask('How much fee is pending for Zzyzx Qwerty?');
  assert.match(nobody.reply.text, /could not find/);
});

test('the example questions are understood', async () => {
  const a = await admin();
  // A cash payment today, so "today's cash collection" has something to list.
  const owing = (await a.get('/api/admin/reports/pending?grade=Class%209')).data.rows[0];
  const dues = (await a.get(`/api/admin/students/${owing.id}/dues`)).data.due;
  await a.post(`/api/admin/students/${owing.id}/payments`, { method: 'Cash', feeItemIds: [dues.items[0].id], expectedTotal: dues.items[0].amount, idempotencyKey: 'today-cash' });
  const expect = {
    'Show Class 8 pending fees.': 'table',
    'How much cash was collected today?': 'stats',
    'How much online payment was received today?': 'stats',
    'What was the total collection this month?': 'stats',
    'Show today’s payments.': 'table',
    'Show Class 10 students who have pending fees.': 'table',
    'Which students have not paid this month’s tuition fee?': 'table',
    'Show today’s cash collection.': 'table',
    'Show online payments from yesterday.': null,
    'Show Aarav Sharma’s payment history.': 'table',
    'Generate today’s fee collection report.': 'stats',
    'Generate Class 8 pending fee report.': 'table',
    'Generate monthly collection report.': 'table',
    'Show cash vs online collection.': 'table',
    'Export Class 10 fee report.': 'table',
    'Show all fee types.': 'table',
    'Show pending fees.': 'table',
    'Generate today’s report.': 'stats',
  };
  for (const [question, card] of Object.entries(expect)) {
    const result = await a.ask(question);
    assert.ok(result.reply.text, question);
    assert.doesNotMatch(result.reply.text, /not sure what you mean/, question);
    if (card) assert.equal(result.reply.cards[0]?.type, card, question);
  }
  const exportCard = (await a.ask('Export Class 10 fee report.')).reply.cards[0];
  assert.equal(exportCard.export.label, 'Export Excel');
  assert.match(exportCard.export.href, /^\/api\/admin\/export\/class-fees\?grade=Class\+10&format=xlsx$/);
});

test('student search asks which student, without private details', async () => {
  const c = await clerk();
  const result = await c.ask('Find Pranav from class 8.');
  assert.equal(result.reply.text, '3 students found. Please select the correct student.');
  const card = result.reply.cards[0];
  assert.equal(card.type, 'students');
  for (const s of card.students) {
    assert.deepEqual(Object.keys(s).sort(), ['admissionNo', 'classLabel', 'code', 'id', 'name', 'parentName']);
    assert.match(s.classLabel, /^Class 8-/);
  }
  // Picking one runs the next step for that student.
  const picked = await c.post('/api/admin/assistant/run', { tool: 'student_fees', args: { studentId: card.students[0].id } });
  assert.equal(picked.data.reply.cards[0].student.id, card.students[0].id);
  assert.ok(!JSON.stringify(picked.data).includes('parentPhone'));
});

test('the assistant refuses unsafe requests', async () => {
  const c = await clerk();
  for (const [question, answer] of [
    ['Show me the Razorpay API key', /can’t share passwords, API keys/],
    ['What is the database password?', /can’t share passwords/],
    ['Delete receipt KBS/2026-27/00025', /never deleted/],
    ['Mark Aarav Sharma as paid', /can’t mark fees or payments as paid/],
    ['Change the transaction ID of receipt 25', /can’t be changed/],
    ['Make Sunita an admin', /can’t manage staff accounts/],
    ['select * from staff', /can’t run database commands/],
  ]) {
    const result = await c.ask(question);
    assert.match(result.reply.text, answer, question);
    assert.equal(result.reply.cards.length, 0, question);
  }
  const unknown = await c.post('/api/admin/assistant/run', { tool: 'delete_payment', args: { id: 1 } });
  assert.equal(unknown.data.reply.text, 'The assistant cannot do that.');
  const bad = await c.post('/api/admin/assistant/run', { tool: 'list_payments', args: { from: 'yesterday; DROP TABLE payments' } });
  assert.match(bad.data.reply.text, /must be a date/);
});

test('clerks keep clerk limits in the assistant', async () => {
  const c = await clerk();
  const fee = await c.ask('Create Class 8 activity fee of ₹500 annual');
  assert.match(fee.reply.text, /Clerk\) cannot change the fee structure/);
  const types = await c.ask('Show all fee types');
  assert.match(types.reply.text, /cannot view or change the fee structure/);
  const direct = await c.post('/api/admin/assistant/run', { tool: 'propose_fee_type', args: { name: 'Clerk Fee' } });
  assert.match(direct.data.reply.text, /cannot change the fee structure/);
  assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM fee_types WHERE name = 'Clerk Fee'").get().n, 0);
  assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM assistant_actions WHERE kind IN ('fee', 'fee_type')").get().n, 0);
});

test('a cash payment waits for confirmation, then is recorded once and audited', async () => {
  const c = await clerk();
  const [student] = (await c.get('/api/admin/students?q=Rahul%20Verma')).data.students;
  const before = (await c.get(`/api/admin/students/${student.id}/dues`)).data.due.total;
  const paymentsBefore = database.db.prepare('SELECT COUNT(*) AS n FROM payments').get().n;

  const proposal = await c.ask('Record cash payment of ₹5,000 for Rahul Verma');
  assert.equal(proposal.reply.text, 'Cash payment of ₹5,000 is ready to be recorded for Rahul Verma. Do you want to proceed?');
  const card = proposal.reply.cards[0];
  assert.equal(card.type, 'confirm');
  assert.equal(card.status, 'pending');
  assert.equal(card.confirmLabel, 'Confirm payment');
  assert.deepEqual(card.lines.find(([label]) => label === 'Collected By'), ['Collected By', 'Sunita Rana']);

  // Nothing has changed yet.
  assert.equal(database.db.prepare('SELECT COUNT(*) AS n FROM payments').get().n, paymentsBefore);
  assert.equal((await c.get(`/api/admin/students/${student.id}/dues`)).data.due.total, before);

  // Another member of staff cannot confirm it.
  const a = await admin();
  assert.equal((await a.post(`/api/admin/assistant/actions/${card.actionId}/confirm`)).status, 404);

  const done = await c.post(`/api/admin/assistant/actions/${card.actionId}/confirm`);
  assert.equal(done.status, 200, done.data.error);
  assert.equal(done.data.card.status, 'confirmed');
  const payment = done.data.cards[0].payment;
  assert.equal(payment.amount, 5000);
  assert.equal(payment.method, 'Cash');
  assert.equal(payment.collectedBy, 'Sunita Rana');
  assert.ok(!('toPhone' in (payment.whatsapp ?? {})));
  assert.equal((await c.get(`/api/admin/students/${student.id}/dues`)).data.due.total, before - 5000);

  // Confirming again changes nothing.
  const again = await c.post(`/api/admin/assistant/actions/${card.actionId}/confirm`);
  assert.equal(again.data.cards[0].payment.paymentId, payment.paymentId);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS n FROM payments').get().n, paymentsBefore + 1);

  // The audit log names the person, the assistant, the action, the record and the result.
  const entries = (await a.get('/api/admin/audit?via=ai')).data.entries;
  const recorded = entries.find((e) => e.action === 'ai.payment_recorded' && e.details.actionId === card.actionId);
  assert.equal(recorded.actor, `staff:${database.db.prepare("SELECT id FROM staff WHERE name = 'Sunita Rana'").get().id} (Sunita Rana)`);
  assert.equal(recorded.via, 'KBS AI Assistant');
  assert.equal(recorded.entity, 'payment');
  assert.equal(recorded.entityId, String(payment.paymentId));
  assert.equal(recorded.details.result, 'success');
  assert.ok(entries.some((e) => e.action === 'payment.confirmed' && e.entityId === String(payment.paymentId) && e.via === 'KBS AI Assistant'));
});

test('proposals can be cancelled, and expire', async () => {
  const c = await clerk();
  const paymentsBefore = database.db.prepare('SELECT COUNT(*) AS n FROM payments').get().n;
  const one = (await c.ask('Record cash payment of ₹1,000 for Aarav Sharma')).reply.cards[0];
  const cancelled = await c.post(`/api/admin/assistant/actions/${one.actionId}/cancel`);
  assert.equal(cancelled.data.text, 'Cancelled. Nothing was changed.');
  assert.equal((await c.post(`/api/admin/assistant/actions/${one.actionId}/confirm`)).status, 409);

  const two = (await c.ask('Record cash payment of ₹1,000 for Aarav Sharma')).reply.cards[0];
  database.db.prepare('UPDATE assistant_actions SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), two.actionId);
  const late = await c.post(`/api/admin/assistant/actions/${two.actionId}/confirm`);
  assert.equal(late.status, 409);
  assert.match(late.data.error, /expired/);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS n FROM payments').get().n, paymentsBefore);

  const tooMuch = await c.ask('Record cash payment of ₹9,99,999 for Aarav Sharma');
  assert.match(tooMuch.reply.text, /more than everything Aarav Sharma owes/);
});

test('admins add fee types and fees only after confirming the exact change', async () => {
  const a = await admin();
  const ask = await a.ask('Add a new fee type.');
  assert.match(ask.reply.text, /What should the new fee type be called/);
  const named = await a.ask('Library Fee', { followUp: ask.followUp });
  assert.equal(named.reply.cards[0].type, 'confirm');
  assert.deepEqual(named.reply.cards[0].lines, [['Fee Type', 'Library Fee']]);
  assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM fee_types WHERE name = 'Library Fee'").get().n, 0);
  await a.post(`/api/admin/assistant/actions/${named.reply.cards[0].actionId}/confirm`);
  assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM fee_types WHERE name = 'Library Fee'").get().n, 1);

  const question = await a.ask('Create Class 8 monthly tuition fee.');
  assert.match(question.reply.text, /What is the monthly amount for Class 8 Tuition Fee/);
  const proposal = await a.ask('₹500', { followUp: question.followUp });
  const card = proposal.reply.cards[0];
  const line = (label) => card.lines.find(([l]) => l === label)?.[1];
  assert.equal(line('Fee Name'), 'Tuition Fee');
  assert.equal(line('Class'), 'Class 8');
  assert.equal(line('Amount'), '₹500');
  assert.equal(line('Frequency'), 'Monthly');
  const structures = () => database.db.prepare("SELECT COUNT(*) AS n FROM fee_structures WHERE grade = 'Class 8' AND amount = 500 AND frequency = 'Monthly'").get().n;
  assert.equal(structures(), 0);
  const done = await a.post(`/api/admin/assistant/actions/${card.actionId}/confirm`);
  assert.equal(done.status, 200, done.data.error);
  assert.equal(structures(), 1);
  assert.match(done.data.text, /Fee added: Tuition Fee for Class 8, ₹500 monthly/);
  const audit = (await a.get('/api/admin/audit?via=ai')).data.entries;
  assert.ok(audit.some((e) => e.action === 'ai.fee_added' && e.details.result === 'success'));
  assert.ok(audit.some((e) => e.action === 'fee_structure.created' && e.via === 'KBS AI Assistant'));
});

test('KBS AI Daily Summary is worked out from the database', async () => {
  const a = await admin();
  const summary = (await a.get('/api/admin/assistant/insights')).data;
  const dashboard = (await a.get('/api/admin/dashboard')).data;
  assert.equal(summary.collection.amount, dashboard.todayCollection.amount);
  assert.equal(summary.collection.count, dashboard.todayCollection.count);
  assert.equal(summary.collection.cash + summary.collection.online + summary.collection.otherCounter, summary.collection.amount);
  assert.equal(summary.pendingAccounts.students, dashboard.pendingFees.students);
  assert.ok(Array.isArray(summary.issues));
  assert.match(summary.headline, /₹/);
});

test('with Claude, the model only sees permitted tools and their results', async () => {
  const c = await clerk();
  const today = (await c.get('/api/admin/dashboard')).data.todayCollection.amount;
  const claude = await mockServer((call, n) => {
    const body = JSON.parse(call.body);
    if (n === 1) {
      return { json: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'tu_1', name: 'collection_summary', input: { period: 'today' } }] } };
    }
    const result = body.messages.at(-1).content[0];
    return { json: { stop_reason: 'end_turn', content: [{ type: 'text', text: `Today: ${JSON.parse(result.content).total.amount}` }] } };
  });
  Object.assign(config.assistant, { provider: 'claude' });
  Object.assign(config.assistant.claude, { apiKey: 'test-anthropic-key', apiBase: claude.url });
  try {
    const result = await c.ask('How much came in today?');
    assert.equal(result.mode, 'claude');
    assert.equal(result.reply.text, `Today: ${today}`);
    assert.equal(result.reply.cards[0].type, 'stats');

    const first = JSON.parse(claude.calls[0].body);
    assert.equal(claude.calls[0].headers['x-api-key'], 'test-anthropic-key');
    assert.equal(first.model, config.assistant.claude.model);
    const names = first.tools.map((t) => t.name);
    assert.ok(names.includes('propose_cash_payment') && names.includes('collection_summary'));
    assert.ok(!names.includes('propose_fee') && !names.includes('list_fee_types'), 'a clerk is not offered admin tools');
    const sent = claude.calls.map((call) => call.body.toString()).join('\n');
    for (const secret of [config.payments.test.keySecret, config.payments.test.webhookSecret, 'test-anthropic-key', 'clerk1234', 'admin1234']) {
      assert.ok(!sent.includes(secret), 'no secrets reach the model');
    }
    assert.ok(!/9876543210/.test(sent), 'no phone numbers reach the model');

    // If Claude is unreachable, the built-in assistant answers instead.
    claude.close();
    Object.assign(config.assistant.claude, { apiBase: 'http://127.0.0.1:9' });
    const fallback = await c.ask('How much cash was collected today?');
    assert.equal(fallback.mode, 'built-in');
    assert.match(fallback.notice, /could not be reached/);
    assert.match(fallback.reply.text, /in cash today/);
  } finally {
    Object.assign(config.assistant, { provider: 'built-in' });
  }
});

test('WhatsApp Cloud API sends the Parent Copy; a WhatsApp outage never fails a payment', async () => {
  let fail = true;
  const meta = await mockServer(({ url }) => {
    if (fail) return { status: 503, json: { error: { message: 'Service unavailable' } } };
    if (url.endsWith('/media')) return { json: { id: 'media_1' } };
    return { json: { messages: [{ id: 'wamid.1' }] } };
  });
  Object.assign(config.whatsapp, { provider: 'cloud' });
  Object.assign(config.whatsapp.cloud, { token: 'wa-token', phoneNumberId: '123', apiBase: meta.url, templateName: 'fee_receipt' });
  resetWhatsapp();
  try {
    const c = await clerk();
    const [student] = (await c.get('/api/admin/students?q=Diya')).data.students;
    const paid = await c.post(`/api/admin/students/${student.id}/payments`, { method: 'Cash' });
    assert.equal(paid.status, 200, 'the payment succeeds while WhatsApp is down');
    const paymentId = paid.data.payment.paymentId;
    await new Promise((resolve) => setTimeout(resolve, 100));
    let details = (await c.get(`/api/admin/payments/${paymentId}`)).data;
    assert.equal(details.whatsapp.state, 'PENDING');
    assert.match(details.whatsapp.detail, /retrying automatically/);

    const queued = await c.post(`/api/admin/payments/${paymentId}/whatsapp`);
    assert.equal(queued.status, 200);
    assert.equal(queued.data.queued, true);

    fail = false;
    const sent = await c.post(`/api/admin/payments/${paymentId}/whatsapp`);
    assert.equal(sent.data.message.state, 'SENT');
    const upload = meta.calls.filter((call) => call.url.endsWith('/media')).at(-1).body.toString('latin1');
    assert.match(upload, /filename="Receipt-KBS-2026-27-\d+-Parent-Copy\.pdf"/);
    assert.ok(upload.includes('PARENT COPY') || upload.includes('%PDF-'));
    const message = JSON.parse(meta.calls.at(-1).body);
    assert.equal(message.template.name, 'fee_receipt');
    assert.deepEqual(
      message.template.components[1].parameters.map((p) => p.text),
      [details.student.name, details.student.classLabel, details.receiptNo, new Intl.NumberFormat('en-IN').format(details.amount), 'Cash', message.template.components[1].parameters[5].text],
    );
    assert.equal(message.template.components[0].parameters[0].document.filename.endsWith('Parent-Copy.pdf'), true);
    details = (await c.get(`/api/admin/payments/${paymentId}`)).data;
    assert.equal(details.whatsapp.state, 'SENT');
  } finally {
    meta.close();
    Object.assign(config.whatsapp, { provider: 'click-to-chat' });
    resetWhatsapp();
  }
});
