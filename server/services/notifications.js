import { config } from '../config.js';
import { broadcast, on } from '../events.js';
import { sendSms } from '../sms.js';
import { paymentDetails } from './payment-history.js';
import { deliver, prepareReceiptMessage } from './whatsapp.js';
import { scheduleRegisterSync } from './register-sync.js';
import { getStudent } from './students.js';
import { rupees } from '../../shared/format.js';

// What happens after a payment is confirmed (the payment is already stored):
//   1. the WhatsApp receipt message is prepared (and sent, if the API is set up)
//   2. clerks' screens show the "Payment confirmed" card
//   3. an SMS confirmation goes to the parent
//   4. the Excel/CSV fee register on disk is refreshed
export function registerNotificationHandlers() {
  on('payment.confirmed', async ({ paymentId }) => {
    prepareReceiptMessage(paymentId);
    const details = paymentDetails(paymentId);
    broadcast('payment.confirmed', details);

    if (config.smsReceipts) {
      const student = getStudent(details.student.id);
      sendSms(
        student.parentPhone,
        'receipt',
        `Payment of ${rupees(details.amount)} received for ${details.student.name} (${details.student.classLabel}). ` +
          `Receipt ${details.receiptNo}. Thank you. – ${config.school.shortName}`,
      );
    }
    scheduleRegisterSync();
    await deliver(paymentId);
  });

  on('payment.failed', ({ orderId }) => broadcast('payment.failed', { orderId }));
}
