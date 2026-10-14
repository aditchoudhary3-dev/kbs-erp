import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';
import { icon } from '../../lib/icons.js';
import { bottomNav, pageHead } from '../components.js';
import { loadFamily } from '../store.js';

// Bars cover marks from 40 to 100 across 140px, as in the mockup.
const barHeight = (value) => Math.max(4, Math.round(((value - 40) / 60) * 140));

function trendLabel(subject) {
  if (subject.trend === null) return html`<span class="trend trend--flat">—</span>`;
  if (subject.trend === 0) return html`<span class="trend trend--flat">No change since ${subject.since}</span>`;
  const up = subject.trend > 0;
  return html`<span class="trend ${up ? '' : 'trend--down'}">${up ? '+' : '−'}${Math.abs(subject.trend)} since ${subject.since}</span>`;
}

const percent = (value) => (value === null ? '–' : `${value}%`);

export async function annualView(root) {
  const { child } = await loadFamily();
  const data = await api(`/api/students/${child.id}/annual`);
  const { student } = data;

  mount(
    root,
    html`
      <main class="screen">
        ${pageHead('Annual report', `${student.name} · ${student.classLabel} · ${data.yearLabel}`)}

        <div class="stats">
          <div class="stat stat--card"><div class="stat-value">${percent(data.avgAll)}</div><div class="stat-label">Avg. marks</div></div>
          <div class="stat stat--card"><div class="stat-value">${percent(data.attAll)}</div><div class="stat-label">Attendance</div></div>
          <div class="stat stat--card"><div class="stat-value">${data.activities}</div><div class="stat-label">Activities</div></div>
        </div>

        <section class="card" aria-label="Average marks by month">
          <div class="head-text" style="gap: 2px">
            <h2 class="card-title">Average marks by month</h2>
            ${data.note ? html`<div class="note">${data.note}</div>` : ''}
          </div>
          <div class="chart" role="img" aria-label="${data.bars
            .filter((b) => b.value !== null)
            .map((b) => `${b.name}: ${b.value}%`)
            .join(', ') || 'No months reported yet'}">
            ${data.bars.map(
              (b) => html`
                <div class="chart-col">
                  <div class="chart-value">${b.value ?? ''}</div>
                  ${b.value === null
                    ? html`<div class="chart-bar chart-bar--empty"></div>`
                    : html`<div class="chart-bar" style="height: ${barHeight(b.value)}px" title="${b.name}: ${b.value}%"></div>`}
                </div>
              `,
            )}
          </div>
          <div class="chart-labels" aria-hidden="true">${data.bars.map((b) => html`<span>${b.label}</span>`)}</div>
        </section>

        <section class="card card--flush" aria-label="Subjects">
          <div class="table-head"><span>Subject (year so far)</span><span>Avg · Trend</span></div>
          ${data.subjects.map(
            (s) => html`
              <div class="subject-row">
                <span>${s.name}</span>
                <span class="subject-figures"><span>${s.avg ?? '–'}</span>${trendLabel(s)}</span>
              </div>
            `,
          )}
        </section>

        ${data.highlights.length
          ? html`
              <section class="card card--gap-10" aria-label="Highlights">
                <h2 class="card-title">Highlights</h2>
                <p class="body-text">${data.highlights.join(' · ')}</p>
              </section>
            `
          : ''}

        <a class="button button--medium" href="/api/students/${student.id}/report-card.pdf" download>
          ${icon('download', 18)} Download report card (PDF)
        </a>
      </main>
      ${bottomNav('report')}
    `,
  );
}
