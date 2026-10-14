import { db, nowIso } from '../db.js';
import { HttpError } from '../http.js';
import { getClass } from './students.js';
import { monthLong } from '../../shared/format.js';

function toNotice(row) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    classId: row.class_id,
    className: row.class_name ?? null,
    createdAt: row.created_at,
  };
}

export function listNotices() {
  return db
    .prepare(
      `SELECT n.*, c.name AS class_name FROM notices n LEFT JOIN classes c ON c.id = n.class_id
       ORDER BY n.created_at DESC, n.id DESC`,
    )
    .all()
    .map(toNotice);
}

export function createNotice({ title, body, classId }) {
  const cleanTitle = String(title ?? '').trim();
  const cleanBody = String(body ?? '').trim();
  if (!cleanTitle || cleanTitle.length > 100) throw new HttpError(400, 'Write a headline under 100 characters.');
  if (cleanBody.length > 1000) throw new HttpError(400, 'Keep the message under 1,000 characters.');
  const cls = classId ? getClass(Number(classId)) : null;
  const { lastInsertRowid } = db
    .prepare('INSERT INTO notices (title, body, class_id, created_at) VALUES (?, ?, ?, ?)')
    .run(cleanTitle, cleanBody, cls?.id ?? null, nowIso());
  return { id: Number(lastInsertRowid) };
}

export function deleteNotice(id) {
  const { changes } = db.prepare('DELETE FROM notices WHERE id = ?').run(id);
  if (!changes) throw new HttpError(404, 'Notice not found.');
}

// What a parent sees in the "updates" strip: the latest published report plus
// notices for everyone or for the child's class. Newest first.
export function updatesForStudent(student, limit = 2) {
  const report = db
    .prepare(
      `SELECT month, published_at FROM progress_reports
       WHERE student_id = ? AND status = 'published' ORDER BY published_at DESC LIMIT 1`,
    )
    .get(student.id);
  const notices = db
    .prepare(
      `SELECT id, title, body, created_at FROM notices
       WHERE class_id IS NULL OR class_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(student.classId, limit);

  const updates = notices.map((n) => ({ kind: 'notice', id: n.id, text: n.title, body: n.body, at: n.created_at }));
  if (report) {
    updates.push({
      kind: 'report',
      text: `${monthLong(report.month)} report published by the school`,
      month: report.month,
      at: report.published_at,
    });
  }
  return updates.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
