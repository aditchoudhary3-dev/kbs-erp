import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const env = process.env;

const razorpayConfigured = Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
const whatsappConfigured = Boolean(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID);

export const config = {
  port: Number(env.PORT) || 3000,
  // Use HOST=0.0.0.0 to open the app from a phone on the same Wi-Fi.
  host: env.HOST || '127.0.0.1',
  dbFile: env.DB_FILE || path.join(ROOT, 'data', 'schoolconnect.db'),

  // Public address of this server (e.g. https://fees.kbsschool.in). Used for
  // receipt links in WhatsApp messages. Leave empty when running locally.
  publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),

  // Demo mode shows login codes and demo accounts on screen instead of sending SMS.
  demoMode: env.DEMO_MODE !== 'off',

  // A new, empty database is filled with demo data only in demo mode. On a
  // real server (DEMO_MODE=off) it starts empty, and the first admin is
  // created from ADMIN_EMAIL / ADMIN_PASSWORD (see server/bootstrap.js).
  seedDemo: env.SEED_DEMO ? env.SEED_DEMO !== 'off' : env.DEMO_MODE !== 'off',
  firstAdmin: {
    name: env.ADMIN_NAME || 'School Admin',
    email: env.ADMIN_EMAIL || '',
    password: env.ADMIN_PASSWORD || '',
  },

  // Cookies are marked Secure when the public address is HTTPS.
  secureCookies: env.SECURE_COOKIES ? env.SECURE_COOKIES !== 'off' : (env.PUBLIC_BASE_URL || '').startsWith('https://'),

  // How parents log in. The PIN (set up with an access code from the school
  // office) needs nothing extra. Codes by SMS need an SMS provider (server/sms.js).
  parentLogin: {
    otp: env.DEMO_MODE !== 'off' || Boolean(env.SMS_PROVIDER),
    pin: true,
    accessCodeDays: 14,
  },

  school: {
    name: env.SCHOOL_NAME || 'Modern K.B.S. Senior Secondary School',
    shortName: env.SCHOOL_SHORT_NAME || 'KBS School',
    monogram: 'KBS',
    logo: '/logo-192.png',
    address: '45 Mile, Ladwara, Tehsil Shahpur, District Kangra, Himachal Pradesh – 176208',
    shortAddress: '45 Mile, Ladwara, Tehsil Shahpur, District Kangra, H.P. – 176208',
    // The address as printed on receipts and in WhatsApp messages.
    addressLines: ['45 Mile, Ladwara, Tehsil Shahpur,', 'District Kangra, Himachal Pradesh – 176208'],
    pin: '176208',
  },

  appName: 'KBS School ERP',

  academicYear: {
    start: '2026-04',
    session: '2026-27',
    label: '2026–27',
    breakMonths: ['2026-05', '2026-06'],
    breakLabel: 'summer break',
  },
  subjects: ['English', 'Hindi', 'Maths', 'Science', 'Social Studies'],

  // The school day, for the timetable (Monday to Saturday).
  timetable: {
    days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    periods: [
      { period: 1, start: '08:30', end: '09:10' },
      { period: 2, start: '09:10', end: '09:50' },
      { period: 3, start: '09:50', end: '10:30' },
      { period: 4, start: '10:30', end: '11:10' },
      { period: 5, start: '11:40', end: '12:20' },
      { period: 6, start: '12:20', end: '13:00' },
      { period: 7, start: '13:00', end: '13:40' },
      { period: 8, start: '13:40', end: '14:20' },
    ],
    breakAfter: 4, // lunch break after period 4
  },
  receiptPrefix: 'KBS/2026-27/',

  fees: {
    // Fees become payable this many days before their due date; later
    // instalments are shown as upcoming.
    dueWindowDays: 30,
  },

  payments: {
    // 'razorpay' when keys are present, otherwise the built-in test gateway.
    gateway: env.PAYMENT_GATEWAY || (razorpayConfigured ? 'razorpay' : 'test'),
    razorpay: {
      keyId: env.RAZORPAY_KEY_ID || '',
      keySecret: env.RAZORPAY_KEY_SECRET || '',
      webhookSecret: env.RAZORPAY_WEBHOOK_SECRET || '',
      apiBase: env.RAZORPAY_API_BASE || 'https://api.razorpay.com',
    },
    test: {
      // Secrets for the built-in gateway. Random per run unless set.
      keySecret: env.TEST_GATEWAY_KEY_SECRET || crypto.randomBytes(24).toString('hex'),
      webhookSecret: env.TEST_GATEWAY_WEBHOOK_SECRET || crypto.randomBytes(24).toString('hex'),
      // Real gateways retry webhooks; the test gateway sends each one twice so
      // duplicate handling is exercised on every test payment.
      duplicateWebhooks: env.TEST_GATEWAY_DUPLICATE_WEBHOOKS !== 'off',
      webhookDelayMs: 250,
    },
    // Unfinished online payments are checked with the gateway after this long.
    reconcileAfterMinutes: 10,
  },

  whatsapp: {
    // 'cloud' uses the official WhatsApp Business Cloud API; 'click-to-chat'
    // prepares the message and opens WhatsApp for the clerk to press Send.
    provider: env.WHATSAPP_PROVIDER || (whatsappConfigured ? 'cloud' : 'click-to-chat'),
    countryCode: '91',
    cloud: {
      token: env.WHATSAPP_TOKEN || '',
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
      apiBase: env.WHATSAPP_API_BASE || 'https://graph.facebook.com',
      apiVersion: env.WHATSAPP_API_VERSION || 'v21.0',
      // Messages the school starts need a Meta-approved template (see README).
      templateName: env.WHATSAPP_TEMPLATE_NAME || '',
      templateLanguage: env.WHATSAPP_TEMPLATE_LANGUAGE || 'en',
      appSecret: env.WHATSAPP_APP_SECRET || '',
      verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
    },
    maxAttempts: 5,
  },

  // KBS AI Assistant for staff. It only reads and proposes through the
  // allow-listed tools in server/assistant/tools.js; changes run after the
  // staff member presses Confirm. With ANTHROPIC_API_KEY set, Claude reads
  // the questions; otherwise the built-in assistant answers the common ones.
  assistant: {
    name: 'KBS AI Assistant',
    provider: env.ASSISTANT_PROVIDER || (env.ANTHROPIC_API_KEY ? 'claude' : 'built-in'),
    claude: {
      apiKey: env.ANTHROPIC_API_KEY || '',
      model: env.ASSISTANT_MODEL || 'claude-opus-5-5',
      apiBase: (env.ANTHROPIC_API_BASE || 'https://api.anthropic.com').replace(/\/$/, ''),
      maxRounds: 6,
      timeoutMs: 45_000,
    },
    // A proposed change must be confirmed within this many minutes.
    confirmMinutes: 15,
    messagesPerMinute: Number(env.ASSISTANT_MESSAGES_PER_MINUTE) || 20,
  },

  // SMS confirmation of receipts in addition to WhatsApp (simulated SMS).
  smsReceipts: env.SMS_RECEIPTS !== 'off',

  // An always-current Excel/CSV copy of the fee register, rewritten after each payment.
  exports: {
    registerSync: env.REGISTER_SYNC !== 'off',
    dir: env.EXPORT_DIR || '', // defaults to data/exports next to the database
  },

  // Off-site copies of the daily backup, in any S3-compatible storage
  // (Oracle Object Storage, Cloudflare R2, Backblaze B2, AWS S3). Optional.
  offsiteBackup: {
    endpoint: (env.BACKUP_S3_ENDPOINT || '').replace(/\/$/, ''),
    region: env.BACKUP_S3_REGION || 'auto',
    bucket: env.BACKUP_S3_BUCKET || '',
    accessKey: env.BACKUP_S3_ACCESS_KEY || '',
    secretKey: env.BACKUP_S3_SECRET_KEY || '',
    prefix: env.BACKUP_S3_PREFIX || 'kbs-erp/',
  },

  otp: { length: 6, ttlSeconds: 300, resendSeconds: 30, maxAttempts: 5 },
  sessionDays: 30,
  staffSessionHours: 12,

  // Filled in when the server starts.
  runtime: { internalUrl: '' },
};

// Kept for modules that only need the full school name.
config.schoolName = config.school.name;
