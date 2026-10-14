import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';
import { bottomNav, pageHead } from '../components.js';
import { loadFamily } from '../store.js';

// The class timetable, one day at a time (today first).

export async function timetableView(root) {
  const { child } = await loadFamily();
  const data = await api(`/api/students/${child.id}/timetable`);
  let day = data.today >= 1 && data.today <= data.days.length ? data.today : 1;

  function render() {
    const lessons = data.periods.map((p) => ({ ...p, lesson: data.cells.find((c) => c.day === day && c.period === p.period) }));
    mount(
      root,
      html`
        <main class="screen">
          ${pageHead('Timetable', `${data.student.name} · ${data.class.label}`)}
          <div class="month-pills" role="group" aria-label="Day">
            ${data.days.map((d, i) => html`<button type="button" class="month-pill" data-day="${i + 1}" aria-pressed="${i + 1 === day}" aria-label="${d}">${d.slice(0, 3)}${i + 1 === data.today ? ' ·' : ''}</button>`)}
          </div>
          <section class="card card--flush" aria-label="${data.days[day - 1]}">
            ${data.cells.length
              ? lessons.map(
                  (p) => html`
                    ${p.period === data.breakAfter + 1 ? html`<div class="tt-break">Lunch break</div>` : ''}
                    <div class="tt-row">
                      <div class="tt-time"><strong>${p.period}</strong><span>${p.start}–${p.end}</span></div>
                      <div class="grow">
                        <div class="row-title">${p.lesson?.subject ?? 'Free period'}</div>
                        ${p.lesson?.teacher ? html`<div class="row-sub">${p.lesson.teacher}</div>` : ''}
                      </div>
                    </div>
                  `,
                )
              : html`<p class="meta" style="padding: 18px">The school has not published this class’s timetable yet.</p>`}
          </section>
        </main>
        ${bottomNav('')}
      `,
    );
  }

  root.addEventListener('click', (event) => {
    const pill = event.target.closest('[data-day]');
    if (!pill) return;
    day = Number(pill.dataset.day);
    render();
  });
  render();
}
