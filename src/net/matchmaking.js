/**
 * Matchmaking — the client half of the REST surface in server/http.js.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: **offline is the default state of this
 * game, and the UI must be completely silent about it.** Somebody opening the
 * page on a laptop with no room server running is the normal case, not an error
 * case. So every call here:
 *
 *   - has a hard 3 s timeout,
 *   - resolves to null/false instead of throwing,
 *   - never logs,
 *   - and, once a call has failed, short-circuits subsequent calls for a
 *     backing-off window rather than making the next one wait 3 s again.
 *
 * That last part is what makes a 4-second room-browser poll survivable while
 * offline: the first poll costs a timeout, the rest cost nothing, and one probe
 * every so often is still made so the browser lights up on its own the moment a
 * server appears.
 *
 * Note on return values: functions documented as returning a list return `null`
 * — not `[]` — when the server could not be reached, because "no lobbies" and
 * "no server" are different screens and the caller has to be able to tell them
 * apart.
 */

const TIMEOUT_MS = 3000;
const BACKOFF_MIN = 4000;
const BACKOFF_MAX = 30000;

/** Room codes are read out loud, so the alphabet drops I/O/0/1. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

/* ---------------------------------------------------------------- server --- */

function hostFromQuery() {
  const loc = typeof location !== 'undefined' ? location : null;
  let host = '';
  try {
    host = new URLSearchParams(loc ? loc.search : '').get('server') || '';
  } catch { host = ''; }
  // Accept ?server=host:port, ?server=http://host:port and ?server=ws://host:port
  // — people paste whichever one they happen to have in the clipboard.
  host = host.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
  if (!host) {
    const h = (loc && loc.hostname) || 'localhost';
    host = `${h}:8787`;
  }
  return host;
}

function secure() {
  return typeof location !== 'undefined' && location.protocol === 'https:';
}

/**
 * Where the room server lives. Mirrors readNetConfig() in client.js exactly —
 * the REST surface and the game socket are the same host and port.
 */
export const SERVER = {
  base() { return `${secure() ? 'https' : 'http'}://${hostFromQuery()}`; },
  ws() { return `${secure() ? 'wss' : 'ws'}://${hostFromQuery()}`; },
};

/* --------------------------------------------------------------- offline --- */

let offlineUntil = 0;
let backoff = BACKOFF_MIN;

function markOffline() {
  offlineUntil = Date.now() + backoff;
  backoff = Math.min(BACKOFF_MAX, Math.round(backoff * 1.6));
}

function markOnline() {
  offlineUntil = 0;
  backoff = BACKOFF_MIN;
}

/** True while we are inside a back-off window from a failed call. */
export function isOffline() { return Date.now() < offlineUntil; }

/**
 * @param {string} path
 * @param {{method?:string, body?:any, force?:boolean}} [opts]
 *   `force` ignores the back-off window — use it for an explicit retry the
 *   player asked for, never for a poll.
 * @returns {Promise<any|null>}
 */
async function request(path, opts = {}) {
  if (!opts.force && isOffline()) return null;
  if (typeof fetch !== 'function') return null;

  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => { if (ctl) ctl.abort(); }, TIMEOUT_MS);
  try {
    const res = await fetch(SERVER.base() + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctl ? ctl.signal : undefined,
      // The room browser must never read a cached roster.
      cache: 'no-store',
      mode: 'cors',
      credentials: 'omit',
    });
    // A 404 means the server is there and the thing is not; that is a live
    // server, so it must not start the offline back-off.
    markOnline();
    if (!res.ok) return null;
    return await res.json();
  } catch {
    markOffline();
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------- api --- */

/** @returns {Promise<boolean>} */
export async function health() {
  const j = await request('/api/health', { force: true });
  return !!(j && j.ok);
}

/**
 * Public lobbies, fullest first.
 * @returns {Promise<Array<{name:string, code:string, mode:string, players:number,
 *   max:number, phase:string, timeLeft:number, private:boolean}>|null>}
 *   null when the server is unreachable.
 */
export async function listRooms() {
  const j = await request('/api/rooms');
  if (!j || !Array.isArray(j.rooms)) return null;
  return j.rooms.filter((r) => r && typeof r === 'object');
}

/**
 * @param {{mode?:string, private?:boolean, code?:string}} opts
 *   `code` asks the server for a specific invite code (the friends flow uses
 *   the player's own profile id so "my code" and "my lobby" are one thing). The
 *   server may hand back a different one if it is taken — always use what comes
 *   back, never what you asked for.
 * @returns {Promise<{room:string, code:string, mode:string}|null>}
 */
export async function createRoom(opts = {}) {
  const j = await request('/api/rooms', {
    method: 'POST',
    body: {
      mode: opts.mode || 'classic',
      private: !!opts.private,
      code: opts.code ? normalizeCode(opts.code) : undefined,
    },
  });
  if (!j || !j.code) return null;
  return { room: j.room || j.code, code: j.code, mode: j.mode || opts.mode || 'classic' };
}

/**
 * @param {string} code
 * @returns {Promise<object|null>} the room, or null for "no such live lobby"
 *   AND for "no server" — the caller has already established which it is by
 *   whatever it is showing.
 */
export async function findRoom(code) {
  const c = normalizeCode(code);
  if (c.length < 4) return null;
  return await request(`/api/rooms/${encodeURIComponent(c)}`);
}

/**
 * Find the best lobby in this mode, or start one.
 *
 * "Best" is the FULLEST joinable room, not the emptiest: a hole-eating game
 * with two players in it is a worse match than one with nine, and spreading
 * players evenly across lobbies is how a small population ends up with nobody
 * ever meeting anybody.
 *
 * @param {string} mode
 * @returns {Promise<{room:string, code:string, mode:string, created:boolean}|null>}
 */
export async function quickMatch(mode = 'classic') {
  const rooms = await listRooms();
  if (rooms) {
    const joinable = rooms
      .filter((r) => !r.private && r.mode === mode && (r.players || 0) < (r.max || 12))
      .sort((a, b) => (b.players || 0) - (a.players || 0));
    if (joinable.length) {
      const r = joinable[0];
      return { room: r.name || r.code, code: r.code, mode: r.mode, created: false };
    }
  }
  const made = await createRoom({ mode });
  return made ? { ...made, created: true } : null;
}

/**
 * Push the player's public record for the online leaderboard.
 * @param {object} record profile.publicRecord()
 * @returns {Promise<{rank:{global:number|null, weekly:number|null}}|null>}
 */
export async function submitProfile(record) {
  if (!record || typeof record !== 'object') return null;
  const j = await request('/api/profile', { method: 'POST', body: record });
  if (!j || !j.ok) return null;
  return { rank: j.rank || { global: null, weekly: null } };
}

/**
 * @param {{board?:'global'|'weekly', metric?:string, limit?:number}} [opts]
 * @returns {Promise<{board:string, metric:string, updated:number, entries:object[]}|null>}
 */
export async function fetchLeaderboard(opts = {}) {
  const q = new URLSearchParams({
    board: opts.board === 'weekly' ? 'weekly' : 'global',
    metric: opts.metric || 'totalScore',
    limit: String(Math.min(200, Math.max(1, Math.round(opts.limit || 100)))),
  });
  const j = await request(`/api/leaderboard?${q}`);
  if (!j || !Array.isArray(j.entries)) return null;
  return j;
}

/** @param {string} id @returns {Promise<object|null>} */
export async function fetchProfile(id) {
  const c = normalizeCode(id);
  if (c.length < 4) return null;
  return await request(`/api/profile/${encodeURIComponent(c)}`);
}

/* --------------------------------------------------------------- helpers --- */

/** Fold whatever the player typed or pasted into a legal code. */
export function normalizeCode(s) {
  return String(s == null ? '' : s)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, CODE_LENGTH);
}

/** A link that drops the recipient straight into the lobby. */
export function inviteUrl(code) {
  const c = normalizeCode(code);
  if (typeof location === 'undefined') return `?room=${c}`;
  const u = new URL(location.href);
  u.search = '';
  u.hash = '';
  u.searchParams.set('room', c);
  return u.toString();
}
