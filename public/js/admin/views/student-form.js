import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';
import { icon } from '../../lib/icons.js';
import { toast } from '../../lib/toast.js';
import { gradeOptions, pageHead } from '../components.js';
import { session } from '../session.js';
import { rupees } from '/shared/format.js';

// Add Student and Edit Student. On save the server validates everything,
// checks for duplicate admission numbers and duplicate students, gives the
// student their ID and creates their fee account from the fee structure.

const SECTIONS = ['A', 'B', 'C', 'D'];
const req = html`<span class="req" aria-hidden="true">*</span>`;

function formHtml(meta, s, { editing, code }) {
  const radio = (name, value, current) => html`<label><input type="radio" name="${name}" value="${value}" ${value === current ? 'checked' : ''} /> ${value}</label>`;
  const transport = s.transport ? 'Yes' : 'No';
  return html`
    <section class="form-section">
      <h2>Student</h2>
      <div class="form-grid form-grid--three">
        <div class="field">Student ID
          <span class="id-preview">${editing ? s.code : code}</span>
          <span class="hint">${editing ? 'Cannot be changed' : 'Given automatically when you save'}</span>
        </div>
        <label class="field"><span>Admission Number ${req}</span><input class="control" name="admissionNo" value="${s.admissionNo ?? ''}" placeholder="KBS/2026/0123" required /></label>
        <label class="field">Student Status
          <select class="control" name="status" ${editing ? 'disabled' : ''}>
            <option ${s.status !== 'Inactive' ? 'selected' : ''}>Active</option>
            <option ${s.status === 'Inactive' ? 'selected' : ''}>Inactive</option>
          </select>
          ${editing ? html`<span class="hint">Use Deactivate on the student’s page</span>` : ''}
        </label>
        <label class="field" style="grid-column: span 2"><span>Student Name ${req}</span><input class="control" name="name" value="${s.name ?? ''}" maxlength="80" required /></label>
        <label class="field"><span>Date of Birth ${req}</span><input class="control" type="date" name="dob" value="${s.dob ?? ''}" max="${meta.today}" required /></label>
        <div class="field"><span>Gender ${req}</span>
          <div class="radio-row" role="radiogroup" aria-label="Gender">${meta.genders.map((g) => radio('gender', g, s.gender))}</div>
        </div>
      </div>
    </section>

    <section class="form-section">
      <h2>Parents and contact</h2>
      <div class="form-grid">
        <label class="field"><span>Father’s Name ${req}</span><input class="control" name="fatherName" value="${s.fatherName ?? ''}" maxlength="80" /></label>
        <label class="field"><span>Mother’s Name ${req}</span><input class="control" name="motherName" value="${s.motherName ?? ''}" maxlength="80" /></label>
        <label class="field"><span>Parent/Guardian Mobile Number ${req}</span>
          <input class="control" type="tel" inputmode="numeric" name="parentPhone" value="${s.parentPhone ?? ''}" placeholder="98765 43210" required />
          <span class="hint">Parents log in to the app with this number</span>
        </label>
        <label class="field">Alternate Mobile Number<input class="control" type="tel" inputmode="numeric" name="altPhone" value="${s.altPhone ?? ''}" /></label>
        <label class="field">WhatsApp number for receipts
          <input class="control" type="tel" inputmode="numeric" name="whatsappPhone" value="${s.whatsappPhone && s.whatsappPhone !== s.parentPhone ? s.whatsappPhone : ''}" />
          <span class="hint">Leave empty to use the parent’s mobile</span>
        </label>
        <label class="field span-2">Address ${req}<textarea class="textarea" name="address" rows="2" maxlength="200" required>${s.address ?? ''}</textarea></label>
      </div>
    </section>

    <section class="form-section">
      <h2>Class and admission</h2>
      <div class="form-grid form-grid--three">
        <label class="field"><span>Class ${req}</span><select class="control" name="grade" required>${gradeOptions(meta.grades, s.grade ?? '', { all: 'Choose class' })}</select></label>
        <label class="field"><span>Section ${req}</span><select class="control" name="section">${SECTIONS.map((x) => html`<option ${x === (s.section ?? 'A') ? 'selected' : ''}>${x}</option>`)}</select></label>
        <label class="field">Roll No.<input class="control" type="number" min="1" name="rollNo" value="${s.rollNo ?? ''}" /><span class="hint">Leave empty for the next number</span></label>
        <label class="field"><span>Session / Academic Year ${req}</span><select class="control" name="session">${meta.sessions.map((x) => html`<option ${x === (s.session ?? meta.session) ? 'selected' : ''}>${x}</option>`)}</select></label>
        <label class="field"><span>Admission Date ${req}</span><input class="control" type="date" name="admissionDate" value="${s.admissionDate ?? meta.today}" required /></label>
      </div>
    </section>

    <section class="form-section">
      <h2>Transport</h2>
      <div class="form-grid">
        <div class="field"><span>Transport Required ${req}</span>
          <div class="radio-row" role="radiogroup" aria-label="Transport required">${radio('transport', 'Yes', transport)}${radio('transport', 'No', transport)}</div>
        </div>
        <label class="field" data-route ${transport === 'Yes' ? '' : 'hidden'}><span>Bus Route ${req}</span>
          <input class="control" name="busRoute" value="${s.busRoute ?? ''}" list="bus-routes" placeholder="e.g. Route 1 – Shahpur" />
          <datalist id="bus-routes">${meta.busRoutes.map((r) => html`<option value="${r}"></option>`)}</datalist>
        </label>
      </div>
    </section>

    <section class="form-section">
      <h2>Other</h2>
      <label class="field">Remarks (optional)<textarea class="textarea" name="remarks" rows="2" maxlength="500">${s.remarks ?? ''}</textarea></label>
    </section>
  `;
}

export async function studentFormView(root, ctx) {
  const meta = session.meta;
  const editing = Boolean(ctx.params.id);
  let student = editing ? (await api(`/api/admin/students/${ctx.params.id}`)).student : {};
  let code = editing ? student.code : (await api('/api/admin/students/next-code')).code;
  let lastSaved = null;

  function render(values = student) {
    mount(
      root,
      html`
        <div class="page form-page">
          ${pageHead(
            editing ? `Edit ${student.name}` : 'Add Student',
            editing
              ? 'Changes are recorded in the audit log. Receipts already issued keep the details printed on them.'
              : 'Fields marked * are required. The fee account is created from the fee structure when you save.',
          )}
          ${lastSaved
            ? html`
                <div class="success-banner" role="status">
                  ${icon('check', 20, 2.5)}
                  <span>Student added successfully: <strong>${lastSaved.student.name}</strong> (${lastSaved.student.code}, ${lastSaved.student.classLabel}). Fee account created with ${lastSaved.feeAccount.added} fee items.</span>
                  <a class="link-button" href="/admin/students/${lastSaved.student.id}">View</a>
                </div>
              `
            : ''}
          <form class="panel" data-student-form novalidate>
            <p class="form-error" role="alert" hidden style="margin: 16px 20px 0"></p>
            ${formHtml(meta, values, { editing, code })}
            <div class="sticky-actions">
              <a class="btn" href="${editing ? `/admin/students/${student.id}` : '/admin/students'}" data-cancel>Cancel</a>
              ${editing
                ? html`<button type="submit" class="btn btn--primary" data-save="save">Save changes</button>`
                : html`
                    <button type="submit" class="btn" data-save="another">Save &amp; add another</button>
                    <button type="submit" class="btn btn--primary" data-save="save">Save student</button>
                  `}
            </div>
          </form>
        </div>
      `,
    );
  }

  render();
  let dirty = false;

  root.addEventListener('input', () => (dirty = true));
  root.addEventListener('change', (event) => {
    dirty = true;
    if (event.target.name === 'transport') {
      const route = root.querySelector('[data-route]');
      route.hidden = event.target.value !== 'Yes';
      if (!route.hidden) route.querySelector('input').focus();
    }
  });
  root.addEventListener('click', (event) => {
    if (event.target.closest('[data-cancel]')) dirty = false;
  });
  ctx.setGuard(() => (dirty ? 'You have not saved this student. Leave without saving?' : null));

  // Names of required fields that are empty, marked on the form.
  function missingFields(form, body) {
    const required = [
      ['admissionNo', 'Admission Number'], ['name', 'Student Name'], ['dob', 'Date of Birth'], ['gender', 'Gender'],
      ['parentPhone', 'Parent/Guardian Mobile Number'], ['address', 'Address'], ['grade', 'Class'], ['admissionDate', 'Admission Date'],
    ];
    if (body.transport === 'Yes') required.push(['busRoute', 'Bus Route']);
    const missing = required.filter(([key]) => !String(body[key] ?? '').trim());
    if (!String(body.fatherName ?? '').trim() && !String(body.motherName ?? '').trim()) missing.push(['fatherName', 'Father’s or Mother’s Name']);
    form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
    for (const [key] of missing) form.querySelector(`[name="${key}"]`)?.setAttribute('aria-invalid', 'true');
    return missing;
  }

  root.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const action = event.submitter?.dataset.save ?? 'save';
    const errorBox = form.querySelector('.form-error');
    const body = Object.fromEntries(new FormData(form));
    if (body.transport !== 'Yes') body.busRoute = '';
    const missing = missingFields(form, body);
    if (missing.length) {
      errorBox.textContent = `Please fill in: ${missing.map(([, label]) => label).join(', ')}.`;
      errorBox.hidden = false;
      form.querySelector('[aria-invalid="true"]')?.focus();
      return;
    }
    form.querySelectorAll('button[type="submit"]').forEach((b) => (b.disabled = true));
    errorBox.hidden = true;
    try {
      if (editing) {
        const result = await api(`/api/admin/students/${student.id}`, { method: 'PUT', body });
        dirty = false;
        const changes = result.feeAccount;
        toast(`Saved.${changes.added || changes.removed ? ` Fee account updated (${changes.added} added, ${changes.removed} removed).` : ''}`);
        ctx.navigate(`/admin/students/${student.id}`);
        return;
      }
      const result = await api('/api/admin/students', { method: 'POST', body });
      dirty = false;
      toast(result.message);
      if (action === 'another') {
        lastSaved = result;
        code = (await api('/api/admin/students/next-code')).code;
        // Keep the class, section, session and admission date for the next entry.
        render({ grade: body.grade, section: body.section, session: body.session, admissionDate: body.admissionDate, transport: false });
        window.scrollTo({ top: 0, behavior: 'smooth' });
        root.querySelector('[name="admissionNo"]').focus();
      } else {
        ctx.navigate(`/admin/students/${result.student.id}?added=1`);
      }
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      form.querySelectorAll('button[type="submit"]').forEach((b) => (b.disabled = false));
    }
  });

  ctx.onMount(() => root.querySelector(editing ? '[name="name"]' : '[name="admissionNo"]').focus());
}

export const feeAccountSummary = (items) => `${items.length} fee items, ${rupees(items.reduce((t, i) => t + i.amount, 0))}`;
