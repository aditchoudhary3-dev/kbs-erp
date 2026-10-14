import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';
import { icon } from '../../lib/icons.js';
import { toast } from '../../lib/toast.js';
import { openModal, pageHead, payBadge } from '../components.js';
import { bindReceiptActions, receiptLinks } from '../receipt-actions.js';
import { session } from '../session.js';
import { formatDate, formatPhone, rupees } from '/shared/format.js';

function itemStatus(item, today, horizon) {
  if (item.paid) return html`<span class="pay-badge pay-badge--paid">Paid</span><span class="sub mono">${item.receiptNo}</span>`;
  if (item.dueDate < today) return html`<span class="pay-badge pay-badge--overdue">Overdue</span>`;
  if (item.dueDate <= horizon) return html`<span class="pay-badge pay-badge--pending">Due</span>`;
  return html`<span class="pay-badge pay-badge--inactive">Upcoming</span>`;
}

export async function studentProfileView(root, ctx) {
  const meta = session.meta;
  const id = Number(ctx.params.id);
  const justAdded = ctx.query.get('added') === '1';

  async function render() {
    const data = await api(`/api/admin/students/${id}`);
    const { student, account, payments, due } = data;
    const horizon = new Date(Date.parse(`${meta.today}T00:00:00Z`) + meta.dueWindowDays * 86_400_000).toISOString().slice(0, 10);
    const optional = session.can('fees.manage')
      ? (await api(`/api/admin/fee-structure?grade=${encodeURIComponent(student.grade)}&session=${student.session}`)).structures.filter((s) => !s.compulsory)
      : [];
    const detail = (label, value) => html`<div><dt>${label}</dt><dd>${value || '—'}</dd></div>`;

    mount(
      root,
      html`
        <div class="page">
          ${justAdded ? html`<div class="success-banner" role="status">${icon('check', 20, 2.5)} Student added successfully. Their fee account has been created.</div>` : ''}
          ${pageHead(
            student.name,
            html`${student.code} · ${student.admissionNo} · ${student.classLabel} · Roll no. ${student.rollNo} ${payBadge(student.status === 'Active' ? 'ACTIVE' : 'INACTIVE')}`,
            html`
              ${session.can('payments.collect') && student.active && due.total ? html`<a class="btn btn--primary" href="/admin/cash?student=${student.id}">${icon('rupee', 18)} Collect fee</a>` : ''}
              ${session.can('students.edit') ? html`<a class="btn" href="/admin/students/${student.id}/edit">${icon('edit', 16)} Edit</a>` : ''}
              ${session.can('students.edit')
                ? student.active
                  ? html`<button type="button" class="btn" data-deactivate>Deactivate</button>`
                  : html`<button type="button" class="btn btn--primary" data-reactivate>Reactivate</button>`
                : ''}
            `,
          )}
          ${student.active ? '' : html`<div class="banner"><span><strong>Inactive</strong> since ${formatDate(student.deactivatedAt)}. Payments and receipts are kept; no new fees are charged.</span></div>`}

          <section class="panel">
            <div class="panel-body">
              <dl class="profile-grid">
                ${detail('Date of Birth', student.dob && formatDate(student.dob))}
                ${detail('Gender', student.gender)}
                ${detail('Father’s Name', student.fatherName)}
                ${detail('Mother’s Name', student.motherName)}
                ${detail('Mobile', `+91 ${formatPhone(student.parentPhone)}`)}
                ${detail('Alternate Mobile', student.altPhone && `+91 ${formatPhone(student.altPhone)}`)}
                ${detail('WhatsApp', `+91 ${formatPhone(student.whatsappPhone)}`)}
                ${detail('Session', student.session)}
                ${detail('Admission Date', student.admissionDate && formatDate(student.admissionDate))}
                ${detail('Transport', student.transport ? `Yes · ${student.busRoute}` : 'No')}
                ${detail('Address', student.address)}
                ${detail('Remarks', student.remarks)}
              </dl>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <h2 class="panel-title">Fee account</h2>
              <span class="muted">Due now ${rupees(due.total)}${due.upcomingTotal ? ` · upcoming ${rupees(due.upcomingTotal)}` : ''}</span>
            </div>
            ${optional.length && student.active
              ? html`
                  <form class="report-params" data-optional>
                    <label class="field">Add an optional fee
                      <select class="control" name="structureId">${optional.map((o) => html`<option value="${o.id}">${o.name} · ${rupees(o.amount)} ${o.frequency.toLowerCase()}</option>`)}</select>
                    </label>
                    <button type="submit" class="btn btn--small">Add to this student</button>
                  </form>
                `
              : ''}
            ${account.length
              ? html`
                  <div class="table-wrap">
                    <table class="table">
                      <thead><tr><th>Fee</th><th>Type</th><th>Due date</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead>
                      <tbody>
                        ${account.map(
                          (item) => html`
                            <tr>
                              <td class="strong">${item.title}</td>
                              <td>${item.feeType}</td>
                              <td class="nowrap">${formatDate(item.dueDate)}</td>
                              <td class="num strong">${rupees(item.amount)}</td>
                              <td>${itemStatus(item, meta.today, horizon)}</td>
                              <td>${!item.paid && session.can('fees.manage') ? html`<button type="button" class="link-button link-button--danger" data-waive="${item.id}">Waive</button>` : ''}</td>
                            </tr>
                          `,
                        )}
                      </tbody>
                    </table>
                  </div>
                `
              : html`<p class="panel-empty">No fees yet.</p>`}
          </section>

          <section class="panel">
            <div class="panel-head"><h2 class="panel-title">Payments</h2><span class="muted">${payments.length} records</span></div>
            ${payments.length
              ? html`
                  <div class="table-wrap">
                    <table class="table">
                      <thead><tr><th>Date</th><th>Receipt No.</th><th>Mode</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead>
                      <tbody>
                        ${payments.map(
                          (p) => html`
                            <tr>
                              <td class="nowrap">${formatDate(p.at)}</td>
                              <td class="mono">${p.receiptNo ?? '—'}</td>
                              <td>${p.method}<span class="sub">${p.collectedBy}</span></td>
                              <td class="num strong">${rupees(p.amount)}</td>
                              <td>${payBadge(p.status)}</td>
                              <td>${p.paymentId ? receiptLinks(p.paymentId, { status: p.status, correctionPending: p.correctionPending, whatsapp: p.whatsapp }) : ''}</td>
                            </tr>
                          `,
                        )}
                      </tbody>
                    </table>
                  </div>
                `
              : html`<p class="panel-empty">No payments yet.</p>`}
          </section>
        </div>
      `,
    );
  }

  function askReason() {
    return new Promise((resolve) => {
      const dialog = openModal(
        String(html`
          <h2 class="modal-title">Deactivate this student?</h2>
          <p class="muted" style="margin: 0">Payments and receipts are kept. Unpaid fees that are not yet due are removed. You can reactivate later.</p>
          <form class="modal-body" style="padding: 0">
            <label class="field">Reason<input class="control" name="reason" placeholder="e.g. Left school, transfer certificate issued" required /></label>
            <div class="form-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn btn--primary">Deactivate</button></div>
          </form>
        `),
        { label: 'Deactivate student' },
      );
      dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
      dialog.addEventListener('close', () => resolve(null));
      dialog.querySelector('form').addEventListener('submit', (event) => {
        event.preventDefault();
        const reason = event.target.reason.value.trim();
        resolve(reason);
        dialog.close();
      });
    });
  }

  bindReceiptActions(root);
  root.addEventListener('click', async (event) => {
    try {
      if (event.target.closest('[data-deactivate]')) {
        const reason = await askReason();
        if (!reason) return;
        const result = await api(`/api/admin/students/${id}/status`, { method: 'POST', body: { active: false, reason } });
        toast(`Deactivated. ${result.feeAccount.removed} future fee items removed; payments kept.`);
        await render();
      } else if (event.target.closest('[data-reactivate]')) {
        const result = await api(`/api/admin/students/${id}/status`, { method: 'POST', body: { active: true } });
        toast(`Reactivated. ${result.feeAccount.added} fee items added back.`);
        await render();
      } else if (event.target.closest('[data-waive]')) {
        const reason = window.prompt('Why is this fee being waived? This is recorded in the audit log.');
        if (!reason) return;
        await api(`/api/admin/fee-items/${event.target.closest('[data-waive]').dataset.waive}`, { method: 'DELETE', body: { reason } });
        toast('Fee waived and recorded in the audit log.');
        await render();
      }
    } catch (err) {
      toast(err.message, { tone: 'error' });
    }
  });
  root.addEventListener('submit', async (event) => {
    if (!event.target.matches('[data-optional]')) return;
    event.preventDefault();
    try {
      const result = await api(`/api/admin/students/${id}/optional-fees`, { method: 'POST', body: { structureId: Number(event.target.structureId.value) } });
      toast(result.added ? `Added ${result.added} instalments.` : 'This fee was already on the student’s account.');
      await render();
    } catch (err) {
      toast(err.message, { tone: 'error' });
    }
  });

  await render();
}
