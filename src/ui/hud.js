/**
 * HUD: timer, leaderboard, size meter, kill feed, floating score popups,
 * minimap and the start/results screens. Pure DOM over the canvas.
 * BASELINE — expected to be replaced with a AAA pass.
 */

import * as THREE from 'three';
import { WORLD, TIER_LIST, MATCH } from '../config.js';

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
    root = layer;
    root.innerHTML = `
      <div id="hud-timer" class="panel">2:30</div>
      <div id="hud-board" class="panel"><h3>Leaderboard</h3><div class="list"></div></div>
      <div id="hud-size" class="panel">
        <div class="label">Your hole</div>
        <div class="value">1.2 m</div>
        <div class="unlock">Next: street furniture</div>
        <div class="bar"><i style="width:0%"></i></div>
      </div>
      <div id="hud-map" class="panel"><canvas width="336" height="336"></canvas></div>
      <div id="hud-feed"></div>
      <div id="hud-popups"></div>
    `;
    this.timerEl = root.querySelector('#hud-timer');
    this.listEl = root.querySelector('#hud-board .list');
    this.sizeVal = root.querySelector('#hud-size .value');
    this.sizeUnlock = root.querySelector('#hud-size .unlock');
    this.sizeBar = root.querySelector('#hud-size .bar > i');
    this.feedEl = root.querySelector('#hud-feed');
    this.popupEl = root.querySelector('#hud-popups');
    this.mapCanvas = root.querySelector('#hud-map canvas');
    this.mapCtx = this.mapCanvas.getContext('2d');

    this._popups = [];
    this._feed = [];
    this._v = new THREE.Vector3();
    this._lastRankKey = '';
  }

  setTimer(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    const m = Math.floor(s / 60);
    const r = s % 60;
    this.timerEl.textContent = `${m}:${String(r).padStart(2, '0')}`;
    this.timerEl.classList.toggle('urgent', s <= MATCH.FRENZY_AT);
  }

  setLeaderboard(holes, me) {
    const sorted = [...holes].sort((a, b) => b.score - a.score).slice(0, 8);
    const key = sorted.map((h) => `${h.id}:${h.score}`).join('|');
    if (key === this._lastRankKey) return;
    this._lastRankKey = key;
    this.listEl.innerHTML = sorted.map((h, i) => `
      <div class="row ${h === me ? 'me' : ''}">
        <span class="rank">${i + 1}</span>
        <span class="dot" style="background:#${h.color.getHexString()};color:#${h.color.getHexString()}"></span>
        <span class="nm">${escapeHtml(h.name)}</span>
        <span class="sc">${formatScore(h.score)}</span>
      </div>`).join('');
  }

  setSize(hole) {
    const d = hole.radius * 2;
    this.sizeVal.textContent = `${d.toFixed(1)} m`;
    let next = null;
    for (const t of TIER_LIST) {
      if (hole.radius < t.eatRadius) { next = t; break; }
    }
    if (next) {
      this.sizeUnlock.textContent = `Next unlock: ${next.label}`;
      let prev = 0;
      for (const t of TIER_LIST) { if (t.eatRadius < next.eatRadius) prev = t.eatRadius; }
      const p = (hole.radius - prev) / Math.max(0.001, next.eatRadius - prev);
      this.sizeBar.style.width = `${Math.max(0, Math.min(1, p)) * 100}%`;
    } else {
      this.sizeUnlock.textContent = 'Everything is edible.';
      this.sizeBar.style.width = '100%';
    }
  }

  pushFeed(text, color = '#ffffff') {
    const el = document.createElement('div');
    el.className = 'feed-item';
    el.innerHTML = text;
    el.style.borderLeft = `3px solid ${color}`;
    this.feedEl.prepend(el);
    this._feed.push({ el, t: 0 });
    while (this._feed.length > 5) {
      const old = this._feed.shift();
      old.el.remove();
    }
  }

  /** Drain effects.popups into DOM elements anchored to world positions. */
  syncPopups(effects, camera) {
    for (const p of effects.popups) {
      if (p.__el) continue;
      const el = document.createElement('div');
      el.className = `popup${p.big ? ' big' : ''}`;
      el.textContent = p.text;
      el.style.color = `#${new THREE.Color(p.hex).getHexString()}`;
      this.popupEl.appendChild(el);
      p.__el = el;
      this._popups.push(p);
    }
    for (let i = this._popups.length - 1; i >= 0; i--) {
      const p = this._popups[i];
      if (!effects.popups.includes(p)) {
        p.__el.remove();
        this._popups.splice(i, 1);
        continue;
      }
      this._v.copy(p.pos);
      this._v.y += 1 + p.t * 3.4;
      this._v.project(camera);
      const x = (this._v.x * 0.5 + 0.5) * window.innerWidth;
      const y = (-this._v.y * 0.5 + 0.5) * window.innerHeight;
      const a = 1 - Math.pow(p.t / 1.25, 2.2);
      p.__el.style.transform = `translate(-50%,-50%) translate(${x}px,${y}px) scale(${1 + p.t * 0.3})`;
      p.__el.style.opacity = String(Math.max(0, a));
    }
  }

  drawMinimap(holes, me, layout) {
    const c = this.mapCtx;
    const S = this.mapCanvas.width;
    const span = WORLD.SIZE * 2;
    const toX = (x) => ((x + WORLD.SIZE) / span) * S;
    const toY = (z) => ((z + WORLD.SIZE) / span) * S;

    c.clearRect(0, 0, S, S);
    c.fillStyle = '#152535';
    c.fillRect(0, 0, S, S);

    // land
    c.fillStyle = '#243a4f';
    c.fillRect(0, 0, toX(WORLD.BAY_EDGE), S);
    // bay
    c.fillStyle = '#12708f';
    c.fillRect(toX(WORLD.BAY_EDGE), 0, S - toX(WORLD.BAY_EDGE), S);
    // river
    c.fillRect(0, toY(-WORLD.RIVER_HALF_W), toX(WORLD.BAY_EDGE), toY(WORLD.RIVER_HALF_W) - toY(-WORLD.RIVER_HALF_W));

    // roads
    c.strokeStyle = 'rgba(255,255,255,0.10)';
    c.lineWidth = 1;
    if (layout) {
      for (const r of layout.roadsX) {
        c.beginPath(); c.moveTo(toX(r.pos), 0); c.lineTo(toX(r.pos), S); c.stroke();
      }
      for (const r of layout.roadsZ) {
        c.beginPath(); c.moveTo(0, toY(r.pos)); c.lineTo(toX(WORLD.BAY_EDGE), toY(r.pos)); c.stroke();
      }
    }

    for (const h of holes) {
      if (!h.alive) continue;
      const r = Math.max(2.4, (h.radius / WORLD.SIZE) * S * 3.6);
      c.beginPath();
      c.arc(toX(h.position.x), toY(h.position.z), r, 0, 7);
      c.fillStyle = h === me ? '#ffffff' : `#${h.color.getHexString()}`;
      c.fill();
      if (h === me) {
        c.strokeStyle = '#ff3d8b'; c.lineWidth = 2.4; c.stroke();
      }
    }
  }
}

function formatScore(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
  ));
}
