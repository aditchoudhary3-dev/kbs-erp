import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';
import { icon } from '../../lib/icons.js';
import { toast } from '../../lib/toast.js';
import { classOptions, pageHead, statusBadge } from '../components.js';
import { session } from '../session.js';
import { firstName, formatDate, formatDateTime, formatPhone, todayIso } from '/shared/format.js';

const STATUS_LABEL = { Pending: 'Not started', Draft: 'Draft', Published: 'Published' };

function markError(value) {
  if (value === '') return false;
  const n = Number(value);
  return !Number.isInteger(n) || n < 0 || n > 100;
}

export async function progressView(root, ctx) {
  const meta = session.meta;
  const fallbackClass = meta.classes.find((c) => c.name === '6-B') ?? meta.classes[0];
  let classId = meta.classes.some((c) => String(c.id) === ctx.query.get('class'))
    ? Number(ctx.query.get('class'))
    : fallbackClass?.id;
  let month = meta.months.some((m) => m.key === ctx.query.get('month')) ? ctx.query.get('month') : meta.months[0]?.key;

  let data = null;
  let selectedId = null;
  let form = null;
  let dirty = false;
  let saving = false;
  let adding = false;
  let error = '';
  let remindersSent = false;

  if (!classId || !month) {
    mount(root, html`<div class="page">${pageHead('Monthly progress', 'Add a class first.')}</div>`);
    return;
  }

  const current = () => data.students.find((s) => s.id === selectedId);

  function selectStudent(id) {
    selectedId = id;
    const report = current()?.report;
    form = {
      marks: Object.fromEntries(
        meta.subjects.map((subject) => [subject, report?.marks.find((m) => m.subject === subject)?.score ?? '']),
      ),
      // New reports take attendance from the daily register, when it has been kept.
      daysPresent: report?.daysPresent ?? current()?.attendance?.attended ?? '',
      schoolDays: report?.schoolDays ?? current()?.attendance?.days ?? data.suggestedSchoolDays ?? '',
      remarks: report?.remarks ?? '',
      activities: report ? report.activities.map((a) => ({ ...a })) : [],
    };
    dirty = false;
    adding = false;
    error = '';
  }

  async function load(preferId) {
    data = await api(`/api/admin/progress?classId=${classId}&month=${month}`);
    const pick =
      data.students.find((s) => s.id === preferId) ??
      data.students.find((s) => s.status !== 'Published') ??
      data.students[0];
    selectStudent(pick?.id ?? null);
  }

  // ---- Markup -----------------------------------------------------------------

  function banner() {
    const fee = data.feeBanner;
    if (!fee) return '';
    const n = fee.families;
    const overdue = fee.dueDate < todayIso();
    return html`
      <div class="banner">
        <span>
          <strong>Fees:</strong> ${n} ${n === 1 ? 'family' : 'families'} in ${data.class.name}
          ${overdue ? `${n === 1 ? 'has' : 'have'} fees overdue since` : `${n === 1 ? 'has' : 'have'} fees due by`}
          ${formatDate(fee.dueDate, { year: false })}.
        </span>
        <button type="button" class="btn btn--dark" data-remind ${remindersSent ? 'disabled' : ''}>
          ${remindersSent ? 'Reminders sent' : 'Send reminders'}
        </button>
      </div>
    `;
  }

  function activitiesMarkup() {
    return html`
      ${form.activities.map(
        (a, i) => html`
          <span class="chip">
            ${a.result ? `${a.name} · ${a.result}` : a.name}
            <button type="button" class="chip-remove" data-remove="${i}" aria-label="Remove ${a.name}">
              ${icon('x', 14, 2.5)}
            </button>
          </span>
        `,
      )}
      ${adding
        ? html`
            <span class="activity-form">
              <input class="control" name="newName" placeholder="Activity, e.g. Art competition" maxlength="80"
                aria-label="Activity name" />
              <input class="control" name="newResult" placeholder="Result, e.g. Winner" maxlength="40"
                aria-label="Result" style="width: 170px" />
              <button type="button" class="btn btn--small btn--primary" data-add-confirm>Add</button>
              <button type="button" class="link-button" data-add-cancel>Cancel</button>
            </span>
          `
        : html`<button type="button" class="chip-add" data-add>+ Add activity</button>`}
    `;
  }

  function editorNote(s) {
    const r = s.report;
    if (s.status === 'Published') return `Published ${formatDateTime(r.publishedAt)} · parents see edits straight away`;
    if (s.status === 'Draft') return `Draft saved ${formatDateTime(r.updatedAt)} · not visible to parents yet`;
    return 'Not visible to parents until you publish.';
  }

  function editor(s) {
    return html`
      <form class="editor" data-editor novalidate aria-label="Progress for ${s.name}">
        <div class="editor-head">
          <div class="page-head-text" style="gap: 2px">
            <div class="editor-name">${s.name}</div>
            <div class="muted" style="font-size: 14px">Roll no. ${s.rollNo} · Parent: +91 ${formatPhone(s.parentPhone)}</div>
          </div>
          <div class="status-pill badge--${s.status.toLowerCase()}">${STATUS_LABEL[s.status]}</div>
        </div>

        <div class="editor-grid">
          <div class="editor-section">
            <div class="section-label">Marks (out of 100)</div>
            ${meta.subjects.map(
              (subject) => html`
                <label class="mark-row">
                  ${subject}
                  <input class="mark-input" type="number" inputmode="numeric" min="0" max="100" step="1"
                    name="mark" data-subject="${subject}" value="${form.marks[subject]}"
                    aria-invalid="${markError(String(form.marks[subject]))}" />
                </label>
              `,
            )}
          </div>

          <div class="editor-section editor-section--loose">
            <div class="section-label">Attendance${s.attendance ? html` <span class="muted" style="font-weight: 500; text-transform: none; letter-spacing: 0">· register: ${s.attendance.attended} of ${s.attendance.days} days</span>` : ''}</div>
            <div class="attendance">
              <label class="field">Days present
                <input class="control control--small" type="number" inputmode="numeric" min="0" max="31"
                  name="daysPresent" value="${form.daysPresent}" />
              </label>
              <label class="field">School days
                <input class="control control--small" type="number" inputmode="numeric" min="1" max="31"
                  name="schoolDays" value="${form.schoolDays}" />
              </label>
            </div>
            <label class="remarks-label">Teacher remarks
              <textarea class="textarea" rows="4" name="remarks" maxlength="1000"
                placeholder="How is ${firstName(s.name)} doing this month?">${form.remarks}</textarea>
            </label>
          </div>
        </div>

        <div class="editor-section">
          <div class="section-label">Activities</div>
          <div class="chips" data-activities>${activitiesMarkup()}</div>
        </div>

        <p class="form-error" role="alert" ${error ? '' : 'hidden'}>${error}</p>

        <div class="editor-foot">
          <div class="editor-note">
            ${editorNote(s)}<strong data-dirty ${dirty ? '' : 'hidden'} style="color: var(--warn-ink)"> · Unsaved changes</strong>
          </div>
          <div class="editor-actions">
            ${s.status === 'Published'
              ? html`<button type="button" class="btn" data-save="update">Save changes</button>`
              : html`
                  <button type="button" class="btn" data-save="draft">Save draft</button>
                  <button type="button" class="btn btn--outline" data-save="publish">Publish</button>
                `}
            <button type="button" class="btn btn--primary" data-save="next">Save and next student</button>
          </div>
        </div>
      </form>
    `;
  }

  function render() {
    const counts = { Published: 0, Draft: 0, Pending: 0 };
    data.students.forEach((s) => (counts[s.status] += 1));
    const s = current();

    mount(
      root,
      html`
        <div class="page">
          ${pageHead(
            'Monthly progress',
            'Enter marks, attendance, remarks and activities, then publish to parents.',
            html`
              <label class="field">Class
                <select class="control" data-class>${classOptions(meta.classes, classId)}</select>
              </label>
              <label class="field">Month
                <select class="control control--wide" data-month>
                  ${meta.months.map((m) => html`<option value="${m.key}" ${m.key === month ? 'selected' : ''}>${m.label}</option>`)}
                </select>
              </label>
            `,
          )}
          ${banner()}
          <div class="entry">
            <div class="roster">
              <div class="roster-head">
                <span>Students · ${data.class.name}</span>
                ${counts.Draft
                  ? html`<button type="button" class="link-button" data-publish-all>
                      Publish ${counts.Draft} draft${counts.Draft === 1 ? '' : 's'}
                    </button>`
                  : ''}
              </div>
              ${data.students.map(
                (st) => html`
                  <button type="button" class="roster-item" data-student="${st.id}" aria-current="${st.id === selectedId}">
                    <span>${st.name}</span>${statusBadge(st.status)}
                  </button>
                `,
              )}
              <div class="roster-foot">${counts.Published} of ${data.students.length} published for ${data.monthLabel}</div>
            </div>
            ${s ? editor(s) : html`<div class="editor"><p class="muted">No students in this class yet.</p></div>`}
          </div>
        </div>
      `,
    );
  }

  const renderActivities = () => {
    root.querySelector('[data-activities]').innerHTML = String(activitiesMarkup());
  };

  function markDirty() {
    dirty = true;
    root.querySelector('[data-dirty]')?.removeAttribute('hidden');
  }

  function confirmDiscard() {
    return !dirty || window.confirm(`You have unsaved changes for ${current().name}. Discard them?`);
  }

  // ---- Actions ----------------------------------------------------------------

  async function save(action) {
    const student = current();
    if (!student || saving) return;
    const index = data.students.indexOf(student);
    const next = data.students[index + 1];

    // Nothing to save: just move on.
    if (action === 'next' && !dirty) {
      if (next) {
        selectStudent(next.id);
        render();
        root.querySelector('.mark-input')?.focus();
      } else {
        toast(`That was the last student in ${data.class.name}.`);
      }
      return;
    }

    saving = true;
    root.querySelectorAll('[data-save]').forEach((b) => (b.disabled = true));
    try {
      const { report } = await api(`/api/admin/progress/${student.id}/${month}`, {
        method: 'PUT',
        body: { ...form, publish: action === 'publish' },
      });
      student.report = report;
      student.status = report.status === 'published' ? 'Published' : 'Draft';
      dirty = false;

      if (action === 'publish') toast(`Published. ${firstName(student.name)}’s parents can see it now.`);
      else if (student.status === 'Published') toast('Changes saved. Parents see the update.');
      else toast(`Draft saved for ${student.name}.`);

      if (action === 'next' && next) selectStudent(next.id);
      else {
        selectStudent(student.id);
        if (action === 'next') toast(`That was the last student in ${data.class.name}.`);
      }
      render();
      if (action === 'next') root.querySelector('.mark-input')?.focus();
    } catch (err) {
      error = err.message;
      render();
      root.querySelector('.form-error')?.scrollIntoView({ block: 'nearest' });
    } finally {
      saving = false;
    }
  }

  function addActivity() {
    const name = root.querySelector('[name="newName"]');
    const result = root.querySelector('[name="newResult"]');
    if (!name.value.trim()) {
      name.focus();
      return;
    }
    form.activities.push({ name: name.value.trim(), result: result.value.trim() });
    adding = false;
    markDirty();
    renderActivities();
    root.querySelector('[data-add]')?.focus();
  }

  root.addEventListener('input', (event) => {
    const el = event.target;
    if (!el.closest('[data-editor]') || !el.name || el.name.startsWith('new')) return;
    if (el.name === 'mark') {
      form.marks[el.dataset.subject] = el.value;
      el.setAttribute('aria-invalid', String(markError(el.value)));
    } else {
      form[el.name] = el.value;
    }
    markDirty();
  });

  root.addEventListener('change', async (event) => {
    const select = event.target.closest('[data-class], [data-month]');
    if (!select) return;
    if (!confirmDiscard()) {
      select.value = select.matches('[data-class]') ? String(classId) : month;
      return;
    }
    if (select.matches('[data-class]')) classId = Number(select.value);
    else month = select.value;
    remindersSent = false;
    history.replaceState(null, '', `/admin/progress?class=${classId}&month=${month}`);
    await load();
    render();
  });

  root.addEventListener('keydown', (event) => {
    if (!event.target.name?.startsWith('new')) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      addActivity();
    } else if (event.key === 'Escape') {
      adding = false;
      renderActivities();
    }
  });

  root.addEventListener('submit', (event) => event.preventDefault());

  root.addEventListener('click', async (event) => {
    const target = event.target.closest('button');
    if (!target) return;

    if (target.dataset.student) {
      const id = Number(target.dataset.student);
      if (id === selectedId || !confirmDiscard()) return;
      selectStudent(id);
      render();
    } else if (target.dataset.save) {
      save(target.dataset.save);
    } else if (target.dataset.remove !== undefined) {
      form.activities.splice(Number(target.dataset.remove), 1);
      markDirty();
      renderActivities();
    } else if (target.hasAttribute('data-add')) {
      adding = true;
      renderActivities();
      root.querySelector('[name="newName"]').focus();
    } else if (target.hasAttribute('data-add-confirm')) {
      addActivity();
    } else if (target.hasAttribute('data-add-cancel')) {
      adding = false;
      renderActivities();
    } else if (target.hasAttribute('data-remind')) {
      target.disabled = true;
      try {
        const { families } = await api('/api/admin/fees/reminders', { method: 'POST', body: { classId } });
        remindersSent = true;
        target.textContent = 'Reminders sent';
        toast(`SMS reminders sent to ${families} ${families === 1 ? 'family' : 'families'}.`);
      } catch (err) {
        target.disabled = false;
        toast(err.message, { tone: 'error' });
      }
    } else if (target.hasAttribute('data-publish-all')) {
      if (!confirmDiscard()) return;
      const drafts = data.students.filter((s) => s.status === 'Draft').length;
      if (!window.confirm(`Publish ${drafts} draft report${drafts === 1 ? '' : 's'} for ${data.class.name}? Parents will see them straight away.`)) return;
      try {
        const result = await api('/api/admin/progress/publish', { method: 'POST', body: { classId, month } });
        const skipped = result.skipped.length ? ` Not published (incomplete): ${result.skipped.join(', ')}.` : '';
        toast(`Published ${result.published} report${result.published === 1 ? '' : 's'}.${skipped}`, { duration: 5000 });
        await load(selectedId);
        render();
      } catch (err) {
        toast(err.message, { tone: 'error' });
      }
    }
  });

  ctx.setGuard(() => (dirty ? `You have unsaved changes for ${current()?.name}. Leave without saving?` : null));

  await load(Number(ctx.query.get('student')) || undefined);
  render();
}
