/**
 * STREET FURNITURE — the first minute of every match is spent eating this.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS BUILT THE WAY IT IS
 * ---------------------------------------------------------------------------
 * 1. ONE POOL PER TYPE, GLOBALLY. Every prop goes through `ctx.addInstanced`,
 *    so ~14k objects cost ~60 draw calls, not 14k. Placement is collected in a
 *    first pass and only emitted once the exact per-type counts are known, so
 *    each InstancedMesh is allocated to its true size instead of a guess.
 *
 * 2. VERTEX COLOUR, NOT TEXTURES. A bench needs timber slats AND dark cast-iron
 *    ends in a single instanced draw. Multi-material props would mean multiple
 *    pools per object, and an object that is swallowed must be ONE addressable
 *    thing. So colour is baked into the merged geometry as a `color` attribute
 *    and the material is a single `vertexColors` standard material. Props that
 *    are genuinely monochrome (wheelie bins, fabric, scooters) instead leave
 *    their body vertices near-white and take a per-instance hex, which three
 *    multiplies on top — that is where the colour variety comes from.
 *
 * 3. BAKED CONTACT OCCLUSION. Every vertex is darkened toward the ground
 *    (`aoAt`). The sun shadow map is ~0.28 m per texel over the play area, so
 *    a 0.3 m cone casts a shadow smaller than one texel; without this ramp the
 *    small props read as floating. It also means TINY props can skip
 *    `castShadow` entirely, which halves their triangle cost (the shadow pass
 *    re-draws every instance).
 *
 * 4. TRIANGLE DISCIPLINE. Round things are 6-8 segment tubes with smooth
 *    normals (reads round, no razor edges, ~30 tris). Rectangular things are
 *    swept rectangular prisms with a chamfered top section — from a 40-degree
 *    camera the top edges are the only ones on the silhouette, so that is where
 *    the bevel budget goes.
 *
 * 5. PLACEMENT IS CONTEXTUAL. `block.streetLife` drives spacing, `block.zone`
 *    drives vocabulary, and things that appear in groups in real life (café
 *    sets, scooter rows, barrier lines, lounger rows) are placed as clusters,
 *    never as independent dice rolls.
 *
 * NOTE ON ctx.isFree: buildings.js claims `max(w,d)*0.5` around a block centre,
 * which on the coarse 3 m occupancy grid covers the whole parcel *including the
 * sidewalk*. So the shared grid cannot gate pavement placement — it would leave
 * the city bare, which is the bug this module exists to fix. Props therefore
 * keep their own fine (1.5 m) grid for prop-vs-prop, derive the building
 * keep-out from the block's own setback data, and use `ctx.isFree` only as a
 * soft hint (retry a few jittered candidates) so palms and vehicles are dodged
 * where the shared grid still carries useful information.
 */

import * as THREE from 'three';
import { TIER, PALETTE } from '../config.js';
import { makeRNG } from '../core/rng.js';
import { solid } from '../core/materials.js';
import { ZONE } from './cityLayout.js';

/** Global dial for tuning density against the triangle budget. */
const DENSITY = 1.0;

const TAU = Math.PI * 2;

/* ========================================================== colour ====== */

const _lin = new Map();
/** sRGB hex -> linear RGB triple, matching three's working colour space. */
function lin(hex) {
  let c = _lin.get(hex);
  if (!c) {
    const t = new THREE.Color(hex);
    c = [t.r, t.g, t.b];
    _lin.set(hex, c);
  }
  return c;
}

/**
 * Contact occlusion ramp. The bottom half-metre of every prop is darkened so it
 * bites into the pavement even when the shadow map cannot resolve it.
 */
const AO_H = 0.55;
const AO_MIN = 0.68;
function aoAt(y) {
  const t = y <= 0 ? 0 : y >= AO_H ? 1 : y / AO_H;
  return AO_MIN + (1 - AO_MIN) * (t * t * (3 - 2 * t));
}

/* ========================================================== mesher ====== */

/**
 * Tiny geometry accumulator. Everything a prop is made of lands in one
 * position/normal/color/index buffer, so a whole object is one merged
 * BufferGeometry and therefore one instanced draw.
 *
 * A rotation+translation is carried on the builder itself (`xform`) so angled
 * sub-parts — a street-name blade, a canted sign, a chair turned to the table —
 * can reuse the axis-aligned primitives instead of needing their own maths.
 */
class M {
  constructor() {
    this.p = []; this.n = []; this.c = []; this.i = [];
    this.v = 0;
    this.cr = 1; this.cg = 1; this.cb = 1;
    this.sa = 0; this.ca = 1; this.ox = 0; this.oy = 0; this.oz = 0;
  }

  col(hex, k = 1) {
    const c = lin(hex);
    this.cr = c[0] * k; this.cg = c[1] * k; this.cb = c[2] * k;
    return this;
  }

  /** Set a local yaw + offset applied to every subsequent vertex. */
  xform(ang = 0, ox = 0, oy = 0, oz = 0) {
    this.sa = Math.sin(ang); this.ca = Math.cos(ang);
    this.ox = ox; this.oy = oy; this.oz = oz;
    return this;
  }
  reset() { return this.xform(0, 0, 0, 0); }

  _v(x, y, z, nx, ny, nz) {
    const wx = x * this.ca + z * this.sa + this.ox;
    const wz = -x * this.sa + z * this.ca + this.oz;
    const wy = y + this.oy;
    const mx = nx * this.ca + nz * this.sa;
    const mz = -nx * this.sa + nz * this.ca;
    const a = aoAt(wy);
    this.p.push(wx, wy, wz);
    this.n.push(mx, ny, mz);
    this.c.push(this.cr * a, this.cg * a, this.cb * a);
    return this.v++;
  }

  tri(A, B, C) {
    const nx = (B[1] - A[1]) * (C[2] - A[2]) - (B[2] - A[2]) * (C[1] - A[1]);
    const ny = (B[2] - A[2]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[2] - A[2]);
    const nz = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
    const l = Math.hypot(nx, ny, nz) || 1;
    const a = this._v(A[0], A[1], A[2], nx / l, ny / l, nz / l);
    const b = this._v(B[0], B[1], B[2], nx / l, ny / l, nz / l);
    const c = this._v(C[0], C[1], C[2], nx / l, ny / l, nz / l);
    this.i.push(a, b, c);
    return this;
  }

  /** Flat-shaded quad, wound A-B-C-D. */
  quad(A, B, C, D) {
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
    const vx = D[0] - A[0], vy = D[1] - A[1], vz = D[2] - A[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const a = this._v(A[0], A[1], A[2], nx, ny, nz);
    const b = this._v(B[0], B[1], B[2], nx, ny, nz);
    const c = this._v(C[0], C[1], C[2], nx, ny, nz);
    const d = this._v(D[0], D[1], D[2], nx, ny, nz);
    this.i.push(a, b, c, a, c, d);
    return this;
  }

  /**
   * Swept rectangular prism. `secs` is [[y, w, d], ...] bottom to top, so a
   * chamfer is just an extra section 3 cm below the top with 3 cm less width.
   */
  prism(cx, cz, secs, opts = {}) {
    const cols = opts.cols;
    for (let g = 0; g < secs.length - 1; g++) {
      if (cols && cols[g] !== undefined) this.col(cols[g]);
      const [y0, w0, d0] = secs[g];
      const [y1, w1, d1] = secs[g + 1];
      const a0 = w0 / 2, b0 = d0 / 2, a1 = w1 / 2, b1 = d1 / 2;
      // +z, +x, -z, -x
      this.quad([cx - a0, y0, cz + b0], [cx + a0, y0, cz + b0], [cx + a1, y1, cz + b1], [cx - a1, y1, cz + b1]);
      this.quad([cx + a0, y0, cz + b0], [cx + a0, y0, cz - b0], [cx + a1, y1, cz - b1], [cx + a1, y1, cz + b1]);
      this.quad([cx + a0, y0, cz - b0], [cx - a0, y0, cz - b0], [cx - a1, y1, cz - b1], [cx + a1, y1, cz - b1]);
      this.quad([cx - a0, y0, cz - b0], [cx - a0, y0, cz + b0], [cx - a1, y1, cz + b1], [cx - a1, y1, cz - b1]);
    }
    if (opts.capTop !== false) {
      if (cols && cols[secs.length - 2] !== undefined) this.col(cols[secs.length - 2]);
      const [y, w, d] = secs[secs.length - 1];
      this.quad(
        [cx - w / 2, y, cz + d / 2], [cx + w / 2, y, cz + d / 2],
        [cx + w / 2, y, cz - d / 2], [cx - w / 2, y, cz - d / 2]
      );
    }
    if (opts.capBot) {
      const [y, w, d] = secs[0];
      this.quad(
        [cx - w / 2, y, cz - d / 2], [cx + w / 2, y, cz - d / 2],
        [cx + w / 2, y, cz + d / 2], [cx - w / 2, y, cz + d / 2]
      );
    }
    return this;
  }

  /** Axis-aligned box, base-anchored at y, centred on x/z. */
  box(cx, y, cz, w, h, d, cap = true) {
    return this.prism(cx, cz, [[y, w, d], [y + h, w, d]], { capTop: cap });
  }

  /**
   * Swept round tube with radial (smooth) normals. `secs` is [[y, r], ...] or
   * [[y, rx, rz]]. Six to eight segments is enough to read round on a prop.
   */
  tube(cx, cz, secs, segs = 8, opts = {}) {
    const rot = opts.rot || 0;
    const cols = opts.cols;
    const rx = (s) => s[1];
    const rz = (s) => (s.length > 2 ? s[2] : s[1]);
    for (let g = 0; g < secs.length - 1; g++) {
      if (cols && cols[g] !== undefined) this.col(cols[g]);
      const s0 = secs[g], s1 = secs[g + 1];
      const dy = Math.max(1e-4, s1[0] - s0[0]);
      const slope = (rx(s0) - rx(s1)) / dy;   // outward tilt of the wall
      const ny = slope / Math.sqrt(1 + slope * slope);
      const nk = 1 / Math.sqrt(1 + slope * slope);
      for (let k = 0; k < segs; k++) {
        const a0 = rot + (k / segs) * TAU;
        const a1 = rot + ((k + 1) / segs) * TAU;
        const c0 = Math.cos(a0), q0 = Math.sin(a0);
        const c1 = Math.cos(a1), q1 = Math.sin(a1);
        const A = [cx + c0 * rx(s0), s0[0], cz + q0 * rz(s0)];
        const B = [cx + c1 * rx(s0), s0[0], cz + q1 * rz(s0)];
        const C = [cx + c1 * rx(s1), s1[0], cz + q1 * rz(s1)];
        const D = [cx + c0 * rx(s1), s1[0], cz + q0 * rz(s1)];
        const ia = this._v(A[0], A[1], A[2], c0 * nk, ny, q0 * nk);
        const ib = this._v(B[0], B[1], B[2], c1 * nk, ny, q1 * nk);
        const ic = this._v(C[0], C[1], C[2], c1 * nk, ny, q1 * nk);
        const id = this._v(D[0], D[1], D[2], c0 * nk, ny, q0 * nk);
        this.i.push(ia, ib, ic, ia, ic, id);
      }
    }
    if (opts.capTop) {
      const s = secs[secs.length - 1];
      if (cols && cols[secs.length - 2] !== undefined) this.col(cols[secs.length - 2]);
      const idx = [];
      for (let k = 0; k < segs; k++) {
        const a = rot + (k / segs) * TAU;
        idx.push(this._v(cx + Math.cos(a) * rx(s), s[0], cz + Math.sin(a) * rz(s), 0, 1, 0));
      }
      for (let k = 1; k < segs - 1; k++) this.i.push(idx[0], idx[k], idx[k + 1]);
    }
    if (opts.capBot) {
      const s = secs[0];
      const idx = [];
      for (let k = 0; k < segs; k++) {
        const a = rot + (k / segs) * TAU;
        idx.push(this._v(cx + Math.cos(a) * rx(s), s[0], cz + Math.sin(a) * rz(s), 0, -1, 0));
      }
      for (let k = 1; k < segs - 1; k++) this.i.push(idx[0], idx[k + 1], idx[k]);
    }
    return this;
  }

  /** Flat polygon standing in the XY plane, extruded `t` along z. Signs. */
  discZ(cx, cy, r, t, segs = 8, rot = 0, rz2 = null) {
    const ry = rz2 === null ? r : rz2;
    const front = [], back = [];
    for (let k = 0; k < segs; k++) {
      const a = rot + (k / segs) * TAU;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * ry;
      front.push(this._v(x, y, t / 2, 0, 0, 1));
      back.push(this._v(x, y, -t / 2, 0, 0, -1));
    }
    for (let k = 1; k < segs - 1; k++) {
      this.i.push(front[0], front[k], front[k + 1]);
      this.i.push(back[0], back[k + 1], back[k]);
    }
    for (let k = 0; k < segs; k++) {
      const k2 = (k + 1) % segs;
      const a = rot + ((k + 0.5) / segs) * TAU;
      const nx = Math.cos(a), ny = Math.sin(a);
      const p0 = [cx + Math.cos(rot + (k / segs) * TAU) * r, cy + Math.sin(rot + (k / segs) * TAU) * ry];
      const p1 = [cx + Math.cos(rot + (k2 / segs) * TAU) * r, cy + Math.sin(rot + (k2 / segs) * TAU) * ry];
      const ia = this._v(p0[0], p0[1], t / 2, nx, ny, 0);
      const ib = this._v(p1[0], p1[1], t / 2, nx, ny, 0);
      const ic = this._v(p1[0], p1[1], -t / 2, nx, ny, 0);
      const id = this._v(p0[0], p0[1], -t / 2, nx, ny, 0);
      this.i.push(ia, ib, ic, ia, ic, id);
    }
    return this;
  }

  /** Single flat polygon facing +z. Sign faces, where an extrusion is waste. */
  faceZ(cx, cy, z, r, segs = 8, rot = 0) {
    const idx = [];
    for (let k = 0; k < segs; k++) {
      const a = rot + (k / segs) * TAU;
      idx.push(this._v(cx + Math.cos(a) * r, cy + Math.sin(a) * r, z, 0, 0, 1));
    }
    for (let k = 1; k < segs - 1; k++) this.i.push(idx[0], idx[k], idx[k + 1]);
    return this;
  }

  /** Rectangular beam between two arbitrary points. Frames, legs, rails. */
  beam(ax, ay, az, bx, by, bz, w, h, caps = true) {
    let dx = bx - ax, dy = by - ay, dz = bz - az;
    const L = Math.hypot(dx, dy, dz) || 1;
    dx /= L; dy /= L; dz /= L;
    let ux = 0, uy = 1, uz = 0;
    if (Math.abs(dy) > 0.94) { ux = 1; uy = 0; }
    let sx = uy * dz - uz * dy, sy = uz * dx - ux * dz, sz = ux * dy - uy * dx;
    let sl = Math.hypot(sx, sy, sz) || 1;
    sx /= sl; sy /= sl; sz /= sl;
    const tx = dy * sz - dz * sy, ty = dz * sx - dx * sz, tz = dx * sy - dy * sx;
    const hw = w / 2, hh = h / 2;
    const P = (px, py, pz, a, b) => [
      px + sx * a + tx * b, py + sy * a + ty * b, pz + sz * a + tz * b,
    ];
    const A0 = P(ax, ay, az, -hw, -hh), A1 = P(ax, ay, az, hw, -hh);
    const A2 = P(ax, ay, az, hw, hh), A3 = P(ax, ay, az, -hw, hh);
    const B0 = P(bx, by, bz, -hw, -hh), B1 = P(bx, by, bz, hw, -hh);
    const B2 = P(bx, by, bz, hw, hh), B3 = P(bx, by, bz, -hw, hh);
    this.quad(A0, A1, B1, B0);
    this.quad(A1, A2, B2, B1);
    this.quad(A2, A3, B3, B2);
    this.quad(A3, A0, B0, B3);
    if (caps) { this.quad(A3, A2, A1, A0); this.quad(B0, B1, B2, B3); }
    return this;
  }

  /**
   * Flat board spanning (y0,z0) -> (y1,z1) in the YZ plane, `w` wide along x.
   * Canted panels — sandwich boards, lounger backs, hoarding — need a tilt that
   * `prism` cannot express and `beam` gets the roll wrong on.
   */
  board(cx, w, y0, z0, y1, z1, t) {
    const dy = y1 - y0, dz = z1 - z0;
    const L = Math.hypot(dy, dz) || 1;
    const ny = dz / L, nz = -dy / L;
    const hx = w / 2, ht = t / 2;
    const V = (sx, far, sn) => [
      cx + sx * hx,
      (far ? y1 : y0) + ny * ht * sn,
      (far ? z1 : z0) + nz * ht * sn,
    ];
    const A = V(-1, 0, 1), B = V(1, 0, 1), C = V(1, 1, 1), D = V(-1, 1, 1);
    const E = V(-1, 0, -1), F = V(1, 0, -1), G = V(1, 1, -1), H = V(-1, 1, -1);
    this.quad(A, B, C, D);
    this.quad(F, E, H, G);
    this.quad(E, F, B, A);
    this.quad(D, C, G, H);
    this.quad(E, A, D, H);
    this.quad(B, F, G, C);
    return this;
  }

  /** Horizontal quad — table tops, panels, plates. */
  plate(cx, y, cz, w, d) {
    return this.quad(
      [cx - w / 2, y, cz + d / 2], [cx + w / 2, y, cz + d / 2],
      [cx + w / 2, y, cz - d / 2], [cx - w / 2, y, cz - d / 2]
    );
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.p), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.n), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.c), 3));
    g.setIndex(this.v > 65535
      ? new THREE.BufferAttribute(new Uint32Array(this.i), 1)
      : new THREE.BufferAttribute(new Uint16Array(this.i), 1));
    g.computeBoundingSphere();
    return g;
  }
}

/* ======================================================== materials ===== */

const MATS = {};
function mat(kind) {
  if (MATS[kind]) return MATS[kind];
  let m;
  if (kind === 'metal') {
    m = solid({ vertexColors: true, roughness: 0.34, metalness: 0.52, envMapIntensity: 1.0 });
  } else if (kind === 'gloss') {
    // Stylised shelter / kiosk glazing: opaque on purpose. Instanced transparency
    // has no reliable sort order, and a frosted opaque panel reads the same from
    // the game camera without ever showing a sorting seam.
    m = solid({ vertexColors: true, roughness: 0.16, metalness: 0.16, envMapIntensity: 1.7 });
  } else if (kind === 'fabric') {
    m = solid({ vertexColors: true, roughness: 0.88, metalness: 0.0, envMapIntensity: 0.5 });
  } else {
    m = solid({ vertexColors: true, roughness: 0.63, metalness: 0.04, envMapIntensity: 0.7 });
  }
  MATS[kind] = m;
  return m;
}

/* ========================================================== shapes ====== */
/* Every builder is authored facing +z, base at y = 0, in metres.            */

const P = PALETTE;

/* -- litter / kerbside ---------------------------------------------------- */

function gCone(m) {
  m.tube(0, 0, [[0, 0.30], [0.07, 0.15], [0.34, 0.105], [0.46, 0.086], [0.72, 0.028]], 7, {
    capTop: true,
    cols: [P.CONE_ORANGE, P.CONE_ORANGE, P.CONE_STRIPE, P.CONE_ORANGE],
  });
}

function gBollard(m) {
  m.tube(0, 0, [[0, 0.155], [0.07, 0.125], [0.84, 0.118], [0.95, 0.072]], 6, {
    capTop: true, cols: [P.BOLLARD_DARK, P.BOLLARD_DARK, P.CHROME],
  });
}

function gBollardStone(m) {
  m.col(P.PRECAST).prism(0, 0, [
    [0, 0.38, 0.38], [0.07, 0.31, 0.31], [0.76, 0.29, 0.29], [0.88, 0.23, 0.23],
  ], { cols: [P.CONCRETE_DARK, P.PRECAST, P.PRECAST] });
}

function gHydrant(m) {
  m.tube(0, 0, [[0, 0.24], [0.06, 0.155], [0.56, 0.155], [0.62, 0.19]], 6, {
    cols: [P.HYDRANT_RED, P.HYDRANT_RED, P.HYDRANT_RED],
  });
  m.tube(0, 0, [[0.62, 0.19], [0.80, 0.085]], 6, { capTop: true, cols: [P.HYDRANT_YELLOW] });
  m.col(P.HYDRANT_YELLOW);
  m.beam(-0.14, 0.36, 0, -0.27, 0.36, 0, 0.14, 0.14);
}

function gUplighter(m) {
  m.col(P.STEEL_DARK).tube(0, 0, [[0, 0.16], [0.18, 0.12]], 5, { capTop: false });
  m.col(P.LAMP_GLOW).tube(0, 0, [[0.18, 0.115], [0.21, 0.10]], 5, { capTop: true });
}

function gMooringCleat(m) {
  m.col(P.STEEL_DARK);
  m.tube(0, 0, [[0, 0.13], [0.06, 0.12]], 6, { capTop: true });
  m.beam(-0.13, 0.14, 0, 0.13, 0.14, 0, 0.10, 0.10);
  m.beam(-0.22, 0.20, 0, 0.22, 0.20, 0, 0.09, 0.09);
}

/* -- bins ----------------------------------------------------------------- */

function gBinMuni(m) {
  m.tube(0, 0, [[0, 0.34], [0.09, 0.33], [0.78, 0.37]], 6, {
    cols: [P.BENCH_METAL, P.BIN_GREEN],
  });
  m.tube(0, 0, [[0.78, 0.41], [0.88, 0.40], [1.00, 0.24]], 6, {
    capTop: true, cols: [P.BENCH_METAL, P.BENCH_METAL],
  });
}

/** Wheelie bin — body left near-white so the instance hex sets the colour. */
function gBinWheelie(m) {
  m.col(0x2b2f33).prism(0, 0, [[0, 0.30, 0.36], [0.17, 0.54, 0.46]]);
  m.col(0xf4f4f4).prism(0, 0, [[0.17, 0.54, 0.46], [0.94, 0.60, 0.53]]);
  m.col(0xdadada).prism(0, 0.02, [[0.94, 0.62, 0.55], [1.02, 0.60, 0.51]]);
  m.col(0x33383c);
  m.beam(-0.26, 1.03, -0.24, 0.26, 1.03, -0.24, 0.05, 0.05);
}

function gBinMesh(m) {
  m.col(P.BENCH_METAL).prism(0, 0, [[0, 0.30, 0.30], [0.09, 0.37, 0.37], [0.80, 0.39, 0.39]]);
  m.col(P.STEEL_DARK).prism(0, 0, [[0.80, 0.43, 0.43], [0.88, 0.41, 0.41]]);
}

/* -- seating -------------------------------------------------------------- */

function gBenchSlat(m) {
  // Timber slats on cast-iron ends — the standard Miami park bench.
  m.col(P.BENCH_WOOD);
  m.prism(0, 0.03, [[0.44, 1.94, 0.46], [0.50, 1.94, 0.44]]);
  m.col(P.BENCH_WOOD, 0.94);
  m.beam(-0.95, 0.76, -0.20, 0.95, 0.76, -0.20, 0.06, 0.30);
  m.col(P.BENCH_METAL);
  for (const s of [-1, 1]) {
    m.beam(s * 0.86, 0.0, 0.22, s * 0.86, 0.46, 0.20, 0.07, 0.07);
    m.beam(s * 0.86, 0.0, -0.22, s * 0.86, 0.90, -0.22, 0.07, 0.07);
    m.beam(s * 0.86, 0.46, 0.22, s * 0.86, 0.46, -0.22, 0.07, 0.07);
  }
}

function gBenchConcrete(m) {
  m.col(P.PRECAST).prism(0, 0, [
    [0, 0.52, 0.50], [0.06, 0.60, 0.56], [0.40, 0.60, 0.56], [0.46, 2.20, 0.62], [0.50, 2.16, 0.58],
  ]);
  m.col(P.TEAK).prism(0, 0, [[0.50, 2.10, 0.54], [0.56, 2.06, 0.50]]);
}

function gBenchBackless(m) {
  m.col(P.WOOD_DECK).prism(0, 0, [[0.40, 1.70, 0.44], [0.46, 1.66, 0.40]]);
  m.col(P.BENCH_METAL);
  for (const s of [-1, 1]) {
    m.beam(s * 0.68, 0, 0.16, s * 0.68, 0.41, 0.14, 0.07, 0.07);
    m.beam(s * 0.68, 0, -0.16, s * 0.68, 0.41, -0.14, 0.07, 0.07);
  }
}

function gPicnicTable(m) {
  m.col(P.WOOD_DECK).prism(0, 0, [[0.70, 2.00, 0.86], [0.76, 1.96, 0.82]]);
  m.col(P.WOOD_LIGHT);
  for (const s of [-1, 1]) {
    m.prism(0, s * 0.76, [[0.44, 1.96, 0.32], [0.49, 1.92, 0.28]]);
  }
  m.col(P.WOOD_DARK);
  for (const s of [-1, 1]) {
    m.beam(s * 0.80, 0, 0.86, s * 0.80, 0.70, 0.10, 0.09, 0.09);
    m.beam(s * 0.80, 0, -0.86, s * 0.80, 0.70, -0.10, 0.09, 0.09);
  }
}

function gLounger(m) {
  m.col(0xf2f2f2);
  m.prism(0, 0.18, [[0.40, 0.66, 1.24], [0.45, 0.62, 1.20]]);
  m.board(0, 0.62, 0.44, -0.44, 0.90, -0.84, 0.06);
  m.col(P.WOOD_DARK);
  for (const s of [-1, 1]) {
    m.beam(s * 0.30, 0, 0.68, s * 0.30, 0.41, 0.68, 0.06, 0.06, false);
    m.beam(s * 0.30, 0, -0.34, s * 0.30, 0.41, -0.34, 0.06, 0.06, false);
  }
}

/* -- signage -------------------------------------------------------------- */

function pole(m, h, r = 0.045, hex = P.SIGN_POLE) {
  m.col(hex).tube(0, 0, [[0, r * 1.5], [0.05, r], [h, r * 0.92]], 6, { capTop: true });
}

function gSignStop(m) {
  pole(m, 2.35);
  // The plate is extruded; the white ring and red centre are single faces on
  // the front, which is all the camera ever sees of them.
  m.col(P.HYDRANT_RED).discZ(0, 2.30, 0.40, 0.055, 8, Math.PI / 8);
  m.col(P.SIGN_FACE).faceZ(0, 2.30, 0.032, 0.345, 8, Math.PI / 8);
  m.col(P.HYDRANT_RED).faceZ(0, 2.30, 0.036, 0.30, 8, Math.PI / 8);
}

function gSignNoEntry(m) {
  pole(m, 2.30);
  m.col(P.HYDRANT_RED).discZ(0, 2.26, 0.34, 0.05, 8);
  m.col(P.SIGN_FACE).xform(0, 0, 0, 0.03).prism(0, 0, [[2.19, 0.46, 0.02], [2.33, 0.46, 0.02]]);
  m.reset();
}

function gSignOneWay(m) {
  pole(m, 2.45);
  m.col(P.SIGN_DARK).xform(0, 0, 0, 0.04).prism(0, 0, [[2.16, 1.05, 0.05], [2.46, 1.05, 0.05]]);
  m.col(P.SIGN_FACE).xform(0, 0, 0, 0.068);
  m.prism(-0.22, 0, [[2.28, 0.42, 0.02], [2.34, 0.42, 0.02]]);
  m.tri([0.02, 2.24, 0], [0.30, 2.31, 0], [0.02, 2.38, 0]);
  m.reset();
}

function gSignParking(m) {
  pole(m, 2.55);
  m.col(P.SIGN_BLUE).xform(0, 0, 0, 0.04).prism(0, 0, [[1.96, 0.44, 0.045], [2.58, 0.44, 0.045]]);
  m.col(P.SIGN_FACE).xform(0, 0, 0, 0.068).prism(0, 0, [[2.16, 0.16, 0.02], [2.42, 0.16, 0.02]]);
  m.reset();
}

function gSignStreet(m) {
  pole(m, 2.90, 0.05);
  m.col(P.SIGN_GREEN);
  m.prism(0, 0, [[2.62, 1.30, 0.06], [2.86, 1.30, 0.06]]);
  m.xform(Math.PI / 2, 0, 0, 0).prism(0, 0, [[2.34, 1.10, 0.06], [2.56, 1.10, 0.06]]);
  m.reset();
  m.col(P.SIGN_FACE);
  m.prism(0, 0, [[2.70, 0.86, 0.075], [2.76, 0.86, 0.075]]);
}

function gSandwichBoard(m) {
  m.col(0x2b2822);
  m.board(0, 0.76, 0.03, 0.20, 0.94, 0.04, 0.05);   // chalkboard leaf, front
  m.board(0, 0.76, 0.03, -0.20, 0.94, -0.04, 0.05); // back leaf
  m.col(P.NEON_AQUA);
  m.board(0, 0.44, 0.60, 0.145, 0.66, 0.135, 0.02);
  m.col(P.SIGN_FACE);
  m.board(0, 0.34, 0.40, 0.155, 0.44, 0.148, 0.02);
}

function gValetStand(m) {
  m.col(P.SIGN_DARK).prism(0, 0, [[0, 0.62, 0.48], [0.06, 0.56, 0.42], [0.96, 0.56, 0.42], [1.04, 0.66, 0.52]]);
  m.col(P.TEAK).prism(0, 0, [[1.04, 0.68, 0.54], [1.10, 0.64, 0.50]]);
  m.col(P.ACCENT_HOT).prism(0, 0.28, [[1.10, 0.52, 0.03], [1.46, 0.52, 0.03]]);
  m.col(P.SIGN_FACE).prism(0, 0.30, [[1.22, 0.34, 0.02], [1.30, 0.34, 0.02]]);
}

function gStanchion(m) {
  m.col(P.CHROME);
  m.tube(0, 0, [[0, 0.17], [0.05, 0.15], [0.09, 0.055], [0.94, 0.05]], 6, { cols: [P.STEEL_DARK, P.STEEL_DARK, P.CHROME] });
  m.tube(0, 0, [[0.94, 0.075], [1.02, 0.065]], 6, { capTop: true });
  m.col(P.ACCENT_HOT);
  m.tube(0, 0, [[0.84, 0.07], [0.88, 0.07]], 6);
}

/* -- kerbside machines ---------------------------------------------------- */

function gMailbox(m) {
  m.col(0xf4f4f4);
  m.prism(0, 0, [[0.28, 0.70, 0.52], [0.98, 0.72, 0.54]]);
  m.tube(0, 0, [[0.98, 0.36, 0.27], [1.10, 0.34, 0.25], [1.20, 0.24, 0.17]], 6, { capTop: true, rot: 0 });
  m.col(0x2b2f33);
  m.prism(0, 0, [[0, 0.22, 0.30], [0.28, 0.56, 0.44]]);
  m.col(0xd8d8d8);
  m.prism(0, 0.28, [[0.70, 0.46, 0.04], [0.90, 0.46, 0.04]]);
}

function gParkingMeter(m) {
  m.col(P.PARKING_METER);
  m.tube(0, 0, [[0, 0.16], [0.05, 0.13], [1.02, 0.075]], 6, { cols: [P.STEEL_DARK, P.PARKING_METER] });
  m.prism(0, 0, [[1.02, 0.28, 0.22], [1.08, 0.32, 0.26], [1.42, 0.32, 0.26], [1.48, 0.27, 0.21]]);
  m.col(P.SIGN_DARK).prism(0, 0.135, [[1.14, 0.22, 0.02], [1.34, 0.22, 0.02]]);
  m.col(P.NEON_AQUA).prism(0, 0.145, [[1.20, 0.16, 0.01], [1.28, 0.16, 0.01]]);
}

function gNewsBox(m) {
  m.col(0xf0f0f0);
  m.prism(0, 0, [[0.22, 0.50, 0.44], [1.02, 0.52, 0.46], [1.10, 0.48, 0.42]]);
  m.col(P.SIGN_DARK);
  m.prism(0, 0, [[0, 0.16, 0.16], [0.22, 0.44, 0.40]]);
  m.prism(0, 0.235, [[0.60, 0.40, 0.02], [0.96, 0.40, 0.02]]);
  m.col(P.SIGN_FACE);
  m.prism(0, 0.245, [[0.68, 0.32, 0.01], [0.90, 0.32, 0.01]]);
}

function gUtilityBox(m) {
  m.col(P.CONCRETE_DARK).prism(0, 0, [[0, 0.92, 0.56], [0.09, 0.86, 0.50]]);
  m.col(P.ALUMINIUM).prism(0, 0, [[0.09, 0.84, 0.48], [1.24, 0.86, 0.50], [1.32, 0.80, 0.44]]);
  m.col(P.STEEL_DARK).prism(0, 0.255, [[0.24, 0.68, 0.02], [1.16, 0.68, 0.02]]);
  m.col(P.SIGN_FACE).prism(0.28, 0.26, [[0.94, 0.16, 0.01], [1.08, 0.16, 0.01]]);
}

function gAtmKiosk(m) {
  m.col(P.CONCRETE_DARK).prism(0, 0, [[0, 1.10, 0.86], [0.10, 1.02, 0.78]]);
  m.col(0xf0ece2).prism(0, 0, [[0.10, 1.00, 0.76], [2.02, 1.02, 0.78], [2.12, 0.94, 0.70]]);
  m.col(P.SIGN_DARK).prism(0, 0.39, [[0.94, 0.72, 0.03], [1.62, 0.72, 0.03]]);
  m.col(P.NEON_BLUE).prism(0, 0.40, [[1.24, 0.48, 0.02], [1.52, 0.48, 0.02]]);
  m.col(P.ACCENT_SUN).prism(0, 0, [[2.12, 0.96, 0.72], [2.22, 0.90, 0.66]]);
}

function gPhoneKiosk(m) {
  m.col(P.STEEL_DARK).prism(0, 0, [[0, 0.72, 0.44], [0.10, 0.64, 0.36]]);
  m.col(0x30363a).prism(0, 0, [[0.10, 0.60, 0.32], [2.30, 0.64, 0.34]]);
  m.col(P.NEON_AQUA).prism(0, 0.18, [[0.90, 0.52, 0.02], [1.94, 0.52, 0.02]]);
  m.col(P.NEON_PINK).prism(0, -0.18, [[0.90, 0.52, 0.02], [1.94, 0.52, 0.02]]);
  m.col(P.ALUMINIUM).prism(0, 0, [[2.30, 0.72, 0.42], [2.40, 0.66, 0.36]]);
}

function gDrinkFountain(m) {
  m.col(P.PRECAST).prism(0, 0, [[0, 0.44, 0.38], [0.07, 0.38, 0.32], [0.86, 0.38, 0.32], [0.94, 0.52, 0.44]]);
  m.col(P.CONCRETE_DARK).prism(0, 0, [[0.94, 0.50, 0.42], [1.00, 0.44, 0.36]]);
  m.col(P.CHROME).beam(0, 0.98, -0.06, 0, 1.12, 0.06, 0.05, 0.05);
}

function gDogStation(m) {
  pole(m, 1.24, 0.045, P.SIGN_POLE);
  m.col(P.BIN_GREEN).prism(0, 0, [[0.62, 0.34, 0.24], [1.02, 0.36, 0.26], [1.08, 0.32, 0.22]]);
  m.col(P.SIGN_GREEN).prism(0, 0, [[1.24, 0.40, 0.03], [1.56, 0.40, 0.03]]);
  m.col(P.SIGN_FACE).prism(0, 0.02, [[1.32, 0.24, 0.01], [1.48, 0.24, 0.01]]);
}

/* -- planting ------------------------------------------------------------- */

/** Clipped shrub. Two rings, six sides: round enough, 28 triangles. */
function shrub(m, x, y, z, r, hex, segs = 6) {
  m.col(hex);
  m.tube(x, z, [[y, r * 0.74], [y + r * 0.80, r], [y + r * 1.9, r * 0.34]], segs, { capTop: true });
}

function gPlanterRound(m) {
  m.col(P.PLANTER).tube(0, 0, [[0, 0.54], [0.06, 0.51], [0.66, 0.62]], 7, {
    cols: [P.PLANTER_DARK, P.PLANTER],
  });
  m.col(P.MULCH).tube(0, 0, [[0.62, 0.55], [0.65, 0.52]], 7, { capTop: true });
  shrub(m, 0, 0.60, 0, 0.44, P.HEDGE, 6);
}

function gPlanterSquare(m) {
  m.col(P.PLANTER).prism(0, 0, [
    [0, 1.02, 1.02], [0.07, 0.96, 0.96], [0.72, 1.10, 1.10],
  ], { cols: [P.PLANTER_DARK, P.PLANTER], capTop: false });
  m.col(P.MULCH).plate(0, 0.68, 0, 1.02, 1.02);
  shrub(m, 0, 0.64, 0, 0.42, P.HEDGE_LIGHT, 6);
}

function gPlanterTrough(m) {
  m.col(P.PLANTER).prism(0, 0, [
    [0, 1.84, 0.60], [0.06, 1.78, 0.54], [0.58, 1.92, 0.68],
  ], { cols: [P.PLANTER_DARK, P.PLANTER], capTop: false });
  m.col(P.MULCH).plate(0, 0.54, 0, 1.82, 0.58);
  shrub(m, -0.48, 0.50, 0, 0.32, P.HEDGE, 5);
  shrub(m, 0.44, 0.50, 0, 0.30, P.HEDGE_LIGHT, 5);
  m.col(P.FLOWER_PINK);
  m.tube(0, 0.10, [[0.52, 0.20], [0.80, 0.10]], 5, { capTop: true });
}

function gPottedPalm(m) {
  m.col(P.TERRACOTTA).tube(0, 0, [[0, 0.38], [0.05, 0.36], [0.62, 0.47]], 6, {
    cols: [P.BRICK_DARK, P.TERRACOTTA],
  });
  m.col(P.MULCH).tube(0, 0, [[0.58, 0.42], [0.61, 0.40]], 6, { capTop: true });
  m.col(P.PALM_TRUNK).tube(0, 0, [[0.58, 0.10], [1.46, 0.07]], 5, { capTop: false });
  // Five fronds as flat tapered beams — cheaper than alpha cards, never pops.
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * TAU + 0.4;
    m.col(k % 2 ? P.PALM_FROND : P.PALM_FROND_DARK);
    m.beam(0, 1.46, 0, Math.cos(a) * 1.24, 1.52, Math.sin(a) * 1.24, 0.34, 0.04, false);
  }
}

function gHangBasket(m) {
  m.col(P.STEEL_DARK).beam(0, 0, 0, 0, 0.28, 0, 0.03, 0.03, false);
  m.col(P.PLANTER_DARK).tube(0, 0, [[0.28, 0.30], [0.46, 0.32]], 6, { capTop: false });
  shrub(m, 0, 0.40, 0, 0.30, P.FLOWER_MAGENTA, 5);
}

/* -- café terrace --------------------------------------------------------- */

function gCafeTable(m) {
  m.col(P.STEEL_DARK);
  m.tube(0, 0, [[0, 0.30], [0.05, 0.055], [0.70, 0.05]], 6);
  m.col(P.TABLE_TOP);
  m.tube(0, 0, [[0.70, 0.44], [0.76, 0.42]], 8, { capTop: true });
}

function gCafeChair(m) {
  m.col(0xf6f2e8);
  m.prism(0, 0, [[0.42, 0.46, 0.44], [0.47, 0.44, 0.42]]);
  m.board(0, 0.44, 0.47, -0.20, 0.90, -0.24, 0.06);
  m.col(0xe2ddd0);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    m.beam(sx * 0.18, 0, sz * 0.17, sx * 0.21, 0.44, sz * 0.20, 0.045, 0.045, false);
  }
}

/**
 * Canopy: a shallow two-stage cone closed underneath. Modelling the underside
 * as its own inverted surface would double the cost and show back faces from
 * below, so the bottom is a single downward-facing disc instead.
 */
function canopy(m, y0, r0, y1, r1, y2, segs = 8) {
  m.tube(0, 0, [[y0, r0], [y1, r1], [y2, 0.085]], segs, { capTop: true, capBot: true });
}

function gUmbrella(m) {
  m.col(P.STEEL_DARK);
  m.tube(0, 0, [[0, 0.34], [0.05, 0.30], [0.07, 0.05], [2.14, 0.045]], 6);
  m.col(0xffffff);
  canopy(m, 2.14, 1.26, 2.26, 1.10, 2.50);
  m.col(P.STEEL_DARK);
  m.tube(0, 0, [[2.50, 0.05], [2.62, 0.035]], 5, { capTop: true });
}

function gBeachParasol(m) {
  m.col(P.WOOD_DARK);
  m.tube(0, 0, [[0, 0.06], [2.02, 0.05]], 6);
  m.col(0xffffff);
  canopy(m, 2.02, 1.42, 2.16, 1.20, 2.46);
}

function gPatioHeater(m) {
  m.col(P.STEEL_DARK).tube(0, 0, [[0, 0.42], [0.09, 0.38]], 8, { capTop: true });
  m.col(P.CHROME).tube(0, 0, [[0.09, 0.11], [1.62, 0.10]], 6);
  m.col(P.ALUMINIUM).tube(0, 0, [[1.62, 0.16], [1.78, 0.30], [1.86, 0.28]], 8);
  m.col(P.LAMP_GLOW).tube(0, 0, [[1.86, 0.28], [1.90, 0.27]], 8);
  m.col(P.ALUMINIUM).tube(0, 0, [[1.90, 0.30], [1.98, 0.62], [2.10, 0.56]], 8, { capTop: true, capBot: true });
}

function gStringPole(m) {
  m.col(P.WOOD_DARK);
  m.tube(0, 0, [[0, 0.24], [0.08, 0.20]], 6, { capTop: true });
  m.tube(0, 0, [[0.08, 0.09], [3.30, 0.075]], 6, { capTop: true });
  m.col(P.STEEL_DARK).beam(0, 3.24, 0, 0.9, 3.16, 0, 0.03, 0.03, false);
  m.col(P.LAMP_GLOW);
  for (let k = 1; k <= 4; k++) {
    m.tube(k * 0.22, 0, [[3.24 - k * 0.018, 0.05], [3.16 - k * 0.018, 0.045]], 5, { capTop: true });
  }
}

/* -- micromobility -------------------------------------------------------- */

/** Wheel whose axle runs along +z (the object then points along x). */
function wheelZ(m, x, y, r, t, segs = 9) {
  m.xform(0, x, y, 0);
  m.discZ(0, 0, r, t, segs, 0, r);
  m.reset();
}

/** Wheel whose axle runs along +x (the object then points along z). */
function wheelX(m, z, y, x, r, t, segs = 7) {
  m.xform(Math.PI / 2, x, y, z);
  m.discZ(0, 0, r, t, segs, 0, r);
  m.reset();
}

function gBicycle(m) {
  // Wheels lie in the XY plane, so the bike points along +x; the placer turns it.
  m.col(P.TYRE);
  wheelZ(m, -0.55, 0.34, 0.34, 0.05);
  wheelZ(m, 0.55, 0.34, 0.34, 0.05);
  m.col(0xf2f2f2);
  m.beam(-0.55, 0.34, 0, -0.05, 0.62, 0, 0.05, 0.05, false);
  m.beam(-0.05, 0.62, 0, 0.42, 0.90, 0, 0.05, 0.05, false);
  m.beam(-0.05, 0.62, 0, 0.18, 0.36, 0, 0.05, 0.05, false);
  m.beam(0.18, 0.36, 0, 0.55, 0.34, 0, 0.05, 0.05, false);
  m.beam(0.42, 0.90, 0, 0.55, 0.34, 0, 0.05, 0.05, false);
  m.col(P.SIGN_DARK);
  m.beam(-0.10, 0.68, -0.09, -0.10, 0.68, 0.09, 0.20, 0.07);
  m.beam(0.44, 0.94, -0.22, 0.44, 0.94, 0.22, 0.05, 0.05);
}

function gBikeRack(m) {
  m.col(P.STEEL);
  // Inverted-U hoop.
  m.beam(-0.44, 0, 0, -0.44, 0.72, 0, 0.07, 0.07, false);
  m.beam(0.44, 0, 0, 0.44, 0.72, 0, 0.07, 0.07, false);
  m.beam(-0.44, 0.72, 0, 0.44, 0.72, 0, 0.07, 0.07);
  m.col(P.STEEL_DARK);
  m.beam(-0.44, 0.06, 0, 0.44, 0.06, 0, 0.05, 0.05, false);
}

function gScooter(m) {
  m.col(P.TYRE);
  wheelZ(m, -0.48, 0.13, 0.13, 0.05, 7);
  wheelZ(m, 0.42, 0.13, 0.13, 0.05, 7);
  m.col(0xf4f4f4);
  m.beam(-0.48, 0.16, 0, 0.42, 0.16, 0, 0.16, 0.06);
  m.prism(-0.05, 0, [[0.19, 0.62, 0.17], [0.23, 0.58, 0.15]]);
  m.beam(0.42, 0.18, 0, 0.50, 1.00, 0, 0.05, 0.05, false);
  m.col(P.SIGN_DARK);
  m.beam(0.50, 1.00, -0.22, 0.50, 1.00, 0.22, 0.05, 0.05);
  m.col(P.NEON_AQUA);
  m.prism(-0.05, 0, [[0.235, 0.34, 0.13], [0.245, 0.34, 0.13]]);
}

/* -- lighting ------------------------------------------------------------- */

function gLampModern(m) {
  // The arm reaches along +z, i.e. outward over the carriageway once the
  // placer has turned the post to face the street.
  m.col(P.STEEL_DARK).tube(0, 0, [[0, 0.24], [0.16, 0.20], [0.22, 0.145]], 7, { capTop: false });
  m.col(P.LAMP_POST).tube(0, 0, [[0.22, 0.135], [6.60, 0.085]], 7, { capTop: false });
  m.col(P.LAMP_POST);
  m.beam(0, 6.56, 0, 0, 6.94, 0.34, 0.10, 0.10, false);
  m.beam(0, 6.94, 0.34, 0, 6.98, 1.52, 0.09, 0.09, false);
  m.col(P.ALUMINIUM).prism(0, 1.60, [[6.80, 0.30, 0.74], [6.96, 0.34, 0.80]]);
  m.col(P.LAMP_GLOW).plate(0, 6.795, 1.60, 0.24, 0.64);
}

/** Acorn globe: two rings is enough to read as a globe at any game distance. */
function globe(m, x, z, y, r, segs = 6) {
  m.tube(x, z, [[y, r * 0.62], [y + r * 0.78, r], [y + r * 2.0, r * 0.40]], segs, { capTop: true });
}

function gLampDeco(m) {
  m.col(P.BENCH_METAL);
  m.prism(0, 0, [[0, 0.44, 0.44], [0.10, 0.36, 0.36], [0.44, 0.26, 0.26]]);
  m.tube(0, 0, [[0.44, 0.115], [4.36, 0.085]], 6, { capTop: false });
  m.beam(-0.60, 4.44, 0, 0.60, 4.44, 0, 0.08, 0.08);
  for (const s of [-1, 1]) {
    m.col(P.BENCH_METAL);
    m.beam(s * 0.60, 4.42, 0, s * 0.60, 4.62, 0, 0.07, 0.07, false);
    m.col(P.LAMP_GLOW);
    globe(m, s * 0.60, 0, 4.62, 0.21, 6);
  }
}

function gLampPark(m) {
  m.col(P.BENCH_METAL);
  m.prism(0, 0, [[0, 0.34, 0.34], [0.08, 0.27, 0.27], [0.34, 0.18, 0.18]]);
  m.tube(0, 0, [[0.34, 0.085], [3.34, 0.07]], 6, { capTop: false });
  m.col(P.LAMP_GLOW);
  globe(m, 0, 0, 3.30, 0.25, 6);
}

/* -- transit -------------------------------------------------------------- */

function gBusShelter(m) {
  const L = 4.30, D = 1.55;
  m.col(P.STEEL_DARK);
  for (const x of [-L / 2 + 0.12, L / 2 - 0.12]) {
    m.beam(x, 0, -D / 2 + 0.1, x, 2.48, -D / 2 + 0.1, 0.12, 0.12, false);
  }
  m.beam(-L / 2, 0, D / 2 - 0.1, -L / 2, 2.48, D / 2 - 0.1, 0.12, 0.12, false);
  m.beam(L / 2 - 0.24, 0, D / 2 - 0.1, L / 2 - 0.24, 2.48, D / 2 - 0.1, 0.12, 0.12, false);
  // Back wall + one end wall in frosted glazing.
  m.col(P.GLASS_SKY, 1.06);
  m.prism(0, -D / 2 + 0.12, [[0.30, L - 0.30, 0.05], [2.36, L - 0.30, 0.05]]);
  m.prism(-L / 2 + 0.08, 0, [[0.30, 0.05, D - 0.30], [2.36, 0.05, D - 0.30]]);
  // Canopy, cantilevered a little past the posts so it reads from above.
  m.col(P.ALUMINIUM);
  m.prism(0, 0.05, [[2.48, L + 0.30, D + 0.42], [2.62, L + 0.22, D + 0.34]]);
  // Bench inside.
  m.col(P.TEAK);
  m.prism(0, -D / 2 + 0.38, [[0.44, L - 1.0, 0.40], [0.49, L - 1.06, 0.36]]);
  m.col(P.STEEL_DARK);
  for (const s of [-1, 1]) {
    m.beam(s * (L / 2 - 0.7), 0, -D / 2 + 0.38, s * (L / 2 - 0.7), 0.45, -D / 2 + 0.38, 0.06, 0.30, false);
  }
  // Advertising panel + timetable, the two things that make a shelter readable.
  m.col(P.SIGN_DARK);
  m.prism(L / 2 - 0.06, 0, [[0.30, 0.09, D - 0.30], [2.36, 0.09, D - 0.30]]);
  m.col(P.NEON_PINK);
  m.prism(L / 2 - 0.115, 0, [[0.80, 0.02, D - 0.62], [1.94, 0.02, D - 0.62]]);
  m.col(P.SIGN_FACE);
  m.prism(-L / 2 + 0.85, -D / 2 + 0.19, [[1.42, 0.60, 0.02], [1.96, 0.60, 0.02]]);
  m.col(P.SIGN_BLUE);
  m.prism(-L / 2 + 0.85, -D / 2 + 0.185, [[1.96, 0.66, 0.03], [2.10, 0.66, 0.03]]);
}

function gFoodCart(m) {
  m.col(P.TYRE);
  wheelX(m, 0.46, 0.20, -0.62, 0.20, 0.09);
  wheelX(m, 0.46, 0.20, 0.62, 0.20, 0.09);
  m.col(0xf4f4f4);
  m.prism(0, 0, [[0.34, 1.72, 0.92], [1.02, 1.78, 0.96], [1.08, 1.72, 0.90]]);
  m.col(P.ACCENT_HOT);
  m.prism(0, 0, [[0.58, 1.80, 0.98], [0.78, 1.80, 0.98]]);
  m.col(P.CHROME);
  m.prism(0, 0, [[1.08, 1.76, 0.94], [1.14, 1.70, 0.88]]);
  m.col(P.STEEL_DARK);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    m.beam(sx * 0.78, 1.14, sz * 0.40, sx * 0.72, 2.28, sz * 0.36, 0.05, 0.05, false);
  }
  m.col(P.FABRIC_SUN);
  m.prism(0, 0, [[2.20, 2.00, 1.24], [2.34, 1.30, 0.80], [2.46, 0.20, 0.14]]);
  m.col(P.FABRIC_WHITE);
  m.prism(0, 0, [[2.14, 2.06, 1.30], [2.20, 2.02, 1.26]]);
}

function gHotdogStand(m) {
  m.col(P.TYRE);
  wheelX(m, 0.28, 0.17, -0.46, 0.17, 0.08);
  wheelX(m, 0.28, 0.17, 0.46, 0.17, 0.08);
  m.col(P.CHROME);
  m.prism(0, 0, [[0.34, 1.18, 0.66], [0.92, 1.22, 0.70], [0.98, 1.16, 0.64]]);
  m.col(P.HYDRANT_RED);
  m.prism(0, 0, [[0.62, 1.26, 0.74], [0.78, 1.26, 0.74]]);
  m.col(P.STEEL_DARK);
  m.tube(0, 0, [[0.98, 0.045], [2.06, 0.04]], 5);
  m.col(P.FABRIC_CORAL);
  canopy(m, 2.02, 1.00, 2.14, 0.86, 2.40);
}

function gDisplayRack(m) {
  m.col(P.STEEL);
  for (const s of [-1, 1]) {
    m.beam(s * 0.62, 0, 0, s * 0.62, 1.52, 0, 0.05, 0.05, false);
    m.beam(s * 0.62, 0.04, -0.32, s * 0.62, 0.04, 0.32, 0.05, 0.05);
  }
  m.beam(-0.62, 1.50, 0, 0.62, 1.50, 0, 0.05, 0.05);
  // Hanging stock, blocked in so it reads as clothing at 4 m.
  const cols = [P.FABRIC_CORAL, P.FABRIC_AQUA, P.FABRIC_SUN, P.FABRIC_SKY, P.FABRIC_PINK];
  for (let k = 0; k < 6; k++) {
    m.col(cols[k % cols.length]);
    m.prism(-0.50 + k * 0.20, 0, [[0.74, 0.17, 0.30], [1.44, 0.15, 0.26]]);
  }
}

function gProduceCrate(m) {
  m.col(P.WOOD_LIGHT);
  m.prism(0, 0, [[0, 0.62, 0.44], [0.34, 0.64, 0.46]], { capTop: false });
  m.col(P.WOOD_DARK);
  m.prism(0, 0, [[0.34, 0.66, 0.48], [0.38, 0.62, 0.44]], { capTop: false });
  m.col(P.FLOWER_ORANGE);
  m.tube(-0.14, 0, [[0.32, 0.16], [0.44, 0.15], [0.50, 0.05]], 6, { capTop: true });
  m.col(P.GRASS_LIGHT);
  m.tube(0.16, 0.02, [[0.32, 0.16], [0.44, 0.15], [0.50, 0.05]], 6, { capTop: true });
}

/* -- construction --------------------------------------------------------- */

function gJersey(m) {
  m.col(P.CONCRETE_DARK);
  m.prism(0, 0, [
    [0, 2.00, 0.60], [0.10, 1.98, 0.56], [0.30, 1.98, 0.30],
    [0.72, 1.98, 0.24], [0.80, 1.94, 0.20],
  ], { cols: [P.CONCRETE_DARK, P.PRECAST, P.PRECAST, P.PRECAST] });
  m.col(P.ACCENT_SUN);
  m.prism(0, 0, [[0.56, 2.00, 0.27], [0.64, 2.00, 0.27]]);
}

function gWaterBarrier(m) {
  m.col(0xffffff);
  m.prism(0, 0, [
    [0, 0.58, 0.44], [0.06, 0.54, 0.40], [0.86, 0.56, 0.42], [0.94, 0.50, 0.36],
  ]);
  m.col(0xe8e8e8);
  m.prism(0, 0, [[0.34, 0.60, 0.46], [0.42, 0.60, 0.46]]);
  m.col(0xd8d8d8);
  m.prism(0, 0, [[0.94, 0.30, 0.22], [1.02, 0.26, 0.18]]);
}

function gAframe(m) {
  m.col(P.BARRIER_ORANGE);
  for (const s of [-1, 1]) {
    m.beam(-0.52, 0, s * 0.24, -0.52, 1.02, s * 0.05, 0.06, 0.06, false);
    m.beam(0.52, 0, s * 0.24, 0.52, 1.02, s * 0.05, 0.06, 0.06, false);
  }
  m.col(P.BARRIER_WHITE);
  m.prism(0, 0, [[0.52, 1.10, 0.06], [0.76, 1.10, 0.06]]);
  m.col(P.BARRIER_ORANGE);
  for (let k = 0; k < 4; k++) {
    m.prism(-0.42 + k * 0.28, 0, [[0.52, 0.13, 0.075], [0.76, 0.13, 0.075]]);
  }
  m.col(P.BARRIER_WHITE);
  m.prism(0, 0, [[0.86, 1.06, 0.06], [1.02, 1.06, 0.06]]);
}

function gTrafficBarrel(m) {
  m.tube(0, 0, [
    [0, 0.36], [0.05, 0.33], [0.30, 0.34], [0.42, 0.31],
    [0.60, 0.32], [0.72, 0.29], [0.92, 0.30],
  ], 8, {
    capTop: true,
    cols: [P.BARRIER_ORANGE, P.BARRIER_ORANGE, P.BARRIER_WHITE, P.BARRIER_ORANGE,
      P.BARRIER_WHITE, P.BARRIER_ORANGE],
  });
}

function gCrate(m) {
  m.col(P.WOOD_DECK);
  m.prism(0, 0, [[0, 0.78, 0.72], [0.06, 0.82, 0.76], [0.62, 0.82, 0.76], [0.68, 0.78, 0.72]]);
  m.col(P.WOOD_DARK);
  m.prism(0, 0, [[0.28, 0.84, 0.78], [0.36, 0.84, 0.78]]);
}

function gPallet(m) {
  m.col(P.WOOD_LIGHT);
  for (let k = 0; k < 3; k++) {
    const y = k * 0.16;
    m.prism(0, 0, [[y, 1.16, 0.98], [y + 0.05, 1.16, 0.98]]);
    m.col(P.WOOD_DARK);
    for (const s of [-1, 0, 1]) {
      m.prism(s * 0.46, 0, [[y + 0.05, 0.16, 0.92], [y + 0.11, 0.16, 0.92]]);
    }
    m.col(P.WOOD_LIGHT);
  }
}

function gScaffold(m) {
  m.col(P.SCAFFOLD);
  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) {
      m.beam(sx * 0.58, 0, sz * 0.42, sx * 0.58, 1.94, sz * 0.42, 0.07, 0.07, false);
    }
    m.beam(-0.58, 0.96, sz * 0.42, 0.58, 0.96, sz * 0.42, 0.06, 0.06, false);
    m.beam(-0.58, 1.90, sz * 0.42, 0.58, 1.90, sz * 0.42, 0.06, 0.06, false);
    m.beam(-0.58, 0.06, sz * 0.42, 0.58, 1.90, sz * 0.42, 0.05, 0.05, false);
  }
  m.col(P.WOOD_DECK);
  m.prism(0, 0, [[1.90, 1.24, 0.90], [1.96, 1.24, 0.90]]);
}

function gSandbags(m) {
  const rows = [
    [0, [-0.34, 0, 0.34]],
    [0.19, [-0.20, 0.20]],
    [0.38, [0]],
  ];
  for (let ri = 0; ri < rows.length; ri++) {
    const [y, xs] = rows[ri];
    for (const x of xs) {
      m.col(ri % 2 ? P.SAND_WET : P.SAND);
      m.tube(x, 0, [[y, 0.10, 0.16], [y + 0.09, 0.20, 0.20], [y + 0.19, 0.09, 0.15]], 6, { capTop: true });
    }
  }
}

function gPortaloo(m) {
  m.col(0xd8d8d8).prism(0, 0, [[0, 1.14, 1.14], [0.06, 1.10, 1.10]]);
  m.col(0xffffff).prism(0, 0, [[0.06, 1.08, 1.08], [2.16, 1.10, 1.10], [2.26, 1.02, 1.02]]);
  m.col(0xe2e2e2).prism(0, 0.56, [[0.10, 0.72, 0.02], [2.00, 0.72, 0.02]]);
  m.col(P.SIGN_BLUE).prism(0, 0.565, [[1.50, 0.26, 0.02], [1.76, 0.26, 0.02]]);
  m.col(P.STEEL_DARK).beam(0.28, 1.02, 0.58, 0.34, 1.02, 0.58, 0.05, 0.14);
}

/* ========================================================= catalogue ==== */

const T = TIER;

/**
 * key -> definition.
 *   r/h    physical radius + height, used by the eat physics
 *   cap    unused now (counts are exact), kept as documentation of intent
 *   tint   per-instance colour palette; body vertices must be near-white
 *   shadow only props tall enough to throw a shadow the map can resolve
 */
const DEFS = {
  /* litter + kerb ------------------------------------------------------- */
  cone: { g: gCone, tier: T.TINY, r: 0.30, h: 0.72, label: 'Traffic Cone', debris: P.CONE_ORANGE },
  bollard: { g: gBollard, tier: T.TINY, r: 0.16, h: 0.95, label: 'Bollard', debris: P.BOLLARD_DARK },
  bollardStone: { g: gBollardStone, tier: T.TINY, r: 0.20, h: 0.88, label: 'Stone Bollard', debris: P.PRECAST },
  hydrant: { g: gHydrant, tier: T.TINY, r: 0.25, h: 0.80, label: 'Fire Hydrant', debris: P.HYDRANT_RED },
  uplighter: { g: gUplighter, tier: T.TINY, r: 0.16, h: 0.22, label: 'Uplighter', debris: P.STEEL_DARK },
  cleat: { g: gMooringCleat, tier: T.TINY, r: 0.22, h: 0.25, label: 'Mooring Cleat', debris: P.STEEL_DARK },

  /* bins ----------------------------------------------------------------- */
  binMuni: { g: gBinMuni, tier: T.SMALL, r: 0.40, h: 1.00, label: 'Litter Bin', shadow: true, debris: P.BIN_GREEN },
  binWheelie: {
    g: gBinWheelie, tier: T.SMALL, r: 0.34, h: 1.06, label: 'Wheelie Bin', shadow: true,
    tint: [P.BIN_GREEN, P.BIN_BLUE, P.BIN_GREY, P.BIN_GREEN, P.BIN_BLUE], debris: P.BIN_GREEN,
  },
  binMesh: { g: gBinMesh, tier: T.SMALL, r: 0.28, h: 0.88, label: 'Wire Bin', debris: P.BENCH_METAL },

  /* seating -------------------------------------------------------------- */
  benchSlat: { g: gBenchSlat, tier: T.SMALL, r: 1.00, h: 0.90, label: 'Bench', shadow: true, debris: P.BENCH_WOOD },
  benchConcrete: { g: gBenchConcrete, tier: T.SMALL, r: 1.12, h: 0.56, label: 'Stone Bench', shadow: true, crumbles: true, debris: P.PRECAST },
  benchBackless: { g: gBenchBackless, tier: T.SMALL, r: 0.88, h: 0.46, label: 'Park Bench', debris: P.WOOD_DECK },
  picnicTable: { g: gPicnicTable, tier: T.MEDIUM, r: 1.10, h: 0.76, label: 'Picnic Table', shadow: true, debris: P.WOOD_DECK },
  lounger: { g: gLounger, tier: T.MEDIUM, r: 1.00, h: 0.90, label: 'Sun Lounger', shadow: true, debris: 0xf2f2f2 },

  /* signage -------------------------------------------------------------- */
  signStop: { g: gSignStop, tier: T.SMALL, r: 0.24, h: 2.70, label: 'Stop Sign', shadow: true, debris: P.HYDRANT_RED },
  signNoEntry: { g: gSignNoEntry, tier: T.SMALL, r: 0.22, h: 2.60, label: 'No Entry Sign', shadow: true, debris: P.HYDRANT_RED },
  signOneWay: { g: gSignOneWay, tier: T.SMALL, r: 0.28, h: 2.50, label: 'One Way Sign', shadow: true, debris: P.SIGN_DARK },
  signParking: { g: gSignParking, tier: T.SMALL, r: 0.22, h: 2.60, label: 'Parking Sign', shadow: true, debris: P.SIGN_BLUE },
  signStreet: { g: gSignStreet, tier: T.SMALL, r: 0.34, h: 2.90, label: 'Street Sign', shadow: true, debris: P.SIGN_GREEN },
  sandwichBoard: { g: gSandwichBoard, tier: T.SMALL, r: 0.42, h: 0.95, label: 'Sandwich Board', debris: P.SIGN_DARK },
  valetStand: { g: gValetStand, tier: T.SMALL, r: 0.40, h: 1.46, label: 'Valet Stand', shadow: true, debris: P.SIGN_DARK },
  stanchion: { g: gStanchion, tier: T.SMALL, r: 0.18, h: 1.02, label: 'Rope Post', debris: P.CHROME },

  /* kerb machines --------------------------------------------------------- */
  mailbox: { g: gMailbox, tier: T.SMALL, r: 0.40, h: 1.20, label: 'Mailbox', shadow: true, tint: [P.MAILBOX, P.MAILBOX, 0x2f6fb0], debris: P.MAILBOX },
  meter: { g: gParkingMeter, tier: T.SMALL, r: 0.20, h: 1.48, label: 'Parking Meter', shadow: true, debris: P.PARKING_METER },
  newsBox: { g: gNewsBox, tier: T.SMALL, r: 0.32, h: 1.10, label: 'Newspaper Box', shadow: true, tint: [P.NEWSSTAND, P.SIGN_BLUE, P.ACCENT_SUN, P.BIN_GREEN], debris: P.NEWSSTAND },
  utilityBox: { g: gUtilityBox, tier: T.SMALL, r: 0.50, h: 1.32, label: 'Utility Cabinet', shadow: true, debris: P.ALUMINIUM },
  atmKiosk: { g: gAtmKiosk, tier: T.MEDIUM, r: 0.60, h: 2.22, label: 'ATM Kiosk', shadow: true, debris: 0xf0ece2 },
  phoneKiosk: { g: gPhoneKiosk, tier: T.MEDIUM, r: 0.38, h: 2.40, label: 'Charging Kiosk', shadow: true, debris: P.STEEL_DARK },
  fountain: { g: gDrinkFountain, tier: T.SMALL, r: 0.28, h: 1.12, label: 'Drinking Fountain', debris: P.PRECAST },
  dogStation: { g: gDogStation, tier: T.SMALL, r: 0.22, h: 1.56, label: 'Dog Waste Station', debris: P.BIN_GREEN },

  /* planting -------------------------------------------------------------- */
  planterRound: { g: gPlanterRound, tier: T.SMALL, r: 0.62, h: 1.45, label: 'Planter', shadow: true, debris: P.PLANTER },
  planterSquare: { g: gPlanterSquare, tier: T.SMALL, r: 0.78, h: 1.45, label: 'Planter', shadow: true, debris: P.PLANTER },
  planterTrough: { g: gPlanterTrough, tier: T.SMALL, r: 1.00, h: 1.10, label: 'Flower Trough', shadow: true, debris: P.PLANTER },
  pottedPalm: { g: gPottedPalm, tier: T.MEDIUM, r: 0.80, h: 1.90, label: 'Potted Palm', shadow: true, debris: P.PALM_FROND },
  // Hangs off a Deco lamp bracket, hence the y offset.
  hangBasket: { g: gHangBasket, tier: T.TINY, r: 0.34, h: 0.80, y: 3.86, label: 'Flower Basket', debris: P.FLOWER_MAGENTA },

  /* café terrace ---------------------------------------------------------- */
  cafeTable: { g: gCafeTable, tier: T.SMALL, r: 0.46, h: 0.78, label: 'Café Table', debris: P.TABLE_TOP },
  cafeChair: { g: gCafeChair, tier: T.SMALL, r: 0.30, h: 0.90, label: 'Café Chair', debris: P.CHAIR },
  umbrella: {
    g: gUmbrella, tier: T.MEDIUM, r: 1.30, h: 2.56, label: 'Patio Umbrella', shadow: true,
    tint: [P.FABRIC_CORAL, P.FABRIC_AQUA, P.FABRIC_SUN, P.FABRIC_SKY, P.FABRIC_PINK, P.FABRIC_WHITE],
    debris: P.FABRIC_CORAL,
  },
  parasol: {
    g: gBeachParasol, tier: T.MEDIUM, r: 1.45, h: 2.44, label: 'Beach Parasol', shadow: true,
    tint: [P.FABRIC_SUN, P.FABRIC_CORAL, P.FABRIC_AQUA, P.FABRIC_WHITE], debris: P.FABRIC_SUN,
  },
  heater: { g: gPatioHeater, tier: T.MEDIUM, r: 0.62, h: 2.10, label: 'Patio Heater', shadow: true, debris: P.ALUMINIUM },
  stringPole: { g: gStringPole, tier: T.MEDIUM, r: 0.26, h: 3.30, label: 'String-Light Pole', shadow: true, debris: P.WOOD_DARK },

  /* micromobility --------------------------------------------------------- */
  bicycle: { g: gBicycle, tier: T.MEDIUM, r: 0.75, h: 1.05, label: 'Bicycle', shadow: true, tint: [0xf2f2f2, P.CAR_TEAL, P.CAR_CORAL, P.CAR_YELLOW, P.CAR_MINT], debris: P.STEEL },
  bikeRack: { g: gBikeRack, tier: T.SMALL, r: 0.48, h: 0.75, label: 'Bike Rack', debris: P.STEEL },
  scooter: { g: gScooter, tier: T.MEDIUM, r: 0.52, h: 1.05, label: 'E-Scooter', shadow: true, tint: [0xf4f4f4, P.NEON_AQUA, P.ACCENT_HOT, P.CAR_LIME], debris: P.NEON_AQUA },

  /* lighting -------------------------------------------------------------- */
  lampModern: { g: gLampModern, tier: T.MEDIUM, r: 0.30, h: 7.00, label: 'Street Light', shadow: true, debris: P.LAMP_POST },
  lampDeco: { g: gLampDeco, tier: T.MEDIUM, r: 0.42, h: 5.80, label: 'Deco Lamp Post', shadow: true, debris: P.BENCH_METAL },
  lampPark: { g: gLampPark, tier: T.MEDIUM, r: 0.26, h: 4.05, label: 'Park Lamp', shadow: true, debris: P.BENCH_METAL },

  /* transit + vending ----------------------------------------------------- */
  busShelter: { g: gBusShelter, tier: T.LARGE, r: 2.30, h: 2.62, label: 'Bus Shelter', shadow: true, debris: P.ALUMINIUM },
  foodCart: { g: gFoodCart, tier: T.MEDIUM, r: 1.20, h: 2.56, label: 'Food Cart', shadow: true, debris: P.FABRIC_SUN },
  hotdogStand: { g: gHotdogStand, tier: T.MEDIUM, r: 0.85, h: 2.40, label: 'Hot-Dog Stand', shadow: true, debris: P.FABRIC_CORAL },
  displayRack: { g: gDisplayRack, tier: T.MEDIUM, r: 0.70, h: 1.55, label: 'Display Rack', shadow: true, debris: P.FABRIC_CORAL },
  produceCrate: { g: gProduceCrate, tier: T.SMALL, r: 0.40, h: 0.52, label: 'Produce Crate', debris: P.WOOD_LIGHT },

  /* construction ---------------------------------------------------------- */
  jersey: { g: gJersey, tier: T.MEDIUM, r: 1.05, h: 0.80, label: 'Jersey Barrier', shadow: true, crumbles: true, debris: P.PRECAST },
  waterBarrier: { g: gWaterBarrier, tier: T.SMALL, r: 0.36, h: 1.02, label: 'Water Barrier', shadow: true, tint: [0xffffff, P.BARRIER_ORANGE, 0xffffff], debris: P.BARRIER_ORANGE },
  aframe: { g: gAframe, tier: T.SMALL, r: 0.60, h: 1.05, label: 'Barricade', shadow: true, debris: P.BARRIER_ORANGE },
  barrel: { g: gTrafficBarrel, tier: T.SMALL, r: 0.36, h: 0.92, label: 'Traffic Barrel', shadow: true, debris: P.BARRIER_ORANGE },
  crate: { g: gCrate, tier: T.SMALL, r: 0.56, h: 0.68, label: 'Crate', debris: P.WOOD_DECK },
  pallet: { g: gPallet, tier: T.SMALL, r: 0.75, h: 0.48, label: 'Pallet Stack', debris: P.WOOD_LIGHT },
  scaffold: { g: gScaffold, tier: T.MEDIUM, r: 0.75, h: 1.96, label: 'Scaffold Tower', shadow: true, debris: P.SCAFFOLD },
  sandbags: { g: gSandbags, tier: T.SMALL, r: 0.48, h: 0.57, label: 'Sandbags', debris: P.SAND },
  portaloo: { g: gPortaloo, tier: T.MEDIUM, r: 0.80, h: 2.26, label: 'Portaloo', shadow: true, debris: 0xffffff },
};

/** Which material each pool renders with. */
const MAT_OF = {
  bollard: 'metal', stanchion: 'metal', bikeRack: 'metal', scaffold: 'metal',
  cleat: 'metal', busShelter: 'gloss', heater: 'metal',
  umbrella: 'fabric', parasol: 'fabric',
};

const _geoCache = new Map();
function factoryFor(key) {
  return () => {
    let geo = _geoCache.get(key);
    if (!geo) {
      const m = new M();
      DEFS[key].g(m);
      geo = m.geometry();
      _geoCache.set(key, geo);
    }
    return { geometry: geo, material: mat(MAT_OF[key] || 'prop') };
  };
}

/* ========================================================== placer ====== */

const SIDE_ROT = { n: Math.PI, s: 0, w: -Math.PI / 2, e: Math.PI / 2 };

function edgePt(b, s, u, inset) {
  if (s === 'n') return { x: b.x - b.w / 2 + u, z: b.z - b.d / 2 + inset };
  if (s === 's') return { x: b.x - b.w / 2 + u, z: b.z + b.d / 2 - inset };
  if (s === 'w') return { x: b.x - b.w / 2 + inset, z: b.z - b.d / 2 + u };
  return { x: b.x + b.w / 2 - inset, z: b.z - b.d / 2 + u };
}
const edgeLen = (b, s) => ((s === 'n' || s === 's') ? b.w : b.d);

/**
 * Collects placements, resolves collisions on a fine grid, then emits every
 * pool at its exact final size.
 */
class Placer {
  constructor(ctx) {
    this.ctx = ctx;
    this.rng = makeRNG(0x5eed_1a7 ^ (ctx.layout.seed | 0));
    this.items = [];
    this.cell = 1.6;
    this.grid = new Map();
  }

  _key(i, j) { return (i + 8192) * 20000 + (j + 8192); }

  free(x, z, r) {
    const c = this.cell;
    const i0 = Math.floor((x - r) / c), i1 = Math.floor((x + r) / c);
    const j0 = Math.floor((z - r) / c), j1 = Math.floor((z + r) / c);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const bucket = this.grid.get(this._key(i, j));
        if (!bucket) continue;
        for (let k = 0; k < bucket.length; k += 3) {
          const dx = bucket[k] - x, dz = bucket[k + 1] - z;
          const rr = bucket[k + 2] + r;
          if (dx * dx + dz * dz < rr * rr) return false;
        }
      }
    }
    return true;
  }

  claim(x, z, r) {
    const c = this.cell;
    const i0 = Math.floor((x - r) / c), i1 = Math.floor((x + r) / c);
    const j0 = Math.floor((z - r) / c), j1 = Math.floor((z + r) / c);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = this._key(i, j);
        let bucket = this.grid.get(k);
        if (!bucket) { bucket = []; this.grid.set(k, bucket); }
        bucket.push(x, z, r);
      }
    }
  }

  /**
   * @returns {boolean} placed
   */
  put(key, x, z, rot = 0, scale = 1, hex = null) {
    const d = DEFS[key];
    if (!d) return false;
    const rr = d.r * scale + 0.16;
    if (!this.free(x, z, rr)) return false;
    this.claim(x, z, rr);
    this.items.push({ key, x, z, rot, scale, hex });
    return true;
  }

  /** Soft-hint variant: nudge off anything the shared grid already knows about. */
  putSoft(key, x, z, rot = 0, scale = 1, hex = null) {
    const r = this.rng;
    for (let t = 0; t < 3; t++) {
      const jx = t === 0 ? 0 : (r() - 0.5) * 5.0;
      const jz = t === 0 ? 0 : (r() - 0.5) * 5.0;
      if (this.ctx.isFree(x + jx, z + jz, 0)) return this.put(key, x + jx, z + jz, rot, scale, hex);
    }
    return this.put(key, x, z, rot, scale, hex);
  }

  emit() {
    const counts = new Map();
    for (const it of this.items) counts.set(it.key, (counts.get(it.key) || 0) + 1);

    const ctx = this.ctx;
    const r = this.rng;
    let tris = 0;
    for (const it of this.items) {
      const d = DEFS[it.key];
      const hex = d.tint ? (it.hex ?? d.tint[Math.floor(r() * d.tint.length)]) : null;
      ctx.addInstanced(it.key, factoryFor(it.key), {
        position: new THREE.Vector3(it.x, ctx.Y_WALK + (d.y || 0), it.z),
        rotationY: it.rot,
        scale: it.scale,
        hex,
        tier: d.tier,
        radius: d.r * it.scale,
        height: d.h * it.scale,
        label: d.label,
        kind: it.key,
        capacity: counts.get(it.key),
        castShadow: !!d.shadow,
        crumbles: !!d.crumbles,
        debrisColor: d.debris,
      });
      // Claim on the shared grid so vehicles/pedestrians do not stand inside a
      // bus shelter. Radius 0 marks a single 3 m cell — anything larger would
      // carpet the whole map at this density.
      ctx.occupy(it.x, it.z, d.r > 1.2 ? d.r : 0);
    }
    for (const [key, n] of counts) {
      const g = _geoCache.get(key);
      if (g) tris += (g.index.count / 3) * n;
    }
    console.info(
      `[props] ${counts.size} pools / ${this.items.length} instances / ` +
      `${(tris / 1000).toFixed(0)}k tris`
    );
    return { pools: counts.size, instances: this.items.length, tris };
  }
}

/* ========================================================= placement ==== */

export function buildProps(ctx) {
  const pl = new Placer(ctx);
  for (const b of ctx.layout.blocks) {
    const r = makeRNG((b.seed ^ 0x2b7d) >>> 0);
    try {
      dressBlock(pl, b, r);
    } catch (e) {
      console.error('[props] block failed', b.x, b.z, e);
    }
  }
  pl.emit();
}

function dressBlock(pl, b, r) {
  const Z = b.zone;
  const life = b.streetLife;
  const open = Z === ZONE.PARK || Z === ZONE.PLAZA || Z === ZONE.MARINA;

  // The pavement band actually available between kerb and building line. On an
  // open block (park / plaza / basin apron) there is no building, so the whole
  // parcel is fair game.
  const band = open
    ? Math.min(b.w, b.d) * 0.42
    : Math.max(1.8, Math.min(b.sidewalk, Math.min(b.w, b.d) * 0.23));

  const sides = ['n', 's', 'w', 'e'].filter((s) => b.edges[s]);
  if (!sides.length) sides.push(b.frontage);

  for (const s of sides) kerbRun(pl, b, s, r, band, life);
  if (!open && band > 2.3) for (const s of sides) facadeRun(pl, b, s, r, band, life);
  cornerDressing(pl, b, r);

  switch (Z) {
    case ZONE.CONSTRUCTION: constructionYard(pl, b, r, band); break;
    case ZONE.PARK: parkFurniture(pl, b, r); break;
    case ZONE.PLAZA: plazaFurniture(pl, b, r); break;
    case ZONE.MARINA: marinaApron(pl, b, r); break;
    case ZONE.PARKING: lotFurniture(pl, b, r, band); break;
    case ZONE.RETAIL:
    case ZONE.LOWRISE: retailTerrace(pl, b, r, band); break;
    case ZONE.TOWER:
    case ZONE.LANDMARK: towerForecourt(pl, b, r, band); break;
    default: break;
  }
  if (b.bayfront && !open) beachFront(pl, b, r);
}

/* ------------------------------------------------------------ kerb line -- */

/** Weighted kerbside vocabulary for a block. */
function kerbTable(b) {
  const t = [
    ['bollard', 9], ['binMuni', 6], ['binWheelie', 4], ['planterRound', 6],
    ['planterSquare', 4], ['benchSlat', 5], ['signStreet', 3], ['signParking', 3],
    ['hydrant', 3], ['meter', 5], ['newsBox', 3], ['utilityBox', 2], ['cone', 2],
    ['bikeRack', 3], ['scooter', 3], ['bicycle', 2], ['mailbox', 2],
  ];
  if (b.streetLife > 0.5) {
    t.push(['planterTrough', 5], ['binMesh', 3], ['phoneKiosk', 1], ['atmKiosk', 1],
      ['pottedPalm', 4], ['stanchion', 2], ['hotdogStand', 1]);
  }
  if (b.streetLife < 0.3) {
    t.push(['bollardStone', 4], ['crate', 2], ['pallet', 1]);
  }
  if (b.onSpine) t.push(['benchConcrete', 3], ['foodCart', 1], ['displayRack', 1]);
  return t;
}

function kerbRun(pl, b, s, r, band, life) {
  const len = edgeLen(b, s);
  if (len < 11) return;
  const rot = SIDE_ROT[s];
  const inMin = 0.95;
  const inMax = Math.max(1.25, band - 0.55);

  /* Lamp posts on an even cadence. An irregular lamp rhythm is one of the
     loudest "procedural city" tells, so this one is deliberately metronomic. */
  const gap = b.onBoulevard ? 22 : b.onSpine ? 25 : 31;
  const kind = (b.onSpine || b.onBoulevard)
    ? (life > 0.45 ? 'lampDeco' : 'lampModern')
    : (life > 0.3 ? 'lampModern' : 'lampPark');
  for (let u = 4 + r() * 6; u < len - 4; u += gap) {
    const p = edgePt(b, s, u, 1.35);
    if (pl.put(kind, p.x, p.z, rot)) {
      // Deco posts on a busy spine carry hanging baskets; modern ones don't.
      if (kind === 'lampDeco' && r.chance(0.55)) {
        pl.put('hangBasket', p.x + Math.sin(rot + 1.57) * 0.62, p.z + Math.cos(rot + 1.57) * 0.62, rot, 1);
      }
      if (r.chance(0.3)) {
        const q = edgePt(b, s, u + 1.5, 0.85);
        pl.put('uplighter', q.x, q.z, rot);
      }
    }
  }

  /* One shelter per busy boulevard frontage. */
  if ((b.onBoulevard || b.onSpine) && life > 0.42 && len > 30 && r.chance(0.5)) {
    const u = 8 + r() * (len - 20);
    const p = edgePt(b, s, u, Math.min(2.1, Math.max(1.5, band - 0.9)));
    if (pl.put('busShelter', p.x, p.z, rot)) {
      const q = edgePt(b, s, u + 3.2, 1.1);
      pl.put('binMesh', q.x, q.z, rot);
      const q2 = edgePt(b, s, u - 3.2, 1.15);
      pl.put('signParking', q2.x, q2.z, rot);
    }
  }

  /* General furniture run. Spacing tightens hard with street life, which is
     what makes a spine feel crowded and a back lot feel empty. */
  const base = (5.6 - 3.1 * life) / DENSITY;
  const table = kerbTable(b);
  for (let u = 3.0 + r() * 2.5; u < len - 3.0; u += base * (0.68 + r() * 0.8)) {
    const inset = inMin + r() * Math.max(0.25, inMax - inMin);
    const p = edgePt(b, s, u, inset);
    const key = r.weighted(table);
    const jitter = (r() - 0.5) * 0.3;
    if (key === 'scooter') { scooterRow(pl, b, s, u, inset, rot, r); continue; }
    if (key === 'bikeRack') { bikeCluster(pl, b, s, u, inset, rot, r); continue; }
    pl.putSoft(key, p.x, p.z, rot + jitter);
  }

  /* Parking meters march along the kerb wherever cars park — regular, close in. */
  if (life > 0.34 && !b.onSpine && r.chance(0.45)) {
    for (let u = 6 + r() * 4; u < len - 5; u += 7.2) {
      const p = edgePt(b, s, u, 1.0);
      pl.put('meter', p.x, p.z, rot);
    }
  }
}

/** Scooters are dumped in tidy rows against the kerb, never one at a time. */
function scooterRow(pl, b, s, u, inset, rot, r) {
  const n = 3 + r.int(0, 4);
  for (let k = 0; k < n; k++) {
    const p = edgePt(b, s, u + k * 0.78, inset + (r() - 0.5) * 0.16);
    pl.put('scooter', p.x, p.z, rot + Math.PI / 2 + (r() - 0.5) * 0.16);
  }
}

/**
 * U-racks stand with the hoop plane parallel to the kerb, so the bikes locked
 * to them lie parallel to the kerb too — both are authored along local x, which
 * is exactly the edge direction after the placer's rotation.
 */
function bikeCluster(pl, b, s, u, inset, rot, r) {
  const n = 2 + r.int(0, 2);
  for (let k = 0; k < n; k++) {
    const p = edgePt(b, s, u + k * 1.15, inset);
    if (!pl.put('bikeRack', p.x, p.z, rot)) continue;
    if (r.chance(0.62)) {
      const q = edgePt(b, s, u + k * 1.15, inset + 0.55);
      pl.put('bicycle', q.x, q.z, rot + (r() - 0.5) * 0.12);
    }
  }
}

/* --------------------------------------------------------- facade line --- */

function facadeRun(pl, b, s, r, band, life) {
  const len = edgeLen(b, s);
  if (len < 14) return;
  const rot = SIDE_ROT[s];
  const inset = band - 0.35;
  const step = 6.5 - 3.0 * life;
  const shoppy = b.zone === ZONE.RETAIL || b.zone === ZONE.LOWRISE;
  const table = shoppy
    ? [['sandwichBoard', 7], ['produceCrate', 6], ['displayRack', 5], ['pottedPalm', 6],
      ['binWheelie', 4], ['cafeChair', 3], ['crate', 3], ['planterTrough', 3], ['heater', 2]]
    : [['pottedPalm', 6], ['planterSquare', 5], ['benchSlat', 4], ['binWheelie', 3],
      ['bollardStone', 4], ['utilityBox', 2], ['sandwichBoard', 2]];

  for (let u = 4 + r() * 3; u < len - 4; u += step * (0.7 + r() * 0.9)) {
    const p = edgePt(b, s, u, inset);
    pl.putSoft(r.weighted(table), p.x, p.z, rot + (r() - 0.5) * 0.4);
  }
}

/* ------------------------------------------------------------- corners --- */

function cornerDressing(pl, b, r) {
  // A real corner carries the hydrant, the stop sign and a bollard cluster.
  const corners = [];
  if (b.edges.n && b.edges.w) corners.push(['w', 'n', 2.2, 2.2]);
  if (b.edges.n && b.edges.e) corners.push(['e', 'n', -2.2, 2.2]);
  if (b.edges.s && b.edges.w) corners.push(['w', 's', 2.2, -2.2]);
  if (b.edges.s && b.edges.e) corners.push(['e', 's', -2.2, -2.2]);
  for (const [sx, sz, ox, oz] of corners) {
    const x = (sx === 'w' ? b.x - b.w / 2 : b.x + b.w / 2) + ox;
    const z = (sz === 'n' ? b.z - b.d / 2 : b.z + b.d / 2) + oz;
    const rot = Math.atan2(-ox, -oz);
    if (r.chance(0.55)) pl.put(r.chance(0.6) ? 'signStop' : 'signNoEntry', x, z, rot);
    if (r.chance(0.5)) pl.put('hydrant', x + ox * 0.7, z + oz * 0.7, rot);
    if (r.chance(0.4)) {
      for (let k = 0; k < 3; k++) {
        pl.put('bollard', x - ox * 0.2 + k * ox * 0.55, z - oz * 0.2 + k * oz * 0.55, 0);
      }
    }
    if (b.streetLife > 0.5 && r.chance(0.35)) pl.put('newsBox', x + ox * 0.3, z - oz * 0.4, rot);
  }
}

/* ------------------------------------------------------ zone dressings --- */

function cafeCluster(pl, x, z, rot, r, n = 1) {
  for (let c = 0; c < n; c++) {
    const cx = x + (r() - 0.5) * 4.5;
    const cz = z + (r() - 0.5) * 4.5;
    if (!pl.put('cafeTable', cx, cz, r() * TAU)) continue;
    const seats = 2 + r.int(0, 2);
    for (let k = 0; k < seats; k++) {
      const a = (k / seats) * TAU + r() * 0.6;
      pl.put('cafeChair', cx + Math.cos(a) * 0.92, cz + Math.sin(a) * 0.92, a + Math.PI / 2);
    }
    if (r.chance(0.55)) pl.put('umbrella', cx, cz, r() * TAU);
  }
}

function retailTerrace(pl, b, r, band) {
  const life = b.streetLife;
  const nClusters = Math.round(1 + life * 4 + r() * 1.6);
  const s = b.frontage;
  const len = edgeLen(b, s);
  const rot = SIDE_ROT[s];
  for (let k = 0; k < nClusters; k++) {
    const u = 5 + r() * Math.max(1, len - 10);
    const p = edgePt(b, s, u, Math.max(1.9, band * 0.62));
    cafeCluster(pl, p.x, p.z, rot, r, 1);
  }
  // String-light poles bracket a terrace; that catenary is a lot of the mood.
  if (life > 0.45 && r.chance(0.55)) {
    const u = 6 + r() * Math.max(1, len - 12);
    for (const du of [0, 5.5]) {
      const p = edgePt(b, s, u + du, Math.max(1.7, band * 0.5));
      pl.put('stringPole', p.x, p.z, rot);
    }
  }
  if (r.chance(0.5)) {
    const u = 4 + r() * Math.max(1, len - 8);
    const p = edgePt(b, s, u, 1.5);
    pl.put(r.chance(0.5) ? 'foodCart' : 'hotdogStand', p.x, p.z, rot);
  }
  // Newspaper vending row.
  if (r.chance(0.32)) {
    const u = 4 + r() * Math.max(1, len - 10);
    for (let k = 0; k < 3 + r.int(0, 2); k++) {
      const p = edgePt(b, s, u + k * 0.62, 1.25);
      pl.put('newsBox', p.x, p.z, rot);
    }
  }
}

function towerForecourt(pl, b, r, band) {
  const s = b.frontage;
  const len = edgeLen(b, s);
  const rot = SIDE_ROT[s];
  const mid = len / 2 + (r() - 0.5) * len * 0.2;
  // Flanking potted palms + a rope line either side of the door.
  for (const sgn of [-1, 1]) {
    for (let k = 0; k < 2; k++) {
      const p = edgePt(b, s, mid + sgn * (2.4 + k * 2.2), Math.max(1.8, band * 0.6));
      pl.put('pottedPalm', p.x, p.z, rot);
    }
  }
  if (r.chance(0.55)) {
    const p = edgePt(b, s, mid + 3.6, 1.6);
    pl.put('valetStand', p.x, p.z, rot);
  }
  if (r.chance(0.45)) {
    for (let k = 0; k < 5; k++) {
      const p = edgePt(b, s, mid - 4 + k * 1.7, 1.35);
      pl.put('stanchion', p.x, p.z, rot);
    }
  }
  if (b.streetLife > 0.5 && r.chance(0.5)) {
    const p = edgePt(b, s, mid - 6.5, 1.5);
    pl.put('atmKiosk', p.x, p.z, rot);
  }
}

function plazaFurniture(pl, b, r) {
  const n = Math.round((b.w * b.d) / 190);
  for (let i = 0; i < n; i++) {
    const x = b.x + (r() - 0.5) * b.w * 0.82;
    const z = b.z + (r() - 0.5) * b.d * 0.82;
    const key = r.weighted([
      ['benchConcrete', 8], ['planterSquare', 7], ['planterRound', 6], ['binMuni', 4],
      ['bollardStone', 6], ['lampPark', 4], ['pottedPalm', 5], ['fountain', 2],
      ['cafeTable', 4], ['benchSlat', 5], ['planterTrough', 3],
    ]);
    if (key === 'cafeTable') { cafeCluster(pl, x, z, 0, r, 1); continue; }
    pl.putSoft(key, x, z, r() * TAU);
  }
  // A ring of planters around the centre reads as designed public realm.
  if (Math.min(b.w, b.d) > 34 && r.chance(0.6)) {
    const rad = Math.min(b.w, b.d) * 0.24;
    const k = 8 + r.int(0, 4);
    for (let i = 0; i < k; i++) {
      const a = (i / k) * TAU;
      pl.put('planterRound', b.x + Math.cos(a) * rad, b.z + Math.sin(a) * rad, a);
    }
  }
}

function parkFurniture(pl, b, r) {
  const n = Math.round((b.w * b.d) / 240);
  for (let i = 0; i < n; i++) {
    const x = b.x + (r() - 0.5) * b.w * 0.84;
    const z = b.z + (r() - 0.5) * b.d * 0.84;
    const key = r.weighted([
      ['benchBackless', 9], ['benchSlat', 7], ['picnicTable', 7], ['binMesh', 5],
      ['lampPark', 5], ['fountain', 3], ['dogStation', 3], ['planterRound', 3],
      ['bollardStone', 3], ['binMuni', 3],
    ]);
    pl.putSoft(key, x, z, r() * TAU);
  }
  // Picnic groves: tables come in twos and threes around a shady spot.
  const groves = 1 + r.int(0, 2);
  for (let g = 0; g < groves; g++) {
    const gx = b.x + (r() - 0.5) * b.w * 0.6;
    const gz = b.z + (r() - 0.5) * b.d * 0.6;
    for (let k = 0; k < 2 + r.int(0, 2); k++) {
      pl.putSoft('picnicTable', gx + (r() - 0.5) * 7, gz + (r() - 0.5) * 7, r() * TAU);
    }
    pl.putSoft('binMesh', gx + (r() - 0.5) * 8, gz + (r() - 0.5) * 8, 0);
  }
}

function marinaApron(pl, b, r) {
  const n = Math.round((b.w * b.d) / 260);
  for (let i = 0; i < n; i++) {
    const x = b.x + (r() - 0.5) * b.w * 0.86;
    const z = b.z + (r() - 0.5) * b.d * 0.86;
    pl.putSoft(r.weighted([
      ['cleat', 8], ['crate', 6], ['bollardStone', 5], ['benchSlat', 5],
      ['binMesh', 4], ['lampPark', 4], ['pallet', 4], ['planterRound', 3],
      ['lounger', 3], ['parasol', 2],
    ]), x, z, r() * TAU);
  }
  // Cleats march along the seaward edge at a fixed dock spacing.
  const ez = b.x + b.w / 2 - 1.2;
  for (let u = 2.5; u < b.d - 2.5; u += 4.5) {
    pl.put('cleat', ez, b.z - b.d / 2 + u, 0);
  }
}

function beachFront(pl, b, r) {
  // Promenade furniture on the seaward strip: loungers and parasols in rows.
  const x0 = b.x + b.w / 2 - 3.4;
  const rows = 1 + r.int(0, 1);
  for (let row = 0; row < rows; row++) {
    const x = x0 - row * 3.1;
    for (let u = 3; u < b.d - 3; u += 2.9) {
      if (!r.chance(0.62)) continue;
      const z = b.z - b.d / 2 + u;
      pl.put('lounger', x, z, Math.PI / 2 + (r() - 0.5) * 0.2);
      if (r.chance(0.34)) pl.put('parasol', x - 1.5, z + 0.6, 0);
    }
  }
}

function lotFurniture(pl, b, r, band) {
  // A garage forecourt: kerb protection, cabinets and a few cones.
  const n = Math.round((b.w + b.d) / 12);
  for (let i = 0; i < n; i++) {
    const s = r.pick(['n', 's', 'w', 'e']);
    const u = 3 + r() * Math.max(1, edgeLen(b, s) - 6);
    const p = edgePt(b, s, u, 0.9 + r() * Math.max(0.3, band - 1.2));
    pl.putSoft(r.weighted([
      ['bollard', 9], ['cone', 6], ['utilityBox', 4], ['barrel', 3],
      ['signParking', 5], ['binWheelie', 3], ['aframe', 2],
    ]), p.x, p.z, SIDE_ROT[s]);
  }
}

function constructionYard(pl, b, r, band) {
  /* Hoarding line: barriers march continuously along every street frontage,
     which is what makes a site read as a site from the air. */
  const sides = ['n', 's', 'w', 'e'].filter((s) => b.edges[s]);
  for (const s of sides) {
    const len = edgeLen(b, s);
    const rot = SIDE_ROT[s];
    const kind = r.chance(0.55) ? 'jersey' : 'waterBarrier';
    const step = kind === 'jersey' ? 2.15 : 1.05;
    for (let u = 1.6; u < len - 1.6; u += step) {
      const p = edgePt(b, s, u, 1.25);
      pl.put(kind, p.x, p.z, rot + Math.PI / 2);
    }
    // Cones and barrels punctuate the line.
    for (let u = 3 + r() * 4; u < len - 3; u += 7 + r() * 6) {
      const p = edgePt(b, s, u, 0.6);
      pl.put(r.chance(0.55) ? 'cone' : 'barrel', p.x, p.z, r() * TAU);
    }
  }

  /* Site yard: material stacks, welfare units, scaffolding. */
  const n = Math.round((b.w * b.d) / 200);
  for (let i = 0; i < n; i++) {
    const x = b.x + (r() - 0.5) * b.w * 0.78;
    const z = b.z + (r() - 0.5) * b.d * 0.78;
    pl.putSoft(r.weighted([
      ['crate', 9], ['pallet', 8], ['sandbags', 6], ['scaffold', 6],
      ['cone', 6], ['barrel', 5], ['aframe', 4], ['portaloo', 3],
      ['jersey', 3], ['waterBarrier', 3],
    ]), x, z, r() * TAU);
  }
  // Portaloos come in banks of two or three.
  if (r.chance(0.7)) {
    const bx = b.x + (r() - 0.5) * b.w * 0.5;
    const bz = b.z + (r() - 0.5) * b.d * 0.5;
    const a = r() * TAU;
    for (let k = 0; k < 2 + r.int(0, 1); k++) {
      pl.putSoft('portaloo', bx + Math.cos(a) * k * 1.35, bz + Math.sin(a) * k * 1.35, a + Math.PI / 2);
    }
  }
  // Pallet + crate stacks cluster near one corner, like a real materials drop.
  const dx = b.x + (r() - 0.5) * b.w * 0.45;
  const dz = b.z + (r() - 0.5) * b.d * 0.45;
  for (let k = 0; k < 4 + r.int(0, 4); k++) {
    pl.putSoft(r.chance(0.5) ? 'pallet' : 'crate',
      dx + (r() - 0.5) * 6, dz + (r() - 0.5) * 6, r() * TAU);
  }
}
