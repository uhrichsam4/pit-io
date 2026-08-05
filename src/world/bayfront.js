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
import { solid } from '../core/materials.js';
import { M } from './props.js';
import { specimen } from './nature.js';
import { makeRNG } from '../core/rng.js';

const TAU = Math.PI * 2;

/**
 * The island's bounds. A circle, deliberately: the match already owns a
 * circular hard wall (Last Hole Standing's closing ring) and reusing that shape
 * means the "you cannot leave the island" clamp is code that already works.
 */
export const ISLAND = { cx: 4000, cz: 0, r: 178 };

/** Where the park sits inside that circle. +x is the bay, -z is Bayside. */
const P = {
  GRASS: 0x5f9e4a,
  GRASS_DK: 0x4d8a3c,
  PATH: 0xd9b9a0,        // the pink-beige paving the whole park is laid in
  PATH_DK: 0xc2a189,
  PLAZA: 0xe0cdb8,
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
function ring(m, cx, cz, y, rIn, rOut, segs = 48, from = 0, to = TAU) {
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
function buildGround(m) {
  // Grass body of the park — an irregular wedge, bay side bulging east.
  polygon(m, [
    [-150, -190], [-40, -200], [70, -170], [120, -120], [150, -40],
    [158, 40], [130, 120], [70, 175], [-40, 195], [-140, 180], [-165, 60], [-168, -70],
  ], 0.02);
  // Mown bands. Kept SHORT and confined to the open lawn: run full width and
  // they read as a barcode laid over the whole park rather than cut grass.
  m.col(P.GRASS_DK);
  for (let i = -2; i <= 2; i++) {
    strip(m, -120, 40 + i * 15, -20, 44 + i * 15, 9, 0.03);
    strip(m, 10, 130 + i * 13, 90, 132 + i * 13, 8, 0.03);
  }

  /* --- the bay, east of the revetment ---------------------------------- */
  m.col(P.WATER);
  polygon(m, [[150, -200], [340, -200], [340, 210], [90, 210], [140, 120], [162, 30], [156, -60]], -0.35);

  /* --- rock revetment: the whole eastern shore is armoured, not beach --- */
  m.col(P.ROCK);
  const shore = [];
  for (let i = 0; i <= 26; i++) {
    const t = i / 26;
    const z = -180 + t * 370;
    const x = 152 + Math.sin(t * 3.1) * 9 - Math.pow(Math.abs(t - 0.45) * 2, 2) * 14;
    shore.push([x, z]);
  }
  for (let i = 0; i < shore.length - 1; i++) {
    const [x0, z0] = shore[i], [x1, z1] = shore[i + 1];
    strip(m, x0, z0, x1, z1, 11, 0.05);
    // Boulders, so the edge is not a clean line from above.
    if (i % 2 === 0) {
      m.box(x0 + 4, 0, z0, 3.4, 1.5 + (i % 3) * 0.4, 3.0);
    }
  }

  /* --- the baywalk, just inland of the rocks --------------------------- */
  m.col(P.PATH);
  for (let i = 0; i < shore.length - 1; i++) {
    strip(m, shore[i][0] - 9, shore[i][1], shore[i + 1][0] - 9, shore[i + 1][1], 9, 0.06);
  }

  /* --- the great central promenade, boulevard to the fountain ---------- */
  strip(m, -160, 96, 96, 74, 22, 0.07);
  // and the north-south spine
  strip(m, -30, -150, -10, 170, 15, 0.07);

  /* --- radial paths off the fountain plaza ------------------------------ */
  const FX = 96, FZ = 74;
  for (const a of [-2.5, -1.9, -1.25, -0.6, 0.55, 1.2, 1.9]) {
    strip(m, FX + Math.cos(a) * 26, FZ + Math.sin(a) * 26,
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
      strip(m, sx + (ex - sx) * t0, sz + (ez - sz) * t0 + bow,
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

/** The Pepper Fountain — circular, waterfront, stepped basin, ring plaza. */
function buildFountain(m) {
  const cx = 96, cz = 74;
  m.col(P.PLAZA);
  ring(m, cx, cz, 0.08, 20, 62, 56);            // the big paved apron
  m.col(P.PATH_DK);
  ring(m, cx, cz, 0.09, 58, 62, 56);            // its darker outer band

  // Stepped stone basin.
  m.col(P.CONCRETE);
  ring(m, cx, cz, 0.5, 17.5, 20.5, 48);
  ring(m, cx, cz, 1.0, 15.0, 17.5, 48);
  // Water, in two tones so the middle reads deeper.
  m.col(0x35c9d6);
  ring(m, cx, cz, 0.8, 6.5, 15.5, 48);
  m.col(0x18a3b4);
  ring(m, cx, cz, 0.7, 2.5, 6.5, 32);
  // Centre boss and its plume.
  m.col(P.CONCRETE).tube(cx, cz, [[0.7, 2.6], [1.9, 1.9]], 16);
  m.col(0xbfeef6).tube(cx, cz, [[1.9, 1.1], [8.5, 0.35]], 10);
  m.col(0xe6fbff).tube(cx, cz, [[8.5, 1.9], [10.2, 0.2]], 10);
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
  // Light tower — a tapered concrete slab column.
  m.col(P.CONCRETE);
  m.prism(-6, 4, [[0, 9, 9], [3, 7.5, 7.5], [26, 3.4, 3.4]]);
  m.col(0xd8d2c6).prism(-6, 4, [[26, 4.2, 4.2], [29, 1.2, 1.2]]);

  // The triangular reflecting pool the aerials show beside it.
  m.col(0x2aa7b5);
  m.tri([-64, 0.1, 118], [-24, 0.1, 104], [-38, 0.1, 146]);
  m.col(P.CONCRETE_DK);
  strip(m, -66, 120, -22, 102, 3, 0.12);

  // Playground: a canopy of teal sails over soft ground.
  m.col(0xcfa87e);
  polygon(m, [[16, 118], [56, 112], [64, 146], [26, 154]], 0.09);
  m.col(0x2aa39b);
  for (const [px, pz, r] of [[30, 128, 7], [46, 136, 6], [38, 146, 5]]) {
    m.col(P.STEEL).tube(px, pz, [[0, 0.35], [6.5, 0.3]], 6);
    m.col(0x2aa39b);
    for (let i = 0; i < 6; i++) {
      const a0 = (i / 6) * TAU, a1 = ((i + 1) / 6) * TAU;
      m.tri([px, 7.2, pz],
        [px + Math.cos(a0) * r, 4.6, pz + Math.sin(a0) * r],
        [px + Math.cos(a1) * r, 4.6, pz + Math.sin(a1) * r]);
    }
  }

  // Dog park: fenced lawn on the south-east.
  m.col(P.GRASS_DK);
  polygon(m, [[86, 140], [126, 132], [132, 168], [92, 176]], 0.06);
  m.col(P.DARKSTEEL);
  for (let i = 0; i < 18; i++) {
    const t = i / 18;
    m.tube(86 + t * 46, 140 + t * 8, [[0, 0.1], [1.5, 0.08]], 4);
  }
}

/** Planting: real specimens from nature.js, laid out as the aerials show. */
function plant(group, rng) {
  const KINDS = ['liveOak', 'mahogany', 'poinciana', 'banyan', 'sabal', 'coconutA', 'royalA', 'queenPalm'];
  const avail = KINDS.filter((k) => specimen(k, 0));
  if (!avail.length) return;

  /** One InstancedMesh per species, because a park is hundreds of trees. */
  const buckets = new Map();
  const add = (key, x, z, s, rot) => {
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ x, z, s, rot });
  };

  // The dense canopy through the middle of the park.
  for (let i = 0; i < 190; i++) {
    const a = rng() * TAU, rr = Math.sqrt(rng());
    const x = -60 + Math.cos(a) * rr * 95;
    const z = 10 + Math.sin(a) * rr * 120;
    if (Math.hypot(x - 96, z - 74) < 66) continue;       // keep the plaza clear
    if (Math.hypot(x + 8, z + 78) < 82) continue;        // and the amphitheatre
    const k = avail[(rng() * Math.min(3, avail.length)) | 0];
    add(k, x, z, 0.85 + rng() * 0.5, rng() * TAU);
  }
  // Palm rows along the baywalk and the fountain apron — the signature planting.
  const palms = avail.filter((k) => /royal|coconut|sabal|queenPalm|washingtonia/i.test(k));
  if (palms.length) {
    for (let i = 0; i < 34; i++) {
      const t = i / 34;
      add(palms[i % palms.length], 141 - Math.pow(Math.abs(t - 0.45) * 2, 2) * 13,
        -172 + t * 350, 0.9 + rng() * 0.35, rng() * TAU);
    }
    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * TAU;
      add(palms[i % palms.length], 96 + Math.cos(a) * 56, 74 + Math.sin(a) * 56,
        0.9 + rng() * 0.3, rng() * TAU);
    }
  }

  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(),
    _p = new THREE.Vector3(), _s = new THREE.Vector3();
  for (const [key, list] of buckets) {
    const sp = specimen(key, 0);
    if (!sp) continue;
    const inst = new THREE.InstancedMesh(sp.geometry, sp.material, list.length);
    inst.castShadow = true;
    inst.receiveShadow = false;
    list.forEach((t, i) => {
      _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.rot);
      _p.set(t.x, 0, t.z); _s.set(t.s, t.s, t.s);
      inst.setMatrixAt(i, _m.compose(_p, _q, _s));
    });
    inst.instanceMatrix.needsUpdate = true;
    inst.name = `bayfront-${key}`;
    group.add(inst);
  }
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

  const m = new M();
  m.col(P.GRASS);
  buildGround(m);
  buildAmphitheatre(m);
  buildFountain(m);
  buildWheel(m);
  buildBayside(m, rng);
  buildSouth(m, rng);

  const mesh = new THREE.Mesh(m.geometry(), solid({
    name: 'bayfront', vertexColors: true, roughness: 0.72, metalness: 0.03,
  }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'bayfront-shell';
  group.add(mesh);

  plant(group, rng);

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
