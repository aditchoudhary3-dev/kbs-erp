import { html, mount } from '../../lib/html.js';
import { compact, gradeOptions, options, pageHead, sectionOptions } from '../components.js';
import { session } from '../session.js';

// Excel Export: every report as an Excel workbook or CSV file.

export async function exportView(root) {
  const meta = session.meta;
  const monthStart = `${meta.today.slice(0, 7)}-01`;

  const classFields = html`
    <label class="field">Class<select class="control" name="grade">${gradeOptions(meta.grades, '')}</select></label>
    <label class="field">Section<select class="control" name="section">${sectionOptions(meta.classes, '', '')}</select></label>
  `;
  const dateFields = html`
    <label class="field">From<input class="control" type="date" name="from" value="${monthStart}" max="${meta.today}" /></label>
    <label class="field">To<input class="control" type="date" name="to" value="${meta.today}" max="${meta.today}" /></label>
  `;

  const EXPORTS = [
    {
      name: 'payments',
      title: 'Fee register (all payments)',
      description: 'One row per fee paid: student ID, admission no., name, parents, class, section, fee type, amount, mode, transaction ID, date, time, status, receipt no., collected by.',
      fields: html`${classFields}${dateFields}<label class="field">Status<select class="control" name="status">${options(meta.statuses, '', { all: 'All statuses' })}</select></label>`,
    },
    { name: 'pending', title: 'Pending fees', description: 'Students with fees due, with amounts, due dates and parent contacts.', fields: html`${classFields}<label class="check-field"><input type="checkbox" name="overdueOnly" value="true" /> Overdue only</label>` },
    { name: 'daily', title: 'Daily collection', description: 'Receipts and amounts for each day, online and at the counter, with cash totals.', fields: dateFields },
    { name: 'monthly', title: 'Monthly collection', description: `Collection for each month of ${meta.academicYear}.`, fields: '' },
    { name: 'class-wise', title: 'Class-wise collection', description: 'Collected and pending amounts for every class and section.', fields: dateFields },
    { name: 'modes', title: 'Payment-mode report', description: 'Totals by payment mode (cash, UPI, card, net banking, cheque…).', fields: dateFields },
    ...(session.can('students.export')
      ? [{ name: 'students', title: 'Students', description: 'All student records with contact details, class, transport and status.', fields: html`${classFields}<label class="field">Status<select class="control" name="status"><option value="all">All</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label>` }]
      : []),
    ...(session.can('fees.manage') ? [{ name: 'fee-structure', title: 'Fee structure', description: 'Every fee with class, frequency, amounts and collection so far.', fields: html`<label class="field">Session<select class="control" name="session">${options(meta.sessions, meta.session)}</select></label>` }] : []),
    ...(session.can('audit.view') ? [{ name: 'audit', title: 'Audit log', description: 'Who did what and when (latest 5,000 entries).', fields: dateFields }] : []),
  ];

  mount(
    root,
    html`
      <div class="page">
        ${pageHead('Excel Export', 'Download any report as an Excel workbook (.xlsx) or CSV. Paid rows come from the receipts exactly as issued.')}
        <div class="banner banner--info"><span>An always-up-to-date copy of the fee register is also saved automatically after every payment, in the <strong>data/exports</strong> folder on the school computer.</span></div>
        <div class="class-grid" style="grid-template-columns: repeat(auto-fill, minmax(340px, 1fr))">
          ${EXPORTS.map(
            (e) => html`
              <form class="class-card" data-export="${e.name}">
                <h2 style="font-size: 18px">${e.title}</h2>
                <p class="muted" style="margin: 0; font-size: 13.5px">${e.description}</p>
                ${e.fields ? html`<div class="form-grid" style="gap: 10px">${e.fields}</div>` : ''}
                <div class="class-actions">
                  <button type="submit" class="btn btn--small btn--primary" value="xlsx">Download Excel</button>
                  <button type="submit" class="btn btn--small" value="csv">Download CSV</button>
                </div>
              </form>
            `,
          )}
        </div>
      </div>
    `,
  );

  root.addEventListener('change', (event) => {
    if (event.target.name !== 'grade') return;
    const section = event.target.form.elements.section;
    if (section) section.innerHTML = String(sectionOptions(meta.classes, event.target.value, ''));
  });

  root.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target;
    const params = compact(Object.fromEntries(new FormData(form)));
    const link = document.createElement('a');
    link.href = `/api/admin/export/${form.dataset.export}?${new URLSearchParams({ ...params, format: event.submitter?.value ?? 'xlsx' })}`;
    link.download = '';
    document.body.append(link);
    link.click();
    link.remove();
  });
}
