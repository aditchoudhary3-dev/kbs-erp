import { db, nowIso, transaction } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../http.js';
import { GRADES } from '../../shared/school.js';
import { MONTHS, todayIso } from '../../shared/format.js';

// Fee structure: fee types, the fees each class pays in a session, and the
// instalments generated from each fee's frequency. Each instalment becomes a
// fee item for each student ("the student's fee account").
//
// Paid fee items are never changed. Editing a fee updates only unpaid
// instalments, so old payments and receipts stay exactly as they were.

export const FREQUENCIES = ['Monthly', 'Quarterly', 'Half-Yearly', 'Yearly', 'One-Time', 'Custom'];
const STEP_MONTHS = { Monthly: 1, Quarterly: 3, 'Half-Yearly': 6 };

export const currentSession = () => config.academicYear.session;
export function sessionsOffered() {
  const year = Number(currentSession().slice(0, 4));
  return [year - 1, year, year + 1].map((y) => `${y}-${String((y + 1) % 100).padStart(2, '0')}`);
}
export function sessionRange(session) {
  const year = Number(String(session).slice(0, 4));
  return { start: `${year}-04-01`, end: `${year + 1}-03-31` };
}
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) && !Number.isNaN(Date.parse(v));

function addMonthsToDate(date, months) {
  const [y, m, d] = date.split('-').map(Number);
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

// Academic quarters and halves start in April.
function periodLabel(frequency, dueDate) {
  const month = Number(dueDate.slice(5, 7));
  const year = dueDate.slice(0, 4);
  if (frequency === 'Monthly') return `${MONTHS[month - 1]} ${year}`;
  const offset = (month + 8) % 12; // April = 0
  if (frequency === 'Quarterly') {
    const first = (Math.floor(offset / 3) * 3 + 3) % 12;
    return `${MONTHS[first]}–${MONTHS[(first + 2) % 12]}`;
  }
  return offset < 6 ? 'Apr–Sep' : 'Oct–Mar';
}

// [{ period, dueDate }] for a structure.
export function instalments(structure) {
  const frequency = structure.frequency;
  if (frequency === 'Custom') return structure.schedule.map((s) => ({ period: s.label, dueDate: s.dueDate }));
  if (frequency === 'Yearly' || frequency === 'One-Time') return [{ period: structure.session, dueDate: structure.firstDueDate }];
  const { end } = sessionRange(structure.session);
  const out = [];
  for (let date = structure.firstDueDate; date <= end && out.length < 24; date = addMonthsToDate(date, STEP_MONTHS[frequency])) {
    out.push({ period: periodLabel(frequency, date), dueDate: date });
  }
  return out;
}

// ---- Fee types -------------------------------------------------------------------------

export function listFeeTypes() {
  return db
    .prepare(
      `SELECT t.id, t.name, COUNT(s.id) AS structures FROM fee_types t
       LEFT JOIN fee_structures s ON s.fee_type_id = t.id AND s.active = 1
       GROUP BY t.id ORDER BY t.name`,
    )
    .all()
    .map((t) => ({ id: t.id, name: t.name, structures: t.structures }));
}

export function createFeeType(rawName) {
  const name = String(rawName ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 40) throw new HttpError(400, 'Give the fee type a name, like “Computer Fee”.');
  if (db.prepare('SELECT 1 FROM fee_types WHERE name = ?').get(name)) throw new HttpError(409, `“${name}” already exists.`);
  const { lastInsertRowid } = db.prepare('INSERT INTO fee_types (name, created_at) VALUES (?, ?)').run(name, nowIso());
  return { id: Number(lastInsertRowid), name };
}

// ---- Structures ------------------------------------------------------------------------

function toStructure(row) {
  return {
    id: row.id,
    feeTypeId: row.fee_type_id,
    feeType: row.fee_type,
    name: row.name,
    grade: row.grade,
    session: row.session,
    amount: row.amount,
    frequency: row.frequency,
    firstDueDate: row.first_due_date,
    schedule: row.schedule ? JSON.parse(row.schedule) : [],
    lateFee: row.late_fee,
    compulsory: Boolean(row.compulsory),
    transportOnly: Boolean(row.transport_only),
    newAdmissionsOnly: Boolean(row.new_admissions_only),
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT = 'SELECT s.*, t.name AS fee_type FROM fee_structures s JOIN fee_types t ON t.id = s.fee_type_id';

export function getStructure(id) {
  const row = db.prepare(`${SELECT} WHERE s.id = ?`).get(id);
  if (!row) throw new HttpError(404, 'Fee not found.');
  const structure = toStructure(row);
  structure.instalments = instalments(structure);
  return structure;
}

export function listStructures({ session = currentSession(), grade = '', feeTypeId = '', includeInactive = false } = {}) {
  const where = ['s.session = ?'];
  const args = [session];
  if (grade) {
    where.push('(s.grade = ? OR s.grade IS NULL)');
    args.push(grade);
  }
  if (feeTypeId) {
    where.push('s.fee_type_id = ?');
    args.push(Number(feeTypeId));
  }
  if (!includeInactive) where.push('s.active = 1');
  const stats = new Map(
    db
      .prepare(
        `SELECT structure_id, COUNT(DISTINCT student_id) AS students, SUM(amount) AS billed,
                SUM(CASE WHEN payment_id IS NOT NULL THEN amount ELSE 0 END) AS collected
         FROM fee_items WHERE structure_id IS NOT NULL GROUP BY structure_id`,
      )
      .all()
      .map((r) => [r.structure_id, r]),
  );
  return db
    .prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY CASE WHEN s.grade IS NULL THEN 0 ELSE 1 END, s.grade, t.name, s.name`)
    .all(...args)
    .map((row) => {
      const s = toStructure(row);
      const st = stats.get(s.id) ?? { students: 0, billed: 0, collected: 0 };
      return { ...s, instalmentCount: instalments(s).length, students: st.students, billed: st.billed, collected: st.collected, pending: st.billed - st.collected };
    });
}

function cleanStructure(input, existing = null) {
  const merged = { ...(existing ?? {}), ...input };
  const feeType = db.prepare('SELECT id, name FROM fee_types WHERE id = ?').get(Number(merged.feeTypeId));
  if (!feeType) throw new HttpError(400, 'Choose a fee type (or add a new one).');
  const name = String(merged.name ?? feeType.name).trim() || feeType.name;
  if (name.length > 60) throw new HttpError(400, 'The fee name is too long.');
  const grade = merged.grade ? String(merged.grade) : null;
  if (grade && !GRADES.includes(grade)) throw new HttpError(400, 'Choose a class from Nursery to Class 12, or “All classes”.');
  const session = String(merged.session ?? currentSession());
  if (!/^\d{4}-\d{2}$/.test(session)) throw new HttpError(400, 'Choose a session, like 2026-27.');
  const amount = Number(merged.amount);
  if (!Number.isInteger(amount) || amount < 1 || amount > 1_000_000) throw new HttpError(400, 'Amount must be a whole number of rupees.');
  const lateFee = Number(merged.lateFee || 0);
  if (!Number.isInteger(lateFee) || lateFee < 0 || lateFee > 100_000) throw new HttpError(400, 'Late fee must be a whole number of rupees (0 for none).');
  if (!FREQUENCIES.includes(merged.frequency)) throw new HttpError(400, 'Choose how often this fee is charged.');

  const { start, end } = sessionRange(session);
  let schedule = null;
  let firstDueDate = merged.firstDueDate;
  if (merged.frequency === 'Custom') {
    const list = Array.isArray(merged.schedule) ? merged.schedule : [];
    schedule = list
      .map((s) => ({ label: String(s.label ?? '').trim(), dueDate: String(s.dueDate ?? '') }))
      .filter((s) => s.label || s.dueDate);
    if (!schedule.length || schedule.length > 24) throw new HttpError(400, 'Add at least one instalment (name and due date).');
    for (const s of schedule) {
      if (!s.label || s.label.length > 30) throw new HttpError(400, 'Each instalment needs a short name, like “Term 1”.');
      if (!isDate(s.dueDate) || s.dueDate < start || s.dueDate > end) throw new HttpError(400, `The due date for “${s.label}” must be within the ${session} session.`);
    }
    if (new Set(schedule.map((s) => s.label.toLowerCase())).size !== schedule.length) throw new HttpError(400, 'Instalment names must be different.');
    schedule.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    firstDueDate = schedule[0].dueDate;
  } else if (!isDate(firstDueDate) || firstDueDate < start || firstDueDate > end) {
    throw new HttpError(400, `Choose a due date within the ${session} session (${start} to ${end}).`);
  }

  return {
    feeTypeId: feeType.id,
    name,
    grade,
    session,
    amount,
    frequency: merged.frequency,
    firstDueDate,
    schedule,
    lateFee,
    compulsory: merged.compulsory === undefined ? true : merged.compulsory === true || merged.compulsory === 'true' || merged.compulsory === 'on',
    transportOnly: merged.transportOnly === true || merged.transportOnly === 'true' || merged.transportOnly === 'on',
    newAdmissionsOnly: merged.newAdmissionsOnly === true || merged.newAdmissionsOnly === 'true' || merged.newAdmissionsOnly === 'on',
    active: merged.active === undefined ? true : Boolean(merged.active) && merged.active !== 'false',
  };
}

export function createStructure(input, { applyToExisting = true } = {}) {
  const data = cleanStructure(input);
  return transaction(() => {
    const now = nowIso();
    const id = Number(
      db
        .prepare(
          `INSERT INTO fee_structures (fee_type_id, name, grade, session, amount, frequency, first_due_date, schedule, late_fee,
             compulsory, transport_only, new_admissions_only, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(data.feeTypeId, data.name, data.grade, data.session, data.amount, data.frequency, data.firstDueDate,
          data.schedule ? JSON.stringify(data.schedule) : null, data.lateFee, data.compulsory ? 1 : 0, data.transportOnly ? 1 : 0,
          data.newAdmissionsOnly ? 1 : 0, now, now).lastInsertRowid,
    );
    const result = applyToExisting ? syncStructure(id) : { added: 0, updated: 0, removed: 0 };
    return { structure: getStructure(id), ...result };
  });
}

// Changes a fee. Only unpaid instalments follow the change; with
// `includeOverdue` off, unpaid instalments already past their due date keep
// their old amount too.
export function updateStructure(id, input, { includeOverdue = false } = {}) {
  const existing = getStructure(id);
  const data = cleanStructure(input, existing);
  if (data.session !== existing.session || (data.grade ?? null) !== (existing.grade ?? null)) {
    throw new HttpError(400, 'To charge a different class or session, add a new fee instead.');
  }
  return transaction(() => {
    db.prepare(
      `UPDATE fee_structures SET fee_type_id = ?, name = ?, amount = ?, frequency = ?, first_due_date = ?, schedule = ?, late_fee = ?,
         compulsory = ?, transport_only = ?, new_admissions_only = ?, active = ?, updated_at = ? WHERE id = ?`,
    ).run(data.feeTypeId, data.name, data.amount, data.frequency, data.firstDueDate, data.schedule ? JSON.stringify(data.schedule) : null,
      data.lateFee, data.compulsory ? 1 : 0, data.transportOnly ? 1 : 0, data.newAdmissionsOnly ? 1 : 0, data.active ? 1 : 0, nowIso(), id);
    const result = syncStructure(id, { includeOverdue });
    return { before: existing, structure: getStructure(id), ...result };
  });
}

// ---- Fee accounts -------------------------------------------------------------------------

const STUDENT_FIELDS = `SELECT s.id, s.session, s.transport, s.admission_date, s.active, s.created_at, c.grade
                        FROM students s JOIN classes c ON c.id = s.class_id`;

function eligible(structure, student) {
  if (!structure.active || !structure.compulsory || !student.active) return false;
  if (student.session !== structure.session) return false;
  if (structure.grade && structure.grade !== student.grade) return false;
  if (structure.transportOnly && !student.transport) return false;
  // "New admissions only": students added after this fee was set up.
  if (structure.newAdmissionsOnly && student.created_at < structure.createdAt) return false;
  return true;
}

// A student who joins mid-year is charged instalments due from their admission
// month onwards (yearly and one-time fees are always charged).
function chargeable(structure, instalment, student) {
  if (structure.frequency === 'Yearly' || structure.frequency === 'One-Time') return true;
  const admitted = student.admission_date ?? '';
  return !admitted || instalment.dueDate.slice(0, 7) >= admitted.slice(0, 7);
}

const titleFor = (structure, period) => (period === structure.session ? structure.name : `${structure.name} · ${period}`);

// Brings one student's items for one structure in line with the structure.
function syncItems(structure, student, { includeOverdue = false, today = todayIso() } = {}) {
  const planned = instalments(structure);
  const periods = new Set(planned.map((p) => p.period));
  const existing = db
    .prepare('SELECT id, period, amount, due_date, payment_id FROM fee_items WHERE student_id = ? AND structure_id = ?')
    .all(student.id, structure.id);
  const byPeriod = new Map(existing.map((i) => [i.period, i]));
  const result = { added: 0, updated: 0, removed: 0 };
  const isEligible = eligible(structure, student);
  const assignedOptional = !structure.compulsory && existing.length > 0;

  for (const item of existing) {
    if (item.payment_id !== null) continue; // paid: never touched
    const future = item.due_date >= today;
    const stillCharged = periods.has(item.period) && structure.active && (isEligible || assignedOptional);
    if (!stillCharged) {
      if (future || !structure.active || !periods.has(item.period)) {
        db.prepare('DELETE FROM fee_items WHERE late_fee_for = ? AND payment_id IS NULL').run(item.id);
        db.prepare('DELETE FROM fee_items WHERE id = ? AND payment_id IS NULL').run(item.id);
        result.removed += 1;
      }
      continue;
    }
    if (!future && !includeOverdue) continue;
    const plan = planned.find((p) => p.period === item.period);
    const dueDate = structure.newAdmissionsOnly ? item.due_date : plan.dueDate;
    db.prepare('UPDATE fee_items SET amount = ?, due_date = ?, title = ?, fee_type = ? WHERE id = ? AND payment_id IS NULL').run(
      structure.amount, dueDate, titleFor(structure, item.period), structure.feeType, item.id,
    );
    if (item.amount !== structure.amount || item.due_date !== dueDate) result.updated += 1;
  }

  if (isEligible) {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO fee_items (student_id, title, fee_type, amount, due_date, created_at, structure_id, period)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const plan of planned) {
      if (byPeriod.has(plan.period) || !chargeable(structure, plan, student)) continue;
      // Admission fees fall due on the day of admission.
      const dueDate = structure.newAdmissionsOnly && (student.admission_date ?? '') > plan.dueDate ? student.admission_date : plan.dueDate;
      const { changes } = insert.run(student.id, titleFor(structure, plan.period), structure.feeType, structure.amount, dueDate, nowIso(), structure.id, plan.period);
      result.added += changes;
    }
  }
  return result;
}

const add = (a, b) => ({ added: a.added + b.added, updated: a.updated + b.updated, removed: a.removed + b.removed });

export function syncStructure(id, options = {}) {
  const structure = getStructure(id);
  const students = structure.grade
    ? db.prepare(`${STUDENT_FIELDS} WHERE c.grade = ?`).all(structure.grade)
    : db.prepare(STUDENT_FIELDS).all();
  let total = { added: 0, updated: 0, removed: 0 };
  transaction(() => {
    for (const student of students) total = add(total, syncItems(structure, student, options));
  });
  return total;
}

// Creates or refreshes a student's fee account from every fee that applies to
// them (after admission, a class change, or turning transport on/off).
export function syncStudentAccount(studentId) {
  const student = db.prepare(`${STUDENT_FIELDS} WHERE s.id = ?`).get(studentId);
  if (!student) throw new HttpError(404, 'Student not found.');
  const structures = db
    .prepare(`${SELECT} WHERE s.session = ?`)
    .all(student.session)
    .map(toStructure);
  // Structures the student already has items for (other classes, optional fees) are included too.
  const linked = new Set(db.prepare('SELECT DISTINCT structure_id FROM fee_items WHERE student_id = ? AND structure_id IS NOT NULL').all(studentId).map((r) => r.structure_id));
  let total = { added: 0, updated: 0, removed: 0 };
  transaction(() => {
    for (const structure of structures) {
      if (!eligible(structure, student) && !linked.has(structure.id)) continue;
      total = add(total, syncItems(structure, student));
    }
  });
  return total;
}

// Adds an optional fee (e.g. Computer Fee) to one student's account.
export function assignOptionalFee(studentId, structureId) {
  const structure = getStructure(structureId);
  const student = db.prepare(`${STUDENT_FIELDS} WHERE s.id = ?`).get(studentId);
  if (!student) throw new HttpError(404, 'Student not found.');
  if (!structure.active) throw new HttpError(400, 'This fee is switched off.');
  const insert = db.prepare(
    `INSERT OR IGNORE INTO fee_items (student_id, title, fee_type, amount, due_date, created_at, structure_id, period)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let added = 0;
  transaction(() => {
    for (const plan of instalments(structure)) {
      if (!chargeable(structure, plan, student)) continue;
      added += insert.run(studentId, titleFor(structure, plan.period), structure.feeType, structure.amount, plan.dueDate, nowIso(), structure.id, plan.period).changes;
    }
  });
  return { added };
}

// ---- Late fees -------------------------------------------------------------------------------

// Adds the fee's late fee, once, to every unpaid instalment past its due date.
export function applyLateFees(today = todayIso()) {
  const overdue = db
    .prepare(
      `SELECT f.id, f.student_id, f.title, s.late_fee FROM fee_items f
       JOIN fee_structures s ON s.id = f.structure_id
       WHERE f.payment_id IS NULL AND f.late_fee_for IS NULL AND s.late_fee > 0 AND f.due_date < ?
         AND NOT EXISTS (SELECT 1 FROM fee_items l WHERE l.late_fee_for = f.id)`,
    )
    .all(today);
  if (!overdue.length) return 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO fee_items (student_id, title, fee_type, amount, due_date, created_at, late_fee_for)
     VALUES (?, ?, 'Late Fee', ?, ?, ?, ?)`,
  );
  let added = 0;
  transaction(() => {
    for (const item of overdue) added += insert.run(item.student_id, `Late fee · ${item.title}`, item.late_fee, today, nowIso(), item.id).changes;
  });
  return added;
}

let lateFeeTimer = null;
export function startLateFeeWorker() {
  applyLateFees();
  lateFeeTimer = setInterval(() => {
    try {
      applyLateFees();
    } catch (err) {
      console.error('[fees] late fees:', err.message);
    }
  }, 60 * 60_000);
  lateFeeTimer.unref();
}
export const stopLateFeeWorker = () => clearInterval(lateFeeTimer);
