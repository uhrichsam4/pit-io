/**
 * MINIMAP
 *
 * WHY THIS IS SPLIT OUT AND CACHED
 *   drawMinimap() runs every single frame. The old version re-stroked the whole
 *   road network (~60 full-map lines) on every one of those frames, which is
 *   pure waste: the city does not move. Everything static — water, parcels,
 *   parks, the road grid, landmark pips — is rasterised ONCE into an offscreen
 *   canvas and blitted with a single drawImage. Per frame we then draw only the
 *   dozen-or-so things that actually change: the holes and the target rings.
 *
 * The map is deliberately a dark, high-contrast reduction of the city rather
 * than a literal top-down of the Miami palette: it sits inside a dark glass
 * panel, and the saturated hole colours have to be the loudest thing on it.
 */

import { WORLD } from '../config.js';

/* Map ink.
 * Value hierarchy is the whole job here: STREETS DARK, PARCELS LIGHT. The
 * first pass had them within a few percent of each other and the grid turned
 * into brown mush at 190 px. Warm throughout — a blue-grey map under a warm
 * city is the same mistake the art bible bans on the asphalt (§3). */
const INK = {
  land: '#4a4137',          // ground with no parcel on it
  street: '#302a23',        // roadway is cut dark INTO the land
  avenue: '#221d18',        // arteries darkest, so the spines read
  block: '#82725a',
  blockTall: '#a58f69',     // towers read lighter: the skyline's mass, mapped
  park: '#419a55',
  plaza: '#998b69',
  bay: '#0f6d8b',
  bayDeep: '#0a4a63',
  river: '#12849b',
  shore: 'rgba(120, 240, 225, 0.8)',
  bridge: '#6c604e',
  landmark: '#ffc93c',
};

const ZONE_INK = {
  park: INK.park,
  plaza: INK.plaza,
  tower: INK.blockTall,
  landmark: INK.blockTall,
  construction: '#7d6a45',
  parking: '#584d3f',
  marina: INK.river,
};

export class Minimap {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this._static = null;
    this._staticFor = null;   // identity of the layout the cache was built from
    this._staticSize = 0;
    this._t = 0;
  }

  /**
   * Backing-store resize. Always supersampled at least 2x: a 190 CSS-px map of
   * a 1040 m city puts a 22 m street at four pixels, and at 1:1 the whole grid
   * turned to mush. The extra pixels are paid for once, in the static layer.
   */
  resize(cssSize, dpr = 1) {
    const px = Math.max(240, Math.round(cssSize * Math.max(2, Math.min(3, dpr))));
    if (px === this.canvas.width) return;
    this.canvas.width = px;
    this.canvas.height = px;
    this._static = null;      // cache is resolution-bound
  }

  /**
   * @param {Array} holes    every hole in the match
   * @param {object} me      the player's hole (highlighted)
   * @param {object} layout  cityLayout output; may be null before the build
   * @param {number} dt      seconds, drives the pulse phases
   */
  draw(holes, me, layout, dt = 0.016) {
    const c = this.ctx;
    const S = this.canvas.width;
    this._t += dt;

    if (!this._static || this._staticFor !== layout || this._staticSize !== S) {
      this._buildStatic(layout, S);
      this._staticFor = layout;
      this._staticSize = S;
    }

    const span = WORLD.SIZE * 2;
    const P = S / span;
    const toX = (x) => (x + WORLD.SIZE) * P;
    const toY = (z) => (z + WORLD.SIZE) * P;

    c.clearRect(0, 0, S, S);
    c.drawImage(this._static, 0, 0);

    /* --- highlight rings on high-value targets the player is near -------- */
    if (layout && layout.landmarks && me) {
      const pulse = 0.5 + 0.5 * Math.sin(this._t * 3.4);
      for (const lm of layout.landmarks) {
        const d = Math.hypot(lm.x - me.position.x, lm.z - me.position.z);
        if (d > 260) continue;
        const x = toX(lm.x), y = toY(lm.z);
        c.beginPath();
        c.arc(x, y, (3.4 + pulse * 2.6) * (S / 336), 0, Math.PI * 2);
        c.strokeStyle = `rgba(255, 201, 60, ${0.75 - pulse * 0.42})`;
        c.lineWidth = 1.6 * (S / 336);
        c.stroke();
      }
    }

    /* --- holes ----------------------------------------------------------- */
    const k = S / 336;                       // authored at 336px, scales up
    for (const h of holes) {
      if (!h || !h.alive || h === me) continue;
      this._hole(c, toX(h.position.x), toY(h.position.z), h, P, k, false);
    }
    if (me && me.alive) {
      this._hole(c, toX(me.position.x), toY(me.position.z), me, P, k, true);
    } else if (me) {
      // Dead: leave a ghost marker where we fell so the respawn read is clear.
      const x = toX(me.position.x), y = toY(me.position.z);
      c.beginPath();
      c.arc(x, y, 5 * k, 0, Math.PI * 2);
      c.strokeStyle = 'rgba(255,61,139,0.7)';
      c.lineWidth = 1.5 * k;
      c.setLineDash([3 * k, 3 * k]);
      c.stroke();
      c.setLineDash([]);
    }
  }

  /* ---------------------------------------------------------------- draw -- */

  _hole(c, x, y, h, P, k, isMe) {
    const hex = h.color && h.color.getHexString ? `#${h.color.getHexString()}` : '#ffffff';
    // Radius on the map is exaggerated: a 6 m hole is 2 px true-to-scale and
    // would be invisible next to a 40 m one.
    const r = Math.min(15 * k, Math.max(isMe ? 3.6 * k : 2.8 * k, h.radius * P * 2.4));

    if (isMe) {
      const pulse = 0.5 + 0.5 * Math.sin(this._t * 4.2);
      c.beginPath();
      c.arc(x, y, r + (4 + pulse * 3.5) * k, 0, Math.PI * 2);
      c.fillStyle = `rgba(255, 61, 139, ${0.20 + pulse * 0.14})`;
      c.fill();
    }

    // Dark halo first: guarantees a saturated dot still separates from a
    // saturated background (grass, bay) at 3 px.
    c.beginPath();
    c.arc(x, y, r + 1.6 * k, 0, Math.PI * 2);
    c.fillStyle = 'rgba(4, 8, 14, 0.72)';
    c.fill();

    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fillStyle = isMe ? '#ffffff' : hex;
    c.fill();

    if (isMe) {
      c.lineWidth = 2 * k;
      c.strokeStyle = '#ff3d8b';
      c.stroke();
      // Heading tick, so you can steer by the map alone.
      const vx = h.velocity ? h.velocity.x : 0;
      const vz = h.velocity ? h.velocity.z : 0;
      const len = Math.hypot(vx, vz);
      if (len > 0.7) {
        const ux = vx / len, uz = vz / len;
        c.beginPath();
        c.moveTo(x + ux * (r + 2 * k), y + uz * (r + 2 * k));
        c.lineTo(x + ux * (r + 7 * k), y + uz * (r + 7 * k));
        c.strokeStyle = '#ffffff';
        c.lineWidth = 2.2 * k;
        c.lineCap = 'round';
        c.stroke();
      }
    }
  }

  /* -------------------------------------------------------------- static -- */

  _buildStatic(layout, S) {
    const cv = this._staticCanvas || (this._staticCanvas = document.createElement('canvas'));
    cv.width = S; cv.height = S;
    const g = cv.getContext('2d');
    const span = WORLD.SIZE * 2;
    const P = S / span;
    const X = (x) => (x + WORLD.SIZE) * P;
    const Y = (z) => (z + WORLD.SIZE) * P;
    const k = S / 336;

    g.clearRect(0, 0, S, S);
    // Generic land first. Parcel-free ground (park bands, the rail cut, the
    // civic superblocks) must not inherit the road colour — the first version
    // did, and downtown grew several convincing black holes.
    g.fillStyle = INK.land;
    g.fillRect(0, 0, S, S);

    if (!layout) { this._static = cv; return; }

    /* --- the street grid, cut INTO the land ------------------------------ */
    const bayX = X(layout.bayEdge ?? WORLD.BAY_EDGE);
    for (const r of layout.roadsX || []) {
      const w = Math.max(1, r.half * 2 * P);
      g.fillStyle = r.cls === 'street' ? INK.street : INK.avenue;
      g.fillRect(X(r.pos) - w / 2, 0, w, S);
    }
    for (const r of layout.roadsZ || []) {
      const w = Math.max(1, r.half * 2 * P);
      g.fillStyle = r.cls === 'street' ? INK.street : INK.avenue;
      g.fillRect(0, Y(r.pos) - w / 2, bayX, w);
    }

    /* --- parcels --------------------------------------------------------- */
    for (const b of layout.blocks || []) {
      const w = b.w * P, d = b.d * P;
      if (w < 0.7 || d < 0.7) continue;
      let ink = ZONE_INK[b.zone] || INK.block;
      // Tall blocks read lighter so the skyline's centre of mass is legible.
      if (b.heightClass === 'super' || b.heightClass === 'high') ink = INK.blockTall;
      g.fillStyle = ink;
      // Inset by half a pixel so adjacent parcels never close up the street.
      g.fillRect(X(b.x - b.w / 2) + 0.5, Y(b.z - b.d / 2) + 0.5, Math.max(1, w - 1), Math.max(1, d - 1));
    }

    /* --- water: bay, river ribbon, basins and cuts ------------------------ */
    const bay = layout.bayEdge ?? WORLD.BAY_EDGE;
    const grad = g.createLinearGradient(X(bay), 0, S, 0);
    grad.addColorStop(0, INK.bay);
    grad.addColorStop(1, INK.bayDeep);
    g.fillStyle = grad;
    g.fillRect(X(bay), 0, S - X(bay), S);

    const river = layout.river;
    if (river && river.samples && river.samples.length > 1) {
      g.beginPath();
      for (let i = 0; i < river.samples.length; i++) {
        const s = river.samples[i];
        const px = X(s.x), py = Y(s.z - s.half);
        i === 0 ? g.moveTo(px, py) : g.lineTo(px, py);
      }
      for (let i = river.samples.length - 1; i >= 0; i--) {
        const s = river.samples[i];
        g.lineTo(X(s.x), Y(s.z + s.half));
      }
      g.closePath();
      g.fillStyle = INK.river;
      g.fill();
    }
    for (const p of layout.waterPolys || []) {
      g.fillStyle = INK.river;
      g.fillRect(X(p.x0), Y(p.z0), (p.x1 - p.x0) * P, (p.z1 - p.z0) * P);
    }
    // Brickell Key is an island: punch the cut, then put the land back.
    const key = layout.brickellKey;
    if (key) {
      g.fillStyle = INK.blockTall;
      g.fillRect(X(key.x0), Y(key.z0), (key.x1 - key.x0) * P, (key.z1 - key.z0) * P);
    }

    /* --- bridges: thin land ties across the channel ---------------------- */
    for (const b of layout.bridges || []) {
      g.fillStyle = INK.bridge;
      g.fillRect(X(b.x - b.width / 2), Y(b.z - b.length / 2),
        Math.max(1, b.width * P), Math.max(1, b.length * P));
    }

    /* --- shoreline: the bay is a wall, and it must look like one --------- */
    g.strokeStyle = INK.shore;
    g.lineWidth = 1.4 * k;
    g.beginPath();
    g.moveTo(X(bay) + 0.5, 0);
    g.lineTo(X(bay) + 0.5, S);
    g.stroke();

    /* --- landmark pips: the map's high-value targets --------------------- */
    for (const lm of layout.landmarks || []) {
      const x = X(lm.x), y = Y(lm.z), s = 2.6 * k;
      g.save();
      g.translate(x, y);
      g.rotate(Math.PI / 4);
      g.fillStyle = 'rgba(6,10,18,0.85)';
      g.fillRect(-s - 1, -s - 1, (s + 1) * 2, (s + 1) * 2);
      g.fillStyle = INK.landmark;
      g.fillRect(-s, -s, s * 2, s * 2);
      g.restore();
    }

    /* --- playfield frame: the hole cannot leave this box ------------------ */
    g.strokeStyle = 'rgba(255,255,255,0.09)';
    g.lineWidth = 1;
    g.strokeRect(0.5, 0.5, S - 1, S - 1);

    this._static = cv;
  }
}
