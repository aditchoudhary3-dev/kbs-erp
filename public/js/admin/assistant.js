import { api } from '../lib/api.js';
import { html, raw } from '../lib/html.js';
import { icon } from '../lib/icons.js';
import { session } from './session.js';
import { payBadge, whatsappStatus } from './components.js';
import { bindReceiptActions, copyButtons } from './receipt-actions.js';
import { confirmationCard, markShown } from './live.js';
import { formatDate, rupees } from '/shared/format.js';

// KBS AI Assistant: a chat panel on every staff page. Answers come from the
// server's allow-listed tools (with the user's own permissions). Anything
// that changes records is shown as a proposal with CONFIRM and CANCEL, and
// only runs when the user presses Confirm.

const STORE_KEY = 'kbs-assistant';
const state = { open: false, busy: false, messages: [], followUp: null };
let panel = null;
let launcher = null;

function save() {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify({ messages: state.messages.slice(-30), followUp: state.followUp }));
  } catch {
    // Storage can be unavailable (private windows); the chat still works.
  }
}

function restore() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? 'null');
    if (saved?.messages) {
      state.messages = saved.messages;
      state.followUp = saved.followUp ?? null;
    }
  } catch {
    state.messages = [];
  }
}

// ---- Text and cards -------------------------------------------------------------------------

const escapeText = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Plain text with **bold** and line breaks (everything else is escaped).
const richText = (text) => raw(escapeText(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>'));

function cell(value, type) {
  if (value === null || value === undefined || value === '') return '';
  if (type === 'money') return rupees(value);
  if (type === 'number') return Number(value).toLocaleString('en-IN');
  if (type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value);
  if (type === 'status' || ['PAID', 'PENDING', 'FAILED', 'CANCELLED', 'OVERDUE'].includes(value)) return payBadge(String(value));
  return String(value);
}

const runButton = (label, tool, args, { primary = false, say = label } = {}) =>
  html`<button type="button" class="btn btn--small ${primary ? 'btn--primary' : ''}" data-ai-run="${tool}" data-ai-args="${JSON.stringify(args)}" data-ai-say="${say}">${label}</button>`;

function tableCard(c) {
  const numeric = (col) => col.type === 'money' || col.type === 'number';
  const actions = c.rowAction === 'receipt' || c.rowAction === 'student';
  const totals = c.totals && c.columns.some((col) => c.totals[col.key] !== undefined) ? c.totals : null;
  return html`
    <section class="ai-card">
      <header class="ai-card-head">
        <div><strong>${c.title}</strong>${c.subtitle ? html`<span class="muted">${c.subtitle}</span>` : ''}</div>
        <span class="ai-card-tools">
          ${c.export ? html`<a class="btn btn--small btn--primary" href="${c.export.href}" download>${icon('download', 14)} ${c.export.label.toUpperCase()}</a>` : ''}
          ${c.link ? html`<a class="btn btn--small" href="${c.link.href}">${c.link.label}</a>` : ''}
        </span>
      </header>
      ${c.note ? html`<p class="ai-note">${c.note}</p>` : ''}
      ${c.rows.length
        ? html`
            <div class="ai-table-wrap">
              <table class="ai-table">
                <thead><tr>${c.columns.map((col) => html`<th class="${numeric(col) ? 'num' : ''}">${col.header}</th>`)}${actions ? html`<th></th>` : ''}</tr></thead>
                <tbody>
                  ${c.rows.map(
                    (row) => html`
                      <tr>
                        ${c.columns.map((col) => html`<td class="${numeric(col) ? 'num' : ''}">${cell(row[col.key], col.type)}</td>`)}
                        ${c.rowAction === 'receipt'
                          ? html`<td>${row.paymentId ? html`<button type="button" class="link-button" data-receipt="${row.paymentId}">Receipt</button>` : ''}</td>`
                          : c.rowAction === 'student'
                            ? html`<td class="nowrap">
                                <button type="button" class="link-button" data-ai-run="student_fees" data-ai-args="${JSON.stringify({ studentId: row.id })}" data-ai-say="Fees for ${row.name}">Fees</button>
                                ${session.can('payments.collect') ? html` · <a class="link-button" href="/admin/cash?student=${row.id}">Collect</a>` : ''}
                              </td>`
                            : ''}
                      </tr>
                    `,
                  )}
                </tbody>
                ${totals ? html`<tfoot><tr>${c.columns.map((col) => html`<td class="${numeric(col) ? 'num' : ''}">${cell(totals[col.key], col.type === 'status' ? '' : col.type)}</td>`)}${actions ? html`<td></td>` : ''}</tr></tfoot>` : ''}
              </table>
            </div>
          `
        : html`<p class="ai-note">Nothing to show.</p>`}
      ${c.more ? html`<p class="ai-more">+ ${c.more} more ${c.export ? '— use Export Excel for the full list' : ''}</p>` : ''}
    </section>
  `;
}

function studentsCard(c) {
  return html`
    <section class="ai-card">
      <header class="ai-card-head"><div><strong>${c.title}</strong></div></header>
      <ul class="ai-students">
        ${c.students.map(
          (s) => html`
            <li>
              <div class="ai-student">
                <strong>${s.name}</strong>
                <span>Admission No. ${s.admissionNo} · ${s.classLabel}</span>
                <span>Parent: ${s.parentName}</span>
              </div>
              <div class="ai-student-actions">
                ${c.then
                  ? runButton('Select', c.then.tool, { ...c.then.args, studentId: s.id }, { primary: true, say: `${s.name} (${s.classLabel})` })
                  : html`
                      ${session.can('payments.view') ? runButton('Fees', 'student_fees', { studentId: s.id }, { say: `Fees for ${s.name}` }) : ''}
                      ${session.can('payments.view') ? runButton('History', 'student_payments', { studentId: s.id }, { say: `Payment history of ${s.name}` }) : ''}
                    `}
              </div>
            </li>
          `,
        )}
      </ul>
    </section>
  `;
}

function studentFeesCard(c) {
  const s = c.student;
  return html`
    <section class="ai-card">
      <header class="ai-card-head">
        <div><strong>${s.name}</strong><span class="muted">${s.classLabel} · ${s.admissionNo} · Parent: ${s.parentName}</span></div>
      </header>
      <div class="ai-stats ai-stats--three">
        <div class="ai-stat ${c.due.total ? 'ai-stat--warn' : 'ai-stat--ok'}"><span>Pending now</span><strong>${rupees(c.due.total)}</strong></div>
        <div class="ai-stat ${c.due.overdue ? 'ai-stat--danger' : ''}"><span>Overdue</span><strong>${rupees(c.due.overdue)}</strong></div>
        <div class="ai-stat"><span>Paid this session</span><strong>${rupees(c.paidThisSession)}</strong></div>
      </div>
      ${c.due.items.length
        ? html`<ul class="ai-dues">${c.due.items.map((i) => html`<li><span>${i.title}<span class="muted"> · due ${formatDate(i.dueDate)}${i.overdue ? ' · overdue' : ''}</span></span><strong>${rupees(i.amount)}</strong></li>`)}</ul>`
        : ''}
      ${c.upcoming.count ? html`<p class="ai-note">Upcoming: ${c.upcoming.count} instalment${c.upcoming.count === 1 ? '' : 's'}, ${rupees(c.upcoming.total)}</p>` : ''}
      <div class="ai-card-actions">
        ${c.canCollect && c.active && (c.due.total || c.upcoming.count) ? html`<a class="btn btn--small btn--primary" href="/admin/cash?student=${s.id}">${icon('rupee', 14)} Collect at counter</a>` : ''}
        ${runButton('Payment history', 'student_payments', { studentId: s.id }, { say: `Payment history of ${s.name}` })}
        ${c.lastPayment ? html`<button type="button" class="btn btn--small" data-receipt="${c.lastPayment.paymentId}">Last receipt ${c.lastPayment.receiptNo}</button>` : ''}
      </div>
    </section>
  `;
}

function statsCard(c) {
  return html`
    <section class="ai-card">
      <header class="ai-card-head"><div><strong>${c.title}</strong></div></header>
      <div class="ai-stats">
        ${c.items.map(
          (item) => html`<div class="ai-stat ${item.strong ? 'ai-stat--strong' : ''}"><span>${item.label}</span><strong>${cell(item.value, item.format)}</strong>${item.sub ? html`<em>${item.sub}</em>` : ''}</div>`,
        )}
      </div>
    </section>
  `;
}

function confirmCard(c) {
  const pending = c.status === 'pending';
  return html`
    <section class="ai-card ai-confirm ai-confirm--${c.status}" data-action-card="${c.actionId}">
      <header class="ai-card-head">
        <div><strong>${c.title}</strong></div>
        ${pending ? html`<span class="ai-chip ai-chip--warn">Needs your confirmation</span>` : html`<span class="ai-chip">${c.statusText}</span>`}
      </header>
      <dl class="ai-lines">${c.lines.map(([label, value]) => html`<dt>${label}</dt><dd>${value}</dd>`)}</dl>
      ${c.items ? html`<ul class="ai-dues">${c.items.map(([label, amount]) => html`<li><span>${label}</span><strong>${rupees(amount)}</strong></li>`)}</ul>` : ''}
      ${c.note ? html`<p class="ai-note">${c.note}</p>` : ''}
      ${c.error && c.status === 'failed' ? html`<p class="form-error">${c.error}</p>` : ''}
      ${pending
        ? html`
            <div class="ai-card-actions">
              <button type="button" class="btn btn--primary" data-ai-confirm="${c.actionId}">${icon('check', 16, 2.5)} ${c.confirmLabel.toUpperCase()}</button>
              <button type="button" class="btn" data-ai-cancel="${c.actionId}">CANCEL</button>
            </div>
          `
        : ''}
    </section>
  `;
}

function receiptCard(c) {
  const p = c.payment;
  return html`
    <section class="ai-card" data-payment="${p.paymentId}">
      <header class="ai-card-head">
        <div><strong>Receipt ${p.receiptNo}</strong><span class="muted">${p.student.name} · ${p.student.classLabel}</span></div>
        ${payBadge(p.status)}
      </header>
      <dl class="ai-lines">
        <dt>Amount</dt><dd>${rupees(p.amount)}</dd>
        <dt>Payment Mode</dt><dd>${p.method}${p.channel === 'online' ? ' (online)' : ''}</dd>
        <dt>Transaction ID</dt><dd>${p.txnId ?? '—'}</dd>
        <dt>Date</dt><dd>${formatDate(p.paidAt)}</dd>
        <dt>Collected By</dt><dd>${p.collectedBy}</dd>
        ${p.status === 'PAID' ? html`<dt>WhatsApp Status</dt><dd data-wa-status data-wa-plain>${whatsappStatus(p.whatsapp, { label: false })}</dd>` : ''}
      </dl>
      ${copyButtons(p, { compact: true })}
      <p class="confirm-foot"><button type="button" class="link-button" data-receipt="${p.paymentId}">Receipt copies and history</button></p>
    </section>
  `;
}

export function insightsBody(s) {
  const tile = (label, value, { tone = '', format = 'money' } = {}) =>
    html`<div class="ai-stat ${tone ? `ai-stat--${tone}` : ''}"><span>${label}</span><strong>${cell(value, format)}</strong></div>`;
  return html`
    <p class="ai-headline">${s.headline}</p>
    <div class="ai-stats ai-stats--insights">
      ${tile('Today’s Collection', s.collection.amount, { tone: 'strong' })}
      ${tile('Cash', s.collection.cash)}
      ${tile('Online', s.collection.online)}
      ${tile('Payments', s.collection.count, { format: 'number' })}
      ${tile('Failed Payments', s.failedPayments, { format: 'number', tone: s.failedPayments ? 'danger' : '' })}
      ${tile('Pending fee accounts', s.pendingAccounts.students, { format: 'number', tone: s.pendingAccounts.students ? 'warn' : '' })}
      ${tile('WhatsApp receipts pending', s.whatsapp.pending, { format: 'number', tone: s.whatsapp.pending ? 'warn' : '' })}
      ${tile(session.can('corrections.approve') ? 'Corrections to approve' : 'My correction requests', s.corrections, { format: 'number', tone: s.corrections ? 'warn' : '' })}
    </div>
    <div class="ai-issues">
      <strong>Recent issues</strong>
      ${s.issues.length
        ? html`<ul>${s.issues.map((i) => html`<li class="ai-issue ai-issue--${i.tone}"><span>${i.text}</span><a class="link-button" href="${i.href}">View</a></li>`)}</ul>`
        : html`<p class="muted" style="margin: 4px 0 0">Nothing needs attention.</p>`}
    </div>
  `;
}

function cardHtml(c) {
  switch (c.type) {
    case 'table':
      return tableCard(c);
    case 'students':
      return studentsCard(c);
    case 'student-fees':
      return studentFeesCard(c);
    case 'stats':
      return statsCard(c);
    case 'confirm':
      return confirmCard(c);
    case 'receipt':
      return receiptCard(c);
    case 'payment':
      return html`<div class="ai-payment">${confirmationCard(c.payment, { dismissible: false })}</div>`;
    case 'insights':
      return html`<section class="ai-card"><header class="ai-card-head"><div><strong>KBS AI Daily Summary</strong><span class="muted">${formatDate(c.summary.date)}</span></div></header>${insightsBody(c.summary)}</section>`;
    case 'link':
      return html`<div class="ai-card-actions"><a class="btn btn--small" href="${c.href}">${c.label}</a></div>`;
    default:
      return '';
  }
}

// ---- The panel ----------------------------------------------------------------------------------

function messageHtml(m, index) {
  if (m.role === 'user') return html`<div class="ai-msg ai-msg--user"><div class="ai-bubble">${m.text}</div></div>`;
  return html`
    <div class="ai-msg ai-msg--assistant" data-index="${index}">
      <span class="ai-avatar" aria-hidden="true">${icon('sparkle', 15)}</span>
      <div class="ai-reply">
        ${m.text ? html`<div class="ai-bubble ${m.error ? 'ai-bubble--error' : ''}">${richText(m.text)}</div>` : ''}
        ${m.notice ? html`<p class="ai-note">${m.notice}</p>` : ''}
        ${(m.cards ?? []).map(cardHtml)}
      </div>
    </div>
  `;
}

function introHtml() {
  const info = session.meta.assistant;
  return html`
    <div class="ai-msg ai-msg--assistant">
      <span class="ai-avatar" aria-hidden="true">${icon('sparkle', 15)}</span>
      <div class="ai-reply">
        <div class="ai-bubble"><strong>How can I help you?</strong><br />I answer from the school’s records, using your ${session.meta.staff.roleLabel.toLowerCase()} permissions. Anything that changes records waits for your confirmation.</div>
        <div class="ai-suggestions">${info.suggestions.map((s) => html`<button type="button" class="ai-suggestion" data-ai-suggest="${s}">${s}</button>`)}</div>
      </div>
    </div>
  `;
}

function render({ scroll = true } = {}) {
  const log = panel.querySelector('.ai-log');
  log.innerHTML = String(html`
    ${introHtml()}
    ${state.messages.map(messageHtml)}
    ${state.busy ? html`<div class="ai-msg ai-msg--assistant"><span class="ai-avatar" aria-hidden="true">${icon('sparkle', 15)}</span><div class="ai-typing" role="status" aria-label="Thinking"><span></span><span></span><span></span></div></div>` : ''}
  `);
  if (scroll) {
    const last = log.querySelector('.ai-msg:last-child');
    if (last && state.messages.length) log.scrollTop = Math.max(0, last.offsetTop - 12);
  }
  panel.querySelector('[data-ai-send]').disabled = state.busy;
}

function push(message) {
  state.messages.push(message);
  save();
}

const historyForServer = () => state.messages.filter((m) => m.text).slice(-12).map((m) => ({ role: m.role, text: m.text }));

async function request(userText, call) {
  if (state.busy) return;
  push({ role: 'user', text: userText });
  state.busy = true;
  render();
  try {
    const result = await call();
    state.followUp = result.followUp ?? null;
    push({ role: 'assistant', text: result.reply.text, cards: result.reply.cards ?? [], notice: result.notice ?? null });
  } catch (err) {
    state.followUp = null;
    push({ role: 'assistant', text: err.message, cards: [], error: true });
  } finally {
    state.busy = false;
    save();
    render();
  }
}

function send(text) {
  const message = text.trim();
  if (!message) return;
  const history = historyForServer();
  const followUp = state.followUp;
  request(message, () => api('/api/admin/assistant/chat', { method: 'POST', body: { message, history, followUp } }));
}

function runTool(tool, args, say) {
  request(say, () => api('/api/admin/assistant/run', { method: 'POST', body: { tool, args } }));
}

// Replaces a proposal card everywhere in the conversation with its new state.
function updateActionCard(card) {
  for (const m of state.messages) {
    m.cards = (m.cards ?? []).map((c) => (c.type === 'confirm' && c.actionId === card.actionId ? card : c));
  }
}

async function decide(actionId, confirm, button) {
  if (state.busy) return;
  button.disabled = true;
  state.busy = true;
  try {
    const result = await api(`/api/admin/assistant/actions/${actionId}/${confirm ? 'confirm' : 'cancel'}`, { method: 'POST' });
    updateActionCard(result.card);
    for (const c of result.cards ?? []) if (c.type === 'payment') markShown(c.payment.paymentId);
    push({ role: 'user', text: confirm ? 'Confirm' : 'Cancel' });
    push({ role: 'assistant', text: result.text, cards: result.cards ?? [] });
    if (confirm) document.dispatchEvent(new CustomEvent('kbs:assistant-change'));
  } catch (err) {
    push({ role: 'assistant', text: err.message, cards: [], error: true });
  } finally {
    state.busy = false;
    save();
    render();
  }
}

export function openAssistant(text) {
  if (!panel) return;
  state.open = true;
  panel.hidden = false;
  document.body.classList.add('ai-open');
  launcher.setAttribute('aria-expanded', 'true');
  render();
  const input = panel.querySelector('textarea');
  if (text) send(text);
  else input.focus();
}

function closeAssistant() {
  state.open = false;
  panel.hidden = true;
  document.body.classList.remove('ai-open');
  launcher.setAttribute('aria-expanded', 'false');
  launcher.focus();
}

export function startAssistant() {
  const info = session.meta.assistant;
  if (!info) return;
  restore();

  launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.className = 'ai-launcher';
  launcher.setAttribute('aria-expanded', 'false');
  launcher.setAttribute('aria-controls', 'kbs-ai');
  launcher.innerHTML = String(html`${icon('sparkle', 18)}<span>KBS AI</span>`);
  launcher.addEventListener('click', () => (state.open ? closeAssistant() : openAssistant()));

  panel = document.createElement('aside');
  panel.className = 'ai-panel';
  panel.id = 'kbs-ai';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', info.name);
  panel.innerHTML = String(html`
    <header class="ai-head">
      <span class="ai-mark" aria-hidden="true">${icon('sparkle', 18)}</span>
      <div class="ai-title"><strong>${info.name}</strong><span>${info.modeLabel} · ${session.meta.staff.roleLabel} access</span></div>
      <button type="button" class="ai-icon-button" data-ai-clear title="Start a new conversation" aria-label="Start a new conversation">${icon('undo', 17)}</button>
      <button type="button" class="ai-icon-button" data-ai-close aria-label="Close the assistant">${icon('x', 18, 2.5)}</button>
    </header>
    <div class="ai-log" role="log" aria-live="polite"></div>
    <form class="ai-input" data-ai-form>
      <label class="sr-only" for="ai-question">Ask KBS AI Assistant</label>
      <textarea id="ai-question" rows="1" maxlength="500" placeholder="Ask about fees, receipts, students…"></textarea>
      <button type="submit" class="btn btn--primary" data-ai-send aria-label="Send">${icon('send', 18)}</button>
    </form>
    <p class="ai-foot">Answers come only from the school’s records. Payments and fee changes need your confirmation and are recorded in the audit log.</p>
  `);
  document.body.append(launcher, panel);

  const input = panel.querySelector('textarea');
  panel.querySelector('[data-ai-form]').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value;
    input.value = '';
    input.style.height = '';
    send(text);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      panel.querySelector('[data-ai-form]').requestSubmit();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = '';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  });
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAssistant();
  });
  panel.querySelector('[data-ai-close]').addEventListener('click', closeAssistant);
  panel.querySelector('[data-ai-clear]').addEventListener('click', () => {
    state.messages = [];
    state.followUp = null;
    save();
    render();
    input.focus();
  });

  bindReceiptActions(panel);
  panel.addEventListener('click', (event) => {
    const suggestion = event.target.closest('[data-ai-suggest]');
    if (suggestion) return send(suggestion.dataset.aiSuggest);
    const run = event.target.closest('[data-ai-run]');
    if (run) return runTool(run.dataset.aiRun, JSON.parse(run.dataset.aiArgs || '{}'), run.dataset.aiSay || run.textContent.trim());
    const confirm = event.target.closest('[data-ai-confirm]');
    if (confirm) return decide(Number(confirm.dataset.aiConfirm), true, confirm);
    const cancel = event.target.closest('[data-ai-cancel]');
    if (cancel) return decide(Number(cancel.dataset.aiCancel), false, cancel);
    // In-app links close the panel on small screens so the page is visible.
    if (event.target.closest('a[href^="/admin"]') && window.matchMedia('(max-width: 860px)').matches) closeAssistant();
    return undefined;
  });

  document.addEventListener('kbs:open-assistant', (event) => openAssistant(event.detail?.text));
}
