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
import { ROAD_CLASS } from './cityLayout.js';
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

/** Kerb reveal above the carriageway, and the width of the gutter pan. */
const GUTTER_W = 0.34;

/**
 * The kerb + sidewalk cross-section, measured as an inset from the block edge.
 * Negative = out over the asphalt. `c` is a vertex-colour multiplier on the
 * paving albedo: the nose is pushed bright because a chamfer that catches the
 * sun is the single thing that makes a kerb read as concrete rather than paint.
 */
const PROFILE = [
  { o: -GUTTER_W, y: 0.016, c: 0.88 },   // outer lip of the gutter pan
  { o: -0.14, y: 0.008, c: 0.80 },       // channel invert — water runs here
  { o: -0.01, y: 0.038, c: 0.93 },       // toe of the kerb
  { o: 0.04, y: 0.120, c: 0.82 },        // battered face, mostly in shadow
  { o: 0.11, y: 0.182, c: 1.12 },        // chamfered nose — the sunlit highlight
  { o: 0.19, y: 0.192, c: 1.04 },        // kerb top
  { o: 0.34, y: Y_WALK, c: 0.97 },       // back of kerb
  { o: 1.75, y: Y_WALK, c: 1.0 },        // front of the walking zone (ramp run)
  { o: 0, y: Y_WALK, c: 1.0 },           // building line — `o` filled per block
];
/** Same stations, dropped flush for a kerb ramp. */
const PROFILE_DROP = [0.016, 0.008, 0.030, 0.038, 0.050, 0.056, 0.062, Y_WALK, Y_WALK];

const RAMP_A = 1.2;      // ramp starts this far from the block corner
const RAMP_B = 4.9;      // ...and ends here. Matches the zebra corridor below.
const RAMP_FLARE = 0.7;

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

  /** Axis-aligned horizontal rectangle. */
  rect(x0, x1, z0, z1, y, col) {
    if (x1 - x0 < 1e-4 || z1 - z0 < 1e-4) return;
    this.quad([x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0], col);
  }

  /** Convex polygon (fan) on a horizontal plane. `pts` = [[x,z], ...] CCW. */
  polyY(pts, y, col) {
    for (let i = 1; i < pts.length - 1; i++) {
      this.tri(
        [pts[0][0], y, pts[0][1]],
        [pts[i][0], y, pts[i][1]],
        [pts[i + 1][0], y, pts[i + 1][1]],
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

  const LAND_X0 = -S - 40, LAND_X1 = BAY;
  const LAND_Z0 = -S - 40, LAND_Z1 = S + 40;

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

  const stat = { crossBars: 0, ramps: 0, manholes: 0, arrows: 0, medianM: 0, bridges: 0 };

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

    const bankLine = [];        // for the bulkhead sweep
    for (let i = 0; i < cols.length - 1; i++) {
      const xa = cols[i], xb = cols[i + 1];
      if (xb - xa < 1e-4) continue;
      const [ta, ba] = bank(xa);
      const [tb, bb] = bank(xb);
      bankLine.push({ x: xa, top: ta, bot: ba });

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

    /* Bulkhead: a low concrete wall along both banks. Without it the 32 cm
       step from the land plane down to the water plane shows as a sliver of
       background at any grazing camera angle. */
    for (let i = 0; i < bankLine.length - 1; i++) {
      const a = bankLine[i], b = bankLine[i + 1];
      if (b.x - a.x > 12) continue;                 // skip the map-edge jump
      wallRun(a.x, a.top, b.x, b.top, 1);
      wallRun(a.x, a.bot, b.x, b.bot, -1);
    }
    for (const p of layout.waterPolys) {
      wallRun(p.x0, p.z0, p.x1, p.z0, 1);
      wallRun(p.x0, p.z1, p.x1, p.z1, -1);
      wallRunZ(p.x0, p.z0, p.z1);
    }
  }

  /** Bulkhead segment along x, `side` = which way the land is (+1 = -z side). */
  function wallRun(x0, z0, x1, z1, side) {
    const TOP = 0.42, BOT = -1.9, T = 0.5;
    const o = side * T;
    struct.quad(
      [x0, TOP, z0], [x0, BOT, z0], [x1, BOT, z1], [x1, TOP, z1], 0.98, true
    );
    struct.quad(
      [x0, TOP, z0 - o], [x0, TOP, z0], [x1, TOP, z1], [x1, TOP, z1 - o], 1.06
    );
  }
  function wallRunZ(x, z0, z1) {
    const TOP = 0.42, BOT = -1.9;
    struct.quad([x, TOP, z1], [x, BOT, z1], [x, BOT, z0], [x, TOP, z0], 0.96, true);
    struct.quad([x - 0.5, TOP, z0], [x - 0.5, TOP, z1], [x, TOP, z1], [x, TOP, z0], 1.06);
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

  /** Runs of open carriageway: dry, off the junctions, off the bridge decks. */
  function carriagewayRuns(r) {
    const lo = r.axis === 'x' ? -S - 30 : -S - 30;
    const hi = r.axis === 'x' ? S + 30 : BAY;
    let runs = dryRuns(layout, r, lo, hi);
    for (const [a, b] of (r.axis === 'x' ? junctionSpansX : junctionSpansZ)) runs = cut(runs, a, b);
    for (const br of layout.bridges) {
      if (r.axis === 'x') {
        if (Math.abs(br.x - r.pos) > br.width * 0.5) continue;
        runs = cut(runs, br.z - br.length / 2, br.z + br.length / 2);
      } else {
        if (Math.abs(br.z - r.pos) > br.length * 0.5) continue;
        runs = cut(runs, br.x - br.width / 2, br.x + br.width / 2);
      }
    }
    return runs;
  }

  /** Runs of paint: same, but paint carries straight over a bridge deck. */
  function paintRuns(r) {
    const lo = -S - 30;
    const hi = r.axis === 'x' ? S + 30 : BAY;
    let runs = dryRuns(layout, r, lo, hi);
    for (const [a, b] of (r.axis === 'x' ? junctionSpansX : junctionSpansZ)) {
      runs = cut(runs, a - 6.5, b + 6.5);
    }
    return runs;
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
  }

  /* --- the diagonal transit cut ----------------------------------------- */
  for (const d of layout.diagonals) {
    const nx = d.nx * d.half, nz = d.nz * d.half;
    road.quad(
      [d.ax - nx, Y_DIAG, d.az - nz], [d.ax + nx, Y_DIAG, d.az + nz],
      [d.bx + nx, Y_DIAG, d.bz + nz], [d.bx - nx, Y_DIAG, d.bz - nz], 1.0
    );
    // Centre line, dashed, following the bias.
    const n = Math.floor(d.len / 12);
    for (let i = 0; i < n; i++) {
      const t0 = (i + 0.25) * 12, t1 = t0 + 5.5;
      const w = 0.15;
      white.quad(
        [d.ax + d.ux * t0 - d.nx * w, Y_MARK, d.az + d.uz * t0 - d.nz * w],
        [d.ax + d.ux * t0 + d.nx * w, Y_MARK, d.az + d.uz * t0 + d.nz * w],
        [d.ax + d.ux * t1 + d.nx * w, Y_MARK, d.az + d.uz * t1 + d.nz * w],
        [d.ax + d.ux * t1 - d.nx * w, Y_MARK, d.az + d.uz * t1 - d.nz * w], 1.0
      );
    }
  }

  /* ================================================== 3. lane marking === */

  /** One dashed run of paint along a road's free axis. */
  function dashRun(r, cross, a, b, w, dash, gap, surf, col) {
    for (let t = a; t < b - dash; t += dash + gap) {
      if (r.axis === 'x') surf.rect(cross - w / 2, cross + w / 2, t, t + dash, Y_MARK, col);
      else surf.rect(t, t + dash, cross - w / 2, cross + w / 2, Y_MARK, col);
    }
  }
  function solidRun(r, cross, a, b, w, surf, col) {
    if (r.axis === 'x') surf.rect(cross - w / 2, cross + w / 2, a, b, Y_MARK, col);
    else surf.rect(a, b, cross - w / 2, cross + w / 2, Y_MARK, col);
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
        // Bus lane: solid white edge plus the terracotta bed.
        if (P.bus) {
          solidRun(r, r.pos + s * P.busEdge, a, b, 0.26, white, 1.0);
          const c0 = P.busEdge + 0.13, c1 = P.busEdge + LANE_W;
          if (r.axis === 'x') busl.rect(r.pos + Math.min(s * c0, s * c1), r.pos + Math.max(s * c0, s * c1), a, b, Y_TINT, 1.0);
          else busl.rect(a, b, r.pos + Math.min(s * c0, s * c1), r.pos + Math.max(s * c0, s * c1), Y_TINT, 1.0);
        }
        // Kerbside parking: a bay line plus a tick every car length, so the
        // bays line up with where vehicles.js actually parks.
        const bayLine = r.half - P.park;
        solidRun(r, r.pos + s * bayLine, a, b, 0.20, white, 0.92);
        for (let t = Math.ceil(a / 6.6) * 6.6; t < b; t += 6.6) {
          const t0 = t - 0.09, t1 = t + 0.09;
          const e0 = bayLine, e1 = Math.min(r.half - 0.25, bayLine + 1.6);
          if (r.axis === 'x') white.rect(r.pos + Math.min(s * e0, s * e1), r.pos + Math.max(s * e0, s * e1), t0, t1, Y_MARK, 0.92);
          else white.rect(t0, t1, r.pos + Math.min(s * e0, s * e1), r.pos + Math.max(s * e0, s * e1), Y_MARK, 0.92);
        }
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

  /* ============================================ 4. junctions + zebras === */

  for (const ix of net.intersections) {
    const rx = layout.roadsX[ix.ri];
    const rz = layout.roadsZ[ix.rj];
    const major = rx.cls !== STREET || rz.cls !== STREET;

    // Zebra on every approach of a signalled junction; a quiet street-on-street
    // crossroads gets two, which is what stops the city reading as a stencil.
    const sidesX = major ? [-1, 1] : [rng.sign()];
    const sidesZ = major ? [-1, 1] : [rng.sign()];

    for (const s of sidesX) {
      // Crossing the N/S road, north or south of the box.
      const zc = rz.pos + s * (rz.half + CROSS_GAP + CROSS_W / 2);
      zebra(rx.pos - rx.half, rx.pos + rx.half, zc, 'x');
      stopBar(rx, rz, s, 'x');
    }
    for (const s of sidesZ) {
      const xc = rx.pos + s * (rx.half + CROSS_GAP + CROSS_W / 2);
      zebra(rz.pos - rz.half, rz.pos + rz.half, xc, 'z');
      stopBar(rz, rx, s, 'z');
    }

    /* Junction wear: real intersections are a patchwork of utility cuts and
       overlay, and the polish where every tyre in the city turns. Kept inside
       +-10% albedo so it reads as surface history, not dirt. */
    const jr = makeRNG((ix.id * 2654435761) >>> 0);
    for (let i = 0; i < 3; i++) {
      const w = ix.halfX * (0.3 + jr() * 0.55), d = ix.halfZ * (0.3 + jr() * 0.55);
      const cx = ix.x + (jr() - 0.5) * (ix.halfX * 2 - w);
      const cz = ix.z + (jr() - 0.5) * (ix.halfZ * 2 - d);
      patch.rect(cx - w / 2, cx + w / 2, cz - d / 2, cz + d / 2, Y_PATCH, 0.90 + jr() * 0.19);
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

    // Keep-clear box: only where two boulevards meet, or it becomes wallpaper.
    if (rx.cls === BOULEVARD && rz.cls === BOULEVARD) keepClear(ix);

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
      approachArrows(rx, rz, s, 'x');
      approachArrows(rz, rx, s, 'z');
    }
  }

  /** Zebra bars across a carriageway. `axis` = the axis the road runs on. */
  function zebra(lo, hi, cross, axis) {
    const span = hi - lo - 1.4;
    const n = Math.max(3, Math.floor(span / BAR_PITCH));
    const start = (lo + hi) / 2 - (n - 1) * BAR_PITCH / 2;
    for (let i = 0; i < n; i++) {
      const p = start + i * BAR_PITCH;
      if (axis === 'x') white.rect(p - BAR_W / 2, p + BAR_W / 2, cross - CROSS_W / 2, cross + CROSS_W / 2, Y_MARK, 1.0);
      else white.rect(cross - CROSS_W / 2, cross + CROSS_W / 2, p - BAR_W / 2, p + BAR_W / 2, Y_MARK, 1.0);
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
    const base = cr.half + CROSS_GAP + CROSS_W + STOP_SET + STOP_BAR + 4.6;
    if (base > 26) return;
    for (let k = 0; k < P.lanes; k++) {
      const lat = P.inner + (k + 0.5) * LANE_W;
      const cx0 = r.pos + rightSign * lat;
      const c = cr.pos + s * base;
      // Kerb lane may turn right, the median lane left, the rest go ahead.
      let kind = 'ahead';
      if (k === 0 && P.lanes > 1) kind = 'right';
      else if (k === P.lanes - 1 && P.lanes > 1) kind = 'left';
      // Heading: the vehicle travels toward the junction, i.e. in -s.
      let rot;
      if (axis === 'x') rot = dir > 0 ? 0 : Math.PI;
      else rot = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
      const px = axis === 'x' ? cx0 : c;
      const pz = axis === 'x' ? c : cx0;
      // Mirror the turn side for lanes on the far half of a two-way road.
      const flip = rightSign < 0 ? -1 : 1;
      arrow(px, pz, rot, kind, axis === 'x' ? flip : flip);
      stat.arrows++;
    }
  }

  /** Painted arrow: 4.4 m long, chunky enough to read from 60 m up. */
  function arrow(px, pz, rot, kind, flip) {
    const cs = Math.cos(rot), sn = Math.sin(rot);
    // local (u = forward, v = left of travel) -> world
    const P = (u, v) => {
      const vv = v * flip;
      // rot 0 => forward +z ; rot PI/2 => forward +x
      return [px + vv * cs + u * sn, pz + u * cs - vv * sn];
    };
    const poly = (pts) => white.polyY(pts.map(([u, v]) => P(u, v)), Y_MARK, 1.0);
    // shaft
    poly([[-2.2, -0.24], [1.0, -0.24], [1.0, 0.24], [-2.2, 0.24]]);
    if (kind === 'ahead') {
      poly([[1.0, -0.72], [2.2, 0], [1.0, 0.72]]);
      poly([[1.0, -0.24], [1.0, 0.24], [1.0, 0.24], [1.0, -0.24]]);
    } else {
      const sgn = kind === 'left' ? 1 : -1;
      // elbow + head pointing across
      poly([[0.52, sgn * 0.24], [1.0, sgn * 0.24], [1.0, sgn * 1.15], [0.52, sgn * 1.15]]);
      poly([[0.28, sgn * 1.15], [1.24, sgn * 1.15], [0.76, sgn * 2.05]]);
      // and a straight head, because these lanes may also go ahead
      poly([[1.0, -0.72], [2.2, 0], [1.0, 0.72]]);
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
    const kMin = x0 - z1, kMax = x1 - z0;
    for (let k = kMin; k < kMax; k += 4.2) {
      const pts = [];
      const ax = Math.max(x0, k + z0), az = ax - k;
      const bx = Math.min(x1, k + z1), bz = bx - k;
      if (bx - ax < 0.4) continue;
      pts.push([ax, az], [bx, bz]);
      const hw = 0.16;
      yellow.quad(
        [ax + hw, Y_MARK, az - hw], [bx + hw, Y_MARK, bz - hw],
        [bx - hw, Y_MARK, bz + hw], [ax - hw, Y_MARK, az + hw], 1.0
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

    // Interior slab (building pad / plaza floor). Kept a shade warmer than the
    // walking band so the frontage still reads as a footway from the air.
    walk.rect(x0 + sw, x1 - sw, z0 + sw, z1 - sw, Y_WALK, tone * 0.985);

    const edges = [
      { key: 'n', road: b.edges.n, len: b.w, corner0: [x0, z0], corner1: [x1, z0] },
      { key: 'e', road: b.edges.e, len: b.d, corner0: [x1, z0], corner1: [x1, z1] },
      { key: 's', road: b.edges.s, len: b.w, corner0: [x1, z1], corner1: [x0, z1] },
      { key: 'w', road: b.edges.w, len: b.d, corner0: [x0, z1], corner1: [x0, z0] },
    ];

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
      stations.push({ s: e.len, d: 0 });
      stations.sort((p, q) => p.s - q.s);

      sweepEdge(e, stations, sw, tone, x0, x1, z0, z1);
    }

    // Planting strip: a continuous green ribbon behind the kerb on the busy
    // frontages. nature.js drops its street palms at 2.2 m in, which lands
    // inside this band, so the two agree without either knowing about it.
    if (b.streetLife > 0.5 && sw > 4.2) {
      for (const e of edges) {
        if (!e.road) continue;
        plantStrip(e, x0, x1, z0, z1);
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
  function sweepEdge(e, stations, sw, tone, x0, x1, z0, z1) {
    const N = PROFILE.length;
    const oAt = (i) => (i === N - 1 ? sw : PROFILE[i].o);
    const yAt = (i, d) => PROFILE[i].y + (PROFILE_DROP[i] - PROFILE[i].y) * d;

    const pt = (i, st) => {
      const o = oAt(i);
      // Corner stations follow the mitre; interior stations are clamped so a
      // wide sidewalk cannot fold back on itself near a corner.
      const s = st.s <= 0 ? o : (st.s >= e.len ? e.len - o : Math.max(st.s, o));
      const y = yAt(i, st.d);
      const [px, pz] = edgePoint(e, s, o, x0, x1, z0, z1);
      return [px, y, pz];
    };

    for (let i = 0; i < N - 1; i++) {
      const col0 = PROFILE[i].c * tone;
      const col1 = PROFILE[i + 1].c * tone;
      const col = (col0 + col1) * 0.5;
      for (let k = 0; k < stations.length - 1; k++) {
        const a = pt(i, stations[k]);
        const b = pt(i, stations[k + 1]);
        const c = pt(i + 1, stations[k + 1]);
        const d = pt(i + 1, stations[k]);
        // Wind so the normal comes out +y on the flat parts.
        walk.quad(a, b, c, d, col);
      }
    }
  }

  /** Grass ribbon behind the kerb, broken so people can reach the kerb. */
  function plantStrip(e, x0, x1, z0, z1) {
    const IN0 = 1.55, IN1 = 3.05;
    const seg = 12.5, gapW = 2.6;
    for (let s = 3.5; s < e.len - 5.5; s += seg) {
      const a = s, c = Math.min(e.len - 3.5, s + seg - gapW);
      if (c - a < 3) continue;
      const p0 = edgePoint(e, a, IN0, x0, x1, z0, z1);
      const p1 = edgePoint(e, c, IN0, x0, x1, z0, z1);
      const p2 = edgePoint(e, c, IN1, x0, x1, z0, z1);
      const p3 = edgePoint(e, a, IN1, x0, x1, z0, z1);
      plant.quad(
        [p0[0], Y_WALK + 0.005, p0[1]], [p1[0], Y_WALK + 0.005, p1[1]],
        [p2[0], Y_WALK + 0.005, p2[1]], [p3[0], Y_WALK + 0.005, p3[1]], 1.0
      );
    }
  }

  /* ================================================== 6. the medians === */

  for (const r of layout.medians) {
    const hw = r.medianW * 0.5;
    let runs = dryRuns(layout, r, r.axis === 'x' ? -S - 30 : -S - 30, r.axis === 'x' ? S + 30 : BAY);
    for (const [a, b] of (r.axis === 'x' ? junctionSpansX : junctionSpansZ)) {
      runs = cut(runs, a - 7, b + 7);      // pull back for the median nose
    }
    for (const [a, b] of runs) {
      if (b - a < 8) continue;
      medianRun(r, hw, a, b);
      stat.medianM += b - a;
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
          if (s > 0) walk.quad(A, B, C, D, col);
          else walk.quad(D, C, B, A, col);
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
      if (r.axis === 'x') plant.quad(A, B, C, D, 1.0);
      else plant.quad(D, C, B, A, 1.0);
    }
    // Hedge spine, chamfered so it never shows a razor edge.
    const hh = 0.62, hwid = Math.min(1.05, hw - 1.2);
    if (hwid > 0.3) {
      for (let k = 0; k < ts.length - 1; k++) {
        const t0 = ts[k], t1 = ts[k + 1];
        if (inset(t0) > 0.05 || inset(t1) > 0.05) continue;
        if (r.axis === 'x') {
          hedge.box(r.pos - hwid, r.pos + hwid, 0.14, 0.14 + hh, t0, t1, 0.86, 1.1);
        } else {
          hedge.box(t0, t1, 0.14, 0.14 + hh, r.pos - hwid, r.pos + hwid, 0.86, 1.1);
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

  /* ===================================================== 8. bridges === */

  for (const br of layout.bridges) {
    buildBridge(br);
    stat.bridges++;
  }

  /**
   * A bridge is a deck, a cambered soffit, pilastered parapets, piers into the
   * channel and a pair of lighting standards.
   *
   * NOTE the deck TOP is dead flat at y=0: vehicles.js pins traffic to y=0.02,
   * so an arched running surface would bury every car at mid-span. The camber
   * is carried by the soffit and the parapet line instead, which is where you
   * read it from a 3/4 camera anyway.
   */
  function buildBridge(br) {
    const alongZ = br.length >= br.width;
    const hw = br.width / 2, hl = br.length / 2;
    const N = 10;
    const DECK = 1.35;

    const seg = (i) => {
      const t = i / N;
      const camber = 0.75 * (1 - (2 * t - 1) * (2 * t - 1));
      return {
        p: (alongZ ? br.z - hl + br.length * t : br.x - hw * 0 - (br.width / 2) + br.width * t),
        camber,
      };
    };

    // Deck running surface (asphalt, part of the carriageway mesh).
    if (alongZ) road.rect(br.x - hw, br.x + hw, br.z - hl, br.z + hl, Y_ROAD, 1.0);
    else road.rect(br.x - br.width / 2, br.x + br.width / 2, br.z - br.length / 2, br.z + br.length / 2, Y_ROAD, 1.0);

    // Soffit + fascia.
    for (let i = 0; i < N; i++) {
      const a = seg(i), b = seg(i + 1);
      const ya = -DECK + a.camber, yb = -DECK + b.camber;
      if (alongZ) {
        // undersides
        struct.quad([br.x - hw, ya, a.p], [br.x + hw, ya, a.p], [br.x + hw, yb, b.p], [br.x - hw, yb, b.p], 0.72);
        // fascia beams
        struct.quad([br.x - hw, 0, a.p], [br.x - hw, ya, a.p], [br.x - hw, yb, b.p], [br.x - hw, 0, b.p], 0.9, true);
        struct.quad([br.x + hw, ya, a.p], [br.x + hw, 0, a.p], [br.x + hw, 0, b.p], [br.x + hw, yb, b.p], 0.9, true);
      } else {
        struct.quad([a.p, ya, br.z - br.length / 2], [a.p, ya, br.z + br.length / 2], [b.p, yb, br.z + br.length / 2], [b.p, yb, br.z - br.length / 2], 0.72);
      }
    }

    // Parapets. Solid wall with pilasters — balusters at this scale would be
    // razor-thin geometry, which the art bible forbids.
    const PAR_H = 1.05;
    const wallAt = (s) => {
      if (alongZ) {
        struct.box(br.x + s * hw - 0.42, br.x + s * hw + 0.06, 0, PAR_H, br.z - hl, br.z + hl, 0.96, 1.08);
      } else {
        struct.box(br.x - br.width / 2, br.x + br.width / 2, 0, PAR_H, br.z + s * (br.length / 2) - 0.42, br.z + s * (br.length / 2) + 0.06, 0.96, 1.08);
      }
    };
    wallAt(-1); wallAt(1);
    const span = alongZ ? br.length : br.width;
    const np = Math.max(2, Math.round(span / 9));
    for (let i = 0; i <= np; i++) {
      const t = i / np;
      const camber = 0.28 * (1 - (2 * t - 1) * (2 * t - 1));
      for (const s of [-1, 1]) {
        if (alongZ) {
          const z = br.z - hl + br.length * t;
          struct.box(br.x + s * hw - 0.55, br.x + s * hw + 0.18, 0, PAR_H + 0.30 + camber, z - 0.42, z + 0.42, 1.0, 1.14);
        } else {
          const x = br.x - br.width / 2 + br.width * t;
          struct.box(x - 0.42, x + 0.42, 0, PAR_H + 0.30 + camber, br.z + s * (br.length / 2) - 0.55, br.z + s * (br.length / 2) + 0.18, 1.0, 1.14);
        }
      }
    }

    // Piers into the channel.
    const piers = Math.max(1, Math.round(span / 26));
    for (let i = 1; i <= piers; i++) {
      const t = i / (piers + 1);
      if (alongZ) {
        const z = br.z - hl + br.length * t;
        struct.box(br.x - hw * 0.62, br.x + hw * 0.62, -6.5, -DECK + 0.15, z - 1.5, z + 1.5, 0.8, 0.9);
      } else {
        const x = br.x - br.width / 2 + br.width * t;
        struct.box(x - 1.5, x + 1.5, -6.5, -DECK + 0.15, br.z - br.length * 0.3, br.z + br.length * 0.3, 0.8, 0.9);
      }
    }

    // Lighting standards on the parapet.
    const lamps = Math.max(2, Math.round(span / 22));
    for (let i = 0; i < lamps; i++) {
      const t = (i + 0.5) / lamps;
      for (const s of [-1, 1]) {
        const lx = alongZ ? br.x + s * (hw - 0.2) : br.x - br.width / 2 + br.width * t;
        const lz = alongZ ? br.z - hl + br.length * t : br.z + s * (br.length / 2 - 0.2);
        lampPole.box(lx - 0.11, lx + 0.11, PAR_H, PAR_H + 4.4, lz - 0.11, lz + 0.11, 0.9, 1.0);
        lampGlow.box(lx - 0.34, lx + 0.34, PAR_H + 4.4, PAR_H + 4.7, lz - 0.26, lz + 0.26, 1.0, 1.0);
      }
    }
  }

  /* ================================================== 9. materials === */

  const asphaltMap = Textures.asphalt();
  const asphaltNormal = asphaltMap.userData.companions
    ? asphaltMap.userData.companions.normalMap : null;

  addMesh(group, land, layer({
    map: Textures.paving(512, PALETTE.GRAVEL, 'rgba(118,110,94,0.42)', 3),
    roughness: 1.0,
  }, 0), 'ground-base');

  addMesh(group, bed, ground({
    color: PALETTE.SEA_MID, roughness: 0.6, metalness: 0.0,
  }), 'water-bed', false);

  addMesh(group, road, layer({
    map: asphaltMap,
    roughness: 1.0,
  }, 1), 'roads');

  addMesh(group, alley, layer({
    map: Textures.paving(512, PALETTE.CONCRETE_DARK, 'rgba(104,94,80,0.62)', 2),
    roughness: 1.0,
  }, 1), 'alleys');

  addMesh(group, patch, layer({
    map: asphaltMap, roughness: 1.0, vertexColors: true,
  }, 2), 'road-wear');

  // Bus-lane paint: PALETTE.TERRACOTTA knocked back so it reads as worn paint
  // on asphalt rather than a red carpet. Flat albedo (paint IS flat) with the
  // road's own normal map so the surface relief carries straight through.
  const busColor = new THREE.Color(PALETTE.TERRACOTTA).multiplyScalar(0.52);
  addMesh(group, busl, layer({
    color: busColor,
    normalMap: asphaltNormal,
    normalScale: new THREE.Vector2(0.8, 0.8),
    roughnessMap: Textures.roughness(256, 196, 0.20),
    roughness: 1.0,
  }, 3), 'bus-lanes');

  addMesh(group, white, layer({
    color: PALETTE.ROAD_LINE, roughness: 0.86, vertexColors: true,
  }, 5), 'markings-white', false);

  addMesh(group, yellow, layer({
    color: PALETTE.ROAD_LINE_YELLOW, roughness: 0.86, vertexColors: true,
  }, 5), 'markings-yellow', false);

  addMesh(group, walk, layer({
    map: Textures.paving(512, PALETTE.SIDEWALK, 'rgba(150,142,126,0.5)', 4),
    roughness: 0.94, vertexColors: true,
  }, 1), 'sidewalks');

  addMesh(group, plant, ground({
    map: Textures.grass(), roughness: 0.95,
  }), 'planting');

  addMesh(group, iron, layer({
    color: PALETTE.ROOF_TAR, roughness: 0.62, metalness: 0.25, vertexColors: true,
  }, 7), 'road-ironwork', false);

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

  if (!lampGlow.empty) {
    const gm = new THREE.Mesh(lampGlow.build(), new THREE.MeshBasicMaterial({
      color: new THREE.Color(PALETTE.LAMP_GLOW), toneMapped: false, vertexColors: true,
    }));
    gm.name = 'bridge-lamp-glow';
    gm.matrixAutoUpdate = false;
    group.add(gm);
  }

  console.debug(
    `[streets] ${layout.blocks.length} blocks | ${stat.ramps} kerb ramps | ` +
    `${stat.crossBars} zebra bars | ${stat.arrows} arrows | ${stat.manholes} manholes | ` +
    `${Math.round(stat.medianM)} m median | ${stat.bridges} bridges`
  );

  return group;
}
