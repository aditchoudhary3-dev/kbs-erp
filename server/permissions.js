import { HttpError } from './http.js';
import { requireStaff } from './auth.js';

export const ROLES = {
  admin: 'Admin',
  clerk: 'Clerk',
  teacher: 'Teacher',
  staff: 'Staff (no app access)',
};

// Roles that sign in to the staff app. "staff" records (drivers, attendants…)
// are kept for the school's records but cannot log in.
export const LOGIN_ROLES = ['admin', 'clerk', 'teacher'];

// What each role may do. Admins may do everything.
// Clerks handle collections and receipts but cannot change fees, student
// records, staff accounts or confirmed payments. Teachers see only the
// classes assigned to them: students (no fees), attendance, monthly
// progress and timetable.
const GRANTS = {
  clerk: [
    'dashboard.view',
    'payments.view',
    'payments.collect', // record money received at the counter
    'payments.reconcile', // ask the gateway for the status of an online payment
    'receipts.print',
    'whatsapp.send',
    'reminders.send',
    'students.view',
    'reports.view',
    'reports.export',
    'corrections.request', // ask an admin to correct a completed payment
    'assistant.use', // KBS AI Assistant (its tools check these same permissions)
    'attendance.view',
    'timetable.view',
    'parents.access', // give parents their app access code
  ],
  teacher: [
    'teaching', // My Day, My Classes: limited to the teacher's own classes
    'attendance.mark',
    'progress.enter', // monthly progress for their own classes
    'timetable.view',
  ],
  staff: [],
  admin: ['*'],
};

// Admin-only permissions, listed for the Users page.
export const ADMIN_ONLY = [
  'students.edit',
  'students.export',
  'fees.manage',
  'corrections.approve',
  'users.manage',
  'progress.manage',
  'notices.manage',
  'audit.view',
  'system.manage',
  'timetable.manage',
];

// Permissions only teachers have (admins see everything anyway).
const TEACHER_ONLY = ['teaching'];

export function can(role, permission) {
  const grants = GRANTS[role] ?? [];
  if (grants.includes('*')) return !TEACHER_ONLY.includes(permission);
  return grants.includes(permission);
}

export function permissionsFor(role) {
  if (GRANTS[role]?.includes('*')) {
    return [...new Set([...GRANTS.clerk, ...GRANTS.teacher.filter((p) => !TEACHER_ONLY.includes(p)), ...ADMIN_ONLY])];
  }
  return [...(GRANTS[role] ?? [])];
}

// Returns the logged-in staff member, or refuses the request.
// `permission` may be a list: any one of them is enough.
export function allow(ctx, permission) {
  const staff = requireStaff(ctx);
  const needed = permission === undefined ? [] : [].concat(permission);
  if (needed.length && !needed.some((p) => can(staff.role, p))) {
    throw new HttpError(403, 'Your account does not have permission for this. Please ask the school admin.');
  }
  return staff;
}
