import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';
import { icon } from '../../lib/icons.js';
import { pageHead, payBadge } from '../components.js';
import { bindReceiptActions, receiptLinks } from '../receipt-actions.js';
import { insightsBody } from '../assistant.js';
import { session } from '../session.js';
import { formatDate, formatTime, greeting, hourNow, istDate, rupees, todayIso } from '/shared/format.js';

const when = (iso) => (istDate(iso) === todayIso() ? `Today, ${formatTime(iso)}` : `${formatDate(iso, { year: false })}, ${formatTime(iso)}`);

function recentTable(rows) {
  if (!rows.length) return html`<p class="panel-empty">No payments yet.</p>`;
  return html`
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>When</th><th>Student</th><th>Receipt No.</th><th class="num">Amount</th><th>Mode</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${rows.map(
            (p) => html`
              <tr>
                <td class="muted nowrap">${when(p.at)}</td>
                <td><span class="strong">${p.student.name}</span><span class="sub">${p.student.classLabel}</span></td>
                <td class="mono nowrap">${p.receiptNo ?? '—'}</td>
                <td class="num strong nowrap">${rupees(p.amount)}</td>
                <td>${p.paymentId ? p.method : 'Online'}<span class="sub">${p.channel === 'online' ? 'Online' : p.collectedBy}</span></td>
                <td>${payBadge(p.status)}</td>
                <td>${p.paymentId ? receiptLinks(p.paymentId, { status: p.status, correctionPending: p.correctionPending, whatsapp: p.whatsapp }) : html`<span class="muted" style="font-size: 12px">${p.failureReason ?? 'Awaiting gateway'}</span>`}</td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    </div>
  `;
}

function classTable(classes) {
  return html`
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Class</th><th class="num">Students</th><th style="width: 30%">Paid students</th><th class="num">Pending students</th><th class="num">Collected</th><th class="num">Pending amount</th></tr></thead>
        <tbody>
          ${classes.map(
            (c) => html`
              <tr>
                <td class="strong"><a class="link-button" href="/admin/payments?grade=${encodeURIComponent(c.grade)}" style="color: inherit">${c.grade}</a></td>
                <td class="num">${c.totalStudents}</td>
                <td>
                  <div class="class-progress-line"><span>${c.paidStudents} paid</span><span class="muted">${c.totalStudents ? Math.round((c.paidStudents / c.totalStudents) * 100) : 0}%</span></div>
                  <div class="meter"><div class="meter-fill" style="width: ${c.totalStudents ? Math.round((c.paidStudents / c.totalStudents) * 100) : 0}%"></div></div>
                </td>
                <td class="num">${c.pendingStudents}</td>
                <td class="num">${rupees(c.collected)}</td>
                <td class="num strong" style="color: ${c.pending ? 'var(--pending-ink)' : 'inherit'}">${c.pending ? rupees(c.pending) : '—'}</td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    </div>
  `;
}

export async function dashboardView(root) {
  const { school, staff } = session.meta;

  async function render() {
    const [d, ai] = await Promise.all([
      api('/api/admin/dashboard'),
      session.meta.assistant ? api('/api/admin/assistant/insights').catch(() => null) : null,
    ]);
    mount(
      root,
      html`
        <div class="page">
          ${pageHead(
            school.shortName,
            `${greeting(hourNow())}, ${staff.name.split(' ')[0]}. Fee position on ${formatDate(d.today)}.`,
            html`
              ${session.can('payments.collect') ? html`<a class="btn btn--primary" href="/admin/cash">${icon('rupee', 18)} Cash Collection</a>` : ''}
              ${session.can('students.edit') ? html`<a class="btn" href="/admin/students/new">${icon('userPlus', 18)} Add Student</a>` : ''}
              <a class="btn" href="/admin/payments">Payments</a>
            `,
          )}
          ${session.meta.pendingCorrections
            ? html`<div class="banner"><span><strong>${session.meta.pendingCorrections} payment correction${session.meta.pendingCorrections === 1 ? '' : 's'}</strong> waiting for your approval.</span><a class="btn btn--dark" href="/admin/corrections">Review</a></div>`
            : ''}

          <div class="tiles">
            <div class="tile tile--accent">
              <span class="tile-label">Today’s Collection</span>
              <span class="tile-value">${rupees(d.todayCollection.amount)}</span>
              <span class="tile-sub">${d.todayCollection.count} ${d.todayCollection.count === 1 ? 'payment' : 'payments'} today</span>
            </div>
            <div class="tile">
              <span class="tile-label">This Month’s Collection</span>
              <span class="tile-value">${rupees(d.monthCollection.amount)}</span>
              <span class="tile-sub">${d.monthCollection.count} payments in ${d.monthLabel}</span>
            </div>
            <div class="tile">
              <span class="tile-label">Total Paid Students</span>
              <span class="tile-value">${d.students.paid} <span class="muted" style="font-size: 16px">of ${d.students.total}</span></span>
              <span class="tile-sub">Nothing due right now</span>
            </div>
            <div class="tile">
              <span class="tile-label">Pending Fees</span>
              <span class="tile-value">${rupees(d.pendingFees.amount)}</span>
              <span class="tile-sub ${d.pendingFees.overdue ? 'tile-sub--warn' : ''}">
                ${d.pendingFees.students} students${d.pendingFees.overdue ? ` · ${rupees(d.pendingFees.overdue)} overdue` : ''}
              </span>
            </div>
          </div>

          ${ai
            ? html`
                <section class="panel ai-summary" aria-labelledby="ai-summary-title">
                  <div class="panel-head">
                    <h2 class="panel-title" id="ai-summary-title"><span class="ai-mark" aria-hidden="true">${icon('sparkle', 16)}</span> KBS AI Daily Summary</h2>
                    <button type="button" class="btn btn--small" data-ask-ai>${icon('sparkle', 15)} Ask KBS AI</button>
                  </div>
                  <div class="panel-body">${insightsBody(ai)}</div>
                </section>
              `
            : ''}

          <div class="page-head-text" style="gap: 20px">
            <section class="panel">
              <div class="panel-head">
                <h2 class="panel-title">Recent Payments</h2>
                <a class="link-button" href="/admin/payments">All payments</a>
              </div>
              ${recentTable(d.recentPayments)}
            </section>
            <section class="panel">
              <div class="panel-head">
                <h2 class="panel-title">Class-wise fee position</h2>
                <a class="link-button" href="/admin/classes">Class cards and exports</a>
              </div>
              ${classTable(d.classes)}
            </section>
          </div>

          ${d.progress
            ? html`
                <section class="panel">
                  <div class="panel-head">
                    <h2 class="panel-title">${d.progress.monthLabel} progress reports</h2>
                    <a class="link-button" href="/admin/progress">Enter progress</a>
                  </div>
                  <div class="panel-body" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px">
                    ${d.progress.classes.map(
                      (r) => html`
                        <a class="class-progress" href="/admin/progress?class=${r.classId}" style="color: inherit; text-decoration: none">
                          <div class="class-progress-line"><strong>${r.className}</strong><span class="muted">${r.published}/${r.total}</span></div>
                          <div class="meter"><div class="meter-fill" style="width: ${r.total ? Math.round((r.published / r.total) * 100) : 0}%"></div></div>
                        </a>
                      `,
                    )}
                  </div>
                </section>
              `
            : ''}
        </div>
      `,
    );
  }

  bindReceiptActions(root);
  root.addEventListener('click', (event) => {
    if (event.target.closest('[data-ask-ai]')) document.dispatchEvent(new CustomEvent('kbs:open-assistant'));
  });
  await render();

  // Refresh when a payment is confirmed anywhere (online or at another counter).
  let pending = null;
  const refresh = () => {
    clearTimeout(pending);
    pending = setTimeout(() => render().catch(() => {}), 400);
  };
  document.addEventListener('kbs:payment', refresh);
  document.addEventListener('kbs:payment-failed', refresh);
  document.addEventListener('kbs:whatsapp', refresh);
  document.addEventListener('kbs:assistant-change', refresh);
  return () => {
    clearTimeout(pending);
    document.removeEventListener('kbs:payment', refresh);
    document.removeEventListener('kbs:payment-failed', refresh);
    document.removeEventListener('kbs:whatsapp', refresh);
    document.removeEventListener('kbs:assistant-change', refresh);
  };
}
