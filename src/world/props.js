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
 * 6. THE GROUND IS MEASURED, NOT ASSUMED. `Ground` samples the surface that
 *    streets.js, water.js and nature.js have already built and puts each prop
 *    exactly on it — there are eight different heights out there and planting
 *    everything at Y_WALK left 402 props hovering or buried. The same sample
 *    decides whether the site is legal at all: below GROUND_MIN it is the
 *    carriageway, the gutter or a crossing ramp, and nothing stands there.
 *
 * 7. NOTHING SHARES GROUND WITH ANYTHING. Three separate tests, because they
 *    answer three different questions and none of them can answer another's:
 *
 *    prop vs prop     the placer's own fine (1.6 m) grid, claiming the MEASURED
 *                     contact footprint of each prop — see `contactRadius`.
 *    prop vs scenery  `Placer.sceneryClear`, which asks the registry for every
 *                     INSTANCED entity — that is exactly everything nature.js
 *                     plants, at its real measured radius. This is what stopped
 *                     600 audit pairs of bollards-inside-hedges, and what now
 *                     also stops loungers inside sea grapes.
 *    prop vs building the block's own setback data, NOT the shared grid:
 *                     buildings.js claims `max(w,d)*0.5` around a block centre,
 *                     which on the coarse 3 m occupancy grid covers the whole
 *                     parcel *including the sidewalk*. Gating pavement
 *                     placement on that leaves the city bare, which is the bug
 *                     this module exists to fix, so `ctx.isFree` is only ever a
 *                     soft hint here (retry a few jittered candidates).
 *
 * 8. A REFUSED SITE IS NOT A LOST PROP. Every one of those tests can say no, and
 *    saying no three times per placement cost a fifth of the city's furniture
 *    the first time it was tried. So the callers slide the prop a metre or two
 *    along the line it belongs to (`putAlong`) instead of dropping it: the kerb
 *    rhythm survives, the density survives, and the prop still ends up
 *    somewhere a person would have put it.
 */

import * as THREE from 'three';
import { TIER, PALETTE, WORLD } from '../config.js';
import { makeRNG } from '../core/rng.js';
import { solid } from '../core/materials.js';
import { ZONE } from './cityLayout.js';

/**
 * ONE KNOB FOR THE WHOLE MODULE.
 *
 * 1.0 puts ~16.6k props on the map (the art bible asks for 9k-16k small props;
 * ~1.3k of the overshoot is pavement ironwork, which is 9 cm tall and reads as
 * ground texture rather than as furniture) and costs ~1.09M geometry triangles.
 * Every spacing and every area-based count below divides by this, so if the
 * project needs the triangles back, 0.75 lands around 12.5k props and ~820k
 * triangles without changing how anything looks up close. Draw calls do not
 * move with density: this module is one InstancedMesh per prop type, 119 of
 * them, whatever DENSITY is set to.
 */
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
// Kept shallow on purpose: a 0.6 m planter is *entirely* inside the ramp, and
// at the first-pass strength (0.55 m / 0.68) every low prop read as muddy brown
// instead of the bone/pastel it is authored as.
const AO_H = 0.40;
const AO_MIN = 0.78;
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
    this.p = []; this.n = []; this.c = []; this.i = []; this.g = [];
    this.v = 0;
    this.cr = 1; this.cg = 1; this.cb = 1; this.gl = 0;
    this.sa = 0; this.ca = 1; this.ox = 0; this.oy = 0; this.oz = 0;
  }

  /**
   * Set the colour of every subsequent vertex. This ALWAYS clears the glow
   * flag: `prism`/`tube` drive their `cols` arrays through here, so if colour
   * did not reset emission a single lit strip would leak into every section of
   * every swept part that followed it. Emissive surfaces therefore have to say
   * so explicitly, right where they are built, with `lit()`.
   */
  col(hex, k = 1) {
    const c = lin(hex);
    this.cr = c[0] * k; this.cg = c[1] * k; this.cb = c[2] * k;
    this.gl = 0;
    return this;
  }

  /**
   * Colour + "this surface emits after dark". `g` is how hard, relative to its
   * own albedo: ~1.2 for a bare lamp, ~0.55 for a backlit panel. See NIGHT_U.
   */
  lit(hex, k = 1, g = 1) {
    this.col(hex, k);
    this.gl = g;
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
    this.g.push(this.gl);
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
        /* WINDING. The ring runs counter-clockwise in (x, z) as the angle
           increases, so A-B-C is a CLOCKWISE loop seen from outside and every
           tube in the module rendered inside out for as long as this file has
           existed: with FrontSide materials you saw straight through the near
           wall at the inside of the far one. That is the single defect behind
           the "hollow shell" bins, the open traffic barrel, the cone with a
           void in its base, and every missing capTop. A-C-B is outward. */
        this.i.push(ia, ic, ib, ia, id, ic);
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
      for (let k = 1; k < segs - 1; k++) this.i.push(idx[0], idx[k + 1], idx[k]);
    }
    if (opts.capBot) {
      const s = secs[0];
      const idx = [];
      for (let k = 0; k < segs; k++) {
        const a = rot + (k / segs) * TAU;
        idx.push(this._v(cx + Math.cos(a) * rx(s), s[0], cz + Math.sin(a) * rz(s), 0, -1, 0));
      }
      for (let k = 1; k < segs - 1; k++) this.i.push(idx[0], idx[k], idx[k + 1]);
    }
    return this;
  }

  /**
   * Swept prism with the four vertical arrises cut off — an octagon in plan.
   *
   * `prism` can only chamfer the top and bottom edges, and on anything the
   * camera passes at three metres the vertical corners are what read as a raw
   * box. `secs` is [[y, w, d, c], ...] where `c` is the corner cut. Costs
   * exactly twice a `prism` ring, so it is for the props that earn it.
   */
  oct(cx, cz, secs, opts = {}) {
    const cols = opts.cols;
    const pts = (s) => {
      const a = s[1] / 2, b = s[2] / 2, c = Math.min(s[3] ?? 0.02, a * 0.9, b * 0.9);
      return [
        [a, b - c], [a - c, b], [-(a - c), b], [-a, b - c],
        [-a, -(b - c)], [-(a - c), -b], [a - c, -b], [a, -(b - c)],
      ];
    };
    for (let g = 0; g < secs.length - 1; g++) {
      if (cols && cols[g] !== undefined) this.col(cols[g]);
      const p0 = pts(secs[g]), p1 = pts(secs[g + 1]);
      const y0 = secs[g][0], y1 = secs[g + 1][0];
      for (let k = 0; k < 8; k++) {
        const j = (k + 1) % 8;
        this.quad(
          [cx + p0[k][0], y0, cz + p0[k][1]], [cx + p1[k][0], y1, cz + p1[k][1]],
          [cx + p1[j][0], y1, cz + p1[j][1]], [cx + p0[j][0], y0, cz + p0[j][1]]
        );
      }
    }
    if (opts.capTop !== false) {
      if (cols && cols[secs.length - 2] !== undefined) this.col(cols[secs.length - 2]);
      const s = secs[secs.length - 1], p = pts(s);
      for (let k = 1; k < 7; k++) {
        this.tri([cx + p[0][0], s[0], cz + p[0][1]],
          [cx + p[k + 1][0], s[0], cz + p[k + 1][1]],
          [cx + p[k][0], s[0], cz + p[k][1]]);
      }
    }
    if (opts.capBot) {
      const s = secs[0], p = pts(s);
      for (let k = 1; k < 7; k++) {
        this.tri([cx + p[0][0], s[0], cz + p[0][1]],
          [cx + p[k][0], s[0], cz + p[k][1]],
          [cx + p[k + 1][0], s[0], cz + p[k + 1][1]]);
      }
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
      // Same inverted winding as `tube` had — the rim of every wheel and every
      // cable-drum flange was rendering its inside face.
      this.i.push(ia, ic, ib, ia, id, ic);
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
   * Round bar between two arbitrary points, with radial normals.
   *
   * `beam` is a rectangular section, and a rectangular section is exactly why
   * every rope, every scaffold tube and every bike wheel in this module read as
   * a bent stick. Five or six sides is enough to lose the flat.
   */
  tubeBetween(ax, ay, az, bx, by, bz, r, segs = 5, caps = false) {
    let dx = bx - ax, dy = by - ay, dz = bz - az;
    const L = Math.hypot(dx, dy, dz) || 1;
    dx /= L; dy /= L; dz /= L;
    let ux = 0, uy = 1, uz = 0;
    if (Math.abs(dy) > 0.94) { ux = 1; uy = 0; }
    let sx = uy * dz - uz * dy, sy = uz * dx - ux * dz, sz = ux * dy - uy * dx;
    const sl = Math.hypot(sx, sy, sz) || 1;
    sx /= sl; sy /= sl; sz /= sl;
    const tx = dy * sz - dz * sy, ty = dz * sx - dx * sz, tz = dx * sy - dy * sx;
    const A = [], B = [], NM = [];
    for (let k = 0; k < segs; k++) {
      const a = (k / segs) * TAU;
      const c = Math.cos(a), q = Math.sin(a);
      const nx = sx * c + tx * q, ny = sy * c + ty * q, nzz = sz * c + tz * q;
      NM.push([nx, ny, nzz]);
      A.push(this._v(ax + nx * r, ay + ny * r, az + nzz * r, nx, ny, nzz));
      B.push(this._v(bx + nx * r, by + ny * r, bz + nzz * r, nx, ny, nzz));
    }
    for (let k = 0; k < segs; k++) {
      const j = (k + 1) % segs;
      this.i.push(A[k], B[j], B[k], A[k], A[j], B[j]);
    }
    if (caps) {
      const a0 = this._v(ax, ay, az, -dx, -dy, -dz);
      const b0 = this._v(bx, by, bz, dx, dy, dz);
      for (let k = 0; k < segs; k++) {
        const j = (k + 1) % segs;
        const p = NM[k], q = NM[j];
        this.i.push(a0,
          this._v(ax + q[0] * r, ay + q[1] * r, az + q[2] * r, -dx, -dy, -dz),
          this._v(ax + p[0] * r, ay + p[1] * r, az + p[2] * r, -dx, -dy, -dz));
        this.i.push(b0,
          this._v(bx + p[0] * r, by + p[1] * r, bz + p[2] * r, dx, dy, dz),
          this._v(bx + q[0] * r, by + q[1] * r, bz + q[2] * r, dx, dy, dz));
      }
    }
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

  /** Horizontal n-gon facing up (or down). The cheapest round face there is. */
  disc(cx, y, cz, r, segs = 8, rot = 0, up = true, rz = null) {
    const b = rz === null ? r : rz;
    const idx = [];
    for (let k = 0; k < segs; k++) {
      const a = rot + (k / segs) * TAU;
      idx.push(this._v(cx + Math.cos(a) * r, y, cz + Math.sin(a) * b, 0, up ? 1 : -1, 0));
    }
    for (let k = 1; k < segs - 1; k++) {
      if (up) this.i.push(idx[0], idx[k + 1], idx[k]);
      else this.i.push(idx[0], idx[k], idx[k + 1]);
    }
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
    g.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(this.g), 1));
    g.setIndex(this.v > 65535
      ? new THREE.BufferAttribute(new Uint32Array(this.i), 1)
      : new THREE.BufferAttribute(new Uint16Array(this.i), 1));
    g.computeBoundingSphere();
    return g;
  }
}

/* ======================================================== materials ===== */

/**
 * NIGHT.
 *
 * The engine publishes `scene.userData.nightFactor` every frame and content
 * modules drive their own emission from it. A prop is ONE merged geometry in
 * ONE instanced draw, so "the menu board's face glows but its frame does not"
 * cannot be a second material — it has to be per-vertex. `aGlow` carries it,
 * and the shader adds `vColor * aGlow * nightFactor` to the emissive term.
 *
 * Consequences worth knowing:
 *  · At nightFactor 0 the term is exactly zero, so the daytime frame every
 *    other agent has been reviewing against is untouched, bit for bit.
 *  · The glow inherits `vColor`, which already carries the per-instance tint
 *    and the contact-AO ramp — so a lit panel glows in ITS OWN colour without
 *    anything having to be authored twice.
 *
 * WHY THE UNIFORM IS DRIVEN FROM onBeforeRender AND NOT FROM A GAME TICK
 * The frame loop (src/game.js) calls exactly two module hooks, `trafficUpdate`
 * and `pedestrianUpdate`, and game.js belongs to another agent. A hook nobody
 * calls is a feature that silently never runs. `Object3D.onBeforeRender` fires
 * immediately before each of these meshes is drawn, in the main pass only, and
 * the pools are `frustumCulled = false`, so it is guaranteed every frame with
 * no cross-file contract at all. `propsUpdate` is still published for whoever
 * eventually owns a real update list; both call the same idempotent setter.
 */
const NIGHT_U = { value: 0 };

/** Emissive strength at full night, before the per-vertex `aGlow` weight. */
const GLOW_GAIN = 1.15;

function glowify(m) {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = NIGHT_U;
    shader.vertexShader =
      'attribute float aGlow;\nvarying float vGlow;\n' +
      shader.vertexShader.replace(
        '#include <color_vertex>',
        '#include <color_vertex>\n\tvGlow = aGlow;'
      );
    shader.fragmentShader =
      'uniform float uNight;\nvarying float vGlow;\n' +
      shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += vColor.rgb * (vGlow * uNight);'
      );
  };
  // Without this three would hand this material the cached program of any
  // other MeshStandardMaterial with identical parameters — one that has never
  // seen the injection above.
  m.customProgramCacheKey = () => 'props-glow';
  return m;
}

const MATS = {};
function mat(kind) {
  if (MATS[kind]) return MATS[kind];
  let m;
  // `name` is part of the material cache key in materials.js, so it also
  // guarantees these instances are ours alone and glowify() cannot leak onto
  // another module's material.
  if (kind === 'metal') {
    m = solid({ name: 'prop-metal', vertexColors: true, roughness: 0.34, metalness: 0.52, envMapIntensity: 1.0 });
  } else if (kind === 'gloss') {
    // Stylised shelter / kiosk glazing: opaque on purpose. Instanced transparency
    // has no reliable sort order, and a frosted opaque panel reads the same from
    // the game camera without ever showing a sorting seam.
    m = solid({ name: 'prop-gloss', vertexColors: true, roughness: 0.16, metalness: 0.16, envMapIntensity: 1.7 });
  } else if (kind === 'fabric') {
    m = solid({ name: 'prop-fabric', vertexColors: true, roughness: 0.88, metalness: 0.0, envMapIntensity: 0.5 });
  } else {
    m = solid({ name: 'prop-std', vertexColors: true, roughness: 0.63, metalness: 0.04, envMapIntensity: 0.7 });
  }
  glowify(m);
  MATS[kind] = m;
  return m;
}

/* ========================================================== shapes ====== */
/* Every builder is authored facing +z, base at y = 0, in metres.            */

const P = PALETTE;

/* ---------------------------------------------------------------- helpers */
/* The parts every street object is made of. Written once because "bevel it,
   slat it, band it, bolt it" is the same job on forty different props, and
   because a shared part is a shared triangle budget you can actually reason
   about. Every one of these is authored facing +z, base-anchored. */

/**
 * A run of timber boards along local x with daylight between them.
 *
 * The single most repeated fix in this module: every bench, every pallet,
 * every crate lid in the first pass was one extruded slab, and from the game's
 * overhead camera a bench IS its slat gaps — that is the whole read. `tones`
 * alternates the timber colour board to board so one bench is never one hue.
 */
function slats(m, cx, cz, y, len, n, bw, gap, th, tones) {
  const span = n * bw + (n - 1) * gap;
  for (let k = 0; k < n; k++) {
    const z = cz - span / 2 + bw / 2 + k * (bw + gap);
    if (tones) m.col(tones[k % tones.length]);
    // Slightly narrower on top: ten triangles, no razor arris, and the top face
    // catches the sun at a different angle from the sides.
    m.prism(cx, z, [[y, len, bw], [y + th, len - 0.018, bw * 0.86]]);
  }
}

/** Proud band around a tube — hoop, collar, rim bead, reflective sleeve. */
function band(m, x, z, y, r, h, segs = 8, taper = 0) {
  m.tube(x, z, [[y, r], [y + h, r - taper]], segs);
}

/**
 * Overlapping-lobe foliage mass.
 *
 * The whole planter family shipped one 5-segment cone per pot, and a cone with
 * five facets does not read as a plant, it reads as a low-poly gem — the exact
 * word three separate reviewers used. Three offset domes at different heights
 * cost about 40% more and give a LUMPY silhouette, which is the only thing
 * that separates foliage from crystal at this triangle count.
 */
function bush(m, x, y, z, r, hexA, hexB, segs = 5, lobes = 2, spread = 1) {
  const set = [
    [0, 0, 0, 1.00, hexA],
    [r * 0.52 * spread, r * 0.26, -r * 0.36 * spread, 0.68, hexB],
    [-r * 0.46 * spread, r * 0.10, r * 0.38 * spread, 0.60, hexB],
    [r * 0.10, r * 0.52, r * 0.16, 0.52, hexA],
  ];
  for (let i = 0; i < lobes; i++) {
    const [dx, dy, dz, k, hex] = set[i];
    m.col(hex);
    m.tube(x + dx, z + dz, [
      [y + dy, r * k * 0.66], [y + dy + r * k * 0.72, r * k], [y + dy + r * k * 1.60, r * k * 0.34],
    ], segs, { capTop: true, rot: i * 0.9 });
  }
}

/** Mounded produce / blooms: small overlapping discs at two sizes. */
function berries(m, x, y, z, r, spread, n, hexes, rng) {
  for (let k = 0; k < n; k++) {
    const a = (k / n) * TAU + 0.7;
    const q = 0.45 + ((k * 7) % 5) * 0.11;
    const rr = r * (0.72 + ((k * 3) % 4) * 0.14);
    m.col(hexes[k % hexes.length]);
    m.tube(x + Math.cos(a) * spread * q, z + Math.sin(a) * spread * q, [
      [y + ((k * 5) % 3) * r * 0.22, rr * 0.7], [y + ((k * 5) % 3) * r * 0.22 + rr * 0.85, rr],
      [y + ((k * 5) % 3) * r * 0.22 + rr * 1.7, rr * 0.32],
    ], 4, { capTop: true });
  }
}

/** Chamfered sign plate with a border stripe printed on BOTH faces. */
function plateBoth(m, cx, cy, w, h, t, faceHex, borderHex, inset = 0.04) {
  m.col(faceHex).prism(cx, 0, [[cy - h / 2, w, t], [cy + h / 2, w, t]]);
  if (borderHex === null) return;
  m.col(borderHex);
  for (const s of [-1, 1]) {
    const z = s * (t / 2 + 0.006);
    m.xform(0, 0, 0, z);
    // Border drawn as four thin bars so the middle stays the plate colour.
    m.prism(cx, 0, [[cy + h / 2 - inset, w - inset * 2, 0.008], [cy + h / 2 - inset * 0.5, w - inset * 2, 0.008]]);
    m.prism(cx, 0, [[cy - h / 2 + inset * 0.5, w - inset * 2, 0.008], [cy - h / 2 + inset, w - inset * 2, 0.008]]);
    for (const sx of [-1, 1]) {
      m.prism(cx + sx * (w / 2 - inset * 0.75), 0,
        [[cy - h / 2 + inset * 0.5, inset * 0.5, 0.008], [cy + h / 2 - inset * 0.5, inset * 0.5, 0.008]]);
    }
    m.reset();
  }
}

/** Blocky legend bar on both faces of a plate — lettering at game distance. */
function legendBoth(m, cx, cy, w, h, zFace, hex) {
  m.col(hex);
  for (const s of [-1, 1]) {
    m.xform(0, 0, 0, s * zFace);
    m.prism(cx, 0, [[cy - h / 2, w, 0.01], [cy + h / 2, w, 0.01]]);
    m.reset();
  }
}

/**
 * Flat rectangle facing +z or -z. Two triangles.
 *
 * The whole signage family paints its legend on ONE face, so from behind half
 * the stop signs in the city are bare red octagons. Lettering has to be cheap
 * enough to draw twice, and this is how cheap: a route number, a border stripe,
 * a chalk mark and a poster block are all two triangles each.
 */
function decal(m, cx, cy, z, w, h, dir = 1) {
  const a = w / 2, b = h / 2;
  if (dir > 0) {
    m.quad([cx - a, cy - b, z], [cx + a, cy - b, z], [cx + a, cy + b, z], [cx - a, cy + b, z]);
  } else {
    m.quad([cx + a, cy - b, -z], [cx - a, cy - b, -z], [cx - a, cy + b, -z], [cx + a, cy + b, -z]);
  }
  return m;
}

/** Border stripe drawn as four thin decals, on both faces of a plate. */
function borderBoth(m, cx, cy, z, w, h, t) {
  for (const s of [1, -1]) {
    decal(m, cx, cy + h / 2 - t / 2, z, w, t, s);
    decal(m, cx, cy - h / 2 + t / 2, z, w, t, s);
    decal(m, cx - w / 2 + t / 2, cy, z, t, h, s);
    decal(m, cx + w / 2 - t / 2, cy, z, t, h, s);
  }
}

/** Flat decal lying on a leaf raked in the YZ plane. Chalk, posters, menus. */
function rake(m, cx, w, y0, z0, y1, z1, off) {
  const dy = y1 - y0, dz = z1 - z0;
  const L = Math.hypot(dy, dz) || 1;
  const ny = dz / L, nz = -dy / L;
  const A = [cx - w / 2, y0 + ny * off, z0 + nz * off];
  const B = [cx + w / 2, y0 + ny * off, z0 + nz * off];
  const C = [cx + w / 2, y1 + ny * off, z1 + nz * off];
  const D = [cx - w / 2, y1 + ny * off, z1 + nz * off];
  return m.quad(A, D, C, B);
}

/** Cast base flange with a ring of bolt heads. Posts, hydrants, bollards. */
function flange(m, x, z, y, r, h, bolts = 0, segs = 8, boltR = 0.022) {
  m.tube(x, z, [[y, r], [y + h * 0.6, r], [y + h, r * 0.86]], segs, { capTop: true });
  for (let k = 0; k < bolts; k++) {
    const a = (k / bolts) * TAU + 0.3;
    m.tube(x + Math.cos(a) * r * 0.72, z + Math.sin(a) * r * 0.72,
      [[y + h, boltR], [y + h + boltR * 0.7, boltR * 0.7]], 3, { capTop: true });
  }
}

/** Round rope run with a real sag. Five chords and a 6-sided section. */
function ropeRun(m, x0, x1, z, yEnd, ySag, r = 0.035, segs = 5) {
  const N = 5;
  const yOf = (t) => yEnd - (yEnd - ySag) * (1 - (2 * t - 1) * (2 * t - 1));
  for (let k = 0; k < N; k++) {
    const t0 = k / N, t1 = (k + 1) / N;
    const ax = x0 + (x1 - x0) * t0, bx = x0 + (x1 - x0) * t1;
    m.tubeBetween(ax, yOf(t0), z, bx, yOf(t1), z, r, segs);
  }
}

/* -- litter / kerbside ---------------------------------------------------- */

/**
 * Traffic cone — ORANGE with a white sleeve, on a moulded base plate.
 *
 * The first pass had the banding inverted (white body, orange cap), an open
 * hollow where the base should be and two razor wings for a skirt. Instant
 * readability is the entire premise of this game and the most iconic street
 * object in it was failing at it. The plate is a chamfered octagon so the
 * corners are not needles, the sweep starts on top of the plate with a fillet
 * ring, and the tip is rounded rather than a point.
 */
function gCone(m) {
  m.col(P.CONE_ORANGE);
  m.oct(0, 0, [[0, 0.37, 0.37, 0.055], [0.034, 0.35, 0.35, 0.05]],
    { cols: [P.CONE_ORANGE, P.CONE_ORANGE] });
  m.tube(0, 0, [
    [0.030, 0.205], [0.085, 0.158], [0.30, 0.118], [0.46, 0.092],
    [0.66, 0.043], [0.72, 0.026],
  ], 7, {
    capTop: true,
    cols: [P.CONE_ORANGE, P.CONE_ORANGE, P.CONE_STRIPE, P.CONE_ORANGE, P.CONE_ORANGE],
  });
}

/**
 * Bollard. Cast base flange, tapered shaft, reflective band, domed cap.
 *
 * 631 of these — the most placed object in the city — and the first pass was a
 * bare tapered stick with a flat cut on top and no value separation against
 * bone paving at all. Four rings at eight segments buys the three things every
 * bollard has: a splayed foot that gives it a real contact edge, the band, and
 * a cap. The band is authored WHITE against a mid-grey shaft so the ratio
 * survives whatever the per-instance tint multiplies through it.
 */
function gBollard(m) {
  m.tube(0, 0, [
    [0, 0.212], [0.052, 0.150], [0.70, 0.093], [0.78, 0.091], [0.96, 0.040],
  ], 8, {
    capTop: true,
    cols: [0x9aa09e, 0xd8dcda, 0xffffff, 0xd0d4d2],
  });
}

/**
 * Stone bollard. Chamfered arrises, plinth course, recessed shaft, domed cap.
 *
 * 350 dead-flat bone posts at almost exactly the pavement's own luminance was
 * the tell. `oct` cuts the four vertical corners — the thing that separates a
 * carved block from an extrusion — and the body is authored near-white so the
 * tint array can take the stone a value or two DARKER than the paving it
 * stands on, which the art direction demands and the first pass ignored.
 */
function gBollardStone(m) {
  m.oct(0, 0, [
    [0, 0.40, 0.40, 0.032], [0.05, 0.335, 0.335, 0.028],
    [0.62, 0.325, 0.325, 0.027], [0.80, 0.30, 0.30, 0.024],
    [0.88, 0.235, 0.235, 0.020],
  ], { cols: [0xc4bcac, 0xf6f2e8, 0xece6d8, 0xf2eee4] });
}

/**
 * Cast-iron bell bollard with a ball finial.
 *
 * The third bollard MODEL, not a recolour. `bollard` is the single most placed
 * object in the city (875 of them) and `bollardStone` is a square block, so a
 * kerb run that wants a third beat has only ever had two. This one is round
 * like the first but has a waisted shaft, a collar and a ball on top, which is
 * a different silhouette from every angle including straight down.
 */
function gBollardBell(m) {
  // Six segments and the painted band folded into the sweep's own `cols`, so a
  // bollard the city places hundreds of times costs 76 triangles rather than
  // 117 — and at 6 it matches gBollard, which is the house round-ness.
  m.tube(0, 0, [[0, 0.185], [0.07, 0.155], [0.44, 0.120], [0.50, 0.118],
    [0.72, 0.142], [0.80, 0.118]], 6, {
    capTop: false,
    cols: [P.BENCH_METAL, P.BENCH_METAL, P.ACCENT_SUN, P.BENCH_METAL, P.BENCH_METAL],
  });
  m.col(P.BENCH_METAL);
  m.tube(0, 0, [[0.80, 0.100], [0.87, 0.128], [0.96, 0.052]], 6, { capTop: true });
}

/**
 * Dry-barrel fire hydrant — flange, waisted barrel, shoulder, two side outlets,
 * a steamer outlet at the kerb, domed bonnet and an operating nut.
 *
 * 329 red bollards wearing a hat, with no outlets and no contact shadow. The
 * outlets are what make the silhouette read as a hydrant from ANY angle, which
 * is the whole job at 0.8 m.
 *
 * COLOUR: the bonnet and the outlet caps are authored WHITE and the body red,
 * so the per-instance hex recolours the caps while only deepening the body —
 * that is how one geometry yields the yellow-bonnet, white-bonnet and
 * cream-bonnet variants a real kerb run has, out of a multiplicative tint.
 */
function gHydrant(m) {
  m.col(P.HYDRANT_RED);
  m.tube(0, 0, [[0, 0.235], [0.055, 0.160]], 6, { cols: [0xd8342a] });
  m.tube(0, 0, [[0.055, 0.158], [0.14, 0.140], [0.44, 0.124], [0.52, 0.158]], 6);
  m.tube(0, 0, [[0.52, 0.166], [0.62, 0.146]], 6);
  m.col(0xffffff);
  m.tube(0, 0, [[0.62, 0.140], [0.74, 0.086], [0.80, 0.044], [0.84, 0.036]], 6, { capTop: true });
  // Two 2.5 in side outlets and one 4.5 in steamer at the kerb face.
  for (const s of [-1, 1]) {
    m.col(P.HYDRANT_RED).tubeBetween(s * 0.11, 0.34, 0, s * 0.20, 0.34, 0, 0.058, 5);
    m.col(0xffffff).tubeBetween(s * 0.20, 0.34, 0, s * 0.245, 0.34, 0, 0.070, 5, true);
  }
  m.col(P.HYDRANT_RED).tubeBetween(0, 0.36, 0.10, 0, 0.36, 0.19, 0.078, 6);
  m.col(0xffffff).tubeBetween(0, 0.36, 0.19, 0, 0.36, 0.235, 0.090, 6, true);
  // Chain loop between the two side caps — the detail that says cast iron.
  m.col(0x8a8f8c);
  m.tubeBetween(-0.20, 0.30, 0.02, 0, 0.24, 0.06, 0.014, 3);
  m.tubeBetween(0, 0.24, 0.06, 0.20, 0.30, 0.02, 0.014, 3);
}

/**
 * Fire-department standpipe (the "Siamese" inlet every US frontage has and no
 * procedural street ever does). Reads as a hydrant's tall cousin: same red, but
 * a slim riser with two chrome inlets angled at the kerb and a placard on top.
 */
function gStandpipe(m) {
  m.col(P.CONCRETE_DARK).oct(0, 0, [[0, 0.40, 0.34, 0.04], [0.07, 0.34, 0.28, 0.035]]);
  // Cast flange with four bolt heads where the riser lands on the pad.
  m.col(0x9a2820).tube(0, 0, [[0.07, 0.195], [0.115, 0.120]], 6, { capTop: true });
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * TAU + 0.4;
    m.tube(Math.cos(a) * 0.145, Math.sin(a) * 0.145,
      [[0.10, 0.026], [0.125, 0.019]], 3, { capTop: true });
  }
  m.col(P.HYDRANT_RED);
  m.tube(0, 0, [[0.115, 0.108], [0.44, 0.100], [0.50, 0.122], [0.56, 0.100], [0.80, 0.094]], 6,
    { cols: [0xc4322a, P.HYDRANT_RED, P.HYDRANT_RED, P.HYDRANT_RED] });
  m.tube(0, 0, [[0.80, 0.150], [0.90, 0.136]], 6, { capTop: true });
  /* The Siamese inlets. Round bosses with hex caps, splayed 30 deg out and
     dropped 20 deg — as square beams in cream they read as two boxes glued to
     a post, which is what the catalogue shot showed. */
  for (const s of [-1, 1]) {
    m.col(P.HYDRANT_RED).tubeBetween(0, 0.66, 0.04, s * 0.15, 0.60, 0.17, 0.062, 6);
    m.col(P.CHROME).tubeBetween(s * 0.15, 0.60, 0.17, s * 0.20, 0.58, 0.22, 0.078, 6, true);
    m.col(0x8a8f8c).tubeBetween(s * 0.17, 0.56, 0.19, s * 0.07, 0.46, 0.12, 0.012, 3);
  }
  // Placard on a visible bracket rather than floating off the riser.
  m.col(P.STEEL_DARK).beam(0, 0.94, 0.06, 0, 0.98, 0.10, 0.05, 0.05, false);
  m.col(P.SIGN_FACE).prism(0, 0.115, [[0.92, 0.28, 0.022], [1.06, 0.28, 0.022]]);
  m.col(P.HYDRANT_RED).prism(0, 0.128, [[0.96, 0.20, 0.008], [1.01, 0.20, 0.008]]);
}

/**
 * In-ground uplighter: flush bezel, shielded well, louvred lens.
 *
 * The lens is recessed 4 cm into a dark well with three louvre bars across it,
 * so what the camera sees by day is a fitting rather than a bright stud. The
 * pale ring on the paving is authored at the paving's own value and carries the
 * glow flag, so it is invisible at noon and becomes the pool of light this
 * thing is supposed to throw once the day/night cycle turns over — the closest
 * an opaque instanced material can get to a light cone.
 */
function gUplighter(m) {
  m.lit(P.SIDEWALK, 1.02, 0.85).disc(0, 0.011, 0, 0.46, 8);
  m.col(P.ALUMINIUM).tube(0, 0, [[0, 0.195], [0.035, 0.185], [0.05, 0.150]], 6, { capTop: false });
  m.col(P.STEEL_DARK).tube(0, 0, [[0.05, 0.145], [0.21, 0.138]], 6, { capTop: false });
  m.lit(P.LAMP_GLOW, 1, 1.35).disc(0, 0.165, 0, 0.118, 6);
  m.col(0x22262a);
  for (const z of [-0.07, 0, 0.07]) m.plate(0, 0.182, z, 0.22, 0.022);
}

/**
 * Mooring cleat. Bow-tie in plan: oval base plate, waisted stem, horns that
 * sweep up and taper. The first pass was a dark lozenge on the quay because the
 * one shape that identifies a cleat — the double horn — was a straight bar.
 */
function gMooringCleat(m) {
  m.col(P.STEEL_DARK);
  m.tube(0, 0, [[0, 0.15, 0.10], [0.035, 0.145, 0.095], [0.05, 0.10, 0.07]], 6, { capTop: false });
  for (const s of [-1, 1]) {
    m.tube(s * 0.10, 0, [[0.04, 0.028], [0.055, 0.020]], 3, { capTop: true });
  }
  // Waisted stem, then the horn bar with ends swept up and tapered.
  m.tube(0, 0, [[0.05, 0.085, 0.062], [0.12, 0.062, 0.048], [0.17, 0.080, 0.060]], 5, { capTop: false });
  m.col(0x7f8785);
  m.tubeBetween(-0.09, 0.185, 0, 0.09, 0.185, 0, 0.055, 5);
  for (const s of [-1, 1]) {
    m.tubeBetween(s * 0.09, 0.185, 0, s * 0.19, 0.215, 0, 0.046, 5);
    m.tubeBetween(s * 0.19, 0.215, 0, s * 0.25, 0.228, 0, 0.026, 4, true);
  }
}

/* -- bins ----------------------------------------------------------------- */

/**
 * Municipal litter bin: hexagonal body with a recessed panel per face, a domed
 * lid raised on a visible gap, a push flap on the street face and a plinth.
 *
 * The old one was an uncapped tube, so you looked through the near wall at the
 * inside of the far one with the lid floating over the hole. `M.tube`'s winding
 * is fixed at source now, but the object still needed to become a bin: the lid
 * stands on three short posts so the shadow line under it reads, and the body
 * steps IN between 0.14 and 0.66 so the panel is a real reveal, not a decal.
 *
 * Body authored near-white; lid and plinth mid-grey. The instance hex then
 * paints the body green or grey and drags the lid to a darker shade of the
 * same, which is exactly how a colour-coded municipal bin is finished.
 */
function gBinMuni(m) {
  m.col(0x6c736e).tube(0, 0, [[0, 0.385], [0.055, 0.352]], 6, { rot: 0.26 });
  m.col(0xf4f4f4);
  m.tube(0, 0, [
    [0.055, 0.348], [0.115, 0.338], [0.15, 0.316], [0.62, 0.322], [0.66, 0.344], [0.72, 0.352],
  ], 6, { rot: 0.26, cols: [0xf4f4f4, 0xe4e4e4, 0xf4f4f4, 0xf4f4f4, 0xfafafa] });
  m.col(0x24282a).disc(0, 0.70, 0, 0.33, 6, 0.26);
  // Lid on a 5 cm gap: three short posts, a domed cap and a closed underside.
  m.col(0x6c736e);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * TAU + 0.5;
    m.tubeBetween(Math.cos(a) * 0.27, 0.72, Math.sin(a) * 0.27,
      Math.cos(a) * 0.27, 0.77, Math.sin(a) * 0.27, 0.032, 3);
  }
  m.col(0x7b827c).disc(0, 0.77, 0, 0.40, 6, 0.26, false);
  m.tube(0, 0, [[0.77, 0.40], [0.90, 0.365], [1.00, 0.20]], 6, { rot: 0.26, capTop: true });
  // Push flap on the street face, plus a small embossed city crest.
  m.col(0x1d2124).prism(0, 0.312, [[0.30, 0.30, 0.03], [0.54, 0.30, 0.03]]);
  m.col(0xd8dcd6).prism(0, 0.322, [[0.20, 0.14, 0.014], [0.28, 0.14, 0.014]]);
}

/**
 * Wheelie bin. Chamfered vertical arrises, four pressed rib lines, a lid with
 * an overhang lip, a hinge barrel, a grab handle, two wheels and a number plate.
 *
 * The one bin whose per-instance colour was already doing its job — so this is
 * about moulding. `oct` cuts the four corners and the rib lines come out of the
 * sweep's own tone changes, which is free relief at 3 m.
 */
function gBinWheelie(m) {
  m.col(0x2b2f33).prism(0, -0.02, [[0, 0.30, 0.34], [0.15, 0.46, 0.42]]);
  m.oct(0, 0, [
    [0.15, 0.50, 0.44, 0.03], [0.20, 0.56, 0.49, 0.03], [0.42, 0.570, 0.500, 0.03],
    [0.66, 0.585, 0.515, 0.03], [0.94, 0.600, 0.530, 0.035],
  ], { capTop: false, cols: [0xdcdcdc, 0xffffff, 0xf2f2f2, 0xffffff] });
  // Lid: overhang lip, hinge barrel at the back, grab handle at the front.
  m.col(0xe8e8e8).prism(0, 0.01, [[0.94, 0.625, 0.555], [0.99, 0.620, 0.545], [1.02, 0.58, 0.50]]);
  m.col(0x33383c);
  m.tubeBetween(-0.27, 0.985, -0.26, 0.27, 0.985, -0.26, 0.035, 5);
  m.beam(-0.24, 1.015, 0.245, 0.24, 1.015, 0.245, 0.055, 0.045);
  // Wheels on a visible axle, and the lifting-comb channel above them.
  m.col(0x1e2124);
  for (const s of [-1, 1]) {
    m.tubeBetween(s * 0.23, 0.115, -0.26, s * 0.29, 0.115, -0.26, 0.115, 6, true);
  }
  m.col(0x9aa0a2).prism(0, -0.255, [[0.30, 0.30, 0.02], [0.46, 0.30, 0.02]]);
  m.col(0x30343a).plate(0.20, 0.945, 0.16, 0.16, 0.10);
}

/**
 * Wire litter bin. A ring of twelve vertical bars between two hoops, with a
 * dark liner set inside them so you read bars-against-liner and not
 * bars-against-sky, and a short post foot so it is not flush on the paving.
 *
 * Labelled "Wire Bin" and placed 394 times as two solid tapered boxes with no
 * mesh, no bars and no aperture. The openwork silhouette is the entire object.
 */
function gBinMesh(m) {
  const R = 0.30, N = 12;
  m.col(P.STEEL_DARK).tube(0, 0, [[0, 0.11], [0.06, 0.10], [0.10, 0.085]], 5, { capTop: false });
  m.col(P.BENCH_METAL);
  for (let k = 0; k < N; k++) {
    const a = (k / N) * TAU;
    const c = Math.cos(a), q = Math.sin(a);
    m.tubeBetween(c * R * 0.90, 0.09, q * R * 0.90, c * R, 0.82, q * R, 0.022, 3);
  }
  m.tube(0, 0, [[0.13, R * 0.945], [0.17, R * 0.955]], 8);
  m.tube(0, 0, [[0.72, R * 1.01], [0.76, R * 1.01]], 8);
  // Liner: lighter than the frame so the bars separate against it, and capped
  // at 0.66 so the bin has contents rather than a hole through the world.
  m.col(0x8e948f).tube(0, 0, [[0.10, R * 0.86], [0.66, R * 0.90]], 8, { capTop: false });
  m.col(0x3b3f42).disc(0, 0.66, 0, R * 0.90, 8);
  m.col(P.BENCH_METAL).tube(0, 0, [[0.82, R * 1.06], [0.86, R * 1.10], [0.88, R * 0.98]], 8,
    { capTop: false });
}

/**
 * Sacks put out for collection. The only SOFT silhouette on any pavement in the
 * game — everything else this module makes is a box, a tube or a board — which
 * is exactly why a back-of-house kerb needs it: three slumped bags say "bin day
 * behind a restaurant" in a way no amount of extra wheelie bins can.
 */
function gTrashBags(m) {
  /* Gathered-neck profile, not a dome. The shoulder bulges, the neck pinches
     and a twisted knot sits on top; every sack is squashed non-uniformly and
     spun to its own angle, so no two are the same lump. The pile is then
     VALUE-SEPARATED — charcoal, blue-grey and one pale clear-recycling sack —
     because four bags within one value of black read as boulders. */
  const bags = [
    [-0.30, -0.04, 0, 0.30, 0x2b2f33, 0.4, 1.16, 0.86],
    [0.28, 0.08, 0, 0.34, 0x39424a, 1.9, 1.10, 0.90],
    [0.00, 0.30, 0, 0.27, 0x9aa39c, 3.3, 1.14, 0.84],
    [-0.05, 0.02, 0.44, 0.26, 0x323739, 5.0, 1.12, 0.88],
  ];
  for (const [x, z, y, r, hex, rot, kx, kz] of bags) {
    m.col(hex);
    m.tube(x, z, [
      [y, r * 0.55 * kx, r * 0.55 * kz],
      [y + r * 0.35, r * 1.00 * kx, r * 1.00 * kz],
      [y + r * 0.90, r * 0.85 * kx, r * 0.85 * kz],
      [y + r * 1.25, r * 0.30 * kx, r * 0.30 * kz],
      [y + r * 1.45, r * 0.16 * kx, r * 0.16 * kz],
    ], 7, { capTop: true, rot });
    // Twisted knot: two short crossed bars at the neck.
    m.col(hex, 0.86);
    const ky = y + r * 1.45;
    m.tubeBetween(x - r * 0.16, ky, z - r * 0.10, x + r * 0.18, ky + r * 0.12, z + r * 0.08, r * 0.07, 3);
    m.tubeBetween(x - r * 0.14, ky + r * 0.10, z + r * 0.12, x + r * 0.16, ky + r * 0.02, z - r * 0.12, r * 0.06, 3);
  }
  // A kerb pile is bags AND boxes. Flattened cartons leaning on the sacks.
  const boxes = [[-0.56, 0.30, 0.52, 0.36, 0.16, P.WOOD_LIGHT],
    [0.52, -0.30, 0.44, 0.30, 0.12, P.WOOD_DECK],
    [0.10, -0.44, 0.30, 0.26, 0.22, P.WOOD_LIGHT]];
  for (const [x, z, w, h, d, hex] of boxes) {
    m.col(hex);
    m.prism(x, z, [[0, w - 0.03, d - 0.03], [0.02, w, d], [h - 0.02, w, d], [h, w - 0.03, d - 0.03]]);
  }
}

/* -- seating -------------------------------------------------------------- */

/* Timber tones used slat-to-slat inside one bench. Authored near-white so the
   per-instance hex is what sets the species; the pair keeps a single bench
   from being a single colour, which 459 identical orange planks were. */
const SLAT_A = [0xfaf6ee, 0xe6dccc];
const SLAT_B = [0xf2ece0, 0xdcd0bc];

/**
 * Park bench — five seat slats, three back slats, cast-iron end frames.
 *
 * Its own comment claimed "timber slats on cast-iron ends" while the geometry
 * was one flat plank for the seat, one for the back and two pin legs. This is
 * the object it always said it was: daylight through the seat from the high
 * camera, an L-shaped end frame with an arm knee, foot plates so it lands on an
 * edge rather than four points, and a stretcher tying the two ends together.
 */
function gBenchSlat(m) {
  slats(m, 0, 0.05, 0.44, 1.80, 5, 0.09, 0.018, 0.048, SLAT_A);
  // Back: three boards raked back off the arm knee.
  for (let k = 0; k < 3; k++) {
    m.col(SLAT_B[k % 2]);
    const t = k / 2;
    m.board(0, 1.80, 0.56 + t * 0.30, -0.19 - t * 0.055, 0.62 + t * 0.30, -0.215 - t * 0.055, 0.048);
  }
  m.col(P.BENCH_METAL);
  for (const s of [-1, 1]) {
    const x = s * 0.86;
    // Foot plate first: a contact edge, not a point.
    m.prism(x, 0.01, [[0, 0.14, 0.60], [0.035, 0.11, 0.56]]);
    m.tubeBetween(x, 0.03, 0.235, x, 0.44, 0.215, 0.050, 4);   // front leg
    m.tubeBetween(x, 0.03, -0.215, x, 0.50, -0.20, 0.050, 4);  // rear leg
    m.tubeBetween(x, 0.50, -0.20, x, 0.62, -0.17, 0.048, 4);   // knee
    m.tubeBetween(x, 0.62, -0.17, x, 0.615, 0.24, 0.048, 4);   // arm
    m.tubeBetween(x, 0.615, 0.24, x, 0.50, 0.245, 0.045, 4);   // arm drop to seat
  }
  m.tubeBetween(-0.86, 0.20, 0.01, 0.86, 0.20, 0.01, 0.036, 4);  // cross stretcher
}

/**
 * Precast bench: two end piers, a seat cast in three units, a slatted teak cap.
 *
 * A single slab balanced on one central pedestal read as a butter block that
 * would tip. Two piers with a chamfered top and a 3 cm shadow reveal under the
 * seat is what makes cast stone look like cast stone, and the joints between
 * the seat segments are what stop it reading as one extrusion.
 */
function gBenchConcrete(m) {
  m.col(0xf2ece0);
  for (const s of [-1, 1]) {
    m.prism(s * 0.74, 0, [
      [0, 0.44, 0.56], [0.05, 0.40, 0.52], [0.36, 0.40, 0.52], [0.40, 0.46, 0.58],
    ], { cols: [0xc8c0ae, 0xf2ece0, 0xf2ece0] });
  }
  // Shadow reveal: the seat sits on a narrower plinth than the pier top.
  m.col(0xd8d0be);
  for (const s of [-1, 1]) m.prism(s * 0.74, 0, [[0.40, 0.34, 0.46], [0.43, 0.34, 0.46]]);
  m.col(0xf6f0e4);
  for (let k = -1; k <= 1; k++) {
    m.prism(k * 0.716, 0, [
      [0.43, 0.70, 0.58], [0.47, 0.704, 0.584], [0.505, 0.66, 0.545],
    ]);
  }
  m.col(P.TEAK);
  slats(m, 0, 0, 0.505, 2.06, 3, 0.15, 0.014, 0.045, [0xffffff, 0xeadfcc]);
}

/**
 * Backless park bench: three slats on two steel sled frames.
 *
 * A plank on four sticks, 65 times. The sled frames give it a real contact
 * footprint instead of four points, and the bolt heads at every board-to-frame
 * junction are what a bench of this kind is actually made of.
 */
function gBenchBackless(m) {
  slats(m, 0, 0, 0.40, 1.66, 3, 0.115, 0.02, 0.05, SLAT_A);
  m.col(P.BENCH_METAL);
  for (const s of [-1, 1]) {
    const x = s * 0.66;
    m.prism(x, 0, [[0, 0.12, 0.50], [0.04, 0.09, 0.46]]);
    m.tubeBetween(x, 0.035, 0.18, x, 0.40, 0.155, 0.045, 4);
    m.tubeBetween(x, 0.035, -0.18, x, 0.40, -0.155, 0.045, 4);
    m.tubeBetween(x, 0.40, -0.155, x, 0.40, 0.155, 0.045, 4);
  }
  m.tubeBetween(-0.66, 0.16, 0, 0.66, 0.16, 0, 0.032, 4);
  m.col(0x8f9694);
  for (const s of [-1, 1]) {
    for (const z of [-0.135, 0, 0.135]) m.plate(s * 0.66, 0.451, z, 0.05, 0.05);
  }
}

/**
 * Bowed civic bench: three precast segments set on a shallow arc with a timber
 * seat and a slim steel back rail.
 *
 * `benchSlat` is placed 706 times and `benchConcrete` is a straight bar, so
 * every plaza in the city was ruled with straight lines of seating. The bow is
 * only 0.2 m over 2.6 m — enough that the shadow and the top edge curve, which
 * is all the eye needs to stop counting copies.
 */
/**
 * Bowed civic bench. The bow is now 0.45 m over the 2.6 m run, not 0.20: at
 * 0.20 neither the top edge nor the cast shadow curved enough to see, which is
 * the only reason the object exists. Four slats follow the arc as three chords
 * each, the piers have chamfered tops and a shadow reveal, and the back is two
 * rails on short posts instead of one bar floating behind the seat.
 */
function gBenchCurve(m) {
  const bow = (t) => 0.45 * (t * t);                 // t in [-1, 1] across the run
  for (let k = -1; k <= 1; k++) {
    const x = k * 0.88, z = bow(k);
    m.col(0xf2ece0);
    m.prism(x, z, [
      [0, 0.80, 0.56], [0.05, 0.74, 0.50], [0.36, 0.74, 0.50], [0.40, 0.82, 0.58],
    ], { cols: [0xc8c0ae, 0xf2ece0, 0xf2ece0] });
    m.col(0xd8d0be).prism(x, z, [[0.40, 0.66, 0.44], [0.43, 0.66, 0.44]]);
  }
  // Seat: four slats, each three chords following the arc.
  const N = 3, X = 1.30;
  for (let s = 0; s < 4; s++) {
    m.col(SLAT_A[s % 2]);
    const dz = -0.165 + s * 0.115;
    for (let k = 0; k < N; k++) {
      const t0 = -1 + (2 * k) / N, t1 = -1 + (2 * (k + 1)) / N;
      m.beam(t0 * X, 0.455, bow(t0) + dz, t1 * X, 0.455, bow(t1) + dz, 0.095, 0.048, false);
    }
  }
  // Back: two rails on three short posts, following the same arc.
  m.col(P.BENCH_METAL);
  for (const t of [-1, 0, 1]) {
    m.tubeBetween(t * X * 0.96, 0.44, bow(t * 0.96) - 0.20,
      t * X * 0.96, 0.90, bow(t * 0.96) - 0.30, 0.042, 4);
  }
  for (const y of [0.70, 0.87]) {
    m.col(SLAT_B[y > 0.8 ? 0 : 1]);
    for (let k = 0; k < N; k++) {
      const t0 = -1 + (2 * k) / N, t1 = -1 + (2 * (k + 1)) / N;
      const d = y > 0.8 ? -0.30 : -0.256;
      m.beam(t0 * X, y, bow(t0) + d, t1 * X, y, bow(t1) + d, 0.10, 0.05, false);
    }
  }
}

/**
 * Picnic table. The top is five planks with 8 mm gaps you can see the grass
 * through — from the game's overhead camera that IS the object — the benches
 * are two planks each, and the two A-frames are tied by a cross-brace and a
 * diagonal so the frame reads as carpentry rather than two separate trestles.
 */
function gPicnicTable(m) {
  slats(m, 0, 0, 0.70, 1.96, 5, 0.155, 0.014, 0.055,
    [P.WOOD_DECK, P.WOOD_LIGHT, P.WOOD_DECK, 0xd6a878, P.WOOD_LIGHT]);
  for (const s of [-1, 1]) {
    slats(m, 0, s * 0.76, 0.44, 1.92, 2, 0.145, 0.014, 0.05, [P.WOOD_LIGHT, P.WOOD_DECK]);
  }
  m.col(P.WOOD_DARK);
  for (const s of [-1, 1]) {
    m.beam(s * 0.80, 0, 0.86, s * 0.80, 0.70, 0.10, 0.09, 0.09);
    m.beam(s * 0.80, 0, -0.86, s * 0.80, 0.70, -0.10, 0.09, 0.09);
    m.beam(s * 0.80, 0.40, -0.90, s * 0.80, 0.40, 0.90, 0.08, 0.07, false);
  }
  m.beam(-0.80, 0.62, 0, 0.80, 0.62, 0, 0.08, 0.08, false);
  m.beam(-0.80, 0.40, -0.62, 0.80, 0.64, 0.10, 0.06, 0.06, false);
  m.col(0x6b6f6c);
  for (const s of [-1, 1]) {
    for (const z of [-0.62, -0.28, 0.28, 0.62]) m.plate(s * 0.80, 0.756, z, 0.05, 0.05);
  }
}

/**
 * Sun lounger. A teak frame FIRST — two side rails the full 1.9 m with a foot
 * at each end and a rail under the knee — then the cushion dropped inside it so
 * the frame stands 3 cm proud all round. Seat pad and back pad are separate
 * with a hinge bar between them, which is the joint that says "this reclines".
 */
function gLounger(m) {
  m.col(P.WOOD_DARK);
  for (const s of [-1, 1]) {
    m.beam(s * 0.34, 0.36, -0.92, s * 0.34, 0.36, 0.94, 0.07, 0.09, false);
    for (const z of [-0.80, 0.02, 0.84]) {
      m.beam(s * 0.34, 0, z, s * 0.34, 0.36, z, 0.06, 0.06, false);
      m.prism(s * 0.34, z, [[0, 0.11, 0.11], [0.03, 0.09, 0.09]]);
    }
  }
  m.beam(-0.34, 0.30, 0.30, 0.34, 0.30, 0.30, 0.06, 0.06, false);
  m.col(0xf2f2f2);
  m.prism(0, 0.30, [[0.38, 0.60, 1.04], [0.42, 0.62, 1.06], [0.47, 0.58, 1.02]]);
  m.col(0xe8e8e8).tubeBetween(-0.30, 0.42, -0.26, 0.30, 0.42, -0.26, 0.035, 4);
  m.col(0xf2f2f2);
  m.board(0, 0.60, 0.44, -0.30, 0.88, -0.74, 0.10);
  // A rolled towel over the foot end. One in four loungers has one and this is
  // the one that carries it — the pool edge stops reading as a showroom.
  m.col(0xfaf6ee).tubeBetween(-0.22, 0.52, 0.72, 0.22, 0.52, 0.72, 0.075, 5, true);
}

/* -- signage -------------------------------------------------------------- */

/** Sign post with a cast base collar and a cap. */
function pole(m, h, r = 0.045, hex = P.SIGN_POLE) {
  m.col(hex).tube(0, 0, [
    [0, r * 1.9], [0.06, r * 1.25], [0.10, r], [h, r * 0.92], [h + 0.05, r * 0.60],
  ], 6, { capTop: true });
}

/** Slim bracket band where a plate clamps to its post. */
function bracket(m, y, w = 0.13, h = 0.09, d = 0.11, hex = P.SIGN_POLE) {
  m.col(hex).prism(0, 0, [[y, w, d], [y + h, w, d]]);
}

/**
 * Stop sign. The white ring, the red field and blocky STOP lettering are now
 * on BOTH faces — roughly half the 135 stop signs in the city present their
 * back to the camera, and the back was a bare red octagon. The plate is thinner
 * (0.03) with a chamfer ring so the rim catches sun instead of going black on
 * the silhouette, and the post is a U-channel with two bolt heads through it.
 */
function gSignStop(m) {
  m.col(P.SIGN_POLE);
  m.prism(0, 0, [[0, 0.10, 0.10], [0.07, 0.075, 0.07], [2.36, 0.070, 0.062]]);
  m.col(P.HYDRANT_RED);
  m.discZ(0, 2.30, 0.40, 0.030, 8, Math.PI / 8);
  m.discZ(0, 2.30, 0.372, 0.046, 8, Math.PI / 8);   // chamfered rim bead
  for (const s of [1, -1]) {
    m.col(P.SIGN_FACE).faceZ(0, 2.30, s * 0.026, 0.348, 8, Math.PI / 8);
    m.col(P.HYDRANT_RED).faceZ(0, 2.30, s * 0.030, 0.302, 8, Math.PI / 8);
    m.col(P.SIGN_FACE);
    for (let k = 0; k < 4; k++) decal(m, -0.165 + k * 0.11, 2.30, s * 0.034, 0.062, 0.155, s);
  }
  m.col(0x8f9694);
  for (const y of [2.12, 2.48]) {
    m.prism(0, 0, [[y, 0.11, 0.09], [y + 0.035, 0.11, 0.09]]);
  }
}

/**
 * No-entry disc. White bar mirrored onto the back face, a thin white rim ring
 * inset on both faces and a chamfered rim so the edge is not a black sliver.
 */
function gSignNoEntry(m) {
  pole(m, 2.26);
  m.col(P.HYDRANT_RED);
  m.discZ(0, 2.26, 0.36, 0.028, 8);
  m.discZ(0, 2.26, 0.335, 0.044, 8);
  for (const s of [1, -1]) {
    m.col(P.SIGN_FACE).faceZ(0, 2.26, s * 0.024, 0.325, 8);
    m.col(P.HYDRANT_RED).faceZ(0, 2.26, s * 0.028, 0.288, 8);
    m.col(P.SIGN_FACE);
    decal(m, 0, 2.26, s * 0.032, 0.46, 0.135, s);
  }
  bracket(m, 2.14, 0.13, 0.10, 0.10);
}

/**
 * One-way plate. The white bar and the arrow are on both faces and the arrow
 * now spans 80% of the plate, which is what makes it readable as a direction
 * rather than a white smudge.
 */
function gSignOneWay(m) {
  pole(m, 2.46);
  m.col(P.SIGN_DARK).prism(0, 0, [[2.16, 1.05, 0.045], [2.46, 1.05, 0.045]]);
  for (const s of [1, -1]) {
    const z = s * 0.028;
    m.col(P.SIGN_FACE);
    decal(m, 0, 2.31, z, 0.62, 0.075, s);
    decal(m, -0.14, 2.31, z, 0.60, 0.045, s);
    if (s > 0) m.tri([0.24, 2.245, z], [0.44, 2.31, z], [0.24, 2.375, z]);
    else m.tri([0.24, 2.245, z], [0.24, 2.375, z], [0.44, 2.31, z]);
  }
  borderBoth(m, 0, 2.31, 0.026, 0.99, 0.24, 0.02);
  bracket(m, 2.02, 0.13, 0.14, 0.11);
}

/**
 * Parking sign. 207 of these — the most common sign in the city — and the
 * legend was a single face at +z, so from every other angle it was a blank blue
 * lozenge. Border, a blocky P and the rider bar are mirrored onto both faces.
 */
function gSignParking(m) {
  pole(m, 2.58);
  m.col(P.SIGN_BLUE).prism(0, 0, [[1.96, 0.44, 0.042], [2.58, 0.44, 0.042]]);
  for (const s of [1, -1]) {
    const z = s * 0.026;
    m.col(P.SIGN_FACE);
    decal(m, -0.055, 2.34, z, 0.085, 0.30, s);          // stem of the P
    decal(m, 0.045, 2.42, z, 0.115, 0.135, s);          // bowl of the P
    decal(m, 0, 2.07, z, 0.28, 0.055, s);               // rider bar
  }
  borderBoth(m, 0, 2.27, 0.024, 0.38, 0.56, 0.022);
  bracket(m, 1.84, 0.13, 0.12, 0.11);
}

/**
 * Street-name blades. Border stripe, two lines of blocky lettering on both
 * faces, chamfered blade edges and a cast cross-bracket with a finial.
 */
function gSignStreet(m) {
  pole(m, 2.62, 0.05);
  const blade = (len, ang) => {
    m.xform(ang, 0, 0, 0);
    m.col(P.SIGN_GREEN);
    m.prism(0, 0, [[2.62, len, 0.035], [2.655, len, 0.055], [2.845, len, 0.055], [2.88, len, 0.035]]);
    for (const s of [1, -1]) {
      const z = s * 0.032;
      m.col(P.SIGN_FACE);
      decal(m, -len * 0.10, 2.79, z, len * 0.56, 0.06, s);
      decal(m, -len * 0.24, 2.70, z, len * 0.26, 0.045, s);
      decal(m, 0, 2.868, z * 0.6, len * 0.90, 0.014, s);
      decal(m, 0, 2.632, z * 0.6, len * 0.90, 0.014, s);
    }
    m.reset();
  };
  blade(1.34, 0);
  blade(1.06, Math.PI / 2);
  m.col(P.BENCH_METAL);
  m.tube(0, 0, [[2.56, 0.085], [2.62, 0.075], [2.90, 0.070], [2.96, 0.055]], 6);
  m.tube(0, 0, [[2.96, 0.070], [3.02, 0.075], [3.08, 0.030]], 6, { capTop: true });
}

/**
 * Chalk A-board. A 6 cm timber frame around a slate panel, a piano hinge along
 * the apex, a restraining chain and feet — and chalk, blocked in as irregular
 * pale bars so it reads as something WRITTEN from three metres.
 */
function gSandwichBoard(m) {
  for (const s of [-1, 1]) {
    const zTop = s * 0.045, zBot = s * 0.22;
    m.col(0x2b2822);
    m.board(0, 0.70, 0.06, zBot, 0.92, zTop, 0.045);
    // Frame: four rails around the slate.
    m.col(P.WOOD_LIGHT);
    m.board(0, 0.76, 0.06, zBot, 0.11, zBot + s * 0.008, 0.05);
    m.board(0, 0.76, 0.87, zTop + s * 0.008, 0.92, zTop, 0.05);
    for (const sx of [-1, 1]) {
      m.board(sx * 0.355, 0.05, 0.06, zBot, 0.92, zTop, 0.05);
    }
    // Chalk: irregular bars plus an underline, set at a slight angle.
    m.col(0xe8e4d6);
    rake(m, -0.02, 0.42, 0.74, zBot * 0.86, 0.80, zTop * 1.06, s * 0.006);
    rake(m, 0.06, 0.30, 0.62, zBot * 0.92, 0.66, zBot * 0.80, s * 0.006);
    rake(m, -0.05, 0.36, 0.46, zBot * 0.98, 0.50, zBot * 0.90, s * 0.006);
    m.col(s > 0 ? P.NEON_AQUA : P.FABRIC_SUN);
    rake(m, 0.02, 0.24, 0.33, zBot, 0.355, zBot * 0.96, s * 0.006);
  }
  m.col(P.STEEL_DARK);
  m.tubeBetween(-0.36, 0.935, 0, 0.36, 0.935, 0, 0.028, 5);
  m.tubeBetween(-0.30, 0.44, -0.16, -0.30, 0.40, 0.16, 0.012, 3);
  m.tubeBetween(0.30, 0.44, -0.16, 0.30, 0.40, 0.16, 0.012, 3);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) m.prism(sx * 0.355, sz * 0.235, [[0, 0.09, 0.09], [0.055, 0.07, 0.07]]);
  }
}

/**
 * Valet lectern. Raked top with a timber lip, a key-hook board of eight hooks
 * on the front panel, a lower shelf of ticket books, a brass kick rail and a
 * real sign — dark board, lit accent bar, white plate block — instead of a
 * blank magenta face with one white pill on it.
 */
function gValetStand(m) {
  m.col(P.SIGN_DARK);
  m.oct(0, 0, [[0, 0.66, 0.52, 0.03], [0.07, 0.58, 0.44, 0.03],
    [0.92, 0.58, 0.44, 0.03]], { capTop: false });
  m.col(P.TEAK).board(0, 0.66, 0.94, -0.20, 1.06, 0.20, 0.06);
  m.col(P.WOOD_DARK).beam(-0.33, 1.00, 0.21, 0.33, 1.00, 0.21, 0.05, 0.05, false);
  m.col(P.CHROME).tubeBetween(-0.26, 0.10, 0.235, 0.26, 0.10, 0.235, 0.022, 5);
  // Key hooks in a 2x4 grid on the front panel, with fobs on half of them.
  m.col(P.ALUMINIUM).prism(0, 0.225, [[0.44, 0.46, 0.02], [0.78, 0.46, 0.02]]);
  m.col(P.CHROME);
  for (let k = 0; k < 8; k++) {
    const x = -0.165 + (k % 4) * 0.11, y = 0.70 - Math.floor(k / 4) * 0.16;
    m.tubeBetween(x, y, 0.235, x, y - 0.035, 0.265, 0.012, 3);
    if (k % 3 === 0) { m.col(P.ACCENT_SUN); decal(m, x, y - 0.09, 0.268, 0.045, 0.075); m.col(P.CHROME); }
  }
  // Open shelf under the top with two ticket books.
  m.col(0x1b1f26).prism(0, 0, [[0.86, 0.50, 0.36], [0.90, 0.50, 0.36]]);
  m.col(P.SIGN_FACE).prism(-0.10, 0.02, [[0.90, 0.17, 0.13], [0.94, 0.17, 0.13]]);
  // The sign head.
  m.col(P.SIGN_DARK).prism(0, 0.24, [[1.06, 0.56, 0.05], [1.46, 0.56, 0.05]]);
  m.lit(P.ACCENT_HOT, 1, 0.9);
  decal(m, 0, 1.12, 0.268, 0.46, 0.05);
  decal(m, 0, 1.12, 0.268, 0.46, 0.05, -1);
  m.col(P.SIGN_FACE);
  decal(m, 0, 1.27, 0.268, 0.38, 0.13);
  decal(m, 0, 1.27, 0.268, 0.38, 0.13, -1);
}

/**
 * Queue post. Weighted cast base with a chamfered skirt and a slight dish, a
 * rope eye under the collar (the one detail that says "queue" rather than
 * "bollard"), a polished/brushed value split and a domed cap.
 */
function gStanchion(m) {
  m.col(P.STEEL_DARK);
  m.tube(0, 0, [[0, 0.185], [0.028, 0.180], [0.055, 0.135], [0.075, 0.062]], 6, { capTop: false });
  m.col(P.CHROME).tube(0, 0, [[0.075, 0.052], [0.80, 0.049]], 6);
  m.col(P.ACCENT_SUN).tube(0, 0, [[0.80, 0.058], [0.845, 0.058]], 6);
  m.col(P.ALUMINIUM).tube(0, 0, [[0.845, 0.052], [0.905, 0.072], [0.935, 0.068]], 6);
  // Rope eye.
  m.col(P.CHROME);
  m.tubeBetween(0, 0.905, 0.055, 0, 0.945, 0.085, 0.016, 3);
  m.tubeBetween(0, 0.945, 0.085, 0, 0.905, 0.105, 0.016, 3);
  m.tube(0, 0, [[0.935, 0.070], [0.99, 0.062], [1.02, 0.028]], 6, { capTop: true });
}

/* -- kerbside machines ---------------------------------------------------- */

/**
 * Collection mailbox. The barrel-top hood is a real 10-sided half-cylinder
 * lying along x — a 6-segment tube flattened to a slab from the game camera,
 * which is why the old one read as a blue crate — and the box stands on ONE
 * pedestal leg with a 25 cm gap under it, because that gap is half the
 * silhouette of the object.
 */
function gMailbox(m) {
  m.col(0x2b2f33);
  m.prism(0, 0, [[0, 0.40, 0.36], [0.045, 0.34, 0.30], [0.29, 0.28, 0.24]]);
  m.col(0xf4f4f4);
  m.oct(0, 0, [[0.29, 0.68, 0.50, 0.035], [0.34, 0.72, 0.54, 0.035],
    [0.92, 0.72, 0.54, 0.035]], { capTop: false, cols: [0xdcdcdc, 0xf4f4f4] });
  m.tubeBetween(-0.36, 0.92, 0, 0.36, 0.92, 0, 0.272, 10, true);
  // Pull-down door: recessed reveal, chunky handle, and the slot under the lip.
  m.col(0xe0e0e0).prism(0, 0.245, [[0.42, 0.58, 0.03], [0.88, 0.58, 0.03]]);
  m.col(0xd0d0d0);
  borderBoth(m, 0, 0.65, 0.262, 0.60, 0.48, 0.02);
  m.col(0x2b2f33);
  m.tubeBetween(-0.20, 0.60, 0.275, 0.20, 0.60, 0.275, 0.030, 5, true);
  m.col(0x15181b);
  decal(m, 0, 1.02, 0.245, 0.44, 0.045);
  m.col(0xe8e8e8).prism(0, 0.255, [[1.05, 0.50, 0.05], [1.08, 0.50, 0.05]]);
  // Flank decal and the collection-times plate.
  m.col(P.HYDRANT_RED); decal(m, -0.10, 0.78, 0.263, 0.16, 0.12);
  m.col(P.SIGN_BLUE); decal(m, 0.10, 0.78, 0.263, 0.16, 0.12);
  m.col(0xf4f4f4).prism(0.36, 0.10, [[0.60, 0.02, 0.20], [0.80, 0.02, 0.20]]);
}

/**
 * Parking meter. Canted head with a recessed screen behind a chrome bezel, a
 * keypad, a coin slot and a card-reader lip, a hipped cap with an aerial nub,
 * and an anchor plate with four bolts at the base.
 *
 * The lit aqua strip was the only feature on the old one and it is invisible at
 * noon, which is when the player sees it. Everything added here reads in
 * daylight; the strip is still there for the night pass.
 */
function gParkingMeter(m) {
  m.col(P.STEEL_DARK);
  m.prism(0, 0, [[0, 0.30, 0.28], [0.035, 0.27, 0.25]]);
  m.col(0x8f9694);
  for (let k = 0; k < 4; k++) {
    decal(m, (k % 2 ? 1 : -1) * 0.10, 0.0355, 0, 0.05, 0.05);
  }
  m.col(P.PARKING_METER);
  m.tube(0, 0, [[0.035, 0.13], [0.96, 0.076]], 5);
  m.col(P.ALUMINIUM).tube(0, 0, [[0.96, 0.098], [1.02, 0.092]], 5);
  m.col(0x717f7e);
  m.prism(0, 0, [[1.02, 0.30, 0.24], [1.07, 0.33, 0.26], [1.40, 0.33, 0.24], [1.45, 0.29, 0.20]]);
  m.col(P.ALUMINIUM).prism(0, -0.01, [[1.45, 0.30, 0.21], [1.49, 0.24, 0.16]]);
  m.col(P.STEEL_DARK).tubeBetween(0.07, 1.49, -0.02, 0.07, 1.60, -0.02, 0.012, 3);
  // Front face: screen in a bezel, keypad, coin slot, card lip.
  m.col(P.ALUMINIUM); borderBoth(m, 0, 1.31, 0.132, 0.24, 0.16, 0.018);
  m.lit(P.NEON_AQUA, 1, 0.9); decal(m, 0, 1.31, 0.134, 0.20, 0.12);
  m.col(0x2c3234);
  for (let r = 0; r < 3; r++) decal(m, 0, 1.19 - r * 0.045, 0.132, 0.19, 0.03);
  m.col(0x15181b); decal(m, 0.07, 1.10, 0.132, 0.03, 0.055);
  m.col(P.ALUMINIUM).prism(-0.06, 0.128, [[1.08, 0.11, 0.02], [1.12, 0.11, 0.02]]);
  m.col(P.ACCENT_SUN); decal(m, 0, 1.05, 0.132, 0.26, 0.028);
}

/**
 * Newspaper honour box. Two thin legs with a 20 cm gap under the body, a sloped
 * lid with a lift handle, a hinged door in a recessed reveal, a glazed window
 * with a masthead behind it, a coin housing with a slot and a knob, and a pull
 * bar. The old one was a plain box on a dark truncated pyramid — a wheelie bin.
 */
function gNewsBox(m) {
  m.col(P.STEEL_DARK);
  for (const s of [-1, 1]) {
    m.prism(s * 0.17, 0, [[0, 0.14, 0.16], [0.03, 0.10, 0.12], [0.22, 0.08, 0.10]]);
  }
  m.col(0xf0f0f0);
  m.oct(0, 0, [[0.22, 0.48, 0.42, 0.025], [0.26, 0.50, 0.44, 0.025],
    [1.00, 0.50, 0.44, 0.025]], { capTop: false });
  m.col(0xe4e4e4).board(0, 0.50, 1.00, -0.22, 1.10, 0.22, 0.05);
  m.col(P.STEEL_DARK).tubeBetween(-0.12, 1.09, 0.10, 0.12, 1.09, 0.10, 0.022, 4);
  // Door: recessed reveal, glazed window with a masthead, coin box, pull bar.
  m.col(0xdadada).prism(0, 0.215, [[0.28, 0.40, 0.02], [0.96, 0.40, 0.02]]);
  m.col(0x1b1f22).prism(0, 0.228, [[0.56, 0.36, 0.012], [0.94, 0.36, 0.012]]);
  m.col(P.SIGN_FACE); decal(m, 0, 0.76, 0.236, 0.33, 0.34);
  m.col(P.SIGN_DARK); decal(m, 0, 0.885, 0.238, 0.33, 0.075);
  m.col(P.HYDRANT_RED); decal(m, 0, 0.815, 0.238, 0.33, 0.045);
  m.col(0x9aa0a0);
  for (let k = 0; k < 4; k++) decal(m, 0, 0.74 - k * 0.055, 0.238, 0.28, 0.028);
  m.col(P.STEEL_DARK);
  m.prism(0.19, 0.24, [[0.60, 0.10, 0.06], [0.80, 0.10, 0.06]]);
  m.tubeBetween(0.19, 0.83, 0.26, 0.19, 0.83, 0.30, 0.028, 4, true);
  m.col(0x15181b); decal(m, 0.19, 0.72, 0.272, 0.055, 0.014);
  m.col(P.ALUMINIUM).tubeBetween(-0.16, 0.42, 0.245, 0.10, 0.42, 0.245, 0.020, 4);
}

/**
 * Utility cabinet. Two doors with a centre seam, hinge knuckles down each outer
 * edge, a padlock hasp, a louvre stack low on one flank, a top that overhangs
 * as a drip cap and falls to the back, and a cable-duct fillet at the plinth.
 *
 * All 122 were the same near-white, so a street of them was one object stamped
 * repeatedly; the body is authored near-white and the tint array now carries
 * grey-green, olive, beige and dark grey.
 */
function gUtilityBox(m) {
  m.col(0xa8a498).prism(0, 0, [[0, 0.94, 0.58], [0.06, 0.90, 0.54], [0.11, 0.86, 0.50]]);
  m.col(0xf2f2f2);
  m.oct(0, 0, [[0.11, 0.84, 0.48, 0.03], [0.16, 0.86, 0.50, 0.03],
    [1.22, 0.86, 0.50, 0.03]], { capTop: false });
  // Drip cap: overhangs 4 cm and falls 3 degrees to the back.
  m.col(0xdedede).board(0, 0.94, 1.28, -0.29, 1.24, 0.29, 0.05);
  m.col(0xe8e8e8).prism(0, 0, [[1.22, 0.90, 0.54], [1.25, 0.90, 0.54]]);
  m.col(0x8f9694);
  decal(m, 0, 0.68, 0.252, 0.014, 0.98);                 // centre seam
  for (const sx of [-1, 1]) {
    for (const y of [0.30, 0.68, 1.06]) decal(m, sx * 0.40, y, 0.252, 0.035, 0.10);
  }
  m.col(0x4a5250);
  decal(m, 0, 0.72, 0.254, 0.09, 0.16);                  // hasp
  m.col(0x2c3234);
  for (let k = 0; k < 4; k++) decal(m, -0.30, 0.28 + k * 0.055, 0.252, 0.34, 0.024);
  m.col(P.ACCENT_SUN); decal(m, 0.30, 1.10, 0.252, 0.14, 0.10);
  m.col(P.NEON_AQUA); decal(m, 0.26, 0.42, 0.252, 0.12, 0.16);
}

/**
 * ATM kiosk. The player looks DOWN on this, so the privacy hood cantilevered
 * 18 cm over the screen is what gives it a silhouette; the rest is the front a
 * cash machine actually has — recessed fascia, screen behind a bezel, keypad,
 * card and receipt slots, a cash tray — plus lit logo panels on both flanks so
 * the back and sides are not blank slabs. Only 15 of them; spend it.
 */
function gAtmKiosk(m) {
  m.col(P.CONCRETE_DARK).prism(0, 0, [[0, 1.14, 0.90], [0.10, 1.06, 0.82]]);
  m.col(0xf0ece2);
  m.oct(0, 0, [[0.10, 1.00, 0.76, 0.06], [0.16, 1.04, 0.80, 0.06],
    [1.96, 1.04, 0.80, 0.06], [2.06, 0.98, 0.74, 0.05]], { capTop: false });
  m.col(0xe4dfd2).tube(0, 0, [[2.06, 0.50, 0.38], [2.14, 0.44, 0.33], [2.18, 0.30, 0.22]], 8,
    { capTop: true });
  // Recessed fascia with the working parts in it.
  m.col(0x6e6a60).prism(0, 0.365, [[0.72, 0.80, 0.045], [1.86, 0.80, 0.045]]);
  m.col(P.SIGN_DARK).prism(0, 0.375, [[1.30, 0.66, 0.03], [1.72, 0.66, 0.03]]);
  m.lit(P.NEON_BLUE, 1, 0.95); decal(m, 0, 1.51, 0.392, 0.58, 0.36);
  m.col(P.ALUMINIUM); borderBoth(m, 0, 1.51, 0.394, 0.62, 0.40, 0.025);
  m.col(0x3a4046).prism(0, 0.378, [[1.02, 0.42, 0.05], [1.22, 0.42, 0.05]]);
  m.col(0xb8bcb8);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) decal(m, -0.135 + c * 0.09, 1.06 + r * 0.055, 0.404, 0.055, 0.032);
  }
  m.col(0x15181b);
  decal(m, 0.28, 1.20, 0.392, 0.13, 0.022);              // card slot
  decal(m, -0.28, 1.20, 0.392, 0.16, 0.018);             // receipt slot
  m.col(P.STEEL_DARK).prism(0, 0.38, [[0.80, 0.40, 0.06], [0.90, 0.40, 0.06]]);
  m.col(0x15181b); decal(m, 0, 0.87, 0.412, 0.34, 0.05);
  // Privacy hood: the one part that reads from directly above.
  m.col(0xe0dbcd);
  m.prism(0, 0.44, [[1.86, 0.88, 0.22], [1.94, 0.86, 0.20]]);
  m.board(0, 0.88, 1.86, 0.38, 1.80, 0.55, 0.05);
  // Lit bank panels on the two flanks, so no face of this thing is blank.
  for (const s of [-1, 1]) {
    m.lit(P.NEON_BLUE, 1, 0.7).prism(s * 0.53, 0, [[1.30, 0.02, 0.44], [1.62, 0.02, 0.44]]);
    m.col(P.ACCENT_SUN).prism(s * 0.535, 0, [[1.24, 0.015, 0.30], [1.28, 0.015, 0.30]]);
  }
}

/**
 * Digital street kiosk. Pill section rather than a slab, aluminium bezels round
 * both screens, a two-band advert instead of one flat colour, a charging shelf
 * with USB dots, a speaker grille and a chamfered aluminium crown with a solar
 * plate — the side faces were blank on the old one.
 */
function gPhoneKiosk(m) {
  m.col(P.STEEL_DARK).prism(0, 0, [[0, 0.76, 0.48], [0.10, 0.68, 0.40]]);
  m.col(0x30363a);
  m.oct(0, 0, [[0.10, 0.62, 0.34, 0.14], [0.16, 0.64, 0.36, 0.15],
    [2.24, 0.64, 0.36, 0.15]], { capTop: false });
  for (const [s, hex] of [[1, P.NEON_AQUA], [-1, P.NEON_PINK]]) {
    m.col(P.ALUMINIUM).prism(0, s * 0.175, [[0.86, 0.56, 0.02], [1.98, 0.56, 0.02]]);
    m.lit(hex, 1, 0.85); decal(m, 0, 1.56, s * 0.19, 0.50, 0.76, s);
    m.lit(P.SIGN_FACE, 1, 0.6); decal(m, 0, 1.02, s * 0.19, 0.50, 0.24, s);
  }
  // Charging shelf, a phone resting on it, and a speaker grille.
  m.col(P.ALUMINIUM).prism(0, 0.24, [[0.92, 0.34, 0.14], [0.96, 0.34, 0.14]]);
  m.col(0x15181b);
  for (let k = 0; k < 4; k++) decal(m, -0.09 + k * 0.06, 0.90, 0.192, 0.028, 0.016);
  m.col(0x22262a).prism(0.10, 0.25, [[0.96, 0.09, 0.10], [0.975, 0.09, 0.10]]);
  m.col(0x3a4046);
  for (let k = 0; k < 5; k++) decal(m, 0, 0.72 - k * 0.028, 0.192, 0.30, 0.014);
  m.col(P.ALUMINIUM);
  m.oct(0, 0, [[2.24, 0.68, 0.40, 0.14], [2.32, 0.70, 0.42, 0.15],
    [2.40, 0.62, 0.34, 0.12]], { capTop: true });
  m.col(0x2a3a4a).plate(0, 2.405, 0, 0.44, 0.24);
}

/**
 * Drinking fountain. The parts that make it identifiable as one and not a
 * bollard with a pebble on it: a real dished BOWL with a drain, a bubbler that
 * ARCS out of a stem, a push button on the front, a second ADA bowl at 0.62,
 * and a bottle filler with a lit panel on the back.
 */
function gDrinkFountain(m) {
  m.col(P.PRECAST);
  m.oct(0, 0, [[0, 0.48, 0.42, 0.04], [0.07, 0.42, 0.36, 0.035],
    [0.86, 0.38, 0.32, 0.03], [0.92, 0.44, 0.38, 0.035]], { capTop: false });
  // The main bowl: dished, capped, with a dark drain disc in it.
  m.col(P.ALUMINIUM);
  m.tube(0, 0.02, [[0.92, 0.235, 0.215], [0.95, 0.26, 0.235], [0.99, 0.255, 0.23]], 6,
    { capTop: true });
  m.col(0x9aa0a0).tube(0, 0.02, [[0.93, 0.20, 0.18], [0.955, 0.18, 0.16]], 6, { capTop: true });
  m.col(0x2c3234).disc(0, 0.958, 0.02, 0.055, 5);
  // Bubbler: vertical stem plus a 45-degree nozzle. Not a straight stub.
  m.col(P.CHROME);
  m.tubeBetween(0, 0.96, -0.12, 0, 1.09, -0.12, 0.028, 5);
  m.tubeBetween(0, 1.09, -0.12, 0, 1.04, -0.02, 0.024, 5, true);
  m.tubeBetween(0, 1.00, 0.22, 0, 1.00, 0.26, 0.032, 5, true);   // push button
  // Lower ADA bowl on one side.
  m.col(P.ALUMINIUM);
  m.tube(-0.28, 0.02, [[0.60, 0.155, 0.14], [0.63, 0.17, 0.155], [0.66, 0.165, 0.15]], 6,
    { capTop: true });
  m.col(0x2c3234).disc(-0.28, 0.645, 0.02, 0.04, 5);
  m.col(P.CHROME).tubeBetween(-0.28, 0.66, -0.10, -0.28, 0.74, -0.06, 0.02, 4, true);
  // Bottle filler on the back face.
  m.col(P.STEEL_DARK).prism(0, -0.19, [[1.00, 0.24, 0.10], [1.22, 0.24, 0.10]]);
  m.lit(P.NEON_BLUE, 1, 0.8); decal(m, 0, 1.14, -0.245, 0.14, 0.06, -1);
  // A damp stain on the paving under the bowl.
  m.col(P.SIDEWALK, 0.88).disc(0, 0.008, 0.06, 0.52, 6);
}

/**
 * Dog waste station. A bag dispenser with a visible slot and a bag tail hanging
 * out of it, a hooded bin with a swing flap and a latched lid line below it, a
 * bracket where the boxes clamp to the post, and a white dog pictogram on the
 * blade. Three flat green boxes on a stick said none of that.
 */
function gDogStation(m) {
  pole(m, 1.62, 0.045, P.SIGN_POLE);
  m.col(P.STEEL_DARK);
  for (const y of [0.62, 1.08]) m.prism(0, -0.02, [[y, 0.10, 0.13], [y + 0.05, 0.10, 0.13]]);
  // Bin with a hooded opening and a swing flap.
  m.col(P.BIN_GREEN);
  m.oct(0, 0.08, [[0.30, 0.32, 0.24, 0.025], [0.34, 0.34, 0.26, 0.025],
    [0.86, 0.34, 0.26, 0.025]], { capTop: false });
  m.col(0x2f7d55).board(0, 0.34, 0.86, -0.05, 0.94, 0.21, 0.045);
  m.col(0x15201a); decal(m, 0, 0.80, 0.212, 0.22, 0.10);
  m.col(0x2f7d55); decal(m, 0, 0.62, 0.212, 0.28, 0.012);   // latch line
  m.col(P.ALUMINIUM); decal(m, 0.11, 0.66, 0.213, 0.05, 0.035);
  // Dispenser with a slot and a bag tail.
  m.col(P.BIN_GREEN).prism(0, 0.08, [[1.02, 0.30, 0.22], [1.30, 0.30, 0.22]]);
  m.col(0x15201a); decal(m, 0, 1.08, 0.192, 0.20, 0.028);
  m.col(0xe8e8e8).board(0, 0.10, 1.07, 0.19, 0.96, 0.23, 0.014);
  m.col(P.SIGN_GREEN).prism(0, 0, [[1.44, 0.42, 0.032], [1.78, 0.42, 0.032]]);
  m.col(P.SIGN_FACE);
  for (const s of [1, -1]) {
    decal(m, -0.02, 1.60, s * 0.019, 0.16, 0.075, s);      // dog body
    decal(m, 0.08, 1.66, s * 0.019, 0.05, 0.06, s);        // head
    decal(m, -0.09, 1.68, s * 0.019, 0.035, 0.05, s);      // tail
  }
}

/* -- planting ------------------------------------------------------------- */

/**
 * Clipped shrub — now a MASS, not a gem.
 *
 * Every planter in the module shipped one 5-segment cone, and five facets read
 * as a low-poly crystal from any distance. Two overlapping lobes at different
 * heights cost thirteen more triangles and give a lumpy silhouette, which is
 * the whole difference between foliage and glass.
 */
function shrub(m, x, y, z, r, hex, segs = 6, lobes = 2) {
  bush(m, x, y, z, r, hex, hex === P.HEDGE ? P.HEDGE_LIGHT : P.HEDGE, segs, lobes);
}

/**
 * Round planter. Eight segments with a proud rolled rim and a foot ring, a
 * two-tone body (lighter at the rim, warmer at the base), a slightly domed
 * mulch bed dropped below the rim, and a real foliage mass on top.
 */
function gPlanterRound(m) {
  m.tube(0, 0, [
    [0, 0.50], [0.055, 0.535], [0.09, 0.475], [0.56, 0.560], [0.62, 0.605], [0.665, 0.575],
  ], 8, { cols: [0xb8ac94, 0xc8bda4, 0xf0e6d0, 0xfaf2e0, 0xe4d8be] });
  m.col(P.MULCH).disc(0, 0.585, 0, 0.50, 8);
  m.col(0x5c4534).disc(0, 0.60, 0.06, 0.24, 5);
  shrub(m, 0, 0.575, 0, 0.44, P.HEDGE, 5, 2);
}

/**
 * Square precast planter. Battered body, a 6 cm coping rim that overhangs on
 * all four sides, a recessed reveal band under it, a chamfered plinth and two
 * score lines per face.
 *
 * 453 copies of one flat tan box was the most literal "untextured box" in the
 * slice. Everything here is profile relief rather than a texture, which is what
 * the art bible asks for and what survives minification at 40 m.
 */
function gPlanterSquare(m) {
  m.prism(0, 0, [
    [0, 1.06, 1.06], [0.07, 0.98, 0.98], [0.46, 0.94, 0.94],
    [0.54, 0.905, 0.905], [0.60, 0.95, 0.95], [0.655, 1.08, 1.08], [0.72, 1.055, 1.055],
  ], {
    capTop: false,
    cols: [0xb4a890, 0xf2eadA, 0xe8dfcc, 0xf6efe0, 0xfaf4e6, 0xe8dfcc],
  });
  // Score lines: two per face, on all four faces.
  m.col(0xd8ceb8);
  for (let f = 0; f < 4; f++) {
    m.xform((f / 4) * TAU, 0, 0, 0);
    for (const x of [-0.22, 0.22]) decal(m, x, 0.30, 0.475, 0.018, 0.44);
    m.reset();
  }
  m.col(P.MULCH).plate(0, 0.60, 0, 0.90, 0.90);
  shrub(m, 0, 0.56, 0, 0.44, P.HEDGE_LIGHT, 5, 2);
}

/**
 * Long trough. Coping rim, three rib pilasters along the front face — the thing
 * that makes a long planter read as a long planter and not a skip — a shadow
 * gap at the plinth, a clipped hedge that fills it end to end and bloom clumps
 * sitting ON the foliage rather than instead of it.
 */
function gPlanterTrough(m) {
  m.prism(0, 0, [
    [0, 1.86, 0.62], [0.05, 1.78, 0.54], [0.46, 1.74, 0.50],
    [0.52, 1.86, 0.62], [0.58, 1.83, 0.59],
  ], { capTop: false, cols: [0xb4a890, 0xf2ead8, 0xf8f2e4, 0xe8dfcc] });
  m.col(0xe4dbc6);
  for (const x of [-0.58, 0, 0.58]) {
    m.prism(x, 0.02, [[0.06, 0.16, 0.56], [0.50, 0.16, 0.56]]);
  }
  m.col(P.MULCH).plate(0, 0.50, 0, 1.72, 0.48);
  // One continuous clipped mass with a ridged top, not two isolated domes.
  m.col(P.HEDGE);
  m.prism(0, 0, [[0.46, 1.62, 0.44], [0.78, 1.70, 0.50], [0.92, 1.44, 0.26]],
    { cols: [P.HEDGE, P.HEDGE_LIGHT] });
  m.col(P.HEDGE_LIGHT);
  m.prism(-0.42, 0.04, [[0.66, 0.62, 0.36], [0.86, 0.56, 0.30], [0.97, 0.34, 0.16]]);
  const blooms = [[-0.62, 0.90, P.FLOWER_PINK], [-0.10, 0.99, P.FLOWER_WHITE],
    [0.38, 0.93, P.FLOWER_PINK], [0.72, 0.88, P.FLOWER_MAGENTA]];
  for (const [x, y, hex] of blooms) {
    m.col(hex);
    for (let k = 0; k < 3; k++) {
      const a = k * 2.1;
      m.disc(x + Math.cos(a) * 0.06, y + k * 0.015, 0.04 + Math.sin(a) * 0.06, 0.085, 5);
    }
  }
}

/**
 * Potted palm. The pot gets a rolled rim bead and a foot ring, the trunk tapers
 * and leans with frond-scar rings, and each frond is a spine with leaflets
 * angled off it instead of one flat beam — a crown of five flat beams reads as
 * a five-pointed star from directly above, which is where the camera is.
 */
function gPottedPalm(m) {
  m.tube(0, 0, [
    [0, 0.30], [0.055, 0.325], [0.09, 0.288], [0.62, 0.378], [0.68, 0.415], [0.72, 0.395],
  ], 6, { cols: [0x9a5a3a, 0xb4643e, P.TERRACOTTA, 0xdc8054, 0xc06a44] });
  m.col(P.MULCH).disc(0, 0.645, 0, 0.36, 6);
  // Leaning tapered trunk with two scar rings.
  m.col(P.PALM_TRUNK);
  m.tube(0, 0, [[0.62, 0.098], [0.86, 0.090]], 5);
  m.col(P.PALM_TRUNK_DARK).tube(0.012, 0, [[0.86, 0.094], [0.90, 0.092]], 5);
  m.col(P.PALM_TRUNK).tube(0.03, 0.01, [[0.90, 0.086], [1.24, 0.076]], 5);
  m.col(P.PALM_TRUNK_DARK).tube(0.05, 0.015, [[1.24, 0.080], [1.28, 0.078]], 5);
  m.col(P.PALM_TRUNK).tube(0.07, 0.02, [[1.28, 0.072], [1.58, 0.062]], 5);
  m.col(P.PALM_FROND_DARK).tube(0.08, 0.02, [[1.56, 0.15], [1.82, 0.075]], 5, { capTop: true });
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * TAU + 0.55;
    const cx = Math.cos(a), cz = Math.sin(a);
    const L = k % 2 ? 0.86 : 0.66;
    m.col(k % 2 ? P.PALM_FROND : P.PALM_FROND_DARK);
    // Spine, then two leaflet blades angled off it.
    m.beam(0.08, 1.80, 0.02, 0.08 + cx * L, 1.28, 0.02 + cz * L, 0.075, 0.045, false);
    m.col(k % 2 ? P.PALM_FROND_LIGHT : P.PALM_FROND);
    for (const s of [-1, 1]) {
      m.beam(0.08 + cx * L * 0.28, 1.66, 0.02 + cz * L * 0.28,
        0.08 + cx * L * 0.82 - cz * s * 0.20, 1.34, 0.02 + cz * L * 0.82 + cx * s * 0.20,
        0.20, 0.026, false);
    }
  }
}

/* -- café terrace --------------------------------------------------------- */

/**
 * Café table: 10-sided top with a chamfered edge band, a slim column with a
 * collar, and a cast base on three splayed feet.
 *
 * Its top did not render at all — 188 headless posts across the city — because
 * `M.tube`'s capTop fan was wound the wrong way. That is fixed at source; this
 * is the table it should have been under it.
 */
function gCafeTable(m) {
  m.col(P.STEEL_DARK);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * TAU + 0.4;
    m.tubeBetween(0, 0.055, 0, Math.cos(a) * 0.28, 0.022, Math.sin(a) * 0.28, 0.045, 4, true);
  }
  m.tube(0, 0, [[0, 0.115], [0.055, 0.105], [0.075, 0.052]], 6, { capTop: false });
  m.tube(0, 0, [[0.075, 0.048], [0.62, 0.044]], 6);
  m.tube(0, 0, [[0.62, 0.085], [0.68, 0.078]], 6);
  m.col(0xe8e0cc).tube(0, 0, [[0.68, 0.335], [0.71, 0.352]], 10);
  m.col(0xfaf6ec).tube(0, 0, [[0.71, 0.352], [0.755, 0.345]], 10, { capTop: true });
}

/**
 * Café chair. Four real legs splayed 8 degrees with a stretcher between the
 * front pair, a dished seat pan with a chamfered rim, and a back of three
 * horizontal slats carried on uprights that continue from the rear legs.
 *
 * 569 copies, and the old one was five razor-edged flat slabs with two solid
 * side panels standing in for legs — the "cardboard furniture" the art bible
 * bans by name. The open back is also what stops a terrace massing into a wall.
 */
function gCafeChair(m) {
  m.col(0xe6e0d0);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    m.tubeBetween(sx * 0.22, 0, sz * 0.22, sx * 0.185, 0.43, sz * 0.185, 0.024, 4);
  }
  m.tubeBetween(-0.20, 0.16, 0.20, 0.20, 0.16, 0.20, 0.018, 4);
  m.col(0xf6f2e8);
  m.prism(0, 0, [[0.42, 0.40, 0.38], [0.45, 0.44, 0.42], [0.48, 0.395, 0.375]]);
  m.col(0xe6e0d0);
  for (const sx of [-1, 1]) {
    m.tubeBetween(sx * 0.185, 0.43, -0.185, sx * 0.165, 0.90, -0.235, 0.024, 4);
  }
  m.col(0xf2ece0);
  for (let k = 0; k < 3; k++) {
    const t = k / 2;
    m.beam(-0.175, 0.58 + t * 0.145, -0.205 - t * 0.016,
      0.175, 0.58 + t * 0.145, -0.205 - t * 0.016, 0.075, 0.032, false);
  }
}

/**
 * Fabric canopy with SCALLOPED panels.
 *
 * A smooth cone reads as a mushroom cap, and from the game's overhead camera a
 * parasol IS its plan shape — so the hem alternates between two radii, which is
 * what turns a circle into a scallop, and each panel is drawn separately so the
 * beach-stripe alternation costs nothing.
 */
function canopyFabric(m, y0, y1, y2, rA, rB, segs = 8, hexA = null, hexB = null) {
  const rimR = (k) => ((k % 2) ? rB : rA);
  const pt = (k, r, y) => {
    const a = (k / segs) * TAU;
    return [Math.cos(a) * r, y, Math.sin(a) * r];
  };
  const rMid = (rA + rB) * 0.5 * 0.58;
  const apex = [0, y2, 0];
  for (let k = 0; k < segs; k++) {
    const j = (k + 1) % segs;
    if (hexA) m.col(k % 2 ? hexB : hexA);
    m.quad(pt(k, rimR(k), y0), pt(k, rMid, y1), pt(j, rMid, y1), pt(j, rimR(j), y0));
    m.tri(apex, pt(j, rMid, y1), pt(k, rMid, y1));
  }
  if (hexA) m.col(hexA);
  m.disc(0, y0 + 0.006, 0, (rA + rB) * 0.5, segs, 0, false);
}

/** Valance skirt hanging off a scalloped hem. */
function valance(m, y0, drop, rA, rB, segs = 8) {
  const rimR = (k) => ((k % 2) ? rB : rA);
  const pt = (k, r, y) => {
    const a = (k / segs) * TAU;
    return [Math.cos(a) * r, y, Math.sin(a) * r];
  };
  for (let k = 0; k < segs; k++) {
    const j = (k + 1) % segs;
    const d0 = drop * (k % 2 ? 0.72 : 1);
    const d1 = drop * (j % 2 ? 0.72 : 1);
    m.quad(pt(k, rimR(k), y0 - d0), pt(k, rimR(k), y0), pt(j, rimR(j), y0), pt(j, rimR(j), y0 - d1));
  }
}

/**
 * Patio umbrella. Scalloped canopy with every other panel a half-stop lighter
 * (the 3/4 camera sees this as one flat disc otherwise), a valance skirt, a
 * finial and vent cap, and — because the camera also sees the UNDERSIDE — a
 * runner hub with three visible rib struts under it.
 */
function gUmbrella(m) {
  m.col(P.STEEL_DARK);
  m.tube(0, 0, [[0, 0.34], [0.05, 0.30], [0.07, 0.05], [2.14, 0.045]], 6);
  canopyFabric(m, 2.14, 2.27, 2.50, 1.26, 1.17, 8, 0xffffff, 0xe8e8e8);
  m.col(0xf0f0f0);
  valance(m, 2.14, 0.16, 1.26, 1.17, 8);
  m.col(P.STEEL_DARK);
  m.tube(0, 0, [[2.06, 0.10], [2.12, 0.09]], 6);           // runner hub
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * TAU + 0.5;
    m.tubeBetween(Math.cos(a) * 0.09, 2.12, Math.sin(a) * 0.09,
      Math.cos(a) * 0.90, 2.21, Math.sin(a) * 0.90, 0.022, 3);
  }
  m.tube(0, 0, [[2.50, 0.09], [2.55, 0.075]], 5);          // vent cap
  m.tube(0, 0, [[2.55, 0.05], [2.62, 0.055], [2.68, 0.02]], 5, { capTop: true });
}

/**
 * Beach parasol. A Miami beach parasol is a STRIPED object and this one had no
 * stripes: the panels now alternate colour around the eight segments, the hem
 * is scalloped with a trim band, and the mast gets a joint collar, a ferrule
 * and a weighted base disc.
 */
function gBeachParasol(m) {
  m.col(P.WOOD_DARK);
  m.tube(0, 0, [[0, 0.30], [0.045, 0.26], [0.07, 0.062]], 6, { capTop: false });
  m.tube(0, 0, [[0.07, 0.058], [1.16, 0.055]], 6);
  m.col(P.CHROME).tube(0, 0, [[1.16, 0.072], [1.22, 0.068]], 6);
  m.col(P.WOOD_DARK).tube(0, 0, [[1.22, 0.055], [2.02, 0.050]], 6);
  canopyFabric(m, 2.02, 2.16, 2.46, 1.42, 1.31, 8, 0xffffff, 0xdcdcdc);
  m.col(0xe4e4e4);
  valance(m, 2.02, 0.10, 1.42, 1.31, 8);
  m.col(P.WOOD_DARK);
  m.tube(0, 0, [[2.46, 0.05], [2.54, 0.056], [2.60, 0.022]], 5, { capTop: true });
}

/**
 * Square market parasol on a timber mast, with a fabric valance.
 *
 * Round canopies are 203 of the 203 parasols in the city and from the game's
 * overhead camera a canopy IS its plan shape — so a terrace of them reads as a
 * tray of identical discs. A square one costs the same triangles and changes
 * the single most visible thing about the object. Fabric authored near-white so
 * the per-instance tint colours it, same as the round pair.
 */
/**
 * Square market parasol. The canopy is scored into four panels by a darker seam
 * running from the peak down each hip, the valance is scalloped into six
 * lappets a side with a contrasting trim, four rib tips poke past the corners
 * and there is a finial on the peak — without those it is a folded card.
 */
function gParasolSquare(m) {
  m.col(P.WOOD_DARK);
  m.tube(0, 0, [[0, 0.32], [0.05, 0.28], [0.07, 0.058], [1.30, 0.055]], 6);
  m.col(P.CHROME).tube(0, 0, [[1.30, 0.075], [1.38, 0.070]], 6);
  m.col(P.WOOD_DARK).tube(0, 0, [[1.38, 0.055], [2.16, 0.05]], 6);
  m.col(0xffffff);
  m.prism(0, 0, [[2.16, 2.24, 2.24], [2.28, 2.06, 2.06], [2.58, 0.16, 0.16]],
    { capTop: true, capBot: true });
  // Hip seams: four thin darker strips from the peak down to each corner.
  m.col(0xdedede);
  for (let k = 0; k < 4; k++) {
    m.xform((k / 4) * TAU + Math.PI / 4, 0, 0, 0);
    m.beam(0, 2.575, 0.10, 0, 2.19, 1.50, 0.035, 0.012, false);
    m.reset();
  }
  // Scalloped valance: six lappets per side, alternating depth, on a trim band.
  for (let side = 0; side < 4; side++) {
    m.xform((side / 4) * TAU, 0, 0, 0);
    m.col(side % 2 ? 0xf2f2f2 : 0xe8e8e8);
    for (let k = 0; k < 6; k++) {
      const x = -0.93 + k * 0.372;
      m.prism(x, 1.12, [[2.17 - (k % 2 ? 0.30 : 0.22), 0.34, 0.035], [2.17, 0.34, 0.035]]);
    }
    m.col(0xdcdcdc);
    m.prism(0, 1.13, [[2.13, 2.24, 0.028], [2.17, 2.24, 0.028]]);
    m.reset();
  }
  // Rib tips past the corners, a crank handle, a finial.
  m.col(P.WOOD_DARK);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * TAU + Math.PI / 4;
    m.tubeBetween(Math.cos(a) * 1.50, 2.18, Math.sin(a) * 1.50,
      Math.cos(a) * 1.62, 2.16, Math.sin(a) * 1.62, 0.022, 3, true);
  }
  m.col(P.STEEL_DARK);
  m.tubeBetween(0.055, 1.02, 0, 0.16, 1.02, 0, 0.022, 4, true);
  m.tube(0, 0, [[2.58, 0.06], [2.66, 0.068], [2.72, 0.026]], 5, { capTop: true });
}

/**
 * Patio heater. The old one read as a mushroom floor lamp: a 9 cm pancake for a
 * base that plainly could not hold a gas bottle, no burner cage, no controls.
 * This has the tall housing with a hinged door line and a foot ring, a control
 * knob on the post, a burner guard of six vertical bars over a glowing element
 * ring, and a reflector with a rolled rim and a vent cap.
 */
function gPatioHeater(m) {
  m.col(P.STEEL_DARK);
  m.tube(0, 0, [[0, 0.44], [0.05, 0.42], [0.10, 0.30]], 8, { capTop: false });
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * TAU + 0.5;
    m.prism(Math.cos(a) * 0.36, Math.sin(a) * 0.36, [[0, 0.14, 0.14], [0.045, 0.11, 0.11]]);
  }
  m.tube(0, 0, [[0.10, 0.28], [0.50, 0.24], [0.55, 0.20]], 8, { capTop: true });
  m.col(0x59615f);
  decal(m, 0, 0.30, 0.262, 0.30, 0.40);
  m.col(P.ALUMINIUM); decal(m, 0.11, 0.30, 0.264, 0.035, 0.06);
  m.col(P.CHROME);
  m.tube(0, 0, [[0.55, 0.115], [0.86, 0.108]], 6);
  m.tube(0, 0, [[0.86, 0.135], [0.92, 0.128]], 6);
  m.tubeBetween(0, 0.89, 0.12, 0, 0.89, 0.19, 0.038, 5, true);
  m.tube(0, 0, [[0.92, 0.105], [1.62, 0.100]], 6);
  m.col(P.ALUMINIUM).tube(0, 0, [[1.62, 0.16], [1.70, 0.26]], 8);
  m.lit(P.LAMP_GLOW, 1, 1.3).tube(0, 0, [[1.70, 0.24], [1.88, 0.245]], 8);
  m.col(P.STEEL_DARK);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * TAU;
    m.tubeBetween(Math.cos(a) * 0.275, 1.68, Math.sin(a) * 0.275,
      Math.cos(a) * 0.275, 1.90, Math.sin(a) * 0.275, 0.016, 3);
  }
  m.col(P.ALUMINIUM);
  m.tube(0, 0, [[1.68, 0.28], [1.72, 0.285]], 8);
  m.tube(0, 0, [[1.88, 0.285], [1.92, 0.29]], 8);
  m.tube(0, 0, [[1.92, 0.30], [2.00, 0.60], [2.06, 0.625], [2.10, 0.60]], 8,
    { capTop: true, capBot: true });
  m.tube(0, 0, [[2.10, 0.09], [2.16, 0.07]], 5, { capTop: true });
}

/**
 * String-light pole. The string it is named for went nowhere, so it read as a
 * lone stick in a verge. It now has its own reason to exist: a cast base collar
 * with bolt heads, a cross-arm with a gusset at each end, a coil of slack cable
 * at the arm root, and six bulbs on visible drop wires rather than four stubs.
 */
function gStringPole(m) {
  m.col(P.STEEL_DARK);
  flange(m, 0, 0, 0, 0.26, 0.09, 4, 6, 0.026);
  m.col(P.WOOD_DARK);
  m.tube(0, 0, [[0.09, 0.10], [1.70, 0.088]], 6);
  m.col(0x7a5838).tube(0, 0, [[1.70, 0.092], [1.74, 0.090]], 6);
  m.col(P.WOOD_DARK).tube(0, 0, [[1.74, 0.086], [3.30, 0.075]], 6, { capTop: true });
  m.col(P.STEEL_DARK);
  m.tubeBetween(0, 3.24, 0, 0.94, 3.16, 0, 0.032, 5);
  m.tubeBetween(0.06, 2.98, 0, 0.34, 3.19, 0, 0.024, 4);
  m.tubeBetween(0.62, 3.19, 0, 0.90, 3.05, 0, 0.020, 4);
  for (let k = 0; k < 3; k++) {
    m.tube(0.10, 0, [[2.86 - k * 0.05, 0.062], [2.90 - k * 0.05, 0.062]], 5);
  }
  for (let k = 1; k <= 6; k++) {
    const x = k * 0.145, y = 3.24 - x * 0.085;
    m.col(P.STEEL_DARK).tubeBetween(x, y, 0, x, y - 0.10, 0, 0.010, 3);
    m.lit(P.LAMP_GLOW, 1, 1.25);
    m.tube(x, 0, [[y - 0.10, 0.05], [y - 0.15, 0.055], [y - 0.21, 0.03]], 5, { capTop: true });
  }
}

/**
 * A festoon SPAN, poles included, as one object.
 *
 * The catenary is the whole point of string lights and it cannot be a prop of
 * its own: a cable hanging in mid-air has no ground contact, so the consumption
 * physics has nothing to take out from under it and the placement audit counts
 * every one of them as a floating prop. Modelling the pair of poles AND the
 * wire between them as a single consumable fixes both — its contact patch is
 * two 0.24 m feet 5.4 m apart, it topples about whichever foot the hole leaves
 * standing, and it goes down the hole the narrow way like the gate it is.
 */
function gStringArch(m) {
  /* 2.0 m half-span, not the 2.7 that looked right in isolation. Everything
     downstream reasons about props as bounding CIRCLES — the placer's reserve
     and the audit's overlap test both do — so a wide gate cannot stand over a
     table without one of them calling it a defect. At 4 m the circle is 2.2 m,
     which clears a table row set 2.4 m away, and the span still arches over a
     terrace's full depth. */
  const S = 2.0;          // half-span; poles at -S and +S along local x
  const TOP = 3.10, SAG = 0.55;
  for (const s of [-1, 1]) {
    m.col(P.WOOD_DARK);
    m.tube(s * S, 0, [[0, 0.24], [0.08, 0.20]], 6, { capTop: true });
    m.tube(s * S, 0, [[0.08, 0.095], [TOP + 0.10, 0.075]], 6, { capTop: true });
  }
  // Cable as four chords of a parabola; bulbs hang from each joint.
  const N = 6;
  const yOf = (t) => TOP - SAG * (1 - (2 * t - 1) * (2 * t - 1));
  m.col(P.STEEL_DARK);
  for (let k = 0; k < N; k++) {
    const t0 = k / N, t1 = (k + 1) / N;
    m.beam(-S + 2 * S * t0, yOf(t0), 0, -S + 2 * S * t1, yOf(t1), 0, 0.03, 0.03, false);
  }
  m.lit(P.LAMP_GLOW, 1, 1.25);
  for (let k = 1; k < N; k++) {
    const t = k / N, y = yOf(t);
    m.tube(-S + 2 * S * t, 0, [[y - 0.06, 0.055], [y - 0.17, 0.045]], 5, { capTop: true });
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

/**
 * Bicycle. Wheels with a hub and six spokes (spokes are the whole reason a bike
 * reads as a bike), a chainring with cranks and pedals, a chain run to the rear
 * hub, a real diamond frame so the triangle reads, a two-blade fork, a saddle on
 * a post and bars through a visible stem — plus a kickstand, because 72 coral
 * pictograms were standing up unsupported.
 */
function gBicycle(m) {
  const wheel = (cx, cy, r) => {
    m.col(P.TYRE);
    for (let k = 0; k < 8; k++) {
      const a0 = (k / 8) * TAU, a1 = ((k + 1) / 8) * TAU;
      m.tubeBetween(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, 0,
        cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, 0, 0.032, 3);
    }
    m.col(P.STEEL);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU + 0.3;
      m.tubeBetween(cx, cy, 0, cx + Math.cos(a) * r * 0.94, cy + Math.sin(a) * r * 0.94, 0, 0.010, 3);
    }
    m.col(P.CHROME);
    m.xform(0, cx, cy, 0); m.discZ(0, 0, 0.045, 0.075, 5, 0, 0.045); m.reset();
  };
  wheel(-0.55, 0.34, 0.34);
  wheel(0.55, 0.34, 0.34);
  // Diamond frame: down tube, seat tube, top tube, chainstay, seatstay.
  m.col(0xf2f2f2);
  m.tubeBetween(-0.05, 0.30, 0, 0.40, 0.62, 0, 0.026, 4);   // down tube
  m.tubeBetween(-0.05, 0.30, 0, -0.06, 0.86, 0, 0.026, 4);  // seat tube
  m.tubeBetween(-0.06, 0.86, 0, 0.42, 0.66, 0, 0.024, 4);   // top tube
  m.tubeBetween(-0.05, 0.30, 0, -0.55, 0.34, 0, 0.022, 4);  // chainstay
  m.tubeBetween(-0.06, 0.84, 0, -0.55, 0.34, 0, 0.020, 4);  // seatstay
  // Fork: two blades to the front hub.
  for (const s of [-1, 1]) {
    m.tubeBetween(0.42, 0.66, 0, 0.55, 0.34, s * 0.045, 0.020, 4);
  }
  // Chainring, cranks, pedals, chain.
  m.col(P.CHROME);
  m.xform(0, -0.05, 0.30, 0.055); m.discZ(0, 0, 0.105, 0.014, 6, 0, 0.105); m.reset();
  m.col(P.SIGN_DARK);
  m.tubeBetween(-0.05, 0.30, 0.07, -0.05, 0.16, 0.07, 0.018, 3);
  m.tubeBetween(-0.05, 0.30, -0.07, -0.05, 0.44, -0.07, 0.018, 3);
  m.prism(-0.05, 0.10, [[0.135, 0.10, 0.05], [0.155, 0.10, 0.05]]);
  m.prism(-0.05, -0.10, [[0.415, 0.10, 0.05], [0.435, 0.10, 0.05]]);
  m.col(0x1e2124);
  m.tubeBetween(-0.05, 0.395, 0.055, -0.55, 0.375, 0.055, 0.010, 3);
  m.tubeBetween(-0.05, 0.205, 0.055, -0.55, 0.305, 0.055, 0.010, 3);
  // Saddle on a post, stem and bars.
  m.col(0x22262a);
  m.tubeBetween(-0.06, 0.86, 0, -0.07, 0.98, 0, 0.018, 4);
  m.prism(-0.07, 0, [[0.98, 0.24, 0.09], [1.01, 0.20, 0.13], [1.03, 0.13, 0.10]]);
  m.tubeBetween(0.42, 0.66, 0, 0.44, 0.94, 0, 0.020, 4);
  m.tubeBetween(0.44, 0.94, 0, 0.50, 0.96, 0, 0.020, 4);
  m.tubeBetween(0.50, 0.96, -0.22, 0.50, 0.96, 0.22, 0.018, 4);
  m.col(0x15181b);
  for (const s of [-1, 1]) m.tubeBetween(0.50, 0.96, s * 0.14, 0.50, 0.96, s * 0.22, 0.028, 4, true);
  // Kickstand — nothing in this module is allowed to balance on two points.
  m.col(P.STEEL_DARK);
  m.tubeBetween(-0.05, 0.26, 0.05, -0.16, 0.01, 0.20, 0.016, 3);
}

/**
 * Sheffield stand. PAIRED hoops 0.9 m apart so a rack reads as a rack, round
 * 0.08 m tube instead of a square section, bolted base flanges so it lands on
 * the pavement instead of sinking into it, and the cross-rail lifted to 0.22
 * where it can actually be seen.
 */
function gBikeRack(m) {
  for (const z of [-0.45, 0.45]) {
    m.col(0x8d938f);
    for (const s of [-1, 1]) {
      m.tubeBetween(s * 0.42, 0.045, z, s * 0.42, 0.68, z, 0.040, 5);
      m.tubeBetween(s * 0.42, 0.68, z, s * 0.34, 0.75, z, 0.040, 5);
      m.col(P.STEEL_DARK);
      m.prism(s * 0.42, z, [[0, 0.16, 0.16], [0.03, 0.13, 0.13]]);
      m.col(0x6f7876);
      for (const b of [-1, 1]) m.plate(s * 0.42 + b * 0.05, 0.032, z, 0.035, 0.035);
      m.col(0x8d938f);
    }
    m.tubeBetween(-0.34, 0.75, z, 0.34, 0.75, z, 0.040, 5);
    m.col(0x6f7876);
    m.tubeBetween(-0.42, 0.22, z, 0.42, 0.22, z, 0.030, 4);
  }
}

/**
 * E-scooter. 192 of these read as a coloured stick with a dark T on one end:
 * r=0.13 wheels at five segments vanish entirely. Wheels are now 0.19 at eight
 * segments, on a two-leg fork and a rear swingarm, with a chamfered deck and an
 * inset grip panel, a folding-clamp collar at the stem root, a rear fender, a
 * kickstand that touches the ground and a number plate on the stem head.
 */
function gScooter(m) {
  m.col(P.TYRE);
  m.xform(0, -0.46, 0.19, 0); m.discZ(0, 0, 0.19, 0.07, 8, 0, 0.19); m.reset();
  m.xform(0, 0.44, 0.19, 0); m.discZ(0, 0, 0.19, 0.07, 8, 0, 0.19); m.reset();
  m.col(0x9aa0a0);
  m.xform(0, -0.46, 0.19, 0); m.discZ(0, 0, 0.055, 0.09, 5, 0, 0.055); m.reset();
  m.xform(0, 0.44, 0.19, 0); m.discZ(0, 0, 0.055, 0.09, 5, 0, 0.055); m.reset();
  // Deck with an inset grip panel, then the fork and swingarm.
  m.col(0xf4f4f4);
  m.prism(-0.02, 0, [[0.11, 0.80, 0.19], [0.14, 0.86, 0.21], [0.19, 0.80, 0.17]]);
  m.col(0x22262a);
  m.plate(-0.02, 0.192, 0, 0.66, 0.13);
  for (const s of [-1, 1]) {
    m.tubeBetween(0.44, 0.19, s * 0.055, 0.47, 0.60, s * 0.035, 0.026, 4);
    m.tubeBetween(-0.46, 0.19, s * 0.055, -0.30, 0.15, s * 0.05, 0.024, 4);
  }
  m.col(0xf4f4f4);
  m.tubeBetween(0.47, 0.58, 0, 0.50, 1.00, 0, 0.040, 5);
  m.col(0x30363a).tube(0.475, 0, [[0.56, 0.055], [0.63, 0.052]], 5);
  m.col(0xf4f4f4).tubeBetween(0.50, 1.00, -0.24, 0.50, 1.00, 0.24, 0.026, 5);
  m.col(0x15181b);
  for (const s of [-1, 1]) m.tubeBetween(0.50, 1.00, s * 0.13, 0.50, 1.00, s * 0.24, 0.035, 5, true);
  m.tubeBetween(0.50, 0.98, 0.10, 0.44, 0.95, 0.16, 0.014, 3);
  m.col(0x2b2f33).board(0, 0.34, 0.30, -0.62, 0.40, -0.34, 0.03);
  m.col(P.STEEL_DARK).tubeBetween(-0.10, 0.14, 0.06, -0.18, 0.01, 0.18, 0.016, 3);
  m.col(P.SIGN_FACE); decal(m, 0.50, 0.86, 0.04, 0.14, 0.09);
}

/* -- lighting ------------------------------------------------------------- */

/**
 * Lantern head. Eight-sided glass housing with a dark mullion band, a skirt
 * ring under it, a dark ogee cap and a ball finial.
 *
 * The whole lamp family shipped a two-ring faceted cone in beige — a party hat,
 * not a lit lantern. The mullion read comes out of the sweep's own `cols` so it
 * costs nothing, and only the glass panes carry the glow flag.
 */
function lantern(m, x, z, y, r, segs = 7) {
  m.col(P.BENCH_METAL);
  m.tube(x, z, [[y, r * 0.44], [y + r * 0.16, r * 0.92], [y + r * 0.30, r * 0.98]], segs);
  m.lit(P.LAMP_GLOW, 1, 1.3);
  m.tube(x, z, [
    [y + r * 0.30, r], [y + r * 0.90, r * 0.96], [y + r * 1.45, r * 0.80],
  ], segs, { cols: [P.LAMP_GLOW, P.LAMP_GLOW] });
  m.col(P.BENCH_METAL);
  m.tube(x, z, [[y + r * 0.62, r * 1.02], [y + r * 0.74, r * 1.00]], segs);
  m.tube(x, z, [
    [y + r * 1.45, r * 0.86], [y + r * 1.80, r * 0.52], [y + r * 2.00, r * 0.18],
  ], segs, { capTop: true });
  m.tube(x, z, [[y + r * 2.00, r * 0.20], [y + r * 2.18, r * 0.24], [y + r * 2.36, r * 0.08]], 5,
    { capTop: true });
}

/**
 * Cobra-arm street light. Correct silhouette already; this adds the detail it
 * had none of — a tapered chamfered housing, a cast bracket joint with a gusset
 * under the arm, a hinged access door with two bolts at 0.6 m, a bolted base
 * flange and a bird spike on the housing top, which sells the scale for 6 tris.
 */
function gLampModern(m) {
  m.col(P.STEEL_DARK);
  m.tube(0, 0, [[0, 0.26], [0.05, 0.25], [0.09, 0.175]], 8, { capTop: false });
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * TAU + 0.4;
    m.tube(Math.cos(a) * 0.205, Math.sin(a) * 0.205, [[0.05, 0.028], [0.075, 0.02]], 3,
      { capTop: true });
  }
  m.col(P.LAMP_POST).tube(0, 0, [[0.09, 0.145], [0.22, 0.135], [6.60, 0.085]], 7,
    { capTop: false });
  m.col(0x8f938c); decal(m, 0, 0.72, 0.126, 0.13, 0.34);
  m.col(P.LAMP_POST);
  m.tubeBetween(0, 6.52, 0, 0, 6.94, 0.34, 0.055, 5);
  m.tubeBetween(0, 6.94, 0.34, 0, 6.98, 1.52, 0.050, 5);
  m.tubeBetween(0, 6.86, 0.20, 0, 6.92, 0.60, 0.032, 4);   // gusset
  m.col(P.ALUMINIUM);
  m.prism(0, 1.56, [[6.78, 0.26, 0.60], [6.83, 0.32, 0.78], [6.94, 0.30, 0.74], [6.98, 0.24, 0.62]]);
  m.lit(P.LAMP_GLOW, 1, 1.4).plate(0, 6.775, 1.58, 0.24, 0.62);
  m.col(P.STEEL_DARK).tubeBetween(0, 6.98, 1.70, 0, 7.10, 1.70, 0.010, 3);
}

/**
 * Twin-globe Deco post. Tapered fluted shaft with three raised rings on a cast
 * bell base with bolt ears, a pair of SCROLL brackets rather than a straight
 * bar, two real lanterns and a ball finial between the arms.
 */
function gLampDeco(m, baskets = false) {
  m.col(P.BENCH_METAL);
  m.prism(0, 0, [[0, 0.46, 0.46], [0.06, 0.42, 0.42], [0.26, 0.40, 0.40], [0.34, 0.30, 0.30]]);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * TAU + Math.PI / 4;
    m.prism(Math.cos(a) * 0.20, Math.sin(a) * 0.20, [[0.26, 0.10, 0.10], [0.30, 0.08, 0.08]]);
  }
  m.tube(0, 0, [[0.34, 0.145], [0.46, 0.128], [0.52, 0.118]], 6);
  m.tube(0, 0, [[0.52, 0.112], [2.30, 0.094], [3.90, 0.080], [4.36, 0.076]], 6, { capTop: false });
  for (const y of [1.06, 2.30, 3.54]) m.tube(0, 0, [[y, 0.108], [y + 0.05, 0.106]], 6);
  // Scroll brackets: a knee and a short drop, not one straight cross-arm.
  for (const s of [-1, 1]) {
    m.tubeBetween(0, 4.30, 0, s * 0.36, 4.44, 0, 0.045, 4);
    m.tubeBetween(s * 0.36, 4.44, 0, s * 0.62, 4.42, 0, 0.045, 4);
    m.tubeBetween(s * 0.30, 4.16, 0, s * 0.56, 4.40, 0, 0.028, 4);
    m.tubeBetween(s * 0.62, 4.42, 0, s * 0.62, 4.56, 0, 0.042, 4);
    lantern(m, s * 0.62, 0, 4.56, 0.185, 6);
    if (!baskets) continue;
    m.col(P.STEEL_DARK);
    for (const c of [-1, 1]) {
      m.tubeBetween(s * 0.62 + c * 0.16, 4.40, 0, s * 0.62 + c * 0.20, 4.14, 0, 0.010, 3);
    }
    // Woven basket: rim ring, a two-tone flower mound, foliage under it and
    // trailing stems, so it is not one solid magenta lump.
    m.col(0x7a6248).tube(s * 0.62, 0, [[4.06, 0.20], [4.16, 0.28]], 8, { capTop: false });
    m.col(0x5e4a36).tube(s * 0.62, 0, [[4.16, 0.285], [4.20, 0.29]], 8);
    m.col(P.HEDGE).tube(s * 0.62, 0, [[4.14, 0.30], [4.22, 0.26], [4.26, 0.16]], 6, { capTop: true });
    m.col(s > 0 ? P.FLOWER_MAGENTA : P.FLOWER_PINK);
    m.tube(s * 0.62, 0, [[4.20, 0.24], [4.30, 0.27], [4.40, 0.14]], 6, { capTop: true });
    m.col(s > 0 ? P.FLOWER_PINK : P.FLOWER_WHITE);
    m.tube(s * 0.62 + 0.10, 0.06, [[4.26, 0.13], [4.34, 0.15], [4.40, 0.06]], 5, { capTop: true });
    m.col(P.HEDGE_LIGHT);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * TAU + 0.8;
      m.tubeBetween(s * 0.62 + Math.cos(a) * 0.22, 4.14, Math.sin(a) * 0.22,
        s * 0.62 + Math.cos(a) * 0.30, 3.84, Math.sin(a) * 0.30, 0.022, 3);
    }
    m.col(P.BENCH_METAL);
  }
  m.col(P.BENCH_METAL);
  m.tube(0, 0, [[4.36, 0.080], [4.48, 0.096], [4.60, 0.036]], 5, { capTop: true });
}

function gLampDecoBasket(m) { gLampDeco(m, true); }

/**
 * Park lamp. Tapered fluted post on a cast square plinth with a chamfered
 * collar and bolt ears, three raised rings, and a real eight-sided lantern with
 * a skirt, an ogee cap and a ball finial in place of the beige acorn.
 */
function gLampPark(m) {
  m.col(P.BENCH_METAL);
  m.prism(0, 0, [[0, 0.36, 0.36], [0.06, 0.33, 0.33], [0.20, 0.31, 0.31], [0.28, 0.22, 0.22]]);
  m.tube(0, 0, [[0.28, 0.115], [0.38, 0.100]], 6);
  m.tube(0, 0, [[0.38, 0.096], [1.70, 0.082], [3.02, 0.070], [3.34, 0.066]], 6, { capTop: false });
  for (const y of [0.86, 1.90, 2.86]) m.tube(0, 0, [[y, 0.094], [y + 0.045, 0.092]], 6);
  lantern(m, 0, 0, 3.30, 0.23, 7);
}

/* -- transit -------------------------------------------------------------- */

/**
 * Hanging garment: shoulders, a taper, a hem, and a hook over the rail.
 *
 * Both clothing rails in the module hung flat vertical cards, so from the game
 * camera they read as a flag stand rather than stock. A garment is defined by
 * being WIDEST just below the shoulder and narrowing to the hem.
 */
function garment(m, x, y, z, len, hex, lean = 0) {
  m.col(P.CHROME);
  m.tubeBetween(x, y + 0.05, z, x + lean * 0.03, y - 0.10, z, 0.010, 3);
  m.col(hex);
  const dx = lean * 0.05;
  m.prism(x + dx, z, [
    [y - 0.10 - len, 0.20, 0.16],
    [y - 0.10 - len * 0.30, 0.25, 0.20],
    [y - 0.22, 0.23, 0.18],
    [y - 0.10, 0.11, 0.09],
  ], { capTop: false });
}

/**
 * Bus shelter. The composition was right and the surfaces were not: the glazing
 * was an opaque pale slab and the canopy — the face the high 3/4 camera sees
 * most of — was a blank cream board. The back wall is now three panes divided
 * by real mullions with a top and bottom rail (the frame is what tells the eye
 * it is glazing), and the canopy has a parapet lip, three ribs and a gutter.
 */
function gBusShelter(m) {
  const L = 4.30, D = 1.55;
  m.col(P.STEEL_DARK);
  for (const x of [-L / 2 + 0.12, L / 2 - 0.12]) {
    m.beam(x, 0, -D / 2 + 0.1, x, 2.48, -D / 2 + 0.1, 0.12, 0.12, false);
  }
  m.beam(-L / 2, 0, D / 2 - 0.1, -L / 2, 2.48, D / 2 - 0.1, 0.12, 0.12, false);
  m.beam(L / 2 - 0.24, 0, D / 2 - 0.1, L / 2 - 0.24, 2.48, D / 2 - 0.1, 0.12, 0.12, false);
  // Glazing, brighter and paler so it reads as glass, in a real frame.
  m.col(P.GLASS_SKY, 1.22);
  m.prism(0, -D / 2 + 0.12, [[0.34, L - 0.34, 0.035], [2.32, L - 0.34, 0.035]]);
  m.prism(-L / 2 + 0.08, 0, [[0.34, 0.035, D - 0.34], [2.32, 0.035, D - 0.34]]);
  m.col(P.ALUMINIUM);
  for (const x of [-L / 3, L / 3]) {
    m.prism(x, -D / 2 + 0.12, [[0.34, 0.05, 0.06], [2.32, 0.05, 0.06]]);
  }
  for (const y of [0.30, 2.32]) {
    m.prism(0, -D / 2 + 0.12, [[y, L - 0.30, 0.07], [y + 0.05, L - 0.30, 0.07]]);
  }
  // Canopy: parapet lip, ribs and a gutter edge, because this is what is seen.
  m.col(P.ALUMINIUM);
  m.prism(0, 0.05, [[2.48, L + 0.30, D + 0.42], [2.58, L + 0.22, D + 0.34]]);
  m.col(0xb4b8b2);
  m.prism(0, 0.05, [[2.58, L + 0.24, D + 0.36], [2.64, L + 0.24, D + 0.36], [2.66, L + 0.18, D + 0.30]]);
  m.col(P.STEEL_DARK);
  for (const x of [-1.30, 0, 1.30]) {
    m.prism(x, 0.05, [[2.58, 0.10, D + 0.30], [2.61, 0.10, D + 0.30]]);
  }
  m.col(0x9aa09a).prism(0, 0.05 + (D + 0.42) / 2 - 0.03, [[2.44, L + 0.30, 0.06], [2.50, L + 0.30, 0.06]]);
  m.lit(P.LAMP_GLOW, 1, 1.1).plate(0, 2.475, 0.05, L - 0.6, 0.22);
  // Bench inside.
  m.col(P.TEAK);
  slats(m, 0, -D / 2 + 0.38, 0.44, L - 1.06, 3, 0.115, 0.02, 0.05, [0xc08a52, 0xb07a44]);
  m.col(P.STEEL_DARK);
  for (const s of [-1, 1]) {
    m.beam(s * (L / 2 - 0.7), 0, -D / 2 + 0.38, s * (L / 2 - 0.7), 0.45, -D / 2 + 0.38, 0.06, 0.30, false);
  }
  // Advertising panel and a route map on the end panel.
  m.col(P.SIGN_DARK);
  m.prism(L / 2 - 0.06, 0, [[0.30, 0.09, D - 0.30], [2.36, 0.09, D - 0.30]]);
  m.lit(P.NEON_PINK, 1, 0.9);
  m.prism(L / 2 - 0.115, 0, [[0.80, 0.02, D - 0.62], [1.94, 0.02, D - 0.62]]);
  m.lit(P.SIGN_FACE, 1, 0.5);
  m.prism(-L / 2 + 0.85, -D / 2 + 0.19, [[1.42, 0.60, 0.02], [1.96, 0.60, 0.02]]);
  m.col(P.SIGN_BLUE);
  m.prism(-L / 2 + 0.85, -D / 2 + 0.185, [[1.96, 0.66, 0.03], [2.10, 0.66, 0.03]]);
  m.col(P.HYDRANT_RED); decal(m, -L / 2 + 0.85, 1.70, -D / 2 + 0.205, 0.50, 0.02);
  m.col(P.SIGN_GREEN); decal(m, -L / 2 + 0.85, 1.58, -D / 2 + 0.205, 0.42, 0.02);
}

/**
 * Vendor food cart. Fabric canopy in four alternating panels with a scalloped
 * valance and a finial, a braced frame, a dressed counter (serving lip, two
 * chrome hatch lids, a menu board, a condiment tray, a cup stack) and running
 * gear that reads — two spoked wheels on a visible axle, a caster and a handle.
 */
function gFoodCart(m) {
  m.col(P.TYRE);
  for (const s of [-1, 1]) {
    m.xform(Math.PI / 2, s * 0.62, 0.24, 0.46); m.discZ(0, 0, 0.24, 0.10, 8, 0, 0.24); m.reset();
    m.col(P.CHROME);
    m.xform(Math.PI / 2, s * 0.62, 0.24, 0.46); m.discZ(0, 0, 0.07, 0.12, 5, 0, 0.07); m.reset();
    m.col(P.TYRE);
  }
  m.col(P.STEEL_DARK).tubeBetween(-0.66, 0.24, 0.46, 0.66, 0.24, 0.46, 0.035, 5);
  m.tubeBetween(0, 0.12, -0.42, 0, 0.34, -0.42, 0.03, 4);
  m.col(P.TYRE);
  m.xform(Math.PI / 2, 0, 0.12, -0.42); m.discZ(0, 0, 0.12, 0.07, 6, 0, 0.12); m.reset();
  m.col(0xf4f4f4);
  m.oct(0, 0, [[0.34, 1.68, 0.88, 0.06], [0.40, 1.74, 0.94, 0.06],
    [1.02, 1.78, 0.96, 0.06]], { capTop: false });
  m.col(P.ACCENT_HOT).prism(0, 0, [[0.58, 1.80, 0.98], [0.78, 1.80, 0.98]]);
  m.col(P.CHROME);
  m.prism(0, 0, [[1.02, 1.80, 0.98], [1.08, 1.76, 0.94]]);
  m.prism(0, 0.44, [[1.08, 1.76, 0.10], [1.14, 1.74, 0.08]]);   // serving lip
  for (const s of [-1, 1]) m.tube(s * 0.44, -0.12, [[1.08, 0.20], [1.12, 0.19]], 6, { capTop: true });
  m.tubeBetween(-0.92, 0.90, 0, -0.92, 0.90, 0, 0.03, 4);
  m.tubeBetween(-0.90, 0.78, -0.30, -0.90, 0.78, 0.30, 0.032, 5);   // push handle
  m.col(P.STEEL_DARK);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    m.tubeBetween(sx * 0.78, 1.14, sz * 0.40, sx * 0.72, 2.28, sz * 0.36, 0.032, 4);
  }
  for (const sz of [-1, 1]) {
    m.tubeBetween(-0.75, 1.70, sz * 0.38, 0.75, 1.70, sz * 0.38, 0.022, 4);
  }
  m.tubeBetween(-0.78, 1.14, -0.40, 0.72, 2.28, 0.36, 0.018, 4);
  // Menu board, condiment tray, cup stack, propane bottle.
  m.col(P.SIGN_DARK).prism(-0.74, 0.42, [[1.30, 0.42, 0.03], [1.86, 0.42, 0.03]]);
  m.col(P.FABRIC_SUN); decal(m, -0.74, 1.78, 0.437, 0.36, 0.07);
  m.col(P.SIGN_FACE);
  for (let k = 0; k < 4; k++) decal(m, -0.74, 1.66 - k * 0.09, 0.437, 0.32, 0.035);
  m.col(P.HYDRANT_RED).tube(0.66, 0.18, [[1.14, 0.06], [1.30, 0.05]], 5, { capTop: true });
  m.col(P.FABRIC_SUN).tube(0.78, 0.18, [[1.14, 0.06], [1.30, 0.05]], 5, { capTop: true });
  m.col(P.SIGN_FACE).tube(0.50, 0.20, [[1.14, 0.075], [1.42, 0.085]], 6, { capTop: true });
  m.col(P.CAR_SILVER).tube(-0.40, 0, [[0.36, 0.16], [0.62, 0.155], [0.66, 0.10]], 6, { capTop: true });
  canopyFabric(m, 2.20, 2.34, 2.52, 1.42, 1.30, 6, P.FABRIC_SUN, 0xfdf3dc);
  m.col(P.FABRIC_WHITE);
  valance(m, 2.20, 0.16, 1.42, 1.30, 6);
  m.col(P.STEEL_DARK).tube(0, 0, [[2.52, 0.05], [2.58, 0.055], [2.62, 0.02]], 5, { capTop: true });
}

/**
 * Hot-dog cart. A stainless drum lying on its side and CAPPED so the ends are
 * rounded, a two-leaf lid with a steam vent, a chrome push handle, a condiment
 * shelf with squeeze bottles and a napkin box, an under-shelf with a propane
 * bottle, two spoked wheels plus a jockey wheel, a menu board, and an umbrella
 * with eight gores and a scalloped hem.
 */
function gHotdogStand(m) {
  m.col(P.TYRE);
  for (const s of [-1, 1]) {
    m.xform(Math.PI / 2, s * 0.46, 0.20, 0.28); m.discZ(0, 0, 0.20, 0.08, 7, 0, 0.20); m.reset();
    m.col(P.CHROME);
    m.xform(Math.PI / 2, s * 0.46, 0.20, 0.28); m.discZ(0, 0, 0.06, 0.10, 5, 0, 0.06); m.reset();
    m.col(P.TYRE);
  }
  m.xform(Math.PI / 2, 0, 0.10, -0.34); m.discZ(0, 0, 0.10, 0.06, 6, 0, 0.10); m.reset();
  m.col(P.STEEL_DARK).tubeBetween(-0.50, 0.20, 0.28, 0.50, 0.20, 0.28, 0.03, 5);
  m.col(P.CHROME);
  m.tubeBetween(-0.58, 0.62, 0, 0.58, 0.62, 0, 0.30, 8, true);
  m.col(0xe4e8e6);
  m.prism(0, 0, [[0.88, 1.20, 0.62], [0.94, 1.16, 0.58]]);
  m.col(P.HYDRANT_RED).prism(0, 0, [[0.56, 1.24, 0.66], [0.70, 1.24, 0.66]]);
  m.col(P.CHROME);
  m.tube(0, 0.10, [[0.94, 0.07], [1.04, 0.06]], 5, { capTop: true });   // steam vent
  m.tubeBetween(0.62, 0.74, -0.20, 0.62, 0.74, 0.20, 0.028, 5, true);   // push handle
  m.tubeBetween(0.58, 0.68, 0, 0.62, 0.74, 0, 0.024, 4);
  // Condiment shelf and the under-shelf.
  m.col(P.ALUMINIUM).prism(0, 0.44, [[0.72, 0.90, 0.20], [0.76, 0.90, 0.20]]);
  m.col(P.HYDRANT_RED).tube(-0.24, 0.44, [[0.76, 0.055], [0.90, 0.04]], 5, { capTop: true });
  m.col(P.FABRIC_SUN).tube(-0.10, 0.44, [[0.76, 0.055], [0.90, 0.04]], 5, { capTop: true });
  m.col(P.BIN_GREEN).tube(0.04, 0.44, [[0.76, 0.055], [0.88, 0.04]], 5, { capTop: true });
  m.col(P.SIGN_FACE).prism(0.26, 0.44, [[0.76, 0.16, 0.14], [0.86, 0.16, 0.14]]);
  m.col(P.CAR_SILVER).tube(-0.30, -0.10, [[0.24, 0.14], [0.46, 0.135], [0.50, 0.09]], 6, { capTop: true });
  // Menu board on the street face.
  m.col(P.SIGN_DARK).prism(-0.62, 0.40, [[0.90, 0.44, 0.03], [1.36, 0.44, 0.03]]);
  m.col(P.HYDRANT_RED); decal(m, -0.62, 1.28, 0.417, 0.38, 0.08);
  m.col(P.SIGN_FACE);
  for (let k = 0; k < 3; k++) decal(m, -0.68, 1.14 - k * 0.09, 0.417, 0.24, 0.035);
  m.col(P.FABRIC_SUN); decal(m, 0.72 - 0.62, 1.14, 0.417, 0.10, 0.16);
  m.col(P.STEEL_DARK);
  m.tube(0, 0, [[0.94, 0.045], [2.02, 0.04]], 5);
  canopyFabric(m, 2.00, 2.14, 2.40, 1.02, 0.92, 8, P.FABRIC_CORAL, 0xff9a90);
  m.col(P.FABRIC_CORAL);
  valance(m, 2.00, 0.13, 1.02, 0.92, 8);
  m.col(P.STEEL_DARK).tube(0, 0, [[2.40, 0.045], [2.46, 0.05], [2.50, 0.02]], 5, { capTop: true });
}

/**
 * Market clothing rail. Shaped garments on visible hangers, a lower shelf of
 * folded stock, a cross-brace between the uprights and a header board — five
 * flat coloured slabs on a bare goalpost read as a rack of card.
 */
function gDisplayRack(m) {
  m.col(P.STEEL);
  for (const s of [-1, 1]) {
    m.tubeBetween(s * 0.62, 0.04, 0, s * 0.62, 1.52, 0, 0.028, 5);
    m.tubeBetween(s * 0.62, 0.04, -0.32, s * 0.62, 0.04, 0.32, 0.026, 4);
    for (const sz of [-1, 1]) m.prism(s * 0.62, sz * 0.32, [[0, 0.10, 0.10], [0.03, 0.08, 0.08]]);
  }
  m.tubeBetween(-0.62, 1.50, 0, 0.62, 1.50, 0, 0.024, 5);
  m.tubeBetween(-0.62, 0.44, 0, 0.62, 0.44, 0, 0.020, 4);
  m.col(P.WOOD_LIGHT).prism(0, 0, [[0.44, 1.16, 0.42], [0.48, 1.16, 0.42]]);
  m.col(P.FABRIC_SKY).prism(-0.28, 0, [[0.48, 0.34, 0.30], [0.62, 0.32, 0.28]]);
  m.col(P.FABRIC_PINK).prism(0.26, 0.04, [[0.48, 0.32, 0.28], [0.58, 0.30, 0.26]]);
  const cols = [P.FABRIC_CORAL, P.FABRIC_AQUA, P.FABRIC_SUN, P.FABRIC_SKY, P.FABRIC_PINK, P.FABRIC_LIME];
  for (let k = 0; k < 6; k++) {
    garment(m, -0.50 + k * 0.20, 1.50, (k % 3 - 1) * 0.04, 0.52 + (k % 3) * 0.09,
      cols[k], (k % 2 ? 1 : -1) * (1 + k % 3));
  }
  m.col(P.SIGN_DARK).prism(0, 0, [[1.56, 0.72, 0.03], [1.78, 0.72, 0.03]]);
  m.col(P.SIGN_FACE); decal(m, 0, 1.67, 0.017, 0.56, 0.07);
}

/**
 * Slatted produce crate. Four corner posts, three slats a side with 15 mm gaps
 * you can see through, a rim rail and a plank floor, filled with a mound of
 * overlapping fruit at two sizes rather than two smooth domes.
 */
function gProduceCrate(m) {
  const W = 0.62, D = 0.44, H = 0.34;
  m.col(P.WOOD_DECK);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      m.prism(sx * (W / 2 - 0.035), sz * (D / 2 - 0.035), [[0, 0.075, 0.075], [H + 0.04, 0.07, 0.07]]);
    }
  }
  m.col(P.WOOD_LIGHT);
  for (let k = 0; k < 3; k++) {
    const y = 0.03 + k * 0.115;
    for (const sz of [-1, 1]) m.prism(0, sz * (D / 2 - 0.012), [[y, W - 0.06, 0.022], [y + 0.075, W - 0.06, 0.022]]);
    for (const sx of [-1, 1]) m.prism(sx * (W / 2 - 0.012), 0, [[y, 0.022, D - 0.06], [y + 0.075, 0.022, D - 0.06]]);
  }
  m.col(P.WOOD_DARK);
  m.prism(0, 0, [[H + 0.04, W + 0.03, D + 0.03], [H + 0.075, W - 0.01, D - 0.01]]);
  m.col(P.WOOD_DECK).plate(0, 0.03, 0, W - 0.08, D - 0.08);
  berries(m, 0, H - 0.02, 0, 0.075, 0.20, 9,
    [P.FLOWER_ORANGE, P.CAR_LIME, P.HYDRANT_RED, P.FLOWER_ORANGE, P.GRASS_LIGHT]);
}

/* -- construction --------------------------------------------------------- */

/**
 * Jersey barrier. The profile was already right; what it had none of was the
 * JOINT — a recessed end face with two lifting pockets, a connector lug at one
 * end and a socket at the other, so a run of them reads as linked units rather
 * than as identical blocks parked in a line. Top edges chamfered, a dirtier top
 * face than the flanks, and a tyre scuff band at 0.35.
 */
function gJersey(m) {
  m.prism(0, 0, [
    [0, 2.00, 0.62], [0.06, 1.98, 0.58], [0.30, 1.98, 0.32], [0.33, 1.98, 0.31],
    [0.40, 1.98, 0.30], [0.70, 1.98, 0.25], [0.76, 1.96, 0.22], [0.80, 1.90, 0.17],
  ], {
    cols: [0xa8a08c, 0xf4eee0, 0xdcd4c0, 0xf4eee0, 0xf2ece0, 0xeae2d2, 0xe4dccc],
  });
  // Recessed end faces with two lifting pockets each.
  m.col(0xd8d0be);
  for (const s of [-1, 1]) {
    m.prism(s * 0.985, 0, [[0.34, 0.03, 0.26], [0.72, 0.03, 0.22]]);
    m.xform(Math.PI / 2 * s, 0, 0, 0);
    m.reset();
  }
  m.col(0xb4ac98);
  for (const s of [-1, 1]) {
    for (const z of [-0.05, 0.05]) m.plate(s * 0.62, 0.802, z, 0.16, 0.07);
  }
  // Connector lug on one end, socket on the other.
  m.col(0xe8e0d0).prism(1.02, 0, [[0.40, 0.09, 0.16], [0.70, 0.09, 0.16]]);
  m.col(0x9a9280).prism(-0.995, 0, [[0.40, 0.02, 0.19], [0.70, 0.02, 0.19]]);
  m.col(P.ACCENT_SUN);
  m.prism(0, 0, [[0.52, 2.00, 0.285], [0.60, 2.00, 0.275]]);
}

/**
 * Water-filled traffic barrier. Re-authored 1.85 m long along local x so it
 * packs end to end down a construction edge; the old one was a 0.72 m stepped
 * block that read as a chunky Lego brick. Splayed foot, wasp waist, flat top
 * deck, a raised fill cap with a screw lid at each end, a moulded lifting
 * handle recess in each flank, a male lug at one end and a female socket at the
 * other, two moulding ribs a side and a reflective panel at each end.
 */
function gWaterBarrier(m) {
  m.prism(0, 0, [
    [0, 1.82, 0.56], [0.09, 1.80, 0.48], [0.34, 1.80, 0.33],
    [0.60, 1.80, 0.31], [0.84, 1.82, 0.42], [0.96, 1.80, 0.46], [1.00, 1.74, 0.40],
  ], { cols: [0xd0d0d0, 0xf4f4f4, 0xffffff, 0xffffff, 0xfafafa, 0xf0f0f0] });
  // Fill caps with screw lids.
  for (const s of [-1, 1]) {
    m.col(0xe4e4e4).tube(s * 0.66, 0, [[1.00, 0.115], [1.09, 0.105]], 6);
    m.col(0xc8c8c8).tube(s * 0.66, 0, [[1.09, 0.115], [1.14, 0.095]], 6, { capTop: true });
  }
  // Ribs, handle recesses, and the interlocking ends.
  m.col(0xe0e0e0);
  for (const y of [0.42, 0.66]) m.prism(0, 0, [[y, 1.83, 0.36], [y + 0.05, 1.83, 0.36]]);
  m.col(0xcccccc);
  for (const s of [-1, 1]) {
    for (const sx of [-1, 1]) decal(m, sx * 0.42, 0.74, s * 0.20, 0.34, 0.13, s);
  }
  m.col(0xf4f4f4).prism(0.93, 0, [[0.30, 0.14, 0.24], [0.86, 0.14, 0.24]]);
  m.col(0xbcbcbc).prism(-0.905, 0, [[0.28, 0.03, 0.28], [0.88, 0.03, 0.28]]);
  m.lit(P.SIGN_FACE, 1, 0.4);
  for (const s of [-1, 1]) m.prism(s * 0.80, 0, [[0.60, 0.20, 0.34], [0.80, 0.20, 0.34]]);
  // Scuff band baked into the bottom 0.12 so it does not read as new plastic.
  m.col(0x9a9a96).prism(0, 0, [[0.02, 1.83, 0.50], [0.11, 1.82, 0.46]]);
}

/**
 * Type II barricade. The stripes are DIAGONAL now — that 45-degree slope is the
 * feature that identifies a barricade, and vertical bars read as a fence. Two
 * rails plus a cap, a sandbag over the feet and an amber reflector at each end.
 */
function gAframe(m) {
  m.col(P.BARRIER_ORANGE);
  for (const s of [-1, 1]) {
    m.beam(-0.52, 0, s * 0.24, -0.52, 1.02, s * 0.05, 0.06, 0.06, false);
    m.beam(0.52, 0, s * 0.24, 0.52, 1.02, s * 0.05, 0.06, 0.06, false);
  }
  for (const [y0, slope] of [[0.44, 1], [0.78, -1]]) {
    m.col(P.BARRIER_WHITE);
    m.prism(0, 0, [[y0, 1.10, 0.06], [y0 + 0.22, 1.10, 0.06]]);
    m.col(P.BARRIER_ORANGE);
    for (let k = 0; k < 5; k++) {
      const x = -0.44 + k * 0.24;
      for (const s of [1, -1]) {
        const z = s * 0.032;
        // Parallelogram: four quads on the diagonal, mirrored on the far rail.
        m.quad([x - 0.06, y0 + 0.005, z], [x + 0.06, y0 + 0.005, z],
          [x + 0.06 + slope * 0.13, y0 + 0.215, z], [x - 0.06 + slope * 0.13, y0 + 0.215, z]);
        m.quad([x + 0.06, y0 + 0.005, -z], [x - 0.06, y0 + 0.005, -z],
          [x - 0.06 + slope * 0.13, y0 + 0.215, -z], [x + 0.06 + slope * 0.13, y0 + 0.215, -z]);
      }
    }
  }
  m.col(P.BARRIER_WHITE);
  m.prism(0, 0, [[1.00, 1.06, 0.08], [1.05, 1.02, 0.06]]);
  m.col(P.ACCENT_SUN);
  for (const s of [-1, 1]) decal(m, s * 0.50, 0.66, 0.033, 0.10, 0.10);
  // Sandbag over the feet: a barricade nobody has weighted down is the tell.
  m.col(P.SAND_WET);
  m.tube(-0.52, 0, [[0, 0.16, 0.24], [0.08, 0.21, 0.30], [0.15, 0.10, 0.16]], 6,
    { capTop: true, rot: 0.4 });
}

/**
 * Traffic drum. Closed 8-sided barrel with PROUD ribs and retroreflective
 * bands rather than colour changes on the same surface, on a black rubber
 * ballast base ring — the single most identifying feature of a traffic drum and
 * the one the old model had none of — with a recessed lid and a lift slot.
 */
function gTrafficBarrel(m) {
  m.col(0x1e2124);
  m.tube(0, 0, [[0, 0.42], [0.06, 0.43], [0.10, 0.40], [0.12, 0.32]], 8, { capTop: false });
  m.col(P.BARRIER_ORANGE);
  m.tube(0, 0, [[0.10, 0.30], [0.20, 0.295], [0.86, 0.285], [0.92, 0.275]], 8, { capTop: true });
  for (const [y, hex] of [[0.22, P.BARRIER_WHITE], [0.40, P.BARRIER_ORANGE],
    [0.58, P.BARRIER_WHITE], [0.76, P.BARRIER_ORANGE]]) {
    m.col(hex);
    m.tube(0, 0, [[y, 0.312], [y + 0.14, 0.308]], 8);
  }
  m.col(0xe06010);
  m.tube(0, 0, [[0.88, 0.255], [0.90, 0.22]], 8, { capTop: true });
  m.col(0x8c3c08); decal(m, 0, 0.905, 0, 0.16, 0.03);
}

/**
 * Timber packing case. Four corner posts, three planks a face with a visible
 * gap and a darker seam between them, a lid with two cleats across it and a
 * stencilled shipping mark. Every edge bevelled, and no two boards the same
 * tone — the old one was a plain tan cube with a stripe.
 */
function gCrate(m) {
  const W = 0.78, D = 0.72, H = 0.66;
  const tones = [P.WOOD_DECK, P.WOOD_LIGHT, 0xd0a274, 0xbb8d5f];
  m.col(P.WOOD_DARK);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      m.prism(sx * (W / 2 - 0.045), sz * (D / 2 - 0.045),
        [[0, 0.09, 0.09], [0.02, 0.10, 0.10], [H - 0.02, 0.10, 0.10], [H, 0.09, 0.09]]);
    }
  }
  for (let k = 0; k < 3; k++) {
    const y = 0.04 + k * 0.205;
    m.col(tones[k % 4]);
    for (const sz of [-1, 1]) {
      m.prism(0, sz * (D / 2 - 0.018), [[y, W - 0.10, 0.035], [y + 0.165, W - 0.115, 0.030]]);
    }
    m.col(tones[(k + 2) % 4]);
    for (const sx of [-1, 1]) {
      m.prism(sx * (W / 2 - 0.018), 0, [[y, 0.035, D - 0.10], [y + 0.165, 0.030, D - 0.115]]);
    }
  }
  m.col(P.WOOD_LIGHT);
  slats(m, 0, 0, H, W - 0.02, 4, 0.155, 0.012, 0.04, [P.WOOD_LIGHT, P.WOOD_DECK]);
  m.col(P.WOOD_DARK);
  for (const sx of [-1, 1]) m.prism(sx * 0.24, 0, [[H + 0.04, 0.075, D - 0.02], [H + 0.065, 0.07, D - 0.03]]);
  m.col(P.SIGN_FACE); decal(m, 0, 0.36, D / 2 + 0.002, 0.24, 0.18);
  m.col(P.SIGN_DARK);
  decal(m, 0, 0.42, D / 2 + 0.004, 0.18, 0.03);
  decal(m, 0, 0.32, D / 2 + 0.004, 0.12, 0.06);
}

/**
 * Pallet stack. One pallet is now five top deck boards with 4 cm gaps, three
 * stringers below and three bottom boards — you can see the pavement through
 * the fork slots, which is the one thing a pallet actually does. The stack is
 * three layers with a rotation offset per layer and a splintered gap in the
 * middle one, plus nail heads at every board crossing.
 */
function gPallet(m) {
  const tones = [P.WOOD_LIGHT, 0xd7b384, P.WOOD_DECK];
  for (let k = 0; k < 3; k++) {
    const y = k * 0.155;
    m.xform((k - 1) * 0.06, 0, 0, 0);
    m.col(tones[k % 3]);
    for (const s of [-1, 0, 1]) {
      m.prism(s * 0.46, 0, [[y, 0.16, 0.96], [y + 0.045, 0.155, 0.95]]);       // stringers
    }
    m.col(tones[(k + 1) % 3]);
    for (const s of [-1, 0, 1]) {
      m.prism(s * 0.46, 0, [[y + 0.115, 0.16, 0.96], [y + 0.15, 0.155, 0.95]]);
    }
    // Top deck: five boards, one missing on the middle pallet.
    const n = 5;
    for (let b = 0; b < n; b++) {
      if (k === 1 && b === 3) continue;
      m.col(tones[(b + k) % 3]);
      const z = -0.42 + b * 0.21;
      m.prism(0, z, [[y + 0.045, 1.16, 0.135], [y + 0.115, 1.15, 0.125]]);
    }
    m.col(0x8f9490);
    for (const s of [-1, 0, 1]) {
      for (const z of [-0.42, 0, 0.42]) m.plate(s * 0.46, y + 0.117, z, 0.04, 0.04);
    }
    m.reset();
  }
}

/**
 * Scaffold tower. Ledgers on ALL FOUR faces at four lifts (the old one had two
 * faces and read as an inverted F), adjustable base plates with a visible screw
 * jack under each standard, a boarded deck with a toe board on all four edges,
 * a guard rail and a mid rail above the deck, and a ladder on one face.
 */
function gScaffold(m) {
  const HX = 0.60, HZ = 0.45, TOP = 2.62, DECK = 1.62;
  m.col(P.STEEL_DARK);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      m.prism(sx * HX, sz * HZ, [[0, 0.20, 0.20], [0.03, 0.17, 0.17]]);
      m.col(P.CHROME).tubeBetween(sx * HX, 0.03, sz * HZ, sx * HX, 0.16, sz * HZ, 0.028, 4);
      m.col(P.SCAFFOLD).tubeBetween(sx * HX, 0.16, sz * HZ, sx * HX, TOP, sz * HZ, 0.045, 5);
      m.col(P.STEEL_DARK);
    }
  }
  m.col(P.SCAFFOLD);
  for (const y of [0.52, 1.06, DECK - 0.06, 1.98, 2.56]) {
    for (const sz of [-1, 1]) m.tubeBetween(-HX, y, sz * HZ, HX, y, sz * HZ, 0.036, 4);
    for (const sx of [-1, 1]) m.tubeBetween(sx * HX, y, -HZ, sx * HX, y, HZ, 0.036, 4);
  }
  // Diagonal braces on two opposite faces only, as a real tower is braced.
  m.col(0x9a8a64);
  for (const sz of [-1, 1]) {
    m.tubeBetween(-HX, 0.20, sz * HZ, HX, DECK - 0.10, sz * HZ, 0.030, 4);
  }
  // Deck, toe boards, ladder.
  m.col(P.WOOD_DECK);
  slats(m, 0, 0, DECK, HX * 2 + 0.04, 3, 0.28, 0.012, 0.05, [P.WOOD_DECK, 0xb08a5c]);
  m.col(P.WOOD_DARK);
  for (const sz of [-1, 1]) m.prism(0, sz * (HZ - 0.02), [[DECK + 0.05, HX * 2, 0.03], [DECK + 0.20, HX * 2, 0.03]]);
  for (const sx of [-1, 1]) m.prism(sx * (HX - 0.02), 0, [[DECK + 0.05, 0.03, HZ * 2], [DECK + 0.20, 0.03, HZ * 2]]);
  m.col(P.SCAFFOLD);
  for (const sx of [-1, 1]) m.tubeBetween(sx * 0.28, 0.16, HZ - 0.10, sx * 0.28, DECK + 0.30, HZ - 0.10, 0.026, 4);
  for (let k = 0; k < 5; k++) {
    const y = 0.34 + k * 0.30;
    m.tubeBetween(-0.28, y, HZ - 0.10, 0.28, y, HZ - 0.10, 0.020, 4);
  }
}

/**
 * Cable reel. There was NO CABLE on it — the thing the object is named for.
 * The flanges are now radial timber staves with a darker seam between each and
 * a steel hub plate carrying six bolt heads, five stacked rings of near-black
 * cable are wound on the drum, and one loose end drapes over the flange to the
 * ground.
 */
function gCableDrum(m) {
  const R = 0.78;
  for (const s of [-1, 1]) {
    m.xform(0, 0, R, s * 0.30);
    for (let k = 0; k < 8; k++) {
      m.col(k % 2 ? P.WOOD_DECK : 0xb98d5f);
      const a0 = (k / 8) * TAU, a1 = ((k + 1) / 8) * TAU;
      m.tri([0, 0, s * 0.045], [Math.cos(a0) * R, Math.sin(a0) * R, s * 0.045],
        [Math.cos(a1) * R, Math.sin(a1) * R, s * 0.045]);
      m.tri([0, 0, -s * 0.045], [Math.cos(a1) * R, Math.sin(a1) * R, -s * 0.045],
        [Math.cos(a0) * R, Math.sin(a0) * R, -s * 0.045]);
      m.quad([Math.cos(a0) * R, Math.sin(a0) * R, 0.045],
        [Math.cos(a1) * R, Math.sin(a1) * R, 0.045],
        [Math.cos(a1) * R, Math.sin(a1) * R, -0.045],
        [Math.cos(a0) * R, Math.sin(a0) * R, -0.045]);
    }
    m.col(P.STEEL_DARK);
    m.discZ(0, 0, 0.18, 0.10, 6, -Math.PI / 2);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU;
      m.discZ(Math.cos(a) * 0.13, Math.sin(a) * 0.13, 0.028, 0.12, 3, -Math.PI / 2);
    }
    m.reset();
  }
  // The cable itself: five stacked rings, each offset to suggest a helix.
  for (let k = 0; k < 5; k++) {
    m.col(k % 2 ? 0x24282c : 0x1a1e22);
    m.xform(0, 0, R, -0.20 + k * 0.10);
    m.discZ(0, 0, 0.46 - k * 0.005, 0.095, 10, -Math.PI / 2 + k * 0.12);
    m.reset();
  }
  m.col(0x1a1e22);
  m.tubeBetween(0.06, R + 0.46, 0.28, 0.30, R * 0.9, 0.42, 0.035, 4);
  m.tubeBetween(0.30, R * 0.9, 0.42, 0.52, 0.10, 0.50, 0.035, 4);
  m.tubeBetween(0.52, 0.10, 0.50, 0.78, 0.04, 0.30, 0.035, 4);
  m.col(P.WOOD_DARK);
  for (const s of [-1, 1]) {
    m.prism(s * 0.52, 0, [[0, 0.30, 0.76], [0.15, 0.24, 0.72]]);
  }
  m.col(P.SIGN_FACE);
  m.xform(0, 0, R, 0.352); m.discZ(0.20, -0.16, 0.16, 0.02, 4, -Math.PI / 4); m.reset();
}

/**
 * Sandbags. Flattened SACKS — wider than tall, squashed on the axis they lie
 * on, with a pinched tied end at one side and a seam ridge along the top — in a
 * deliberately untidy 3-2-1 stack with one knocked off the end. Six radially
 * symmetric tubes in a perfect pyramid read as pebbles.
 */
function gSandbags(m) {
  const rows = [
    [0, [[-0.34, 0.10, 0.2], [0.02, -0.06, 1.4], [0.36, 0.06, 2.6]]],
    [0.155, [[-0.19, -0.02, 3.5], [0.20, 0.08, 0.8]]],
    [0.30, [[0.02, 0.02, 2.0]]],
  ];
  const tones = [P.SAND, P.SAND_WET, 0xdcc79a];
  let i = 0;
  for (const [y, xs] of rows) {
    for (const [x, z, rot] of xs) {
      m.col(tones[i % 3]); i++;
      m.tube(x, z, [
        [y, 0.13, 0.09], [y + 0.045, 0.235, 0.155], [y + 0.115, 0.215, 0.14],
        [y + 0.165, 0.10, 0.07],
      ], 6, { capTop: true, rot });
      m.col(tones[(i + 1) % 3]);
      m.tube(x + Math.cos(rot) * 0.24, z + Math.sin(rot) * 0.24,
        [[y + 0.03, 0.055, 0.045], [y + 0.09, 0.035, 0.03]], 4, { capTop: true });
      m.col(tones[i % 3], 0.9);
      m.plate(x, y + 0.168, z, 0.30, 0.035);
    }
  }
  // One knocked off the end, and a damp band along the bottom course.
  m.col(P.SAND_WET);
  m.tube(0.56, -0.30, [[0, 0.14, 0.10], [0.05, 0.23, 0.16], [0.12, 0.21, 0.145],
    [0.17, 0.10, 0.07]], 6, { capTop: true, rot: 1.1 });
}

/**
 * Site toilet. Corrugations down the side and back panels — that texture is the
 * entire visual identity of one of these — a roof raked back and lighter than
 * the shell, a vent pipe up the rear corner, a moulded base skid with fork
 * slots, a door in a contrasting colour with a recessed handle plate and an
 * occupancy vane, and a hand-sanitiser box on one flank.
 */
function gPortaloo(m) {
  m.col(0xb8bcb6).prism(0, 0, [[0, 1.18, 1.18], [0.05, 1.14, 1.14], [0.10, 1.10, 1.10]]);
  m.col(0x8f948e);
  for (const sx of [-1, 1]) m.plate(sx * 0.42, 0.052, 0, 0.20, 1.10);
  m.col(0xf2f2f2);
  m.oct(0, 0, [[0.10, 1.08, 1.08, 0.05], [0.16, 1.12, 1.12, 0.05],
    [2.10, 1.12, 1.12, 0.05]], { capTop: false });
  // Corrugations: eight vertical ribs on the two flanks and the back.
  m.col(0xdcdcdc);
  for (let f = 0; f < 3; f++) {
    m.xform((f + 1) * Math.PI / 2, 0, 0, 0);
    for (let k = 0; k < 8; k++) {
      m.prism(-0.42 + k * 0.12, 0.56, [[0.20, 0.055, 0.025], [2.02, 0.055, 0.025]]);
    }
    m.reset();
  }
  m.col(0xf8f8f8).board(0, 1.14, 2.10, -0.60, 2.22, 0.60, 0.06);
  m.col(0x8f948e);
  m.tubeBetween(-0.50, 0.14, -0.50, -0.50, 2.30, -0.50, 0.055, 5, true);
  // Door in a contrasting colour, with a handle plate and an occupancy vane.
  m.col(P.SIGN_GREEN).prism(0, 0.565, [[0.14, 0.70, 0.03], [2.00, 0.70, 0.03]]);
  m.col(0x1f5c3c); decal(m, 0, 1.07, 0.582, 0.62, 0.02);
  m.col(P.ALUMINIUM).prism(0.26, 0.575, [[1.02, 0.10, 0.025], [1.22, 0.10, 0.025]]);
  m.col(P.HYDRANT_RED); decal(m, 0.26, 1.30, 0.584, 0.05, 0.05);
  m.col(P.SIGN_BLUE); decal(m, 0, 1.62, 0.584, 0.26, 0.20);
  m.col(0xf2f2f2).prism(0.44, -0.585, [[1.20, 0.20, 0.11], [1.46, 0.20, 0.11]]);
}

/* -- restaurant terrace --------------------------------------------------- */
/* A terrace is a ROOM somebody laid out, not a scatter of tables: it has an
   edge (rail / hedge), a threshold (menu board, host stand), service (station,
   pastry case, bar) and light (heaters, festoon). Each of those is a distinct
   silhouette so a cluster of them reads as one place from the game camera. */

/**
 * Dressed round table. The cloth is now a DRAPE — eight sides flaring to a
 * wider hem at the floor, two corner points pulled down and out, and a soft
 * fold — over a visible tabletop disc, with the settings standing on a closed
 * top. Before the capTop fix it rendered as an open V-shell with the bud vase
 * and glasses floating on the rim.
 */
function gCafeTableCloth(m) {
  m.col(0xfaf6ec);
  m.tube(0, 0, [[0, 0.55], [0.10, 0.52], [0.44, 0.49], [0.70, 0.47], [0.74, 0.455]], 8,
    { capTop: false });
  // Two corner points pulled down and outward, and one soft fold crease.
  for (const [a, r0] of [[0.9, 0.62], [3.6, 0.60]]) {
    m.col(0xf2ece0);
    m.tubeBetween(Math.cos(a) * 0.50, 0.30, Math.sin(a) * 0.50,
      Math.cos(a) * r0, 0.0, Math.sin(a) * r0, 0.075, 4);
  }
  m.col(0xf0eade);
  m.tubeBetween(Math.cos(2.2) * 0.50, 0.62, Math.sin(2.2) * 0.50,
    Math.cos(2.2) * 0.52, 0.06, Math.sin(2.2) * 0.52, 0.035, 4);
  m.col(0xe8e0d0).tube(0, 0, [[0.74, 0.46], [0.76, 0.455]], 8);
  m.col(0xfdfaf2).disc(0, 0.762, 0, 0.455, 8);
  // Settings on the closed top.
  m.col(P.PATINA).tube(0.12, 0.10, [[0.762, 0.05], [0.88, 0.042]], 5, { capTop: true });
  m.col(P.FLOWER_PINK).tube(0.12, 0.10, [[0.88, 0.075], [0.96, 0.03]], 5, { capTop: true });
  m.col(P.CHROME);
  m.tube(-0.16, -0.10, [[0.762, 0.045], [0.87, 0.05]], 5, { capTop: true });
  m.tube(-0.06, 0.20, [[0.762, 0.045], [0.87, 0.05]], 5, { capTop: true });
  m.col(P.SIGN_FACE).prism(0.20, -0.20, [[0.762, 0.16, 0.10], [0.78, 0.15, 0.09]]);
  m.col(0xf4efe2).tube(-0.24, 0.14, [[0.762, 0.09], [0.775, 0.085]], 6, { capTop: true });
}

/**
 * Square bistro table. Chamfered and darkened top edge band, an apron rail on
 * all four sides, a cross-stretcher between the legs, tapered legs, and a
 * second setting so it never reads as an unused table.
 */
function gCafeTableSquare(m) {
  m.col(P.STEEL_DARK);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    m.tubeBetween(sx * 0.32, 0, sz * 0.32, sx * 0.29, 0.64, sz * 0.29, 0.025, 4);
  }
  m.tubeBetween(-0.30, 0.20, -0.30, 0.30, 0.20, 0.30, 0.018, 4);
  m.tubeBetween(0.30, 0.20, -0.30, -0.30, 0.20, 0.30, 0.018, 4);
  m.col(0x6f5a44);
  m.prism(0, 0, [[0.64, 0.66, 0.66], [0.70, 0.66, 0.66]]);          // apron
  m.col(0x9a7048).prism(0, 0, [[0.70, 0.78, 0.78], [0.73, 0.79, 0.79]]);
  m.col(0xfaf4e6).prism(0, 0, [[0.73, 0.79, 0.79], [0.765, 0.75, 0.75]]);
  m.col(P.SIGN_FACE).prism(0.20, 0.18, [[0.765, 0.14, 0.10], [0.945, 0.13, 0.09]]);
  m.col(P.STEEL_DARK).tube(-0.18, -0.16, [[0.765, 0.075], [0.79, 0.07]], 6, { capTop: true });
  m.col(P.GLASS_MINT).tube(-0.14, 0.20, [[0.765, 0.045], [0.87, 0.05]], 5, { capTop: true });
}

/**
 * French bistro chair. A round dished seat, four legs splayed 12 degrees and
 * tapered, a ring stretcher, and a back of a curved top rail on three vertical
 * spindles — the SEE-THROUGH back is what stops 588 of these massing into a
 * green wall, which is exactly what a solid board did.
 *
 * The seat is authored near-white and the frame carries the saturated hue, so a
 * terrace reads as one chair model in four colours rather than four blocks of
 * colour.
 */
function gBistroChair(m) {
  m.col(0xe0d8c8);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    m.tubeBetween(sx * 0.24, 0, sz * 0.24, sx * 0.155, 0.42, sz * 0.155, 0.026, 4);
  }
  for (let k = 0; k < 4; k++) {
    const a0 = (k / 4) * TAU + Math.PI / 4, a1 = ((k + 1) / 4) * TAU + Math.PI / 4;
    m.tubeBetween(Math.cos(a0) * 0.225, 0.16, Math.sin(a0) * 0.225,
      Math.cos(a1) * 0.225, 0.16, Math.sin(a1) * 0.225, 0.016, 3);
  }
  m.col(0xf6f2e8);
  m.tube(0, 0, [[0.42, 0.225], [0.45, 0.245], [0.465, 0.238]], 10);
  m.col(0xfdfaf2).disc(0, 0.463, 0, 0.238, 10);
  m.col(0xe8e2d4).tube(0, 0, [[0.463, 0.20], [0.475, 0.185]], 10, { capTop: true });
  // Back: a curved top rail carried on three spindles.
  m.col(0xe0d8c8);
  for (const x of [-0.13, 0, 0.13]) {
    const z = -0.19 - (0.13 * 0.13 - x * x) * 0.9;
    m.tubeBetween(x, 0.44, z + 0.02, x, 0.84, z - 0.03, 0.020, 4);
  }
  const rail = [[-0.20, -0.175], [-0.10, -0.205], [0.10, -0.205], [0.20, -0.175]];
  for (let k = 0; k < 3; k++) {
    m.tubeBetween(rail[k][0], 0.86, rail[k][1] - 0.03, rail[k + 1][0], 0.86, rail[k + 1][1] - 0.03,
      0.030, 5);
  }
  for (const s of [-1, 1]) {
    m.tubeBetween(s * 0.155, 0.44, -0.155, s * 0.20, 0.86, -0.205, 0.024, 4);
  }
}

/**
 * Bar stool. Round tapered legs triangulated by TWO stretcher rings, a seat
 * with a dished top and a rounded edge roll over a rattan panel, and foot pads
 * at the leg tips.
 */
function gBarStool(m) {
  m.col(P.STEEL_DARK);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * TAU + 0.4;
    m.tubeBetween(Math.cos(a) * 0.28, 0.02, Math.sin(a) * 0.28,
      Math.cos(a) * 0.10, 0.70, Math.sin(a) * 0.10, 0.028, 5);
    m.tube(Math.cos(a) * 0.28, Math.sin(a) * 0.28, [[0, 0.05], [0.025, 0.042]], 4, { capTop: true });
  }
  for (const [y, r] of [[0.24, 0.225], [0.44, 0.175]]) {
    for (let k = 0; k < 3; k++) {
      const a0 = (k / 3) * TAU + 0.4, a1 = ((k + 1) / 3) * TAU + 0.4;
      m.tubeBetween(Math.cos(a0) * r, y, Math.sin(a0) * r, Math.cos(a1) * r, y, Math.sin(a1) * r,
        0.018, 4);
    }
  }
  m.col(P.TEAK);
  m.tube(0, 0, [[0.68, 0.215], [0.72, 0.235], [0.755, 0.228]], 8);
  m.col(0xd8a870).disc(0, 0.753, 0, 0.228, 8);
  m.col(0xb98a52).tube(0, 0, [[0.753, 0.19], [0.762, 0.175]], 8, { capTop: true });
}

/**
 * Menu board. A dark slate inset inside a proud timber frame, canted back 8
 * degrees on chunky A-frame legs with feet — and CHALK on it: five pale bars in
 * two lengths plus a heading and a drawn motif. At four metres that reads
 * unmistakably as a written menu, and the old blank navy slab read as nothing.
 */
function gMenuBoard(m) {
  m.col(P.WOOD_DARK);
  for (const s of [-1, 1]) {
    m.tubeBetween(s * 0.30, 0, 0.14, s * 0.26, 1.00, -0.02, 0.045, 5);
    m.tubeBetween(s * 0.30, 0, -0.14, s * 0.26, 1.00, -0.02, 0.038, 4);
    m.prism(s * 0.30, 0.14, [[0, 0.12, 0.10], [0.03, 0.10, 0.08]]);
    m.prism(s * 0.30, -0.14, [[0, 0.12, 0.10], [0.03, 0.10, 0.08]]);
  }
  m.tubeBetween(-0.28, 0.34, 0.02, 0.28, 0.34, 0.02, 0.030, 4);
  // The board itself, raked back 8 degrees.
  m.col(P.TEAK).board(0, 0.68, 0.90, 0.10, 1.68, -0.02, 0.07);
  m.col(0x24282c).board(0, 0.56, 0.96, 0.082, 1.62, -0.005, 0.045);
  m.col(P.SIGN_FACE);
  rake(m, 0, 0.40, 1.46, 0.028, 1.50, 0.022, 0.026);
  for (let k = 0; k < 5; k++) {
    const y = 1.34 - k * 0.115;
    rake(m, -0.05 + (k % 2) * 0.04, k % 2 ? 0.30 : 0.42, y, 0.03, y + 0.035, 0.028, 0.026);
  }
  m.col(P.NEON_ORANGE);
  rake(m, 0.14, 0.12, 0.68, 0.055, 0.80, 0.045, 0.026);
  m.lit(P.SIGN_FACE, 1, 0.5);
  rake(m, 0, 0.44, 1.52, 0.021, 1.58, 0.014, 0.026);
}

/**
 * Host lectern. Frame-and-panel body with a two-tone inset, a contrasting dark
 * top with a lip and a brass edge band, a reservation book and a stack of menus
 * on the sloped top, a brass kick rail, an open shelf of menu covers below, and
 * a lamp that has a shade, an elbow and a base plate.
 */
function gHostStand(m) {
  m.col(P.WOOD_DARK);
  m.oct(0, 0, [[0, 0.56, 0.46, 0.03], [0.07, 0.50, 0.40, 0.03],
    [0.98, 0.50, 0.40, 0.03]], { capTop: false });
  m.col(0x6f5232); decal(m, 0, 0.56, 0.202, 0.36, 0.68);
  m.col(0xa07a4c); borderBoth(m, 0, 0.56, 0.204, 0.40, 0.74, 0.03);
  m.col(P.ACCENT_SUN).prism(0, 0, [[0.94, 0.53, 0.43], [0.97, 0.53, 0.43]]);
  m.col(P.TEAK).board(0, 0.56, 0.98, -0.21, 1.10, 0.19, 0.06);
  m.col(0x6f5232).board(0, 0.58, 1.03, 0.20, 1.06, 0.21, 0.04);
  m.col(P.CHROME).tubeBetween(-0.22, 0.10, 0.215, 0.22, 0.10, 0.215, 0.020, 5);
  // Reservation book, menu stack and the shelf below.
  m.col(P.SIGN_FACE).prism(-0.10, -0.02, [[1.05, 0.24, 0.18], [1.08, 0.235, 0.175]]);
  m.col(0x8c1a2c).prism(0.16, 0.02, [[1.03, 0.16, 0.22], [1.09, 0.155, 0.215]]);
  m.col(0x2a2f3a).prism(0, 0, [[0.60, 0.42, 0.32], [0.63, 0.42, 0.32]]);
  m.col(P.STUCCO_BUTTER).prism(-0.08, 0, [[0.63, 0.20, 0.26], [0.69, 0.19, 0.25]]);
  // The lamp: arm, elbow, shade, base plate.
  m.col(P.CHROME);
  m.tube(0.18, -0.10, [[1.08, 0.06], [1.10, 0.055]], 6, { capTop: true });
  m.tubeBetween(0.18, 1.10, -0.10, 0.18, 1.32, -0.10, 0.016, 4);
  m.tubeBetween(0.18, 1.32, -0.10, 0.18, 1.34, -0.02, 0.016, 4);
  m.col(P.SIGN_DARK).tube(0.18, -0.02, [[1.28, 0.13], [1.35, 0.075]], 6, { capTop: true });
  m.lit(P.LAMP_GLOW, 1, 1.1).disc(0.18, 1.278, -0.02, 0.125, 6, 0, false);
}

/**
 * Pastry case. The goods inside were invisible because the glass band rendered
 * fully opaque: the glass is now pale and high-key with a bright highlight
 * streak across the top third, a dark interior value behind it, a chrome bezel
 * top and bottom and a mullion at each end, and the front curves forward at the
 * top the way a bakery case does. Shelf goods are brighter and more varied.
 */
function gPastryCase(m) {
  m.col(P.STEEL_DARK).prism(0, 0, [[0, 1.12, 0.70], [0.08, 1.06, 0.64], [0.20, 1.04, 0.62]]);
  m.col(P.ALUMINIUM).prism(0, 0, [[0.20, 1.08, 0.66], [0.26, 1.06, 0.64]]);
  m.col(0xf0ece2).prism(0, 0, [[0.26, 1.04, 0.62], [0.80, 1.04, 0.62]]);
  m.col(P.CHROME).prism(0, 0, [[0.80, 1.10, 0.68], [0.86, 1.08, 0.66]]);
  // Dark interior first, so the glass has something to be in front of.
  m.col(0x2a2f34).prism(0, 0, [[0.86, 1.00, 0.58], [1.42, 1.00, 0.58]], { capTop: false });
  for (const [y, hex] of [[0.90, P.STUCCO_BUTTER], [1.16, P.TERRACOTTA]]) {
    m.col(P.ALUMINIUM).prism(0, 0, [[y, 0.98, 0.52], [y + 0.03, 0.98, 0.52]]);
    for (let k = 0; k < 5; k++) {
      m.col([hex, P.FLOWER_WHITE, 0x6b4630, P.FLOWER_PINK, P.STUCCO_BUTTER][k]);
      m.prism(-0.36 + k * 0.18, 0, [[y + 0.03, 0.14, 0.30], [y + 0.11, 0.12, 0.26]]);
    }
  }
  // Curved front glass: two rings leaning forward at the top.
  m.col(P.GLASS_SKY, 1.30);
  m.board(0, 1.06, 0.86, 0.31, 1.30, 0.33, 0.035);
  m.board(0, 1.06, 1.30, 0.33, 1.44, 0.24, 0.035);
  m.col(0xf4fbff, 1.35);
  m.board(0, 1.06, 1.30, 0.352, 1.40, 0.288, 0.012);
  m.col(P.GLASS_SKY, 1.24);
  for (const s of [-1, 1]) m.prism(s * 0.53, 0, [[0.86, 0.03, 0.60], [1.44, 0.03, 0.52]]);
  m.col(P.CHROME);
  for (const s of [-1, 1]) m.prism(s * 0.53, 0, [[0.86, 0.05, 0.62], [0.90, 0.05, 0.62]]);
  for (const s of [-1, 1]) m.prism(s * 0.53, 0.30, [[0.86, 0.05, 0.06], [1.44, 0.05, 0.06]]);
  m.lit(P.LAMP_GLOW, 1, 0.7).prism(0, 0, [[1.44, 1.10, 0.60], [1.50, 1.06, 0.56]]);
}

/**
 * Waiter's side station. Two cupboard doors with a scribed reveal and chrome
 * pulls, a drawer line under the top, a shelf of folded linen, a plinth recess
 * so it does not sit flush on the pavement, a stack of three offset trays, a
 * flared ice bucket and a folded napkin pile with two glasses.
 */
function gServiceStation(m) {
  m.col(0x5f4630).prism(0, 0, [[0, 0.86, 0.46], [0.06, 0.90, 0.50]]);
  m.col(P.WOOD_DARK);
  m.oct(0, 0, [[0.06, 0.90, 0.50, 0.03], [0.10, 0.94, 0.54, 0.03],
    [0.86, 0.94, 0.54, 0.03]], { capTop: false });
  m.col(0x6f5232);
  decal(m, 0, 0.45, 0.272, 0.014, 0.58);                       // centre seam
  decal(m, 0, 0.78, 0.272, 0.86, 0.012);                       // drawer line
  for (const s of [-1, 1]) {
    m.col(0x7d5e3c); decal(m, s * 0.22, 0.44, 0.272, 0.36, 0.50);
    m.col(P.CHROME); m.tubeBetween(s * 0.22, 0.62, 0.28, s * 0.22, 0.62, 0.31, 0.018, 4, true);
  }
  m.col(P.CHROME).tubeBetween(-0.24, 0.82, 0.28, 0.24, 0.82, 0.28, 0.016, 4);
  m.col(P.TEAK).prism(0, 0, [[0.86, 0.98, 0.58], [0.92, 0.94, 0.54]]);
  // Tray stack, ice bucket, napkins and glasses.
  m.col(P.FABRIC_WHITE);
  for (let k = 0; k < 3; k++) {
    m.xform(k * 0.10, 0, 0, 0);
    m.prism(-0.26, 0.02, [[0.92 + k * 0.035, 0.34, 0.30], [0.95 + k * 0.035, 0.33, 0.29]]);
    m.reset();
  }
  m.col(P.CHROME);
  m.tube(0.26, 0, [[0.92, 0.14], [1.02, 0.17], [1.12, 0.19]], 6, { capTop: false });
  m.tube(0.26, 0, [[1.12, 0.195], [1.15, 0.185]], 6);
  m.col(P.SEA_FOAM).disc(0.26, 1.115, 0, 0.185, 6);
  m.col(P.FABRIC_WHITE).prism(0.02, -0.14, [[0.92, 0.22, 0.16], [0.98, 0.20, 0.14]]);
  m.col(P.GLASS_MINT);
  for (const dx of [-0.02, 0.08]) m.tube(dx, 0.16, [[0.92, 0.045], [1.03, 0.05]], 5, { capTop: true });
}

/**
 * Glass windbreak. A bottom rail and four chrome glass clamps where the pane
 * meets the frame, a rounded capping profile on the top rail, levelling feet
 * under the concrete shoes, and a frosted band along the bottom of the pane
 * plus a slim etched band at eye height so it is not one uniform blue sheet.
 */
function gTerraceRail(m) {
  m.col(P.CONCRETE_DARK);
  for (const s of [-1, 1]) {
    m.prism(s * 0.80, 0, [[0.03, 0.34, 0.40], [0.10, 0.30, 0.36]]);
    m.col(P.STEEL_DARK);
    for (const sz of [-1, 1]) m.tube(s * 0.80, sz * 0.13, [[0, 0.045], [0.035, 0.04]], 4, { capTop: true });
    m.col(P.CONCRETE_DARK);
  }
  m.col(P.ALUMINIUM);
  for (const s of [-1, 1]) m.tubeBetween(s * 0.80, 0.10, 0, s * 0.80, 1.04, 0, 0.040, 5);
  m.tubeBetween(-0.86, 1.04, 0, 0.86, 1.04, 0, 0.055, 6);
  m.tubeBetween(-0.82, 0.18, 0, 0.82, 0.18, 0, 0.035, 5);
  m.col(P.GLASS_SKY, 1.18).prism(0, 0, [[0.18, 1.56, 0.028], [1.02, 1.56, 0.028]]);
  m.col(0xd8ecf6, 1.24).prism(0, 0, [[0.18, 1.56, 0.032], [0.43, 1.56, 0.032]]);
  m.col(0xeaf6fc, 1.2); decal(m, 0, 0.78, 0.018, 1.50, 0.05);
  m.col(P.CHROME);
  for (const sx of [-1, 1]) {
    for (const y of [0.24, 0.96]) m.prism(sx * 0.70, 0, [[y, 0.09, 0.09], [y + 0.07, 0.09, 0.09]]);
  }
}

/**
 * Terrace hedge trough. The old one was a solid extruded green prism on a brown
 * box — "the green sausage" nature.js already names as the failure mode. The
 * trough now has five visible staves per long side with reveals between them, a
 * darker capping rail and a shadow gap at the plinth; the hedge is five
 * overlapping clipped clumps with a RIDGED top so it has a lit face and a
 * turned-away face, jittered in height so the top is not a ruled line, with
 * two leaves overhanging the lip and dark mulch visible between the stems.
 */
function gTerraceHedge(m) {
  m.col(P.BRICK_DARK).prism(0, 0, [[0, 1.98, 0.50], [0.045, 2.04, 0.56]]);
  m.col(P.WOOD_DARK);
  m.prism(0, 0, [[0.045, 2.04, 0.56], [0.44, 2.08, 0.60]], { capTop: false });
  m.col(0x74522e);
  for (let k = 0; k < 5; k++) {
    const x = -0.80 + k * 0.40;
    for (const sz of [-1, 1]) decal(m, x, 0.24, sz * 0.301, 0.055, 0.36, sz);
  }
  m.col(0x6f4e2c).prism(0, 0, [[0.44, 2.12, 0.64], [0.50, 2.08, 0.60]]);
  m.col(P.MULCH).plate(0, 0.455, 0, 1.96, 0.50);
  // Clipped hedge: overlapping clumps with a pitched ridge, not one prism.
  for (let k = 0; k < 5; k++) {
    const x = -0.84 + k * 0.42;
    const h = 0.86 + ((k * 7) % 3) * 0.055;
    m.col(k % 2 ? P.HEDGE : P.HEDGE_LIGHT);
    m.prism(x, 0, [[0.42, 0.46, 0.44], [h - 0.14, 0.50, 0.50], [h, 0.40, 0.34]],
      { cols: [k % 2 ? P.HEDGE : P.HEDGE_LIGHT, k % 2 ? P.HEDGE_LIGHT : P.HEDGE] });
  }
  // Two leaves overhanging the lip.
  m.col(P.HEDGE_LIGHT);
  m.tube(-0.62, 0.30, [[0.52, 0.16], [0.62, 0.14], [0.68, 0.05]], 5, { capTop: true });
  m.col(P.HEDGE);
  m.tube(0.72, -0.30, [[0.50, 0.15], [0.60, 0.13], [0.66, 0.05]], 5, { capTop: true });
}

/**
 * Planted screen. A trellis reads by its CROSSING lattice; the old one was five
 * evenly-spaced horizontal rails, i.e. a ladder. Seven vertical battens now
 * cross the rails so there are see-through squares, the top rail overhangs the
 * posts, and the climber is five clumps threaded THROUGH the lattice at varied
 * heights with a trailing flower run, rather than three gems parked in front.
 */
function gPlantScreen(m) {
  m.col(P.WOOD_DARK).prism(0, 0, [
    [0, 1.88, 0.52], [0.07, 1.82, 0.46], [0.50, 1.94, 0.58],
  ], { cols: [P.BRICK_DARK, P.WOOD_DARK, P.WOOD_DARK], capTop: false });
  m.col(P.MULCH).plate(0, 0.46, 0, 1.84, 0.48);
  m.col(P.TEAK);
  for (const s of [-1, 1]) m.beam(s * 0.84, 0.42, 0, s * 0.84, 1.82, 0, 0.10, 0.09, false);
  for (let k = 0; k < 5; k++) {
    const y = 0.78 + k * 0.25;
    m.beam(-0.94, y, 0.02, 0.94, y, 0.02, 0.085, 0.045, false);
  }
  m.col(0x9a7048);
  for (let k = 0; k < 7; k++) {
    const x = -0.72 + k * 0.24;
    m.beam(x, 0.62, -0.02, x, 1.90, -0.02, 0.055, 0.04, false);
  }
  m.col(P.TEAK).beam(-0.98, 1.90, 0, 0.98, 1.90, 0, 0.11, 0.06, false);
  // Climber woven through the lattice, front and back.
  const clumps = [[-0.62, 0.88, 0.30, 0.06], [-0.14, 1.32, 0.26, -0.05],
    [0.30, 1.02, 0.28, 0.06], [0.68, 1.52, 0.24, -0.05], [0.06, 0.72, 0.24, 0.06]];
  for (let k = 0; k < clumps.length; k++) {
    const [x, y, r, z] = clumps[k];
    m.col(k % 2 ? P.HEDGE : P.HEDGE_LIGHT);
    m.tube(x, z, [[y - r, r * 0.6], [y, r], [y + r * 0.9, r * 0.7], [y + r * 1.4, r * 0.25]], 5,
      { capTop: true, rot: k });
  }
  m.col(P.FLOWER_MAGENTA);
  for (const [x, y] of [[-0.40, 1.10], [0.12, 1.56], [0.52, 0.94]]) {
    m.tube(x, 0.08, [[y, 0.09], [y + 0.07, 0.10], [y + 0.14, 0.04]], 5, { capTop: true });
  }
  m.lit(P.LAMP_GLOW, 1, 1.15);
  for (const x of [-0.56, 0, 0.56]) {
    m.tube(x, 0, [[1.80, 0.05], [1.70, 0.042]], 5, { capTop: true });
  }
  m.col(P.STEEL_DARK);
  m.tubeBetween(-0.84, 1.86, 0, 0.84, 1.86, 0, 0.010, 3);
}

/* -- nightlife + hotel ---------------------------------------------------- */

/**
 * Hotel porte-cochère. Four columns and a slab, and by some way the biggest
 * thing this module makes: 6.4 m across the frontage. Its contact patch is the
 * four column feet, so a hole has to take out most of an entrance before it
 * goes — which is right, and it gives the tower forecourts a landmark that is
 * neither a building nor litter.
 */
function gPorteCochere(m) {
  const HX = 2.70, HZ = 1.30, H = 4.05;
  /* Each column gets a base plinth, a contrasting stone lower metre, two
     vertical reveal grooves per face and a capital block at the head — 12
     copies of a 6.4 m hotel entrance is a landmark object, and four plain
     tapered shafts is not what a landmark looks like. */
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      m.col(P.CONCRETE_DARK);
      m.prism(sx * HX, sz * HZ, [[0, 0.62, 0.62], [0.10, 0.58, 0.58], [0.16, 0.52, 0.52]]);
      m.col(P.STUCCO_SAND);
      m.prism(sx * HX, sz * HZ, [[0.16, 0.50, 0.50], [1.10, 0.48, 0.48]], { capTop: false });
      m.col(P.CONCRETE);
      m.prism(sx * HX, sz * HZ, [[1.10, 0.46, 0.46], [H - 0.34, 0.42, 0.42]], { capTop: false });
      m.col(P.CONCRETE_WARM);
      m.prism(sx * HX, sz * HZ, [[H - 0.34, 0.48, 0.48], [H - 0.26, 0.52, 0.52],
        [H, 0.50, 0.50]], { capTop: false });
      m.col(P.CONCRETE_DARK);
      for (let f = 0; f < 4; f++) {
        m.xform((f / 4) * TAU, sx * HX, 0, sz * HZ);
        for (const g of [-0.11, 0.11]) decal(m, g, 2.30, 0.232, 0.035, 2.20);
        m.reset();
      }
    }
  }
  /* The soffit is its own thin slab with a bottom face, and it is the lit part.
     A canopy modelled as one prism has no underside at all — `prism` only caps
     the top — so at eye level you would look straight up through it, and any
     "downlight" placed under it would be an upward-facing quad nobody can see. */
  m.col(P.CONCRETE).prism(0, 0, [[H - 0.06, 6.30, 3.20], [H, 6.30, 3.20]],
    { capTop: false, capBot: true });
  m.lit(P.LAMP_GLOW, 0.62, 0.9).prism(0, 0, [[H - 0.055, 4.90, 2.10], [H - 0.005, 4.90, 2.10]],
    { capTop: false, capBot: true });
  // Recessed downlights with visible dark housings in the soffit.
  m.col(0x2a2f34);
  for (let k = 0; k < 6; k++) {
    const x = -2.10 + (k % 3) * 2.10, z = k < 3 ? -0.80 : 0.80;
    m.tube(x, z, [[H - 0.10, 0.17], [H - 0.055, 0.17]], 6, { capBot: false });
    m.lit(P.LAMP_GLOW, 1, 1.25).disc(x, H - 0.10, z, 0.15, 6, 0, false);
    m.col(0x2a2f34);
  }
  // Three-part fascia: shadow gap, main band, proud drip edge.
  m.col(P.CONCRETE_DARK).prism(0, 0, [[H, 6.26, 3.16], [H + 0.06, 6.26, 3.16]]);
  m.col(P.CONCRETE_WARM).prism(0, 0, [[H + 0.06, 6.46, 3.36], [H + 0.26, 6.52, 3.42]]);
  m.col(P.CONCRETE).prism(0, 0, [[H + 0.26, 6.66, 3.56], [H + 0.34, 6.62, 3.52],
    [H + 0.40, 6.30, 3.20]]);
  m.lit(P.NEON_AQUA, 1, 0.8);
  decal(m, 0, H + 0.16, 1.712, 3.20, 0.13);
  decal(m, 0, H + 0.16, 1.712, 3.20, 0.13, -1);
  // Hanging lantern under the centre of the canopy.
  m.col(P.BENCH_METAL);
  m.tubeBetween(0, H - 0.06, 0, 0, H - 0.52, 0, 0.030, 4);
  lantern(m, 0, 0, H - 1.10, 0.24, 7);
}

/**
 * Entrance carpet WITH its rope line, running door-to-kerb along local +z.
 *
 * The ropes are part of the object rather than four stanchions standing on it,
 * because a prop standing on another prop is two things the tooling has to
 * call wrong: the placer refuses the second one, and where it does not, the
 * audit counts the pair as interpenetrating. Modelled together it is one
 * consumable that falls in one piece, which is also what it would do.
 */
function gCarpetRunner(m) {
  m.col(0xb4243c).prism(0, 0, [
    [0, 1.42, 2.70], [0.045, 1.50, 2.78], [0.07, 1.38, 2.66],
  ], { cols: [0x8c1a2c, 0xb4243c] });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      m.col(P.STEEL_DARK).tube(sx * 1.02, sz * 1.08, [[0, 0.16], [0.05, 0.14]], 5, { capTop: true });
      m.col(P.ACCENT_SUN, 0.9).tube(sx * 1.02, sz * 1.08, [[0.05, 0.05], [0.90, 0.046]], 5);
      m.tube(sx * 1.02, sz * 1.08, [[0.90, 0.075], [0.98, 0.05]], 5, { capTop: true });
    }
    m.col(0x8c1a2c);
    const pts = [[-1.08, 0.84], [-0.36, 0.66], [0.36, 0.66], [1.08, 0.84]];
    for (let k = 0; k < 3; k++) {
      m.beam(sx * 1.02, pts[k][1], pts[k][0], sx * 1.02, pts[k + 1][1], pts[k + 1][0], 0.05, 0.05, false);
    }
  }
}

/**
 * Queue line. Five chords with a real catenary on a round six-sided section, so
 * it reads as rope and not as a bent stick; a brass end clip and a tassel where
 * it meets each finial; and a weighted disc base with a chamfered top under a
 * bead below the finial.
 */
function gVelvetRope(m) {
  const S = 0.95;
  for (const s of [-1, 1]) {
    m.col(P.STEEL_DARK);
    m.tube(s * S, 0, [[0, 0.185], [0.03, 0.180], [0.06, 0.13], [0.075, 0.055]], 5, { capTop: false });
    m.col(P.CHROME);
    m.tube(s * S, 0, [[0.075, 0.048], [0.86, 0.045]], 5);
    m.tube(s * S, 0, [[0.86, 0.070], [0.90, 0.066]], 5);
    m.tube(s * S, 0, [[0.90, 0.055], [0.96, 0.065], [1.00, 0.028]], 5, { capTop: true });
    m.col(P.ACCENT_SUN);
    m.tube(s * S, 0, [[0.82, 0.058], [0.86, 0.058]], 5);
  }
  m.col(0x8c1a2c);
  ropeRun(m, -S, S, 0, 0.86, 0.62, 0.038, 6);
  m.col(P.ACCENT_SUN);
  for (const s of [-1, 1]) {
    m.tubeBetween(s * S, 0.86, 0, s * (S - 0.07), 0.82, 0, 0.045, 5, true);
    m.col(0x6f1424);
    m.tube(s * S, 0, [[0.78, 0.035], [0.82, 0.045], [0.86, 0.02]], 4, { capTop: true });
    m.col(P.ACCENT_SUN);
  }
}

/**
 * Door podium. A raked lectern top with a lipped edge, a guest-list clipboard
 * and a pen on it, a chrome toe kick and top edge band, a rope eye on the
 * street face so it visibly belongs to the velvetRope run it is placed with,
 * and an illuminated house-number plate rather than a bare glow rectangle.
 */
function gBouncerPodium(m) {
  m.col(P.SIGN_DARK);
  m.oct(0, 0, [[0, 0.68, 0.52, 0.035], [0.09, 0.60, 0.44, 0.035],
    [1.00, 0.60, 0.44, 0.035]], { capTop: false });
  m.col(P.CHROME);
  m.prism(0, 0, [[0.05, 0.66, 0.50], [0.09, 0.64, 0.48]]);
  m.prism(0, 0, [[1.00, 0.66, 0.50], [1.035, 0.64, 0.48]]);
  m.col(0x1b1f26).board(0, 0.66, 1.02, -0.20, 1.14, 0.20, 0.05);
  m.col(P.CHROME).board(0, 0.66, 1.06, 0.21, 1.10, 0.225, 0.035);
  m.col(P.SIGN_FACE);
  rake(m, -0.05, 0.30, 1.05, -0.10, 1.12, 0.13, 0.03);
  m.col(P.SIGN_DARK);
  rake(m, -0.05, 0.26, 1.075, -0.02, 1.085, 0.03, 0.035);
  m.col(P.ACCENT_SUN);
  rake(m, 0.20, 0.02, 1.06, -0.02, 1.10, 0.10, 0.035);
  m.col(P.CHROME);
  m.tubeBetween(0, 0.72, 0.225, 0, 0.78, 0.255, 0.016, 3);
  m.tubeBetween(0, 0.78, 0.255, 0, 0.72, 0.275, 0.016, 3);
  m.col(P.SIGN_DARK).prism(0, 0.235, [[0.52, 0.34, 0.03], [0.76, 0.34, 0.03]]);
  m.lit(P.NEON_PINK, 1, 0.9); decal(m, 0, 0.64, 0.252, 0.28, 0.18);
  m.col(P.SIGN_DARK);
  decal(m, -0.05, 0.64, 0.256, 0.06, 0.11);
  decal(m, 0.06, 0.64, 0.256, 0.06, 0.11);
}

/**
 * Valet key board. A real cabinet — 0.78 x 0.16 x 0.68 box with a recessed door
 * panel, a hinge line, a lock escutcheon and a pull — with the CONTENTS shown:
 * eight hooks and four fobs on the open half. A sloped writing ledge with a
 * clipboard on top, a braced A-frame with feet and a lower stretcher, and a lit
 * VALET header. The old one was a blank white board on two bare sticks.
 */
function gKeyBoard(m) {
  m.col(P.STEEL_DARK);
  for (const s of [-1, 1]) {
    m.tubeBetween(s * 0.36, 0, -0.12, s * 0.30, 0.94, 0, 0.028, 4);
    m.tubeBetween(s * 0.36, 0, 0.12, s * 0.30, 0.94, 0, 0.028, 4);
    m.prism(s * 0.36, -0.12, [[0, 0.10, 0.10], [0.03, 0.08, 0.08]]);
    m.prism(s * 0.36, 0.12, [[0, 0.10, 0.10], [0.03, 0.08, 0.08]]);
  }
  m.tubeBetween(-0.34, 0.30, 0, 0.34, 0.30, 0, 0.022, 4);
  m.col(P.ALUMINIUM);
  m.oct(0, 0, [[0.94, 0.78, 0.16, 0.02], [1.62, 0.78, 0.16, 0.02]], { capTop: true });
  // Left half: a closed door with a hinge line, escutcheon and pull.
  m.col(0x9aa09c); decal(m, -0.19, 1.26, 0.082, 0.36, 0.60);
  m.col(P.STEEL_DARK);
  for (const y of [1.02, 1.26, 1.50]) decal(m, -0.365, y, 0.084, 0.03, 0.08);
  decal(m, -0.03, 1.26, 0.084, 0.03, 0.09);
  m.col(P.CHROME).tubeBetween(-0.05, 1.26, 0.086, -0.05, 1.26, 0.11, 0.014, 4, true);
  // Right half: open, showing hooks and fobs.
  m.col(0x2a2f3a); decal(m, 0.19, 1.26, 0.082, 0.36, 0.60);
  m.col(P.CHROME);
  for (let k = 0; k < 8; k++) {
    const x = 0.06 + (k % 4) * 0.09, y = 1.44 - Math.floor(k / 4) * 0.24;
    m.tubeBetween(x, y, 0.084, x, y - 0.03, 0.10, 0.010, 3);
    if (k % 2) {
      m.col([P.ACCENT_SUN, P.NEON_AQUA][k % 2 ? 0 : 1]);
      decal(m, x, y - 0.10, 0.104, 0.035, 0.09);
      m.col(P.CHROME);
    }
  }
  m.col(P.STEEL_DARK).board(0, 0.78, 1.62, -0.10, 1.72, 0.12, 0.05);
  m.col(P.SIGN_FACE); rake(m, -0.10, 0.24, 1.66, 0.01, 1.70, 0.08, 0.03);
  m.col(P.SIGN_DARK).prism(0, 0, [[1.72, 0.66, 0.06], [1.86, 0.66, 0.06]]);
  m.lit(P.NEON_AQUA, 1, 0.85);
  decal(m, 0, 1.79, 0.032, 0.54, 0.08);
  decal(m, 0, 1.79, 0.032, 0.54, 0.08, -1);
}

/**
 * Ash bin. Capped at both ends (it had an open top and a void at the base and
 * read as a length of ducting), with the parts that make it legible: an angled
 * stainless head with a crescent ash slot, a hinged door line and a lock barrel
 * on the body, a moulded base collar with two fixing bolts and a brand plate.
 */
function gCigBin(m) {
  m.col(P.BOLLARD_DARK).tube(0, 0, [[0, 0.215], [0.055, 0.20], [0.075, 0.175]], 6, { capTop: false });
  for (const s of [-1, 1]) {
    m.tube(s * 0.15, 0, [[0.05, 0.026], [0.07, 0.02]], 3, { capTop: true });
  }
  m.col(P.STEEL_DARK).tube(0, 0, [[0.075, 0.17], [0.90, 0.19]], 6, { capTop: false });
  m.col(0x5b6260); decal(m, 0, 0.48, 0.176, 0.20, 0.62);        // door line
  m.col(P.CHROME).tubeBetween(0.09, 0.48, 0.175, 0.09, 0.48, 0.20, 0.018, 4, true);
  m.col(P.ALUMINIUM);
  m.tube(0, 0, [[0.90, 0.205], [0.96, 0.20], [1.02, 0.155]], 6, { capTop: true });
  m.col(0x15181b).disc(0, 1.005, 0.05, 0.085, 5);
  m.col(P.SIGN_FACE).prism(0, 0.178, [[0.70, 0.14, 0.012], [0.76, 0.14, 0.012]]);
}

/**
 * Illuminated blade sign. It carried NO CONTENT — 129 identical blank hot-pink
 * rectangles, when the entire job of the object is to name a bar. It now has
 * five chunky channel letters standing 3 cm proud on a dark panel, a neon tube
 * frame round the perimeter, a visible dark return so it reads as a box, two
 * bracket gussets at the pole, a transformer box and a row of chase bulbs.
 */
function gLightboxSign(m) {
  m.col(P.STEEL_DARK);
  m.oct(0, 0, [[0, 0.56, 0.48, 0.04], [0.10, 0.48, 0.40, 0.04]], { capTop: false });
  m.col(P.SIGN_POLE).tube(0, 0, [[0.10, 0.10], [1.62, 0.09]], 6);
  m.col(P.STEEL_DARK).prism(0, 0, [[0.72, 0.24, 0.20], [1.02, 0.24, 0.20]]);   // transformer
  for (const s of [-1, 1]) {
    m.col(P.SIGN_POLE).tubeBetween(s * 0.06, 1.62, 0, s * 0.30, 1.80, 0, 0.030, 4);
  }
  m.col(P.SIGN_DARK).prism(0, 0, [[1.62, 0.86, 0.26], [1.72, 0.90, 0.30],
    [3.24, 0.90, 0.30], [3.34, 0.86, 0.26]]);
  m.lit(P.NEON_PINK, 1, 1.0);
  for (const s of [1, -1]) {
    const z = s * 0.152;
    // Neon tube frame, then five channel letters standing proud of the panel.
    decal(m, 0, 3.20, z, 0.80, 0.045, s);
    decal(m, 0, 1.76, z, 0.80, 0.045, s);
    decal(m, -0.385, 2.48, z, 0.045, 1.44, s);
    decal(m, 0.385, 2.48, z, 0.045, 1.44, s);
  }
  m.lit(P.NEON_WHITE, 1, 1.05);
  for (let k = 0; k < 5; k++) {
    const y = 2.98 - k * 0.28;
    m.prism(0, 0, [[y - 0.10, 0.44 - (k % 2) * 0.10, 0.33], [y + 0.10, 0.44 - (k % 2) * 0.10, 0.33]]);
  }
  m.lit(P.NEON_YELLOW, 1, 1.0);
  for (let k = 0; k < 6; k++) {
    const y = 1.86 + k * 0.26;
    for (const s of [-1, 1]) m.tube(s * 0.42, 0, [[y, 0.035], [y + 0.05, 0.03]], 4, { capTop: true });
  }
  m.lit(P.NEON_AQUA, 1, 1.0).prism(0, 0, [[3.34, 0.90, 0.28], [3.44, 0.86, 0.24]]);
}

/**
 * Outdoor bar. Ten vertical timber battens with visible gaps and varied tone
 * across the front — that alone converts a box into a bar — a brass foot rail
 * on brackets, a counter that overhangs 8 cm on the customer side with a
 * bullnose in a contrasting dark stone, and a back-bar gantry of two shelves
 * carrying twelve bottles at mixed heights plus a row of hanging stemware.
 */
function gOutdoorBar(m) {
  m.col(0x5f4630).prism(0, 0, [[0, 2.62, 0.74], [0.06, 2.66, 0.78]]);
  m.col(P.WOOD_DARK).prism(0, 0, [[0.06, 2.66, 0.78], [1.02, 2.66, 0.78]], { capTop: false });
  const tones = [P.WOOD_DARK, 0x9a7048, 0x7d5c38, P.TEAK];
  for (let k = 0; k < 10; k++) {
    m.col(tones[k % 4]);
    m.prism(-1.17 + k * 0.26, 0.40, [[0.08, 0.20, 0.04], [1.00, 0.20, 0.04]]);
  }
  m.col(P.ACCENT_SUN);
  m.tubeBetween(-1.10, 0.20, 0.46, 1.10, 0.20, 0.46, 0.028, 5);
  for (const s of [-1, 1]) m.tubeBetween(s * 1.00, 0.20, 0.39, s * 1.00, 0.20, 0.46, 0.022, 4);
  m.col(0x30363a).prism(0, 0.06, [[1.02, 2.84, 0.98], [1.06, 2.86, 1.00], [1.10, 2.82, 0.96]]);
  m.lit(P.NEON_AQUA, 1, 0.85).prism(0, 0, [[0, 2.62, 0.75], [0.06, 2.62, 0.75]]);
  // Back-bar gantry: two shelves, mixed bottles, hanging stemware.
  m.col(P.STEEL_DARK);
  m.prism(0, -0.42, [[1.10, 2.24, 0.26], [1.14, 2.24, 0.26]]);
  m.prism(0, -0.42, [[1.44, 2.20, 0.24], [1.48, 2.20, 0.24]]);
  for (const s of [-1, 1]) m.tubeBetween(s * 1.06, 1.10, -0.42, s * 1.06, 1.80, -0.42, 0.028, 4);
  m.prism(0, -0.42, [[1.76, 2.20, 0.20], [1.80, 2.20, 0.20]]);
  const glass = [P.GLASS_MINT, P.TERRACOTTA, P.STUCCO_BUTTER, P.GLASS_TEAL, 0x8c1a2c, P.FLOWER_WHITE];
  for (let k = 0; k < 12; k++) {
    m.col(glass[k % 6]);
    const y = k < 6 ? 1.14 : 1.48;
    const x = -0.95 + (k % 6) * 0.38;
    m.tube(x, -0.42, [[y, 0.062], [y + 0.16 + (k % 3) * 0.04, 0.05], [y + 0.24 + (k % 3) * 0.04, 0.022]],
      5, { capTop: true });
  }
  m.col(P.GLASS_MINT);
  for (let k = 0; k < 5; k++) {
    m.tube(-0.60 + k * 0.30, -0.42, [[1.62, 0.02], [1.70, 0.075]], 5, { capTop: false });
  }
}

/**
 * DJ booth. The lit front is recessed 4 cm behind a frame so the glow has a
 * hard edge instead of floating, there is a black mesh grille band under the
 * counter, and the top carries two turntables with platters and tone arms, a
 * mixer with a fader strip and a laptop on a stand — plus a coiled cable off
 * the back to the floor.
 */
function gDjBooth(m) {
  m.col(P.SIGN_DARK);
  m.oct(0, 0, [[0, 1.88, 0.76, 0.05], [0.08, 1.80, 0.68, 0.05],
    [1.04, 1.80, 0.68, 0.05]], { capTop: false });
  m.col(0x15181b).prism(0, 0.325, [[0.14, 1.62, 0.03], [0.96, 1.62, 0.03]]);
  m.lit(P.NEON_PURPLE, 1, 1.0); decal(m, 0, 0.55, 0.345, 1.54, 0.74);
  m.col(0x1b1f26);
  for (let k = 0; k < 6; k++) decal(m, 0, 0.99 - k * 0.022, 0.352, 1.66, 0.012);
  m.col(P.STEEL_DARK).prism(0, 0, [[1.04, 1.90, 0.78], [1.08, 1.92, 0.80], [1.12, 1.86, 0.74]]);
  for (const s of [-1, 1]) {
    m.col(0x2a2f3a).prism(s * 0.52, 0, [[1.12, 0.58, 0.44], [1.17, 0.54, 0.40]]);
    m.col(P.ALUMINIUM).tube(s * 0.52, 0, [[1.17, 0.17], [1.185, 0.17]], 8, { capTop: true });
    m.col(P.CHROME).tubeBetween(s * 0.52 + 0.20, 1.19, -0.14, s * 0.52 + 0.02, 1.19, 0.10, 0.012, 3);
  }
  m.col(0x1b1f26).prism(0, 0, [[1.12, 0.42, 0.30], [1.17, 0.40, 0.28]]);
  m.lit(P.NEON_AQUA, 1, 0.9); decal(m, 0, 1.172, 0.02, 0.34, 0.05);
  m.col(0x30363a).board(0, 0.36, 1.14, -0.20, 1.40, -0.30, 0.02);
  m.lit(P.SIGN_FACE, 1, 0.7); rake(m, 0, 0.32, 1.16, -0.21, 1.38, -0.295, 0.014);
  m.col(0x15181b);
  m.tubeBetween(0.70, 1.06, -0.36, 0.78, 0.60, -0.44, 0.020, 3);
  m.tubeBetween(0.78, 0.60, -0.44, 0.70, 0.04, -0.52, 0.020, 3);
}

/**
 * PA stack. Two trapezoidal cabinets raked 8 degrees with a joint line between
 * them, on a wheeled dolly rather than a plain plinth: recessed grille with a
 * clear value break, two round driver bosses proud of it, a horn above them,
 * handles on both flanks, rubber feet and a lighter trim edge.
 */
function gSpeakerStack(m) {
  m.col(P.STEEL_DARK).prism(0, 0, [[0.06, 0.64, 0.60], [0.10, 0.56, 0.52]]);
  m.col(0x15181b);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    m.tube(sx * 0.22, sz * 0.20, [[0, 0.055], [0.06, 0.055]], 5, { capTop: true });
  }
  for (let box = 0; box < 2; box++) {
    const y0 = 0.10 + box * 0.68;
    m.col(P.SIGN_DARK);
    m.prism(0, -0.02, [[y0, 0.50, 0.44], [y0 + 0.03, 0.52, 0.46],
      [y0 + 0.61, 0.50, 0.42], [y0 + 0.64, 0.46, 0.38]]);
    m.col(0x9aa0a0);
    m.prism(0, -0.02, [[y0 + 0.63, 0.52, 0.46], [y0 + 0.655, 0.50, 0.44]]);
    m.col(0x14161a);
    m.board(0, 0.44, y0 + 0.04, 0.205, y0 + 0.60, 0.165, 0.025);
    m.col(0x2c3238);
    for (const r of [0.32, 0.60]) {
      m.tube(0, 0.21 - (r - 0.32) * 0.14, [[y0 + r * 0.5 + 0.06, 0.11], [y0 + r * 0.5 + 0.075, 0.10]],
        6, { capTop: true });
    }
    m.col(0x1b1f26).prism(0, 0.19, [[y0 + 0.44, 0.34, 0.03], [y0 + 0.56, 0.34, 0.03]]);
    m.col(0x15181b);
    for (const s of [-1, 1]) m.prism(s * 0.26, -0.02, [[y0 + 0.30, 0.03, 0.20], [y0 + 0.36, 0.03, 0.20]]);
  }
}

/* -- storefront dressing -------------------------------------------------- */

/**
 * Rolling clothes rail. Castors, a lower shelf of folded stock, six shaped
 * garments on visible hangers at uneven lengths and hang angles with one turned
 * outward, and a price card on the end — four flat vertical cards on a bare
 * goalpost read as a flag stand.
 */
function gClothesRail(m) {
  m.col(P.STEEL);
  for (const s of [-1, 1]) {
    m.tubeBetween(s * 0.52, 0.07, -0.28, s * 0.52, 0.07, 0.28, 0.026, 4);
    m.tubeBetween(s * 0.52, 0.07, 0, s * 0.52, 1.48, 0, 0.028, 5);
    m.col(P.STEEL_DARK);
    for (const sz of [-1, 1]) {
      m.tube(s * 0.52, sz * 0.28, [[0.03, 0.045], [0.07, 0.04]], 5, { capTop: true });
      m.tube(s * 0.52, sz * 0.28, [[0, 0.05], [0.03, 0.05]], 5);
    }
    m.col(P.STEEL);
  }
  m.tubeBetween(-0.54, 1.48, 0, 0.54, 1.48, 0, 0.024, 5);
  m.tubeBetween(-0.52, 0.34, 0, 0.52, 0.34, 0, 0.020, 4);
  m.col(P.WOOD_LIGHT).prism(0, 0, [[0.34, 0.96, 0.40], [0.38, 0.96, 0.40]]);
  m.col(P.FABRIC_AQUA).prism(-0.22, 0, [[0.38, 0.32, 0.28], [0.50, 0.30, 0.26]]);
  m.col(P.FABRIC_SUN).prism(0.20, 0.03, [[0.38, 0.30, 0.26], [0.47, 0.28, 0.24]]);
  const cols = [P.FABRIC_SKY, P.FABRIC_CORAL, P.FABRIC_LIME, P.FABRIC_PINK,
    P.FABRIC_WHITE, P.FABRIC_AQUA];
  for (let k = 0; k < 6; k++) {
    garment(m, -0.42 + k * 0.17, 1.48, (k === 3 ? 0.10 : 0) + (k % 2 ? 0.03 : -0.03),
      0.50 + (k % 3) * 0.10, cols[k], (k % 2 ? 1 : -1) * (1 + (k % 3)));
  }
  m.col(P.SIGN_FACE).prism(0.52, 0.14, [[1.28, 0.02, 0.18], [1.44, 0.02, 0.18]]);
  m.col(P.NEON_PINK).prism(0.522, 0.14, [[1.36, 0.01, 0.14], [1.40, 0.01, 0.14]]);
}

/**
 * Greengrocer display. The goods were six 5-segment cones in three flat colours
 * — traffic cones on a ramp. Each is now a shallow slatted tray of eight
 * overlapping fruit at two sizes, with a chalk price card on a wire above it, a
 * slatted back board behind the top shelf and a short striped awning over it.
 */
function gProduceStand(m) {
  m.col(P.WOOD_DARK);
  for (const s of [-1, 1]) {
    m.board(s * 0.62, 0.10, 0.02, -0.42, 1.02, 0.30, 0.09);
    m.beam(s * 0.62, 0.10, -0.40, s * 0.62, 0.62, 0.20, 0.06, 0.05, false);
  }
  m.col(P.WOOD_LIGHT);
  m.board(0, 1.24, 0.42, -0.34, 0.52, 0.10, 0.05);
  m.board(0, 1.24, 0.74, -0.10, 1.00, 0.24, 0.05);
  m.col(P.WOOD_DECK);
  for (let k = 0; k < 4; k++) {
    m.prism(0, -0.44 + k * 0.05, [[1.02 + k * 0.10, 1.20, 0.035], [1.08 + k * 0.10, 1.20, 0.035]]);
  }
  const sets = [
    [-0.38, 0.50, 0.24, [P.FLOWER_ORANGE, 0xff8a2a]],
    [0.00, 0.52, 0.20, [P.CAR_LIME, P.GRASS_LIGHT]],
    [0.38, 0.50, 0.24, [P.HYDRANT_RED, 0xd9382c]],
    [-0.38, 0.86, 0.10, [P.FLOWER_YELLOW, P.STUCCO_BUTTER]],
    [0.00, 0.88, 0.06, [0x8a5aa8, P.FLOWER_MAGENTA]],
    [0.38, 0.86, 0.10, [P.GRASS_LIGHT, P.CAR_LIME]],
  ];
  for (const [x, y, z, hexes] of sets) {
    m.col(P.WOOD_LIGHT);
    m.prism(x, z - 0.02, [[y - 0.05, 0.34, 0.26], [y, 0.36, 0.28]], { capTop: false });
    berries(m, x, y - 0.02, z - 0.02, 0.052, 0.115, 7, hexes);
    m.col(P.SIGN_DARK).prism(x, z - 0.14, [[y + 0.16, 0.16, 0.012], [y + 0.28, 0.16, 0.012]]);
    m.col(P.SIGN_FACE); decal(m, x, y + 0.22, z - 0.147, 0.11, 0.03, -1);
    m.col(P.STEEL_DARK).tubeBetween(x, y + 0.16, z - 0.14, x, y + 0.02, z - 0.10, 0.008, 3);
  }
  // Striped awning over the top shelf.
  for (let k = 0; k < 6; k++) {
    m.col(k % 2 ? P.FABRIC_CORAL : P.FABRIC_WHITE);
    m.board(-0.55 + k * 0.22, 0.21, 1.26, -0.44, 1.14, -0.02, 0.04);
  }
}

/**
 * Market flower stand. There was no stand — two planks leaning at 60 degrees
 * against nothing, with three smooth capsules on sticks behind them. This is an
 * A-frame with two slatted shelves, six galvanised buckets with darker rim
 * bands, loose bunches of short stems topped with three-tier bloom cones at
 * jittered heights, a chalk price board on the front rail and a striped valance.
 */
function gFlowerStand(m) {
  m.col(P.WOOD_DARK);
  for (const s of [-1, 1]) {
    m.beam(s * 0.56, 0, -0.30, s * 0.56, 1.02, 0.06, 0.075, 0.075, false);
    m.beam(s * 0.56, 0, 0.30, s * 0.56, 1.02, 0.06, 0.075, 0.075, false);
    m.beam(s * 0.56, 0.42, -0.20, s * 0.56, 0.42, 0.20, 0.06, 0.05, false);
  }
  for (const [y, dz] of [[0.55, 0.10], [0.95, 0.02]]) {
    m.col(P.WOOD_LIGHT);
    slats(m, 0, dz, y, 1.18, 4, 0.10, 0.02, 0.035, [P.WOOD_LIGHT, 0xd0aa7c]);
    m.col(P.WOOD_DARK);
    m.prism(0, dz + 0.24, [[y, 1.22, 0.05], [y + 0.07, 1.22, 0.05]]);
  }
  const blooms = [P.FLOWER_MAGENTA, P.FLOWER_YELLOW, P.FLOWER_WHITE, P.FLOWER_ORANGE,
    P.FLOWER_PINK, P.FLOWER_MAGENTA];
  for (let k = 0; k < 6; k++) {
    const x = -0.38 + (k % 3) * 0.38, y = k < 3 ? 0.585 : 0.985;
    const z = (k < 3 ? 0.10 : 0.02) - 0.02;
    m.col(P.ALUMINIUM).tube(x, z, [[y, 0.11], [y + 0.26, 0.13]], 5, { capTop: false });
    m.col(0x9aa09c).tube(x, z, [[y + 0.26, 0.135], [y + 0.29, 0.13]], 5);
    m.col(P.GRASS_LIGHT);
    for (let s = 0; s < 4; s++) {
      const a = (s / 4) * TAU + k;
      m.tubeBetween(x, y + 0.24, z, x + Math.cos(a) * 0.07, y + 0.40 + (s % 2) * 0.05,
        z + Math.sin(a) * 0.07, 0.012, 3);
    }
    m.col(blooms[k]);
    const h = y + 0.40 + (k % 3) * 0.05;
    m.tube(x, z, [[h, 0.14], [h + 0.09, 0.16], [h + 0.17, 0.11], [h + 0.24, 0.04]], 5,
      { capTop: true });
  }
  m.col(P.SIGN_DARK).board(0, 0.30, 0.34, 0.30, 0.56, 0.24, 0.03);
  m.col(P.SIGN_FACE);
  rake(m, 0, 0.24, 0.40, 0.288, 0.44, 0.283, 0.02);
  rake(m, -0.03, 0.16, 0.48, 0.283, 0.51, 0.279, 0.02);
  for (let k = 0; k < 6; k++) {
    m.col(k % 2 ? P.FABRIC_CORAL : P.FABRIC_WHITE);
    m.prism(-0.50 + k * 0.20, 0.28, [[1.02, 0.18, 0.04], [1.20, 0.18, 0.04]]);
  }
}

/**
 * Shrink-wrapped delivery on its pallet. The pallet underneath was already
 * good; the load was one blank block with a strap. It is now six cartons in a
 * 3x2 stack with deliberately uneven edges, wrapped in a pale sheet that
 * follows the stepped silhouette rather than smoothing it, two straps crossing
 * at 90 degrees and a shipping label on the front face.
 */
function gDeliveryStack(m) {
  m.col(P.WOOD_LIGHT);
  slats(m, 0, 0, 0.10, 1.10, 4, 0.19, 0.035, 0.05, [P.WOOD_LIGHT, P.WOOD_DECK]);
  m.col(P.WOOD_DARK);
  for (const s of [-1, 0, 1]) m.prism(s * 0.44, 0, [[0, 0.18, 0.90], [0.10, 0.18, 0.90]]);
  const tones = [0xd9d2c2, 0xf0ece2, 0xc9b795];
  for (let k = 0; k < 6; k++) {
    const col = k % 3, row = Math.floor(k / 3);
    m.col(tones[(k + row) % 3]);
    m.prism(-0.30 + col * 0.30 + (row ? 0.03 : -0.02), (row ? -0.03 : 0.03),
      [[0.15 + row * 0.40, 0.30, 0.74], [0.53 + row * 0.40, 0.29, 0.72]]);
  }
  // Wrap: a pale sheet following the stepped silhouette.
  m.col(0xdde2dc, 1.04);
  m.prism(0, 0.02, [[0.16, 0.98, 0.80], [0.54, 0.96, 0.78]], { capTop: false });
  m.prism(0, -0.02, [[0.54, 0.99, 0.80], [0.93, 0.94, 0.76], [0.97, 0.86, 0.68]]);
  m.col(P.SIGN_BLUE);
  m.prism(0, 0, [[0.52, 1.02, 0.84], [0.60, 1.02, 0.84]]);
  m.xform(Math.PI / 2, 0, 0, 0);
  m.prism(0, 0, [[0.70, 0.86, 0.98], [0.78, 0.86, 0.98]]);
  m.reset();
  m.col(P.SIGN_FACE); decal(m, 0, 0.76, 0.402, 0.26, 0.18);
  m.col(P.SIGN_DARK); decal(m, 0, 0.82, 0.404, 0.20, 0.03);
}

/* -- kerbside clutter ----------------------------------------------------- */

/**
 * Commercial skip. Sloped front face, four pressed ribs a side, fork pockets
 * across the bottom, a lifting bar at each end, four castors, two lid leaves
 * with visible hinge barrels and grab handles — one of them left half open —
 * a hauler name stencilled on the flank and a scraped band along the top edge.
 */
function gDumpster(m) {
  m.col(0x2b2f33);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      m.tubeBetween(sx * 0.92 - 0.06, 0.10, sz * 0.52, sx * 0.92 + 0.06, 0.10, sz * 0.52, 0.10, 6, true);
    }
  }
  m.col(0x3a4046);
  for (const sz of [-1, 1]) m.prism(0, sz * 0.42, [[0.14, 2.10, 0.22], [0.24, 2.10, 0.22]]);
  m.col(0xf0f0f0);
  m.prism(0, 0, [[0.20, 2.16, 1.24], [0.28, 2.24, 1.28], [1.14, 2.58, 1.40]], { capTop: false });
  m.col(0xdedede);
  for (let k = 0; k < 4; k++) {
    const x = -0.86 + k * 0.58;
    for (const sz of [-1, 1]) decal(m, x, 0.68, sz * 0.68, 0.10, 0.80, sz);
  }
  m.col(0xbdbdbd).prism(0, 0, [[1.02, 2.54, 1.37], [1.10, 2.57, 1.39]]);
  m.col(0xe8e8e8).prism(0, 0, [[1.14, 2.52, 1.34], [1.19, 2.52, 1.34]]);
  // Lid leaves: one flat, one propped half open, with hinge barrels and grabs.
  m.col(0x3a4046);
  m.tubeBetween(-1.22, 1.20, 0, 1.22, 1.20, 0, 0.055, 5);
  m.col(0xdcdcdc);
  m.prism(0, -0.62, [[1.20, 2.44, 1.20], [1.25, 2.42, 1.18]]);
  m.board(0, 2.44, 1.22, 0.06, 1.72, 0.86, 0.06);
  m.col(0x3a4046);
  m.tubeBetween(-0.50, 1.24, -1.14, 0.50, 1.24, -1.14, 0.035, 4);
  m.tubeBetween(-0.50, 1.72, 0.88, 0.50, 1.72, 0.88, 0.035, 4);
  // Lifting bars at each end, and a stencilled hauler name.
  for (const s of [-1, 1]) {
    m.tubeBetween(s * 1.30, 0.62, -0.34, s * 1.30, 0.62, 0.34, 0.045, 5);
    m.tubeBetween(s * 1.22, 0.62, -0.34, s * 1.30, 0.62, -0.34, 0.035, 4);
    m.tubeBetween(s * 1.22, 0.62, 0.34, s * 1.30, 0.62, 0.34, 0.035, 4);
  }
  m.col(0x30363a);
  decal(m, -0.30, 0.72, 0.702, 0.86, 0.13);
  m.col(0x9aa0a0);
  decal(m, 0.62, 0.70, 0.702, 0.28, 0.09);
}

/**
 * Advertising bench. Slatted seat, and an ad panel that is DOUBLE-SIDED with a
 * bezel lip and real poster content on both faces — two colour blocks and a
 * headline bar, which is what advertising reads as from three metres. The old
 * one was blank navy from the street and lit only on the far side.
 */
function gBusBench(m) {
  m.col(0xd8d0be);
  for (const s of [-1, 1]) {
    m.prism(s * 0.84, 0, [[0, 0.20, 0.56], [0.05, 0.17, 0.52], [0.42, 0.16, 0.50], [0.45, 0.19, 0.53]]);
  }
  slats(m, 0, 0.02, 0.45, 1.80, 4, 0.10, 0.02, 0.05, [P.TEAK, 0xc08a52]);
  m.col(P.SIGN_DARK);
  m.prism(0, -0.24, [[0.50, 1.90, 0.10], [0.56, 1.94, 0.12], [1.10, 1.94, 0.12], [1.16, 1.90, 0.10]]);
  for (const s of [1, -1]) {
    const z = -0.24 + s * 0.062;
    m.lit(P.SIGN_FACE, 1, 0.55); decal(m, 0, 0.83, z, 1.72, 0.50, s);
    m.col(P.FABRIC_CORAL); decal(m, -0.48, 0.86, z + s * 0.004, 0.66, 0.40, s);
    m.col(P.NEON_AQUA); decal(m, 0.46, 0.94, z + s * 0.004, 0.62, 0.22, s);
    m.col(P.SIGN_DARK); decal(m, 0.46, 0.70, z + s * 0.004, 0.62, 0.10, s);
  }
}

/**
 * Pay-and-display machine. Recessed screen behind a chrome bezel, a keypad, a
 * card-reader lip, a coin funnel and a ticket slot with a shelf under it, a
 * printed instruction panel and a municipal logo block, every vertical edge
 * chamfered, a three-part value break and a solar panel on the canted top —
 * which is both correct for Miami and a strong silhouette cue from above.
 */
function gPayStation(m) {
  m.col(P.STEEL_DARK);
  m.oct(0, 0, [[0, 0.52, 0.46, 0.04], [0.09, 0.44, 0.38, 0.035],
    [0.60, 0.44, 0.38, 0.035]], { capTop: false });
  m.col(P.PARKING_METER);
  m.oct(0, 0, [[0.60, 0.50, 0.40, 0.04], [0.66, 0.54, 0.44, 0.04],
    [1.56, 0.52, 0.42, 0.04]], { capTop: false });
  m.col(P.ALUMINIUM); borderBoth(m, 0, 1.28, 0.215, 0.30, 0.22, 0.02);
  m.lit(P.NEON_AQUA, 1, 0.9); decal(m, 0, 1.28, 0.216, 0.26, 0.18);
  m.col(0x30363a);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) decal(m, -0.10 + c * 0.068, 1.06 + r * 0.05, 0.213, 0.05, 0.03);
  }
  m.col(0x15181b);
  decal(m, 0.14, 1.14, 0.213, 0.03, 0.06);
  decal(m, -0.02, 0.86, 0.213, 0.22, 0.025);
  m.col(P.ALUMINIUM);
  m.prism(-0.02, 0.20, [[0.80, 0.26, 0.05], [0.84, 0.25, 0.05]]);
  m.tube(0.14, 0.20, [[0.94, 0.045], [0.97, 0.04]], 5, { capTop: true });
  m.col(P.SIGN_BLUE); decal(m, 0, 1.46, 0.213, 0.36, 0.10);
  m.col(P.SIGN_FACE); decal(m, 0, 1.46, 0.215, 0.28, 0.03);
  m.col(P.SIGN_DARK).board(0, 0.54, 1.56, -0.18, 1.70, 0.18, 0.05);
  m.col(0x2a3a4a); rake(m, 0, 0.46, 1.575, -0.155, 1.685, 0.155, 0.03);
}

/**
 * Wayfinding totem. The blank white lightbox is now an information layout: a
 * coloured header band, a dark map over the upper two thirds with four route
 * lines, and three directional arrow blades that project 5 cm proud of the body
 * edge — that projection is what makes a totem read as wayfinding from the
 * NARROW side too, where the old one was just a dark monolith. Top chamfered
 * into a wedge, stainless kick plate, and the panel emissive dropped so it
 * stops reading as a lightbox at noon.
 */
function gWayfindTotem(m) {
  m.col(P.CONCRETE_DARK).prism(0, 0, [[0, 0.64, 0.42], [0.09, 0.56, 0.34]]);
  m.col(P.ALUMINIUM).prism(0, 0, [[0.09, 0.54, 0.32], [0.22, 0.54, 0.32]]);
  m.col(P.SIGN_DARK);
  m.oct(0, 0, [[0.22, 0.52, 0.30, 0.04], [2.58, 0.52, 0.30, 0.04],
    [2.82, 0.44, 0.22, 0.03]], { capTop: true });
  for (const s of [1, -1]) {
    const z = s * 0.152;
    m.lit(P.SIGN_FACE, 1, 0.35); decal(m, 0, 1.52, z, 0.40, 1.80, s);
    m.col(P.NEON_AQUA); decal(m, 0, 2.31, z + s * 0.004, 0.40, 0.22, s);
    m.col(0x2c3238); decal(m, 0, 1.72, z + s * 0.004, 0.36, 0.94, s);
    m.col(P.HYDRANT_RED); decal(m, -0.05, 1.90, z + s * 0.006, 0.24, 0.02, s);
    m.col(P.SIGN_BLUE); decal(m, 0.02, 1.64, z + s * 0.006, 0.28, 0.02, s);
    m.col(P.SIGN_GREEN); decal(m, -0.02, 1.46, z + s * 0.006, 0.30, 0.02, s);
    m.col(P.ACCENT_SUN); decal(m, 0.04, 2.02, z + s * 0.006, 0.20, 0.02, s);
  }
  // Directional blades, proud of the body on both edges.
  for (let k = 0; k < 3; k++) {
    const y = 0.86 + k * 0.19;
    m.col(k % 2 ? P.SIGN_BLUE : P.SIGN_GREEN);
    m.prism(0, 0, [[y, 0.62, 0.34], [y + 0.14, 0.62, 0.34]]);
    m.col(P.SIGN_FACE);
    for (const s of [1, -1]) decal(m, k % 2 ? 0.10 : -0.10, y + 0.07, s * 0.172, 0.24, 0.05, s);
  }
  m.lit(P.NEON_AQUA, 1, 0.9).prism(0, 0, [[2.44, 0.54, 0.32], [2.52, 0.54, 0.32]]);
}

/**
 * Corner newsstand. The awning is raked and striped with a valance hanging 20
 * cm below the front edge, a serving hatch is cut into the front with a counter
 * shelf and a rolled shutter above it, the signboard carries a masthead block
 * and two colour bars, and the magazine rack is a canted tier of nine covers.
 */
function gNewsKiosk(m) {
  m.col(P.CONCRETE_DARK).prism(0, 0, [[0, 2.12, 1.46], [0.10, 2.02, 1.36]]);
  m.col(P.NEWSSTAND);
  m.oct(0, 0, [[0.10, 1.96, 1.30, 0.08], [0.18, 2.00, 1.34, 0.08],
    [2.24, 2.00, 1.34, 0.08]], { capTop: false });
  m.col(0xa8402e);
  for (let k = 0; k < 6; k++) decal(m, -0.85 + k * 0.34, 1.20, 0.672, 0.05, 1.80);
  // Serving hatch: a recessed dark opening, a counter shelf, a rolled shutter.
  m.col(0x1b1f22).prism(0, 0.64, [[1.02, 1.10, 0.05], [1.72, 1.10, 0.05]]);
  m.col(P.ALUMINIUM).prism(0, 0.78, [[0.98, 1.16, 0.30], [1.03, 1.16, 0.30]]);
  m.col(0x9aa0a0).tubeBetween(-0.56, 1.78, 0.70, 0.56, 1.78, 0.70, 0.085, 6, true);
  m.col(P.SIGN_DARK).prism(0, 0.685, [[1.86, 1.60, 0.03], [2.16, 1.60, 0.03]]);
  m.lit(P.LAMP_GLOW, 1, 0.8); decal(m, -0.28, 2.01, 0.703, 0.90, 0.16);
  m.col(P.NEON_AQUA); decal(m, 0.50, 2.05, 0.703, 0.42, 0.08);
  m.col(P.ACCENT_SUN); decal(m, 0.50, 1.94, 0.703, 0.42, 0.06);
  // Raked striped awning with a valance.
  for (let k = 0; k < 8; k++) {
    m.col(k % 2 ? P.FABRIC_CORAL : P.FABRIC_WHITE);
    m.board(-0.98 + k * 0.28, 0.28, 2.22, -0.30, 2.02, 1.02, 0.05);
    m.prism(-0.98 + k * 0.28, 1.02, [[1.82, 0.28, 0.05], [2.02, 0.28, 0.05]]);
  }
  // Canted tiered magazine rack, nine covers in two rows.
  m.col(P.WOOD_DARK).board(0, 1.70, 0.10, 0.72, 0.92, 1.10, 0.08);
  const covers = [P.FABRIC_SKY, P.FABRIC_SUN, P.FABRIC_PINK, P.FABRIC_LIME, P.FABRIC_AQUA];
  for (let k = 0; k < 9; k++) {
    const row = Math.floor(k / 5), col = k % 5;
    const x = -0.62 + col * 0.31 + row * 0.15;
    const y0 = row ? 0.62 : 0.30, y1 = row ? 0.86 : 0.56;
    const z0 = row ? 0.92 : 1.04, z1 = row ? 0.80 : 0.92;
    m.col(covers[(k + row) % 5]);
    m.board(x, 0.26, y0, z0, y1, z1, 0.025);
    m.col(P.SIGN_DARK);
    rake(m, x, 0.24, y1 - 0.05, z1 + 0.01, y1, z1, 0.016);
  }
  m.col(0xd9d2c2).prism(0.80, 0.98, [[0, 0.36, 0.28], [0.14, 0.34, 0.26]]);
}

/**
 * Site fence panel. The defining feature of a site fence is that you can SEE
 * THROUGH it and the infill was a solid aluminium slab. The mesh is now nine
 * vertical and six horizontal 20 mm bars welded inside a round 40 mm frame with
 * radiused corners, on moulded concrete feet with a lifting slot and post
 * sockets, plus orange clamp couplers at the post positions.
 */
function gMeshFence(m) {
  m.col(P.CONCRETE_DARK);
  for (const s of [-1, 1]) {
    m.prism(s * 0.92, 0, [[0, 0.46, 0.38], [0.05, 0.44, 0.36], [0.12, 0.38, 0.30]]);
    m.col(0x9a9280); decal(m, s * 0.92, 0.07, 0.152, 0.18, 0.04);
    m.col(0x6f6a5e);
    for (const sz of [-1, 1]) m.tube(s * 0.92, sz * 0.10, [[0.11, 0.055], [0.13, 0.05]], 5, { capTop: true });
    m.col(P.CONCRETE_DARK);
  }
  m.col(P.STEEL);
  for (const s of [-1, 1]) m.tubeBetween(s * 0.98, 0.10, 0, s * 0.98, 1.94, 0, 0.040, 6);
  m.tubeBetween(-0.98, 1.94, 0, 0.98, 1.94, 0, 0.040, 6);
  m.tubeBetween(-0.98, 0.16, 0, 0.98, 0.16, 0, 0.036, 5);
  m.col(0x9aa4a2);
  for (let k = 0; k < 9; k++) {
    const x = -0.78 + k * 0.195;
    m.tubeBetween(x, 0.18, 0, x, 1.92, 0, 0.011, 3);
  }
  for (let k = 0; k < 6; k++) {
    const y = 0.42 + k * 0.29;
    m.tubeBetween(-0.96, y, 0, 0.96, y, 0, 0.011, 3);
  }
  m.col(P.BARRIER_ORANGE);
  for (const s of [-1, 1]) {
    for (const y of [0.62, 1.60]) m.tube(s * 0.98, 0, [[y, 0.065], [y + 0.11, 0.062]], 5);
  }
  m.col(P.SIGN_FACE).prism(0.42, 0.02, [[1.10, 0.34, 0.02], [1.50, 0.34, 0.02]]);
  m.col(P.SIGN_BLUE); decal(m, 0.42, 1.42, 0.031, 0.30, 0.06);
  m.col(P.SIGN_DARK);
  for (let k = 0; k < 3; k++) decal(m, 0.42, 1.30 - k * 0.06, 0.031, 0.26, 0.025);
}

/* -- park ----------------------------------------------------------------- */

/**
 * Teak bench. A teak bench is defined by its JOINERY, and this one had a solid
 * prism for a seat and a solid prism for a back. Five seat boards and three
 * back boards with gaps, rounded arm ends, and brass bolt heads at every
 * board-to-frame junction.
 */
function gBenchTeak(m) {
  slats(m, 0, 0.02, 0.42, 1.68, 5, 0.088, 0.018, 0.05, [0xffffff, 0xe8dcc6]);
  for (let k = 0; k < 3; k++) {
    m.col(k % 2 ? 0xe8dcc6 : 0xffffff);
    const t = k / 2;
    m.board(0, 1.68, 0.54 + t * 0.30, -0.21 - t * 0.055, 0.60 + t * 0.30, -0.235 - t * 0.055, 0.048);
  }
  m.col(0x7a5636);
  for (const s of [-1, 1]) {
    const x = s * 0.78;
    m.prism(x, 0, [[0, 0.13, 0.52], [0.03, 0.11, 0.48]]);
    m.tubeBetween(x, 0.02, 0.20, x, 0.42, 0.185, 0.048, 4);
    m.tubeBetween(x, 0.02, -0.20, x, 0.50, -0.195, 0.048, 4);
    m.tubeBetween(x, 0.50, -0.20, x, 0.66, -0.24, 0.045, 4);
    m.tubeBetween(x, 0.66, -0.24, x, 0.70, 0.20, 0.045, 4);
    m.tubeBetween(x, 0.70, 0.20, x, 0.68, 0.26, 0.045, 4, true);
    m.tubeBetween(x, 0.47, 0.20, x, 0.70, 0.20, 0.040, 4);
  }
  m.tubeBetween(-0.78, 0.18, 0, 0.78, 0.18, 0, 0.032, 4);
  m.col(P.ACCENT_SUN);
  for (const s of [-1, 1]) {
    for (const z of [-0.20, -0.10, 0, 0.10, 0.20]) m.plate(s * 0.78, 0.471, z, 0.035, 0.035);
  }
}

/**
 * Chess table. The board was a plain navy square, which removed the only reason
 * the object exists — the chequer is now an 8x8 alternating grid inlaid inside
 * a raised precast border. A fluted stem, weathered tone bands, and two capped
 * stools with domed seats on tapered stems (all three of which rendered as
 * hollow open shells before the capTop fix).
 */
function gChessTable(m) {
  m.col(0xd8d0be).tube(0, 0, [[0, 0.32], [0.06, 0.30], [0.10, 0.24]], 8, { capTop: false });
  m.col(0xf2ece0);
  m.tube(0, 0, [[0.10, 0.22], [0.30, 0.20], [0.60, 0.21], [0.66, 0.26]], 6,
    { cols: [0xe8e0ce, 0xf2ece0, 0xe8e0ce] });
  m.tube(0, 0, [[0.66, 0.54], [0.70, 0.56], [0.745, 0.55]], 8, { capTop: true });
  // Inlaid chequer: 64 quads, and it is the whole point of the object.
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      m.col((r + c) % 2 ? 0x2a2f3a : 0xf6f0e2);
      m.plate(-0.28 + c * 0.08, 0.748, -0.28 + r * 0.08, 0.078, 0.078);
    }
  }
  m.col(0xcfc6b0);
  for (const s of [-1, 1]) {
    m.tube(s * 0.86, 0, [[0, 0.22], [0.05, 0.20], [0.09, 0.15]], 6, { capTop: false });
    m.tube(s * 0.86, 0, [[0.09, 0.14], [0.36, 0.13], [0.42, 0.17]], 5, { capTop: false });
    m.tube(s * 0.86, 0, [[0.42, 0.26], [0.46, 0.275], [0.50, 0.255]], 8, { capTop: true });
  }
}

/**
 * Park barbecue. The grate is now SEVEN parallel bars across the firebox rather
 * than one dark plate, with a swing handle on the lid, height-adjustment
 * notches cut into the post, an ash-pan lip under the firebox, a concrete
 * footing pad, and a sooty gradient up the inner walls — a park grill that has
 * never been used is the tell.
 */
function gBbqGrill(m) {
  m.col(P.CONCRETE_DARK).prism(0, 0, [[0, 0.42, 0.42], [0.05, 0.36, 0.36]]);
  m.col(P.STEEL_DARK).prism(0, 0, [[0.05, 0.26, 0.26], [0.10, 0.20, 0.20], [0.76, 0.18, 0.18]]);
  m.col(0x59615f);
  for (let k = 0; k < 5; k++) decal(m, 0, 0.24 + k * 0.11, 0.101, 0.10, 0.02);
  m.col(0x3a332c);
  m.prism(0, 0, [[0.72, 0.80, 0.54], [0.78, 0.84, 0.58], [0.96, 0.86, 0.60]], { capTop: false });
  m.col(0x241f19).disc(0, 0.80, 0, 0.34, 4, Math.PI / 4);
  m.col(P.STEEL_DARK).prism(0, 0, [[0.68, 0.86, 0.60], [0.72, 0.82, 0.56]]);
  m.col(0x9aa0a0);
  for (let k = 0; k < 7; k++) {
    const z = -0.21 + k * 0.07;
    m.tubeBetween(-0.38, 0.955, z, 0.38, 0.955, z, 0.016, 3);
  }
  m.col(P.ALUMINIUM).board(0, 0.82, 0.98, -0.30, 1.30, -0.14, 0.05);
  m.col(P.STEEL_DARK);
  m.tubeBetween(-0.14, 1.16, -0.20, 0.14, 1.16, -0.20, 0.020, 4);
  m.tubeBetween(-0.14, 1.16, -0.20, -0.14, 1.10, -0.24, 0.016, 3);
  m.tubeBetween(0.14, 1.16, -0.20, 0.14, 1.10, -0.24, 0.016, 3);
}

/**
 * Square-potted topiary. Pot with a proud rolled rim, a reveal band and a base
 * plinth; a tapered leaning trunk with two pruning stubs and bark shading; and
 * a ball built as an inner dome under a scatter of overlapping leaf clumps, so
 * the silhouette is lumpy rather than a six-facet gem.
 */
function gPottedFicus(m) {
  m.prism(0, 0, [
    [0, 0.80, 0.80], [0.06, 0.72, 0.72], [0.52, 0.70, 0.70],
    [0.60, 0.675, 0.675], [0.66, 0.72, 0.72], [0.74, 0.84, 0.84], [0.80, 0.82, 0.82],
  ], { capTop: false, cols: [0xb4a890, 0xf6f2e8, 0xece6d8, 0xf2ece0, 0xfaf6ec, 0xece6d8] });
  m.col(P.MULCH).plate(0, 0.68, 0, 0.64, 0.64);
  m.col(P.PALM_TRUNK_DARK);
  m.tube(0, 0, [[0.66, 0.098], [0.98, 0.086]], 5, { cols: [0x6e5436] });
  m.tube(0.03, 0.01, [[0.98, 0.082], [1.32, 0.070]], 5);
  m.tubeBetween(0.02, 1.04, 0, 0.14, 1.12, 0.04, 0.024, 3, true);
  m.tubeBetween(0.01, 0.88, 0, -0.10, 0.96, -0.04, 0.022, 3, true);
  m.col(P.TREE_CANOPY_DARK);
  m.tube(0.04, 0.01, [[0.96, 0.30], [1.20, 0.40], [1.52, 0.26]], 6, { capTop: true });
  bush(m, 0.04, 1.02, 0.01, 0.44, P.TREE_CANOPY, P.TREE_CANOPY_LIGHT, 5, 3, 1.05);
}

/**
 * Cast-stone urn. A rolled rim torus at the bowl lip and a matching foot ring
 * where the bowl meets the plinth — two rings, and they are what make cast
 * stone read as cast stone — eight shallow flutes cut into the bowl as
 * alternating facet tone (free relief), the plinth stepped into two courses,
 * and the blooms pushed out over the rim so they trail.
 */
function gPlanterUrn(m) {
  m.prism(0, 0, [[0, 0.60, 0.60], [0.06, 0.55, 0.55], [0.13, 0.53, 0.53], [0.18, 0.48, 0.48]],
    { cols: [0xb4a890, 0xf2ece0, 0xece6d8] });
  // Foot ring, fluted ogee bowl, rolled rim torus.
  m.tube(0, 0, [[0.18, 0.185], [0.23, 0.215], [0.27, 0.185]], 8,
    { cols: [0xe4dccc, 0xf2ece0] });
  m.tube(0, 0, [[0.27, 0.175], [0.42, 0.255], [0.66, 0.415], [0.76, 0.455]], 8,
    { cols: [0xf6f2e8, 0xfaf6ee, 0xf2ece0] });
  m.tube(0, 0, [[0.76, 0.475], [0.80, 0.495], [0.84, 0.465]], 8,
    { cols: [0xfdfaf2, 0xece6d8] });
  m.col(P.MULCH).disc(0, 0.79, 0, 0.44, 8);
  shrub(m, 0, 0.76, 0, 0.30, P.HEDGE_LIGHT, 5, 2);
  m.col(P.FLOWER_MAGENTA);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * TAU + 0.9;
    m.tube(Math.cos(a) * 0.44, Math.sin(a) * 0.44, [[0.74, 0.09], [0.82, 0.12], [0.88, 0.05]], 5,
      { capTop: true });
  }
}

/**
 * Fabricated steel trough. Reads as folded plate now: a 25 mm returned top lip
 * all round, a fold line down each corner, a recessed shadow gap at the base
 * instead of a plinth, four levelling feet, and a real value break — dark body,
 * lighter top lip, warmer bottom third. The seven splinter beams are replaced
 * by three crossed grass fans plus three straw seed-head spikes, so the
 * planting has a mass and a top silhouette.
 */
function gPlanterModern(m) {
  m.col(0x22262a);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    m.prism(sx * 0.56, sz * 0.18, [[0, 0.12, 0.12], [0.055, 0.10, 0.10]]);
  }
  m.prism(0, 0, [
    [0.055, 1.28, 0.48], [0.11, 1.32, 0.52], [0.34, 1.24, 0.46],
    [0.80, 1.10, 0.40], [0.86, 1.14, 0.44],
  ], { capTop: false, cols: [0x3a4046, 0x565f5c, 0x49514f, 0x8f9694] });
  m.col(0x9aa0a0).prism(0, 0, [[0.86, 1.16, 0.46], [0.885, 1.10, 0.40]]);
  m.col(0x2c3234);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) decal(m, sx * 0.60, 0.48, sz * 0.232, 0.02, 0.72, sz);
  }
  m.col(P.MULCH).plate(0, 0.82, 0, 1.04, 0.34);
  const blades = [P.GRASS_DRY, P.GRASS_LIGHT, P.GRASS];
  for (let k = 0; k < 6; k++) {
    m.col(blades[k % 3]);
    const x = -0.44 + k * 0.176;
    const lean = (k % 2 ? 1 : -1) * (0.14 + (k % 3) * 0.06);
    m.beam(x, 0.78, 0, x + lean, 1.34 + (k % 3) * 0.12, lean * 0.5, 0.16, 0.02, false);
    m.beam(x, 0.78, 0, x - lean * 0.6, 1.20 + (k % 2) * 0.10, -lean * 0.4, 0.13, 0.02, false);
  }
  m.col(0xc9bb7a);
  for (let k = 0; k < 3; k++) {
    const x = -0.32 + k * 0.32;
    m.tubeBetween(x, 0.82, 0, x + 0.04, 1.62, 0.03, 0.012, 3);
    m.tube(x + 0.04, 0.03, [[1.58, 0.045], [1.68, 0.05], [1.76, 0.02]], 4, { capTop: true });
  }
}

/* -- terrace shade, service and the closed-up look ------------------------ */

/**
 * Freestanding terrace awning. From the top-down camera the old one was a
 * single flat rectangle of acid lime with no camber, no rafters and no stripe.
 * It is now five bays defined by visible rafters underneath, each cambered with
 * a 5 cm mid-span sag so the top surface is not one plane, a front edge
 * scalloped into five half-round lappets with a 0.22 m valance hung off it, a
 * ridge beam and tie rods — and the fabric is authored as an alternating
 * near-white STRIPE so the per-instance tint produces a striped canopy, which
 * is the actual Miami note.
 */
function gTerraceAwning(m) {
  const HX = 1.90, BZ = -0.92, FZ = 0.86, TOP = 2.58, LIP = 2.14;
  m.col(P.STEEL_DARK);
  for (const sx of [-1, 1]) {
    for (const [z, h] of [[BZ, TOP], [FZ, LIP]]) {
      m.tube(sx * HX, z, [[0, 0.19], [0.06, 0.15]], 6, { capTop: true });
      m.tube(sx * HX, z, [[0.06, 0.072], [h + 0.06, 0.062]], 6, { capTop: true });
    }
    m.tubeBetween(sx * HX, TOP, BZ, sx * HX, LIP + 0.30, FZ, 0.024, 4);   // tie rod
  }
  m.tubeBetween(-HX, TOP + 0.02, BZ, HX, TOP + 0.02, BZ, 0.045, 5);
  m.tubeBetween(-HX, LIP + 0.02, FZ, HX, LIP + 0.02, FZ, 0.045, 5);
  // Five cambered bays on visible rafters, striped across the width.
  const N = 5, W = (HX * 2 + 0.36) / N;
  for (let k = 0; k < N; k++) {
    const x = -HX - 0.18 + W * (k + 0.5);
    m.col(k % 2 ? 0xffffff : 0xdddddd);
    m.board(x, W, TOP + 0.07, BZ - 0.12, LIP + 0.12, (BZ + FZ) / 2, 0.05);
    m.board(x, W, LIP + 0.12, (BZ + FZ) / 2, LIP + 0.07, FZ + 0.24, 0.05);
    m.col(P.STEEL_DARK);
    m.tubeBetween(-HX - 0.18 + W * k, TOP + 0.03, BZ - 0.12,
      -HX - 0.18 + W * k, LIP + 0.03, FZ + 0.24, 0.026, 4);
  }
  m.col(P.STEEL_DARK);
  m.tubeBetween(-HX - 0.18, LIP + 0.03, FZ + 0.24, HX + 0.18, LIP + 0.03, FZ + 0.24, 0.026, 4);
  // Scalloped front edge and a valance hung off it.
  for (let k = 0; k < N; k++) {
    const x = -HX - 0.18 + W * (k + 0.5);
    m.col(k % 2 ? 0xffffff : 0xdddddd);
    m.prism(x, FZ + 0.26, [[LIP - 0.16, W * 0.94, 0.045], [LIP + 0.07, W * 0.94, 0.045]]);
    m.col(0xeeeeee);
    m.tube(x, FZ + 0.26, [[LIP - 0.16, W * 0.30, 0.03], [LIP - 0.10, W * 0.46, 0.03]], 5);
  }
  m.lit(P.LAMP_GLOW, 1, 1.1);
  for (const x of [-1.15, 0, 1.15]) {
    m.tube(x, 0.06, [[2.18, 0.05], [2.26, 0.06]], 5, { capTop: true });
  }
}

/**
 * Champagne bucket on a tripod. An eight-sided flare with a rolled rim ring and
 * two cast ring handles, five ice chunks standing proud of the rim rather than
 * one flat disc, a real bottle — six-sided with a shoulder taper, a neck and a
 * foil capsule — leaning 20 degrees, and a brace ring joining the three legs.
 */
function gIceBucket(m) {
  m.col(P.STEEL_DARK);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * TAU + 0.5;
    m.tubeBetween(Math.cos(a) * 0.26, 0.02, Math.sin(a) * 0.26,
      Math.cos(a) * 0.09, 0.58, Math.sin(a) * 0.09, 0.024, 4);
    m.tube(Math.cos(a) * 0.26, Math.sin(a) * 0.26, [[0, 0.045], [0.025, 0.04]], 4, { capTop: true });
  }
  for (let k = 0; k < 3; k++) {
    const a0 = (k / 3) * TAU + 0.5, a1 = ((k + 1) / 3) * TAU + 0.5;
    m.tubeBetween(Math.cos(a0) * 0.20, 0.22, Math.sin(a0) * 0.20,
      Math.cos(a1) * 0.20, 0.22, Math.sin(a1) * 0.20, 0.016, 3);
  }
  m.col(P.CHROME);
  m.tube(0, 0, [[0.54, 0.175], [0.62, 0.205], [0.86, 0.245]], 8, { capTop: false });
  m.tube(0, 0, [[0.86, 0.255], [0.90, 0.248]], 8);
  for (const s of [-1, 1]) {
    m.tubeBetween(s * 0.245, 0.78, 0, s * 0.295, 0.74, 0, 0.024, 4);
    m.tubeBetween(s * 0.295, 0.74, 0, s * 0.28, 0.66, 0, 0.022, 4, true);
  }
  m.col(P.SEA_FOAM).disc(0, 0.855, 0, 0.235, 8);
  m.col(0xf4ffff);
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * TAU + 0.3;
    m.tube(Math.cos(a) * 0.13, Math.sin(a) * 0.13,
      [[0.84, 0.055], [0.90, 0.045]], 4, { capTop: true, rot: k });
  }
  // Bottle: six sides, shoulder, neck, foil capsule, leaning 20 degrees.
  m.col(P.GLASS_MINT);
  m.tubeBetween(0.05, 0.82, 0.02, 0.11, 1.02, 0.05, 0.075, 6);
  m.tubeBetween(0.11, 1.02, 0.05, 0.14, 1.10, 0.06, 0.045, 6);
  m.col(P.ACCENT_SUN);
  m.tubeBetween(0.14, 1.10, 0.06, 0.16, 1.18, 0.07, 0.038, 6, true);
}

/**
 * Gelato counter. The old one hid all five tubs — the entire point of the
 * object — under an opaque parallelogram plate stabbing out of the cabinet. The
 * well is now recessed into the top holding eight pans in two rows of four,
 * each with a mounded top and a scoop handle; the hood is three short chamfered
 * bands stepping FORWARD and constrained inside the cabinet footprint, in pale
 * glass with aluminium frames at both edges; and the fascia carries a lit price
 * strip, a row of flavour cards and a cone stack on one end.
 */
function gGelatoCase(m) {
  m.col(P.STEEL_DARK).prism(0, 0, [[0, 1.60, 0.84], [0.10, 1.52, 0.76]]);
  m.col(P.ALUMINIUM).prism(0, 0, [[0.10, 1.50, 0.74], [0.16, 1.54, 0.78]]);
  m.col(0xe8e4da);
  m.oct(0, 0, [[0.16, 1.54, 0.78, 0.05], [0.86, 1.54, 0.78, 0.05]], { capTop: false });
  m.col(P.CHROME).prism(0, 0, [[0.86, 1.60, 0.84], [0.92, 1.56, 0.80]]);
  m.col(0x9aa0a0).prism(0, 0, [[0.84, 1.46, 0.70], [0.88, 1.46, 0.70]]);
  const tubs = [P.STUCCO_BUTTER, P.FLOWER_PINK, P.TERRACOTTA, P.SEA_FOAM,
    P.WOOD_DARK, P.FLOWER_WHITE, P.STUCCO_BUTTER, P.FLOWER_PINK];
  for (let k = 0; k < 8; k++) {
    const col = k % 4, row = Math.floor(k / 4);
    const x = -0.54 + col * 0.36, z = -0.14 + row * 0.30;
    m.col(P.ALUMINIUM).prism(x, z, [[0.84, 0.34, 0.28], [0.88, 0.32, 0.26]], { capTop: false });
    m.col(tubs[k]);
    m.prism(x, z, [[0.86, 0.30, 0.24], [0.93, 0.28, 0.22], [0.96, 0.20, 0.15]]);
    m.col(P.CHROME);
    m.tubeBetween(x + 0.10, 0.95, z, x + 0.14, 1.06, z - 0.04, 0.016, 3, true);
  }
  // Curved hood: three bands stepping forward, inside the cabinet footprint.
  const hood = [[0.96, 0.36, 1.16, 0.40], [1.16, 0.40, 1.32, 0.30], [1.32, 0.30, 1.40, 0.10]];
  for (const [y0, z0, y1, z1] of hood) {
    m.col(P.GLASS_SKY, 1.28);
    m.board(0, 1.46, y0, z0, y1, z1, 0.03);
  }
  m.col(P.ALUMINIUM);
  for (const s of [-1, 1]) {
    m.tubeBetween(s * 0.74, 0.96, 0.36, s * 0.74, 1.32, 0.30, 0.026, 4);
    m.tubeBetween(s * 0.74, 1.32, 0.30, s * 0.74, 1.40, 0.10, 0.026, 4);
  }
  m.lit(P.LAMP_GLOW, 1, 0.75).prism(0, -0.38, [[1.34, 1.30, 0.05], [1.42, 1.30, 0.05]]);
  // Lit price strip, flavour cards and a cone stack on the fascia.
  m.lit(P.LAMP_GLOW, 1, 0.6); decal(m, 0, 0.72, 0.392, 1.36, 0.10);
  m.col(P.SIGN_DARK);
  for (let k = 0; k < 6; k++) decal(m, -0.55 + k * 0.22, 0.50, 0.392, 0.16, 0.20);
  m.col(P.SIGN_FACE);
  for (let k = 0; k < 6; k++) decal(m, -0.55 + k * 0.22, 0.55, 0.394, 0.12, 0.05);
  m.col(P.WOOD_LIGHT);
  for (let k = 0; k < 3; k++) {
    m.tube(0.66, 0.16, [[0.92 + k * 0.10, 0.075], [1.00 + k * 0.10, 0.045]], 5, { capTop: true });
  }
}

/**
 * Post-and-rope terrace divider. Round rope on five chords so the sag is smooth
 * (0.045 square-section beams kinked at each joint and read as bent sticks),
 * turned timber bollards with a bead below the finial and a brass ferrule at
 * the base, and whipped rope ends with an eye-splice over each finial.
 */
function gTerraceRope(m) {
  const S = 1.00;
  for (const s of [-1, 1]) {
    m.col(P.ACCENT_SUN).tube(s * S, 0, [[0, 0.12], [0.05, 0.115]], 6, { capTop: false });
    m.col(P.WOOD_DARK);
    m.tube(s * S, 0, [[0.05, 0.105], [0.18, 0.088], [0.62, 0.078], [0.80, 0.086]], 6);
    m.col(P.TEAK).tube(s * S, 0, [[0.80, 0.094], [0.86, 0.088], [0.94, 0.070]], 6);
    m.col(P.CHROME).tube(s * S, 0, [[0.94, 0.086], [1.00, 0.092], [1.08, 0.040]], 6, { capTop: true });
  }
  m.col(P.SAND_WET);
  ropeRun(m, -S, S, 0, 0.90, 0.68, 0.042, 6);
  ropeRun(m, -S, S, 0, 0.58, 0.40, 0.038, 6);
  m.col(0xb09a72);
  for (const s of [-1, 1]) {
    for (const y of [0.90, 0.58]) {
      m.tube(s * S, 0, [[y - 0.05, 0.062], [y + 0.05, 0.062]], 5);
    }
  }
}

/**
 * Chairs stacked for the night. Rebuilt from the café chair: five nested
 * copies, each raised 0.10, rotated 3 degrees and offset, with the bottom
 * chair's legs actually reaching the ground and the back frames overlapping
 * into one continuous leaning silhouette — the old one was four trays floating
 * above two slabs with a detached panel over them. A strap round the middle,
 * and the whole stack leans 3 degrees off vertical.
 */
function gChairStack(m) {
  const LEAN = 0.035;
  m.col(0xe6e0d0);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    m.tubeBetween(sx * 0.22, 0, sz * 0.22, sx * 0.185, 0.43, sz * 0.185, 0.024, 4);
  }
  for (let k = 0; k < 5; k++) {
    const y = 0.42 + k * 0.10;
    const dz = k * LEAN;
    m.col(k % 2 ? 0xf2ede1 : P.CHAIR);
    m.xform((k - 2) * 0.052, 0, 0, dz);
    m.prism(0, 0, [[y, 0.40, 0.38], [y + 0.03, 0.44, 0.42], [y + 0.06, 0.395, 0.375]]);
    m.col(k % 2 ? P.CHAIR : 0xe2ddd0);
    for (const sx of [-1, 1]) {
      m.tubeBetween(sx * 0.185, y + 0.01, -0.185, sx * 0.165, y + 0.46, -0.235, 0.023, 4);
    }
    for (let b = 0; b < 2; b++) {
      m.beam(-0.175, y + 0.17 + b * 0.20, -0.205 - b * 0.02,
        0.175, y + 0.17 + b * 0.20, -0.205 - b * 0.02, 0.075, 0.03, false);
    }
    m.reset();
  }
  m.col(P.SIGN_DARK);
  m.tubeBetween(-0.22, 0.74, 0.10, 0.22, 0.74, 0.10, 0.018, 4);
  m.tubeBetween(0.22, 0.74, 0.10, 0.22, 0.70, -0.24, 0.018, 4);
  m.tubeBetween(-0.22, 0.74, 0.10, -0.22, 0.70, -0.24, 0.018, 4);
}

/**
 * Barrel high-top. The hoops are now PROUD 2 cm steel bands at the quarter
 * points and at both chimes so the barrel reads as bound rather than painted,
 * the bottom chime tucks in with a visible rim instead of flaring into a dark
 * cone, the staves alternate two adjacent timber tones around the eight
 * segments, and the candle holder stands upright and central on the top.
 */
function gBarrelTable(m) {
  const secs = [[0, 0.295], [0.06, 0.315], [0.16, 0.335], [0.54, 0.362],
    [0.92, 0.335], [1.02, 0.312]];
  // Staves drawn segment by segment so adjacent tones cut vertical stave lines.
  for (let g = 0; g < secs.length - 1; g++) {
    const [y0, r0] = secs[g], [y1, r1] = secs[g + 1];
    for (let k = 0; k < 8; k++) {
      const a0 = (k / 8) * TAU, a1 = ((k + 1) / 8) * TAU;
      m.col(k % 2 ? P.WOOD_DECK : 0xb1854f);
      m.quad([Math.cos(a0) * r0, y0, Math.sin(a0) * r0],
        [Math.cos(a0) * r1, y1, Math.sin(a0) * r1],
        [Math.cos(a1) * r1, y1, Math.sin(a1) * r1],
        [Math.cos(a1) * r0, y0, Math.sin(a1) * r0]);
    }
  }
  m.col(P.STEEL_DARK);
  for (const [y, r] of [[0.05, 0.318], [0.30, 0.352], [0.78, 0.352], [0.98, 0.322]]) {
    m.tube(0, 0, [[y, r], [y + 0.045, r]], 8);
  }
  m.col(P.TEAK).tube(0, 0, [[1.02, 0.44], [1.06, 0.47], [1.10, 0.455]], 10);
  m.col(0xc78d52).disc(0, 1.098, 0, 0.455, 10);
  m.col(P.STEEL_DARK).tube(0, 0, [[1.098, 0.075], [1.13, 0.07]], 6);
  m.col(P.SIGN_FACE).tube(0, 0, [[1.13, 0.055], [1.24, 0.05]], 6, { capTop: true });
  m.lit(P.LAMP_GLOW, 1, 1.1).tube(0, 0, [[1.24, 0.045], [1.28, 0.02]], 5, { capTop: true });
}

/* -- hotel + lounge ------------------------------------------------------- */

/**
 * Bell cart. The structure was already right; the tubes were spindly squares
 * and the bags were three plain boxes. The frame is 0.07 m round tube with
 * corner elbows, there is a hanging garment rail across the top, a push handle
 * at one end and a bumper rail round the deck — and every bag has one piece of
 * hardware: a grab handle, a zip band, a corner patch, or a retractable handle
 * stub with two wheels.
 */
function gLuggageCart(m) {
  m.col(P.TYRE);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      m.tube(sx * 0.50, sz * 0.34, [[0, 0.09], [0.16, 0.09]], 5, { capTop: true });
    }
  }
  m.col(0x7a1f2b).prism(0, 0, [[0.16, 1.20, 0.82], [0.26, 1.16, 0.78]]);
  m.col(P.CHROME);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      m.tubeBetween(sx * 0.54, 0.20, sz * 0.36, sx * 0.54, 1.40, sz * 0.36, 0.035, 5);
      m.tubeBetween(sx * 0.54, 1.40, sz * 0.36, sx * 0.50, 1.44, sz * 0.32, 0.035, 5);
    }
    m.tubeBetween(sx * 0.50, 1.44, -0.32, sx * 0.50, 1.44, 0.32, 0.035, 5);
    m.tubeBetween(sx * 0.54, 0.24, -0.36, sx * 0.54, 0.24, 0.36, 0.030, 4);
  }
  m.tubeBetween(-0.50, 1.44, -0.36, 0.50, 1.44, -0.36, 0.035, 5);
  m.tubeBetween(-0.50, 1.44, 0.36, 0.50, 1.44, 0.36, 0.035, 5);
  m.tubeBetween(-0.50, 1.34, 0, 0.50, 1.34, 0, 0.028, 5);      // garment rail
  m.tubeBetween(-0.66, 0.90, -0.20, -0.66, 0.90, 0.20, 0.030, 5, true);  // push handle
  m.tubeBetween(-0.54, 0.90, 0, -0.66, 0.90, 0, 0.024, 4);
  m.tubeBetween(-0.56, 0.24, -0.36, -0.56, 0.24, 0.36, 0.026, 4);
  // Three mismatched bags, each with one piece of hardware.
  m.col(P.CAR_NAVY).prism(-0.28, 0, [[0.26, 0.50, 0.36], [0.86, 0.48, 0.34]]);
  m.col(0x1a3050); decal(m, -0.28, 0.74, 0.182, 0.46, 0.05);
  m.col(P.CHROME).tubeBetween(-0.40, 0.87, 0, -0.16, 0.87, 0, 0.020, 4);
  m.col(P.STUCCO_CORAL).prism(0.24, 0.08, [[0.26, 0.50, 0.34], [0.70, 0.48, 0.32]]);
  m.col(0xd05a44); decal(m, 0.24, 0.44, 0.242, 0.14, 0.14);
  m.col(P.CHROME);
  m.tubeBetween(0.14, 0.70, 0.08, 0.14, 0.90, 0.08, 0.014, 4);
  m.tubeBetween(0.34, 0.70, 0.08, 0.34, 0.90, 0.08, 0.014, 4);
  m.tubeBetween(0.14, 0.90, 0.08, 0.34, 0.90, 0.08, 0.014, 4);
  m.col(P.WOOD_DARK);
  m.tube(0.18, -0.16, [[0.70, 0.23, 0.14], [0.86, 0.21, 0.13], [0.94, 0.14, 0.09]], 6,
    { capTop: true, rot: 0.4 });
  m.col(P.ACCENT_SUN).prism(0.54, -0.30, [[0.80, 0.10, 0.02], [0.92, 0.10, 0.02]]);
}

/**
 * Galvanised drinks tub. A rolled top rim and two riveted side handles, three
 * pressed ribs round the body, an ice mass with seven bottle necks poking
 * through at varied angles, a lower cross-brace ring between the legs, and a
 * folded towel over the rim.
 */
function gDrinksTub(m) {
  m.col(P.STEEL_DARK);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * TAU + 0.78;
    m.tubeBetween(Math.cos(a) * 0.40, 0.02, Math.sin(a) * 0.40,
      Math.cos(a) * 0.30, 0.52, Math.sin(a) * 0.30, 0.026, 4);
    m.tube(Math.cos(a) * 0.40, Math.sin(a) * 0.40, [[0, 0.05], [0.025, 0.045]], 4, { capTop: true });
  }
  for (let k = 0; k < 4; k++) {
    const a0 = (k / 4) * TAU + 0.78, a1 = ((k + 1) / 4) * TAU + 0.78;
    m.tubeBetween(Math.cos(a0) * 0.355, 0.22, Math.sin(a0) * 0.355,
      Math.cos(a1) * 0.355, 0.22, Math.sin(a1) * 0.355, 0.018, 3);
  }
  m.col(P.ALUMINIUM);
  m.tube(0, 0, [[0.48, 0.35], [0.58, 0.40], [0.84, 0.46]], 8, { capTop: false });
  m.tube(0, 0, [[0.84, 0.475], [0.885, 0.465]], 8);
  m.col(0x9aa09c);
  for (const y of [0.58, 0.70]) m.tube(0, 0, [[y, 0.425 + (y - 0.58) * 0.42], [y + 0.03, 0.43 + (y - 0.58) * 0.42]], 8);
  for (const s of [-1, 1]) {
    m.tubeBetween(s * 0.46, 0.74, 0, s * 0.52, 0.70, 0, 0.028, 4);
    m.tube(s * 0.44, 0, [[0.72, 0.035], [0.76, 0.03]], 4, { capTop: true });
  }
  m.col(P.SEA_FOAM).disc(0, 0.845, 0, 0.45, 8);
  m.col(0xf4ffff);
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * TAU + 0.4;
    m.tube(Math.cos(a) * 0.26, Math.sin(a) * 0.26, [[0.82, 0.075], [0.88, 0.06]], 4,
      { capTop: true, rot: k });
  }
  const bottles = [P.GLASS_MINT, P.TERRACOTTA, P.STUCCO_BUTTER, P.GLASS_TEAL,
    P.HYDRANT_RED, P.FLOWER_WHITE, P.CAR_LIME];
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * TAU + 0.4, r = 0.13 + (k % 3) * 0.08;
    m.col(bottles[k]);
    m.tubeBetween(Math.cos(a) * r, 0.80, Math.sin(a) * r,
      Math.cos(a) * (r + 0.05) + 0.02, 1.00 + (k % 3) * 0.04, Math.sin(a) * (r + 0.05),
      0.042, 5, true);
  }
  m.col(P.FABRIC_WHITE);
  m.tubeBetween(0.30, 0.86, -0.34, 0.44, 0.62, -0.30, 0.065, 5, true);
}

/**
 * Lounge table. A slatted teak top — five boards with 8 mm gaps inside a mitred
 * perimeter frame — on an apron rail, tapered square legs with feet, and a lower
 * shelf with a stack of two magazines. The two blobs on top are now a tumbler
 * with a straw leaning 20 degrees and a candle lantern with a glowing pane.
 */
function gLoungeTable(m) {
  m.col(P.WOOD_DARK);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    m.prism(sx * 0.40, sz * 0.24, [[0, 0.075, 0.075], [0.03, 0.065, 0.065], [0.34, 0.05, 0.05]]);
  }
  m.prism(0, 0, [[0.16, 0.86, 0.50], [0.20, 0.86, 0.50]]);       // lower shelf
  m.col(P.SIGN_FACE).prism(-0.16, 0.04, [[0.20, 0.28, 0.20], [0.24, 0.27, 0.19]]);
  m.col(P.FABRIC_CORAL).prism(-0.13, 0.02, [[0.24, 0.26, 0.19], [0.27, 0.25, 0.18]]);
  m.col(P.WOOD_DARK).prism(0, 0, [[0.28, 0.90, 0.54], [0.34, 0.90, 0.54]]);   // apron
  m.col(P.TEAK);
  m.prism(0, 0, [[0.34, 0.96, 0.60], [0.40, 0.94, 0.58]], { capTop: false });
  slats(m, 0, 0, 0.35, 0.88, 5, 0.092, 0.008, 0.05, [0xb07a44, 0xc08a52]);
  m.col(P.GLASS_MINT).tube(0.26, 0.02, [[0.40, 0.07], [0.58, 0.062]], 6, { capTop: true });
  m.col(P.FABRIC_CORAL).tubeBetween(0.26, 0.54, 0.02, 0.33, 0.70, 0.06, 0.010, 3);
  m.col(P.STEEL_DARK);
  m.prism(-0.22, 0.04, [[0.40, 0.16, 0.16], [0.44, 0.14, 0.14]]);
  m.prism(-0.22, 0.04, [[0.60, 0.16, 0.16], [0.64, 0.13, 0.13]]);
  for (const [dx, dz] of [[-0.06, 0], [0.06, 0], [0, -0.06], [0, 0.06]]) {
    m.tubeBetween(-0.22 + dx, 0.44, 0.04 + dz, -0.22 + dx, 0.60, 0.04 + dz, 0.010, 3);
  }
  m.lit(P.LAMP_GLOW, 1, 1.2).prism(-0.22, 0.04, [[0.46, 0.10, 0.10], [0.58, 0.10, 0.10]]);
}

/* -- ironwork in the pavement --------------------------------------------- */
/* Covers and hatches sit PROUD of the paving on their own frames, never flush.
   A plate coplanar with the sidewalk z-fights, and z-fighting anywhere is an
   automatic review failure — the frame is also what a real cover has, so the
   honest model and the safe model are the same model. */

/**
 * Manhole cover. The old plate was 0x5c554c — near-identical in value to the
 * asphalt — 8-sided, and stood 7 cm proud, so all that read was a black X
 * apparently floating on the road. This is a 12-sided disc sitting 1.5 cm proud
 * inside a sunken cast frame ring that is DARKER than the road, so the cover
 * reads as a lighter disc against a dark ring; the face carries a raised waffle
 * grid, a centre boss and two pick slots, and the iron is a warm rust rather
 * than road grey.
 */
function gManholeCover(m) {
  m.col(0x4a4038);
  m.tube(0, 0, [[0, 0.42], [0.012, 0.415], [0.02, 0.36]], 12, { capTop: false });
  m.col(0x7a6a58);
  m.tube(0, 0, [[0.008, 0.355], [0.028, 0.352]], 12);
  m.col(0x8a7864).disc(0, 0.030, 0, 0.352, 12);
  m.col(0x6b5c4c);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const x = -0.19 + c * 0.127, z = -0.19 + r * 0.127;
      if (x * x + z * z > 0.10) continue;
      m.plate(x, 0.038, z, 0.098, 0.098);
    }
  }
  m.col(0x8a7864).tube(0, 0, [[0.030, 0.075], [0.046, 0.068]], 8, { capTop: true });
  m.col(0x2f2822);
  for (const a of [0.4, 0.4 + Math.PI]) {
    m.plate(Math.cos(a) * 0.24, 0.039, Math.sin(a) * 0.24, 0.07, 0.03);
  }
}

/**
 * Square gully cover. The second manhole MODEL, not a recolour: 529 identical
 * round plates on a road is the repetition, and a square utility-valve plate on
 * the same sunken frame breaks it from directly above, which is the only angle
 * that matters for pavement ironwork.
 */
function gManholeSquare(m) {
  m.col(0x4a4038);
  m.prism(0, 0, [[0, 0.72, 0.62], [0.012, 0.70, 0.60], [0.02, 0.60, 0.50]], { capTop: false });
  m.col(0x7a6a58).prism(0, 0, [[0.008, 0.58, 0.48], [0.028, 0.575, 0.475]]);
  m.col(0x6b5c4c);
  for (let k = 0; k < 5; k++) {
    m.plate(0, 0.031, -0.18 + k * 0.09, 0.50, 0.055);
  }
  m.col(0x8a7864);
  for (const s of [-1, 1]) m.plate(s * 0.22, 0.031, 0, 0.06, 0.44);
  m.col(0x2f2822);
  for (const s of [-1, 1]) m.plate(s * 0.16, 0.033, 0, 0.07, 0.03);
}

/**
 * Gully grate. Sunk flush into a recessed cast frame with a 4 cm lip rather
 * than lying proud on the middle of a paving slab, seven slots with a central
 * cross-rib, near-black voids so the openings actually read, two bolt bosses
 * and a hinge lug, and a silt stain painted on the paving around it.
 */
function gDrainGrate(m) {
  m.col(P.SIDEWALK, 0.90).plate(0, 0.004, 0, 1.02, 0.78);
  m.col(0x5a5249);
  m.prism(0, 0, [[0, 0.80, 0.58], [0.02, 0.78, 0.56], [0.055, 0.72, 0.50]], { capTop: false });
  m.col(0x1b1814).plate(0, 0.030, 0, 0.70, 0.48);
  m.col(0x6a6259);
  for (let k = 0; k < 8; k++) {
    m.prism(-0.30 + k * 0.086, 0, [[0.030, 0.042, 0.48], [0.052, 0.040, 0.48]]);
  }
  m.prism(0, 0, [[0.030, 0.68, 0.05], [0.052, 0.68, 0.05]]);
  m.col(0x4d463e);
  for (const s of [-1, 1]) {
    m.tube(s * 0.32, 0, [[0.052, 0.045], [0.066, 0.038]], 5, { capTop: true });
  }
  m.prism(0, -0.26, [[0.052, 0.14, 0.05], [0.068, 0.13, 0.05]]);
}

/** Steel cellar doors outside a shop — the delivery hatch every old retail
 *  street has and no procedural one ever does. */
function gCellarHatch(m) {
  m.col(0x6a6259).prism(0, 0, [[0, 1.26, 1.02], [0.05, 1.26, 1.02]]);
  m.col(P.ALUMINIUM);
  for (const s of [-1, 1]) m.prism(0, s * 0.26, [[0.05, 1.14, 0.46], [0.13, 1.12, 0.44]]);
  m.col(P.STEEL_DARK);
  for (const s of [-1, 1]) m.tube(s * 0.40, 0, [[0.13, 0.07], [0.16, 0.06]], 5, { capTop: true });
}

/* -- more kerbside -------------------------------------------------------- */

/**
 * Bus stop flag. The blade carries a BUS GLYPH now — a white rounded rectangle
 * with two dark window bars and two wheel dots, which reads as a bus at any
 * distance and costs six quads — plus a route-number band under it, a 2 cm
 * frame lip on both faces so it is not a decal on a slab, a bracket where the
 * blade meets the pole, and a cast cap on the pole top.
 */
function gBusStopFlag(m) {
  pole(m, 2.78, 0.055, P.SIGN_POLE);
  m.col(P.SIGN_BLUE);
  m.prism(0, 0, [[2.10, 0.54, 0.045], [2.13, 0.56, 0.065], [2.75, 0.56, 0.065], [2.78, 0.54, 0.045]]);
  for (const s of [1, -1]) {
    const z = s * 0.034;
    m.lit(P.SIGN_FACE, 1, 0.60); decal(m, 0, 2.53, z, 0.40, 0.30, s);
    m.col(P.SIGN_BLUE);
    decal(m, -0.09, 2.60, z + s * 0.003, 0.13, 0.09, s);
    decal(m, 0.09, 2.60, z + s * 0.003, 0.13, 0.09, s);
    m.col(P.SIGN_DARK);
    decal(m, -0.11, 2.41, z + s * 0.003, 0.07, 0.07, s);
    decal(m, 0.11, 2.41, z + s * 0.003, 0.07, 0.07, s);
    m.lit(P.NEON_AQUA, 1, 0.90); decal(m, 0, 2.71, z, 0.42, 0.10, s);
    m.col(P.SIGN_FACE); decal(m, 0, 2.71, z + s * 0.003, 0.24, 0.045, s);
  }
  m.col(P.ALUMINIUM);
  borderBoth(m, 0, 2.44, 0.036, 0.50, 0.62, 0.022);
  bracket(m, 1.98, 0.14, 0.12, 0.12);
  m.col(P.SIGN_DARK).prism(0, 0.045, [[1.22, 0.42, 0.05], [1.88, 0.42, 0.05]]);
  m.lit(P.SIGN_FACE, 1, 0.50).prism(0, 0.072, [[1.28, 0.34, 0.012], [1.82, 0.34, 0.012]]);
  m.col(P.SIGN_DARK);
  for (let k = 0; k < 5; k++) decal(m, 0, 1.72 - k * 0.09, 0.079, 0.28, 0.025);
}

/**
 * Recycling point. The apertures are RECESSED 5 cm into the body so they read
 * as holes rather than stickers, and shaped per stream — a round hole for
 * bottles, a slot for paper — which is how a recycling point reads without
 * text. Chamfered corners, a sloped shoulder under each lid, a pictogram on
 * each stream panel, a base plinth and a shared back panel with a city mark.
 */
function gBinTwin(m) {
  m.col(P.BENCH_METAL);
  m.prism(0, 0, [[0, 1.22, 0.58], [0.06, 1.18, 0.54], [0.12, 1.12, 0.48], [0.22, 1.12, 0.48]]);
  for (const [s, hex, lidHex] of [[-1, 0xf2f2f2, P.BIN_GREEN], [1, 0xf2f2f2, P.BIN_BLUE]]) {
    m.col(hex);
    m.oct(s * 0.27, 0, [[0.22, 0.50, 0.44, 0.03], [0.82, 0.52, 0.46, 0.03],
      [0.92, 0.48, 0.42, 0.03]], { capTop: false });
    m.col(lidHex);
    m.prism(s * 0.27, 0, [[0.92, 0.56, 0.50], [0.98, 0.55, 0.49], [1.02, 0.48, 0.42]]);
    // Recessed aperture: dark well, then the shaped opening.
    m.col(0x15181b);
    m.prism(s * 0.27, 0.17, [[0.56, 0.36, 0.06], [0.82, 0.36, 0.06]]);
    m.col(0x0d0f11);
    if (s < 0) m.tube(s * 0.27, 0.235, [[0.62, 0.115], [0.74, 0.115]], 6, { capTop: true });
    else m.prism(s * 0.27, 0.235, [[0.66, 0.30, 0.02], [0.72, 0.30, 0.02]]);
    // Stream panel with a pictogram.
    m.col(lidHex); decal(m, s * 0.27, 0.42, 0.232, 0.38, 0.16);
    m.col(P.SIGN_FACE);
    if (s < 0) {
      decal(m, s * 0.27, 0.40, 0.234, 0.07, 0.11);
      decal(m, s * 0.27, 0.48, 0.234, 0.03, 0.05);
    } else {
      decal(m, s * 0.27 - 0.02, 0.42, 0.234, 0.11, 0.13);
      decal(m, s * 0.27 + 0.05, 0.46, 0.234, 0.05, 0.05);
    }
  }
  m.col(P.BENCH_METAL);
  m.prism(0, -0.20, [[0.22, 1.10, 0.06], [1.02, 1.10, 0.06]]);
  m.col(P.SIGN_FACE); decal(m, 0, 0.88, -0.232, 0.22, 0.10, -1);
}

/**
 * Roll cage. The two side panels were solid aluminium sheets, so a roll cage
 * rendered as a flat grey board on the pavement — the one thing a roll cage
 * must never look like. They are now real mesh: six vertical and three
 * horizontal bars you can see the cartons through. A hinged rear gate with a
 * latch, castors as visible wheels in swivel forks, a shrink-wrapped top carton
 * and a bungee across the open face.
 */
function gStockTrolley(m) {
  m.col(P.STEEL_DARK);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      m.prism(sx * 0.34, sz * 0.28, [[0.10, 0.09, 0.07], [0.15, 0.09, 0.07]]);
      m.col(P.TYRE);
      m.tubeBetween(sx * 0.34 - 0.05, 0.075, sz * 0.28, sx * 0.34 + 0.05, 0.075, sz * 0.28,
        0.075, 6, true);
      m.col(P.STEEL_DARK);
    }
  }
  m.col(P.STEEL).prism(0, 0, [[0.15, 0.86, 0.68], [0.21, 0.82, 0.64]]);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      m.tubeBetween(sx * 0.40, 0.18, sz * 0.31, sx * 0.40, 1.50, sz * 0.31, 0.026, 5);
    }
    m.tubeBetween(sx * 0.40, 1.50, -0.31, sx * 0.40, 1.50, 0.31, 0.024, 4);
  }
  m.col(0x9aa4a2);
  for (const s of [-1, 1]) {
    for (let k = 0; k < 6; k++) {
      const x = -0.33 + k * 0.132;
      m.tubeBetween(x, 0.24, s * 0.31, x, 1.46, s * 0.31, 0.011, 3);
    }
    for (let k = 0; k < 3; k++) {
      const y = 0.44 + k * 0.38;
      m.tubeBetween(-0.38, y, s * 0.31, 0.38, y, s * 0.31, 0.011, 3);
    }
  }
  // Hinged rear gate with a latch.
  m.col(P.STEEL);
  m.tubeBetween(-0.40, 0.24, -0.31, -0.40, 1.40, -0.31, 0.020, 4);
  m.col(P.ACCENT_SUN);
  m.tubeBetween(0.34, 0.80, -0.34, 0.42, 0.80, -0.30, 0.022, 4, true);
  const cartons = [P.WOOD_LIGHT, 0xd9dcd6, P.WOOD_DECK];
  for (let k = 0; k < 3; k++) {
    m.col(cartons[k]);
    m.xform((k - 1) * 0.07, 0, 0, 0);
    m.prism(0, 0, [[0.21 + k * 0.33, 0.66, 0.50], [0.52 + k * 0.33, 0.64, 0.48]]);
    m.reset();
  }
  m.col(0xdde2dc, 1.04).prism(0, 0, [[1.18, 0.70, 0.54], [1.24, 0.68, 0.52]]);
  m.col(0x2b2f33);
  m.tubeBetween(-0.40, 1.06, 0.31, 0.40, 0.94, 0.31, 0.014, 3);
}

/**
 * Poster A-board. Both faces were entirely blank cream. Each now carries a
 * header bar, an image area of two colour blocks and a headline block inside a
 * visible 2.5 cm aluminium snap frame, with a hinge barrel at the apex and a
 * webbing strap between the leg pairs that stops the frame splaying.
 */
function gAboardPoster(m) {
  m.col(P.ALUMINIUM);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      m.board(sx * 0.40, 0.07, 0.02, sz * 0.23, 1.04, sz * 0.055, 0.05);
      m.prism(sx * 0.40, sz * 0.23, [[0, 0.10, 0.09], [0.03, 0.085, 0.075]]);
    }
  }
  for (const sz of [-1, 1]) {
    // Snap frame: four rails around the poster.
    m.col(P.ALUMINIUM);
    m.board(0, 0.86, 0.16, sz * 0.205, 0.20, sz * 0.199, 0.035);
    m.board(0, 0.86, 1.00, sz * 0.062, 1.04, sz * 0.056, 0.035);
    for (const sx of [-1, 1]) {
      m.board(sx * 0.41, 0.04, 0.18, sz * 0.202, 1.02, sz * 0.059, 0.035);
    }
    m.lit(P.SIGN_FACE, 1, 0.50).board(0, 0.82, 0.19, sz * 0.20, 1.00, sz * 0.058, 0.02);
    // Poster content: header bar, two image blocks, a headline block.
    const off = sz * 0.014;
    m.col(P.NEON_PINK);
    rake(m, 0, 0.78, 0.90, sz * 0.075, 0.99, sz * 0.060, off);
    m.col(P.FABRIC_AQUA);
    rake(m, -0.18, 0.36, 0.54, sz * 0.153, 0.82, sz * 0.093, off);
    m.col(P.FABRIC_SUN);
    rake(m, 0.20, 0.32, 0.60, sz * 0.142, 0.82, sz * 0.093, off);
    m.col(P.SIGN_DARK);
    rake(m, 0, 0.62, 0.32, sz * 0.192, 0.40, sz * 0.178, off);
    rake(m, -0.12, 0.34, 0.24, sz * 0.206, 0.29, sz * 0.197, off);
  }
  m.col(P.STEEL_DARK);
  m.tubeBetween(-0.42, 1.06, 0, 0.42, 1.06, 0, 0.026, 5);
  m.col(0x2b2f33);
  for (const sx of [-1, 1]) {
    m.tubeBetween(sx * 0.40, 0.38, -0.16, sx * 0.40, 0.34, 0.16, 0.012, 3);
  }
}

/* ========================================================= catalogue ==== */

const T = TIER;

/**
 * key -> definition.
 *   r/h    nominal radius + height. worldBuild MEASURES both off the merged
 *          geometry, so these are a fallback and a sanity note, never the
 *          physics. Fix a wrong footprint by fixing the mesh.
 *   cap    unused now (counts are exact), kept as documentation of intent
 *   tint   per-instance colour palette; body vertices must be near-white
 *   sv     per-instance scale variance, +-fraction. See Placer.put — the
 *          single cheapest cure for a row of identical objects, because it
 *          breaks the silhouette rhythm as well as the footprint. Left off
 *          anything that forms a CONTINUOUS LINE (hoarding, portaloo banks,
 *          newspaper rows, scooter ranks) where a 6% length change opens gaps.
 *   shadow only props tall enough to throw a shadow the map can resolve
 */
const DEFS = {
  /* litter + kerb ------------------------------------------------------- */
  cone: {
    g: gCone, tier: T.TINY, r: 0.30, h: 0.72, label: 'Traffic Cone', sv: 0.07,
    /* Near-white multipliers: the cone is authored in its real orange with a
       white sleeve, and a multiplicative instance hex cannot invent contrast it
       does not have — but it can scuff one. +-8% is a coned-off run that has
       been on site a while rather than one freshly delivered. */
    tint: [0xffffff, 0xf4f0ec, 0xe6e2dc, 0xfffaf0], debris: P.CONE_ORANGE,
  },
  bollard: {
    g: gBollard, tier: T.TINY, r: 0.16, h: 0.95, label: 'Bollard', sv: 0.06,
    tint: [0xdfe4e2, 0x6f7876, 0x4a5250, 0x8d938f, 0x4a5250], debris: P.BOLLARD_DARK,
  },
  bollardStone: {
    g: gBollardStone, tier: T.TINY, r: 0.20, h: 0.88, label: 'Stone Bollard', sv: 0.07,
    /* Warm limestone, grey granite, coral stone — all a value or two DARKER
       than SIDEWALK, because 350 posts at the pavement's own luminance is
       exactly the separation failure the art direction calls out. */
    tint: [0xc8bda4, 0xb2aea4, 0xd0b8a4, 0xbfb49c], debris: P.PRECAST,
  },
  bollardBell: { g: gBollardBell, tier: T.TINY, r: 0.19, h: 0.96, label: 'Bell Bollard', sv: 0.07, debris: P.BENCH_METAL },
  hydrant: {
    g: gHydrant, tier: T.TINY, r: 0.25, h: 0.84, label: 'Fire Hydrant', shadow: true, sv: 0.05,
    /* Bonnet and outlet caps are authored WHITE over a red body, so the hex
       repaints the caps and only deepens the body: yellow-bonnet, white-bonnet
       and cream-bonnet hydrants out of one geometry. */
    tint: [P.HYDRANT_YELLOW, P.HYDRANT_YELLOW, 0xffffff, 0xffe9b0, 0xdfe4e2],
    debris: P.HYDRANT_RED,
  },
  standpipe: { g: gStandpipe, tier: T.SMALL, r: 0.25, h: 1.06, label: 'Standpipe', sv: 0.05, debris: P.HYDRANT_RED },
  uplighter: { g: gUplighter, tier: T.TINY, r: 0.16, h: 0.22, label: 'Uplighter', sv: 0.08, debris: P.STEEL_DARK },
  cleat: {
    g: gMooringCleat, tier: T.TINY, r: 0.26, h: 0.25, label: 'Mooring Cleat',
    tint: [0xffffff, 0xc8d8c8, 0xd0b8a0], debris: P.STEEL_DARK,
  },

  /* bins ----------------------------------------------------------------- */
  binMuni: {
    g: gBinMuni, tier: T.SMALL, r: 0.42, h: 1.00, label: 'Litter Bin', sv: 0.05,
    tint: [P.BIN_GREEN, 0x2f7d55, P.BIN_GREY, P.BIN_GREEN, 0x4f8f6a], debris: P.BIN_GREEN,
  },
  binWheelie: {
    g: gBinWheelie, tier: T.SMALL, r: 0.34, h: 1.06, label: 'Wheelie Bin',
    tint: [P.BIN_GREEN, P.BIN_BLUE, P.BIN_GREY, P.BIN_GREEN, P.BIN_BLUE], debris: P.BIN_GREEN,
  },
  binMesh: {
    g: gBinMesh, tier: T.SMALL, r: 0.33, h: 0.88, label: 'Wire Bin', sv: 0.05,
    tint: [0xffffff, 0xdfe4e2, 0xc8d0cc], debris: P.BENCH_METAL,
  },
  trashBags: {
    g: gTrashBags, tier: T.TINY, r: 0.72, h: 0.86, label: 'Rubbish Sacks', sv: 0.10,
    tint: [0xffffff, 0xc4d2e0, 0xc8dcc4, 0xe0d8cc], debris: 0x2b2f33,
  },

  /* seating -------------------------------------------------------------- */
  benchSlat: {
    g: gBenchSlat, tier: T.SMALL, r: 1.00, h: 0.90, label: 'Bench', shadow: true, sv: 0.05,
    /* Slats authored near-white so the hex is the timber species; the cast-iron
       ends are authored dark and land as dark warm iron under any of them. */
    tint: [P.BENCH_WOOD, P.TEAK, P.WOOD_DARK, P.WOOD_DECK], debris: P.BENCH_WOOD,
  },
  benchCurve: {
    g: gBenchCurve, tier: T.SMALL, r: 1.40, h: 0.95, label: 'Civic Bench', shadow: true,
    sv: 0.05, crumbles: true,
    tint: [0xffffff, 0xf0e2cc, 0xe6ddc8, 0xfaf2e2], debris: P.PRECAST,
  },
  benchConcrete: {
    g: gBenchConcrete, tier: T.SMALL, r: 1.12, h: 0.56, label: 'Stone Bench', shadow: true,
    crumbles: true, tint: [0xffffff, 0xece4d2, 0xdcd6c6], debris: P.PRECAST,
  },
  benchBackless: {
    g: gBenchBackless, tier: T.SMALL, r: 0.88, h: 0.46, label: 'Park Bench', sv: 0.05,
    tint: [P.WOOD_DECK, P.BENCH_WOOD, P.TEAK], debris: P.WOOD_DECK,
  },
  picnicTable: {
    g: gPicnicTable, tier: T.MEDIUM, r: 1.10, h: 0.76, label: 'Picnic Table', shadow: true,
    sv: 0.05, tint: [0xffffff, 0xd6d2c6, 0xf0d8b0, 0xd8a884], debris: P.WOOD_DECK,
  },
  lounger: {
    g: gLounger, tier: T.MEDIUM, r: 1.00, h: 0.90, label: 'Sun Lounger', shadow: true, sv: 0.04,
    tint: [0xffffff, 0xffffff, P.STUCCO_SKY, P.FABRIC_AQUA, P.FABRIC_CORAL, P.STUCCO_BUTTER],
    debris: 0xf2f2f2,
  },

  /* signage -------------------------------------------------------------- */
  signStop: { g: gSignStop, tier: T.SMALL, r: 0.24, h: 2.70, label: 'Stop Sign', debris: P.HYDRANT_RED },
  signNoEntry: { g: gSignNoEntry, tier: T.SMALL, r: 0.22, h: 2.60, label: 'No Entry Sign', debris: P.HYDRANT_RED },
  signOneWay: { g: gSignOneWay, tier: T.SMALL, r: 0.28, h: 2.50, label: 'One Way Sign', debris: P.SIGN_DARK },
  signParking: { g: gSignParking, tier: T.SMALL, r: 0.22, h: 2.60, label: 'Parking Sign', debris: P.SIGN_BLUE },
  signStreet: { g: gSignStreet, tier: T.SMALL, r: 0.34, h: 2.90, label: 'Street Sign', debris: P.SIGN_GREEN },
  sandwichBoard: {
    g: gSandwichBoard, tier: T.SMALL, r: 0.46, h: 0.99, label: 'Sandwich Board', sv: 0.06,
    tint: [0xffffff, 0xf0e6d4, 0xdcd6c8, 0xfaf2e0], debris: P.SIGN_DARK,
  },
  valetStand: { g: gValetStand, tier: T.SMALL, r: 0.40, h: 1.46, label: 'Valet Stand', debris: P.SIGN_DARK },
  stanchion: {
    g: gStanchion, tier: T.SMALL, r: 0.19, h: 1.02, label: 'Rope Post',
    tint: [0xffffff, 0xffe0a0, 0xdfe4e2, 0xffffff], debris: P.CHROME,
  },

  /* kerb machines --------------------------------------------------------- */
  mailbox: { g: gMailbox, tier: T.SMALL, r: 0.40, h: 1.20, label: 'Mailbox', tint: [P.MAILBOX, P.MAILBOX, 0x2f6fb0], debris: P.MAILBOX },
  meter: {
    g: gParkingMeter, tier: T.SMALL, r: 0.22, h: 1.60, label: 'Parking Meter', sv: 0.04,
    tint: [0xffffff, 0xdfe8e6, 0xcac6b6, 0xe8ecec], debris: P.PARKING_METER,
  },
  newsBox: { g: gNewsBox, tier: T.SMALL, r: 0.32, h: 1.10, label: 'Newspaper Box', tint: [P.NEWSSTAND, P.SIGN_BLUE, P.ACCENT_SUN, P.BIN_GREEN], debris: P.NEWSSTAND },
  utilityBox: {
    g: gUtilityBox, tier: T.SMALL, r: 0.50, h: 1.32, label: 'Utility Cabinet',
    tint: [P.ALUMINIUM, 0x6f7a63, 0xc9c2b2, 0x7e8480], debris: P.ALUMINIUM,
  },
  atmKiosk: { g: gAtmKiosk, tier: T.MEDIUM, r: 0.60, h: 2.22, label: 'ATM Kiosk', shadow: true, debris: 0xf0ece2 },
  phoneKiosk: { g: gPhoneKiosk, tier: T.MEDIUM, r: 0.38, h: 2.40, label: 'Charging Kiosk', debris: P.STEEL_DARK },
  fountain: {
    g: gDrinkFountain, tier: T.SMALL, r: 0.32, h: 1.22, label: 'Drinking Fountain',
    tint: [0xffffff, 0xd8f0f0, 0xffd8c8], debris: P.PRECAST,
  },
  dogStation: {
    g: gDogStation, tier: T.SMALL, r: 0.24, h: 1.82, label: 'Dog Waste Station',
    debris: P.BIN_GREEN,
  },

  /* planting -------------------------------------------------------------- */
  planterRound: {
    g: gPlanterRound, tier: T.SMALL, r: 0.62, h: 1.45, label: 'Planter', sv: 0.09,
    /* Restrained near-white multipliers, not four saturated pot colours: the
       instance hex multiplies the WHOLE prop, so a terracotta tint would take
       the foliage with it and turn the planting muddy. */
    tint: [0xffffff, 0xf2e2c8, 0xdedad0, 0xfaf2e4], debris: P.PLANTER,
  },
  planterSquare: {
    g: gPlanterSquare, tier: T.SMALL, r: 0.78, h: 1.45, label: 'Planter', sv: 0.09,
    tint: [0xffffff, 0xf0dcc0, 0xdcd8d0, 0xc8c0b4], debris: P.PLANTER,
  },
  planterTrough: {
    g: gPlanterTrough, tier: T.SMALL, r: 1.00, h: 1.10, label: 'Flower Trough', shadow: true,
    sv: 0.06, tint: [0xffffff, 0xf2e6cc, 0xdcd8d0], debris: P.PLANTER,
  },
  pottedPalm: {
    g: gPottedPalm, tier: T.MEDIUM, r: 0.80, h: 1.90, label: 'Potted Palm', sv: 0.10,
    tint: [0xffffff, 0xf4e8dc, 0xdcecf4, 0xfaf4ea], debris: P.PALM_FROND,
  },

  /* café terrace ---------------------------------------------------------- */
  cafeTable: {
    g: gCafeTable, tier: T.SMALL, r: 0.40, h: 0.78, label: 'Café Table', sv: 0.05,
    tint: [0xffffff, 0xffffff, P.TEAK, 0xe6ddc8], debris: P.TABLE_TOP,
  },
  cafeTableCloth: { g: gCafeTableCloth, tier: T.SMALL, r: 0.71, h: 0.96, label: 'Dressed Table', sv: 0.05, debris: P.FABRIC_WHITE },
  cafeTableSquare: { g: gCafeTableSquare, tier: T.SMALL, r: 0.52, h: 0.94, label: 'Bistro Table', sv: 0.05, debris: P.TEAK },
  cafeChair: {
    g: gCafeChair, tier: T.SMALL, r: 0.30, h: 0.90, label: 'Café Chair', sv: 0.05,
    // Near-white body, so the instance hex is what makes a terrace of twenty
    // chairs stop looking like twenty copies of one chair.
    tint: [0xffffff, 0xffffff, P.FABRIC_AQUA, P.FABRIC_CORAL, P.FABRIC_SUN, P.STUCCO_SKY],
    debris: P.CHAIR,
  },
  bistroChair: {
    g: gBistroChair, tier: T.SMALL, r: 0.26, h: 0.88, label: 'Bistro Chair', sv: 0.06,
    /* Pale hues on purpose. The frame is authored light and the seat almost
       white, so a pastel hex paints the frame and leaves the seat reading as
       the lightest thing on the chair — one model in four colours, which is
       what a terrace looks like, rather than four blocks of colour. */
    tint: [0xffffff, 0xffd6e2, 0xdcf0c0, 0xffeec0, 0xcfeef0], debris: P.CHAIR,
  },
  barStool: {
    g: gBarStool, tier: T.SMALL, r: 0.34, h: 0.76, label: 'Bar Stool', sv: 0.05,
    tint: [0xffffff, 0xffdca0, 0xf0f0f0, 0xd8dcdc], debris: P.TEAK,
  },
  menuBoard: {
    g: gMenuBoard, tier: T.SMALL, r: 0.34, h: 1.70, label: 'Menu Board', sv: 0.05,
    tint: [0xffffff, 0xf0dcb8, 0xd8dce0, 0xfaf0e0], debris: P.SIGN_DARK,
  },
  hostStand: {
    g: gHostStand, tier: T.SMALL, r: 0.35, h: 1.38, label: 'Host Stand',
    tint: [0xffffff, 0xe8cba4, 0xf6f2ea], debris: P.WOOD_DARK,
  },
  pastryCase: { g: gPastryCase, tier: T.MEDIUM, r: 0.65, h: 1.50, label: 'Pastry Case', shadow: true, debris: P.GLASS_SKY },
  serviceStation: { g: gServiceStation, tier: T.SMALL, r: 0.54, h: 1.12, label: 'Service Station', debris: P.WOOD_DARK },
  terraceRail: { g: gTerraceRail, tier: T.SMALL, r: 0.99, h: 1.06, label: 'Terrace Screen', debris: P.ALUMINIUM },
  terraceHedge: {
    g: gTerraceHedge, tier: T.SMALL, r: 1.08, h: 1.00, label: 'Terrace Hedge', shadow: true,
    sv: 0.05, tint: [0xffffff, 0xe4e8b8, 0xc8ece0], debris: P.HEDGE,
  },
  /* No `sv` for the same reason as the rope: it packs on a boundary line. */
  plantScreen: { g: gPlantScreen, tier: T.MEDIUM, r: 0.99, h: 2.02, label: 'Planted Screen', shadow: true, debris: P.HEDGE },
  /* No `sv` on the rope: it packs end to end on the boundary line, and a 5%
     length change there opens a visible gap between every pair. */
  terraceRope: {
    g: gTerraceRope, tier: T.SMALL, r: 1.02, h: 1.08, label: 'Rope Divider',
    tint: [0xffffff, 0xdcc4a0, 0xf2eee6], debris: P.TEAK,
  },
  stringArch: { g: gStringArch, tier: T.MEDIUM, r: 2.20, h: 3.27, label: 'Festoon Lights', shadow: true, sv: 0.04, debris: P.WOOD_DARK },
  terraceAwning: {
    g: gTerraceAwning, tier: T.MEDIUM, r: 2.34, h: 2.65, label: 'Terrace Awning', shadow: true, sv: 0.04,
    tint: [P.FABRIC_CORAL, P.FABRIC_AQUA, P.FABRIC_SUN, P.FABRIC_WHITE, P.FABRIC_PINK,
      P.FABRIC_SKY, P.FABRIC_LIME],
    debris: P.FABRIC_CORAL,
  },
  iceBucket: { g: gIceBucket, tier: T.TINY, r: 0.38, h: 1.14, label: 'Ice Bucket', sv: 0.06, debris: P.CHROME },
  gelatoCase: { g: gGelatoCase, tier: T.MEDIUM, r: 0.81, h: 1.42, label: 'Gelato Counter', shadow: true, sv: 0.04, debris: P.ALUMINIUM },
  chairStack: { g: gChairStack, tier: T.SMALL, r: 0.31, h: 1.34, label: 'Stacked Chairs', sv: 0.06, debris: P.CHAIR },
  barrelTable: {
    g: gBarrelTable, tier: T.SMALL, r: 0.47, h: 1.28, label: 'Barrel Table', sv: 0.05,
    tint: [0xffffff, 0xe4cfae, 0xc9ab86], debris: P.WOOD_DECK,
  },

  /* nightlife + hotel ------------------------------------------------------ */
  porteCochere: { g: gPorteCochere, tier: T.LARGE, r: 3.35, h: 4.45, label: 'Entrance Canopy', shadow: true, crumbles: true, debris: P.CONCRETE },
  carpetRunner: { g: gCarpetRunner, tier: T.MEDIUM, r: 1.58, h: 0.98, label: 'Red Carpet', shadow: true, debris: 0xb4243c },
  velvetRope: {
    g: gVelvetRope, tier: T.SMALL, r: 1.13, h: 1.08, label: 'Rope Line',
    tint: [0xffffff, 0xffe0a8, 0x9aa8cc, 0xd8d8d8], debris: P.CHROME,
  },
  bouncerPodium: {
    g: gBouncerPodium, tier: T.SMALL, r: 0.42, h: 1.16, label: 'Door Podium',
    tint: [0xffffff, 0xd8dce4, 0xffc0b8], debris: P.SIGN_DARK,
  },
  keyBoard: { g: gKeyBoard, tier: T.SMALL, r: 0.33, h: 1.62, label: 'Valet Key Board', debris: P.ALUMINIUM },
  cigBin: { g: gCigBin, tier: T.TINY, r: 0.28, h: 1.02, label: 'Ash Bin', sv: 0.05, debris: P.STEEL_DARK },
  lightboxSign: {
    g: gLightboxSign, tier: T.MEDIUM, r: 0.36, h: 3.44, label: 'Neon Sign', shadow: true,
    sv: 0.07,
    /* Rolls the whole sign's hue: the panel is authored dark so it stays dark,
       and the neon frame and channel letters take the colour. A strip of bars
       is no longer one pink swatch repeated 129 times. */
    tint: [0xffffff, 0x8affe8, 0xffe07a, 0xc79aff, 0xffffff], debris: P.NEON_PINK,
  },
  outdoorBar: { g: gOutdoorBar, tier: T.MEDIUM, r: 1.35, h: 1.70, label: 'Outdoor Bar', shadow: true, debris: P.TEAK },
  djBooth: { g: gDjBooth, tier: T.MEDIUM, r: 1.00, h: 1.20, label: 'DJ Booth', shadow: true, sv: 0.04, debris: P.NEON_PURPLE },
  speakerStack: { g: gSpeakerStack, tier: T.SMALL, r: 0.44, h: 1.42, label: 'Speaker Stack', sv: 0.05, debris: P.SIGN_DARK },
  luggageCart: { g: gLuggageCart, tier: T.MEDIUM, r: 0.73, h: 1.50, label: 'Bell Cart', shadow: true, sv: 0.04, debris: P.CHROME },
  drinksTub: { g: gDrinksTub, tier: T.SMALL, r: 0.60, h: 1.00, label: 'Drinks Tub', sv: 0.06, debris: P.ALUMINIUM },
  loungeSofa: {
    g: gLoungeSofa, tier: T.MEDIUM, r: 1.07, h: 0.88, label: 'Lounge Sofa', shadow: true, sv: 0.04,
    tint: [0xffffff, 0xffffff, P.STUCCO_SKY, P.FABRIC_AQUA, P.STUCCO_PEACH, P.STUCCO_LILAC],
    debris: 0xf4f1e8,
  },
  loungeTable: { g: gLoungeTable, tier: T.SMALL, r: 0.52, h: 0.60, label: 'Lounge Table', sv: 0.05, debris: P.TEAK },

  /* storefront dressing ---------------------------------------------------- */
  clothesRail: { g: gClothesRail, tier: T.SMALL, r: 0.62, h: 1.50, label: 'Clothes Rail', sv: 0.06, debris: P.FABRIC_SKY },
  produceStand: { g: gProduceStand, tier: T.MEDIUM, r: 0.67, h: 1.26, label: 'Produce Stand', shadow: true, sv: 0.05, debris: P.WOOD_LIGHT },
  flowerStand: { g: gFlowerStand, tier: T.SMALL, r: 0.61, h: 1.26, label: 'Flower Stand', sv: 0.05, debris: P.FLOWER_MAGENTA },
  deliveryStack: { g: gDeliveryStack, tier: T.SMALL, r: 0.69, h: 1.00, label: 'Delivery Pallet', sv: 0.06, debris: P.WOOD_LIGHT },
  stockTrolley: { g: gStockTrolley, tier: T.MEDIUM, r: 0.58, h: 1.52, label: 'Stock Cage', shadow: true, sv: 0.05, debris: P.STEEL },
  aboardPoster: {
    g: gAboardPoster, tier: T.SMALL, r: 0.48, h: 1.14, label: 'A-Board', sv: 0.07,
    tint: [0xffffff, 0xffd8e4, 0xd8f0e8, 0xffeec8], debris: P.ALUMINIUM,
  },

  /* extra kerbside --------------------------------------------------------- */
  dumpster: {
    g: gDumpster, tier: T.MEDIUM, r: 1.25, h: 1.34, label: 'Skip', shadow: true, sv: 0.05,
    tint: [P.BIN_GREEN, P.CAR_YELLOW, P.BIN_BLUE, P.RUST, P.BIN_GREY], debris: P.BIN_GREY,
  },
  busBench: {
    g: gBusBench, tier: T.SMALL, r: 0.98, h: 1.16, label: 'Advertising Bench', shadow: true,
    sv: 0.04, tint: [0xffffff, 0xffd8e0, 0xd8f0ff, 0xfff0c8], debris: P.TEAK,
  },
  payStation: { g: gPayStation, tier: T.SMALL, r: 0.33, h: 1.75, label: 'Pay Station', debris: P.PARKING_METER },
  wayfindTotem: { g: gWayfindTotem, tier: T.MEDIUM, r: 0.37, h: 2.82, label: 'Wayfinding Pylon', shadow: true, sv: 0.05, debris: P.SIGN_DARK },
  newsKiosk: { g: gNewsKiosk, tier: T.MEDIUM, r: 1.27, h: 2.34, label: 'Newsstand', shadow: true, debris: P.NEWSSTAND },
  meshFence: {
    g: gMeshFence, tier: T.SMALL, r: 1.03, h: 1.97, label: 'Site Fence',
    tint: [0xffffff, 0xe4ece4, 0xd0dcd0], debris: P.STEEL,
  },
  pottedFicus: {
    g: gPottedFicus, tier: T.MEDIUM, r: 0.56, h: 1.80, label: 'Topiary', shadow: true, sv: 0.07,
    tint: [0xffffff, 0xf4e2cc, 0xdcdcd4, 0xd8f0ec], debris: P.TREE_CANOPY,
  },
  binTwin: {
    g: gBinTwin, tier: T.SMALL, r: 0.64, h: 1.02, label: 'Recycling Point', sv: 0.04,
    tint: [0xffffff, 0xe8ece8, 0xf0e8d8], debris: P.BIN_GREEN,
  },
  busStopFlag: { g: gBusStopFlag, tier: T.SMALL, r: 0.12, h: 2.78, label: 'Bus Stop', debris: P.SIGN_BLUE },
  /* Ironwork. TINY on purpose: a cover is the very first thing a fresh hole
     should be able to take, and it is 8 cm tall — anything else would mean a
     manhole surviving a hole that has already swallowed the pavement it is in. */
  manholeCover: {
    g: gManholeCover, tier: T.TINY, r: 0.44, h: 0.05, label: 'Manhole Cover', sv: 0.06,
    tint: [0xffffff, 0xe8dcd0, 0xd0c4b4, 0xf0e8dc], debris: 0x7a6a58,
  },
  /* Second manhole MODEL. See VARIANTS: `manholeCover` placements roll between
     the two, so 529 pieces of pavement ironwork are not one shape. */
  manholeSquare: {
    g: gManholeSquare, tier: T.TINY, r: 0.40, h: 0.05, label: 'Utility Cover', sv: 0.06,
    tint: [0xffffff, 0xe8dcd0, 0xd0c4b4], debris: 0x7a6a58,
  },
  drainGrate: {
    g: gDrainGrate, tier: T.TINY, r: 0.51, h: 0.07, label: 'Drain Grate', sv: 0.06,
    tint: [0xffffff, 0xeae4dc, 0xd8d0c6], debris: 0x6a6259,
  },
  cellarHatch: { g: gCellarHatch, tier: T.TINY, r: 0.81, h: 0.16, label: 'Cellar Hatch', sv: 0.05, debris: P.ALUMINIUM },
  planterUrn: {
    g: gPlanterUrn, tier: T.SMALL, r: 0.50, h: 1.36, label: 'Stone Urn', sv: 0.08,
    crumbles: true, tint: [0xffffff, 0xe8e2d2, 0xf4e6cc, 0xfaf6ee], debris: P.PRECAST,
  },
  planterModern: {
    g: gPlanterModern, tier: T.SMALL, r: 0.72, h: 1.76, label: 'Grass Trough', shadow: true,
    sv: 0.07, tint: [0xffffff, 0xdca882, 0xd8dcd8, 0x9ce0d8], debris: P.BOLLARD_DARK,
  },

  /* park ------------------------------------------------------------------- */
  benchTeak: {
    g: gBenchTeak, tier: T.SMALL, r: 0.85, h: 0.96, label: 'Teak Bench', shadow: true, sv: 0.04,
    /* New honey teak through to silvered grey — a weathered teak bench and a
       new one are never the same colour, and all 235 were one flat TEAK. */
    tint: [P.TEAK, 0xd8a86c, 0xa89a86, 0xc08a52], debris: P.TEAK,
  },
  chessTable: { g: gChessTable, tier: T.SMALL, r: 1.10, h: 0.74, label: 'Chess Table', shadow: true, crumbles: true, debris: P.PRECAST },
  bbqGrill: {
    g: gBbqGrill, tier: T.SMALL, r: 0.44, h: 1.32, label: 'Park Grill', debris: P.SIGN_DARK,
  },
  umbrella: {
    g: gUmbrella, tier: T.MEDIUM, r: 1.30, h: 2.56, label: 'Patio Umbrella', shadow: true,
    tint: [P.FABRIC_CORAL, P.FABRIC_AQUA, P.FABRIC_SUN, P.FABRIC_SKY, P.FABRIC_PINK, P.FABRIC_WHITE],
    debris: P.FABRIC_CORAL,
  },
  parasol: {
    g: gBeachParasol, tier: T.MEDIUM, r: 1.45, h: 2.44, label: 'Beach Parasol', shadow: true,
    tint: [P.FABRIC_SUN, P.FABRIC_CORAL, P.FABRIC_AQUA, P.FABRIC_WHITE], debris: P.FABRIC_SUN,
  },
  parasolSquare: {
    g: gParasolSquare, tier: T.MEDIUM, r: 1.58, h: 2.70, label: 'Market Parasol', shadow: true, sv: 0.05,
    tint: [P.FABRIC_WHITE, P.FABRIC_LIME, P.FABRIC_SKY, P.FABRIC_CORAL, P.FABRIC_SUN,
      P.STUCCO_PEACH, P.FABRIC_AQUA],
    debris: P.FABRIC_WHITE,
  },
  heater: {
    g: gPatioHeater, tier: T.MEDIUM, r: 0.62, h: 2.16, label: 'Patio Heater',
    tint: [0xffffff, 0x8f9694, 0xdfe4e2], debris: P.ALUMINIUM,
  },
  stringPole: {
    g: gStringPole, tier: T.MEDIUM, r: 0.28, h: 3.30, label: 'String-Light Pole', shadow: true,
    sv: 0.06, tint: [0xffffff, 0xe4cba8, 0xd8d0c4], debris: P.WOOD_DARK,
  },

  /* micromobility --------------------------------------------------------- */
  bicycle: { g: gBicycle, tier: T.MEDIUM, r: 0.75, h: 1.05, label: 'Bicycle', tint: [0xf2f2f2, P.CAR_TEAL, P.CAR_CORAL, P.CAR_YELLOW, P.CAR_MINT], debris: P.STEEL },
  bikeRack: {
    g: gBikeRack, tier: T.SMALL, r: 0.62, h: 0.75, label: 'Bike Rack',
    tint: [0xdfe4e2, 0x8fae94, 0xb7bdbb], debris: P.STEEL,
  },
  scooter: { g: gScooter, tier: T.MEDIUM, r: 0.52, h: 1.05, label: 'E-Scooter', tint: [0xf4f4f4, P.NEON_AQUA, P.ACCENT_HOT, P.CAR_LIME], debris: P.NEON_AQUA },

  /* lighting -------------------------------------------------------------- */
  lampModern: {
    g: gLampModern, tier: T.MEDIUM, r: 0.30, h: 7.00, label: 'Street Light', shadow: true,
    sv: 0.04, tint: [0xffffff, 0xc8ccc8, 0xd8c8b0], debris: P.LAMP_POST,
  },
  lampDeco: {
    g: gLampDeco, tier: T.MEDIUM, r: 0.48, h: 4.72, label: 'Deco Lamp Post', shadow: true,
    sv: 0.04, tint: [0xffffff, 0xbcd4c0, 0xd8c8a8, 0xc8ccc8], debris: P.BENCH_METAL,
  },
  /* Same post with its flower baskets modelled in. See gLampDeco for why they
     are not props of their own any more. */
  lampDecoBasket: {
    g: gLampDecoBasket, tier: T.MEDIUM, r: 0.52, h: 4.72, label: 'Deco Lamp Post', shadow: true,
    sv: 0.04, tint: [0xffffff, 0xffd8e8, 0xffe0c8, 0xbcd4c0], debris: P.BENCH_METAL,
  },
  lampPark: {
    g: gLampPark, tier: T.MEDIUM, r: 0.26, h: 3.98, label: 'Park Lamp', shadow: true, sv: 0.04,
    tint: [0xffffff, 0xbcd4c0, 0xd8c8a8], debris: P.BENCH_METAL,
  },

  /* transit + vending ----------------------------------------------------- */
  busShelter: { g: gBusShelter, tier: T.LARGE, r: 2.30, h: 2.62, label: 'Bus Shelter', shadow: true, debris: P.ALUMINIUM },
  foodCart: { g: gFoodCart, tier: T.MEDIUM, r: 1.20, h: 2.56, label: 'Food Cart', shadow: true, debris: P.FABRIC_SUN },
  hotdogStand: { g: gHotdogStand, tier: T.MEDIUM, r: 0.85, h: 2.40, label: 'Hot-Dog Stand', shadow: true, debris: P.FABRIC_CORAL },
  displayRack: { g: gDisplayRack, tier: T.MEDIUM, r: 0.70, h: 1.55, label: 'Display Rack', shadow: true, debris: P.FABRIC_CORAL },
  produceCrate: { g: gProduceCrate, tier: T.SMALL, r: 0.40, h: 0.52, label: 'Produce Crate', debris: P.WOOD_LIGHT },

  /* construction ---------------------------------------------------------- */
  jersey: {
    g: gJersey, tier: T.MEDIUM, r: 1.05, h: 0.80, label: 'Jersey Barrier', shadow: true,
    crumbles: true, tint: [0xffffff, 0xe2ded2, 0xf2ede0, 0xd4cec0], debris: P.PRECAST,
  },
  waterBarrier: {
    g: gWaterBarrier, tier: T.SMALL, r: 0.95, h: 1.14, label: 'Water Barrier',
    tint: [0xffffff, P.BARRIER_ORANGE, 0xffffff, P.ACCENT_SUN], debris: P.BARRIER_ORANGE,
  },
  aframe: {
    g: gAframe, tier: T.SMALL, r: 0.60, h: 1.05, label: 'Barricade',
    tint: [0xffffff, 0xece6d6, 0xd8d2c2], debris: P.BARRIER_ORANGE,
  },
  barrel: {
    g: gTrafficBarrel, tier: T.SMALL, r: 0.43, h: 0.92, label: 'Traffic Barrel', sv: 0.05,
    tint: [0xffffff, 0xffeadc, 0xe0d8cc], debris: P.BARRIER_ORANGE,
  },
  crate: {
    g: gCrate, tier: T.SMALL, r: 0.56, h: 0.73, label: 'Crate', sv: 0.09,
    tint: [0xffffff, 0xe8dcc8, 0xd6c4a8, 0xf4ece0], debris: P.WOOD_DECK,
  },
  pallet: {
    g: gPallet, tier: T.SMALL, r: 0.75, h: 0.50, label: 'Pallet Stack', sv: 0.07,
    tint: [0xffffff, 0xd8d4cc, 0xc8d4e0, 0xf0e2cc], debris: P.WOOD_LIGHT,
  },
  scaffold: { g: gScaffold, tier: T.MEDIUM, r: 0.75, h: 1.96, label: 'Scaffold Tower', shadow: true, sv: 0.06, debris: P.SCAFFOLD },
  cableDrum: {
    g: gCableDrum, tier: T.MEDIUM, r: 0.80, h: 1.56, label: 'Cable Reel', shadow: true, sv: 0.08,
    tint: [0xffffff, 0xe4d0b0, 0xcbb08a], debris: P.WOOD_DECK,
  },
  sandbags: {
    g: gSandbags, tier: T.SMALL, r: 0.56, h: 0.50, label: 'Sandbags', sv: 0.09,
    tint: [0xffffff, 0xe8dcc0, 0xd8ccb4], debris: P.SAND,
  },
  portaloo: {
    g: gPortaloo, tier: T.MEDIUM, r: 0.82, h: 2.30, label: 'Portaloo', shadow: true,
    tint: [0xffffff, 0xe6eef2, 0xdce2de], debris: 0xffffff,
  },
};

/** Which material each pool renders with. */
const MAT_OF = {
  bollard: 'metal', stanchion: 'metal', bikeRack: 'metal', scaffold: 'metal',
  cleat: 'metal', busShelter: 'gloss', heater: 'metal',
  umbrella: 'fabric', parasol: 'fabric', parasolSquare: 'fabric',
  bollardBell: 'metal', standpipe: 'metal',
  velvetRope: 'metal', cigBin: 'metal', meshFence: 'metal', clothesRail: 'metal',
  dumpster: 'metal', barStool: 'metal', keyBoard: 'metal',
  terraceRail: 'gloss', pastryCase: 'gloss',
  cafeTableCloth: 'fabric', carpetRunner: 'fabric',
  terraceAwning: 'fabric', loungeSofa: 'fabric',
  iceBucket: 'metal', drinksTub: 'metal', luggageCart: 'metal',
  stockTrolley: 'metal', binTwin: 'metal', gelatoCase: 'gloss',
  manholeCover: 'metal', manholeSquare: 'metal', drainGrate: 'metal', cellarHatch: 'metal',
};

const _geoCache = new Map();
function geometryFor(key) {
  let geo = _geoCache.get(key);
  if (!geo) {
    const m = new M();
    DEFS[key].g(m);
    geo = m.geometry();
    _geoCache.set(key, geo);
  }
  return geo;
}

function factoryFor(key) {
  return () => ({ geometry: geometryFor(key), material: mat(MAT_OF[key] || 'prop') });
}

/**
 * What this prop actually puts on the ground, measured off its own merged
 * geometry exactly the way worldBuild measures it (the horizontal extent of the
 * lowest fifth of the object).
 *
 * The `r` values in DEFS were authored by eye and worldBuild now ignores them
 * for the physics, so a placer that still reserved them was reserving a number
 * nothing else in the game believes: `parasol` claimed 1.45 m for a 12 cm pole,
 * so nothing could stand under a canopy that is meant to shade loungers, while
 * `benchSlat` claimed 1.00 against a true 0.94 and quietly rejected the bin
 * that belongs beside it. Reserve what the mesh occupies and both stop.
 */
const _contactCache = new Map();
function contactBox(key) {
  let m = _contactCache.get(key);
  if (m !== undefined) return m;
  const geo = geometryFor(key);
  if (!geo.boundingBox) geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const hiLocal = bb.min.y + (bb.max.y - bb.min.y) * 0.20;
  const pos = geo.attributes.position;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > hiLocal) continue;
    const x = pos.getX(i), z = pos.getZ(i);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (!(maxX > minX)) { minX = bb.min.x; maxX = bb.max.x; minZ = bb.min.z; maxZ = bb.max.z; }
  m = {
    hx: (maxX - minX) / 2,
    hz: (maxZ - minZ) / 2,
    r: Math.hypot(maxX - minX, maxZ - minZ) / 2,
  };
  _contactCache.set(key, m);
  return m;
}
const contactRadius = (key) => contactBox(key).r;

/* ========================================================== placer ====== */

/**
 * Kinds that exist as more than one MODEL.
 *
 * Per-instance colour and scale break a repeat up to a point; past a few
 * hundred copies the SHAPE is what the eye locks onto, and 529 identical
 * round plates on a road is the single most countable repeat in the module.
 * Rather than thread a second key through twenty weighted placement tables,
 * `put` rolls the family here — every existing call site keeps working and
 * gets model variety for free.
 */
const VARIANTS = {
  manholeCover: ['manholeCover', 'manholeCover', 'manholeSquare'],
};

const SIDE_ROT = { n: Math.PI, s: 0, w: -Math.PI / 2, e: Math.PI / 2 };

/* ------------------------------------------------------ ground surfaces -- */

/**
 * Bridge decks and their approach ramps, replicated from streets.js.
 *
 * These two numbers are a contract streets.js and vehicles.js already share
 * (`streets.js: DECK_Y / DECK_RAMP`, `vehicles.js: deckHeight()`); this module
 * only needs to know WHERE the ground stops being flat. Kerb furniture placed
 * inside the skirt was landing at Y_WALK against a carriageway that had climbed
 * to 1.04 m, so 163 props were buried up to the shoulders in tarmac. Nothing
 * this module makes belongs on a crossing — streets.js stands the bridge's own
 * lamps — so the whole skirt is simply refused.
 */
const DECK_Y = 1.2;
const DECK_RAMP = 7;

function deckHeight(bridges, x, z) {
  for (let i = 0; i < bridges.length; i++) {
    const b = bridges[i];
    const kx = (b.width * 0.5 + DECK_RAMP - Math.abs(x - b.x)) / DECK_RAMP;
    if (kx <= 0) continue;
    const kz = (b.length * 0.5 + DECK_RAMP - Math.abs(z - b.z)) / DECK_RAMP;
    if (kz <= 0) continue;
    const k = Math.min(1, kx) * Math.min(1, kz);
    if (k > 0) return DECK_Y * k;
  }
  return 0;
}

/**
 * THE SURFACE THE CITY ACTUALLY BUILT.
 *
 * Every prop in this module used to be planted at exactly `Y_WALK`, on the
 * theory that street furniture stands on the sidewalk. The sidewalk is only one
 * of eight surfaces it stands on, and an audit against the built geometry found
 * 402 props off their own ground:
 *
 *    0.000  carriageway, and every prop whose run overshot a block corner
 *    0.064  the flush part of a KERB RAMP — streets.js drops the whole kerb
 *           profile at every crossing, so the 5 m either side of a corner is
 *           not at Y_WALK at all
 *    0.142  the planted median island
 *    0.155  Y_WALK, the sidewalk
 *    0.170  a park lawn (nature.js lays turf 15 mm proud of the paving)
 *    0.225  a feature apron, sports court, sandpit, plaza inlay or raised bed
 *
 * Those numbers belong to streets.js and nature.js and will move when either is
 * edited, so hard-coding a table of them would have been wrong within a week.
 * Both modules have already RUN by the time this one does — their geometry is
 * in the scene — so this measures the ground instead of predicting it, exactly
 * as worldBuild now measures prop size instead of trusting a declaration.
 *
 * Only near-horizontal faces below CEIL count. That threshold is what separates
 * "ground" from "a thing standing on the ground": every paved, planted and
 * decked surface in the city tops out at 0.23, and the next thing up is a pond
 * rim at 0.34. Above CEIL a prop would be standing on the furniture.
 */
const GROUND_CEIL = 0.30;

/**
 * Below this, the sampled surface is not a place to put furniture.
 *
 * It catches the carriageway (0.0), the gutter pan, the kerb face — and, the
 * reason it is 40 mm under Y_WALK rather than at zero, the crossing ramps. A
 * ramp runs from 0.064 at the kerb to Y_WALK 1.9 m back, so this refuses the
 * dropped part and accepts the level part behind it. That is the right rule
 * twice over: it stops the float, and it keeps bins and bike racks out of the
 * wheelchair crossing, which is where a city puts nothing at all.
 */
const GROUND_MIN = 0.115;

const _box = new THREE.Box3();

class Ground {
  constructor(scene) {
    this.cell = 6;
    this.grid = new Map();
    this.t = [];
    scene.traverse((n) => {
      if (!n.isMesh || n.isInstancedMesh) return;
      // Buildings are the one group with no walkable surface of its own and by
      // far the most triangles; skipping it halves the build cost.
      for (let p = n; p; p = p.parent) if (p.name === 'buildings') return;
      this._add(n);
    });
  }

  _add(n) {
    const geo = n.geometry;
    const pos = geo.attributes.position;
    if (!pos) return;
    // Cheap reject: a mesh entirely above the ceiling cannot contribute.
    if (!geo.boundingBox) geo.computeBoundingBox();
    n.updateWorldMatrix(true, false);
    _box.copy(geo.boundingBox).applyMatrix4(n.matrixWorld);
    if (_box.min.y > GROUND_CEIL) return;
    const m = n.matrixWorld.elements;
    const idx = geo.index;
    const cnt = idx ? idx.count : pos.count;
    const t = this.t, c = this.cell;
    const ax = [0, 0, 0], ay = [0, 0, 0], az = [0, 0, 0];
    for (let i = 0; i < cnt; i += 3) {
      let hi = -Infinity;
      for (let k = 0; k < 3; k++) {
        const j = idx ? idx.getX(i + k) : i + k;
        const px = pos.getX(j), py = pos.getY(j), pz = pos.getZ(j);
        ax[k] = m[0] * px + m[4] * py + m[8] * pz + m[12];
        ay[k] = m[1] * px + m[5] * py + m[9] * pz + m[13];
        az[k] = m[2] * px + m[6] * py + m[10] * pz + m[14];
        if (ay[k] > hi) hi = ay[k];
      }
      if (hi > GROUND_CEIL) continue;
      // Upward-facing only: the underside of a slab is not somewhere to stand.
      const ny = (az[1] - az[0]) * (ax[2] - ax[0]) - (ax[1] - ax[0]) * (az[2] - az[0]);
      if (ny <= 0) continue;
      const base = t.length;
      t.push(ax[0], az[0], ay[0], ax[1], az[1], ay[1], ax[2], az[2], ay[2]);
      const i0 = Math.floor(Math.min(ax[0], ax[1], ax[2]) / c);
      const i1 = Math.floor(Math.max(ax[0], ax[1], ax[2]) / c);
      const j0 = Math.floor(Math.min(az[0], az[1], az[2]) / c);
      const j1 = Math.floor(Math.max(az[0], az[1], az[2]) / c);
      // The base plane is emitted as a few enormous quads; bucketing those into
      // every cell they touch would put the whole city in one bucket. They are
      // below GROUND_MIN anyway, so nothing is lost by leaving them out.
      if (i1 - i0 > 24 || j1 - j0 > 24) continue;
      for (let i2 = i0; i2 <= i1; i2++) {
        for (let j2 = j0; j2 <= j1; j2++) {
          const k = (i2 + 4096) * 16384 + (j2 + 4096);
          let b = this.grid.get(k);
          if (!b) { b = []; this.grid.set(k, b); }
          b.push(base);
        }
      }
    }
  }

  /** Height of the highest ground under (x,z), or null where there is none. */
  at(x, z) {
    const c = this.cell;
    const b = this.grid.get((Math.floor(x / c) + 4096) * 16384 + (Math.floor(z / c) + 4096));
    if (!b) return null;
    const t = this.t;
    let best = null;
    for (let n = 0; n < b.length; n++) {
      const i = b[n];
      const ax = t[i], az = t[i + 1], bx = t[i + 3], bz = t[i + 4], cx = t[i + 6], cz = t[i + 7];
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (d > -1e-9 && d < 1e-9) continue;
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      if (l1 < 0 || l1 > 1) continue;
      const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      if (l2 < 0 || l2 > 1) continue;
      const l3 = 1 - l1 - l2;
      if (l3 < 0) continue;
      const y = l1 * t[i + 2] + l2 * t[i + 5] + l3 * t[i + 8];
      if (best === null || y > best) best = y;
    }
    return best;
  }
}

/**
 * Which registered entities this module treats as scenery it must not sit in.
 *
 * nature.js and buildings.js both run before this one, so everything they
 * placed is in the registry with a footprint measured from its own geometry —
 * far better information than the shared 3 m occupancy grid. But buildings are
 * one-off MESHES whose bounding circle is 7 m for a storefront and 28 for a
 * tower, which covers the entire pavement this module has to work on; gating
 * placement on those leaves the city bare. Everything nature.js plants is
 * INSTANCED, so backing is the honest discriminator, and it is a better one
 * than the radius cut it replaces: that cut was 3.2 m, and the four things it
 * silently let props stand inside — sea grape (5.4 m), playground (4.3),
 * pergola (3.7) and the park fountains (5.8 and 9.4) — are all bigger.
 */
const isScenery = (c) => !!c.pool;

/** How far the registry has to be asked around a site. The largest scenery. */
const SCENERY_MAX_R = 9.5;

/**
 * How much of two footprints may overlap before it reads as a defect. Matched
 * to the audit's own penetration test (`(ra+rb)*0.62 - d > 0.25`) with the
 * slack removed, so what gets rejected here is exactly what gets counted there.
 */
const SCENERY_FIT = 0.62;

/** Metres to slide a refused prop along its own line before giving up on it. */
const SLIDE = [0, 1.15, -1.15, 2.4, -2.4];

/** Unit vector along a block edge, in the same sense `edgePt`'s `u` runs. */
const EDGE_DIR = { n: [1, 0], s: [1, 0], w: [0, 1], e: [0, 1] };

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
    this.tried = 0;
    this.cell = 1.6;
    this.grid = new Map();
    this.bridges = ctx.layout.bridges || [];
    this._near = [];
    this.ground = new Ground(ctx.scene);
    this.rejected = { water: 0, bridge: 0, scenery: 0, occupied: 0, road: 0, void: 0 };
    /* Named counters for the COMPOSED layouts. A terrace or an entrance is
       either there or it is not, and when it is not there is nothing in the
       frame to notice — unlike a missing bin, which is invisible. The first
       cut of the terrace lost four out of five of its boundary screens to
       street trees on the kerb line and nobody could have seen that from a
       screenshot; the counters are how it was found. */
    this.tally = { terrace: 0, terraceEdge: 0, terraceEdgeLost: 0, entrance: 0, entranceLost: 0 };
  }

  /**
   * Would this footprint interpenetrate scenery some earlier module placed?
   * See SCENERY_MAX_R for why buildings are deliberately not consulted here.
   */
  sceneryClear(x, z, r) {
    const near = this.ctx.registry.query(x, z, r + SCENERY_MAX_R, this._near);
    for (let i = 0; i < near.length; i++) {
      const c = near[i];
      if (!isScenery(c)) continue;
      const reach = (r + c.radius) * SCENERY_FIT;
      const dx = c.position.x - x, dz = c.position.z - z;
      if (dx * dx + dz * dz < reach * reach) return false;
    }
    return true;
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
   * Reserve the FEET of a prop that stands on two or four of them.
   *
   * A bounding circle is the wrong reservation for a gate, a bar counter or an
   * entrance canopy: `contactRadius` returns the circle through the corners of
   * the contact patch, so a 4 m festoon arch would reserve 2.2 m of terrace it
   * does not touch and refuse every table meant to sit under it. Those props
   * pass a small `claimR` for their hub and then claim their real feet here —
   * half a metre of ground each, exactly where the geometry lands.
   *
   * @param {number} rot the prop's yaw; feet are offset along its local +x
   * @param {number[]} offs foot positions along local x
   */
  claimFeet(x, z, rot, offs, r) {
    const ax = Math.cos(rot), az = -Math.sin(rot);
    for (const o of offs) this.claim(x + ax * o, z + az * o, r);
  }

  /**
   * `claimFeet` for a prop whose feet are not in a line.
   *
   * A festoon gate and a rope line have two feet on one axis, so an array of
   * offsets along local x says everything about them. A terrace awning has
   * four, in two rows 1.8 m apart across the pavement — reserving the midline
   * between them would leave both rows of posts unclaimed and let a table land
   * inside one.
   *
   * @param {Array<[number, number]>} pts foot positions in local (x, z)
   */
  claimLocal(x, z, rot, pts, r) {
    const c = Math.cos(rot), s = Math.sin(rot);
    for (const [lx, lz] of pts) this.claim(x + lx * c + lz * s, z - lx * s + lz * c, r);
  }

  /**
   * @param {number} [claimR] ground footprint to test and reserve. Defaults to
   *   the prop's MEASURED contact footprint; pass 0 for things that legitimately
   *   share a footprint with something already placed (a basket hanging off a
   *   lamp bracket), or an explicit value where the mesh understates what the
   *   object needs (a parasol stands on a 12 cm pole but shades 2.8 m).
   * @param {boolean} [onRoad] this site IS the carriageway on purpose — a cone
   *   taper closing a lane. Everything else is refused there.
   * @returns {boolean} placed
   */
  put(key, x, z, rot = 0, scale = 1, hex = null, claimR = -1, onRoad = false) {
    const fam = VARIANTS[key];
    if (fam) key = fam[Math.floor(this.rng() * fam.length)];
    const d = DEFS[key];
    if (!d) return false;
    this.tried++;
    /* ANTI-REPETITION, applied HERE rather than at emit time so that the
       footprint this reserves is the footprint the prop actually has. Nothing
       in a real street is made to the same tolerance twice; a few percent of
       size spread is what stops a kerb run of nine planters reading as nine
       copies of a planter, and it costs no triangles and no draw calls. */
    if (d.sv) scale *= 1 + (this.rng() - 0.5) * 2 * d.sv;
    // A prop in the bay or halfway up a bridge ramp is wrong however tidily it
    // is spaced, so the site is disqualified before anything else is tested.
    if (this.ctx.layout.isWater(x, z)) { this.rejected.water++; return false; }
    if (deckHeight(this.bridges, x, z) > 0.02) { this.rejected.bridge++; return false; }
    // Whatever surface is really here is where this prop stands — and if that
    // surface is the road, the gutter or a crossing ramp, it does not stand.
    const gy = this.ground.at(x, z);
    if (gy === null) { this.rejected.void++; return false; }
    if (!onRoad && gy < GROUND_MIN) { this.rejected.road++; return false; }
    if (claimR !== 0) {
      const foot = claimR < 0 ? Math.max(0.25, contactRadius(key) * scale) : claimR;
      if (!this.free(x, z, foot + 0.10)) { this.rejected.occupied++; return false; }
      if (!this.sceneryClear(x, z, foot)) { this.rejected.scenery++; return false; }
      this.claim(x, z, foot + 0.10);
    }
    this.items.push({ key, x, z, rot, scale, hex, y: gy });
    return true;
  }

  /**
   * Place at (x,z) or, failing that, a little way along the line (ux,uz).
   *
   * A kerb run is a rhythm, not a set of fixed points. Once the placer started
   * refusing sites that sat inside a park hedge or a bandshell apron, refusing
   * outright cost the city a fifth of its street furniture — where sliding the
   * bin a metre down the same kerb keeps the rhythm, the density AND the fix.
   */
  putAlong(key, x, z, ux, uz, rot = 0, scale = 1, hex = null, claimR = -1, onRoad = false) {
    for (let i = 0; i < SLIDE.length; i++) {
      const t = SLIDE[i];
      if (this.put(key, x + ux * t, z + uz * t, rot, scale, hex, claimR, onRoad)) return t;
    }
    return null;
  }

  /**
   * Soft-hint variant: nudge off anything the shared grid already knows about,
   * then place anyway.
   *
   * The forcing tail is deliberate on a built block — buildings.js claims
   * `max(w,d)*0.5` around the block centre, which on a 3 m grid swallows the
   * pavement too, so an honest `isFree` gate there leaves the city bare (see
   * the file header). `strict` turns the tail off, and the three zones that
   * carry no building at all — park, plaza, marina apron — pass it, because
   * there the only thing objecting is nature.js's pond, bandshell or fountain
   * apron, and a picnic table in the pond is not a trade worth making.
   */
  putSoft(key, x, z, rot = 0, scale = 1, hex = null, claimR = -1, onRoad = false, strict = false) {
    const r = this.rng;
    // Strict callers get more candidates because they have no fallback: the
    // shared grid over-claims badly (a bandshell's `occupy(r=17)` marks a 35 m
    // square on a 3 m grid), so a single dice roll inside a park throws away
    // furniture that had somewhere perfectly good to stand five metres away.
    const tries = strict ? 8 : 4;
    for (let t = 0; t < tries; t++) {
      const jx = t === 0 ? 0 : (r() - 0.5) * 5.0;
      const jz = t === 0 ? 0 : (r() - 0.5) * 5.0;
      if (!this.ctx.isFree(x + jx, z + jz, 0)) continue;
      if (this.put(key, x + jx, z + jz, rot, scale, hex, claimR, onRoad)) return true;
    }
    if (strict) { this.rejected.occupied++; return false; }
    return this.put(key, x, z, rot, scale, hex, claimR, onRoad);
  }

  /**
   * `putSoft` that gives up rather than forcing.
   *
   * ONLY for blocks that carry no building: park, plaza and marina apron.
   * A construction site and a parking structure both register a mesh, and
   * buildings.js claims `radius * 0.92` around it — 20 m on a construction
   * parcel — which carpets the whole block on the shared grid. Using this there
   * does not tidy the yard, it empties it.
   */
  putOpen(key, x, z, rot = 0, scale = 1, hex = null, claimR = -1) {
    return this.putSoft(key, x, z, rot, scale, hex, claimR, false, true);
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
        position: new THREE.Vector3(it.x, it.y, it.z),
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
      const foot = contactRadius(it.key) * (typeof it.scale === 'number' ? it.scale : 1);
      ctx.occupy(it.x, it.z, foot > 1.2 ? foot : 0);
    }
    for (const [key, n] of counts) {
      const g = _geoCache.get(key);
      if (g) tris += (g.index.count / 3) * n;
    }
    const rj = this.rejected;
    const ty = this.tally;
    console.info(
      `[props] ${counts.size} pools / ${this.items.length} instances / ` +
      `${(tris / 1000).toFixed(0)}k tris / ` +
      `${((this.items.length / this.tried) * 100).toFixed(0)}% of ${this.tried} attempts placed ` +
      `| refused: ${rj.occupied} occupied, ${rj.scenery} into scenery, ` +
      `${rj.bridge} on a bridge, ${rj.water} in water, ` +
      `${rj.road} on the carriageway or a crossing ramp, ${rj.void} over nothing`
    );
    console.info(
      `[props] composed: ${ty.terrace} terraces ` +
      `(${ty.terraceEdge} boundary sections, ${ty.terraceEdgeLost} refused), ` +
      `${ty.entrance} entrances (${ty.entranceLost} refused)`
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
  dressMedians(pl, ctx.layout, makeRNG(0x3d1a97));
  pl.emit();
  wireNight(ctx);
}

/**
 * Point the shared glow uniform at the engine's published nightFactor.
 *
 * See NIGHT_U for why this rides on onBeforeRender. In short: it is the only
 * per-frame callback this module can rely on without an agreement from the
 * file that owns the game loop. It runs immediately before each pool is drawn,
 * so the value the first prop mesh writes is the value every prop mesh reads
 * in the same frame — no one-frame lag, no ordering assumption.
 */
function wireNight(ctx) {
  const scene = ctx.scene;
  const sync = () => {
    const n = scene.userData.nightFactor;
    NIGHT_U.value = (typeof n === 'number' ? n : 0) * GLOW_GAIN;
  };
  sync();
  for (const key of Object.keys(DEFS)) {
    const pool = ctx.props.pools.get(key);
    if (pool) pool.mesh.onBeforeRender = sync;
  }
  // Published for whoever eventually owns a module update list. Idempotent, so
  // being called as well as (or instead of) the render hook changes nothing.
  scene.userData.propsUpdate = sync;
}

/**
 * Landscaped medians. Brickell Ave and Biscayne Blvd are boulevards with a
 * planted island down the middle, and a rhythm of Deco twin-globe posts along
 * it is the single most recognisable thing about them from the air. It also
 * fixes a gameplay problem: the starting camera frames a junction, and without
 * this the whole middle of the frame is bare asphalt with nothing to eat.
 *
 * The island is not continuous, and predicting where it stops is a losing game:
 * streets.js drops it across junctions, across the bridges, wherever the road
 * runs dry-to-wet, and wherever what is left would be under 18 m long. So this
 * places on the island's own vocabulary and lets the surface sample decide —
 * the six props that used to end up marooned on bare asphalt where a short run
 * had been dropped are now simply refused.
 */
function dressMedians(pl, layout, rng) {
  const S = WORLD.SIZE;
  for (const road of layout.medians) {
    const alongX = road.axis === 'z';               // constant z, runs along x
    const cross = alongX ? layout.roadsX : layout.roadsZ;
    const lo = alongX ? -S + 30 : -S + 30;
    const hi = alongX ? WORLD.BAY_EDGE - 30 : S - 30;

    /* The island is NOT empty ground. streets.js runs a solid clipped hedge
       spine down its centre — 0.13 m to 0.99 m tall, half-width
       min(1.15, medianW/2 - 1.1) — and everything shorter than a metre that
       this module planted on the centreline was simply inside it: 95 props
       buried in a hedge. Low furniture therefore goes in the soil strip
       between the hedge and the median kerb, which is where it belongs anyway.
       Lamp standards stay on the centreline: a post rising out of a planted
       median is the correct thing, and the rhythm is the point. */
    const halfW = (road.medianW || 7) * 0.5;
    const hedge = Math.max(0, Math.min(1.15, halfW - 1.1));
    const kerbIn = halfW - 0.75;

    let sinceLamp = 12;
    for (let t = lo; t < hi; t += 4.0 + rng() * 2.5) {
      // Stay out of the junction boxes and the painted nose tapers.
      let clear = true;
      for (const c of cross) {
        if (Math.abs(t - c.pos) < c.half + 13) { clear = false; break; }
      }
      if (!clear) continue;
      const x = alongX ? t : road.pos;
      const z = alongX ? road.pos : t;
      if (layout.isWater(x, z)) continue;

      sinceLamp += 4.0;
      const rotAlong = alongX ? Math.PI / 2 : 0;
      if (sinceLamp > 25) {
        if (pl.putSoft('lampDeco', x, z, rotAlong)) sinceLamp = 0;
        continue;
      }
      const key = rng.weighted([
        ['uplighter', 9], ['planterRound', 3], ['planterUrn', 3], ['planterModern', 3],
        ['bollardStone', 2], ['bollardBell', 2], ['planterTrough', 3],
      ]);
      // Uplighters graze the hedge, so they sit right against its face; planting
      // needs its own clear soil between hedge and kerb.
      const pr = contactRadius(key);
      const nearFace = hedge + pr + 0.12;
      const farFace = kerbIn - pr;
      if (farFace < nearFace) continue;
      const off = (key === 'uplighter' ? nearFace : nearFace + rng() * (farFace - nearFace))
        * (rng.chance(0.5) ? -1 : 1);
      const px = alongX ? x : road.pos + off;
      const pz = alongX ? road.pos + off : z;
      // Uplighters aim across the hedge; the rest face along the road with it.
      const rot = key === 'uplighter'
        ? rotAlong + (off > 0 ? -Math.PI / 2 : Math.PI / 2)
        : rotAlong;
      pl.put(key, px, pz, rot);
    }
  }
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

  /* DESIGNED PLACES GO DOWN FIRST.
     Site hoarding, a restaurant terrace and a hotel entrance are all COMPOSED
     layouts: they need a contiguous piece of pavement and they read as one
     thing or as nothing. The kerb run is the opposite — a rhythm that is happy
     to flow round whatever is already there. Running the composed layouts last
     (which the hoarding did once, and cost most of itself to bins that had
     already taken the kerb) gets the priority exactly backwards. */
  if (Z === ZONE.CONSTRUCTION) constructionYard(pl, b, r, band);
  /* The pop-up bar is a composed layout too, and it needs 4 m of genuinely
     clear ground for the counter, the booth and the PA. Called from inside
     plazaFurniture/parkFurniture/marinaApron it ran AFTER the kerb line and the
     promenade had claimed their rings, and a citywide audit found it landing
     zero times — the whole nightlife group existed in the code and nowhere in
     the game. It goes with the other designed places, first. */
  if (open) eventCorner(pl, b, r);
  const shoppy = Z === ZONE.RETAIL || Z === ZONE.LOWRISE;
  if (shoppy && life > 0.32 && band > 3.3) restaurantTerrace(pl, b, r, band);
  if ((Z === ZONE.TOWER || Z === ZONE.LANDMARK || Z === ZONE.MIDRISE
      || (shoppy && life > 0.5)) && band > 4.0) hotelEntrance(pl, b, r, band);

  for (const s of sides) kerbRun(pl, b, s, r, band, life);
  if (!open && band > 2.3) for (const s of sides) facadeRun(pl, b, s, r, band, life);
  if (open) openPerimeter(pl, b, r);
  cornerDressing(pl, b, r);

  switch (Z) {
    case ZONE.CONSTRUCTION: break;   // already dressed, above the kerb run
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
  if (b.bayfront && Z !== ZONE.PARK) beachFront(pl, b, r);
}

/* ------------------------------------------------------------ kerb line -- */

/**
 * What tends to stand next to what. Pairing is most of the difference between
 * "scattered props" and "a street somebody maintains".
 */
const COMPANION = {
  benchSlat: ['binMuni', 'binMesh', 'planterRound'],
  benchConcrete: ['binMuni', 'planterSquare'],
  benchBackless: ['binMesh', 'dogStation'],
  binMuni: ['newsBox', 'cone'],
  binWheelie: ['binWheelie', 'crate'],
  planterRound: ['planterRound', 'bollard'],
  planterSquare: ['planterSquare', 'benchSlat'],
  planterTrough: ['planterRound'],
  signStop: ['bollard', 'hydrant'],
  signStreet: ['meter', 'newsBox'],
  meter: ['meter', 'bollard'],
  newsBox: ['newsBox', 'binMesh'],
  hydrant: ['bollard'],
  bollard: ['bollard', 'bollard'],
  bollardStone: ['bollardStone'],
  cone: ['cone', 'cone'],
  hotdogStand: ['binMesh', 'crate'],
  foodCart: ['binMesh', 'crate', 'sandwichBoard'],
  cafeTable: ['cafeChair'],
  utilityBox: ['bollard'],
  crate: ['crate', 'pallet'],
  pottedPalm: ['pottedPalm'],
  displayRack: ['produceCrate', 'sandwichBoard'],
  produceCrate: ['produceCrate', 'crate'],
  mailbox: ['newsBox'],
  atmKiosk: ['bollard'],
  phoneKiosk: ['binMesh'],
  busBench: ['binMesh', 'binMuni'],
  payStation: ['bollard', 'signParking'],
  wayfindTotem: ['bollard', 'binMesh'],
  dumpster: ['binWheelie', 'pallet', 'crate'],
  cigBin: ['binMesh'],
  newsKiosk: ['binMuni', 'bollard'],
  clothesRail: ['clothesRail', 'sandwichBoard'],
  produceStand: ['produceCrate', 'crate'],
  flowerStand: ['produceCrate', 'planterRound'],
  deliveryStack: ['deliveryStack', 'binWheelie'],
  pottedFicus: ['pottedFicus'],
  benchTeak: ['binMesh', 'planterRound'],
  lightboxSign: ['cigBin'],
  barStool: ['barStool'],
  bollardBell: ['bollardBell', 'bollardBell'],
  planterUrn: ['planterUrn', 'bollardBell'],
  planterModern: ['planterModern', 'benchCurve'],
  benchCurve: ['binTwin', 'planterModern'],
  binTwin: ['newsBox', 'aboardPoster'],
  trashBags: ['trashBags', 'binWheelie'],
  stockTrolley: ['deliveryStack', 'crate'],
  aboardPoster: ['sandwichBoard', 'pottedFicus'],
  barrelTable: ['barStool', 'barrelTable'],
  standpipe: ['bollardBell'],
  gelatoCase: ['binMesh', 'chairStack'],
  chairStack: ['chairStack'],
  busStopFlag: ['binMesh', 'busBench'],
  cableDrum: ['pallet', 'crate'],
};

/** Weighted kerbside vocabulary for a block. */
/**
 * Weighted kerbside vocabulary for a block.
 *
 * The weights are spread deliberately THIN across many models rather than
 * concentrated on a few. The first cut of this table had `bollard` at 7 and
 * `planterRound` at 6 out of ~60 total weight, and the result was 875 identical
 * bollards and a city where every third planter was the same round pot — the
 * exact defect the brief names. Adding a model is worth far more here than
 * adding a placement: a third bollard and a third and fourth planter take the
 * same ground and the same triangles and stop the eye counting copies.
 */
function kerbTable(b) {
  const t = [
    ['bollard', 4], ['bollardBell', 4], ['binMuni', 5], ['binWheelie', 4],
    ['planterRound', 4], ['planterSquare', 3], ['planterUrn', 4], ['planterModern', 3],
    ['benchSlat', 4], ['signStreet', 3], ['signParking', 3],
    ['hydrant', 3], ['standpipe', 2], ['meter', 4], ['newsBox', 3], ['utilityBox', 2],
    ['cone', 2], ['signOneWay', 3], ['benchTeak', 3], ['payStation', 2], ['cigBin', 2],
    ['bikeRack', 3], ['scooter', 3], ['bicycle', 2], ['mailbox', 2], ['binTwin', 3],
  ];
  if (b.streetLife > 0.5) {
    t.push(['planterTrough', 4], ['binMesh', 3], ['phoneKiosk', 1], ['atmKiosk', 1],
      ['pottedPalm', 2], ['stanchion', 2], ['hotdogStand', 1], ['pottedFicus', 3],
      ['wayfindTotem', 2], ['busBench', 3], ['flowerStand', 2], ['aboardPoster', 3],
      ['barrelTable', 2]);
  }
  if (b.streetLife < 0.45) {
    // The quiet side of a block is where the servicing happens. A skip, a stack
    // of pallets and a heap of sacks say "back of house" more cheaply than any
    // signage — and the sacks are the only soft shape on the whole pavement.
    t.push(['bollardStone', 4], ['crate', 2], ['pallet', 1], ['dumpster', 3],
      ['deliveryStack', 2], ['meshFence', 1], ['trashBags', 4], ['stockTrolley', 2]);
  }
  if (b.onSpine) t.push(['benchConcrete', 2], ['benchCurve', 3], ['foodCart', 1],
    ['displayRack', 1], ['newsKiosk', 2], ['lightboxSign', 2]);
  return t;
}

function kerbRun(pl, b, s, r, band, life) {
  const len = edgeLen(b, s);
  if (len < 11) return;
  const rot = SIDE_ROT[s];
  /* Two distinct lines — a kerb line and a facade line (see facadeRun) with
     clear walking room between — is what makes a pavement read as a pavement
     from above. Scattering across the full band just looks like litter.

     The SETBACK IS DRAWN ONCE PER FRONTAGE, not once per prop. Re-rolling it
     per item over the 0.85-2.5 m the band allows made every kerb line zig-zag
     by up to 1.65 m, which is the single loudest scatter tell in the module:
     real street furniture is set out off one building line and lines up. What
     is left is a 12 cm jitter, which is about how accurately a crew working off
     a string line actually lands a bin. */
  const setback = 0.85 + r() * Math.max(0.25, Math.min(2.5, Math.max(1.15, band - 0.5)) - 0.85);

  /* Lamp posts on an even cadence. An irregular lamp rhythm is one of the
     loudest "procedural city" tells, so this one is deliberately metronomic. */
  const gap = b.onBoulevard ? 29 : b.onSpine ? 33 : 42;
  const kind = (b.onSpine || b.onBoulevard)
    ? (life > 0.45 ? 'lampDeco' : 'lampModern')
    : (life > 0.3 ? 'lampModern' : 'lampPark');
  const [ux, uz] = EDGE_DIR[s];
  for (let u0 = 4 + r() * 6; u0 < len - 4; u0 += gap) {
    const p = edgePt(b, s, u0, 1.35);
    // Roughly half the Deco posts on a given frontage carry flower baskets —
    // it is one pool switch, and it breaks up what is otherwise the most
    // metronomic run of identical objects in the whole city.
    const kk = (kind === 'lampDeco' && r.chance(0.45)) ? 'lampDecoBasket' : kind;
    const slid = pl.putAlong(kk, p.x, p.z, ux, uz, rot);
    if (slid !== null) {
      const u = u0 + slid;
      if (r.chance(0.3)) {
        const q = edgePt(b, s, u + 1.6, 0.8);
        pl.put('uplighter', q.x, q.z, rot);
      }
    }
  }

  /* One shelter per busy boulevard frontage — and where the frontage does not
     earn a shelter, the pole-and-blade version of the same stop. A route that
     only has stops on its grand frontages is a route with four stops on it. */
  let stopped = false;
  if ((b.onBoulevard || b.onSpine) && life > 0.42 && len > 30 && r.chance(0.5)) {
    const u0 = 8 + r() * (len - 20);
    const p = edgePt(b, s, u0, Math.min(2.1, Math.max(1.5, band - 0.9)));
    const slid = pl.putAlong('busShelter', p.x, p.z, ux, uz, rot);
    if (slid !== null) {
      stopped = true;
      const u = u0 + slid;
      const q = edgePt(b, s, u + 3.2, 1.1);
      pl.putAlong('binMesh', q.x, q.z, ux, uz, rot);
      const q2 = edgePt(b, s, u - 3.2, 1.15);
      pl.putAlong('signParking', q2.x, q2.z, ux, uz, rot);
    }
  }
  if (!stopped && life > 0.28 && len > 24 && r.chance(0.34)) {
    const u0 = 7 + r() * (len - 15);
    const p = edgePt(b, s, u0, 1.0);
    const slid = pl.putAlong('busStopFlag', p.x, p.z, ux, uz, rot);
    if (slid !== null && r.chance(0.55)) {
      const q = edgePt(b, s, u0 + slid + 2.4, Math.min(1.9, Math.max(1.3, band - 0.8)));
      pl.putAlong(r.chance(0.5) ? 'busBench' : 'binMesh', q.x, q.z, ux, uz, rot);
    }
  }

  /* General furniture run. Spacing tightens hard with street life, which is
     what makes a spine feel crowded and a back lot feel empty.

     MEASURED, and left alone. A 2.5 m grid walk of every block's STREET-FACING
     pavement band, measuring each sample's distance to the nearest prop, gives
     a mean gap of 0.46 m on retail and 0.47 m on lowrise with zero percent of
     either more than 6 m from something. (An earlier version of that walk also
     sampled the rear boundaries where two blocks abut — ground no frontage pass
     touches, and correctly so — and reported lowrise at 2.83 m with 12% over
     10 m. Nothing was wrong with the street; the metric was measuring the back
     of the building.) */
  const base = (8.2 - 4.2 * life) / DENSITY;
  const table = kerbTable(b);
  for (let u = 2.4 + r() * 2.0; u < len - 2.4; u += base * (0.72 + r() * 0.7)) {
    const inset = setback + (r() - 0.5) * 0.24;
    const p = edgePt(b, s, u, inset);
    const key = r.weighted(table);
    const jitter = (r() - 0.5) * 0.3;
    if (key === 'scooter') { scooterRow(pl, b, s, u, inset, rot, r); continue; }
    if (key === 'bikeRack') { bikeCluster(pl, b, s, u, inset, rot, r); continue; }
    const slid = pl.putAlong(key, p.x, p.z, ux, uz, rot + jitter);
    if (slid === null) continue;
    // Companions: real street furniture arrives in pairs — a bin beside the
    // bench, a second planter beside the first, litter beside the cart. A
    // companion stands ON THE SAME LINE as its principal, not offset off it.
    if (COMPANION[key] && r.chance(0.36)) {
      const q = edgePt(b, s, u + slid + 1.5 + r() * 0.9, inset + (r() - 0.5) * 0.2);
      pl.putAlong(r.pick(COMPANION[key]), q.x, q.z, ux, uz, rot + (r() - 0.5) * 0.4);
    }
  }

  /* Mid-pavement line. Without it a 7 m sidewalk is a kerb line, a facade line
     and four metres of nothing in between, which reads as an empty plaza from
     the game camera. */
  if (band > 3.6) {
    const midIn = band * 0.55;
    for (let u = 5 + r() * 4; u < len - 4; u += ((15.5 - 6.5 * life) / DENSITY) * (0.7 + r() * 0.8)) {
      const p = edgePt(b, s, u, midIn + (r() - 0.5) * 0.24);
      const key = r.weighted([
        ['benchSlat', 6], ['benchCurve', 5], ['planterSquare', 5], ['planterTrough', 4],
        ['planterModern', 4], ['planterUrn', 4], ['binMuni', 4],
        ['pottedPalm', 2], ['bollardStone', 3], ['cafeTable', life > 0.5 ? 6 : 1],
        ['picnicTable', 2], ['stanchion', 2], ['lampPark', 3], ['barrelTable', life > 0.5 ? 3 : 0],
      ]);
      if (key === 'cafeTable') { cafeCluster(pl, p.x, p.z, rot, r, 1); continue; }
      pl.putAlong(key, p.x, p.z, ux, uz, rot + (r() - 0.5) * 0.5);
    }
  }

  /* Parking meters march along the kerb wherever cars park — regular, close in.
     The rhythm is the point, so a blocked meter is skipped rather than slid. */
  if (life > 0.34 && !b.onSpine && r.chance(0.30)) {
    for (let u = 6 + r() * 4; u < len - 5; u += 9.6) {
      const p = edgePt(b, s, u, 1.0);
      pl.put('meter', p.x, p.z, rot);
    }
  }

  /* IRONWORK. Drainage runs along the kerb at a surveyed spacing, not at
     random, and a pavement with no covers in it is one of those absences you
     cannot name but can see — every other flat surface in the city has been
     given a joint pattern or a texture and this one had nothing. These are 9 cm
     tall, so they cost almost nothing and they are the first thing a fresh hole
     is allowed to take. They stand off the kerb by 0.8 m rather than in the
     gutter: the gutter samples below GROUND_MIN and is refused there anyway. */
  for (let u = 5 + r() * 9; u < len - 4; u += 26 + r() * 16) {
    const p = edgePt(b, s, u, 0.82 + r() * 0.2);
    // A gutter grate is 0.76 long by 0.54, authored along local x — which after
    // SIDE_ROT is the edge direction, so plain `rot` lays it ALONG the kerb the
    // way drainage actually runs.
    pl.putAlong('drainGrate', p.x, p.z, ux, uz, rot);
  }
  if (band > 2.6) {
    for (let u = 9 + r() * 14; u < len - 5; u += 34 + r() * 22) {
      const p = edgePt(b, s, u, band * (0.45 + r() * 0.25));
      pl.putAlong('manholeCover', p.x, p.z, ux, uz, r() * TAU);
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
  const step = (9.4 - 4.6 * life) / DENSITY;
  const shoppy = b.zone === ZONE.RETAIL || b.zone === ZONE.LOWRISE;
  /* A shopfront puts its STOCK on the pavement — rails, crates, buckets of
     flowers, a pastry case. That is what makes a retail street look open for
     business rather than merely furnished, and it is the half of "storefront
     dressing" the module was missing entirely. */
  const table = shoppy
    ? [['sandwichBoard', 5], ['aboardPoster', 5], ['produceCrate', 5], ['displayRack', 4],
      ['pottedPalm', 3], ['binWheelie', 3], ['cafeChair', 2], ['crate', 3],
      ['planterTrough', 3], ['heater', 2], ['clothesRail', 5], ['produceStand', 4],
      ['flowerStand', 3], ['deliveryStack', 3], ['pastryCase', 2], ['gelatoCase', 3],
      ['menuBoard', 3], ['pottedFicus', 3], ['stockTrolley', 3], ['chairStack', 3],
      ['planterUrn', 3], ['cellarHatch', 3]]
    : [['pottedPalm', 3], ['planterSquare', 4], ['planterUrn', 4], ['planterModern', 3],
      ['benchSlat', 4], ['benchCurve', 3], ['binWheelie', 3],
      ['bollardStone', 3], ['utilityBox', 2], ['sandwichBoard', 2], ['pottedFicus', 3],
      ['deliveryStack', 2], ['cigBin', 2], ['benchTeak', 3], ['trashBags', 3],
      ['stockTrolley', 2], ['cellarHatch', 2], ['standpipe', 2]];

  const [ux, uz] = EDGE_DIR[s];
  // Shop clutter stands AGAINST the glass, so this line is tighter than the
  // kerb line is: a sandwich board a metre out into the walking zone reads as
  // dropped, not as put out.
  for (let u = 3 + r() * 3; u < len - 3; u += step * (0.72 + r() * 0.8)) {
    const p = edgePt(b, s, u, inset + (r() - 0.5) * 0.22);
    const key = r.weighted(table);
    const slid = pl.putAlong(key, p.x, p.z, ux, uz, rot + (r() - 0.5) * 0.4);
    if (slid === null) continue;
    if (COMPANION[key] && r.chance(0.32)) {
      const q = edgePt(b, s, u + slid + 1.3 + r() * 0.8, inset - 0.2 - r() * 0.35);
      pl.putAlong(r.pick(COMPANION[key]), q.x, q.z, ux, uz, rot + (r() - 0.5) * 0.5);
    }
  }
}

/* --------------------------------------------------- open-block promenade -- */

/**
 * The promenade line around a PARK, PLAZA or MARINA apron.
 *
 * Neither existing pass was reaching that ground. `kerbRun` sets its furniture
 * within 2.5 m of the block edge; the interior scatter spreads (w*d)/108
 * objects over the whole parcel, which out on the apron works out at roughly
 * one object every 11 m. Between the two there is a 3-8 m ring of bare paving,
 * and because an open block is the one place the game camera sees a large
 * uninterrupted area of ground, that ring is where thin dressing reads loudest
 * — in the `crowd` frame it was the biggest empty surface on screen.
 *
 * So this dresses the line a person actually walks, with the vocabulary that
 * belongs to it: benches turned to LOOK INTO the green rather than out at the
 * traffic, bins where the benches are, lamps on an even cadence, planting
 * between. `putAlong` rather than `putOpen` because a promenade is a rhythm —
 * sliding a bench a metre keeps it, and `put` already refuses anything that
 * would land inside nature.js's ponds, aprons and hedges.
 */
const PROMENADE = [
  ['benchSlat', 6], ['benchTeak', 6], ['benchBackless', 5], ['benchCurve', 5],
  ['binMesh', 4], ['binMuni', 3], ['binTwin', 3],
  ['planterRound', 4], ['planterUrn', 4], ['planterModern', 4], ['planterTrough', 3],
  ['bollardStone', 3], ['bollardBell', 3], ['pottedPalm', 3], ['pottedFicus', 3],
  ['cigBin', 2], ['dogStation', 2], ['wayfindTotem', 2], ['drainGrate', 3],
  ['manholeCover', 2], ['fountain', 2],
];
const FACES_IN = new Set(['benchSlat', 'benchTeak', 'benchBackless', 'benchCurve']);

function openPerimeter(pl, b, r) {
  // One inset for the whole block, so the ring is a ring and not a scribble.
  const inset = 3.6 + r() * 2.4;
  if (Math.min(b.w, b.d) < inset * 2 + 10) return;
  for (const s of ['n', 's', 'w', 'e']) {
    if (!b.edges[s]) continue;
    const len = edgeLen(b, s);
    if (len < 18) continue;
    const rot = SIDE_ROT[s];
    const [ux, uz] = EDGE_DIR[s];
    // A bench on this line faces the block, i.e. 180 degrees off the kerb.
    const inward = rot + Math.PI;
    let sinceLamp = 14 + r() * 8;
    for (let u = 4 + r() * 4; u < len - 4; u += 4.6 + r() * 3.2) {
      const p = edgePt(b, s, u, inset + (r() - 0.5) * 0.6);
      sinceLamp += 6;
      if (sinceLamp > 23) {
        if (pl.putAlong('lampPark', p.x, p.z, ux, uz, rot) !== null) { sinceLamp = 0; continue; }
      }
      const key = r.weighted(PROMENADE);
      const yaw = FACES_IN.has(key) ? inward + (r() - 0.5) * 0.10 : squared(r);
      const slid = pl.putAlong(key, p.x, p.z, ux, uz, yaw);
      // A bin at the end of the bench, on the same line — the pairing that
      // makes a promenade read as maintained rather than as furnished.
      if (slid !== null && FACES_IN.has(key) && r.chance(0.42)) {
        const q = edgePt(b, s, u + slid + 1.9 + r() * 0.6, inset);
        pl.putAlong(r.chance(0.5) ? 'binMesh' : 'binTwin', q.x, q.z, ux, uz, rot);
      }
    }
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
    // A corner is the busiest 3 m of pavement in the city and the one most
    // likely to already hold a street tree or a park hedge, so the sign and the
    // hydrant walk back along the kerb they belong to instead of being dropped.
    const sgn = Math.sign(ox) || 1;
    if (r.chance(0.55)) {
      pl.putAlong(r.chance(0.6) ? 'signStop' : 'signNoEntry', x, z, sgn, 0, rot);
    }
    if (r.chance(0.5)) pl.putAlong('hydrant', x + ox * 0.7, z + oz * 0.7, 0, Math.sign(oz) || 1, rot);
    if (r.chance(0.4)) {
      for (let k = 0; k < 3; k++) {
        pl.put('bollard', x - ox * 0.2 + k * ox * 0.55, z - oz * 0.2 + k * oz * 0.55, 0);
      }
    }
    if (b.streetLife > 0.5 && r.chance(0.35)) {
      pl.putAlong('newsBox', x + ox * 0.3, z - oz * 0.4, sgn, 0, rot);
    }
  }
}

/* ------------------------------------------------------ zone dressings --- */

/**
 * One café setting. `rot` is the frontage it belongs to: a terrace is a row of
 * settings ALONG a shopfront, so the cluster is only ever displaced parallel to
 * that frontage — displacing it freely walked tables out into the carriageway
 * and broke the read that these belong to the shop behind them.
 */
/** The three tables and two chairs a setting can be made of. */
const TABLE_KINDS = [['cafeTable', 5], ['cafeTableCloth', 4], ['cafeTableSquare', 4]];
const CHAIR_KINDS = ['cafeChair', 'bistroChair'];

function cafeCluster(pl, x, z, rot, r, n = 1) {
  // Local +x after the placer's Y rotation. Sliding along it keeps the setting
  // on the terrace line instead of wandering off the kerb.
  const ax = Math.cos(rot), az = -Math.sin(rot);
  for (let c = 0; c < n; c++) {
    const t = (r() - 0.5) * 5.0;
    const rot0 = rot + (r() - 0.5) * 0.5;
    // Model varies per SETTING, not per object: one restaurant does not own
    // three different tables, but three restaurants in a row do.
    const tk = r.weighted(TABLE_KINDS);
    const ck = r.pick(CHAIR_KINDS);
    // Slide the whole setting down the terrace rather than losing it: a table
    // that cannot stand at this exact metre is still wanted two metres on.
    const slid = pl.putAlong(tk, x + ax * t, z + az * t, ax, az, rot0);
    if (slid === null) continue;
    const cx = x + ax * (t + slid), cz = z + az * (t + slid);
    /* Seats ring the table on even slots. When the setting gets a parasol it
       takes one of those slots and stands on its own base rather than through
       the tabletop: a co-located pole is invisible from the game camera but it
       is 51 interpenetrating pairs in the audit, and a 1.26 m canopy from
       1.5 m out still shades the whole setting.

       The ring radius is DERIVED from the two models chosen above rather than
       being the flat 1.15 it used to be. A clothed table is 0.71 m across the
       floor against a bare pedestal's 0.42, so one fixed radius either buries
       the chairs in the big table or floats them off the small one — and
       "buries" here means the placer silently refuses them, which is how a
       terrace ends up as tables with nobody able to sit at them. */
    const ring = contactRadius(tk) + contactRadius(ck) + 0.26;
    const seats = 3 + r.int(0, 1);
    const shaded = r.chance(0.5);
    /* An ice bucket takes a slot of its own, standing on the floor beside the
       table the way a real one does — the smallest object on a terrace and the
       one that says somebody is actually being served rather than that the
       chairs have been set out. Only clothed tables get one: a bare pedestal
       table is a coffee table, and a champagne bucket at it is a joke. */
    const served = tk === 'cafeTableCloth' && r.chance(0.3);
    const slots = seats + (shaded ? 1 : 0) + (served ? 1 : 0);
    for (let k = 0; k < seats; k++) {
      const a = rot0 + (k / slots) * TAU + (r() - 0.5) * 0.22;
      const sx = cx + Math.cos(a) * ring, sz = cz + Math.sin(a) * ring;
      // Face the table: local +z maps to (sin rotY, cos rotY).
      pl.put(ck, sx, sz, Math.atan2(-Math.cos(a), -Math.sin(a)));
    }
    if (shaded) {
      const a = rot0 + (seats / slots) * TAU;
      // Two canopy MODELS. From the game's overhead camera a parasol is its
      // plan shape and nothing else, so a round-only terrace is a tray of
      // identical discs however many colours are on it.
      const uk = r.chance(0.42) ? 'parasolSquare' : 'umbrella';
      pl.put(uk, cx + Math.cos(a) * (ring + 0.35), cz + Math.sin(a) * (ring + 0.35), r() * TAU);
    }
    if (served) {
      const a = rot0 + ((seats + (shaded ? 1 : 0)) / slots) * TAU;
      /* OUTSIDE the seat ring, not inside it. A clothed table reserves 0.81 m
         and the bucket 0.50, so anything closer than 1.31 m from the table
         centre is refused outright — which is why the first cut of this placed
         exactly zero ice buckets in the entire city. */
      const br = ring + 0.14;
      pl.put('iceBucket', cx + Math.cos(a) * br, cz + Math.sin(a) * br, r() * TAU);
    }
  }
}

/* ------------------------------------------------------------- terrace --- */

/**
 * Terrace boundary vocabulary.
 *
 * Five entries, and the ONE chosen is used for the whole boundary of a given
 * terrace (see restaurantTerrace) — a real restaurant buys one kind of screen,
 * and mixing hedge, glass and rope along a single 12 m edge is the surest way
 * to make a designed thing look scattered. The variety lives between terraces.
 *
 * `plantScreen` is the only tall one and the only one that lights up, so it is
 * also what stops a whole street of terraces having a flat waist-height edge.
 */
const TERRACE_EDGE = [['terraceHedge', 5], ['terraceRail', 5], ['terraceRope', 4],
  ['plantScreen', 4], ['planterSquare', 2], ['planterTrough', 2]];

/**
 * A RESTAURANT TERRACE, laid out as a room rather than sprinkled as objects.
 *
 * The single biggest reason a procedural street reads as procedural is that
 * everything on it was placed by the same independent dice roll. A terrace in
 * the real world is four parallel lines and a threshold:
 *
 *   kerb  |  boundary (hedge / glass screen / planters, with ONE gap)
 *         |  the tables, all on one line, all square to the shopfront
 *         |  service against the glass (station, pastry case, heater)
 *   glass |  and at the gap: a menu board and a host stand
 *
 * Laying it out in that order is also what makes the collision budget work:
 * the boundary and the threshold are the things that must land, so they claim
 * their ground first and the tables fill what is left.
 *
 * Runs BEFORE the kerb run for the block (see dressBlock), so the bins and
 * meters flow around the terrace instead of the terrace losing to the bins.
 */
function restaurantTerrace(pl, b, r, band) {
  const s = b.frontage;
  const len = edgeLen(b, s);
  if (len < 19) return;
  const rot = SIDE_ROT[s];
  const [ux, uz] = EDGE_DIR[s];

  const span = Math.min(len - 11, 9 + r() * 9);
  if (span < 7) return;
  const u0 = 5 + r() * Math.max(0.5, len - span - 10);
  const uMid = u0 + span * 0.5;

  /* THE THREE LINES, in metres of inset from the kerb.
     They are not fractions of the band, because the things standing on them
     have fixed sizes: a boundary screen reserves ~0.35 m of depth, a dressed
     table 0.71, and the placer wants 0.2 m of air between any two claims. So
     the table line sits a fixed 1.62 m behind the boundary — proportional
     spacing put it 0.65 m behind on a 4 m pavement, where every single table
     was silently refused for overlapping the hedge in front of it. Whether
     there is ALSO room for a service line against the glass is then a
     question the remaining depth answers, not an assumption. */
  const dKerb = 1.30;
  const dFacade = band - 0.65;
  /* Three widths of terrace, because Miami has three widths of pavement and
     forcing one layout onto all of them means the narrow two thirds of the
     city get NO terrace at all — which is what the first cut did: 37 terraces
     citywide, all on the six-metre spines.
       fenced  boundary line + table line (+ service where there is depth)
       narrow  one table line down the middle, planters bracketing the ends */
  const fenced = dFacade - dKerb >= 2.85;
  const dTable = fenced ? dKerb + 1.62 : (dKerb + dFacade) * 0.5;
  const roomy = fenced && dFacade - dTable >= 1.25;
  pl.tally.terrace++;

  /* Boundary line. The gap is the way in, so it is left at a known place and
     everything else keys off it — a terrace you cannot walk into reads as a
     storage yard. */
  const GAP = 2.5;
  /* ONE boundary model per terrace, drawn once. Re-rolling it per section gave
     every terrace a hedge, then a glass screen, then a rope, then a planter
     along a single 12 m edge — which reads as four restaurants sharing a
     pavement, not as one restaurant's terrace. */
  const key = r.weighted(TERRACE_EDGE);
  for (let u = u0; fenced && u < u0 + span; ) {
    /* Pack on the item's LENGTH ALONG THE KERB, and reserve a capsule rather
       than the circle its footprint bounds. A 2.04 m hedge bounds a 1.06 m
       circle, so circle-packing it leaves a 0.4 m hole between every pair and
       the "edge" reads as a dotted line — which is the one thing a terrace
       boundary must not do. */
    const cb = contactBox(key);
    if (Math.abs(u + cb.hx - uMid) > GAP * 0.5 + cb.hx) {
      /* STEP THE SECTION IN OR OUT, NEVER SKIP IT.
         A boundary section may not slide ALONG the run — its neighbours are
         packed against it and the next one starts where this one ends — so the
         one axis it is free on is depth. A third of them were being lost, and
         the thing that takes them is nature's kerb underplanting: buildStreetTrees
         puts a shrub 1.5 m either side of every street tree at an inset of
         1.75-2.35 m, which lands within a metre of the 1.30 m boundary line.
         Half a metre of give either way steps the screen round it, and a
         boundary that jogs 0.5 m round a planter still reads as one edge —
         a 2 m hole in it does not, and that is the defect the packing above
         exists to avoid in the first place. */
      let done = false;
      for (const dd of [0, -0.35, 0.48, 0.92]) {
        const dep = dKerb + dd;
        // Never step past the table line, and never into the gutter. The floor
        // is a backstop only — the ground sample already refuses the kerb ramp.
        if (dep < 0.90 || dep > dTable - 0.55) continue;
        const p = edgePt(b, s, u + cb.hx, dep + (r() - 0.5) * 0.10);
        if (!pl.put(key, p.x, p.z, rot + (r() - 0.5) * 0.05, 1, null, cb.hz)) continue;
        pl.claimFeet(p.x, p.z, rot, [-cb.hx * 0.55, cb.hx * 0.55], cb.hz);
        pl.tally.terraceEdge++;
        done = true;
        break;
      }
      if (!done) pl.tally.terraceEdgeLost++;
    }
    u += cb.hx * 2 + 0.16;
  }

  // A narrow terrace still needs to say where it starts and stops.
  if (!fenced) {
    for (const du of [-0.4, span + 0.4]) {
      const p = edgePt(b, s, u0 + du, dTable);
      pl.putAlong('planterSquare', p.x, p.z, ux, uz, rot);
    }
  }

  /* Threshold: menu board on the kerb side of the gap, host stand inside it. */
  const gp = edgePt(b, s, uMid - 1.45, fenced ? dKerb + 0.2 : dTable - 1.3);
  pl.putAlong('menuBoard', gp.x, gp.z, ux, uz, rot + (r() - 0.5) * 0.2);
  const hp = edgePt(b, s, uMid + 1.2, roomy ? dFacade - 0.3 : dTable + 0.9);
  pl.putAlong('hostStand', hp.x, hp.z, ux, uz, rot + (r() - 0.5) * 0.25);

  /* SHADE OR LIGHT, never both. A terrace gets either a fabric awning over the
     table line or a pair of festoon gates across it — the awning is 4.2 m of
     canopy at 2.6 m and the gates are 4 m of wire at 3.1 m, so together they
     interpenetrate and neither reads. Which one a terrace gets is the loudest
     difference between two terraces on the same street, so it is a coin flip
     rather than a rule.

     The gates run ACROSS the terrace rather than along it: the arch is 4 m wide
     and a terrace is only ever ~9-18 m long, so along the frontage it would eat
     two table bays, while across it uses depth nothing else wants. */
  if (fenced && r.chance(0.5)) {
    /* Four posts in two rows across the pavement, so the reservation cannot be
       a line of feet — see claimLocal. The canopy sits ON the table line and
       the tables slide a metre out of the way of the two posts that land in the
       row, which is exactly what happens under a real one.
       Gated on `fenced`, not on `roomy`: a fenced terrace is already 4.8 m of
       pavement and the awning's deepest post lands at dTable + 1.11, so it
       fits every one of them. Gating on `roomy` plus the arch's own 3.6 m depth
       test meant an awning needed 5.55 m and the city got seven. */
    const feet = [[-1.90, -0.92], [1.90, -0.92], [-1.90, 0.86], [1.90, 0.86]];
    for (const du of [span * 0.26, span * 0.74]) {
      if (Math.abs(u0 + du - uMid) < GAP * 0.5 + 2.0) continue;
      const p = edgePt(b, s, u0 + du, dTable);
      if (pl.put('terraceAwning', p.x, p.z, rot, 1, null, 0.34)) {
        pl.claimLocal(p.x, p.z, rot, feet, 0.26);
      }
    }
  } else if (dFacade - dKerb > 3.6) {
    const archRot = rot + Math.PI / 2;
    for (const du of [1.8, span - 1.8]) {
      const p = edgePt(b, s, u0 + du, (dKerb + dFacade) * 0.5);
      if (pl.put('stringArch', p.x, p.z, archRot, 1, null, 0.34)) {
        pl.claimFeet(p.x, p.z, archRot, [-2.0, 2.0], 0.34);
      }
    }
  } else if (r.chance(0.5)) {
    // Too shallow for either gate: a single festoon pole is still worth having,
    // and it is the only overhead light a narrow terrace can carry.
    const p = edgePt(b, s, u0 + span * 0.3, Math.max(1.2, dKerb - 0.15));
    pl.putAlong('stringPole', p.x, p.z, ux, uz, rot);
  }

  /* Tables, one line, square to the shopfront, skipping the bay in front of
     the entrance gap. */
  const pitch = 2.9 + r() * 0.5;
  for (let u = u0 + 1.6; u < u0 + span - 1.2; u += pitch) {
    if (Math.abs(u - uMid) < GAP * 0.5 + 1.0) continue;
    const p = edgePt(b, s, u, dTable + (r() - 0.5) * 0.2);
    cafeCluster(pl, p.x, p.z, rot + (r() - 0.5) * 0.12, r, 1);
  }

  /* Service and warmth against the glass — only where the depth is genuinely
     there. On a 4 m pavement this line would be standing in the table row. */
  if (!roomy) return;
  const srv = [['serviceStation', 4], ['pastryCase', 3], ['gelatoCase', 3], ['heater', 5],
    ['pottedFicus', 3], ['binMesh', 2], ['chairStack', 3], ['barrelTable', 2],
    ['drinksTub', 2], ['iceBucket', 2]];
  for (let u = u0 + 1.2; u < u0 + span - 1.0; u += 3.4 + r() * 2.2) {
    if (Math.abs(u - uMid) < 1.8) continue;
    const p = edgePt(b, s, u, dFacade + (r() - 0.5) * 0.2);
    pl.putAlong(r.weighted(srv), p.x, p.z, ux, uz, rot + (r() - 0.5) * 0.2);
  }
}

/* ------------------------------------------------- hotel + club entrance -- */

/**
 * The front door of a hotel or a club: the one piece of street furniture a
 * player reads as ADDRESS rather than as clutter.
 *
 * Two variants, never both, because a porte-cochère and a roped red carpet are
 * the same idea done at two budgets — and because their bounding circles are
 * 3.3 m and 1.8 m, so overlapping them is a guaranteed pair in the placement
 * audit for a composition nobody would build anyway.
 */
/**
 * Slide a big single object along a frontage until it finds ground.
 *
 * A canopy reserves 3.45 m and refuses to stand within 2.4 m of a street tree,
 * and nature.js plants those every 8-12 m along exactly this kerb. Anchored
 * rigidly at the middle of the frontage the entrance therefore landed 6 times
 * out of 59 attempts citywide — the composition existed in the code and
 * essentially not in the city. `SLIDE`'s +-2.4 m is tuned for kerb rhythm and
 * is far too short to clear a tree, so this walks the whole frontage in tree
 * spacings and takes the first bay that is genuinely free.
 *
 * @returns {?number} the u it landed at
 */
function anchorAlong(pl, b, s, u0, inset, key, rot, claimR = -1) {
  for (const du of [0, 4, -4, 8, -8, 12, -12, 16, -16]) {
    const u = u0 + du;
    if (u < 6 || u > edgeLen(b, s) - 6) continue;
    /* Depth as well as length. A tree line is a LINE: walking the frontage
       moves the canopy along with you, so a bay refused at one inset is often
       refused at every inset the walk visits. Half a metre in or out clears the
       trunk instead, and 28 of 86 frontages were still ending up with no front
       door at all. The steps are small enough that the canopy stays where the
       composition wants it — it is still the middle of the frontage. */
    for (const di of [0, -0.55, 0.55]) {
      const p = edgePt(b, s, u, inset + di);
      if (p && pl.put(key, p.x, p.z, rot, 1, null, claimR)) return u;
    }
  }
  return null;
}

function hotelEntrance(pl, b, r, band) {
  const s = b.frontage;
  const len = edgeLen(b, s);
  if (len < 26) return;
  const rot = SIDE_ROT[s];
  const [ux, uz] = EDGE_DIR[s];
  const mid0 = len / 2 + (r() - 0.5) * len * 0.16;

  // A canopy needs 3.3 m of depth for its columns plus standing room; below
  // that the block gets the carpet-and-rope door instead.
  const wantGrand = band >= 4.4 && r.chance(0.6);

  // A refused canopy falls through to the club door rather than leaving the
  // block with no front entrance at all — the canopy is the one prop in the
  // module big enough that a whole frontage can fail to have room for it.
  const grandInset = Math.min(Math.max(2.05, band * 0.5), band - 1.95);
  const grandMid = wantGrand
    ? anchorAlong(pl, b, s, mid0, grandInset, 'porteCochere', rot)
    : null;

  if (grandMid !== null) {
    const inset = grandInset;
    const mid = grandMid;
    pl.tally.entrance++;
    // Everything else stands clear of the canopy's own 3.45 m reservation.
    for (const sgn of [-1, 1]) {
      const p = edgePt(b, s, mid + sgn * 4.5, inset);
      pl.put('pottedFicus', p.x, p.z, rot);
    }
    const v = edgePt(b, s, mid + 4.6, 1.5);
    pl.putAlong('valetStand', v.x, v.z, ux, uz, rot);
    const k = edgePt(b, s, mid - 4.7, Math.max(1.9, band - 0.8));
    pl.putAlong('keyBoard', k.x, k.z, ux, uz, rot);
    const sg = edgePt(b, s, mid - 7.0, 1.4);
    pl.putAlong('lightboxSign', sg.x, sg.z, ux, uz, rot);
    // A bell cart parked at the door is the one object that says a hotel is
    // OPERATING rather than merely built. It stands against the wall, out of
    // the drive-through line under the canopy.
    if (r.chance(0.7)) {
      const lc = edgePt(b, s, mid + 3.2, Math.max(2.0, band - 0.75));
      pl.putAlong('luggageCart', lc.x, lc.z, ux, uz, rot + Math.PI / 2 + (r() - 0.5) * 0.4);
    }
    loungeGroup(pl, b, s, mid - 8.8, band, rot, r);
  } else {
    const inset = Math.min(Math.max(1.75, band * 0.5), band - 1.65);
    const mid = anchorAlong(pl, b, s, mid0, inset, 'carpetRunner', rot);
    if (mid === null) { pl.tally.entranceLost++; return; }
    pl.tally.entrance++;
    const pd = edgePt(b, s, mid + 2.9, inset + 0.4);
    if (pl.putAlong('bouncerPodium', pd.x, pd.z, ux, uz, rot - 0.5)) {
      const cb = edgePt(b, s, mid + 3.8, inset + 0.2);
      pl.put('cigBin', cb.x, cb.z, rot);
    }
    /* The queue runs ALONG the frontage — a club queue stands against the wall,
       and running it out toward the kerb would put half of it in the gutter,
       where the ground sample refuses it anyway.

       Rope lines abut end to end, so they claim a hub and their two posts
       rather than the 1.13 m circle their footprint bounds: at that radius the
       second unit of any queue is refused and a queue of one is just a stray
       stanchion. */
    for (let k = 0; k < 2 + r.int(0, 2); k++) {
      const q = edgePt(b, s, mid + 4.6 + k * 2.05, Math.max(1.7, inset - 0.3));
      if (pl.put('velvetRope', q.x, q.z, rot, 1, null, 0.32)) {
        pl.claimFeet(q.x, q.z, rot, [-0.95, 0.95], 0.24);
      }
    }
    // The sign is what makes the door read at night. It goes on the side the
    // queue is not, well clear of the rope line.
    const sg = edgePt(b, s, mid - 6.6, 1.4);
    pl.putAlong('lightboxSign', sg.x, sg.z, ux, uz, rot);
  }
}

/**
 * OUTDOOR LOUNGE SEATING, the two shapes it actually comes in.
 *
 * The brief asks for rooftop lounge furniture. Roofs belong to buildings.js and
 * nothing standing on one has a ground contact patch this module can measure —
 * a sofa up there would be a floating prop by every test the project has. So
 * the lounge lives where the game can reach it: hotel forecourts, plazas, the
 * marina apron.
 *
 * Both variants pass a small `claimR` and then claim the sofa's FEET. A sofa is
 * 1.96 m across a 0.88 m body, so the circle bounding it is 1.07 m in every
 * direction; reserve that and the low table 1.4 m in front of it is refused,
 * which leaves a lounge that is a row of sofas facing nothing.
 */
const SOFA_FEET = [-0.72, 0, 0.72];

/** Against a frontage: one sofa on the building line, a table in front of it. */
function loungeGroup(pl, b, s, u, band, rot, r) {
  if (band < 3.7 || u < 4 || u > edgeLen(b, s) - 4 || !r.chance(0.55)) return false;
  const inset = Math.max(2.0, band - 1.35);
  const p = edgePt(b, s, u, inset);
  if (!pl.put('loungeSofa', p.x, p.z, rot, 1, null, 0.42)) return false;
  pl.claimFeet(p.x, p.z, rot, SOFA_FEET, 0.44);
  // Local +z faces the kerb, so the table goes out in front of the seat.
  const nx = Math.sin(rot), nz = Math.cos(rot);
  pl.put('loungeTable', p.x + nx * 1.42, p.z + nz * 1.42, rot);
  if (r.chance(0.45)) {
    const ax = Math.cos(rot), az = -Math.sin(rot);
    pl.put('pottedFicus', p.x + ax * 1.7, p.z + az * 1.7, rot);
  }
  return true;
}

/** In the open: two sofas looking at each other across the table. */
function loungeIsland(pl, px, pz, face, r) {
  const nx = Math.sin(face), nz = Math.cos(face);
  /* SEARCHED, not diced. The caller hands over one random point inside a park
     or a plaza, and one point inside ground that nature has already planted is
     a coin flip weighted heavily against — measured, the whole city held 23
     lounge sofas and 12 lounge tables, i.e. the seating group the plaza, the
     park and the marina each ask for existed in about a third of one of them.
     The group cannot be slid the way a kerb prop can, because the sofas and the
     table are laid out around wherever the table lands; so the SITE is what
     moves, before anything is placed. */
  let x = px, z = pz, ok = false;
  for (let t = 0; t < 12 && !ok; t++) {
    x = px + (t === 0 ? 0 : (r() - 0.5) * 11);
    z = pz + (t === 0 ? 0 : (r() - 0.5) * 11);
    ok = pl.free(x, z, 2.6) && pl.sceneryClear(x, z, 2.2);
  }
  if (!ok) return false;
  if (!pl.put('loungeTable', x, z, face)) return false;
  let n = 0;
  for (const sg of [-1, 1]) {
    const sx = x - nx * sg * 1.62, sz = z - nz * sg * 1.62;
    // Turned to look back at the table it is set around.
    const srot = sg > 0 ? face : face + Math.PI;
    if (!pl.put('loungeSofa', sx, sz, srot, 1, null, 0.42)) continue;
    pl.claimFeet(sx, sz, srot, SOFA_FEET, 0.44);
    n++;
  }
  if (n && r.chance(0.5)) {
    const ax = Math.cos(face), az = -Math.sin(face);
    pl.put(r.chance(0.5) ? 'parasolSquare' : 'pottedFicus',
      x + ax * 2.5, z + az * 2.5, r() * TAU, 1, null, 0.75);
  }
  return n > 0;
}

function retailTerrace(pl, b, r, band) {
  const life = b.streetLife;
  const s = b.frontage;
  const len = edgeLen(b, s);
  const rot = SIDE_ROT[s];
  /* Settings belong to a SHOP, so they arrive in short runs at one or two
     addresses along the frontage — not as independent dice rolls down its whole
     length. Same number of tables either way; the difference is that a run of
     three outside one door reads as a café and three singletons 20 m apart read
     as furniture that fell off a lorry. This is the "cluster them outside the
     storefront they belong to" half of the brief, for the frontages that are
     too shallow or too quiet to earn a full composed terrace. */
  const addresses = 1 + r.int(0, life > 0.5 ? 2 : 1);
  const inset = Math.max(1.9, band * 0.62);
  for (let k = 0; k < addresses; k++) {
    const u0 = 5 + r() * Math.max(1, len - 12);
    const n = Math.max(1, Math.round((1 + life * 2 + r()) * DENSITY));
    for (let i = 0; i < n; i++) {
      const p = edgePt(b, s, u0 + i * 3.0, inset + (r() - 0.5) * 0.2);
      cafeCluster(pl, p.x, p.z, rot + (r() - 0.5) * 0.1, r, 1);
    }
  }
  const [ux, uz] = EDGE_DIR[s];
  /* Festoon lighting. A gate (two poles and the catenary between them, as one
     object) instead of the two independent poles this used to place: those
     could and did land 5.5 m apart with a bin between them and no wire, which
     is a pair of mystery posts. Where the pavement is too shallow for a 4 m
     gate to sit square, a single pole is still worth having. */
  if (life > 0.45 && r.chance(0.6)) {
    const u = 6 + r() * Math.max(1, len - 12);
    const p = edgePt(b, s, u, Math.max(1.7, band * 0.5));
    if (band > 4.6) {
      const archRot = rot + Math.PI / 2;
      if (pl.put('stringArch', p.x, p.z, archRot, 1, null, 0.34)) {
        pl.claimFeet(p.x, p.z, archRot, [-2.0, 2.0], 0.34);
      }
    } else {
      pl.putAlong('stringPole', p.x, p.z, ux, uz, rot);
    }
  }
  if (r.chance(0.5)) {
    const u = 4 + r() * Math.max(1, len - 8);
    const p = edgePt(b, s, u, 1.5);
    pl.putAlong(r.chance(0.5) ? 'foodCart' : 'hotdogStand', p.x, p.z, ux, uz, rot);
  }
  /* Standing room. A bar's pavement is high-tops and no chairs, which is a
     completely different plan pattern from the café clusters above — same
     ground, different rhythm, and it is the reason two retail frontages in a
     row do not look like the same frontage twice. */
  if (life > 0.5 && band > 2.6 && r.chance(0.42)) {
    const u0 = 5 + r() * Math.max(1, len - 12);
    for (let k = 0; k < 2 + r.int(0, 2); k++) {
      const p = edgePt(b, s, u0 + k * 2.5, Math.max(1.8, band * 0.55) + (r() - 0.5) * 0.3);
      const slid = pl.putAlong('barrelTable', p.x, p.z, ux, uz, r() * TAU);
      if (slid === null) continue;
      const q = edgePt(b, s, u0 + k * 2.5 + slid, Math.max(1.8, band * 0.55) - 1.0);
      pl.put('barStool', q.x, q.z, rot + Math.PI + (r() - 0.5) * 0.6);
    }
    const t = edgePt(b, s, u0 - 2.0, Math.max(1.8, band - 0.7));
    pl.putAlong('drinksTub', t.x, t.z, ux, uz, rot);
  }
  // Shade over a wide retail pavement, where there is no restaurant terrace to
  // hang it off. Same four-post reservation as the terrace one.
  if (band > 4.4 && r.chance(0.35)) {
    const u = 6 + r() * Math.max(1, len - 12);
    const p = edgePt(b, s, u, Math.min(band - 1.2, 2.6));
    if (pl.put('terraceAwning', p.x, p.z, rot, 1, null, 0.34)) {
      pl.claimLocal(p.x, p.z, rot,
        [[-1.90, -0.92], [1.90, -0.92], [-1.90, 0.86], [1.90, 0.86]], 0.26);
    }
  }
  // Newspaper vending row: boxes stand shoulder to shoulder, so the row as a
  // whole is slid rather than each box independently.
  if (r.chance(0.32)) {
    const u0 = 4 + r() * Math.max(1, len - 10);
    const p0 = edgePt(b, s, u0, 1.25);
    const slid = pl.putAlong('newsBox', p0.x, p0.z, ux, uz, rot);
    if (slid !== null) {
      for (let k = 1; k < 3 + r.int(0, 2); k++) {
        const p = edgePt(b, s, u0 + slid + k * 0.62, 1.25);
        pl.put('newsBox', p.x, p.z, rot);
      }
    }
  }
}

function towerForecourt(pl, b, r, band) {
  const s = b.frontage;
  const len = edgeLen(b, s);
  const rot = SIDE_ROT[s];
  const mid = len / 2 + (r() - 0.5) * len * 0.2;
  const [ux, uz] = EDGE_DIR[s];
  // Flanking potted palms + a rope line either side of the door. The pair is
  // symmetric about the entrance, so these do NOT slide — a lopsided pair of
  // door palms looks worse than a single one.
  // ONE planter model for the flanking pair, chosen per building. A tower's
  // door furniture is bought as a set; the variety belongs between towers.
  const doorPlanter = r.weighted([['planterSquare', 4], ['planterUrn', 5], ['planterModern', 4]]);
  for (const sgn of [-1, 1]) {
    const p = edgePt(b, s, mid + sgn * 2.4, Math.max(1.8, band * 0.6));
    pl.put('pottedPalm', p.x, p.z, rot);
    const q = edgePt(b, s, mid + sgn * 4.6, Math.max(1.8, band * 0.6));
    pl.put(doorPlanter, q.x, q.z, rot);
  }
  // A forecourt lounge, well off to the side of the door line.
  loungeGroup(pl, b, s, mid + 9.5 + r() * 4, band, rot, r);
  if (r.chance(0.55)) {
    const p = edgePt(b, s, mid + 3.6, 1.6);
    pl.putAlong('valetStand', p.x, p.z, ux, uz, rot);
  }
  if (r.chance(0.4)) {
    const p = edgePt(b, s, mid - 8.0 - r() * 3, Math.max(1.9, band - 0.8));
    pl.putAlong('luggageCart', p.x, p.z, ux, uz, rot + Math.PI / 2 + (r() - 0.5) * 0.5);
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
  // Smokers get put round the side of a tower, never at its front door.
  if (r.chance(0.5)) {
    const p = edgePt(b, s, mid + 7.5 + r() * 3, Math.max(1.7, band - 0.9));
    pl.putAlong('cigBin', p.x, p.z, ux, uz, rot);
  }
}

/**
 * Everything designed sits on the site's own axes. A plaza full of benches at
 * random yaw is the loudest "procedural" tell there is, and it costs nothing to
 * fix: pick one of the four square headings and jitter it by a couple of
 * degrees so the row is not machine-perfect either.
 */
const SQUARE = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
const squared = (r) => r.pick(SQUARE) + (r() - 0.5) * 0.16;

/**
 * A pop-up bar with a DJ and a PA stack.
 *
 * Miami's plazas and its marina apron are where the city's nightlife actually
 * happens, and this module had nothing for it: after dark those blocks were
 * benches and planters. This is one composed group per site, on the site's own
 * axes, sited by hand rather than by dice — a bar facing out, three stools at
 * the counter, and the booth and speakers set back behind it where the crowd
 * is not.
 *
 * The anchor is searched rather than jittered: `putSoft` would move the bar
 * and leave the stools and speakers laid out around where it used to be.
 */
function eventCorner(pl, b, r) {
  if (Math.min(b.w, b.d) < 22) return;
  /* A pop-up bar with a PA belongs on a plaza or a marina apron, which is where
     Miami actually puts one. Once the site search below started succeeding, a
     flat 0.85 gave the city a DJ booth in the middle of essentially every lawn
     it owns — density bought at the cost of the thing the brief calls logical
     placement. Parks keep a much smaller share. */
  if (!r.chance(b.zone === ZONE.PARK ? 0.34 : 0.85)) return;
  const face = r.pick(SQUARE);
  const ax = Math.cos(face), az = -Math.sin(face);   // local +x
  const nx = Math.sin(face), nz = Math.cos(face);    // local +z, the way it faces

  /* THE SITE SEARCH IS THE WHOLE FEATURE.
     Counted in the built city, this landed TWICE — two pop-up bars, two DJ
     booths and four speakers across every park, plaza and marina apron in
     Miami. The group is not rare by design, it was being refused by tests that
     are wrong for the ground it stands on:

       ctx.isFree(1.6)  the shared 3 m grid, which rounds that up to a 9 x 9 m
                        square. Inside a planted park every square metre reads
                        as claimed (see putOpen), so this alone is close to a
                        blanket no — and it is the ONE test that answers nothing
                        an open block cares about, because an open block carries
                        no building.
       4.2 / 3.4        a reservation for a group whose real extent is a 2.7 m
                        counter and a booth 3.2 m behind it. Asking for 4.2 m of
                        clear ground in every direction from the CENTRE asked
                        for roughly twice the footprint the bar actually uses.

     `pl.free` (the placer's own fine grid, at the group's true size) and
     `sceneryClear` (nature's measured plants) are the honest tests and they are
     kept. The sample also walks the whole parcel rather than its middle half —
     a bar belongs at the edge of a plaza as readily as in the centre. */
  let cx = 0, cz = 0, ok = false;
  for (let t = 0; t < 36 && !ok; t++) {
    cx = b.x + (r() - 0.5) * b.w * 0.72;
    cz = b.z + (r() - 0.5) * b.d * 0.72;
    ok = pl.free(cx, cz, 3.1) && pl.sceneryClear(cx, cz, 2.6);
  }
  if (!ok) return;

  // The counter is 2.8 m of frontage on a 0.9 m body: its bounding circle says
  // 1.35 m in every direction, which would refuse the stools that belong at it.
  if (!pl.put('outdoorBar', cx, cz, face, 1, null, 0.62)) return;
  pl.claimFeet(cx, cz, face, [-1.1, 1.1], 0.62);
  for (let k = -1; k <= 1; k++) {
    pl.put('barStool', cx + ax * k * 0.92 + nx * 1.3, cz + az * k * 0.92 + nz * 1.3,
      face + Math.PI + (r() - 0.5) * 0.5);
  }
  const dx = cx - nx * 3.2, dz = cz - nz * 3.2;
  if (pl.put('djBooth', dx, dz, face)) {
    for (const sg of [-1, 1]) {
      pl.put('speakerStack', dx + ax * sg * 2.0, dz + az * sg * 2.0, face);
    }
  }
  pl.put('cigBin', cx + ax * 2.6 + nx * 1.1, cz + az * 2.6 + nz * 1.1, face);
  pl.put('lightboxSign', cx - ax * 3.4 + nx * 0.6, cz - az * 3.4 + nz * 0.6, face);
  /* The service side. An ice tub behind the counter and a couple of high-tops
     out in front are what turn "a bar object" into a bar somebody is running:
     the tub is on the staff side, the tables are on the crowd side, and that
     asymmetry is what the eye reads as a working layout. */
  pl.put('drinksTub', cx - ax * 2.1 - nx * 0.9, cz - az * 2.1 - nz * 0.9, face);
  for (let k = 0; k < 2 + r.int(0, 1); k++) {
    const tx = cx + ax * (k - 1) * 2.9 + nx * (3.4 + r() * 1.4);
    const tz = cz + az * (k - 1) * 2.9 + nz * (3.4 + r() * 1.4);
    if (!pl.put('barrelTable', tx, tz, r() * TAU)) continue;
    for (let q = 0; q < 2; q++) {
      const a = face + Math.PI * q + (r() - 0.5) * 0.6;
      pl.put('barStool', tx + Math.sin(a) * 1.0, tz + Math.cos(a) * 1.0, a + Math.PI);
    }
  }
  // Somewhere to sit that is not a stool, set back out of the crush.
  loungeIsland(pl, cx - nx * 6.4 + ax * 3.0, cz - nz * 6.4 + az * 3.0, face + Math.PI / 2, r);
}

function plazaFurniture(pl, b, r) {
  /* One prop per 82 m2, not per 115. An open block is the one place the game
     camera sees a large uninterrupted area of paving, so it is where thin
     dressing reads loudest — measured off the `crowd` frame, where a plaza at
     the old rate was one object every 10.7 m and looked swept. */
  const n = Math.round((b.w * b.d) / 82 * DENSITY);
  for (let i = 0; i < n; i++) {
    const x = b.x + (r() - 0.5) * b.w * 0.82;
    const z = b.z + (r() - 0.5) * b.d * 0.82;
    const key = r.weighted([
      ['benchConcrete', 5], ['benchCurve', 6], ['planterSquare', 4], ['planterRound', 4],
      ['planterUrn', 5], ['planterModern', 4], ['binMuni', 3], ['binTwin', 3],
      ['bollardStone', 4], ['bollardBell', 4], ['lampPark', 4], ['pottedPalm', 4],
      ['fountain', 2], ['cafeTable', 4], ['benchSlat', 3], ['planterTrough', 3],
      ['benchTeak', 4], ['pottedFicus', 4], ['wayfindTotem', 2], ['chessTable', 2],
      ['barrelTable', 2], ['manholeCover', 3], ['parasolSquare', 2],
    ]);
    if (key === 'cafeTable') { cafeCluster(pl, x, z, r.pick(SQUARE), r, 1); continue; }
    // Open block: nothing here has a building claim, so an occupied cell means
    // nature.js's fountain apron or seating steps and the site is genuinely gone.
    pl.putOpen(key, x, z, squared(r));
  }
  // A ring of planters around the centre reads as designed public realm. One
  // model for the whole ring — a ring of four different pots is not a ring.
  if (Math.min(b.w, b.d) > 34 && r.chance(0.6)) {
    const rad = Math.min(b.w, b.d) * 0.24;
    const k = 8 + r.int(0, 4);
    const pot = r.weighted([['planterRound', 4], ['planterUrn', 5], ['planterModern', 3]]);
    for (let i = 0; i < k; i++) {
      const a = (i / k) * TAU;
      pl.put(pot, b.x + Math.cos(a) * rad, b.z + Math.sin(a) * rad, a);
    }
  }
  // One lounge island per decent plaza — the seating a bench is not.
  if (Math.min(b.w, b.d) > 26 && r.chance(0.55)) {
    loungeIsland(pl, b.x + (r() - 0.5) * b.w * 0.5, b.z + (r() - 0.5) * b.d * 0.5,
      r.pick(SQUARE), r);
  }
}

function parkFurniture(pl, b, r) {
  const n = Math.round((b.w * b.d) / 108 * DENSITY);
  for (let i = 0; i < n; i++) {
    const x = b.x + (r() - 0.5) * b.w * 0.84;
    const z = b.z + (r() - 0.5) * b.d * 0.84;
    const key = r.weighted([
      ['benchBackless', 7], ['benchSlat', 5], ['benchCurve', 5], ['picnicTable', 6],
      ['binMesh', 4], ['binTwin', 3],
      ['lampPark', 5], ['fountain', 3], ['dogStation', 3], ['planterRound', 3],
      ['planterUrn', 3], ['bollardStone', 3], ['binMuni', 2],
      ['benchTeak', 6], ['chessTable', 5], ['bbqGrill', 5], ['trashBags', 1],
    ]);
    /* Benches in a park come in facing pairs across a walk, with the bin at one
       end — that trio is what makes a lawn read as a park rather than as an
       object field. A bench is authored facing +z, so a pair set 2.6 m apart on
       the same axis and turned 180 degrees from each other looks across at
       itself. */
    if (key === 'benchBackless' || key === 'benchSlat' || key === 'benchTeak') {
      const face = r.pick(SQUARE);
      const nx = Math.sin(face), nz = Math.cos(face);   // the direction it faces
      if (!pl.putOpen(key, x - nx * 1.3, z - nz * 1.3, face)) continue;
      pl.putOpen(key, x + nx * 1.3, z + nz * 1.3, face + Math.PI);
      if (r.chance(0.45)) {
        pl.putOpen('binMesh', x + nz * 2.0 - nx * 1.3, z - nx * 2.0 - nz * 1.3, face);
      }
      continue;
    }
    pl.putOpen(key, x, z, squared(r));
  }
  // A park lounge under the trees. Same group as the plaza's, but turned to a
  // random square heading so the two never read as the same set piece.
  if (Math.min(b.w, b.d) > 24 && r.chance(0.5)) {
    loungeIsland(pl, b.x + (r() - 0.5) * b.w * 0.55, b.z + (r() - 0.5) * b.d * 0.55,
      r.pick(SQUARE), r);
  }
  // Picnic groves: tables come in twos and threes around a shady spot, set out
  // square to each other the way somebody would actually drag them.
  const groves = 2 + r.int(0, 2);
  for (let g = 0; g < groves; g++) {
    const gx = b.x + (r() - 0.5) * b.w * 0.6;
    const gz = b.z + (r() - 0.5) * b.d * 0.6;
    const face = r.pick(SQUARE);
    const ax = Math.cos(face), az = -Math.sin(face);
    for (let k = 0; k < 2 + r.int(0, 2); k++) {
      pl.putOpen('picnicTable', gx + ax * k * 3.2 + (r() - 0.5) * 1.2,
        gz + az * k * 3.2 + (r() - 0.5) * 1.2, face + (r() - 0.5) * 0.14);
    }
    pl.putOpen('binMesh', gx - ax * 2.4, gz - az * 2.4, face);
  }
}

function marinaApron(pl, b, r) {
  // One prop per 95 m2 rather than 118. A marina block is small and almost all
  // of it is apron, so the interior scatter IS its dressing — there is no
  // building line for a facade run to hang anything off.
  const n = Math.round((b.w * b.d) / 95 * DENSITY);
  for (let i = 0; i < n; i++) {
    const x = b.x + (r() - 0.5) * b.w * 0.86;
    const z = b.z + (r() - 0.5) * b.d * 0.86;
    const key = r.weighted([
      ['cleat', 8], ['crate', 6], ['bollardStone', 4], ['bollardBell', 3], ['benchSlat', 3],
      ['binMesh', 3], ['binTwin', 2], ['lampPark', 4], ['pallet', 4], ['planterRound', 3],
      ['planterModern', 3], ['lounger', 3], ['parasol', 2], ['parasolSquare', 2],
      ['benchTeak', 4], ['benchCurve', 3], ['deliveryStack', 3], ['cigBin', 2],
      ['drinksTub', 2], ['barrelTable', 2], ['stockTrolley', 2], ['drainGrate', 3],
    ]);
    // A parasol stands on a 12 cm pole, so its measured footprint would let a
    // crate sit under the canopy. It reserves the ground its shade covers.
    const shade = key === 'parasol' || key === 'parasolSquare';
    pl.putOpen(key, x, z, squared(r), 1, null, shade ? 0.9 : -1);
  }
  // Cleats march along the seaward edge at a fixed dock spacing.
  const ez = b.x + b.w / 2 - 1.2;
  for (let u = 2.5; u < b.d - 2.5; u += 4.5) {
    pl.put('cleat', ez, b.z - b.d / 2 + u, 0);
  }
  // Waterside lounge — the marina is the one place in the city where sitting
  // and looking at nothing in particular is the entire point of the ground.
  if (Math.min(b.w, b.d) > 22 && r.chance(0.6)) {
    loungeIsland(pl, b.x + (r() - 0.5) * b.w * 0.5, b.z + (r() - 0.5) * b.d * 0.5,
      r.pick(SQUARE), r);
  }
}

function beachFront(pl, b, r) {
  // Promenade furniture on the seaward strip: loungers in pairs under a shared
  // parasol, and mooring cleats along the seawall itself.
  const x0 = b.x + b.w / 2 - 3.6;
  const rows = 1 + r.int(0, 1);
  for (let row = 0; row < rows; row++) {
    const x = x0 - row * 3.2;
    for (let u = 3; u < b.d - 3; u += 3.4) {
      if (!r.chance(0.66)) continue;
      const z = b.z - b.d / 2 + u;
      const placed = pl.put('lounger', x, z, Math.PI / 2 + (r() - 0.5) * 0.2);
      if (placed && r.chance(0.7)) pl.put('lounger', x, z + 1.35, Math.PI / 2 + (r() - 0.5) * 0.2);
      // The canopy is meant to overhang the loungers, so it reserves a little
      // more than its 12 cm pole and nothing like its 2.8 m span. Round or
      // square by the same coin flip the terraces use.
      if (placed && r.chance(0.6)) {
        pl.put(r.chance(0.4) ? 'parasolSquare' : 'parasol', x - 1.7, z + 0.7, r() * TAU, 1, null, 0.35);
      }
    }
  }
  for (let u = 2.5; u < b.d - 2.5; u += 5.5) {
    pl.put('cleat', b.x + b.w / 2 - 1.1, b.z - b.d / 2 + u, 0);
  }
}

/**
 * A garage forecourt: kerb protection, cabinets and a few cones.
 *
 * Everything here is protection for a vehicle entrance, and protection comes in
 * RUNS: a line of bollards guarding the ramp mouth, a row of cones closing a
 * bay, a pair of cabinets against the wall. Rolling a fresh side, offset and
 * setback for each of ~20 items — which is what this did — produced a garage
 * ringed in evenly-spread confetti, the one shape a real forecourt never has.
 */
function lotFurniture(pl, b, r, band) {
  const runs = Math.max(2, Math.round((b.w + b.d) / 34 * DENSITY));
  for (let i = 0; i < runs; i++) {
    const s = r.pick(['n', 's', 'w', 'e']);
    const len = edgeLen(b, s);
    const [ux, uz] = EDGE_DIR[s];
    const rot = SIDE_ROT[s];
    const key = r.weighted([
      ['bollard', 6], ['bollardBell', 4], ['cone', 6], ['utilityBox', 4], ['barrel', 3],
      ['signParking', 5], ['binWheelie', 3], ['aframe', 2], ['standpipe', 3],
      ['payStation', 4], ['dumpster', 2], ['meshFence', 2], ['trashBags', 3],
      ['drainGrate', 4],
    ]);
    // One setback for the whole run, and a pitch that just clears the prop.
    const inset = 0.9 + r() * Math.max(0.3, band - 1.2);
    const pitch = Math.max(1.25, contactRadius(key) * 2 + 0.45);
    const n = key === 'utilityBox' ? 1 + r.int(0, 1) : 3 + r.int(0, 4);
    const u0 = 2.5 + r() * Math.max(1, len - 5 - n * pitch);
    for (let k = 0; k < n; k++) {
      const p = edgePt(b, s, u0 + k * pitch, inset);
      // A garage IS a building, so the shared grid is unusable here (see putOpen).
      pl.putAlong(key, p.x, p.z, ux, uz, rot);
    }
  }
}

function constructionYard(pl, b, r, band) {
  /* Hoarding line: barriers march continuously along every street frontage,
     which is what makes a site read as a site from the air. */
  const sides = ['n', 's', 'w', 'e'].filter((s) => b.edges[s]);
  for (const s of sides) {
    const len = edgeLen(b, s);
    const rot = SIDE_ROT[s];
    const kind = r.weighted([['jersey', 5], ['waterBarrier', 4], ['meshFence', 4]]);
    const step = kind === 'jersey' ? 2.06 : kind === 'meshFence' ? 2.04 : 1.90;
    /* Reserve a fraction of the unit rather than its bounding circle. These
       three are LINE props authored end to end along local x, and a circle
       through the corners of a 2 m barrier is 1.05 m — so on the default
       reservation every second one refused itself and a continuous hoarding
       came out as a dotted one. */
    for (let u = 1.6; u < len - 1.6; u += step) {
      const p = edgePt(b, s, u, 1.25);
      pl.put(kind, p.x, p.z, rot + Math.PI / 2, 1, null, step * 0.40);
    }
    // Cones and barrels punctuate the line.
    for (let u = 3 + r() * 4; u < len - 3; u += 7 + r() * 6) {
      const p = edgePt(b, s, u, 0.6);
      pl.put(r.chance(0.55) ? 'cone' : 'barrel', p.x, p.z, r() * TAU);
    }
    // A cable reel left against the hoarding — the round vertical the yard is
    // otherwise entirely without.
    if (r.chance(0.45)) {
      const p = edgePt(b, s, 4 + r() * Math.max(1, len - 8), 2.4);
      pl.putAlong('cableDrum', p.x, p.z, ...EDGE_DIR[s], rot + (r() - 0.5) * 0.5);
    }
  }

  /* Lane closure. A site with no works in the road in front of it is the
     giveaway that the hoarding is scenery; it is also the only thing that puts
     anything edible in the middle of a 34 m boulevard. This is the one place in
     the module that WANTS the carriageway, hence the onRoad flag: the cones
     stand on the asphalt, and now at whatever height the asphalt turns out to
     be rather than at a hand-subtracted kerb height. */
  const fr = b.frontageStreets && b.frontageStreets[0];
  if (fr && r.chance(0.8)) {
    const road = fr.road;
    const side = fr.side;
    const alongX = side === 'n' || side === 's';
    const kerb = alongX
      ? (side === 'n' ? b.z - b.d / 2 : b.z + b.d / 2)
      : (side === 'w' ? b.x - b.w / 2 : b.x + b.w / 2);
    const outward = (side === 'n' || side === 'w') ? -1 : 1;
    const len = alongX ? b.w : b.d;
    const u0 = (alongX ? b.x : b.z) - len / 2 + 4 + r() * (len - 16);
    // A taper out to 3.6 m then a straight run — standard cone taper.
    for (let k = 0; k < 12; k++) {
      const t = u0 + k * 1.9;
      const depth = 0.9 + Math.min(3.6, k * 0.62);
      const cx = alongX ? t : kerb + outward * depth;
      const cz = alongX ? kerb + outward * depth : t;
      pl.put(k % 5 === 4 ? 'barrel' : 'cone', cx, cz, 0, 1, null, -1, true);
    }
    const ex = alongX ? u0 - 1.6 : kerb + outward * 1.2;
    const ez = alongX ? kerb + outward * 1.2 : u0 - 1.6;
    pl.put('aframe', ex, ez, alongX ? 0 : Math.PI / 2, 1, null, -1, true);
  }

  /* Site yard: material stacks, welfare units, scaffolding. Everything on a
     site is set down square to the hoarding, because that is the only way it
     fits and because that is how a banksman lands it off a lorry. */
  const n = Math.round((b.w * b.d) / 145 * DENSITY);
  const yard = r.pick(SQUARE);
  const ax = Math.cos(yard), az = -Math.sin(yard);
  for (let i = 0; i < n; i++) {
    const x = b.x + (r() - 0.5) * b.w * 0.78;
    const z = b.z + (r() - 0.5) * b.d * 0.78;
    // The site's own hoarding mesh claims the whole parcel on the shared grid,
    // so this slides along the yard axis rather than consulting it.
    pl.putAlong(r.weighted([
      ['crate', 9], ['pallet', 8], ['sandbags', 6], ['scaffold', 6],
      ['cone', 6], ['barrel', 5], ['aframe', 4], ['portaloo', 3],
      ['jersey', 3], ['waterBarrier', 3], ['dumpster', 5], ['meshFence', 4],
      ['deliveryStack', 3], ['cableDrum', 5], ['stockTrolley', 2], ['trashBags', 2],
    ]), x, z, ax, az, yard + (r() - 0.5) * 0.2);
  }
  // Portaloos come in banks of two or three, shoulder to shoulder facing out.
  if (r.chance(0.7)) {
    const bx = b.x + (r() - 0.5) * b.w * 0.5;
    const bz = b.z + (r() - 0.5) * b.d * 0.5;
    for (let k = 0; k < 2 + r.int(0, 1); k++) {
      pl.putAlong('portaloo', bx + ax * k * 1.35, bz + az * k * 1.35, -az, ax, yard);
    }
  }
  // Pallet + crate stacks cluster near one corner, like a real materials drop:
  // laid out in short rows rather than tipped over the yard at random.
  const dx = b.x + (r() - 0.5) * b.w * 0.45;
  const dz = b.z + (r() - 0.5) * b.d * 0.45;
  for (let k = 0; k < 4 + r.int(0, 4); k++) {
    const row = Math.floor(k / 3), col = k % 3;
    pl.putAlong(r.chance(0.5) ? 'pallet' : 'crate',
      dx + ax * col * 1.5 - az * row * 1.6 + (r() - 0.5) * 0.5,
      dz + az * col * 1.5 + ax * row * 1.6 + (r() - 0.5) * 0.5,
      ax, az, yard + (r() - 0.5) * 0.16);
  }
}
