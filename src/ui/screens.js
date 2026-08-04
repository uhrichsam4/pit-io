/**
 * SCREENS — the in-match full-screen states: loading, countdown, results.
 *
 * CONTRACT (called from src/game.js, do not break):
 *   new Screens(root) · screens.onPlay · screens.onLobby · screens.onMenu
 *   clear() · showLoading(text) · showMenu() · showCountdown(n)
 *   showResults(summary, me, breakdown)
 *
 * THE TITLE SCREEN IS GONE. It has been replaced by the meta layer's lobby
 * (src/ui/screens/lobby.js, mounted by src/ui/meta.js). showMenu() is kept as
 * the seam game.js already calls in two places: it clears this overlay and
 * hands control to whoever owns the shell. showFallbackMenu() is the one
 * exception — a bare title card used only when the meta layer failed to load,
 * so a broken front end can never leave the game unplayable.
 *
 * Everything here sits ON TOP of a bright, moving, high-detail image, so each
 * screen carries its own dimming veil, animated colour wash, hard-outlined
 * display type, and plated cards for anything with small text in it.
 */

import { MATCH, TIER_LIST } from '../config.js';
import { uiState, formatScore, ordinal } from './hud.js';
import { icon } from './shell.js';

const LOADING_TIPS = [
  'Cones first. Towers later.',
  'Bigger holes are slower — trade speed for reach.',
  'Swallow a rival and you inherit most of their score.',
  'The last 30 seconds are a frenzy. Everything fits.',
  'The bay is a wall. Do not get pinned against it.',
];

export class Screens {
  constructor(root) {
    this.root = root;
    const el = document.createElement('div');
    el.id = 'screens';
    el.style.position = 'absolute';
    el.style.inset = '0';
    el.style.pointerEvents = 'none';
    root.appendChild(el);
    this.el = el;
    this.onPlay = null;
    this.onLobby = null;
    /** Hand-off to the meta layer. Wired by game.js to show the lobby. */
    this.onMenu = null;

    this._cd = -99;

    this.showLoading('Building Miami…');
  }

  clear() {
    this.el.innerHTML = '';
    this.el.style.pointerEvents = 'none';
    this._cd = -99;
    this._cdWrap = null;
  }

  /* ====================================================================== */
  /* LOADING                                                                */
  /* ====================================================================== */

  showLoading(text = 'Loading…') {
    // Keep the tip stable across the several showLoading() calls the boot
    // sequence makes, or it flickers through the list while nothing happens.
    if (this._tip == null) this._tip = LOADING_TIPS[(Math.random() * LOADING_TIPS.length) | 0];
    this.el.innerHTML = `
      <div id="loading">
        <div class="lt">Miami<br/>Devour</div>
        <div class="bar"><i></i></div>
        <div class="lm">${esc(text)}</div>
        <div class="key-hint" style="margin-top:.4em">${esc(this._tip)}</div>
      </div>`;
    this.el.style.pointerEvents = 'auto';
    this._cd = -99;
  }

  /* ====================================================================== */
  /* TITLE / MENU  (handed to the meta layer)                                */
  /* ====================================================================== */

  /**
   * The title screen is now the lobby. game.js calls this from init() and from
   * returnToLobby(); both must end up in the same place, so all this does is
   * take this overlay down and hand over.
   */
  showMenu() {
    this.clear();
    if (this.onMenu) this.onMenu();
  }

  /**
   * The one screen that exists purely as insurance.
   *
   * If the meta layer failed to load there is no lobby to hand to, and a black
   * page over a slowly orbiting city is indistinguishable from a crash. This
   * says what happened and still lets the player start a match.
   *
   * @param {number} objects edible objects in the world, for the footer
   */
  showFallbackMenu(objects = 0) {
    const mins = Math.floor(MATCH.DURATION / 60);
    const secs = String(MATCH.DURATION % 60).padStart(2, '0');
    this.el.innerHTML = `
      <div class="scr veil">
        <div class="aurora"></div>
        <div class="menu-in">
          <div class="eyebrow">Brickell &middot; Biscayne Bay</div>
          <h1 class="title"><span class="tl">Miami</span><span class="tl">Devour</span></h1>
          <p class="tagline">
            The lobby did not load, so this is the short way in. Swallow the
            city &mdash; litter, then cars, then the <b>towers themselves</b>.
            Be the biggest when the clock hits zero.
          </p>

          <button class="btn" id="play-btn">Play</button>
          <div class="key-hint">or press <kbd>Space</kbd></div>

          <div class="foot">
            <span><b>${mins}:${secs}</b> match</span>
            <span><b>${MATCH.BOT_COUNT + 1}</b> holes</span>
            <span><b>${esc(Number(objects).toLocaleString())}</b> edible objects</span>
            <span><b>${TIER_LIST.length}</b> size tiers</span>
          </div>
        </div>
      </div>`;
    this.el.style.pointerEvents = 'auto';
    this.el.querySelector('#play-btn').addEventListener('click', () => {
      uiState.reset();
      if (this.onPlay) this.onPlay();
    });
  }


  /* ====================================================================== */
  /* COUNTDOWN                                                              */
  /* ====================================================================== */

  /**
   * Called every frame while the match counts in, so it must be idempotent:
   * rebuild only when the whole number the player reads actually changes, or
   * the pop animation restarts sixty times a second and looks frozen.
   */
  showCountdown(n) {
    // MATCH.COUNTDOWN has slack on it (3.2s), so ceil() alone would flash a
    // "4" for two frames before settling into the real 3-2-1.
    const step = n <= 0 ? 0 : Math.min(Math.floor(MATCH.COUNTDOWN), Math.ceil(n));
    if (step === this._cd && this._cdWrap && this._cdWrap.isConnected) return;
    this._cd = step;

    if (!this._cdWrap || !this._cdWrap.isConnected) {
      this.el.innerHTML = '<div id="cd-wrap"></div>';
      this._cdWrap = this.el.querySelector('#cd-wrap');
      this.el.style.pointerEvents = 'none';
    }
    const go = step === 0;
    this._cdWrap.innerHTML = go
      ? '<div class="cd go">GO!</div>'
      : `<div class="ring"></div><div class="cd">${step}</div>`;
  }

  /* ====================================================================== */
  /* RESULTS                                                                */
  /* ====================================================================== */

  /**
   * End of match.
   *
   * Two exits, deliberately: "Play Again" restarts immediately, "Return to
   * Lobby" goes back to the title. Both must hand off to a FULL reset — the
   * screen itself only reports, it never leaves gameplay state behind.
   */
  showResults(summary, me, breakdown = null) {
    const { rankings = [], winner, rank = 1, total = 1, score = 0,
            diameter = 0, won = false, stats = {}, teams = null,
            mode = null } = summary || {};
    const suffix = ordinal(rank);

    const stat = (label, value, cls = '') =>
      `<div class="stat ${cls}"><span class="sv">${value}</span><span class="sl">${label}</span></div>`;

    // The card carries the whole screen, so it needs the same veil + centring
    // treatment the menu gets. It previously shipped as a bare `.screen` div
    // (a class that does not exist) whose two inner blocks were tagged
    // `.panel` — which is `position:absolute` — so the stats row and the
    // standings list were pulled out of flow and drew on top of each other in
    // the top-left corner over an undimmed city.
    this.el.innerHTML = `
      <div class="scr veil results-screen">
        <div class="aurora"></div>
        <div class="res-card">
          <div class="rs-head">
            <div class="rs-kicker">Match complete</div>
            <div class="rs-place ${rank === 1 ? 'first' : ''}">
              <span class="n">${rank}<sup>${suffix}</sup></span>
              <span class="rs-of">of ${total}</span>
            </div>
            <div class="rs-verdict ${won ? 'win' : ''}">
              ${verdictLine(won, teams, winner)}
            </div>
            ${mode ? `<div class="rs-mode">${esc(mode.icon || '')} ${escapeHtml(mode.name || '')}</div>` : ''}
          </div>

          <div class="rs-stats">
            ${stat('Final score', Math.round(score).toLocaleString())}
            ${stat('Hole size', `${diameter.toFixed(1)}<span class="u">m</span>`)}
            ${stat('Devoured', (stats.devoured || 0).toLocaleString())}
            ${stat('Rivals eaten', stats.rivalsEaten || 0)}
            ${bestMealStat(stats, stat)}
          </div>

          ${rewardsBlock(breakdown)}

          ${teamsBlock(teams)}

          <div class="rs-board">
            <h3>Final standings</h3>
            <div class="rs-rows">
              ${rankings.slice(0, 8).map((h, i) => `
                <div class="row ${h === me ? 'me' : ''} ${i < 3 ? `p${i + 1}` : ''}"
                     style="animation-delay:${(i * 0.045).toFixed(3)}s">
                  <span class="rk">${i + 1}</span>
                  <span class="dot" style="background:#${h.color.getHexString()};color:#${h.color.getHexString()}"></span>
                  <span class="nm">${escapeHtml(h.name)}${i === 0 ? ' <span class="crown">&#9819;</span>' : ''}</span>
                  <span class="sc">${Math.round(h.score).toLocaleString()}</span>
                </div>`).join('')}
            </div>
          </div>

          <div class="rs-actions">
            <button class="btn" id="again-btn">Play Again</button>
            <button class="btn btn-ghost" id="lobby-btn">Return to Lobby</button>
          </div>
        </div>
      </div>`;
    this.el.style.pointerEvents = 'auto';

    const fade = (fn) => {
      const scr = this.el.querySelector('.res-card');
      if (scr) scr.classList.add('leaving');
      // Let the transition play before the world is torn down and rebuilt.
      setTimeout(fn, 240);
    };
    this.el.querySelector('#again-btn').addEventListener('click', () => {
      fade(() => { if (this.onPlay) this.onPlay(); });
    });
    this.el.querySelector('#lobby-btn').addEventListener('click', () => {
      fade(() => { if (this.onLobby) this.onLobby(); });
    });
  }

}

/**
 * "Best meal" is worth a tile only when there IS one. Match owns the label; the
 * live HUD independently tracks the same thing (uiState.bestMeal) and is the
 * fallback when a match ended without Match seeing a swallow (e.g. a net client
 * crediting nobody).
 *
 * The tile is marked `wide` because it is the only one holding a NAME rather
 * than a number — at the same width as "Rivals eaten" it ellipsised to
 * "Brickell …", which tells the player nothing.
 */
function bestMealStat(stats, stat) {
  const label = stats.biggestMeal || (uiState.bestMeal && uiState.bestMeal.label);
  if (!label) return '';
  return stat('Best meal', esc(label), 'wide');
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (m) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
  ));
}

/** Alias: the results screen was written against this name. */
const escapeHtml = esc;

/** 12345 -> "12,345". Every number on this card is read, not scanned. */
const num = (n) => Math.round(Number(n) || 0).toLocaleString();

/**
 * Who took the city. In Team Devour the individual winner is beside the point —
 * the round is decided on pooled score, so the line has to name a team.
 */
function verdictLine(won, teams, winner) {
  if (teams && teams.length) {
    if (won) return 'Your team took the city';
    if (teams[0] && teams[0].score === teams[teams.length - 1].score) return 'The city is a draw';
    return `<b>${escapeHtml(teams[0] ? teams[0].name : '—')}</b> took the city`;
  }
  if (won) return 'You were the biggest hole in Miami';
  return `<b>${escapeHtml(winner ? winner.name : '—')}</b> took the city`;
}

/** Pooled team scores, above the individual standings rather than instead. */
function teamsBlock(teams) {
  if (!teams || !teams.length) return '';
  const top = Math.max(1, ...teams.map((t) => t.score));
  return `
    <div class="rs-teams">
      <h3>Team scores</h3>
      ${teams.map((t) => `
        <div class="rs-team ${t.mine ? 'mine' : ''}" style="--tc:${esc(t.color)}">
          <span class="tn">${escapeHtml(t.name)}${t.mine ? ' <i>you</i>' : ''}</span>
          <span class="tbar"><i style="width:${((t.score / top) * 100).toFixed(1)}%"></i></span>
          <span class="ts">${num(t.score)}</span>
        </div>`).join('')}
    </div>`;
}

/**
 * What the round paid.
 *
 * The breakdown comes from progression.grantMatchRewards and is ALWAYS optional
 * — a failure there is caught in game.js and lands here as null, in which case
 * the card simply reports the match and says nothing about rewards. Never a
 * zeroed-out XP bar, which would read as "you earned nothing".
 */
function rewardsBlock(b) {
  if (!b || !b.xp) return '';
  const after = b.xp.after || { level: 1, xp: 0, need: 1 };
  const pct = Math.min(100, Math.max(0, (after.xp / Math.max(1, after.need)) * 100));
  const parts = (b.parts || []).map((p) => `
    <li><span class="pl">${escapeHtml(p.label)}</span>
        <span class="pv">${p.xp ? `+${num(p.xp)} XP` : ''}${p.xp && p.coins ? ' · ' : ''}${p.coins ? `+${num(p.coins)} ${icon('coin', '0.9em')} coins` : ''}</span></li>`).join('');

  const done = (b.challenges || []).filter((c) => c.completed);
  const achievements = b.achievements || [];

  return `
    <div class="rs-rewards">
      <div class="rw-top">
        <span class="rw-pill xp">+${num(b.xp.total)} XP</span>
        <span class="rw-pill coin">+${num(b.coins ? b.coins.total : 0)} ${icon('coin', '0.9em')} coins</span>
        ${b.xp.levelsGained > 0
          ? `<span class="rw-pill up">LEVEL UP → ${after.level}</span>` : ''}
      </div>
      <div class="rw-lvl">
        <span class="rw-lv">LV ${after.level}</span>
        <span class="rw-bar"><i style="width:${pct.toFixed(1)}%"></i></span>
        <span class="rw-xp">${num(after.xp)}/${num(after.need)}</span>
      </div>
      ${parts ? `<ul class="rw-parts">${parts}</ul>` : ''}
      ${done.length ? `<div class="rw-note challenge">✔ ${done.map((c) => escapeHtml(c.text)).join(' · ')}</div>` : ''}
      ${achievements.length
        ? `<div class="rw-note achieve">🏅 ${achievements.map((a) => escapeHtml(a.name || a.title || a.id)).join(' · ')}</div>`
        : ''}
    </div>`;
}
