/**
 * ZOO ANIMALS — six species, a habitat they cannot leave, and a hole to run
 * from.
 *
 * WHAT THIS MODULE OWNS
 * ---------------------
 *  · The geometry of six species, built with props.js's `M` mesher so the
 *    animals are vertex-coloured, UV-less, single-merged-geometry objects that
 *    instance exactly the way every other prop in the city does.
 *  · One `Consumable` per animal, registered through `ctx.addInstanced`, so a
 *    hole eats a zebra by the ordinary path and nothing here has to know the
 *    consumption rules.
 *  · A per-frame behaviour tick published as `scene.userData.animalUpdate`,
 *    with `scene.userData.animalReset` alongside it — exactly the shape
 *    vehicles.js uses for `trafficUpdate` (vehicles.js:5511) and the shape
 *    game.js already looks for when it rewinds a match (game.js:756-757).
 *
 * WHAT IT DELIBERATELY DOES NOT OWN
 * ---------------------------------
 * The SITE. Habitat rectangles come from `ctx.layout.zoo`, decided inside
 * buildLayout() before a single tree is planted. That ordering is not a style
 * preference, it is the lesson of the basketball court: the first court chose
 * its own site from inside props.js, which runs after nature.js, and the build
 * came out with four courts holding one hoop each because every missing piece
 * was refused for standing where a tree already was. A habitat is an order of
 * magnitude bigger than a court and would fail an order of magnitude worse.
 * If `layout.zoo` is absent this module builds NOTHING and says so loudly —
 * silently inventing a site would put a herd of zebras inside a hedge.
 *
 * THE SILHOUETTE IS THE WHOLE BRIEF
 * ---------------------------------
 * This game has exactly one camera: about 40 m up, looking down at 54 degrees.
 * Nobody will ever see an animal's face. So the budget goes into the outline —
 * a giraffe IS its neck, an elephant IS its ears and trunk, a zebra IS its
 * stripes, a flamingo IS its legs and the S of its neck — and nothing at all
 * goes into detail that is invisible from above. Two pose variants per species
 * (three for the birds), because "a herd is one mesh stamped out six times" is
 * a criticism this project has already earned once.
 *
 * COST
 * ----
 * The frame is render-bound (112 ms render against 2.1 ms simulation), so the
 * behaviour is deliberately the cheapest thing that still reads: no steering
 * behaviours, no avoidance, no pathfinding, no allocation on the hot path. One
 * target point, one heading, one clamp. LOD bands are copied from
 * pedestrians.js rather than invented.
 */

import * as THREE from 'three';
import { TIER } from '../config.js';
import { makeRNG } from '../core/rng.js';
import { solid } from '../core/materials.js';
import { STATE } from '../gameplay/entities.js';
import { M } from './props.js';

const TAU = Math.PI * 2;

/* ========================================================== colour ====== */
/* Animal coats are not in PALETTE — nothing else in the city is made of one —
   so they are literals, named here once and used by key everywhere below. */
const C = {
  penguinBack: 0x2b3038,
  penguinPale: 0xf3ece0,
  penguinBeak: 0xe8963c,
  penguinFoot: 0xd07f36,
  penguinCheek: 0xf0b64a,

  monkeyFur: 0x7d5c3d,
  monkeyFurDark: 0x59412c,
  monkeyFace: 0xd6b189,

  zebraLight: 0xefe9dd,
  zebraDark: 0x2b2823,
  hoof: 0x3a332b,

  giraffeTan: 0xe2b76c,
  giraffePatch: 0x9c6528,
  giraffePale: 0xecd6a6,

  eleGrey: 0x8e8c89,
  eleDark: 0x6d6b69,
  eleTusk: 0xe9e1cd,

  flamingo: 0xef8fae,
  flamingoDeep: 0xd9628a,
  flamingoLeg: 0xe6a0b4,
  craneGrey: 0xc7cbd0,
  craneWhite: 0xf1f0ec,
  craneCrown: 0xc8443a,
  billDark: 0x2c2c31,

  eye: 0x1a1a1f,
};

/* ========================================================= material ===== */

let _mat = null;
/**
 * One material for every animal: same program, so all thirteen pools batch as
 * well as WebGL allows.
 *
 * `M.geometry()` writes an `aGlow` attribute for props.js's night-emission
 * shader. This material never compiles that attribute in, so it is simply not
 * bound — which is correct: nothing in a zoo is a light source, and an
 * emissive giraffe at 3 a.m. would be a bug, not a feature.
 */
function animalMat() {
  if (_mat) return _mat;
  // `name` is part of the material cache key in core/materials.js, so this
  // instance is ours alone and nobody else's onBeforeCompile can reach it.
  _mat = solid({
    name: 'animal-hide',
    vertexColors: true,
    roughness: 0.84,
    metalness: 0.0,
    envMapIntensity: 0.40,
  });
  return _mat;
}

/* ========================================================= geometry ===== */
/* Every animal is authored FACING +z, base at y = 0, in metres — the same
   convention props.js uses, because these geometries go through the same
   `addInstanced` path and the same measured-footprint physics. */

/**
 * A leg in two segments with a joint, and a foot that touches the ground.
 *
 * Four straight rods is what made the first dog in this project read as a
 * table with a head (pedestrians.js:770). A knee costs six triangles.
 */
function leg(m, x, zTop, zFoot, yTop, yKnee, rTop, rMid, rFoot, coat, footHex) {
  m.col(coat);
  const zKnee = zTop + (zFoot - zTop) * 0.55;
  m.tubeBetween(x, yTop, zTop, x, yKnee, zKnee, rTop, 5, false);
  m.tubeBetween(x, yKnee, zKnee, x, 0.045, zFoot, rMid, 5, false);
  m.col(footHex);
  m.tube(x, zFoot, [[0, rFoot], [0.055, rFoot * 0.92]], 6, { capTop: true });
}

/** Rope tail with a tuft on the end. Two colours, five segments, 40 triangles. */
function tuftTail(m, pts, r, coat, tuft, tuftR) {
  m.col(coat);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    m.tubeBetween(a[0], a[1], a[2], b[0], b[1], b[2], r * (1 - i * 0.12), 4, false);
  }
  const e = pts[pts.length - 1];
  m.col(tuft);
  m.tube(e[0], e[2], [[e[1] - tuftR * 1.4, tuftR * 0.5], [e[1] - tuftR * 0.5, tuftR],
    [e[1] + tuftR * 0.3, tuftR * 0.4]], 5, { capTop: true });
}

/* ------------------------------------------------------------- penguin --- */
/**
 * King penguin, ~1.15 m. From above it is a dark teardrop with an orange beak
 * and two pale feet, which is the entire read — so the beak and the feet are
 * built at a size that survives being four pixels across.
 *
 * v0 stands square (a colony bird at rest); v1 leans into a waddle and is
 * built out of a tilted capsule rather than a stack of rings, so the two are
 * different objects and not the same object rotated.
 */
function penguinGeo(v) {
  const m = new M();
  if (v === 0) {
    m.col(C.penguinBack);
    m.tube(0, 0, [
      [0.05, 0.155, 0.125], [0.22, 0.205, 0.175], [0.60, 0.215, 0.190],
      [0.82, 0.170, 0.150], [0.90, 0.115, 0.105],
    ], 8, { capTop: false, capBot: true });
    // Head, set slightly forward of the spine the way a standing bird holds it.
    m.tube(0, 0.012, [[0.86, 0.105], [0.96, 0.128], [1.06, 0.115], [1.12, 0.055]],
      7, { capTop: true });
    // Pale front. A separate, smaller sweep pushed into +z: from the game
    // camera you see the dark back and a crescent of white, which is exactly
    // what a penguin looks like from a helicopter.
    m.col(C.penguinPale);
    m.tube(0, 0.062, [[0.16, 0.110, 0.070], [0.36, 0.150, 0.100],
      [0.62, 0.150, 0.098], [0.80, 0.105, 0.062]], 7, { capTop: true });
    m.tube(0, 0.055, [[0.90, 0.072, 0.048], [0.99, 0.082, 0.055],
      [1.06, 0.062, 0.040]], 6, { capTop: true });
    // Ear patches — the one flash of colour on the bird, and visible from above.
    m.col(C.penguinCheek);
    for (const s of [-1, 1]) {
      m.tube(s * 0.10, 0.02, [[0.94, 0.030], [1.01, 0.038], [1.05, 0.022]], 5, { capTop: true });
    }
    m.col(C.penguinBeak);
    m.tubeBetween(0, 1.005, 0.095, 0, 0.972, 0.245, 0.021, 5, true);
    // Flippers held slightly out, which widens the top-down outline.
    m.col(C.penguinBack);
    for (const s of [-1, 1]) {
      m.beam(s * 0.185, 0.70, 0.015, s * 0.245, 0.30, -0.045, 0.042, 0.145, true);
    }
    m.col(C.penguinFoot);
    for (const s of [-1, 1]) m.prism(s * 0.078, 0.095, [[0, 0.085, 0.185], [0.038, 0.072, 0.160]]);
    m.col(C.penguinBack);
    m.prism(0, -0.150, [[0.05, 0.130, 0.100], [0.12, 0.090, 0.045]]);
  } else {
    // Waddling: a leaning capsule. Built the other way round on purpose so the
    // pair never reads as one mesh at two rotations.
    const bx = 0, byB = 0.20, bzB = -0.10, byT = 0.78, bzT = 0.09;
    m.col(C.penguinBack);
    m.tubeBetween(bx, byB, bzB, bx, byT, bzT, 0.205, 8, true);
    m.tube(0, 0.155, [[0.76, 0.115], [0.86, 0.130], [0.96, 0.116], [1.02, 0.055]],
      7, { capTop: true });
    m.col(C.penguinPale);
    m.tubeBetween(bx, byB + 0.02, bzB + 0.085, bx, byT - 0.04, bzT + 0.075, 0.140, 7, true);
    m.tube(0, 0.196, [[0.80, 0.072], [0.90, 0.080], [0.97, 0.058]], 6, { capTop: true });
    m.col(C.penguinCheek);
    for (const s of [-1, 1]) {
      m.tube(s * 0.098, 0.165, [[0.84, 0.028], [0.91, 0.036], [0.95, 0.020]], 5, { capTop: true });
    }
    m.col(C.penguinBeak);
    m.tubeBetween(0, 0.905, 0.245, 0, 0.862, 0.385, 0.021, 5, true);
    // Flippers thrown back mid-stride.
    m.col(C.penguinBack);
    m.beam(0.175, 0.62, 0.02, 0.255, 0.34, -0.155, 0.040, 0.140, true);
    m.beam(-0.175, 0.62, 0.02, -0.230, 0.30, -0.020, 0.040, 0.140, true);
    m.col(C.penguinFoot);
    m.prism(0.080, 0.190, [[0, 0.082, 0.180], [0.036, 0.070, 0.155]]);
    m.prism(-0.082, 0.020, [[0, 0.082, 0.180], [0.036, 0.070, 0.155]]);
    m.col(C.penguinBack);
    m.prism(0, -0.235, [[0.14, 0.125, 0.100], [0.22, 0.085, 0.045]]);
  }
  return m.geometry();
}

/* -------------------------------------------------------------- monkey --- */
/**
 * ~0.62 m. The TAIL is the read: a small brown blob is not a monkey, a small
 * brown blob with a question-mark of tail arcing off it is. So the tail gets
 * five segments and everything else gets as few as it can survive on.
 */
function monkeyGeo(v) {
  const m = new M();
  if (v === 0) {
    // On all fours.
    const y = 0.31;
    m.col(C.monkeyFur);
    m.tubeBetween(0, y - 0.01, -0.17, 0, y + 0.02, 0.15, 0.098, 6, true);
    m.tube(0, 0.255, [[y + 0.03, 0.055], [y + 0.10, 0.088], [y + 0.19, 0.078],
      [y + 0.23, 0.034]], 7, { capTop: true });
    m.col(C.monkeyFace);
    m.faceZ(0, y + 0.125, 0.318, 0.056, 7, 0.3);
    m.col(C.monkeyFurDark);
    for (const s of [-1, 1]) m.discZ(s * 0.082, y + 0.135, 0.040, 0.016, 6, 0, 0.048);
    // Four legs, tucked under. Front pair shorter than the rear: that stance
    // difference is most of what says "primate" rather than "dog".
    m.col(C.monkeyFurDark);
    for (const s of [-1, 1]) {
      m.tubeBetween(s * 0.062, y - 0.02, 0.11, s * 0.080, 0.035, 0.145, 0.024, 4, true);
      m.tubeBetween(s * 0.066, y - 0.03, -0.13, s * 0.092, 0.035, -0.115, 0.026, 4, true);
    }
    m.col(C.monkeyFur);
    tuftTail(m, [
      [0, y - 0.01, -0.19], [0.01, y + 0.20, -0.34], [0.03, y + 0.33, -0.22],
      [0.04, y + 0.30, -0.06], [0.04, y + 0.18, 0.02],
    ], 0.026, C.monkeyFur, C.monkeyFurDark, 0.036);
  } else {
    // Sitting up, arms loose — the pose a monkey spends most of its day in,
    // and a completely different outline from above: a compact disc with a
    // spiral of tail beside it.
    m.col(C.monkeyFur);
    m.tube(0, -0.01, [[0.02, 0.135, 0.150], [0.14, 0.150, 0.165],
      [0.34, 0.120, 0.130], [0.44, 0.085, 0.092]], 7, { capTop: false, capBot: true });
    m.tube(0, 0.005, [[0.42, 0.062], [0.50, 0.092], [0.59, 0.082], [0.63, 0.036]],
      7, { capTop: true });
    m.col(C.monkeyFace);
    m.faceZ(0, 0.525, 0.088, 0.058, 7, 0.3);
    m.col(C.monkeyFurDark);
    for (const s of [-1, 1]) m.discZ(s * 0.086, 0.535, 0.042, 0.016, 6, 0, 0.050);
    // Arms hanging off the shoulders, knees up.
    m.col(C.monkeyFurDark);
    for (const s of [-1, 1]) {
      m.tubeBetween(s * 0.125, 0.365, 0.02, s * 0.150, 0.12, 0.075, 0.024, 4, true);
      m.tubeBetween(s * 0.085, 0.10, 0.06, s * 0.098, 0.045, 0.175, 0.030, 4, true);
    }
    tuftTail(m, [
      [0.03, 0.06, -0.14], [0.14, 0.05, -0.26], [0.28, 0.05, -0.20],
      [0.30, 0.05, -0.04], [0.20, 0.06, 0.04],
    ], 0.025, C.monkeyFur, C.monkeyFurDark, 0.034);
  }
  return m.geometry();
}

/* --------------------------------------------------------------- zebra --- */
/**
 * ~1.45 m at the shoulder, 2.2 m nose to tail.
 *
 * THE BARREL IS SLICED, not swept. A single tapered prism is a horse; seven
 * alternating slices are a zebra, and from directly overhead the stripes are
 * the only thing distinguishing it from every other quadruped in the city.
 * Seven three-ring prisms is 126 triangles — less than the cost of doing it
 * any other way, and it is the whole point of the animal.
 */
function zebraGeo(v) {
  const m = new M();
  const grazing = v === 1;
  const N = 7, LEN = 1.24;
  const dz = (LEN / N) * 1.06;                 // slight overlap: no daylight gaps
  for (let k = 0; k < N; k++) {
    const z = -LEN / 2 + (k + 0.5) * (LEN / N);
    const t = (k + 0.5) / N;
    const w = 0.40 + 0.13 * Math.sin(Math.PI * t);
    m.col(k % 2 === 0 ? C.zebraLight : C.zebraDark);
    m.prism(0, z, [
      [0.86, w * 0.70, dz], [1.06, w, dz], [1.30, w * 0.94, dz], [1.40, w * 0.52, dz],
    ]);
  }
  /* Neck and head. Grazing drops the head to the grass, which changes the
     top-down outline completely — the neck folds under the chest instead of
     standing proud of it. */
  const nb = [0, 1.32, 0.55];
  const nt = grazing ? [0, 0.72, 1.02] : [0, 1.86, 0.86];
  const nm = [nb[0], (nb[1] + nt[1]) / 2 + (grazing ? 0.10 : 0.04),
    (nb[2] + nt[2]) / 2 + (grazing ? 0.06 : 0.02)];
  m.col(C.zebraLight);
  m.tubeBetween(nb[0], nb[1], nb[2], nm[0], nm[1], nm[2], 0.155, 6, true);
  m.tubeBetween(nm[0], nm[1], nm[2], nt[0], nt[1], nt[2], 0.115, 6, true);
  // Mane: a dark blade standing up off the crest. Reads from above as the
  // stripe that runs from the withers to the ears.
  m.col(C.zebraDark);
  m.beam(0, nb[1] + 0.10, nb[2] - 0.06, nt[0], nt[1] + 0.09, nt[2] - 0.02, 0.035, 0.115, true);
  // Head: a wedge with a dark muzzle, pointing wherever the neck ended.
  const hz = grazing ? nt[2] + 0.16 : nt[2] + 0.18;
  const hy = grazing ? nt[1] - 0.16 : nt[1] + 0.02;
  m.col(C.zebraLight);
  m.beam(nt[0], nt[1], nt[2], 0, hy, hz, 0.155, 0.185, true);
  m.col(C.zebraDark);
  m.tube(0, hz + 0.02, [[hy - 0.075, 0.075], [hy + 0.045, 0.082]], 6, { capTop: true });
  for (const s of [-1, 1]) {
    m.tri([s * 0.055, nt[1] + 0.06, nt[2] - 0.02],
      [s * 0.115, nt[1] + 0.06, nt[2] + 0.02],
      [s * 0.085, nt[1] + 0.20, nt[2] - 0.01]);
  }
  /* Legs. Striped down to the knee, dark hoof — a plain white leg makes the
     whole animal read as a painted horse. */
  const zF = 0.46, zB = -0.50;
  for (const s of [-1, 1]) {
    leg(m, s * 0.20, zF, zF + (grazing ? 0.05 : 0.02), 1.08, 0.60, 0.075, 0.048, 0.055,
      C.zebraLight, C.hoof);
    leg(m, s * 0.21, zB, zB - 0.03, 1.10, 0.58, 0.085, 0.050, 0.058,
      C.zebraLight, C.hoof);
    // Two dark bands per leg. Cheap, and it stops the legs going pale-grey.
    m.col(C.zebraDark);
    m.tube(s * 0.20, zF + 0.01, [[0.78, 0.062], [0.87, 0.062]], 6);
    m.tube(s * 0.21, zB - 0.01, [[0.80, 0.070], [0.89, 0.070]], 6);
  }
  tuftTail(m, [[0, 1.30, -0.62], [0, 1.02, -0.74], [0, 0.78, -0.76]],
    0.030, C.zebraLight, C.zebraDark, 0.062);
  return m.geometry();
}

/* ------------------------------------------------------------- giraffe --- */
/**
 * ~4.7 m. THE SILHOUETTE IS THE NECK — that is the species' entire identity
 * from a camera looking down, so the neck gets four tapered segments and its
 * own patch pattern while the body gets the minimum that will carry it.
 *
 * v0 stands with the head up; v1 has the neck swung down and forward to browse,
 * which from above turns a tall thin post into a long diagonal. Nothing else
 * in this city has either outline.
 */
function giraffeGeo(v) {
  const m = new M();
  const browse = v === 1;
  const PATCH = [C.giraffeTan, C.giraffePatch, C.giraffeTan, C.giraffePatch,
    C.giraffePatch, C.giraffeTan];
  /* Body: five patch slices. Same trick as the zebra's stripes and for the same
     reason — a plain tan barrel is a camel. */
  const N = 5, LEN = 1.70;
  const dz = (LEN / N) * 1.06;
  for (let k = 0; k < N; k++) {
    const z = -LEN / 2 + (k + 0.5) * (LEN / N);
    const t = (k + 0.5) / N;
    const w = 0.62 + 0.16 * Math.sin(Math.PI * t);
    // The back SLOPES: withers high at the shoulder, croup low at the tail.
    const top = 2.62 + t * 0.30;
    m.col(PATCH[k % PATCH.length]);
    m.prism(0, z, [
      [top - 0.86, w * 0.68, dz], [top - 0.62, w, dz],
      [top - 0.14, w * 0.94, dz], [top, w * 0.50, dz],
    ]);
  }
  /* Neck: four segments so it can bend, patched segment by segment. */
  const base = [0, 2.86, 0.66];
  const tip = browse ? [0, 1.05, 2.05] : [0, 4.34, 1.16];
  const seg = 4;
  let px = base[0], py = base[1], pz = base[2];
  for (let k = 1; k <= seg; k++) {
    const t = k / seg;
    // Bowed, not straight: a straight neck is a chimney.
    const bow = Math.sin(t * Math.PI) * (browse ? 0.26 : 0.13);
    const nx = base[0] + (tip[0] - base[0]) * t;
    const ny = base[1] + (tip[1] - base[1]) * t + (browse ? bow : 0);
    const nz = base[2] + (tip[2] - base[2]) * t + (browse ? 0 : bow);
    m.col(PATCH[(k + 1) % PATCH.length]);
    m.tubeBetween(px, py, pz, nx, ny, nz, 0.235 - k * 0.030, 6, true);
    px = nx; py = ny; pz = nz;
  }
  // Mane down the back of the neck, and the head on the end of it.
  m.col(C.giraffePatch);
  m.beam(base[0], base[1] + 0.14, base[2] - 0.16, px, py + (browse ? -0.14 : 0.12),
    pz - (browse ? 0.16 : 0.14), 0.045, 0.150, true);
  const hdz = browse ? 0.20 : 0.24, hdy = browse ? -0.20 : 0.02;
  m.col(C.giraffePale);
  m.beam(px, py, pz, px, py + hdy, pz + hdz, 0.150, 0.180, true);
  m.col(C.giraffePatch);
  m.tube(px, pz + hdz + 0.03, [[py + hdy - 0.075, 0.072], [py + hdy + 0.040, 0.078]],
    6, { capTop: true });
  // Ossicones. Four rings each, and the one detail worth spending on: they are
  // the difference between a long neck and a GIRAFFE's long neck.
  m.col(C.giraffeTan);
  for (const s of [-1, 1]) {
    const ox = px + s * 0.062, oy = py + (browse ? 0.06 : 0.16), oz = pz + (browse ? -0.02 : 0.02);
    m.tubeBetween(ox, oy, oz, ox + s * 0.02, oy + (browse ? 0.10 : 0.17), oz + 0.02, 0.022, 4, false);
    m.col(C.giraffePatch);
    m.tube(ox + s * 0.02, oz + 0.02, [[oy + (browse ? 0.09 : 0.16), 0.038],
      [oy + (browse ? 0.14 : 0.21), 0.030]], 5, { capTop: true });
    m.col(C.giraffeTan);
  }
  /* Legs: long, pale, and the front pair longer than the rear. */
  const zF = 0.62, zB = -0.66;
  for (const s of [-1, 1]) {
    leg(m, s * 0.30, zF, zF + 0.04, 2.10, 1.10, 0.115, 0.070, 0.085, C.giraffePale, C.hoof);
    leg(m, s * 0.31, zB, zB - 0.05, 1.96, 1.00, 0.120, 0.072, 0.088, C.giraffePale, C.hoof);
    m.col(C.giraffePatch);
    m.tube(s * 0.30, zF + 0.02, [[1.62, 0.098], [1.80, 0.100]], 6);
    m.tube(s * 0.31, zB - 0.02, [[1.52, 0.102], [1.70, 0.104]], 6);
  }
  tuftTail(m, [[0, 2.84, -0.86], [0, 2.30, -1.00], [0, 1.86, -1.02]],
    0.036, C.giraffeTan, C.giraffePatch, 0.070);
  return m.geometry();
}

/* ------------------------------------------------------------ elephant --- */
/**
 * ~3.3 m, 4.4 m long. From straight above an elephant is EARS AND TRUNK: two
 * broad flat panels either side of a small head, with a rope running forward
 * off the front of it. The body underneath is almost incidental to the read, so
 * it is four rings of octagon and no more.
 */
function elephantGeo(v) {
  const m = new M();
  const raised = v === 1;
  m.col(C.eleGrey);
  m.oct(0, 0, [
    [1.24, 1.28, 2.90, 0.34], [1.62, 1.52, 3.26, 0.42],
    [2.74, 1.48, 3.10, 0.42], [3.04, 0.98, 2.34, 0.28],
  ], { capTop: true });
  // Head, set forward and a little lower than the shoulder.
  m.oct(0, 1.86, [
    [1.86, 0.88, 0.82, 0.22], [2.10, 1.10, 1.02, 0.26],
    [2.86, 1.02, 0.92, 0.24], [3.06, 0.62, 0.56, 0.16],
  ], { capTop: true });
  // Domed forehead — the bulge that stops the head reading as a crate.
  m.tube(0, 1.98, [[2.92, 0.46, 0.42], [3.06, 0.50, 0.44], [3.20, 0.30, 0.26]],
    7, { capTop: true });
  /* EARS. A board spans (y0,z0)->(y1,z1) with its width along x, so a panel
     dropped from behind the skull down and back is a big flat wing standing
     out sideways — which is exactly the shape that says "elephant" from a
     camera 40 m up. Nothing else on the animal is worth as many triangles. */
  m.col(C.eleDark);
  for (const s of [-1, 1]) {
    m.board(s * 1.02, 1.02, 2.94, 1.62, 1.66, 1.30, 0.075);
    m.board(s * 1.36, 0.62, 2.62, 1.58, 1.86, 1.36, 0.060);
  }
  /* TRUNK. Five segments so it can curl. Down-and-forward at rest, curled up
     over the tusks when raised — two completely different outlines. */
  m.col(C.eleGrey);
  const trunk = raised
    ? [[0, 2.62, 2.28], [0, 2.30, 2.66], [0, 2.34, 3.02], [0, 2.72, 3.10], [0, 3.02, 2.86]]
    : [[0, 2.62, 2.28], [0, 2.00, 2.46], [0, 1.36, 2.54], [0, 0.76, 2.46], [0, 0.38, 2.58]];
  for (let i = 0; i < trunk.length - 1; i++) {
    const a = trunk[i], b = trunk[i + 1];
    m.tubeBetween(a[0], a[1], a[2], b[0], b[1], b[2], 0.215 - i * 0.030, 6, i === 0);
  }
  m.col(C.eleTusk);
  for (const s of [-1, 1]) {
    m.tubeBetween(s * 0.34, 2.44, 2.20, s * 0.42, 2.02, 2.62, 0.058, 5, true);
    m.tubeBetween(s * 0.42, 2.02, 2.62, s * 0.46, 1.86, 2.86, 0.036, 5, true);
  }
  /* Legs: columns, not rods. An elephant's leg is as thick as a bollard is
     tall, and thinning them is the single fastest way to make it read as a cow. */
  for (const s of [-1, 1]) {
    for (const z of [1.02, -1.04]) {
      m.col(C.eleGrey);
      m.tube(s * 0.62, z, [[0.20, 0.320], [0.90, 0.300], [1.50, 0.330]], 7);
      m.col(C.eleDark);
      m.tube(s * 0.62, z, [[0, 0.340], [0.20, 0.336]], 7, { capBot: true });
      // Toenails. Six triangles that put the foot ON the ground.
      m.col(C.eleTusk);
      m.disc(s * 0.62, 0.055, z + 0.24, 0.115, 6, 0, true, 0.075);
    }
  }
  tuftTail(m, [[0, 2.72, -1.52], [0, 2.10, -1.66], [0, 1.58, -1.66]],
    0.052, C.eleGrey, C.eleDark, 0.075);
  return m.geometry();
}

/* --------------------------------------------------------------- birds --- */
/**
 * Aviary birds, ~1.5 m. Three variants because a bird colony that is two poses
 * looks like wallpaper: v0 flamingo standing, v1 flamingo resting on one leg
 * with the head tucked, v2 a grey crane standing tall.
 *
 * The read from above is the LEGS and the NECK — a pink dot with two hairlines
 * under it and an S on top of it. So the neck gets four segments and the body
 * gets one sweep.
 */
function birdGeo(v) {
  const m = new M();
  const crane = v === 2;
  const body = crane ? C.craneWhite : C.flamingo;
  const deep = crane ? C.craneGrey : C.flamingoDeep;
  const legHex = crane ? C.billDark : C.flamingoLeg;
  const bodyY = crane ? 0.86 : 0.80;

  /* Legs. Thin, and long enough to be most of the animal's height. */
  m.col(legHex);
  if (v === 1) {
    // One leg down, the other folded up against the body — the pose everyone
    // recognises, and a completely different outline from two legs down.
    m.tubeBetween(0.01, 0, 0.02, -0.01, bodyY - 0.06, 0.01, 0.024, 5, true);
    m.tubeBetween(0.10, bodyY - 0.30, 0.00, 0.13, bodyY - 0.12, 0.06, 0.022, 4, true);
    m.col(deep);
    m.disc(0.01, 0.012, 0.06, 0.075, 6, 0, true, 0.10);
  } else {
    for (const s of [-1, 1]) {
      m.tubeBetween(s * 0.085, 0, 0.02, s * 0.062, bodyY - 0.06, 0.01, 0.023, 5, true);
      m.col(deep);
      m.disc(s * 0.085, 0.012, 0.06, 0.070, 6, 0, true, 0.095);
      m.col(legHex);
    }
    // Hocks — the backwards "knee" that makes a wading bird a wading bird.
    m.col(deep);
    for (const s of [-1, 1]) {
      m.tube(s * 0.075, 0.005, [[bodyY * 0.44, 0.035], [bodyY * 0.50, 0.033]], 5);
    }
  }

  /* Body: an ellipsoid longer in z than in x, tail feathers off the back. */
  m.col(body);
  m.tube(0, 0, [
    [bodyY - 0.10, 0.095, 0.150], [bodyY, 0.150, 0.255],
    [bodyY + 0.14, 0.135, 0.225], [bodyY + 0.22, 0.062, 0.105],
  ], 7, { capTop: true, capBot: true });
  // A folded wing each side, one shade deeper. Widens the top-down outline.
  m.col(deep);
  for (const s of [-1, 1]) {
    m.board(s * 0.145, 0.055, bodyY + 0.13, 0.10, bodyY - 0.02, -0.22, 0.085);
  }
  m.col(crane ? C.billDark : deep);
  m.prism(0, -0.30, [[bodyY - 0.02, 0.150, 0.190], [bodyY + 0.10, 0.090, 0.090]]);

  /* Neck + head. */
  let neck;
  if (v === 1) {
    // Head tucked back over the shoulder, beak buried in the wing.
    neck = [[0, bodyY + 0.16, 0.06], [0, bodyY + 0.40, -0.02],
      [-0.02, bodyY + 0.44, -0.18], [-0.03, bodyY + 0.26, -0.24]];
  } else if (crane) {
    // Straight up. A crane's neck is a mast, a flamingo's is a hook.
    neck = [[0, bodyY + 0.16, 0.05], [0, bodyY + 0.42, 0.09],
      [0, bodyY + 0.66, 0.11], [0, bodyY + 0.86, 0.12]];
  } else {
    neck = [[0, bodyY + 0.16, 0.06], [0, bodyY + 0.44, 0.16],
      [0, bodyY + 0.60, 0.30], [0, bodyY + 0.52, 0.42]];
  }
  m.col(body);
  for (let i = 0; i < neck.length - 1; i++) {
    const a = neck[i], b = neck[i + 1];
    m.tubeBetween(a[0], a[1], a[2], b[0], b[1], b[2], 0.052 - i * 0.006, 5, i === 0);
  }
  const h = neck[neck.length - 1];
  m.col(crane ? C.craneWhite : body);
  m.tube(h[0], h[2], [[h[1] - 0.045, 0.048], [h[1] + 0.020, 0.062],
    [h[1] + 0.070, 0.040]], 6, { capTop: true });
  if (crane) {
    m.col(C.craneCrown);
    m.tube(h[0], h[2], [[h[1] + 0.055, 0.042], [h[1] + 0.095, 0.026]], 6, { capTop: true });
  }
  m.col(C.billDark);
  if (crane) {
    m.tubeBetween(h[0], h[1] + 0.015, h[2] + 0.05, h[0], h[1] + 0.005, h[2] + 0.30, 0.020, 5, true);
  } else if (v === 1) {
    m.tubeBetween(h[0], h[1] - 0.01, h[2] - 0.04, h[0], h[1] - 0.10, h[2] + 0.06, 0.024, 5, true);
  } else {
    // The kinked flamingo bill: forward, then sharply down.
    m.col(C.flamingoDeep);
    m.tubeBetween(h[0], h[1] + 0.005, h[2] + 0.04, h[0], h[1] - 0.015, h[2] + 0.13, 0.028, 5, true);
    m.col(C.billDark);
    m.tubeBetween(h[0], h[1] - 0.015, h[2] + 0.13, h[0], h[1] - 0.095, h[2] + 0.17, 0.024, 5, true);
  }
  return m.geometry();
}

/* ========================================================== species ===== */

/**
 * One entry per species. `geo` is a function declaration above, so referencing
 * it here cannot hit a temporal dead zone the way a `const` arrow would — this
 * file has three shipped TDZ bugs behind it and the ordering is deliberate.
 *
 *   variants  distinct meshes, and therefore distinct instanced pools
 *   foot      half-width of the body on the ground; drives the pen inset and
 *             the spawn spacing, and is the only thing standing between a
 *             giraffe and a fence post through its ribs
 *   speed/run metres per second, wandering and fleeing
 *   fleeR     how far away a hole has to be before this animal stops caring
 *   herd      followers loosely track the first of their species
 *   perch     may climb something in its pen (monkeys, and only monkeys)
 *   per       square metres of pen per animal; min/max bracket the result
 */
const SPECIES = {
  elephant: {
    key: 'elephant', geo: elephantGeo, variants: 2, label: 'Elephant',
    /* foot 2.10, not the 1.75 the body measures. The RESTING TRUNK reaches
       y = 0.38, which is inside worldBuild's contact band (the lowest fifth of
       a 3.2 m animal), so the measured contact radius is 2.24 and not 1.66 —
       and at the top of the scale range, 2.42. The pen inset is derived from
       `foot`, so an under-declared foot puts the trunk through the fence.
       Verified against worldBuild.measureGeometry in __selftest. */
    tier: TIER.LARGE, score: 62, foot: 2.10, scale: [0.94, 1.08],
    speed: 0.62, run: 2.1, turn: 1.1, fleeR: 26, herd: true, perch: false,
    gaitK: 1.5, bob: 0.045, roll: 0.020, pitch: 0.010,
    pause: [2.4, 5.0], per: 150, min: 2, max: 5,
  },
  giraffe: {
    key: 'giraffe', geo: giraffeGeo, variants: 2, label: 'Giraffe',
    tier: TIER.LARGE, score: 50, foot: 1.05, scale: [0.92, 1.10],
    speed: 0.85, run: 2.7, turn: 1.4, fleeR: 24, herd: false, perch: false,
    gaitK: 1.9, bob: 0.060, roll: 0.026, pitch: 0.012,
    pause: [2.0, 4.5], per: 95, min: 2, max: 6,
  },
  zebra: {
    key: 'zebra', geo: zebraGeo, variants: 2, label: 'Zebra',
    tier: TIER.MEDIUM, score: 18, foot: 0.90, scale: [0.92, 1.08],
    speed: 1.15, run: 4.3, turn: 2.6, fleeR: 22, herd: true, perch: false,
    gaitK: 2.6, bob: 0.055, roll: 0.030, pitch: 0.018,
    pause: [1.0, 3.2], per: 46, min: 3, max: 9,
  },
  penguin: {
    key: 'penguin', geo: penguinGeo, variants: 2, label: 'Penguin',
    tier: TIER.SMALL, score: 6, foot: 0.30, scale: [0.90, 1.08],
    speed: 0.52, run: 1.6, turn: 3.4, fleeR: 12, herd: true, perch: false,
    // The waddle. Roll is six times anything else in the file, on purpose.
    gaitK: 5.4, bob: 0.030, roll: 0.150, pitch: 0.020,
    pause: [0.8, 3.0], per: 15, min: 6, max: 16,
  },
  monkey: {
    key: 'monkey', geo: monkeyGeo, variants: 2, label: 'Monkey',
    tier: TIER.SMALL, score: 8, foot: 0.28, scale: [0.90, 1.10],
    speed: 1.55, run: 3.6, turn: 5.5, fleeR: 16, herd: false, perch: true,
    gaitK: 6.0, bob: 0.075, roll: 0.040, pitch: 0.030,
    pause: [0.3, 1.6], per: 24, min: 4, max: 10,
  },
  bird: {
    key: 'bird', geo: birdGeo, variants: 3, label: 'Flamingo',
    // The crane variant gets its own kill-feed name; see labelFor().
    tier: TIER.SMALL, score: 7, foot: 0.34, scale: [0.92, 1.08],
    speed: 0.48, run: 2.3, turn: 3.0, fleeR: 14, herd: true, perch: false,
    gaitK: 4.2, bob: 0.038, roll: 0.055, pitch: 0.016,
    pause: [1.4, 4.4], per: 13, min: 6, max: 18,
  },
};

/** Biggest first: the largest pens go to the animals that need them. */
const BY_SIZE = ['elephant', 'giraffe', 'zebra', 'monkey', 'penguin', 'bird'];

/**
 * Species -> habitat.
 *
 * The keys in cityLayout.ZOO_SPECIES are a contract with the keys in SPECIES
 * below, and cityLayout says so in its own comment. This resolver exists
 * anyway, because the contract was BROKEN once already and nothing threw when
 * it was: the first ZOO_SPECIES was a Miami roster — flamingo, alligator,
 * panther, capybara, macaw — matched to these six by list index, which put
 * elephants in the Gator Swamp under a sign that said Gator Swamp. Silent, and
 * only visible in a screenshot. So the mapping is resolved on names, checked
 * three ways, and PRINTED at build time.
 *
 * Three passes, first one to answer wins:
 *   1. the pen's own `species`/`label` against the word list. The species' real
 *      key is always first in its list, so the healthy case is a direct hit.
 *      The stale Miami names are kept as aliases: if that table is ever
 *      reverted, the zoo degrades to a sensible animal in each habitat instead
 *      of an arbitrary one.
 *   2. `kind` — 'grass' | 'water' | 'rock' | 'aviary'. cityLayout:87 names kind
 *      as the contract the animal module switches on, so it is the durable
 *      hook and the name matching above is the courtesy.
 *   3. largest pen left to largest animal remaining.
 *
 * The order this list is walked in is the resolution order, and it is NOT
 * BY_SIZE: the most specific claim has to be settled first or a broad word
 * list eats a pen a narrower one owns.
 */
const MATCH_ORDER = ['giraffe', 'bird', 'monkey', 'zebra', 'elephant', 'penguin'];

const PEN_WORDS = {
  giraffe: ['giraffe', 'paddock'],
  bird: ['bird', 'flamingo', 'crane', 'wader', 'lagoon'],
  monkey: ['monkey', 'primate', 'ape', 'lemur', 'panther', 'ridge', 'rock'],
  zebra: ['zebra', 'capybara', 'savanna', 'savannah', 'plains', 'lawn'],
  // A wallowing elephant belongs in a water habitat far more than a bird does,
  // and 'Gator Swamp' is the third-largest pen — which an elephant needs.
  elephant: ['elephant', 'pachyderm', 'alligator', 'gator', 'swamp'],
  // A penguin IS a bird, so the aviary enclosure re-reads as the penguin house
  // with nothing about the ground having to change. It is also the smallest
  // pen, which is right for the one species that clusters.
  penguin: ['penguin', 'polar', 'antarctic', 'macaw', 'aviary', 'parrot', 'pool'],
};

/** Ground types this species is happy on, best first. cityLayout `kind`. */
const PEN_KINDS = {
  elephant: ['grass', 'water'],
  giraffe: ['grass'],
  zebra: ['grass'],
  monkey: ['rock', 'aviary'],
  penguin: ['water', 'aviary'],
  bird: ['aviary', 'water'],
};

function labelFor(sp, variant) {
  if (sp.key === 'bird') return variant === 2 ? 'Crane' : 'Flamingo';
  return sp.label;
}

/* ========================================================== habitat ===== */

/**
 * A habitat rectangle, in its own frame so a pen may be turned off-axis.
 *
 * The local transform is character-for-character the one props.js uses in
 * `Placer._reserved` (props.js:6005). Two different rotations of "the same"
 * rectangle is how a fence ends up 90 degrees out from the animals inside it.
 */
function makePen(cx, cz, hw, hd, yaw, name, kind) {
  return {
    cx, cz, hw, hd, yaw,
    cos: Math.cos(yaw), sin: Math.sin(yaw),
    name: name || '',
    kind: kind || '',
    area: hw * hd * 4,
    wet: false,
  };
}

const _lp = { lx: 0, lz: 0 };
const _wp = { x: 0, z: 0 };

function toLocal(pen, x, z, out) {
  const dx = x - pen.cx, dz = z - pen.cz;
  out.lx = dx * pen.cos - dz * pen.sin;
  out.lz = dx * pen.sin + dz * pen.cos;
  return out;
}

function toWorld(pen, lx, lz, out) {
  out.x = pen.cx + lx * pen.cos + lz * pen.sin;
  out.z = pen.cz - lx * pen.sin + lz * pen.cos;
  return out;
}

/**
 * CONTAINMENT.
 *
 * A hard clamp, applied to the integrated position, in the pen's own frame.
 *
 * This is not elegant and it is not physical — an animal that runs at a fence
 * stops dead against it instead of turning along it. It is here anyway,
 * because a clamp is the only containment that CANNOT FAIL. Steering, soft
 * repulsion, "turn away when close" and every other well-behaved alternative
 * has a numerator that can go to zero, a frame that can be long enough to step
 * over the boundary, and a flee vector that can point straight through the
 * wire. One of those slips through eventually, and the failure mode is a
 * three-tonne elephant walking down Brickell Avenue. So: clamp, every tick,
 * after integration, unconditionally.
 */
function clampToPen(pen, inset, x, z, out) {
  toLocal(pen, x, z, _lp);
  const hx = Math.max(0, pen.hw - inset);
  const hz = Math.max(0, pen.hd - inset);
  let lx = _lp.lx, lz = _lp.lz;
  if (lx < -hx) lx = -hx; else if (lx > hx) lx = hx;
  if (lz < -hz) lz = -hz; else if (lz > hz) lz = hz;
  return toWorld(pen, lx, lz, out);
}

function insidePen(pen, inset, x, z, slack = 1e-4) {
  toLocal(pen, x, z, _lp);
  return Math.abs(_lp.lx) <= Math.max(0, pen.hw - inset) + slack
    && Math.abs(_lp.lz) <= Math.max(0, pen.hd - inset) + slack;
}

/**
 * Normalise whatever `layout.zoo` turns out to be into a list of pens.
 *
 * The zoo district is reserved in cityLayout.buildLayout() and this module is
 * a consumer of that decision, not a party to it. Rather than hard-code one
 * spelling of a rectangle and silently place nothing when it changes — this
 * codebase fails SILENTLY, a kerb pass once placed zero objects for a whole
 * build because it guessed a mesh name — every reasonable spelling is
 * accepted, and anything unrecognised is reported rather than swallowed.
 *
 * Accepted for the district: `zoo.pens` / `.habitats` / `.enclosures` /
 * `.exhibits`, or the district itself as an array, or a bare rectangle.
 * Accepted for a rectangle: {x,z,w,d}, {x,z,hw,hd}, {x0,z0,x1,z1},
 * {minX,maxX,minZ,maxZ}, with an optional `yaw`.
 */
function rectToPen(r) {
  if (!r || typeof r !== 'object') return null;
  const yaw = Number.isFinite(r.yaw) ? r.yaw : (Number.isFinite(r.rot) ? r.rot : 0);
  // Both fields, kept apart: `species`/`label` is the pen's NAME and `kind` is
  // its ground type. Folding them into one string is how a 'water' pen matches
  // a species word list that happens to contain 'water'.
  const name = `${r.species || ''} ${r.label || ''} ${r.name || ''} ${r.id || ''}`
    .toLowerCase().trim();
  const kind = String(r.kind || '').toLowerCase();
  let cx, cz, hw, hd;
  if (Number.isFinite(r.x) && Number.isFinite(r.z)
      && Number.isFinite(r.hw) && Number.isFinite(r.hd)) {
    cx = r.x; cz = r.z; hw = r.hw; hd = r.hd;
  } else if (Number.isFinite(r.x) && Number.isFinite(r.z)
      && Number.isFinite(r.w) && Number.isFinite(r.d)) {
    cx = r.x; cz = r.z; hw = r.w / 2; hd = r.d / 2;
  } else if (Number.isFinite(r.x0) && Number.isFinite(r.x1)
      && Number.isFinite(r.z0) && Number.isFinite(r.z1)) {
    cx = (r.x0 + r.x1) / 2; cz = (r.z0 + r.z1) / 2;
    hw = Math.abs(r.x1 - r.x0) / 2; hd = Math.abs(r.z1 - r.z0) / 2;
  } else if (Number.isFinite(r.minX) && Number.isFinite(r.maxX)
      && Number.isFinite(r.minZ) && Number.isFinite(r.maxZ)) {
    cx = (r.minX + r.maxX) / 2; cz = (r.minZ + r.maxZ) / 2;
    hw = Math.abs(r.maxX - r.minX) / 2; hd = Math.abs(r.maxZ - r.minZ) / 2;
  } else {
    return null;
  }
  if (!(hw > 0.5) || !(hd > 0.5)) return null;
  return makePen(cx, cz, hw, hd, yaw, name, kind);
}

function readZoo(layout) {
  const out = [];
  const zoo = layout && layout.zoo;
  if (!zoo) return out;
  const lists = [zoo.pens, zoo.habitats, zoo.enclosures, zoo.exhibits,
    Array.isArray(zoo) ? zoo : null];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const r of list) {
      const p = rectToPen(r);
      if (p) out.push(p);
    }
    if (out.length) return out;
  }
  // No pen list: the district itself is the rectangle, and we subdivide.
  const whole = rectToPen(zoo);
  if (whole) out.push(whole);
  return out;
}

/**
 * Split the biggest pen along its long axis until there are at least `n`.
 *
 * `gap` is left between the halves — that strip is where the layout's own
 * fences, paths and gates go, and an animal that can stand on the fence line
 * is an animal standing inside a fence post.
 */
function splitToAtLeast(pens, n, gap) {
  let guard = 64;                       // a split loop that cannot terminate
  while (pens.length < n && guard-- > 0) {
    let bi = 0;
    for (let i = 1; i < pens.length; i++) if (pens[i].area > pens[bi].area) bi = i;
    const p = pens[bi];
    const along = p.hw >= p.hd;
    const half = (along ? p.hw : p.hd);
    const nh = half / 2 - gap / 2;
    if (nh < 3) break;                  // splitting further yields unusable pens
    // Child centre. It is `nh + gap/2`, which reduces to exactly half/2 —
    // written the short way, because the long way reads as an error.
    const off = half / 2;
    const a = along
      ? makePen(0, 0, nh, p.hd, p.yaw, p.name, p.kind)
      : makePen(0, 0, p.hw, nh, p.yaw, p.name, p.kind);
    const b = along
      ? makePen(0, 0, nh, p.hd, p.yaw, p.name, p.kind)
      : makePen(0, 0, p.hw, nh, p.yaw, p.name, p.kind);
    // Placed in the parent's frame, so a rotated district splits correctly.
    toWorld(p, along ? -off : 0, along ? 0 : -off, _wp);
    a.cx = _wp.x; a.cz = _wp.z;
    toWorld(p, along ? off : 0, along ? 0 : off, _wp);
    b.cx = _wp.x; b.cz = _wp.z;
    pens.splice(bi, 1, a, b);
  }
  return pens;
}

/**
 * Species -> pen, in the three passes MATCH_ORDER documents.
 *
 * Every pass removes the pen it claims, so no two species can be handed the
 * same rectangle — which would put a herd of zebras and a herd of elephants on
 * top of each other with both of them correctly contained and the bug looking
 * like a rendering fault.
 */
function assignPens(pens) {
  const free = pens.slice();
  const out = {};
  const how = {};

  const take = (key, i, why) => {
    out[key] = free[i];
    how[key] = `${free[i].name || free[i].kind || 'pen'} (${why})`;
    free.splice(i, 1);
  };

  // 1. by name.
  for (const key of MATCH_ORDER) {
    const words = PEN_WORDS[key];
    for (let i = 0; i < free.length; i++) {
      const n = free[i].name;
      if (!n || !words.some((w) => n.includes(w))) continue;
      take(key, i, 'name');
      break;
    }
  }
  // 2. by ground kind, largest matching pen first.
  for (const key of MATCH_ORDER) {
    if (out[key]) continue;
    const kinds = PEN_KINDS[key] || [];
    for (const want of kinds) {
      let best = -1;
      for (let i = 0; i < free.length; i++) {
        if (free[i].kind !== want) continue;
        if (best < 0 || free[i].area > free[best].area) best = i;
      }
      if (best >= 0) { take(key, best, `kind:${want}`); break; }
    }
  }
  // 3. biggest pen left to biggest animal left.
  const need = BY_SIZE.filter((k) => !out[k]);
  free.sort((a, b) => b.area - a.area);
  // The bound is taken BEFORE the loop. Testing `i < free.length` while
  // shifting `free` inside it advances the cursor and shrinks the list at the
  // same time, so it stops halfway and half the species silently get no pen —
  // which is exactly what the self-test caught on the first run.
  const n = Math.min(need.length, free.length);
  for (let i = 0; i < n; i++) {
    out[need[i]] = free[i];
    how[need[i]] = `${free[i].name || 'pen'} (by size)`;
  }
  return { pens: out, how };
}

/* ============================================================== LOD ===== */
/*
 * Copied from pedestrians.js:4896-4904 rather than invented, so the crowd and
 * the zoo drop to coarser steps at the same distances and there is one scheme
 * in the project instead of two.
 */
const NEAR2 = 75 * 75;
const MID2 = 190 * 190;
const CULL2 = 420 * 420;

/**
 * WE DO NOT HIDE A CULLED ANIMAL, and pedestrians.js does.
 *
 * That difference is load-bearing. A pedestrian's visible instance is scenery
 * and their consumable is a separate merged fall body, so collapsing the
 * instance costs nothing. An ANIMAL'S INSTANCE IS ITS CONSUMABLE — the same
 * slot the registry holds and the hole eats. Zeroing its matrix would leave an
 * invisible, fully edible zebra standing in the park. So a far animal simply
 * stops being simulated: it freezes where it stands, still drawn, still edible.
 */

/* ============================================================= build ===== */

const _v3 = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _near = [];

/**
 * Build the zoo population.
 *
 * @param {object} ctx worldBuild context
 * @returns {{count:number, update:Function, reset:Function, residue:Function}}
 */
export function buildAnimals(ctx) {
  const { scene, layout, registry } = ctx;
  /* cityLayout publishes `zoo.seed` and says outright that every animal and
     prop pass should branch from it, so that a replicated client reproduces
     the same herd. Falling back to the world seed keeps this module buildable
     against a layout that has not adopted it. */
  const zooSeed = (layout.zoo && Number.isFinite(layout.zoo.seed))
    ? layout.zoo.seed : layout.seed;
  const rng = makeRNG(((zooSeed | 0) ^ 0x2007a1) >>> 0);

  const st = {
    scene, layout, registry, rng,
    animals: [],
    pools: [],
    time: 0,
    holes: [],
    holeT: 1e3,
    focus: new THREE.Vector3(),
    focusSrc: null,
    noFocus: false,
    counts: {},
    pens: {},
  };

  // Published unconditionally, even when there is no zoo: game.js looks these
  // up once at construction (game.js:219) and a hook that appears later is a
  // hook nobody calls.
  scene.userData.animalUpdate = (dt, holes) => updateAnimals(st, dt, holes);
  scene.userData.animalReset = () => resetAnimals(st);

  const api = {
    get count() { return st.animals.length; },
    update: (dt, holes) => updateAnimals(st, dt, holes),
    reset: () => resetAnimals(st),
    residue: () => residueOf(st),
    /** Exposed for the orchestrator's verification pass, not for gameplay. */
    _state: st,
  };

  const raw = readZoo(layout);
  if (!raw.length) {
    // Loud, and then nothing. Inventing a site here would put a herd inside
    // whatever nature.js planted an hour of build time ago.
    console.warn('[animals] layout.zoo is missing or unreadable — no animals placed. '
      + 'The habitat must be reserved in cityLayout.buildLayout() BEFORE nature runs; '
      + 'see the basketball-court reservation for the shape this module reads.');
    return api;
  }

  const PATH = 2.2;                       // strip left between split pens
  const pens = splitToAtLeast(raw.slice(), BY_SIZE.length, PATH);
  const assigned = assignPens(pens);
  st.pens = assigned.pens;

  /* Which pens sit near water at all. `layout.isWater` walks the water polys,
     and calling it for sixty animals every frame is a cost the frame budget
     does not have — so it is asked ONCE per pen here, and only pens that can
     possibly reach water pay for the test at runtime. */
  for (const key of BY_SIZE) {
    const pen = st.pens[key];
    if (!pen) continue;
    pen.wet = penTouchesWater(layout, pen);
    pen.ponds = pondsIn(built, pen);
  }

  /* GROUND HEIGHT, taken from the module that actually built the surface.
     zoo.js publishes `ctx.zoo.y` — the height it laid its pens, paths and pond
     rims at (zoo.js:1831) — and standing the animals on anything else means
     standing them on a surface nobody built. The fallback is the same
     expression zoo.js falls back to, so the two cannot drift apart. */
  const built = ctx.zoo;
  const groundY = (built && Number.isFinite(built.y))
    ? built.y : (ctx.Y_WALK ?? 0.155) + 0.015;

  const MAX_ANIMALS = 64;                 // hard ceiling on the per-frame cost
  for (const key of BY_SIZE) {
    const sp = SPECIES[key];
    const pen = st.pens[key];
    if (!pen) continue;
    const inset = penInset(pen, sp);
    if (inset <= 0) continue;             // pen too small for this animal at all
    const usable = Math.max(0, (pen.hw - inset) * 2) * Math.max(0, (pen.hd - inset) * 2);
    let n = Math.round(usable / sp.per);
    if (n < sp.min) n = sp.min;
    if (n > sp.max) n = sp.max;
    n = Math.min(n, MAX_ANIMALS - st.animals.length);
    if (n <= 0) continue;
    spawnSpecies(ctx, st, sp, pen, inset, groundY, n);
  }

  if (!st.animals.length) {
    console.warn('[animals] a zoo district was found but every pen was too small '
      + 'or every placement was refused — nothing stands in it.');
    return api;
  }

  const parts = BY_SIZE.filter((k) => st.counts[k]).map((k) => `${st.counts[k]} ${k}`);
  console.info(
    `[animals] ${st.animals.length} animals in ${Object.keys(st.pens).length} habitats: `
    + `${parts.join(', ')} | ${st.pools.length} pools | `
    + `${BY_SIZE.filter((k) => st.pens[k] && st.pens[k].wet).length} pens border water`
  );
  /* The pen the layout named and the animal actually standing in it. Printed
     because this pairing has silently gone wrong once already (see
     MATCH_ORDER): a wrong mapping throws nothing, renders fine, and is only
     visible as animals standing under a sign for a different species. A `(by
     size)` in this line means a pen was NOT matched by name and somebody
     should look at ZOO_SPECIES. */
  console.info('[animals] habitat mapping: '
    + BY_SIZE.filter((k) => assigned.how[k]).map((k) => `${k} -> ${assigned.how[k]}`).join(', '));
  return api;
}

/** Largest inset that still leaves a pen an animal can turn round in. */
function penInset(pen, sp) {
  // Body half-width, plus enough clearance that the mesh never touches the
  // fence line the layout reserved for its own posts.
  const want = sp.foot + 0.45;
  const cap = Math.min(pen.hw, pen.hd) * 0.42;
  const inset = Math.min(want, cap);
  return (pen.hw - inset > sp.foot * 0.8 && pen.hd - inset > sp.foot * 0.8) ? inset : 0;
}

/**
 * The ponds zoo.js dug inside this pen.
 *
 * `layout.isWater` knows nothing about them — it answers for the bay, the
 * river and the basins, and a pond zoo.js excavated inside a pen is none of
 * those. So a giraffe would have walked straight through open water that the
 * only water test in this module says is dry ground.
 *
 * They are ELLIPSES: zoo.js sweeps radius `r` in x and `r * sq` in z
 * (zoo.js:1790), so a circular test would either let an animal into the narrow
 * ends or lock it out of ground it can stand on.
 */
function pondsIn(built, pen) {
  const out = [];
  if (!built || !Array.isArray(built.ponds)) return out;
  for (const p of built.ponds) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.r)) continue;
    // Centre inside the pen: a pond belongs to exactly one habitat.
    if (!insidePen(pen, 0, p.x, p.z, p.r)) continue;
    out.push({ x: p.x, z: p.z, rx: p.r, rz: p.r * (Number.isFinite(p.sq) ? p.sq : 1) });
  }
  return out;
}

/** Would this animal's body be standing in one of them? */
function inPond(ponds, x, z, foot) {
  for (let i = 0; i < ponds.length; i++) {
    const p = ponds[i];
    const ax = (x - p.x) / (p.rx + foot);
    const az = (z - p.z) / (p.rz + foot);
    if (ax * ax + az * az < 1) return true;
  }
  return false;
}

/** Nine samples across the pen. One wet sample and the pen pays the runtime test. */
function penTouchesWater(layout, pen) {
  if (typeof layout.isWater !== 'function') return false;
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      toWorld(pen, i * pen.hw * 0.92, j * pen.hd * 0.92, _wp);
      if (layout.isWater(_wp.x, _wp.z)) return true;
    }
  }
  return false;
}

/**
 * Perches a monkey can actually climb.
 *
 * Not invented geometry: the registry is queried for whatever props.js and
 * nature.js already put in this pen, and only objects of a climbable height
 * are kept. A monkey sitting on top of a real rock is worth more than a monkey
 * levitating over a spot where a rock might have been.
 */
function findPerches(ctx, pen, groundY) {
  const out = [];
  if (!ctx.registry || typeof ctx.registry.query !== 'function') return out;
  const found = ctx.registry.query(pen.cx, pen.cz, Math.hypot(pen.hw, pen.hd), _near);
  for (let i = 0; i < found.length && out.length < 4; i++) {
    const c = found[i];
    if (!c || !c.position) continue;
    if (typeof c.kind === 'string' && c.kind.startsWith('animal-')) continue;
    const h = c.height || 0;
    if (h < 0.7 || h > 2.6) continue;
    if ((c.radius || 0) < 0.30) continue;
    if (!insidePen(pen, 1.2, c.position.x, c.position.z)) continue;
    out.push({
      c,
      x: c.position.x,
      z: c.position.z,
      y: Math.max(groundY, c.position.y + h * 0.84),
    });
  }
  return out;
}

function spawnSpecies(ctx, st, sp, pen, inset, groundY, n) {
  const rng = st.rng;
  const perches = sp.perch ? findPerches(ctx, pen, groundY) : null;
  const hx = Math.max(0, pen.hw - inset);
  const hz = Math.max(0, pen.hd - inset);
  const minSep = sp.foot * 2.1;
  const placed = [];
  let leader = null;

  for (let i = 0; i < n; i++) {
    /* Rejection sampling with a low try count. A herd is meant to LOOK like a
       herd, so a couple of near-misses are fine; what is not fine is two
       elephants sharing a footprint, which reads as one two-headed elephant. */
    let x = 0, z = 0, ok = false;
    for (let t = 0; t < 14; t++) {
      toWorld(pen, (rng() * 2 - 1) * hx, (rng() * 2 - 1) * hz, _wp);
      let clear = true;
      for (let k = 0; k < placed.length; k += 2) {
        const dx = placed[k] - _wp.x, dz = placed[k + 1] - _wp.z;
        if (dx * dx + dz * dz < minSep * minSep) { clear = false; break; }
      }
      if (!clear) continue;
      // A land animal never STARTS in water either, which is what makes the
      // "revert to the last position" rule in the tick safe by induction.
      if (pen.wet && st.layout.isWater(_wp.x, _wp.z)) continue;
      x = _wp.x; z = _wp.z; ok = true;
      break;
    }
    if (!ok) continue;
    placed.push(x, z);

    const variant = i % sp.variants;
    const scale = sp.scale[0] + rng() * (sp.scale[1] - sp.scale[0]);
    const yaw = rng() * TAU;
    const key = `animal-${sp.key}-${variant}`;

    const c = ctx.addInstanced(key, () => ({
      geometry: sp.geo(variant),
      material: animalMat(),
    }), {
      // A shared scratch vector is safe HERE and only because both consumers
      // clone it: pools.add does `position.clone()` into slotPos (pools.js:134)
      // and Consumable does the same into `.position` (entities.js:41). Nothing
      // downstream keeps this reference, so the next animal may reuse it.
      position: _v3.set(x, groundY, z),
      rotationY: yaw,
      scale,
      // A multiplying instance tint can only darken, never recolour, so this is
      // coat tone and nothing more — enough that a herd is not one hue.
      hex: coatTint(rng),
      tier: sp.tier,
      score: sp.score,
      radius: sp.foot,
      label: labelFor(sp, variant),
      kind: key,
      capacity: sp.max + 2,
      dynamic: true,
      castShadow: true,
      receiveShadow: false,
      /* A penguin is 1.1 m tall and would fail pools.js's 1.8 m height cull
         (pools.js:263), losing the contact shadow that is the only thing
         putting it ON the grass rather than above it — and it MOVES, so the
         eye tracks the shadow. Everything animated in this project sets this. */
      keepShadow: true,
      debrisColor: sp.key === 'zebra' ? C.zebraLight : C.eleGrey,
    });
    if (!c) continue;                      // pool full: fewer animals, never a crash

    if (st.pools.indexOf(c.pool) < 0) st.pools.push(c.pool);

    const a = {
      sp, pen, inset, c,
      x, z, y: groundY, yaw,
      x0: x, z0: z, y0: groundY, yaw0: yaw,
      baseY: groundY,
      tx: x, tz: z,
      pause: rng() * 2.5,
      gait: rng() * TAU,
      acc: 0,
      roll: 0, pitch: 0,
      held: false, culled: false, fleeing: false,
      leader: null,
      offX: 0, offZ: 0,
      perches: perches && perches.length ? perches : null,
      perch: null, perchY: groundY, perchT: 0, climb: 0,
    };
    if (sp.herd) {
      if (!leader) leader = a;
      else {
        a.leader = leader;
        const ang = rng() * TAU;
        const rad = sp.foot * 2.4 + rng() * sp.foot * 5.0;
        a.offX = Math.cos(ang) * rad;
        a.offZ = Math.sin(ang) * rad;
      }
    }
    retarget(st, a);
    st.animals.push(a);
    st.counts[sp.key] = (st.counts[sp.key] || 0) + 1;
  }
}

/**
 * Coat tone.
 *
 * pools.js raises the instance colour to the 2.2 on its way to linear space
 * (pools.js:119), so the band has to be narrow at THIS end to be narrow at the
 * other: 0.96 becomes 0.914, and 0.90 would have become 0.79 — a fifth of the
 * albedo gone, which reads as a dirty animal rather than a different one.
 */
function coatTint(rng) {
  const k = 0.96 + rng() * 0.04;
  const v = Math.max(0, Math.min(255, Math.round(255 * k)));
  return (v << 16) | (v << 8) | v;
}

/* ============================================================ behaviour == */

function retarget(st, a) {
  const pen = a.pen;
  const L = a.leader;
  if (L && L.c && L.c.state === STATE.IDLE) {
    // Loose follow: aim at a fixed offset from the leader, not at the leader,
    // so a herd spreads out instead of collapsing onto one point.
    clampToPen(pen, a.inset, L.x + a.offX, L.z + a.offZ, _wp);
  } else {
    const hx = Math.max(0, pen.hw - a.inset);
    const hz = Math.max(0, pen.hd - a.inset);
    toWorld(pen, (st.rng() * 2 - 1) * hx, (st.rng() * 2 - 1) * hz, _wp);
  }
  a.tx = _wp.x;
  a.tz = _wp.z;
}

/**
 * A content module cannot reach the camera, so LOD keys off the shadow rig's
 * target the same way pedestrians.js does (pedestrians.js:5156).
 */
function resolveFocus(st) {
  if (!st.focusSrc) {
    let sunTarget = null;
    for (const o of st.scene.children) {
      if (o.isCamera) { st.focusSrc = o; break; }
      if (o.isDirectionalLight && o.castShadow && o.target) sunTarget = o.target;
    }
    if (!st.focusSrc) st.focusSrc = sunTarget;
    if (!st.focusSrc) { st.focus.set(0, 0, 0); st.noFocus = true; return; }
    st.noFocus = false;
  }
  st.focus.copy(st.focusSrc.position);
}

/**
 * Whatever the caller handed us, or a scan of the scene if it handed us
 * nothing. The scan is the fallback pedestrians.js uses (collectHoles,
 * pedestrians.js:5174) and it exists so this module still works if the frame
 * loop calls `animalUpdate(dt)` with one argument.
 */
function gatherHoles(st, holes, dt) {
  const out = st.holes;
  if (holes && holes.length !== undefined) {
    out.length = 0;
    for (let i = 0; i < holes.length; i++) {
      const h = holes[i];
      if (!h || h.alive === false) continue;
      const p = h.position;
      if (!p) continue;
      out.push({ x: p.x, z: p.z, r: h.radius || h.trueRadius || 1 });
    }
    return out;
  }
  st.holeT += dt;
  if (st.holeT < 0.4) return out;
  st.holeT = 0;
  out.length = 0;
  for (const o of st.scene.children) {
    if (!o.visible || !o.name || !o.name.startsWith('hole-')) continue;
    let r = 0;
    for (const ch of o.children) if (ch.scale.x > r) r = ch.scale.x;
    if (r < 0.2) continue;
    out.push({ x: o.position.x, z: o.position.z, r });
  }
  return out;
}

function updateAnimals(st, dt, holes) {
  const n = st.animals.length;
  if (!n) return;
  if (!(dt > 0)) dt = 1 / 60;
  // A backgrounded tab hands back a multi-second dt. Without this the herd
  // teleports, and a teleport past a fence is exactly what the clamp is for —
  // but a teleport INSIDE the pen still looks like a bug, so it is capped.
  if (dt > 0.25) dt = 0.25;
  st.time += dt;

  resolveFocus(st);
  const hl = gatherHoles(st, holes, dt);
  const fx = st.focus.x, fz = st.focus.z;

  for (let i = 0; i < n; i++) {
    const a = st.animals[i];
    const c = a.c;
    if (!c) continue;

    /* ---- who owns this body? -------------------------------------------
     * The same handover vehicles.js performs (vehicles.js:5640). At WOBBLE the
     * hole has taken ground from under the animal and the consume system owns
     * its transform from that moment; writing a walk pose over it is how a
     * prop ends up half-eaten and standing up again. */
    if (c.state !== STATE.IDLE) { a.held = true; continue; }
    if (a.held) {
      // Back from the dead, wherever the respawner put it.
      a.held = false;
      a.x = c.position.x;
      a.z = c.position.z;
      a.climb = 0; a.perch = null;
      a.y = a.baseY;
      clampToPen(a.pen, a.inset, a.x, a.z, _wp);
      a.x = _wp.x; a.z = _wp.z;
      a.acc = 0;
      retarget(st, a);
    }

    const dx = a.x - fx, dz = a.z - fz;
    const d2 = st.noFocus ? 0 : dx * dx + dz * dz;
    if (d2 > CULL2) { a.culled = true; continue; }   // frozen, NOT hidden
    a.culled = false;

    const interval = d2 < NEAR2 ? 0 : d2 < MID2 ? 1 / 28 : 1 / 10;
    a.acc += dt;
    if (a.acc < interval) continue;
    const sdt = a.acc > 0.34 ? 0.34 : a.acc;
    a.acc = 0;

    stepAnimal(st, a, sdt, hl);
    writePose(st, a);
  }

  // Nothing in the engine flushes instanced pools per frame, so do our own —
  // the same line vehicles.js ends its tick with (vehicles.js:5810).
  for (let i = 0; i < st.pools.length; i++) st.pools[i].flush();
}

function stepAnimal(st, a, dt, holes) {
  const sp = a.sp;

  /* ---- flee ------------------------------------------------------------
   * Straight away from every hole in range, weighted so the nearest wins.
   * The target is deliberately set THIRTY METRES away and NOT clamped: the
   * animal runs flat out at the fence, and the clamp below stops it there. A
   * cornered animal presses against the wire, which is what it should do. */
  let ax = 0, az = 0, near = 0;
  for (let i = 0; i < holes.length; i++) {
    const h = holes[i];
    const hx = a.x - h.x, hz = a.z - h.z;
    const reach = sp.fleeR + h.r;
    const dd = hx * hx + hz * hz;
    if (dd > reach * reach) continue;
    const d = Math.sqrt(dd) || 1e-3;
    const w = (reach - d) / reach;
    ax += (hx / d) * w;
    az += (hz / d) * w;
    near++;
  }

  let speed;
  if (near) {
    const l = Math.hypot(ax, az) || 1;
    a.tx = a.x + (ax / l) * 30;
    a.tz = a.z + (az / l) * 30;
    a.pause = 0;
    a.fleeing = true;
    a.perch = null;                     // whatever it was holding, it lets go
    speed = sp.run;
  } else {
    if (a.fleeing) { a.fleeing = false; retarget(st, a); }
    speed = sp.speed;
  }

  /* ---- climbing (monkeys only) ---------------------------------------- */
  if (sp.perch) speed = stepPerch(st, a, dt, near, speed);

  /* ---- walk ------------------------------------------------------------ */
  let nx = a.x, nz = a.z;
  if (a.pause > 0 && !near) {
    a.pause -= dt;
    a.gait += dt * 0.7;                 // idle sway, so nothing is a statue
  } else {
    const tx = a.tx - a.x, tz = a.tz - a.z;
    const dist = Math.hypot(tx, tz);
    const arrive = 0.30 + sp.foot * 0.35;
    if (dist < arrive || speed <= 0) {
      if (!near && speed > 0) {
        a.pause = sp.pause[0] + st.rng() * (sp.pause[1] - sp.pause[0]);
        retarget(st, a);
      }
      a.gait += dt * 0.7;
    } else {
      // Turn toward the heading at a species rate, then walk along the BODY
      // axis — an animal that strafes at its target instead of turning into it
      // is the tell that gave the first crowd system away.
      const want = Math.atan2(tx / dist, tz / dist);
      let d = want - a.yaw;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      const lim = sp.turn * dt;
      a.yaw += d > lim ? lim : d < -lim ? -lim : d;
      const step = Math.min(speed * dt, dist);
      nx = a.x + Math.sin(a.yaw) * step;
      nz = a.z + Math.cos(a.yaw) * step;
      a.gait += step * sp.gaitK;
    }
  }

  /* ---- CONTAINMENT, unconditionally, after integration ----------------- */
  clampToPen(a.pen, a.inset, nx, nz, _wp);
  nx = _wp.x;
  nz = _wp.z;

  /* WATER. Only pens that were measured as touching water at build time pay
     for this — `isWater` walks the water polygons and sixty calls a frame is
     real money at this frame budget. Reverting to the previous position is
     safe because that position was dry: spawn refuses wet ground, and every
     step since has been through this same gate. */
  if (a.pen.wet && st.layout.isWater(nx, nz)) {
    nx = a.x;
    nz = a.z;
    a.pause = 0.35;
    retarget(st, a);
  }
  a.x = nx;
  a.z = nz;

  /* ---- gait -------------------------------------------------------------
   * `abs(sin)` and not `sin`: a bob that goes negative drives the feet through
   * the grass on every other step. */
  const amp = (a.pause > 0 && !near) ? 0.25 : 1;
  const lift = a.climb > 0 ? (a.perchY - a.baseY) * a.climb : 0;
  a.y = a.baseY + lift + Math.abs(Math.sin(a.gait)) * sp.bob * amp;
  a.roll = Math.sin(a.gait) * sp.roll * amp;
  a.pitch = Math.sin(a.gait * 2) * sp.pitch * amp;
}

/**
 * Monkeys, and only monkeys, get off the ground.
 *
 * The perch is a real registered consumable found at build time, so if a hole
 * eats the rock the monkey was sitting on, the monkey comes down instead of
 * hanging in the air over the crater. That check is the whole reason this is
 * keyed on the Consumable and not on a stored coordinate.
 */
function stepPerch(st, a, dt, near, speed) {
  if (a.perch) {
    const p = a.perch;
    const gone = !p.c || p.c.state !== STATE.IDLE;
    if (near || gone) {
      a.perch = null;
    } else {
      a.tx = p.x;
      a.tz = p.z;
      const dx = p.x - a.x, dz = p.z - a.z;
      if (dx * dx + dz * dz < 0.36) {
        a.climb = Math.min(1, a.climb + dt * 1.6);
        a.perchT -= dt;
        if (a.perchT <= 0) a.perch = null;
        // Holding on: no walking while it is up there.
        if (a.climb > 0.15) return 0;
      }
    }
  } else if (a.perches && a.climb <= 0 && !near && st.rng() < dt * 0.10) {
    const p = a.perches[Math.floor(st.rng() * a.perches.length)];
    if (p && p.c && p.c.state === STATE.IDLE) {
      a.perch = p;
      a.perchY = p.y;
      a.perchT = 3 + st.rng() * 6;
      a.pause = 0;
    }
  }
  if (!a.perch && a.climb > 0) {
    a.climb = Math.max(0, a.climb - dt * 2.0);
    if (a.climb > 0.15) return 0;         // still coming down
  }
  return speed;
}

/**
 * Push one animal's transform to its instance slot AND to the registry.
 *
 * `slotPos` is the authored resting place the consume system falls from and
 * respawns to, so a moving consumable has to keep it current — exactly what
 * vehicles.js does (vehicles.js:5694). And `registry.rehash` is not optional:
 * without it the spatial hash keeps the animal in the cell it was BUILT in,
 * and a hole swallows a zebra that walked away ten seconds ago.
 */
function writePose(st, a) {
  const c = a.c;
  _pos.set(a.x, a.y, a.z);
  _e.set(a.pitch, a.yaw, a.roll, 'YXZ');
  _q.setFromEuler(_e);
  c.position.copy(_pos);
  const p = c.pool;
  if (!p) return;
  if (p.slotPos[c.slot]) p.slotPos[c.slot].copy(_pos);
  if (p.slotRot[c.slot]) p.slotRot[c.slot].copy(_q);
  p.setTransform(c.slot, _pos, _q, p.slotScale[c.slot]);
  st.registry.rehash(c);
}

/* ============================================================== reset ==== */

/**
 * Put every animal back where it was built, with nothing left over.
 *
 * ORDERING CONTRACT: game.js's resetWorld() calls consume.resetAll() first and
 * the module hooks afterwards (game.js:741-757), so by the time this runs the
 * consume system has already dropped its in-flight interactions. This function
 * repeats the physics-state clear anyway so that it is correct called alone —
 * a reset that only works in one calling order is a reset that will one day be
 * called in the other one.
 */
function resetAnimals(st) {
  for (let i = 0; i < st.animals.length; i++) {
    const a = st.animals[i];
    a.x = a.x0; a.z = a.z0; a.y = a.y0; a.yaw = a.yaw0;
    a.tx = a.x0; a.tz = a.z0;
    a.roll = 0; a.pitch = 0;
    a.pause = 0; a.acc = 0; a.gait = 0;
    a.held = false; a.culled = false; a.fleeing = false;
    a.perch = null; a.perchT = 0; a.climb = 0; a.perchY = a.baseY;

    const c = a.c;
    if (!c) continue;
    c.state = STATE.IDLE;
    c.fallT = 0;
    c.eatenBy = null;
    c._hasTipQuat = false;
    if (c._dyn) {
      const d = c._dyn;
      d.ox = d.oy = d.oz = 0;
      d.vx = d.vz = 0;
      d.roll = 0; d.tilt = 0; d.tiltVel = 0; d.loss = 0;
      d.hole = null; d.settled = false;
    }
    _pos.set(a.x0, a.y0, a.z0);
    _e.set(0, a.yaw0, 0, 'YXZ');
    _q.setFromEuler(_e);
    c.position.copy(_pos);
    const p = c.pool;
    if (p) {
      if (p.slotPos[c.slot]) p.slotPos[c.slot].copy(_pos);
      if (p.slotRot[c.slot]) p.slotRot[c.slot].copy(_q);
      // restore() composes slotPos/slotRot/slotScale — the authored stance.
      p.restore(c.slot);
    }
    if (st.registry) {
      if (st.registry.byId && !st.registry.byId.has(c.id)) st.registry.add(c);
      if (typeof st.registry.rehash === 'function') st.registry.rehash(c);
    }
  }
  // resetWorld() flushes the pools BEFORE it calls the module hooks, so the
  // matrices written above would sit dirty until the next frame. Flush ours.
  for (let i = 0; i < st.pools.length; i++) {
    const p = st.pools[i];
    p._dirtyAll = true;
    p.flush();
  }
  st.time = 0;
  st.holeT = 1e3;
  st.holes.length = 0;
}

/**
 * What is left over. Every counter must be zero immediately after reset(); a
 * non-zero one names exactly which invariant survived the restart.
 */
function residueOf(st) {
  let outsidePen = 0, notIdle = 0, moved = 0, fleeing = 0, climbing = 0, inWater = 0;
  for (let i = 0; i < st.animals.length; i++) {
    const a = st.animals[i];
    if (!insidePen(a.pen, a.inset, a.x, a.z, 1e-3)) outsidePen++;
    if (a.c && a.c.state !== STATE.IDLE) notIdle++;
    if (Math.abs(a.x - a.x0) > 1e-6 || Math.abs(a.z - a.z0) > 1e-6
        || Math.abs(a.y - a.y0) > 1e-6) moved++;
    if (a.fleeing) fleeing++;
    if (a.climb > 0 || a.perch) climbing++;
    if (a.pen.wet && st.layout && typeof st.layout.isWater === 'function'
        && st.layout.isWater(a.x, a.z)) inWater++;
  }
  return {
    animals: st.animals.length,
    outsidePen, notIdle, moved, fleeing, climbing, inWater,
  };
}

/* ============================================================ catalogue == */

/**
 * Build one animal on its own, with no world around it.
 *
 * The same escape hatch nature.js exposes (nature.js:7862) and for the same
 * reason: `tools/prop-catalogue.mjs` photographs props out of the assembled
 * city, and with six agents in this tree at once the city routinely will not
 * boot. This module's import graph is three, config, rng, materials, entities
 * and props, so an animal can always be built and looked at even when nothing
 * else can.
 */
export function specimen(key, variant = 0) {
  const sp = SPECIES[key];
  if (!sp) return null;
  return {
    geometry: sp.geo(variant % sp.variants),
    material: animalMat(),
    def: sp,
  };
}

/** Every kind this module owns, for a caller that wants to sweep them. */
export function animalKeys() {
  const out = [];
  for (const key of BY_SIZE) {
    for (let v = 0; v < SPECIES[key].variants; v++) out.push(`animal-${key}-${v}`);
  }
  return out;
}

/* ============================================================ selftest === */

/**
 * Headless self-test. No renderer, no world build, no DOM.
 *
 *   node -e "import('./src/world/animals.js').then(m=>console.log(m.__selftest()))"
 *
 * Covers the four things that would be silent failures in the live game:
 * containment under a flee vector aimed straight at a fence, land animals in
 * water, reset leaving residue, and update() with no holes at all.
 */
/**
 * worldBuild.measureGeometry's contact maths, repeated here.
 *
 * Deliberately a COPY and not an import: worldBuild.js imports every content
 * module, so importing it back would close a cycle, and the point of the test
 * is to check this module against that file's rule rather than to share code
 * with it. If worldBuild's band ever moves off the lowest fifth, this test
 * starts lying — which is why the source line is named in the comment above
 * its only caller. Test support only.
 */
function contactOf(geometry) {
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const height = bb.max.y - bb.min.y;
  const hi = bb.min.y + height * 0.20;
  const pos = geometry.attributes.position;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > hi) continue;
    const x = pos.getX(i), z = pos.getZ(i);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (!(maxX > minX)) {
    return { radius: Math.hypot(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / 2, degenerate: true };
  }
  return { radius: Math.hypot(maxX - minX, maxZ - minZ) / 2, degenerate: false };
}

/** Cheap checksum of a geometry's vertex positions. Test support only. */
function geoHash(g) {
  const p = g.attributes.position.array;
  let h = 0x811c9dc5;
  for (let i = 0; i < p.length; i++) {
    h = Math.imul(h ^ Math.round(p[i] * 4096), 0x01000193) | 0;
  }
  return h >>> 0;
}

export function __selftest() {
  const results = [];
  let failed = 0;
  const ok = (name, cond, detail = '') => {
    results.push({ name, pass: !!cond, detail: String(detail) });
    if (!cond) failed++;
  };

  /* --- 1. every species and variant builds a usable mesh ----------------- */
  {
    let tris = 0;
    let worstMesh = 0;
    const census = [];
    for (const key of BY_SIZE) {
      const sp = SPECIES[key];
      for (let v = 0; v < sp.variants; v++) {
        const g = sp.geo(v);
        g.computeBoundingBox();
        const bb = g.boundingBox;
        const h = bb.max.y - bb.min.y;
        const t = g.index.count / 3;
        ok(`${key} v${v} has vertex colours`, !!g.attributes.color);
        ok(`${key} v${v} has no uv attribute`, !g.attributes.uv);
        ok(`${key} v${v} is base-anchored`, bb.min.y > -0.03 && bb.min.y < 0.06, bb.min.y);
        ok(`${key} v${v} has a plausible height`, h > 0.4 && h < 6.0, h);
        /* The poses have to be different OBJECTS, not one object turned round —
           "a herd is one mesh stamped out six times" is a criticism this
           project has already earned. Checked on the position buffer and NOT
           on triangle count or bounding box: the elephant's two trunk poses
           produce byte-identical counts and an identical box, so both of the
           cheap tests would have passed a genuine duplicate. */
        if (v > 0) {
          ok(`${key} v${v} is a different mesh from v${v - 1}`,
            geoHash(sp.geo(v - 1)) !== geoHash(g));
        }
        census.push(`${key}v${v}:${t}`);
        tris += t;
        if (t > worstMesh) worstMesh = t;
      }
    }
    // 64 animals against these meshes is about 24 k triangles, next to a frame
    // that already rasterises 9.25 M. The cap exists to catch a species that
    // has quietly doubled, not to squeeze the last hundred out.
    ok('no single animal exceeds 700 triangles', worstMesh <= 700, worstMesh);
    ok('whole bestiary under 6000 triangles', tris < 6000, `${tris} — ${census.join(' ')}`);
  }

  /* --- 1b. the declared foot is not smaller than the MEASURED one --------
   * worldBuild measures the contact footprint off the geometry and overrides
   * whatever a module declared (worldBuild.js:197), but the PEN INSET here is
   * derived from `foot` — so an under-declared foot is not corrected anywhere,
   * it just quietly lets the body hang over the fence. The elephant's resting
   * trunk found this: 1.66 as a body, 2.24 with the trunk in the band. */
  {
    for (const key of BY_SIZE) {
      const sp = SPECIES[key];
      let worst = 0;
      for (let v = 0; v < sp.variants; v++) {
        const m = contactOf(sp.geo(v));
        if (m.radius > worst) worst = m.radius;
        ok(`${key} v${v} has a real contact patch`, !m.degenerate,
          'contact band is empty — the footprint fell back to full extents');
      }
      const needed = worst * sp.scale[1];
      ok(`${key} foot covers its measured contact patch`,
        sp.foot + 0.45 >= needed - 1e-6, `foot ${sp.foot} + 0.45 vs ${needed.toFixed(2)}`);
    }
  }

  /* --- a stub world, with a water strip cutting the zoo in half ---------- */
  const WATER_X = 40;                   // everything east of this is water
  const mkCtx = () => {
    const pools = [];
    return {
      Y_WALK: 0.155,
      scene: new THREE.Scene(),
      layout: {
        seed: 4242,
        blocks: [],
        zoo: { x: 0, z: 0, w: 150, d: 110 },
        isWater: (x) => x > WATER_X,
        isRoad: () => false,
      },
      registry: {
        byId: new Map(),
        add() {},
        rehash() {},
        query(x, z, r, out) { out.length = 0; return out; },
      },
      addInstanced(key, factory, opts) {
        // The factory is the expensive half and is exercised in test 1, so the
        // stub skips it and hands back the shape addInstanced really returns.
        let pool = pools.find((p) => p.key === key);
        if (!pool) {
          pool = {
            key, n: 0, slotPos: [], slotRot: [], slotScale: [],
            _dirtyAll: false,
            setTransform() {}, restore() {}, flush() {},
          };
          pools.push(pool);
        }
        const slot = pool.n++;
        pool.slotPos[slot] = opts.position.clone();
        pool.slotRot[slot] = new THREE.Quaternion();
        pool.slotScale[slot] = new THREE.Vector3(1, 1, 1);
        return {
          id: `${key}#${slot}`, pool, slot,
          position: opts.position.clone(),
          radius: opts.radius, height: 1, tier: opts.tier,
          kind: opts.kind, label: opts.label, state: STATE.IDLE,
        };
      },
    };
  };

  const built = buildAnimals(mkCtx());
  const st = built._state;
  ok('animals were built', built.count > 0, built.count);
  ok('every species is represented',
    BY_SIZE.every((k) => (st.counts[k] || 0) > 0),
    JSON.stringify(st.counts));
  ok('animalUpdate is published on the scene',
    typeof st.scene.userData.animalUpdate === 'function');
  ok('animalReset is published on the scene',
    typeof st.scene.userData.animalReset === 'function');
  ok('nobody spawned in water', st.animals.every((a) => a.x <= WATER_X));

  /* --- 2. update() is safe with zero holes ------------------------------- */
  {
    let threw = null;
    try {
      built.update(1 / 60, []);
      built.update(1 / 60);            // one argument, the fallback path
      built.update(0, []);             // a zero dt must not divide by anything
      built.update(-1, []);
      built.update(9.9, []);           // a backgrounded tab
      for (let i = 0; i < 400; i++) built.update(1 / 60, []);
    } catch (e) { threw = e; }
    ok('update with no holes never throws', !threw, threw && threw.message);
    ok('still contained after 400 idle ticks',
      st.animals.every((a) => insidePen(a.pen, a.inset, a.x, a.z, 1e-3)));
    ok('nobody walked into water after 400 idle ticks',
      st.animals.every((a) => a.x <= WATER_X + 1e-6));
    ok('nobody sank below the lawn', st.animals.every((a) => a.y >= a.baseY - 1e-9));
  }

  /* --- 3. ADVERSARIAL FLEE: a hole parked so the run is straight at a fence */
  {
    let worst = 0;
    let wet = 0;
    let cornered = 0;
    let targeted = 0;
    const stragglers = [];
    /* ONE hole at a time, and outside the pen it is aimed at, so the flee
       vector for every animal in that pen points at the far fence and never
       turns away from it. Six holes at once — the first version of this test —
       let two pushes cancel in the middle of a pen, and an animal that is not
       driven into the wire is not a containment test at all. */
    for (const key of BY_SIZE) {
      const pen = st.pens[key];
      if (!pen) continue;
      targeted++;
      toWorld(pen, -pen.hw - 3, 0, _wp);
      const holes = [{ position: { x: _wp.x, z: _wp.z }, radius: 45, alive: true }];
      // A deliberately brutal dt: 0.2 s a tick is 0.86 m of fleeing zebra.
      for (let step = 0; step < 300; step++) {
        built.update(0.2, holes);
        for (const a of st.animals) {
          toLocal(a.pen, a.x, a.z, _lp);
          const hx = Math.max(0, a.pen.hw - a.inset);
          const hz = Math.max(0, a.pen.hd - a.inset);
          const over = Math.max(Math.abs(_lp.lx) - hx, Math.abs(_lp.lz) - hz);
          if (over > worst) worst = over;
          if (a.pen.wet && a.x > WATER_X) wet++;
        }
      }
      /* Everything in the targeted pen must now be jammed against the +x wire —
         or, in a pen that borders water, against the WATER LINE, which is the
         nearer of the two barriers and stops them first. Both are the same
         property: the animal ran until something it cannot cross stopped it. */
      const mine = st.animals.filter((a) => a.pen === pen);
      const stuck = mine.filter((a) => {
        toLocal(a.pen, a.x, a.z, _lp);
        if (_lp.lx > Math.max(0, a.pen.hw - a.inset) - 0.05) return true;
        return a.pen.wet && a.x > WATER_X - 1.6;
      });
      if (mine.length && stuck.length === mine.length) cornered++;
      else stragglers.push(`${key}:${stuck.length}/${mine.length}`);
    }
    ok('CONTAINMENT holds under an adversarial flee', worst <= 1e-6, worst);
    ok('no land animal is ever in water while fleeing', wet === 0, wet);
    ok('every targeted pen ended up pressed against a barrier',
      targeted > 0 && cornered === targeted,
      `${cornered}/${targeted} ${stragglers.join(' ')}`);
  }

  /* --- 4. an eaten animal is left alone ---------------------------------- */
  {
    const a = st.animals[0];
    const wasX = a.x, wasZ = a.z;
    a.c.state = STATE.FALLING;
    for (let i = 0; i < 60; i++) built.update(1 / 60, []);
    ok('a falling animal is not walked by us', a.x === wasX && a.z === wasZ);
    ok('and it is marked as held', a.held);
    a.c.state = STATE.IDLE;
    built.update(1 / 60, []);
    ok('and it is picked back up when it returns to IDLE', !a.held);
  }

  /* --- 5. reset leaves zero residue -------------------------------------- */
  {
    // Make a mess first: scatter, flee, eat one, perch one.
    for (const a of st.animals) { a.fleeing = true; a.climb = 0.5; }
    st.animals[1].c.state = STATE.GONE;
    for (let i = 0; i < 30; i++) built.update(0.2, []);
    const before = built.residue();
    ok('the mess is real before reset',
      before.moved > 0 || before.notIdle > 0 || before.fleeing > 0,
      JSON.stringify(before));

    built.reset();
    const r = built.residue();
    ok('reset: nothing outside its pen', r.outsidePen === 0, r.outsidePen);
    ok('reset: nothing mid-consumption', r.notIdle === 0, r.notIdle);
    ok('reset: nothing has moved', r.moved === 0, r.moved);
    ok('reset: nothing still fleeing', r.fleeing === 0, r.fleeing);
    ok('reset: nothing still climbing', r.climbing === 0, r.climbing);
    ok('reset: nothing in water', r.inWater === 0, r.inWater);
    ok('reset: the population is intact', r.animals === built.count, r.animals);
    ok('reset: consumable positions match their spawn',
      st.animals.every((a) => Math.abs(a.c.position.x - a.x0) < 1e-9
        && Math.abs(a.c.position.z - a.z0) < 1e-9));
    ok('reset is idempotent', (() => {
      built.reset();
      const r2 = built.residue();
      return r2.moved === 0 && r2.notIdle === 0 && r2.outsidePen === 0;
    })());
  }

  /* --- 6. a monkey climbs a real prop, and comes down when it is eaten --- */
  {
    const c6 = mkCtx();
    // A registry that offers one climbable object wherever it is asked.
    const rock = {
      position: new THREE.Vector3(0, 0.17, 0),
      height: 1.6, radius: 0.9, kind: 'boulder', state: STATE.IDLE,
    };
    c6.registry.query = (x, z, r, out) => {
      out.length = 0;
      rock.position.set(x, 0.17, z);       // dead centre of whichever pen asks
      out.push(rock);
      return out;
    };
    const zoo6 = buildAnimals(c6);
    const s6 = zoo6._state;
    const monkeys = s6.animals.filter((a) => a.sp.key === 'monkey');
    ok('monkeys found a perch to climb', monkeys.length > 0 && !!monkeys[0].perches,
      monkeys.length);
    // Drive one onto it directly rather than waiting on the 10%/s dice roll.
    const mk = monkeys[0];
    mk.perch = mk.perches[0];
    mk.perchY = mk.perches[0].y;
    mk.perchT = 30;
    mk.x = mk.perches[0].x; mk.z = mk.perches[0].z;
    for (let i = 0; i < 120; i++) zoo6.update(1 / 30, []);
    ok('a monkey gets off the ground', mk.y > mk.baseY + 0.4, mk.y - mk.baseY);
    ok('and no higher than the thing it is standing on',
      mk.y <= mk.perchY + 0.12, `${mk.y} vs ${mk.perchY}`);
    // Now eat the rock out from under it.
    rock.state = STATE.GONE;
    for (let i = 0; i < 120; i++) zoo6.update(1 / 30, []);
    ok('the rock going down brings the monkey down with it',
      mk.climb === 0 && mk.y < mk.baseY + 0.12, `${mk.climb} / ${mk.y - mk.baseY}`);
    ok('and it never left its pen while climbing',
      s6.animals.every((a) => insidePen(a.pen, a.inset, a.x, a.z, 1e-3)));
  }

  /* --- 7. no zoo in the layout means no animals, and no crash ------------ */
  {
    const c2 = mkCtx();
    c2.layout.zoo = null;
    const empty = buildAnimals(c2);
    ok('a layout with no zoo builds nothing', empty.count === 0);
    ok('and its update is a safe no-op', (() => {
      empty.update(1 / 60, []); empty.update(1 / 60); empty.reset();
      return empty.residue().animals === 0;
    })());
  }

  return { failed, passed: results.length - failed, total: results.length, results };
}
