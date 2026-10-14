import { html, mount } from './html.js';

// A small history-based router.
//
// Each route's view is `async (container, ctx) => cleanup?`. The view fills a
// fresh container, which replaces the old one once ready. Listeners attached
// inside the container disappear with it. Views can register:
//   ctx.onMount(fn)      run after the container is on the page (e.g. to focus)
//   ctx.setGuard(fn)     fn returns a message while there is unsaved work; the
//                        router asks the user to confirm before leaving
export function createRouter({ routes, outlet, onError, onChange }) {
  const compiled = routes.map((route) => {
    const keys = [];
    const pattern = route.path.replace(/:(\w+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });
    return { ...route, keys, regex: new RegExp(`^${pattern}/?$`) };
  });

  let cleanup = null;
  let guard = null;
  let navigation = 0;

  function match(pathname) {
    for (const route of compiled) {
      const m = route.regex.exec(pathname);
      if (m) return { route, params: Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }

  async function render() {
    const id = ++navigation;
    const url = new URL(location.href);
    const found = match(url.pathname);
    if (!found) {
      navigate(compiled[0].path, { replace: true });
      return;
    }

    const container = document.createElement('div');
    container.className = 'view';
    const mounted = [];
    let nextGuard = null;
    const ctx = {
      params: found.params,
      query: url.searchParams,
      navigate,
      onMount: (fn) => mounted.push(fn),
      setGuard: (fn) => (nextGuard = fn),
    };

    const slow = setTimeout(() => {
      if (id === navigation) mount(outlet, html`<div class="loading"><div class="spinner" role="status" aria-label="Loading"></div></div>`);
    }, 250);

    try {
      const result = await found.route.view(container, ctx);
      clearTimeout(slow);
      if (id !== navigation) {
        if (typeof result === 'function') result();
        return;
      }
      if (cleanup) cleanup();
      cleanup = typeof result === 'function' ? result : null;
      guard = nextGuard;
      outlet.replaceChildren(container);
      if (found.route.title) document.title = found.route.title;
      window.scrollTo(0, 0);
      mounted.forEach((fn) => fn());
      onChange?.(url.pathname);
    } catch (err) {
      clearTimeout(slow);
      if (id === navigation) onError(err, { navigate, outlet, retry: render });
    }
  }

  function navigate(path, { replace = false } = {}) {
    const warning = !replace && guard?.();
    if (warning && !window.confirm(warning)) return;
    guard = null;
    history[replace ? 'replaceState' : 'pushState'](null, '', path);
    render();
  }

  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');
    if (!link || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (link.target || link.hasAttribute('download')) return;
    const url = new URL(link.href);
    if (url.origin !== location.origin || !match(url.pathname)) return;
    event.preventDefault();
    navigate(url.pathname + url.search);
  });

  window.addEventListener('popstate', render);
  window.addEventListener('beforeunload', (event) => {
    if (guard?.()) event.preventDefault();
  });

  return { navigate, start: render, reload: render };
}
