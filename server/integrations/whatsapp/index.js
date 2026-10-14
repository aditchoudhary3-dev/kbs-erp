import { config } from '../../config.js';
import { createCloudApi } from './cloud-api.js';
import { createClickToChat, clickToChatLink } from './click-to-chat.js';
import { formatDate } from '../../../shared/format.js';

export { clickToChatLink };

// The active WhatsApp provider. A provider is { name, label, automatic, send? }.
let instance = null;

export function whatsapp() {
  if (instance) return instance;
  const choice = config.whatsapp.provider;
  if (choice === 'cloud') instance = createCloudApi(config.whatsapp.cloud);
  else if (choice === 'click-to-chat') instance = createClickToChat();
  else throw new Error(`Unknown WHATSAPP_PROVIDER "${choice}". Use "cloud" or "click-to-chat".`);
  return instance;
}

export function resetWhatsapp() {
  instance = null;
}

export const whatsappNumber = (phone) => `${config.whatsapp.countryCode}${phone}`;

const amountText = (amount) => new Intl.NumberFormat('en-IN').format(amount);

// The receipt message, worded as the school asked. It goes with the PARENT
// COPY of the receipt (never the School Copy).
export function receiptMessage(r, { receiptUrl = null } = {}) {
  return [
    'Dear Parent,',
    '',
    'Your fee payment has been successfully received.',
    '',
    `Student: ${r.student.name}`,
    `Class: ${r.student.classLabel}`,
    `Receipt No.: ${r.receiptNo}`,
    `Amount Paid: ₹${amountText(r.total)}`,
    `Payment Mode: ${r.method}`,
    `Date: ${formatDate(r.paidAt)}`,
    '',
    'Please find your Parent Copy receipt attached.',
    ...(receiptUrl ? [`Parent Copy: ${receiptUrl}`] : []),
    '',
    'Thank you.',
    '',
    r.school.name,
    ...(r.school.addressLines ?? [r.school.address]),
  ].join('\n');
}

// Values for the approved template's {{1}}…{{6}} (see README).
export const receiptTemplateParams = (r) => [
  r.student.name,
  r.student.classLabel,
  r.receiptNo,
  amountText(r.total),
  r.method,
  formatDate(r.paidAt),
];
