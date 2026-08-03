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
 *
 * PERFORMANCE POSTURE
 *   Every one of those methods runs at frame rate. The rule followed here is:
 *   touch the DOM only when a value a human could notice has changed. Text is
 *   compared before it is written, rows are only reordered when the order
 *   actually differs, and the map's static layer is cached (see minimap.js).
 */

import * as THREE from 'three';
import { TIER_LIST, MATCH } from '../config.js';
import { Minimap } from './minimap.js';

/** Tier accent ramp — mirrors --t0..--t7 in styles.css. */
const TIER_COLORS = [
  '#d7dde6', '#9fe4ff', '#37e6d5', '#4dff9e',
  '#ffc93c', '#ff9430', '#ff3d8b', '#c58cff',
];

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
            <div class="tier">Litter</div>
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
        <div class="k">Devoured by</div>
        <div class="v">&nbsp;</div>
        <div class="ring"></div>
        <div class="rs">Respawning in 0.0s</div>
      </div>

      <div id="hud-toast"></div>
      <div id="hud-popups"></div>
      <div id="hud-stick"><i class="ring"></i><i class="knob"></i></div>
    `;

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
    this.tierEl = $('#hud-size .tier');
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
    this.toastEl = $('#hud-toast');
    this.popupEl = $('#hud-popups');
    this.stickEl = $('#hud-stick');
    this.mapCanvas = $('#hud-map canvas');

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
    this._frenzy = false;
    this._dead = false;
    this._hints = new Set();
    this._feedItems = [];

    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', this._resize);
    this._resize();
    this._installTouchStick();
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
    const floor = h < 520 ? 0.56 : 0.74;
    const s = Math.max(floor, Math.min(1.28, Math.min(w / 1500, h / 850)));
    document.documentElement.style.setProperty('--s', s.toFixed(3));
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
    this._dead = false;
    this.deadEl.classList.remove('on');
    for (const item of this._feedItems.slice()) this._dropFeed(item);
    uiState.reset();
  }

  /* ====================================================================== */
  /* LEADERBOARD                                                            */
  /* ====================================================================== */

  setLeaderboard(holes, me) {
    const sorted = [...holes].sort((a, b) => b.score - a.score);
    const cap = window.innerHeight < 560 ? 5 : 8;
    const shown = sorted.slice(0, cap);

    // The player must always be on the board, even sitting in 11th — an
    // out-of-frame rank is exactly the moment you need to see it.
    const myRank = me ? sorted.indexOf(me) + 1 : 0;
    if (me && myRank > cap) shown[shown.length - 1] = me;

    const members = shown.map((h) => h.id).sort((a, b) => a - b).join(',');
    if (members !== this._members) {
      this._members = members;
      this._rebuildRows(shown, me);
    }

    const order = shown.map((h) => h.id).join(',');
    if (order !== this._order) {
      this._flipReorder(shown);
      this._order = order;
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
      // A meal worth noticing gets the score a punch of its own.
      if (h.score - row.prev >= 50) restart(row.sc, 'bump');
      row.prev = h.score;

      const rank = h === me ? myRank : sorted.indexOf(h) + 1;
      if (rank !== row.rank) {
        row.rank = rank;
        row.rk.textContent = String(rank);
        // classList, not className: FLIP's `slide` class must survive this.
        row.el.classList.toggle('p1', rank === 1);
        row.el.classList.toggle('p2', rank === 2);
        row.el.classList.toggle('p3', rank === 3);
      }
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
          disp: h.score, prev: h.score, text: '', rank: -1, alive: true,
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
    this._order = '';
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
      row.el.classList.add('slide');
      row.el.style.transform = '';
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
      this.deadTime.textContent = `Respawning in ${Math.max(0, hole.respawnAt).toFixed(1)}s`;
      return;
    }
    if (this._dead) {
      this._dead = false;
      this.deadEl.classList.remove('on');
    }

    /* --- biggest single meal, for the results screen --------------------
     * Score deltas are the only per-meal signal the HUD is handed, so the
     * "best meal" is reconstructed from the largest jump plus the label the
     * hole was carrying at that moment. A negative delta is a respawn tax,
     * not a meal — skip it, and keep the record for the whole match.        */
    const gain = hole.score - this._lastScore;
    if (gain > 0 && (!uiState.bestMeal || gain > uiState.bestMeal.score)) {
      uiState.bestMeal = { label: hole.lastMeal || 'the city', score: gain };
    }
    this._lastScore = hole.score;

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

  pushFeed(text, color = '#ffffff') {
    const el = document.createElement('div');
    el.className = 'feed-item';
    el.style.setProperty('--fc', color);
    el.innerHTML = text;
    this.feedEl.prepend(el);
    const item = { el, timer: null };
    this._feedItems.push(item);

    // Fade out on its own; a kill feed that only trims on overflow leaves stale
    // lines sitting there for the whole match when the action goes quiet.
    item.timer = setTimeout(() => this._dropFeed(item), 6200);
    while (this._feedItems.length > 5) this._dropFeed(this._feedItems[0]);
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
      const t = tierOfScore(val);
      const el = document.createElement('div');
      el.className = `popup${val >= 400 ? ' huge' : p.big || val >= 60 ? ' big' : ''}`;
      el.textContent = p.text;
      el.style.setProperty('--pc', TIER_COLORS[t]);
      this.popupEl.appendChild(el);
      p.__el = el;
      // Deterministic per-popup drift so a burst of numbers fans out instead of
      // stacking into an unreadable column.
      p.__drift = ((val * 37 + this._popups.length * 61) % 100) / 100 - 0.5;
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
      const x = (this._v.x * 0.5 + 0.5) * w + p.__drift * t * 46;
      const y = (-this._v.y * 0.5 + 0.5) * h - t * t * 14;   // slight arc
      // Overshoot punch on spawn, then a slow drift-up scale.
      const punch = t < 0.17 ? 0.5 * (1 - t / 0.17) : 0;
      const scale = 1 + punch + t * 0.2;
      const a = t < 0.72 ? 1 : 1 - (t - 0.72) / 0.53;
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
