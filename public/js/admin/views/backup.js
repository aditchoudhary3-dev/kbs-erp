import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';
import { icon } from '../../lib/icons.js';
import { toast } from '../../lib/toast.js';
import { pageHead } from '../components.js';
import { formatDateTime } from '/shared/format.js';

// System Backup: complete copies of the database, made while the app runs.

const size = (bytes) => (bytes > 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`);

export async function backupView(root) {
  async function render() {
    const { backups } = await api('/api/admin/system/backups');
    mount(
      root,
      html`
        <div class="page">
          ${pageHead(
            'System Backup',
            'A backup is a complete copy of all students, fees, payments, receipts and settings.',
            html`<button type="button" class="btn btn--primary" data-backup>${icon('database', 18)} Back up now</button>`,
          )}
          <div class="grid-2">
            <div class="tile">
              <span class="tile-label">Automatic backups</span>
              <span style="font-size: 14px; line-height: 1.5">A backup is made every day while the app is running. The last 14 daily backups are kept; backups you make yourself are never removed.</span>
            </div>
            <div class="tile">
              <span class="tile-label">Keep a copy off this computer</span>
              <span style="font-size: 14px; line-height: 1.5">Download a backup at least once a week to a pen drive or Google Drive. To restore one: stop the app, put the file in place of <strong>data/schoolconnect.db</strong>, start the app.</span>
            </div>
          </div>
          <section class="panel">
            <div class="panel-head"><h2 class="panel-title">Backups</h2><span class="muted">${backups.length} kept</span></div>
            ${backups.length
              ? html`
                  <table class="table">
                    <thead><tr><th>Made</th><th>File</th><th>Type</th><th class="num">Size</th><th></th></tr></thead>
                    <tbody>
                      ${backups.map(
                        (b) => html`
                          <tr>
                            <td class="nowrap">${formatDateTime(b.createdAt)}</td>
                            <td class="mono">${b.name}</td>
                            <td>${b.automatic ? 'Automatic' : 'Manual'}</td>
                            <td class="num">${size(b.size)}</td>
                            <td class="num"><a class="link-button" href="/api/admin/system/backups/${encodeURIComponent(b.name)}" download>Download</a></td>
                          </tr>
                        `,
                      )}
                    </tbody>
                  </table>
                `
              : html`<p class="panel-empty">No backups yet.</p>`}
          </section>
        </div>
      `,
    );
  }

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-backup]');
    if (!button) return;
    button.disabled = true;
    try {
      const { backup } = await api('/api/admin/system/backups', { method: 'POST' });
      toast(`Backup made: ${backup.name} (${size(backup.size)}).`);
      await render();
    } catch (err) {
      toast(err.message, { tone: 'error' });
      button.disabled = false;
    }
  });

  await render();
}
