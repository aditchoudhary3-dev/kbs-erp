import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';
import { icon } from '../../lib/icons.js';
import { toast } from '../../lib/toast.js';
import { compact, exportButtons, gradeOptions, pageHead, payBadge, sectionOptions } from '../components.js';
import { session } from '../session.js';
import { formatPhone, rupees } from '/shared/format.js';

// Manage Students: search, filter by class, section and status. Students are
// deactivated, never deleted.

export async function studentsView(root, ctx) {
  const meta = session.meta;
  const filters = {
    q: ctx.query.get('q') ?? '',
    grade: ctx.query.get('grade') ?? '',
    section: ctx.query.get('section') ?? '',
    status: ctx.query.get('status') ?? 'active',
  };
  let data = null;

  async function load() {
    data = await api(`/api/admin/students?${new URLSearchParams({ ...compact(filters), limit: 300 })}`);
    renderTable();
  }

  function renderTable() {
    root.querySelector('[data-table]').innerHTML = String(html`
      <div class="result-bar">
        <span><strong>${data.students.length}</strong> students${data.students.length === 300 ? ' (first 300: search to narrow down)' : ''}</span>
        ${session.can('students.export') ? html`<span>Export: ${exportButtons('/api/admin/export/students', compact(filters))}</span>` : ''}
      </div>
      ${data.students.length
        ? html`
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr><th>Student ID</th><th>Admission No.</th><th>Name</th><th>Class</th><th>Father / Mother</th><th>Mobile</th><th>Transport</th><th class="num">Due now</th><th>Status</th><th></th></tr>
                </thead>
                <tbody>
                  ${data.students.map(
                    (s) => html`
                      <tr>
                        <td class="mono">${s.code}</td>
                        <td class="mono">${s.admissionNo}</td>
                        <td><a class="strong" href="/admin/students/${s.id}" style="color: inherit">${s.name}</a><span class="sub">Roll no. ${s.rollNo}${s.gender ? ` · ${s.gender}` : ''}</span></td>
                        <td>${s.className}</td>
                        <td>${s.parentNames || '—'}</td>
                        <td class="nowrap">+91 ${formatPhone(s.parentPhone)}</td>
                        <td>${s.transport ? html`Yes<span class="sub">${s.busRoute}</span>` : 'No'}</td>
                        <td class="num">${s.due ? html`<span class="pay-badge ${s.overdue ? 'pay-badge--overdue' : 'pay-badge--pending'}">${rupees(s.due)}</span>` : html`<span class="muted">—</span>`}</td>
                        <td>${payBadge(s.active ? 'ACTIVE' : 'INACTIVE')}</td>
                        <td>
                          <span class="row-actions">
                            <a class="link-button" href="/admin/students/${s.id}">View</a>
                            ${session.can('students.edit') ? html`<a class="link-button" href="/admin/students/${s.id}/edit">Edit</a>` : ''}
                            ${session.can('payments.collect') && s.due && s.active ? html`<a class="link-button" href="/admin/cash?student=${s.id}">Collect</a>` : ''}
                          </span>
                        </td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            </div>
          `
        : html`<p class="panel-empty">No students match.</p>`}
    `);
  }

  mount(
    root,
    html`
      <div class="page">
        ${pageHead(
          'Manage Students',
          'Search, view and edit students. Deactivated students keep all their payments and receipts.',
          session.can('students.edit') ? html`<a class="btn btn--primary" href="/admin/students/new">${icon('userPlus', 18)} Add Student</a>` : '',
        )}
        <section class="panel">
          <form class="filters" data-filters>
            <label class="field field--wide">Search<input class="control" type="search" name="q" value="${filters.q}" placeholder="Name, admission no., student ID, parent or phone" /></label>
            <label class="field">Class<select class="control" name="grade">${gradeOptions(meta.grades, filters.grade)}</select></label>
            <label class="field">Section<select class="control" name="section">${sectionOptions(meta.classes, filters.grade, filters.section)}</select></label>
            <label class="field">Status
              <select class="control" name="status">
                ${[['active', 'Active'], ['inactive', 'Inactive'], ['all', 'All']].map(([v, l]) => html`<option value="${v}" ${v === filters.status ? 'selected' : ''}>${l}</option>`)}
              </select>
            </label>
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
    history.replaceState(null, '', `/admin/students?${new URLSearchParams(compact(filters))}`);
    load().catch((err) => toast(err.message, { tone: 'error' }));
  };
  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('input', (e) => {
    if (e.target.name !== 'q') return;
    clearTimeout(typing);
    typing = setTimeout(apply, 300);
  });
  form.addEventListener('change', (e) => {
    if (e.target.name === 'grade') form.elements.section.innerHTML = String(sectionOptions(meta.classes, e.target.value, ''));
    if (e.target.name !== 'q') apply();
  });

  await load();
}
