/**
 * Buildings — the architecture of Brickell and Downtown Miami.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS SHAPED THE WAY IT IS
 * ---------------------------------------------------------------------------
 * A building must be *individually swallowable*, so it cannot be merged with
 * its neighbours. That makes the per-building draw call the hard floor of the
 * whole city's budget: 400 buildings x 4 meshes is 1600 draw calls before a
 * single prop is placed. So every building is assembled as loose geometry and
 * merged down to ONE mesh wherever possible:
 *
 *   skin   the whole building — facade, podium, parapet, balconies, awnings,
 *          roof deck and roof plant — in a single material.
 *   glass  curtain wall only (towers). Needs metalness 0.8, cannot share.
 *   lit    emissive crown / signage. Only on landmarks and hero towers.
 *
 * The trick that collapses "facade + coloured trim" into one material is a
 * FLAT UV PATCH. Every skin texture has a region that is plain wall colour
 * (the plinth band of a storefront, the mortar-free corner of a stucco bay,
 * anywhere at all on concrete). Trim geometry gets all four of its UVs pinned
 * to that one texel, which makes the sampled albedo a known constant, and then
 * a per-vertex colour multiplies it to whatever the trim should actually be.
 * The multiplier is derived by *reading the generated canvas back* rather than
 * re-deriving materials.js's warm-balance maths, so it stays correct if the
 * texture library is re-graded.
 *
 * Everything else follows from the art bible:
 *   - No razor edges. Masses are lofted prisms with chamfered plans, not boxes.
 *   - Roofs are on screen constantly, so every roof gets a parapet, a deck and
 *     a populated plant scape.
 *   - Skyline rhythm comes from the layout's height field plus per-block plan
 *     archetypes (chamfered, elliptical, bowed, twisted, twin-on-podium).
 */

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { TIER, PALETTE } from '../config.js';
import { FABRIC_COLORS } from '../render/palette.js';
import { makeRNG } from '../core/rng.js';
import { Textures, solid, glass } from '../core/materials.js';
import { ZONE, STYLE } from './cityLayout.js';

const P = PALETTE;
const STOREY = 3.4;

/**
 * Curtain-wall tints. PALETTE.GLASS_TINTS includes GLASS_BRONZE, which the
 * glass generator's dark sill gradient turns olive-brown at building scale —
 * fine for one hero facade, wrong for a whole skyline. Weighted here instead.
 */
const GLASS_TINTS = [
  P.GLASS_TEAL, P.GLASS_BLUE, P.GLASS_AQUA, P.GLASS_SKY, P.GLASS_MINT,
  P.GLASS_TEAL, P.GLASS_SKY, P.GLASS_SMOKE, P.GLASS_BLUE, P.GLASS_AQUA,
  // One bronze facade in twelve. It is the warm note that stops the glass half
  // of the skyline reading as a single material, and at one-in-twelve the
  // olive cast the sill gradient gives it lands as a hero, not as a mistake.
  P.GLASS_BRONZE, P.GLASS_SMOKE,
];

/**
 * Ground-floor palettes, drawn per building from the block seed.
 *
 * Every glass tower in Brickell used to call podium() with no colour options at
 * all, so all thirty-four of them wore the same precast wall, the same warm
 * cornice and the same chrome canopy — on the one part of a tower the player
 * ever drives past. Grouped rather than rolled surface by surface, because a
 * random wall against a random cornice reads as a bug, not as variety.
 */
const BASE_PALETTES = [
  [{ wall: P.PRECAST, band: P.CONCRETE_WARM, pier: P.CONCRETE, canopy: P.CHROME, planter: P.PLANTER }, 15],
  [{ wall: P.STUCCO_WHITE, band: P.CONCRETE_WARM, pier: P.MULLION, canopy: P.CHROME, planter: P.PLANTER }, 13],
  [{ wall: P.STUCCO_SAND, band: P.STUCCO_CREAM, pier: P.STUCCO_WHITE, canopy: P.FABRIC_SUN, planter: P.PLANTER_DARK }, 12],
  [{ wall: P.CONCRETE_DARK, band: P.PRECAST, pier: P.STEEL_DARK, canopy: P.STEEL, planter: P.PLANTER_DARK }, 11],
  [{ wall: P.STUCCO_SKY, band: P.STUCCO_WHITE, pier: P.MULLION, canopy: P.FABRIC_SKY, planter: P.PLANTER }, 9],
  [{ wall: P.WOOD_DARK, band: P.CONCRETE_WARM, pier: P.STUCCO_WHITE, canopy: P.TEAK, planter: P.PLANTER_DARK }, 9],
  [{ wall: P.STUCCO_MINT, band: P.STUCCO_WHITE, pier: P.CONCRETE_WARM, canopy: P.FABRIC_AQUA, planter: P.PLANTER }, 8],
  [{ wall: P.STUCCO_CORAL, band: P.STUCCO_CREAM, pier: P.STUCCO_WHITE, canopy: P.FABRIC_CORAL, planter: P.PLANTER }, 8],
  [{ wall: P.TERRACOTTA, band: P.STUCCO_CREAM, pier: P.STUCCO_SAND, canopy: P.FABRIC_SUN, planter: P.PLANTER }, 7],
  [{ wall: P.BRICK, band: P.STUCCO_CREAM, pier: P.BRICK_LIGHT, canopy: P.FABRIC_CORAL, planter: P.PLANTER_DARK }, 6],
];
const BASE_PAL_DEFAULT = BASE_PALETTES[0][0];

/**
 * Architectural trim: fins, mullion bands, spandrel courses, corner columns.
 *
 * The shaft used to pick between exactly two of these, which made the second
 * variety axis after the plan shape nearly binary. Real curtain wall is trimmed
 * in anodised white, bronze-grey, warm precast or bare concrete depending on
 * the decade it was built in, and reading those apart at 300 m is most of what
 * tells two glass towers apart at all.
 */
const ACCENT_TRIM = [
  [P.MULLION, 16], [P.CONCRETE, 13], [P.PRECAST, 12], [P.STUCCO_WHITE, 12],
  [P.CONCRETE_WARM, 11], [P.ALUMINIUM, 9], [P.MULLION_DARK, 8],
  [P.STEEL_DARK, 7], [P.STUCCO_SAND, 6], [P.CONCRETE_DARK, 6],
];

/* ========================================================== colour ====== */

const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** Linear RGB of an sRGB hex. */
function linOf(hex) {
  return [s2l(((hex >> 16) & 255) / 255), s2l(((hex >> 8) & 255) / 255), s2l((hex & 255) / 255)];
}

/**
 * Average linear colour of a texture around one UV, read straight off the
 * canvas the generator painted. This is what makes the flat-UV tint exact.
 */
function sampleLinear(tex, u, v) {
  const fallback = [0.62, 0.60, 0.48];
  try {
    const c = tex.image;
    const g = c.getContext('2d');
    const x = Math.max(0, Math.min(c.width - 9, Math.round(u * c.width) - 4));
    const y = Math.max(0, Math.min(c.height - 9, Math.round((1 - v) * c.height) - 4));
    const d = g.getImageData(x, y, 9, 9).data;
    let r = 0, gg = 0, b = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
    return [s2l(r / n / 255), s2l(gg / n / 255), s2l(b / n / 255)];
  } catch (e) {
    return fallback;
  }
}

/* ======================================================== geometry ====== */

/** Outward 2D normal of the edge a->b, for our clockwise-from-above winding. */
function edgeN(a, b) {
  const nx = -(b[1] - a[1]), nz = (b[0] - a[0]);
  const L = Math.hypot(nx, nz) || 1;
  return [nx / L, nz / L];
}

/** Averaged per-point normals, for plans that should shade smoothly. */
function pointNormals(p) {
  const n = p.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = edgeN(p[(i - 1 + n) % n], p[i]);
    const b = edgeN(p[i], p[(i + 1) % n]);
    let x = a[0] + b[0], z = a[1] + b[1];
    const L = Math.hypot(x, z) || 1;
    out.push([x / L, z / L]);
  }
  return out;
}

/**
 * Move a convex plan outward (o>0) or inward (o<0) along its bisectors.
 *
 * WHY THE INWARD CLAMP IS PER-EDGE AND NOT AN INRADIUS TEST.
 * An inward offset shortens every edge, and on a deep-and-narrow parcel the
 * short chamfer edges vanish long before the inradius is used up. Past that
 * point the miter formula happily keeps going: the edge's two ends cross, its
 * outward normal flips, and the NEXT offset then drives those vertices
 * outward. The plan becomes a bow-tie whose planBounds is bigger than the plan
 * it came from — which is how a midrise setback ended up 4 m WIDER than the
 * storey below it and hanging over the pavement, and how the Freedom Tower's
 * crown lantern (sized off planBounds) grew to 41 m across on a 13 m parcel.
 * So the limit is the offset at which the FIRST edge is about to disappear.
 */
function offsetPlan(p, o) {
  const n = p.length;
  // Per-vertex displacement for a unit offset. 1/cos(half-angle) so a chamfer
  // corner moves out as far as its faces do.
  const u = [];
  for (let i = 0; i < n; i++) {
    const a = edgeN(p[(i - 1 + n) % n], p[i]);
    const b = edgeN(p[i], p[(i + 1) % n]);
    let mx = a[0] + b[0], mz = a[1] + b[1];
    const L = Math.hypot(mx, mz) || 1;
    mx /= L; mz /= L;
    const k = 1 / Math.max(0.4, mx * a[0] + mz * a[1]);
    u.push([mx * k, mz * k]);
  }
  if (o < 0) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const dx = p[j][0] - p[i][0], dz = p[j][1] - p[i][1];
      const L = Math.hypot(dx, dz);
      if (L < 1e-5) continue;
      // Rate this edge shortens at, per metre of inward offset.
      const rate = ((u[j][0] - u[i][0]) * dx + (u[j][1] - u[i][1]) * dz) / L;
      if (rate > 1e-5) o = Math.max(o, (0.02 - L) / rate);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) out.push([p[i][0] + u[i][0] * o, p[i][1] + u[i][1] * o]);
  return out;
}

/**
 * Step a plan back by `t` metres for a setback.
 *
 * offsetPlan now refuses to fold a plan, which on a thin parcel means it can
 * only inset a little — leaving a "setback" that does not visibly step back.
 * Falling back to a centred scale keeps the storey above smaller on every side
 * without ever inverting an edge.
 */
function insetPlan(p, t) {
  const bb = planBounds(p);
  const q = offsetPlan(p, -t);
  const qb = planBounds(q);
  if (qb.w <= bb.w - t && qb.d <= bb.d - t) return q;
  const sx = Math.max(0.5, 1 - (2 * t) / Math.max(1, bb.w));
  const sz = Math.max(0.5, 1 - (2 * t) / Math.max(1, bb.d));
  return movePlan(scalePlan(movePlan(p, -bb.cx, -bb.cz), sx, sz), bb.cx, bb.cz);
}

function scalePlan(p, sx, sz) { return p.map((q) => [q[0] * sx, q[1] * (sz ?? sx)]); }

function rotPlan(p, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return p.map((q) => [q[0] * c - q[1] * s, q[0] * s + q[1] * c]);
}

function movePlan(p, dx, dz) { return p.map((q) => [q[0] + dx, q[1] + dz]); }

const revPlan = (p) => p.slice().reverse();

function planBounds(p) {
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const q of p) {
    if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0];
    if (q[1] < z0) z0 = q[1]; if (q[1] > z1) z1 = q[1];
  }
  return { x0, x1, z0, z1, w: x1 - x0, d: z1 - z0, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 };
}

/** Perimeter length. Drives how many piers/fins a face gets, so the rhythm is
 *  metric (one pier every 6-7 m) instead of a fixed count on every plan. */
function planPerimeter(p) {
  let t = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    t += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return t;
}

/* --- plan archetypes. All wound clockwise seen from above (outward faces). */

function rectPlan(w, d, c = 0) {
  const hw = w / 2, hd = d / 2;
  if (c <= 0.05) return [[hw, hd], [hw, -hd], [-hw, -hd], [-hw, hd]];
  c = Math.min(c, Math.min(hw, hd) * 0.45);
  return [
    [hw, hd - c], [hw, -hd + c], [hw - c, -hd], [-hw + c, -hd],
    [-hw, -hd + c], [-hw, hd - c], [-hw + c, hd], [hw - c, hd],
  ];
}

function ellipsePlan(w, d, n = 18) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = -(i / n) * Math.PI * 2 + 0.3;
    out.push([(w / 2) * Math.cos(a), (d / 2) * Math.sin(a)]);
  }
  return out;
}

/** Rectangle with the street face (+z) bowed out — the Brickell curved slab. */
function bowPlan(w, d, bulge, n = 7) {
  const hw = w / 2, hd = d / 2;
  const out = [[hw, hd - 1.5], [hw, -hd + 1.5], [hw - 1.5, -hd], [-hw + 1.5, -hd], [-hw, -hd + 1.5], [-hw, hd - 1.5]];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = -hw + w * t;
    out.push([x, hd + Math.sin(t * Math.PI) * bulge]);
  }
  return out;
}

/*
 * More convex plans. CONVEX IS A HARD REQUIREMENT, not a stylistic choice:
 * offsetPlan miters along vertex bisectors and inPlan is a half-plane test, so
 * a re-entrant corner (a cruciform, an L) would make every setback, parapet and
 * roof-plant placement in the file wrong. Everything below stays convex; the
 * variety comes from how many sides there are and how unequal they are.
 */

/** Regular-ish polygon stretched to the parcel. Hex and octagon shafts. */
function polyPlan(w, d, n, phase = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = -(i / n) * Math.PI * 2 + phase;
    out.push([(w / 2) * Math.cos(a), (d / 2) * Math.sin(a)]);
  }
  return out;
}

/** Trapezoid: the -z end is narrower. Reads as a prow from the 3/4 camera. */
function wedgePlan(w, d, taper, c) {
  const hw = w / 2, hd = d / 2, nw = hw * (1 - taper);
  c = Math.min(c, Math.min(nw, hd) * 0.4);
  return [
    [hw, hd - c], [nw, -hd + c], [nw - c, -hd], [-nw + c, -hd],
    [-nw, -hd + c], [-hw, hd - c], [-hw + c, hd], [hw - c, hd],
  ];
}

/** Both long faces bowed — a lens. The classic Brickell curved condo slab. */
function lensPlan(w, d, bulge, n = 6) {
  const hw = w / 2, hd = d / 2, out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push([-hw + w * t, hd + Math.sin(t * Math.PI) * bulge]);
  }
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push([hw - w * t, -hd - Math.sin(t * Math.PI) * bulge]);
  }
  return out;
}

/**
 * Rectangle with ONE corner sliced off hard. Asymmetry you can read at 400 m.
 *
 * The two replacement points must be emitted in the order the perimeter visits
 * them or the plan self-crosses; on the (+,-) and (-,+) corners the perimeter
 * arrives along z and leaves along x, so the pair is the other way round.
 */
function cornerCutPlan(w, d, cut, sx, sz) {
  const hw = w / 2, hd = d / 2;
  const c = Math.min(cut, Math.min(hw, hd) * 0.8);
  const out = [];
  for (const q of [[hw, hd], [hw, -hd], [-hw, -hd], [-hw, hd]]) {
    if (Math.sign(q[0]) !== sx || Math.sign(q[1]) !== sz) { out.push(q); continue; }
    const ax = [q[0] - sx * c, q[1]], az = [q[0], q[1] - sz * c];
    if (sx * sz > 0) out.push(ax, az); else out.push(az, ax);
  }
  return out;
}

/* --- lofting ------------------------------------------------------------ */

function capInto(pts, y, up, pos, nor, uv, idx, base, uS) {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    pos.push(pts[i][0], y, pts[i][1]);
    nor.push(0, up ? 1 : -1, 0);
    uv.push(pts[i][0] / uS, pts[i][1] / uS);
  }
  for (let i = 1; i < n - 1; i++) {
    if (up) idx.push(base, base + i, base + i + 1);
    else idx.push(base, base + i + 1, base + i);
  }
  return base + n;
}

/**
 * Sweep a stack of horizontal rings into a closed shell.
 * @param {{p:number[][], y:number}[]} rings all the same vertex count
 */
function loft(rings, o = {}) {
  const uS = o.uScale || 4, vS = o.vScale || 4;
  const uOff = o.uOffset || 0, vBase = o.vBase || 0;
  const n = rings[0].p.length, R = rings.length;

  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = rings[0].p[i], b = rings[0].p[(i + 1) % n];
    cum[i + 1] = cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]);
  }

  const pos = [], nor = [], uv = [], idx = [];
  const pn = o.smooth ? pointNormals(rings[0].p) : null;
  let base = 0;

  for (let s = 0; s < R - 1; s++) {
    const A = rings[s], B = rings[s + 1];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a0 = A.p[i], a1 = A.p[j], b0 = B.p[i], b1 = B.p[j];
      const fn = edgeN(a0, a1);
      const n0 = pn ? pn[i] : fn;
      const n1 = pn ? pn[j] : fn;
      const u0 = uOff + cum[i] / uS, u1 = uOff + cum[i + 1] / uS;
      const v0 = (A.y - vBase) / vS, v1 = (B.y - vBase) / vS;
      pos.push(a0[0], A.y, a0[1], a1[0], A.y, a1[1], b1[0], B.y, b1[1], b0[0], B.y, b0[1]);
      nor.push(n0[0], 0, n0[1], n1[0], 0, n1[1], n1[0], 0, n1[1], n0[0], 0, n0[1]);
      uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      base += 4;
    }
  }
  if (o.capTop) base = capInto(rings[R - 1].p, rings[R - 1].y, true, pos, nor, uv, idx, base, uS);
  if (o.capBottom) base = capInto(rings[0].p, rings[0].y, false, pos, nor, uv, idx, base, uS);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Horizontal annulus between two concentric plans (slab top / soffit). */
function ringCap(outer, inner, y, up) {
  const n = outer.length;
  const pos = [], nor = [], uv = [], idx = [];
  let b = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const q = [outer[i], outer[j], inner[j], inner[i]];
    for (const t of q) { pos.push(t[0], y, t[1]); nor.push(0, up ? 1 : -1, 0); uv.push(t[0] / 4, t[1] / 4); }
    if (up) idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    else idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
    b += 4;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Upstand wall around a roof edge: outer face, inner face and a coping. */
function parapetGeo(plan, y, h, t) {
  const bb = planBounds(plan);
  t = Math.min(t, Math.min(bb.w, bb.d) * 0.24);
  const inner = offsetPlan(plan, -t);
  return BufferGeometryUtils.mergeGeometries([
    loft([{ p: plan, y }, { p: plan, y: y + h }], {}),
    loft([{ p: revPlan(inner), y }, { p: revPlan(inner), y: y + h }], {}),
    ringCap(plan, inner, y + h, true),
  ], false);
}

/** Projecting slab (balcony, string course, cornice) hung off a plan. */
function slabGeo(plan, y, t, proj) {
  const outer = offsetPlan(plan, proj);
  return BufferGeometryUtils.mergeGeometries([
    loft([{ p: outer, y }, { p: outer, y: y + t }], {}),
    ringCap(outer, plan, y + t, true),
    ringCap(outer, plan, y, false),
  ], false);
}

/** Box with UVs in metres so a tiled map keeps constant world density. */
function box(w, h, d, x = 0, y = 0, z = 0, uv = 4) {
  const g = new THREE.BoxGeometry(w, h, d);
  const a = g.attributes.uv;
  const spans = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    const [su, sv] = spans[f];
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      a.setXY(k, a.getX(k) * (su / uv), a.getY(k) * (sv / uv));
    }
  }
  a.needsUpdate = true;
  g.translate(x, y + h / 2, z);
  return g;
}

function cyl(r, h, seg, x = 0, y = 0, z = 0, rTop = r) {
  const g = new THREE.CylinderGeometry(rTop, r, h, seg, 1, false);
  g.translate(x, y + h / 2, z);
  return g;
}

/* --- attribute helpers -------------------------------------------------- */

/**
 * Re-map a metre-space UV set — what `box(w,h,d,...,1)` produces — onto a tile
 * of uS x vS metres. Needed for glazed geometry, because a curtain-wall tile is
 * 15 m wide by 35 m tall and box() can only divide both axes by one number.
 */
function tileUV(g, uS, vS) {
  const a = g.attributes.uv;
  for (let i = 0; i < a.count; i++) a.setXY(i, a.getX(i) / uS, a.getY(i) / vS);
  a.needsUpdate = true;
  return g;
}

function setUVFlat(g, u, v) {
  const a = g.attributes.uv;
  for (let i = 0; i < a.count; i++) a.setXY(i, u, v);
  a.needsUpdate = true;
  return g;
}

function setColor(g, c) {
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c[0]; arr[i * 3 + 1] = c[1]; arr[i * 3 + 2] = c[2]; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

const WHITE3 = [1, 1, 1];

/* =========================================================== skins ====== */

/**
 * A skin bundles the facade material with the "plain texel" its trim geometry
 * pins its UVs to, plus the linear colour actually found there — which is what
 * the per-vertex tint divides against.
 */
/**
 * Dial back the world-space albedo breakup on ONE facade material.
 *
 * materials.js multiplies every mapped surface by a world-space noise field so
 * that ground planes stop reading as a tile grid. On a road that is exactly
 * right. On painted render it is not: the field's mid band lands at three to
 * five metres, which on a 20 m wide stucco tower is four or five lobes across
 * the face, and stacked on the height map's own patch layer it rendered as
 * camouflage — cream blotches crawling over butter, mint and aqua walls alike,
 * identical on every building because the field is world-space. Render is
 * PAINTED; its whole visual point is that it is one flat colour with a fine
 * tooth. The tooth (the texture's own high-frequency layer) is untouched.
 *
 * Guarded: solid() caches, so the same material can come back from several
 * skins and the scale must only ever be applied once.
 */
const _tamed = new WeakSet();
function tameMacro(mat, k) {
  if (k === 1 || _tamed.has(mat)) return mat;
  _tamed.add(mat);
  const u = mat.userData && mat.userData.macroUniforms;
  if (u && u.uMacroA) u.uMacroA.value.y *= k;
  return mat;
}

function makeSkin(tex, fu, fv, uScale, vScale, matOpts, awn = false, night = null, macro = 1, grid = null) {
  const base = sampleLinear(tex, fu, fv);
  const mat = solid({ map: tex, vertexColors: true, emissiveIntensity: 0, ...matOpts });
  tameMacro(mat, macro);
  if (night) nightMat(mat, night[0], night[1]);
  const cache = new Map();
  return {
    mat, fu, fv, uScale, vScale, awn,
    // Tile divisions, for Build's UV phase. Only skins whose map has a window
    // grid declare them; a phase on plain concrete would buy nothing.
    bays: grid ? grid[0] : 0,
    floors: grid ? grid[1] : 0,
    /** Vertex-colour multiplier that turns the flat texel into `hex`. */
    tint(hex) {
      let v = cache.get(hex);
      if (!v) {
        const t = linOf(hex);
        v = [
          Math.min(3.2, t[0] / Math.max(0.02, base[0])),
          Math.min(3.2, t[1] / Math.max(0.02, base[1])),
          Math.min(3.2, t[2] / Math.max(0.02, base[2])),
        ];
        cache.set(hex, v);
      }
      return v;
    },
  };
}

const _skins = new Map();
function skin(key, make) {
  let s = _skins.get(key);
  if (!s) { s = make(); _skins.set(key, s); }
  return s;
}

/* ==================================================== night lighting ==== */

/**
 * THE DAY/NIGHT CONTRACT, ARCHITECTURE SIDE.
 *
 * src/core/engine.js publishes scene.userData.nightFactor every frame. Nothing
 * here re-implements the cycle: every emissive this module owns is registered
 * with the intensity it should read at noon and at midnight, and one update
 * walks the list. Because materials are shared and cached, that list is ~30
 * entries for the whole city, not one per building.
 */
const _nightMats = [];
const _nightSeen = new WeakSet();
function nightMat(mat, day, night) {
  if (_nightSeen.has(mat)) return mat;
  _nightSeen.add(mat);
  mat.emissiveIntensity = day;
  _nightMats.push({ mat, day, night });
  return mat;
}

function installNightCycle(scene) {
  let last = -1;
  const update = () => {
    const n = scene.userData.nightFactor;
    if (typeof n !== 'number' || Math.abs(n - last) < 0.0015) return;
    last = n;
    // Windows do not all switch on the instant the sun clips the horizon.
    // Smoothstep plus a bias toward the late half of dusk reads as a city
    // filling up over half an hour instead of a light switch being thrown.
    const k = n * n * (3 - 2 * n);
    for (const e of _nightMats) e.mat.emissiveIntensity = e.day + (e.night - e.day) * k;
  };
  // The documented hook, for whoever pumps the per-module updates...
  scene.userData.buildingsUpdate = update;
  // ...plus the renderer's own per-frame scene callback, so the skyline lights
  // up whether or not the game loop has been taught about this module yet.
  // Chained, never replaced: another module may already own this slot.
  const prev = scene.onBeforeRender;
  scene.onBeforeRender = function (...a) { prev.apply(this, a); update(); };
  update();
}

/* --- emissive window maps ----------------------------------------------- */

function litCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);
  return { c, g };
}

function litTex(c) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

const _litTex = new Map();
function litTexCached(key, make) {
  let t = _litTex.get(key);
  if (!t) { t = make(); _litTex.set(key, t); }
  return t;
}

/** Deterministic per-texture noise, so a rebuilt city lights up identically. */
function litRNG(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OFFICE_LIGHTS = ['#fff0cf', '#ffe3ab', '#e8f0ff', '#fff7e4', '#ffd9a0'];

/**
 * Lit windows for a curtain wall, on exactly the grid Textures.glass paints —
 * 10 floors x 10 bays per tile, vision glass above a 26% spandrel band. Used as
 * an emissiveMap so a lit tower costs no extra draw call and no extra mesh.
 */
function glassNightTex(tint, floors = 10, bays = 10) {
  return litTexCached(`gn${tint}-${floors}-${bays}`, () => {
    const size = 512;
    const { c, g } = litCanvas(size);
    const rnd = litRNG(0x51a7 ^ tint ^ (bays << 8));
    const fh = size / floors, bw = size / bays;
    const visionH = fh * 0.74;
    for (let f = 0; f < floors; f++) {
      // Whole floors go dark — a plant level, an empty tenancy, a fire floor.
      const floorOff = rnd() < 0.16;
      for (let i = 0; i < bays; i++) {
        if (floorOff ? rnd() > 0.12 : rnd() > 0.52) continue;
        const v = 0.45 + rnd() * 0.55;
        g.globalAlpha = v;
        g.fillStyle = OFFICE_LIGHTS[(rnd() * OFFICE_LIGHTS.length) | 0];
        // Inset by the mullion width so the glow does not paint the frames.
        g.fillRect(i * bw + 1.5, f * fh + 1.5, bw - 3, visionH - 3);
      }
    }
    g.globalAlpha = 1;
    return litTex(c);
  });
}

/**
 * Lit windows for painted render.
 *
 * The openings are no longer a grid that can be re-derived — Textures.stucco
 * varies their width, height and position per column — so it publishes the
 * rectangles it actually painted and this lights those. Deriving a second grid
 * here is how a night facade ends up with rectangles of glow floating on the
 * render between the real windows.
 */
function stuccoNightTex(hex) {
  return litTexCached(`sn${hex}`, () => {
    const size = 512;
    const { c, g } = litCanvas(size);
    const rnd = litRNG(0x3311 ^ hex);
    const wins = Textures.stucco(hex, 8, 6).userData.windows || [];
    for (const w of wins) {
      if (rnd() > 0.46) continue;
      // A blind or a curtain diffuses the light instead of hiding it, so those
      // read as soft and pale; bare glass shows the lamp itself.
      const soft = w.t === 'blind' || w.t === 'curtain';
      g.globalAlpha = (soft ? 0.30 : 0.45) + rnd() * 0.55;
      // Homes are warmer and more uneven than offices.
      g.fillStyle = soft ? '#ffe6bc' : (rnd() < 0.75 ? '#ffd79a' : '#ffeed0');
      g.fillRect(w.x + 1, w.y + 1, Math.max(1, w.w - 2), Math.max(1, w.h - 2));
    }
    g.globalAlpha = 1;
    return litTex(c);
  });
}

/**
 * Shopfront at night: the fascia sign burns, the display window spills warm
 * light onto the pavement. This is the single biggest reason a night street
 * reads as a street rather than as a row of dark boxes.
 *
 * The plinth is left black, because the plinth is where every trim surface in
 * the building pins its flat UV — see makeSkin.
 */
function shopNightTex(hex) {
  return litTexCached(`hn${hex}`, () => {
    const size = 512;
    const { c, g } = litCanvas(size);
    const rnd = litRNG(0x7ac1 ^ hex);
    const P = (t) => size * t;
    const neon = NEON_SET[(rnd() * NEON_SET.length) | 0];
    // Fascia sign: the band Textures.storefront paints its lettering into.
    g.fillStyle = `#${neon.toString(16).padStart(6, '0')}`;
    g.globalAlpha = 0.30;
    g.fillRect(0, P(0.055), size, P(0.115));
    g.globalAlpha = 1;
    let lx = P(0.10);
    for (let w = 0; w < 5; w++) {
      const ww = P(0.06 + rnd() * 0.13);
      roundRectPath(g, lx, P(0.088), ww, P(0.048), P(0.012));
      g.fill();
      lx += ww + P(0.035);
      if (lx > P(0.9)) break;
    }
    // Interior spill behind the display glazing, brightest at the head.
    const gy = P(0.30), gH = P(0.585);
    const grad = g.createLinearGradient(0, gy, 0, gy + gH);
    grad.addColorStop(0.0, 'rgba(255,228,170,0.85)');
    grad.addColorStop(0.55, 'rgba(255,206,140,0.55)');
    grad.addColorStop(1.0, 'rgba(220,160,90,0.16)');
    g.fillStyle = grad;
    g.fillRect(P(0.045), gy, size - P(0.09), gH);
    for (let i = 0; i < 6; i++) {
      const x = P(0.08) + rnd() * size * 0.84;
      const y = gy + gH * (0.25 + rnd() * 0.5);
      const rr = P(0.02 + rnd() * 0.05);
      const rg = g.createRadialGradient(x, y, 0, x, y, rr);
      rg.addColorStop(0, 'rgba(255,244,214,0.9)');
      rg.addColorStop(1, 'rgba(255,244,214,0)');
      g.fillStyle = rg;
      g.beginPath(); g.arc(x, y, rr, 0, 7); g.fill();
    }
    return litTex(c);
  });
}

function roundRectPath(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

const NEON_SET = [
  P.NEON_PINK, P.NEON_AQUA, P.NEON_YELLOW, P.NEON_PURPLE,
  P.NEON_GREEN, P.NEON_ORANGE, P.NEON_BLUE, P.NEON_WHITE,
];

/**
 * Painted render with punched windows. 6 bays x 8 floors per tile.
 *
 * The emissiveMap is black everywhere except inside those punched windows, and
 * the flat texel the trim pins to (8,8 in texture space) is wall, not window —
 * so a balcony slab tinted off this same material stays unlit at midnight while
 * the facade behind it fills with lamplight.
 */
function stuccoSkin(hex) {
  return skin(`st${hex}`, () => makeSkin(
    Textures.stucco(hex, 8, 6), 8 / 512, 1 - 8 / 512, 6 * 3.3, 8 * STOREY,
    {
      roughness: 0.78, emissiveMap: stuccoNightTex(hex), emissive: 0xffffff,
      // The height map carries a 4 m "patch" layer at a fifth of its range so
      // that render reads as repainted rather than sprayed. At the map's own
      // 0.8 that lobed relief is the other half of the camouflage — a soft
      // lumpy shading pattern the size of a bedroom window. Halved; the fine
      // tooth is the same field an octave up and still lands.
      normalScale: new THREE.Vector2(0.45, 0.45),
    },
    false, [0, 1.15], 0.62, [6, 8]
  ));
}

/** Shopfront. One tile = one shop unit wide, one storey tall. */
function shopSkin(hex) {
  return skin(`sh${hex}`, () => makeSkin(
    Textures.storefront(hex), 0.5, 1 - 492 / 512, 9, 5.0,
    { roughness: 0.7, emissiveMap: shopNightTex(hex), emissive: 0xffffff },
    true, [0, 1.5]
  ));
}

/** Cast concrete — podiums, cores, crowns, roof plant, every coloured trim. */
function trimSkin() {
  return skin('trim', () => makeSkin(
    Textures.concrete(512, 0xf7f3e6), 250 / 512, 1 - 170 / 512, 4.5, 4.5,
    { roughness: 0.72, envMapIntensity: 0.5 }
  ));
}

/** Power-trowelled deck slab, for open parking structures. */
function deckSkin() {
  return skin('deck', () => makeSkin(
    Textures.parkingDeck(), 130 / 512, 1 - 150 / 512, 10, 3.2, { roughness: 0.86 }
  ));
}

/**
 * Curtain-wall bay rhythms, per CW_U x CW_V tile.
 *
 * WHY THE GRID IS A VARIETY AXIS AND NOT A CONSTANT.
 * Every glass tower in the city used to be clad in the same 1.5 m mullion
 * rhythm, so the only thing telling two of them apart at 120 m was the tint —
 * which is why the teal half of Brickell read as one asset recoloured. Real
 * curtain wall is set out to the decade it was built in: a 1970s tower runs
 * near-2 m bays with heavy transoms, a 2010s condo runs 1.1 m ribs. The floor
 * count stays 10 per 35 m tile in all three, because a storey is 3.5 m
 * whatever year it is, and faking that would break the metric read.
 *
 * Cost is one texture set per (tint, grid) pair actually used, not per pair
 * possible — a city with 34 glass towers can never make more than 34.
 */
const CW_GRIDS = [[10, 8], [10, 10], [10, 13]];

const CURTAIN = new Map();
function curtainMat(tint, grid = 1) {
  const gi = ((grid | 0) % CW_GRIDS.length + CW_GRIDS.length) % CW_GRIDS.length;
  const key = `${tint}|${gi}`;
  let m = CURTAIN.get(key);
  if (!m) {
    const [floors, bays] = CW_GRIDS[gi];
    m = glass({
      map: Textures.glass(tint, floors, bays, 512),
      // Lit offices ride on the same UVs as the curtain wall, so a whole
      // skyline switches on for the cost of one extra texture per tint.
      emissiveMap: glassNightTex(tint, floors, bays), emissive: 0xffffff, emissiveIntensity: 0,
      roughness: 0.16, metalness: 0.74, color: 0xffffff,
    });
    nightMat(m, 0, 1.35);
    CURTAIN.set(key, m);
  }
  return m;
}
/** Curtain-wall tile size in metres — must match CW_GRIDS' floors x bays. */
const CW_U = 15, CW_V = 35;

/* ============================================================ Build ===== */

/**
 * Accumulates one building's geometry and collapses it to the fewest meshes
 * that can express it. `face` keeps real texture UVs; `trim` pins to the flat
 * texel and tints; `band` keeps authored UVs (used for the awning stripe band).
 */
class Build {
  /**
   * @param {object} sk skin
   * @param {?number} neon this building's signage colour. One per building, not
   *   one per sign: every emissive on a building shares a single merged mesh, so
   *   the emissive uniform is a building-wide decision. Variety comes from
   *   neighbours picking differently, which is how a real strip looks anyway.
   */
  /**
   * @param {?object} rng when given, the building draws a UV PHASE from it.
   *
   * WHY A PHASE.
   * One stucco texture serves every building painted that colour, so a row of
   * them wore the identical window pattern in the identical place — from the
   * rooftops preset three neighbours read as one asset stamped three times,
   * which is the exact failure this module exists to prevent. Sliding the tile
   * by a whole number of bays and a whole number of storeys costs nothing (it
   * is two numbers handed to `loft`) and decorrelates them completely.
   *
   * WHOLE bays and WHOLE storeys, not a free offset: the balcony slabs, string
   * courses and cornices are modelled geometry placed at 3.4 m intervals from
   * the building's own base, and a fractional shift would slice them straight
   * through the painted window heads.
   */
  constructor(sk, neon = null, rng = null) {
    this.sk = sk;
    this.skinGeo = [];
    this.glassGeo = [];
    this.glassMat = null;
    this.litGeo = [];
    this.litHex = neon;
    this.neon = neon || P.NEON_AQUA;
    this.uPhase = 0;
    this.vPhase = 0;
    if (rng && sk.bays) {
      this.uPhase = rng.int(0, sk.bays - 1) / sk.bays;
      this.vPhase = -rng.int(0, (sk.floors || 1) - 1) * STOREY;
    }
  }

  /** loft() options for a wall clad in this building's skin, phase included. */
  wall(extra) {
    return {
      uScale: this.sk.uScale, vScale: this.sk.vScale,
      uOffset: this.uPhase, vBase: this.vPhase, capTop: false, ...extra,
    };
  }

  face(g) { this.skinGeo.push(setColor(g, WHITE3)); return this; }

  trim(g, hex) {
    setUVFlat(g, this.sk.fu, this.sk.fv);
    this.skinGeo.push(setColor(g, this.sk.tint(hex)));
    return this;
  }

  band(g) { this.skinGeo.push(setColor(g, WHITE3)); return this; }

  gl(g, mat) { this.glassMat = mat; this.glassGeo.push(g); return this; }

  lit(g, hex) {
    hex = hex ?? this.neon;
    if (this.litHex === null) this.litHex = hex;
    setUVFlat(g, this.sk.fu, this.sk.fv);
    this.litGeo.push(setColor(g, this.sk.tint(hex)));
    return this;
  }

  /** @returns {THREE.Group} */
  finish() {
    const root = new THREE.Group();
    const mk = (geos, mat) => {
      if (!geos.length) return;
      const m = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(geos, false), mat);
      m.castShadow = true;
      m.receiveShadow = true;
      root.add(m);
    };
    mk(this.skinGeo, this.sk.mat);
    if (this.glassGeo.length && this.glassMat) mk(this.glassGeo, this.glassMat);
    if (this.litGeo.length) {
      // Signage is dim but not off in daylight — a lit crown at noon reads as
      // painted metal, which is right. At night it is the loudest thing on the
      // building. toneMapped:false so the neon survives the grade and blooms.
      mk(this.litGeo, nightMat(solid({
        map: this.sk.mat.map, vertexColors: true, roughness: 0.4,
        emissive: this.litHex, emissiveIntensity: 0.34, toneMapped: false,
      }), 0.34, 3.4));
    }
    return root;
  }
}

/* ========================================================= roof kit ===== */

/** True if (x,z) is inside a convex clockwise-from-above plan. */
function inPlan(p, x, z) {
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    const n = edgeN(a, b);
    if ((x - a[0]) * n[0] + (z - a[1]) * n[1] > 0) return false;
  }
  return true;
}

function acUnit(B, x, y, z, s, r) {
  const w = 1.5 * s, d = 1.1 * s, h = 0.85 * s;
  B.trim(box(w, h * 0.16, d, x, y, z, 3), P.STEEL_DARK);            // skid frame
  B.trim(box(w, h, d, x, y + h * 0.16, z, 3), P.AC_METAL);
  B.trim(box(w * 0.86, 0.14 * s, d * 0.86, x, y + h * 1.16, z, 3), P.CHROME);
  B.trim(cyl(0.34 * s, 0.2 * s, 8, x, y + h * 1.2, z), P.STEEL_DARK);  // fan cowl
  if (r() < 0.5) B.trim(box(0.24 * s, 0.5 * s, 0.24 * s, x + w * 0.42, y + h * 1.3, z, 3), P.VENT_METAL);
}

function ventStack(B, x, y, z, s) {
  B.trim(cyl(0.28 * s, 1.1 * s, 8, x, y, z), P.VENT_METAL);
  B.trim(cyl(0.42 * s, 0.16 * s, 8, x, y + 1.1 * s, z), P.STEEL);
}

function ductRun(B, x, y, z, len, rot, s) {
  const c = Math.cos(rot), si = Math.sin(rot);
  for (let i = 0; i < 3; i++) {
    const t = (i / 2 - 0.5) * len;
    B.trim(box(0.18 * s, 0.42 * s, 0.18 * s, x + c * t, y, z + si * t, 2), P.STEEL_DARK);
  }
  const g = box(len, 0.62 * s, 0.7 * s, 0, y + 0.42 * s, 0, 2.5);
  g.rotateY(rot); g.translate(x, 0, z);
  B.trim(g, P.VENT_METAL);
}

function waterTank(B, x, y, z, s) {
  for (const [dx, dz] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
    B.trim(box(0.2 * s, 1.5 * s, 0.2 * s, x + dx * s * 1.1, y, z + dz * s * 1.1, 2), P.STEEL_DARK);
  }
  B.trim(cyl(0.95 * s, 2.0 * s, 10, x, y + 1.5 * s, z), P.WATER_TANK);
  B.trim(cyl(0.95 * s, 0.6 * s, 10, x, y + 3.5 * s, z, 0.1), P.ROOF_DARK);
}

function bulkhead(B, x, y, z, w, d, h, hex) {
  const pp = movePlan(rectPlan(w, d, 0.5), x, z);
  B.trim(loft([{ p: pp, y }, { p: pp, y: y + h }], { capTop: true }), hex);
  B.trim(box(w + 0.5, 0.28, d + 0.5, x, y + h, z, 3), P.PARAPET);
}

function dish(B, x, y, z, s) {
  B.trim(cyl(0.12 * s, 1.0 * s, 6, x, y, z), P.STEEL_DARK);
  const g = cyl(0.85 * s, 0.16 * s, 10, 0, 0, 0);
  g.rotateX(-0.7); g.translate(x, y + 1.1 * s, z);
  B.trim(g, P.ALUMINIUM);
}

function helipad(B, x, y, z, r) {
  B.trim(cyl(r, 0.34, 16, x, y, z), P.HELIPAD);
  B.trim(cyl(r * 0.86, 0.1, 16, x, y + 0.34, z), P.HELIPAD_MARK);
  B.trim(cyl(r * 0.74, 0.09, 16, x, y + 0.4, z), P.HELIPAD);
  B.trim(box(r * 0.16, 0.09, r * 0.7, x - r * 0.24, y + 0.44, z, 2), P.HELIPAD_MARK);
  B.trim(box(r * 0.16, 0.09, r * 0.7, x + r * 0.24, y + 0.44, z, 2), P.HELIPAD_MARK);
  B.trim(box(r * 0.5, 0.09, r * 0.16, x, y + 0.44, z, 2), P.HELIPAD_MARK);
}

/** Sun lounger: frame, cushion, raked back. 3 boxes, reads instantly. */
function lounger(B, x, y, z, rot, hex) {
  const g = BufferGeometryUtils.mergeGeometries([
    box(0.74, 0.10, 1.90, 0, 0.30, 0, 1.5),
    box(0.64, 0.14, 1.70, 0, 0.38, 0, 1.5),
    box(0.10, 0.30, 0.10, -0.28, 0, 0.80, 1),
    box(0.10, 0.30, 0.10, 0.28, 0, 0.80, 1),
    box(0.10, 0.30, 0.10, -0.28, 0, -0.80, 1),
    box(0.10, 0.30, 0.10, 0.28, 0, -0.80, 1),
  ], false);
  const bk = box(0.64, 0.12, 0.72, 0, 0, 0, 1.5);
  bk.rotateX(-0.85);
  bk.translate(0, 0.60, -0.78);
  const all = BufferGeometryUtils.mergeGeometries([g, bk], false);
  all.rotateY(rot);
  all.translate(x, y, z);
  B.trim(all, hex);
}

/** Parasol on a slim mast. The pop of colour that sells a rooftop from above. */
function parasol(B, x, y, z, hex, s = 1) {
  B.trim(cyl(0.06, 2.4 * s, 6, x, y, z), P.ALUMINIUM);
  B.trim(cyl(1.45 * s, 0.42 * s, 8, x, y + 2.2 * s, z, 0.07), hex);
  B.trim(cyl(0.16, 0.10, 8, x, y, z), P.CONCRETE_DARK);
}

/** Slatted pergola over a deck: posts, beams and a run of slats. */
function pergola(B, x, y, z, w, d, hex) {
  const h = 2.7;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      B.trim(box(0.20, h, 0.20, x + sx * (w / 2 - 0.2), y, z + sz * (d / 2 - 0.2), 2), hex);
    }
  }
  B.trim(box(w, 0.22, 0.22, x, y + h, z - d / 2 + 0.2, 3), hex);
  B.trim(box(w, 0.22, 0.22, x, y + h, z + d / 2 - 0.2, 3), hex);
  const n = Math.max(3, Math.round(w / 0.9));
  for (let i = 0; i <= n; i++) {
    B.trim(box(0.14, 0.16, d, x - w / 2 + (w * i) / n, y + h + 0.22, z, 2), hex);
  }
  // Festoon bulbs slung under the beam. Twelve triangles apiece and they are
  // the whole reason a roof terrace reads as OPEN at midnight rather than as
  // another unlit lump of furniture.
  const nb = Math.max(3, Math.round(w / 1.3));
  for (let i = 0; i < nb; i++) {
    B.lit(box(0.16, 0.16, 0.16, x - w / 2 + (w * (i + 0.5)) / nb, y + h - 0.2, z + d / 2 - 0.25, 1));
  }
}

/** Rooftop bar: a counter, a back gantry and a row of stools. */
function roofBar(B, x, y, z, w, rot, hex, r) {
  const parts = [
    box(w, 1.12, 0.85, 0, 0, 0, 2.5),
    box(w + 0.34, 0.14, 1.05, 0, 1.12, 0, 3),
    box(w * 0.82, 2.1, 0.32, 0, 0, -1.1, 2.5),
  ];
  const n = Math.max(2, Math.round(w / 1.1));
  for (let i = 0; i < n; i++) {
    const sx = -w / 2 + (w * (i + 0.5)) / n;
    parts.push(cyl(0.16, 0.78, 6, sx, 0, 0.95));
  }
  const g = BufferGeometryUtils.mergeGeometries(parts, false);
  g.rotateY(rot); g.translate(x, y, z);
  B.trim(g, hex);
  // Back-bar glow: the one thing that makes a roof terrace read at night.
  const l = box(w * 0.78, 0.34, 0.16, 0, 0, 0, 2);
  l.rotateY(rot); l.translate(x, y + 1.5, z);
  l.translate(-Math.sin(rot) * 1.1, 0, -Math.cos(rot) * 1.1);
  B.lit(l);
}

/**
 * Rooftop pool terrace. Miami condos sell the roof, so this is where a
 * residential tower earns the 3/4 camera: real water, a timber deck, loungers
 * under parasols, a pergola and a bar.
 */
function rooftopPool(B, x, y, z, w, d, r) {
  const deck = movePlan(rectPlan(w + 5.2, d + 5.6, 1.4), x, z);
  B.trim(loft([{ p: deck, y }, { p: deck, y: y + 0.24 }], { capTop: true, uScale: 2.4 }), P.WOOD_DECK);
  // Coping ring, then the water dropped inside it so the lip reads as a lip.
  B.trim(parapetGeo(movePlan(rectPlan(w, d, 0.6), x, z), y + 0.24, 0.34, 0.34), P.CONCRETE);
  B.trim(box(w - 0.7, 0.14, d - 0.7, x, y + 0.30, z, 4), P.WATER_POOL);

  const nL = Math.max(2, Math.min(5, Math.round(d / 2.4)));
  for (let i = 0; i < nL; i++) {
    const lz = z - d / 2 + (i + 0.5) * (d / nL);
    lounger(B, x - w / 2 - 1.5, y + 0.24, lz, 0, r.chance(0.6) ? P.FABRIC_WHITE : P.TEAK);
    if (r.chance(0.55)) lounger(B, x + w / 2 + 1.5, y + 0.24, lz, Math.PI, P.FABRIC_WHITE);
  }
  for (let i = 0; i < 2; i++) {
    if (!r.chance(0.7)) continue;
    parasol(B, x + (i ? 1 : -1) * (w / 2 + 2.4), y + 0.24, z + (r() - 0.5) * d * 0.6,
      r.pick(FABRIC_COLORS), 0.85 + r() * 0.3);
  }
  if (r.chance(0.5) && w > 7) {
    pergola(B, x, y + 0.24, z + d / 2 + 2.4, Math.min(w, 7), 2.8,
      r.chance(0.5) ? P.WOOD_DARK : P.STUCCO_WHITE);
  }
  if (r.chance(0.45)) {
    roofBar(B, x, y + 0.24, z - d / 2 - 2.2, Math.min(w * 0.8, 6), 0, P.WOOD_DARK, r);
  }
}

/* ========================================================== terraces ==== */

/**
 * Sample points around a plan's perimeter, pulled `inset` metres inside it.
 *
 * A podium roof is almost never a field you can scatter on. The shaft grows out
 * of the middle of it, `roofScape` refuses any spot within 2.5 m of that shaft,
 * and it wants 4.1 m of clear radius per item — so on a podium drawn at 1.10x
 * the shaft (which is every tower in the city) the scatter found NOTHING and
 * the terrace rendered as a bare pale plane wrapping the base of the tower.
 * Measured on the review frames it is the largest untextured surface in the
 * whole skyline shot, which is art-bible anti-pattern #3 one level up.
 *
 * A real terrace is laid out along its edge anyway — planting on the parapet,
 * loungers facing out, tables in the corners — so this walks the ring instead
 * of trying to scatter in a middle that does not exist.
 */
function ringPoints(plan, inset, step) {
  const out = [];
  const n = plan.length;
  for (let i = 0; i < n; i++) {
    const a = plan[i], b = plan[(i + 1) % n];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.floor(L / step);
    if (k < 1) continue;
    const nn = edgeN(a, b);
    for (let j = 0; j < k; j++) {
      const t = (j + 0.5) / k;
      out.push({
        x: a[0] + (b[0] - a[0]) * t - nn[0] * inset,
        z: a[1] + (b[1] - a[1]) * t - nn[1] * inset,
        // +z of a placed object ends up pointing out over the parapet, which is
        // the way a lounger, a chair and a planter all actually face.
        rot: Math.atan2(nn[0], nn[1]),
        run: L,
      });
    }
  }
  return out;
}

/** Café table and two chairs. From the review camera this is a pale disc with
 *  two dots beside it — which is precisely what a terrace looks like from a
 *  helicopter, and nothing else on a roof makes that mark. */
function terraceTable(B, x, y, z, rot, hex) {
  const c = Math.cos(rot), s = Math.sin(rot);
  B.trim(cyl(0.08, 0.70, 6, x, y, z), P.STEEL_DARK);
  B.trim(cyl(0.52, 0.09, 10, x, y + 0.70, z), hex);
  for (const sx of [-1, 1]) {
    // Chairs sit to either side ALONG the parapet, not in front of the view.
    const cx = x + c * sx * 0.88, cz = z - s * sx * 0.88;
    const seat = box(0.44, 0.42, 0.44, 0, 0, 0, 1);
    seat.rotateY(rot); seat.translate(cx, y, cz);
    B.trim(seat, P.CHAIR);
    const back = box(0.44, 0.46, 0.09, 0, 0, -0.18, 1);
    back.rotateY(rot); back.translate(cx, y + 0.42, cz);
    B.trim(back, P.CHAIR);
  }
}

/** Potted palm in a tub. The only saturated green a terrace shows from directly
 *  above, and the cheapest way to make a roof read as inhabited. */
function terracePot(B, x, y, z, s, hex, phase = 0) {
  B.trim(cyl(0.36 * s, 0.60 * s, 8, x, y, z, 0.48 * s), hex);
  B.trim(cyl(0.13 * s, 1.00 * s, 6, x, y + 0.6 * s, z), P.WOOD_DARK);
  for (let i = 0; i < 4; i++) {
    const g = box(1.45 * s, 0.09 * s, 0.34 * s, 0.62 * s, 0, 0, 1.6);
    g.rotateZ(-0.30);
    g.rotateY((i / 4) * Math.PI * 2 + phase);
    g.translate(x, y + 1.5 * s, z);
    B.trim(g, i % 2 ? P.PALM_FROND : P.PALM_FROND_DARK);
  }
}

/**
 * Lay a usable roof terrace over `plan` and dress its edge.
 *
 * Returns the points it consumed so the caller's scatter can avoid dropping a
 * chiller on top of a sun lounger.
 */
function terraceDeck(B, plan, y, r, o = {}) {
  const taken = [];
  // A real raised deck with a visible edge, not a repaint: a second cap at the
  // same height as the roof surface z-fights across the whole roof from 300 m.
  B.trim(loft([{ p: plan, y }, { p: plan, y: y + 0.14 }], { capTop: true, uScale: 2.2 }),
    o.deckHex || (r.chance(0.55) ? P.WOOD_DECK : P.PLAZA));
  const top = y + 0.14;
  const rail = o.railHex || P.PLANTER;
  for (const p of ringPoints(plan, 1.35, 5.0)) {
    if (o.avoid && inPlan(o.avoid, p.x, p.z)) continue;
    const roll = r();
    if (roll < 0.30) {
      const g = box(2.2, 0.62, 0.85, 0, 0, 0, 2);
      g.rotateY(p.rot); g.translate(p.x, top, p.z);
      B.trim(g, rail);
      const h = box(1.95, 0.34, 0.66, 0, 0, 0, 2);
      h.rotateY(p.rot); h.translate(p.x, top + 0.62, p.z);
      B.trim(h, r.chance(0.5) ? P.HEDGE : P.HEDGE_LIGHT);
    } else if (roll < 0.50) {
      lounger(B, p.x, top, p.z, p.rot, r.chance(0.6) ? P.FABRIC_WHITE : P.TEAK);
    } else if (roll < 0.63) {
      parasol(B, p.x, top, p.z, r.pick(FABRIC_COLORS), 0.78 + r() * 0.3);
    } else if (roll < 0.78) {
      terraceTable(B, p.x, top, p.z, p.rot, P.TABLE_TOP);
    } else if (roll < 0.90) {
      terracePot(B, p.x, top, p.z, 0.85 + r() * 0.4,
        r.chance(0.5) ? P.PLANTER : P.TERRACOTTA, r() * 6.28);
    } else {
      continue;   // deliberate gaps: a terrace packed edge to edge reads as a comb
    }
    taken.push([p.x, p.z]);
  }
  return taken;
}

/* =========================================================== signage ==== */

/**
 * Illuminated channel letters on a frame. `w` is the whole sign, letters are
 * blocks — real glyphs at 200 m are mush, and blocks read as a wordmark.
 *
 * The frame is skin, the letters are emissive, so the sign is a dark rack by
 * day and a burning name at night, off one shared material each.
 */
function channelSign(B, x, y, z, w, h, rot, r, hex, legs = true) {
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const push = (g, ox, oy, oz) => {
    g.rotateY(rot);
    g.translate(x + ox * cos + oz * sin, y + oy, z - ox * sin + oz * cos);
    return g;
  };
  if (legs) {
    for (const sx of [-1, 1]) {
      B.trim(push(box(0.16, h * 1.5, 0.16, 0, 0, 0, 2), sx * (w / 2 - 0.3), -h * 1.5, 0), P.STEEL_DARK);
    }
    B.trim(push(box(w, 0.14, 0.14, 0, 0, 0, 3), 0, -0.14, 0), P.STEEL_DARK);
  }
  // Letters: 3-7 blocks of unequal width, with real gaps between them.
  const n = 3 + Math.floor(r() * 5);
  const gap = w * 0.045;
  const avail = w * 0.9 - gap * (n - 1);
  let cx = -w * 0.45;
  for (let i = 0; i < n; i++) {
    const lw = (avail / n) * (0.62 + r() * 0.72);
    const lh = h * (0.72 + r() * 0.28);
    // box() already stands its geometry on y = 0, so the letter sits on the
    // sign baseline with no vertical offset of its own.
    B.lit(push(box(lw, lh, 0.22, 0, 0, 0, 1.2), cx + lw / 2, 0, 0), hex);
    cx += lw + gap;
    if (cx > w * 0.45) break;
  }
}

/** Illuminated band wrapped round a plan — crown lighting, podium fascia. */
function litBand(B, plan, y, h, proj, hex) {
  const p = offsetPlan(plan, proj);
  B.lit(loft([{ p, y }, { p, y: y + h }], {}), hex);
}

/**
 * Vertical neon blade running down a building corner. Deco hotels wear these
 * and they are the cheapest possible way to make a night skyline feel Miami.
 */
function neonBlade(B, x, z, y0, y1, rot, hex, w = 0.9) {
  const g = box(w, y1 - y0, 0.24, 0, y0, 0, 2);
  g.rotateY(rot); g.translate(x, 0, z);
  B.lit(g, hex);
  const f = box(w + 0.4, y1 - y0 + 0.5, 0.16, 0, y0 - 0.25, 0, 2);
  f.rotateY(rot); f.translate(x - Math.sin(rot) * 0.12, 0, z - Math.cos(rot) * 0.12);
  B.trim(f, P.STEEL_DARK);
}

/** Address numerals beside a doorway. Tiny, but it is what the player drives past. */
function addressPlate(B, x, y, zFace, hex) {
  B.trim(box(1.5, 0.5, 0.1, x, y, zFace + 0.06, 1), hex);
  for (let i = 0; i < 3; i++) {
    B.lit(box(0.16, 0.3, 0.06, x - 0.45 + i * 0.4, y + 0.1, zFace + 0.12, 1), P.NEON_WHITE);
  }
}

/**
 * Populate a roof: parapet, deck, plant. This is the single highest-value
 * detail pass in the file — the 3/4 camera shows roofs almost every frame.
 */
/** Two or three condensers on one shared skid — one object, not three specks. */
function acPack(B, x, y, z, rot, s, r) {
  const n = 2 + (r() < 0.45 ? 1 : 0);
  const w = 1.6 * s, gap = 0.28 * s;
  const span = n * w + (n - 1) * gap;
  const parts = [box(span + 0.5 * s, 0.22 * s, 1.5 * s, 0, 0, 0, 3)];
  const g0 = BufferGeometryUtils.mergeGeometries(parts, false);
  g0.rotateY(rot); g0.translate(x, y, z);
  B.trim(g0, P.STEEL_DARK);
  for (let i = 0; i < n; i++) {
    const ox = -span / 2 + w / 2 + i * (w + gap);
    acUnit(B, x + Math.cos(rot) * ox, y + 0.22 * s, z - Math.sin(rot) * ox, s * (0.9 + r() * 0.25), r);
  }
}

/** Big packaged chiller: the single largest thing on most commercial roofs. */
function chiller(B, x, y, z, rot, s, r) {
  const w = 5.4 * s, d = 2.3 * s, h = 2.0 * s;
  const parts = [
    box(w, h, d, 0, 0, 0, 3),
    box(w + 0.4, 0.22, d + 0.4, 0, h, 0, 3),
    box(w * 0.3, 0.5, d * 0.8, -w * 0.32, h + 0.22, 0, 2),
  ];
  const g = BufferGeometryUtils.mergeGeometries(parts, false);
  g.rotateY(rot); g.translate(x, y, z);
  B.trim(g, P.AC_METAL);
  for (let i = 0; i < 3; i++) {
    const ox = (i - 1) * w * 0.3;
    B.trim(cyl(0.62 * s, 0.26 * s, 10, x + Math.cos(rot) * ox, y + h + 0.22, z - Math.sin(rot) * ox), P.STEEL_DARK);
  }
}

/**
 * Tilted PV array on rails.
 *
 * Worth its triangles because nothing else on a roof looks like it: a dark,
 * ordered rectangle among pale lumpy machinery, which is exactly the kind of
 * mark that survives being 200 m from the lens and stops one roof reading as
 * the same grey speckle as the next.
 */
function solarArray(B, x, y, z, w, d, rot) {
  const rows = Math.max(2, Math.min(4, Math.round(d / 1.5)));
  const rails = [], panes = [];
  for (let i = 0; i < rows; i++) {
    const oz = -d / 2 + (i + 0.5) * (d / rows);
    rails.push(box(w, 0.26, 0.14, 0, 0, oz - 0.42, 2));
    rails.push(box(w, 0.62, 0.14, 0, 0, oz + 0.42, 2));
    const g = box(w, 0.08, 1.15, 0, 0, 0, 2);
    g.rotateX(-0.38);
    g.translate(0, 0.52, oz);
    panes.push(g);
  }
  const rg = BufferGeometryUtils.mergeGeometries(rails, false);
  rg.rotateY(rot); rg.translate(x, y, z);
  B.trim(rg, P.STEEL_DARK);
  const pg = BufferGeometryUtils.mergeGeometries(panes, false);
  pg.rotateY(rot); pg.translate(x, y, z);
  B.trim(pg, P.SPANDREL);
}

/** Induced-draught cooling tower: louvred casing, fan cowl, guard ring. Taller
 *  than a chiller, so it is what gives a roof a second silhouette. */
function coolingTower(B, x, y, z, s, r) {
  const w = 3.2 * s, d = 2.5 * s, h = 3.0 * s;
  B.trim(box(w, h, d, x, y, z, 3), P.PRECAST);
  for (let i = 0; i < 4; i++) {
    B.trim(box(w + 0.14, 0.14 * s, d + 0.14, x, y + h * (0.22 + i * 0.17), z, 2), P.STEEL_DARK);
  }
  const rr = Math.min(w, d) * 0.42;
  B.trim(cyl(rr, 0.62 * s, 12, x, y + h, z), P.VENT_METAL);
  B.trim(cyl(rr * 1.1, 0.12 * s, 12, x, y + h + 0.62 * s, z), P.STEEL);
  if (r() < 0.5) B.trim(box(0.22 * s, 1.4 * s, 0.22 * s, x + w * 0.4, y + h, z, 2), P.VENT_METAL);
}

/** Raised glazed monitors. A low commercial roof reads as a shed, not a slab. */
function skylightRun(B, x, y, z, len, rot, hex) {
  const n = Math.max(2, Math.min(4, Math.round(len / 2.6)));
  const kerbs = [], glz = [];
  for (let i = 0; i < n; i++) {
    const ox = -len / 2 + (i + 0.5) * (len / n);
    kerbs.push(box(1.9, 0.3, 1.6, ox, 0, 0, 2));
    const a = box(1.85, 0.1, 1.0, 0, 0, 0, 2); a.rotateX(0.44); a.translate(ox, 0.52, -0.4);
    const b = box(1.85, 0.1, 1.0, 0, 0, 0, 2); b.rotateX(-0.44); b.translate(ox, 0.52, 0.4);
    glz.push(a, b);
  }
  const kg = BufferGeometryUtils.mergeGeometries(kerbs, false);
  kg.rotateY(rot); kg.translate(x, y, z);
  B.trim(kg, P.CONCRETE_DARK);
  const gg = BufferGeometryUtils.mergeGeometries(glz, false);
  gg.rotateY(rot); gg.translate(x, y, z);
  B.trim(gg, hex || P.GLASS_SKY);
}

/** A run of planters. The cheapest possible roof garden, and the only green on
 *  a roof that the 3/4 camera can actually pick out. */
function planterRun(B, x, y, z, len, rot, hex) {
  const n = Math.max(2, Math.min(5, Math.round(len / 2.2)));
  const tubs = [], green = [];
  for (let i = 0; i < n; i++) {
    const ox = -len / 2 + (i + 0.5) * (len / n);
    tubs.push(box(1.55, 0.62, 0.95, ox, 0, 0, 2));
    green.push(box(1.3, 0.46, 0.72, ox, 0.62, 0, 2));
  }
  const t = BufferGeometryUtils.mergeGeometries(tubs, false);
  t.rotateY(rot); t.translate(x, y, z);
  B.trim(t, hex);
  const g = BufferGeometryUtils.mergeGeometries(green, false);
  g.rotateY(rot); g.translate(x, y, z);
  B.trim(g, P.HEDGE);
}

/**
 * Rooftop hoarding on a steel frame.
 *
 * The loudest thing a low roof can wear, and after dark it is what stops the
 * downtown block between the towers going black. The face is `lit`, so it costs
 * no mesh of its own on any building that already carries signage.
 */
function billboard(B, x, y, z, w, h, rot, hex, r) {
  const legH = 1.4 + r() * 1.8;
  const parts = [
    box(0.32, legH + h, 0.32, -(w / 2 - 0.5), 0, 0, 2),
    box(0.32, legH + h, 0.32, (w / 2 - 0.5), 0, 0, 2),
    box(w, 0.24, 0.5, 0, legH - 0.24, 0, 3),
    box(w, 0.24, 0.5, 0, legH + h, 0, 3),
    box(w * 0.9, 0.14, 0.14, 0, legH - 0.55, 0.9, 2),   // flood gantry
  ];
  // Raking back braces. On two vertical posts a hoarding has no depth at all
  // from the 3/4 camera and reads as a decal laid across the parapet; the
  // braces are what make it a structure standing ON a roof.
  const rise = legH + h * 0.6;
  for (const s of [-1, 1]) {
    // Foot on the roof 1.9 m behind the hoarding, head against the post. The
    // rotation happens while the box still stands on the origin, so it pivots
    // about its own foot rather than about the building's base.
    const g = box(0.18, Math.hypot(rise, 1.9), 0.18, 0, 0, 0, 2);
    g.rotateX(Math.atan2(1.9, rise));
    g.translate(s * (w / 2 - 0.9), 0, -1.9);
    parts.push(g);
  }
  // Flood heads along the gantry, aimed up at the face.
  const nF = Math.max(2, Math.round(w / 4.5));
  for (let i = 0; i < nF; i++) {
    parts.push(box(0.4, 0.26, 0.34, -w * 0.42 + (w * 0.84 * (i + 0.5)) / nF, legH - 0.74, 0.9, 1.5));
  }
  const frame = BufferGeometryUtils.mergeGeometries(parts, false);
  frame.rotateY(rot); frame.translate(x, y, z);
  B.trim(frame, P.STEEL_DARK);
  // Three panels with a real reveal between them. One 18 m rectangle of flat
  // emissive is a slab; three with dark gaps reads as printed advertising, and
  // it costs eight extra triangles.
  const gap = 0.3, pw = (w - 0.9 - gap * 2) / 3;
  for (let i = 0; i < 3; i++) {
    const g = box(pw, h - 0.35, 0.16, -(w - 0.9) / 2 + pw / 2 + i * (pw + gap), legH + 0.18, 0.2, 3);
    g.rotateY(rot); g.translate(x, y, z);
    B.lit(g, hex);
  }
}

/**
 * Framed box sign on a roof: a dark steel rack carrying one glowing panel.
 *
 * The third roof-sign type. Channel letters and a hoarding were the only two,
 * and a city where every roof wears one of two racks is the same repeat one
 * storey up — this is the internally-lit fascia box that half of downtown
 * actually carries, and it reads as a solid bar of colour at any distance where
 * individual letters have already turned to mush.
 */
function boxSign(B, x, y, z, w, h, rot, hex) {
  const push = (g) => { g.rotateY(rot); g.translate(x, y, z); return g; };
  B.trim(push(box(w + 0.6, 0.3, 0.75, 0, 0, 0, 3)), P.STEEL_DARK);
  B.trim(push(box(w + 0.6, 0.3, 0.75, 0, h + 0.3, 0, 3)), P.STEEL_DARK);
  for (const sx of [-1, 1]) {
    B.trim(push(box(0.34, h + 0.6, 0.55, sx * (w / 2 + 0.13), 0, 0, 2)), P.STEEL_DARK);
    B.trim(push(box(0.2, h * 1.7, 0.2, sx * (w / 2 - 0.4), -h * 1.7, -0.3, 2)), P.STEEL_DARK);
  }
  B.lit(push(box(w * 0.95, h, 0.24, 0, 0.3, 0.1, 3)), hex);
}

/**
 * Louvred screen enclosing rooftop plant.
 *
 * Real commercial roofs hide their machinery behind an acoustic screen, and it
 * is the one roof object with a flat, deliberate, man-made outline — everything
 * else up there is lumpy. That contrast is what stops a roof reading as one
 * undifferentiated field of grey speckle from the review camera.
 */
function plantScreen(B, x, y, z, w, d, rot, hex, r) {
  const pl = movePlan(rotPlan(rectPlan(w, d, Math.min(w, d) * 0.16), rot), x, z);
  const h = 2.4 + r() * 0.9;
  B.trim(parapetGeo(pl, y, h, 0.26), hex);
  for (let i = 1; i <= 3; i++) {
    B.trim(slabGeo(pl, y + (h * i) / 4, 0.1, 0.13), P.STEEL_DARK);
  }
  // Kit inside, poking just over the screen so it reads as an enclosure.
  const n = 1 + (r() < 0.6 ? 1 : 0);
  for (let i = 0; i < n; i++) {
    const ox = (i - (n - 1) / 2) * w * 0.36;
    B.trim(cyl(Math.min(0.85, w * 0.16), h * 0.42, 10,
      x + Math.cos(rot) * ox, y + h * 0.72, z - Math.sin(rot) * ox), P.VENT_METAL);
  }
}

/**
 * Rooftop sports deck: a coloured court with a perimeter cage. Reads as a hard
 * rectangle of saturated colour from directly above, which is exactly the kind
 * of mark the steep camera can pick out at 250 m.
 */
function roofCourt(B, x, y, z, w, d, rot, hex) {
  const pl = movePlan(rotPlan(rectPlan(w, d, 0.6), rot), x, z);
  B.trim(loft([{ p: pl, y }, { p: pl, y: y + 0.12 }], { capTop: true, uScale: 3 }), hex);
  B.trim(parapetGeo(pl, y + 0.12, 0.3, 0.16), P.CONCRETE_WARM);
  const bb = planBounds(pl);
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    B.trim(cyl(0.07, 2.6, 6, bb.x0 + bb.w * t, y + 0.12, bb.z0 + 0.2), P.STEEL_DARK);
    B.trim(cyl(0.07, 2.6, 6, bb.x0 + bb.w * t, y + 0.12, bb.z1 - 0.2), P.STEEL_DARK);
  }
  B.trim(box(w * 0.9, 0.08, 0.08, x, y + 2.7, z, 3), P.STEEL);
}

/** Sedum tray / gravel-ballast patch. Breaks a bald roof into fields. */
function roofPatch(B, x, y, z, w, d, hex) {
  B.trim(box(w, 0.12, d, x, y, z, 3), hex);
  B.trim(box(w + 0.3, 0.2, 0.18, x, y, z - d / 2 - 0.09, 2), P.CONCRETE_DARK);
  B.trim(box(w + 0.3, 0.2, 0.18, x, y, z + d / 2 + 0.09, 2), P.CONCRETE_DARK);
}

/** Roof deck surfaces, so not every roof in the city is the same grey gravel. */
const ROOF_SURFACE = [
  [P.ROOF_GRAVEL, 34], [P.ROOF_MEMBRANE, 22], [P.ROOF_TAR, 14],
  [P.CONCRETE_DARK, 12], [P.ROOF, 18],
];

/** Nudge a hex in value and a little in hue. Used for per-roll membrane tone. */
function jitterHex(hex, v, w) {
  const r0 = (hex >> 16) & 255, g0 = (hex >> 8) & 255, b0 = hex & 255;
  const c = (x, k) => Math.max(0, Math.min(255, Math.round(x * v * k)));
  return (c(r0, 1 + w) << 16) | (c(g0, 1) << 8) | c(b0, 1 - w);
}

/**
 * The largest axis-aligned rectangle centred on a convex plan that still fits
 * inside it. Coarse (6% steps) on purpose — it only has to find somewhere safe
 * to lay membrane, and every failed test is four half-plane checks.
 */
function inscribedRect(plan, margin) {
  const bb = planBounds(plan);
  const inner = offsetPlan(plan, -margin);
  for (let k = 0.96; k > 0.30; k -= 0.06) {
    const hw = bb.w * 0.5 * k, hd = bb.d * 0.5 * k;
    if (inPlan(inner, bb.cx - hw, bb.cz - hd) && inPlan(inner, bb.cx + hw, bb.cz - hd)
      && inPlan(inner, bb.cx + hw, bb.cz + hd) && inPlan(inner, bb.cx - hw, bb.cz + hd)) {
      return { cx: bb.cx, cz: bb.cz, w: hw * 2, d: hd * 2 };
    }
  }
  return null;
}

/**
 * Lay the roof.
 *
 * WHY IT IS LAID IN ROLLS AND NOT FILLED WITH ONE QUAD.
 * Everything in this file that carries a colour rather than a texture pins its
 * UVs to one flat texel — that is the trick that keeps a whole building down to
 * a single draw call, and on a cornice or a vent it is free. On a 40 x 25 m
 * roof cap it is not: the deck came out as one perfectly uniform plane, and
 * measured on the `rooftops` preset that plane was the largest untextured area
 * anywhere in the frame. Art-bible anti-pattern #3, fifty storeys up, on every
 * building in the city.
 *
 * A single-ply roof is actually laid in two-metre rolls, lapped, and no two
 * rolls off the same wagon are quite the same colour. So the deck is built as
 * rolls with per-roll tone — real construction, no extra material, no extra
 * draw call, and about sixty triangles. That is the tonal structure the eye
 * needs at the 100-200 m the review camera actually sits at.
 */
function roofDeck(B, plan, y, hex, r) {
  B.trim(loft([{ p: plan, y }], { capTop: true, uScale: 3 }), hex);
  const rect = inscribedRect(plan, 0.7);
  if (!rect) return;
  const along = r.chance(0.5);
  const span = along ? rect.w : rect.d;      // across the rolls
  const run = along ? rect.d : rect.w;       // along them
  if (span < 4 || run < 3) return;
  const n = Math.max(2, Math.min(16, Math.round(span / 2.2)));
  const rw = span / n;
  for (let i = 0; i < n; i++) {
    const off = -span / 2 + rw * (i + 0.5);
    // Value walks rather than jumping, so the roof reads as one field that is
    // unevenly weathered instead of as a barcode.
    const v = 0.94 + ((i * 7919) % 13) / 13 * 0.13;
    const tone = jitterHex(hex, v, ((i * 4993) % 7) / 7 * 0.05 - 0.02);
    const w = along ? rw - 0.10 : run;
    const d = along ? run : rw - 0.10;
    B.trim(box(w, 0.05, d, rect.cx + (along ? off : 0), y + 0.01,
      rect.cz + (along ? 0 : off), 3), tone);
  }
}

/**
 * Populate a roof: parapet, deck, plant. This is the single highest-value
 * detail pass in the file — the 3/4 camera shows roofs almost every frame.
 *
 * WHY THE ITEMS GOT BIGGER AND FEWER.
 * The first version scattered up to 26 sub-metre objects on a spacing of 3 m.
 * From the review camera that minifies into speckle — the roof read as noise,
 * not as machinery, and every roof read as the SAME noise. Plant now comes in
 * chunks (a chiller, a skid of condensers, a patch of ballast) on a 4.4 m
 * spacing, which is both how a real roof is laid out and what survives being
 * 200 m from the lens.
 */
function roofScape(B, plan, y, r, o = {}) {
  const bb = planBounds(plan);
  const area = bb.w * bb.d;
  const ph = o.parapetH ?? (0.85 + r() * 0.7);
  B.trim(parapetGeo(plan, y, ph, 0.42), o.parapetHex || P.PARAPET);
  roofDeck(B, plan, y + 0.03, o.surfaceHex || r.weighted(ROOF_SURFACE), r);

  /*
   * BREAK THE FIELD BEFORE ANYTHING IS PUT ON IT.
   *
   * The rolls give the deck its tone; these give it a HISTORY. A second
   * membrane field where the last re-roof stopped, a walkway of pavers from the
   * stair door out to the plant, and the ring of ballast round a drain — the
   * marks that say a person has been up here.
   */
  if (area > 420) {
    B.trim(box(bb.w * (0.30 + r() * 0.26), 0.07, bb.d * (0.32 + r() * 0.28),
      bb.cx + (r() - 0.5) * bb.w * 0.28, y + 0.04, bb.cz + (r() - 0.5) * bb.d * 0.28, 3),
    r.weighted(ROOF_SURFACE));
    const wz = bb.cz + (r() - 0.5) * bb.d * 0.44;
    B.trim(box(bb.w * 0.88, 0.09, 1.3, bb.cx, y + 0.04, wz, 3), P.CONCRETE_WARM);
    // Rainwater outlet: a sump ring with the pipe boss in it. Two cylinders,
    // and it is the one mark on a roof that is unmistakably plumbing.
    const dx = bb.cx + (r() - 0.5) * bb.w * 0.5, dz = bb.cz + (r() - 0.5) * bb.d * 0.5;
    if (inPlan(offsetPlan(plan, -2.0), dx, dz)) {
      B.trim(cyl(1.05, 0.06, 10, dx, y + 0.04, dz), P.ROOF_TAR);
      B.trim(cyl(0.34, 0.16, 8, dx, y + 0.06, dz), P.STEEL_DARK);
    }
  }

  // A usable terrace, laid out along the parapet. See ringPoints.
  const taken = o.deck
    ? terraceDeck(B, offsetPlan(plan, -0.5), y + 0.04, r,
      { avoid: o.avoid, deckHex: o.deckHex, railHex: o.parapetHex })
    : [];

  const inner = offsetPlan(plan, -2.4);
  const spots = [];
  const tries = Math.min(20, 3 + Math.round(area / 62));
  for (let i = 0; i < tries * 4 && spots.length < tries; i++) {
    const x = bb.cx + (r() - 0.5) * bb.w * 0.84;
    const z = bb.cz + (r() - 0.5) * bb.d * 0.84;
    if (!inPlan(inner, x, z)) continue;
    // A podium roof has a tower growing out of it; plant must dodge the shaft.
    if (o.avoid && inPlan(o.avoid, x, z)) continue;
    let ok = true;
    for (const s of spots) if (Math.hypot(s[0] - x, s[1] - z) < 4.1) { ok = false; break; }
    // ...and it must dodge the terrace furniture, which was placed on a ring
    // the scatter knows nothing about.
    if (ok) for (const s of taken) if (Math.hypot(s[0] - x, s[1] - z) < 3.2) { ok = false; break; }
    if (ok) spots.push([x, z]);
  }
  // Plant lines up with the building, not with the random number generator:
  // real roofs run their kit square to the parapet.
  const rot = r.chance(0.5) ? 0 : Math.PI / 2;

  let i = 0;
  // Big-ticket items first, so they get the middle of the roof.
  if (o.helipad && area > 900 && spots.length) {
    i = 1;
    helipad(B, bb.cx, y + 0.05, bb.cz, Math.min(7.5, bb.w * 0.22));
  }
  if (o.pool && area > 620 && spots.length > i) {
    rooftopPool(B, bb.cx + (r() - 0.5) * 3, y + 0.05, bb.cz,
      Math.min(11, bb.w * 0.32), Math.min(6.5, bb.d * 0.24), r);
    i += 2;
  }
  if (area > 260 && spots.length > i + 1) {
    const s = spots[i++];
    bulkhead(B, s[0], y + 0.05, s[1], 3.4, 3.0, 2.9 + r() * 1.4,
      r.chance(0.5) ? P.CONCRETE_DARK : (o.parapetHex || P.PRECAST));
  }
  // A packaged chiller belongs on a plant roof, not in the middle of a terrace
  // somebody is meant to sunbathe on. The stair bulkhead above stays: a terrace
  // has to be reached from somewhere, and that door is what tells you so.
  if (!o.deck && area > 700 && spots.length > i && r.chance(0.7)) {
    const s = spots[i++]; chiller(B, s[0], y + 0.05, s[1], rot, 0.85 + r() * 0.45, r);
  }
  if (o.tank !== false && area > 200 && spots.length > i) {
    const s = spots[i++]; waterTank(B, s[0], y + 0.05, s[1], 0.8 + r() * 0.35);
  }
  for (; i < spots.length; i++) {
    const s = spots[i];
    const roll = r();
    if (o.deck) {
      // The middle of a terrace is still terrace. Only the kit a hotel roof
      // actually shows out there — planting, a pergola, a shaded table — plus
      // the one vent stack every deck really does have poking through it.
      if (roll < 0.30) planterRun(B, s[0], y + 0.19, s[1], 2.4 + r() * 1.8, rot, o.parapetHex || P.PLANTER);
      else if (roll < 0.52) pergola(B, s[0], y + 0.19, s[1], 3.4 + r() * 2.2, 2.6 + r() * 0.8, r.chance(0.5) ? P.WOOD_DARK : P.STUCCO_WHITE);
      else if (roll < 0.66) terraceTable(B, s[0], y + 0.19, s[1], rot, P.TABLE_TOP);
      else if (roll < 0.78) parasol(B, s[0], y + 0.19, s[1], r.pick(FABRIC_COLORS), 0.85 + r() * 0.3);
      else if (roll < 0.86) terracePot(B, s[0], y + 0.19, s[1], 1.0 + r() * 0.5, P.PLANTER_DARK, r() * 6.28);
      else if (roll < 0.94) ventStack(B, s[0], y + 0.05, s[1], 0.8 + r() * 0.5);
      else roofBar(B, s[0], y + 0.19, s[1], 3.4 + r() * 2.0, rot, P.WOOD_DARK, r);
      continue;
    }
    if (roll < 0.22) acPack(B, s[0], y + 0.05, s[1], rot, 0.9 + r() * 0.5, r);
    else if (roll < 0.31) {
      roofPatch(B, s[0], y + 0.05, s[1], 3.0 + r() * 2.4, 2.4 + r() * 1.8,
        r.chance(0.45) ? P.HEDGE : P.GRAVEL);
    } else if (roll < 0.36) ventStack(B, s[0], y + 0.05, s[1], 0.9 + r() * 0.7);
    // Spots are only guaranteed 2.4 m inside the parapet, and a duct is drawn
    // about its centre — an unclamped 5.5 m run reached past the roof edge and
    // out over the lot line, which on a split block is the neighbour's air.
    else if (roll < 0.44) ductRun(B, s[0], y + 0.05, s[1], 2.5 + r() * 1.5, rot, 1.3);
    else if (roll < 0.50) dish(B, s[0], y + 0.05, s[1], 0.8 + r() * 0.6);
    else if (roll < 0.60) solarArray(B, s[0], y + 0.05, s[1], 2.6 + r() * 2.0, 2.2 + r() * 1.4, rot);
    else if (roll < 0.67) coolingTower(B, s[0], y + 0.05, s[1], 0.7 + r() * 0.4, r);
    else if (roll < 0.74) skylightRun(B, s[0], y + 0.05, s[1], 2.6 + r() * 2.0, rot, P.GLASS_SKY);
    else if (roll < 0.81) planterRun(B, s[0], y + 0.05, s[1], 2.4 + r() * 2.0, rot, o.parapetHex || P.PLANTER);
    else if (roll < 0.90) {
      plantScreen(B, s[0], y + 0.05, s[1], 3.0 + r() * 1.8, 2.4 + r() * 1.2, rot,
        r.chance(0.5) ? (o.parapetHex || P.PARAPET) : P.PRECAST, r);
    } else if (roll < 0.95 && area > 900) {
      roofCourt(B, s[0], y + 0.05, s[1], 5.4 + r() * 1.6, 3.6 + r() * 1.2, rot,
        r.weighted([[P.CAR_TEAL, 10], [P.HEDGE, 9], [P.TERRACOTTA, 8], [P.CAR_BLUE, 6]]));
    } else if (roll < 0.97) B.trim(box(2.0 + r() * 1.4, 0.7, 1.5 + r(), s[0], y + 0.05, s[1], 3), P.ROOF_MEMBRANE);
    else acUnit(B, s[0], y + 0.05, s[1], 1.1 + r() * 0.6, r);
  }

  // A name on the roof. Only worth it on something big enough to carry it, and
  // a hoarding some of the time — a city where every roof sign is the same
  // channel-letter rack is the same repeat one level up.
  if (o.sign && bb.w > 15) {
    const pick = r();
    if (pick < 0.30 && bb.d > 9) {
      billboard(B, bb.cx, y + ph - 0.2, bb.cz + bb.d * 0.24,
        Math.min(bb.w * 0.66, 18), 3.0 + r() * 2.4, 0, B.neon, r);
    } else if (pick < 0.56) {
      boxSign(B, bb.cx, y + ph + 1.5, bb.cz + bb.d * 0.28,
        Math.min(bb.w * 0.56, 15), 1.9 + r() * 1.3, 0, B.neon);
    } else {
      channelSign(B, bb.cx, y + ph + 1.4, bb.cz + bb.d * 0.30,
        Math.min(bb.w * 0.62, 22), 2.4 + r() * 1.4, 0, r, B.neon);
    }
  }
}

/* ================================================== shared components === */

/**
 * Retail podium.
 *
 * The obvious construction — solid wall, then a glass band inset behind it —
 * renders as a blank concrete box, because the wall is in front of the glass.
 * So the wall STOPS at the shopfront head and the glazing occupies that band
 * outright, with piers standing proud of it. That is also how a real podium is
 * built, and it is what gives the base of a tower any scale at all.
 *
 * @param {?THREE.Material} glassMat when null the shopfront is a dark recessed
 *        band in the skin material instead of a curtain-wall mesh.
 */
function podium(B, plan, h, r, glassMat, opts = {}) {
  const bb = planBounds(plan);
  const head = Math.min(h - 1.6, 5.8);
  const pal = opts.pal || BASE_PAL_DEFAULT;
  const pierHex = opts.pierHex || pal.pier;
  const bandHex = opts.bandHex || pal.band;
  const neon = opts.neon || B.neon;
  /*
   * BASE ARCHETYPE.
   *
   * Every podium in the city used to be built by exactly this function with
   * exactly one composition — 0.45 m recessed glass, a comb of square piers, a
   * centred canopy, two planters and the address plate on the left. Four
   * hundred buildings wore it, and the base is the ONLY part of a tower the
   * player ever drives past, so it was also the most-looked-at repeat in the
   * game. These three are the ways a Miami base actually meets its pavement,
   * and they differ in the one thing you can see from a car: how deep the
   * shadow at the bottom of the building is.
   */
  const arch = opts.baseStyle || r.weighted([
    ['pier', 40],     // shallow reveal, square piers — the office base
    ['arcade', 30],   // deep colonnade, glass pulled 2 m back into shade
    ['plinth', 30],   // raised terrace with steps, glass flush behind piers
  ]);
  const recess = arch === 'arcade' ? Math.min(2.3, Math.min(bb.w, bb.d) * 0.10)
    : arch === 'plinth' ? 0.25 : 0.45;
  const inner = offsetPlan(plan, -recess);
  // A raised entrance terrace: the base sits on a step, not on the tarmac.
  const sill = arch === 'plinth' ? 0.85 + r() * 0.4 : 0.55;

  B.trim(loft([{ p: plan, y: 0 }, { p: plan, y: sill }], { uScale: 5, vScale: 5 }), P.CONCRETE_DARK);
  if (glassMat) {
    B.gl(loft([{ p: inner, y: sill }, { p: inner, y: head }], { uScale: CW_U, vScale: CW_V }), glassMat);
  } else {
    B.trim(loft([{ p: inner, y: sill }, { p: inner, y: head }], { uScale: 4, vScale: 4 }), P.SPANDREL);
  }
  /*
   * THE SHOPFRONT ITSELF.
   *
   * The glazing used to be one unbroken ribbon from corner to corner with a
   * comb of structural piers standing in front of it, which at street level
   * reads as a glass box with columns, not as a parade of shops. Real retail
   * glazing is divided: a stall riser you can kick, a mullion every three and a
   * half metres, and a transom about two metres up with the shop signage above
   * it. Three thin rings of geometry, all merged into the skin mesh, and they
   * are the difference between "podium" and "row of shops" from a car.
   */
  const nBay = Math.max(4, Math.min(34, Math.round(planPerimeter(inner) / 3.4)));
  B.trim(slabGeo(inner, sill, 0.34, 0.13), P.CONCRETE_DARK);           // stall riser
  fins(B, inner, sill + 0.34, head - 0.1, nBay, 0.16, P.MULLION);      // bay mullions
  if (head - sill > 3.4) {
    B.trim(slabGeo(inner, head - 1.35, 0.18, 0.13), P.MULLION);        // transom
  }

  const nP = Math.max(6, Math.min(20, Math.round(planPerimeter(plan) / 7)));
  if (arch === 'arcade') {
    // Round columns on the building line with an open soffit behind them. The
    // deepest shadow any base in the kit throws, and the reason the arcade
    // reads instantly as a different building from its neighbour.
    const cr = Math.max(0.38, Math.min(0.62, recess * 0.28));
    for (let i = 0; i < nP; i++) {
      const t = (i / nP) * plan.length;
      const a = plan[Math.floor(t) % plan.length], b2 = plan[(Math.floor(t) + 1) % plan.length];
      const f = t - Math.floor(t);
      const nn = edgeN(a, b2);
      B.trim(cyl(cr, head - 0.1, 10,
        a[0] + (b2[0] - a[0]) * f - nn[0] * cr * 1.1, sill * 0.4,
        a[1] + (b2[1] - a[1]) * f - nn[1] * cr * 1.1), pierHex);
    }
    B.trim(ringCap(plan, inner, head, false), P.CONCRETE_DARK);   // arcade soffit
  } else {
    // Piers, on a real 6-8 m rhythm, standing proud of the glass line.
    fins(B, plan, sill, head + 0.5, nP, arch === 'plinth' ? 0.62 : 0.85, pierHex);
  }
  // Head beam + the wall above it.
  B.trim(slabGeo(plan, head, 0.75, 0.55), bandHex);
  if (h > head + 1.4) {
    B.trim(loft([{ p: plan, y: head + 0.75 }, { p: plan, y: h }], { uScale: 5, vScale: 5 }), opts.wallHex || pal.wall);
    // Reveals so the upper podium is not a blank slab either.
    for (let yy = head + 3.4; yy < h - 0.8; yy += 3.4) {
      B.trim(slabGeo(plan, yy, 0.28, 0.28), P.CONCRETE_DARK);
    }
  }
  B.trim(slabGeo(plan, h - 0.55, 0.62, 0.8), bandHex);

  /* --- what the player actually drives past ----------------------------- */
  const cw = Math.min(bb.w * 0.5, 13);
  const cProj = opts.canopyProj ?? 2.4;
  /*
   * WHERE THE FRONT DOOR IS.
   *
   * Dead centre, on every building in the city. Nothing else made a row of
   * podiums read as one stamped asset so strongly, because the door is the one
   * thing on a base the eye goes looking for. Real frontages put it wherever
   * the core landed. Kept clear of the corners by the planter allowance so the
   * flanking pots and the address plate still have somewhere to stand.
   */
  const exMax = Math.max(0, bb.w * 0.5 - cw * 0.5 - 3.2);
  const ex = r.chance(0.42) ? 0 : (r() - 0.5) * 1.7 * exMax;
  canopy(B, cw, head - 0.6, bb.z1, cProj, opts.canopyHex || pal.canopy, ex);
  // Entrance portal: piers and a lintel standing proud of a dark reveal, so the
  // base has a middle and the building has a front door. A run of shopfront
  // glazing with no break in it is what made every podium read as a plinth.
  const ew = Math.min(bb.w * 0.30, cw * 0.82);
  for (const sx of [-1, 1]) {
    B.trim(box(0.9, head + 1.4, 0.8, ex + sx * (ew / 2 + 0.45), 0, bb.z1 + 0.28, 2), pierHex);
  }
  B.trim(box(ew + 1.8, 1.1, 0.8, ex, head + 0.3, bb.z1 + 0.28, 3), pierHex);
  B.trim(box(ew, head + 0.3, 0.5, ex, 0, bb.z1 - 0.06, 3), P.SPANDREL);
  // Steps up to a raised lobby. Three treads, so the base has a foot.
  if (arch === 'plinth') {
    for (let i = 0; i < 3; i++) {
      B.trim(box(ew + 2.4 - i * 0.5, sill * (1 - i / 3), 0.42, ex, 0, bb.z1 + 0.5 + i * 0.42, 2),
        P.CONCRETE_WARM);
    }
  }
  // Soffit cove tucked under the canopy. A lit underside is what actually puts
  // light on the pavement at night; the fascia band above only lights itself.
  B.lit(box(cw * 0.76, 0.2, cProj * 0.55, ex, head - 0.79, bb.z1 + cProj * 0.52, 3), neon);
  // The building's name over its own door. It is what the player reads at
  // street level, and at 200 m it is still a lit bar on the podium.
  if (bb.w > 22 && h > head + 4.0) {
    channelSign(B, ex, head + 1.6, bb.z1 + 0.55, Math.min(bb.w * 0.4, 13),
      Math.min(h - head - 2.4, 1.5 + r() * 0.7), 0, r, neon, false);
  }
  // Lit fascia over the shopfront: the band that makes a podium read as retail
  // rather than as a plinth, and the thing that carries the block at night.
  if (opts.sign !== false) {
    B.lit(loft([
      { p: offsetPlan(plan, 0.5), y: head + 0.05 },
      { p: offsetPlan(plan, 0.5), y: head + 0.62 },
    ], {}), neon);
  }
  // Awnings down the rest of the frontage. A podium is shops, and one canopy
  // over the lobby door is not what says so from the pavement.
  if (opts.awnings !== false && bb.w > 14) {
    // One awning per shop unit, not per building: at 11 m spacing a 40 m
    // frontage got three, which reads as three random flags rather than as a
    // parade. 8 m is a shop.
    const n = Math.min(6, Math.floor(bb.w / 8));
    const aw = Math.min((bb.w * 0.86) / (n + 1) - 0.9, 6.5);
    for (let i = 0; i < n && aw > 2.4; i++) {
      const ax = -bb.w * 0.43 + (bb.w * 0.86) * (i + 0.5) / n;
      if (Math.abs(ax - ex) < cw * 0.62 + aw * 0.5) continue;
      awning(B, aw, head - 1.5, bb.z1, 1.5, 0.5, r.pick(FABRIC_COLORS), ax);
    }
  }
  // Paving apron at the door. It is 8 cm tall and it is the thing that tells a
  // player at street level where the entrance is before they can read the sign.
  B.trim(box(Math.min(bb.w * 0.5, cw + 4.4), 0.08, 2.0, ex, 0, bb.z1 + 1.0, 2),
    r.chance(0.5) ? P.PLAZA : P.CONCRETE_WARM);
  // Planters flanking the entrance, and the street number beside the door.
  const px = cw / 2 + 1.6;
  for (const sx of [-1, 1]) {
    const pxx = ex + sx * px;
    if (Math.abs(pxx) > bb.w * 0.46) continue;
    B.trim(box(2.2, 0.85, 1.1, pxx, 0, bb.z1 - 0.6, 2), opts.planterHex || pal.planter);
    B.trim(box(1.9, 0.34, 0.85, pxx, 0.85, bb.z1 - 0.6, 2), P.HEDGE);
  }
  addressPlate(B, Math.max(-bb.w * 0.46, ex - cw / 2 - 0.9), 3.1, bb.z1, P.SIGN_DARK);
  return head;
}

/**
 * Entrance canopy hung off the +z (street) face.
 *
 * The stays are tension rods raking back UP to the wall. The first version hung
 * two 1.1 m stubs below the slab that stopped in mid-air — floating geometry in
 * every frame the camera got near a pavement, which is an automatic review
 * failure and was on several hundred buildings.
 */
function canopy(B, w, y, zFace, proj, hex, x = 0) {
  B.trim(box(w, 0.34, proj, x, y, zFace + proj / 2, 3), hex);
  const reach = Math.max(0.4, proj - 0.3), rise = 1.5;
  const L = Math.hypot(reach, rise);
  for (const sx of [-1, 1]) {
    const g = box(0.12, L, 0.12, 0, 0, 0, 2);
    g.rotateX(-Math.atan2(reach, rise));
    g.translate(x + sx * (w / 2 - 0.45), y + 0.34, zFace + reach);
    B.trim(g, P.STEEL);
  }
}

/**
 * Ground floor for a shaft that has no retail podium.
 *
 * Nineteen of Brickell's thirty-four towers had none: the curtain wall ran
 * straight into the pavement, so the part of the building the player actually
 * drives past was a blank mirrored wall with no door, no canopy, no planting
 * and nothing lit after dark. Every real tower has a double-height lobby, and
 * it also gives the shaft the shadow line it needs where it meets the ground.
 *
 * Sized off the SHAFT plan, not the lot, so it can never be the piece that puts
 * the building over its own lot line.
 */
function towerBase(B, plan, r, pal, neon, glassMat, grow = 1.5) {
  const h = 6.4 + r() * 2.8;
  // The lobby grows OUTWARD from the shaft, so on a parcel the shaft nearly
  // fills it is the piece that ends up on the kerb. `grow` is whatever spare
  // ground the caller actually has.
  const out = offsetPlan(plan, Math.min(grow, 1.0 + r() * 0.5));
  const ob = planBounds(out);
  const colon = r.chance(0.34);
  const wall = offsetPlan(out, colon ? -1.5 : -0.6);
  B.trim(loft([{ p: out, y: 0 }, { p: out, y: 0.45 }], { uScale: 5, vScale: 5 }), P.CONCRETE_DARK);
  // A real double-height lobby is GLAZED, and a lit box behind glass is the one
  // thing that makes the foot of a 150 m tower legible after dark. Falls back to
  // a dark reveal when the building carries no curtain wall to borrow.
  if (glassMat) {
    B.gl(loft([{ p: wall, y: 0.45 }, { p: wall, y: h }], { uScale: CW_U, vScale: CW_V }), glassMat);
  } else {
    B.trim(loft([{ p: wall, y: 0.45 }, { p: wall, y: h }], { uScale: 4, vScale: 4 }), P.SPANDREL);
  }
  // Lobby glazing is set out like lobby glazing: slender mullions on a 3 m bay
  // and one high transom. Without them a double-height lobby is a mirrored band
  // with a scale you cannot read, which is what makes a 150 m tower look like a
  // render rather than a building when you drive past its foot.
  const nLob = Math.max(4, Math.min(30, Math.round(planPerimeter(wall) / 3.0)));
  fins(B, wall, 0.45, h - 0.15, nLob, 0.14, P.MULLION);
  B.trim(slabGeo(wall, h - 1.5, 0.16, 0.12), P.MULLION);

  const nP = Math.max(6, Math.min(18, Math.round(planPerimeter(out) / 6.5)));
  if (colon) {
    // Columns on the building line, lobby glass 1.5 m behind them. Same trick
    // as the arcade podium and the same reason: depth at the bottom of a shaft.
    for (let i = 0; i < nP; i++) {
      const t = (i / nP) * out.length;
      const a = out[Math.floor(t) % out.length], b2 = out[(Math.floor(t) + 1) % out.length];
      const f = t - Math.floor(t);
      const nn = edgeN(a, b2);
      B.trim(cyl(0.44, h + 0.2, 10, a[0] + (b2[0] - a[0]) * f - nn[0] * 0.5, 0.2,
        a[1] + (b2[1] - a[1]) * f - nn[1] * 0.5), pal.pier);
    }
    B.trim(ringCap(out, wall, h, false), P.CONCRETE_DARK);
  } else {
    fins(B, out, 0.45, h + 0.3, nP, 0.75, pal.pier);
  }
  B.trim(slabGeo(out, h, 0.72, 0.6), pal.band);
  B.lit(loft([{ p: offsetPlan(out, 0.5), y: h + 0.08 }, { p: offsetPlan(out, 0.5), y: h + 0.56 }], {}), neon);

  const cw = Math.min(ob.w * 0.42, 10);
  const proj = 1.9 + r() * 0.5;
  const exMax = Math.max(0, ob.w * 0.5 - cw * 0.5 - 3.0);
  const ex = r.chance(0.45) ? 0 : (r() - 0.5) * 1.7 * exMax;
  canopy(B, cw, h - 1.5, ob.z1, proj, pal.canopy, ex);
  B.lit(box(cw * 0.76, 0.2, proj * 0.55, ex, h - 1.69, ob.z1 + proj * 0.52, 3), neon);
  const ew = Math.min(ob.w * 0.30, cw * 0.85);
  for (const sx of [-1, 1]) {
    B.trim(box(0.8, h + 0.9, 0.7, ex + sx * (ew / 2 + 0.4), 0, ob.z1 + 0.24, 2), pal.pier);
  }
  B.trim(box(ew + 1.6, 0.9, 0.7, ex, h + 0.2, ob.z1 + 0.24, 3), pal.pier);
  B.trim(box(ew, h + 0.2, 0.5, ex, 0, ob.z1 - 0.06, 3), P.SPANDREL);
  for (const sx of [-1, 1]) {
    const px = ex + sx * (cw / 2 + 1.5);
    if (Math.abs(px) + 1.1 > ob.w * 0.5) continue;
    B.trim(box(2.0, 0.8, 1.0, px, 0, ob.z1 - 0.6, 2), pal.planter);
    B.trim(box(1.7, 0.32, 0.78, px, 0.8, ob.z1 - 0.6, 2), P.HEDGE);
  }
  B.trim(box(Math.min(ob.w * 0.5, cw + 4.0), 0.08, 1.9, ex, 0, ob.z1 + 0.95, 2),
    r.chance(0.5) ? P.PLAZA : P.CONCRETE_WARM);
  addressPlate(B, Math.max(-ob.w * 0.46, ex - cw / 2 - 1.0), 3.0, ob.z1, P.SIGN_DARK);
  return h;
}

/**
 * A stack of projecting balcony slabs with a slim balustrade.
 *
 * `mode` is the anti-repetition knob and it costs nothing: the same number of
 * rings, but the projection varies floor to floor, which is the difference
 * between a comb and a building. 'wave' is the Brickell undulating condo,
 * 'zig' the alternating deep/shallow terrace, 'taper' the ziggurat.
 */
function balconyStack(B, plan, y0, y1, step, proj, slabHex, railHex, mode = 'flat') {
  const n = Math.max(1, Math.floor((y1 - 1 - y0) / step));
  let i = 0;
  for (let y = y0; y < y1 - 1; y += step, i++) {
    let p = proj;
    if (mode === 'wave') p = proj * (0.55 + 0.45 * (1 + Math.sin(i * 0.85)) / 2 + 0.2);
    else if (mode === 'zig') p = i % 2 ? proj * 0.42 : proj;
    else if (mode === 'taper') p = proj * (1 - 0.55 * (i / Math.max(1, n)));
    else if (mode === 'grow') p = proj * (0.45 + 0.55 * (i / Math.max(1, n)));
    B.trim(slabGeo(plan, y, 0.24, p), slabHex);
    B.trim(parapetGeo(offsetPlan(plan, p), y + 0.24, 1.0, 0.09), railHex);
  }
}

const BALCONY_MODES = [['flat', 26], ['wave', 24], ['zig', 22], ['taper', 14], ['grow', 14]];

/**
 * Projecting bays running the full height of a section.
 *
 * The one articulation in the kit that changes a shaft's PLAN rather than
 * decorating its face: a comb of oriels reads as a scalloped silhouette from
 * 300 m, where a fin or a spandrel course has long since minified into texture.
 * Glazed off the shaft's own curtain wall when there is one, so it usually
 * costs no extra material and no extra draw call.
 */
function orielBays(B, plan, y0, y1, count, w, depth, mat, hex) {
  const n = plan.length;
  for (let i = 0; i < count; i++) {
    const t = (i / count) * n;
    const a = plan[Math.floor(t) % n], b = plan[(Math.floor(t) + 1) % n];
    const f = t - Math.floor(t);
    const x = a[0] + (b[0] - a[0]) * f, z = a[1] + (b[1] - a[1]) * f;
    const nrm = edgeN(a, b);
    const rot = Math.atan2(nrm[0], nrm[1]);
    const place = (g, out) => {
      g.rotateY(rot);
      g.translate(x + nrm[0] * out, 0, z + nrm[1] * out);
      return g;
    };
    if (mat) B.gl(place(tileUV(box(w, y1 - y0, depth, 0, y0, 0, 1), CW_U, CW_V), depth * 0.42), mat);
    else B.trim(place(box(w, y1 - y0, depth, 0, y0, 0, 3), depth * 0.42), hex);
    // A mullion up each side of the bay: without it the projection has no edge
    // and the whole comb flattens back into the facade at mid distance.
    for (const sx of [-1, 1]) {
      const m = box(0.26, y1 - y0, depth + 0.2, sx * w * 0.5, y0, 0, 2);
      B.trim(place(m, depth * 0.45), hex);
    }
  }
}

/** Vertical fins running the height of a shaft — cheap, huge silhouette win. */
function fins(B, plan, y0, y1, count, depth, hex) {
  const n = plan.length;
  for (let i = 0; i < count; i++) {
    const t = (i / count) * n;
    const a = plan[Math.floor(t) % n], b = plan[(Math.floor(t) + 1) % n];
    const f = t - Math.floor(t);
    const x = a[0] + (b[0] - a[0]) * f, z = a[1] + (b[1] - a[1]) * f;
    const nrm = edgeN(a, b);
    const g = box(0.42, y1 - y0, depth, 0, y0, 0, 3);
    g.rotateY(Math.atan2(nrm[0], nrm[1]));
    g.translate(x + nrm[0] * depth * 0.35, 0, z + nrm[1] * depth * 0.35);
    B.trim(g, hex);
  }
}

/* ============================================================ towers ==== */

/**
 * Pick a plan archetype. This is where skyline variety actually comes from.
 *
 * Every one of these is CONVEX — see the note above polyPlan. The variety is in
 * side count, chamfer depth, taper and asymmetry, all of which survive being
 * offset, inset, capped and populated.
 */
/** Plans whose loft should shade smoothly rather than facet. */
const isSmoothPlan = (k) => k === 'ellipse' || k === 'bow' || k === 'lens';

function shaftPlan(r, w, d, kind, seedPhase = 0) {
  const m = Math.min(w, d);
  switch (kind) {
    case 'ellipse': return ellipsePlan(w, d, 16);
    case 'lens': return lensPlan(w, d, m * 0.14);
    case 'bow': return bowPlan(w, d, m * 0.16);
    case 'hex': return polyPlan(w, d, 6, seedPhase);
    case 'octa': return polyPlan(w, d, 8, Math.PI / 8);
    case 'wedge': return wedgePlan(w, d, 0.26 + 0.16 * seedPhase, m * 0.12);
    case 'cut': return cornerCutPlan(w, d, m * 0.42, seedPhase < 0.5 ? 1 : -1, 1);
    case 'chamferHard': return rectPlan(w, d, m * 0.28);
    case 'slab': return rectPlan(w, d, m * 0.10);
    default: return rectPlan(w, d, m * 0.16);
  }
}

/** Weighted plan menu. Kept here so towers and twins draw from one table. */
const PLAN_MENU = [
  ['chamfer', 24], ['slab', 15], ['ellipse', 10], ['bow', 10], ['chamferHard', 10],
  ['hex', 8], ['octa', 8], ['wedge', 7], ['lens', 8], ['cut', 6],
];

const CROWN_MENU = [
  ['step', 12], ['taper', 8], ['plant', 11], ['blade', 6], ['dome', 7],
  ['spire', 8], ['fins', 7], ['hat', 6], ['lantern', 6], ['ring', 7],
  ['slant', 11], ['sky', 9], ['glassbox', 9], ['arch', 6],
];

/**
 * A top sliced by an inclined plane.
 *
 * Every other crown in the menu finishes horizontal, and a skyline of
 * horizontal tops is a skyline of steps. One raking plane is the strongest
 * silhouette move available here and it costs one loft's worth of triangles.
 * `dir` is a unit direction in plan; the roof is lowest on the -dir side.
 */
function slantTop(plan, y, rise, dirX, dirZ) {
  const n = plan.length;
  const bb = planBounds(plan);
  const span = Math.max(1, Math.abs(dirX) * bb.w + Math.abs(dirZ) * bb.d);
  const hOf = (q) => y + 1.2 + rise * (0.5 + ((q[0] - bb.cx) * dirX + (q[1] - bb.cz) * dirZ) / span);
  const pos = [], nor = [], uv = [], idx = [];
  let b = 0;
  for (let i = 0; i < n; i++) {
    const a = plan[i], c = plan[(i + 1) % n];
    const nn = edgeN(a, c);
    const ha = hOf(a), hc = hOf(c);
    pos.push(a[0], y, a[1], c[0], y, c[1], c[0], hc, c[1], a[0], ha, a[1]);
    for (let k = 0; k < 4; k++) nor.push(nn[0], 0, nn[1]);
    uv.push(0, y / 4, 1, y / 4, 1, hc / 4, 0, ha / 4);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    b += 4;
  }
  // Cap, given the plane's own normal so it shades as one raking surface.
  const gx = (rise * dirX) / span, gz = (rise * dirZ) / span;
  const L = Math.hypot(gx, 1, gz);
  for (let i = 0; i < n; i++) {
    const q = plan[i];
    pos.push(q[0], hOf(q), q[1]);
    nor.push(-gx / L, 1 / L, -gz / L);
    uv.push(q[0] / 4, q[1] / 4);
  }
  for (let i = 1; i < n - 1; i++) idx.push(b, b + i, b + i + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/**
 * Crown the shaft. Every tower gets a top, because a flat-topped shaft is the
 * loudest "procedural city" tell there is — but they must not all get the SAME
 * top, which is the second loudest. Ten shapes, and the mast is now optional:
 * an aviation mast on every single roof was itself a repeat.
 */
function crown(B, plan, y, r, opt = {}) {
  const bb = planBounds(plan);
  const cx = bb.cx, cz = bb.cz;
  const m = Math.min(bb.w, bb.d);
  const kind = opt.kind || r.weighted(CROWN_MENU);
  const litHex = opt.litHex || B.neon;
  const lit = opt.lit;
  let top = y;

  if (kind === 'step') {
    let p = plan, yy = y;
    const n = 2 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      const h = 3.2 + r() * 3.4;
      B.trim(loft([{ p, y: yy }, { p, y: yy + h }], { capTop: false }), i % 2 ? P.CONCRETE : P.PRECAST);
      B.trim(slabGeo(p, yy + h, 0.42, 0.7), P.CONCRETE_WARM);
      yy += h + 0.42;
      p = insetPlan(p, m * 0.11);
      if (Math.hypot(planBounds(p).w, planBounds(p).d) < 6) break;
    }
    B.trim(loft([{ p, y: yy }], { capTop: true }), P.ROOF_GRAVEL);
    if (lit) litBand(B, plan, y + 1.2, 0.9, 0.25, litHex);
    top = yy;
  } else if (kind === 'taper') {
    const p2 = insetPlan(plan, m * 0.3);
    const h = 7 + r() * 9;
    B.trim(loft([{ p: plan, y }, { p: p2, y: y + h }], { capTop: false }), P.PRECAST);
    // A capped taper is a bare pale bulge, and on an elliptical plan it renders
    // as a featureless dome the size of the shaft — the one place in the crown
    // menu that still put an untextured mass on the skyline. The top of a tower
    // carries machinery like any other roof, so give it one.
    roofScape(B, p2, y + h, r, { parapetH: 0.8, tank: false, sign: false });
    if (lit) litBand(B, plan, y + 0.4, 0.7, 0.2, litHex);
    top = y + h + 2;
  } else if (kind === 'blade') {
    B.trim(parapetGeo(plan, y, 1.5, 0.5), P.PARAPET);
    const bw = m * 0.34;
    const h = 10 + r() * 14;
    B.trim(loft([
      { p: movePlan(rectPlan(bw, bb.d * 0.5, 0.5), cx, cz), y },
      { p: movePlan(rectPlan(bw * 0.6, bb.d * 0.34, 0.4), cx, cz), y: y + h },
    ], { capTop: true }), P.CONCRETE);
    if (lit) B.lit(box(bw * 0.35, h * 0.8, 0.5, cx, y + 1, cz + bb.d * 0.25, 3), litHex);
    top = y + h;
  } else if (kind === 'dome') {
    /* Stepped drum + cap. The Deco/Mediterranean top that breaks up a row of
       flat-capped glass shafts more than any other single shape. */
    B.trim(parapetGeo(plan, y, 1.1, 0.45), P.PARAPET);
    const rr = m * 0.44;
    B.trim(cyl(rr, 2.4, 14, cx, y + 1.1, cz), P.STUCCO_WHITE);
    /*
     * Pilasters round the drum and ribs up the cone.
     *
     * Three stacked smooth cylinders have no shadow line anywhere on them, so
     * past about 100 m the whole crown collapses into one pale lump — and four
     * of those landed in a single downtown frame. Sixteen thin boxes give the
     * drum a bay rhythm and the cone a set of hips, which is what actually
     * tells the eye it is looking at a built object and not at a blob.
     */
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const g = box(0.44, 2.4, 0.42, 0, y + 1.1, 0, 2);
      g.rotateY(-a);
      g.translate(cx + Math.cos(a) * rr, 0, cz + Math.sin(a) * rr);
      B.trim(g, P.CONCRETE_WARM);
    }
    B.trim(cyl(rr * 1.10, 0.5, 14, cx, y + 3.5, cz), P.CONCRETE_WARM);
    B.trim(cyl(rr * 0.94, 2.6, 14, cx, y + 4.0, cz, rr * 0.52), P.TERRACOTTA);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.39;
      // Built at the origin, THEN tilted, THEN moved. box() stands its geometry
      // on y = 0 by translating it first, so a rotateZ applied after the height
      // is baked in swings the rib about the building's base — at a 60 m crown
      // that throws it eighteen metres sideways, over the neighbour and out
      // across the carriageway.
      const g = box(0.26, 2.72, 0.9, 0, 0, 0, 2);
      g.rotateZ(0.28);                                   // lean in toward the axis
      g.rotateY(-a);                                     // local +x is outward radial
      g.translate(cx + Math.cos(a) * rr * 0.74, y + 4.0, cz + Math.sin(a) * rr * 0.74);
      B.trim(g, P.CONCRETE_WARM);
    }
    B.trim(cyl(rr * 0.52, 1.2, 12, cx, y + 6.6, cz, rr * 0.12), P.TERRACOTTA);
    if (lit) B.lit(cyl(rr * 1.03, 0.55, 14, cx, y + 1.5, cz), litHex);
    top = y + 7.8;
  } else if (kind === 'spire') {
    /* Setback drum then a long tapered spire. This is how you get one tower to
       read as taller than its neighbours without adding a single storey. */
    B.trim(parapetGeo(plan, y, 1.3, 0.45), P.PARAPET);
    let p = insetPlan(plan, m * 0.20);
    const h1 = 5 + r() * 6;
    B.trim(loft([{ p, y: y + 1.3 }, { p: insetPlan(p, m * 0.12), y: y + 1.3 + h1 }], { capTop: true }), P.PRECAST);
    const sh = 14 + r() * 22;
    B.trim(cyl(m * 0.13, sh, 8, cx, y + 1.3 + h1, cz, m * 0.018), P.ALUMINIUM);
    if (lit) {
      for (let i = 0; i < 3; i++) {
        B.lit(cyl(m * 0.11 * (1 - i * 0.28), 0.5, 8, cx, y + 1.3 + h1 + sh * (0.12 + i * 0.28), cz), litHex);
      }
    }
    top = y + 1.3 + h1 + sh;
  } else if (kind === 'fins') {
    /* Four raking fins past the parapet — the Brickell "crown of blades". */
    B.trim(parapetGeo(plan, y, 1.4, 0.45), P.PARAPET);
    B.trim(loft([{ p: offsetPlan(plan, -0.6), y: y + 0.1 }], { capTop: true, uScale: 3 }), P.ROOF_GRAVEL);
    const fh = 8 + r() * 12;
    const n = 4 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      const t = (i / n) * plan.length;
      const a = plan[Math.floor(t) % plan.length], b = plan[(Math.floor(t) + 1) % plan.length];
      const f = t - Math.floor(t);
      const px = a[0] + (b[0] - a[0]) * f, pz = a[1] + (b[1] - a[1]) * f;
      const nn = edgeN(a, b);
      const g = box(0.7, fh, 1.4, 0, y, 0, 3);
      g.rotateY(Math.atan2(nn[0], nn[1]));
      g.translate(px, 0, pz);
      B.trim(g, P.CONCRETE);
      if (lit) {
        const l = box(0.34, fh * 0.86, 0.3, 0, y + 0.6, 0, 2);
        l.rotateY(Math.atan2(nn[0], nn[1]));
        l.translate(px + nn[0] * 0.6, 0, pz + nn[1] * 0.6);
        B.lit(l, litHex);
      }
    }
    const mech = insetPlan(plan, m * 0.28);
    B.trim(loft([{ p: mech, y: y + 1.5 }, { p: mech, y: y + 1.5 + fh * 0.55 }], { capTop: true }), P.CONCRETE_DARK);
    top = y + fh;
  } else if (kind === 'hat') {
    /*
     * Pitched cap. Reads as masonry, so it is what breaks a run of glass.
     *
     * WHY IT IS LAID IN COURSES AND NOT LOFTED IN ONE GO.
     * One slope from the eaves to a small apex is geometrically a roof and
     * visually a ramp: at the review camera's 62-degree look-down a 30 m wide,
     * 6 m tall cap presents its whole slope to the lens as a single bald pale
     * surface. Measured on the rooftops preset it was the largest untextured
     * area anywhere in the frame — art-bible anti-pattern #3, fifty storeys up.
     * Real pantiled roofs are laid in courses. Four of them cost ~400 triangles
     * and buy a shadow line every couple of metres plus a stepped silhouette.
     *
     * Half the hats used to be TERRACOTTA and the other half ROOF_DARK, so a
     * pitched cap on a teal glass shaft landed as a dark brown lump — the one
     * muddy note in an otherwise bright frame. Pale options carry the same
     * silhouette without the value hole.
     */
    B.trim(slabGeo(plan, y, 0.6, 0.9), P.CONCRETE_WARM);
    // Pitch tracks the plan. A fixed 4-9 m rise on a wide tower is a 1:4 slope,
    // which from above is indistinguishable from a flat roof.
    const h = Math.max(3.5, m * 0.30) + r() * 4;
    const tile = r.weighted([
      [P.TERRACOTTA, 8], [P.ROOF_DARK, 6], [P.CONCRETE_WARM, 9], [P.STUCCO_WHITE, 7],
    ]);
    const eaves = offsetPlan(plan, 0.5);
    let pPrev = eaves, yPrev = y + 0.6;
    for (let i = 1; i <= 4; i++) {
      const pi = insetPlan(eaves, m * 0.42 * (i / 4));
      const yi = y + 0.6 + h * (i / 4);
      B.trim(loft([{ p: pPrev, y: yPrev }, { p: pi, y: yi }], {}), tile);
      B.trim(slabGeo(pi, yi, 0.16, 0.26), i % 2 ? P.CONCRETE_WARM : tile);
      pPrev = pi; yPrev = yi + 0.16;
    }
    const ab = planBounds(pPrev);
    if (Math.min(ab.w, ab.d) > 7) {
      // A wide hat is a mansard, and a mansard has a flat top. A flat top is a
      // roof, so it gets the parapet and the plant every other roof gets.
      roofScape(B, pPrev, yPrev, r, { parapetH: 0.6, tank: false, sign: false });
      top = yPrev + 3;
    } else {
      // Cupola: drum, cornice, finial. The apex of a real pitched roof is never
      // a point, and this is the mark that says "masonry" from a kilometre out.
      const cr = Math.max(0.7, Math.min(ab.w, ab.d) * 0.36);
      B.trim(loft([{ p: pPrev, y: yPrev }], { capTop: true, uScale: 3 }), tile);
      B.trim(cyl(cr, 1.7, 10, cx, yPrev, cz), P.STUCCO_WHITE);
      B.trim(cyl(cr * 1.22, 0.3, 10, cx, yPrev + 1.7, cz), P.CONCRETE_WARM);
      B.trim(cyl(cr * 0.95, 1.6, 10, cx, yPrev + 2.0, cz, cr * 0.18), tile);
      if (lit) B.lit(cyl(cr * 1.04, 0.5, 10, cx, yPrev + 0.55, cz), litHex);
      top = yPrev + 3.6;
    }
    if (lit) litBand(B, plan, y - 0.9, 0.7, 0.3, litHex);
  } else if (kind === 'slant') {
    /*
     * Raked top. The one crown that changes the outline of the whole tower
     * rather than adding a hat to it — and, as first built, the one crown that
     * put a completely bald surface on the skyline. A 25 m rake across a 30 m
     * shaft presents its whole slope to the review camera as a single flat
     * quad; on the `rooftops` preset it was the largest untextured area in the
     * frame. A real raked roof is a standing-seam deck: sheets three metres
     * wide with a raised rib at every joint, plus a fascia where it lands on
     * the parapet. Both are what give the plane a shadow line at all.
     */
    B.trim(parapetGeo(plan, y, 0.9, 0.42), P.PARAPET);
    const rise = Math.max(5, Math.min(26, m * 0.48 + r() * 12));
    const a = r() * Math.PI * 2;
    const dx = Math.cos(a), dz = Math.sin(a);
    const p2 = insetPlan(plan, Math.max(0.4, m * 0.05));
    const deckHex = r.chance(0.5) ? P.PRECAST : P.CONCRETE;
    B.trim(slantTop(p2, y + 0.9, rise, dx, dz), deckHex);

    const b2 = planBounds(p2);
    const span = Math.max(1, Math.abs(dx) * b2.w + Math.abs(dz) * b2.d);
    const cross = Math.max(1, Math.abs(dz) * b2.w + Math.abs(dx) * b2.d);
    const pitch = Math.atan2(rise, span);
    const L = Math.hypot(span, rise);
    const yMid = y + 2.1 + rise * 0.5;
    const nR = Math.max(3, Math.min(12, Math.round(cross / 2.9)));
    const ribHex = r.chance(0.5) ? P.ALUMINIUM : P.MULLION;
    for (let i = 0; i < nR; i++) {
      const t = (-0.5 + (i + 0.5) / nR) * cross * 0.78;
      // Shorten toward the flanks so a rib on a rounded plan cannot run out
      // past the edge of the surface it is supposed to be lying on.
      const k = 1 - 0.42 * Math.abs(t) / (cross * 0.4);
      const g = box(0.26, 0.20, L * k, 0, -0.10, 0, 2);
      g.rotateX(-pitch);
      g.rotateY(Math.atan2(dx, dz));
      g.translate(b2.cx - dz * t, yMid, b2.cz + dx * t);
      B.trim(g, ribHex);
    }
    if (lit) litBand(B, plan, y + 0.1, 0.7, 0.24, litHex);
    top = y + 2.1 + rise;
  } else if (kind === 'sky') {
    /* Open top floor under a deep roof plate — the Miami sky terrace. It is the
       one crown that puts life on a tower instead of machinery, and from the
       3/4 camera it is the only one you can see INTO. */
    B.trim(parapetGeo(plan, y, 1.05, 0.4), P.PARAPET);
    const deck = offsetPlan(plan, -0.8);
    B.trim(loft([{ p: deck, y: y + 0.12 }], { capTop: true, uScale: 2.6 }), P.WOOD_DECK);
    const ch = 4.0 + r() * 1.5;
    cornerColumns(B, insetPlan(plan, Math.max(0.6, m * 0.14)), y + 0.12, y + ch,
      Math.max(0.5, m * 0.06), P.CONCRETE);
    if (bb.w > 21 && bb.d > 17) {
      rooftopPool(B, cx, y + 0.12, cz, Math.min(9, bb.w * 0.30), Math.min(5.5, bb.d * 0.22), r);
    } else {
      pergola(B, cx, y + 0.12, cz + bb.d * 0.16, Math.min(bb.w * 0.52, 6), Math.min(bb.d * 0.34, 3), P.WOOD_DARK);
      roofBar(B, cx, y + 0.12, cz - bb.d * 0.26, Math.min(bb.w * 0.5, 5), 0, P.WOOD_DARK, r);
      for (let i = 0; i < 2; i++) {
        parasol(B, cx + (i ? 1 : -1) * bb.w * 0.28, y + 0.12, cz + bb.d * 0.02,
          r.pick(FABRIC_COLORS), 0.8);
      }
    }
    B.trim(slabGeo(plan, y + ch, 0.85, Math.min(2.4, m * 0.11)), P.CONCRETE_WARM);
    if (lit) litBand(B, plan, y + ch - 0.5, 0.45, Math.min(2.2, m * 0.10), litHex);
    // Mechanical still has to go somewhere: a low penthouse behind the terrace.
    const mp = movePlan(rectPlan(Math.min(bb.w * 0.34, 9), Math.min(bb.d * 0.32, 7), 0.8),
      cx, cz + bb.d * 0.24);
    B.trim(loft([{ p: mp, y: y + ch + 0.85 }, { p: mp, y: y + ch + 4.0 }], { capTop: true }), P.CONCRETE_DARK);
    top = y + ch + 4.2;
  } else if (kind === 'glassbox') {
    /* Glazed penthouse under a deep roof plate. The only crown that is LIGHTER
       than the shaft it sits on, so it is what stops a run of masonry towers
       all ending in the same pale lump of concrete — and after dark it is a
       lit box floating over a dark parapet. */
    B.trim(parapetGeo(plan, y, 1.0, 0.42), P.PARAPET);
    const p = insetPlan(plan, Math.max(0.7, m * 0.15));
    const gh = 6.5 + r() * 5;
    B.gl(loft([{ p, y: y + 1.0 }, { p, y: y + 1.0 + gh }], { uScale: CW_U, vScale: CW_V }),
      B.glassMat || curtainMat(P.GLASS_SKY, 1));
    cornerColumns(B, p, y + 1.0, y + 1.0 + gh, Math.max(0.45, m * 0.05), P.CONCRETE);
    B.trim(slabGeo(p, y + 1.0 + gh, 0.8, Math.min(2.4, m * 0.12)), P.CONCRETE_WARM);
    if (lit) litBand(B, p, y + 0.6 + gh, 0.45, Math.min(2.2, m * 0.11), litHex);
    top = y + 1.8 + gh;
  } else if (kind === 'arch') {
    /* Portal frame standing past the parapet: two piers and a lintel with the
       sky showing through. A hole in a silhouette reads from further away than
       any amount of added mass, and nothing else in the menu makes one. */
    B.trim(parapetGeo(plan, y, 1.2, 0.45), P.PARAPET);
    B.trim(loft([{ p: offsetPlan(plan, -0.7), y: y + 0.1 }], { capTop: true, uScale: 3 }), P.ROOF_GRAVEL);
    const ah = 9 + r() * 10;
    const pt = Math.max(1.1, m * 0.13);
    const pd2 = Math.min(bb.d * 0.55, pt * 3.2);
    for (const s of [-1, 1]) {
      B.trim(box(pt, ah, pd2, cx + s * (bb.w * 0.5 - pt * 0.7), y + 1.2, cz, 3), P.CONCRETE);
    }
    B.trim(box(bb.w - pt * 0.4, pt * 0.95, pd2, cx, y + 1.2 + ah, cz, 3), P.CONCRETE_WARM);
    if (lit) B.lit(box(bb.w - pt * 2.2, 0.5, 0.4, cx, y + 0.5 + ah, cz + pd2 * 0.5 + 0.2, 2), litHex);
    const amp = movePlan(rectPlan(Math.min(bb.w * 0.4, 10), Math.min(bb.d * 0.4, 8), 1.0), cx, cz);
    B.trim(loft([{ p: amp, y: y + 1.3 }, { p: amp, y: y + 5.5 }], { capTop: true }), P.CONCRETE_DARK);
    top = y + 1.2 + ah + pt;
  } else if (kind === 'lantern') {
    /* Open steel frame with a glowing box in it — the classic Miami beacon. */
    B.trim(parapetGeo(plan, y, 1.2, 0.45), P.PARAPET);
    const p = insetPlan(plan, m * 0.26);
    const pb = planBounds(p);
    const h = 8 + r() * 8;
    for (let i = 0; i < p.length; i += Math.max(1, Math.round(p.length / 4))) {
      B.trim(box(0.42, h, 0.42, p[i][0], y + 1.2, p[i][1], 2), P.STEEL_DARK);
    }
    B.trim(slabGeo(p, y + 1.2 + h, 0.4, 0.6), P.CONCRETE);
    B.lit(loft([{ p: insetPlan(p, 0.5), y: y + 2.2 }, { p: insetPlan(p, 0.5), y: y + h - 0.4 }],
      { capTop: true }), litHex);
    B.trim(cyl(pb.w * 0.16, 3.0, 8, cx, y + 1.6 + h, cz, pb.w * 0.03), P.ALUMINIUM);
    top = y + 1.6 + h + 3;
  } else {
    /* 'ring' and 'plant' both end in a mechanical penthouse; the ring gets a
       deep projecting cornice first, which changes the silhouette completely. */
    if (kind === 'ring') {
      B.trim(slabGeo(plan, y, 0.9, Math.min(1.8, m * 0.09)), P.CONCRETE_WARM);
      if (lit) litBand(B, plan, y + 0.9, 0.8, Math.min(1.9, m * 0.095), litHex);
      B.trim(parapetGeo(insetPlan(plan, 1.4), y + 0.9, 1.2, 0.4), P.PARAPET);
      roofScape(B, insetPlan(plan, 2.0), y + 1.0, r, {
        helipad: opt.helipad, parapetH: 0.8, tank: false, sign: lit && r.chance(0.5),
      });
      top = y + 1.0;
    } else {
      B.trim(parapetGeo(plan, y, 1.6, 0.5), P.PARAPET);
      roofScape(B, offsetPlan(plan, -0.6), y + 0.1, r, {
        helipad: opt.helipad, parapetH: 0.9, sign: lit && r.chance(0.5),
      });
      top = y + 0.1;
    }
    const ph = 4.2 + r() * 4.0;
    const pw = Math.min(bb.w * (0.34 + r() * 0.26), 13), pd = Math.min(bb.d * (0.34 + r() * 0.24), 11);
    const pp = movePlan(rectPlan(pw, pd, 1.2), cx + (r() - 0.5) * bb.w * 0.1, cz);
    B.trim(loft([{ p: pp, y: top + 1.6 }, { p: pp, y: top + 1.6 + ph }], { capTop: true }), P.CONCRETE_DARK);
    B.trim(slabGeo(pp, top + 1.6 + ph, 0.3, 0.4), P.PARAPET);
    top = top + 1.9 + ph;
  }

  // Mast + aviation light. Optional now: one on every roof in the city was
  // itself a repeat, and the shapes above already carry the silhouette.
  if (opt.mast ?? r.chance(0.5)) {
    const mh = 6 + r() * 12;
    B.trim(cyl(0.5, mh, 6, cx, top, cz, 0.16), P.ALUMINIUM);
    if (lit) B.lit(cyl(0.45, 0.45, 6, cx, top + mh, cz), P.LIGHT_RED);
    else B.trim(cyl(0.45, 0.45, 6, cx, top + mh, cz), P.LIGHT_RED);
    return top + mh;
  }
  return top;
}

/**
 * How the shaft of a glass tower is articulated. This is the second variety
 * axis after the plan: two towers with the same plan and different treatments
 * do not read as the same asset, and the whole point of this module is that no
 * two neighbours do.
 */
const FACADE_MENU = [
  ['fin', 20],      // vertical mullion fins, office language
  ['band', 17],     // horizontal spandrel courses, ribbon-window language
  ['grid', 12],     // both — a deep punched grid
  ['sleek', 10],    // corner columns only; the hero towers stay quiet
  ['brise', 11],    // brise-soleil: deep shading fins on one axis
  ['resi', 17],     // balcony slabs
  ['oriel', 14],    // projecting glazed bays — changes the plan, not the skin
  ['crossband', 12],// deep cornice every third floor, shallow fins between
];

/** Deep sun-shading fins over the glass, on a coarse rhythm. Tropical Modern. */
function briseSoleil(B, plan, y0, y1, step, depth, hex) {
  for (let y = y0; y < y1 - 1; y += step) {
    B.trim(slabGeo(plan, y, 0.18, depth), hex);
  }
}

/** Expressed corner columns — makes a plain glass box read as built, not extruded. */
function cornerColumns(B, plan, y0, y1, size, hex) {
  const n = plan.length;
  const stride = Math.max(1, Math.round(n / 4));
  for (let i = 0; i < n; i += stride) {
    const p = plan[i];
    const nn = pointNormals(plan)[i];
    const g = box(size, y1 - y0, size, 0, y0, 0, 3);
    g.rotateY(Math.atan2(nn[0], nn[1]));
    g.translate(p[0] + nn[0] * size * 0.18, 0, p[1] + nn[1] * size * 0.18);
    B.trim(g, hex);
  }
}

/**
 * A Brickell tower: retail podium with a canopy, an articulated shaft with
 * setbacks and an expressed service core, and a crown.
 *
 * `o.shift` slides the shaft off the parcel centre so a lower wing can sit
 * beside it (see `shoulder` in towerBlock). The combined bounding box is still
 * the parcel, which is what the consumption footprint measures, so the physics
 * circle stays centred on the building the player can see.
 */
function tower(ctx, B, r, w, d, h, o = {}) {
  const gt = o.glassTint ?? r.pick(GLASS_TINTS);
  const cm = curtainMat(gt, o.glassGrid ?? 1);
  const podH = o.podiumH ?? (o.podium ? 8 + r() * 9 : 0);
  const facade = o.facade || (o.resi === true ? 'resi' : r.weighted(FACADE_MENU));
  const resi = facade === 'resi';
  const shift = o.shift || 0;
  const mv = (p) => (shift ? movePlan(p, shift, 0) : p);
  const pal = o.pal || r.weighted(BASE_PALETTES);

  /* --- shaft plan, drawn first: the ground floor is built around it ------ */
  const kind = o.planKind || r.weighted(PLAN_MENU);
  const twist = !o.noTwist && r.chance(0.18) ? (r() < 0.5 ? -1 : 1) * (0.10 + r() * 0.16) : 0;
  const phase = r();
  let curKind = kind;
  const plan0 = mv(shaftPlan(r, w, d, kind, phase));

  /* --- podium, or at minimum a lobby ----------------------------------- */
  let baseTop = 0;
  if (podH > 2) {
    // Never wider than the parcel: the podium is the piece that actually meets
    // the pavement, so it is the piece that ends up on the kerb if it is not
    // clamped. o.lotW/lotD are the real lot; w/d are the shaft.
    const pw = Math.min(w * 1.10, o.lotW ?? w * 1.10);
    const pd = Math.min(d * 1.10, o.lotD ?? d * 1.10);
    const pp = rectPlan(pw, pd, Math.min(pw, pd) * 0.09);
    // A masonry podium under a glass shaft is a real Brickell type and it is
    // also the only thing that stops the base of every tower being the same
    // band of curtain wall as the shaft above it.
    podium(B, pp, podH, r, r.chance(0.72) ? cm : null, { sign: o.sign, neon: B.neon, pal });
    roofScape(B, offsetPlan(pp, -1.6), podH + 0.05, r, {
      tank: false, parapetH: 1.0, pool: r.chance(0.34), deck: true,
      avoid: offsetPlan(mv(rectPlan(w, d, 0)), 2.5),
    });
    baseTop = podH;
  } else {
    towerBase(B, plan0, r, pal, B.neon, cm,
      Math.max(0.35, Math.min((o.lotW ?? w + 3) - w, (o.lotD ?? d + 3) - d) / 2 - 0.25));
  }

  /* --- shaft ----------------------------------------------------------- */
  // Setback count is a massing decision, not a height lookup: a 60 m tower that
  // steps twice and a 160 m tower that runs straight are both real buildings,
  // and drawing the count from the height is exactly what made every tall
  // tower in the ridge share a silhouette.
  const maxSect = 1 + (h > 62 ? 1 : 0) + (h > 120 ? 1 : 0);
  const sections = o.sections ?? Math.max(1, Math.min(maxSect, r.weighted([[1, 30], [2, 40], [3, 30]])));
  let y = baseTop, pw = w, pd = d;
  let plan = plan0;
  const shaftTop = h;
  const railHex = r.pick([P.GLASS_SKY, P.ALUMINIUM, P.MULLION, P.GLASS_AQUA]);
  const balMode = r.weighted(BALCONY_MODES);
  const finHex = r.weighted(ACCENT_TRIM);
  // The horizontal courses read at a different distance from the fins, so they
  // are a separate draw from the same table — two towers that share a plan and
  // a facade language still differ in the pair.
  const slabHex = r.weighted(ACCENT_TRIM);

  for (let s = 0; s < sections; s++) {
    const isLast = s === sections - 1;
    const top = isLast ? shaftTop : y + (shaftTop - baseTop) * (0.42 + r() * 0.16) / sections * 1.6;
    const segTop = Math.min(shaftTop - 3, Math.max(y + 12, top));
    const steps = twist ? Math.max(2, Math.round((segTop - y) / 14)) : 1;
    const rings = [];
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      rings.push({ p: rotPlan(plan, twist * (y + (segTop - y) * t) / 60), y: y + (segTop - y) * t });
    }
    B.gl(loft(rings, { uScale: CW_U, vScale: CW_V, smooth: isSmoothPlan(curKind), capTop: false, capBottom: false }), cm);

    // Expressed service core: a solid slot of masonry riding up one face.
    if (s === 0 && r.chance(0.45)) {
      const cw = Math.min(pw, pd) * 0.30;
      const cp = movePlan(rectPlan(cw, pd * 0.42, 0.5), shift, 0);
      B.trim(loft([{ p: cp, y: baseTop }, { p: cp, y: shaftTop + 2 + r() * 6 }],
        { uScale: 5, vScale: 5, capTop: true }), r.chance(0.5) ? P.CONCRETE : P.CONCRETE_DARK);
    }

    const fp = rotPlan(plan, twist * y / 60);
    switch (facade) {
      case 'resi':
        balconyStack(B, fp, y + 3.4, segTop, STOREY * (r.chance(0.55) ? 1 : 2),
          1.25, slabHex, railHex, balMode);
        break;
      case 'band':
        for (let yy = y + STOREY; yy < segTop - 2; yy += STOREY) {
          B.trim(slabGeo(plan, yy, 0.42, 0.42), slabHex);
        }
        cornerColumns(B, plan, y, segTop, Math.min(pw, pd) * 0.09, finHex);
        break;
      case 'grid':
        fins(B, plan, y + 1, segTop, 10 + Math.round(r() * 8), 0.5, finHex);
        for (let yy = y + STOREY * 2; yy < segTop - 2; yy += STOREY * 2) {
          B.trim(slabGeo(plan, yy, 0.3, 0.36), slabHex);
        }
        break;
      case 'sleek':
        cornerColumns(B, plan, y, segTop, Math.min(pw, pd) * 0.075, finHex);
        for (let yy = y + STOREY * 6; yy < segTop - 2; yy += STOREY * 6) {
          B.trim(slabGeo(plan, yy, 0.5, 0.3), slabHex);
        }
        break;
      case 'brise':
        briseSoleil(B, plan, y + STOREY, segTop, STOREY * 1.5, 0.9, finHex);
        cornerColumns(B, plan, y, segTop, Math.min(pw, pd) * 0.085, slabHex);
        break;
      case 'oriel':
        orielBays(B, plan, y + 0.6, segTop - 0.4,
          Math.max(4, Math.min(14, Math.round(planPerimeter(plan) / 10))),
          Math.min(4.2, Math.min(pw, pd) * 0.26), 0.9 + r() * 0.6, cm, finHex);
        cornerColumns(B, plan, y, segTop, Math.min(pw, pd) * 0.07, slabHex);
        break;
      case 'crossband':
        // Every third floor, deep enough to throw a real shadow line. This is
        // the one language that still reads as bands from the bay.
        for (let yy = y + STOREY * 3; yy < segTop - 2; yy += STOREY * 3) {
          B.trim(slabGeo(plan, yy - 0.3, 0.85, 0.8), slabHex);
        }
        fins(B, plan, y + 1, segTop, 6 + Math.round(r() * 5), 0.34, finHex);
        break;
      default:
        fins(B, plan, y + 1, segTop, 8 + Math.round(r() * 6), 0.55, finHex);
        for (let yy = y + STOREY * 4; yy < segTop - 2; yy += STOREY * 4) {
          B.trim(slabGeo(plan, yy, 0.34, 0.34), slabHex);
        }
    }

    // Setback: the terrace roof it creates is prime 3/4-camera real estate.
    if (!isLast) {
      B.trim(slabGeo(plan, segTop, 0.5, 1.1), slabHex);
      pw *= 0.78 + r() * 0.14; pd *= 0.78 + r() * 0.14;
      // A tower is allowed to change shape at a setback. A slab that becomes a
      // point tower is the biggest massing move available for free, and drawing
      // every storey from the same archetype is what made the setbacks read as
      // one prism telescoping into itself.
      if (r.chance(0.32)) curKind = r.weighted(PLAN_MENU);
      const next = mv(shaftPlan(r, pw, pd, curKind, phase));
      roofScape(B, offsetPlan(plan, 0.6), segTop + 0.5, r, {
        tank: false, parapetH: 1.0, pool: resi && r.chance(0.65),
        deck: resi || r.chance(0.55),
        avoid: offsetPlan(next, 2.5),
      });
      plan = next;
    }
    y = segTop;
  }

  // The name down the corner. Every hotel and half the condos in Brickell wear
  // one, and after dark it is what makes a tower an address instead of a lit
  // grid. Kept clear of the crown and the base so it reads as a blade.
  if (o.lit && r.chance(0.45)) {
    const b0 = planBounds(plan0);
    const y0 = Math.max(baseTop + 4, 10);
    if (y - 10 > y0 + 14) {
      neonBlade(B, b0.x1 - 0.5, b0.cz, y0, y - 10, Math.PI / 2, B.neon, 1.0 + r() * 0.5);
    }
  }

  const capPlan = rotPlan(plan, twist * y / 60);
  return crown(B, capPlan, y, r, {
    lit: o.lit, litHex: o.litHex, helipad: o.helipad ?? (h > 120 && r.chance(0.5)),
    kind: o.crownKind, mast: o.mast,
  });
}

/**
 * Miami residential tower: pastel render, a balcony slab on every floor, a
 * couple of setbacks. No curtain wall, so it is a single draw call — and it is
 * the only thing that stops the skyline being a comb of identical teal shafts.
 */
function resiTower(ctx, B, r, w, d, h, o = {}) {
  const podH = o.podiumH || 0;
  const shift = o.shift || 0;
  const mv = (p) => (shift ? movePlan(p, shift, 0) : p);
  const pal = o.pal || r.weighted(BASE_PALETTES);
  let y = 0;

  const maxSect = h > 110 ? 3 : h > 58 ? 2 : 1;
  const sections = Math.max(1, Math.min(maxSect, r.weighted([[1, 34], [2, 40], [3, 26]])));
  const kind = o.planKind || r.weighted([
    ['chamfer', 26], ['slab', 18], ['ellipse', 12], ['lens', 12],
    ['bow', 10], ['hex', 8], ['wedge', 8], ['cut', 6],
  ]);
  const phase = r();
  const plan0 = mv(shaftPlan(r, w, d, kind, phase));

  if (podH > 2) {
    const pw = Math.min(w * 1.12, o.lotW ?? w * 1.12);
    const pd = Math.min(d * 1.12, o.lotD ?? d * 1.12);
    const pp = rectPlan(pw, pd, Math.min(pw, pd) * 0.11);
    podium(B, pp, podH, r, null, {
      wallHex: o.trimHex || pal.wall, canopyHex: r.pick(FABRIC_COLORS),
      pierHex: o.trimHex || pal.pier, neon: B.neon, pal,
    });
    roofScape(B, offsetPlan(pp, -1.8), podH + 0.05, r, {
      tank: false, parapetH: 1.0, pool: r.chance(0.55), deck: true,
      avoid: offsetPlan(mv(rectPlan(w, d, 0)), 2.6),
    });
    y = podH;
  } else {
    towerBase(B, plan0, r, pal, B.neon, null,
      Math.max(0.35, Math.min((o.lotW ?? w + 3) - w, (o.lotD ?? d + 3) - d) / 2 - 0.25));
  }

  let plan = plan0;
  const trim = o.trimHex || P.STUCCO_WHITE;
  const rail = r.pick([P.GLASS_SKY, P.ALUMINIUM, P.STUCCO_WHITE, P.GLASS_AQUA, P.MULLION]);
  const step = STOREY * (h > 55 ? 2 : 1);
  const mode = r.weighted(BALCONY_MODES);
  /*
   * Facade language, drawn once per building.
   *
   * Four Brickell condos in a row all wore a projecting balcony slab on every
   * other floor, the same depth, the same rail — the same asset recoloured,
   * which is exactly what this module exists to prevent. A recessed loggia and
   * a continuous ribbon slab are the two other ways a Miami condo is actually
   * built, and they read completely differently at skyline distance: one is a
   * grid of shadow, one is a stack of white lines, one is a comb.
   */
  const lang = o.resiFacade || r.weighted([
    ['balcony', 34], ['loggia', 20], ['ribbon', 18], ['deep', 12],
    ['terrace', 16], ['oriel', 14],
  ]);
  /*
   * How far anything is allowed to hang off the structural plan.
   *
   * The consumption physics measures the assembled geometry, so a balcony over
   * the lot line does not just look wrong — it makes the building claim ground
   * it is not standing on and react to holes that never reached it. The shaft
   * is drawn well inside its parcel, so this is usually the full 2 m; on a lot
   * the shaft nearly fills it collapses to whatever is actually spare.
   */
  const reach = Math.max(0.55, Math.min(2.0,
    Math.min((o.lotW ?? w + 4) - w, (o.lotD ?? d + 4) - d) / 2 - 0.3));
  const proj = Math.min(reach, 0.85 + r() * 0.65);
  let pw = w, pd = d;
  for (let sct = 0; sct < sections; sct++) {
    const last = sct === sections - 1;
    const want = last ? h : y + (h - podH) * (0.30 + r() * 0.14);
    const segTop = Math.min(h - 2, Math.max(y + 14, want));
    B.face(loft([{ p: plan, y }, { p: plan, y: segTop }], B.wall()));
    if (lang === 'loggia') {
      // Recessed balconies: a dark reveal with a rail across it, so the facade
      // is a grid of holes rather than a stack of shelves.
      for (let yy = y + STOREY; yy < segTop - 1; yy += step) {
        B.trim(loft([{ p: offsetPlan(plan, -0.4), y: yy }, { p: offsetPlan(plan, -0.4), y: yy + step * 0.62 }],
          { uScale: 4, vScale: 4 }), P.SPANDREL);
        B.trim(parapetGeo(plan, yy, 1.0, 0.13), rail);
      }
      fins(B, plan, y, segTop, Math.max(4, Math.round(planPerimeter(plan) / 9)), 0.7, trim);
    } else if (lang === 'ribbon') {
      // Continuous floor slabs with the rail flush on the edge — the smooth
      // white-line condo. No projection at all, so its silhouette is a prism
      // and the detail is all in the banding.
      for (let yy = y + STOREY; yy < segTop - 1; yy += STOREY) {
        B.trim(slabGeo(plan, yy - 0.18, 0.4, 0.34), trim);
        B.trim(parapetGeo(offsetPlan(plan, 0.34), yy + 0.22, 0.95, 0.1), rail);
      }
    } else if (lang === 'terrace') {
      // Deep planted setback every four floors, plain render between. The Miami
      // garden condo, and the only residential language whose facade shows
      // GREEN from the 3/4 camera instead of another stack of white shelves.
      const tp = Math.min(reach, 1.5 + r() * 0.6);
      for (let yy = y + STOREY * 2; yy < segTop - 1; yy += STOREY * 4) {
        B.trim(slabGeo(plan, yy, 0.3, tp), trim);
        B.trim(loft([{ p: offsetPlan(plan, tp - 0.55), y: yy + 0.3 },
          { p: offsetPlan(plan, tp - 0.55), y: yy + 0.92 }], {}), P.HEDGE);
        B.trim(parapetGeo(offsetPlan(plan, tp), yy + 0.3, 1.0, 0.12), rail);
      }
      fins(B, plan, y, segTop, Math.max(4, Math.round(planPerimeter(plan) / 11)), 0.5, trim);
    } else if (lang === 'oriel') {
      orielBays(B, plan, y + 0.4, segTop - 0.3,
        Math.max(4, Math.min(12, Math.round(planPerimeter(plan) / 11))),
        Math.min(4.0, Math.min(pw, pd) * 0.24), Math.min(reach, 1.0 + r() * 0.5),
        null, trim);
      for (let yy = y + STOREY * 3; yy < segTop - 1; yy += STOREY * 3) {
        B.trim(slabGeo(plan, yy, 0.3, Math.min(reach, 0.35)), trim);
      }
    } else {
      balconyStack(B, plan, y + STOREY, segTop, lang === 'deep' ? STOREY : step,
        Math.min(reach, lang === 'deep' ? proj * 1.6 : proj), trim, rail, mode);
    }
    if (r.chance(0.35)) fins(B, plan, y, segTop, 4, Math.min(reach, 0.85), trim);
    if (!last) {
      B.trim(slabGeo(plan, segTop, 0.55, Math.min(reach, 1.5)), trim);
      pw *= 0.78 + r() * 0.12; pd *= 0.78 + r() * 0.12;
      const next = mv(shaftPlan(r, pw, pd, r.chance(0.30) ? r.weighted([
        ['chamfer', 26], ['slab', 18], ['ellipse', 12], ['lens', 12],
        ['bow', 10], ['hex', 8], ['wedge', 8], ['cut', 6],
      ]) : kind, phase));
      roofScape(B, offsetPlan(plan, 0.9), segTop + 0.55, r, {
        tank: false, parapetH: 1.0, pool: r.chance(0.55), deck: true,
        avoid: offsetPlan(next, 2.0),
      });
      plan = next;
    }
    y = segTop;
  }
  // A neon blade down the corner of a pastel condo is the single most Miami
  // thing in the file, and it is what makes the residential half of the
  // skyline visible at midnight instead of a row of black cutouts.
  if (o.lit && r.chance(0.55)) {
    const bb = planBounds(plan);
    neonBlade(B, bb.x1 - 0.4, bb.cz, Math.max(podH, 6), y - 4, Math.PI / 2, B.neon, 1.1);
  }
  return crown(B, plan, y, r, {
    lit: o.lit, helipad: o.helipad, mast: o.mast,
    // Dome and hat were 23% of this menu between them, and both are pale
    // domed lumps — four of them landed in one downtown frame and read as the
    // same hat on four buildings. Trimmed, and the two new tops that are not
    // lumps at all take the difference.
    kind: o.crownKind || r.weighted([
      ['plant', 13], ['step', 13], ['taper', 8], ['dome', 9], ['sky', 13],
      ['hat', 8], ['ring', 9], ['spire', 9], ['lantern', 7], ['slant', 8],
      ['glassbox', 10], ['arch', 6],
    ]),
  });
}

/* =========================================================== midrise ==== */

/** 6-16 storey Deco / stucco block: banded floors, stepping, loggias. */
function midrise(ctx, B, r, w, d, h, o = {}) {
  const deco = o.deco ?? r.chance(0.4);
  /*
   * `w`/`d` are the ground this building may OCCUPY, not the size of its
   * structural plan. Balconies, cornices and the base band all hang outside
   * the plan, so the plan has to be drawn in by that much or the silhouette —
   * which is what the eye sees and what the consumption footprint measures —
   * overruns the strip of lot the block split handed us. A 1.15 m balcony
   * against a 1.0 m party gap is how 7 midrise pairs came to overlap by up to
   * 0.9 m of thin air. Everything hung off `plan` below is capped at `reach`,
   * so the assembled width is exactly `w`.
   */
  const reach = Math.min(deco ? 0.6 : 1.15, Math.min(w, d) * 0.06);
  const pw = Math.max(5, w - 2 * reach), pd = Math.max(5, d - 2 * reach);
  const cham = Math.min(pw, pd) * (deco ? 0.10 : 0.16);
  // A midrise does not have to be a rectangle either. Chamfered, octagonal and
  // corner-cut plans all fit the same lot and none of them read as the box next
  // to them; the plan is drawn once and every setback inherits it.
  const mk = r.weighted([['chamfer', 44], ['slab', 18], ['octa', 12], ['cut', 12],
    ['ellipse', 6], ['bow', 8]]);
  let plan = deco ? rectPlan(pw, pd, cham) : shaftPlan(r, pw, pd, mk, r());
  // Deco is the language that WANTS a loud band, so it draws the accent twice as
  // often as the plain stucco block does.
  const trim = o.trimHex
    || (r.chance(deco ? 0.55 : 0.28) ? accentFor(r, o.wallHex) : r.weighted(RENDER_TRIM));

  const steps = h > 26 ? (deco ? r.int(2, 3) : r.int(1, 2)) : 1;
  let y = 0;
  const heights = [];
  for (let i = 0; i < steps; i++) heights.push((h / steps) * (i === steps - 1 ? 1 : 0.9 + r() * 0.2));
  const bandMode = r.weighted(BALCONY_MODES);
  // Facade language, drawn once for the whole building so the storeys agree.
  const lang = deco ? 'deco' : r.weighted([['balcony', 40], ['loggia', 20], ['pier', 22], ['ribbon', 18]]);

  for (let i = 0; i < steps; i++) {
    const top = i === steps - 1 ? Math.max(y + 6, h) : y + heights[i];
    B.face(loft([{ p: plan, y }, { p: plan, y: top }], B.wall()));

    if (lang === 'deco') {
      // String courses every floor read as the Deco banding from the air.
      for (let yy = y + STOREY; yy < top - 1; yy += STOREY) {
        B.trim(slabGeo(plan, yy - 0.16, 0.3, Math.min(0.26, reach)), trim);
      }
    } else if (lang === 'pier') {
      fins(B, plan, Math.max(y, 4.8), top - 0.5, Math.max(5, Math.round((pw + pd) / 7)),
        Math.min(0.62, reach / 0.85), trim);
      for (let yy = y + STOREY * 2; yy < top - 1; yy += STOREY * 2) {
        B.trim(slabGeo(plan, yy, 0.26, Math.min(0.24, reach)), P.CONCRETE_WARM);
      }
    } else if (lang === 'ribbon') {
      for (let yy = y + STOREY; yy < top - 1; yy += STOREY) {
        B.trim(slabGeo(plan, yy - 0.2, 0.46, Math.min(0.5, reach)), trim);
      }
    } else if (lang === 'loggia') {
      // Recessed balconies: a dark reveal band instead of a projecting slab.
      for (let yy = y + STOREY; yy < top - 1; yy += STOREY * 2) {
        B.trim(loft([{ p: offsetPlan(plan, -0.35), y: yy }, { p: offsetPlan(plan, -0.35), y: yy + 2.2 }],
          { uScale: 4, vScale: 4 }), P.SPANDREL);
        B.trim(parapetGeo(plan, yy, 1.0, 0.14), r.chance(0.5) ? P.ALUMINIUM : P.GLASS_SKY);
      }
    } else {
      balconyStack(B, plan, Math.max(y, STOREY), top - 1, STOREY * (r.chance(0.6) ? 1 : 2),
        reach, trim, r.chance(0.5) ? P.ALUMINIUM : P.GLASS_SKY, bandMode);
    }

    B.trim(slabGeo(plan, top, 0.45, Math.min(0.55, reach)), P.CONCRETE_WARM);   // cornice
    if (i < steps - 1) {
      const nextPlan = insetPlan(plan, 1.8 + r() * 2.6);
      roofScape(B, offsetPlan(plan, 0.2), top + 0.45, r, {
        tank: false, parapetH: 0.9, avoid: offsetPlan(nextPlan, 1.6),
        pool: r.chance(0.30), deck: r.chance(0.55),
      });
      plan = nextPlan;
      if (planBounds(plan).w < 8 || planBounds(plan).d < 8) { y = top + 0.45; break; }
    }
    y = top + 0.45;
  }

  roofScape(B, plan, y, r, {
    pool: !deco && r.chance(0.42), parapetHex: deco ? trim : P.PARAPET,
    // Roof terraces on the low city are what the 3/4 camera is actually looking
    // down at for most of the frame, and they are the nightlife the brief wants.
    deck: r.chance(deco ? 0.22 : 0.34),
    // A roof sign is the cheapest thing a low building can wear that reads at
    // BOTH review distances, and after dark it is what stops the gaps between
    // the towers going black. It costs no mesh — the emissive is merged.
    sign: o.sign ?? r.chance(0.42),
  });
  const roofTop = y + 2.5;

  // Ground-floor retail: a recessed dark shopfront band with piers in front,
  // which is what gives a midrise any scale at eye level.
  if (o.retailBase !== false) {
    const base = rectPlan(pw, pd, cham);
    const bb2 = planBounds(base);
    B.trim(loft([{ p: offsetPlan(base, -0.45), y: 0.45 }, { p: offsetPlan(base, -0.45), y: 4.3 }], { uScale: 4, vScale: 4 }), P.SPANDREL);
    B.trim(loft([{ p: base, y: 0 }, { p: base, y: 0.45 }], { uScale: 4, vScale: 4 }), P.CONCRETE_DARK);
    // A fin sits proud of the face by 0.85x its depth, so it is the deepest
    // thing on the flank of a low midrise unless it is capped too.
    fins(B, base, 0.45, 4.6, Math.max(6, Math.round((pw + pd) / 6)),
      Math.min(0.7, reach / 0.85), trim);
    B.trim(slabGeo(base, 4.3, 0.55, Math.min(0.5, reach)), trim);
    // Lit fascia over the shopfront — the band that carries the street at
    // night. Gated: an emissive band is a second mesh and therefore a second
    // draw call on a building that would otherwise cost exactly one.
    if (o.litFascia ?? r.chance(0.45)) {
      B.lit(loft([{ p: offsetPlan(base, 0.05), y: 4.32 }, { p: offsetPlan(base, 0.05), y: 4.82 }], {}));
    }
    if (r.chance(0.72)) awning(B, Math.min(pw * 0.62, 14), 4.2, bb2.z1 + 0.05, 1.9, 0.5, r.pick(FABRIC_COLORS));
    else canopy(B, Math.min(pw * 0.6, 14), 4.2, bb2.z1, 2.0, r.pick(FABRIC_COLORS));
    // Planters at the base: what the player's hole actually drives past.
    for (const sx of [-1, 1]) {
      const px = sx * pw * 0.34;
      B.trim(box(1.7, 0.7, 0.9, px, 0, bb2.z1 - 0.5, 2), P.PLANTER);
      B.trim(box(1.45, 0.3, 0.7, px, 0.7, bb2.z1 - 0.5, 2), P.HEDGE);
    }
    // A vertical neon blade on the corner — Deco hotels wear these.
    if (r.chance(0.30) && h > 12) {
      neonBlade(B, bb2.x1 - 0.5, bb2.z1 - 0.9, 5.2, Math.min(h - 1.5, 5.2 + 12), 0, B.neon, 0.85);
    }
  }
  return roofTop;
}

/* ======================================================== storefronts === */

/** Awning band inside Textures.storefront(), in tile-v. */
const AWN_V0 = 1 - 0.26, AWN_V1 = 1 - 0.175;
const SIGN_V0 = 1 - 0.17, SIGN_V1 = 1 - 0.055;

/**
 * Striped awning that borrows the shopfront texture's own awning band.
 * `x` places it along the frontage, so a wide podium can carry a run of them
 * instead of one lonely canopy over the lobby door.
 */
function awning(B, w, y, zFace, proj, drop, hex, x = 0) {
  if (!B.sk.awn) {
    // No striped band in this texture — model a plain fabric canopy instead.
    // Sloped about its own centre, then moved to the facade. Rotating it after
    // the translate pivoted it around the building origin, which threw the
    // fabric 2-3 m into the air and left it hanging off nothing above the
    // valance it is supposed to be attached to.
    const g = box(w, 0.22, Math.hypot(proj, drop), 0, -0.11, 0, 3);
    g.rotateX(Math.atan2(drop, proj));
    g.translate(x, y - drop / 2, zFace + proj / 2);
    B.trim(g, hex || P.FABRIC_CORAL);
    B.trim(box(w, 0.5, 0.16, x, y - drop - 0.5, zFace + proj, 3), hex || P.FABRIC_CORAL);
    return;
  }
  const pos = [], nor = [], uv = [], idx = [];
  const hw = w / 2;
  const z0 = zFace, z1 = zFace + proj;
  const y0 = y, y1 = y - drop;
  const push = (p, n, u) => {
    const b = pos.length / 3;
    for (let i = 0; i < 4; i++) { pos.push(p[i][0], p[i][1], p[i][2]); nor.push(n[0], n[1], n[2]); uv.push(u[i][0], u[i][1]); }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  // Sloping top — the stripes run out from the facade.
  push(
    [[-hw, y0, z0], [hw, y0, z0], [hw, y1, z1], [-hw, y1, z1]],
    [0, 0.94, 0.34],
    [[0, AWN_V1], [1, AWN_V1], [1, AWN_V0], [0, AWN_V0]]
  );
  // Underside.
  push(
    [[-hw, y1 - 0.12, z1], [hw, y1 - 0.12, z1], [hw, y0 - 0.12, z0], [-hw, y0 - 0.12, z0]],
    [0, -0.94, -0.34],
    [[0, AWN_V0], [1, AWN_V0], [1, AWN_V1], [0, AWN_V1]]
  );
  // Valance.
  push(
    [[-hw, y1, z1], [hw, y1, z1], [hw, y1 - 0.55, z1], [-hw, y1 - 0.55, z1]],
    [0, 0, 1],
    [[0, AWN_V0], [1, AWN_V0], [1, AWN_V0 - 0.03], [0, AWN_V0 - 0.03]]
  );
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  if (x) g.translate(x, 0, 0);
  B.band(g);
}

/**
 * Projecting fascia box over a shopfront: a shallow tray whose faces are all
 * mapped into the signage band, so it reads as a lit sign at night off the
 * shared skin material.
 */
function fasciaBox(B, x, y, zFace, w, h) {
  const g = box(w, h, 0.34, x, y, zFace + 0.17, 2);
  const a = g.attributes.uv;
  for (let i = 0; i < a.count; i++) {
    a.setXY(i, 0.08 + (a.getX(i) % 1) * 0.84, SIGN_V0 + (SIGN_V1 - SIGN_V0) * 0.5);
  }
  a.needsUpdate = true;
  B.band(g);
  B.trim(box(w + 0.24, 0.14, 0.44, x, y + h, zFace + 0.22, 2), P.STEEL_DARK);
}

/** Projecting blade sign, front faces borrowed from the signage band. */
function bladeSign(B, x, y, zFace, w, h) {
  const g = box(0.22, h, w, x, y, zFace + w / 2 + 0.2, 2);
  const a = g.attributes.uv;
  for (let i = 0; i < a.count; i++) a.setXY(i, 0.15 + a.getX(i) * 0.02, SIGN_V0 + (SIGN_V1 - SIGN_V0) * 0.5);
  a.needsUpdate = true;
  B.band(g);
  B.trim(box(0.1, 0.1, w * 0.9, x, y + h, zFace + w / 2 + 0.2, 2), P.STEEL_DARK);
}

/**
 * A retail parcel is a ROW of individually edible shops. Each unit gets its own
 * width, height, cornice, awning and signage, so the row never combs.
 */
function shopUnit(ctx, group, b, r, world, lw, ld, h, hex, opt = {}) {
  const B = new Build(shopSkin(hex), r.pick(NEON_SET));
  const floors = Math.max(1, Math.round(h / 5.0));
  const cham = Math.min(lw, ld) * 0.06;
  // One texture tile == exactly the shopfront, so the display window, awning
  // band and plinth land where the modelled awning and cornice are.
  const uS = Math.max(4, lw - 2 * cham), vS = h / floors;
  const plan = rectPlan(lw, ld, cham);
  const bb = planBounds(plan);

  // uOffset puts the front face's tile seam exactly on the shop's left corner.
  B.face(loft([{ p: plan, y: 0 }, { p: plan, y: h }], {
    uScale: uS, vScale: vS, capTop: false, capBottom: true,
    // Perimeter runs +x face, back, -x face, then the street face; shift u so
    // the street face starts on a tile boundary.
    uOffset: -(2 * (ld - 2 * cham) + (lw - 2 * cham) + 3 * cham * 1.4142) / uS,
  }));

  /* --- cornice + parapet. Vary the profile per unit. --------------------- */
  const cor = r.weighted([['flat', 24], ['step', 22], ['curve', 22], ['gable', 16], ['finial', 16]]);
  const trimHex = r.pick([P.STUCCO_WHITE, P.STUCCO_CREAM, P.CONCRETE_WARM, P.STUCCO_SAND]);
  // The cornice projects 0.42 m, and on the flanks that is the PARTY WALL. A
  // terrace's cornice returns on its own frontage; it does not grow into the
  // shop next door. Hung off the full plan it made every unit 0.84 m wider
  // than the strip of frontage it was allotted, against a 0.35 m gap — which
  // is all 157 storefront/storefront pairs in the audit's overlap list, each
  // one a cornice buried inside its neighbour's wall and 0.42 m of the
  // neighbour's ground claimed by the wrong building's footprint.
  const COR = 0.42;
  B.trim(slabGeo(rectPlan(Math.max(2, lw - 2 * COR), ld, cham), h, 0.42, COR),
    trimHex);
  if (cor === 'step') {
    B.trim(parapetGeo(plan, h + 0.42, 0.7, 0.4), P.CONCRETE_WARM);
    const cw = lw * 0.42;
    B.trim(box(cw, 1.1, ld * 0.3, 0, h + 0.42, bb.z1 - ld * 0.16, 3), trimHex);
  } else if (cor === 'curve') {
    B.trim(parapetGeo(plan, h + 0.42, 0.55, 0.4), P.CONCRETE_WARM);
    B.trim(cyl(lw * 0.24, 0.5, 12, 0, h + 0.97, bb.z1 - ld * 0.14), trimHex);
  } else if (cor === 'gable') {
    // Stepped Deco gable over the frontage — three rising blocks, centred.
    B.trim(parapetGeo(plan, h + 0.42, 0.6, 0.4), P.CONCRETE_WARM);
    for (let i = 0; i < 3; i++) {
      const gw = lw * (0.62 - i * 0.17);
      if (gw < 1.2) break;
      B.trim(box(gw, 0.75, Math.min(ld * 0.28, 1.6), 0, h + 0.42 + i * 0.75,
        bb.z1 - Math.min(ld * 0.14, 0.8), 2.5), i % 2 ? trimHex : P.CONCRETE_WARM);
    }
  } else if (cor === 'finial') {
    // Flat parapet with a pair of piers — the cheap Deco frontage, everywhere
    // on Collins Ave and nowhere in the first version of this file.
    B.trim(parapetGeo(plan, h + 0.42, 0.8, 0.4), P.CONCRETE_WARM);
    for (const sx of [-1, 1]) {
      B.trim(box(0.7, 1.5, 0.7, sx * (lw / 2 - 0.9), h + 0.42, bb.z1 - 0.5, 2), trimHex);
      B.trim(box(0.9, 0.22, 0.9, sx * (lw / 2 - 0.9), h + 1.92, bb.z1 - 0.5, 2), P.CONCRETE_WARM);
    }
  } else {
    B.trim(parapetGeo(plan, h + 0.42, 0.9, 0.4), P.CONCRETE_WARM);
  }
  B.trim(loft([{ p: offsetPlan(plan, -0.4), y: h + 0.45 }], { capTop: true, uScale: 3 }),
    r.weighted(ROOF_SURFACE));

  /* --- roof plant. Small, but this is what a mid-game hole looks down on. */
  const nAc = 1 + Math.floor(r() * 2);
  for (let i = 0; i < nAc; i++) {
    const x = (r() - 0.5) * lw * 0.55, z = (r() - 0.5) * ld * 0.55;
    if (r() < 0.55) acPack(B, x, h + 0.5, z, r.chance(0.5) ? 0 : Math.PI / 2, 0.8 + r() * 0.3, r);
    else ventStack(B, x, h + 0.5, z, 0.8);
  }
  if (r.chance(0.3)) waterTank(B, (r() - 0.5) * lw * 0.4, h + 0.5, (r() - 0.5) * ld * 0.4, 0.55);
  // Roof terrace on a taller unit: chairs and parasols read from the 3/4 camera
  // and are exactly the nightlife the brief asks for.
  if (h > 9 && lw > 9 && r.chance(0.35)) {
    parasol(B, (r() - 0.5) * lw * 0.4, h + 0.5, bb.z1 - ld * 0.28,
      r.pick(FABRIC_COLORS), 0.8);
    B.trim(box(1.0, 0.72, 1.0, (r() - 0.5) * lw * 0.4, h + 0.5, bb.z1 - ld * 0.28, 2), P.TABLE_TOP);
  }

  /* --- shopfront furniture ---------------------------------------------- */
  const awnY = vS * AWN_V1;
  if (r.chance(0.82)) awning(B, lw * 0.9, awnY, bb.z1, 1.6 + r() * 0.9, 0.55);
  /*
   * A shop's signage costs ZERO extra draw calls, and that is why it is built
   * this way. bladeSign and fasciaBox pin their UVs to the signage band of the
   * shopfront texture, so they merge into the same skin mesh as the wall — and
   * that material carries shopNightTex as its emissiveMap, which means the
   * band, the letters and the display window all light at dusk without a second
   * mesh, a second material or a second draw. 242 storefronts x one lit mesh
   * each would have been 242 draw calls for the same picture.
   */
  if (r.chance(0.62)) bladeSign(B, lw * (0.5 - 0.12), awnY + 1.6, bb.z1, 1.5, 0.9);
  if (r.chance(0.55)) fasciaBox(B, 0, vS * SIGN_V0 - 0.1, bb.z1, lw * 0.86, vS * 0.13);
  // Roll-down shutter on a closed unit.
  if (r.chance(0.18)) {
    B.trim(box(lw * 0.62, 3.1, 0.22, 0, 0.1, bb.z1 - 0.1, 2), P.ALUMINIUM);
  }
  // A-board on the pavement, part of the shop so it falls with it.
  // Both leaves are tilted about their own centre and only then moved out to
  // the kerb: rotateX on a leaf that has already been pushed 20 m down the
  // parcel swings it about the SHOP's origin, which buried one leaf up to 4 m
  // under the pavement and left the other floating over it. That single bug
  // was every "sunken storefront" in the audit.
  if (r.chance(0.4)) {
    const ax = (r() - 0.5) * lw * 0.5, az = bb.z1 + 1.45;
    for (const [tilt, hex] of [[0.16, P.SIGN_LIGHT], [-0.16, P.SIGN_DARK]]) {
      const g = box(0.9, 1.1, 0.09, 0, -0.55, 0, 1.5);
      g.rotateX(tilt);
      g.translate(ax, 0.55, az - Math.sign(tilt) * 0.16);
      B.trim(g, hex);
    }
  }

  register(ctx, group, B, world, Math.max(lw, ld) * 0.5, h + 1.4, TIER.HUGE,
    'storefront', opt.label || 'Storefront', hex, { lw, ld });
}

/* ============================================================ garage ==== */

/** Cheap parked car: three boxes, tinted. Only the visible decks get them. */
function parkedCar(B, x, y, z, rot, hex) {
  const body = box(4.4, 0.95, 1.85, 0, 0, 0, 3);
  const cabin = box(2.5, 0.72, 1.72, -0.2, 0.95, 0, 3);
  const g = BufferGeometryUtils.mergeGeometries([body, cabin], false);
  g.rotateY(rot); g.translate(x, y, z);
  B.trim(g, hex);
}

function garage(ctx, group, b, r, world, lw, ld, levels) {
  const B = new Build(deckSkin(), P.SIGN_BLUE);
  const lh = 3.35;
  const cham = Math.min(lw, ld) * 0.07;
  const plan = rectPlan(lw, ld, cham);
  const bb = planBounds(plan);
  const inner = offsetPlan(plan, -0.6);

  for (let i = 0; i < levels; i++) {
    const y = i * lh;
    B.face(loft([{ p: plan, y }, { p: plan, y: y + 0.5 }], { uScale: 10, vScale: 3, capBottom: i === 0 }));
    B.face(loft([{ p: plan, y: y + 0.5 }], { capTop: true, uScale: 10 }));
    // Spandrel. Kept low so the ~1.9 m band above it stays open — a garage you
    // cannot see into is just a concrete box.
    B.trim(loft([{ p: offsetPlan(plan, 0.22), y: y + 0.5 }, { p: offsetPlan(plan, 0.22), y: y + 1.25 }], {}), i % 2 ? P.PRECAST : P.CONCRETE);
    B.trim(slabGeo(plan, y + 1.25, 0.18, 0.34), P.CONCRETE_DARK);
    // Columns on a real structural grid, not just the corners.
    const cols = Math.max(3, Math.round(lw / 8));
    for (let k = 0; k <= cols; k++) {
      const x = bb.x0 + (lw * k) / cols;
      B.trim(box(0.6, lh, 0.7, x * 0.97, y, bb.z1 * 0.97, 3), P.CONCRETE_DARK);
      B.trim(box(0.6, lh, 0.7, x * 0.97, y, bb.z0 * 0.97, 3), P.CONCRETE_DARK);
    }

    // Parked cars right behind the spandrel, where the camera can see them.
    const rows = Math.max(2, Math.floor(lw / 2.9));
    for (let k = 0; k < rows; k++) {
      if (r() < 0.26) continue;
      const x = -lw / 2 + 2.0 + k * ((lw - 4) / Math.max(1, rows - 1));
      parkedCar(B, x, y + 0.5, bb.z1 - 2.1, Math.PI / 2, r.pick(CAR_HEX));
      if (r() < 0.7) parkedCar(B, x, y + 0.5, bb.z0 + 2.1, Math.PI / 2, r.pick(CAR_HEX));
    }
  }

  const top = levels * lh;
  // Ramp: a sheared slab climbing the west bay, visible from the 3/4 camera.
  for (let i = 0; i < levels - 1; i++) {
    const g = new THREE.BoxGeometry(6.2, 0.4, ld * 0.55);
    const pa = g.attributes.position;
    for (let v = 0; v < pa.count; v++) {
      if (pa.getZ(v) > 0) pa.setY(v, pa.getY(v) + lh);
    }
    pa.needsUpdate = true;
    g.computeVertexNormals();
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(pa.count * 2), 2));
    g.translate(-lw / 2 + 4.2, i * lh + 0.45, (i % 2 ? -1 : 1) * ld * 0.2);
    B.trim(g, P.CONCRETE);
  }

  // Stair / lift tower breaking the slab, plus rooftop level.
  bulkhead(B, bb.x0 + 3.4, 0, bb.z0 + 3.2, 5.2, 5.2, top + 3.2, P.STUCCO_SAND);
  B.trim(parapetGeo(plan, top, 1.2, 0.45), P.PRECAST);
  B.face(loft([{ p: inner, y: top + 0.02 }], { capTop: true, uScale: 10 }));
  const rows = Math.max(2, Math.floor(lw / 3.2));
  for (let k = 0; k < rows; k++) {
    if (r() < 0.45) continue;
    const x = -lw / 2 + 2.4 + k * ((lw - 5) / Math.max(1, rows - 1));
    parkedCar(B, x, top + 0.1, bb.z1 - 3.0, Math.PI / 2, r.pick(CAR_HEX));
  }
  for (let k = 0; k < 3; k++) {
    B.trim(cyl(0.14, 6.5, 6, bb.x0 + 5 + k * (lw - 10) / 2, top + 1.2, bb.cz), P.LAMP_POST);
  }
  // Big "P" sign on the street corner. Illuminated, because an unlit parking
  // sign is the one piece of signage in a city that is never actually unlit.
  B.trim(box(0.55, 3.6, 2.8, bb.x1 - 0.25, 4.4, bb.z1 - 3.0, 3), P.SIGN_DARK);
  B.lit(box(0.3, 2.6, 1.9, bb.x1 - 0.05, 4.9, bb.z1 - 3.0, 3), P.SIGN_BLUE);

  register(ctx, group, B, world, Math.max(lw, ld) * 0.5, top + 4, TIER.MASSIVE,
    'garage', 'Parking Garage', P.PRECAST, { lw, ld });
}

/** Surface car park: fence, planting kerb, painted bays, parked cars, kiosk. */
function surfaceLot(ctx, group, b, r, world, lw, ld) {
  const B = new Build(trimSkin(), P.SIGN_BLUE);
  const plan = rectPlan(lw, ld, 1.2);
  const bb = planBounds(plan);
  // Perimeter kerb + rail — stops the lot reading as a bald slab.
  B.trim(parapetGeo(plan, 0, 0.45, 0.4), P.CONCRETE_DARK);
  for (let i = 0; i < 10; i++) {
    const t = (i + 0.5) / 10;
    B.trim(cyl(0.09, 1.1, 6, bb.x0 + lw * t, 0.45, bb.z1 - 0.2), P.STEEL_DARK);
    B.trim(cyl(0.09, 1.1, 6, bb.x0 + lw * t, 0.45, bb.z0 + 0.2), P.STEEL_DARK);
  }
  B.trim(box(lw, 0.1, 0.12, 0, 1.4, bb.z1 - 0.2, 3), P.STEEL);
  B.trim(box(lw, 0.1, 0.12, 0, 1.4, bb.z0 + 0.2, 3), P.STEEL);

  const bays = Math.max(3, Math.floor((lw - 3) / 2.7));
  const rows = ld > 26 ? 2 : 1;
  for (let rr = 0; rr < rows; rr++) {
    const z = rows === 1 ? bb.cz : bb.z0 + 6.5 + rr * (ld - 13);
    for (let k = 0; k <= bays; k++) {
      const x = bb.x0 + 1.5 + k * ((lw - 3) / bays);
      B.trim(box(0.14, 0.055, 5.0, x, 0.0, z, 2), P.ROAD_LINE);   // stall paint
    }
    for (let k = 0; k < bays; k++) {
      if (r() < 0.38) continue;
      const x = bb.x0 + 1.5 + ((lw - 3) / bays) * (k + 0.5);
      parkedCar(B, x, 0.02, z, Math.PI / 2, r.pick(CAR_HEX));
    }
  }
  // Attendant kiosk + light poles.
  B.trim(box(2.6, 2.7, 2.4, bb.x1 - 2.4, 0, bb.z1 - 2.2, 2.5), P.STUCCO_CREAM);
  B.trim(box(3.2, 0.24, 3.0, bb.x1 - 2.4, 2.7, bb.z1 - 2.2, 2.5), P.ROOF_DARK);
  for (let k = 0; k < 2; k++) {
    const x = bb.x0 + lw * (0.3 + k * 0.4);
    B.trim(cyl(0.16, 7.5, 6, x, 0.45, bb.cz), P.LAMP_POST);
    B.trim(box(1.5, 0.28, 0.5, x, 7.9, bb.cz, 2), P.ALUMINIUM);
  }
  register(ctx, group, B, world, Math.max(lw, ld) * 0.5, 3, TIER.HUGE,
    'lot', 'Car Park', P.CONCRETE_DARK, { lw, ld });
}

const CAR_HEX = [
  P.CAR_WHITE, P.CAR_SILVER, P.CAR_GRAPHITE, P.CAR_RED, P.CAR_BLUE,
  P.CAR_TEAL, P.CAR_YELLOW, P.CAR_GREEN, P.CAR_CORAL, P.CAR_NAVY, P.CAR_BLACK,
];

/* ====================================================== construction ==== */

/** Lattice tower crane: mast, slew, cab, jib, counter-jib, cable and hook. */
function towerCrane(ctx, B, x, z, h, jib, rot, r) {
  const leg = 0.9;
  for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    B.trim(box(0.22, h, 0.22, x + dx * leg, 0, z + dz * leg, 2), P.CRANE_YELLOW);
  }
  for (let y = 2; y < h; y += 3.0) {
    B.trim(box(leg * 2.2, 0.15, 0.15, x, y, z - leg, 2), P.CRANE_YELLOW);
    B.trim(box(0.15, 0.15, leg * 2.2, x + leg, y, z, 2), P.CRANE_YELLOW);
  }
  const top = h;
  B.trim(box(2.6, 1.6, 2.6, x, top, z, 2), P.CRANE_YELLOW);
  const cab = box(2.0, 2.0, 2.2, 0, top + 1.6, 1.9, 2);
  const jibG = [];
  // Jib + counter-jib as one rotated assembly.
  jibG.push(box(jib, 0.5, 1.1, jib / 2 + 1.6, top + 1.9, 0, 3));
  jibG.push(box(jib * 0.34, 0.5, 1.1, -jib * 0.17 - 1.6, top + 1.9, 0, 3));
  jibG.push(box(2.6, 1.7, 2.4, -jib * 0.34 - 1.4, top + 1.9, 0, 2));   // counterweight
  for (let i = 1; i < 7; i++) {
    jibG.push(box(0.12, 1.0, 0.12, 1.6 + (jib / 7) * i, top + 2.4, 0, 2));
  }
  jibG.push(box(0.14, 4.6, 0.14, 1.0, top + 2.4, 0, 2));               // A-frame
  const trolley = jib * (0.35 + r() * 0.4);
  jibG.push(box(0.9, 0.4, 0.9, trolley, top + 1.6, 0, 2));
  jibG.push(box(0.1, h * 0.55, 0.1, trolley, top + 1.6 - h * 0.55, 0, 2));  // cable
  jibG.push(box(1.0, 0.9, 1.0, trolley, top + 1.6 - h * 0.55 - 0.9, 0, 2)); // hook block
  const merged = BufferGeometryUtils.mergeGeometries([cab, ...jibG], false);
  merged.rotateY(rot);
  merged.translate(x, 0, z);
  B.trim(merged, P.CRANE_YELLOW);
}

function scaffold(B, x0, x1, y0, y1, z, hex) {
  for (let x = x0; x <= x1 + 0.01; x += 2.4) B.trim(box(0.14, y1 - y0, 0.14, x, y0, z, 2), hex);
  for (let y = y0 + 2.0; y < y1; y += 2.0) {
    B.trim(box(x1 - x0, 0.12, 0.12, (x0 + x1) / 2, y, z, 3), hex);
    B.trim(box(x1 - x0, 0.09, 0.5, (x0 + x1) / 2, y - 0.09, z + 0.3, 3), P.WOOD_DECK);
  }
}

/**
 * A construction site. These are the most interesting silhouettes in the city,
 * so they get the full kit: core, exposed slabs, crane, scaffold, netting,
 * hoarding, portacabins and stacked materials.
 */
function construction(ctx, group, b, r, world, lw, ld, h, lotW, lotD) {
  const B = new Build(trimSkin(), P.NEON_ORANGE);
  const floors = Math.max(3, Math.round(h / 3.6));
  const cw = Math.max(6, lw * 0.28), cd = Math.max(6, ld * 0.28);
  const plan = rectPlan(lw, ld, Math.min(lw, ld) * 0.08);
  const bb = planBounds(plan);

  /* Concrete core, climbing a couple of floors above the topped-out slab. */
  const corePlan = rectPlan(cw, cd, 1.0);
  B.trim(loft([{ p: corePlan, y: 0 }, { p: corePlan, y: h + 9.5 }], { uScale: 5, vScale: 3.5, capTop: true }), P.CONCRETE);
  for (let y = 3.5; y < h + 9; y += 3.5) B.trim(slabGeo(corePlan, y - 0.1, 0.16, 0.18), P.CONCRETE_DARK);
  B.trim(parapetGeo(corePlan, h + 9.5, 1.0, 0.3), P.CONE_ORANGE);

  /* Exposed slabs on a real column grid. */
  const colPlan = offsetPlan(plan, -1.0);
  const gridN = Math.max(2, Math.round(lw / 9));
  /*
   * WHERE THE DECK STOPS BEING POURED.
   *
   * Every floor used to get a solid deck cap. From the review camera you look
   * DOWN at ~30 degrees onto a 3.6 m floor pitch, so deck hides deck and a
   * thirty-storey site rendered as one solid pale concrete prism with faint
   * lines on it — indistinguishable from a finished building with no windows,
   * which is art-bible anti-pattern #3 and was the loudest defect in the
   * Brickell frame. The top fifth now has beams and no slab, so there is real
   * sky through the frame and the thing reads as unfinished from 400 m.
   */
  const openFrom = Math.max(2, Math.round(floors * 0.8));
  for (let i = 1; i <= floors; i++) {
    const y = i * 3.6;
    // The top few floors are still being poured, so they shrink back and stop.
    const raw = i >= openFrom;
    const sp = i > floors * 0.78 ? offsetPlan(plan, -(2 + r() * 5)) : plan;
    B.trim(slabGeo(sp, y, 0.42, 0.35), P.PRECAST);
    if (!raw) {
      B.trim(loft([{ p: sp, y: y + 0.42 }], { capTop: true, uScale: 4 }), P.CONCRETE_WARM);
    } else {
      // Steel decking laid on beams, not yet poured: two runs of joists across
      // the bay, and starter bars standing out of the last pour.
      const spb = planBounds(sp);
      for (let k = 0; k <= gridN; k++) {
        B.trim(box(0.34, 0.36, spb.d * 0.92, spb.x0 + (spb.w * k) / gridN, y, spb.cz, 3), P.STEEL_DARK);
      }
      if (i === floors) {
        for (let k = 0; k <= gridN * 2; k++) {
          B.trim(cyl(0.05, 1.3, 4, spb.x0 + (spb.w * k) / (gridN * 2), y + 0.42, spb.cz + (r() - 0.5) * spb.d * 0.5), P.RUST);
        }
      }
    }
    for (let k = 0; k <= gridN; k++) {
      const t3 = k / gridN;
      B.trim(box(0.55, 3.6, 0.55, bb.x0 + 1.2 + (lw - 2.4) * t3, y - 3.18, bb.z1 - 1.2, 3), P.CONCRETE);
      B.trim(box(0.55, 3.6, 0.55, bb.x0 + 1.2 + (lw - 2.4) * t3, y - 3.18, bb.z0 + 1.2, 3), P.CONCRETE);
    }
    // Edge protection.
    if (i > 1 && i < floors) {
      for (let k = 0; k < 6; k++) {
        const t2 = (k + 0.5) / 6;
        B.trim(box(0.1, 1.1, 0.1, bb.x0 + lw * t2, y + 0.42, bb.z1 - 0.3, 2), P.CONE_ORANGE);
      }
      B.trim(box(lw * 0.96, 0.08, 0.1, 0, y + 1.4, bb.z1 - 0.3, 3), P.CONE_ORANGE);
    }
    // Stacked materials on a few slabs.
    if (r() < 0.5) {
      const mx = bb.x0 + 2.5 + r() * (lw - 5), mz = bb.z0 + 2.5 + r() * (ld - 5);
      B.trim(box(2.6, 0.5, 1.3, mx, y + 0.42, mz, 2), r.chance(0.5) ? P.RUST : P.WOOD_DECK);
      if (r() < 0.6) B.trim(box(2.2, 0.35, 1.1, mx + 0.2, y + 0.92, mz, 2), P.STEEL_DARK);
    }
  }

  /* Scaffolding + safety netting. Both street faces, because one wrapped face
     against three bare ones reads as a rendering glitch rather than as a site,
     and the netting is the only saturated colour the whole assembly owns. */
  const sh = Math.min(h, 3.6 * Math.round(floors * 0.7));
  scaffold(B, bb.x0 + 1.5, bb.x1 - 1.5, 0, sh, bb.z1 + 0.9, P.SCAFFOLD);
  const netHex = r.weighted([[P.STUCCO_MINT, 10], [P.STUCCO_SKY, 10], [P.FABRIC_AQUA, 7], [P.CONE_ORANGE, 5]]);
  for (let x = bb.x0 + 1.5; x < bb.x1 - 1.5; x += 2.6) {
    B.trim(box(1.3, sh, 0.05, x, 0, bb.z1 + 1.25, 3), netHex);
    B.trim(box(1.3, sh * 0.86, 0.05, x, 0, bb.z0 - 1.25, 3), netHex);
  }
  // Man-hoist up the flank: a lattice mast with a cage on it. The one piece of
  // kit that says "site" at any distance where the crane is off frame.
  const hx = bb.x1 - 1.4;
  for (const dz of [-0.8, 0.8]) {
    B.trim(box(0.16, h * 0.92, 0.16, hx, 0, bb.cz + dz, 2), P.CRANE_YELLOW);
  }
  for (let y = 2.4; y < h * 0.92; y += 2.4) {
    B.trim(box(0.12, 0.12, 1.8, hx, y, bb.cz, 2), P.CRANE_YELLOW);
  }
  B.trim(box(1.5, 2.4, 1.9, hx + 0.7, h * (0.22 + r() * 0.5), bb.cz, 2), P.SIGN_LIGHT);

  /* Hoarding — the site boundary, so it may never leave the parcel. */
  const hoard = rectPlan(Math.min(lw + 3.4, lotW ?? lw + 3.4),
    Math.min(ld + 3.4, lotD ?? ld + 3.4), 2.0);
  B.trim(parapetGeo(hoard, 0, 3.0, 0.22), r.pick([P.FABRIC_SKY, P.STUCCO_WHITE, P.FABRIC_AQUA]));
  B.trim(parapetGeo(hoard, 3.0, 0.22, 0.4), P.SIGN_DARK);
  const hb = planBounds(hoard);

  /* Crane.
   * The jib runs along the site's long axis and is cut so that BOTH ends stay
   * inside the hoarding. Swinging a 30 m jib to a random bearing on a 25 m
   * parcel hung it over the street and the neighbouring block — and since the
   * consumption footprint is measured off the assembled geometry, it also made
   * the site claim 12 m of ground it does not stand on. */
  const alongX = hb.w >= hb.d;
  const span = alongX ? hb.w : hb.d;
  const cross = (alongX ? hb.d : hb.w) / 2;
  // Forward reach is jib+1.6, counter-jib reach is 0.34*jib+2.7; both must fit
  // inside `span`, which pins the jib length and where the mast stands.
  const jib = Math.max(8, Math.min(30, (span - 4.3) / 1.34));
  const back = 0.34 * jib + 2.7;
  // Cab and counterweight are 3 m wide, so keep that much clear of the side.
  const lat = -Math.min(cross * 0.42, Math.max(0, cross - 3.2));
  towerCrane(ctx, B,
    alongX ? -span / 2 + back : lat,
    alongX ? lat : -span / 2 + back,
    h + 10 + r() * 12, jib, alongX ? 0 : -Math.PI / 2, r);

  for (let i = 0; i < 2 + Math.floor(r() * 2); i++) {
    const cx = hb.x1 - 4.0, cz = hb.z0 + 4 + i * 3.4;
    B.trim(box(6.0, 2.7, 2.9, cx, i > 1 ? 2.85 : 0, cz, 3), i % 2 ? P.STUCCO_WHITE : P.FABRIC_SKY);
    B.trim(box(6.2, 0.2, 3.1, cx, (i > 1 ? 2.85 : 0) + 2.7, cz, 3), P.STEEL);
  }
  B.trim(box(4.4, 1.5, 2.2, hb.x0 + 4, 0, hb.z1 - 3.2, 3), P.RUST);

  register(ctx, group, B, world, Math.max(lw, ld) * 0.6, h + 26, TIER.MASSIVE,
    'construction', 'Construction Site', P.CONCRETE, { lw: lotW ?? hb.w, ld: lotD ?? hb.d });
}

/* ========================================================= landmarks ==== */

/** Big-span roof, ring of glazing, deep fascia. Kaseya Center. */
function arena(ctx, B, r, lw, ld, h) {
  const plan = ellipsePlan(lw, ld, 22);
  const bb = planBounds(plan);
  const glassTop = h * 0.74;

  /* Plinth, then a full-height glazed drum, then a projecting fascia. The
     glazing has to sit PROUD of the concrete or the concrete simply hides it. */
  B.trim(loft([{ p: offsetPlan(plan, 0.6), y: 0 }, { p: offsetPlan(plan, 0.6), y: 4.2 }], { uScale: 6, vScale: 6, smooth: true }), P.PRECAST);
  B.gl(loft([{ p: plan, y: 4.2 }, { p: plan, y: glassTop }], { uScale: CW_U, vScale: CW_V, smooth: true }), curtainMat(P.GLASS_SKY));
  // Raking buttresses around the drum — the thing that says "arena".
  for (let i = 0; i < 18; i++) {
    const a = -(i / 18) * Math.PI * 2 + 0.3;
    const cx = Math.cos(a), cz = Math.sin(a);
    const g = box(0.9, glassTop - 4.2, 1.5, 0, 4.2, 0, 4);
    g.rotateY(Math.atan2(cx, cz));
    g.translate(cx * (lw / 2) * 1.01, 0, cz * (ld / 2) * 1.01);
    B.trim(g, P.CONCRETE);
  }
  // Fascia depth scales with the drum. The arena only ever gets the parcel the
  // zoner hands it, and Kaseya Center's is 20 m wide, not the 118 m the
  // landmark asks for — a fixed 2.6 m fascia there is a third of the building
  // hanging over the pavement.
  const fas = Math.min(2.6, Math.max(0.6, Math.min(lw, ld) * 0.05));
  B.trim(slabGeo(plan, glassTop, 1.8, fas), P.CONCRETE_WARM);
  B.lit(loft([{ p: offsetPlan(plan, fas + 0.3), y: glassTop + 0.3 }, { p: offsetPlan(plan, fas + 0.3), y: glassTop + 1.4 }], { smooth: true }), P.NEON_PINK);

  /* Barrel roof — scaled rings, not inset ones: an inset on a 118x88 ellipse
     collapses the short axis long before the long one. */
  B.trim(loft([
    { p: plan, y: glassTop + 1.8 },
    { p: scalePlan(plan, 0.93), y: glassTop + 5.0 },
    { p: scalePlan(plan, 0.72), y: glassTop + 8.6 },
    { p: scalePlan(plan, 0.40), y: glassTop + 10.6 },
  ], { uScale: 8, vScale: 8, smooth: true, capTop: true }), P.ROOF_MEMBRANE);
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    acUnit(B, Math.cos(a) * bb.w * 0.16, glassTop + 10.6, Math.sin(a) * bb.d * 0.16, 1.7, r);
  }
  /* Entrance canopy on columns — a deliberate overhang, but sized off the
     drum so it stays a canopy instead of becoming an 8 m slab over the road. */
  const cProj = Math.max(2.4, Math.min(11, ld * 0.16));
  B.trim(box(lw * 0.42, 1.1, cProj, 0, 7.6, bb.z1 + cProj * 0.34, 5), P.CHROME);
  // Arena marquee over the entrance. The one building in the city that would
  // be criminal to leave unnamed at night.
  channelSign(B, 0, 9.2, bb.z1 + cProj * 0.34, lw * 0.34, 2.6, 0, r, B.neon, false);
  for (const sx of [-1, 1]) {
    B.trim(cyl(0.55, 7.6, 10, sx * lw * 0.17, 0, bb.z1 + cProj * 0.62), P.STEEL);
  }
  return glassTop + 11;
}

/** Stepped masonry tower with an illuminated crown. Freedom Tower language. */
function decoTower(ctx, B, r, lw, ld, h) {
  const base = rectPlan(lw, ld, Math.min(lw, ld) * 0.10);
  const bh = Math.min(h * 0.34, 22);
  B.face(loft([{ p: base, y: 0 }, { p: base, y: bh }], B.wall()));
  // Colonnade across the entrance. Its projection tracks the parcel depth —
  // a fixed 2.7 m portico on a 12 m deep lot is a fifth of the building
  // standing on the pavement.
  const bb = planBounds(base);
  const por = Math.max(0.9, Math.min(1.7, ld * 0.12));
  for (let i = 0; i < 6; i++) {
    B.trim(cyl(0.62, 8.0, 10, bb.x0 + lw * (i + 0.5) / 6, 0, bb.z1 + por), P.STUCCO_WHITE);
  }
  B.trim(box(lw + 1.2, 1.3, por * 2 + 0.6, 0, 8.0, bb.z1 + por * 0.7, 4), P.STUCCO_WHITE);
  B.trim(slabGeo(base, bh, 0.6, 1.0), P.STUCCO_WHITE);

  let p = insetPlan(base, Math.min(lw, ld) * 0.16), y = bh + 0.6;
  const shaftTop = h * 0.80;
  B.face(loft([{ p, y }, { p, y: shaftTop }], B.wall()));
  for (let yy = y + STOREY; yy < shaftTop; yy += STOREY) B.trim(slabGeo(p, yy, 0.26, 0.22), P.STUCCO_WHITE);
  // Vertical piers — the thing that makes Deco read as Deco.
  fins(B, p, y, shaftTop, 12, 0.75, P.STUCCO_WHITE);
  B.trim(slabGeo(p, shaftTop, 0.7, 1.2), P.STUCCO_WHITE);

  // Stepped, illuminated crown + lantern.
  let cy = shaftTop + 0.7, cp = p;
  for (let i = 0; i < 3; i++) {
    const hh = (h - shaftTop) * 0.22;
    B.trim(loft([{ p: cp, y: cy }, { p: cp, y: cy + hh }], { uScale: 5, vScale: 5 }), P.STUCCO_CREAM);
    B.lit(loft([{ p: offsetPlan(cp, 0.22), y: cy + hh * 0.55 }, { p: offsetPlan(cp, 0.22), y: cy + hh * 0.9 }], {}), P.NEON_YELLOW);
    cy += hh;
    cp = insetPlan(cp, Math.min(lw, ld) * 0.09);
  }
  const cb = planBounds(cp);
  // A lantern is round, so its radius has to come off the SHORT axis of the
  // crown. Sizing it off cb.w put a 41 m drum on a 13 m deep parcel, hanging
  // 11 m over the carriageway on both sides.
  const lantern = Math.max(1.6, Math.min(cb.w, cb.d) * 0.45);
  B.trim(cyl(lantern, 6.0, 10, 0, cy, 0), P.STUCCO_WHITE);
  B.trim(cyl(lantern * 1.12, 4.0, 10, 0, cy + 6, 0, 0.15), P.TERRACOTTA);
  B.trim(cyl(0.28, 7.0, 6, 0, cy + 10, 0, 0.1), P.ALUMINIUM);
  B.lit(cyl(0.5, 0.5, 6, 0, cy + 16.6, 0), P.LIGHT_RED);
  return cy + 17;
}

/** Low, wide, heavy: colonnade, entablature, civic roof plant. */
function civicBlock(ctx, B, r, lw, ld, h) {
  const plan = rectPlan(lw, ld, 1.6);
  const bb = planBounds(plan);
  B.trim(loft([{ p: rectPlan(lw + 3.0, ld + 3.0, 2.0), y: 0 }, { p: rectPlan(lw + 3.0, ld + 3.0, 2.0), y: 1.5 }], { uScale: 5, vScale: 5 }), P.CONCRETE_DARK);
  B.face(loft([{ p: plan, y: 1.5 }, { p: plan, y: h }], B.wall()));
  // Colonnade wrapping the two street faces.
  const n = Math.max(5, Math.round(lw / 5.5));
  for (let i = 0; i < n; i++) {
    const x = bb.x0 + lw * (i + 0.5) / n;
    B.trim(cyl(0.78, h - 3.4, 12, x, 1.5, bb.z1 + 1.9), P.STUCCO_WHITE);
    B.trim(box(2.0, 0.5, 2.0, x, h - 1.9, bb.z1 + 1.9, 3), P.STUCCO_WHITE);
  }
  B.trim(box(lw + 5.2, 1.9, 4.6, 0, h - 1.4, bb.z1 + 1.6, 5), P.STUCCO_WHITE);  // entablature
  // Uplighting on the portico. Civic buildings are floodlit at night and the
  // warm wash is what stops the downtown core going black behind the towers.
  B.lit(box(lw + 4.4, 0.5, 0.5, 0, h - 2.1, bb.z1 + 3.6, 4), P.NEON_WHITE);
  B.trim(slabGeo(plan, h, 0.8, 1.6), P.STUCCO_WHITE);
  roofScape(B, offsetPlan(plan, -0.4), h + 0.8, r, { parapetHex: P.STUCCO_WHITE, tank: true });
  return h + 3;
}

/* ==================================================== block dispatch ==== */

const ROT = { s: 0, n: Math.PI, e: Math.PI / 2, w: -Math.PI / 2 };

/**
 * FOOTPRINT DISCIPLINE — measured, not assumed.
 *
 * Every building must stand inside the parcel it was handed with its base
 * flush to the pavement. Anything sprawling past the lot line is standing on
 * the kerb, the carriageway or a neighbour; and now that the consumption
 * physics measures the assembled geometry, an overhang ALSO makes the building
 * claim ground it is not standing on, so the hole has to eat further out than
 * the silhouette to take it. addMesh has already built every child's bounding
 * box by the time this runs, so reading them back is free.
 *
 * `fit` is the lot the building was drawn for, in the building's own frame.
 */
function onCarriageway(layout, x, z) {
  for (const r of layout.roadsX) if (Math.abs(x - r.pos) < r.half) return true;
  for (const r of layout.roadsZ) if (Math.abs(z - r.pos) < r.half) return true;
  return false;
}

const _footprint = new Map();
function auditFootprint(ctx, kind, root, world, fit) {
  let lo = null, hi = null;
  for (const m of root.children) {
    const bb = m.geometry.boundingBox;
    if (!bb) continue;
    if (!lo) { lo = bb.min.clone(); hi = bb.max.clone(); } else { lo.min(bb.min); hi.max(bb.max); }
  }
  if (!lo) return;
  const e = _footprint.get(kind) || { n: 0, road: 0, offGround: 0, over: 0, wet: 0 };
  e.n++;
  if (Math.abs(lo.y) > 0.2) e.offGround++;
  // Overhang past the lot line is expected — that is what an awning, a canopy
  // and an A-board are for. Crossing the KERB is not, so test the silhouette's
  // corners against the carriageway rather than against the lot. Deliberately
  // NOT layout.isRoad: that also counts the service alleys, and a rear awning
  // reaching a metre over the back lane it faces is the design, not a fault.
  const c = Math.cos(world.rot), s = Math.sin(world.rot);
  let onRoad = false, onWater = false;
  for (let i = 0; i < 4; i++) {
    const lx = i & 1 ? hi.x : lo.x, lz = i & 2 ? hi.z : lo.z;
    const wx = world.x + lx * c + lz * s, wz = world.z - lx * s + lz * c;
    if (onCarriageway(ctx.layout, wx, wz)) onRoad = true;
    if (ctx.layout.isWater(wx, wz)) onWater = true;
  }
  if (onRoad) e.road++;
  if (onWater) e.wet++;
  if (fit) {
    e.over = Math.max(e.over,
      +Math.max(Math.max(-lo.x, hi.x) - fit.lw / 2, Math.max(-lo.z, hi.z) - fit.ld / 2).toFixed(1));
  }
  _footprint.set(kind, e);
}

/**
 * Register a finished Build as a Consumable sitting exactly on the pavement.
 *
 * The `radius`/`height` the callers pass are the size they INTENDED. worldBuild
 * measures the assembled geometry and overrides them anyway, so the declared
 * pair only ever surfaces as noise in the prop audit — a tower declaring 105 m
 * against a real 186 m looks like a bug and is not one. Measure here too, from
 * the same child bounding boxes auditFootprint is about to read, and declare
 * what is actually there. Costs nothing: the boxes are already built.
 */
function register(ctx, group, B, world, radius, height, tier, kind, label, hex, fit) {
  const root = B.finish();
  root.position.set(world.x, ctx.Y_WALK, world.z);
  root.rotation.y = world.rot;
  let lo = null, hi = null;
  for (const m of root.children) {
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    const bb = m.geometry.boundingBox;
    if (!lo) { lo = bb.min.clone(); hi = bb.max.clone(); } else { lo.min(bb.min); hi.max(bb.max); }
  }
  if (lo) {
    radius = Math.hypot(hi.x - lo.x, hi.z - lo.z) / 2;
    height = Math.max(0.5, hi.y - lo.y);
  }
  ctx.addMesh(root, {
    parent: group,
    position: new THREE.Vector3(world.x, 0, world.z),
    radius, height, tier, kind, label,
    crumbles: true,
    debrisColor: hex,
  });
  ctx.occupy(world.x, world.z, radius * 0.92);
  if (!ctx.fadeableBuildings) ctx.fadeableBuildings = [];
  ctx.fadeableBuildings.push(root);
  auditFootprint(ctx, kind, root, world, fit);
  return root;
}

/**
 * Dry ground beyond a block edge, in metres, capped at `cap`.
 *
 * Sampled rather than derived from bayfront/riverwalk flags: those say the
 * BLOCK is near water, not which of its four lot lines the water is actually
 * on, and the seawall, the marina basins, the Key cut and the river bend all
 * meet the grid at different angles.
 */
function dryRun(layout, b, side, cap) {
  const alongX = side === 'n' || side === 's';
  const out = side === 'e' || side === 's' ? 1 : -1;
  let worst = cap;
  for (let i = 0; i <= 4; i++) {
    const t = (-0.5 + i / 4) * 0.98;
    for (let o = 0.5; o <= cap; o += 0.5) {
      const x = alongX ? b.x + t * b.w : b.x + out * (b.w / 2 + o);
      const z = alongX ? b.z + out * (b.d / 2 + o) : b.z + t * b.d;
      if (layout.isWater(x, z)) { worst = Math.min(worst, o - 0.5); break; }
    }
  }
  return worst;
}

/**
 * Dry promenade kept between the building line and open water. A lot line on
 * the seawall is a FRONTAGE, not a party wall — but `b.edges` only knows about
 * roads, so the bay side of a bayfront block read as "no neighbour here" and
 * got the 0.5-2 m party-wall gap. That is how Icon Brickell and the Bayfront
 * Amphitheatre ended up with their podium slabs out over Biscayne Bay.
 */
const SEAWALL = 4.0;

/** Buildable rectangle: generous pavement on street frontages, party walls
 *  (0.5-2 m) on the sides that only face an alley or a neighbour. */
function lotOf(ctx, b, r) {
  const sw = b.sidewalk || 5;
  const want = (side) => (b.edges && b.edges[side]
    ? Math.max(2.8, sw * (0.62 + r() * 0.36))
    : 0.5 + r() * 1.6);
  // The promenade a water-facing side has to keep, whatever else happens.
  const keep = (side) => {
    const dry = dryRun(ctx.layout, b, side, SEAWALL);
    return dry >= SEAWALL ? 0 : SEAWALL - dry;
  };
  const kn = keep('n'), ks = keep('s'), kw = keep('w'), ke = keep('e');
  let n = Math.max(want('n'), kn), s = Math.max(want('s'), ks);
  let w = Math.max(want('w'), kw), e = Math.max(want('e'), ke);
  // Brickell parcels are only 18-43 m deep. An unclamped 6 m setback on both
  // frontages leaves nothing to build on, which is how whole blocks ended up
  // as bare pavement. Cap the pair at a third of the parcel — but never below
  // the seawall promenade: on a spit too thin to hold both, the right answer is
  // an unbuildable lot (buildBuildings drops it), not a tower in the bay.
  const fit = (a, c, ma, mc, dim) => {
    const max = Math.max(ma + mc, dim * 0.34);
    const t = a + c;
    if (t <= max) return [a, c];
    const k = (max - ma - mc) / Math.max(1e-6, t - ma - mc);
    return [ma + (a - ma) * k, mc + (c - mc) * k];
  };
  [n, s] = fit(n, s, kn, ks, b.d);
  [w, e] = fit(w, e, kw, ke, b.w);
  return {
    x: b.x + (w - e) / 2,
    z: b.z + (n - s) / 2,
    w: b.w - w - e,
    d: b.d - n - s,
  };
}

/** Split a lot into `n` strips with a party-wall gap. Drives building count. */
function splitLot(lot, n, gap) {
  if (n <= 1) return [lot];
  const alongX = lot.w >= lot.d;
  const len = alongX ? lot.w : lot.d;
  const each = (len - gap * (n - 1)) / n;
  const out = [];
  for (let i = 0; i < n; i++) {
    const off = -len / 2 + each / 2 + i * (each + gap);
    out.push({
      x: alongX ? lot.x + off : lot.x,
      z: alongX ? lot.z : lot.z + off,
      w: alongX ? each : lot.w,
      d: alongX ? lot.d : each,
    });
  }
  return out;
}

/** World placement for a lot, given the frontage side. */
function place(lot, side) {
  const swap = side === 'e' || side === 'w';
  return {
    world: { x: lot.x, z: lot.z, rot: ROT[side] },
    lw: swap ? lot.d : lot.w,
    ld: swap ? lot.w : lot.d,
  };
}

/**
 * Tower renders stay MOSTLY light — a saturated 200 m slab dominates the whole
 * frame — but "mostly" is the operative word. A uniform-value skyline of cream
 * and teal is exactly as repetitive as a uniform-shape one, and the first pass
 * had no chromatic tower in it at all. Weighted, so coral and lilac appear a
 * few times across Brickell instead of on every third block.
 */
const TOWER_PASTELS = [
  [P.STUCCO_WHITE, 11], [P.STUCCO_CREAM, 9], [P.STUCCO_SAND, 6],
  [P.STUCCO_SKY, 12], [P.STUCCO_PEACH, 7], [P.STUCCO_MINT, 13],
  [P.STUCCO_AQUA, 13], [P.STUCCO_CORAL, 13], [P.STUCCO_PINK, 10],
  [P.STUCCO_LILAC, 9], [P.STUCCO_BUTTER, 6],
];

/**
 * Deco banding accents.
 *
 * RENDER_TRIM is eight shades of pale, so a mint block with a cream cornice and
 * a coral block with a cream cornice differ in exactly one colour — which is
 * why downtown reads as one continuous pale mass from the review camera however
 * many plan shapes are actually in it. Miami Deco banding is the other way
 * round: the BAND is the loud part. Kept off the wall itself, because a whole
 * saturated facade at this scale is a value hole, so this only ever lands on
 * cornices, string courses, balcony slabs and piers.
 */
const DECO_ACCENT = [
  [P.STUCCO_CORAL, 12], [P.STUCCO_SKY, 12], [P.STUCCO_BUTTER, 10],
  [P.TERRACOTTA, 7], [P.STUCCO_AQUA, 11], [P.STUCCO_PINK, 9],
  [P.STUCCO_LILAC, 8], [P.GLASS_TEAL, 7], [P.STUCCO_MINT, 9], [P.BRICK_LIGHT, 5],
];

/** An accent that is not the wall it is going on — a coral band on a coral
 *  building is a band you cannot see. */
function accentFor(r, wallHex) {
  for (let i = 0; i < 4; i++) {
    const h = r.weighted(DECO_ACCENT);
    if (h !== wallHex) return h;
  }
  return P.STUCCO_WHITE;
}

/** Cornices, string courses, balcony slabs and piers on painted render. */
const RENDER_TRIM = [
  [P.STUCCO_WHITE, 22], [P.CONCRETE_WARM, 18], [P.CONCRETE, 12],
  [P.PRECAST, 11], [P.STUCCO_CREAM, 11], [P.STUCCO_SAND, 9],
  [P.MULLION, 8], [P.TERRACOTTA, 5],
];
/**
 * Midrise render colours.
 *
 * TERRACOTTA and the two brick tones are in here deliberately: the pastel set
 * on its own gave downtown a uniform VALUE as well as a uniform shape, so a
 * block of six midrises read as one pale mass however many plans it contained.
 * A warm masonry building every few parcels is what Overtown and the older
 * Flagler stock actually look like, and it is the only dark note the low city
 * has. They still go through the stucco skin, so they keep punched windows that
 * light at night — a brick texture would have none.
 */
const STUCCO_SET = [
  P.STUCCO_PINK, P.STUCCO_CORAL, P.STUCCO_CREAM, P.STUCCO_LILAC,
  P.STUCCO_AQUA, P.STUCCO_MINT, P.STUCCO_BUTTER, P.STUCCO_PEACH,
  // BRICK_LIGHT, not TERRACOTTA: through the stucco texture's warm balance the
  // deeper terracotta rendered as dark khaki at tower scale — a muddy mid,
  // which the bible bans outright. BRICK_LIGHT keeps the warm masonry note and
  // stays on the bright side of the grade.
  P.STUCCO_SAND, P.STUCCO_SKY, P.BRICK_LIGHT, P.STUCCO_WHITE,
];
const SHOP_SET = [
  P.STUCCO_CREAM, P.STUCCO_PINK, P.STUCCO_AQUA, P.STUCCO_PEACH, P.STUCCO_WHITE,
  P.STUCCO_MINT, P.STUCCO_BUTTER, P.STUCCO_LILAC, P.STUCCO_CORAL, P.STUCCO_SAND,
];

export function buildBuildings(ctx) {
  const { layout } = ctx;
  const group = ctx.group('buildings');
  if (!ctx.fadeableBuildings) ctx.fadeableBuildings = [];
  installNightCycle(ctx.scene);

  // Several hand-placed heroes (the arena, Government Center, the amphitheatre)
  // land on blocks the zoner had already called MIDRISE or PLAZA. Match on the
  // landmark NAME so they still get their bespoke geometry — matching on style
  // alone would also catch ordinary Deco infill that happens to sit in a park.
  const heroes = new Set(layout.landmarks.map((l) => l.name));

  _footprint.clear();
  let count = 0;

  for (const b of layout.blocks) {
    const r = makeRNG(b.seed ^ 0x9e37);
    const side = b.frontage || 's';
    const lot = lotOf(ctx, b, r);
    if (lot.w < 7 || lot.d < 7) continue;

    // STUCCO belongs on this list: the Riverwalk Market is the one hero the
    // zoner leaves as ZONE.RETAIL, so without it the block fell through to the
    // ordinary shop row, the market hall never rendered anywhere in the city,
    // and landmarkBlock's STUCCO branch was unreachable code.
    if (b.landmark && heroes.has(b.landmark)
        && (b.style === STYLE.ARENA || b.style === STYLE.CIVIC
            || b.style === STYLE.DECO || b.style === STYLE.STUCCO)) {
      count += landmarkBlock(ctx, group, b, r, lot, side);
      continue;
    }

    switch (b.zone) {
      case ZONE.TOWER:
        count += towerBlock(ctx, group, b, r, lot, side, false);
        break;
      case ZONE.LANDMARK:
        count += landmarkBlock(ctx, group, b, r, lot, side);
        break;
      case ZONE.MIDRISE:
        count += midriseBlock(ctx, group, b, r, lot, side);
        break;
      case ZONE.RETAIL:
      case ZONE.LOWRISE:
        count += retailBlock(ctx, group, b, r, lot, side);
        break;
      case ZONE.PARKING:
        count += parkingBlock(ctx, group, b, r, lot, side);
        break;
      case ZONE.CONSTRUCTION:
        count += constructionBlock(ctx, group, b, r, lot, side);
        break;
      default:
        break;   // park / plaza / marina belong to nature + water
    }
  }

  const rows = [..._footprint.entries()];
  const bad = rows.filter(([, e]) => e.road || e.offGround || e.wet)
    .map(([k, e]) => `${k}: ${e.road}/${e.n} over the carriageway`
      + (e.offGround ? `, ${e.offGround} not flush to the pavement` : '')
      + (e.wet ? `, ${e.wet} over water` : ''));
  // Per kind, not a single global maximum: one 4 m arena canopy used to hide
  // every other kind's reach behind it, which is exactly the number you need
  // when you are trying to work out WHICH builder is crossing its lot line.
  const reach = rows.map(([k, e]) => `${k} ${e.over}`).join(' ');
  console.info(`[buildings] ${count} buildings | `
    + (bad.length ? `FOOTPRINT: ${bad.join('; ')}`
      : 'all on the pavement, none over the carriageway, none over water')
    + ` | reach past the lot line, m: ${reach}`);

  /* Cost report. Buildings cannot be merged with each other — each one has to
     be separately swallowable — so this module IS the city's draw-call floor
     and the number needs to be visible every boot, not measured after a
     regression. Triangles here are the scene's, not the frame's: shadow passes
     draw the same geometry again. */
  let tris = 0, meshes = 0;
  for (const root of ctx.fadeableBuildings) {
    for (const m of root.children) {
      meshes++;
      const g = m.geometry;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    }
  }
  console.info(`[buildings] ${meshes} meshes / ${(tris / 1e6).toFixed(2)}M triangles `
    + `| ${_nightMats.length} night-driven materials`);
}

/* ------------------------------------------------------------ towers --- */

/**
 * PLAN PROPORTION.
 *
 * The old code handed the tower `lotW * fill` by `lotD * fill`, so every shaft
 * inherited the proportion of its parcel — and Brickell's parcels are all
 * roughly the same shape, which is why the first pass rendered a comb of
 * identically-proportioned shafts. Drawing the proportion separately is the
 * single cheapest anti-repetition move available: the same lot now yields a
 * point tower, a wide slab or a deep bar depending on nothing but the seed.
 *
 * Each entry is [name, [xFraction, zFraction], weight].
 */
/** Height bands in metres. See the band draw in towerBlock. */
const TOWER_BANDS = [[34, 60], [58, 94], [92, 142], [138, 218]];

const TOWER_PROPORTION = [
  ['square', [0.96, 0.96], 22],
  ['slab', [1.00, 0.54], 20],   // wide frontage, thin: the Brickell condo
  ['bar', [0.56, 1.00], 14],    // deep and narrow, gable to the street
  ['point', [0.66, 0.66], 20],  // small footprint, goes up
  ['stub', [0.92, 0.78], 12],   // squat and broad
  ['sliver', [0.90, 0.42], 12], // razor slab — only ever a few of these
];

function towerBlock(ctx, group, b, r, lot, side, isLandmark) {
  let made = 0;
  const h = Math.max(42, b.heightM || b.floors * STOREY);
  // A wide lot gets a low retail annex alongside the tower — that is what
  // stops every Brickell block being one lonely shaft on an empty slab, and it
  // is the only thing giving the skyline a BASE. The old threshold (30 x 52 m)
  // almost never fired, because Brickell parcels are 18-43 m deep.
  const wide = Math.min(lot.w, lot.d) > 24 && Math.max(lot.w, lot.d) > 46;
  let towerLot = lot, annexLot = null;
  if (wide && r.chance(0.52)) {
    // The tower keeps two thirds and the annex is a 9-22 m liner. An even split
    // (what splitLot gives) halved the shaft's frontage, and a comb of needles
    // is the last thing this skyline needs more of — the annex exists to put
    // low mass BETWEEN the towers, not to make the towers thinner.
    const alongX = lot.w >= lot.d;
    const len = alongX ? lot.w : lot.d;
    const gap = 1.8;
    const aLen = Math.max(9, Math.min(len * 0.33, 22));
    const tLen = len - aLen - gap;
    const s = r.chance(0.5) ? 1 : -1;
    const tOff = -s * (gap + aLen) / 2;
    const aOff = s * (tLen + gap) / 2;
    towerLot = alongX ? { x: lot.x + tOff, z: lot.z, w: tLen, d: lot.d }
      : { x: lot.x, z: lot.z + tOff, w: lot.w, d: tLen };
    annexLot = alongX ? { x: lot.x + aOff, z: lot.z, w: aLen, d: lot.d }
      : { x: lot.x, z: lot.z + aOff, w: lot.w, d: aLen };
  }

  const pl = place(towerLot, side);
  const hp = b.heightPotential ?? 0.5;
  let wanted;
  if (isLandmark) {
    // A hero is the height it is named for. Only the lottery's top end applies.
    wanted = h * Math.max(0.95, 0.28 + 0.42 * hp + Math.pow(r(), 2.4) * (0.5 + 0.7 * hp));
  } else {
    /*
     * SKYLINE RHYTHM — a BAND draw, not a multiplier on the height field.
     *
     * cityLayout's field is deliberately smooth so the massing reads as a ridge
     * along Brickell Ave, and the old code multiplied it by a single smooth
     * lottery. Both inputs being smooth is exactly why the ridge rendered as a
     * picket fence (anti-pattern #7): every parcel drew from the same narrow
     * band around 0.8x the same field value, so thirty towers came out within
     * a few storeys of one another and nothing punctuated them.
     *
     * Now the field only biases WHICH band a parcel draws from; the metres come
     * from inside the band. That is what a real downtown looks like from the
     * bay — clusters of supertalls with genuinely low, chunky infill wedged
     * between them, not a comb. `h` still caps it, so a parcel the zoner called
     * low can never sprout a 200 m shaft.
     */
    const w = [
      6 + 40 * (1 - hp) * (1 - hp),        // 34-58 m: the punctuation
      16 + 26 * (1 - Math.abs(hp - 0.45) * 1.6),
      8 + 46 * hp * hp,
      Math.max(0, 62 * (hp - 0.42)),       // 140 m+: only on the ridge
    ];
    const band = r.weighted([[0, w[0]], [1, w[1]], [2, w[2]], [3, w[3]]]);
    const span = TOWER_BANDS[band];
    // Squared draw inside the band so the middle of each is denser than its
    // edges and the four bands blend into one continuous population.
    wanted = span[0] + (span[1] - span[0]) * (0.5 * (r() + r()));
    wanted = Math.min(wanted, Math.max(34, h * 1.15));
  }
  /*
   * How much of the parcel the shaft takes.
   *
   * Inverted from the original curve. Tall towers were made the WIDEST, which
   * is structurally sensible and visually the wrong way round: it produced a
   * skyline of tall-and-broad shafts with nothing chunky and low between them.
   * A 40 m building that fills its lot reads as a mass; the same 40 m on 78% of
   * it reads as a stub of a tower. Slenderness at the top end is still policed
   * by `slender` below, so nothing turns into a needle.
   */
  const fill = wanted < 70
    ? 0.92 - 0.05 * (wanted / 70)
    : 0.87 - 0.09 * Math.min(1, (wanted - 70) / 150);

  const prop = r.weighted(TOWER_PROPORTION.map((e) => [e, e[2]]));
  let sw = pl.lw * fill * prop[1][0];
  let sd = pl.ld * fill * prop[1][1];
  // A shaft narrower than about 11 m is a needle, not a building, and its roof
  // cannot carry any of the plant the 3/4 camera expects to find up there.
  sw = Math.max(Math.min(11, pl.lw * fill), sw);
  sd = Math.max(Math.min(11, pl.ld * fill), sd);
  // Slenderness reads off the geometric mean, not the short side: a 40x14 slab
  // is a perfectly stable 150 m building and clamping it on its 14 m depth was
  // capping exactly the shapes that make a skyline interesting.
  const slender = Math.sqrt(sw * sd) * 11.5;
  const hCap = Math.max(30, Math.min(wanted, slender));
  // Short towers lean masonry: a 45 m glass box is the least interesting thing
  // this file can make, and a pastel one is exactly the Miami note the low half
  // of the skyline was missing.
  const masonry = b.style === STYLE.TOWER
    || (!isLandmark && r.chance(hCap < 80 ? 0.52 : 0.27));
  let podH = b.hasPodium ? Math.max(7, b.podiumH) : (r.chance(0.55) ? 6 + r() * 6 : 0);
  // An 18 m podium under a 34 m tower is a plinth wearing a hat. Half the
  // building at most, and below that it is honestly just a building.
  if (podH > hCap * 0.5) podH = hCap > 26 ? Math.max(6, hCap * 0.40) : 0;
  const neon = r.pick(NEON_SET);
  // An unlit Miami skyline at night is the thing to avoid, and a crown that
  // does not light is a black cutout against the sky. Anything with a top worth
  // seeing gets one; the rest still light their windows off the emissive map.
  const litIt = isLandmark || hCap > 110 || r.chance(0.58);
  // One base palette per building, shared by the podium, the lobby and the
  // wing, so a tower's ground floor reads as one piece of architecture.
  const pal = r.weighted(BASE_PALETTES);
  // Chosen here, not inside tower(): the wing is glazed off the SAME curtain
  // wall as the shaft, and a Build can only carry one glass material.
  const gTint = r.pick(GLASS_TINTS);
  const gGrid = r.int(0, CW_GRIDS.length - 1);

  /* A lower wing beside the shaft. Combined the two masses still fill the
     parcel, so the measured footprint stays centred on the parcel — see the
     note on `o.shift` in tower(). */
  const canWing = Math.min(sw, sd) > 14 && pl.lw > 34 && prop[0] !== 'sliver';
  const wing = canWing && r.chance(0.30);
  let shift = 0, wingW = 0, wingSide = 1;
  if (wing) {
    wingSide = r.chance(0.5) ? 1 : -1;
    wingW = pl.lw * 0.30;
    // 3.4 m, not 1.5: the shaft now grows a lobby up to 1.5 m past its own plan
    // and the wing grows a ground floor of its own, so a party gap the width of
    // one of them put the two bases inside each other.
    sw = Math.min(sw, pl.lw * fill - wingW - 3.4);
    shift = -wingSide * (pl.lw * fill / 2 - sw / 2);
  }

  if (masonry) {
    const hex = r.weighted(TOWER_PASTELS);
    const MB = new Build(stuccoSkin(hex), neon, r);
    if (wing) {
      wingBlock(MB, r, wingSide * (pl.lw * fill / 2 - wingW / 2), wingW, sd * 0.94,
        hCap * (0.22 + r() * 0.18), P.STUCCO_WHITE, null, pal);
    }
    const mt = resiTower(ctx, MB, r, sw, sd, hCap, {
      podiumH: wing ? 0 : podH, lit: litIt, shift, pal,
      lotW: pl.lw, lotD: pl.ld,
      trimHex: r.chance(0.30) ? accentFor(r, hex)
        : (r.chance(0.45) ? P.STUCCO_WHITE : P.CONCRETE_WARM),
      helipad: hCap > 130 && r.chance(0.4),
    });
    register(ctx, group, MB, pl.world, Math.max(pl.lw, pl.ld) * 0.5, mt,
      hCap > 120 || isLandmark ? TIER.LANDMARK : TIER.MASSIVE, 'tower',
      b.landmark || 'Residential Tower', hex, { lw: pl.lw, ld: pl.ld });
    made++;
    if (annexLot) made += annex(ctx, group, r, annexLot, side);
    return made;
  }

  const B = new Build(trimSkin(), neon);
  const twin = pl.lw > 46 && !wing && r.chance(0.34);
  let top;
  if (twin) {
    // Two shafts on one shared podium: one consumable, two silhouettes.
    const tw = pl.lw * 0.42, td = Math.min(pl.ld * 0.86, tw * 1.15);
    const pp = rectPlan(pl.lw, pl.ld, Math.min(pl.lw, pl.ld) * 0.09);
    const gt = gTint;
    B.glassMat = curtainMat(gt, gGrid);
    podium(B, pp, podH || 10, r, curtainMat(gt, gGrid), { neon, pal });
    roofScape(B, offsetPlan(pp, -1.8), (podH || 10) + 0.05, r, {
      tank: false, parapetH: 1.0, avoid: rectPlan(pl.lw * 0.9, pl.ld * 0.9, 0),
    });
    top = 0;
    // Deliberately unequal: two shafts the same height is a tuning fork, and
    // the pair that reads as one building is the one where they differ.
    const hs = [1, 0.58 + r() * 0.30];
    let i = 0;
    for (const dx of [-1, 1]) {
      const sub = new Build(trimSkin(), neon);
      sub.skinGeo = B.skinGeo; sub.glassGeo = B.glassGeo; sub.litGeo = B.litGeo;
      sub.glassMat = B.glassMat; sub.litHex = B.litHex;
      const t = towerShaftAt(ctx, sub, r, dx * pl.lw * 0.24, 0, tw, td,
        Math.max(36, hCap * hs[i++]), podH || 9, gt, isLandmark, gGrid);
      B.glassMat = sub.glassMat; B.litHex = sub.litHex;
      top = Math.max(top, t);
    }
  } else {
    if (wing) {
      wingBlock(B, r, wingSide * (pl.lw * fill / 2 - wingW / 2), wingW, sd * 0.94,
        hCap * (0.20 + r() * 0.16), r.weighted(ACCENT_TRIM), curtainMat(gTint, gGrid), pal);
    }
    top = tower(ctx, B, r, sw, sd, hCap, {
      podium: !wing && podH > 2, podiumH: wing ? 0 : podH,
      lit: litIt, shift, lotW: pl.lw, lotD: pl.ld, pal,
      glassTint: gTint, glassGrid: gGrid,
      helipad: hCap > 130 && r.chance(0.55),
    });
  }

  register(ctx, group, B, pl.world, Math.max(pl.lw, pl.ld) * 0.5, top,
    hCap > 120 || isLandmark ? TIER.LANDMARK : TIER.MASSIVE, 'tower',
    b.landmark || 'Glass Tower', P.GLASS_TEAL, { lw: pl.lw, ld: pl.ld });
  made++;

  if (annexLot) made += annex(ctx, group, r, annexLot, side);
  return made;
}

/**
 * The lower wing that sits beside a shaft. Same building, same consumable —
 * this is massing, not a second structure — but it turns a single extruded
 * prism into something with a shoulder, which is what most real towers have.
 *
 * WHY IT IS NOT A `trim` VOLUME ANY MORE.
 * Trim geometry pins its UVs to one flat texel — that is the whole reason a
 * coloured cornice costs no extra draw call, and it is also why a wall built
 * that way can never have a window in it. A 60-90 m wing made of trim was a
 * literally featureless pale prism standing beside its tower: art-bible
 * anti-pattern #3, and the loudest defect in the Brickell skyline frame. A
 * glass tower's wing is now glazed off the shaft's own curtain wall, which is
 * free because that mesh already exists; a masonry tower's wing is `face`, so
 * it gets the punched windows its stucco skin already paints.
 */
function wingBlock(B, rng, x, w, d, h, hex, glassMat, pal) {
  const plan = movePlan(rectPlan(w, d, Math.min(w, d) * 0.14), x, 0);
  const bb = planBounds(plan);
  const base = Math.min(6.0, h * 0.24);
  const p = pal || BASE_PAL_DEFAULT;

  /* Ground floor. The wing meets the pavement as much as the shaft does. */
  B.trim(loft([{ p: plan, y: 0 }, { p: plan, y: 0.45 }], { uScale: 5, vScale: 5 }), P.CONCRETE_DARK);
  B.trim(loft([{ p: offsetPlan(plan, -0.5), y: 0.45 }, { p: offsetPlan(plan, -0.5), y: base }],
    { uScale: 4, vScale: 4 }), P.SPANDREL);
  fins(B, plan, 0.45, base + 0.3, Math.max(5, Math.round(planPerimeter(plan) / 7)), 0.7, p.pier);
  B.trim(slabGeo(plan, base, 0.55, 0.55), p.band);
  if (w > 9) awning(B, Math.min(w * 0.5, 7), base - 1.3, bb.z1, 1.5, 0.5, p.canopy, x);

  /* Shaft. */
  if (glassMat) {
    B.gl(loft([{ p: offsetPlan(plan, -0.32), y: base + 0.55 }, { p: offsetPlan(plan, -0.32), y: h }],
      { uScale: CW_U, vScale: CW_V }), glassMat);
    for (let yy = base + STOREY; yy < h - 1; yy += STOREY) {
      B.trim(slabGeo(plan, yy, 0.34, 0.28), P.CONCRETE_WARM);
    }
    fins(B, plan, base + 0.55, h, Math.max(6, Math.round(planPerimeter(plan) / 5.5)), 0.42, hex);
  } else {
    B.face(loft([{ p: plan, y: base + 0.55 }, { p: plan, y: h }],
      B.wall()));
    balconyStack(B, plan, base + STOREY, h - 1, STOREY * 2, 0.9, hex, P.GLASS_SKY,
      rng.weighted(BALCONY_MODES));
  }
  B.trim(slabGeo(plan, h, 0.5, 0.7), P.CONCRETE_WARM);
  roofScape(B, offsetPlan(plan, 0.2), h + 0.5, rng, {
    tank: false, parapetH: 1.0, pool: rng.chance(0.5), sign: rng.chance(0.4),
    deck: rng.chance(0.55),
  });
}

/** Low pastel block sharing a tower's parcel. Fills the lot, breaks the base. */
function annex(ctx, group, r, lot, side) {
  const ap = place(lot, side);
  if (ap.lw < 8 || ap.ld < 8) return 0;
  const hex = r.pick(STUCCO_SET);
  const AB = new Build(stuccoSkin(hex), r.pick(NEON_SET), r);
  const ah = 9 + r() * 16;
  const top = midrise(ctx, AB, r, ap.lw, ap.ld, ah, { deco: r.chance(0.45), wallHex: hex });
  register(ctx, group, AB, ap.world, Math.max(ap.lw, ap.ld) * 0.5, top,
    TIER.MASSIVE, 'midrise', 'Podium Annex', hex, { lw: ap.lw, ld: ap.ld });
  return 1;
}

/** Shaft-only variant used by the twin-tower case (shares one Build). */
function towerShaftAt(ctx, B, r, ox, oz, w, d, h, y0, gt, isLandmark, grid = 1) {
  const cm = curtainMat(gt, grid);
  const kind = r.weighted(PLAN_MENU);
  const plan = movePlan(shaftPlan(r, w, d, kind, r()), ox, oz);
  const smooth = kind === 'ellipse' || kind === 'bow' || kind === 'lens';
  B.gl(loft([{ p: plan, y: y0 }, { p: plan, y: h }], { uScale: CW_U, vScale: CW_V, smooth }), cm);
  if (r.chance(0.55)) {
    balconyStack(B, plan, y0 + 3.4, h, STOREY * 2, 1.2, P.CONCRETE_WARM,
      P.GLASS_SKY, r.weighted(BALCONY_MODES));
  } else if (r.chance(0.5)) {
    briseSoleil(B, plan, y0 + STOREY, h, STOREY * 1.5, 0.85, P.MULLION);
  } else {
    fins(B, plan, y0 + 1, h, 8, 0.5, P.MULLION);
  }
  // The two shafts of a pair must not wear the same hat; that is the whole
  // reason for building them as one object instead of two.
  return crown(B, plan, h, r, { lit: isLandmark || r.chance(0.5), kind: r.weighted(CROWN_MENU) });
}

/* ----------------------------------------------------------- midrise --- */

function midriseBlock(ctx, group, b, r, lot, side) {
  // Real blocks carry several buildings; one slab per parcel is the single
  // biggest reason a procedural city reads as procedural.
  const long = Math.max(lot.w, lot.d);
  const short = Math.min(lot.w, lot.d);
  // Several buildings per block. One slab per parcel is the loudest possible
  // "generated city" tell, and it flattens the skyline into a comb.
  const n = long > 54 ? 3 : long > 26 ? 2 : 1;
  // splitLot cuts the long axis, which on a parcel that is long across its own
  // frontage stacks the units FRONT TO BACK — and every one of them still draws
  // its ground-floor awning on its own front face. That canopy projects ~2 m,
  // far more than the balcony allowance midrise() reserves, so the rear unit's
  // awning was ending up inside the building in front of it. Give it room.
  const stacked = (lot.w >= lot.d) === (side === 'e' || side === 'w');
  const parts = splitLot(lot, short < 15 ? Math.min(n, 2) : n,
    Math.max(stacked ? 2.4 : 1.0, 1.0 + r() * 1.8));
  let made = 0;
  for (const part of parts) {
    if (part.w < 7.5 || part.d < 7.5) continue;
    const pl = place(part, side);
    const hex = r.pick(STUCCO_SET);
    const B = new Build(stuccoSkin(hex), r.pick(NEON_SET), r);
    const h = Math.max(11, (b.floors + r.int(-2, 3)) * STOREY * (0.85 + r() * 0.3));
    // Full strip, no safety fudge: midrise() now draws its structural plan
    // inside the width it is handed, so the 5% haircut that used to absorb the
    // balcony overhang only shrank the block's built frontage for nothing.
    const top = midrise(ctx, B, r, pl.lw, pl.ld, h, {
      deco: b.style === STYLE.DECO || r.chance(0.35), wallHex: hex,
    });
    register(ctx, group, B, pl.world, Math.max(pl.lw, pl.ld) * 0.5, top,
      TIER.MASSIVE, 'midrise',
      r.chance(0.5) ? 'Apartment Block' : 'Office Block', hex, { lw: pl.lw, ld: pl.ld });
    made++;
  }
  return made;
}

/* ------------------------------------------------------------ retail --- */

function retailBlock(ctx, group, b, r, lot, side) {
  const swap = side === 'e' || side === 'w';
  const lw = swap ? lot.d : lot.w;
  const ld = swap ? lot.w : lot.d;
  if (lw < 8) return 0;

  // Uneven unit widths: a comb of identical shops is an instant fail.
  // A deep parcel gets a second row backing onto the service alley, which is
  // both how a real block works and what stops the middle reading as bare slab.
  const rear = ld > 30 && r.chance(0.72);
  const frontD = rear ? ld * (0.46 + r() * 0.08) : Math.max(10, ld * (0.74 + r() * 0.24));
  let made = 0;
  made += shopStrip(ctx, group, b, r, lot, side, lw, ld, frontD, (ld - frontD) / 2, false);
  if (rear) {
    const rearD = ld - frontD - 3.0;
    if (rearD > 9) made += shopStrip(ctx, group, b, r, lot, side, lw, ld, rearD, -(ld - rearD) / 2, true);
  }
  return made;
}

/** One run of shopfronts along the parcel, at local z offset `dz`. */
function shopStrip(ctx, group, b, r, lot, side, lw, ld, depth, dz, isRear) {
  const widths = [];
  let left = lw;
  while (left > 7.0) {
    let uw = 7.0 + r() * 7.4;
    if (left - uw < 7.0) uw = left;
    widths.push(Math.min(uw, left));
    left -= Math.min(uw, left);
  }
  if (!widths.length) widths.push(lw);

  const c = Math.cos(ROT[side]), s = Math.sin(ROT[side]);
  let cur = -lw / 2;
  let made = 0;
  for (const uw of widths) {
    const localX = cur + uw / 2;
    cur += uw;
    const wx = lot.x + localX * c + dz * s;
    const wz = lot.z - localX * s + dz * c;
    const h = (r.chance(0.4) ? 1 : r.chance(0.62) ? 2 : 3) * 5.0 + r() * 1.4;
    const hex = r.pick(SHOP_SET);
    shopUnit(ctx, group, b, r, { x: wx, z: wz, rot: isRear ? ROT[side] + Math.PI : ROT[side] },
      uw - 0.35, depth, h, hex, { label: r.pick(SHOP_LABELS) });
    made++;
  }
  return made;
}

const SHOP_LABELS = ['Café', 'Bodega', 'Boutique', 'Barber Shop', 'Taqueria',
  'Pharmacy', 'Juice Bar', 'Gallery', 'Cuban Bakery', 'Surf Shop'];

/* ----------------------------------------------------------- parking --- */

function parkingBlock(ctx, group, b, r, lot, side) {
  const pl = place(lot, side);
  // Downtown builds decks; the low-rise fringe leaves it as a surface lot.
  const deck = b.floors >= 4 || r.chance(0.55);
  if (deck && Math.min(pl.lw, pl.ld) > 16) {
    garage(ctx, group, b, r, pl.world, pl.lw * 0.94, pl.ld * 0.94,
      Math.max(3, Math.min(7, b.floors)));
  } else {
    surfaceLot(ctx, group, b, r, pl.world, pl.lw * 0.96, pl.ld * 0.96);
  }
  return 1;
}

/* ------------------------------------------------------ construction --- */

function constructionBlock(ctx, group, b, r, lot, side) {
  const pl = place(lot, side);
  const h = Math.max(12, b.floors * 3.6 * (0.6 + r() * 0.5));
  // The lot dimensions go in as well: the site is 78% of the parcel but the
  // hoarding is drawn 1.7 m outside the site, which on a small lot put the
  // fence itself on the pavement.
  construction(ctx, group, b, r, pl.world, pl.lw * 0.78, pl.ld * 0.78, h, pl.lw, pl.ld);
  return 1;
}

/* --------------------------------------------------------- landmarks --- */

function landmarkBlock(ctx, group, b, r, lot, side) {
  const fp = b.footprint || { w: lot.w * 0.8, d: lot.d * 0.8 };
  const useLot = { x: lot.x, z: lot.z, w: Math.min(lot.w, fp.w), d: Math.min(lot.d, fp.d) };
  const pl = place(useLot, side);
  const h = Math.max(18, b.heightM || b.floors * STOREY);
  const style = b.style;

  if (style === STYLE.ARENA) {
    const B = new Build(trimSkin(), P.NEON_PINK);
    // 0.96, not 1.02: the drum carries a 0.6 m plinth outside the plan, so
    // drawing it oversize started the building already past the parcel line.
    const top = arena(ctx, B, r, pl.lw * 0.96, pl.ld * 0.96, h);
    register(ctx, group, B, pl.world, Math.max(pl.lw, pl.ld) * 0.55, top,
      TIER.LANDMARK, 'landmark', b.landmark || 'Arena', P.PRECAST, { lw: pl.lw, ld: pl.ld });
    return 1;
  }
  if (style === STYLE.CIVIC) {
    const hex = r.pick([P.STUCCO_SAND, P.STUCCO_CREAM, P.STUCCO_WHITE]);
    const B = new Build(stuccoSkin(hex), P.NEON_WHITE, r);
    const top = civicBlock(ctx, B, r, pl.lw * 0.96, pl.ld * 0.96, Math.min(h, 34));
    register(ctx, group, B, pl.world, Math.max(pl.lw, pl.ld) * 0.55, top,
      TIER.LANDMARK, 'landmark', b.landmark || 'Civic Hall', hex, { lw: pl.lw, ld: pl.ld });
    return 1;
  }
  if (style === STYLE.DECO) {
    const hex = r.pick([P.STUCCO_CREAM, P.STUCCO_SAND, P.STUCCO_WHITE]);
    const B = new Build(stuccoSkin(hex), P.NEON_YELLOW, r);
    const top = decoTower(ctx, B, r, pl.lw * 0.9, pl.ld * 0.9, h);
    register(ctx, group, B, pl.world, Math.max(pl.lw, pl.ld) * 0.5, top,
      TIER.LANDMARK, 'landmark', b.landmark || 'Deco Tower', hex, { lw: pl.lw, ld: pl.ld });
    return 1;
  }
  if (style === STYLE.STUCCO) {
    // Market hall: a vaulted shed, low and wide.
    const hex = r.pick(SHOP_SET);
    const B = new Build(stuccoSkin(hex), r.pick(NEON_SET), r);
    const plan = rectPlan(pl.lw * 0.94, pl.ld * 0.94, 1.4);
    const bb = planBounds(plan);
    B.face(loft([{ p: plan, y: 0 }, { p: plan, y: Math.max(6, h * 0.6) }], B.wall()));
    const hh = Math.max(6, h * 0.6);
    B.trim(loft([
      { p: plan, y: hh }, { p: offsetPlan(plan, -1.6), y: hh + 1.8 }, { p: offsetPlan(plan, -5.0), y: hh + 3.4 },
    ], { uScale: 6, vScale: 6, capTop: true }), P.TERRACOTTA);
    awning(B, pl.lw * 0.84, 4.0, bb.z1, 2.6, 0.7, P.FABRIC_CORAL);
    B.trim(box(pl.lw * 0.9, 0.3, 3.0, 0, 4.2, bb.z1 + 1.5, 4), P.FABRIC_CORAL);
    channelSign(B, 0, 5.4, bb.z1 + 0.2, pl.lw * 0.44, 1.8, 0, r, B.neon, false);
    register(ctx, group, B, pl.world, Math.max(pl.lw, pl.ld) * 0.5, hh + 4,
      TIER.MASSIVE, 'landmark', b.landmark || 'Market Hall', hex, { lw: pl.lw, ld: pl.ld });
    return 1;
  }
  // STYLE.GLASS / STYLE.TOWER — hero towers.
  return towerBlock(ctx, group, b, r, useLot, side, true);
}
