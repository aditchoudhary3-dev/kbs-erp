// Entry point: `npm start`.

// The built-in SQLite module needs Node 22.13 or newer. Check before loading it
// so an old Node prints a clear message instead of a stack trace.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`The KBS School app needs Node.js 22.13 or newer (you have ${process.version}). Get it from https://nodejs.org`);
  process.exit(1);
}

const { config } = await import('./config.js');
const { startServer } = await import('./app.js');
const { DEMO } = await import('./seed.js');
const { formatPhone } = await import('../shared/format.js');

try {
  const { port, seeded } = await startServer(config);
  const { gateway } = await import('./integrations/payments/index.js');
  const { whatsapp } = await import('./integrations/whatsapp/index.js');
  const { configureRegisterSync } = await import('./services/register-sync.js');
  const base = config.publicBaseUrl || `http://localhost:${port}`;
  const bold = (s) => `\x1b[1m${s}\x1b[0m`;
  const exportsDir = configureRegisterSync(config.dbFile);

  console.log(`
  ${bold(`${config.appName} is running`)}${seeded ? ' (demo data loaded)' : ''}

    Parent app        ${bold(base)}
    School office     ${bold(`${base}/admin`)}

    Payments          ${gateway().label}${gateway().name === 'test' ? ' (no money moves; set RAZORPAY_* to go live)' : ''}
    WhatsApp          ${whatsapp().label}${whatsapp().automatic ? '' : ' (clerk presses Send; set WHATSAPP_* for automatic)'}
    AI assistant      ${config.assistant.provider === 'claude' && config.assistant.claude.apiKey ? `Claude (${config.assistant.claude.model})` : 'Built-in (set ANTHROPIC_API_KEY to use Claude)'}
    Excel register    ${exportsDir ?? 'off'}
${
  config.demoMode
    ? `
    Demo admin        ${DEMO.adminEmail} / ${DEMO.adminPassword}
    Demo clerk        ${DEMO.clerkEmail} / ${DEMO.clerkPassword}
    Demo teacher      ${DEMO.teacherEmail} / ${DEMO.teacherPassword}
    Demo parent       +91 ${formatPhone(DEMO.parentPhone)} with PIN ${DEMO.parentPin} (Aarav, 6-B) · +91 ${formatPhone(DEMO.siblingsPhone)} (two children)
    Login codes appear on screen and below as [SMS] lines.
`
    : ''
}
  Press Ctrl+C to stop.
`);
} catch (err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Try: PORT=3001 npm start`);
  } else {
    console.error(err);
  }
  process.exit(1);
}
