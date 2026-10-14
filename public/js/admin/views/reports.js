import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';
import { toast } from '../../lib/toast.js';
import { compact, exportButtons, gradeOptions, pageHead, payBadge, sectionOptions } from '../components.js';
import { bindReceiptActions, receiptLinks } from '../receipt-actions.js';
import { session } from '../session.js';
import { formatDate, formatPhone, rupees } from '/shared/format.js';

const REPORTS = [
  { id: 'daily', label: 'Daily collection', params: ['from', 'to'] },
  { id: 'monthly', label: 'Monthly collection', params: [] },
  { id: 'class-wise', label: 'Class-wise collection', params: ['from', 'to'] },
  { id: 'student', label: 'Student-wise history', params: ['studentId'] },
  { id: 'pending', label: 'Pending fees', params: ['grade', 'section', 'overdueOnly'] },
  { id: 'modes', label: 'Payment modes', params: ['from', 'to'] },
  { id: 'class-fees', label: 'Class fee status', params: ['grade', 'section'] },
];

function cell(value, column) {
  if (value === null || value === undefined || value === '') return '';
  if (column.type === 'money') return rupees(value);
  if (column.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value);
  return String(value);
}

function reportTable(fullReport, { extraColumn } = {}) {
  const report = { ...fullReport, columns: fullReport.columns.filter((c) => c.screen !== false) };
  if (!report.rows.length) return html`<p class="panel-empty">Nothing to show for these settings.</p>`;
  const numeric = (c) => ['money', 'number'].includes(c.type);
  return html`
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            ${report.columns.map((c) => html`<th class="${numeric(c) ? 'num' : ''}">${c.header}</th>`)}
            ${extraColumn ? html`<th></th>` : ''}
          </tr>
        </thead>
        <tbody>
          ${report.rows.map(
            (row) => html`
              <tr>
                ${report.columns.map((c) =>
                  c.key === 'status' && ['PAID', 'PENDING', 'FAILED', 'OVERDUE'].includes(row.status)
                    ? html`<td>${payBadge(row.status)}</td>`
                    : html`<td class="${numeric(c) ? 'num' : ''} ${c.type === 'money' ? 'strong' : ''}">${cell(row[c.key], c)}</td>`,
                )}
                ${extraColumn ? html`<td>${extraColumn(row)}</td>` : ''}
              </tr>
            `,
          )}
        </tbody>
        ${report.totals
          ? html`<tfoot><tr>${report.columns.map((c) => html`<td class="${numeric(c) ? 'num' : ''}">${cell(report.totals[c.key], c)}</td>`)}${extraColumn ? html`<td></td>` : ''}</tr></tfoot>`
          : ''}
      </table>
    </div>
  `;
}

export async function reportsView(root, ctx) {
  const meta = session.meta;
  let current = REPORTS.find((r) => r.id === ctx.query.get('report')) ?? REPORTS[0];
  const params = {
    from: ctx.query.get('from') ?? '',
    to: ctx.query.get('to') ?? '',
    grade: ctx.query.get('grade') ?? '',
    section: ctx.query.get('section') ?? '',
    overdueOnly: ctx.query.get('overdueOnly') ?? '',
    studentId: ctx.query.get('studentId') ?? '',
  };
  let studentResults = [];

  const activeParams = () => compact(Object.fromEntries(current.params.map((k) => [k, params[k]])));

  function paramsForm() {
    const fields = [];
    if (current.params.includes('from')) {
      fields.push(html`
        <label class="field">From<input class="control" type="date" name="from" value="${params.from}" max="${meta.today}" /></label>
        <label class="field">To<input class="control" type="date" name="to" value="${params.to}" max="${meta.today}" /></label>
      `);
    }
    if (current.params.includes('grade')) {
      fields.push(html`
        <label class="field">Class<select class="control" name="grade">${gradeOptions(meta.grades, params.grade)}</select></label>
        <label class="field">Section<select class="control" name="section">${sectionOptions(meta.classes, params.grade, params.section)}</select></label>
        <label class="check-field"><input type="checkbox" name="overdueOnly" ${params.overdueOnly === 'true' ? 'checked' : ''} /> Overdue only</label>
      `);
    }
    if (current.params.includes('studentId')) {
      fields.push(html`
        <label class="field" style="flex: 1 1 280px">Find a student
          <input class="control" type="search" name="studentSearch" placeholder="Name or admission number" autocomplete="off" />
        </label>
      `);
    }
    return fields.length ? html`<form class="report-params" data-params>${fields}</form>` : '';
  }

  async function renderReport() {
    const body = root.querySelector('[data-report]');
    if (current.id === 'student' && !params.studentId) {
      body.innerHTML = String(html`
        ${studentResults.length
          ? html`<div class="search-results" style="border-top: 0">${studentResults.map(
              (s) => html`<button type="button" class="search-result" data-pick="${s.id}"><span><span class="strong">${s.name}</span><span class="sub">${s.classLabel} · ${s.admissionNo}</span></span></button>`,
            )}</div>`
          : html`<p class="panel-empty">Search for a student to see their full payment history.</p>`}
      `);
      return;
    }

    const query = new URLSearchParams(activeParams());
    const report = await api(`/api/admin/reports/${current.id}?${query}`);
    const exportParams = activeParams();
    body.innerHTML = String(html`
      <div class="result-bar">
        <span><strong>${report.title}</strong>${report.subtitle ? ` · ${report.subtitle}` : ''}</span>
        ${session.can('reports.export') ? exportButtons(`/api/admin/export/${current.id}`, exportParams) : ''}
      </div>
      ${current.id === 'student'
        ? html`
            <div class="panel-body" style="padding-bottom: 0">
              <div class="banner ${report.dues.length ? '' : 'banner--info'}">
                <span>
                  <strong>${report.student.name}</strong> · ${report.student.classLabel} · ${report.student.parentNames} · +91 ${formatPhone(report.student.parentPhone)}
                  <br />${report.dues.length ? `Still due: ${report.dues.map((d) => `${d.title} (${rupees(d.amount)})`).join(', ')}` : 'Nothing due.'}
                </span>
                ${report.dues.length && session.can('payments.collect') ? html`<a class="btn btn--dark" href="/admin/cash?student=${report.student.id}">Collect fee</a>` : ''}
                <button type="button" class="btn btn--small" data-clear-student>Another student</button>
              </div>
            </div>
          `
        : ''}
      ${reportTable(report, {
        extraColumn:
          (current.id === 'pending' || current.id === 'class-fees') && session.can('payments.collect')
            ? (row) => html`<a class="link-button" href="/admin/cash?student=${row.id}">Collect</a>`
            : current.id === 'student'
              ? (row) => (row.paymentId ? receiptLinks(row.paymentId) : '')
              : null,
      })}
    `);
  }

  function syncUrl() {
    const query = new URLSearchParams({ report: current.id, ...activeParams() });
    history.replaceState(null, '', `/admin/reports?${query}`);
  }

  function render() {
    mount(
      root,
      html`
        <div class="page">
          ${pageHead('Reports', 'Collections and dues, ready to download for Excel.')}
          <div class="tabs" role="tablist" aria-label="Reports">
            ${REPORTS.map((r) => html`<button type="button" class="tab" role="tab" data-tab="${r.id}" aria-selected="${r.id === current.id}">${r.label}</button>`)}
          </div>
          <section class="panel">
            ${paramsForm()}
            <div data-report></div>
          </section>
        </div>
      `,
    );
    syncUrl();
    return renderReport();
  }

  bindReceiptActions(root);
  let searchTimer = null;

  root.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]');
    if (tab) {
      current = REPORTS.find((r) => r.id === tab.dataset.tab);
      render().catch((err) => toast(err.message, { tone: 'error' }));
      return;
    }
    const pick = event.target.closest('[data-pick]');
    if (pick) {
      params.studentId = pick.dataset.pick;
      syncUrl();
      renderReport().catch((err) => toast(err.message, { tone: 'error' }));
      return;
    }
    if (event.target.closest('[data-clear-student]')) {
      params.studentId = '';
      studentResults = [];
      syncUrl();
      renderReport();
    }
  });

  root.addEventListener('input', (event) => {
    if (event.target.name !== 'studentSearch') return;
    clearTimeout(searchTimer);
    const q = event.target.value.trim();
    searchTimer = setTimeout(async () => {
      studentResults = q ? (await api(`/api/admin/students?${new URLSearchParams({ q, limit: 20 })}`)).students : [];
      params.studentId = '';
      renderReport();
    }, 250);
  });

  root.addEventListener('change', (event) => {
    const form = event.target.closest('[data-params]');
    if (!form || event.target.name === 'studentSearch') return;
    if (event.target.name === 'grade') {
      form.elements.section.innerHTML = String(sectionOptions(meta.classes, event.target.value, ''));
    }
    for (const key of ['from', 'to', 'grade', 'section']) if (form.elements[key]) params[key] = form.elements[key].value;
    if (form.elements.overdueOnly) params.overdueOnly = form.elements.overdueOnly.checked ? 'true' : '';
    syncUrl();
    renderReport().catch((err) => toast(err.message, { tone: 'error' }));
  });

  await render();
}
