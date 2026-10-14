// npm run create-admin -- --email you@school.in --name "Your Name"
// Creates an admin account (or resets an existing account's password and
// makes it an admin). Asks for the password without showing it.
import readline from 'node:readline';
import { config } from './config.js';
import { db, openDatabase, closeDatabase } from './db.js';
import { hashPassword } from './auth.js';
import { createUser } from './services/users.js';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : '';
};

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (text) => rl.output.write(text.includes(question) ? text : '');
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const email = arg('email').trim().toLowerCase();
const name = arg('name').trim() || 'School Admin';
if (!email) {
  console.error('Usage: npm run create-admin -- --email you@school.in --name "Your Name"');
  process.exit(1);
}

const password = process.env.ADMIN_PASSWORD || (await askHidden('New password (at least 8 characters): '));
if (password.length < 8) {
  console.error('The password must be at least 8 characters.');
  process.exit(1);
}

openDatabase(config.dbFile);
const existing = db.prepare('SELECT id FROM staff WHERE email = ?').get(email);
if (existing) {
  db.prepare("UPDATE staff SET password_hash = ?, role = 'admin', active = 1 WHERE id = ?").run(hashPassword(password), existing.id);
  db.prepare("DELETE FROM sessions WHERE role = 'admin' AND subject = ?").run(String(existing.id));
  console.log(`${email} is now an active admin with the new password.`);
} else {
  createUser({ name, email, role: 'admin', password });
  console.log(`Admin account created for ${email}.`);
}
closeDatabase();
