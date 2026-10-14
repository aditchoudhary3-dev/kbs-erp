import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';
import { bottomNav, pageHead, studentLine } from '../components.js';
import { loadFamily } from '../store.js';

// Marks below this are drawn in amber, as in the mockups.
const LOW_MARK = 75;

function monthDetail(m, className) {
  return html`
    <section class="card card--gap-10" aria-label="Attendance">
      <div class="card-head card-head--baseline">
        <h2 class="card-title">Attendance</h2>
        <div class="big-number">${m.attPct}%</div>
      </div>
      <div class="meter"><div class="meter-fill meter-fill--ok" style="width: ${m.attPct}%"></div></div>
      <div class="meta">Present ${m.daysPresent} of ${m.schoolDays} school days</div>
    </section>

    <section class="card card--gap-12" aria-label="Marks">
      <div class="card-head card-head--baseline">
        <h2 class="card-title">Marks</h2>
        <div class="meta">Average <strong style="color: var(--ink)">${m.avg}%</strong></div>
      </div>
      ${m.marks.map(
        (s) => html`
          <div class="subject">
            <div class="subject-line"><span>${s.subject}</span><span>${s.score ?? '–'} / 100</span></div>
            <div class="meter meter--small">
              <div class="meter-fill ${s.score < LOW_MARK ? 'meter-fill--low' : ''}" style="width: ${s.score ?? 0}%"></div>
            </div>
          </div>
        `,
      )}
    </section>

    <section class="card card--gap-10" aria-label="Teacher remarks">
      <h2 class="card-title">Teacher remarks</h2>
      <p class="body-text">${m.remarks}</p>
      <div class="note">— Class teacher, ${className}</div>
    </section>

    <section class="card card--gap-10" aria-label="Activities">
      <h2 class="card-title">Activities</h2>
      ${m.activities.length
        ? m.activities.map(
            (a) => html`
              <div class="activity">
                <span>${a.name}</span>
                ${a.result ? html`<span class="activity-result">${a.result}</span>` : ''}
              </div>
            `,
          )
        : html`<p class="meta">No activities recorded this month.</p>`}
    </section>
  `;
}

export async function progressView(root, { query }) {
  const { child } = await loadFamily();
  const data = await api(`/api/students/${child.id}/progress`);
  const { months, student } = data;

  if (!months.length) {
    mount(
      root,
      html`
        <main class="screen">
          ${pageHead('Monthly progress', studentLine(student))}
          <section class="card">
            <h2 class="card-title">No reports yet</h2>
            <p class="meta">The school publishes a progress report every month. It will appear here.</p>
          </section>
        </main>
        ${bottomNav('progress')}
      `,
    );
    return;
  }

  let selected = months.find((m) => m.month === query.get('month')) ?? months.at(-1);

  function render() {
    mount(
      root,
      html`
        <main class="screen">
          ${pageHead('Monthly progress', studentLine(student))}
          <div class="month-pills" role="group" aria-label="Month">
            ${months.map(
              (m) => html`
                <button type="button" class="month-pill" data-month="${m.month}" aria-pressed="${m === selected}"
                  aria-label="${m.longLabel}">${m.label}</button>
              `,
            )}
          </div>
          ${monthDetail(selected, student.classLabel)}
        </main>
        ${bottomNav('progress')}
      `,
    );
    root.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  root.addEventListener('click', (event) => {
    const pill = event.target.closest('[data-month]');
    if (!pill) return;
    selected = months.find((m) => m.month === pill.dataset.month);
    history.replaceState(null, '', `/progress?month=${selected.month}`);
    render();
    root.querySelector(`[data-month="${selected.month}"]`)?.focus();
  });

  render();
}
