import { db, transaction } from './db.js';
import { config } from './config.js';
import { ensureClass } from './services/students.js';
import { createUser } from './services/users.js';
import { GRADES } from '../shared/school.js';

// Getting a real school's server ready (DEMO_MODE=off).
//
// A new database starts empty: no demo students or payments. It gets the
// classes Nursery to Class 12 (section A; add more sections when adding
// students) and the first admin account from ADMIN_EMAIL / ADMIN_PASSWORD.
// The first admin then adds staff, fees and students in the app.

export function prepareNewSchool() {
  transaction(() => {
    for (const grade of GRADES) ensureClass(grade, 'A');
  });
}

// Creates the first admin when the school has none yet. Returns the admin, or
// null when there is one already or no ADMIN_EMAIL / ADMIN_PASSWORD was given.
export function ensureFirstAdmin() {
  const hasAdmin = db.prepare("SELECT 1 FROM staff WHERE role = 'admin' AND active = 1 LIMIT 1").get();
  if (hasAdmin) return null;
  const { name, email, password } = config.firstAdmin;
  if (!email || !password) {
    console.warn(
      '\n  No admin account yet. Set ADMIN_EMAIL and ADMIN_PASSWORD (at least 8 characters) and restart,\n' +
        '  or run: npm run create-admin -- --email you@school.in --name "Your Name"\n',
    );
    return null;
  }
  const admin = createUser({ name, email, role: 'admin', password });
  console.log(`  First admin account created for ${admin.email}. Log in and change the password.`);
  return admin;
}
