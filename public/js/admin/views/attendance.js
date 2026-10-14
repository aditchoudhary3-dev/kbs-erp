import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';
import { icon } from '../../lib/icons.js';
import { toast } from '../../lib/toast.js';
import { exportButtons, pageHead } from '../components.js';
import { session } from '../session.js';
import { formatDate, formatDateTime, MONTHS_LONG } from '/shared/format.js';

// Daily attendance. Teachers mark their own classes (today, or up to a week
// back); the office sees every class, today's summary and monthly registers.

const STATUSES = [
  ['present', 'P', 'Present'],
  ['absent', 'A', 'Absent'],
  ['late', 'L', 'Late'],
  ['leave', 'Lv', 'Leave'],
];

const shift = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const monthOptions = (today) => {
  const out = [];
  let [y, m] = today.split('-').map(Number);
  for (let i = 0; i < 12; i++) {
    out.push({ key: `${y}-${String(m).padStart(2, '0')}`, label: `${MONTHS_LONG[m - 1]} ${y}` });
    m -= 1;
    if (!m) {
      m = 12;
      y -= 1;
    }
  }
  return out;
};

export async function attendanceView(root, ctx) {
  const meta = session.meta;
  const canMark = session.can('attendance.mark');
  const officeView = session.can('attendance.view');
  const classes = meta.classes;
  if (!classes.length) {
    mount(root, html`<div class="page">${pageHead('Attendance', 'No classes are assigned to you yet. Please ask the school admin.')}</div>`);
    return;
  }
  const preferred = classes.find((c) => String(c.id) === ctx.query.get('class'));
  let tab = ctx.query.get('tab') ?? (officeView && !preferred && !canMark ? 'today' : 'mark');
  let classId = (preferred ?? classes[0]).id;
  let date = ctx.query.get('date') ?? meta.today;
  let month = meta.today.slice(0, 7);
  let sheet = null; // the class's day
  let marks = new Map(); // studentId -> { status, note }
  let dirty = false;

  const earliest = session.can('timetable.manage') ? '2026-04-01' : shift(meta.today, -7);

  function syncUrl() {
    const q = new URLSearchParams({ tab, ...(tab !== 'today' ? { class: classId } : {}), ...(tab === 'mark' ? { date } : {}) });
    history.replaceState(null, '', `/admin/attendance?${q}`);
  }

  async function loadSheet() {
    sheet = await api(`/api/admin/attendance?classId=${classId}&date=${date}`);
    // A new day starts with everyone present; the teacher marks the exceptions.
    marks = new Map(sheet.students.map((s) => [s.id, { status: s.status ?? (canMark ? 'present' : null), note: s.note ?? '' }]));
    dirty = !sheet.marked && canMark && sheet.students.length > 0;
  }

  const counts = () => {
    const t = { present: 0, absent: 0, late: 0, leave: 0, none: 0 };
    for (const m of marks.values()) t[m.status ?? 'none'] += 1;
    return t;
  };

  function markPanel() {
    const sunday = new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
    const editable = canMark && date >= earliest && !sunday;
    const t = counts();
    return html`
      <section class="panel">
        <div class="att-toolbar">
          <label class="field">Class<select class="control" data-class>${classes.map((c) => html`<option value="${c.id}" ${c.id === classId ? 'selected' : ''}>${c.label ?? c.name}</option>`)}</select></label>
          <label class="field">Date<input class="control" type="date" data-date value="${date}" max="${meta.today}" min="${canMark && !officeView ? earliest : '2026-04-01'}" /></label>
          <div class="att-counts">
            <span class="att-count att-count--present">${t.present + t.late} present</span>
            <span class="att-count att-count--absent">${t.absent} absent</span>
            ${t.leave ? html`<span class="att-count att-count--leave">${t.leave} leave</span>` : ''}
            ${t.none ? html`<span class="att-count">${t.none} not marked</span>` : ''}
          </div>
        </div>
        <div class="att-status">
          ${sunday
            ? html`<strong>Sunday.</strong> No attendance on Sundays.`
            : sheet.marked
              ? html`Saved by <strong>${sheet.markedBy ?? 'staff'}</strong> on ${formatDateTime(sheet.markedAt)}.${editable ? ' You can still change it.' : ''}`
              : editable
                ? html`<strong>Not marked yet.</strong> Everyone starts as Present: tap the students who are absent, late or on leave, then save.`
                : 'Not marked for this day.'}
        </div>
        ${sheet.students.length
          ? html`
              <ul class="att-list" data-list>
                ${sheet.students.map((s) => {
                  const m = marks.get(s.id);
                  return html`
                    <li class="att-row att-row--${m.status ?? 'none'}" data-student="${s.id}">
                      <span class="att-roll">${s.rollNo}</span>
                      <span class="att-name"><strong>${s.name}</strong><span class="muted">${s.admissionNo}</span></span>
                      <span class="att-buttons" role="radiogroup" aria-label="Attendance for ${s.name}">
                        ${STATUSES.map(
                          ([value, code, label]) => html`<button type="button" class="att-btn att-btn--${value}" role="radio" aria-checked="${m.status === value}" aria-label="${label}" title="${label}" data-status="${value}" ${editable ? '' : 'disabled'}>${code}</button>`,
                        )}
                      </span>
                      ${m.status === 'absent' || m.status === 'leave' || m.note
                        ? html`<input class="control control--small att-note" data-note placeholder="Reason (optional)" maxlength="120" value="${m.note}" ${editable ? '' : 'disabled'} />`
                        : ''}
                    </li>
                  `;
                })}
              </ul>
              ${editable
                ? html`
                    <div class="sticky-actions sticky-actions--att">
                      <button type="button" class="btn" data-all-present>All present</button>
                      <button type="button" class="btn btn--primary" data-save>${icon('check', 18, 2.5)} Save attendance</button>
                    </div>
                  `
                : ''}
            `
          : html`<p class="panel-empty">No students in this class.</p>`}
      </section>
    `;
  }

  async function registerPanel() {
    const reg = await api(`/api/admin/attendance/register?classId=${classId}&month=${month}`);
    const days = reg.dates.map((d) => `d${d.slice(8)}`);
    return html`
      <section class="panel">
        <div class="att-toolbar">
          <label class="field">Class<select class="control" data-class>${classes.map((c) => html`<option value="${c.id}" ${c.id === classId ? 'selected' : ''}>${c.label ?? c.name}</option>`)}</select></label>
          <label class="field">Month<select class="control" data-month>${monthOptions(meta.today).map((m) => html`<option value="${m.key}" ${m.key === month ? 'selected' : ''}>${m.label}</option>`)}</select></label>
          <span class="grow"></span>
          ${exportButtons('/api/admin/attendance/register/export', { classId, month })}
        </div>
        <p class="muted" style="margin: 0 20px 12px">${reg.subtitle}. ${reg.legend}.</p>
        ${reg.rows.length && reg.dates.length
          ? html`
              <div class="table-wrap">
                <table class="table table--compact att-register">
                  <thead><tr><th class="num">Roll</th><th>Student</th>${reg.dates.map((d) => html`<th class="num" title="${formatDate(d)}">${Number(d.slice(8))}</th>`)}<th class="num">Present</th><th class="num">Absent</th><th class="num">%</th></tr></thead>
                  <tbody>
                    ${reg.rows.map(
                      (r) => html`<tr><td class="num">${r.rollNo}</td><td class="strong nowrap">${r.name}</td>${days.map((k) => html`<td class="num reg-${r[k] || 'none'}">${r[k]}</td>`)}<td class="num">${r.present}</td><td class="num">${r.absent}</td><td class="num strong">${r.pct}</td></tr>`,
                    )}
                  </tbody>
                </table>
              </div>
            `
          : html`<p class="panel-empty">No attendance marked in this month yet.</p>`}
      </section>
    `;
  }

  async function todayPanel() {
    const s = await api(`/api/admin/attendance/summary?date=${date}`);
    return html`
      <section class="panel">
        <div class="att-toolbar">
          <label class="field">Date<input class="control" type="date" data-date value="${date}" max="${meta.today}" /></label>
          <div class="att-counts">
            <span class="att-count">${s.markedClasses} of ${s.totalClasses} classes marked</span>
            <span class="att-count att-count--present">${s.attended} present</span>
            <span class="att-count att-count--absent">${s.absent} absent</span>
            ${s.leave ? html`<span class="att-count att-count--leave">${s.leave} leave</span>` : ''}
            ${s.pct !== null ? html`<span class="att-count"><strong>${s.pct}%</strong> attendance</span>` : ''}
          </div>
        </div>
        <div class="table-wrap">
          <table class="table table--compact">
            <thead><tr><th>Class</th><th class="num">Students</th><th>Status</th><th class="num">Present</th><th class="num">Absent</th><th class="num">Leave</th><th></th></tr></thead>
            <tbody>
              ${s.classes.map(
                (c) => html`<tr>
                  <td class="strong">${c.label}</td><td class="num">${c.students}</td>
                  <td>${c.marked ? html`<span class="pay-badge pay-badge--paid">Marked</span>` : html`<span class="pay-badge pay-badge--pending">Not marked</span>`}</td>
                  <td class="num">${c.marked ? c.attended : '—'}</td><td class="num">${c.marked ? c.absent : '—'}</td><td class="num">${c.marked ? c.leave : '—'}</td>
                  <td><button type="button" class="link-button" data-open-class="${c.classId}">${c.marked ? 'View' : canMark ? 'Mark' : 'Open'}</button></td>
                </tr>`,
              )}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  async function render() {
    let body;
    if (tab === 'mark') {
      await loadSheet();
      body = markPanel();
    } else if (tab === 'register') {
      body = await registerPanel();
    } else {
      body = await todayPanel();
    }
    mount(
      root,
      html`
        <div class="page">
          ${pageHead('Attendance', canMark && !officeView ? 'Mark your classes every school day. Parents see their child’s attendance in the app.' : 'Daily attendance for every class. Parents see their child’s attendance in the app.')}
          <div class="tabs" role="tablist">
            <button type="button" class="tab" role="tab" data-tab="mark" aria-selected="${tab === 'mark'}">${canMark ? 'Mark attendance' : 'Class day'}</button>
            <button type="button" class="tab" role="tab" data-tab="register" aria-selected="${tab === 'register'}">Monthly register</button>
            ${officeView ? html`<button type="button" class="tab" role="tab" data-tab="today" aria-selected="${tab === 'today'}">Whole school</button>` : ''}
          </div>
          ${body}
        </div>
      `,
    );
    syncUrl();
  }

  // Updates one row without re-rendering the whole list (keeps focus and scroll).
  function refreshRow(studentId) {
    const li = root.querySelector(`[data-student="${studentId}"]`);
    const m = marks.get(studentId);
    li.className = `att-row att-row--${m.status ?? 'none'}`;
    li.querySelectorAll('[data-status]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.status === m.status)));
    const note = li.querySelector('[data-note]');
    if ((m.status === 'absent' || m.status === 'leave') && !note) {
      li.insertAdjacentHTML('beforeend', String(html`<input class="control control--small att-note" data-note placeholder="Reason (optional)" maxlength="120" value="${m.note}" />`));
    }
    const t = counts();
    root.querySelector('.att-counts').innerHTML = String(html`
      <span class="att-count att-count--present">${t.present + t.late} present</span>
      <span class="att-count att-count--absent">${t.absent} absent</span>
      ${t.leave ? html`<span class="att-count att-count--leave">${t.leave} leave</span>` : ''}
      ${t.none ? html`<span class="att-count">${t.none} not marked</span>` : ''}
    `);
  }

  async function save(button) {
    button.disabled = true;
    try {
      const entries = [...marks.entries()].filter(([, m]) => m.status).map(([studentId, m]) => ({ studentId, status: m.status, note: m.note }));
      const result = await api('/api/admin/attendance', { method: 'PUT', body: { classId, date, entries } });
      dirty = false;
      toast(`Attendance saved for ${result.class.label}: ${result.counts.attended} present, ${result.counts.absent} absent.`);
      await render();
    } catch (err) {
      toast(err.message, { tone: 'error' });
      button.disabled = false;
    }
  }

  ctx.setGuard(() => (dirty && tab === 'mark' ? 'You have not saved this attendance. Leave without saving?' : null));

  root.addEventListener('click', (event) => {
    const t = event.target;
    const tabButton = t.closest('[data-tab]');
    if (tabButton) {
      if (dirty && tab === 'mark' && !window.confirm('You have not saved this attendance. Leave without saving?')) return;
      tab = tabButton.dataset.tab;
      render().catch((err) => toast(err.message, { tone: 'error' }));
      return;
    }
    const status = t.closest('[data-status]');
    if (status && !status.disabled) {
      const id = Number(status.closest('[data-student]').dataset.student);
      marks.get(id).status = status.dataset.status;
      dirty = true;
      refreshRow(id);
      return;
    }
    if (t.closest('[data-all-present]')) {
      for (const m of marks.values()) m.status = 'present';
      dirty = true;
      for (const id of marks.keys()) refreshRow(id);
      return;
    }
    const saveButton = t.closest('[data-save]');
    if (saveButton) {
      save(saveButton);
      return;
    }
    const open = t.closest('[data-open-class]');
    if (open) {
      classId = Number(open.dataset.openClass);
      tab = 'mark';
      render().catch((err) => toast(err.message, { tone: 'error' }));
    }
  });

  root.addEventListener('input', (event) => {
    if (!event.target.matches('[data-note]')) return;
    const id = Number(event.target.closest('[data-student]').dataset.student);
    marks.get(id).note = event.target.value;
    dirty = true;
  });

  root.addEventListener('change', (event) => {
    const t = event.target;
    if (t.matches('[data-class], [data-date], [data-month]')) {
      if (dirty && tab === 'mark' && !window.confirm('You have not saved this attendance. Leave without saving?')) {
        render();
        return;
      }
      if (t.matches('[data-class]')) classId = Number(t.value);
      if (t.matches('[data-date]') && t.value) date = t.value;
      if (t.matches('[data-month]')) month = t.value;
      render().catch((err) => toast(err.message, { tone: 'error' }));
    }
  });

  await render();
}
