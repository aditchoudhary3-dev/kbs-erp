import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';
import { icon } from '../../lib/icons.js';
import { bindInstallCard, bottomNav, installCard, openSheet } from '../components.js';
import { forgetFamily, loadFamily, selectChild } from '../store.js';
import { firstName, formatDate, greeting, hourNow, initials, possessive, rupees } from '/shared/format.js';

function feesCard(fees) {
  if (!fees.total) {
    return html`
      <section class="card card--ok" aria-label="Fees">
        <div class="ok-row">
          <div class="ok-mark">${icon('check', 22, 2.5)}</div>
          <div class="grow">
            <div class="card-title">All fees paid</div>
            <div class="meta">Nothing is due right now.</div>
          </div>
          <a class="card-link" href="/fees">History</a>
        </div>
      </section>
    `;
  }
  return html`
    <section class="card card--warn" aria-label="Fees due">
      <div class="card-head card-head--top">
        <div class="head-text">
          <div class="fee-label">${fees.overdue ? 'Fees overdue' : 'Fees due'}</div>
          <div class="fee-amount">${rupees(fees.total)}</div>
        </div>
        <div class="pill ${fees.overdue ? 'pill--danger' : 'pill--light'}">
          ${fees.overdue ? 'Was due' : 'Due'} ${formatDate(fees.dueDate, { year: false })}
        </div>
      </div>
      <a href="/fees" class="button button--dark">View and pay</a>
    </section>
  `;
}

function progressCard(progress) {
  if (!progress) {
    return html`
      <section class="card">
        <div class="card-title">Monthly progress</div>
        <p class="meta">Reports will appear here as soon as the school publishes them.</p>
      </section>
    `;
  }
  return html`
    <section class="card">
      <div class="card-head">
        <h2 class="card-title">${progress.monthLabel} progress</h2>
        <a class="card-link" href="/progress?month=${progress.month}">Details</a>
      </div>
      <div class="stats">
        <div class="stat"><div class="stat-value">${progress.avg}%</div><div class="stat-label">Avg. marks</div></div>
        <div class="stat"><div class="stat-value">${progress.attPct}%</div><div class="stat-label">Attendance</div></div>
        <div class="stat"><div class="stat-value">${progress.activities}</div><div class="stat-label">Activities</div></div>
      </div>
    </section>
  `;
}

const TODAY = { present: ['Present today', 'ok'], late: ['Came late today', 'warn'], absent: ['Absent today', 'danger'], leave: ['On leave today', 'warn'] };

function attendanceCard(a) {
  const [label, tone] = TODAY[a.today] ?? ['Not marked yet today', 'light'];
  return html`
    <a class="card card--link" href="/attendance" aria-label="Attendance">
      <div class="card-head">
        <h2 class="card-title">Attendance</h2>
        <span class="pill pill--${tone}">${label}</span>
      </div>
      <div class="meta">${a.days ? html`${a.monthLabel}: <strong style="color: var(--ink)">${a.pct}%</strong> (${a.days} school days marked)` : `No attendance marked yet in ${a.monthLabel}.`}</div>
    </a>
  `;
}

function updateItem(update) {
  const content = html`${icon('bell', 18)}
    <span>${update.text}${update.body ? html`<span class="update-body">${update.body}</span>` : ''}</span>`;
  return update.kind === 'report'
    ? html`<a class="update" href="/progress?month=${update.month}">${content}</a>`
    : html`<div class="update">${content}</div>`;
}

export async function homeView(root, { navigate }) {
  const { me, child } = await loadFamily();
  const data = await api(`/api/students/${child.id}/home`);
  const { student } = data;

  mount(
    root,
    html`
      <main class="screen">
        <div class="school-bar">
          <img src="/logo-192.png" alt="" width="40" height="40" />
          <span>${me.schoolName}</span>
        </div>
        <header class="head">
          <div class="head-text">
            <div class="eyebrow">${greeting(hourNow())}</div>
            <h1 class="title">${possessive(firstName(student.name))} dashboard</h1>
          </div>
          <button type="button" class="icon-button" data-logout aria-label="Log out" title="Log out">
            ${icon('logout', 20)}
          </button>
        </header>

        <section class="student" aria-label="Student">
          <div class="avatar" aria-hidden="true">${initials(student.name)}</div>
          <div class="grow">
            <div class="student-name">${student.name}</div>
            <div class="meta">${student.classLabel} · Roll no. ${student.rollNo}</div>
          </div>
          ${me.children.length > 1
            ? html`<button type="button" class="text-button" data-switch>Switch</button>`
            : ''}
        </section>

        ${installCard()}
        ${feesCard(data.fees)} ${data.attendance ? attendanceCard(data.attendance) : ''} ${progressCard(data.progress)}

        <a href="/timetable" class="feature-link">
          ${icon('clock', 26)}
          <div class="grow">
            <div class="feature-title">Class timetable</div>
            <div class="feature-sub">Today’s periods and the whole week</div>
          </div>
          ${icon('chevronRight', 20)}
        </a>

        <a href="/report" class="feature-link">
          ${icon('report', 26)}
          <div class="grow">
            <div class="feature-title">Annual report ${data.academicYear}</div>
            <div class="feature-sub">All months so far, in one view</div>
          </div>
          ${icon('chevronRight', 20)}
        </a>

        ${data.updates.length
          ? html`<section class="updates" aria-label="Updates from school">${data.updates.map(updateItem)}</section>`
          : ''}
      </main>
      ${bottomNav('home')}
    `,
  );

  bindInstallCard(root);

  root.querySelector('[data-logout]').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    forgetFamily();
    navigate('/login', { replace: true });
  });

  root.querySelector('[data-switch]')?.addEventListener('click', () => {
    const sheet = openSheet(
      String(html`
        <h2 class="sheet-title">Choose a child</h2>
        <div class="options">
          ${me.children.map(
            (c) => html`
              <button type="button" class="child-option" data-child="${c.id}" aria-current="${c.id === child.id}">
                <span class="avatar" aria-hidden="true">${initials(c.name)}</span>
                <span class="grow">
                  <span class="student-name">${c.name}</span>
                  <span class="meta">${c.classLabel} · Roll no. ${c.rollNo}</span>
                </span>
              </button>
            `,
          )}
        </div>
      `),
      { label: 'Choose a child' },
    );
    sheet.addEventListener('click', (event) => {
      const option = event.target.closest('[data-child]');
      if (!option) return;
      selectChild(Number(option.dataset.child));
      sheet.close();
      navigate('/', { replace: true });
    });
  });
}
