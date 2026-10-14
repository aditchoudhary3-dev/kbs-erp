import { api } from '../../lib/api.js';
import { html, mount } from '../../lib/html.js';
import { loadFamily, forgetFamily } from '../store.js';
import { formatPhone } from '/shared/format.js';

// Parent login, three ways:
//   pin    mobile number + 6-digit PIN (the usual way)
//   setup  first time, or a forgotten PIN: the access code from the school office + a new PIN
//   otp    a one-time code by SMS (only when the school has an SMS service, and in the demo)

const DIGITS = 6;

function formatTyping(value) {
  const digits = value.replace(/\D/g, '').slice(0, 10);
  return digits.length > 5 ? `${digits.slice(0, 5)} ${digits.slice(5)}` : digits;
}

const phoneField = (value, { readOnly = false, change = false } = {}) => html`
  <div class="field">
    <div class="field-row">
      <label for="phone" class="field-label">Mobile number</label>
      ${change ? html`<button type="button" class="text-button" data-change>Change number</button>` : ''}
    </div>
    <div class="phone-field">
      <span class="phone-prefix">+91</span>
      <input id="phone" class="phone-input" type="tel" inputmode="numeric" autocomplete="tel-national" placeholder="98765 43210" value="${value}" ${readOnly ? 'readonly' : ''} />
    </div>
  </div>
`;

const pinField = (id, label, { autocomplete = 'current-password' } = {}) => html`
  <div class="field">
    <label for="${id}" class="field-label">${label}</label>
    <input id="${id}" class="pin-input" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="${autocomplete}" placeholder="••••••" />
  </div>
`;

export async function loginView(root, { navigate, onMount }) {
  // Already logged in? Go straight to the dashboard.
  try {
    await loadFamily({ fresh: true });
    navigate('/', { replace: true });
    return;
  } catch (err) {
    if (err.status !== 401) throw err;
  }

  const config = await api('/api/config');
  const demo = config.demo;
  const ways = config.login ?? { otp: true, pin: false };
  let mode = ways.pin ? 'pin' : 'otp';
  let phone = demo ? formatPhone(demo.parentPhone) : '';
  let busy = false;
  // One-time code state
  let otpSent = false;
  let resendAt = 0;
  let timer = null;

  function intro() {
    if (mode === 'setup') return 'Enter your mobile number and the access code from the school office, then choose a 6-digit PIN.';
    if (mode === 'otp') return 'Log in with the mobile number you gave the school. We’ll send you a one-time code.';
    return 'Log in with the mobile number you gave the school and your 6-digit PIN.';
  }

  function demoHint() {
    if (!demo) return '';
    if (mode === 'pin') return html`<p class="demo-hint" data-demo>Demo: <strong>+91 ${formatPhone(demo.parentPhone)}</strong> with PIN <strong>${demo.parentPin}</strong>.</p>`;
    if (mode === 'otp') {
      return html`<p class="demo-hint" data-demo>Demo: try <strong>+91 ${formatPhone(demo.parentPhone)}</strong> (Aarav, 6-B) or <strong>+91 ${formatPhone(demo.siblingsPhone)}</strong> (two children).</p>`;
    }
    return html`<p class="demo-hint" data-demo>Demo: the school office gives each family an access code from <strong>Parent App Access</strong>.</p>`;
  }

  function form() {
    if (mode === 'pin') {
      return html`
        ${phoneField(phone)}
        ${pinField('pin', '6-digit PIN')}
        <p class="form-error" data-error role="alert" hidden></p>
        ${demoHint()}
        <div class="spacer"></div>
        <button type="submit" class="button button--large" data-submit>Log in</button>
        <div class="login-switch">
          <button type="button" class="inline-link" data-mode="setup">First time? Use your access code</button>
          ${ways.otp ? html`<button type="button" class="inline-link" data-mode="otp">Get a login code by SMS instead</button>` : ''}
        </div>
        <p class="login-foot">Forgot your PIN? Ask the school office for a new access code.</p>
      `;
    }
    if (mode === 'setup') {
      return html`
        ${phoneField(phone)}
        <div class="field">
          <label for="code" class="field-label">Access code from the school</label>
          <input id="code" class="code-input" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="ABCD-2345" maxlength="9" />
        </div>
        ${pinField('pin', 'Choose a 6-digit PIN', { autocomplete: 'new-password' })}
        ${pinField('pin2', 'Type the PIN again', { autocomplete: 'new-password' })}
        <p class="form-error" data-error role="alert" hidden></p>
        ${demoHint()}
        <div class="spacer"></div>
        <button type="submit" class="button button--large" data-submit>Set PIN and log in</button>
        <div class="login-switch"><button type="button" class="inline-link" data-mode="pin">I already have a PIN</button></div>
        <p class="login-foot">No access code? The school office gives one to each family.</p>
      `;
    }
    return html`
      ${phoneField(phone, { readOnly: otpSent, change: otpSent })}
      <div class="field" data-code-field ${otpSent ? '' : 'hidden'}>
        <label for="otp1" class="field-label">Enter the 6-digit code</label>
        <div class="otp" role="group" aria-label="6-digit code">
          ${Array.from({ length: DIGITS }, (_, i) => html`<input id="otp${i + 1}" class="otp-digit" aria-label="Digit ${i + 1}" inputmode="numeric" autocomplete="${i === 0 ? 'one-time-code' : 'off'}" />`)}
        </div>
        <div class="otp-status" data-status></div>
      </div>
      <p class="form-error" data-error role="alert" hidden></p>
      ${demoHint()}
      <div class="spacer"></div>
      <button type="submit" class="button button--large" data-submit>${otpSent ? 'Verify and continue' : 'Send code'}</button>
      ${ways.pin ? html`<div class="login-switch"><button type="button" class="inline-link" data-mode="pin">Log in with my PIN</button></div>` : ''}
      <p class="login-foot">Number not recognised? Contact the school office.</p>
    `;
  }

  function render() {
    clearInterval(timer);
    mount(
      root,
      html`
        <main class="login">
          <div class="brand">
            <img class="brand-logo" src="${config.logo}" alt="" width="56" height="56" />
            <div class="grow">
              <div class="brand-name">${config.schoolShortName}</div>
              <div class="meta">${config.schoolName}</div>
            </div>
          </div>
          <div class="login-intro">
            <h1 class="login-title">${mode === 'setup' ? 'Set up the app' : 'Welcome, parents'}</h1>
            <p class="login-lede">${intro()}</p>
          </div>
          <form class="login-form" novalidate>${form()}</form>
        </main>
      `,
    );
    if (mode === 'otp' && otpSent) startCountdown();
  }

  const $ = (selector) => root.querySelector(selector);
  const showError = (message) => {
    const box = $('[data-error]');
    box.textContent = message;
    box.hidden = !message;
  };
  const digits = () => [...root.querySelectorAll('.otp-digit')];
  const code = () => digits().map((d) => d.value).join('');

  function renderStatus() {
    const status = $('[data-status]');
    if (!status) return;
    const left = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
    if (left > 0) {
      status.textContent = `Code sent to +91 ${phone} · Resend in 0:${String(left).padStart(2, '0')}`;
    } else {
      status.innerHTML = String(html`Didn’t get it? <button type="button" class="inline-link" data-resend>Resend code</button>`);
      clearInterval(timer);
    }
  }
  function startCountdown() {
    clearInterval(timer);
    renderStatus();
    timer = setInterval(renderStatus, 1000);
  }

  async function sendCode() {
    const result = await api('/api/auth/otp', { method: 'POST', body: { phone: $('#phone').value } });
    phone = formatPhone(result.phone);
    otpSent = true;
    resendAt = Date.now() + result.resendIn * 1000;
    render();
    if (result.demoCode) {
      const box = $('[data-demo]');
      if (box) box.innerHTML = String(html`Demo mode: no SMS is sent. Your code is <strong>${result.demoCode}</strong>.`);
    }
    digits()[0].focus();
  }

  async function verifyCode() {
    if (code().length < DIGITS) {
      showError('Enter all 6 digits of the code.');
      digits()[code().length]?.focus();
      return;
    }
    try {
      await api('/api/auth/verify', { method: 'POST', body: { phone, code: code() } });
    } catch (err) {
      digits().forEach((d) => (d.value = ''));
      digits()[0].focus();
      throw err;
    }
    done();
  }

  async function pinLogin() {
    const pin = $('#pin').value.replace(/\D/g, '');
    if (pin.length !== DIGITS) {
      showError('Enter your 6-digit PIN.');
      $('#pin').focus();
      return;
    }
    await api('/api/auth/pin', { method: 'POST', body: { phone: $('#phone').value, pin } });
    done();
  }

  async function setup() {
    const pin = $('#pin').value.replace(/\D/g, '');
    if (!$('#code').value.trim()) {
      showError('Enter the access code from the school office.');
      $('#code').focus();
      return;
    }
    if (pin.length !== DIGITS) {
      showError('Choose a 6-digit PIN.');
      $('#pin').focus();
      return;
    }
    if (pin !== $('#pin2').value.replace(/\D/g, '')) {
      showError('The two PINs are different. Type the same PIN twice.');
      $('#pin2').focus();
      return;
    }
    await api('/api/auth/setup', { method: 'POST', body: { phone: $('#phone').value, code: $('#code').value, pin } });
    done();
  }

  function done() {
    clearInterval(timer);
    forgetFamily();
    navigate('/', { replace: true });
  }

  async function run(action) {
    if (busy) return;
    busy = true;
    const submit = $('[data-submit]');
    if (submit) submit.disabled = true;
    showError('');
    try {
      await action();
    } catch (err) {
      showError(err.message);
    } finally {
      busy = false;
      const again = $('[data-submit]');
      if (again) again.disabled = false;
    }
  }

  root.addEventListener('submit', (event) => {
    event.preventDefault();
    if (mode === 'pin') run(pinLogin);
    else if (mode === 'setup') run(setup);
    else run(otpSent ? verifyCode : sendCode);
  });

  root.addEventListener('input', (event) => {
    const t = event.target;
    if (t.id === 'phone' && !t.readOnly) {
      t.value = formatTyping(t.value);
      phone = t.value;
    } else if (t.id === 'code') {
      const raw = t.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      t.value = raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
    } else if (t.classList.contains('pin-input')) {
      t.value = t.value.replace(/\D/g, '').slice(0, DIGITS);
    } else if (t.classList.contains('otp-digit')) {
      // One digit per box; pasting or autofilling the whole code fills every box.
      const boxes = digits();
      const i = boxes.indexOf(t);
      const typed = t.value.replace(/\D/g, '');
      if (typed.length > 1) {
        const all = (code().slice(0, i) + typed).slice(0, DIGITS).split('');
        boxes.forEach((b, j) => (b.value = all[j] ?? ''));
      } else {
        t.value = typed;
      }
      boxes.forEach((b) => b.classList.toggle('is-filled', Boolean(b.value)));
      const next = boxes.find((b) => !b.value);
      if (typed && next) next.focus();
      if (code().length === DIGITS) run(verifyCode);
    }
  });

  root.addEventListener('keydown', (event) => {
    const t = event.target;
    if (!t.classList?.contains('otp-digit')) return;
    const boxes = digits();
    const i = boxes.indexOf(t);
    if (event.key === 'Backspace' && !t.value && i > 0) {
      boxes[i - 1].value = '';
      boxes[i - 1].classList.remove('is-filled');
      boxes[i - 1].focus();
      event.preventDefault();
    }
  });

  root.addEventListener('click', (event) => {
    const switchTo = event.target.closest('[data-mode]');
    if (switchTo) {
      phone = $('#phone')?.value ?? phone;
      mode = switchTo.dataset.mode;
      otpSent = false;
      render();
      ($('#phone').value ? $('#pin') ?? $('#phone') : $('#phone')).focus();
      return;
    }
    if (event.target.closest('[data-change]')) {
      otpSent = false;
      render();
      $('#phone').focus();
      return;
    }
    if (event.target.closest('[data-resend]')) run(sendCode);
  });

  render();
  onMount(() => ($('#phone').value ? ($('#pin') ?? $('#phone')) : $('#phone')).focus());
  return () => clearInterval(timer);
}
