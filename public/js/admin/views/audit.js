import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';
import { toast } from '../../lib/toast.js';
import { compact, exportButtons, pageHead } from '../components.js';
import { formatDateTime } from '/shared/format.js';

// Audit Logs: who did what and when. Entries are never edited or deleted.

const ACTIONS = {
  'payment.confirmed': 'Payment confirmed',
  'payment.reversed': 'Payment cancelled (correction)',
  'payment.reconciled': 'Checked with gateway',
  'payment.signature_rejected': 'Rejected: bad payment signature',
  'payment.mismatch': 'Rejected: payment details did not match',
  'webhook.rejected': 'Rejected: unsigned webhook',
  'correction.requested': 'Correction requested',
  'correction.approved': 'Correction approved',
  'correction.rejected': 'Correction rejected',
  'whatsapp.sent': 'Parent copy sent on WhatsApp',
  'whatsapp.resent': 'Parent copy re-sent on WhatsApp',
  'whatsapp.opened': 'WhatsApp opened for parent copy',
  'receipt.printed': 'Receipt print opened',
  'receipt.downloaded': 'Receipt PDF downloaded',
  'ai.payment_recorded': 'AI: payment recorded (confirmed)',
  'ai.fee_type_added': 'AI: fee type added (confirmed)',
  'ai.fee_added': 'AI: fee added (confirmed)',
  'ai.cancelled': 'AI: proposal cancelled',
  'attendance.saved': 'Attendance saved',
  'timetable.changed': 'Timetable changed',
  'teacher.classes': 'Teacher’s classes changed',
  'subject.added': 'Subject added',
  'subject.removed': 'Subject removed',
  'subject.restored': 'Subject restored',
  'parent.code_issued': 'Parent access code given',
  'parent.pin_set': 'Parent set up app PIN',
  'parent.enabled': 'Parent app access switched on',
  'parent.disabled': 'Parent app access switched off',
  'student.created': 'Student added',
  'student.updated': 'Student edited',
  'student.deactivated': 'Student deactivated',
  'student.reactivated': 'Student reactivated',
  'fee.waived': 'Fee waived',
  'fee.assigned': 'Optional fee added',
  'fee_type.created': 'Fee type added',
  'fee_structure.created': 'Fee added',
  'fee_structure.updated': 'Fee changed',
  'reminders.sent': 'Reminders sent',
  'report.exported': 'Report exported',
  'user.created': 'Staff account added',
  'user.updated': 'Staff account changed',
  'staff.login': 'Logged in',
  'staff.password_changed': 'Changed own password',
  'system.backup': 'Backup created',
  'system.backup_downloaded': 'Backup downloaded',
};

function describe(entry) {
  const d = entry.details ?? {};
  switch (entry.action) {
    case 'payment.confirmed':
      return `${d.receiptNo} · ₹${d.amount} · ${d.method} · via ${d.via}`;
    case 'payment.reversed':
      return `${d.receiptNo} · ₹${d.amount} · ${d.reason}`;
    case 'student.updated':
    case 'fee_structure.updated':
      return Object.entries(d)
        .filter(([, v]) => v && typeof v === 'object' && 'from' in v)
        .map(([k, v]) => `${k}: ${v.from} → ${v.to}`)
        .join('; ') || JSON.stringify(d);
    case 'student.created':
      return `${d.name} · ${d.admissionNo} · ${d.class} · ${d.feeItems} fee items`;
    case 'correction.requested':
      return `${d.receiptNo} · ${d.kind} · “${d.reason}”`;
    case 'fee.waived':
      return `${d.title} (₹${d.amount}) · reason: ${d.reason}`;
    case 'report.exported':
      return `${d.report} as ${d.format} (${d.rows} rows)`;
    case 'receipt.printed':
    case 'receipt.downloaded':
      return `${d.receiptNo} · ${{ school: 'School copy', parent: 'Parent copy', both: 'School and parent copies' }[d.copy] ?? d.copy}`;
    case 'ai.payment_recorded':
      return `Result: ${d.result}${d.receiptNo ? ` · ${d.receiptNo} · ₹${d.amount} · ${d.method} · ${d.student}` : ''}${d.error ? ` · ${d.error}` : ''}`;
    case 'ai.fee_added':
      return `Result: ${d.result}${d.name ? ` · ${d.name} · ${d.grade} · ₹${d.amount} ${d.frequency} · ${d.feeItemsAdded} fee items` : ''}${d.error ? ` · ${d.error}` : ''}`;
    case 'ai.fee_type_added':
      return `Result: ${d.result}${d.name ? ` · ${d.name}` : ''}${d.error ? ` · ${d.error}` : ''}`;
    case 'ai.cancelled':
      return d.title ?? '';
    case 'attendance.saved':
      return `${d.class} · ${d.date} · ${d.present} present, ${d.absent} absent${d.leave ? `, ${d.leave} leave` : ''}`;
    case 'timetable.changed':
      return `Day ${d.day}, period ${d.period}: ${d.subject ?? '—'} · ${d.teacher ?? 'no teacher'}`;
    case 'teacher.classes':
      return (d.classes ?? []).join(', ') || 'No classes';
    case 'parent.code_issued':
    case 'parent.enabled':
    case 'parent.disabled':
      return (d.children ?? []).join(', ');
    default:
      return Object.keys(d).length ? JSON.stringify(d) : '';
  }
}

export async function auditView(root) {
  const filters = { action: '', actor: '', from: '', to: '', via: '' };
  let offset = 0;
  let entries = [];
  let total = 0;
  let actions = [];

  async function load({ append = false } = {}) {
    offset = append ? entries.length : 0;
    const data = await api(`/api/admin/audit?${new URLSearchParams({ ...compact(filters), limit: 100, offset })}`);
    entries = append ? [...entries, ...data.entries] : data.entries;
    total = data.total;
    actions = data.actions;
    renderTable();
  }

  function renderTable() {
    root.querySelector('[data-actions]').innerHTML = String(
      html`<option value="">All actions</option>${actions.map((a) => html`<option value="${a}" ${a === filters.action ? 'selected' : ''}>${ACTIONS[a] ?? a}</option>`)}`,
    );
    root.querySelector('[data-table]').innerHTML = String(html`
      <div class="result-bar"><span><strong>${total}</strong> entries</span>${exportButtons('/api/admin/export/audit', compact(filters))}</div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
          <tbody>
            ${entries.map(
              (e) => html`
                <tr>
                  <td class="nowrap muted">${formatDateTime(e.at)}</td>
                  <td>
                    ${e.actor.startsWith('gateway:') ? `Payment gateway (${e.actor.slice(8)})` : e.actor.replace(/^staff:\d+ /, '').replace(/[()]/g, '')}
                    ${e.via ? html`<span class="ai-chip">via ${e.via}</span>` : ''}
                  </td>
                  <td class="strong">${ACTIONS[e.action] ?? e.action}</td>
                  <td class="audit-details">${describe(e)}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
      ${entries.length < total ? html`<div class="load-more"><button type="button" class="btn btn--small" data-more>Show more</button></div>` : ''}
    `);
  }

  mount(
    root,
    html`
      <div class="page">
        ${pageHead('Audit Logs', 'Every payment, correction, receipt, student change, fee change, export and login, including changes confirmed through the KBS AI Assistant. Entries cannot be edited or deleted.')}
        <section class="panel">
          <form class="filters" data-filters>
            <label class="field">Action<select class="control" name="action" data-actions></select></label>
            <label class="field">Who<input class="control" name="actor" placeholder="Name" /></label>
            <label class="field">From<input class="control" type="date" name="from" /></label>
            <label class="field">To<input class="control" type="date" name="to" /></label>
            <label class="field">Made through<select class="control" name="via"><option value="">Anything</option><option value="ai">KBS AI Assistant only</option></select></label>
          </form>
          <div data-table></div>
        </section>
      </div>
    `,
  );

  const form = root.querySelector('[data-filters]');
  let typing = null;
  const apply = () => {
    for (const key of Object.keys(filters)) filters[key] = form.elements[key].value;
    load().catch((err) => toast(err.message, { tone: 'error' }));
  };
  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('change', apply);
  form.addEventListener('input', (e) => {
    if (e.target.name !== 'actor') return;
    clearTimeout(typing);
    typing = setTimeout(apply, 300);
  });
  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-more]')) load({ append: true }).catch((err) => toast(err.message, { tone: 'error' }));
  });

  await load();
}
