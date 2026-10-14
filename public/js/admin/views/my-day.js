import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';
import { icon } from '../../lib/icons.js';
import { openModal, pageHead } from '../components.js';
import { session } from '../session.js';
import { formatDate, formatPhone, greeting, hourNow } from '/shared/format.js';

// A teacher's home page: today's periods, their classes and today's attendance.

const nowMinutes = () => {
  const [h, m] = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }).split(':').map(Number);
  return h * 60 + m;
};
const minutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

function studentsModal(data) {
  openModal(
    String(html`
      <h2 class="modal-title">${data.class.label}</h2>
      <p class="muted" style="margin: 0">${data.students.length} students${data.class.classTeacher ? ` · Class teacher: ${data.class.classTeacher.name}` : ''}</p>
      <div class="table-wrap" style="max-height: 60vh; overflow: auto">
        <table class="table table--compact">
          <thead><tr><th class="num">Roll</th><th>Student</th><th>Admission No.</th><th>Parents</th>${data.students[0]?.parentPhone !== undefined ? html`<th>Mobile</th>` : ''}</tr></thead>
          <tbody>
            ${data.students.map(
              (s) => html`<tr><td class="num">${s.rollNo}</td><td class="strong">${s.name}</td><td class="mono">${s.admissionNo}</td><td>${s.parentNames}</td>${s.parentPhone !== undefined ? html`<td class="nowrap"><a href="tel:+91${s.parentPhone}">${formatPhone(s.parentPhone)}</a></td>` : ''}</tr>`,
            )}
          </tbody>
        </table>
      </div>
      <div class="form-actions"><button type="button" class="btn" data-close>Close</button></div>
    `),
    { label: data.class.label, wide: true },
  ).querySelector('[data-close]').addEventListener('click', (event) => event.target.closest('dialog').close());
}

export async function myDayView(root) {
  const { staff } = session.meta;
  const d = await api('/api/admin/my-day');
  const marked = new Map(d.attendance.classes.map((c) => [c.classId, c]));
  const now = nowMinutes();
  const current = d.periods.find((p) => minutes(p.start) <= now && now < minutes(p.end));

  mount(
    root,
    html`
      <div class="page">
        ${pageHead(`${greeting(hourNow())}, ${staff.name.split(' ')[0]}`, `Your day · ${formatDate(d.date)}`)}

        ${d.classes.length
          ? ''
          : html`<div class="banner banner--info"><span>No classes are assigned to you yet. The school admin assigns classes on <strong>Subjects &amp; Teachers</strong>, or gives you periods in the timetable.</span></div>`}

        <div class="grid-2 my-day">
          <section class="panel">
            <div class="panel-head"><h2 class="panel-title">${icon('clock', 18)} Today’s periods</h2><a class="link-button" href="/admin/timetable">Full timetable</a></div>
            ${d.periods.some((p) => p.lesson)
              ? html`
                  <ol class="period-list">
                    ${d.periods.map(
                      (p) => html`
                        <li class="${p === current ? 'is-now' : ''} ${p.lesson ? '' : 'is-free'}">
                          <span class="period-no">${p.period}</span>
                          <span class="period-time">${p.start}–${p.end}</span>
                          <span class="grow">${p.lesson ? html`<strong>${p.lesson.className}</strong> · ${p.lesson.subject ?? 'Period'}` : 'Free'}</span>
                          ${p === current ? html`<span class="ai-chip ai-chip--warn">Now</span>` : ''}
                        </li>
                      `,
                    )}
                  </ol>
                `
              : html`<p class="panel-empty">${new Date(`${d.date}T00:00:00Z`).getUTCDay() === 0 ? 'Sunday: no periods.' : 'No periods for you today.'}</p>`}
          </section>

          <section class="panel">
            <div class="panel-head"><h2 class="panel-title">${icon('checklist', 18)} Attendance today</h2></div>
            <div class="class-cards">
              ${d.classes.map((c) => {
                const a = marked.get(c.classId);
                return html`
                  <div class="class-card">
                    <div class="class-card-head">
                      <strong>${c.label}</strong>
                      ${c.classTeacher ? html`<span class="ai-chip">Class teacher</span>` : ''}
                    </div>
                    <div class="muted" style="font-size: 13.5px">
                      ${a?.marked ? html`<span class="pay-badge pay-badge--paid">Marked</span> ${a.attended} present · ${a.absent} absent${a.leave ? ` · ${a.leave} leave` : ''}` : html`<span class="pay-badge pay-badge--pending">Not marked yet</span>`}
                    </div>
                    <div class="class-card-actions">
                      <a class="btn btn--small ${a?.marked ? '' : 'btn--primary'}" href="/admin/attendance?class=${c.classId}">${a?.marked ? 'Review attendance' : 'Mark attendance'}</a>
                      <button type="button" class="btn btn--small" data-students="${c.classId}">Students</button>
                      <a class="btn btn--small" href="/admin/progress?class=${c.classId}">Progress</a>
                    </div>
                  </div>
                `;
              })}
            </div>
          </section>
        </div>

        <section class="panel">
          <div class="panel-head"><h2 class="panel-title">Absent today in your classes</h2><span class="muted">${d.absentees.length}</span></div>
          ${d.absentees.length
            ? html`<div class="table-wrap"><table class="table table--compact"><thead><tr><th>Student</th><th>Class</th><th>Status</th><th>Note</th></tr></thead><tbody>
                ${d.absentees.map((s) => html`<tr><td class="strong">${s.name}</td><td>${s.classLabel}</td><td>${s.status === 'leave' ? 'Leave' : 'Absent'}</td><td class="muted">${s.note ?? ''}</td></tr>`)}
              </tbody></table></div>`
            : html`<p class="panel-empty">Nobody marked absent so far today.</p>`}
        </section>
      </div>
    `,
  );

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-students]');
    if (!button) return;
    button.disabled = true;
    try {
      studentsModal(await api(`/api/admin/classes/${button.dataset.students}/students`));
    } finally {
      button.disabled = false;
    }
  });
}
