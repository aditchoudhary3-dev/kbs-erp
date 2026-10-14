import { EventEmitter } from 'node:events';

// In-process event bus. Services announce things that happened
// ("payment.confirmed"); listeners do the follow-up work (receipt message,
// clerk notification, register export) without the services knowing them.
export const events = new EventEmitter();
events.setMaxListeners(50);

// Runs a listener without letting one failure break the others or the caller.
export function on(name, listener) {
  events.on(name, (payload) => {
    Promise.resolve()
      .then(() => listener(payload))
      .catch((err) => console.error(`[events] ${name} listener failed:`, err));
  });
}

// ---- Live updates to staff screens (server-sent events) ----------------------

const clients = new Set();

export function openStream(req, res, staff) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const client = { res, staff };
  clients.add(client);
  req.on('close', () => clients.delete(client));
}

export function broadcast(type, data) {
  const message = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) client.res.write(message);
}

export function closeStreams() {
  for (const client of clients) client.res.end();
  clients.clear();
}

// Comment lines keep proxies from closing idle connections.
setInterval(() => {
  for (const client of clients) client.res.write(': ping\n\n');
}, 20_000).unref();
