import { html } from '../lib/html.js';

export function pageHead(title, subtitle, actions = '') {
  return html`
    <div class="page-head">
      <div class="page-head-text">
        <h1 class="page-title">${title}</h1>
        ${subtitle ? html`<div class="page-sub">${subtitle}</div>` : ''}
      </div>
      ${actions ? html`<div class="toolbar">${actions}</div>` : ''}
    </div>
  `;
}

// Monthly progress statuses (Published, Draft, Pending).
export const statusBadge = (status) => html`<span class="badge badge--${status.toLowerCase()}">${status}</span>`;

// Payment statuses: PAID (green), PENDING (orange), FAILED (red).
export const payBadge = (status) => html`<span class="pay-badge pay-badge--${status.toLowerCase()}">${status}</span>`;

// WhatsApp status of the parent copy: SENT (green), PENDING (orange) or
// FAILED (red). Takes the message ({ state, detail }) or just its state.
export function whatsappStatus(message, { label = true } = {}) {
  const state = typeof message === 'string' ? message : message?.state;
  if (!state) return '';
  const detail = typeof message === 'object' ? message.detail : '';
  return html`<span class="wa-badge wa-badge--${state.toLowerCase()}" title="${detail ?? ''}">${label ? 'WhatsApp: ' : ''}${state}</span>`;
}

// Class sections (6-A, 6-B …) as <option>s; value is the section's id.
export function classOptions(classes, selected, { all } = {}) {
  return html`
    ${all ? html`<option value="all" ${selected === 'all' ? 'selected' : ''}>${all}</option>` : ''}
    ${classes.map((c) => html`<option value="${c.id}" ${String(c.id) === String(selected) ? 'selected' : ''}>${c.name}</option>`)}
  `;
}

// Grades (Nursery … Class 12) as <option>s.
export function gradeOptions(grades, selected, { all = 'All classes' } = {}) {
  return html`
    ${all ? html`<option value="" ${!selected ? 'selected' : ''}>${all}</option>` : ''}
    ${grades.map((g) => html`<option value="${g}" ${g === selected ? 'selected' : ''}>${g}</option>`)}
  `;
}

export function sectionOptions(classes, grade, selected) {
  const sections = [...new Set(classes.filter((c) => !grade || c.grade === grade).map((c) => c.section))].sort();
  return html`
    <option value="" ${!selected ? 'selected' : ''}>All sections</option>
    ${sections.map((s) => html`<option value="${s}" ${s === selected ? 'selected' : ''}>Section ${s}</option>`)}
  `;
}

export function options(values, selected, { all } = {}) {
  return html`
    ${all ? html`<option value="" ${!selected ? 'selected' : ''}>${all}</option>` : ''}
    ${values.map((v) => html`<option value="${v}" ${v === selected ? 'selected' : ''}>${v}</option>`)}
  `;
}

// Download buttons for a report: Excel and CSV.
export function exportButtons(path, params = {}) {
  const query = (format) => new URLSearchParams({ ...params, format }).toString();
  return html`
    <span class="export-group">
      <a class="btn btn--small" href="${path}?${query('xlsx')}" download>Excel</a>
      <a class="btn btn--small" href="${path}?${query('csv')}" download>CSV</a>
    </span>
  `;
}

// Centered modal dialog. Returns the <dialog>; it is removed when closed.
export function openModal(template, { label, wide = false }) {
  const dialog = document.createElement('dialog');
  dialog.className = `modal${wide ? ' modal--wide' : ''}`;
  dialog.setAttribute('aria-label', label);
  dialog.innerHTML = `<div class="modal-body">${template}</div>`;
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

// Removes empty values so they do not appear in URLs.
export const compact = (object) => Object.fromEntries(Object.entries(object).filter(([, v]) => v !== '' && v !== null && v !== undefined));
