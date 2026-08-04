/**
 * BISCAYNE BAY, THE MIAMI RIVER, AND EVERYTHING THAT MEETS THEM.
 *
 * Owns: the water surface + its shader, the shoreline distance field, seawalls
 * and bulkheads, the promenade/riverwalk edge, marina pontoons and piles,
 * bridge piers, nav buoys.
 *
 * ---------------------------------------------------------------------------
 * WHY A SIGNED DISTANCE FIELD RUNS THE WHOLE MODULE
 * ---------------------------------------------------------------------------
 * cityLayout cuts real geography into the shore: two marina basins notched into
 * the promenade, three channels around Brickell Key, and a river that bends
 * +-15 m off its nominal centreline. A rectangular water plane with a straight
 * foam line down one edge cannot express any of that, and a straight foam line
 * on a curved shore is the single loudest "this is procedural" tell in the
 * frame.
 *
 * So the module bakes ONE artefact — a signed distance-to-shore field over the
 * whole map — and derives everything from it:
 *
 *   the coastline   the water shader DISCARDS wherever the field is negative,
 *                   so the waterline is the bilinear zero crossing of a 2 m
 *                   grid: smooth, sub-cell, and exactly the geography the
 *                   layout asked for. The surface geometry itself can then be
 *                   a handful of fat rectangles (1 draw call) that overhang the
 *                   land, because the pixels that land on soil never survive.
 *   the foam        distance-driven, so it follows every basin and bend for
 *                   free instead of being a band down one axis.
 *   the depth grade turquoise shallows -> deep cyan, from the same distance.
 *   the seawalls    marching-squares the zero contour, chain, simplify, extrude
 *                   a coping profile along it. One pass builds the bay
 *                   parapet, both river bulkheads, the basin quays and the
 *                   Brickell Key revetment, all consistent, all one draw call.
 *
 * ---------------------------------------------------------------------------
 * WHY THE WATER SITS ABOVE y=0 (0.12 m)
 * ---------------------------------------------------------------------------
 * streets.js owns the base ground plane, and it is a single slab that runs
 * 30 m PAST the bay edge and straight across the river channel — that is the
 * "dark grey wedges jutting into the bay" defect. water.js cannot edit that
 * file, but water is opaque: floating the surface just above the base plane
 * (-0.03), the carriageways (0.0) and the lane paint (0.022) hides every one of
 * them, and the seawall parapet then covers the 2 m where the waterline meets
 * the promenade slab (0.155). The remaining clearance is small in absolute
 * terms, so the material also carries a polygon offset — that scales with depth
 * precision, which a fixed metric gap does not.
 *
 * ---------------------------------------------------------------------------
 * REFLECTIONS
 * ---------------------------------------------------------------------------
 * A real planar reflection means re-rendering the city, and the city is
 * currently thousands of draw calls. Instead a SKYLINE PROXY — one merged mesh
 * of flat boxes built straight from the layout massing — is rendered through a
 * mirrored camera into a 512x288 target: two draw calls, once per frame. The
 * water samples it in screen space (a mirrored camera shares the main
 * projection, so screen UV is the correct lookup) and falls back to the IBL
 * anywhere the proxy did not cover. Towers reflect; it costs nothing.
 *
 * The proxy LIGHTS UP. Its fragment shader carries a night state — a dark
 * facade plus a stochastic window lattice plus a lit crown — cross-faded on
 * nightFactor. A reflection that only ever darkens leaves the bay as a hole in
 * the middle of a glowing city, which is exactly what the first night build
 * looked like.
 *
 * ---------------------------------------------------------------------------
 * THE DAY/NIGHT CONTRACT — READ THIS BEFORE TOUCHING A COLOUR IN HERE
 * ---------------------------------------------------------------------------
 * NOTHING about the light is baked. This module used to snapshot
 * LIGHTING.SUN_ELEVATION / SUN_AZIMUTH / SUN_COLOR / SKY_MID / SKY_HORIZON into
 * its uniforms at build time, which pinned the bay at 14:24 forever: after dark
 * it stayed a self-lit electric cyan sheet BRIGHTER THAN THE CITY BEHIND IT.
 *
 * Every light-dependent uniform is now driven per frame from what engine.js
 * publishes — `scene.userData.sunDir`, `.sunDiscDir`, `.nightFactor`,
 * `.goldenFactor` and `.dayNight` — inside the water mesh's own
 * `onBeforeRender`, which is the one callback guaranteed to fire once per
 * rendered frame without game.js having to know this module exists.
 *
 * What follows the light: the specular direction, the specular and glitter
 * colour and tightness, the reflected sky gradient, the body albedo, the foam
 * brightness, the unlit floor, the Fresnel floor and cap, and the reflected
 * skyline's own shading. Look values live in DAY_LOOK / NIGHT_LOOK below and
 * are lerped on nightFactor — one place to retune, no shader edits.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SURFACE CARRIES THREE NORMALS AND A MEASURED DEPTH RAMP
 * ---------------------------------------------------------------------------
 * Fixing the night left the DAY bay as the weaker half, and two measurements
 * explain the whole of it rather than any amount of colour tweaking:
 *
 *   1. Unprojecting the `waterfront` preset's camera onto this surface shows
 *      the visible bay spans 0-90 m offshore. The depth ramp spent its contrast
 *      between 34 m and 190 m, so the player only ever saw its first quarter
 *      and every pixel of water graded to the same turquoise.
 *   2. At the art-directed hour the sun is 56 deg up and the camera looks down
 *      at 24-44 deg, putting the specular half-vector 41 deg off vertical. With
 *      a 6 deg wave slope the glitter term evaluates to pow(0.75, 46) = 2e-6.
 *      The bay had never rendered a single sparkle.
 *
 * So the ramp distances are now the distances the game renders, and the one
 * wave gradient is re-steepened into three normals — calm for shading, 2.2x for
 * the reflected sky, 5.5x for glitter — because those three terms want three
 * different slope distributions and only one of them can afford to be noisy.
 * The unlit floor came down 0.40 -> 0.18 at the same time: it is a constant
 * added to every pixel, so it divided every bit of contrast underneath it.
 */

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { WORLD, PALETTE } from '../config.js';
import { LIGHTING } from '../core/quality.js';
import { Textures, solid, ground } from '../core/materials.js';
import { applyHoleCut } from '../render/groundShader.js';
import { makeRNG } from '../core/rng.js';

/* ========================================================== constants === */

/** Water surface height. See the header — this is above the land base plane. */
const WATER_Y = 0.12;
const BAY = WORLD.BAY_EDGE;

/** Shore field domain and resolution. 2 m cells; bilinear does the rest. */
const FIELD = { x0: -601, z0: -661, cell: 2, w: 542, h: 662 };
/** Signed distance encoded into R over +-this, in metres. */
const SD_RANGE = 56;
/** Offshore distance encoded into G over this, for the depth grade. */
const DEPTH_RANGE = 340;

/** Water surface geometry lattice (coarse: the coast comes from the field). */
const GRID = { x0: -601, z0: -661, cell: 4, w: 232, h: 331 };  // x1 = 327 exactly
/** Where the offshore apron takes over from the inshore lattice. */
const OFFSHORE_X = GRID.x0 + GRID.w * GRID.cell;               // 327
/** Far enough that the bay never ends on screen (fog kills it at 2600 m). */
const OFFSHORE_FAR = 3400;

/** Only build shore furniture where the land base plane actually exists. */
const LAND_BOX = { x0: -546, x1: 338, z0: -546, z1: 546 };

const SEAWALL_TOP = 1.36;
const COPING_LIP = 1.14;

/* --------------------------------------------------------- day / night --- */

/**
 * The two ends of the water's look, lerped on scene.userData.nightFactor.
 *
 * WHY THESE ARE AUTHORED RATHER THAN DERIVED FROM THE LIGHT RIG
 * The engine's own night stop only halves the key (3.55 -> 1.80) and doubles
 * the ambient, because the whole city has to stay readable after dark. Feed
 * that straight into a surface whose albedo is a saturated turquoise and whose
 * emissive floor is 40% of that albedo and you get exactly the defect this
 * pass exists to kill: a bay noticeably brighter than the lit towers standing
 * on it. Water is the one large surface in frame with no bounce coming back
 * into it, so it has to be pushed down harder than the rig does on its own.
 *
 *   bodyMul     multiplies the depth-graded albedo. The night value is not a
 *               grey scale-down: it is bluer than it is green, which is what
 *               turns turquoise into the deep blue-green a moonlit bay is.
 *   foamMul     the same for whitecaps and surf. Foam at night is lit by the
 *               moon and by the city, not by the sun.
 *   selfLit     the unlit floor added to the emissive. This is the single
 *               biggest contributor to the old glowing-cyan night: 40% of a
 *               bright albedo, added after the lighting, every hour of the day.
 *   glintTight  the specular exponent of the sparkle. Moon glitter is a much
 *               tighter, harder path than sun glitter — narrow and sharp, not
 *               a broad sheen.
 *   mixFloor    how much reflection covered pixels keep whatever the Fresnel
 *   mixCap      says, and the ceiling on it. Both open up at night because the
 *               reflected, lit skyline IS the night bay.
 */
const DAY_LOOK = {
  bodyMul: [1.00, 1.00, 1.00],
  foamMul: [1.00, 1.00, 1.00],
  /* Was 0.40, and that single number was most of why the day bay rendered as a
     sheet of flat turquoise paint. An unlit floor is a constant added to every
     pixel of the surface, so it does not merely brighten the water — it
     DIVIDES every bit of contrast the wave field, the shadows and the
     reflection manage to produce. At 0.40 it was roughly 40% of the final
     value and nothing underneath it could read. The lit share below picks the
     level back up (0.62 -> 0.78 in WATER_BODY), so the bay is no darker than
     it was; it just has structure in it now. */
  selfLit: 0.18,
  glareGain: 2.20,
  glintGain: 1.00,
  glintTight: 46.0,
  mixFloor: 0.17,
  mixCap: 0.74,
  reflAmt: 1.15,
};
const NIGHT_LOOK = {
  bodyMul: [0.155, 0.235, 0.310],
  foamMul: [0.200, 0.265, 0.355],
  selfLit: 0.012,
  glareGain: 0.85,
  glintGain: 0.42,
  glintTight: 190.0,
  /* 0.42 was tuned on the open bay, where the reflected towers arrive as
     separated columns with dark water between them. The river is a 40 m strip
     with a wall of lit podium directly behind it: every pixel of it was
     covered, and it came back as a solid blown rug brighter than the street on
     its bank. Backed off here, damped again over the river specifically, and
     capped by the mirror-radiance shoulder in WATER_BODY. */
  mixFloor: 0.36,
  mixCap: 0.90,
  /* NOT boosted after dark, even though the night reflection is the point.
     uReflAmt scales the target's own radiance, and the night proxy is already
     emissive: push it past 1.0 and a reflected window comes out brighter than
     the window it is a reflection of, which is the same defect this whole pass
     is here to remove, just one bounce further along. */
  reflAmt: 1.00,
};

/**
 * How many boat wakes the shader carries. Every one costs a branch and an
 * exp() on every water pixel on screen, so this is deliberately small and the
 * tracker spends the slots on the boats NEAREST THE CAMERA — a wake 600 m out
 * is three pixels wide.
 */
const MAX_WAKES = 5;

/** vehicles.js FLEET keys that float. Used to pull boats out of the registry. */
const WAKE_KINDS = new Set([
  'motorYacht', 'sailBoat', 'waterTaxi', 'skiff', 'sportFisher', 'cruiseShip', 'jetSki',
]);

/* ============================================================ geometry === */

/** Marching-squares + chaining tolerances, metres. */
const SIMPLIFY_EPS = 0.75;
const MAX_STATION = 8;

/* ---------------------------------------------------------- shore field --- */

/**
 * Water predicate. Deliberately NOT layout.isWater(): that reports dry inside
 * a bridge footprint (correct for zoning, wrong for a river, which flows
 * underneath). Everything else matches, including the Brickell Key island —
 * the island is land simply by being west of the bay edge and outside every
 * water poly, so it needs no special case.
 */
function makeWaterTest(layout) {
  const polys = layout.waterPolys || [];
  const centerAt = layout.river.centerAt;
  const halfAt = layout.river.halfAt;
  const rz = WORLD.RIVER_Z, rh = WORLD.RIVER_HALF_W;
  return (x, z) => {
    if (x >= BAY) return true;
    // The bent channel, unioned with the nominal straight band: cityLayout
    // guarantees blocks are cleared from both, so both must hold water.
    const c = centerAt(x), h = halfAt(x);
    if (z > c - h && z < c + h) return true;
    if (z > rz - rh && z < rz + rh) return true;
    for (let i = 0; i < polys.length; i++) {
      const p = polys[i];
      if (x > p.x0 && x < p.x1 && z > p.z0 && z < p.z1) return true;
    }
    return false;
  };
}

/**
 * Two-pass chamfer distance transform. Exact Euclidean would buy ~3% accuracy
 * on a field whose only consumers are a foam width and a discard test, and
 * cost four times the build time.
 */
function chamfer(w, h, seed) {
  const d = new Float32Array(w * h);
  d.fill(1e9);
  for (let i = 0; i < d.length; i++) if (seed[i]) d[i] = 0;
  const D = 1.41421356;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 1);
        if (x > 0) v = Math.min(v, d[i - w - 1] + D);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + D);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    const row = y * w;
    for (let x = w - 1; x >= 0; x--) {
      const i = row + x;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 1);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + D);
        if (x > 0) v = Math.min(v, d[i + w - 1] + D);
      }
      d[i] = v;
    }
  }
  return d;
}

/**
 * Bake the signed distance-to-shore field and its GPU texture.
 * Positive = water, negative = land, metres.
 */
function buildShoreField(layout) {
  const { x0, z0, cell, w, h } = FIELD;
  const isWater = makeWaterTest(layout);

  const wet = new Uint8Array(w * h);
  const dry = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    const z = z0 + (j + 0.5) * cell;
    const row = j * w;
    for (let i = 0; i < w; i++) {
      const x = x0 + (i + 0.5) * cell;
      const m = isWater(x, z) ? 1 : 0;
      wet[row + i] = m;
      dry[row + i] = m ^ 1;
    }
  }

  const toLand = chamfer(w, h, dry);   // for water cells
  const toWater = chamfer(w, h, wet);  // for land cells

  // The true boundary lies half a cell outside the nearest opposite cell.
  const sd = new Float32Array(w * h);
  for (let i = 0; i < sd.length; i++) {
    sd[i] = wet[i] ? (toLand[i] - 0.5) * cell : -(toWater[i] - 0.5) * cell;
  }

  const data = new Uint8Array(w * h * 4);
  for (let i = 0, o = 0; i < sd.length; i++, o += 4) {
    const s = sd[i];
    data[o] = Math.max(0, Math.min(255, Math.round((0.5 + s / (2 * SD_RANGE)) * 255)));
    data[o + 1] = Math.max(0, Math.min(255, Math.round((s > 0 ? s / DEPTH_RANGE : 0) * 255)));
    data[o + 2] = 0;
    data[o + 3] = 255;
  }

  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;

  /** Bilinear CPU sampler — the geometry builders need the same field. */
  const at = (x, z) => {
    const fx = (x - x0) / cell - 0.5;
    const fz = (z - z0) / cell - 0.5;
    const i0 = Math.max(0, Math.min(w - 1, Math.floor(fx)));
    const j0 = Math.max(0, Math.min(h - 1, Math.floor(fz)));
    const i1 = Math.min(w - 1, i0 + 1);
    const j1 = Math.min(h - 1, j0 + 1);
    const tx = Math.max(0, Math.min(1, fx - i0));
    const tz = Math.max(0, Math.min(1, fz - j0));
    const a = sd[j0 * w + i0], b = sd[j0 * w + i1];
    const c = sd[j1 * w + i0], d = sd[j1 * w + i1];
    return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * tz;
  };

  return { sd, tex, at, w, h, x0, z0, cell };
}

/* ------------------------------------------------- shoreline extraction --- */

/**
 * Marching squares at the zero contour of the (smooth) field. Cell corners are
 * field samples at cell centres, so the emitted vertices land on the bilinear
 * zero crossing — the same curve the shader discards against, which is why the
 * seawall never leaves a sliver of water on the wrong side of it.
 */
function marchShore(field) {
  const { sd, w, h, x0, z0, cell } = field;
  const segs = [];
  const px = (i) => x0 + (i + 0.5) * cell;
  const pz = (j) => z0 + (j + 0.5) * cell;
  const lerpT = (a, b) => a / (a - b);

  for (let j = 0; j < h - 1; j++) {
    for (let i = 0; i < w - 1; i++) {
      const a = sd[j * w + i];          // (i,   j)
      const b = sd[j * w + i + 1];      // (i+1, j)
      const c = sd[(j + 1) * w + i + 1];// (i+1, j+1)
      const d = sd[(j + 1) * w + i];    // (i,   j+1)
      let code = 0;
      if (a > 0) code |= 1;
      if (b > 0) code |= 2;
      if (c > 0) code |= 4;
      if (d > 0) code |= 8;
      if (code === 0 || code === 15) continue;

      const xa = px(i), xb = px(i + 1), za = pz(j), zb = pz(j + 1);
      // Edge crossing points: bottom(a-b), right(b-c), top(d-c), left(a-d)
      const eB = () => ({ x: xa + (xb - xa) * lerpT(a, b), z: za });
      const eR = () => ({ x: xb, z: za + (zb - za) * lerpT(b, c) });
      const eT = () => ({ x: xa + (xb - xa) * lerpT(d, c), z: zb });
      const eL = () => ({ x: xa, z: za + (zb - za) * lerpT(a, d) });

      const push = (p, q) => segs.push([p, q]);
      switch (code) {
        case 1: case 14: push(eL(), eB()); break;
        case 2: case 13: push(eB(), eR()); break;
        case 3: case 12: push(eL(), eR()); break;
        case 4: case 11: push(eR(), eT()); break;
        case 5: push(eL(), eT()); push(eB(), eR()); break;
        case 6: case 9: push(eB(), eT()); break;
        case 7: case 8: push(eL(), eT()); break;
        case 10: push(eL(), eB()); push(eR(), eT()); break;
        default: break;
      }
    }
  }
  return segs;
}

/** Weld segment endpoints into polylines. */
function chainSegments(segs) {
  const key = (p) => `${Math.round(p.x * 20)},${Math.round(p.z * 20)}`;
  const map = new Map();
  for (const s of segs) {
    for (const p of s) {
      const k = key(p);
      let e = map.get(k);
      if (!e) { e = []; map.set(k, e); }
      e.push(s);
    }
  }
  const used = new Set();
  const lines = [];

  const walk = (seg, fromKey) => {
    const pts = [];
    let cur = seg;
    let k = fromKey;
    while (cur && !used.has(cur)) {
      used.add(cur);
      const [p, q] = cur;
      const kp = key(p);
      const head = kp === k ? p : q;
      const tail = kp === k ? q : p;
      if (pts.length === 0) pts.push(head);
      pts.push(tail);
      k = key(tail);
      const cand = map.get(k) || [];
      cur = cand.find((s) => !used.has(s));
    }
    return pts;
  };

  for (const s of segs) {
    if (used.has(s)) continue;
    // Walk both ways from this seed so open coasts come out in one piece.
    const fwd = walk(s, key(s[0]));
    const back = [];
    const startKey = key(s[0]);
    let cand = (map.get(startKey) || []).find((t) => !used.has(t));
    if (cand) {
      const bpts = walk(cand, startKey);
      for (let i = bpts.length - 1; i >= 1; i--) back.push(bpts[i]);
    }
    const pts = back.concat(fwd);
    if (pts.length > 2) lines.push(pts);
  }
  return lines;
}

/** Douglas-Peucker. */
function simplify(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    if (hi - lo < 2) continue;
    const a = pts[lo], b = pts[hi];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1e-6;
    let best = -1, bi = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = Math.abs((pts[i].x - a.x) * dz - (pts[i].z - a.z) * dx) / len;
      if (d > best) { best = d; bi = i; }
    }
    if (best > eps) { keep[bi] = 1; stack.push([lo, bi], [bi, hi]); }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/** Break long straights back into stations so furniture has somewhere to sit. */
function resample(pts, maxLen) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = out[out.length - 1], b = pts[i];
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.ceil(d / maxLen);
    for (let k = 1; k <= n; k++) {
      out.push({ x: a.x + (b.x - a.x) * (k / n), z: a.z + (b.z - a.z) * (k / n) });
    }
  }
  return out;
}

/** Split a polyline into the runs that lie inside the buildable map. */
function clipToLand(pts, box) {
  const runs = [];
  let cur = [];
  for (const p of pts) {
    const inside = p.x > box.x0 && p.x < box.x1 && p.z > box.z0 && p.z < box.z1;
    if (inside) cur.push(p);
    else if (cur.length) { runs.push(cur); cur = []; }
  }
  if (cur.length) runs.push(cur);
  return runs.filter((r) => r.length >= 2);
}

/**
 * Shoreline polylines with a per-vertex outward (water-side) normal and a
 * mitre scale, ready to extrude.
 */
function buildShorelines(field) {
  const raw = chainSegments(marchShore(field));
  const out = [];
  for (const line of raw) {
    for (const run of clipToLand(line, LAND_BOX)) {
      const pts = resample(simplify(run, SIMPLIFY_EPS), MAX_STATION);
      if (pts.length < 2) continue;
      let total = 0;
      for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      if (total < 14) continue;                       // stubs from field noise

      /*
       * ORIENTATION. sweepProfile winds its triangles from (tangent x normal),
       * so the profile only faces outward when the normal is exactly
       * (t.z, -t.x) — flipping individual normals to point at the water would
       * place the wall correctly and render it INSIDE OUT, which is precisely
       * what happened on the first pass: backface culling ate the whole
       * parapet and left the bollards floating on a flat promenade.
       *
       * So the direction of travel is what gets corrected, not the normal:
       * probe the field along the run, and if the water is on the wrong side,
       * reverse the polyline.
       */
      const normalAt = (i) => {
        const dx = pts[i + 1].x - pts[i].x, dz = pts[i + 1].z - pts[i].z;
        const l = Math.hypot(dx, dz) || 1e-6;
        return { x: dz / l, z: -dx / l };
      };
      let vote = 0;
      for (let i = 0; i < pts.length - 1; i += Math.max(1, (pts.length / 12) | 0)) {
        const n = normalAt(i);
        const mx = (pts[i].x + pts[i + 1].x) / 2, mz = (pts[i].z + pts[i + 1].z) / 2;
        vote += field.at(mx + n.x * 3, mz + n.z * 3) > field.at(mx - n.x * 3, mz - n.z * 3) ? 1 : -1;
      }
      if (vote < 0) pts.reverse();

      const segN = [];
      for (let i = 0; i < pts.length - 1; i++) segN.push(normalAt(i));
      const closed = Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].z - pts[pts.length - 1].z) < 3.5;
      const nrm = [];
      for (let i = 0; i < pts.length; i++) {
        const a = segN[Math.max(0, i - 1)] || segN[0];
        const b = segN[Math.min(segN.length - 1, i)] || segN[segN.length - 1];
        let nx = a.x + b.x, nz = a.z + b.z;
        const l = Math.hypot(nx, nz) || 1e-6;
        nx /= l; nz /= l;
        // Mitre: pull the offset out so a 90 deg corner does not pinch.
        const scale = 1 / Math.max(0.45, nx * b.x + nz * b.z);
        nrm.push({ x: nx, z: nz, s: scale });
      }
      out.push({ pts, nrm, closed, length: total });
    }
  }
  return out;
}

/* ------------------------------------------------------- mesh utilities --- */

/**
 * Sweep a 2D profile (offset from the line, height) along a shoreline.
 * `tint` per profile point becomes a vertex colour, which is how the tide
 * staining and the bright coping get painted without a second material.
 */
function sweepProfile(shore, profile, opts = {}) {
  const { pts, nrm } = shore;
  const n = pts.length;
  const m = profile.length;
  const pos = [];
  const col = [];
  const uv = [];
  const idx = [];
  const uScale = opts.uScale || 0.25;
  const jitter = opts.jitter || null;

  let dist = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) dist += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    const p = pts[i], nv = nrm[i];
    const wob = jitter ? jitter(p, i) : 1;
    for (let k = 0; k < m; k++) {
      const pr = profile[k];
      const off = pr[0] * nv.s;
      pos.push(p.x + nv.x * off, pr[1], p.z + nv.z * off);
      uv.push(dist * uScale, pr[2]);
      col.push(pr[3] * wob, pr[4] * wob, pr[5] * wob);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < m - 1; k++) {
      const a = i * m + k, b = a + 1, c = a + m, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Axis-aligned quad on the XZ plane with world-scaled UVs. */
function quadXZ(x0, z0, x1, z1, y, uvScale) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1,
  ], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([
    0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
  ], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([
    x0 * uvScale, z0 * uvScale, x1 * uvScale, z0 * uvScale,
    x1 * uvScale, z1 * uvScale, x0 * uvScale, z1 * uvScale,
  ], 2));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  return g;
}

/** Give a geometry a uniform vertex colour so it can merge with a swept wall. */
function withFlatColour(g, k) {
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3).fill(k);
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

function box(w, hgt, d, x, y, z, rotY = 0) {
  const g = new THREE.BoxGeometry(w, hgt, d);
  if (rotY) g.rotateY(rotY);
  g.translate(x, y, z);
  return g;
}

/* ============================================================== shader === */

const WATER_PARS = /* glsl */ `
  uniform float uTime;
  uniform sampler2D uShoreMap;
  uniform vec2  uShoreOrigin;
  uniform vec2  uShoreSize;
  uniform vec2  uShoreRanges;
  uniform vec3  uDeep, uMidC, uShallow, uFoamC, uRiverC, uAbyss, uSandC;
  uniform vec3  uSunDirW, uSunTint, uSkyHi, uSkyLo;
  uniform vec3  uBodyMul, uFoamMul, uSpill;
  uniform float uSelfLit, uGlareGain, uGlintGain, uGlintTight;
  uniform float uMixFloor, uMixCap, uNight;
  uniform sampler2D uRefl;
  uniform float uReflAmt;
  uniform float uRiverZ;
  uniform vec4  uBridges[6];
  uniform int   uBridgeCount;
  uniform vec4  uWakeA[${MAX_WAKES}];
  uniform vec4  uWakeB[${MAX_WAKES}];
  uniform int   uWakeCount;
  varying vec3  vWaterPos;
  varying vec4  vReflCoord;

  float wHash(vec2 p){
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }
  /* QUINTIC, not the usual smoothstep cubic, and this is the fix for a
     measured defect rather than a refinement. Cubic interpolation of a value
     lattice is only C1 at the cell boundary: its second derivative jumps, and
     on a large smooth surface the eye reads that discontinuity as a grid of
     creases. The waterfront frame showed exactly that — a diagonal checkerboard
     of ~20 m diamonds across the near bay, which is the base octave of the
     swell field made visible by its own interpolant, and it is the art bible's
     "tiling so obvious you can count the repeats". The quintic is C2, so the
     lattice has nothing left to show. Four extra multiplies per sample. */
  float wNoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), u.x),
               mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  /* Value noise lives on a lattice, and three octaves sharing ONE world-axis
     aligned lattice is why the old bay was tiled with ~20 m square blotches you
     could count: every octave put its features on the same grid lines and they
     reinforced instead of cancelling. Rotating 40 deg between octaves (and
     once up front, so the base octave is not axis aligned either) breaks the
     alignment for four multiplies a sample. */
  float wFbm(vec2 p){
    mat2 R = mat2(0.766, 0.643, -0.643, 0.766);
    p = R * p;
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 3; i++) { v += a * wNoise(p); p = R * p * 2.07 + 9.3; a *= 0.5; }
    return v;
  }

  /* x = signed distance to shore (m), y = offshore distance for the depth
     grade. Outside the baked domain the distance keeps growing analytically,
     so the open bay stays deep all the way to the horizon. */
  vec2 shoreSample(vec2 p) {
    vec2 uv  = (p - uShoreOrigin) / uShoreSize;
    vec2 cuv = clamp(uv, 0.0, 1.0);
    vec4 t = texture2D(uShoreMap, cuv);
    float extra = length((uv - cuv) * uShoreSize);
    float base = (t.r - 0.5) * 2.0 * uShoreRanges.x;
    // Leaving the baked domain keeps walking in whichever direction the edge
    // texel was already going: out to sea it gets deeper, inland it stays land.
    float s = base >= 0.0 ? 1.0 : -1.0;
    return vec2(base + s * extra,
                t.g * uShoreRanges.y + max(0.0, s) * extra);
  }

  /* Signed distance only — for the fetch probes, which do not need the depth
     channel or the out-of-domain extension. */
  float shoreRaw(vec2 p) {
    vec2 cuv = clamp((p - uShoreOrigin) / uShoreSize, 0.0, 1.0);
    return (texture2D(uShoreMap, cuv).r - 0.5) * 2.0 * uShoreRanges.x;
  }

  /* Sum of directional waves. Only the analytic GRADIENT is used — the surface
     stays geometrically flat, so the whole bay is a handful of triangles and
     every bit of relief is per-pixel. Frequencies are mutually irrational so
     the pattern never visibly repeats.

     CREST SHARPENING. A pure sine sum gives a rolling, soapy surface with no
     edges in it; real chop has narrow crests and broad troughs. Adding the
     second harmonic of each wave's own phase to the GRADIENT (not the height)
     is a Gerstner-shaped profile for one extra cos per wave, and it is what
     puts a hard specular line on the crest instead of a soft sheen.

     The kd argument scales only the three short waves. Their wavelength is
     under 4 m, so past ~250 m one screen pixel spans several crests and they
     alias into television static; the caller fades them out on the screen
     footprint, because there is no mip chain here to do it for us — every bit
     of this relief is analytic. */
  vec2 waveGrad(vec2 p, float t, float k, float kd) {
    vec2 g = vec2(0.0);
    #define WAV(dx, dz, f, s, a, sh, m) { \
      float ph = (p.x * (dx) + p.y * (dz)) * (f) + t * (s); \
      g += vec2(dx, dz) * ((cos(ph) + (sh) * cos(2.0 * ph)) * (a) * (f) * k * (m)); }
    WAV( 0.94,  0.34, 0.071, 0.90, 0.52,   0.42, 1.0)
    WAV( 0.58, -0.81, 0.129, 1.28, 0.33,   0.38, 1.0)
    WAV(-0.38,  0.93, 0.237, 1.71, 0.175,  0.32, 1.0)
    WAV( 0.99, -0.16, 0.427, 2.33, 0.098,  0.26, 1.0)
    WAV( 0.22,  0.98, 0.803, 3.19, 0.050,  0.00, kd)
    WAV(-0.71, -0.70, 1.451, 4.40, 0.024,  0.00, kd)
    WAV( 0.46, -0.89, 2.311, 6.10, 0.0115, 0.00, kd)
    #undef WAV
    return g;
  }

  /**
   * Height of the two LONGEST waves only, normalised to about +-1.
   *
   * Swell shading — the slow tonal drift that says a sea has volume under it —
   * used to be driven off the value-noise swell field, and that put the noise
   * lattice straight into the body colour of the largest flat surface in the
   * game. A swell is not noise; it is the long wave, and taking the shading
   * from the same two sines the surface is already rippling with costs two
   * sin() and cannot show a grid because there is no grid in it.
   */
  float waveLong(vec2 p, float t) {
    return 0.62 * sin((p.x * 0.94 + p.y * 0.34) * 0.071 + t * 0.90)
         + 0.38 * sin((p.x * 0.58 - p.y * 0.81) * 0.129 + t * 1.28);
  }
`;

const WATER_BODY = /* glsl */ `
  vec2 wP = vWaterPos.xz;
  vec2 wShore = shoreSample(wP);
  if (wShore.x < 0.0) discard;

  /* streets.js runs its bridge decks dead flat at y=0 (vehicles pin traffic to
     y=0.02), which this surface sits 12 cm above — so without this the river
     is painted over every crossing and the traffic appears to drive on water.
     Cut the surface out under each deck instead, inset so the water tucks
     under the fascia and leaves no seam. The shoreline field deliberately does
     NOT know about bridges: a hole in the mask would grow a seawall around
     every crossing, mid-channel. */
  for (int bi = 0; bi < 6; bi++) {
    if (bi >= uBridgeCount) break;
    vec4 br = uBridges[bi];
    if (abs(wP.x - br.x) < br.z && abs(wP.y - br.y) < br.w) discard;
  }

  float wT = uTime;
  vec3 wV = normalize(cameraPosition - vWaterPos);

  /* How much world one pixel covers here. Everything with a wavelength under
     this has to be faded out or it aliases. */
  float wFoot = max(fwidth(wP.x), fwidth(wP.y));
  float wNear = 1.0 - smoothstep(0.10, 0.52, wFoot);

  /* ---- THE CHANNEL, resolved before anything else uses it -------------
     Centreline AND half-width are the same functions cityLayout cut the land
     with, so the water agrees with its own banks. Normalising the offset by the
     LOCAL half-width is what the old code was missing: it faded the river tint
     over a fixed 34-96 m band on a channel that is 45 m across at the west end
     and 73 m at the mouth, so the tint could not follow the flare and nothing
     downstream of it could know where the thalweg was. */
  float wRC = uRiverZ - 9.0 * sin((wP.x + 470.0) / 300.0) + 5.5 * sin((wP.x - 60.0) / 118.0);
  float wRT = clamp((wP.x + 200.0) / 480.0, 0.0, 1.0);
  float wRH = 26.0 * (0.86 + 0.55 * wRT * wRT);
  /* 0 on the thalweg, 1 at the bulkhead, >1 out in the bay. */
  float wRN = abs(wP.y - wRC) / max(1.0, wRH);
  float wRiv = (1.0 - smoothstep(0.85, 2.60, wRN))
             * (1.0 - smoothstep(${BAY.toFixed(1)} - 40.0, ${BAY.toFixed(1)} + 70.0, wP.x));

  /* The two noise fields the whole surface runs on: one lacy and fast for the
     texture of foam, one broad and slow for where things gather. Evaluated up
     here rather than down in the foam block because the slow one also decides
     where the chop is, and wind is the reason for both.
     Three separate fBm evaluations per pixel is not affordable over half a
     screen of bay, which is why there are exactly two. */
  float wLace = wFbm(wP * 0.40 - vec2(wT * 0.18, wT * 0.11));
  float wSwell = wFbm(wP * 0.048 + vec2(wT * 0.04, -wT * 0.025));

  /* Chop is damped in the shallows: the last few metres against a seawall are
     always calmer than open water, and the flattening is what reads as
     "shelter" rather than a texture running under a wall. */
  float wLongH = waveLong(wP, wT);
  float wCalm = 0.35 + 0.65 * smoothstep(0.0, 26.0, wShore.x);
  /* CAT'S PAWS. Wind over water is gusty, so chop arrives in patches — bands of
     ruffled water lying next to bands of glass. That patchiness is the largest
     single cue that a surface is water and not a plane with a texture on it,
     and it costs one multiply because the slow field is already in hand.
     Half the swing now comes from the long wave rather than all of it from the
     noise field: crests are where chop builds, and splitting the term means the
     patch pattern is no longer a pure function of one lattice. */
  float wGust = 0.55 + 0.55 * wSwell + 0.25 * (0.5 + 0.5 * wLongH);
  vec2 wG = waveGrad(wP, wT, wCalm * 1.55, (0.30 + 0.70 * wNear) * wGust);
  vec3 wNormal = normalize(vec3(-wG.x, 1.0, -wG.y));

  /* ---- THREE NORMALS OUT OF ONE WAVE FIELD ---------------------------
     The shading normal above has to stay calm: it feeds three's own specular
     and IBL paths, and a steep sea in those goes to noise long before it goes
     to chop. But calm is precisely the wrong slope distribution for the two
     terms that actually REVEAL water, and the arithmetic is not close.

     Measured at the art-directed hour: the sun sits 56 deg up, the game camera
     looks down at 24-44 deg, so the specular half-vector stands 41 deg off
     vertical. A surface whose steepest facet is 6 deg returns
     pow(0.75, 46) = 2e-6 of the sun. That is not "subtle sparkle", it is zero,
     and it is why the bay had no glitter anywhere in any daylight frame.

     Real water answers this with capillary facets that genuinely do reach
     30-40 deg — they are just far too small to put in a shading normal. So the
     one gradient is re-steepened twice, for two normalizes and no extra noise
     lookups, and each term gets the slope distribution it needs:
       wSlopeN   the reflected sky. Swings the reflected ray across the sky
                 gradient so the bay ripples instead of mirroring one colour.
       wFacetN   glitter only. Steep enough that a sun 41 deg away can find
                 facets aimed at it, which is what glitter physically is. */
  vec3 wSlopeN = normalize(vec3(-wG.x * 2.2, 1.0, -wG.y * 2.2));
  vec3 wFacetN = normalize(vec3(-wG.x * 5.5, 1.0, -wG.y * 5.5));

  /* ---- depth grade --------------------------------------------------
     Distance offshore is read from the HIGH-PRECISION signed channel while it
     is in range (0.44 m per LSB over +-56 m) and only handed over to the long
     channel (1.33 m per LSB over 340 m) beyond it. They encode the same
     quantity; reading the long one everywhere is what terraced the river — a
     26 m wide channel got nineteen quantisation levels across it and the grade
     came out as visible steps. */
  float wDist = mix(wShore.x, wShore.y, smoothstep(30.0, 50.0, wShore.x));

  /* Turquoise shelf -> deep cyan -> a deeper cyan still in the open bay. The
     last step is NOT a slide toward navy: uAbyss is uDeep held at 72%, which
     keeps the far water unmistakably Biscayne while giving the grade somewhere
     to go.

     THE RAMP DISTANCES ARE MEASURED, NOT CHOSEN. Unprojecting the waterfront
     preset's camera onto this surface puts the whole visible bay between 0 and
     90 m offshore (camera 102 m up, 250 m back, view elevation 17-44 deg). The
     previous ramp spent its contrast between 34 m and 190 m, so the player saw
     the first quarter of it: every pixel of water in the frame resolved to
     shallow-or-mid and the bay came out as one flat sheet of turquoise from the
     seawall to the bottom of the screen. Everything below now lands inside
     95 m, which is the range the game actually renders, while the abyss step
     stays long because menu-hero does see 400 m and still needs somewhere for
     the far bay to go. */
  vec3 wCol = mix(uShallow, uMidC, smoothstep(0.0, 22.0, wDist));
  wCol = mix(wCol, uDeep, smoothstep(18.0, 95.0, wDist) * 0.92);
  wCol = mix(wCol, uAbyss, smoothstep(110.0, 520.0, wDist) * 0.85);

  /* The seawall stands 1.32 m out over the contour, so the WATERLINE the camera
     can actually see is that far offshore. Foam and shallows are measured from
     there — measured from the contour they all hide behind the wall, which is
     exactly why the first pass had no visible surf. */
  float wSdF = max(0.0, wShore.x - ${(1.34).toFixed(2)});

  /* ---- the river ------------------------------------------------------
     Siltier, greener and DARKER than the bay. The tint alone was never enough:
     a 60 m strip of one flat colour held between two straight bulkheads is a
     swimming pool whatever colour it is painted, which is exactly what the
     `river` preset rendered. Three things fix it, and none of them is a colour:
     depth across the channel, a current, and a shaded margin at the wall. */
  wCol = mix(wCol, uRiverC, wRiv * 0.92);

  /* 1. CROSS-CHANNEL DEPTH. A dredged channel is deepest on the thalweg and
        shelves up to the quay. The bay's own depth grade cannot express this —
        it runs on distance to shore, and in a 60 m channel that never gets past
        its first fifth — so the river carries its own. */
  wCol *= mix(1.0, mix(0.60, 1.04, smoothstep(0.08, 0.98, wRN)), wRiv);

  /* 2. THE CURRENT. The single cue that separates a river from a pond, and the
        one the old surface had none of. Streamwise filaments in a frame ~14x
        longer along the channel than across it, sliding downstream at 1.3 m/s.
        The time term is a uniform translation of the sample point, NOT a
        position-weighted advection: weighting it by wRiv would shear the
        lattice a little more every second and tear the field apart over the
        length of a match. */
  if (wRiv > 0.004) {
    float wStr = wNoise(vec2((wP.x - wT * 1.30) * 0.075, (wP.y - wRC) * 0.85));
    wCol *= mix(1.0, 0.84 + 0.32 * wStr, wRiv);
  }

  /* 3. THE MARGIN. The last couple of metres against a bulkhead sit in the
        wall's own shadow and collect everything the channel is carrying, so
        they are darker than open channel — the opposite of the bright shelf
        the bay gets, and what stops the water reading as tiled to the edge. */
  wCol *= 1.0 - 0.20 * wRiv * (1.0 - smoothstep(0.0, 3.2, wSdF));

  /* Sand showing through the first few metres. WET sand, not a brightened
     shallow: the old version lifted the turquoise 18% and added warmth, which
     made a pale cyan apron indistinguishable from foam and turned the river —
     which is never more than 26 m across, i.e. all apron — into a swimming
     pool. Suppressed in the river, because the Miami River is silt. */
  wCol = mix(wCol, uSandC, (1.0 - smoothstep(0.0, 6.0, wSdF)) * 0.26
                           * (1.0 - wRiv * 0.85) * (1.0 - uNight * 0.85));

  /* Swell shading. A long wave is metres of extra water depth under a trough
     and metres less under a crest, and the body colour follows it — that slow
     tonal drift is the difference between a sea and a fill colour. Applied to
     the graded body only, so foam and glitter still sit on top at full value.
     Driven mostly by the LONG WAVE rather than by the noise field: see
     waveLong() for why the noise version was printing its own lattice across
     the bay. */
  wCol *= 0.945 + 0.075 * wLongH + 0.055 * wSwell;

  /* ---- foam ---------------------------------------------------------- */

  /* FETCH. Surf needs open water to build in: a 48 m marina basin gets a
     ripple, the open bay gets a breaking line. Probing the field 45 m out in
     four directions gives the width of the water body cheaply — without it the
     wide bay foam band floods every basin and channel bank to bank and turns
     them into flat white rectangles. */
  float wOpen = max(max(shoreRaw(wP + vec2(45.0, 0.0)), shoreRaw(wP - vec2(45.0, 0.0))),
                    max(shoreRaw(wP + vec2(0.0, 45.0)), shoreRaw(wP - vec2(0.0, 45.0))));
  /* The x-probes run ALONG the river, so they report open water in a 52 m
     channel and the surf model thinks the Miami River is Biscayne Bay. It is
     not: a river gets a lick at the bulkhead, not a breaking line. */
  float wFetch = (0.22 + 0.78 * smoothstep(10.0, 44.0, max(wOpen, wShore.x)))
               * (1.0 - wRiv * 0.55);

  /* SHAPED lace. The raw fBm is a smooth hill field in 0..1, and the old code
     multiplied the band by (0.34 + 0.90 * it) — a term that never reaches
     zero, so the "foam" was a continuous pale wash with no holes in it. From
     the game camera that is haze, not surf. Remapping hard gives foam that has
     dark water showing THROUGH the aeration, which is the whole read. */
  float wTex = smoothstep(0.26, 0.68, wLace + 0.16 * wSwell);

  /* Scalloped, breathing band — a constant-width line is the tell.
     Sized generously: the coping oversails the wall face by 0.3 m and stands
     1.24 m above the surface, so from a low camera it screens roughly the
     first four metres of water. A 2 m surf line is a 2 m surf line the player
     never sees. */
  float wWidth = (6.5 + 8.0 * wSwell + 2.4 * sin(wT * 0.8 + wSwell * 21.0)) * wFetch;
  float wBand = 1.0 - smoothstep(0.0, max(2.0, wWidth), wSdF);
  wBand *= (0.18 + 1.05 * wTex) * wFetch;
  /* Bright wash hugging the wall, the part that never fully drains back.
     Widened, and given a term that survives the river fetch penalty: the Miami
     River gets no breaking line and should not, but at 1.7 m the lick against
     the bulkhead was four pixels from the river preset's camera, which is
     indistinguishable from no surf at all. A river bank without a waterline is
     what made that channel read as a swimming pool. */
  float wEdge = (1.0 - smoothstep(0.0, 2.2 + 2.6 * wFetch, wSdF))
              * (0.34 + 0.58 * wFetch + 0.30 * wRiv);
  float wFoam = clamp(max(wBand, wEdge * 0.96), 0.0, 1.0);

  /* Whitecaps. Sparse on purpose: the old shader covered the bay in them and
     it read as scum on a swimming pool. */
  float wCap = smoothstep(0.72, 0.92, wSwell)
             * smoothstep(24.0, 130.0, wSdF)
             * (0.10 + 0.95 * wTex) * wFetch;
  wFoam = clamp(wFoam + wCap * 0.45, 0.0, 1.0);

  /* ---- boat wakes -----------------------------------------------------
     Fed live from the boats vehicles.js is already moving (see makeWakeTracker
     — water.js finds them in the entity registry rather than asking another
     agent's module for an API). A wake is two separate things and drawing only
     one of them is why a foam smear behind a hull never convinces:
       the trail   churned, aerated water directly astern, wide as the beam and
                   spreading slowly, dying out over a boat-length or ten;
       the arms    the Kelvin V, which opens at a FIXED angle (~19.5 deg)
                   whatever the speed. That fixed angle is the read: it is the
                   thing your eye knows a boat wake by. */
  float wWake = 0.0;
  for (int wi = 0; wi < ${MAX_WAKES}; wi++) {
    if (wi >= uWakeCount) break;
    vec4 wa = uWakeA[wi];
    vec2 wd = wP - wa.xy;
    float ws = -dot(wd, wa.zw);                    // metres astern of the hull
    vec4 wb = uWakeB[wi];
    if (ws < -1.0 || ws > wb.y) continue;
    float wlat = abs(wd.x * wa.w - wd.y * wa.z);   // metres off the track
    if (wlat > wb.x + ws * 0.42 + 3.0) continue;
    float wFade = 1.0 - ws / wb.y;
    wFade *= wFade;
    float wSpread = wb.x + ws * 0.14;
    float wTrail = (1.0 - smoothstep(wSpread * 0.35, wSpread, wlat)) * wFade;
    float wArmD = (wlat - ws * 0.354 - wb.x * 0.55) / (0.95 + 0.055 * ws);
    float wArm = exp(-wArmD * wArmD) * wFade * smoothstep(0.5, 4.0, ws);
    wWake += (wTrail * 0.80 + wArm * 1.00) * wb.z;
  }
  wWake = clamp(wWake, 0.0, 1.0) * (0.44 + 0.70 * wLace);
  wFoam = clamp(max(wFoam, wWake), 0.0, 1.0);

  wCol = mix(wCol, uFoamC * uFoamMul, wFoam * 0.92);
  wCol *= uBodyMul;

  /* Split the body colour between lit diffuse and an unlit floor. A tower
     shadow landing on a fully-lit turquoise plane drops it to grey-blue and
     reads as an oil slick, not as shade; carrying some of the colour unlit
     keeps the shadow as a tonal shift instead of a stain. The floor itself is
     uSelfLit, and it collapses to ~0 after dark: an unlit term is by
     definition immune to the sun going down, which is precisely how the bay
     ended up out-glowing the city it reflects.
     The lit share went 0.62 -> 0.78 as the unlit floor went 0.40 -> 0.18, so
     the bay sits at the same level it was reviewed at and the difference lands
     entirely in contrast: the wave shading, the shadows and the reflection all
     used to be divided by a large constant that no longer exists. */
  diffuseColor.rgb = wCol * 0.78;

  /* Foam is matte and opaque; open water is a near-mirror. */
  float wRough = mix(0.20, 0.76, wFoam);
  wRough = mix(wRough, min(0.9, wRough + 0.16), wRiv * 0.6);

  /* ---- reflection ----------------------------------------------------
     The scene IBL is NOT used for this surface. Its lower hemisphere is warm
     asphalt (correct for a facade, wrong for a sea), and at the grazing angles
     this camera hits the bay at, a 5 degree wave slope swings the reflected
     ray back and forth across that horizon seam — which paints the bay in hard
     scalloped blotches. An analytic sky, plus the planar target where the
     skyline actually covers it, has no seam to cross. */
  /* wSlopeN, not wNormal. The reflected ray is the one place a few degrees of
     wave slope turns into a large colour change, because it sweeps the ray
     across the whole sky gradient — from a pale horizon haze to a saturated
     zenith. On the calm shading normal that sweep is a couple of per cent and
     the bay mirrors one colour. */
  vec3 wR = reflect(-wV, wSlopeN);
  vec3 wSky = mix(uSkyLo, uSkyHi, pow(clamp(wR.y, 0.0, 1.0), 0.42));
  // Glare path. uSkyLo/uSkyHi/uSunTint/uSunDirW are all live: at golden hour
  // this lays an orange road down the bay toward the real sun, and after dark
  // it becomes a narrow cold moon path, because the direction and the colour
  // both come from the cycle instead of from a build-time snapshot of 14:24.
  wSky += uSunTint * pow(max(dot(wR, uSunDirW), 0.0), 130.0) * uGlareGain;

  /* Projective lookup, not screen UV: a mirrored look-at frame is left-handed,
     so the target is horizontally flipped and only its own projection reads it
     back correctly. */
  vec2 wRefUv = vReflCoord.xy / max(vReflCoord.w, 1e-4);
  /* STRONGLY ANISOTROPIC, and that is not a stylistic preference. A reflected
     vertical edge in real water wanders very little sideways and smears a great
     deal up and down, because a wave tilted toward you moves the reflected
     point along the line of sight, not across it. Distorting both axes by
     comparable amounts is exactly what turned the night skyline into wriggling
     noodles — the lateral term is now less than half what it was and the
     vertical term carries the break-up instead. */
  /* The river gets several times the distortion of the bay, and it is not a
     stylistic choice. Over open water the reflected towers arrive as separated
     columns with dark chop between them, which breaks them up for free. Over a
     60 m channel with a continuous podium wall standing on its bank, every tap
     lands on the same lit facade and the sum came back as ONE hard-edged
     rectangle lying on the water — read as a stain, not as a reflection, and
     most of why that channel looked like a tiled pool. */
  float wRivBlur = 1.0 + 3.2 * wRiv;
  wRefUv = clamp(wRefUv + wG.xy * vec2(0.020, 0.088) * wRivBlur,
                 vec2(0.002), vec2(0.998));
  /* Five taps smeared along screen-vertical. Two things at once: it dissolves
     the reflected skyline's stepped silhouette (a row of box crowns mirrors
     into a hard staircase, which reads as a stain rather than as buildings),
     and a vertically smeared reflection is what water actually does.
     The spread GROWS with distance offshore: far water is seen at a shallower
     angle, so one pixel of it integrates far more of the wave field, and the
     reflection has to dissolve accordingly. A reflection that stays equally
     crisp 400 m out is a decal. */
  float wRefStep = 0.0072 * (1.0 + 2.2 * smoothstep(0.0, 220.0, wSdF)) * wRivBlur;
  vec4 wRefl = texture2D(uRefl, wRefUv) * 0.34
    + texture2D(uRefl, clamp(wRefUv + vec2(0.0, wRefStep), 0.002, 0.998)) * 0.22
    + texture2D(uRefl, clamp(wRefUv - vec2(0.0, wRefStep), 0.002, 0.998)) * 0.22
    + texture2D(uRefl, clamp(wRefUv + vec2(0.0, wRefStep * 2.4), 0.002, 0.998)) * 0.11
    + texture2D(uRefl, clamp(wRefUv - vec2(0.0, wRefStep * 2.4), 0.002, 0.998)) * 0.11;
  vec3 wMirror = mix(wSky, wRefl.rgb * uReflAmt, wRefl.a * 0.95);

  /* A REFLECTION MAY NOT OUT-SHINE WHAT IT REFLECTS.
     In the open bay the lit towers mirror into separated columns with dark
     water between them and nothing ever binds. Over the river the camera sees a
     40 m strip entirely covered by the reflection of the podium wall standing
     right behind it, every tap lands on a lit window, and the sum came back as
     a solid blown yellow rug measurably brighter than the street on its bank —
     the same defect this module exists to remove, one bounce further along.
     Compressing only above 0.85 leaves the whole daylight range and every
     separated night column untouched; it binds solely on saturated sheets. */
  float wMirL = max(wMirror.r, max(wMirror.g, wMirror.b));
  wMirror *= 1.0 / (1.0 + max(0.0, wMirL - 0.85) * 0.85);

  float wFres = 0.02 + 0.98 * pow(1.0 - clamp(dot(wNormal, wV), 0.0, 1.0), 5.0);
  /* Honest Fresnel is wrong at both ends for this camera. Looking steeply down
     it puts the skyline at 4%, and the reflected towers are the money shot, so
     covered pixels get a floor. Looking near-horizontally down the channel it
     goes past 0.9 and the bay turns into a sheet of white sky, so it is capped
     — Biscayne Bay has to stay turquoise all the way out.
     The river factor is silt: the Miami River carries far too much of it to
     mirror a skyline the way the open bay does, and damping the mix here is
     also the cheapest place to stop a 40 m channel filling bank to bank with
     reflected windows. */
  float wMix = clamp(wFres + wRefl.a * uMixFloor, 0.0, uMixCap) * (1.0 - wRiv * 0.50);
  vec3 wEmissive = wMirror * wMix * (1.0 - wFoam * 0.85) + wCol * uSelfLit;
  diffuseColor.rgb *= 1.0 - wMix * 0.55;      // what reflects does not transmit

  /* Glitter: only inside the key's specular path, and faded out once one
     screen pixel covers more than a wave crest — otherwise the far bay turns
     into television static. Tightness is live, because moon glitter is a much
     harder, narrower path than sun glitter and reusing the sun's exponent
     after dark spreads it into a milky sheen.
     wFacetN, not wNormal: see the three-normal block above for the measurement.
     On the shading normal this term evaluated to 2e-6 at the reviewed hour, in
     other words the bay has never had any sun glitter on it at all. */
  vec3 wH = normalize(uSunDirW + wV);
  float wPath = pow(max(dot(wFacetN, wH), 0.0), uGlintTight);
  float wGlint = wNoise(wP * 1.35 + vec2(wT * 0.55, -wT * 0.38))
               * wNoise(wP * 3.30 - vec2(wT * 0.90, wT * 0.62));
  wEmissive += uSunTint * smoothstep(0.60, 0.94, wGlint) * wPath * 3.2 * uGlintGain
             * wNear * (1.0 - wFoam);

  /* City spill. After dark the promenade lamps, shopfronts and signage throw
     light onto the first few tens of metres of water; without it a lit city
     meets the bay along a hard black line and the whole waterfront reads as a
     cut-out. uSpill is zero by day, so this costs a multiply and nothing else.
     Modulated by the wave gradient so it shimmers instead of sitting there as
     a painted band, and killed inside foam, which is already bright. */
  float wSpillK = (1.0 - smoothstep(0.0, 40.0, wSdF))
                * (0.40 + 0.90 * wLace)
                * (0.55 + 2.4 * length(wG))
                * (1.0 - wFoam * 0.6);
  wEmissive += uSpill * wSpillK;
`;

/* =========================================================== materials === */

function makeWaterMaterial(uniforms) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.2,
    metalness: 0.0,
    // Deliberately low: this surface supplies its own sky reflection. See the
    // reflection block in WATER_BODY for why the scene IBL cannot be used here.
    envMapIntensity: 0.30,
    dithering: true,
    // The land base plane runs 30 m past the bay edge under this surface; a
    // fixed metric gap stops resolving somewhere past 700 m, a depth-slope
    // offset does not.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        '#include <common>\nvarying vec3 vWaterPos;\nvarying vec4 vReflCoord;\nuniform mat4 uReflMat;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n'
        + 'vWaterPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n'
        + 'vReflCoord = uReflMat * vec4(vWaterPos, 1.0);'
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${WATER_PARS}`)
      .replace('#include <map_fragment>', WATER_BODY)
      .replace('#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = wRough;')
      .replace('#include <normal_fragment_maps>',
        '#include <normal_fragment_maps>\nnormal = wNormal;')
      .replace('#include <lights_fragment_end>',
        '#include <lights_fragment_end>\ntotalEmissiveRadiance += wEmissive;');
  };
  /* The bay is a ground-level surface and the promenade beside it is edible, so
     a hole opened on the waterfront reaches it. Uncut, the water sheet simply
     rendered over the void — a lid of turquoise lying across the hole, which is
     the one thing in the frame that must never have anything over it. */
  applyHoleCut(mat);
  mat.customProgramCacheKey = () => 'miami-water-v4-cut';
  return mat;
}

/* ========================================================= reflections === */

/**
 * The proxy's shader. Two states, cross-faded on nightFactor.
 *
 * WHY THE NIGHT STATE IS SYNTHESISED HERE RATHER THAN DARKENED
 * A reflection that only ever gets darker is a reflection that disappears, and
 * "the waterfront towers lighting up and smearing across the bay" is the shot
 * this whole module exists to deliver. So after dark the proxy stops being a
 * silhouette and becomes a light source: a near-black facade carrying a
 * stochastic lattice of lit windows plus a lit crown.
 *
 * WHY THE WINDOW LATTICE RUNS ON (x + z)
 * Every proxy box is axis aligned, so on an X-facing wall x is constant and the
 * sum sweeps with z; on a Z-facing wall it sweeps with x. One expression covers
 * both orientations and needs no normal attribute (which the proxy deletes, to
 * keep the merge small). The only surface it degenerates on is a 45 deg wall,
 * and there are none.
 */
const PROXY_VERT = /* glsl */ `
  attribute vec3 color;
  attribute vec2 aInfo;          // x = per-building seed, y = height fraction
  varying vec3 vDay;
  varying vec2 vInfo;
  varying vec3 vW;
  void main() {
    vDay = color;
    vInfo = aInfo;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const PROXY_FRAG = /* glsl */ `
  uniform float uNight, uDayGain;
  uniform vec3  uDayTint, uWinWarm, uWinHome, uWinCool, uWinPink, uWinViolet, uNightBody;
  varying vec3 vDay;
  varying vec2 vInfo;
  varying vec3 vW;

  float pHash(vec2 p){
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }

  void main() {
    float u = (vW.x + vW.z) * 0.2817;                    // ~3.55 m window bays
    vec2  cell = vec2(floor(u), floor((vW.y - 3.0) * 0.2597));   // 3.85 m floors
    float sd = vInfo.x * 91.7;
    float r1 = pHash(cell + sd);
    float r2 = pHash(cell * 1.83 + sd + 17.0);
    // Occupancy varies per building: an office block at 2 a.m. is a grid of
    // four lit floors, a condo tower is speckled everywhere. One value for all
    // of them reads as a texture, not as a city.
    float occ = 0.22 + 0.36 * fract(vInfo.x * 7.13);
    float on  = step(1.0 - occ, r1);

    /* DAYLIGHT: the same lattice, spent as VALUE rather than as light. A
       reflected tower with no articulation in it arrives in bright water as an
       even grey smudge, and an even grey smudge reads as dirt on the lens, not
       as a building — which is exactly how the daylight reflection looked. A
       +-15% mullion/spandrel rhythm costs nothing here because the lattice is
       already computed for the night state below. */
    vec3 day = vDay * uDayTint * uDayGain * (0.86 + 0.28 * on + 0.10 * r2);

    /* The cool family is picked PER BUILDING, not per window. Miami lights its
       waterfront towers pink and violet, and a reflected skyline where every
       accent is the same aqua reads as an office park; scattering the accent
       across whole towers is what makes the bay look like Brickell. */
    float acc = fract(vInfo.x * 3.77);
    vec3 cool = acc < 0.17 ? uWinPink : (acc < 0.31 ? uWinViolet : uWinCool);
    vec3  wc  = r2 < 0.55 ? uWinWarm : (r2 < 0.86 ? uWinHome : cool);
    /* Podiums stay busy, crowns thin out — that vertical falloff is what makes
       the reflected column taper instead of sitting there as a solid bar. The
       podium end came down from 1.20 because the river reflects almost nothing
       BUT podium: the brightest band of the proxy was the only band that
       channel ever saw, and it filled bank to bank. */
    float band = mix(1.00, 0.62, smoothstep(0.15, 1.0, vInfo.y));
    vec3  win  = wc * on * band * (0.50 + 0.80 * r2);
    // The top few per cent of a Brickell tower is a lit cap, and in a
    // reflection that cap is the brightest thing in the frame.
    float crown = smoothstep(0.95, 0.995, vInfo.y);
    vec3 night = uNightBody * (0.45 + 1.0 * vInfo.y) + win + cool * crown * 1.10;

    gl_FragColor = vec4(mix(day, night, uNight), 1.0);
  }
`;

/**
 * Skyline proxy: one merged box per massing block, straight from the layout.
 * It is never seen directly — only mirrored in the bay — so a box with a baked
 * vertical gradient plus the night shader above is entirely sufficient, and it
 * keeps the reflection pass at two draw calls.
 */
function buildSkylineProxy(layout, uniforms) {
  const rng = makeRNG(0x5ea5);
  const geos = [];
  const haze = new THREE.Color(PALETTE.SKY_HORIZON);
  const glassC = new THREE.Color(PALETTE.GLASS_TEAL);
  const stone = new THREE.Color(PALETTE.CONCRETE_DARK);

  for (const b of layout.blocks) {
    const h = b.heightM || (b.floors || 0) * 3.4;
    if (h < 14) continue;
    const fp = b.footprint || { w: b.w * 0.8, d: b.d * 0.8 };
    const g = new THREE.BoxGeometry(fp.w, h, fp.d);
    g.translate(b.x, h / 2, b.z);

    const base = (b.style === 'glass' || b.style === 'tower')
      ? glassC.clone().lerp(haze, 0.16)
      : stone.clone().lerp(haze, 0.24);
    // Loud per-building value spread: a reflected block of towers that is all
    // one value reads as a stain on the bay, not as a skyline.
    base.offsetHSL((rng() - 0.5) * 0.05, 0, (rng() - 0.5) * 0.20);
    const seed = rng();

    /* Vertical gradient baked into vertex colour: sky-lit crown, shaded base.
       A daylight reflection is read as a SILHOUETTE with a value ramp, nothing
       more — and it has to sit clearly DARKER than the sky it replaces. The
       first pass tinted the proxy toward the horizon haze until it matched the
       reflected sky exactly, and the towers became mathematically present and
       visually invisible. */
    const pos = g.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const info = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      const t = THREE.MathUtils.clamp(pos.getY(i) / Math.max(1, h), 0, 1);
      const k = 0.20 + 0.55 * t;
      col[i * 3] = base.r * k;
      col[i * 3 + 1] = base.g * k;
      col[i * 3 + 2] = base.b * k;
      info[i * 2] = seed;
      info[i * 2 + 1] = t;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aInfo', new THREE.BufferAttribute(info, 2));
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    geos.push(g);
  }
  if (!geos.length) return null;
  const merged = BufferGeometryUtils.mergeGeometries(geos, false);
  for (const g of geos) g.dispose();

  /*
   * DoubleSide is load-bearing, not a precaution. Mirroring the camera flips
   * the handedness of the view matrix, so every triangle's winding flips in
   * screen space and three's FrontSide culling throws away exactly the faces
   * the reflection is supposed to show — leaving the far INTERIOR wall of each
   * box. That is why the reflected skyline used to be a set of pale
   * washed-out streaks with no facade detail in them, and it is why the window
   * lattice below would have landed on the wrong surface.
   */
  return new THREE.Mesh(merged, new THREE.ShaderMaterial({
    uniforms,
    vertexShader: PROXY_VERT,
    fragmentShader: PROXY_FRAG,
    side: THREE.DoubleSide,
    fog: false,
  }));
}

/** Bridge footprints as (centreX, centreZ, halfWidth, halfLength), inset. */
function bridgeCutouts(layout) {
  const out = [];
  for (const b of (layout.bridges || []).slice(0, 6)) {
    out.push(new THREE.Vector4(b.x, b.z, Math.max(1, b.width / 2 - 1.6), Math.max(1, b.length / 2 - 1.6)));
  }
  while (out.length < 6) out.push(new THREE.Vector4(0, 0, -1, -1));
  return out;
}

function blankTexture() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  t.needsUpdate = true;
  return t;
}

function installReflection(ctx, uniforms, proxyU, hooks) {
  const proxy = buildSkylineProxy(ctx.layout, proxyU);
  if (!proxy) return;

  const rt = new THREE.WebGLRenderTarget(1024, 576, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: true,
    generateMipmaps: false,
  });
  rt.texture.minFilter = THREE.LinearFilter;
  rt.texture.magFilter = THREE.LinearFilter;
  rt.texture.colorSpace = THREE.NoColorSpace;
  uniforms.uRefl.value = rt.texture;

  const rScene = new THREE.Scene();
  proxy.frustumCulled = false;
  rScene.add(proxy);

  const vcam = new THREE.PerspectiveCamera();
  const mirrorY = WATER_Y;
  const camPos = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  const camUp = new THREE.Vector3();
  const target = new THREE.Vector3();
  const prevColor = new THREE.Color();
  /* Whatever the proxy did not cover clears to a dim horizon, LIVE — a target
     cleared to a baked afternoon haze bleeds a pale fringe around every
     reflected tower at midnight. */
  const fringe = new THREE.Color(PALETTE.SKY_HORIZON).multiplyScalar(0.5);
  // Clip space (-1..1) -> texture space (0..1).
  const bias = new THREE.Matrix4().set(
    0.5, 0, 0, 0.5,
    0, 0.5, 0, 0.5,
    0, 0, 0.5, 0.5,
    0, 0, 0, 1
  );
  /*
   * The target only needs filling when something that changes it changed.
   * Keying on uTime alone was wrong in two directions: GTAO renders the scene a
   * SECOND time each frame for its normal buffer (same uTime — must skip), and
   * the menu camera orbits while the game clock is stopped (same uTime — must
   * NOT skip). Key on the camera pose and the clock together and both cases
   * fall out correctly.
   */
  const pose = new Float32Array(9).fill(NaN);
  const posesMatch = (camera, t) => {
    const p = camera.position, q = camera.quaternion;
    const same = pose[0] === p.x && pose[1] === p.y && pose[2] === p.z
      && pose[3] === q.x && pose[4] === q.y && pose[5] === q.z && pose[6] === q.w
      && pose[7] === t && pose[8] === camera.aspect;
    pose[0] = p.x; pose[1] = p.y; pose[2] = p.z;
    pose[3] = q.x; pose[4] = q.y; pose[5] = q.z; pose[6] = q.w;
    pose[7] = t; pose[8] = camera.aspect;
    return same;
  };

  hooks.push((renderer, scene, camera) => {
    // The fringe follows the sky the proxy is standing in front of.
    const dn = scene.userData.dayNight;
    if (dn) fringe.copy(dn.skyLo).multiplyScalar(0.5);

    const tod = scene.userData.timeOfDay || 0;
    if (posesMatch(camera, uniforms.uTime.value + tod)) return;

    camera.getWorldPosition(camPos);
    camera.getWorldDirection(camDir);
    camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    target.copy(camPos).add(camDir);

    vcam.fov = camera.fov;
    vcam.aspect = camera.aspect;
    vcam.near = camera.near;
    vcam.far = camera.far;
    vcam.position.set(camPos.x, 2 * mirrorY - camPos.y, camPos.z);
    vcam.up.set(camUp.x, -camUp.y, camUp.z);       // the camera's up, mirrored
    vcam.lookAt(target.x, 2 * mirrorY - target.y, target.z);
    vcam.updateProjectionMatrix();
    vcam.updateMatrixWorld(true);

    uniforms.uReflMat.value
      .copy(bias)
      .multiply(vcam.projectionMatrix)
      .multiply(vcam.matrixWorldInverse);

    const prevRT = renderer.getRenderTarget();
    const prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(prevColor);
    renderer.setRenderTarget(rt);
    renderer.setClearColor(fringe, 0);
    renderer.clear(true, true, false);
    renderer.render(rScene, vcam);
    renderer.setRenderTarget(prevRT);
    renderer.setClearColor(prevColor, prevAlpha);
  });
}

/* ------------------------------------------------------- day and night --- */

/** Lerp an authored [r,g,b] pair straight into a working-space colour. */
function lerpRGB(out, a, b, t) {
  return out.setRGB(
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t
  );
}

/**
 * Resolve every light-dependent uniform from the live cycle. Runs once per
 * rendered frame off the water mesh's own onBeforeRender — see the header for
 * why this module does not wait to be called by game.js.
 *
 * Cost is about forty lerps and no allocation, which is why it runs
 * unconditionally rather than trying to detect that the hour has not moved.
 */
function makeLightingUpdate(scene, uniforms, proxyU) {
  const spec = new THREE.Vector3(0, 1, 0);
  const tint = new THREE.Color();
  /* Sodium street lighting with a bite of Miami aqua in it. Scaled small on
     purpose: this term exists to stop the waterfront ending in a hard black
     line, not to light the bay. */
  const SPILL_NIGHT = new THREE.Color(PALETTE.SODIUM)
    .lerp(new THREE.Color(PALETTE.NEON_AQUA), 0.20)
    .multiplyScalar(0.155);

  return () => {
    const ud = scene.userData;
    const dn = ud.dayNight;
    const key = ud.sunDir;
    if (!dn || !key) return;                 // pre-contract engine: leave the seed values
    const night = THREE.MathUtils.clamp(ud.nightFactor || 0, 0, 1);
    const golden = THREE.MathUtils.clamp(ud.goldenFactor || 0, 0, 1);

    /*
     * SPECULAR DIRECTION. Not the key: the key is floored at 24 deg elevation
     * so its shadow ortho stays renderable, and a glitter path anchored 24 deg
     * up is a puddle of sparkle under the camera instead of the road of light
     * running to the horizon that a low sun actually lays on water.
     *
     * So the glitter follows the ASTRONOMICAL sun (which really does set),
     * softly floored just above the horizon, and hands over to the key — which
     * at night IS the moon — on nightFactor. Both share the same azimuth every
     * hour of the cycle, so this interpolation only ever moves the elevation:
     * the path rises and falls, it never swings sideways.
     */
    spec.copy(ud.sunDiscDir || key);
    if (spec.y < 0.045) { spec.y = 0.045; spec.normalize(); }
    uniforms.uSunDirW.value.copy(spec).lerp(key, night).normalize();

    uniforms.uSunTint.value.copy(dn.keyColor);
    uniforms.uSkyHi.value.copy(dn.skyHi);
    uniforms.uSkyLo.value.copy(dn.skyLo);
    uniforms.uNight.value = night;

    lerpRGB(uniforms.uBodyMul.value, DAY_LOOK.bodyMul, NIGHT_LOOK.bodyMul, night);
    lerpRGB(uniforms.uFoamMul.value, DAY_LOOK.foamMul, NIGHT_LOOK.foamMul, night);
    const mix1 = (k) => DAY_LOOK[k] + (NIGHT_LOOK[k] - DAY_LOOK[k]) * night;
    uniforms.uSelfLit.value = mix1('selfLit');
    uniforms.uGlareGain.value = mix1('glareGain') * (1 + 0.85 * golden);
    // Golden hour is the hour water is FOR. Widen and brighten the sparkle.
    uniforms.uGlintGain.value = mix1('glintGain') * (1 + 1.10 * golden);
    uniforms.uGlintTight.value = mix1('glintTight') * (1 - 0.32 * golden);
    uniforms.uMixFloor.value = mix1('mixFloor');
    uniforms.uMixCap.value = mix1('mixCap');
    uniforms.uReflAmt.value = mix1('reflAmt');
    uniforms.uSpill.value.copy(SPILL_NIGHT).multiplyScalar(night);

    /* ---- the reflected skyline ---- */
    proxyU.uNight.value = night;
    // Tint the daylight proxy halfway toward the key's hue so the reflected
    // city goes orange when the city does, and normalise out the key's own
    // brightness so only the HUE lands here — the level is uDayGain's job.
    tint.copy(dn.keyColor);
    const m = Math.max(tint.r, tint.g, tint.b) || 1;
    proxyU.uDayTint.value.setRGB(
      0.5 + 0.5 * tint.r / m, 0.5 + 0.5 * tint.g / m, 0.5 + 0.5 * tint.b / m
    );
    proxyU.uDayGain.value = THREE.MathUtils.clamp(dn.keyIntensity / 3.55, 0.5, 1.1);
  };
}

/* ------------------------------------------------------------- wakes ---- */

/**
 * Find the boats and hand the shader the nearest few that are under way.
 *
 * WHY THIS READS THE REGISTRY INSTEAD OF ASKING vehicles.js
 * vehicles.js owns the boats and already moves them; water.js owns the water
 * they move through. Neither module may edit the other, and inventing a
 * cross-module callback would have needed both. The registry is the shared
 * surface that already exists: boats are registered dynamic consumables whose
 * `kind` is their FLEET key and whose `position` vehicles.js updates every
 * frame. Reading it is free and needs nobody's cooperation.
 *
 * Heading comes from the position DELTA rather than from any velocity the other
 * module might expose, so this keeps working whatever vehicles.js does
 * internally — including the jet skis, which weave.
 *
 * WHY "UNDER WAY" IS A DISPLACEMENT TEST AND NOT A SPEED TEST
 * The obvious version divides the frame's displacement by a frame time and
 * thresholds the speed. There is no honest frame time available here. uTime is
 * a WALL clock (game.js feeds it clock.elapsedTime) while the simulation runs
 * on whatever dt it is handed — and the screenshot harness drives the game
 * synchronously, so it advances the boats a sixtieth of a second at a time
 * while the wall clock stands still. Measured: every wake in every captured
 * frame came out as zero. performance.now() fails the same test from the other
 * end, reporting 4 m/s hulls as doing 0.02 m/s because one software-rendered
 * frame takes ten seconds.
 *
 * Displacement needs no clock and answers the question exactly: vehicles.js
 * writes a moored hull's x and z as constants and only heaves it in y, so ANY
 * horizontal movement means the boat is under way. Wake size then comes off the
 * hull, which is a property of the boat rather than of the frame rate.
 */
function makeWakeTracker(ctx, uniforms) {
  const registry = ctx.registry;
  const camPos = new THREE.Vector3();
  /** Preallocated so a per-frame sort does not churn the heap. */
  const cand = [];
  for (let i = 0; i < 64; i++) cand.push({ x: 0, z: 0, dx: 0, dz: 0, d2: 0, r: 1 });
  let boats = null;
  let prev = null;

  return (renderer, scene, camera) => {
    if (boats === null) {
      // water.js builds FIRST, so there are no boats to find until the world is
      // finished. Resolve on the first rendered frame, once.
      boats = [];
      for (const c of registry.dynamics) if (WAKE_KINDS.has(c.kind)) boats.push(c);
      prev = new Float32Array(boats.length * 2);
      for (let i = 0; i < boats.length; i++) {
        prev[i * 2] = boats[i].position.x;
        prev[i * 2 + 1] = boats[i].position.z;
      }
      return;
    }

    camera.getWorldPosition(camPos);
    let n = 0;
    let moved = 0;
    for (let i = 0; i < boats.length; i++) {
      const c = boats[i];
      const p = c.position;
      const dx = p.x - prev[i * 2], dz = p.z - prev[i * 2 + 1];
      const d = Math.hypot(dx, dz);
      // A stationary frame (the GTAO pass re-rendering the same one) must not
      // wipe the heading of everything that IS moving, so hold the previous
      // sample until something actually moves.
      if (d > 1e-4) { prev[i * 2] = p.x; prev[i * 2 + 1] = p.z; moved++; }
      if (c.state >= 1) continue;                 // being eaten, or gone
      if (d <= 1e-4) continue;
      if (n >= cand.length) break;
      const e = cand[n++];
      e.x = p.x; e.z = p.z;
      e.dx = dx / d; e.dz = dz / d;
      e.r = c.radius || 2;
      const ox = p.x - camPos.x, oz = p.z - camPos.z;
      e.d2 = ox * ox + oz * oz;
    }
    if (!moved) return;                           // nothing advanced; keep the last set

    // Spend the handful of shader slots on what the player can actually see.
    const near = cand.slice(0, n).sort((a, b) => a.d2 - b.d2);
    const used = Math.min(MAX_WAKES, near.length);
    for (let i = 0; i < used; i++) {
      const w = near[i];
      uniforms.uWakeA.value[i].set(w.x, w.z, w.dx, w.dz);
      // Everything scales off the hull. A jet ski's radius is ~1 m and a cruise
      // ship's is ~20, and that spread is a better predictor of how much water
      // a boat throws than anything this module could measure per frame.
      uniforms.uWakeB.value[i].set(
        Math.max(1.1, w.r * 0.70),                       // half-beam of the trail
        THREE.MathUtils.clamp(22 + w.r * 5.5, 24, 165),  // how far it survives
        THREE.MathUtils.clamp(0.42 + w.r * 0.035, 0.42, 0.95), // how hard it foams
        0
      );
    }
    uniforms.uWakeCount.value = used;
  };
}

/* ============================================================== build === */

export function buildWater(ctx) {
  const { scene, layout } = ctx;
  const g = ctx.group('water');
  const rng = makeRNG(0x0cea11);

  const field = buildShoreField(layout);

  /* ------------------------------------------------------- uniforms ---
   * SEED VALUES ONLY. Every light-dependent one of these is overwritten from
   * scene.userData before the first pixel is drawn (makeLightingUpdate runs at
   * the top of the water mesh's onBeforeRender). They are seeded from LIGHTING
   * so that a build without the day/night contract — or the single frame
   * between construction and the first render — still looks like the authored
   * afternoon rather than like black. */
  const sunEl = THREE.MathUtils.degToRad(LIGHTING.SUN_ELEVATION);
  const sunAz = THREE.MathUtils.degToRad(LIGHTING.SUN_AZIMUTH);
  const sunDir = new THREE.Vector3(
    Math.sin(sunAz) * Math.cos(sunEl),
    Math.sin(sunEl),
    Math.cos(sunAz) * Math.cos(sunEl)
  ).normalize();

  const wakeA = [], wakeB = [];
  for (let i = 0; i < MAX_WAKES; i++) {
    wakeA.push(new THREE.Vector4(0, 0, 0, 1));
    wakeB.push(new THREE.Vector4(1, 1, 0, 0));
  }

  const uniforms = {
    uTime: { value: 0 },
    uShoreMap: { value: field.tex },
    uShoreOrigin: { value: new THREE.Vector2(FIELD.x0, FIELD.z0) },
    uShoreSize: { value: new THREE.Vector2(FIELD.w * FIELD.cell, FIELD.h * FIELD.cell) },
    uShoreRanges: { value: new THREE.Vector2(SD_RANGE, DEPTH_RANGE) },
    uDeep: { value: new THREE.Color(PALETTE.SEA_DEEP) },
    uMidC: { value: new THREE.Color(PALETTE.SEA_MID) },
    uShallow: { value: new THREE.Color(PALETTE.SEA_SHALLOW) },
    uFoamC: { value: new THREE.Color(PALETTE.SEA_FOAM) },
    /* PALETTE.WATER_RIVER is already the greener of the two water entries, but
       read straight it is still a clean teal, and a clean teal in a 40 m
       channel with hard bulkheads on both sides renders as a swimming pool —
       which is what the `river` preset looked like. Pulling it a little toward
       wet sand and taking the level down puts the silt back without inventing
       a colour or editing another agent's palette. */
    /* Measured off the `river` preset: at 0.13 silt and 0.86 level the channel
       still rendered LIGHTER and more saturated than Biscayne Bay in the same
       build, which is backwards — the bay is clear ocean over sand and the
       Miami River is a dredged industrial channel. More silt, and a level that
       puts the thalweg clearly under the bay it drains into. */
    uRiverC: {
      value: new THREE.Color(PALETTE.WATER_RIVER)
        .lerp(new THREE.Color(PALETTE.SAND_WET), 0.20)
        .multiplyScalar(0.70),
    },
    // The far bay: uDeep held down, NOT slid toward navy. See the depth grade.
    uAbyss: { value: new THREE.Color(PALETTE.SEA_DEEP).multiplyScalar(0.72) },
    // Wet sand under the first few metres. A real colour, not a brightened
    // shallow — see the wash in WATER_BODY for what that cost us.
    uSandC: { value: new THREE.Color(PALETTE.SAND_WET) },
    uSunDirW: { value: sunDir },
    uSunTint: { value: new THREE.Color(LIGHTING.SUN_COLOR) },
    // Matched to the sky dome's own radiance so the reflected horizon and the
    // real horizon are the same colour where they meet.
    uSkyHi: { value: new THREE.Color(LIGHTING.SKY_MID).multiplyScalar(LIGHTING.SKY_GAIN) },
    uSkyLo: { value: new THREE.Color(PALETTE.SKY_HORIZON).multiplyScalar(LIGHTING.SKY_GAIN * 1.04) },
    /* ---- driven by makeLightingUpdate, seeded at the day endpoint ---- */
    uNight: { value: 0 },
    uBodyMul: { value: new THREE.Color().setRGB(...DAY_LOOK.bodyMul) },
    uFoamMul: { value: new THREE.Color().setRGB(...DAY_LOOK.foamMul) },
    uSpill: { value: new THREE.Color(0, 0, 0) },
    uSelfLit: { value: DAY_LOOK.selfLit },
    uGlareGain: { value: DAY_LOOK.glareGain },
    uGlintGain: { value: DAY_LOOK.glintGain },
    uGlintTight: { value: DAY_LOOK.glintTight },
    uMixFloor: { value: DAY_LOOK.mixFloor },
    uMixCap: { value: DAY_LOOK.mixCap },
    // Replaced by the live target as soon as the reflection pass installs; the
    // 1x1 transparent fallback keeps the sampler bound if it never does.
    uRefl: { value: blankTexture() },
    uReflMat: { value: new THREE.Matrix4() },
    uReflAmt: { value: DAY_LOOK.reflAmt },
    uRiverZ: { value: WORLD.RIVER_Z },
    uBridges: { value: bridgeCutouts(layout) },
    uBridgeCount: { value: Math.min(6, (layout.bridges || []).length) },
    uWakeA: { value: wakeA },
    uWakeB: { value: wakeB },
    uWakeCount: { value: 0 },
    // Legacy alias so anything that reached for the old foam colour still works.
    uFoam: { value: new THREE.Color(PALETTE.SEA_FOAM) },
  };

  /* The reflected skyline's own shading. Shared with makeLightingUpdate, which
     is what makes the city in the bay light up as the city does. */
  const proxyU = {
    uNight: { value: 0 },
    uDayGain: { value: 1 },
    uDayTint: { value: new THREE.Color(1, 1, 1) },
    uWinWarm: { value: new THREE.Color(PALETTE.WINDOW_OFFICE) },
    uWinHome: { value: new THREE.Color(PALETTE.WINDOW_HOME) },
    uWinCool: { value: new THREE.Color(PALETTE.NEON_AQUA).multiplyScalar(0.85) },
    // Held below the aqua on purpose: NEON_PINK and NEON_PURPLE are saturated
    // in one or two channels, and at parity they punch a hole in the reflection
    // that the warm families never do.
    uWinPink: { value: new THREE.Color(PALETTE.NEON_PINK).multiplyScalar(0.78) },
    uWinViolet: { value: new THREE.Color(PALETTE.NEON_PURPLE).multiplyScalar(0.72) },
    // Unlit concrete under a night sky: not black, but far below its windows.
    uNightBody: { value: new THREE.Color(PALETTE.SKY_MID).multiplyScalar(0.055) },
  };

  /* -------------------------------------------------- water surface --- */
  const geos = [];

  // Inshore: greedy rectangles over the water mask, dilated onto the land so
  // the discard (not the geometry) owns the coastline.
  const { x0: gx0, z0: gz0, cell: gc, w: gw, h: gh } = GRID;
  const mask = new Uint8Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const x = gx0 + (i + 0.5) * gc;
      const z = gz0 + (j + 0.5) * gc;
      if (field.at(x, z) > -7) mask[j * gw + i] = 1;
    }
  }
  const used = new Uint8Array(gw * gh);
  let rects = 0;
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const s = j * gw + i;
      if (!mask[s] || used[s]) continue;
      let i2 = i;
      while (i2 + 1 < gw && mask[j * gw + i2 + 1] && !used[j * gw + i2 + 1]) i2++;
      let j2 = j;
      grow: while (j2 + 1 < gh) {
        for (let k = i; k <= i2; k++) {
          const t = (j2 + 1) * gw + k;
          if (!mask[t] || used[t]) break grow;
        }
        j2++;
      }
      for (let jj = j; jj <= j2; jj++) for (let ii = i; ii <= i2; ii++) used[jj * gw + ii] = 1;
      geos.push(quadXZ(
        gx0 + i * gc, gz0 + j * gc, gx0 + (i2 + 1) * gc, gz0 + (j2 + 1) * gc,
        WATER_Y, 0.02
      ));
      rects++;
    }
  }

  // Offshore apron. Subdivided so the per-vertex fog term has somewhere to
  // interpolate between the seawall and the haze.
  const off = new THREE.PlaneGeometry(
    OFFSHORE_FAR - OFFSHORE_X, OFFSHORE_FAR * 2, 22, 26
  ).rotateX(-Math.PI / 2);
  off.translate((OFFSHORE_X + OFFSHORE_FAR) / 2, WATER_Y, 0);
  geos.push(off);

  const waterMat = makeWaterMaterial(uniforms);
  const water = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(geos, false), waterMat);
  water.name = 'bay-water';
  water.receiveShadow = true;
  water.castShadow = false;
  water.frustumCulled = false;
  g.add(water);
  for (const q of geos) q.dispose();

  /* ------------------------------------------------- per-frame work ---
   * onBeforeRender is the hook, because it is the only one that fires once per
   * rendered frame without game.js having to call this module by name — and
   * game.js currently only drives uTime. Everything that has to follow the
   * clock hangs off here.
   *
   * ORDER MATTERS. The lighting resolve has to land before the reflection
   * render, or the proxy draws one frame behind the hour it is standing in.
   */
  const hooks = [makeLightingUpdate(scene, uniforms, proxyU)];
  hooks.push(makeWakeTracker(ctx, uniforms));
  installReflection(ctx, uniforms, proxyU, hooks);
  water.onBeforeRender = (renderer, rScene, camera) => {
    for (let i = 0; i < hooks.length; i++) hooks[i](renderer, rScene, camera);
  };

  /* -------------------------------------------- seawall + promenade --- */
  const shores = buildShorelines(field);
  const stats = buildShoreStructures(ctx, g, shores, field, rng);

  /* ------------------------------------------------------- marinas ---- */
  const marina = buildMarinas(ctx, g, layout, rng);

  ctx.waterUniforms = uniforms;
  scene.userData.waterUniforms = uniforms;
  scene.userData.shoreField = field;
  // Published so vehicles.js can float hulls on it and anyone else can ask
  // where the surface is instead of hardcoding a second copy of the number.
  scene.userData.waterY = WATER_Y;

  console.info(
    `[water] ${rects} surface rects | ${shores.length} shorelines / ` +
    `${Math.round(stats.length)} m of seawall | ${stats.bollards} bollards | ` +
    `${stats.piers} bridge piers | ${stats.steps} step flights | ` +
    `${marina.pontoons} pontoons / ${marina.piles} piles`
  );
  return g;
}

/* ------------------------------------------------ seawall + promenade --- */

/**
 * Seawall profile, swept along every shoreline. Offsets are metres from the
 * waterline; the outer face reaches well below the surface so no camera angle
 * can find a gap between the wall and the water.
 *
 * [offset, y, uv.v, r, g, b]
 */
const WALL_PROFILE = (() => {
  const C = SEAWALL_TOP - 0.07;            // arris chamfer start
  /* The coping has to separate in VALUE from both the promenade behind it and
     the water in front, or a 1.3 m parapet reads as a painted line from the
     game camera. Bright top, hard drop to a shaded face. */
  const clean = [0.90, 0.89, 0.86];
  const bright = [1.16, 1.15, 1.10];
  const shade = [0.70, 0.69, 0.67];
  const green = [0.50, 0.60, 0.49];        // algae at the tide line
  const sub = [0.30, 0.41, 0.35];
  return [
    /* inner face */
    [-1.34, 0.02, 0.02, ...[0.92, 0.91, 0.88]],
    [-1.34, COPING_LIP, 0.30, ...clean],
    /* duplicated rows give the sweep HARD edges; three's vertex-normal average
       would otherwise round every 90 degree turn into soft plasticine. The
       chamfer rows below are deliberately NOT duplicated, so those arrises get
       the rounded highlight the art bible asks for. */
    [-1.34, COPING_LIP, 0.30, ...clean],
    [-1.66, COPING_LIP, 0.38, ...shade],
    [-1.66, COPING_LIP, 0.38, ...shade],
    [-1.66, C, 0.42, ...bright],
    [-1.59, SEAWALL_TOP, 0.46, ...bright],
    /* coping top */
    [1.59, SEAWALL_TOP, 1.26, ...bright],
    [1.66, C, 1.30, ...bright],
    [1.66, COPING_LIP, 1.34, ...shade],
    [1.66, COPING_LIP, 1.34, ...shade],
    [1.34, COPING_LIP, 1.42, ...clean],
    /* Outer face. It points east, the key light comes from the north-west, so
       it is always the shaded plane — and that dark band under a bright coping
       is the whole reason a seawall reads as a wall from 300 m up. */
    [1.34, COPING_LIP, 1.42, ...clean],
    [1.34, 0.62, 1.56, ...[0.74, 0.75, 0.71]],
    [1.34, 0.22, 1.66, ...green],
    [1.34, -2.60, 2.34, ...sub],
  ];
})();

function buildShoreStructures(ctx, group, shores, field, rng) {
  const piers = buildBridgePiers(ctx.layout, field);
  const wallGeos = piers.geos;      // same concrete, so they cost no draw call
  const walkGeos = [];
  const vergeGeos = [];
  let totalLen = 0;
  let bollards = 0;
  let steps = 0;

  const layout = ctx.layout;
  const blocks = layout.blocks;
  /** Cheap point-in-block test so the promenade never paves over a park lot. */
  const inBlock = (x, z) => {
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (Math.abs(x - b.x) < b.w / 2 - 0.5 && Math.abs(z - b.z) < b.d / 2 - 0.5) return true;
    }
    return false;
  };

  for (const shore of shores) {
    totalLen += shore.length;
    wallGeos.push(sweepProfile(shore, WALL_PROFILE, {
      uScale: 0.25,
      // Slow tonal drift along the wall so a 1 km parapet is not one flat value.
      jitter: (p) => 0.95 + 0.09 * Math.sin(p.x * 0.031 + p.z * 0.047),
    }));

    /* Promenade / riverwalk apron behind the wall. Emitted band by band and
       dropped wherever a block or a carriageway already owns the ground —
       cityLayout pulls parcels 9 m back off the river, and that bare strip is
       exactly what this fills.
       -------------------------------------------------------------------
       THE BANDS CARRY A CROSS-SECTION NOW, and that is the whole point of
       emitting them separately in the first place. Laid at one flat tone the
       riverwalk rendered as ten metres of undifferentiated grey running the
       length of both banks — measured on the `river` preset it was the single
       largest featureless surface in the frame, and it is 400 m of it. A real
       waterfront edge is a sequence: a dark granite kerb band against the
       parapet, the paving field, then planting against the back of the walk.
       Three values and one hue is enough for a 3/4 camera to read it as a
       designed edge instead of a slab. */
    const { pts, nrm } = shore;
    /** Per-band: [tone, planted]. Band 0 sits against the coping. */
    const BANDS = [[0.78, false], [1.02, false], [0.92, false], [1.0, true]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const na = nrm[i], nb = nrm[i + 1];
      for (let bandI = 0; bandI < BANDS.length; bandI++) {
        const o0 = -1.66 - bandI * 2.1;
        const o1 = o0 - 2.1;
        const cx = (a.x + b.x) / 2 + ((na.x + nb.x) / 2) * (o0 + o1) / 2;
        const cz = (a.z + b.z) / 2 + ((na.z + nb.z) / 2) * (o0 + o1) / 2;
        if (layout.isRoad(cx, cz) || inBlock(cx, cz)) continue;
        if (field.at(cx, cz) > -0.8) continue;         // never pave open water
        const [bandTone, planted] = BANDS[bandI];
        const q = new THREE.BufferGeometry();
        const ax0 = a.x + na.x * o0 * na.s, az0 = a.z + na.z * o0 * na.s;
        const ax1 = a.x + na.x * o1 * na.s, az1 = a.z + na.z * o1 * na.s;
        const bx0 = b.x + nb.x * o0 * nb.s, bz0 = b.z + nb.z * o0 * nb.s;
        const bx1 = b.x + nb.x * o1 * nb.s, bz1 = b.z + nb.z * o1 * nb.s;
        const Y = ctx.Y_WALK + (planted ? 0.012 : 0);
        q.setAttribute('position', new THREE.Float32BufferAttribute([
          ax0, Y, az0, bx0, Y, bz0, bx1, Y, bz1, ax1, Y, az1,
        ], 3));
        q.setAttribute('normal', new THREE.Float32BufferAttribute([
          0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
        ], 3));
        q.setAttribute('uv', new THREE.Float32BufferAttribute([
          ax0 * 0.33, az0 * 0.33, bx0 * 0.33, bz0 * 0.33,
          bx1 * 0.33, bz1 * 0.33, ax1 * 0.33, az1 * 0.33,
        ], 2));
        q.setIndex([0, 2, 1, 0, 3, 2]);
        if (planted) {
          vergeGeos.push(q);
        } else {
          /* Bay-to-bay tonal drift ALONG the walk on top of the cross-section.
             Two stations of one band at one exact value is where the flatness
             comes back; the paving map's own 3 m repeat is not enough on a run
             this long. */
          const drift = 0.955 + 0.075
            * (Math.abs(Math.sin(cx * 0.37 + cz * 0.61) * 43758.5) % 1);
          withFlatColour(q, bandTone * drift);
          walkGeos.push(q);
        }
      }
    }

    /* Steps down to the water. Irregular, but they are the detail that says
       "people use this edge" rather than "this is a retaining wall" — and they
       break the coping line into episodes.
       Pitched at 95-190 m rather than 190-340: at the old interval a 400 m
       run of riverwalk carried one flight or none, so the episode the feature
       exists to create never landed inside a camera frame. */
    let sinceSteps = rng() * 90;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      sinceSteps += Math.hypot(b.x - a.x, b.z - a.z);
      if (sinceSteps < 95 + rng() * 95) continue;
      sinceSteps = 0;
      steps++;
      const nv = nrm[i];
      const ang = Math.atan2(nv.x, nv.z);
      for (let s = 0; s < 4; s++) {
        const y = COPING_LIP - 0.02 - s * 0.30;
        const out = 1.34 + 0.42 + s * 0.42;
        const g = new THREE.BoxGeometry(3.2, 0.32, 0.44);
        g.rotateY(ang);
        g.translate(b.x + nv.x * out, y, b.z + nv.z * out);
        wallGeos.push(withFlatColour(g, 0.98));
      }
      // Cheek walls either side, so the flight is not four floating slabs.
      for (const s of [-1, 1]) {
        const g = new THREE.BoxGeometry(0.34, 2.6, 2.4);
        g.rotateY(ang);
        g.translate(b.x + nv.x * 2.6 - Math.cos(ang) * s * 1.75,
          0.20, b.z + nv.z * 2.6 + Math.sin(ang) * s * 1.75);
        wallGeos.push(withFlatColour(g, 0.93));
      }
    }

    /* Mooring bollards on the coping, plus the occasional ladder and fender
       on the water face. Every one is a slot in a globally shared pool. */
    let run = rng() * 9;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const segLen = Math.hypot(b.x - a.x, b.z - a.z);
      run += segLen;
      if (run < 13 + rng() * 7) continue;
      run = 0;
      const t = 0.3 + rng() * 0.4;
      const px = a.x + (b.x - a.x) * t, pz = a.z + (b.z - a.z) * t;
      const nv = nrm[i];
      ctx.addInstanced('sea-bollard', bollardFactory, {
        position: new THREE.Vector3(px - nv.x * 0.35, SEAWALL_TOP - 0.02, pz - nv.z * 0.35),
        rotationY: rng() * 6.28,
        capacity: 900,
        tier: ctx.TIER.SMALL,
        radius: 0.36, height: 0.82,
        // NOT 'bollard': props.js registers 1,040 street bollards under that
        // kind, and the prop audit groups by kind and samples the first 40 —
        // which were all quay bollards sitting on the seawall coping over
        // water. The audit reported props.js's bollards as 100% floating and
        // in the sea, which is neither true nor about props.js at all.
        label: 'Mooring bollard', kind: 'mooringBollard',
        castShadow: true, receiveShadow: true,
      });
      bollards++;

      // One bollard in six has a gull on it. Cheap, and it is the thing that
      // makes a stone edge read as a waterfront.
      if (rng() < 0.17) {
        ctx.addInstanced('gull', gullFactory, {
          position: new THREE.Vector3(px - nv.x * 0.35, SEAWALL_TOP + 0.78, pz - nv.z * 0.35),
          rotationY: rng() * 6.28,
          capacity: 200,
          decor: true,
          castShadow: true, receiveShadow: false,
        });
      }

      if (rng() < 0.14) {
        // Access ladder: the rungs read at street level and the stringers keep
        // the wall from looking like an extruded profile from the air.
        ctx.addInstanced('sea-ladder', ladderFactory, {
          position: new THREE.Vector3(px + nv.x * 1.44, 0.0, pz + nv.z * 1.44),
          rotationY: Math.atan2(nv.x, nv.z),
          capacity: 220,
          decor: true,
          castShadow: true, receiveShadow: false,
        });
      }
      if (rng() < 0.20) {
        ctx.addInstanced('sea-fender', fenderFactory, {
          position: new THREE.Vector3(px + nv.x * 1.42, 0.42, pz + nv.z * 1.42),
          rotationY: Math.atan2(nv.x, nv.z),
          capacity: 400,
          decor: true,
          castShadow: false, receiveShadow: false,
        });
      }
    }
  }

  if (wallGeos.length) {
    /* HOLE-CUT, and it is not optional. The seawall is a ground-level structure
       standing on the promenade, and the promenade IS edible — take a 20 m bite
       out of Bayfront Park and an uncut parapet stays hanging over the void
       with its bollards on it. Named so `solid()`'s parameter cache cannot hand
       this patched instance to anyone else, and the program key is set
       explicitly afterwards because applyHoleCut pins a constant one that would
       otherwise discard the de-tiling variant baked into this material's
       source. */
    const mat = applyHoleCut(solid({
      map: Textures.concrete(512, PALETTE.SEAWALL),
      vertexColors: true,
      roughness: 0.93,
      metalness: 0.0,
      envMapIntensity: 0.45,
      name: 'water-seawall',
    }));
    mat.customProgramCacheKey = () => 'miami-seawall-cut-v1';
    const mesh = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(wallGeos, false), mat);
    mesh.name = 'seawall';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    for (const q of wallGeos) q.dispose();
  }

  if (walkGeos.length) {
    const mat = ground({
      map: Textures.paving(512, PALETTE.PLAZA, 'rgba(150,144,132,0.5)', 5),
      roughness: 0.95,
      vertexColors: true,
      // Coplanar with the block sidewalk slabs where they overlap; the offset
      // is what keeps that join from shimmering.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(walkGeos, false), mat);
    mesh.name = 'promenade';
    mesh.receiveShadow = true;
    group.add(mesh);
    for (const q of walkGeos) q.dispose();
  }

  /* The planted band at the back of the walk. One extra draw call, and it is
     the only green anywhere on 800 m of riverbank — against four values of grey
     paving it is worth several times what another paving tone would be. */
  if (vergeGeos.length) {
    const mesh = new THREE.Mesh(
      BufferGeometryUtils.mergeGeometries(vergeGeos, false),
      ground({
        map: Textures.grass(),
        roughness: 0.95,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
      })
    );
    mesh.name = 'promenade-verge';
    mesh.receiveShadow = true;
    group.add(mesh);
    for (const q of vergeGeos) q.dispose();
  }

  return { length: totalLen, bollards, steps, piers: piers.count };
}

/* -------------------------------------------------------- bridge piers --- */

/**
 * PIERS UNDER EVERY RIVER CROSSING.
 *
 * These did not exist. streets.js's buildBridge() says "piers are deliberately
 * NOT built here — water.js already stands two pier walls under every entry in
 * layout.bridges", and the foot of this file said the opposite; both comments
 * were written against a version of the other module that no longer does it, so
 * four crossings spanned open water on nothing at all.
 *
 * WHAT IS ACTUALLY VISIBLE, and why the pier is shaped the way it is.
 * DECK_Y is a hard contract with vehicles.js at 1.20 m and the water sits at
 * 0.12, so the soffit clears the channel by 18 cm — there is no headroom to
 * show a pier IN. The read has to come from outboard instead: each pier is
 * wider than the deck it carries, so it emerges either side of the fascia as a
 * chunky block standing in the water with a ledge under the parapet. From the
 * river camera that row of blocks marching across the channel is the whole
 * difference between a bridge and a strip of asphalt lying on the bay.
 *
 * The long axis runs ACROSS the deck, which for every crossing here is ALONG
 * the current (the roads run north/south, the river runs east/west), so the
 * cutwaters land on the two ends that actually face the flow.
 */
const PIER_TOP = 1.06;      // just under the 1.20 m deck: the ledge is the read
const PIER_BOT = -2.80;     // well below the surface, so no angle finds its foot

function buildBridgePiers(layout, field) {
  const geos = [];
  let count = 0;
  const H = PIER_TOP - PIER_BOT;
  const Y = (PIER_TOP + PIER_BOT) / 2;

  for (const br of layout.bridges || []) {
    const alongZ = br.length >= br.width;
    const half = (alongZ ? br.length : br.width) / 2;
    const c = alongZ ? br.z : br.x;          // centre along the span
    const cross = alongZ ? br.x : br.z;      // the road's fixed coordinate
    const halfW = br.width / 2;
    // ~13 m bays. Closer reads as a viaduct, wider as a bridge with no piers.
    const n = Math.max(2, Math.round((half * 2) / 13));
    for (let i = 0; i <= n; i++) {
      const t = c - half + (half * 2 * i) / n;
      const px = alongZ ? cross : t;
      const pz = alongZ ? t : cross;
      // Only in genuinely open channel. Everything nearer the bank than this is
      // under the approach embankment streets.js already builds, where a pier
      // would stand inside a wall.
      if (field.at(px, pz) < 4.0) continue;

      const shaftLen = halfW * 2 + 2.4;
      geos.push(withFlatColour(
        alongZ ? box(shaftLen, H, 2.5, px, Y, pz) : box(2.5, H, shaftLen, px, Y, pz),
        0.88
      ));
      // Cutwaters: a box on the diagonal, half buried in the shaft end, so the
      // pier presents a point to the current instead of a slab.
      for (const s of [-1, 1]) {
        const ox = alongZ ? s * shaftLen * 0.5 : 0;
        const oz = alongZ ? 0 : s * shaftLen * 0.5;
        geos.push(withFlatColour(
          box(1.9, H * 0.94, 1.9, px + ox, Y - H * 0.03, pz + oz, Math.PI / 4),
          0.96
        ));
      }
      count++;
    }
  }
  return { geos, count };
}

/* ---------------------------------------------------- prop factories --- */

/**
 * Cast-iron mooring bollard. Segment counts are deliberately mean: this is the
 * most-instanced thing the module owns (150+ of them along 3 km of quay), so
 * every triangle here is paid for a hundred and fifty times.
 */
function bollardFactory() {
  const parts = [];
  const shaft = new THREE.CylinderGeometry(0.19, 0.25, 0.62, 8, 1);
  shaft.translate(0, 0.31, 0);
  parts.push(shaft);
  const head = new THREE.SphereGeometry(0.24, 8, 3, 0, Math.PI * 2, 0, Math.PI * 0.55);
  head.scale(1, 0.75, 1);
  head.translate(0, 0.62, 0);
  parts.push(head);
  const foot = new THREE.CylinderGeometry(0.34, 0.38, 0.10, 8, 1);
  foot.translate(0, 0.05, 0);
  parts.push(foot);
  const geo = BufferGeometryUtils.mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return { geometry: geo, material: solid({ color: PALETTE.BOLLARD_DARK, roughness: 0.55, metalness: 0.25 }) };
}

function ladderFactory() {
  const parts = [];
  for (const s of [-1, 1]) {
    const g = new THREE.BoxGeometry(0.07, 2.1, 0.07);
    g.translate(s * 0.22, 0.35, 0);
    parts.push(g);
  }
  for (let i = 0; i < 5; i++) {
    const g = new THREE.BoxGeometry(0.50, 0.055, 0.055);
    g.translate(0, -0.45 + i * 0.4, 0);
    parts.push(g);
  }
  const geo = BufferGeometryUtils.mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return { geometry: geo, material: solid({ color: PALETTE.STEEL, roughness: 0.4, metalness: 0.6 }) };
}

function fenderFactory() {
  const g = new THREE.CylinderGeometry(0.22, 0.22, 0.62, 8, 1);
  g.rotateZ(Math.PI / 2);
  return { geometry: g, material: solid({ color: PALETTE.TYRE, roughness: 0.9, metalness: 0.0 }) };
}

function pileFactory() {
  const g = new THREE.CylinderGeometry(0.20, 0.24, 4.4, 8, 1);
  g.translate(0, 1.3, 0);
  return { geometry: g, material: solid({ color: PALETTE.DOCK_PILING, roughness: 0.92, metalness: 0.0 }) };
}

function cleatFactory() {
  const parts = [];
  const bar = new THREE.BoxGeometry(0.34, 0.07, 0.09);
  bar.translate(0, 0.19, 0);
  parts.push(bar);
  for (const s of [-1, 1]) {
    const p = new THREE.BoxGeometry(0.07, 0.16, 0.09);
    p.translate(s * 0.10, 0.10, 0);
    parts.push(p);
  }
  const geo = BufferGeometryUtils.mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return { geometry: geo, material: solid({ color: PALETTE.CHROME, roughness: 0.3, metalness: 0.7 }) };
}

function gullFactory() {
  const parts = [];
  const body = new THREE.SphereGeometry(0.13, 7, 5);
  body.scale(1.0, 0.95, 1.9);
  parts.push(body);
  const head = new THREE.SphereGeometry(0.075, 6, 4);
  head.translate(0, 0.11, 0.17);
  parts.push(head);
  const tail = new THREE.ConeGeometry(0.075, 0.20, 5);
  tail.rotateX(Math.PI / 2);
  tail.translate(0, 0.02, -0.30);
  parts.push(tail);
  const geo = BufferGeometryUtils.mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return { geometry: geo, material: solid({ color: 0xf6f2e6, roughness: 0.75, metalness: 0.0 }) };
}

function buoyFactory() {
  const parts = [];
  const body = new THREE.CylinderGeometry(0.34, 0.42, 1.0, 8, 1);
  body.translate(0, 0.5, 0);
  parts.push(body);
  const top = new THREE.ConeGeometry(0.30, 0.62, 8);
  top.translate(0, 1.28, 0);
  parts.push(top);
  const geo = BufferGeometryUtils.mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return { geometry: geo, material: solid({ color: 0xffffff, roughness: 0.55, metalness: 0.05 }) };
}

/* ------------------------------------------------------------ marinas --- */

/**
 * Floating pontoons in the basins cityLayout notched into the shore. Decking
 * for one basin is merged into a single consumable mesh — the fingers are all
 * one structure, so they are eaten as one — and the piles and cleats are slots
 * in the global instanced pools.
 */
function buildMarinas(ctx, group, layout, rng) {
  const basins = layout.basins || [];
  let pontoons = 0;
  let piles = 0;

  const deckMat = solid({
    map: Textures.wood(512, PALETTE.WOOD_DECK, 7),
    roughness: 0.88,
    metalness: 0.0,
  });

  const DECK_TOP = WATER_Y + 0.42;
  const DECK_BOT = WATER_Y - 0.16;
  const DECK_H = DECK_TOP - DECK_BOT;
  const DECK_Y = (DECK_TOP + DECK_BOT) / 2;

  for (const bs of basins) {
    const parts = [];
    const inset = 5;
    const zA = bs.z0 + inset, zB = bs.z1 - inset;
    const xA = bs.x0 + 6;
    const spineZ0 = zA, spineZ1 = zB;
    if (spineZ1 - spineZ0 < 6) continue;

    // Main walkway, running along the sheltered (landward) side of the basin.
    parts.push(box(2.4, DECK_H, spineZ1 - spineZ0, xA, DECK_Y, (spineZ0 + spineZ1) / 2));

    // Finger docks projecting toward the bay mouth.
    const fingerLen = Math.min(20, (bs.x1 - xA) - 8);
    const nFingers = Math.max(2, Math.floor((spineZ1 - spineZ0) / 9));
    for (let i = 0; i < nFingers; i++) {
      const z = spineZ0 + ((i + 0.5) / nFingers) * (spineZ1 - spineZ0);
      parts.push(box(fingerLen, DECK_H, 1.5, xA + 1.2 + fingerLen / 2, DECK_Y, z));
      // Piles at the outboard end and midway: what actually holds a pontoon.
      for (const fx of [xA + 3, xA + fingerLen]) {
        ctx.addInstanced('dock-pile', pileFactory, {
          position: new THREE.Vector3(fx, WATER_Y - 1.4, z + 1.35),
          capacity: 400, decor: true, castShadow: true, receiveShadow: false,
        });
        piles++;
      }
      for (let c = 0; c < 3; c++) {
        ctx.addInstanced('dock-cleat', cleatFactory, {
          position: new THREE.Vector3(xA + 4 + c * (fingerLen / 3.4), DECK_TOP, z + 0.62),
          rotationY: Math.PI / 2,
          capacity: 500, decor: true, castShadow: false, receiveShadow: false,
        });
      }
    }

    // Gangway from the quay to the spine — the thing that makes it read as
    // floating rather than as a plank lying on the water.
    parts.push(box(7.0, 0.22, 1.5, bs.x0 + 1.5, DECK_TOP + 0.16, (spineZ0 + spineZ1) / 2));

    // Fuel dock: a small kiosk at the head of the spine.
    parts.push(box(2.2, 2.0, 2.2, xA, WATER_Y + 1.4, spineZ0 + 1.4));

    for (let i = 0; i <= 4; i++) {
      const z = spineZ0 + (i / 4) * (spineZ1 - spineZ0);
      ctx.addInstanced('dock-pile', pileFactory, {
        position: new THREE.Vector3(xA - 1.5, WATER_Y - 1.4, z),
        capacity: 400, decor: true, castShadow: true, receiveShadow: false,
      });
      piles++;
    }

    const geo = BufferGeometryUtils.mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    const mesh = new THREE.Mesh(geo, deckMat);
    mesh.name = `pontoon-${bs.name}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    ctx.addMesh(mesh, {
      group: 'water',
      position: new THREE.Vector3((bs.x0 + bs.x1) / 2, DECK_TOP, (bs.z0 + bs.z1) / 2),
      radius: Math.max(bs.x1 - bs.x0, bs.z1 - bs.z0) * 0.42,
      height: 2.4,
      tier: ctx.TIER.HUGE,
      label: bs.name,
      kind: 'pontoon',
      crumbles: true,
      debrisColor: PALETTE.WOOD_DECK,
    });
    pontoons++;
  }

  /* Channel markers down the river. Cheap, and they tell you at a glance that
     the bend is a navigable channel rather than a puddle. */
  const river = layout.river;
  for (let x = -180; x < BAY - 20; x += 96) {
    const c = river.centerAt(x), h = river.halfAt(x);
    for (const s of [-1, 1]) {
      if (rng() < 0.35) continue;
      ctx.addInstanced('nav-buoy', buoyFactory, {
        position: new THREE.Vector3(x + rng() * 20, WATER_Y - 0.28, c + s * (h - 5)),
        rotationY: rng() * 6.28,
        hex: s < 0 ? 0xe8433a : 0x37c05a,
        capacity: 60,
        tier: ctx.TIER.MEDIUM,
        radius: 0.45, height: 1.9,
        label: 'Channel marker', kind: 'buoy',
        castShadow: true, receiveShadow: false,
      });
    }
  }

  return { pontoons, piles };
}

/**
 * Offline diagnostics for the shore extraction — the coastline is the one part
 * of this module that can be verified without a GPU, and doing it in node is
 * two orders of magnitude faster than a screenshot round trip.
 */
export function debugShore(layout) {
  const field = buildShoreField(layout);
  const lines = buildShorelines(field).map((s) => ({
    points: s.pts.length,
    length: +s.length.toFixed(0),
    closed: s.closed,
    x: [Math.min(...s.pts.map((p) => p.x)).toFixed(0), Math.max(...s.pts.map((p) => p.x)).toFixed(0)],
    z: [Math.min(...s.pts.map((p) => p.z)).toFixed(0), Math.max(...s.pts.map((p) => p.z)).toFixed(0)],
  }));
  return { field, lines };
}

/*
 * NO BRIDGE PIERS HERE. streets.js's buildBridge() now sinks its own piers from
 * -6.5 up into the soffit; a second set in the same channel positions would be
 * duplicate geometry and a guaranteed z-fight.
 */
