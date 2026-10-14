import { html } from '../lib/html.js';
import { icon } from '../lib/icons.js';
import { install, installState } from '../lib/pwa.js';

const NAV = [
  { href: '/', label: 'Home', icon: 'home' },
  { href: '/fees', label: 'Fees', icon: 'fees' },
  { href: '/attendance', label: 'Attendance', icon: 'calendar' },
  { href: '/progress', label: 'Progress', icon: 'progress' },
  { href: '/report', label: 'Report', icon: 'report' },
];

export function bottomNav(active) {
  return html`
    <nav class="bottom-nav" aria-label="Main">
      ${NAV.map(
        (item) => html`
          <a href="${item.href}" aria-current="${item.icon === active ? 'page' : 'false'}">
            ${icon(item.icon)}<span>${item.label}</span>
          </a>
        `,
      )}
    </nav>
  `;
}

export function pageHead(title, subtitle) {
  return html`
    <header class="head-text">
      <h1 class="title">${title}</h1>
      <div class="subtitle">${subtitle}</div>
    </header>
  `;
}

export const studentLine = (student) => `${student.name} · ${student.classLabel}`;

// Opens a bottom sheet built from a template. Returns the <dialog>, removed on close.
export function openSheet(template, { label }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'sheet';
  dialog.setAttribute('aria-label', label);
  dialog.innerHTML = `<div class="sheet-body"><div class="sheet-handle" aria-hidden="true"></div>${template}</div>`;
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close(); // tap on the backdrop
  });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

// "Install the app" card on the home screen, while the app is open in the browser.
export function installCard() {
  const state = installState();
  if (state === 'installed') return '';
  return html`
    <section class="card install-card" data-install-card aria-label="Install the app">
      <img src="/icon-maskable-192.png" alt="" width="44" height="44" />
      <div class="grow">
        <div class="card-title">Install the KBS School app</div>
        <div class="meta" data-install-help>${state === 'available' ? 'Opens like an app from your home screen.' : 'In Chrome, tap ⋮ then “Install app” or “Add to Home screen”.'}</div>
      </div>
      ${state === 'available' ? html`<button type="button" class="button button--medium" data-install>Install</button>` : ''}
      <button type="button" class="icon-button" data-install-dismiss aria-label="Hide">${icon('x', 18)}</button>
    </section>
  `;
}

export function bindInstallCard(root) {
  const card = root.querySelector('[data-install-card]');
  if (!card) return;
  try {
    if (localStorage.getItem('kbs.install.hidden') === '1') card.remove();
  } catch {
    // Storage blocked: the card simply shows.
  }
  card.querySelector('[data-install]')?.addEventListener('click', async () => {
    if (await install()) card.remove();
  });
  card.querySelector('[data-install-dismiss]').addEventListener('click', () => {
    card.remove();
    try {
      localStorage.setItem('kbs.install.hidden', '1');
    } catch {
      // Hidden for this visit only.
    }
  });
  // Chrome may offer installation a moment after the page loads.
  document.addEventListener('kbs:installable', (event) => {
    if (!card.isConnected || !event.detail || card.querySelector('[data-install]')) return;
    card.querySelector('[data-install-help]').textContent = 'Opens like an app from your home screen.';
    card.querySelector('[data-install-dismiss]').insertAdjacentHTML('beforebegin', '<button type="button" class="button button--medium" data-install>Install</button>');
    card.querySelector('[data-install]').addEventListener('click', async () => {
      if (await install()) card.remove();
    });
  });
}
