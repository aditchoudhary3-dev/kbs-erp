import { api } from '../lib/api.js';
import { createRouter } from '../lib/router.js';
import { html, mount } from '../lib/html.js';
import { icon } from '../lib/icons.js';
import { toast } from '../lib/toast.js';
import { session } from './session.js';
import { openModal } from './components.js';
import { startLiveUpdates } from './live.js';
import { openAssistant, startAssistant } from './assistant.js';
import { loginScreen } from './views/login.js';
import { dashboardView } from './views/dashboard.js';
import { collectView } from './views/collect.js';
import { paymentsView } from './views/payments.js';
import { receiptsView } from './views/receipts.js';
import { correctionsView } from './views/corrections.js';
import { classesView } from './views/classes.js';
import { reportsView } from './views/reports.js';
import { exportView } from './views/export.js';
import { studentsView } from './views/students.js';
import { studentFormView } from './views/student-form.js';
import { studentProfileView } from './views/student-profile.js';
import { feeStructureView } from './views/fee-structure.js';
import { progressView } from './views/progress.js';
import { noticesView } from './views/notices.js';
import { usersView } from './views/users.js';
import { auditView } from './views/audit.js';
import { backupView } from './views/backup.js';
import { healthView } from './views/health.js';
import { myDayView } from './views/my-day.js';
import { attendanceView } from './views/attendance.js';
import { timetableView } from './views/timetable.js';
import { academicsView } from './views/academics.js';
import { parentsView } from './views/parents.js';
import { install, installState, registerApp } from '../lib/pwa.js';

registerApp();

const root = document.getElementById('admin');

// The menu, grouped. Each page appears only for staff whose role allows it;
// the server enforces the same permissions on every request.
const MENU = [
  {
    items: [
      { path: '/admin', label: 'Dashboard', icon: 'grid', view: dashboardView, permission: 'dashboard.view' },
      { path: '/admin/my-day', label: 'My Day', icon: 'grid', view: myDayView, permission: 'teaching' },
    ],
  },
  {
    title: 'Students',
    items: [
      { path: '/admin/students/new', label: 'Add Student', icon: 'userPlus', view: studentFormView, permission: 'students.edit' },
      { path: '/admin/students', label: 'Manage Students', icon: 'users', view: studentsView, permission: 'students.view' },
      { path: '/admin/parents', label: 'Parent App Access', icon: 'key', view: parentsView, permission: 'parents.access' },
    ],
  },
  {
    title: 'Academics',
    items: [
      { path: '/admin/attendance', label: 'Attendance', icon: 'checklist', view: attendanceView, permission: ['attendance.mark', 'attendance.view'] },
      { path: '/admin/timetable', label: 'Timetable', icon: 'clock', view: timetableView, permission: ['timetable.view', 'teaching'] },
      { path: '/admin/progress', label: 'Monthly progress', icon: 'progress', view: progressView, permission: ['progress.manage', 'progress.enter'] },
      { path: '/admin/academics', label: 'Subjects & Teachers', icon: 'book', view: academicsView, permission: 'timetable.manage' },
    ],
  },
  {
    title: 'Fees',
    items: [
      { path: '/admin/fee-structure', label: 'Fee Structure', icon: 'fees', view: feeStructureView, permission: 'fees.manage' },
      { path: '/admin/cash', label: 'Cash Collection', icon: 'rupee', view: collectView, permission: 'payments.collect' },
      { path: '/admin/payments', label: 'Payments', icon: 'list', view: paymentsView, permission: 'payments.view' },
      { path: '/admin/receipts', label: 'Receipts', icon: 'receipt', view: receiptsView, permission: 'receipts.print' },
      { path: '/admin/corrections', label: 'Corrections', icon: 'undo', view: correctionsView, permission: 'corrections.request', count: 'pendingCorrections' },
    ],
  },
  {
    title: 'Reports',
    items: [
      { path: '/admin/reports', label: 'Reports', icon: 'chart', view: reportsView, permission: 'reports.view' },
      { path: '/admin/classes', label: 'Class-wise', icon: 'layers', view: classesView, permission: 'reports.view' },
      { path: '/admin/export', label: 'Excel Export', icon: 'download', view: exportView, permission: 'reports.export' },
    ],
  },
  {
    title: 'School',
    items: [
      { path: '/admin/users', label: 'Staff Records', icon: 'shield', view: usersView, permission: 'users.manage' },
      { path: '/admin/notices', label: 'Notices', icon: 'megaphone', view: noticesView, permission: 'notices.manage' },
    ],
  },
  {
    title: 'System',
    items: [
      { path: '/admin/audit', label: 'Audit Logs', icon: 'list', view: auditView, permission: 'audit.view' },
      { path: '/admin/backup', label: 'System Backup', icon: 'database', view: backupView, permission: 'system.manage' },
      { path: '/admin/health', label: 'System Health', icon: 'activity', view: healthView, permission: 'system.manage' },
    ],
  },
];

// Pages reached from other pages rather than the menu.
const EXTRA_ROUTES = [
  { path: '/admin/students/:id/edit', label: 'Edit student', view: studentFormView, permission: 'students.edit' },
  { path: '/admin/students/:id', label: 'Student', view: studentProfileView, permission: 'students.view' },
  { path: '/admin/collect', label: 'Cash Collection', view: collectView, permission: 'payments.collect' },
];

function renderShell(menu) {
  const { staff, school, appName } = session.meta;
  const brand = html`
    <div class="brand">
      <img class="brand-logo" src="${school.logo}" alt="" width="42" height="42" />
      <div class="page-head-text" style="gap: 0">
        <span class="brand-name">${appName}</span>
        <span class="brand-sub">${school.shortName}</span>
      </div>
    </div>
  `;
  mount(
    root,
    html`
      <div class="shell">
        <header class="topbar">
          ${brand}
          <button type="button" class="menu-button" data-menu aria-label="Open menu" aria-expanded="false">${icon('menu', 20)}</button>
        </header>
        <aside class="sidebar" aria-label="Main menu">
          ${brand}
          ${session.meta.assistant
            ? html`<button type="button" class="side-link side-link--ai" data-open-ai>${icon('sparkle', 18)}${session.meta.assistant.name}</button>`
            : ''}
          <nav aria-label="Sections" style="display: contents">
            ${menu.map(
              (group) => html`
                ${group.title ? html`<div class="side-group">${group.title}</div>` : ''}
                ${group.items.map(
                  (p) => html`<a class="side-link" href="${p.path}" data-nav="${p.path}">${icon(p.icon, 18)}${p.label}
                    ${p.count && session.meta[p.count] ? html`<span class="side-count" data-count="${p.count}">${session.meta[p.count]}</span>` : ''}</a>`,
                )}
              `,
            )}
          </nav>
          <div class="side-foot">
            <strong>${staff.name}</strong>
            <span>${staff.email}</span>
            <span class="role-chip">${staff.roleLabel}</span>
            <button type="button" class="link-button side-install" data-install-app hidden>${icon('phone', 16)} Install this app</button>
            <a class="side-parent-link" href="/" target="_blank" rel="noopener">Open the parent app ↗</a>
            <button type="button" class="link-button" data-password>Change password</button>
            <button type="button" class="link-button" data-logout style="margin-top: 2px">Log out</button>
          </div>
        </aside>
        <main class="main" id="outlet"></main>
      </div>
    `,
  );

  const shell = root.querySelector('.shell');
  const menuButton = root.querySelector('[data-menu]');
  menuButton.addEventListener('click', () => {
    const open = shell.classList.toggle('nav-open');
    menuButton.setAttribute('aria-expanded', String(open));
  });
  // Tapping a link or outside the menu closes it on small screens.
  shell.addEventListener('click', (event) => {
    if (!shell.classList.contains('nav-open')) return;
    if (event.target.closest('.side-link') || !event.target.closest('.sidebar, [data-menu]')) {
      shell.classList.remove('nav-open');
      menuButton.setAttribute('aria-expanded', 'false');
    }
  });

  root.querySelector('[data-logout]').addEventListener('click', async () => {
    await api('/api/admin/logout', { method: 'POST' });
    location.assign('/admin');
  });
  root.querySelector('[data-password]').addEventListener('click', changePassword);
  root.querySelector('[data-open-ai]')?.addEventListener('click', () => openAssistant());

  // "Install this app" while it is open in a browser that offers installing.
  const installButton = root.querySelector('[data-install-app]');
  const syncInstall = () => (installButton.hidden = installState() !== 'available');
  syncInstall();
  document.addEventListener('kbs:installable', syncInstall);
  installButton.addEventListener('click', () => install());
}

function changePassword() {
  const dialog = openModal(
    String(html`
      <h2 class="modal-title">Change your password</h2>
      <form class="modal-body" style="padding: 0" novalidate>
        <label class="field">Current password<input class="control" type="password" name="currentPassword" autocomplete="current-password" required /></label>
        <label class="field">New password (at least 8 characters)<input class="control" type="password" name="newPassword" autocomplete="new-password" minlength="8" required /></label>
        <p class="form-error" role="alert" hidden></p>
        <div class="form-actions">
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="submit" class="btn btn--primary">Save password</button>
        </div>
      </form>
    `),
    { label: 'Change password' },
  );
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    try {
      await api('/api/admin/me/password', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      dialog.close();
      toast('Password changed.');
    } catch (err) {
      const box = form.querySelector('.form-error');
      box.textContent = err.message;
      box.hidden = false;
    }
  });
}

// Highlights the menu item for the page, or for its parent (a student's profile → Manage Students).
function highlightNav(pathname) {
  const current = pathname.replace(/\/$/, '') || '/admin';
  const links = [...root.querySelectorAll('[data-nav]')];
  const exact = links.find((l) => l.dataset.nav === current);
  const parent = exact ?? links.filter((l) => l.dataset.nav !== '/admin' && current.startsWith(`${l.dataset.nav}/`)).sort((a, b) => b.dataset.nav.length - a.dataset.nav.length)[0];
  const alias = current === '/admin/collect' ? links.find((l) => l.dataset.nav === '/admin/cash') : null;
  for (const link of links) {
    if (link === (exact ?? alias ?? parent)) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function showFatal(err) {
  mount(root, html`<div class="error-state" role="alert"><h2>Could not load the fee office</h2><p class="muted">${err.message}</p></div>`);
}

async function boot() {
  try {
    await session.load();
  } catch (err) {
    if (err.status === 401) {
      loginScreen(root, boot);
      return;
    }
    showFatal(err);
    return;
  }

  const menu = MENU.map((g) => ({ ...g, items: g.items.filter((p) => session.can(p.permission)) })).filter((g) => g.items.length);
  const pages = [...menu.flatMap((g) => g.items), ...EXTRA_ROUTES.filter((p) => session.can(p.permission))];
  // More specific paths first (/admin/students/new before /admin/students/:id).
  const ordered = [pages[0], ...pages.slice(1).sort((a, b) => (a.path.includes(':') ? 1 : 0) - (b.path.includes(':') ? 1 : 0))];
  renderShell(menu);
  // Payment alerts are for staff who handle payments.
  if (session.can('payments.view')) startLiveUpdates();
  startAssistant();
  const router = createRouter({
    outlet: document.getElementById('outlet'),
    routes: ordered.map((p) => ({ path: p.path, view: p.view, title: `${p.label} · ${session.meta.appName}` })),
    onChange: highlightNav,
    onError(err, { outlet, retry }) {
      if (err.status === 401) {
        location.reload();
        return;
      }
      mount(
        outlet,
        html`
          <div class="error-state" role="alert">
            <h2>Something went wrong</h2>
            <p class="muted">${err.message}</p>
            <button type="button" class="btn btn--primary" data-retry>Try again</button>
          </div>
        `,
      );
      outlet.querySelector('[data-retry]').addEventListener('click', retry);
    },
  });
  router.start();
}

boot();
