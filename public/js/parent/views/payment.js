import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';
import { icon } from '../../lib/icons.js';
import { formatDateTime, rupees } from '/shared/format.js';

export async function paymentView(root, { params }) {
  const payment = await api(`/api/payments/${encodeURIComponent(params.id)}`);
  const { student } = payment;

  mount(
    root,
    html`
      <main class="done">
        <div class="done-mark">${icon('check', 44, 2.5)}</div>
        <h1 class="done-title">Payment successful</h1>
        <div class="done-amount">${rupees(payment.amount)}</div>
        <span class="status-badge">${icon('check', 14, 3)} ${payment.statusLabel}</span>
        <p class="subtitle" style="text-align: center">Confirmed with the bank. Keep this receipt for your records.</p>

        <section class="card details" aria-label="Payment details">
          <div class="detail"><span>Student</span><span>${student.name}, ${student.className}</span></div>
          <div class="detail">
            <span>For</span>
            <span>${payment.items.map((item, i) => html`${i ? html`<br />` : ''}${item.title}`)}</span>
          </div>
          <div class="detail"><span>Paid on</span><span>${formatDateTime(payment.paidAt)}</span></div>
          <div class="detail"><span>Method</span><span>${payment.method}</span></div>
          <div class="detail"><span>Receipt no.</span><span>${payment.receiptNo}</span></div>
          ${payment.txnId ? html`<div class="detail"><span>Transaction ID</span><span>${payment.txnId}</span></div>` : ''}
        </section>

        <div class="spacer"></div>
        <a class="button button--outline" href="${payment.urls.pdf}" download>
          ${icon('download', 18)} Download receipt (PDF)
        </a>
        <a class="button button--medium" href="/">Back to home</a>
      </main>
    `,
  );
}
