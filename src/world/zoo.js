/**
 * THE ZOO — every part of it that is not an animal.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AND WHY IT LOOKS LIKE THIS
 * ---------------------------------------------------------------------------
 * 1. THE SITE IS NOT CHOSEN HERE. `layout.zoo` is decided in cityLayout, before
 *    anything is placed, exactly the way `b.court` is — and for exactly the
 *    same reason. The first basketball court picked its own site inside
 *    props.js, which runs AFTER nature.js, and shipped four courts with one
 *    hoop each because a tree already stood on every piece it wanted to put
 *    down. A zoo is a far bigger clearing than a court and would have failed
 *    far worse. This module is a CONSUMER of a reservation somebody else made.
 *    If the reservation is not there it logs once and returns cleanly; a world
 *    build must not die because one content module has no site.
 *
 * 2. IT OWNS ITS OWN PROP TABLE. props.js keeps DEFS, geometryFor, factoryFor,
 *    mat and its Placer module-private — only the `M` mesh builder is exported.
 *    So the zoo carries its own DEFS-shaped table (`ZOO_DEFS`), its own
 *    geometry cache and its own two-pass placer, and registers every pool
 *    through `ctx.addInstanced` directly. Nothing in props.js is edited.
 *
 * 3. IT BORROWS MODELS, NOT POOLS. A zoo needs a bench, a wire bin, a park lamp
 *    and a planter, and props.js already models all four beautifully. It does
 *    NOT add to those pools: props.js sizes every pool to its exact final count
 *    (`capacity: counts.get(key)` in its emit), so an extra `add()` against
 *    `benchSlat` returns slot -1 and `addInstanced` returns null — a whole prop
 *    kind that silently places nothing, which is this codebase's signature
 *    failure mode. Instead each borrowed model gets a pool of its OWN key
 *    sharing the SAME BufferGeometry: one extra draw call, zero extra
 *    triangles, no capacity collision. See `borrowModel`.
 *
 * 4. SIZE IS MEASURED, NOT DECLARED. worldBuild measures the contact footprint
 *    off the merged geometry, so the `r`/`h` in ZOO_DEFS are fallbacks only.
 *    What the table really decides is TIER, and tier is a gameplay judgement
 *    about what a hole of a given size should be able to swallow:
 *      fence panel / rail / info board  SMALL   — a starting 2 m hole eats it
 *      pen gate / turnstile / buggy     MEDIUM
 *      ticket booth / viewing deck      LARGE
 *      entrance arch / service shed     XLARGE  — the arch is 12 m across
 *
 * 5. THE PATHS AND THE POND WATER GO THROUGH materials.ground(). Anything at
 *    ground level that does not is a surface the hole cannot cut, and the void
 *    then renders UNDERNEATH an intact path. Same rule nature.js states in its
 *    own header for lawn, paving, courts and pond water.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE ORCHESTRATOR HAS TO WIRE
 * ---------------------------------------------------------------------------
 * `buildZoo` must be added to MODULES in worldBuild.js AFTER 'props' and
 * BEFORE 'vehicles'/'pedestrians':
 *   - after props, so `ctx.props.pools` already holds the bench/bin/lamp/
 *     planter models this file borrows (it degrades to its own stand-ins if
 *     they are missing, but the borrowed ones are better);
 *   - before pedestrians, so the `ctx.occupy` calls for the big structures are
 *     still read by the crowd pass.
 * This module publishes `ctx.zoo` and `scene.userData.zoo` describing the
 * habitats, viewing points, paths and yard, which is what the animal agent
 * should place against. It deliberately does NOT occupy habitat interiors —
 * doing so would blanket the pens on the coarse 3 m grid and every animal that
 * asked `ctx.isFree` inside one would be refused. See `OCCUPY_MIN`.
 */

import * as THREE from 'three';
import { TIER, PALETTE } from '../config.js';
import { makeRNG } from '../core/rng.js';
import { solid, ground, Textures } from '../core/materials.js';
import { M } from './props.js';

const P = PALETTE;
const T = TIER;
const TAU = Math.PI * 2;

/** Fence, wall and rail modules are all authored this long so they tile. */
const FENCE_MOD = 2.60;
/** Surfaced path width. Two buggies, or a buggy and a pushchair. */
const PATH_W = 3.10;

/**
 * A prop only claims ground on the shared occupancy grid if its footprint is
 * bigger than this. `occupy` rounds any radius up to whole 3 m cells in EVERY
 * direction, so a 1.4 m fence panel would mark a 9 m square — do that all the
 * way round a 20 m pen and the pen's whole interior is flagged occupied, which
 * is precisely how the animal pass would end up placing nothing. Only the big
 * back-of-house structures, which pedestrians genuinely must not walk into,
 * are worth that cost.
 */
const OCCUPY_MIN = 2.0;

/* ========================================================== helpers ===== */
/* Local copies of the props.js part library. props.js exports the builder and
   nothing else, so the shared parts — a slat run, a bolt head, a blocky sign
   legend — have to be re-stated here. Kept deliberately small: these are the
   only four that earn their place across more than one zoo prop. */

/**
 * Flat rectangle facing +z (or -z). Two triangles.
 * Same contract as props.js's `decal`: `z` is the offset of the +z face, and
 * `dir < 0` mirrors it to -z. A one-sided sign is a blank plate from behind.
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

/**
 * A WORD, drawn as blocks, on both faces.
 *
 * At this game's camera a sign is legible by its RHYTHM — block, gap, block —
 * and not by its glyphs; props.js proves that with `legendBoth` on every street
 * sign in the city. Anything finer is triangles nobody can resolve.
 */
function word(m, cx, cy, z, w, h, n) {
  const gap = w / (n * 4.5);
  const bw = (w - gap * (n - 1)) / n;
  for (let k = 0; k < n; k++) {
    const x = cx - w / 2 + bw / 2 + k * (bw + gap);
    // Letters are not all the same height; three of a kind in a row is the
    // thing that makes blocks read as blocks instead of as a word.
    const hh = h * (k % 3 === 1 ? 0.78 : 1);
    decal(m, x, cy, z, bw, hh, 1);
    decal(m, x, cy, z, bw, hh, -1);
  }
}

/**
 * Flat decal lying on a leaf raked in the YZ plane. Info panels, price boards.
 *
 * `off` is signed along (dz, -dy). For a leaf that RISES the vector points
 * down-and-back, so a decal meant for the FRONT of an upright panel takes a
 * NEGATIVE offset — get this backwards and every panel photographs blank,
 * which is exactly what happened to props.js's sandwich boards the first time.
 */
function rake(m, cx, w, y0, z0, y1, z1, off) {
  const dy = y1 - y0, dz = z1 - z0;
  const L = Math.hypot(dy, dz) || 1;
  const ny = dz / L, nz = -dy / L;
  const A = [cx - w / 2, y0 + ny * off, z0 + nz * off];
  const B = [cx + w / 2, y0 + ny * off, z0 + nz * off];
  const C = [cx + w / 2, y1 + ny * off, z1 + nz * off];
  const D = [cx - w / 2, y1 + ny * off, z1 + nz * off];
  return off >= 0 ? m.quad(A, D, C, B) : m.quad(A, B, C, D);
}

/** Horizontal torus. Hose coils, tyre rims, drum flanges. */
function ring(m, cx, cy, cz, R, tubeR, segs = 10) {
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * TAU, a1 = ((i + 1) / segs) * TAU;
    m.tubeBetween(
      cx + Math.cos(a0) * R, cy, cz + Math.sin(a0) * R,
      cx + Math.cos(a1) * R, cy, cz + Math.sin(a1) * R,
      tubeR, 4
    );
  }
}

/**
 * Overlapping-lobe foliage mass. One cone reads as a low-poly gem; three offset
 * domes read as a plant. Straight out of props.js's `bush`, for the same reason
 * it was written there.
 */
function lobes(m, x, y, z, r, hexA, hexB, segs = 5, n = 3) {
  const set = [
    [0, 0, 0, 0.92, hexA],
    [r * 0.74, r * 0.16, -r * 0.50, 0.76, hexB],
    [-r * 0.66, -r * 0.04, r * 0.58, 0.70, hexB],
  ];
  for (let i = 0; i < n; i++) {
    const [dx, dy, dz, k, hex] = set[i];
    m.col(hex);
    m.tube(x + dx, z + dz, [
      [y + dy, r * k * 0.66], [y + dy + r * k * 0.72, r * k], [y + dy + r * k * 1.60, r * k * 0.34],
    ], segs, { capTop: true, rot: i * 0.9 });
  }
}

/* ==================================================== entrance shapes === */

/**
 * THE ENTRANCE ARCH. 12 m across, 7.9 m tall — the single thing that tells a
 * player from four hundred metres up that this district is a zoo.
 *
 * Two masonry piers, a lintel, an arch-topped sign board with lettering on BOTH
 * faces, wrought-iron leaves standing open, and a lantern on each cap. The
 * contact patch is the two plinths, 12.3 m apart, so the measured footprint is
 * ~6.2 m and it lands squarely in XLARGE: a hole has to be most of a bus wide
 * before the front gate goes anywhere.
 */
function gZooArch(m) {
  const HW = 5.20;                    // pier centre offset from the road axis
  const PY = 5.05;                    // top of the piers

  for (const s of [-1, 1]) {
    const x = s * HW;
    m.col(0xb9ab90);                                                    // rubble plinth
    m.oct(x, 0, [[0, 1.86, 1.52, 0.18], [0.30, 1.80, 1.46, 0.18], [0.38, 1.68, 1.34, 0.16]]);
    m.col(P.STUCCO_PEACH);                                              // rendered shaft
    m.oct(x, 0, [[0.38, 1.56, 1.24, 0.15], [4.56, 1.46, 1.16, 0.15]], { capTop: false });
    m.col(0xe6d8bc);                                                    // moulded cap
    m.oct(x, 0, [[4.56, 1.72, 1.42, 0.15], [4.80, 1.82, 1.52, 0.15], [PY, 1.68, 1.38, 0.15]]);
    // Banner on the outer face of each pier. Two garden pillars become a
    // GATEWAY the moment something hangs off them.
    m.col(P.FABRIC_AQUA);
    m.prism(x, 0.64, [[1.34, 0.98, 0.05], [3.94, 0.98, 0.05]]);
    m.col(P.FABRIC_WHITE);
    for (let k = 0; k < 4; k++) decal(m, x, 3.60 - k * 0.42, 0.675, 0.62, 0.20);
    m.col(P.SIGN_DARK);
    m.prism(x, 0.64, [[1.24, 1.06, 0.06], [1.34, 1.06, 0.06]]);         // banner weight bar
    // Lantern on the cap.
    m.col(0x33413f).tube(x, 0, [[PY, 0.13], [PY + 0.16, 0.19], [PY + 0.24, 0.15]], 6, { capTop: true });
    m.lit(P.LAMP_GLOW, 1, 1.05).tube(x, 0, [[PY + 0.24, 0.20], [PY + 0.62, 0.18]], 6);
    m.col(0x33413f).tube(x, 0, [[PY + 0.62, 0.22], [PY + 0.82, 0.16], [PY + 1.00, 0.04]], 6, { capTop: true });
  }

  /* Lintel spanning the piers, with a real cornice band — the top edges are the
     only ones on the silhouette from a 40-degree camera, so that is where the
     section changes go. */
  m.col(0xe6d8bc);
  m.prism(0, 0, [[PY, 12.30, 1.28], [PY + 0.16, 12.76, 1.48],
    [PY + 0.96, 12.76, 1.48], [PY + 1.14, 12.34, 1.30]]);
  m.col(P.STUCCO_PEACH);
  m.prism(0, 0, [[PY + 0.30, 11.20, 1.53], [PY + 0.84, 11.20, 1.53]]);  // recessed frieze

  /* Sign board with an arched crown. The crown is drawn 4 cm THINNER than the
     board it sits on: at equal thickness the two front faces are coplanar over
     the whole overlap and z-fight across the entire sign. */
  const SY = PY + 1.14;
  m.col(P.STUCCO_CREAM);
  m.prism(0, 0, [[SY, 6.80, 0.34], [SY + 1.02, 6.80, 0.34]]);
  m.discZ(0, SY + 1.02, 3.40, 0.30, 14, 0, 1.32);
  m.col(0x9c8f74);                                                       // board frame
  for (const s of [-1, 1]) m.prism(s * 3.34, 0, [[SY, 0.14, 0.38], [SY + 1.06, 0.14, 0.38]]);
  m.col(P.SIGN_GREEN);
  word(m, 0, SY + 0.50, 0.19, 5.10, 0.54, 3);                            // the name
  m.col(P.SIGN_DARK);
  word(m, 0, SY + 1.42, 0.17, 2.90, 0.24, 4);                            // the strapline
  // A paw-print roundel each side of the crown: two discs and four toes, and
  // it is the one motif that says ZOO rather than BOTANIC GARDEN.
  for (const s of [-1, 1]) {
    m.col(P.ACCENT_SUN);
    m.faceZ(s * 2.30, SY + 1.40, 0.18, 0.34, 8);
    m.col(P.SIGN_DARK);
    m.faceZ(s * 2.30, SY + 1.34, 0.19, 0.15, 7);
    for (let k = 0; k < 4; k++) {
      const a = 0.55 + (k / 3) * (Math.PI - 1.1);
      m.faceZ(s * 2.30 + Math.cos(a) * 0.22, SY + 1.40 + Math.sin(a) * 0.22, 0.19, 0.055, 6);
    }
  }

  /* Iron leaves, hung on the pier faces and standing OPEN. A closed gate on the
     way into a public attraction reads as "shut", which is the one thing this
     object must not say. */
  for (const s of [-1, 1]) {
    const L = 4.00, dir = -s;
    m.xform(s * 0.34, s * (HW - 0.80), 0, 0);
    m.col(0x33413f);
    m.tubeBetween(0, 0.06, 0, 0, 3.34, 0, 0.055, 5);                     // hinge stile
    m.tubeBetween(dir * L, 0.06, 0, dir * L, 3.02, 0, 0.050, 5);         // lock stile
    m.tubeBetween(0, 3.34, 0, dir * L, 3.02, 0, 0.044, 5);               // raked top rail
    m.tubeBetween(0, 0.18, 0, dir * L, 0.18, 0, 0.040, 5);
    m.tubeBetween(0, 1.72, 0, dir * L, 1.62, 0, 0.038, 5);
    for (let k = 1; k < 13; k++) {
      const t = k / 13, x = dir * L * t;
      m.tubeBetween(x, 0.18, 0, x, 3.34 + (3.02 - 3.34) * t, 0, 0.021, 4);
    }
    m.col(P.ACCENT_SUN);
    m.discZ(dir * L * 0.5, 2.30, 0.42, 0.05, 9, 0, 0.42);                // gilt roundel
    m.reset();
  }
}

/**
 * Flanking wall. Runs away from the arch to the corner of the site, so the
 * entrance reads as a boundary you pass THROUGH rather than a free-standing
 * pergola with open ground either side.
 */
function gZooGateWall(m) {
  const W = 2.90, H = 1.92;
  m.col(0xb9ab90);
  m.prism(0, 0, [[0, W + 0.16, 0.72], [0.26, W + 0.10, 0.66]]);          // plinth
  m.col(P.STUCCO_PEACH);
  m.oct(0, 0, [[0.26, W, 0.52, 0.06], [H - 0.16, W, 0.52, 0.06]], { capTop: false });
  m.col(0xe6d8bc);
  m.prism(0, 0, [[H - 0.16, W + 0.14, 0.66], [H - 0.05, W + 0.18, 0.70], [H, W + 0.10, 0.62]]);
  // Pilaster at one end, so a run of these has a rhythm instead of being a
  // single extruded ribbon 30 m long.
  m.col(0xe6d8bc);
  m.prism(W / 2, 0, [[0.26, 0.42, 0.68], [H + 0.16, 0.40, 0.66], [H + 0.30, 0.50, 0.76], [H + 0.38, 0.42, 0.68]]);
  m.col(0x9c8f74);
  m.prism(0, 0, [[0.92, W - 0.20, 0.545], [1.00, W - 0.20, 0.545]]);     // string course
  m.col(P.PATINA);
  m.prism(-0.35, 0.28, [[1.14, 0.74, 0.04], [1.62, 0.74, 0.04]]);        // bronze plaque
  m.col(0x2f4a42);
  for (let k = 0; k < 3; k++) decal(m, -0.35, 1.50 - k * 0.13, 0.305, 0.58, 0.05);
}

/**
 * Waist-high tripod turnstile with a ticket scanner.
 *
 * The arms are the whole read, so they are three real tubes on a hub at 120
 * degrees rather than a disc — from directly overhead, which is this game's
 * only angle, a disc is a coin.
 */
function gZooTurnstile(m) {
  m.col(0x8d949c);
  m.tube(0, 0, [[0, 0.30], [0.06, 0.28], [0.10, 0.24]], 8, { capTop: true });      // base
  m.tube(0, 0, [[0.10, 0.115], [0.86, 0.105]], 8, { capTop: false });              // column
  m.col(P.CHROME);
  m.tube(0, 0, [[0.86, 0.16], [0.96, 0.15], [1.00, 0.10]], 8, { capTop: true });   // hub
  for (let k = 0; k < 3; k++) {
    const a = 0.5 + (k / 3) * TAU;
    m.tubeBetween(0, 0.92, 0, Math.cos(a) * 0.62, 0.92, Math.sin(a) * 0.62, 0.035, 5, true);
  }
  // Scanner post beside it, with a live green pad.
  m.col(0x53605c);
  m.prism(0.74, 0, [[0, 0.34, 0.30], [0.06, 0.30, 0.26]]);
  m.oct(0.74, 0, [[0.06, 0.24, 0.22, 0.04], [1.06, 0.22, 0.20, 0.04], [1.12, 0.26, 0.24, 0.05]]);
  m.lit(P.LIGHT_GREEN, 1, 0.9);
  decal(m, 0.74, 0.94, 0.105, 0.15, 0.11);
  m.col(P.SIGN_FACE);
  decal(m, 0.74, 0.74, 0.105, 0.16, 0.20);
  m.col(0x36414a);
  m.prism(0.74, 0, [[0.66, 0.20, 0.215], [0.86, 0.20, 0.215]]);                    // reader body
}

/**
 * TICKET BOOTH. A booth is its window: a dark recess, glazing set back inside
 * it, a counter shelf sticking out to rest a wallet on, and a price board.
 * Without the recess it is a shed with a blue rectangle painted on it.
 */
function gZooTicketBooth(m) {
  const W = 3.30, D = 2.50, H = 2.44;
  m.col(0xbfb4a0);
  m.prism(0, 0, [[0, W + 0.30, D + 0.30], [0.14, W + 0.22, D + 0.22]]);            // plinth
  m.col(P.STUCCO_CREAM);
  m.oct(0, 0, [[0.14, W, D, 0.17], [H, W, D, 0.17]], { capTop: false });
  m.col(P.STUCCO_AQUA);
  m.prism(0, 0, [[0.14, W + 0.01, D + 0.01], [0.62, W + 0.01, D + 0.01]]);         // dado band

  // Window: recess, glazing, transom, counter.
  m.col(0x23272e);
  m.prism(0, D / 2 - 0.10, [[0.98, 2.16, 0.22], [2.14, 2.16, 0.22]]);
  m.col(P.GLASS_AQUA, 1.08);
  m.prism(0, D / 2 - 0.02, [[1.42, 2.00, 0.05], [2.06, 2.00, 0.05]]);
  m.col(0xdfe4e2);
  m.prism(0, D / 2 - 0.015, [[1.36, 2.06, 0.07], [1.44, 2.06, 0.07]]);             // transom
  for (const s of [-1, 0, 1]) m.prism(s * 0.68, D / 2 - 0.015, [[1.42, 0.06, 0.07], [2.08, 0.06, 0.07]]);
  m.col(0x8f7a58);
  m.prism(0, D / 2 + 0.18, [[1.00, 2.34, 0.50], [1.09, 2.30, 0.46]]);              // counter shelf
  m.col(0x6b5540);
  for (const s of [-1, 1]) m.beam(s * 0.94, 0.99, D / 2 + 0.02, s * 0.94, 0.72, D / 2 + 0.36, 0.07, 0.07, false);

  // Price board on the -x return, and a chalked "OPEN" by the window.
  m.col(P.SIGN_DARK);
  m.prism(-W / 2 - 0.03, -0.30, [[1.18, 0.06, 1.10], [2.16, 0.06, 1.10]]);
  m.col(P.SIGN_FACE);
  for (let k = 0; k < 5; k++) {
    m.xform(Math.PI / 2, -W / 2 - 0.065, 0, -0.30);
    decal(m, 0, 2.00 - k * 0.18, 0.0, 0.86, 0.07);
    m.reset();
  }
  m.col(P.ACCENT_SUN);
  decal(m, 1.28, 1.86, D / 2 + 0.005, 0.42, 0.30);
  m.col(P.SIGN_DARK);
  decal(m, 1.28, 1.86, D / 2 + 0.008, 0.30, 0.06);

  // Hipped tile roof with a real overhang, plus a lamp over the window.
  m.col(P.TERRACOTTA);
  m.prism(0, 0, [[H, W + 0.74, D + 0.74], [H + 0.14, W + 0.62, D + 0.62],
    [H + 0.62, 1.30, 0.94], [H + 0.70, 0.70, 0.46]]);
  m.col(0x9c5f42);
  m.prism(0, 0, [[H + 0.02, W + 0.78, D + 0.78], [H + 0.08, W + 0.74, D + 0.74]]); // fascia bead
  m.col(0x53605c);
  m.beam(0, H + 0.06, D / 2 + 0.30, 0, H - 0.22, D / 2 + 0.60, 0.06, 0.06, false);
  m.lit(P.LAMP_GLOW, 1, 1.0);
  m.tube(0, D / 2 + 0.60, [[H - 0.34, 0.16], [H - 0.24, 0.20], [H - 0.20, 0.10]], 7, { capTop: true });
}

/* ================================================== fence family ======== */

/**
 * MESH PANEL — the workhorse barrier. Welded mesh on a steel frame.
 *
 * Verticals close, horizontals sparse: that ratio is what reads as animal-grade
 * mesh instead of as chain-link, and it is the difference between this and the
 * `fenceChain` props.js uses round a basketball court.
 */
function gZooFenceMesh(m) {
  const W = FENCE_MOD, H = 2.06;
  m.col(0x5c6a66);
  for (const s of [-1, 1]) {
    const x = s * W / 2;
    m.prism(x, 0, [[0, 0.30, 0.30], [0.09, 0.26, 0.26], [H - 0.02, 0.17, 0.17], [H + 0.07, 0.22, 0.22]]);
  }
  m.col(0x6f7d78);
  m.box(0, H - 0.20, 0, W, 0.09, 0.10);                                   // top rail
  m.box(0, 0.13, 0, W, 0.08, 0.09);                                       // bottom rail
  m.box(0, H * 0.48, 0, W, 0.055, 0.07);                                  // mid rail
  m.col(0x93a09a);
  for (let k = 1; k < 15; k++) {
    const x = -W / 2 + (W * k) / 15;
    m.tubeBetween(x, 0.19, 0, x, H - 0.16, 0, 0.014, 3);
  }
  for (let k = 1; k < 6; k++) {
    const y = 0.19 + ((H - 0.37) * k) / 6;
    m.tubeBetween(-W / 2 + 0.12, y, 0, W / 2 - 0.12, y, 0, 0.012, 3);
  }
  // Outward-canted overhang along the top. Every real animal fence has one and
  // it is the detail that stops this reading as a tennis court.
  m.col(0x5c6a66);
  for (const s of [-1, 1]) m.tubeBetween(s * W / 2, H - 0.02, 0, s * W / 2, H + 0.30, -0.26, 0.035, 4);
  m.tubeBetween(-W / 2, H + 0.30, -0.26, W / 2, H + 0.30, -0.26, 0.030, 4);
}

/**
 * GLASS VIEWING PANEL. Stone plinth, steel mullions, one big pane.
 * Rendered with the 'gloss' material — see the note in props.js on why the
 * glazing in this game is opaque: instanced transparency has no reliable sort
 * order and a frosted opaque pane reads identically from the game camera.
 */
function gZooFenceGlass(m) {
  const W = FENCE_MOD, H = 1.98;
  m.col(0xc4b9a2);
  m.prism(0, 0, [[0, W, 0.44], [0.42, W, 0.40]]);
  m.col(0xe0d6c0);
  m.prism(0, 0, [[0.42, W + 0.08, 0.50], [0.52, W + 0.04, 0.46]]);        // coping
  m.col(0x6f7878);
  for (const s of [-1, 1]) m.tube(s * (W / 2 - 0.10), 0, [[0.50, 0.058], [H, 0.050]], 6, { capTop: true });
  m.col(P.GLASS_AQUA, 1.10);
  m.prism(0, 0, [[0.56, W - 0.28, 0.035], [H - 0.11, W - 0.28, 0.035]]);
  m.col(0xdfe4e2);
  m.box(0, H - 0.11, 0, W - 0.16, 0.07, 0.10);                            // capping rail
  // The smear band at child height. A viewing pane nobody has pressed a face
  // against is a shop window.
  m.col(0xffffff, 1.03);
  decal(m, -0.20, 1.16, 0.023, 1.10, 0.34, 1);
  decal(m, 0.30, 1.28, 0.023, 0.70, 0.26, -1);
}

/** TIMBER POST-AND-RAIL. Grazing paddocks: three rails, bolted, no mesh. */
function gZooFenceTimber(m) {
  const W = FENCE_MOD, H = 1.32;
  m.col(P.WOOD_DARK);
  for (const s of [-1, 1]) {
    m.tube(s * W / 2, 0, [[0, 0.110], [H - 0.10, 0.098], [H, 0.058]], 6, { capTop: true });
  }
  m.tube(0, 0, [[0, 0.098], [H - 0.30, 0.088], [H - 0.24, 0.050]], 6, { capTop: true });
  m.col(P.WOOD_DECK);
  for (const y of [0.40, 0.82, 1.13]) {
    m.prism(0, 0, [[y, W, 0.060], [y + 0.115, W - 0.02, 0.052]]);
  }
  m.col(0x6b5540);
  for (const s of [-1, 1]) {
    for (const y of [0.455, 0.875]) {
      m.xform(0, 0, 0, 0.100); m.discZ(s * W / 2, y, 0.024, 0.035, 5); m.reset();
    }
  }
  // Wire strand slung below the bottom rail — the thing that actually keeps a
  // small animal in, and 12 triangles.
  m.col(0x9aa4a2);
  m.tubeBetween(-W / 2, 0.22, 0.02, W / 2, 0.22, 0.02, 0.010, 3);
}

/** LOW STONE WALL. Coursed rubble with a coping — the boundary to a walk-in. */
function gZooWallStone(m) {
  const W = FENCE_MOD, H = 0.88;
  const tones = [0xc4b9a2, 0xb4a992, 0xcec3ab];
  for (let c = 0; c < 3; c++) {
    const y = 0.02 + c * 0.245;
    const n = 5 + (c % 2);
    const bw = W / n;
    for (let k = 0; k < n; k++) {
      // Staggered course to course. Aligned joints are a brick wall in a
      // texture; staggered ones are masonry at 200 triangles.
      const x = -W / 2 + bw / 2 + k * bw + (c % 2 ? bw * 0.10 : -bw * 0.05);
      m.col(tones[(c * 2 + k) % 3]);
      m.prism(x, 0, [[y, bw * 0.95, 0.42 + (k % 2) * 0.035], [y + 0.23, bw * 0.90, 0.39]]);
    }
  }
  m.col(0xe0d6c0);
  m.prism(0, 0, [[H - 0.10, W + 0.10, 0.52], [H - 0.03, W + 0.06, 0.48], [H, W + 0.02, 0.44]]);
}

/**
 * KEEPER GATE. Sits in a fence run where the service track meets a pen. Heavy
 * frame, sheeted lower half, a real latch and a hazard plate.
 */
function gZooGatePen(m) {
  const W = FENCE_MOD, H = 2.10;
  m.col(0x4a5652);
  for (const s of [-1, 1]) {
    m.prism(s * W / 2, 0, [[0, 0.36, 0.36], [0.12, 0.32, 0.32], [H + 0.10, 0.24, 0.24], [H + 0.22, 0.30, 0.30]]);
  }
  m.col(P.SIGN_GREEN);
  // Leaf, hung a few degrees off the closed line so it reads as a moving part.
  m.xform(0.13, -W / 2 + 0.20, 0, 0);
  m.prism(1.02, 0, [[0.10, 2.14, 0.09], [0.20, 2.14, 0.09]]);            // bottom rail
  m.prism(1.02, 0, [[H - 0.16, 2.14, 0.09], [H - 0.06, 2.14, 0.09]]);    // top rail
  for (const x of [0.02, 2.02]) m.prism(x, 0, [[0.10, 0.10, 0.09], [H - 0.06, 0.10, 0.09]]);
  m.col(0x2f6a4c);
  m.prism(1.02, 0, [[0.20, 2.00, 0.05], [1.02, 2.00, 0.05]]);            // sheeted lower half
  m.col(0x93a09a);
  for (let k = 1; k < 9; k++) m.tubeBetween(0.02 + k * 0.222, 1.06, 0, 0.02 + k * 0.222, H - 0.14, 0, 0.013, 3);
  for (const y of [1.30, 1.62]) m.tubeBetween(0.06, y, 0, 1.98, y, 0, 0.012, 3);
  m.col(P.CHROME);
  m.tubeBetween(1.94, 1.02, -0.10, 1.94, 1.02, 0.14, 0.030, 5, true);    // latch bar
  m.col(P.ACCENT_SUN);
  decal(m, 1.02, 0.62, 0.030, 0.62, 0.40, 1);
  decal(m, 1.02, 0.62, 0.030, 0.62, 0.40, -1);
  m.col(P.SIGN_DARK);
  for (let k = 0; k < 3; k++) {
    decal(m, 1.02, 0.74 - k * 0.11, 0.033, 0.48, 0.045, 1);
    decal(m, 1.02, 0.74 - k * 0.11, 0.033, 0.48, 0.045, -1);
  }
  m.reset();
}

/* ==================================================== viewing zones ===== */

/** Tubular guard rail. Keeps the crowd off the fence line at a viewing point. */
function gZooRail(m) {
  const W = 2.40, H = 1.05;
  for (const s of [-1, 0, 1]) {
    const x = s * (W / 2);
    m.col(0x53605c);
    m.prism(x, 0, [[0, 0.22, 0.22], [0.05, 0.19, 0.19]]);
    m.tube(x, 0, [[0.05, 0.055], [H - 0.06, 0.048]], 6, { capTop: false });
  }
  m.col(P.WOOD_DECK);
  m.prism(0, 0, [[H - 0.06, W + 0.20, 0.11], [H, W + 0.16, 0.10]]);       // timber top cap
  m.col(0x53605c);
  m.tubeBetween(-W / 2 - 0.08, 0.58, 0, W / 2 + 0.08, 0.58, 0, 0.035, 5);
  m.tubeBetween(-W / 2 - 0.08, 0.24, 0, W / 2 + 0.08, 0.24, 0, 0.030, 5);
  // Toe kerb: the low band that stops a dropped pushchair wheel and grounds
  // the rail visually. Without it a rail floats on a 5 cm base plate.
  m.col(0xbfb4a0);
  m.prism(0, 0, [[0, W + 0.30, 0.30], [0.11, W + 0.26, 0.26]]);
}

/**
 * RAISED VIEWING DECK. Timber platform, three steps, rail on the pen side.
 * The boards run across, alternating tone, because from directly above the
 * board joints ARE the object.
 */
function gZooPlatform(m) {
  const W = 4.40, D = 3.20, H = 0.78;
  m.col(0x6b5540);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      m.prism(sx * (W / 2 - 0.26), sz * (D / 2 - 0.26), [[0, 0.24, 0.24], [H - 0.16, 0.21, 0.21]]);
    }
  }
  m.col(0x7d6a52);
  m.prism(0, 0, [[H - 0.18, W, D], [H - 0.08, W - 0.04, D - 0.04]]);      // bearer frame
  const n = 13;
  for (let k = 0; k < n; k++) {
    const z = -D / 2 + (D * (k + 0.5)) / n;
    m.col(k % 2 ? P.WOOD_DECK : 0xb98d5e);
    m.prism(0, z, [[H - 0.08, W, D / n - 0.025], [H, W - 0.04, D / n - 0.055]]);
  }
  // Steps down the -z side.
  m.col(0x8f7a58);
  for (let k = 0; k < 3; k++) {
    const y = H - (k + 1) * (H / 3);
    m.prism(0, -D / 2 - 0.20 - k * 0.32, [[y, 2.20, 0.34], [y + H / 3, 2.20, 0.34]]);
  }
  // Rail on the pen side and the two returns.
  m.col(0x53605c);
  for (const x of [-W / 2 + 0.20, 0, W / 2 - 0.20]) {
    m.tube(x, D / 2 - 0.18, [[H, 0.050], [H + 1.02, 0.044]], 6, { capTop: true });
  }
  for (const sx of [-1, 1]) {
    m.tube(sx * (W / 2 - 0.18), 0, [[H, 0.050], [H + 1.02, 0.044]], 6, { capTop: true });
    m.tubeBetween(sx * (W / 2 - 0.18), H + 0.96, -D / 2 + 0.20, sx * (W / 2 - 0.18), H + 0.96, D / 2 - 0.18, 0.034, 5);
  }
  m.col(P.WOOD_DECK);
  m.prism(0, D / 2 - 0.18, [[H + 0.96, W - 0.20, 0.12], [H + 1.04, W - 0.24, 0.11]]);
  m.col(0x53605c);
  m.tubeBetween(-W / 2 + 0.20, H + 0.56, D / 2 - 0.18, W / 2 - 0.20, H + 0.56, D / 2 - 0.18, 0.032, 5);
}

/**
 * INFORMATION BOARD. Raked panel on two canted legs, facing into the pen.
 *
 * The back is left plain steel on purpose — unlike a street sign, which props.js
 * insists must carry its legend twice, an interpretation board genuinely is
 * one-sided and the blank back is what makes it read as one.
 */
function gZooInfoBoard(m) {
  const W = 1.44;
  m.col(0x53605c);
  for (const s of [-1, 1]) {
    m.prism(s * (W / 2 - 0.10), 0, [[0, 0.24, 0.26], [0.06, 0.20, 0.22]]);
    m.beam(s * (W / 2 - 0.10), 0.05, 0.16, s * (W / 2 - 0.10), 0.94, -0.10, 0.09, 0.09, false);
  }
  // Panel raked back: bottom edge forward and low, top edge back and high.
  m.col(0x3f4a52);
  m.board(0, W, 0.62, 0.20, 1.24, -0.16, 0.055);
  m.col(P.STUCCO_CREAM);
  rake(m, 0, W - 0.10, 0.65, 0.185, 1.21, -0.145, -0.036);
  m.col(P.SIGN_GREEN);
  rake(m, 0, W - 0.10, 1.06, -0.075, 1.21, -0.145, -0.038);               // title bar
  m.col(P.SIGN_FACE);
  rake(m, -W / 2 + 0.38, 0.54, 1.09, -0.09, 1.18, -0.13, -0.040);
  // Species illustration block, then three lines of body copy.
  m.col(0xb98d5e);
  rake(m, -W / 2 + 0.32, 0.44, 0.72, 0.145, 1.00, -0.02, -0.040);
  m.col(0x6f7d78);
  for (let k = 0; k < 3; k++) {
    const t0 = 0.74 + k * 0.10, t1 = t0 + 0.045;
    rake(m, 0.30, 0.62, t0, 0.14 - k * 0.055, t1, 0.115 - k * 0.055, -0.040);
  }
  m.col(0x93a09a);
  m.tubeBetween(-W / 2 + 0.10, 0.58, 0.14, W / 2 - 0.10, 0.58, 0.14, 0.022, 4);
}

/** Fingerpost. Three arms at three heights, each pointing somewhere different. */
function gZooSignpost(m) {
  const H = 2.58;
  m.col(0xbfb4a0);
  m.tube(0, 0, [[0, 0.20], [0.10, 0.18], [0.16, 0.14]], 8, { capTop: true });
  m.col(P.WOOD_DARK);
  m.oct(0, 0, [[0.16, 0.17, 0.17, 0.035], [H, 0.15, 0.15, 0.03]], { capTop: true });
  m.col(0xe0d6c0);
  m.tube(0, 0, [[H, 0.15], [H + 0.10, 0.20], [H + 0.28, 0.05]], 7, { capTop: true });  // finial
  const arms = [[2.22, 0.0, 1.02, P.SIGN_GREEN], [1.88, 2.1, 0.90, P.CAR_TEAL], [1.54, 4.0, 0.84, P.ACCENT_SUN]];
  for (const [y, ang, len, hex] of arms) {
    m.xform(ang, 0, 0, 0);
    m.col(hex);
    // Pointed end: two prism sections, the last one narrow, is an arrow.
    m.prism(len / 2 + 0.10, 0, [[y, len, 0.055], [y + 0.26, len, 0.055]]);
    m.prism(len + 0.22, 0, [[y + 0.05, 0.24, 0.055], [y + 0.21, 0.24, 0.055]]);
    m.col(P.SIGN_FACE);
    for (const s of [1, -1]) decal(m, len / 2 + 0.02, y + 0.13, 0.030, len - 0.24, 0.09, s);
    m.reset();
  }
}

/* ==================================================== amenity =========== */

/**
 * Refreshment cart. Wheels, a striped canopy, a served counter, an urn and a
 * chalked menu — the same anatomy as props.js's `foodCart` but shorter, on a
 * drawbar, and liveried for a park rather than a kerb.
 */
function gZooFoodCart(m) {
  m.col(P.TYRE);
  for (const s of [-1, 1]) {
    m.xform(Math.PI / 2, s * 0.86, 0.28, 0.02); m.discZ(0, 0, 0.28, 0.11, 8, 0, 0.28); m.reset();
    m.col(P.CHROME);
    m.xform(Math.PI / 2, s * 0.86, 0.28, 0.02); m.discZ(0, 0, 0.09, 0.13, 5, 0, 0.09); m.reset();
    m.col(P.TYRE);
  }
  m.col(P.STEEL_DARK).tubeBetween(-0.92, 0.28, 0.02, 0.92, 0.28, 0.02, 0.038, 5);
  m.tubeBetween(-0.90, 0.62, -0.44, -0.90, 0.40, -0.86, 0.034, 5);                  // drawbar
  m.col(0xf2efe4);
  m.oct(0, 0, [[0.40, 2.06, 1.02, 0.08], [0.46, 2.12, 1.08, 0.08], [1.06, 2.16, 1.10, 0.08]], { capTop: false });
  m.col(P.SIGN_GREEN);
  m.prism(0, 0, [[0.62, 2.18, 1.12], [0.84, 2.18, 1.12]]);                          // livery band
  m.col(P.STUCCO_CREAM);
  for (let k = 0; k < 6; k++) decal(m, -0.90 + k * 0.36, 0.73, 0.562, 0.20, 0.14);
  m.col(P.CHROME);
  m.prism(0, 0, [[1.06, 2.18, 1.12], [1.12, 2.12, 1.06]]);                          // counter top
  m.prism(0, 0.62, [[1.12, 2.14, 0.14], [1.18, 2.10, 0.12]]);                       // serving lip
  m.col(P.STEEL_DARK);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    m.tubeBetween(sx * 0.94, 1.18, sz * 0.48, sx * 0.88, 2.32, sz * 0.44, 0.030, 4);
  }
  m.col(P.CAR_TEAL);
  // Canopy: a shallow four-sided pyramid with a valance, which is what props.js
  // learned a fabric canopy has to be before it stops reading as a lid.
  m.prism(0, 0, [[2.32, 2.44, 1.34], [2.40, 2.28, 1.22], [2.62, 0.90, 0.44]]);
  m.col(P.FABRIC_WHITE);
  m.prism(0, 0, [[2.20, 2.46, 1.36], [2.32, 2.46, 1.36]]);                          // valance
  m.col(P.CAR_TEAL);
  for (let k = 0; k < 7; k++) decal(m, -1.05 + k * 0.35, 2.26, 0.681, 0.16, 0.12);
  // Chalked menu, an urn, a cup stack, a condiment tray.
  m.col(P.SIGN_DARK).prism(-0.80, 0.48, [[1.28, 0.52, 0.04], [1.86, 0.52, 0.04]]);
  m.col(P.ACCENT_SUN); decal(m, -0.80, 1.78, 0.502, 0.44, 0.08);
  m.col(P.SIGN_FACE);
  for (let k = 0; k < 4; k++) decal(m, -0.80, 1.66 - k * 0.09, 0.502, 0.40, 0.035);
  m.col(P.CAR_SILVER).tube(0.62, 0.10, [[1.18, 0.17], [1.52, 0.165], [1.58, 0.11]], 7, { capTop: true });
  m.col(P.SIGN_FACE).tube(0.24, 0.24, [[1.18, 0.075], [1.48, 0.085]], 6, { capTop: true });
  m.col(P.HYDRANT_RED).tube(1.00, 0.20, [[1.18, 0.055], [1.32, 0.048]], 5, { capTop: true });
  m.col(P.FABRIC_SUN).tube(1.12, 0.20, [[1.18, 0.055], [1.32, 0.048]], 5, { capTop: true });
}

/**
 * Boulder for a pond rim or a pen interior.
 *
 * TWO offset masses, not one. A single octagonal blob is a die; the second lump
 * is the entire difference between "rock" and "rounded cube", and it costs 30
 * triangles. `sv` in the DEFS row spreads the size so a rim is not a bead
 * necklace of identical stones.
 */
function gZooRock(m) {
  m.col(0xa8a08e);
  m.oct(0, 0, [[0, 0.86, 0.70, 0.22], [0.26, 0.94, 0.78, 0.24], [0.58, 0.66, 0.54, 0.17], [0.76, 0.26, 0.20, 0.06]]);
  m.col(0x968e7e);
  m.oct(0.54, -0.32, [[0, 0.52, 0.46, 0.15], [0.20, 0.46, 0.40, 0.13], [0.33, 0.18, 0.15, 0.04]]);
  m.col(0xb6b09c);
  m.oct(-0.46, 0.34, [[0, 0.40, 0.36, 0.11], [0.15, 0.32, 0.28, 0.09], [0.24, 0.12, 0.11, 0.03]]);
  // Weathering: the top faces of a limestone boulder bleach, the crevices do
  // not. One recoloured cap is enough to break the flat fill.
  m.col(0xc6c0ac);
  m.disc(-0.05, 0.775, 0.02, 0.24, 7, 0.4);
}

/** Fallen log — a perch inside a pen, a seat outside one. */
function gZooLog(m) {
  m.col(0x8a6b4a);
  m.xform(0, 0, 0, 0);
  m.tubeBetween(-1.15, 0.24, 0.06, 1.20, 0.21, -0.10, 0.235, 7, true);
  m.col(0x6f543a);
  m.tubeBetween(0.30, 0.30, -0.03, 0.86, 0.62, 0.34, 0.085, 5, true);      // stub branch
  m.col(0xc4a882);
  m.xform(Math.PI / 2, -1.15, 0.24, 0.06); m.discZ(0, 0, 0.225, 0.03, 7, 0, 0.225); m.reset();
  m.col(0x7a5f42);
  m.tubeBetween(-0.60, 0.42, 0.02, 0.10, 0.44, -0.06, 0.055, 4);           // bark ridge
}

/* ==================================================== back of house ===== */

/**
 * SERVICE SHED. Ribbed cladding, a roller shutter, a personnel door, a gutter.
 *
 * The ribs are nine thin prisms rather than a profiled sheet: what reads at
 * this distance is the shadow line down the wall, and nine of them cost less
 * than one properly modelled corrugation.
 */
function gZooShed(m) {
  const W = 6.60, D = 4.40, H = 3.00;
  m.col(0x9aa09c);
  m.prism(0, 0, [[0, W + 0.56, D + 0.56], [0.12, W + 0.44, D + 0.44]]);    // concrete apron
  m.col(0x7f8f86);
  m.prism(0, 0, [[0.12, W, D], [H, W, D]], { capTop: false });
  m.col(0x93a49a);
  for (let k = 0; k < 9; k++) {
    const x = -W / 2 + 0.40 + (k * (W - 0.80)) / 8;
    m.prism(x, 0, [[0.14, 0.11, D + 0.06], [H - 0.06, 0.11, D + 0.06]], { capTop: false });
  }
  m.col(0x63706a);
  m.prism(0, 0, [[0.12, W + 0.06, D + 0.10], [0.34, W + 0.06, D + 0.10]]); // splash plinth

  // Roller shutter on the +z face, with the drum housing above it.
  m.col(0x546058);
  m.prism(-1.15, D / 2 + 0.03, [[0.14, 3.10, 0.10], [2.30, 3.10, 0.10]]);
  m.col(0xa9b0aa);
  for (let k = 0; k < 11; k++) {
    m.prism(-1.15, D / 2 + 0.075, [[0.20 + k * 0.19, 2.96, 0.03], [0.32 + k * 0.19, 2.96, 0.03]]);
  }
  m.col(0x63706a);
  m.prism(-1.15, D / 2 + 0.06, [[2.30, 3.24, 0.34], [2.62, 3.24, 0.34]]);  // drum housing
  // Personnel door and a wired light beside it.
  m.col(0x3f4a44);
  m.prism(2.10, D / 2 + 0.03, [[0.14, 1.02, 0.09], [2.22, 1.02, 0.09]]);
  m.col(P.CHROME);
  m.tube(2.48, D / 2 + 0.10, [[1.06, 0.032], [1.16, 0.030]], 5, { capTop: true });
  m.lit(P.LAMP_GLOW, 1, 0.95);
  m.tube(2.10, D / 2 + 0.20, [[2.36, 0.13], [2.46, 0.16], [2.50, 0.08]], 7, { capTop: true });

  // Monopitch roof as a real slab, plus a gutter and a vent.
  m.col(0x6e7a74);
  m.board(0, W + 0.84, H + 0.58, D / 2 + 0.44, H + 0.06, -D / 2 - 0.44, 0.15);
  m.col(0x8d949c);
  m.tubeBetween(-W / 2 - 0.42, H + 0.50, D / 2 + 0.44, W / 2 + 0.42, H + 0.50, D / 2 + 0.44, 0.075, 6);
  m.tubeBetween(W / 2 + 0.34, H + 0.46, D / 2 + 0.44, W / 2 + 0.34, 0.20, D / 2 + 0.30, 0.055, 5);
  m.col(0xa9b0aa);
  m.tube(-1.60, -0.60, [[H + 0.34, 0.26], [H + 0.62, 0.24], [H + 0.70, 0.30]], 8, { capTop: true });
  m.col(P.SIGN_GREEN);
  m.prism(1.90, D / 2 + 0.055, [[2.42, 1.50, 0.04], [2.84, 1.50, 0.04]]);
  m.col(P.SIGN_FACE);
  for (let k = 0; k < 4; k++) decal(m, 1.20 + k * 0.36, 2.63, 0.078 + D / 2, 0.24, 0.13);
}

/**
 * Open steel canopy over the buggy bay. Four legs on base plates, rafters, a
 * translucent sheet roof pitched to the back so it sheds toward the yard drain.
 */
function gZooBayCanopy(m) {
  const W = 6.00, D = 4.20, H = 3.10;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * (W / 2 - 0.32), z = sz * (D / 2 - 0.32);
      m.col(0x6f7878);
      m.prism(x, z, [[0, 0.46, 0.46], [0.07, 0.42, 0.42]]);
      m.col(0x8d949c);
      m.tube(x, z, [[0.07, 0.105], [H, 0.095]], 6, { capTop: true });
      // Knee brace: an unbraced portal frame reads as four sticks and a lid.
      m.col(0x8d949c);
      m.tubeBetween(x, H - 0.62, z, x - sx * 0.58, H - 0.06, z, 0.045, 4);
    }
  }
  m.col(0x8d949c);
  for (const sz of [-1, 1]) {
    const z = sz * (D / 2 - 0.32);
    m.beam(-W / 2 + 0.32, H + 0.02, z, W / 2 - 0.32, H + 0.02, z, 0.11, 0.16);
  }
  for (let k = 0; k < 5; k++) {
    const x = -W / 2 + 0.42 + (k * (W - 0.84)) / 4;
    m.beam(x, H + 0.42, D / 2 + 0.30, x, H + 0.10, -D / 2 - 0.30, 0.09, 0.11);
  }
  m.col(0xd8dcd6);
  m.board(0, W + 0.70, H + 0.50, D / 2 + 0.36, H + 0.18, -D / 2 - 0.36, 0.07);
  m.col(P.SIGN_GREEN);
  m.prism(0, D / 2 + 0.30, [[H + 0.42, W * 0.6, 0.05], [H + 0.68, W * 0.6, 0.05]]);
  m.col(P.SIGN_FACE);
  for (let k = 0; k < 5; k++) decal(m, -1.30 + k * 0.65, H + 0.55, D / 2 + 0.33, 0.36, 0.10);
}

/** Feed crates: two stacked, a hessian sack slumped against them, a scoop. */
function gZooFeedCrate(m) {
  const w = 1.02, d = 0.72;
  for (let s = 0; s < 2; s++) {
    const y = s * 0.44;
    m.col(s ? 0xd6c4a8 : 0xc6b294);
    for (const sz of [-1, 1]) m.prism(0, sz * d / 2, [[y, w, 0.045], [y + 0.42, w, 0.045]]);
    for (const sx of [-1, 1]) m.prism(sx * w / 2, 0, [[y, 0.045, d], [y + 0.42, 0.045, d]]);
    m.col(0xa8906e);
    for (const yy of [y + 0.09, y + 0.31]) {
      m.prism(0, d / 2 + 0.012, [[yy, w + 0.03, 0.022], [yy + 0.06, w + 0.03, 0.022]]);
    }
    m.col(s ? 0x9a8464 : 0x8a7458);
    m.plate(0, y + 0.42, 0, w - 0.06, d - 0.06);                          // grain surface
    m.col(P.SIGN_DARK);
    decal(m, 0.02, y + 0.24, d / 2 + 0.03, 0.34, 0.13);
  }
  // The sack. Three tapered tube sections lean it against the stack.
  m.col(0xc9b58c);
  m.tube(-0.78, 0.24, [[0, 0.30], [0.26, 0.33], [0.52, 0.24], [0.60, 0.09]], 7, { capTop: true });
  m.col(0xb09c74);
  ring(m, -0.78, 0.30, 0.24, 0.32, 0.028, 8);
  m.col(P.ALUMINIUM);
  m.tube(0.62, -0.52, [[0, 0.13], [0.16, 0.15]], 7, { capTop: true });    // scoop
  m.tubeBetween(0.62, 0.14, -0.52, 0.90, 0.34, -0.66, 0.024, 4);
}

/** Hose reel on a stand, hose coiled, nozzle hanging, tap at the foot. */
function gZooHoseReel(m) {
  m.col(0x53605c);
  m.prism(0, 0, [[0, 0.72, 0.44], [0.07, 0.66, 0.40]]);                   // base plate
  for (const s of [-1, 1]) m.prism(s * 0.29, 0, [[0.07, 0.09, 0.09], [0.94, 0.08, 0.08]]);
  m.col(0x8d949c);
  m.tubeBetween(-0.30, 0.72, 0, 0.30, 0.72, 0, 0.035, 6, true);           // axle
  for (const s of [-1, 1]) {
    m.xform(Math.PI / 2, s * 0.22, 0.72, 0); m.discZ(0, 0, 0.34, 0.035, 10, 0, 0.34); m.reset();
  }
  // The coil. Four rings at two radii is a coil; one torus is a doughnut.
  m.col(P.SIGN_GREEN);
  for (let k = 0; k < 4; k++) {
    const x = -0.15 + k * 0.10;
    m.xform(Math.PI / 2, x, 0.72, 0); m.discZ(0, 0, 0.26 - (k % 2) * 0.03, 0.085, 9, 0, 0.26 - (k % 2) * 0.03); m.reset();
  }
  m.col(0x2f6a4c);
  m.tubeBetween(0.20, 0.50, 0.02, 0.34, 0.14, 0.22, 0.030, 5);            // tail
  m.col(P.CHROME);
  m.tubeBetween(0.34, 0.14, 0.22, 0.46, 0.09, 0.30, 0.026, 5, true);      // nozzle
  m.col(0x8d949c);
  m.tube(-0.44, 0.14, [[0, 0.055], [0.42, 0.05]], 6, { capTop: true });   // standpipe
  m.col(P.HYDRANT_RED);
  m.xform(Math.PI / 2, -0.44, 0.44, 0.14); m.discZ(0, 0, 0.10, 0.035, 7, 0, 0.10); m.reset();
}

/**
 * Keeper's utility buggy. Flat bed, roll cage, bench seat, a feed bin on the
 * back. MEDIUM: it is a cart, and the tier ladder calls tier 2 "bikes & carts".
 */
function gZooBuggy(m) {
  m.col(P.TYRE);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    m.xform(Math.PI / 2, sx * 0.60, 0.29, sz * 0.86);
    m.discZ(0, 0, 0.29, 0.20, 8, 0, 0.29);
    m.reset();
    m.col(P.CHROME);
    m.xform(Math.PI / 2, sx * 0.60, 0.29, sz * 0.86);
    m.discZ(0, 0, 0.11, 0.22, 5, 0, 0.11);
    m.reset();
    m.col(P.TYRE);
  }
  m.col(0x2f6a4c);
  m.prism(0, 0, [[0.36, 1.18, 2.18], [0.44, 1.24, 2.26], [0.62, 1.24, 2.26], [0.68, 1.16, 2.18]]);
  m.col(0x27593f);
  m.prism(0, -0.72, [[0.68, 1.10, 0.80], [1.02, 1.06, 0.76]]);            // seat base
  m.col(0x3f4a44);
  m.board(0, 1.06, 1.02, -1.02, 1.52, -1.16, 0.09);                       // seat back
  m.col(0x93a09a);
  m.plate(0, 0.70, 0.42, 1.10, 1.20);                                     // flat bed
  for (let k = 0; k < 5; k++) {
    m.col(0x7f8f86);
    m.prism(0, -0.14 + k * 0.28, [[0.70, 1.10, 0.035], [0.73, 1.06, 0.03]]);
  }
  m.col(0x8d949c);
  for (const sx of [-1, 1]) {
    m.tubeBetween(sx * 0.52, 1.06, -0.96, sx * 0.52, 1.94, -0.84, 0.038, 5);
    m.tubeBetween(sx * 0.52, 1.94, -0.84, sx * 0.52, 1.86, 0.30, 0.038, 5);
    m.tubeBetween(sx * 0.52, 1.86, 0.30, sx * 0.52, 0.72, 0.42, 0.036, 5);
  }
  m.tubeBetween(-0.52, 1.94, -0.84, 0.52, 1.94, -0.84, 0.034, 5);
  m.tubeBetween(-0.52, 1.86, 0.30, 0.52, 1.86, 0.30, 0.034, 5);
  m.col(0xd8dcd6);
  m.board(0, 1.14, 1.96, -0.86, 1.88, 0.30, 0.06);                        // canopy
  m.col(0x3f4a44);
  m.tubeBetween(0, 1.02, -1.28, 0.26, 1.34, -1.06, 0.030, 5);             // steering column
  m.xform(0.5, 0.26, 1.34, -1.06); m.discZ(0, 0, 0.17, 0.03, 9, 0, 0.17); m.reset();
  m.col(0xb09c74);
  m.prism(0, 0.62, [[0.73, 0.86, 0.62], [1.16, 0.82, 0.58]]);             // feed bin on the bed
  m.col(0x8a7458);
  m.plate(0, 1.16, 0.62, 0.78, 0.54);
  m.col(P.HEADLIGHT);
  for (const sx of [-1, 1]) m.tube(sx * 0.40, -1.14, [[0.74, 0.09], [0.80, 0.085]], 6, { capTop: true });
}

/* ============================================ borrowed-model stand-ins == */
/* Used ONLY when props.js has not built the model this file would rather
   borrow (see borrowModel). A stand-in that exists beats a prop kind that
   silently places nothing. */

function gZooBenchAlt(m) {
  m.col(0x4a5250);
  for (const s of [-1, 1]) {
    m.prism(s * 0.72, 0, [[0, 0.10, 0.54], [0.05, 0.09, 0.50], [0.42, 0.08, 0.16]]);
    m.beam(s * 0.72, 0.42, -0.16, s * 0.72, 0.92, -0.26, 0.08, 0.08, false);
  }
  const tones = [P.BENCH_WOOD, 0xd0a06a];
  for (let k = 0; k < 4; k++) {
    m.col(tones[k % 2]);
    m.prism(0, -0.20 + k * 0.14, [[0.42, 1.68, 0.11], [0.47, 1.64, 0.10]]);
  }
  for (let k = 0; k < 3; k++) {
    m.col(tones[k % 2]);
    m.board(0, 1.68, 0.56 + k * 0.14, -0.20, 0.62 + k * 0.14, -0.23, 0.045);
  }
}

function gZooBinAlt(m) {
  m.col(0x8d949c);
  m.tube(0, 0, [[0, 0.30], [0.06, 0.28]], 8, { capTop: false });
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * TAU;
    m.tubeBetween(Math.cos(a) * 0.28, 0.05, Math.sin(a) * 0.28, Math.cos(a) * 0.31, 0.76, Math.sin(a) * 0.31, 0.016, 3);
  }
  for (const y of [0.16, 0.46, 0.72]) ring(m, 0, y, 0, 0.30 + y * 0.04, 0.018, 10);
  m.col(P.SIGN_GREEN);
  m.tube(0, 0, [[0.76, 0.34], [0.84, 0.32], [0.88, 0.20]], 8, { capTop: true });
  m.col(0x2b3038);
  m.disc(0, 0.881, 0, 0.13, 7);
}

function gZooLampAlt(m) {
  m.col(0xbfb4a0);
  m.tube(0, 0, [[0, 0.22], [0.14, 0.20], [0.22, 0.15]], 8, { capTop: true });
  m.col(P.BENCH_METAL);
  m.tube(0, 0, [[0.22, 0.075], [3.20, 0.055]], 6, { capTop: false });
  m.tube(0, 0, [[3.20, 0.15], [3.32, 0.13]], 6, { capTop: false });
  m.lit(P.LAMP_GLOW, 1, 1.15);
  m.tube(0, 0, [[3.32, 0.24], [3.62, 0.26], [3.82, 0.16]], 7, { capTop: false });
  m.col(P.BENCH_METAL);
  m.tube(0, 0, [[3.82, 0.20], [3.94, 0.10], [4.04, 0.04]], 7, { capTop: true });
}

function gZooPlanterAlt(m) {
  m.col(0xd8c8ae);
  m.tube(0, 0, [[0, 0.40], [0.10, 0.44], [0.52, 0.46], [0.58, 0.48]], 9, { capTop: false });
  m.col(0xbfae94);
  ring(m, 0, 0.575, 0, 0.475, 0.028, 9);
  m.col(P.MULCH);
  m.disc(0, 0.55, 0, 0.44, 9);
  lobes(m, 0, 0.55, 0, 0.40, P.HEDGE, P.HEDGE_LIGHT, 5, 3);
  m.col(P.FLOWER_YELLOW);
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * TAU + 0.6;
    m.tube(Math.cos(a) * 0.28, Math.sin(a) * 0.28, [[0.86, 0.06], [0.94, 0.03]], 5, { capTop: true });
  }
}

/* ========================================================== DEFS ======== */

/**
 * The zoo's own DEFS table, same shape as props.js's.
 *   g        builder
 *   tier     what size of hole may swallow it, and therefore its score
 *   r, h     FALLBACK size only — worldBuild measures the geometry
 *   label    the string the HUD shows when it goes down the hole
 *   shadow   cast into the shadow map (pools.js still culls anything < 1.8 m)
 *   sv       per-instance scale spread, so a run of nine is not nine copies
 *   tint     per-instance multiply. MUST be all-or-nothing per key: the pool's
 *            instanceColor buffer is allocated from the FIRST add, so a key
 *            whose first instance passes null silently drops every later hex.
 *   mat      which of props.js's four materials to render with
 *   borrow   props.js pool key whose geometry to reuse instead of building `g`
 */
const ZOO_DEFS = {
  /* entrance ------------------------------------------------------------- */
  zooArch: {
    g: gZooArch, tier: T.XLARGE, r: 6.20, h: 7.90, label: 'Zoo Entrance',
    shadow: true, crumbles: true, debris: P.STUCCO_PEACH,
  },
  zooGateWall: {
    g: gZooGateWall, tier: T.MEDIUM, r: 1.55, h: 2.30, label: 'Gateway Wall',
    shadow: true, crumbles: true, debris: P.STUCCO_PEACH,
  },
  zooTurnstile: {
    g: gZooTurnstile, tier: T.MEDIUM, r: 0.70, h: 1.12, label: 'Turnstile',
    debris: P.STEEL_DARK,
  },
  zooTicketBooth: {
    g: gZooTicketBooth, tier: T.LARGE, r: 2.25, h: 3.14, label: 'Ticket Booth',
    shadow: true, crumbles: true, debris: P.STUCCO_CREAM,
  },

  /* fencing -------------------------------------------------------------- */
  zooFenceMesh: {
    g: gZooFenceMesh, tier: T.SMALL, r: 1.44, h: 2.36, label: 'Habitat Fence',
    shadow: true, mat: 'metal', debris: 0x6f7d78,
  },
  zooFenceGlass: {
    g: gZooFenceGlass, tier: T.SMALL, r: 1.32, h: 1.98, label: 'Viewing Pane',
    shadow: true, mat: 'gloss', debris: P.GLASS_AQUA,
  },
  zooFenceTimber: {
    g: gZooFenceTimber, tier: T.SMALL, r: 1.41, h: 1.32, label: 'Paddock Fence',
    sv: 0.03, tint: [0xffffff, 0xe8dcc6, 0xd0c0a4, 0xf2e6d0], debris: P.WOOD_DARK,
  },
  zooWallStone: {
    g: gZooWallStone, tier: T.SMALL, r: 1.34, h: 0.88, label: 'Enclosure Wall',
    crumbles: true, sv: 0.03, tint: [0xffffff, 0xf0e6d2, 0xdcd2bc], debris: P.PRECAST,
  },
  zooGatePen: {
    g: gZooGatePen, tier: T.MEDIUM, r: 1.48, h: 2.32, label: 'Keeper Gate',
    shadow: true, mat: 'metal', debris: P.SIGN_GREEN,
  },

  /* viewing -------------------------------------------------------------- */
  zooRail: {
    g: gZooRail, tier: T.SMALL, r: 1.35, h: 1.05, label: 'Viewing Rail',
    mat: 'metal', debris: 0x53605c,
  },
  zooPlatform: {
    g: gZooPlatform, tier: T.LARGE, r: 2.60, h: 1.82, label: 'Viewing Deck',
    shadow: true, debris: P.WOOD_DECK,
  },
  zooInfoBoard: {
    g: gZooInfoBoard, tier: T.SMALL, r: 0.74, h: 1.26, label: 'Information Board',
    sv: 0.04, debris: P.SIGN_GREEN,
  },
  zooSignpost: {
    g: gZooSignpost, tier: T.SMALL, r: 0.40, h: 2.86, label: 'Zoo Signpost',
    shadow: true, sv: 0.04, debris: P.WOOD_DARK,
  },

  /* amenity -------------------------------------------------------------- */
  zooFoodCart: {
    g: gZooFoodCart, tier: T.MEDIUM, r: 1.30, h: 2.62, label: 'Refreshment Cart',
    shadow: true, debris: P.CAR_TEAL,
  },
  zooRock: {
    g: gZooRock, tier: T.SMALL, r: 0.86, h: 0.78, label: 'Boulder',
    sv: 0.26, crumbles: true, tint: [0xffffff, 0xe8e0cc, 0xd2ccbc, 0xf2ece0], debris: 0xa8a08e,
  },
  zooLog: {
    g: gZooLog, tier: T.TINY, r: 1.20, h: 0.68, label: 'Fallen Log',
    sv: 0.14, tint: [0xffffff, 0xe0cbae, 0xc2a888], debris: 0x8a6b4a,
  },

  /* back of house -------------------------------------------------------- */
  zooShed: {
    g: gZooShed, tier: T.XLARGE, r: 4.30, h: 3.73, label: 'Service Shed',
    shadow: true, crumbles: true, debris: 0x7f8f86,
  },
  zooBayCanopy: {
    g: gZooBayCanopy, tier: T.LARGE, r: 3.55, h: 3.60, label: 'Vehicle Bay',
    shadow: true, mat: 'metal', debris: 0x8d949c,
  },
  zooFeedCrate: {
    g: gZooFeedCrate, tier: T.SMALL, r: 0.75, h: 0.86, label: 'Feed Crates',
    sv: 0.07, tint: [0xffffff, 0xe8dcc8, 0xd6c4a8], debris: P.WOOD_LIGHT,
  },
  zooHoseReel: {
    g: gZooHoseReel, tier: T.SMALL, r: 0.42, h: 1.06, label: 'Hose Reel',
    mat: 'metal', debris: P.SIGN_GREEN,
  },
  zooBuggy: {
    g: gZooBuggy, tier: T.MEDIUM, r: 1.30, h: 2.00, label: 'Keeper Buggy',
    shadow: true, keepShadow: true, tint: [0xffffff, 0xd8f0d8, 0xf0ecd0], debris: 0x2f6a4c,
  },

  /* borrowed from props.js — see borrowModel for why these are separate pools */
  zooBench: {
    g: gZooBenchAlt, borrow: 'benchSlat', tier: T.SMALL, r: 1.00, h: 0.92,
    label: 'Bench', shadow: true, sv: 0.05,
    tint: [P.BENCH_WOOD, P.TEAK, P.WOOD_DARK, P.WOOD_DECK], debris: P.BENCH_WOOD,
  },
  zooBin: {
    g: gZooBinAlt, borrow: 'binMesh', tier: T.SMALL, r: 0.33, h: 0.90,
    label: 'Wire Bin', sv: 0.05, mat: 'metal',
    tint: [0xffffff, 0xdfe4e2, 0xc8d0cc], debris: P.BENCH_METAL,
  },
  zooLamp: {
    g: gZooLampAlt, borrow: 'lampPark', tier: T.MEDIUM, r: 0.26, h: 4.04,
    label: 'Park Lamp', shadow: true, sv: 0.04,
    tint: [0xffffff, 0xbcd4c0, 0xd8c8a8], debris: P.BENCH_METAL,
  },
  zooPlanter: {
    g: gZooPlanterAlt, borrow: 'planterRound', tier: T.SMALL, r: 0.62, h: 1.45,
    label: 'Planter', sv: 0.09,
    tint: [0xffffff, 0xf2e2c8, 0xdedad0, 0xfaf2e4], debris: P.PLANTER,
  },
};

/* ================================================ geometry + material === */

const _geoCache = new Map();
const _matCache = new Map();
const _contactCache = new Map();
const _borrowed = { hit: [], miss: [] };

/** Merged geometry for a zoo key, built once. */
function zooGeometry(key) {
  let g = _geoCache.get(key);
  if (!g) {
    const m = new M();
    ZOO_DEFS[key].g(m);
    g = m.geometry();
    _geoCache.set(key, g);
  }
  return g;
}

/**
 * Take a model props.js already built, WITHOUT taking its pool.
 *
 * props.js emits `capacity: counts.get(key)` — every pool is allocated to the
 * exact number of instances props.js itself placed. An extra `add()` therefore
 * returns slot -1, `addInstanced` returns null, and the prop kind vanishes with
 * no error anywhere. So this reads the BufferGeometry off the built pool and
 * lets us open a pool of our own around it: same triangles, same material, one
 * more draw call, and no capacity to overrun.
 *
 * Returns null if props.js placed none of that kind this seed (or if this
 * module was wired to run before props.js), in which case the local stand-in
 * geometry is used instead. Both outcomes are logged — a silent fallback is
 * how you end up shipping the wrong bench for a month.
 */
function borrowModel(ctx, srcKey) {
  const pools = ctx.props && ctx.props.pools;
  const p = pools && typeof pools.get === 'function' ? pools.get(srcKey) : null;
  if (!p || !p.geometry || !p.material) { _borrowed.miss.push(srcKey); return null; }
  _borrowed.hit.push(srcKey);
  return { geometry: p.geometry, material: p.material };
}

/**
 * props.js's four prop materials, fetched rather than rebuilt.
 *
 * They carry a vertex-shader injection (`glowify`) that drives per-vertex night
 * emission off `scene.userData.nightFactor`. That function is module-private,
 * so a material made here from scratch would leave every zoo lantern, scanner
 * pad and lit sign dead at midnight while the rest of the city glows. The pool
 * scan is the reliable route: it returns the actual instance in use. The
 * `solid()` fallback repeats props.js's exact parameters — materials.js keys
 * its cache on the parameter object INCLUDING `name`, so if props.js ever asked
 * for this material we still get that same injected instance back.
 */
const MAT_PARAMS = {
  prop: { name: 'prop-std', vertexColors: true, roughness: 0.63, metalness: 0.04, envMapIntensity: 0.7 },
  metal: { name: 'prop-metal', vertexColors: true, roughness: 0.34, metalness: 0.52, envMapIntensity: 1.0 },
  gloss: { name: 'prop-gloss', vertexColors: true, roughness: 0.16, metalness: 0.16, envMapIntensity: 1.7 },
  fabric: { name: 'prop-fabric', vertexColors: true, roughness: 0.88, metalness: 0.0, envMapIntensity: 0.5 },
};

function zooMaterial(ctx, kind) {
  const k = MAT_PARAMS[kind] ? kind : 'prop';
  let m = _matCache.get(k);
  if (m) return m;
  const want = MAT_PARAMS[k].name;
  const pools = ctx.props && ctx.props.pools;
  if (pools && typeof pools.values === 'function') {
    for (const p of pools.values()) {
      if (p.material && p.material.name === want) { m = p.material; break; }
    }
  }
  if (!m) m = solid({ ...MAT_PARAMS[k] });
  _matCache.set(k, m);
  return m;
}

function factoryFor(ctx, key) {
  const d = ZOO_DEFS[key];
  return () => {
    if (d.borrow) {
      const b = borrowModel(ctx, d.borrow);
      if (b) return b;
    }
    return { geometry: zooGeometry(key), material: zooMaterial(ctx, d.mat) };
  };
}

/**
 * What this prop puts on the ground, measured the way worldBuild measures it:
 * the horizontal extent of the lowest fifth of the object. The `r` in the DEFS
 * row is an authored guess and reserving it would reserve a number nothing else
 * in the game believes — props.js learned that when a parasol claimed 1.45 m
 * for a 12 cm pole.
 */
function zooContactRadius(key) {
  let v = _contactCache.get(key);
  if (v !== undefined) return v;
  const d = ZOO_DEFS[key];
  // A borrowed model's footprint is not measurable until the pool exists, and
  // this is called during placement. The DEFS row for a borrowed key carries
  // props.js's own authored radius, which for a bench and a bin is within a few
  // per cent of the truth.
  const geo = d.borrow ? null : zooGeometry(key);
  if (!geo) { v = d.r; _contactCache.set(key, v); return v; }
  if (!geo.boundingBox) geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const hi = bb.min.y + (bb.max.y - bb.min.y) * 0.20;
  const pos = geo.attributes.position;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > hi) continue;
    const x = pos.getX(i), z = pos.getZ(i);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (!(maxX > minX)) { minX = bb.min.x; maxX = bb.max.x; minZ = bb.min.z; maxZ = bb.max.z; }
  v = Math.hypot(maxX - minX, maxZ - minZ) / 2;
  _contactCache.set(key, v);
  return v;
}

/* ==================================================== layout reading ==== */

const numOf = (...vals) => {
  for (const v of vals) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
};

/** Names a habitat might carry that mean "this one has water in it". */
const WET = /water|pond|lagoon|aqua|marine|wetland|swamp|seal|otter|penguin|flamingo|pelican|hippo|croc|alligator|turtle|duck|heron|beaver/i;

/**
 * Normalise `layout.zoo` into the shape this module works in.
 *
 * The layout is another agent's output and its exact field spelling is not
 * something this file can verify by grep, so every field is read through a
 * short list of plausible names and anything missing is DERIVED rather than
 * assumed. A habitat that cannot yield a usable rectangle is dropped and
 * counted, never silently coerced into one at the origin.
 */
function readZoo(layout) {
  const z = layout && layout.zoo;
  if (!z || typeof z !== 'object') return null;
  const raw = Array.isArray(z.habitats) ? z.habitats
    : Array.isArray(z.pens) ? z.pens
      : Array.isArray(z.enclosures) ? z.enclosures : null;
  if (!raw || !raw.length) return null;

  const habitats = [];
  let dropped = 0;
  for (let i = 0; i < raw.length; i++) {
    const h = raw[i] || {};
    const x = numOf(h.x, h.cx, h.centerX, h.centreX);
    const zz = numOf(h.z, h.cz, h.centerZ, h.centreZ);
    let w = numOf(h.w, h.width);
    let d = numOf(h.d, h.depth);
    if (w === undefined && numOf(h.hw) !== undefined) w = h.hw * 2;
    if (d === undefined && numOf(h.hd) !== undefined) d = h.hd * 2;
    if (x === undefined || zz === undefined || !(w > 3) || !(d > 3)) { dropped++; continue; }
    const yaw = numOf(h.yaw, h.rot, h.rotation, h.angle) || 0;
    const kind = String(h.kind || h.type || h.species || h.theme || h.name || '');
    habitats.push({
      x, z: zz, w, d, yaw, kind, index: i,
      water: h.water === true || h.pond === true || h.wet === true || WET.test(kind),
    });
  }
  if (!habitats.length) return null;

  return {
    habitats,
    dropped,
    y: numOf(z.y, z.groundY),
    entrance: z.entrance || z.gate || z.entry || null,
    exit: z.exit || null,
    yard: z.yard || z.service || z.depot || null,
    bounds: numOf(z.w) !== undefined && numOf(z.x) !== undefined
      ? { x: z.x, z: z.z, w: z.w, d: z.d } : null,
  };
}

/** Rotation that turns a prop's authored +z face toward (dx, dz). */
const yawTo = (dx, dz) => Math.atan2(dx, dz);

/** World point from a habitat's local (lx, lz). */
function habPoint(h, lx, lz) {
  const c = Math.cos(h.yaw), s = Math.sin(h.yaw);
  return { x: h.x + lx * c + lz * s, z: h.z - lx * s + lz * c };
}

function insideHabitat(habs, x, z, pad = 0) {
  for (const h of habs) {
    const dx = x - h.x, dz = z - h.z;
    const c = Math.cos(h.yaw), s = Math.sin(h.yaw);
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    if (Math.abs(lx) <= h.w / 2 + pad && Math.abs(lz) <= h.d / 2 + pad) return h;
  }
  return null;
}

/* ==================================================== the placer ======== */

/**
 * Collects placements on a fine grid, then emits every pool at its EXACT final
 * size. Same two-pass shape as props.js's Placer, and for the same reason:
 * `addInstanced` takes `capacity` from the first add for a key, so the count
 * has to be known before a single instance is created.
 */
class ZooPlacer {
  constructor(ctx, rng, y) {
    this.ctx = ctx;
    this.rng = rng;
    this.y = y;
    this.items = [];
    this.cell = 1.4;
    this.grid = new Map();
    this.tried = 0;
    this.rejected = { water: 0, road: 0, occupied: 0 };
  }

  _key(i, j) { return (i + 8192) * 20000 + (j + 8192); }

  free(x, z, r) {
    const c = this.cell;
    for (let i = Math.floor((x - r) / c); i <= Math.floor((x + r) / c); i++) {
      for (let j = Math.floor((z - r) / c); j <= Math.floor((z + r) / c); j++) {
        const b = this.grid.get(this._key(i, j));
        if (!b) continue;
        for (let k = 0; k < b.length; k += 3) {
          const dx = b[k] - x, dz = b[k + 1] - z, rr = b[k + 2] + r;
          if (dx * dx + dz * dz < rr * rr) return false;
        }
      }
    }
    return true;
  }

  claim(x, z, r) {
    const c = this.cell;
    for (let i = Math.floor((x - r) / c); i <= Math.floor((x + r) / c); i++) {
      for (let j = Math.floor((z - r) / c); j <= Math.floor((z + r) / c); j++) {
        const k = this._key(i, j);
        let b = this.grid.get(k);
        if (!b) { b = []; this.grid.set(k, b); }
        b.push(x, z, r);
      }
    }
  }

  /**
   * @param {number} [claimR] ground to test and reserve. -1 = the measured
   *   contact footprint; 0 = share ground on purpose (a rock at a pond rim
   *   that overlaps the shore band).
   */
  put(key, x, z, rot = 0, y = null, scale = 1, claimR = -1) {
    const d = ZOO_DEFS[key];
    // Guard, not decoration. A mistyped key here would place nothing and say
    // nothing, which is exactly how this codebase has lost whole passes before.
    if (!d) { console.warn(`[zoo] unknown prop key "${key}" — nothing placed`); return false; }
    this.tried++;
    if (d.sv) scale *= 1 + (this.rng() - 0.5) * 2 * d.sv;
    const L = this.ctx.layout;
    if (L.isWater(x, z)) { this.rejected.water++; return false; }
    if (L.isRoad(x, z)) { this.rejected.road++; return false; }
    const foot = claimR < 0 ? Math.max(0.24, zooContactRadius(key) * scale) : claimR;
    if (foot > 0) {
      if (!this.free(x, z, foot + 0.06)) { this.rejected.occupied++; return false; }
      this.claim(x, z, foot + 0.06);
    }
    this.items.push({ key, x, z, rot, scale, y: y === null ? this.y : y, foot });
    return true;
  }

  /** Place at (x,z) or a short way along (ux,uz). A run is a rhythm, not a set
   *  of fixed points — props.js lost a fifth of the city's furniture before it
   *  learned to slide a refused prop instead of dropping it. */
  putAlong(key, x, z, ux, uz, rot = 0, y = null, scale = 1, claimR = -1) {
    for (const t of [0, 1.3, -1.3, 2.6, -2.6]) {
      if (this.put(key, x + ux * t, z + uz * t, rot, y, scale, claimR)) return true;
    }
    return false;
  }

  emit() {
    const counts = new Map();
    for (const it of this.items) counts.set(it.key, (counts.get(it.key) || 0) + 1);
    const ctx = this.ctx;
    const r = this.rng;
    let placed = 0;
    for (const it of this.items) {
      const d = ZOO_DEFS[it.key];
      // All-or-nothing per key: the pool allocates its instanceColor buffer
      // from the first add, so a key that starts with null can never be tinted.
      const hex = d.tint ? d.tint[Math.floor(r() * d.tint.length)] : null;
      const c = ctx.addInstanced(it.key, factoryFor(ctx, it.key), {
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
        keepShadow: !!d.keepShadow,
        crumbles: !!d.crumbles,
        debrisColor: d.debris,
      });
      if (c) placed++;
      // Only the big structures claim ground on the shared grid. See OCCUPY_MIN
      // for why a fence panel must not: `occupy` rounds to whole 3 m cells and
      // a ring of them would flag every pen interior as taken, which is how the
      // animal pass would end up placing nothing.
      if (it.foot >= OCCUPY_MIN) ctx.occupy(it.x, it.z, it.foot);
    }
    return { pools: counts.size, placed, counts };
  }
}

/* ==================================================== ground meshes ===== */

/**
 * Planar UVs from world XZ.
 *
 * The M builder writes position, normal, colour and glow but NO uv — a prop is
 * vertex-coloured and never needs one. That is why bayfront's grass and paving
 * were invisible the first time: `map:` had no coordinates to sample. Every
 * surface built here is horizontal, so projecting straight down is the correct
 * mapping rather than an approximation, and it tiles across the whole site.
 */
function planarUV(geo, tiles) {
  const pos = geo.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) / tiles;
    uv[i * 2 + 1] = pos.getZ(i) / tiles;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** Up-facing annulus, optionally squashed in z. Pond shores, path aprons. */
function annulus(m, cx, cz, r0, r1, y0, y1, segs, sq = 1) {
  for (let k = 0; k < segs; k++) {
    const a0 = (k / segs) * TAU, a1 = ((k + 1) / segs) * TAU;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    // Wound outer@a0 -> inner@a0 -> inner@a1 -> outer@a1, which is the order
    // that makes quad()'s cross product point UP. The other order renders the
    // shore from below and the pond looks like a hole in the ground.
    m.quad(
      [cx + c0 * r1, y1, cz + s0 * r1 * sq],
      [cx + c0 * r0, y0, cz + s0 * r0 * sq],
      [cx + c1 * r0, y0, cz + s1 * r0 * sq],
      [cx + c1 * r1, y1, cz + s1 * r1 * sq]
    );
  }
}

/**
 * The surfaced path network, as ONE merged decor mesh with real edging.
 *
 * Decor, not consumable: a path is a surface, and a surface the player can eat
 * off the ground is a hole in the world. It carries kerb edging as actual
 * geometry because from directly overhead the edge line is the only thing that
 * separates a path from a lighter patch of grass.
 */
function buildPathMesh(ctx, plan, yPath, group) {
  const deck = new M();
  const edge = new M();
  let metres = 0;

  const strip = (ax, az, bx, bz, w, tone) => {
    let dx = bx - ax, dz = bz - az;
    const L = Math.hypot(dx, dz);
    if (L < 0.4) return;
    metres += L;
    dx /= L; dz /= L;
    // Overrun each end by half a width so the joints at a node close instead of
    // leaving a wedge of turf in the middle of every junction.
    const ex = dx * w * 0.5, ez = dz * w * 0.5;
    const nx = -dz * w * 0.5, nz = dx * w * 0.5;
    const x0 = ax - ex, z0 = az - ez, x1 = bx + ex, z1 = bz + ez;
    deck.col(tone);
    deck.quad(
      [x0 + nx, yPath, z0 + nz], [x1 + nx, yPath, z1 + nz],
      [x1 - nx, yPath, z1 - nz], [x0 - nx, yPath, z0 - nz]
    );
    edge.col(0xd8ceb4);
    for (const s of [-1, 1]) {
      const ox = -dz * (w * 0.5 + 0.09) * s, oz = dx * (w * 0.5 + 0.09) * s;
      edge.beam(x0 + ox, yPath + 0.045, z0 + oz, x1 + ox, yPath + 0.045, z1 + oz, 0.18, 0.09);
    }
  };

  for (const s of plan.segments) strip(s.ax, s.az, s.bx, s.bz, s.w, s.tone);
  // A paved apron at each junction: without it the overrun quads cross at an
  // angle and leave a visible X of double-drawn paving.
  for (const n of plan.nodes) {
    deck.col(0xcdc0a2);
    deck.disc(n.x, yPath + 0.002, n.z, n.r, 10, n.r * 0.7);
  }

  const out = [];
  for (const [b, name, tiles] of [[deck, 'zoo-path', 5], [edge, 'zoo-path-edge', 3]]) {
    const geo = b.geometry();
    if (!geo.getAttribute('position') || geo.getAttribute('position').count === 0) continue;
    planarUV(geo, tiles);
    const mesh = new THREE.Mesh(geo, ground({
      name,
      map: Textures.paving(512, name === 'zoo-path' ? 0xd0c3a6 : 0xdfd5bc,
        'rgba(138,126,102,0.42)', name === 'zoo-path' ? 4 : 2),
      roughness: 0.96, vertexColors: true,
      // Same depth-layer scheme nature.js uses: turf sits at depth 3, a feature
      // apron above it at 4. Without the offset the path z-fights the lawn.
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
    }));
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    ctx.addMesh(mesh, { parent: group, decor: true });
    out.push(mesh);
  }
  return { meshes: out.length, metres };
}

/**
 * Shallow water for the wet habitats: a sloping shore band and a water plane.
 *
 * Built as two up-facing surfaces rather than as a basin. A basin is a tube,
 * `tube` winds its walls outward, and with FrontSide materials you would be
 * looking straight through the near wall of every pond at the inside of the far
 * one — the same defect that had every bin in props.js rendering hollow.
 */
function buildPondMesh(ctx, ponds, group) {
  const shore = new M();
  const wet = new M();
  for (const p of ponds) {
    const segs = 18;
    // Cobble margin, then a graded shelf, then the water itself 12 cm down.
    shore.col(0xbdb49c);
    annulus(shore, p.x, p.z, p.r + 0.55, p.r + 1.45, p.y + 0.05, p.y + 0.11, segs, p.sq);
    shore.col(0x9c9280);
    annulus(shore, p.x, p.z, p.r, p.r + 0.55, p.y - 0.06, p.y + 0.05, segs, p.sq);
    shore.col(0x8e846e);
    annulus(shore, p.x, p.z, p.r - 0.9, p.r, p.y - 0.14, p.y - 0.06, segs, p.sq);
    wet.col(P.WATER_POOL);
    wet.disc(p.x, p.y - 0.10, p.z, p.r - 0.25, segs, 0, true, (p.r - 0.25) * p.sq);
    // A paler shelf ring inside the water reads as depth without a shader.
    wet.col(P.SEA_SHALLOW, 1.14);
    annulus(wet, p.x, p.z, p.r - 0.9, p.r - 0.25, p.y - 0.098, p.y - 0.098, segs, p.sq);
  }

  const made = [];
  const sg = shore.geometry();
  if (sg.getAttribute('position').count) {
    planarUV(sg, 3);
    const mesh = new THREE.Mesh(sg, ground({
      name: 'zoo-pond-shore', map: Textures.sand(), roughness: 0.95, vertexColors: true,
      polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -10,
    }));
    mesh.name = 'zoo-pond-shore';
    mesh.castShadow = false; mesh.receiveShadow = true;
    ctx.addMesh(mesh, { parent: group, decor: true });
    made.push(mesh);
  }
  const wg = wet.geometry();
  if (wg.getAttribute('position').count) {
    const mesh = new THREE.Mesh(wg, ground({
      // A DISTINCT material, as the brief asks: glossy, metallic-ish and
      // strongly env-lit, which is what separates standing water from a
      // blue-green painted floor at this camera angle.
      name: 'zoo-pond-water', color: 0xffffff, vertexColors: true,
      roughness: 0.12, metalness: 0.28, envMapIntensity: 1.7,
      polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -12,
    }));
    mesh.name = 'zoo-pond-water';
    mesh.castShadow = false; mesh.receiveShadow = true;
    ctx.addMesh(mesh, { parent: group, decor: true });
    made.push(mesh);
  }
  return made.length;
}

/* ==================================================== the plan ========== */

/**
 * Decide where the entrance, the hub, the viewing points and the yard go, and
 * lay out the path graph that joins them.
 *
 * A hub with spokes AND a ring joining the viewing points in angular order is
 * the classic municipal-zoo plan, and it is also the only topology that
 * guarantees every pen is reachable from the gate without pathfinding.
 */
function planZoo(ctx, zoo, rng) {
  const habs = zoo.habitats;
  const L = ctx.layout;

  // Site bounds: the union of the habitat rectangles' rotated corners, or the
  // layout's own if it published one.
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const h of habs) {
    for (const [lx, lz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = habPoint(h, (lx * h.w) / 2, (lz * h.d) / 2);
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
    }
  }
  if (zoo.bounds) {
    x0 = Math.min(x0, zoo.bounds.x - zoo.bounds.w / 2);
    x1 = Math.max(x1, zoo.bounds.x + zoo.bounds.w / 2);
    z0 = Math.min(z0, zoo.bounds.z - zoo.bounds.d / 2);
    z1 = Math.max(z1, zoo.bounds.z + zoo.bounds.d / 2);
  }
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;

  /* Which edge does the street arrive on? March outward from each edge midpoint
     and take the shortest walk to a carriageway. A front gate that faces the
     back of the site is the one placement error nobody would forgive. */
  const EDGES = [
    { n: 'e', x: x1, z: cz, dx: 1, dz: 0 },
    { n: 'w', x: x0, z: cz, dx: -1, dz: 0 },
    { n: 's', x: cx, z: z1, dx: 0, dz: 1 },
    { n: 'n', x: cx, z: z0, dx: 0, dz: -1 },
  ];
  let best = null;
  for (const e of EDGES) {
    let dist = Infinity;
    for (let t = 3; t <= 48; t += 2) {
      if (L.isRoad(e.x + e.dx * t, e.z + e.dz * t)) { dist = t; break; }
    }
    if (!best || dist < best.dist) best = { ...e, dist };
  }

  const entrance = zoo.entrance && numOf(zoo.entrance.x) !== undefined
    ? {
      x: zoo.entrance.x, z: numOf(zoo.entrance.z, zoo.entrance.cz) ?? cz,
      yaw: numOf(zoo.entrance.yaw, zoo.entrance.rot) ?? yawTo(best.dx, best.dz),
    }
    : { x: best.x + best.dx * 6.5, z: best.z + best.dz * 6.5, yaw: yawTo(best.dx, best.dz) };

  // Hub: the centroid of the pens, pulled a little toward the gate, and pushed
  // clear of any pen it happens to land inside.
  let hub = {
    x: cx + (entrance.x - cx) * 0.22,
    z: cz + (entrance.z - cz) * 0.22,
  };
  let guard = 0;
  while (guard++ < 24) {
    const h = insideHabitat(habs, hub.x, hub.z, 3.2);
    if (!h) break;
    const dx = hub.x - h.x, dz = hub.z - h.z;
    const len = Math.hypot(dx, dz) || 1;
    hub = { x: hub.x + (dx / len) * 4.5, z: hub.z + (dz / len) * 4.5 };
  }

  /* Viewing point per pen: the midpoint of whichever side faces the hub, pushed
     3.4 m out so the crowd stands off the fence rather than inside the pen. */
  const views = [];
  for (const h of habs) {
    const sides = [
      { lx: 0, lz: h.d / 2, out: [0, 1], span: h.w },
      { lx: 0, lz: -h.d / 2, out: [0, -1], span: h.w },
      { lx: h.w / 2, lz: 0, out: [1, 0], span: h.d },
      { lx: -h.w / 2, lz: 0, out: [-1, 0], span: h.d },
    ];
    let pick = null, bestD = Infinity;
    for (const s of sides) {
      const p = habPoint(h, s.lx, s.lz);
      const d = Math.hypot(p.x - hub.x, p.z - hub.z);
      if (d < bestD) { bestD = d; pick = { ...s, p }; }
    }
    const o = habPoint(h, pick.lx + pick.out[0] * 3.4, pick.lz + pick.out[1] * 3.4);
    views.push({
      hab: h,
      side: pick,
      // The fence-line midpoint, and the standing point out in front of it.
      fx: pick.p.x, fz: pick.p.z,
      x: o.x, z: o.z,
      // Yaw that turns a prop's +z face AWAY from the pen (rails, boards and
      // benches all face the visitor's back, so they take this + PI where they
      // must look inward).
      yawOut: yawTo(o.x - pick.p.x, o.z - pick.p.z),
      span: pick.span,
    });
  }
  views.sort((a, b) => Math.atan2(a.z - hub.z, a.x - hub.x) - Math.atan2(b.z - hub.z, b.x - hub.x));

  // Yard: the corner furthest from the gate, outside every pen.
  let yard = zoo.yard && numOf(zoo.yard.x) !== undefined
    ? { x: zoo.yard.x, z: numOf(zoo.yard.z) ?? cz, w: numOf(zoo.yard.w) ?? 16, d: numOf(zoo.yard.d) ?? 12 }
    : null;
  if (!yard) {
    let far = null, farD = -1;
    for (const [px, pz] of [[x0 + 9, z0 + 8], [x1 - 9, z0 + 8], [x0 + 9, z1 - 8], [x1 - 9, z1 - 8]]) {
      const d = Math.hypot(px - entrance.x, pz - entrance.z);
      if (d > farD && !insideHabitat(habs, px, pz, 5)) { farD = d; far = { x: px, z: pz }; }
    }
    if (!far) far = { x: x0 - 10, z: z0 - 8 };
    yard = { x: far.x, z: far.z, w: 16, d: 12 };
  }
  yard.yaw = yawTo(hub.x - yard.x, hub.z - yard.z);

  // Exit: a second, plainer gate on the edge next to the entrance, so the loop
  // has somewhere to end that is not where it started.
  const exitEdge = EDGES.find((e) => e.n !== best.n && (e.dx === 0) !== (best.dx === 0)) || best;
  const exit = zoo.exit && numOf(zoo.exit.x) !== undefined
    ? { x: zoo.exit.x, z: numOf(zoo.exit.z) ?? cz, yaw: numOf(zoo.exit.yaw) ?? yawTo(exitEdge.dx, exitEdge.dz) }
    : { x: exitEdge.x + exitEdge.dx * 5.0, z: exitEdge.z + exitEdge.dz * 5.0, yaw: yawTo(exitEdge.dx, exitEdge.dz) };

  /* --- the path graph -------------------------------------------------- */
  const nodes = [
    { x: entrance.x, z: entrance.z, r: 4.4, kind: 'entrance' },
    { x: hub.x, z: hub.z, r: 5.2, kind: 'hub' },
    { x: exit.x, z: exit.z, r: 3.4, kind: 'exit' },
    { x: yard.x, z: yard.z, r: 3.0, kind: 'yard' },
  ];
  const segments = [];
  const link = (a, b, w, tone) => segments.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, w, tone });

  /* A spoke that runs straight through a neighbouring pen is a path through a
     lion. Two elbow candidates, offset either side of the straight line; take
     whichever samples clear. Cheap, and it fixes the only routing failure this
     topology can produce. */
  const clearRun = (a, b) => {
    for (let t = 0.1; t <= 0.9; t += 0.1) {
      if (insideHabitat(habs, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, 1.2)) return false;
    }
    return true;
  };
  const route = (a, b, w, tone) => {
    if (clearRun(a, b)) { link(a, b, w, tone); return; }
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    let dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    for (const s of [1, -1]) {
      const e = { x: mx - dz * len * 0.42 * s, z: mz + dx * len * 0.42 * s, r: 2.6, kind: 'bend' };
      if (clearRun(a, e) && clearRun(e, b)) {
        nodes.push(e); link(a, e, w, tone); link(e, b, w, tone); return;
      }
    }
    link(a, b, w, tone);   // nowhere clean to go: the direct run still connects
  };

  route(nodes[0], nodes[1], PATH_W * 1.35, 0xd4c7a8);          // gate approach, wide
  for (const v of views) {
    nodes.push({ x: v.x, z: v.z, r: 3.0, kind: 'view', view: v });
    route(nodes[1], { x: v.x, z: v.z }, PATH_W, 0xcdc0a2);
  }
  // The ring: consecutive viewing points, which is what makes a visit a circuit
  // rather than eight there-and-back trips to the same junction.
  for (let i = 0; i < views.length && views.length > 2; i++) {
    const a = views[i], b = views[(i + 1) % views.length];
    route({ x: a.x, z: a.z }, { x: b.x, z: b.z }, PATH_W * 0.82, 0xc6b99c);
  }
  route(nodes[1], nodes[2], PATH_W, 0xcdc0a2);                  // hub -> exit
  route(nodes[1], nodes[3], PATH_W * 0.9, 0xb9ae95);            // hub -> yard (service)

  /* --- ponds ------------------------------------------------------------ */
  let wets = habs.filter((h) => h.water);
  if (!wets.length) {
    // Nothing in the layout said "water". Rather than ship a zoo with no pond,
    // the biggest pen becomes the wet one — and it is logged, because a derived
    // decision that nobody can see in the data is one nobody can debug.
    const biggest = habs.slice().sort((a, b) => b.w * b.d - a.w * a.d)[0];
    if (biggest) { biggest.water = true; wets = [biggest]; }
    zoo.derivedWater = true;
  }
  const ponds = wets.map((h) => {
    const small = Math.min(h.w, h.d);
    const r = Math.max(3.0, Math.min(small * 0.32, 9.5));
    const off = habPoint(h, (rng() - 0.5) * h.w * 0.16, (rng() - 0.5) * h.d * 0.16);
    return { x: off.x, z: off.z, r, sq: 0.72 + rng() * 0.28, hab: h };
  });

  return { bounds: { x0, x1, z0, z1, cx, cz }, entrance, exit, hub, yard, views, nodes, segments, ponds };
}

/* ==================================================== entry point ======= */

/**
 * @param {object} ctx worldBuild context
 * @returns {{structures:number, fences:number, paths:number, ponds:number, props:number}}
 */
export function buildZoo(ctx) {
  const empty = { structures: 0, fences: 0, paths: 0, ponds: 0, props: 0 };
  const zoo = readZoo(ctx.layout);
  if (!zoo) {
    // Once, cleanly. A world build must not die because one module has no site,
    // and it must not spam either — this runs on every restart.
    console.info('[zoo] layout.zoo absent or has no usable habitats — zoo skipped');
    return empty;
  }

  const rng = makeRNG(((ctx.layout.seed | 0) ^ 0x2005e) >>> 0);
  const group = ctx.group('zoo');

  /* GROUND HEIGHT. props.js measures the built surface with its own `Ground`
     sampler, which is module-private, so this uses the surface CONTRACT the
     park blocks are built to instead: nature.js lays turf at Y_WALK + 0.015 and
     a feature apron (court, sandpit, inlay) 55 mm above that. The zoo's paths
     are feature aprons and everything on them stands at that height. A layout
     that publishes its own `zoo.y` overrides both. */
  const yGround = zoo.y !== undefined ? zoo.y : ctx.Y_WALK + 0.015;
  const yPath = yGround + 0.055;

  const plan = planZoo(ctx, zoo, rng);
  const habs = zoo.habitats;
  const pl = new ZooPlacer(ctx, rng, yGround);

  const tally = { structures: 0, fences: 0, viewing: 0, amenity: 0, yard: 0, rocks: 0 };

  /* ---------------------------------------------------------- 1. paths --- */
  const paths = buildPathMesh(ctx, plan, yPath, group);
  const pondCount = buildPondMesh(ctx, plan.ponds.map((p) => ({ ...p, y: yGround })), group);

  /* ------------------------------------------------------- 2. entrance --- */
  {
    const e = plan.entrance;
    const c = Math.cos(e.yaw), s = Math.sin(e.yaw);
    // Local frame: +z is out toward the street, +x runs along the frontage.
    const EX = (lx, lz) => e.x + lx * c + lz * s;
    const EZ = (lx, lz) => e.z - lx * s + lz * c;

    if (pl.put('zooArch', e.x, e.z, e.yaw, yPath, 1, 5.4)) tally.structures++;
    // Flanking walls running out from both piers to the site corners.
    for (const side of [-1, 1]) {
      for (let k = 0; k < 5; k++) {
        const lx = side * (7.0 + k * 2.98);
        if (pl.put('zooGateWall', EX(lx, 0), EZ(lx, 0), e.yaw + (side < 0 ? Math.PI : 0), yGround, 1, 1.5)) {
          tally.structures++;
        }
      }
    }
    // Turnstiles in the throat of the arch, on the inside.
    for (let k = -1; k <= 1; k++) {
      if (pl.put('zooTurnstile', EX(k * 1.9, -2.4), EZ(k * 1.9, -2.4), e.yaw, yPath, 1, 0.75)) tally.structures++;
    }
    // Ticket booth to one side of the approach, facing the queue.
    const bs = rng.chance(0.5) ? 1 : -1;
    if (pl.put('zooTicketBooth', EX(bs * 5.9, 4.4), EZ(bs * 5.9, 4.4), e.yaw + bs * 0.42, yPath, 1, 2.3)) {
      tally.structures++;
    }
    if (pl.put('zooSignpost', EX(-bs * 4.6, 4.0), EZ(-bs * 4.6, 4.0), e.yaw + 0.5, yPath)) tally.amenity++;
    for (const side of [-1, 1]) {
      if (pl.put('zooPlanter', EX(side * 3.2, 3.0), EZ(side * 3.2, 3.0), rng() * TAU, yPath)) tally.amenity++;
      if (pl.put('zooBin', EX(side * 6.6, 1.6), EZ(side * 6.6, 1.6), rng() * TAU, yPath)) tally.amenity++;
    }
    if (pl.put('zooFoodCart', EX(bs * 8.2, -3.6), EZ(bs * 8.2, -3.6), e.yaw + Math.PI - bs * 0.3, yPath)) {
      tally.amenity++;
    }

    // Exit: no arch, just a gate wall pair, a turnstile line and a signpost.
    const xg = plan.exit;
    const xc = Math.cos(xg.yaw), xs = Math.sin(xg.yaw);
    for (const side of [-1, 1]) {
      for (let k = 0; k < 3; k++) {
        const lx = side * (2.6 + k * 2.98);
        if (pl.put('zooGateWall', xg.x + lx * xc, xg.z - lx * xs,
          xg.yaw + (side < 0 ? Math.PI : 0), yGround, 1, 1.5)) tally.structures++;
      }
      if (pl.put('zooTurnstile', xg.x + side * 0.95 * xc - 1.8 * xs,
        xg.z - side * 0.95 * xs - 1.8 * xc, xg.yaw, yPath, 1, 0.75)) tally.structures++;
    }
    if (pl.put('zooSignpost', xg.x + 3.6 * xc, xg.z - 3.6 * xs, xg.yaw - 0.4, yPath)) tally.amenity++;
  }

  /* --------------------------------------------------- 3. pen fencing --- */
  const STYLES = ['zooFenceMesh', 'zooFenceGlass', 'zooFenceTimber', 'zooWallStone'];
  for (const h of habs) {
    const hr = makeRNG(((ctx.layout.seed | 0) ^ (0x21a0 + h.index * 7919)) >>> 0);
    /* A pen's barrier says what lives in it: mesh for anything that climbs,
       glass where the animal is worth pressing your face against, timber for
       grazers, a low wall for a walk-through. The layout's own `kind` string
       gets the first say; failing that the pen's size decides, because a 40 m
       paddock behind glass is a greenhouse. */
    const k = h.kind.toLowerCase();
    let style;
    if (/glass|reptile|primate|ape|monkey|aquar|insect|nocturn/.test(k)) style = 'zooFenceGlass';
    else if (/graz|deer|goat|farm|paddock|pony|horse|sheep|llama/.test(k)) style = 'zooFenceTimber';
    else if (/bird|walk|garden|butterfly|lemur|petting/.test(k)) style = 'zooWallStone';
    else if (/big|cat|lion|tiger|bear|wolf|raptor|aviary/.test(k)) style = 'zooFenceMesh';
    else style = hr.weighted([['zooFenceMesh', 5], ['zooFenceGlass', 3], ['zooFenceTimber', 4], ['zooWallStone', 2]]);
    h.style = style;

    const view = plan.views.find((v) => v.hab === h);
    const sides = [
      { lz: h.d / 2, along: 'x', len: h.w, dyaw: 0 },
      { lz: -h.d / 2, along: 'x', len: h.w, dyaw: Math.PI },
      { lx: h.w / 2, along: 'z', len: h.d, dyaw: Math.PI / 2 },
      { lx: -h.w / 2, along: 'z', len: h.d, dyaw: -Math.PI / 2 },
    ];
    // The service side is the one nearest the yard: that is where the keeper
    // gate goes, so the buggy is not driving through the viewing point.
    let svc = 0, svcD = Infinity;
    sides.forEach((s, i) => {
      const p = habPoint(h, s.along === 'x' ? 0 : s.lx, s.along === 'x' ? s.lz : 0);
      const d = Math.hypot(p.x - plan.yard.x, p.z - plan.yard.z);
      if (d < svcD) { svcD = d; svc = i; }
    });

    sides.forEach((s, si) => {
      const n = Math.max(2, Math.round(s.len / FENCE_MOD));
      const step = s.len / n;
      // Uniform scale only: a non-uniform scale is supported by the pool but
      // worldBuild falls back to scale 1 when it measures one, so the physics
      // footprint would stop matching the mesh. +-9% is invisible and honest.
      const sc = Math.max(0.90, Math.min(1.10, step / FENCE_MOD));
      const isView = view && (
        (s.along === 'x' && Math.abs((s.lz > 0 ? h.d / 2 : -h.d / 2) - view.side.lz) < 0.01 && view.side.lx === 0) ||
        (s.along === 'z' && Math.abs((s.lx > 0 ? h.w / 2 : -h.w / 2) - view.side.lx) < 0.01 && view.side.lz === 0)
      );
      const gapHalf = isView ? Math.max(1, Math.round((view.span > 18 ? 3.4 : 2.2) / step / 2)) : 0;
      const mid = (n - 1) / 2;
      for (let i = 0; i < n; i++) {
        // The GAP is the whole point: a sealed box is a compound, and a pen you
        // cannot see into is a pen the player never notices exists.
        if (gapHalf && Math.abs(i - mid) <= gapHalf) continue;
        const t = -s.len / 2 + step * (i + 0.5);
        const gate = si === svc && Math.abs(i - mid) < 0.51;
        const key = gate ? 'zooGatePen' : style;
        const p = s.along === 'x' ? habPoint(h, t, s.lz) : habPoint(h, s.lx, t);
        if (pl.put(key, p.x, p.z, h.yaw + s.dyaw, yGround, gate ? 1 : sc, 1.12)) {
          if (gate) tally.structures++; else tally.fences++;
        }
      }
    });

    /* Corner posts. A run of panels that stops short of the corner leaves a
       daylight notch at every one of them, and four notches per pen is what
       makes a fence read as a row of hoardings. */
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = habPoint(h, (sx * h.w) / 2, (sz * h.d) / 2);
      if (pl.put(style, p.x, p.z, h.yaw + (sx * sz > 0 ? Math.PI / 4 : -Math.PI / 4), yGround, 0.62, 0.7)) {
        tally.fences++;
      }
    }
  }

  /* -------------------------------------------------- 4. viewing zones --- */
  for (const v of plan.views) {
    const inward = v.yawOut + Math.PI;      // faces the pen
    const c = Math.cos(v.yawOut), s = Math.sin(v.yawOut);
    // Local frame at the viewing point: +z points out of the pen, +x along it.
    const VX = (lx, lz) => v.x + lx * c + lz * s;
    const VZ = (lx, lz) => v.z - lx * s + lz * c;

    // Rails on the fence line, backs to the visitor: a rail's top cap should be
    // what a leaning elbow meets, so it faces OUT.
    let rails = 0;
    const nRail = v.span > 18 ? 3 : 2;
    for (let i = 0; i < nRail; i++) {
      const lx = (i - (nRail - 1) / 2) * 2.55;
      if (pl.putAlong('zooRail', VX(lx, -1.5), VZ(lx, -1.5), c, -s, v.yawOut, yPath)) rails++;
    }
    tally.viewing += rails;

    // Information boards, angled toward the pen so they are read facing in.
    const nBoard = v.span > 16 ? 2 : 1;
    for (let i = 0; i < nBoard; i++) {
      const lx = (i - (nBoard - 1) / 2) * 3.1 + (rng() - 0.5) * 0.6;
      if (pl.putAlong('zooInfoBoard', VX(lx, 0.9), VZ(lx, 0.9), c, -s, inward + (rng() - 0.5) * 0.3, yPath)) {
        tally.viewing++;
      }
    }
    // A raised deck for the bigger pens, set back so it looks over the rail.
    if (v.span > 15 && rng.chance(0.55)) {
      const side = rng.chance(0.5) ? 1 : -1;
      if (pl.put('zooPlatform', VX(side * 4.6, 3.4), VZ(side * 4.6, 3.4), inward, yPath, 1, 2.5)) {
        tally.structures++;
      }
    }
    // Bench facing the pen, bin at one end, a lamp behind. The trio is what
    // makes a viewing point a PLACE rather than three metres of railing.
    if (pl.putAlong('zooBench', VX(-2.4, 3.0), VZ(-2.4, 3.0), c, -s, inward, yPath)) tally.amenity++;
    if (pl.putAlong('zooBench', VX(2.4, 3.0), VZ(2.4, 3.0), c, -s, inward, yPath)) tally.amenity++;
    if (pl.putAlong('zooBin', VX(4.1, 2.7), VZ(4.1, 2.7), c, -s, rng() * TAU, yPath)) tally.amenity++;
    if (pl.putAlong('zooLamp', VX(-4.4, 3.2), VZ(-4.4, 3.2), c, -s, 0, yPath)) tally.amenity++;
    if (rng.chance(0.6) && pl.putAlong('zooPlanter', VX(5.6, 3.6), VZ(5.6, 3.6), c, -s, rng() * TAU, yPath)) {
      tally.amenity++;
    }
  }

  /* ------------------------------------------------ 5. path furniture --- */
  for (const seg of plan.segments) {
    let dx = seg.bx - seg.ax, dz = seg.bz - seg.az;
    const len = Math.hypot(dx, dz);
    if (len < 8) continue;
    dx /= len; dz /= len;
    const nx = -dz, nz = dx;
    // Lamps alternate sides every 15 m, which is a street-lighting rhythm and
    // the reason the loop reads as a promenade at night.
    const nLamp = Math.max(1, Math.floor(len / 15));
    for (let i = 0; i < nLamp; i++) {
      const t = (len * (i + 0.5)) / nLamp;
      const side = i % 2 ? 1 : -1;
      const off = seg.w * 0.5 + 0.95;
      if (pl.putAlong('zooLamp', seg.ax + dx * t + nx * off * side, seg.az + dz * t + nz * off * side,
        dx, dz, 0, yPath)) tally.amenity++;
    }
    const nSeat = Math.floor(len / 24);
    for (let i = 0; i < nSeat; i++) {
      const t = (len * (i + 0.7)) / Math.max(1, nSeat);
      const side = rng.chance(0.5) ? 1 : -1;
      const off = seg.w * 0.5 + 1.15;
      const x = seg.ax + dx * t + nx * off * side, z = seg.az + dz * t + nz * off * side;
      // A bench faces the path it stands beside, never the hedge behind it.
      if (pl.putAlong('zooBench', x, z, dx, dz, yawTo(-nx * side, -nz * side), yPath)) tally.amenity++;
      if (rng.chance(0.7) && pl.putAlong('zooBin', x + nx * side * 1.5 + dx * 1.4,
        z + nz * side * 1.5 + dz * 1.4, dx, dz, rng() * TAU, yPath)) tally.amenity++;
    }
    const nPlant = Math.floor(len / 19);
    for (let i = 0; i < nPlant; i++) {
      const t = (len * (i + 0.25)) / Math.max(1, nPlant);
      const side = i % 2 ? -1 : 1;
      const off = seg.w * 0.5 + 0.85;
      if (pl.putAlong('zooPlanter', seg.ax + dx * t + nx * off * side, seg.az + dz * t + nz * off * side,
        dx, dz, rng() * TAU, yPath)) tally.amenity++;
    }
  }
  // A signpost at every junction that has more than a couple of ways out, and a
  // cart at the two busiest.
  const junctions = plan.nodes.filter((n) => n.kind === 'hub' || n.kind === 'view');
  for (let i = 0; i < junctions.length; i++) {
    const n = junctions[i];
    const a = rng() * TAU;
    if (i % 2 === 0 && pl.put('zooSignpost', n.x + Math.cos(a) * (n.r + 0.7), n.z + Math.sin(a) * (n.r + 0.7),
      rng() * TAU, yPath)) tally.amenity++;
    if (n.kind === 'hub' || (i % 3 === 1 && rng.chance(0.5))) {
      const b = a + 2.1;
      if (pl.put('zooFoodCart', n.x + Math.cos(b) * (n.r + 2.0), n.z + Math.sin(b) * (n.r + 2.0),
        yawTo(-Math.cos(b), -Math.sin(b)), yPath)) tally.amenity++;
    }
  }

  /* -------------------------------------------------------- 6. ponds ---- */
  for (const p of plan.ponds) {
    const n = 8 + Math.floor(p.r * 1.4);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + rng() * 0.35;
      const rr = p.r + 1.0 + rng() * 0.9;
      const x = p.x + Math.cos(a) * rr, z = p.z + Math.sin(a) * rr * p.sq;
      // claimR 0.55, not the measured 0.9: rim stones are MEANT to touch, and
      // the honest footprint refuses every second one and leaves a dotted line.
      if (pl.put('zooRock', x, z, rng() * TAU, yGround + 0.02, 1, 0.55)) tally.rocks++;
    }
    // Basking logs and a couple of boulders out in the pen itself.
    for (let i = 0; i < 3; i++) {
      const a = rng() * TAU, rr = p.r + 2.6 + rng() * 3.0;
      const x = p.x + Math.cos(a) * rr, z = p.z + Math.sin(a) * rr * p.sq;
      if (!insideHabitat(habs, x, z, -1.5)) continue;
      if (pl.put(rng.chance(0.55) ? 'zooLog' : 'zooRock', x, z, rng() * TAU, yGround + 0.02)) tally.rocks++;
    }
  }
  // Every pen gets a little furniture, wet or dry — an empty rectangle behind a
  // fence is the thing that makes a zoo read as a car park with railings.
  for (const h of habs) {
    const n = Math.max(2, Math.round((h.w * h.d) / 190));
    for (let i = 0; i < n; i++) {
      const p = habPoint(h, (rng() - 0.5) * h.w * 0.66, (rng() - 0.5) * h.d * 0.66);
      if (pl.put(rng.weighted([['zooRock', 5], ['zooLog', 4]]), p.x, p.z, rng() * TAU, yGround + 0.02)) {
        tally.rocks++;
      }
    }
  }

  /* --------------------------------------------------- 7. service yard -- */
  {
    const y = plan.yard;
    const c = Math.cos(y.yaw), s = Math.sin(y.yaw);
    const YX = (lx, lz) => y.x + lx * c + lz * s;
    const YZ = (lx, lz) => y.z - lx * s + lz * c;

    if (pl.put('zooShed', YX(-3.4, -2.2), YZ(-3.4, -2.2), y.yaw, yGround, 1, 4.0)) tally.yard++;
    if (pl.put('zooBayCanopy', YX(4.4, -1.4), YZ(4.4, -1.4), y.yaw, yGround, 1, 3.2)) tally.yard++;
    if (pl.put('zooBuggy', YX(4.2, -1.2), YZ(4.2, -1.2), y.yaw + 0.12, yGround, 1, 1.4)) tally.yard++;
    if (rng.chance(0.7) && pl.put('zooBuggy', YX(6.6, 2.6), YZ(6.6, 2.6), y.yaw - 0.5, yGround, 1, 1.4)) {
      tally.yard++;
    }
    // Feed crates stacked against the shed wall, in a row like a delivery.
    for (let i = 0; i < 4; i++) {
      if (pl.putAlong('zooFeedCrate', YX(-6.0 + i * 1.35, 1.1), YZ(-6.0 + i * 1.35, 1.1),
        c, -s, y.yaw + (rng() - 0.5) * 0.24, yGround)) tally.yard++;
    }
    for (let i = 0; i < 2; i++) {
      if (pl.put('zooHoseReel', YX(-1.0 + i * 1.7, 2.4), YZ(-1.0 + i * 1.7, 2.4), y.yaw + Math.PI, yGround)) {
        tally.yard++;
      }
    }
    if (pl.put('zooBin', YX(1.9, 3.0), YZ(1.9, 3.0), rng() * TAU, yGround)) tally.yard++;
    if (pl.put('zooBin', YX(2.9, 3.1), YZ(2.9, 3.1), rng() * TAU, yGround)) tally.yard++;
    // Screen the yard off the public route with a stone wall and a gate.
    for (let i = 0; i < 6; i++) {
      const lx = -7.4 + i * 2.66;
      if (pl.put(i === 3 ? 'zooGatePen' : 'zooWallStone', YX(lx, 4.6), YZ(lx, 4.6), y.yaw, yGround, 1, 1.12)) {
        if (i === 3) tally.structures++; else tally.fences++;
      }
    }
    if (pl.put('zooSignpost', YX(7.6, 4.2), YZ(7.6, 4.2), y.yaw + 0.6, yGround)) tally.yard++;
  }

  /* ---------------------------------------------------------- 8. emit --- */
  const out = pl.emit();

  const summary = {
    structures: tally.structures,
    fences: tally.fences,
    paths: plan.segments.length,
    ponds: plan.ponds.length,
    props: tally.viewing + tally.amenity + tally.yard + tally.rocks,
  };

  /* Published for the animal pass, the crowd pass and anything else that needs
     to know where the zoo is. Deliberately mirrors `ctx.courts`, which is how
     props.js tells the crowd where to stage a basketball game. NOTE: the
     habitat interiors are NOT claimed on the occupancy grid — see OCCUPY_MIN —
     so an animal placer can use `ctx.isFree` inside a pen and get a real
     answer. If animals need a per-frame update, publish it the way vehicles.js
     publishes `scene.userData.trafficUpdate`; game.js already calls that shape. */
  ctx.zoo = {
    y: yGround, yPath,
    bounds: plan.bounds,
    entrance: plan.entrance,
    exit: plan.exit,
    hub: plan.hub,
    yard: plan.yard,
    habitats: habs.map((h) => ({
      x: h.x, z: h.z, w: h.w, d: h.d, yaw: h.yaw, kind: h.kind,
      water: !!h.water, style: h.style,
    })),
    ponds: plan.ponds.map((p) => ({ x: p.x, z: p.z, r: p.r, sq: p.sq, y: yGround - 0.10 })),
    views: plan.views.map((v) => ({ x: v.x, z: v.z, fx: v.fx, fz: v.fz, yawOut: v.yawOut })),
    paths: plan.segments.map((s) => ({ ax: s.ax, az: s.az, bx: s.bx, bz: s.bz, w: s.w })),
    summary,
  };
  ctx.scene.userData.zoo = ctx.zoo;
  ctx.stats.zoo = summary;

  const rj = pl.rejected;
  console.info(
    `[zoo] ${habs.length} habitats (${zoo.dropped} unreadable) | ` +
    `${out.pools} pools / ${out.placed} instances of ${pl.tried} attempts | ` +
    `${summary.structures} structures, ${summary.fences} fence sections, ` +
    `${tally.viewing} viewing pieces, ${tally.amenity} amenities, ` +
    `${tally.yard} yard items, ${tally.rocks} rocks & logs | ` +
    `${summary.paths} path segments (${paths.metres.toFixed(0)} m, ${paths.meshes} meshes), ` +
    `${summary.ponds} ponds${zoo.derivedWater ? ' (water pen derived — layout flagged none)' : ''} | ` +
    `refused: ${rj.occupied} occupied, ${rj.road} on the carriageway, ${rj.water} in water`
  );
  if (_borrowed.miss.length) {
    console.warn(
      `[zoo] props.js models not available, using local stand-ins: ` +
      `${[...new Set(_borrowed.miss)].join(', ')} ` +
      `(is buildZoo running BEFORE buildProps?)`
    );
  }

  return summary;
}
