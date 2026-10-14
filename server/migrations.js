import crypto from 'node:crypto';
import { parseClassName, sectionName, sortOrder, classLabel } from '../shared/school.js';

// Schema versions, applied in order and tracked with PRAGMA user_version.
// Never edit a shipped migration; add a new one instead.

// ---- 1: the original SchoolConnect schema ------------------------------------

const BASELINE = `
CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  roll_no INTEGER NOT NULL,
  parent_name TEXT NOT NULL DEFAULT '',
  parent_phone TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (class_id, roll_no)
);
CREATE INDEX IF NOT EXISTS students_parent_phone ON students(parent_phone);

CREATE TABLE IF NOT EXISTS progress_reports (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  days_present INTEGER,
  school_days INTEGER,
  remarks TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('draft', 'published')),
  updated_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE (student_id, month)
);

CREATE TABLE IF NOT EXISTS progress_marks (
  report_id INTEGER NOT NULL REFERENCES progress_reports(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  score INTEGER,
  PRIMARY KEY (report_id, subject)
);

CREATE TABLE IF NOT EXISTS progress_activities (
  id INTEGER PRIMARY KEY,
  report_id INTEGER NOT NULL REFERENCES progress_reports(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  result TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  amount INTEGER NOT NULL,
  method TEXT NOT NULL,
  receipt_no TEXT NOT NULL UNIQUE,
  txn_id TEXT,
  paid_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL DEFAULT 'parent'
);

-- Amounts are whole rupees. A fee item is paid once it points at a payment.
CREATE TABLE IF NOT EXISTS fee_items (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  due_date TEXT NOT NULL,
  payment_id INTEGER REFERENCES payments(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fee_items_student ON fee_items(student_id, payment_id);

CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id INTEGER PRIMARY KEY,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS otp_codes_phone ON otp_codes(phone);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('parent', 'admin')),
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Outgoing SMS. Nothing is really sent; the terminal prints each message.
CREATE TABLE IF NOT EXISTS sms_log (
  id INTEGER PRIMARY KEY,
  phone TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

// ---- 2: fee payment workflow ---------------------------------------------------

const FEE_WORKFLOW = `
-- Classes are grade + section (Nursery-A ... 12-B).
ALTER TABLE classes ADD COLUMN grade TEXT NOT NULL DEFAULT '';
ALTER TABLE classes ADD COLUMN section TEXT NOT NULL DEFAULT 'A';
ALTER TABLE classes ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

ALTER TABLE students ADD COLUMN admission_no TEXT;
ALTER TABLE students ADD COLUMN father_name TEXT NOT NULL DEFAULT '';
ALTER TABLE students ADD COLUMN mother_name TEXT NOT NULL DEFAULT '';
ALTER TABLE students ADD COLUMN whatsapp_phone TEXT;
ALTER TABLE students ADD COLUMN active INTEGER NOT NULL DEFAULT 1;

ALTER TABLE fee_items ADD COLUMN fee_type TEXT NOT NULL DEFAULT 'Other';

-- Staff accounts with roles (previously a single "admins" role).
ALTER TABLE admins RENAME TO staff;
ALTER TABLE staff ADD COLUMN role TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE staff ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE staff ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
ALTER TABLE staff ADD COLUMN last_login_at TEXT;

-- One row per attempt to pay: an online checkout or a counter collection.
CREATE TABLE payment_orders (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  fee_item_ids TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('online', 'counter')),
  gateway TEXT NOT NULL,
  gateway_order_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('created', 'paid', 'failed', 'cancelled')),
  failure_reason TEXT,
  idempotency_key TEXT UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX payment_orders_student ON payment_orders(student_id, status);
CREATE INDEX payment_orders_created ON payment_orders(created_at);

-- The payments table is the ledger of confirmed money received.
ALTER TABLE payments ADD COLUMN order_id INTEGER REFERENCES payment_orders(id);
ALTER TABLE payments ADD COLUMN gateway TEXT NOT NULL DEFAULT 'counter';
ALTER TABLE payments ADD COLUMN gateway_payment_id TEXT;
ALTER TABLE payments ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed';
ALTER TABLE payments ADD COLUMN collected_by TEXT NOT NULL DEFAULT '';
ALTER TABLE payments ADD COLUMN verified_at TEXT;
ALTER TABLE payments ADD COLUMN verified_via TEXT;
ALTER TABLE payments ADD COLUMN receipt_snapshot TEXT;
ALTER TABLE payments ADD COLUMN receipt_token TEXT;
ALTER TABLE payments ADD COLUMN review_note TEXT;
-- These unique indexes are what make duplicate confirmations impossible.
CREATE UNIQUE INDEX payments_gateway_payment ON payments(gateway, gateway_payment_id);
CREATE UNIQUE INDEX payments_order ON payments(order_id);
CREATE UNIQUE INDEX payments_receipt_token ON payments(receipt_token);
CREATE INDEX payments_paid_at ON payments(paid_at);
CREATE INDEX payments_student ON payments(student_id);

-- Every webhook received, valid or not. The unique key drops repeats.
CREATE TABLE payment_events (
  id INTEGER PRIMARY KEY,
  gateway TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  gateway_order_id TEXT,
  gateway_payment_id TEXT,
  signature_valid INTEGER NOT NULL,
  outcome TEXT,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (gateway, event_id)
);

-- Receipt messages to parents on WhatsApp: one per payment.
CREATE TABLE whatsapp_messages (
  id INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL UNIQUE REFERENCES payments(id),
  to_phone TEXT NOT NULL,
  body TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_message_id TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  opened_by TEXT
);
CREATE INDEX whatsapp_messages_provider_id ON whatsapp_messages(provider_message_id);

CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  details TEXT
);
CREATE INDEX audit_log_at ON audit_log(at);
`;

function upgradeExistingRows(db) {
  const now = new Date().toISOString();

  for (const c of db.prepare('SELECT id, name FROM classes').all()) {
    const { grade, section } = parseClassName(c.name);
    db.prepare('UPDATE classes SET grade = ?, section = ?, name = ?, sort_order = ? WHERE id = ?').run(
      grade,
      section,
      sectionName(grade, section),
      sortOrder(grade, section),
      c.id,
    );
  }

  for (const s of db.prepare('SELECT id, created_at FROM students WHERE admission_no IS NULL').all()) {
    const year = (s.created_at || now).slice(0, 4);
    db.prepare('UPDATE students SET admission_no = ? WHERE id = ?').run(`KBS/${year}/${String(s.id).padStart(4, '0')}`, s.id);
  }
  db.exec('CREATE UNIQUE INDEX students_admission_no ON students(admission_no)');

  db.exec(`UPDATE fee_items SET fee_type = CASE
             WHEN instr(title, ' · ') > 0 THEN substr(title, 1, instr(title, ' · ') - 1)
             ELSE title END`);
  db.prepare("UPDATE staff SET created_at = ? WHERE created_at = ''").run(now);

  // Give every existing payment an order and a frozen receipt, like new ones.
  const payments = db
    .prepare(
      `SELECT p.*, s.name AS student_name, s.admission_no, s.roll_no, s.parent_name, s.parent_phone,
              c.grade, c.section
       FROM payments p JOIN students s ON s.id = p.student_id JOIN classes c ON c.id = s.class_id
       ORDER BY p.id`,
    )
    .all();
  for (const p of payments) {
    const items = db.prepare('SELECT id, title, fee_type, amount FROM fee_items WHERE payment_id = ? ORDER BY id').all(p.id);
    const online = p.recorded_by === 'parent';
    const orderId = Number(
      db
        .prepare(
          `INSERT INTO payment_orders (student_id, amount, fee_item_ids, channel, gateway, gateway_order_id, status,
             created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'paid', ?, ?, ?)`,
        )
        .run(
          p.student_id,
          p.amount,
          JSON.stringify(items.map((i) => i.id)),
          online ? 'online' : 'counter',
          online ? 'test' : 'counter',
          online ? `order_migrated_${p.id}` : null,
          online ? 'parent' : 'staff',
          p.paid_at,
          p.paid_at,
        ).lastInsertRowid,
    );
    const snapshot = {
      receiptNo: p.receipt_no,
      paidAt: p.paid_at,
      student: {
        id: p.student_id,
        name: p.student_name,
        admissionNo: p.admission_no,
        rollNo: p.roll_no,
        grade: p.grade,
        section: p.section,
        className: sectionName(p.grade, p.section),
        classLabel: classLabel(p.grade, p.section),
        parentNames: p.parent_name,
      },
      items: items.map((i) => ({ feeType: i.fee_type, title: i.title, amount: i.amount })),
      total: p.amount,
      method: p.method,
      txnId: p.txn_id,
      gatewayOrderId: online ? `order_migrated_${p.id}` : null,
      collectedBy: online ? 'Online payment' : 'School office',
      status: 'PAID',
    };
    db.prepare(
      `UPDATE payments SET order_id = ?, gateway = ?, gateway_payment_id = ?, collected_by = ?, verified_at = ?,
         verified_via = 'import', receipt_snapshot = ?, receipt_token = ? WHERE id = ?`,
    ).run(
      orderId,
      online ? 'test' : 'counter',
      online ? p.txn_id : null,
      snapshot.collectedBy,
      p.paid_at,
      JSON.stringify(snapshot),
      crypto.randomBytes(18).toString('base64url'),
      p.id,
    );
  }
}

// ---- 3: student records, fee structure, cash corrections ------------------------

const ERP = `
-- Full admission details. Students are never deleted, only deactivated.
ALTER TABLE students ADD COLUMN dob TEXT;
ALTER TABLE students ADD COLUMN gender TEXT;
ALTER TABLE students ADD COLUMN alt_phone TEXT;
ALTER TABLE students ADD COLUMN address TEXT NOT NULL DEFAULT '';
ALTER TABLE students ADD COLUMN session TEXT NOT NULL DEFAULT '2026-27';
ALTER TABLE students ADD COLUMN admission_date TEXT;
ALTER TABLE students ADD COLUMN transport INTEGER NOT NULL DEFAULT 0;
ALTER TABLE students ADD COLUMN bus_route TEXT NOT NULL DEFAULT '';
ALTER TABLE students ADD COLUMN remarks TEXT NOT NULL DEFAULT '';
ALTER TABLE students ADD COLUMN deactivated_at TEXT;

-- Fee types the school defines (Tuition Fee, Computer Fee, ...).
CREATE TABLE fee_types (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL
);

-- A fee that applies to a class (or all classes) for a session. Instalments
-- are generated from the frequency; each becomes a fee item per student.
CREATE TABLE fee_structures (
  id INTEGER PRIMARY KEY,
  fee_type_id INTEGER NOT NULL REFERENCES fee_types(id),
  name TEXT NOT NULL,
  grade TEXT,
  session TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  frequency TEXT NOT NULL CHECK (frequency IN ('Monthly', 'Quarterly', 'Half-Yearly', 'Yearly', 'One-Time', 'Custom')),
  first_due_date TEXT NOT NULL,
  schedule TEXT,
  late_fee INTEGER NOT NULL DEFAULT 0,
  compulsory INTEGER NOT NULL DEFAULT 1,
  transport_only INTEGER NOT NULL DEFAULT 0,
  new_admissions_only INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX fee_structures_grade ON fee_structures(session, grade);

ALTER TABLE fee_items ADD COLUMN structure_id INTEGER REFERENCES fee_structures(id);
ALTER TABLE fee_items ADD COLUMN period TEXT;
ALTER TABLE fee_items ADD COLUMN late_fee_for INTEGER REFERENCES fee_items(id);
-- One fee item per student per instalment, and one late fee per item.
CREATE UNIQUE INDEX fee_items_instalment ON fee_items(student_id, structure_id, period);
CREATE UNIQUE INDEX fee_items_late_fee ON fee_items(late_fee_for);
CREATE INDEX fee_items_due ON fee_items(payment_id, due_date);

-- Who collected it, how much cash was handed over, and reversals.
ALTER TABLE payments ADD COLUMN collected_by_staff_id INTEGER REFERENCES staff(id);
ALTER TABLE payments ADD COLUMN amount_received INTEGER;
ALTER TABLE payments ADD COLUMN reversed_at TEXT;
ALTER TABLE payments ADD COLUMN reversal_reason TEXT;
ALTER TABLE payments ADD COLUMN replaces_payment_id INTEGER REFERENCES payments(id);

-- Corrections to completed payments, approved by an admin.
CREATE TABLE payment_corrections (
  id INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id),
  kind TEXT NOT NULL CHECK (kind IN ('cancel', 'change_details')),
  reason TEXT NOT NULL,
  requested_changes TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by INTEGER NOT NULL REFERENCES staff(id),
  requested_at TEXT NOT NULL,
  decided_by INTEGER REFERENCES staff(id),
  decided_at TEXT,
  decision_note TEXT,
  replacement_payment_id INTEGER REFERENCES payments(id)
);
CREATE UNIQUE INDEX payment_corrections_open ON payment_corrections(payment_id) WHERE status = 'pending';
`;

// v4: receipt copies and the KBS AI Assistant.
const ASSISTANT = `
-- Audit entries made through the KBS AI Assistant say so here.
ALTER TABLE audit_log ADD COLUMN via TEXT;

-- Changes the assistant has prepared. Nothing happens until the staff member
-- who asked presses Confirm; the change then runs with their permissions.
CREATE TABLE assistant_actions (
  id INTEGER PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'cancelled', 'failed', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  result TEXT,
  error TEXT
);
CREATE INDEX assistant_actions_staff ON assistant_actions(staff_id, created_at);
CREATE INDEX audit_log_entity ON audit_log(entity, entity_id);
`;

// v5: teachers and staff records, subjects, timetable, attendance, parent app accounts.
const ACADEMICS = `
-- Staff records for everyone at school. Admins, clerks and teachers log in;
-- other staff ("staff" role) are records only, so email and password are optional.
CREATE TABLE staff_v5 (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'admin',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT '',
  last_login_at TEXT,
  phone TEXT,
  designation TEXT NOT NULL DEFAULT '',
  joined_on TEXT
);
INSERT INTO staff_v5 (id, email, name, password_hash, role, active, created_at, last_login_at)
  SELECT id, email, name, password_hash, role, active, created_at, last_login_at FROM staff;
DROP TABLE staff;
ALTER TABLE staff_v5 RENAME TO staff;

CREATE TABLE subjects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- The classes each teacher teaches, and who is the class teacher.
CREATE TABLE teacher_classes (
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  class_id INTEGER NOT NULL REFERENCES classes(id),
  class_teacher INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (staff_id, class_id)
);
CREATE UNIQUE INDEX one_class_teacher ON teacher_classes(class_id) WHERE class_teacher = 1;

-- Weekly timetable: Monday = 1 ... Saturday = 6.
CREATE TABLE timetable (
  class_id INTEGER NOT NULL REFERENCES classes(id),
  day INTEGER NOT NULL CHECK (day BETWEEN 1 AND 6),
  period INTEGER NOT NULL CHECK (period BETWEEN 1 AND 12),
  subject_id INTEGER REFERENCES subjects(id),
  staff_id INTEGER REFERENCES staff(id),
  PRIMARY KEY (class_id, day, period)
);
CREATE INDEX timetable_teacher ON timetable(staff_id, day, period);

-- Daily attendance, one row per student per school day.
CREATE TABLE attendance (
  student_id INTEGER NOT NULL REFERENCES students(id),
  date TEXT NOT NULL,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  status TEXT NOT NULL CHECK (status IN ('present', 'absent', 'late', 'leave')),
  note TEXT,
  marked_by INTEGER REFERENCES staff(id),
  marked_at TEXT NOT NULL,
  PRIMARY KEY (student_id, date)
);
CREATE INDEX attendance_class_date ON attendance(class_id, date);

-- Parents who sign in with a PIN set up from an access code the school
-- gives them (no SMS needed). The phone is the one on the student record.
CREATE TABLE parent_accounts (
  phone TEXT PRIMARY KEY,
  pin_hash TEXT,
  setup_code_hash TEXT,
  setup_expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);
`;

export const STANDARD_SUBJECTS = [
  'English', 'Hindi', 'Maths', 'Science', 'Social Studies', 'Sanskrit', 'Computer Science',
  'Environmental Studies', 'General Knowledge', 'Drawing', 'Physical Education', 'Music',
  'Physics', 'Chemistry', 'Biology', 'Accountancy', 'Business Studies', 'Economics', 'Political Science', 'History', 'Geography',
];

export const STANDARD_FEE_TYPES = [
  'Tuition Fee', 'Admission Fee', 'Annual Charges', 'Examination Fee', 'Computer Fee', 'Transport Fee',
  'Activity Fee', 'Sports Fee', 'Development Fee', 'Late Fee', 'Other Fee',
];
const OLD_TYPE_NAMES = {
  Tuition: 'Tuition Fee', Transport: 'Transport Fee', 'Annual charges': 'Annual Charges', Exam: 'Examination Fee',
  Admission: 'Admission Fee', Activity: 'Activity Fee', Other: 'Other Fee',
};

// Groups existing fees into fee structures, so they appear in the new module.
function backfillFeeStructures(db) {
  const now = new Date().toISOString();
  const session = '2026-27';
  const addType = db.prepare('INSERT OR IGNORE INTO fee_types (name, created_at) VALUES (?, ?)');
  for (const name of STANDARD_FEE_TYPES) addType.run(name, now);
  for (const [from, to] of Object.entries(OLD_TYPE_NAMES)) db.prepare('UPDATE fee_items SET fee_type = ? WHERE fee_type = ?').run(to, from);
  for (const { fee_type: type } of db.prepare('SELECT DISTINCT fee_type FROM fee_items').all()) addType.run(type, now);
  const typeId = (name) => db.prepare('SELECT id FROM fee_types WHERE name = ?').get(name).id;

  const groups = new Map();
  const items = db
    .prepare('SELECT f.id, f.title, f.fee_type, f.amount, f.due_date, c.grade FROM fee_items f JOIN students s ON s.id = f.student_id JOIN classes c ON c.id = s.class_id')
    .all();
  for (const item of items) {
    const [base, label = null] = item.title.split(' · ');
    const key = [item.grade, item.fee_type, base, item.amount].join('|');
    const group = groups.get(key) ?? { ...item, base, periods: new Map(), itemIds: [] };
    group.periods.set(label ?? session, item.due_date);
    group.itemIds.push([item.id, label ?? session]);
    groups.set(key, group);
  }
  for (const g of groups.values()) {
    const schedule = [...g.periods].map(([label, dueDate]) => ({ label, dueDate })).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const id = Number(
      db
        .prepare(
          `INSERT INTO fee_structures (fee_type_id, name, grade, session, amount, frequency, first_due_date, schedule,
             transport_only, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(typeId(g.fee_type), g.base, g.grade, session, g.amount, schedule.length > 1 ? 'Custom' : 'One-Time', schedule[0].dueDate,
          JSON.stringify(schedule), g.fee_type === 'Transport Fee' ? 1 : 0, now, now).lastInsertRowid,
    );
    const link = db.prepare('UPDATE fee_items SET structure_id = ?, period = ? WHERE id = ?');
    for (const [itemId, period] of g.itemIds) link.run(id, period, itemId);
  }
  db.prepare("UPDATE students SET transport = 1 WHERE id IN (SELECT DISTINCT student_id FROM fee_items WHERE fee_type = 'Transport Fee')").run();
  db.prepare("UPDATE students SET admission_date = substr(created_at, 1, 10) WHERE admission_date IS NULL").run();
  db.prepare("UPDATE students SET deactivated_at = ? WHERE active = 0").run(now);
  db.prepare("UPDATE payments SET collected_by_staff_id = (SELECT id FROM staff WHERE name = payments.collected_by LIMIT 1) WHERE gateway = 'counter'").run();
}

export const MIGRATIONS = [
  { version: 1, name: 'baseline', up: (db) => db.exec(BASELINE) },
  {
    version: 2,
    name: 'fee payment workflow',
    up: (db) => {
      db.exec(FEE_WORKFLOW);
      upgradeExistingRows(db);
    },
  },
  {
    version: 3,
    name: 'student records, fee structure and corrections',
    up: (db) => {
      db.exec(ERP);
      backfillFeeStructures(db);
    },
  },
  { version: 4, name: 'receipt copies and AI assistant', up: (db) => db.exec(ASSISTANT) },
  {
    version: 5,
    name: 'teachers, attendance, timetable and parent accounts',
    up: (db) => {
      db.exec(ACADEMICS);
      const add = db.prepare('INSERT OR IGNORE INTO subjects (name, sort_order) VALUES (?, ?)');
      STANDARD_SUBJECTS.forEach((name, i) => add.run(name, i + 1));
    },
  },
];
