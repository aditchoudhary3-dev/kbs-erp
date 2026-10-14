import crypto from 'node:crypto';
import { db, nowIso } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../http.js';
import { accessCodeHash, endParentSessions, normalizePhone } from '../auth.js';
import { clickToChatLink, whatsappNumber } from '../integrations/whatsapp/index.js';
import { classLabel } from '../../shared/school.js';
import { formatDate } from '../../shared/format.js';

// Parent app access. A family is the mobile number on their children's
// records. The office gives a one-time access code; the parent uses it once
// to choose a PIN. The office can switch a family's access off and on.

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L

function newCode() {
  const chars = Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

function accountStatus(account) {
  if (account?.status === 'disabled') return 'disabled';
  if (account?.setup_code_hash && Date.parse(account.setup_expires_at) > Date.now()) return 'code_issued';
  if (account?.pin_hash) return 'active';
  return 'not_set_up';
}

export const ACCESS_LABELS = {
  not_set_up: 'Not set up',
  code_issued: 'Code given, not used yet',
  active: 'Using the app',
  disabled: 'Switched off',
};

// Families (one per parent mobile number) with their children and access.
export function listFamilies({ q = '', status = '', limit = 200 } = {}) {
  const text = String(q).trim().toLowerCase();
  const rows = db
    .prepare(
      `SELECT s.parent_phone AS phone, s.name, s.father_name, s.mother_name, s.parent_name, c.grade, c.section
       FROM students s JOIN classes c ON c.id = s.class_id WHERE s.active = 1 ORDER BY c.sort_order, s.name`,
    )
    .all();
  const families = new Map();
  for (const r of rows) {
    const family = families.get(r.phone) ?? { phone: r.phone, parentNames: [r.father_name, r.mother_name].filter(Boolean).join(' / ') || r.parent_name, children: [] };
    family.children.push({ name: r.name, classLabel: classLabel(r.grade, r.section) });
    families.set(r.phone, family);
  }
  const accounts = new Map(db.prepare('SELECT * FROM parent_accounts').all().map((a) => [a.phone, a]));
  return [...families.values()]
    .map((f) => {
      const account = accounts.get(f.phone);
      const state = accountStatus(account);
      return { ...f, status: state, statusLabel: ACCESS_LABELS[state], lastLoginAt: account?.last_login_at ?? null, codeExpiresAt: state === 'code_issued' ? account.setup_expires_at : null };
    })
    .filter((f) => !status || f.status === status)
    .filter((f) => !text || f.phone.includes(text.replace(/\D/g, '') || '~') || f.parentNames.toLowerCase().includes(text) || f.children.some((c) => c.name.toLowerCase().includes(text)))
    .slice(0, limit);
}

function family(phone) {
  const children = db
    .prepare('SELECT s.name, c.grade, c.section FROM students s JOIN classes c ON c.id = s.class_id WHERE s.parent_phone = ? AND s.active = 1 ORDER BY s.name')
    .all(phone);
  if (!children.length) throw new HttpError(404, 'No current student has this mobile number.');
  return children.map((c) => ({ name: c.name, classLabel: classLabel(c.grade, c.section) }));
}

function ensureAccount(phone) {
  const now = nowIso();
  db.prepare('INSERT OR IGNORE INTO parent_accounts (phone, created_at, updated_at) VALUES (?, ?, ?)').run(phone, now, now);
  return db.prepare('SELECT * FROM parent_accounts WHERE phone = ?').get(phone);
}

// A one-time access code for a family (also resets a forgotten PIN).
export function issueAccessCode(rawPhone) {
  const phone = normalizePhone(rawPhone);
  const children = family(phone);
  const account = ensureAccount(phone);
  if (account.status === 'disabled') throw new HttpError(409, 'App access for this family is switched off. Switch it on first.');
  const code = newCode();
  const expires = new Date(Date.now() + config.parentLogin.accessCodeDays * 86_400_000).toISOString();
  db.prepare('UPDATE parent_accounts SET setup_code_hash = ?, setup_expires_at = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE phone = ?').run(
    accessCodeHash(phone, code),
    expires,
    nowIso(),
    phone,
  );
  const appUrl = config.publicBaseUrl || 'the KBS School app';
  const message = [
    'Dear Parent,',
    '',
    `Your ${config.school.shortName} app access code is: ${code}`,
    '',
    `Open ${appUrl}, choose "First time? Use access code", enter your mobile number ${phone} and this code, then choose a 6-digit PIN.`,
    `The code works once and expires on ${formatDate(expires)}.`,
    '',
    config.school.name,
  ].join('\n');
  return { phone, children, code, expiresAt: expires, message, whatsappLink: clickToChatLink(whatsappNumber(phone), message) };
}

export function setFamilyAccess(rawPhone, active) {
  const phone = normalizePhone(rawPhone);
  const children = family(phone);
  ensureAccount(phone);
  db.prepare('UPDATE parent_accounts SET status = ?, updated_at = ? WHERE phone = ?').run(active ? 'active' : 'disabled', nowIso(), phone);
  if (!active) endParentSessions(phone);
  return { phone, children, status: accountStatus(db.prepare('SELECT * FROM parent_accounts WHERE phone = ?').get(phone)) };
}
