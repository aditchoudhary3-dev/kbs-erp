import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';
import { toast } from '../../lib/toast.js';
import { classOptions, pageHead } from '../components.js';
import { session } from '../session.js';
import { formatDateTime } from '/shared/format.js';

export async function noticesView(root) {
  const meta = session.meta;
  let notices = [];

  async function load() {
    ({ notices } = await api('/api/admin/notices'));
  }

  function render() {
    mount(
      root,
      html`
        <div class="page">
          ${pageHead('Notices', 'The newest notices appear on the parent app’s home screen.')}
          <div class="grid-2">
            <form class="panel" data-new-notice novalidate>
              <div class="panel-head"><h2 class="panel-title">New notice</h2></div>
              <div class="panel-body">
                <label class="field">Headline
                  <input class="control" name="title" maxlength="100" required placeholder="e.g. Parent–teacher meeting on Saturday" />
                </label>
                <label class="field">Details (optional)
                  <textarea class="textarea" name="body" rows="4" maxlength="1000" placeholder="Time, place, anything parents should bring"></textarea>
                </label>
                <label class="field">Send to
                  <select class="control" name="classId">${classOptions(meta.classes, 'all', { all: 'All parents' })}</select>
                </label>
                <p class="form-error" role="alert" hidden></p>
                <div class="form-actions"><button type="submit" class="btn btn--primary">Post notice</button></div>
              </div>
            </form>

            <section class="panel">
              <div class="panel-head"><h2 class="panel-title">Posted</h2><span class="muted">${notices.length} notice${notices.length === 1 ? '' : 's'}</span></div>
              ${notices.length
                ? html`
                    <table class="table">
                      <tbody>
                        ${notices.map(
                          (n) => html`
                            <tr>
                              <td>
                                <span class="strong">${n.title}</span>
                                ${n.body ? html`<span class="sub">${n.body}</span>` : ''}
                                <span class="sub">${n.className ? `Class ${n.className}` : 'All parents'} · ${formatDateTime(n.createdAt)}</span>
                              </td>
                              <td class="num"><button type="button" class="link-button link-button--danger" data-delete="${n.id}">Delete</button></td>
                            </tr>
                          `,
                        )}
                      </tbody>
                    </table>
                  `
                : html`<p class="panel-empty">No notices yet.</p>`}
            </section>
          </div>
        </div>
      `,
    );
  }

  root.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formEl = event.target;
    const button = formEl.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      await api('/api/admin/notices', { method: 'POST', body: Object.fromEntries(new FormData(formEl)) });
      toast('Notice posted. Parents will see it on their home screen.');
      await load();
      render();
    } catch (err) {
      const box = formEl.querySelector('.form-error');
      box.textContent = err.message;
      box.hidden = false;
      button.disabled = false;
    }
  });

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-delete]');
    if (!button || !window.confirm('Delete this notice? Parents will no longer see it.')) return;
    try {
      await api(`/api/admin/notices/${button.dataset.delete}`, { method: 'DELETE' });
      toast('Notice deleted.');
      await load();
      render();
    } catch (err) {
      toast(err.message, { tone: 'error' });
    }
  });

  await load();
  render();
}
