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
 */

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { WORLD, PALETTE } from '../config.js';
import { LIGHTING } from '../core/quality.js';
import { Textures, solid, ground } from '../core/materials.js';
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

      // Segment normals, then mitred vertex normals. The sign is settled by
      // probing the field rather than trusting marching-squares winding.
      const segN = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const dx = pts[i + 1].x - pts[i].x, dz = pts[i + 1].z - pts[i].z;
        const l = Math.hypot(dx, dz) || 1e-6;
        let nx = dz / l, nz = -dx / l;
        const mx = (pts[i].x + pts[i + 1].x) / 2, mz = (pts[i].z + pts[i + 1].z) / 2;
        if (field.at(mx + nx * 3, mz + nz * 3) < field.at(mx - nx * 3, mz - nz * 3)) { nx = -nx; nz = -nz; }
        segN.push({ x: nx, z: nz });
      }
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
  uniform vec3  uDeep, uMidC, uShallow, uFoamC, uRiverC;
  uniform vec3  uSunDirW, uSunTint, uSkyHi, uSkyLo;
  uniform sampler2D uRefl;
  uniform float uReflAmt;
  uniform float uRiverZ;
  varying vec3  vWaterPos;
  varying vec4  vReflCoord;

  float wHash(vec2 p){
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }
  float wNoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), u.x),
               mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float wFbm(vec2 p){
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 3; i++) { v += a * wNoise(p); p = p * 2.07 + 9.3; a *= 0.5; }
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

  /* Sum of directional waves. Only the analytic GRADIENT is used — the surface
     stays geometrically flat, so the whole bay is a handful of triangles and
     every bit of relief is per-pixel. Frequencies are mutually irrational so
     the pattern never visibly repeats. */
  vec2 waveGrad(vec2 p, float t, float k) {
    vec2 g = vec2(0.0);
    #define WAV(dx, dz, f, s, a) { \
      float ph = (p.x * (dx) + p.y * (dz)) * (f) + t * (s); \
      g += vec2(dx, dz) * (cos(ph) * (a) * (f) * k); }
    WAV( 0.94,  0.34, 0.071, 0.90, 0.30)
    WAV( 0.58, -0.81, 0.129, 1.28, 0.19)
    WAV(-0.38,  0.93, 0.237, 1.71, 0.105)
    WAV( 0.99, -0.16, 0.427, 2.33, 0.055)
    WAV( 0.22,  0.98, 0.803, 3.19, 0.026)
    WAV(-0.71, -0.70, 1.451, 4.40, 0.012)
    WAV( 0.46, -0.89, 2.311, 6.10, 0.0055)
    #undef WAV
    return g;
  }
`;

const WATER_BODY = /* glsl */ `
  vec2 wP = vWaterPos.xz;
  vec2 wShore = shoreSample(wP);
  if (wShore.x < 0.0) discard;

  float wT = uTime;
  vec3 wV = normalize(cameraPosition - vWaterPos);

  /* Chop is damped in the shallows: the last few metres against a seawall are
     always calmer than open water, and the flattening is what reads as
     "shelter" rather than a texture running under a wall. */
  float wCalm = 0.35 + 0.65 * smoothstep(0.0, 26.0, wShore.x);
  vec2 wG = waveGrad(wP, wT, wCalm);
  vec3 wNormal = normalize(vec3(-wG.x, 1.0, -wG.y));

  /* ---- depth grade -------------------------------------------------- */
  float wDepth = clamp(wShore.y / 115.0, 0.0, 1.0);
  vec3 wCol = mix(uShallow, uMidC, smoothstep(0.0, 0.26, wDepth));
  wCol = mix(wCol, uDeep, smoothstep(0.20, 0.86, wDepth));
  /* Sand showing through the first few metres. */
  wCol = mix(wCol, uShallow * 1.22 + vec3(0.05, 0.04, 0.01),
             (1.0 - smoothstep(0.0, 7.5, wShore.x)) * 0.55);

  /* The river runs siltier and greener than the bay. Centreline is the same
     pair of sines cityLayout uses, so the tint follows the bend. */
  float wRC = uRiverZ - 9.0 * sin((wP.x + 470.0) / 300.0) + 5.5 * sin((wP.x - 60.0) / 118.0);
  float wRiv = (1.0 - smoothstep(34.0, 96.0, abs(wP.y - wRC)))
             * (1.0 - smoothstep(${BAY.toFixed(1)} - 30.0, ${BAY.toFixed(1)} + 90.0, wP.x));
  wCol = mix(wCol, uRiverC, wRiv * 0.72);

  /* ---- foam ---------------------------------------------------------- */
  /* Two noise fields do all of it: one lacy and fast for the texture of the
     foam, one broad and slow for where it decides to gather. Three separate
     fBm evaluations per pixel is not affordable over half a screen of bay. */
  float wLace = wFbm(wP * 0.40 - vec2(wT * 0.18, wT * 0.11));
  float wSwell = wFbm(wP * 0.048 + vec2(wT * 0.04, -wT * 0.025));
  /* Scalloped, breathing band — a constant-width line is the tell. */
  float wWidth = 3.0 + 5.0 * wSwell + 1.6 * sin(wT * 0.8 + wSwell * 21.0);
  float wBand = 1.0 - smoothstep(0.0, max(1.2, wWidth), wShore.x);
  wBand *= 0.30 + 0.90 * wLace;
  float wEdge = 1.0 - smoothstep(0.0, 1.35, wShore.x);
  float wFoam = clamp(max(wBand * 0.95, wEdge), 0.0, 1.0);

  /* Whitecaps. Sparse on purpose: the old shader covered the bay in them and
     it read as scum on a swimming pool. */
  float wCap = smoothstep(0.72, 0.92, wSwell)
             * smoothstep(24.0, 130.0, wShore.x)
             * (0.25 + 0.75 * wLace);
  wFoam = clamp(wFoam + wCap * 0.45, 0.0, 1.0);
  wCol = mix(wCol, uFoamC, wFoam * 0.92);

  diffuseColor.rgb = wCol;

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
  vec3 wR = reflect(-wV, wNormal);
  vec3 wSky = mix(uSkyLo, uSkyHi, pow(clamp(wR.y, 0.0, 1.0), 0.42));
  wSky += uSunTint * pow(max(dot(wR, uSunDirW), 0.0), 130.0) * 2.2;   // sun glare path

  /* Projective lookup, not screen UV: a mirrored look-at frame is left-handed,
     so the target is horizontally flipped and only its own projection reads it
     back correctly. */
  vec2 wRefUv = vReflCoord.xy / max(vReflCoord.w, 1e-4);
  wRefUv = clamp(wRefUv + wG.xy * vec2(0.20, 0.32), vec2(0.002), vec2(0.998));
  vec4 wRefl = texture2D(uRefl, wRefUv);
  vec3 wMirror = mix(wSky, wRefl.rgb * uReflAmt, wRefl.a * 0.88);

  float wFres = 0.02 + 0.98 * pow(1.0 - clamp(dot(wNormal, wV), 0.0, 1.0), 5.0);
  vec3 wEmissive = wMirror * wFres * (1.0 - wFoam * 0.85);
  diffuseColor.rgb *= 1.0 - wFres * 0.55;      // what reflects does not transmit

  /* Glitter: only inside the sun's specular path, and faded out once one
     screen pixel covers more than a wave crest — otherwise the far bay turns
     into television static. */
  vec3 wH = normalize(uSunDirW + wV);
  float wPath = pow(max(dot(wNormal, wH), 0.0), 10.0);
  float wFoot = max(fwidth(wP.x), fwidth(wP.y));
  float wNear = 1.0 - smoothstep(0.18, 0.85, wFoot);
  float wGlint = wNoise(wP * 1.35 + vec2(wT * 0.55, -wT * 0.38))
               * wNoise(wP * 3.30 - vec2(wT * 0.90, wT * 0.62));
  wEmissive += uSunTint * smoothstep(0.52, 0.90, wGlint) * wPath * 2.6 * wNear;
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
  mat.customProgramCacheKey = () => 'miami-water-v1';
  return mat;
}

/* ========================================================= reflections === */

/**
 * Skyline proxy: one merged, flat-shaded box per massing block, straight from
 * the layout. It is never seen directly — only mirrored in the bay — so a box
 * with a baked vertical gradient is entirely sufficient, and it keeps the
 * reflection pass at two draw calls.
 */
function buildSkylineProxy(layout) {
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
      ? glassC.clone().lerp(haze, 0.30)
      : stone.clone().lerp(haze, 0.42);
    base.offsetHSL(0, 0, (rng() - 0.5) * 0.06);

    // Vertical gradient baked into vertex colour: sky-lit crown, shaded base.
    // A reflection is read as a silhouette with a value ramp, nothing more.
    const pos = g.attributes.position;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const t = THREE.MathUtils.clamp(pos.getY(i) / Math.max(1, h), 0, 1);
      const k = 0.42 + 0.72 * t;
      col[i * 3] = base.r * k;
      col[i * 3 + 1] = base.g * k;
      col[i * 3 + 2] = base.b * k;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    geos.push(g);
  }
  if (!geos.length) return null;
  const merged = BufferGeometryUtils.mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  return new THREE.Mesh(merged, new THREE.MeshBasicMaterial({
    vertexColors: true, toneMapped: false, fog: false,
  }));
}

function blankTexture() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  t.needsUpdate = true;
  return t;
}

function installReflection(ctx, water, uniforms) {
  const proxy = buildSkylineProxy(ctx.layout);
  if (!proxy) return;

  const rt = new THREE.WebGLRenderTarget(512, 288, {
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
  const fringe = new THREE.Color(PALETTE.SKY_HORIZON).multiplyScalar(0.5);
  // Clip space (-1..1) -> texture space (0..1).
  const bias = new THREE.Matrix4().set(
    0.5, 0, 0, 0.5,
    0, 0.5, 0, 0.5,
    0, 0, 0.5, 0.5,
    0, 0, 0, 1
  );
  let lastT = -1;

  water.onBeforeRender = (renderer, scene, camera) => {
    // GTAO renders the scene a second time for its normal buffer; the target
    // only needs filling once per simulated frame.
    if (uniforms.uTime.value === lastT) return;
    lastT = uniforms.uTime.value;

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
  };
}

/* ============================================================== build === */

export function buildWater(ctx) {
  const { scene, layout } = ctx;
  const g = ctx.group('water');
  const rng = makeRNG(0x0cea11);

  const field = buildShoreField(layout);

  /* ------------------------------------------------------- uniforms --- */
  const sunEl = THREE.MathUtils.degToRad(LIGHTING.SUN_ELEVATION);
  const sunAz = THREE.MathUtils.degToRad(LIGHTING.SUN_AZIMUTH);
  const sunDir = new THREE.Vector3(
    Math.sin(sunAz) * Math.cos(sunEl),
    Math.sin(sunEl),
    Math.cos(sunAz) * Math.cos(sunEl)
  ).normalize();

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
    uRiverC: { value: new THREE.Color(PALETTE.WATER_RIVER) },
    uSunDirW: { value: sunDir },
    uSunTint: { value: new THREE.Color(LIGHTING.SUN_COLOR) },
    // Matched to the sky dome's own radiance so the reflected horizon and the
    // real horizon are the same colour where they meet.
    uSkyHi: { value: new THREE.Color(LIGHTING.SKY_MID).multiplyScalar(LIGHTING.SKY_GAIN) },
    uSkyLo: { value: new THREE.Color(PALETTE.SKY_HORIZON).multiplyScalar(LIGHTING.SKY_GAIN * 1.04) },
    // Replaced by the live target as soon as the reflection pass installs; the
    // 1x1 transparent fallback keeps the sampler bound if it never does.
    uRefl: { value: blankTexture() },
    uReflMat: { value: new THREE.Matrix4() },
    uReflAmt: { value: 1.15 },
    uRiverZ: { value: WORLD.RIVER_Z },
    // Legacy alias so anything that reached for the old foam colour still works.
    uFoam: { value: new THREE.Color(PALETTE.SEA_FOAM) },
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

  installReflection(ctx, water, uniforms);

  /* -------------------------------------------- seawall + promenade --- */
  const shores = buildShorelines(field);
  const stats = buildShoreStructures(ctx, g, shores, field, rng);

  /* ------------------------------------------------------- marinas ---- */
  const marina = buildMarinas(ctx, g, layout, rng);

  /* --------------------------------------------------- bridge piers --- */
  buildBridgePiers(ctx, g, layout);

  ctx.waterUniforms = uniforms;
  scene.userData.waterUniforms = uniforms;
  scene.userData.shoreField = field;

  console.info(
    `[water] ${rects} surface rects | ${shores.length} shorelines / ` +
    `${Math.round(stats.length)} m of seawall | ${stats.bollards} bollards | ` +
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
const WALL_PROFILE = [
  [-1.34, 0.02, 0.02, 0.92, 0.91, 0.88],
  [-1.34, COPING_LIP, 0.30, 1.00, 1.00, 1.00],
  [-1.66, COPING_LIP, 0.38, 0.86, 0.85, 0.83],
  [-1.66, SEAWALL_TOP, 0.44, 1.06, 1.05, 1.02],
  [1.66, SEAWALL_TOP, 1.28, 1.06, 1.05, 1.02],
  [1.66, COPING_LIP, 1.34, 0.84, 0.83, 0.81],
  [1.34, COPING_LIP, 1.40, 1.00, 1.00, 0.99],
  [1.34, 0.58, 1.55, 0.90, 0.92, 0.86],
  [1.34, 0.16, 1.66, 0.60, 0.68, 0.58],   // tide line: algae + salt staining
  [1.34, -2.60, 2.34, 0.36, 0.47, 0.40],
];

function buildShoreStructures(ctx, group, shores, field, rng) {
  const wallGeos = [];
  const walkGeos = [];
  let totalLen = 0;
  let bollards = 0;

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
       exactly what this fills. */
    const { pts, nrm } = shore;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const na = nrm[i], nb = nrm[i + 1];
      for (let bandI = 0; bandI < 4; bandI++) {
        const o0 = -1.66 - bandI * 2.1;
        const o1 = o0 - 2.1;
        const cx = (a.x + b.x) / 2 + ((na.x + nb.x) / 2) * (o0 + o1) / 2;
        const cz = (a.z + b.z) / 2 + ((na.z + nb.z) / 2) * (o0 + o1) / 2;
        if (layout.isRoad(cx, cz) || inBlock(cx, cz)) continue;
        if (field.at(cx, cz) > -0.8) continue;         // never pave open water
        const q = new THREE.BufferGeometry();
        const ax0 = a.x + na.x * o0 * na.s, az0 = a.z + na.z * o0 * na.s;
        const ax1 = a.x + na.x * o1 * na.s, az1 = a.z + na.z * o1 * na.s;
        const bx0 = b.x + nb.x * o0 * nb.s, bz0 = b.z + nb.z * o0 * nb.s;
        const bx1 = b.x + nb.x * o1 * nb.s, bz1 = b.z + nb.z * o1 * nb.s;
        const Y = ctx.Y_WALK;
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
        walkGeos.push(q);
      }
    }

    /* Steps down to the water. Rare and irregular, but they are the detail
       that says "people use this edge" rather than "this is a retaining
       wall" — and they break the 1 km coping line into episodes. */
    let sinceSteps = rng() * 160;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      sinceSteps += Math.hypot(b.x - a.x, b.z - a.z);
      if (sinceSteps < 190 + rng() * 150) continue;
      sinceSteps = 0;
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
        label: 'Mooring bollard', kind: 'bollard',
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
    const mat = solid({
      map: Textures.concrete(512, PALETTE.SEAWALL),
      vertexColors: true,
      roughness: 0.93,
      metalness: 0.0,
      envMapIntensity: 0.45,
    });
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

  return { length: totalLen, bollards };
}

/* ---------------------------------------------------- prop factories --- */

function bollardFactory() {
  const parts = [];
  const shaft = new THREE.CylinderGeometry(0.19, 0.25, 0.62, 10, 1);
  shaft.translate(0, 0.31, 0);
  parts.push(shaft);
  const head = new THREE.SphereGeometry(0.24, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.55);
  head.scale(1, 0.75, 1);
  head.translate(0, 0.62, 0);
  parts.push(head);
  const foot = new THREE.CylinderGeometry(0.34, 0.38, 0.10, 10, 1);
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

/* ------------------------------------------------------- bridge piers --- */

/**
 * streets.js drops each crossing in as a single slab; without something
 * standing in the water underneath it, a bridge reads as a plank floating over
 * the river. Two pier walls per crossing, merged with a shared material.
 */
function buildBridgePiers(ctx, group, layout) {
  const parts = [];
  for (const br of layout.bridges || []) {
    const along = br.length;
    const n = br.kind === 'causeway' ? 1 : 2;
    for (let i = 0; i < n; i++) {
      const t = (i + 1) / (n + 1);
      const z = br.z - along / 2 + along * t;
      const halfW = br.width * 0.31;
      parts.push(box(halfW * 2, 5.0, 3.4, br.x, WATER_Y - 2.0, z));
      // Cutwaters on the up- and downstream ends: a pier without them reads as
      // a brick dropped in the river.
      for (const s of [-1, 1]) {
        const nose = new THREE.CylinderGeometry(1.7, 1.7, 5.0, 8, 1);
        nose.translate(br.x + s * halfW, WATER_Y - 2.0, z);
        parts.push(nose);
      }
    }
  }
  if (!parts.length) return;
  const geo = BufferGeometryUtils.mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  const mesh = new THREE.Mesh(geo, solid({
    map: Textures.concrete(512, PALETTE.CONCRETE_DARK),
    roughness: 0.94,
    envMapIntensity: 0.4,
  }));
  mesh.name = 'bridge-piers';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}
