import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';
import { icon } from '../../lib/icons.js';
import { bottomNav, pageHead, studentLine } from '../components.js';
import { payDues } from '../checkout.js';
import { loadFamily } from '../store.js';
import { formatDate, rupees } from '/shared/format.js';

function dueCard(due, gatewayLabel) {
  if (!due.items.length) {
    return html`
      <section class="card card--ok">
        <div class="ok-row">
          <div class="ok-mark">${icon('check', 22, 2.5)}</div>
          <div class="grow">
            <div class="card-title">Nothing due right now</div>
            <div class="meta">We’ll let you know when the next fees are added.</div>
          </div>
        </div>
      </section>
    `;
  }
  return html`
    <section class="card" aria-label="Due now">
      <div class="card-head">
        <h2 class="card-title">${due.overdue ? 'Overdue' : 'Due now'}</h2>
        <div class="pill ${due.overdue ? 'pill--danger' : 'pill--warn'}">
          ${due.overdue ? 'Was due' : 'Due'} ${formatDate(due.dueDate)}
        </div>
      </div>
      <div class="lines">
        ${due.items.map((item) => html`<div class="line"><span>${item.title}</span><span>${rupees(item.amount)}</span></div>`)}
        <div class="rule"></div>
        <div class="line line--total"><span>Total</span><span>${rupees(due.total)}</span></div>
      </div>
      <p class="form-error" data-pay-error role="alert" hidden></p>
      <button type="button" class="button" data-pay>Pay ${rupees(due.total)}</button>
      <div class="secure-note">${icon('lock', 14)}<span>UPI, cards, net banking · ${gatewayLabel}</span></div>
    </section>
  `;
}

function historyList(payments) {
  if (!payments.length) return html`<div class="empty">No payments yet.</div>`;
  return payments.map(
    (p) => html`
      <div class="row">
        <div class="grow">
          <div class="row-title">${p.description}</div>
          <div class="row-sub">Paid ${formatDate(p.paidAt)} · ${p.method}</div>
        </div>
        <div class="row-end">
          <div class="row-amount">${rupees(p.amount)}</div>
          <a class="receipt-link" href="/api/payments/${p.id}/receipt.pdf" download>Receipt</a>
        </div>
      </div>
    `,
  );
}

export async function feesView(root, { navigate }) {
  const { child } = await loadFamily();
  const data = await api(`/api/students/${child.id}/fees`);

  mount(
    root,
    html`
      <main class="screen">
        ${pageHead('Fees', studentLine(data.student))} ${dueCard(data.due, data.gateway.name === 'razorpay' ? 'Secured by Razorpay' : 'Test gateway, no money is charged')}
        <h2 class="section-title">Payment history</h2>
        <section class="card card--flush">${historyList(data.payments)}</section>
      </main>
      ${bottomNav('fees')}
    `,
  );

  const payButton = root.querySelector('[data-pay]');
  const errorBox = root.querySelector('[data-pay-error]');
  payButton?.addEventListener('click', async () => {
    payButton.disabled = true;
    errorBox.hidden = true;
    try {
      const paymentId = await payDues({ student: data.student, due: data.due });
      if (paymentId) navigate(`/payments/${paymentId}`);
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    } finally {
      payButton.disabled = false;
    }
  });
}
