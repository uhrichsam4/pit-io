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
import { createReadStream, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BODY = 16 * 1024;
const RATE_WINDOW_MS = 60000;
const RATE_LIMIT = 90;          // writes per IP per window

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '600',
  // Private Network Access. The normal setup for this game is a page on
  // localhost:5173 calling a server on localhost:8787, and Chrome treats a
  // request that lands on a loopback or LAN address as a private-network
  // request: it forces a preflight and refuses unless the target opts in.
  // Without these two the browser reports a bare "Failed to fetch" and the
  // whole meta layer looks like it was never wired up. The second header is
  // the newer Local Network Access spelling of the same opt-in.
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Allow-Local-Network-Access': 'true',
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

/**
 * Resolves to the body text, to `null` if the request died, or to `undefined`
 * to mean "over the limit, already answered, do not touch the response".
 */
function readBody(req, res) {
  return new Promise((resolve) => {
    let size = 0;
    let answered = false;
    const chunks = [];
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        chunks.length = 0;
        answered = true;
        // Settle BEFORE destroying. destroy() can emit 'error' synchronously,
        // and that handler would otherwise win the race and resolve with null —
        // sending the caller down the "bad body" path, which writes a second
        // set of headers onto a response that is already finished.
        finish(undefined);
        // Answer before hanging up: a bare connection reset is indistinguishable
        // from the server being down, which is the one thing this client treats
        // as "go offline".
        try { sendJson(res, 413, { error: 'body too large' }); } catch { /* gone */ }
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => finish(answered ? undefined : null));
    req.on('aborted', () => finish(answered ? undefined : null));
  });
}

/**
 * Body handlers run in a promise, so a throw inside one is an UNHANDLED
 * REJECTION — which, on modern Node, terminates the process and every match on
 * it. One malformed POST must cost that request and nothing else.
 */
function guard(res, method, path, promise) {
  promise.catch((e) => {
    console.warn('[http]', method, path, e && e.message);
    try { sendJson(res, 500, { error: 'server error' }); } catch { /* already sent */ }
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
/** Where the built client lives, relative to this file. */
const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Serve a file out of dist/. Returns false if there is nothing to serve, so the
 * caller can fall through to its own 404.
 *
 * Path traversal is the whole risk here: this is the one place the server turns
 * a string from the network into a filesystem read. resolve() the joined path
 * and require it to still be inside DIST — `/../../etc/passwd` normalises out
 * of the directory and is rejected rather than read.
 */
function serveStatic(req, res, path) {
  let rel = path === '/' ? '/index.html' : path;
  try { rel = decodeURIComponent(rel); } catch { return false; }
  const file = resolve(join(DIST, rel));
  if (file !== resolve(DIST) && !file.startsWith(resolve(DIST) + sep)) return false;

  let st;
  try { st = statSync(file); } catch { return false; }
  if (st.isDirectory()) return false;

  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
  // Vite fingerprints every asset filename, so those are immutable; index.html
  // is the one file that must never be cached or players get a stale bundle
  // pointing at hashes that no longer exist.
  const cache = /\/assets\//.test(rel)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
  res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'cache-control': cache });
  if ((req.method || 'GET').toUpperCase() === 'HEAD') { res.end(); return true; }
  createReadStream(file).pipe(res);
  return true;
}

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

    // Anything that is not the API is the GAME.
    //
    // One service, not two. A hosting platform gives you a single port, and
    // splitting the client onto a static host and the socket onto another
    // origin means CORS, a second URL to keep in sync, and a `?server=` query
    // param the player has to be told about. Serving the built client from the
    // same process makes the deployed game one link you can send someone, and
    // the WebSocket lives at that same origin for free.
    //
    // If dist/ has not been built this falls through to the old JSON banner, so
    // running the server alone for local development behaves exactly as before.
    if (!path.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      if (serveStatic(req, res, path)) return;
      if (path === '/') {
        sendJson(res, 200, {
          name: 'miami-devour room server',
          version,
          note: 'no dist/ build found — run `npm run build` to serve the game from here',
          api: ['/api/health', '/api/rooms', '/api/rooms/:code', '/api/leaderboard', '/api/profile/:id'],
        });
        return;
      }
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
      guard(res, method, path, readBody(req, res).then((text) => {
        if (text === undefined) return;     // oversized; already answered 413
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
      }));
      return;
    }

    const roomMatch = /^\/api\/rooms\/([^/]{1,32})$/.exec(path);
    if (roomMatch && method === 'GET') {
      const room = store.findRoom(decodeURIComponent(roomMatch[1]));
      // ?soft=1 answers 200 { room: null } instead of 404. The friends list
      // polls a handful of codes every few seconds and most of them are not
      // live lobbies; a 404 is the correct answer but the browser prints a red
      // line in the console for every one, which buries real errors. The plain
      // form keeps the documented 404 for anyone coding against the contract.
      if (!room) {
        if (url.searchParams.get('soft')) sendJson(res, 200, { room: null });
        else sendJson(res, 404, { error: 'not found' });
        return;
      }
      sendJson(res, 200, url.searchParams.get('soft') ? { room } : room);
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
      guard(res, method, path, readBody(req, res).then((text) => {
        if (text === undefined) return;     // oversized; already answered 413
        const body = parseJson(text);
        const result = body && store.submitProfile(body);
        if (!result) { sendJson(res, 400, { error: 'bad profile' }); return; }
        sendJson(res, 200, { ok: true, rank: result.rank });
      }));
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
