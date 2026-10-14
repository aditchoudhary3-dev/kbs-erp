// Installing the app on a phone (Progressive Web App).
//
// registerApp() starts the service worker and listens for Chrome's install
// offer. installState() tells a page whether to show an "Install app" button;
// install() shows Chrome's install dialog. Pages listen for "kbs:installable"
// to show or hide their button.

let deferred = null;

export function registerApp() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {}));
  }
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event;
    document.dispatchEvent(new CustomEvent('kbs:installable', { detail: true }));
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    document.dispatchEvent(new CustomEvent('kbs:installable', { detail: false }));
  });
}

const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// 'installed', 'available' (Chrome offered it), or 'manual' (use the browser menu).
export function installState() {
  if (standalone()) return 'installed';
  return deferred ? 'available' : 'manual';
}

export async function install() {
  if (!deferred) return false;
  deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null;
  document.dispatchEvent(new CustomEvent('kbs:installable', { detail: false }));
  return outcome === 'accepted';
}
