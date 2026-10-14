// Tests for the ERP modules: Add Student, fee structure, cash collection
// (part payments, change), payment corrections and system pages.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.QUIET = '1';
process.env.TEST_GATEWAY_DUPLICATE_WEBHOOKS = 'off';

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

function client() {
  const jar = new Map();
  async function request(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const header of res.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const [name, value] = pair.split('=');
      if (value) jar.set(name, value);
      else jar.delete(name);
    }
    const type = res.headers.get('content-type') || '';
    return { status: res.status, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  }
  return {
    get: (p) => request('GET', p),
    post: (p, b = {}) => request('POST', p, b),
    put: (p, b) => request('PUT', p, b),
  };
}

async function login(email, password) {
  const c = client();
  const res = await c.post('/api/admin/login', { email, password });
  assert.equal(res.status, 200, res.data.error);
  return c;
}
const admin = () => login(DEMO.adminEmail, DEMO.adminPassword);
const clerk = () => login(DEMO.clerkEmail, DEMO.clerkPassword);

const NEW_STUDENT = {
  name: 'Rahul Sharma',
  admissionNo: 'KBS/2026/0901',
  dob: '2013-05-14',
  gender: 'Male',
  fatherName: 'Sanjeev Sharma',
  motherName: 'Anita Sharma',
  parentPhone: '98160 12345',
  altPhone: '94180 55555',
  address: 'Village Ladwara, Tehsil Shahpur, District Kangra, H.P.',
  grade: 'Class 8',
  section: 'A',
  session: '2026-27',
  admissionDate: '2026-09-15',
  transport: 'Yes',
  busRoute: 'Route 1 – Shahpur',
  remarks: 'Joined mid-session',
  status: 'Active',
};

test('Add Student validates, rejects duplicates and creates the fee account', async () => {
  const office = await admin();
  const code = (await office.get('/api/admin/students/next-code')).data.code;
  assert.match(code, /^STU\d{5}$/);

  const missing = await office.post('/api/admin/students', { ...NEW_STUDENT, dob: '' });
  assert.equal(missing.status, 400);
  assert.match(missing.data.error, /date of birth/);
  const noRoute = await office.post('/api/admin/students', { ...NEW_STUDENT, busRoute: '' });
  assert.equal(noRoute.status, 400, 'transport needs a bus route');

  const saved = await office.post('/api/admin/students', NEW_STUDENT);
  assert.equal(saved.status, 200, saved.data.error);
  assert.equal(saved.data.message, 'Student added successfully.');
  assert.equal(saved.data.student.code, code);
  assert.equal(saved.data.student.classLabel, 'Class 8-A');
  assert.ok(saved.data.feeAccount.added > 0);

  const again = await office.post('/api/admin/students', NEW_STUDENT);
  assert.equal(again.status, 409);
  assert.match(again.data.error, /Admission number/);
  const twin = await office.post('/api/admin/students', { ...NEW_STUDENT, admissionNo: 'KBS/2026/0902' });
  assert.equal(twin.status, 409);
  assert.match(twin.data.error, /already registered/);

  // The fee account follows the class's fee structure and the admission date.
  const profile = (await office.get(`/api/admin/students/${saved.data.student.id}`)).data;
  const titles = profile.account.map((i) => i.title);
  assert.ok(titles.includes('Admission Fee'), 'new admissions pay the admission fee');
  assert.ok(titles.includes('Annual Charges'));
  assert.ok(titles.includes('Tuition Fee · Term 2'));
  assert.ok(!titles.includes('Tuition Fee · Term 1'), 'a September joiner is not charged for July');
  assert.ok(titles.includes('Transport Fee · Oct–Dec'));
  assert.ok(!titles.includes('Computer Fee · Oct–Dec'), 'optional fees are not added automatically');
  assert.equal(profile.account.find((i) => i.title === 'Admission Fee').dueDate, '2026-09-15');
});

test('students are deactivated, never deleted, and keep their payment history', async () => {
  const office = await admin();
  const [student] = (await office.get('/api/admin/students?q=Rahul%20Sharma')).data.students;
  const paid = await office.post(`/api/admin/students/${student.id}/payments`, { method: 'Cash' });
  assert.equal(paid.status, 200, paid.data.error);

  assert.equal((await office.post(`/api/admin/students/${student.id}/status`, { active: false })).status, 400, 'a reason is needed');
  const off = await office.post(`/api/admin/students/${student.id}/status`, { active: false, reason: 'Left school' });
  assert.equal(off.data.student.status, 'Inactive');
  assert.ok(off.data.feeAccount.removed > 0, 'future unpaid fees are removed');

  const inactive = (await office.get('/api/admin/students?status=inactive&q=Rahul')).data.students;
  assert.equal(inactive.length, 1);
  const history = (await office.get(`/api/admin/students/${student.id}`)).data.payments;
  assert.ok(history.some((p) => p.receiptNo === paid.data.payment.receiptNo), 'payments are kept');
  assert.equal((await office.post(`/api/admin/students/${student.id}/payments`, { method: 'Cash' })).status, 409, 'no collection from inactive students');

  const on = await office.post(`/api/admin/students/${student.id}/status`, { active: true });
  assert.equal(on.data.student.status, 'Active');
  assert.ok(on.data.feeAccount.added > 0, 'fees come back on reactivation');
});

test('fee structure: new fee types, instalments, safe edits and late fees', async () => {
  const office = await admin();
  const type = await office.post('/api/admin/fee-types', { name: 'Smart Class Fee' });
  assert.equal(type.status, 200);
  assert.equal((await office.post('/api/admin/fee-types', { name: 'smart class fee' })).status, 409);

  const created = await office.post('/api/admin/fee-structure', {
    feeTypeId: type.data.feeType.id,
    name: 'Smart Class Fee',
    grade: 'Class 5',
    session: '2026-27',
    amount: 300,
    frequency: 'Monthly',
    firstDueDate: '2026-10-05',
    lateFee: 50,
  });
  assert.equal(created.status, 200, created.data.error);
  assert.deepEqual(created.data.structure.instalments.map((i) => i.period), ['Oct 2026', 'Nov 2026', 'Dec 2026', 'Jan 2027', 'Feb 2027', 'Mar 2027']);
  const classFive = (await office.get('/api/admin/classes')).data.grades.find((g) => g.grade === 'Class 5').totalStudents;
  assert.equal(created.data.added, classFive * 6);

  // Pay October for one student, then raise the fee: the payment is untouched.
  const [student] = (await office.get('/api/admin/students?grade=Class%205&limit=1')).data.students;
  const due = (await office.get(`/api/admin/students/${student.id}/dues`)).data.due;
  const october = due.items.find((i) => i.title === 'Smart Class Fee · Oct 2026');
  const paid = await office.post(`/api/admin/students/${student.id}/payments`, { method: 'Cash', feeItemIds: [october.id] });
  assert.equal(paid.status, 200, paid.data.error);

  const edited = await office.put(`/api/admin/fee-structure/${created.data.structure.id}`, { amount: 350 });
  assert.equal(edited.status, 200, edited.data.error);
  assert.ok(edited.data.updated > 0);
  const account = (await office.get(`/api/admin/students/${student.id}`)).data.account;
  assert.equal(account.find((i) => i.id === october.id).amount, 300, 'the paid instalment keeps its amount');
  assert.equal(account.find((i) => i.title === 'Smart Class Fee · Nov 2026').amount, 350);
  const receipt = (await office.get(`/api/admin/payments/${paid.data.payment.paymentId}`)).data;
  assert.equal(receipt.amount, 300, 'the receipt keeps its amount');

  // A fee already past due gets its late fee once.
  const late = await office.post('/api/admin/fee-structure', {
    feeTypeId: type.data.feeType.id,
    name: 'Lab Fee',
    grade: 'Class 9',
    session: '2026-27',
    amount: 400,
    frequency: 'One-Time',
    firstDueDate: '2026-09-01',
    lateFee: 60,
  });
  assert.equal(late.status, 200, late.data.error);
  const [nine] = (await office.get('/api/admin/students?grade=Class%209&limit=1')).data.students;
  const first = (await office.get(`/api/admin/students/${nine.id}/dues`)).data.due.items;
  const second = (await office.get(`/api/admin/students/${nine.id}/dues`)).data.due.items;
  assert.equal(first.filter((i) => i.title === 'Late fee · Lab Fee').length, 1);
  assert.equal(second.filter((i) => i.title === 'Late fee · Lab Fee').length, 1, 'not added twice');
});

test('cash collection: change, part payments, and the clerk who collected', async () => {
  const counter = await clerk();
  const [student] = (await counter.get('/api/admin/students?q=Ishaan%20Verma')).data.students;
  const due = (await counter.get(`/api/admin/students/${student.id}/dues`)).data.due;
  const tuition = due.items.find((i) => i.title === 'Tuition Fee · Term 2');

  // Part payment: ₹5,000 towards ₹12,500.
  const part = await counter.post(`/api/admin/students/${student.id}/payments`, {
    method: 'Cash', feeItemIds: [tuition.id], expectedTotal: tuition.amount, amountReceived: 5000, idempotencyKey: 'part-1',
  });
  assert.equal(part.status, 200, part.data.error);
  assert.equal(part.data.payment.amount, 5000);
  assert.equal(part.data.partPayment, true);
  assert.equal(part.data.balance, tuition.amount - 5000);
  assert.equal(part.data.payment.collectedBy, 'Sunita Rana');
  assert.ok(part.data.payment.collectedByStaffId);
  const after = (await counter.get(`/api/admin/students/${student.id}/dues`)).data.due.items;
  const balance = after.find((i) => i.title === 'Tuition Fee · Term 2 (balance)');
  assert.equal(balance.amount, tuition.amount - 5000);

  // Paying the balance with a ₹10,000 note: change is recorded on the receipt.
  const cash = await counter.post(`/api/admin/students/${student.id}/payments`, {
    method: 'Cash', feeItemIds: [balance.id], expectedTotal: balance.amount, amountReceived: 10000, idempotencyKey: 'bal-1',
  });
  assert.equal(cash.status, 200, cash.data.error);
  assert.equal(cash.data.change, 10000 - balance.amount);
  const fmt = (n) => `₹${new Intl.NumberFormat('en-IN').format(n)}`;
  const full = (await counter.get(`/receipts/${cash.data.payment.paymentId}?copy=school`)).data.toString();
  assert.ok(full.includes(`<dt>Cash Received / Change</dt><dd><strong>${fmt(10000)} / ${fmt(10000 - balance.amount)}</strong></dd>`));
  const onePage = (await counter.get(`/receipts/${cash.data.payment.paymentId}?copy=both`)).data.toString();
  assert.equal(onePage.split(`<span>Cash Received / Change:</span> <strong>${fmt(10000)} / ${fmt(10000 - balance.amount)}</strong>`).length - 1, 2);

  const upi = await counter.post(`/api/admin/students/${student.id}/payments`, { method: 'UPI', reference: 'UPI 1', amountReceived: 999999 });
  assert.equal(upi.status, 400, 'only cash can have change');
});

test('corrections: clerks request, admins approve, nothing is deleted', async () => {
  const counter = await clerk();
  const office = await admin();
  const [student] = (await counter.get('/api/admin/students?q=Meera%20Iyer')).data.students;
  const paid = await counter.post(`/api/admin/students/${student.id}/payments`, { method: 'Cash', idempotencyKey: 'meera-1' });
  const paymentId = paid.data.payment.paymentId;
  const receiptNo = paid.data.payment.receiptNo;

  // Wrong mode: it was actually UPI.
  const request = await counter.post(`/api/admin/payments/${paymentId}/corrections`, {
    kind: 'change_details', reason: 'Parent paid by UPI, not cash', method: 'UPI', reference: 'UPI 555444333222',
  });
  assert.equal(request.status, 200, request.data.error);
  assert.equal((await counter.post(`/api/admin/payments/${paymentId}/corrections`, { kind: 'cancel', reason: 'again please' })).status, 409, 'one open request at a time');
  assert.equal((await counter.post(`/api/admin/corrections/${request.data.correction.id}/decision`, { approve: true })).status, 403);

  const decided = await office.post(`/api/admin/corrections/${request.data.correction.id}/decision`, { approve: true, note: 'Checked the UPI statement' });
  assert.equal(decided.data.correction.status, 'approved');
  const replacement = (await office.get(`/api/admin/payments/${decided.data.correction.replacementPaymentId}`)).data;
  assert.equal(replacement.method, 'UPI');
  assert.equal(replacement.replacesReceiptNo, receiptNo);
  assert.equal(replacement.amount, paid.data.payment.amount);
  const original = (await office.get(`/api/admin/payments/${paymentId}`)).data;
  assert.equal(original.status, 'CANCELLED');
  assert.ok((await office.get(`/receipts/${paymentId}`)).data.toString().includes('CANCELLED'));
  assert.equal((await office.get(`/api/admin/students/${student.id}/dues`)).data.due.total, 0, 'fees stay paid via the replacement');

  // Cancel outright: fees become due again.
  const cancel = await counter.post(`/api/admin/payments/${replacement.paymentId}/corrections`, { kind: 'cancel', reason: 'Cheque bounced later' });
  await office.post(`/api/admin/corrections/${cancel.data.correction.id}/decision`, { approve: true });
  assert.ok((await office.get(`/api/admin/students/${student.id}/dues`)).data.due.total > 0);
  const history = (await office.get(`/api/admin/payments?q=${encodeURIComponent(receiptNo)}`)).data.rows;
  assert.equal(history[0].status, 'CANCELLED', 'the original stays in history');
  const log = (await office.get('/api/admin/audit?action=correction')).data.entries.map((e) => e.action);
  assert.ok(log.includes('correction.requested') && log.includes('correction.approved'));
});

test('system health and exports for admins', async () => {
  const office = await admin();
  const health = (await office.get('/api/admin/system/health')).data;
  assert.ok(['ok', 'warn', 'error'].includes(health.status));
  assert.equal(health.checks.find((c) => c.name === 'Database integrity').status, 'ok');
  const students = await office.get('/api/admin/export/students?format=csv');
  assert.equal(students.status, 200);
  assert.ok(students.data.toString().includes('Date of Birth'));
  const structure = await office.get('/api/admin/export/fee-structure?format=xlsx');
  assert.equal(structure.status, 200);
  const audit = await office.get('/api/admin/export/audit?format=csv');
  assert.equal(audit.status, 200);
});
