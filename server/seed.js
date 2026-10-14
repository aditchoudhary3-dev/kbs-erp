import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { db, openDatabase, closeDatabase, isEmpty, transaction } from './db.js';
import { hashPassword } from './auth.js';
import { ensureClass } from './services/students.js';
import { confirmOrderTx, insertOrder } from './services/payments.js';
import { createStructure, syncStudentAccount } from './services/fee-structure.js';
import { assignClasses, setTimetableCell } from './services/academics.js';
import { GRADES } from '../shared/school.js';
import { todayIso } from '../shared/format.js';

// Demo sign-ins, shown on the login screens while demo mode is on.
export const DEMO = {
  parentPhone: '9876543210', // Aarav Sharma's parent, as in the mockups
  siblingsPhone: '9876500018', // Diya (6-B) and Kabir (7-A) Patel's parent
  adminEmail: 'admin@kbs.test',
  adminPassword: 'admin1234',
  clerkEmail: 'clerk@kbs.test',
  clerkPassword: 'clerk1234',
  teacherEmail: 'teacher@kbs.test',
  teacherPassword: 'teacher1234',
  parentPin: '246810', // Aarav's parent can also log in with this PIN
};

const STAFF = [
  { name: 'Anil Thakur', email: DEMO.adminEmail, password: DEMO.adminPassword, role: 'admin' },
  { name: 'Sunita Rana', email: DEMO.clerkEmail, password: DEMO.clerkPassword, role: 'clerk' },
];

const SECTIONS = {
  Nursery: ['A'],
  LKG: ['A'],
  UKG: ['A'],
  'Class 1': ['A', 'B'],
  'Class 2': ['A'],
  'Class 3': ['A', 'B'],
  'Class 4': ['A'],
  'Class 5': ['A', 'B'],
  'Class 6': ['A', 'B'],
  'Class 7': ['A'],
  'Class 8': ['A', 'B'],
  'Class 9': ['A', 'B'],
  'Class 10': ['A', 'B'],
  'Class 11': ['A', 'B'],
  'Class 12': ['A', 'B'],
};

// Sample fee structure for 2026-27 (whole rupees). Change it on the Fee Structure page.
function bandFor(grade) {
  const i = GRADES.indexOf(grade);
  if (i <= 2) return { tuition: 6500, annual: 3000 }; // Nursery–UKG
  if (i <= 7) return { tuition: 8500, annual: 4000 }; // Class 1–5
  if (i <= 10) return { tuition: 12500, annual: 5000 }; // Class 6–8 (as in the mockups)
  if (i <= 12) return { tuition: 14000, annual: 5500 }; // Class 9–10
  return { tuition: 16000, annual: 6000 }; // Class 11–12
}

function feeStructuresFor(grade) {
  const band = bandFor(grade);
  const i = GRADES.indexOf(grade);
  return [
    { feeType: 'Annual Charges', name: 'Annual Charges', amount: band.annual, frequency: 'Yearly', firstDueDate: '2026-04-10', lateFee: 100 },
    {
      feeType: 'Tuition Fee',
      name: 'Tuition Fee',
      amount: band.tuition,
      frequency: 'Custom',
      schedule: [{ label: 'Term 1', dueDate: '2026-07-10' }, { label: 'Term 2', dueDate: '2026-10-10' }],
      lateFee: 200,
    },
    {
      feeType: 'Transport Fee',
      name: 'Transport Fee',
      amount: 3000,
      frequency: 'Custom',
      schedule: [
        { label: 'Jul–Sep', dueDate: '2026-07-10' },
        { label: 'Oct–Dec', dueDate: '2026-10-10' },
        { label: 'Jan–Mar', dueDate: '2027-01-10' },
      ],
      lateFee: 100,
      transportOnly: true,
    },
    ...(grade === 'Class 10' || grade === 'Class 12'
      ? [{ feeType: 'Examination Fee', name: 'Board Exam Fee', amount: 1800, frequency: 'One-Time', firstDueDate: '2026-10-31' }]
      : []),
    ...(i >= 8 ? [{ feeType: 'Computer Fee', name: 'Computer Fee', amount: 600, frequency: 'Quarterly', firstDueDate: '2026-04-15', compulsory: false }] : []),
  ];
}

const VILLAGES = ['Ladwara', 'Shahpur', 'Rait', 'Gaggal', 'Chambi', 'Dadh', 'Sidhbari', 'Darini', 'Bhatehr', 'Lanj', 'Kaned', 'Harchakian'];
const BUS_ROUTES = ['Route 1 – Shahpur', 'Route 2 – Rait', 'Route 3 – Gaggal', 'Route 4 – Chambi'];
const GENDER_OF = { 'Aanya Gupta': 'Female', 'Diya Patel': 'Female', 'Kavya Reddy': 'Female', 'Meera Iyer': 'Female' };

// Students from the mockups: [grade, section, roll, name, father, mother, bus, phone]
const MOCKUP_STUDENTS = [
  ['Class 6', 'B', 12, 'Aanya Gupta', 'Vivek Gupta', 'Neha Gupta', true],
  ['Class 6', 'B', 14, 'Aarav Sharma', 'Rohit Sharma', 'Priya Sharma', true, DEMO.parentPhone],
  ['Class 6', 'B', 15, 'Arjun Nair', 'Suresh Nair', 'Latha Nair', false],
  ['Class 6', 'B', 18, 'Diya Patel', 'Nilesh Patel', 'Hetal Patel', true, DEMO.siblingsPhone],
  ['Class 6', 'B', 21, 'Ishaan Verma', 'Rakesh Verma', 'Sunita Verma', true],
  ['Class 6', 'B', 23, 'Kavya Reddy', 'Srinivas Reddy', 'Lakshmi Reddy', false],
  ['Class 6', 'B', 26, 'Meera Iyer', 'Anand Iyer', 'Radha Iyer', true],
  ['Class 6', 'B', 30, 'Rohan Singh', 'Gurpreet Singh', 'Harpreet Kaur', false],
  ['Class 7', 'A', 9, 'Kabir Patel', 'Nilesh Patel', 'Hetal Patel', true, DEMO.siblingsPhone],
];
const MOCKUP_NAMES = new Set(MOCKUP_STUDENTS.map((s) => s[3]));

const BOYS = ['Aditya', 'Ansh', 'Arnav', 'Aryan', 'Ayush', 'Daksh', 'Dev', 'Harsh', 'Kartik', 'Lakshya', 'Nikhil', 'Parth', 'Pranav', 'Rahul', 'Ritvik', 'Sahil', 'Shivam', 'Tanish', 'Vansh', 'Vivaan', 'Yash', 'Abhinav', 'Kunal', 'Manav', 'Om', 'Rudra', 'Sarthak', 'Utkarsh'];
const GIRLS = ['Aarohi', 'Aditi', 'Anjali', 'Ananya', 'Ira', 'Ishita', 'Kritika', 'Muskan', 'Myra', 'Navya', 'Neha', 'Palak', 'Pooja', 'Riya', 'Saanvi', 'Shreya', 'Simran', 'Sneha', 'Tanvi', 'Tara', 'Vanshika', 'Diksha', 'Khushi', 'Nandini', 'Sakshi', 'Tanya'];
const SURNAMES = ['Sharma', 'Thakur', 'Rana', 'Chauhan', 'Katoch', 'Guleria', 'Dogra', 'Pathania', 'Sood', 'Bhardwaj', 'Verma', 'Kapoor', 'Rathore', 'Jamwal', 'Chandel', 'Dhiman', 'Awasthi', 'Kumar', 'Sharma', 'Thakur', 'Rana', 'Mehta', 'Negi', 'Parmar'];
const FATHERS = ['Rakesh', 'Sanjeev', 'Vinod', 'Ajay', 'Rajesh', 'Sunil', 'Anil', 'Pawan', 'Naresh', 'Rajiv', 'Vikram', 'Manoj', 'Deepak', 'Ashok', 'Sandeep', 'Kuldeep', 'Surinder', 'Ramesh', 'Mukesh', 'Pankaj'];
const MOTHERS = ['Sunita', 'Anita', 'Rekha', 'Kiran', 'Neelam', 'Seema', 'Poonam', 'Meena', 'Asha', 'Renu', 'Kavita', 'Sushma', 'Manju', 'Rita', 'Shalini', 'Vandana', 'Anju', 'Sapna'];

// ---- Progress reports (as before) ----------------------------------------------------

const MONTHS = ['2026-04', '2026-07', '2026-08', '2026-09'];
const SCHOOL_DAYS = { '2026-04': 22, '2026-07': 25, '2026-08': 23, '2026-09': 24 };
const PUBLISHED_AT = {
  '2026-04': '2026-05-04T05:30:00.000Z',
  '2026-07': '2026-08-03T05:30:00.000Z',
  '2026-08': '2026-09-02T05:30:00.000Z',
  '2026-09': '2026-09-22T06:15:00.000Z',
};

// September is still being entered; these are the reports from the mockups.
const SEPTEMBER = {
  'Aanya Gupta': 'published',
  'Aarav Sharma': 'published',
  'Arjun Nair': 'draft',
  'Kabir Patel': 'published',
};

// Aarav's reports, exactly as in the mockups. Marks follow config.subjects.
const AARAV = {
  '2026-04': {
    present: 20,
    marks: [82, 77, 70, 84, 82],
    remarks: 'A good start to the year. Aarav settles in quickly and is curious in science lessons. Encourage daily reading at home.',
    activities: [['Welcome assembly', 'Participated'], ['Homework completed', '17 / 20']],
  },
  '2026-07': {
    present: 23,
    marks: [85, 79, 72, 87, 83],
    remarks: 'Steady improvement in English writing. Maths needs regular practice, especially fractions.',
    activities: [['Van Mahotsav tree planting', 'Participated'], ['Homework completed', '19 / 20']],
  },
  '2026-08': {
    present: 21,
    marks: [86, 80, 74, 88, 84],
    remarks: 'Took part confidently in the Independence Day programme. Keep up the good effort in all subjects.',
    activities: [['Independence Day recitation', 'Performed'], ['Inter-class quiz', 'Runner-up'], ['Homework completed', '18 / 20']],
  },
  '2026-09': {
    present: 22,
    marks: [88, 81, 76, 90, 85],
    remarks: 'Aarav participates actively in class discussions. Needs more practice with fractions and word problems in Maths.',
    activities: [['Inter-house football', 'Winner'], ['Science exhibition', 'Participated'], ['Homework completed', '18 / 20']],
  },
};

const REMARKS = [
  (n, weak) => `${n} is attentive in class and completes work on time. ${weak} needs a little more practice at home.`,
  (n, weak) => `${n} has made steady progress this month. Regular revision in ${weak} will help further.`,
  (n, weak) => `${n} participates well in group work and asks good questions. Please encourage more practice in ${weak}.`,
  (n) => `A consistent month for ${n}. Encourage twenty minutes of reading at home every day.`,
  (n, weak) => `${n} is cheerful and helpful in class. Focus on neat presentation and on ${weak} exercises.`,
];

const EVENTS = {
  '2026-04': [['Welcome assembly', ['Participated']]],
  '2026-07': [['Van Mahotsav tree planting', ['Participated']]],
  '2026-08': [
    ['Independence Day programme', ['Performed', 'Participated']],
    ['Inter-class quiz', ['Participated', 'Participated', 'Runner-up']],
  ],
  '2026-09': [
    ['Inter-house football', ['Participated', 'Participated', 'Winner']],
    ['Science exhibition', ['Participated', 'Participated', 'Second prize']],
  ],
};

// Deterministic random numbers so every reset produces the same demo data.
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const between = (rand, lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

function generatedReports(name, index) {
  const rand = random(index * 7919 + 17);
  const ability = 62 + Math.round(rand() * 28);
  const offsets = config.subjects.map(() => Math.round(rand() * 14 - 7));
  const first = name.split(' ')[0];
  return Object.fromEntries(
    MONTHS.map((month, mi) => {
      const marks = offsets.map((o) => clamp(Math.round(ability + o + mi * 1.5 + rand() * 6 - 3), 35, 99));
      const weak = config.subjects[marks.indexOf(Math.min(...marks))];
      const activities = [];
      for (const [event, results] of EVENTS[month]) {
        if (rand() < 0.75) activities.push([event, pick(rand, results)]);
      }
      activities.push(['Homework completed', `${15 + Math.floor(rand() * 6)} / 20`]);
      return [month, { present: SCHOOL_DAYS[month] - Math.floor(rand() * 4), marks, remarks: pick(rand, REMARKS)(first, weak), activities }];
    }),
  );
}

const statements = new Map();
const stmt = (sql) => {
  if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
  return statements.get(sql);
};

function insertReport(studentId, month, report, status) {
  const updatedAt = status === 'published' ? PUBLISHED_AT[month] : '2026-09-23T09:00:00.000Z';
  const id = Number(
    stmt(
      `INSERT INTO progress_reports (student_id, month, days_present, school_days, remarks, status, updated_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(studentId, month, report.present, SCHOOL_DAYS[month], report.remarks, status, updatedAt, status === 'published' ? updatedAt : null)
      .lastInsertRowid,
  );
  config.subjects.forEach((subject, i) =>
    stmt('INSERT INTO progress_marks (report_id, subject, score) VALUES (?, ?, ?)').run(id, subject, report.marks[i]),
  );
  report.activities.forEach(([name, result], i) =>
    stmt('INSERT INTO progress_activities (report_id, position, name, result) VALUES (?, ?, ?, ?)').run(id, i, name, result),
  );
}

// ---- Students ----------------------------------------------------------------------------

function buildRoster() {
  const rand = random(20260401);
  const usedPhones = new Set([DEMO.parentPhone, DEMO.siblingsPhone]);
  const phone = () => {
    for (;;) {
      const candidate = `${pick(rand, ['9', '9', '8', '7'])}${String(between(rand, 0, 999_999_999)).padStart(9, '0')}`;
      if (!usedPhones.has(candidate)) {
        usedPhones.add(candidate);
        return candidate;
      }
    }
  };

  const roster = [];
  for (const [grade, sections] of Object.entries(SECTIONS)) {
    for (const section of sections) {
      const fixed = MOCKUP_STUDENTS.filter((s) => s[0] === grade && s[1] === section);
      const size = grade === 'Class 6' && section === 'B' ? 24 : between(rand, 14, 22);
      const generated = [];
      for (let i = fixed.length; i < size; i++) {
        const girl = rand() < 0.48;
        const surname = pick(rand, SURNAMES);
        let name;
        do name = `${pick(rand, girl ? GIRLS : BOYS)} ${surname}`;
        while (MOCKUP_NAMES.has(name) || generated.some((g) => g.name === name));
        generated.push({
          name,
          gender: girl ? 'Female' : 'Male',
          father: `${pick(rand, FATHERS)} ${surname}`,
          mother: `${pick(rand, MOTHERS)} ${surname}`,
          bus: rand() < 0.55,
          phone: phone(),
        });
      }
      generated.sort((a, b) => a.name.localeCompare(b.name));

      // Roll numbers follow the alphabet, keeping the mockup students' numbers.
      const taken = new Set(fixed.map((s) => s[2]));
      let roll = 1;
      const nextRoll = () => {
        while (taken.has(roll)) roll += 1;
        taken.add(roll);
        return roll;
      };
      for (const s of fixed) {
        roster.push({ grade, section, roll: s[2], name: s[3], gender: GENDER_OF[s[3]] ?? 'Male', father: s[4], mother: s[5], bus: s[6], phone: s[7] ?? phone() });
      }
      for (const g of generated) roster.push({ grade, section, roll: nextRoll(), ...g });
    }
  }
  return roster;
}

// ---- Fees and payments ------------------------------------------------------------------

const istTime = (date, hour, minute) => new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+05:30`).toISOString();

function datesBetween(from, to) {
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

// Mockup families whose Term 2 fees are already paid; the rest of the mockup
// students still owe Term 2 (as in the mockups' "6 families" banner).
const MOCKUP_PAID_TERM_2 = new Set(['Aanya Gupta', 'Kavya Reddy']);

export function seed() {
  statements.clear();
  const rand = random(7);
  const today = todayIso();
  const now = Date.now();
  // Term 2 payments from early September up to today (some after the due date).
  const term2Days = today >= '2026-09-05' ? datesBetween('2026-09-05', today) : [];

  transaction(() => {
    for (const s of STAFF) {
      db.prepare('INSERT INTO staff (email, name, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, 1, ?)').run(
        s.email,
        s.name,
        hashPassword(s.password),
        s.role,
        '2026-04-01T04:00:00.000Z',
      );
    }
    const staffNames = STAFF.map((s) => s.name);

    for (const [grade, sections] of Object.entries(SECTIONS)) for (const section of sections) ensureClass(grade, section);

    // Fee structure: one set per class, plus the school-wide admission fee.
    const typeId = (name) => db.prepare('SELECT id FROM fee_types WHERE name = ?').get(name).id;
    for (const grade of GRADES) {
      for (const f of feeStructuresFor(grade)) {
        createStructure({ ...f, feeTypeId: typeId(f.feeType), grade, session: '2026-27' }, { applyToExisting: false });
      }
    }
    createStructure(
      { feeTypeId: typeId('Admission Fee'), name: 'Admission Fee', amount: 5000, frequency: 'One-Time', firstDueDate: '2026-04-01', session: '2026-27', newAdmissionsOnly: true },
      { applyToExisting: false },
    );

    const payments = [];
    let admissionSeq = 100;
    buildRoster().forEach((s, index) => {
      const gradeIndex = GRADES.indexOf(s.grade);
      admissionSeq += 1;
      const admissionYear = Math.min(2026, 2026 - gradeIndex + Math.floor(rand() * 3));
      const classId = ensureClass(s.grade, s.section);
      const village = pick(rand, VILLAGES);
      const studentId = Number(
        stmt(
          `INSERT INTO students (name, class_id, roll_no, admission_no, parent_name, father_name, mother_name, parent_phone,
             alt_phone, dob, gender, address, session, admission_date, transport, bus_route, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          s.name, classId, s.roll, `KBS/${admissionYear}/${String(admissionSeq).padStart(4, '0')}`, s.father, s.father, s.mother, s.phone,
          rand() < 0.4 ? `9${String(between(rand, 100000000, 999999999))}` : null,
          `${2022 - gradeIndex}-${String(between(rand, 1, 12)).padStart(2, '0')}-${String(between(rand, 1, 28)).padStart(2, '0')}`,
          s.gender,
          `Village ${village}, Tehsil Shahpur, District Kangra, H.P.`,
          '2026-27',
          `${admissionYear}-04-01`,
          s.bus ? 1 : 0,
          s.bus ? pick(rand, BUS_ROUTES) : '',
          '2026-04-01T04:00:00.000Z',
        ).lastInsertRowid,
      );
      syncStudentAccount(studentId);

      // Progress reports for Class 1 to 12.
      if (gradeIndex >= 3) {
        const reports = s.name === 'Aarav Sharma' ? AARAV : generatedReports(s.name, index);
        for (const month of MONTHS) {
          let status = 'published';
          if (month === '2026-09') {
            status = MOCKUP_NAMES.has(s.name) ? SEPTEMBER[s.name] : s.grade === 'Class 6' && s.section === 'B' ? null : rand() < 0.3 ? 'published' : null;
          }
          if (status) insertReport(studentId, month, reports[month], status);
        }
      }

      // The fee account was generated from the fee structure; pick out the instalments.
      const items = db
        .prepare('SELECT f.id, f.period, fs.name FROM fee_items f JOIN fee_structures fs ON fs.id = f.structure_id WHERE f.student_id = ?')
        .all(studentId);
      const item = (name, period = '2026-27') => items.find((i) => i.name === name && i.period === period)?.id ?? null;
      const annual = item('Annual Charges');
      const tuition1 = item('Tuition Fee', 'Term 1');
      const transport1 = item('Transport Fee', 'Jul–Sep');
      const tuition2 = item('Tuition Fee', 'Term 2');
      const transport2 = item('Transport Fee', 'Oct–Dec');
      const exam = item('Board Exam Fee');

      const plan = (items, at, channel, method, collector) => payments.push({ studentId, items: items.filter(Boolean), at, channel, method, collector });
      const onlineMethod = () => pick(rand, ['UPI', 'UPI', 'UPI', 'UPI', 'Card', 'Net banking']);
      const counterMethod = () => pick(rand, ['Cash', 'Cash', 'Cash', 'Cheque', 'UPI']);
      const payNormally = (items, date, { online = rand() < 0.6 } = {}) => {
        const hour = online ? between(rand, 7, 21) : between(rand, 9, 15);
        plan(items, istTime(date, hour, between(rand, 0, 59)), online ? 'online' : 'counter', online ? onlineMethod() : counterMethod(), online ? null : pick(rand, staffNames));
      };

      if (s.name === 'Aarav Sharma') {
        // Exactly as in the mockups' payment history.
        plan([annual], '2026-04-02T05:10:00.000Z', 'online', 'Card');
        plan([transport1], '2026-07-08T06:20:00.000Z', 'online', 'UPI');
        plan([tuition1], '2026-07-08T06:24:00.000Z', 'online', 'UPI');
        return;
      }
      if (rand() < 0.97 || MOCKUP_NAMES.has(s.name)) payNormally([annual], `2026-04-${String(between(rand, 1, 15)).padStart(2, '0')}`);
      if (rand() < 0.93 || MOCKUP_NAMES.has(s.name)) payNormally([tuition1, transport1], `2026-07-${String(between(rand, 1, 15)).padStart(2, '0')}`);

      const paysTerm2 = MOCKUP_NAMES.has(s.name) ? MOCKUP_PAID_TERM_2.has(s.name) : rand() < 0.38;
      if (paysTerm2 && term2Days.length) {
        const date = pick(rand, term2Days);
        const items = [tuition2, transport2, exam && rand() < 0.6 ? exam : null];
        if (date === today) {
          // Payments earlier today, so today's collection is not empty.
          const minutesAgo = between(rand, 10, 300);
          const at = new Date(Math.max(now - minutesAgo * 60_000, Date.parse(`${today}T00:05:00+05:30`))).toISOString();
          const online = rand() < 0.5;
          plan(items, at, online ? 'online' : 'counter', online ? onlineMethod() : counterMethod(), online ? null : STAFF[1].name);
        } else {
          payNormally(items, date);
        }
      }
    });

    // Record payments in date order so receipt numbers run chronologically.
    payments.sort((a, b) => a.at.localeCompare(b.at));
    let seq = 0;
    for (const p of payments) {
      seq += 1;
      const amount = p.items.reduce((t, id) => t + stmt('SELECT amount FROM fee_items WHERE id = ?').get(id).amount, 0);
      const online = p.channel === 'online';
      const orderId = insertOrder({
        studentId: p.studentId,
        amount,
        feeItemIds: p.items,
        channel: p.channel,
        gatewayName: online ? 'test' : 'counter',
        gatewayOrderId: online ? `order_seed${String(seq).padStart(9, '0')}` : null,
        createdBy: online ? 'parent' : 'staff',
        createdAt: p.at,
      });
      const reference = online
        ? `pay_seed${String(seq).padStart(10, '0')}`
        : p.method === 'Cash'
          ? `KBS-C-${String(seq).padStart(8, '0')}`
          : p.method === 'Cheque'
            ? `CHQ ${between(rand, 100000, 999999)}`
            : `UPI ${between(rand, 100000000000, 999999999999)}`;
      confirmOrderTx(orderId, {
        gatewayPaymentId: online ? reference : null,
        txnId: reference,
        method: p.method,
        paidAt: p.at,
        via: 'import',
        collectedBy: online ? 'Online (Test gateway)' : p.collector,
        silent: true,
      });
    }

    // A few unfinished online payments, so every status appears in the history.
    const unpaid = db
      .prepare(
        `SELECT s.id AS student_id, SUM(f.amount) AS amount, json_group_array(f.id) AS ids
         FROM fee_items f JOIN students s ON s.id = f.student_id
         WHERE f.payment_id IS NULL AND f.due_date = '2026-10-10' AND s.parent_phone NOT IN (?, ?)
         GROUP BY s.id ORDER BY s.id LIMIT 5`,
      )
      .all(DEMO.parentPhone, DEMO.siblingsPhone);
    unpaid.forEach((u, i) => {
      const failed = i < 3;
      // Failed attempts over the last few days; two checkouts left open in the last hour.
      const minutesAgo = failed ? (i + 1) * 26 * 60 : 20 + i * 25;
      const created = new Date(now - minutesAgo * 60_000).toISOString();
      const orderId = insertOrder({
        studentId: u.student_id,
        amount: u.amount,
        feeItemIds: JSON.parse(u.ids),
        channel: 'online',
        gatewayName: 'test',
        gatewayOrderId: `order_seedopen${i}`,
        status: failed ? 'failed' : 'created',
        createdBy: 'parent',
        createdAt: created,
      });
      if (failed) db.prepare('UPDATE payment_orders SET failure_reason = ? WHERE id = ?').run('The bank declined this payment.', orderId);
    });

    db.prepare('INSERT INTO notices (title, body, class_id, created_at) VALUES (?, ?, NULL, ?)').run(
      'School closed on Friday, 2 Oct for Gandhi Jayanti',
      'Classes resume on Saturday, 3 October at the usual time.',
      '2026-09-18T04:30:00.000Z',
    );
  });
  statements.clear();
  seedAcademics();
}

// ---- Teachers, timetable and attendance (demo) ---------------------------------------------

const TEACHERS = [
  // [name, designation, main subject, class teacher of, email]
  ['Meena Sharma', 'TGT Maths', 'Maths', '6-B', DEMO.teacherEmail],
  ['Rajesh Kumar', 'TGT English', 'English', '6-A', 'rajesh.kumar@kbs.test'],
  ['Pooja Thakur', 'TGT Hindi', 'Hindi', '7-A', 'pooja.thakur@kbs.test'],
  ['Vikram Rana', 'TGT Science', 'Science', '8-A', 'vikram.rana@kbs.test'],
  ['Sunil Katoch', 'TGT Social Studies', 'Social Studies', null, 'sunil.katoch@kbs.test'],
  ['Anita Guleria', 'Computer Teacher', 'Computer Science', null, 'anita.guleria@kbs.test'],
  ['Harish Chand', 'PET', 'Physical Education', null, 'harish.chand@kbs.test'],
];
const OTHER_STAFF = [
  ['Ramesh Lal', 'Bus Driver (Route 1 – Shahpur)', '9418012345'],
  ['Kamla Devi', 'Attendant', '9418023456'],
  ['Prem Singh', 'Peon', '9418034567'],
];
// Each class's periods rotate through these subjects; classes are offset so no teacher is double-booked.
const ROTATION = ['Maths', 'English', 'Hindi', 'Science', 'Social Studies', 'Computer Science', 'Physical Education', 'Sanskrit'];
const SUBJECT_TEACHER = { Sanskrit: 'Pooja Thakur' };

export function seedAcademics() {
  if (db.prepare("SELECT 1 FROM staff WHERE role = 'teacher' LIMIT 1").get()) return;
  const rand = random(11);
  const classId = (name) => db.prepare('SELECT id FROM classes WHERE name = ?').get(name)?.id;
  transaction(() => {
    const ids = {};
    for (const [name, designation, , , email] of TEACHERS) {
      const password = email === DEMO.teacherEmail ? DEMO.teacherPassword : `kbs-${Math.floor(rand() * 1e9)}`;
      ids[name] = Number(
        db
          .prepare("INSERT INTO staff (email, name, password_hash, role, active, created_at, designation, phone, joined_on) VALUES (?, ?, ?, 'teacher', 1, ?, ?, ?, ?)")
          .run(email, name, hashPassword(password), '2026-04-01T04:00:00.000Z', designation, `94180${String(between(rand, 10000, 99999))}`, `20${between(rand, 10, 24)}-04-01`).lastInsertRowid,
      );
    }
    for (const [name, designation, phone] of OTHER_STAFF) {
      db.prepare("INSERT INTO staff (email, name, password_hash, role, active, created_at, designation, phone) VALUES (NULL, ?, NULL, 'staff', 1, ?, ?, ?)").run(
        name,
        '2026-04-01T04:00:00.000Z',
        designation,
        phone,
      );
    }
    for (const [name, , , classTeacherOf] of TEACHERS) {
      if (classTeacherOf && classId(classTeacherOf)) assignClasses(ids[name], [{ classId: classId(classTeacherOf), classTeacher: true }]);
    }

    // Timetable for Classes 6 to 8.
    const subjectId = (name) => db.prepare('SELECT id FROM subjects WHERE name = ?').get(name)?.id;
    const teacherFor = (subject) => ids[SUBJECT_TEACHER[subject] ?? TEACHERS.find((t) => t[2] === subject)?.[0]];
    ['6-A', '6-B', '7-A', '8-A'].forEach((name, c) => {
      const id = classId(name);
      if (!id) return;
      for (let day = 1; day <= 6; day += 1) {
        for (let period = 1; period <= 8; period += 1) {
          const subject = ROTATION[(period - 1 + day + 2 * c) % ROTATION.length];
          setTimetableCell(id, day, period, { subjectId: subjectId(subject), teacherId: teacherFor(subject) });
        }
      }
    });

    // Three weeks of attendance (Sundays and 2 Oct off). Today: every class
    // except 6-B, which the demo teacher marks.
    const today = todayIso();
    const start = new Date(Date.parse(`${today}T00:00:00Z`) - 21 * 86_400_000).toISOString().slice(0, 10);
    const days = datesBetween(start < '2026-04-01' ? '2026-04-01' : start, today).filter(
      (d) => new Date(`${d}T00:00:00Z`).getUTCDay() !== 0 && d !== '2026-10-02',
    );
    const students = db.prepare('SELECT s.id, s.class_id, c.name AS class_name FROM students s JOIN classes c ON c.id = s.class_id WHERE s.active = 1').all();
    const mark = db.prepare('INSERT OR IGNORE INTO attendance (student_id, date, class_id, status, marked_by, marked_at) VALUES (?, ?, ?, ?, ?, ?)');
    const admin = db.prepare("SELECT id FROM staff WHERE role = 'admin' ORDER BY id LIMIT 1").get()?.id ?? null;
    for (const date of days) {
      for (const st of students) {
        if (date === today && st.class_name === '6-B') continue;
        const r = rand();
        const status = r < 0.92 ? 'present' : r < 0.96 ? 'absent' : r < 0.98 ? 'late' : 'leave';
        mark.run(st.id, date, st.class_id, status, admin, `${date}T03:45:00.000Z`);
      }
    }

    // Aarav's parent can also log in with a PIN.
    const now = new Date().toISOString();
    db.prepare('INSERT OR IGNORE INTO parent_accounts (phone, pin_hash, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
      DEMO.parentPhone,
      hashPassword(DEMO.parentPin),
      now,
      now,
    );
  });
}

// `npm run reset` wipes the database and loads fresh demo data.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--reset')) {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.dbFile + suffix, { force: true });
  }
  openDatabase(config.dbFile);
  if (isEmpty()) {
    const started = Date.now();
    seed();
    console.log(`Demo data for ${config.school.shortName} loaded into ${config.dbFile} (${Date.now() - started} ms).`);
  } else {
    console.log('The database already has data. Run `npm run reset` to start over.');
  }
  closeDatabase();
}
