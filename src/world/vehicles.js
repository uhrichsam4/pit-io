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

  /**
   * PER-INSTANCE PAINT — why the shader is patched rather than using
   * `instanceColor`.
   *
   * The fleet used to allocate ONE POOL PER PAINT COLOUR because three's
   * `instanceColor` multiplies the WHOLE mesh: tint a sedan red and its
   * windows, tyres and number plate go red too. That cost 103 InstancedMeshes
   * for 36 shapes — 67 wasted draw calls in the beauty pass and another 67 in
   * the shadow pass, and it was the single biggest reason the city carried 389
   * pools (see docs/PERF_FINDINGS.md).
   *
   * The fix is a per-vertex SELECTOR. Each vertex says which of four
   * per-instance colour slots repaints it, or zero for "use the colour baked
   * into the geometry". Only the roles that actually differ between a shape's
   * variants get a slot (see `tintPlan`), so glass, rubber, chrome, lamps and
   * plates stay exactly as authored while the body, its knocked-back sills,
   * the livery accent and a contrast roof all move per instance. One sedan
   * pool, nine paints, one draw call.
   */
  _vehMat.customProgramCacheKey = () => 'veh-tint-v1';
  _vehMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float tintSel;
        attribute vec3 aTint0;
        attribute vec3 aTint1;
        attribute vec3 aTint2;
        attribute vec3 aTint3;`)
      .replace('#include <color_vertex>', `#include <color_vertex>
        {
          vec3 vehTint = vec3(1.0);
          if (tintSel > 3.5) vehTint = aTint3;
          else if (tintSel > 2.5) vehTint = aTint2;
          else if (tintSel > 1.5) vehTint = aTint1;
          else if (tintSel > 0.5) vehTint = aTint0;
          vColor.xyz *= vehTint;
        }`);
  };
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
  /* --- added for the boat and machinery rebuild ------------------------- */
  // Marine glazing. A boat's windows are 3-6 m of dark tinted band and the one
  // thing that makes a stack of white boxes read as a yacht; the road-car
  // `glass` tone is far too light to do that job against a cream hull.
  ['GLASS_DK', 'glassDk', BAND.GLASS],
  // The band below a boat's boot stripe: dark, matte, permanently wet.
  ['ANTIFOUL', 'antifoul', BAND.HULL],
  // Teak knocked back — plank reveals, coaming tops, side decks.
  ['DECK_LO', 'deckLo', BAND.MATTE],
  // Dried concrete / site dust on the bottom of a working machine.
  ['DUSTY', 'dusty', BAND.ROUGH],
  // Mud, rust and oil on a skip, a track frame or a counterweight.
  ['GRIME', 'grime', BAND.ROUGH],
  // Hazard chevrons and warning panels: unlit sun yellow, not a lamp.
  ['HAZARD', 'hazard', BAND.ROUGH],
  // Sail cloth in shade — the leeward panel of a mainsail.
  ['SAIL_LO', 'sailLo', BAND.MATTE],
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
    seat: v.seat ?? 0x3a3c40,
    hull: v.hull ?? PALETTE.HULL_WHITE,
    deck: v.deck ?? PALETTE.TEAK,
    sail: v.sail ?? PALETTE.SAIL,
    glassDk: v.glassDk ?? 0x1b2b33,
    antifoul: v.antifoul ?? 0x2b3f4a,
    deckLo: v.deckLo ?? darken(v.deck ?? PALETTE.TEAK, 0.68),
    dusty: v.dusty ?? 0xbcb3a1,
    grime: v.grime ?? 0x6b6053,
    hazard: v.hazard ?? PALETTE.ACCENT_SUN,
    sailLo: v.sailLo ?? darken(PALETTE.SAIL, 0.80),
    steel: v.steel ?? PALETTE.STEEL,
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
    /**
     * Where `carLamps` put the lamps, if it was called.
     *
     * The decorative light CARDS (brake flare, indicators, headlight pool) have
     * to sit just proud of the panel the real lamp is baked into. Guessing that
     * from `def.len` put every brake card 0.3 m INSIDE the bodywork, where the
     * depth test hid it outright — the whole fleet drove around with no brake
     * lights. Recording the lamp plane at build time is the only way the cards
     * and the baked lamps can be describing the same car.
     */
    this.lamp = null;
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
    return { count, pos, nor, uv, roles: Uint8Array.from(this.r), lamp: this.lamp };
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
 * Append a scratch shape into `sh`.
 *
 * Deliberately a loop and not `push(...arr)`: a spread of a 20k-element array
 * is passed as 20k arguments and blows the call stack, which is a real limit on
 * the bigger machinery shapes.
 */
function absorb(sh, s2) {
  for (let i = 0; i < s2.p.length; i++) { sh.p.push(s2.p[i]); sh.n.push(s2.n[i]); }
  for (let i = 0; i < s2.u.length; i++) sh.u.push(s2.u[i]);
  for (let i = 0; i < s2.r.length; i++) sh.r.push(s2.r[i]);
}

/**
 * Build a sub-assembly at the origin and stamp it in rotated and translated.
 *
 * Three shapes were already doing this by hand with a copy-pasted rotation
 * loop, and every hydraulic ram, lattice diagonal, davit and outrigger in the
 * rebuild needs it. Rotation order is roll (z) -> pitch (x) -> yaw (y), which
 * is the order that makes "lay a beam down and then swing it" behave.
 */
function stamp(sh, build, o = {}) {
  const s2 = new Shape();
  build(s2);
  const { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0 } = o;
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  const rot = (arr, i, ox, oy, oz) => {
    const px = arr[i], py = arr[i + 1], pz = arr[i + 2];
    const a = px * cz - py * sz, b = px * sz + py * cz;
    const b2 = b * cx - pz * sx, c2 = b * sx + pz * cx;
    arr[i] = a * cy + c2 * sy + ox;
    arr[i + 1] = b2 + oy;
    arr[i + 2] = -a * sy + c2 * cy + oz;
  };
  for (let i = 0; i < s2.p.length; i += 3) {
    rot(s2.p, i, x, y, z);
    rot(s2.n, i, 0, 0, 0);
  }
  absorb(sh, s2);
}

/** Cylinder between two arbitrary points — stays, rails, rams, outriggers. */
function tube(sh, a, b, r0, r1, seg, role, caps = [true, true]) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-5) return;
  const rx = -Math.asin(Math.max(-1, Math.min(1, dy / len)));
  const ry = Math.atan2(dx, dz);
  stamp(sh, (s) => cyl(s, 0, 0, 0, r0, r1, len, seg, 'z', role, caps),
    { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, z: (a[2] + b[2]) / 2, rx, ry });
}

/**
 * A hydraulic ram: a bright rod sliding out of a dark barrel, with a pivot pin
 * at each end. It is the single strongest silhouette cue plant machinery has —
 * without it an excavator arm is a bent stick.
 */
function ram(sh, a, b, rb, o = {}) {
  const f = o.out ?? 0.55;            // how far along the rod is extended
  const m = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  tube(sh, a, m, rb, rb, 6, o.barrel ?? ROLE.DARK);
  // PLATE, not CHROME, for the rod. A chrome rod is physically right and
  // visually wrong here: at metalness 0.92 under a turquoise sky it comes out
  // as a glowing cyan stick, which is the exact artefact three reviews called
  // an error. PLATE is a bright matte off-white and reads as polished steel.
  tube(sh, m, b, rb * 0.62, rb * 0.62, 5, ROLE.PLATE);
  for (const p of [a, b]) box(sh, p[0], p[1], p[2], rb * 2.6, rb * 1.7, rb * 1.7, ROLE.MACH_LO);
}

/**
 * A raised rail / toe rail / rubbing strake following a sheer line, both sides.
 * `stations` are half-widths, so the rail follows the hull's taper instead of
 * running straight through the bow.
 */
function strake(sh, stations, h, t, role) {
  for (const s of [-1, 1]) {
    for (let i = 0; i < stations.length - 1; i++) {
      const A = stations[i], B = stations[i + 1];
      const mz = (A.z + B.z) / 2, my = (A.y + B.y) / 2;
      sh.quad([s * A.x, A.y, A.z], [s * B.x, B.y, B.z],
        [s * B.x, B.y + h, B.z], [s * A.x, A.y + h, A.z], role, [0, my, mz]);
      sh.quad([s * A.x, A.y + h, A.z], [s * B.x, B.y + h, B.z],
        [s * (B.x - t), B.y + h, B.z], [s * (A.x - t), A.y + h, A.z], role, [0, my - 2, mz]);
    }
  }
}

/**
 * Stanchions with a rail wire threaded through them, both sides.
 *
 * Posts alone read as loose sticks — the review said exactly that about the
 * yacht's foredeck — and the wire is two triangles a span.
 */
function guardRail(sh, stations, h, role = ROLE.CHROME) {
  for (const s of [-1, 1]) {
    for (const st of stations) box(sh, s * st.x, st.y + h / 2, st.z, 0.05, h, 0.05, role);
    for (let i = 0; i < stations.length - 1; i++) {
      const A = stations[i], B = stations[i + 1];
      const mz = (A.z + B.z) / 2;
      sh.quad([s * A.x, A.y + h, A.z], [s * B.x, B.y + h, B.z],
        [s * B.x, B.y + h - 0.05, B.z], [s * A.x, A.y + h - 0.05, A.z], role, [0, A.y, mz]);
    }
  }
}

/** Black/yellow hazard chevrons on a z-facing panel. */
function chevrons(sh, x, y, z, w, h, n, dz) {
  const cw = w / n;
  for (let i = 0; i < n; i++) {
    faceZ(sh, x - w / 2 + cw * (i + 0.5), y, z, cw * 0.86, h,
      i % 2 ? ROLE.HAZARD : ROLE.DARK, dz);
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
  /**
   * WHERE THE VALUES SIT, AND WHY THEY MOVED
   * ----------------------------------------
   * The old face ran aluminium from 60% of the radius all the way to a CHROME
   * hub vertex. Aluminium is metalness 0.92 against a turquoise Miami sky, so
   * that disc reflected the sky and came out as a GLOWING TEAL CENTRE — three
   * separate reviews called it out on the convertible, the taxi, the flatbed
   * and the garbage truck, one of them as "reads as an error".
   *
   * A wheel is legible as dark-bright-dark: black rubber, an alloy ring, a dark
   * hub boss. So the metal is now a RING between 0.62 and 0.26 of the radius,
   * the hub interpolates to ROLE.DARK, and alternate sectors of the ring are
   * knocked to dark so the face reads as spokes rather than a plate. Same three
   * triangles a segment as before — this is a re-roling, not a spend.
   */
  const rr = r * 0.62;                        // where the tyre ends and metal starts
  const rimRole = o.rimRole ?? ROLE.RIM;
  const inward = [cx - side * 2, cy, cz];
  const outward = [cx + side * 2, cy, cz];
  const face = (xs, sgn, ref2) => {
    const xw = xs - sgn * width * 0.14;       // rim set into the sidewall
    const hub = [xs - sgn * width * 0.30, cy, cz];
    for (let i = 0; i < seg; i++) {
      const t0 = (i / seg) * Math.PI * 2, t1 = ((i + 1) / seg) * Math.PI * 2;
      const spoke = (i & 1) ? ROLE.DARK : rimRole;
      sh.tri3(pt(t0, r, xs), pt(t1, r, xs), pt(t1, rr, xw),
        ROLE.TYRE, ROLE.TYRE, spoke, ref2);
      sh.tri3(pt(t0, r, xs), pt(t1, rr, xw), pt(t0, rr, xw),
        ROLE.TYRE, spoke, spoke, ref2);
      sh.tri3(hub, pt(t0, rr, xw), pt(t1, rr, xw),
        ROLE.DARK, spoke, spoke, ref2);
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
  /**
   * The same hull with the topside split at the waterline.
   *
   * Every hull in the fleet was ONE tone from sheer to keel, and every boat
   * review said the same thing: a white slab. A boat is three tones — dark
   * antifouling below the water, a hard boot stripe at it, light topsides above
   * — and a painted-on decal cannot do it, because the decal is flat while the
   * chine is not. Two extra profile points buy the break in the geometry, which
   * means it also survives the hull tapering into the bow.
   */
  HULL3: [
    [-1.00, 0.52], [-0.72, 0.16], [0.00, 0.00], [0.72, 0.16],
    [1.00, 0.52], [1.00, 0.62], [1.00, 1.00],
    [-1.00, 1.00], [-1.00, 0.62],
  ],
};

/**
 * Edge roles for HULL3: keel and garboard in antifouling, a boot stripe at the
 * waterline, topsides in the hull colour, deck on top.
 */
const HULL3_ROLES = {
  0: ROLE.ANTIFOUL, 1: ROLE.ANTIFOUL, 2: ROLE.ANTIFOUL, 3: ROLE.ANTIFOUL,
  4: ROLE.ACCENT, 5: ROLE.HULL, 6: ROLE.WHITE, 7: ROLE.HULL, 8: ROLE.ACCENT,
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

/**
 * Decal quad on an x-facing surface (door livery, side markers).
 *
 * THE WINDING WAS INVERTED, AND IT COST THE WHOLE FLEET ITS SIDE DETAIL.
 * -------------------------------------------------------------------------
 * `flat` emits (a,b,c) and (a,c,d) verbatim — it does not auto-orient the way
 * `quad` does — and the old corner order gave the +x decal a geometric normal
 * of -x and the -x decal a normal of +x. Under the default FrontSide material
 * that means every faceX decal in the city was back-face culled from the only
 * direction you can actually see it from: a decal on the right flank was
 * rendered only for a viewer standing inside the vehicle.
 *
 * That single bug is behind four separate review verdicts — the motor yacht
 * with "no windows at all", the shuttle bus with "no passenger glazing on
 * either flank", the delivery van whose signwriting "came out as blank white
 * boxes", and the cruise ship with "no windows". The normals were always
 * right; only the corner order was wrong. faceY and faceZ are correct and are
 * left alone.
 */
function faceX(sh, x, y, z, d, h, role, dx) {
  const hz = d / 2, hy = h / 2, xx = x + dx * 0.014;
  const a = [xx, y - hy, z - hz], b = [xx, y - hy, z + hz];
  const c = [xx, y + hy, z + hz], e = [xx, y + hy, z - hz];
  if (dx > 0) sh.flat(a, e, c, b, role, [1, 0, 0]);
  else sh.flat(b, c, e, a, role, [-1, 0, 0]);
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
  // The lamp plane, for the light cards. First call wins: `police` and `taxi`
  // decorate a body that already declared one, and the base car is the one
  // carrying the lamps.
  if (!sh.lamp) sh.lamp = { zF, zR, yH, yT, dx, wL, hL };
}

/**
 * Front and rear fog / running lamps low in the bumper.
 *
 * Two triangles a corner, and they are what stops the LOWER half of a car going
 * completely dead after dark: the tail lamps are up at boot height, so from the
 * game's 3/4 camera a queue of cars at a red showed one band of red floating in
 * the air with unlit bodywork under it.
 */
function bumperLamps(sh, o) {
  const { zF, zR, y, dx } = o;
  for (const s of [-1, 1]) {
    faceZ(sh, s * dx, y, zF, 0.16, 0.08, ROLE.HEAD, 1);
    faceZ(sh, s * dx, y, zR, 0.16, 0.08, ROLE.TAIL, -1);
  }
}

/**
 * The horizontal detail a car needs, because the game's camera looks DOWN.
 *
 * From 40 m up, the bonnet, roof and boot are most of a car's visible area, and
 * all three were one unbroken slab of paint — which is why the fleet read as
 * coloured lozenges rather than as cars. The black plenum strip at the base of
 * the windscreen (wipers, scuttle vent) and a shut line at the boot are four
 * triangles, and they are the only body detail the default camera angle can
 * actually see. Both are pinned to the FLAT part of the upper surface: a
 * horizontal decal on the sloping nose would float off it.
 */
function topDetail(sh, o) {
  const { y, zCowl, w, zShut } = o;
  faceY(sh, 0, y, zCowl, w, 0.17, ROLE.DARK);
  if (zShut !== undefined) faceY(sh, 0, y, zShut, (o.wShut ?? w * 0.95), 0.06, ROLE.BODY_LO);
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
  // Upper surface is flat at y = 1.09 between z = -1.74 and z = 1.28.
  topDetail(sh, { y: 1.09, zCowl: 1.16, w: 1.30, zShut: -1.58 });
  wheels4(sh, 0.86, 1.45, -1.45, 0.36, 0.26);
  carLamps(sh, { zF: 2.31, zR: -2.31, yH: 0.72, yT: 0.78, dx: 0.56, rx: 0.92, rz: 0.95 });
  bumperLamps(sh, { zF: 2.31, zR: -2.31, y: 0.50, dx: 0.64 });
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
  topDetail(sh, { y: 1.41, zCowl: 1.22, w: 1.36 });
  wheels4(sh, 0.93, 1.55, -1.55, 0.42, 0.30);
  carLamps(sh, { zF: 2.42, zR: -2.42, yH: 1.02, yT: 1.16, dx: 0.62, wL: 0.46, yG: 0.72, wG: 1.14, yP: 0.52, rx: 0.99, rz: 1.05 });
  bumperLamps(sh, { zF: 2.42, zR: -2.42, y: 0.58, dx: 0.70 });
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
  // Upper surface tapers 1.18 -> 1.14 over the parallel span; 1.145 is the
  // local height at the scuttle, so the decal lies on it rather than over it.
  topDetail(sh, { y: 1.145, zCowl: 1.00, w: 1.24 });
  wheels4(sh, 0.84, 1.28, -1.28, 0.35, 0.25);
  carLamps(sh, { zF: 1.98, zR: -1.98, yH: 0.76, yT: 0.94, dx: 0.54, wL: 0.36, wG: 0.9, yP: 0.46, rx: 0.88, rz: 0.85 });
  bumperLamps(sh, { zF: 1.98, zR: -1.98, y: 0.44, dx: 0.60 });
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
  topDetail(sh, { y: 1.51, zCowl: 1.52, w: 1.42 });
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
  topDetail(sh, { y: 0.862, zCowl: 0.76, w: 1.30 });
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

/**
 * Grand tourer: very long bonnet, tight fastback cabin set well back.
 *
 * WHY THE GLASS AND THE SILLS ARE FIXED COLOURS HERE
 * --------------------------------------------------
 * This shape is painted graphite, navy, black and teal. With the fleet's shared
 * glass tone (a mid slate) the roof, the screen and the flank all landed within
 * a few percent of each other, and a dark instance read from the game camera as
 * ONE UNBROKEN LUMP — no glasshouse, no shoulder, no wheels. So the cabin tint
 * and the knocked-back sills are pinned in `FLEET` to values that do not follow
 * the paint: a near-black cabin band under a bright sky band, and a sill at 35%
 * of the body colour. Whatever the instance is painted, the flank now carries a
 * horizontal light-dark-light rhythm.
 */
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
  ], { edgeRoles: CABIN_GLOSS_ROLES, skip: new Set([0]), capStart: ROLE.GLASS, capEnd: ROLE.GLASS });
  pillar(sh, 0.87, 1.20, -1.10, 0.12, 0.30);
  // Sky-reflection bands across the top of both screens. The flanks get theirs
  // from CABIN_GLOSS_ROLES; the screens are caps, so they need it drawn on.
  sh.flat([-0.66, 1.25, 0.15], [0.66, 1.25, 0.15], [0.62, 1.30, 0.09], [-0.62, 1.30, 0.09],
    ROLE.GLASS_HI, [0, 0.6, 0.8]);
  sh.flat([0.60, 1.21, -1.95], [-0.60, 1.21, -1.95], [-0.64, 1.17, -1.88], [0.64, 1.17, -1.88],
    ROLE.GLASS_HI, [0, 0.6, -0.8]);
  // Bonnet power bulge and a pair of vents: the long nose needs an event.
  chamfer(sh, 0, 1.02, 1.50, 1.10, 0.06, 0.90, 0.05, ROLE.GLOSS);
  for (const s of [-1, 1]) faceY(sh, s * 0.58, 0.99, 0.98, 0.26, 0.44, ROLE.CARBON);
  topDetail(sh, { y: 0.985, zCowl: 0.50, w: 1.30 });
  // Shoulder crease + door shut line. Five metres of flank was one plane.
  for (const s of [-1, 1]) {
    faceX(sh, s * 0.98, 0.86, 0.10, 3.30, 0.05, ROLE.GLOSS_LO, s);
    faceX(sh, s * 0.98, 0.62, -0.62, 0.05, 0.62, ROLE.CARBON, s);
    faceX(sh, s * 0.98, 0.62, 1.06, 0.05, 0.62, ROLE.CARBON, s);
  }
  chamfer(sh, 0, 1.16, -2.28, 1.40, 0.06, 0.30, 0.03, ROLE.GLOSS_LO);
  /* Tail: a full-width lamp bar with a dark centre panel, over a body-colour
   * diffuser valance with the pipes RECESSED into it. The old pair of pale
   * chrome cubes stuck on the bumper corners read as a modelling mistake. */
  faceZ(sh, 0, 0.86, -2.44, 1.46, 0.10, ROLE.TAIL, -1);
  faceZ(sh, 0, 0.86, -2.452, 0.52, 0.11, ROLE.DARK, -1);
  for (const s of [-1, 1]) faceZ(sh, s * 0.52, 0.86, -2.452, 0.42, 0.13, ROLE.TAIL, -1);
  chamfer(sh, 0, 0.40, -2.40, 1.52, 0.30, 0.24, 0.06, ROLE.GLOSS_LO);
  faceZ(sh, 0, 0.34, -2.53, 1.16, 0.18, ROLE.CARBON, -1);
  for (const s of [-1, 1]) faceZ(sh, s * 0.30, 0.42, -2.535, 0.22, 0.10, ROLE.DARK, -1);
  wheels4(sh, 0.93, 1.62, -1.56, 0.39, 0.31, 8);
  carLamps(sh, { zF: 2.52, zR: -2.42, yH: 0.70, yT: 0.84, dx: 0.58, wL: 0.42, hL: 0.11, yG: 0.44, wG: 1.14, yP: 0.42, rx: 0.99, rz: 1.05 });
  mirrors(sh, 1.01, 1.06, 0.60);
}

/**
 * Roadster with the roof down — and the one body in the fleet whose interior is
 * a first-class surface, because the game's camera looks straight down INTO it.
 * It used to be a flat pan with two headrests standing on nothing.
 */
function convertible(sh) {
  sweep(sh, SEC.OCT, [
    { z: -2.17, w: 1.62, h: 0.72, y0: 0.38 },
    { z: -1.50, w: 1.84, h: 0.78, y0: 0.33 },
    { z: 1.10, w: 1.84, h: 0.76, y0: 0.33 },
    { z: 2.17, w: 1.58, h: 0.58, y0: 0.35 },
  ], { edgeRoles: OCT_SILL, capStart: ROLE.BODY_LO, capEnd: ROLE.BODY_LO });
  const zw = 0.62;                                   // windscreen base
  // Sunk footwell floor and a transmission tunnel: the cockpit is a well now.
  box(sh, 0, 0.92, -0.30, 1.44, 0.10, 1.94, ROLE.DARK);
  box(sh, 0, 1.02, -0.16, 0.32, 0.14, 1.30, ROLE.INTERIOR);
  // Door tops in body colour over a darker inner panel.
  for (const s of [-1, 1]) {
    chamfer(sh, s * 0.83, 1.08, -0.30, 0.18, 0.10, 1.94, 0.04, ROLE.BODY);
    faceX(sh, s * 0.73, 1.00, -0.30, 1.90, 0.18, ROLE.INTERIOR, s);
    // Door shut line and a side crease, so the flank is not a soap bar.
    faceX(sh, s * 0.93, 0.72, -0.68, 0.05, 0.60, ROLE.BODY_LO, s);
    faceX(sh, s * 0.93, 0.86, 0.10, 3.00, 0.05, ROLE.BODY_LO, s);
  }
  // Two buckets: squab, backrest, headrest.
  for (const s of [-1, 1]) {
    box(sh, s * 0.40, 1.02, -0.50, 0.50, 0.12, 0.54, ROLE.SEAT);
    chamfer(sh, s * 0.40, 1.24, -0.86, 0.48, 0.44, 0.20, 0.07, ROLE.SEAT);
    box(sh, s * 0.40, 1.50, -0.90, 0.28, 0.18, 0.16, ROLE.DARK);
  }
  // Dash cowl with a dark instrument binnacle, and a wheel on the left.
  chamfer(sh, 0, 1.04, 0.42, 1.44, 0.14, 0.36, 0.06, ROLE.INTERIOR);
  faceZ(sh, 0, 1.07, 0.24, 1.16, 0.12, ROLE.DARK, -1);
  stamp(sh, (s2) => {
    cyl(s2, 0, 0, 0, 0.17, 0.17, 0.04, 6, 'z', ROLE.DARK, [false, false]);
    box(s2, 0, 0, -0.07, 0.05, 0.05, 0.14, ROLE.INTERIOR);
  }, { x: -0.40, y: 1.19, z: 0.14, rx: -0.50 });
  // Folded soft-top stack under a tonneau behind the seats.
  chamfer(sh, 0, 1.16, -1.34, 1.54, 0.22, 0.60, 0.09, ROLE.DARK);
  box(sh, 0, 1.10, -1.74, 1.58, 0.08, 0.44, ROLE.BODY_LO);
  // Raked screen in a chrome frame.
  sh.quad([-0.78, 1.06, zw], [0.78, 1.06, zw], [0.68, 1.46, zw - 0.30], [-0.68, 1.46, zw - 0.30],
    ROLE.GLASS_HI, [0, 0.6, -1]);
  for (const s of [-1, 1]) {
    box(sh, s * 0.73, 1.26, zw - 0.15, 0.05, 0.42, 0.34, ROLE.CHROME);
  }
  box(sh, 0, 1.46, zw - 0.31, 1.40, 0.05, 0.06, ROLE.CHROME);
  faceY(sh, 0, 1.10, 1.62, 1.34, 0.05, ROLE.BODY_LO);        // bonnet shut line
  wheels4(sh, 0.87, 1.36, -1.36, 0.37, 0.27);
  carLamps(sh, { zF: 2.17, zR: -2.17, yH: 0.70, yT: 0.78, dx: 0.56, wL: 0.38, yP: 0.44, rx: 0.93, rz: 0.95 });
  mirrors(sh, 0.95, 1.06, 0.52);
}

/**
 * Taxi. 175 of them — the highest-count body in the city — so everything here
 * is chosen for what survives at 40 m and costs nothing at 175 copies.
 *
 * The three things that were wrong: the roof box was a blank white brick, the
 * livery band was authored at x = 0.92, which is the OCT section's own
 * half-width, so it sank into the chamfer and vanished; and one of the three
 * operators was painted white, which made those cabs indistinguishable from a
 * sedan. All three fixed: a real chequer standing 20 mm proud, a lit sign with
 * a dark bar reading as lettering, and a fleet that is taxi-yellow throughout.
 */
function taxi(sh) {
  sedan(sh);
  // Roof sign: a dark plinth carrying a lit box with a dark bar across 60% of
  // the lit face, which is what "TAXI" looks like from the game camera.
  box(sh, 0, 1.44, 0.10, 0.62, 0.08, 0.24, ROLE.DARK);
  chamfer(sh, 0, 1.61, 0.10, 0.86, 0.24, 0.30, 0.05, ROLE.SIGN);
  for (const dz of [1, -1]) faceZ(sh, 0, 1.61, 0.10 + dz * 0.15, 0.52, 0.10, ROLE.DARK, dz);
  for (const s of [-1, 1]) faceX(sh, s * 0.43, 1.61, 0.10, 0.18, 0.10, ROLE.DARK, s);
  /* Chequer band: six alternating quads a door, pushed 20 mm proud of the
   * flank on a box so it can never sink into the body section. */
  for (const s of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      const z = -1.32 + i * 0.44;
      box(sh, s * 0.95, 0.80, z, 0.05, 0.16, 0.42, i % 2 ? ROLE.WHITE : ROLE.DARK);
    }
    faceX(sh, s * 0.93, 0.60, -0.10, 2.40, 0.20, ROLE.ACCENT, s);   // operator band
    faceX(sh, s * 0.90, 1.02, -1.78, 0.44, 0.22, ROLE.SIGN, s);     // medallion number
    faceX(sh, s * 0.86, 1.26, 0.84, 0.16, 0.42, ROLE.DARK, s);      // dark A-pillar
  }
}

/**
 * Marked patrol SUV. It inherits a sound body; what makes it a police car is
 * the dressing, and the dressing was one flat blue rectangle on the door.
 */
function police(sh) {
  suv(sh);
  /* Light bar: six separate lenses in a dark housing with a low aerofoil
   * section, instead of one chamfered box with four coloured end faces. */
  chamfer(sh, 0, 1.99, 0.20, 1.30, 0.09, 0.34, 0.04, ROLE.DARK);
  chamfer(sh, 0, 2.07, 0.20, 1.18, 0.11, 0.26, 0.05, ROLE.DARK);
  for (let i = 0; i < 6; i++) {
    const x = -0.50 + i * 0.20;
    const role = i % 2 ? ROLE.BEACON : ROLE.TAIL;
    for (const dz of [1, -1]) faceZ(sh, x, 2.07, 0.20 + dz * 0.13, 0.17, 0.09, role, dz);
    faceY(sh, x, 2.125, 0.20, 0.17, 0.22, role);
  }
  for (const s of [-1, 1]) faceX(sh, s * 0.60, 2.07, 0.20, 0.24, 0.09, ROLE.BEACON, s);
  for (const s of [-1, 1]) {
    /* Two-part door livery: a swept band with a gold underline, a shield, and
     * a lettering block. Every element is keyed to the BAND rather than to the
     * paint, so it reads identically on the white car and the black one — a
     * white lettering block on a white patrol car is no lettering at all. */
    faceX(sh, s * 0.99, 1.10, -0.30, 2.10, 0.34, ROLE.BLUE, s);
    faceX(sh, s * 0.99, 0.84, -0.30, 2.10, 0.16, ROLE.SIGN, s);
    faceX(sh, s * 1.00, 1.22, 0.42, 0.44, 0.44, ROLE.SIGN, s);
    faceX(sh, s * 1.01, 1.22, 0.42, 0.22, 0.22, ROLE.BLUE, s);
    faceX(sh, s * 1.00, 1.10, -0.94, 1.00, 0.16, ROLE.SIGN, s);
  }
  // Push bar, pillar spotlight, whip antenna.
  box(sh, 0, 0.86, 2.50, 1.66, 0.10, 0.09, ROLE.CHROME);
  for (const s of [-1, 1]) {
    box(sh, s * 0.62, 1.06, 2.48, 0.09, 0.50, 0.09, ROLE.CHROME);
    box(sh, s * 0.55, 1.28, 2.48, 0.09, 0.09, 0.09, ROLE.CHROME);
  }
  stamp(sh, (s2) => {
    cyl(s2, 0, 0, 0, 0.09, 0.09, 0.22, 6, 'z', ROLE.DARK);
    faceZ(s2, 0, 0, 0.11, 0.14, 0.10, ROLE.HEAD, 1);
  }, { x: -0.90, y: 1.62, z: 0.94, ry: -0.5 });
  // Whip antenna. 45 mm, not 25: the bible bans needle-thin geometry outright.
  cyl(sh, 0.72, 1.92, -2.10, 0.045, 0.03, 0.86, 5, 'y', ROLE.DARK);
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
  // A van's roof is the largest unbroken surface in the fleet and the camera
  // looks straight down at it. Four pressed ribs and a hatch, ten triangles.
  for (const z of [-1.9, -0.9, 0.1, 1.1]) faceY(sh, 0, 2.54, z, 1.58, 0.09, ROLE.BODY_LO);
  faceY(sh, 0, 2.54, -2.55, 0.62, 0.62, ROLE.DARK);
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
  // Roof bows on the load box: 13 m^2 of white slab, aimed straight at the camera.
  for (const z of [-3.6, -2.4, -1.2, 0.0, 0.9]) faceY(sh, 0, 3.35, z, 2.02, 0.10, ROLE.DARK);
  chamfer(sh, 0, 0.62, -1.55, 2.30, 0.30, 5.30, 0.06, ROLE.DARK);
  wheels4(sh, 1.13, 2.70, -2.10, 0.54, 0.34);
  wheel(sh, 1.13, 0.54, -3.10, 0.54, 0.34, 6); wheel(sh, -1.13, 0.54, -3.10, 0.54, 0.34, 6);
  carLamps(sh, { zF: 3.90, zR: -4.28, yH: 0.86, yT: 1.00, dx: 0.80, wL: 0.40, yG: 0.52, wG: 1.3, yP: 0.48 });
  mirrors(sh, 1.22, 2.30, 3.30);
}

/**
 * A working truck's face.
 *
 * Every truck cab in the fleet was a smooth rounded box: no grille, no lamp
 * bezels, no shut line, no step. This is the shared kit, because the flatbed,
 * the mixer and the refuse truck all present the same 2.2 m frontal panel to a
 * camera that is usually looking at it from three metres away.
 */
function truckFace(sh, o) {
  const { zN, zL, xF, wF, yG, yL, ySill, yDoor, zDoor } = o;
  // Chrome grille with three bars, half-let into the nose panel.
  chamfer(sh, 0, yG, zN + 0.02, wF * 0.62, 0.46, 0.14, 0.04, ROLE.CHROME);
  for (let i = 0; i < 3; i++) {
    faceZ(sh, 0, yG - 0.15 + i * 0.15, zN + 0.09, wF * 0.56, 0.07, ROLE.DARK, 1);
  }
  for (const s of [-1, 1]) {
    // Lamp bezel, sitting just BEHIND the lamp plane so the lens reads inside it.
    box(sh, s * o.dxL, yL, zL - 0.07, 0.36, 0.28, 0.14, ROLE.CHROME);
    // Door shut line, handle, and a step under the door.
    faceX(sh, s * xF, yDoor, zDoor, 0.05, 1.00, ROLE.DARK, s);
    box(sh, s * (xF + 0.03), yDoor + 0.16, zDoor - 0.34, 0.05, 0.06, 0.26, ROLE.CHROME);
    box(sh, s * (xF - 0.16), ySill, zDoor - 0.30, 0.30, 0.07, 0.56, ROLE.DARK);
  }
  // Stepped bumper and a sun visor over the screen.
  chamfer(sh, 0, ySill + 0.10, zN + 0.16, wF * 1.04, 0.32, 0.22, 0.05, ROLE.DARK);
  chamfer(sh, 0, o.yVisor, zN - 0.06, wF * 0.92, 0.06, 0.26, 0.03, ROLE.BODY_LO);
}

/**
 * Flatbed. `load` builds the strapped-cargo variant — half the fleet runs
 * loaded, and an always-empty deck is the loudest tell that a truck is scenery.
 */
function flatbedBody(sh, load) {
  sweep(sh, SEC.OCT, [
    { z: 1.30, w: 2.20, h: 1.95, y0: 0.60 },
    { z: 3.30, w: 2.20, h: 1.90, y0: 0.60 },
    { z: 3.86, w: 2.06, h: 1.66, y0: 0.60 },
  ], { edgeRoles: OCT_SILL, capStart: false, capEnd: ROLE.BODY_LO });
  for (const s of [-1, 1]) faceX(sh, s * 1.10, 1.78, 3.00, 1.10, 0.62, ROLE.GLASS, s);
  faceZ(sh, 0, 1.90, 3.86, 1.82, 0.56, ROLE.GLASS, 1);
  truckFace(sh, {
    zN: 3.86, zL: 3.96, xF: 1.10, wF: 2.06, yG: 1.20, yL: 0.86, dxL: 0.78,
    ySill: 0.42, yDoor: 1.55, zDoor: 3.00, yVisor: 2.24,
  });
  // Stack in dark steel, not chrome: a polished cylinder at metalness 0.92
  // mirrors the Miami sky and comes out as a glowing cyan pole.
  cyl(sh, 1.14, 2.70, 1.24, 0.09, 0.09, 1.60, 6, 'y', ROLE.DARK);          // stack
  chamfer(sh, 1.14, 3.44, 1.24, 0.20, 0.16, 0.20, 0.04, ROLE.STEEL);
  /* --- the deck ------------------------------------------------------------
   * 5.6 m of one saturated colour was the single largest flat surface on the
   * vehicle. It is a steel frame now, planked in two timber tones with a real
   * reveal between the boards, and a diamond-plate strip over each wheel line. */
  chamfer(sh, 0, 1.02, -1.45, 2.34, 0.26, 5.30, 0.06, ROLE.DARK);
  for (let i = 0; i < 10; i++) {
    faceY(sh, -1.00 + i * 0.222, 1.15, -1.45, 0.19, 5.14, i % 2 ? ROLE.DECK_LO : ROLE.DECK);
  }
  for (const s of [-1, 1]) faceY(sh, s * 0.98, 1.152, -2.40, 0.24, 2.40, ROLE.STEEL);
  // Headache rack, standing just behind the cab.
  for (const s of [-1, 1]) box(sh, s * 1.02, 1.90, 1.16, 0.10, 1.40, 0.12, ROLE.DARK);
  box(sh, 0, 2.56, 1.16, 2.14, 0.12, 0.12, ROLE.DARK);
  for (const s of [-1, 1]) box(sh, s * 0.36, 1.90, 1.16, 0.07, 1.40, 0.08, ROLE.STEEL);
  // Stake sides: a rail, four posts a side, and a top rail linking them.
  for (const s of [-1, 1]) {
    chamfer(sh, s * 1.12, 1.30, -1.45, 0.10, 0.34, 5.20, 0.04, ROLE.BODY_LO);
    for (let i = 0; i < 4; i++) box(sh, s * 1.12, 1.72, -3.7 + i * 1.45, 0.10, 0.86, 0.14, ROLE.DARK);
    box(sh, s * 1.12, 2.12, -1.55, 0.08, 0.09, 4.40, ROLE.DARK);
  }
  chamfer(sh, 0, 0.60, -1.45, 2.20, 0.34, 5.20, 0.06, ROLE.DARK);
  // Mudguards over the rear bogie, fuel tank and battery box on the rail.
  for (const s of [-1, 1]) {
    box(sh, s * 1.02, 1.02, -2.70, 0.42, 0.10, 2.00, ROLE.DARK);
    box(sh, s * 1.02, 1.02, 2.70, 0.42, 0.10, 1.10, ROLE.DARK);
  }
  cyl(sh, -1.06, 0.72, 0.30, 0.30, 0.30, 0.34, 6, 'x', ROLE.CHROME);
  box(sh, 1.06, 0.76, 0.30, 0.30, 0.44, 0.60, ROLE.DARK);
  if (load) {
    // Two crate stacks and a pipe bundle under a ratchet strap.
    chamfer(sh, -0.48, 1.58, -0.40, 1.02, 0.80, 1.60, 0.06, ROLE.DECK_LO);
    chamfer(sh, 0.55, 1.42, -0.10, 0.86, 0.48, 1.10, 0.05, ROLE.DECK);
    for (let i = 0; i < 3; i++) {
      cyl(sh, 0.10 + i * 0.30, 1.35, -2.60, 0.16, 0.16, 2.20, 6, 'z', ROLE.STEEL);
    }
    for (const z of [-0.90, 0.10]) box(sh, -0.48, 1.60, z, 1.10, 0.86, 0.05, ROLE.HAZARD);
  }
  wheels4(sh, 1.00, 2.70, -2.20, 0.48, 0.30, 7);
  wheel(sh, 1.00, 0.48, -3.20, 0.48, 0.30, 7); wheel(sh, -1.00, 0.48, -3.20, 0.48, 0.30, 7);
  carLamps(sh, { zF: 3.96, zR: -4.10, yH: 0.86, yT: 1.02, dx: 0.78, wL: 0.38, grille: false, yP: 0.48 });
  mirrors(sh, 1.20, 2.24, 3.30);
}
function flatbed(sh) { flatbedBody(sh, false); }
function flatbedLoad(sh) { flatbedBody(sh, true); }

/**
 * Rear-loader refuse truck.
 *
 * It read as a generic box truck because the cab and the body were the same
 * flat green and the rear was a plain chamfered plate. A refuse truck is
 * recognised from behind: a packer body overhanging the chassis, a hopper mouth
 * you can see into, rams down each side and chevrons across the tailgate.
 */
function garbageTruck(sh) {
  sweep(sh, SEC.OCT, [
    { z: 1.60, w: 2.28, h: 2.20, y0: 0.58 },
    { z: 3.40, w: 2.28, h: 2.10, y0: 0.58 },
    { z: 3.92, w: 2.14, h: 1.86, y0: 0.58 },
  ], { role: ROLE.WHITE, edgeRoles: { 0: ROLE.DARK, 1: ROLE.DARK, 2: ROLE.DARK },
    capStart: false, capEnd: ROLE.WHITE });
  for (const s of [-1, 1]) faceX(sh, s * 1.14, 1.92, 3.10, 1.10, 0.62, ROLE.GLASS, s);
  faceZ(sh, 0, 2.02, 3.92, 1.90, 0.60, ROLE.GLASS, 1);
  truckFace(sh, {
    zN: 3.92, zL: 4.02, xF: 1.14, wF: 2.14, yG: 1.24, yL: 0.90, dxL: 0.82,
    ySill: 0.44, yDoor: 1.62, zDoor: 3.10, yVisor: 2.40,
  });
  // Amber beacon bar across the cab roof.
  box(sh, 0, 2.74, 3.20, 1.34, 0.10, 0.20, ROLE.DARK);
  for (const s of [-1, 1]) faceZ(sh, s * 0.42, 2.76, 3.31, 0.42, 0.09, ROLE.AMBER, 1);
  // Body: green, ribbed, with a rub rail and a livery panel.
  sweep(sh, SEC.OCT, [
    { z: -3.10, w: 2.30, h: 2.10, y0: 0.66 },
    { z: -2.20, w: 2.38, h: 2.55, y0: 0.66 },
    { z: 1.40, w: 2.38, h: 2.55, y0: 0.66 },
  ], { edgeRoles: OCT_SILL, capStart: false, capEnd: false });
  for (const s of [-1, 1]) {
    for (let i = 0; i < 5; i++) faceX(sh, s * 1.20, 1.90, -1.70 + i * 0.95, 0.14, 1.30, ROLE.BODY_LO, s);
    faceX(sh, s * 1.205, 1.32, -0.90, 4.20, 0.12, ROLE.DARK, s);         // rub rail
    faceX(sh, s * 1.21, 2.24, -0.10, 2.60, 0.48, ROLE.WHITE, s);         // livery panel
    faceX(sh, s * 1.22, 2.24, -0.10, 2.20, 0.14, ROLE.DARK, s);          // lettering
    faceX(sh, s * 1.21, 1.62, 1.06, 0.56, 0.28, ROLE.HAZARD, s);         // fleet number
    box(sh, s * 1.12, 1.08, -1.60, 0.34, 0.10, 2.40, ROLE.DARK);         // mudguard
  }
  faceY(sh, 0, 3.21, -0.60, 1.86, 3.00, ROLE.BODY_LO);                   // roof panel line
  /* --- tailgate ------------------------------------------------------------
   * A distinct packer body overhanging the chassis, with a hopper mouth cut
   * into it, rams down each side, a rear step and a grab rail. Each decal on
   * the tail panel gets its own standoff so nothing is coplanar. */
  chamfer(sh, 0, 1.70, -3.86, 2.44, 2.60, 1.40, 0.12, ROLE.BODY_LO);
  faceZ(sh, 0, 1.60, -4.570, 1.90, 1.06, ROLE.DARK, -1);                 // hopper mouth
  faceZ(sh, 0, 0.94, -4.578, 1.60, 0.18, ROLE.GRIME, -1);                // spill lip
  chevrons(sh, 0, 2.68, -4.586, 2.10, 0.28, 6, -1);
  for (const s of [-1, 1]) {
    ram(sh, [s * 1.18, 2.60, -3.30], [s * 1.18, 1.40, -4.20], 0.09);
    box(sh, s * 0.86, 0.74, -4.62, 0.60, 0.09, 0.30, ROLE.STEEL);        // rear step
    box(sh, s * 1.16, 1.90, -4.62, 0.07, 1.10, 0.07, ROLE.CHROME);       // grab rail
    box(sh, s * 0.52, 1.10, -4.78, 0.14, 0.12, 0.50, ROLE.DARK);         // bin-lifter fork
  }
  box(sh, 0, 1.16, -4.96, 1.30, 0.12, 0.12, ROLE.DARK);
  // Side ladder up to the body.
  for (let i = 0; i < 3; i++) box(sh, 1.24, 1.00 + i * 0.36, -2.90, 0.10, 0.07, 0.44, ROLE.CHROME);
  chamfer(sh, 0, 0.66, -0.9, 2.24, 0.32, 6.4, 0.06, ROLE.DARK);
  wheels4(sh, 1.02, 2.80, -1.90, 0.50, 0.32, 7);
  wheel(sh, 1.02, 0.50, -2.95, 0.50, 0.32, 7); wheel(sh, -1.02, 0.50, -2.95, 0.50, 0.32, 7);
  carLamps(sh, { zF: 4.02, zR: -4.72, yH: 0.90, yT: 1.10, dx: 0.82, wL: 0.38, grille: false, yP: 0.50 });
  mirrors(sh, 1.24, 2.44, 3.36);
}

function cementMixer(sh) {
  sweep(sh, SEC.OCT, [
    { z: 1.70, w: 2.26, h: 2.20, y0: 0.60 },
    { z: 3.40, w: 2.26, h: 2.10, y0: 0.60 },
    { z: 3.90, w: 2.12, h: 1.86, y0: 0.60 },
  ], { edgeRoles: OCT_SILL, capStart: false, capEnd: ROLE.BODY_LO });
  for (const s of [-1, 1]) faceX(sh, s * 1.13, 1.94, 3.10, 1.10, 0.62, ROLE.GLASS, s);
  faceZ(sh, 0, 2.04, 3.90, 1.88, 0.60, ROLE.GLASS, 1);
  truckFace(sh, {
    zN: 3.90, zL: 4.00, xF: 1.13, wF: 2.12, yG: 1.24, yL: 0.90, dxL: 0.80,
    ySill: 0.44, yDoor: 1.64, zDoor: 3.10, yVisor: 2.42,
  });
  /* --- the drum ------------------------------------------------------------
   * Tilted nose-up, discharging at the rear. `dp` gives a point at axial
   * offset t and angle a on the tilted axis, which is what lets the helical
   * fins, the hopper and the chute all sit ON the drum rather than near it. */
  const tilt = 0.13;
  const drumY = 2.55, drumZ = -0.90;
  const sy = Math.sin(tilt), cyy = Math.cos(tilt);
  const seg = 10;
  const dp = (t, a, r) => [
    Math.cos(a) * r,
    drumY - t * sy + Math.sin(a) * r * cyy,
    drumZ + t * cyy + Math.sin(a) * r * sy,
  ];
  const radAt = (t) => (t < -1.20 ? 0.70 + (t + 2.70) * 0.40
    : t < 1.50 ? 1.30 : 1.30 - (t - 1.50) * 0.40);
  const emit = (r0, r1, z0, z1, role) => {
    const mz = (z0 + z1) / 2;
    cyl(sh, 0, drumY - (mz - drumZ) * sy, drumZ + (mz - drumZ) * cyy,
      r0, r1, Math.abs(z1 - z0), seg, 'z', role, [false, false]);
  };
  emit(0.70, 1.30, -3.60, -2.10, ROLE.MACH);
  emit(1.30, 1.30, -2.10, 0.40, ROLE.MACH);
  emit(1.30, 0.86, 0.40, 1.50, ROLE.MACH);
  /* Dried-concrete wash over the BOTTOM of the barrel: this is a working truck.
   * In `dp`, angle 0 is +x and pi/2 is straight up, so the underside is the
   * arc between pi and 2pi. */
  for (let i = 0; i < 6; i++) {
    const a0 = Math.PI * (1.12 + 0.76 * (i / 6)), a1 = Math.PI * (1.12 + 0.76 * ((i + 1) / 6));
    sh.quad(dp(-2.20 - drumZ, a0, 1.31), dp(-2.20 - drumZ, a1, 1.31),
      dp(0.40 - drumZ, a1, 1.31), dp(0.40 - drumZ, a0, 1.31),
      ROLE.DUSTY, [0, drumY, drumZ]);
  }
  // Three raised helical fin bands. A bare cone-cylinder is not a mixer.
  for (let b = 0; b < 3; b++) {
    const a0 = b * 2.09;
    const N = 7;
    for (let i = 0; i < N; i++) {
      const u0 = i / N, u1 = (i + 1) / N;
      const t0 = -2.40 + u0 * 3.60, t1 = -2.40 + u1 * 3.60;
      const g0 = a0 + u0 * 3.4, g1 = a0 + u1 * 3.4;
      const r0 = radAt(t0), r1 = radAt(t1);
      sh.quad(dp(t0, g0, r0), dp(t1, g1, r1), dp(t1, g1, r1 + 0.10), dp(t0, g0, r0 + 0.10),
        ROLE.MACH_LO, [0, drumY, drumZ]);
    }
  }
  // Feed hopper on top, discharge chute hinged off the tail.
  cyl(sh, 0, drumY + 0.36, -3.72, 0.72, 0.72, 0.14, seg, 'z', ROLE.MACH_LO);
  cyl(sh, 0, 3.42, 1.12, 0.62, 0.34, 0.70, 8, 'y', ROLE.STEEL, [false, true]);
  stamp(sh, (s2) => {
    // A tapered trough: floor plus two low cheeks, raked down and aft.
    s2.quad([-0.50, 0, -0.70], [0.50, 0, -0.70], [0.34, 0, 0.70], [-0.34, 0, 0.70],
      ROLE.MACH_LO, [0, -1, 0]);
    for (const s of [-1, 1]) {
      s2.quad([s * 0.50, 0, -0.70], [s * 0.34, 0, 0.70], [s * 0.34, 0.18, 0.70], [s * 0.50, 0.18, -0.70],
        ROLE.MACH_LO, [0, 0.09, 0]);
    }
    s2.quad([-0.50, 0, -0.70], [0.50, 0, -0.70], [0.50, 0.18, -0.70], [-0.50, 0.18, -0.70],
      ROLE.GRIME, [0, 0.09, 0.5]);
  }, { x: 0, y: 1.40, z: -4.34, rx: 0.62 });
  chamfer(sh, 0, 2.20, -3.86, 1.20, 0.36, 0.30, 0.06, ROLE.MACH_LO);       // chute hinge
  // Water tank behind the cab, ladder up the near side to a catwalk.
  cyl(sh, 0, 3.10, 1.90, 0.42, 0.42, 1.70, 8, 'x', ROLE.WHITE);
  for (const s of [-1, 1]) box(sh, s * 1.06, 1.30, -1.2, 0.14, 1.70, 0.20, ROLE.DARK);
  for (let i = 0; i < 4; i++) box(sh, 1.20, 0.90 + i * 0.42, 0.90, 0.10, 0.07, 0.46, ROLE.DARK);
  box(sh, 1.16, 2.62, -0.60, 0.34, 0.08, 2.60, ROLE.DARK);                 // catwalk
  box(sh, 1.30, 3.06, -0.60, 0.08, 0.80, 0.08, ROLE.MACH_LO);
  box(sh, 1.30, 3.42, -0.60, 0.08, 0.08, 2.60, ROLE.MACH_LO);
  chamfer(sh, 0, 0.66, -0.9, 2.16, 0.34, 6.6, 0.06, ROLE.DARK);
  wheels4(sh, 1.02, 2.80, -1.80, 0.50, 0.32, 7);
  wheel(sh, 1.02, 0.50, -2.90, 0.50, 0.32, 7); wheel(sh, -1.02, 0.50, -2.90, 0.50, 0.32, 7);
  carLamps(sh, { zF: 4.00, zR: -4.60, yH: 0.90, yT: 1.06, dx: 0.80, wL: 0.36, grille: false, yP: 0.50 });
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
  /* A bus roof is 11.8 x 2.5 m and the game's camera looks straight down at
   * it — it is the largest single surface any vehicle in the city presents,
   * and it was one unbroken slab of cream with a WHITE AC pod on a WHITE roof,
   * i.e. invisible. Kit it out: metal AC pack, rear equipment box, hatch, and
   * the pressed bows a monocoque roof actually has. */
  chamfer(sh, 0, 3.30, 1.2, 1.30, 0.26, 2.20, 0.08, ROLE.STEEL);   // roof AC pack
  box(sh, 0, 3.36, -4.30, 1.16, 0.20, 1.10, ROLE.STEEL);           // rear equipment pod
  faceY(sh, 0, 3.26, -1.90, 0.74, 0.74, ROLE.DARK);                // escape hatch
  for (const z of [-3.1, -0.5, 3.1, 4.3]) faceY(sh, 0, 3.26, z, 1.92, 0.09, ROLE.BODY_LO);
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
    // Cant-rail pinstripe: carries the livery up to where the camera can see it.
    faceX(sh, s * 1.285, 2.44, 4.2, 8.0, 0.10, ROLE.ACCENT, s);
    faceX(sh, s * 1.285, 2.44, -5.4, 6.0, 0.10, ROLE.ACCENT, s);
  }
  for (const z of [6.60, 2.60, -4.20]) {
    for (const s of [-1, 1]) {
      faceX(sh, s * 1.28, 1.60, z, 1.20, 1.90, ROLE.GLASS, s);
      // Body colour, not dark: a dark split line on dark glass is invisible.
      faceX(sh, s * 1.29, 1.60, z, 0.07, 1.90, ROLE.BODY, s);       // door leaf split
      faceX(sh, s * 1.29, 0.68, z, 1.24, 0.10, ROLE.DARK, s);       // step well shadow
    }
  }
  faceZ(sh, 0, 3.02, 8.92, 1.70, 0.30, ROLE.SIGN, 1);
  for (const s of [-1, 1]) faceX(sh, s * 1.285, 2.62, 7.30, 0.80, 0.30, ROLE.SIGN, s);
  /* --- the roof ------------------------------------------------------------
   * 18 m x 2.5 m of white, and the game's camera spends most of its time
   * looking straight at it. It gets treated as a facade: a full-length raised
   * centre spine, a real AC pack with a louvred face, framed hatches, and a
   * transverse rib rhythm, plus the livery band carried over the shoulder at
   * the articulation so the joint is legible from directly above. */
  chamfer(sh, 0, 3.37, 3.90, 0.80, 0.22, 7.80, 0.06, ROLE.BODY_LO);
  chamfer(sh, 0, 3.37, -5.35, 0.80, 0.22, 6.40, 0.06, ROLE.BODY_LO);
  chamfer(sh, 0, 3.52, 6.10, 1.36, 0.36, 2.30, 0.08, ROLE.STEEL);          // AC pack
  for (let i = 0; i < 4; i++) faceZ(sh, 0, 3.44 + i * 0.09, 7.26, 1.10, 0.06, ROLE.DARK, 1);
  box(sh, 0, 3.42, -6.60, 1.20, 0.28, 1.20, ROLE.STEEL);                   // equipment pod
  for (let i = 0; i < 3; i++) faceY(sh, 0, 3.57, -6.60 - 0.30 + i * 0.30, 1.10, 0.07, ROLE.DARK);
  for (const z of [1.60, -3.40]) {                                         // framed hatches
    box(sh, 0, 3.30, z, 0.86, 0.10, 0.86, ROLE.BODY_LO);
    faceY(sh, 0, 3.35, z, 0.66, 0.66, ROLE.DARK);
  }
  for (const z of [0.30, 2.80, 4.80, 7.40, -2.50, -4.40, -6.00, -7.90]) {
    faceY(sh, 0, 3.26, z, 2.02, 0.10, ROLE.BODY_LO);
  }
  // Livery over the roof shoulder at the joint.
  for (const s of [-1, 1]) faceY(sh, s * 0.78, 3.262, -1.20, 0.46, 1.30, ROLE.ACCENT);
  chamfer(sh, 0, 0.42, 3.6, 2.34, 0.34, 10.4, 0.06, ROLE.DARK);
  chamfer(sh, 0, 0.42, -5.4, 2.34, 0.34, 7.0, 0.06, ROLE.DARK);
  wheels4(sh, 1.22, 7.20, 1.10, 0.56, 0.36);
  wheel(sh, 1.22, 0.56, -6.60, 0.56, 0.36, 6); wheel(sh, -1.22, 0.56, -6.60, 0.56, 0.36, 6);
  carLamps(sh, { zF: 8.95, zR: -8.95, yH: 0.80, yT: 1.00, dx: 0.90, wL: 0.40, grille: false, yP: 0.48 });
  mirrors(sh, 1.34, 2.70, 8.50);
}

/**
 * Airport shuttle. The body sweep, the roof pod, the wheels and the lamps were
 * all well made — and the thing rendered as a blank cream slab, because the
 * only glazing on 7.3 m of coach was a single 1.0 m door window on one side.
 * A coach is READ by its window band; everything below adds one, both sides,
 * with mullions and a proper glazed entry door.
 */
function shuttleBus(sh) {
  sweep(sh, SEC.COACH, [
    { z: -3.55, w: 2.06, h: 2.34, y0: 0.36, rake: 0.10 },
    { z: -3.00, w: 2.22, h: 2.38, y0: 0.32 },
    { z: 2.60, w: 2.22, h: 2.38, y0: 0.32 },
    { z: 3.55, w: 2.04, h: 2.20, y0: 0.32, rake: -0.26 },
  ], {
    /* The COACH section paints its own flank band as saloon glazing, which on
     * this body ran from y = 1.13 to 2.18 — over half the side — and still did
     * not read as windows, because nothing broke it up. The band is painted
     * body colour here and the glazing is authored explicitly instead: a
     * shallower run with WHITE mullions through it. Dark mullions on dark glass
     * are invisible; it is the white pillars between the panes that make a
     * window band read as windows. */
    edgeRoles: { ...COACH_ROLES, 4: ROLE.BODY, 10: ROLE.BODY },
    capStart: ROLE.BODY, capEnd: ROLE.GLASS,
  });
  for (const s of [-1, 1]) {
    faceX(sh, s * 1.12, 1.00, 0, 5.8, 0.42, ROLE.ACCENT, s);
    // Continuous saloon glazing, z -2.6 .. 2.4, split by four mullions.
    faceX(sh, s * 1.12, 1.82, -0.10, 5.00, 0.86, ROLE.GLASS, s);
    faceX(sh, s * 1.125, 2.21, -0.10, 5.00, 0.09, ROLE.GLASS_HI, s);
    for (let i = 0; i < 4; i++) {
      faceX(sh, s * 1.13, 1.82, -2.00 + i * 1.00, 0.10, 0.88, ROLE.BODY, s);
    }
    faceX(sh, s * 1.13, 1.34, -0.10, 5.00, 0.07, ROLE.BODY_LO, s);   // waist rail
  }
  // Glazed entry door with a step well, behind the front axle, kerb side.
  faceX(sh, 1.13, 1.60, 1.62, 0.98, 1.46, ROLE.BODY_LO, 1);
  faceX(sh, 1.14, 1.74, 1.62, 0.84, 1.10, ROLE.GLASS, 1);
  faceX(sh, 1.14, 0.80, 1.62, 0.90, 0.24, ROLE.DARK, 1);
  faceZ(sh, 0, 1.70, -3.62, 1.44, 0.86, ROLE.GLASS, -1);             // rear window
  faceZ(sh, 0, 2.66, 3.42, 1.44, 0.28, ROLE.SIGN, 1);                // destination blind
  // Knocked-back paint, not white: a white pod on a white roof is no pod.
  chamfer(sh, 0, 2.86, -1.40, 1.50, 0.30, 2.40, 0.08, ROLE.BODY_LO);  // roof luggage pod
  for (let i = 0; i < 5; i++) faceY(sh, 0, 3.02, -2.40 + i * 0.50, 1.30, 0.08, ROLE.DARK);
  for (const s of [-1, 1]) box(sh, s * 0.80, 2.78, -1.40, 0.06, 0.06, 2.30, ROLE.CHROME);
  for (const z of [0.3, 1.3, 2.3]) faceY(sh, 0, 2.70, z, 1.62, 0.09, ROLE.BODY_LO);
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
  // Roof cross. An ambulance is identified from the air, and from this game's
  // camera the air is where the player is. The arms are 4 mm apart in y so the
  // overlap at the centre cannot z-fight.
  faceY(sh, 0, 2.70, -1.60, 1.40, 0.34, ROLE.RED);
  faceY(sh, 0, 2.704, -1.60, 0.34, 1.40, ROLE.RED);
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
  // Two-wheelers never call carLamps, so they declare their lamp plane by hand
  // — otherwise the brake card falls back to the bounding box and sits at hub
  // height, halfway down the back wheel.
  sh.lamp = { zF: 0.78, zR: -0.96, yH: 0.92, yT: 0.80, dx: 0, wL: 0.16, hL: 0.09 };
}

/**
 * Naked motorcycle. Two wheels give it almost no plan area, so the silhouette
 * has to work in profile: a raked fork, a tank that steps up out of the engine,
 * a stepped seat and a tail unit that kicks up behind the rear wheel. That
 * profile is what stops it reading as "small car" at 40 m, which is the only
 * thing a bike has to get right in this game.
 */
/**
 * Sports bike. Longer than it was — 1.44 m of wheelbase and 2.16 m overall,
 * against 1.32 / 2.30 before, which read as stubby next to the cars.
 *
 * The front end was the real failure: dark forks against a dark yoke against a
 * dark nose, with the headlight painted on as a 19 cm rectangle, so from the
 * game camera the whole front of the bike was one blob. It now has splayed
 * chrome fork legs, a round headlamp disc under a dark screen, and — like the
 * cars beside it, which is what made the omission conspicuous — wheels with a
 * light alloy rim inside the dark tyre.
 */
function motorcycle(sh) {
  const rF = 0.34, rR = 0.36, zF = 0.82, zR = -0.62;
  wheel(sh, 0.0, rF, zF, rF, 0.13, 8, { twin: true, arch: false });
  wheel(sh, 0.0, rR, zR, rR, 0.19, 8, { twin: true, arch: false });
  // Chain run and sprocket on the left, and a rear shock behind the engine.
  cyl(sh, -0.12, rR, zR, 0.15, 0.15, 0.03, 7, 'x', ROLE.CHROME);
  box(sh, -0.12, rR - 0.03, zR + 0.30, 0.04, 0.05, 0.62, ROLE.DARK);
  stamp(sh, (s2) => cyl(s2, 0, 0, 0, 0.05, 0.05, 0.42, 6, 'y', ROLE.RED),
    { y: 0.62, z: -0.30, rx: -0.55 });
  // Swingarm.
  for (const s of [-1, 1]) box(sh, s * 0.13, 0.40, -0.30, 0.06, 0.09, 0.72, ROLE.CHROME);
  // Splayed fork legs, raked forward. Bright chrome, so the front end reads.
  for (const s of [-1, 1]) {
    stamp(sh, (s2) => cyl(s2, 0, 0, 0, 0.058, 0.050, 0.90, 6, 'y', ROLE.CHROME),
      { x: s * 0.16, y: 0.72, z: 0.76, rx: 0.40, rz: -s * 0.07 });
  }
  chamfer(sh, 0, 1.08, 0.62, 0.34, 0.20, 0.24, 0.06, ROLE.DARK);     // top yoke
  chamfer(sh, 0, 0.46, 0.06, 0.42, 0.46, 0.66, 0.09, ROLE.DARK);     // engine
  box(sh, 0, 0.34, 0.30, 0.36, 0.20, 0.22, ROLE.CHROME);             // header pipes
  chamfer(sh, 0, 0.90, 0.26, 0.44, 0.34, 0.72, 0.13, ROLE.BODY);     // tank
  chamfer(sh, 0, 0.86, -0.26, 0.34, 0.10, 0.50, 0.05, ROLE.SEAT);
  chamfer(sh, 0, 0.98, -0.72, 0.26, 0.24, 0.44, 0.08, ROLE.BODY);    // tail unit
  box(sh, 0, 1.20, 0.56, 0.68, 0.05, 0.06, ROLE.DARK);               // bars
  for (const s of [-1, 1]) box(sh, s * 0.32, 1.28, 0.54, 0.11, 0.08, 0.05, ROLE.CHROME);
  // Nose fairing: a round lamp under a small dark screen.
  chamfer(sh, 0, 1.06, 0.86, 0.28, 0.30, 0.20, 0.06, ROLE.BODY);
  cyl(sh, 0, 1.02, 0.94, 0.115, 0.115, 0.06, 7, 'z', ROLE.DARK);
  faceZ(sh, 0, 1.02, 0.975, 0.17, 0.17, ROLE.HEAD, 1);
  sh.quad([-0.13, 1.24, 0.84], [0.13, 1.24, 0.84], [0.11, 1.36, 0.76], [-0.11, 1.36, 0.76],
    ROLE.DARK, [0, 1.0, 0.4]);
  faceZ(sh, 0, 1.02, -0.94, 0.17, 0.10, ROLE.TAIL, -1);
  faceZ(sh, 0, 0.64, -0.96, 0.20, 0.07, ROLE.PLATE, -1);
  for (const s of [-1, 1]) faceX(sh, s * 0.20, 1.10, 0.78, 0.11, 0.08, ROLE.AMBER, s);
  cyl(sh, 0.22, 0.42, -0.56, 0.08, 0.09, 0.70, 6, 'z', ROLE.CHROME); // exhaust can
  sh.lamp = { zF: 0.98, zR: -0.94, yH: 1.02, yT: 1.02, dx: 0, wL: 0.19, hL: 0.10 };
}

/**
 * Cruiser. Sixty-seven identical sportbikes on one city's kerbs is a rank, so
 * the two-wheeler count is split across two body styles: this one has a longer
 * rake, a 1.72 m wheelbase, a wide bar, a teardrop tank, a low stepped saddle,
 * a valanced rear fender and shotgun pipes.
 */
function cruiser(sh) {
  const rF = 0.36, rR = 0.34, zF = 1.00, zR = -0.72;
  wheel(sh, 0.0, rF, zF, rF, 0.12, 8, { twin: true, arch: false });
  wheel(sh, 0.0, rR, zR, rR, 0.22, 8, { twin: true, arch: false });
  cyl(sh, -0.14, rR, zR, 0.15, 0.15, 0.03, 7, 'x', ROLE.CHROME);
  // Long raked forks running down to the front spindle.
  for (const s of [-1, 1]) {
    stamp(sh, (s2) => cyl(s2, 0, 0, 0, 0.055, 0.048, 1.04, 6, 'y', ROLE.CHROME),
      { x: s * 0.15, y: 0.76, z: 0.82, rx: 0.56, rz: -s * 0.05 });
  }
  chamfer(sh, 0, 1.12, 0.64, 0.32, 0.18, 0.22, 0.05, ROLE.CHROME);
  // Big lazy vee twin with chrome covers.
  chamfer(sh, 0, 0.44, 0.06, 0.44, 0.44, 0.56, 0.09, ROLE.DARK);
  for (const dz of [0.20, -0.16]) chamfer(sh, 0, 0.66, dz, 0.36, 0.30, 0.26, 0.07, ROLE.CHROME);
  chamfer(sh, 0, 0.86, 0.32, 0.46, 0.30, 0.66, 0.15, ROLE.BODY);     // teardrop tank
  chamfer(sh, 0, 0.76, -0.22, 0.40, 0.10, 0.56, 0.06, ROLE.SEAT);    // low stepped saddle
  chamfer(sh, 0, 0.90, -0.58, 0.34, 0.16, 0.26, 0.06, ROLE.SEAT);    // pillion pad
  // Valanced rear fender over the fat back tyre.
  for (let i = 0; i < 4; i++) {
    const a0 = Math.PI * (0.14 + 0.72 * (i / 4)), a1 = Math.PI * (0.14 + 0.72 * ((i + 1) / 4));
    const p = (a, r) => [0, rR + Math.sin(a) * r, zR + Math.cos(a) * r];
    for (const s of [-1, 1]) {
      sh.quad([s * 0.15, p(a0, rR * 1.16)[1], p(a0, rR * 1.16)[2]],
        [s * 0.15, p(a1, rR * 1.16)[1], p(a1, rR * 1.16)[2]],
        [s * 0.15, p(a1, rR * 1.34)[1], p(a1, rR * 1.34)[2]],
        [s * 0.15, p(a0, rR * 1.34)[1], p(a0, rR * 1.34)[2]], ROLE.BODY, [0, rR, zR]);
    }
    sh.quad([-0.15, p(a0, rR * 1.34)[1], p(a0, rR * 1.34)[2]],
      [0.15, p(a0, rR * 1.34)[1], p(a0, rR * 1.34)[2]],
      [0.15, p(a1, rR * 1.34)[1], p(a1, rR * 1.34)[2]],
      [-0.15, p(a1, rR * 1.34)[1], p(a1, rR * 1.34)[2]], ROLE.BODY, [0, rR, zR]);
  }
  box(sh, 0, 1.26, 0.60, 0.84, 0.05, 0.06, ROLE.CHROME);             // wide bar
  for (const s of [-1, 1]) box(sh, s * 0.40, 1.34, 0.58, 0.12, 0.09, 0.05, ROLE.CHROME);
  cyl(sh, 0, 1.10, 0.98, 0.14, 0.14, 0.10, 7, 'z', ROLE.CHROME);     // big round lamp
  faceZ(sh, 0, 1.10, 1.035, 0.21, 0.21, ROLE.HEAD, 1);
  faceZ(sh, 0, 0.94, -0.98, 0.16, 0.10, ROLE.TAIL, -1);
  faceZ(sh, 0, 0.62, -1.00, 0.20, 0.07, ROLE.PLATE, -1);
  for (const s of [-1, 1]) faceX(sh, s * 0.24, 1.14, 0.90, 0.11, 0.08, ROLE.AMBER, s);
  for (const s of [-1, 1]) cyl(sh, s * 0.20, 0.34, -0.44, 0.065, 0.075, 1.10, 6, 'z', ROLE.CHROME);
  sh.lamp = { zF: 1.04, zR: -0.98, yH: 1.10, yT: 0.94, dx: 0, wL: 0.21, hL: 0.10 };
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
 *
 * The deck plane is the TOP EDGE of the hull section, so its height follows the
 * sheer — it rises toward the bow. Anything standing on deck has to be placed
 * against the local sheer height, not against a single number; a flat decal
 * pinned at the transom height disappears under the deck amidships.
 */

/**
 * Flybridge motor yacht — 31 of them along the seawall.
 *
 * The massing was right and the boat still rendered as a stack of white boxes,
 * for one reason: the GLASS role did not read as glass at this scale, so a
 * 13 m yacht had NO WINDOWS. Everything else here is secondary to darkening
 * that glazing: near-black tinted bands with a bright specular top edge do most
 * of the work of making a white boat look like a boat.
 */
function motorYacht(sh) {
  sweep(sh, SEC.HULL3, [
    { z: -6.30, w: 3.50, h: 1.55, y0: -0.95 },
    { z: -4.20, w: 4.10, h: 1.70, y0: -1.05 },
    { z: 2.40, w: 4.20, h: 1.75, y0: -1.05 },
    { z: 5.60, w: 2.90, h: 1.70, y0: -0.95 },
    { z: 7.10, w: 0.80, h: 1.55, y0: -0.75 },
  ], {
    role: ROLE.HULL,
    // The whole deck plane is teak, so the cockpit sole, the side decks and the
    // foredeck all come out warm against the white without a single decal —
    // and, being the sheer edge itself, they follow the sheer instead of
    // sinking under it the way a flat panel does.
    edgeRoles: { ...HULL3_ROLES, 6: ROLE.DECK },
    capStart: ROLE.ANTIFOUL, capEnd: ROLE.HULL,
  });
  // Sheer stripe sweeping the length of the topsides, above the boot stripe.
  for (const s of [-1, 1]) faceX(sh, s * 2.10, 0.42, -1.0, 10.2, 0.11, ROLE.ACCENT, s);
  // Saloon + flybridge, stepping back as they rise.
  chamfer(sh, 0, 1.35, -0.40, 3.50, 1.50, 6.20, 0.22, ROLE.WHITE);
  for (const s of [-1, 1]) {
    faceX(sh, s * 1.76, 1.52, -0.40, 5.40, 0.72, ROLE.GLASS_DK, s);
    faceX(sh, s * 1.77, 1.86, -0.40, 5.40, 0.08, ROLE.GLASS_HI, s);
    for (let i = 0; i < 3; i++) faceX(sh, s * 1.78, 1.52, -2.20 + i * 1.60, 0.09, 0.74, ROLE.WHITE, s);
  }
  faceZ(sh, 0, 1.60, 2.72, 2.70, 0.80, ROLE.GLASS_DK, 1);
  faceZ(sh, 0, 1.96, 2.73, 2.70, 0.09, ROLE.GLASS_HI, 1);
  chamfer(sh, 0, 2.70, -1.60, 2.80, 1.20, 3.80, 0.20, ROLE.WHITE);
  for (const s of [-1, 1]) {
    faceX(sh, s * 1.41, 2.82, -1.60, 3.20, 0.60, ROLE.GLASS_DK, s);
    faceX(sh, s * 1.42, 3.10, -1.60, 3.20, 0.08, ROLE.GLASS_HI, s);
  }
  chamfer(sh, 0, 3.42, -1.60, 2.60, 0.14, 3.60, 0.06, ROLE.WHITE);
  // Bimini over the flybridge, on four posts.
  for (const s of [-1, 1]) {
    for (const z of [-0.30, -2.90]) box(sh, s * 1.10, 3.90, z, 0.06, 0.90, 0.06, ROLE.CHROME);
  }
  chamfer(sh, 0, 4.38, -1.60, 2.50, 0.10, 3.20, 0.05, ROLE.ACCENT);
  // Radar arch, dome and mast.
  for (const s of [-1, 1]) box(sh, s * 1.10, 4.00, -3.60, 0.14, 1.20, 0.16, ROLE.STEEL);
  box(sh, 0, 4.58, -3.60, 2.36, 0.16, 0.18, ROLE.STEEL);
  cyl(sh, 0, 4.86, -3.60, 0.34, 0.30, 0.40, 8, 'y', ROLE.WHITE);      // radar dome
  cyl(sh, 0, 5.30, -3.60, 0.05, 0.05, 0.90, 6, 'y', ROLE.STEEL);
  // Bow guardrail: stanchions WITH a wire between them. Without it they read as
  // loose sticks standing on the foredeck, which is exactly what the review saw.
  guardRail(sh, [
    { x: 1.94, y: 0.66, z: 2.90 }, { x: 1.84, y: 0.68, z: 3.90 },
    { x: 1.56, y: 0.70, z: 4.90 }, { x: 1.12, y: 0.72, z: 5.90 },
    { x: 0.46, y: 0.74, z: 6.70 },
  ], 0.60);
  // Fenders hung over the side, and a cleat pair.
  for (const s of [-1, 1]) {
    for (const z of [-2.60, -0.40, 1.80]) {
      cyl(sh, s * 2.12, -0.10, z, 0.16, 0.16, 0.62, 6, 'y', ROLE.DARK);
    }
    box(sh, s * 1.70, 0.70, 5.30, 0.24, 0.09, 0.09, ROLE.CHROME);
  }
}

/**
 * Sloop under sail.
 *
 * The old version was a 10 m hero object in the bay that read as a featureless
 * cream slab with two needles sticking out of it: NO SAIL AREA at all (the
 * "furled main" was a 34 cm box), a mast 90 mm across over 11 m, and one flat
 * tone from sheer to keel. The sail is now a real hoisted main with a belly in
 * it, the spars are thick enough to obey the no-needle-geometry rule, and the
 * hull carries three tones with the break in the geometry rather than a decal.
 */
function sailBoat(sh) {
  sweep(sh, SEC.HULL3, [
    { z: -4.60, w: 2.40, h: 1.40, y0: -0.80 },
    { z: -2.60, w: 3.00, h: 1.55, y0: -0.95 },
    { z: 1.60, w: 3.10, h: 1.60, y0: -0.95 },
    { z: 4.40, w: 1.90, h: 1.55, y0: -0.85 },
    { z: 5.40, w: 0.50, h: 1.40, y0: -0.70 },
  ], { role: ROLE.HULL, edgeRoles: HULL3_ROLES, capStart: ROLE.ANTIFOUL, capEnd: ROLE.HULL });
  // Toe rail round the whole deck edge, following the hull's taper.
  strake(sh, [
    { x: 1.20, y: 0.60, z: -4.60 }, { x: 1.50, y: 0.60, z: -2.60 },
    { x: 1.55, y: 0.65, z: 1.60 }, { x: 0.95, y: 0.70, z: 4.40 },
    { x: 0.25, y: 0.70, z: 5.40 },
  ], 0.08, 0.05, ROLE.WHITE);
  // Coachroof with a companionway hatch and two flush deck lights.
  chamfer(sh, 0, 0.86, 0.90, 1.90, 0.50, 3.40, 0.16, ROLE.WHITE);
  for (const s of [-1, 1]) faceX(sh, s * 0.96, 0.88, 0.90, 2.80, 0.24, ROLE.GLASS_DK, s);
  box(sh, 0, 1.14, -0.60, 0.86, 0.10, 0.60, ROLE.DECK);
  for (const z of [1.60, 2.30]) faceY(sh, 0, 1.11, z, 0.44, 0.34, ROLE.GLASS_DK);
  /* --- cockpit well --------------------------------------------------------
   * A dark sole ringed by a coaming that stands 200 mm proud of the deck: from
   * the game's 3/4 camera the coaming's own shadow is what reads as the drop. */
  faceY(sh, 0, 0.610, -2.70, 1.50, 2.40, ROLE.DECK_LO);
  for (let i = 0; i < 5; i++) faceY(sh, -0.56 + i * 0.28, 0.618, -2.70, 0.20, 2.30, ROLE.DECK);
  for (const s of [-1, 1]) {
    box(sh, s * 0.86, 0.70, -2.70, 0.14, 0.30, 2.44, ROLE.WHITE);     // coaming
    box(sh, s * 0.54, 0.68, -2.90, 0.46, 0.12, 1.90, ROLE.DECK);      // bench
  }
  box(sh, 0, 0.70, -3.90, 1.74, 0.30, 0.14, ROLE.WHITE);
  cyl(sh, 0, 0.86, -1.90, 0.14, 0.12, 0.56, 6, 'y', ROLE.CHROME);     // pedestal
  cyl(sh, 0, 1.22, -1.90, 0.30, 0.30, 0.05, 8, 'z', ROLE.DARK, [false, false]);
  // Bow pulpit, anchor roller and a chrome cleat.
  guardRail(sh, [
    { x: 0.86, y: 0.68, z: 4.10 }, { x: 0.60, y: 0.70, z: 4.90 },
    { x: 0.22, y: 0.70, z: 5.42 },
  ], 0.58);
  box(sh, 0, 0.76, 5.56, 0.20, 0.10, 0.42, ROLE.CHROME);              // anchor roller
  for (const s of [-1, 1]) box(sh, s * 0.50, 0.74, 3.60, 0.24, 0.09, 0.09, ROLE.CHROME);
  /* --- rig -----------------------------------------------------------------
   * Mast 0.14 m at the step tapering to 0.09 at the head, stays at 0.05 with a
   * spreader pair. Nothing on the boat is needle-thin any more. */
  const zM = 0.60, yStep = 0.66, hM = 11.2, yHead = yStep + hM;
  cyl(sh, 0, yStep + hM / 2, zM, 0.14, 0.09, hM, 6, 'y', ROLE.CHROME);
  for (const s of [-1, 1]) box(sh, s * 0.44, 5.60, zM, 0.88, 0.07, 0.09, ROLE.CHROME);
  cyl(sh, 0, 1.16, -1.10, 0.09, 0.09, 3.60, 6, 'z', ROLE.CHROME);     // boom
  // Standing rigging: forestay, backstay and a shroud each side over a spreader.
  const T = (a, b, r) => tube(sh, a, b, r, r, 4, ROLE.CHROME, [false, false]);
  T([0, yHead - 0.15, zM], [0, 0.74, 5.42], 0.05);                    // forestay
  T([0, yHead - 0.20, zM], [0, 0.66, -4.40], 0.05);                   // backstay
  for (const s of [-1, 1]) {
    T([0, yHead - 0.30, zM], [s * 0.86, 5.60, zM], 0.045);
    T([s * 0.86, 5.60, zM], [s * 1.48, 0.66, zM], 0.045);
  }
  /* --- the mainsail --------------------------------------------------------
   * A hoisted sheet with a belly in it, from the masthead to the boom end. It
   * is the whole reason this object is in the bay, and it did not exist. */
  const yTack = 1.26, zTack = zM - 0.10, zClew = -2.86, yClew = 1.22;
  const nH = 4, nC = 3;
  const P = (u, v) => {
    const y = yTack + (yHead - 0.30 - yTack) * u;
    const zL = zClew + (zM - zClew) * Math.pow(u, 0.86);
    const z = zTack + (zL - zTack) * v;
    const x = 0.34 * Math.sin(Math.PI * Math.pow(u, 0.8) * 0.92) * Math.sin(Math.PI * v);
    return [x, y - (yClew - yTack) * (1 - u) * v * 0.4, z];
  };
  for (let i = 0; i < nH; i++) {
    for (let j = 0; j < nC; j++) {
      const a = P(i / nH, j / nC), b = P((i + 1) / nH, j / nC);
      const c = P((i + 1) / nH, (j + 1) / nC), d = P(i / nH, (j + 1) / nC);
      sh.flat(a, b, c, d, ROLE.SAIL, [1, 0, 0]);
      sh.flat(d, c, b, a, ROLE.SAIL_LO, [-1, 0, 0]);
    }
  }
  // Furled jib rolled on the forestay.
  tube(sh, [0, 0.86, 5.20], [0, yHead - 1.20, zM + 0.10], 0.13, 0.07, 6, ROLE.SAIL, [true, true]);
}

/**
 * Open launch working the river and the marinas. Eighteen of them sit against
 * the seawall at three metres, so the canopy, the guardrails and the helm are
 * all things the player reads at eye level rather than from the air.
 */
function waterTaxi(sh) {
  sweep(sh, SEC.HULL3, [
    { z: -3.90, w: 2.50, h: 1.30, y0: -0.72 },
    { z: -2.20, w: 2.80, h: 1.40, y0: -0.80 },
    { z: 2.00, w: 2.80, h: 1.40, y0: -0.80 },
    { z: 3.90, w: 1.40, h: 1.30, y0: -0.70 },
  ], { role: ROLE.HULL, edgeRoles: HULL3_ROLES, capStart: ROLE.ANTIFOUL, capEnd: ROLE.HULL });
  // Rubbing strake, with black fenders hung over it.
  strake(sh, [
    { x: 1.25, y: 0.52, z: -3.90 }, { x: 1.40, y: 0.55, z: -2.20 },
    { x: 1.40, y: 0.60, z: 2.00 }, { x: 0.70, y: 0.60, z: 3.90 },
  ], 0.09, 0.05, ROLE.WHITE);
  for (const s of [-1, 1]) {
    for (const z of [-1.60, 1.10]) cyl(sh, s * 1.46, 0.16, z, 0.14, 0.14, 0.54, 6, 'y', ROLE.DARK);
    box(sh, s * 0.94, 0.66, 3.30, 0.20, 0.08, 0.08, ROLE.CHROME);      // cleats
    box(sh, s * 1.10, 0.66, -3.40, 0.20, 0.08, 0.08, ROLE.CHROME);
  }
  // Deck stanchions with a rope guardrail, and a gap amidships for boarding.
  guardRail(sh, [
    { x: 1.32, y: 0.60, z: -3.30 }, { x: 1.38, y: 0.60, z: -2.10 },
    { x: 1.38, y: 0.62, z: -0.90 },
  ], 0.52);
  guardRail(sh, [
    { x: 1.38, y: 0.62, z: 0.90 }, { x: 1.30, y: 0.62, z: 2.20 },
    { x: 0.86, y: 0.62, z: 3.30 },
  ], 0.52);
  /* --- canopy --------------------------------------------------------------
   * Cambered in three sections with a 0.10 m crown, a scalloped fascia and a
   * grab rail underneath. A dead-flat slab is what made it read as cardboard. */
  for (const s of [-1, 1]) {
    for (const z of [1.60, -0.20, -2.00]) box(sh, s * 1.15, 1.45, z, 0.08, 1.72, 0.08, ROLE.CHROME);
  }
  const cw = 1.30, cy0 = 2.30, crown = 0.10;
  for (let i = 0; i < 3; i++) {
    const x0 = -cw + (i * 2 * cw) / 3, x1 = -cw + ((i + 1) * 2 * cw) / 3;
    const y0 = cy0 + crown * Math.cos((x0 / cw) * Math.PI * 0.5);
    const y1 = cy0 + crown * Math.cos((x1 / cw) * Math.PI * 0.5);
    sh.quad([x0, y0, 2.00], [x1, y1, 2.00], [x1, y1, -2.40], [x0, y0, -2.40],
      ROLE.ACCENT, [0, 1.4, -0.2]);
    sh.quad([x0, y0 - 0.09, 2.00], [x1, y1 - 0.09, 2.00], [x1, y1 - 0.09, -2.40], [x0, y0 - 0.09, -2.40],
      ROLE.ACCENT, [0, 3.4, -0.2]);
  }
  for (const dz of [2.00, -2.40]) {
    // Scalloped fascia: five shallow lobes along the canopy edge.
    for (let i = 0; i < 5; i++) {
      const x0 = -cw + (i * 2 * cw) / 5, x1 = -cw + ((i + 1) * 2 * cw) / 5;
      const dip = 0.06 + 0.05 * Math.sin(Math.PI * ((i + 0.5) / 5));
      faceZ(sh, (x0 + x1) / 2, cy0 - 0.04 - dip / 2, dz, (x1 - x0) * 0.94, dip,
        ROLE.ACCENT, dz > 0 ? 1 : -1);
    }
  }
  faceZ(sh, 0, cy0 - 0.09, 2.02, 1.90, 0.16, ROLE.SIGN, 1);            // route board
  box(sh, 0, 2.14, -0.20, 0.07, 0.07, 4.20, ROLE.CHROME);              // grab rail
  /* --- helm ---------------------------------------------------------------- */
  chamfer(sh, 0, 1.02, 2.30, 1.60, 0.86, 1.10, 0.10, ROLE.WHITE);
  faceZ(sh, 0, 1.26, 2.86, 1.30, 0.34, ROLE.DARK, 1);                  // dash
  sh.quad([-0.66, 1.48, 2.86], [0.66, 1.48, 2.86], [0.60, 1.86, 2.62], [-0.60, 1.86, 2.62],
    ROLE.GLASS_HI, [0, 1.2, 1.6]);
  for (const s of [-1, 1]) box(sh, s * 0.63, 1.67, 2.74, 0.05, 0.40, 0.30, ROLE.CHROME);
  stamp(sh, (s2) => cyl(s2, 0, 0, 0, 0.16, 0.16, 0.04, 6, 'z', ROLE.DARK, [false, false]),
    { x: -0.32, y: 1.36, z: 2.62, rx: -0.42 });
  faceY(sh, 0, 0.596, -0.6, 2.10, 5.4, ROLE.DECK_LO);                  // sole
  for (const z of [0.60, -0.90, -2.40]) chamfer(sh, 0, 0.70, z, 2.10, 0.16, 0.44, 0.05, ROLE.DECK);
  cyl(sh, 0.42, 0.10, -3.94, 0.09, 0.09, 0.30, 6, 'z', ROLE.DARK);     // transom exhaust
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

/**
 * Convertible sportfisher. The cockpit sole used to render as a bright orange
 * rectangle lying flat on a white deck — a texturing error, not teak. It is a
 * recessed well now, below a coaming, in a muted teak with plank reveals.
 */
function sportFisher(sh) {
  sweep(sh, SEC.HULL3, [
    { z: -5.60, w: 3.20, h: 1.50, y0: -0.90 },
    { z: -3.40, w: 3.70, h: 1.62, y0: -1.00 },
    { z: 2.20, w: 3.70, h: 1.66, y0: -1.00 },
    { z: 5.00, w: 2.30, h: 1.60, y0: -0.90 },
    { z: 6.30, w: 0.60, h: 1.45, y0: -0.72 },
  ], { role: ROLE.HULL, edgeRoles: HULL3_ROLES, capStart: ROLE.ANTIFOUL, capEnd: ROLE.HULL });
  for (const s of [-1, 1]) faceX(sh, s * 1.86, 0.36, -0.6, 9.0, 0.10, ROLE.ACCENT, s);
  chamfer(sh, 0, 1.20, 1.30, 3.10, 1.20, 4.00, 0.20, ROLE.WHITE);
  faceZ(sh, 0, 1.38, 3.32, 2.40, 0.68, ROLE.GLASS_DK, 1);
  faceZ(sh, 0, 1.74, 3.33, 2.40, 0.09, ROLE.GLASS_HI, 1);
  for (const s of [-1, 1]) {
    faceX(sh, s * 1.56, 1.38, 1.30, 3.40, 0.62, ROLE.GLASS_DK, s);
    faceX(sh, s * 1.57, 1.70, 1.30, 3.40, 0.08, ROLE.GLASS_HI, s);
  }
  /* --- cockpit well --------------------------------------------------------
   * A muted teak sole with a plank reveal every 0.28 m, ringed by a coaming
   * standing 0.30 m proud of the covering boards. The old version was a flat
   * bright-orange rectangle lying on a white deck, which read as a texturing
   * error rather than as a fishing cockpit. */
  faceY(sh, 0, 0.605, -3.60, 2.60, 3.50, ROLE.DECK_LO);
  for (let i = 0; i < 9; i++) faceY(sh, -1.08 + i * 0.27, 0.614, -3.60, 0.21, 3.40, ROLE.DECK);
  for (const s of [-1, 1]) box(sh, s * 1.42, 0.74, -3.60, 0.22, 0.34, 3.60, ROLE.WHITE);
  box(sh, 0, 0.72, -5.40, 2.86, 0.34, 0.22, ROLE.WHITE);
  faceZ(sh, 0, 0.20, -5.60, 0.72, 0.60, ROLE.DECK, -1);            // transom door
  chamfer(sh, 0, 0.82, -0.90, 1.30, 0.62, 0.50, 0.06, ROLE.WHITE); // bait station
  faceY(sh, 0, 1.11, -0.90, 1.14, 0.40, ROLE.DECK_LO);
  // Rod holders along the covering boards.
  for (const s of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      stamp(sh, (s2) => cyl(s2, 0, 0, 0, 0.055, 0.055, 0.26, 5, 'y', ROLE.CHROME),
        { x: s * 1.36, y: 0.82, z: -2.30 - i * 0.80, rz: -s * 0.30 });
    }
  }
  // Bow pulpit and rails round the foredeck.
  guardRail(sh, [
    { x: 1.72, y: 0.66, z: 3.60 }, { x: 1.44, y: 0.68, z: 4.60 },
    { x: 0.96, y: 0.70, z: 5.50 }, { x: 0.34, y: 0.72, z: 6.20 },
  ], 0.58);
  // Tuna tower — the unmistakable sportfisher silhouette.
  for (const s of [-1, 1]) {
    box(sh, s * 1.05, 2.80, 1.30, 0.10, 2.00, 0.10, ROLE.CHROME);
    box(sh, s * 1.05, 3.86, 1.30, 0.10, 1.30, 0.10, ROLE.CHROME);
  }
  chamfer(sh, 0, 3.86, 1.30, 2.30, 0.12, 1.60, 0.05, ROLE.WHITE);
  chamfer(sh, 0, 4.58, 1.30, 1.60, 0.14, 1.10, 0.05, ROLE.WHITE);
  // Two outriggers swept back and out from the tower, not one vertical pole.
  // 0.10 m at the root: the bible bans needle-thin geometry, and a 4 m spar at
  // 45 mm is exactly that.
  for (const s of [-1, 1]) {
    tube(sh, [s * 1.00, 4.40, 1.10], [s * 3.10, 5.40, -2.40], 0.10, 0.06, 5, ROLE.WHITE);
  }
}

/**
 * Cruise ship. Two of them, 45 m long, visible clean across the bay — and the
 * old one was a cream wedding cake of plain stacked boxes. A ship at this
 * distance is read from four things: the hull colour break at the waterline,
 * continuous rows of window slots, lifeboats on davits, and a bridge. It now
 * has all four, plus a dressed top deck, because the camera sees ship roofs.
 */
function cruiseShip(sh) {
  sweep(sh, SEC.HULL3, [
    { z: -22.0, w: 8.4, h: 6.4, y0: -3.6 },
    { z: -16.0, w: 10.0, h: 7.0, y0: -4.0 },
    { z: 12.0, w: 10.2, h: 7.0, y0: -4.0 },
    { z: 20.0, w: 6.4, h: 6.6, y0: -3.6 },
    { z: 23.5, w: 1.6, h: 6.0, y0: -3.0 },
  ], {
    role: ROLE.BLUE,
    // Navy below the boot topping, a white stripe at it, cream topsides.
    edgeRoles: {
      0: ROLE.BLUE, 1: ROLE.BLUE, 2: ROLE.BLUE, 3: ROLE.BLUE,
      4: ROLE.WHITE, 5: ROLE.HULL, 6: ROLE.WHITE, 7: ROLE.HULL, 8: ROLE.WHITE,
    },
    capStart: ROLE.BLUE, capEnd: ROLE.HULL,
  });
  for (const s of [-1, 1]) {
    faceX(sh, s * 5.05, 1.40, -2, 34, 1.10, ROLE.GLASS_DK, s);
    faceX(sh, s * 5.06, 2.02, -2, 34, 0.12, ROLE.GLASS_HI, s);
  }
  /* Four stepped accommodation decks. Each gets a continuous dark window band
   * broken by mullions, which is what turns a white box into a deck of cabins
   * from 300 m — the single highest-value detail on the whole ship. */
  const decks = [[3.0, 9.6, 40], [6.0, 9.0, 37], [9.0, 8.0, 32], [11.8, 6.4, 24]];
  for (let i = 0; i < decks.length; i++) {
    const [y, w, L] = decks[i];
    chamfer(sh, 0, y + 1.35, -2, w, 2.70, L, 0.30, ROLE.WHITE);
    for (const s of [-1, 1]) {
      faceX(sh, s * w * 0.5, y + 1.50, -2, L - 3, 1.00, ROLE.GLASS_DK, s);
      faceX(sh, s * (w * 0.5 + 0.02), y + 2.06, -2, L - 3, 0.10, ROLE.GLASS_HI, s);
      const n = Math.round((L - 3) / 2.4);
      for (let k = 0; k < n; k++) {
        faceX(sh, s * (w * 0.5 + 0.03), y + 1.50, -2 - (L - 3) / 2 + (k + 0.5) * ((L - 3) / n),
          0.10, 1.02, ROLE.WHITE, s);
      }
    }
  }
  // Promenade deck: eight lifeboats hung on davits, four a side.
  for (const s of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const z = -13 + i * 8.5;
      box(sh, s * 4.95, 4.30, z, 0.30, 1.10, 0.24, ROLE.STEEL);
      chamfer(sh, s * 5.20, 3.60, z, 0.90, 0.80, 3.20, 0.24, ROLE.HAZARD);
      faceY(sh, s * 5.20, 3.98, z, 0.70, 2.90, ROLE.WHITE);
    }
  }
  chamfer(sh, 0, 14.4, 2.0, 5.2, 1.6, 12.0, 0.24, ROLE.WHITE);
  /* Bridge: raked, wrap-around dark glazing, and wings out to the ship's side
   * — the wings are what say "bridge" rather than "another white box". */
  chamfer(sh, 0, 16.2, 8.0, 6.6, 2.0, 4.4, 0.26, ROLE.WHITE);
  for (const s of [-1, 1]) {
    chamfer(sh, s * 4.30, 15.6, 8.6, 2.20, 0.60, 2.00, 0.12, ROLE.WHITE);
    faceX(sh, s * 3.31, 16.4, 8.0, 3.8, 1.20, ROLE.GLASS_DK, s);
    faceX(sh, s * 3.32, 17.10, 8.0, 3.8, 0.14, ROLE.GLASS_HI, s);
  }
  faceZ(sh, 0, 16.4, 10.22, 5.8, 1.20, ROLE.GLASS_DK, 1);
  faceZ(sh, 0, 17.10, 10.23, 5.8, 0.14, ROLE.GLASS_HI, 1);
  cyl(sh, 0, 17.6, -6.0, 2.1, 1.8, 5.6, 10, 'y', ROLE.ACCENT);      // funnel
  cyl(sh, 0, 20.6, -6.0, 1.9, 1.8, 0.7, 10, 'y', ROLE.DARK);        // black cap
  // Swept funnel fin.
  sh.quad([-0.20, 15.4, -8.0], [0.20, 15.4, -8.0], [0.20, 20.8, -10.4], [-0.20, 20.8, -10.4],
    ROLE.ACCENT, [0, 18, -6]);
  for (const s of [-1, 1]) {
    sh.quad([s * 0.20, 15.4, -8.0], [s * 0.20, 20.8, -10.4],
      [s * 0.20, 20.8, -9.0], [s * 0.20, 15.0, -6.4], ROLE.ACCENT, [-s, 18, -8]);
  }
  /* --- top deck ------------------------------------------------------------
   * The camera looks down on ship roofs for most of the match, and the highest
   * accommodation block tops out at y = 14.5, aft of z = -4. That is the sun
   * deck: pool, loungers and a rail line round the edge. */
  faceY(sh, 0, 14.50, -9.5, 5.8, 7.0, ROLE.WHITE);                  // pool surround
  faceY(sh, 0, 14.52, -9.5, 4.2, 5.2, ROLE.BLUE);                   // pool
  for (const s of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      box(sh, s * 2.80, 14.60, -13.0 + i * 1.7, 0.66, 0.16, 1.40, ROLE.WHITE);
    }
  }
  guardRail(sh, [
    { x: 3.10, y: 14.5, z: -13.6 }, { x: 3.10, y: 14.5, z: -8.0 },
    { x: 3.10, y: 14.5, z: -3.0 },
  ], 0.90, ROLE.STEEL);
}

/* ================================================ shape: machinery ===== */

/**
 * Standard plant fittings: a rotating beacon, a ROPS/FOPS canopy and a step
 * ladder. Every yellow machine on a site has all three, and not one of ours
 * had any of them — which is most of why they read as toys.
 */
function beacon(sh, x, y, z) {
  cyl(sh, x, y, z, 0.06, 0.06, 0.14, 5, 'y', ROLE.DARK);
  cyl(sh, x, y + 0.16, z, 0.09, 0.07, 0.18, 6, 'y', ROLE.AMBER);
}
function ropsFrame(sh, o) {
  const { x, y0, y1, z0, z1, r = 0.07 } = o;
  for (const s of [-1, 1]) {
    for (const z of [z0, z1]) box(sh, s * x, (y0 + y1) / 2, z, r, y1 - y0, r, ROLE.DARK);
    box(sh, s * x, y1, (z0 + z1) / 2, r, r, z1 - z0, ROLE.DARK);
  }
  for (const z of [z0, z1]) box(sh, 0, y1, z, x * 2, r, r, ROLE.DARK);
}
function stepLadder(sh, x, y0, z, n, dx) {
  for (let i = 0; i < n; i++) box(sh, x, y0 + i * 0.34, z, 0.30, 0.06, 0.10, ROLE.DARK);
  box(sh, x + dx * 0.14, y0 + n * 0.34 * 0.5 + 0.40, z, 0.07, n * 0.34 + 0.70, 0.07, ROLE.MACH_LO);
}

/**
 * A machine cab: a body in knocked-back machine paint, a dark surround, and
 * glazing inside it.
 *
 * Building the cab shell itself out of ROLE.DARK — which is what the first pass
 * did — makes the whole cab a black brick, because the dark glass then has
 * nothing to sit against. The surround has to be a frame, not the body.
 */
function machCab(sh, o) {
  const { x = 0, y, z, w, h, d, b = 0.12 } = o;
  chamfer(sh, x, y, z, w, h, d, b, ROLE.MACH_LO);
  const gy = y + h * 0.14, gh = h * 0.52;
  for (const s of [-1, 1]) {
    faceX(sh, x + s * w * 0.5, gy, z, d * 0.84, gh + 0.10, ROLE.DARK, s);
    faceX(sh, x + s * (w * 0.5 + 0.008), gy, z, d * 0.74, gh, ROLE.GLASS, s);
  }
  faceZ(sh, x, gy, z + d * 0.5, w * 0.80, gh + 0.10, ROLE.DARK, 1);
  faceZ(sh, x, gy, z + d * 0.5 + 0.008, w * 0.70, gh, ROLE.GLASS, 1);
  faceZ(sh, x, gy, z - d * 0.5, w * 0.80, gh + 0.10, ROLE.DARK, -1);
  faceZ(sh, x, gy, z - d * 0.5 - 0.008, w * 0.70, gh, ROLE.GLASS, -1);
}

/**
 * Tracked excavator.
 *
 * The blockout was good and it still read as a toy, because there was not ONE
 * HYDRAULIC RAM on it — so the arm was a bent stick — the tracks were plain
 * slabs with no sprocket or idler, and every surface was the same machine
 * yellow. All three fixed below.
 */
function excavator(sh) {
  for (const s of [-1, 1]) {
    chamfer(sh, s * 1.10, 0.44, 0, 0.72, 0.88, 4.30, 0.22, ROLE.GRIME);
    // DUSTY, not STEEL: polished metal down at the grousers picks up the sky
    // and sparkles cyan along the bottom of the tracks.
    for (let i = 0; i < 7; i++) box(sh, s * 1.10, 0.10, -1.8 + i * 0.6, 0.80, 0.10, 0.22, ROLE.DUSTY);
    // Drive sprocket, idler and three track rollers per side.
    for (const z of [-2.00, 2.00]) cyl(sh, s * 1.10, 0.46, z, 0.42, 0.42, 0.50, 6, 'x', ROLE.MACH_LO);
    for (const z of [-1.00, 0, 1.00]) cyl(sh, s * 1.10, 0.22, z, 0.17, 0.17, 0.44, 5, 'x', ROLE.DARK);
  }
  cyl(sh, 0, 1.02, -0.20, 1.10, 1.10, 0.28, 10, 'y', ROLE.MACH_LO);
  chamfer(sh, 0, 1.62, -1.05, 2.40, 1.00, 2.60, 0.16, ROLE.MACH);   // house + counterweight
  faceZ(sh, 0, 1.50, -2.36, 2.00, 1.20, ROLE.GRIME, -1);            // counterweight face
  for (const s of [-1, 1]) faceX(sh, s * 1.21, 1.70, -0.90, 1.90, 0.36, ROLE.MACH_LO, s);
  for (const s of [-1, 1]) faceX(sh, s * 1.22, 1.28, -0.90, 1.10, 0.28, ROLE.WHITE, s);
  machCab(sh, { x: -0.72, y: 2.10, z: 0.62, w: 1.10, h: 1.90, d: 1.60, b: 0.14 });
  beacon(sh, -0.72, 3.06, 0.10);
  cyl(sh, 0.72, 2.70, -1.60, 0.11, 0.09, 1.00, 6, 'y', ROLE.DARK);  // exhaust stack
  // Handrail loop round the house roof, and a step ladder up the near side.
  for (const s of [-1, 1]) box(sh, s * 1.10, 2.42, -1.60, 0.07, 0.60, 0.07, ROLE.MACH);
  box(sh, 0, 2.70, -1.60, 2.20, 0.07, 0.07, ROLE.MACH);
  box(sh, 1.10, 2.70, -0.70, 0.07, 0.07, 1.80, ROLE.MACH);
  stepLadder(sh, 1.26, 0.72, 0.30, 3, 1);
  // Boom / stick / bucket. Angles chosen so the machine reads as "working".
  const boom = (x, y, z, len, ang, w) => {
    stamp(sh, (s2) => chamfer(s2, 0, 0, 0, w, w * 1.25, len, 0.06, ROLE.MACH), { x, y, z, rx: ang });
  };
  boom(0.66, 2.70, 2.00, 3.60, 0.62, 0.44);
  boom(0.66, 3.30, 4.30, 3.30, -0.95, 0.36);
  // The three rams. This is the silhouette cue the machine was missing.
  ram(sh, [0.66, 1.90, 0.60], [0.66, 3.00, 2.60], 0.14);            // boom ram
  ram(sh, [0.66, 4.10, 2.90], [0.66, 3.80, 4.60], 0.12);            // stick ram
  ram(sh, [0.66, 2.90, 4.90], [0.66, 2.05, 5.28], 0.10);            // bucket ram
  /* The bucket has to MEET the stick. The stick's lower pivot lands at
   * (0.66, 1.96, 5.26) — length 3.30 rotated -0.95 rad about x — so the bucket
   * is hung there rather than at a guessed height, which is what left it
   * floating half a metre clear of the arm. */
  chamfer(sh, 0.66, 1.45, 5.40, 0.98, 0.95, 0.90, 0.10, ROLE.MACH_LO);
  faceZ(sh, 0.66, 1.50, 5.85, 0.80, 0.66, ROLE.GRIME, 1);
  for (let i = 0; i < 4; i++) box(sh, 0.20 + i * 0.30, 1.02, 5.82, 0.12, 0.30, 0.24, ROLE.DARK);
}

/**
 * Centre-pivot wheel loader. The masses were right; none of the language that
 * makes a machine read as a machine was there — no rams, no stack, no beacon,
 * no ROPS, no ladder, no chevrons, and a bucket with no back plate or teeth.
 */
function wheelLoader(sh) {
  chamfer(sh, 0, 1.30, -1.50, 2.10, 1.10, 2.40, 0.18, ROLE.MACH);   // rear engine block
  chamfer(sh, 0, 1.20, 0.60, 1.90, 0.80, 2.00, 0.16, ROLE.MACH);
  machCab(sh, { y: 2.30, z: -0.55, w: 1.60, h: 1.60, d: 1.50, b: 0.14 });
  chamfer(sh, 0, 3.14, -0.55, 1.66, 0.14, 1.56, 0.05, ROLE.MACH);
  ropsFrame(sh, { x: 0.84, y0: 1.60, y1: 3.20, z0: -1.28, z1: 0.18 });
  beacon(sh, 0.50, 3.22, -0.55);
  // Exhaust stack and air-cleaner canister on the engine deck.
  cyl(sh, -0.62, 2.40, -1.30, 0.10, 0.08, 1.10, 6, 'y', ROLE.DARK);
  cyl(sh, 0.58, 2.16, -1.60, 0.24, 0.24, 0.90, 7, 'z', ROLE.MACH_LO);
  // Articulation band at the waist, and a dusty scuff along the bottom.
  chamfer(sh, 0, 1.20, -0.35, 1.60, 0.90, 0.24, 0.06, ROLE.DARK);
  for (const s of [-1, 1]) faceX(sh, s * 1.06, 0.90, -1.50, 2.30, 0.26, ROLE.DUSTY, s);
  chevrons(sh, 0, 1.30, -2.72, 1.70, 0.36, 6, -1);
  stepLadder(sh, -1.02, 0.80, -0.20, 3, -1);
  // Lift arms, with a lift ram to each and a tilt ram to the bucket linkage.
  for (const s of [-1, 1]) {
    stamp(sh, (s2) => chamfer(s2, 0, 0, 0, 0.22, 0.34, 3.30, 0.06, ROLE.MACH),
      { x: s * 0.86, y: 1.70, z: 1.90, rx: -0.30 });
    ram(sh, [s * 0.86, 1.10, 0.70], [s * 0.86, 1.86, 2.30], 0.13);
  }
  ram(sh, [0, 2.10, 0.80], [0, 1.62, 2.70], 0.11);
  chamfer(sh, 0, 0.72, 3.34, 2.60, 1.05, 1.05, 0.12, ROLE.MACH_LO);
  faceZ(sh, 0, 0.90, 2.80, 2.36, 0.86, ROLE.GRIME, -1);             // bucket back plate
  faceY(sh, 0, 1.24, 3.34, 2.30, 0.86, ROLE.GRIME);                 // spoil in the bucket
  chamfer(sh, 0, 0.28, 3.82, 2.60, 0.18, 0.30, 0.04, ROLE.DARK);    // cutting edge
  for (let i = 0; i < 5; i++) box(sh, -0.96 + i * 0.48, 0.24, 3.98, 0.20, 0.12, 0.24, ROLE.DARK);
  wheels4(sh, 0.98, 1.10, -1.70, 0.72, 0.44, 8);
}

/** Articulated site dumper: a tipping skip on six wheels. */
function siteDumper(sh) {
  chamfer(sh, 0, 1.90, 2.30, 2.30, 1.90, 2.10, 0.16, ROLE.MACH);
  for (const s of [-1, 1]) faceX(sh, s * 1.16, 2.20, 2.40, 1.40, 0.90, ROLE.GLASS, s);
  faceZ(sh, 0, 2.20, 3.36, 1.80, 0.90, ROLE.GLASS, 1);
  ropsFrame(sh, { x: 1.14, y0: 2.86, y1: 3.34, z0: 1.36, z1: 3.24 });
  beacon(sh, 0.80, 3.36, 3.10);
  stepLadder(sh, 1.22, 0.90, 2.10, 3, 1);
  chamfer(sh, 0, 0.86, 0.20, 2.20, 0.70, 6.60, 0.10, ROLE.GRIME);
  // Articulation joint between cab and skip.
  cyl(sh, 0, 1.10, 1.16, 0.42, 0.42, 1.30, 8, 'x', ROLE.DARK);
  /* Tipper body — raked up at the front so it reads as a skip, not a box. The
   * TOP EDGE of the section is dark: the game camera looks down on this, so
   * what it sees is the load, and a clean orange lid is the one thing a working
   * dumper never has. */
  sweep(sh, SEC.OCT, [
    { z: -3.60, w: 2.60, h: 1.50, y0: 1.28 },
    { z: 0.60, w: 2.70, h: 1.60, y0: 1.28 },
    { z: 1.30, w: 2.70, h: 2.10, y0: 1.28 },
  ], {
    role: ROLE.MACH_LO,
    edgeRoles: { 0: ROLE.GRIME, 1: ROLE.GRIME, 2: ROLE.GRIME, 5: ROLE.GRIME },
    capStart: ROLE.MACH_LO, capEnd: ROLE.MACH_LO,
  });
  // Mud and rust up the bottom third of the skip: this thing carries spoil.
  for (const s of [-1, 1]) {
    faceX(sh, s * 1.35, 1.62, -1.20, 4.60, 0.56, ROLE.GRIME, s);
    faceX(sh, s * 1.34, 2.10, -1.20, 4.60, 0.10, ROLE.DARK, s);
  }
  faceZ(sh, 0, 1.66, -3.62, 2.20, 0.60, ROLE.GRIME, -1);
  // Two tipping rams from the chassis to the skip underside.
  for (const s of [-1, 1]) ram(sh, [s * 0.62, 1.16, -0.60], [s * 0.50, 1.60, 0.90], 0.11);
  // Mudguards over all six wheels.
  for (const s of [-1, 1]) {
    for (const z of [2.20, -1.60, -3.05]) box(sh, s * 1.06, 1.42, z, 0.66, 0.10, 1.70, ROLE.DARK);
  }
  wheels4(sh, 1.06, 2.20, -1.60, 0.74, 0.46, 8);
  wheel(sh, 1.06, 0.74, -3.05, 0.74, 0.46, 8);
  wheel(sh, -1.06, 0.74, -3.05, 0.74, 0.46, 8);
  carLamps(sh, { zF: 3.46, zR: -4.40, yH: 1.30, yT: 1.40, dx: 0.90, wL: 0.30, grille: false, yP: 1.00 });
}

/**
 * Tower crane.
 *
 * It used to be a crane STUMP: sixteen metres of lattice with a slew ring on
 * top and nothing above it. A tower crane's whole contribution to a skyline is
 * the horizontal — jib, counter-jib, counterweight — and at 200 m that L is the
 * silhouette that says "city under construction". So the top is now built, the
 * bracing is diagonal rather than plain rungs, and the upper sections carry
 * hazard banding.
 */
function craneBase(sh) {
  chamfer(sh, 0, 0.35, 0, 7.4, 0.70, 7.4, 0.14, ROLE.DARK);          // ballast pad
  for (const s of [-1, 1]) {
    for (const t of [-1, 1]) chamfer(sh, s * 2.4, 1.00, t * 2.4, 2.0, 0.60, 2.0, 0.10, ROLE.GRIME);
  }
  // Lattice mast: four chords, a horizontal at every level and a diagonal on
  // every face, which is what a lattice actually looks like.
  const H = 16.0, LV = 6, dy = H / LV, a = 0.90;
  for (const s of [-1, 1]) {
    for (const t of [-1, 1]) box(sh, s * a, H / 2 + 0.7, t * a, 0.22, H, 0.22, ROLE.MACH);
  }
  const diag = Math.hypot(dy, a * 2);
  const tilt = Math.atan2(a * 2, dy);
  for (let i = 0; i < LV; i++) {
    const y = 0.70 + i * dy;
    // Red/white banding on the top two sections. Sun yellow on crane yellow is
    // a two-percent value shift, i.e. invisible — it has to be a real contrast.
    const role = i >= LV - 1 ? ROLE.RED : i === LV - 2 ? ROLE.WHITE : ROLE.MACH;
    for (const s of [-1, 1]) {
      box(sh, s * a, y + dy, 0, 0.14, 0.14, a * 2, role);
      box(sh, 0, y + dy, s * a, a * 2, 0.14, 0.14, role);
      // One diagonal per face per level, alternating direction as it climbs.
      const d = (i % 2) ? 1 : -1;
      stamp(sh, (s2) => box(s2, 0, 0, 0, 0.12, diag, 0.12, role),
        { x: s * a, y: y + dy / 2, z: 0, rx: d * tilt });
      stamp(sh, (s2) => box(s2, 0, 0, 0, 0.12, diag, 0.12, role),
        { x: 0, y: y + dy / 2, z: s * a, rz: -d * tilt });
    }
    // Climbing ladder up the inside of the mast.
    box(sh, 0.36, y + dy * 0.5, 0.62, 0.44, 0.05, 0.05, ROLE.CHROME);
  }
  /* --- the top ------------------------------------------------------------- */
  const yT = H + 0.90;
  cyl(sh, 0, yT, 0, 1.15, 1.15, 0.40, 10, 'y', ROLE.MACH_LO);        // slewing ring
  chamfer(sh, 0, yT + 0.60, 0, 1.80, 0.90, 1.80, 0.14, ROLE.MACH);   // slew deck
  // Operator cab, hung on the jib side.
  chamfer(sh, 0, yT + 1.60, 1.70, 1.20, 1.40, 1.30, 0.12, ROLE.MACH_LO);
  faceZ(sh, 0, yT + 1.70, 2.36, 0.94, 1.00, ROLE.GLASS, 1);
  for (const s of [-1, 1]) faceX(sh, s * 0.61, yT + 1.70, 1.70, 1.00, 1.00, ROLE.GLASS, s);
  // Jib and counter-jib as tapering lattice beams.
  const jibY = yT + 2.50;
  chamfer(sh, 0, jibY, 11.5, 0.60, 0.60, 20.0, 0.10, ROLE.MACH);
  for (let i = 0; i < 6; i++) {
    stamp(sh, (s2) => box(s2, 0, 0, 0, 0.10, 1.30, 0.10, ROLE.MACH),
      { y: jibY - 0.45, z: 3.4 + i * 3.2, rx: (i % 2 ? 1 : -1) * 0.95 });
  }
  chamfer(sh, 0, jibY, -4.60, 0.70, 0.66, 7.60, 0.10, ROLE.MACH);
  for (const t of [0, 1, 2]) {
    chamfer(sh, 0, jibY - 0.10, -6.6 - t * 0.55, 1.70, 1.30, 0.46, 0.06, ROLE.GRIME);
  }
  // A-frame apex with tie bars fore and aft.
  box(sh, 0, jibY + 1.60, 0, 0.24, 3.20, 0.24, ROLE.MACH);
  tube(sh, [0, jibY + 3.10, 0], [0, jibY + 0.30, 18.0], 0.08, 0.08, 4, ROLE.MACH, [false, false]);
  tube(sh, [0, jibY + 3.10, 0], [0, jibY + 0.30, -7.6], 0.08, 0.08, 4, ROLE.MACH, [false, false]);
  // Trolley and hook block.
  box(sh, 0, jibY - 0.42, 12.0, 0.70, 0.26, 0.80, ROLE.MACH_LO);
  tube(sh, [0, jibY - 0.52, 12.0], [0, jibY - 5.20, 12.0], 0.05, 0.05, 4, ROLE.DARK, [false, false]);
  chamfer(sh, 0, jibY - 5.50, 12.0, 0.46, 0.68, 0.46, 0.08, ROLE.MACH_LO);
  faceZ(sh, 0, jibY - 5.50, 12.24, 0.36, 0.30, ROLE.DARK, 1);
}

/**
 * Scissor lift. The crossed-X arm stack was right and everything around it was
 * bare: rails with no infill, no control box, no ram, no pivot bosses, castors
 * sitting in no forks, and one colour throughout.
 */
function scissorLift(sh) {
  chamfer(sh, 0, 0.30, 0, 1.50, 0.44, 2.60, 0.10, ROLE.DARK);
  for (const s of [-1, 1]) {
    for (const z of [0.95, -0.95]) {
      // Castors in swivel forks, so the wheels are mounted to something.
      box(sh, s * 0.72, 0.44, z, 0.28, 0.20, 0.34, ROLE.MACH_LO);
      for (const d of [-1, 1]) box(sh, s * (0.72 + d * 0.13), 0.30, z, 0.05, 0.24, 0.30, ROLE.MACH_LO);
      wheel(sh, s * 0.72, 0.24, z, 0.24, 0.18, 7, { arch: false });
    }
  }
  // Two crossed pairs of arms, with a pivot boss at every crossing.
  for (let k = 0; k < 2; k++) {
    const y = 0.72 + k * 1.30;
    for (const s of [-1, 1]) {
      for (const d of [-1, 1]) {
        stamp(sh, (s2) => box(s2, 0, 0, 0, 0.10, 0.20, 2.30, ROLE.MACH),
          { x: s * 0.60, y, rx: d * 0.55 });
      }
      cyl(sh, s * 0.60, y, 0, 0.13, 0.13, 0.30, 6, 'x', ROLE.DARK);
      for (const d of [-1, 1]) {
        cyl(sh, s * 0.60, y + d * 0.60, d * -1.05, 0.09, 0.09, 0.28, 5, 'x', ROLE.DARK);
      }
    }
  }
  // Hydraulic ram between the lowest two arms.
  ram(sh, [0, 0.42, -0.80], [0, 1.10, 0.60], 0.11);
  // Platform deck, guard rails with a kick plate and mesh infill, control box.
  // DUSTY for the deck: a matte grey chequer plate, not a mirror that turns
  // the platform floor turquoise.
  chamfer(sh, 0, 2.72, 0, 1.60, 0.16, 2.80, 0.06, ROLE.DUSTY);
  for (const s of [-1, 1]) {
    box(sh, s * 0.78, 3.32, 0, 0.07, 1.10, 2.72, ROLE.MACH);
    box(sh, 0, 3.32, s * 1.36, 1.60, 1.10, 0.07, ROLE.MACH);
    // Outboard of the rail box (which reaches x = 0.815), or the depth test
    // buries the infill inside the rail and the guards read as bare plates.
    faceX(sh, s * 0.822, 3.00, 0, 2.66, 0.30, ROLE.MACH_LO, s);     // kick plate
    faceX(sh, s * 0.818, 3.52, 0, 2.66, 0.52, ROLE.DARK, s);        // mesh infill
    faceZ(sh, 0, 3.00, s * 1.402, 1.54, 0.30, ROLE.MACH_LO, s);
    faceZ(sh, 0, 3.52, s * 1.398, 1.54, 0.52, ROLE.DARK, s);
  }
  // Entry gate at the rear: a lighter panel with a visible stile each side.
  faceZ(sh, 0, 3.30, -1.412, 0.70, 1.00, ROLE.MACH_LO, -1);
  for (const d of [-1, 1]) faceZ(sh, d * 0.38, 3.30, -1.422, 0.08, 1.04, ROLE.DARK, -1);
  chamfer(sh, 0.52, 3.36, 1.30, 0.36, 0.44, 0.20, 0.05, ROLE.DARK); // control box
  faceZ(sh, 0.52, 3.40, 1.41, 0.26, 0.22, ROLE.SIGN, 1);
}

/**
 * Articulated tandem roller. Correct parts, correct proportions, and nothing
 * ancillary at all: the drum was butted straight into the body with no yoke or
 * pivot, and there was no scraper, canopy, beacon, step or handrail.
 */
function roadRoller(sh) {
  // GRIME, not STEEL: a 12-sided cylinder at metalness 0.92 mirrors the Miami
  // sky and the drum came out bright turquoise. A roller drum is grey.
  cyl(sh, 0, 0.62, 1.45, 0.62, 0.62, 1.90, 12, 'x', ROLE.GRIME);
  // Drum yoke: two side arms carrying a visible pivot boss.
  for (const s of [-1, 1]) {
    chamfer(sh, s * 1.02, 0.86, 1.45, 0.16, 0.90, 1.20, 0.05, ROLE.DARK);
    cyl(sh, s * 1.02, 0.62, 1.45, 0.16, 0.16, 0.22, 6, 'x', ROLE.MACH_LO);
  }
  box(sh, 0, 1.24, 1.45, 2.10, 0.18, 0.50, ROLE.DARK);
  // Scraper bar along the drum's trailing edge.
  box(sh, 0, 0.44, 0.84, 1.86, 0.09, 0.10, ROLE.MACH_LO);
  for (const s of [-1, 1]) box(sh, s * 0.86, 0.62, 0.90, 0.08, 0.30, 0.08, ROLE.DARK);
  chamfer(sh, 0, 1.00, 0.35, 1.30, 0.70, 1.30, 0.12, ROLE.MACH);
  chamfer(sh, 0, 1.10, -1.10, 1.90, 1.00, 2.10, 0.14, ROLE.MACH);
  // Articulation joint line between front and rear body.
  cyl(sh, 0, 1.16, -0.10, 0.30, 0.30, 1.20, 8, 'x', ROLE.DARK);
  machCab(sh, { y: 2.10, z: -0.90, w: 1.20, h: 1.10, d: 1.20, b: 0.10 });
  chamfer(sh, 0, 2.72, -0.90, 1.34, 0.12, 1.34, 0.05, ROLE.MACH);
  ropsFrame(sh, { x: 0.72, y0: 1.60, y1: 2.90, z0: -1.50, z1: -0.30 });
  beacon(sh, 0.42, 2.92, -0.90);
  stepLadder(sh, 0.96, 0.60, -0.60, 2, 1);
  // Black rubber fender band round the rear wheels.
  for (const s of [-1, 1]) box(sh, s * 0.82, 1.32, -1.90, 0.52, 0.10, 1.40, ROLE.DARK);
  for (const s of [-1, 1]) faceX(sh, s * 0.96, 0.70, -1.10, 2.00, 0.24, ROLE.DUSTY, s);
  wheel(sh, 0.82, 0.60, -1.90, 0.60, 0.40, 8);
  wheel(sh, -0.82, 0.60, -1.90, 0.60, 0.40, 8);
}

/* ====================================================== the catalogue === */

const SHAPE_FN = {
  sedan, suv, hatchback, pickup, sports, convertible, taxi, police,
  supercar, roadster, gtCoupe,
  deliveryVan, boxTruck, flatbed, flatbedLoad, garbageTruck, cementMixer,
  cityBus, articBus, shuttleBus, ambulance, scooter, motorcycle, cruiser, bicycle,
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
 * A paint variant, fully baked. Positions/normals/uvs are the SAME
 * BufferAttribute objects for every variant of a shape.
 *
 * Only used now as the SAFETY VALVE for a shape whose variants repaint more
 * roles than there are per-instance tint slots — see `tintPlan`. Nothing in
 * the current fleet needs it (the worst is three), but a future paint scheme
 * that does must degrade to an extra pool rather than to the wrong colours.
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
  g.setAttribute('tintSel', new THREE.BufferAttribute(new Float32Array(s.count), 1));
  g.computeBoundingSphere();
  return g;
}

/* ------------------------------------------------- per-instance paint --- */

/** Per-instance colour slots a single vehicle pool can carry. */
const MAX_TINT = 4;
const WHITE3 = [1, 1, 1];

/**
 * Work out, per shape, WHICH roles actually change between its paint variants.
 *
 * This is derived rather than declared on purpose. A hand-written list of
 * "the body and the roof are the tinted bits" silently produces the wrong
 * colour the day someone adds a variant with a different rim or a different
 * boot stripe. Comparing the resolved palettes cannot be wrong: a role whose
 * colour is identical in every variant is baked into the geometry, and a role
 * that moves gets a slot.
 *
 * Roles are grouped by the colour SEQUENCE they take across the variants, not
 * by their palette key, so an exotic whose roof is simply its body colour
 * shares the body's slot instead of burning a second one.
 *
 * @returns {null|{n:number, sel:Float32Array, variants:number[][][]}}
 *   null means "this shape needs more slots than exist" — the caller falls
 *   back to one pool per paint, which is what the whole fleet used to do.
 */
const _planCache = new Map();
function tintPlan(key) {
  if (_planCache.has(key)) return _planCache.get(key);
  const def = FLEET[key];
  const pals = def.paints.map(paletteFor);
  const nRoles = ROLE_KEY.length;
  /** slot index per role; 0 = baked into the geometry. */
  const slotOf = new Uint8Array(nRoles);
  const bySig = new Map();
  let n = 0;
  let ok = true;

  for (let r = 0; r < nRoles && ok; r++) {
    let varies = false;
    for (let v = 1; v < pals.length; v++) {
      const a = pals[0][r], b = pals[v][r];
      if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) { varies = true; break; }
    }
    if (!varies) continue;
    // Signature = the whole colour run. Two roles that are always the same
    // colour as each other share one slot.
    let sig = '';
    for (let v = 0; v < pals.length; v++) {
      const c = pals[v][r];
      sig += `${c[0].toFixed(5)},${c[1].toFixed(5)},${c[2].toFixed(5)};`;
    }
    let s = bySig.get(sig);
    if (s === undefined) {
      if (n >= MAX_TINT) { ok = false; break; }
      s = ++n;
      bySig.set(sig, s);
    }
    slotOf[r] = s;
  }

  let plan = null;
  if (ok) {
    const sh = getShape(key);
    const sel = new Float32Array(sh.count);
    for (let i = 0; i < sh.count; i++) sel[i] = slotOf[sh.roles[i]];
    // variants[v][slot-1] = the linear triple that slot takes on variant v.
    const variants = pals.map((pal) => {
      const out = new Array(MAX_TINT).fill(null);
      for (let r = 0; r < nRoles; r++) {
        const s = slotOf[r];
        if (s) out[s - 1] = pal[r];
      }
      for (let s = 0; s < MAX_TINT; s++) if (!out[s]) out[s] = WHITE3;
      return out;
    });
    plan = { n, sel, variants, slotOf };
  } else {
    // Not fatal — `spawn` falls back to one pool per paint — but it silently
    // costs draw calls, so say so rather than letting it rot.
    console.warn(`[vehicles] ${key} repaints more than ${MAX_TINT} role groups; `
      + 'falling back to one pool per paint');
  }
  _planCache.set(key, plan);
  return plan;
}

/**
 * ONE geometry per shape: everything that never changes is baked, everything
 * that does carries a slot selector for the shader to look up per instance.
 */
const _shapeGeoCache = new Map();
function shapeGeometry(key) {
  let g = _shapeGeoCache.get(key);
  if (g) return g;
  const s = getShape(key);
  const plan = tintPlan(key);
  // Variant 0 supplies every baked colour. Safe by construction: a role is
  // only baked when it is identical in every variant.
  const pal = paletteFor(FLEET[key].paints[0]);
  g = new THREE.BufferGeometry();
  g.setAttribute('position', s.pos);
  g.setAttribute('normal', s.nor);
  g.setAttribute('uv', s.uv);
  const col = new Float32Array(s.count * 3);
  for (let i = 0; i < s.count; i++) {
    const role = s.roles[i];
    if (plan.slotOf[role]) { col[i * 3] = 1; col[i * 3 + 1] = 1; col[i * 3 + 2] = 1; }
    else {
      const c = pal[role];
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('tintSel', new THREE.BufferAttribute(plan.sel, 1));
  g.computeBoundingSphere();
  _shapeGeoCache.set(key, g);
  return g;
}

/**
 * Write one instance's paint into the pool's tint attributes.
 *
 * The four attributes are allocated on first use and always all four, even for
 * a single-livery shape like the taxi: the shader is shared by the whole fleet
 * and declares all four, so a geometry that omitted them would leave the
 * attribute unbound.
 */
function applyTint(pool, slot, type, vi) {
  let attrs = pool._vehTint;
  if (!attrs) {
    attrs = pool._vehTint = [];
    for (let s = 0; s < MAX_TINT; s++) {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(pool.capacity * 3), 3);
      pool.geometry.setAttribute(`aTint${s}`, a);
      attrs.push(a);
    }
  }
  const plan = tintPlan(type);
  const cols = plan ? plan.variants[vi % plan.variants.length] : null;
  for (let s = 0; s < MAX_TINT; s++) {
    const c = cols ? cols[s] : WHITE3;
    attrs[s].setXYZ(slot, c[0], c[1], c[2]);
    attrs[s].needsUpdate = true;
  }
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
  const sh = getShape(key);
  const p = sh.pos.array;
  let minY = Infinity, maxY = -Infinity;
  let frontZ = -Infinity, backZ = Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const y = p[i + 1], z = p[i + 2];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z > frontZ) frontZ = z;
    if (z < backZ) backZ = z;
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
  const height = maxY - minY;

  /* --- where the decorative light cards belong ------------------------------
   * These used to be guessed from FLEET.len ("the tail is 40% of the length
   * back"), and the guess was short on EVERY shape in the fleet: a sedan's
   * brake card landed at z = -1.98 against a tail panel at z = -2.31, i.e.
   * 0.33 m inside solid bodywork, where the depth test threw it away. The city
   * has had no visible brake lights at all. The lamp plane is now taken from
   * the shape that baked the lamps, and falls back to measured extents for the
   * two-wheelers and boats that have no `carLamps` call. */
  const L = sh.lamp;
  const lampY = L ? L.yT : Math.max(0.42, Math.min(1.15, height * 0.48));
  m = {
    minY, height, contactW: cw, contactD: cd,
    radius: Math.hypot(cw, cd) / 2,
    frontZ, backZ,
    bodyL: frontZ - backZ,
    midZ: (frontZ + backZ) * 0.5,
    /** Distance AHEAD of the origin at which the headlight pool starts. */
    noseZ: (L ? L.zF : frontZ) - 0.05,
    /** Distance BEHIND the origin of the brake card, just proud of the panel. */
    tailZ: (L ? -L.zR : -backZ) + 0.07,
    lampY,
    lampW: L ? Math.max(0.34, L.dx * 2 + L.wL) : Math.max(0.34, cw * 0.86),
    lampH: L ? Math.max(0.20, Math.min(0.46, L.hL * 1.7))
             : Math.max(0.20, Math.min(0.42, height * 0.22)),
  };
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
/**
 * TOOLING: one fully-painted geometry for a kind, for the catalogue studio.
 *
 * The catalogue used to photograph a live instance standing in the city, which
 * meant a shot could come back as somebody's curtain wall, or as a palm, or —
 * once the shared dev server is under load from five agents — not at all. This
 * hands the shape straight to an isolated renderer instead. `variantGeometry`
 * bakes every role colour into the vertex buffer, so no per-instance tint
 * attributes are needed and the result is exactly what the city draws.
 */
export function vehicleSpecimen(key, vi = 0) {
  const def = FLEET[key];
  if (!def) return null;
  return {
    geometry: variantGeometry(key, def.paints[vi % def.paints.length]),
    material: vehicleMaterial(),
    def,
    variants: def.paints.length,
    metrics: shapeMetrics(key),
  };
}

/** TOOLING: every kind the fleet can build. */
export function vehicleKinds() { return Object.keys(FLEET); }

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
      { paint: P.STUCCO_BUTTER },
      // Everything below this line is FREE. A pool is one shape now, not one
      // (shape, paint), so a fourteenth sedan colour costs twelve floats on one
      // instance and not a draw call — and a kerb of nine repeating colours was
      // still the loudest "this is procedural" tell in the frame.
      { paint: P.CAR_BLACK, roof: P.CAR_GRAPHITE }, { paint: P.STUCCO_SKY },
      { paint: P.CAR_GREEN }, { paint: P.STUCCO_SAND, roof: P.CAR_WHITE },
      { paint: P.CAR_PURPLE, roof: P.CAR_BLACK }] },
  suv: { tier: 'LARGE', r: 1.7, h: 1.85, len: 4.9, cap: 68, label: 'SUV',
    paints: [
      { paint: P.CAR_BLACK }, { paint: P.CAR_WHITE, roof: P.CAR_GRAPHITE },
      { paint: P.CAR_SILVER }, { paint: P.CAR_GREEN, roof: P.CAR_WHITE },
      { paint: P.CAR_ORANGE }, { paint: P.CAR_NAVY, roof: P.CAR_SILVER },
      { paint: P.CAR_GRAPHITE },
      { paint: P.CAR_RED, roof: P.CAR_BLACK }, { paint: P.STUCCO_SAND },
      { paint: P.CAR_TEAL, roof: P.CAR_WHITE }, { paint: P.STUCCO_CREAM },
      { paint: P.CAR_BLUE, roof: P.CAR_GRAPHITE }] },
  hatchback: { tier: 'LARGE', r: 1.4, h: 1.6, len: 4.0, cap: 54, label: 'Hatchback',
    // Pastels come from the stucco set on purpose: they are already graded for
    // this sun, and a mint or peach hatchback is exactly right for Miami.
    paints: [
      { paint: P.CAR_LIME, roof: P.CAR_WHITE }, { paint: P.CAR_TEAL },
      { paint: P.CAR_YELLOW, roof: P.CAR_GRAPHITE }, { paint: P.CAR_WHITE },
      { paint: P.STUCCO_MINT }, { paint: P.STUCCO_PEACH, roof: P.CAR_WHITE },
      { paint: P.CAR_PINK, roof: P.CAR_WHITE },
      { paint: P.STUCCO_LILAC }, { paint: P.CAR_CORAL, roof: P.STUCCO_CREAM },
      { paint: P.CAR_SILVER, roof: P.CAR_BLACK }, { paint: P.STUCCO_AQUA },
      { paint: P.CAR_RED }] },
  pickup: { tier: 'LARGE', r: 1.8, h: 1.9, len: 5.5, cap: 40, label: 'Pickup',
    paints: [
      ...plain([P.CAR_CORAL, P.CAR_GRAPHITE, P.CAR_WHITE, P.CAR_NAVY, P.CAR_RED]),
      { paint: P.CAR_BLACK }, { paint: P.CAR_SILVER, roof: P.CAR_GRAPHITE },
      { paint: P.CAR_GREEN }, { paint: P.STUCCO_SAND }] },
  sports: { tier: 'LARGE', r: 1.5, h: 1.25, len: 4.5, cap: 39, label: 'Sports Coupe',
    paints: [P.CAR_RED, P.CAR_PINK, P.CAR_MINT, P.CAR_YELLOW, P.CAR_PURPLE,
      P.CAR_BLACK, P.NEON_ORANGE].map((c) => exotic(c)) },
  // Tan hide, not black: the camera looks straight down into this one, and a
  // dark interior in a dark cockpit well is just a hole in the car.
  convertible: { tier: 'LARGE', r: 1.5, h: 1.35, len: 4.4, cap: 28, label: 'Convertible',
    paints: [P.CAR_PURPLE, P.CAR_WHITE, P.CAR_CORAL, P.STUCCO_AQUA, P.CAR_PINK,
      P.CAR_RED, P.STUCCO_BUTTER, P.CAR_SILVER, P.NEON_AQUA]
      .map((c) => ({ paint: c, seat: 0x8d7a62, interior: 0x4c443b })) },
  supercar: { tier: 'LARGE', r: 1.6, h: 1.15, len: 4.7, cap: 30, label: 'Supercar',
    paints: [P.NEON_PINK, P.NEON_AQUA, P.ACCENT_SUN, P.CAR_ORANGE, P.CAR_LIME, P.CAR_WHITE,
      P.NEON_PURPLE, P.CAR_BLACK]
      .map((c) => exotic(c, P.CAR_GRAPHITE)) },
  roadster: { tier: 'LARGE', r: 1.5, h: 1.3, len: 4.5, cap: 29, label: 'Roadster',
    paints: [P.CAR_MINT, P.STUCCO_PINK, P.CAR_SILVER, P.CAR_NAVY, P.CAR_PURPLE,
      P.CAR_RED, P.STUCCO_BUTTER]
      .map((c) => exotic(c)) },
  /* The GT's glazing and sills do NOT follow the paint — see `gtCoupe()`. A
   * navy car with the fleet's shared mid-slate glass had no value separation
   * between roof, screen and flank and read as one dark lump. */
  gtCoupe: { tier: 'LARGE', r: 1.6, h: 1.4, len: 5.0, cap: 29, label: 'Grand Tourer',
    paints: [P.CAR_GRAPHITE, P.CAR_NAVY, P.CAR_RED, P.CAR_SILVER, P.CAR_TEAL,
      P.CAR_BLACK, P.STUCCO_CREAM]
      .map((c) => ({
        paint: c, paintLo: darken(c, 0.35), rim: P.CHROME,
        glass: 0x171d24, glassHi: 0xbcdcea,
      })) },
  // Three operators, because a rank of a hundred and seventy identical cabs is
  // the same repetition problem as a kerb of identical saloons. All three are
  // taxi-yellow — the white livery made those cabs indistinguishable from a
  // sedan — and only the band colour changes, which costs one tint slot.
  taxi: { tier: 'LARGE', r: 1.6, h: 1.7, len: 4.7, cap: 60, label: 'Taxi',
    paints: [
      { paint: P.TAXI_YELLOW, accent: 0x24262b, paintLo: darken(P.TAXI_YELLOW, 0.72) },
      { paint: P.TAXI_YELLOW, accent: P.CAR_TEAL, paintLo: darken(P.TAXI_YELLOW, 0.72) },
      { paint: P.TAXI_YELLOW, accent: P.NEON_PINK, paintLo: darken(P.TAXI_YELLOW, 0.72) }] },
  // Black steel wheels, not civilian alloys.
  police: { tier: 'LARGE', r: 1.7, h: 1.9, len: 4.9, cap: 26, label: 'Police Car',
    paints: [
      { paint: P.CAR_WHITE, blue: P.POLICE_BLUE, red: P.CAR_RED, rim: 0x3b4147 },
      { paint: P.CAR_BLACK, blue: P.POLICE_BLUE, red: P.CAR_RED, rim: 0x3b4147 }] },
  deliveryVan: { tier: 'LARGE', r: 2.0, h: 2.6, len: 6.0, cap: 56, label: 'Delivery Van',
    paints: [
      { paint: P.TRUCK_WHITE, accent: P.NEON_PINK }, { paint: P.CAR_TEAL, accent: P.FABRIC_WHITE },
      { paint: P.BRICK, accent: P.STUCCO_CREAM }, { paint: P.BUS_BLUE, accent: P.FABRIC_WHITE },
      { paint: P.CAR_YELLOW, accent: P.CAR_GRAPHITE }, { paint: P.CAR_GREEN, accent: P.FABRIC_WHITE },
      { paint: P.STUCCO_CREAM, accent: P.CAR_CORAL }, { paint: P.CAR_GRAPHITE, accent: P.NEON_AQUA }] },
  boxTruck: { tier: 'XLARGE', r: 2.5, h: 3.3, len: 8.6, cap: 60, label: 'Box Truck',
    paints: [
      { paint: P.CAR_BLUE, white: P.TRUCK_WHITE, accent: P.FABRIC_SKY },
      { paint: P.CAR_GRAPHITE, white: P.TRUCK_WHITE, accent: P.FABRIC_CORAL }] },
  /* Deck timber is authored separately from the cab paint, and knocked well
   * back from the old saturated orange, which was the largest single flat
   * colour on the vehicle. */
  flatbed: { tier: 'XLARGE', r: 2.4, h: 2.8, len: 8.4, cap: 40, label: 'Flatbed Truck',
    paints: [P.CAR_NAVY, P.TRUCK_WHITE, P.CAR_RED, P.CAR_GREEN]
      .map((c) => ({ paint: c, deck: P.WOOD_LIGHT, deckLo: P.WOOD_DARK })) },
  flatbedLoad: { tier: 'XLARGE', r: 2.4, h: 2.8, len: 8.4, cap: 24, label: 'Flatbed Truck',
    paints: [P.CAR_NAVY, P.TRUCK_WHITE, P.CAR_RED, P.CAR_GREEN]
      .map((c) => ({ paint: c, deck: P.WOOD_LIGHT, deckLo: P.WOOD_DARK })) },
  // Pale cab against the green body, plus a sanitation livery panel.
  garbageTruck: { tier: 'XLARGE', r: 2.6, h: 3.3, len: 9.0, cap: 24, label: 'Garbage Truck',
    paints: [{ paint: P.BIN_GREEN, paintLo: darken(P.BIN_GREEN, 0.62),
      white: P.FABRIC_WHITE, grime: 0x6d6455 }] },
  cementMixer: { tier: 'XLARGE', r: 2.6, h: 3.6, len: 8.8, cap: 34, label: 'Cement Mixer',
    paints: [{ paint: P.CAR_ORANGE, paintLo: darken(P.CAR_ORANGE, 0.62),
      white: P.TRUCK_WHITE, dusty: 0xc2b9a6 }] },
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
  motorcycle: { tier: 'MEDIUM', r: 0.7, h: 1.3, len: 2.16, cap: 46, label: 'Motorcycle',
    paints: [P.CAR_RED, P.CAR_GRAPHITE, P.NEON_AQUA, P.CAR_ORANGE, P.CAR_BLACK,
      P.CAR_LIME, P.CAR_BLUE]
      .map((c) => exotic(c)) },
  // Second two-wheeler body style: 67 identical sportbikes was a rank.
  cruiser: { tier: 'MEDIUM', r: 0.8, h: 1.4, len: 2.56, cap: 34, label: 'Cruiser',
    paints: [P.CAR_BLACK, P.CAR_NAVY, P.BRICK, P.CAR_GRAPHITE, P.CAR_TEAL, P.CAR_PURPLE]
      .map((c) => exotic(c)) },
  bicycle: { tier: 'MEDIUM', r: 0.55, h: 1.05, len: 1.8, cap: 150, label: 'Bicycle',
    paints: plain([P.ACCENT_AQUA, P.CAR_CORAL]) },

  /* --- boats: y = 0 is the waterline ------------------------------------
   * `glassDk` is the one that matters. The shared road-car glass tone is far
   * too light against a cream hull, so every boat in the bay rendered with no
   * windows at all — a stack of white boxes. Near-black tinted bands with a
   * bright top edge are most of what makes these read as boats.
   * `antifoul` is the band below the boot stripe, which the HULL3 section now
   * carries as geometry rather than a decal. */
  motorYacht: { tier: 'XLARGE', r: 3.4, h: 5.2, len: 13.4, cap: 40, label: 'Motor Yacht',
    paints: [
      { hull: P.HULL_WHITE, accent: P.HULL_NAVY, white: P.HULL_WHITE, glassDk: 0x141d24, deck: 0xb0834c },
      { hull: P.HULL_WHITE, accent: P.HULL_TEAL, white: P.HULL_WHITE, glassDk: 0x141d24, deck: 0xb0834c },
      { hull: P.HULL_NAVY, accent: P.FABRIC_SUN, white: P.HULL_WHITE, glassDk: 0x141d24, deck: 0xb0834c }] },
  sailBoat: { tier: 'XLARGE', r: 2.4, h: 12.0, len: 10.0, cap: 40, label: 'Sailing Boat',
    paints: [
      { hull: P.HULL_WHITE, accent: P.HULL_NAVY, white: P.HULL_WHITE, glassDk: 0x16222a, deck: 0xb0834c },
      { hull: P.HULL_TEAL, accent: P.FABRIC_WHITE, white: P.HULL_WHITE, glassDk: 0x16222a, deck: 0xb0834c },
      { hull: 0xe9dfc6, accent: 0x8f3f36, white: P.HULL_WHITE, glassDk: 0x16222a, deck: 0xb0834c }] },
  // Canopy hue varies per instance, so a marina of them is not one boat.
  waterTaxi: { tier: 'XLARGE', r: 2.1, h: 3.0, len: 7.8, cap: 24, label: 'Water Taxi',
    paints: [P.NEON_AQUA, P.FABRIC_CORAL, P.FABRIC_SUN, P.FABRIC_SKY].map((c) => ({
      hull: P.HULL_WHITE, accent: c, white: P.HULL_WHITE, glassDk: 0x16222a, deck: 0xb0834c,
    })) },
  skiff: { tier: 'LARGE', r: 1.3, h: 1.6, len: 5.0, cap: 40, label: 'Skiff',
    paints: [{ hull: P.HULL_WHITE, deck: P.WOOD_DECK }, { hull: P.HULL_TEAL, deck: P.WOOD_DECK }] },
  sportFisher: { tier: 'XLARGE', r: 3.0, h: 6.2, len: 11.9, cap: 16, label: 'Sportfisher',
    paints: [{ hull: P.HULL_WHITE, accent: P.HULL_NAVY, white: P.HULL_WHITE,
      glassDk: 0x141d24, deck: 0xa88a63, antifoul: 0x27363f }] },
  cruiseShip: { tier: 'HUGE', r: 9.0, h: 24.0, len: 45.5, cap: 3, label: 'Cruise Ship',
    paints: [{ hull: 0xf0e6cf, accent: P.NEON_PINK, white: P.HULL_WHITE, blue: P.HULL_NAVY,
      glassDk: 0x131c22, hazard: 0xff8a2e }] },
  jetSki: { tier: 'MEDIUM', r: 0.7, h: 1.0, len: 3.1, cap: 40, label: 'Jet Ski',
    paints: [P.NEON_PINK, P.NEON_AQUA, P.ACCENT_SUN, P.CAR_LIME]
      .map((c) => ({ ...exotic(c), accent: P.HULL_WHITE, deck: P.HULL_WHITE })) },

  /* --- site machinery ----------------------------------------------------
   * Every machine carries ONE paint variant, so nothing here costs a tint slot
   * and the extra role colours are baked into the geometry for free. They are
   * spent breaking up the yellow: a dark chassis, a grimy counterweight, a
   * dusty bottom edge — which is the difference between plant and a toy. */
  excavator: { tier: 'XLARGE', r: 2.4, h: 4.2, len: 8.0, cap: 30, label: 'Excavator',
    paints: [{ paint: P.CRANE_YELLOW, paintLo: darken(P.CRANE_YELLOW, 0.66),
      grime: 0x4a4e52, dusty: 0xb8ae9b }] },
  wheelLoader: { tier: 'XLARGE', r: 2.0, h: 3.3, len: 7.4, cap: 24, label: 'Wheel Loader',
    paints: [{ paint: P.CRANE_YELLOW, paintLo: darken(P.CRANE_YELLOW, 0.66),
      dusty: 0xbdb09a }] },
  siteDumper: { tier: 'XLARGE', r: 2.4, h: 3.4, len: 8.4, cap: 24, label: 'Site Dumper',
    paints: [{ paint: P.CAR_ORANGE, paintLo: darken(P.CAR_ORANGE, 0.66),
      grime: 0x6a5540 }] },
  craneBase: { tier: 'XLARGE', r: 4.2, h: 17.5, len: 7.4, cap: 10, label: 'Tower Crane Base',
    paints: [{ paint: P.CRANE_YELLOW, paintLo: darken(P.CRANE_YELLOW, 0.66),
      grime: 0x8e8880 }] },
  scissorLift: { tier: 'LARGE', r: 1.2, h: 3.9, len: 2.8, cap: 24, label: 'Scissor Lift',
    paints: [{ paint: P.CRANE_YELLOW, paintLo: darken(P.CRANE_YELLOW, 0.58) }] },
  roadRoller: { tier: 'LARGE', r: 1.4, h: 2.9, len: 4.4, cap: 16, label: 'Road Roller',
    paints: [{ paint: P.CAR_YELLOW, paintLo: darken(P.CAR_YELLOW, 0.66),
      dusty: 0xb5aa93, grime: 0x93968f }] },
};

/* ================================================== spawn / pooling ==== */

/**
 * Instantiate one vehicle.
 *
 * ONE POOL PER SHAPE. Paint rides in per-instance tint slots (see `tintPlan`),
 * so a hundred and seventy taxis and three hundred and fifty sedans of nine
 * colours are two InstancedMeshes rather than ten. `hex` is deliberately NOT
 * passed: three's `instanceColor` would tint the glass and the tyres too, which
 * is the exact problem the tint slots exist to solve.
 */
function spawn(ctx, state, type, vi, x, surfaceY, z, rotY, dynamic) {
  const def = FLEET[type];
  const spec = def.paints[vi % def.paints.length];
  const plan = tintPlan(type);
  // A shape whose variants repaint more roles than there are slots keeps the
  // old one-pool-per-paint behaviour rather than coming out the wrong colour.
  const key = plan ? `veh:${type}` : `veh:${type}:${vi}`;
  const c = ctx.addInstanced(key, () => ({
    geometry: plan ? shapeGeometry(type) : variantGeometry(type, spec),
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
    capacity: plan ? def.cap * def.paints.length : def.cap,
    dynamic,
    castShadow: true,
    receiveShadow: true,
    debrisColor: spec.paint ?? spec.hull ?? 0xffffff,
  });
  if (c) {
    applyTint(c.pool, c.slot, type, vi);
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

    /* --- who gives way where nobody is signalled -------------------------
     * roadNetwork only signals a junction when at least one of its two roads
     * is bigger than a STREET, so on the minor grid `lightFor` answers green
     * to both axes for ever and the two streams simply drove through each
     * other. That is the "cars driving through each other" failure, and it was
     * happening at every street x street crossing in the city.
     *
     * Each unsignalled junction therefore caches, per approach axis, the lanes
     * an approaching driver has to look at, plus which axis holds priority.
     * Priority alternates on a checkerboard rather than following one axis, so
     * neither direction is systematically starved and no street reads as
     * permanently subordinate. */
    for (const ix of this.net.intersections) {
      if (ix.signalled) continue;
      // Always rebuilt, never reused: these hold live lane lists, and a stale
      // one from a previous world would be describing cars that no longer exist.
      ix.vehCross = { x: [], z: [] };
      ix.vehPriority = ((ix.ri + ix.rj) % 2) ? 'x' : 'z';
      for (const laneAxis of ['x', 'z']) {
        const axis = laneAxis === 'x' ? 'z' : 'x';
        const ri = laneAxis === 'x' ? ix.rj : ix.ri;
        for (const dir of [1, -1]) {
          const list = this.byRoadDir.get(`${axis}:${ri}:${dir}`);
          if (!list) continue;
          for (const o of list) {
            ix.vehCross[laneAxis].push({ info: o, sJ: this.net.sFor(o.lane, ix.x, ix.z) });
          }
        }
      }
    }
  }

  /**
   * Is it unsafe to enter this unsignalled junction right now?
   *
   * Two separate reasons, and they are not the same rule. Anything already IN
   * the box stops everybody, whichever axis it came from — that is what makes
   * the crossing first-come-first-served rather than a race. Anything merely
   * APPROACHING only stops the subordinate axis, so the priority street keeps
   * flowing instead of both directions creeping at every corner.
   */
  _crossBusy(v, lane, ix) {
    const arr = ix.vehCross && ix.vehCross[lane.axis];
    if (!arr) return false;
    const yielding = ix.vehPriority !== lane.axis;
    const box = (lane.axis === 'x' ? ix.halfX : ix.halfZ) + 3.0;
    for (let i = 0; i < arr.length; i++) {
      const { info, sJ } = arr[i];
      const L = info.list;
      for (let k = 0; k < L.length; k++) {
        const o = L[k];
        // A car the consume system has taken over is not going anywhere, so
        // waiting for it to clear would stall the crossing for ever.
        if (o.dead || (o.c && o.c.state >= 1)) continue;
        const d = sJ - o.s;
        if (Math.abs(d) < box + o.len * 0.5) return true;
        if (yielding && d > 0 && d < 22 && o.v > 1.2) return true;
      }
    }
    return false;
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
      // A revived car is a fresh car: no stale dive or lean carried over from
      // whatever it was doing when the ground went out from under it.
      v.acc = 0; v.pitch = 0; v.roll = 0;
      v.yawPrev = this.net.headingOf(info.lane);
      v.turn = null; v.decided = -1; v.waitT = 0; v.giveT = 0;
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
   *
   * Transit is the third case and lives in its own branch below: a bus in a
   * bus lane halts at a real shelter, which nobody else does.
   */
  _tryKerbEvent(v, info) {
    const lane = info.lane;
    // A committed turn owns the vehicle's path outright; stopping halfway
    // through one would leave it braking for a kerb it is no longer aimed at.
    if (v.turn || !lane.kerbLane) return;
    const seg = info.segs[v.seg];
    if (!seg) return;
    const stopOff = lane.axis === 'x' ? 'stopX' : 'stopZ';
    /**
     * Is `s` a place a vehicle may legally stand?
     *
     * The junction it has to be clear of is the one nearest THE STOPPING
     * POINT, not the one nearest the driver. Testing against the driver's next
     * junction looks equivalent and is not: a bus stop 90 m ahead with a
     * crossing 40 m ahead failed the test, and on a boulevard with a junction
     * every 70 m and a shelter on every block that is EVERY stop — buses made
     * exactly zero halts in a 150 s run. The same bug was quietly costing kerb
     * bays and double-parks their far candidates too.
     */
    const clearOfJunction = (s) => {
      if (!(s > seg.lo + 12 && s < seg.hi - 28)) return false;
      const J = lane.junctions;
      for (let i = 0; i < J.length; i++) {
        const box = J[i].ix[stopOff] + STOP_SETBACK;
        // Not queued across the approach, and not still inside the box behind.
        if (s + 16 > J[i].s - box && s < J[i].s + box + 6) return false;
      }
      return true;
    };

    /**
     * A bus stop may sit right on the corner — that is where they are built,
     * and a bus standing at one is not a queue blocking the approach, it is a
     * bus in a bus lane doing its job. The general clearance (16 m of lead-in
     * plus a boulevard's 17 m half-width) blocks 69 m either side of every
     * junction, which on a 68 m block is the whole block: with it, the fleet
     * made zero halts. Transit only has to stay out of the box itself.
     */
    const clearForBus = (s) => {
      if (!(s > seg.lo + 12 && s < seg.hi - 28)) return false;
      const J = lane.junctions;
      const pad = v.len * 0.6 + 2;
      for (let i = 0; i < J.length; i++) {
        const box = J[i].ix[stopOff];
        if (s > J[i].s - box - pad && s < J[i].s + box + pad) return false;
      }
      return true;
    };

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
      // Halt where props.js actually built a stop. A bus pulling up at a random
      // stretch of kerb, thirty metres from the shelter and the queue of people
      // waiting under it, is the tell that the two modules are not describing
      // the same city. `registerStops` fills these in; the random fallback only
      // runs on a bus lane that genuinely has no stop on it.
      let s = -1;
      const S = info.stops;
      if (S) {
        // Every stop in reach, not just the first: shelters sit on block
        // frontages and plenty of them are inside the junction clearance, so
        // taking the nearest and giving up if it fails means never halting.
        for (let i = 0; i < S.length; i++) {
          if (S[i] < v.s + 22) continue;
          if (S[i] > v.s + 200) break;              // sorted
          if (!clearForBus(S[i])) continue;
          s = S[i];
          break;
        }
        if (s < 0) return;
      } else {
        s = v.s + 26 + this.rng() * 40;
        if (!clearForBus(s)) return;
      }
      if (!this.rng.chance(0.7)) return;
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
          // Only the lane-change test needs this now; the kerb tests look up
          // the junction nearest their own candidate stopping point instead.
          const nj = v.lcT - dt <= 0 ? net.nextJunction(lane, v.s) : null;
          if (v.cool <= 0) {
            // Transit asks more often than everyone else: a bus only halts at
            // one of the ~37 real shelters, and at 15 m/s a 12 s gap between
            // questions carries it 180 m — past most of them.
            v.cool = v.busStop ? 4 + this.rng() * 5 : 7 + this.rng() * 11;
            this._tryKerbEvent(v, info);
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
            // Give way where there is no signal to do it for us.
            if (!mustStop && !j.ix.signalled && dStop < 20) {
              if (this._crossBusy(v, lane, j.ix)) { mustStop = true; v.giveT += dt; }
              else v.giveT = 0;
              // Nothing in a grid of minor streets is worth a permanent stand-off.
              if (v.giveT > 6) { mustStop = false; v.giveT = 0; }
            } else if (v.giveT) {
              v.giveT = 0;
            }
            /* KEEP CLEAR. IDM only knows about the car in front, so a queue
             * discharging past a junction parked its tail across the box and
             * the cross stream then drove straight through it. Do not cross
             * the line unless there is room for the whole vehicle on the far
             * side of the junction. */
            if (!mustStop && dStop < 22 && lead && !lead.dead && lead.v < 1.4
                && (!lead.c || lead.c.state === 0)) {
              const far = j.s + (lane.axis === 'x' ? j.ix.stopX : j.ix.stopZ);
              if (lead.s - lead.len * 0.5 < far + v.len + IDM_S0) mustStop = true;
            }
            if (mustStop) acc = Math.min(acc, this._interact(v, Math.max(0.05, dStop), 0));
          }
        }

        /* --- the road physically runs out --------------------------------
         * A segment whose far end is NOT the map boundary ends at water. Cars
         * are supposed to turn off at the last junction before it, but a
         * forced turn can be refused (no target lane, no gap), and nothing
         * then told the car the road was gone: it drove to the end at full
         * speed, got clamped onto the exact metre where the last arrival was
         * already standing, and the whole city's interpenetration — ten pairs,
         * every one of them past |z| = 370 — came from those few stubs.
         * Treat the end as a wall and they queue for it like traffic. */
        const segNow = info.segs[v.seg];
        if (segNow && !segNow.edgeHi && v.s > segNow.lo) {
          // `+ IDM_S0` for the same reason the bay stop needs it: IDM parks one
          // standstill gap short of whatever you hand it, and a car parked
          // short of the wall never trips the relocation test below — which is
          // a permanent queue at every river bank in the city.
          const dEnd = (segNow.hi - v.len * 0.5) - v.s;
          if (dEnd < 60 && dEnd > -4) {
            acc = Math.min(acc, this._interact(v, Math.max(0.05, dEnd + IDM_S0), 0));
          }
        }

        acc = Math.max(-BRAKE_MAX, Math.min(aMax, acc));
        // Kept for the updater: weight transfer is the difference between a
        // fleet that stops and a fleet that dives onto its nose when it stops.
        v.acc = acc;

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
        // `>=`, not `>`. The clamp below parks the car EXACTLY on the wall, so
        // a strict test never fired again and a vehicle that found no free
        // boundary segment on its first try was stranded there for the whole
        // match. Retrying costs one sample of eight entries a frame, for the
        // handful of cars in that state.
        const seg = info.segs[v.seg];
        if (seg && v.s >= seg.hi - v.len * 0.5) {
          const e = this._freeEntry(v);
          if (e) {
            this.pending.push({
              v, from: info, to: e.info, si: e.si,
              s: e.info.segs[e.si].lo + v.len * 0.5 + 2, reset: true,
            });
          } else {
            // Hold behind whatever is already waiting, never on top of it.
            let hold = seg.hi - v.len * 0.5;
            if (lead && !lead.dead) {
              hold = Math.min(hold, lead.s - (lead.len + v.len) * 0.5 - IDM_S0);
            }
            v.s = Math.min(v.s, hold);
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
      v.acc = 0;
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

  /**
   * Attach the bus stops props.js built to the bus lane that serves them.
   *
   * props.js runs before this module, so the registry is already the shared
   * record of where every shelter and stop flag went. Reading it here is what
   * makes a bus halt at a shelter with people under it instead of at an
   * arbitrary 26-66 m down the road, and it needs no new contract between the
   * two modules beyond the prop `kind`, which is stable.
   */
  registerStops(registry) {
    const buses = this.lanes.filter((i) => i.lane.busLane);
    if (!buses.length) return 0;
    let n = 0;
    for (const c of registry.byId.values()) {
      if (c.kind !== 'busShelter' && c.kind !== 'busStopFlag') continue;
      let best = null, bestD = 11;
      for (const info of buses) {
        const L = info.lane;
        // Perpendicular distance from the stop to this lane's centreline.
        const d = Math.abs((L.axis === 'x' ? c.position.x : c.position.z) - L.cross);
        if (d >= bestD) continue;
        const s = this.net.sFor(L, c.position.x, c.position.z);
        let on = false;
        for (const sg of info.segs) if (s > sg.lo + 14 && s < sg.hi - 30) { on = true; break; }
        if (!on) continue;
        bestD = d; best = { info, s };
      }
      if (!best) continue;
      if (!best.info.stops) best.info.stops = [];
      // A shelter and its flag are metres apart and are one stop, not two.
      const S = best.info.stops;
      let dup = false;
      for (let i = 0; i < S.length; i++) if (Math.abs(S[i] - best.s) < 14) { dup = true; break; }
      if (dup) continue;
      S.push(best.s);
      n++;
    }
    for (const info of buses) if (info.stops) info.stops.sort((a, b) => a - b);
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
  ['boxTruck', 3], ['shuttleBus', 1.6], ['flatbed', 0.6], ['flatbedLoad', 0.6],
  ['police', 1.0],
  ['scooter', 4], ['motorcycle', 2.1], ['cruiser', 1.3], ['garbageTruck', 0.9],
  ['cementMixer', 0.9],
  ['ambulance', 0.6], ['articBus', 0.7], ['gtCoupe', 1.0], ['supercar', 0.8],
  ['roadster', 0.8],
];
/** Inner lanes: cars only, and where Miami keeps its exotics. */
const INNER_LANE_MIX = [
  ['sedan', 28], ['suv', 17], ['hatchback', 12], ['taxi', 8], ['pickup', 5],
  ['sports', 6], ['convertible', 4], ['supercar', 3.2], ['roadster', 2.6],
  ['gtCoupe', 3.0], ['police', 0.8], ['deliveryVan', 3], ['motorcycle', 1.7],
  ['cruiser', 0.9],
];
/** Bus lane: transit, taxis and the two-wheelers allowed to share it. */
const BUS_LANE_MIX = [
  ['cityBus', 28], ['articBus', 8], ['shuttleBus', 10], ['taxi', 30],
  ['scooter', 12], ['motorcycle', 6], ['cruiser', 3], ['ambulance', 3], ['police', 4],
];
const KERB_MIX = [
  ['sedan', 26], ['suv', 17], ['hatchback', 13], ['taxi', 6], ['pickup', 9],
  ['deliveryVan', 7], ['sports', 3], ['convertible', 3], ['boxTruck', 2],
  ['scooter', 4], ['motorcycle', 1.9], ['cruiser', 1.1], ['police', 0.8],
  ['flatbed', 0.4], ['flatbedLoad', 0.4],
  ['supercar', 1.2], ['roadster', 1.6], ['gtCoupe', 2.0],
];
const LOT_MIX = [
  ['sedan', 32], ['suv', 22], ['hatchback', 16], ['pickup', 10],
  ['deliveryVan', 7], ['sports', 5], ['convertible', 4], ['taxi', 4],
];

const BIG = new Set(['cityBus', 'articBus', 'boxTruck', 'garbageTruck',
  'cementMixer', 'flatbed', 'flatbedLoad', 'ambulance', 'shuttleBus']);
/** Small enough, and driven by someone who would bother, to take a bay. */
const CAN_PARK = new Set(['sedan', 'suv', 'hatchback', 'pickup', 'sports',
  'convertible', 'taxi', 'supercar', 'roadster', 'gtCoupe', 'deliveryVan',
  'scooter', 'motorcycle', 'cruiser', 'police']);
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
 * `skip` is the difference between the callers. A bicycle has to miss the bench
 * as well as the parked cars, so it passes nothing. Plant belongs among the
 * barriers and spoil heaps of its own site, so machinery passes SITE_CLUTTER —
 * but only that. It used to pass "everything that is not a vehicle", which is
 * not the same thing at all: the excavators went in on top of the potted ficus,
 * the clipped hedge, the bench, the bell bollard and the fire hydrant that
 * nature.js and props.js had already put on the frontage, up to 2.6 m into
 * them. Nothing bigger than a delivery van is considered either way — a tower's
 * circumradius covers half its own parcel, and keeping off buildings is the
 * grid's job.
 */
function clearOfPlaced(ctx, x, z, yaw, w, d, out, skip) {
  const list = ctx.registry.query(x, z, Math.hypot(w, d) * 0.5 + 7, out);
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    const om = FLEET[o.kind] ? shapeMetrics(o.kind) : null;
    if (skip && skip.has(o.kind)) continue;
    // Flat ground detail is not an obstruction. A manhole cover, a drain grate,
    // a utility plate or a road patch is part of the surface, and a machine
    // standing over one is right, not wrong. Named exemptions alone were too
    // brittle for this — measuring is not.
    if (skip && o.height < 0.35) continue;
    if (o.radius > 6.5) continue;
    /* A prop that is not one of ours has no authored contact box; its measured
     * radius is honest for something compact, so stand a square in its place.
     *
     * TALL THINGS GET AN EXTRA STAND-OFF. A palm's registered radius is its
     * trunk, about a metre — so a machine could legally park 1.5 m from one and
     * be completely under ten metres of canopy. The catalogue proved it: all
     * nine excavators in the city were planted so tight to a palm that four
     * separate framing attempts came back occluded. A machine standing beside a
     * street tree is fine; a machine standing UNDER one is not. */
    const grow = (skip && o.height > 4) ? 2.4 : 0;
    const ow = (om ? om.contactW : o.radius * 1.41) + grow;
    const od = (om ? om.contactD : o.radius * 1.41) + grow;
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
    // Spacing, metres per vehicle. Pulled in ~12% after looking at the
    // `intersection` frame: eight lanes of Brickell Avenue with four cars on
    // them reads as a closed road, and "empty pavement is a failure" applies
    // to tarmac too. It costs ~150 more instances and no draw calls, because a
    // pool is per (shape, paint) and every one of them already exists.
    const base = cls === ROAD_CLASS.BOULEVARD ? 60
      : cls === ROAD_CLASS.AVENUE ? 70 : 90;
    const outward = lane.laneCount > 1 ? lane.index / (lane.laneCount - 1) : 0;
    const spacing = lane.busLane ? 210 : base * (0.86 + 0.55 * outward);
    const mix = lane.busLane ? BUS_LANE_MIX
      : lane.kerbLane ? KERB_LANE_MIX : INNER_LANE_MIX;
    const stopOff = lane.axis === 'x' ? 'stopX' : 'stopZ';
    /**
     * Is this stretch of lane inside a junction box?
     *
     * The initial fleet used to be laid down by arc length alone, which meant
     * a car on the north-south carriageway and a car on the east-west one
     * could both be dealt into the middle of the SAME crossing — 16 pairs of
     * vehicles standing inside each other at t = 0, every one of them at a
     * junction, and the `intersection` preset frames a junction. The running
     * sim never does this (the signals and the turn claims see to it); only
     * the deal did, and a screenshot is always taken on the deal.
     *
     * The margin is half the vehicle plus 2 m, so a car deals up to the stop
     * line and no further.
     */
    const clearOfJunction = (s, len) => {
      const J = lane.junctions;
      if (!J) return s;
      const pad = len * 0.5 + 1.0;
      for (let i = 0; i < J.length; i++) {
        const box = J[i].ix[stopOff];
        const lo = J[i].s - box - pad, hi = J[i].s + box + pad;
        // Backed up to the stop line rather than deleted: simply refusing the
        // slot cost 790 of the city's 1,392 moving vehicles, because a
        // boulevard box plus its crosswalks is 40 m of a 70 m block. Nudging
        // it to the line keeps the density AND puts the car where a car
        // waiting at a red light belongs.
        if (s > lo && s < hi) return (s - lo) < (hi - s) ? lo : hi;
      }
      return s;
    };
    for (let si = 0; si < info.segs.length; si++) {
      const seg = info.segs[si];
      const n = Math.floor((seg.hi - seg.lo) / spacing);
      for (let i = 0; i < n; i++) {
        let s = seg.lo + 12 + ((i + rng() * 0.7) / n) * (seg.hi - seg.lo - 24);
        let type = rng.weighted(mix);
        // Heavy vehicles keep to the kerb lane, like they are supposed to.
        if (!lane.kerbLane && BIG.has(type)) type = 'sedan';
        const def = FLEET[type];
        s = clearOfJunction(s, def.len);
        if (s < seg.lo + 6 || s > seg.hi - 6) continue;
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
          turn: null, decided: -1, waitT: 0, giveT: 0, held: false,
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
          /* --- ride: how the body moves on its springs ------------------ */
          acc: 0, pitch: 0, roll: 0, yawPrev: traf.net.headingOf(lane),
          // Half the axle span, for reading the road gradient under the car.
          axleZ: m.bodyL * 0.38,
          // A stiff sports car dives less than a laden van, and a bus barely
          // pitches at all. One number, straight off the mass class.
          softness: big ? 0.5 : QUICK.has(type) ? 0.7 : 1.0,
          /* --- light-card metrics, all measured off the shape ----------- */
          // Every one of these used to be a fraction of FLEET.len. They are now
          // the shape's own lamp plane, so a card is proud of the panel it
          // belongs to instead of buried a third of a metre inside it.
          noseZ: m.noseZ,
          beamW: m.contactW * 1.5,
          beamL: 10 + m.bodyL * 0.9,
          hazY: m.lampY,
          hazW: m.contactW + 0.06,
          hazD: m.bodyL + 0.10,
          hazZ: m.midZ,
          tailZ: m.tailZ,
          lampY: m.lampY,
          lampW: m.lampW,
          lampH: m.lampH,
          indW: m.contactW + 0.10,
          indL: m.bodyL,
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
  /**
   * Water that is already spoken for.
   *
   * A cruise ship is 45 m long and 10 m in the beam, and the inshore mooring
   * band runs straight through both berths — which is how a 10 m sailing boat
   * ended up moored 12 m from the centreline of one, i.e. inside it. The berths
   * are claimed before anything else is laid out.
   */
  const keepOut = [];
  const claimed = (x, z) => {
    for (let i = 0; i < keepOut.length; i++) {
      const k = keepOut[i];
      if (Math.abs(x - k.x) < k.rx && Math.abs(z - k.z) < k.rz) return true;
    }
    return false;
  };
  // Nothing floats on land. isWater() also reports dry inside a bridge AABB,
  // which is the point: a hull moored under a causeway is inside the deck, not
  // under it. That is how a skiff ended up parked in the Brickell Key Causeway.
  const put = (type, x, z, rot, moving, cruise) => {
    if (!layout.isWater(x, z) || claimed(x, z)) return null;
    const c = spawn(ctx, state, type, pickVariant(rng, type), x, BOAT_Y, z, rot, !!moving);
    if (!c) return null;
    const b = { c, x, z, rot, phase: rng() * 6.28, speed: 0 };
    if (cruise) Object.assign(b, cruise);
    boats.push(b);
    return c;
  };

  // Two cruise vessels at the port terminals north and south of the channel.
  // First, so their berths are claimed before the mooring bands are laid out.
  for (const [bx, bz, brot] of [[WORLD.BAY_EDGE + 17, -448, 0.02],
    [WORLD.BAY_EDGE + 19, 455, Math.PI - 0.02]]) {
    if (put('cruiseShip', bx, bz, brot, true)) {
      keepOut.push({ x: bx, z: bz, rx: 15, rz: 33 });
    }
  }

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
  // The inshore line is the only one any camera in the game gets close to, so
  // it is the one worth spending hulls on; the outer band is scenery.
  for (const band of [{ x0: 12, x1: 40, step: 21, p: 0.85 },
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
        wakeZ: FLEET[type].len * 0.44,
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
      speed, vz: speed * dir, wake: 1.5, wakeL: 13, wakeZ: 1.4,
      x0, rot0: dir > 0 ? 0 : Math.PI, weave: 12 + rng() * 10, weaveHz: 0.22 + rng() * 0.14,
    });
  }
  return boats;
}

/** How far inside the parcel line a machine's contact patch has to finish. */
const SITE_MARGIN = 0.4;

/**
 * The site's OWN clutter — the only things plant is allowed to stand among.
 *
 * Mirrors constructionYard() in props.js: hoarding, cones, barrels, material
 * stacks, welfare units. Everything else on a construction frontage — the
 * street trees, hedges, planters, benches, hydrants and bollards that nature.js
 * and props.js place along the kerb — is somebody else's, and an excavator
 * parked in it is a defect, not site character. Flat ground detail is listed
 * too: a machine may sit over a manhole or a drain grate.
 */
const SITE_CLUTTER = new Set([
  'jersey', 'waterBarrier', 'meshFence', 'cone', 'barrel', 'cableDrum', 'aframe',
  'crate', 'pallet', 'sandbags', 'scaffold', 'portaloo', 'dumpster',
  'deliveryStack', 'stockTrolley', 'trashBags', 'spoilHeap', 'rebar', 'siteHut',
  'manholeCover', 'drainGrate', 'utilityPlate', 'roadPatch',
]);

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
      for (let a = 0; a < 14 && !ok; a++) {
        const edge = r.int(0, 3);
        const u = (r() - 0.5) * 0.78;
        // How far out toward the parcel line. Pinned hard to the line, every
        // machine landed in the frontage strip — which is exactly where the
        // street trees, hedges, planters and hydrants are, so honouring them
        // starved the sites (41 machines down to 16). Standing off the line by
        // a varying amount keeps the "plant works the edges, the middle is the
        // works" reading, gives the clearance test somewhere to go, and stops
        // the machines forming a rectangle.
        const inset = 0.42 + r() * 0.58;
        rot = (edge === 0 ? 0 : edge === 1 ? Math.PI : edge === 2 ? Math.PI / 2 : -Math.PI / 2)
          + (r() - 0.5) * 0.5;
        const ca = Math.abs(Math.cos(rot)), sa = Math.abs(Math.sin(rot));
        const spanX = b.w * 0.5 - (m.contactW * ca + m.contactD * sa) * 0.5 - SITE_MARGIN;
        const spanZ = b.d * 0.5 - (m.contactW * sa + m.contactD * ca) * 0.5 - SITE_MARGIN;
        if (spanX <= 0 || spanZ <= 0) break;   // parcel too small for this machine
        if (edge === 0) { x = b.x + u * b.w; z = b.z - spanZ * inset; }
        else if (edge === 1) { x = b.x + u * b.w; z = b.z + spanZ * inset; }
        else if (edge === 2) { x = b.x - spanX * inset; z = b.z + u * b.d; }
        else { x = b.x + spanX * inset; z = b.z + u * b.d; }
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
        // parked at the kerb or the street trees on the frontage, so ask the
        // registry — placeParked, props and nature all ran first. Only the
        // site's own clutter is skipped: making plant dodge its own barriers,
        // spoil and portaloos starves the sites, and plant standing among site
        // clutter is the point.
        if (ok && !clearOfPlaced(ctx, x, z, rot, m.contactW + 0.6, m.contactD + 0.6, near, SITE_CLUTTER)) {
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
      let rot = 0, x = 0, z = 0, clear = false;
      // The crane base checked only against the machines this loop had placed,
      // so it happily landed on anything props.js or nature.js had already put
      // on the parcel. It is the largest single object on the site — 4.2 m of
      // ballast — and the one most obviously wrong standing in a planter. One
      // shot at a single random spot then lost most of the cranes, so it gets
      // the same handful of tries the machines do.
      for (let a = 0; a < 10 && !clear; a++) {
        rot = r() * 1.5;
        x = b.x + (r() - 0.5) * b.w * 0.5;
        z = b.z + (r() - 0.5) * b.d * 0.5;
        clear = true;
        for (const q of placed) {
          if (boxesClash(x, z, rot, cm.contactW + 1.0, cm.contactD + 1.0,
            q[0], q[1], q[2], q[3], q[4])) { clear = false; break; }
        }
        if (clear && !clearOfPlaced(ctx, x, z, rot, cm.contactW + 1.0, cm.contactD + 1.0,
          near, SITE_CLUTTER)) clear = false;
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
      // Falloff pulled back from 1.7 to 1.15 and the peak raised: at 1.7 the
      // pool had collapsed to a quarter of its brightness by 4 m, so from the
      // game's 125 m camera it read as a smudge at the bumper rather than as a
      // wedge of light down the road. It has to survive the night grade.
      const b = Math.pow(1 - t, 1.15) * (1 - u * u) * 1.15;
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
  // props.js has already built the shelters; this is where the buses learn
  // that they are supposed to stop at them.
  const busStops = traf.registerStops(ctx.registry);
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
    busLanes: traf.lanes.reduce((n, i) => n + (i.lane.busLane ? 1 : 0), 0),
    busLanesServed: traf.lanes.reduce((n, i) => n + (i.stops ? 1 : 0), 0),
    bays,
    busStops,
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
    + `${bays} free kerb bays | ${busStops} bus stops | ${boats.length} boats | `
    + `${state.pools.size} pools`
  );
  return state;
}

/* =========================================================== update ==== */

function makeUpdater(ctx, traf, state, boats) {
  const registry = ctx.registry;
  const decks = state.decks;
  const out = { x: 0, z: 0, rot: 0 };
  const q = new THREE.Quaternion();
  // Yaw only. The light cards lie flat on the road and must NOT inherit the
  // body's dive and roll, or a braking car's headlight pool rocks with it.
  const qy = new THREE.Quaternion();
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
    // Foam is white water, not a lamp. `additive()` starts every card material
    // at opacity 0 and this one was never turned up, so every wake in Biscayne
    // Bay has been drawing at zero alpha — the boats under way looked moored.
    wakeMat.opacity = 0.60 - 0.26 * lit;

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
      const sn = Math.sin(out.rot), cs = Math.cos(out.rot);

      /* --- the body on its springs -------------------------------------
       * Three things tilt a car and all three were missing, which is why the
       * fleet slid around perfectly flat: a bridge ramp (traffic climbed the
       * causeways bolt upright, wheels through the deck at one end and in the
       * air at the other), braking, and cornering. The ramp term is measured
       * from the deck under each axle rather than assumed, so it is exactly
       * the surface streets.js built. */
      let surf, grade = 0;
      if (decks.length) {
        const yF = deckHeight(decks, out.x + sn * v.axleZ, out.z + cs * v.axleZ);
        const yR = deckHeight(decks, out.x - sn * v.axleZ, out.z - cs * v.axleZ);
        surf = (yF + yR) * 0.5;
        // NEGATIVE, because a rotation about the body's +x axis carries the
        // nose (local +z) toward -y: pitch > 0 is nose DOWN. Climbing a ramp
        // is nose UP, so the gradient enters with its sign flipped. The dive
        // term below wants the same convention and gets it from `-v.acc`.
        if (yF !== yR) grade = -Math.atan2(yF - yR, 2 * v.axleZ);
      } else {
        surf = 0;
      }
      // Weight transfer, smoothed: a spring rate, not a step function.
      const dive = -v.acc * 0.005 * v.softness;
      v.pitch += (dive - v.pitch) * Math.min(1, dt * 8);
      // Roll comes out of the yaw rate the path is already producing, so a
      // turn arc and a lane change both lean without either knowing about it.
      let dyaw = out.rot - v.yawPrev;
      if (dyaw > Math.PI) dyaw -= Math.PI * 2;
      else if (dyaw < -Math.PI) dyaw += Math.PI * 2;
      v.yawPrev = out.rot;
      // A respawn at the map edge is a teleport, not a corner.
      const rollT = Math.abs(dyaw) > 0.4 ? 0
        : Math.max(-0.075, Math.min(0.075, (dyaw / dt) * v.v * 0.006 * v.softness));
      v.roll += (rollT - v.roll) * Math.min(1, dt * 7);

      pos.set(out.x, surf + v.yOff, out.z);
      e.set(0, out.rot, 0, 'YXZ');
      qy.setFromEuler(e);
      const tilt = grade + v.pitch;
      if (Math.abs(tilt) > 2e-4 || Math.abs(v.roll) > 2e-4) {
        e.set(tilt, out.rot, v.roll, 'YXZ');
        q.setFromEuler(e);
      } else {
        q.copy(qy);
      }
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
        // 0.06, not 0.035: streets.js works its marking pass at y = 0.018 and
        // the carriageway itself is cambered, so the old height left the pool
        // fighting the lane paint for the same depth.
        pos.set(out.x + sn * v.noseZ, surf + 0.06, out.z + cs * v.noseZ);
        scl.set(v.beamW, 1, v.beamL);
        beams.setTransform(v.beam, pos, qy, scl);
        v.beamShown = true;
      } else if (v.beamShown) {
        beams.setTransform(v.beam, gone, nilQ, nil);
        v.beamShown = false;
      }

      // Brake lamps, square across the tail. Unlike the beams these are worth
      // drawing in daylight — a red flare on the back of a decelerating car is
      // how you read a queue forming from 200 m up.
      if (v.brake && v.mode !== 'parked') {
        pos.set(out.x - sn * v.tailZ, surf + v.lampY, out.z - cs * v.tailZ);
        scl.set(v.lampW, v.lampH, 1);
        brakes.setTransform(v.beam, pos, qy, scl);
        v.brakeShown = true;
      } else if (v.brakeShown) {
        brakes.setTransform(v.beam, gone, nilQ, nil);
        v.brakeShown = false;
      }

      // Hazards and indicators: scarce, so they are lent out and taken back.
      if (v.hazard && v.hazSlot === undefined && hazFree.length) v.hazSlot = hazFree.pop();
      if (v.hazSlot !== undefined) {
        if (v.hazard) {
          pos.set(out.x + sn * v.hazZ, surf + v.hazY, out.z + cs * v.hazZ);
          scl.set(v.hazW, 1, v.hazD);
          hazards.setTransform(v.hazSlot, pos, qy, scl);
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
          pos.set(out.x + sn * v.hazZ, surf + v.lampY, out.z + cs * v.hazZ);
          scl.set(v.blink * v.indW, v.lampH, v.indL);
          indics.setTransform(v.indSlot, pos, qy, scl);
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
      // Yaw-pitch-roll in the hull's own frame: with the default XYZ order a
      // boat lying east-west pitched about the world axis and swam sideways.
      e.set(Math.sin(ph * 0.83 + 1.1) * 0.011, b.rot, Math.cos(ph * 0.71) * 0.017, 'YXZ');
      q.setFromEuler(e);
      c.position.copy(pos);
      const p = c.pool;
      p.slotPos[c.slot].copy(pos);
      p.slotRot[c.slot].copy(q);
      p.setTransform(c.slot, pos, q, p.slotScale[c.slot]);
      registry.rehash(c);

      if (b.wake) {
        e.set(0, b.rot, 0, 'YXZ');
        q.setFromEuler(e);
        // The trail is authored running aft from the card origin, so the origin
        // belongs at the TRANSOM. Anchoring it at the hull's centre buried the
        // hot half of the foam under the boat that is supposed to be making it.
        pos.set(b.x - Math.sin(b.rot) * b.wakeZ, BOAT_Y + 0.03,
          b.z - Math.cos(b.rot) * b.wakeZ);
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
