import { createRouter } from '../lib/router.js';
import { html, mount } from '../lib/html.js';
import { forgetFamily } from './store.js';
import { loginView } from './views/login.js';
import { homeView } from './views/home.js';
import { feesView } from './views/fees.js';
import { paymentView } from './views/payment.js';
import { progressView } from './views/progress.js';
import { annualView } from './views/annual.js';
import { attendanceView } from './views/attendance.js';
import { timetableView } from './views/timetable.js';
import { registerApp } from '../lib/pwa.js';

registerApp();

const router = createRouter({
  outlet: document.getElementById('app'),
  routes: [
    { path: '/', view: homeView, title: 'Home · KBS School' },
    { path: '/login', view: loginView, title: 'Log in · KBS School' },
    { path: '/fees', view: feesView, title: 'Fees · KBS School' },
    { path: '/payments/:id', view: paymentView, title: 'Payment successful · KBS School' },
    { path: '/progress', view: progressView, title: 'Monthly progress · KBS School' },
    { path: '/report', view: annualView, title: 'Annual report · KBS School' },
    { path: '/attendance', view: attendanceView, title: 'Attendance · KBS School' },
    { path: '/timetable', view: timetableView, title: 'Timetable · KBS School' },
  ],
  onError(err, { navigate, outlet, retry }) {
    if (err.status === 401) {
      forgetFamily();
      navigate('/login', { replace: true });
      return;
    }
    mount(
      outlet,
      html`
        <div class="error-state" role="alert">
          <h2>Something went wrong</h2>
          <p class="muted">${err.message}</p>
          <button type="button" class="button button--medium" data-retry>Try again</button>
        </div>
      `,
    );
    outlet.querySelector('[data-retry]').addEventListener('click', retry);
  },
});

router.start();
