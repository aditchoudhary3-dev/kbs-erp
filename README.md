# KBS School ERP

The school management and fee system for **Modern K.B.S. Senior Secondary School**, 45 Mile, Ladwara, Tehsil Shahpur, District Kangra, Himachal Pradesh – 176208.

- **Parent app** (phone): pay fees online, download receipts, see attendance, the class timetable, monthly progress and the annual report.
- **Staff app** for the office, teachers and admins (computer, tablet or phone):

Both install on Android phones from Chrome (no Play Store needed), and both use the same central database. To put the app online, follow **[GOING-LIVE.md](GOING-LIVE.md)**.


| Menu | What it does |
| --- | --- |
| Dashboard | Today's and this month's collection, paid students, pending fees, recent payments, KBS AI Daily Summary |
| My Day (teachers) | Today's periods, their classes, attendance still to mark, who is absent |
| Students → Add Student | Full admission form; checks duplicates, gives the Student ID, creates the fee account |
| Students → Manage Students | Search, view, edit, deactivate/reactivate (students are never deleted) |
| Students → Parent App Access | Give each family a one-time access code to set up their PIN; see who uses the app; switch a family off |
| Academics → Attendance | Teachers mark their classes daily (Present / Absent / Late / Leave); monthly register with Excel export; whole-school view |
| Academics → Timetable | Monday–Saturday, 8 periods; subject and teacher per period; no teacher in two classes at once |
| Academics → Monthly progress | Marks, remarks, activities; attendance filled in from the daily register |
| Academics → Subjects & Teachers | Subjects, and which classes each teacher teaches (and who is class teacher) |
| Fees → Fee Structure | Fee types, fees per class and session, frequency, late fee, optional/compulsory, transport-only |
| Fees → Cash Collection | Counter payments: amount received, confirmation screen, then PAYMENT SUCCESSFUL with the School Copy and Parent Copy |
| Fees → Payments / Receipts | Every payment and receipt, searchable; both copies of every receipt (view, print, download), Parent Copy on WhatsApp, request correction |
| Fees → Corrections | Clerks request corrections to completed payments; admins approve or reject |
| Reports → Reports / Class-wise / Excel Export | Daily, monthly, class-wise, student-wise, pending and payment-mode reports; Excel and CSV |
| School → Staff Records | Everyone at school: admins, clerks and teachers (with logins) and other staff (records only); export to Excel |
| System → Audit Logs / System Backup / System Health | Full activity log, backups (with off-site copies), health checks |
| KBS AI Assistant (every page) | Ask about fees, payments, receipts and students in plain English; reports with Export Excel; record counter payments and (admins) add fees after confirming; daily summary on the dashboard |

## Run it

You need **Node.js 22.13 or newer**. There is nothing to install.

```bash
cd schoolconnect
npm start
```

On a Mac you can also double-click **Start SchoolConnect.command**.

Your existing data is upgraded automatically the first time a new version starts, after a backup copy of the database is made next to it.

| | Address | Demo login |
| --- | --- | --- |
| Staff app | http://localhost:3000/admin | Admin `admin@kbs.test` / `admin1234` · Clerk `clerk@kbs.test` / `clerk1234` · Teacher `teacher@kbs.test` / `teacher1234` (Meena Sharma, class teacher of 6-B) |
| Parent app | http://localhost:3000 | `98765 43210` with PIN `246810` (Aarav, 6-B), or a login code by SMS for `98765 00018` (Diya and Kabir) |

The demo data covers Nursery to Class 12: 24 sections, about 430 students with full admission details, a fee structure for every class, a term's worth of payments, 7 teachers with a timetable for Classes 6–8, and three weeks of attendance. Login codes appear on screen, because no real SMS is sent in demo mode.

`npm run reset` reloads the demo data. `npm test` runs the automated checks.

## The payment workflow

```
PAYMENT SUCCESS ─► VERIFY PAYMENT ─► UPDATE DATABASE ─► UPDATE CLASS-WISE RECORD ─► GENERATE RECEIPT
   ─► SHOW CLERK CONFIRMATION ─► PRINT RECEIPT ─► SEND RECEIPT ON WHATSAPP ─► STORE PAYMENT HISTORY
```

1. **Payment.** A parent pays online in the app, or a clerk records money received at the counter (cash, cheque, UPI, bank transfer or card).
2. **Verification.** An online payment becomes PAID only after the server has verified it:
   - it checks the gateway's signature on the checkout response,
   - it looks up the payment directly with the gateway,
   - and it accepts the gateway's signed webhook, which confirms the payment even if the parent closes the app.

   A button in the browser can never mark fees as paid.
3. **One transaction.** Confirming a payment records it in the ledger, marks the fees paid, gives it the next receipt number (`KBS/2026-27/00001`, …), freezes a copy of the receipt, and writes an audit entry. Either all of this happens or none of it does.
4. **No duplicates.** A webhook delivered twice, a webhook plus the browser's confirmation, or a double-click at the counter all produce one payment and one receipt. This is enforced in the code and by unique keys in the database.
5. **Class-wise records** are calculated from the ledger, so they update the moment a payment is confirmed and can never disagree with it.
6. **Receipt: two copies.** Every payment has a **School Copy** and a **Parent Copy** (see below): one full A4 page each, or both together on one A4 page.
7. **Clerk confirmation.** Every staff screen shows **✓ PAYMENT SUCCESSFUL** straight away (student, class, amount, receipt number, payment mode) with **PRINT SCHOOL COPY**, **PRINT PARENT COPY**, **PRINT BOTH COPIES** (both on one A4 page), **DOWNLOAD SCHOOL COPY**, **DOWNLOAD PARENT COPY**, **DOWNLOAD BOTH COPIES** and **SEND PARENT COPY ON WHATSAPP**.
8. **WhatsApp.** Only the Parent Copy is sent, in the school's wording. It is sent automatically when the WhatsApp Business API is set up (see below). If WhatsApp is unavailable the payment still completes and the message waits in a retry queue. Its status shows as **SENT**, **PENDING** or **FAILED**. Without the API, the button opens WhatsApp with the parent's number and the message filled in, and downloads the Parent Copy PDF to attach.
9. **History.** Every payment and attempt (PAID, PENDING, FAILED) is kept and searchable. An always-current Excel and CSV copy of the fee register is written to `data/exports/`.

## Receipt copies

Every payment has two separate receipts, each designed for one **A4 portrait page (210 × 297 mm)**:

| | School Copy | Parent Copy |
| --- | --- | --- |
| Header | School name, address, PIN – 176208, **FEE RECEIPT** | Same |
| Large label | **SCHOOL COPY** | **PARENT COPY** |
| Details | Receipt Number, Date, Time, Student Name, Admission Number, Student ID, Father/Mother Name, Class, Section | Same |
| Fee table | Fee Head \| Amount: Tuition Fee, Admission Fee, Annual Charges, Transport Fee, Examination Fee, Other Fee, then **Total Amount Paid** | Same |
| Payment | Payment Mode, Transaction ID / Payment Reference, Collected By, Payment Status | Payment Mode, Transaction ID / Payment Reference, Payment Status, Collected By |
| Bottom | School Copy – For School Record · Clerk Signature · Authorized Signature | PARENT COPY · Please keep this receipt for your records. · Authorized Signature |
| PDF | `Receipt-KBS-2026-27-00123-School-Copy.pdf` (kept in the receipt archive) | `Receipt-KBS-2026-27-00123-Parent-Copy.pdf` (the one sent on WhatsApp) |

Each fee paid is shown under its fee head (for example *Tuition Fee: Term 1, Term 2*); fee types outside the five named heads appear under **Other Fee**. The heads are listed in `FEE_HEADS` in `server/services/receipts.js`. Both copies are made from the receipt frozen when the payment was confirmed, so they always agree.

**Printing.** **PRINT SCHOOL COPY** and **PRINT PARENT COPY** each print one full A4 page. **PRINT BOTH COPIES** prints **both copies on one A4 page**: the School Copy on the top half and the Parent Copy on the bottom half, with a dashed *Cut here* line between them. The half-page copies carry every field (the six fee heads sit in two columns). The print stylesheet uses `@page { size: A4 portrait; margin: 10mm; }`, and every layout is sized to fill exactly one page and never spill onto a second. In the print dialog choose paper size **A4**, margins **Default**, scale **100%**, and turn off **Headers and footers** for a clean page.

**PDFs.** **DOWNLOAD SCHOOL COPY** and **DOWNLOAD PARENT COPY** give one full A4 page each (`…-School-Copy.pdf`, `…-Parent-Copy.pdf`); **DOWNLOAD BOTH COPIES** gives one A4 page with both copies (`…-School-and-Parent-Copies.pdf`).

Every receipt stays available from **Payments** and **Receipts** → **Receipt copies**: view, print or download either copy, send or re-send the Parent Copy, and see the receipt's history (printed, downloaded, sent, corrections). Parents are never sent the School Copy: the parent app, WhatsApp and the receipt link only ever serve the Parent Copy. Completed receipts are never deleted; mistakes go through **Request correction**.

## KBS AI Assistant

Open it from **KBS AI** (bottom right) or the menu. Ask in plain English, for example:

- *How much fee is pending for Rahul Verma?* · *Show Rahul Verma's payment history.* · *Find receipt number 1025.*
- *How much cash was collected today?* · *Show online payments from yesterday.* · *What was the total collection this month?*
- *Show Class 8 pending fees.* · *Which students have not paid this month's tuition fee?* · *Find Pranav from class 8.*
- *Generate today's fee collection report.* · *Export Class 10 fee report.* · *Show cash vs online collection.* (each with **EXPORT EXCEL**)
- *Record cash payment of ₹5,000 for Rahul Verma.* (shows the exact payment, then **CONFIRM PAYMENT** / **CANCEL**)
- Admins: *Show all fee types.* · *Add a new fee type.* · *Create Class 8 monthly tuition fee of ₹2,000.* (shows the exact fee, instalments and how many students it applies to, then **CONFIRM** / **CANCEL**)

The dashboard shows a **KBS AI Daily Summary**: today's collection (cash and online), number of payments, failed payments, pending fee accounts, WhatsApp receipts pending, corrections, and recent issues with links.

**How it is kept safe**

- The assistant has no database access of its own. It can only use the allow-listed tools in `server/assistant/tools.js`. Each tool is a fixed lookup or a fixed proposal, checks the user's role on the server, and validates its inputs.
- It answers only from what those tools return. Numbers are read from the database each time.
- It shows only what is needed about a student: name, admission number, class and parent name. Phone numbers, addresses and dates of birth are never given to it.
- It can never mark payments as paid by itself, change payment status, transaction IDs, amounts or issued receipts, delete anything, manage staff accounts, or see passwords, API keys, tokens, settings or environment variables. There are no tools for these.
- Anything that changes records (a counter payment, a fee type, a fee) is only *prepared*. It runs when the person who asked presses **Confirm**, within 15 minutes, if their role still allows it, through the same code as the normal screens.
- Clerks get clerk limits: they can search students, see fees and reports, record counter payments (with confirmation), and print and send receipts, but not change the fee structure or anything else.
- Every confirmed, failed or cancelled assistant action is in the **Audit Logs**: who, *via KBS AI Assistant*, what, when, which record and the result. The changes it makes (the payment, the fee) are also logged as made through the assistant. Filter with **Made through → KBS AI Assistant only**.

**Built-in or Claude.** Without any setup, the built-in assistant understands the common questions above. For free-form questions, set an Anthropic API key and the assistant uses Claude, still limited to the same tools and permissions:

```bash
ANTHROPIC_API_KEY=sk-ant-... npm start          # optional: ASSISTANT_MODEL=claude-opus-5-5
```

Claude receives only the question, the recent conversation text and the tool results for that user. If it cannot be reached, the built-in assistant answers instead.

## Roles

| | Admin | Clerk | Teacher |
| --- | --- | --- | --- |
| Cash collection, view payments and receipts | ✓ | ✓ | |
| Print, download and WhatsApp receipts | ✓ | ✓ | |
| Request a payment correction | ✓ | ✓ | |
| KBS AI Assistant (within the same permissions) | ✓ | ✓ | |
| Reports and Excel/CSV exports | ✓ | ✓ | |
| Give parents app access codes | ✓ | ✓ | |
| See attendance for every class | ✓ | ✓ | |
| Mark attendance, enter monthly progress | ✓ | | own classes |
| See students (names, admission numbers, parents; no fees) | ✓ | ✓ | own classes |
| Parents' phone numbers | ✓ | ✓ | as class teacher |
| Timetable | edit | view | view (own week, own classes) |
| Add, edit, deactivate students; export the student list; switch parent access off | ✓ | | |
| Fee structure, fee types, waivers | ✓ | | |
| Approve payment corrections | ✓ | | |
| Staff Records, Subjects & Teachers, Audit Logs, Backup, Health, notices | ✓ | | |

Other staff (drivers, attendants…) can be kept in **Staff Records** without app access. Every permission is checked on the server for every request, not just hidden in the menu.

## Parents' login

Parents log in with the mobile number on their children's records and a 6-digit PIN:

1. The office opens **Parent App Access** and gives the family a one-time **access code** (sent on WhatsApp or printed).
2. In the app, the parent taps **First time? Use your access code**, enters their number and the code, and chooses a PIN.
3. A forgotten PIN: the office gives a new code. Five wrong PINs lock the login for 15 minutes. An admin can **switch off** a family's access, which also logs them out.

This needs no SMS service. Where an SMS provider is connected (`SMS_PROVIDER`, `server/sms.js`), parents can also log in with a one-time code by SMS.

## Installing on Android phones

Open the address in **Chrome** on the phone: the parent app at `/`, the staff app at `/admin`. Chrome offers **Install app** (or use **⋮ → Install app / Add to Home screen**). The school's icon appears on the home screen and the app opens full screen. It updates itself; there is nothing to reinstall. The app keeps working views of its screens for poor connections, but records always come live from the server and are never stored on the phone.

## Students and fee accounts

**Add Student** asks for everything on the admission form. On **Save** it checks that no other student has the same admission number, and that the same child (same name, date of birth and father or phone) is not already registered. It then gives the Student ID (`STU00435`) and creates the student's **fee account**: every compulsory fee in the Fee Structure for that class and session, with transport fees only if transport is required. A student admitted mid-session is not charged for instalments that fell due before they joined, but yearly and one-time fees always apply. Fees marked *new admissions only* (such as Admission Fee) are charged to students added after the fee was set up.

Students are **deactivated, never deleted**. All their payments and receipts stay; unpaid fees that are not yet due are removed, and are added back if they are reactivated.

## Fee Structure

A fee has a type (add new types any time with **+ Add fee type**), a class (or all classes), a session, an amount, a frequency (Monthly, Quarterly, Half-Yearly, Yearly, One-Time, or Custom instalments), a due date, a late fee, and whether it is compulsory, optional, transport-only or for new admissions only.

- Fees become **due** 30 days before their due date; later instalments show as **upcoming** (they can still be paid in advance at the counter).
- A fee's **late fee** is added once to each instalment still unpaid after its due date.
- **Editing a fee changes only unpaid instalments.** Paid instalments, payments and receipts never change.
- Optional fees (for example Computer Fee) are added to individual students from their page.

## Cash payments and corrections

1. **Cash Collection:** search by name, admission number or Student ID. Tick the fees being paid and enter the amount received.
   - More than the total: the extra is shown as change to return.
   - Less than the total: it is a part payment, and the rest stays due.
2. **Confirm cash payment** shows the confirmation screen (student, class, amount, mode, collected by, date and time).
3. **Confirm & generate receipt** saves it with the clerk's user ID, issues the receipt number, and shows **PAYMENT SUCCESSFUL** with Print Receipt, Send WhatsApp, Download PDF and View Receipt.

A completed payment cannot be changed. If something is wrong, use **Request correction** on the receipt. When an admin approves:

- the original payment is marked **CANCELLED**, kept in history with its reason, and recorded in the audit log;
- for a wrong mode or reference, a corrected receipt is issued ("replaces receipt …");
- for a cancellation, the fees become due again.

Financial records are never deleted.

## Backups

A complete backup is made automatically every day, in `data/backups/`. The last 14 daily backups are kept. You can also back up and download from **System Backup**. To restore: stop the app, copy the backup file over `data/schoolconnect.db`, then start the app. Keep a weekly copy off the school computer.

## Going live with Razorpay

The app runs with a built-in **test gateway** until Razorpay keys are set. The test gateway uses Razorpay's formats and signed webhooks, so the verification code that runs in testing is the same code that runs with Razorpay.

1. In the Razorpay dashboard, create API keys and a **webhook** pointing at `https://<your-domain>/api/webhooks/payments`. Choose the events `payment.captured`, `payment.failed` and `order.paid`, and set a webhook secret.
2. Start the app with:

```bash
RAZORPAY_KEY_ID=rzp_live_xxx \
RAZORPAY_KEY_SECRET=xxx \
RAZORPAY_WEBHOOK_SECRET=xxx \
PUBLIC_BASE_URL=https://fees.example.com \
npm start
```

Parents then pay on Razorpay Checkout. If a webhook is ever missed, pending payments are checked with Razorpay automatically, and **Check with gateway** does the same on demand.

## Sending receipts automatically on WhatsApp

This uses the official **WhatsApp Business Platform (Cloud API)** from Meta.

1. Set up a WhatsApp Business account and phone number in Meta Business Manager.
2. Create a **Utility** message template, for example named `fee_receipt`, with a **Document** header (the Parent Copy PDF is attached there) and this body:

```
Dear Parent,

Your fee payment has been successfully received.

Student: {{1}}
Class: {{2}}
Receipt No.: {{3}}
Amount Paid: ₹{{4}}
Payment Mode: {{5}}
Date: {{6}}

Please find your Parent Copy receipt attached.

Thank you.

Modern K.B.S. Senior Secondary School
45 Mile, Ladwara, Tehsil Shahpur,
District Kangra, Himachal Pradesh – 176208
```

3. Start the app with:

```bash
WHATSAPP_TOKEN=... WHATSAPP_PHONE_NUMBER_ID=... WHATSAPP_TEMPLATE_NAME=fee_receipt npm start
```

Each Parent Copy PDF is uploaded and sent with the template. If WhatsApp is down, the payment is unaffected: the message is queued and retried automatically (up to 5 times, with growing gaps), and **Re-send** puts it back in the queue. For delivery ticks, point the WhatsApp webhook at `/api/webhooks/whatsapp` and set `WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_APP_SECRET`.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Use `HOST=0.0.0.0` to reach it from other devices on the network |
| `PUBLIC_BASE_URL` | empty | The school's web address; adds a receipt download link to WhatsApp messages |
| `RAZORPAY_*` | not set | See above; without them the test gateway is used |
| `WHATSAPP_*` | not set | See above; without them the clerk sends each Parent Copy from WhatsApp |
| `ANTHROPIC_API_KEY` / `ASSISTANT_MODEL` | not set / `claude-opus-5-5` | KBS AI Assistant on Claude; without a key the built-in assistant answers |
| `SMS_RECEIPTS` | on | Also confirm payments by SMS (connect a provider in `server/sms.js`) |
| `REGISTER_SYNC` / `EXPORT_DIR` | on / `data/exports` | The always-current Excel/CSV fee register |
| `DEMO_MODE` | on | `off` for a real school: no demo data or demo logins; parents log in with a PIN |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | not set | Creates the first admin on a new, empty server (or run `npm run create-admin`) |
| `SECURE_COOKIES` | on when `PUBLIC_BASE_URL` is https | Marks login cookies Secure and adds HSTS |
| `BACKUP_S3_*` | not set | Copies each daily backup to S3-compatible storage (Oracle Object Storage, R2, B2, S3) |
| `SMS_PROVIDER` | not set | Lets parents log in with a code by SMS, once a provider is connected in `server/sms.js` |

The academic year, receipt number prefix and subjects are in `server/config.js`. Fee amounts are set on the **Fee Structure** page.

## How it is built

A Node.js server with its built-in SQLite database, and plain JavaScript in the browser. There is no build step and there are no packages. The parts most likely to change later sit behind small interfaces:

```
server/integrations/payments/   razorpay.js, test-gateway.js   (add another gateway here)
server/integrations/whatsapp/   cloud-api.js, click-to-chat.js (add another WhatsApp provider here)
server/integrations/export/     xlsx.js, csv.js                (add another export format here)
server/services/payments.js     the payment pipeline: orders, verification, confirmation, counter payments
server/services/receipts.js     receipt copies (School Copy, Parent Copy): A4 page and PDF
server/assistant/               KBS AI Assistant: tools.js (the allow-list), actions.js (confirm),
                                local.js (built-in), claude.js (Claude), insights.js (daily summary)
server/services/reports.js      dashboard, class-wise, and the reports
server/services/whatsapp.js     WhatsApp outbox with retries
server/permissions.js           what Admin, Clerk and Teacher may do
server/services/academics.js    subjects, teachers' classes, timetable
server/services/attendance.js   daily attendance and registers
server/services/parent-access.js  parent access codes and PINs
server/bootstrap.js             a real school's first start (empty school, first admin)
public/sw.js, *.webmanifest     installing the apps on phones
Dockerfile, docker-compose.yml, deploy/   the live server (see GOING-LIVE.md)
server/migrations.js            database versions; older databases upgrade automatically
public/js/admin/                staff app screens
public/js/parent/               parent app
test/                           end-to-end and integration tests
```

Before changing the database version, the app copies the database to a timestamped backup file next to it.

## Before real families use it

Follow **[GOING-LIVE.md](GOING-LIVE.md)**. It covers HTTPS, the first admin account (with `DEMO_MODE=off` there are no demo accounts or demo data), loading the real fee structure and students, parent access codes, installing on phones, daily and off-site backups, and automatic updates from GitHub.
