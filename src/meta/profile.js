/**
 * The player's persistent identity, progression and wallet.
 *
 * THE CONTRACT every meta-layer module builds against. Progression, the store,
 * leaderboards, challenges and the profile screen all read and write through
 * here — nobody keeps their own copy of "what level am I", because two sources
 * of truth for that is how a player loses cosmetics they paid for.
 *
 * Storage is localStorage, written through a single save() so a crash mid-match
 * cannot leave a half-written profile. When a room server is reachable the
 * profile is also pushed to it for the online leaderboard; offline everything
 * still works, it is simply local-only.
 */

const KEY = 'miami-devour:profile:v1';
const SAVE_DEBOUNCE_MS = 400;

/** XP needed to go from level n to n+1. Gentle curve: early levels are quick. */
export function xpForLevel(level) {
  return Math.round(120 * Math.pow(level, 1.35));
}

/** Total XP to reach a level from zero. */
export function totalXpForLevel(level) {
  let t = 0;
  for (let i = 1; i < level; i++) t += xpForLevel(i);
  return t;
}

const DEFAULTS = () => ({
  version: 1,
  /** Stable local id. Doubles as the friend code (short, uppercase). */
  id: null,
  name: '',
  icon: 'hole-01',
  nameplate: 'plate-default',

  level: 1,
  xp: 0,
  coins: 300,

  /** Cosmetic ids the player owns, and what is currently equipped. */
  owned: {
    skin: ['skin-classic'],
    trail: ['trail-none'],
    rim: ['rim-classic'],
    icon: ['hole-01'],
    nameplate: ['plate-default'],
    emote: ['emote-wave'],
  },
  equipped: {
    skin: 'skin-classic',
    trail: 'trail-none',
    rim: 'rim-classic',
    icon: 'hole-01',
    nameplate: 'plate-default',
    emotes: ['emote-wave'],
  },

  /** Lifetime stats — the numbers the leaderboard and profile screen show. */
  stats: {
    matches: 0,
    wins: 0,
    top3: 0,
    totalScore: 0,
    bestScore: 0,
    biggestHole: 0,
    objectsDevoured: 0,
    rivalsEaten: 0,
    playTimeSec: 0,
    byMode: {},          // modeId -> { matches, wins, bestScore }
  },

  /** Daily challenges, rerolled on a new local day. */
  daily: { day: null, challenges: [] },
  /** Consecutive days played. */
  streak: { days: 0, lastDay: null, best: 0 },
  achievements: {},      // id -> { unlocked:true, at:timestamp }
  season: { id: null, xp: 0, claimed: [] },

  /** Friend codes the player has added. */
  friends: [],
  settings: {
    music: 0.6, sfx: 0.9, quality: 'auto',
    invertY: false, showFps: false, reducedMotion: false,
  },
});

function makeId() {
  // Short, unambiguous, speakable — this is what a player reads out to a friend.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Deep-merge saved data over defaults so a new field never breaks an old save. */
function hydrate(saved) {
  const base = DEFAULTS();
  if (!saved || typeof saved !== 'object') return base;
  const merge = (dst, src) => {
    for (const k of Object.keys(src || {})) {
      const v = src[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) {
        merge(dst[k], v);
      } else if (v !== undefined) {
        dst[k] = v;
      }
    }
    return dst;
  };
  return merge(base, saved);
}

class Profile {
  constructor() {
    this.data = hydrate(this._read());
    if (!this.data.id) { this.data.id = makeId(); this._dirty = true; }
    this._listeners = new Set();
    this._saveTimer = null;
    this.rollDaily();
    this.touchStreak();
    this.save();
  }

  _read() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); }
    catch { return null; }
  }

  /** Subscribe to any change. Returns an unsubscribe function. */
  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() { for (const fn of this._listeners) { try { fn(this.data); } catch { /* listener's problem */ } } }

  /** Debounced so a burst of updates during a match end is one write. */
  save() {
    this._emit();
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try { localStorage.setItem(KEY, JSON.stringify(this.data)); }
      catch { /* private mode or quota: the session still works */ }
    }, SAVE_DEBOUNCE_MS);
  }

  /* ------------------------------------------------------ progression --- */

  /**
   * Award XP and level up as many times as the amount covers.
   * @returns {{levelsGained:number, level:number, xp:number}}
   */
  addXp(amount) {
    const d = this.data;
    d.xp += Math.max(0, Math.round(amount));
    let gained = 0;
    while (d.xp >= xpForLevel(d.level)) {
      d.xp -= xpForLevel(d.level);
      d.level++;
      gained++;
    }
    d.season.xp += Math.max(0, Math.round(amount));
    this.save();
    return { levelsGained: gained, level: d.level, xp: d.xp };
  }

  addCoins(n) { this.data.coins = Math.max(0, this.data.coins + Math.round(n)); this.save(); }
  canAfford(n) { return this.data.coins >= n; }

  /** Level progress 0..1, for the XP bar. */
  levelProgress() {
    return Math.min(1, this.data.xp / Math.max(1, xpForLevel(this.data.level)));
  }

  /* -------------------------------------------------------- cosmetics --- */

  owns(kind, id) { return (this.data.owned[kind] || []).includes(id); }

  grant(kind, id) {
    const list = this.data.owned[kind] || (this.data.owned[kind] = []);
    if (!list.includes(id)) { list.push(id); this.save(); return true; }
    return false;
  }

  /** Spend coins and grant. Returns false if unaffordable or already owned. */
  purchase(kind, id, price) {
    if (this.owns(kind, id) || !this.canAfford(price)) return false;
    this.data.coins -= price;
    this.grant(kind, id);
    return true;
  }

  equip(kind, id) {
    if (!this.owns(kind, id)) return false;
    this.data.equipped[kind] = id;
    this.save();
    return true;
  }

  /* ------------------------------------------------------------ stats --- */

  /**
   * Fold one finished match into lifetime stats.
   * @param {{mode:string, rank:number, players:number, score:number,
   *          holeDiameter:number, devoured:number, rivalsEaten:number,
   *          durationSec:number}} r
   */
  recordMatch(r) {
    const s = this.data.stats;
    s.matches++;
    if (r.rank === 1) s.wins++;
    if (r.rank <= 3) s.top3++;
    s.totalScore += r.score || 0;
    s.bestScore = Math.max(s.bestScore, r.score || 0);
    s.biggestHole = Math.max(s.biggestHole, r.holeDiameter || 0);
    s.objectsDevoured += r.devoured || 0;
    s.rivalsEaten += r.rivalsEaten || 0;
    s.playTimeSec += Math.round(r.durationSec || 0);

    const m = s.byMode[r.mode] || (s.byMode[r.mode] = { matches: 0, wins: 0, bestScore: 0 });
    m.matches++;
    if (r.rank === 1) m.wins++;
    m.bestScore = Math.max(m.bestScore, r.score || 0);
    this.save();
  }

  /* ------------------------------------------------------- dailies etc --- */

  /** Replace the daily set if the local day has rolled over. */
  rollDaily(generate) {
    const day = todayKey();
    if (this.data.daily.day === day && this.data.daily.challenges.length) return false;
    this.data.daily.day = day;
    this.data.daily.challenges = generate ? generate() : this.data.daily.challenges;
    this.save();
    return true;
  }

  /** Count a login toward the streak. Missing a day resets it to 1. */
  touchStreak() {
    const day = todayKey();
    const st = this.data.streak;
    if (st.lastDay === day) return st.days;
    const y = new Date(); y.setDate(y.getDate() - 1);
    const yesterday = `${y.getFullYear()}-${y.getMonth() + 1}-${y.getDate()}`;
    st.days = st.lastDay === yesterday ? st.days + 1 : 1;
    st.lastDay = day;
    st.best = Math.max(st.best, st.days);
    this.save();
    return st.days;
  }

  unlockAchievement(id) {
    if (this.data.achievements[id]) return false;
    this.data.achievements[id] = { unlocked: true, at: Date.now() };
    this.save();
    return true;
  }

  /** Everything the leaderboard needs about this player. */
  publicRecord() {
    const d = this.data;
    return {
      id: d.id,
      name: d.name || 'Player',
      icon: d.icon,
      nameplate: d.nameplate,
      level: d.level,
      totalScore: d.stats.totalScore,
      bestScore: d.stats.bestScore,
      biggestHole: d.stats.biggestHole,
      wins: d.stats.wins,
      matches: d.stats.matches,
    };
  }

  /** Wipe everything. Used by Settings, and by tests. */
  reset() {
    this.data = hydrate(null);
    this.data.id = makeId();
    this.rollDaily();
    this.touchStreak();
    this.save();
  }
}

export const profile = new Profile();
