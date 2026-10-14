// Tests for teachers, attendance, timetable, staff records, parent app access
// (access code + PIN), installing the apps (PWA), and off-site backups.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.QUIET = '1';
process.env.TEST_GATEWAY_DUPLICATE_WEBHOOKS = 'off';

const { startServer } = await import('../server/app.js');
const { DEMO } = await import('../server/seed.js');
const database = await import('../server/db.js');
const { putObject, signRequest } = await import('../server/integrations/storage/s3.js');
const { todayIso } = await import('../shared/format.js');

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
  let cookie = '';
  async function request(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('='));
    if (set.length) cookie = set.join('; ');
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  }
  return { get: (p) => request('GET', p), post: (p, b = {}) => request('POST', p, b), put: (p, b) => request('PUT', p, b) };
}

async function staff(email, password) {
  const c = client();
  const res = await c.post('/api/admin/login', { email, password });
  assert.equal(res.status, 200, res.data.error);
  return c;
}
const admin = () => staff(DEMO.adminEmail, DEMO.adminPassword);
const teacher = () => staff(DEMO.teacherEmail, DEMO.teacherPassword);
const classId = (name) => database.db.prepare('SELECT id FROM classes WHERE name = ?').get(name).id;
const sundayFree = () => {
  // The most recent day that is not a Sunday (attendance is not marked on Sundays).
  let d = todayIso();
  while (new Date(`${d}T00:00:00Z`).getUTCDay() === 0) d = new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return d;
};

test('teachers see only their own classes, and never fees', async () => {
  const t = await teacher();
  const me = (await t.get('/api/admin/me')).data;
  assert.deepEqual(me.permissions.sort(), ['attendance.mark', 'progress.enter', 'teaching', 'timetable.view']);
  const mine = me.classes.map((c) => c.name);
  assert.ok(mine.includes('6-B'));
  assert.ok(!mine.includes('10-A'), 'not a class they teach');

  for (const path of ['/api/admin/students', '/api/admin/payments', '/api/admin/dashboard', '/api/admin/reports/pending', '/api/admin/users', '/api/admin/parents']) {
    assert.equal((await t.get(path)).status, 403, path);
  }
  const other = classId('10-A');
  assert.equal((await t.get(`/api/admin/attendance?classId=${other}`)).status, 403);
  assert.equal((await t.get(`/api/admin/classes/${other}/students`)).status, 403);
  assert.equal((await t.get(`/api/admin/progress?classId=${other}`)).status, 403);

  // Their class: students without fees; parents' phones only as class teacher.
  const own = (await t.get(`/api/admin/classes/${classId('6-B')}/students`)).data;
  assert.ok(own.students.length > 10);
  assert.ok('parentPhone' in own.students[0], 'class teacher sees parent phones');
  assert.ok(!JSON.stringify(own).includes('"due"'));
  const subjectClass = (await t.get(`/api/admin/classes/${classId('7-A')}/students`)).data;
  assert.ok(!('parentPhone' in subjectClass.students[0]), 'subject teacher does not');

  const progress = await t.get(`/api/admin/progress?classId=${classId('6-B')}`);
  assert.equal(progress.status, 200);
  assert.equal(progress.data.feeBanner, null, 'no fee information for teachers');
});

test('attendance is marked once per day, within limits, and parents see it', async () => {
  const t = await teacher();
  const date = sundayFree();
  const cls = classId('6-B');
  const sheet = (await t.get(`/api/admin/attendance?classId=${cls}&date=${date}`)).data;
  const [first, second, ...rest] = sheet.students;
  const entries = [
    { studentId: first.id, status: 'absent', note: 'Fever' },
    { studentId: second.id, status: 'late' },
    ...rest.map((s) => ({ studentId: s.id, status: 'present' })),
  ];
  const saved = await t.put('/api/admin/attendance', { classId: cls, date, entries });
  assert.equal(saved.status, 200, saved.data.error);
  assert.equal(saved.data.counts.absent, 1);
  assert.equal(saved.data.counts.attended, sheet.students.length - 1, 'late counts as present');

  // Saving again changes marks; it never adds a second row for the day.
  await t.put('/api/admin/attendance', { classId: cls, date, entries: [{ studentId: first.id, status: 'leave', note: 'Wedding' }] });
  assert.equal(database.db.prepare('SELECT COUNT(*) AS n FROM attendance WHERE student_id = ? AND date = ?').get(first.id, date).n, 1);
  assert.equal(database.db.prepare('SELECT status FROM attendance WHERE student_id = ? AND date = ?').get(first.id, date).status, 'leave');

  // Not in the future, not a Sunday, not a student from another class, not long ago (for teachers).
  const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  assert.equal((await t.put('/api/admin/attendance', { classId: cls, date: tomorrow, entries })).status, 400);
  const outsider = database.db.prepare('SELECT id FROM students WHERE class_id = ? LIMIT 1').get(classId('6-A')).id;
  assert.equal((await t.put('/api/admin/attendance', { classId: cls, date, entries: [{ studentId: outsider, status: 'present' }] })).status, 400);
  assert.equal((await t.put('/api/admin/attendance', { classId: cls, date: '2026-04-06', entries })).status, 403);
  assert.equal((await t.put('/api/admin/attendance', { classId: cls, date, entries: [{ studentId: first.id, status: 'sleeping' }] })).status, 400);

  // The register and its Excel export.
  const register = (await t.get(`/api/admin/attendance/register?classId=${cls}&month=${date.slice(0, 7)}`)).data;
  assert.ok(register.dates.includes(date));
  const xlsx = await t.get(`/api/admin/attendance/register/export?classId=${cls}&month=${date.slice(0, 7)}&format=xlsx`);
  assert.equal(xlsx.status, 200);
  assert.equal(xlsx.data.subarray(0, 2).toString(), 'PK');

  // Aarav's parent sees his attendance (Aarav is in 6-B).
  const parent = client();
  assert.equal((await parent.post('/api/auth/pin', { phone: DEMO.parentPhone, pin: DEMO.parentPin })).status, 200);
  const [aarav] = (await parent.get('/api/me')).data.children;
  const mine = (await parent.get(`/api/students/${aarav.id}/attendance?month=${date.slice(0, 7)}`)).data;
  assert.ok(mine.days.some((d) => d.date === date));
  assert.ok(mine.summary.days >= 1);
  assert.equal((await parent.get(`/api/students/${outsider}/attendance`)).status, 404, 'not someone else’s child');

  // Audit
  const a = await admin();
  assert.ok((await a.get('/api/admin/audit?action=attendance.saved')).data.entries.some((e) => e.details.class === 'Class 6-B'));
});

test('the timetable refuses to give a teacher two classes at once', async () => {
  const a = await admin();
  const { teachers } = (await a.get('/api/admin/teachers')).data;
  const rajesh = teachers.find((t) => t.name === 'Rajesh Kumar');
  const { subjects } = (await a.get('/api/admin/subjects')).data;
  const english = subjects.find((s) => s.name === 'English');
  // Rajesh teaches 6-A on Monday period 1 in the demo timetable.
  const clash = await a.put(`/api/admin/timetable/${classId('6-B')}/1/1`, { subjectId: english.id, teacherId: rajesh.id });
  assert.equal(clash.status, 409);
  assert.match(clash.data.error, /Rajesh Kumar already teaches Class 6-A in period 1 on Monday/);

  // A period when Rajesh is free.
  const busy = new Set((await a.get(`/api/admin/timetable/teacher/${rajesh.id}`)).data.cells.map((c) => `${c.day}-${c.period}`));
  const slot = [1, 2, 3, 4, 5, 6].flatMap((d) => [1, 2, 3, 4, 5, 6, 7, 8].map((p) => `${d}-${p}`)).find((k) => !busy.has(k));
  const [day, period] = slot.split('-');
  const free = await a.put(`/api/admin/timetable/${classId('10-A')}/${day}/${period}`, { subjectId: english.id, teacherId: rajesh.id });
  assert.equal(free.status, 200, free.data.error);
  // A period in a class gives the teacher access to that class.
  assert.ok((await a.get('/api/admin/teachers')).data.teachers.find((t) => t.id === rajesh.id).classes.some((c) => c.name === '10-A'));

  const t = await teacher();
  const week = (await t.get('/api/admin/timetable/mine')).data;
  assert.ok(week.cells.length > 0 && week.cells.every((c) => c.teacher === 'Meena Sharma'));
  assert.equal((await t.put(`/api/admin/timetable/${classId('6-B')}/1/1`, { subjectId: english.id })).status, 403, 'teachers cannot edit');

  const parent = client();
  await parent.post('/api/auth/pin', { phone: DEMO.parentPhone, pin: DEMO.parentPin });
  const [aarav] = (await parent.get('/api/me')).data.children;
  const tt = (await parent.get(`/api/students/${aarav.id}/timetable`)).data;
  assert.equal(tt.class.label, 'Class 6-B');
  assert.equal(tt.cells.length, 48);
});

test('staff records: teachers and staff without app access', async () => {
  const a = await admin();
  const driver = await a.post('/api/admin/users', { name: 'Bus Driver Two', role: 'staff', designation: 'Driver', phone: '94180 99999' });
  assert.equal(driver.status, 200, driver.data.error);
  assert.equal(driver.data.user.canLogin, false);
  assert.equal(driver.data.user.email, null);

  const t = await a.post('/api/admin/users', { name: 'New Teacher', role: 'teacher', email: 'new.teacher@kbs.test', password: 'teacher-pass', designation: 'PRT' });
  assert.equal(t.status, 200, t.data.error);
  const nt = await staff('new.teacher@kbs.test', 'teacher-pass');
  const me = (await nt.get('/api/admin/me')).data;
  assert.deepEqual(me.classes, [], 'no classes until the admin assigns them');
  await a.put(`/api/admin/teachers/${t.data.user.id}/classes`, { classes: [{ classId: classId('3-A'), classTeacher: true }] });
  assert.deepEqual((await nt.get('/api/admin/me')).data.classes.map((c) => c.name), ['3-A']);

  // Only one class teacher per class.
  const taken = await a.put(`/api/admin/teachers/${t.data.user.id}/classes`, { classes: [{ classId: classId('6-B'), classTeacher: true }] });
  assert.equal(taken.status, 409);

  // Switching a teacher off signs them out.
  await a.put(`/api/admin/users/${t.data.user.id}`, { active: false });
  assert.equal((await nt.get('/api/admin/me')).status, 401);

  const xlsx = await a.get('/api/admin/export/staff?format=xlsx');
  assert.equal(xlsx.status, 200);
});

test('parents log in with an access code and PIN; the school can switch access off', async () => {
  const a = await admin();
  const phone = DEMO.siblingsPhone;
  const issued = await a.post(`/api/admin/parents/${phone}/code`);
  assert.equal(issued.status, 200, issued.data.error);
  assert.match(issued.data.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(issued.data.whatsappLink.startsWith(`https://wa.me/91${phone}`));
  assert.ok(!JSON.stringify(database.db.prepare('SELECT * FROM parent_accounts WHERE phone = ?').get(phone)).includes(issued.data.code), 'only a hash is stored');

  const p = client();
  assert.equal((await p.post('/api/auth/setup', { phone, code: 'WRNG-CODE', pin: '135790' })).status, 400);
  assert.match((await p.post('/api/auth/setup', { phone, code: issued.data.code, pin: '123456' })).data.error, /harder to guess/);
  const setup = await p.post('/api/auth/setup', { phone, code: issued.data.code.toLowerCase(), pin: '135790' });
  assert.equal(setup.status, 200, setup.data.error);
  assert.equal((await p.get('/api/me')).data.children.length, 2);
  assert.equal((await client().post('/api/auth/setup', { phone, code: issued.data.code, pin: '135790' })).status, 400, 'the code works once');

  // Wrong PINs lock the account for a while.
  const q = client();
  for (let i = 0; i < 4; i++) assert.equal((await q.post('/api/auth/pin', { phone, pin: '000111' })).status, 400);
  assert.equal((await q.post('/api/auth/pin', { phone, pin: '000111' })).status, 429);
  assert.equal((await q.post('/api/auth/pin', { phone, pin: '135790' })).status, 429, 'locked even with the right PIN');
  database.db.prepare('UPDATE parent_accounts SET locked_until = NULL WHERE phone = ?').run(phone);
  assert.equal((await q.post('/api/auth/pin', { phone, pin: '135790' })).status, 200);

  // Switched off: logged out everywhere, and cannot log in.
  const off = await a.post(`/api/admin/parents/${phone}/status`, { active: false });
  assert.equal(off.data.status, 'disabled');
  assert.equal((await p.get('/api/me')).status, 401);
  assert.equal((await client().post('/api/auth/pin', { phone, pin: '135790' })).status, 403);
  assert.equal((await a.post(`/api/admin/parents/${phone}/code`)).status, 409);
  await a.post(`/api/admin/parents/${phone}/status`, { active: true });
  assert.equal((await client().post('/api/auth/pin', { phone, pin: '135790' })).status, 200);

  // Clerks give codes; only admins switch access off.
  const clerk = await staff(DEMO.clerkEmail, DEMO.clerkPassword);
  assert.equal((await clerk.post(`/api/admin/parents/${phone}/code`)).status, 200);
  assert.equal((await clerk.post(`/api/admin/parents/${phone}/status`, { active: false })).status, 403);

  const families = (await a.get('/api/admin/parents?q=Patel')).data.families;
  assert.ok(families.some((f) => f.phone === phone));
});

test('both apps can be installed on a phone', async () => {
  for (const [path, start] of [['/manifest.webmanifest', '/'], ['/admin.webmanifest', '/admin']]) {
    const res = await fetch(base + path);
    assert.equal(res.headers.get('content-type'), 'application/manifest+json');
    const manifest = await res.json();
    assert.equal(manifest.start_url, start);
    assert.equal(manifest.display, 'standalone');
    assert.ok(manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'any'));
    assert.ok(manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
    for (const icon of manifest.icons) assert.equal((await fetch(base + icon.src)).status, 200, icon.src);
  }
  const sw = await fetch(`${base}/sw.js`);
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type'), /javascript/);
  assert.match(await sw.text(), /NEVER_CACHE = \/\^\\\/\(api\|receipts\|r\)\\\//, 'records are never cached on the phone');
  assert.equal((await fetch(`${base}/offline.html`)).status, 200);
  assert.ok((await (await fetch(`${base}/admin`)).text()).includes('rel="manifest" href="/admin.webmanifest"'));
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true });
});

test('off-site backups are signed uploads to S3-compatible storage', async () => {
  const calls = [];
  const storage = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(200, { etag: '"abc"' });
    res.end();
  });
  await new Promise((resolve) => storage.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = `http://127.0.0.1:${storage.address().port}`;
    const result = await putObject({ endpoint, region: 'ap-mumbai-1', bucket: 'kbs-backups', accessKey: 'AKIDEXAMPLE', secretKey: 'secret' }, 'kbs-erp/backup 1.db', Buffer.from('SQLite format 3'));
    assert.equal(result.etag, '"abc"');
    const [call] = calls;
    assert.equal(call.method, 'PUT');
    assert.equal(call.url, '/kbs-backups/kbs-erp/backup%201.db');
    assert.equal(call.body.toString(), 'SQLite format 3');
    assert.match(call.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/ap-mumbai-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  } finally {
    storage.close();
  }

  // The signature matches Amazon's published example for S3 Signature Version 4.
  const signed = signRequest({
    method: 'PUT',
    url: new URL('https://examplebucket.s3.amazonaws.com/test%24file.text'),
    headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
    body: 'Welcome to Amazon S3.',
    region: 'us-east-1',
    accessKey: 'AKIAIOSFODNN7EXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.match(signed.authorization, /Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd$/);
});
