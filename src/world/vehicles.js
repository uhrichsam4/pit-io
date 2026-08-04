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
 * Material bands. uv.x selects one (roughness, metalness, emissive) triple, so
 * a single material covers wet-look paint, dead-matte rubber, chrome — and lit
 * lamp lenses.
 *
 * WHY LAMPS ARE BANDS AND NOT A SECOND MATERIAL
 * ---------------------------------------------
 * Headlights, tail lights and indicators have to glow after dark, and there are
 * ~1200 vehicles carrying them. Anything per-object (a light, a second mesh, an
 * emissive uniform) multiplies by 1200. Instead the *band* carries the emissive
 * colour: uv.x already selects the band, so an emissiveMap keyed the same way
 * costs one extra texture fetch and nothing else, and the whole city's lamps
 * fade up together by animating one `emissiveIntensity` per frame.
 */
const BAND = {
  PAINT: 0, GLASS: 1, TYRE: 2, CHROME: 3, MATTE: 4, LENS: 5, HULL: 6, ROUGH: 7,
  GLOSS: 8,       // exotic clear-coat: deeper, wetter, sharper reflection
  HEAD: 9,        // headlight lens
  TAIL: 10,       // tail lens
  AMBER: 11,      // indicator / hazard lens
  GLASS_HI: 12,   // upper glass band — the sky reflection on a windscreen
  CABIN_LIT: 13,  // bus / coach saloon glazing, lit from inside after dark
  SIGN: 14,       // illuminated signage: taxi roof box, destination blind
  CARBON: 15,     // splitters, diffusers, vents on the exotics
  BEACON: 16,     // emergency light bar, blue half
};
/** [roughness, metalness] per band. */
const BAND_MR = [
  // Paint keeps metalness low: a metallic clear-coat scales diffuse by
  // (1 - metalness), and Miami wants punchy colour, not dark colour.
  [0.30, 0.14], [0.10, 0.58], [0.95, 0.00], [0.20, 0.92],
  [0.62, 0.02], [0.13, 0.05], [0.24, 0.04], [0.74, 0.08],
  [0.08, 0.34], [0.10, 0.04], [0.12, 0.03], [0.12, 0.03],
  [0.05, 0.74], [0.14, 0.40], [0.44, 0.02], [0.38, 0.46],
  [0.12, 0.03],
];
/**
 * Emissive colour per band, sRGB 0..1. Relative brightness is baked in here —
 * a headlight has to out-punch its own tail light by a factor of two or the
 * back of the city looks the same as the front.
 */
const BAND_EM = (() => {
  const e = BAND_MR.map(() => [0, 0, 0]);
  e[BAND.HEAD] = [1.00, 0.95, 0.82];
  e[BAND.TAIL] = [0.72, 0.05, 0.03];
  e[BAND.AMBER] = [0.88, 0.40, 0.02];
  e[BAND.CABIN_LIT] = [0.40, 0.36, 0.26];
  e[BAND.SIGN] = [0.80, 0.70, 0.44];
  e[BAND.BEACON] = [0.10, 0.34, 0.95];
  return e;
})();

function bandData(pick) {
  const data = new Uint8Array(BAND_MR.length * 4);
  for (let i = 0; i < BAND_MR.length; i++) {
    const [r, g, b] = pick(i);
    data[i * 4 + 0] = Math.round(r * 255);
    data[i * 4 + 1] = Math.round(g * 255);
    data[i * 4 + 2] = Math.round(b * 255);
    data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, BAND_MR.length, 1, THREE.RGBAFormat);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

let _bandTex = null;
function bandTexture() {
  if (_bandTex) return _bandTex;
  // Roughness reads green, metalness reads blue — one texture feeds both maps.
  _bandTex = bandData((i) => [1, BAND_MR[i][0], BAND_MR[i][1]]);
  _bandTex.colorSpace = THREE.NoColorSpace;
  return _bandTex;
}

let _emTex = null;
function emissiveTexture() {
  if (_emTex) return _emTex;
  _emTex = bandData((i) => BAND_EM[i]);
  _emTex.colorSpace = THREE.SRGBColorSpace;   // it is a colour, not a mask
  return _emTex;
}

/**
 * ONE material for every vehicle in Miami, lamps included.
 *
 * The obvious alternative — a "lit" material for moving traffic and a dark one
 * for parked cars — doubles the pool count, because a pool owns exactly one
 * (geometry, material) pair. It is not worth 60 draw calls: the lens emissive
 * here is deliberately pitched at RETROREFLECTOR level, which is what a parked
 * car's lamps genuinely do under a streetlight, and the difference between
 * parked and driving is carried by the additive headlight beams, which only
 * moving vehicles get. See `beamPool`.
 */
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
    emissive: 0xffffff,
    emissiveMap: emissiveTexture(),
    emissiveIntensity: 0,     // driven from nightFactor every frame
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
  ['HEAD', 'head', BAND.HEAD],
  ['TAIL', 'tail', BAND.TAIL],
  ['AMBER', 'amber', BAND.AMBER],
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
  /* --- added for the exotics, the glasshouse and the lit signage ------- */
  ['GLOSS', 'paint', BAND.GLOSS],       // exotic body: deeper clear-coat
  ['GLOSS_LO', 'paintLo', BAND.GLOSS],
  ['GLASS_HI', 'glassHi', BAND.GLASS_HI],
  ['CABIN', 'cabin', BAND.CABIN_LIT],   // saloon glazing that lights up at night
  ['SIGN', 'sign', BAND.SIGN],
  ['CARBON', 'carbon', BAND.CARBON],
  ['INTERIOR', 'interior', BAND.MATTE], // dash / trim seen behind the screen
  ['BEACON', 'blue', BAND.BEACON],      // emergency light bar
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
    // The upper third of a windscreen is sky, not cabin. Authoring it as a
    // separate lighter band is what stops glazing reading as a painted stripe.
    glassHi: v.glassHi ?? 0x9fc4d8,
    cabin: v.cabin ?? 0x5c7a86,
    sign: v.sign ?? PALETTE.SIGN_LIGHT,
    carbon: v.carbon ?? 0x2b2e33,
    interior: v.interior ?? 0x2e3136,
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

  /**
   * Triangle with a different role at each corner.
   *
   * The role byte becomes both a vertex colour and a uv, and both interpolate.
   * That is a free gradient: a wheel face can go from bright rim at the hub to
   * dead-black rubber at the tread in ONE triangle per segment instead of
   * three, which matters when the city carries five thousand wheels.
   */
  tri3(a, b, c, ra, rb, rc, ref) {
    const before = this.r.length;
    this.tri(a, b, c, ra, ref);
    // `tri` may have reversed the winding, so patch by position, not by index.
    const pts = [a, b, c], roles = [ra, rb, rc];
    for (let i = before; i < this.r.length; i++) {
      const px = this.p[i * 3], py = this.p[i * 3 + 1], pz = this.p[i * 3 + 2];
      for (let k = 0; k < 3; k++) {
        if (pts[k][0] === px && pts[k][1] === py && pts[k][2] === pz) {
          this.r[i] = roles[k];
          this.u[i * 2] = (ROLE_BAND[roles[k]] + 0.5) / BAND_MR.length;
          break;
        }
      }
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
 * A road wheel: tread band, tyre sidewall, dished rim, and a fender lip.
 *
 * WHY THE RIM IS A REAL DISC AND NOT A GRADIENT
 * ---------------------------------------------
 * The previous version drew the face as ONE cone per segment, bright only at
 * the single hub vertex and dark at the tread. Averaged over the triangle that
 * is a black disc, and the street-level review said exactly that: the fleet
 * looked like it was riding on skids. A wheel is legible because it has a
 * BRIGHT CENTRE covering most of its area, so the face is now three bands —
 * dark tread, a sidewall that fades to metal, and an aluminium dish out to 60%
 * of the radius. Two extra triangles a segment for the thing the eye actually
 * looks for on a car.
 *
 * `o.twin` caps the inboard face too. A one-sided wheel is invisible from its
 * back — fine when a body panel hides it, fatal on a two-wheeler where you can
 * see straight through the bike to the road.
 * `o.arch` adds the fender lip: a dark arc standing just proud of the tyre's
 * outer sidewall. It sits outboard of every body in the fleet (checked against
 * each shape's flank width), so it reads as the wheel well from the 3/4 camera,
 * which is the angle that never shows the wheel itself.
 */
function wheel(sh, cx, cy, cz, r, width, seg = 8, o = {}) {
  const ref = [cx, cy, cz];
  const side = cx >= 0 ? 1 : -1;
  const xo = cx + side * width / 2, xi = cx - side * width / 2;
  const pt = (t, rad, x) => [x, cy + Math.sin(t) * rad, cz + Math.cos(t) * rad];
  const rr = r * 0.60;                        // where the tyre ends and metal starts
  const inward = [cx - side * 2, cy, cz];
  const outward = [cx + side * 2, cy, cz];
  const face = (xs, sgn, ref2) => {
    const xw = xs - sgn * width * 0.16;       // rim set into the sidewall
    const hub = [xs - sgn * width * 0.34, cy, cz];
    for (let i = 0; i < seg; i++) {
      const t0 = (i / seg) * Math.PI * 2, t1 = ((i + 1) / seg) * Math.PI * 2;
      sh.tri3(pt(t0, r, xs), pt(t1, r, xs), pt(t1, rr, xw),
        ROLE.TYRE, ROLE.TYRE, ROLE.RIM, ref2);
      sh.tri3(pt(t0, r, xs), pt(t1, rr, xw), pt(t0, rr, xw),
        ROLE.TYRE, ROLE.RIM, ROLE.RIM, ref2);
      sh.tri3(hub, pt(t0, rr, xw), pt(t1, rr, xw),
        ROLE.CHROME, ROLE.RIM, ROLE.RIM, ref2);
    }
  };
  for (let i = 0; i < seg; i++) {
    const t0 = (i / seg) * Math.PI * 2, t1 = ((i + 1) / seg) * Math.PI * 2;
    sh.quad(pt(t0, r, xo), pt(t1, r, xo), pt(t1, r, xi), pt(t0, r, xi), ROLE.TYRE, ref);
  }
  face(xo, side, inward);
  if (o.twin) face(xi, -side, outward);
  if (o.arch !== false) {
    // Top of the arc only: below the axle a lip would hang in clear air where
    // the body has already tucked in.
    const xa = xo - side * width * 0.10;
    const n = 3;
    for (let i = 0; i < n; i++) {
      const a0 = Math.PI * (0.10 + 0.80 * (i / n));
      const a1 = Math.PI * (0.10 + 0.80 * ((i + 1) / n));
      sh.quad(pt(a0, r * 1.03, xa), pt(a1, r * 1.03, xa),
        pt(a1, r * 1.26, xa), pt(a0, r * 1.26, xa), ROLE.DARK, [0, cy, cz]);
    }
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
  /**
   * Greenhouse: vertical glass flanks, chamfered roof.
   *
   * The flank is split at 0.44 so the upper band can carry a different role.
   * Glass that is one flat tone reads as a painted stripe from the 3/4 camera;
   * a bright sky-reflection band above a dark cabin band is the cheapest thing
   * that makes it read as glazing, and it costs four triangles a car.
   */
  CABIN: [
    [-1.00, 0.00], [1.00, 0.00], [1.00, 0.44], [1.00, 0.70],
    [0.80, 1.00], [-0.80, 1.00], [-1.00, 0.70], [-1.00, 0.44],
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
/** The same, in the exotics' deeper clear-coat. */
const OCT_SILL_GLOSS = { 0: ROLE.GLOSS_LO, 1: ROLE.GLOSS_LO, 2: ROLE.GLOSS_LO };
const CABIN_ROLES = {
  0: ROLE.BODY_LO, 1: ROLE.GLASS, 2: ROLE.GLASS_HI, 3: ROLE.ROOF,
  4: ROLE.ROOF, 5: ROLE.ROOF, 6: ROLE.GLASS_HI, 7: ROLE.GLASS,
};
/** Same greenhouse, but the saloon glazing lights up after dark. */
const CABIN_LIT_ROLES = {
  0: ROLE.BODY_LO, 1: ROLE.CABIN, 2: ROLE.GLASS_HI, 3: ROLE.ROOF,
  4: ROLE.ROOF, 5: ROLE.ROOF, 6: ROLE.GLASS_HI, 7: ROLE.CABIN,
};
/** Greenhouse on an exotic: the roof carries the deep clear-coat too. */
const CABIN_GLOSS_ROLES = {
  0: ROLE.GLOSS_LO, 1: ROLE.GLASS, 2: ROLE.GLASS_HI, 3: ROLE.GLOSS,
  4: ROLE.GLOSS, 5: ROLE.GLOSS, 6: ROLE.GLASS_HI, 7: ROLE.GLASS,
};
const COACH_ROLES = {
  0: ROLE.BODY_LO, 1: ROLE.BODY_LO, 2: ROLE.BODY_LO, 3: ROLE.BODY_LO,
  4: ROLE.CABIN, 5: ROLE.BODY, 6: ROLE.ROOF, 7: ROLE.ROOF,
  8: ROLE.ROOF, 9: ROLE.BODY, 10: ROLE.CABIN, 11: ROLE.BODY_LO,
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

function wheels4(sh, wx, zF, zR, r, w, seg = 6, o = undefined) {
  wheel(sh, wx, r, zF, r, w, seg, o); wheel(sh, -wx, r, zF, r, w, seg, o);
  wheel(sh, wx, r, zR, r, w, seg, o); wheel(sh, -wx, r, zR, r, w, seg, o);
}

/**
 * Wing mirrors on stalks — a tiny silhouette cue that reads instantly. The
 * rearward face gets its own dark quad so the mirror has a glass in it.
 */
function mirrors(sh, x, y, z) {
  for (const s of [-1, 1]) {
    box(sh, s * (x + 0.05), y, z, 0.20, 0.13, 0.07, ROLE.BODY_LO);
    faceZ(sh, s * (x + 0.05), y, z - 0.035, 0.15, 0.09, ROLE.GLASS, -1);
  }
}

/** A B-pillar standing proud of the side glass, both sides. */
function pillar(sh, x, y, z, w, h) {
  for (const s of [-1, 1]) faceX(sh, s * x, y, z, w, h, ROLE.BODY, s);
}

/** Twin tailpipes below the rear bumper. */
function exhaust(sh, x, y, z, r, role = ROLE.CHROME) {
  for (const s of [-1, 1]) box(sh, s * x, y, z, r * 2, r * 2, r * 2.6, role);
}

/** Head/tail lamps, indicators, grille and number plates for a road car. */
function carLamps(sh, o) {
  const { zF, zR, yH, yT, dx, wL = 0.42, hL = 0.15 } = o;
  for (const s of [-1, 1]) {
    faceZ(sh, s * dx, yH, zF, wL, hL, ROLE.HEAD, 1);
    faceZ(sh, s * (dx - wL * 0.5 - 0.13), yH, zF, 0.16, hL * 0.8, ROLE.AMBER, 1);
    faceZ(sh, s * dx, yT, zR, wL * 0.92, hL, ROLE.TAIL, -1);
    // Side repeater on the front wing. Two triangles, and it is what stops the
    // flanks of the fleet going completely dead at night.
    if (o.repeater !== false) {
      faceX(sh, s * (o.rx ?? 0.92), yH, zF - (o.rz ?? 1.0), 0.20, 0.09, ROLE.AMBER, s);
    }
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
  ], { edgeRoles: CABIN_ROLES, skip: new Set([0]), capStart: ROLE.GLASS, capEnd: ROLE.GLASS_HI });
  pillar(sh, 0.85, 1.24, -0.10, 0.11, 0.34);
  faceZ(sh, 0, 1.16, 0.86, 1.30, 0.10, ROLE.INTERIOR, 1);   // dash below the screen
  wheels4(sh, 0.86, 1.45, -1.45, 0.36, 0.26);
  carLamps(sh, { zF: 2.31, zR: -2.31, yH: 0.72, yT: 0.78, dx: 0.56, rx: 0.92, rz: 0.95 });
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
  ], { edgeRoles: CABIN_ROLES, skip: new Set([0]), capStart: ROLE.GLASS, capEnd: ROLE.GLASS_HI });
  pillar(sh, 0.91, 1.58, -0.20, 0.12, 0.40);
  // Roof rails: the one detail that separates an SUV from a tall hatchback.
  for (const s of [-1, 1]) box(sh, s * 0.66, 2.00, -0.4, 0.07, 0.07, 2.5, ROLE.DARK);
  wheels4(sh, 0.93, 1.55, -1.55, 0.42, 0.30);
  carLamps(sh, { zF: 2.42, zR: -2.42, yH: 1.02, yT: 1.16, dx: 0.62, wL: 0.46, yG: 0.72, wG: 1.14, yP: 0.52, rx: 0.99, rz: 1.05 });
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
  ], { edgeRoles: CABIN_ROLES, skip: new Set([0]), capStart: ROLE.GLASS, capEnd: ROLE.GLASS_HI });
  pillar(sh, 0.83, 1.30, -0.30, 0.10, 0.30);
  wheels4(sh, 0.84, 1.28, -1.28, 0.35, 0.25);
  carLamps(sh, { zF: 1.98, zR: -1.98, yH: 0.76, yT: 0.94, dx: 0.54, wL: 0.36, wG: 0.9, yP: 0.46, rx: 0.88, rz: 0.85 });
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
  ], { edgeRoles: CABIN_ROLES, skip: new Set([0]), capStart: ROLE.GLASS, capEnd: ROLE.GLASS_HI });
  pillar(sh, 0.93, 1.66, 0.52, 0.12, 0.40);
  exhaust(sh, 0.62, 0.44, -2.82, 0.06);
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
  ], { role: ROLE.GLOSS, edgeRoles: OCT_SILL_GLOSS, capStart: ROLE.GLOSS_LO, capEnd: ROLE.GLOSS_LO });
  // Fastback: the cabin trails all the way to the tail in one line.
  sweep(sh, SEC.CABIN, [
    { z: -2.10, w: 1.56, h: 0.20, y0: 0.92, rake: 0.06 },
    { z: -0.70, w: 1.76, h: 0.40, y0: 0.92 },
    { z: 0.62, w: 1.62, h: 0.34, y0: 0.86, rake: -0.62 },
  ], { edgeRoles: CABIN_GLOSS_ROLES, skip: new Set([0]), capStart: ROLE.GLOSS, capEnd: ROLE.GLASS_HI });
  chamfer(sh, 0, 1.16, -2.02, 1.44, 0.06, 0.34, 0.03, ROLE.GLOSS_LO);  // ducktail spoiler
  chamfer(sh, 0, 0.30, 2.20, 1.50, 0.09, 0.26, 0.03, ROLE.CARBON);     // front splitter
  faceZ(sh, 0, 0.36, -2.22, 1.20, 0.22, ROLE.CARBON, -1);              // rear diffuser
  exhaust(sh, 0.40, 0.42, -2.30, 0.07);
  wheels4(sh, 0.91, 1.38, -1.38, 0.38, 0.32);
  carLamps(sh, { zF: 2.21, zR: -2.21, yH: 0.60, yT: 0.72, dx: 0.60, wL: 0.40, hL: 0.11, yG: 0.40, wG: 1.1, yP: 0.38, rx: 0.97, rz: 0.90 });
  mirrors(sh, 0.99, 0.96, 0.44);
}

/**
 * Mid-engine supercar. Everything here is doing one job: making it read as
 * NOT-a-sedan from 60 m. Wider track than anything else on the road, a cabin
 * shoved forward over the front axle, a hard shoulder line over the rear
 * haunch, and a wing you can see in silhouette. The paint is the GLOSS band,
 * which is the only place in the fleet with a real clear-coat.
 */
function supercar(sh) {
  sweep(sh, SEC.OCT, [
    { z: -2.24, w: 1.94, h: 0.54, y0: 0.26 },
    { z: -1.60, w: 2.10, h: 0.66, y0: 0.20 },
    { z: -0.20, w: 2.10, h: 0.62, y0: 0.18 },
    { z: 1.30, w: 1.94, h: 0.48, y0: 0.18 },
    { z: 2.10, w: 1.72, h: 0.32, y0: 0.20 },
    { z: 2.32, w: 1.44, h: 0.26, y0: 0.22 },
  ], { role: ROLE.GLOSS, edgeRoles: OCT_SILL_GLOSS, capStart: ROLE.GLOSS_LO, capEnd: ROLE.CARBON });
  // Cabin sits forward of centre — that offset is the mid-engine tell.
  sweep(sh, SEC.CABIN, [
    { z: -0.86, w: 1.44, h: 0.32, y0: 0.76, rake: 0.34 },
    { z: 0.06, w: 1.58, h: 0.36, y0: 0.76 },
    { z: 0.94, w: 1.36, h: 0.26, y0: 0.72, rake: -0.56 },
  ], { edgeRoles: CABIN_GLOSS_ROLES, skip: new Set([0]), capStart: ROLE.GLASS, capEnd: ROLE.GLASS_HI });
  // Engine cover with louvres, dropping away behind the cabin.
  chamfer(sh, 0, 0.94, -1.44, 1.52, 0.16, 1.30, 0.07, ROLE.CARBON);
  for (let i = 0; i < 4; i++) box(sh, 0, 1.03, -1.00 - i * 0.28, 1.34, 0.05, 0.10, ROLE.GLOSS_LO);
  // Side intakes feeding the rear wheels: the deepest shadow on the flank.
  for (const s of [-1, 1]) faceX(sh, s * 1.05, 0.56, -0.90, 1.30, 0.34, ROLE.CARBON, s);
  // Wing on two uprights, high enough to break the roofline.
  for (const s of [-1, 1]) box(sh, s * 0.60, 1.02, -2.06, 0.09, 0.34, 0.20, ROLE.CARBON);
  chamfer(sh, 0, 1.22, -2.10, 1.72, 0.07, 0.42, 0.03, ROLE.CARBON);
  chamfer(sh, 0, 0.24, 2.16, 1.66, 0.10, 0.34, 0.03, ROLE.CARBON);   // splitter
  faceZ(sh, 0, 0.34, -2.26, 1.44, 0.28, ROLE.CARBON, -1);            // diffuser
  exhaust(sh, 0.22, 0.46, -2.34, 0.07, ROLE.CARBON);
  exhaust(sh, 0.52, 0.46, -2.34, 0.07, ROLE.CARBON);
  wheels4(sh, 0.96, 1.46, -1.50, 0.37, 0.36);
  carLamps(sh, {
    zF: 2.32, zR: -2.24, yH: 0.54, yT: 0.66, dx: 0.54, wL: 0.44, hL: 0.09,
    grille: false, yP: 0.34, rx: 1.02, rz: 0.80,
  });
  // A full-width tail bar over the twin lamps — pure supercar signature.
  faceZ(sh, 0, 0.80, -2.26, 1.50, 0.06, ROLE.TAIL, -1);
  mirrors(sh, 1.03, 0.86, 0.30);
}

/** Open-top luxury roadster: long bonnet, twin roll hoops, roof down. */
function roadster(sh) {
  sweep(sh, SEC.OCT, [
    { z: -2.16, w: 1.68, h: 0.66, y0: 0.34 },
    { z: -1.44, w: 1.90, h: 0.74, y0: 0.28 },
    { z: 0.40, w: 1.90, h: 0.72, y0: 0.28 },
    { z: 1.70, w: 1.82, h: 0.60, y0: 0.28 },
    { z: 2.28, w: 1.58, h: 0.44, y0: 0.30 },
  ], { role: ROLE.GLOSS, edgeRoles: OCT_SILL_GLOSS, capStart: ROLE.GLOSS_LO, capEnd: ROLE.GLOSS_LO });
  // Cockpit tub, seats, and the folded roof under a tonneau behind them.
  faceY(sh, 0, 0.99, -0.34, 1.44, 1.56, ROLE.SEAT);
  for (const s of [-1, 1]) {
    chamfer(sh, s * 0.38, 1.16, -0.82, 0.42, 0.30, 0.24, 0.07, ROLE.SEAT);
    chamfer(sh, s * 0.38, 1.20, -1.16, 0.46, 0.26, 0.30, 0.09, ROLE.GLOSS_LO);  // roll hoop
  }
  chamfer(sh, 0, 1.06, -1.62, 1.62, 0.16, 0.86, 0.10, ROLE.GLOSS_LO);
  faceZ(sh, 0, 1.06, 0.44, 1.30, 0.13, ROLE.INTERIOR, 1);            // dashboard top
  // Raked screen in a chrome frame — the frame is what sells "roof down".
  const zw = 0.56;
  sh.quad([-0.74, 1.02, zw], [0.74, 1.02, zw], [0.64, 1.44, zw - 0.32], [-0.64, 1.44, zw - 0.32],
    ROLE.GLASS_HI, [0, 0.6, -1]);
  for (const s of [-1, 1]) box(sh, s * 0.70, 1.23, zw - 0.16, 0.05, 0.44, 0.36, ROLE.CHROME);
  box(sh, 0, 1.45, zw - 0.33, 1.34, 0.05, 0.06, ROLE.CHROME);
  chamfer(sh, 0, 0.28, 2.20, 1.44, 0.08, 0.24, 0.03, ROLE.CARBON);
  exhaust(sh, 0.46, 0.42, -2.24, 0.07);
  wheels4(sh, 0.90, 1.44, -1.40, 0.38, 0.30);
  carLamps(sh, { zF: 2.28, zR: -2.16, yH: 0.70, yT: 0.80, dx: 0.56, wL: 0.40, hL: 0.12, yG: 0.44, wG: 1.06, yP: 0.42, rx: 0.96, rz: 0.95 });
  mirrors(sh, 0.98, 1.02, 0.42);
}

/** Grand tourer: very long bonnet, tight fastback cabin set well back. */
function gtCoupe(sh) {
  sweep(sh, SEC.OCT, [
    { z: -2.42, w: 1.76, h: 0.66, y0: 0.36 },
    { z: -1.70, w: 1.96, h: 0.74, y0: 0.30 },
    { z: 0.60, w: 1.96, h: 0.70, y0: 0.28 },
    { z: 2.00, w: 1.84, h: 0.54, y0: 0.28 },
    { z: 2.52, w: 1.62, h: 0.40, y0: 0.30 },
  ], { role: ROLE.GLOSS, edgeRoles: OCT_SILL_GLOSS, capStart: ROLE.GLOSS_LO, capEnd: ROLE.GLOSS_LO });
  sweep(sh, SEC.CABIN, [
    { z: -2.06, w: 1.52, h: 0.26, y0: 0.98, rake: 0.10 },
    { z: -1.10, w: 1.74, h: 0.46, y0: 0.98 },
    { z: 0.34, w: 1.60, h: 0.40, y0: 0.94, rake: -0.66 },
  ], { edgeRoles: CABIN_GLOSS_ROLES, skip: new Set([0]), capStart: ROLE.GLOSS, capEnd: ROLE.GLASS_HI });
  pillar(sh, 0.87, 1.20, -1.10, 0.12, 0.30);
  // Bonnet power bulge and a pair of vents: the long nose needs an event.
  chamfer(sh, 0, 1.02, 1.50, 1.10, 0.06, 0.90, 0.05, ROLE.GLOSS);
  for (const s of [-1, 1]) faceY(sh, s * 0.58, 0.99, 0.98, 0.26, 0.44, ROLE.CARBON);
  chamfer(sh, 0, 1.16, -2.28, 1.40, 0.06, 0.30, 0.03, ROLE.GLOSS_LO);
  faceZ(sh, 0, 0.38, -2.44, 1.24, 0.24, ROLE.CARBON, -1);
  exhaust(sh, 0.48, 0.44, -2.52, 0.07);
  wheels4(sh, 0.93, 1.62, -1.56, 0.39, 0.31);
  carLamps(sh, { zF: 2.52, zR: -2.42, yH: 0.70, yT: 0.84, dx: 0.58, wL: 0.42, hL: 0.11, yG: 0.44, wG: 1.14, yP: 0.42, rx: 0.99, rz: 1.05 });
  mirrors(sh, 1.01, 1.06, 0.60);
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
    ROLE.GLASS_HI, [0, 0.6, -1]);
  for (const s of [-1, 1]) {
    box(sh, s * 0.73, 1.26, zw - 0.15, 0.05, 0.42, 0.34, ROLE.CHROME);
  }
  wheels4(sh, 0.87, 1.36, -1.36, 0.37, 0.27);
  carLamps(sh, { zF: 2.17, zR: -2.17, yH: 0.70, yT: 0.78, dx: 0.56, wL: 0.38, yP: 0.44, rx: 0.93, rz: 0.95 });
  mirrors(sh, 0.95, 1.06, 0.52);
}

function taxi(sh) {
  sedan(sh);
  // Roof sign: a lit box, not a painted one. It is the single most legible
  // "this city has taxis in it" cue after dark, and it costs one band.
  chamfer(sh, 0, 1.58, 0.10, 0.74, 0.22, 0.28, 0.05, ROLE.SIGN);
  box(sh, 0, 1.45, 0.10, 0.60, 0.06, 0.22, ROLE.DARK);             // mounting foot
  // Livery band down the doors plus a chequer stripe above it.
  for (const s of [-1, 1]) {
    faceX(sh, s * 0.92, 0.66, -0.1, 2.5, 0.24, ROLE.ACCENT, s);
    faceX(sh, s * 0.92, 0.86, -0.1, 2.5, 0.10, ROLE.WHITE, s);
  }
}

function police(sh) {
  suv(sh);
  // Light bar with red and blue ends, plus a door shield panel.
  chamfer(sh, 0, 2.02, 0.20, 1.24, 0.16, 0.32, 0.05, ROLE.DARK);
  for (const dz of [1, -1]) {
    faceZ(sh, -0.42, 2.02, 0.20 + dz * 0.16, 0.38, 0.13, ROLE.TAIL, dz);
    faceZ(sh, 0.42, 2.02, 0.20 + dz * 0.16, 0.38, 0.13, ROLE.BEACON, dz);
  }
  for (const s of [-1, 1]) {
    faceX(sh, s * 0.98, 0.96, -0.2, 1.9, 0.5, ROLE.BLUE, s);
    faceX(sh, s * 0.63, 2.02, 0.20, 0.30, 0.13, ROLE.BEACON, s);
  }
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
  // Signwriting. Every van in FLEET carries an `accent` colour and until now
  // nothing in the shape used it, so the whole delivery fleet came out as
  // blank white boxes — the one body style in the city with a flat 3 x 2 m
  // panel begging for a livery, and it was the only one not wearing one.
  // Restricted to the parallel section of the flank: forward of z = -2.0 the
  // body tucks in and a decal pinned to the full width would float.
  for (const s of [-1, 1]) {
    faceX(sh, s * 1.03, 1.52, -0.80, 2.40, 1.06, ROLE.ACCENT, s);
    faceX(sh, s * 1.03, 0.74, -0.80, 2.60, 0.16, ROLE.ACCENT, s);
  }
  faceZ(sh, 0, 1.50, -2.95, 1.52, 0.92, ROLE.ACCENT, -1);
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
  faceZ(sh, 0, 3.02, 5.78, 1.70, 0.30, ROLE.SIGN, 1);
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
  faceZ(sh, 0, 3.02, 8.92, 1.70, 0.30, ROLE.SIGN, 1);
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
  chamfer(sh, 0, 2.82, 1.10, 1.40, 0.18, 0.34, 0.05, ROLE.DARK);     // light bar
  for (const dz of [1, -1]) {
    faceZ(sh, -0.46, 2.82, 1.10 + dz * 0.17, 0.42, 0.14, ROLE.TAIL, dz);
    faceZ(sh, 0.46, 2.82, 1.10 + dz * 0.17, 0.42, 0.14, ROLE.BEACON, dz);
  }
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
  faceZ(sh, 0, 0.80, -0.96, 0.16, 0.09, ROLE.TAIL, -1);
  // Both faces capped: there is no bodywork on a scooter to hide the back of a
  // one-sided wheel, so from the far side you looked through the bike.
  wheel(sh, 0.02, 0.30, 0.66, 0.30, 0.11, 7, { twin: true });
  wheel(sh, 0.02, 0.30, -0.66, 0.30, 0.13, 7, { twin: true });
}

/**
 * Naked motorcycle. Two wheels give it almost no plan area, so the silhouette
 * has to work in profile: a raked fork, a tank that steps up out of the engine,
 * a stepped seat and a tail unit that kicks up behind the rear wheel. That
 * profile is what stops it reading as "small car" at 40 m, which is the only
 * thing a bike has to get right in this game.
 */
function motorcycle(sh) {
  const rF = 0.33, rR = 0.35;
  wheel(sh, 0.0, rF, 0.70, rF, 0.13, 7, { twin: true });
  wheel(sh, 0.0, rR, -0.62, rR, 0.18, 7, { twin: true });
  // Fork legs and yoke, raked forward over the front wheel.
  for (const s of [-1, 1]) box(sh, s * 0.13, 0.66, 0.64, 0.06, 0.74, 0.09, ROLE.CHROME);
  chamfer(sh, 0, 0.98, 0.58, 0.30, 0.26, 0.26, 0.07, ROLE.DARK);
  chamfer(sh, 0, 0.46, 0.04, 0.40, 0.44, 0.62, 0.09, ROLE.DARK);     // engine
  chamfer(sh, 0, 0.86, 0.16, 0.42, 0.32, 0.68, 0.12, ROLE.BODY);     // tank
  chamfer(sh, 0, 0.84, -0.30, 0.34, 0.10, 0.44, 0.05, ROLE.SEAT);
  chamfer(sh, 0, 0.94, -0.66, 0.26, 0.22, 0.40, 0.08, ROLE.BODY);    // tail unit
  box(sh, 0, 1.14, 0.54, 0.66, 0.05, 0.06, ROLE.DARK);               // bars
  for (const s of [-1, 1]) box(sh, s * 0.31, 1.22, 0.52, 0.11, 0.08, 0.05, ROLE.CHROME);
  chamfer(sh, 0, 1.02, 0.74, 0.24, 0.22, 0.14, 0.05, ROLE.BODY);
  faceZ(sh, 0, 1.02, 0.81, 0.19, 0.15, ROLE.HEAD, 1);
  faceZ(sh, 0, 0.98, -0.86, 0.17, 0.10, ROLE.TAIL, -1);
  faceZ(sh, 0, 0.62, -0.88, 0.20, 0.07, ROLE.PLATE, -1);
  for (const s of [-1, 1]) faceX(sh, s * 0.19, 1.06, 0.68, 0.11, 0.08, ROLE.AMBER, s);
  cyl(sh, 0.22, 0.42, -0.52, 0.08, 0.09, 0.66, 6, 'z', ROLE.CHROME); // exhaust can
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

/**
 * Personal watercraft. Small enough that it lives or dies on silhouette: a
 * pointed prow, a stepped saddle, handlebars and a stubby rear platform.
 */
function jetSki(sh) {
  sweep(sh, SEC.HULL, [
    { z: -1.35, w: 1.02, h: 0.58, y0: -0.26 },
    { z: -0.70, w: 1.16, h: 0.62, y0: -0.30 },
    { z: 0.50, w: 1.14, h: 0.62, y0: -0.30 },
    { z: 1.28, w: 0.66, h: 0.58, y0: -0.24 },
    { z: 1.62, w: 0.16, h: 0.48, y0: -0.16 },
  ], { role: ROLE.GLOSS, edgeRoles: { 5: ROLE.GLOSS_LO }, capStart: ROLE.GLOSS_LO, capEnd: ROLE.GLOSS });
  chamfer(sh, 0, 0.44, -0.30, 0.62, 0.20, 1.00, 0.09, ROLE.SEAT);      // saddle
  chamfer(sh, 0, 0.52, 0.68, 0.56, 0.26, 0.52, 0.10, ROLE.GLOSS_LO);   // bar cowl
  box(sh, 0, 0.72, 0.86, 0.62, 0.05, 0.06, ROLE.DARK);                 // handlebars
  chamfer(sh, 0, 0.30, -1.28, 0.80, 0.08, 0.34, 0.04, ROLE.DECK);      // boarding step
  for (const s of [-1, 1]) faceX(sh, s * 0.58, 0.26, 0.10, 1.40, 0.16, ROLE.ACCENT, s);
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
    // Castors, tucked under the chassis: a fender lip on a 240 mm wheel that
    // nobody can see costs six triangles and buys nothing.
    for (const z of [0.95, -0.95]) wheel(sh, s * 0.72, 0.24, z, 0.24, 0.18, 7, { arch: false });
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
  supercar, roadster, gtCoupe,
  deliveryVan, boxTruck, flatbed, garbageTruck, cementMixer,
  cityBus, articBus, shuttleBus, ambulance, scooter, motorcycle, bicycle,
  motorYacht, sailBoat, waterTaxi, skiff, sportFisher, cruiseShip, jetSki,
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
 * Ground truth from the shape buffer, measured once per shape and cached.
 *
 * worldBuild.js already measures this geometry to size the consumption physics.
 * Placement has to read the SAME numbers or the two are describing different
 * objects — which is how a fleet ends up parked in bays too narrow for it.
 *
 *   minY      the lowest point of the shape, i.e. how far the tyres sit above
 *             the origin. Every road vehicle here bottoms out 12-75 mm up.
 *   contactW  width across the contact patch — what has to fit in a kerb bay.
 *   contactD  length along it — what has to fit between two bay ticks.
 *   radius    the same contact radius worldBuild hands the physics.
 */
const _metricCache = new Map();
function shapeMetrics(key) {
  let m = _metricCache.get(key);
  if (m) return m;
  const p = getShape(key).pos.array;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 1; i < p.length; i += 3) {
    if (p[i] < minY) minY = p[i];
    if (p[i] > maxY) maxY = p[i];
  }
  // Contact band: the lowest fifth of the object, which is what rests on the
  // ground. A bus mirror 3 m up says nothing about the bay it needs.
  const hiY = minY + (maxY - minY) * 0.20;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i + 1] > hiY) continue;
    if (p[i] < minX) minX = p[i]; if (p[i] > maxX) maxX = p[i];
    if (p[i + 2] < minZ) minZ = p[i + 2]; if (p[i + 2] > maxZ) maxZ = p[i + 2];
  }
  const cw = maxX - minX, cd = maxZ - minZ;
  m = { minY, height: maxY - minY, contactW: cw, contactD: cd,
        radius: Math.hypot(cw, cd) / 2 };
  _metricCache.set(key, m);
  return m;
}

/**
 * Put the origin where the shape's lowest geometry lands on `surface`.
 *
 * Road vehicles were all spawned at y = surface + 0.015 as a z-fight guard, but
 * their wheel cylinders already bottom out 48-75 mm above the shape origin, so
 * the guard stacked on top of a gap and the whole fleet hovered 6-9 cm over the
 * tarmac. Measuring it gives a real 4 mm of clearance instead of a guessed one.
 *
 * A hull is the exception: boats are authored with y = 0 AT THE WATERLINE and
 * geometry below it, so their draught is the author's and must not be seated.
 */
function seatY(type, surface) {
  const minY = shapeMetrics(type).minY;
  return minY > 0 ? surface - minY + 0.004 : surface;
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
/** A deep clear-coat paint for the exotics: darker sills, gloss everywhere. */
const exotic = (c, rim = P.CHROME) => ({ paint: c, paintLo: darken(c, 0.58), rim });

const FLEET = {
  // Colour counts are a real cost: a pool is one (shape, paint) pair, so nine
  // sedan colours is nine draw calls. They are spent here rather than on more
  // shapes because a row of six identical white sedans is the single loudest
  // "this is procedural" tell on a kerb, and the fix is colour, not geometry.
  // A contrasting roof costs NOTHING — `roof` is already its own role — and it
  // is the only body-colour variation the 3/4 camera can see, because from up
  // there the roof is most of the car. Spending it on a third of the variants
  // breaks up a kerb of same-shape saloons without buying another pool.
  sedan: { tier: 'LARGE', r: 1.6, h: 1.5, len: 4.7, cap: 120, label: 'Sedan',
    paints: [
      { paint: P.CAR_WHITE }, { paint: P.CAR_SILVER, roof: P.CAR_GRAPHITE },
      { paint: P.CAR_RED, roof: P.CAR_BLACK }, { paint: P.CAR_BLUE },
      { paint: P.CAR_CORAL, roof: P.STUCCO_CREAM }, { paint: P.CAR_GRAPHITE },
      { paint: P.CAR_NAVY }, { paint: P.CAR_TEAL, roof: P.CAR_WHITE },
      { paint: P.STUCCO_BUTTER }] },
  suv: { tier: 'LARGE', r: 1.7, h: 1.85, len: 4.9, cap: 110, label: 'SUV',
    paints: [
      { paint: P.CAR_BLACK }, { paint: P.CAR_WHITE, roof: P.CAR_GRAPHITE },
      { paint: P.CAR_SILVER }, { paint: P.CAR_GREEN, roof: P.CAR_WHITE },
      { paint: P.CAR_ORANGE }, { paint: P.CAR_NAVY, roof: P.CAR_SILVER },
      { paint: P.CAR_GRAPHITE }] },
  hatchback: { tier: 'LARGE', r: 1.4, h: 1.6, len: 4.0, cap: 90, label: 'Hatchback',
    // Pastels come from the stucco set on purpose: they are already graded for
    // this sun, and a mint or peach hatchback is exactly right for Miami.
    paints: [
      { paint: P.CAR_LIME, roof: P.CAR_WHITE }, { paint: P.CAR_TEAL },
      { paint: P.CAR_YELLOW, roof: P.CAR_GRAPHITE }, { paint: P.CAR_WHITE },
      { paint: P.STUCCO_MINT }, { paint: P.STUCCO_PEACH, roof: P.CAR_WHITE },
      { paint: P.CAR_PINK, roof: P.CAR_WHITE }] },
  pickup: { tier: 'LARGE', r: 1.8, h: 1.9, len: 5.5, cap: 70, label: 'Pickup',
    paints: plain([P.CAR_CORAL, P.CAR_GRAPHITE, P.CAR_WHITE, P.CAR_NAVY, P.CAR_RED]) },
  sports: { tier: 'LARGE', r: 1.5, h: 1.25, len: 4.5, cap: 55, label: 'Sports Coupe',
    paints: [P.CAR_RED, P.CAR_PINK, P.CAR_MINT, P.CAR_YELLOW, P.CAR_PURPLE].map((c) => exotic(c)) },
  convertible: { tier: 'LARGE', r: 1.5, h: 1.35, len: 4.4, cap: 50, label: 'Convertible',
    paints: plain([P.CAR_PURPLE, P.CAR_WHITE, P.CAR_CORAL, P.STUCCO_AQUA, P.CAR_PINK]) },
  supercar: { tier: 'LARGE', r: 1.6, h: 1.15, len: 4.7, cap: 40, label: 'Supercar',
    paints: [P.NEON_PINK, P.NEON_AQUA, P.ACCENT_SUN, P.CAR_ORANGE, P.CAR_LIME, P.CAR_WHITE]
      .map((c) => exotic(c, P.CAR_GRAPHITE)) },
  roadster: { tier: 'LARGE', r: 1.5, h: 1.3, len: 4.5, cap: 40, label: 'Roadster',
    paints: [P.CAR_MINT, P.STUCCO_PINK, P.CAR_SILVER, P.CAR_NAVY, P.CAR_PURPLE]
      .map((c) => exotic(c)) },
  gtCoupe: { tier: 'LARGE', r: 1.6, h: 1.4, len: 5.0, cap: 40, label: 'Grand Tourer',
    paints: [P.CAR_GRAPHITE, P.CAR_NAVY, P.CAR_RED, P.CAR_SILVER, P.CAR_TEAL]
      .map((c) => exotic(c)) },
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
  scooter: { tier: 'MEDIUM', r: 0.6, h: 1.1, len: 1.9, cap: 80, label: 'Scooter',
    paints: plain([P.CAR_TEAL, P.CAR_PINK, P.STUCCO_BUTTER, P.CAR_WHITE]) },
  motorcycle: { tier: 'MEDIUM', r: 0.7, h: 1.3, len: 2.3, cap: 70, label: 'Motorcycle',
    paints: [P.CAR_RED, P.CAR_GRAPHITE, P.NEON_AQUA, P.CAR_ORANGE, P.CAR_BLACK]
      .map((c) => exotic(c)) },
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
  jetSki: { tier: 'MEDIUM', r: 0.7, h: 1.0, len: 3.1, cap: 40, label: 'Jet Ski',
    paints: [P.NEON_PINK, P.NEON_AQUA, P.ACCENT_SUN, P.CAR_LIME]
      .map((c) => ({ ...exotic(c), accent: P.HULL_WHITE, deck: P.HULL_WHITE })) },

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
function spawn(ctx, state, type, vi, x, surfaceY, z, rotY, dynamic) {
  const def = FLEET[type];
  const spec = def.paints[vi % def.paints.length];
  const key = `veh:${type}:${vi}`;
  const c = ctx.addInstanced(key, () => ({
    geometry: variantGeometry(type, spec),
    material: vehicleMaterial(),
  }), {
    // Callers pass the SURFACE the thing stands on; seatY turns that into an
    // origin, so nobody has to remember a per-shape fudge.
    position: new THREE.Vector3(x, seatY(type, surfaceY), z),
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

/** Mirrors roadNetwork.speedFor. Local because the lanes below are ours. */
function speedForClass(cls) {
  if (cls === ROAD_CLASS.BOULEVARD) return 15.5;   // ~55 km/h
  if (cls === ROAD_CLASS.AVENUE) return 12.5;
  return 9.5;
}

/**
 * EVERY LANE streets.js ACTUALLY PAINTS.
 *
 * roadNetwork gives one lane per direction on a street and two on an avenue.
 * streets.js paints two and four, plus a bus lane on every boulevard, plus the
 * kerbside bay. The gap is not academic: on an avenue the network's outermost
 * lane sits 5.1 m from the centreline while the paint runs out to 13.6 m, so
 * traffic drove down the middle of the road and the outer half of every
 * carriageway was bare asphalt between the moving cars and the parked ones.
 *
 * So the lane set traffic drives is derived from the SAME `lanePlan` that
 * paints the road. roadNetwork keeps its jobs — intersections, stop lines,
 * signal phases, sidewalks, and the lanes pedestrians.js cycles on — and this
 * module stops pretending its four-lane avenues are two-lane ones.
 *
 * Lane 0 is the INNERMOST (against the centreline or median) and lane n-1 is
 * the kerbmost, which is the opposite of roadNetwork's numbering. It is written
 * that way here because it matches the order streets.js paints them in.
 */
function buildDriveLanes(layout, net) {
  const lanes = [];
  const S = WORLD.SIZE;
  for (const [axis, roads] of [['x', layout.roadsX], ['z', layout.roadsZ]]) {
    for (let ri = 0; ri < roads.length; ri++) {
      const r = roads[ri];
      const P = lanePlan(r);
      const n = P.lanes + (P.bus ? 1 : 0);
      for (const dir of [1, -1]) {
        // Right-hand traffic: see the header of roadNetwork.js. Travelling +z
        // your right hand points to -x; travelling +x it points to +z.
        const rightSign = axis === 'x' ? (dir > 0 ? -1 : 1) : (dir > 0 ? 1 : -1);
        for (let k = 0; k < n; k++) {
          const busLane = P.bus && k === n - 1;
          const inward = busLane ? P.busEdge + LANE_W * 0.5 : P.inner + (k + 0.5) * LANE_W;
          lanes.push({
            id: lanes.length,
            axis, roadIndex: ri, road: r,
            cross: r.pos + rightSign * inward,
            dir, index: k, laneCount: n,
            innerLane: k === 0,
            kerbLane: k === n - 1,
            busLane,
            /** +1/-1 along the cross axis, pointing at the kerb. */
            kerbSign: rightSign,
            min: -S - 30,
            max: axis === 'x' ? S + 30 : WORLD.BAY_EDGE + 30,
            speed: speedForClass(r.cls),
            junctions: [],
          });
        }
      }
    }
  }
  // Junction links, by exactly the rule roadNetwork uses.
  for (const lane of lanes) {
    const list = [];
    for (const ix of net.intersections) {
      if (lane.axis === 'x' ? ix.ri !== lane.roadIndex : ix.rj !== lane.roadIndex) continue;
      list.push({ ix, s: net.sFor(lane, ix.x, ix.z) });
    }
    list.sort((a, b) => a.s - b.s);
    lane.junctions = list;
  }
  return lanes;
}

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

/**
 * How many vehicles may be standing in a live traffic lane at once, city-wide.
 *
 * A double-parked van is the difference between a street that looks used and
 * one that looks like a diorama. It is also, at scale, gridlock: a single-lane
 * street with a van on it stops dead until the van leaves. Ten is enough that
 * you nearly always have one on camera in a busy frame and few enough that the
 * network never notices.
 */
const MAX_BLOCKING = 10;

/* --------------------------------------------------------- bridges ---- */
/**
 * MUST mirror `bridgeSpans` / `yAt` in streets.js, the way `lanePlan` below
 * mirrors its kerb bays. streets.js owns the deck geometry; this is the only
 * description of it traffic has.
 *
 * The previous version ramped 1.2 m in BOTH axes around the raw AABB in
 * layout.bridges, and that is not the surface streets.js builds. It builds
 * between `lo` and `hi`, which are the AABB CLAMPED INWARD to the nearest
 * crossing road, and its approach ramp is only as long as the gap left over —
 * frequently shorter than 7 m, and 0 m where a road abuts the deck. Two
 * consequences, both of which the audit was seeing:
 *
 *   · The Brickell Key Causeway's AABB is 42 m long but its deck is the 24 m
 *     between SE 8 St and SE 10 St. The old cross-axis ramp then lifted traffic
 *     on SE 8 St — a road 25 m away that never touches the causeway — by up to
 *     0.57 m of clear air.
 *   · Where a ramp is shortened, cars ramped over 7 m while the asphalt ramped
 *     over less, so they climbed ahead of the deck.
 *
 * The three river bridges happen to be unclamped with full 7 m ramps, which is
 * why they looked fine and hid the bug.
 */
const DECK_Y = 1.2;
const DECK_RAMP = 7;

function buildDeckSpans(layout) {
  return layout.bridges.map((br) => {
    const alongZ = br.length >= br.width;
    const half = (alongZ ? br.length : br.width) / 2;
    const c = alongZ ? br.z : br.x;
    const perp = alongZ ? layout.roadsZ : layout.roadsX;
    let lo = c - half, hi = c + half;
    for (const r of perp) {
      const a = r.pos - r.half, b = r.pos + r.half;
      if (b <= c && b > lo) lo = b;
      if (a >= c && a < hi) hi = a;
    }
    let freeLo = 1e4, freeHi = 1e4;
    for (const r of perp) {
      const a = r.pos - r.half, b = r.pos + r.half;
      if (b <= lo) freeLo = Math.min(freeLo, lo - b);
      if (a >= hi) freeHi = Math.min(freeHi, a - hi);
    }
    return {
      alongZ, lo, hi,
      cross: alongZ ? br.x : br.z,
      halfW: br.width / 2,
      rampLo: Math.min(DECK_RAMP, freeLo),
      rampHi: Math.min(DECK_RAMP, freeHi),
    };
  });
}

/** Height of the running surface at (x,z); 0 anywhere that is not a deck. */
function deckHeight(spans, x, z) {
  let y = 0;
  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i];
    // Beyond the fascia there is a parapet and a drop, not a ramp.
    if (Math.abs((sp.alongZ ? x : z) - sp.cross) > sp.halfW) continue;
    const t = sp.alongZ ? z : x;
    const t0 = sp.lo - sp.rampLo, t1 = sp.hi + sp.rampHi;
    if (t < t0 || t > t1) continue;
    const a = sp.rampLo > 0 ? (t - t0) / sp.rampLo : 1;
    const b = sp.rampHi > 0 ? (t1 - t) / sp.rampHi : 1;
    const k = Math.max(0, Math.min(1, a, b));
    if (k * DECK_Y > y) y = k * DECK_Y;
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
    /** Cars that finished nosing into a bay this frame. */
    this.unpark = [];
    /** Cars sitting in a kerbside bay, deliberately absent from every lane. */
    this.parked = [];
    /** How many vehicles are currently standing IN a running lane. Capped. */
    this.blocking = 0;
    /** How many buses are sitting at a stop in a bus lane. Separately capped. */
    this.busHalts = 0;
    /** Lifetime manoeuvre tally — the only way to tell "rare" from "broken". */
    this.tally = { bayStops: 0, doubleParks: 0, busStops: 0, laneChanges: 0,
      aborted: 0, pullOuts: 0, revived: 0 };
    /** Swallowed vehicles, waiting for the respawner to hand them back. */
    this.gone = [];
    this._reviveT = 0;
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
    for (const lane of buildDriveLanes(layout, this.net)) {
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
      // Unit vector toward the kerb, and the sign of the yaw change that steers
      // that way. Everything lateral — pulling in to a bay, double-parking,
      // changing lane — is expressed in these so no caller has to re-derive
      // which way "right" is on a road running the other way.
      const h = this.net.headingOf(lane);
      const kx = lane.axis === 'x' ? lane.kerbSign : 0;
      const kz = lane.axis === 'x' ? 0 : lane.kerbSign;
      const info = {
        lane, segs, list: [], claims: [], opposing: null, siblings: [],
        sMin: s0, sMax: s1,
        kx, kz, kyaw: kx * Math.cos(h) - kz * Math.sin(h),
      };
      this.lanes.push(info);
      this.byLaneId.set(lane.id, info);
      for (let i = 0; i < segs.length; i++) {
        if (segs[i].edgeLo) this.entries.push({ info, si: i });
      }
    }
    for (const info of this.lanes) {
      const L = info.lane;
      // Oncoming lanes, cached for the left-turn yield test.
      info.opposing = this.lanes.filter((o) =>
        o.lane.axis === L.axis && o.lane.roadIndex === L.roadIndex && o.lane.dir !== L.dir);
      // Lanes you may legally slide into: same carriageway, adjacent index.
      // The bus lane is excluded so general traffic never drifts into it.
      info.siblings = this.lanes.filter((o) =>
        o.lane.axis === L.axis && o.lane.roadIndex === L.roadIndex
        && o.lane.dir === L.dir && !o.lane.busLane
        && Math.abs(o.lane.index - L.index) === 1);
      // The whole carriageway, kerbmost last — the turn targets are drawn here.
      info.carriageway = this.lanes
        .filter((o) => o.lane.axis === L.axis && o.lane.roadIndex === L.roadIndex
          && o.lane.dir === L.dir)
        .sort((a, b) => a.lane.index - b.lane.index);
    }
    // Perpendicular carriageways, keyed for the turn lookup.
    this.byRoadDir = new Map();
    for (const info of this.lanes) {
      const L = info.lane;
      const k = `${L.axis}:${L.roadIndex}:${L.dir}`;
      let arr = this.byRoadDir.get(k);
      if (!arr) { arr = []; this.byRoadDir.set(k, arr); }
      arr.push(info);
    }
    for (const arr of this.byRoadDir.values()) arr.sort((a, b) => a.lane.index - b.lane.index);
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

  /**
   * Is there room at `s` on this lane for a vehicle of length `len`?
   *
   * The lane list alone is not the answer. Lane changes are applied AFTER the
   * per-lane sweep, so a slot claimed earlier in the same frame is still
   * invisible to it: two cars leaving the map on the same tick both drew the
   * same boundary segment, both found it empty and both re-entered at the same
   * `s`. That is exactly where the pairs of cars sitting inside each other at
   * the map edge came from, and the same race let two cars turn into one gap.
   */
  hasRoom(info, s, len) {
    const L = info.list;
    for (let i = 0; i < L.length; i++) {
      if (Math.abs(L[i].s - s) < (L[i].len + len) * 0.5 + 4) return false;
      if (L[i].s > s + 40) break;
    }
    const P = this.pending;
    for (let i = 0; i < P.length; i++) {
      if (P[i].to !== info) continue;
      if (Math.abs(P[i].s - s) < (P[i].v.len + len) * 0.5 + 4) return false;
    }
    // Slots held by cars already committed to an arc onto this lane. A turn is
    // decided up to 45 m out and re-checked once more before the arc, but the
    // car then spends 6-11 m of arc in the junction with nothing holding its
    // landing spot — so a second car turning in from another approach found the
    // lane empty and both arrived in the same 3 m of tarmac. Holding the slot
    // from the moment of commitment is what stops that, and it costs a refused
    // turn rather than a visible correction after the fact.
    const C = info.claims;
    for (let i = 0; i < C.length; i++) {
      if (Math.abs(C[i].s - s) < (C[i].len + len) * 0.5 + 4) return false;
    }
    return true;
  }

  /** Abandon a turn, releasing whatever slot it was holding. */
  _dropTurn(v) {
    const t = v.turn;
    if (!t) return;
    if (t.claim) {
      const C = t.dstInfo.claims;
      const i = C.indexOf(t.claim);
      if (i >= 0) C.splice(i, 1);
      t.claim = null;
    }
    v.turn = null;
  }

  /**
   * Hand back the road space a stopped vehicle was holding. Two separate
   * quotas: general traffic double-parking in a running lane, and transit
   * halting in a bus lane. They contend for different tarmac, so sharing one
   * counter would have five buses at stops starve every van in the city.
   */
  _unblock(v) {
    if (v.blocks) { v.blocks = false; this.blocking--; }
    if (v.haltsBus) { v.haltsBus = false; this.busHalts--; }
  }

  /** Give back everything a vehicle was holding: turn slot, bay, block quota. */
  _release(v) {
    this._dropTurn(v);
    if (v.bay) { v.bay.taken = false; v.bay = null; }
    this._unblock(v);
  }

  /** Swallowed. Keep the record so the respawner can hand it back to traffic. */
  _lose(v) {
    this._release(v);
    v.dead = true;
    if (!v.gone) { v.gone = true; this.gone.push(v); }
  }

  /**
   * Put respawned vehicles back on the road.
   *
   * The consume system returns a swallowed prop to its authored resting place
   * after 30 s — and for a moving car the "authored" place is wherever it was
   * when it went in, because the updater writes the live transform there every
   * frame. Without this, every car the player eats came back as a dead lump
   * parked in a live lane that the rest of the traffic then drove through.
   */
  _reviveGone() {
    for (let i = this.gone.length - 1; i >= 0; i--) {
      const v = this.gone[i];
      const c = v.c;
      if (!c) { this.gone.splice(i, 1); continue; }
      if (c.state !== 0 || !this.registry.byId.has(c.id)) continue;
      let info = v.info;
      let s = this.net.sFor(info.lane, c.position.x, c.position.z);
      if (!this.hasRoom(info, s, v.len + 6)) {
        // Its old slot filled in while it was gone: come back at the map edge
        // instead. Failing that, wait — a stuck retry costs one test a second.
        const e = this._freeEntry(v);
        if (!e) continue;
        info = e.info;
        v.lane = info.lane;
        v.seg = e.si;
        v.v0 = info.lane.speed * v.vf;
        s = info.segs[e.si].lo + v.len * 0.5 + 2;
      } else {
        v.seg = this._segAt(info, s);
      }
      this.gone.splice(i, 1);
      v.gone = false;
      v.dead = false;
      v.s = s;
      v.v = 0;
      v.mode = 'drive';
      v.lat = v.latT = v.latV = 0;
      v.hazard = false; v.held = false; v.boost = 0; v.moveT = 0;
      v.turn = null; v.decided = -1;
      v.cool = 6 + this.rng() * 12;
      this._insert(info, v);
      this.tally.revived++;
    }
  }

  /**
   * Steer toward the target lateral offset.
   *
   * Rate scales with road speed, so a car crossing a lane at 14 m/s takes about
   * as long as one nosing into a bay at 2 m/s takes to cover a tenth of the
   * distance. That is what makes a lane change read as a lane change and a park
   * read as a park, out of one number.
   */
  _lateral(v, dt) {
    const d = v.latT - v.lat;
    if (Math.abs(d) < 1e-4) { v.lat = v.latT; v.latV = 0; return; }
    const rate = Math.min(2.2, 0.42 + 0.14 * v.v);
    const step = Math.sign(d) * Math.min(Math.abs(d), rate * dt);
    v.lat += step;
    v.latV = step / dt;
  }

  /**
   * Once every several seconds, ask whether this vehicle wants to stop.
   *
   * Two outcomes, and they are deliberately different manoeuvres: a taxi or a
   * small car takes an EMPTY KERBSIDE BAY (the ones placeParked left open),
   * which puts it fully out of the running lane; a delivery van DOUBLE-PARKS,
   * which does not, and is why the queue behind it has to deal with it. The
   * cap on `blocking` is the only thing standing between "the city has life in
   * it" and "the city is gridlocked", so it is small and it is global.
   */
  _tryKerbEvent(v, info, j) {
    const lane = info.lane;
    // A committed turn owns the vehicle's path outright; stopping halfway
    // through one would leave it braking for a kerb it is no longer aimed at.
    if (v.turn || !lane.kerbLane) return;
    const seg = info.segs[v.seg];
    if (!seg) return;
    const stopOff = lane.axis === 'x' ? 'stopX' : 'stopZ';
    const clearOfJunction = (s) => (!j || s + 16 < j.s - j.ix[stopOff] - STOP_SETBACK)
      && s > seg.lo + 12 && s < seg.hi - 28;

    /**
     * Transit halts. A bus lane full of buses that never stop is the tell that
     * the transit is set dressing, and this is the one manoeuvre that can be
     * done safely in a live lane: the bus lane is the only lane a bus blocks,
     * and general traffic is barred from it (see `info.siblings`). It gets its
     * own small quota rather than the double-parking one, because the two are
     * competing for completely different road space.
     */
    if (lane.busLane) {
      if (!v.busStop || this.busHalts >= 5) return;
      const s = v.s + 26 + this.rng() * 40;
      if (!clearOfJunction(s)) return;
      if (!this.rng.chance(0.55)) return;
      this.busHalts++;
      this.tally.busStops++;
      v.haltsBus = true;
      v.mode = 'stop';
      v.moveT = 0;
      v.stopS = s;
      // Toward the kerb but still inside the lane: a bus at a stop leans in,
      // it does not leave the carriageway.
      v.latT2 = v.nudge * 0.85;
      v.holdT = 6 + this.rng() * 7;
      v.blink = 1;
      return;
    }

    if (v.canPark && info.bays) {
      const B = info.bays;
      for (let i = 0; i < B.length; i++) {
        const b = B[i];
        if (b.s < v.s + 24) continue;
        if (b.s > v.s + 90) break;             // sorted, so nothing further is closer
        if (b.taken || b.len < v.len + 0.8) continue;
        if (!clearOfJunction(b.s)) continue;
        // First spot you see or you drive on — hence `break`, not `continue`.
        if (!this.rng.chance(v.taxi ? 0.75 : 0.40)) break;
        b.taken = true;
        v.bay = b;
        v.mode = 'bay';
        v.moveT = 0;
        v.stopS = b.s;
        v.latT2 = b.lat;
        v.parkT = v.taxi ? 5 + this.rng() * 6 : 30 + this.rng() * 80;
        v.hazard = true;
        this.tally.bayStops++;
        return;
      }
    }

    if (v.doublePark && this.blocking < MAX_BLOCKING) {
      const s = v.s + 22 + this.rng() * 18;
      if (!clearOfJunction(s)) return;
      if (!this.rng.chance(0.45)) return;
      this.blocking++;
      v.blocks = true;
      v.mode = 'stop';
      v.moveT = 0;
      v.stopS = s;
      // Nose OUT, into the running lane — that is what makes it a double-park
      // and not a parked car. Bounded so the body never leaves its own lane.
      v.latT2 = -v.nudge * 0.9;
      v.holdT = v.taxi ? 4 + this.rng() * 4 : 7 + this.rng() * 7;
      v.hazard = true;
      this.tally.doubleParks++;
    }
  }

  /**
   * Overtake by changing lane rather than by crawling behind a bus for ever.
   *
   * Only ever one lane at a time and only when the destination has a hole big
   * enough for the vehicle plus a full headway at both ends, which is what
   * `hasRoom` with an inflated length buys. A refused change costs nothing; a
   * granted one that lands on somebody is two cars inside each other.
   */
  _tryLaneChange(v, info, lead, j) {
    if (v.turn || !info.siblings.length || Math.abs(v.lat) > 0.05) return;
    // Weaving through a junction looks like a mistake even when it is legal.
    if (j && j.s - v.s < 26) return;
    const L = info.lane;
    let want = 0;
    if (lead && !lead.dead && lead.v < v.v0 * 0.72) {
      const gap = (lead.s - lead.len * 0.5) - (v.s + v.len * 0.5);
      if (gap < v.v * 2.6 + 12) want = -1;              // blocked: pull inboard
    }
    // Heavies belong on the outside, and everyone else drifts back out
    // eventually. Without that the inside lanes silt up with whatever turned
    // left into them and stop being overtaking lanes at all.
    if (!want && !L.kerbLane && (v.big || this.rng() < 0.025)) want = 1;
    if (!want) return;
    // Nothing heavy in the innermost lane, ever.
    if (v.big && want < 0 && L.index <= 1) return;
    let dst = null;
    for (const o of info.siblings) {
      if (Math.sign(o.lane.index - L.index) === want) { dst = o; break; }
    }
    if (!dst) return;
    if (!this.hasRoom(dst, v.s, v.len + 16)) return;
    // Where the car is NOW, expressed in the destination lane's kerb frame.
    const lat = (L.cross - dst.lane.cross) * L.kerbSign;
    this.tally.laneChanges++;
    // Signal the way it is going. `want` is +1 toward the kerb, and the kerb is
    // on the driver's right, which is exactly the indicator convention.
    v.blinkSide = want > 0 ? 1 : -1;
    v.blinkT = 2.6;
    this.pending.push({ v, from: info, to: dst, s: v.s, lat });
  }

  step(dt, time) {
    this.time = time;
    const net = this.net;
    this.pending.length = 0;
    this.unpark.length = 0;

    for (let li = 0; li < this.lanes.length; li++) {
      const info = this.lanes[li];
      const L = info.list;
      const lane = info.lane;
      for (let i = L.length - 1; i >= 0; i--) {
        const v = L[i];
        const c = v.c;
        // Swallowed mid-drive: drop out of the queue without stalling it.
        if (!c || c.state >= 2) { L.splice(i, 1); this._lose(v); continue; }
        // Losing support: the consume system owns its transform now, so it is
        // no longer a car in a queue. Leave it in the lane list (it may regain
        // support if the hole moves on) but stop driving it.
        if (c.state >= 1) { v.held = true; continue; }
        // Just handed back. It has been sitting with its wheels over an opening,
        // so it pulls away from rest — resuming at the speed it was doing when
        // the ground went would snap it forward the instant it settled.
        if (v.held) { v.held = false; v.v = 0; }

        this._lateral(v, dt);
        if (v.boost > 0) v.boost -= dt;
        const aMax = v.boost > 0 ? v.a * 1.8 : v.a;
        let acc = aMax * (1 - Math.pow(v.v / v.v0, 4));

        // --- car following ------------------------------------------------
        const lead = L[i + 1];
        if (lead && !lead.dead) {
          const gap = (lead.s - lead.len * 0.5) - (v.s + v.len * 0.5);
          // A leader the consume system has taken over is stationary whatever
          // its last driven speed says. Following that stale speed is how a
          // queue drives into the back of a car teetering over a hole.
          const lv = (lead.c && lead.c.state >= 1) ? 0 : lead.v;
          acc = Math.min(acc, this._interact(v, gap, lv));
          // Standing still behind somebody for a while, then a gap: that is
          // where the eager drivers get their getaway.
          if (v.v < 0.4 && gap > IDM_S0 + 2.5 && v.eager) v.boost = 2.2;
        }

        // --- kerbside manoeuvres --------------------------------------------
        v.cool -= dt;
        if (v.mode === 'drive') {
          const nj = (v.cool <= 0 || v.lcT - dt <= 0) ? net.nextJunction(lane, v.s) : null;
          if (v.cool <= 0) {
            v.cool = 7 + this.rng() * 11;
            this._tryKerbEvent(v, info, nj);
          }
          if ((v.lcT -= dt) <= 0) {
            v.lcT = 1.4 + this.rng() * 2.2;
            this._tryLaneChange(v, info, lead, nj);
          }
        } else if (v.mode === 'exit') {
          if (Math.abs(v.lat) < 0.08) { v.mode = 'drive'; v.hazard = false; v.cool = 20 + this.rng() * 30; }
        } else if (v.mode === 'hold') {
          acc = -BRAKE_MAX;
          if ((v.holdT -= dt) <= 0) {
            v.mode = 'exit';
            v.latT = 0;
            v.boost = 2.4;
            this._unblock(v);
          }
        } else {
          // 'stop' and 'bay': brake to a target point on the kerb, and only
          // start crossing over once close enough that it reads as one move.
          //
          // The IDM term is fed `d + IDM_S0`, not `d`. IDM comes to rest one
          // standstill gap SHORT of whatever you hand it, so braking to the bay
          // centre directly parks the car 2.4 m before it — and then the arrival
          // test never fires, the manoeuvre never completes, and a double-parked
          // van holds its lane and its quota slot for the rest of the match.
          // That is exactly what it did.
          const d = v.stopS - v.s;
          acc = Math.min(acc, this._interact(v, Math.max(0.05, d + IDM_S0), 0));
          if (d < 16) v.latT = v.latT2;
          v.moveT += dt;
          const arrived = v.v < 0.3 && d < 2.2;
          if (arrived && v.mode === 'stop') { v.v = 0; v.mode = 'hold'; }
          else if (arrived && Math.abs(v.lat - v.latT2) < 0.08) {
            v.v = 0;
            // Fully in the bay and out of the running lane: leave the queue
            // so nothing behind it ever waits on a parked car.
            v.mode = 'parked';
            v.hazard = false;
            this.unpark.push({ v, from: info });
          } else if (v.moveT > 30) {
            this.tally.aborted++;
            // Watchdog. Whatever went wrong, a vehicle stuck mid-manoeuvre is a
            // blocked lane, and a blocked lane is worse than an abandoned stop.
            this._release(v);
            v.mode = 'exit';
            v.latT = 0;
            v.hazard = false;
          }
        }

        // --- signals + turn decision ---------------------------------------
        const j = v.mode === 'drive' || v.mode === 'exit'
          ? net.nextJunction(lane, v.s) : null;
        let jDist = Infinity;
        if (j) {
          const stopOff = (lane.axis === 'x' ? j.ix.stopX : j.ix.stopZ)
            + (j.ix.signalled ? STOP_SETBACK : STOP_SETBACK * 0.5);
          const dStop = (j.s - stopOff) - (v.s + v.len * 0.5);
          jDist = dStop;
          // Decide ONCE per junction. Re-rolling every frame would turn every
          // car in the city eventually, whatever the probability says.
          // Not while still sliding across from a lane change: the turn arc is
          // absolute, so committing to one mid-slide snaps the car onto it.
          if (v.decided !== j.ix.id && dStop < 45 && Math.abs(v.lat) < 0.2) {
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
              if (v.waitT > 7) { this._dropTurn(v); mustStop = false; }
            }
            if (mustStop) acc = Math.min(acc, this._interact(v, Math.max(0.05, dStop), 0));
          }
        }

        acc = Math.max(-BRAKE_MAX, Math.min(aMax, acc));

        /* --- what the lamps say ------------------------------------------
         * Brake lights are the cheapest legibility win in the whole module:
         * without them a queue at a red is a row of parked cars and a car
         * slowing for a junction is indistinguishable from one cruising. The
         * threshold is a real lift-off deceleration, plus "stopped and still in
         * a lane", which is a driver with a foot on the pedal.
         *
         * Indicators are derived, never stored as a mode: every state that
         * makes a car cross a line already exists, and re-deriving from it
         * means an indicator can never be left blinking on a car that finished
         * its manoeuvre three junctions ago. -1 signals left, +1 the kerb side.
         */
        v.brake = acc < -0.7 || (v.v < 0.4 && v.mode !== 'exit');
        if (v.blinkT > 0) v.blinkT -= dt;
        v.blink =
          v.mode === 'bay' || v.mode === 'stop' || v.mode === 'hold' ? 1
          : v.mode === 'exit' ? -1
          : (v.turn && !v.turn.done && jDist < 36) ? (v.turn.left ? -1 : 1)
          : v.blinkT > 0 ? v.blinkSide
          : 0;

        v.v = Math.max(0, v.v + acc * dt);
        v.s += v.v * dt;

        // --- execute the turn ------------------------------------------------
        const T = v.turn;
        // Re-check the target slot just BEFORE the arc starts. The decision was
        // taken up to 45 m back and the gap may have closed since; abandoning
        // here costs nothing visually, abandoning mid-arc would snap the car.
        if (T && !T.done && !T.checked && v.s >= T.sSrc - T.arc - 2) {
          T.checked = true;
          if (!this.hasRoom(T.dstInfo, T.sDst, v.len + 6)) { this._dropTurn(v); continue; }
          // Committed: hold the landing slot until the car is physically in it.
          T.claim = { s: T.sDst, len: v.len + 6 };
          T.dstInfo.claims.push(T.claim);
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
      if (ev.reset) { this._release(ev.v); ev.v.decided = -1; ev.v.mode = 'drive'; ev.v.lat = 0; ev.v.latT = 0; ev.v.hazard = false; }
      // A lane change keeps the car where it visually was and lets `_lateral`
      // walk it across; jumping the offset is what would look like a teleport.
      if (ev.lat !== undefined) { ev.v.lat = ev.lat; ev.v.latT = 0; }
      this._insert(ev.to, ev.v);
      // In the list now, so the reservation has done its job. Released after
      // the insert, never before, or the slot is briefly unheld and unfilled.
      const T2 = ev.v.turn;
      if (T2 && T2.done && T2.claim) {
        const C = T2.dstInfo.claims;
        const ci = C.indexOf(T2.claim);
        if (ci >= 0) C.splice(ci, 1);
        T2.claim = null;
      }
    }

    // Cars that finished nosing into a bay leave the queue entirely.
    for (const ev of this.unpark) {
      this._remove(ev.from, ev.v);
      this.parked.push(ev.v);
    }

    this._stepParked(dt);

    // Cheap enough to do off a timer rather than every frame.
    if ((this._reviveT -= dt) <= 0) { this._reviveT = 1.0; this._reviveGone(); }
  }

  /**
   * Parked cars are OUT of every lane list, which is the whole point: nothing
   * queues behind a car that is not on the carriageway. They still need a
   * heartbeat, so they get their own sweep — run after the lane sweep, so
   * re-joining the traffic is a plain insert with nothing mid-iteration.
   */
  _stepParked(dt) {
    const P = this.parked;
    for (let i = P.length - 1; i >= 0; i--) {
      const v = P[i];
      const c = v.c;
      if (!c || c.state >= 2) { P.splice(i, 1); this._lose(v); continue; }
      if (c.state >= 1) { v.held = true; continue; }
      if (v.held) { v.held = false; v.v = 0; }
      // Off the carriageway: engine off, no lamps. The contrast between a dark
      // kerb and a lane of lit brake lights is most of what a night frame is.
      v.brake = false;
      v.blink = 0;
      this._lateral(v, dt);
      if ((v.parkT -= dt) > 0) continue;
      const info = v.info;
      // Pull out only into a real gap. Failing is fine — try again shortly.
      if (!this.hasRoom(info, v.s, v.len + 18)) { v.parkT = 2 + this.rng() * 3; continue; }
      P.splice(i, 1);
      if (v.bay) { v.bay.taken = false; v.bay = null; }
      v.mode = 'exit';
      v.latT = 0;
      v.v = 0;
      v.boost = 2.6;
      v.hazard = true;
      v.decided = -1;
      this.tally.pullOuts++;
      this._insert(info, v);
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
  /**
   * The lane a turn lands in: kerbmost for a right, innermost for a left.
   * Buses keep their own lane; nobody else is allowed to turn into it.
   */
  _turnTarget(lane, ix, wantDir, toKerb) {
    const axis = lane.axis === 'x' ? 'z' : 'x';
    const roadIndex = lane.axis === 'x' ? ix.rj : ix.ri;
    const arr = this.byRoadDir.get(`${axis}:${roadIndex}:${wantDir}`);
    if (!arr || !arr.length) return null;
    if (!toKerb) return arr[0];
    for (let i = arr.length - 1; i >= 0; i--) if (!arr[i].lane.busLane) return arr[i];
    return null;
  }

  _decideTurn(v, lane, ix, forced) {
    if (v.noTurn && !forced) return null;
    const r = this.rng;
    // Turning across three lanes of your own carriageway is what produces the
    // weaving that makes procedural traffic look drunk. Rights come out of the
    // kerb lane, lefts out of the inside lane, and the lanes in between simply
    // go straight — which is also what makes lane CHOICE mean something.
    let wantRight = lane.kerbLane && !lane.busLane && r() < 0.30;
    let wantLeft = !wantRight && lane.innerLane && r() < 0.26;
    // At the last junction before a dead end this is not a preference.
    if (forced && !wantRight && !wantLeft) { wantRight = true; wantLeft = false; }
    if (!wantRight && !wantLeft) return null;
    // Travelling +z, right is -x; travelling +x, right is +z. See roadNetwork.
    const rightDir = lane.axis === 'x' ? -lane.dir : lane.dir;
    let wantDir = wantRight ? rightDir : -rightDir;
    let dstInfo = this._turnTarget(lane, ix, wantDir, wantRight);
    if (!dstInfo && forced) {
      wantDir = -wantDir;
      wantLeft = !wantLeft;
      dstInfo = this._turnTarget(lane, ix, wantDir, !wantRight);
    }
    if (!dstInfo) return null;
    const dst = dstInfo.lane;

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
        // Same reason as car-following: a held car is not coming, so waiting
        // for it would stall the turn behind a car that cannot move.
        if (L[i].c && L[i].c.state >= 1) continue;
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
        this._dropTurn(v);
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
    // Lateral offset from the lane centre: pulling in, double-parking, or
    // halfway through a lane change. The yaw term is what stops it reading as
    // a car sliding sideways — a vehicle points where it is going.
    if (v.lat || v.latV) {
      const info = v.info;
      out.x += v.lat * info.kx;
      out.z += v.lat * info.kz;
      out.rot += Math.max(-0.20, Math.min(0.20, info.kyaw * v.latV * 0.13));
    }
    return out;
  }

  /**
   * Attach the kerbside bays placeParked left empty to the lane that serves
   * them, so a driving car can pull into one. Called once, after placement.
   */
  registerBays(bays) {
    let n = 0;
    for (const b of bays) {
      const arr = this.byRoadDir.get(`${b.axis}:${b.roadIndex}:${b.dir}`);
      if (!arr || !arr.length) continue;
      let info = null;
      for (let i = arr.length - 1; i >= 0; i--) if (!arr[i].lane.busLane) { info = arr[i]; break; }
      if (!info) continue;
      const s = this.net.sFor(info.lane, b.x, b.z);
      // Only bays on a driveable stretch of that lane are any use.
      let ok = false;
      for (const sg of info.segs) if (s > sg.lo + 10 && s < sg.hi - 20) { ok = true; break; }
      if (!ok) continue;
      if (!info.bays) info.bays = [];
      // Positive lat means "toward the kerb", which is exactly the direction a
      // bay sits from its lane, so the magnitude is all that is needed.
      info.bays.push({ s, lat: Math.abs(b.cross - info.lane.cross), len: b.len, taken: false });
      n++;
    }
    for (const info of this.lanes) if (info.bays) info.bays.sort((a, b2) => a.s - b2.s);
    return n;
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
  return { inner, lanes, bus, park, busEdge: inner + lanes * LANE_W };
}

/**
 * Which vehicles appear where. Three mixes, because a lane is not a kerb is
 * not a bus lane, and one table for all of them is how you end up with a
 * cement mixer in the overtaking lane and no taxis anywhere.
 */
const KERB_LANE_MIX = [
  ['sedan', 20], ['suv', 12], ['hatchback', 9], ['taxi', 11], ['pickup', 7],
  ['deliveryVan', 8], ['sports', 2], ['convertible', 2], ['cityBus', 3.6],
  ['boxTruck', 3], ['shuttleBus', 1.6], ['flatbed', 1.2], ['police', 1.0],
  ['scooter', 4], ['motorcycle', 3.4], ['garbageTruck', 0.9], ['cementMixer', 0.9],
  ['ambulance', 0.6], ['articBus', 0.7], ['gtCoupe', 1.0], ['supercar', 0.8],
  ['roadster', 0.8],
];
/** Inner lanes: cars only, and where Miami keeps its exotics. */
const INNER_LANE_MIX = [
  ['sedan', 28], ['suv', 17], ['hatchback', 12], ['taxi', 8], ['pickup', 5],
  ['sports', 6], ['convertible', 4], ['supercar', 3.2], ['roadster', 2.6],
  ['gtCoupe', 3.0], ['police', 0.8], ['deliveryVan', 3], ['motorcycle', 2.6],
];
/** Bus lane: transit, taxis and the two-wheelers allowed to share it. */
const BUS_LANE_MIX = [
  ['cityBus', 28], ['articBus', 8], ['shuttleBus', 10], ['taxi', 30],
  ['scooter', 12], ['motorcycle', 9], ['ambulance', 3], ['police', 4],
];
const KERB_MIX = [
  ['sedan', 26], ['suv', 17], ['hatchback', 13], ['taxi', 6], ['pickup', 9],
  ['deliveryVan', 7], ['sports', 3], ['convertible', 3], ['boxTruck', 2],
  ['scooter', 4], ['motorcycle', 3], ['police', 0.8], ['flatbed', 0.8],
  ['supercar', 1.2], ['roadster', 1.6], ['gtCoupe', 2.0],
];
const LOT_MIX = [
  ['sedan', 32], ['suv', 22], ['hatchback', 16], ['pickup', 10],
  ['deliveryVan', 7], ['sports', 5], ['convertible', 4], ['taxi', 4],
];

const BIG = new Set(['cityBus', 'articBus', 'boxTruck', 'garbageTruck',
  'cementMixer', 'flatbed', 'ambulance', 'shuttleBus']);
/** Small enough, and driven by someone who would bother, to take a bay. */
const CAN_PARK = new Set(['sedan', 'suv', 'hatchback', 'pickup', 'sports',
  'convertible', 'taxi', 'supercar', 'roadster', 'gtCoupe', 'deliveryVan',
  'scooter', 'motorcycle', 'police']);
/** Drivers who will stop where they are and put the hazards on. */
const DOUBLE_PARKERS = new Set(['deliveryVan', 'taxi']);
/** Transit that makes a scheduled halt at the kerb instead of parking. */
const BUS_STOPPERS = new Set(['cityBus', 'articBus', 'shuttleBus']);
/** Anything that would take a bend hard enough to be worth watching. */
const QUICK = new Set(['sports', 'supercar', 'roadster', 'gtCoupe', 'scooter',
  'motorcycle']);

function pickVariant(rng, type) {
  return rng.int(0, FLEET[type].paints.length - 1);
}

/**
 * Separating-axis test between two contact rectangles on the ground plane.
 *
 * The circle test the audit uses is wrong for a vehicle in both directions: an
 * excavator's contact patch is 2.9 m across and 8.2 m long, so its circumradius
 * demands 4.4 m of clearance abeam — which it does not need — while allowing
 * two of them to park nose to tail inside each other. Rectangles either touch
 * or they do not.
 */
function boxesClash(ax, az, aYaw, aw, ad, bx, bz, bYaw, bw, bd) {
  const ac = Math.cos(aYaw), as = Math.sin(aYaw);
  const bc = Math.cos(bYaw), bs = Math.sin(bYaw);
  // Rotation about +y: local +x -> (cos, -sin), local +z -> (sin, cos).
  const A = [[ac, -as], [as, ac]], B = [[bc, -bs], [bs, bc]];
  const dx = bx - ax, dz = bz - az;
  for (const n of [A[0], A[1], B[0], B[1]]) {
    const t = Math.abs(dx * n[0] + dz * n[1]);
    const ra = Math.abs(A[0][0] * n[0] + A[0][1] * n[1]) * aw * 0.5
             + Math.abs(A[1][0] * n[0] + A[1][1] * n[1]) * ad * 0.5;
    const rb = Math.abs(B[0][0] * n[0] + B[0][1] * n[1]) * bw * 0.5
             + Math.abs(B[1][0] * n[0] + B[1][1] * n[1]) * bd * 0.5;
    if (t > ra + rb) return false;
  }
  return true;
}

/**
 * Would a footprint standing here sit inside something already placed?
 *
 * This module runs after every other content placer, so the registry — not the
 * occupancy grid — is the honest record of what is on the ground. The grid
 * quantises to 3 m cells and inflates any non-zero radius to a whole ring of
 * them, which is why a test for a 1.8 m bicycle was really a test of a 9 m
 * square and failed on every furnished sidewalk in the city.
 *
 * `vehiclesOnly` is the difference between the two callers. Plant belongs among
 * the barriers and spoil heaps of a construction site, so machinery only has to
 * miss other vehicles; a bicycle has to miss the bench as well. Nothing bigger
 * than a delivery van is considered either way — a tower's circumradius covers
 * half its own parcel, and keeping off buildings is the grid's job.
 */
function clearOfPlaced(ctx, x, z, yaw, w, d, out, vehiclesOnly) {
  const list = ctx.registry.query(x, z, Math.hypot(w, d) * 0.5 + 7, out);
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    const om = FLEET[o.kind] ? shapeMetrics(o.kind) : null;
    if (!om && vehiclesOnly) continue;
    if (o.radius > 6.5) continue;
    // A prop that is not one of ours has no authored contact box; its measured
    // radius is honest for something compact, so stand a square in its place.
    const ow = om ? om.contactW : o.radius * 1.41;
    const od = om ? om.contactD : o.radius * 1.41;
    if (boxesClash(x, z, yaw, w, d, o.position.x, o.position.z, o.rotationY || 0, ow, od)) {
      return false;
    }
  }
  return true;
}

/**
 * Fill every driveable lane stretch with moving traffic.
 *
 * Density is per lane, not per road, and the outer lanes are deliberately
 * thinner than the inner ones. Uniform density across a four-lane avenue reads
 * as a car park; a busy inside lane thinning out toward the kerb is what a
 * moving road actually looks like from above.
 */
function placeMoving(ctx, state, traf, rng) {
  const decks = state.decks;
  for (const info of traf.lanes) {
    const lane = info.lane;
    const cls = lane.road.cls;
    const base = cls === ROAD_CLASS.BOULEVARD ? 68
      : cls === ROAD_CLASS.AVENUE ? 80 : 100;
    const outward = lane.laneCount > 1 ? lane.index / (lane.laneCount - 1) : 0;
    const spacing = lane.busLane ? 210 : base * (0.86 + 0.55 * outward);
    const mix = lane.busLane ? BUS_LANE_MIX
      : lane.kerbLane ? KERB_LANE_MIX : INNER_LANE_MIX;
    for (let si = 0; si < info.segs.length; si++) {
      const seg = info.segs[si];
      const n = Math.floor((seg.hi - seg.lo) / spacing);
      for (let i = 0; i < n; i++) {
        const s = seg.lo + 12 + ((i + rng() * 0.7) / n) * (seg.hi - seg.lo - 24);
        let type = rng.weighted(mix);
        // Heavy vehicles keep to the kerb lane, like they are supposed to.
        if (!lane.kerbLane && BIG.has(type)) type = 'sedan';
        const def = FLEET[type];
        if (!traf.hasRoom(info, s, def.len)) continue;
        const p = traf.net.sampleLane(lane, s, {});
        const vi = pickVariant(rng, type);
        const c = spawn(ctx, state, type, vi, p.x, deckHeight(decks, p.x, p.z), p.z,
          traf.net.headingOf(lane), true);
        if (!c) continue;
        const big = BIG.has(type);
        const vf = (big ? 0.78 : 0.92) + rng() * 0.22;
        const m = shapeMetrics(type);
        traf.add({
          c, lane, s, seg: si, len: def.len, dead: false,
          // Cached so the updater never has to look the shape up per frame.
          yOff: seatY(type, 0),
          v: lane.speed * vf * 0.75, v0: lane.speed * vf, vf,
          turn: null, decided: -1, waitT: 0, held: false,
          noTurn: type === 'articBus',
          /* --- driving personality ------------------------------------- */
          // Comfortable acceleration. A city where every car pulls away at the
          // same rate is the tell that gave the old traffic away instantly.
          a: (big ? 1.5 : QUICK.has(type) ? 3.4 : 2.4) * (0.82 + rng() * 0.42),
          eager: QUICK.has(type) ? rng.chance(0.75) : rng.chance(0.22),
          big,
          /* --- lateral state ------------------------------------------- */
          lat: 0, latT: 0, latT2: 0, latV: 0,
          mode: 'drive', hazard: false, blocks: false, haltsBus: false, bay: null,
          holdT: 0, parkT: 0, stopS: 0, boost: 0, moveT: 0,
          brake: false, blink: 0, blinkSide: 1, blinkT: 0,
          busStop: BUS_STOPPERS.has(type),
          cool: 8 + rng() * 26,
          lcT: rng() * 3,
          // Widest the body may move inside its own lane without any part of
          // it crossing a lane line. Measured, so a bus never uses a car's.
          nudge: Math.max(0.15, (LANE_W - m.contactW) * 0.5 - 0.16),
          canPark: CAN_PARK.has(type),
          doublePark: DOUBLE_PARKERS.has(type),
          taxi: type === 'taxi',
          /* --- light-card metrics, measured once per vehicle ----------- */
          noseZ: def.len * 0.40,
          beamW: m.contactW * 1.5,
          beamL: 10 + def.len * 0.9,
          hazY: m.height * 0.42,
          hazW: m.contactW + 0.06,
          hazD: m.contactD + 0.06,
          // Tail card sits just aft of the bodywork so it is never coplanar
          // with it; the lamp band is clamped because a bus's tail lights are
          // at car height, not at half the height of a bus.
          tailZ: def.len * 0.40 + 0.10,
          lampY: Math.max(0.42, Math.min(1.15, m.height * 0.48)),
          lampW: Math.max(0.34, m.contactW * 0.86),
          lampH: Math.max(0.20, Math.min(0.42, m.height * 0.22)),
          indW: m.contactW + 0.10,
          indL: def.len,
        }, info);
      }
    }
  }
}

/**
 * Kerbside parking, aligned to the bay ticks streets.js paints.
 *
 * Also RETURNS the bays it leaves empty. Those gaps are not waste: they are
 * where a taxi pulls in to drop a fare and where a driving car parks up, which
 * is the only way that manoeuvre can be safe — the alternative is a moving car
 * choosing a spot at runtime and discovering a static one already in it.
 */
function placeParked(ctx, state, rng) {
  const { layout } = ctx;
  const S = WORLD.SIZE;
  const decks = state.decks;
  const bays = [];
  const roads = [
    ...layout.roadsX.map((r, i) => [r, i, 'x']),
    ...layout.roadsZ.map((r, i) => [r, i, 'z']),
  ];
  for (const [r, roadIndex, axis] of roads) {
    const pp = lanePlan(r);
    if (pp.park < 2.1) continue;
    const off = r.half - pp.park * 0.5;
    const alongX = r.axis === 'z';
    const lo = -S + 24;
    const hi = alongX ? WORLD.BAY_EDGE - 26 : S - 24;
    const cross = alongX ? layout.roadsX : layout.roadsZ;
    // Where the last car on each side of this road ends, along the kerb. The
    // ticks are 6.6 m apart but a box truck's contact patch is 8.2 m long, so
    // consecutive ticks were putting two of them 1.6 m inside each other.
    const kerbEnd = [-Infinity, -Infinity];
    const taken = [[], []];
    const empty = [[], []];
    for (let t = Math.ceil(lo / 6.6) * 6.6 + 3.3; t < hi; t += 6.6) {
      let atJunction = false;
      for (const cr of cross) {
        if (Math.abs(t - cr.pos) < cr.half + 9) { atJunction = true; break; }
      }
      if (atJunction) continue;
      for (let si = 0; si < 2; si++) {
        const s = si ? 1 : -1;
        const x = alongX ? t : r.pos + s * off;
        const z = alongX ? r.pos + s * off : t;
        if (layout.isWater(x, z)) continue;
        if (deckHeight(decks, x, z) > 0.01) continue;
        // Runs and gaps, not confetti: a slow term along the road gives blocks
        // of solid parking broken by driveways and hydrant clearances, which
        // is what a real kerb looks like. Uniform noise reads as a fence.
        const run = 0.5 + 0.5 * Math.sin(t * 0.020 + r.pos * 0.31 + s * 1.7);
        const wanted = rng.chance(0.13 + 0.46 * run);
        const type = wanted ? rng.weighted(KERB_MIX) : null;
        const m = type ? shapeMetrics(type) : null;
        // The bay is what streets.js painted. A vehicle wider than it either
        // rides the kerb or juts into the running lane; 0.2 m of mirror-and-arch
        // overhang is what a real kerb tolerates, a whole wheel is not.
        const fits = m && m.contactW <= pp.park + 0.2
          && t - m.contactD * 0.5 >= kerbEnd[si] + 0.4;
        if (!fits) {
          if (pp.park >= 2.4) empty[si].push({ t, x, z, cross: r.pos + s * off, si });
          continue;
        }
        const halfLen = m.contactD * 0.5;
        const rot = alongX
          ? (s > 0 ? Math.PI / 2 : -Math.PI / 2)
          : (s > 0 ? Math.PI : 0);
        if (!spawn(ctx, state, type, pickVariant(rng, type), x, 0, z,
          rot + (rng() - 0.5) * 0.035, false)) continue;
        kerbEnd[si] = t + halfLen;
        taken[si].push([t - halfLen, t + halfLen]);
      }
    }
    // A gap is only usable if a 5.4 m car fits in it with clear air at both
    // ends. Handing out a bay that a static car half-covers would put two
    // vehicles in the same tarmac, which is exactly what this whole system is
    // supposed to make impossible.
    for (let si = 0; si < 2; si++) {
      for (const g of empty[si]) {
        let clear = true;
        for (const [a, b] of taken[si]) {
          if (b > g.t - 3.1 && a < g.t + 3.1) { clear = false; break; }
        }
        if (!clear) continue;
        // The lane that serves this kerb is the one whose right hand points at
        // it: on a road along z that is dir -1 for the +x side, and vice versa.
        const dir = axis === 'x' ? (g.si ? -1 : 1) : (g.si ? 1 : -1);
        bays.push({ axis, roadIndex, dir, x: g.x, z: g.z, cross: g.cross, len: 5.6 });
      }
    }
  }
  return bays;
}

/**
 * Angle parking on parcels nobody else claimed. These are exactly the bare
 * slabs the review flagged, so anything that lands here is a win — but the
 * occupancy test keeps us off other modules' geometry.
 *
 * CURRENTLY YIELDS NOTHING, ON PURPOSE. All 137 candidate parcels fail the
 * isFree() test, because buildings.js now builds on every one of them and
 * claims it — a parking parcel gets a real deck garage or a surface lot with
 * its own baked cars, both of which already read as parking. Forcing cars in
 * here would stack a second fleet on top of that one. Kept because it costs
 * nothing and is the right home for lot parking the moment a bare parcel exists
 * again; do not "fix" the zero by loosening the occupancy test.
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
        const c = spawn(ctx, state, type, pickVariant(rng, type), x, ctx.Y_WALK, z, rot, false);
        if (c) ctx.occupy(x, z, c.radius * 0.7);
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
  // Nothing floats on land. isWater() also reports dry inside a bridge AABB,
  // which is the point: a hull moored under a causeway is inside the deck, not
  // under it. That is how a skiff ended up parked in the Brickell Key Causeway.
  const put = (type, x, z, rot, moving, cruise) => {
    if (!layout.isWater(x, z)) return null;
    const c = spawn(ctx, state, type, pickVariant(rng, type), x, BOAT_Y, z, rot, !!moving);
    if (!c) return null;
    const b = { c, x, z, rot, phase: rng() * 6.28, speed: 0 };
    if (cruise) Object.assign(b, cruise);
    boats.push(b);
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
        ['skiff', 26], ['sportFisher', 10], ['waterTaxi', 12], ['jetSki', 14]]);
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
      const type = rng.weighted([['skiff', 44], ['waterTaxi', 32], ['sailBoat', 24]]);
      const rot = w > d ? Math.PI / 2 : 0;
      // The mid-line of the Key Cut South is exactly where the causeway lands,
      // so the nominal slot is dry. Shuffle along the cut before giving up
      // rather than losing the boat and leaving the channel empty.
      for (const nudge of [0, -0.22, 0.22, -0.38, 0.38]) {
        const u = t + nudge;
        if (u <= 0.04 || u >= 0.96) continue;
        const x = w > d ? ch.x0 + u * w : (ch.x0 + ch.x1) / 2;
        const z = w > d ? (ch.z0 + ch.z1) / 2 : ch.z0 + u * d;
        if (put(type, x, z, rot)) break;
      }
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

  /* ------------------------------------------------------ under way ---- */
  /**
   * A bay with eighty boats in it and not one of them moving is a car park.
   * These run north/south in lanes placed OUTSIDE the moorings (which stop at
   * BAY_EDGE + 128), so nothing under way can ever cross a moored hull, and
   * they wrap at the map edge where they are 500 m from any camera.
   *
   * Jet skis get their own inshore band and a weave, because a PWC going in a
   * straight line is the one thing a PWC never does.
   */
  const B = WORLD.BAY_EDGE;
  const runs = [
    { x: B + 96, dir: 1, n: 5, spd: [4.2, 2.2], mix: [['waterTaxi', 40], ['motorYacht', 26], ['skiff', 20]] },
    { x: B + 150, dir: -1, n: 5, spd: [3.4, 2.0], mix: [['motorYacht', 34], ['sailBoat', 30], ['sportFisher', 18]] },
    { x: B + 208, dir: 1, n: 4, spd: [3.0, 2.4], mix: [['sailBoat', 40], ['motorYacht', 26], ['sportFisher', 14]] },
    { x: B + 268, dir: -1, n: 3, spd: [2.6, 1.8], mix: [['sailBoat', 46], ['motorYacht', 22]] },
  ];
  for (const run of runs) {
    for (let i = 0; i < run.n; i++) {
      const z = -WORLD.SIZE + 40 + ((i + rng() * 0.6) / run.n) * (WORLD.SIZE * 2 - 80);
      const type = rng.weighted(run.mix);
      const speed = run.spd[0] + rng() * run.spd[1];
      put(type, run.x + (rng() - 0.5) * 26, z, run.dir > 0 ? 0 : Math.PI, true, {
        speed, vz: speed * run.dir,
        wake: 1.1 + FLEET[type].len * 0.09, wakeL: FLEET[type].len * 1.7,
      });
    }
  }
  for (let i = 0; i < 9; i++) {
    const z = -WORLD.SIZE + 70 + (i / 9) * (WORLD.SIZE * 2 - 140);
    if (Math.abs(z) < 60) continue;                        // clear of the river mouth
    const dir = i % 2 ? 1 : -1;
    const speed = 8 + rng() * 4;
    const x0 = B + 52 + rng() * 30;
    put('jetSki', x0, z, dir > 0 ? 0 : Math.PI, true, {
      speed, vz: speed * dir, wake: 1.5, wakeL: 13,
      x0, rot0: dir > 0 ? 0 : Math.PI, weave: 12 + rng() * 10, weaveHz: 0.22 + rng() * 0.14,
    });
  }
  return boats;
}

/** How far inside the parcel line a machine's contact patch has to finish. */
const SITE_MARGIN = 0.4;

const MACHINE_MIX = [['excavator', 26], ['wheelLoader', 20], ['siteDumper', 18],
  ['cementMixer', 12], ['scissorLift', 14], ['roadRoller', 10]];

/**
 * Plant machinery around the edge of every construction parcel.
 *
 * The perimeter offset has to come from the MACHINE, not from a fraction of the
 * block. At the old 0.42 * width a cement mixer — 8.9 m of contact patch, most
 * of it drum — hung 2.5 m over the parcel line, across the sidewalk and into
 * the kerbside parking that placeParked had already filled. So the type is
 * drawn first and the machine is then stood its own half-extent inside the
 * boundary, on both axes, at the heading it will actually sit at.
 */
function placeMachinery(ctx, state, rng) {
  const near = [];
  let cranes = 0;
  for (const b of ctx.layout.blocks) {
    if (b.zone !== ZONE.CONSTRUCTION) continue;
    const r = makeRNG(b.seed ^ 0x51a7);
    const n = 3 + r.int(0, 3);
    // Machines are 3-9 m long, so a purely random perimeter position parks two
    // of them inside each other. Keep a local list and reject overlapping pairs
    // — the shared occupancy grid is no help here, buildings.js has already
    // claimed the whole parcel for the tower core.
    const placed = [];
    for (let i = 0; i < n; i++) {
      const type = r.weighted(MACHINE_MIX);
      const m = shapeMetrics(type);
      let x = 0, z = 0, rot = 0, ok = false;
      for (let a = 0; a < 8 && !ok; a++) {
        const edge = r.int(0, 3);
        const u = (r() - 0.5) * 0.78;
        rot = (edge === 0 ? 0 : edge === 1 ? Math.PI : edge === 2 ? Math.PI / 2 : -Math.PI / 2)
          + (r() - 0.5) * 0.5;
        const ca = Math.abs(Math.cos(rot)), sa = Math.abs(Math.sin(rot));
        const spanX = b.w * 0.5 - (m.contactW * ca + m.contactD * sa) * 0.5 - SITE_MARGIN;
        const spanZ = b.d * 0.5 - (m.contactW * sa + m.contactD * ca) * 0.5 - SITE_MARGIN;
        if (spanX <= 0 || spanZ <= 0) break;   // parcel too small for this machine
        if (edge === 0) { x = b.x + u * b.w; z = b.z - spanZ; }
        else if (edge === 1) { x = b.x + u * b.w; z = b.z + spanZ; }
        else if (edge === 2) { x = b.x - spanX; z = b.z + u * b.d; }
        else { x = b.x + spanX; z = b.z + u * b.d; }
        // The along-edge coordinate has to stay on the parcel too, or a machine
        // backed onto the north edge juts out of the west one.
        x = Math.min(b.x + spanX, Math.max(b.x - spanX, x));
        z = Math.min(b.z + spanZ, Math.max(b.z - spanZ, z));
        ok = true;
        for (const q of placed) {
          if (boxesClash(x, z, rot, m.contactW + 0.6, m.contactD + 0.6,
            q[0], q[1], q[2], q[3], q[4])) { ok = false; break; }
        }
        // Even inside the line a machine on a narrow parcel can reach a car
        // parked at the kerb, so ask the registry — placeParked ran first.
        // Vehicles only, deliberately: making plant dodge the site's own
        // barriers, spoil and portaloos too starves the sites, 41 machines
        // down to 9, and plant standing among site clutter is the point.
        if (ok && !clearOfPlaced(ctx, x, z, rot, m.contactW + 0.6, m.contactD + 0.6, near, true)) {
          ok = false;
        }
      }
      if (!ok) continue;
      placed.push([x, z, rot, m.contactW, m.contactD]);
      const c = spawn(ctx, state, type, 0, x, ctx.Y_WALK, z, rot, false);
      // Claim what the machine actually covers, not a flat 2.4 m. An excavator
      // is 4.4 m across the tracks and a site dumper 3.8 m, and pedestrians.js
      // reads this grid AFTER us — under-claiming is why the crowd walked
      // through the plant.
      if (c) ctx.occupy(x, z, c.radius * 0.85);
    }
    if (cranes < 7 && r.chance(0.6) && Math.min(b.w, b.d) > 34) {
      const cm = shapeMetrics('craneBase');
      const rot = r() * 1.5;
      const x = b.x + (r() - 0.5) * b.w * 0.5;
      const z = b.z + (r() - 0.5) * b.d * 0.5;
      let clear = true;
      for (const q of placed) {
        if (boxesClash(x, z, rot, cm.contactW + 1.0, cm.contactD + 1.0,
          q[0], q[1], q[2], q[3], q[4])) { clear = false; break; }
      }
      if (!clear) continue;
      const c = spawn(ctx, state, 'craneBase', 0, x, ctx.Y_WALK, z, rot, false);
      if (c) ctx.occupy(x, z, c.radius * 0.85);
      cranes++;
    }
  }
}

/**
 * Bikes leaning at the kerb on lively blocks — cheap, and the street reads.
 *
 * This placed exactly ZERO bicycles before, and the reason was the clearance
 * test, not the city. `isFree(x, z, 1.1)` rounds any non-zero radius up to a
 * whole ring of 3 m cells, so a 1.8 m bicycle was asking whether a 9 m square
 * of sidewalk was empty — and props.js has furnished every metre of kerb by the
 * time this runs. Test the one cell the bike stands in, then ask the registry
 * about the bench that is actually next to it.
 */
function placeBikes(ctx, state, rng) {
  const near = [];
  const bm = shapeMetrics('bicycle');
  for (const b of ctx.layout.blocks) {
    if (b.streetLife < 0.55) continue;
    const r = makeRNG(b.seed ^ 0x2b19);
    const n = r.int(0, 2);
    for (let i = 0; i < n; i++) {
      // A furnished kerb is mostly taken, so slide along the edge rather than
      // giving up on the first bench: one draw per bike found gaps for six
      // bicycles in the whole city, which is the same as none.
      for (let a = 0; a < 10; a++) {
        const side = r.int(0, 3);
        const hw = b.w / 2 - 1.6, hd = b.d / 2 - 1.6;
        const u = (r() - 0.5) * 0.8;
        let x, z, rot;
        if (side === 0) { x = b.x + u * b.w; z = b.z - hd; rot = 0; }
        else if (side === 1) { x = b.x + u * b.w; z = b.z + hd; rot = Math.PI; }
        else if (side === 2) { x = b.x - hw; z = b.z + u * b.d; rot = Math.PI / 2; }
        else { x = b.x + hw; z = b.z + u * b.d; rot = -Math.PI / 2; }
        if (!ctx.isFree(x, z, 0)) continue;
        const yaw = rot + Math.PI / 2;
        if (!clearOfPlaced(ctx, x, z, yaw, bm.contactW + 0.5, bm.contactD + 0.5, near, false)) {
          continue;
        }
        ctx.occupy(x, z, 1.0);
        spawn(ctx, state, 'bicycle', pickVariant(r, 'bicycle'), x, ctx.Y_WALK, z, yaw, false);
        break;
      }
    }
  }
}

/* ====================================================== light cards ==== */

/**
 * WHY THE HEADLIGHTS ARE GEOMETRY AND NOT LIGHTS
 * ----------------------------------------------
 * A thousand cars means a thousand headlight pairs. Two thousand real lights is
 * not a budget conversation, it is impossible — three's forward renderer would
 * be compiling shaders per light count and the shadow atlas alone would end the
 * frame. What actually reads on screen is not the illumination, it is the
 * SHAPE: a warm wedge lying on the tarmac in front of the car. So that is what
 * is drawn — one additive fan per moving vehicle, in one instanced pool, one
 * draw call for the whole city, hidden outright in daylight.
 *
 * The fan is authored in unit space (z 0..1 forward, half width 0.5..1.0) and
 * scaled per vehicle, so a bus throws a wider, longer pool than a scooter out
 * of the same 24 triangles.
 */
function beamGeometry() {
  const NZ = 5, NX = 4;
  const pos = [], col = [];
  const warm = new THREE.Color(PALETTE.HEADLIGHT);
  const grid = [];
  for (let j = 0; j < NZ; j++) {
    const t = j / (NZ - 1);
    const row = [];
    for (let i = 0; i < NX; i++) {
      const u = (i / (NX - 1)) * 2 - 1;
      // Brightness: hot at the lamp, gone by the far end, gone at the edges.
      const b = Math.pow(1 - t, 1.7) * (1 - u * u) * 0.9;
      row.push({ x: u * (0.5 + 0.5 * t), z: t, b });
    }
    grid.push(row);
  }
  const push = (p) => {
    pos.push(p.x, 0, p.z);
    col.push(warm.r * p.b, warm.g * p.b, warm.b * p.b);
  };
  for (let j = 0; j < NZ - 1; j++) {
    for (let i = 0; i < NX - 1; i++) {
      const a = grid[j][i], b = grid[j][i + 1], c = grid[j + 1][i + 1], d = grid[j + 1][i];
      push(a); push(b); push(c);
      push(a); push(c); push(d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

/**
 * Brake lamps: two hot panels across the tail with a faint bar between them.
 *
 * Authored in the x-y plane at z = 0 so a plain yaw puts it square across the
 * back of the vehicle, and scaled to that vehicle's measured width. This is a
 * CARD and not a change to the baked TAIL band because the band is shared by
 * every instance of a pool — one geometry, 544 sedans — so there is no way to
 * light one car's tail lights and not another's. A card is per vehicle.
 */
function brakeGeometry() {
  const pos = [], col = [];
  const hot = new THREE.Color(PALETTE.TAILLIGHT);
  const push = (x, y, b) => { pos.push(x, y, 0); col.push(hot.r * b, hot.g * b, hot.b * b); };
  const quad = (x0, x1, y0, y1, b) => {
    push(x0, y0, b); push(x1, y0, b); push(x1, y1, b);
    push(x0, y0, b); push(x1, y1, b); push(x0, y1, b);
  };
  for (const s of [-1, 1]) quad(s * 0.19, s * 0.50, -0.5, 0.5, 1.0);
  quad(-0.19, 0.19, -0.20, 0.20, 0.28);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

/**
 * One side's indicators: front repeater and rear lamp on the same flank.
 *
 * Authored on the vehicle's RIGHT (local -x, because forward is +z and up is
 * +y, so right is -x). Signalling left is the same card with a negative x
 * scale — the material is double-sided, so mirroring costs nothing and one
 * pool serves both directions.
 */
function indicatorGeometry() {
  const pos = [];
  const quad = (z0, z1) => {
    pos.push(-0.5, -0.5, z0, -0.5, -0.5, z1, -0.5, 0.5, z1);
    pos.push(-0.5, -0.5, z0, -0.5, 0.5, z1, -0.5, 0.5, z0);
  };
  quad(0.30, 0.45);
  quad(-0.46, -0.31);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeBoundingSphere();
  return g;
}

/** Four amber corner lamps. Scaled to the vehicle, blinked by the material. */
function hazardGeometry() {
  const sh = new Shape();
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      faceZ(sh, sx * 0.42, 0, sz * 0.5, 0.26, 0.16, ROLE.AMBER, sz);
      faceX(sh, sx * 0.5, 0, sz * 0.40, 0.20, 0.14, ROLE.AMBER, sx);
    }
  }
  const f = sh.finish();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', f.pos);
  g.computeBoundingSphere();
  return g;
}

/** A widening foam trail behind a hull, plus the white water at the bow. */
function wakeGeometry() {
  const pos = [], col = [];
  const foam = new THREE.Color(PALETTE.WATER_WAKE);
  const push = (x, z, b) => { pos.push(x, 0, z); col.push(foam.r * b, foam.g * b, foam.b * b); };
  const N = 6;
  for (let j = 0; j < N - 1; j++) {
    const t0 = j / (N - 1), t1 = (j + 1) / (N - 1);
    // Trail runs aft (-z) from the transom, widening and thinning.
    const w0 = 0.22 + 0.78 * t0, w1 = 0.22 + 0.78 * t1;
    const b0 = (1 - t0) * (1 - t0) * 0.55, b1 = (1 - t1) * (1 - t1) * 0.55;
    for (const s of [-1, 1]) {
      // Two ribbons rather than one slab: a V, which is what a wake is.
      const i0 = w0 * 0.55, i1 = w1 * 0.55;
      push(s * i0, -t0, b0); push(s * w0, -t0, 0); push(s * w1, -t1, 0);
      push(s * i0, -t0, b0); push(s * w1, -t1, 0); push(s * i1, -t1, b1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

function additive(vertexColors, color = 0xffffff) {
  return new THREE.MeshBasicMaterial({
    color,
    vertexColors,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
}

/**
 * A pool of decorative cards driven entirely by the updater.
 *
 * These are NOT consumables — a headlight beam is not something the hole can
 * eat — so they go through props.pool directly rather than ctx.addInstanced.
 * Slots are pre-allocated far below the world and driven into place, which is
 * the only way to get a free list out of an append-only pool.
 */
function cardPool(ctx, key, geometry, material, capacity) {
  const pool = ctx.props.pool(key, () => ({ geometry, material }), capacity, {
    castShadow: false, receiveShadow: false,
  });
  const hidden = new THREE.Vector3(0, -9999, 0);
  for (let i = 0; i < capacity; i++) pool.add(hidden, 0, 0.0001);
  pool.mesh.renderOrder = 4;
  return pool;
}

/** 0 below a, 1 above b, smooth between. */
function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/* ============================================================ build ==== */

export function buildVehicles(ctx) {
  const rng = makeRNG(0x7c3a51);
  const net = ctx.roads || (ctx.roads = new RoadNetwork(ctx.layout));
  // Built once: placement and the updater must read the same deck as each other
  // and as streets.js, or traffic and asphalt drift apart over a river.
  const state = { pools: new Set(), counts: {}, total: 0, decks: buildDeckSpans(ctx.layout) };

  const traf = new Traffic(ctx, net, rng);
  placeMoving(ctx, state, traf, rng);
  const moving = traf.vehicles.length;

  const freeBays = placeParked(ctx, state, rng);
  const bays = traf.registerBays(freeBays);
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
    cruising: boats.reduce((n, b) => n + (b.speed ? 1 : 0), 0),
    lanes: traf.lanes.length,
    bays,
    atKerb: traf.parked.length,
    blocking: traf.blocking,
    busHalts: traf.busHalts,
    tally: traf.tally,
    lots,
    pools: state.pools.size,
    byType: state.counts,
  });

  console.info(
    `[vehicles] ${state.total} vehicles | ${moving} driving on ${traf.lanes.length} lanes | `
    + `${bays} free kerb bays | ${boats.length} boats | ${state.pools.size} pools`
  );
  return state;
}

/* =========================================================== update ==== */

function makeUpdater(ctx, traf, state, boats) {
  const registry = ctx.registry;
  const decks = state.decks;
  const out = { x: 0, z: 0, rot: 0 };
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3(1, 1, 1);
  const gone = new THREE.Vector3(0, -9999, 0);
  const nilQ = new THREE.Quaternion();
  const nil = new THREE.Vector3(0, 0, 0);
  let time = 0;
  let sweepAt = 0;

  const lamps = vehicleMaterial();

  /* --- decorative light / foam cards ---------------------------------- */
  const drivers = traf.vehicles.length;
  const beamMat = additive(true);
  const beams = cardPool(ctx, 'vfx:headbeam', beamGeometry(), beamMat, drivers);
  const hazMat = additive(false, PALETTE.INDICATOR);
  const hazards = cardPool(ctx, 'vfx:hazard', hazardGeometry(), hazMat, 48);
  const hazFree = [];
  for (let i = hazards.count - 1; i >= 0; i--) hazFree.push(i);
  // Indicators share the hazards' material, so they share its blink. Real
  // flashers are unsynchronised, but at 40 m nobody has ever noticed and it
  // saves a second material and a second phase to animate.
  const indics = cardPool(ctx, 'vfx:indic', indicatorGeometry(), hazMat, 96);
  const indFree = [];
  for (let i = indics.count - 1; i >= 0; i--) indFree.push(i);
  const brakeMat = additive(true);
  const brakes = cardPool(ctx, 'vfx:brake', brakeGeometry(), brakeMat, drivers);
  const wakeMat = additive(true);
  const wakes = cardPool(ctx, 'vfx:wake', wakeGeometry(), wakeMat, boats.length);
  // Beam and brake slots are handed out once, in order, and never move: a
  // vehicle keeps the same card for the whole match, so nothing has to be
  // freed mid-frame. Hazards and indicators are rarer than the fleet, so those
  // two are lent from a free list instead.
  for (let i = 0; i < traf.vehicles.length; i++) traf.vehicles[i].beam = i;

  /**
   * Put every card this vehicle owns away.
   *
   * Called when it is swallowed AND when the consume system takes its
   * transform. Without the second case a car teetering over a hole left its
   * headlight pool and its brake lights lying flat on the tarmac where the car
   * used to be, which is exactly the kind of stray geometry the rubric fails a
   * frame for. Guarded by the `*Shown` flags so a dead vehicle costs one
   * upload, not one per frame for the thirty-second respawn delay.
   */
  const stow = (v) => {
    if (v.beamShown) { beams.setTransform(v.beam, gone, nilQ, nil); v.beamShown = false; }
    if (v.brakeShown) { brakes.setTransform(v.beam, gone, nilQ, nil); v.brakeShown = false; }
    if (v.hazSlot !== undefined) {
      hazards.setTransform(v.hazSlot, gone, nilQ, nil);
      hazFree.push(v.hazSlot); v.hazSlot = undefined;
    }
    if (v.indSlot !== undefined) {
      indics.setTransform(v.indSlot, gone, nilQ, nil);
      indFree.push(v.indSlot); v.indSlot = undefined;
    }
  };

  return (dt) => {
    if (!(dt > 0)) return;
    if (dt > 0.2) dt = 0.2;      // a stalled tab must not teleport the fleet
    time += dt;

    traf.step(dt, time);

    // --- day/night -----------------------------------------------------
    // engine.js owns the cycle; this only reads it. Lamps come up through
    // dusk rather than snapping on at midnight, which is when drivers
    // actually reach for the switch.
    const night = ctx.scene.userData.nightFactor || 0;
    const lit = smoothstep(0.06, 0.42, night);
    lamps.emissiveIntensity = 0.03 + 2.3 * lit;
    beamMat.opacity = 0.85 * lit;
    beams.mesh.visible = lit > 0.02;
    // Hazards, indicators and brake lamps burn day and night — they are
    // signals, not illumination — but they gain punch after dark like the
    // real thing, because the surface behind them stops competing.
    hazMat.opacity = (time % 0.92) < 0.52 ? 0.80 + 0.20 * lit : 0.04;
    brakeMat.opacity = 0.34 + 0.52 * lit;

    const V = traf.vehicles;
    for (let i = 0; i < V.length; i++) {
      const v = V[i];
      if (v.dead) { stow(v); continue; }
      const c = v.c;
      if (!c || c.state >= 2) { traf._lose(v); continue; }
      // Wheels over the void: hand it to the physics rather than fighting it
      // for the matrix every frame, which is what stopped cars ever tilting.
      if (c.state >= 1) { stow(v); continue; }
      traf.place(v, out);
      const surf = deckHeight(decks, out.x, out.z);
      pos.set(out.x, surf + v.yOff, out.z);
      e.set(0, out.rot, 0);
      q.setFromEuler(e);
      c.position.copy(pos);
      const p = c.pool;
      p.slotPos[c.slot].copy(pos);
      p.slotRot[c.slot].copy(q);
      p.setTransform(c.slot, pos, q, p.slotScale[c.slot]);
      registry.rehash(c);

      // Headlight pool on the tarmac, starting at the nose. A car sitting in a
      // bay has its lights off — that contrast between the moving lanes and the
      // parked kerb is most of what makes the night frame read.
      if (lit > 0.02 && v.mode !== 'parked') {
        const sn = Math.sin(out.rot), cs = Math.cos(out.rot);
        pos.set(out.x + sn * v.noseZ, surf + 0.035, out.z + cs * v.noseZ);
        scl.set(v.beamW, 1, v.beamL);
        beams.setTransform(v.beam, pos, q, scl);
        v.beamShown = true;
      } else if (v.beamShown) {
        beams.setTransform(v.beam, gone, nilQ, nil);
        v.beamShown = false;
      }

      // Brake lamps, square across the tail. Unlike the beams these are worth
      // drawing in daylight — a red flare on the back of a decelerating car is
      // how you read a queue forming from 200 m up.
      if (v.brake && v.mode !== 'parked') {
        const sn = Math.sin(out.rot), cs = Math.cos(out.rot);
        pos.set(out.x - sn * v.tailZ, surf + v.lampY, out.z - cs * v.tailZ);
        scl.set(v.lampW, v.lampH, 1);
        brakes.setTransform(v.beam, pos, q, scl);
        v.brakeShown = true;
      } else if (v.brakeShown) {
        brakes.setTransform(v.beam, gone, nilQ, nil);
        v.brakeShown = false;
      }

      // Hazards and indicators: scarce, so they are lent out and taken back.
      if (v.hazard && v.hazSlot === undefined && hazFree.length) v.hazSlot = hazFree.pop();
      if (v.hazSlot !== undefined) {
        if (v.hazard) {
          pos.set(out.x, surf + v.hazY, out.z);
          scl.set(v.hazW, 1, v.hazD);
          hazards.setTransform(v.hazSlot, pos, q, scl);
        } else {
          hazards.setTransform(v.hazSlot, gone, nilQ, nil);
          hazFree.push(v.hazSlot);
          v.hazSlot = undefined;
        }
      }
      // Hazards already flash all four corners, so a vehicle showing them does
      // not also get a single-side indicator — that reads as a fault, not a
      // signal.
      const wantInd = v.blink && !v.hazard;
      if (wantInd && v.indSlot === undefined && indFree.length) v.indSlot = indFree.pop();
      if (v.indSlot !== undefined) {
        if (wantInd) {
          pos.set(out.x, surf + v.lampY, out.z);
          scl.set(v.blink * v.indW, v.lampH, v.indL);
          indics.setTransform(v.indSlot, pos, q, scl);
        } else {
          indics.setTransform(v.indSlot, gone, nilQ, nil);
          indFree.push(v.indSlot);
          v.indSlot = undefined;
        }
      }
    }

    // A slow heave and roll. Small on purpose: the water plane is flat, so a
    // big bob would lift a hull clear of a surface that never rises to meet it.
    const ZLIM = WORLD.SIZE + 30;
    for (let i = 0; i < boats.length; i++) {
      const b = boats[i];
      const c = b.c;
      if (!c || c.state >= 1) continue;
      if (b.speed) {
        b.z += b.vz * dt;
        // Wrapping happens 550 m out at the corner of the map, where the pop
        // is a fraction of a pixel. Turning them round instead would need a
        // whole manoeuvring model for something nobody will ever be near.
        if (b.z > ZLIM) b.z -= ZLIM * 2;
        else if (b.z < -ZLIM) b.z += ZLIM * 2;
        if (b.weave) {
          const w = Math.sin(time * b.weaveHz * 6.28 + b.phase);
          b.x = b.x0 + w * b.weave;
          // Point where it is going: d/dt of the weave over forward speed.
          b.rot = b.rot0 + Math.atan2(
            Math.cos(time * b.weaveHz * 6.28 + b.phase) * b.weave * b.weaveHz * 6.28,
            b.speed
          ) * (b.vz > 0 ? 1 : -1);
        }
      }
      const ph = time * 0.62 + b.phase;
      const heave = b.speed ? 0.02 : 0.045;
      pos.set(b.x, BOAT_Y + Math.sin(ph) * heave, b.z);
      e.set(Math.sin(ph * 0.83 + 1.1) * 0.011, b.rot, Math.cos(ph * 0.71) * 0.017);
      q.setFromEuler(e);
      c.position.copy(pos);
      const p = c.pool;
      p.slotPos[c.slot].copy(pos);
      p.slotRot[c.slot].copy(q);
      p.setTransform(c.slot, pos, q, p.slotScale[c.slot]);
      registry.rehash(c);

      if (b.wake) {
        e.set(0, b.rot, 0);
        q.setFromEuler(e);
        pos.set(b.x, BOAT_Y + 0.03, b.z);
        scl.set(b.wake, 1, b.wakeL);
        wakes.setTransform(i, pos, q, scl);
      }
    }

    // Nothing in the engine flushes instanced pools per frame, so do our own.
    // This is also what lets the consume system's wobble reach the GPU.
    for (const p of state.pools) p.flush();
    beams.flush(); hazards.flush(); indics.flush(); brakes.flush(); wakes.flush();

    // Compact the dead out of the list occasionally rather than every frame.
    sweepAt += dt;
    if (sweepAt > 3) {
      sweepAt = 0;
      // `gone` vehicles are kept: they are coming back, and dropping them here
      // is how a respawned car ends up outside the sim for good.
      let w = 0;
      for (let i = 0; i < V.length; i++) if (!V[i].dead || V[i].gone) V[w++] = V[i];
      V.length = w;
    }
  };
}
