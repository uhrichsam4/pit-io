/**
 * MIAMI DEVOUR — server-side state that outlives a single socket.
 *
 * Two things live here:
 *
 *   ROOMS       A registry of room *descriptors*, which is not the same thing
 *               as the live WebSocket rooms in server.js. A private lobby is
 *               created over REST and handed to a player as a 6-character code
 *               long before anybody opens a socket for it, so the descriptor
 *               has to exist while `live` is still null. server.js binds and
 *               unbinds the live room as sockets come and go.
 *
 *   LEADERBOARD A tiny JSON table persisted beside the server.
 *
 * EVERYTHING A CLIENT SENDS IS HOSTILE UNTIL SANITISED. The leaderboard is
 * rendered into other players' HTML, so a name is stripped of control and
 * bidi characters and clamped by code point, every number is checked for
 * finiteness before it is stored, and the same sanitiser runs again on load —
 * a file written by an older build, or edited by hand, must not be able to
 * inject anything either.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Roster cap. server.js imports this so the REST `max` and the WS refusal agree. */
export const MAX_PLAYERS = 12;

/** A reserved-but-never-joined lobby is garbage after this long. Ten minutes is
 *  long enough to text a friend a code and short enough that the browser does
 *  not fill with ghosts. */
const ROOM_TTL_MS = 10 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 1500;
const MAX_ENTRIES = 5000;
const MAX_NAME = 16;

/** Unambiguous and speakable — this is read aloud down a phone. Matches the
 *  alphabet profile.js uses for player ids, so a player's own code is a legal
 *  room code. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Mirrors the ids in src/gameplay/modes.js. Duplicated rather than imported
 *  because that module pulls in the renderer's palette, and the server has no
 *  business loading three.js to validate a string. */
const KNOWN_MODES = new Set([
  'classic', 'car-crunch', 'crowd-control', 'building-rush',
  'last-hole', 'team-devour', 'neon-nights', 'rush-hour',
]);

/* ------------------------------------------------------------ sanitisers --- */

/* Control characters, zero-width joiners and the bidi overrides. The last group
   matters more than it looks: a name containing U+202E renders right-to-left
   from that point on and can visually rewrite the rows around it. */
const NASTY = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * Coerce to a string WITHOUT invoking user-controlled conversion.
 *
 * `String(x)` and `Number(x)` both run ToPrimitive, and a JSON body is allowed
 * to contain `{"name": {"toString": "x"}}` — an object whose toString is not
 * callable. Converting that throws "Cannot convert object to primitive value",
 * and thrown from inside the request handler it took the whole server down,
 * live matches and all. A name is a string or it is nothing.
 */
function asPrimitiveString(s) {
  if (s == null) return '';
  const t = typeof s;
  if (t === 'string') return s;
  if (t === 'number' || t === 'boolean') return String(s);
  return '';
}

/** Clamp by CODE POINT, so slicing never leaves a lone surrogate behind. */
export function cleanText(s, max = MAX_NAME) {
  const t = asPrimitiveString(s).replace(NASTY, '').trim();
  const cps = Array.from(t);
  return (cps.length > max ? cps.slice(0, max).join('') : t).trim();
}

export function cleanNum(n, { min = 0, max = 1e12, def = 0 } = {}) {
  // Same hazard as above: Number({toString:'x'}) throws rather than returning
  // NaN, so anything that is not already a number gets one safe conversion.
  const t = typeof n;
  const v = t === 'number' ? n : (t === 'string' || t === 'boolean' ? Number(n) : NaN);
  if (!Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, Math.round(v * 1000) / 1000));
}

/** Player / room identifiers: uppercase, alphanumeric, short. */
export function cleanCode(s, max = 12) {
  return asPrimitiveString(s).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, max);
}

/**
 * Cosmetic ids ('hole-01', 'plate-neon'). Strict, because unlike a display
 * name these end up in class names and attribute values on other players'
 * screens, where a stray quote is all an injection needs.
 */
export function cleanSlug(s, max = 24) {
  return asPrimitiveString(s).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, max);
}

export function cleanMode(s) {
  const m = cleanSlug(s, 24);
  return KNOWN_MODES.has(m) ? m : 'classic';
}

/** Room names come off the WebSocket query string and can be anything. */
function cleanRoomName(s) {
  return asPrimitiveString(s).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'miami';
}

function randomCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

/**
 * ISO-8601 week key, e.g. "2026-W31". Weeks belong to the year containing their
 * Thursday, which is why this shifts to Thursday before counting.
 */
export function isoWeekKey(date = new Date()) {
  const t = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = t.getUTCDay() || 7;              // Monday = 1 … Sunday = 7
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/* ---------------------------------------------------------------- record --- */

const METRICS = ['totalScore', 'bestScore', 'biggestHole', 'wins', 'matches'];

/** Take a client-supplied public record down to exactly the fields we store. */
function cleanRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = cleanCode(raw.id, 12);
  if (id.length < 4) return null;
  return {
    id,
    name: cleanText(raw.name, MAX_NAME) || 'Player',
    icon: cleanSlug(raw.icon) || 'hole-01',
    nameplate: cleanSlug(raw.nameplate) || 'plate-default',
    level: cleanNum(raw.level, { min: 1, max: 9999, def: 1 }),
    totalScore: cleanNum(raw.totalScore, { max: 1e11 }),
    bestScore: cleanNum(raw.bestScore, { max: 1e9 }),
    biggestHole: cleanNum(raw.biggestHole, { max: 1e5 }),
    wins: cleanNum(raw.wins, { max: 1e6 }),
    matches: cleanNum(raw.matches, { max: 1e6 }),
    updated: Date.now(),
  };
}

/* ----------------------------------------------------------------- store --- */

export function createStore({ dir = join(__dirname, '.data') } = {}) {
  const file = join(dir, 'leaderboard.json');

  /** @type {Map<string, any>} descriptor by room name */
  const byName = new Map();
  /** @type {Map<string, any>} descriptor by invite code */
  const byCode = new Map();

  let db = { version: 1, updated: 0, players: {}, week: { key: isoWeekKey(), players: {} } };
  let saveTimer = null;

  /* ------------------------------------------------------------ storage --- */

  function ensureDir() {
    try {
      mkdirSync(dir, { recursive: true });
      // Keeps a working directory out of `git status` without touching the
      // repository-root .gitignore, which belongs to somebody else.
      const gi = join(dir, '.gitignore');
      if (!existsSync(gi)) writeFileSync(gi, '*\n');
    } catch { /* read-only deployment: the board is simply in-memory */ }
  }

  function load() {
    if (!existsSync(file)) return;
    let parsed = null;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      // A half-written or hand-edited file must never take the server down on
      // boot. Move it aside so it can be inspected, and start clean.
      try { renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* best effort */ }
      console.warn('[store] leaderboard file unreadable, starting fresh:', e.message);
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;

    // Re-sanitise on the way in. Trusting our own file is how a bad record
    // written by an older build survives forever.
    const players = {};
    for (const raw of Object.values(parsed.players || {})) {
      const rec = cleanRecord(raw);
      if (rec) {
        rec.updated = cleanNum(raw.updated, { max: 1e15, def: Date.now() });
        players[rec.id] = rec;
      }
    }
    const wk = parsed.week && typeof parsed.week === 'object' ? parsed.week : {};
    const weekPlayers = {};
    if (wk.key === isoWeekKey()) {
      for (const [id, v] of Object.entries(wk.players || {})) {
        const pid = cleanCode(id, 12);
        if (!pid || !v || typeof v !== 'object') continue;
        const base = {};
        for (const m of METRICS) base[m] = cleanNum(v.base ? v.base[m] : 0);
        weekPlayers[pid] = { base, at: cleanNum(v.at, { max: 1e15, def: Date.now() }) };
      }
    }
    db = {
      version: 1,
      updated: cleanNum(parsed.updated, { max: 1e15, def: Date.now() }),
      players,
      week: { key: isoWeekKey(), players: weekPlayers },
    };
  }

  /** Write temp + rename: a reader either sees the old file or the new one. */
  function writeNow() {
    ensureDir();
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(db));
      renameSync(tmp, file);
    } catch (e) {
      console.warn('[store] could not persist leaderboard:', e.message);
    }
  }

  function scheduleSave() {
    db.updated = Date.now();
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; prune(); writeNow(); }, SAVE_DEBOUNCE_MS);
    if (saveTimer.unref) saveTimer.unref();
  }

  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    prune();
    writeNow();
  }

  /** Bound the file. Keeping the top scorers is the only pruning that reads
   *  as fair to the people who get dropped. */
  function prune() {
    const ids = Object.keys(db.players);
    if (ids.length <= MAX_ENTRIES) return;
    const keep = ids
      .sort((a, b) => db.players[b].totalScore - db.players[a].totalScore)
      .slice(0, MAX_ENTRIES);
    const kept = {};
    for (const id of keep) kept[id] = db.players[id];
    db.players = kept;
    for (const id of Object.keys(db.week.players)) {
      if (!kept[id]) delete db.week.players[id];
    }
  }

  /** The weekly table is keyed on the ISO week; a new key empties it. */
  function rollWeek() {
    const key = isoWeekKey();
    if (db.week.key === key) return;
    db.week = { key, players: {} };
    scheduleSave();
  }

  /* -------------------------------------------------------------- rooms --- */

  function freeCode(preferred) {
    const want = cleanCode(preferred, 6);
    if (want.length === 6 && !byCode.has(want) && !byName.has(want)) return want;
    let code = randomCode();
    let guard = 0;
    while ((byCode.has(code) || byName.has(code)) && guard++ < 64) code = randomCode();
    return code;
  }

  function makeDescriptor({ name, code, mode, isPrivate }) {
    const desc = {
      name,
      code,
      mode: cleanMode(mode),
      private: !!isPrivate,
      createdAt: Date.now(),
      lastActive: Date.now(),
      live: null,
    };
    byName.set(desc.name, desc);
    byCode.set(desc.code, desc);
    return desc;
  }

  /** Reserve a room over REST. The live WS room appears when someone connects. */
  function createRoom({ mode, private: isPrivate, code } = {}) {
    const c = freeCode(code);
    // Name and code are the same string on purpose: the client joins the game
    // with ?room=<code>, so a player who reads out their code has told their
    // friend everything needed to get into the same match.
    return makeDescriptor({ name: c, code: c, mode, isPrivate });
  }

  /** Called by the WS layer for rooms conjured straight from ?room=<name>. */
  function ensureRoom(rawName, opts = {}) {
    const name = cleanRoomName(rawName);
    const existing = byName.get(name);
    if (existing) return existing;
    const code = /^[A-Z0-9]{6}$/.test(name) ? name : freeCode();
    return makeDescriptor({
      name, code, mode: opts.mode, isPrivate: !!opts.private,
    });
  }

  function attachLive(rawName, live) {
    const desc = ensureRoom(rawName);
    desc.live = live;
    desc.lastActive = Date.now();
    return desc;
  }

  function detachLive(rawName) {
    const desc = byName.get(cleanRoomName(rawName));
    if (!desc) return;
    desc.live = null;
    desc.lastActive = Date.now();
  }

  function view(desc) {
    const live = desc.live;
    const players = live ? live.clients.size : 0;
    return {
      name: desc.name,
      code: desc.code,
      mode: desc.mode,
      players,
      max: MAX_PLAYERS,
      // A reserved lobby nobody has opened a socket for yet is 'waiting'; the
      // live phases come straight off the room.
      phase: live ? live.phase : 'waiting',
      timeLeft: live ? Math.max(0, Math.round(live.timeLeft)) : 0,
      private: desc.private,
    };
  }

  function listRooms() {
    sweepRooms();
    const out = [];
    for (const desc of byName.values()) {
      if (desc.private) continue;               // invite-only never appears here
      out.push(view(desc));
    }
    out.sort((a, b) => b.players - a.players || a.code.localeCompare(b.code));
    return out;
  }

  /** Lookup accepts either the invite code or the raw room name. */
  function findRoom(needle) {
    const code = cleanCode(needle, 24);
    const desc = byCode.get(code)
      || byName.get(cleanRoomName(needle))
      || byName.get(code);
    return desc ? view(desc) : null;
  }

  function sweepRooms() {
    const now = Date.now();
    for (const desc of [...byName.values()]) {
      if (desc.live && desc.live.clients.size > 0) { desc.lastActive = now; continue; }
      if (now - desc.lastActive > ROOM_TTL_MS) {
        byName.delete(desc.name);
        byCode.delete(desc.code);
      }
    }
  }

  /* -------------------------------------------------------- leaderboard --- */

  /**
   * Merge a client's public record.
   *
   * Lifetime stats only ever go up, so we keep the maximum rather than the
   * latest: a client that reconnects with a stale or zeroed profile must not be
   * able to wipe its own board entry, and neither must anybody spoofing an id.
   */
  function submitProfile(raw) {
    rollWeek();
    const rec = cleanRecord(raw);
    if (!rec) return null;

    const prev = db.players[rec.id];
    if (prev) {
      for (const m of METRICS) rec[m] = Math.max(prev[m] || 0, rec[m]);
      rec.level = Math.max(prev.level || 1, rec.level);
    }
    db.players[rec.id] = rec;

    // First submission of the week snapshots the baseline; from then on the
    // weekly table shows what has been earned since.
    const w = db.week.players[rec.id];
    if (!w) {
      const base = {};
      for (const m of METRICS) base[m] = rec[m];
      db.week.players[rec.id] = { base, at: Date.now() };
    } else {
      // A profile reset (or a fresh device on the same id) would otherwise make
      // every weekly delta negative forever.
      for (const m of METRICS) if (rec[m] < w.base[m]) w.base[m] = rec[m];
      w.at = Date.now();
    }

    scheduleSave();
    return {
      record: rec,
      rank: {
        global: rankOf(rec.id, 'global', 'totalScore'),
        weekly: rankOf(rec.id, 'weekly', 'totalScore'),
      },
    };
  }

  function getProfile(id) {
    return db.players[cleanCode(id, 12)] || null;
  }

  /**
   * Weekly rows are deltas for the cumulative metrics and lifetime values for
   * the peak ones. The client only ever reports lifetime totals, so "best score
   * this week" is not derivable; what IS honest is that only players who have
   * played this week appear at all, and that their totals/wins/matches count
   * only this week's play.
   */
  function weeklyRow(rec) {
    const w = db.week.players[rec.id];
    if (!w) return null;
    return {
      ...rec,
      totalScore: Math.max(0, rec.totalScore - w.base.totalScore),
      wins: Math.max(0, rec.wins - w.base.wins),
      matches: Math.max(0, rec.matches - w.base.matches),
      bestScore: rec.bestScore,
      biggestHole: rec.biggestHole,
    };
  }

  /**
   * A leaderboard row has to be EARNED by finishing a match.
   *
   * Every client posts its profile on boot, so without this the board fills with
   * people who have played nothing: eighteen rows arrived during development and
   * a dozen of them were "Player · 0 · 0", which makes a live board look broken
   * and pads the real players down the list. Ranking is also meaningless for
   * them — a hundred accounts tied on zero sort by id.
   */
  const hasPlayed = (r) => (r.matches || 0) > 0;

  function tableFor(board) {
    rollWeek();
    const all = Object.values(db.players).filter(hasPlayed);
    if (board !== 'weekly') return all.slice();
    const out = [];
    for (const rec of all) {
      const row = weeklyRow(rec);
      if (row && hasPlayed(row)) out.push(row);
    }
    return out;
  }

  function sortBy(rows, metric) {
    const m = METRICS.includes(metric) ? metric : 'totalScore';
    return rows.sort((a, b) => (b[m] - a[m]) || (b.totalScore - a.totalScore) || a.id.localeCompare(b.id));
  }

  function rankOf(id, board, metric) {
    const rows = sortBy(tableFor(board), metric);
    const i = rows.findIndex((r) => r.id === id);
    return i < 0 ? null : i + 1;
  }

  function leaderboard({ board = 'global', metric = 'totalScore', limit = 100 } = {}) {
    const b = board === 'weekly' ? 'weekly' : 'global';
    const m = METRICS.includes(metric) ? metric : 'totalScore';
    const lim = Math.min(200, Math.max(1, Math.round(Number(limit) || 100)));
    const rows = sortBy(tableFor(b), m).slice(0, lim);
    return {
      board: b,
      metric: m,
      updated: db.updated,
      entries: rows.map((r, i) => ({ rank: i + 1, ...r })),
    };
  }

  /* ---------------------------------------------------------- lifecycle --- */

  ensureDir();
  load();

  const sweeper = setInterval(() => { sweepRooms(); rollWeek(); }, 60000);
  if (sweeper.unref) sweeper.unref();

  return {
    MAX_PLAYERS,
    createRoom, ensureRoom, attachLive, detachLive,
    listRooms, findRoom, roomView: view,
    submitProfile, getProfile, leaderboard, rankOf,
    flush,
    dispose() { clearInterval(sweeper); flush(); },
    /** Test hook — the REST layer never touches the raw table. */
    _db: () => db,
  };
}
