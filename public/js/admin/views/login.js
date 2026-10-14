import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';

export async function loginScreen(root, onLoggedIn) {
  const config = await api('/api/config').catch(() => ({ schoolName: '', schoolShortName: 'KBS School', monogram: 'KBS', demo: null }));
  const demo = config.demo;
  document.title = `Staff login · ${config.schoolShortName}`;

  mount(
    root,
    html`
      <div class="login-wrap">
        <form class="login-card" novalidate>
          <div class="brand">
            <img class="brand-logo brand-logo--large" src="${config.logo ?? '/logo-192.png'}" alt="" width="64" height="64" />
            <div class="page-head-text" style="gap: 0">
              <span class="brand-name">${config.schoolShortName}</span>
              <span class="brand-sub">${config.schoolName}</span>
            </div>
          </div>
          <h1 class="page-title">Staff login</h1>
          <label class="field">Email
            <input class="control" type="email" name="email" autocomplete="username" required value="${demo?.clerkEmail ?? ''}" />
          </label>
          <label class="field">Password
            <input class="control" type="password" name="password" autocomplete="current-password" required value="${demo?.clerkPassword ?? ''}" />
          </label>
          <p class="form-error" role="alert" hidden></p>
          <button type="submit" class="btn btn--primary">Log in</button>
          ${demo
            ? html`
                <div class="demo-hint">
                  Demo accounts. The clerk account is filled in.
                  <div style="display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap">
                    <button type="button" class="btn btn--small" data-demo="clerk">Use Clerk (${demo.clerkEmail})</button>
                    <button type="button" class="btn btn--small" data-demo="admin">Use Admin (${demo.adminEmail})</button>
                  </div>
                </div>
              `
            : ''}
        </form>
      </div>
    `,
  );

  const form = root.querySelector('form');
  const errorBox = form.querySelector('.form-error');
  const button = form.querySelector('button[type="submit"]');

  form.addEventListener('click', (event) => {
    const choice = event.target.closest('[data-demo]')?.dataset.demo;
    if (!choice) return;
    form.email.value = demo[`${choice}Email`];
    form.password.value = demo[`${choice}Password`];
    form.requestSubmit();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    button.disabled = true;
    errorBox.hidden = true;
    try {
      await api('/api/admin/login', { method: 'POST', body: { email: data.get('email'), password: data.get('password') } });
      onLoggedIn();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      button.disabled = false;
    }
  });

  form.querySelector(demo ? 'button[type="submit"]' : 'input').focus();
}
