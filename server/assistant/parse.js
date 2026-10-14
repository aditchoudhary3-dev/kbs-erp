import { config } from '../config.js';
import { GRADES } from '../../shared/school.js';
import { addMonths, currentMonthKey, MONTHS_LONG, todayIso } from '../../shared/format.js';

// Small, predictable readers for the words staff use in questions:
// classes ("Class 8", "8-B", "class viii"), dates ("today", "last month",
// "25 Sep"), payment modes, amounts ("₹5,000", "5k"), receipt numbers and
// student names. Used by the built-in assistant and to clean tool inputs.

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 };
const WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
};
const NUMBER = '(\\d{1,2}|xii|xi|x|ix|viii|vii|vi|iv|v|iii|ii|i|twelfth|eleventh|tenth|ninth|eighth|seventh|sixth|fifth|fourth|third|second|first|twelve|eleven|ten|nine|eight|seven|six|five|four|three|two|one)';

function gradeFromNumber(token) {
  const t = String(token).toLowerCase();
  const n = /^\d+$/.test(t) ? Number(t) : ROMAN[t] ?? WORDS[t];
  return n >= 1 && n <= 12 ? `Class ${n}` : null;
}

// A class name in any common form, or null. Used to clean tool inputs.
export function toGrade(value) {
  if (value === null || value === undefined || value === '') return null;
  const v = String(value).trim().toLowerCase().replace(/^(class|grade|std\.?|standard)\s*/, '').replace(/(st|nd|rd|th)$/, '');
  if (v === 'nursery') return 'Nursery';
  if (v === 'lkg') return 'LKG';
  if (v === 'ukg') return 'UKG';
  if (v === 'all' || v === 'all classes') return null;
  return gradeFromNumber(v) ?? GRADES.find((g) => g.toLowerCase() === String(value).trim().toLowerCase()) ?? null;
}

// { grade, section } mentioned in a sentence, or null.
export function findGrade(text) {
  const t = ` ${String(text).toLowerCase()} `;
  const sectionAfter = '(?:\\s*-\\s*|\\s+section\\s+|\\s+)([a-d])\\b';
  let m = new RegExp(`\\b(nursery|lkg|ukg)\\b(?:${sectionAfter})?`).exec(t);
  if (m) return { grade: toGrade(m[1]), section: m[2]?.toUpperCase() ?? '' };
  m = new RegExp(`\\b(?:class|grade|std\\.?|standard)\\s*-?\\s*${NUMBER}(?:st|nd|rd|th)?\\b(?:${sectionAfter})?`).exec(t);
  if (m && gradeFromNumber(m[1])) return { grade: gradeFromNumber(m[1]), section: m[2]?.toUpperCase() ?? '' };
  m = /\b(\d{1,2})(?:st|nd|rd|th)\s+(?:class|grade|std)\b/.exec(t);
  if (m && gradeFromNumber(m[1])) return { grade: gradeFromNumber(m[1]), section: '' };
  m = /(?:^|\s)(\d{1,2})\s*-\s*([a-d])\b/.exec(t);
  if (m && gradeFromNumber(m[1])) return { grade: gradeFromNumber(m[1]), section: m[2].toUpperCase() };
  return null;
}

export const findSection = (text) => /\bsection\s+([a-d])\b/i.exec(text)?.[1]?.toUpperCase() ?? '';

// ---- Dates -------------------------------------------------------------------------

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const shift = (date, days) => iso(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000);
const weekday = (date) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
const MONTH_RE = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const monthIndex = (name) => ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(name.slice(0, 3).toLowerCase());
const sessionStart = () => `${config.academicYear.start}-01`;

// A date without a year is the most recent one (payments are in the past).
function dayMonth(day, month, year, today) {
  const d = Number(day);
  if (d < 1 || d > 31 || month < 0 || month > 11) return null;
  const pad = (n) => String(n).padStart(2, '0');
  let y = year ? Number(year.length === 2 ? `20${year}` : year) : Number(today.slice(0, 4));
  let date = `${y}-${pad(month + 1)}-${pad(d)}`;
  if (!year && date > today) date = `${y - 1}-${pad(month + 1)}-${pad(d)}`;
  return Number.isNaN(Date.parse(date)) ? null : date;
}

// All the single dates in a sentence, in order.
export function findDates(text, today = todayIso()) {
  const t = String(text).toLowerCase();
  const found = [];
  const add = (index, date) => date && found.push({ index, date });
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(m.index, `${m[1]}-${m[2]}-${m[3]}`);
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?(${MONTH_RE})\\b\\.?(?:,?\\s*(\\d{4}))?`, 'g'))) add(m.index, dayMonth(m[1], monthIndex(m[2]), m[3], today));
  for (const m of t.matchAll(new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s*(\\d{4}))?`, 'g'))) add(m.index, dayMonth(m[2], monthIndex(m[1]), m[3], today));
  for (const m of t.matchAll(/\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/g)) add(m.index, dayMonth(m[1], Number(m[2]) - 1, m[3], today));
  return found.sort((a, b) => a.index - b.index).map((f) => f.date);
}

const RANGE_LABELS = {
  today: 'today',
  yesterday: 'yesterday',
  this_week: 'this week',
  last_week: 'last week',
  this_month: 'this month',
  last_month: 'last month',
  this_session: `this session (${config.academicYear.label})`,
};
export const PERIODS = Object.keys(RANGE_LABELS);

export function periodRange(period, today = todayIso()) {
  const range = rangeFor(period, today);
  return range ? { ...range, period } : null;
}

function rangeFor(period, today) {
  const month = today.slice(0, 7);
  switch (period) {
    case 'today':
      return { from: today, to: today, label: RANGE_LABELS.today };
    case 'yesterday':
      return { from: shift(today, -1), to: shift(today, -1), label: RANGE_LABELS.yesterday };
    case 'this_week':
      return { from: shift(today, -weekday(today)), to: today, label: RANGE_LABELS.this_week };
    case 'last_week': {
      const monday = shift(today, -weekday(today) - 7);
      return { from: monday, to: shift(monday, 6), label: RANGE_LABELS.last_week };
    }
    case 'this_month':
      return { from: `${month}-01`, to: today, label: RANGE_LABELS.this_month };
    case 'last_month': {
      const key = addMonths(month, -1);
      return { from: `${key}-01`, to: shift(`${month}-01`, -1), label: RANGE_LABELS.last_month };
    }
    case 'this_session':
      return { from: sessionStart(), to: today, label: RANGE_LABELS.this_session };
    default:
      return null;
  }
}

export function monthRange(key, today = todayIso()) {
  const end = shift(`${addMonths(key, 1)}-01`, -1);
  const [y, m] = key.split('-').map(Number);
  return { from: `${key}-01`, to: end < today ? end : today, label: `${MONTHS_LONG[m - 1]} ${y}`, month: key };
}

const formatDay = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  return `${d} ${MONTHS_LONG[m - 1].slice(0, 3)} ${y}`;
};

// The period a sentence talks about: { from, to, label }, or null.
export function findRange(text, today = todayIso()) {
  const t = String(text).toLowerCase();
  if (/\bday before yesterday\b/.test(t)) {
    const d = shift(today, -2);
    return { from: d, to: d, label: formatDay(d) };
  }
  const last = /\b(?:last|past|previous)\s+(\d{1,3})\s+days?\b/.exec(t);
  if (last) return { from: shift(today, -(Number(last[1]) - 1)), to: today, label: `the last ${last[1]} days` };
  const dates = findDates(t, today);
  if (dates.length >= 2 && /\b(from|between|to|till|until|and)\b/.test(t)) {
    const [a, b] = dates[0] <= dates[1] ? [dates[0], dates[1]] : [dates[1], dates[0]];
    return { from: a, to: b, label: `${formatDay(a)} to ${formatDay(b)}` };
  }
  if (dates.length) return { from: dates[0], to: dates[0], label: formatDay(dates[0]) };
  if (/\b(today|today's|todays|tonight|so far today)\b/.test(t)) return periodRange('today', today);
  if (/\byesterday\b/.test(t)) return periodRange('yesterday', today);
  if (/\b(this|current)\s+week\b|\bweek so far\b/.test(t)) return periodRange('this_week', today);
  if (/\b(last|previous|past)\s+week\b/.test(t)) return periodRange('last_week', today);
  if (/\b(last|previous|past)\s+month\b/.test(t)) return periodRange('last_month', today);
  if (/\b(this|current)\s+month\b|\bthis month's\b|\bmonth so far\b|\bmonth to date\b/.test(t)) return periodRange('this_month', today);
  if (/\b(this|current)\s+(session|year|academic year)\b|\bso far this year\b|\bsince april\b/.test(t)) return periodRange('this_session', today);
  const named = new RegExp(`\\b(?:in|for|during|of)\\s+(${MONTH_RE})\\b(?:\\s+(\\d{4}))?`).exec(t);
  if (named) {
    const index = monthIndex(named[1]);
    const startYear = Number(config.academicYear.start.slice(0, 4));
    const year = named[2] ? Number(named[2]) : index >= 3 ? startYear : startYear + 1;
    return monthRange(`${year}-${String(index + 1).padStart(2, '0')}`, today);
  }
  return null;
}

// The month (YYYY-MM) a sentence talks about, defaulting to this month.
export function findMonth(text, today = todayIso()) {
  const range = findRange(text, today);
  if (range?.month) return range.month;
  if (/\b(last|previous)\s+month\b/.test(String(text).toLowerCase())) return addMonths(currentMonthKey(), -1);
  if (/\bnext\s+month\b/.test(String(text).toLowerCase())) return addMonths(currentMonthKey(), 1);
  return currentMonthKey();
}

// ---- Payment modes, amounts, receipts ----------------------------------------------------

export const MODE_LABELS = { cash: 'cash', online: 'online', counter: 'at the counter', upi: 'UPI', cheque: 'cheque', card: 'card', bank_transfer: 'bank transfer' };
export const MODES = Object.keys(MODE_LABELS);

export function findMode(text) {
  const t = String(text).toLowerCase();
  if (/\bcash\b/.test(t)) return 'cash';
  if (/\bonline\b|\bgateway\b|\brazorpay\b/.test(t)) return 'online';
  if (/\bupi\b|\bgpay\b|\bphonepe\b|\bpaytm\b/.test(t)) return 'upi';
  if (/\bcheques?\b/.test(t)) return 'cheque';
  if (/\bbank transfer\b|\bneft\b|\brtgs\b|\bimps\b/.test(t)) return 'bank_transfer';
  if (/\b(debit |credit )?card\b/.test(t)) return 'card';
  if (/\bcounter\b|\boffice\b/.test(t)) return 'counter';
  return null;
}

// Payment-history filters for a mode.
export function modeFilter(mode) {
  return (
    {
      cash: { mode: 'Cash' },
      online: { channel: 'online' },
      counter: { channel: 'counter' },
      upi: { mode: 'UPI' },
      cheque: { mode: 'Cheque' },
      card: { mode: 'Card' },
      bank_transfer: { mode: 'Bank transfer' },
    }[mode] ?? {}
  );
}

export const COUNTER_MODE = { cash: 'Cash', upi: 'UPI', cheque: 'Cheque', card: 'Card', bank_transfer: 'Bank transfer' };

const MULTIPLIER = { k: 1000, thousand: 1000, lakh: 100_000, lac: 100_000, lakhs: 100_000 };
function toAmount(number, unit) {
  const value = Number(String(number).replace(/,/g, '')) * (MULTIPLIER[String(unit ?? '').toLowerCase()] ?? 1);
  return Number.isFinite(value) && value > 0 && Number.isInteger(value) ? value : null;
}

// A rupee amount: "₹5,000", "Rs 500", "5000 rupees", "5k". With `bare`,
// a plain number of 3 to 7 digits also counts (used when an amount is expected).
export function findAmount(text, { bare = false } = {}) {
  const t = String(text);
  let m = /(?:₹|\brs\.?|\binr)\s*([\d,]+(?:\.\d{1,2})?)\s*(k|thousand|lakhs?|lac)?\b/i.exec(t);
  if (m) return toAmount(m[1], m[2]);
  m = /\b([\d,]+(?:\.\d+)?)\s*(k|thousand|lakhs?|lac)?\s*(?:rupees|rs\b\.?|inr\b|\/-)/i.exec(t);
  if (m) return toAmount(m[1], m[2]);
  m = /\b(\d+(?:\.\d+)?)\s*(k|thousand|lakhs?|lac)\b/i.exec(t);
  if (m) return toAmount(m[1], m[2]);
  if (bare) {
    const cleaned = t.replace(/\b(?:class|grade|std|receipt(?:\s*(?:no\.?|number))?)\s*#?\s*\d+/gi, ' ');
    m = /(?:^|[^\d/-])(\d{1,3}(?:,\d{2,3})+|\d{2,7})(?![\d/-])/.exec(cleaned);
    if (m) return toAmount(m[1]);
  }
  return null;
}

export function findReceipt(text) {
  const t = String(text);
  let m = /\b([A-Z]{2,5}\/\d{4}-\d{2}\/\d{1,6})\b/i.exec(t);
  if (m) return m[1].toUpperCase();
  m = /\breceipt\s*(?:no\.?|number|num\.?|#)?\s*[:#-]?\s*([A-Z0-9/-]*\d[A-Z0-9/-]*)/i.exec(t);
  return m ? m[1].toUpperCase() : null;
}

// A payment reference: "ref 1234", "UTR 4829…", "cheque no 482913".
export function findReference(text) {
  const m = /\b(?:ref(?:erence)?|utr|txn(?:\s*id)?|transaction\s*id|cheque\s*(?:no\.?|number))\s*[:#-]?\s*([A-Z0-9][A-Z0-9/-]{3,39})/i.exec(String(text));
  return m ? m[1] : '';
}

export function findFrequency(text) {
  const t = String(text).toLowerCase();
  if (/\bhalf[- ]?yearly\b|\bsix[- ]monthly\b|\bsemi[- ]?annual\b|\bevery 6 months\b|\btwice a year\b/.test(t)) return 'Half-Yearly';
  if (/\bquarterly\b|\bevery (3|three) months\b|\bper quarter\b/.test(t)) return 'Quarterly';
  if (/\bmonthly\b|\bper month\b|\bevery month\b|\ba month\b/.test(t)) return 'Monthly';
  if (/\bone[- ]?time\b|\bonce\b/.test(t)) return 'One-Time';
  if (/\byearly\b|\bannual(ly)?\b|\bper year\b|\bevery year\b|\bonce a year\b/.test(t)) return 'Yearly';
  return null;
}

// ---- Fee types ---------------------------------------------------------------------------

const FEE_SYNONYMS = { tution: 'tuition', bus: 'transport', van: 'transport', exam: 'examination', exams: 'examination', board: 'board', computers: 'computer', annual: 'annual' };

// The existing fee type a sentence mentions ("tuition" → "Tuition Fee"), or null.
export function matchFeeType(text, feeTypes) {
  const words = new Set(String(text).toLowerCase().split(/[^a-z]+/).filter(Boolean).map((w) => FEE_SYNONYMS[w] ?? w));
  const lower = String(text).toLowerCase();
  const ranked = [...feeTypes].sort((a, b) => b.name.length - a.name.length);
  for (const type of ranked) if (lower.includes(type.name.toLowerCase())) return type.name;
  for (const type of ranked) {
    const key = type.name.toLowerCase().split(/\s+/)[0];
    if (words.has(key) || words.has(key.replace(/s$/, ''))) return type.name;
  }
  if (words.has('examination')) return ranked.find((t) => /exam/i.test(t.name))?.name ?? null;
  return null;
}

const NOT_A_FEE_NAME = new Set(['a', 'an', 'the', 'new', 'add', 'create', 'set', 'up', 'setup', 'make', 'monthly', 'quarterly', 'yearly', 'annual', 'half', 'one', 'time', 'class', 'for', 'of', 'all', 'classes', 'type', 'called', 'named', 'please', 'start', 'charging', 'charge', 'introduce']);

// The name of a fee in a sentence such as "add a library fee" → "Library Fee".
export function extractFeeName(text) {
  const quoted = /["“‘']([^"”’']{2,40})["”’']/.exec(text);
  if (quoted) return titleCase(quoted[1]);
  const named = /\b(?:called|named|name)\s+([a-z][a-z ]{1,38})$/i.exec(String(text).trim().replace(/[.?!]+$/, ''));
  if (named) return titleCase(named[1]);
  const m = /\b([a-z][a-z ]{1,40}?)\s+(fee|fees|charges)\b/i.exec(String(text).replace(/\b(?:class|grade)\s*\w+\b/gi, ' ').replace(/\s+/g, ' '));
  if (!m) return null;
  const words = m[1].split(/\s+/).filter((w) => !NOT_A_FEE_NAME.has(w.toLowerCase()));
  if (!words.length || words.length > 3) return null;
  return titleCase(`${words.join(' ')} ${m[2].toLowerCase() === 'charges' ? 'Charges' : 'Fee'}`);
}

export const titleCase = (text) =>
  String(text)
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b([a-z])([a-z]*)/gi, (_, a, b) => a.toUpperCase() + b.toLowerCase());

// ---- Student names -------------------------------------------------------------------------

const STOP = new Set(
  `a about after all also am amount amounts an and any are as at be been being bill by can check class classes collect collected collection
   could details detail did do does done due dues each fee fees fees' fee's find for from get give has have he her him his history how i
   in info information is it its kindly know let list look me month months much my need no not now number of on online or our paid parent
   parents pay payment payments pending please record records report search see section she show showing so status student students tell
   that the their them there these they this those to today total transaction transactions up upi us was we were what when where which who
   whom whose why will with would yet yesterday you your balance outstanding owe owes owing remaining left history receipts receipt cash
   cheque card mode modes received receive took take taken collecting recorded collects collections enter entry log for find locate lookup
   who's name named called mr mrs ms miss master kumari shri smt sir madam ji fee-wise hey hi hello rs inr rupees rupee generate export excel
   download overdue late fine dear kid child son daughter ward boy girl admission adm id stu which's whats what's grade std standard new
   week year session yearly monthly quarterly till until between since last previous past next current then than per
   ref reference utr txn no create add type make set setup want wants like should must just only every
   select choose pick open view
   failed failure successful unsuccessful declined cancelled canceled reversed stuck unfinished recent latest last first new old all`.split(/\s+/),
);

// The words in a question that could be a student's name (or an admission
// number / student ID), with everything else removed.
export function nameQuery(text, { feeTypes = [] } = {}) {
  const raw = String(text);
  const id = /\b(stu\d{1,6})\b/i.exec(raw) ?? /\b([a-z]{2,5}\/\d{4}\/\d{1,6})\b/i.exec(raw);
  if (id) return id[1].toUpperCase();
  const feeWords = new Set(feeTypes.flatMap((t) => t.name.toLowerCase().split(/\s+/)));
  const cleaned = raw
    .replace(/[’']s\b/gi, ' ')
    .replace(/(?:₹|\brs\.?|\binr)\s*[\d,]+/gi, ' ')
    .replace(new RegExp(`\\b(?:class|grade|std\\.?|standard)\\s*-?\\s*${NUMBER}(?:st|nd|rd|th)?\\b(?:\\s*-\\s*[a-d]\\b)?`, 'gi'), ' ')
    .replace(/\b(?:nursery|lkg|ukg)\b/gi, ' ')
    .replace(/\bsection\s+[a-d]\b/gi, ' ')
    .replace(new RegExp(`\\b(?:${MONTH_RE})\\b`, 'gi'), ' ')
    .replace(/\d+/g, ' ');
  const tokens = cleaned
    .split(/[^A-Za-zऀ-ॿ.-]+/)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((w) => w.length >= 2 && !STOP.has(w.toLowerCase()) && !feeWords.has(w.toLowerCase()) && !MODE_WORDS.has(w.toLowerCase()));
  return tokens.slice(0, 4).join(' ');
}
const MODE_WORDS = new Set(['cash', 'online', 'upi', 'gpay', 'phonepe', 'paytm', 'cheque', 'card', 'neft', 'rtgs', 'imps', 'bank', 'transfer', 'counter', 'office', 'gateway', 'razorpay']);
