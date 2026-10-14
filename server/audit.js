import { AsyncLocalStorage } from 'node:async_hooks';
import { db, nowIso } from './db.js';

// Who did what, for money-related and access-related actions.
// `actor` is a staff member ({ id, name }), or a string such as 'gateway' or 'parent:98765...'.
// `via` names the tool that acted for them (the KBS AI Assistant).
const context = new AsyncLocalStorage();

// Runs fn so that every audit entry written inside it is marked as made via `via`.
export const auditVia = (via, fn) => context.run({ via }, fn);

export function audit(actor, action, { entity = null, entityId = null, details = null, via = null } = {}) {
  const who = typeof actor === 'string' ? actor : `staff:${actor.id} (${actor.name})`;
  db.prepare('INSERT INTO audit_log (at, actor, action, entity, entity_id, details, via) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    nowIso(),
    who,
    action,
    entity,
    entityId === null ? null : String(entityId),
    details === null ? null : JSON.stringify(details),
    via ?? context.getStore()?.via ?? null,
  );
}

const toEntry = (r) => ({
  id: r.id,
  at: r.at,
  actor: r.actor,
  action: r.action,
  entity: r.entity,
  entityId: r.entity_id,
  details: r.details ? JSON.parse(r.details) : null,
  via: r.via,
});

// Latest entries first, optionally filtered by action, person, dates, or AI-only.
export function recentAudit({ limit = 100, offset = 0, action = '', actor = '', from = '', to = '', via = '' } = {}) {
  const where = ['1 = 1'];
  const args = [];
  if (action) {
    where.push('action LIKE ?');
    args.push(`${action}%`);
  }
  if (actor) {
    where.push('actor LIKE ?');
    args.push(`%${actor}%`);
  }
  if (via === 'ai') where.push('via IS NOT NULL');
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    where.push('at >= ?');
    args.push(new Date(`${from}T00:00:00+05:30`).toISOString());
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    where.push('at < ?');
    args.push(new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 86_400_000).toISOString());
  }
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE ${where.join(' AND ')}`).get(...args).n;
  const entries = db
    .prepare(`SELECT * FROM audit_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...args, Math.min(Number(limit) || 100, 5000), Number(offset) || 0)
    .map(toEntry);
  return { total, entries };
}

// Everything recorded about one record (for example a payment's receipt), oldest first.
export function auditFor(entity, entityId, { limit = 50 } = {}) {
  return db
    .prepare('SELECT * FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY id LIMIT ?')
    .all(entity, String(entityId), limit)
    .map(toEntry);
}

export const auditActions = () => db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all().map((r) => r.action);
