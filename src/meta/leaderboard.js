/**
 * Leaderboards — the board model, the metric definitions, and the cache.
 *
 * HONESTY IS THE WHOLE DESIGN HERE. A board is either real data from a room
 * server, or it is the player's own history clearly labelled as local. There is
 * no third option: this module never invents an opponent, never pads a short
 * board with plausible-looking names, and never shows a lifetime number under a
 * heading that implies it is weekly without saying so. A fake rival on a
 * leaderboard is a lie the player cannot detect, which makes every real number
 * next to it worthless.
 *
 * The server surface lives in src/net/matchmaking.js (fetchLeaderboard /
 * submitProfile). It is written by another module and may not exist at all in a
 * local checkout, so every call into it is a lazy import inside a try/catch and
 * every failure path lands on the local board rather than on an error screen.
 */

import { profile } from './profile.js';
import { shortNum } from '../ui/shell.js';

/** Board ids, in tab order. */
export const BOARDS = ['global', 'weekly', 'friends'];

export const BOARD_LABELS = {
  global: 'Global',
  weekly: 'Weekly',
  friends: 'Friends',
};

/** Grouped digits rather than compact form — 1,240 wins reads better than 1.2k. */
function grouped(v) {
  return Math.round(Number(v) || 0).toLocaleString('en-US');
}

/**
 * The five things a board can rank by. `short` is the tab label on a 360 px
 * phone, where "Biggest hole" simply does not fit five across.
 */
export const METRICS = [
  { id: 'totalScore', label: 'Total score', short: 'Total', unit: '', fmt: (v) => shortNum(v) },
  { id: 'bestScore', label: 'Best match', short: 'Best', unit: '', fmt: (v) => shortNum(v) },
  { id: 'biggestHole', label: 'Biggest hole', short: 'Hole', unit: 'm', fmt: (v) => `${(Number(v) || 0).toFixed(1)} m` },
  { id: 'wins', label: 'Wins', short: 'Wins', unit: '', fmt: (v) => grouped(v) },
  { id: 'matches', label: 'Matches', short: 'Played', unit: '', fmt: (v) => grouped(v) },
];

export function getMetric(id) {
  return METRICS.find((m) => m.id === id) || METRICS[0];
}

/** Format a value for a metric, with "—" for "we genuinely do not know". */
export function formatMetric(value, metricId) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return getMetric(metricId).fmt(Number(value));
}

/* ============================================================ rank badge === */

/**
 * Career tiers. Thresholds are calibrated against the real economy: a full
 * city is ~527k score (see TIER in src/config.js), so a good match is tens of
 * thousands and a career is millions. Bronze must be leavable in an evening
 * and Diamond must take a season.
 */
export const RANK_TIERS = [
  { tier: 'bronze', label: 'Bronze', color: '#c9803f', min: 0 },
  { tier: 'silver', label: 'Silver', color: '#cfd8e6', min: 800 },
  { tier: 'gold', label: 'Gold', color: '#ffc93c', min: 3000 },
  { tier: 'platinum', label: 'Platinum', color: '#37e6d5', min: 9000 },
  { tier: 'diamond', label: 'Diamond', color: '#ff3d8b', min: 25000 },
];

/** Career points from lifetime play. Wins dominate, volume still counts. */
export function ratingOf(rec) {
  if (!rec) return 0;
  const wins = Number(rec.wins) || 0;
  const total = Number(rec.totalScore) || 0;
  const matches = Number(rec.matches) || 0;
  return Math.max(0, Math.round(wins * 250 + total / 500 + matches * 25));
}

/**
 * The badge for a player.
 *
 * Takes either a record ({ wins, totalScore, matches } — a leaderboard entry or
 * profile.publicRecord()) or a raw rating number, because callers have one or
 * the other and neither should have to know the formula.
 *
 * @returns {{tier:string,label:string,color:string,rating:number,next:object|null,progress:number}}
 */
export function rankBadge(rank) {
  const rating = typeof rank === 'number' ? Math.max(0, rank) : ratingOf(rank);
  let idx = 0;
  for (let i = 0; i < RANK_TIERS.length; i++) if (rating >= RANK_TIERS[i].min) idx = i;
  const t = RANK_TIERS[idx];
  const next = RANK_TIERS[idx + 1] || null;
  const span = next ? next.min - t.min : 1;
  return {
    tier: t.tier,
    label: t.label,
    color: t.color,
    rating,
    next,
    progress: next ? Math.min(1, (rating - t.min) / span) : 1,
  };
}

/* ================================================================= local === */

function statValue(stats, metricId) {
  const v = stats ? stats[metricId] : 0;
  return Number.isFinite(Number(v)) ? Number(v) : 0;
}

function meEntry(metricId) {
  const d = profile.data;
  return {
    id: d.id,
    name: d.name || 'Player',
    icon: d.icon,
    level: d.level,
    wins: d.stats.wins,
    matches: d.stats.matches,
    totalScore: d.stats.totalScore,
    bestScore: d.stats.bestScore,
    biggestHole: d.stats.biggestHole,
    value: statValue(d.stats, metricId),
    isMe: true,
  };
}

/**
 * A friend entry from whatever the friends list happens to hold. Friends are
 * stored as codes; if some other module has cached a friend's public record we
 * use its numbers, and if it has not we say so with `unknown` rather than
 * guessing a score for them.
 */
function friendEntry(f, metricId) {
  if (typeof f === 'string') {
    if (!f.trim()) return null;
    return { id: f, name: f, unknown: true, value: null };
  }
  if (!f || typeof f !== 'object') return null;
  const id = f.id || f.code || f.friendCode;
  if (!id) return null;
  const raw = f[metricId] != null ? f[metricId] : (f.stats ? f.stats[metricId] : null);
  const value = Number.isFinite(Number(raw)) ? Number(raw) : null;
  return {
    id,
    name: f.name || id,
    icon: f.icon,
    level: f.level,
    wins: Number(f.wins) || (f.stats ? Number(f.stats.wins) : 0) || 0,
    matches: Number(f.matches) || (f.stats ? Number(f.stats.matches) : 0) || 0,
    totalScore: Number(f.totalScore) || (f.stats ? Number(f.stats.totalScore) : 0) || 0,
    value,
    unknown: value == null,
  };
}

/** Rank the scored entries 1..n; anyone we have no number for keeps rank null. */
function rankEntries(list) {
  const scored = list.filter((e) => Number.isFinite(Number(e.value)));
  const unknown = list.filter((e) => !Number.isFinite(Number(e.value)));
  scored.sort((a, b) => (b.value - a.value) || String(a.name).localeCompare(String(b.name)));
  scored.forEach((e, i) => { e.rank = i + 1; });
  unknown.forEach((e) => { e.rank = null; });
  return scored.concat(unknown);
}

/** Every friend we know about locally, scored where we have numbers for them. */
function friendList(metricId) {
  return (profile.data.friends || [])
    .map((f) => friendEntry(f, metricId))
    .filter(Boolean);
}

/**
 * The board we can build with no server at all: the player, plus any friends
 * they have added. Nothing else. Callers must label the result as local.
 */
export function localBoard(metric = 'totalScore') {
  const m = getMetric(metric).id;
  return rankEntries([meEntry(m), ...friendList(m)]);
}

/* ================================================================ server === */

const MAX_ROWS = 200;

function toEntry(r, metricId, meId) {
  if (!r || typeof r !== 'object') return null;
  const id = r.id || r.playerId || r.code || null;
  const raw = r[metricId] != null ? r[metricId]
    : (r.value != null ? r.value : (r.stats ? r.stats[metricId] : null));
  const value = Number.isFinite(Number(raw)) ? Number(raw) : null;
  if (value == null) return null;               // a row with no number is not a row
  return {
    id,
    name: String(r.name || r.player || 'Player').slice(0, 24),
    icon: r.icon,
    level: Number(r.level) || 1,
    wins: Number(r.wins) || 0,
    matches: Number(r.matches) || 0,
    totalScore: Number(r.totalScore) || 0,
    value,
    isMe: !!(id && meId && id === meId),
  };
}

/** Accept any of the shapes a REST board might reasonably come back as. */
function listOf(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return null;
  for (const k of ['entries', 'rows', 'leaderboard', 'players', 'results', 'data']) {
    if (Array.isArray(raw[k])) return raw[k];
  }
  return null;
}

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('leaderboard request timed out')), ms);
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/* ================================================================= cache === */

const CACHE_MS = 60_000;
const NET_TIMEOUT_MS = 6000;

/** key -> { at:number, result:object } */
const cache = new Map();
/** key -> Promise, so three tab taps in a second are one request. */
const inflight = new Map();

export function clearCache() { cache.clear(); }

/**
 * Fetch a board.
 *
 * @param {{board?:string, metric?:string, force?:boolean}} opts
 * @returns {Promise<{board:string, metric:string, entries:object[],
 *   source:'server'|'local', updated:number, note:string, error:string|null,
 *   me:object|null}>}
 */
export async function load({ board = 'global', metric = 'totalScore', force = false } = {}) {
  const b = BOARDS.includes(board) ? board : 'global';
  const m = getMetric(metric).id;
  const key = `${b}:${m}`;

  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  if (inflight.has(key)) return inflight.get(key);

  const run = (async () => {
    const meId = profile.data.id;
    let entries = null;
    let source = 'local';
    let error = null;
    let note = '';

    try {
      const mod = await import('../net/matchmaking.js');
      if (mod && typeof mod.fetchLeaderboard === 'function') {
        // `ids` lets a server that understands friend boards answer one
        // directly; a server that ignores it is handled by the filter below.
        const req = { board: b, metric: m };
        if (b === 'friends') req.ids = [profile.data.id, ...friendList(m).map((f) => f.id)];
        const raw = await withTimeout(mod.fetchLeaderboard(req), NET_TIMEOUT_MS);
        const list = listOf(raw);
        if (raw == null) {
          // The documented contract: a failed call resolves to null rather
          // than throwing, so this is the ordinary "playing offline" path.
          error = 'no server answered';
        } else if (list) {
          entries = rankEntries(
            list.slice(0, MAX_ROWS).map((r) => toEntry(r, m, meId)).filter(Boolean),
          );
          source = 'server';
        } else {
          error = 'server sent an unreadable board';
        }
      } else {
        error = 'no matchmaking service';
      }
    } catch (e) {
      // Absent module, offline, CORS, timeout — all the same to the player.
      error = e && e.message ? e.message : String(e);
    }

    if (source === 'server' && b === 'friends') {
      // The documented REST surface has no friends board, so a server that
      // ignores `ids` hands back everyone. Showing that under a "Friends" tab
      // would be a lie, so the list is narrowed here to people the player
      // actually added, and friends the server has never seen are appended
      // with no number rather than dropped.
      const allow = new Set([profile.data.id, ...friendList(m).map((f) => f.id)]);
      const rows = entries.filter((e) => e.id && allow.has(e.id));
      const seen = new Set(rows.map((e) => e.id));
      for (const f of friendList(m)) if (!seen.has(f.id)) rows.push({ ...f, value: null, unknown: true });
      entries = rankEntries(rows);
    }

    if (source !== 'server') {
      const all = localBoard(m);
      // A friend we have no numbers for belongs on the friends board (so the
      // player sees who they added) but not on a score ranking.
      entries = b === 'friends' ? all : all.filter((e) => !e.unknown);
      if (b === 'weekly') note = 'Local history has no weekly split — these are lifetime totals.';
    }

    const me = entries.find((e) => e.isMe) || null;
    const result = {
      board: b, metric: m, entries, source, updated: Date.now(), note, error, me,
    };
    cache.set(key, { at: Date.now(), result });
    return result;
  })();

  inflight.set(key, run);
  try { return await run; } finally { inflight.delete(key); }
}

/**
 * Push our public record so the server board has us on it. Silent by design:
 * this fires on entering the leaderboard and nobody wants a toast telling them
 * a service they never asked about is unreachable.
 *
 * @returns {Promise<boolean>} true only if a submit actually went through.
 */
export async function push() {
  try {
    const mod = await import('../net/matchmaking.js');
    if (!mod || typeof mod.submitProfile !== 'function') return false;
    await withTimeout(mod.submitProfile(profile.publicRecord()), NET_TIMEOUT_MS);
    clearCache();                                 // our own row just changed
    return true;
  } catch {
    return false;
  }
}
