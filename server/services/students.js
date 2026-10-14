import { db, nowIso, transaction } from '../db.js';
import { HttpError } from '../http.js';
import { normalizePhone } from '../auth.js';
import { GRADES, classLabel, sectionName, sortOrder } from '../../shared/school.js';
import { todayIso } from '../../shared/format.js';

const SELECT = `
  SELECT s.*, c.name AS class_name, c.grade, c.section
  FROM students s JOIN classes c ON c.id = s.class_id`;

export const GENDERS = ['Male', 'Female', 'Other'];

// Student IDs come from the database row and can never be reused.
export const studentCode = (id) => `STU${String(id).padStart(5, '0')}`;
export const nextStudentCode = () => studentCode((db.prepare('SELECT MAX(id) AS id FROM students').get().id ?? 0) + 1);

// "Rakesh Verma / Sunita Verma", falling back to the single parent name.
export function parentNames(s) {
  const names = [s.fatherName, s.motherName].filter(Boolean);
  return names.length ? names.join(' / ') : s.parentName || '';
}

function toStudent(row) {
  const student = {
    id: row.id,
    code: studentCode(row.id),
    name: row.name,
    rollNo: row.roll_no,
    admissionNo: row.admission_no,
    dob: row.dob,
    gender: row.gender,
    parentName: row.parent_name,
    fatherName: row.father_name,
    motherName: row.mother_name,
    parentPhone: row.parent_phone,
    altPhone: row.alt_phone,
    whatsappPhone: row.whatsapp_phone || row.parent_phone,
    address: row.address,
    session: row.session,
    admissionDate: row.admission_date,
    transport: Boolean(row.transport),
    busRoute: row.bus_route,
    remarks: row.remarks,
    active: Boolean(row.active),
    status: row.active ? 'Active' : 'Inactive',
    deactivatedAt: row.deactivated_at,
    classId: row.class_id,
    className: row.class_name,
    grade: row.grade,
    section: row.section,
    classLabel: classLabel(row.grade, row.section),
  };
  student.parentNames = parentNames(student);
  return student;
}

export function getStudent(id) {
  const row = db.prepare(`${SELECT} WHERE s.id = ?`).get(id);
  return row ? toStudent(row) : null;
}

export function studentsForPhone(phone) {
  return db.prepare(`${SELECT} WHERE s.parent_phone = ? AND s.active = 1 ORDER BY s.name`).all(phone).map(toStudent);
}

export function studentsInClass(classId) {
  return db.prepare(`${SELECT} WHERE s.class_id = ? AND s.active = 1 ORDER BY s.roll_no`).all(classId).map(toStudent);
}

export function allStudents() {
  return db.prepare(`${SELECT} WHERE s.active = 1 ORDER BY c.sort_order, s.roll_no`).all().map(toStudent);
}

const likePattern = (text) => `%${String(text).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// Search by name, admission number, student ID, parent or phone.
// status: 'active' (default), 'inactive' or 'all'.
export function searchStudents({ q = '', grade = '', section = '', status = 'active', limit = 50 } = {}) {
  const where = [status === 'inactive' ? 's.active = 0' : status === 'all' ? '1 = 1' : 's.active = 1'];
  const args = [];
  const text = String(q).trim();
  if (text) {
    const idMatch = /^stu0*(\d+)$/i.exec(text);
    where.push(
      `(s.name LIKE ? ESCAPE '\\' OR s.admission_no LIKE ? ESCAPE '\\' OR s.parent_phone LIKE ? ESCAPE '\\'
        OR s.alt_phone LIKE ? ESCAPE '\\' OR s.father_name LIKE ? ESCAPE '\\' OR s.mother_name LIKE ? ESCAPE '\\' OR s.id = ?)`,
    );
    const like = likePattern(text);
    const phone = likePattern(text.replace(/\D/g, '') || text);
    args.push(like, like, phone, phone, like, like, idMatch ? Number(idMatch[1]) : -1);
  }
  if (grade) {
    where.push('c.grade = ?');
    args.push(grade);
  }
  if (section) {
    where.push('c.section = ?');
    args.push(section);
  }
  return db
    .prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY c.sort_order, s.name LIMIT ?`)
    .all(...args, limit)
    .map(toStudent);
}

export function busRoutes() {
  return db.prepare("SELECT DISTINCT bus_route FROM students WHERE bus_route != '' ORDER BY bus_route").all().map((r) => r.bus_route);
}

// ---- Classes -------------------------------------------------------------------

export function listClasses() {
  return db
    .prepare(
      `SELECT c.id, c.name, c.grade, c.section, COUNT(s.id) AS student_count
       FROM classes c LEFT JOIN students s ON s.class_id = c.id AND s.active = 1
       GROUP BY c.id ORDER BY c.sort_order`,
    )
    .all()
    .map((c) => ({
      id: c.id,
      name: c.name,
      grade: c.grade,
      section: c.section,
      label: classLabel(c.grade, c.section),
      studentCount: c.student_count,
    }));
}

export function getClass(id) {
  const row = db.prepare('SELECT id, name, grade, section FROM classes WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'Class not found.');
  return { id: row.id, name: row.name, grade: row.grade, section: row.section, label: classLabel(row.grade, row.section) };
}

export function ensureClass(grade, section) {
  if (!GRADES.includes(grade)) throw new HttpError(400, 'Choose a class from Nursery to Class 12.');
  const clean = String(section ?? '').trim().toUpperCase();
  if (!/^[A-Z]$/.test(clean)) throw new HttpError(400, 'Section must be a single letter, like A or B.');
  const name = sectionName(grade, clean);
  const existing = db.prepare('SELECT id FROM classes WHERE name = ?').get(name);
  if (existing) return existing.id;
  return Number(
    db
      .prepare('INSERT INTO classes (name, grade, section, sort_order) VALUES (?, ?, ?, ?)')
      .run(name, grade, clean, sortOrder(grade, clean)).lastInsertRowid,
  );
}

// ---- Adding and editing (admin only) ----------------------------------------------

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) && !Number.isNaN(Date.parse(v));

function text(value, label, { required = false, max = 80, min = 2 } = {}) {
  const clean = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (required && clean.length < min) throw new HttpError(400, `Enter the ${label}.`);
  if (clean.length > max) throw new HttpError(400, `The ${label} is too long.`);
  return clean;
}

const truthy = (v) => v === true || v === 'true' || v === 'Yes' || v === 'yes' || v === 'on' || v === 1 || v === '1';

function cleanStudentInput(input) {
  const admissionNo = String(input.admissionNo ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9/\-]{3,30}$/.test(admissionNo)) throw new HttpError(400, 'Enter the admission number, like KBS/2026/0123.');
  const name = text(input.name, 'student’s full name', { required: true });
  const classId = input.classId ? Number(input.classId) : ensureClass(input.grade, input.section);
  getClass(classId);

  const dob = String(input.dob ?? '');
  if (!isDate(dob)) throw new HttpError(400, 'Enter the date of birth.');
  const age = (Date.parse(todayIso()) - Date.parse(dob)) / (365.25 * 86_400_000);
  if (age < 2 || age > 25) throw new HttpError(400, 'Check the date of birth: the student should be between 2 and 25 years old.');

  const gender = String(input.gender ?? '');
  if (!GENDERS.includes(gender)) throw new HttpError(400, 'Choose the gender.');

  const fatherName = text(input.fatherName, 'father’s name');
  const motherName = text(input.motherName, 'mother’s name');
  if (!fatherName && !motherName) throw new HttpError(400, 'Enter the father’s or mother’s name.');

  const admissionDate = String(input.admissionDate ?? '');
  if (!isDate(admissionDate)) throw new HttpError(400, 'Enter the admission date.');
  const session = String(input.session ?? '');
  if (!/^\d{4}-\d{2}$/.test(session)) throw new HttpError(400, 'Choose the session, like 2026-27.');

  const transport = truthy(input.transport);
  const busRoute = text(input.busRoute, 'bus route', { max: 60 });
  if (transport && !busRoute) throw new HttpError(400, 'Enter the bus route for a student who uses school transport.');

  let rollNo = input.rollNo === '' || input.rollNo === undefined || input.rollNo === null ? null : Number(input.rollNo);
  if (rollNo !== null && (!Number.isInteger(rollNo) || rollNo < 1 || rollNo > 999)) throw new HttpError(400, 'Roll number must be a whole number.');
  if (rollNo === null) {
    rollNo = (db.prepare('SELECT MAX(roll_no) AS r FROM students WHERE class_id = ? AND active = 1').get(classId).r ?? 0) + 1;
  }

  return {
    name,
    classId,
    rollNo,
    admissionNo,
    dob,
    gender,
    fatherName,
    motherName,
    parentName: fatherName || motherName,
    parentPhone: normalizePhone(input.parentPhone),
    altPhone: input.altPhone ? normalizePhone(input.altPhone) : null,
    whatsappPhone: input.whatsappPhone ? normalizePhone(input.whatsappPhone) : null,
    address: text(input.address, 'address', { required: true, max: 200, min: 5 }),
    session,
    admissionDate,
    transport,
    busRoute: transport ? busRoute : '',
    remarks: text(input.remarks, 'remarks', { max: 500 }),
    active: input.status === undefined ? true : input.status !== 'Inactive',
  };
}

function assertUnique(data, exceptId = null) {
  const adm = db.prepare('SELECT id, name FROM students WHERE admission_no = ?').get(data.admissionNo);
  if (adm && adm.id !== exceptId) throw new HttpError(409, `Admission number ${data.admissionNo} already belongs to ${adm.name}.`);

  // The same child entered twice: same name and date of birth, and the same father or phone.
  const twin = db
    .prepare(
      `SELECT s.id, s.name, s.admission_no, c.name AS class_name FROM students s JOIN classes c ON c.id = s.class_id
       WHERE lower(s.name) = lower(?) AND s.dob = ? AND (lower(s.father_name) = lower(?) OR s.parent_phone = ?) AND s.id != ?`,
    )
    .get(data.name, data.dob, data.fatherName, data.parentPhone, exceptId ?? -1);
  if (twin) throw new HttpError(409, `This student is already registered: ${twin.name}, ${twin.admission_no} (${twin.class_name}).`);

  const roll = db.prepare('SELECT id, name FROM students WHERE class_id = ? AND roll_no = ? AND active = 1').get(data.classId, data.rollNo);
  if (roll && roll.id !== exceptId) throw new HttpError(409, `Roll no. ${data.rollNo} in that class already belongs to ${roll.name}.`);
}

const COLUMNS = [
  ['name', 'name'], ['class_id', 'classId'], ['roll_no', 'rollNo'], ['admission_no', 'admissionNo'], ['dob', 'dob'],
  ['gender', 'gender'], ['parent_name', 'parentName'], ['father_name', 'fatherName'], ['mother_name', 'motherName'],
  ['parent_phone', 'parentPhone'], ['alt_phone', 'altPhone'], ['whatsapp_phone', 'whatsappPhone'], ['address', 'address'],
  ['session', 'session'], ['admission_date', 'admissionDate'], ['transport', 'transport'], ['bus_route', 'busRoute'], ['remarks', 'remarks'],
];
const values = (data) => COLUMNS.map(([, key]) => (typeof data[key] === 'boolean' ? (data[key] ? 1 : 0) : data[key]));

// Saves a new student and creates their fee account in one transaction.
// `syncAccount` is injected to avoid a circular import with fee-structure.js.
export function createStudent(input, { syncAccount }) {
  const data = cleanStudentInput(input);
  assertUnique(data);
  return transaction(() => {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO students (${COLUMNS.map(([c]) => c).join(', ')}, active, deactivated_at, created_at)
         VALUES (${COLUMNS.map(() => '?').join(', ')}, ?, ?, ?)`,
      )
      .run(...values(data), data.active ? 1 : 0, data.active ? null : nowIso(), nowIso());
    const id = Number(lastInsertRowid);
    const account = syncAccount(id);
    return { student: getStudent(id), feeAccount: account };
  });
}

// Returns { before, after, account }. Receipts already issued keep the details printed on them.
export function updateStudent(id, input, { syncAccount }) {
  const before = getStudent(id);
  if (!before) throw new HttpError(404, 'Student not found.');
  const moving = input.grade !== undefined || input.section !== undefined;
  const merged = {
    ...before,
    altPhone: before.altPhone ?? '',
    whatsappPhone: before.whatsappPhone === before.parentPhone ? '' : before.whatsappPhone,
    ...input,
    classId: moving ? null : input.classId ?? before.classId,
    status: before.status,
  };
  const data = cleanStudentInput(merged);
  assertUnique(data, id);
  return transaction(() => {
    db.prepare(`UPDATE students SET ${COLUMNS.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...values(data), id);
    const account = syncAccount(id);
    return { before, after: getStudent(id), account };
  });
}

// Deactivating keeps every payment and receipt; unpaid fees not yet due are removed.
export function setStudentActive(id, active, { syncAccount }) {
  const student = getStudent(id);
  if (!student) throw new HttpError(404, 'Student not found.');
  if (student.active === active) return { student, account: { added: 0, updated: 0, removed: 0 } };
  return transaction(() => {
    db.prepare('UPDATE students SET active = ?, deactivated_at = ? WHERE id = ?').run(active ? 1 : 0, active ? null : nowIso(), id);
    let account = { added: 0, updated: 0, removed: 0 };
    if (active) {
      account = syncAccount(id);
    } else {
      const { changes } = db
        .prepare('DELETE FROM fee_items WHERE student_id = ? AND payment_id IS NULL AND due_date >= ? AND late_fee_for IS NULL AND NOT EXISTS (SELECT 1 FROM fee_items l WHERE l.late_fee_for = fee_items.id)')
        .run(id, todayIso());
      account.removed = changes;
    }
    return { student: getStudent(id), account };
  });
}
