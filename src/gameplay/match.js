/**
 * Match state machine: menu -> countdown -> playing -> results.
 * Owns the clock, respawn rules, the end-of-match frenzy, the escalation
 * announcements and the final ranking.
 *
 * ESCALATION is the job here. A 150 s round with a silent clock reads as a
 * sandbox; the same round with "60 SECONDS", a lead change called out, and a
 * marked leader reads as a match. Everything below exists to make the last
 * third of the round feel different from the first.
 */

import { MATCH, HOLE, TIER_LIST } from '../config.js';
import { Hole } from './hole.js';
import { clampToLand } from './ai.js';

export const PHASE = {
  LOADING: 'loading',
  MENU: 'menu',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  RESULTS: 'results',
};

/** A challenger must beat the incumbent by this much to take the marker. */
const LEAD_MARGIN = 1.04;
/** Minimum seconds between two "takes the lead" calls. */
const LEAD_COOLDOWN = 12;

/** Feed colours. Kept here so every announcement speaks the same language. */
const COL = {
  CLOCK: '#ffffff',
  URGENT: '#ffc93c',
  FRENZY: '#ff3d8b',
  LEAD: '#37e6d5',
};

export class Match {
  constructor() {
    this.phase = PHASE.LOADING;
    this.timeLeft = MATCH.DURATION;
    this.elapsed = 0;
    this.countdown = MATCH.COUNTDOWN;
    this.frenzy = false;
    /** @type {import('./hole.js').Hole[]} */
    this.holes = [];
    /** @type {import('./hole.js').Hole|null} Current leader, also flagged on the hole. */
    this.leader = null;
    /**
     * Optional city layout. When the host assigns it, respawn placement uses
     * the authoritative isWater() instead of ai.js's reconstruction.
     */
    this.layout = null;

    this.onPhase = null;
    this.onFrenzy = null;
    this.onRespawn = null;
    this.resetStats();
    /**
     * Optional sink for escalation lines: (text, color, kind) => void.
     * If nobody wires it, _announce falls back to the kill feed (see there).
     */
    this.onAnnounce = null;
    /** Optional (newLeader, oldLeader) => void. */
    this.onLeadChange = null;

    this._announced = new Set();
    this._tierCalled = 0;
    this._leadCallAt = -99;
    this._sorted = [];
  }

  /** Per-match tallies, shown on the end screen. Reset by start(). */
  resetStats() {
    this.stats = {
      devoured: 0,           // objects the player swallowed
      biggestMeal: null,     // label of the largest thing they took
      biggestMealScore: 0,
      rivalsEaten: 0,
      timesEaten: 0,
      peakRadius: 0,
      startedAt: 0,
    };
  }

  /**
   * @param {import('./hole.js').Hole[]} holes
   * @param {?object} mode  a src/gameplay/modes.js entry. Only `elimination` is
   *   read here; everything else about a mode is applied by the host.
   */
  start(holes, mode = null) {
    this.resetStats();
    this.holes = holes;
    this.mode = mode;
    /**
     * ELIMINATION MODES DO NOT RESPAWN, and are not ranked on score.
     *
     * "Last Hole Standing" that hands the win to whoever ate the most is not
     * the mode, it is Classic on a smaller map — the closing ring was there but
     * nothing was ever at stake inside it. Here, being swallowed is final, and
     * the standings are the order people went out in, backwards.
     */
    this.elimination = !!(mode && mode.elimination);
    this._elimOrder = [];
    this._elimCounter = 0;
    this.timeLeft = MATCH.DURATION;
    this.elapsed = 0;
    this.countdown = MATCH.COUNTDOWN;
    this.frenzy = false;
    this.leader = null;
    this._announced.clear();
    this._tierCalled = 0;
    this._leadCallAt = -99;
    for (const h of holes) {
      h.spawnGrace = 0;
      h.isLeader = false;
      h.rank = 0;
      h.eliminatedAt = 0;
    }
    this._setPhase(PHASE.COUNTDOWN);
  }

  /** Holes still in the match. In non-elimination modes this is everyone. */
  get aliveCount() {
    let n = 0;
    for (const h of this.holes) if (h.alive || !this.elimination) n++;
    return n;
  }

  _setPhase(p) {
    if (this.phase === p) return;
    this.phase = p;
    if (this.onPhase) this.onPhase(p);
  }

  /* ------------------------------------------------------------- clock --- */

  update(dt) {
    if (this.phase === PHASE.COUNTDOWN) {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this._setPhase(PHASE.PLAYING);
        this._announce('<b>DEVOUR MIAMI</b>', COL.URGENT, 'start');
      }
      return;
    }
    if (this.phase !== PHASE.PLAYING) return;

    this.timeLeft -= dt;
    this.elapsed += dt;

    if (!this.frenzy && this.timeLeft <= MATCH.FRENZY_AT) {
      this.frenzy = true;
      if (this.onFrenzy) this.onFrenzy(true);
    }

    this._tickAnnouncements();
    this._tickLeader();

    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      this._rank();
      this._setPhase(PHASE.RESULTS);
      return;
    }

    for (const h of this.holes) {
      if (h.spawnGrace > 0) h.spawnGrace = Math.max(0, h.spawnGrace - dt);
      if (h.alive) continue;

      if (this.elimination) {
        // Out for good. Recorded once, in the order it happened, because that
        // order IS the final table.
        if (!h.eliminatedAt) {
          h.eliminatedAt = ++this._elimCounter;
          h.respawnAt = 0;
          const left = this.aliveCount;
          this._announce(
            `<b>${h.name}</b> is out${left > 1 ? ` — ${left} left` : ''}`,
            `#${h.color.getHexString()}`, 'elim'
          );
        }
        continue;
      }

      h.respawnAt -= dt;
      if (h.respawnAt <= 0) this._respawn(h);
    }

    // One hole left and nobody can come back: the mode is decided, so do not
    // make the winner drive around an empty city until the clock expires.
    if (this.elimination && this.aliveCount <= 1) {
      this.timeLeft = 0;
      this._rank();
      this._setPhase(PHASE.RESULTS);
    }
  }

  /* ----------------------------------------------------- announcements --- */

  /**
   * Where escalation lines go.
   *
   * Preference order is (1) an explicitly wired onAnnounce, (2) a DOM event so
   * a HUD can subscribe without Match knowing it exists, (3) the kill feed.
   * The third path exists because Match is constructed before the HUD in
   * game.js and has no handle on it; it is a lookup, not a dependency, and it
   * silently does nothing if the UI has moved on.
   */
  _announce(text, color = COL.CLOCK, kind = 'info') {
    if (this.onAnnounce) { this.onAnnounce(text, color, kind); return; }
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('md-announce', { detail: { text, color, kind } }));
    }
    const g = typeof globalThis !== 'undefined' ? globalThis : null;
    const hud = g && (g.__miamiHUD || (g.DEV && g.DEV.game && g.DEV.game.hud));
    if (hud && typeof hud.pushFeed === 'function') hud.pushFeed(text, color);
  }

  _tickAnnouncements() {
    // Clock milestones, once each.
    for (const at of MATCH.ANNOUNCE_AT) {
      if (this.timeLeft > at || this._announced.has(`t${at}`)) continue;
      this._announced.add(`t${at}`);
      if (at === MATCH.FRENZY_AT) continue;         // the frenzy line covers it
      const m = Math.floor(at / 60), s = at % 60;
      const label = m ? `${m}:${String(s).padStart(2, '0')}` : `${s} SECONDS`;
      this._announce(`<b>${label}</b> remaining`, at <= 30 ? COL.URGENT : COL.CLOCK, 'clock');
    }

    // First hole in the match to unlock each of the heavy tiers. This is what
    // tells everyone else the round has moved on without them.
    let top = 0;
    for (const h of this.holes) {
      if (!h.alive) continue;
      for (let i = TIER_LIST.length - 1; i > top; i--) {
        if (h.radius >= TIER_LIST[i].eatRadius) { top = i; break; }
      }
    }
    if (top > this._tierCalled) {
      this._tierCalled = top;
      if (top >= 4) {
        const who = this.holes.find((h) => h.alive && h.radius >= TIER_LIST[top].eatRadius);
        if (who) {
          this._announce(
            `<b>${who.name}</b> is eating ${TIER_LIST[top].label.toUpperCase()}`,
            `#${who.color.getHexString()}`, 'tier'
          );
        }
      }
    }
  }

  /**
   * Recompute ranks and flag the leader so the HUD/minimap can mark them.
   *
   * HYSTERESIS IS NOT OPTIONAL HERE. Two holes eating the same block trade the
   * top slot several times a second; the first version of this emitted
   * eighteen "takes the lead" lines in one match and the crown strobed. The
   * incumbent has to be beaten by a clear margin to lose the marker, and the
   * announcement additionally has a cooldown.
   */
  _tickLeader() {
    const prev = this.leader;
    this._rank();
    const top = this._sorted[0] || null;
    if (!top) return;

    const takeover = !prev || !prev.alive
      ? true
      : top !== prev && top.score > prev.score * LEAD_MARGIN;
    if (!takeover) {
      if (prev && !prev.isLeader) prev.isLeader = true;
      return;
    }
    if (top === prev) return;

    if (prev) prev.isLeader = false;
    top.isLeader = true;
    this.leader = top;
    if (this.onLeadChange) this.onLeadChange(top, prev);
    // Only call it out once there is something to lead, and never twice inside
    // the cooldown.
    if (prev && top.score > 250 && this.elapsed - this._leadCallAt > LEAD_COOLDOWN) {
      this._leadCallAt = this.elapsed;
      this._announce(`<b>${top.name}</b> takes the lead`,
        `#${top.color.getHexString()}`, 'lead');
    }
  }

  /* ----------------------------------------------------------- respawn --- */

  /**
   * Respawn rules:
   *   - you keep HOLE.RESPAWN_KEEP of your score, so a late kill is a setback
   *     rather than the end of your match;
   *   - you never come back inside the jaws of whoever just ate you;
   *   - you get HOLE.RESPAWN_GRACE seconds during which AI will not hunt you.
   */
  _respawn(h) {
    const killer = h.killedBy;
    // The floor is measured against the field, not the clock: dying at t=130 in
    // a match where everyone is on 40,000 must not drop you to a size that
    // cannot eat anything left standing.
    const keep = Math.max(
      Math.round(h.score * HOLE.RESPAWN_KEEP),
      Math.round(this._medianScore() * HOLE.RESPAWN_FLOOR)
    );

    if (this.onRespawn) {
      this.onRespawn(h);
    } else {
      // No host handler (headless tests, net fallback): put them back where
      // they died, pushed onto dry land.
      const p = clampToLand(h.position.x, h.position.z, this.layout);
      h.reset(p.x, p.z, keep);
    }

    // Match owns the score rule even when the host picked the spawn point, so
    // the number cannot drift between game.js and here.
    if (h.score !== keep) {
      h.score = keep;
      h.radius = Hole.radiusFor(keep);
      h.displayRadius = h.radius;
    }

    if (killer && killer.alive) {
      const dx = h.position.x - killer.position.x;
      const dz = h.position.z - killer.position.z;
      const d = Math.hypot(dx, dz);
      const safe = 90 + killer.radius * 4;
      if (d < safe) {
        const nx = d > 0.01 ? dx / d : 1;
        const nz = d > 0.01 ? dz / d : 0;
        const p = clampToLand(
          killer.position.x + nx * safe, killer.position.z + nz * safe, this.layout
        );
        h.position.set(p.x, 0, p.z);
        h.velocity.set(0, 0, 0);
        h.syncVisual();
      }
    }

    h.spawnGrace = HOLE.RESPAWN_GRACE;
    h.killedBy = null;
  }

  _medianScore() {
    const s = this._rank();
    if (!s.length) return 0;
    return s[Math.floor(s.length / 2)].score;
  }

  /* ---------------------------------------------------------- rankings --- */

  _rank() {
    const s = this._sorted;
    s.length = 0;
    for (const h of this.holes) s.push(h);
    if (this.elimination) {
      // Survivors above the fallen; among the fallen, whoever lasted longest.
      // Score only separates people who are still standing together.
      s.sort((a, b) => (
        (b.alive ? 1 : 0) - (a.alive ? 1 : 0) ||
        (b.eliminatedAt || 0) - (a.eliminatedAt || 0) ||
        (b.score - a.score) || (b.eatCount - a.eatCount) || (a.id - b.id)
      ));
    } else {
      // Score first; eatCount breaks ties so two holes on 0 do not swap places
      // every frame and spam the lead-change announcement.
      s.sort((a, b) => (b.score - a.score) || (b.eatCount - a.eatCount) || (a.id - b.id));
    }
    for (let i = 0; i < s.length; i++) s[i].rank = i + 1;
    return s;
  }

  rankings() {
    return [...this._rank()];
  }

  get playerRank() {
    const r = this._rank();
    for (let i = 0; i < r.length; i++) if (r[i].isPlayer) return i + 1;
    return r.length;
  }

  /** The hole in first place. */
  get winner() {
    return this._rank()[0] || null;
  }

  /**
   * Everything the end screen needs, gathered in one place so the UI never has
   * to reach into match internals to work out how the round went.
   */
  summary(player) {
    const ranks = this.rankings();
    const me = ranks.indexOf(player);
    return {
      rankings: ranks,
      winner: ranks[0] || null,
      rank: me < 0 ? ranks.length : me + 1,
      total: ranks.length,
      score: player ? Math.round(player.score) : 0,
      diameter: player ? player.radius * 2 : 0,
      won: ranks[0] === player,
      stats: this.stats || {},
    };
  }
}
