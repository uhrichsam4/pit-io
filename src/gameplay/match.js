/**
 * Match state machine: menu -> countdown -> playing -> results.
 * Owns the clock, respawns, the end-of-match frenzy and final rankings.
 */

import { MATCH, HOLE } from '../config.js';

export const PHASE = {
  LOADING: 'loading',
  MENU: 'menu',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  RESULTS: 'results',
};

export class Match {
  constructor() {
    this.phase = PHASE.LOADING;
    this.timeLeft = MATCH.DURATION;
    this.countdown = 3;
    this.frenzy = false;
    /** @type {import('./hole.js').Hole[]} */
    this.holes = [];
    this.onPhase = null;
    this.onFrenzy = null;
    this.onRespawn = null;
  }

  start(holes) {
    this.holes = holes;
    this.timeLeft = MATCH.DURATION;
    this.countdown = 3.2;
    this.frenzy = false;
    this._setPhase(PHASE.COUNTDOWN);
  }

  _setPhase(p) {
    if (this.phase === p) return;
    this.phase = p;
    if (this.onPhase) this.onPhase(p);
  }

  update(dt) {
    if (this.phase === PHASE.COUNTDOWN) {
      this.countdown -= dt;
      if (this.countdown <= 0) this._setPhase(PHASE.PLAYING);
      return;
    }
    if (this.phase !== PHASE.PLAYING) return;

    this.timeLeft -= dt;
    if (!this.frenzy && this.timeLeft <= MATCH.FRENZY_AT) {
      this.frenzy = true;
      if (this.onFrenzy) this.onFrenzy(true);
    }
    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      this._setPhase(PHASE.RESULTS);
      return;
    }

    for (const h of this.holes) {
      if (h.alive) continue;
      h.respawnAt -= dt;
      if (h.respawnAt <= 0 && this.onRespawn) this.onRespawn(h);
    }
  }

  rankings() {
    return [...this.holes].sort((a, b) => b.score - a.score);
  }

  get playerRank() {
    const r = this.rankings();
    const i = r.findIndex((h) => h.isPlayer);
    return i < 0 ? r.length : i + 1;
  }
}
