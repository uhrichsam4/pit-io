/**
 * BAYFRONT PARK — the spawn island.
 *
 * A reconstruction of Miami's Bayfront Park, used as the waiting room players
 * drive around while the host decides to start. Built from aerial reference: the
 * layout, the landmarks and their positions relative to one another are the real
 * park's. It is NOT surveyed geometry and does not pretend to be — everything
 * here is drawn in code with the same primitives the city uses, in the same
 * stylised register, because a photogrammetry drop-in would clash with every
 * other thing on screen (and this project ships no binary assets at all).
 *
 * WHAT IS IN IT, north to south, matching the reference:
 *   · Bayside Marketplace — long low sheds along the north quay, marina beyond
 *   · Skyviews — the observation wheel on the north-east point
 *   · The amphitheatre — seating bowl, stage under a pitched canopy, and the
 *     big arcing solar roof along its western back edge
 *   · The Noguchi light tower and the slide mound in the middle
 *   · Pepper Fountain — the circular waterfront fountain and its ring plaza
 *   · Playground and dog park to the south
 *   · Rock revetment shoreline and the baywalk down the whole eastern edge
 *   · Biscayne Boulevard and its parking apron to the west
 *
 * WHERE IT LIVES. Far off the city grid at ISLAND.cx, so it can never interact
 * with Miami's colliders, occlusion set or consumables. It is hidden outright
 * during a match — it is several hundred draw calls that nobody can see.
 */

import * as THREE from 'three';
import { solid, ground, Textures } from '../core/materials.js';
import { M } from './props.js';
import { specimen } from './nature.js';
import { GEOMETRY_UNDER_TEST as PED } from './pedestrians.js';
import { makeRNG } from '../core/rng.js';

const TAU = Math.PI * 2;

/**
 * DENSITY.
 *
 * The spawn island is the ONLY thing on screen — buildBayfront hides the entire
 * city while it is up — so the budget that normally has to cover 27,000
 * consumables across a square kilometre goes to one 350 m park. The city's
 * per-kind triangle limits do not apply here and following them anyway is what
 * made the first pass look thin.
 */
const D = {
  canopy: 900,        // shade trees
  understory: 900,
  grass: 5200,        // tufts and ground cover
  palmsWalk: 92,      // baywalk rows
  palmsPlaza: 60,
  crowd: 240,
};

/**
 * The island's bounds. A circle, deliberately: the match already owns a
 * circular hard wall (Last Hole Standing's closing ring) and reusing that shape
 * means the "you cannot leave the island" clamp is code that already works.
 */
export const ISLAND = { cx: 4000, cz: 0, r: 178 };

/** Where the park sits inside that circle. +x is the bay, -z is Bayside. */
const P = {
  GRASS: 0x55913f,
  GRASS_DK: 0x437b34,
  PATH: 0xc9ab96,        // the pink-beige paving the whole park is laid in
  PATH_DK: 0xb2957f,
  PLAZA: 0xcfbca8,
  CONCRETE: 0xbfc3c0,
  CONCRETE_DK: 0x8f9694,
  SAND: 0xded1b0,
  ROCK: 0x8d8577,
  WATER: 0x1d7f8c,
  WHITE: 0xf2f4f2,
  STEEL: 0xb9c2c7,
  DARKSTEEL: 0x5d666b,
  SEAT: 0x36414a,
  ROOF: 0x9aa4a8,
  TEAK: 0xb07a44,
  ASPHALT: 0x3f4247,
  TERRACOTTA: 0xc98b6b,     // the fountain apron and the great promenade
  TERRACOTTA_DK: 0xb0755a,
  TOWER: 0x7d4436,          // the light tower's oxide-red concrete
};

/* ------------------------------------------------------------- helpers --- */

/**
 * A ground triangle guaranteed to face UP.
 *
 * m.tri() derives its normal from the winding, and a downward-facing ground
 * triangle is invisible — the whole lawn, the bay and the fountain basin were
 * culled on the first build because the point order happened to run the other
 * way. Rather than hand-ordering every polygon in this file, work out the sign
 * once per triangle and swap if it came out pointing at the centre of the
 * earth.
 */
function triUp(m, A, B, C) {
  // Y component of (B-A) x (C-A) for points sharing a height.
  const y = (B[2] - A[2]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[2] - A[2]);
  if (y >= 0) m.tri(A, B, C);
  else m.tri(A, C, B);
}

/** Filled polygon on the ground at height y, from a ring of [x,z] points. */
function polygon(m, pts, y, close = true) {
  if (pts.length < 3) return;
  let cx = 0, cz = 0;
  for (const [x, z] of pts) { cx += x; cz += z; }
  cx /= pts.length; cz /= pts.length;
  const n = pts.length;
  for (let i = 0; i < (close ? n : n - 1); i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    triUp(m, [cx, y, cz], [a[0], y, a[1]], [b[0], y, b[1]]);
  }
}

/** An annular band — path rings, plaza edges, the fountain's steps. */
function ring(m, cx, cz, y, rIn, rOut, segs = 72, from = 0, to = TAU) {
  const step = (to - from) / segs;
  for (let i = 0; i < segs; i++) {
    const a0 = from + i * step, a1 = from + (i + 1) * step;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    const A = [cx + c0 * rIn, y, cz + s0 * rIn];
    const B = [cx + c0 * rOut, y, cz + s0 * rOut];
    const C = [cx + c1 * rOut, y, cz + s1 * rOut];
    const D = [cx + c1 * rIn, y, cz + s1 * rIn];
    triUp(m, A, B, C);
    triUp(m, A, C, D);
  }
}

/** A straight paved strip from A to B. */
function strip(m, x0, z0, x1, z1, w, y) {
  const dx = x1 - x0, dz = z1 - z0;
  const l = Math.hypot(dx, dz) || 1;
  const nx = (-dz / l) * (w / 2), nz = (dx / l) * (w / 2);
  const A = [x0 - nx, y, z0 - nz], B = [x0 + nx, y, z0 + nz];
  const C = [x1 + nx, y, z1 + nz], D = [x1 - nx, y, z1 - nz];
  triUp(m, A, B, C);
  triUp(m, A, C, D);
}

/* ------------------------------------------------------------ the park --- */

/**
 * Ground, shoreline and paths. One mesh: this is a lot of flat geometry and
 * every piece of it shares a material, so it has no business being 40 draws.
 */
function buildGround(m, lawn, pave, water, sandM) {
  // Grass body of the park — an irregular wedge, bay side bulging east.
  lawn.col(0xffffff);
  polygon(lawn, [
    [-150, -190], [-40, -200], [70, -170], [120, -120], [150, -40],
    [158, 40], [130, 120], [70, 175], [-40, 195], [-140, 180], [-165, 60], [-168, -70],
  ], 0.02);
  // Mown bands. Kept SHORT and confined to the open lawn: run full width and
  // they read as a barcode laid over the whole park rather than cut grass.
  // Mowing stripes: the SAME texture a shade darker, which is literally what a
  // mower leaves — blades laid in opposite directions.
  lawn.col(0xc8d0c8);
  for (let i = -2; i <= 2; i++) {
    strip(lawn, -120, 40 + i * 15, -20, 44 + i * 15, 9, 0.03);
    strip(lawn, 10, 130 + i * 13, 90, 132 + i * 13, 8, 0.03);
  }

  /* --- the bay, east of the revetment ---------------------------------- */
  water.col(0xffffff);
  polygon(water, [[150, -200], [340, -200], [340, 210], [90, 210], [140, 120], [162, 30], [156, -60]], -0.35);

  /* --- rock revetment: the whole eastern shore is armoured, not beach --- */
  m.col(P.ROCK);
  const shore = [];
  for (let i = 0; i <= 70; i++) {
    const t = i / 70;
    const z = -180 + t * 370;
    const x = 152 + Math.sin(t * 3.1) * 9 - Math.pow(Math.abs(t - 0.45) * 2, 2) * 14;
    shore.push([x, z]);
  }
  for (let i = 0; i < shore.length - 1; i++) {
    const [x0, z0] = shore[i], [x1, z1] = shore[i + 1];
    strip(m, x0, z0, x1, z1, 11, 0.05);
    // Boulders, so the edge is not a clean line from above.
    // Boulders every station, varied, so the revetment reads as rock.
    m.box(x0 + 3 + (i % 3), 0, z0, 2.6 + (i % 4) * 0.5, 1.2 + (i % 5) * 0.35, 2.4 + (i % 3) * 0.5);
    if (i % 3 === 0) m.box(x0 + 6.5, 0, z0 + 2, 2.2, 1.1, 2.0);
  }

  /* --- the baywalk, just inland of the rocks --------------------------- */
  pave.col(0xffffff);
  for (let i = 0; i < shore.length - 1; i++) {
    strip(pave, shore[i][0] - 9, shore[i][1], shore[i + 1][0] - 9, shore[i + 1][1], 9, 0.06);
  }

  /* --- the great central promenade, boulevard to the fountain ---------- */
  pave.col(0xd9a288);
  strip(pave, -160, 96, 96, 74, 24, 0.07);
  pave.col(0xb7876c);
  strip(pave, -160, 84, 96, 62, 2.0, 0.075);
  strip(pave, -160, 108, 96, 86, 2.0, 0.075);
  pave.col(0xffffff);
  // and the north-south spine
  strip(pave, -30, -150, -10, 170, 15, 0.07);

  /* --- radial paths off the fountain plaza ------------------------------ */
  const FX = 96, FZ = 74;
  for (const a of [-2.5, -1.9, -1.25, -0.6, 0.55, 1.2, 1.9]) {
    strip(pave, FX + Math.cos(a) * 26, FZ + Math.sin(a) * 26,
      FX + Math.cos(a) * 120, FZ + Math.sin(a) * 120, 7, 0.065);
  }
  // Curving walks through the tree canopy.
  for (const [sx, sz, ex, ez] of [
    [-120, -60, 40, -110], [-130, 20, -20, -30], [-90, 130, 40, 150], [30, -60, 120, -30],
  ]) {
    const segs = 10;
    for (let i = 0; i < segs; i++) {
      const t0 = i / segs, t1 = (i + 1) / segs;
      const bow = Math.sin(Math.PI * t0) * 22, bow1 = Math.sin(Math.PI * t1) * 22;
      strip(pave, sx + (ex - sx) * t0, sz + (ez - sz) * t0 + bow,
        sx + (ex - sx) * t1, sz + (ez - sz) * t1 + bow1, 6, 0.06);
    }
  }

  /* --- Biscayne Boulevard and its parking apron, west ------------------ */
  m.col(P.ASPHALT);
  strip(m, -196, -200, -196, 200, 26, 0.04);
  m.col(P.CONCRETE_DK);
  strip(m, -176, -200, -176, 200, 12, 0.05);
}

/**
 * The amphitheatre. A seating bowl of concentric stepped wedges facing a stage
 * under a pitched canopy, with the long arcing solar roof behind it — the
 * silhouette that makes this park recognisable from the air.
 */
function buildAmphitheatre(m) {
  const cx = -8, cz = -78;          // stage centre
  const face = Math.PI * 0.5;       // the bowl opens south-east

  // Stepped seating: seven concentric arcs, each a little higher.
  for (let i = 0; i < 7; i++) {
    const rIn = 22 + i * 7.5, rOut = rIn + 7.0, y = 0.6 + i * 1.15;
    m.col(i % 2 ? P.CONCRETE : P.CONCRETE_DK);
    ring(m, cx, cz, y, rIn, rOut, 30, face - 1.25, face + 1.25);
    // riser
    m.col(P.CONCRETE_DK);
    const segs = 30, from = face - 1.25, step = 2.5 / segs;
    for (let k = 0; k < segs; k++) {
      const a0 = from + k * step, a1 = from + (k + 1) * step;
      m.quad(
        [cx + Math.cos(a0) * rIn, y - 1.15, cz + Math.sin(a0) * rIn],
        [cx + Math.cos(a1) * rIn, y - 1.15, cz + Math.sin(a1) * rIn],
        [cx + Math.cos(a1) * rIn, y, cz + Math.sin(a1) * rIn],
        [cx + Math.cos(a0) * rIn, y, cz + Math.sin(a0) * rIn]
      );
    }
    // Seat rows, dark against the pale concrete — this is what reads from above.
    m.col(P.SEAT);
    ring(m, cx, cz, y + 0.06, rIn + 1.6, rOut - 1.6, 30, face - 1.2, face + 1.2);
  }

  // Radial aisles cutting the bowl into blocks.
  m.col(P.CONCRETE);
  for (const a of [-1.25, -0.62, 0, 0.62, 1.25]) {
    const ang = face + a;
    strip(m, cx + Math.cos(ang) * 22, cz + Math.sin(ang) * 22,
      cx + Math.cos(ang) * 75, cz + Math.sin(ang) * 75, 3.2, 9.0);
  }

  // Stage deck and its pitched canopy.
  m.col(P.CONCRETE_DK).box(cx, 0, cz, 34, 1.6, 22);
  m.col(P.DARKSTEEL).box(cx, 1.6, cz, 30, 0.6, 19);
  for (const [ox, oz] of [[-14, -8.5], [14, -8.5], [-14, 8.5], [14, 8.5]]) {
    m.col(P.STEEL).tube(cx + ox, cz + oz, [[1.6, 0.45], [13, 0.38]], 6);
  }
  // A hipped roof: four quads to an apex, which is the real stage house.
  m.col(P.ROOF);
  const rx = 19, rz = 13, ry = 13, apex = 18.5;
  const c = [[cx - rx, ry, cz - rz], [cx + rx, ry, cz - rz], [cx + rx, ry, cz + rz], [cx - rx, ry, cz + rz]];
  for (let i = 0; i < 4; i++) {
    m.tri(c[i], c[(i + 1) % 4], [cx, apex, cz]);
  }

  /* The solar canopy: a long shallow arc of dark panels on white legs, curving
     around the back of the bowl. It is the single most identifiable thing in
     the aerials, so it gets its own geometry rather than being suggested. */
  const scR = 88;
  for (let i = 0; i < 26; i++) {
    const a0 = face + 0.95 + (i / 26) * 1.5;
    const a1 = face + 0.95 + ((i + 1) / 26) * 1.5;
    const y = 7.5 + Math.sin((i / 26) * Math.PI) * 2.2;
    m.col(0x2b3440);
    m.quad(
      [cx + Math.cos(a0) * (scR - 7), y, cz + Math.sin(a0) * (scR - 7)],
      [cx + Math.cos(a0) * (scR + 7), y - 1.4, cz + Math.sin(a0) * (scR + 7)],
      [cx + Math.cos(a1) * (scR + 7), y - 1.4, cz + Math.sin(a1) * (scR + 7)],
      [cx + Math.cos(a1) * (scR - 7), y, cz + Math.sin(a1) * (scR - 7)]
    );
    if (i % 3 === 0) {
      m.col(P.WHITE);
      m.tube(cx + Math.cos(a0) * scR, cz + Math.sin(a0) * scR, [[0, 0.4], [y - 0.7, 0.32]], 6);
    }
  }
}

/**
 * The Claude Pepper Fountain and its plaza.
 *
 * A civic plaza is not one flat orange disc. Radial banding, concentric joint
 * lines and a pale kerb are what the close aerial actually shows, and they are
 * what stop a 120 m circle reading as a car park. Colour corrected too: the
 * apron is terracotta and the water is jade in rings, not beige and pool-blue.
 */
function buildFountain(m, pave) {
  const cx = 96, cz = 74;

  pave.col(0xcfae95);
  ring(pave, cx, cz, 0.08, 21, 60, 96);
  pave.col(0xc2a189);
  for (let i = 0; i < 24; i += 2) {
    ring(pave, cx, cz, 0.085, 23, 58, 4, (i / 24) * TAU, ((i + 1) / 24) * TAU);
  }
  pave.col(0xb5977f);
  for (const r of [30, 39, 48, 56]) ring(pave, cx, cz, 0.09, r - 0.35, r + 0.35, 96);

  m.col(0xdcd3c4);
  ring(m, cx, cz, 0.12, 60, 61.6, 96);
  ring(m, cx, cz, 0.12, 20.2, 21.4, 96);
  m.col(0xa8443a);
  ring(m, cx, cz, 0.16, 18.8, 20.2, 96);

  m.col(P.CONCRETE);
  ring(m, cx, cz, 0.55, 17.2, 18.8, 84);
  m.col(P.WHITE);
  ring(m, cx, cz, 0.62, 16.2, 17.2, 84);

  m.col(0x3fbf9a); ring(m, cx, cz, 0.5, 12.6, 16.2, 84);
  m.col(0x2aa98a); ring(m, cx, cz, 0.44, 8.6, 12.6, 72);
  m.col(0xd8efe6); ring(m, cx, cz, 0.50, 7.4, 8.6, 72);
  m.col(0x1f8f78); ring(m, cx, cz, 0.38, 3.0, 7.4, 60);

  m.col(P.CONCRETE).tube(cx, cz, [[0.38, 3.0], [1.5, 2.2]], 24);
  m.col(0xcdf2ea).tube(cx, cz, [[1.5, 1.0], [7.5, 0.32]], 12);
  m.col(0xeafbf6).tube(cx, cz, [[7.5, 1.7], [9.2, 0.18]], 12);

  /* Benches facing the water. Every civic fountain has them and they are what
     make a plaza read as somewhere people sit rather than somewhere they cross.
     Angles are jittered so twenty of them are not a perfect clock face. */
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * TAU + 0.08 + Math.sin(i * 2.3) * 0.05;
    const rr = 26 + Math.sin(i * 1.7) * 1.2;
    const bx = cx + Math.cos(a) * rr, bz = cz + Math.sin(a) * rr;
    m.col(P.CONCRETE_DK);
    m.box(bx - 0.9, 0.1, bz - 0.9, 1.8, 0.42, 1.8);
    m.col(i % 3 ? P.TEAK : 0xa06f3d);
    for (let k = 0; k < 3; k++) m.box(bx - 1.55 + k * 1.1, 0.52, bz - 0.72, 0.95, 0.1, 1.45);
    m.col(P.STEEL);
    m.box(bx - 1.7, 0.12, bz - 0.8, 0.14, 0.42, 1.6);
    m.box(bx + 1.56, 0.12, bz - 0.8, 0.14, 0.42, 1.6);
  }
}


/** Skyviews — the observation wheel on the north-east point. */
function buildWheel(m) {
  const cx = 104, cz = -156, R = 34;
  // Two A-frame legs.
  m.col(P.WHITE);
  for (const s of [-1, 1]) {
    m.tubeBetween(cx + s * 14, 0, cz - 11, cx, R, cz, 1.5, 6);
    m.tubeBetween(cx + s * 14, 0, cz + 11, cx, R, cz, 1.5, 6);
  }
  m.col(P.STEEL).tube(cx, cz, [[R - 1.6, 2.4], [R + 1.6, 2.4]], 10);

  // Rim and spokes, in the plane facing the bay.
  const N = 28;
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * TAU, a1 = ((i + 1) / N) * TAU;
    const p0 = [cx + Math.cos(a0) * R, R + Math.sin(a0) * R, cz];
    const p1 = [cx + Math.cos(a1) * R, R + Math.sin(a1) * R, cz];
    m.col(P.WHITE);
    m.tubeBetween(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], 0.5, 4);
    m.tubeBetween(cx, R, cz, p0[0], p0[1], p0[2], 0.22, 3);
    // Gondolas hang from every other rim node.
    if (i % 2 === 0) {
      m.col(i % 4 === 0 ? 0x37e6d5 : 0xf2f4f2);
      m.box(p0[0] - 1.5, p0[1] - 4.2, cz - 1.5, 3.0, 2.6, 3.0);
    }
  }
}

/** Bayside Marketplace: long low sheds on the north quay, and the marina. */
function buildBayside(m, rng) {
  m.col(P.WHITE);
  // Two parallel sheds with the teal roof accents from the reference.
  for (const [ox, oz, w, d] of [[40, -178, 128, 22], [46, -148, 118, 20]]) {
    m.box(ox - w / 2, 0, oz - d / 2, w, 9, d);
    m.col(P.ROOF).box(ox - w / 2, 9, oz - d / 2, w, 1.2, d);
    m.col(0x2fa8a0);
    for (let i = 0; i < 5; i++) m.box(ox - w / 2 + 12 + i * 24, 9.2, oz - d / 2 - 0.6, 9, 2.2, d + 1.2);
    m.col(P.WHITE);
  }
  // The octagonal pavilion at the point.
  m.col(P.WHITE).tube(132, -186, [[0, 17], [8, 17]], 8);
  m.col(0xb03a3a).tube(132, -186, [[8, 18], [9.4, 16]], 8);

  /* Marina: finger piers and moored boats. The park reads as waterfront only
     if the water has something in it. */
  m.col(P.TEAK);
  for (let i = 0; i < 6; i++) {
    const z = -196 + i * 13;
    strip(m, 150, z, 214, z, 3.2, 0.5);
  }
  for (let i = 0; i < 11; i++) {
    const z = -200 + i * 12 + (rng() * 4 - 2);
    const x = 168 + rng() * 34;
    const L = 8 + rng() * 12;
    m.col(P.WHITE);
    m.box(x, 0.2, z - 1.7, L, 2.2, 3.4);
    m.col(0xdfe6ea).box(x + L * 0.3, 2.4, z - 1.1, L * 0.4, 1.7, 2.2);
  }
}

/** The Noguchi light tower, the slide mound, playground and dog park. */
function buildSouth(m, rng) {
  // (the light tower and the Challenger Memorial live in buildMonuments)

  // The triangular reflecting pool the aerials show beside it.
  m.col(0x2aa7b5);
  m.tri([-64, 0.1, 118], [-24, 0.1, 104], [-38, 0.1, 146]);
  m.col(P.CONCRETE_DK);
  strip(m, -66, 120, -22, 102, 3, 0.12);

  // Playground surfacing only — nature.js's playground model sits on it.
  m.col(0xcfa87e);
  polygon(m, [[16, 118], [56, 112], [64, 146], [26, 154]], 0.09);

  // Dog park: fenced lawn on the south-east.
  m.col(P.GRASS_DK);
  polygon(m, [[86, 140], [126, 132], [132, 168], [92, 176]], 0.06);
  m.col(P.DARKSTEEL);
  for (let i = 0; i < 18; i++) {
    const t = i / 18;
    m.tube(86 + t * 46, 140 + t * 8, [[0, 0.1], [1.5, 0.08]], 4);
  }
}

/**
 * PLACEMENT RULES.
 *
 * The density pass scattered planting across the park with a few circular
 * exclusions and turned Bayfront into a jungle: foliage closed over the paths,
 * buried the amphitheatre and hid the bay. A real civic park is mostly OPEN —
 * lawns you can see across, a plaza, clear sightlines to the water and the
 * skyline — with planting in defined belts and beds.
 *
 * Nothing is scattered freely now. Every placement is tested against a path
 * corridor, the open areas, landmark footprints, and an occupancy grid so two
 * things can never share a spot.
 */

/** Centre-lines of every walkway: [x0,z0,x1,z1,halfWidth]. */
const PATHS = [
  [-160, 96, 96, 74, 13],
  [-30, -150, -10, 170, 8.5],
];
for (const a of [-2.5, -1.9, -1.25, -0.6, 0.55, 1.2, 1.9]) {
  PATHS.push([96 + Math.cos(a) * 26, 74 + Math.sin(a) * 26,
    96 + Math.cos(a) * 120, 74 + Math.sin(a) * 120, 4.5]);
}
for (let i = 0; i < 70; i++) {
  const t = i / 70, t2 = (i + 1) / 70;
  const bx = (u) => 141 - Math.pow(Math.abs(u - 0.45) * 2, 2) * 13;
  PATHS.push([bx(t) - 9, -180 + t * 370, bx(t2) - 9, -180 + t2 * 370, 7]);
}

/** Deliberately empty: [x, z, radius]. Lawns, plaza, audience ground. */
const OPEN = [
  [-96, 46, 40],      // the great west lawn
  [-8, -50, 56],      // the amphitheatre's audience lawn — in FRONT of the bowl,
  [-8, -100, 40],     //   and the bowl itself, rather than one 84 m disc that
                      //   reached halfway across the park and ate two groves
  [96, 74, 58],       // the fountain plaza
  [-104, 74, 30],     // the pavilion lawn
  [34, 22, 30],       // the central lawn
  [-44, 152, 26],     // the south lawn
];

/** Landmark footprints: [x, z, radius]. */
const BUILT = [
  [104, -156, 40], [40, -178, 70], [46, -148, 62], [-6, 4, 12],
  [-104, 128, 14], [-78, -18, 22], [40, 132, 22], [108, 156, 12], [-214, 40, 30],
];

function distToSeg(px, pz, x0, z0, x1, z1) {
  const dx = x1 - x0, dz = z1 - z0;
  const L = dx * dx + dz * dz;
  const t = L ? Math.max(0, Math.min(1, ((px - x0) * dx + (pz - z0) * dz) / L)) : 0;
  return Math.hypot(px - (x0 + dx * t), pz - (z0 + dz * t));
}

function blocked(x, z, r, opts) {
  const open = !opts || opts.open !== false;
  const path = !opts || opts.path !== false;
  // A landmark must not be rejected by its OWN entry in BUILT. The playground
  // and the hoop were, which left their surfacing painted on the ground with
  // nothing standing on it — a bare tan rectangle beside the fountain.
  const built = !opts || opts.built !== false;
  if (x < -164 || x > 148 || z < -194 || z > 188) return true;
  if (path) {
    for (let i = 0; i < PATHS.length; i++) {
      const s = PATHS[i];
      if (distToSeg(x, z, s[0], s[1], s[2], s[3]) < s[4] + r + 1.2) return true;
    }
  }
  if (open) {
    for (const o of OPEN) if (Math.hypot(x - o[0], z - o[1]) < o[2]) return true;
  }
  if (built) {
    for (const b of BUILT) if (Math.hypot(x - b[0], z - b[1]) < b[2] + r) return true;
  }
  return false;
}

/**
 * Everything placed rather than modelled: planting and park furniture.
 *
 * nature.js owns finished models for all of it, so this calls specimen()
 * instead of re-modelling badly, and keeps the island in the city's register.
 * One InstancedMesh per species.
 */
function dress(group, rng) {
  const buckets = new Map();
  const CELL = 3;
  const taken = new Set();
  const free = (x, z, r) => {
    const n = Math.ceil(r / CELL), gx = Math.floor(x / CELL), gz = Math.floor(z / CELL);
    for (let i = -n; i <= n; i++) {
      for (let j = -n; j <= n; j++) if (taken.has(`${gx + i},${gz + j}`)) return false;
    }
    return true;
  };
  const claim = (x, z, r) => {
    const n = Math.max(0, Math.ceil(r / CELL) - 1);
    const gx = Math.floor(x / CELL), gz = Math.floor(z / CELL);
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) taken.add(`${gx + i},${gz + j}`);
  };
  const put = (k, x, z, s = 1, rot = null, r = 2.5, opts) => {
    if (blocked(x, z, r, opts) || !free(x, z, r)) return false;
    claim(x, z, r);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push({ x, z, s, rot: rot == null ? rng() * TAU : rot });
    return true;
  };
  const pick = (a) => a[(rng() * a.length) | 0];

  const CANOPY = ['liveOak', 'liveOak', 'banyan', 'mahogany', 'seagrapeT', 'tabebuia'];
  const FLOWER = ['poinciana', 'jacaranda'];

  // The western shade belt — the park's wall against Biscayne Boulevard.
  for (let i = 0; i < 190; i++) {
    put(rng() < 0.07 ? pick(FLOWER) : pick(CANOPY),
      -158 + rng() * 32, -190 + rng() * 380, 0.9 + rng() * 0.55, null, 4 + rng() * 2);
  }
  // Groves BETWEEN the open areas, which is where the aerials show tree mass.
  const GROVES = [
    [-78, -6, 24], [26, 96, 26], [-56, 112, 22], [70, 6, 26],
    [14, -140, 28], [-126, -104, 30], [96, 136, 20], [-118, 6, 22],
    [56, -108, 24], [-40, -152, 26], [116, 96, 16], [-96, 158, 20],
    [66, 56, 18], [-140, 88, 18],
  ];
  for (const [gx, gz, gr] of GROVES) {
    for (let i = 0; i < 90; i++) {
      const a = rng() * TAU, rr = Math.sqrt(rng()) * gr;
      put(rng() < 0.07 ? pick(FLOWER) : pick(CANOPY),
        gx + Math.cos(a) * rr, gz + Math.sin(a) * rr, 0.9 + rng() * 0.55, null, 4 + rng() * 2);
    }
  }

  // Specimen trees standing alone on the lawns. A real park lawn is not bare —
  // it has half a dozen big trees with clear ground under them.
  for (const [ox, oz, orr] of OPEN) {
    const n = Math.max(1, Math.round(orr / 16));
    for (let i = 0; i < n; i++) {
      const a = rng() * TAU, rr = (0.35 + rng() * 0.45) * orr;
      put(pick(CANOPY), ox + Math.cos(a) * rr, oz + Math.sin(a) * rr,
        1.05 + rng() * 0.4, null, 7, { open: false });
    }
  }

  /* --- palms: rows and rings, jittered so they are not a grid ------------- */
  const PALM = ['royalA', 'royalB', 'coconutA', 'coconutB', 'queenPalm', 'sabal', 'washingtonia'];
  for (let i = 0; i < 64; i++) {
    const t = i / 64;
    const bx = 141 - Math.pow(Math.abs(t - 0.45) * 2, 2) * 13;
    const bz = -172 + t * 350 + (rng() - 0.5) * 3.5;
    put(PALM[(i * 3 + 1) % PALM.length], bx - 1.5 + (rng() - 0.5) * 1.5, bz,
      1.0 + rng() * 0.3, null, 2.2, { path: false });
    if (i % 2 === 0) {
      put(PALM[(i * 5 + 2) % PALM.length], bx - 18 + (rng() - 0.5) * 3, bz + 3,
        0.95 + rng() * 0.3, null, 2.2, { open: false });
    }
  }
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * TAU + (rng() - 0.5) * 0.05;
    const rr = 57 + (rng() - 0.5) * 2.5;
    put(PALM[(i * 3) % PALM.length], 96 + Math.cos(a) * rr, 74 + Math.sin(a) * rr,
      1.0 + rng() * 0.25, null, 2.2, { open: false, path: false });
  }
  for (let i = 0; i < 22; i++) {
    const t = i / 22, x = -148 + t * 226, z = 95 - t * 22;
    put(i % 2 ? 'royalA' : 'royalB', x + (rng() - 0.5) * 2, z - 17 + (rng() - 0.5) * 2,
      1.05 + rng() * 0.2, null, 2.2, { open: false });
    put(i % 2 ? 'royalB' : 'royalA', x + (rng() - 0.5) * 2, z + 17 + (rng() - 0.5) * 2,
      1.05 + rng() * 0.2, null, 2.2, { open: false });
  }

  /* --- understory at grove edges and in beds, never loose on a lawn ------- */
  const UNDER = ['shrub', 'shrub', 'arecaClump', 'fanShort', 'sago', 'traveller'];
  const BLOOM = ['hibiscus', 'bougain', 'croton'];
  for (const [gx, gz, gr] of GROVES) {
    for (let i = 0; i < 40; i++) {
      const a = rng() * TAU, rr = (0.72 + rng() * 0.5) * gr;
      put(rng() < 0.22 ? pick(BLOOM) : pick(UNDER),
        gx + Math.cos(a) * rr, gz + Math.sin(a) * rr, 0.8 + rng() * 0.5, null, 2.2);
    }
  }
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * TAU;
    put(rng() < 0.42 ? pick(BLOOM) : 'hedge', 96 + Math.cos(a) * 62, 74 + Math.sin(a) * 62,
      0.9 + rng() * 0.35, a + Math.PI / 2 + (rng() - 0.5) * 0.2, 1.6,
      { open: false, path: false });
  }

  /* --- grass ONLY on the lawns, which is what a lawn is ------------------- */
  for (const [ox, oz, orr] of OPEN) {
    const n = Math.round(orr * orr * 0.55);
    for (let i = 0; i < n; i++) {
      const a = rng() * TAU, rr = Math.sqrt(rng()) * (orr - 3);
      const x = ox + Math.cos(a) * rr, z = oz + Math.sin(a) * rr;
      if (blocked(x, z, 0.4, { open: false })) continue;
      const k = rng() < 0.6 ? 'ornGrass' : 'groundcover';
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push({ x, z, s: 0.65 + rng() * 0.65, rot: rng() * TAU });
    }
  }

  /* --- furniture serves the thing it stands beside ------------------------ */
  for (let i = 0; i < 24; i++) {
    const t = i / 24;
    put('parkLamp', -146 + t * 226, 95 - t * 22 - 15.5, 1, 0, 1.2, { open: false });
    put('parkLamp', -146 + t * 226, 95 - t * 22 + 15.5, 1, 0, 1.2, { open: false });
  }
  for (let i = 0; i < 26; i++) {
    const t = i / 26;
    put('parkLamp', 141 - Math.pow(Math.abs(t - 0.45) * 2, 2) * 13 - 15.5,
      -168 + t * 340, 1, 0, 1.2, { open: false });
  }
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * TAU;
    put('parkLamp', 96 + Math.cos(a) * 45, 74 + Math.sin(a) * 45, 1, 0, 1.2,
      { open: false, path: false });
  }
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * TAU + 0.22;
    put(i % 2 ? 'planterL' : 'planterS', 96 + Math.cos(a) * 23.5, 74 + Math.sin(a) * 23.5,
      1, a, 1.6, { open: false, path: false });
  }
  put('pergola', -132, 30, 1.2, 0.35, 6, { open: false, built: false });
  put('pergola', 64, 160, 1.1, -0.6, 6, { open: false, built: false });
  put('playground', 40, 132, 1.3, 0.2, 10, { open: false, built: false, path: false });
  put('hoop', 108, 158, 1.0, 0.5, 5, { open: false, built: false });
  put('flagUS', -24, 34, 1.2, 0, 3, { open: false, built: false });
  put('bandshell', -8, -78, 1.6, Math.PI, 8, { open: false, path: false, built: false });

  /* --- instance them ------------------------------------------------------ */
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(),
    _p = new THREE.Vector3(), _s = new THREE.Vector3(), _ax = new THREE.Vector3(0, 1, 0);
  let placed = 0;
  for (const [k, list] of buckets) {
    const sp = specimen(k, 0);
    if (!sp || !list.length) continue;
    const inst = new THREE.InstancedMesh(sp.geometry, sp.material, list.length);
    inst.castShadow = true;
    inst.receiveShadow = false;
    inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3), 3);
    list.forEach((t, i) => {
      _q.setFromAxisAngle(_ax, t.rot);
      _p.set(t.x, 0, t.z);
      _s.set(t.s * (0.9 + rng() * 0.2), t.s * (0.86 + rng() * 0.3), t.s * (0.9 + rng() * 0.2));
      inst.setMatrixAt(i, _m.compose(_p, _q, _s));
      const v = 0.84 + rng() * 0.26;
      inst.instanceColor.setXYZ(i, v * (0.96 + rng() * 0.08), v, v * (0.94 + rng() * 0.09));
    });
    inst.instanceMatrix.needsUpdate = true;
    inst.instanceColor.needsUpdate = true;
    inst.name = `bayfront-${k}`;
    group.add(inst);
    placed += list.length;
  }
  return placed;
}


/**
 * The downtown skyline behind the park.
 *
 * Every reference photo of Bayfront Park is really a photo of the park AND the
 * wall of Brickell and Downtown towers behind it — take those away and the
 * place reads as a field by the sea. They are pure backdrop: no collision, no
 * consumables, never approached, so they are boxes with glass banding and that
 * is the correct amount of geometry to spend.
 */
function buildSkyline(m, rng) {
  const GLASS = [0x8fb6c9, 0x7fa8bd, 0xa8c6d4, 0x6f97ad, 0x9fc3cf];
  const place = (x, z, w, d, h, seed) => {
    const g = GLASS[seed % GLASS.length];
    m.col(0xd9dde0).box(x - w / 2, 0, z - d / 2, w, 3, d);          // podium
    m.col(g).box(x - w / 2, 3, z - d / 2, w, h, d);
    // Spandrel banding: the single cue that reads as "tower" at this distance.
    m.col(0xf0f4f6);
    for (let y = 6; y < h; y += 7) {
      m.box(x - w / 2 - 0.25, y, z - d / 2 - 0.25, w + 0.5, 1.1, d + 0.5);
    }
    m.col(0xc8d2d8).box(x - w / 2 + 1.5, 3 + h, z - d / 2 + 1.5, w - 3, 2.2, d - 3);
    if (seed % 3 === 0) {
      m.col(0x9aa4aa).tube(x, z, [[5 + h, 0.5], [5 + h + 14, 0.22]], 5);
    }
  };
  // The Biscayne Boulevard wall, west of the park.
  for (let i = 0; i < 16; i++) {
    const z = -210 + i * 27 + rng() * 8;
    const h = 46 + rng() * 118;
    place(-250 - rng() * 46, z, 26 + rng() * 16, 24 + rng() * 14, h, i);
  }
  // A second rank further back, shorter, to give the wall depth.
  for (let i = 0; i < 13; i++) {
    place(-330 - rng() * 70, -220 + i * 34 + rng() * 10,
      22 + rng() * 14, 22 + rng() * 12, 34 + rng() * 80, i + 5);
  }
  // Brickell across the mouth of the river, seen past the point to the south.
  for (let i = 0; i < 9; i++) {
    place(150 + rng() * 120, 300 + rng() * 90, 24 + rng() * 14, 24 + rng() * 12,
      54 + rng() * 96, i + 2);
  }
}

/**
 * The Challenger Memorial and the light tower.
 *
 * The memorial is Noguchi's twisting helix — it reads as both a DNA strand and
 * the shuttle — and it stands in the south-west corner. The first pass had a
 * plain tapered slab here, which is neither.
 */
function buildMonuments(m) {
  // Challenger Memorial: two counter-rotating helical ribbons on a low plinth.
  const hx = -104, hz = 128;
  m.col(P.CONCRETE_DK);
  ring(m, hx, hz, 0.3, 0, 11, 24);
  m.col(P.WHITE);
  for (const phase of [0, Math.PI]) {
    let px = null;
    for (let i = 0; i <= 34; i++) {
      const t = i / 34;
      const a = phase + t * Math.PI * 2.6;
      const r = 5.4 * (1 - t * 0.55);
      const y = 0.3 + t * 27;
      const cur = [hx + Math.cos(a) * r, y, hz + Math.sin(a) * r];
      if (px) m.tubeBetween(px[0], px[1], px[2], cur[0], cur[1], cur[2], 0.85, 5);
      px = cur;
    }
  }

  // The light tower: an oxide-red concrete cylinder, the tallest thing in the
  // park and visible in every reference photo.
  m.col(P.TOWER);
  m.tube(-6, 4, [[0, 5.2], [30, 4.4]], 12);
  m.col(0x62362b).tube(-6, 4, [[30, 4.8], [32, 4.0]], 12);
  m.col(0x2f3338);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    m.box(-6 + Math.cos(a) * 4.3, 8, 4 + Math.sin(a) * 4.3, 1.2, 18, 1.2);
  }

  // Noguchi's geometric mound — the stepped grass cone the aerials show.
  m.col(P.GRASS_DK);
  for (let i = 0; i < 5; i++) {
    ring(m, -78, -18, 0.4 + i * 1.5, 0, 20 - i * 3.6, 20);
  }

  // White tensile sail canopies, south-west of the lawn.
  m.col(P.WHITE);
  for (const [sx, sz] of [[-118, 92], [-100, 104], [-124, 116]]) {
    m.col(P.STEEL).tube(sx, sz, [[0, 0.3], [8, 0.24]], 5);
    m.col(P.WHITE);
    for (let i = 0; i < 5; i++) {
      const a0 = (i / 5) * TAU, a1 = ((i + 1) / 5) * TAU;
      m.tri([sx, 8.4, sz],
        [sx + Math.cos(a0) * 9, 3.4, sz + Math.sin(a0) * 9],
        [sx + Math.cos(a1) * 9, 3.4, sz + Math.sin(a1) * 9]);
    }
  }
}


/**
 * The Tina Hills Pavilion.
 *
 * The white fabric shell on the south lawn — in every aerial it is a cluster of
 * peaked sails over a low stage, with a shallow arc of stepped seating facing
 * it. Much smaller than the main amphitheatre and quite different in character:
 * that one is dark concrete and seating, this one is white and floats.
 */
function buildPavilion(m) {
  const cx = -104, cz = 74;

  // Stage deck.
  m.col(P.CONCRETE);
  ring(m, cx, cz, 0.35, 0, 13, 28, -0.5, Math.PI + 0.5);
  m.col(P.CONCRETE_DK);
  ring(m, cx, cz, 0.15, 12.4, 13.6, 28, -0.5, Math.PI + 0.5);

  // Four masts carrying a run of peaked sails, the shape the photos show.
  const peaks = [[-8, -3, 7.5], [0, -5, 9.0], [8, -3, 7.5]];
  for (const [ox, oz, ph] of peaks) {
    m.col(P.STEEL).tube(cx + ox, cz + oz, [[0, 0.34], [ph, 0.24]], 6);
    m.col(P.WHITE);
    // A sail is a cone pulled down to four corners, not a flat disc — that
    // droop between the masts is the whole look.
    const R = 7.2;
    for (let i = 0; i < 8; i++) {
      const a0 = (i / 8) * TAU, a1 = ((i + 1) / 8) * TAU;
      const sag = 0.55;
      m.tri(
        [cx + ox, ph + 0.6, cz + oz],
        [cx + ox + Math.cos(a0) * R, ph - 2.4 - Math.abs(Math.sin(a0 * 2)) * sag, cz + oz + Math.sin(a0) * R],
        [cx + ox + Math.cos(a1) * R, ph - 2.4 - Math.abs(Math.sin(a1 * 2)) * sag, cz + oz + Math.sin(a1) * R]
      );
    }
  }

  // The shallow arc of steps facing it.
  for (let i = 0; i < 4; i++) {
    const rIn = 17 + i * 3.4, y = 0.25 + i * 0.42;
    m.col(i % 2 ? P.CONCRETE : P.CONCRETE_DK);
    ring(m, cx, cz, y, rIn, rIn + 3.2, 24, 0.35, Math.PI - 0.35);
  }
}

/**
 * The Metromover viaduct along Biscayne Boulevard.
 *
 * Two pale concrete guideway beams on round columns, running the length of the
 * park's western edge, with a station where the promenade meets the boulevard.
 * It is in the background of most of the reference photos and it is the single
 * clearest cue that this park is in Downtown Miami rather than anywhere else.
 */
function buildMetromover(m) {
  const X = -214;           // just west of the boulevard
  const Y = 9.6;            // deck height
  const z0 = -206, z1 = 206;

  m.col(0xc4c8c6);
  // Columns on a regular bay, each with a flared head.
  for (let z = z0; z <= z1; z += 19) {
    m.tube(X, z, [[0, 1.5], [Y - 1.6, 1.25]], 10);
    m.prism(X, z, [[Y - 1.6, 4.4, 3.2], [Y - 0.5, 5.6, 3.8]]);
  }
  /* Twin guideway beams and their running rails.
     box() CENTRES on the z it is given. Passing the start of the run put each
     412 m beam half off the north end of the island and left the columns
     standing under nothing — the viaduct had no deck at all. */
  const zc = (z0 + z1) / 2, zl = z1 - z0;
  for (const off of [-2.4, 2.4]) {
    m.col(0xd2d6d3);
    m.box(X + off - 1.7, Y - 0.5, zc, 3.4, 1.5, zl);
    m.col(0x9aa09c);
    m.box(X + off - 1.9, Y + 1.0, zc, 0.5, 0.5, zl);
    m.box(X + off + 1.4, Y + 1.0, zc, 0.5, 0.5, zl);
  }

  /* The station: a barrel-vault canopy on a platform, with a lift tower. */
  const sz = 40;
  m.col(0xd8dbd8).box(X - 7, Y + 1.0, sz, 14, 0.5, 34);
  m.col(0xbfc4c1);
  for (let i = 0; i <= 12; i++) {
    const a0 = Math.PI * (i / 12), a1 = Math.PI * ((i + 1) / 12);
    const R = 8.4, cy = Y + 4.2;
    m.quad(
      [X + Math.cos(a0) * R, cy + Math.sin(a0) * 3.4, sz - 17],
      [X + Math.cos(a1) * R, cy + Math.sin(a1) * 3.4, sz - 17],
      [X + Math.cos(a1) * R, cy + Math.sin(a1) * 3.4, sz + 17],
      [X + Math.cos(a0) * R, cy + Math.sin(a0) * 3.4, sz + 17]
    );
  }
  // Lift / stair tower, the tall grey slab in the reference.
  m.col(0xb6bbb8).box(X + 7, 0, sz, 6.5, Y + 7, 10);
  m.col(0x39424a).box(X + 7.2, 2, sz - 3.4, 6.1, 8, 6.6);
  // Stair run down to the pavement.
  m.col(0xc4c8c6);
  for (let i = 0; i < 12; i++) {
    m.box(X + 14, i * 0.85, sz - 4 + i * 1.6, 5, 0.9, 1.7);
  }

  // A car sitting in the station — small, red, and unmistakably a Mover.
  m.col(0xdedede).box(X - 2.2 - 1.6, Y + 1.5, sz, 3.2, 3.2, 18);
  m.col(0xc23b32).box(X - 2.2 - 1.7, Y + 3.4, sz, 3.4, 0.9, 18);
  m.col(0x2b3238).box(X - 2.2 - 1.75, Y + 2.4, sz, 3.5, 1.4, 16);
}


/**
 * A stylised standing figure, built once and instanced.
 *
 * pedestrians.js exposes its parts, but composing a standing pose out of eight
 * separate part geometries per person is a lot of matrix work for a crowd that
 * never animates. One low-poly body at the game's own level of abstraction is
 * cheaper, reads correctly at the distance anyone sees it, and takes its colour
 * per instance so a crowd is not a hundred identical clones.
 */
function figureGeometry() {
  const f = new M();
  f.col(0xffffff);
  f.tube(0, 0, [[0, 0.10], [0.44, 0.085]], 5);              // legs, together
  f.tube(0.09, 0, [[0, 0.09], [0.44, 0.075]], 5);
  f.prism(0, 0, [[0.44, 0.40, 0.24], [0.62, 0.44, 0.26], [1.16, 0.40, 0.23]]);  // torso
  f.prism(0, 0, [[1.16, 0.30, 0.20], [1.26, 0.22, 0.18]]);  // shoulders/neck
  f.tube(0, 0, [[1.26, 0.145], [1.52, 0.135], [1.60, 0.09]], 6);   // head
  for (const sx of [-0.26, 0.26]) {                          // arms
    f.tube(sx, 0, [[0.52, 0.07], [1.14, 0.075]], 5);
  }
  return f.geometry();
}

/**
 * Promenade life.
 *
 * People GATHER. Scattering 250 figures evenly over a park is the same mistake
 * as scattering the trees — it reads as noise, not as a crowd. These cluster
 * where the reference photos put them: the fountain apron, the baywalk, the
 * promenade, the amphitheatre steps and the pavilion, in knots of two to six
 * with a few loners walking between.
 *
 * Static instances rather than agents. This is a waiting room, and a crowd that
 * wandered would need collision against a park that has none.
 */
function crowd(group, rng) {
  const mat = solid({ name: 'bayfront-crowd', vertexColors: true, roughness: 0.78, metalness: 0.02 });
  const SKIN = [0xe8c39a, 0xd9a878, 0xb07a4e, 0x8a5a36, 0xf0d3b4];
  const WEAR = [0xff6b8a, 0x37e6d5, 0xffd25e, 0xf2f4f2, 0x4dd2ff, 0xff9f43, 0x9b7bff, 0x6fdc8c];

  /** [x, z, spread, groups] — the social areas, weighted by how busy they are. */
  const HAUNTS = [
    [96, 74, 34, 14],       // the fountain plaza
    [124, -40, 16, 5],      // baywalk north
    [128, 60, 16, 6],       // baywalk by the fountain
    [120, 140, 14, 4],      // baywalk south
    [-40, 88, 26, 7],       // the great promenade
    [-8, -34, 26, 6],       // amphitheatre steps
    [-104, 82, 18, 5],      // the pavilion
    [40, 132, 14, 3],       // playground
  ];

  const spots = [];
  const near = (x, z, r) => [x + (rng() - 0.5) * r, z + (rng() - 0.5) * r];
  for (const [hx, hz, spread, groups] of HAUNTS) {
    for (let g = 0; g < groups; g++) {
      // A knot of people standing together, then jitter within the knot.
      const [cx0, cz0] = near(hx, hz, spread * 2);
      const n = 2 + ((rng() * 5) | 0);
      for (let i = 0; i < n; i++) {
        const [x, z] = near(cx0, cz0, 3.2);
        // Never on a lawn (that is what makes lawns read as open) and never on
        // a path centre-line, but the plaza and promenade edges are fine.
        if (blocked(x, z, 0.6, { open: true, path: false })) continue;
        spots.push([x, z]);
      }
    }
  }
  // A few walking alone along the baywalk and the promenade.
  for (let i = 0; i < 26; i++) {
    const t = rng();
    const bx = 141 - Math.pow(Math.abs(t - 0.45) * 2, 2) * 13;
    spots.push([bx - 9 + (rng() - 0.5) * 4, -170 + t * 344]);
  }
  for (let i = 0; i < 14; i++) {
    const t = rng();
    spots.push([-150 + t * 236, 96 - t * 22 + (rng() - 0.5) * 9]);
  }

  const geo = figureGeometry();
  const inst = new THREE.InstancedMesh(geo, mat, spots.length);
  inst.castShadow = true;
  inst.receiveShadow = false;
  inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(spots.length * 3), 3);
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(),
    _p = new THREE.Vector3(), _s = new THREE.Vector3(), _ax = new THREE.Vector3(0, 1, 0);
  const _c = new THREE.Color();
  spots.forEach(([x, z], i) => {
    _q.setFromAxisAngle(_ax, rng() * TAU);
    _p.set(x, 0, z);
    // Adults, a few children, nobody exactly the same height.
    const h = rng() < 0.16 ? 0.7 + rng() * 0.12 : 0.94 + rng() * 0.2;
    _s.set(h * (0.93 + rng() * 0.13), h, h * (0.93 + rng() * 0.13));
    inst.setMatrixAt(i, _m.compose(_p, _q, _s));
    _c.setHex(rng() < 0.4 ? SKIN[(rng() * SKIN.length) | 0] : WEAR[(rng() * WEAR.length) | 0]);
    inst.instanceColor.setXYZ(i, _c.r, _c.g, _c.b);
  });
  inst.instanceMatrix.needsUpdate = true;
  inst.instanceColor.needsUpdate = true;
  inst.name = 'bayfront-crowd';
  group.add(inst);

  /* Birds and dogs where they would actually be: pigeons on paving, dogs on
     the lawn edges and the promenade. */
  const extras = [
    ['pigeon', 40, 1.0, [[96, 74, 30], [124, 40, 16], [-40, 90, 18]]],
    ['dogShort', 4, 1.0, [[-40, 92, 12], [40, 130, 10]]],
    ['dogLean', 3, 1.0, [[124, 20, 12]]],
  ];
  for (const [k, n, sc, zones] of extras) {
    const g = PED[k] && PED[k]();
    if (!g) continue;
    const im = new THREE.InstancedMesh(g, mat, n);
    im.castShadow = true;
    for (let i = 0; i < n; i++) {
      const [zx, zz, zr] = zones[i % zones.length];
      const a = rng() * TAU, r = Math.sqrt(rng()) * zr;
      _q.setFromAxisAngle(_ax, rng() * TAU);
      _p.set(zx + Math.cos(a) * r, 0, zz + Math.sin(a) * r);
      _s.set(sc * (0.9 + rng() * 0.2), sc, sc * (0.9 + rng() * 0.2));
      im.setMatrixAt(i, _m.compose(_p, _q, _s));
    }
    im.instanceMatrix.needsUpdate = true;
    im.name = `bayfront-${k}`;
    group.add(im);
  }

  /* Vendor kit belongs in the active social areas, not on a lawn. */
  const kit = [
    ['streetTable', [[108, 52], [-46, 92]]],
    ['streetCooler', [[110, 55], [-44, 95]]],
    ['trolley', [[106, 50]]],
    ['tripod', [[126, -24], [118, 118]]],
  ];
  for (const [k, at] of kit) {
    const g = PED[k] && PED[k]();
    if (!g) continue;
    const im = new THREE.InstancedMesh(g, mat, at.length);
    im.castShadow = true;
    at.forEach(([x, z], i) => {
      _q.setFromAxisAngle(_ax, rng() * TAU);
      _p.set(x, 0, z); _s.set(1, 1, 1);
      im.setMatrixAt(i, _m.compose(_p, _q, _s));
    });
    im.instanceMatrix.needsUpdate = true;
    im.name = `bayfront-${k}`;
    group.add(im);
  }

  return spots.length;
}


/* --------------------------------------------------------------- build --- */

/**
 * Build the spawn island and add it to the scene, hidden.
 *
 * @returns {{ group:THREE.Group, bounds:{cx:number,cz:number,r:number},
 *             spawns:{x:number,z:number}[], show:Function, hide:Function }}
 */
export function buildBayfront(scene) {
  const rng = makeRNG(0xba4f20);
  const group = new THREE.Group();
  group.name = 'bayfront';
  group.position.set(ISLAND.cx, 0, ISLAND.cz);

  /**
   * FOUR meshes, not one.
   *
   * The first version drew the whole island into a single vertexColors solid
   * with no map on it, and that is the entire reason it read as a 2002 game:
   * every surface was a flat untextured colour. The city does not do that —
   * streets.js and nature.js put real procedural textures and normal maps on
   * every ground plane. Splitting by material costs three extra draw calls and
   * buys grass that looks like grass.
   */
  const m = new M();          // structures: vertex-coloured solid
  const lawn = new M();       // grass, textured
  const pave = new M();       // paths and plazas, textured
  const water = new M();      // the bay
  const sandM = new M();      // beach / soft surfacing

  m.col(P.GRASS);
  buildGround(m, lawn, pave, water, sandM);
  buildAmphitheatre(m);
  buildFountain(m, pave);
  buildWheel(m);
  buildBayside(m, rng);
  buildSouth(m, rng);
  buildMonuments(m);
  buildSkyline(m, rng);
  buildPavilion(m);
  buildMetromover(m);

  /**
   * Planar UVs from world XZ.
   *
   * props.js's M builder writes position, normal, colour and glow — but no uv,
   * because a prop is vertex-coloured and never needs one. That is why the
   * grass and paving textures were invisible: `map:` had no coordinates to
   * sample and every surface stayed a flat fill. Every surface being textured
   * here is horizontal, so projecting straight down is not an approximation —
   * it is the correct mapping, and it tiles seamlessly across the whole park.
   */
  const planarUV = (g, tiles) => {
    const pos = g.getAttribute('position');
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      uv[i * 2] = pos.getX(i) / tiles;
      uv[i * 2 + 1] = pos.getZ(i) / tiles;
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  };

  const addMesh = (builder, material, name, shadow = true, tiles = 0) => {
    const g = builder.geometry();
    if (!g.getAttribute('position') || g.getAttribute('position').count === 0) return;
    if (tiles) planarUV(g, tiles);
    const mesh = new THREE.Mesh(g, material);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    mesh.name = `bayfront-${name}`;
    group.add(mesh);
  };

  addMesh(lawn, ground({
    name: 'bayfront-lawn', map: Textures.grass(), color: 0x86a878,
    roughness: 0.98, metalness: 0, vertexColors: true,
  }), 'lawn', false, 9);

  addMesh(pave, ground({
    name: 'bayfront-pave',
    map: Textures.paving(512, 0xc9ab96, 'rgba(150,140,120,0.45)', 5),
    roughness: 0.92, metalness: 0, vertexColors: true,
  }), 'pave', false, 6);

  addMesh(water, solid({
    name: 'bayfront-water', color: 0x1d8f9c, roughness: 0.16, metalness: 0.35,
    envMapIntensity: 1.6, vertexColors: true,
  }), 'water', false, 24);

  addMesh(sandM, ground({
    name: 'bayfront-sand', map: Textures.sand(), color: 0xd9cdb2,
    roughness: 0.95, metalness: 0, vertexColors: true,
  }), 'sand', false, 7);

  addMesh(m, solid({
    name: 'bayfront', vertexColors: true, roughness: 0.72, metalness: 0.03,
  }), 'shell', true);

  const n = dress(group, rng);
  const people = crowd(group, rng);
  console.info(`[bayfront] spawn island: ${n} plants and props, ${people} people`);

  // Spawn ring: on the great lawn, spread so nobody lands on a landmark or on
  // top of somebody else.
  const spawns = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    spawns.push({
      x: ISLAND.cx - 40 + Math.cos(a) * 62,
      z: ISLAND.cz + 20 + Math.sin(a) * 62,
    });
  }

  group.visible = false;
  scene.add(group);

  return {
    group,
    bounds: { cx: ISLAND.cx, cz: ISLAND.cz, r: ISLAND.r },
    spawns,
    show() { group.visible = true; },
    hide() { group.visible = false; },
  };
}
