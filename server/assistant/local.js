import { can } from '../permissions.js';
import {
  COUNTER_MODE,
  extractFeeName,
  findAmount,
  findFrequency,
  findGrade,
  findMode,
  findMonth,
  findRange,
  findReceipt,
  findReference,
  findSection,
  matchFeeType,
  nameQuery,
  titleCase,
} from './parse.js';

// The built-in assistant: reads a question with simple rules and turns it
// into one tool call (see tools.js). It never changes anything itself; it
// only reaches the same tools, with the same permission checks, as Claude.
//
// understand() returns one of:
//   { tool, args }                     run this tool
//   { reply: { text, cards }, followUp? }  answer directly (help, refusals, questions back)

const call = (tool, args = {}) => ({ tool, args: Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== '')) });
const answer = (text, extra = {}) => ({ reply: { text, cards: extra.cards ?? [] }, followUp: extra.followUp ?? null });
const ask = (text, followUp) => answer(text, { followUp });

// ---- Things the assistant will not do -------------------------------------------------

const REFUSALS = [
  {
    test: /\b(password|passcode|pass code|api[\s_-]?keys?|secrets?|tokens?|credentials?|env(ironment)?\s*(var(iable)?s?)?\b|\.env\b|connection string|database (url|file|path|login|user)|db (password|login|user)|webhook secret|private key|config(uration)? (file|values|settings))\b/,
    text: 'I can’t share passwords, API keys, tokens, settings or database details. I don’t have access to them, by design. If you have lost your own password, ask the school admin to reset it.',
  },
  {
    test: /\bselect\s+(\*|count\s*\()|\binsert\s+into\b|\bupdate\s+\w+\s+set\b|\bdelete\s+from\b|\b(drop|alter|truncate)\s+(table|database)\b|\bunion\s+select\b|;\s*--|\bsql(ite)?\b|\bdatabase quer(y|ies)\b/,
    text: 'I can’t run database commands. I can only answer from the school’s records through approved, read-only lookups, and prepare changes for you to confirm.',
  },
  {
    test: /\b(delete|remove|erase|wipe|purge|clear|undo|void)\b[\s\S]*\b(payments?|receipts?|transactions?|ledger|records?|history|entries|entry)\b/,
    text: 'Payments and receipts are never deleted. If a payment was recorded by mistake, open the receipt and choose Request correction. An admin approves it, the receipt is marked CANCELLED, and the original stays on record.',
  },
  {
    test: /\b(delete|remove)\b[\s\S]*\bstudents?\b/,
    text: 'Students are never deleted, so their payment history stays complete. An admin can deactivate a student from the student’s page.',
  },
  {
    test: /\bmark\b[\s\S]*\b(as )?paid\b|\bset\b[\s\S]*\bstatus\b|\bchange\b[\s\S]*\bstatus\b|\bmake\b[\s\S]*\bpaid\b/,
    text: 'I can’t mark fees or payments as paid. Online payments become PAID only after the payment gateway verifies them. If a parent paid at the counter, say for example “Record cash payment of ₹5,000 for <student>” and confirm it, so a proper receipt is issued.',
  },
  {
    test: /\b(change|edit|modify|update|alter|correct|fix|replace|reduce|increase)\b[\s\S]*\b(transaction id|txn|transactions?|receipts?|payment amount|amount paid|paid amount|payments?)\b/,
    text: 'Completed payments and receipts can’t be changed. If something is wrong, open the receipt and choose Request correction; an admin reviews it, and the original stays in the audit log.',
  },
  {
    test: /\b(add|create|delete|remove|change|edit|make|give|grant|reset)\b[\s\S]*\b(users?|admins?|staff accounts?|clerk accounts?|logins?|roles?|permissions?|access)\b/,
    text: 'I can’t manage staff accounts or permissions. An admin can do that on Users & Permissions.',
  },
];

function help(staff) {
  const lines = ['I can look things up in the school’s fee, attendance and student records, and prepare changes for you to confirm. Try:'];
  const examples = [
    ['payments.view', 'How much fee is pending for Rahul Verma?'],
    ['reports.view', 'Show Class 8 pending fees'],
    ['reports.view', 'How much cash was collected today?'],
    ['payments.view', 'Show online payments from yesterday'],
    ['payments.view', 'Find receipt number 25'],
    ['reports.view', 'Generate today’s fee collection report'],
    ['reports.view', 'Which students have not paid this month’s tuition fee?'],
    ['students.view', 'Find Pranav from class 8'],
    ['attendance.view', 'Who is absent today?'],
    ['payments.collect', 'Record cash payment of ₹5,000 for Aarav Sharma'],
    ['fees.manage', 'Create Class 8 monthly activity fee of ₹200'],
  ];
  for (const [permission, text] of examples) if (can(staff.role, permission)) lines.push(`• ${text}`);
  lines.push('Anything that changes records waits for you to press Confirm.');
  return lines.join('\n');
}

// ---- Answers to the assistant's own questions --------------------------------------------

const NEW_QUESTION = /\b(show|find|how|what|which|who|generate|report|export|list|pending|collected|collection|history|receipt|record|create|add)\b|\?/;

function fill(followUp, text) {
  const { tool, args, need } = followUp;
  if (need === 'amount') {
    const amount = findAmount(text, { bare: true });
    return amount ? call(tool, { ...args, amount }) : null;
  }
  if (need === 'frequency') {
    const frequency = findFrequency(text);
    return frequency ? call(tool, { ...args, frequency }) : null;
  }
  if (NEW_QUESTION.test(text.toLowerCase()) && text.split(/\s+/).length > 3) return null;
  if (need === 'reference') return call(tool, { ...args, reference: text.trim().slice(0, 40) });
  if (need === 'name') return call(tool, { ...args, name: titleCase(text.replace(/["“”]/g, '')).slice(0, 40) });
  if (need === 'student') return call(tool, { ...args, name: nameQuery(text) || text.trim().slice(0, 60) });
  return null;
}

// ---- Fee structure (admin) ----------------------------------------------------------------------

function feeStructureIntent(raw, t, feeTypes, grade) {
  const creating = /\b(add|create|new|set ?up|make|introduce|start charging|charge)\b/.test(t);
  if (/\bfee\s*types?\b|\btypes? of fees?\b|\bkinds? of fees?\b/.test(t)) {
    if (!creating) return call('list_fee_types');
    const name = extractFeeName(raw.replace(/\bfee\s*type\b/i, ''));
    return name
      ? call('propose_fee_type', { name })
      : ask('What should the new fee type be called? For example: Activity Fee.', { tool: 'propose_fee_type', args: {}, need: 'name' });
  }
  if (creating && /\b(fee|fees|charges?)\b/.test(t) && !/\b(payment|paid|receive|collect)\b/.test(t)) {
    const feeType = matchFeeType(t, feeTypes) ?? extractFeeName(raw);
    if (!feeType) return ask('Which fee should I set up? For example: “Create Class 8 monthly tuition fee of ₹2,000”.', null);
    const args = {
      feeType,
      grade: /\ball classes\b|\bevery class\b|\bwhole school\b/.test(t) ? undefined : grade?.grade,
      frequency: findFrequency(t),
      amount: findAmount(raw) ?? findAmount(raw.replace(/\blate fee.*$/i, ''), { bare: true }),
      lateFee: /\blate fee\b/.test(t) ? findAmount(raw.slice(t.indexOf('late fee')), { bare: true }) : undefined,
      compulsory: /\boptional\b/.test(t) ? false : undefined,
      transportOnly: /\btransport (students )?only\b|\bonly (for )?transport\b|\bbus students\b/.test(t) || undefined,
    };
    const due = /\bdue\b[\s\S]*/.exec(raw)?.[0];
    if (due) {
      const range = findRange(due);
      if (range && range.from === range.to) args.firstDueDate = range.from;
    }
    const where = args.grade ? `${args.grade} ` : '';
    if (!args.frequency) {
      return ask(`How often should ${where}${feeType} be charged: Monthly, Quarterly, Half-Yearly, Yearly or One-Time?`, { tool: 'propose_fee', args, need: 'frequency' });
    }
    if (!args.amount) {
      return ask(`What is the ${args.frequency.toLowerCase()} amount for ${where}${feeType}?`, { tool: 'propose_fee', args, need: 'amount' });
    }
    return call('propose_fee', args);
  }
  if (/\bfee structure\b|\bfees? (?:set ?up|setup)\b|\bwhat fees\b|\bfees? (?:for|of) (?:class|grade|nursery|lkg|ukg|all)\b/.test(t) && !/\b(pending|due|paid|collect)\b/.test(t)) {
    return call('fee_structure', { grade: grade?.grade });
  }
  return null;
}

// ---- Understanding a question ----------------------------------------------------------------------

export function understand(text, { staff, followUp = null, feeTypes = [] }) {
  const raw = String(text).trim();
  const t = raw.toLowerCase().replace(/[’‘`]/g, "'");

  if (followUp) {
    const filled = fill(followUp, raw);
    if (filled) return filled;
  }

  for (const refusal of REFUSALS) if (refusal.test.test(t)) return answer(refusal.text);

  if (/^(hi|hello|hey|namaste|good (morning|afternoon|evening))\b[\s!.]*$/.test(t) || /\b(help|what can you do|how do i use|examples?)\b/.test(t)) {
    return answer(help(staff));
  }
  if (/^(thanks|thank you|ok|okay|great|fine|done)\b/.test(t)) return answer('You’re welcome. Ask me anything else about fees, payments or students.');

  const grade = findGrade(raw);
  const section = grade?.section || findSection(raw);
  const range = findRange(t);
  const mode = findMode(t);
  const name = () => nameQuery(raw, { feeTypes });
  const period = range ? (range.period ? { period: range.period } : { from: range.from, to: range.to }) : {};

  // Receipts
  const receipt = findReceipt(raw);
  if (receipt) return call('find_receipt', { receiptNo: receipt });

  // Fee types and fees (admin; the tool checks permission)
  const fee = feeStructureIntent(raw, t, feeTypes, grade);
  if (fee) return fee;

  // Recording a counter payment: always a proposal to confirm.
  const amount = findAmount(raw);
  const recording = /\b(record|collect|receive|received|take|took|accept|enter|log|deposit(ed)?)\b/.test(t) || /\bpaid\b/.test(t);
  if (recording && !/\b(how much|total|report|not paid|unpaid|haven't|didn't|who has|which students)\b/.test(t) && (amount || /\b(record|collect|receive|accept|enter)\b[\s\S]*\b(payment|fee|fees|cash)\b/.test(t))) {
    const who = name();
    const args = {
      name: who || undefined,
      grade: grade?.grade,
      section,
      amount: amount ?? undefined,
      method: COUNTER_MODE[mode] ?? (mode === 'online' ? undefined : 'Cash'),
      reference: findReference(raw) || undefined,
      feeType: matchFeeType(t, feeTypes) ?? undefined,
    };
    if (mode === 'online') return answer('Online payments are recorded automatically when the payment gateway confirms them. I can only prepare payments received at the counter (cash, UPI, cheque, card or bank transfer).');
    if (!who) return ask('Which student is this payment for?', { tool: 'propose_cash_payment', args, need: 'student' });
    if (!amount) return ask(`How much did you receive for ${who}?`, { tool: 'propose_cash_payment', args, need: 'amount' });
    return call('propose_cash_payment', args);
  }

  // Reports with an Excel export
  if (/\b(report|export|excel|spreadsheet|download)\b/.test(t)) {
    const g = grade?.grade;
    if (/\b(not paid|unpaid|haven't paid|did not pay|didn't pay)\b/.test(t)) {
      const feeType = matchFeeType(t, feeTypes);
      if (feeType) return call('unpaid_fee', { feeType, month: findMonth(t), grade: g });
    }
    if (/\b(pending|dues?|outstanding|defaulters?|overdue|balance)\b/.test(t)) return call('run_report', { report: 'pending', grade: g, section });
    if (/\bmonthly\b|\bmonth[- ]?wise\b|\beach month\b|\bper month\b/.test(t) && !range) return call('run_report', { report: 'monthly' });
    if (/\bmodes?\b|\bcash vs\b|\bcash and online\b|\bonline vs\b/.test(t)) return call('run_report', { report: 'modes', ...period });
    if (/\bclass[- ]?wise\b/.test(t)) return call('run_report', { report: 'class-wise', ...period });
    if (g) return call('run_report', { report: 'class-fees', grade: g, section });
    if (/\bmonth\b/.test(t) && range) return call('run_report', { report: 'class-wise', ...period });
    return call('run_report', { report: 'daily', ...(range ? period : { period: 'today' }) });
  }

  // Cash vs online
  if (/\bcash\s*(vs\.?|versus|v\/s|and|or|against|compared (to|with))\s*online\b|\bonline\s*(vs\.?|versus|v\/s|and|or|against)\s*cash\b|\bpayment modes?\b|\bmode[- ]?wise\b/.test(t)) {
    if (range && !range.period) return call('run_report', { report: 'modes', ...period });
    return call('cash_vs_online', { period: range?.period });
  }

  // Attendance: who is absent, how many present
  if (/\b(absent|absentees|attendance|present today|on leave|who (is|was|were) (not )?(in school|present))\b/.test(t) && !/\b(fee|fees|paid|payment)\b/.test(t)) {
    const when = range?.period === 'yesterday' ? { period: 'yesterday' } : range && range.from === range.to && !range.period ? { date: range.from } : {};
    return call('attendance_day', { ...when, grade: grade?.grade, section });
  }

  // Who has not paid a particular fee
  if (/\b(not|never|yet to)\s+(been\s+)?paid\b|\bunpaid\b|\bdefaulters?\b|\bhaven't paid\b|\bhasn't paid\b|\bdid not pay\b|\bdidn't pay\b|\bnot pay\b/.test(t)) {
    const feeType = matchFeeType(t, feeTypes);
    if (feeType) return call('unpaid_fee', { feeType, month: findMonth(t), grade: grade?.grade });
    return call('pending_fees', { grade: grade?.grade, section });
  }

  // Pending fees: one student, or a class / the school
  if (/\b(pending|dues?|outstanding|balance|owe|owes|owing|arrears?|remaining|overdue)\b/.test(t)) {
    const who = name();
    if (who) return call('student_fees', { name: who, grade: grade?.grade, section });
    return call('pending_fees', { grade: grade?.grade, section, overdueOnly: /\boverdue\b|\blate\b/.test(t) || undefined });
  }

  // A student's payment history
  if (/\bhistory\b|\bpast payments\b|\ball payments (of|by|for)\b|\breceipts (of|for)\b|\bpaid so far\b/.test(t)) {
    const who = name();
    if (who) return call('student_payments', { name: who, grade: grade?.grade, section });
  }

  // Collection totals
  const totalQuestion = /\b(how much|total|sum|amount|figure)\b/.test(t);
  const moneyIn = /\b(collect|collected|collection|collections|received|receive|got|came|come in|earned|income|paid)\b/.test(t);
  if (totalQuestion && moneyIn) return call('collection_summary', { ...(range ? period : { period: 'today' }), mode: mode ?? undefined });

  // Lists of payments
  if (/\b(collection|collections|payments?|transactions?|receipts?)\b/.test(t)) {
    const who = name();
    if (who && !range && /\bpayments?\b|\breceipts?\b/.test(t)) return call('student_payments', { name: who, grade: grade?.grade, section });
    const status = /\bfailed\b|\bunsuccessful\b|\bdeclined\b/.test(t) ? 'FAILED' : /\bcancel(l)?ed\b|\breversed\b/.test(t) ? 'CANCELLED' : /\bpending\b|\bstuck\b|\bunfinished\b/.test(t) ? 'PENDING' : undefined;
    const fallback = status === 'FAILED' || status === 'PENDING' ? 'this_week' : 'today';
    return call('list_payments', { ...(range ? period : { period: fallback }), mode: mode ?? undefined, grade: grade?.grade, section, status });
  }

  // Overall position
  if (/\b(summary|overview|insights?|position|dashboard|status today|how (is|are) (it|we|things) going|anything wrong|issues?|problems?)\b/.test(t)) return call('daily_summary');

  // Finding a student
  const who = name();
  if (who && (/\b(find|search|look ?up|locate|who is|details?|info|profile|show)\b/.test(t) || who.split(' ').length <= 3)) {
    return call('find_students', { query: who, grade: grade?.grade, section });
  }
  if (grade) return call('run_report', { report: 'class-fees', grade: grade.grade, section });

  return answer(`I’m not sure what you mean. ${help(staff)}`);
}
