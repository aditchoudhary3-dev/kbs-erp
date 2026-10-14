import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';
import { toast } from '../../lib/toast.js';
import { exportButtons, openModal, pageHead } from '../components.js';
import { session } from '../session.js';
import { formatDate, formatDateTime, formatPhone } from '/shared/format.js';

// Staff records: everyone who works at the school. Admins, clerks and
// teachers log in to this app; other staff (drivers, attendants…) are
// records only. Admins add people, change roles, switch accounts off and on,
// and set new passwords. Every change is in the Audit Logs.

const ROLE_HELP = {
  admin: 'Everything: students, fees, payments, attendance, timetable, reports, staff, settings and the audit log.',
  clerk: 'Fee counter: collect fees, payments and receipts, WhatsApp, reports and exports, attendance (view), parent app codes. Cannot change fees, student records or staff.',
  teacher: 'Only their own classes: mark attendance, enter monthly progress, see students (no fees) and the timetable.',
  staff: 'A staff record (driver, attendant, peon…). No app login.',
};

const LOGIN = new Set(['admin', 'clerk', 'teacher']);

function personForm(user, roles) {
  const role = user?.role ?? 'teacher';
  return html`
    <div class="form-grid">
      <label class="field">Name<input class="control" name="name" value="${user?.name ?? ''}" maxlength="60" required /></label>
      <label class="field">Role
        <select class="control" name="role">${Object.entries(roles).map(([value, label]) => html`<option value="${value}" ${value === role ? 'selected' : ''}>${label}</option>`)}</select>
      </label>
      <label class="field">Designation<input class="control" name="designation" value="${user?.designation ?? ''}" placeholder="e.g. TGT Maths, Accountant, Driver" maxlength="60" /></label>
      <label class="field">Mobile number<input class="control" name="phone" type="tel" inputmode="numeric" value="${user?.phone ? formatPhone(user.phone) : ''}" /></label>
      <label class="field">Joining date<input class="control" name="joinedOn" type="date" value="${user?.joinedOn ?? ''}" /></label>
      <label class="field" data-login>Email (used to log in)<input class="control" name="email" type="email" value="${user?.email ?? ''}" /></label>
      ${user ? '' : html`<label class="field" data-login>First password (at least 8 characters)<input class="control" name="password" type="text" minlength="8" autocomplete="new-password" /></label>`}
    </div>
    <p class="muted" data-role-help style="margin: 0; font-size: 13px">${ROLE_HELP[role]}</p>
  `;
}

export async function usersView(root) {
  const me = session.meta.staff;
  let filter = '';

  async function render() {
    const { users, roles } = await api('/api/admin/users');
    const shown = users.filter((u) => !filter || u.role === filter);
    const count = (role) => users.filter((u) => u.role === role && u.active).length;
    mount(
      root,
      html`
        <div class="page">
          ${pageHead(
            'Staff Records',
            'Everyone at school. Admins, clerks and teachers log in to this app; other staff are records only.',
            html`${exportButtons('/api/admin/export/staff')}<button type="button" class="btn btn--primary" data-add>Add staff member</button>`,
          )}

          <div class="tiles">
            ${['admin', 'clerk', 'teacher', 'staff'].map(
              (role) => html`
                <button type="button" class="tile tile--button ${filter === role ? 'tile--accent' : ''}" data-filter="${role}" aria-pressed="${filter === role}">
                  <span class="tile-label">${roles[role]}</span>
                  <span class="tile-value">${count(role)}</span>
                  <span class="tile-sub">${ROLE_HELP[role]}</span>
                </button>
              `,
            )}
          </div>

          <section class="panel">
            <div class="panel-head">
              <h2 class="panel-title">${filter ? roles[filter] : 'All staff'} <span class="muted">(${shown.length})</span></h2>
              ${filter ? html`<button type="button" class="link-button" data-filter="">Show everyone</button>` : ''}
            </div>
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Name</th><th>Role</th><th>Mobile</th><th>App login</th><th>Last login</th><th></th></tr></thead>
                <tbody>
                  ${shown.map(
                    (u) => html`
                      <tr>
                        <td>
                          <span class="strong">${u.name}${u.id === me.id ? html` <span class="muted">(you)</span>` : ''}</span>
                          <span class="sub">${u.designation || ''}${u.joinedOn ? `${u.designation ? ' · ' : ''}joined ${formatDate(u.joinedOn)}` : ''}</span>
                          ${u.classes.length ? html`<span class="sub">Classes: ${u.classes.map((c) => `${c.label}${c.classTeacher ? ' ★' : ''}`).join(', ')}</span>` : ''}
                        </td>
                        <td>${u.roleLabel}</td>
                        <td class="nowrap">${u.phone ? formatPhone(u.phone) : '—'}</td>
                        <td>
                          ${!u.active
                            ? html`<span class="pay-badge pay-badge--failed">Switched off</span>`
                            : u.canLogin
                              ? html`<span class="pay-badge pay-badge--paid">Active</span><span class="sub">${u.email}</span>`
                              : html`<span class="pay-badge pay-badge--inactive">No login</span>`}
                        </td>
                        <td class="muted nowrap">${u.lastLoginAt ? formatDateTime(u.lastLoginAt) : LOGIN.has(u.role) ? 'Never' : '—'}</td>
                        <td>
                          <span class="row-actions">
                            <button type="button" class="link-button" data-edit="${u.id}">Edit</button>
                            ${LOGIN.has(u.role) ? html`<button type="button" class="link-button" data-reset="${u.id}" data-name="${u.name}">Set new password</button>` : ''}
                            ${u.id === me.id
                              ? ''
                              : html`<button type="button" class="link-button ${u.active ? 'link-button--danger' : ''}" data-active="${u.id}" data-value="${u.active ? '0' : '1'}">${u.active ? 'Switch off' : 'Switch on'}</button>`}
                          </span>
                        </td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <p class="muted" style="margin: 0">Teachers’ classes are set on <a href="/admin/academics">Subjects &amp; Teachers</a> and the <a href="/admin/timetable">Timetable</a>. Every change is recorded in <a href="/admin/audit">Audit Logs</a>.</p>
        </div>
      `,
    );
    root.dataset.roles = JSON.stringify(roles);
  }

  async function update(id, changes, message) {
    try {
      await api(`/api/admin/users/${id}`, { method: 'PUT', body: changes });
      toast(message);
    } catch (err) {
      toast(err.message, { tone: 'error' });
    }
    await render();
  }

  function openPerson(user) {
    const roles = JSON.parse(root.dataset.roles);
    const dialog = openModal(
      String(html`
        <h2 class="modal-title">${user ? `Edit ${user.name}` : 'Add a staff member'}</h2>
        <form class="modal-body" style="padding: 0" novalidate>
          ${personForm(user, roles)}
          <p class="form-error" role="alert" hidden></p>
          <div class="form-actions">
            <button type="button" class="btn" data-close>Cancel</button>
            <button type="submit" class="btn btn--primary">${user ? 'Save changes' : 'Add staff member'}</button>
          </div>
        </form>
      `),
      { label: user ? `Edit ${user.name}` : 'Add a staff member', wide: true },
    );
    const form = dialog.querySelector('form');
    const syncRole = () => {
      const login = LOGIN.has(form.role.value);
      form.querySelectorAll('[data-login]').forEach((el) => (el.hidden = !login));
      form.querySelector('[data-role-help]').textContent = ROLE_HELP[form.role.value];
    };
    syncRole();
    form.role.addEventListener('change', syncRole);
    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const body = Object.fromEntries(new FormData(form));
      if (!LOGIN.has(body.role)) {
        delete body.password;
        if (!user) delete body.email;
      }
      try {
        if (user) {
          if (LOGIN.has(body.role) && !user.canLogin) {
            const password = window.prompt(`${body.name} needs a password to log in (at least 8 characters):`);
            if (!password) return;
            body.password = password;
          }
          await api(`/api/admin/users/${user.id}`, { method: 'PUT', body });
          toast('Saved.');
        } else {
          const { user: added } = await api('/api/admin/users', { method: 'POST', body });
          toast(added.canLogin ? `${added.name} can now log in as ${added.roleLabel}. Share the password in person.` : `${added.name} added.`);
        }
        dialog.close();
        await render();
      } catch (err) {
        const box = form.querySelector('.form-error');
        box.textContent = err.message;
        box.hidden = false;
      }
    });
  }

  root.addEventListener('click', async (event) => {
    if (event.target.closest('[data-add]')) return openPerson(null);
    const filterButton = event.target.closest('[data-filter]');
    if (filterButton) {
      filter = filter === filterButton.dataset.filter ? '' : filterButton.dataset.filter;
      return render();
    }
    const edit = event.target.closest('[data-edit]');
    if (edit) {
      const { users } = await api('/api/admin/users');
      return openPerson(users.find((u) => u.id === Number(edit.dataset.edit)));
    }
    const reset = event.target.closest('[data-reset]');
    if (reset) {
      const password = window.prompt(`New password for ${reset.dataset.name} (at least 8 characters):`);
      if (password) update(reset.dataset.reset, { password }, 'Password changed. They have been signed out everywhere.');
      return undefined;
    }
    const active = event.target.closest('[data-active]');
    if (active) {
      const on = active.dataset.value === '1';
      if (!on && !window.confirm('Switch off this person? If they log in to the app, they are signed out immediately.')) return undefined;
      update(active.dataset.active, { active: on }, on ? 'Switched on.' : 'Switched off.');
    }
    return undefined;
  });

  await render();
}
