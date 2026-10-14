import { db, nowIso } from '../db.js';
import { HttpError } from '../http.js';
import { checkPasswordStrength, endStaffSessions, hashPassword, verifyPassword } from '../auth.js';
import { LOGIN_ROLES, ROLES } from '../permissions.js';
import { teacherClasses } from './academics.js';

// Staff records: everyone who works at the school. Admins, clerks and
// teachers have app logins; "staff" records (drivers, attendants…) do not.

const toUser = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  role: row.role,
  roleLabel: ROLES[row.role] ?? row.role,
  active: Boolean(row.active),
  canLogin: LOGIN_ROLES.includes(row.role) && Boolean(row.password_hash),
  phone: row.phone,
  designation: row.designation,
  joinedOn: row.joined_on,
  createdAt: row.created_at,
  lastLoginAt: row.last_login_at,
  classes: row.role === 'teacher' ? teacherClasses(row.id) : [],
});

export function listUsers() {
  return db
    .prepare("SELECT * FROM staff ORDER BY active DESC, CASE role WHEN 'admin' THEN 0 WHEN 'clerk' THEN 1 WHEN 'teacher' THEN 2 ELSE 3 END, name")
    .all()
    .map(toUser);
}

export const getUser = (id) => {
  const row = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
  return row ? toUser(row) : null;
};

function cleanEmail(value, { required }) {
  const email = String(value ?? '').trim().toLowerCase();
  if (!email && !required) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  return email;
}

function cleanRole(value) {
  if (!ROLES[value]) throw new HttpError(400, 'Choose a role: Admin, Clerk, Teacher or Staff.');
  return value;
}

function cleanPhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
  if (!digits) return null;
  if (!/^\d{10}$/.test(digits)) throw new HttpError(400, 'Enter a 10-digit mobile number.');
  return digits;
}

function cleanDate(value) {
  const date = String(value ?? '').trim();
  if (!date) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new HttpError(400, 'Enter the joining date as a date.');
  return date;
}

const cleanText = (value, max) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

const activeAdmins = () => db.prepare("SELECT COUNT(*) AS n FROM staff WHERE role = 'admin' AND active = 1").get().n;

export function createUser({ name, email, role, password, phone, designation, joinedOn }) {
  const cleanName = cleanText(name, 60);
  if (cleanName.length < 2) throw new HttpError(400, 'Enter the person’s name.');
  const theRole = cleanRole(role);
  const login = LOGIN_ROLES.includes(theRole);
  const address = cleanEmail(email, { required: login });
  if (login) checkPasswordStrength(password);
  if (address && db.prepare('SELECT 1 FROM staff WHERE email = ?').get(address)) throw new HttpError(409, 'Someone already uses that email.');
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO staff (email, name, password_hash, role, active, created_at, phone, designation, joined_on)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    )
    .run(address, cleanName, login ? hashPassword(String(password)) : null, theRole, nowIso(), cleanPhone(phone), cleanText(designation, 60), cleanDate(joinedOn));
  return getUser(Number(lastInsertRowid));
}

// Admins change a record: details, role, active status, or a new password.
export function updateUser(id, changes, actingStaff) {
  const user = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
  if (!user) throw new HttpError(404, 'User not found.');
  const role = changes.role === undefined ? user.role : cleanRole(changes.role);
  const active = changes.active === undefined ? Boolean(user.active) : Boolean(changes.active);
  const name = changes.name === undefined ? user.name : cleanText(changes.name, 60);
  if (name.length < 2) throw new HttpError(400, 'Enter the person’s name.');
  const login = LOGIN_ROLES.includes(role);
  const email = changes.email === undefined ? user.email : cleanEmail(changes.email, { required: login });
  if (login && !email) throw new HttpError(400, 'People who log in need an email address.');
  if (email && email !== user.email && db.prepare('SELECT 1 FROM staff WHERE email = ? AND id != ?').get(email, id)) {
    throw new HttpError(409, 'Someone already uses that email.');
  }
  if (login && !user.password_hash && !changes.password) throw new HttpError(400, 'Set a password so this person can log in.');

  if (id === actingStaff.id && (!active || role !== 'admin')) {
    throw new HttpError(400, 'You cannot remove your own admin access.');
  }
  if (user.role === 'admin' && user.active && (role !== 'admin' || !active) && activeAdmins() <= 1) {
    throw new HttpError(400, 'The school needs at least one active admin.');
  }

  db.prepare('UPDATE staff SET name = ?, role = ?, active = ?, email = ?, phone = ?, designation = ?, joined_on = ? WHERE id = ?').run(
    name,
    role,
    active ? 1 : 0,
    email,
    changes.phone === undefined ? user.phone : cleanPhone(changes.phone),
    changes.designation === undefined ? user.designation : cleanText(changes.designation, 60),
    changes.joinedOn === undefined ? user.joined_on : cleanDate(changes.joinedOn),
    id,
  );
  if (changes.password) {
    checkPasswordStrength(changes.password);
    db.prepare('UPDATE staff SET password_hash = ? WHERE id = ?').run(hashPassword(String(changes.password)), id);
  }
  if (role !== 'teacher' && user.role === 'teacher') db.prepare('DELETE FROM teacher_classes WHERE staff_id = ?').run(id);
  if (!active || changes.password || role !== user.role) endStaffSessions(id);
  return getUser(id);
}

export function changeOwnPassword(staff, { currentPassword, newPassword }) {
  const row = db.prepare('SELECT password_hash FROM staff WHERE id = ?').get(staff.id);
  if (!row.password_hash || !verifyPassword(String(currentPassword ?? ''), row.password_hash)) throw new HttpError(400, 'Your current password is not right.');
  checkPasswordStrength(newPassword);
  db.prepare('UPDATE staff SET password_hash = ? WHERE id = ?').run(hashPassword(String(newPassword)), staff.id);
}
