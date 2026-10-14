import { HttpError, sendDownload } from '../http.js';
import { allow, can } from '../permissions.js';
import { audit } from '../audit.js';
import * as academics from '../services/academics.js';
import * as attendance from '../services/attendance.js';
import * as parentAccess from '../services/parent-access.js';
import { getClass, getStudent } from '../services/students.js';
import { exportTable, FORMATS } from '../integrations/export/index.js';
import { currentMonthKey, todayIso } from '../../shared/format.js';

// Teachers, attendance, subjects, timetable and parent app access (staff side).
// Teachers only ever reach the classes assigned to them (academics.classScope).

const classParam = (value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Choose a class.');
  return getClass(id).id;
};
const monthParam = (value) => (/^\d{4}-\d{2}$/.test(String(value ?? '')) ? value : currentMonthKey());

export function schoolRoutes(router) {
  // ---- Teachers: My Day and My Classes -------------------------------------------------------

  router.get('/api/admin/my-day', (ctx) => {
    const staff = allow(ctx, 'teaching');
    const date = todayIso();
    const scope = academics.classScope(staff);
    return {
      date,
      periods: academics.teacherDay(staff.id, date),
      classes: academics.teacherClasses(staff.id),
      attendance: attendance.daySummary(date, scope),
      absentees: attendance.absentees(date, scope),
    };
  });

  router.get('/api/admin/classes/:id/students', (ctx) => {
    const staff = allow(ctx, ['teaching', 'students.view']);
    const classId = classParam(ctx.params.id);
    academics.assertClassAccess(staff, classId);
    // Parent phone numbers: office staff, and the class teacher of this class.
    const withContacts = can(staff.role, 'students.view') || academics.isClassTeacher(staff.id, classId);
    return academics.classStudents(classId, { withContacts });
  });

  // ---- Attendance -------------------------------------------------------------------------------

  router.get('/api/admin/attendance', (ctx) => {
    const staff = allow(ctx, ['attendance.mark', 'attendance.view']);
    const classId = classParam(ctx.query.get('classId'));
    academics.assertClassAccess(staff, classId);
    return attendance.classAttendance(classId, ctx.query.get('date') || todayIso());
  });

  router.put('/api/admin/attendance', (ctx) => {
    const staff = allow(ctx, 'attendance.mark');
    const classId = classParam(ctx.body.classId);
    academics.assertClassAccess(staff, classId);
    const result = attendance.saveAttendance(classId, String(ctx.body.date ?? ''), ctx.body.entries, staff);
    audit(staff, 'attendance.saved', {
      entity: 'class',
      entityId: classId,
      details: { class: result.class.label, date: result.date, present: result.counts.attended, absent: result.counts.absent, leave: result.counts.leave },
    });
    return result;
  });

  router.get('/api/admin/attendance/summary', (ctx) => {
    const staff = allow(ctx, ['attendance.mark', 'attendance.view']);
    return attendance.daySummary(ctx.query.get('date') || todayIso(), academics.classScope(staff));
  });

  router.get('/api/admin/attendance/register', (ctx) => {
    const staff = allow(ctx, ['attendance.mark', 'attendance.view']);
    const classId = classParam(ctx.query.get('classId'));
    academics.assertClassAccess(staff, classId);
    return attendance.monthlyRegister(classId, monthParam(ctx.query.get('month')));
  });

  router.get('/api/admin/attendance/register/export', (ctx) => {
    const staff = allow(ctx, ['attendance.mark', 'attendance.view']);
    const classId = classParam(ctx.query.get('classId'));
    academics.assertClassAccess(staff, classId);
    const format = ctx.query.get('format') ?? 'xlsx';
    if (!FORMATS[format]) throw new HttpError(400, 'Choose Excel (xlsx) or CSV.');
    const register = attendance.monthlyRegister(classId, monthParam(ctx.query.get('month')));
    const file = exportTable(format, { title: register.title, sheetName: 'Attendance', columns: register.columns, rows: register.rows });
    audit(staff, 'report.exported', { details: { report: 'attendance', format, rows: register.rows.length, class: register.class.label, month: register.month } });
    sendDownload(ctx.res, file.buffer, { type: file.contentType, filename: `KBS-${register.filename}.${file.extension}` });
  });

  router.get('/api/admin/students/:id/attendance', (ctx) => {
    const staff = allow(ctx, ['students.view', 'teaching']);
    const student = getStudent(Number(ctx.params.id));
    if (!student) throw new HttpError(404, 'Student not found.');
    academics.assertClassAccess(staff, student.classId);
    return attendance.studentAttendance(student.id, monthParam(ctx.query.get('month')));
  });

  // ---- Subjects and teachers' classes (admin) -----------------------------------------------------

  router.get('/api/admin/subjects', (ctx) => {
    const staff = allow(ctx, ['timetable.view', 'teaching']);
    return { subjects: academics.listSubjects({ includeInactive: can(staff.role, 'timetable.manage') }) };
  });

  router.post('/api/admin/subjects', (ctx) => {
    const staff = allow(ctx, 'timetable.manage');
    const subject = academics.addSubject(ctx.body.name);
    audit(staff, 'subject.added', { details: subject });
    return { subject };
  });

  router.post('/api/admin/subjects/:id/status', (ctx) => {
    const staff = allow(ctx, 'timetable.manage');
    const subject = academics.setSubjectActive(Number(ctx.params.id), ctx.body.active === true);
    audit(staff, subject.active ? 'subject.restored' : 'subject.removed', { details: subject });
    return { subject };
  });

  router.get('/api/admin/teachers', (ctx) => {
    allow(ctx, ['timetable.manage', 'timetable.view']);
    return { teachers: academics.listTeachers() };
  });

  router.put('/api/admin/teachers/:id/classes', (ctx) => {
    const staff = allow(ctx, 'timetable.manage');
    const classes = academics.assignClasses(Number(ctx.params.id), ctx.body.classes);
    audit(staff, 'teacher.classes', { entity: 'staff', entityId: ctx.params.id, details: { classes: classes.map((c) => `${c.label}${c.classTeacher ? ' (class teacher)' : ''}`) } });
    return { classes };
  });

  // ---- Timetable --------------------------------------------------------------------------------

  router.get('/api/admin/timetable', (ctx) => {
    const staff = allow(ctx, ['timetable.view', 'teaching']);
    const classId = classParam(ctx.query.get('classId'));
    academics.assertClassAccess(staff, classId);
    return academics.classTimetable(classId);
  });

  router.get('/api/admin/timetable/mine', (ctx) => {
    const staff = allow(ctx, 'teaching');
    return academics.teacherTimetable(staff.id);
  });

  router.get('/api/admin/timetable/teacher/:id', (ctx) => {
    allow(ctx, 'timetable.view');
    return academics.teacherTimetable(Number(ctx.params.id));
  });

  router.put('/api/admin/timetable/:classId/:day/:period', (ctx) => {
    const staff = allow(ctx, 'timetable.manage');
    const classId = classParam(ctx.params.classId);
    const cell = academics.setTimetableCell(classId, Number(ctx.params.day), Number(ctx.params.period), {
      subjectId: ctx.body.subjectId || null,
      teacherId: ctx.body.teacherId || null,
    });
    audit(staff, 'timetable.changed', {
      entity: 'class',
      entityId: classId,
      details: { day: Number(ctx.params.day), period: Number(ctx.params.period), subject: cell?.subject ?? null, teacher: cell?.teacher ?? null },
    });
    return { cell };
  });

  // ---- Parent app access ------------------------------------------------------------------------

  router.get('/api/admin/parents', (ctx) => {
    allow(ctx, 'parents.access');
    return {
      families: parentAccess.listFamilies({ q: ctx.query.get('q') ?? '', status: ctx.query.get('status') ?? '' }),
      labels: parentAccess.ACCESS_LABELS,
    };
  });

  router.post('/api/admin/parents/:phone/code', (ctx) => {
    const staff = allow(ctx, 'parents.access');
    const result = parentAccess.issueAccessCode(ctx.params.phone);
    audit(staff, 'parent.code_issued', { entity: 'parent', entityId: result.phone, details: { children: result.children.map((c) => c.name), expiresAt: result.expiresAt } });
    return result;
  });

  router.post('/api/admin/parents/:phone/status', (ctx) => {
    const staff = allow(ctx, 'students.edit');
    const active = ctx.body.active === true;
    const result = parentAccess.setFamilyAccess(ctx.params.phone, active);
    audit(staff, active ? 'parent.enabled' : 'parent.disabled', { entity: 'parent', entityId: result.phone, details: { children: result.children.map((c) => c.name) } });
    return result;
  });
}
