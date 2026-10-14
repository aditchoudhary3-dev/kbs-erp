import { db, nowIso } from './db.js';
import { formatPhone } from '../shared/format.js';

// Stand-in for an SMS gateway (MSG91, Twilio, etc.). Messages are stored and
// printed to the terminal so the demo can be followed without a real phone.
export function sendSms(phone, kind, body) {
  db.prepare('INSERT INTO sms_log (phone, kind, body, created_at) VALUES (?, ?, ?, ?)').run(phone, kind, body, nowIso());
  if (!process.env.QUIET) console.log(`\x1b[36m[SMS to +91 ${formatPhone(phone)}]\x1b[0m ${body}`);
}
