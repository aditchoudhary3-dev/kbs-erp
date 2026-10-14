import { config } from '../config.js';
import { db } from '../db.js';
import { HttpError, sendDownload } from '../http.js';
import * as auth from '../auth.js';
import { allow, can, LOGIN_ROLES, permissionsFor, ROLES } from '../permissions.js';
import { audit, auditActions, auditFor, recentAudit } from '../audit.js';
import { openStream } from '../events.js';
import {
  busRoutes,
  createStudent,
  GENDERS,
  getClass,
  getStudent,
  listClasses,
  nextStudentCode,
  searchStudents,
  setStudentActive,
  updateStudent,
} from '../services/students.js';
import * as feeStructure from '../services/fee-structure.js';
import * as corrections from '../services/corrections.js';
import * as system from '../services/system.js';
import * as fees from '../services/fees.js';
import * as progress from '../services/progress.js';
import * as notices from '../services/notices.js';
import * as reports from '../services/reports.js';
import { COUNTER_METHODS, reconcileOrder, recordCounterPayment } from '../services/payments.js';
import { paymentDetails, REGISTER_COLUMNS, registerRows, searchPayments, STATUSES } from '../services/payment-history.js';
import { prepareReceiptMessage, sendByStaff } from '../services/whatsapp.js';
import { parseCopy, receiptData } from '../services/receipts.js';
import * as assistant from '../assistant/index.js';
import { changeOwnPassword, createUser, listUsers, updateUser } from '../services/users.js';
import * as academics from '../services/academics.js';
import { monthTotals, STATUS_LABELS } from '../services/attendance.js';
import { exportTable, FORMATS } from '../integrations/export/index.js';
import { gateway } from '../integrations/payments/index.js';
import { whatsapp } from '../integrations/whatsapp/index.js';
import { GRADES } from '../../shared/school.js';
import { monthLongYear, todayIso } from '../../shared/format.js';

function classIdParam(value) {
  if (value === null || value === undefined || value === '' || value === 'all') return null;
  return getClass(Number(value)).id;
}

// Query-string filters for payment history and exports.
const paymentFilters = (q) =>
  Object.fromEntries(
    ['q', 'studentName', 'admissionNo', 'receiptNo', 'txnId', 'grade', 'section', 'mode', 'status', 'from', 'to', 'channel', 'studentId', 'classId', 'receiptsOnly', 'collectedBy']
      .map((key) => [key, q.get(key) ?? ''])
      .filter(([, v]) => v !== ''),
  );

function sendExport(ctx, table, name) {
  const format = ctx.query.get('format') ?? 'xlsx';
  if (!FORMATS[format]) throw new HttpError(400, 'Choose Excel (xlsx) or CSV.');
  const file = exportTable(format, { ...table, columns: table.columns.filter((c) => c.export !== false) });
  const staff = auth.currentStaff(ctx);
  audit(staff, 'report.exported', { details: { report: name, format, rows: table.rows.length } });
  sendDownload(ctx.res, file.buffer, { type: file.contentType, filename: `KBS-${table.filename ?? name}.${file.extension}` });
}

function studentsTable(q) {
  const students = searchStudents({ q: q.q ?? '', grade: q.grade ?? '', section: q.section ?? '', status: q.status ?? 'all', limit: 100000 });
  return {
    title: 'Students',
    filename: `students-${todayIso()}`,
    columns: [
      { key: 'code', header: 'Student ID', width: 11 },
      { key: 'admissionNo', header: 'Admission Number', width: 17 },
      { key: 'name', header: 'Student Name', width: 22 },
      { key: 'dob', header: 'Date of Birth', type: 'date', width: 13 },
      { key: 'gender', header: 'Gender', width: 8 },
      { key: 'fatherName', header: "Father's Name", width: 20 },
      { key: 'motherName', header: "Mother's Name", width: 20 },
      { key: 'parentPhone', header: 'Mobile', width: 13 },
      { key: 'altPhone', header: 'Alternate Mobile', width: 15 },
      { key: 'address', header: 'Address', width: 36 },
      { key: 'grade', header: 'Class', width: 10 },
      { key: 'section', header: 'Section', width: 8 },
      { key: 'rollNo', header: 'Roll No.', type: 'number', width: 8 },
      { key: 'session', header: 'Session', width: 9 },
      { key: 'admissionDate', header: 'Admission Date', type: 'date', width: 14 },
      { key: 'transportLabel', header: 'Transport', width: 10 },
      { key: 'busRoute', header: 'Bus Route', width: 16 },
      { key: 'status', header: 'Status', width: 9 },
      { key: 'remarks', header: 'Remarks', width: 30 },
    ],
    rows: students.map((s) => ({ ...s, transportLabel: s.transport ? 'Yes' : 'No' })),
  };
}

function auditTable(q) {
  const { entries } = recentAudit({ ...q, limit: 5000 });
  return {
    title: 'Audit log',
    filename: `audit-log-${todayIso()}`,
    columns: [
      { key: 'at', header: 'When (UTC)', width: 24 },
      { key: 'actor', header: 'Who', width: 26 },
      { key: 'action', header: 'Action', width: 24 },
      { key: 'entity', header: 'Record', width: 12 },
      { key: 'entityId', header: 'Record ID', width: 10 },
      { key: 'via', header: 'Through', width: 18 },
      { key: 'detailsText', header: 'Details', width: 80 },
    ],
    rows: entries.map((e) => ({ ...e, detailsText: e.details ? JSON.stringify(e.details) : '' })),
  };
}

function staffTable() {
  return {
    title: 'Staff records',
    filename: `staff-${todayIso()}`,
    columns: [
      { key: 'name', header: 'Name', width: 22 },
      { key: 'roleLabel', header: 'Role', width: 20 },
      { key: 'designation', header: 'Designation', width: 24 },
      { key: 'phone', header: 'Mobile', width: 13 },
      { key: 'email', header: 'Email (login)', width: 26 },
      { key: 'joinedOn', header: 'Joining Date', type: 'date', width: 13 },
      { key: 'classesText', header: 'Classes', width: 30 },
      { key: 'status', header: 'Status', width: 12 },
    ],
    rows: listUsers().map((u) => ({
      ...u,
      classesText: u.classes.map((c) => `${c.label}${c.classTeacher ? ' (class teacher)' : ''}`).join(', '),
      status: u.active ? 'Active' : 'Switched off',
    })),
  };
}

function feeStructureTable(q) {
  const rows = feeStructure.listStructures({ session: q.session || feeStructure.currentSession(), grade: q.grade ?? '', includeInactive: true });
  return {
    title: 'Fee structure',
    filename: `fee-structure-${q.session || feeStructure.currentSession()}`,
    columns: [
      { key: 'feeType', header: 'Fee Type', width: 16 },
      { key: 'name', header: 'Fee Name', width: 22 },
      { key: 'gradeLabel', header: 'Class', width: 12 },
      { key: 'session', header: 'Session', width: 9 },
      { key: 'amount', header: 'Amount', type: 'money', width: 11 },
      { key: 'frequency', header: 'Frequency', width: 12 },
      { key: 'firstDueDate', header: 'First Due Date', type: 'date', width: 14 },
      { key: 'instalmentCount', header: 'Instalments', type: 'number', width: 11 },
      { key: 'lateFee', header: 'Late Fee', type: 'money', width: 10 },
      { key: 'kind', header: 'Compulsory/Optional', width: 18 },
      { key: 'transport', header: 'Transport Only', width: 14 },
      { key: 'students', header: 'Students', type: 'number', width: 10 },
      { key: 'billed', header: 'Billed', type: 'money', width: 13 },
      { key: 'collected', header: 'Collected', type: 'money', width: 13 },
      { key: 'statusLabel', header: 'Status', width: 10 },
    ],
    rows: rows.map((r) => ({
      ...r,
      gradeLabel: r.grade ?? 'All classes',
      kind: r.compulsory ? 'Compulsory' : 'Optional',
      transport: r.transportOnly ? 'Yes' : 'No',
      statusLabel: r.active ? 'Active' : 'Stopped',
    })),
  };
}

export function adminRoutes(router) {
  // ---- Session -------------------------------------------------------------------

  router.post('/api/admin/login', (ctx) => {
    const staff = auth.staffLogin(ctx.res, ctx.body.email, ctx.body.password);
    audit(staff, 'staff.login');
    return { staff };
  });

  router.post('/api/admin/logout', (ctx) => {
    auth.endSession(ctx, 'admin');
    return { ok: true };
  });

  router.get('/api/admin/me', (ctx) => {
    const staff = allow(ctx);
    // Teachers see only their own classes in every class list.
    const scope = academics.classScope(staff);
    const classes = listClasses().filter((c) => !scope || scope.has(c.id));
    return {
      staff: { ...staff, roleLabel: ROLES[staff.role] },
      permissions: permissionsFor(staff.role),
      appName: config.appName,
      school: config.school,
      schoolName: config.school.name,
      academicYear: config.academicYear.label,
      classes,
      grades: scope ? GRADES.filter((g) => classes.some((c) => c.grade === g)) : GRADES,
      myClasses: scope ? academics.teacherClasses(staff.id) : null,
      timetable: academics.timetableShape(),
      attendanceStatuses: STATUS_LABELS,
      subjects: config.subjects,
      months: progress.reportableMonths().map((key) => ({ key, label: monthLongYear(key) })),
      currentMonth: progress.activeMonth(),
      counterMethods: COUNTER_METHODS,
      paymentModes: [...new Set(['UPI', 'Card', 'Net banking', 'Wallet', ...COUNTER_METHODS])],
      statuses: STATUSES,
      feeTypes: feeStructure.listFeeTypes(),
      frequencies: feeStructure.FREQUENCIES,
      session: feeStructure.currentSession(),
      sessions: feeStructure.sessionsOffered(),
      genders: GENDERS,
      busRoutes: busRoutes(),
      pendingCorrections: can(staff.role, 'corrections.approve') ? corrections.pendingCount() : 0,
      dueWindowDays: config.fees.dueWindowDays,
      gateway: { name: gateway().name, label: gateway().label },
      whatsapp: { provider: whatsapp().name, label: whatsapp().label, automatic: whatsapp().automatic },
      demoMode: config.demoMode,
      today: todayIso(),
      assistant: can(staff.role, 'assistant.use') ? assistant.assistantInfo(staff) : null,
      roles: ROLES,
      loginRoles: LOGIN_ROLES,
      parentLogin: config.parentLogin,
      publicBaseUrl: config.publicBaseUrl,
    };
  });

  router.post('/api/admin/me/password', (ctx) => {
    const staff = allow(ctx);
    changeOwnPassword(staff, ctx.body);
    audit(staff, 'staff.password_changed');
    return { ok: true };
  });

  // Live updates (payment confirmations) for staff screens.
  router.get('/api/admin/events', (ctx) => {
    const staff = allow(ctx, 'payments.view');
    openStream(ctx.req, ctx.res, staff);
  });

  // ---- Dashboard and class-wise ---------------------------------------------------------

  router.get('/api/admin/dashboard', (ctx) => {
    const staff = allow(ctx, 'dashboard.view');
    const data = reports.dashboard();
    if (can(staff.role, 'progress.manage')) {
      const month = progress.activeMonth();
      data.progress = { monthLabel: monthLongYear(month), classes: progress.monthStatusCounts(month) };
    }
    return data;
  });

  router.get('/api/admin/classes', (ctx) => {
    allow(ctx, 'reports.view');
    return { grades: reports.classSummary() };
  });

  // ---- Students ------------------------------------------------------------------------

  const syncAccount = (id) => feeStructure.syncStudentAccount(id);

  router.get('/api/admin/students', (ctx) => {
    allow(ctx, 'students.view');
    const month = progress.activeMonth();
    const q = ctx.query;
    const students = searchStudents({
      q: q.get('q') ?? '',
      grade: q.get('grade') ?? '',
      section: q.get('section') ?? '',
      status: q.get('status') ?? 'active',
      limit: Math.min(Number(q.get('limit')) || 100, 1000),
    });
    const due = new Map(fees.outstanding().map((r) => [r.studentId, r]));
    const status = new Map(db.prepare('SELECT student_id, status FROM progress_reports WHERE month = ?').all(month).map((r) => [r.student_id, r.status]));
    return {
      month,
      monthLabel: monthLongYear(month),
      students: students.map((s) => ({
        ...s,
        due: due.get(s.id)?.total ?? 0,
        overdue: due.get(s.id)?.overdue ?? false,
        reportStatus: { published: 'Published', draft: 'Draft' }[status.get(s.id)] ?? 'Pending',
      })),
    };
  });

  // Registered before /:id so "next-code" is not read as a student id.
  router.get('/api/admin/students/next-code', (ctx) => {
    allow(ctx, 'students.edit');
    return { code: nextStudentCode() };
  });

  router.get('/api/admin/students/:id', (ctx) => {
    allow(ctx, 'students.view');
    const student = getStudent(Number(ctx.params.id));
    if (!student) throw new HttpError(404, 'Student not found.');
    const account = db
      .prepare(
        `SELECT f.id, f.title, f.fee_type, f.amount, f.due_date, f.payment_id, p.receipt_no
         FROM fee_items f LEFT JOIN payments p ON p.id = f.payment_id WHERE f.student_id = ? ORDER BY f.due_date, f.id`,
      )
      .all(student.id)
      .map((f) => ({ id: f.id, title: f.title, feeType: f.fee_type, amount: f.amount, dueDate: f.due_date, paid: f.payment_id !== null, receiptNo: f.receipt_no }));
    return {
      student,
      due: fees.dueSummary(student.id),
      account,
      payments: searchPayments({ studentId: student.id }, { limit: 100 }).rows,
    };
  });

  router.post('/api/admin/students', (ctx) => {
    const staff = allow(ctx, 'students.edit');
    const { student, feeAccount } = createStudent(ctx.body, { syncAccount });
    audit(staff, 'student.created', {
      entity: 'student',
      entityId: student.id,
      details: { name: student.name, admissionNo: student.admissionNo, class: student.className, feeItems: feeAccount.added },
    });
    return { student, feeAccount, message: 'Student added successfully.' };
  });

  router.put('/api/admin/students/:id', (ctx) => {
    const staff = allow(ctx, 'students.edit');
    const { before, after, account } = updateStudent(Number(ctx.params.id), ctx.body, { syncAccount });
    const changed = Object.fromEntries(
      ['name', 'admissionNo', 'rollNo', 'className', 'dob', 'gender', 'fatherName', 'motherName', 'parentPhone', 'altPhone', 'whatsappPhone', 'address', 'session', 'admissionDate', 'transport', 'busRoute', 'remarks']
        .filter((k) => before[k] !== after[k])
        .map((k) => [k, { from: before[k], to: after[k] }]),
    );
    audit(staff, 'student.updated', { entity: 'student', entityId: after.id, details: changed });
    return { student: after, feeAccount: account };
  });

  // Deactivate or reactivate. Students are never deleted.
  router.post('/api/admin/students/:id/status', (ctx) => {
    const staff = allow(ctx, 'students.edit');
    const active = ctx.body.active === true;
    const reason = String(ctx.body.reason ?? '').trim().slice(0, 300);
    if (!active && reason.length < 3) throw new HttpError(400, 'Give a reason for deactivating (for example, “Left school”).');
    const { student, account } = setStudentActive(Number(ctx.params.id), active, { syncAccount });
    audit(staff, active ? 'student.reactivated' : 'student.deactivated', {
      entity: 'student',
      entityId: student.id,
      details: { name: student.name, reason, feeItemsRemoved: account.removed, feeItemsAdded: account.added },
    });
    return { student, feeAccount: account };
  });

  router.post('/api/admin/students/:id/optional-fees', (ctx) => {
    const staff = allow(ctx, 'fees.manage');
    const student = getStudent(Number(ctx.params.id));
    if (!student) throw new HttpError(404, 'Student not found.');
    const result = feeStructure.assignOptionalFee(student.id, Number(ctx.body.structureId));
    audit(staff, 'fee.assigned', { entity: 'student', entityId: student.id, details: { structureId: ctx.body.structureId, ...result } });
    return result;
  });

  // ---- Collecting fees at the counter ----------------------------------------------------

  router.get('/api/admin/students/:id/dues', (ctx) => {
    allow(ctx, 'payments.collect');
    const student = getStudent(Number(ctx.params.id));
    if (!student) throw new HttpError(404, 'Student not found.');
    feeStructure.applyLateFees();
    return { student, due: fees.dueSummary(student.id) };
  });

  router.post('/api/admin/students/:id/payments', (ctx) => {
    const staff = allow(ctx, 'payments.collect');
    const student = getStudent(Number(ctx.params.id));
    if (!student) throw new HttpError(404, 'Student not found.');
    if (!student.active) throw new HttpError(409, 'This student is inactive. Reactivate them before collecting fees.');
    const result = recordCounterPayment(student.id, { ...ctx.body, staff });
    prepareReceiptMessage(result.paymentId); // so the card shows the WhatsApp status straight away
    return {
      duplicate: result.duplicate,
      change: result.change ?? 0,
      partPayment: Boolean(result.partPayment),
      balance: result.balance ?? 0,
      payment: paymentDetails(result.paymentId),
    };
  });

  router.delete('/api/admin/fee-items/:id', (ctx) => {
    const staff = allow(ctx, 'fees.manage');
    const removed = fees.waiveFeeItem(Number(ctx.params.id));
    audit(staff, 'fee.waived', { entity: 'student', entityId: removed.studentId, details: { ...removed, reason: String(ctx.body?.reason ?? '') } });
    return { removed };
  });

  // ---- Payment history, receipts and WhatsApp -------------------------------------------

  router.get('/api/admin/payments', (ctx) => {
    allow(ctx, 'payments.view');
    return searchPayments(paymentFilters(ctx.query), {
      limit: Number(ctx.query.get('limit')) || 50,
      offset: Number(ctx.query.get('offset')) || 0,
    });
  });

  // One payment with its receipt copies and everything recorded about it.
  router.get('/api/admin/payments/:id', (ctx) => {
    allow(ctx, 'payments.view');
    const id = Number(ctx.params.id);
    return { ...paymentDetails(id), activity: auditFor('payment', id) };
  });

  // The print dialog was opened for a copy (the receipt archive keeps a record).
  router.post('/api/admin/payments/:id/printed', (ctx) => {
    const staff = allow(ctx, 'receipts.print');
    const receipt = receiptData(Number(ctx.params.id));
    const copy = parseCopy(ctx.body.copy, 'both');
    audit(staff, 'receipt.printed', { entity: 'payment', entityId: receipt.paymentId, details: { receiptNo: receipt.receiptNo, copy } });
    return { ok: true };
  });

  router.post('/api/admin/payments/:id/whatsapp', async (ctx) => {
    const staff = allow(ctx, 'whatsapp.send');
    paymentDetails(Number(ctx.params.id)); // 404 if missing
    return sendByStaff(Number(ctx.params.id), staff);
  });

  router.post('/api/admin/payment-orders/:id/reconcile', async (ctx) => {
    const staff = allow(ctx, 'payments.reconcile');
    const result = await reconcileOrder(Number(ctx.params.id), staff);
    audit(staff, 'payment.reconciled', { entity: 'order', entityId: ctx.params.id, details: result });
    return result;
  });

  // ---- KBS AI Assistant ----------------------------------------------------------------------

  router.post('/api/admin/assistant/chat', (ctx) => {
    const staff = allow(ctx, 'assistant.use');
    return assistant.ask(staff, ctx.body);
  });

  // A pick from a list the assistant showed (for example the right student).
  router.post('/api/admin/assistant/run', (ctx) => {
    const staff = allow(ctx, 'assistant.use');
    return assistant.runTool(staff, String(ctx.body.tool ?? ''), ctx.body.args);
  });

  router.post('/api/admin/assistant/actions/:id/confirm', (ctx) => {
    const staff = allow(ctx, 'assistant.use');
    return assistant.confirmAction(staff, Number(ctx.params.id));
  });

  router.post('/api/admin/assistant/actions/:id/cancel', (ctx) => {
    const staff = allow(ctx, 'assistant.use');
    return assistant.cancelAction(staff, Number(ctx.params.id));
  });

  router.get('/api/admin/assistant/insights', (ctx) => {
    const staff = allow(ctx, 'dashboard.view');
    return assistant.dailySummary(staff);
  });

  // ---- Payment corrections ------------------------------------------------------------------

  router.post('/api/admin/payments/:id/corrections', (ctx) => {
    const staff = allow(ctx, 'corrections.request');
    return { correction: corrections.requestCorrection(Number(ctx.params.id), ctx.body, staff) };
  });

  router.get('/api/admin/corrections', (ctx) => {
    const staff = allow(ctx, 'corrections.request');
    const all = can(staff.role, 'corrections.approve');
    return {
      corrections: corrections.listCorrections({ status: ctx.query.get('status') ?? '', requestedBy: all ? null : staff.id }),
      kinds: corrections.KINDS,
    };
  });

  router.post('/api/admin/corrections/:id/decision', (ctx) => {
    const staff = allow(ctx, 'corrections.approve');
    return { correction: corrections.decideCorrection(Number(ctx.params.id), { approve: ctx.body.approve === true, note: ctx.body.note }, staff) };
  });

  // ---- System (admin) -----------------------------------------------------------------------

  router.get('/api/admin/system/health', (ctx) => {
    allow(ctx, 'system.manage');
    return system.health();
  });

  router.get('/api/admin/system/backups', (ctx) => {
    allow(ctx, 'system.manage');
    return { backups: system.listBackups(), offsite: system.offsiteStatus() };
  });

  router.post('/api/admin/system/backups', async (ctx) => {
    const staff = allow(ctx, 'system.manage');
    const backup = system.createBackup();
    const copy = await system.uploadBackup(backup.name);
    audit(staff, 'system.backup', { details: { name: backup.name, size: backup.size, offsite: copy ? (copy.ok ? 'copied' : copy.error) : 'not set up' } });
    return { backup, offsite: system.offsiteStatus() };
  });

  router.get('/api/admin/system/backups/:name', async (ctx) => {
    const staff = allow(ctx, 'system.manage');
    const file = system.backupPath(ctx.params.name);
    audit(staff, 'system.backup_downloaded', { details: { name: ctx.params.name } });
    const { readFile } = await import('node:fs/promises');
    sendDownload(ctx.res, await readFile(file), { type: 'application/vnd.sqlite3', filename: ctx.params.name });
  });

  // ---- Reports and exports -----------------------------------------------------------------

  router.get('/api/admin/reports/:name', (ctx) => {
    allow(ctx, 'reports.view');
    const q = Object.fromEntries(ctx.query);
    if (ctx.params.name === 'student') return reports.studentHistory(q.studentId);
    const report = reports.REPORTS[ctx.params.name];
    if (!report) throw new HttpError(404, 'Unknown report.');
    return report({ ...q, overdueOnly: q.overdueOnly === 'true' });
  });

  router.get('/api/admin/export/:name', (ctx) => {
    allow(ctx, 'reports.export');
    const name = ctx.params.name;
    const q = Object.fromEntries(ctx.query);
    if (name === 'payments') {
      const filters = paymentFilters(ctx.query);
      const scope = filters.grade ? `${filters.grade}${filters.section ? `-${filters.section}` : ''}` : 'all-classes';
      return sendExport(
        ctx,
        {
          sheetName: 'Fee register',
          filename: `fee-register-${scope.replace(/\s+/g, '-').toLowerCase()}-${todayIso()}`,
          columns: REGISTER_COLUMNS,
          rows: registerRows(filters),
        },
        name,
      );
    }
    let table;
    if (name === 'students') {
      allow(ctx, 'students.export');
      table = studentsTable(q);
    } else if (name === 'audit') {
      allow(ctx, 'audit.view');
      table = auditTable(q);
    } else if (name === 'staff') {
      allow(ctx, 'users.manage');
      table = staffTable();
    } else if (name === 'fee-structure') {
      allow(ctx, 'fees.manage');
      table = feeStructureTable(q);
    } else if (name === 'student') table = reports.studentHistory(q.studentId);
    else if (reports.REPORTS[name]) table = reports.REPORTS[name]({ ...q, overdueOnly: q.overdueOnly === 'true' });
    else throw new HttpError(404, 'Unknown report.');
    sendExport(ctx, { ...table, sheetName: table.title }, name);
  });

  // ---- Fee structure (admin) ------------------------------------------------------------------

  router.get('/api/admin/fee-structure', (ctx) => {
    allow(ctx, 'fees.manage');
    const q = ctx.query;
    return {
      structures: feeStructure.listStructures({
        session: q.get('session') || feeStructure.currentSession(),
        grade: q.get('grade') ?? '',
        feeTypeId: q.get('feeTypeId') ?? '',
        includeInactive: q.get('includeInactive') === 'true',
      }),
      feeTypes: feeStructure.listFeeTypes(),
    };
  });

  router.get('/api/admin/fee-structure/:id', (ctx) => {
    allow(ctx, 'fees.manage');
    return { structure: feeStructure.getStructure(Number(ctx.params.id)) };
  });

  router.post('/api/admin/fee-types', (ctx) => {
    const staff = allow(ctx, 'fees.manage');
    const type = feeStructure.createFeeType(ctx.body.name);
    audit(staff, 'fee_type.created', { details: type });
    return { feeType: type };
  });

  router.post('/api/admin/fee-structure', (ctx) => {
    const staff = allow(ctx, 'fees.manage');
    const result = feeStructure.createStructure(ctx.body, { applyToExisting: ctx.body.applyToExisting !== false });
    audit(staff, 'fee_structure.created', { entity: 'fee_structure', entityId: result.structure.id, details: { ...result.structure, instalments: undefined, feeItemsAdded: result.added } });
    return result;
  });

  router.put('/api/admin/fee-structure/:id', (ctx) => {
    const staff = allow(ctx, 'fees.manage');
    const result = feeStructure.updateStructure(Number(ctx.params.id), ctx.body, { includeOverdue: ctx.body.includeOverdue === true });
    const changed = Object.fromEntries(
      ['name', 'amount', 'frequency', 'firstDueDate', 'lateFee', 'compulsory', 'transportOnly', 'newAdmissionsOnly', 'active']
        .filter((k) => JSON.stringify(result.before[k]) !== JSON.stringify(result.structure[k]))
        .map((k) => [k, { from: result.before[k], to: result.structure[k] }]),
    );
    audit(staff, 'fee_structure.updated', { entity: 'fee_structure', entityId: result.structure.id, details: { ...changed, unpaidUpdated: result.updated, added: result.added, removed: result.removed } });
    return { structure: result.structure, added: result.added, updated: result.updated, removed: result.removed };
  });

  router.post('/api/admin/fees/reminders', (ctx) => {
    const staff = allow(ctx, 'reminders.send');
    const result = fees.sendReminders({ classId: classIdParam(ctx.body.classId), grade: ctx.body.grade || null });
    audit(staff, 'reminders.sent', { details: { classId: ctx.body.classId ?? null, grade: ctx.body.grade ?? null, ...result } });
    return result;
  });

  // ---- Monthly progress (admin) ---------------------------------------------------------------

  router.get('/api/admin/progress', (ctx) => {
    const staff = allow(ctx, ['progress.manage', 'progress.enter']);
    const classId = classIdParam(ctx.query.get('classId'));
    if (classId === null) throw new HttpError(400, 'Choose a class.');
    academics.assertClassAccess(staff, classId);
    const month = ctx.query.get('month') || progress.activeMonth();
    const data = progress.classProgress(classId, month);
    // Days present from the daily attendance register, where it has been kept.
    const register = monthTotals(classId, month);
    if (register.days) {
      data.attendanceDays = register.days;
      data.suggestedSchoolDays = data.suggestedSchoolDays ?? register.days;
      for (const s of data.students) s.attendance = { attended: register.byStudent.get(s.id) ?? 0, days: register.days };
    }
    return {
      class: getClass(classId),
      monthLabel: monthLongYear(month),
      feeBanner: can(staff.role, 'payments.view') ? fees.classFeeBanner(classId) : null,
      ...data,
    };
  });

  router.put('/api/admin/progress/:studentId/:month', (ctx) => {
    const staff = allow(ctx, ['progress.manage', 'progress.enter']);
    const student = getStudent(Number(ctx.params.studentId));
    if (!student) throw new HttpError(404, 'Student not found.');
    academics.assertClassAccess(staff, student.classId);
    const report = progress.saveReport(student.id, ctx.params.month, ctx.body, { publish: ctx.body.publish === true });
    return { report };
  });

  router.post('/api/admin/progress/publish', (ctx) => {
    const staff = allow(ctx, ['progress.manage', 'progress.enter']);
    const classId = classIdParam(ctx.body.classId);
    if (classId !== null) academics.assertClassAccess(staff, classId);
    else if (!can(staff.role, 'progress.manage')) throw new HttpError(400, 'Choose a class.');
    return progress.publishDrafts(classId, String(ctx.body.month ?? ''));
  });

  // ---- Notices (admin) ------------------------------------------------------------------------

  router.get('/api/admin/notices', (ctx) => {
    allow(ctx, 'notices.manage');
    return { notices: notices.listNotices() };
  });

  router.post('/api/admin/notices', (ctx) => {
    allow(ctx, 'notices.manage');
    return notices.createNotice({ ...ctx.body, classId: classIdParam(ctx.body.classId) });
  });

  router.delete('/api/admin/notices/:id', (ctx) => {
    allow(ctx, 'notices.manage');
    notices.deleteNotice(Number(ctx.params.id));
    return { ok: true };
  });

  // ---- Users and audit log (admin) -------------------------------------------------------------

  router.get('/api/admin/users', (ctx) => {
    allow(ctx, 'users.manage');
    return { users: listUsers(), roles: ROLES, loginRoles: LOGIN_ROLES };
  });

  router.post('/api/admin/users', (ctx) => {
    const staff = allow(ctx, 'users.manage');
    const user = createUser(ctx.body);
    audit(staff, 'user.created', { entity: 'staff', entityId: user.id, details: { name: user.name, email: user.email, role: user.role, designation: user.designation } });
    return { user };
  });

  router.put('/api/admin/users/:id', (ctx) => {
    const staff = allow(ctx, 'users.manage');
    const user = updateUser(Number(ctx.params.id), ctx.body, staff);
    const { password, ...changes } = ctx.body;
    audit(staff, 'user.updated', { entity: 'staff', entityId: user.id, details: { ...changes, passwordReset: Boolean(password) } });
    return { user };
  });

  router.get('/api/admin/audit', (ctx) => {
    allow(ctx, 'audit.view');
    const q = Object.fromEntries(ctx.query);
    return { ...recentAudit(q), actions: auditActions() };
  });
}
