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
  P.GLASS_TEAL, P.GLASS_SKY, P.GLASS_SMOKE,
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

/** Move a convex plan outward (o>0) or inward (o<0) along its bisectors. */
function offsetPlan(p, o) {
  const n = p.length, out = [];
  if (o < 0) {
    // An inset deeper than the inradius folds the polygon into a star. Every
    // caller derives its inset from a facade dimension, so clamp rather than
    // ask them all to check.
    const bb = planBounds(p);
    o = Math.max(o, -0.42 * Math.min(bb.w, bb.d));
  }
  for (let i = 0; i < n; i++) {
    const a = edgeN(p[(i - 1 + n) % n], p[i]);
    const b = edgeN(p[i], p[(i + 1) % n]);
    let mx = a[0] + b[0], mz = a[1] + b[1];
    const L = Math.hypot(mx, mz) || 1;
    mx /= L; mz /= L;
    // 1/cos(half-angle) so a chamfer corner moves out as far as its faces do.
    const k = o / Math.max(0.4, mx * a[0] + mz * a[1]);
    out.push([p[i][0] + mx * k, p[i][1] + mz * k]);
  }
  return out;
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
function makeSkin(tex, fu, fv, uScale, vScale, matOpts, awn = false) {
  const base = sampleLinear(tex, fu, fv);
  const mat = solid({ map: tex, vertexColors: true, ...matOpts });
  const cache = new Map();
  return {
    mat, fu, fv, uScale, vScale, awn,
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

/** Painted render with punched windows. 6 bays x 8 floors per tile. */
function stuccoSkin(hex) {
  return skin(`st${hex}`, () => makeSkin(
    Textures.stucco(hex, 8, 6), 8 / 512, 1 - 8 / 512, 6 * 3.3, 8 * STOREY,
    { roughness: 0.78 }
  ));
}

/** Shopfront. One tile = one shop unit wide, one storey tall. */
function shopSkin(hex) {
  return skin(`sh${hex}`, () => makeSkin(
    Textures.storefront(hex), 0.5, 1 - 492 / 512, 9, 5.0, { roughness: 0.7 }, true
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

const CURTAIN = new Map();
function curtainMat(tint) {
  let m = CURTAIN.get(tint);
  if (!m) {
    m = glass({ map: Textures.glass(tint, 10, 10, 512), roughness: 0.16, metalness: 0.74, color: 0xffffff });
    CURTAIN.set(tint, m);
  }
  return m;
}
/** Curtain-wall tile size in metres — must match Textures.glass(_,10,10). */
const CW_U = 15, CW_V = 35;

/* ============================================================ Build ===== */

/**
 * Accumulates one building's geometry and collapses it to the fewest meshes
 * that can express it. `face` keeps real texture UVs; `trim` pins to the flat
 * texel and tints; `band` keeps authored UVs (used for the awning stripe band).
 */
class Build {
  constructor(sk) {
    this.sk = sk;
    this.skinGeo = [];
    this.glassGeo = [];
    this.glassMat = null;
    this.litGeo = [];
    this.litHex = null;
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
      mk(this.litGeo, solid({
        map: this.sk.mat.map, vertexColors: true, roughness: 0.4,
        emissive: this.litHex, emissiveIntensity: 1.9, toneMapped: false,
      }));
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

function rooftopPool(B, x, y, z, w, d, r) {
  B.trim(box(w + 2.4, 0.22, d + 2.4, x, y, z, 4), P.WOOD_DECK);              // deck
  B.trim(parapetGeo(movePlan(rectPlan(w, d, 0.6), x, z), y + 0.22, 0.4, 0.32), P.CONCRETE);
  B.trim(box(w - 0.6, 0.16, d - 0.6, x, y + 0.34, z, 4), P.SEA_MID);
  for (let i = 0; i < 4; i++) {
    const lx = x - w / 2 - 1.0, lz = z - d / 2 + (i + 0.5) * (d / 4);
    B.trim(box(0.7, 0.34, 1.9, lx, y + 0.22, lz, 2), P.FABRIC_WHITE);
  }
  if (r() < 0.7) {
    B.trim(cyl(0.07, 2.3, 6, x + w / 2 + 1.4, y + 0.22, z), P.ALUMINIUM);
    B.trim(cyl(1.5, 0.5, 8, x + w / 2 + 1.4, y + 2.4, z, 0.08), r.pick(FABRIC_COLORS));
  }
}

/**
 * Populate a roof: parapet, deck, plant. This is the single highest-value
 * detail pass in the file — the 3/4 camera shows roofs almost every frame.
 */
function roofScape(B, plan, y, r, o = {}) {
  const bb = planBounds(plan);
  const area = bb.w * bb.d;
  const ph = o.parapetH ?? (0.85 + r() * 0.7);
  B.trim(parapetGeo(plan, y, ph, 0.42), o.parapetHex || P.PARAPET);
  B.trim(loft([{ p: plan, y: y + 0.03 }], { capTop: true, uScale: 3 }), P.ROOF_GRAVEL);

  const inner = offsetPlan(plan, -2.2);
  const spots = [];
  const tries = Math.min(26, 6 + Math.round(area / 26));
  for (let i = 0; i < tries * 3 && spots.length < tries; i++) {
    const x = bb.cx + (r() - 0.5) * bb.w * 0.86;
    const z = bb.cz + (r() - 0.5) * bb.d * 0.86;
    if (!inPlan(inner, x, z)) continue;
    // A podium roof has a tower growing out of it; plant must dodge the shaft.
    if (o.avoid && inPlan(o.avoid, x, z)) continue;
    let ok = true;
    for (const s of spots) if (Math.hypot(s[0] - x, s[1] - z) < 3.0) { ok = false; break; }
    if (ok) spots.push([x, z]);
  }

  let i = 0;
  // Big-ticket items first, so they get the middle of the roof.
  if (o.helipad && area > 900 && spots.length) {
    i = 1;
    helipad(B, bb.cx, y + 0.05, bb.cz, Math.min(7.5, bb.w * 0.22));
  }
  if (o.pool && area > 500 && spots.length > i) {
    rooftopPool(B, bb.cx + (r() - 0.5) * 3, y + 0.05, bb.cz, Math.min(11, bb.w * 0.34), Math.min(6, bb.d * 0.26), r);
    i += 2;
  }
  if (area > 260 && spots.length > i + 1) {
    const s = spots[i++];
    bulkhead(B, s[0], y + 0.05, s[1], 3.4, 3.0, 2.9 + r() * 1.4, P.CONCRETE_DARK);
  }
  if (o.tank !== false && area > 200 && spots.length > i) {
    const s = spots[i++]; waterTank(B, s[0], y + 0.05, s[1], 0.8 + r() * 0.35);
  }
  for (; i < spots.length; i++) {
    const s = spots[i];
    const roll = r();
    if (roll < 0.46) acUnit(B, s[0], y + 0.05, s[1], 0.9 + r() * 0.8, r);
    else if (roll < 0.62) ventStack(B, s[0], y + 0.05, s[1], 0.8 + r() * 0.6);
    else if (roll < 0.74) ductRun(B, s[0], y + 0.05, s[1], 2.5 + r() * 3, r() < 0.5 ? 0 : Math.PI / 2, 1);
    else if (roll < 0.82) dish(B, s[0], y + 0.05, s[1], 0.7 + r() * 0.5);
    else if (roll < 0.9) B.trim(box(1.6 + r(), 0.5, 1.2 + r(), s[0], y + 0.05, s[1], 3), P.ROOF_MEMBRANE);
    else B.trim(cyl(0.5, 0.7, 8, s[0], y + 0.05, s[1]), P.VENT_METAL);
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
  const inner = offsetPlan(plan, -0.45);

  B.trim(loft([{ p: plan, y: 0 }, { p: plan, y: 0.55 }], { uScale: 5, vScale: 5 }), P.CONCRETE_DARK);
  if (glassMat) {
    B.gl(loft([{ p: inner, y: 0.55 }, { p: inner, y: head }], { uScale: CW_U, vScale: CW_V }), glassMat);
  } else {
    B.trim(loft([{ p: inner, y: 0.55 }, { p: inner, y: head }], { uScale: 4, vScale: 4 }), P.SPANDREL);
  }
  // Piers, on a real 6-8 m rhythm, standing proud of the glass line.
  const per = [];
  for (let i = 0; i < plan.length; i++) {
    const a = plan[i], b = plan[(i + 1) % plan.length];
    per.push(Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = per.reduce((x, y) => x + y, 0);
  const nP = Math.max(6, Math.min(20, Math.round(total / 7)));
  fins(B, plan, 0.55, head + 0.5, nP, 0.85, opts.pierHex || P.CONCRETE);
  // Head beam + the wall above it.
  B.trim(slabGeo(plan, head, 0.75, 0.55), opts.bandHex || P.CONCRETE_WARM);
  if (h > head + 1.4) {
    B.trim(loft([{ p: plan, y: head + 0.75 }, { p: plan, y: h }], { uScale: 5, vScale: 5 }), opts.wallHex || P.PRECAST);
    // Reveals so the upper podium is not a blank slab either.
    for (let yy = head + 3.4; yy < h - 0.8; yy += 3.4) {
      B.trim(slabGeo(plan, yy, 0.28, 0.28), P.CONCRETE_DARK);
    }
  }
  B.trim(slabGeo(plan, h - 0.55, 0.62, 0.95), opts.bandHex || P.CONCRETE_WARM);
  canopy(B, Math.min(bb.w * 0.5, 13), head - 0.6, bb.z1, 3.0, opts.canopyHex || P.CHROME);
  return head;
}

/** Entrance canopy hung off the +z (street) face. */
function canopy(B, w, y, zFace, proj, hex) {
  B.trim(box(w, 0.34, proj, 0, y, zFace + proj / 2, 3), hex);
  B.trim(box(0.16, 1.1, 0.16, -w / 2 + 0.5, y - 1.1, zFace + proj - 0.4, 2), P.STEEL);
  B.trim(box(0.16, 1.1, 0.16, w / 2 - 0.5, y - 1.1, zFace + proj - 0.4, 2), P.STEEL);
}

/** A stack of projecting balcony slabs with a slim balustrade. */
function balconyStack(B, plan, y0, y1, step, proj, slabHex, railHex) {
  for (let y = y0; y < y1 - 1; y += step) {
    B.trim(slabGeo(plan, y, 0.24, proj), slabHex);
    B.trim(parapetGeo(offsetPlan(plan, proj), y + 0.24, 1.0, 0.09), railHex);
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

/** Pick a plan archetype. This is where skyline variety actually comes from. */
function shaftPlan(r, w, d, kind) {
  switch (kind) {
    case 'ellipse': return ellipsePlan(w, d, 16);
    case 'bow': return bowPlan(w, d, Math.min(w, d) * 0.16);
    case 'chamferHard': return rectPlan(w, d, Math.min(w, d) * 0.28);
    case 'slab': return rectPlan(w, d, Math.min(w, d) * 0.10);
    default: return rectPlan(w, d, Math.min(w, d) * 0.16);
  }
}

/**
 * Crown the shaft. Every tower gets a top — a stepped cap, a sculpted taper or
 * a mechanical penthouse with a mast — because a flat-topped shaft is the
 * loudest "procedural city" tell there is.
 */
function crown(B, plan, y, r, opt = {}) {
  const bb = planBounds(plan);
  const kind = opt.kind || r.weighted([['step', 34], ['taper', 22], ['plant', 28], ['blade', 16]]);
  const litHex = opt.litHex || P.NEON_AQUA;
  let top = y;

  if (kind === 'step') {
    let p = plan, yy = y;
    for (let i = 0; i < 3; i++) {
      const h = 3.2 + r() * 3.4;
      B.trim(loft([{ p, y: yy }, { p, y: yy + h }], { capTop: false }), i % 2 ? P.CONCRETE : P.PRECAST);
      B.trim(slabGeo(p, yy + h, 0.42, 0.7), P.CONCRETE_WARM);
      yy += h + 0.42;
      p = offsetPlan(p, -Math.min(bb.w, bb.d) * 0.11);
      if (Math.hypot(planBounds(p).w, planBounds(p).d) < 6) break;
    }
    B.trim(loft([{ p, y: yy }], { capTop: true }), P.ROOF_GRAVEL);
    if (opt.lit) B.lit(loft([{ p: offsetPlan(plan, 0.25), y: y + 1.2 }, { p: offsetPlan(plan, 0.25), y: y + 2.0 }], {}), litHex);
    top = yy;
  } else if (kind === 'taper') {
    const p2 = offsetPlan(plan, -Math.min(bb.w, bb.d) * 0.3);
    const h = 7 + r() * 9;
    B.trim(loft([{ p: plan, y }, { p: p2, y: y + h }], { capTop: true }), P.PRECAST);
    top = y + h;
  } else if (kind === 'blade') {
    B.trim(parapetGeo(plan, y, 1.5, 0.5), P.PARAPET);
    const bw = Math.min(bb.w, bb.d) * 0.34;
    const h = 10 + r() * 14;
    B.trim(loft([{ p: rectPlan(bw, bb.d * 0.5, 0.5), y }, { p: rectPlan(bw * 0.6, bb.d * 0.34, 0.4), y: y + h }], { capTop: true }), P.CONCRETE);
    if (opt.lit) B.lit(box(bw * 0.35, h * 0.8, 0.5, 0, y + 1, bb.d * 0.25, 3), litHex);
    top = y + h;
  } else {
    B.trim(parapetGeo(plan, y, 1.6, 0.5), P.PARAPET);
    roofScape(B, offsetPlan(plan, -0.6), y + 0.1, r, { helipad: opt.helipad, parapetH: 0.9 });
    const pw = Math.min(bb.w * 0.5, 11), pd = Math.min(bb.d * 0.5, 9);
    B.trim(loft([{ p: rectPlan(pw, pd, 1.2), y: y + 1.7 }, { p: rectPlan(pw, pd, 1.2), y: y + 6.4 }], { capTop: true }), P.CONCRETE_DARK);
    top = y + 6.4;
  }

  // Mast + aviation light: reads at 400 m and costs 40 triangles.
  const mh = 6 + r() * 12;
  B.trim(cyl(0.5, mh, 6, 0, top, 0, 0.16), P.ALUMINIUM);
  if (opt.lit) B.lit(cyl(0.45, 0.45, 6, 0, top + mh, 0), P.LIGHT_RED);
  else B.trim(cyl(0.45, 0.45, 6, 0, top + mh, 0), P.LIGHT_RED);
  return top + mh;
}

/**
 * A Brickell tower: retail podium with a canopy, an articulated shaft with
 * setbacks and an expressed service core, and a crown.
 */
function tower(ctx, B, r, w, d, h, o = {}) {
  const gt = o.glassTint ?? r.pick(GLASS_TINTS);
  const cm = curtainMat(gt);
  const podH = o.podiumH ?? (o.podium ? 8 + r() * 9 : 0);
  const resi = o.resi ?? r.chance(0.45);

  /* --- podium ---------------------------------------------------------- */
  let baseTop = 0;
  if (podH > 2) {
    const pp = rectPlan(w * 1.10, d * 1.10, Math.min(w, d) * 0.09);
    podium(B, pp, podH, r, cm);
    roofScape(B, offsetPlan(pp, -1.6), podH + 0.05, r, {
      tank: false, parapetH: 1.0, avoid: offsetPlan(rectPlan(w, d, 0), 2.5),
    });
    baseTop = podH;
  }

  /* --- shaft ----------------------------------------------------------- */
  const kind = o.planKind || r.weighted([
    ['chamfer', 34], ['slab', 20], ['ellipse', 14], ['bow', 16], ['chamferHard', 16],
  ]);
  const twist = !o.noTwist && r.chance(0.16) ? (r() < 0.5 ? -1 : 1) * (0.10 + r() * 0.14) : 0;
  const smooth = kind === 'ellipse' || kind === 'bow';

  const sections = 1 + (h > 70 ? 1 : 0) + (h > 130 ? 1 : 0);
  let y = baseTop, pw = w, pd = d;
  let plan = shaftPlan(r, pw, pd, kind);
  const shaftTop = h;

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
    B.gl(loft(rings, { uScale: CW_U, vScale: CW_V, smooth, capTop: false, capBottom: false }), cm);

    // Expressed service core: a solid slot of masonry riding up one face.
    if (s === 0 && r.chance(0.55)) {
      const cw = Math.min(pw, pd) * 0.30;
      B.trim(loft([{ p: rectPlan(cw, pd * 0.42, 0.5), y: baseTop }, { p: rectPlan(cw, pd * 0.42, 0.5), y: shaftTop + 2 + r() * 6 }], { uScale: 5, vScale: 5, capTop: true }), r.chance(0.5) ? P.CONCRETE : P.CONCRETE_DARK);
    }
    if (resi) {
      balconyStack(B, rotPlan(plan, twist * y / 60), y + 3.4, segTop, STOREY * (r.chance(0.5) ? 1 : 2),
        1.25, P.CONCRETE_WARM, r.chance(0.5) ? P.GLASS_SKY : P.ALUMINIUM);
    } else {
      fins(B, plan, y + 1, segTop, 8 + Math.round(r() * 6), 0.55, r.chance(0.5) ? P.MULLION : P.CONCRETE);
      for (let yy = y + STOREY * 4; yy < segTop - 2; yy += STOREY * 4) {
        B.trim(slabGeo(plan, yy, 0.34, 0.34), P.CONCRETE_WARM);
      }
    }
    // Setback: the terrace roof it creates is prime 3/4-camera real estate.
    if (!isLast) {
      B.trim(slabGeo(plan, segTop, 0.5, 1.1), P.CONCRETE_WARM);
      roofScape(B, offsetPlan(plan, 0.6), segTop + 0.5, r, {
        tank: false, parapetH: 1.0, pool: resi && r.chance(0.5),
        avoid: offsetPlan(shaftPlan(r, pw * 0.82, pd * 0.82, kind), 2.5),
      });
      pw *= 0.80 + r() * 0.10; pd *= 0.80 + r() * 0.10;
      plan = shaftPlan(r, pw, pd, kind);
    }
    y = segTop;
  }

  const capPlan = rotPlan(plan, twist * y / 60);
  return crown(B, capPlan, y, r, {
    lit: o.lit, litHex: o.litHex, helipad: o.helipad ?? (h > 120 && r.chance(0.5)),
    kind: o.crownKind,
  });
}

/**
 * Miami residential tower: pastel render, a balcony slab on every floor, a
 * couple of setbacks. No curtain wall, so it is a single draw call — and it is
 * the only thing that stops the skyline being a comb of identical teal shafts.
 */
function resiTower(ctx, B, r, w, d, h, o = {}) {
  const cham = Math.min(w, d) * (r.chance(0.4) ? 0.22 : 0.13);
  const uS = B.sk.uScale, vS = B.sk.vScale;
  const podH = o.podiumH || 0;
  let y = 0;

  if (podH > 2) {
    const pp = rectPlan(w * 1.12, d * 1.12, cham);
    podium(B, pp, podH, r, null, {
      wallHex: P.STUCCO_WHITE, canopyHex: r.pick(FABRIC_COLORS), pierHex: P.STUCCO_WHITE,
    });
    roofScape(B, offsetPlan(pp, -1.8), podH + 0.05, r, {
      tank: false, parapetH: 1.0, pool: r.chance(0.3),
      avoid: offsetPlan(rectPlan(w, d, 0), 2.6),
    });
    y = podH;
  }

  const sections = h > 115 ? 3 : h > 62 ? 2 : 1;
  let plan = r.chance(0.18) ? ellipsePlan(w, d, 14) : rectPlan(w, d, cham);
  const rail = r.pick([P.GLASS_SKY, P.ALUMINIUM, P.STUCCO_WHITE, P.GLASS_AQUA]);
  const step = STOREY * (h > 55 ? 2 : 1);
  for (let sct = 0; sct < sections; sct++) {
    const last = sct === sections - 1;
    const want = last ? h : y + (h - podH) * (0.30 + r() * 0.14);
    const segTop = Math.min(h - 2, Math.max(y + 14, want));
    B.face(loft([{ p: plan, y }, { p: plan, y: segTop }], { uScale: uS, vScale: vS, capTop: false }));
    balconyStack(B, plan, y + STOREY, segTop, step, 1.05, P.STUCCO_WHITE, rail);
    if (r.chance(0.35)) fins(B, plan, y, segTop, 4, 0.85, P.STUCCO_WHITE);
    if (!last) {
      B.trim(slabGeo(plan, segTop, 0.55, 1.5), P.STUCCO_WHITE);
      const next = offsetPlan(plan, -(2.2 + r() * 3.4));
      roofScape(B, offsetPlan(plan, 0.9), segTop + 0.55, r, {
        tank: false, parapetH: 1.0, pool: r.chance(0.26), avoid: offsetPlan(next, 2.0),
      });
      plan = next;
    }
    y = segTop;
  }
  return crown(B, plan, y, r, {
    lit: o.lit, litHex: P.NEON_AQUA, helipad: o.helipad,
    kind: r.weighted([['plant', 46], ['step', 34], ['taper', 20]]),
  });
}

/* =========================================================== midrise ==== */

/** 6-16 storey Deco / stucco block: banded floors, stepping, loggias. */
function midrise(ctx, B, r, w, d, h, o = {}) {
  const deco = o.deco ?? r.chance(0.4);
  const cham = Math.min(w, d) * (deco ? 0.10 : 0.16);
  let plan = rectPlan(w, d, cham);
  const uS = B.sk.uScale, vS = B.sk.vScale;

  const steps = h > 26 ? (deco ? 3 : 2) : 1;
  let y = 0;
  const heights = [];
  for (let i = 0; i < steps; i++) heights.push((h / steps) * (i === steps - 1 ? 1 : 0.9 + r() * 0.2));

  for (let i = 0; i < steps; i++) {
    const top = i === steps - 1 ? Math.max(y + 6, h) : y + heights[i];
    B.face(loft([{ p: plan, y }, { p: plan, y: top }], { uScale: uS, vScale: vS, capTop: false }));

    // String courses every floor read as the Deco banding from the air.
    if (deco) {
      for (let yy = y + STOREY; yy < top - 1; yy += STOREY) {
        B.trim(slabGeo(plan, yy - 0.16, 0.3, 0.26), P.STUCCO_WHITE);
      }
    } else {
      balconyStack(B, plan, Math.max(y, STOREY), top - 1, STOREY * (r.chance(0.6) ? 1 : 2),
        1.15, P.STUCCO_WHITE, r.chance(0.5) ? P.ALUMINIUM : P.GLASS_SKY);
    }

    B.trim(slabGeo(plan, top, 0.45, 0.55), P.CONCRETE_WARM);   // cornice
    if (i < steps - 1) {
      const nextPlan = offsetPlan(plan, -(1.8 + r() * 2.6));
      roofScape(B, offsetPlan(plan, 0.2), top + 0.45, r, {
        tank: false, parapetH: 0.9, avoid: offsetPlan(nextPlan, 1.6),
      });
      plan = nextPlan;
      if (planBounds(plan).w < 8 || planBounds(plan).d < 8) { y = top + 0.45; break; }
    }
    y = top + 0.45;
  }

  roofScape(B, plan, y, r, {
    pool: !deco && r.chance(0.3), parapetHex: deco ? P.STUCCO_WHITE : P.PARAPET,
  });
  const roofTop = y + 2.5;

  // Ground-floor retail: a recessed dark shopfront band with piers in front,
  // which is what gives a midrise any scale at eye level.
  if (o.retailBase !== false) {
    const base = rectPlan(w, d, cham);
    const bb2 = planBounds(base);
    B.trim(loft([{ p: offsetPlan(base, -0.45), y: 0.45 }, { p: offsetPlan(base, -0.45), y: 4.3 }], { uScale: 4, vScale: 4 }), P.SPANDREL);
    B.trim(loft([{ p: base, y: 0 }, { p: base, y: 0.45 }], { uScale: 4, vScale: 4 }), P.CONCRETE_DARK);
    fins(B, base, 0.45, 4.6, Math.max(6, Math.round((w + d) / 6)), 0.7, P.STUCCO_WHITE);
    B.trim(slabGeo(base, 4.3, 0.55, 0.5), P.STUCCO_WHITE);
    if (r.chance(0.72)) awning(B, Math.min(w * 0.62, 14), 4.2, bb2.z1 + 0.05, 1.9, 0.5, r.pick(FABRIC_COLORS));
    else canopy(B, Math.min(w * 0.6, 14), 4.2, bb2.z1, 2.0, r.pick(FABRIC_COLORS));
  }
  return roofTop;
}

/* ======================================================== storefronts === */

/** Awning band inside Textures.storefront(), in tile-v. */
const AWN_V0 = 1 - 0.26, AWN_V1 = 1 - 0.175;
const SIGN_V0 = 1 - 0.17, SIGN_V1 = 1 - 0.055;

/** Striped awning that borrows the shopfront texture's own awning band. */
function awning(B, w, y, zFace, proj, drop, hex) {
  if (!B.sk.awn) {
    // No striped band in this texture — model a plain fabric canopy instead.
    const g = box(w, 0.22, proj, 0, y - drop * 0.5, zFace + proj / 2, 3);
    g.rotateX(-0.2); g.translate(0, y * 0.2, 0);
    B.trim(g, hex || P.FABRIC_CORAL);
    B.trim(box(w, 0.5, 0.16, 0, y - drop - 0.5, zFace + proj, 3), hex || P.FABRIC_CORAL);
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
  B.band(g);
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
  const B = new Build(shopSkin(hex));
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
  const cor = r.weighted([['flat', 40], ['step', 30], ['curve', 30]]);
  B.trim(slabGeo(plan, h, 0.42, 0.42), P.STUCCO_WHITE);
  if (cor === 'step') {
    B.trim(parapetGeo(plan, h + 0.42, 0.7, 0.4), P.CONCRETE_WARM);
    const cw = lw * 0.42;
    B.trim(box(cw, 1.1, ld * 0.3, 0, h + 0.42, bb.z1 - ld * 0.16, 3), P.STUCCO_WHITE);
  } else if (cor === 'curve') {
    B.trim(parapetGeo(plan, h + 0.42, 0.55, 0.4), P.CONCRETE_WARM);
    B.trim(cyl(lw * 0.24, 0.5, 12, 0, h + 0.97, bb.z1 - ld * 0.14), P.STUCCO_WHITE);
  } else {
    B.trim(parapetGeo(plan, h + 0.42, 0.9, 0.4), P.CONCRETE_WARM);
  }
  B.trim(loft([{ p: offsetPlan(plan, -0.4), y: h + 0.45 }], { capTop: true, uScale: 3 }), P.ROOF_GRAVEL);

  /* --- roof plant. Small, but this is what a mid-game hole looks down on. */
  const nAc = 1 + Math.floor(r() * 3);
  for (let i = 0; i < nAc; i++) {
    const x = (r() - 0.5) * lw * 0.6, z = (r() - 0.5) * ld * 0.6;
    if (r() < 0.6) acUnit(B, x, h + 0.5, z, 0.8 + r() * 0.4, r);
    else ventStack(B, x, h + 0.5, z, 0.7);
  }
  if (r.chance(0.3)) waterTank(B, (r() - 0.5) * lw * 0.4, h + 0.5, (r() - 0.5) * ld * 0.4, 0.55);

  /* --- shopfront furniture ---------------------------------------------- */
  const awnY = vS * AWN_V1;
  if (r.chance(0.82)) awning(B, lw * 0.9, awnY, bb.z1, 1.6 + r() * 0.9, 0.55);
  if (r.chance(0.45)) bladeSign(B, lw * (0.5 - 0.12), awnY + 1.6, bb.z1, 1.5, 0.9);
  // Roll-down shutter on a closed unit.
  if (r.chance(0.18)) {
    B.trim(box(lw * 0.62, 3.1, 0.22, 0, 0.1, bb.z1 - 0.1, 2), P.ALUMINIUM);
  }
  // A-board on the pavement, part of the shop so it falls with it.
  if (r.chance(0.4)) {
    const ax = (r() - 0.5) * lw * 0.5;
    const g1 = box(0.9, 1.1, 0.09, ax, 0, bb.z1 + 1.3, 1.5); g1.rotateX(0.16);
    B.trim(g1, P.SIGN_LIGHT);
    const g2 = box(0.9, 1.1, 0.09, ax, 0, bb.z1 + 1.6, 1.5); g2.rotateX(-0.16);
    B.trim(g2, P.SIGN_DARK);
  }

  register(ctx, group, B, world, Math.max(lw, ld) * 0.5, h + 1.4, TIER.HUGE,
    'storefront', opt.label || 'Storefront', hex);
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
  const B = new Build(deckSkin());
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
  // Big "P" sign on the street corner.
  B.trim(box(0.4, 3.4, 2.6, bb.x1 - 0.3, 4.5, bb.z1 - 3.0, 3), P.SIGN_BLUE);

  register(ctx, group, B, world, Math.max(lw, ld) * 0.5, top + 4, TIER.MASSIVE,
    'garage', 'Parking Garage', P.PRECAST);
}

/** Surface car park: fence, planting kerb, painted bays, parked cars, kiosk. */
function surfaceLot(ctx, group, b, r, world, lw, ld) {
  const B = new Build(trimSkin());
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
    'lot', 'Car Park', P.CONCRETE_DARK);
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
function construction(ctx, group, b, r, world, lw, ld, h) {
  const B = new Build(trimSkin());
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
  for (let i = 1; i <= floors; i++) {
    const y = i * 3.6;
    // The top few floors are still being poured, so they shrink back and stop.
    const sp = i > floors * 0.78 ? offsetPlan(plan, -(2 + r() * 5)) : plan;
    B.trim(slabGeo(sp, y, 0.42, 0.35), P.PRECAST);
    B.trim(loft([{ p: sp, y: y + 0.42 }], { capTop: true, uScale: 4 }), P.CONCRETE_WARM);
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

  /* Scaffolding + safety netting on the street face. */
  const sh = Math.min(h, 3.6 * Math.round(floors * 0.7));
  scaffold(B, bb.x0 + 1.5, bb.x1 - 1.5, 0, sh, bb.z1 + 0.9, P.SCAFFOLD);
  const netHex = r.chance(0.5) ? P.STUCCO_MINT : P.STUCCO_SKY;
  for (let x = bb.x0 + 1.5; x < bb.x1 - 1.5; x += 2.6) {
    B.trim(box(1.3, sh, 0.05, x, 0, bb.z1 + 1.25, 3), netHex);
  }

  /* Crane. */
  towerCrane(ctx, B, bb.x0 + Math.max(4, lw * 0.16), bb.z0 + Math.max(4, ld * 0.18),
    h + 10 + r() * 12, Math.min(30, Math.max(lw, ld) * 0.8), r() * Math.PI * 2, r);

  /* Hoarding around the lot + portacabins + a skip. */
  const hoard = offsetPlan(rectPlan(lw + 3.4, ld + 3.4, 2.0), 0);
  B.trim(parapetGeo(hoard, 0, 3.0, 0.22), r.pick([P.FABRIC_SKY, P.STUCCO_WHITE, P.FABRIC_AQUA]));
  B.trim(parapetGeo(hoard, 3.0, 0.22, 0.4), P.SIGN_DARK);
  const hb = planBounds(hoard);
  for (let i = 0; i < 2 + Math.floor(r() * 2); i++) {
    const cx = hb.x1 - 4.0, cz = hb.z0 + 4 + i * 3.4;
    B.trim(box(6.0, 2.7, 2.9, cx, i > 1 ? 2.85 : 0, cz, 3), i % 2 ? P.STUCCO_WHITE : P.FABRIC_SKY);
    B.trim(box(6.2, 0.2, 3.1, cx, (i > 1 ? 2.85 : 0) + 2.7, cz, 3), P.STEEL);
  }
  B.trim(box(4.4, 1.5, 2.2, hb.x0 + 4, 0, hb.z1 - 3.2, 3), P.RUST);

  register(ctx, group, B, world, Math.max(lw, ld) * 0.6, h + 26, TIER.MASSIVE,
    'construction', 'Construction Site', P.CONCRETE);
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
  B.trim(slabGeo(plan, glassTop, 1.8, 2.6), P.CONCRETE_WARM);
  B.lit(loft([{ p: offsetPlan(plan, 2.9), y: glassTop + 0.3 }, { p: offsetPlan(plan, 2.9), y: glassTop + 1.4 }], { smooth: true }), P.NEON_PINK);

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
  /* Entrance canopy on columns. */
  B.trim(box(lw * 0.42, 1.1, 11, 0, 7.6, bb.z1 + 3.0, 5), P.CHROME);
  for (const sx of [-1, 1]) {
    B.trim(cyl(0.55, 7.6, 10, sx * lw * 0.17, 0, bb.z1 + 7.4), P.STEEL);
  }
  return glassTop + 11;
}

/** Stepped masonry tower with an illuminated crown. Freedom Tower language. */
function decoTower(ctx, B, r, lw, ld, h) {
  const base = rectPlan(lw, ld, Math.min(lw, ld) * 0.10);
  const uS = B.sk.uScale, vS = B.sk.vScale;
  const bh = Math.min(h * 0.34, 22);
  B.face(loft([{ p: base, y: 0 }, { p: base, y: bh }], { uScale: uS, vScale: vS }));
  // Colonnade across the entrance.
  const bb = planBounds(base);
  for (let i = 0; i < 6; i++) {
    B.trim(cyl(0.62, 8.0, 10, bb.x0 + lw * (i + 0.5) / 6, 0, bb.z1 + 1.4), P.STUCCO_WHITE);
  }
  B.trim(box(lw + 2.4, 1.3, 3.4, 0, 8.0, bb.z1 + 1.0, 4), P.STUCCO_WHITE);
  B.trim(slabGeo(base, bh, 0.6, 1.0), P.STUCCO_WHITE);

  let p = offsetPlan(base, -Math.min(lw, ld) * 0.16), y = bh + 0.6;
  const shaftTop = h * 0.80;
  B.face(loft([{ p, y }, { p, y: shaftTop }], { uScale: uS, vScale: vS, capTop: false }));
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
    cp = offsetPlan(cp, -Math.min(lw, ld) * 0.09);
  }
  const cb = planBounds(cp);
  B.trim(cyl(Math.max(2.0, cb.w * 0.45), 6.0, 10, 0, cy, 0), P.STUCCO_WHITE);
  B.trim(cyl(Math.max(2.0, cb.w * 0.5), 4.0, 10, 0, cy + 6, 0, 0.15), P.TERRACOTTA);
  B.trim(cyl(0.28, 7.0, 6, 0, cy + 10, 0, 0.1), P.ALUMINIUM);
  B.lit(cyl(0.5, 0.5, 6, 0, cy + 16.6, 0), P.LIGHT_RED);
  return cy + 17;
}

/** Low, wide, heavy: colonnade, entablature, civic roof plant. */
function civicBlock(ctx, B, r, lw, ld, h) {
  const plan = rectPlan(lw, ld, 1.6);
  const bb = planBounds(plan);
  const uS = B.sk.uScale, vS = B.sk.vScale;
  B.trim(loft([{ p: rectPlan(lw + 3.0, ld + 3.0, 2.0), y: 0 }, { p: rectPlan(lw + 3.0, ld + 3.0, 2.0), y: 1.5 }], { uScale: 5, vScale: 5 }), P.CONCRETE_DARK);
  B.face(loft([{ p: plan, y: 1.5 }, { p: plan, y: h }], { uScale: uS, vScale: vS, capTop: false }));
  // Colonnade wrapping the two street faces.
  const n = Math.max(5, Math.round(lw / 5.5));
  for (let i = 0; i < n; i++) {
    const x = bb.x0 + lw * (i + 0.5) / n;
    B.trim(cyl(0.78, h - 3.4, 12, x, 1.5, bb.z1 + 1.9), P.STUCCO_WHITE);
    B.trim(box(2.0, 0.5, 2.0, x, h - 1.9, bb.z1 + 1.9, 3), P.STUCCO_WHITE);
  }
  B.trim(box(lw + 5.2, 1.9, 4.6, 0, h - 1.4, bb.z1 + 1.6, 5), P.STUCCO_WHITE);  // entablature
  B.trim(slabGeo(plan, h, 0.8, 1.6), P.STUCCO_WHITE);
  roofScape(B, offsetPlan(plan, -0.4), h + 0.8, r, { parapetHex: P.STUCCO_WHITE, tank: true });
  return h + 3;
}

/* ==================================================== block dispatch ==== */

const ROT = { s: 0, n: Math.PI, e: Math.PI / 2, w: -Math.PI / 2 };

/** Register a finished Build as a Consumable sitting exactly on the pavement. */
function register(ctx, group, B, world, radius, height, tier, kind, label, hex) {
  const root = B.finish();
  root.position.set(world.x, ctx.Y_WALK, world.z);
  root.rotation.y = world.rot;
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
  return root;
}

/** Buildable rectangle: generous pavement on street frontages, party walls
 *  (0.5-2 m) on the sides that only face an alley or a neighbour. */
function lotOf(b, r) {
  const sw = b.sidewalk || 5;
  const want = (side) => (b.edges && b.edges[side]
    ? Math.max(2.8, sw * (0.62 + r() * 0.36))
    : 0.5 + r() * 1.6);
  let n = want('n'), s = want('s'), w = want('w'), e = want('e');
  // Brickell parcels are only 18-43 m deep. An unclamped 6 m setback on both
  // frontages leaves nothing to build on, which is how whole blocks ended up
  // as bare pavement. Cap the pair at a third of the parcel.
  const fit = (a, c, dim) => {
    const max = dim * 0.34;
    const t = a + c;
    return t > max ? [a * (max / t), c * (max / t)] : [a, c];
  };
  [n, s] = fit(n, s, b.d);
  [w, e] = fit(w, e, b.w);
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

/** Tower renders stay light — a saturated 200 m slab dominates the whole frame. */
const TOWER_PASTELS = [
  P.STUCCO_WHITE, P.STUCCO_CREAM, P.STUCCO_SAND, P.STUCCO_SKY,
  P.STUCCO_PEACH, P.STUCCO_MINT, P.STUCCO_AQUA,
];
const STUCCO_SET = [
  P.STUCCO_PINK, P.STUCCO_CORAL, P.STUCCO_CREAM, P.STUCCO_LILAC,
  P.STUCCO_AQUA, P.STUCCO_MINT,
];
const SHOP_SET = [
  P.STUCCO_CREAM, P.STUCCO_PINK, P.STUCCO_AQUA, P.STUCCO_PEACH, P.STUCCO_WHITE,
];

export function buildBuildings(ctx) {
  const { layout } = ctx;
  const group = ctx.group('buildings');
  if (!ctx.fadeableBuildings) ctx.fadeableBuildings = [];

  // Several hand-placed heroes (the arena, Government Center, the amphitheatre)
  // land on blocks the zoner had already called MIDRISE or PLAZA. Match on the
  // landmark NAME so they still get their bespoke geometry — matching on style
  // alone would also catch ordinary Deco infill that happens to sit in a park.
  const heroes = new Set(layout.landmarks.map((l) => l.name));

  let count = 0;

  for (const b of layout.blocks) {
    const r = makeRNG(b.seed ^ 0x9e37);
    const side = b.frontage || 's';
    const lot = lotOf(b, r);
    if (lot.w < 7 || lot.d < 7) continue;

    if (b.landmark && heroes.has(b.landmark)
        && (b.style === STYLE.ARENA || b.style === STYLE.CIVIC || b.style === STYLE.DECO)) {
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

  console.info(`[buildings] ${count} buildings`);
}

/* ------------------------------------------------------------ towers --- */

function towerBlock(ctx, group, b, r, lot, side, isLandmark) {
  let made = 0;
  const h = Math.max(42, b.heightM || b.floors * STOREY);
  // A wide lot gets a low retail annex alongside the tower — that is what
  // stops every Brickell block being one lonely shaft on an empty slab.
  const wide = Math.min(lot.w, lot.d) > 30 && Math.max(lot.w, lot.d) > 52;
  let towerLot = lot, annexLot = null;
  if (wide && r.chance(0.78)) {
    const parts = splitLot(lot, 2, 1.6);
    const iT = r.chance(0.5) ? 0 : 1;
    towerLot = parts[iT];
    annexLot = parts[1 - iT];
  }

  const pl = place(towerLot, side);
  // Spread the layout's height field rather than flattening it: a uniform cap
  // is exactly how a skyline turns into a comb. Tall blocks also take MORE of
  // their lot, so height buys mass instead of turning into a needle.
  const spread = 0.72 + 1.05 * (b.heightPotential ?? 0.5);
  const wanted = h * spread;
  const fill = 0.80 + 0.14 * Math.min(1, wanted / 170);
  const slender = Math.min(pl.lw, pl.ld) * fill * 12.5;
  const hCap = Math.max(34, Math.min(wanted, slender));
  const masonry = b.style === STYLE.TOWER || (!isLandmark && r.chance(0.24));
  const podH = b.hasPodium ? Math.max(7, b.podiumH) : (r.chance(0.55) ? 6 + r() * 6 : 0);

  if (masonry) {
    const hex = r.pick(TOWER_PASTELS);
    const MB = new Build(stuccoSkin(hex));
    const mt = resiTower(ctx, MB, r, pl.lw * fill, pl.ld * fill, hCap, {
      podiumH: podH, lit: isLandmark || hCap > 150 || r.chance(0.2),
      helipad: hCap > 130 && r.chance(0.4),
    });
    register(ctx, group, MB, pl.world, Math.max(pl.lw, pl.ld) * 0.5, mt,
      hCap > 120 || isLandmark ? TIER.LANDMARK : TIER.MASSIVE, 'tower',
      b.landmark || 'Residential Tower', hex);
    made++;
    if (annexLot) made += annex(ctx, group, r, annexLot, side);
    return made;
  }

  const B = new Build(trimSkin());
  const twin = pl.lw > 46 && r.chance(0.34);
  let top;
  if (twin) {
    // Two shafts on one shared podium: one consumable, two silhouettes.
    const sw = pl.lw * 0.42, sd = Math.min(pl.ld * 0.86, sw * 1.15);
    const pp = rectPlan(pl.lw, pl.ld, Math.min(pl.lw, pl.ld) * 0.09);
    const gt = r.pick(GLASS_TINTS);
    B.glassMat = curtainMat(gt);
    podium(B, pp, podH || 10, r, curtainMat(gt));
    roofScape(B, offsetPlan(pp, -1.8), (podH || 10) + 0.05, r, {
      tank: false, parapetH: 1.0, avoid: rectPlan(pl.lw * 0.9, pl.ld * 0.9, 0),
    });
    top = 0;
    for (const dx of [-1, 1]) {
      const sub = new Build(trimSkin());
      sub.skinGeo = B.skinGeo; sub.glassGeo = B.glassGeo; sub.litGeo = B.litGeo;
      sub.glassMat = B.glassMat; sub.litHex = B.litHex;
      const t = towerShaftAt(ctx, sub, r, dx * pl.lw * 0.24, 0, sw, sd,
        h * (dx < 0 ? 1 : 0.72 + r() * 0.2), podH || 9, gt, isLandmark);
      B.glassMat = sub.glassMat; B.litHex = sub.litHex;
      top = Math.max(top, t);
    }
  } else {
    top = tower(ctx, B, r, pl.lw * fill, pl.ld * fill, hCap, {
      podium: podH > 2, podiumH: podH,
      lit: isLandmark || hCap > 150 || r.chance(0.22),
      resi: r.chance(0.35),
      helipad: hCap > 130 && r.chance(0.55),
    });
  }

  register(ctx, group, B, pl.world, Math.max(pl.lw, pl.ld) * 0.5, top,
    hCap > 120 || isLandmark ? TIER.LANDMARK : TIER.MASSIVE, 'tower',
    b.landmark || 'Glass Tower', P.GLASS_TEAL);
  made++;

  if (annexLot) made += annex(ctx, group, r, annexLot, side);
  return made;
}

/** Low pastel block sharing a tower's parcel. Fills the lot, breaks the base. */
function annex(ctx, group, r, lot, side) {
  const ap = place(lot, side);
  if (ap.lw < 8 || ap.ld < 8) return 0;
  const hex = r.pick(STUCCO_SET);
  const AB = new Build(stuccoSkin(hex));
  const ah = 9 + r() * 16;
  const top = midrise(ctx, AB, r, ap.lw * 0.93, ap.ld * 0.93, ah, { deco: r.chance(0.45) });
  register(ctx, group, AB, ap.world, Math.max(ap.lw, ap.ld) * 0.5, top,
    TIER.MASSIVE, 'midrise', 'Podium Annex', hex);
  return 1;
}

/** Shaft-only variant used by the twin-tower case (shares one Build). */
function towerShaftAt(ctx, B, r, ox, oz, w, d, h, y0, gt, isLandmark) {
  const cm = curtainMat(gt);
  const kind = r.weighted([['chamfer', 40], ['slab', 24], ['ellipse', 18], ['bow', 18]]);
  const plan = movePlan(shaftPlan(r, w, d, kind), ox, oz);
  const smooth = kind === 'ellipse' || kind === 'bow';
  B.gl(loft([{ p: plan, y: y0 }, { p: plan, y: h }], { uScale: CW_U, vScale: CW_V, smooth }), cm);
  if (r.chance(0.6)) {
    balconyStack(B, plan, y0 + 3.4, h, STOREY * 2, 1.2, P.CONCRETE_WARM, P.GLASS_SKY);
  } else {
    fins(B, plan, y0 + 1, h, 8, 0.5, P.MULLION);
  }
  return crown(B, plan, h, r, { lit: isLandmark || r.chance(0.4), kind: r.chance(0.5) ? 'plant' : 'step' });
}

/* ----------------------------------------------------------- midrise --- */

function midriseBlock(ctx, group, b, r, lot, side) {
  // Real blocks carry several buildings; one slab per parcel is the single
  // biggest reason a procedural city reads as procedural.
  const long = Math.max(lot.w, lot.d);
  const short = Math.min(lot.w, lot.d);
  // Several buildings per block. One slab per parcel is the loudest possible
  // "generated city" tell, and it flattens the skyline into a comb.
  const n = long > 58 ? 3 : long > 30 ? 2 : 1;
  const parts = splitLot(lot, short < 15 ? Math.min(n, 2) : n, 1.0 + r() * 1.8);
  let made = 0;
  for (const part of parts) {
    if (part.w < 7.5 || part.d < 7.5) continue;
    const pl = place(part, side);
    const hex = r.pick(STUCCO_SET);
    const B = new Build(stuccoSkin(hex));
    const h = Math.max(11, (b.floors + r.int(-2, 3)) * STOREY * (0.85 + r() * 0.3));
    const top = midrise(ctx, B, r, pl.lw * 0.95, pl.ld * 0.95, h, {
      deco: b.style === STYLE.DECO || r.chance(0.35),
    });
    register(ctx, group, B, pl.world, Math.max(pl.lw, pl.ld) * 0.5, top,
      TIER.MASSIVE, 'midrise',
      r.chance(0.5) ? 'Apartment Block' : 'Office Block', hex);
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
  while (left > 7.5) {
    let uw = 7.5 + r() * 7.5;
    if (left - uw < 7.5) uw = left;
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
  construction(ctx, group, b, r, pl.world, pl.lw * 0.78, pl.ld * 0.78, h);
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
    const B = new Build(trimSkin());
    const top = arena(ctx, B, r, pl.lw * 1.02, pl.ld * 1.02, h);
    register(ctx, group, B, pl.world, Math.max(pl.lw, pl.ld) * 0.55, top,
      TIER.LANDMARK, 'landmark', b.landmark || 'Arena', P.PRECAST);
    return 1;
  }
  if (style === STYLE.CIVIC) {
    const hex = r.pick([P.STUCCO_SAND, P.STUCCO_CREAM, P.STUCCO_WHITE]);
    const B = new Build(stuccoSkin(hex));
    const top = civicBlock(ctx, B, r, pl.lw * 0.96, pl.ld * 0.96, Math.min(h, 34));
    register(ctx, group, B, pl.world, Math.max(pl.lw, pl.ld) * 0.55, top,
      TIER.LANDMARK, 'landmark', b.landmark || 'Civic Hall', hex);
    return 1;
  }
  if (style === STYLE.DECO) {
    const hex = r.pick([P.STUCCO_CREAM, P.STUCCO_SAND, P.STUCCO_WHITE]);
    const B = new Build(stuccoSkin(hex));
    const top = decoTower(ctx, B, r, pl.lw * 0.9, pl.ld * 0.9, h);
    register(ctx, group, B, pl.world, Math.max(pl.lw, pl.ld) * 0.5, top,
      TIER.LANDMARK, 'landmark', b.landmark || 'Deco Tower', hex);
    return 1;
  }
  if (style === STYLE.STUCCO) {
    // Market hall: a vaulted shed, low and wide.
    const hex = r.pick(SHOP_SET);
    const B = new Build(stuccoSkin(hex));
    const plan = rectPlan(pl.lw * 0.94, pl.ld * 0.94, 1.4);
    const bb = planBounds(plan);
    B.face(loft([{ p: plan, y: 0 }, { p: plan, y: Math.max(6, h * 0.6) }], { uScale: B.sk.uScale, vScale: B.sk.vScale, capTop: false }));
    const hh = Math.max(6, h * 0.6);
    B.trim(loft([
      { p: plan, y: hh }, { p: offsetPlan(plan, -1.6), y: hh + 1.8 }, { p: offsetPlan(plan, -5.0), y: hh + 3.4 },
    ], { uScale: 6, vScale: 6, capTop: true }), P.TERRACOTTA);
    awning(B, pl.lw * 0.84, 4.0, bb.z1, 2.6, 0.7, P.FABRIC_CORAL);
    B.trim(box(pl.lw * 0.9, 0.3, 3.0, 0, 4.2, bb.z1 + 1.5, 4), P.FABRIC_CORAL);
    register(ctx, group, B, pl.world, Math.max(pl.lw, pl.ld) * 0.5, hh + 4,
      TIER.MASSIVE, 'landmark', b.landmark || 'Market Hall', hex);
    return 1;
  }
  // STYLE.GLASS / STYLE.TOWER — hero towers.
  return towerBlock(ctx, group, b, r, useLot, side, true);
}
