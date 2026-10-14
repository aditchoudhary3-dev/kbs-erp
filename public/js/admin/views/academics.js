import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';
import { toast } from '../../lib/toast.js';
import { openModal, pageHead } from '../components.js';
import { session } from '../session.js';

// Subjects, and which classes each teacher teaches (and who is class teacher).
// A teacher sees only these classes. Giving a teacher a period in the
// timetable also adds that class.

export async function academicsView(root) {
  const meta = session.meta;

  async function render() {
    const [{ subjects }, { teachers }] = await Promise.all([api('/api/admin/subjects'), api('/api/admin/teachers')]);
    const classTeacher = new Map();
    for (const t of teachers) for (const c of t.classes) if (c.classTeacher) classTeacher.set(c.classId, t.name);
    const without = meta.classes.filter((c) => !classTeacher.has(c.id));

    mount(
      root,
      html`
        <div class="page">
          ${pageHead('Subjects & Teachers', 'Teachers see only the classes they are given here (or have periods in, on the Timetable). Add teachers on Staff Records.')}

          <section class="panel">
            <div class="panel-head">
              <h2 class="panel-title">Teachers and their classes</h2>
              <a class="link-button" href="/admin/users">Add a teacher</a>
            </div>
            ${teachers.length
              ? html`
                  <div class="table-wrap">
                    <table class="table">
                      <thead><tr><th>Teacher</th><th>Classes</th><th></th></tr></thead>
                      <tbody>
                        ${teachers.map(
                          (t) => html`
                            <tr>
                              <td><span class="strong">${t.name}</span><span class="sub">${t.designation || 'Teacher'}</span></td>
                              <td>
                                ${t.classes.length
                                  ? html`<span class="chip-list">${t.classes.map((c) => html`<span class="class-chip ${c.classTeacher ? 'class-chip--ct' : ''}" title="${c.classTeacher ? 'Class teacher' : 'Subject teacher'}">${c.label}${c.classTeacher ? ' ★' : ''}</span>`)}</span>`
                                  : html`<span class="muted">No classes yet</span>`}
                              </td>
                              <td><button type="button" class="link-button" data-edit="${t.id}">Change classes</button></td>
                            </tr>
                          `,
                        )}
                      </tbody>
                    </table>
                  </div>
                  <p class="muted" style="margin: 0 20px 16px; font-size: 13px">★ class teacher (marks attendance and sees parents’ phone numbers). ${without.length ? `Classes without a class teacher: ${without.map((c) => c.label).join(', ')}.` : 'Every class has a class teacher.'}</p>
                `
              : html`<p class="panel-empty">No teachers yet. Add them on <a href="/admin/users">Staff Records</a> with the role Teacher.</p>`}
          </section>

          <section class="panel">
            <div class="panel-head"><h2 class="panel-title">Subjects</h2></div>
            <div class="panel-body">
              <form class="subject-add" data-add-subject>
                <input class="control" name="name" placeholder="New subject, e.g. Punjabi" maxlength="40" required />
                <button type="submit" class="btn btn--primary">Add subject</button>
              </form>
              <div class="chip-list" style="margin-top: 14px">
                ${subjects.map(
                  (s) => html`<span class="class-chip ${s.active ? '' : 'class-chip--off'}">${s.name}
                    <button type="button" class="chip-x" data-subject="${s.id}" data-active="${s.active ? '0' : '1'}" aria-label="${s.active ? `Remove ${s.name}` : `Restore ${s.name}`}">${s.active ? '×' : '↺'}</button></span>`,
                )}
              </div>
              <p class="muted" style="margin: 12px 0 0; font-size: 13px">Removed subjects stay on old timetables and can be restored. Monthly progress reports use: ${meta.subjects.join(', ')}.</p>
            </div>
          </section>
        </div>
      `,
    );
  }

  function editClasses(teacher) {
    const current = new Map(teacher.classes.map((c) => [c.classId, c.classTeacher]));
    const dialog = openModal(
      String(html`
        <h2 class="modal-title">Classes for ${teacher.name}</h2>
        <p class="muted" style="margin: 0; font-size: 14px">Tick the classes ${teacher.name.split(' ')[0]} teaches. Choose one class where they are the class teacher, if any.</p>
        <form class="modal-body" style="padding: 0" novalidate>
          <div class="class-pick">
            ${meta.classes.map(
              (c) => html`
                <div class="class-pick-row">
                  <label class="check-field"><input type="checkbox" name="class" value="${c.id}" ${current.has(c.id) ? 'checked' : ''} /> ${c.label}</label>
                  <label class="check-field muted"><input type="radio" name="classTeacher" value="${c.id}" ${current.get(c.id) ? 'checked' : ''} /> class teacher</label>
                </div>
              `,
            )}
          </div>
          <label class="check-field"><input type="radio" name="classTeacher" value="" ${[...current.values()].some(Boolean) ? '' : 'checked'} /> Not a class teacher</label>
          <p class="form-error" role="alert" hidden></p>
          <div class="form-actions">
            <button type="button" class="btn" data-close>Cancel</button>
            <button type="submit" class="btn btn--primary">Save</button>
          </div>
        </form>
      `),
      { label: `Classes for ${teacher.name}`, wide: true },
    );
    const form = dialog.querySelector('form');
    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    form.addEventListener('change', (event) => {
      // Choosing a class-teacher class ticks that class too.
      if (event.target.name === 'classTeacher' && event.target.value) form.querySelector(`[name="class"][value="${event.target.value}"]`).checked = true;
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const ct = Number(form.classTeacher.value) || null;
      const classes = [...form.querySelectorAll('[name="class"]:checked')].map((b) => ({ classId: Number(b.value), classTeacher: Number(b.value) === ct }));
      try {
        await api(`/api/admin/teachers/${teacher.id}/classes`, { method: 'PUT', body: { classes } });
        dialog.close();
        toast(`Classes saved for ${teacher.name}.`);
        await render();
      } catch (err) {
        const box = form.querySelector('.form-error');
        box.textContent = err.message;
        box.hidden = false;
      }
    });
  }

  root.addEventListener('click', async (event) => {
    const edit = event.target.closest('[data-edit]');
    if (edit) {
      const { teachers } = await api('/api/admin/teachers');
      editClasses(teachers.find((t) => t.id === Number(edit.dataset.edit)));
      return;
    }
    const subject = event.target.closest('[data-subject]');
    if (subject) {
      try {
        await api(`/api/admin/subjects/${subject.dataset.subject}/status`, { method: 'POST', body: { active: subject.dataset.active === '1' } });
        await render();
      } catch (err) {
        toast(err.message, { tone: 'error' });
      }
    }
  });
  root.addEventListener('submit', async (event) => {
    if (!event.target.matches('[data-add-subject]')) return;
    event.preventDefault();
    try {
      const { subject } = await api('/api/admin/subjects', { method: 'POST', body: { name: event.target.name.value } });
      toast(`${subject.name} added.`);
      await render();
    } catch (err) {
      toast(err.message, { tone: 'error' });
    }
  });

  await render();
}
