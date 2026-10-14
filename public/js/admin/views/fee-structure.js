import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';
import { icon } from '../../lib/icons.js';
import { toast } from '../../lib/toast.js';
import { compact, exportButtons, gradeOptions, openModal, options, pageHead } from '../components.js';
import { session } from '../session.js';
import { formatDate, rupees } from '/shared/format.js';

// Fee Structure (admin): fee types and the fees each class pays. Editing a
// fee changes only unpaid instalments; paid ones and their receipts stay as they were.

const FREQUENCY_HINT = {
  Monthly: 'One instalment every month from the first due date to March',
  Quarterly: 'Every three months from the first due date',
  'Half-Yearly': 'Every six months from the first due date',
  Yearly: 'Once in the session',
  'One-Time': 'Once',
  Custom: 'Your own instalments, each with a name and due date',
};

function scheduleRow(item = {}) {
  return html`
    <div class="schedule-row">
      <input class="control" name="scheduleLabel" placeholder="Name, e.g. Term 1" value="${item.label ?? ''}" maxlength="30" aria-label="Instalment name" />
      <input class="control" type="date" name="scheduleDate" value="${item.dueDate ?? ''}" aria-label="Due date" />
      <button type="button" class="link-button link-button--danger" data-remove-row>Remove</button>
    </div>
  `;
}

function feeForm(meta, feeTypes, f, editing) {
  const custom = f.frequency === 'Custom';
  return html`
    <div class="form-grid">
      <label class="field">Fee type
        <select class="control" name="feeTypeId">${feeTypes.map((t) => html`<option value="${t.id}" ${t.id === f.feeTypeId ? 'selected' : ''}>${t.name}</option>`)}</select>
      </label>
      <label class="field">Fee name (on receipts)<input class="control" name="name" value="${f.name ?? ''}" maxlength="60" placeholder="e.g. Tuition Fee" /></label>
      <label class="field">Class
        <select class="control" name="grade" ${editing ? 'disabled' : ''}>${gradeOptions(meta.grades, f.grade ?? '', { all: 'All classes' })}</select>
      </label>
      <label class="field">Applicable session
        <select class="control" name="session" ${editing ? 'disabled' : ''}>${options(meta.sessions, f.session ?? meta.session)}</select>
      </label>
      <label class="field">Amount per instalment (₹)<input class="control" type="number" min="1" step="1" name="amount" value="${f.amount ?? ''}" required /></label>
      <label class="field">Frequency
        <select class="control" name="frequency" data-frequency>${options(meta.frequencies, f.frequency ?? 'Monthly')}</select>
        <span class="hint" data-frequency-hint>${FREQUENCY_HINT[f.frequency ?? 'Monthly']}</span>
      </label>
      <label class="field" data-first-due ${custom ? 'hidden' : ''}>First due date<input class="control" type="date" name="firstDueDate" value="${f.firstDueDate ?? ''}" /></label>
      <label class="field">Late fee (₹, once per overdue instalment)<input class="control" type="number" min="0" step="1" name="lateFee" value="${f.lateFee ?? 0}" /></label>
    </div>
    <div class="field" data-schedule ${custom ? '' : 'hidden'}>Instalments
      <div class="schedule-rows">${(f.schedule?.length ? f.schedule : [{}, {}]).map(scheduleRow)}</div>
      <button type="button" class="btn btn--small" data-add-row style="align-self: flex-start">+ Add instalment</button>
    </div>
    <div class="check-row">
      <label class="check-field"><input type="radio" name="compulsory" value="true" ${f.compulsory !== false ? 'checked' : ''} /> Compulsory (charged to every student it applies to)</label>
      <label class="check-field"><input type="radio" name="compulsory" value="false" ${f.compulsory === false ? 'checked' : ''} /> Optional (added to chosen students)</label>
    </div>
    <div class="check-row">
      <label class="check-field"><input type="checkbox" name="transportOnly" ${f.transportOnly ? 'checked' : ''} /> Only for students who use school transport</label>
      <label class="check-field"><input type="checkbox" name="newAdmissionsOnly" ${f.newAdmissionsOnly ? 'checked' : ''} /> Only for new admissions</label>
      ${editing
        ? html`
            <label class="check-field"><input type="checkbox" name="active" ${f.active ? 'checked' : ''} /> Active (untick to stop charging it)</label>
            <label class="check-field"><input type="checkbox" name="includeOverdue" /> Also change unpaid instalments that are already overdue</label>
          `
        : html`<label class="check-field"><input type="checkbox" name="applyToExisting" checked /> Add it to existing students now</label>`}
    </div>
  `;
}

function readForm(form, editing) {
  const data = Object.fromEntries(new FormData(form));
  const labels = [...form.querySelectorAll('[name="scheduleLabel"]')].map((i) => i.value);
  const dates = [...form.querySelectorAll('[name="scheduleDate"]')].map((i) => i.value);
  const body = {
    feeTypeId: Number(data.feeTypeId),
    name: data.name,
    amount: data.amount,
    frequency: data.frequency,
    firstDueDate: data.firstDueDate,
    schedule: labels.map((label, i) => ({ label, dueDate: dates[i] })),
    lateFee: data.lateFee || 0,
    compulsory: data.compulsory === 'true',
    transportOnly: Boolean(data.transportOnly),
    newAdmissionsOnly: Boolean(data.newAdmissionsOnly),
  };
  if (editing) {
    body.active = Boolean(data.active);
    body.includeOverdue = Boolean(data.includeOverdue);
  } else {
    body.grade = data.grade;
    body.session = data.session;
    body.applyToExisting = Boolean(data.applyToExisting);
  }
  return body;
}

export async function feeStructureView(root, ctx) {
  const meta = session.meta;
  const filters = { session: ctx.query.get('session') ?? meta.session, grade: ctx.query.get('grade') ?? '', feeTypeId: '', includeInactive: '' };
  let data = null;

  async function load() {
    data = await api(`/api/admin/fee-structure?${new URLSearchParams(compact(filters))}`);
    render();
  }

  function render() {
    mount(
      root,
      html`
        <div class="page">
          ${pageHead(
            'Fee Structure',
            'Fees for each class and session. Changes apply to unpaid instalments only; completed payments never change.',
            html`
              <button type="button" class="btn" data-add-type>+ Add fee type</button>
              <button type="button" class="btn btn--primary" data-add-fee>${icon('plus', 16)} Add fee</button>
            `,
          )}
          <section class="panel">
            <div class="panel-head"><h2 class="panel-title">Fee types</h2><span class="muted">${data.feeTypes.length} types</span></div>
            <div class="type-chips">${data.feeTypes.map((t) => html`<span class="type-chip">${t.name}<span>${t.structures}</span></span>`)}</div>
          </section>
          <section class="panel">
            <form class="filters" data-filters>
              <label class="field">Session<select class="control" name="session">${options(meta.sessions, filters.session)}</select></label>
              <label class="field">Class<select class="control" name="grade">${gradeOptions(meta.grades, filters.grade)}</select></label>
              <label class="field">Fee type
                <select class="control" name="feeTypeId"><option value="">All types</option>${data.feeTypes.map((t) => html`<option value="${t.id}" ${String(t.id) === filters.feeTypeId ? 'selected' : ''}>${t.name}</option>`)}</select>
              </label>
              <label class="check-field"><input type="checkbox" name="includeInactive" ${filters.includeInactive ? 'checked' : ''} /> Show stopped fees</label>
            </form>
            <div class="result-bar">
              <span><strong>${data.structures.length}</strong> fees</span>
              ${exportButtons('/api/admin/export/fee-structure', compact({ session: filters.session, grade: filters.grade }))}
            </div>
            <div class="table-wrap">
              <table class="table table--compact">
                <thead>
                  <tr><th>Fee</th><th>Class</th><th class="num">Amount</th><th>Frequency</th><th>First due</th><th class="num">Late fee</th><th>Applies to</th><th class="num">Billed</th><th class="num">Collected</th><th class="num">Pending</th><th></th></tr>
                </thead>
                <tbody>
                  ${data.structures.map(
                    (f) => html`
                      <tr style="${f.active ? '' : 'opacity: 0.55'}">
                        <td><span class="strong">${f.name}</span>${f.feeType !== f.name || !f.active ? html`<span class="sub">${f.feeType !== f.name ? f.feeType : ''}${f.active ? '' : ' stopped'}</span>` : ''}</td>
                        <td class="nowrap">${f.grade ?? 'All classes'}</td>
                        <td class="num strong">${rupees(f.amount)}</td>
                        <td class="nowrap">${f.frequency}<span class="sub">${f.instalmentCount} × instalment</span></td>
                        <td class="nowrap">${formatDate(f.firstDueDate)}</td>
                        <td class="num">${f.lateFee ? rupees(f.lateFee) : '—'}</td>
                        <td>${f.compulsory ? 'Compulsory' : 'Optional'}${f.transportOnly ? html`<span class="sub">Transport students</span>` : ''}${f.newAdmissionsOnly ? html`<span class="sub">New admissions</span>` : ''}</td>
                        <td class="num">${rupees(f.billed)}<span class="sub">${f.students} students</span></td>
                        <td class="num" style="color: var(--paid-ink)">${rupees(f.collected)}</td>
                        <td class="num strong" style="color: ${f.pending ? 'var(--pending-ink)' : 'inherit'}">${rupees(f.pending)}</td>
                        <td><button type="button" class="link-button" data-edit="${f.id}">Edit</button></td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            </div>
            ${data.structures.length ? '' : html`<p class="panel-empty">No fees for these filters.</p>`}
          </section>
        </div>
      `,
    );
  }

  function openFeeForm(existing) {
    const editing = Boolean(existing);
    const values = existing ?? { session: filters.session, grade: filters.grade || null, frequency: 'Monthly', compulsory: true, lateFee: 0 };
    const dialog = openModal(
      String(html`
        <h2 class="modal-title">${editing ? `Edit ${existing.name} (${existing.grade ?? 'All classes'})` : 'Add a fee'}</h2>
        ${editing ? html`<p class="muted" style="margin: 0; font-size: 14px">Paid instalments and receipts are never changed.</p>` : ''}
        <form class="modal-body" style="padding: 0" novalidate>
          ${feeForm(meta, data.feeTypes, values, editing)}
          <p class="form-error" role="alert" hidden></p>
          <div class="form-actions">
            <button type="button" class="btn" data-close>Cancel</button>
            <button type="submit" class="btn btn--primary">${editing ? 'Save changes' : 'Add fee'}</button>
          </div>
        </form>
      `),
      { label: editing ? 'Edit fee' : 'Add a fee', wide: true },
    );
    const form = dialog.querySelector('form');
    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    form.addEventListener('change', (event) => {
      if (!event.target.matches('[data-frequency]')) return;
      const custom = event.target.value === 'Custom';
      form.querySelector('[data-schedule]').hidden = !custom;
      form.querySelector('[data-first-due]').hidden = custom;
      form.querySelector('[data-frequency-hint]').textContent = FREQUENCY_HINT[event.target.value];
    });
    form.addEventListener('click', (event) => {
      if (event.target.closest('[data-add-row]')) {
        form.querySelector('.schedule-rows').insertAdjacentHTML('beforeend', String(scheduleRow()));
      } else if (event.target.closest('[data-remove-row]')) {
        event.target.closest('.schedule-row').remove();
      }
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('[type="submit"]');
      button.disabled = true;
      try {
        const body = readForm(form, editing);
        const result = editing
          ? await api(`/api/admin/fee-structure/${existing.id}`, { method: 'PUT', body })
          : await api('/api/admin/fee-structure', { method: 'POST', body });
        dialog.close();
        toast(
          editing
            ? `Saved. ${result.updated} unpaid instalments updated, ${result.added} added, ${result.removed} removed.`
            : `Fee added with ${result.structure.instalments.length} instalment(s); ${result.added} fee items created for students.`,
          { duration: 5000 },
        );
        await load();
      } catch (err) {
        const box = form.querySelector('.form-error');
        box.textContent = err.message;
        box.hidden = false;
        button.disabled = false;
      }
    });
  }

  function addFeeType() {
    const dialog = openModal(
      String(html`
        <h2 class="modal-title">Add a fee type</h2>
        <form class="modal-body" style="padding: 0" novalidate>
          <label class="field">Name<input class="control" name="name" placeholder="e.g. Smart Class Fee" maxlength="40" required /></label>
          <p class="form-error" role="alert" hidden></p>
          <div class="form-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn btn--primary">Add fee type</button></div>
        </form>
      `),
      { label: 'Add a fee type' },
    );
    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    dialog.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const { feeType } = await api('/api/admin/fee-types', { method: 'POST', body: { name: event.target.name.value } });
        dialog.close();
        toast(`“${feeType.name}” added. You can now add fees of this type.`);
        await load();
      } catch (err) {
        const box = event.target.querySelector('.form-error');
        box.textContent = err.message;
        box.hidden = false;
      }
    });
  }

  root.addEventListener('click', async (event) => {
    if (event.target.closest('[data-add-type]')) addFeeType();
    else if (event.target.closest('[data-add-fee]')) openFeeForm(null);
    else if (event.target.closest('[data-edit]')) {
      const { structure } = await api(`/api/admin/fee-structure/${event.target.closest('[data-edit]').dataset.edit}`);
      openFeeForm(structure);
    }
  });
  root.addEventListener('change', (event) => {
    const form = event.target.closest('[data-filters]');
    if (!form) return;
    filters.session = form.elements.session.value;
    filters.grade = form.elements.grade.value;
    filters.feeTypeId = form.elements.feeTypeId.value;
    filters.includeInactive = form.elements.includeInactive.checked ? 'true' : '';
    load().catch((err) => toast(err.message, { tone: 'error' }));
  });

  await load();
}
