/**
 * VEHICLES — traffic simulation, parked fleet, boats and site machinery.
 *
 * ---------------------------------------------------------------------------
 * WHY THE GEOMETRY IS BUILT THE WAY IT IS
 * ---------------------------------------------------------------------------
 * A car has to read as a car from 4 m and as a coloured chip from 300 m, and
 * there are ~1700 of them. That rules out a Group of little meshes per vehicle
 * (the old implementation: 6 pools of boxes, and the reason the city was at
 * 5.2k draw calls). Every vehicle here is ONE instanced slot of ONE merged
 * geometry, so a whole fleet of 200 taxis is a single draw call.
 *
 * The awkward part is colour. `InstancedProp` tints via `instanceColor`, which
 * three multiplies over the WHOLE mesh — so tyres, glass and tail lights would
 * all come out tinted with the body paint (a red car would get red windows and
 * invisible tail lights). Instead the paint is baked into a per-vertex `color`
 * attribute and one pool is created per (shape, paint) pair. The positions /
 * normals / uvs are SHARED BufferAttributes across every paint variant of a
 * shape, so ten colours of sedan cost one vertex buffer and ten small colour
 * buffers. It also means the pooled fall-proxy inherits the exact same
 * material, so a car being swallowed keeps its black tyres.
 *
 * Material response comes from an 8x1 "band" texture sampled through the uv:
 * each vertex points at one of eight (roughness, metalness) pairs, so glossy
 * paint, matte tyre rubber, chrome and glass all live in a single
 * MeshStandardMaterial — one shader program for every vehicle in Miami.
 *
 * ---------------------------------------------------------------------------
 * THE TRAFFIC SIM
 * ---------------------------------------------------------------------------
 * Built on roadNetwork.js. A vehicle is (lane, s, v). Per lane we keep a list
 * sorted by s, so car-following is a single backwards sweep — O(n), never
 * O(n^2). Longitudinal control is IDM, which gives smooth queue discharge and
 * a stable stop at a red light for free. Turning hops the vehicle onto a
 * crossing kerb lane at the point where the two lane centrelines meet, and
 * renders a quadratic Bezier through that corner so the path is an arc rather
 * than a right-angle snap.
 *
 * NOTE ON FLUSHING: nothing in the engine calls `props.flushAll()` per frame,
 * and `InstancedProp.setTransform` only marks the pool dirty. So the updater
 * flushes its OWN pools each frame — that is also what makes the wobble the
 * consume system writes into a parked car actually reach the GPU.
 */

import * as THREE from 'three';
import { TIER, WORLD, PALETTE } from '../config.js';
import { CAR_PAINTS } from '../render/palette.js';
import { makeRNG } from '../core/rng.js';
import { solid } from '../core/materials.js';
import { RoadNetwork, LANE_W } from './roadNetwork.js';
import { ROAD_CLASS, ZONE } from './cityLayout.js';

/* ========================================================== materials === */

/**
 * Material bands. uv.x selects one of eight (roughness, metalness) pairs, so a
 * single material covers wet-look paint, dead-matte rubber and chrome.
 */
const BAND = {
  PAINT: 0, GLASS: 1, TYRE: 2, CHROME: 3, MATTE: 4, LENS: 5, HULL: 6, ROUGH: 7,
};
/** [roughness, metalness] per band. */
const BAND_MR = [
  // Paint keeps metalness low: a metallic clear-coat scales diffuse by
  // (1 - metalness), and Miami wants punchy colour, not dark colour.
  [0.30, 0.14], [0.10, 0.58], [0.95, 0.00], [0.20, 0.92],
  [0.62, 0.02], [0.13, 0.05], [0.24, 0.04], [0.74, 0.08],
];

let _bandTex = null;
function bandTexture() {
  if (_bandTex) return _bandTex;
  // Roughness reads green, metalness reads blue — one texture feeds both maps.
  const data = new Uint8Array(BAND_MR.length * 4);
  for (let i = 0; i < BAND_MR.length; i++) {
    data[i * 4 + 0] = 255;
    data[i * 4 + 1] = Math.round(BAND_MR[i][0] * 255);
    data[i * 4 + 2] = Math.round(BAND_MR[i][1] * 255);
    data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, BAND_MR.length, 1, THREE.RGBAFormat);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  _bandTex = t;
  return t;
}

let _vehMat = null;
function vehicleMaterial() {
  if (_vehMat) return _vehMat;
  const bt = bandTexture();
  _vehMat = solid({
    color: 0xffffff,
    vertexColors: true,
    // The band texture carries the absolute values, so the scalars are 1.
    roughness: 1.0,
    metalness: 1.0,
    roughnessMap: bt,
    metalnessMap: bt,
    envMapIntensity: 1.1,
  });
  return _vehMat;
}

/* ============================================================== roles === */

/**
 * A role is "which palette entry and which material band does this triangle
 * use". Baked per vertex as a byte, resolved to a colour when a paint variant
 * is instantiated.
 */
const ROLE_DEFS = [
  ['BODY', 'paint', BAND.PAINT],
  ['BODY_LO', 'paintLo', BAND.PAINT],   // sills, bumpers: the paint knocked back
  ['ROOF', 'roof', BAND.PAINT],
  ['ACCENT', 'accent', BAND.PAINT],     // livery band, roof sign, stripe
  ['WHITE', 'white', BAND.PAINT],
  ['GLASS', 'glass', BAND.GLASS],
  ['TYRE', 'tyre', BAND.TYRE],
  ['RIM', 'rim', BAND.CHROME],
  ['CHROME', 'chrome', BAND.CHROME],
  ['HEAD', 'head', BAND.LENS],
  ['TAIL', 'tail', BAND.LENS],
  ['AMBER', 'amber', BAND.LENS],
  ['PLATE', 'plate', BAND.MATTE],
  ['DARK', 'dark', BAND.MATTE],
  ['SEAT', 'seat', BAND.MATTE],
  ['HULL', 'hull', BAND.HULL],
  ['DECK', 'deck', BAND.MATTE],
  ['SAIL', 'sail', BAND.MATTE],
  ['MACH', 'paint', BAND.ROUGH],        // machinery paint: no showroom gloss
  ['MACH_LO', 'paintLo', BAND.ROUGH],
  ['STEEL', 'steel', BAND.CHROME],
  ['BLUE', 'blue', BAND.PAINT],
  ['RED', 'red', BAND.PAINT],
  ['GREEN', 'green', BAND.PAINT],
];
/** @type {Record<string, number>} */
const ROLE = {};
const ROLE_KEY = [];
const ROLE_BAND = [];
for (let i = 0; i < ROLE_DEFS.length; i++) {
  ROLE[ROLE_DEFS[i][0]] = i;
  ROLE_KEY.push(ROLE_DEFS[i][1]);
  ROLE_BAND.push(ROLE_DEFS[i][2]);
}

const _c = new THREE.Color();
/** sRGB hex -> the linear triple three expects in a vertex colour attribute. */
function lin(hex) {
  _c.setHex(hex);
  return [_c.r, _c.g, _c.b];
}
function darken(hex, k) {
  const r = Math.round(((hex >> 16) & 255) * k);
  const g = Math.round(((hex >> 8) & 255) * k);
  const b = Math.round((hex & 255) * k);
  return (r << 16) | (g << 8) | b;
}

/** Resolve a variant spec into the linear colour used by every role. */
function paletteFor(v) {
  const paint = v.paint ?? PALETTE.CAR_WHITE;
  const table = {
    paint,
    paintLo: v.paintLo ?? darken(paint, 0.66),
    roof: v.roof ?? paint,
    accent: v.accent ?? PALETTE.CAR_GRAPHITE,
    white: v.white ?? PALETTE.TRUCK_WHITE,
    glass: v.glass ?? 0x35505e,
    tyre: PALETTE.TYRE,
    rim: v.rim ?? PALETTE.ALUMINIUM,
    chrome: PALETTE.CHROME,
    head: PALETTE.HEADLIGHT,
    tail: PALETTE.TAILLIGHT,
    amber: PALETTE.INDICATOR,
    plate: 0xf0ead6,
    dark: 0x23262a,
    seat: 0x3a3c40,
    hull: v.hull ?? PALETTE.HULL_WHITE,
    deck: v.deck ?? PALETTE.TEAK,
    sail: PALETTE.SAIL,
    steel: PALETTE.STEEL,
    blue: v.blue ?? PALETTE.POLICE_BLUE,
    red: v.red ?? PALETTE.CAR_RED,
    green: v.green ?? PALETTE.BIN_GREEN,
  };
  return ROLE_KEY.map((k) => lin(table[k]));
}

/* ===================================================== shape building === */

/**
 * Triangle soup with a role byte per vertex. Flat normals throughout: the art
 * bible asks for chunky confident forms, and a faceted 8-gon wheel reads better
 * in this language than a smooth one anyway.
 */
class Shape {
  constructor() {
    this.p = []; this.n = []; this.u = []; this.r = [];
  }
  get tris() { return this.r.length / 3; }

  _push(v, nx, ny, nz, role) {
    this.p.push(v[0], v[1], v[2]);
    this.n.push(nx, ny, nz);
    this.u.push((ROLE_BAND[role] + 0.5) / BAND_MR.length, 0.5);
    this.r.push(role);
  }

  /**
   * Emit a triangle, auto-orienting it so the normal points away from `ref`.
   * Every primitive below is locally convex about its own centre, so this
   * removes an entire class of winding bugs at zero runtime cost.
   */
  tri(a, b, c, role, ref) {
    let ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    let vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz);
    if (L < 1e-9) return;
    nx /= L; ny /= L; nz /= L;
    let flip = false;
    if (ref) {
      const mx = (a[0] + b[0] + c[0]) / 3 - ref[0];
      const my = (a[1] + b[1] + c[1]) / 3 - ref[1];
      const mz = (a[2] + b[2] + c[2]) / 3 - ref[2];
      if (nx * mx + ny * my + nz * mz < 0) flip = true;
    }
    if (flip) {
      nx = -nx; ny = -ny; nz = -nz;
      this._push(a, nx, ny, nz, role);
      this._push(c, nx, ny, nz, role);
      this._push(b, nx, ny, nz, role);
    } else {
      this._push(a, nx, ny, nz, role);
      this._push(b, nx, ny, nz, role);
      this._push(c, nx, ny, nz, role);
    }
  }

  quad(a, b, c, d, role, ref) {
    this.tri(a, b, c, role, ref);
    this.tri(a, c, d, role, ref);
  }

  /** Explicit-normal quad — for decals that sit flush on a surface. */
  flat(a, b, c, d, role, nrm) {
    for (const [x, y, z] of [a, b, c, a, c, d]) {
      this._push([x, y, z], nrm[0], nrm[1], nrm[2], role);
    }
  }

  finish() {
    const count = this.r.length;
    const pos = new THREE.BufferAttribute(new Float32Array(this.p), 3);
    const nor = new THREE.BufferAttribute(new Float32Array(this.n), 3);
    const uv = new THREE.BufferAttribute(new Float32Array(this.u), 2);
    return { count, pos, nor, uv, roles: Uint8Array.from(this.r) };
  }
}

/* ------------------------------------------------------- primitives --- */

/** Plain 12-triangle box. For small parts where a chamfer would not be seen. */
function box(sh, cx, cy, cz, w, h, d, role) {
  const hx = w / 2, hy = h / 2, hz = d / 2;
  const ref = [cx, cy, cz];
  const P = (sx, sy, sz) => [cx + sx * hx, cy + sy * hy, cz + sz * hz];
  sh.quad(P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), P(1, -1, 1), role, ref);
  sh.quad(P(-1, -1, -1), P(-1, 1, -1), P(-1, 1, 1), P(-1, -1, 1), role, ref);
  sh.quad(P(-1, 1, -1), P(1, 1, -1), P(1, 1, 1), P(-1, 1, 1), role, ref);
  sh.quad(P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1), role, ref);
  sh.quad(P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1), role, ref);
  sh.quad(P(-1, -1, -1), P(1, -1, -1), P(1, 1, -1), P(-1, 1, -1), role, ref);
}

/**
 * Chamfered box — 44 triangles. "Bevel everything" is rule one of the geometry
 * bible; this is the workhorse for anything the camera gets close to.
 */
function chamfer(sh, cx, cy, cz, w, h, d, b, role) {
  const hx = w / 2, hy = h / 2, hz = d / 2;
  const e = Math.max(0.01, Math.min(b, hx * 0.55, hy * 0.55, hz * 0.55));
  const ref = [cx, cy, cz];
  // ax picks which axis is at full extent; the other two are inset by e.
  const P = (sx, sy, sz, ax) => [
    cx + sx * (ax === 0 ? hx : hx - e),
    cy + sy * (ax === 1 ? hy : hy - e),
    cz + sz * (ax === 2 ? hz : hz - e),
  ];
  for (const s of [-1, 1]) {
    sh.quad(P(s, -1, -1, 0), P(s, 1, -1, 0), P(s, 1, 1, 0), P(s, -1, 1, 0), role, ref);
    sh.quad(P(-1, s, -1, 1), P(1, s, -1, 1), P(1, s, 1, 1), P(-1, s, 1, 1), role, ref);
    sh.quad(P(-1, -1, s, 2), P(1, -1, s, 2), P(1, 1, s, 2), P(-1, 1, s, 2), role, ref);
  }
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      sh.quad(P(sx, sy, -1, 0), P(sx, sy, -1, 1), P(sx, sy, 1, 1), P(sx, sy, 1, 0), role, ref);
    }
    for (const sz of [-1, 1]) {
      sh.quad(P(sx, -1, sz, 0), P(sx, -1, sz, 2), P(sx, 1, sz, 2), P(sx, 1, sz, 0), role, ref);
    }
  }
  for (const sy of [-1, 1]) {
    for (const sz of [-1, 1]) {
      sh.quad(P(-1, sy, sz, 1), P(-1, sy, sz, 2), P(1, sy, sz, 2), P(1, sy, sz, 1), role, ref);
    }
  }
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        sh.tri(P(sx, sy, sz, 0), P(sx, sy, sz, 1), P(sx, sy, sz, 2), role, ref);
      }
    }
  }
}

/** Cylinder along an axis. `caps` = [startCap, endCap]. */
function cyl(sh, cx, cy, cz, r0, r1, len, seg, axis, role, caps = [true, true]) {
  const ref = [cx, cy, cz];
  const h = len / 2;
  const pt = (t, rad, along) => {
    const a = Math.cos(t) * rad, b = Math.sin(t) * rad;
    if (axis === 'x') return [cx + along, cy + b, cz + a];
    if (axis === 'y') return [cx + a, cy + along, cz + b];
    return [cx + a, cy + b, cz + along];
  };
  const c0 = axis === 'x' ? [cx - h, cy, cz] : axis === 'y' ? [cx, cy - h, cz] : [cx, cy, cz - h];
  const c1 = axis === 'x' ? [cx + h, cy, cz] : axis === 'y' ? [cx, cy + h, cz] : [cx, cy, cz + h];
  for (let i = 0; i < seg; i++) {
    const t0 = (i / seg) * Math.PI * 2, t1 = ((i + 1) / seg) * Math.PI * 2;
    sh.quad(pt(t0, r0, -h), pt(t1, r0, -h), pt(t1, r1, h), pt(t0, r1, h), role, ref);
    if (caps[0]) sh.tri(c0, pt(t0, r0, -h), pt(t1, r0, -h), role, ref);
    if (caps[1]) sh.tri(c1, pt(t0, r1, h), pt(t1, r1, h), role, ref);
  }
}

/**
 * A road wheel. The inner face is never visible, so only the outer disc is
 * emitted and it gets the rim colour — a light hub inside a dark tyre is what
 * makes a wheel read as a wheel at 40 m.
 */
function wheel(sh, cx, cy, cz, r, width, seg = 8) {
  const ref = [cx, cy, cz];
  const side = cx >= 0 ? 1 : -1;
  const xo = cx + side * width / 2, xi = cx - side * width / 2;
  const pt = (t, rad, x) => [x, cy + Math.sin(t) * rad, cz + Math.cos(t) * rad];
  const hub = [xo + side * 0.004, cy, cz];
  const inward = [cx - side * 2, cy, cz];
  for (let i = 0; i < seg; i++) {
    const t0 = (i / seg) * Math.PI * 2, t1 = ((i + 1) / seg) * Math.PI * 2;
    sh.quad(pt(t0, r, xo), pt(t1, r, xo), pt(t1, r, xi), pt(t0, r, xi), ROLE.TYRE, ref);
    sh.tri(hub, pt(t0, r * 0.64, xo), pt(t1, r * 0.64, xo), ROLE.RIM, inward);
  }
}

/**
 * Swept profile: the core car-body primitive. A 2D section (unit coordinates,
 * x in -1..1 and y in 0..1) is walked along a list of stations, each with its
 * own width, height, floor and rake. Sides get per-edge roles, so a window band
 * costs nothing extra — it is just an edge of the section tagged GLASS.
 */
function sweep(sh, prof, stations, opt = {}) {
  const role = opt.role ?? ROLE.BODY;
  const edgeRoles = opt.edgeRoles || null;
  const skip = opt.skip || null;
  const n = prof.length;
  let rx = 0, ry = 0, rz = 0;
  for (const st of stations) { rx += 0; ry += st.y0 + st.h * 0.5; rz += st.z; }
  const ref = [0, ry / stations.length, rz / stations.length];
  const P = (st, i) => [
    prof[i][0] * st.w * 0.5,
    st.y0 + prof[i][1] * st.h,
    st.z + (st.rake || 0) * prof[i][1],
  ];
  for (let s = 0; s < stations.length - 1; s++) {
    const A = stations[s], B = stations[s + 1];
    for (let i = 0; i < n; i++) {
      if (skip && skip.has(i)) continue;
      const j = (i + 1) % n;
      const er = edgeRoles && edgeRoles[i] !== undefined ? edgeRoles[i] : role;
      sh.quad(P(A, i), P(A, j), P(B, j), P(B, i), er, ref);
    }
  }
  const cap = (st, r) => {
    if (r === false || r === undefined) return;
    const c = [0, st.y0 + st.h * 0.5, st.z + (st.rake || 0) * 0.5];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      sh.tri(c, P(st, i), P(st, j), r, ref);
    }
  };
  cap(stations[0], opt.capStart);
  cap(stations[stations.length - 1], opt.capEnd);
}

/** Unit sections reused across the fleet. */
const SEC = {
  /** Chamfered box section — car lower bodies, truck boxes. */
  OCT: [
    [-1.00, 0.22], [-0.80, 0.00], [0.80, 0.00], [1.00, 0.22],
    [1.00, 0.80], [0.78, 1.00], [-0.78, 1.00], [-1.00, 0.80],
  ],
  /** Greenhouse: vertical glass flanks, chamfered roof. */
  CABIN: [
    [-1.00, 0.00], [1.00, 0.00], [1.00, 0.66],
    [0.80, 1.00], [-0.80, 1.00], [-1.00, 0.66],
  ],
  /** Bus / van flank: skirt, window band, cant rail, chamfered roof. */
  COACH: [
    [-1.00, 0.06], [-0.90, 0.00], [0.90, 0.00], [1.00, 0.06],
    [1.00, 0.34], [1.00, 0.78], [1.00, 0.93], [0.84, 1.00],
    [-0.84, 1.00], [-1.00, 0.93], [-1.00, 0.78], [-1.00, 0.34],
  ],
  /** Boat hull section: deep vee rising to a flared sheer. */
  HULL: [
    [-1.00, 0.55], [-0.72, 0.16], [0.00, 0.00], [0.72, 0.16],
    [1.00, 0.55], [1.00, 1.00], [-1.00, 1.00],
  ],
};

/** Edge-role maps for the sections above. */
const OCT_SILL = { 0: ROLE.BODY_LO, 1: ROLE.BODY_LO, 2: ROLE.BODY_LO };
const CABIN_ROLES = {
  0: ROLE.BODY_LO, 1: ROLE.GLASS, 2: ROLE.ROOF,
  3: ROLE.ROOF, 4: ROLE.ROOF, 5: ROLE.GLASS,
};
const COACH_ROLES = {
  0: ROLE.BODY_LO, 1: ROLE.BODY_LO, 2: ROLE.BODY_LO, 3: ROLE.BODY_LO,
  4: ROLE.GLASS, 5: ROLE.BODY, 6: ROLE.ROOF, 7: ROLE.ROOF,
  8: ROLE.ROOF, 9: ROLE.BODY, 10: ROLE.GLASS, 11: ROLE.BODY_LO,
};

/* ==================================================== shape: fittings === */

/** Decal quad on a z-facing surface (lamps, plates, grilles). */
function faceZ(sh, x, y, z, w, h, role, dz) {
  const hx = w / 2, hy = h / 2, zz = z + dz * 0.014;
  const a = [x - hx, y - hy, zz], b = [x + hx, y - hy, zz];
  const c = [x + hx, y + hy, zz], d = [x - hx, y + hy, zz];
  if (dz > 0) sh.flat(a, b, c, d, role, [0, 0, 1]);
  else sh.flat(b, a, d, c, role, [0, 0, -1]);
}

/** Decal quad on an x-facing surface (door livery, side markers). */
function faceX(sh, x, y, z, d, h, role, dx) {
  const hz = d / 2, hy = h / 2, xx = x + dx * 0.014;
  const a = [xx, y - hy, z - hz], b = [xx, y - hy, z + hz];
  const c = [xx, y + hy, z + hz], e = [xx, y + hy, z - hz];
  if (dx > 0) sh.flat(a, b, c, e, role, [1, 0, 0]);
  else sh.flat(b, a, e, c, role, [-1, 0, 0]);
}

/** Decal quad lying on a horizontal surface (roof markings, deck panels). */
function faceY(sh, x, y, z, w, d, role) {
  const hx = w / 2, hz = d / 2, yy = y + 0.014;
  sh.flat([x - hx, yy, z + hz], [x + hx, yy, z + hz],
    [x + hx, yy, z - hz], [x - hx, yy, z - hz], role, [0, 1, 0]);
}

function wheels4(sh, wx, zF, zR, r, w, seg = 6) {
  wheel(sh, wx, r, zF, r, w, seg); wheel(sh, -wx, r, zF, r, w, seg);
  wheel(sh, wx, r, zR, r, w, seg); wheel(sh, -wx, r, zR, r, w, seg);
}

/** Wing mirrors on stalks — a tiny silhouette cue that reads instantly. */
function mirrors(sh, x, y, z) {
  for (const s of [-1, 1]) box(sh, s * (x + 0.05), y, z, 0.20, 0.13, 0.06, ROLE.DARK);
}

/** Head/tail lamps, indicators, grille and number plates for a road car. */
function carLamps(sh, o) {
  const { zF, zR, yH, yT, dx, wL = 0.42, hL = 0.15 } = o;
  for (const s of [-1, 1]) {
    faceZ(sh, s * dx, yH, zF, wL, hL, ROLE.HEAD, 1);
    faceZ(sh, s * (dx - wL * 0.5 - 0.13), yH, zF, 0.16, hL * 0.8, ROLE.AMBER, 1);
    faceZ(sh, s * dx, yT, zR, wL * 0.92, hL, ROLE.TAIL, -1);
  }
  if (o.grille !== false) faceZ(sh, 0, o.yG ?? yH - 0.24, zF, o.wG ?? 1.02, 0.17, ROLE.DARK, 1);
  faceZ(sh, 0, o.yP ?? 0.44, zF, 0.44, 0.12, ROLE.PLATE, 1);
  faceZ(sh, 0, o.yP ?? 0.44, zR, 0.44, 0.12, ROLE.PLATE, -1);
}

/* ====================================================== shape: cars ==== */

function sedan(sh) {
  sweep(sh, SEC.OCT, [
    { z: -2.31, w: 1.62, h: 0.70, y0: 0.38 },
    { z: -1.74, w: 1.84, h: 0.76, y0: 0.33 },
    { z: 1.28, w: 1.84, h: 0.76, y0: 0.33 },
    { z: 2.31, w: 1.60, h: 0.66, y0: 0.36 },
  ], { edgeRoles: OCT_SILL, capStart: ROLE.BODY_LO, capEnd: ROLE.BODY_LO });
  sweep(sh, SEC.CABIN, [
    { z: -1.40, w: 1.58, h: 0.46, y0: 1.06, rake: 0.42 },
    { z: -0.10, w: 1.70, h: 0.50, y0: 1.06 },
    { z: 1.00, w: 1.54, h: 0.44, y0: 1.06, rake: -0.48 },
  ], { edgeRoles: CABIN_ROLES, skip: new Set([0]), capStart: ROLE.GLASS, capEnd: ROLE.GLASS });
  wheels4(sh, 0.86, 1.45, -1.45, 0.36, 0.26);
  carLamps(sh, { zF: 2.31, zR: -2.31, yH: 0.72, yT: 0.78, dx: 0.56 });
  mirrors(sh, 0.95, 1.06, 0.66);
}

function suv(sh) {
  sweep(sh, SEC.OCT, [
    { z: -2.42, w: 1.74, h: 0.94, y0: 0.46 },
    { z: -1.80, w: 1.96, h: 1.00, y0: 0.41 },
    { z: 1.40, w: 1.96, h: 1.00, y0: 0.41 },
    { z: 2.42, w: 1.76, h: 0.90, y0: 0.45 },
  ], { edgeRoles: OCT_SILL, capStart: ROLE.BODY_LO, capEnd: ROLE.BODY_LO });
  sweep(sh, SEC.CABIN, [
    { z: -1.94, w: 1.72, h: 0.60, y0: 1.34, rake: 0.16 },
    { z: -0.20, w: 1.82, h: 0.62, y0: 1.34 },
    { z: 1.06, w: 1.66, h: 0.54, y0: 1.34, rake: -0.42 },
  ], { edgeRoles: CABIN_ROLES, skip: new Set([0]), capStart: ROLE.GLASS, capEnd: ROLE.GLASS });
  // Roof rails: the one detail that separates an SUV from a tall hatchback.
  for (const s of [-1, 1]) box(sh, s * 0.66, 2.00, -0.4, 0.07, 0.07, 2.5, ROLE.DARK);
  wheels4(sh, 0.93, 1.55, -1.55, 0.42, 0.30);
  carLamps(sh, { zF: 2.42, zR: -2.42, yH: 1.02, yT: 1.16, dx: 0.62, wL: 0.46, yG: 0.72, wG: 1.14, yP: 0.52 });
  mirrors(sh, 1.02, 1.40, 0.76);
}

function hatchback(sh) {
  sweep(sh, SEC.OCT, [
    { z: -1.98, w: 1.60, h: 0.82, y0: 0.38 },
    { z: -1.44, w: 1.76, h: 0.84, y0: 0.34 },
    { z: 1.10, w: 1.76, h: 0.80, y0: 0.34 },
    { z: 1.98, w: 1.56, h: 0.62, y0: 0.36 },
  ], { edgeRoles: OCT_SILL, capStart: ROLE.BODY_LO, capEnd: ROLE.BODY_LO });
  sweep(sh, SEC.CABIN, [
    { z: -1.86, w: 1.54, h: 0.44, y0: 1.14, rake: -0.30 },
    { z: -0.30, w: 1.66, h: 0.48, y0: 1.14 },
    { z: 0.86, w: 1.50, h: 0.42, y0: 1.12, rake: -0.44 },
  ], { edgeRoles: CABIN_ROLES, skip: new Set([0]), capStart: ROLE.GLASS, capEnd: ROLE.GLASS });
  wheels4(sh, 0.84, 1.28, -1.28, 0.35, 0.25);
  carLamps(sh, { zF: 1.98, zR: -1.98, yH: 0.76, yT: 0.94, dx: 0.54, wL: 0.36, wG: 0.9, yP: 0.46 });
  mirrors(sh, 0.92, 1.16, 0.50);
}

function pickup(sh) {
  // Cab + separate bed: the step between them is the whole silhouette.
  sweep(sh, SEC.OCT, [
    { z: -2.72, w: 1.86, h: 0.88, y0: 0.54 },
    { z: -0.30, w: 2.02, h: 0.94, y0: 0.50 },
    { z: 1.86, w: 2.02, h: 1.02, y0: 0.50 },
    { z: 2.72, w: 1.84, h: 0.94, y0: 0.52 },
  ], { edgeRoles: OCT_SILL, capStart: ROLE.BODY_LO, capEnd: ROLE.BODY_LO });
  sweep(sh, SEC.CABIN, [
    { z: -0.30, w: 1.80, h: 0.66, y0: 1.40, rake: 0.10 },
    { z: 0.52, w: 1.86, h: 0.68, y0: 1.40 },
    { z: 1.36, w: 1.70, h: 0.58, y0: 1.40, rake: -0.40 },
  ], { edgeRoles: CABIN_ROLES, skip: new Set([0]), capStart: ROLE.GLASS, capEnd: ROLE.GLASS });
  // Bed walls + tailgate.
  for (const s of [-1, 1]) box(sh, s * 0.94, 1.24, -1.55, 0.14, 0.44, 2.28, ROLE.BODY);
  box(sh, 0, 1.24, -2.66, 1.94, 0.44, 0.14, ROLE.BODY);
  faceY(sh, 0, 1.40, -1.55, 1.74, 2.24, ROLE.DARK);
  wheels4(sh, 0.97, 1.75, -1.78, 0.46, 0.33);
  carLamps(sh, { zF: 2.72, zR: -2.72, yH: 1.08, yT: 1.24, dx: 0.66, wL: 0.44, yG: 0.78, wG: 1.2, yP: 0.58 });
  mirrors(sh, 1.08, 1.46, 0.58);
}

function sports(sh) {
  sweep(sh, SEC.OCT, [
    { z: -2.21, w: 1.72, h: 0.56, y0: 0.40 },
    { z: -1.30, w: 1.92, h: 0.64, y0: 0.32 },
    { z: 0.60, w: 1.92, h: 0.58, y0: 0.30 },
    { z: 1.60, w: 1.80, h: 0.44, y0: 0.30 },
    { z: 2.21, w: 1.60, h: 0.34, y0: 0.30 },
  ], { edgeRoles: OCT_SILL, capStart: ROLE.BODY_LO, capEnd: ROLE.BODY_LO });
  // Fastback: the cabin trails all the way to the tail in one line.
  sweep(sh, SEC.CABIN, [
    { z: -2.10, w: 1.56, h: 0.20, y0: 0.92, rake: 0.06 },
    { z: -0.70, w: 1.76, h: 0.40, y0: 0.92 },
    { z: 0.62, w: 1.62, h: 0.34, y0: 0.86, rake: -0.62 },
  ], { edgeRoles: CABIN_ROLES, skip: new Set([0]), capStart: ROLE.BODY, capEnd: ROLE.GLASS });
  chamfer(sh, 0, 1.16, -2.02, 1.44, 0.06, 0.34, 0.03, ROLE.BODY_LO);  // ducktail spoiler
  wheels4(sh, 0.91, 1.38, -1.38, 0.38, 0.32);
  carLamps(sh, { zF: 2.21, zR: -2.21, yH: 0.60, yT: 0.72, dx: 0.60, wL: 0.40, hL: 0.11, yG: 0.40, wG: 1.1, yP: 0.38 });
  mirrors(sh, 0.99, 0.96, 0.44);
}

function convertible(sh) {
  sweep(sh, SEC.OCT, [
    { z: -2.17, w: 1.62, h: 0.72, y0: 0.38 },
    { z: -1.50, w: 1.84, h: 0.78, y0: 0.33 },
    { z: 1.10, w: 1.84, h: 0.76, y0: 0.33 },
    { z: 2.17, w: 1.58, h: 0.58, y0: 0.35 },
  ], { edgeRoles: OCT_SILL, capStart: ROLE.BODY_LO, capEnd: ROLE.BODY_LO });
  // Open cockpit: a sunk tub, two headrests and a raked screen.
  faceY(sh, 0, 1.04, -0.30, 1.48, 1.70, ROLE.SEAT);
  for (const s of [-1, 1]) chamfer(sh, s * 0.40, 1.20, -0.92, 0.44, 0.30, 0.24, 0.07, ROLE.SEAT);
  const zw = 0.62;
  sh.quad([-0.78, 1.06, zw], [0.78, 1.06, zw], [0.68, 1.46, zw - 0.30], [-0.68, 1.46, zw - 0.30],
    ROLE.GLASS, [0, 0.6, -1]);
  for (const s of [-1, 1]) {
    box(sh, s * 0.73, 1.26, zw - 0.15, 0.05, 0.42, 0.34, ROLE.CHROME);
  }
  wheels4(sh, 0.87, 1.36, -1.36, 0.37, 0.27);
  carLamps(sh, { zF: 2.17, zR: -2.17, yH: 0.70, yT: 0.78, dx: 0.56, wL: 0.38, yP: 0.44 });
  mirrors(sh, 0.95, 1.06, 0.52);
}

function taxi(sh) {
  sedan(sh);
  // Roof sign + the livery band down the doors.
  chamfer(sh, 0, 1.58, 0.10, 0.72, 0.20, 0.26, 0.05, ROLE.ACCENT);
  for (const s of [-1, 1]) faceX(sh, s * 0.92, 0.68, -0.1, 2.5, 0.22, ROLE.ACCENT, s);
}

function police(sh) {
  suv(sh);
  // Light bar with red and blue ends, plus a door shield panel.
  chamfer(sh, 0, 2.02, 0.20, 1.24, 0.16, 0.32, 0.05, ROLE.DARK);
  faceZ(sh, -0.42, 2.02, 0.36, 0.36, 0.12, ROLE.RED, 1);
  faceZ(sh, 0.42, 2.02, 0.36, 0.36, 0.12, ROLE.BLUE, 1);
  for (const s of [-1, 1]) faceX(sh, s * 0.98, 0.96, -0.2, 1.9, 0.5, ROLE.BLUE, s);
}

/* ================================================ shape: vans, trucks == */

function deliveryVan(sh) {
  sweep(sh, SEC.COACH, [
    { z: -2.95, w: 1.94, h: 2.20, y0: 0.34 },
    { z: -2.10, w: 2.06, h: 2.24, y0: 0.30 },
    { z: 1.30, w: 2.06, h: 2.24, y0: 0.30 },
    { z: 2.35, w: 1.94, h: 1.90, y0: 0.30, rake: -0.30 },
  ], {
    edgeRoles: { ...COACH_ROLES, 4: ROLE.BODY, 10: ROLE.BODY },
    capStart: ROLE.BODY, capEnd: ROLE.GLASS,
  });
  // Cab glazing only — the load box behind it is solid panel.
  for (const s of [-1, 1]) faceX(sh, s * 1.03, 1.66, 1.00, 1.00, 0.62, ROLE.GLASS, s);
  chamfer(sh, 0, 0.42, 2.62, 1.90, 0.30, 0.30, 0.07, ROLE.BODY_LO);
  wheels4(sh, 0.98, 1.70, -1.98, 0.43, 0.30);
  carLamps(sh, { zF: 2.95, zR: -2.95, yH: 0.78, yT: 1.30, dx: 0.70, wL: 0.34, yG: 0.50, wG: 1.1, yP: 0.42 });
  mirrors(sh, 1.10, 1.86, 1.62);
}

function boxTruck(sh) {
  // Cab.
  sweep(sh, SEC.OCT, [
    { z: 1.10, w: 2.24, h: 2.05, y0: 0.55 },
    { z: 3.30, w: 2.24, h: 1.95, y0: 0.55 },
    { z: 3.80, w: 2.10, h: 1.70, y0: 0.55 },
  ], { edgeRoles: OCT_SILL, capStart: false, capEnd: ROLE.BODY_LO });
  for (const s of [-1, 1]) faceX(sh, s * 1.12, 2.05, 3.00, 1.20, 0.72, ROLE.GLASS, s);
  faceZ(sh, 0, 2.10, 3.80, 1.86, 0.78, ROLE.GLASS, 1);
  // Load box, deliberately a touch wider than the cab.
  chamfer(sh, 0, 2.05, -1.55, 2.38, 2.60, 5.40, 0.10, ROLE.WHITE);
  faceX(sh, 1.20, 2.05, -1.55, 5.10, 1.90, ROLE.ACCENT, 1);
  faceX(sh, -1.20, 2.05, -1.55, 5.10, 1.90, ROLE.ACCENT, -1);
  chamfer(sh, 0, 0.62, -1.55, 2.30, 0.30, 5.30, 0.06, ROLE.DARK);
  wheels4(sh, 1.13, 2.70, -2.10, 0.54, 0.34);
  wheel(sh, 1.13, 0.54, -3.10, 0.54, 0.34, 6); wheel(sh, -1.13, 0.54, -3.10, 0.54, 0.34, 6);
  carLamps(sh, { zF: 3.90, zR: -4.28, yH: 0.86, yT: 1.00, dx: 0.80, wL: 0.40, yG: 0.52, wG: 1.3, yP: 0.48 });
  mirrors(sh, 1.22, 2.30, 3.30);
}

function flatbed(sh) {
  sweep(sh, SEC.OCT, [
    { z: 1.30, w: 2.20, h: 1.95, y0: 0.60 },
    { z: 3.30, w: 2.20, h: 1.90, y0: 0.60 },
    { z: 3.86, w: 2.06, h: 1.66, y0: 0.60 },
  ], { edgeRoles: OCT_SILL, capStart: false, capEnd: ROLE.BODY_LO });
  for (const s of [-1, 1]) faceX(sh, s * 1.10, 2.00, 3.00, 1.10, 0.70, ROLE.GLASS, s);
  faceZ(sh, 0, 2.06, 3.86, 1.82, 0.74, ROLE.GLASS, 1);
  chamfer(sh, 0, 1.02, -1.30, 2.34, 0.26, 5.60, 0.06, ROLE.DECK);
  // Stake sides — an open deck needs an edge or it reads as a plank.
  for (const s of [-1, 1]) {
    chamfer(sh, s * 1.12, 1.30, -1.30, 0.10, 0.34, 5.50, 0.04, ROLE.BODY_LO);
    for (let i = 0; i < 4; i++) box(sh, s * 1.12, 1.72, -3.6 + i * 1.5, 0.10, 0.86, 0.12, ROLE.STEEL);
  }
  chamfer(sh, 0, 0.60, -1.30, 2.20, 0.34, 5.50, 0.06, ROLE.DARK);
  wheels4(sh, 1.00, 2.70, -2.20, 0.48, 0.30);
  wheel(sh, 1.00, 0.48, -3.20, 0.48, 0.30, 7); wheel(sh, -1.00, 0.48, -3.20, 0.48, 0.30, 7);
  carLamps(sh, { zF: 3.96, zR: -4.10, yH: 0.86, yT: 1.02, dx: 0.78, wL: 0.38, yG: 0.52, wG: 1.2, yP: 0.48 });
  mirrors(sh, 1.20, 2.24, 3.30);
}

function garbageTruck(sh) {
  sweep(sh, SEC.OCT, [
    { z: 1.60, w: 2.28, h: 2.20, y0: 0.58 },
    { z: 3.40, w: 2.28, h: 2.10, y0: 0.58 },
    { z: 3.92, w: 2.14, h: 1.86, y0: 0.58 },
  ], { edgeRoles: OCT_SILL, capStart: false, capEnd: ROLE.BODY_LO });
  for (const s of [-1, 1]) faceX(sh, s * 1.14, 2.20, 3.10, 1.10, 0.74, ROLE.GLASS, s);
  faceZ(sh, 0, 2.26, 3.92, 1.90, 0.80, ROLE.GLASS, 1);
  // Hopper with the classic sloped back and a tipped rear loader.
  sweep(sh, SEC.OCT, [
    { z: -3.40, w: 2.30, h: 2.10, y0: 0.66 },
    { z: -2.20, w: 2.38, h: 2.55, y0: 0.66 },
    { z: 1.40, w: 2.38, h: 2.55, y0: 0.66 },
  ], { edgeRoles: OCT_SILL, capStart: ROLE.MACH_LO, capEnd: false, role: ROLE.MACH });
  chamfer(sh, 0, 1.34, -4.10, 2.20, 2.00, 1.20, 0.10, ROLE.MACH_LO);
  for (const s of [-1, 1]) box(sh, s * 1.05, 2.90, -1.0, 0.16, 0.16, 4.4, ROLE.STEEL);
  chamfer(sh, 0, 0.66, -0.9, 2.24, 0.32, 6.4, 0.06, ROLE.DARK);
  wheels4(sh, 1.02, 2.80, -1.90, 0.50, 0.32);
  wheel(sh, 1.02, 0.50, -2.95, 0.50, 0.32, 7); wheel(sh, -1.02, 0.50, -2.95, 0.50, 0.32, 7);
  carLamps(sh, { zF: 4.02, zR: -4.72, yH: 0.90, yT: 1.10, dx: 0.82, wL: 0.38, yG: 0.54, wG: 1.3, yP: 0.50 });
  mirrors(sh, 1.24, 2.44, 3.36);
}

function cementMixer(sh) {
  sweep(sh, SEC.OCT, [
    { z: 1.70, w: 2.26, h: 2.20, y0: 0.60 },
    { z: 3.40, w: 2.26, h: 2.10, y0: 0.60 },
    { z: 3.90, w: 2.12, h: 1.86, y0: 0.60 },
  ], { edgeRoles: OCT_SILL, capStart: false, capEnd: ROLE.BODY_LO });
  for (const s of [-1, 1]) faceX(sh, s * 1.13, 2.20, 3.10, 1.10, 0.74, ROLE.GLASS, s);
  faceZ(sh, 0, 2.26, 3.90, 1.88, 0.80, ROLE.GLASS, 1);
  // The drum: two tapered cylinders tilted nose-up, plus the feed chute.
  // Nose-down toward the discharge chute at the rear, like the real thing.
  const tilt = 0.13;
  const drumY = 2.55, drumZ = -0.90;
  const sy = Math.sin(tilt), cyy = Math.cos(tilt);
  const seg = 10;
  const emit = (r0, r1, z0, z1, role) => {
    const mz = (z0 + z1) / 2;
    cyl(sh, 0, drumY - (mz - drumZ) * sy, drumZ + (mz - drumZ) * cyy,
      r0, r1, Math.abs(z1 - z0), seg, 'z', role, [false, false]);
  };
  emit(0.70, 1.30, -3.60, -2.10, ROLE.MACH);
  emit(1.30, 1.30, -2.10, 0.40, ROLE.MACH);
  emit(1.30, 0.86, 0.40, 1.50, ROLE.MACH);
  cyl(sh, 0, drumY + 0.36, -3.72, 0.72, 0.72, 0.14, seg, 'z', ROLE.MACH_LO);
  chamfer(sh, 0, 1.60, -4.30, 1.10, 0.30, 1.30, 0.08, ROLE.STEEL);
  for (const s of [-1, 1]) box(sh, s * 1.06, 1.30, -1.2, 0.14, 1.70, 0.20, ROLE.STEEL);
  chamfer(sh, 0, 0.66, -0.9, 2.16, 0.34, 6.6, 0.06, ROLE.DARK);
  wheels4(sh, 1.02, 2.80, -1.80, 0.50, 0.32);
  wheel(sh, 1.02, 0.50, -2.90, 0.50, 0.32, 7); wheel(sh, -1.02, 0.50, -2.90, 0.50, 0.32, 7);
  carLamps(sh, { zF: 4.00, zR: -4.60, yH: 0.90, yT: 1.06, dx: 0.80, wL: 0.36, yG: 0.54, wG: 1.3, yP: 0.50 });
  mirrors(sh, 1.22, 2.44, 3.34);
}

/* ================================================== shape: passenger === */

function cityBus(sh) {
  sweep(sh, SEC.COACH, [
    { z: -5.75, w: 2.36, h: 2.90, y0: 0.36, rake: 0.10 },
    { z: -5.05, w: 2.55, h: 2.94, y0: 0.32 },
    { z: 4.95, w: 2.55, h: 2.94, y0: 0.32 },
    { z: 5.75, w: 2.36, h: 2.86, y0: 0.32, rake: -0.14 },
  ], { edgeRoles: COACH_ROLES, capStart: ROLE.GLASS, capEnd: ROLE.GLASS });
  // Destination blind + a livery flash so buses are not a plain slab.
  faceZ(sh, 0, 3.02, 5.78, 1.70, 0.30, ROLE.DARK, 1);
  for (const s of [-1, 1]) faceX(sh, s * 1.28, 1.10, 0, 10.2, 0.52, ROLE.ACCENT, s);
  // Door leaves, in the two places a real bus puts them.
  for (const z of [3.30, -1.40]) {
    for (const s of [-1, 1]) faceX(sh, s * 1.28, 1.60, z, 1.20, 1.90, ROLE.GLASS, s);
  }
  chamfer(sh, 0, 3.30, 1.2, 1.30, 0.26, 2.20, 0.08, ROLE.WHITE);   // roof AC pod
  chamfer(sh, 0, 0.42, 0, 2.36, 0.34, 11.0, 0.06, ROLE.DARK);
  wheels4(sh, 1.22, 4.10, -3.40, 0.56, 0.36);
  wheel(sh, 1.22, 0.56, -4.55, 0.56, 0.36, 6); wheel(sh, -1.22, 0.56, -4.55, 0.56, 0.36, 6);
  carLamps(sh, { zF: 5.80, zR: -5.80, yH: 0.80, yT: 1.00, dx: 0.90, wL: 0.40, grille: false, yP: 0.48 });
  mirrors(sh, 1.34, 2.70, 5.40);
}

function articBus(sh) {
  sweep(sh, SEC.COACH, [
    { z: -0.60, w: 2.42, h: 2.90, y0: 0.34 },
    { z: 0.20, w: 2.55, h: 2.94, y0: 0.32 },
    { z: 8.10, w: 2.55, h: 2.94, y0: 0.32 },
    { z: 8.90, w: 2.36, h: 2.86, y0: 0.32, rake: -0.14 },
  ], { edgeRoles: COACH_ROLES, capStart: false, capEnd: ROLE.GLASS });
  // Concertina joint: a narrower ribbed section is what sells "articulated".
  for (let i = 0; i < 6; i++) {
    chamfer(sh, 0, 1.74, -0.66 - i * 0.22, 2.30 - (i % 2) * 0.12, 2.70, 0.21, 0.05, ROLE.DARK);
  }
  sweep(sh, SEC.COACH, [
    { z: -8.90, w: 2.36, h: 2.88, y0: 0.34, rake: 0.12 },
    { z: -8.20, w: 2.55, h: 2.94, y0: 0.32 },
    { z: -2.00, w: 2.55, h: 2.94, y0: 0.32 },
  ], { edgeRoles: COACH_ROLES, capStart: ROLE.BODY, capEnd: false });
  for (const s of [-1, 1]) {
    faceX(sh, s * 1.28, 1.10, 4.2, 8.0, 0.52, ROLE.ACCENT, s);
    faceX(sh, s * 1.28, 1.10, -5.4, 6.0, 0.52, ROLE.ACCENT, s);
  }
  for (const z of [6.60, 2.60, -4.20]) {
    for (const s of [-1, 1]) faceX(sh, s * 1.28, 1.60, z, 1.20, 1.90, ROLE.GLASS, s);
  }
  faceZ(sh, 0, 3.02, 8.92, 1.70, 0.30, ROLE.DARK, 1);
  chamfer(sh, 0, 0.42, 3.6, 2.34, 0.34, 10.4, 0.06, ROLE.DARK);
  chamfer(sh, 0, 0.42, -5.4, 2.34, 0.34, 7.0, 0.06, ROLE.DARK);
  wheels4(sh, 1.22, 7.20, 1.10, 0.56, 0.36);
  wheel(sh, 1.22, 0.56, -6.60, 0.56, 0.36, 6); wheel(sh, -1.22, 0.56, -6.60, 0.56, 0.36, 6);
  carLamps(sh, { zF: 8.95, zR: -8.95, yH: 0.80, yT: 1.00, dx: 0.90, wL: 0.40, grille: false, yP: 0.48 });
  mirrors(sh, 1.34, 2.70, 8.50);
}

function shuttleBus(sh) {
  sweep(sh, SEC.COACH, [
    { z: -3.55, w: 2.06, h: 2.34, y0: 0.36, rake: 0.10 },
    { z: -3.00, w: 2.22, h: 2.38, y0: 0.32 },
    { z: 2.60, w: 2.22, h: 2.38, y0: 0.32 },
    { z: 3.55, w: 2.04, h: 2.20, y0: 0.32, rake: -0.26 },
  ], { edgeRoles: COACH_ROLES, capStart: ROLE.BODY, capEnd: ROLE.GLASS });
  for (const s of [-1, 1]) faceX(sh, s * 1.12, 1.00, 0, 5.8, 0.42, ROLE.ACCENT, s);
  faceX(sh, 1.12, 1.44, 1.60, 1.00, 1.70, ROLE.GLASS, 1);
  chamfer(sh, 0, 2.86, -1.40, 1.50, 0.30, 2.40, 0.08, ROLE.WHITE);   // roof luggage pod
  chamfer(sh, 0, 0.42, 0, 2.06, 0.32, 6.6, 0.06, ROLE.DARK);
  wheels4(sh, 1.07, 2.30, -2.20, 0.48, 0.32);
  carLamps(sh, { zF: 3.60, zR: -3.60, yH: 0.80, yT: 1.02, dx: 0.76, wL: 0.36, yG: 0.52, wG: 1.2, yP: 0.46 });
  mirrors(sh, 1.18, 2.24, 3.20);
}

function ambulance(sh) {
  sweep(sh, SEC.OCT, [
    { z: 1.20, w: 2.02, h: 1.90, y0: 0.42 },
    { z: 2.60, w: 2.02, h: 1.86, y0: 0.42 },
    { z: 3.10, w: 1.90, h: 1.60, y0: 0.42 },
  ], { edgeRoles: OCT_SILL, capStart: false, capEnd: ROLE.WHITE, role: ROLE.WHITE });
  for (const s of [-1, 1]) faceX(sh, s * 1.01, 1.90, 2.35, 1.00, 0.64, ROLE.GLASS, s);
  faceZ(sh, 0, 1.94, 3.10, 1.66, 0.70, ROLE.GLASS, 1);
  chamfer(sh, 0, 1.60, -1.10, 2.24, 2.20, 4.70, 0.10, ROLE.WHITE);
  for (const s of [-1, 1]) {
    faceX(sh, s * 1.13, 1.30, -1.10, 4.40, 0.40, ROLE.RED, s);
    faceX(sh, s * 1.13, 2.10, -0.40, 1.30, 0.90, ROLE.GLASS, s);
  }
  chamfer(sh, 0, 2.82, 1.10, 1.40, 0.18, 0.34, 0.05, ROLE.RED);      // light bar
  faceZ(sh, 0, 1.10, -3.46, 1.60, 1.40, ROLE.DARK, -1);              // rear doors
  chamfer(sh, 0, 0.50, 0, 2.10, 0.30, 5.9, 0.06, ROLE.DARK);
  wheels4(sh, 1.06, 1.90, -1.90, 0.46, 0.30);
  carLamps(sh, { zF: 3.20, zR: -3.48, yH: 0.86, yT: 1.06, dx: 0.72, wL: 0.36, yG: 0.54, wG: 1.1, yP: 0.48 });
  mirrors(sh, 1.14, 2.06, 2.60);
}

/* ================================================ shape: two-wheelers == */

function scooter(sh) {
  chamfer(sh, 0, 0.52, -0.10, 0.34, 0.30, 1.00, 0.09, ROLE.BODY);
  chamfer(sh, 0, 0.72, 0.62, 0.30, 0.52, 0.30, 0.08, ROLE.BODY);
  chamfer(sh, 0, 0.74, -0.50, 0.40, 0.14, 0.60, 0.05, ROLE.SEAT);
  box(sh, 0, 1.02, 0.72, 0.52, 0.05, 0.06, ROLE.DARK);               // bars
  faceZ(sh, 0, 0.92, 0.78, 0.18, 0.14, ROLE.HEAD, 1);
  chamfer(sh, 0, 0.86, -0.86, 0.34, 0.24, 0.20, 0.05, ROLE.BODY_LO); // top box
  wheel(sh, 0.02, 0.30, 0.66, 0.30, 0.11, 8);
  wheel(sh, 0.02, 0.30, -0.66, 0.30, 0.13, 8);
}

function bicycle(sh) {
  for (const z of [0.55, -0.55]) {
    // Thin rims: a torus is far too many triangles for something this small.
    for (let i = 0; i < 10; i++) {
      const a0 = (i / 10) * Math.PI * 2, a1 = ((i + 1) / 10) * Math.PI * 2;
      const r = 0.33, ri = 0.28;
      const p0 = [0, 0.33 + Math.sin(a0) * r, z + Math.cos(a0) * r];
      const p1 = [0, 0.33 + Math.sin(a1) * r, z + Math.cos(a1) * r];
      const p2 = [0, 0.33 + Math.sin(a1) * ri, z + Math.cos(a1) * ri];
      const p3 = [0, 0.33 + Math.sin(a0) * ri, z + Math.cos(a0) * ri];
      sh.flat(p0, p1, p2, p3, ROLE.TYRE, [1, 0, 0]);
      sh.flat(p3, p2, p1, p0, ROLE.TYRE, [-1, 0, 0]);
    }
  }
  box(sh, 0, 0.60, 0.02, 0.05, 0.05, 1.02, ROLE.BODY);
  box(sh, 0, 0.48, 0.30, 0.05, 0.34, 0.05, ROLE.BODY);
  box(sh, 0, 0.62, -0.42, 0.05, 0.50, 0.05, ROLE.BODY);
  box(sh, 0, 0.88, -0.52, 0.13, 0.06, 0.30, ROLE.SEAT);
  box(sh, 0, 0.96, 0.48, 0.46, 0.04, 0.05, ROLE.DARK);
}

/* ===================================================== shape: boats ==== */

const HULL_ROLES = { 5: ROLE.WHITE };

/**
 * Boats are modelled with y = 0 at the waterline, so the placement code can
 * drop them straight onto the water plane and the bob animation is a simple
 * offset rather than a per-hull constant.
 */
function motorYacht(sh) {
  sweep(sh, SEC.HULL, [
    { z: -6.30, w: 3.50, h: 1.55, y0: -0.95 },
    { z: -4.20, w: 4.10, h: 1.70, y0: -1.05 },
    { z: 2.40, w: 4.20, h: 1.75, y0: -1.05 },
    { z: 5.60, w: 2.90, h: 1.70, y0: -0.95 },
    { z: 7.10, w: 0.80, h: 1.55, y0: -0.75 },
  ], { role: ROLE.HULL, edgeRoles: HULL_ROLES, capStart: ROLE.HULL, capEnd: ROLE.HULL });
  // Boot stripe at the waterline — the single cue that reads "boat" not "shed".
  for (const s of [-1, 1]) faceX(sh, s * 2.06, -0.10, -1.0, 10.4, 0.22, ROLE.ACCENT, s);
  // Saloon + flybridge, stepping back as they rise.
  chamfer(sh, 0, 1.35, -0.40, 3.50, 1.50, 6.20, 0.22, ROLE.WHITE);
  for (const s of [-1, 1]) faceX(sh, s * 1.76, 1.55, -0.40, 5.40, 0.72, ROLE.GLASS, s);
  faceZ(sh, 0, 1.62, 2.72, 2.70, 0.80, ROLE.GLASS, 1);
  chamfer(sh, 0, 2.70, -1.60, 2.80, 1.20, 3.80, 0.20, ROLE.WHITE);
  for (const s of [-1, 1]) faceX(sh, s * 1.41, 2.86, -1.60, 3.20, 0.60, ROLE.GLASS, s);
  chamfer(sh, 0, 3.42, -1.60, 2.60, 0.14, 3.60, 0.06, ROLE.WHITE);
  // Radar arch + mast.
  for (const s of [-1, 1]) box(sh, s * 1.10, 4.00, -2.90, 0.14, 1.20, 0.16, ROLE.STEEL);
  box(sh, 0, 4.58, -2.90, 2.36, 0.16, 0.18, ROLE.STEEL);
  cyl(sh, 0, 5.10, -2.90, 0.05, 0.05, 1.10, 6, 'y', ROLE.STEEL);
  chamfer(sh, 0, 4.78, -2.90, 0.60, 0.20, 0.24, 0.06, ROLE.WHITE);
  // Bow rail + foredeck fittings.
  for (const s of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      box(sh, s * (1.9 - i * 0.32), 1.02, 3.6 + i * 0.85, 0.05, 0.52, 0.05, ROLE.CHROME);
    }
  }
  faceY(sh, 0, 0.62, -4.40, 2.10, 2.60, ROLE.DECK);      // cockpit sole
}

function sailBoat(sh) {
  sweep(sh, SEC.HULL, [
    { z: -4.60, w: 2.40, h: 1.40, y0: -0.80 },
    { z: -2.60, w: 3.00, h: 1.55, y0: -0.95 },
    { z: 1.60, w: 3.10, h: 1.60, y0: -0.95 },
    { z: 4.40, w: 1.90, h: 1.55, y0: -0.85 },
    { z: 5.40, w: 0.50, h: 1.40, y0: -0.70 },
  ], { role: ROLE.HULL, edgeRoles: HULL_ROLES, capStart: ROLE.HULL, capEnd: ROLE.HULL });
  for (const s of [-1, 1]) faceX(sh, s * 1.52, -0.12, -0.6, 8.2, 0.18, ROLE.ACCENT, s);
  // Coachroof + cockpit.
  chamfer(sh, 0, 0.86, 0.90, 1.90, 0.50, 3.40, 0.16, ROLE.WHITE);
  for (const s of [-1, 1]) faceX(sh, s * 0.96, 0.90, 0.90, 2.80, 0.26, ROLE.GLASS, s);
  faceY(sh, 0, 0.58, -2.60, 1.30, 2.10, ROLE.DECK);
  // Mast, boom and a furled main — a bare pole reads as a broken boat.
  cyl(sh, 0, 6.20, 0.60, 0.09, 0.07, 11.2, 6, 'y', ROLE.CHROME);
  cyl(sh, 0, 1.70, -1.20, 0.07, 0.07, 3.40, 6, 'z', ROLE.CHROME);
  chamfer(sh, 0, 1.92, -1.20, 0.34, 0.34, 3.10, 0.12, ROLE.SAIL);
  // Standing rigging as two thin stays, fore and aft.
  box(sh, 0, 5.60, 2.60, 0.035, 8.6, 0.035, ROLE.CHROME);
  box(sh, 0, 5.20, -1.80, 0.035, 8.0, 0.035, ROLE.CHROME);
}

function waterTaxi(sh) {
  sweep(sh, SEC.HULL, [
    { z: -3.90, w: 2.50, h: 1.30, y0: -0.72 },
    { z: -2.20, w: 2.80, h: 1.40, y0: -0.80 },
    { z: 2.00, w: 2.80, h: 1.40, y0: -0.80 },
    { z: 3.90, w: 1.40, h: 1.30, y0: -0.70 },
  ], { role: ROLE.HULL, edgeRoles: HULL_ROLES, capStart: ROLE.HULL, capEnd: ROLE.HULL });
  for (const s of [-1, 1]) faceX(sh, s * 1.38, -0.08, 0, 6.6, 0.20, ROLE.ACCENT, s);
  // Open canopy on posts: passengers should read as "outside".
  for (const s of [-1, 1]) {
    for (const z of [1.60, -0.20, -2.00]) box(sh, s * 1.15, 1.55, z, 0.08, 1.50, 0.08, ROLE.CHROME);
  }
  chamfer(sh, 0, 2.36, -0.20, 2.60, 0.16, 4.40, 0.07, ROLE.ACCENT);
  chamfer(sh, 0, 1.10, 2.30, 1.70, 1.00, 1.30, 0.12, ROLE.WHITE);
  faceZ(sh, 0, 1.30, 2.96, 1.30, 0.52, ROLE.GLASS, 1);
  for (const z of [0.60, -0.90, -2.40]) chamfer(sh, 0, 0.80, z, 2.10, 0.14, 0.44, 0.05, ROLE.DECK);
  faceY(sh, 0, 0.58, -0.6, 2.10, 5.4, ROLE.SEAT);
}

function skiff(sh) {
  sweep(sh, SEC.HULL, [
    { z: -2.40, w: 1.70, h: 0.90, y0: -0.48 },
    { z: -1.20, w: 1.90, h: 0.95, y0: -0.52 },
    { z: 1.30, w: 1.85, h: 0.95, y0: -0.52 },
    { z: 2.55, w: 0.70, h: 0.88, y0: -0.45 },
  ], { role: ROLE.HULL, edgeRoles: HULL_ROLES, capStart: ROLE.HULL, capEnd: ROLE.HULL });
  chamfer(sh, 0, 0.78, 0.30, 0.80, 0.62, 0.60, 0.10, ROLE.WHITE);   // centre console
  box(sh, 0, 1.18, 0.30, 0.60, 0.06, 0.06, ROLE.CHROME);
  chamfer(sh, 0, 0.78, -1.90, 0.44, 0.70, 0.36, 0.08, ROLE.DARK);   // outboard
  cyl(sh, 0, 0.20, -2.10, 0.11, 0.11, 0.50, 6, 'y', ROLE.DARK);
  for (const z of [-0.70, 1.00]) chamfer(sh, 0, 0.50, z, 1.55, 0.10, 0.34, 0.04, ROLE.SEAT);
}

function sportFisher(sh) {
  sweep(sh, SEC.HULL, [
    { z: -5.60, w: 3.20, h: 1.50, y0: -0.90 },
    { z: -3.40, w: 3.70, h: 1.62, y0: -1.00 },
    { z: 2.20, w: 3.70, h: 1.66, y0: -1.00 },
    { z: 5.00, w: 2.30, h: 1.60, y0: -0.90 },
    { z: 6.30, w: 0.60, h: 1.45, y0: -0.72 },
  ], { role: ROLE.HULL, edgeRoles: HULL_ROLES, capStart: ROLE.HULL, capEnd: ROLE.HULL });
  for (const s of [-1, 1]) faceX(sh, s * 1.82, -0.10, -0.6, 9.4, 0.20, ROLE.ACCENT, s);
  chamfer(sh, 0, 1.20, 1.30, 3.10, 1.20, 4.00, 0.20, ROLE.WHITE);
  faceZ(sh, 0, 1.42, 3.32, 2.40, 0.72, ROLE.GLASS, 1);
  for (const s of [-1, 1]) faceX(sh, s * 1.56, 1.42, 1.30, 3.40, 0.66, ROLE.GLASS, s);
  faceY(sh, 0, 0.62, -3.60, 2.30, 3.00, ROLE.DECK);
  // Tuna tower — the unmistakable sportfisher silhouette.
  for (const s of [-1, 1]) {
    box(sh, s * 1.05, 2.80, 1.30, 0.09, 2.00, 0.09, ROLE.CHROME);
    box(sh, s * 1.05, 3.86, 1.30, 0.09, 1.30, 0.09, ROLE.CHROME);
  }
  chamfer(sh, 0, 3.86, 1.30, 2.30, 0.12, 1.60, 0.05, ROLE.WHITE);
  chamfer(sh, 0, 4.58, 1.30, 1.60, 0.14, 1.10, 0.05, ROLE.WHITE);
  cyl(sh, 0, 5.60, -0.60, 0.05, 0.04, 2.20, 6, 'y', ROLE.CHROME);   // outrigger
}

function cruiseShip(sh) {
  sweep(sh, SEC.HULL, [
    { z: -22.0, w: 8.4, h: 6.4, y0: -3.6 },
    { z: -16.0, w: 10.0, h: 7.0, y0: -4.0 },
    { z: 12.0, w: 10.2, h: 7.0, y0: -4.0 },
    { z: 20.0, w: 6.4, h: 6.6, y0: -3.6 },
    { z: 23.5, w: 1.6, h: 6.0, y0: -3.0 },
  ], { role: ROLE.HULL, edgeRoles: HULL_ROLES, capStart: ROLE.HULL, capEnd: ROLE.HULL });
  for (const s of [-1, 1]) {
    faceX(sh, s * 5.05, -0.60, -2, 36, 1.10, ROLE.BLUE, s);
    faceX(sh, s * 5.05, 1.60, -2, 34, 1.30, ROLE.GLASS, s);
  }
  // Four stepped accommodation decks with continuous window bands.
  const decks = [[3.0, 9.6, 40], [6.0, 9.0, 37], [9.0, 8.0, 32], [11.8, 6.4, 24]];
  for (let i = 0; i < decks.length; i++) {
    const [y, w, L] = decks[i];
    chamfer(sh, 0, y + 1.35, -2, w, 2.70, L, 0.30, ROLE.WHITE);
    for (const s of [-1, 1]) faceX(sh, s * w * 0.5, y + 1.55, -2, L - 3, 1.10, ROLE.GLASS, s);
  }
  chamfer(sh, 0, 14.4, 2.0, 5.2, 1.6, 12.0, 0.24, ROLE.WHITE);
  chamfer(sh, 0, 16.2, 8.0, 6.6, 2.0, 4.4, 0.26, ROLE.WHITE);       // bridge
  for (const s of [-1, 1]) faceX(sh, s * 3.31, 16.4, 8.0, 3.8, 1.20, ROLE.GLASS, s);
  faceZ(sh, 0, 16.4, 10.22, 5.8, 1.20, ROLE.GLASS, 1);
  cyl(sh, 0, 18.0, -6.0, 2.1, 1.8, 5.6, 10, 'y', ROLE.ACCENT);      // funnel
  cyl(sh, 0, 21.0, -6.0, 1.8, 1.7, 0.5, 10, 'y', ROLE.DARK);
  faceY(sh, 0, 13.2, -14.0, 5.4, 8.0, ROLE.BLUE);        // pool deck
}

/* ================================================ shape: machinery ===== */

function excavator(sh) {
  for (const s of [-1, 1]) {
    chamfer(sh, s * 1.10, 0.44, 0, 0.72, 0.88, 4.30, 0.22, ROLE.DARK);
    for (let i = 0; i < 7; i++) box(sh, s * 1.10, 0.10, -1.8 + i * 0.6, 0.80, 0.10, 0.22, ROLE.STEEL);
  }
  cyl(sh, 0, 1.02, -0.20, 1.10, 1.10, 0.28, 10, 'y', ROLE.MACH_LO);
  chamfer(sh, 0, 1.62, -1.05, 2.40, 1.00, 2.60, 0.16, ROLE.MACH);   // house + counterweight
  chamfer(sh, -0.72, 2.10, 0.62, 1.10, 1.90, 1.60, 0.14, ROLE.MACH);
  faceZ(sh, -0.72, 2.30, 1.44, 0.86, 1.10, ROLE.GLASS, 1);
  faceX(sh, -1.28, 2.30, 0.62, 1.30, 1.10, ROLE.GLASS, -1);
  // Boom / stick / bucket. Angles chosen so the machine reads as "working".
  const boom = (x, y, z, len, ang, w) => {
    const c = Math.cos(ang), s2 = Math.sin(ang);
    const sh2 = new Shape();
    chamfer(sh2, 0, 0, 0, w, w * 1.25, len, 0.06, ROLE.MACH);
    for (let i = 0; i < sh2.p.length; i += 3) {
      const py = sh2.p[i + 1], pz = sh2.p[i + 2];
      sh2.p[i + 1] = y + py * c - pz * s2;
      sh2.p[i + 2] = z + py * s2 + pz * c;
      sh2.p[i] += x;
      const ny = sh2.n[i + 1], nz = sh2.n[i + 2];
      sh2.n[i + 1] = ny * c - nz * s2;
      sh2.n[i + 2] = ny * s2 + nz * c;
    }
    sh.p.push(...sh2.p); sh.n.push(...sh2.n); sh.u.push(...sh2.u); sh.r.push(...sh2.r);
  };
  boom(0.66, 2.70, 2.00, 3.60, 0.62, 0.44);
  boom(0.66, 3.30, 4.30, 2.80, -0.95, 0.36);
  chamfer(sh, 0.66, 1.30, 5.55, 0.98, 0.80, 0.90, 0.10, ROLE.STEEL);
  for (let i = 0; i < 4; i++) box(sh, 0.20 + i * 0.30, 0.94, 5.96, 0.12, 0.30, 0.24, ROLE.STEEL);
}

function wheelLoader(sh) {
  chamfer(sh, 0, 1.30, -1.50, 2.10, 1.10, 2.40, 0.18, ROLE.MACH);   // rear engine block
  chamfer(sh, 0, 1.20, 0.60, 1.90, 0.80, 2.00, 0.16, ROLE.MACH);
  chamfer(sh, 0, 2.30, -0.55, 1.60, 1.60, 1.50, 0.14, ROLE.MACH_LO);
  for (const s of [-1, 1]) faceX(sh, s * 0.81, 2.45, -0.55, 1.20, 1.10, ROLE.GLASS, s);
  faceZ(sh, 0, 2.45, 0.21, 1.30, 1.10, ROLE.GLASS, 1);
  chamfer(sh, 0, 3.14, -0.55, 1.66, 0.14, 1.56, 0.05, ROLE.MACH);
  // Lift arms and bucket.
  for (const s of [-1, 1]) {
    const sh2 = new Shape();
    chamfer(sh2, 0, 0, 0, 0.22, 0.34, 3.30, 0.06, ROLE.MACH);
    const ang = -0.30, c = Math.cos(ang), sn = Math.sin(ang);
    for (let i = 0; i < sh2.p.length; i += 3) {
      const py = sh2.p[i + 1], pz = sh2.p[i + 2];
      sh2.p[i] += s * 0.86;
      sh2.p[i + 1] = 1.70 + py * c - pz * sn;
      sh2.p[i + 2] = 1.90 + py * sn + pz * c;
      const ny = sh2.n[i + 1], nz = sh2.n[i + 2];
      sh2.n[i + 1] = ny * c - nz * sn;
      sh2.n[i + 2] = ny * sn + nz * c;
    }
    sh.p.push(...sh2.p); sh.n.push(...sh2.n); sh.u.push(...sh2.u); sh.r.push(...sh2.r);
  }
  chamfer(sh, 0, 0.72, 3.34, 2.60, 1.05, 1.05, 0.12, ROLE.STEEL);
  chamfer(sh, 0, 0.28, 3.82, 2.60, 0.18, 0.30, 0.04, ROLE.DARK);
  wheels4(sh, 0.98, 1.10, -1.70, 0.72, 0.44, 8);
}

function siteDumper(sh) {
  chamfer(sh, 0, 1.90, 2.30, 2.30, 1.90, 2.10, 0.16, ROLE.MACH);
  for (const s of [-1, 1]) faceX(sh, s * 1.16, 2.20, 2.40, 1.40, 0.90, ROLE.GLASS, s);
  faceZ(sh, 0, 2.20, 3.36, 1.80, 0.90, ROLE.GLASS, 1);
  chamfer(sh, 0, 0.86, 0.20, 2.20, 0.70, 6.60, 0.10, ROLE.MACH_LO);
  // Tipper body — raked up at the front so it reads as a skip, not a box.
  sweep(sh, SEC.OCT, [
    { z: -3.60, w: 2.60, h: 1.50, y0: 1.28 },
    { z: 0.60, w: 2.70, h: 1.60, y0: 1.28 },
    { z: 1.30, w: 2.70, h: 2.10, y0: 1.28 },
  ], { role: ROLE.MACH_LO, capStart: ROLE.MACH_LO, capEnd: ROLE.MACH_LO });
  faceY(sh, 0, 1.60, -1.20, 2.30, 4.60, ROLE.DARK);
  wheels4(sh, 1.06, 2.20, -1.60, 0.74, 0.46, 8);
  wheel(sh, 1.06, 0.74, -3.05, 0.74, 0.46, 8);
  wheel(sh, -1.06, 0.74, -3.05, 0.74, 0.46, 8);
  carLamps(sh, { zF: 3.46, zR: -4.40, yH: 1.30, yT: 1.40, dx: 0.90, wL: 0.30, grille: false, yP: 1.00 });
}

function craneBase(sh) {
  chamfer(sh, 0, 0.35, 0, 7.4, 0.70, 7.4, 0.14, ROLE.DARK);          // ballast pad
  for (const s of [-1, 1]) {
    for (const t of [-1, 1]) chamfer(sh, s * 2.4, 1.00, t * 2.4, 2.0, 0.60, 2.0, 0.10, ROLE.DARK);
  }
  // Lattice mast: four legs plus diagonals, which is the whole visual signature.
  const H = 16.0;
  for (const s of [-1, 1]) {
    for (const t of [-1, 1]) box(sh, s * 0.90, H / 2 + 0.7, t * 0.90, 0.20, H, 0.20, ROLE.MACH);
  }
  for (let i = 0; i < 8; i++) {
    const y = 1.1 + i * 2.0;
    for (const s of [-1, 1]) {
      box(sh, s * 0.90, y, 0, 0.13, 0.13, 1.90, ROLE.MACH);
      box(sh, 0, y, s * 0.90, 1.90, 0.13, 0.13, ROLE.MACH);
    }
  }
  cyl(sh, 0, H + 0.9, 0, 1.15, 1.15, 0.40, 10, 'y', ROLE.MACH_LO);
}

function scissorLift(sh) {
  chamfer(sh, 0, 0.30, 0, 1.50, 0.44, 2.60, 0.10, ROLE.MACH_LO);
  for (const s of [-1, 1]) {
    for (const z of [0.95, -0.95]) wheel(sh, s * 0.72, 0.24, z, 0.24, 0.18, 7);
  }
  // Two crossed pairs of arms — the X is the shape people recognise.
  for (let k = 0; k < 2; k++) {
    const y = 0.72 + k * 1.30;
    for (const s of [-1, 1]) {
      for (const d of [-1, 1]) {
        const sh2 = new Shape();
        box(sh2, 0, 0, 0, 0.10, 0.20, 2.30, ROLE.STEEL);
        const ang = d * 0.55, c = Math.cos(ang), sn = Math.sin(ang);
        for (let i = 0; i < sh2.p.length; i += 3) {
          const py = sh2.p[i + 1], pz = sh2.p[i + 2];
          sh2.p[i] += s * 0.60;
          sh2.p[i + 1] = y + py * c - pz * sn;
          sh2.p[i + 2] = py * sn + pz * c;
          const ny = sh2.n[i + 1], nz = sh2.n[i + 2];
          sh2.n[i + 1] = ny * c - nz * sn;
          sh2.n[i + 2] = ny * sn + nz * c;
        }
        sh.p.push(...sh2.p); sh.n.push(...sh2.n); sh.u.push(...sh2.u); sh.r.push(...sh2.r);
      }
    }
  }
  chamfer(sh, 0, 2.72, 0, 1.60, 0.16, 2.80, 0.06, ROLE.MACH);
  for (const s of [-1, 1]) {
    box(sh, s * 0.78, 3.32, 0, 0.07, 1.10, 2.72, ROLE.MACH);
    box(sh, 0, 3.32, s * 1.36, 1.60, 1.10, 0.07, ROLE.MACH);
  }
}

function roadRoller(sh) {
  cyl(sh, 0, 0.62, 1.45, 0.62, 0.62, 1.90, 12, 'x', ROLE.STEEL);
  chamfer(sh, 0, 1.00, 0.35, 1.30, 0.70, 1.30, 0.12, ROLE.MACH);
  chamfer(sh, 0, 1.10, -1.10, 1.90, 1.00, 2.10, 0.14, ROLE.MACH);
  chamfer(sh, 0, 2.10, -0.90, 1.20, 1.10, 1.20, 0.12, ROLE.MACH_LO);
  for (const s of [-1, 1]) faceX(sh, s * 0.61, 2.20, -0.90, 0.90, 0.72, ROLE.GLASS, s);
  chamfer(sh, 0, 2.72, -0.90, 1.34, 0.12, 1.34, 0.05, ROLE.MACH);
  wheel(sh, 0.82, 0.60, -1.90, 0.60, 0.40, 8);
  wheel(sh, -0.82, 0.60, -1.90, 0.60, 0.40, 8);
}

/* ====================================================== the catalogue === */

const SHAPE_FN = {
  sedan, suv, hatchback, pickup, sports, convertible, taxi, police,
  deliveryVan, boxTruck, flatbed, garbageTruck, cementMixer,
  cityBus, articBus, shuttleBus, ambulance, scooter, bicycle,
  motorYacht, sailBoat, waterTaxi, skiff, sportFisher, cruiseShip,
  excavator, wheelLoader, siteDumper, craneBase, scissorLift, roadRoller,
};

const _shapeCache = new Map();
function getShape(key) {
  let s = _shapeCache.get(key);
  if (!s) {
    const sh = new Shape();
    SHAPE_FN[key](sh);
    s = sh.finish();
    _shapeCache.set(key, s);
  }
  return s;
}

/**
 * A paint variant. Positions/normals/uvs are the SAME BufferAttribute objects
 * for every variant of a shape, so ten colours of sedan upload one vertex
 * buffer and ten small colour buffers.
 */
function variantGeometry(key, spec) {
  const s = getShape(key);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', s.pos);
  g.setAttribute('normal', s.nor);
  g.setAttribute('uv', s.uv);
  const pal = paletteFor(spec);
  const col = new Float32Array(s.count * 3);
  for (let i = 0; i < s.count; i++) {
    const c = pal[s.roles[i]];
    col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

/**
 * Triangles per shape and the resulting fleet cost. Exported so the geometry
 * budget can be checked without booting a renderer:
 *   node -e "import('./src/world/vehicles.js').then(m=>console.log(m.vehicleShapeStats()))"
 */
export function vehicleShapeStats() {
  const out = {};
  let total = 0;
  for (const k of Object.keys(SHAPE_FN)) {
    const t = getShape(k).count / 3;
    out[k] = t;
    total += t;
  }
  out._total = total;
  return out;
}

const P = PALETTE;
const plain = (list) => list.map((c) => ({ paint: c }));

/**
 * radius/height feed the swallow physics; len feeds car-following. Which
 * vehicles appear where is decided by the ROAD_MIX / KERB_MIX / LOT_MIX tables
 * below, not by a flag here.
 */
const FLEET = {
  sedan: { tier: 'LARGE', r: 1.6, h: 1.5, len: 4.7, cap: 180, label: 'Sedan',
    paints: plain([P.CAR_WHITE, P.CAR_SILVER, P.CAR_RED, P.CAR_BLUE, P.CAR_CORAL, P.CAR_GRAPHITE]) },
  suv: { tier: 'LARGE', r: 1.7, h: 1.85, len: 4.9, cap: 150, label: 'SUV',
    paints: plain([P.CAR_BLACK, P.CAR_WHITE, P.CAR_SILVER, P.CAR_GREEN, P.CAR_ORANGE]) },
  hatchback: { tier: 'LARGE', r: 1.4, h: 1.6, len: 4.0, cap: 130, label: 'Hatchback',
    paints: plain([P.CAR_LIME, P.CAR_TEAL, P.CAR_YELLOW, P.CAR_WHITE]) },
  pickup: { tier: 'LARGE', r: 1.8, h: 1.9, len: 5.5, cap: 95, label: 'Pickup',
    paints: plain([P.CAR_CORAL, P.CAR_GRAPHITE, P.CAR_WHITE]) },
  sports: { tier: 'LARGE', r: 1.5, h: 1.25, len: 4.5, cap: 75, label: 'Sports Car',
    paints: plain([P.CAR_RED, P.CAR_PINK, P.CAR_MINT]) },
  convertible: { tier: 'LARGE', r: 1.5, h: 1.35, len: 4.4, cap: 60, label: 'Convertible',
    paints: plain([P.CAR_PURPLE, P.CAR_WHITE]) },
  taxi: { tier: 'LARGE', r: 1.6, h: 1.7, len: 4.7, cap: 170, label: 'Taxi',
    paints: [{ paint: P.TAXI_YELLOW, accent: 0x24262b, paintLo: darken(P.TAXI_YELLOW, 0.72) }] },
  police: { tier: 'LARGE', r: 1.7, h: 1.9, len: 4.9, cap: 50, label: 'Police Car',
    paints: [{ paint: P.CAR_WHITE, blue: P.POLICE_BLUE, red: P.CAR_RED }] },
  deliveryVan: { tier: 'LARGE', r: 2.0, h: 2.6, len: 6.0, cap: 110, label: 'Delivery Van',
    paints: [
      { paint: P.TRUCK_WHITE, accent: P.NEON_PINK }, { paint: P.CAR_TEAL, accent: P.FABRIC_WHITE },
      { paint: P.BRICK, accent: P.STUCCO_CREAM }, { paint: P.BUS_BLUE, accent: P.FABRIC_WHITE }] },
  boxTruck: { tier: 'XLARGE', r: 2.5, h: 3.3, len: 8.6, cap: 60, label: 'Box Truck',
    paints: [
      { paint: P.CAR_BLUE, white: P.TRUCK_WHITE, accent: P.FABRIC_SKY },
      { paint: P.CAR_GRAPHITE, white: P.TRUCK_WHITE, accent: P.FABRIC_CORAL }] },
  flatbed: { tier: 'XLARGE', r: 2.4, h: 2.8, len: 8.4, cap: 40, label: 'Flatbed Truck',
    paints: [{ paint: P.CAR_NAVY }, { paint: P.TRUCK_WHITE }] },
  garbageTruck: { tier: 'XLARGE', r: 2.6, h: 3.3, len: 9.0, cap: 24, label: 'Garbage Truck',
    paints: [{ paint: P.BIN_GREEN, paintLo: darken(P.BIN_GREEN, 0.7) }] },
  cementMixer: { tier: 'XLARGE', r: 2.6, h: 3.6, len: 8.8, cap: 34, label: 'Cement Mixer',
    paints: [{ paint: P.CAR_ORANGE, paintLo: darken(P.CAR_ORANGE, 0.7) }] },
  cityBus: { tier: 'XLARGE', r: 3.2, h: 3.4, len: 11.8, cap: 70, label: 'City Bus',
    paints: [
      { paint: P.BUS_WHITE, accent: P.BUS_BLUE, roof: P.BUS_WHITE },
      { paint: P.BUS_BLUE, accent: P.FABRIC_SUN, roof: P.BUS_WHITE },
      { paint: P.CAR_GREEN, accent: P.FABRIC_WHITE, roof: P.BUS_WHITE }] },
  articBus: { tier: 'XLARGE', r: 4.4, h: 3.4, len: 18.2, cap: 16, label: 'Articulated Bus',
    paints: [{ paint: P.BUS_WHITE, accent: P.NEON_AQUA, roof: P.BUS_WHITE }] },
  shuttleBus: { tier: 'XLARGE', r: 2.2, h: 2.9, len: 7.3, cap: 30, label: 'Airport Shuttle',
    paints: [{ paint: P.BUS_WHITE, accent: P.FABRIC_SKY, roof: P.BUS_WHITE }] },
  ambulance: { tier: 'XLARGE', r: 2.1, h: 2.9, len: 6.4, cap: 20, label: 'Ambulance',
    paints: [{ paint: P.TRUCK_WHITE, white: P.TRUCK_WHITE, red: P.CAR_RED }] },
  scooter: { tier: 'MEDIUM', r: 0.6, h: 1.1, len: 1.9, cap: 110, label: 'Scooter',
    paints: plain([P.CAR_TEAL, P.CAR_PINK]) },
  bicycle: { tier: 'MEDIUM', r: 0.55, h: 1.05, len: 1.8, cap: 150, label: 'Bicycle',
    paints: plain([P.ACCENT_AQUA, P.CAR_CORAL]) },

  /* --- boats: y = 0 is the waterline ---------------------------------- */
  motorYacht: { tier: 'XLARGE', r: 3.4, h: 5.2, len: 13.4, cap: 40, label: 'Motor Yacht',
    paints: [
      { hull: P.HULL_WHITE, accent: P.HULL_NAVY, white: P.HULL_WHITE },
      { hull: P.HULL_WHITE, accent: P.HULL_TEAL, white: P.HULL_WHITE },
      { hull: P.HULL_NAVY, accent: P.FABRIC_SUN, white: P.HULL_WHITE }] },
  sailBoat: { tier: 'XLARGE', r: 2.4, h: 12.0, len: 10.0, cap: 40, label: 'Sailing Boat',
    paints: [
      { hull: P.HULL_WHITE, accent: P.HULL_NAVY, white: P.HULL_WHITE },
      { hull: P.HULL_TEAL, accent: P.FABRIC_WHITE, white: P.HULL_WHITE }] },
  waterTaxi: { tier: 'XLARGE', r: 2.1, h: 3.0, len: 7.8, cap: 24, label: 'Water Taxi',
    paints: [{ hull: P.HULL_WHITE, accent: P.NEON_AQUA, white: P.HULL_WHITE }] },
  skiff: { tier: 'LARGE', r: 1.3, h: 1.6, len: 5.0, cap: 40, label: 'Skiff',
    paints: [{ hull: P.HULL_WHITE, deck: P.WOOD_DECK }, { hull: P.HULL_TEAL, deck: P.WOOD_DECK }] },
  sportFisher: { tier: 'XLARGE', r: 3.0, h: 6.2, len: 11.9, cap: 16, label: 'Sportfisher',
    paints: [{ hull: P.HULL_WHITE, accent: P.HULL_NAVY, white: P.HULL_WHITE }] },
  cruiseShip: { tier: 'HUGE', r: 9.0, h: 24.0, len: 45.5, cap: 3, label: 'Cruise Ship',
    paints: [{ hull: P.HULL_WHITE, accent: P.NEON_PINK, white: P.HULL_WHITE, blue: P.HULL_NAVY }] },

  /* --- site machinery -------------------------------------------------- */
  excavator: { tier: 'XLARGE', r: 2.4, h: 4.2, len: 8.0, cap: 30, label: 'Excavator',
    paints: [{ paint: P.CRANE_YELLOW, paintLo: darken(P.CRANE_YELLOW, 0.66) }] },
  wheelLoader: { tier: 'XLARGE', r: 2.0, h: 3.3, len: 7.4, cap: 24, label: 'Wheel Loader',
    paints: [{ paint: P.CRANE_YELLOW, paintLo: darken(P.CRANE_YELLOW, 0.66) }] },
  siteDumper: { tier: 'XLARGE', r: 2.4, h: 3.4, len: 8.4, cap: 24, label: 'Site Dumper',
    paints: [{ paint: P.CAR_ORANGE, paintLo: darken(P.CAR_ORANGE, 0.7) }] },
  craneBase: { tier: 'XLARGE', r: 4.2, h: 17.5, len: 7.4, cap: 10, label: 'Tower Crane Base',
    paints: [{ paint: P.CRANE_YELLOW, paintLo: darken(P.CRANE_YELLOW, 0.66) }] },
  scissorLift: { tier: 'LARGE', r: 1.2, h: 3.9, len: 2.8, cap: 24, label: 'Scissor Lift',
    paints: [{ paint: P.CRANE_YELLOW, paintLo: darken(P.CRANE_YELLOW, 0.66) }] },
  roadRoller: { tier: 'LARGE', r: 1.4, h: 2.9, len: 4.4, cap: 16, label: 'Road Roller',
    paints: [{ paint: P.CAR_YELLOW, paintLo: darken(P.CAR_YELLOW, 0.7) }] },
};

/* ================================================== spawn / pooling ==== */

/**
 * Instantiate one vehicle. Pool key is (shape, paint) so the whole fleet of a
 * given colour is a single InstancedMesh; `hex` is deliberately NOT passed, so
 * the pool never allocates an instanceColor and the fall-proxy inherits the
 * baked colours exactly.
 */
function spawn(ctx, state, type, vi, x, y, z, rotY, dynamic) {
  const def = FLEET[type];
  const spec = def.paints[vi % def.paints.length];
  const key = `veh:${type}:${vi}`;
  const c = ctx.addInstanced(key, () => ({
    geometry: variantGeometry(type, spec),
    material: vehicleMaterial(),
  }), {
    position: new THREE.Vector3(x, y, z),
    rotationY: rotY,
    tier: TIER[def.tier],
    radius: def.r,
    height: def.h,
    label: def.label,
    kind: type,
    capacity: def.cap,
    dynamic,
    castShadow: true,
    receiveShadow: true,
    debrisColor: spec.paint ?? spec.hull ?? 0xffffff,
  });
  if (c) {
    state.pools.add(c.pool);
    state.counts[type] = (state.counts[type] || 0) + 1;
    state.total++;
  }
  return c;
}

/* ======================================================= traffic sim === */

/** IDM parameters. Tuned for readable stop-and-go rather than realism. */
const IDM_A = 2.6;        // comfortable acceleration, m/s^2
const IDM_B = 3.4;        // comfortable deceleration
const IDM_T = 1.25;       // desired time headway, s
const IDM_S0 = 2.4;       // standstill gap, m
const BRAKE_MAX = 9.0;

/**
 * Extra setback on top of RoadNetwork's `stopX`/`stopZ`.
 *
 * The network puts its stop line 2.6 m out from the junction box, but
 * streets.js paints the zebra from 1.1 m to 4.7 m out and the stop bar at
 * ~6.1 m. Braking to the network's line parks a queue on top of the crossing,
 * which looks broken and stands the cars where the pedestrians are.
 */
const STOP_SETBACK = 4.0;

/** Bridge decks sit 1.2 m proud of the carriageway; ramp on over 7 m. */
function deckHeight(bridges, x, z) {
  let y = 0;
  for (let i = 0; i < bridges.length; i++) {
    const b = bridges[i];
    const kx = (b.width * 0.5 + 7 - Math.abs(x - b.x)) / 7;
    if (kx <= 0) continue;
    const kz = (b.length * 0.5 + 7 - Math.abs(z - b.z)) / 7;
    if (kz <= 0) continue;
    const k = Math.min(1, kx) * Math.min(1, kz);
    if (k > 0) y = Math.max(y, 1.2 * k);
  }
  return y;
}

class Traffic {
  constructor(ctx, net, rng) {
    this.ctx = ctx;
    this.net = net;
    this.rng = rng;
    this.layout = ctx.layout;
    this.registry = ctx.registry;
    this.time = 0;
    /** @type {LaneInfo[]} */
    this.lanes = [];
    this.byLaneId = new Map();
    this.pending = [];
    this.vehicles = [];
    /** Segment starts that sit on the map boundary — the only safe respawns. */
    this.entries = [];
    this._p = { x: 0, z: 0 };
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this._buildLanes();
  }

  /**
   * Split each lane into the stretches that are actually driveable. A road
   * that crosses the river without a bridge simply stops being a road there,
   * which is why the map does not have cars swimming to Brickell.
   */
  _buildLanes() {
    const { layout } = this;
    const S = WORLD.SIZE;
    for (const lane of this.net.lanes) {
      const a = lane.axis === 'x' ? -S + 8 : -S + 8;
      const b = lane.axis === 'x' ? S - 8 : WORLD.BAY_EDGE - 10;
      const s0 = Math.min(a * lane.dir, b * lane.dir);
      const s1 = Math.max(a * lane.dir, b * lane.dir);
      const segs = [];
      let run = null;
      const step = 3;
      for (let s = s0; s <= s1; s += step) {
        const p = this.net.sampleLane(lane, s, this._p);
        const ok = !layout.isWater(p.x, p.z);
        if (ok) { if (!run) run = { lo: s, hi: s }; else run.hi = s; }
        else if (run) { if (run.hi - run.lo > 50) segs.push(run); run = null; }
      }
      if (run && run.hi - run.lo > 50) segs.push(run);
      if (!segs.length) continue;
      // A segment that stops short of the lane's limit ends at water, not at
      // the map edge. Cars must never wrap there — that is a visible pop in
      // the middle of the city; they turn off at the last junction instead.
      for (const sg of segs) {
        sg.edgeLo = sg.lo <= s0 + 8;
        sg.edgeHi = sg.hi >= s1 - 8;
      }
      const info = { lane, segs, list: [], opposing: null, sMin: s0, sMax: s1 };
      this.lanes.push(info);
      this.byLaneId.set(lane.id, info);
      for (let i = 0; i < segs.length; i++) {
        if (segs[i].edgeLo) this.entries.push({ info, si: i });
      }
    }
    // Oncoming lanes, cached for the left-turn yield test.
    for (const info of this.lanes) {
      info.opposing = this.lanes.filter((o) =>
        o.lane.axis === info.lane.axis
        && o.lane.roadIndex === info.lane.roadIndex
        && o.lane.dir !== info.lane.dir);
    }
  }

  /** Sorted insert — lists are short, so a linear scan beats a binary search. */
  _insert(info, v) {
    const L = info.list;
    let i = L.length;
    while (i > 0 && L[i - 1].s > v.s) i--;
    L.splice(i, 0, v);
    v.info = info;
  }

  _remove(info, v) {
    const i = info.list.indexOf(v);
    if (i >= 0) info.list.splice(i, 1);
  }

  add(v, info) {
    this.vehicles.push(v);
    this._insert(info, v);
  }

  /** Is there room at `s` on this lane for a vehicle of length `len`? */
  hasRoom(info, s, len) {
    const L = info.list;
    for (let i = 0; i < L.length; i++) {
      if (Math.abs(L[i].s - s) < (L[i].len + len) * 0.5 + 4) return false;
      if (L[i].s > s + 40) break;
    }
    return true;
  }

  step(dt, time) {
    this.time = time;
    const net = this.net;
    this.pending.length = 0;

    for (let li = 0; li < this.lanes.length; li++) {
      const info = this.lanes[li];
      const L = info.list;
      const lane = info.lane;
      for (let i = L.length - 1; i >= 0; i--) {
        const v = L[i];
        const c = v.c;
        // Swallowed mid-drive: drop out of the queue without stalling it.
        if (!c || c.state >= 2) { L.splice(i, 1); v.dead = true; continue; }
        // Losing support: the consume system owns its transform now, so it is
        // no longer a car in a queue. Leave it in the lane list (it may regain
        // support if the hole moves on) but stop driving it.
        if (c.state >= 1) continue;

        let acc = IDM_A * (1 - Math.pow(v.v / v.v0, 4));

        // --- car following ------------------------------------------------
        const lead = L[i + 1];
        if (lead && !lead.dead) {
          const gap = (lead.s - lead.len * 0.5) - (v.s + v.len * 0.5);
          acc = Math.min(acc, this._interact(v, gap, lead.v));
        }

        // --- signals + turn decision ---------------------------------------
        const j = net.nextJunction(lane, v.s);
        if (j) {
          const stopOff = (lane.axis === 'x' ? j.ix.stopX : j.ix.stopZ)
            + (j.ix.signalled ? STOP_SETBACK : STOP_SETBACK * 0.5);
          const dStop = (j.s - stopOff) - (v.s + v.len * 0.5);
          // Decide ONCE per junction. Re-rolling every frame would turn every
          // car in the city eventually, whatever the probability says.
          if (v.decided !== j.ix.id && dStop < 45) {
            v.decided = j.ix.id;
            if (!v.turn) {
              const seg = info.segs[v.seg];
              const nxt = net.nextJunction(lane, j.s + 1);
              const dead = seg && !seg.edgeHi
                && (!nxt || nxt.s > seg.hi - 14);
              v.turn = this._decideTurn(v, lane, j.ix, dead);
              v.waitT = 0;
            }
          }

          if (dStop > -1.2 && dStop < 70) {
            const st = net.lightFor(j.ix, lane.axis, time);
            let mustStop = st === 'red';
            // Amber: stop only if you actually can. Slamming on at 15 m/s for
            // a light that just changed reads as a bug, not as caution.
            if (st === 'amber') mustStop = dStop > v.v * 1.1;
            if (!mustStop && v.turn && !v.turn.done && v.turn.left) {
              if (this._oncoming(v, lane, j.ix)) { mustStop = true; v.waitT += dt; }
              // Give up rather than deadlock the whole approach.
              if (v.waitT > 7) { v.turn = null; mustStop = false; }
            }
            if (mustStop) acc = Math.min(acc, this._interact(v, Math.max(0.05, dStop), 0));
          }
        }

        acc = Math.max(-BRAKE_MAX, Math.min(IDM_A, acc));
        v.v = Math.max(0, v.v + acc * dt);
        v.s += v.v * dt;

        // --- execute the turn ------------------------------------------------
        const T = v.turn;
        // Re-check the target slot just BEFORE the arc starts. The decision was
        // taken up to 45 m back and the gap may have closed since; abandoning
        // here costs nothing visually, abandoning mid-arc would snap the car.
        if (T && !T.done && !T.checked && v.s >= T.sSrc - T.arc - 2) {
          T.checked = true;
          if (!this.hasRoom(T.dstInfo, T.sDst, v.len + 6)) { v.turn = null; continue; }
        }
        if (T && !T.done && v.s >= T.sSrc) {
          T.done = true;
          this.pending.push({ v, from: info, to: T.dstInfo, s: T.sDst + (v.s - T.sSrc) });
          continue;
        }

        // --- leaving the map: reappear at a boundary, never mid-city ---------
        const seg = info.segs[v.seg];
        if (seg && v.s > seg.hi - v.len * 0.5) {
          const e = this._freeEntry(v);
          if (e) {
            this.pending.push({
              v, from: info, to: e.info, si: e.si,
              s: e.info.segs[e.si].lo + v.len * 0.5 + 2, reset: true,
            });
          } else {
            v.s = seg.hi - v.len * 0.5;
            v.v = 0;
          }
        }
      }
    }

    // Lane changes are applied after the sweep so no list mutates mid-iteration.
    for (const ev of this.pending) {
      this._remove(ev.from, ev.v);
      ev.v.s = ev.s;
      if (ev.to !== ev.from) {
        ev.v.lane = ev.to.lane;
        // Adopt the new road's limit outright — taking the min would ratchet a
        // car that turns twice down to a crawl it never recovers from.
        ev.v.v0 = ev.to.lane.speed * ev.v.vf;
        ev.v.seg = ev.si !== undefined ? ev.si : this._segAt(ev.to, ev.s);
      } else if (ev.si !== undefined) {
        ev.v.seg = ev.si;
      }
      if (ev.reset) { ev.v.turn = null; ev.v.decided = -1; }
      this._insert(ev.to, ev.v);
    }
  }

  /** A map-edge segment start with room for this vehicle, or null. */
  _freeEntry(v) {
    const n = this.entries.length;
    if (!n) return null;
    for (let k = 0; k < 8; k++) {
      const e = this.entries[Math.floor(this.rng() * n)];
      const sg = e.info.segs[e.si];
      if (sg.hi - sg.lo < v.len + 30) continue;
      if (this.hasRoom(e.info, sg.lo + v.len * 0.5 + 2, v.len)) return e;
    }
    return null;
  }

  /** IDM interaction term against a leader `gap` metres ahead at speed `lv`. */
  _interact(v, gap, lv) {
    const g = Math.max(0.35, gap);
    const dv = v.v - lv;
    const sStar = IDM_S0 + Math.max(0, v.v * IDM_T + (v.v * dv) / (2 * Math.sqrt(IDM_A * IDM_B)));
    return IDM_A * (1 - Math.pow(v.v / v.v0, 4) - (sStar / g) * (sStar / g));
  }

  _segAt(info, s) {
    for (let i = 0; i < info.segs.length; i++) {
      if (s >= info.segs[i].lo - 4 && s <= info.segs[i].hi + 4) return i;
    }
    return 0;
  }

  /**
   * Choose a turn at `ix`, or null to go straight. Returns the Bezier corner so
   * the vehicle sweeps the junction instead of snapping through a right angle.
   */
  _decideTurn(v, lane, ix, forced) {
    if (v.noTurn && !forced) return null;
    const r = this.rng;
    let wantRight = r() < (lane.kerbLane ? 0.30 : 0.06);
    let wantLeft = !wantRight && r() < (lane.kerbLane ? 0.10 : 0.22);
    // At the last junction before a dead end this is not a preference.
    if (forced && !wantRight && !wantLeft) { wantRight = true; wantLeft = false; }
    if (!wantRight && !wantLeft) return null;
    // Travelling +z, right is -x; travelling +x, right is +z. See roadNetwork.
    const rightDir = lane.axis === 'x' ? -lane.dir : lane.dir;
    const wantDir = wantRight ? rightDir : -rightDir;
    const opts = this.net.turnOptions(lane, ix);
    let dst = null;
    for (const l of opts) if (l.dir === wantDir) { dst = l; break; }
    if (!dst && forced) for (const l of opts) if (l.dir === -wantDir) { dst = l; wantLeft = !wantLeft; break; }
    if (!dst) return null;
    const dstInfo = this.byLaneId.get(dst.id);
    if (!dstInfo) return null;

    const cx = lane.axis === 'x' ? lane.cross : dst.cross;
    const cz = lane.axis === 'x' ? dst.cross : lane.cross;
    const sSrc = this.net.sFor(lane, cx, cz);
    const sDst = this.net.sFor(dst, cx, cz);
    if (sSrc <= v.s + 3) return null;
    const seg = dstInfo.segs[this._segAt(dstInfo, sDst)];
    if (!seg || sDst < seg.lo || sDst > seg.hi - 20) return null;
    if (!this.hasRoom(dstInfo, sDst + 6, v.len)) return null;

    const arc = wantRight ? 6.5 : 11.0;
    const a = this.net.sampleLane(lane, sSrc - arc, {});
    const b = this.net.sampleLane(dst, sDst + arc, {});
    return {
      dstInfo, sSrc, sDst, arc, left: wantLeft,
      p0x: a.x, p0z: a.z, p1x: cx, p1z: cz, p2x: b.x, p2z: b.z,
    };
  }

  /** True if crossing now would cut up oncoming traffic. */
  _oncoming(v, lane, ix) {
    const self = this.byLaneId.get(lane.id);
    if (!self) return false;
    for (const o of self.opposing) {
      const sJ = this.net.sFor(o.lane, ix.x, ix.z);
      const L = o.list;
      for (let i = 0; i < L.length; i++) {
        const d = sJ - L[i].s;
        if (d > 0 && d < 30 && L[i].v > 1.5) return true;
      }
    }
    return false;
  }

  /** Resolve (lane, s) plus any active turn into a world transform. */
  place(v, out) {
    const t = v.turn;
    if (t) {
      // Two halves of one Bezier: the approach is still measured on the source
      // lane, the exit on the destination lane, and they meet at k = 0.5 where
      // the two lane centrelines cross.
      const k = t.done
        ? 0.5 + 0.5 * ((v.s - t.sDst) / t.arc)
        : 0.5 * (1 - (t.sSrc - v.s) / t.arc);
      if (k >= 1) {
        v.turn = null;
      } else if (k > 0) {
        const m = 1 - k;
        out.x = m * m * t.p0x + 2 * m * k * t.p1x + k * k * t.p2x;
        out.z = m * m * t.p0z + 2 * m * k * t.p1z + k * k * t.p2z;
        const dx = 2 * m * (t.p1x - t.p0x) + 2 * k * (t.p2x - t.p1x);
        const dz = 2 * m * (t.p1z - t.p0z) + 2 * k * (t.p2z - t.p1z);
        out.rot = Math.atan2(dx, dz);
        return out;
      }
    }
    this.net.sampleLane(v.lane, v.s, out);
    out.rot = this.net.headingOf(v.lane);
    return out;
  }
}

/* ======================================================== placement ==== */

/**
 * MUST mirror `lanePlan` in streets.js — that module paints a kerbside bay
 * line plus a tick every 6.6 m explicitly so vehicles.js can park inside it.
 * If these two drift, every parked car in Miami straddles a white line.
 */
function lanePlan(r) {
  const inner = r.median ? r.medianW * 0.5 : 0;
  let lanes = r.cls === ROAD_CLASS.STREET ? 2
    : (r.cls === ROAD_CLASS.BOULEVARD && r.median ? 3 : 4);
  let bus = r.cls === ROAD_CLASS.BOULEVARD;
  let park = r.half - inner - lanes * LANE_W - (bus ? LANE_W : 0) - 0.4;
  if (park < 1.9 && bus) { bus = false; park += LANE_W; }
  while (park < 1.9 && lanes > 1) { lanes--; park += LANE_W; }
  return { inner, lanes, bus, park };
}

const ROAD_MIX = [
  ['sedan', 24], ['suv', 15], ['hatchback', 11], ['taxi', 10], ['pickup', 7],
  ['deliveryVan', 7], ['sports', 4], ['convertible', 3], ['cityBus', 3.4],
  ['boxTruck', 3], ['shuttleBus', 1.6], ['flatbed', 1.2], ['police', 1.2],
  ['scooter', 3], ['garbageTruck', 0.8], ['cementMixer', 0.8],
  ['ambulance', 0.6], ['articBus', 0.7],
];
const KERB_MIX = [
  ['sedan', 30], ['suv', 19], ['hatchback', 14], ['taxi', 6], ['pickup', 9],
  ['deliveryVan', 7], ['sports', 4], ['convertible', 3], ['boxTruck', 2],
  ['scooter', 4], ['police', 0.8], ['flatbed', 0.8],
];
const LOT_MIX = [
  ['sedan', 32], ['suv', 22], ['hatchback', 16], ['pickup', 10],
  ['deliveryVan', 7], ['sports', 5], ['convertible', 4], ['taxi', 4],
];

const BIG = new Set(['cityBus', 'articBus', 'boxTruck', 'garbageTruck',
  'cementMixer', 'flatbed', 'ambulance', 'shuttleBus']);

function pickVariant(rng, type) {
  return rng.int(0, FLEET[type].paints.length - 1);
}

/** Fill every driveable lane stretch with moving traffic. */
function placeMoving(ctx, state, traf, rng) {
  const bridges = ctx.layout.bridges;
  for (const info of traf.lanes) {
    const lane = info.lane;
    const cls = lane.road.cls;
    const spacing = cls === ROAD_CLASS.BOULEVARD ? 46
      : cls === ROAD_CLASS.AVENUE ? 58 : 74;
    for (let si = 0; si < info.segs.length; si++) {
      const seg = info.segs[si];
      const n = Math.floor((seg.hi - seg.lo) / spacing);
      for (let i = 0; i < n; i++) {
        const s = seg.lo + 12 + ((i + rng() * 0.7) / n) * (seg.hi - seg.lo - 24);
        let type = rng.weighted(ROAD_MIX);
        // Heavy vehicles keep to the kerb lane, like they are supposed to.
        if (!lane.kerbLane && BIG.has(type)) type = 'sedan';
        const def = FLEET[type];
        if (!traf.hasRoom(info, s, def.len)) continue;
        const p = traf.net.sampleLane(lane, s, {});
        const y = deckHeight(bridges, p.x, p.z) + 0.015;
        const vi = pickVariant(rng, type);
        const c = spawn(ctx, state, type, vi, p.x, y, p.z, traf.net.headingOf(lane), true);
        if (!c) continue;
        const vf = (BIG.has(type) ? 0.78 : 0.92) + rng() * 0.22;
        traf.add({
          c, lane, s, seg: si, len: def.len, dead: false,
          v: lane.speed * vf * 0.75, v0: lane.speed * vf, vf,
          turn: null, decided: -1, waitT: 0,
          noTurn: type === 'articBus',
        }, info);
      }
    }
  }
}

/** Kerbside parking, aligned to the bay ticks streets.js paints. */
function placeParked(ctx, state, rng) {
  const { layout } = ctx;
  const S = WORLD.SIZE;
  const bridges = layout.bridges;
  for (const r of [...layout.roadsX, ...layout.roadsZ]) {
    const pp = lanePlan(r);
    if (pp.park < 2.1) continue;
    const off = r.half - pp.park * 0.5;
    const alongX = r.axis === 'z';
    const lo = -S + 24;
    const hi = alongX ? WORLD.BAY_EDGE - 26 : S - 24;
    const cross = alongX ? layout.roadsX : layout.roadsZ;
    for (let t = Math.ceil(lo / 6.6) * 6.6 + 3.3; t < hi; t += 6.6) {
      let atJunction = false;
      for (const cr of cross) {
        if (Math.abs(t - cr.pos) < cr.half + 9) { atJunction = true; break; }
      }
      if (atJunction) continue;
      for (const s of [-1, 1]) {
        const x = alongX ? t : r.pos + s * off;
        const z = alongX ? r.pos + s * off : t;
        if (layout.isWater(x, z)) continue;
        if (deckHeight(bridges, x, z) > 0.01) continue;
        // Runs and gaps, not confetti: a slow term along the road gives blocks
        // of solid parking broken by driveways and hydrant clearances, which
        // is what a real kerb looks like. Uniform noise reads as a fence.
        const run = 0.5 + 0.5 * Math.sin(t * 0.020 + r.pos * 0.31 + s * 1.7);
        if (!rng.chance(0.16 + 0.52 * run)) continue;
        const type = rng.weighted(KERB_MIX);
        const def = FLEET[type];
        if (def.len > 6.4 && !rng.chance(0.4)) continue;
        const rot = alongX
          ? (s > 0 ? Math.PI / 2 : -Math.PI / 2)
          : (s > 0 ? Math.PI : 0);
        spawn(ctx, state, type, pickVariant(rng, type), x, 0.015, z,
          rot + (rng() - 0.5) * 0.035, false);
      }
    }
  }
}

/**
 * Angle parking on parcels nobody else claimed. These are exactly the bare
 * slabs the review flagged, so anything that lands here is a win — but the
 * occupancy test keeps us off other modules' geometry.
 */
function placeLots(ctx, state, rng) {
  let lots = 0;
  for (const b of ctx.layout.blocks) {
    if (lots > 20) break;
    if (b.zone === ZONE.PARK || b.zone === ZONE.MARINA) continue;
    if (Math.min(b.w, b.d) < 24) continue;
    const rad = Math.min(b.w, b.d) * 0.26;
    if (!ctx.isFree(b.x, b.z, rad)) continue;
    lots++;
    const alongX = b.w >= b.d;
    const rows = Math.min(2, Math.max(1, Math.floor((alongX ? b.d : b.w) / 17)));
    const nbay = Math.min(13, Math.floor(((alongX ? b.w : b.d) - 10) / 3.1));
    const ang = 1.05;   // ~60 degrees to the aisle
    for (let ri = 0; ri < rows; ri++) {
      const rowOff = (ri - (rows - 1) / 2) * 16.5;
      for (let k = 0; k < nbay; k++) {
        const along = (k - (nbay - 1) / 2) * 3.1;
        const x = b.x + (alongX ? along : rowOff);
        const z = b.z + (alongX ? rowOff : along);
        if (!ctx.isFree(x, z, 2.2)) continue;
        if (!rng.chance(0.46)) continue;
        const type = rng.weighted(LOT_MIX);
        const rot = (alongX ? 0 : Math.PI / 2) + ang * (ri % 2 ? 1 : -1);
        spawn(ctx, state, type, pickVariant(rng, type), x, ctx.Y_WALK + 0.01, z, rot, false);
        ctx.occupy(x, z, 1.8);
      }
    }
  }
  return lots;
}

/**
 * Waterline. Must match WATER_Y in water.js — that module keeps its surface
 * geometrically flat and does all the swell per-pixel, so a hull that bobbed
 * on a replicated wave function would drift off a plane that never moves.
 */
const BOAT_Y = 0.12;

/** Marina basins, the river and the bay edge. */
function placeBoats(ctx, state, rng) {
  const { layout } = ctx;
  const boats = [];
  const put = (type, x, z, rot, moving) => {
    const c = spawn(ctx, state, type, pickVariant(rng, type), x, BOAT_Y, z, rot, !!moving);
    if (c) boats.push({ c, x, z, rot, phase: rng() * 6.28 });
    return c;
  };

  // Basins. water.js lays a walkway 6 m off the landward edge with 1.5 m
  // finger docks every ~9 m; boats moor ALONGSIDE the fingers, bow toward the
  // walkway. Slots that would land on a finger are skipped rather than
  // snapped, so nothing ends up parked on the decking.
  for (const bs of layout.basins) {
    const xA = bs.x0 + 6;
    const zA = bs.z0 + 5, zB = bs.z1 - 5;
    if (zB - zA < 6) continue;
    const nF = Math.max(2, Math.floor((zB - zA) / 9));
    const fingers = [];
    for (let i = 0; i < nF; i++) fingers.push(zA + ((i + 0.5) / nF) * (zB - zA));
    for (let z = bs.z0 + 4; z < bs.z1 - 4; z += 6.2) {
      let onFinger = false;
      for (const fz of fingers) if (Math.abs(z - fz) < 1.9) { onFinger = true; break; }
      if (onFinger) continue;
      if (!rng.chance(0.86)) continue;
      const type = rng.weighted([['motorYacht', 24], ['sailBoat', 26],
        ['skiff', 28], ['sportFisher', 10], ['waterTaxi', 12]]);
      const half = FLEET[type].len * 0.5;
      const x = xA + 3.2 + half;
      if (x + half > bs.x1 - 3) continue;
      put(type, x, z, -Math.PI / 2, true);   // bow toward the walkway
    }
    // A couple of bigger hulls lying along the outer wall of the basin.
    for (let z = bs.z0 + 8; z < bs.z1 - 8; z += 15) {
      if (!rng.chance(0.5)) continue;
      const type = rng.weighted([['motorYacht', 40], ['sportFisher', 34], ['waterTaxi', 26]]);
      put(type, bs.x1 - 7, z, 0, true);
    }
  }

  // Bay: two bands. An inshore line of moored hulls off the seawall, then
  // traffic further out so the water has depth instead of one row of boats.
  for (const band of [{ x0: 12, x1: 40, step: 26, p: 0.82 },
    { x0: 58, x1: 128, step: 46, p: 0.66 }]) {
    for (let z = -WORLD.SIZE + 60; z < WORLD.SIZE - 60; z += band.step) {
      if (Math.abs(z) < 52) continue;                     // keep the river mouth clear
      if (!rng.chance(band.p)) continue;
      const x = WORLD.BAY_EDGE + band.x0 + rng() * (band.x1 - band.x0);
      const type = rng.weighted([['motorYacht', 30], ['sailBoat', 30],
        ['sportFisher', 14], ['waterTaxi', 14], ['skiff', 12]]);
      put(type, x, z + (rng() - 0.5) * 12, rng() * 6.28, true);
    }
  }

  // The cuts around Brickell Key: sheltered water, so small craft.
  for (const ch of layout.channels || []) {
    const w = ch.x1 - ch.x0, d = ch.z1 - ch.z0;
    if (Math.min(w, d) < 12) continue;
    const n = Math.max(1, Math.floor(Math.max(w, d) / 26));
    for (let i = 0; i < n; i++) {
      if (!rng.chance(0.6)) continue;
      const t = (i + 0.5) / n;
      const x = w > d ? ch.x0 + t * w : (ch.x0 + ch.x1) / 2;
      const z = w > d ? (ch.z0 + ch.z1) / 2 : ch.z0 + t * d;
      put(rng.weighted([['skiff', 44], ['waterTaxi', 32], ['sailBoat', 24]]),
        x, z, w > d ? Math.PI / 2 : 0);
    }
  }

  // River: working craft along both banks, nosed into the bulkheads.
  for (let x = -WORLD.SIZE + 120; x < WORLD.BAY_EDGE - 30; x += 22) {
    const cz = layout.river.centerAt(x);
    const hw = layout.river.halfAt(x);
    for (const s of [-1, 1]) {
      if (!rng.chance(0.62)) continue;
      const z = cz + s * (hw - 6.5);
      if (!layout.isWater(x, z)) continue;
      const type = rng.weighted([['waterTaxi', 30], ['skiff', 26],
        ['motorYacht', 22], ['sportFisher', 12], ['sailBoat', 10]]);
      put(type, x, z, Math.PI / 2 + (s > 0 ? 0.1 : -0.1));
    }
  }

  // Two cruise vessels at the port terminals north and south of the channel.
  put('cruiseShip', WORLD.BAY_EDGE + 17, -448, 0.02, true);
  put('cruiseShip', WORLD.BAY_EDGE + 19, 455, Math.PI - 0.02, true);
  return boats;
}

/** Plant machinery around the edge of every construction parcel. */
function placeMachinery(ctx, state, rng) {
  let cranes = 0;
  for (const b of ctx.layout.blocks) {
    if (b.zone !== ZONE.CONSTRUCTION) continue;
    const r = makeRNG(b.seed ^ 0x51a7);
    // buildings.js fills the middle; the perimeter strip is what is left.
    const hw = b.w * 0.42, hd = b.d * 0.42;
    const n = 3 + r.int(0, 3);
    // Machines are 3-8 m long, so a purely random perimeter position parks two
    // of them inside each other. Keep a local list and reject close pairs —
    // the shared occupancy grid is no help here, buildings.js has already
    // claimed the whole parcel for the tower core.
    const placed = [];
    for (let i = 0; i < n; i++) {
      let x = 0, z = 0, rot = 0, ok = false;
      for (let a = 0; a < 8 && !ok; a++) {
        const edge = r.int(0, 3);
        const u = (r() - 0.5) * 0.78;
        if (edge === 0) { x = b.x + u * b.w; z = b.z - hd; rot = 0; }
        else if (edge === 1) { x = b.x + u * b.w; z = b.z + hd; rot = Math.PI; }
        else if (edge === 2) { x = b.x - hw; z = b.z + u * b.d; rot = Math.PI / 2; }
        else { x = b.x + hw; z = b.z + u * b.d; rot = -Math.PI / 2; }
        ok = true;
        for (const q of placed) if (Math.hypot(q[0] - x, q[1] - z) < 9) { ok = false; break; }
      }
      if (!ok) continue;
      placed.push([x, z]);
      const type = r.weighted([['excavator', 26], ['wheelLoader', 20],
        ['siteDumper', 18], ['cementMixer', 12], ['scissorLift', 14],
        ['roadRoller', 10]]);
      spawn(ctx, state, type, 0, x, ctx.Y_WALK + 0.01, z, rot + (r() - 0.5) * 0.5, false);
      ctx.occupy(x, z, 2.4);
    }
    if (cranes < 7 && r.chance(0.6) && Math.min(b.w, b.d) > 34) {
      const x = b.x + (r() - 0.5) * b.w * 0.5;
      const z = b.z + (r() - 0.5) * b.d * 0.5;
      let clear = true;
      for (const q of placed) if (Math.hypot(q[0] - x, q[1] - z) < 11) { clear = false; break; }
      if (!clear) continue;
      spawn(ctx, state, 'craneBase', 0, x, ctx.Y_WALK + 0.01, z, r() * 1.5, false);
      ctx.occupy(x, z, 4.2);
      cranes++;
    }
  }
}

/** Bikes leaning at the kerb on lively blocks — cheap, and the street reads. */
function placeBikes(ctx, state, rng) {
  for (const b of ctx.layout.blocks) {
    if (b.streetLife < 0.55) continue;
    const r = makeRNG(b.seed ^ 0x2b19);
    const n = r.int(0, 2);
    for (let i = 0; i < n; i++) {
      const side = r.int(0, 3);
      const hw = b.w / 2 - 1.6, hd = b.d / 2 - 1.6;
      const u = (r() - 0.5) * 0.8;
      let x, z, rot;
      if (side === 0) { x = b.x + u * b.w; z = b.z - hd; rot = 0; }
      else if (side === 1) { x = b.x + u * b.w; z = b.z + hd; rot = Math.PI; }
      else if (side === 2) { x = b.x - hw; z = b.z + u * b.d; rot = Math.PI / 2; }
      else { x = b.x + hw; z = b.z + u * b.d; rot = -Math.PI / 2; }
      if (!ctx.isFree(x, z, 1.1)) continue;
      ctx.occupy(x, z, 1.0);
      spawn(ctx, state, 'bicycle', pickVariant(r, 'bicycle'), x, ctx.Y_WALK, z,
        rot + Math.PI / 2, false);
    }
  }
}

/* ============================================================ build ==== */

export function buildVehicles(ctx) {
  const rng = makeRNG(0x7c3a51);
  const net = ctx.roads || (ctx.roads = new RoadNetwork(ctx.layout));
  const state = { pools: new Set(), counts: {}, total: 0 };

  const traf = new Traffic(ctx, net, rng);
  placeMoving(ctx, state, traf, rng);
  const moving = traf.vehicles.length;

  placeParked(ctx, state, rng);
  const lots = placeLots(ctx, state, rng);
  placeBikes(ctx, state, rng);
  placeMachinery(ctx, state, rng);
  const boats = placeBoats(ctx, state, rng);

  const update = makeUpdater(ctx, traf, state, boats);
  ctx.scene.userData.trafficUpdate = update;
  // Deliberately NOT exposing the vehicle array on scene.userData: a vehicle
  // points at its lane list which points back at the vehicle, and the
  // screenshot harness serialises window.DEV — a cycle in there hangs it.
  ctx.scene.userData.trafficDebug = () => ({
    total: state.total,
    moving: traf.vehicles.reduce((n, v) => n + (v.dead ? 0 : 1), 0),
    parked: state.total - moving - boats.length,
    boats: boats.length,
    lanes: traf.lanes.length,
    lots,
    pools: state.pools.size,
    byType: state.counts,
  });

  console.info(
    `[vehicles] ${state.total} vehicles | ${moving} driving on ${traf.lanes.length} lanes | `
    + `${boats.length} boats | ${state.pools.size} pools`
  );
  return state;
}

/* =========================================================== update ==== */

function makeUpdater(ctx, traf, state, boats) {
  const registry = ctx.registry;
  const bridges = ctx.layout.bridges;
  const out = { x: 0, z: 0, rot: 0 };
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const pos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  let time = 0;
  let sweepAt = 0;

  return (dt) => {
    if (!(dt > 0)) return;
    if (dt > 0.2) dt = 0.2;      // a stalled tab must not teleport the fleet
    time += dt;

    traf.step(dt, time);

    const V = traf.vehicles;
    for (let i = 0; i < V.length; i++) {
      const v = V[i];
      if (v.dead) continue;
      const c = v.c;
      if (!c || c.state >= 2) { v.dead = true; continue; }
      // Wheels over the void: hand it to the physics rather than fighting it
      // for the matrix every frame, which is what stopped cars ever tilting.
      if (c.state >= 1) continue;
      traf.place(v, out);
      pos.set(out.x, deckHeight(bridges, out.x, out.z) + 0.015, out.z);
      e.set(0, out.rot, 0);
      q.setFromEuler(e);
      c.position.copy(pos);
      const p = c.pool;
      p.slotPos[c.slot].copy(pos);
      p.slotRot[c.slot].copy(q);
      p.setTransform(c.slot, pos, q, p.slotScale[c.slot]);
      registry.rehash(c);
    }

    // A slow heave and roll. Small on purpose: the water plane is flat, so a
    // big bob would lift a hull clear of a surface that never rises to meet it.
    for (let i = 0; i < boats.length; i++) {
      const b = boats[i];
      const c = b.c;
      if (!c || c.state >= 1) continue;
      const ph = time * 0.62 + b.phase;
      pos.set(b.x, BOAT_Y + Math.sin(ph) * 0.045, b.z);
      e.set(Math.sin(ph * 0.83 + 1.1) * 0.011, b.rot, Math.cos(ph * 0.71) * 0.017);
      q.setFromEuler(e);
      c.position.copy(pos);
      const p = c.pool;
      p.slotPos[c.slot].copy(pos);
      p.slotRot[c.slot].copy(q);
      p.setTransform(c.slot, pos, q, p.slotScale[c.slot]);
      registry.rehash(c);
    }

    // Nothing in the engine flushes instanced pools per frame, so do our own.
    // This is also what lets the consume system's wobble reach the GPU.
    for (const p of state.pools) p.flush();

    // Compact the dead out of the list occasionally rather than every frame.
    sweepAt += dt;
    if (sweepAt > 3) {
      sweepAt = 0;
      let w = 0;
      for (let i = 0; i < V.length; i++) if (!V[i].dead) V[w++] = V[i];
      V.length = w;
    }
  };
}
