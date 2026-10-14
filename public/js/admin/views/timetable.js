import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';
import { toast } from '../../lib/toast.js';
import { openModal, pageHead } from '../components.js';
import { session } from '../session.js';

// Weekly timetable (Monday to Saturday). Admins edit a class's timetable by
// clicking a period; the server refuses to give a teacher two classes at
// once. Teachers see their own week and their classes' timetables.

function grid(tt, { cell, editable }) {
  return html`
    <div class="table-wrap">
      <table class="table tt-grid">
        <thead>
          <tr>
            <th>Day</th>
            ${tt.periods.map((p) => html`<th>${p.period}<span class="sub">${p.start}–${p.end}</span></th>${p.period === tt.breakAfter ? html`<th class="tt-break-col" aria-label="Lunch break">Lunch</th>` : ''}`)}
          </tr>
        </thead>
        <tbody>
          ${tt.days.map(
            (dayName, i) => html`
              <tr>
                <th scope="row">${dayName.slice(0, 3)}</th>
                ${tt.periods.map((p) => {
                  const c = tt.cells.find((x) => x.day === i + 1 && x.period === p.period);
                  return html`
                    <td class="tt-cell ${c ? '' : 'tt-cell--empty'}">
                      ${editable
                        ? html`<button type="button" class="tt-edit" data-cell="${i + 1}-${p.period}" aria-label="${dayName}, period ${p.period}: ${c ? `${c.subject ?? 'no subject'}, ${c.teacher ?? 'no teacher'}` : 'empty'}">${c ? cell(c) : '+'}</button>`
                        : c
                          ? cell(c)
                          : ''}
                    </td>
                    ${p.period === tt.breakAfter ? html`<td class="tt-break-col"></td>` : ''}
                  `;
                })}
              </tr>
            `,
          )}
        </tbody>
      </table>
    </div>
  `;
}

const classCell = (c) => html`<strong>${c.subject ?? '—'}</strong><span class="sub">${c.teacher ?? 'No teacher'}</span>`;
const teacherCell = (c) => html`<strong>${c.className}</strong><span class="sub">${c.subject ?? ''}</span>`;

export async function timetableView(root, ctx) {
  const meta = session.meta;
  const editable = session.can('timetable.manage');
  const teacher = session.can('teaching');
  const classes = meta.classes;
  let view = ctx.query.get('view') ?? (teacher ? 'mine' : 'class');
  let classId = Number(ctx.query.get('class')) || classes[0]?.id;
  let teacherId = Number(ctx.query.get('teacher')) || null;
  let subjects = [];
  let teachers = [];

  if (editable || session.can('timetable.view')) {
    [{ subjects }, { teachers }] = await Promise.all([api('/api/admin/subjects'), api('/api/admin/teachers')]);
    subjects = subjects.filter((s) => s.active);
    teacherId = teacherId ?? teachers[0]?.id ?? null;
  }

  async function render() {
    let tt = null;
    let title = '';
    if (view === 'mine') {
      tt = await api('/api/admin/timetable/mine');
      title = 'My week';
    } else if (view === 'teacher' && teacherId) {
      tt = await api(`/api/admin/timetable/teacher/${teacherId}`);
      title = teachers.find((t) => t.id === teacherId)?.name ?? '';
    } else if (classId) {
      tt = await api(`/api/admin/timetable?classId=${classId}`);
      title = tt.class.label;
    }
    mount(
      root,
      html`
        <div class="page">
          ${pageHead('Timetable', editable ? 'Click a period to set its subject and teacher. A teacher cannot be given two classes at the same time.' : 'The weekly timetable, Monday to Saturday.')}
          <div class="tabs" role="tablist">
            ${teacher ? html`<button type="button" class="tab" role="tab" data-view="mine" aria-selected="${view === 'mine'}">My week</button>` : ''}
            <button type="button" class="tab" role="tab" data-view="class" aria-selected="${view === 'class'}">By class</button>
            ${teachers.length ? html`<button type="button" class="tab" role="tab" data-view="teacher" aria-selected="${view === 'teacher'}">By teacher</button>` : ''}
          </div>
          <section class="panel">
            <div class="att-toolbar">
              ${view === 'class'
                ? html`<label class="field">Class<select class="control" data-class>${classes.map((c) => html`<option value="${c.id}" ${c.id === classId ? 'selected' : ''}>${c.label}</option>`)}</select></label>`
                : view === 'teacher'
                  ? html`<label class="field">Teacher<select class="control" data-teacher>${teachers.map((t) => html`<option value="${t.id}" ${t.id === teacherId ? 'selected' : ''}>${t.name}</option>`)}</select></label>`
                  : ''}
              <h2 class="panel-title" style="align-self: end">${title}</h2>
            </div>
            ${tt
              ? tt.cells.length || (editable && view === 'class')
                ? grid(tt, { cell: view === 'class' ? classCell : teacherCell, editable: editable && view === 'class' })
                : html`<p class="panel-empty">${view === 'mine' ? 'No periods are given to you in the timetable yet.' : 'No timetable yet.'}</p>`
              : html`<p class="panel-empty">Choose a class.</p>`}
          </section>
        </div>
      `,
    );
    history.replaceState(null, '', `/admin/timetable?${new URLSearchParams({ view, ...(view === 'class' ? { class: classId } : {}), ...(view === 'teacher' ? { teacher: teacherId } : {}) })}`);
  }

  function editCell(day, period) {
    api(`/api/admin/timetable?classId=${classId}`).then((tt) => {
      const current = tt.cells.find((c) => c.day === day && c.period === period);
      const p = tt.periods.find((x) => x.period === period);
      const dialog = openModal(
        String(html`
          <h2 class="modal-title">${tt.class.label} · ${tt.days[day - 1]}, period ${period}</h2>
          <p class="muted" style="margin: 0">${p.start}–${p.end}</p>
          <form class="modal-body" style="padding: 0" novalidate>
            <label class="field">Subject<select class="control" name="subjectId"><option value="">— None —</option>${subjects.map((s) => html`<option value="${s.id}" ${s.id === current?.subjectId ? 'selected' : ''}>${s.name}</option>`)}</select></label>
            <label class="field">Teacher<select class="control" name="teacherId"><option value="">— None —</option>${teachers.map((t) => html`<option value="${t.id}" ${t.id === current?.teacherId ? 'selected' : ''}>${t.name}${t.designation ? ` (${t.designation})` : ''}</option>`)}</select></label>
            <p class="form-error" role="alert" hidden></p>
            <div class="form-actions">
              ${current ? html`<button type="button" class="btn link-button--danger" data-clear>Clear period</button>` : ''}
              <button type="button" class="btn" data-close>Cancel</button>
              <button type="submit" class="btn btn--primary">Save</button>
            </div>
          </form>
        `),
        { label: 'Edit period' },
      );
      const form = dialog.querySelector('form');
      const submit = async (body) => {
        try {
          await api(`/api/admin/timetable/${classId}/${day}/${period}`, { method: 'PUT', body });
          dialog.close();
          await render();
        } catch (err) {
          const box = form.querySelector('.form-error');
          box.textContent = err.message;
          box.hidden = false;
        }
      };
      dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
      dialog.querySelector('[data-clear]')?.addEventListener('click', () => submit({ subjectId: null, teacherId: null }));
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        submit({ subjectId: Number(form.subjectId.value) || null, teacherId: Number(form.teacherId.value) || null });
      });
    });
  }

  root.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-view]');
    if (tab) {
      view = tab.dataset.view;
      render().catch((err) => toast(err.message, { tone: 'error' }));
      return;
    }
    const cell = event.target.closest('[data-cell]');
    if (cell) {
      const [day, period] = cell.dataset.cell.split('-').map(Number);
      editCell(day, period);
    }
  });
  root.addEventListener('change', (event) => {
    if (event.target.matches('[data-class]')) classId = Number(event.target.value);
    else if (event.target.matches('[data-teacher]')) teacherId = Number(event.target.value);
    else return;
    render().catch((err) => toast(err.message, { tone: 'error' }));
  });

  await render();
}
