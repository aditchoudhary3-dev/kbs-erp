import crypto from 'node:crypto';
import { db, nowIso } from './db.js';
import { config } from './config.js';
import { HttpError, setCookie } from './http.js';
import { sendSms } from './sms.js';

const COOKIES = { parent: 'sc_parent', admin: 'sc_admin' };

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const codeHash = (phone, code) => sha256(`${phone}:${code}`);

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Accepts "98765 43210", "+91 98765-43210", "09876543210" and returns 10 digits.
export function normalizePhone(input) {
  let digits = String(input ?? '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (!/^[6-9]\d{9}$/.test(digits)) throw new HttpError(400, 'Enter a valid 10-digit mobile number.');
  return digits;
}

// ---- Parent login with a one-time code --------------------------------------

// A parent may sign in if a current student has this number and the school
// has not switched off the family's app access.
function checkParentAllowed(phone) {
  const known = db.prepare('SELECT 1 FROM students WHERE parent_phone = ? AND active = 1 LIMIT 1').get(phone);
  if (!known) {
    throw new HttpError(404, 'This number is not registered with the school. Please contact the school office.');
  }
  const account = db.prepare('SELECT status FROM parent_accounts WHERE phone = ?').get(phone);
  if (account?.status === 'disabled') {
    throw new HttpError(403, 'App access for this number has been switched off. Please contact the school office.');
  }
}

export function requestOtp(rawPhone) {
  if (!config.parentLogin.otp) throw new HttpError(400, 'Log in with your PIN, or use the access code from the school office.');
  const phone = normalizePhone(rawPhone);
  checkParentAllowed(phone);

  // Cooldown between codes, unless the last one was used to log in successfully.
  const last = db.prepare('SELECT created_at, verified FROM otp_codes WHERE phone = ? ORDER BY id DESC LIMIT 1').get(phone);
  if (last && !last.verified) {
    const wait = config.otp.resendSeconds - (Date.now() - Date.parse(last.created_at)) / 1000;
    if (wait > 0) throw new HttpError(429, `Please wait ${Math.ceil(wait)} seconds before asking for a new code.`);
  }

  const code = String(crypto.randomInt(0, 10 ** config.otp.length)).padStart(config.otp.length, '0');
  const expires = new Date(Date.now() + config.otp.ttlSeconds * 1000).toISOString();
  db.prepare('UPDATE otp_codes SET consumed = 1 WHERE phone = ? AND consumed = 0').run(phone);
  db.prepare('INSERT INTO otp_codes (phone, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    phone,
    codeHash(phone, code),
    nowIso(),
    expires,
  );
  sendSms(phone, 'otp', `${code} is your ${config.school.shortName} login code. It expires in 5 minutes. Do not share it with anyone.`);

  return {
    phone,
    resendIn: config.otp.resendSeconds,
    ...(config.demoMode ? { demoCode: code } : {}),
  };
}

export function verifyOtp(res, rawPhone, rawCode) {
  const phone = normalizePhone(rawPhone);
  const code = String(rawCode ?? '').replace(/\D/g, '');
  const row = db
    .prepare('SELECT * FROM otp_codes WHERE phone = ? AND consumed = 0 ORDER BY id DESC LIMIT 1')
    .get(phone);

  if (!row || Date.parse(row.expires_at) < Date.now()) {
    throw new HttpError(400, 'This code has expired. Tap “Resend code” to get a new one.');
  }
  if (row.attempts >= config.otp.maxAttempts) {
    throw new HttpError(429, 'Too many wrong attempts. Please ask for a new code.');
  }
  db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);

  if (!safeEqual(row.code_hash, codeHash(phone, code))) {
    const left = config.otp.maxAttempts - row.attempts - 1;
    throw new HttpError(
      400,
      left > 0
        ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`
        : 'Too many wrong attempts. Please ask for a new code.',
    );
  }

  db.prepare('UPDATE otp_codes SET consumed = 1, verified = 1 WHERE id = ?').run(row.id);
  checkParentAllowed(phone);
  startSession(res, 'parent', phone);
  noteParentLogin(phone);
  return phone;
}

// ---- Parent login with an access code and PIN (no SMS needed) -----------------
//
// The school office gives a family a one-time access code. The parent enters
// it once with their mobile number and chooses a 6-digit PIN; after that they
// log in with number + PIN. A new code from the office resets a forgotten PIN.

const PIN_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
export const accessCodeHash = (phone, code) => sha256(`access:${phone}:${String(code).toUpperCase().replace(/[^A-Z0-9]/g, '')}`);

function parentAccount(phone) {
  return db.prepare('SELECT * FROM parent_accounts WHERE phone = ?').get(phone);
}

function checkLock(account) {
  if (account?.locked_until && Date.parse(account.locked_until) > Date.now()) {
    const minutes = Math.ceil((Date.parse(account.locked_until) - Date.now()) / 60_000);
    throw new HttpError(429, `Too many wrong attempts. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
  }
}

function failAttempt(account, message) {
  const failed = account.failed_attempts + 1;
  if (failed >= PIN_ATTEMPTS) {
    db.prepare('UPDATE parent_accounts SET failed_attempts = 0, locked_until = ?, updated_at = ? WHERE phone = ?').run(
      new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString(),
      nowIso(),
      account.phone,
    );
    throw new HttpError(429, `Too many wrong attempts. Please try again in ${LOCK_MINUTES} minutes.`);
  }
  db.prepare('UPDATE parent_accounts SET failed_attempts = ?, updated_at = ? WHERE phone = ?').run(failed, nowIso(), account.phone);
  const left = PIN_ATTEMPTS - failed;
  throw new HttpError(400, `${message} ${left} ${left === 1 ? 'try' : 'tries'} left.`);
}

function cleanPin(raw) {
  const pin = String(raw ?? '').replace(/\D/g, '');
  if (pin.length !== 6) throw new HttpError(400, 'Your PIN must be 6 digits.');
  if (/^(\d)\1{5}$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) {
    throw new HttpError(400, 'Choose a PIN that is harder to guess (not 111111 or 123456).');
  }
  return pin;
}

function noteParentLogin(phone) {
  db.prepare('UPDATE parent_accounts SET last_login_at = ?, failed_attempts = 0, locked_until = NULL WHERE phone = ?').run(nowIso(), phone);
}

// First sign-in (or a forgotten PIN): access code from the school + a new PIN.
export function setupParentPin(res, rawPhone, rawCode, rawPin) {
  const phone = normalizePhone(rawPhone);
  checkParentAllowed(phone);
  const account = parentAccount(phone);
  checkLock(account);
  if (!account?.setup_code_hash || !account.setup_expires_at) {
    throw new HttpError(400, 'There is no access code for this number. Please ask the school office for one.');
  }
  if (Date.parse(account.setup_expires_at) < Date.now()) {
    throw new HttpError(400, 'This access code has expired. Please ask the school office for a new one.');
  }
  if (!safeEqual(account.setup_code_hash, accessCodeHash(phone, rawCode))) failAttempt(account, 'That access code is not right.');
  const pin = cleanPin(rawPin);
  db.prepare(
    'UPDATE parent_accounts SET pin_hash = ?, setup_code_hash = NULL, setup_expires_at = NULL, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE phone = ?',
  ).run(hashPassword(pin), nowIso(), phone);
  startSession(res, 'parent', phone);
  noteParentLogin(phone);
  return phone;
}

export function parentPinLogin(res, rawPhone, rawPin) {
  const phone = normalizePhone(rawPhone);
  checkParentAllowed(phone);
  const account = parentAccount(phone);
  checkLock(account);
  if (!account?.pin_hash) {
    throw new HttpError(400, 'You have not set a PIN yet. Use the access code from the school office the first time.');
  }
  if (!verifyPassword(String(rawPin ?? '').replace(/\D/g, ''), account.pin_hash)) failAttempt(account, 'That PIN is not right.');
  startSession(res, 'parent', phone);
  noteParentLogin(phone);
  return phone;
}

// Signs a family out everywhere (when their access is switched off).
export function endParentSessions(phone) {
  db.prepare("DELETE FROM sessions WHERE role = 'parent' AND subject = ?").run(phone);
}

// ---- School office login -----------------------------------------------------

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [, saltHex, hashHex] = stored.split(':');
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

export function checkPasswordStrength(password) {
  if (String(password ?? '').length < 8) throw new HttpError(400, 'Passwords must be at least 8 characters.');
}

const failedLogins = new Map(); // email -> { count, until }

// Roles that sign in to the staff app (see permissions.js).
const LOGIN_ROLES = new Set(['admin', 'clerk', 'teacher']);

// ---- School staff (admins and clerks) ----------------------------------------

export function staffLogin(res, rawEmail, password) {
  const email = String(rawEmail ?? '').trim().toLowerCase();
  const lock = failedLogins.get(email);
  if (lock && lock.until > Date.now()) {
    throw new HttpError(429, 'Too many attempts. Please wait a minute and try again.');
  }

  const staff = db.prepare('SELECT * FROM staff WHERE email = ?').get(email);
  if (!staff || !staff.password_hash || !verifyPassword(String(password ?? ''), staff.password_hash)) {
    const count = (lock?.count ?? 0) + 1;
    failedLogins.set(email, { count, until: count >= 5 ? Date.now() + 60_000 : 0 });
    throw new HttpError(401, 'That email and password do not match.');
  }
  if (!staff.active) throw new HttpError(403, 'This account has been switched off. Please ask the school admin.');
  if (!LOGIN_ROLES.has(staff.role)) throw new HttpError(403, 'This staff record does not have app access. Please ask the school admin.');

  failedLogins.delete(email);
  db.prepare('UPDATE staff SET last_login_at = ? WHERE id = ?').run(nowIso(), staff.id);
  startSession(res, 'admin', String(staff.id), config.staffSessionHours * 3600);
  return toStaff(staff);
}

const toStaff = (row) => ({ id: row.id, email: row.email, name: row.name, role: row.role });

// ---- Sessions ---------------------------------------------------------------

function startSession(res, role, subject, maxAge = config.sessionDays * 86400) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, role, subject, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    sha256(token),
    role,
    subject,
    nowIso(),
    new Date(Date.now() + maxAge * 1000).toISOString(),
  );
  setCookie(res, COOKIES[role], token, { maxAge });
}

function sessionSubject(ctx, role) {
  const token = ctx.cookies[COOKIES[role]];
  if (!token) return null;
  const row = db
    .prepare('SELECT subject, expires_at FROM sessions WHERE token_hash = ? AND role = ?')
    .get(sha256(token), role);
  if (!row || Date.parse(row.expires_at) < Date.now()) return null;
  return row.subject;
}

export function endSession(ctx, role) {
  const token = ctx.cookies[COOKIES[role]];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  setCookie(ctx.res, COOKIES[role], '', { maxAge: 0 });
}

// Signs a staff member out everywhere (after a password change or deactivation).
export function endStaffSessions(staffId) {
  db.prepare("DELETE FROM sessions WHERE role = 'admin' AND subject = ?").run(String(staffId));
}

export function parentPhone(ctx) {
  return sessionSubject(ctx, 'parent');
}

export function requireParent(ctx) {
  const phone = parentPhone(ctx);
  if (!phone) throw new HttpError(401, 'Please log in again.');
  if (db.prepare("SELECT 1 FROM parent_accounts WHERE phone = ? AND status = 'disabled'").get(phone)) {
    throw new HttpError(401, 'App access for this number has been switched off. Please contact the school office.');
  }
  return phone;
}

export function currentStaff(ctx) {
  const id = sessionSubject(ctx, 'admin');
  if (!id) return null;
  const row = db.prepare('SELECT * FROM staff WHERE id = ? AND active = 1').get(Number(id));
  return row && LOGIN_ROLES.has(row.role) ? toStaff(row) : null;
}

export function requireStaff(ctx) {
  const staff = currentStaff(ctx);
  if (!staff) throw new HttpError(401, 'Please log in again.');
  return staff;
}
