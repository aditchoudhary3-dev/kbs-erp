import { config } from '../config.js';
import { HttpError, sendDownload } from '../http.js';
import * as auth from '../auth.js';
import { can } from '../permissions.js';
import { getStudent, studentsForPhone } from '../services/students.js';
import { dueSummary } from '../services/fees.js';
import { createOnlineOrder, getOrder, orderByGatewayId, verifyCheckout } from '../services/payments.js';
import { orderStatus, paymentDetails, studentPayments } from '../services/payment-history.js';
import { parseCopy, receiptData, receiptFilename, receiptPdf } from '../services/receipts.js';
import { audit } from '../audit.js';
import { annualReport, latestPublished, publishedReports } from '../services/progress.js';
import { updatesForStudent } from '../services/notices.js';
import { reportCardPdf } from '../services/documents.js';
import { gateway } from '../integrations/payments/index.js';
import { applyLateFees } from '../services/fee-structure.js';
import { DEMO } from '../seed.js';
import { attendanceMonths, studentAttendance } from '../services/attendance.js';
import { classTimetable, weekday } from '../services/academics.js';
import { currentMonthKey, monthLong, monthShort, todayIso } from '../../shared/format.js';

// Loads a student and checks that the logged-in parent is their guardian.
function ownChild(ctx, id = ctx.params.id) {
  const phone = auth.requireParent(ctx);
  const student = getStudent(Number(id));
  if (!student || student.parentPhone !== phone) throw new HttpError(404, 'Student not found.');
  return student;
}

// Staff who may print receipts, or the student's own parent.
function canSeeStudent(ctx, studentId) {
  const staff = auth.currentStaff(ctx);
  if (staff && can(staff.role, 'receipts.print')) return staff;
  ownChild(ctx, studentId);
  return null;
}

const publicStudent = ({ parentPhone, whatsappPhone, ...student }) => student;

export function parentRoutes(router) {
  router.get('/api/config', () => ({
    schoolName: config.school.name,
    schoolShortName: config.school.shortName,
    schoolAddress: config.school.shortAddress,
    monogram: config.school.monogram,
    logo: config.school.logo,
    demoMode: config.demoMode,
    demo: config.demoMode ? DEMO : null,
    login: { otp: config.parentLogin.otp, pin: config.parentLogin.pin },
  }));

  router.post('/api/auth/otp', ({ body }) => auth.requestOtp(body.phone));

  // Number + PIN; and the first time (or a forgotten PIN), the access code from the school.
  router.post('/api/auth/pin', (ctx) => {
    auth.parentPinLogin(ctx.res, ctx.body.phone, ctx.body.pin);
    return { ok: true };
  });

  router.post('/api/auth/setup', (ctx) => {
    const phone = auth.setupParentPin(ctx.res, ctx.body.phone, ctx.body.code, ctx.body.pin);
    audit(`parent:${phone}`, 'parent.pin_set', { entity: 'parent', entityId: phone });
    return { ok: true };
  });

  router.post('/api/auth/verify', (ctx) => {
    auth.verifyOtp(ctx.res, ctx.body.phone, ctx.body.code);
    return { ok: true };
  });

  router.post('/api/auth/logout', (ctx) => {
    auth.endSession(ctx, 'parent');
    return { ok: true };
  });

  router.get('/api/me', (ctx) => {
    const phone = auth.requireParent(ctx);
    return {
      phone,
      children: studentsForPhone(phone).map(publicStudent),
      schoolName: config.school.name,
      schoolShortName: config.school.shortName,
      academicYear: config.academicYear.label,
    };
  });

  router.get('/api/students/:id/home', (ctx) => {
    const student = ownChild(ctx);
    const latest = latestPublished(student.id);
    return {
      student: publicStudent(student),
      fees: dueSummary(student.id),
      progress: latest && {
        month: latest.month,
        monthLabel: monthLong(latest.month),
        avg: latest.avg,
        attPct: latest.attPct,
        activities: latest.activities.length,
      },
      updates: updatesForStudent(student),
      academicYear: config.academicYear.label,
      attendance: (() => {
        const month = studentAttendance(student.id, currentMonthKey());
        const today = month.days.find((d) => d.date === todayIso());
        return { today: today?.status ?? null, monthLabel: monthLong(month.month), pct: month.summary.pct, days: month.summary.days };
      })(),
    };
  });

  // ---- Attendance and timetable --------------------------------------------------

  router.get('/api/students/:id/attendance', (ctx) => {
    const student = ownChild(ctx);
    const month = /^\d{4}-\d{2}$/.test(ctx.query.get('month') ?? '') ? ctx.query.get('month') : currentMonthKey();
    return { student: publicStudent(student), months: attendanceMonths(student.id), ...studentAttendance(student.id, month) };
  });

  router.get('/api/students/:id/timetable', (ctx) => {
    const student = ownChild(ctx);
    return { student: publicStudent(student), today: weekday(todayIso()), ...classTimetable(student.classId) };
  });

  router.get('/api/students/:id/fees', (ctx) => {
    const student = ownChild(ctx);
    applyLateFees();
    return {
      student: publicStudent(student),
      due: dueSummary(student.id),
      payments: studentPayments(student.id),
      gateway: { name: gateway().name, label: gateway().label },
    };
  });

  // ---- Paying online -----------------------------------------------------------
  // 1. The app asks for a payment order for everything currently due.
  // 2. The parent pays on the gateway's checkout.
  // 3. The app sends back what checkout returned; the server verifies it.
  // The gateway's webhook confirms the payment independently of the browser.

  router.post('/api/students/:id/payment-orders', async (ctx) => {
    const student = ownChild(ctx);
    applyLateFees();
    const order = await createOnlineOrder(student.id, {
      expectedAmount: ctx.body.amount,
      createdBy: `parent:${student.parentPhone}`,
    });
    return {
      order: { id: order.id, amount: order.amount, gatewayOrderId: order.gatewayOrderId },
      checkout: gateway().checkoutConfig(),
      prefill: { name: student.parentNames || student.name, contact: `+91${student.parentPhone}` },
      description: `${student.name} · ${student.classLabel}`,
      schoolName: config.school.name,
    };
  });

  router.post('/api/payments/verify', async (ctx) => {
    const { gatewayOrderId, gatewayPaymentId, signature } = ctx.body;
    const order = orderByGatewayId(gatewayOrderId);
    if (!order) throw new HttpError(404, 'Payment order not found.');
    ownChild(ctx, order.studentId);
    return verifyCheckout({ gatewayOrderId, gatewayPaymentId, signature });
  });

  router.get('/api/payment-orders/:id', (ctx) => {
    const order = getOrder(Number(ctx.params.id));
    if (!order) throw new HttpError(404, 'Payment order not found.');
    ownChild(ctx, order.studentId);
    return orderStatus(order.id);
  });

  router.get('/api/payments/:id', (ctx) => {
    const details = paymentDetails(Number(ctx.params.id));
    const staff = canSeeStudent(ctx, details.student.id);
    const { whatsapp, urls, ...rest } = details;
    // Parents only get the Parent Copy.
    const parentUrls = { receipt: urls.parentCopy, pdf: urls.parentCopyPdf };
    return { ...rest, id: details.paymentId, urls: staff ? urls : parentUrls };
  });

  // Receipt PDF. Staff choose ?copy=school|parent|both; parents only ever get the Parent Copy.
  router.get('/api/payments/:id/receipt.pdf', (ctx) => {
    const receipt = receiptData(Number(ctx.params.id));
    const staff = canSeeStudent(ctx, receipt.studentId);
    const copy = staff ? parseCopy(ctx.query.get('copy')) : 'parent';
    if (staff) audit(staff, 'receipt.downloaded', { entity: 'payment', entityId: receipt.paymentId, details: { receiptNo: receipt.receiptNo, copy } });
    sendDownload(ctx.res, receiptPdf(receipt, { copy }), { type: 'application/pdf', filename: receiptFilename(receipt, copy) });
  });

  // ---- Progress ------------------------------------------------------------------

  router.get('/api/students/:id/progress', (ctx) => {
    const student = ownChild(ctx);
    return {
      student: publicStudent(student),
      subjects: config.subjects,
      months: publishedReports(student.id).map((r) => ({
        month: r.month,
        label: monthShort(r.month),
        longLabel: monthLong(r.month),
        daysPresent: r.daysPresent,
        schoolDays: r.schoolDays,
        attPct: r.attPct,
        avg: r.avg,
        marks: r.marks,
        remarks: r.remarks,
        activities: r.activities,
      })),
    };
  });

  router.get('/api/students/:id/annual', (ctx) => {
    const student = ownChild(ctx);
    const { reports, ...annual } = annualReport(student.id);
    return { student: publicStudent(student), ...annual };
  });

  router.get('/api/students/:id/report-card.pdf', (ctx) => {
    const staff = auth.currentStaff(ctx);
    const student = staff ? getStudent(Number(ctx.params.id)) : ownChild(ctx);
    if (!student) throw new HttpError(404, 'Student not found.');
    sendDownload(ctx.res, reportCardPdf(student, annualReport(student.id)), {
      type: 'application/pdf',
      filename: `report-card-${student.name}-${config.academicYear.label}.pdf`,
    });
  });
}
