import http from 'node:http';
import path from 'node:path';
import { config, ROOT } from './config.js';
import { openDatabase, isEmpty, purgeExpired } from './db.js';
import { createRouter, HttpError, resolveInside, sendJson, serveFile, useSecureCookies } from './http.js';
import { closeStreams } from './events.js';
import { parentRoutes } from './routes/parent.js';
import { adminRoutes } from './routes/admin.js';
import { gatewayRoutes } from './routes/gateway.js';
import { schoolRoutes } from './routes/school.js';
import { registerNotificationHandlers } from './services/notifications.js';
import { startReconcileWorker, stopReconcileWorker } from './services/payments.js';
import { startRetryWorker, stopRetryWorker } from './services/whatsapp.js';
import { configureRegisterSync } from './services/register-sync.js';
import { startLateFeeWorker, stopLateFeeWorker } from './services/fee-structure.js';
import { configureSystem, startBackupWorker, stopBackupWorker } from './services/system.js';
import { gateway } from './integrations/payments/index.js';
import { seed } from './seed.js';
import { ensureFirstAdmin, prepareNewSchool } from './bootstrap.js';

const PUBLIC = path.join(ROOT, 'public');
const SHARED = path.join(ROOT, 'shared');

function securityHeaders() {
  // Razorpay Checkout needs its script and frames when Razorpay is in use.
  const razorpay = config.payments.gateway === 'razorpay';
  const csp = [
    "default-src 'self'",
    `script-src 'self'${razorpay ? ' https://checkout.razorpay.com' : ''}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data:${razorpay ? ' https://*.razorpay.com' : ''}`,
    "font-src 'self'",
    `connect-src 'self'${razorpay ? ' https://*.razorpay.com' : ''}`,
    `frame-src 'self'${razorpay ? ' https://api.razorpay.com https://checkout.razorpay.com' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'x-frame-options': 'DENY',
    'content-security-policy': csp,
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    // Browsers remember to use HTTPS only (when the app is served over HTTPS).
    ...(config.secureCookies ? { 'strict-transport-security': 'max-age=31536000' } : {}),
  };
}

async function serveApp(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
  const { pathname } = url;

  if (pathname.startsWith('/shared/')) {
    const file = resolveInside(SHARED, pathname.slice('/shared'.length));
    if (file && (await serveFile(req, res, file))) return;
    throw new HttpError(404, 'Not found');
  }

  // Real files (scripts, styles, fonts, icons).
  if (path.extname(pathname)) {
    const file = resolveInside(PUBLIC, pathname);
    if (file && (await serveFile(req, res, file))) return;
    throw new HttpError(404, 'Not found');
  }

  // Everything else is a page in one of the two single-page apps.
  const page = pathname === '/admin' || pathname.startsWith('/admin/') ? 'admin.html' : 'index.html';
  await serveFile(req, res, path.join(PUBLIC, page));
}

export function createApp() {
  const router = createRouter();
  parentRoutes(router);
  adminRoutes(router);
  schoolRoutes(router);
  gatewayRoutes(router);
  const headers = securityHeaders();

  return http.createServer(async (req, res) => {
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    const url = new URL(req.url, 'http://localhost');
    try {
      // For the hosting platform's health checks and uptime monitors.
      if (url.pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (await router.handle(req, res, url)) return;
      if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');
      await serveApp(req, res, url);
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
      } else {
        console.error(err);
        sendJson(res, 500, { error: 'Something went wrong on our side. Please try again.' });
      }
    }
  });
}

let handlersRegistered = false;

// Opens the database (seeding demo data on first run), starts background
// workers and begins listening.
export function startServer({ port, host, dbFile }) {
  openDatabase(dbFile);
  useSecureCookies(config.secureCookies);
  // A new database: demo data in demo mode, otherwise an empty school.
  const empty = isEmpty();
  const seeded = empty && config.seedDemo;
  if (seeded) seed();
  else if (empty) prepareNewSchool();
  ensureFirstAdmin();
  purgeExpired();
  configureRegisterSync(dbFile);
  configureSystem(dbFile);
  gateway(); // fail fast on a bad PAYMENT_GATEWAY setting

  if (!handlersRegistered) {
    registerNotificationHandlers();
    handlersRegistered = true;
  }
  startReconcileWorker();
  startRetryWorker();
  startLateFeeWorker();
  startBackupWorker();

  const server = createApp();
  server.on('close', () => {
    stopReconcileWorker();
    stopRetryWorker();
    stopLateFeeWorker();
    stopBackupWorker();
  });
  const close = server.close.bind(server);
  server.close = (callback) => {
    closeStreams();
    return close(callback);
  };

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const { port: actualPort } = server.address();
      config.runtime.internalUrl = `http://127.0.0.1:${actualPort}`;
      resolve({ server, port: actualPort, seeded });
    });
  });
}
