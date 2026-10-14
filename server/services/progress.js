import { db, nowIso, transaction } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../http.js';
import { studentsInClass } from './students.js';
import { academicMonths, currentMonthKey, monthLong, monthRanges, monthShort } from '../../shared/format.js';

const PODIUM = /^(winner|runner[- ]?up|first|second|third|1st|2nd|3rd|gold|silver|bronze)\b/i;

const mean = (values) => values.reduce((total, v) => total + v, 0) / values.length;
const lowerFirst = (text) => text.charAt(0).toLowerCase() + text.slice(1);

// ---- Months -----------------------------------------------------------------

export const yearMonths = () => academicMonths(config.academicYear.start);

// The month the school is currently reporting on, kept inside the academic year.
export function activeMonth(now = new Date()) {
  const months = yearMonths();
  const current = currentMonthKey(now);
  if (current < months[0]) return months[0];
  if (current > months.at(-1)) return months.at(-1);
  return current;
}

// Months staff can enter progress for, newest first.
export function reportableMonths(now = new Date()) {
  const active = activeMonth(now);
  return yearMonths()
    .filter((m) => m <= active && !config.academicYear.breakMonths.includes(m))
    .reverse();
}

function assertReportable(month) {
  if (!reportableMonths().includes(month)) throw new HttpError(400, 'Progress cannot be entered for that month.');
}

// ---- Reading ----------------------------------------------------------------

function hydrate(row) {
  const scores = new Map(
    db.prepare('SELECT subject, score FROM progress_marks WHERE report_id = ?').all(row.id).map((m) => [m.subject, m.score]),
  );
  const activities = db
    .prepare('SELECT name, result FROM progress_activities WHERE report_id = ? ORDER BY position')
    .all(row.id)
    .map((a) => ({ name: a.name, result: a.result }));
  const marks = config.subjects.map((subject) => ({ subject, score: scores.get(subject) ?? null }));
  const filled = marks.map((m) => m.score).filter((s) => s !== null);

  return {
    id: row.id,
    month: row.month,
    status: row.status,
    daysPresent: row.days_present,
    schoolDays: row.school_days,
    remarks: row.remarks,
    marks,
    activities,
    avg: filled.length ? Math.round(mean(filled)) : null,
    attPct: row.school_days ? Math.round((row.days_present / row.school_days) * 100) : null,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  };
}

export function readReport(studentId, month) {
  const row = db.prepare('SELECT * FROM progress_reports WHERE student_id = ? AND month = ?').get(studentId, month);
  return row ? hydrate(row) : null;
}

export function publishedReports(studentId) {
  return db
    .prepare("SELECT * FROM progress_reports WHERE student_id = ? AND status = 'published' ORDER BY month")
    .all(studentId)
    .map(hydrate);
}

export function latestPublished(studentId) {
  const row = db
    .prepare("SELECT * FROM progress_reports WHERE student_id = ? AND status = 'published' ORDER BY month DESC LIMIT 1")
    .get(studentId);
  return row ? hydrate(row) : null;
}

const isComplete = (report) =>
  report.marks.every((m) => m.score !== null) &&
  report.schoolDays !== null &&
  report.daysPresent !== null &&
  report.remarks.trim() !== '';

// ---- Annual summary -----------------------------------------------------------

export function annualReport(studentId) {
  const reports = publishedReports(studentId);
  const byMonth = new Map(reports.map((r) => [r.month, r]));
  const months = yearMonths();
  const active = activeMonth();

  const bars = months.map((month) => ({
    month,
    label: monthShort(month).charAt(0),
    name: monthShort(month),
    value: byMonth.get(month)?.avg ?? null,
  }));

  const allScores = reports.flatMap((r) => r.marks.map((m) => m.score)).filter((s) => s !== null);
  const withAttendance = reports.filter((r) => r.schoolDays);
  const present = withAttendance.reduce((t, r) => t + r.daysPresent, 0);
  const days = withAttendance.reduce((t, r) => t + r.schoolDays, 0);

  const subjects = config.subjects.map((name) => {
    const points = reports
      .map((r) => ({ month: r.month, score: r.marks.find((m) => m.subject === name)?.score ?? null }))
      .filter((p) => p.score !== null);
    if (!points.length) return { name, avg: null, trend: null, since: null };
    return {
      name,
      avg: Math.round(mean(points.map((p) => p.score))),
      trend: points.length > 1 ? points.at(-1).score - points[0].score : null,
      since: monthShort(points[0].month),
    };
  });

  const highlights = [...reports]
    .reverse()
    .flatMap((r) =>
      r.activities
        .filter((a) => PODIUM.test(a.result))
        .map((a) => `${a.result}, ${lowerFirst(a.name)} (${monthShort(r.month)})`),
    );
  const strongest = subjects.filter((s) => s.avg !== null).sort((a, b) => b.avg - a.avg)[0];
  if (strongest) highlights.push(`Strongest subject: ${strongest.name}`);

  const note = [];
  const { breakMonths, breakLabel } = config.academicYear;
  if (breakMonths.length) note.push(`${monthRanges(breakMonths)}: ${breakLabel}`);
  const upcoming = months.filter((m) => m > active);
  if (upcoming.length) note.push(`${monthRanges(upcoming)}: upcoming`);

  const latest = reports.at(-1);
  return {
    yearLabel: config.academicYear.label,
    avgAll: allScores.length ? Math.round(mean(allScores)) : null,
    attAll: days ? Math.round((present / days) * 100) : null,
    activities: reports.reduce((t, r) => t + r.activities.length, 0),
    bars,
    note: note.join(' · '),
    subjects,
    highlights,
    latestRemark: latest ? { month: monthLong(latest.month), text: latest.remarks } : null,
    reports,
  };
}

// ---- Staff entry --------------------------------------------------------------

export function classProgress(classId, month) {
  assertReportable(month);
  const students = studentsInClass(classId).map((student) => {
    const report = readReport(student.id, month);
    const status = !report ? 'Pending' : report.status === 'published' ? 'Published' : 'Draft';
    return { ...student, status, report };
  });

  // Most students share the same number of school days; suggest it for new entries.
  const counts = new Map();
  for (const s of students) {
    const days = s.report?.schoolDays;
    if (days) counts.set(days, (counts.get(days) ?? 0) + 1);
  }
  const suggestedSchoolDays = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return { month, students, suggestedSchoolDays };
}

function optionalInt(value, label, min, max) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${label} must be a whole number from ${min} to ${max}.`);
  }
  return n;
}

function cleanInput(input) {
  const marks = config.subjects.map((subject) => ({
    subject,
    score: optionalInt(input.marks?.[subject], `${subject} marks`, 0, 100),
  }));
  const schoolDays = optionalInt(input.schoolDays, 'School days', 1, 31);
  const daysPresent = optionalInt(input.daysPresent, 'Days present', 0, 31);
  if (daysPresent !== null && schoolDays !== null && daysPresent > schoolDays) {
    throw new HttpError(400, 'Days present cannot be more than school days.');
  }

  const remarks = String(input.remarks ?? '').trim();
  if (remarks.length > 1000) throw new HttpError(400, 'Remarks must be under 1,000 characters.');

  const rawActivities = Array.isArray(input.activities) ? input.activities : [];
  if (rawActivities.length > 20) throw new HttpError(400, 'Add at most 20 activities.');
  const activities = rawActivities.map((a) => {
    const name = String(a?.name ?? '').trim();
    const result = String(a?.result ?? '').trim();
    if (!name || name.length > 80) throw new HttpError(400, 'Each activity needs a name under 80 characters.');
    if (result.length > 40) throw new HttpError(400, 'Activity results must be under 40 characters.');
    return { name, result };
  });

  return { marks, schoolDays, daysPresent, remarks, activities };
}

// Saves a report. Publishing makes it visible to parents; a report that is
// already published stays published when it is edited.
export function saveReport(studentId, month, input, { publish = false } = {}) {
  assertReportable(month);
  const data = cleanInput(input);

  return transaction(() => {
    const existing = db
      .prepare('SELECT id, status, published_at FROM progress_reports WHERE student_id = ? AND month = ?')
      .get(studentId, month);
    const status = publish || existing?.status === 'published' ? 'published' : 'draft';

    if (status === 'published') {
      const missing = [];
      if (data.marks.some((m) => m.score === null)) missing.push('marks for every subject');
      if (data.schoolDays === null || data.daysPresent === null) missing.push('attendance');
      if (!data.remarks) missing.push('teacher remarks');
      if (missing.length) throw new HttpError(400, `Before publishing, add ${missing.join(', ')}.`);
    }

    const now = nowIso();
    const publishedAt = status === 'published' ? existing?.published_at || now : null;
    let id = existing?.id;
    if (id) {
      db.prepare(
        `UPDATE progress_reports
         SET days_present = ?, school_days = ?, remarks = ?, status = ?, updated_at = ?, published_at = ?
         WHERE id = ?`,
      ).run(data.daysPresent, data.schoolDays, data.remarks, status, now, publishedAt, id);
      db.prepare('DELETE FROM progress_marks WHERE report_id = ?').run(id);
      db.prepare('DELETE FROM progress_activities WHERE report_id = ?').run(id);
    } else {
      id = Number(
        db
          .prepare(
            `INSERT INTO progress_reports (student_id, month, days_present, school_days, remarks, status, updated_at, published_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(studentId, month, data.daysPresent, data.schoolDays, data.remarks, status, now, publishedAt).lastInsertRowid,
      );
    }

    const insertMark = db.prepare('INSERT INTO progress_marks (report_id, subject, score) VALUES (?, ?, ?)');
    for (const m of data.marks) insertMark.run(id, m.subject, m.score);
    const insertActivity = db.prepare(
      'INSERT INTO progress_activities (report_id, position, name, result) VALUES (?, ?, ?, ?)',
    );
    data.activities.forEach((a, i) => insertActivity.run(id, i, a.name, a.result));

    return readReport(studentId, month);
  });
}

// Publishes every complete draft in a class. Incomplete drafts are left alone.
export function publishDrafts(classId, month) {
  assertReportable(month);
  const drafts = db
    .prepare(
      `SELECT r.*, s.name AS student_name FROM progress_reports r
       JOIN students s ON s.id = r.student_id
       WHERE s.class_id = ? AND r.month = ? AND r.status = 'draft'
       ORDER BY s.roll_no`,
    )
    .all(classId, month);

  const now = nowIso();
  const skipped = [];
  let published = 0;
  transaction(() => {
    for (const row of drafts) {
      if (!isComplete(hydrate(row))) {
        skipped.push(row.student_name);
        continue;
      }
      db.prepare("UPDATE progress_reports SET status = 'published', published_at = ?, updated_at = ? WHERE id = ?").run(
        now,
        now,
        row.id,
      );
      published += 1;
    }
  });
  return { published, skipped };
}

export function monthStatusCounts(month) {
  return db
    .prepare(
      `SELECT c.id, c.name, COUNT(s.id) AS total,
              SUM(CASE WHEN r.status = 'published' THEN 1 ELSE 0 END) AS published,
              SUM(CASE WHEN r.status = 'draft' THEN 1 ELSE 0 END) AS drafts
       FROM classes c
       LEFT JOIN students s ON s.class_id = c.id
       LEFT JOIN progress_reports r ON r.student_id = s.id AND r.month = ?
       GROUP BY c.id ORDER BY c.name`,
    )
    .all(month)
    .map((r) => ({ classId: r.id, className: r.name, total: r.total, published: r.published ?? 0, drafts: r.drafts ?? 0 }));
}
