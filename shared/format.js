// Formatting helpers shared by the server and both browser apps.
// Everything is shown in Indian Standard Time, whatever the device clock says.

export const TIME_ZONE = 'Asia/Kolkata';
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const inr = new Intl.NumberFormat('en-IN');
const pad = (n) => String(n).padStart(2, '0');

export function rupees(amount) {
  return '₹' + inr.format(amount);
}

// Month keys look like "2026-09".
export function parseMonth(key) {
  const [year, month] = key.split('-').map(Number);
  return { year, month };
}

export function monthKey(year, month) {
  return `${year}-${pad(month)}`;
}

export function addMonths(key, count) {
  const { year, month } = parseMonth(key);
  const index = year * 12 + (month - 1) + count;
  return monthKey(Math.floor(index / 12), (index % 12) + 1);
}

export function academicMonths(startKey) {
  return Array.from({ length: 12 }, (_, i) => addMonths(startKey, i));
}

export const monthShort = (key) => MONTHS[parseMonth(key).month - 1];
export const monthLong = (key) => MONTHS_LONG[parseMonth(key).month - 1];
export const monthLongYear = (key) => `${monthLong(key)} ${parseMonth(key).year}`;

// Collapses month keys into readable runs: ["2026-05","2026-06"] -> "May–Jun".
export function monthRanges(keys) {
  const runs = [];
  for (const key of [...keys].sort()) {
    const run = runs.at(-1);
    if (run && addMonths(run.at(-1), 1) === key) run.push(key);
    else runs.push([key]);
  }
  return runs
    .map((run) => (run.length === 1 ? monthShort(run[0]) : `${monthShort(run[0])}–${monthShort(run.at(-1))}`))
    .join(', ');
}

const istFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hourCycle: 'h23',
});

function istParts(date) {
  const parts = istFormat.formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

export function todayIso(now = new Date()) {
  const p = istParts(now);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function currentMonthKey(now = new Date()) {
  return todayIso(now).slice(0, 7);
}

export function hourNow(now = new Date()) {
  return istParts(now).hour;
}

// Accepts a calendar date ("2026-10-10") or a timestamp ("2026-09-23T11:02:00.000Z").
export function formatDate(value, { year = true } = {}) {
  const p = value.length === 10 ? parseCalendarDate(value) : istParts(new Date(value));
  return `${p.day} ${MONTHS[p.month - 1]}${year ? ` ${p.year}` : ''}`;
}

export function formatDateTime(value) {
  const p = istParts(new Date(value));
  const hour = p.hour % 12 || 12;
  return `${p.day} ${MONTHS[p.month - 1]} ${p.year}, ${hour}:${pad(p.minute)} ${p.hour < 12 ? 'am' : 'pm'}`;
}

function parseCalendarDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  return { year, month, day };
}

export function formatPhone(phone) {
  return phone.length === 10 ? `${phone.slice(0, 5)} ${phone.slice(5)}` : phone;
}

export function initials(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('');
}

export const firstName = (name) => name.split(/\s+/)[0];
export const possessive = (name) => (name.endsWith('s') ? `${name}’` : `${name}’s`);

export function greeting(hour) {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export function formatTime(value) {
  const p = istParts(new Date(value));
  return `${p.hour % 12 || 12}:${pad(p.minute)} ${p.hour < 12 ? 'am' : 'pm'}`;
}

// Calendar date in India for a timestamp: "2026-09-29".
export function istDate(value) {
  return todayIso(new Date(value));
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n) {
  return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
}

function belowThousand(n) {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return [hundreds ? `${ONES[hundreds]} Hundred` : '', rest ? belowHundred(rest) : ''].filter(Boolean).join(' ');
}

// Indian numbering, as printed on receipts: 15500 -> "Rupees Fifteen Thousand Five Hundred Only".
export function amountInWords(amount) {
  let n = Math.floor(Math.abs(amount));
  if (n === 0) return 'Rupees Zero Only';
  const parts = [];
  const crore = Math.floor(n / 10_000_000);
  n %= 10_000_000;
  const lakh = Math.floor(n / 100_000);
  n %= 100_000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  if (crore) parts.push(`${belowThousand(crore)} Crore`);
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (n) parts.push(belowThousand(n));
  return `Rupees ${parts.join(' ')} Only`;
}
