import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';
import { toast } from '../../lib/toast.js';
import { compact, exportButtons, gradeOptions, options, pageHead, payBadge, sectionOptions, whatsappStatus } from '../components.js';
import { bindReceiptActions, receiptLinks } from '../receipt-actions.js';
import { session } from '../session.js';
import { formatDate, formatTime, rupees } from '/shared/format.js';

// Payment history: every payment and attempt, searchable, with receipt actions.

const PAGE_SIZE = 50;
const FILTERS = ['q', 'grade', 'section', 'from', 'to', 'mode', 'status'];

function rowHtml(p, { fresh = false } = {}) {
  return html`
    <tr class="${fresh ? 'is-new' : ''}">
      <td class="nowrap">${formatDate(p.at)}<span class="sub">${formatTime(p.at)}</span></td>
      <td class="mono nowrap">${p.receiptNo ?? '—'}</td>
      <td>
        <span class="strong">${p.student.name}</span><span class="sub">${p.student.admissionNo} · ${p.student.className}</span>
        ${p.reviewNote ? html`<span class="note-flag">⚠ ${p.reviewNote}</span>` : ''}
      </td>
      <td class="num strong nowrap">${rupees(p.amount)}</td>
      <td>
        ${p.paymentId ? p.method : 'Online checkout'}<span class="sub">${p.channel === 'online' ? (p.paymentId ? 'Online' : 'Awaiting gateway') : p.collectedBy || 'Counter'}</span>
        <span class="sub mono">${p.txnId ?? ''}</span>
      </td>
      <td>
        ${payBadge(p.status)}
        ${p.status === 'FAILED' && p.failureReason ? html`<span class="sub">${p.failureReason}</span>` : ''}
        ${p.status === 'CANCELLED' && p.reversalReason ? html`<span class="sub">${p.reversalReason}</span>` : ''}
        ${p.status === 'PAID' ? html`<span class="sub">${whatsappStatus(p.whatsapp)}</span>` : ''}
      </td>
      <td>
        ${p.paymentId
          ? receiptLinks(p.paymentId, { status: p.status, correctionPending: p.correctionPending, whatsapp: p.whatsapp })
          : p.status === 'PENDING' && p.channel === 'online' && session.can('payments.reconcile')
            ? html`<span class="row-actions"><button type="button" class="link-button" data-reconcile="${p.orderId}">Check with gateway</button></span>`
            : ''}
      </td>
    </tr>
  `;
}

export const paymentsView = (root, ctx) =>
  paymentList(root, ctx, {
    path: '/admin/payments',
    title: 'Payments',
    subtitle: 'Every payment and payment attempt, online and at the counter. PAID, PENDING, FAILED or CANCELLED.',
    statuses: session.meta.statuses,
  });

export const receiptsView = (root, ctx) =>
  paymentList(root, ctx, {
    path: '/admin/receipts',
    title: 'Receipts',
    subtitle: 'Every receipt issued, with its School Copy and Parent Copy. View, print, download, or send the Parent Copy on WhatsApp. Receipts are never deleted; cancelled ones are kept.',
    statuses: ['PAID', 'CANCELLED'],
    receiptsOnly: true,
  });

async function paymentList(root, ctx, { path, title, subtitle, statuses, receiptsOnly = false }) {
  const meta = session.meta;
  const filters = Object.fromEntries(FILTERS.map((key) => [key, ctx.query.get(key) ?? '']));
  let rows = [];
  let summary = { total: 0, paidCount: 0, paidAmount: 0 };
  let freshIds = new Set();

  async function load({ append = false } = {}) {
    const params = new URLSearchParams({ ...compact(filters), ...(receiptsOnly ? { receiptsOnly: '1' } : {}), limit: PAGE_SIZE, offset: append ? rows.length : 0 });
    const data = await api(`/api/admin/payments?${params}`);
    rows = append ? [...rows, ...data.rows] : data.rows;
    summary = data;
    renderResults();
  }

  function renderResults() {
    const body = root.querySelector('[data-results]');
    body.innerHTML = String(html`
      <div class="result-bar">
        <span><strong>${summary.total}</strong> records · <strong>${summary.paidCount}</strong> paid · <strong>${rupees(summary.paidAmount)}</strong> collected</span>
        ${session.can('reports.export') ? html`<span>Export these: ${exportButtons('/api/admin/export/payments', { ...compact(filters), ...(receiptsOnly ? { receiptsOnly: '1' } : {}) })}</span>` : ''}
      </div>
      ${rows.length
        ? html`
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr><th>Date</th><th>Receipt No.</th><th>Student</th><th class="num">Amount</th><th>Mode · Transaction ID</th><th>Status</th><th></th></tr>
                </thead>
                <tbody>${rows.map((p) => rowHtml(p, { fresh: freshIds.has(p.paymentId) }))}</tbody>
              </table>
            </div>
            ${rows.length < summary.total
              ? html`<div class="load-more"><button type="button" class="btn btn--small" data-more>Show ${Math.min(PAGE_SIZE, summary.total - rows.length)} more</button></div>`
              : ''}
          `
        : html`<p class="panel-empty">No payments match these filters.</p>`}
    `);
  }

  function syncUrl() {
    const query = new URLSearchParams(compact(filters)).toString();
    history.replaceState(null, '', `${path}${query ? `?${query}` : ''}`);
  }

  mount(
    root,
    html`
      <div class="page">
        ${pageHead(title, subtitle)}
        <section class="panel">
          <form class="filters" data-filters>
            <label class="field field--wide">Search
              <input class="control" type="search" name="q" value="${filters.q}" placeholder="Student name, admission no., receipt no. or transaction ID" />
            </label>
            <label class="field">Class<select class="control" name="grade">${gradeOptions(meta.grades, filters.grade)}</select></label>
            <label class="field">Section<select class="control" name="section">${sectionOptions(meta.classes, filters.grade, filters.section)}</select></label>
            <label class="field">From<input class="control" type="date" name="from" value="${filters.from}" max="${meta.today}" /></label>
            <label class="field">To<input class="control" type="date" name="to" value="${filters.to}" max="${meta.today}" /></label>
            <label class="field">Payment mode<select class="control" name="mode">${options(meta.paymentModes, filters.mode, { all: 'All modes' })}</select></label>
            <label class="field">Status<select class="control" name="status">${options(statuses, filters.status, { all: 'All statuses' })}</select></label>
            <div class="filter-actions"><button type="button" class="btn btn--small" data-reset>Clear filters</button></div>
          </form>
          <div data-results></div>
        </section>
      </div>
    `,
  );

  const form = root.querySelector('[data-filters]');
  let typing = null;
  const apply = () => {
    for (const key of FILTERS) filters[key] = form.elements[key].value;
    syncUrl();
    load().catch((err) => toast(err.message, { tone: 'error' }));
  };
  form.addEventListener('input', (event) => {
    if (event.target.name !== 'q') return;
    clearTimeout(typing);
    typing = setTimeout(apply, 300);
  });
  form.addEventListener('change', (event) => {
    if (event.target.name === 'grade') {
      form.elements.section.innerHTML = String(sectionOptions(meta.classes, event.target.value, ''));
    }
    if (event.target.name !== 'q') apply();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    apply();
  });
  root.querySelector('[data-reset]').addEventListener('click', () => {
    form.reset();
    for (const key of FILTERS) form.elements[key].value = '';
    apply();
  });

  bindReceiptActions(root, { onCorrection: () => load().catch(() => {}) });
  root.addEventListener('click', async (event) => {
    if (event.target.closest('[data-more]')) {
      load({ append: true }).catch((err) => toast(err.message, { tone: 'error' }));
      return;
    }
    const reconcile = event.target.closest('[data-reconcile]');
    if (reconcile) {
      reconcile.disabled = true;
      try {
        const result = await api(`/api/admin/payment-orders/${reconcile.dataset.reconcile}/reconcile`, { method: 'POST' });
        toast(
          result.status === 'paid'
            ? 'The gateway has the money: payment confirmed and receipt issued.'
            : result.status === 'failed'
              ? 'The gateway reports this payment did not go through.'
              : 'No completed payment at the gateway yet.',
        );
        await load();
      } catch (err) {
        toast(err.message, { tone: 'error' });
        reconcile.disabled = false;
      }
    }
  });

  // New confirmations appear at the top, highlighted.
  const onPayment = (event) => {
    freshIds = new Set([...freshIds, event.detail.paymentId]);
    load().catch(() => {});
  };
  const onWhatsapp = () => load().catch(() => {});
  document.addEventListener('kbs:payment', onPayment);
  document.addEventListener('kbs:whatsapp', onWhatsapp);

  await load();
  return () => {
    document.removeEventListener('kbs:payment', onPayment);
    document.removeEventListener('kbs:whatsapp', onWhatsapp);
  };
}
