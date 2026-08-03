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
  { o: 1.90, y: Y_WALK, c: 1.0 },        // front of the walking zone (ramp run)
  { o: 0, y: Y_WALK, c: 1.0 },           // building line — `o` filled per block
];
/** Same stations, dropped flush for a kerb ramp. */
const PROFILE_DROP = [0.016, 0.006, 0.030, 0.040, 0.052, 0.058, 0.064, Y_WALK, Y_WALK];

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
  }

  /* --- the diagonal transit cut ----------------------------------------- */
  // Emitted into the ALLEY layer on purpose: it crosses every road it meets,
  // and the alley layer's polygon offset sits between the base land and the
  // carriageway, so the roads always win the overlap at any view distance.
  for (const d of layout.diagonals) {
    const nx = d.nx * d.half, nz = d.nz * d.half;
    alley.quad(
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

  /**
   * Deterministic 0..1 hash. Used to fade paint: a city where every dash is
   * exactly the same brightness reads as a stencil, and the high-contrast
   * white is also what makes distant sub-pixel lines fringe under the lens
   * aberration in the grade.
   */
  const fade = (a, b) => {
    const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
    return 0.82 + (s - Math.floor(s)) * 0.18;
  };

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
        // Kerbside parking: a bay line plus a tick every car length, so the
        // bays line up with where vehicles.js actually parks.
        const bayLine = r.half - P.park;
        solidRun(r, r.pos + s * bayLine, a, b, 0.24, white, 0.90);
        for (let t = Math.ceil(a / 6.6) * 6.6; t < b; t += 6.6) {
          const t0 = t - 0.11, t1 = t + 0.11;
          const e0 = bayLine, e1 = Math.min(r.half - 0.25, bayLine + 1.6);
          const c = 0.9 * fade(t, bayLine);
          if (r.axis === 'x') white.rect(r.pos + Math.min(s * e0, s * e1), r.pos + Math.max(s * e0, s * e1), t0, t1, Y_MARK, c);
          else white.rect(t0, t1, r.pos + Math.min(s * e0, s * e1), r.pos + Math.max(s * e0, s * e1), Y_MARK, c);
        }

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

    for (const s of sidesX) {
      const gap = freeGap(layout.roadsZ, ix.rj, s);
      if (gap < NEED_ZEBRA) continue;
      // Crossing the N/S road, north or south of the box.
      const zc = rz.pos + s * (rz.half + CROSS_GAP + CROSS_W / 2);
      zebra(rx.pos - rx.half, rx.pos + rx.half, zc, 'x');
      if (gap >= NEED_STOP) stopBar(rx, rz, s, 'x');
    }
    for (const s of sidesZ) {
      const gap = freeGap(layout.roadsX, ix.ri, s);
      if (gap < NEED_ZEBRA) continue;
      const xc = rx.pos + s * (rx.half + CROSS_GAP + CROSS_W / 2);
      zebra(rz.pos - rz.half, rz.pos + rz.half, xc, 'z');
      if (gap >= NEED_STOP) stopBar(rz, rx, s, 'z');
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
      if (freeGap(layout.roadsZ, ix.rj, s) > NEED_STOP + 8) approachArrows(rx, rz, s, 'x');
      if (freeGap(layout.roadsX, ix.ri, s) > NEED_STOP + 8) approachArrows(rz, rx, s, 'z');
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
    const kMin = x0 - z1, kMax = x1 - z0;
    for (let k = kMin; k < kMax; k += 6.4) {
      const ax = Math.max(x0, k + z0), az = ax - k;
      const bx = Math.min(x1, k + z1), bz = bx - k;
      if (bx - ax < 0.4) continue;
      const hw = 0.13;
      yellow.quadUp(
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

      /* Expansion joints across the walking zone every ~6 m. The paving map
         already carries the 1.2 m slab joints; this is the coarser second
         rhythm, and having both is what stops a long frontage reading as one
         extruded ribbon. They live in the marking mesh purely to reuse its
         polygon offset — the vertex colour turns the paint albedo into a
         recessed grey line. */
      if (e.road) {
        for (let s = 6; s < e.len - 2.5; s += 6) {
          const p0 = edgePoint(e, s - 0.045, 0.32, x0, x1, z0, z1);
          const p1 = edgePoint(e, s + 0.045, 0.32, x0, x1, z0, z1);
          const p2 = edgePoint(e, s + 0.045, sw, x0, x1, z0, z1);
          const p3 = edgePoint(e, s - 0.045, sw, x0, x1, z0, z1);
          const jy = Y_WALK + 0.004;
          white.quadUp(
            [p0[0], jy, p0[1]], [p1[0], jy, p1[1]],
            [p2[0], jy, p2[1]], [p3[0], jy, p3[1]], 0.56 * tone
          );
        }
      }
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
      // The mitre: corner stations move inward with the profile, and interior
      // stations are clamped into the same window so a wide sidewalk cannot
      // fold back on itself and invert a quad near a corner.
      const s = Math.min(Math.max(st.s, o), Math.max(o, e.len - o));
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
        walk.quadUp(a, b, c, d, col);
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
      const y = Y_WALK + 0.012;
      plant.quadUp(
        [p0[0], y, p0[1]], [p1[0], y, p1[1]], [p2[0], y, p2[1]], [p3[0], y, p3[1]], 1.0
      );
    }
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
  }, 0.5), 'alleys');

  addMesh(group, patch, layer({
    map: asphaltMap, roughness: 1.0, vertexColors: true,
  }, 2), 'road-wear');

  // Bus-lane paint: PALETTE.TERRACOTTA mixed most of the way back into the
  // asphalt, so it reads as a tinted lane rather than a red carpet. Flat albedo
  // (paint IS flat) with the road's own normal map so the relief carries
  // straight through and the lane still looks like tarmac.
  const busColor = new THREE.Color(PALETTE.ASPHALT)
    .lerp(new THREE.Color(PALETTE.TERRACOTTA), 0.42);
  addMesh(group, busl, layer({
    color: busColor,
    normalMap: asphaltNormal,
    normalScale: new THREE.Vector2(0.8, 0.8),
    roughnessMap: Textures.roughness(256, 196, 0.20),
    roughness: 1.0,
  }, 3), 'bus-lanes');

  // Paint receives shadow: a zebra that stays bright white inside a tower's
  // shadow is the loudest possible "these are decals" tell.
  addMesh(group, white, layer({
    color: PALETTE.ROAD_LINE, roughness: 0.88, vertexColors: true,
  }, 5), 'markings-white');

  addMesh(group, yellow, layer({
    color: PALETTE.ROAD_LINE_YELLOW, roughness: 0.88, vertexColors: true,
  }, 5), 'markings-yellow');

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
