/**
 * HUD — everything drawn over the game while a round is running: the clock,
 * the leaderboard, the size/unlock meter, the kill feed, floating score
 * numbers, the minimap and the transient feedback states (frenzy, death and
 * respawn, first-minute hints).
 *
 * CONTRACT (called from src/game.js, do not break):
 *   new HUD(root, camera) · hud.root
 *   setTimer(s) · setLeaderboard(holes, me) · setSize(hole)
 *   pushFeed(html, color) · syncPopups(effects, camera) · drawMinimap(h, me, layout)
 *   showCaption(c) · clearCaptions()
 *   setPowerups(list) · showPowerupBanner({name, seconds, id, kind})
 *   setHeat({tier, value})
 *   setEventBanner({name, seconds, id}) · clearEventBanner() · setEventMarker({x,z,r})
 *   setSubtitles(on) · openAudioSettings() / closeAudioSettings()
 *   Every one of the new setters is a no-op when handed null or nothing.
 *
 * PERFORMANCE POSTURE
 *   Every one of those methods runs at frame rate. The rule followed here is:
 *   touch the DOM only when a value a human could notice has changed. Text is
 *   compared before it is written, rows are only reordered when the order
 *   actually differs, and the map's static layer is cached (see minimap.js).
 */

import * as THREE from 'three';
import { TIER_LIST, MATCH, HOLE, WORLD } from '../config.js';
import { Minimap } from './minimap.js';
import { audio } from '../core/audio.js';
// The HUD's own sheet. index.html links every OTHER css/*.css by hand but not
// this one, so without this import .ob-warn, the captions and everything added
// below render completely unstyled. Same pattern the screen modules use.
import './css/hud.css';

/** Tier accent ramp — mirrors --t0..--t7 in styles.css. */
const TIER_COLORS = [
  '#d7dde6', '#9fe4ff', '#37e6d5', '#4dff9e',
  '#ffc93c', '#ff9430', '#ff3d8b', '#c58cff',
];

/* ===========================================================================
 * POWER-UPS / HEAT / EVENTS — presentation-only tables
 *
 * Deliberately NOT imported from gameplay/powerups.js or gameplay/heat.js.
 * setPowerups() is handed everything it needs (PowerupSystem.activeFor()
 * already returns id/name/icon/css/description/remaining/duration/frac), so
 * the HUD stays a pure sink: it can be driven by a test harness, by the
 * network, or by nothing at all without dragging two gameplay modules into the
 * UI bundle. These are FALLBACKS for a caller that passes only an id, and the
 * values are copied from the definitions they mirror.
 * ======================================================================== */

/** Mirrors POWERUPS in src/gameplay/powerups.js (icon/css/name/shape). */
const POWERUP_FALLBACK = {
  vacuum: { name: 'VACUUM BOOST', icon: '◎', css: '#37e6d5', shape: 'ring',
    description: 'Suction reaches past the rim. Loose props slide in.' },
  turbo: { name: 'TURBO DRAIN', icon: '»', css: '#ffc93c', shape: 'cone',
    description: 'Faster, and turns like it means it.' },
  mass: { name: 'MASS SURGE', icon: '◈', css: '#ff3d8b', shape: 'octa',
    description: 'Briefly wider. Score and growth are untouched.' },
};

/** Mirrors POWERUP_ORDER in src/gameplay/powerups.js. Row order must be STABLE
 *  — a rail that reshuffles when one boost expires is a rail nobody can read. */
const POWERUP_RANK = { vacuum: 0, turbo: 1, mass: 2 };

/**
 * Heat tiers 0..3, matching the ladder in src/gameplay/heat.js (HEAT.UP).
 *
 * ACCESSIBILITY (spec §6): every tier carries a NUMBER, a WORD and a distinct
 * GLYPH, so the meter is fully readable with the colour thrown away. `hint` is
 * the plain-English "how do I cool down" line the spec asks for; the wording
 * matches the feed line heat.js already pushes, so the two never contradict.
 */
const HEAT_TIERS = [
  { label: 'CLEAR', glyph: '○', hint: 'The city has lost interest.' },
  { label: 'NOTICED', glyph: '◔', hint: 'Stop eating city property and it cools off.' },
  { label: 'PATROLS', glyph: '◑', hint: 'Drive away from patrol cars to cool down.' },
  { label: 'RESPONSE', glyph: '●', hint: 'Leave the response zone — distance cools you fastest.' },
];

/** Circumference of the r=15.5 countdown ring in the 36x36 viewBox below. */
const RING_LEN = 2 * Math.PI * 15.5;

/**
 * localStorage key for the in-match audio mixer.
 *
 * Namespaced the same way every other persisted key in this project is
 * ('miami-devour:map', 'miami-devour:mode', 'miami-devour:profile:v1') so a
 * reader can tell at a glance which app owns it, and versioned so a shape
 * change is a new key rather than a crash on an old blob.
 */
const AUDIO_PREFS_KEY = 'miami-devour:audio:v1';

/**
 * Starting mix. `music` and `sfx` are the same numbers profile.js ships as its
 * defaults, so opening this panel on a fresh install does not silently move the
 * mix the meta Settings screen would have shown.
 */
const AUDIO_DEFAULTS = {
  /* 0.85, matching Audio's own `this._volume` (audio.js:408). hud.js is the ONLY
     caller of audio.setVolume, and the constructor pushes these prefs
     unconditionally — so a default of 1 here silently made the whole game
     louder for every player on first load, and the first slider drag persisted
     that over the shipped level for good. */
  master: 0.85, music: 0.6, sfx: 0.9, voice: 1,
  muted: false, voicesMuted: false, subtitles: true,
};

/** The four sliders, in mixing order (widest bus first). */
const AUDIO_SLIDERS = [
  { key: 'master', icon: '🔊', name: 'Master' },
  { key: 'music', icon: '🎵', name: 'Music' },
  { key: 'sfx', icon: '💥', name: 'Effects' },
  { key: 'voice', icon: '🗣️', name: 'Voices' },
];

/**
 * The three switches. Each carries its own ON/OFF WORD rather than relying on
 * the knob's position or colour — spec §6, and the reason `onWord` is not just
 * "ON" for the two mutes: "Mute all: ON" is genuinely ambiguous.
 */
const AUDIO_TOGGLES = [
  { key: 'muted', icon: '🔇', name: 'Mute all', onWord: 'MUTED', offWord: 'AUDIBLE' },
  { key: 'voicesMuted', icon: '🤫', name: 'Mute voices', onWord: 'MUTED', offWord: 'AUDIBLE' },
  { key: 'subtitles', icon: '💬', name: 'Subtitles', onWord: 'ON', offWord: 'OFF' },
];

/**
 * Reduced motion, from the OS query OR the in-app toggle (settings.js stamps
 * `.reduced-motion` on <html>). Everything the CSS animates is also gated in
 * @media (prefers-reduced-motion: reduce); this is for the things only JS can
 * decide, i.e. the pulsing marker painted into the minimap canvas.
 */
let _prefersReduce = false;
try {
  if (typeof window !== 'undefined' && window.matchMedia) {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    _prefersReduce = !!mq.matches;
    const onMq = (e) => { _prefersReduce = !!e.matches; };
    if (mq.addEventListener) mq.addEventListener('change', onMq);
    else if (mq.addListener) mq.addListener(onMq);
  }
} catch { /* no matchMedia: animate, which is the pre-existing behaviour */ }

/**
 * Coerce whatever the gameplay side calls a colour into something CSS accepts.
 *
 * NOT COSMETIC PARANOIA: POWERUPS[id].color is a THREE hex NUMBER (0x37e6d5)
 * and .css is the string beside it; cityEvents' def.color is a string. Feeding
 * the number straight into a custom property writes `--pc: 3663061`, which is
 * silently invalid — the row falls back to white and nobody sees an error.
 * This file has already shipped one class of bug that fails exactly that
 * quietly.
 */
function cssColor(v, fallback) {
  if (typeof v === 'string' && v) return v;
  if (typeof v === 'number' && Number.isFinite(v)) {
    return `#${((v >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`;
  }
  return fallback;
}

function reduceMotion() {
  if (_prefersReduce) return true;
  return typeof document !== 'undefined'
    && document.documentElement.classList.contains('reduced-motion');
}

/**
 * The meta-layer profile, if the meta layer is in this build.
 *
 * WHY LAZY, AND WHY AT ALL: profile.data.settings already owns `music` and
 * `sfx` for the meta Settings screen. Two persisted copies of one slider is how
 * a player's mix silently reverts, so the panel below mirrors those two values
 * back into the profile. It is a *dynamic* import so hud.js keeps working —
 * and keeps persisting, in its own key — in a build with no meta layer.
 * The promise never rejects, so a queued write is never lost.
 */
let _profileP = null;
function withProfile(fn) {
  if (typeof document === 'undefined') return;
  if (!_profileP) _profileP = import('../meta/profile.js').catch(() => null);
  _profileP.then((m) => {
    if (!m || !m.profile || !m.profile.data || !m.profile.data.settings) return;
    try { fn(m.profile); } catch { /* a broken profile must not break the mixer */ }
  });
}

/**
 * Cross-screen UI state. The results screen wants a fact only the live HUD ever
 * sees — the player's biggest single meal. Both files are part of the same UI
 * layer, so they share this rather than pushing extra fields onto gameplay
 * objects or asking game.js for another call.
 */
export const uiState = {
  /** @type {{label:string, score:number}|null} */
  bestMeal: null,
  reset() { this.bestMeal = null; },
};

/**
 * Caption text comes from a data file but is injected as innerHTML beside a
 * bold speaker name, so it gets escaped. Cheap, and it lets a line contain an
 * apostrophe or an ampersand without breaking the row.
 */
function escapeHtml(s) {
  return String(s).replace(/[&<>"\']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}


export class HUD {
  constructor(root, camera) {
    this.camera = camera;

    // Own a dedicated layer so Screens (a sibling) is never clobbered.
    const layer = document.createElement('div');
    layer.id = 'hud-layer';
    layer.style.position = 'absolute';
    layer.style.inset = '0';
    layer.style.pointerEvents = 'none';
    layer.style.transition = 'opacity .25s ease';
    root.appendChild(layer);
    this.root = layer;

    layer.innerHTML = `
      <div class="hud-scrim top"></div>
      <div class="hud-scrim bottom"></div>

      <div id="hud-timer" class="panel">
        <div class="lbl">Time left</div>
        <div class="val">2:30</div>
        <div class="trk"><i></i></div>
      </div>

      <div id="hud-frenzy"><span class="fz-t">FRENZY</span><span class="fz-s">Everything is edible</span></div>

      <div id="hud-board" class="panel">
        <div class="hd"><span class="ttl">Leaderboard</span><span class="mine">&mdash;</span></div>
        <div class="list"></div>
        <div id="hud-rank"><span class="ar">&#9650;</span><span class="n">1<sup>st</sup></span><span class="k">Place</span></div>
      </div>

      <div id="hud-feed"></div>

      <div id="hud-size" class="panel">
        <div class="top">
          <div class="badge"><span class="n">1</span></div>
          <div class="txt">
            <div class="tier"><span class="lbl">Litter</span><span class="grace">Safe 0.0</span></div>
            <div class="dia"><span class="n">2.3</span><span class="u">m</span></div>
          </div>
        </div>
        <div class="nxt"><span class="k">Next</span><span class="v">Street furniture</span><span class="p">0%</span></div>
        <div class="trk"><i class="fill"></i></div>
        <div class="pips"></div>
      </div>

      <div id="hud-tierup"><div class="k">Tier unlocked</div><div class="v">&nbsp;</div></div>

      <div id="hud-map" class="panel">
        <canvas></canvas>
        <div class="frame"><i></i><i></i><i></i><i></i></div>
      </div>

      <div id="hud-dead">
        <div class="card">
          <div class="k">Devoured by</div>
          <div class="v">&nbsp;</div>
          <div class="bar"><i></i></div>
          <div class="rs">Respawning in 0.0s</div>
        </div>
      </div>

      <div id="hud-toast"></div>
      <div id="hud-popups"></div>
      <div id="hud-stick"><i class="ring"></i><i class="knob"></i></div>
    `;

    /* ------------------------------------------------------------------ *
     * POWER-UPS / HEAT / EVENTS / AUDIO — appended, never merged into the
     * template above. Keeping them in their own insert means the original
     * markup can be edited by whoever owns it without a three-way conflict.
     *
     * The status rail sits on the RIGHT, directly above the minimap. The
     * bottom-left column looks emptier but is not: #hud-tierup parks itself at
     * `left: 1.05em; bottom: 9.4em` for 2.4 s on every tier unlock, and a
     * power-up rail there would be covered exactly when a player is most
     * likely to be reading it.
     * ------------------------------------------------------------------ */
    layer.insertAdjacentHTML('beforeend', `
      <div id="hud-event" role="status" aria-live="polite" aria-atomic="true">
        <span class="ev-ic" aria-hidden="true"></span>
        <span class="ev-tx"><b class="ev-nm"></b><span class="ev-sub"></span></span>
        <span class="ev-cd"><b class="ev-n">0</b><span class="ev-u">s</span></span>
        <i class="ev-bar"><b></b></i>
      </div>

      <div id="hud-status">
        <div id="hud-pow" role="group" aria-label="Active power-ups"></div>
        <div id="hud-heat" data-tier="0">
          <div class="ht-hd">
            <span class="ht-ic" aria-hidden="true">○</span>
            <b class="ht-k">HEAT 0</b>
            <span class="ht-v">CLEAR</span>
          </div>
          <div class="ht-seg" role="img" aria-label="Heat tier 0 of 3">
            <i></i><i></i><i></i>
          </div>
          <div class="ht-hint">The city has lost interest.</div>
        </div>
        <button id="hud-audio-btn" class="hud-tap" type="button"
                aria-expanded="false" aria-controls="hud-audio"
                aria-label="Audio settings" title="Audio settings">
          <span class="ab-ic" aria-hidden="true">&#128266;</span>
          <span class="ab-lbl">AUDIO</span>
        </button>
      </div>

      <div id="hud-powbanner" role="status" aria-live="polite"></div>

      <div id="hud-audio" class="hud-tap" role="dialog" aria-modal="false"
           aria-label="Audio settings" hidden></div>
    `);

    const $ = (s) => layer.querySelector(s);
    this.timerEl = $('#hud-timer');
    this.timerVal = $('#hud-timer .val');
    this.timerBar = $('#hud-timer .trk > i');
    this.frenzyEl = $('#hud-frenzy');
    this.rankEl = $('#hud-rank');
    this.boardEl = $('#hud-board');
    this.listEl = $('#hud-board .list');
    this.myRankEl = $('#hud-board .mine');
    this.feedEl = $('#hud-feed');
    this.sizeEl = $('#hud-size');
    this.badgeEl = $('#hud-size .badge .n');
    this.tierEl = $('#hud-size .tier .lbl');
    this.graceEl = $('#hud-size .grace');
    this.diaEl = $('#hud-size .dia .n');
    this.nextEl = $('#hud-size .nxt .v');
    this.pctEl = $('#hud-size .nxt .p');
    this.fillEl = $('#hud-size .trk .fill');
    this.pipsEl = $('#hud-size .pips');
    this.tierUpEl = $('#hud-tierup');
    this.tierUpVal = $('#hud-tierup .v');
    this.deadEl = $('#hud-dead');
    this.deadName = $('#hud-dead .v');
    this.deadTime = $('#hud-dead .rs');
    this.deadBar = $('#hud-dead .bar > i');
    this.toastEl = $('#hud-toast');
    this.popupEl = $('#hud-popups');
    this.stickEl = $('#hud-stick');
    this.mapCanvas = $('#hud-map canvas');

    /* --- power-ups / heat / events / audio ------------------------------ */
    this.evtEl = $('#hud-event');
    this.evtIc = $('#hud-event .ev-ic');
    this.evtNm = $('#hud-event .ev-nm');
    this.evtSub = $('#hud-event .ev-sub');
    this.evtNum = $('#hud-event .ev-n');
    this.evtBar = $('#hud-event .ev-bar > b');
    this.statusEl = $('#hud-status');
    this.powEl = $('#hud-pow');
    this.heatEl = $('#hud-heat');
    this.heatIc = $('#hud-heat .ht-ic');
    this.heatKey = $('#hud-heat .ht-k');
    this.heatVal = $('#hud-heat .ht-v');
    this.heatSeg = $('#hud-heat .ht-seg');
    this.heatSegs = [...this.heatSeg.children];
    this.heatHint = $('#hud-heat .ht-hint');
    this.powBanner = $('#hud-powbanner');
    this.audioBtn = $('#hud-audio-btn');
    this.audioPanel = $('#hud-audio');

    /** Same 2d context minimap.js draws through — the event marker is painted
     *  INTO the existing map, never onto a second canvas. */
    this.mapCtx = this.mapCanvas.getContext('2d');

    // One pip per size tier; the whole progression is legible at a glance.
    this.pipsEl.innerHTML = TIER_LIST
      .map((_, i) => `<i style="--pc:${TIER_COLORS[i]}"></i>`).join('');
    this.pipEls = [...this.pipsEl.children];

    this.minimap = new Minimap(this.mapCanvas);

    /* ---- per-frame bookkeeping ---------------------------------------- */
    this._popups = [];
    this._rows = new Map();          // hole.id -> {el, nm, sc, dot, rk, disp}
    this._order = '';
    this._members = '';
    this._v = new THREE.Vector3();
    this._now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    this._dt = 1 / 60;

    this._lastSecs = -1;
    this._lastTier = -1;
    this._lastRank = 0;
    this._lastDia = '';
    this._lastPct = -1;
    this._lastScore = 0;
    this._lastEat = 0;
    this._lastReorder = 0;
    this._grace = false;
    this._frenzy = false;
    this._dead = false;
    this._hints = new Set();
    this._feedItems = [];
    /** Seconds a kill-feed line stays up. Field, not a constant, so the
     *  screenshot harness can hold the feed open while it composites. */
    this.feedTTL = 7.5;

    /* --- power-up rail --------------------------------------------------
     * Rows are POOLED by id. Rebuilding three <div>s a frame is cheap in
     * isolation and ruinous next to the leaderboard's FLIP, which measures
     * offsetTop on every row it owns — a sibling that keeps re-inserting nodes
     * forces those reads to be synchronous layouts. */
    /** @type {Map<string, object>} id -> row record */
    this._pu = new Map();
    this._puEndAt = new Map();      // id -> _now of the last "ended" card
    this._puCards = [];

    /* --- heat ----------------------------------------------------------- */
    this._heatTier = -1;
    this._heatPct = -1;
    this._heatHideAt = 0;           // tier 0 lingers briefly, then the block goes
    this._heatOn = false;

    /* --- city event ------------------------------------------------------ */
    this._evtId = null;
    this._evtLeft = 0;
    this._evtSpan = 0;
    this._evtShownSecs = -1;
    /** @type {{x:number,z:number,r:number}|null} drawn into the minimap. */
    this._evtMarker = null;

    /* --- audio mixer ------------------------------------------------------ */
    /**
     * The VoiceSystem, if the integrator hands it over (`hud.voice = game.voice`).
     * Optional: setSubtitles() falls back to window.__GAME__.voice and, failing
     * that, to hiding the captions in CSS. Declared here so the property always
     * exists rather than being conjured by an assignment somewhere else.
     * @type {{setSubtitles?:Function}|null}
     */
    this.voice = null;
    this._audioPrefs = this._loadAudioPrefs();
    this._audioOpen = false;
    this._audioRows = null;
    this._hudShown = null;          // tri-state: null = "not decided yet"

    // gameplay/match.js resolves its escalation lines through this global
    // before falling back to DEV — claiming it is what makes clock milestones
    // and lead changes reach the feed in a build with no dev harness.
    globalThis.__miamiHUD = this;

    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', this._resize);
    this._resize();
    this._installTouchStick();
    this._installAudioSettings();
    this._watchVisibility();
    // Restore the saved mix. Runs LAST in the constructor: _installAudioSettings
    // has to have built the rows first or there is nothing to write the values
    // into, and applying before the DOM exists was one of the three TDZ-shaped
    // bugs this file has already shipped.
    this._applyAudioPrefs();
  }

  /* ====================================================================== */
  /* LAYOUT                                                                 */
  /* ====================================================================== */

  /**
   * One scale knob drives every HUD dimension (see the em model in styles.css).
   * Short viewports get a smaller floor so a phone held sideways is not 60% HUD.
   */
  _resize() {
    const w = window.innerWidth || 1600;
    const h = window.innerHeight || 900;
    // The floor is a LEGIBILITY floor, not a layout one: below it the 0.6em
    // labels stop being readable. Measured on a 1024x600 laptop, where the old
    // 0.74 put the smallest rendered glyph at 6.5 px.
    const floor = h < 520 ? 0.66 : 0.78;
    const s = Math.max(floor, Math.min(1.28, Math.min(w / 1500, h / 850)));
    document.documentElement.style.setProperty('--s', s.toFixed(3));
    // Fewer feed lines on a short screen — five wrapped ones are most of the
    // left-hand column when the viewport is 390 px tall.
    this.maxFeed = h < 560 ? 3 : 5;
    // The map canvas backing store must follow the CSS box, not the other way.
    const box = this.mapCanvas.getBoundingClientRect();
    this.minimap.resize(box.width || 176, window.devicePixelRatio || 1);
  }

  /* ====================================================================== */
  /* TIMER + FRENZY                                                         */
  /* ====================================================================== */

  setTimer(seconds) {
    // First per-frame call from game.js, so this is where dt is measured.
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    this._dt = Math.min(0.1, Math.max(0.0005, now - this._now));
    this._now = now;

    // The clock only ever runs down, so time going UP means a fresh round.
    // game.js has no "new match" call into the HUD, and match-scoped state
    // (frenzy banner, one-shot hints, rank history) must not survive one.
    if (seconds > this._lastSecs + 1) this._resetMatchState();

    const s = Math.max(0, Math.ceil(seconds));
    if (s !== this._lastSecs) {
      this._lastSecs = s;
      const m = Math.floor(s / 60);
      this.timerVal.textContent = `${m}:${String(s % 60).padStart(2, '0')}`;
      this.timerBar.style.transform = `scaleX(${Math.max(0, Math.min(1, seconds / MATCH.DURATION))})`;
      this.timerEl.classList.toggle('warn', s <= 60 && s > MATCH.FRENZY_AT);
      this.timerEl.classList.toggle('urgent', s <= MATCH.FRENZY_AT);
    }

    if (!this._frenzy && seconds <= MATCH.FRENZY_AT && seconds > 0) {
      this._frenzy = true;
      this.frenzyEl.classList.add('on');
      // Big for the announcement, then it shrinks to a persistent reminder so
      // the player is never in doubt about why everything suddenly fits.
      clearTimeout(this._frenzyT);
      this._frenzyT = setTimeout(() => this.frenzyEl.classList.add('slim'), 2600);
    }

    // Early-game teaching moment: explain the size gate before the player
    // works it out by bouncing off a car.
    const elapsed = MATCH.DURATION - seconds;
    if (elapsed > 2.5 && elapsed < 30) {
      this.toast('gate', '<span class="ic">!</span>Swallow only what <b>fits</b> &mdash; start on litter and cones', 7.5);
    }

    // Power-up and event countdowns ride the clock this method already
    // measures, so they keep ticking whether the game pushes them every frame
    // or only when something changes. See _tickOverlays().
    this._tickOverlays();
  }

  _resetMatchState() {
    this._frenzy = false;
    this.frenzyEl.classList.remove('on', 'slim');
    clearTimeout(this._frenzyT);
    this._hints.clear();
    this.toastEl.innerHTML = '';
    this._lastRank = 0;
    this._lastTier = -1;
    this._lastScore = 0;
    this._lastEat = 0;
    this._dead = false;
    this.deadEl.classList.remove('on');
    for (const item of this._feedItems.slice()) this._dropFeed(item);
    // Nothing from the previous round may survive into this one: a stale
    // "VACUUM BOOST 12s" or a storm banner counting down over a fresh match is
    // the exact class of bug §7 of the spec calls "unreset world state".
    this._retireAllPowerups(false);
    this.setHeat(null);
    this.clearEventBanner();
    this.setEventMarker(null);
    uiState.reset();
  }

  /* ====================================================================== */
  /* LEADERBOARD                                                            */
  /* ====================================================================== */

  setLeaderboard(holes, me) {
    // Same comparator as Match._rank(). Score alone leaves two holes on zero
    // trading places every frame, and — worse — lets the board disagree with
    // the rank the match itself believes in, so the crowned leader on the
    // minimap could be sitting second here.
    const sorted = [...holes].sort(
      (a, b) => (b.score - a.score) || (b.eatCount - a.eatCount) || (a.id - b.id)
    );
    const cap = window.innerHeight < 560 ? 5 : 8;
    const shown = sorted.slice(0, cap);
    const ranks = shown.map((_, i) => i + 1);

    // The player must always be on the board, even sitting in 11th — an
    // out-of-frame rank is exactly the moment you need to see it. The pinned
    // row keeps its TRUE rank: stamping the slot index there printed "5" next
    // to a player the header simultaneously called 7th.
    const myRank = me ? sorted.indexOf(me) + 1 : 0;
    if (me && myRank > cap) {
      shown[shown.length - 1] = me;
      ranks[ranks.length - 1] = myRank;
    }

    const members = shown.map((h) => h.id).sort((a, b) => a - b).join(',');
    if (members !== this._members) {
      this._members = members;
      this._rebuildRows(shown, me);
    }

    // Reorder on a cooldown, and stamp the rank numbers in the SAME step.
    // During the frenzy every hole's score moves on every frame; unthrottled,
    // the board is permanently mid-transition and reads as a smear of
    // overlapping rows. One move per 0.35 s lets each 0.26 s slide land. The
    // rank digits ride along so a row's number always matches its slot.
    //
    // The key carries the ranks, not just the ids: when the player is pinned
    // into the last slot their number changes while the slot order does not,
    // and keying on order alone froze that digit for the rest of the match.
    const order = shown.map((h, i) => `${h.id}:${ranks[i]}`).join(',');
    if (order !== this._order && this._now - this._lastReorder > 0.35) {
      this._flipReorder(shown);
      this._order = order;
      this._lastReorder = this._now;
      for (let i = 0; i < shown.length; i++) {
        const row = this._rows.get(shown[i].id);
        if (!row) continue;
        const rank = ranks[i];
        if (rank === row.rank) continue;
        row.rank = rank;
        row.rk.textContent = String(rank);
        // classList, not className: FLIP's `slide` class must survive this.
        row.el.classList.toggle('p1', rank === 1);
        row.el.classList.toggle('p2', rank === 2);
        row.el.classList.toggle('p3', rank === 3);
      }
    }

    /* --- per-row values: only written when the rendered text changes ---- */
    const ease = 1 - Math.exp(-11 * this._dt);
    for (let i = 0; i < shown.length; i++) {
      const h = shown[i];
      const row = this._rows.get(h.id);
      if (!row) continue;

      row.disp += (h.score - row.disp) * ease;
      if (Math.abs(h.score - row.disp) < 0.6) row.disp = h.score;
      const txt = formatScore(row.disp);
      if (txt !== row.text) {
        row.text = txt;
        row.sc.textContent = txt;
      }
      // A meal worth noticing gets the score a punch of its own — throttled,
      // because restart() forces a reflow and a late-game hole clears 50
      // points every single frame, which would be eight sync layouts a frame.
      if (h.score - row.prev >= 50 && this._now - row.bumpAt > 0.4) {
        row.bumpAt = this._now;
        restart(row.sc, 'bump');
      }
      row.prev = h.score;

      if (row.alive !== h.alive) {
        row.alive = h.alive;
        row.el.classList.toggle('dead', !h.alive);
      }
    }

    /* --- the player's own rank, and how it changed ---------------------- */
    if (!me || myRank <= 0) return;
    if (myRank !== this._lastRank) {
      const first = this._lastRank === 0;
      const improved = !first && myRank < this._lastRank;
      this.myRankEl.innerHTML = `${myRank}<sup>${ordinal(myRank)}</sup>`;
      if (!first) {
        this._flashRank(myRank, improved);
        if (improved) {
          const row = this._rows.get(me.id);
          if (row) restart(row.el, 'gain');
        }
      }
      this._lastRank = myRank;
    }
  }

  _rebuildRows(shown, me) {
    this.listEl.innerHTML = '';
    const keep = new Set();
    for (const h of shown) {
      keep.add(h.id);
      let row = this._rows.get(h.id);
      if (!row) {
        const el = document.createElement('div');
        el.innerHTML = '<span class="rk"></span><span class="dot"></span>' +
                       '<span class="nm"></span><span class="sc">0</span>';
        row = {
          el,
          rk: el.querySelector('.rk'),
          dot: el.querySelector('.dot'),
          nm: el.querySelector('.nm'),
          sc: el.querySelector('.sc'),
          disp: h.score, prev: h.score, text: '', rank: -1, alive: true, bumpAt: 0,
        };
        this._rows.set(h.id, row);
      }
      // className reset wipes p1/p2/p3/dead; null the caches so the next tick
      // re-stamps them instead of thinking they are already applied.
      row.el.className = h === me ? 'row me' : 'row';
      row.rank = -1;
      row.alive = null;
      const hex = `#${h.color.getHexString()}`;
      row.nm.textContent = h.name;
      row.dot.style.background = hex;
      row.dot.style.color = hex;
      this.listEl.appendChild(row.el);
    }
    for (const id of [...this._rows.keys()]) if (!keep.has(id)) this._rows.delete(id);
    // A rebuild reorders the DOM immediately, so the rank digits must be
    // re-stamped on the very next tick — clearing the cooldown stops them
    // lagging a third of a second behind the slots they label.
    this._order = '';
    this._lastReorder = 0;
  }

  /**
   * FLIP: measure where each row was, put it back there with a transform, then
   * let CSS glide it to its new slot. Rank changes have to be *seen*, and a
   * board that snaps is a board nobody reads.
   */
  _flipReorder(shown) {
    const before = new Map();
    for (const [id, row] of this._rows) before.set(id, row.el.offsetTop);
    for (const h of shown) {
      const row = this._rows.get(h.id);
      if (row) this.listEl.appendChild(row.el);
    }
    for (const h of shown) {
      const row = this._rows.get(h.id);
      if (!row) continue;
      const d = (before.get(h.id) ?? row.el.offsetTop) - row.el.offsetTop;
      if (!d) continue;
      row.el.classList.remove('slide');
      row.el.style.transform = `translateY(${d}px)`;
      void row.el.offsetWidth;                 // commit the parked position
      row.el.classList.add('slide', 'moving');
      row.el.style.transform = '';
      clearTimeout(row.moveT);
      row.moveT = setTimeout(() => row.el.classList.remove('moving'), 300);
    }
  }

  _flashRank(rank, improved) {
    const el = this.rankEl;
    el.className = rank === 1 ? 'lead' : improved ? 'up' : 'down';
    el.querySelector('.ar').innerHTML = improved ? '&#9650;' : '&#9660;';
    el.querySelector('.n').innerHTML = `${rank}<sup>${ordinal(rank)}</sup>`;
    el.querySelector('.k').textContent = rank === 1 ? 'You lead' : 'Place';
    restart(el, 'on');
  }

  /* ====================================================================== */
  /* SIZE / UNLOCK METER                                                    */
  /* ====================================================================== */

  setSize(hole) {
    /* --- being eaten: takes over the whole read ------------------------- */
    if (!hole.alive) {
      if (!this._dead) {
        this._dead = true;
        this.deadEl.classList.add('on');
        this.deadName.textContent = hole.killedBy ? hole.killedBy.name : 'the city';
      }
      const left = Math.max(0, hole.respawnAt);
      this.deadTime.textContent = `Respawning in ${left.toFixed(1)}s`;
      // A draining bar beats a spinner: it says how long, not just "waiting".
      this.deadBar.style.width = `${(1 - Math.min(1, left / HOLE.RESPAWN_TIME)) * 100}%`;
      return;
    }
    if (this._dead) {
      this._dead = false;
      this.deadEl.classList.remove('on');
    }

    /* --- biggest single meal, for the results screen --------------------
     * Score deltas are the only per-meal signal the HUD is handed, so the
     * "best meal" is reconstructed from a jump plus the label the hole was
     * carrying at that moment. Gating on eatCount moving by exactly one is
     * what makes it a MEAL rather than a frame total: at 60 fps a big hole
     * swallows three things in a tick, and a respawn or a dev size-set moves
     * the score without eating anything at all.                             */
    const gain = hole.score - this._lastScore;
    const bites = (hole.eatCount || 0) - this._lastEat;
    if (bites === 1 && gain > 0 && (!uiState.bestMeal || gain > uiState.bestMeal.score)) {
      uiState.bestMeal = { label: hole.lastMeal || 'the city', score: gain };
    }
    this._lastScore = hole.score;
    this._lastEat = hole.eatCount || 0;

    /* --- current tier and the next unlock ------------------------------- */
    let ti = 0;
    for (let i = 0; i < TIER_LIST.length; i++) {
      if (hole.radius >= TIER_LIST[i].eatRadius) ti = i;
    }
    const cur = TIER_LIST[ti];
    const next = TIER_LIST[ti + 1] || null;

    const dia = (hole.radius * 2).toFixed(1);
    if (dia !== this._lastDia) {
      this._lastDia = dia;
      this.diaEl.textContent = dia;
    }

    // Spawn protection (match.js, HOLE.RESPAWN_GRACE). Without a readout the
    // player has no idea why nothing is hunting them for the first few seconds.
    const grace = hole.spawnGrace || 0;
    const graceOn = grace > 0.05;
    if (graceOn) this.graceEl.textContent = `Safe ${grace.toFixed(1)}`;
    if (graceOn !== this._grace) {
      this._grace = graceOn;
      this.graceEl.classList.toggle('on', graceOn);
    }

    let p = 1;
    if (next) {
      p = (hole.radius - cur.eatRadius) / Math.max(0.001, next.eatRadius - cur.eatRadius);
      p = Math.max(0, Math.min(1, p));
    }
    const pct = Math.round(p * 100);
    if (pct !== this._lastPct) {
      this._lastPct = pct;
      this.fillEl.style.width = `${pct}%`;
      this.pctEl.textContent = next ? `${pct}%` : '';
    }

    if (ti !== this._lastTier) {
      const climbed = ti > this._lastTier && this._lastTier >= 0;
      this._lastTier = ti;
      const c = TIER_COLORS[ti];
      this.sizeEl.style.setProperty('--tier-c', c);
      this.sizeEl.style.setProperty('--fill-a', c);
      this.sizeEl.style.setProperty('--fill-b', TIER_COLORS[Math.min(TIER_COLORS.length - 1, ti + 1)]);
      this.badgeEl.textContent = String(ti + 1);
      this.tierEl.textContent = cur.label;
      this.nextEl.textContent = next ? next.label : 'Everything is edible';
      this.pctEl.textContent = next ? `${pct}%` : '';
      for (let i = 0; i < this.pipEls.length; i++) {
        this.pipEls[i].className = i < ti ? 'done' : i === ti ? 'cur' : '';
      }
      if (climbed) {
        restart(this.sizeEl, 'tierup');
        this.tierUpEl.style.setProperty('--tier-c', c);
        this.tierUpVal.textContent = cur.label;
        restart(this.tierUpEl, 'on');
      }
    }
  }

  /* ====================================================================== */
  /* KILL FEED                                                              */
  /* ====================================================================== */

  /**
   * @param {string} text  HTML (callers use <b> for the actor)
   * @param {string} color accent for the bar and the bold run
   * @param {string} [kind] 'clock' | 'lead' | 'tier' | 'kill' — match.js tags
   *   its escalation lines, so clock ticks can sit quieter than a kill.
   */
  /**
   * NPC dialogue subtitles.
   *
   * Captions are not a nice-to-have here: the voice pack is generated offline
   * and may be absent entirely (fresh clone, no key, generation never run), in
   * which case this is the ONLY form the dialogue takes. So it renders the same
   * whether or not a sound played — `c.spoken` only changes the speaker glyph.
   *
   * Newest at the bottom, three at most, each expiring on its own ttl.
   */
  /**
   * NPC dialogue subtitles.
   *
   * Captions are not decoration: the voice pack is generated offline and may be
   * absent entirely (fresh clone, no key, generator never run), in which case
   * this is the ONLY form the dialogue takes. `c.spoken` only picks the glyph.
   *
   * EACH ROW OWNS ITS OWN REMOVAL. The first version kept a shared `_caps`
   * array and one interval that compared every row's deadline against
   * performance.now(). It removed rows ~200 ms after they appeared while
   * reporting nine seconds of life remaining — two clocks and a shared array
   * that had to agree, and they did not. A per-row setTimeout has no shared
   * state to disagree with, so the bug cannot recur, and it is less code.
   */
  showCaption(c) {
    if (!c || !c.text) return;
    /* Parented to the HUD ROOT, not document.body. On body the captions were
       being removed by something outside this class within a few hundred ms —
       the shell owns body and swaps screens through it, so anything parked
       there is living in someone else's container. The HUD root survives for
       the life of the HUD, which is exactly the lifetime a caption wants. */
    const host = this.root && this.root.isConnected ? this.root : document.body;
    if (!this._capWrap || !host.contains(this._capWrap)) {
      const el = document.createElement('div');
      el.className = 'vo-captions';
      host.appendChild(el);
      this._capWrap = el;
    }
    const wrap = this._capWrap;

    // At most three on screen: oldest out first, so the newest is always read.
    while (wrap.childElementCount >= 3) {
      const first = wrap.firstElementChild;
      if (!first) break;
      if (first._capT) clearTimeout(first._capT);
      first.remove();
    }

    const row = document.createElement('div');
    row.className = 'vo-cap';
    const who = c.castName ? '<b>' + escapeHtml(c.castName) + '</b> ' : '';
    row.innerHTML = '<span class="vo-ic">' + (c.spoken ? '\u{1F5E3}' : '\u{1F4AC}')
      + '</span>' + who + escapeHtml(c.text);
    wrap.appendChild(row);
    void row.offsetWidth;                 // reflow, so the entry transition runs
    row.classList.add('on');

    // Long enough to read even a short line. ttl arrives in SECONDS.
    const ms = Math.max(2200, (Number(c.ttl) > 0 ? Number(c.ttl) : 2.6) * 1000);
    row._capT = setTimeout(() => {
      row.classList.remove('on');
      row._capT = setTimeout(() => row.remove(), 240);
    }, ms);
  }

  /** Wipe every caption, so none survives a match restart. */
  clearCaptions() {
    const wrap = this._capWrap;
    if (!wrap) return;
    for (const row of Array.from(wrap.children)) {
      if (row._capT) clearTimeout(row._capT);
      row.remove();
    }
  }

  pushFeed(text, color = '#ffffff', kind = 'kill') {
    const el = document.createElement('div');
    el.className = 'feed-item';
    el.dataset.kind = kind;
    el.style.setProperty('--fc', color);
    el.innerHTML = text;
    this.feedEl.prepend(el);
    const item = { el, timer: null };
    this._feedItems.push(item);

    // Fade out on its own; a kill feed that only trims on overflow leaves stale
    // lines sitting there for the whole match when the action goes quiet.
    item.timer = setTimeout(() => this._dropFeed(item), this.feedTTL * 1000);
    while (this._feedItems.length > (this.maxFeed || 5)) this._dropFeed(this._feedItems[0]);
  }

  _dropFeed(item) {
    const i = this._feedItems.indexOf(item);
    if (i < 0) return;
    this._feedItems.splice(i, 1);
    clearTimeout(item.timer);
    item.el.classList.add('out');
    setTimeout(() => item.el.remove(), 420);
  }

  /* ====================================================================== */
  /* TOASTS                                                                 */
  /* ====================================================================== */

  /** Show a one-shot hint. `id` makes it idempotent when called every frame. */
  toast(id, html, seconds = 5) {
    if (this._hints.has(id)) return;
    this._hints.add(id);
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = html;
    this.toastEl.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 460);
    }, seconds * 1000);
  }

  /* ====================================================================== */
  /* SCORE POPUPS                                                           */
  /* ====================================================================== */

  /** Drain effects.popups into DOM elements anchored to world positions. */
  syncPopups(effects, camera) {
    for (const p of effects.popups) {
      if (p.__el) continue;
      const val = parseFloat(String(p.text).replace(/[^0-9.]/g, '')) || 0;
      const tier = tierOfScore(val);
      const el = document.createElement('div');
      el.className = `popup t${tier}`;
      el.textContent = p.text;
      el.style.setProperty('--pc', TIER_COLORS[tier]);
      // Late game spawns dozens of these per second on top of each other. Tier
      // decides both the size AND the stacking order, so the number that
      // actually mattered is never buried under a shower of +2s.
      el.style.zIndex = String(tier);
      this.popupEl.appendChild(el);
      p.__el = el;
      p.__tier = tier;
      // Deterministic per-popup fan-out, seeded off the spawn position so two
      // popups from the same object never take the same path.
      // Position alone is not enough: everything inside one tower footprint
      // shares a seed, and the whole shower would take the same path.
      const seed = Math.abs(p.pos.x * 7.13 + p.pos.z * 3.71 + (this._popSeq = (this._popSeq || 0) + 0.618)) % 1;
      p.__dx = (seed - 0.5) * 2;
      p.__dy = 0.6 + seed * 0.8;
      this._popups.push(p);
    }

    const w = window.innerWidth, h = window.innerHeight;
    for (let i = this._popups.length - 1; i >= 0; i--) {
      const p = this._popups[i];
      if (!effects.popups.includes(p)) {
        p.__el.remove();
        this._popups.splice(i, 1);
        continue;
      }
      const t = p.t;
      this._v.copy(p.pos);
      this._v.y += 1 + t * 3.4;
      this._v.project(camera);
      // Behind the camera: project() mirrors the point, which would slap the
      // number on the opposite side of the screen.
      if (this._v.z > 1) { p.__el.style.opacity = '0'; continue; }
      const x = (this._v.x * 0.5 + 0.5) * w + p.__dx * t * 82;
      const y = (-this._v.y * 0.5 + 0.5) * h - p.__dy * t * 26 + t * t * 18;
      // Overshoot punch on spawn, then a slow drift-up scale.
      const punch = t < 0.17 ? 0.5 * (1 - t / 0.17) : 0;
      const scale = 1 + punch + t * 0.2;
      // Small values clear out fast so they cannot fog the big ones.
      const life = p.__tier <= 2 ? 0.5 : 0.72;
      const a = t < life ? 1 : 1 - (t - life) / (1.25 - life);
      p.__el.style.transform =
        `translate(-50%,-50%) translate(${x.toFixed(1)}px,${y.toFixed(1)}px) scale(${scale.toFixed(3)})`;
      p.__el.style.opacity = String(Math.max(0, a));
    }
  }

  /* ====================================================================== */
  /* MINIMAP                                                                */
  /* ====================================================================== */

  drawMinimap(holes, me, layout) {
    this.minimap.draw(holes, me, layout, this._dt);
    // The event zone goes ON TOP of the map minimap.js just finished painting,
    // in the same canvas and the same transform. Drawing it inside Minimap
    // would mean owning a file another pass is editing; drawing it in a second
    // canvas would mean two minimaps that can disagree about where north is.
    if (this._evtMarker) this._drawEventMarker(this._evtMarker);
  }

  /* ====================================================================== */
  /* POWER-UPS                                                              */
  /* ====================================================================== */

  /**
   * The active-power-up rail.
   *
   * @param {Array<{id:string,name?:string,icon?:string,css?:string,color?:string,
   *   description?:string,remaining:number,duration?:number,frac?:number}>} [list]
   *   PowerupSystem.activeFor(hole) returns exactly this shape. Pass null or
   *   omit it and nothing happens; pass [] and everything retires with its end
   *   notification.
   *
   * ACCESSIBILITY (spec §6): every row carries the power-up's NAME in text, a
   * distinct ICON GLYPH, a distinct BORDER STYLE (solid / dashed / dotted) and
   * the remaining whole seconds as a number — so the rail is unambiguous with
   * the colour discarded entirely. The ring is decoration on top of that, not
   * the message.
   */
  setPowerups(list) {
    const arr = Array.isArray(list) ? list : null;
    if (!arr) return;                       // "no-op when given nothing"

    const seen = new Set();
    for (const p of arr) {
      if (!p) continue;
      const id = String(p.id || p.key || '');
      if (!id) continue;
      seen.add(id);
      const row = this._puRow(id, p);
      row.remaining = Math.max(0, Number(p.remaining) || 0);
      // `frac` is authoritative when the caller supplies it (stacking can push
      // remaining past the nominal duration, and then remaining/duration > 1).
      const dur = Number(p.duration) || row.duration || row.remaining || 1;
      row.duration = dur;
      row.frac = Number.isFinite(p.frac) ? Math.max(0, Math.min(1, p.frac))
        : Math.max(0, Math.min(1, row.remaining / Math.max(0.001, dur)));
      this._renderPuRow(row);
    }

    for (const id of [...this._pu.keys()]) {
      if (!seen.has(id)) this._retirePowerup(id, true);
    }
    this._syncStatusVisibility();
  }

  /** Pool lookup + first-time build for one rail row. */
  _puRow(id, p) {
    let row = this._pu.get(id);
    if (row) {
      // A repeat pickup can arrive with richer data than the first one did.
      if (p && p.name) row.name = String(p.name);
      return row;
    }
    const fb = POWERUP_FALLBACK[id] || {};
    const el = document.createElement('div');
    el.className = 'pu-row';
    el.dataset.pu = id;
    el.dataset.shape = String((p && p.shape) || fb.shape || 'ring');
    el.innerHTML =
      '<span class="pu-ic" aria-hidden="true"></span>' +
      '<span class="pu-tx"><b class="pu-nm"></b><span class="pu-ds"></span></span>' +
      '<span class="pu-ring">' +
        `<svg viewBox="0 0 36 36" aria-hidden="true" focusable="false">` +
          '<circle class="pu-trk" cx="18" cy="18" r="15.5"></circle>' +
          `<circle class="pu-arc" cx="18" cy="18" r="15.5"` +
            ` stroke-dasharray="${RING_LEN.toFixed(2)}" stroke-dashoffset="0"></circle>` +
        '</svg>' +
        '<b class="pu-sec">0</b>' +
      '</span>';

    row = {
      id, el,
      ic: el.querySelector('.pu-ic'),
      nm: el.querySelector('.pu-nm'),
      ds: el.querySelector('.pu-ds'),
      arc: el.querySelector('.pu-arc'),
      sec: el.querySelector('.pu-sec'),
      name: String((p && p.name) || fb.name || id.toUpperCase()),
      icon: String((p && p.icon) || fb.icon || '★'),
      css: cssColor((p && p.css) ?? (p && p.color), fb.css || '#ffffff'),
      description: String((p && p.description) || fb.description || ''),
      remaining: 0, duration: 1, frac: 1,
      shownSec: -1, shownPct: -1,
    };
    row.el.style.setProperty('--pc', row.css);
    row.ic.textContent = row.icon;
    row.nm.textContent = row.name;
    row.ds.textContent = row.description;
    // The visible name is the label; the description is the accessible detail,
    // because at this size it can only ever be one clipped line on a phone.
    row.el.setAttribute('aria-label', `${row.name}. ${row.description}`);

    this._pu.set(id, row);
    this._reorderPowerups();
    return row;
  }

  /**
   * Stable order, always. POWERUP_RANK first, then id, so the rail never
   * reshuffles because one boost happened to be picked up before another.
   */
  _reorderPowerups() {
    const rows = [...this._pu.values()].sort((a, b) => {
      const ra = POWERUP_RANK[a.id] ?? 99;
      const rb = POWERUP_RANK[b.id] ?? 99;
      return ra - rb || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
    for (const r of rows) this.powEl.appendChild(r.el);
  }

  /** Write only what a human could see change — this runs at frame rate. */
  _renderPuRow(row) {
    const secs = Math.ceil(row.remaining - 0.001);
    if (secs !== row.shownSec) {
      row.shownSec = secs;
      row.sec.textContent = String(Math.max(0, secs));
      // Under four seconds the row starts flashing. The `low` class also
      // switches the border to a doubled rule, so the warning survives with no
      // colour and no animation (see the reduced-motion block in hud.css).
      row.el.classList.toggle('low', secs <= 4);
    }
    const pct = Math.round(row.frac * 100);
    if (pct !== row.shownPct) {
      row.shownPct = pct;
      row.arc.style.strokeDashoffset = (RING_LEN * (1 - row.frac)).toFixed(2);
    }
  }

  /** Drop one row and, unless we are wiping the match, say so. */
  _retirePowerup(id, announce) {
    const row = this._pu.get(id);
    if (!row) return;
    this._pu.delete(id);
    row.el.classList.add('out');
    setTimeout(() => row.el.remove(), 340);
    if (announce) {
      const last = this._puEndAt.get(id) || -99;
      // Dedupe: the game may push its own end notification AND stop listing the
      // power-up in the same frame. One card, not two.
      if (this._now - last > 1.5) {
        this._puEndAt.set(id, this._now);
        this.showPowerupBanner({
          id, kind: 'end', name: row.name, icon: row.icon, color: row.css,
        });
      }
    }
    this._syncStatusVisibility();
  }

  _retireAllPowerups(announce) {
    for (const id of [...this._pu.keys()]) this._retirePowerup(id, announce);
  }

  /**
   * The pickup card — `VACUUM BOOST — 30s` — and its end notification.
   *
   * @param {{name:string, seconds?:number, id?:string, icon?:string,
   *   color?:string, description?:string, kind?:'get'|'end'}} [info]
   *
   * The two states are told apart by a kicker word, an arrow glyph and a border
   * style, not by hue: `POWER-UP ▲` on a solid edge versus `ENDED ▼` on a
   * dashed one. The end card fades out; the pickup card pops in and holds.
   */
  showPowerupBanner(info) {
    if (!info) return;
    const id = String(info.id || '');
    const fb = POWERUP_FALLBACK[id] || {};
    const end = info.kind === 'end';
    const name = String(info.name || fb.name || id.toUpperCase() || 'POWER-UP');
    const secs = Math.max(0, Math.round(Number(info.seconds) || 0));
    const desc = String(info.description || fb.description || '');

    const card = document.createElement('div');
    card.className = 'pb-card';
    card.dataset.kind = end ? 'end' : 'get';
    card.style.setProperty('--pc', cssColor(info.css ?? info.color, fb.css || '#ffffff'));
    const sub = end
      ? 'Boost expired'
      : (secs ? `${secs}s${desc ? ' &middot; ' : ''}` : '') + escapeHtml(desc);
    card.innerHTML =
      `<span class="pb-ic" aria-hidden="true">${escapeHtml(String(info.icon || fb.icon || '★'))}</span>` +
      '<span class="pb-tx">' +
        `<span class="pb-k">${end ? 'ENDED &#9660;' : 'POWER-UP &#9650;'}</span>` +
        `<b class="pb-nm">${escapeHtml(name)}</b>` +
        `<span class="pb-sub">${sub}</span>` +
      '</span>';

    this.powBanner.appendChild(card);
    void card.offsetWidth;                  // reflow, so the entry animation runs
    card.classList.add('on');
    const rec = { card, timer: 0 };
    this._puCards.push(rec);
    rec.timer = setTimeout(() => this._dropPuCard(rec), end ? 2200 : 2800);
    while (this._puCards.length > 2) this._dropPuCard(this._puCards[0]);
  }

  _dropPuCard(rec) {
    const i = this._puCards.indexOf(rec);
    if (i < 0) return;
    this._puCards.splice(i, 1);
    clearTimeout(rec.timer);
    rec.card.classList.remove('on');
    rec.card.classList.add('out');
    setTimeout(() => rec.card.remove(), 420);
  }

  /**
   * Countdowns that must keep moving between pushes from the game.
   *
   * Called once per frame from setTimer(). Power-up rows and the event banner
   * both self-tick here and are simply overwritten whenever the authoritative
   * value arrives, so the HUD reads correctly whether the game pushes state
   * every frame or only when it changes.
   */
  _tickOverlays() {
    const dt = this._dt;

    if (this._pu.size) {
      for (const [id, row] of [...this._pu]) {
        row.remaining = Math.max(0, row.remaining - dt);
        row.frac = Math.max(0, Math.min(1, row.remaining / Math.max(0.001, row.duration)));
        if (row.remaining <= 0) { this._retirePowerup(id, true); continue; }
        this._renderPuRow(row);
      }
    }

    if (this._evtId && this._evtLeft > 0) {
      this._evtLeft = Math.max(0, this._evtLeft - dt);
      const s = Math.ceil(this._evtLeft - 0.001);
      if (s !== this._evtShownSecs) {
        this._evtShownSecs = s;
        this.evtNum.textContent = String(Math.max(0, s));
        this.evtEl.classList.toggle('soon', s <= 5);
      }
      if (this._evtSpan > 0) {
        this.evtBar.style.transform =
          `scaleX(${(this._evtLeft / this._evtSpan).toFixed(3)})`;
      }
    }

    if (this._heatOn && this._heatTier === 0 && this._heatHideAt
        && this._now > this._heatHideAt) {
      this._heatOn = false;
      this.heatEl.classList.remove('on');
      this._syncStatusVisibility();
    }
  }

  /* ====================================================================== */
  /* HEAT                                                                   */
  /* ====================================================================== */

  /**
   * The police-response meter.
   *
   * @param {{tier?:number, value?:number}} [state] tier 0..3 (HeatSystem
   *   .tierOf), value 0..1 (HeatSystem.heatOf). Null hides the meter.
   *
   * ACCESSIBILITY (spec §6): the tier is printed as a NUMBER and a WORD, the
   * three segments are filled/hollow (a shape difference, readable in
   * greyscale) and the hint line says in plain English how to cool down. No
   * part of the read depends on the colour of the bar.
   */
  setHeat(state) {
    if (!state) {
      if (this._heatOn) {
        this._heatOn = false;
        this.heatEl.classList.remove('on');
        this._syncStatusVisibility();
      }
      this._heatTier = -1;
      this._heatPct = -1;
      return;
    }

    const tier = Math.max(0, Math.min(3, Math.round(Number(state.tier) || 0)));
    const value = Math.max(0, Math.min(1, Number(state.value) || 0));

    // Tier 0 with an empty meter is "nothing is happening", and a permanent
    // HEAT 0 chip is just clutter. It lingers for three seconds after a
    // cool-down so the player sees the all-clear, then goes.
    const wanted = tier > 0 || value > 0.02;
    if (wanted) this._heatHideAt = 0;
    else if (this._heatOn && !this._heatHideAt) this._heatHideAt = this._now + 3;
    if (wanted && !this._heatOn) {
      this._heatOn = true;
      this.heatEl.classList.add('on');
      this._syncStatusVisibility();
    }

    if (tier !== this._heatTier) {
      const prev = this._heatTier;
      this._heatTier = tier;
      const t = HEAT_TIERS[tier];
      this.heatEl.dataset.tier = String(tier);
      this.heatIc.textContent = t.glyph;
      this.heatKey.textContent = `HEAT ${tier}`;
      this.heatVal.textContent = t.label;
      this.heatHint.textContent = t.hint;
      this.heatSeg.setAttribute('aria-label', `Heat tier ${tier} of 3. ${t.hint}`);
      for (let i = 0; i < this.heatSegs.length; i++) {
        this.heatSegs[i].className = i < tier ? 'lit' : '';
      }
      if (prev >= 0 && tier > prev) restart(this.heatEl, 'bump');
    }

    const pct = Math.round(value * 100);
    if (pct !== this._heatPct) {
      this._heatPct = pct;
      this.heatEl.style.setProperty('--hv', `${pct}%`);
    }
  }

  /* ====================================================================== */
  /* CITY EVENTS                                                            */
  /* ====================================================================== */

  /**
   * The compact top-of-screen event banner.
   *
   * @param {{name?:string, seconds?:number, id?:string, icon?:string,
   *   color?:string, message?:string, short?:string, sub?:string,
   *   kind?:string}} [info]
   *
   * Tolerates the full payload EventManager pushes through `onBanner`
   * (kind/id/name/short/icon/color/message/sub/seconds/countdownTo) as well as
   * the three fields the integration contract promises. `kind: 'clear'` and a
   * missing name both mean "take it down".
   */
  setEventBanner(info) {
    if (!info) return;                      // "no-op when given nothing"
    if (info.kind === 'clear') { this.clearEventBanner(); return; }

    const name = String(info.message || info.name || info.short || '').trim();
    if (!name) { this.clearEventBanner(); return; }

    const secs = Math.max(0, Number(info.seconds) || 0);
    this._evtId = String(info.id || name);
    this._evtLeft = secs;
    this._evtSpan = secs;
    this._evtShownSecs = -1;

    this.evtEl.dataset.kind = String(info.kind || 'alert');
    this.evtEl.style.setProperty('--ec', cssColor(info.color, '#5fd8ff'));
    this.evtIc.textContent = String(info.icon || '⚠');
    this.evtNm.textContent = name;
    this.evtSub.textContent = String(info.sub || '');
    this.evtSub.hidden = !info.sub;
    this.evtNum.textContent = String(Math.ceil(secs));
    this.evtEl.classList.toggle('nocount', secs <= 0);
    this.evtEl.classList.remove('soon');
    this.evtBar.style.transform = 'scaleX(1)';
    // 'end' banners are announcements with no countdown; they clear themselves
    // rather than sitting on screen for the rest of the match.
    clearTimeout(this._evtHideT);
    if (secs <= 0) this._evtHideT = setTimeout(() => this.clearEventBanner(), 3400);
    restart(this.evtEl, 'on');
    // The frenzy banner lives at top:6.5em and would sit underneath this one.
    this.root.classList.add('has-evt');
  }

  /** Take the banner down. Safe to call when there is none. */
  clearEventBanner() {
    clearTimeout(this._evtHideT);
    this._evtId = null;
    this._evtLeft = 0;
    this._evtSpan = 0;
    this._evtShownSecs = -1;
    this.evtEl.classList.remove('on', 'soon');
    this.root.classList.remove('has-evt');
  }

  /**
   * The event's zone on the minimap.
   *
   * @param {{x:number, z:number, r:number, label?:string, color?:string,
   *   points?:Array<{x:number,z:number,r:number}>}} [m] null removes it.
   *
   * Stored only — the paint happens in drawMinimap(), inside the existing
   * minimap canvas, because that is where the map's transform lives.
   */
  setEventMarker(m) {
    if (!m || !Number.isFinite(m.x) || !Number.isFinite(m.z)) {
      this._evtMarker = null;
      return;
    }
    this._evtMarker = m;
  }

  /**
   * Paint the event zone into the minimap.
   *
   * The transform is the one Minimap.draw() uses, re-derived from the same two
   * facts (canvas.width and WORLD.SIZE) rather than assumed: a marker drawn in
   * a different projection than the holes is worse than no marker at all.
   *
   * SHAPE, NOT COLOUR: the zone is a DASHED ring. minimap.js already draws
   * solid rings (the leader), soft pulsing discs (the player) and rotated
   * squares (landmarks), so dashes are the one outline nothing else uses.
   */
  _drawEventMarker(m) {
    const c = this.mapCtx;
    const S = this.mapCanvas.width;
    if (!c || !S) return;

    const P = S / (WORLD.SIZE * 2);
    const k = S / 336;                      // minimap.js authors at 336 px
    const x = (m.x + WORLD.SIZE) * P;
    const y = (m.z + WORLD.SIZE) * P;
    const r = Math.max(7 * k, (Number(m.r) || 60) * P);
    const col = cssColor(m.color, '#5fd8ff');
    const pulse = reduceMotion() ? 0.55 : 0.5 + 0.5 * Math.sin(this._now * 2.1);

    c.save();

    c.globalAlpha = 0.10 + pulse * 0.07;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fillStyle = col;
    c.fill();

    c.globalAlpha = 0.95;
    c.setLineDash([5 * k, 4 * k]);
    c.lineWidth = 2 * k;
    c.strokeStyle = col;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.stroke();
    c.setLineDash([]);

    // Debris clusters: where the loot actually is, rather than one vague blob.
    for (const p of (m.points || [])) {
      if (!p || !Number.isFinite(p.x)) continue;
      const px = (p.x + WORLD.SIZE) * P;
      const py = (p.z + WORLD.SIZE) * P;
      const pr = Math.max(2 * k, (Number(p.r) || 12) * P);
      c.beginPath();
      c.arc(px, py, pr, 0, Math.PI * 2);
      c.fillStyle = 'rgba(6,10,18,0.6)';
      c.fill();
      c.lineWidth = 1.4 * k;
      c.strokeStyle = col;
      c.stroke();
    }

    // The word, so the ring is not the only thing carrying the meaning.
    const label = String(m.label || m.id || 'EVENT').toUpperCase();
    const fs = Math.max(8, Math.round(9.5 * k));
    c.font = `900 ${fs}px ${'system-ui, -apple-system, "Segoe UI", sans-serif'}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const ty = Math.max(fs, Math.min(S - fs * 0.7, y - r - fs * 0.85));
    const tx = Math.max(fs * 2, Math.min(S - fs * 2, x));
    c.globalAlpha = 1;
    c.lineWidth = Math.max(2, 3 * k);
    c.lineJoin = 'round';
    c.strokeStyle = 'rgba(4,8,14,0.92)';
    c.strokeText(label, tx, ty);
    c.fillStyle = '#ffffff';
    c.fillText(label, tx, ty);

    c.restore();
  }

  /**
   * Show only the blocks that have something to say.
   *
   * The CONTAINER is never hidden — it also holds the audio button, which has
   * to stay reachable all match. Only the rail and the heat chip toggle.
   */
  _syncStatusVisibility() {
    this.powEl.classList.toggle('on', this._pu.size > 0);
  }

  /* ====================================================================== */
  /* AUDIO SETTINGS                                                         */
  /* ====================================================================== */

  /**
   * Build the in-match mixer.
   *
   * WHY IT IS HERE AND NOT ONLY IN THE SETTINGS SCREEN: a player who cannot
   * hear a voice line over the music has to leave the match to fix it today.
   * The sliders write to the SAME audio singleton the settings screen uses
   * (setVolume / setMusicVolume / setSfxVolume / setVoiceVolume — all verified
   * against src/core/audio.js, none of them guessed) and mirror music/sfx back
   * into profile.data.settings so the two surfaces cannot disagree.
   */
  _installAudioSettings() {
    /* Keep the game's input out of the mixer.
       input.js listens for keydown on WINDOW and preventDefaults the arrows and
       Space with no target check, so a focused volume slider could not be
       arrowed at all — while `keys.add(e.code)` still ran and the hole drove
       off underneath the panel. Worse, input.js skips preventDefault on
       e.repeat, so a HELD arrow moved the slider and a tap did nothing, which
       reads as a broken control rather than a captured key.
       Escape is deliberately let through so _onDocKey can still close this. */
    this._panelKeyGuard = (e) => {
      if (e.key === 'Escape') return;
      if (/^Arrow/.test(e.code) || e.code === 'Space') e.stopPropagation();
    };
    const slider = (r, v) => {
      const pct = Math.round(v * 100);
      return `
        <div class="au-row" data-row="${r.key}">
          <label class="au-lbl" for="au-${r.key}">
            <span class="au-ic" aria-hidden="true">${r.icon}</span>
            <span class="au-nm">${r.name}</span>
            <output class="au-out" data-out="${r.key}">${pct}</output>
          </label>
          <input class="au-sl" id="au-${r.key}" type="range" min="0" max="100" step="1"
                 value="${pct}" style="--v:${pct}%" data-slider="${r.key}"
                 aria-label="${r.name} volume" />
        </div>`;
    };
    const toggle = (t, on) => `
        <button class="au-tg" type="button" role="switch" data-toggle="${t.key}"
                aria-checked="${on ? 'true' : 'false'}">
          <span class="au-ic" aria-hidden="true">${t.icon}</span>
          <span class="au-nm">${t.name}</span>
          <span class="au-state" data-state="${t.key}">${on ? t.onWord : t.offWord}</span>
          <span class="sw" aria-hidden="true"><i></i></span>
        </button>`;

    const p = this._audioPrefs;
    this.audioPanel.innerHTML =
      '<div class="au-hd"><b>Audio</b>' +
      '<button class="au-x" type="button" aria-label="Close audio settings">&#10005;</button></div>' +

    // Bubble phase, so it runs before input.js's window listener sees the key.
    this.audioPanel.addEventListener('keydown', this._panelKeyGuard);
      AUDIO_SLIDERS.map((r) => slider(r, p[r.key])).join('') +
      '<div class="au-tgs">' + AUDIO_TOGGLES.map((t) => toggle(t, !!p[t.key])).join('') + '</div>' +
      '<p class="au-note">Saved on this device.</p>';

    this._audioRows = true;

    /* --- sliders: apply under the thumb, persist on a short debounce ----- */
    this.audioPanel.addEventListener('input', (e) => {
      const sl = e.target.closest && e.target.closest('[data-slider]');
      if (!sl) return;
      const key = sl.dataset.slider;
      const pct = Math.max(0, Math.min(100, Number(sl.value) || 0));
      sl.style.setProperty('--v', `${pct}%`);
      const out = this.audioPanel.querySelector(`[data-out="${key}"]`);
      if (out) out.textContent = String(pct);
      this._audioPrefs[key] = pct / 100;
      this._pushAudio(key);
      this._saveAudioPrefsSoon();
    });

    // One blip when the thumb is released, never during the drag — otherwise
    // dragging the SFX slider is a machine-gun of click sounds.
    this.audioPanel.addEventListener('change', (e) => {
      const sl = e.target.closest && e.target.closest('[data-slider="sfx"], [data-slider="master"]');
      if (sl) { try { audio.ui('click'); } catch { /* dead context */ } }
    });

    this.audioPanel.addEventListener('click', (e) => {
      if (!e.target || !e.target.closest) return;
      if (e.target.closest('.au-x')) { this.closeAudioSettings(); return; }
      const tg = e.target.closest('[data-toggle]');
      if (!tg) return;
      const key = tg.dataset.toggle;
      const on = tg.getAttribute('aria-checked') !== 'true';
      tg.setAttribute('aria-checked', on ? 'true' : 'false');
      const def = AUDIO_TOGGLES.find((t) => t.key === key);
      const st = tg.querySelector(`[data-state="${key}"]`);
      if (st && def) st.textContent = on ? def.onWord : def.offWord;
      this._audioPrefs[key] = on;
      this._pushAudio(key);
      this._saveAudioPrefsSoon();
      try { audio.ui('click'); } catch { /* dead context */ }
    });

    this.audioBtn.addEventListener('click', () => this.toggleAudioSettings());

    /* --- dismissal ------------------------------------------------------- *
     * Capture phase so a tap anywhere else closes the panel, but NOTHING is
     * stopped or consumed: game.js owns Escape (it opens the pause menu) and
     * gameplay/input.js owns pointerdown on the canvas. Interfering with
     * either would be a gameplay regression shipped from a settings panel. */
    this._onDocDown = (e) => {
      if (!this._audioOpen) return;
      const t = e.target;
      if (t && t.closest && t.closest('#hud-audio, #hud-audio-btn')) return;
      this.closeAudioSettings();
    };
    this._onDocKey = (e) => {
      if (e.key === 'Escape' && this._audioOpen) this.closeAudioSettings();
    };
    window.addEventListener('pointerdown', this._onDocDown, true);
    window.addEventListener('keydown', this._onDocKey);
  }

  openAudioSettings() {
    if (this._audioOpen) return;
    this._audioOpen = true;
    this.audioPanel.hidden = false;
    void this.audioPanel.offsetWidth;
    this.audioPanel.classList.add('on');
    this.audioBtn.setAttribute('aria-expanded', 'true');
    // The meta Settings screen may have moved music/sfx since this panel was
    // last opened. It is the other owner of those two values, so adopt them.
    withProfile((pr) => {
      const s = pr.data.settings;
      let changed = false;
      for (const k of ['music', 'sfx']) {
        const v = Number(s[k]);
        if (Number.isFinite(v) && Math.abs(v - this._audioPrefs[k]) > 0.001) {
          this._audioPrefs[k] = Math.max(0, Math.min(1, v));
          changed = true;
        }
      }
      if (changed) { this._pushAudio('music'); this._pushAudio('sfx'); this._syncAudioUI(); }
    });
    try { audio.ui('menuOpen'); } catch { /* dead context */ }
  }

  closeAudioSettings() {
    if (!this._audioOpen) return;
    this._audioOpen = false;
    this.audioPanel.classList.remove('on');
    this.audioBtn.setAttribute('aria-expanded', 'false');
    clearTimeout(this._audioHideT);
    // `hidden` only after the fade, or the panel vanishes instead of leaving.
    this._audioHideT = setTimeout(() => {
      if (!this._audioOpen) this.audioPanel.hidden = true;
    }, 220);
    try { audio.ui('menuClose'); } catch { /* dead context */ }
  }

  toggleAudioSettings() {
    if (this._audioOpen) this.closeAudioSettings();
    else this.openAudioSettings();
  }

  /** Push ONE preference at whatever owns it. Names verified in audio.js. */
  _pushAudio(key) {
    const p = this._audioPrefs;
    try {
      if (key === 'master' || key === 'muted') {
        // Order matters: setVolume() is a no-op on the master gain while muted,
        // and setMuted() is what restores the player's level afterwards.
        audio.setVolume(p.master);
        audio.setMuted(p.muted);
      } else if (key === 'music') audio.setMusicVolume(p.music);
      else if (key === 'sfx') audio.setSfxVolume(p.sfx);
      else if (key === 'voice' || key === 'voicesMuted') {
        audio.setVoiceVolume(p.voice);
        audio.setVoicesMuted(p.voicesMuted);
      }
    } catch { /* a closed AudioContext must never break the UI */ }
    if (key === 'subtitles') this.setSubtitles(p.subtitles);
  }

  /**
   * Subtitles on/off.
   *
   * Two independent switches, because either one alone leaves a hole: the
   * VoiceSystem stops GENERATING captions (so nothing is queued in the first
   * place), and a class on <html> hides `.vo-captions` outright — which covers
   * anything already on screen and any caller that reaches showCaption()
   * directly. showCaption() itself is deliberately not touched.
   */
  setSubtitles(on) {
    const v = !!on;
    this._audioPrefs.subtitles = v;
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('no-subtitles', !v);
    }
    const vs = this.voice
      || (typeof globalThis !== 'undefined' && globalThis.__GAME__ && globalThis.__GAME__.voice)
      || null;
    if (vs && typeof vs.setSubtitles === 'function') {
      try { vs.setSubtitles(v); } catch { /* voice pack absent */ }
    }
    if (!v) this.clearCaptions();
    return v;
  }

  /** Current mixer state, as stored. Handy for the results screen and tests. */
  audioPrefs() { return { ...this._audioPrefs }; }

  _loadAudioPrefs() {
    const out = { ...AUDIO_DEFAULTS };
    let raw = null;
    try { raw = localStorage.getItem(AUDIO_PREFS_KEY); }
    catch { return out; }                   // private mode: defaults, no crash

    if (!raw) {
      // Never opened before. profile.data.settings may already hold this
      // player's music/sfx from the meta Settings screen — adopt rather than
      // snapping their mix back to the factory numbers.
      withProfile((pr) => {
        const s = pr.data.settings;
        let changed = false;
        for (const k of ['music', 'sfx']) {
          const v = Number(s[k]);
          if (Number.isFinite(v)) { this._audioPrefs[k] = Math.max(0, Math.min(1, v)); changed = true; }
        }
        if (changed) this._applyAudioPrefs();
      });
      return out;
    }

    try {
      const saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') {
        for (const k of Object.keys(AUDIO_DEFAULTS)) {
          const d = AUDIO_DEFAULTS[k];
          const v = saved[k];
          if (typeof d === 'boolean') { if (typeof v === 'boolean') out[k] = v; }
          else if (Number.isFinite(Number(v))) out[k] = Math.max(0, Math.min(1, Number(v)));
        }
      }
    } catch { /* corrupt blob: defaults, and the next write repairs it */ }
    return out;
  }

  _saveAudioPrefsSoon() {
    clearTimeout(this._audioSaveT);
    // Debounced: dragging a slider fires `input` on every pixel, and a
    // localStorage write plus a profile save per pixel is a stutter you can
    // feel on a phone.
    this._audioSaveT = setTimeout(() => this._saveAudioPrefs(), 350);
  }

  _saveAudioPrefs() {
    const p = this._audioPrefs;
    try { localStorage.setItem(AUDIO_PREFS_KEY, JSON.stringify(p)); }
    catch { /* private mode or quota: the session still works */ }
    withProfile((pr) => {
      const s = pr.data.settings;
      if (s.music === p.music && s.sfx === p.sfx) return;
      s.music = p.music;
      s.sfx = p.sfx;
      pr.save();
    });
  }

  /** Push every stored preference at its owner and redraw the controls. */
  _applyAudioPrefs() {
    for (const k of ['master', 'music', 'sfx', 'voice', 'subtitles']) this._pushAudio(k);
    this._pushAudio('voicesMuted');
    this.setSubtitles(this._audioPrefs.subtitles);
    this._syncAudioUI();
  }

  /** Write the stored values back into the controls. */
  _syncAudioUI() {
    if (!this._audioRows || !this.audioPanel) return;
    const p = this._audioPrefs;
    for (const r of AUDIO_SLIDERS) {
      const sl = this.audioPanel.querySelector(`[data-slider="${r.key}"]`);
      const out = this.audioPanel.querySelector(`[data-out="${r.key}"]`);
      const pct = Math.round((p[r.key] ?? 0) * 100);
      if (sl) { sl.value = String(pct); sl.style.setProperty('--v', `${pct}%`); }
      if (out) out.textContent = String(pct);
    }
    for (const t of AUDIO_TOGGLES) {
      const tg = this.audioPanel.querySelector(`[data-toggle="${t.key}"]`);
      const st = this.audioPanel.querySelector(`[data-state="${t.key}"]`);
      const on = !!p[t.key];
      if (tg) tg.setAttribute('aria-checked', on ? 'true' : 'false');
      if (st) st.textContent = on ? t.onWord : t.offWord;
    }
  }

  /**
   * Keep the one interactive control in this layer honest about whether the
   * HUD is actually on screen.
   *
   * game.js drives HUD visibility by writing `hud.root.style.opacity`, and an
   * element at opacity 0 STILL RECEIVES POINTER EVENTS — an invisible audio
   * button floating over the results screen is a real bug, not a theoretical
   * one. Polled at 4 Hz rather than observed, because game.js rewrites that
   * property on every single frame and a MutationObserver would fire 60 times
   * a second to tell us nothing changed.
   */
  _watchVisibility() {
    const check = () => {
      const shown = this.root.style.opacity !== '0';
      if (shown === this._hudShown) return;
      this._hudShown = shown;
      this.root.classList.toggle('hud-off', !shown);
      if (!shown) this.closeAudioSettings();
    };
    check();
    this._visTimer = setInterval(check, 250);
  }

  /** Release timers and listeners. Nothing calls this today; a second HUD would. */
  dispose() {
    clearInterval(this._visTimer);
    clearTimeout(this._audioSaveT);
    clearTimeout(this._audioHideT);
    clearTimeout(this._evtHideT);
    this.clearCaptions();
    window.removeEventListener('pointerdown', this._onDocDown, true);
    window.removeEventListener('keydown', this._onDocKey);
    window.removeEventListener('resize', this._resize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', this._resize);
  }

  /* ====================================================================== */
  /* TOUCH STICK                                                            */
  /* ====================================================================== */

  /**
   * A purely visual echo of the touch steering in gameplay/input.js — same
   * "first finger wins, origin is where you pressed" rule. It lives in the HUD
   * layer with pointer-events:none, so it can never swallow the input it draws.
   */
  _installTouchStick() {
    const ring = this.stickEl.querySelector('.ring');
    const knob = this.stickEl.querySelector('.knob');
    let id = null, ox = 0, oy = 0;

    const down = (e) => {
      if (e.pointerType !== 'touch' || id !== null) return;
      // The audio button and its panel are the only pointer-events:auto things
      // in this layer. gameplay/input.js binds pointerdown on the CANVAS so it
      // never sees these taps, but this listener is on window and would draw a
      // phantom stick under the player's thumb while they drag a slider.
      if (e.target && e.target.closest && e.target.closest('.hud-tap')) return;
      id = e.pointerId; ox = e.clientX; oy = e.clientY;
      ring.style.left = knob.style.left = `${ox}px`;
      ring.style.top = knob.style.top = `${oy}px`;
      this.stickEl.classList.add('on');
    };
    const move = (e) => {
      if (e.pointerId !== id) return;
      const dx = e.clientX - ox, dy = e.clientY - oy;
      const len = Math.hypot(dx, dy);
      const m = len > 70 ? 70 / len : 1;       // matches input.js's 70px travel
      knob.style.left = `${ox + dx * m}px`;
      knob.style.top = `${oy + dy * m}px`;
    };
    const up = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      this.stickEl.classList.remove('on');
    };
    window.addEventListener('pointerdown', down, { passive: true });
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerup', up, { passive: true });
    window.addEventListener('pointercancel', up, { passive: true });
  }
}

/* --------------------------------------------------------------- helpers -- */

function formatScore(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

function ordinal(n) {
  const t = n % 100;
  if (t >= 11 && t <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
}

/** Which tier ramp colour a score reward belongs to. */
function tierOfScore(v) {
  for (let i = TIER_LIST.length - 1; i >= 0; i--) {
    if (v >= TIER_LIST[i].score) return i;
  }
  return 0;
}

/** Re-trigger a CSS animation that is already on the element. */
function restart(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

export { formatScore, ordinal };
