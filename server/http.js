/**
 * MIAMI DEVOUR — the REST surface, mounted on the room server's port.
 *
 * This rides *beside* the WebSocket game protocol on the same listener (see
 * server.js), for one reason: the game is served from :5173 and the room server
 * is on :8787, so anything the meta layer needs is already a cross-origin call
 * to that one host. Adding a second port would mean a second thing to forward,
 * a second thing to expose on a LAN, and a second thing to get wrong.
 *
 * THE CONTRACT (matchmaking.js on the client codes against exactly this):
 *
 *   GET  /api/health
 *   GET  /api/rooms                       POST /api/rooms
 *   GET  /api/rooms/:code
 *   GET  /api/leaderboard?board=&metric=&limit=
 *   POST /api/profile                     GET  /api/profile/:id
 *
 * Every response is JSON and carries permissive CORS. Without those headers
 * every call from :5173 fails in the browser and the entire meta layer silently
 * shows nothing — which is exactly the failure mode that looks like "the
 * feature was never built".
 */

const MAX_BODY = 16 * 1024;
const RATE_WINDOW_MS = 60000;
const RATE_LIMIT = 90;          // writes per IP per window

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '600',
};

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    // The room browser is polled every few seconds; a cached 200 would show a
    // lobby that emptied a minute ago.
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/** Resolves to null on overflow or error rather than throwing into the server. */
function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { chunks.length = 0; req.destroy(); finish(null); return; }
      chunks.push(c);
    });
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => finish(null));
    req.on('aborted', () => finish(null));
  });
}

function parseJson(text) {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * @param {{ store: any, version: number|string }} deps
 * @returns {(req: import('node:http').IncomingMessage,
 *            res: import('node:http').ServerResponse) => void}
 */
export function createHttpHandler({ store, version = 0 }) {
  /** ip -> { n, reset }. Swept lazily; an unbounded map is a slow memory leak. */
  const rate = new Map();

  function overRate(req) {
    const ip = String(req.socket?.remoteAddress || 'unknown');
    const now = Date.now();
    if (rate.size > 512) {
      for (const [k, v] of rate) if (v.reset < now) rate.delete(k);
    }
    let e = rate.get(ip);
    if (!e || e.reset < now) { e = { n: 0, reset: now + RATE_WINDOW_MS }; rate.set(ip, e); }
    e.n++;
    return e.n > RATE_LIMIT;
  }

  return function handle(req, res) {
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      sendJson(res, 400, { error: 'bad request' });
      return;
    }
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = (req.method || 'GET').toUpperCase();

    if (method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    // A human who opens the server port in a browser should get something
    // better than a stack trace.
    if (path === '/' && method === 'GET') {
      sendJson(res, 200, {
        name: 'miami-devour room server',
        version,
        api: ['/api/health', '/api/rooms', '/api/rooms/:code', '/api/leaderboard', '/api/profile/:id'],
      });
      return;
    }

    if (!path.startsWith('/api/')) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    try {
      route(req, res, { path, method, url });
    } catch (e) {
      // One bad request must never take down a running match.
      console.warn('[http]', method, path, e && e.message);
      sendJson(res, 500, { error: 'server error' });
    }
  };

  function route(req, res, { path, method, url }) {
    /* ------------------------------------------------------------ health --- */
    if (path === '/api/health' && method === 'GET') {
      sendJson(res, 200, { ok: true, version });
      return;
    }

    /* ------------------------------------------------------------- rooms --- */
    if (path === '/api/rooms' && method === 'GET') {
      sendJson(res, 200, { rooms: store.listRooms() });
      return;
    }

    if (path === '/api/rooms' && method === 'POST') {
      if (overRate(req)) { sendJson(res, 429, { error: 'slow down' }); return; }
      readBody(req).then((text) => {
        const body = parseJson(text) || {};
        // `code` is an extension the friends flow uses: a player asks for their
        // own profile id as the lobby code so "my code" and "my lobby" are the
        // same six characters. It is a request, not a guarantee — the store
        // falls back to a random free code if it is taken or malformed.
        const desc = store.createRoom({
          mode: body.mode,
          private: !!body.private,
          code: body.code,
        });
        sendJson(res, 200, { room: desc.name, code: desc.code, mode: desc.mode });
      });
      return;
    }

    const roomMatch = /^\/api\/rooms\/([^/]{1,32})$/.exec(path);
    if (roomMatch && method === 'GET') {
      const room = store.findRoom(decodeURIComponent(roomMatch[1]));
      if (!room) { sendJson(res, 404, { error: 'not found' }); return; }
      sendJson(res, 200, room);
      return;
    }

    /* ------------------------------------------------------- leaderboard --- */
    if (path === '/api/leaderboard' && method === 'GET') {
      sendJson(res, 200, store.leaderboard({
        board: url.searchParams.get('board') || 'global',
        metric: url.searchParams.get('metric') || 'totalScore',
        limit: url.searchParams.get('limit') || 100,
      }));
      return;
    }

    /* ----------------------------------------------------------- profile --- */
    if (path === '/api/profile' && method === 'POST') {
      if (overRate(req)) { sendJson(res, 429, { error: 'slow down' }); return; }
      readBody(req).then((text) => {
        const body = parseJson(text);
        const result = body && store.submitProfile(body);
        if (!result) { sendJson(res, 400, { error: 'bad profile' }); return; }
        sendJson(res, 200, { ok: true, rank: result.rank });
      });
      return;
    }

    const profMatch = /^\/api\/profile\/([^/]{1,32})$/.exec(path);
    if (profMatch && method === 'GET') {
      const rec = store.getProfile(decodeURIComponent(profMatch[1]));
      if (!rec) { sendJson(res, 404, { error: 'not found' }); return; }
      sendJson(res, 200, rec);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  }
}
