import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';
import { exportButtons, pageHead } from '../components.js';
import { session } from '../session.js';
import { rupees } from '/shared/format.js';

// Class-wise fee position for Nursery to Class 12, straight from the ledger.

const percent = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

function classCard(g) {
  const canExport = session.can('reports.export');
  const recordsLink = (params) => `/admin/payments?${new URLSearchParams(params)}`;
  return html`
    <article class="class-card" aria-label="${g.grade}">
      <div class="tile-row">
        <h2>${g.grade}</h2>
        <span class="muted" style="font-size: 13px">${percent(g.paidStudents, g.totalStudents)}% paid</span>
      </div>
      <dl class="class-stats">
        <div><dt>Total Students</dt><dd>${g.totalStudents}</dd></div>
        <div><dt>Paid Students</dt><dd style="color: var(--paid-ink)">${g.paidStudents}</dd></div>
        <div><dt>Pending Students</dt><dd style="color: var(--pending-ink)">${g.pendingStudents}</dd></div>
      </dl>
      <div class="meter"><div class="meter-fill" style="width: ${percent(g.paidStudents, g.totalStudents)}%"></div></div>
      <div class="class-money">
        <span>Total Collected<strong>${rupees(g.collected)}</strong></span>
        <span class="pending" style="text-align: right">Pending Amount<strong>${rupees(g.pending)}</strong></span>
      </div>
      ${g.sections.length > 1 || g.sections[0]?.section !== 'A'
        ? html`
            <div class="sections">
              ${g.sections.map(
                (s) => html`
                  <div class="section-line">
                    <a class="link-button" href="${recordsLink({ grade: g.grade, section: s.section })}">Section ${s.section}</a>
                    <span class="muted">${s.paidStudents}/${s.totalStudents} paid · ${rupees(s.pending)} pending</span>
                    ${canExport ? html`<a class="link-button" href="/api/admin/export/payments?${new URLSearchParams({ grade: g.grade, section: s.section, format: 'xlsx' })}" download>Excel</a>` : ''}
                  </div>
                `,
              )}
            </div>
          `
        : ''}
      <div class="class-actions">
        <a class="btn btn--small" href="${recordsLink({ grade: g.grade })}">Payment records</a>
        <a class="btn btn--small" href="/admin/reports?report=pending&grade=${encodeURIComponent(g.grade)}">Pending list</a>
        ${canExport ? exportButtons('/api/admin/export/payments', { grade: g.grade }) : ''}
      </div>
    </article>
  `;
}

export async function classesView(root) {
  async function render() {
    const { grades } = await api('/api/admin/classes');
    const totals = grades.reduce(
      (t, g) => ({
        students: t.students + g.totalStudents,
        paid: t.paid + g.paidStudents,
        collected: t.collected + g.collected,
        pending: t.pending + g.pending,
      }),
      { students: 0, paid: 0, collected: 0, pending: 0 },
    );
    mount(
      root,
      html`
        <div class="page">
          ${pageHead(
            'Class-wise fee records',
            `${session.meta.academicYear}. Paid students have nothing due; pending students owe at least one fee.`,
            session.can('reports.export') ? html`<span class="muted" style="font-size: 13px">All classes:</span> ${exportButtons('/api/admin/export/payments', {})}` : '',
          )}
          <div class="tiles">
            <div class="tile"><span class="tile-label">Students</span><span class="tile-value">${totals.students}</span><span class="tile-sub">Nursery to Class 12</span></div>
            <div class="tile"><span class="tile-label">Paid students</span><span class="tile-value">${totals.paid}</span><span class="tile-sub">${percent(totals.paid, totals.students)}% of all students</span></div>
            <div class="tile"><span class="tile-label">Collected this year</span><span class="tile-value">${rupees(totals.collected)}</span><span class="tile-sub">All classes</span></div>
            <div class="tile"><span class="tile-label">Pending amount</span><span class="tile-value">${rupees(totals.pending)}</span><span class="tile-sub">Not yet paid</span></div>
          </div>
          <div class="class-grid">${grades.map(classCard)}</div>
        </div>
      `,
    );
  }

  await render();
  let timer = null;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(() => render().catch(() => {}), 400);
  };
  document.addEventListener('kbs:payment', refresh);
  return () => {
    clearTimeout(timer);
    document.removeEventListener('kbs:payment', refresh);
  };
}
