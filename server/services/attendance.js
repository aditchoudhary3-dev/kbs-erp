import { db, nowIso, transaction } from '../db.js';
import { HttpError } from '../http.js';
import { can } from '../permissions.js';
import { classStudents } from './academics.js';
import { classLabel, sectionName } from '../../shared/school.js';
import { addMonths, currentMonthKey, monthLongYear, todayIso } from '../../shared/format.js';

// Daily attendance: one mark per student per school day.
//   present · absent · late (counts as present) · leave (absent with permission)

export const STATUSES = ['present', 'absent', 'late', 'leave'];
export const STATUS_LABELS = { present: 'Present', absent: 'Absent', late: 'Late', leave: 'Leave' };
const CODE = { present: 'P', absent: 'A', late: 'L', leave: 'Lv' };

// How far back each role may mark or change attendance.
const TEACHER_DAYS_BACK = 7;

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) && !Number.isNaN(Date.parse(v));
const shift = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

function tally(statuses) {
  const t = { present: 0, absent: 0, late: 0, leave: 0 };
  for (const s of statuses) t[s] += 1;
  const days = statuses.length;
  return { ...t, days, attended: t.present + t.late, pct: days ? Math.round(((t.present + t.late) / days) * 100) : null };
}

// One class on one day: every student with their mark (or none yet).
export function classAttendance(classId, date) {
  if (!isDate(date)) throw new HttpError(400, 'Choose a date.');
  const { class: cls, students } = classStudents(classId);
  const marks = new Map(
    db.prepare('SELECT student_id, status, note FROM attendance WHERE class_id = ? AND date = ?').all(classId, date).map((r) => [r.student_id, r]),
  );
  const last = db
    .prepare('SELECT a.marked_at, s.name FROM attendance a LEFT JOIN staff s ON s.id = a.marked_by WHERE a.class_id = ? AND a.date = ? ORDER BY a.marked_at DESC LIMIT 1')
    .get(classId, date);
  const list = students.map((s) => ({ id: s.id, name: s.name, rollNo: s.rollNo, admissionNo: s.admissionNo, status: marks.get(s.id)?.status ?? null, note: marks.get(s.id)?.note ?? '' }));
  return {
    date,
    class: cls,
    students: list,
    marked: marks.size > 0,
    complete: list.length > 0 && list.every((s) => s.status),
    markedBy: last?.name ?? null,
    markedAt: last?.marked_at ?? null,
    counts: tally(list.filter((s) => s.status).map((s) => s.status)),
  };
}

// Saves a class's marks for a day. entries: [{ studentId, status, note }].
export function saveAttendance(classId, date, entries, staff) {
  if (!isDate(date)) throw new HttpError(400, 'Choose a date.');
  const today = todayIso();
  if (date > today) throw new HttpError(400, 'Attendance cannot be marked for a future date.');
  if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) throw new HttpError(400, 'That date is a Sunday.');
  if (!can(staff.role, 'timetable.manage') && date < shift(today, -TEACHER_DAYS_BACK)) {
    throw new HttpError(403, `Teachers can mark or change attendance for the last ${TEACHER_DAYS_BACK} days. Ask the school admin for older dates.`);
  }
  const { students } = classStudents(classId);
  const inClass = new Set(students.map((s) => s.id));
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) throw new HttpError(400, 'Mark at least one student.');

  return transaction(() => {
    const now = nowIso();
    const upsert = db.prepare(
      `INSERT INTO attendance (student_id, date, class_id, status, note, marked_by, marked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (student_id, date) DO UPDATE SET class_id = excluded.class_id, status = excluded.status, note = excluded.note,
         marked_by = excluded.marked_by, marked_at = excluded.marked_at`,
    );
    for (const entry of list) {
      const studentId = Number(entry?.studentId);
      if (!inClass.has(studentId)) throw new HttpError(400, 'One of the students is not in this class. Refresh and try again.');
      if (!STATUSES.includes(entry.status)) throw new HttpError(400, 'Each student must be Present, Absent, Late or on Leave.');
      const note = String(entry.note ?? '').trim().slice(0, 120) || null;
      upsert.run(studentId, date, classId, entry.status, note, staff.id, now);
    }
    return classAttendance(classId, date);
  });
}

// One student's marks for a month, with totals (parent app, student page).
export function studentAttendance(studentId, month = currentMonthKey()) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, 'Choose a month.');
  const from = `${month}-01`;
  const to = `${addMonths(month, 1)}-01`;
  const days = db
    .prepare('SELECT date, status, note FROM attendance WHERE student_id = ? AND date >= ? AND date < ? ORDER BY date')
    .all(studentId, from, to)
    .map((d) => ({ date: d.date, status: d.status, note: d.note }));
  const session = db.prepare("SELECT status FROM attendance WHERE student_id = ? AND date >= ?").all(studentId, sessionStart()).map((r) => r.status);
  return { month, monthLabel: monthLongYear(month), days, summary: tally(days.map((d) => d.status)), session: tally(session) };
}

function sessionStart() {
  const today = todayIso();
  const year = Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) < 4 ? 1 : 0);
  return `${year}-04-01`;
}

// The months that have any attendance for a student (for the parent app's month picker).
export function attendanceMonths(studentId) {
  const months = db
    .prepare("SELECT DISTINCT substr(date, 1, 7) AS month FROM attendance WHERE student_id = ? ORDER BY month DESC")
    .all(studentId)
    .map((r) => r.month);
  const current = currentMonthKey();
  return months.includes(current) ? months : [current, ...months];
}

// The monthly register for a class: one row per student, one column per day.
export function monthlyRegister(classId, month = currentMonthKey()) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, 'Choose a month.');
  const { class: cls, students } = classStudents(classId);
  const from = `${month}-01`;
  const to = `${addMonths(month, 1)}-01`;
  const marks = db.prepare('SELECT student_id, date, status FROM attendance WHERE class_id = ? AND date >= ? AND date < ?').all(classId, from, to);
  const dates = [...new Set(marks.map((m) => m.date))].sort();
  const byStudent = new Map();
  for (const m of marks) {
    if (!byStudent.has(m.student_id)) byStudent.set(m.student_id, new Map());
    byStudent.get(m.student_id).set(m.date, m.status);
  }
  const rows = students.map((s) => {
    const own = byStudent.get(s.id) ?? new Map();
    const t = tally([...own.values()]);
    const row = { rollNo: s.rollNo, admissionNo: s.admissionNo, name: s.name, present: t.attended, absent: t.absent, leave: t.leave, late: t.late, pct: t.pct === null ? '' : `${t.pct}%`, id: s.id };
    for (const date of dates) row[`d${date.slice(8)}`] = own.has(date) ? CODE[own.get(date)] : '';
    return row;
  });
  return {
    title: `Attendance register · ${cls.label}`,
    subtitle: `${monthLongYear(month)} · ${dates.length} school day${dates.length === 1 ? '' : 's'} marked`,
    filename: `attendance-${sectionName(cls.grade, cls.section)}-${month}`,
    class: cls,
    month,
    dates,
    columns: [
      { key: 'rollNo', header: 'Roll', type: 'number', width: 6 },
      { key: 'admissionNo', header: 'Admission Number', width: 17 },
      { key: 'name', header: 'Student Name', width: 22 },
      ...dates.map((d) => ({ key: `d${d.slice(8)}`, header: String(Number(d.slice(8))), width: 4 })),
      { key: 'present', header: 'Present', type: 'number', width: 9 },
      { key: 'absent', header: 'Absent', type: 'number', width: 8 },
      { key: 'leave', header: 'Leave', type: 'number', width: 7 },
      { key: 'pct', header: 'Attendance %', width: 13 },
    ],
    rows,
    legend: 'P present · A absent · L late (counts as present) · Lv leave',
  };
}

// Attendance for a month as used by monthly progress reports: days attended / days marked.
export function monthTotals(classId, month) {
  const from = `${month}-01`;
  const to = `${addMonths(month, 1)}-01`;
  const days = db.prepare('SELECT COUNT(DISTINCT date) AS n FROM attendance WHERE class_id = ? AND date >= ? AND date < ?').get(classId, from, to).n;
  const rows = db
    .prepare(
      `SELECT student_id, SUM(CASE WHEN status IN ('present', 'late') THEN 1 ELSE 0 END) AS attended
       FROM attendance WHERE class_id = ? AND date >= ? AND date < ? GROUP BY student_id`,
    )
    .all(classId, from, to);
  return { days, byStudent: new Map(rows.map((r) => [r.student_id, r.attended])) };
}

// Today across the school (or a teacher's classes): marked or not, and counts.
export function daySummary(date = todayIso(), scope = null) {
  const classes = db.prepare('SELECT id, grade, section FROM classes ORDER BY sort_order').all().filter((c) => !scope || scope.has(c.id));
  const counts = new Map(
    db
      .prepare(
        `SELECT class_id, COUNT(*) AS marked,
                SUM(CASE WHEN status IN ('present', 'late') THEN 1 ELSE 0 END) AS attended,
                SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) AS absent,
                SUM(CASE WHEN status = 'leave' THEN 1 ELSE 0 END) AS leave
         FROM attendance WHERE date = ? GROUP BY class_id`,
      )
      .all(date)
      .map((r) => [r.class_id, r]),
  );
  const strength = new Map(db.prepare('SELECT class_id, COUNT(*) AS n FROM students WHERE active = 1 GROUP BY class_id').all().map((r) => [r.class_id, r.n]));
  const rows = classes.map((c) => {
    const k = counts.get(c.id);
    return {
      classId: c.id,
      label: classLabel(c.grade, c.section),
      name: sectionName(c.grade, c.section),
      students: strength.get(c.id) ?? 0,
      marked: Boolean(k),
      attended: k?.attended ?? 0,
      absent: k?.absent ?? 0,
      leave: k?.leave ?? 0,
    };
  });
  const marked = rows.filter((r) => r.marked);
  const totalMarked = marked.reduce((t, r) => t + r.attended + r.absent + r.leave, 0);
  return {
    date,
    classes: rows,
    markedClasses: marked.length,
    totalClasses: rows.length,
    attended: marked.reduce((t, r) => t + r.attended, 0),
    absent: marked.reduce((t, r) => t + r.absent, 0),
    leave: marked.reduce((t, r) => t + r.leave, 0),
    pct: totalMarked ? Math.round((marked.reduce((t, r) => t + r.attended, 0) / totalMarked) * 100) : null,
  };
}

// Students marked absent on a day (for the assistant and the dashboard).
export function absentees(date = todayIso(), scope = null) {
  return db
    .prepare(
      `SELECT s.id, s.name, s.admission_no, c.id AS class_id, c.grade, c.section, a.status, a.note
       FROM attendance a JOIN students s ON s.id = a.student_id JOIN classes c ON c.id = a.class_id
       WHERE a.date = ? AND a.status IN ('absent', 'leave') ORDER BY c.sort_order, s.roll_no`,
    )
    .all(date)
    .filter((r) => !scope || scope.has(r.class_id))
    .map((r) => ({ id: r.id, name: r.name, admissionNo: r.admission_no, classLabel: classLabel(r.grade, r.section), status: r.status, note: r.note }));
}
