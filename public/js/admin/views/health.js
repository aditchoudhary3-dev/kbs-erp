import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';
import { pageHead } from '../components.js';
import { formatDateTime } from '/shared/format.js';

// System Health: is everything working, and what needs attention.

const LABEL = { ok: 'All good', warn: 'Needs attention', error: 'Problem' };
const size = (bytes) => (bytes > 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`);

export async function healthView(root) {
  const h = await api('/api/admin/system/health');
  const fact = (label, value) => html`<div><dt>${label}</dt><dd>${value ?? '—'}</dd></div>`;
  mount(
    root,
    html`
      <div class="page">
        ${pageHead('System Health', `Checked ${formatDateTime(new Date().toISOString())}.`, html`<a class="btn" href="/admin/health">Check again</a>`)}
        <section class="panel">
          <div class="panel-head">
            <h2 class="panel-title"><span class="health-dot health-dot--${h.status}" style="display: inline-block; margin-right: 8px"></span>${LABEL[h.status]}</h2>
          </div>
          <div class="health-list">
            ${h.checks.map(
              (c) => html`
                <div class="health-row">
                  <span class="health-dot health-dot--${c.status}" aria-label="${LABEL[c.status]}"></span>
                  <span class="strong" style="min-width: 220px">${c.name}</span>
                  <span class="muted">${c.detail}</span>
                </div>
              `,
            )}
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2 class="panel-title">Details</h2></div>
          <div class="panel-body">
            <dl class="profile-grid">
              ${fact('Application', h.app.name)}
              ${fact('Database version', h.app.schemaVersion)}
              ${fact('Running since', `${formatDateTime(h.app.startedAt)} (${h.app.uptimeHours} h)`)}
              ${fact('Node.js', h.app.node)}
              ${fact('Active students', h.database.students)}
              ${fact('Inactive students', h.database.inactiveStudents)}
              ${fact('Payments', h.database.payments)}
              ${fact('Cancelled payments', h.database.cancelledPayments)}
              ${fact('Last payment', h.database.lastPaymentAt && formatDateTime(h.database.lastPaymentAt))}
              ${fact('Last gateway webhook', h.database.lastWebhookAt && formatDateTime(h.database.lastWebhookAt))}
              ${fact('Database size', size(h.database.sizeBytes))}
              ${fact('Audit log entries', h.database.auditEntries)}
              ${fact('Backups kept', h.backups.count)}
              ${fact('Free disk space', h.disk && `${(h.disk.free / 1024 ** 3).toFixed(1)} GB`)}
            </dl>
          </div>
        </section>
      </div>
    `,
  );
}
