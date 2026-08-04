/**
 * STREETS — the ground plane, the carriageway, kerbs, sidewalks, every painted
 * marking, medians, service alleys, the river bridges and all the ironwork.
 *
 * ---------------------------------------------------------------------------
 * THE LAYER / Y-OFFSET SCHEME  (read this before adding a surface)
 * ---------------------------------------------------------------------------
 * Almost everything here is coplanar with something else, so the ordering is
 * fixed by BOTH a small world-space y offset AND a polygon offset. The y offset
 * alone is not enough: at menu-hero range the far side of the city is ~800 m
 * out, where a 24-bit depth buffer with near=1/far=1400 resolves about 3 cm —
 * more than the gaps below. polygonOffset is resolution-independent, so it is
 * what actually guarantees the ordering; the y offsets just keep the silhouette
 * sane when you look along a surface edge-on.
 *
 *   -0.900  water fallback bed   (only ever seen where water.js draws nothing)
 *   -0.030  base land            vacant ground, riverbank, everything unbuilt
 *   -0.010  service alleys
 *   -0.006  the diagonal transit cut (must lose to the roads it crosses)
 *    0.000  carriageway, junction boxes, bridge decks
 *    0.008  asphalt repair panels + wheel-track polish     (pofs -2)
 *    0.010  bus-lane paint                                 (pofs -3)
 *    0.018  all line marking: lanes, zebras, stop bars, arrows   (pofs -5)
 *    0.024  ironwork lids — manholes, gully grates, service covers  (pofs -7)
 *    0.155  Y_WALK, the sidewalk top
 *
 * The carriageway itself never self-overlaps: roads are cut at every crossing
 * road and the junction squares are emitted separately, so there is no
 * road-on-road coplanar pair anywhere in the city.
 *
 * ---------------------------------------------------------------------------
 * WHY THE KERB IS A SWEPT PROFILE
 * ---------------------------------------------------------------------------
 * A kerb made of four thin boxes reads as a strip of tape. A real kerb is a
 * profile: a concrete gutter pan the road drains into, a battered face, a
 * chamfered nose that catches the sun, a top, and the back where it meets the
 * paving. That profile is swept around each block as one mitred ring, and the
 * ring carries the SIDEWALK BAND too — which is what makes kerb ramps possible:
 * a ramp is just a station on the sweep where the whole profile is pushed down.
 *
 * The ring is one mesh with vertex colours, so gutter / face / nose / top /
 * paving all come out of a single draw call and a single paving texture.
 *
 * ---------------------------------------------------------------------------
 * COASTLINE
 * ---------------------------------------------------------------------------
 * The base plane used to be one giant rectangle that ran out under the bay and
 * straight through the marina basins. It is now emitted column by column and
 * clipped to `layout.isWater`, so the shore silhouette is the real one. Where
 * the land is removed a flat turquoise bed is dropped in at -0.9 m: water.js
 * currently only renders a straight bay and a straight river, so the bed is
 * what stops the bent river mouth, the basins and the Brickell Key cuts from
 * becoming holes straight through to the sky. Once water.js covers those it is
 * never visible.
 */

import * as THREE from 'three';
import { WORLD, PALETTE } from '../config.js';
import { Textures, ground, solid } from '../core/materials.js';
import { makeRNG } from '../core/rng.js';
import { ROAD_CLASS, ZONE } from './cityLayout.js';
import { RoadNetwork, LANE_W } from './roadNetwork.js';

const { STREET, AVENUE, BOULEVARD } = ROAD_CLASS;

const Y_BED = -0.90;
const Y_BASE = -0.030;
const Y_ALLEY = -0.010;
const Y_DIAG = -0.006;
const Y_ROAD = 0.0;
const Y_PATCH = 0.008;
const Y_TINT = 0.010;
const Y_MARK = 0.018;
const Y_IRON = 0.024;
export const Y_WALK = 0.155;

/**
 * Width of the concrete gutter pan. Two facing kerbs must fit inside the
 * narrowest gap cityLayout produces between parcels (a 0.8 m party-wall seam),
 * so this can never exceed 0.4.
 */
const GUTTER_W = 0.36;

/**
 * The kerb + sidewalk cross-section, measured as an inset from the block edge.
 * Negative = out over the asphalt. `c` is a vertex-colour multiplier on the
 * paving albedo.
 *
 * The VALUE spread across the profile is doing the real work. From the game's
 * 40-degree camera a kerb is about four pixels wide, so it cannot be read as a
 * shape — it has to be read as a value sequence: dark asphalt, light gutter
 * pan, one dark line where the face is in shadow, a bright chamfered nose, then
 * paving. Flatten those numbers and the kerb disappears, which is exactly how
 * the previous four-thin-boxes version looked.
 */
const PROFILE = [
  { o: -GUTTER_W, y: 0.016, c: 0.82 },   // outer lip of the gutter pan
  { o: -0.17, y: 0.006, c: 0.70 },       // channel invert — water runs here
  { o: -0.01, y: 0.040, c: 0.88 },       // toe of the kerb
  { o: 0.05, y: 0.128, c: 0.60 },        // battered face, deep in its own shadow
  { o: 0.13, y: 0.192, c: 1.22 },        // chamfered nose — the sunlit highlight
  { o: 0.30, y: 0.202, c: 1.10 },        // kerb top
  { o: 0.46, y: Y_WALK, c: 0.94 },       // back of kerb
  // Kerb-slab band. A real footway is laid in two materials: a run of heavier
  // slabs against the kerb and the field behind it. Splitting the sweep here
  // costs two triangles per station and gives every block a value band it can
  // vary independently — which is the cheapest cure there is for a paving
  // texture whose repeat period you can otherwise count.
  { o: 1.10, y: Y_WALK, c: 1.0 },        // back of the kerb-slab band
  { o: 1.90, y: Y_WALK, c: 1.0 },        // front of the walking zone (ramp run)
  { o: 0, y: Y_WALK, c: 1.0 },           // building line — `o` filled per block
];
/**
 * Same stations, dropped flush for a kerb ramp. The o=1.10 entry is the exact
 * linear interpolant of the old 0.46 -> 1.90 run, so inserting that station
 * left every existing ramp gradient unchanged.
 */
const PROFILE_DROP = [0.016, 0.006, 0.030, 0.040, 0.052, 0.058, 0.064, 0.1044, Y_WALK, Y_WALK];
/** Index of the profile band that carries the kerb-slab colour. */
const BAND_I = 6;

const RAMP_A = 1.2;      // ramp starts this far from the block corner
const RAMP_B = 4.9;      // ...and ends here. Matches the zebra corridor below.
const RAMP_FLARE = 0.7;

/**
 * Seven-segment strokes per digit — bay numbers and painted speed limits.
 * Chunky beats accurate: a stroke-accurate stencil numeral is 60 mm wide and
 * lands inside one pixel from the game camera. Module scope because the paint
 * functions that read it are hoisted and called from the marking pass above.
 */
const SEG7 = {
  0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abcdg', 4: 'fgbc',
  5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
};

/** Vehicle crossover (driveway) — dropped kerb width and its flares. */
const XOVER_MIN = 4.6;
const XOVER_MAX = 7.4;
const XOVER_FLARE = 0.9;

const CROSS_GAP = 1.1;   // clear gap between the junction box and the zebra
const CROSS_W = 3.6;     // walking width of a zebra crossing
const BAR_W = 0.55;      // one zebra bar
const BAR_PITCH = 1.18;
const STOP_BAR = 0.45;
const STOP_SET = 0.95;   // stop line sits this far back from the zebra

/* ========================================================== geometry === */

/**
 * Flat-shaded triangle-soup builder.
 *
 * Everything in this module is static and unique, so nothing is instanced and
 * nothing is merged after the fact: each mesh accumulates straight into typed
 * arrays and is built once. That is both faster at boot than
 * mergeGeometries-over-thousands-of-tiny-BufferGeometries and much lighter on
 * peak memory.
 *
 * UVs are WORLD space (x/unit, z/unit) on every horizontal face, which is why
 * a road can be cut into 300 separate pieces and still show one continuous,
 * seamless asphalt field.
 */
class Surf {
  constructor(uvUnit = 4) {
    this.uv = uvUnit;
    this.p = []; this.n = []; this.t = []; this.c = [];
  }

  _v(x, y, z, nx, ny, nz, u, v, col) {
    this.p.push(x, y, z);
    this.n.push(nx, ny, nz);
    this.t.push(u, v);
    if (typeof col === 'number') this.c.push(col, col, col);
    else this.c.push(col[0], col[1], col[2]);
  }

  /**
   * Quad from four world points in order around the perimeter.
   * `wall` switches the UV projection to (horizontal run, height) so a vertical
   * face gets an unstretched texture instead of a smear.
   */
  quad(a, b, c, d, col, wall) {
    this.tri(a, b, c, col, wall);
    this.tri(a, c, d, col, wall);
  }

  tri(a, b, c, col, wall) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz);
    if (L < 1e-9) return;                 // degenerate: a mitre swallowed it
    nx /= L; ny /= L; nz /= L;
    const s = 1 / this.uv;
    for (const q of [a, b, c]) {
      const u = wall ? (q[0] + q[2]) * s : q[0] * s;
      const v = wall ? q[1] * s : q[2] * s;
      this._v(q[0], q[1], q[2], nx, ny, nz, u, v, col);
    }
  }

  /**
   * Quad that must end up facing UP whatever order the caller had its corners
   * in. Every swept profile in this file walks its edge in a different
   * direction, and getting one of them backwards silently back-face-culls a
   * whole block of pavement — so the orientation is enforced here instead of
   * being a per-call invariant nobody can check by eye.
   */
  quadUp(a, b, c, d, col) {
    const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    if (ny < 0) this.quad(d, c, b, a, col);
    else this.quad(a, b, c, d, col);
  }

  /** Axis-aligned horizontal rectangle. */
  rect(x0, x1, z0, z1, y, col) {
    if (x1 - x0 < 1e-4 || z1 - z0 < 1e-4) return;
    this.quad([x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0], col);
  }

  /** Convex polygon on a horizontal plane, always up-facing. `pts` = [[x,z]]. */
  polyY(pts, y, col) {
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      area += a[0] * b[1] - b[0] * a[1];
    }
    const p = area > 0 ? pts : [...pts].reverse();
    for (let i = 1; i < p.length - 1; i++) {
      this.tri(
        [p[0][0], y, p[0][1]],
        [p[i + 1][0], y, p[i + 1][1]],
        [p[i][0], y, p[i][1]],
        col
      );
    }
  }

  /** Axis-aligned box with flat faces (top, four sides; no bottom). */
  box(x0, x1, y0, y1, z0, z1, col, topCol) {
    const tc = topCol === undefined ? col : topCol;
    this.quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], tc);
    this.quad([x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0], col, true);
    this.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], col, true);
    this.quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], col, true);
    this.quad([x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1], col, true);
  }

  get empty() { return this.p.length === 0; }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.t, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.computeBoundingSphere();
    return g;
  }
}

function addMesh(group, surf, material, name, shadow = true) {
  if (surf.empty) return null;
  const m = new THREE.Mesh(surf.build(), material);
  m.name = name;
  m.receiveShadow = shadow;
  m.castShadow = false;
  m.matrixAutoUpdate = false;
  group.add(m);
  return m;
}

/** Depth-fight insurance for a layer that is coplanar with the one below it. */
function layer(params, depth) {
  return ground({
    ...params,
    polygonOffset: true,
    polygonOffsetFactor: -depth,
    polygonOffsetUnits: -depth * 2,
  });
}

/* ------------------------------------------------------------ intervals -- */

/** Subtract [a,b] from a list of [lo,hi] runs. */
function cut(runs, a, b) {
  const out = [];
  for (const [lo, hi] of runs) {
    if (b <= lo || a >= hi) { out.push([lo, hi]); continue; }
    if (a > lo) out.push([lo, a]);
    if (b < hi) out.push([b, hi]);
  }
  return out;
}

/**
 * Runs along a road's free axis where the centreline is dry land.
 * The wet/dry flip is bisected to 25 cm so the carriageway stops exactly on the
 * bank instead of on a 4 m sampling grid — the coastline has to be crisp.
 */
function dryRuns(layout, r, lo, hi) {
  const at = (t) => (r.axis === 'x'
    ? layout.isWater(r.pos, t)
    : layout.isWater(t, r.pos));
  const bisect = (a, b) => {
    for (let i = 0; i < 5; i++) {
      const m = (a + b) / 2;
      if (at(m) === at(a)) a = m; else b = m;
    }
    return (a + b) / 2;
  };
  const out = [];
  const STEP = 4;
  let start = at(lo) ? null : lo;
  let prev = lo;
  for (let t = lo + STEP; t <= hi; t += STEP) {
    const wet = at(t);
    if (wet && start !== null) { out.push([start, bisect(prev, t)]); start = null; }
    else if (!wet && start === null) start = bisect(prev, t);
    prev = t;
  }
  if (start !== null) out.push([start, hi]);
  return out;
}

/* ============================================================== build === */

export function buildStreets(ctx) {
  const { layout } = ctx;
  const S = WORLD.SIZE;
  const BAY = WORLD.BAY_EDGE;
  const rng = makeRNG((layout.seed ^ 0x57ee71) >>> 0);
  const group = ctx.group('streets');

  // The lane graph is the shared substrate: painting from it is the only way
  // the stop bars and arrows can land where cars actually stop and turn.
  const net = new RoadNetwork(layout);
  ctx.roads = net;

  // Only a narrow apron past the last block: the base plane is what shows when
  // nothing else claims the ground, and a wide skirt of it around the map is a
  // big empty flat in the menu-hero frame.
  const LAND_X0 = -S - 16, LAND_X1 = BAY;
  const LAND_Z0 = -S - 16, LAND_Z1 = S + 16;

  const land = new Surf(5.0);
  const bed = new Surf(20);
  const road = new Surf(9.0);
  const alley = new Surf(4.0);
  const patch = new Surf(9.0);
  const busl = new Surf(9.0);
  const white = new Surf(4);
  const yellow = new Surf(4);
  const walk = new Surf(4.8);
  const plant = new Surf(6.0);
  const iron = new Surf(1.0);
  const hedge = new Surf(2.0);
  const struct = new Surf(3.2);
  const lampPole = new Surf(1.0);
  const lampGlow = new Surf(1.0);

  /**
   * Flat-colour paint, one mesh, real per-vertex RGB.
   *
   * Everything else in this file uses vertex colour as a scalar multiplier on a
   * mapped albedo, which can only move a surface lighter or darker. A blue
   * disabled bay, a green cycle strip, a buff tactile pad and a concrete
   * driveway apron all need a HUE, so this mesh runs a white base colour and
   * lets the vertex attribute carry the whole albedo. One extra draw call buys
   * every coloured marking in the city.
   */
  const flat = new Surf(1.0);
  /** Crack sealant. Its own mesh only because tar is near-black and glossy. */
  const tar = new Surf(1.0);

  /** sRGB palette entry -> the linear triple a vertex-colour attribute wants. */
  const _lc = new THREE.Color();
  const lin = (hex, k = 1) => {
    _lc.set(hex);
    return [_lc.r * k, _lc.g * k, _lc.b * k];
  };

  const C_TACTILE = [lin(0xc4552f), lin(PALETTE.CURB_PAINT), lin(0xb8603a)];
  const C_APRON = lin(PALETTE.CONCRETE_DARK, 0.92);
  const C_BAY_BLUE = lin(0x2f6fbf);
  const C_CYCLE = lin(0x3f7f5c);
  const C_KERB_PAINT = lin(PALETTE.CURB_PAINT);

  const stat = {
    crossBars: 0, ramps: 0, manholes: 0, arrows: 0, medianM: 0, bridges: 0,
    xovers: 0, bays: 0, loading: 0, accessible: 0, seams: 0, cycleM: 0,
  };

  /**
   * Deterministic 0..1 hash. Used to fade paint: a city where every dash is
   * exactly the same brightness reads as a stencil, and the high-contrast
   * white is also what makes distant sub-pixel lines fringe under the lens
   * aberration in the grade.
   *
   * Declared up here rather than beside the marking pass because the alley and
   * diagonal passes above it need the same numbers, and a `const` used before
   * its line is a temporal-dead-zone throw, not a hoist.
   */
  const fade = (a, b) => {
    const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
    return 0.82 + (s - Math.floor(s)) * 0.18;
  };

  /** The same hash spread over the full 0..1 — used to pick, not to fade. */
  const h01 = (a, b) => {
    const s = Math.sin(a * 45.233 + b * 91.117) * 24634.6345;
    return s - Math.floor(s);
  };

  /* ================================================== 1. land + coast === */
  buildLand();

  function buildLand() {
    const river = layout.river;
    const xs = new Set([LAND_X0, LAND_X1]);
    for (let x = LAND_X0; x < LAND_X1; x += 6) xs.add(x);
    for (const p of layout.waterPolys) {
      if (p.x0 > LAND_X0 && p.x0 < LAND_X1) xs.add(p.x0);
      if (p.x1 > LAND_X0 && p.x1 < LAND_X1) xs.add(p.x1);
    }
    const cols = [...xs].sort((a, b) => a - b);

    // The channel band at a given x: the bent river, unioned with the straight
    // band water.js actually renders (cityLayout guarantees both are wet).
    const bank = (x) => {
      const c = river.centerAt(x), h = river.halfAt(x);
      return [
        Math.min(c - h, WORLD.RIVER_Z - WORLD.RIVER_HALF_W),
        Math.max(c + h, WORLD.RIVER_Z + WORLD.RIVER_HALF_W),
      ];
    };

    // NB: no bulkhead wall is built along this bank. water.js extracts the same
    // coastline from the same predicate and stands a continuous seawall with
    // bollards on it, so a wall here would be a second one in exactly the same
    // place — duplicate geometry and a guaranteed z-fight.
    for (let i = 0; i < cols.length - 1; i++) {
      const xa = cols[i], xb = cols[i + 1];
      if (xb - xa < 1e-4) continue;
      const [ta, ba] = bank(xa);
      const [tb, bb] = bank(xb);

      // Trapezoid land north and south of the channel: keeping the two z edges
      // independent is what makes the bank read as a curve rather than a
      // staircase of 6 m steps.
      let strips = [
        { z0a: LAND_Z0, z0b: LAND_Z0, z1a: ta, z1b: tb },
        { z0a: ba, z0b: bb, z1a: LAND_Z1, z1b: LAND_Z1 },
      ];
      // Marina basins and the Brickell Key cuts. Column boundaries were seeded
      // with every rect edge, so a rect either spans this column or misses it.
      for (const p of layout.waterPolys) {
        if (p.x0 > xa + 1e-4 || p.x1 < xb - 1e-4) continue;
        const next = [];
        for (const s of strips) {
          const lo = Math.max(s.z0a, s.z0b), hi = Math.min(s.z1a, s.z1b);
          if (p.z1 <= lo || p.z0 >= hi) { next.push(s); continue; }
          if (p.z0 > lo) next.push({ z0a: lo, z0b: lo, z1a: p.z0, z1b: p.z0 });
          if (p.z1 < hi) next.push({ z0a: p.z1, z0b: p.z1, z1a: hi, z1b: hi });
        }
        strips = next;
      }
      for (const s of strips) {
        if (s.z1a - s.z0a < 0.2 && s.z1b - s.z0b < 0.2) continue;
        land.quad(
          [xa, Y_BASE, s.z0a], [xa, Y_BASE, s.z1a],
          [xb, Y_BASE, s.z1b], [xb, Y_BASE, s.z0b], 1.0
        );
      }
      // Fallback bed under everything the land clip removed.
      bed.quad([xa, Y_BED, ta], [xa, Y_BED, ba], [xb, Y_BED, bb], [xb, Y_BED, tb], 1.0);
    }
    for (const p of layout.waterPolys) {
      bed.rect(p.x0, p.x1, p.z0, p.z1, Y_BED, 1.0);
    }
  }

  /* ================================================== 2. carriageway === */

  /** Per-road lane plan. Painted lanes always contain the RoadNetwork lanes. */
  function lanePlan(r) {
    const inner = r.median ? r.medianW * 0.5 : 0;
    let lanes = r.cls === STREET ? 2 : (r.cls === BOULEVARD && r.median ? 3 : 4);
    let bus = r.cls === BOULEVARD;
    let park = r.half - inner - lanes * LANE_W - (bus ? LANE_W : 0) - 0.4;
    if (park < 1.9 && bus) { bus = false; park += LANE_W; }
    while (park < 1.9 && lanes > 1) { lanes--; park += LANE_W; }
    return { inner, lanes, bus, park, busEdge: inner + lanes * LANE_W };
  }

  const junctionSpansX = layout.roadsZ.map((c) => [c.pos - c.half, c.pos + c.half]);
  const junctionSpansZ = layout.roadsX.map((c) => [c.pos - c.half, c.pos + c.half]);

  /* --------------------------------------------------------- bridges ---- */
  /**
   * Deck height and approach-ramp length are a CONTRACT, not a style choice:
   * vehicles.js pins traffic to `1.2 * clamp((half + 7 - |d|) / 7)` inside each
   * bridge AABB. Change either number here and every car on the crossing either
   * floats a metre over the deck or drives through it.
   */
  const DECK_Y = 1.2;
  const DECK_RAMP = 7;

  /** Along-axis extent of a bridge, clamped so a ramp never lands on a road. */
  const bridgeSpans = layout.bridges.map((br) => {
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
      br, alongZ, lo, hi,
      rampLo: Math.min(DECK_RAMP, freeLo),
      rampHi: Math.min(DECK_RAMP, freeHi),
      cross: alongZ ? br.x : br.z,
      halfW: br.width / 2,
    };
  });

  /** Remove every bridge (plus its ramps) from a road's runs. */
  function cutBridges(r, runs) {
    for (const s of bridgeSpans) {
      if (r.axis === 'x') {
        if (!s.alongZ || Math.abs(s.cross - r.pos) > s.halfW) continue;
      } else if (s.alongZ || Math.abs(s.cross - r.pos) > s.halfW) continue;
      runs = cut(runs, s.lo - s.rampLo, s.hi + s.rampHi);
    }
    return runs;
  }

  /** Runs of open carriageway: dry, off the junctions, off the bridge decks. */
  function carriagewayRuns(r) {
    const hi = r.axis === 'x' ? S + 30 : BAY;
    let runs = dryRuns(layout, r, -S - 30, hi);
    for (const [a, b] of (r.axis === 'x' ? junctionSpansX : junctionSpansZ)) runs = cut(runs, a, b);
    return cutBridges(r, runs);
  }

  /** Runs of paint. The bridge deck paints itself, at deck height. */
  function paintRuns(r) {
    const hi = r.axis === 'x' ? S + 30 : BAY;
    let runs = dryRuns(layout, r, -S - 30, hi);
    for (const [a, b] of (r.axis === 'x' ? junctionSpansX : junctionSpansZ)) {
      runs = cut(runs, a - 6.5, b + 6.5);
    }
    return cutBridges(r, runs);
  }

  /**
   * Bus-lane bed. Unlike paint this is cut only at the junction box itself:
   * a coloured lane that stops 6.5 m short of every crossing turns into a row
   * of loose orange rectangles, which is the exact failure the crosswalks were
   * just rebuilt to avoid.
   */
  function tintRuns(r) {
    const hi = r.axis === 'x' ? S + 30 : BAY;
    let runs = dryRuns(layout, r, -S - 30, hi);
    for (const [a, b] of (r.axis === 'x' ? junctionSpansX : junctionSpansZ)) {
      runs = cut(runs, a - 0.4, b + 0.4);
    }
    return cutBridges(r, runs);
  }

  for (const r of layout.roadsX) {
    for (const [a, b] of carriagewayRuns(r)) {
      road.rect(r.pos - r.half, r.pos + r.half, a, b, Y_ROAD, 1.0);
    }
  }
  for (const r of layout.roadsZ) {
    for (const [a, b] of carriagewayRuns(r)) {
      road.rect(a, b, r.pos - r.half, r.pos + r.half, Y_ROAD, 1.0);
    }
  }
  for (const ix of net.intersections) {
    road.rect(ix.x - ix.halfX, ix.x + ix.halfX, ix.z - ix.halfZ, ix.z + ix.halfZ, Y_ROAD, 1.0);
  }

  /* --- service alleys ---------------------------------------------------- */
  for (const a of layout.alleys) {
    alley.rect(a.x - a.w / 2, a.x + a.w / 2, a.z - a.d / 2, a.z + a.d / 2, Y_ALLEY, 1.0);
    // A shallow centre channel — alleys drain down the middle, not to a kerb.
    if (a.w > a.d) iron.rect(a.x - a.w / 2, a.x + a.w / 2, a.z - 0.16, a.z + 0.16, Y_ALLEY + 0.006, 0.62);
    else iron.rect(a.x - 0.16, a.x + 0.16, a.z - a.d / 2, a.z + a.d / 2, Y_ALLEY + 0.006, 0.62);

    /* ECHELON BAYS. The only angled parking in the city, and this is the only
       place it can live: buildings.js owns the surface car parks and paints
       its own stalls in them, and the kerbside grid on the street network is
       parallel by construction — vehicles.js parks nose-to-tail on a 6.6 m
       tick. A 7 m service alley is exactly wide enough to mark one side up at
       45 degrees, which is what a real loading alley behind a retail block
       has. */
    const alongX = a.w > a.d;
    const L = alongX ? a.w : a.d;
    const W = alongX ? a.d : a.w;
    if (W < 6.4 || L < 24) continue;
    const P = alongX
      ? (t, o) => [a.x - a.w / 2 + t, a.z - a.d / 2 + o]
      : (t, o) => [a.x - a.w / 2 + o, a.z - a.d / 2 + t];
    const side = h01(a.x, a.z) < 0.5 ? 0 : 1;      // which wall the bays face
    const flip = (o) => (side ? W - o : o);
    const depth = Math.min(4.2, W * 0.5 - 0.5);
    const hw = 0.09;
    for (let t = 3.0; t < L - depth - 6.0; t += 3.15) {
      const q = (dt, dof) => {
        const [x, z] = P(t + dt, flip(0.5 + dof));
        return [x, Y_MARK, z];
      };
      // 45-degree stripe, thickened along the (+1,-1) diagonal.
      const s0 = side ? -1 : 1;
      white.quadUp(
        q(hw, -hw * s0), q(depth + hw, depth - hw * s0),
        q(depth - hw, depth + hw * s0), q(-hw, hw * s0), 0.88
      );
    }
    /* Hatched loading box at the head of the alley — a bin lorry has to be
       able to turn round in here, and the hatch is what says so. */
    const bx0 = L - depth - 4.6, bx1 = L - 1.4;
    if (bx1 - bx0 > 2) {
      for (let k = 0; k < 5; k++) {
        const f = bx0 + (k + 0.5) * ((bx1 - bx0) / 5);
        const run = Math.min(W - 1.2, bx1 - f);
        if (run < 0.8) continue;
        const [ax0, az0] = P(f, 0.6);
        const [ax1, az1] = P(f + run, 0.6 + run);
        yellow.quadUp(
          [ax0, Y_MARK, az0], [ax0 + 0.13, Y_MARK, az0 + 0.13],
          [ax1 + 0.13, Y_MARK, az1 + 0.13], [ax1, Y_MARK, az1], 0.84
        );
      }
    }
  }

  /* --- the diagonal transit cut ----------------------------------------- */
  /**
   * The SURFACE is emitted into the ALLEY layer on purpose: it crosses every
   * road it meets, and the alley layer's polygon offset sits between the base
   * land and the carriageway, so the roads always win the overlap at any view
   * distance.
   *
   * The PAINT cannot follow that rule — paint has to beat the surface under it
   * and would then beat the carriageway wherever the two cross. So every
   * marking here is emitted segment by segment and dropped inside a crossing
   * road's box, which is also simply correct: a transit lane stops at the
   * junction and starts again on the other side.
   *
   * THIS IS ALSO THE ONLY PLACE IN THE CITY WITH ROOM FOR A CYCLE TRACK.
   * A protected lane wants ~1.4 m clear. lanePlan leaves at most 3.8 m of
   * kerbside width anywhere on the grid, and a parked car eats all but 0.95 m
   * of that — so on an ordinary street a painted cycle lane would either move
   * the bay grid the parked fleet is aligned to, or be a lane with cars
   * demonstrably sitting in it. 24 m of transit corridor has the room.
   */
  const onCrossRoad = (x, z) => {
    for (const r of layout.roadsX) if (Math.abs(x - r.pos) < r.half + 1.4) return true;
    for (const r of layout.roadsZ) if (Math.abs(z - r.pos) < r.half + 1.4) return true;
    return false;
  };

  for (const d of layout.diagonals) {
    const nx = d.nx * d.half, nz = d.nz * d.half;
    alley.quad(
      [d.ax - nx, Y_DIAG, d.az - nz], [d.ax + nx, Y_DIAG, d.az + nz],
      [d.bx + nx, Y_DIAG, d.bz + nz], [d.bx - nx, Y_DIAG, d.bz - nz], 1.0
    );

    /** Strip of paint between two lateral offsets, over [t0,t1] along the cut. */
    const strip = (t0, t1, c0, c1, y, surf, col) => surf.quadUp(
      [d.ax + d.ux * t0 + d.nx * c0, y, d.az + d.uz * t0 + d.nz * c0],
      [d.ax + d.ux * t1 + d.nx * c0, y, d.az + d.uz * t1 + d.nz * c0],
      [d.ax + d.ux * t1 + d.nx * c1, y, d.az + d.uz * t1 + d.nz * c1],
      [d.ax + d.ux * t0 + d.nx * c1, y, d.az + d.uz * t0 + d.nz * c1], col
    );

    const STEP = 3.2, TRANSIT = 3.4, CYCLE = 1.5;
    for (let t = 0; t + STEP < d.len; t += STEP) {
      const mx = d.ax + d.ux * (t + STEP / 2), mz = d.az + d.uz * (t + STEP / 2);
      if (onCrossRoad(mx, mz) || layout.isWater(mx, mz)) continue;
      for (const s of [-1, 1]) {
        strip(t, t + STEP, s * 0.35, s * (0.35 + TRANSIT), Y_TINT, busl, 1.0);
        strip(t, t + STEP, s * (0.35 + TRANSIT), s * (0.55 + TRANSIT), Y_MARK, white, 0.96);
        const c1 = d.half - 0.6, c0 = c1 - CYCLE;
        strip(t, t + STEP, s * c0, s * c1, Y_MARK - 0.002, flat, C_CYCLE);
        strip(t, t + STEP, s * (c0 - 0.22), s * c0, Y_MARK, white, 0.94);
      }
      stat.cycleM += STEP * 2;
    }

    // Centre line, dashed, following the bias — and broken at every crossing.
    const n = Math.floor(d.len / 12);
    for (let i = 0; i < n; i++) {
      const t0 = (i + 0.25) * 12, t1 = t0 + 5.5;
      const mx = d.ax + d.ux * (t0 + t1) / 2, mz = d.az + d.uz * (t0 + t1) / 2;
      if (onCrossRoad(mx, mz) || layout.isWater(mx, mz)) continue;
      strip(t0, t1, -0.15, 0.15, Y_MARK, white, 1.0);
    }

    // Glyphs, aligned to the cut rather than to the grid.
    const drot = Math.atan2(d.ux, d.uz);
    for (let t = 22; t < d.len - 22; t += 48) {
      for (const s of [-1, 1]) {
        const rot = s > 0 ? drot : drot + Math.PI;
        const co = s * (d.half - 1.35);
        const gx = d.ax + d.ux * t + d.nx * co, gz = d.az + d.uz * t + d.nz * co;
        if (onCrossRoad(gx, gz) || layout.isWater(gx, gz)) continue;
        bike(gx, gz, rot, 0.85);
        const dc = s * 2.05;
        diamond(d.ax + d.ux * t + d.nx * dc, d.az + d.uz * t + d.nz * dc, rot, 1.0);
      }
    }
  }

  /* ================================================== 3. lane marking === */

  /** One dashed run of paint along a road's free axis. */
  function dashRun(r, cross, a, b, w, dash, gap, surf, col) {
    for (let t = a; t < b - dash; t += dash + gap) {
      const c = col * fade(t, cross);
      if (r.axis === 'x') surf.rect(cross - w / 2, cross + w / 2, t, t + dash, Y_MARK, c);
      else surf.rect(t, t + dash, cross - w / 2, cross + w / 2, Y_MARK, c);
    }
  }
  function solidRun(r, cross, a, b, w, surf, col) {
    if (r.axis === 'x') surf.rect(cross - w / 2, cross + w / 2, a, b, Y_MARK, col);
    else surf.rect(a, b, cross - w / 2, cross + w / 2, Y_MARK, col);
  }

  /** Rectangle in road-local coords: [t0,t1] along the road, [o0,o1] across. */
  function bandRun(r, s, t0, t1, o0, o1, y, surf, col) {
    const l0 = r.pos + s * o0, l1 = r.pos + s * o1;
    const lo = Math.min(l0, l1), hi = Math.max(l0, l1);
    if (r.axis === 'x') surf.rect(lo, hi, t0, t1, y, col);
    else surf.rect(t0, t1, lo, hi, y, col);
  }

  /** Which way traffic runs on side `s`, and the paint rotation that matches. */
  function sideDir(r, s) {
    // Keep-right: RoadNetwork's rightSign for a direction is -s on an x-road
    // and +s on a z-road, so the traffic hugging side s runs the other way.
    const dir = r.axis === 'x' ? -s : s;
    return {
      dir,
      rot: r.axis === 'x' ? (dir > 0 ? 0 : Math.PI)
        : (dir > 0 ? Math.PI / 2 : -Math.PI / 2),
    };
  }

  const roadPt = (r, s, t, o) => (r.axis === 'x'
    ? [r.pos + s * o, t] : [t, r.pos + s * o]);

  /**
   * Kerbside parking programme for one side of one road.
   *
   * THE TICK GRID IS A CONTRACT. vehicles.js re-derives `lanePlan` and parks
   * every car centre on a half-tick of this exact 6.6 m rhythm, measured from
   * the same origin. Everything below decorates that grid — bay numbers,
   * accessible bays, loading zones, junction clearance — and none of it is
   * allowed to move it, or every parked car in Miami straddles a white line.
   */
  function parkingRun(r, P, s, a, b) {
    const bayLine = r.half - P.park;

    // vehicles.js refuses to park in anything under 2.1 m. Painting bays there
    // would be marking out spaces that stay empty for the whole match.
    if (P.park < 2.15) return;

    solidRun(r, r.pos + s * bayLine, a, b, 0.24, white, 0.90);

    const metered = h01(r.pos * 3.1, s * 7.7) < 0.45;
    const { rot } = sideDir(r, s);
    /* Kerb line, kept OFF the kerb. The gutter pan runs from 0.36 m out over
       the asphalt up to the kerb toe at 40 mm, and paint lives at Y_MARK =
       18 mm — so anything painted inside r.half - 0.36 is buried inside the
       pan and the toe, and no amount of polygon offset digs it out: that is a
       geometric 20 mm, not a depth-precision tie. */
    const kerbO = r.half - 0.52;
    let hold = 0;

    for (let t = Math.ceil(a / 6.6) * 6.6; t < b - 6.6; t += 6.6) {
      const bay = Math.round(t / 6.6);
      const h = h01(t * 0.37, r.pos + s * 13.3);
      let kind = 'bay';
      if (hold > 0) { hold--; kind = 'held'; }
      else if (t - a < 8.5 || b - (t + 6.6) < 8.5) kind = 'clear';
      else if (h < 0.055) kind = 'accessible';
      else if (h < 0.145) { kind = 'loading'; hold = 1; }

      // Bay tick: a stub off the bay line at every 6.6 m division.
      if (kind !== 'clear') {
        bandRun(r, s, t - 0.11, t + 0.11, bayLine,
          Math.min(r.half - 0.25, bayLine + 1.6), Y_MARK, white, 0.9 * fade(t, bayLine));
        stat.bays++;
      }

      if (kind === 'clear' || kind === 'loading' || kind === 'held') {
        // Yellow kerb line: no parking at a junction, restricted at a bay.
        bandRun(r, s, t, t + 6.6, kerbO - 0.15, kerbO + 0.15, Y_MARK, yellow,
          kind === 'clear' ? 0.88 : 1.0);
      }
      if (kind === 'loading') {
        // Bay brackets at each end of the zone — the pair is what says "this
        // stretch is a marked bay" rather than "someone painted a yellow line".
        for (const e of [t + 0.15, t + 13.05]) {
          bandRun(r, s, e - 0.13, e + 0.13, bayLine + 0.1, kerbO + 0.16, Y_MARK, yellow, 1.0);
        }
        stat.loading++;
      }
      if (kind === 'accessible') {
        bandRun(r, s, t + 0.45, t + 6.15, bayLine + 0.18, r.half - 0.44,
          Y_MARK - 0.002, flat, C_BAY_BLUE);
        const [gx, gz] = roadPt(r, s, t + 3.3, (bayLine + r.half) / 2);
        wheelchair(gx, gz, rot, Math.min(1.55, P.park * 0.62));
        stat.accessible++;
      } else if (metered && kind === 'bay' && (bay & 1) === 0) {
        // Bay number, painted in the 2 m gap the tick leaves between two cars.
        const [nx, nz] = roadPt(r, s, t, kerbO - 0.42);
        numerals(String(1 + (Math.abs(bay) % 88)), nx, nz, rot, 0.72, white, 0.86);
      }
    }
  }


  for (const r of [...layout.roadsX, ...layout.roadsZ]) {
    const P = lanePlan(r);
    const runs = paintRuns(r);
    for (const [a, b] of runs) {
      if (b - a < 3) continue;
      for (const s of [-1, 1]) {
        // Lane dividers inside one direction: white, dashed.
        for (let k = 1; k < P.lanes; k++) {
          dashRun(r, r.pos + s * (P.inner + k * LANE_W), a, b, 0.22, 3.0, 6.0, white, 1.0);
        }
        // Bus lane: solid white edge (the bed itself is laid separately so it
        // can run continuously through the crossing approach).
        if (P.bus) solidRun(r, r.pos + s * P.busEdge, a, b, 0.26, white, 1.0);
        // Kerbside parking: bays, accessible bays, loading zones, bay numbers
        // and the clearance at each junction — all hung off the same tick grid
        // vehicles.js parks on.
        parkingRun(r, P, s, a, b);

        /* Tyre polish. Two wear tracks per lane, broken into uneven lengths so
           they read as sheen on the asphalt rather than another painted line.
           Only ~5% brighter — any more and it becomes a marking. */
        for (let k = 0; k < P.lanes; k++) {
          const lc = P.inner + (k + 0.5) * LANE_W;
          for (const tr of [-0.86, 0.86]) {
            const c0 = lc + tr - 0.48, c1 = lc + tr + 0.48;
            let t = a;
            while (t < b - 6) {
              const len = 14 + fade(t, k) * 40;
              const end = Math.min(b, t + len);
              if (fade(t + 3, lc) > 0.87) {
                const g = 1.0 + (fade(t, lc + 5) - 0.82) * 0.34;
                const lo = r.pos + Math.min(s * c0, s * c1);
                const hi = r.pos + Math.max(s * c0, s * c1);
                if (r.axis === 'x') patch.rect(lo, hi, t, end, Y_PATCH, g);
                else patch.rect(t, end, lo, hi, Y_PATCH, g);
              }
              t = end + 3 + fade(t, 7) * 9;
            }
          }
        }
      }
      /* Painted speed limit in the kerbside lane. Deliberately rare — one per
         long boulevard run — because the value of a marking that is not a lane
         line is that you notice it. */
      if (r.cls === BOULEVARD && b - a > 110) {
        const s = h01(a, r.pos) < 0.5 ? -1 : 1;
        const { rot } = sideDir(r, s);
        const lane = P.inner + (P.lanes - 0.5) * LANE_W;
        const t = a + (b - a) * 0.38;
        const [sx, sz] = roadPt(r, s, t, lane);
        if (!layout.isWater(sx, sz)) numerals('35', sx, sz, rot, 1.85, white, 0.94);
      }

      // Centre line. A median already separates the directions, so a road with
      // one gets no paint down the middle.
      if (!r.median) {
        if (r.cls === STREET) {
          dashRun(r, r.pos, a, b, 0.20, 3.0, 5.0, yellow, 1.0);
        } else {
          solidRun(r, r.pos - 0.26, a, b, 0.20, yellow, 1.0);
          solidRun(r, r.pos + 0.26, a, b, 0.20, yellow, 1.0);
        }
      }
    }
  }

  /* --- utility trenches: a resurfaced band right across the carriageway --- */
  for (const r of [...layout.roadsX, ...layout.roadsZ]) {
    for (const [a, b] of tintRuns(r)) {
      for (let t = a + 20; t < b - 20; t += 95 + fade(t, r.pos) * 130) {
        const w = 1.3 + fade(t, 3) * 1.9;
        const tone = fade(t, 11) > 0.9 ? 1.09 : 0.91;
        if (r.axis === 'x') patch.rect(r.pos - r.half + 0.4, r.pos + r.half - 0.4, t, t + w, Y_PATCH, tone);
        else patch.rect(t, t + w, r.pos - r.half + 0.4, r.pos + r.half - 0.4, Y_PATCH, tone);
      }
    }
  }

  /* --- crack sealant ----------------------------------------------------- */

  const Y_SEAM = Y_PATCH + 0.003;

  /**
   * One run of sealant. A wandering polyline of quads, because the whole point
   * of the marking is that it is the only line on the road that is NOT
   * straight — everything else out here is paint or a paving joint, and a
   * carriageway with no crooked line on it reads as vinyl.
   */
  function seam(ax, az, dx, dz, len, wobble, seed, col) {
    const nx = -dz, nz = dx;
    const segs = Math.max(2, Math.round(len / 3.2));
    const hw = 0.045 + h01(seed, 7.3) * 0.05;
    let px = ax, pz = az;
    for (let i = 1; i <= segs; i++) {
      const t = (i / segs) * len;
      const o = (h01(seed + i * 2.31, i * 0.77) - 0.5) * wobble;
      const cx = ax + dx * t + nx * o, cz = az + dz * t + nz * o;
      tar.quadUp(
        [px + nx * hw, Y_SEAM, pz + nz * hw],
        [cx + nx * hw, Y_SEAM, cz + nz * hw],
        [cx - nx * hw, Y_SEAM, cz - nz * hw],
        [px - nx * hw, Y_SEAM, pz - nz * hw],
        col
      );
      px = cx; pz = cz;
    }
    stat.seams++;
  }

  /**
   * Asphalt cracks in two directions and both are here, because they mean
   * different things and a viewer reads the difference without knowing it:
   * TRANSVERSE cracks are thermal, spaced like the day's paving, and run the
   * width of the mat; LONGITUDINAL cracks open along the cold joint between
   * two adjacent laydowns — which is exactly where the lane lines are painted.
   */
  for (const r of [...layout.roadsX, ...layout.roadsZ]) {
    const P = lanePlan(r);
    const toWorld = (t, o) => (r.axis === 'x' ? [r.pos + o, t] : [t, r.pos + o]);
    const dAlong = r.axis === 'x' ? [0, 1] : [1, 0];
    const dAcross = r.axis === 'x' ? [1, 0] : [0, 1];
    for (const [a, b] of tintRuns(r)) {
      if (b - a < 14) continue;
      for (let t = a + 6; t < b - 6; t += 21 + h01(t, r.pos) * 52) {
        const oA = -r.half + h01(t, 2.2) * r.half * 0.55;
        const L = Math.min(r.half * (0.75 + h01(t, 4.4) * 1.15), r.half - oA - 0.3);
        if (L < 2) continue;
        const [sx, sz] = toWorld(t, oA);
        if (layout.isWater(sx, sz)) continue;
        seam(sx, sz, dAcross[0], dAcross[1], L, 0.5, t * 7.1 + r.pos,
          0.86 + h01(t, 1.1) * 0.3);
      }
      for (const s of [-1, 1]) {
        for (let k = 1; k <= P.lanes; k++) {
          const o = s * (P.inner + k * LANE_W);
          for (let t = a + 4; t < b - 16; t += 46 + h01(t, o) * 110) {
            if (h01(t * 3.1, o) > 0.5) continue;
            const L = Math.min(10 + h01(t, o + 3) * 30, b - t - 3);
            const [sx, sz] = toWorld(t, o + (h01(t, o + 9) - 0.5) * 0.5);
            if (layout.isWater(sx, sz)) continue;
            seam(sx, sz, dAlong[0], dAlong[1], L, 0.26, t * 3.7 + o,
              0.86 + h01(t, 2.6) * 0.3);
          }
        }
      }
    }
  }

  /* --- bus-lane beds, laid continuously between junction boxes ---------- */
  for (const r of [...layout.roadsX, ...layout.roadsZ]) {
    const P = lanePlan(r);
    if (!P.bus) continue;
    for (const [a, b] of tintRuns(r)) {
      if (b - a < 2) continue;
      for (const s of [-1, 1]) {
        const c0 = P.busEdge + 0.15, c1 = P.busEdge + LANE_W;
        const lo = r.pos + Math.min(s * c0, s * c1);
        const hi = r.pos + Math.max(s * c0, s * c1);
        if (r.axis === 'x') busl.rect(lo, hi, a, b, Y_TINT, 1.0);
        else busl.rect(a, b, lo, hi, Y_TINT, 1.0);

        /* The diamond is what turns a coloured strip into a bus lane. It is
           also the only lane marking in the vocabulary that survives being
           four pixels wide, because it is a blob and not a line. */
        const { rot } = sideDir(r, s);
        for (let t = a + 16; t < b - 12; t += 37) {
          const [dx, dz] = roadPt(r, s, t, (c0 + c1) / 2);
          diamond(dx, dz, rot, 1.0);
        }
      }
    }
  }

  /* ============================================ 4. junctions + zebras === */

  /**
   * Clear carriageway between this road's edge and the next parallel road's
   * edge, in direction `s`. Some of the grid gets down to a 20 m gap, and
   * without this two neighbouring junctions stamp overlapping zebras into the
   * same 20 m — coplanar, in the same mesh, guaranteed to z-fight.
   */
  function freeGap(list, idx, s) {
    const r = list[idx];
    let best = 1e4;
    for (let i = 0; i < list.length; i++) {
      if (i === idx) continue;
      const o = list[i];
      const d = s > 0 ? (o.pos - o.half) - (r.pos + r.half)
        : (r.pos - r.half) - (o.pos + o.half);
      if (d >= 0 && d < best) best = d;
    }
    return best;
  }
  const NEED_ZEBRA = CROSS_GAP + CROSS_W + 0.8;
  const NEED_STOP = CROSS_GAP + CROSS_W + STOP_SET + STOP_BAR + 0.4;

  for (const ix of net.intersections) {
    const rx = layout.roadsX[ix.ri];
    const rz = layout.roadsZ[ix.rj];
    const major = rx.cls !== STREET || rz.cls !== STREET;

    // Zebra on every approach of a signalled junction; a quiet street-on-street
    // crossroads gets two, which is what stops the city reading as a stencil.
    const sidesX = major ? [-1, 1] : [rng.sign()];
    const sidesZ = major ? [-1, 1] : [rng.sign()];

    // A minor road meeting a major one yields; it does not get a stop bar.
    // Two markings that mean different things is the point — a city where
    // every approach carries the identical white bar reads as a stencil.
    const holdLine = (r, cr, s, axis) => {
      if (r.cls === STREET && cr.cls !== STREET) giveWay(r, cr, s, axis);
      else stopBar(r, cr, s, axis);
    };

    for (const s of sidesX) {
      const gap = freeGap(layout.roadsZ, ix.rj, s);
      if (gap < NEED_ZEBRA) continue;
      // Crossing the N/S road, north or south of the box.
      const zc = rz.pos + s * (rz.half + CROSS_GAP + CROSS_W / 2);
      zebra(rx, zc, 'x');
      if (gap >= NEED_STOP) holdLine(rx, rz, s, 'x');
    }
    for (const s of sidesZ) {
      const gap = freeGap(layout.roadsX, ix.ri, s);
      if (gap < NEED_ZEBRA) continue;
      const xc = rx.pos + s * (rx.half + CROSS_GAP + CROSS_W / 2);
      zebra(rz, xc, 'z');
      if (gap >= NEED_STOP) holdLine(rz, rx, s, 'z');
    }

    /* Junction wear: real intersections are a patchwork of utility cuts and
       overlay, and the polish where every tyre in the city turns. Kept inside
       +-10% albedo so it reads as surface history, not dirt. */
    const jr = makeRNG((ix.id * 2654435761) >>> 0);
    for (let i = 0; i < 4; i++) {
      const w = ix.halfX * (0.28 + jr() * 0.58), d = ix.halfZ * (0.28 + jr() * 0.58);
      const cx = ix.x + (jr() - 0.5) * (ix.halfX * 2 - w);
      const cz = ix.z + (jr() - 0.5) * (ix.halfZ * 2 - d);
      patch.rect(cx - w / 2, cx + w / 2, cz - d / 2, cz + d / 2, Y_PATCH, 0.875 + jr() * 0.26);
    }
    // Oil shadow at the stop line. An octagon, because a rectangle of stain
    // announces itself as a decal.
    const orr = Math.min(ix.halfX, ix.halfZ) * 0.7;
    const oct = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.4;
      oct.push([ix.x + Math.cos(a) * orr * (0.8 + jr() * 0.4), ix.z + Math.sin(a) * orr * (0.8 + jr() * 0.4)]);
    }
    patch.polyY(oct, Y_PATCH + 0.001, 0.90);

    // A junction is the most cut, patched and resealed asphalt in any city.
    for (let i = 0; i < 2; i++) {
      const ang = jr() * Math.PI * 2;
      const L = Math.min(ix.halfX, ix.halfZ) * (0.9 + jr() * 1.1);
      const sx = ix.x + (jr() - 0.5) * ix.halfX;
      const sz = ix.z + (jr() - 0.5) * ix.halfZ;
      seam(sx, sz, Math.cos(ang), Math.sin(ang), L, 0.6, ix.id * 13.7 + i, 0.92);
    }

    // Keep-clear box: only where two boulevards meet, or it becomes wallpaper.
    const boxed = rx.cls === BOULEVARD && rz.cls === BOULEVARD;
    if (boxed) keepClear(ix);

    /* Lane extension guides. A big junction box is otherwise a bare grey field
       forty metres across — the single largest untouched surface in the game —
       and the dashes are what tell you which lane you come out in. Only on the
       major road through, or every crossroads turns into graph paper.
       NEVER inside a keep-clear box: the white and yellow marking meshes sit at
       the same y with the same polygon offset, so anywhere they cross is a
       guaranteed z-fight. Two markings that both mean "cross here carefully"
       is also one too many. */
    if (!boxed && (rx.cls === BOULEVARD || rz.cls === BOULEVARD)) {
      const major = rx.cls === BOULEVARD ? rx : rz;
      const P = lanePlan(major);
      const alongX = major.axis === 'x';
      const t0 = alongX ? ix.z - ix.halfZ : ix.x - ix.halfX;
      const t1 = alongX ? ix.z + ix.halfZ : ix.x + ix.halfX;
      for (const s of [-1, 1]) {
        for (let k = 1; k < P.lanes; k++) {
          const c = major.pos + s * (P.inner + k * LANE_W);
          for (let t = t0 + 0.8; t < t1 - 0.9; t += 1.7) {
            const e = Math.min(t + 0.62, t1 - 0.3);
            if (alongX) white.rect(c - 0.10, c + 0.10, t, e, Y_MARK, 0.70);
            else white.rect(t, e, c - 0.10, c + 0.10, Y_MARK, 0.70);
          }
        }
      }
    }

    // Ironwork clusters at the corners plus a manhole in the middle.
    manhole(ix.x + (jr() - 0.5) * ix.halfX, ix.z + (jr() - 0.5) * ix.halfZ, 0.62);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        gully(ix.x + sx * (ix.halfX - 0.5), ix.z + sz * (ix.halfZ + 2.2), sx > 0 ? 'x' : 'x');
        gully(ix.x + sx * (ix.halfX + 2.2), ix.z + sz * (ix.halfZ - 0.5), 'z');
      }
    }

    // Turn arrows in every approach lane.
    for (const s of [-1, 1]) {
      if (freeGap(layout.roadsZ, ix.rj, s) > NEED_STOP + 8) approachArrows(rx, rz, s, 'x');
      if (freeGap(layout.roadsX, ix.ri, s) > NEED_STOP + 8) approachArrows(rz, rx, s, 'z');
    }
  }

  /**
   * Zebra bars across a carriageway. `axis` = the axis the road runs on.
   *
   * Each bar is toned by how close it sits to a WHEEL TRACK. Tyres scrub paint
   * off in two ribbons per lane and nowhere else, so a crossing worn evenly
   * across its whole width is the tell that it was stamped rather than driven
   * over. The tracks here are the same +-0.86 m off each lane centre that the
   * asphalt polish pass uses, so the wear in the paint lines up with the sheen
   * in the road on either side of it.
   */
  function zebra(r, cross, axis) {
    const lo = r.pos - r.half, hi = r.pos + r.half;
    const P = lanePlan(r);
    const span = hi - lo - 1.4;
    const n = Math.max(3, Math.floor(span / BAR_PITCH));
    const start = (lo + hi) / 2 - (n - 1) * BAR_PITCH / 2;
    for (let i = 0; i < n; i++) {
      const p = start + i * BAR_PITCH;
      const off = Math.abs(p - r.pos);
      let d = 9;
      if (off > P.inner) {
        const k = Math.floor((off - P.inner) / LANE_W);
        const lc = P.inner + (k + 0.5) * LANE_W;
        d = Math.min(Math.abs(off - (lc - 0.86)), Math.abs(off - (lc + 0.86)));
      }
      const wear = 0.70 + 0.30 * Math.min(1, d / 0.62);
      const col = wear * fade(p, cross);
      if (axis === 'x') white.rect(p - BAR_W / 2, p + BAR_W / 2, cross - CROSS_W / 2, cross + CROSS_W / 2, Y_MARK, col);
      else white.rect(cross - CROSS_W / 2, cross + CROSS_W / 2, p - BAR_W / 2, p + BAR_W / 2, Y_MARK, col);
      stat.crossBars++;
    }
  }

  /**
   * Stop line across the lanes that are ACTUALLY approaching the box on this
   * side — never the full carriageway, which is the classic tell of painted-on
   * road markings.
   */
  function stopBar(r, cr, s, axis) {
    const P = lanePlan(r);
    const off = cr.half + CROSS_GAP + CROSS_W + STOP_SET;
    const c = cr.pos + s * off;
    // Traffic approaching from +s travels toward -s; keep-right puts it on the
    // side the RoadNetwork calls `rightSign` for dir = -s.
    const dir = -s;
    const rightSign = axis === 'x' ? (dir > 0 ? -1 : 1) : (dir > 0 ? 1 : -1);
    const a = r.pos + rightSign * (P.inner + 0.1);
    const b = r.pos + rightSign * (P.busEdge + (P.bus ? LANE_W : 0));
    const lo = Math.min(a, b), hi = Math.max(a, b);
    if (axis === 'x') white.rect(lo, hi, c - STOP_BAR / 2, c + STOP_BAR / 2, Y_MARK, 1.0);
    else white.rect(c - STOP_BAR / 2, c + STOP_BAR / 2, lo, hi, Y_MARK, 1.0);
  }

  /** Turn arrows, one per approach lane, set back from the stop line. */
  function approachArrows(r, cr, s, axis) {
    const P = lanePlan(r);
    const dir = -s;
    const rightSign = axis === 'x' ? (dir > 0 ? -1 : 1) : (dir > 0 ? 1 : -1);
    const base = cr.half + CROSS_GAP + CROSS_W + STOP_SET + STOP_BAR + 4.8;
    const c = cr.pos + s * base;
    for (let k = 0; k < P.lanes; k++) {
      const lat = P.inner + (k + 0.5) * LANE_W;
      const cx0 = r.pos + rightSign * lat;
      // k = 0 is the lane against the centreline/median, so that is the left
      // turn; the outermost lane is the kerb lane and turns right.
      let kind = 'ahead';
      if (P.lanes > 1 && k === 0) kind = 'left';
      else if (P.lanes > 1 && k === P.lanes - 1) kind = 'right';
      // Heading: the vehicle travels toward the junction, i.e. in -s.
      let rot;
      if (axis === 'x') rot = dir > 0 ? 0 : Math.PI;
      else rot = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
      const px = axis === 'x' ? cx0 : c;
      const pz = axis === 'x' ? c : cx0;
      if (layout.isWater(px, pz)) continue;
      arrow(px, pz, rot, kind);
      stat.arrows++;
    }
  }

  /**
   * Painted arrow, 4.4 m long — chunky, because a scale-accurate 15 cm stroke
   * is a sub-pixel shimmer from the game camera.
   * Local frame: +u is the direction of travel, +v is the driver's left.
   */
  function arrow(px, pz, rot, kind) {
    const cs = Math.cos(rot), sn = Math.sin(rot);
    const P = (u, v) => [px + v * cs + u * sn, pz + u * cs - v * sn];
    const poly = (pts) => white.polyY(pts.map(([u, v]) => P(u, v)), Y_MARK, 1.0);
    poly([[-2.2, -0.24], [1.0, -0.24], [1.0, 0.24], [-2.2, 0.24]]);   // shaft
    poly([[1.0, -0.72], [2.2, 0], [1.0, 0.72]]);                      // head
    if (kind !== 'ahead') {
      const sg = kind === 'left' ? 1 : -1;
      poly([[0.52, sg * 0.24], [1.0, sg * 0.24], [1.0, sg * 1.15], [0.52, sg * 1.15]]);
      poly([[0.24, sg * 1.15], [1.28, sg * 1.15], [0.76, sg * 2.05]]);
    }
  }

  /* ------------------------------------------------- painted glyphs ----- */

  /**
   * Local paint frame, shared with `arrow`: +u is the direction of travel,
   * +v is the driver's left. Author every glyph once in that frame and one
   * rotation puts it on any approach of any road.
   */
  function frame(px, pz, rot) {
    const cs = Math.cos(rot), sn = Math.sin(rot);
    return (u, v) => [px + v * cs + u * sn, pz + u * cs - v * sn];
  }

  /**
   * Painted numerals — bay numbers and speed markings.
   * `h` is cap height; the string is centred on (px,pz) and reads upright to a
   * driver travelling along `rot`.
   */
  function numerals(text, px, pz, rot, h, surf, col) {
    const t = h * 0.17;                  // stroke
    const w = h * 0.60;                  // glyph width
    const pitch = w + t * 1.5;
    const P = frame(px, pz, rot);
    const quad = (u0, u1, v0, v1) => surf.polyY(
      [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => P(u - h / 2, v)),
      Y_MARK, col
    );
    const iv = -w / 2, ov = w / 2;
    for (let i = 0; i < text.length; i++) {
      const segs = SEG7[text[i]];
      if (!segs) continue;
      // Read left-to-right means marching toward the driver's RIGHT, i.e. -v.
      const off = ((text.length - 1) / 2 - i) * pitch;
      const q = (u0, u1, v0, v1) => quad(u0, u1, v0 + off, v1 + off);
      const ix = iv + t * 0.55, ox = ov - t * 0.55;
      if (segs.includes('a')) q(h - t, h, ix, ox);
      if (segs.includes('g')) q(h / 2 - t / 2, h / 2 + t / 2, ix, ox);
      if (segs.includes('d')) q(0, t, ix, ox);
      if (segs.includes('f')) q(h / 2, h - t * 0.55, ov - t, ov);
      if (segs.includes('b')) q(h / 2, h - t * 0.55, iv, iv + t);
      if (segs.includes('e')) q(t * 0.55, h / 2, ov - t, ov);
      if (segs.includes('c')) q(t * 0.55, h / 2, iv, iv + t);
    }
  }

  /** Filled disc in a paint frame. */
  function pDisc(P, cu, cv, rad, n, surf, col) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      pts.push(P(cu + Math.cos(ang) * rad, cv + Math.sin(ang) * rad));
    }
    surf.polyY(pts, Y_MARK, col);
  }

  /** Annulus in a paint frame, emitted quad by quad so polyY stays convex. */
  function pRing(P, cu, cv, rad, th, n, surf, col) {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      const p = (ang, rr) => P(cu + Math.cos(ang) * rr, cv + Math.sin(ang) * rr);
      surf.polyY([p(a0, rad), p(a1, rad), p(a1, rad - th), p(a0, rad - th)], Y_MARK, col);
    }
  }

  /** Bar in a paint frame, given as two corners of an axis-aligned rectangle. */
  function pBar(P, u0, u1, v0, v1, surf, col) {
    surf.polyY([[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => P(u, v)),
      Y_MARK, col);
  }

  /** ISA accessible-bay symbol. Authored in a 2 x 2 m cell, then scaled. */
  function wheelchair(px, pz, rot, k) {
    const F = frame(px, pz, rot);
    const P = (u, v) => F(u * k, v * k);
    pRing(P, -0.32, -0.06, 0.66, 0.15, 14, white, 1.0);   // wheel
    pDisc(P, 0.78, 0.40, 0.21, 10, white, 1.0);           // head
    pBar(P, 0.10, 0.60, 0.24, 0.50, white, 1.0);          // back
    pBar(P, -0.04, 0.16, -0.52, 0.34, white, 1.0);        // seat
    pBar(P, -0.44, -0.20, -0.80, -0.48, white, 1.0);      // footplate
  }

  /** Cycle-lane bicycle. Two wheels, a frame triangle and a bar. */
  function bike(px, pz, rot, k) {
    const F = frame(px, pz, rot);
    const P = (u, v) => F(u * k, v * k);
    pRing(P, -0.78, 0, 0.44, 0.11, 12, white, 1.0);
    pRing(P, 0.78, 0, 0.44, 0.11, 12, white, 1.0);
    pBar(P, -0.70, 0.34, -0.07, 0.07, white, 1.0);        // down tube
    pBar(P, 0.10, 0.26, -0.07, 0.46, white, 1.0);         // seat stay
    pBar(P, 0.62, 0.78, -0.34, 0.34, white, 1.0);         // bars
    pBar(P, 0.26, 0.72, 0.30, 0.42, white, 1.0);          // top tube
  }

  /** HOV / bus-lane diamond. The one marking that reads at any distance. */
  function diamond(px, pz, rot, k) {
    const P = frame(px, pz, rot);
    white.polyY([P(1.15 * k, 0), P(0, 0.44 * k), P(-1.15 * k, 0), P(0, -0.44 * k)],
      Y_MARK, 1.0);
  }

  /**
   * Give-way teeth across the approach lanes of a minor road. Apex points at
   * the driver, which is the whole grammar of the marking.
   */
  function giveWay(r, cr, s, axis) {
    const P = lanePlan(r);
    const c = cr.pos + s * (cr.half + CROSS_GAP + CROSS_W + STOP_SET);
    const dir = -s;
    const rightSign = axis === 'x' ? (dir > 0 ? -1 : 1) : (dir > 0 ? 1 : -1);
    const a = r.pos + rightSign * (P.inner + 0.1);
    const b = r.pos + rightSign * (P.busEdge + (P.bus ? LANE_W : 0));
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const n = Math.max(2, Math.floor((hi - lo) / 0.92));
    const pitch = (hi - lo) / n;
    for (let i = 0; i < n; i++) {
      const p = lo + (i + 0.5) * pitch;
      const tri = axis === 'x'
        ? [[p - 0.27, c], [p + 0.27, c], [p, c + s * 0.66]]
        : [[c, p - 0.27], [c, p + 0.27], [c + s * 0.66, p]];
      white.polyY(tri, Y_MARK, 1.0);
    }
  }

  /** Yellow keep-clear hatch box inside a junction. */
  function keepClear(ix) {
    const x0 = ix.x - ix.halfX + 1.6, x1 = ix.x + ix.halfX - 1.6;
    const z0 = ix.z - ix.halfZ + 1.6, z1 = ix.z + ix.halfZ - 1.6;
    const w = 0.22;
    yellow.rect(x0, x1, z0, z0 + w, Y_MARK, 1.0);
    yellow.rect(x0, x1, z1 - w, z1, Y_MARK, 1.0);
    yellow.rect(x0, x0 + w, z0, z1, Y_MARK, 1.0);
    yellow.rect(x1 - w, x1, z0, z1, Y_MARK, 1.0);
    // 45-degree hatch: clip the line x - z = k against the box analytically.
    // Sparse and thin on purpose — a full-density box junction is correct in
    // London and a wall of yellow in a bright toy city.
    // Sparser and dimmer than the border. At 9 m pitch a 40 m box carries five
    // lines instead of nine, which is the difference between "hatched" and a
    // sheet of yellow filling a quarter of the frame.
    const kMin = x0 - z1, kMax = x1 - z0;
    for (let k = kMin; k < kMax; k += 9.0) {
      const ax = Math.max(x0, k + z0), az = ax - k;
      const bx = Math.min(x1, k + z1), bz = bx - k;
      if (bx - ax < 0.4) continue;
      const hw = 0.11;
      yellow.quadUp(
        [ax + hw, Y_MARK, az - hw], [bx + hw, Y_MARK, bz - hw],
        [bx - hw, Y_MARK, bz + hw], [ax - hw, Y_MARK, az + hw], 0.80
      );
    }
  }

  /* ============================================ 5. sidewalks + kerbs === */

  const nearRoadX = (x) => layout.roadsX.some((r) => Math.abs(x - r.pos) <= r.half + 0.8);
  const nearRoadZ = (z) => layout.roadsZ.some((r) => Math.abs(z - r.pos) <= r.half + 0.8);

  for (const b of layout.blocks) {
    const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2;
    const z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
    const sw = Math.max(2.4, Math.min(b.sidewalk, Math.min(b.w, b.d) / 2 - 1.2));
    b._swInset = sw;

    // Per-block paving tone. Real paving is laid in campaigns; a whole city at
    // one exact value is the flattest thing you can put on screen.
    const tone = 0.94 + ((b.seed % 97) / 97) * 0.11;

    /* THE PAVING CAMPAIGN.
       The paving map repeats every 4.8 m of world space, and there is no
       geometry trick that hides a 4.8 m repeat if every block runs it at the
       same value with the same joint rhythm. So each block gets its own:
       a kerb-slab band that is lighter or darker than its field, a different
       transverse joint pitch, and its own tactile-paving colour. Three
       independent choices over ~400 blocks is enough that the eye stops
       finding the period. */
    const bandTone = [0.90, 1.00, 1.11, 0.95, 1.06][b.seed % 5];
    const jointPitch = [4.5, 6.0, 7.5][(b.seed >> 3) % 3];
    const tactileCol = C_TACTILE[(b.seed >> 5) % C_TACTILE.length];
    const bs = makeRNG((b.seed ^ 0x9e37) >>> 0);

    // Interior slab (building pad / plaza floor). Kept a shade warmer than the
    // walking band so the frontage still reads as a footway from the air.
    walk.rect(x0 + sw, x1 - sw, z0 + sw, z1 - sw, Y_WALK, tone * 0.985);

    const edges = [
      { key: 'n', road: b.edges.n, len: b.w, corner0: [x0, z0], corner1: [x1, z0] },
      { key: 'e', road: b.edges.e, len: b.d, corner0: [x1, z0], corner1: [x1, z1] },
      { key: 's', road: b.edges.s, len: b.w, corner0: [x1, z1], corner1: [x0, z1] },
      { key: 'w', road: b.edges.w, len: b.d, corner0: [x0, z1], corner1: [x0, z0] },
    ];

    /** Everything the sweep pushes down. Nothing flat may be drawn over these. */
    const holesFor = [];

    for (const e of edges) {
      // Ramp windows: only where this edge meets a road AND the corner is a
      // real junction corner, which is exactly where the zebra lands.
      const stations = [{ s: 0, d: 0 }];
      const jc0 = nearRoadX(e.corner0[0]) && nearRoadZ(e.corner0[1]);
      const jc1 = nearRoadX(e.corner1[0]) && nearRoadZ(e.corner1[1]);
      const windows = [];
      if (e.road && jc0 && e.len > RAMP_B + 6) windows.push([RAMP_A, RAMP_B]);
      if (e.road && jc1 && e.len > RAMP_B + 6) windows.push([e.len - RAMP_B, e.len - RAMP_A]);
      for (const [a, c] of windows) {
        stations.push({ s: a - RAMP_FLARE, d: 0 }, { s: a, d: 1 }, { s: c, d: 1 }, { s: c + RAMP_FLARE, d: 0 });
        stat.ramps++;
      }

      /* VEHICLE CROSSOVERS. Every building on this frontage has to get its
         cars off the street somehow, and a kilometre of unbroken kerb is the
         reason a game street reads as extruded. A crossover is the same sweep
         trick as a kerb ramp — push the whole profile down over a window —
         which is why it costs almost nothing to have them. */
      const xo = [];
      if (e.road && e.len > RAMP_B * 2 + XOVER_MAX + 14) {
        const garage = b.zone === ZONE.PARKING;
        const n = garage ? 1 : (bs.chance(0.42) ? 1 : 0);
        for (let i = 0; i < n; i++) {
          const w = garage ? XOVER_MAX : bs.range(XOVER_MIN, XOVER_MAX);
          const lo2 = RAMP_B + 4.0, hi2 = e.len - RAMP_B - 4.0 - w;
          if (hi2 <= lo2) break;
          const s0 = bs.range(lo2, hi2);
          xo.push([s0, s0 + w]);
          stations.push(
            { s: s0 - XOVER_FLARE, d: 0 }, { s: s0, d: 1 },
            { s: s0 + w, d: 1 }, { s: s0 + w + XOVER_FLARE, d: 0 }
          );
          stat.xovers++;
        }
      }

      stations.push({ s: e.len, d: 0 });
      stations.sort((p, q) => p.s - q.s);

      sweepEdge(e, stations, sw, tone, bandTone, x0, x1, z0, z1);

      const holes = [];
      for (const [a, c] of windows) holes.push([a - RAMP_FLARE, c + RAMP_FLARE]);
      for (const [a, c] of xo) holes.push([a - XOVER_FLARE, c + XOVER_FLARE]);
      holesFor.push({ e, holes });
      const clear = (s0, s1) => !holes.some(([a, c]) => s1 > a && s0 < c);

      // Detectable warning surface at the head of every kerb ramp.
      for (const [a, c] of windows) tactilePad(e, a, c, tactileCol, x0, x1, z0, z1);
      // Driveway apron + the yellow across the dropped kerb.
      for (const [a, c] of xo) crossover(e, a, c, sw, x0, x1, z0, z1);

      /* A painted loading kerb where the frontage is busy enough to need one.
         This is the only place in the file that paints the kerb itself, and it
         has to be here rather than in the road pass: only the block knows where
         its own kerb line actually is. */
      if (e.road && b.streetLife > 0.45 && e.len > 34 && bs.chance(0.34)) {
        const len = bs.range(9, 14);
        const s0 = bs.range(RAMP_B + 3, Math.max(RAMP_B + 3.5, e.len - RAMP_B - 3 - len));
        if (clear(s0 - 0.4, s0 + len + 0.4)) {
          paintKerbRun(e, s0, s0 + len, false, x0, x1, z0, z1);
          stat.loading++;
        }
      }

      /* Expansion joints across the walking zone. The paving map already
         carries the 1.2 m slab joints; this is the coarser second rhythm, and
         having both is what stops a long frontage reading as one extruded
         ribbon. The pitch varies per block — one city-wide pitch is just a
         second repeat to count. They live in the marking mesh purely to reuse
         its polygon offset; the vertex colour turns the paint albedo into a
         recessed grey line. */
      if (e.road) {
        for (let s = jointPitch; s < e.len - 2.5; s += jointPitch) {
          if (!clear(s - 0.1, s + 0.1)) continue;    // never over a dropped kerb
          // Starts BEHIND the kerb, not on it: the kerb top back-slopes from
          // 0.202 down to Y_WALK between o = 0.30 and 0.46, so a joint pinned
          // to Y_WALK + 4 mm crosses that slope and is coplanar with it for a
          // few centimetres. Everything inside 0.46 is buried anyway.
          const p0 = edgePoint(e, s - 0.045, 0.50, x0, x1, z0, z1);
          const p1 = edgePoint(e, s + 0.045, 0.50, x0, x1, z0, z1);
          const p2 = edgePoint(e, s + 0.045, sw, x0, x1, z0, z1);
          const p3 = edgePoint(e, s - 0.045, sw, x0, x1, z0, z1);
          const jy = Y_WALK + 0.004;
          white.quadUp(
            [p0[0], jy, p0[1]], [p1[0], jy, p1[1]],
            [p2[0], jy, p2[1]], [p3[0], jy, p3[1]], 0.56 * tone
          );
        }

        /* Backfilled service cuts. Every real footway has them, and a dark
           irregular rectangle is worth more against a tiling texture than any
           amount of extra noise in the texture itself. */
        const nPatch = bs.int(0, 2);
        for (let i = 0; i < nPatch; i++) {
          const len = bs.range(1.2, 3.6);
          const s0 = bs.range(6.5, Math.max(7, e.len - len - 6.5));
          if (!clear(s0 - 0.3, s0 + len + 0.3)) continue;
          const oa = bs.range(0.7, Math.max(1.0, sw - 1.8));
          const ob = Math.min(sw - 0.25, oa + bs.range(0.8, 2.0));
          if (ob - oa < 0.5) continue;
          const p = (ss, oo) => edgePoint(e, ss, oo, x0, x1, z0, z1);
          const A = p(s0, oa), B = p(s0 + len, oa), C = p(s0 + len, ob), D = p(s0, ob);
          const py = Y_WALK + 0.004;
          patch.quadUp([A[0], py, A[1]], [B[0], py, B[1]],
            [C[0], py, C[1]], [D[0], py, D[1]], 0.88 + bs() * 0.30);
        }
      }
    }

    // Planting strip: a continuous green ribbon behind the kerb on the busy
    // frontages. nature.js drops its street palms at 2.2 m in, which lands
    // inside this band, so the two agree without either knowing about it.
    if (b.streetLife > 0.5 && sw > 4.2) {
      for (const { e, holes } of holesFor) {
        if (!e.road) continue;
        plantStrip(e, holes, x0, x1, z0, z1);
      }
    }

    // Kerbside drainage and service covers.
    const br = makeRNG((b.seed ^ 0x2f11) >>> 0);
    for (const e of edges) {
      if (!e.road) continue;
      const n = Math.max(1, Math.floor(e.len / 26));
      for (let i = 0; i < n; i++) {
        const s = (i + 0.5) * (e.len / n) + (br() - 0.5) * 5;
        const [gx, gz] = edgePoint(e, s, -0.2, x0, x1, z0, z1);
        gully(gx, gz, e.key === 'n' || e.key === 's' ? 'x' : 'z');
      }
      if (br.chance(0.55)) {
        const s = br.range(3, Math.max(3.5, e.len - 3));
        const [px, pz] = edgePoint(e, s, 1.1, x0, x1, z0, z1);
        serviceLid(px, pz, e.key === 'n' || e.key === 's');
      }
      /* Utility ironwork is never one kind of lid. Three sizes at three
         rhythms is what stops the footway reading as clean sheet material —
         and unlike a texture, they are the same objects at 4 m and at 40 m. */
      if (br.chance(0.42)) {
        const s = br.range(4, Math.max(4.5, e.len - 4));
        const [px, pz] = edgePoint(e, s, br.range(1.4, Math.max(1.6, sw - 0.8)), x0, x1, z0, z1);
        vaultLid(px, pz, br.range(0.72, 1.05), e.key === 'n' || e.key === 's');
      }
      const nv = br.int(1, 3);
      for (let i = 0; i < nv; i++) {
        const s = br.range(2.5, Math.max(3, e.len - 2.5));
        const [px, pz] = edgePoint(e, s, br.range(0.7, Math.max(0.9, sw - 0.5)), x0, x1, z0, z1);
        valveCap(px, pz, br.range(0.11, 0.17));
      }
    }
  }

  /** World point on a block edge at distance `s` from corner0, inset `o`. */
  function edgePoint(e, s, o, x0, x1, z0, z1) {
    switch (e.key) {
      case 'n': return [x0 + s, z0 + o];
      case 's': return [x1 - s, z1 - o];
      case 'e': return [x1 - o, z0 + s];
      default: return [x0 + o, z1 - s];
    }
  }

  /**
   * Sweep the kerb/sidewalk profile along one block edge.
   *
   * The corner stations move inward with the profile offset, which mitres the
   * four edges into each other exactly: no seam, no overlap, no corner cap.
   */
  function sweepEdge(e, stations, sw, tone, bandTone, x0, x1, z0, z1) {
    const N = PROFILE.length;
    const oAt = (i) => (i === N - 1 ? sw : PROFILE[i].o);
    const yAt = (i, d) => PROFILE[i].y + (PROFILE_DROP[i] - PROFILE[i].y) * d;

    const pt = (i, st) => {
      const o = oAt(i);
      // The mitre: corner stations move inward with the profile, and interior
      // stations are clamped into the same window so a wide sidewalk cannot
      // fold back on itself and invert a quad near a corner.
      const s = Math.min(Math.max(st.s, o), Math.max(o, e.len - o));
      const y = yAt(i, st.d);
      const [px, pz] = edgePoint(e, s, o, x0, x1, z0, z1);
      return [px, y, pz];
    };

    for (let i = 0; i < N - 1; i++) {
      const k = i === BAND_I ? bandTone : 1;
      const col0 = PROFILE[i].c * tone * k;
      const col1 = PROFILE[i + 1].c * tone * k;
      const col = (col0 + col1) * 0.5;
      for (let k = 0; k < stations.length - 1; k++) {
        const a = pt(i, stations[k]);
        const b = pt(i, stations[k + 1]);
        const c = pt(i + 1, stations[k + 1]);
        const d = pt(i + 1, stations[k]);
        walk.quadUp(a, b, c, d, col);
      }
    }
  }

  /** Grass ribbon behind the kerb, broken so people can reach the kerb. */
  function plantStrip(e, holes, x0, x1, z0, z1) {
    const IN0 = 1.55, IN1 = 3.05;
    const seg = 12.5, gapW = 2.6;
    for (let s = 3.5; s < e.len - 5.5; s += seg) {
      const a = s, c = Math.min(e.len - 3.5, s + seg - gapW);
      if (c - a < 3) continue;
      // A verge laid across a dropped kerb would float over the ramp and sit
      // in the middle of a driveway. Drop the whole segment instead.
      if (holes.some(([ha, hc]) => c > ha - 0.6 && a < hc + 0.6)) continue;
      const p0 = edgePoint(e, a, IN0, x0, x1, z0, z1);
      const p1 = edgePoint(e, c, IN0, x0, x1, z0, z1);
      const p2 = edgePoint(e, c, IN1, x0, x1, z0, z1);
      const p3 = edgePoint(e, a, IN1, x0, x1, z0, z1);
      const y = Y_WALK + 0.012;
      plant.quadUp(
        [p0[0], y, p0[1]], [p1[0], y, p1[1]], [p2[0], y, p2[1]], [p3[0], y, p3[1]], 1.0
      );
    }
  }

  /* ------------------------------------------- ramps, aprons, paint ----- */

  /** Height of the DROPPED profile at an arbitrary inset. */
  function dropY(o) {
    for (let i = 0; i < PROFILE.length - 2; i++) {
      const oa = PROFILE[i].o, ob = PROFILE[i + 1].o;
      if (o >= oa && o <= ob) {
        const t = ob - oa < 1e-6 ? 0 : (o - oa) / (ob - oa);
        return PROFILE_DROP[i] + (PROFILE_DROP[i + 1] - PROFILE_DROP[i]) * t;
      }
    }
    return Y_WALK;
  }

  /**
   * Detectable warning surface — the blistered pad at the head of a kerb ramp.
   *
   * Worth its triangles for two reasons beyond being correct: it is the only
   * saturated warm accent anywhere on the footway, and it lands at exactly the
   * point of every junction the camera is already looking at. The colour is
   * per-block, so a crossroads is never four identical corners.
   */
  function tactilePad(e, a, c, col, x0, x1, z0, z1) {
    const IN0 = 0.52, MID = 1.10, IN1 = 1.42;
    // Clamp into the same mitre window the sweep uses, or the pad overruns the
    // corner and pokes out of the perpendicular frontage.
    const s0 = Math.max(a, IN1), s1 = Math.min(c, e.len - IN1);
    if (s1 - s0 < 0.6) return;
    const p = (ss, oo) => edgePoint(e, ss, oo, x0, x1, z0, z1);
    for (const [oa, ob] of [[IN0, MID], [MID, IN1]]) {
      const ya = dropY(oa) + 0.006, yb = dropY(ob) + 0.006;
      const A = p(s0, oa), B = p(s1, oa), C = p(s1, ob), D = p(s0, ob);
      flat.quadUp([A[0], ya, A[1]], [B[0], ya, B[1]],
        [C[0], yb, C[1]], [D[0], yb, D[1]], col);
    }
    const dot = [col[0] * 0.62, col[1] * 0.62, col[2] * 0.62];
    const n = Math.max(3, Math.floor((s1 - s0) / 0.31));
    const pitch = (s1 - s0) / n;
    for (let i = 0; i < n; i++) {
      const ss = s0 + (i + 0.5) * pitch;
      for (let k = 0; k < 3; k++) {
        const oo = IN0 + 0.19 + k * 0.29;
        const y = dropY(oo) + 0.011;
        const A = p(ss - 0.065, oo - 0.065), B = p(ss + 0.065, oo - 0.065);
        const C = p(ss + 0.065, oo + 0.065), D = p(ss - 0.065, oo + 0.065);
        flat.quadUp([A[0], y, A[1]], [B[0], y, B[1]],
          [C[0], y, C[1]], [D[0], y, D[1]], dot);
      }
    }
  }

  /**
   * Yellow paint over the kerb face, nose and top — a loading kerb, or the
   * across-the-drop marking at a crossover. Follows the real profile stations
   * so it wraps the kerb instead of hovering over it as a flat ribbon.
   */
  function paintKerbRun(e, s0, s1, dropped, x0, x1, z0, z1) {
    const STN = [3, 4, 5, 6];
    const yOf = (i) => (dropped ? PROFILE_DROP[i] : PROFILE[i].y) + 0.005;
    const p = (ss, oo) => edgePoint(e, ss, oo, x0, x1, z0, z1);
    const a = Math.max(s0, 0.5), c = Math.min(s1, e.len - 0.5);
    if (c - a < 0.5) return;
    for (let k = 0; k < STN.length - 1; k++) {
      const i = STN[k], j = STN[k + 1];
      const oa = PROFILE[i].o - 0.005, ob = PROFILE[j].o + 0.005;
      const A = p(a, oa), B = p(c, oa), C = p(c, ob), D = p(a, ob);
      flat.quadUp([A[0], yOf(i), A[1]], [B[0], yOf(i), B[1]],
        [C[0], yOf(j), C[1]], [D[0], yOf(j), D[1]], C_KERB_PAINT);
    }
  }

  /** Driveway apron across the footway, plus its saw-cut joints. */
  function crossover(e, a, c, sw, x0, x1, z0, z1) {
    const o0 = 1.90, o1 = Math.max(o0 + 0.7, sw);
    const y = Y_WALK + 0.005;
    const p = (ss, oo) => edgePoint(e, ss, oo, x0, x1, z0, z1);
    const A = p(a, o0), B = p(c, o0), C = p(c, o1), D = p(a, o1);
    flat.quadUp([A[0], y, A[1]], [B[0], y, B[1]],
      [C[0], y, C[1]], [D[0], y, D[1]], C_APRON);
    for (const f of [1 / 3, 2 / 3]) {
      const ss = a + (c - a) * f;
      const j0 = p(ss - 0.04, o0), j1 = p(ss + 0.04, o0);
      const j2 = p(ss + 0.04, o1), j3 = p(ss - 0.04, o1);
      const jy = y + 0.003;
      white.quadUp([j0[0], jy, j0[1]], [j1[0], jy, j1[1]],
        [j2[0], jy, j2[1]], [j3[0], jy, j3[1]], 0.44);
    }
    // Strictly inside the FULLY dropped window: over the flares the sweep is
    // still part-way down, and paint pinned to the dropped profile there ends
    // up 5 cm inside a kerb that has not finished falling yet.
    paintKerbRun(e, a, c, true, x0, x1, z0, z1);

    // Trench drain across the throat, which is where the water actually goes.
    // Kept narrow and lifted 16 mm: the ramp still falls 63 mm per metre here,
    // so a wide flat lid would bury one of its own edges.
    const td = p((a + c) / 2, 1.62);
    const along = e.key === 'n' || e.key === 's';
    const hw = Math.min(2.2, (c - a) * 0.4);
    const ty = dropY(1.62) + 0.016;
    if (along) iron.rect(td[0] - hw, td[0] + hw, td[1] - 0.09, td[1] + 0.09, ty, 0.55);
    else iron.rect(td[0] - 0.09, td[0] + 0.09, td[1] - hw, td[1] + hw, ty, 0.55);

    /* Claim the driveway. streets.js runs before every other content module,
       so this is the one chance to stop props.js standing a bench, or
       nature.js a palm, in the middle of a vehicle crossing. */
    const mid = p((a + c) / 2, (o0 + o1) / 2);
    ctx.occupy(mid[0], mid[1], Math.max(2.4, (c - a) * 0.45));
    // Also claim the gutter in front of it, so nothing is stood in the throat.
    const throat = p((a + c) / 2, -0.2);
    ctx.occupy(throat[0], throat[1], Math.max(2.0, (c - a) * 0.4));
  }

  /* ================================================== 6. the medians === */

  for (const r of layout.medians) {
    const hw = r.medianW * 0.5;
    let runs = dryRuns(layout, r, r.axis === 'x' ? -S - 30 : -S - 30, r.axis === 'x' ? S + 30 : BAY);
    // Pulled back past the zebra corridor (junction edge + CROSS_GAP + CROSS_W)
    // so a raised kerb never lands in the middle of a crossing.
    const NOSE = CROSS_GAP + CROSS_W + 1.6;
    for (const [a, b] of (r.axis === 'x' ? junctionSpansX : junctionSpansZ)) {
      runs = cut(runs, a - NOSE, b + NOSE);
    }
    runs = cutBridges(r, runs);             // the deck carries its own paint
    for (const [a, b] of runs) {
      // Below ~18 m a median with two 3 m noses is a green lozenge marooned in
      // the middle of the road, not a median. Leave those stretches open.
      if (b - a < 18) continue;
      medianRun(r, hw, a, b);
      medianNose(r, hw, a, -1);
      medianNose(r, hw, b, 1);
      stat.medianM += b - a;
    }
  }

  /**
   * Painted median nose. Where the raised island stops short of a junction the
   * carriageway is not simply left blank — the taper is hatched out, and that
   * chevron is what tells you at a glance which side of the island you take.
   */
  function medianNose(r, hw, t, dir) {
    const L = 5.4;
    const at = (u, c) => (r.axis === 'x' ? [r.pos + c, Y_MARK, t + dir * u] : [t + dir * u, Y_MARK, r.pos + c]);
    const W = 0.20;
    // Outline: two converging lines from the nose tip to the island edge.
    for (const s of [-1, 1]) {
      const A = at(0, s * 0.35), B = at(L, s * (hw - 0.1));
      const A2 = at(0, s * 0.35 + W * s), B2 = at(L, s * (hw - 0.1) + W * s);
      yellow.quadUp(A, B, B2, A2, 1.0);
    }
    // Chevrons inside the taper.
    for (let i = 1; i <= 3; i++) {
      const u = (i / 4) * L;
      const c = 0.35 + (hw - 0.45) * (u / L);
      const A = at(u, -c), B = at(u + 0.9, 0), C = at(u + 0.9 + W * 1.4, 0), D = at(u + W * 1.4, -c);
      yellow.quadUp(A, B, C, D, 1.0);
      const E = at(u, c), F = at(u + 0.9, 0), G = at(u + 0.9 + W * 1.4, 0), H = at(u + W * 1.4, c);
      yellow.quadUp(E, F, G, H, 1.0);
    }
  }

  /**
   * A raised planted median: kerb ring, soil, grass, and a low hedge spine.
   * Palms are nature.js's business — the surface and the kerb are ours.
   */
  function medianRun(r, hw, a, b) {
    const M = [
      { o: -0.26, y: 0.014, c: 0.86 },
      { o: -0.05, y: 0.034, c: 0.92 },
      { o: 0.02, y: 0.150, c: 0.84 },
      { o: 0.09, y: 0.172, c: 1.12 },
      { o: 0.20, y: 0.164, c: 1.00 },
      { o: 0.55, y: 0.140, c: 0.95 },
    ];
    const along = (t, o, s) => (r.axis === 'x'
      ? [r.pos + s * (hw - o), 0, t]
      : [t, 0, r.pos + s * (hw - o)]);
    // Nose taper: the last 3 m at each end pull in so the median ends in a
    // wedge instead of a guillotined block.
    const inset = (t) => {
      const d = Math.min(t - a, b - t);
      return d < 3 ? (1 - d / 3) * hw * 0.85 : 0;
    };
    const ts = [a, a + 1.0, a + 3.0];
    for (let t = a + 8; t < b - 8; t += 8) ts.push(t);
    ts.push(b - 3.0, b - 1.0, b);

    for (const s of [-1, 1]) {
      for (let i = 0; i < M.length - 1; i++) {
        const col = (M[i].c + M[i + 1].c) * 0.5;
        for (let k = 0; k < ts.length - 1; k++) {
          const t0 = ts[k], t1 = ts[k + 1];
          const A = along(t0, M[i].o + inset(t0), s); A[1] = M[i].y;
          const B = along(t1, M[i].o + inset(t1), s); B[1] = M[i].y;
          const C = along(t1, M[i + 1].o + inset(t1), s); C[1] = M[i + 1].y;
          const D = along(t0, M[i + 1].o + inset(t0), s); D[1] = M[i + 1].y;
          walk.quadUp(A, B, C, D, col);
        }
      }
    }
    // Soil / grass between the two kerb rings.
    for (let k = 0; k < ts.length - 1; k++) {
      const t0 = ts[k], t1 = ts[k + 1];
      const w0 = hw - 0.55 - inset(t0), w1 = hw - 0.55 - inset(t1);
      if (w0 < 0.2 || w1 < 0.2) continue;
      const A = along(t0, 0.55 + inset(t0), -1); A[1] = 0.142;
      const B = along(t1, 0.55 + inset(t1), -1); B[1] = 0.142;
      const C = along(t1, 0.55 + inset(t1), 1); C[1] = 0.142;
      const D = along(t0, 0.55 + inset(t0), 1); D[1] = 0.142;
      plant.quadUp(A, B, C, D, 1.0);
    }
    // Hedge spine. Two stacked boxes give it a chamfered shoulder, so the top
    // catches the sun instead of ending in a razor edge.
    const hh = 0.86, hwid = Math.min(1.15, hw - 1.1);
    if (hwid > 0.3) {
      for (let k = 0; k < ts.length - 1; k++) {
        const t0 = ts[k], t1 = ts[k + 1];
        if (inset(t0) > 0.05 || inset(t1) > 0.05) continue;
        const inner = hwid * 0.62;
        if (r.axis === 'x') {
          hedge.box(r.pos - hwid, r.pos + hwid, 0.13, 0.13 + hh * 0.72, t0, t1, 0.84, 1.0);
          hedge.box(r.pos - inner, r.pos + inner, 0.13 + hh * 0.72, 0.13 + hh, t0 + 0.2, t1 - 0.2, 0.94, 1.16);
        } else {
          hedge.box(t0, t1, 0.13, 0.13 + hh * 0.72, r.pos - hwid, r.pos + hwid, 0.84, 1.0);
          hedge.box(t0 + 0.2, t1 - 0.2, 0.13 + hh * 0.72, 0.13 + hh, r.pos - inner, r.pos + inner, 0.94, 1.16);
        }
      }
    }
  }

  /* ==================================================== 7. ironwork === */

  function manhole(x, z, r) {
    const n = 10;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push([x + Math.cos(a) * r, z + Math.sin(a) * r]);
    }
    iron.polyY(pts, Y_IRON, 1.0);
    // Rim, a shade darker, so the lid reads as a disc set into the road.
    const pts2 = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts2.push([x + Math.cos(a) * (r * 0.72), z + Math.sin(a) * (r * 0.72)]);
    }
    iron.polyY(pts2, Y_IRON + 0.002, 0.84);
    stat.manholes++;
  }

  function gully(x, z, axis) {
    const w = axis === 'x' ? 0.72 : 0.38;
    const d = axis === 'x' ? 0.38 : 0.72;
    iron.rect(x - w / 2, x + w / 2, z - d / 2, z + d / 2, Y_IRON, 0.68);
    // three grate bars
    for (let i = -1; i <= 1; i++) {
      if (axis === 'x') iron.rect(x - w / 2 + 0.06, x + w / 2 - 0.06, z + i * 0.1 - 0.025, z + i * 0.1 + 0.025, Y_IRON + 0.002, 0.42);
      else iron.rect(x + i * 0.1 - 0.025, x + i * 0.1 + 0.025, z - d / 2 + 0.06, z + d / 2 - 0.06, Y_IRON + 0.002, 0.42);
    }
  }

  function serviceLid(x, z, alongX) {
    const w = alongX ? 0.92 : 0.58;
    const d = alongX ? 0.58 : 0.92;
    iron.rect(x - w / 2, x + w / 2, z - d / 2, z + d / 2, Y_WALK + 0.006, 0.78);
    iron.rect(x - w / 2 + 0.08, x + w / 2 - 0.08, z - d / 2 + 0.08, z + d / 2 - 0.08, Y_WALK + 0.008, 0.90);
  }

  /** Square draw-pit lid with a cast rib across it — telecoms, power. */
  function vaultLid(x, z, r, alongX) {
    const w = alongX ? r : r * 0.78;
    const d = alongX ? r * 0.78 : r;
    iron.rect(x - w, x + w, z - d, z + d, Y_WALK + 0.006, 0.72);
    iron.rect(x - w + 0.07, x + w - 0.07, z - d + 0.07, z + d - 0.07, Y_WALK + 0.008, 0.86);
    if (alongX) iron.rect(x - w + 0.07, x + w - 0.07, z - 0.03, z + 0.03, Y_WALK + 0.010, 0.62);
    else iron.rect(x - 0.03, x + 0.03, z - d + 0.07, z + d - 0.07, Y_WALK + 0.010, 0.62);
  }

  /** Small round stop-tap / gas cap. Cheap, and there are thousands in a city. */
  function valveCap(x, z, r) {
    const pts = [];
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      pts.push([x + Math.cos(a) * r, z + Math.sin(a) * r]);
    }
    iron.polyY(pts, Y_WALK + 0.006, 0.66);
  }

  /* ===================================================== 8. bridges === */

  for (const s of bridgeSpans) {
    buildBridge(s);
    stat.bridges++;
  }

  /**
   * A river crossing: a raised deck on an approach ramp at each end, a deep
   * fascia beam, pilastered parapets and lighting standards.
   *
   * Piers are deliberately NOT built here — water.js already stands two pier
   * walls with cutwaters under every entry in layout.bridges, and a second set
   * in the same water would be duplicate geometry fighting itself.
   *
   * Balusters are also out: a 60 mm baluster is razor-thin geometry the art
   * bible forbids, and from a 40-degree camera it aliases into grey fuzz. A
   * solid parapet with chunky pilasters reads far better at this scale.
   */
  function buildBridge(sp) {
    const { br, alongZ, lo, hi, rampLo, rampHi, cross, halfW } = sp;
    const t0 = lo - rampLo, t1 = hi + rampHi;
    if (t1 - t0 < 6) return;

    /** Deck height along the bridge — must match vehicles.js deckHeight(). */
    const yAt = (t) => {
      const a = rampLo > 0 ? (t - t0) / rampLo : 99;
      const b = rampHi > 0 ? (t1 - t) / rampHi : 99;
      return DECK_Y * Math.max(0, Math.min(1, a, b));
    };

    // Station list: dense at the ramps where the height changes, coarse across
    // the span where it does not.
    const ts = [];
    const push = (v) => { if (!ts.length || v - ts[ts.length - 1] > 0.05) ts.push(v); };
    if (rampLo > 0) for (let i = 0; i <= 4; i++) push(t0 + (rampLo * i) / 4);
    else push(t0);
    for (let t = lo + 6; t < hi - 3; t += 7) push(t);
    push(hi);
    if (rampHi > 0) for (let i = 1; i <= 4; i++) push(hi + (rampHi * i) / 4);

    const P = (t, c, y) => (alongZ ? [cross + c, y, t] : [t, y, cross + c]);
    const SOFFIT = 0.30;                 // just clear of water.js's surface
    const PAR_H = 1.05;

    for (let k = 0; k < ts.length - 1; k++) {
      const a = ts[k], b = ts[k + 1];
      const ya = yAt(a), yb = yAt(b);

      // Running surface, in the carriageway mesh so it shares the asphalt.
      road.quadUp(P(a, -halfW, ya), P(a, halfW, ya), P(b, halfW, yb), P(b, -halfW, yb), 1.0);

      // Fascia beams and the soffit, only where the deck is actually raised.
      if (ya > SOFFIT + 0.2 || yb > SOFFIT + 0.2) {
        const sa = Math.min(SOFFIT, ya - 0.2), sb = Math.min(SOFFIT, yb - 0.2);
        for (const s of [-1, 1]) {
          const A = P(a, s * halfW, yAt(a)), B = P(a, s * halfW, sa);
          const C = P(b, s * halfW, sb), D = P(b, s * halfW, yAt(b));
          if (s > 0) struct.quad(A, B, C, D, 0.94, true);
          else struct.quad(D, C, B, A, 0.94, true);
        }
        struct.quad(P(a, halfW, sa), P(a, -halfW, sa), P(b, -halfW, sb), P(b, halfW, sb), 0.70);
      } else {
        // Ramp foot: a low embankment wall down to the ground.
        for (const s of [-1, 1]) {
          const A = P(a, s * halfW, ya), B = P(a, s * halfW, Y_BASE);
          const C = P(b, s * halfW, Y_BASE), D = P(b, s * halfW, yb);
          if (s > 0) struct.quad(A, B, C, D, 0.94, true);
          else struct.quad(D, C, B, A, 0.94, true);
        }
      }

      // Parapet wall, riding the deck.
      for (const s of [-1, 1]) {
        const c0 = s * halfW, c1 = s * (halfW - 0.46);
        const lo2 = Math.min(c0, c1), hi2 = Math.max(c0, c1);
        if (alongZ) struct.box(cross + lo2, cross + hi2, Math.min(ya, yb), Math.max(ya, yb) + PAR_H, a, b, 0.96, 1.10);
        else struct.box(a, b, Math.min(ya, yb), Math.max(ya, yb) + PAR_H, cross + lo2, cross + hi2, 0.96, 1.10);
      }

      /* Deck paint. Painted here rather than by the marking pass because the
         deck is 1.2 m up and the marking pass works at y = 0.018. */
      const my = (ya + yb) / 2 + 0.02;
      const mid = (a + b) / 2;
      if (b - a > 1.2) {
        for (const s of [-1, 1]) {
          const c = s * 0.26;
          if (alongZ) yellow.rect(cross + Math.min(c, c + 0.2), cross + Math.max(c, c + 0.2), a, b, my, 1.0);
          else yellow.rect(a, b, cross + Math.min(c, c + 0.2), cross + Math.max(c, c + 0.2), my, 1.0);
        }
      }
      if (fade(mid, cross) > 0.9) {
        for (const s of [-1, 1]) {
          for (let k2 = 1; k2 <= 2; k2++) {
            const c = s * k2 * LANE_W;
            if (Math.abs(c) > halfW - 2) continue;
            if (alongZ) white.rect(cross + c - 0.11, cross + c + 0.11, a, b, my, 0.95);
            else white.rect(a, b, cross + c - 0.11, cross + c + 0.11, my, 0.95);
          }
        }
      }
    }

    // Pilasters and lighting standards, spaced along the raised span only.
    const np = Math.max(2, Math.round((hi - lo) / 11));
    for (let i = 0; i <= np; i++) {
      const t = lo + ((hi - lo) * i) / np;
      const y = yAt(t);
      for (const s of [-1, 1]) {
        const c0 = s * (halfW + 0.16), c1 = s * (halfW - 0.60);
        const clo = Math.min(c0, c1), chi = Math.max(c0, c1);
        if (alongZ) struct.box(cross + clo, cross + chi, y, y + PAR_H + 0.34, t - 0.44, t + 0.44, 1.0, 1.16);
        else struct.box(t - 0.44, t + 0.44, y, y + PAR_H + 0.34, cross + clo, cross + chi, 1.0, 1.16);
      }
    }
    const lamps = Math.max(2, Math.round((hi - lo) / 24));
    for (let i = 0; i < lamps; i++) {
      const t = lo + ((hi - lo) * (i + 0.5)) / lamps;
      const y = yAt(t) + PAR_H;
      for (const s of [-1, 1]) {
        const c = s * (halfW - 0.26);
        const lx = alongZ ? cross + c : t;
        const lz = alongZ ? t : cross + c;
        lampPole.box(lx - 0.12, lx + 0.12, y, y + 4.6, lz - 0.12, lz + 0.12, 0.9, 1.0);
        lampGlow.box(lx - 0.36, lx + 0.36, y + 4.6, y + 4.94, lz - 0.28, lz + 0.28, 1.0, 1.0);
      }
    }
  }

  /* ================================================== 9. materials === */

  const asphaltMap = Textures.asphalt();
  const asphaltNormal = asphaltMap.userData.companions
    ? asphaltMap.userData.companions.normalMap : null;

  /**
   * NAMED ON PURPOSE. `ground()` caches by its whole parameter object, so two
   * modules that happen to ask for the same asphalt get the SAME material
   * instance. The night driver below mutates roughness and emissive on these,
   * and a shared instance would drag someone else's surface along with it. The
   * name costs nothing and makes the cache key ours alone.
   */
  const matLand = layer({
    map: Textures.paving(512, PALETTE.GRAVEL, 'rgba(118,110,94,0.42)', 3),
    roughness: 1.0, name: 'streets-land',
  }, 0);
  const matRoad = layer({ map: asphaltMap, roughness: 1.0, name: 'streets-road' }, 1);
  const matPatch = layer({
    map: asphaltMap, roughness: 1.0, vertexColors: true, name: 'streets-wear',
  }, 2);

  const landMesh = addMesh(group, land, matLand, 'ground-base');

  addMesh(group, bed, ground({
    color: PALETTE.SEA_MID, roughness: 0.6, metalness: 0.0,
  }), 'water-bed', false);

  addMesh(group, road, matRoad, 'roads');

  addMesh(group, alley, layer({
    map: Textures.paving(512, PALETTE.CONCRETE_DARK, 'rgba(104,94,80,0.62)', 2),
    roughness: 1.0,
  }, 0.5), 'alleys');

  addMesh(group, patch, matPatch, 'road-wear');

  // Crack sealant. Glossier and darker than anything else on the carriageway:
  // bitumen is the one part of a road surface that is genuinely shiny, and
  // that specular is most of what makes the line read as tar and not as a
  // pencil stroke.
  const matTar = layer({
    color: PALETTE.TAR_SEAM, roughness: 0.52, metalness: 0.04,
    vertexColors: true, name: 'streets-tar',
  }, 3.6);
  addMesh(group, tar, matTar, 'road-cracks');

  // Bus-lane paint: PALETTE.TERRACOTTA mixed most of the way back into the
  // asphalt, so it reads as a tinted lane rather than a red carpet. Flat albedo
  // (paint IS flat) with the road's own normal map so the relief carries
  // straight through and the lane still looks like tarmac.
  const busColor = new THREE.Color(PALETTE.ASPHALT)
    .lerp(new THREE.Color(PALETTE.TERRACOTTA), 0.34);
  const matBus = layer({
    color: busColor,
    normalMap: asphaltNormal,
    normalScale: new THREE.Vector2(0.8, 0.8),
    roughnessMap: Textures.roughness(256, 196, 0.20),
    roughness: 1.0, name: 'streets-buslane',
  }, 3);
  addMesh(group, busl, matBus, 'bus-lanes');

  // Paint receives shadow: a zebra that stays bright white inside a tower's
  // shadow is the loudest possible "these are decals" tell.
  const matWhite = layer({
    color: PALETTE.ROAD_LINE, roughness: 0.88, vertexColors: true,
    name: 'streets-white',
  }, 5);
  addMesh(group, white, matWhite, 'markings-white');

  const matYellow = layer({
    color: PALETTE.ROAD_LINE_YELLOW, roughness: 0.88, vertexColors: true,
    name: 'streets-yellow',
  }, 5);
  addMesh(group, yellow, matYellow, 'markings-yellow');

  /* Coloured paint: accessible bays, cycle beds, tactile pads, driveway
     aprons. White base colour so the vertex attribute IS the albedo. */
  addMesh(group, flat, layer({
    color: 0xffffff, roughness: 0.87, vertexColors: true, name: 'streets-colour',
  }, 4), 'markings-colour');

  addMesh(group, walk, layer({
    map: Textures.paving(512, PALETTE.SIDEWALK, 'rgba(150,142,126,0.5)', 4),
    roughness: 0.94, vertexColors: true,
  }, 1), 'sidewalks');

  addMesh(group, plant, layer({
    map: Textures.grass(), roughness: 0.95,
  }, 2), 'planting');

  addMesh(group, iron, layer({
    color: PALETTE.ROOF_TAR, roughness: 0.62, metalness: 0.25, vertexColors: true,
  }, 7), 'road-ironwork');

  const hedgeMesh = addMesh(group, hedge, solid({
    color: PALETTE.HEDGE, roughness: 0.9, vertexColors: true,
  }), 'median-hedge');
  if (hedgeMesh) hedgeMesh.castShadow = true;

  const structMesh = addMesh(group, struct, ground({
    map: Textures.concrete(512, PALETTE.PRECAST), roughness: 0.92, vertexColors: true,
  }), 'bridges-bulkheads');
  if (structMesh) structMesh.castShadow = true;

  const poleMesh = addMesh(group, lampPole, solid({
    color: PALETTE.LAMP_POST, roughness: 0.5, metalness: 0.4, vertexColors: true,
  }), 'bridge-lamps');
  if (poleMesh) poleMesh.castShadow = true;

  let matGlow = null;
  if (!lampGlow.empty) {
    matGlow = new THREE.MeshBasicMaterial({
      color: new THREE.Color(PALETTE.LAMP_GLOW), toneMapped: false, vertexColors: true,
    });
    const gm = new THREE.Mesh(lampGlow.build(), matGlow);
    gm.name = 'bridge-lamp-glow';
    gm.matrixAutoUpdate = false;
    group.add(gm);
  }

  /* ================================================= 10. day / night === */

  /**
   * The cycle belongs to engine.js. All this reads is the published
   * `nightFactor`, and it moves the only three things about a street surface
   * that actually change after dark:
   *
   *  1. WET SHEEN. Dropping the wearing course's roughness lets the key light
   *     — which the contract guarantees is always above the horizon, i.e. the
   *     moon once the sun has set — lay a specular sheet down the carriageway.
   *     That one term is the whole difference between "dark grey" and "road".
   *  2. RETROREFLECTIVE PAINT. Lane markings are glass-beaded; they are the
   *     one thing on a night street that refuses to go dark. Left alone they
   *     crush into the asphalt and the entire lane structure disappears, which
   *     is a readability failure whatever else is in the frame.
   *  3. The bridge lamps, which were previously lit at noon.
   */
  const nightWet = [matRoad, matPatch, matBus];
  const nightPaint = [matWhite, matYellow];
  matWhite.emissive.set(PALETTE.ROAD_LINE);
  matYellow.emissive.set(PALETTE.ROAD_LINE_YELLOW);
  const glowBase = matGlow ? matGlow.color.clone() : null;

  let lastNight = -1;
  function applyNight(n) {
    if (Math.abs(n - lastNight) < 0.004) return;
    lastNight = n;
    for (const m of nightWet) {
      m.roughness = 1.0 - 0.46 * n;
      m.metalness = 0.07 * n;
      m.envMapIntensity = 0.30 + 0.30 * n;
    }
    // A touch of lift in daylight too: it is what keeps a crossing legible
    // inside a tower's shadow without making it glow.
    for (const m of nightPaint) m.emissiveIntensity = 0.025 + 0.21 * n;
    if (matGlow) matGlow.color.copy(glowBase).multiplyScalar(0.10 + 1.2 * n);
  }

  /*
   * WHY THIS IS HUNG OFF onBeforeRender AS WELL AS THE CONTRACT HOOK.
   * The day/night contract says register the per-frame update on
   * `scene.userData.*Update`, and it is registered — but game.js only pumps
   * `trafficUpdate` and `pedestrianUpdate` by name, so a third name is dead
   * code until someone adds a line there. The renderer calls
   * Object3D.onBeforeRender on every object it draws, and the base land plane
   * is a single mesh spanning the whole map, so it is drawn in every frame of
   * every preset. Both paths call the same idempotent function and whichever
   * runs first wins; the other early-outs on the epsilon.
   */
  if (landMesh) {
    const prev = landMesh.onBeforeRender;
    landMesh.onBeforeRender = function (...args) {
      applyNight(ctx.scene.userData.nightFactor || 0);
      if (prev) prev.apply(this, args);
    };
  }
  ctx.scene.userData.streetsUpdate = () => applyNight(ctx.scene.userData.nightFactor || 0);
  applyNight(ctx.scene.userData.nightFactor || 0);

  console.debug(
    `[streets] ${layout.blocks.length} blocks | ${stat.ramps} kerb ramps | ` +
    `${stat.xovers} crossovers | ${stat.crossBars} zebra bars | ` +
    `${stat.arrows} arrows | ${stat.bays} bays (${stat.accessible} accessible, ` +
    `${stat.loading} loading) | ${Math.round(stat.cycleM)} m cycle lane | ` +
    `${stat.seams} crack seams | ${stat.manholes} manholes | ` +
    `${Math.round(stat.medianM)} m median | ${stat.bridges} bridges`
  );

  return group;
}
