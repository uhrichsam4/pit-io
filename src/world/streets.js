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
 *    0.008  asphalt repair panels, resurfaced trenches     (pofs -2)
 *    0.0088 wheel-track polish (crosses the panels)        (pofs -2.2)
 *    0.0095 standing damp in the gutter                    (pofs -2.5)
 *    0.010  bus-lane paint                                 (pofs -3)
 *    0.011  crack sealant                                  (pofs -3.6)
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
import { applyHoleCut } from '../render/groundShader.js';
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
/**
 * Crack sealant. Module scope, not beside the seam builder that reads it:
 * saw-cut repair borders are drawn from the carriageway pass, which runs
 * BEFORE the sealant pass, and a `const` referenced above its own line is a
 * temporal-dead-zone throw rather than a hoist. That failure takes out
 * buildStreets, and buildStreets is the one module worldBuild does not wrap in
 * a try/catch — so the whole city fails to build.
 */
const Y_SEAM = Y_PATCH + 0.003;
/**
 * Tyre polish. Its own layer between the repair panels and the damp because it
 * CROSSES the panels — see the note on the `polish` mesh. The y offset here is
 * cosmetic; the polygon offset is what decides the order.
 */
const Y_POLISH = Y_PATCH + 0.0008;
/**
 * Standing damp. Above the wear layer (it lies ON the polished asphalt) and
 * below the sealant, which is proud of everything on the carriageway.
 */
const Y_DAMP = Y_PATCH + 0.0015;
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

/**
 * How much carriageway is cleared of ordinary paint where a road dies at the
 * water. Module scope, and for the same temporal-dead-zone reason as SEG7: the
 * marking pass reads it through `paintRuns`, which runs before the end-of-road
 * pass that owns the window.
 *
 * A road that runs into Biscayne Bay is not a road that has been cut off — it
 * is a road that ENDS, and the difference is entirely in the last few metres.
 * Left alone, the lane dashes, the bay ticks and the yellow kerb line all ran
 * straight off the edge of the land, which reads exactly like a texture that
 * has been clipped by a mask.
 */
const SHORE_CLEAR = 7.0;

const CROSS_GAP = 1.1;   // clear gap between the junction box and the zebra
const CROSS_W = 3.6;     // walking width of a zebra crossing
const BAR_W = 0.55;      // one zebra bar
const BAR_PITCH = 1.18;
const STOP_BAR = 0.45;
const STOP_SET = 0.95;   // stop line sits this far back from the zebra

/**
 * CROSSING VOCABULARY.
 *
 * The corridor stays 3.6 m wide whatever style lands in it — RAMP_B, the stop
 * bar setback, the median nose pull-back and pedestrians.js's crossing points
 * are all measured off CROSS_W, so the *geometry* of a crossing is a contract.
 * What is painted INSIDE that corridor is not, and it has to vary.
 *
 * The default gameplay framing has twenty crossings in it at once. When every
 * one is the identical bar stencil at the identical pitch, the frame stops
 * reading as a city and starts reading as wallpaper — the art bible's "tiling
 * so obvious you can count the repeats" and its "crosswalk markings that read
 * as random white rectangles", arriving as the same defect. Real practice also
 * varies: a signalled arterial gets a high-visibility continental or ladder
 * marking because it has to be seen at 55 km/h, and a residential crossroads
 * gets two transverse lines because it does not.
 */
const XWALK = { CONTINENTAL: 0, LADDER: 1, TRANSVERSE: 2, DASHED: 3 };

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
    /**
     * PER-EMITTER UV PHASE — the cure for a countable repeat.
     *
     * World-space UVs are what let one road be cut into 300 pieces and still
     * look continuous, but they also lock the whole city to ONE texture phase:
     * the paving map repeats every `uv` metres from the world origin, on every
     * block, forever, and from the game camera you can count the period across
     * a long frontage. Blocks are separated by carriageway, so there is no
     * continuity between them to protect — which means each one can be given
     * its own phase and its own bond direction for free.
     *
     * Set these immediately before emitting a block and reset them after.
     */
    this.uOff = 0;
    this.vOff = 0;
    this.uvSwap = false;
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
      let u, v;
      if (wall) { u = (q[0] + q[2]) * s; v = q[1] * s; }
      else if (this.uvSwap) { u = (q[2] + this.uOff) * s; v = (q[0] + this.vOff) * s; }
      else { u = (q[0] + this.uOff) * s; v = (q[2] + this.vOff) * s; }
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

  /** Same guarantee for a triangle — same normal test `quad` and `tri` use. */
  triUp(a, b, c, col) {
    const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    if (ny < 0) this.tri(c, b, a, col);
    else this.tri(a, b, c, col);
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

  /* Only a narrow apron past the last block: the base plane is what shows when
     nothing else claims the ground, and a wide skirt of it around the map is a
     big empty flat in the menu-hero frame.
     It has to be WIDER THAN THE CARRIAGEWAY REACHES, though, and it was not.
     Every road is run out to +-(S + 30) so the grid never ends inside the
     playable square, while the land stopped at S + 16 — so the last fourteen
     metres of every road on all three land edges of the map was a strip of
     asphalt hanging in the air over nothing, thirty-two of them, each one
     visible from the two widest camera presets as a comb of grey fingers off
     the edge of the world. */
  const EDGE_APRON = 34;                       // > the roads' own 30 m overrun
  const LAND_X0 = -S - EDGE_APRON, LAND_X1 = BAY;
  const LAND_Z0 = -S - EDGE_APRON, LAND_Z1 = S + EDGE_APRON;

  const land = new Surf(5.0);
  const bed = new Surf(20);
  const road = new Surf(9.0);
  const alley = new Surf(4.0);
  const patch = new Surf(9.0);
  /**
   * TYRE POLISH, AND WHY IT IS NOT IN `patch`.
   *
   * The wear layer used to carry two things that genuinely overlap: transverse
   * resurfaced trench bands, which run the full width of the carriageway, and
   * longitudinal wheel tracks, which run its whole length. Every crossing of
   * the two was a coplanar pair inside one mesh at one y with one polygon
   * offset — a guaranteed z-fight, hundreds of them, on the surface the player
   * looks at for the entire match. There is no y offset that fixes it either:
   * at menu-hero range the depth buffer resolves centimetres.
   *
   * Splitting the polish out gives it its own polygon offset, so the crossings
   * become a decided layering (tyres polish OVER a repair, which is also what
   * happens) instead of a fight. It is then free to run through the junction
   * boxes as well, which is the only reason the biggest bare surface in the
   * game now has any traffic pattern on it.
   */
  const polish = new Surf(9.0);
  /**
   * Standing damp — the water the afternoon sun has not lifted out of the
   * gutter yet. Its own mesh purely so it can carry its own ROUGHNESS, which is
   * the whole point of it: by day it is a barely-there dark stain against the
   * kerb, and after dark it drops to a near-mirror while the rest of the
   * carriageway only half does, so the road stops being one uniformly damp
   * sheet and starts having wet places in it.
   */
  const damp = new Surf(9.0);
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

  /**
   * Detectable-warning pads. YELLOW-dominant, and that is a readability
   * decision rather than a regional one.
   *
   * These used to be terracotta — the same family as the bus-lane bed, which
   * is itself asphalt lerped toward TERRACOTTA. Side by side on one frame the
   * pedestrian warning surface and a traffic lane were the same colour, so
   * neither meant anything. Safety yellow is what Miami actually uses on most
   * of its newer ramps, it is already in the palette's accent set, and it is
   * the only warm hue on the footway that cannot be confused with a lane.
   *
   * The third variant used to be brick 0xc06038 — kept so a crossroads is never
   * four identical corners, but it put the brick family straight back on the
   * footway six metres from the bus lane it was meant to be distinguished from,
   * and the street-level frame showed exactly that. It is now the OTHER thing
   * Miami actually installs: a dark cast-iron detectable-warning plate. Third
   * distinct value, no shared hue with any traffic lane, and against bone paving
   * it is the highest-contrast of the three.
   */
  const C_TACTILE = [lin(0xd9a534), lin(PALETTE.CURB_PAINT), lin(0x6b5c4c)];
  const C_APRON = lin(PALETTE.CONCRETE_DARK, 0.92);
  const C_BAY_BLUE = lin(0x2f6fbf);
  const C_CYCLE = lin(0x3f7f5c);
  const C_KERB_PAINT = lin(PALETTE.CURB_PAINT);
  /** EV charging bay bed. Green is the one bay colour nobody reads as blue. */
  const C_EV = lin(0x2f7a52);
  /** The dark of an open kerb-inlet throat. Not black — it catches sky. */
  const C_INLET = lin(0x2b2924);

  const stat = {
    crossBars: 0, ramps: 0, manholes: 0, arrows: 0, medianM: 0, bridges: 0,
    xovers: 0, bays: 0, loading: 0, accessible: 0, seams: 0, cycleM: 0,
    ev: 0, inlets: 0, pools: 0, roadEnds: 0, xwalk: [0, 0, 0, 0],
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

  /**
   * Where a carriageway genuinely DIES AT THE WATER.
   *
   * Not every end of a dry run is one: `dryRuns` also ends at the edge of the
   * map, and `cutBridges` chops a run either side of a crossing. Both of those
   * are continuations, not ends, and painting a dead-end block into a bridge
   * approach would be a marking that means the opposite of the truth. So the
   * test is on the ground itself — is it wet two and a half metres further on —
   * and a junction sitting hard against the shore is excluded because it
   * already has a full vocabulary of stop bars and crossings in that space.
   *
   * Memoised: this bisects the coastline, `paintRuns` is called once per road
   * and the end-marking pass again, and every road would otherwise pay for it
   * twice.
   */
  const _shoreEnds = new Map();
  function shoreEnds(r) {
    let out = _shoreEnds.get(r);
    if (out) return out;
    out = [];
    const hi = r.axis === 'x' ? S + 30 : BAY;
    const perp = r.axis === 'x' ? layout.roadsZ : layout.roadsX;
    for (const [a, b] of cutBridges(r, dryRuns(layout, r, -S - 30, hi))) {
      if (b - a < 16) continue;
      for (const dir of [-1, 1]) {
        const t = dir > 0 ? b : a;
        const px = r.axis === 'x' ? r.pos : t + dir * 2.5;
        const pz = r.axis === 'x' ? t + dir * 2.5 : r.pos;
        if (!layout.isWater(px, pz)) continue;
        if (perp.some((o) => Math.abs(o.pos - t) < o.half + SHORE_CLEAR + 3)) continue;
        out.push({ t, dir });
      }
    }
    _shoreEnds.set(r, out);
    return out;
  }

  /** Runs of paint. The bridge deck paints itself, at deck height. */
  function paintRuns(r) {
    const hi = r.axis === 'x' ? S + 30 : BAY;
    let runs = dryRuns(layout, r, -S - 30, hi);
    for (const [a, b] of (r.axis === 'x' ? junctionSpansX : junctionSpansZ)) {
      runs = cut(runs, a - 6.5, b + 6.5);
    }
    // Hand the last few metres at a shoreline over to the end-of-road pass.
    // Everything it draws lives at Y_MARK in the same two meshes as the lane
    // lines, so the window has to be genuinely empty, not merely quieter.
    for (const e of shoreEnds(r)) {
      runs = cut(runs, e.t - (e.dir > 0 ? SHORE_CLEAR : 0), e.t + (e.dir < 0 ? SHORE_CLEAR : 0));
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
      else if (h < 0.185) kind = 'ev';

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
        /* Diagonal hatch across the whole zone. The brackets alone say "bay";
           the hatch is what says "and you may not park in it" — and from the
           game camera it is the only kerbside marking other than the blue
           accessible bed that reads as a FIELD rather than as a line, which is
           precisely why it survives at gameplay distance. */
        const zw = kerbO - bayLine - 0.1;
        for (let f = 0.9; f < 13.2; f += 2.2) {
          const run = Math.min(zw, 13.2 - f);
          if (run < 0.5) continue;
          const q = (dt, dof) => {
            const [qx, qz] = roadPt(r, s, t + dt, bayLine + 0.1 + dof);
            return [qx, Y_MARK, qz];
          };
          yellow.quadUp(q(f, 0), q(f + run, run), q(f + run + 0.22, run), q(f + 0.22, 0), 0.86);
        }
        stat.loading++;
      }
      if (kind === 'ev') {
        /* EV bay. Green bed plus a chunky plug glyph — two blobs and a stem,
           because at the width of one parking bay a literal socket outline is
           three pixels of noise. */
        bandRun(r, s, t + 0.45, t + 6.15, bayLine + 0.18, r.half - 0.44,
          Y_MARK - 0.002, flat, C_EV);
        const [gx, gz] = roadPt(r, s, t + 3.3, (bayLine + r.half) / 2);
        const k = Math.min(1.5, P.park * 0.6);
        const F = frame(gx, gz, rot);
        const G = (u, v) => F(u * k, v * k);
        pBar(G, -0.30, 0.46, -0.44, 0.44, white, 1.0);        // body
        pBar(G, 0.46, 0.70, -0.16, 0.16, white, 1.0);         // nose
        for (const sg of [-1, 1]) pBar(G, -0.74, -0.30, sg * 0.10, sg * 0.34, white, 1.0);
        pBar(G, -0.98, -0.74, -0.06, 0.06, white, 1.0);       // lead
        stat.ev++;
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

  /**
   * THE KERBSIDE BAY GRID, PUBLISHED.
   *
   * vehicles.js already re-derives all of this by hand so its parked fleet
   * lands on the painted bays, and the comment on parkingRun calls the 6.6 m
   * tick a contract. props.js is the third consumer and it is not on the grid:
   * it marches parking meters along the kerb on a 9.6 m rhythm of its own, and
   * 6.6 and 9.6 share no useful common multiple, so a meter turns up anywhere
   * between the middle of a bay and the middle of a tick and never twice in the
   * same relation to the paint. A meter is supposed to stand ON the division
   * between the two bays it serves — that alignment is the only reason a row of
   * them reads as a parking street rather than as posts.
   *
   * Published rather than fixed here because the meters are props.js's to
   * place. Everything it needs to land on the paint is below.
   */
  ctx.parking = {
    TICK: 6.6,
    /** Kerb-side offset of the bay line from a road centre; 0 = no bays here. */
    bayLine(r) {
      const P = lanePlan(r);
      return P.park < 2.15 ? 0 : r.half - P.park;
    },
    /** Nearest bay DIVISION to `t` — where a meter or a bay tick belongs. */
    tickNear: (t) => Math.round(t / 6.6) * 6.6,
    /** Centre of the bay that contains `t`. */
    bayCentre: (t) => Math.floor(t / 6.6) * 6.6 + 3.3,
  };

  for (const r of [...layout.roadsX, ...layout.roadsZ]) {
    const P = lanePlan(r);
    const runs = paintRuns(r);
    for (const [a, b] of runs) {
      if (b - a < 3) continue;
      /* DASH RHYTHM IS PER ROAD CLASS, and it is the cheapest cue there is for
         "this is a bigger road". Real practice scales the cycle with design
         speed — a residential street runs a short, tight broken line and an
         arterial runs a long stride with a long gap. One city-wide 3/6 rhythm
         made every road in Miami feel like the same road. */
      const dash = r.cls === STREET ? [0.20, 2.2, 3.6]
        : r.cls === AVENUE ? [0.22, 3.0, 6.0]
          : [0.26, 3.8, 8.4];

      for (const s of [-1, 1]) {
        // Lane dividers inside one direction: white, dashed.
        for (let k = 1; k < P.lanes; k++) {
          dashRun(r, r.pos + s * (P.inner + k * LANE_W), a, b, dash[0], dash[1], dash[2], white, 1.0);
        }
        // Bus lane: solid white edge (the bed itself is laid separately so it
        // can run continuously through the crossing approach).
        if (P.bus) solidRun(r, r.pos + s * P.busEdge, a, b, 0.26, white, 1.0);
        // Kerbside parking: bays, accessible bays, loading zones, bay numbers
        // and the clearance at each junction — all hung off the same tick grid
        // vehicles.js parks on.
        parkingRun(r, P, s, a, b);
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
          // Slightly longer stride than the white lane line beside it: two
          // broken lines at the identical rhythm read as one pattern.
          dashRun(r, r.pos, a, b, 0.20, dash[1] * 1.25, dash[2] * 1.35, yellow, 1.0);
        } else {
          solidRun(r, r.pos - 0.26, a, b, 0.20, yellow, 1.0);
          solidRun(r, r.pos + 0.26, a, b, 0.20, yellow, 1.0);
        }
      }
    }
  }

  /* --- tyre polish -------------------------------------------------------- */

  /**
   * Two wear ribbons per lane, broken into uneven lengths so they read as sheen
   * on the asphalt rather than as another painted line. Only a few percent
   * brighter — any more and it becomes a marking.
   *
   * Laid on `tintRuns`, not `paintRuns`: paint stops 6.5 m short of every
   * junction because it would fight the stop bar and the zebra, but polish is
   * not paint and tyres do not stop there. Under the old runs every wheel track
   * in the city ended in mid-air 6.5 m from each box and picked up again 6.5 m
   * past it, which is the one place traffic is guaranteed to have been.
   *
   * `polish` mesh, per the note on its declaration: this crosses the transverse
   * trench bands below, and the two cannot share a depth layer.
   */
  function wheelTracks(r, P, s, a, b) {
    for (let k = 0; k < P.lanes; k++) {
      const lc = P.inner + (k + 0.5) * LANE_W;
      for (const tr of [-0.86, 0.86]) {
        const c0 = lc + tr - 0.48, c1 = lc + tr + 0.48;
        const lo = r.pos + Math.min(s * c0, s * c1);
        const hi = r.pos + Math.max(s * c0, s * c1);
        let t = a;
        while (t < b - 6) {
          const len = 14 + fade(t, k) * 40;
          const end = Math.min(b, t + len);
          if (fade(t + 3, lc) > 0.87) {
            const g = 1.0 + (fade(t, lc + 5) - 0.82) * 0.34;
            if (r.axis === 'x') polish.rect(lo, hi, t, end, Y_POLISH, g);
            else polish.rect(t, end, lo, hi, Y_POLISH, g);
          }
          t = end + 3 + fade(t, 7) * 9;
        }
      }
    }
  }

  for (const r of [...layout.roadsX, ...layout.roadsZ]) {
    const P = lanePlan(r);
    for (const [a, b] of tintRuns(r)) {
      if (b - a < 8) continue;
      for (const s of [-1, 1]) wheelTracks(r, P, s, a, b);
    }
  }

  /**
   * ...and straight through the junction box, for the road that owns it.
   *
   * A 40 m box is the single largest untouched surface in the game and the one
   * the default gameplay camera is pointed at. It is also, in reality, the most
   * polished asphalt for a mile in any direction. Only ONE of the two roads is
   * drawn: the two sets of ribbons cross at right angles all over the box, and
   * they are in a single mesh at a single depth layer, so drawing both would
   * trade a bare surface for a hundred z-fights. Same owner rule the lane
   * extension guides use, so the box reads as one road passing through another
   * rather than as two roads disagreeing.
   *
   * Spans the box PLUS the 0.4 m `tintRuns` leaves either side of it, which is
   * exactly where the mid-block ribbons stop, so the two abut without
   * overlapping.
   */
  for (const ix of net.intersections) {
    const rx = layout.roadsX[ix.ri], rz = layout.roadsZ[ix.rj];
    const px = lanePlan(rx), pz = lanePlan(rz);
    const useX = px.lanes !== pz.lanes ? px.lanes > pz.lanes : rx.half >= rz.half;
    const r = useX ? rx : rz, P = useX ? px : pz;
    const halfAlong = useX ? ix.halfZ : ix.halfX;
    const c = useX ? ix.z : ix.x;
    for (const s of [-1, 1]) {
      for (let k = 0; k < P.lanes; k++) {
        const lc = P.inner + (k + 0.5) * LANE_W;
        for (const tr of [-0.86, 0.86]) {
          const o0 = lc + tr - 0.48, o1 = lc + tr + 0.48;
          const lo = r.pos + Math.min(s * o0, s * o1);
          const hi = r.pos + Math.max(s * o0, s * o1);
          // Junction polish is stronger than mid-block and always present:
          // every tyre in the district brakes, waits and pulls away here.
          const g = 1.03 + h01(ix.id + k, tr) * 0.07;
          const t0 = c - halfAlong - 0.4, t1 = c + halfAlong + 0.4;
          if (useX) polish.rect(lo, hi, t0, t1, Y_POLISH, g);
          else polish.rect(t0, t1, lo, hi, Y_POLISH, g);
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
        const lo = r.pos - r.half + 0.4, hi = r.pos + r.half - 0.4;
        if (r.axis === 'x') patch.rect(lo, hi, t, t + w, Y_PATCH, tone);
        else patch.rect(t, t + w, lo, hi, Y_PATCH, tone);
        /* A resurfaced band is a trench that was dug, backfilled and sealed:
           the two long joints are the whole reason you can see it. Only the
           long sides — the short ends die into the kerb. */
        const col = 1.20 + fade(t, 17) * 0.38;
        if (r.axis === 'x') {
          seam(lo, t, 1, 0, hi - lo, 0.12, t * 5.1, col);
          seam(lo, t + w, 1, 0, hi - lo, 0.12, t * 5.1 + 9, col);
        } else {
          seam(t, lo, 0, 1, hi - lo, 0.12, t * 5.1, col);
          seam(t + w, lo, 0, 1, hi - lo, 0.12, t * 5.1 + 9, col);
        }
      }
    }
  }

  /* --- standing damp in the channel -------------------------------------- */

  /**
   * One irregular pool of damp, flattened along the gutter it sits in.
   *
   * A ten-sided blob rather than a disc: the whole value of this thing is that
   * it is the only shape on the carriageway with no straight edge and no axis,
   * so the radius is jittered per vertex and the outline is squashed across the
   * channel. Two rings — a wet core and a drying margin — because a puddle with
   * a hard edge reads as a decal, and the margin is also what carries the
   * transition when the night driver takes the core down to a mirror.
   */
  function pool(cx, cz, along, across, alongX, seed) {
    const n = 10;
    /** Rim point i at radius fraction k. `j` is per-vertex, NOT per-ring, so
        the core and the margin stay radially aligned and share their edge. */
    const at = (i, k) => {
      const a = ((i % n) / n) * Math.PI * 2 + seed;
      const j = 0.72 + h01(seed + (i % n), 3.7) * 0.46;
      const u = Math.cos(a) * along * k * j;
      const v = Math.sin(a) * across * k * j;
      return alongX ? [cx + u, Y_DAMP, cz + v] : [cx + v, Y_DAMP, cz + u];
    };
    const C = [cx, Y_DAMP, cz];
    for (let i = 0; i < n; i++) {
      const a0 = at(i, 0.60), a1 = at(i + 1, 0.60);
      const b0 = at(i, 1.0), b1 = at(i + 1, 1.0);
      /* Wet core fanned from the CENTRE, not from a rim vertex: a jittered
         outline is star-shaped but not reliably convex, and polyY's fan off
         p[0] folds back on itself the moment it is not — two coplanar
         triangles of one mesh fighting each other. */
      damp.triUp(C, a1, a0, 0.86);
      /* Drying margin as an annulus sharing the core's rim vertices. Stacking
         a smaller disc on top of a bigger one would need a y offset, and a
         millimetre of separation does not survive being looked at from the
         menu-hero camera 400 m away. Tiling needs none. */
      damp.quadUp(a0, a1, b1, b0, 0.97);
    }
    stat.pools++;
  }

  for (const r of [...layout.roadsX, ...layout.roadsZ]) {
    const P = lanePlan(r);
    const alongX = r.axis !== 'x';       // an x-road's gutter runs along z
    /* The band water is allowed to stand in.
       On the kerb side it stops 0.74 m short of the carriageway edge: the
       gutter pan is a swept concrete channel starting 0.36 m out over the
       asphalt at y = 6-16 mm, so a blob at Y_DAMP lapping onto it both fights
       it on depth and covers the one bright value that makes the kerb read as
       a profile. On the other side it stops clear of the bus-lane bed, which
       wins the depth test against this layer and would slice a puddle in half
       along a dead-straight line. */
    const oOut = r.half - 0.74;
    const oIn = Math.max(0.6, P.bus ? r.half - P.park - 0.25 : oOut - 3.2);
    const halfBand = (oOut - oIn) * 0.5;
    if (halfBand < 0.45) continue;
    for (const [a, b] of tintRuns(r)) {
      if (b - a < 24) continue;
      for (let t = a + 8; t < b - 8; t += 52 + h01(t, r.pos + 3.3) * 74) {
        for (const s of [-1, 1]) {
          if (h01(t * 1.7, r.pos * s + 9.1) > 0.52) continue;
          const along = 1.1 + h01(t + 1.3, s * 2.7) * 2.2;
          const across = Math.min(along * 0.42, halfBand);
          // Drift the centre inside whatever slack the band has left.
          const o = (oIn + oOut) / 2 + (h01(t, s + 4.1) - 0.5) * (halfBand - across) * 1.7;
          const [px, pz] = roadPt(r, s, t, o);
          if (layout.isWater(px, pz)) continue;
          pool(px, pz, along, across, alongX, t * 0.37 + s);
        }
      }
    }
  }

  /* --- crack sealant ----------------------------------------------------- */

  /**
   * One run of sealant. A wandering polyline of quads, because the whole point
   * of the marking is that it is the only line on the road that is NOT
   * straight — everything else out here is paint or a paving joint, and a
   * carriageway with no crooked line on it reads as vinyl.
   */
  function seam(ax, az, dx, dz, len, wobble, seed, col) {
    const nx = -dz, nz = dx;
    /* 1.5 m stations, not 3.2. At 3.2 m a 20 m crack is six near-collinear
       quads and reads as a ruled pencil line drawn across the asphalt — which
       is exactly what it looked like in the gameplay framing. The wander has
       to change direction several times inside one car length before the eye
       accepts it as a crack rather than a stroke. */
    const segs = Math.max(3, Math.round(len / 1.5));
    const hw = 0.055 + h01(seed, 7.3) * 0.055;
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
   * The sealed perimeter of a saw-cut utility repair.
   *
   * Four straight sealant runs with a fresh wobble seed each, so the corners
   * overshoot each other the way a hand-poured seal actually does. This is the
   * cheapest legible detail on the whole carriageway: it turns an invisible
   * tonal rectangle into an unmistakable patch.
   */
  function cutBorder(cx, cz, w, d, seed) {
    const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
    const col = 1.22 + h01(seed, 5.5) * 0.36;
    seam(x0, z0, 1, 0, w, 0.10, seed + 1.1, col);
    seam(x0, z1, 1, 0, w, 0.10, seed + 2.3, col);
    seam(x0, z0, 0, 1, d, 0.10, seed + 3.7, col);
    seam(x1, z0, 0, 1, d, 0.10, seed + 4.9, col);
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
        /* TAR_SEAM is a warm near-black. Multiplied at 0.86 it landed at about
           half the road's value, which from the gameplay camera is a hard black
           line — the loudest thing on an otherwise empty carriageway. Real
           sealant is a band of dull dark brown that has picked up road dust,
           so it wants to sit one step under the asphalt, not five. */
        seam(sx, sz, dAcross[0], dAcross[1], L, 0.85, t * 7.1 + r.pos,
          1.28 + h01(t, 1.1) * 0.42);
      }
      for (const s of [-1, 1]) {
        for (let k = 1; k <= P.lanes; k++) {
          const o = s * (P.inner + k * LANE_W);
          for (let t = a + 4; t < b - 16; t += 46 + h01(t, o) * 110) {
            if (h01(t * 3.1, o) > 0.5) continue;
            const L = Math.min(10 + h01(t, o + 3) * 30, b - t - 3);
            const [sx, sz] = toWorld(t, o + (h01(t, o + 9) - 0.5) * 0.5);
            if (layout.isWater(sx, sz)) continue;
            seam(sx, sz, dAlong[0], dAlong[1], L, 0.42, t * 3.7 + o,
              1.24 + h01(t, 2.6) * 0.42);
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

  /* --- the end of the road ------------------------------------------------ */

  /**
   * WHERE THE CARRIAGEWAY MEETS BISCAYNE BAY.
   *
   * Half the east/west grid runs out of land before it runs out of city, and
   * until now every one of those roads simply stopped: the lane dashes, the bay
   * ticks and the yellow kerb line all ran to the last centimetre of asphalt
   * and vanished. From the waterfront framing that reads as a texture clipped
   * by a mask rather than as a place, and it is the one thing in this module
   * that the bayfront preset is actually looking at.
   *
   * What goes in instead is what a real dead end against a bulkhead carries: a
   * transverse hold line, then a block of diagonal hatch nobody is meant to
   * drive into. Both are authored per DIRECTION rather than across the whole
   * carriageway, so a median (whose own painted nose lives at Y_MARK and is not
   * cut by the shore window) is stepped around rather than overpainted, and so
   * the two halves meet on the centreline instead of crossing it.
   *
   * `paintRuns` has already cleared SHORE_CLEAR metres here, so this block owns
   * every Y_MARK fragment inside it and nothing can tie with it on depth.
   */
  function roadEnd(r, t, dir) {
    const P = lanePlan(r);
    const face = t - dir * 0.7;               // stand off the actual waterline
    const W = 3.0;                            // depth of the hatched block
    const TH = 0.24;                          // stripe half-thickness, along u
    for (const s of [-1, 1]) {
      const o0 = P.inner + 0.2;
      const o1 = Math.max(o0, r.half - 0.95);
      const V = o1 - o0;
      if (V < 1.3) continue;
      /** Road-local (u = metres back from the face, v = metres out from o0). */
      const q = (u, v) => {
        const [x, z] = roadPt(r, s, face - dir * u, o0 + v);
        return [x, Y_MARK, z];
      };
      // 45-degree stripes, clipped analytically to the u/v rectangle so a
      // stripe never overshoots into the kerb line or the centreline.
      for (let c = -V + 0.6; c < W; c += 1.45) {
        const vLo = Math.max(0, -c), vHi = Math.min(V, W - c);
        if (vHi - vLo < 0.45) continue;
        yellow.quadUp(
          q(vLo + c, vLo), q(vHi + c, vHi),
          q(vHi + c + TH, vHi), q(vLo + c + TH, vLo), 0.90
        );
      }
      // The hold line. Set back past the hatch, and full width of the
      // direction: this is the marking that says "stop", and it is the only
      // part of the treatment that still reads from 300 m up.
      white.quadUp(q(W + 0.55, 0), q(W + 0.55, V), q(W + 1.05, V), q(W + 1.05, 0), 1.0);
      stat.roadEnds++;
    }
  }

  for (const r of [...layout.roadsX, ...layout.roadsZ]) {
    for (const e of shoreEnds(r)) roadEnd(r, e.t, e.dir);
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
       overlay, and the polish where every tyre in the city turns.
       The tone alone is worth almost nothing — +-13% albedo on a mottled
       asphalt map is inside the map's own noise, which is why a 40 m junction
       box read as one bare grey field in the gameplay framing. What makes a
       repair read is its EDGE: a utility cut is saw-cut square and then sealed
       all the way round, so it is a rectangle with a dark border. Draw the
       border and a 5% tonal shift is suddenly legible. */
    const jr = makeRNG((ix.id * 2654435761) >>> 0);
    for (let i = 0; i < 4; i++) {
      const w = ix.halfX * (0.28 + jr() * 0.58), d = ix.halfZ * (0.28 + jr() * 0.58);
      const cx = ix.x + (jr() - 0.5) * (ix.halfX * 2 - w);
      const cz = ix.z + (jr() - 0.5) * (ix.halfZ * 2 - d);
      patch.rect(cx - w / 2, cx + w / 2, cz - d / 2, cz + d / 2, Y_PATCH, 0.875 + jr() * 0.26);
      if (jr() < 0.7) cutBorder(cx, cz, w, d, ix.id * 31.7 + i);
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

    /* A junction is the most cut, patched and resealed asphalt in any city.
       Kept SHORT: a crack the full width of the box is a ruled line across the
       one surface the player looks at all game. Three short ones scattered
       read as damage; one long one reads as a scratch on the lens. */
    for (let i = 0; i < 3; i++) {
      const ang = jr() * Math.PI * 2;
      const L = Math.min(ix.halfX, ix.halfZ) * (0.35 + jr() * 0.55);
      const sx = ix.x + (jr() - 0.5) * ix.halfX * 1.5;
      const sz = ix.z + (jr() - 0.5) * ix.halfZ * 1.5;
      seam(sx, sz, Math.cos(ang), Math.sin(ang), L, 0.9, ix.id * 13.7 + i,
        1.26 + jr() * 0.4);
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
    /* Widened from BOULEVARD-only to "the multi-lane road through", which is
       every AVENUE too. An avenue carries the same four lanes a boulevard
       does, and leaving its junctions unguided is what left the default
       gameplay framing looking at forty metres of untouched grey. Streets are
       still excluded: one lane each way has nothing to guide. */
    const guided = rx.cls !== STREET || rz.cls !== STREET;
    if (!boxed && guided) {
      // The road with more lanes owns the box; a tie goes to the wider one.
      const px = lanePlan(rx), pz = lanePlan(rz);
      const useX = px.lanes !== pz.lanes ? px.lanes > pz.lanes : rx.half >= rz.half;
      const major = useX ? rx : rz;
      const P = useX ? px : pz;
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

    /* Ironwork. Every service in the city crosses here, so a junction carries
       far more lids than a mid-block run — and a scatter of hard dark discs is
       most of what stops the box reading as a poured slab. */
    const nLid = 2 + (jr() < 0.6 ? 1 : 0);
    for (let i = 0; i < nLid; i++) {
      manhole(
        ix.x + (jr() - 0.5) * ix.halfX * 1.55,
        ix.z + (jr() - 0.5) * ix.halfZ * 1.55,
        0.52 + jr() * 0.20, jr() * 6.28
      );
    }
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        /* A gully grate is laid ALONG the gutter it drains, and the gutter
           runs the way its own road runs. rx is the north/south road (constant
           x, travelling in z) so a grate in its channel is long in z; rz is
           east/west, so its grates are long in x. These two were swapped, and
           one of them was picked by a `sx > 0 ? 'x' : 'x'` that could only ever
           return one answer. */
        gully(ix.x + sx * (ix.halfX - 0.5), ix.z + sz * (ix.halfZ + 2.2), 'z');
        gully(ix.x + sx * (ix.halfX + 2.2), ix.z + sz * (ix.halfZ - 0.5), 'x');
        // A drawpit beside each gully — the chamber the gully actually drains
        // into. Small, square, and never the same size as its neighbour.
        // Set back past the zebra AND the hold line: the ironwork layer wins
        // the depth test against paint, so a lid dropped inside the crossing
        // would punch a grey hole through a zebra bar.
        if (jr() < 0.5) {
          vaultLid(ix.x + sx * (ix.halfX - 0.6), ix.z + sz * (ix.halfZ + 6.2 + jr() * 2),
            0.32 + jr() * 0.14, false, Y_IRON);
        }
      }
    }

    // Turn arrows in every approach lane.
    for (const s of [-1, 1]) {
      if (freeGap(layout.roadsZ, ix.rj, s) > NEED_STOP + 8) approachArrows(rx, rz, s, 'x');
      if (freeGap(layout.roadsX, ix.ri, s) > NEED_STOP + 8) approachArrows(rz, rx, s, 'z');
    }
  }

  /**
   * Which marking goes in this crossing's corridor. Hashed off the two road
   * positions, so it is stable across rebuilds and the four legs of one
   * junction do not all draw the same answer.
   */
  function xwalkStyle(r, cross) {
    const h = h01(r.pos * 1.7 + 4.3, cross * 0.83);
    if (r.cls === STREET) {
      if (h < 0.26) return XWALK.CONTINENTAL;
      if (h < 0.38) return XWALK.LADDER;
      if (h < 0.74) return XWALK.TRANSVERSE;
      return XWALK.DASHED;
    }
    // Arterials: high-visibility markings, because that is what they carry.
    if (h < 0.54) return XWALK.CONTINENTAL;
    if (h < 0.90) return XWALK.LADDER;
    return XWALK.TRANSVERSE;
  }

  /**
   * A pedestrian crossing across a carriageway. `axis` = the axis the road
   * runs on; `p` below is measured ACROSS the carriageway (the direction the
   * pedestrian walks) and `c` along the corridor.
   *
   * Every bar is toned by how close it sits to a WHEEL TRACK. Tyres scrub paint
   * off in two ribbons per lane and nowhere else, so a crossing worn evenly
   * across its whole width is the tell that it was stamped rather than driven
   * over. The tracks here are the same +-0.86 m off each lane centre that the
   * asphalt polish pass uses, so the wear in the paint lines up with the sheen
   * in the road on either side of it.
   *
   * NOTHING HERE MAY OVERLAP ANYTHING ELSE PAINTED AT Y_MARK. The white and
   * yellow marking meshes share a y and a polygon offset, so an overlap is a
   * guaranteed z-fight rather than a layering decision — which is why the rungs
   * of a ladder stop exactly on the inner face of its rails instead of running
   * under them, and why a median road leaves the island footprint unpainted.
   */
  function zebra(r, cross, axis) {
    const lo = r.pos - r.half, hi = r.pos + r.half;
    const P = lanePlan(r);
    const style = xwalkStyle(r, cross);
    stat.xwalk[style]++;
    const hh = h01(cross * 1.31 + 2.7, r.pos * 0.57);

    /* Crossings are repainted one at a time on whatever cycle the district is
       on, so a junction with four of them has four different amounts of paint
       left. This single multiplier is most of what stops a row of crossings
       reading as one stamp repeated. */
    const age = 0.72 + hh * 0.28;

    const put = (p0, p1, c0, c1, col) => {
      if (p1 - p0 < 1e-3) return;
      if (axis === 'x') white.rect(p0, p1, c0, c1, Y_MARK, col);
      else white.rect(c0, c1, p0, p1, Y_MARK, col);
      stat.crossBars++;
    };

    /* The raised island, if this road has one. At the crossing the island is
       already tapered away — medians stop CROSS_GAP + CROSS_W + 1.6 short of a
       junction — but the painted nose that replaces it lives at Y_MARK in the
       yellow mesh, so paint here would fight it. Leaving the gap is also simply
       what a crossing with a refuge looks like. */
    const gapHalf = r.median ? r.medianW * 0.5 + 0.45 : 0;

    /** Emit across the carriageway, split around the refuge. */
    const span2 = (p0, p1, c0, c1, colAt) => {
      const runs = gapHalf > 0
        ? cut([[p0, p1]], r.pos - gapHalf, r.pos + gapHalf)
        : [[p0, p1]];
      for (const [a, b] of runs) if (b - a > 0.15) put(a, b, c0, c1, colAt(a, b));
    };

    /** Tyre-track wear at a point across the carriageway. */
    const wearAt = (p) => {
      const off = Math.abs(p - r.pos);
      let d = 9;
      if (off > P.inner) {
        const k = Math.floor((off - P.inner) / LANE_W);
        const lc = P.inner + (k + 0.5) * LANE_W;
        d = Math.min(Math.abs(off - (lc - 0.86)), Math.abs(off - (lc + 0.86)));
      }
      return 0.70 + 0.30 * Math.min(1, d / 0.62);
    };

    const cw = CROSS_W - 0.22;                 // paint stops short of the corridor
    const eLo = cross - cw / 2, eHi = cross + cw / 2;
    const ew = style === XWALK.LADDER ? 0.15 : 0.21;
    const a0 = lo + 0.55, a1 = hi - 0.55;

    if (style !== XWALK.CONTINENTAL) {
      for (const e of [eLo + ew, eHi - ew]) {
        if (style === XWALK.DASHED) {
          /* A transverse crossing laid in dashes: the cheapest marking there
             is, and the one a quiet residential crossroads actually gets.
             Long stride, long dash — a 1.5 m rhythm over a 24 m carriageway is
             fifty little rectangles per line, which is the defect the whole
             pass exists to remove rather than a cure for it. */
          for (let t = a0; t < a1 - 0.9; t += 2.15) {
            span2(t, Math.min(t + 1.2, a1), e - ew, e + ew,
              (p) => age * wearAt(p) * fade(p, e));
          }
        } else {
          span2(a0, a1, e - ew, e + ew, () => age * 0.95);
        }
      }
    }
    if (style === XWALK.TRANSVERSE || style === XWALK.DASHED) return;

    /* Bars. Pitch and width both drift per crossing — two crossings on opposite
       arms of one junction laid at the identical rhythm is exactly the beat the
       eye locks on to. A ladder's rungs abut the inner face of its rails. */
    const pitch = BAR_PITCH * (0.90 + hh * 0.30);
    const bw = BAR_W * (0.84 + h01(cross * 2.9, r.pos * 1.13 + 5.1) * 0.42);
    const c0 = style === XWALK.LADDER ? eLo + ew * 2 : eLo;
    const c1 = style === XWALK.LADDER ? eHi - ew * 2 : eHi;
    const n = Math.max(3, Math.floor((hi - lo - 1.4) / pitch));
    const start = (lo + hi) / 2 - (n - 1) * pitch / 2;
    for (let i = 0; i < n; i++) {
      const p = start + i * pitch;
      span2(p - bw / 2, p + bw / 2, c0, c1, () => age * wearAt(p) * fade(p, cross));
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
      /* THE BARB HAS TO FIT INSIDE ITS OWN LANE. It used to reach 2.05 m off
         the lane centre, and a lane is 3.4 m wide — so the left-turn arrow in
         lane 0 crossed the thing on its left, which is either the double-yellow
         centreline (a coplanar overlap between the white and yellow marking
         meshes, both at Y_MARK with the same polygon offset: a z-fight) or the
         raised median kerb, which simply swallowed the tip. 1.58 keeps the
         whole glyph inside LANE_W/2 = 1.7 with a 12 cm margin, and at the size
         this is actually seen the arrow reads no differently. */
      const sg = kind === 'left' ? 1 : -1;
      poly([[0.52, sg * 0.22], [1.0, sg * 0.22], [1.0, sg * 0.92], [0.52, sg * 0.92]]);
      poly([[0.26, sg * 0.92], [1.26, sg * 0.92], [0.76, sg * 1.58]]);
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
    // The two side strips stop at the top and bottom ones. Running all four
    // corner-to-corner double-covers each corner square inside one mesh at one
    // y — four little z-fights per box, on the surface the camera looks at all
    // game.
    yellow.rect(x0, x1, z0, z0 + w, Y_MARK, 1.0);
    yellow.rect(x0, x1, z1 - w, z1, Y_MARK, 1.0);
    yellow.rect(x0, x0 + w, z0 + w, z1 - w, Y_MARK, 1.0);
    yellow.rect(x1 - w, x1, z0 + w, z1 - w, Y_MARK, 1.0);
    /* 45-degree hatch: clip the line x - z = k against the box analytically.
       ONE diagonal family only. A true box junction is cross-hatched, but the
       two families would cross inside a single mesh at a single y with a single
       polygon offset, and every one of those ~25 intersections per box is a
       guaranteed z-fight — the art bible's automatic failure, bought for a
       detail nobody can resolve from the game camera anyway.
       Pitch 5.2, not 9: at 9 m a 40 m box carried four lines so long and so far
       apart that they read as loose yellow streaks lying on the asphalt rather
       than as a hatch. Denser, thinner and dimmer is what turns them back into
       one marking, and it is still nowhere near the wall of yellow a
       full-density London box would be. */
    // Clipped INSIDE the border, not to the box: a diagonal that runs out onto
    // the 0.22 m border strip is the same coplanar overlap in the same mesh.
    const hw = 0.085;
    const ix0 = x0 + w + hw * 1.5, ix1 = x1 - w - hw * 1.5;
    const iz0 = z0 + w + hw * 1.5, iz1 = z1 - w - hw * 1.5;
    const kMin = ix0 - iz1, kMax = ix1 - iz0;
    for (let k = kMin; k < kMax; k += 5.2) {
      const ax = Math.max(ix0, k + iz0), az = ax - k;
      const bx = Math.min(ix1, k + iz1), bz = bx - k;
      if (bx - ax < 0.4) continue;
      yellow.quadUp(
        [ax + hw, Y_MARK, az - hw], [bx + hw, Y_MARK, bz - hw],
        [bx - hw, Y_MARK, bz + hw], [ax - hw, Y_MARK, az + hw], 0.68
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

    /* ...and a fourth, which is the one that actually kills the period: the
       block's own UV PHASE. Tone and joint pitch vary what the paving looks
       like; they cannot move where its 4.8 m repeat lands, so every block in
       the city still broke joint at the same world coordinates and a long
       frontage still had a countable beat. Blocks never touch — there is a
       carriageway between any two of them — so each can be given an arbitrary
       phase, and every fourth one can have its courses turned through 90 deg,
       for the cost of two floats.

       Phased off the block seed directly rather than off `bs`: drawing from
       that generator here would shift every crossover, service patch and
       loading kerb in the city, and those placements are already tuned. */
    walk.uOff = h01(b.seed * 0.017, 3.1) * 4.8;
    walk.vOff = h01(b.seed * 0.023, 7.9) * 4.8;
    walk.uvSwap = h01(b.seed * 0.031, 1.7) < 0.42;

    /* Interior slab (building pad / plaza floor), laid in BAYS rather than as
       one quad. Where a building covers it this is invisible; where it does
       not — a setback, a forecourt, a plaza — it was the largest single flat
       colour anywhere in the game, tens of metres of one exact value. Real
       paving of that size is poured or laid in bays with a movement joint
       between them, and a few percent of tone between bays is enough to give
       the eye something to hold on to. */
    {
      const px0 = x0 + sw, px1 = x1 - sw, pz0 = z0 + sw, pz1 = z1 - sw;
      const BAY = 9.0;
      const nx = Math.max(1, Math.round((px1 - px0) / BAY));
      const nz = Math.max(1, Math.round((pz1 - pz0) / BAY));
      const dx = (px1 - px0) / nx, dz = (pz1 - pz0) / nz;
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < nz; j++) {
          walk.rect(px0 + i * dx, px0 + (i + 1) * dx, pz0 + j * dz, pz0 + (j + 1) * dz,
            Y_WALK, tone * (0.955 + h01(b.seed + i * 3.7, j * 5.3) * 0.062));
        }
      }
    }

    const edges = [
      { key: 'n', road: b.edges.n, len: b.w, corner0: [x0, z0], corner1: [x1, z0] },
      { key: 'e', road: b.edges.e, len: b.d, corner0: [x1, z0], corner1: [x1, z1] },
      { key: 's', road: b.edges.s, len: b.w, corner0: [x1, z1], corner1: [x0, z1] },
      { key: 'w', road: b.edges.w, len: b.d, corner0: [x0, z1], corner1: [x0, z0] },
    ];

    /* --------------------------------------------------- KERB RADII -----
     * A city block whose kerb turns a razor 90 degrees at every junction is
     * the loudest single "this grid was generated" tell there is, and it is
     * also just wrong: no carriageway anywhere can be driven round a square
     * corner. Every real junction has a kerb radius, and at the game's camera
     * that curve is the difference between a street corner and a floor tile.
     *
     * THE RADIUS IS THE SIDEWALK WIDTH, and that is a structural choice rather
     * than a taste one. The sweep's innermost profile station sits at o = sw,
     * and the interior slab is a rectangle inset by exactly sw — so with
     * R = sw the corner arc's radius at that station is zero and it lands on
     * the slab's own corner. The two tile perfectly, with no gap to patch and
     * no overlap to z-fight, and every band outboard of it comes out as a
     * quarter annulus for free. Any other radius needs a corner cap.
     *
     * Only at genuine junction corners (both axes meet a road) and only where
     * both edges are long enough to carry two radii plus a straight run.
     */
    const corners = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
    const roundAt = corners.map(([cx, cz]) => (
      nearRoadX(cx) && nearRoadZ(cz)
      && b.w >= sw * 2.6 && b.d >= sw * 2.6 ? sw : 0
    ));
    // edges[i] runs corners[i] -> corners[(i+1)%4], in that order.
    for (let i = 0; i < 4; i++) {
      edges[i].r0 = roundAt[i];
      edges[i].r1 = roundAt[(i + 1) % 4];
    }
    /* The land the radius gave back to the carriageway. Paved as ROAD, because
     * that is what the inside of a kerb radius is — the apron every turning
     * vehicle actually drives over. Emitted from the square corner outward, so
     * it abuts the junction box on both legs without overlapping it.
     *
     * Fanned by hand rather than through polyY: the region is a square with a
     * CONCAVE arc bitten out of it, so it is star-shaped about the square
     * corner and about nothing else — and polyY reverses its point list
     * whenever the winding comes out clockwise, which is half of the four
     * corners, and that quietly moves the fan origin onto the arc where the
     * triangles fold back through the void they are supposed to be filling.
     * triUp fixes the origin at the corner and settles the facing per triangle. */
    for (let i = 0; i < 4; i++) {
      const R = roundAt[i];
      if (!R) continue;
      const [cx, cz] = corners[i];
      // Inward sign on each axis for this corner of the block.
      const sx = (i === 0 || i === 3) ? 1 : -1;
      const sz = (i === 0 || i === 1) ? 1 : -1;
      const arc = (k) => {
        const a = (k / 7) * Math.PI * 0.5;
        return [cx + sx * R * (1 - Math.cos(a)), Y_ROAD, cz + sz * R * (1 - Math.sin(a))];
      };
      const C = [cx, Y_ROAD, cz];
      for (let k = 0; k < 7; k++) road.triUp(C, arc(k), arc(k + 1), 1.0);
      // Claim it: streets.js runs first, and nothing else knows this corner of
      // the block stopped being footway.
      ctx.occupy(cx + sx * R * 0.42, cz + sz * R * 0.42, R * 0.62);
    }

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

      /* Stations along the corner arcs. Without them the radius is drawn as one
         chord between s=0 and whatever the next station happens to be, which is
         a chamfer rather than a curve. They are inserted AFTER the sort and
         carry the drop `d` interpolated from the run they land in: a kerb ramp
         occupies 1.2-4.9 m from the corner, which is squarely inside the arc,
         and a d=0 station dropped into the middle of that window would stand
         the kerb back up halfway down its own ramp. */
      if (e.r0 || e.r1) {
        const dAt = (ss) => {
          for (let i = 0; i < stations.length - 1; i++) {
            const p = stations[i], q = stations[i + 1];
            if (ss >= p.s && ss <= q.s) {
              const span = q.s - p.s;
              return span < 1e-6 ? q.d : p.d + (q.d - p.d) * ((ss - p.s) / span);
            }
          }
          return 0;
        };
        const arcStations = [];
        for (const [R, base, dir] of [[e.r0, 0, 1], [e.r1, e.len, -1]]) {
          if (!R) continue;
          for (let k = 1; k < 5; k++) {
            const ss = base + dir * (R * k) / 5;
            arcStations.push({ s: ss, d: dAt(ss) });
          }
        }
        for (const st of arcStations) stations.push(st);
        stations.sort((p, q) => p.s - q.s);
      }

      sweepEdge(e, stations, sw, tone, bandTone, x0, x1, z0, z1);

      const holes = [];
      for (const [a, c] of windows) holes.push([a - RAMP_FLARE, c + RAMP_FLARE]);
      for (const [a, c] of xo) holes.push([a - XOVER_FLARE, c + XOVER_FLARE]);
      holesFor.push({ e, holes });
      const clear = (s0, s1) => !holes.some(([a, c]) => s1 > a && s0 < c);

      // Detectable warning surface at the head of every kerb ramp.
      for (const [a, c] of windows) tactilePad(e, a, c, tactileCol, x0, x1, z0, z1);
      // Driveway apron + the yellow across the dropped kerb. A parking block's
      // crossover is a structure ramp and gets threshold markings instead of
      // the domestic saw-cut joints.
      for (const [a, c] of xo) {
        crossover(e, a, c, sw, x0, x1, z0, z1, b.zone === ZONE.PARKING);
      }

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
      // The dropped-kerb windows this edge already carries. An inlet cut into
      // a kerb that is not there would hang in the air over a ramp.
      const dropped = (holesFor.find((h) => h.e === e) || { holes: [] }).holes;
      const n = Math.max(1, Math.floor(e.len / 26));
      for (let i = 0; i < n; i++) {
        const s = (i + 0.5) * (e.len / n) + (br() - 0.5) * 5;
        const [gx, gz] = edgePoint(e, s, -0.2, x0, x1, z0, z1);
        gully(gx, gz, e.key === 'n' || e.key === 's' ? 'x' : 'z');
        if (!dropped.some(([ha, hc]) => s > ha - 0.5 && s < hc + 0.5)) {
          kerbInlet(e, s, x0, x1, z0, z1);
        }
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

    // The sweep and every flat thing hung off it are done; hand the mesh back
    // in its default phase so the medians below are not laid at this block's.
    walk.uOff = 0; walk.vOff = 0; walk.uvSwap = false;
  }

  /**
   * The mouth of a kerb inlet: the opening cut through the kerb face where the
   * gutter actually drains.
   *
   * This is the only hole in a kilometre of kerb, and from street level it is
   * what proves the kerb is a PROFILE and not a painted strip — the grate in
   * the channel alone reads as a decal lying next to a ramp. It is a quad
   * standing 18 mm proud of the real face so it can never tie with it on
   * depth; the winding below yields an outward normal on all four block edges
   * (checked against each: n/e/s/w), which matters because getting it backwards
   * back-face-culls the whole thing into invisibility rather than erroring.
   */
  function kerbInlet(e, s, x0, x1, z0, z1) {
    const HW = 0.31, PROUD = 0.018;
    const s0 = Math.max(0.6, s - HW), s1 = Math.min(e.len - 0.6, s + HW);
    if (s1 - s0 < 0.2) return;
    const p = (ss, oo) => edgePoint(e, ss, oo, x0, x1, z0, z1);
    const oLo = PROFILE[2].o - PROUD, oHi = PROFILE[4].o - PROUD;
    const yLo = PROFILE[2].y + 0.014, yHi = PROFILE[4].y - 0.020;
    const A = p(s0, oLo), B = p(s0, oHi), C = p(s1, oHi), D = p(s1, oLo);
    flat.quad([A[0], yLo, A[1]], [B[0], yHi, B[1]],
      [C[0], yHi, C[1]], [D[0], yLo, D[1]], C_INLET, true);
    stat.inlets++;
  }

  /**
   * World point on a block edge at distance `s` from corner0, inset `o`.
   *
   * ARC-AWARE. Where the block carries a kerb radius (`e.r0` / `e.r1`, set in
   * the block loop) the first and last R metres of the run bend round a quarter
   * circle instead of running into the mitre. Doing it HERE rather than in the
   * sweep is what makes the radius free: every ramp, tactile pad, service
   * patch, expansion joint, gully, crossover and planting strip is already
   * authored in this (s, o) frame, so all of them follow the curve without
   * knowing it exists — which is also the only way they stay on the pavement.
   *
   * Each edge owns half of its corner's 90 degrees and hands over on the 45
   * degree bisector, exactly where the old mitre met, so the two runs join with
   * no seam whichever neighbour is rounded.
   */
  function edgePoint(e, s, o, x0, x1, z0, z1) {
    let ox, oz, ux, uz, vx, vz;
    switch (e.key) {
      case 'n': ox = x0; oz = z0; ux = 1; uz = 0; vx = 0; vz = 1; break;
      case 'e': ox = x1; oz = z0; ux = 0; uz = 1; vx = -1; vz = 0; break;
      case 's': ox = x1; oz = z1; ux = -1; uz = 0; vx = 0; vz = -1; break;
      default: ox = x0; oz = z1; ux = 0; uz = -1; vx = 1; vz = 0; break;
    }
    const r0 = e.r0 || 0, r1 = e.r1 || 0;
    if (r0 > 0 && s < r0) {
      const rad = Math.max(0, r0 - o);
      const a = (1 - s / r0) * Math.PI * 0.25;
      const ca = Math.cos(a), sa = Math.sin(a);
      return [
        ox + (ux + vx) * r0 - (vx * ca + ux * sa) * rad,
        oz + (uz + vz) * r0 - (vz * ca + uz * sa) * rad,
      ];
    }
    if (r1 > 0 && s > e.len - r1) {
      const rad = Math.max(0, r1 - o);
      const a = ((s - (e.len - r1)) / r1) * Math.PI * 0.25;
      const ca = Math.cos(a), sa = Math.sin(a);
      return [
        ox + ux * (e.len - r1) + vx * r1 + (ux * sa - vx * ca) * rad,
        oz + uz * (e.len - r1) + vz * r1 + (uz * sa - vz * ca) * rad,
      ];
    }
    return [ox + ux * s + vx * o, oz + uz * s + vz * o];
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
      // A ROUNDED end needs no clamp — edgePoint bends the run onto the arc and
      // shrinks its radius with `o`, which is the same convergence expressed as
      // a curve. Clamping as well would flatten the first R metres of it.
      const lo = e.r0 > 0 ? 0 : o;
      const hi = e.r1 > 0 ? e.len : Math.max(o, e.len - o);
      const s = Math.min(Math.max(st.s, lo), Math.max(lo, hi));
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
    /* Blisters read DARKER on a bright pad (they are little shadow traps) and
       LIGHTER on a dark one (they are the only part of a cast plate the sun
       actually reaches). Keying off the pad's own value means the same code
       gives both, instead of the iron plate coming out as a black square with
       blacker dots on it. */
    const lum = col[0] * 0.30 + col[1] * 0.59 + col[2] * 0.11;
    const k = lum > 0.22 ? 0.62 : 1.85;
    const dot = [col[0] * k, col[1] * k, col[2] * k];
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
  function crossover(e, a, c, sw, x0, x1, z0, z1, garage) {
    const o0 = 1.90, o1 = Math.max(o0 + 0.7, sw);
    const y = Y_WALK + 0.005;
    const p = (ss, oo) => edgePoint(e, ss, oo, x0, x1, z0, z1);
    const A = p(a, o0), B = p(c, o0), C = p(c, o1), D = p(a, o1);
    flat.quadUp([A[0], y, A[1]], [B[0], y, B[1]],
      [C[0], y, C[1]], [D[0], y, D[1]], C_APRON);
    // A garage ramp gets threshold markings instead: they land in the same
    // stretch of apron the joints would, in the same mesh at the same y, so it
    // has to be one or the other.
    if (!garage) {
      for (const f of [1 / 3, 2 / 3]) {
        const ss = a + (c - a) * f;
        const j0 = p(ss - 0.04, o0), j1 = p(ss + 0.04, o0);
        const j2 = p(ss + 0.04, o1), j3 = p(ss - 0.04, o1);
        const jy = y + 0.003;
        white.quadUp([j0[0], jy, j0[1]], [j1[0], jy, j1[1]],
          [j2[0], jy, j2[1]], [j3[0], jy, j3[1]], 0.44);
      }
    } else {
      garageThreshold(p, a, c, o0, o1, y + 0.004);
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

  /**
   * THRESHOLD MARKINGS AT A PARKING-STRUCTURE ENTRANCE.
   *
   * A garage ramp is not a wide driveway, it is signed — and from the game's
   * 3/4 camera the signage is the only thing that distinguishes it. Without
   * these a 7.4 m dropped kerb in a 60 m frontage just reads as a missing piece
   * of pavement, which is worse than having no entrance at all.
   *
   * Three marks, all of which survive being a dozen pixels wide: a yellow bar
   * at the building line (the threshold every garage in Miami has painted
   * across it), a divider down the middle, and one chevron per half pointing
   * the way that half runs. Everything is authored in the edge's (s, o) frame
   * and laid strictly inside the apron, so nothing here can overlap the kerb
   * paint below it or the trench drain in front of it.
   */
  function garageThreshold(p, a, c, o0, o1, y) {
    const wide = c - a >= 5.0;
    const deep = o1 - o0 >= 1.9;
    if (!wide) return;
    const mid = (a + c) / 2;

    const bar = (s0, s1, oa, ob, surf, col) => {
      const A = p(s0, oa), B = p(s1, oa), C = p(s1, ob), D = p(s0, ob);
      surf.quadUp([A[0], y, A[1]], [B[0], y, B[1]], [C[0], y, C[1]], [D[0], y, D[1]], col);
    };

    bar(a + 0.35, c - 0.35, o1 - 0.42, o1 - 0.06, yellow, 1.0);
    if (!deep) return;
    bar(mid - 0.09, mid + 0.09, o0 + 0.18, o1 - 0.52, white, 0.90);

    // Tip toward the building for the entry half, toward the street for the
    // exit half. Kept clear of both the divider and the threshold bar.
    const half = Math.min(0.66, (c - a) * 0.15);
    const runL = Math.min(1.0, (o1 - o0) * 0.42);
    for (const sg of [-1, 1]) {
      const cx = mid + sg * (c - a) * 0.25;
      const tip = sg < 0 ? o1 - 0.62 : o0 + 0.34;
      const back = sg < 0 ? tip - runL : tip + runL;
      white.polyY([p(cx, tip), p(cx - half, back), p(cx + half, back)], y, 0.90);
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

  /**
   * Cast-iron manhole.
   *
   * The value is the entire point. ROOF_TAR at a 1.0 multiplier is the same
   * luminance as the asphalt around it, so the old lid was invisible in the
   * one frame the game is actually played in — a dark disc you could only find
   * if you knew where to look. Iron in a road is genuinely much darker than
   * the wearing course, and the frame it sits in is a bright ring of fresh
   * bedding mortar. Dark centre, bright collar: two hard value steps in
   * 60 cm, which is what survives being twelve pixels across.
   */
  function manhole(x, z, r, seed = 0) {
    const n = 12;
    const ring = (rad, y, col) => {
      const pts = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + seed;
        pts.push([x + Math.cos(a) * rad, z + Math.sin(a) * rad]);
      }
      iron.polyY(pts, y, col);
    };
    ring(r * 1.24, Y_IRON, 1.32);            // bedding collar, bright
    ring(r, Y_IRON + 0.002, 0.48);           // the lid itself, dark iron
    ring(r * 0.66, Y_IRON + 0.004, 0.62);    // cast centre boss
    // Two pick holes. Tiny, but they are what stops the lid reading as a dot.
    for (const s of [-1, 1]) {
      const a = seed + 0.7;
      const px = x + Math.cos(a) * r * 0.40 * s, pz = z + Math.sin(a) * r * 0.40 * s;
      iron.rect(px - 0.055, px + 0.055, pz - 0.055, pz + 0.055, Y_IRON + 0.006, 0.30);
    }
    stat.manholes++;
  }

  /**
   * Kerb-inlet grate. `axis` is the direction the GUTTER runs, which is the
   * direction the grate is long in — a grate laid across its own channel would
   * be a kerb you cannot drain past.
   *
   * Five bars, not three: at 0.72 m long the bar pitch is what identifies the
   * object at a glance, and three bars over a 0.38 m width reads as a smudge.
   */
  function gully(x, z, axis) {
    const alongX = axis === 'x';
    const w = alongX ? 0.78 : 0.40;
    const d = alongX ? 0.40 : 0.78;
    iron.rect(x - w / 2, x + w / 2, z - d / 2, z + d / 2, Y_IRON, 0.86);   // frame
    iron.rect(x - w / 2 + 0.05, x + w / 2 - 0.05, z - d / 2 + 0.05, z + d / 2 - 0.05,
      Y_IRON + 0.002, 0.34);                                              // the void
    for (let i = -2; i <= 2; i++) {
      const o = i * 0.135;
      if (alongX) {
        iron.rect(x + o - 0.028, x + o + 0.028, z - d / 2 + 0.05, z + d / 2 - 0.05,
          Y_IRON + 0.004, 0.74);
      } else {
        iron.rect(x - w / 2 + 0.05, x + w / 2 - 0.05, z + o - 0.028, z + o + 0.028,
          Y_IRON + 0.004, 0.74);
      }
    }
  }

  /** Rectangular access cover with a raised frame and a cast diamond field. */
  function serviceLid(x, z, alongX) {
    const w = alongX ? 0.92 : 0.58;
    const d = alongX ? 0.58 : 0.92;
    const y = Y_WALK + 0.006;
    iron.rect(x - w / 2, x + w / 2, z - d / 2, z + d / 2, y, 0.70);
    iron.rect(x - w / 2 + 0.08, x + w / 2 - 0.08, z - d / 2 + 0.08, z + d / 2 - 0.08,
      y + 0.002, 0.92);
    // Two lifting keyways, which is what says "lid" rather than "grey rectangle".
    for (const s of [-1, 1]) {
      const kx = alongX ? x + s * (w / 2 - 0.14) : x;
      const kz = alongX ? z : z + s * (d / 2 - 0.14);
      iron.rect(kx - 0.06, kx + 0.06, kz - 0.06, kz + 0.06, y + 0.004, 0.52);
    }
  }

  /**
   * Square draw-pit lid with cast ribs across it — telecoms, power.
   * `y` defaults to the footway but the junction pass drops them in the road,
   * where the same albedo would vanish into the asphalt, so the tone is keyed
   * off the surface it lands on.
   */
  function vaultLid(x, z, r, alongX, y = Y_WALK + 0.006) {
    const w = alongX ? r : r * 0.78;
    const d = alongX ? r * 0.78 : r;
    const k = y < Y_WALK ? 0.62 : 1.0;
    iron.rect(x - w, x + w, z - d, z + d, y, 0.72 * k);
    iron.rect(x - w + 0.07, x + w - 0.07, z - d + 0.07, z + d - 0.07, y + 0.002, 0.90 * k);
    for (const o of [-0.5, 0.5]) {
      if (alongX) {
        const cz = z + o * (d - 0.14) * 0.7;
        iron.rect(x - w + 0.07, x + w - 0.07, cz - 0.03, cz + 0.03, y + 0.004, 0.58 * k);
      } else {
        const cx = x + o * (w - 0.14) * 0.7;
        iron.rect(cx - 0.03, cx + 0.03, z - d + 0.07, z + d - 0.07, y + 0.004, 0.58 * k);
      }
    }
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
   * Piers are NOT built here: water.js owns everything standing in the channel
   * and builds them (buildBridgePiers), sized against the water surface height
   * it also owns. Both files used to claim the OTHER one did it, so for a while
   * nothing did and four crossings spanned open water on nothing.
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
  /**
   * ROAD RELIEF IS DELIBERATELY HELD DOWN, and it is the single biggest thing
   * separating "asphalt" from "gravel lot" in the gameplay frame.
   *
   * The asphalt map ships at normalScale 0.92 over an 18 cm chip band. At the
   * default hole-small framing one chip is five or six screen pixels, so at
   * full strength every one of them gets its own lit face and its own shadow
   * and the carriageway renders as loose crushed stone — measured on the
   * baseline frame, the wearing course had more local contrast than the
   * pastel facades above it. A wearing course seen from 45 m is not a field of
   * pebbles; it is a near-flat plane whose stone you infer from a slight
   * sparkle. Pulled to a third, the relief still catches the low sun along the
   * kerb (which is where it is legible) and stops competing with the paint.
   *
   * The roughness companion is untouched: gloss variation is the part of
   * "aggregate" that survives distance without turning into noise.
   */
  const ROAD_RELIEF = new THREE.Vector2(0.32, 0.32);
  const matRoad = layer({
    map: asphaltMap, normalMap: asphaltNormal, normalScale: ROAD_RELIEF,
    roughness: 1.0, name: 'streets-road',
  }, 1);
  const matPatch = layer({
    map: asphaltMap, normalMap: asphaltNormal, normalScale: ROAD_RELIEF,
    roughness: 1.0, vertexColors: true, name: 'streets-wear',
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

  /**
   * Tyre polish. Same albedo and same relief as the road — the only thing that
   * makes a wheel track visible is that it is smoother, so nearly all of the
   * separation is in ROUGHNESS rather than in the vertex tone. Its polygon
   * offset sits between the repair panels it crosses and the damp that lies on
   * top of it; see the note on the `polish` mesh for why it cannot share one.
   */
  const matPolish = layer({
    map: asphaltMap, normalMap: asphaltNormal,
    // Two thirds of the road's relief: a polished wheel path has had its
    // exposed aggregate worn flat, which is exactly what makes it catch light.
    normalScale: new THREE.Vector2(0.20, 0.20),
    roughness: 0.92, vertexColors: true, name: 'streets-polish',
  }, 2.2);
  addMesh(group, polish, matPolish, 'road-polish');

  /**
   * Standing damp. Same albedo and same relief as the road it lies on — the
   * ONLY thing that separates it is roughness, which is exactly what separates
   * a wet patch of asphalt from a dry one in reality. In daylight it is a
   * slightly darker, slightly sharper stain in the channel; the night driver
   * takes it most of the way to a mirror.
   */
  const matDamp = layer({
    map: asphaltMap,
    normalMap: asphaltNormal,
    // Half the relief of the dry road: water fills the surface texture in, and
    // flattening the normal is most of what makes the eye call it wet.
    normalScale: new THREE.Vector2(0.45, 0.45),
    roughness: 0.86, vertexColors: true, name: 'streets-damp',
  }, 2.5);
  addMesh(group, damp, matDamp, 'road-damp');

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
  /* Desaturating toward the asphalt was the wrong axis, and two passes of it
     did not fix the complaint. Measured off the street-level frame, the bed at
     lerp 0.27 rendered BRIGHTER than the carriageway either side of it — the
     linear mix nearly doubles the red channel — and a warm band that is lighter
     than the road, laid immediately against a bone footway, is the definition
     of brick paving. What separates a painted lane bed from pavers is not how
     red it is, it is that paint on a road is DARKER than the road. So the hue
     goes back up and the value comes down: at 0.30 x 0.74 the bed is
     unmistakably a red bus lane and ~15% darker than the asphalt, which also
     buys the kerb line beside it a value step it did not have. */
  const busColor = new THREE.Color(PALETTE.ASPHALT)
    .lerp(new THREE.Color(PALETTE.TERRACOTTA), 0.30)
    .multiplyScalar(0.74);
  const matBus = layer({
    color: busColor,
    normalMap: asphaltNormal,
    // Same reasoning as ROAD_RELIEF, and more so: a painted lane bed is
    // sealed, so it is genuinely SMOOTHER than the road either side of it.
    normalScale: new THREE.Vector2(0.26, 0.26),
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

  /* HOLE-CUT ON THE HEDGE, and it is not decoration.
     The median hedge is one long mesh standing on the median. When a hole eats
     Brickell Ave the ground under it goes and the hedge — a `solid()` material,
     never patched — stayed hanging in the air over the void. Everything at
     ground level in this file has to be cut, whether or not it is flat. Named
     so `solid()`'s parameter cache cannot hand this patched instance to
     nature.js, which asks for the same hedge colour. */
  const hedgeMesh = addMesh(group, hedge, applyHoleCut(solid({
    color: PALETTE.HEDGE, roughness: 0.9, vertexColors: true, name: 'streets-hedge',
  })), 'median-hedge');
  if (hedgeMesh) hedgeMesh.castShadow = true;

  const structMesh = addMesh(group, struct, ground({
    map: Textures.concrete(512, PALETTE.PRECAST), roughness: 0.92, vertexColors: true,
  }), 'bridges-bulkheads');
  if (structMesh) structMesh.castShadow = true;

  // Same reasoning as the hedge: a hole that reaches the deck must take the
  // standards with it rather than leave a row of poles over the water.
  const poleMesh = addMesh(group, lampPole, applyHoleCut(solid({
    color: PALETTE.LAMP_POST, roughness: 0.5, metalness: 0.4, vertexColors: true,
    name: 'streets-bridge-lamp',
  })), 'bridge-lamps');
  if (poleMesh) poleMesh.castShadow = true;

  let matGlow = null;
  if (!lampGlow.empty) {
    /* Hole-cut, same reasoning as the poles under it. Without it a hole that
       takes the bridge deletes every standard on the crossing and leaves their
       lamp heads hanging in a row over open water — and unlike the poles these
       are unlit basic material, so they would be the BRIGHTEST thing left
       floating. MeshBasicMaterial carries `transformed`, `#include <common>`
       and `#include <color_fragment>`, which is everything the patch splices
       into. */
    matGlow = applyHoleCut(new THREE.MeshBasicMaterial({
      color: new THREE.Color(PALETTE.LAMP_GLOW), toneMapped: false, vertexColors: true,
    }));
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
   *  3. STANDING DAMP. The whole carriageway going glossy at once is a single
   *     flat lacquer, and a lacquered road reads as plastic. The pools in the
   *     channel drop much further than the road around them, so the sheen gets
   *     a shape: bright where the water is, dull where it is not. They are held
   *     at roughness 0.20 rather than driven to a mirror on purpose — a true
   *     mirror facing straight up reflects the empty night zenith and comes out
   *     BLACK, whereas a 0.20 lobe is wide enough to pull in the sodium band
   *     the night IBL paints along its horizon, which is the colour a wet road
   *     under a city actually is.
   *  4. The bridge lamps, which were previously lit at noon.
   */
  const nightWet = [matRoad, matPatch, matBus, matPolish];
  for (const m of nightWet) m.userData.dryRough = m.roughness;
  const nightPaint = [matWhite, matYellow];
  matWhite.emissive.set(PALETTE.ROAD_LINE);
  matYellow.emissive.set(PALETTE.ROAD_LINE_YELLOW);
  const glowBase = matGlow ? matGlow.color.clone() : null;

  let lastNight = -1;
  function applyNight(n) {
    if (Math.abs(n - lastNight) < 0.004) return;
    lastNight = n;
    for (const m of nightWet) {
      // Off each material's OWN dry roughness, not off a shared 1.0: the
      // polished wheel tracks are already glossier than the wearing course by
      // day, and that difference is the entire reason they are visible.
      m.roughness = m.userData.dryRough * (1.0 - 0.46 * n);
      m.metalness = 0.07 * n;
      m.envMapIntensity = 0.30 + 0.30 * n;
    }
    matDamp.roughness = 0.86 - 0.66 * n;
    matDamp.metalness = 0.04 + 0.22 * n;
    matDamp.envMapIntensity = 0.42 + 1.05 * n;
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
    `${stat.xovers} crossovers | ${stat.crossBars} crossing marks ` +
    `(${stat.xwalk[0]} continental / ${stat.xwalk[1]} ladder / ` +
    `${stat.xwalk[2]} transverse / ${stat.xwalk[3]} dashed) | ` +
    `${stat.pools} damp pools | ` +
    `${stat.arrows} arrows | ${stat.bays} bays (${stat.accessible} accessible, ` +
    `${stat.loading} loading, ${stat.ev} EV) | ${Math.round(stat.cycleM)} m cycle lane | ` +
    `${stat.seams} crack seams | ${stat.manholes} manholes | ` +
    `${stat.inlets} kerb inlets | ${stat.roadEnds} shore ends | ` +
    `${Math.round(stat.medianM)} m median | ${stat.bridges} bridges`
  );

  return group;
}
