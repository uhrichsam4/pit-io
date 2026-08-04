/**
 * Progression — what a player earns, and why they come back tomorrow.
 *
 * src/meta/profile.js owns the STORAGE (level, xp, coins, stats, the daily
 * slot, the streak counter, the achievement map, the season wallet). This file
 * owns the CONTENT and the RULES: which challenges exist, what an achievement
 * costs, how a season track is laid out, and exactly how a finished match turns
 * into numbers that move on the end screen.
 *
 * WHO FEEDS WHAT — read this before wiring anything, it is the one place a
 * double-count can creep in:
 *
 *   During a match, the consume path calls progressChallenge() for the three
 *   things the match summary cannot reconstruct:
 *       'vehicles'  'people'  'buildings'
 *
 *   At the end of a match, grantMatchRewards() derives everything else from
 *   the summary itself:
 *       'devour'  'rivals'  'score'  'wins'  'survive'  'bigHole'
 *
 *   Do NOT also call progressChallenge('devour', 1) per swallow. The split is
 *   by construction so neither side has to know what the other did.
 *
 * Every number here is tuned against a ~150 s match paying 120–170 base XP
 * (see MODES[].rewards): a daily set is roughly two to four matches of work,
 * a season track is a season of casual play, and the achievement ladder runs
 * from "you finished your first match" to "you have played this for months".
 */

import { profile, xpForLevel } from './profile.js';
import { MODES, rewardFor } from '../gameplay/modes.js';
import { makeRNG } from '../core/rng.js';

/* ========================================================================= */
/* DAY KEYS                                                                  */
/* ========================================================================= */

/**
 * MUST stay byte-identical to profile.js's private todayKey(), because
 * profile.rollDaily() compares its own key against the one stored here. A
 * zero-padded variant would look correct and silently reroll the dailies on
 * every single call.
 */
function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function dayKeyOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return dayKey(d);
}

/** Milliseconds until the dailies reroll (local midnight). */
export function msUntilReroll() {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1, 0);
  return Math.max(0, midnight - now);
}

/** Stable 32-bit hash of the day key, so the roll is the same on every device. */
function hashSeed(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* ========================================================================= */
/* CHALLENGES                                                                */
/* ========================================================================= */

/**
 * The countable events a challenge can watch.
 * `agg` on a template decides how progressChallenge folds a new value in:
 *   'sum' (default) accumulates, 'max' keeps the best single observation.
 */
export const TRACKS = {
  devour:    { label: 'Objects devoured', icon: '🕳️', unit: '' },
  score:     { label: 'Score',            icon: '⭐', unit: '' },
  vehicles:  { label: 'Vehicles',         icon: '🚗', unit: '' },
  people:    { label: 'People',           icon: '🚶', unit: '' },
  buildings: { label: 'Buildings',        icon: '🏙️', unit: '' },
  wins:      { label: 'Wins',             icon: '🏆', unit: '' },
  rivals:    { label: 'Rivals swallowed', icon: '😈', unit: '' },
  survive:   { label: 'Time played',      icon: '⏱️', unit: 's' },
  bigHole:   { label: 'Hole diameter',    icon: '📏', unit: 'm' },
};

/**
 * The template pool. rollDailies() draws three of these per day, never two on
 * the same track and never more than one that is locked to a mode — three
 * mode-locked challenges on the same day is a daily set the player cannot
 * finish without playing exactly what we told them to.
 */
export const CHALLENGES = [
  { id: 'dev-150',  text: 'Devour 150 objects',                   goal: 150,   track: 'devour',    reward: { xp: 120, coins: 40 } },
  { id: 'dev-400',  text: 'Devour 400 objects',                   goal: 400,   track: 'devour',    reward: { xp: 220, coins: 75 } },
  { id: 'dev-900',  text: 'Devour 900 objects',                   goal: 900,   track: 'devour',    reward: { xp: 360, coins: 130 } },

  { id: 'veh-40',   text: 'Swallow 40 vehicles',                  goal: 40,    track: 'vehicles',  reward: { xp: 140, coins: 50 } },
  { id: 'veh-120',  text: 'Swallow 120 vehicles',                 goal: 120,   track: 'vehicles',  reward: { xp: 260, coins: 90 } },
  { id: 'veh-crunch', text: 'Swallow 60 vehicles in Car Crunch',  goal: 60,    track: 'vehicles',  reward: { xp: 220, coins: 80 }, modes: ['car-crunch', 'rush-hour'] },

  { id: 'ppl-60',   text: 'Sweep 60 people off the sidewalk',     goal: 60,    track: 'people',    reward: { xp: 130, coins: 45 } },
  { id: 'ppl-200',  text: 'Sweep 200 people off the sidewalk',    goal: 200,   track: 'people',    reward: { xp: 250, coins: 85 } },
  { id: 'ppl-crowd', text: 'Take 120 people in Crowd Control',    goal: 120,   track: 'people',    reward: { xp: 230, coins: 85 }, modes: ['crowd-control'] },

  { id: 'bld-12',   text: 'Bring down 12 buildings',              goal: 12,    track: 'buildings', reward: { xp: 170, coins: 60 } },
  { id: 'bld-40',   text: 'Bring down 40 buildings',              goal: 40,    track: 'buildings', reward: { xp: 300, coins: 110 } },
  { id: 'bld-rush', text: 'Flatten 30 structures in Building Rush', goal: 30,  track: 'buildings', reward: { xp: 260, coins: 95 }, modes: ['building-rush'] },

  { id: 'win-1',    text: 'Win a match',                          goal: 1,     track: 'wins',      reward: { xp: 150, coins: 60 } },
  { id: 'win-3',    text: 'Win 3 matches',                        goal: 3,     track: 'wins',      reward: { xp: 320, coins: 130 } },
  { id: 'win-last', text: 'Win a round of Last Hole Standing',    goal: 1,     track: 'wins',      reward: { xp: 260, coins: 95 }, modes: ['last-hole'] },
  { id: 'win-team', text: 'Win a round of Team Devour',           goal: 1,     track: 'wins',      reward: { xp: 240, coins: 90 }, modes: ['team-devour'] },

  { id: 'riv-3',    text: 'Swallow 3 rival holes',                goal: 3,     track: 'rivals',    reward: { xp: 160, coins: 55 } },
  { id: 'riv-10',   text: 'Swallow 10 rival holes',               goal: 10,    track: 'rivals',    reward: { xp: 300, coins: 105 } },

  { id: 'sco-6k',   text: 'Score 6,000 points today',             goal: 6000,  track: 'score',     reward: { xp: 150, coins: 55 } },
  { id: 'sco-20k',  text: 'Score 20,000 points today',            goal: 20000, track: 'score',     reward: { xp: 290, coins: 100 } },
  { id: 'sco-best', text: 'Score 5,000 in a single match',        goal: 5000,  track: 'score',     reward: { xp: 200, coins: 75 }, agg: 'max' },

  { id: 'sur-600',  text: 'Spend 10 minutes in the city',         goal: 600,   track: 'survive',   reward: { xp: 140, coins: 50 } },
  { id: 'sur-1500', text: 'Spend 25 minutes in the city',         goal: 1500,  track: 'survive',   reward: { xp: 260, coins: 95 } },

  { id: 'big-30',   text: 'Grow a hole 30 m across',              goal: 30,    track: 'bigHole',   reward: { xp: 170, coins: 60 }, agg: 'max' },
  { id: 'big-55',   text: 'Grow a hole 55 m across',              goal: 55,    track: 'bigHole',   reward: { xp: 280, coins: 100 }, agg: 'max' },
  { id: 'big-80',   text: 'Grow a hole 80 m across',              goal: 80,    track: 'bigHole',   reward: { xp: 400, coins: 150 }, agg: 'max' },
];

const CHALLENGE_BY_ID = new Map(CHALLENGES.map((c) => [c.id, c]));

/**
 * Three challenges for `seedDay`, deterministic for that day. A player who
 * pulls to refresh, force-quits or opens a second tab gets the same three —
 * a rerollable daily is not a daily.
 *
 * @param {string} [seedDay] day key, defaults to today
 * @returns {Array} live challenge instances (progress/claimed included)
 */
export function rollDailies(seedDay = dayKey()) {
  const rng = makeRNG(hashSeed(`miami-daily:${seedDay}`));
  const pool = CHALLENGES.slice();
  // Fisher-Yates off the seeded stream, then take the first three that satisfy
  // the variety rules. Shuffling beats repeated rejection sampling here because
  // it cannot loop forever if the rules ever tighten.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
  }

  const picked = [];
  const usedTracks = new Set();
  let modeLocked = 0;
  for (const tpl of pool) {
    if (picked.length >= 3) break;
    if (usedTracks.has(tpl.track)) continue;
    if (tpl.modes && modeLocked >= 1) continue;
    usedTracks.add(tpl.track);
    if (tpl.modes) modeLocked++;
    picked.push(tpl);
  }
  // Belt and braces: if the variety rules ever starve the pick, top up.
  for (const tpl of pool) {
    if (picked.length >= 3) break;
    if (!picked.includes(tpl)) picked.push(tpl);
  }

  return picked.slice(0, 3).map((tpl) => ({
    id: tpl.id,
    text: tpl.text,
    goal: tpl.goal,
    track: tpl.track,
    agg: tpl.agg || 'sum',
    modes: tpl.modes || null,
    reward: { xp: tpl.reward.xp, coins: tpl.reward.coins },
    progress: 0,
    claimed: false,
  }));
}

/** Repair a challenge loaded from an older save so the UI never reads NaN. */
function normaliseChallenge(c) {
  const tpl = CHALLENGE_BY_ID.get(c && c.id);
  if (!tpl) return null;
  return {
    id: tpl.id,
    text: tpl.text,
    goal: tpl.goal,
    track: tpl.track,
    agg: tpl.agg || 'sum',
    modes: tpl.modes || null,
    reward: { xp: tpl.reward.xp, coins: tpl.reward.coins },
    progress: Math.max(0, Number(c.progress) || 0),
    claimed: !!c.claimed,
  };
}

/**
 * The three live challenges, rerolling if the local day turned over while the
 * game was open. Every read path goes through here, so a player who leaves the
 * lobby up overnight wakes up to a fresh set rather than a dead one.
 */
export function ensureDailies() {
  const rolled = profile.rollDaily(() => rollDailies(dayKey()));
  const d = profile.data.daily;

  let list = Array.isArray(d.challenges) ? d.challenges.map(normaliseChallenge).filter(Boolean) : [];
  if (rolled || list.length !== 3) {
    list = rollDailies(d.day || dayKey());
    d.challenges = list;
    profile.save();
  } else {
    d.challenges = list;
  }
  return d.challenges;
}

/** Copy of the live set, plus a derived `done` flag for the UI. */
export function challengeState() {
  return ensureDailies().map((c) => ({
    ...c,
    done: c.progress >= c.goal,
    pct: Math.max(0, Math.min(1, c.progress / Math.max(1, c.goal))),
  }));
}

/* Mode-locked challenges need to know what is being played right now. */
let _activeMode = 'classic';

/** Called at match start (and by grantMatchRewards) so `modes` filters work. */
export function setActiveMode(modeId) {
  _activeMode = (modeId && modeId.id) || modeId || 'classic';
  return _activeMode;
}

/**
 * profile.save() emits to every listener, and the shell re-renders the mounted
 * screen on each emit. progressChallenge is called from the swallow path —
 * hundreds of times a second at a big radius — so saves are coalesced. A
 * completion always flushes immediately, because that is the one moment the
 * player might quit on.
 */
const SAVE_COALESCE_MS = 2500;
let _lastSave = 0;
function touch(force) {
  const now = Date.now();
  if (force || now - _lastSave > SAVE_COALESCE_MS) {
    _lastSave = now;
    profile.save();
  }
}

/**
 * Fold one countable event into any daily watching that track.
 * @param {string} track one of TRACKS
 * @param {number} amount value to add (or to compare, for `max` challenges)
 * @returns {Array} challenges that COMPLETED on this call (usually empty)
 */
export function progressChallenge(track, amount = 1) {
  const n = Number(amount);
  if (!TRACKS[track] || !Number.isFinite(n) || n <= 0) return [];

  const list = ensureDailies();
  const completed = [];
  let changed = false;

  for (const c of list) {
    if (c.track !== track || c.claimed) continue;
    if (c.modes && !c.modes.includes(_activeMode)) continue;
    const was = c.progress >= c.goal;
    c.progress = c.agg === 'max' ? Math.max(c.progress, n) : c.progress + n;
    changed = true;
    if (!was && c.progress >= c.goal) completed.push(c);
  }

  if (changed) touch(completed.length > 0);
  return completed;
}

/**
 * Pay out a completed daily. Idempotent — a double tap on the claim button
 * must not pay twice.
 * @returns {boolean} true if this call is what granted the reward
 */
export function claimChallenge(id) {
  const c = ensureDailies().find((x) => x.id === id);
  if (!c || c.claimed || c.progress < c.goal) return false;
  c.claimed = true;

  const prog = profile.data.progression || (profile.data.progression = { challengesClaimed: 0 });
  prog.challengesClaimed = (prog.challengesClaimed || 0) + 1;

  profile.addXp(c.reward.xp);
  profile.addCoins(c.reward.coins);
  profile.save();
  checkAchievements();
  return true;
}

/* ========================================================================= */
/* ACHIEVEMENTS                                                              */
/* ========================================================================= */

/** Tier drives the colour and the grouping on the rewards screen. */
export const ACHIEVEMENT_TIERS = [
  { id: 'bronze', label: 'Bronze', color: '#d08a52' },
  { id: 'silver', label: 'Silver', color: '#c8d3e0' },
  { id: 'gold', label: 'Gold', color: '#ffc93c' },
  { id: 'legend', label: 'Legend', color: '#ff3d8b' },
];

const PAY = {
  bronze: { xp: 100, coins: 50 },
  silver: { xp: 250, coins: 150 },
  gold: { xp: 600, coins: 400 },
  legend: { xp: 1200, coins: 900 },
};

/**
 * `check(stats)` receives the snapshot built by achievementStats() — lifetime
 * stats from the profile plus the derived counts (level, streak, cosmetics
 * owned, modes won, sets completed, season tier, dailies claimed).
 */
export const ACHIEVEMENTS = [
  /* ------------------------------------------------------------- bronze -- */
  { id: 'first-win', name: 'First Blood', desc: 'Win your first match', icon: '🏆', tier: 'bronze', reward: PAY.bronze, check: (s) => s.wins >= 1 },
  { id: 'matches-10', name: 'Getting Hungry', desc: 'Play 10 matches', icon: '🎮', tier: 'bronze', reward: PAY.bronze, check: (s) => s.matches >= 10 },
  { id: 'score-1k', name: 'Small Appetite', desc: 'Score 1,000 points in total', icon: '⭐', tier: 'bronze', reward: PAY.bronze, check: (s) => s.totalScore >= 1000 },
  { id: 'objects-100', name: 'Litter Picker', desc: 'Devour 100 objects', icon: '🗑️', tier: 'bronze', reward: PAY.bronze, check: (s) => s.objectsDevoured >= 100 },
  { id: 'hole-20', name: 'Pothole', desc: 'Reach a hole 20 m across', icon: '⚫', tier: 'bronze', reward: PAY.bronze, check: (s) => s.biggestHole >= 20 },
  { id: 'rivals-5', name: 'Cannibal', desc: 'Swallow 5 rival holes', icon: '😈', tier: 'bronze', reward: PAY.bronze, check: (s) => s.rivalsEaten >= 5 },
  { id: 'level-10', name: 'Local', desc: 'Reach level 10', icon: '🔟', tier: 'bronze', reward: PAY.bronze, check: (s) => s.level >= 10 },
  { id: 'streak-3', name: 'Regular', desc: 'Play 3 days in a row', icon: '📅', tier: 'bronze', reward: PAY.bronze, check: (s) => s.bestStreak >= 3 },

  /* ------------------------------------------------------------- silver -- */
  { id: 'matches-50', name: 'Rush Hour Regular', desc: 'Play 50 matches', icon: '🎯', tier: 'silver', reward: PAY.silver, check: (s) => s.matches >= 50 },
  { id: 'score-10k', name: 'Big Eater', desc: 'Score 10,000 points in total', icon: '🌟', tier: 'silver', reward: PAY.silver, check: (s) => s.totalScore >= 10000 },
  { id: 'objects-1000', name: 'Street Sweeper', desc: 'Devour 1,000 objects', icon: '🧹', tier: 'silver', reward: PAY.silver, check: (s) => s.objectsDevoured >= 1000 },
  { id: 'hole-50', name: 'Sinkhole', desc: 'Reach a hole 50 m across', icon: '🌑', tier: 'silver', reward: PAY.silver, check: (s) => s.biggestHole >= 50 },
  { id: 'rivals-25', name: 'Apex Void', desc: 'Swallow 25 rival holes', icon: '👹', tier: 'silver', reward: PAY.silver, check: (s) => s.rivalsEaten >= 25 },
  { id: 'level-25', name: 'Brickell Native', desc: 'Reach level 25', icon: '🏙️', tier: 'silver', reward: PAY.silver, check: (s) => s.level >= 25 },
  { id: 'streak-7', name: 'Seven Day Forecast', desc: 'Play 7 days in a row', icon: '🔥', tier: 'silver', reward: PAY.silver, check: (s) => s.bestStreak >= 7 },
  { id: 'cosmetics-10', name: 'Dressed Up', desc: 'Own 10 cosmetics', icon: '🎨', tier: 'silver', reward: PAY.silver, check: (s) => s.cosmetics >= 10 },
  { id: 'podium-25', name: 'Podium Habit', desc: 'Finish top 3 in 25 matches', icon: '🥉', tier: 'silver', reward: PAY.silver, check: (s) => s.top3 >= 25 },
  { id: 'dailies-10', name: 'Chore Chart', desc: 'Claim 10 daily challenges', icon: '✅', tier: 'silver', reward: PAY.silver, check: (s) => s.challengesClaimed >= 10 },

  /* --------------------------------------------------------------- gold -- */
  { id: 'matches-250', name: 'City Fixture', desc: 'Play 250 matches', icon: '🗿', tier: 'gold', reward: PAY.gold, check: (s) => s.matches >= 250 },
  { id: 'score-100k', name: 'Insatiable', desc: 'Score 100,000 points in total', icon: '💫', tier: 'gold', reward: PAY.gold, check: (s) => s.totalScore >= 100000 },
  { id: 'objects-10000', name: 'Miami Is Gone', desc: 'Devour 10,000 objects', icon: '🌪️', tier: 'gold', reward: PAY.gold, check: (s) => s.objectsDevoured >= 10000 },
  { id: 'hole-100', name: 'Event Horizon', desc: 'Reach a hole 100 m across', icon: '🕳️', tier: 'gold', reward: PAY.gold, check: (s) => s.biggestHole >= 100 },
  { id: 'level-50', name: 'Kingpin', desc: 'Reach level 50', icon: '👑', tier: 'gold', reward: PAY.gold, check: (s) => s.level >= 50 },
  { id: 'cosmetics-25', name: 'Wardrobe', desc: 'Own 25 cosmetics', icon: '🧳', tier: 'gold', reward: PAY.gold, check: (s) => s.cosmetics >= 25 },
  { id: 'set-complete', name: 'The Full Set', desc: 'Complete a cosmetic collection', icon: '🎁', tier: 'gold', reward: PAY.gold, check: (s) => s.setsCompleted >= 1 },
  { id: 'playtime-5h', name: 'Five Hours Deep', desc: 'Play for 5 hours', icon: '⏳', tier: 'gold', reward: PAY.gold, check: (s) => s.playTimeSec >= 18000 },
  { id: 'best-10k', name: 'One Perfect Round', desc: 'Score 10,000 in a single match', icon: '💎', tier: 'gold', reward: PAY.gold, check: (s) => s.bestScore >= 10000 },

  /* ------------------------------------------------------------- legend -- */
  { id: 'mode-master', name: 'Mode Master', desc: 'Win a match in every game mode', icon: '🎖️', tier: 'legend', reward: PAY.legend, check: (s) => s.modesWon >= s.modesTotal && s.modesTotal > 0 },
  { id: 'season-max', name: 'Tide Turner', desc: 'Reach season tier 30', icon: '🌊', tier: 'legend', reward: PAY.legend, check: (s) => s.seasonTier >= 30 },
  { id: 'rivals-100', name: 'Hole Eater', desc: 'Swallow 100 rival holes', icon: '☠️', tier: 'legend', reward: PAY.legend, check: (s) => s.rivalsEaten >= 100 },
];

/**
 * Cosmetics is a SOFT dependency: it is built by another module and this file
 * must still work if it is absent. import.meta.glob resolves to an empty map
 * when the file does not exist, which is the whole reason it is used here
 * instead of a plain dynamic import — a missing module would otherwise log a
 * failed request to the console on every boot.
 */
const COSMETIC_MODULE = import.meta.glob('./cosmetics.js');
let _cosmetics = null;
let _cosmeticsTried = false;

function loadCosmetics() {
  if (_cosmeticsTried) return;
  _cosmeticsTried = true;
  const loader = COSMETIC_MODULE['./cosmetics.js'];
  if (!loader) return;
  loader().then((m) => { _cosmetics = m; }).catch(() => { /* stays null; set achievement simply cannot unlock */ });
}

/** Let the integrator inject the catalogue synchronously if it prefers. */
export function attachCosmetics(mod) { _cosmetics = mod || null; _cosmeticsTried = true; }

function countOwned() {
  const owned = profile.data.owned || {};
  let n = 0;
  for (const k of Object.keys(owned)) if (Array.isArray(owned[k])) n += owned[k].length;
  return n;
}

function countCompletedSets() {
  const sets = _cosmetics && _cosmetics.SETS;
  if (!Array.isArray(sets)) return 0;
  const owned = profile.data.owned || {};
  const flat = new Set();
  for (const k of Object.keys(owned)) for (const id of (owned[k] || [])) flat.add(id);
  let n = 0;
  for (const s of sets) {
    const ids = s && Array.isArray(s.items) ? s.items : [];
    if (ids.length && ids.every((id) => flat.has(id))) n++;
  }
  return n;
}

/** The snapshot every ACHIEVEMENTS.check() is handed. */
export function achievementStats() {
  loadCosmetics();
  const d = profile.data;
  const s = d.stats;
  const byMode = s.byMode || {};
  let modesWon = 0;
  for (const m of MODES) if ((byMode[m.id] || {}).wins > 0) modesWon++;

  return {
    matches: s.matches || 0,
    wins: s.wins || 0,
    top3: s.top3 || 0,
    totalScore: s.totalScore || 0,
    bestScore: s.bestScore || 0,
    biggestHole: s.biggestHole || 0,
    objectsDevoured: s.objectsDevoured || 0,
    rivalsEaten: s.rivalsEaten || 0,
    playTimeSec: s.playTimeSec || 0,
    byMode,
    level: d.level || 1,
    coins: d.coins || 0,
    streak: (d.streak && d.streak.days) || 0,
    bestStreak: (d.streak && d.streak.best) || 0,
    cosmetics: countOwned(),
    setsCompleted: countCompletedSets(),
    modesWon,
    modesTotal: MODES.length,
    seasonTier: seasonProgress().tier,
    challengesClaimed: (d.progression && d.progression.challengesClaimed) || 0,
  };
}

/**
 * Evaluate the whole ladder, unlock and pay out anything newly earned.
 * Safe to call as often as you like — profile.unlockAchievement() is the gate.
 * @returns {Array} the achievement definitions unlocked by THIS call
 */
export function checkAchievements() {
  const stats = achievementStats();
  const fresh = [];
  for (const a of ACHIEVEMENTS) {
    if (profile.data.achievements[a.id]) continue;
    let hit = false;
    try { hit = !!a.check(stats); } catch { hit = false; }
    if (!hit) continue;
    if (profile.unlockAchievement(a.id)) {
      profile.addXp(a.reward.xp);
      profile.addCoins(a.reward.coins);
      fresh.push(a);
    }
  }
  return fresh;
}

/** Every achievement plus its unlock state, for the rewards screen grid. */
export function achievementState() {
  const map = profile.data.achievements || {};
  return ACHIEVEMENTS.map((a) => ({
    ...a,
    unlocked: !!map[a.id],
    at: map[a.id] ? map[a.id].at : 0,
  }));
}

export function achievementCounts() {
  const map = profile.data.achievements || {};
  let unlocked = 0;
  for (const a of ACHIEVEMENTS) if (map[a.id]) unlocked++;
  return { unlocked, total: ACHIEVEMENTS.length };
}

/* ========================================================================= */
/* SEASON                                                                    */
/* ========================================================================= */

/**
 * Seasons run on a fixed 8-week cadence off a hard epoch rather than a
 * hardcoded end date. A shipped constant like `ends: '2026-09-28'` is correct
 * for six weeks and then reads as a dead game forever, which is exactly the
 * kind of rot nobody notices until a player screenshots it.
 */
const SEASON_EPOCH = Date.UTC(2026, 0, 5);   // Monday
const SEASON_MS = 56 * 864e5;                // 8 weeks

const SEASON_NAMES = [
  { name: 'Neon Tide', blurb: 'The bay is glowing and the city is on the menu.', accent: '#37e6d5' },
  { name: 'Vice Sunset', blurb: 'Pink light, long shadows, nothing left standing.', accent: '#ff3d8b' },
  { name: 'Deco Drift', blurb: 'Pastel facades, chrome trim, one very large hole.', accent: '#ffc93c' },
  { name: 'Bayfront Bloom', blurb: 'Palms, promenades and an appetite that will not quit.', accent: '#4dff9e' },
  { name: 'Hurricane Watch', blurb: 'The forecast says total structural failure.', accent: '#8b5cf6' },
  { name: 'Little Havana Heat', blurb: 'Music on every corner. Eat the corners.', accent: '#ff9430' },
];

function seasonSlot(now = Date.now()) {
  const i = Math.max(0, Math.floor((now - SEASON_EPOCH) / SEASON_MS));
  return { index: i, meta: SEASON_NAMES[i % SEASON_NAMES.length], ends: SEASON_EPOCH + (i + 1) * SEASON_MS };
}

const _slot = seasonSlot();
const _slug = _slot.meta.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/**
 * Season-exclusive cosmetics. Shaped exactly like a src/meta/cosmetics.js entry
 * so the store can concatenate them into its catalogue if it wants to render
 * previews; nothing here depends on that happening.
 */
export const SEASON_ITEMS = [
  { id: `s-${_slug}-skin`, kind: 'skin', name: `${_slot.meta.name} Void`, rarity: 'rare', price: 0, set: `season-${_slug}`, desc: `Season ${_slot.index + 1} exclusive hole skin.`, season: true },
  { id: `s-${_slug}-trail`, kind: 'trail', name: `${_slot.meta.name} Wake`, rarity: 'rare', price: 0, set: `season-${_slug}`, desc: `Season ${_slot.index + 1} exclusive trail.`, season: true },
  { id: `s-${_slug}-rim`, kind: 'rim', name: `${_slot.meta.name} Halo`, rarity: 'epic', price: 0, set: `season-${_slug}`, desc: `Season ${_slot.index + 1} exclusive rim.`, season: true },
  { id: `s-${_slug}-plate`, kind: 'nameplate', name: `${_slot.meta.name} Plate`, rarity: 'epic', price: 0, set: `season-${_slug}`, desc: `Season ${_slot.index + 1} exclusive nameplate.`, season: true },
  { id: `s-${_slug}-icon`, kind: 'icon', name: `${_slot.meta.name} Crest`, rarity: 'legendary', price: 0, set: `season-${_slug}`, desc: `Season ${_slot.index + 1} exclusive profile icon.`, season: true },
  { id: `s-${_slug}-emote`, kind: 'emote', name: `${_slot.meta.name} Salute`, rarity: 'mythic', price: 0, set: `season-${_slug}`, desc: `Season ${_slot.index + 1} exclusive emote.`, season: true },
];

/** Season XP required to have REACHED tier n (1-based). */
function tierThreshold(n) {
  return 250 + (n - 1) * (320 + (n - 1) * 10);
}

/** Reward for each of the 30 tiers. Items land on every fifth. */
const TIER_REWARDS = [
  { coins: 120 }, { xp: 150 }, { coins: 180 }, { coins: 220 }, { item: 0 },
  { coins: 200 }, { xp: 250 }, { coins: 260 }, { coins: 300 }, { item: 1 },
  { coins: 280 }, { xp: 350 }, { coins: 340 }, { coins: 380 }, { item: 2 },
  { coins: 360 }, { xp: 450 }, { coins: 420 }, { coins: 480 }, { item: 3 },
  { coins: 460 }, { xp: 600 }, { coins: 520 }, { coins: 580 }, { item: 4 },
  { coins: 620 }, { xp: 800 }, { coins: 700 }, { coins: 820 }, { item: 5 },
];

export const SEASON = {
  id: `s${_slot.index + 1}-${_slug}`,
  name: `Season ${_slot.index + 1}: ${_slot.meta.name}`,
  blurb: _slot.meta.blurb,
  accent: _slot.meta.accent,
  ends: _slot.ends,
  tiers: TIER_REWARDS.map((r, i) => {
    const tier = i + 1;
    const reward = {};
    if (r.coins) reward.coins = r.coins;
    if (r.xp) reward.xp = r.xp;
    if (r.item !== undefined) reward.item = SEASON_ITEMS[r.item];
    return { tier, at: tierThreshold(tier), reward };
  }),
};

/** Free track only — there is no paid pass in this game, by design. */
export const SEASON_HAS_PAID_TRACK = false;

/** Wipe the season wallet when the calendar has moved on to a new season. */
export function ensureSeason() {
  const s = profile.data.season;
  if (s.id !== SEASON.id) {
    s.id = SEASON.id;
    s.xp = 0;
    s.claimed = [];
    profile.save();
  }
  if (!Array.isArray(s.claimed)) s.claimed = [];
  return s;
}

/**
 * @returns {{tier:number, next:object|null, pct:number, claimable:number[],
 *            xp:number, max:number, endsInMs:number, claimed:number[]}}
 */
export function seasonProgress() {
  const s = ensureSeason();
  const xp = Math.max(0, s.xp || 0);
  const tiers = SEASON.tiers;

  let tier = 0;
  for (const t of tiers) if (xp >= t.at) tier = t.tier;

  const next = tier < tiers.length ? tiers[tier] : null;
  const floor = tier > 0 ? tiers[tier - 1].at : 0;
  const pct = next ? Math.max(0, Math.min(1, (xp - floor) / Math.max(1, next.at - floor))) : 1;

  const claimed = s.claimed.slice();
  const claimable = [];
  for (let n = 1; n <= tier; n++) if (!claimed.includes(n)) claimable.push(n);

  return {
    tier, next, pct, claimable, claimed,
    xp,
    max: tiers[tiers.length - 1].at,
    endsInMs: Math.max(0, SEASON.ends - Date.now()),
  };
}

/**
 * Claim one season tier. Returns false if it is locked or already taken.
 * @returns {boolean}
 */
export function claimSeason(tier) {
  const s = ensureSeason();
  const t = SEASON.tiers.find((x) => x.tier === tier);
  if (!t) return false;
  if ((s.xp || 0) < t.at) return false;
  if (s.claimed.includes(tier)) return false;

  s.claimed.push(tier);
  if (t.reward.coins) profile.addCoins(t.reward.coins);
  if (t.reward.xp) {
    profile.addXp(t.reward.xp);
    // A pass reward that advances the pass is a compounding loop: claim tier 2,
    // unlock tier 3, claim that, and so on. Player XP still counts, season XP
    // does not.
    profile.data.season.xp = Math.max(0, profile.data.season.xp - t.reward.xp);
  }
  if (t.reward.item) profile.grant(t.reward.item.kind, t.reward.item.id);

  profile.save();
  checkAchievements();
  return true;
}

/* ========================================================================= */
/* STREAK + LEVEL VIEWS                                                      */
/* ========================================================================= */

/**
 * A rolling seven-day strip ending on TOMORROW, so the "come back" dot is
 * always the last one on the row regardless of what weekday it is today.
 * The profile only stores `days` and `lastDay`, so the played flags are
 * reconstructed from the run length rather than from a per-day log.
 */
export function streakState() {
  profile.touchStreak();
  const st = profile.data.streak;
  const today = dayKey();
  const days = [];
  const names = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  for (let off = -5; off <= 1; off++) {
    const d = new Date();
    d.setDate(d.getDate() + off);
    const key = dayKey(d);
    // Day -n was played if it falls inside the current unbroken run.
    const withinRun = off <= 0 && st.lastDay === today && -off < st.days;
    days.push({
      key,
      label: names[d.getDay()],
      date: d.getDate(),
      played: !!withinRun,
      isToday: key === today,
      isTomorrow: off === 1,
    });
  }

  return {
    days,
    current: st.days || 0,
    best: st.best || 0,
    playedToday: st.lastDay === today,
    tomorrowKey: dayKeyOffset(1),
  };
}

/** Everything the level card needs, in one read. */
export function levelState() {
  const d = profile.data;
  const need = xpForLevel(d.level);
  return {
    level: d.level,
    xp: d.xp,
    need,
    remaining: Math.max(0, need - d.xp),
    pct: Math.max(0, Math.min(1, d.xp / Math.max(1, need))),
    coins: d.coins,
  };
}

/* ========================================================================= */
/* END-OF-MATCH REWARDS                                                      */
/* ========================================================================= */

/** Bonus weights. Kept together so the end screen's line items stay tunable. */
const BONUS = {
  win: 0.35,
  podium: 0.12,
  perStreakDay: 0.04,
  streakCap: 7,
  challengeKickerXp: 40,
  challengeKickerCoins: 15,
};

function snapshotLevel() {
  const d = profile.data;
  return { level: d.level, xp: d.xp, need: xpForLevel(d.level) };
}

/**
 * Turn a finished match into everything the player earned.
 *
 * @param {object} summary  match.summary(player) plus { mode, durationSec }.
 *   Reads: mode, rank, total, score, diameter, durationSec,
 *          stats.{devoured, rivalsEaten, peakRadius}
 * @returns {{
 *   xp:{base:number,bonus:number,total:number,levelsGained:number,
 *       before:{level,xp,need}, after:{level,xp,need}},
 *   coins:{base:number,bonus:number,total:number},
 *   parts:{label:string,xp:number,coins:number}[],
 *   challenges:{id,text,completed,reward,progress,goal}[],
 *   achievements:object[],
 *   season:{gained:number,tier:number,unlocked:number[],pct:number,next:object|null}
 * }}
 *
 * NOTE ON `after`: it is snapshotted AFTER achievement payouts, so an end
 * screen that animates the bar from `before` to `after` lands on the player's
 * real state instead of a number that jumps the moment they leave.
 */
export function grantMatchRewards(summary = {}) {
  const modeId = setActiveMode(summary.mode);
  ensureDailies();
  ensureSeason();

  const players = Math.max(1, Math.round(summary.total || summary.players || 1));
  const rank = Math.max(1, Math.min(players, Math.round(summary.rank || players)));
  const score = Math.max(0, Math.round(summary.score || 0));
  const durationSec = Math.max(0, Math.round(summary.durationSec || 0));
  const st = summary.stats || {};
  const devoured = Math.max(0, Math.round(st.devoured || summary.devoured || 0));
  const rivalsEaten = Math.max(0, Math.round(st.rivalsEaten || summary.rivalsEaten || 0));
  const diameter = Math.max(
    0,
    summary.diameter || (st.peakRadius ? st.peakRadius * 2 : 0) || (summary.holeDiameter || 0),
  );

  /* --- challenges first: their completions feed the bonus below ---------- */
  const before = ensureDailies().map((c) => ({ id: c.id, done: c.progress >= c.goal }));

  if (score > 0) progressChallenge('score', score);
  if (rank === 1) progressChallenge('wins', 1);
  if (durationSec > 0) progressChallenge('survive', durationSec);
  if (diameter > 0) progressChallenge('bigHole', diameter);
  if (devoured > 0) progressChallenge('devour', devoured);
  if (rivalsEaten > 0) progressChallenge('rivals', rivalsEaten);

  const live = ensureDailies();
  const wasDone = new Map(before.map((b) => [b.id, b.done]));
  const challenges = live.map((c) => ({
    id: c.id,
    text: c.text,
    progress: Math.min(c.progress, c.goal),
    goal: c.goal,
    reward: { xp: c.reward.xp, coins: c.reward.coins },
    completed: c.progress >= c.goal && !wasDone.get(c.id),
  }));
  const justCompleted = challenges.filter((c) => c.completed).length;

  /* --- payout ------------------------------------------------------------ */
  const base = rewardFor(modeId, rank, players);
  const streakDays = Math.min(BONUS.streakCap, (profile.data.streak && profile.data.streak.days) || 0);

  const parts = [];
  let bonusXp = 0;
  let bonusCoins = 0;

  const addPart = (label, xp, coins) => {
    const x = Math.round(xp);
    const c = Math.round(coins);
    if (!x && !c) return;
    parts.push({ label, xp: x, coins: c });
    bonusXp += x;
    bonusCoins += c;
  };

  if (rank === 1) addPart('Victory', base.xp * BONUS.win, base.coins * BONUS.win);
  else if (rank <= 3) addPart(`Podium finish · #${rank}`, base.xp * BONUS.podium, base.coins * BONUS.podium);

  if (streakDays > 1) {
    const m = streakDays * BONUS.perStreakDay;
    addPart(`Day ${streakDays} streak`, base.xp * m, base.coins * m);
  }
  if (justCompleted > 0) {
    // A kicker, not the reward itself — the challenge's own payout is still
    // sitting on the Rewards screen waiting to be claimed, and the walk over
    // there to tap CLAIM is the point.
    addPart(
      justCompleted > 1 ? `${justCompleted} daily challenges done` : 'Daily challenge done',
      BONUS.challengeKickerXp * justCompleted,
      BONUS.challengeKickerCoins * justCompleted,
    );
  }

  const totalXp = Math.max(0, Math.round(base.xp + bonusXp));
  const totalCoins = Math.max(0, Math.round(base.coins + bonusCoins));

  const levelBefore = snapshotLevel();
  const seasonXpBefore = profile.data.season.xp || 0;
  const tierBefore = seasonProgress().tier;

  profile.addXp(totalXp);
  profile.addCoins(totalCoins);
  profile.recordMatch({
    mode: modeId,
    rank,
    players,
    score,
    holeDiameter: diameter,
    devoured,
    rivalsEaten,
    durationSec,
  });

  const achievements = checkAchievements();

  const after = snapshotLevel();
  const sp = seasonProgress();
  const unlocked = [];
  for (let n = tierBefore + 1; n <= sp.tier; n++) unlocked.push(n);

  touch(true);

  return {
    mode: modeId,
    rank,
    players,
    xp: {
      base: Math.round(base.xp),
      bonus: Math.round(bonusXp),
      total: totalXp,
      levelsGained: Math.max(0, after.level - levelBefore.level),
      before: levelBefore,
      after,
    },
    coins: {
      base: Math.round(base.coins),
      bonus: Math.round(bonusCoins),
      total: totalCoins,
    },
    parts,
    challenges,
    achievements,
    season: {
      gained: Math.max(0, (profile.data.season.xp || 0) - seasonXpBefore),
      tier: sp.tier,
      unlocked,
      pct: sp.pct,
      next: sp.next,
    },
  };
}

/* ========================================================================= */
/* BOOT                                                                      */
/* ========================================================================= */

/**
 * Bring the persisted state in line with today: reroll dailies if the day
 * turned over, reset the season wallet if the season did, count the login
 * toward the streak, and back-fill any achievement the player already earned
 * before it existed.
 */
export function initProgression() {
  ensureSeason();
  ensureDailies();
  profile.touchStreak();
  const fresh = checkAchievements();
  loadCosmetics();
  return fresh;
}

initProgression();
