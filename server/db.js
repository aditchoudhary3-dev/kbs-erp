import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations.js';

// Live binding: modules read `db` at call time, after openDatabase() has run.
export let db = null;

export const SCHEMA_VERSION = MIGRATIONS.at(-1).version;

export function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(file);
  return db;
}

export function closeDatabase() {
  db?.close();
  db = null;
}

function currentVersion() {
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  if (version > 0) return version;
  // Databases created before versioning have tables but version 0.
  const hasTables = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'classes'").get();
  return hasTables ? 1 : 0;
}

// Applies pending migrations, each in its own transaction. An existing
// database is copied to a timestamped backup file first.
function migrate(file) {
  let version = currentVersion();
  if (version > SCHEMA_VERSION) {
    throw new Error(`The database is from a newer version of the app (schema ${version}). Update the app.`);
  }
  if (version > 0 && version < SCHEMA_VERSION && file !== ':memory:') {
    const backup = `${file}.before-v${SCHEMA_VERSION}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    console.log(`Database backed up to ${backup} before upgrading.`);
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue;
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Database upgrade to version ${migration.version} (${migration.name}) failed: ${err.message}`);
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
    version = migration.version;
  }
}

export const nowIso = () => new Date().toISOString();

// Runs fn in a transaction. Nested calls join the outer transaction, so
// services can be combined (e.g. create an order and confirm it) atomically.
let depth = 0;
let afterCommitQueue = [];
export function transaction(fn) {
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth += 1;
  let result;
  try {
    result = fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    afterCommitQueue = [];
    throw err;
  } finally {
    depth -= 1;
  }
  const queued = afterCommitQueue;
  afterCommitQueue = [];
  for (const task of queued) task();
  return result;
}

// Runs task once the current transaction has committed (or now, if none).
// Used to announce events only after the data is safely stored.
export function afterCommit(task) {
  if (depth > 0) afterCommitQueue.push(task);
  else task();
}

export function isEmpty() {
  return !db.prepare('SELECT 1 FROM classes LIMIT 1').get();
}

export function purgeExpired() {
  const now = nowIso();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM otp_codes WHERE expires_at < ?').run(now);
}

// Next value of a named sequence (receipt numbers). Call inside a transaction.
export function nextCounter(name) {
  db.prepare('INSERT INTO counters (name, value) VALUES (?, 0) ON CONFLICT(name) DO NOTHING').run(name);
  db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run(name);
  return db.prepare('SELECT value FROM counters WHERE name = ?').get(name).value;
}
