import { db, transaction } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../http.js';
import { can } from '../permissions.js';
import { classLabel, sectionName } from '../../shared/school.js';
import { todayIso } from '../../shared/format.js';

// Subjects, which classes each teacher teaches, and the weekly timetable.
//
// Teachers see only their own classes: the ones they are assigned to here
// (as class teacher or subject teacher), including any class where the
// timetable gives them a period.

// ---- Subjects ------------------------------------------------------------------------

export function listSubjects({ includeInactive = false } = {}) {
  return db
    .prepare(`SELECT id, name, active FROM subjects ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort_order, name`)
    .all()
    .map((s) => ({ id: s.id, name: s.name, active: Boolean(s.active) }));
}

export function addSubject(rawName) {
  const name = String(rawName ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 40) throw new HttpError(400, 'Give the subject a name, like “Computer Science”.');
  const existing = db.prepare('SELECT id, active FROM subjects WHERE lower(name) = lower(?)').get(name);
  if (existing?.active) throw new HttpError(409, `“${name}” is already a subject.`);
  if (existing) {
    db.prepare('UPDATE subjects SET active = 1 WHERE id = ?').run(existing.id);
    return { id: existing.id, name, active: true };
  }
  const order = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM subjects').get().n;
  const { lastInsertRowid } = db.prepare('INSERT INTO subjects (name, sort_order) VALUES (?, ?)').run(name, order);
  return { id: Number(lastInsertRowid), name, active: true };
}

export function setSubjectActive(id, active) {
  const subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(id);
  if (!subject) throw new HttpError(404, 'Subject not found.');
  db.prepare('UPDATE subjects SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  return { id, name: subject.name, active };
}

// ---- Teachers and their classes ---------------------------------------------------------

const classRow = (c) => ({ classId: c.id, name: c.name, grade: c.grade, section: c.section, label: classLabel(c.grade, c.section) });

export function teacherClasses(staffId) {
  return db
    .prepare(
      `SELECT c.id, c.name, c.grade, c.section, tc.class_teacher
       FROM teacher_classes tc JOIN classes c ON c.id = tc.class_id
       WHERE tc.staff_id = ? ORDER BY c.sort_order`,
    )
    .all(staffId)
    .map((c) => ({ ...classRow(c), classTeacher: Boolean(c.class_teacher) }));
}

export function listTeachers({ includeInactive = false } = {}) {
  const teachers = db
    .prepare(`SELECT id, name, designation, active FROM staff WHERE role = 'teacher' ${includeInactive ? '' : 'AND active = 1'} ORDER BY name`)
    .all();
  return teachers.map((t) => ({ id: t.id, name: t.name, designation: t.designation, active: Boolean(t.active), classes: teacherClasses(t.id) }));
}

// Replaces a teacher's classes. Each entry: { classId, classTeacher }.
export function assignClasses(staffId, entries) {
  const teacher = db.prepare("SELECT id, name FROM staff WHERE id = ? AND role = 'teacher'").get(staffId);
  if (!teacher) throw new HttpError(404, 'Teacher not found.');
  const list = Array.isArray(entries) ? entries : [];
  const seen = new Set();
  return transaction(() => {
    db.prepare('DELETE FROM teacher_classes WHERE staff_id = ?').run(staffId);
    for (const entry of list) {
      const classId = Number(entry?.classId);
      if (seen.has(classId)) continue;
      seen.add(classId);
      const cls = db.prepare('SELECT id, grade, section FROM classes WHERE id = ?').get(classId);
      if (!cls) throw new HttpError(400, 'One of the classes no longer exists. Refresh and try again.');
      if (entry.classTeacher) {
        const other = db
          .prepare('SELECT s.name FROM teacher_classes tc JOIN staff s ON s.id = tc.staff_id WHERE tc.class_id = ? AND tc.class_teacher = 1 AND tc.staff_id != ?')
          .get(classId, staffId);
        if (other) throw new HttpError(409, `${other.name} is already the class teacher of ${classLabel(cls.grade, cls.section)}.`);
      }
      db.prepare('INSERT INTO teacher_classes (staff_id, class_id, class_teacher) VALUES (?, ?, ?)').run(staffId, classId, entry.classTeacher ? 1 : 0);
    }
    return teacherClasses(staffId);
  });
}

export function classTeacherOf(classId) {
  return db
    .prepare('SELECT s.id, s.name FROM teacher_classes tc JOIN staff s ON s.id = tc.staff_id WHERE tc.class_id = ? AND tc.class_teacher = 1')
    .get(classId) ?? null;
}

// The classes a staff member may see: null means all (admin, clerk).
export function classScope(staff) {
  if (!can(staff.role, 'teaching')) return null;
  return new Set(teacherClasses(staff.id).map((c) => c.classId));
}

export function assertClassAccess(staff, classId) {
  const scope = classScope(staff);
  if (scope && !scope.has(Number(classId))) throw new HttpError(403, 'This class is not assigned to you. Please ask the school admin.');
}

// Is this teacher the class teacher (not only a subject teacher) of the class?
export const isClassTeacher = (staffId, classId) =>
  Boolean(db.prepare('SELECT 1 FROM teacher_classes WHERE staff_id = ? AND class_id = ? AND class_teacher = 1').get(staffId, classId));

// ---- Students for teachers (no fee details) ----------------------------------------------

export function classStudents(classId, { withContacts = false } = {}) {
  const cls = db.prepare('SELECT id, grade, section FROM classes WHERE id = ?').get(classId);
  if (!cls) throw new HttpError(404, 'Class not found.');
  const students = db
    .prepare(
      `SELECT id, name, roll_no, admission_no, gender, father_name, mother_name, parent_name, parent_phone
       FROM students WHERE class_id = ? AND active = 1 ORDER BY roll_no, name`,
    )
    .all(classId)
    .map((s) => ({
      id: s.id,
      name: s.name,
      rollNo: s.roll_no,
      admissionNo: s.admission_no,
      gender: s.gender,
      parentNames: [s.father_name, s.mother_name].filter(Boolean).join(' / ') || s.parent_name,
      ...(withContacts ? { parentPhone: s.parent_phone } : {}),
    }));
  return { class: { ...classRow({ ...cls, name: sectionName(cls.grade, cls.section) }), classTeacher: classTeacherOf(classId) }, students };
}

// ---- Timetable ----------------------------------------------------------------------------

const DAYS = () => config.timetable.days;
const PERIODS = () => config.timetable.periods;

function cells(where, ...args) {
  return db
    .prepare(
      `SELECT t.class_id, t.day, t.period, t.subject_id, sub.name AS subject, t.staff_id, st.name AS teacher, c.grade, c.section
       FROM timetable t
       JOIN classes c ON c.id = t.class_id
       LEFT JOIN subjects sub ON sub.id = t.subject_id
       LEFT JOIN staff st ON st.id = t.staff_id
       WHERE ${where} ORDER BY t.day, t.period`,
    )
    .all(...args)
    .map((r) => ({
      classId: r.class_id,
      classLabel: classLabel(r.grade, r.section),
      className: sectionName(r.grade, r.section),
      day: r.day,
      period: r.period,
      subjectId: r.subject_id,
      subject: r.subject,
      teacherId: r.staff_id,
      teacher: r.teacher,
    }));
}

export const timetableShape = () => ({ days: DAYS(), periods: PERIODS(), breakAfter: config.timetable.breakAfter });

export function classTimetable(classId) {
  const cls = db.prepare('SELECT id, grade, section FROM classes WHERE id = ?').get(classId);
  if (!cls) throw new HttpError(404, 'Class not found.');
  return { ...timetableShape(), class: { classId: cls.id, label: classLabel(cls.grade, cls.section) }, cells: cells('t.class_id = ?', classId) };
}

export function teacherTimetable(staffId) {
  return { ...timetableShape(), cells: cells('t.staff_id = ?', staffId) };
}

// Monday = 1 … Saturday = 6; Sunday = 0 (no periods).
export function weekday(date = todayIso()) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function teacherDay(staffId, date = todayIso()) {
  const day = weekday(date);
  const list = day === 0 ? [] : cells('t.staff_id = ? AND t.day = ?', staffId, day);
  return PERIODS().map((p) => ({ ...p, lesson: list.find((c) => c.period === p.period) ?? null }));
}

// Sets one period of a class's timetable (subject and teacher; both empty clears it).
export function setTimetableCell(classId, day, period, { subjectId, teacherId }) {
  const cls = db.prepare('SELECT id, grade, section FROM classes WHERE id = ?').get(classId);
  if (!cls) throw new HttpError(404, 'Class not found.');
  if (!Number.isInteger(day) || day < 1 || day > DAYS().length) throw new HttpError(400, 'Choose a day from Monday to Saturday.');
  if (!PERIODS().some((p) => p.period === period)) throw new HttpError(400, 'Choose a period.');
  const subject = subjectId ? db.prepare('SELECT id, name FROM subjects WHERE id = ? AND active = 1').get(Number(subjectId)) : null;
  if (subjectId && !subject) throw new HttpError(400, 'Choose a subject from the list.');
  const teacher = teacherId ? db.prepare("SELECT id, name FROM staff WHERE id = ? AND role = 'teacher' AND active = 1").get(Number(teacherId)) : null;
  if (teacherId && !teacher) throw new HttpError(400, 'Choose a teacher from the list.');

  return transaction(() => {
    if (!subject && !teacher) {
      db.prepare('DELETE FROM timetable WHERE class_id = ? AND day = ? AND period = ?').run(classId, day, period);
      return null;
    }
    if (teacher) {
      const clash = db
        .prepare('SELECT c.grade, c.section FROM timetable t JOIN classes c ON c.id = t.class_id WHERE t.staff_id = ? AND t.day = ? AND t.period = ? AND t.class_id != ?')
        .get(teacher.id, day, period, classId);
      if (clash) {
        throw new HttpError(409, `${teacher.name} already teaches ${classLabel(clash.grade, clash.section)} in period ${period} on ${DAYS()[day - 1]}.`);
      }
      // A teacher with a period in a class can see that class.
      db.prepare('INSERT OR IGNORE INTO teacher_classes (staff_id, class_id, class_teacher) VALUES (?, ?, 0)').run(teacher.id, classId);
    }
    db.prepare(
      `INSERT INTO timetable (class_id, day, period, subject_id, staff_id) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (class_id, day, period) DO UPDATE SET subject_id = excluded.subject_id, staff_id = excluded.staff_id`,
    ).run(classId, day, period, subject?.id ?? null, teacher?.id ?? null);
    return cells('t.class_id = ? AND t.day = ? AND t.period = ?', classId, day, period)[0];
  });
}

