import fs from 'node:fs';
import path from 'node:path';
import { db, SCHEMA_VERSION } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../http.js';
import { gateway } from '../integrations/payments/index.js';
import { whatsapp } from '../integrations/whatsapp/index.js';
import { putObject } from '../integrations/storage/s3.js';

// System backup and health, for admins.

let dbFile = null;
let backupDir = null;
const startedAt = new Date();

export function configureSystem(file) {
  dbFile = file;
  backupDir = file === ':memory:' ? null : path.join(path.dirname(file), 'backups');
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

// ---- Backups -------------------------------------------------------------------------

export function listBackups() {
  if (!backupDir || !fs.existsSync(backupDir)) return [];
  return fs
    .readdirSync(backupDir)
    .filter((name) => name.endsWith('.db'))
    .map((name) => {
      const stat = fs.statSync(path.join(backupDir, name));
      return { name, size: stat.size, createdAt: stat.mtime.toISOString(), automatic: name.includes('-auto') };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// A complete, consistent copy of the database, taken while the app runs.
export function createBackup({ automatic = false } = {}) {
  if (!backupDir) throw new HttpError(400, 'Backups are not available for an in-memory database.');
  fs.mkdirSync(backupDir, { recursive: true });
  const name = `kbs-erp-${stamp()}${automatic ? '-auto' : ''}.db`;
  const target = path.join(backupDir, name);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  return listBackups().find((b) => b.name === name);
}

export function backupPath(name) {
  if (!backupDir || !/^kbs-erp-[\w-]+\.db$/.test(name)) throw new HttpError(404, 'Backup not found.');
  const file = path.join(backupDir, name);
  if (!fs.existsSync(file)) throw new HttpError(404, 'Backup not found.');
  return file;
}

// ---- Off-site copies ------------------------------------------------------------------
//
// With BACKUP_S3_* set, each backup is also copied to cloud object storage,
// so the school's data survives the loss of the server itself.

const offsite = { last: null }; // { name, at, ok, error }

export const offsiteConfigured = () => {
  const o = config.offsiteBackup;
  return Boolean(o.endpoint && o.bucket && o.accessKey && o.secretKey);
};

export async function uploadBackup(name) {
  if (!offsiteConfigured()) return null;
  try {
    const body = fs.readFileSync(backupPath(name));
    await putObject(config.offsiteBackup, `${config.offsiteBackup.prefix}${name}`, body, 'application/vnd.sqlite3');
    offsite.last = { name, at: new Date().toISOString(), ok: true, error: null };
  } catch (err) {
    offsite.last = { name, at: new Date().toISOString(), ok: false, error: err.message };
    console.error(`[backup] off-site copy of ${name} failed: ${err.message}`);
  }
  return offsite.last;
}

export const offsiteStatus = () => ({ configured: offsiteConfigured(), bucket: config.offsiteBackup.bucket || null, last: offsite.last });

// Keeps the newest automatic backups; manual ones are never removed.
function pruneAutomatic(keep = 14) {
  for (const backup of listBackups().filter((b) => b.automatic).slice(keep)) {
    fs.rmSync(path.join(backupDir, backup.name), { force: true });
  }
}

let backupTimer = null;
export function startBackupWorker() {
  if (!backupDir) return;
  const run = () => {
    try {
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      if (!listBackups().some((b) => b.automatic && b.name.includes(today))) {
        const backup = createBackup({ automatic: true });
        pruneAutomatic();
        uploadBackup(backup.name);
      }
    } catch (err) {
      console.error('[backup] automatic backup failed:', err.message);
    }
  };
  run();
  backupTimer = setInterval(run, 60 * 60_000);
  backupTimer.unref();
}
export const stopBackupWorker = () => clearInterval(backupTimer);

// ---- Health ----------------------------------------------------------------------------

const one = (sql, ...args) => db.prepare(sql).get(...args);

export function health() {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();

  const integrity = one('PRAGMA quick_check').quick_check;
  add('Database integrity', integrity === 'ok' ? 'ok' : 'error', integrity === 'ok' ? 'No problems found' : integrity);

  const provider = gateway();
  add('Payment gateway', provider.name === 'razorpay' ? 'ok' : 'warn', provider.name === 'razorpay' ? 'Razorpay (live keys set)' : 'Test gateway: no real money is collected');

  const rejected = one("SELECT COUNT(*) AS n FROM payment_events WHERE signature_valid = 0 AND received_at > ?", dayAgo).n;
  add('Webhook signatures', rejected ? 'warn' : 'ok', rejected ? `${rejected} webhook(s) rejected in the last 24 hours` : 'No rejected webhooks in the last 24 hours');

  const stuck = one("SELECT COUNT(*) AS n FROM payment_orders WHERE channel = 'online' AND status = 'created' AND created_at < ?", new Date(Date.now() - 3600_000).toISOString()).n;
  add('Unfinished online payments', stuck ? 'warn' : 'ok', stuck ? `${stuck} started over an hour ago and not finished (checked with the gateway automatically)` : 'None waiting');

  const review = one("SELECT COUNT(*) AS n FROM payments WHERE review_note IS NOT NULL AND status = 'confirmed'").n;
  add('Payments needing review', review ? 'warn' : 'ok', review ? `${review} paid twice for the same fees` : 'None');

  const corrections = one("SELECT COUNT(*) AS n FROM payment_corrections WHERE status = 'pending'").n;
  add('Correction requests', corrections ? 'warn' : 'ok', corrections ? `${corrections} waiting for approval` : 'None waiting');

  const wa = whatsapp();
  const waFailed = one("SELECT COUNT(*) AS n FROM whatsapp_messages WHERE status = 'failed'").n;
  add('WhatsApp receipts', waFailed ? 'warn' : 'ok', wa.automatic ? (waFailed ? `${waFailed} failed to send (retrying)` : 'Sending automatically') : 'Clerk sends from WhatsApp (API not set up)');

  const ai = config.assistant;
  const claude = ai.provider === 'claude' && Boolean(ai.claude.apiKey);
  add(ai.name, 'ok', claude ? `Claude (${ai.claude.model}), limited to the assistant's allow-listed tools` : 'Built-in assistant (set ANTHROPIC_API_KEY to use Claude)');

  const backups = listBackups();
  const lastBackup = backups[0];
  const backupAge = lastBackup ? (Date.now() - Date.parse(lastBackup.createdAt)) / 3600_000 : Infinity;
  add('Backups', !backupDir ? 'warn' : backupAge < 36 ? 'ok' : 'warn', lastBackup ? `Last backup ${lastBackup.createdAt}` : 'No backups yet');
  const copy = offsiteStatus();
  add(
    'Off-site backup copies',
    !copy.configured ? 'warn' : copy.last && !copy.last.ok ? 'error' : 'ok',
    !copy.configured
      ? 'Not set up: backups stay on this server only (set BACKUP_S3_* to copy them to cloud storage)'
      : copy.last
        ? copy.last.ok
          ? `Last copy ${copy.last.name} at ${copy.last.at} to ${copy.bucket}`
          : `Last copy failed: ${copy.last.error}`
        : `Copies go to ${copy.bucket} after each daily backup`,
  );

  let disk = null;
  if (dbFile && dbFile !== ':memory:') {
    try {
      const stat = fs.statfsSync(path.dirname(dbFile));
      disk = { free: stat.bavail * stat.bsize, total: stat.blocks * stat.bsize };
      add('Disk space', disk.free > 1024 ** 3 ? 'ok' : 'warn', `${(disk.free / 1024 ** 3).toFixed(1)} GB free`);
    } catch {
      // statfs is not available everywhere.
    }
  }

  const size = dbFile && dbFile !== ':memory:' && fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0;
  return {
    status: checks.some((c) => c.status === 'error') ? 'error' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok',
    checks,
    app: {
      name: config.appName,
      schemaVersion: SCHEMA_VERSION,
      node: process.version,
      startedAt: startedAt.toISOString(),
      uptimeHours: Math.round(((Date.now() - startedAt.getTime()) / 3600_000) * 10) / 10,
    },
    database: {
      file: dbFile,
      sizeBytes: size,
      students: one('SELECT COUNT(*) AS n FROM students WHERE active = 1').n,
      inactiveStudents: one('SELECT COUNT(*) AS n FROM students WHERE active = 0').n,
      payments: one("SELECT COUNT(*) AS n FROM payments WHERE status = 'confirmed'").n,
      cancelledPayments: one("SELECT COUNT(*) AS n FROM payments WHERE status = 'reversed'").n,
      auditEntries: one('SELECT COUNT(*) AS n FROM audit_log').n,
      lastPaymentAt: one("SELECT MAX(paid_at) AS t FROM payments WHERE status = 'confirmed'").t,
      lastWebhookAt: one('SELECT MAX(received_at) AS t FROM payment_events').t,
    },
    backups: { directory: backupDir, count: backups.length, last: lastBackup ?? null },
    disk,
  };
}
