import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';
import { bottomNav, pageHead, studentLine } from '../components.js';
import { loadFamily } from '../store.js';
import { formatDate, MONTHS, MONTHS_LONG, todayIso } from '/shared/format.js';

// A child's daily attendance: the month as a calendar, and totals.

const LABEL = { present: 'Present', absent: 'Absent', late: 'Late', leave: 'Leave' };
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function calendar(month, days) {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); // Sunday = 0
  const lead = (first + 6) % 7; // Monday first
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const marks = new Map(days.map((d) => [d.date, d]));
  const today = todayIso();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(html`<span class="cal-day cal-day--blank" aria-hidden="true"></span>`);
  for (let d = 1; d <= count; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const mark = marks.get(date);
    const sunday = new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
    const state = mark ? mark.status : sunday ? 'holiday' : date > today ? 'future' : 'none';
    const label = `${formatDate(date)}: ${mark ? LABEL[mark.status] : sunday ? 'Sunday' : date > today ? 'Upcoming' : 'Not marked'}${mark?.note ? ` (${mark.note})` : ''}`;
    cells.push(html`<span class="cal-day cal-day--${state} ${date === today ? 'cal-day--today' : ''}" title="${label}" aria-label="${label}">${d}</span>`);
  }
  return html`
    <div class="cal" role="grid" aria-label="Attendance calendar">
      ${WEEKDAYS.map((w) => html`<span class="cal-head" aria-hidden="true">${w}</span>`)}
      ${cells}
    </div>
  `;
}

export async function attendanceView(root, { query }) {
  const { child } = await loadFamily();
  let month = /^\d{4}-\d{2}$/.test(query.get('month') ?? '') ? query.get('month') : null;

  async function render() {
    const data = await api(`/api/students/${child.id}/attendance${month ? `?month=${month}` : ''}`);
    month = data.month;
    const s = data.summary;
    mount(
      root,
      html`
        <main class="screen">
          ${pageHead('Attendance', studentLine(data.student))}
          <div class="month-pills" role="group" aria-label="Month">
            ${[...data.months].reverse().map((m) => {
              const [y, mm] = m.split('-').map(Number);
              return html`<button type="button" class="month-pill" data-month="${m}" aria-pressed="${m === month}" aria-label="${MONTHS_LONG[mm - 1]} ${y}">${MONTHS[mm - 1]}</button>`;
            })}
          </div>

          <section class="card card--gap-10" aria-label="This month">
            <div class="card-head card-head--baseline">
              <h2 class="card-title">${data.monthLabel}</h2>
              <div class="big-number">${s.pct === null ? '–' : `${s.pct}%`}</div>
            </div>
            <div class="meter"><div class="meter-fill meter-fill--ok" style="width: ${s.pct ?? 0}%"></div></div>
            <div class="meta">${s.days ? `Present ${s.attended} of ${s.days} school days marked` : 'No attendance marked yet this month.'}</div>
            <div class="att-counts">
              <span class="att-chip att-chip--present">${s.present} present</span>
              <span class="att-chip att-chip--late">${s.late} late</span>
              <span class="att-chip att-chip--absent">${s.absent} absent</span>
              <span class="att-chip att-chip--leave">${s.leave} leave</span>
            </div>
          </section>

          <section class="card card--gap-10" aria-label="Calendar">
            ${calendar(month, data.days)}
            <div class="cal-legend" aria-hidden="true">
              <span><i class="dot dot--present"></i>Present</span><span><i class="dot dot--late"></i>Late</span>
              <span><i class="dot dot--absent"></i>Absent</span><span><i class="dot dot--leave"></i>Leave</span>
            </div>
          </section>

          ${data.session.days
            ? html`<p class="meta" style="text-align: center">This session so far: <strong>${data.session.pct}%</strong> (${data.session.attended} of ${data.session.days} days)</p>`
            : ''}
        </main>
        ${bottomNav('calendar')}
      `,
    );
  }

  root.addEventListener('click', (event) => {
    const pill = event.target.closest('[data-month]');
    if (!pill) return;
    month = pill.dataset.month;
    history.replaceState(null, '', `/attendance?month=${month}`);
    render().catch(() => {});
  });

  await render();
}
