import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';
import { icon } from '../../lib/icons.js';
import { toast } from '../../lib/toast.js';
import { openModal, pageHead } from '../components.js';
import { session } from '../session.js';
import { formatDate, formatDateTime, formatPhone } from '/shared/format.js';

// Parent app access. Each family is the mobile number on their children's
// records. The office gives a one-time access code (on WhatsApp or printed);
// the parent uses it once to choose a 6-digit PIN. A new code resets a
// forgotten PIN. Admins can switch a family's access off.

const TONE = { not_set_up: 'inactive', code_issued: 'pending', active: 'paid', disabled: 'failed' };

function codeModal(result) {
  const dialog = openModal(
    String(html`
      <h2 class="modal-title">Access code for +91 ${formatPhone(result.phone)}</h2>
      <p class="muted" style="margin: 0">${result.children.map((c) => `${c.name} (${c.classLabel})`).join(', ')}</p>
      <div class="access-code" aria-label="Access code">${result.code}</div>
      <p style="margin: 0; font-size: 14px">Works once, until <strong>${formatDate(result.expiresAt)}</strong>. The parent opens the app, taps <strong>First time? Use your access code</strong>, enters their number and this code, and chooses a PIN.</p>
      <div class="form-actions" style="justify-content: flex-start; flex-wrap: wrap">
        <a class="btn btn--whatsapp" href="${result.whatsappLink}" target="_blank" rel="noopener">${icon('chat', 16)} Send on WhatsApp</a>
        <button type="button" class="btn" data-copy>${icon('receipt', 16)} Copy message</button>
        <button type="button" class="btn" data-print-slip>${icon('print', 16)} Print slip</button>
        <button type="button" class="btn btn--primary" data-close>Done</button>
      </div>
      <p class="muted" style="margin: 0; font-size: 12.5px">The code is shown only now. If it is lost, give a new one.</p>
    `),
    { label: 'Access code', wide: true },
  );
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.querySelector('[data-copy]').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(result.message);
      toast('Message copied.');
    } catch {
      toast('Could not copy here. Use Send on WhatsApp or Print slip.', { tone: 'error' });
    }
  });
  dialog.querySelector('[data-print-slip]').addEventListener('click', () => {
    const slip = window.open('', '_blank', 'width=520,height=640');
    if (!slip) return;
    slip.document.write(`<!doctype html><title>App access</title><body style="font:16px system-ui;padding:24px;white-space:pre-wrap">${result.message.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</body>`);
    slip.document.close();
    slip.focus();
    slip.print();
  });
}

export async function parentsView(root) {
  const meta = session.meta;
  const canSwitch = session.can('students.edit');
  let q = '';
  let status = '';
  let timer = null;

  async function load() {
    const { families, labels } = await api(`/api/admin/parents?${new URLSearchParams({ q, status })}`);
    root.querySelector('[data-results]').innerHTML = String(html`
      <div class="result-bar"><span><strong>${families.length}</strong> ${families.length === 1 ? 'family' : 'families'}${families.length === 200 ? ' (first 200: search to narrow down)' : ''}</span></div>
      ${families.length
        ? html`
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Mobile number</th><th>Parents</th><th>Children</th><th>App</th><th>Last login</th><th></th></tr></thead>
                <tbody>
                  ${families.map(
                    (f) => html`
                      <tr>
                        <td class="nowrap strong">+91 ${formatPhone(f.phone)}</td>
                        <td>${f.parentNames}</td>
                        <td>${f.children.map((c) => html`<span class="sub" style="display: block">${c.name} · ${c.classLabel}</span>`)}</td>
                        <td><span class="pay-badge pay-badge--${TONE[f.status]}">${labels[f.status]}</span>${f.codeExpiresAt ? html`<span class="sub">until ${formatDate(f.codeExpiresAt)}</span>` : ''}</td>
                        <td class="muted nowrap">${f.lastLoginAt ? formatDateTime(f.lastLoginAt) : '—'}</td>
                        <td>
                          <span class="row-actions">
                            ${f.status === 'disabled' ? '' : html`<button type="button" class="link-button" data-code="${f.phone}">${f.status === 'active' ? 'New code (reset PIN)' : 'Give access code'}</button>`}
                            ${canSwitch
                              ? html`<button type="button" class="link-button ${f.status === 'disabled' ? '' : 'link-button--danger'}" data-switch="${f.phone}" data-on="${f.status === 'disabled' ? '1' : '0'}">${f.status === 'disabled' ? 'Switch on' : 'Switch off'}</button>`
                              : ''}
                          </span>
                        </td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            </div>
          `
        : html`<p class="panel-empty">No families match.</p>`}
    `);
  }

  mount(
    root,
    html`
      <div class="page">
        ${pageHead('Parent App Access', 'Each family logs in to the parent app with their mobile number and a PIN. Give them a one-time access code to set the PIN; give a new code if they forget it.')}
        <div class="banner banner--info">
          <span>
            <strong>How parents get the app:</strong> open ${meta.publicBaseUrl || 'the school’s app address'} in Chrome on their phone and tap <strong>Install</strong>,
            then <strong>First time? Use your access code</strong>.${meta.parentLogin?.otp ? ' Parents can also log in with a code by SMS.' : ''}
          </span>
        </div>
        <section class="panel">
          <form class="filters" data-filters>
            <label class="field field--wide">Search<input class="control" type="search" name="q" placeholder="Mobile number, parent or child’s name" /></label>
            <label class="field">App<select class="control" name="status">
              <option value="">All families</option><option value="not_set_up">Not set up</option><option value="code_issued">Code given, not used yet</option>
              <option value="active">Using the app</option><option value="disabled">Switched off</option>
            </select></label>
          </form>
          <div data-results></div>
        </section>
      </div>
    `,
  );

  const form = root.querySelector('[data-filters]');
  form.addEventListener('input', (event) => {
    if (event.target.name !== 'q') return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      q = form.q.value;
      load().catch((err) => toast(err.message, { tone: 'error' }));
    }, 250);
  });
  form.addEventListener('change', () => {
    status = form.status.value;
    load().catch((err) => toast(err.message, { tone: 'error' }));
  });
  form.addEventListener('submit', (event) => event.preventDefault());

  root.addEventListener('click', async (event) => {
    const code = event.target.closest('[data-code]');
    if (code) {
      if (code.textContent.startsWith('New') && !window.confirm('Give a new access code? The parent will choose a new PIN with it.')) return;
      code.disabled = true;
      try {
        codeModal(await api(`/api/admin/parents/${code.dataset.code}/code`, { method: 'POST' }));
        await load();
      } catch (err) {
        toast(err.message, { tone: 'error' });
        code.disabled = false;
      }
      return;
    }
    const sw = event.target.closest('[data-switch]');
    if (sw) {
      const on = sw.dataset.on === '1';
      if (!on && !window.confirm('Switch off app access for this family? They are logged out at once.')) return;
      try {
        await api(`/api/admin/parents/${sw.dataset.switch}/status`, { method: 'POST', body: { active: on } });
        toast(on ? 'App access switched on.' : 'App access switched off.');
        await load();
      } catch (err) {
        toast(err.message, { tone: 'error' });
      }
    }
  });

  await load();
}
