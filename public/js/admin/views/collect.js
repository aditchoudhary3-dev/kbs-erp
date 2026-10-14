import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';
import { icon } from '../../lib/icons.js';
import { toast } from '../../lib/toast.js';
import { gradeOptions, openModal, pageHead, payBadge } from '../components.js';
import { bindCard, confirmationCard, markShown } from '../live.js';
import { bindReceiptActions, receiptLinks } from '../receipt-actions.js';
import { session } from '../session.js';
import { formatDate, formatPhone, formatTime, initials, rupees } from '/shared/format.js';

// Cash Collection: find the student, tick what the parent is paying, enter the
// amount received, confirm on the confirmation screen, then the receipt is
// generated. A completed payment can only be corrected through an admin.

const REFERENCE = {
  UPI: { label: 'UPI reference number', placeholder: '12-digit UTR from the parent’s app' },
  Cheque: { label: 'Cheque number and bank', placeholder: 'e.g. 482913, SBI Shahpur' },
  'Bank transfer': { label: 'UTR / transfer reference', placeholder: 'From the bank statement' },
  Card: { label: 'Card terminal reference', placeholder: 'Approval code on the slip' },
  Other: { label: 'Reference or note', placeholder: 'Optional' },
};

const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export async function collectView(root, ctx) {
  const meta = session.meta;
  let query = '';
  let grade = '';
  let results = [];
  let selected = null; // { student, due, payments }
  let completed = null; // last payment made here
  let method = 'Cash';
  let idempotencyKey = newKey();
  let searchTimer = null;

  async function search() {
    results = query.trim() || grade ? (await api(`/api/admin/students?${new URLSearchParams({ q: query, grade, limit: 40 })}`)).students : [];
    renderResults();
  }

  async function select(id, { keepCompleted = false } = {}) {
    const [profile, dues] = await Promise.all([api(`/api/admin/students/${id}`), api(`/api/admin/students/${id}/dues`)]);
    selected = { student: profile.student, due: dues.due, payments: profile.payments };
    if (!keepCompleted) completed = null;
    idempotencyKey = newKey();
    history.replaceState(null, '', `/admin/cash?student=${id}`);
    renderResults();
    renderStudent();
  }

  function renderResults() {
    const list = root.querySelector('[data-results]');
    if (!list) return;
    list.innerHTML = String(
      results.length
        ? html`${results.map(
            (s) => html`
              <button type="button" class="search-result" data-student="${s.id}" aria-current="${selected?.student.id === s.id}">
                <span><span class="strong">${s.name}</span><span class="sub">${s.classLabel} · ${s.admissionNo} · ${s.code}</span></span>
                ${s.due ? html`<span class="pay-badge ${s.overdue ? 'pay-badge--overdue' : 'pay-badge--pending'}">${rupees(s.due)}</span>` : html`<span class="pay-badge pay-badge--paid">Paid</span>`}
              </button>
            `,
          )}`
        : html`<p class="panel-empty">${query || grade ? 'No students match.' : 'Search by student name, admission number or student ID (STU…).'}</p>`,
    );
  }

  const itemRow = (item, checked) => html`
    <label class="due-row">
      <input type="checkbox" name="item" value="${item.id}" data-amount="${item.amount}" data-title="${item.title}" ${checked ? 'checked' : ''} />
      <span class="grow"><span class="strong">${item.title}</span><span class="sub muted" style="display: block; font-size: 13px">${item.feeType} · due ${formatDate(item.dueDate)}${item.dueDate < meta.today ? ' · overdue' : ''}</span></span>
      <span class="strong">${rupees(item.amount)}</span>
    </label>
  `;

  function studentPanel() {
    if (!selected) return html`<section class="panel"><p class="panel-empty">Search for a student on the left to see their outstanding fees.</p></section>`;
    const { student, due, payments } = selected;
    const reference = REFERENCE[method];
    return html`
      ${completed ? html`<div data-completed>${confirmationCard(completed, { large: true })}</div>` : ''}
      <section class="panel">
        <div class="panel-body">
          <div class="student-head">
            <div class="avatar" aria-hidden="true">${initials(student.name)}</div>
            <div class="page-head-text" style="gap: 2px">
              <strong style="font-size: 18px">${student.name}</strong>
              <span class="muted" style="font-size: 14px">Class: ${student.className} · ${student.admissionNo} · ${student.code}</span>
              <span class="muted" style="font-size: 14px">${student.parentNames} · +91 ${formatPhone(student.parentPhone)}</span>
            </div>
          </div>
          ${!student.active
            ? html`<div class="banner"><span>This student is <strong>inactive</strong>. An admin must reactivate them before fees can be collected.</span></div>`
            : due.items.length || due.upcoming.length
              ? html`
                  <form class="page-head-text" style="gap: 16px" data-pay-form novalidate>
                    <div>
                      <div class="section-label" style="margin-bottom: 8px">Outstanding</div>
                      ${due.items.length
                        ? html`<div class="dues" role="group" aria-label="Outstanding fees">${due.items.map((i) => itemRow(i, true))}
                            <div class="due-total"><span>Total Due</span><span>${rupees(due.total)}</span></div></div>`
                        : html`<p class="muted" style="margin: 0">Nothing is due right now.</p>`}
                    </div>
                    ${due.upcoming.length
                      ? html`
                          <details ${due.items.length ? '' : 'open'}>
                            <summary class="link-button" style="cursor: pointer">Upcoming instalments (${due.upcoming.length}): tick to accept in advance</summary>
                            <div class="dues" style="margin-top: 8px">${due.upcoming.map((i) => itemRow(i, false))}</div>
                          </details>
                        `
                      : ''}
                    <div class="pay-form">
                      <label class="field">Payment Method
                        <select class="control" name="method" data-method>${meta.counterMethods.map((m) => html`<option ${m === method ? 'selected' : ''}>${m}</option>`)}</select>
                      </label>
                      <label class="field">Amount Received (₹)
                        <input class="control" type="number" min="1" step="1" name="amountReceived" data-received value="${due.total || ''}" required />
                      </label>
                      ${reference && method !== 'Cash'
                        ? html`<label class="field">${reference.label}<input class="control" name="reference" placeholder="${reference.placeholder}" maxlength="40" /></label>`
                        : ''}
                    </div>
                    <div class="change-due" data-summary></div>
                    <p class="form-error" role="alert" hidden></p>
                    <div class="form-actions" style="justify-content: flex-start">
                      <button type="submit" class="btn btn--primary" data-submit>${icon('check', 18, 2.5)} Confirm ${method === 'Cash' ? 'cash' : method} payment</button>
                    </div>
                  </form>
                `
              : html`<div class="banner banner--info"><span><strong>All paid up.</strong> ${student.name} has nothing due.</span></div>`}
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">Payment history</h2><span class="muted">${payments.length} records</span></div>
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
                          <td>${p.method}</td>
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
    `;
  }

  function renderStudent() {
    const panel = root.querySelector('[data-student-panel]');
    panel.innerHTML = String(studentPanel());
    const card = panel.querySelector('[data-completed] .confirm-card');
    if (card) bindCard(card);
    updateSummary();
  }

  function current() {
    const form = root.querySelector('[data-pay-form]');
    if (!form) return null;
    const boxes = [...form.querySelectorAll('input[name="item"]:checked')];
    const total = boxes.reduce((t, b) => t + Number(b.dataset.amount), 0);
    const received = Number(form.amountReceived.value || 0);
    return { form, boxes, total, received, reference: form.reference?.value.trim() ?? '' };
  }

  function updateSummary() {
    const state = current();
    if (!state) return;
    const { form, total, received } = state;
    const summary = form.querySelector('[data-summary]');
    const submit = form.querySelector('[data-submit]');
    let text = `Selected ${rupees(total)}`;
    if (!total) text = 'Tick at least one fee.';
    else if (received > total) text += method === 'Cash' ? ` · received ${rupees(received)} · change to return ${rupees(received - total)}` : ' · amount is more than the fees selected';
    else if (received > 0 && received < total) text += ` · part payment of ${rupees(received)} · ${rupees(total - received)} stays due`;
    summary.textContent = text;
    submit.disabled = !total || received < 1 || (received > total && method !== 'Cash');
  }

  function confirmationScreen(state) {
    const { student } = selected;
    const now = new Date().toISOString();
    const paid = Math.min(state.received, state.total);
    return new Promise((resolve) => {
      const dialog = openModal(
        String(html`
          <h2 class="modal-title">${method === 'Cash' ? 'Cash' : method} Payment Confirmation</h2>
          <dl class="confirm-table">
            <dt>Student</dt><dd>${student.name}</dd>
            <dt>Class</dt><dd>${student.classLabel}</dd>
            <dt>Fees</dt><dd>${state.boxes.map((b) => html`${b.dataset.title}<br />`)}</dd>
            <dt>Amount</dt><dd style="font-size: 20px">${rupees(paid)}${paid < state.total ? html` <span class="muted" style="font-size: 13px">(part payment, ${rupees(state.total - paid)} stays due)</span>` : ''}</dd>
            <dt>Payment Mode</dt><dd>${method.toUpperCase()}</dd>
            ${method === 'Cash' ? html`<dt>Amount Received</dt><dd>${rupees(state.received)}</dd>` : ''}
            ${method === 'Cash' && state.received > state.total ? html`<dt>Change to return</dt><dd>${rupees(state.received - state.total)}</dd>` : ''}
            ${state.reference ? html`<dt>Reference</dt><dd>${state.reference}</dd>` : ''}
            <dt>Collected By</dt><dd>${meta.staff.name}</dd>
            <dt>Date</dt><dd>${formatDate(now)}</dd>
            <dt>Time</dt><dd>${formatTime(now)}</dd>
          </dl>
          <p class="muted" style="margin: 0; font-size: 13px">Once confirmed, this payment cannot be changed. Mistakes are fixed by asking an admin for a correction.</p>
          <div class="form-actions">
            <button type="button" class="btn" data-back>Back</button>
            <button type="button" class="btn btn--primary" data-go>${icon('check', 18, 2.5)} Confirm &amp; generate receipt</button>
          </div>
        `),
        { label: 'Payment confirmation' },
      );
      let answer = false;
      dialog.querySelector('[data-back]').addEventListener('click', () => dialog.close());
      dialog.querySelector('[data-go]').addEventListener('click', () => {
        answer = true;
        dialog.close();
      });
      dialog.addEventListener('close', () => resolve(answer));
    });
  }

  mount(
    root,
    html`
      <div class="page">
        ${pageHead('Cash Collection', 'Search the student, tick what the parent is paying, enter the amount received and confirm. The receipt is generated immediately.')}
        <div class="collect">
          <section class="panel">
            <div class="search-box">
              <label class="field">Find a student
                <input class="control" type="search" data-search placeholder="Student name, admission no. or student ID" autocomplete="off" />
              </label>
              <label class="field">Class<select class="control" data-grade>${gradeOptions(meta.grades, '')}</select></label>
            </div>
            <div class="search-results" data-results></div>
          </section>
          <div class="page-head-text" style="gap: 20px" data-student-panel></div>
        </div>
      </div>
    `,
  );

  renderResults();
  renderStudent();
  bindReceiptActions(root, { onCorrection: () => selected && select(selected.student.id, { keepCompleted: true }) });

  root.querySelector('[data-search]').addEventListener('input', (event) => {
    query = event.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => search().catch((err) => toast(err.message, { tone: 'error' })), 250);
  });
  root.querySelector('[data-grade]').addEventListener('change', (event) => {
    grade = event.target.value;
    search().catch((err) => toast(err.message, { tone: 'error' }));
  });
  root.addEventListener('click', (event) => {
    const pick = event.target.closest('[data-student]');
    if (pick) select(Number(pick.dataset.student)).catch((err) => toast(err.message, { tone: 'error' }));
  });

  root.addEventListener('change', (event) => {
    const form = event.target.closest('[data-pay-form]');
    if (!form) return;
    if (event.target.name === 'item') {
      // Keep "amount received" equal to the selection until the clerk types their own.
      const state = current();
      if (!form.amountReceived.dataset.touched) form.amountReceived.value = state.total || '';
    }
    if (event.target.matches('[data-method]')) {
      method = event.target.value;
      const ticked = new Set([...form.querySelectorAll('input[name="item"]:checked')].map((b) => b.value));
      const received = form.amountReceived.value;
      renderStudent();
      const again = root.querySelector('[data-pay-form]');
      again.querySelectorAll('input[name="item"]').forEach((b) => (b.checked = ticked.has(b.value)));
      again.amountReceived.value = received;
      again.querySelector('[name="reference"]')?.focus();
    }
    updateSummary();
  });
  root.addEventListener('input', (event) => {
    if (event.target.matches('[data-received]')) {
      event.target.dataset.touched = '1';
      updateSummary();
    }
  });

  root.addEventListener('submit', async (event) => {
    if (!event.target.matches('[data-pay-form]')) return;
    event.preventDefault();
    const state = current();
    const errorBox = state.form.querySelector('.form-error');
    errorBox.hidden = true;
    if (REFERENCE[method] && method !== 'Other' && method !== 'Cash' && !state.reference) {
      errorBox.textContent = `Enter the ${REFERENCE[method].label.toLowerCase()}.`;
      errorBox.hidden = false;
      return;
    }
    if (!(await confirmationScreen(state))) return;

    const submit = state.form.querySelector('[data-submit]');
    submit.disabled = true;
    try {
      const result = await api(`/api/admin/students/${selected.student.id}/payments`, {
        method: 'POST',
        body: {
          feeItemIds: state.boxes.map((b) => Number(b.value)),
          expectedTotal: state.total,
          amountReceived: state.received,
          method,
          reference: state.reference,
          idempotencyKey,
        },
      });
      markShown(result.payment.paymentId);
      completed = { ...result.payment, change: result.change };
      method = 'Cash';
      await select(selected.student.id, { keepCompleted: true });
      if (result.partPayment) toast(`Part payment recorded. ${rupees(result.balance)} stays due.`, { duration: 5000 });
      root.querySelector('[data-completed]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      search().catch(() => {});
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      submit.disabled = false;
    }
  });

  const preselect = Number(ctx.query.get('student'));
  if (preselect) await select(preselect);
  ctx.onMount(() => root.querySelector('[data-search]').focus());
}
