import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_BODY_BYTES = 100 * 1024;

export function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    const keys = [];
    const source = pattern
      .replace(/[.]/g, '\\.')
      .replace(/:(\w+)/g, (_, key) => {
        keys.push(key);
        return '([^/]+)';
      });
    routes.push({ method, regex: new RegExp(`^${source}$`), keys, handler });
  }

  // Returns false when no route matches the path, so the caller can fall through.
  async function handle(req, res, url) {
    let pathMatched = false;
    for (const route of routes) {
      const match = route.regex.exec(url.pathname);
      if (!match) continue;
      pathMatched = true;
      if (route.method !== req.method) continue;

      const params = {};
      route.keys.forEach((key, i) => (params[key] = decodeURIComponent(match[i + 1])));
      const { body, rawBody } = req.method === 'GET' ? { body: {}, rawBody: null } : await readJson(req);
      const ctx = {
        req,
        res,
        url,
        params,
        query: url.searchParams,
        cookies: parseCookies(req.headers.cookie),
        body,
        rawBody, // exact bytes received, for webhook signature checks
      };
      const result = await route.handler(ctx);
      // Handlers that stream (server-sent events) or send files write the response themselves.
      if (!res.headersSent) sendJson(res, 200, result ?? { ok: true });
      return true;
    }
    if (pathMatched) throw new HttpError(405, 'Method not allowed');
    return false;
  }

  return {
    handle,
    get: (pattern, handler) => add('GET', pattern, handler),
    post: (pattern, handler) => add('POST', pattern, handler),
    put: (pattern, handler) => add('PUT', pattern, handler),
    delete: (pattern, handler) => add('DELETE', pattern, handler),
  };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  if (size === 0) return { body: {}, rawBody: Buffer.alloc(0) };
  // Requiring a JSON content type keeps plain cross-site form posts out.
  if (!(req.headers['content-type'] || '').startsWith('application/json')) {
    throw new HttpError(415, 'Expected a JSON request body.');
  }
  const rawBody = Buffer.concat(chunks);
  try {
    const body = JSON.parse(rawBody.toString('utf8'));
    return { body: body && typeof body === 'object' ? body : {}, rawBody };
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.');
  }
}

export function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

export function sendDownload(res, buffer, { type, filename, inline = false }) {
  res.writeHead(200, {
    'content-type': type,
    'content-length': buffer.length,
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename.replace(/[^\w.-]+/g, '-')}"`,
    'cache-control': 'no-store',
  });
  res.end(buffer);
}

export function sendHtml(res, html, { status = 200, headers = {} } = {}) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

export function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try {
      cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // Ignore cookies we did not set.
    }
  }
  return cookies;
}

// Cookies are marked Secure when the app is served over HTTPS (see config.secureCookies).
let secureCookies = false;
export const useSecureCookies = (on) => (secureCookies = Boolean(on));

export function setCookie(res, name, value, { maxAge } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secureCookies) parts.push('Secure');
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  const existing = res.getHeader('set-cookie');
  res.setHeader('set-cookie', [...(existing ? [].concat(existing) : []), parts.join('; ')]);
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

// Maps a URL path onto a file inside rootDir, refusing anything that escapes it.
export function resolveInside(rootDir, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const full = path.join(rootDir, path.normalize(decoded));
  return full.startsWith(rootDir + path.sep) ? full : null;
}

export async function serveFile(req, res, filePath) {
  let data;
  try {
    data = await fs.promises.readFile(filePath);
  } catch {
    return false;
  }
  const ext = path.extname(filePath);
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[ext] || 'application/octet-stream',
    'content-length': data.length,
    'cache-control': ext === '.woff2' ? 'public, max-age=86400' : 'no-cache',
    // The service worker controls the whole site (both apps).
    ...(path.basename(filePath) === 'sw.js' ? { 'service-worker-allowed': '/' } : {}),
  });
  res.end(req.method === 'HEAD' ? undefined : data);
  return true;
}
