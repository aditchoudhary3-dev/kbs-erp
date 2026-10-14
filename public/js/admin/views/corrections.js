import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';
import { toast } from '../../lib/toast.js';
import { openModal, pageHead } from '../components.js';
import { receiptUrl } from '../receipt-actions.js';
import { session } from '../session.js';
import { formatDateTime, rupees } from '/shared/format.js';

// Correction requests for completed payments. Clerks request; admins decide.
// Approving never deletes anything: the original payment is cancelled and kept,
// and for a change of mode/reference a corrected receipt is issued.

const STATUS_BADGE = { pending: 'pending', approved: 'paid', rejected: 'failed' };

export async function correctionsView(root) {
  const approver = session.can('corrections.approve');
  let status = approver ? 'pending' : '';

  async function render() {
    const { corrections } = await api(`/api/admin/corrections?${new URLSearchParams(status ? { status } : {})}`);
    mount(
      root,
      html`
        <div class="page">
          ${pageHead(
            'Payment Corrections',
            approver
              ? 'Requests to correct completed payments. Approving cancels the original (kept on record) and, for a change of mode or reference, issues a corrected receipt.'
              : 'Your correction requests and what the admin decided.',
          )}
          <div class="tabs" role="tablist" aria-label="Status">
            ${[['pending', 'Waiting'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['', 'All']].map(
              ([value, label]) => html`<button type="button" class="tab" role="tab" data-status="${value}" aria-selected="${value === status}">${label}</button>`,
            )}
          </div>
          <section class="panel">
            ${corrections.length
              ? html`
                  <div class="table-wrap">
                    <table class="table">
                      <thead><tr><th>Requested</th><th>Receipt</th><th>Request</th><th>Status</th><th>Decision</th><th></th></tr></thead>
                      <tbody>
                        ${corrections.map(
                          (c) => html`
                            <tr>
                              <td class="nowrap">${formatDateTime(c.requestedAt)}<span class="sub">by ${c.requestedBy}</span></td>
                              <td>
                                <a class="link-button mono" href="${receiptUrl(c.paymentId)}" target="_blank" rel="noopener">${c.receiptNo}</a>
                                <span class="sub">${c.studentName} · ${rupees(c.amount)} · ${c.method}</span>
                              </td>
                              <td style="max-width: 360px">
                                <span class="strong">${c.kindLabel}</span>
                                <span class="sub">“${c.reason}”</span>
                                ${c.requestedChanges ? html`<span class="sub">New: ${[c.requestedChanges.method, c.requestedChanges.reference].filter(Boolean).join(' · ')}</span>` : ''}
                              </td>
                              <td><span class="pay-badge pay-badge--${STATUS_BADGE[c.status]}">${c.status.toUpperCase()}</span></td>
                              <td>
                                ${c.decidedBy ? html`${c.decidedBy}<span class="sub">${formatDateTime(c.decidedAt)}</span>` : html`<span class="muted">—</span>`}
                                ${c.decisionNote ? html`<span class="sub">“${c.decisionNote}”</span>` : ''}
                                ${c.replacementPaymentId ? html`<a class="link-button" href="${receiptUrl(c.replacementPaymentId)}" target="_blank" rel="noopener">New receipt</a>` : ''}
                              </td>
                              <td>
                                ${approver && c.status === 'pending'
                                  ? html`<span class="row-actions">
                                      <button type="button" class="btn btn--small btn--primary" data-decide="${c.id}" data-approve="true">Approve</button>
                                      <button type="button" class="btn btn--small" data-decide="${c.id}" data-approve="false">Reject</button>
                                    </span>`
                                  : ''}
                              </td>
                            </tr>
                          `,
                        )}
                      </tbody>
                    </table>
                  </div>
                `
              : html`<p class="panel-empty">${status === 'pending' ? 'Nothing is waiting for approval.' : 'No requests here.'}</p>`}
          </section>
        </div>
      `,
    );
  }

  function decide(id, approve) {
    const dialog = openModal(
      String(html`
        <h2 class="modal-title">${approve ? 'Approve this correction?' : 'Reject this correction?'}</h2>
        <p class="muted" style="margin: 0">${approve
          ? 'The original payment will be marked CANCELLED (it stays on record and in the audit log). For a change of mode or reference, a corrected receipt is issued; for a cancellation, the fees become due again.'
          : 'The payment stays exactly as it is.'}</p>
        <form class="modal-body" style="padding: 0">
          <label class="field">Note (optional)<input class="control" name="note" maxlength="300" placeholder="${approve ? 'e.g. Checked against the bank statement' : 'Why is it rejected?'}" /></label>
          <div class="form-actions">
            <button type="button" class="btn" data-close>Back</button>
            <button type="submit" class="btn ${approve ? 'btn--primary' : ''}">${approve ? 'Approve' : 'Reject'}</button>
          </div>
        </form>
      `),
      { label: 'Decide correction' },
    );
    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    dialog.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await api(`/api/admin/corrections/${id}/decision`, { method: 'POST', body: { approve, note: event.target.note.value } });
        dialog.close();
        toast(approve ? 'Approved. The original payment is cancelled and kept on record.' : 'Rejected. The payment is unchanged.');
        const badge = document.querySelector('[data-count="pendingCorrections"]');
        if (badge) {
          const left = Math.max(0, Number(badge.textContent) - 1);
          session.meta.pendingCorrections = left;
          if (left) badge.textContent = left;
          else badge.remove();
        }
        await render();
      } catch (err) {
        toast(err.message, { tone: 'error' });
      }
    });
  }

  root.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-status]');
    if (tab) {
      status = tab.dataset.status;
      render().catch((err) => toast(err.message, { tone: 'error' }));
      return;
    }
    const button = event.target.closest('[data-decide]');
    if (button) decide(Number(button.dataset.decide), button.dataset.approve === 'true');
  });

  await render();
}
