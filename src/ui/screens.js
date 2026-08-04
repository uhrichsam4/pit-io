/**
 * SCREENS — the full-screen states: loading, title/menu, countdown, results.
 *
 * CONTRACT (called from src/game.js, do not break):
 *   new Screens(root) · screens.onPlay · clear()
 *   showLoading(text) · showMenu(stats) · showCountdown(n) · showResults(ranks, me)
 *
 * A slow camera orbit over the Brickell skyline runs behind the menu, so every
 * screen here is built to sit ON TOP of a bright, moving, high-detail image:
 * a dimming veil, an animated colour wash, hard-outlined display type, and
 * plated cards for anything with small text in it.
 */

import { MATCH, TIER_LIST } from '../config.js';
import { uiState, formatScore, ordinal } from './hud.js';

const NAME_KEY = 'miami-devour:name';
const MAX_NAME = 12;

/** Fallback handles, in the same register as the bot names. */
const RANDOM_NAMES = [
  'Sinkhole', 'Abyss', 'Undertow', 'Nightfall', 'Maw', 'Gulf',
  'Vortex', 'Kraken', 'Riptide', 'Cyclone', 'Eclipse', 'Zenith',
];

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

    this._cd = -99;
    this.playerName = readName();

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
  /* TITLE / MENU                                                           */
  /* ====================================================================== */

  showMenu(stats = {}) {
    const mins = Math.floor(MATCH.DURATION / 60);
    const secs = String(MATCH.DURATION % 60).padStart(2, '0');
    this.el.innerHTML = `
      <div class="scr veil">
        <div class="aurora"></div>
        <div class="menu-in">
          <div class="eyebrow">Brickell &middot; Biscayne Bay</div>
          <h1 class="title"><span class="tl">Miami</span><span class="tl">Devour</span></h1>
          <p class="tagline">
            You are a hole in the middle of Brickell. Swallow the city &mdash; litter,
            then cars, then the <b>towers themselves</b>. Eat your rivals.
            Be the biggest when the clock hits zero.
          </p>

          <div class="name-row">
            <span class="k">Name</span>
            <input id="name-in" maxlength="${MAX_NAME}" spellcheck="false"
                   autocomplete="off" placeholder="YOU" value="${esc(this.playerName)}">
            <button class="dice" id="name-dice" title="Random name">&#8635;</button>
          </div>

          <button class="btn" id="play-btn">Play</button>
          <div class="key-hint">or press <kbd>Space</kbd></div>

          <div class="howto">
            <div class="card" style="--cc:var(--aqua)">
              <span class="n">1</span>
              <h4>Move</h4>
              <p><kbd>WASD</kbd> or the arrows. Drag with the mouse, or use a thumb on touch.</p>
            </div>
            <div class="card" style="--cc:var(--sun)">
              <span class="n">2</span>
              <h4>Grow</h4>
              <p>Every object you swallow widens the hole. Each new size unlocks a bigger tier.</p>
            </div>
            <div class="card" style="--cc:var(--hot)">
              <span class="n">3</span>
              <h4>Devour</h4>
              <p>Bigger holes eat smaller holes. In the last ${MATCH.FRENZY_AT}s everything is edible.</p>
            </div>
          </div>

          <div class="foot">
            <span><b>${mins}:${secs}</b> match</span>
            <span><b>${MATCH.BOT_COUNT + 1}</b> holes</span>
            <span><b>${esc(String(stats.objects ?? '—'))}</b> edible objects</span>
            <span><b>${TIER_LIST.length}</b> size tiers</span>
          </div>
        </div>
      </div>`;
    this.el.style.pointerEvents = 'auto';

    const input = this.el.querySelector('#name-in');
    const commit = () => {
      this.playerName = cleanName(input.value) || 'You';
      writeName(this.playerName);
    };
    input.addEventListener('input', commit);
    // game.js listens for Space on window to start the match. Without this the
    // space bar both types and launches, mid-word.
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.code === 'Enter' || e.code === 'NumpadEnter') { commit(); this._start(); }
    });

    this.el.querySelector('#name-dice').addEventListener('click', () => {
      input.value = RANDOM_NAMES[(Math.random() * RANDOM_NAMES.length) | 0];
      commit();
    });

    this.el.querySelector('#play-btn').addEventListener('click', () => { commit(); this._start(); });
  }

  /**
   * Hand off to game.js, then stamp the entered name onto the hole it just
   * created. game.js owns hole construction and reads its name from the net
   * config; until it reads `screens.playerName` instead, this is the seam.
   */
  _start() {
    uiState.reset();
    if (this.onPlay) this.onPlay();
    const g = typeof window !== 'undefined' ? window.__GAME__ : null;
    if (g && g.player && this.playerName) g.player.name = this.playerName;
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
  showResults(summary, me) {
    const { rankings = [], winner, rank = 1, total = 1, score = 0,
            diameter = 0, won = false, stats = {} } = summary || {};
    const suffix = ordinal(rank);

    const stat = (label, value) =>
      `<div class="stat"><span class="sv">${value}</span><span class="sl">${label}</span></div>`;

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
              ${won ? 'You were the biggest hole in Miami'
                    : `<b>${escapeHtml(winner ? winner.name : '—')}</b> took the city`}
            </div>
          </div>

          <div class="rs-stats">
            ${stat('Final score', Math.round(score).toLocaleString())}
            ${stat('Hole size', `${diameter.toFixed(1)}<span class="u">m</span>`)}
            ${stat('Devoured', (stats.devoured || 0).toLocaleString())}
            ${stat('Rivals eaten', stats.rivalsEaten || 0)}
            ${bestMealStat(stats, stat)}
          </div>

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
      const scr = this.el.querySelector('.results-screen');
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

function esc(s) {
  return String(s).replace(/[&<>"']/g, (m) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
  ));
}

/** Alias: the results screen was written against this name. */
const escapeHtml = esc;

function cap1(s) {
  const t = String(s || '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function cleanName(s) {
  // Markup characters out: the name is interpolated into HTML in both the
  // leaderboard rows and the results list.
  return String(s || '')
    .replace(/[<>&"'`\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
}

function readName() {
  try { return cleanName(localStorage.getItem(NAME_KEY)) || ''; } catch { return ''; }
}

function writeName(v) {
  try { localStorage.setItem(NAME_KEY, v); } catch { /* private mode: ignore */ }
}
