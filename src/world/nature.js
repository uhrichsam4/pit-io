/**
 * Nature + public space: every park, plaza, promenade, median and street tree
 * in Miami.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS BUILT THE WAY IT IS
 * ---------------------------------------------------------------------------
 * A city needs ~2,000 palms. The obvious implementation — one THREE.Group per
 * tree holding a trunk mesh and nine frond planes — costs ten draw calls per
 * tree and buries the renderer (that single mistake was ~3,300 of the project's
 * 5,200 draw calls). So:
 *
 *   1. ONE TEXTURE ATLAS.  Bark, crownshafts, fronds, canopies, flowers, water
 *      and flat swatches all live in a single 1024px canvas, which means a
 *      whole tree — trunk AND foliage — is one geometry with one material.
 *   2. ONE INSTANCED POOL PER SPECIES.  A species is one draw call for the
 *      entire map, and each instance is still individually swallowable because
 *      pools.js leases a real proxy mesh at capture time.
 *   3. MERGE EVERYTHING STATIC.  Lawns, paths, plaza paving, kerbs, court
 *      markings, steps and walls for all 216 blocks collapse into ~15 meshes.
 *
 * Measured cost of this module for the whole city: 145 draw calls, 365k
 * triangles, 5,939 instances. 129 of those calls are one instanced pool per
 * species VARIANT and 15 are the merged static ground — the variant count IS
 * the anti-repetition budget, and it is where the draw calls went. The
 * Group-of-meshes version this replaced cost about 3,300 draw calls on its own.
 *
 * ---------------------------------------------------------------------------
 * WIND
 * ---------------------------------------------------------------------------
 * Every foliage geometry carries an `aWind` vertex attribute and the shared
 * atlas material carries a vertex-shader sway (see `installWind`). It is free
 * at runtime, it makes 2,000 palms breathe, and it reuses the clock uniform
 * that groundShader.js already updates once a frame — no new per-frame hook.
 * A NEGATIVE aWind means "this is water": the same code path bobs it vertically
 * instead of leaning it sideways, which is how fountain basins ripple.
 *
 * ---------------------------------------------------------------------------
 * SURFACES
 * ---------------------------------------------------------------------------
 * Anything at ground level goes through materials.ground() (or applyHoleCut)
 * or the hole will not cut through it. That includes lawn, paving, mulch,
 * courts, kerbs, low walls and pond water.
 */

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { TIER, PALETTE, WORLD } from '../config.js';
import { makeRNG } from '../core/rng.js';
import { Textures, ground, foliage, painted } from '../core/materials.js';
import { applyHoleCut, holeUniforms } from '../render/groundShader.js';
import { ZONE, ROAD_CLASS } from './cityLayout.js';

/* ======================================================================== */
/*  SHARED CLOCK                                                            */
/* ======================================================================== */

/**
 * groundShader.js already pushes elapsed time into this uniform every frame.
 * Borrowing it means the wind and the water need no update callback at all.
 * Guarded so a refactor over there degrades to "no animation" rather than a
 * module-load crash.
 */
const TIME = (holeUniforms && holeUniforms.uTime) || { value: 0 };

/* ======================================================================== */
/*  ATLAS                                                                   */
/* ======================================================================== */

/**
 * 2048, not 1024.
 *
 * Every cell rect below is in ABSOLUTE canvas pixels and `uvOf` divides by
 * ATLAS, so growing the canvas leaves the existing cells at exactly the texel
 * density they were authored at and simply opens three empty quadrants. The
 * species list needed six more foliage cells (poinciana, jacaranda, croton,
 * groundcover, agave, a third frond) and there was not a spare pixel at 1024.
 * The cost is 16 MB of VRAM; the alternative — a second atlas — is a second
 * material and therefore a second draw call for every species that uses it.
 */
const ATLAS = 2048;

/**
 * Cell rectangles in canvas pixels [x, y, w, h].
 *
 * Layout rule: every OPAQUE cell lives in the bottom two rows of its quadrant,
 * packed against other opaque cells. Mip-chain bleed between neighbours is then
 * brown-into-brown instead of leaf-into-bark, which is the artefact you actually
 * notice.
 */
const CELL = {
  frondA: [0, 0, 512, 256],          // pinnate palm frond, sunlit
  frondB: [512, 0, 512, 256],        // pinnate palm frond, shaded + a torn tip
  fanA: [0, 256, 256, 256],          // costapalmate fan (sabal / washingtonia)
  shrubA: [256, 256, 256, 256],      // dense small-leaf shrub mass
  seagrape: [512, 256, 256, 256],    // big round coastal leaves
  grassTuft: [768, 256, 128, 256],   // ornamental grass
  coconut: [896, 256, 128, 256],     // fruit cluster
  canopyA: [0, 512, 256, 256],       // broadleaf canopy clump, mid green
  canopyB: [256, 512, 256, 256],     // broadleaf canopy clump, deeper green
  canopyPink: [512, 512, 256, 256],  // bougainvillea
  canopyYel: [768, 512, 256, 256],   // tabebuia
  barkRoyal: [0, 768, 128, 128],     // smooth pale concrete-grey ringed trunk
  barkCoco: [128, 768, 128, 128],    // brown, diagonal leaf scars
  barkFib: [256, 768, 128, 128],     // fibrous sabal boot
  crownshaft: [384, 768, 128, 128],  // the green sheath under a royal crown
  barkOak: [512, 768, 128, 128],     // furrowed hardwood
  waterDisc: [640, 768, 128, 128],   // still water with concentric ripples
  stoneTex: [768, 768, 128, 128],    // cast stone for basins and plinths
  mulchTex: [896, 768, 128, 128],    // bark mulch

  /* --- second quadrant: everything added for planting variety ----------- */
  frondC: [1024, 0, 512, 256],       // finer, limier pinnate frond (queen palm)
  frondD: [1536, 0, 512, 256],       // older frond: olive, drooping, tatty tips
  canopyRed: [1024, 256, 256, 256],  // royal poinciana in flower
  canopyPurple: [1280, 256, 256, 256], // jacaranda
  croton: [1536, 256, 256, 256],     // variegated red/orange/lime shrub
  groundcov: [1792, 256, 256, 256],  // low flowering mat
  agave: [1024, 512, 256, 256],      // spiky glaucous rosette
  canopyOlive: [1280, 512, 256, 256], // dark glossy inland canopy (mahogany)
  barkQueen: [1024, 768, 128, 128],  // smooth pale grey-green ringed trunk
  barkMang: [1152, 768, 128, 128],   // dark, wet mangrove bark

  /* --- third quadrant: SILHOUETTE contrast ------------------------------
   * Everything above is a round crown on a stick or a green dome. From the
   * game camera a city planted only out of those two shapes reads as one
   * repeated asset however much you jitter the scale, so this row is about
   * outlines that are not either: a shed-frond skirt, a stiff dark whorl at
   * ankle height, and a stack of upright banana paddles. */
  frondDead: [0, 1024, 512, 256],     // shed frond: tan, collapsed, half torn away
  cycad: [512, 1024, 256, 256],       // sago palm — narrow, dark, spine-stiff whorl
  paddle: [768, 1024, 256, 256],      // traveller's palm / bird of paradise blade
  hibiscus: [1024, 1024, 256, 256],   // glossy shrub carrying big coral trumpets

  /* --- fourth row: the two marks a city of royal palms has not got ---------
   * Every palm above tops out between 8 and 14 m and every plant in the file
   * is green, so a boulevard has ONE skyline and the whole map has ONE hue —
   * and those are the two similarities the eye actually catches, long before
   * it notices that two crowns have the same frond count. This row fixes both
   * with one new cell: a stiff glaucous fan for a Bismarckia (the only plant
   * in Miami that is silver), while the Washingtonia beside it just reuses
   * fanA on a trunk twice as tall as anything else on the street. */
  fanBlue: [1280, 1024, 256, 256],    // Bismarckia: near-circular silver-blue fan
};

/** Flat colour swatches, 64x128 each, along the bottom row. */
const SWATCH = [
  'leaf', 'leafDark', 'wood', 'cream', 'stone', 'coral', 'aqua', 'sun',
  'pink', 'white', 'sand', 'teal', 'magenta', 'terracotta', 'steel', 'shade',
];
const SWATCH_HEX = {
  leaf: PALETTE.TREE_CANOPY, leafDark: PALETTE.TREE_CANOPY_DARK,
  wood: PALETTE.WOOD_DECK, cream: PALETTE.CONCRETE_WARM,
  stone: PALETTE.CONCRETE_DARK, coral: PALETTE.STUCCO_CORAL,
  aqua: PALETTE.STUCCO_AQUA, sun: PALETTE.ACCENT_SUN,
  pink: PALETTE.FLOWER_PINK, white: PALETTE.STUCCO_WHITE,
  sand: PALETTE.SAND, teal: PALETTE.PATINA,
  magenta: PALETTE.FLOWER_MAGENTA, terracotta: PALETTE.TERRACOTTA,
  steel: PALETTE.STEEL, shade: PALETTE.MULCH,
};
for (let i = 0; i < SWATCH.length; i++) CELL[`sw_${SWATCH[i]}`] = [i * 64, 896, 64, 128];

/** Deterministic PRNG — the atlas must be byte-identical every boot. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rgbOf = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
const cssOf = (hex, a = 1) => {
  const c = rgbOf(hex);
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
};
const mixHex = (a, b, t) => {
  const x = rgbOf(a), y = rgbOf(b);
  return `rgb(${Math.round(x[0] + (y[0] - x[0]) * t)},${Math.round(x[1] + (y[1] - x[1]) * t)},${Math.round(x[2] + (y[2] - x[2]) * t)})`;
};
/** The same blend as an INT, for painters that need to mix again afterwards. */
const blendHex = (a, b, t) => {
  const x = rgbOf(a), y = rgbOf(b);
  return (Math.round(x[0] + (y[0] - x[0]) * t) << 16)
    | (Math.round(x[1] + (y[1] - x[1]) * t) << 8)
    | Math.round(x[2] + (y[2] - x[2]) * t);
};

/**
 * GLAUCOUS — the silver-blue of a Bismarck palm.
 *
 * Deliberately NOT a new invented colour, and deliberately not a per-instance
 * tint either: a tint is a MULTIPLY against the atlas, and multiplying a
 * saturated green can only ever darken it — there is no factor that turns
 * 0x4da457 into silver. The hue has to be painted into the cell.
 *
 * So it is derived: the three palm greens pulled most of the way to SEAWALL
 * (the warm grey the bay wall is already painted) and then nudged toward the
 * bay itself. Computed from PALETTE rather than typed as literals so it tracks
 * a regrade of the greens, and it stays inside the Miami palette while sitting
 * far enough off every other plant in the city to read from 200 m.
 */
const GLAUCOUS = {
  light: blendHex(blendHex(PALETTE.PALM_FROND_LIGHT, PALETTE.SEAWALL, 0.45),
    PALETTE.FLOWER_WHITE, 0.30),
  mid: blendHex(blendHex(PALETTE.PALM_FROND, PALETTE.SEAWALL, 0.55),
    PALETTE.SEA_SHALLOW, 0.25),
  dark: blendHex(blendHex(PALETTE.PALM_FROND_DARK, PALETTE.SEAWALL, 0.40),
    PALETTE.SEA_DEEP, 0.18),
};

/* ------------------------------------------------------- cell painters --- */

/**
 * Pinnate palm frond (royal, coconut, queen).
 *
 * Leaflets are FILLED polygons, not strokes: strokes vanish into the mip chain
 * and the crown turns to fog at 40 m. They taper, lean toward the tip, are
 * longest at mid-span, and a handful are torn off — that asymmetry is most of
 * what stops a procedural palm looking like a stencil.
 */
function drawFrond(g, rect, seed, light, mid, dark, torn) {
  const [X, Y, W, H] = rect;
  const rand = mulberry32(seed);
  const cy = Y + H * 0.5;
  const x0 = X + W * 0.02, x1 = X + W * 0.985;
  // Rachis: level at the base, drooping through the tip.
  const rach = (t) => cy - Math.sin(t * Math.PI * 0.72) * H * 0.10 + t * t * H * 0.13;

  const N = 40;
  for (let side = 0; side < 2; side++) {
    const dir = side === 0 ? -1 : 1;
    for (let i = 0; i < N; i++) {
      const t = (i + 0.5) / N;
      if (rand() < torn && t > 0.18 && t < 0.92) continue;
      const bx = x0 + (x1 - x0) * t;
      const by = rach(t);
      const len = (Math.pow(Math.sin(Math.PI * Math.pow(t, 0.86)), 0.72) * 0.40 + 0.04)
        * H * (0.90 + rand() * 0.26);
      const lean = 0.30 + t * 0.46;
      const tipX = bx + len * lean;
      const tipY = by + dir * len * (0.95 - t * 0.30);
      const wide = Math.max(2.4, len * 0.14);

      const sh = (side === 0 ? 0.0 : 0.40) + rand() * 0.36;
      g.fillStyle = sh < 0.42 ? mixHex(light, mid, sh / 0.42) : mixHex(mid, dark, (sh - 0.42) / 0.58);
      g.beginPath();
      g.moveTo(bx - wide * 0.3, by);
      g.quadraticCurveTo(
        bx + len * lean * 0.36 - dir * wide * 0.9, by + dir * len * 0.44, tipX, tipY
      );
      g.quadraticCurveTo(
        bx + len * lean * 0.36 + dir * wide * 0.9, by + dir * len * 0.40, bx + wide * 0.5, by
      );
      g.closePath();
      g.fill();
    }
  }

  /* Rachis on top — a solid spine keeps the frond readable when the leaflets
     minify away. */
  g.lineCap = 'round';
  for (let pass = 0; pass < 2; pass++) {
    g.strokeStyle = pass === 0 ? cssOf(dark, 0.92) : mixHex(mid, light, 0.5);
    g.lineWidth = pass === 0 ? H * 0.030 : H * 0.019;
    g.beginPath();
    for (let i = 0; i <= 32; i++) {
      const t = i / 32;
      const x = x0 + (x1 - x0) * t;
      const y = rach(t) + (pass === 0 ? H * 0.008 : 0);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }
}

/**
 * Costapalmate fan: segments radiating from a hinge at the bottom edge.
 *
 * Parameterised because the difference between a sabal and a Bismarckia is
 * entirely in these four numbers — the sabal is a two-thirds arc that tapers
 * to short wings, the Bismarckia is very nearly a full disc of equal-length
 * stiff segments — and painting a second near-copy of this function is how
 * two species end up drifting apart the first time the leaflet shape changes.
 */
function drawFan(g, rect, seed, {
  light = PALETTE.PALM_FROND_LIGHT,
  mid = PALETTE.PALM_FROND,
  dark = PALETTE.PALM_FROND_DARK,
  spread = Math.PI * 1.06,
  N = 26,
  base = 0.52,
  amp = 0.44,
} = {}) {
  const [X, Y, W, H] = rect;
  const rand = mulberry32(seed);
  const ox = X + W * 0.5, oy = Y + H * 0.99;
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) / N;
    const a = -Math.PI / 2 - spread / 2 + spread * t;
    // Longest at the crown of the fan, shorter at the two outer wings.
    const len = H * (base + amp * Math.sin(Math.PI * t)) * (0.92 + rand() * 0.16);
    const wide = len * 0.085;
    const sh = Math.abs(t - 0.42) * 1.5 + rand() * 0.3;
    g.fillStyle = sh < 0.45 ? mixHex(light, mid, sh / 0.45) : mixHex(mid, dark, Math.min(1, (sh - 0.45) / 0.55));
    const tx = ox + Math.cos(a) * len, ty = oy + Math.sin(a) * len;
    const px = -Math.sin(a) * wide, py = Math.cos(a) * wide;
    g.beginPath();
    g.moveTo(ox + px * 0.4, oy + py * 0.4);
    // Split tip — the notch is the giveaway that this is a fan palm.
    g.lineTo(tx + px * 1.2, ty + py * 1.2);
    g.lineTo(tx + Math.cos(a) * len * 0.10, ty + Math.sin(a) * len * 0.10);
    g.lineTo(tx - px * 1.2, ty - py * 1.2);
    g.lineTo(ox - px * 0.4, oy - py * 0.4);
    g.closePath();
    g.fill();
  }
  /* Hastula: the pale wedge where the segments meet the petiole. */
  g.fillStyle = mixHex(light, mid, 0.3);
  g.beginPath();
  g.ellipse(ox, oy, W * 0.10, H * 0.07, 0, Math.PI, 0);
  g.fill();
}

/**
 * A broadleaf canopy clump.
 *
 * Built as overlapping lobes of small leaf dabs rather than one disc: the
 * ragged silhouette is the entire difference between "tree" and "green ball".
 */
function drawCanopy(g, rect, seed, base, dark, light, flower, flowerP) {
  const [X, Y, W, H] = rect;
  const rand = mulberry32(seed);
  const cx = X + W * 0.5, cy = Y + H * 0.52;
  const R = Math.min(W, H) * 0.47;

  const lobes = [];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + rand() * 0.7;
    const d = R * (0.10 + rand() * 0.52);
    lobes.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d * 0.9, r: R * (0.34 + rand() * 0.26) });
  }
  lobes.push({ x: cx, y: cy, r: R * 0.62 });

  /* An OPAQUE core per lobe before any leaf is drawn.
     Coverage and detail are two different jobs and the scatter cannot do both.
     A mip chain averages alpha, so a crown whose interior is only just opaque
     at level 0 goes see-through by level 3 and the tree thins out as the camera
     pulls back; the core makes the interior opaque by construction. That in
     turn frees the dabs to be small — which is the actual fix here, because a
     banyan's canopy card is 16 m wide and dabs at the old 5.5-12.5% of the cell
     came out as 1-2 m leaves. See drawSeagrape for the full diagnosis. */
  /* A flowering tree's core takes some of the bloom colour. A poinciana in June
     is not a green tree with red dots on it, and the crown has to still read as
     RED from the skyline preset where the dabs have long since minified away. */
  const core = flower > 0
    ? blendHex(blendHex(dark, base, 0.66), flower, Math.min(0.62, flowerP * 0.78))
    : blendHex(dark, base, 0.66);
  for (const L of lobes) {
    g.fillStyle = cssOf(core);
    g.beginPath();
    g.ellipse(L.x, L.y, L.r * 0.78, L.r * 0.74, 0, 0, 6.29);
    g.fill();
  }

  for (const L of lobes) {
    // Count tracks AREA, not radius. It was linear in L.r, so the small lobes
    // were four times as densely leaved as the big ones and the crown had a
    // texture gradient across it that no real tree has.
    const n = Math.round(190 * (L.r / R) * (L.r / R));
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2;
      const d = Math.sqrt(rand()) * L.r;
      const px = L.x + Math.cos(a) * d;
      const py = L.y + Math.sin(a) * d;
      // Light falls from the top-left, so leaves high in the mass are brighter.
      const lit = 1 - (py - (cy - R)) / (2 * R);
      const k = Math.max(0, Math.min(1, lit * 0.9 + rand() * 0.35 - 0.1));
      let fill;
      if (flower > 0 && rand() < flowerP * (0.45 + lit)) {
        fill = mixHex(flower, PALETTE.FLOWER_WHITE, rand() * 0.35);
      } else {
        fill = k > 0.5 ? mixHex(base, light, (k - 0.5) * 1.5) : mixHex(dark, base, k * 2);
      }
      g.fillStyle = fill;
      const lr = R * (0.030 + rand() * 0.040);
      g.beginPath();
      g.ellipse(px, py, lr, lr * (0.60 + rand() * 0.4), rand() * 3.14, 0, 6.29);
      g.fill();
    }
  }
  /* Deep shadow pocket at the underside so the clump reads as a volume. */
  const sg = g.createRadialGradient(cx, cy + R * 0.42, R * 0.05, cx, cy + R * 0.35, R * 0.85);
  sg.addColorStop(0, cssOf(dark, 0.42));
  sg.addColorStop(1, cssOf(dark, 0));
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = sg;
  g.fillRect(X, Y, W, H);
  g.globalCompositeOperation = 'source-over';
}

/** Dense low shrub mass — flat-bottomed so it sits on the ground. */
function drawShrub(g, rect, seed) {
  const [X, Y, W, H] = rect;
  const rand = mulberry32(seed);
  const base = PALETTE.HEDGE, light = PALETTE.HEDGE_LIGHT, dark = PALETTE.TREE_CANOPY_DARK;
  for (let i = 0; i < 900; i++) {
    // Bias the mass into a dome that meets the bottom edge squarely.
    const u = rand(), v = Math.pow(rand(), 0.7);
    const px = X + W * (0.05 + u * 0.9);
    const dome = Math.sin(Math.PI * (0.05 + u * 0.9));
    const py = Y + H * (1.0 - v * (0.22 + dome * 0.74));
    const lit = 1 - (py - Y) / H;
    const k = Math.max(0, Math.min(1, lit * 1.1 + rand() * 0.35 - 0.15));
    g.fillStyle = k > 0.5 ? mixHex(base, light, (k - 0.5) * 1.6) : mixHex(dark, base, k * 2);
    const lr = W * (0.018 + rand() * 0.026);
    g.beginPath();
    g.ellipse(px, py, lr, lr * (0.55 + rand() * 0.5), rand() * 3.14, 0, 6.29);
    g.fill();
  }
}

/**
 * Sea grape: leathery round leaves with a red midrib. Reads instantly coastal.
 *
 * LEAF SCALE IS THE WHOLE PROBLEM HERE, and it is a texel-density bug, not a
 * drawing one. A cell is stretched across a card `canopyR * 2.05` wide, and a
 * sea grape's card is metres across — so the 46 discs this used to draw at
 * 5.5-11% of the cell width came out 0.7-1.4 m in the world. Every leaf on the
 * tree was the size of the pedestrian standing under it, and from four metres
 * the whole species read as a cabbage. (Screenshot: shots/nat-probe-keep.)
 *
 * So the leaves are drawn at 40% of that size and four times as many of them,
 * which puts them at ~0.4 m — a big leaf, still unmistakably a sea grape's,
 * but a LEAF. The count has to rise with the square of the size cut or the
 * crown goes lacy, and coverage cannot be left to the scatter alone: a mip
 * chain averages alpha down, so a crown that is only just opaque at level 0 is
 * see-through at level 3 and the tree flickers as the camera pulls back. An
 * opaque lobe core under the scatter fixes that by construction, and the
 * scatter is then free to be as fine as it likes because it is only ever
 * defining the FRINGE and the surface detail.
 */
function drawSeagrape(g, rect, seed) {
  const [X, Y, W, H] = rect;
  const rand = mulberry32(seed);
  const base = PALETTE.TREE_CANOPY, light = PALETTE.TREE_CANOPY_LIGHT, dark = PALETTE.TREE_CANOPY_DARK;
  // A sea grape is BROAD and flat-topped, not a ball. Three overlapping lobes
  // spread along the horizontal give it that habit before a leaf is drawn.
  const lobes = [];
  for (let i = 0; i < 4; i++) {
    const t = (i + 0.5) / 4;
    lobes.push({
      x: X + W * (0.14 + t * 0.72 + (rand() - 0.5) * 0.10),
      y: Y + H * (0.50 + (rand() - 0.5) * 0.20),
      rx: W * (0.19 + rand() * 0.08),
      ry: H * (0.20 + rand() * 0.07),
    });
  }
  // Opaque cores, inset from the lobe so the scatter still owns the outline.
  for (const L of lobes) {
    g.fillStyle = mixHex(dark, base, 0.72);
    g.beginPath();
    g.ellipse(L.x, L.y, L.rx * 0.74, L.ry * 0.74, 0, 0, 6.29);
    g.fill();
  }
  for (const L of lobes) {
    // Area-proportional: the count has to track the lobe or the big lobes go
    // thin and the small ones turn into solid blobs.
    const n = Math.round((L.rx * L.ry) / (W * H) * 2100);
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2;
      const d = Math.sqrt(rand());
      const px = L.x + Math.cos(a) * d * L.rx;
      const py = L.y + Math.sin(a) * d * L.ry;
      const r = W * (0.021 + rand() * 0.023);
      const lit = 1 - (py - (L.y - L.ry)) / (2 * L.ry);
      const k = Math.max(0, Math.min(1, lit * 0.95 + rand() * 0.3 - 0.12));
      /* The bronze flush of new growth at the ends of the shoots. It is the one
         marking that separates a sea grape from any other round-leaved shrub at
         a glance, and it only reads if it is confined to the OUTSIDE of the
         mass — a rusty leaf in the middle of the crown just looks dead. */
      const young = d > 0.72 && rand() < 0.30;
      g.fillStyle = young
        ? mixHex(PALETTE.RUST, PALETTE.FLOWER_ORANGE, rand() * 0.55)
        : (k > 0.5 ? mixHex(base, light, (k - 0.5) * 1.5) : mixHex(dark, base, k * 2));
      g.beginPath();
      g.ellipse(px, py, r, r * (0.82 + rand() * 0.16), rand() * 3.14, 0, 6.29);
      g.fill();
      // Midrib only on the leaves wide enough to carry one. On a 6 px disc a
      // 1 px line is not a vein, it is noise that greys the whole crown out.
      if (r > W * 0.032) {
        g.strokeStyle = cssOf(PALETTE.RUST, 0.42);
        g.lineWidth = Math.max(1, r * 0.13);
        g.beginPath(); g.moveTo(px, py + r * 0.72); g.lineTo(px, py - r * 0.62); g.stroke();
      }
    }
  }
}

/**
 * Croton: the loudest plant in Miami. Leathery paddle leaves splashed lime,
 * gold, orange and oxblood, all on one bush. It is the cheapest way to put
 * non-green colour at ankle height, which is exactly where a park reads as
 * planted rather than mown.
 */
function drawCroton(g, rect, seed) {
  const [X, Y, W, H] = rect;
  const rand = mulberry32(seed);
  const tones = [
    PALETTE.FLOWER_YELLOW, PALETTE.FLOWER_ORANGE, PALETTE.GRASS_LIGHT,
    PALETTE.RUST, PALETTE.TREE_CANOPY_DARK, PALETTE.CAR_RED,
  ];
  for (let i = 0; i < 120; i++) {
    const u = rand(), v = Math.pow(rand(), 0.62);
    const dome = Math.sin(Math.PI * (0.07 + u * 0.86));
    const px = X + W * (0.07 + u * 0.86);
    const py = Y + H * (1.0 - v * (0.12 + dome * 0.84));
    const len = H * (0.13 + rand() * 0.16);
    const wide = len * (0.24 + rand() * 0.12);
    // Leaves radiate outward from the middle of the mass, so the silhouette
    // spikes instead of reading as one soft blob.
    const a = Math.atan2(py - (Y + H), px - (X + W * 0.5)) + (rand() - 0.5) * 0.9;
    const lit = 1 - (py - Y) / H;
    const base = tones[(i + Math.floor(rand() * 3)) % tones.length];
    g.fillStyle = mixHex(base, lit > 0.55 ? PALETTE.FLOWER_WHITE : PALETTE.TREE_CANOPY_DARK,
      Math.abs(lit - 0.55) * 0.7);
    g.save();
    g.translate(px, py);
    g.rotate(a + Math.PI / 2);
    g.beginPath();
    g.moveTo(0, 0);
    g.quadraticCurveTo(-wide, -len * 0.55, 0, -len);
    g.quadraticCurveTo(wide, -len * 0.55, 0, 0);
    g.fill();
    // Yellow midrib — the giveaway marking on a croton leaf.
    g.strokeStyle = cssOf(PALETTE.FLOWER_YELLOW, 0.55);
    g.lineWidth = Math.max(1, wide * 0.22);
    g.beginPath(); g.moveTo(0, -len * 0.05); g.lineTo(0, -len * 0.9); g.stroke();
    g.restore();
  }
}

/**
 * Groundcover: a dense low mat of small leaves with flowers scattered through
 * it. Drawn FULL-BLEED to all four edges — a mat has no silhouette of its own,
 * it is only ever seen as a texture lying on the soil.
 */
function drawGroundcover(g, rect, seed) {
  const [X, Y, W, H] = rect;
  const rand = mulberry32(seed);
  const base = PALETTE.HEDGE, light = PALETTE.GRASS_LIGHT, dark = PALETTE.TREE_CANOPY_DARK;
  for (let i = 0; i < 700; i++) {
    const px = X + rand() * W, py = Y + rand() * H;
    const k = rand();
    g.fillStyle = k > 0.5 ? mixHex(base, light, (k - 0.5) * 1.7) : mixHex(dark, base, k * 2);
    const lr = W * (0.014 + rand() * 0.020);
    g.beginPath();
    g.ellipse(px, py, lr, lr * (0.7 + rand() * 0.5), rand() * 3.14, 0, 6.29);
    g.fill();
  }
  for (let i = 0; i < 70; i++) {
    const px = X + rand() * W, py = Y + rand() * H;
    const t = rand();
    g.fillStyle = cssOf(t < 0.4 ? PALETTE.FLOWER_WHITE
      : t < 0.75 ? PALETTE.FLOWER_PINK : PALETTE.FLOWER_YELLOW, 0.92);
    const r = W * (0.010 + rand() * 0.014);
    for (let p = 0; p < 5; p++) {
      const a = (p / 5) * 6.283;
      g.beginPath();
      g.ellipse(px + Math.cos(a) * r, py + Math.sin(a) * r, r * 0.72, r * 0.72, 0, 0, 6.29);
      g.fill();
    }
  }
}

/**
 * Agave / yucca rosette: stiff glaucous blades radiating from a point at the
 * bottom edge. A spiky silhouette in a city otherwise made of round crowns —
 * pure shape contrast, which is what the art bible asks planting to provide.
 */
function drawAgave(g, rect, seed) {
  const [X, Y, W, H] = rect;
  const rand = mulberry32(seed);
  const ox = X + W * 0.5, oy = Y + H * 0.98;
  const glauc = 0x9fc4a8, glaucD = 0x5f8a72, glaucL = 0xc8e0be;
  const N = 21;
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) / N;
    const a = -Math.PI / 2 - 1.28 + 2.56 * t + (rand() - 0.5) * 0.14;
    const len = H * (0.50 + 0.45 * Math.sin(Math.PI * t)) * (0.85 + rand() * 0.3);
    const wide = len * (0.075 + rand() * 0.03);
    const sh = Math.abs(t - 0.5) * 1.7 + rand() * 0.3;
    g.fillStyle = sh < 0.5 ? mixHex(glaucL, glauc, sh / 0.5)
      : mixHex(glauc, glaucD, Math.min(1, (sh - 0.5) / 0.5));
    const tx = ox + Math.cos(a) * len, ty = oy + Math.sin(a) * len;
    const px = -Math.sin(a) * wide, py = Math.cos(a) * wide;
    g.beginPath();
    g.moveTo(ox + px, oy + py);
    g.lineTo(tx, ty);                       // a blade ends in a single spine
    g.lineTo(ox - px, oy - py);
    g.closePath();
    g.fill();
    // Rust-coloured terminal spine.
    g.strokeStyle = cssOf(PALETTE.RUST, 0.8);
    g.lineWidth = Math.max(1, wide * 0.35);
    g.beginPath();
    g.moveTo(tx - Math.cos(a) * len * 0.09, ty - Math.sin(a) * len * 0.09);
    g.lineTo(tx, ty);
    g.stroke();
  }
}

/** Ornamental grass: a fan of thin arcing blades. */
function drawGrassTuft(g, rect, seed) {
  const [X, Y, W, H] = rect;
  const rand = mulberry32(seed);
  const ox = X + W * 0.5, oy = Y + H * 0.99;
  for (let i = 0; i < 70; i++) {
    const a = -Math.PI / 2 + (rand() - 0.5) * 1.5;
    const len = H * (0.42 + rand() * 0.55);
    const bend = (rand() - 0.5) * W * 0.55;
    const t = rand();
    g.strokeStyle = t < 0.3 ? cssOf(PALETTE.GRASS_DRY, 0.95)
      : t < 0.7 ? cssOf(PALETTE.GRASS, 0.95) : cssOf(PALETTE.GRASS_LIGHT, 0.95);
    g.lineWidth = Math.max(1.4, W * 0.016 * (0.6 + rand()));
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(ox + (rand() - 0.5) * W * 0.2, oy);
    g.quadraticCurveTo(
      ox + Math.cos(a) * len * 0.5, oy + Math.sin(a) * len * 0.6,
      ox + Math.cos(a) * len * 0.7 + bend, oy + Math.sin(a) * len
    );
    g.stroke();
  }
}

/**
 * ONE sago-palm leaf, hinged at the bottom edge and running up the cell.
 *
 * A whole cell of leaves — the way `fanA` is painted — is wrong for this plant:
 * `makeWhorl` places every leaf as its own strip so the whorl has real
 * three-dimensional spread, and a cell that already contained a whorl would
 * give a whorl of whorls. Same reason `frondA` is one frond.
 *
 * Almost black-green, dead straight, needle-fine leaflets: the exact opposite
 * of every soft round crown in this atlas, which is the entire point of it.
 */
function drawCycad(g, rect, seed) {
  const [X, Y, W, H] = rect;
  const rand = mulberry32(seed);
  const ox = X + W * 0.5, oy = Y + H * 0.985, ty = Y + H * 0.02;
  const dark = 0x1d4529, mid = 0x2f6b39, lit = 0x6aab55;
  // Rachis: a shallow S so the leaf arches instead of standing to attention.
  const spine = (t) => [ox + Math.sin(t * 2.1) * W * 0.055, oy + (ty - oy) * t];
  const teeth = 34;
  for (let k = 1; k <= teeth; k++) {
    const t = k / teeth;
    const [bx, by] = spine(t);
    // Longest at mid-leaf, collapsing to a point at the tip.
    const tl = W * 0.34 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.06)), 0.55);
    for (const s of [-1, 1]) {
      const sh = (s < 0 ? 0.15 : 0.55) + rand() * 0.3;
      g.strokeStyle = sh < 0.5 ? mixHex(lit, mid, sh / 0.5)
        : mixHex(mid, dark, Math.min(1, (sh - 0.5) / 0.5));
      g.lineWidth = Math.max(1.6, W * 0.014);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(bx, by);
      // Leaflets comb backward toward the base, which is what makes a cycad
      // read as a feather rather than as a fishbone.
      g.lineTo(bx + s * tl, by + tl * 0.42);
      g.stroke();
    }
  }
  g.strokeStyle = mixHex(mid, dark, 0.4);
  g.lineWidth = Math.max(2, W * 0.022);
  g.beginPath();
  for (let k = 0; k <= 16; k++) {
    const [px, py] = spine(k / 16);
    if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
  }
  g.stroke();
}

/**
 * ONE banana paddle — traveller's palm, bird of paradise, heliconia.
 *
 * Hinged at the bottom edge, blade running up the cell. The wind tears are not
 * decoration: an untorn paddle is a green rectangle, and a green rectangle in
 * a park is a billboard nobody believes.
 */
function drawPaddle(g, rect, seed) {
  const [X, Y, W, H] = rect;
  const rand = mulberry32(seed);
  const ox = X + W * 0.5, oy = Y + H * 0.99, top = Y + H * 0.015;
  const base = PALETTE.TREE_CANOPY, dark = PALETTE.TREE_CANOPY_DARK, light = PALETTE.GRASS_LIGHT;
  const rib = (t) => oy + (top - oy) * t;
  // Petiole for the first fifth, then the blade opens.
  const halfW = (t) => (t < 0.20 ? W * 0.035
    : W * 0.42 * Math.pow(Math.sin(Math.PI * Math.min(1, (t - 0.18) / 0.86)), 0.62));

  const gr = g.createLinearGradient(X, 0, X + W, 0);
  gr.addColorStop(0, mixHex(base, dark, 0.55));
  gr.addColorStop(0.38, mixHex(light, base, 0.35));
  gr.addColorStop(1, mixHex(base, dark, 0.75));
  g.fillStyle = gr;
  g.beginPath();
  for (let k = 0; k <= 24; k++) { const t = k / 24; g.lineTo(ox - halfW(t), rib(t)); }
  for (let k = 24; k >= 0; k--) { const t = k / 24; g.lineTo(ox + halfW(t), rib(t)); }
  g.closePath();
  g.fill();

  // Tears: cut clean back to the midrib, alternating sides at random spacing.
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = '#000';
  for (let k = 0; k < 13; k++) {
    const t = 0.24 + rand() * 0.72;
    const s = rand() < 0.5 ? -1 : 1;
    const w = W * (0.012 + rand() * 0.020);
    const depth = halfW(t) * (0.45 + rand() * 0.55);
    g.beginPath();
    g.moveTo(ox + s * halfW(t), rib(t) - w);
    g.lineTo(ox + s * halfW(t), rib(t) + w);
    g.lineTo(ox + s * (halfW(t) - depth), rib(t) + w * 0.3);
    g.closePath();
    g.fill();
  }
  g.globalCompositeOperation = 'source-over';

  // Midrib and the lateral veins that make the tears look inevitable.
  g.strokeStyle = cssOf(light, 0.55);
  g.lineWidth = Math.max(2, W * 0.020);
  g.beginPath(); g.moveTo(ox, oy); g.lineTo(ox, top); g.stroke();
  g.lineWidth = Math.max(1, W * 0.007);
  g.strokeStyle = cssOf(dark, 0.35);
  for (let k = 0; k < 26; k++) {
    const t = 0.20 + (k / 26) * 0.78;
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(ox, rib(t));
      g.lineTo(ox + s * halfW(t), rib(t) + H * 0.030);
      g.stroke();
    }
  }
}

/**
 * A flowering shrub mass — hibiscus, ixora, plumbago.
 *
 * drawShrub with blooms would have done, except that a hibiscus flower is
 * 15 cm across on a 1.5 m bush: at that ratio the flowers have to be drawn as
 * discrete discs sitting proud of the leaf mass, not as recoloured leaf dabs,
 * or they average away into a muddy olive the moment the mip chain starts.
 */
function drawFlowerShrub(g, rect, seed, bloom) {
  const [X, Y, W, H] = rect;
  const rand = mulberry32(seed);
  const base = PALETTE.TREE_CANOPY_DARK, light = PALETTE.HEDGE, dark = 0x1d4a2b;
  const dome = (u) => Math.sin(Math.PI * (0.05 + u * 0.9));
  for (let i = 0; i < 820; i++) {
    const u = rand(), v = Math.pow(rand(), 0.7);
    const px = X + W * (0.05 + u * 0.9);
    const py = Y + H * (1.0 - v * (0.20 + dome(u) * 0.76));
    const k = Math.max(0, Math.min(1, (1 - (py - Y) / H) * 1.1 + rand() * 0.32 - 0.14));
    g.fillStyle = k > 0.5 ? mixHex(base, light, (k - 0.5) * 1.7) : mixHex(dark, base, k * 2);
    const lr = W * (0.020 + rand() * 0.028);
    g.beginPath();
    g.ellipse(px, py, lr, lr * (0.6 + rand() * 0.5), rand() * 3.14, 0, 6.29);
    g.fill();
  }
  for (let i = 0; i < 34; i++) {
    const u = rand(), v = Math.pow(rand(), 0.5);
    const px = X + W * (0.08 + u * 0.84);
    const py = Y + H * (1.0 - v * (0.24 + dome(u) * 0.70));
    const r = W * (0.032 + rand() * 0.020);
    // Five overlapping petals round a pale eye — a trumpet flower seen face on.
    g.fillStyle = mixHex(bloom, PALETTE.FLOWER_WHITE, rand() * 0.30);
    for (let p = 0; p < 5; p++) {
      const a = (p / 5) * 6.283 + rand() * 0.2;
      g.beginPath();
      g.ellipse(px + Math.cos(a) * r * 0.62, py + Math.sin(a) * r * 0.62,
        r * 0.62, r * 0.52, a, 0, 6.29);
      g.fill();
    }
    g.fillStyle = cssOf(PALETTE.FLOWER_YELLOW, 0.95);
    g.beginPath(); g.ellipse(px, py, r * 0.24, r * 0.24, 0, 0, 6.29); g.fill();
  }
}

/** Coconut cluster hanging under a crown. */
function drawCoconuts(g, rect, seed) {
  const [X, Y, W, H] = rect;
  const rand = mulberry32(seed);
  for (let i = 0; i < 9; i++) {
    const px = X + W * (0.28 + rand() * 0.44);
    const py = Y + H * (0.16 + rand() * 0.42);
    const r = W * (0.13 + rand() * 0.07);
    g.fillStyle = rand() < 0.4 ? mixHex(PALETTE.GRASS_DRY, PALETTE.WOOD_DARK, 0.4)
      : mixHex(PALETTE.PALM_FROND_DARK, PALETTE.WOOD_DARK, 0.45);
    g.beginPath(); g.ellipse(px, py, r, r * 1.12, 0, 0, 6.29); g.fill();
    g.fillStyle = 'rgba(255,248,226,0.28)';
    g.beginPath(); g.ellipse(px - r * 0.3, py - r * 0.35, r * 0.38, r * 0.30, 0, 0, 6.29); g.fill();
  }
  /* The stalk they hang from. */
  g.strokeStyle = cssOf(PALETTE.WOOD_DARK, 0.9);
  g.lineWidth = W * 0.05;
  g.beginPath(); g.moveTo(X + W * 0.5, Y + H * 0.02); g.lineTo(X + W * 0.5, Y + H * 0.35); g.stroke();
}

/**
 * A trunk bark strip. `kind` picks the species language:
 *   'royal' smooth pale grey with faint growth rings
 *   'coco'  brown with diagonal leaf scars
 *   'fib'   criss-cross fibrous sabal boot
 *   'oak'   deep vertical furrows
 */
function drawBark(g, rect, kind, seed) {
  const [X, Y, W, H] = rect;
  const rand = mulberry32(seed);
  // Warm, mid-value barks. Authored light they blow out under the 3.5x key and
  // the palms turn into white poles — which is exactly what happened the first
  // time round.
  const spec = {
    royal: { base: 0xa89a84, dark: 0x796d5c, light: 0xc6bba6 },
    coco: { base: PALETTE.PALM_TRUNK_DARK, dark: 0x5c462d, light: PALETTE.PALM_TRUNK },
    fib: { base: 0x8a6e49, dark: 0x5b4629, light: 0xa98a5c },
    oak: { base: 0x8e7d66, dark: 0x574a35, light: 0xa89881 },
    queen: { base: 0x9c9c86, dark: 0x6b6b58, light: 0xbcbca4 },
    mang: { base: 0x6f5a45, dark: 0x403325, light: 0x8f7a60 },
  }[kind];

  g.fillStyle = cssOf(spec.base);
  g.fillRect(X, Y, W, H);

  /* Cylindrical shading: the strip wraps a tube, so the left and right
     eighths are the silhouette edges and must go dark. */
  const shade = g.createLinearGradient(X, 0, X + W, 0);
  shade.addColorStop(0.00, cssOf(spec.dark, 0.85));
  shade.addColorStop(0.22, cssOf(spec.light, 0.30));
  shade.addColorStop(0.55, cssOf(spec.base, 0.0));
  shade.addColorStop(1.00, cssOf(spec.dark, 0.92));
  g.fillStyle = shade;
  g.fillRect(X, Y, W, H);

  if (kind === 'royal' || kind === 'queen') {
    for (let i = 0; i < 22; i++) {
      const y = Y + (i + rand() * 0.6) * (H / 22);
      g.strokeStyle = cssOf(spec.dark, 0.16 + rand() * 0.14);
      g.lineWidth = 1 + rand() * 1.6;
      g.beginPath(); g.moveTo(X, y); g.lineTo(X + W, y + (rand() - 0.5) * 2); g.stroke();
      g.strokeStyle = cssOf(spec.light, 0.16);
      g.beginPath(); g.moveTo(X, y + 2); g.lineTo(X + W, y + 2); g.stroke();
    }
  } else if (kind === 'coco') {
    for (let i = 0; i < 16; i++) {
      const y = Y + (i + 0.3) * (H / 16);
      g.strokeStyle = cssOf(spec.dark, 0.45);
      g.lineWidth = 2.2;
      g.beginPath(); g.moveTo(X, y); g.lineTo(X + W, y - H * 0.035); g.stroke();
      g.strokeStyle = cssOf(spec.light, 0.30);
      g.beginPath(); g.moveTo(X, y + 2.6); g.lineTo(X + W, y - H * 0.035 + 2.6); g.stroke();
    }
  } else if (kind === 'fib') {
    for (let i = 0; i < 70; i++) {
      const y = Y + rand() * H;
      const x = X + rand() * W;
      const l = 5 + rand() * 16;
      g.strokeStyle = rand() < 0.5 ? cssOf(spec.dark, 0.4) : cssOf(spec.light, 0.32);
      g.lineWidth = 1 + rand() * 1.8;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + (rand() - 0.5) * l, y + (rand() < 0.5 ? -1 : 1) * l);
      g.stroke();
    }
  } else {
    for (let i = 0; i < 14; i++) {
      const x = X + (i + rand() * 0.7) * (W / 14);
      g.strokeStyle = cssOf(spec.dark, 0.35 + rand() * 0.2);
      g.lineWidth = 1.4 + rand() * 2.6;
      g.beginPath();
      g.moveTo(x, Y);
      for (let k = 1; k <= 5; k++) g.lineTo(x + (rand() - 0.5) * 5, Y + (H / 5) * k);
      g.stroke();
    }
  }
}

/** Green crownshaft sheath (the smooth column under a royal palm crown). */
function drawCrownshaft(g, rect) {
  const [X, Y, W, H] = rect;
  const grad = g.createLinearGradient(X, 0, X + W, 0);
  grad.addColorStop(0.00, cssOf(PALETTE.PALM_FROND_DARK));
  grad.addColorStop(0.30, cssOf(PALETTE.PALM_FROND));
  grad.addColorStop(0.55, cssOf(PALETTE.PALM_FROND_LIGHT));
  grad.addColorStop(1.00, cssOf(PALETTE.TREE_CANOPY_DARK));
  g.fillStyle = grad;
  g.fillRect(X, Y, W, H);
  const fade = g.createLinearGradient(0, Y, 0, Y + H);
  fade.addColorStop(0, cssOf(PALETTE.GRASS_DRY, 0.32));   // sun-bleached top
  fade.addColorStop(1, cssOf(PALETTE.TREE_CANOPY_DARK, 0.30));
  g.fillStyle = fade;
  g.fillRect(X, Y, W, H);
}

/** Still water with concentric ripple rings, for fountain bowls. */
function drawWaterCell(g, rect) {
  const [X, Y, W, H] = rect;
  const cx = X + W / 2, cy = Y + H / 2;
  const grad = g.createRadialGradient(cx, cy, 0, cx, cy, W * 0.72);
  grad.addColorStop(0.0, cssOf(PALETTE.SEA_SHALLOW));
  grad.addColorStop(0.6, cssOf(PALETTE.WATER_POOL));
  grad.addColorStop(1.0, cssOf(PALETTE.SEA_DEEP));
  g.fillStyle = grad;
  g.fillRect(X, Y, W, H);
  for (let i = 1; i < 11; i++) {
    g.strokeStyle = `rgba(255,255,255,${0.05 + (i % 2) * 0.08})`;
    g.lineWidth = 1.6;
    g.beginPath(); g.arc(cx, cy, (i / 11) * W * 0.52, 0, 6.29); g.stroke();
  }
  g.fillStyle = cssOf(PALETTE.WATER_WAKE, 0.35);
  g.beginPath(); g.ellipse(cx - W * 0.16, cy - H * 0.18, W * 0.14, H * 0.06, -0.5, 0, 6.29); g.fill();
}

/** Cast stone with a fine aggregate speckle. */
function drawStoneCell(g, rect, seed, hex) {
  const [X, Y, W, H] = rect;
  const rand = mulberry32(seed);
  g.fillStyle = cssOf(hex);
  g.fillRect(X, Y, W, H);
  for (let i = 0; i < 2200; i++) {
    const a = 0.03 + rand() * 0.09;
    g.fillStyle = rand() < 0.5 ? `rgba(255,250,238,${a})` : `rgba(96,86,70,${a})`;
    g.fillRect(X + rand() * W, Y + rand() * H, 1 + rand() * 2, 1 + rand() * 2);
  }
}

/** Bark mulch: coarse dark chips. */
function drawMulchCell(g, rect, seed) {
  const [X, Y, W, H] = rect;
  const rand = mulberry32(seed);
  g.fillStyle = cssOf(PALETTE.MULCH);
  g.fillRect(X, Y, W, H);
  for (let i = 0; i < 420; i++) {
    const t = rand();
    g.fillStyle = t < 0.4 ? cssOf(PALETTE.WOOD_DARK, 0.8)
      : t < 0.75 ? cssOf(PALETTE.DIRT, 0.55) : cssOf(PALETTE.WOOD_DECK, 0.35);
    g.save();
    g.translate(X + rand() * W, Y + rand() * H);
    g.rotate(rand() * 3.14);
    g.fillRect(-3 - rand() * 4, -1, 6 + rand() * 8, 2 + rand() * 2);
    g.restore();
  }
}

/**
 * Bleed opaque colour outward into the transparent margin.
 *
 * Alpha-tested foliage on a canvas cleared to rgba(0,0,0,0) gets a black
 * fringe the moment mipmapping kicks in, because the filter averages the
 * invisible black pixels in. Dilating the colour (while leaving alpha alone)
 * is the standard fix and it is the single largest quality win in this file.
 *
 * Scoped to ONE CELL, not the whole canvas. This is O(area x 9 x iterations)
 * in plain JS on the main thread during world build, and the atlas has since
 * gone to 2048 — dilating all 4.2 M pixels four times over is ~150 M ops and
 * a visible boot stall, for a result that is identical, because every opaque
 * cell (bark, stone, mulch, swatches) has no transparent margin to bleed into.
 */
function dilateCell(gctx, rect, iterations) {
  const pad = iterations + 1;
  const X = Math.max(0, rect[0] - pad), Y = Math.max(0, rect[1] - pad);
  const W = Math.min(ATLAS - X, rect[2] + pad * 2);
  const H = Math.min(ATLAS - Y, rect[3] + pad * 2);
  const img = gctx.getImageData(X, Y, W, H);
  const d = img.data;
  for (let pass = 0; pass < iterations; pass++) {
    const src = new Uint8ClampedArray(d);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        if (src[o + 3] > 8) continue;
        let r = 0, g2 = 0, b = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= W) continue;
            const p = (yy * W + xx) * 4;
            if (src[p + 3] <= 8 && !(src[p] | src[p + 1] | src[p + 2])) continue;
            r += src[p]; g2 += src[p + 1]; b += src[p + 2]; n++;
          }
        }
        if (!n) continue;
        d[o] = r / n; d[o + 1] = g2 / n; d[o + 2] = b / n;
      }
    }
  }
  gctx.putImageData(img, X, Y);
}

/**
 * Which cells are CUTOUT foliage.
 *
 * Two jobs, and they must not drift apart: these are the cells that need alpha
 * dilation, and they are the cells whose vertices carry `aTint = 1` so the
 * per-instance colour lands on leaves and not on bark, stone or water. One
 * table, so adding a species cannot half-wire it.
 */
const CUTOUT_CELLS = new Set([
  'frondA', 'frondB', 'frondC', 'frondD', 'fanA', 'fanBlue', 'shrubA', 'seagrape',
  'grassTuft', 'coconut', 'canopyA', 'canopyB', 'canopyPink', 'canopyYel',
  'canopyRed', 'canopyPurple', 'canopyOlive', 'croton', 'groundcov', 'agave',
  'frondDead', 'cycad', 'paddle', 'hibiscus',
]);

/**
 * Costapalmate cells are painted radiating UP the cell from a hinge on its
 * bottom edge, so their long axis is v and not u — `frondGeo` has to be told
 * with `alongV`. One set rather than a literal comparison at the call site,
 * because a fan species wired up without it renders its blades with the
 * texture turned 90 degrees, which looks like a broken atlas and not like a
 * missing flag.
 */
const FAN_CELLS = new Set(['fanA', 'fanBlue']);

/** Cells whose colour the per-instance foliage tint is allowed to touch. */
const TINTABLE_CELLS = new Set([...CUTOUT_CELLS, 'crownshaft', 'sw_leaf', 'sw_leafDark']);
// A coconut is brown fruit hanging in a green crown; tinting it with the fronds
// turns a ripe nut lime. A shed frond is the same problem: the skirt is the one
// part of a sabal that is NOT the colour of its crown, and that contrast is the
// whole reason it is there.
TINTABLE_CELLS.delete('coconut');
TINTABLE_CELLS.delete('frondDead');

let _atlasTex = null;

function atlasTexture() {
  if (_atlasTex) return _atlasTex;
  const c = document.createElement('canvas');
  c.width = c.height = ATLAS;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.clearRect(0, 0, ATLAS, ATLAS);

  drawFrond(g, CELL.frondA, 0x0fa17e, PALETTE.PALM_FROND_LIGHT, PALETTE.PALM_FROND, PALETTE.PALM_FROND_DARK, 0.04);
  drawFrond(g, CELL.frondB, 0x77c210, PALETTE.PALM_FROND, PALETTE.PALM_FROND_DARK, PALETTE.TREE_CANOPY_DARK, 0.09);
  drawFan(g, CELL.fanA, 0x31ab77);
  drawShrub(g, CELL.shrubA, 0x5b2d91);
  drawSeagrape(g, CELL.seagrape, 0x1188cd);
  drawGrassTuft(g, CELL.grassTuft, 0x4411aa);
  drawCoconuts(g, CELL.coconut, 0x9d0a11);
  drawCanopy(g, CELL.canopyA, 0x2c71b3, PALETTE.TREE_CANOPY, PALETTE.TREE_CANOPY_DARK, PALETTE.TREE_CANOPY_LIGHT, 0, 0);
  drawCanopy(g, CELL.canopyB, 0x81aa22, PALETTE.HEDGE, PALETTE.TREE_CANOPY_DARK, PALETTE.GRASS_LIGHT, 0, 0);
  drawCanopy(g, CELL.canopyPink, 0x51fa3b, PALETTE.TREE_CANOPY, PALETTE.TREE_CANOPY_DARK, PALETTE.TREE_CANOPY_LIGHT, PALETTE.FLOWER_MAGENTA, 0.62);
  drawCanopy(g, CELL.canopyYel, 0xa0be71, PALETTE.TREE_CANOPY, PALETTE.TREE_CANOPY_DARK, PALETTE.GRASS_LIGHT, PALETTE.FLOWER_YELLOW, 0.68);

  /* The second quadrant: planting variety. Poinciana and jacaranda are the two
     trees that actually make a Miami street look like Miami in June, and a
     croton bed does more for ground-level colour than another hedge run. */
  drawFrond(g, CELL.frondC, 0x2ba9c4, PALETTE.GRASS_LIGHT, PALETTE.PALM_FROND, PALETTE.PALM_FROND_DARK, 0.06);
  drawFrond(g, CELL.frondD, 0x5e3f11, PALETTE.GRASS_DRY, PALETTE.PALM_FROND_DARK, PALETTE.TREE_CANOPY_DARK, 0.16);
  drawCanopy(g, CELL.canopyRed, 0x77ee31, PALETTE.TREE_CANOPY, PALETTE.TREE_CANOPY_DARK, PALETTE.GRASS_LIGHT, PALETTE.CAR_RED, 0.72);
  drawCanopy(g, CELL.canopyPurple, 0x1f5ea8, PALETTE.HEDGE, PALETTE.TREE_CANOPY_DARK, PALETTE.TREE_CANOPY_LIGHT, PALETTE.ACCENT_LILAC, 0.70);
  drawCanopy(g, CELL.canopyOlive, 0x9c3b7f, PALETTE.TREE_CANOPY_DARK, 0x24512c, PALETTE.TREE_CANOPY, 0, 0);
  drawCroton(g, CELL.croton, 0x6ad219);
  drawGroundcover(g, CELL.groundcov, 0x18b3f0);
  drawAgave(g, CELL.agave, 0x3f77d1);

  /* Third quadrant. The shed frond is deliberately painted from the DRY end of
     the palette — straw over rust over dark wood — because a skirt that is
     merely a darker green just reads as shadow. */
  drawFrond(g, CELL.frondDead, 0x0d4b21, PALETTE.GRASS_DRY, PALETTE.RUST, PALETTE.WOOD_DARK, 0.30);
  drawCycad(g, CELL.cycad, 0x5ac311);
  drawPaddle(g, CELL.paddle, 0x2b7ff1);
  drawFlowerShrub(g, CELL.hibiscus, 0x91d40b, PALETTE.CAR_RED);
  /* The Bismarckia fan. The hinge is on the cell's bottom edge — frondGeo maps
     v along the blade from its attachment point — so the arc cannot open much
     past a half turn without running off the cell. What makes it read as the
     stiff DISC a Bismarckia carries, rather than as a pale sabal, is therefore
     the segment LENGTHS: near-equal all the way to the wings (high base, low
     amp) and a third more of them. */
  drawFan(g, CELL.fanBlue, 0x6fd3a1, {
    light: GLAUCOUS.light, mid: GLAUCOUS.mid, dark: GLAUCOUS.dark,
    spread: Math.PI * 1.10, N: 34, base: 0.76, amp: 0.22,
  });

  drawBark(g, CELL.barkRoyal, 'royal', 0x1a2b3c);
  drawBark(g, CELL.barkCoco, 'coco', 0x2b3c4d);
  drawBark(g, CELL.barkFib, 'fib', 0x3c4d5e);
  drawCrownshaft(g, CELL.crownshaft);
  drawBark(g, CELL.barkOak, 'oak', 0x4d5e6f);
  drawBark(g, CELL.barkQueen, 'queen', 0x5e6f70);
  drawBark(g, CELL.barkMang, 'mang', 0x6f7081);
  drawWaterCell(g, CELL.waterDisc);
  drawStoneCell(g, CELL.stoneTex, 0x7711aa, PALETTE.CONCRETE_WARM);
  drawMulchCell(g, CELL.mulchTex, 0x22ccdd);

  for (const name of SWATCH) {
    const [X, Y, W, H] = CELL[`sw_${name}`];
    const hex = SWATCH_HEX[name];
    g.fillStyle = cssOf(hex);
    g.fillRect(X, Y, W, H);
    // A vertical shade ramp so even flat-coloured parts get a little form.
    const gr = g.createLinearGradient(X, 0, X + W, 0);
    gr.addColorStop(0, 'rgba(0,0,0,0.14)');
    gr.addColorStop(0.4, 'rgba(255,255,255,0.10)');
    gr.addColorStop(1, 'rgba(0,0,0,0.16)');
    g.fillStyle = gr;
    g.fillRect(X, Y, W, H);
  }

  for (const name of CUTOUT_CELLS) dilateCell(g, CELL[name], 4);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  _atlasTex = t;
  return t;
}

/**
 * UV rect for a cell, inset so the mip chain cannot pull in a neighbour.
 *
 * The rect carries its own `name` so `mapUV` can tag the geometry as foliage or
 * structure without every call site having to repeat it. Cached: this is called
 * once per frond of every variant of every species, and it allocated a fresh
 * object each time.
 */
const _uvCache = new Map();
function uvOf(name) {
  let r = _uvCache.get(name);
  if (r) return r;
  const [x, y, w, h] = CELL[name];
  const p = 2.5;
  r = {
    name,
    u0: (x + p) / ATLAS,
    u1: (x + w - p) / ATLAS,
    // Canvas y grows down; CanvasTexture flips, so v is measured from the base.
    v0: 1 - (y + h - p) / ATLAS,
    v1: 1 - (y + p) / ATLAS,
  };
  _uvCache.set(name, r);
  return r;
}

/* ======================================================================== */
/*  MATERIALS                                                               */
/* ======================================================================== */

/**
 * Live signals the foliage shader reads. All four are pushed once a frame by
 * the sentinel in `installClock` — see there for why a mesh callback and not a
 * game-loop hook.
 */
const NAT = {
  /** 0 = full day, 1 = full night. Straight from scene.userData.nightFactor. */
  uNatNight: { value: 0 },
  /** xyz = the player's hole, w = its radius. w < 0 disables the corridor. */
  uNatHole: { value: new THREE.Vector4(0, 0, 0, -1) },
  /** Warm ground-uplight bounce; cool light for water and lamp glass. */
  uNatWarm: { value: new THREE.Color(PALETTE.LAMP_GLOW) },
  uNatCool: { value: new THREE.Color(PALETTE.SEA_SHALLOW) },
};

/**
 * The foliage shader: wind, per-instance leaf tint, night uplighting, and the
 * camera corridor.
 *
 * WIND. `aWind` >= 0 is foliage: lean and flutter in the horizontal plane,
 * weighted by how far the vertex is from the trunk and how high it sits.
 * `aWind` < 0 is water: bob vertically with a small ring ripple instead.
 * Phase comes from the instance's own world origin, so no two trees in the
 * city are in step.
 *
 * LEAF TINT. Every nature pool carries an instance colour and three multiplies
 * it into `vColor` for free — but a tree is trunk AND crown in ONE geometry, so
 * an unguarded instance colour turns bark lime. `aTint` is 1 only on vertices
 * whose atlas cell is foliage (see CUTOUT_CELLS), so the tint lands on leaves
 * and the trunk stays the colour the bark texture says it is. That is what buys
 * per-individual crown colour at zero extra draw calls, which is most of the
 * answer to "the palms all look the same".
 *
 * NIGHT. `aGlow` is authored per vertex: positive means "this surface catches a
 * warm uplight from the ground" (the lower trunk, the underside of a crown),
 * negative means "this surface IS a light" (fountain water, a lamp globe).
 * Magnitude is the strength, and the whole term is scaled by nightFactor, so it
 * costs nothing at noon. Only a fraction of trees are uplit, picked by hashing
 * the instance origin — a boulevard where every single palm is floodlit reads
 * as a stadium, not a street.
 *
 * CAMERA CORRIDOR. The occlusion system fades whole registered roots, and a
 * species here is ONE InstancedMesh for the entire city — registering it would
 * dissolve every palm in Miami the moment one of them stood in front of the
 * hole. So foliage does its own: any fragment inside a cone from the camera to
 * the player's hole dissolves, by the same interleaved-gradient dither
 * occlusion.js uses (stays in the opaque pass, needs no sorting). Weighted by
 * height, so a crown opens up and the trunk under it stays solid — you still
 * see that there is a tree there.
 */
function installNatureShader(mat, key) {
  // materials.js caches by (hex, map) — two callers can legitimately land on
  // the same object, and wrapping onBeforeCompile twice would inject the GLSL
  // twice and fail to link.
  if (mat.userData.__natWind) return mat;
  mat.userData.__natWind = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    shader.uniforms.uNatTime = TIME;
    shader.uniforms.uNatNight = NAT.uNatNight;
    shader.uniforms.uNatHole = NAT.uNatHole;
    shader.uniforms.uNatWarm = NAT.uNatWarm;
    shader.uniforms.uNatCool = NAT.uNatCool;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        attribute float aWind;
        attribute float aTint;
        attribute float aGlow;
        uniform float uNatTime;
        varying vec3 vNatWorld;
        varying float vNatGlow;
      `)
      .replace('#include <begin_vertex>', /* glsl */`
        #include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 nOrigin = instanceMatrix[3].xyz;
        #else
          vec3 nOrigin = modelMatrix[3].xyz;
        #endif
        {
          float nPhase = nOrigin.x * 0.19 + nOrigin.z * 0.147;
          if (aWind >= 0.0) {
            // Gusts travel across the map as a slow low-frequency envelope, so
            // the whole avenue leans together instead of each palm buzzing.
            float gust = 0.55 + 0.45 * sin(uNatTime * 0.21 + nOrigin.x * 0.011 - nOrigin.z * 0.007);
            float t = uNatTime * 1.15 + nPhase;
            float s = (sin(t) + 0.38 * sin(t * 2.37 + 1.7)) * aWind * gust;
            transformed.x += s * 0.42;
            transformed.z += cos(t * 0.83 + 1.1) * aWind * gust * 0.30;
            transformed.y -= abs(s) * aWind * 0.06;
          } else {
            float w = -aWind;
            float rr = length(transformed.xz);
            transformed.y += sin(uNatTime * 2.6 - rr * 2.4 + nPhase) * 0.022 * w
                           + sin(uNatTime * 1.7 + rr * 1.1) * 0.014 * w;
          }
          /* Three kinds of night surface, encoded in one float so no extra
             attribute is needed:
                aGlow < 0        a COOL light — fountain water. Always on.
                0 < aGlow <= 1   warm ground uplight on a tree, and only on the
                                 individuals the position hash picks. A
                                 boulevard where every palm is floodlit reads as
                                 a stadium, not a street.
                aGlow > 1        a warm FIXTURE — a lamp globe. Always on, and
                                 its strength is aGlow - 1. */
          float nPick = fract(sin(nOrigin.x * 12.9898 + nOrigin.z * 78.233) * 43758.5453);
          // 0.26, not 0.34. At a third of them the night frames read as a
          // boulevard of floodlights rather than as a street with some feature
          // trees lit on it — and the unlit ones are what make the lit ones
          // land, so thinning the picks costs nothing and buys the contrast.
          vNatGlow = aGlow > 1.0 ? (aGlow - 1.0)
                   : aGlow > 0.0 ? aGlow * step(nPick, 0.26)
                   : aGlow;
        }
      `)
      .replace('#include <project_vertex>', /* glsl */`
        {
          vec4 nW = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            nW = instanceMatrix * nW;
          #endif
          vNatWorld = (modelMatrix * nW).xyz;
        }
        #include <project_vertex>
      `)
      // Gate the instance colour to leaf vertices. Two things this must get
      // right: `#ifdef` because the same material also draws meshes that were
      // never given an instance colour and vColor does not exist in those
      // programs; and `.rgb` because three declares vColor as a vec4 whether or
      // not alpha is in use, so assigning a vec3 to it fails to compile.
      .replace('#include <color_vertex>', /* glsl */`
        #include <color_vertex>
        #ifdef USE_INSTANCING_COLOR
          vColor.rgb = mix(vec3(1.0), vColor.rgb, aTint);
        #endif
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        uniform float uNatNight;
        uniform vec4 uNatHole;
        uniform vec3 uNatWarm;
        uniform vec3 uNatCool;
        varying vec3 vNatWorld;
        varying float vNatGlow;
        float natDither(vec2 p) {
          return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
        }
      `)
      .replace('#include <color_fragment>', /* glsl */`
        #include <color_fragment>
        if (uNatHole.w > 0.0) {
          vec3 toHole = uNatHole.xyz - cameraPosition;
          float L2 = max(dot(toHole, toHole), 1e-4);
          // Parameter along the camera->hole segment. UNCLAMPED on purpose:
          // t > 1 is the ground behind the hole, and a park that dissolved on
          // the far side of the pit would just be a second hole.
          float t = dot(vNatWorld - cameraPosition, toHole) / L2;
          if (t > 0.04 && t < 0.985) {
            float d = distance(vNatWorld, cameraPosition + toHole * t);
            /* A CONE with its apex at the camera, not a cylinder. Scaling the
               radius by t is what makes the opening a constant angular size —
               the same thing occlusion.js gets by working in screen pixels. A
               constant-radius tube looks correct at the hole and then swallows
               half the frame near the lens, because 14 m of world at 40 m from
               the camera is an enormous screen area. Floored, so a hole seen
               from the menu-hero distance still opens something you can see
               through. The radius at the hole widens with the hole: a 30 m
               late-game pit needs far more clear view than a 2 m starting one. */
            float rIn = (uNatHole.w * 1.05 + 1.9) * max(t, 0.14);
            float open = 1.0 - smoothstep(rIn, rIn * 1.80, d);
            /* Only what is actually tall enough to hide anything. A hedge does
               not occlude from a high 3/4 camera, and dissolving it just makes
               the pavement flicker. Raised from 1.1-3.4: the whole knee-to-chest
               layer — hedge, shrub, croton, palmetto, groundcover, which is
               two thirds of everything this file plants — sat inside that ramp
               and speckled every time the player walked past it. */
            open *= smoothstep(1.9, 4.4, vNatWorld.y);
            /* Fade the corridor out as it reaches the pit. Beyond t ~0.9 the
               geometry is AT the hole rather than in front of it: a tree
               standing on the rim projects above and beside the opening, never
               over it, so dissolving it hides nothing and costs a screen-door
               curtain hanging over the ground behind the hole. Measured on the
               crowd frame, where a banyan rooted on the rim was stippling a
               third of the visible park. */
            open *= 1.0 - smoothstep(0.88, 0.99, t);
            /* 0.82, not 0.94: a GHOST always survives.
               At 0.94 a crown standing on the camera-to-hole line vanished
               outright — the A/B pair that produced this number has a queen
               palm fully present in one frame and absent in the other. The
               rubric fails "objects disappearing without falling in" as hard as
               it fails a hidden hole, and occlusion.js makes the same call for
               buildings: dissolve the body, keep enough of it that the player
               still knows what they are standing under. One fragment in six is
               a sparse speckle you can see straight through and still read. */
            if (open > 0.002 && natDither(gl_FragCoord.xy) < open * 0.82) discard;
          }
        }
      `)
      .replace('#include <emissivemap_fragment>', /* glsl */`
        #include <emissivemap_fragment>
        {
          float gl = abs(vNatGlow) * uNatNight;
          totalEmissiveRadiance += (vNatGlow >= 0.0 ? uNatWarm : uNatCool) * gl;
          /* CITY BOUNCE.
             Only a quarter of the trees are hash-picked for an uplight, which
             is right — a boulevard of floodlit palms reads as a stadium. But
             the other three quarters were rendering as BLACK CUTOUTS after
             sunset: in the night waterfront frame the entire promenade planting
             was a single unlit band while the roads, the cars and every facade
             behind it were lit. That is not what a city at night looks like.
             Miami has an enormous amount of spill — sodium off the carriageway,
             shopfronts, headlights, the sky itself — and all of it arrives from
             BELOW and from the sides, so it dies off with height: a hedge is
             washed by it, a royal palm's crown fourteen metres up is not.
             Modulated by diffuseColor so it is a bounce and not a paint job —
             adding flat warm light to a green leaf turns it grey-yellow, while
             multiplying by the leaf's own albedo keeps the crown green and just
             stops it being a hole in the frame. */
          float bounce = exp(-max(vNatWorld.y, 0.0) * 0.20) * 0.50;
          totalEmissiveRadiance += uNatWarm * diffuseColor.rgb * (uNatNight * bounce);
        }
      `);
  };
  mat.customProgramCacheKey = () => key;
  mat.needsUpdate = true;
  return mat;
}

/**
 * materials.foliage() ships `transparent: true`, which is right for blended
 * leaves but wrong for us: it pushes 30 instanced meshes into the sorted
 * transparent queue where they get no early-Z, and with ~2,000 palms on screen
 * the overdraw dominates the frame. We are pure CUTOUT — alphaTest with a hard
 * edge — so the opaque queue is both correct and several times faster. The
 * cache key in materials.js includes our atlas's uuid, so this only ever
 * touches our own material.
 */
function asCutout(m) {
  m.transparent = false;
  m.depthWrite = true;
  m.alphaTest = 0.36;
  return m;
}

let _atlasMat = null;
/**
 * The ONE material every tree, shrub, planter and fountain in Miami uses.
 *
 * There used to be a second, tinted copy per shrub colour run. Per-instance
 * colour replaced it: one material means one program, one place to patch, and
 * a thousand distinct greens instead of three.
 */
function atlasMaterial() {
  if (!_atlasMat) {
    _atlasMat = asCutout(foliage(atlasTexture()));
    // Bump the key whenever the injected GLSL changes: three caches compiled
    // programs by it, and a stale hit is a shader that silently does not have
    // the code you just wrote in it.
    installNatureShader(_atlasMat, 'nature-atlas-v3');
  }
  return _atlasMat;
}

let _pondMat = null;
/**
 * Pond / fountain-basin water: animated normal ripple, sun specular, and it
 * still has to be hole-cuttable because a pond is a ground surface.
 */
function pondMaterial() {
  if (_pondMat) return _pondMat;
  const m = new THREE.MeshStandardMaterial({
    color: PALETTE.SEA_SHALLOW,
    roughness: 0.10,
    metalness: 0.22,
    envMapIntensity: 1.9,
    dithering: true,
    // Same depth-layer scheme as BUCKET_MATS — see `layer`.
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNatTime = TIME;
    shader.uniforms.uNatNight = NAT.uNatNight;
    shader.uniforms.uNatCool = NAT.uNatCool;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vNatW;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\nvNatW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nvarying vec3 vNatW;\nuniform float uNatTime;'
        + '\nuniform float uNatNight;\nuniform vec3 uNatCool;')
      .replace('#include <normal_fragment_maps>', /* glsl */`
        #include <normal_fragment_maps>
        {
          vec2 p = vNatW.xz;
          float t = uNatTime;
          float dx = cos(p.x * 2.10 + t * 1.9) * 0.055
                   + cos((p.x + p.y) * 1.05 - t * 1.2) * 0.045;
          float dz = cos(p.y * 2.45 - t * 1.5) * 0.055
                   + cos((p.x - p.y) * 1.25 + t * 0.95) * 0.045;
          normal = normalize(normal + vec3(dx, 0.0, dz));
        }
      `)
      // A lit pond at night: submerged fixtures, so the glow is strongest in
      // rings and dies at the rim where the stone edge shades it.
      .replace('#include <emissivemap_fragment>', /* glsl */`
        #include <emissivemap_fragment>
        {
          float ring = 0.55 + 0.45 * sin(length(vNatW.xz) * 1.1 + uNatTime * 0.6);
          totalEmissiveRadiance += uNatCool * (uNatNight * (0.16 + 0.12 * ring));
        }
      `);
  };
  applyHoleCut(m);
  // applyHoleCut stamps a shared cache key; ours must win or three could hand
  // this material a program compiled without the ripple.
  m.customProgramCacheKey = () => 'nature-pond-v2';
  _pondMat = m;
  return m;
}

/**
 * Push nightFactor and the player's hole into the foliage uniforms, once a
 * frame, with no hook in the game loop.
 *
 * The loop only calls the two updates it knows about by name (`trafficUpdate`,
 * `pedestrianUpdate`) — a `natureUpdate` on scene.userData would sit there
 * unread, and game.js is not this module's to edit. `scene.onBeforeRender` is
 * one shared slot that six parallel modules would fight over. So: a real mesh
 * that renders every frame and carries the callback. It is one degenerate
 * triangle (all three vertices identical, so the rasteriser emits nothing) on
 * the material it is updating, `frustumCulled = false` so it can never be the
 * frame that gets skipped, and no shadow so it does not also run in the shadow
 * pass. One draw call, zero fragments, zero coupling.
 *
 * `scene.userData.natureUpdate` is still published, for anyone who later wants
 * to drive this from the loop instead; calling it twice a frame is harmless.
 */
function installClock(ctx) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(6), 2));
  for (const name of ['aWind', 'aTint', 'aGlow']) {
    g.setAttribute(name, new THREE.BufferAttribute(new Float32Array(3), 1));
  }
  const hole = NAT.uNatHole.value;
  const tick = () => {
    NAT.uNatNight.value = ctx.scene.userData.nightFactor || 0;
    // The player is holes[0] and groundShader republishes every hole's
    // (x, z, cutRadius, alive) into this array every frame for the ground cut,
    // so the corridor rides on data that is already being maintained.
    const h = holeUniforms.uHoles.value[0];
    if (h && h.w > 0.5) hole.set(h.x, 0, h.y, h.z);
    else hole.w = -1;
  };
  const m = new THREE.Mesh(g, atlasMaterial());
  m.name = 'nature-clock';
  m.frustumCulled = false;
  m.castShadow = false;
  m.receiveShadow = false;
  m.onBeforeRender = tick;
  ctx.addDecor(m, 'nature');
  ctx.scene.userData.natureUpdate = tick;
}

/* ======================================================================== */
/*  GEOMETRY HELPERS                                                        */
/* ======================================================================== */

const _m4 = new THREE.Matrix4();
const _v3 = new THREE.Vector3();

/**
 * Every geometry that reaches the atlas material must carry aTint and aGlow, or
 * BufferGeometryUtils.mergeGeometries refuses to merge a trunk with its crown.
 *
 * Tagging happens HERE, from the atlas cell the geometry was given, rather than
 * at the ~60 call sites. A cell knows whether it is leaves or bark, so "which
 * vertices may the per-instance colour touch" is answered once, by the same
 * table that decides which cells need alpha dilation.
 */
function cellTag(geo, cellName, glow = 0) {
  const n = geo.attributes.position.count;
  const tint = cellName && TINTABLE_CELLS.has(cellName) ? 1 : 0;
  const t = new Float32Array(n);
  if (tint) t.fill(1);
  geo.setAttribute('aTint', new THREE.BufferAttribute(t, 1));
  const g = new Float32Array(n);
  if (glow) g.fill(glow);
  geo.setAttribute('aGlow', new THREE.BufferAttribute(g, 1));
  return geo;
}

/** Remap a geometry's 0..1 UVs into an atlas cell, and tag it from that cell. */
function mapUV(geo, rect) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, rect.u0 + uv.getX(i) * (rect.u1 - rect.u0), rect.v0 + uv.getY(i) * (rect.v1 - rect.v0));
  }
  uv.needsUpdate = true;
  return cellTag(geo, rect.name);
}

/**
 * Attach the wind weight.
 * @param {(x:number,y:number,z:number)=>number} fn returns the per-vertex weight
 */
function windAttr(geo, fn) {
  const p = geo.attributes.position;
  const a = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) a[i] = fn(p.getX(i), p.getY(i), p.getZ(i));
  geo.setAttribute('aWind', new THREE.BufferAttribute(a, 1));
  return geo;
}

/**
 * Overwrite the night-light response after the fact.
 * Positive = lit BY a warm ground uplight, negative = IS a cool light source.
 * @param {(x:number,y:number,z:number)=>number} fn
 */
function glowAttr(geo, fn) {
  const p = geo.attributes.position;
  const a = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) a[i] = fn(p.getX(i), p.getY(i), p.getZ(i));
  geo.setAttribute('aGlow', new THREE.BufferAttribute(a, 1));
  return geo;
}

/** Bend vertex normals toward a radial direction so card clumps shade round. */
function radialNormals(geo, cx, cy, cz, k) {
  const p = geo.attributes.position, n = geo.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    const dx = p.getX(i) - cx, dy = p.getY(i) - cy, dz = p.getZ(i) - cz;
    const l = Math.hypot(dx, dy, dz) || 1;
    const nx = n.getX(i) + (dx / l - n.getX(i)) * k;
    const ny = n.getY(i) + (dy / l - n.getY(i)) * k;
    const nz = n.getZ(i) + (dz / l - n.getZ(i)) * k;
    const m = Math.hypot(nx, ny, nz) || 1;
    n.setXYZ(i, nx / m, ny / m, nz / m);
  }
  n.needsUpdate = true;
  return geo;
}

/** Lift normals toward +Y — foliage undersides should never go black. */
function liftNormals(geo, k) {
  const n = geo.attributes.normal;
  for (let i = 0; i < n.count; i++) {
    const y = n.getY(i) + (1 - n.getY(i)) * k;
    const x = n.getX(i) * (1 - k), z = n.getZ(i) * (1 - k);
    const m = Math.hypot(x, y, z) || 1;
    n.setXYZ(i, x / m, y / m, z / m);
  }
  n.needsUpdate = true;
  return geo;
}

/**
 * Tapered, curved, closed tube — the trunk primitive.
 * y = 0 at the base. `bend` leans the top toward +x, `sway` swings it in z.
 */
function trunkGeo(h, rBot, rTop, cellName, {
  sides = 6, rings = 5, bend = 0, sway = 0, bulge = 0,
} = {}) {
  const pos = [], nor = [], uv = [], idx = [];
  const rect = uvOf(cellName);
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const y = h * t;
    // Palms thicken slightly at the base and just under the crown.
    const r = (rBot + (rTop - rBot) * Math.pow(t, 0.65)) * (1 + bulge * Math.sin(t * Math.PI));
    const ox = bend * h * t * t;
    const oz = sway * h * (t * t * 0.9);
    for (let j = 0; j <= sides; j++) {
      const a = (j / sides) * Math.PI * 2;
      const cx = Math.cos(a), cz = Math.sin(a);
      pos.push(ox + cx * r, y, oz + cz * r);
      nor.push(cx, 0.12, cz);
      uv.push(rect.u0 + (j / sides) * (rect.u1 - rect.u0), rect.v0 + t * (rect.v1 - rect.v0));
    }
  }
  const row = sides + 1;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < sides; j++) {
      const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  return cellTag(finishGeo(pos, nor, uv, idx), cellName);
}

/**
 * One frond: a tapered strip that rises off the crown then droops, built along
 * +X and then swung into place. Three segments is enough curve to read; four
 * would double the palm's triangle budget for nothing.
 */
function frondGeo(len, wid, cellName, {
  segs = 3, rise = 0.52, droop = 0.98, roll = 0, alongV = false,
} = {}) {
  const pos = [], nor = [], uv = [], idx = [];
  const rect = uvOf(cellName);
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const x = len * t;
    const y = len * (rise * t - droop * t * t);
    const hw = wid * 0.5 * (0.42 + 0.58 * Math.sin(Math.PI * Math.min(1, t * 1.02)));
    // Roll folds the two edges below the rachis, which is what stops a frond
    // reading as a flat sheet of paper from directly above.
    const fold = hw * roll;
    for (let s = -1; s <= 1; s += 2) {
      pos.push(x, y - fold, s * hw);
      nor.push(0, 1, 0);
      if (alongV) {
        // Fan cells are drawn radiating UP the cell from a hinge on its bottom
        // edge, so their long axis is v, not u.
        uv.push(s < 0 ? rect.u0 : rect.u1, rect.v0 + t * (rect.v1 - rect.v0));
      } else {
        uv.push(rect.u0 + t * (rect.u1 - rect.u0), s < 0 ? rect.v0 : rect.v1);
      }
    }
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, c, b, b, c, d);
  }
  return cellTag(finishGeo(pos, nor, uv, idx), cellName);
}

/** A flat quad in the XY plane, origin at bottom centre, facing +Z. */
function cardGeo(w, h, cellName) {
  const g = new THREE.PlaneGeometry(w, h);
  g.translate(0, h / 2, 0);
  return mapUV(g, uvOf(cellName));
}

/**
 * Broadleaf canopy: three crossed vertical cards plus a ring of four leaning
 * ones. The leaning ones matter most — the game camera looks down at 40
 * degrees, and a purely vertical card cloud goes paper-thin from up there.
 *
 * WHY THEY LEAN OUTWARD RATHER THAN LYING DOWN
 * The first cut laid three cards NEARLY FLAT (24-41 degrees off horizontal),
 * all in the same orientation, all within 0.38 radius of the trunk. On a
 * banyan that is three 14 m plates stacked on top of each other with their
 * edges parallel, and from the game's high 3/4 camera the crown read as a
 * cabbage: a stack of overlapping discs with hard aligned silhouette edges,
 * not a mound of foliage. Turning each card to face OUT along its own bearing
 * and pushing it to 0.55 radius makes the same triangles describe a dome —
 * the plan outline becomes a lobed ring instead of a disc, and no two edges
 * line up. The crossed vertical cards still fill the middle from directly
 * above, so the dome is not a doughnut.
 */
function canopyGeo(radius, height, cellName, seedRng) {
  const parts = [];
  const cy = height;
  for (let i = 0; i < 3; i++) {
    const g = cardGeo(radius * 2.05, radius * 1.75, cellName);
    g.translate(0, cy - radius * 0.875, 0);
    g.rotateY((i / 3) * Math.PI + seedRng() * 0.4);
    parts.push(g);
  }
  for (let i = 0; i < 4; i++) {
    const g = cardGeo(radius * 1.30, radius * 1.20, cellName);
    g.translate(0, -radius * 0.60, 0);
    // 35-59 degrees off horizontal: enough lean to catch the key light on a
    // different plane from the flat top, not so much that the crown loses the
    // horizontal mass the overhead camera needs.
    _m4.makeRotationX(-Math.PI / 2 + 0.62 + seedRng() * 0.42);
    g.applyMatrix4(_m4);
    const a = (i / 4) * Math.PI * 2 + seedRng() * 0.9;
    _m4.makeRotationY(a);
    g.applyMatrix4(_m4);
    g.translate(Math.cos(a) * radius * 0.55, cy + radius * 0.24, Math.sin(a) * radius * 0.55);
    parts.push(g);
  }
  const merged = BufferGeometryUtils.mergeGeometries(parts, false);
  radialNormals(merged, 0, cy, 0, 0.72);
  return merged;
}

function finishGeo(pos, nor, uv, idx) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Axis-aligned quad on the ground, with UVs scaled to a world tile size. */
function tile(w, d, x, z, y, unitsPerTile) {
  const g = new THREE.PlaneGeometry(w, d, 1, 1);
  g.rotateX(-Math.PI / 2);
  g.translate(x, y, z);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * (w / unitsPerTile), uv.getY(i) * (d / unitsPerTile));
  }
  uv.needsUpdate = true;
  return g;
}

/** A box with world-scaled UVs, so kerbs and walls do not smear. */
function box(w, h, d, x, y, z, unitsPerTile = 2) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const spans = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, uv.getX(k) * (spans[f][0] / unitsPerTile), uv.getY(k) * (spans[f][1] / unitsPerTile));
    }
  }
  uv.needsUpdate = true;
  g.translate(x, y, z);
  return g;
}

/** A flat ribbon following a polyline — park paths that actually curve. */
function ribbon(points, width, y, unitsPerTile) {
  const pos = [], nor = [], uv = [], idx = [];
  let run = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    let dx = b.x - a.x, dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    if (i > 0) run += Math.hypot(p.x - points[i - 1].x, p.z - points[i - 1].z);
    const nx = -dz * width * 0.5, nz = dx * width * 0.5;
    pos.push(p.x - nx, y, p.z - nz); nor.push(0, 1, 0); uv.push(0, run / unitsPerTile);
    pos.push(p.x + nx, y, p.z + nz); nor.push(0, 1, 0); uv.push(width / unitsPerTile, run / unitsPerTile);
  }
  for (let i = 0; i < points.length - 1; i++) {
    // Wind counter-clockwise seen from +Y. Get this backwards and the ribbon is
    // a perfectly correct, perfectly invisible back face on a FrontSide
    // material — which is exactly how every park path vanished.
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, b, c, b, d, c);
  }
  return finishGeo(pos, nor, uv, idx);
}

/** Flat regular polygon on the ground (fountain bowls, pond edges, medallions). */
function disc(r, sides, x, y, z, cellName) {
  const pos = [], nor = [], uv = [], idx = [];
  const rect = cellName ? uvOf(cellName) : { u0: 0, u1: 1, v0: 0, v1: 1 };
  pos.push(x, y, z); nor.push(0, 1, 0);
  uv.push((rect.u0 + rect.u1) / 2, (rect.v0 + rect.v1) / 2);
  for (let i = 0; i <= sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    pos.push(x + Math.cos(a) * r, y, z + Math.sin(a) * r);
    nor.push(0, 1, 0);
    uv.push(
      (rect.u0 + rect.u1) / 2 + Math.cos(a) * (rect.u1 - rect.u0) * 0.5,
      (rect.v0 + rect.v1) / 2 + Math.sin(a) * (rect.v1 - rect.v0) * 0.5
    );
  }
  // Reversed for the same reason as `ribbon`: +angle runs clockwise when you
  // look down the +Y axis, so the naive fan faces the ground.
  for (let i = 1; i <= sides; i++) idx.push(0, i + 1, i);
  return cellTag(finishGeo(pos, nor, uv, idx), cellName);
}

/**
 * Hollow ring wall — fountain and pond rims.
 * The inner sleeve is left facing outward on purpose: the atlas material is
 * double-sided, so three flips its normal for the back faces you actually see
 * from inside the bowl, and that is one less geometry to build.
 */
function ringWall(rIn, rOut, h, y, sides, cellName, x = 0, z = 0) {
  const parts = [];
  const outer = new THREE.CylinderGeometry(rOut, rOut * 1.02, h, sides, 1, true);
  const inner = new THREE.CylinderGeometry(rIn, rIn, h, sides, 1, true);
  const cap = new THREE.RingGeometry(rIn, rOut, sides, 1).rotateX(-Math.PI / 2).translate(0, h / 2, 0);
  outer.translate(0, h / 2, 0);
  inner.translate(0, h / 2, 0);
  for (const g of [outer, inner, cap]) parts.push(mapUV(g, uvOf(cellName)));
  const m = BufferGeometryUtils.mergeGeometries(parts, false);
  m.translate(x, y, z);
  return m;
}

/* ======================================================================== */
/*  SPECIES                                                                 */
/* ======================================================================== */

/**
 * Palm builder. Everything — trunk, crownshaft, every frond, the coconuts —
 * merges into ONE geometry so the whole tree is one instanced draw and one
 * swallowable object.
 */
function makePalm(spec) {
  const rng = makeRNG(spec.seed);
  const parts = [];
  const H = spec.h;
  const shaftH = spec.crownshaft ? H * 0.11 : 0;
  const trunkH = H - shaftH;

  parts.push(trunkGeo(trunkH, spec.rBot, spec.rTop, spec.bark, {
    sides: spec.sides || 6,
    rings: spec.rings || 5,
    bend: spec.bend,
    sway: spec.sway,
    bulge: spec.bulge || 0,
  }));

  const topX = spec.bend * trunkH, topZ = spec.sway * trunkH * 0.9;
  let crownY = trunkH;

  if (spec.crownshaft) {
    const cs = trunkGeo(shaftH, spec.rTop * 1.32, spec.rTop * 0.86, 'crownshaft', {
      sides: spec.sides || 6, rings: 2, bulge: 0.22,
    });
    cs.translate(topX, trunkH, topZ);
    parts.push(cs);
    crownY = trunkH + shaftH * 0.92;
  }

  /* The crown. Fronds alternate between two atlas cells so a single crown is
     already a mix of sunlit and shaded blades.
     ------------------------------------------------------------------------
     THREE ASYMMETRIES, and they are the answer to "the palms all look the
     same". Scale, rotation and tint vary a palm's SIZE and COLOUR, but a crown
     built as an even ring of fronds has the same OUTLINE at every size and
     every rotation, and outline is the thing the eye actually matches. So:
       flag   the whole crown is combed toward one compass bearing — windward
              fronds stand up and reach further, leeward ones hang. Every palm
              on a seafront really does do this, and no two of ours do it in
              the same direction.
       gap    a sector with no fronds in it, where the crown has shed. Turns a
              circle into a horseshoe.
       spiral golden-angle placement instead of an even ring, which clusters
              the fronds into two or three visual bunches per crown.
     Together they mean two instances of the SAME variant, seen from the same
     angle, still have different silhouettes. */
  const n = spec.fronds;
  const flagK = spec.flag || 0;
  const flagDir = spec.flagDir || 0;
  const gapHalf = Math.min(0.72, spec.gap || 0);
  const gapDir = spec.gapDir || 0;
  const TAU = Math.PI * 2;
  let placed = 0;
  for (let i = 0; i < n; i++) {
    const a = spec.spiral ? i * 2.39996 + rng() * 0.22 : (i / n) * TAU + rng() * 0.35;
    if (gapHalf > 0) {
      // Signed angular distance from the bare sector, wrapped to (-PI, PI].
      const d = Math.abs(((a - gapDir + Math.PI) % TAU + TAU) % TAU - Math.PI);
      // Never strip the crown below seven blades — a palm with four fronds is
      // not a windswept palm, it is a broken asset.
      if (d < gapHalf && n - (i - placed) > 7) continue;
    }
    placed++;
    const bias = flagK * Math.cos(a - flagDir);
    // Outer ring of fronds hangs low, inner ring points up: a real crown is a
    // shuttlecock, not a parasol.
    const inner = i % 3 === 0;
    const cell = spec.cells[i % spec.cells.length];
    const fanCell = FAN_CELLS.has(cell);
    /* A COSTAPALMATE CROWN IS A SHUTTLECOCK, NOT A LILY PAD.
       A fan blade is as wide as it is long, so a dozen of them leaving the bud
       at ONE shared pitch, ONE rise and ONE droop overlap into a single
       surface — and every sabal and washingtonia in the city read from the game
       camera as exactly that: a flat dark disc floating on a bare pole, with the
       three upright inner blades sitting on top of it like a lid. A pinnate
       frond is a narrow strip and never does this, so the extra spread is gated
       on the CELL rather than applied to every palm.
       Gated on trunk height too: a saw palmetto's crown starts 40 cm off the
       ground, and a blade allowed to swing further down there would land in the
       contact band worldBuild measures and hand a knee-high shrub a car's pass
       radius (see fanShort's own note). */
    const fan3d = fanCell && trunkH > 3.0;
    const len = spec.frondLen * (inner ? 0.72 : 1) * (0.86 + rng() * 0.3) * (1 + bias * 0.24);
    const spread = fan3d ? 1.15 : 0.45;
    const pitch = (inner ? 0.95 + rng() * 0.4 : spec.pitch + (rng() - 0.5) * spread) + bias * 0.58;
    const f = frondGeo(len, len * spec.frondW, cell, {
      // Per-blade ARC as well as per-blade angle. Blades that all bend by the
      // same amount still finish on one common surface however they are
      // pitched, which is the half of the plate that pitch alone cannot break.
      rise: (inner ? 0.75 : spec.rise) * (fan3d ? 0.82 + rng() * 0.50 : 1),
      droop: (inner ? 0.7 : spec.droop) * (fan3d ? 0.74 + rng() * 0.56 : 1),
      roll: 0.30 + rng() * 0.25,
      alongV: fanCell,
    });
    _m4.makeRotationZ(pitch);
    f.applyMatrix4(_m4);
    _m4.makeRotationY(a);
    f.applyMatrix4(_m4);
    f.translate(topX, crownY, topZ);
    parts.push(f);
  }

  /* The skirt of shed fronds a sabal or a washingtonia carries under its crown.
     Steeply NEGATIVE pitch, because +Z rotation lifts a frond and we want these
     collapsed against the trunk, and short enough that the lowest tip stays far
     above the contact band worldBuild measures. Dead-frond cells are excluded
     from the tint set, so this stays straw against a green crown however the
     instance is coloured. */
  const skirtN = spec.skirt || 0;
  for (let i = 0; i < skirtN; i++) {
    const a = (i / skirtN) * TAU + rng() * 0.5;
    const len = spec.frondLen * (0.34 + rng() * 0.16);
    const f = frondGeo(len, len * Math.min(0.8, spec.frondW), 'frondDead', {
      rise: 0.10, droop: 0.30, roll: 0.55 + rng() * 0.3,
    });
    _m4.makeRotationZ(-(0.95 + rng() * 0.40));
    f.applyMatrix4(_m4);
    _m4.makeRotationY(a);
    f.applyMatrix4(_m4);
    f.translate(topX, crownY - spec.rTop * 0.4, topZ);
    parts.push(f);
  }

  if (spec.coconuts) {
    for (let i = 0; i < 2; i++) {
      const a = rng() * Math.PI * 2;
      const c = cardGeo(spec.rTop * 4.2, spec.rTop * 5.0, 'coconut');
      c.translate(0, -spec.rTop * 4.6, 0);
      _m4.makeRotationY(a);
      c.applyMatrix4(_m4);
      c.translate(topX + Math.cos(a) * spec.rTop * 1.2, crownY - spec.rTop * 0.4,
        topZ + Math.sin(a) * spec.rTop * 1.2);
      parts.push(c);
    }
  }

  const geo = BufferGeometryUtils.mergeGeometries(parts, false);
  liftNormals(geo, 0.28);
  // Wind: nothing at the base, everything at the frond tips. The radial term
  // is what makes the fronds flutter faster than the trunk leans.
  windAttr(geo, (x, y, z) => {
    const up = Math.min(1, Math.max(0, y / H));
    const rad = Math.min(1, Math.hypot(x - topX, z - topZ) / Math.max(1, spec.frondLen));
    return Math.pow(up, 1.9) * (0.55 + 0.85 * rad);
  });
  uplight(geo, crownY);
  return geo;
}

/**
 * Where a warm ground uplight lands on a tree at night.
 *
 * Two lobes, because that is what a pair of in-ground fixtures at the base of a
 * palm actually does: a bright wash on the first three metres of trunk, and a
 * second, softer catch on the underside of the crown where the beam finally
 * hits something. The dark middle between them is the whole effect — light it
 * evenly and the tree reads as self-illuminated plastic.
 */
function uplight(geo, crownY) {
  glowAttr(geo, (x, y) => {
    /* The TRUNK is what an in-ground fixture actually lights, and it is the
       part that reads as "lit" rather than as "luminous". Reach extended to
       4.2 m and the peak raised, because in the night frames that produced
       this comment the trunks were black and only the crowns glowed — exactly
       inside out. */
    const shaft = Math.exp(-Math.max(0, y) / 4.2) * 0.72;
    /* The crown catch is ASYMMETRIC and weak. A beam from the ground hits the
       UNDERSIDE of a crown and stops there; the top of it stays as dark as the
       sky. The old symmetric lobe was 0.32 either side of crownY, which lit the
       whole crown evenly and turned every hash-picked palm into a solid gold
       lamp — the one failure mode this function's own docstring warns about,
       and it was doing it. Above the attachment point the falloff is three
       times faster than below it. */
    const d = y - crownY * 0.90;
    const crown = Math.exp(d > 0
      ? -d / Math.max(0.5, crownY * 0.06)
      : d / Math.max(1.0, crownY * 0.20)) * 0.16;
    // Capped below 1: above 1 the shader reads the value as a light FIXTURE
    // rather than as a surface catching one, and every uplit palm in the city
    // would switch from "picked by the hash" to "always on".
    return Math.min(0.80, shaft + crown);
  });
  return geo;
}

/**
 * MULTI-STEM CLUMPING PALM — areca, bamboo palm, a triple coconut.
 *
 * Worth its own builder rather than three instances of a single-stem palm for
 * two separate reasons.
 *
 * SILHOUETTE. Every other palm in this file is one pole with one tuft, and no
 * amount of scale, rotation or tint jitter changes that outline. A clump is
 * three to five poles of DIFFERENT heights fanning out of one root, so it reads
 * as a distinct plant from 60 m — which is what breaks a boulevard that is
 * otherwise a row of the same shape.
 *
 * PHYSICS. The stems splay from a shared base, so the contact band stays the
 * 40 cm the root ball actually occupies while the crowns spread three metres.
 * Building it as three separate instances would instead give three separate
 * consumables standing inside each other's spacing radius, and the audit would
 * (rightly) call every clump in the city an overlapping pair.
 */
function makeClumpPalm(spec) {
  const rng = makeRNG(spec.seed);
  const parts = [];
  const n = spec.stems;
  let tallest = 0;
  for (let i = 0; i < n; i++) {
    // Stems are graded, not random: a clump has one leader and the rest step
    // down from it, which is what stops it reading as a bundle of sticks.
    const rank = i / Math.max(1, n - 1);
    const h = spec.h * (1 - rank * spec.taper) * (0.92 + rng() * 0.16);
    tallest = Math.max(tallest, h);
    // Splay outward from the root, all in different compass directions.
    const a = (i / n) * Math.PI * 2 + rng() * 0.7;
    const lean = spec.splay * (0.45 + rng() * 0.9);
    const bend = Math.cos(a) * lean, sway = Math.sin(a) * lean;
    const rBot = spec.rBot * (0.85 + rng() * 0.3);
    const stem = trunkGeo(h, rBot, rBot * 0.72, spec.bark, {
      sides: 5, rings: 4, bend, sway, bulge: 0.05,
    });
    // Feet gather at the root ball; only the tops fan apart.
    const fx = Math.cos(a) * spec.rBot * 1.15, fz = Math.sin(a) * spec.rBot * 1.15;
    stem.translate(fx, 0, fz);
    parts.push(stem);

    const cx = fx + bend * h, cz = fz + sway * h * 0.9;
    const fr = Math.max(4, Math.round(spec.fronds * (0.7 + rank * 0.1 + rng() * 0.4)));
    for (let k = 0; k < fr; k++) {
      const fa = (k / fr) * Math.PI * 2 + rng() * 0.4;
      const len = spec.frondLen * h / spec.h * (0.82 + rng() * 0.36);
      const f = frondGeo(len, len * spec.frondW, spec.cells[k % spec.cells.length], {
        rise: 0.44, droop: 1.06, roll: 0.34 + rng() * 0.22,
      });
      _m4.makeRotationZ(spec.pitch + (rng() - 0.5) * 0.5);
      f.applyMatrix4(_m4);
      _m4.makeRotationY(fa);
      f.applyMatrix4(_m4);
      f.translate(cx, h, cz);
      parts.push(f);
    }
  }
  const geo = BufferGeometryUtils.mergeGeometries(parts, false);
  liftNormals(geo, 0.28);
  windAttr(geo, (x, y) => Math.pow(Math.min(1, Math.max(0, y / tallest)), 1.7) * 1.05);
  uplight(geo, tallest * 0.9);
  return geo;
}

/**
 * A stemless-to-short-trunked whorl: sago palm, traveller's palm, bird of
 * paradise. Everything radiates from one hinge just above the ground.
 *
 * Distinct from `makeRosette` (which is crossed flat cards) because these need
 * real leaves placed around a real axis — a sago's stiff radial comb and a
 * traveller's flat two-ranked fan are both about WHERE the leaves point, and
 * three crossed billboards cannot say that. `rank` collapses the whorl into a
 * single plane, which is exactly what a traveller's palm does.
 */
function makeWhorl(spec) {
  const rng = makeRNG(spec.seed);
  const parts = [];
  const trunkH = spec.trunkH || 0;
  if (trunkH > 0.02) {
    parts.push(trunkGeo(trunkH, spec.rBot, spec.rBot * 0.88, spec.bark || 'barkFib',
      { sides: 6, rings: 2, bulge: 0.20 }));
  }
  const n = spec.leaves;
  let top = trunkH;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    let a, pitch, len;
    if (spec.rank) {
      /* TWO-RANKED. Every leaf lies in ONE vertical plane, alternating left and
         right, the inner pair upright and each successive pair laid further
         over — a traveller's palm is a peacock's tail, and it only reads as one
         if the leaves share a plane. Index order runs from the middle out, so
         `u` is how far from the centre of the fan this leaf is. */
      const pairs = Math.ceil(n / 2);
      const u = Math.min(1, (Math.floor(i / 2) + 0.5) / pairs);
      a = (i % 2 ? 0 : Math.PI) + (rng() - 0.5) * 0.24;
      pitch = 0.30 + 1.14 * (1 - u) + (rng() - 0.5) * spec.pitchVar;
      len = spec.len * (0.64 + 0.36 * (1 - u * 0.7)) * (0.90 + rng() * 0.22);
    } else {
      a = t * Math.PI * 2 + rng() * 0.3;
      pitch = spec.pitch + (rng() - 0.5) * spec.pitchVar;
      len = spec.len * (0.74 + 0.40 * Math.sin(Math.PI * t)) * (0.88 + rng() * 0.26);
    }
    const f = frondGeo(len, len * spec.wide, spec.cell, {
      segs: 3, rise: spec.rise, droop: spec.droop, roll: 0.22 + rng() * 0.2,
      alongV: true,
    });
    _m4.makeRotationZ(pitch);
    f.applyMatrix4(_m4);
    _m4.makeRotationY(a);
    f.applyMatrix4(_m4);
    f.translate(0, trunkH, 0);
    parts.push(f);
    top = Math.max(top, trunkH + len * Math.sin(Math.max(0, pitch)) * 0.9);
  }
  const geo = BufferGeometryUtils.mergeGeometries(parts, false);
  radialNormals(geo, 0, trunkH + spec.len * 0.3, 0, 0.5);
  liftNormals(geo, 0.30);
  // Stiff. A sago barely moves and a banana paddle flaps; `flex` is the only
  // thing separating the two here, and the contrast between a still plant and a
  // swaying palm behind it is half of why either reads.
  windAttr(geo, (x, y) => Math.pow(Math.min(1, y / Math.max(0.5, top)), 1.7) * spec.flex);
  uplight(geo, Math.max(0.6, top * 0.7));
  return geo;
}

/**
 * Broadleaf tree: tapered trunk, a couple of limbs, a card-cloud canopy.
 *
 * CONTACT BAND. worldBuild measures an object's ground footprint from the
 * lowest fifth of its geometry, which for a tree must be trunk and nothing
 * else. A card canopy hangs below its own centre by 0.875 x its radius, so on a
 * short-trunked, wide-crowned species the crown dropped INTO that band and the
 * physics measured the whole spread as the footprint: a sea grape was declaring
 * a 4.7 m contact radius and a 3.4 m pass radius when its trunk is 30 cm thick,
 * so it needed a hole three times its own width to fall through. The canopy is
 * therefore lifted until it clears the band by construction — for every
 * species, at every variant, whatever the numbers below say.
 */
function makeTree(spec) {
  const rng = makeRNG(spec.seed);
  const parts = [];
  const H = spec.h;
  const trunkH = H * spec.trunkF;

  parts.push(trunkGeo(trunkH, spec.rBot, spec.rTop, spec.bark, {
    sides: 6, rings: 4, bend: spec.bend, sway: spec.sway, bulge: 0.05,
  }));

  /* Two stub limbs lifting out of the fork — cheap, but it is the difference
     between a tree and a lollipop. */
  for (let i = 0; i < spec.limbs; i++) {
    const a = rng() * Math.PI * 2;
    const l = trunkGeo(H * 0.26, spec.rTop * 0.72, spec.rTop * 0.34, spec.bark, { sides: 5, rings: 2 });
    _m4.makeRotationZ(0.85 + rng() * 0.35);
    l.applyMatrix4(_m4);
    _m4.makeRotationY(a);
    l.applyMatrix4(_m4);
    l.translate(spec.bend * trunkH, trunkH * 0.82, spec.sway * trunkH * 0.9);
    parts.push(l);
  }

  const c = canopyGeo(spec.canopyR, spec.canopyR * spec.canopyF, spec.cell, rng);
  c.computeBoundingBox();
  const cb = c.boundingBox;
  let cy = trunkH * 0.96;
  // Fixed point: raising the canopy also raises the total height, which raises
  // the band it has to clear. Three passes is convergence to well under a mm.
  for (let i = 0; i < 3; i++) {
    const top = Math.max(trunkH, cy + cb.max.y);
    const need = top * 0.235 - cb.min.y;      // 23.5% > the 20% band, with margin
    if (need > cy) cy = need;
  }
  c.translate(spec.bend * trunkH, cy, spec.sway * trunkH * 0.9);
  parts.push(c);

  const geo = BufferGeometryUtils.mergeGeometries(parts, false);
  liftNormals(geo, 0.18);
  const top = cy + cb.max.y;
  windAttr(geo, (x, y) => {
    const up = Math.min(1, Math.max(0, y / top));
    return Math.pow(up, 2.1) * 0.85;
  });
  uplight(geo, cy);
  return geo;
}

/**
 * Low mass: hedge units, shrubs, flower beds, ornamental grass.
 *
 * `depth` makes the mass LINEAR instead of round. A shrub is a blob and its
 * crossed cards are right, but a hedge is a line, and building one out of the
 * same crossed cards gave every hedge unit a 3.3 x 3.3 m ground footprint — as
 * deep as it was long. Since worldBuild measures that footprint for the
 * physics, all 2,400 hedges in the city were claiming 1.65 m of the pavement in
 * front of them and 1.65 m of the setback behind, which is most of a Miami
 * sidewalk — and hedge-against-pedestrian was far and away the commonest
 * overlapping pair on the map. Two parallel faces plus a cap is the same three
 * cards, the same six triangles, and an object the shape of the thing it draws.
 */
function makeBush(spec) {
  const rng = makeRNG(spec.seed);
  const parts = [];
  const n = spec.cards || 3;
  const dep = spec.depth || 0;
  for (let i = 0; i < n; i++) {
    const g = cardGeo(spec.w, spec.h, spec.cell);
    if (dep) {
      // Faces of a slab: both broadside to the run, offset either side of it.
      g.translate(0, 0, (i / Math.max(1, n - 1) - 0.5) * dep);
      g.rotateY((rng() - 0.5) * 0.12);
    } else {
      g.rotateY((i / n) * Math.PI + rng() * 0.3);
    }
    parts.push(g);
  }
  if (spec.top !== false && dep) {
    /* A CLIPPED HEDGE HAS A RIDGE, NOT A LID.
       One horizontal card spanning the full depth gave every hedge in the city
       a single flat top plane, and a run of them at 3.2 m centres therefore
       read from the game camera as one smooth extruded tube — a green sausage
       laid along the kerb. Two cards pitched off a centre ridge cost the same
       six triangles and give the top a lit face and a turned-away face, which
       is the value separation that makes the mass read as a clipped box. */
    const half = dep * 0.62;
    for (const s of [-1, 1]) {
      const t = cardGeo(spec.w * 0.96, half, spec.cell);
      t.translate(0, -half * 0.5, 0);
      _m4.makeRotationX(-Math.PI / 2 + s * 0.32);
      t.applyMatrix4(_m4);
      t.translate(0, spec.h * 0.84, s * half * 0.47);
      parts.push(t);
    }
  } else if (spec.top !== false) {
    const td = spec.w * 0.94;
    const t = cardGeo(spec.w * 0.94, td, spec.cell);
    t.translate(0, -td * 0.5, 0);
    _m4.makeRotationX(-Math.PI / 2);
    t.applyMatrix4(_m4);
    t.translate(0, spec.h * 0.86, 0);
    parts.push(t);
  }
  const geo = BufferGeometryUtils.mergeGeometries(parts, false);
  /* A BLOB IS ROUND; A HEDGE IS NOT.
     The round pair (0.6 / 0.35) points a linear mass's side faces most of the
     way at the sky, so the two long faces and the top all caught the key light
     equally and the unit inflated into a smooth cylinder. Keeping more of the
     side faces' real outward normal is what puts them a stop under the top. */
  const lin = dep > 0;
  radialNormals(geo, 0, spec.h * 0.45, 0, lin ? 0.30 : 0.6);
  liftNormals(geo, lin ? 0.17 : 0.35);
  windAttr(geo, (x, y) => Math.pow(Math.min(1, y / spec.h), 1.6) * 0.45);
  return geo;
}

/**
 * Fountain: octagonal basin, moulded rim, pedestal, upper bowl, and a jet.
 * The water surfaces carry a NEGATIVE wind weight so the shared shader ripples
 * them vertically. From street level these are the landmarks of a plaza.
 */
function makeFountain(scale, tiers) {
  const parts = [];
  // Each part is tagged as it is built — deriving "is this water?" from vertex
  // height after the merge is guesswork, and guessing wrong makes the stonework
  // wobble. `lit` is the same idea for the night pass: NEGATIVE is a cool light
  // source (the submerged fixtures), and just OVER 1 is warm stone lit by them,
  // always on rather than hash-gated — half the fountains in a plaza going dark
  // at random is not a lighting scheme.
  const push = (g, w, lit = 0) => { windAttr(g, () => w); glowAttr(g, () => lit); parts.push(g); };
  const R = 3.1 * scale;
  const rimH = 0.62 * scale;

  // The stone is washed by the water it holds, so the rim gets a little of the
  // warm-side glow rather than none at all.
  push(ringWall(R * 0.86, R, rimH, 0, 8, 'stoneTex'), 0, 1.12);
  // Basin floor, sunk a little so the rim reads as a lip.
  push(disc(R * 0.87, 8, 0, rimH * 0.55, 0, 'waterDisc'), -1.0, -0.85);

  const ped = trunkGeo(rimH * 1.9, R * 0.22, R * 0.16, 'stoneTex', { sides: 8, rings: 2 });
  ped.translate(0, rimH * 0.5, 0);
  push(ped, 0, 1.18);

  let topY = rimH * 2.4;
  for (let i = 0; i < tiers; i++) {
    const br = R * (0.46 - i * 0.14);
    push(ringWall(br * 0.78, br, 0.22 * scale, topY, 8, 'stoneTex'), 0, 1.14);
    push(disc(br * 0.79, 8, 0, topY + 0.15 * scale, 0, 'waterDisc'), -0.7, -0.8);
    const stem = trunkGeo(0.9 * scale, br * 0.24, br * 0.18, 'stoneTex', { sides: 6, rings: 1 });
    stem.translate(0, topY + 0.2 * scale, 0);
    push(stem, 0, 1.16);
    topY += 1.1 * scale;
  }

  /* Jet: a tapered column of water. It gets a positive (foliage) weight so it
     sways instead of bobbing — a jet leans in the wind, it does not pulse. */
  const jet = trunkGeo(1.6 * scale, 0.10 * scale, 0.035 * scale, 'sw_white', { sides: 5, rings: 3 });
  jet.translate(0, topY, 0);
  windAttr(jet, (x, y) => Math.max(0, (y - topY) / (1.6 * scale)) * 0.5);
  // Brightest where it leaves the nozzle and the fixture is pointing at it.
  glowAttr(jet, (x, y) => -1.15 + Math.min(0.7, Math.max(0, y - topY) * 0.4));
  parts.push(jet);
  // The bead of spray at the top of the jet.
  const bead = disc(0.34 * scale, 8, 0, topY + 1.62 * scale, 0, 'sw_white');
  windAttr(bead, () => 0.55);
  glowAttr(bead, () => -0.5);
  parts.push(bead);

  return BufferGeometryUtils.mergeGeometries(parts, false);
}

/**
 * Park path lamp: a stepped cast base, a tapered column and a frosted lantern.
 *
 * props.js owns the street lighting (`lampPark`, `lampModern`, `lampDeco`) and
 * runs it along kerbs; this one exists because a park's path network is inside
 * the parcel, where street furniture never goes, and an unlit path loop is a
 * black stripe through the middle of every park after sunset. Different kind
 * name on purpose — the audit groups by kind and two modules sharing one makes
 * it lie.
 */
function makeParkLamp() {
  const parts = [];
  const H = 4.3;
  parts.push(mapUV(box(0.52, 0.16, 0.52, 0, 0.08, 0, 1), uvOf('stoneTex')));
  parts.push(mapUV(box(0.40, 0.26, 0.40, 0, 0.29, 0, 1), uvOf('stoneTex')));
  parts.push(trunkGeo(H - 0.42, 0.10, 0.065, 'sw_steel', { sides: 6, rings: 3 })
    .translate(0, 0.42, 0));
  // Lantern: a short tapered glass drum under a cap. Six sides is enough at the
  // distance a 4 m lamp is ever seen from, and it keeps the pool cheap.
  const glass = trunkGeo(0.62, 0.20, 0.26, 'sw_white', { sides: 6, rings: 1 });
  glass.translate(0, H - 0.62, 0);
  parts.push(glass);
  parts.push(mapUV(box(0.62, 0.10, 0.62, 0, H - 0.01, 0, 1), uvOf('sw_steel')));
  const geo = BufferGeometryUtils.mergeGeometries(parts, false);
  windAttr(geo, () => 0);
  // >1 means "a fixture, always lit". A lamp that only comes on for a third of
  // the posts on the path is worse than no lamps at all — which is exactly what
  // the hash-gated branch would do to it. The column just under the lantern
  // catches a little of its own light.
  glowAttr(geo, (x, y) => (y > H - 0.75 ? 2.45 : y > H - 1.6 ? 1.22 : 0));
  return geo;
}

/**
 * A stemless rosette — agave, yucca, bird of paradise. Crossed cards hinged at
 * the ground, so its whole footprint is the 30 cm the leaves actually rise
 * from, not the metre they spread over.
 */
function makeRosette(cell, w, h, cards = 3) {
  const parts = [];
  for (let i = 0; i < cards; i++) {
    const g = cardGeo(w, h, cell);
    g.rotateY((i / cards) * Math.PI + i * 0.17);
    parts.push(g);
  }
  const geo = BufferGeometryUtils.mergeGeometries(parts, false);
  radialNormals(geo, 0, h * 0.35, 0, 0.55);
  liftNormals(geo, 0.3);
  // Stiff, succulent leaves. They barely move — that stillness against a
  // swaying palm is half of why the silhouette contrast reads.
  windAttr(geo, (x, y) => Math.pow(Math.min(1, y / h), 2.2) * 0.10);
  return geo;
}

/** Raised plaza planter: a stone box with a shrub mass sitting in it. */
function makePlanter(w, d, h) {
  const parts = [];
  const t = 0.22;
  parts.push(mapUV(box(w, h, t, 0, h / 2, -d / 2 + t / 2, 1.2), uvOf('stoneTex')));
  parts.push(mapUV(box(w, h, t, 0, h / 2, d / 2 - t / 2, 1.2), uvOf('stoneTex')));
  parts.push(mapUV(box(t, h, d - t * 2, -w / 2 + t / 2, h / 2, 0, 1.2), uvOf('stoneTex')));
  parts.push(mapUV(box(t, h, d - t * 2, w / 2 - t / 2, h / 2, 0, 1.2), uvOf('stoneTex')));
  parts.push(mapUV(box(w, 0.1, d, 0, h - 0.16, 0, 1.2), uvOf('mulchTex')));
  // Planting: three crossed cards rising out of the box.
  const bushH = Math.max(1.1, Math.min(w, d) * 0.95);
  for (let i = 0; i < 3; i++) {
    const c = cardGeo(Math.min(w, d) * 1.15, bushH, 'shrubA');
    c.rotateY((i / 3) * Math.PI + i * 0.2);
    c.translate(0, h - 0.2, 0);
    parts.push(c);
  }
  const geo = BufferGeometryUtils.mergeGeometries(parts, false);
  liftNormals(geo, 0.2);
  windAttr(geo, (x, y) => (y > h ? Math.min(1, (y - h) / bushH) * 0.4 : 0));
  return geo;
}

/** Shade pergola: four posts, a header beam, slatted top. */
function makePergola(w, d, h) {
  const parts = [];
  const p = 0.16;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(mapUV(box(p, h, p, sx * (w / 2 - p), h / 2, sz * (d / 2 - p), 1), uvOf('sw_wood')));
    }
  }
  parts.push(mapUV(box(w, 0.18, p * 1.4, 0, h, -d / 2 + p, 1), uvOf('sw_wood')));
  parts.push(mapUV(box(w, 0.18, p * 1.4, 0, h, d / 2 - p, 1), uvOf('sw_wood')));
  const slats = Math.max(4, Math.round(w / 0.75));
  for (let i = 0; i < slats; i++) {
    const x = -w / 2 + (i + 0.5) * (w / slats);
    parts.push(mapUV(box(0.13, 0.16, d, x, h + 0.16, 0, 1), uvOf('sw_wood')));
  }
  const geo = BufferGeometryUtils.mergeGeometries(parts, false);
  windAttr(geo, () => 0);
  return geo;
}

/** Abstract public art: three stacked, rotated slabs. Tinted per instance. */
function makeSculpture(seed) {
  const rng = makeRNG(seed);
  const parts = [];
  let y = 0;
  parts.push(box(2.6, 0.4, 2.6, 0, 0.2, 0, 1));
  y = 0.4;
  for (let i = 0; i < 3; i++) {
    const w = 2.1 - i * 0.42, h = 1.5 + rng() * 1.6, d = 0.85 - i * 0.14;
    const g = box(w, h, d, 0, h / 2, 0, 1);
    g.rotateY(rng() * Math.PI);
    g.translate((rng() - 0.5) * 0.4, y, (rng() - 0.5) * 0.4);
    parts.push(g);
    y += h * 0.86;
  }
  return BufferGeometryUtils.mergeGeometries(parts, false);
}

/** Bandshell: a quarter-barrel acoustic shell over a stage. */
function makeBandshell() {
  const parts = [];
  const W = 13, D = 8, H = 7.4;
  parts.push(mapUV(box(W + 2.4, 0.9, D + 2.0, 0, 0.45, 0, 2), uvOf('stoneTex')));
  const segs = 9;
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI, a1 = ((i + 1) / segs) * Math.PI;
    const am = (a0 + a1) / 2;
    const th = (a1 - a0) * (W / 2) * 1.06;
    const g = box(th, 0.36, D * 0.94, 0, 0, 0, 2);
    g.rotateZ(-(am - Math.PI / 2));
    g.translate(Math.cos(am) * (W / 2), 0.9 + Math.sin(am) * H * 0.78, -D * 0.18);
    parts.push(mapUV(g, uvOf('sw_cream')));
  }
  // Back wall closing the shell.
  parts.push(mapUV(box(W, H * 0.72, 0.4, 0, 0.9 + H * 0.36, -D * 0.62, 2), uvOf('stoneTex')));
  const geo = BufferGeometryUtils.mergeGeometries(parts, false);
  windAttr(geo, () => 0);
  return geo;
}

/** Basketball hoop: post, arm, backboard, ring. */
function makeHoop() {
  const parts = [];
  parts.push(mapUV(box(0.18, 3.6, 0.18, 0, 1.8, 0, 1), uvOf('sw_steel')));
  parts.push(mapUV(box(1.1, 0.14, 0.14, 0.55, 3.55, 0, 1), uvOf('sw_steel')));
  parts.push(mapUV(box(0.08, 1.05, 1.75, 1.12, 3.35, 0, 1), uvOf('sw_white')));
  parts.push(mapUV(box(0.5, 0.07, 0.5, 1.35, 3.05, 0, 1), uvOf('sw_coral')));
  const geo = BufferGeometryUtils.mergeGeometries(parts, false);
  windAttr(geo, () => 0);
  return geo;
}

/** Playground climbing frame + slide. Bright, chunky, obviously a toy. */
function makePlayground() {
  const parts = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(mapUV(box(0.16, 2.4, 0.16, sx * 1.3, 1.2, sz * 1.1, 1), uvOf('sw_aqua')));
    }
  }
  parts.push(mapUV(box(2.9, 0.18, 2.4, 0, 1.6, 0, 1), uvOf('sw_sun')));
  parts.push(mapUV(box(2.9, 0.5, 0.14, 0, 2.1, -1.1, 1), uvOf('sw_coral')));
  const slide = box(0.9, 0.14, 3.4, 0, 0, 0, 1);
  slide.rotateX(0.55);
  slide.translate(1.9, 1.05, 0.9);
  parts.push(mapUV(slide, uvOf('sw_pink')));
  // A-frame swing beside it.
  for (const sx of [-1, 1]) {
    const l = box(0.14, 2.6, 0.14, 0, 1.3, 0, 1);
    l.rotateZ(sx * 0.22);
    l.translate(sx * 1.9 - 3.6, 0, 0);
    parts.push(mapUV(l, uvOf('sw_teal')));
  }
  parts.push(mapUV(box(4.0, 0.16, 0.16, -3.6, 2.55, 0, 1), uvOf('sw_teal')));
  for (const sx of [-1, 1]) {
    parts.push(mapUV(box(0.05, 1.5, 0.05, -3.6 + sx * 0.7, 1.8, 0, 1), uvOf('sw_steel')));
    parts.push(mapUV(box(0.5, 0.09, 0.22, -3.6 + sx * 0.7, 1.05, 0, 1), uvOf('sw_sun')));
  }
  const geo = BufferGeometryUtils.mergeGeometries(parts, false);
  windAttr(geo, () => 0);
  return geo;
}

/** Flag pole with a stiffened banner — the banner catches the wind shader. */
function makeFlagpole(cell) {
  const parts = [];
  const H = 9.5;
  parts.push(mapUV(box(0.7, 0.3, 0.7, 0, 0.15, 0, 1), uvOf('stoneTex')));
  parts.push(trunkGeo(H, 0.11, 0.06, 'sw_steel', { sides: 5, rings: 2 }));
  const flag = cardGeo(2.4, 1.5, cell);
  flag.translate(1.2, 0, 0);
  flag.translate(0, H - 1.9, 0);
  parts.push(flag);
  const geo = BufferGeometryUtils.mergeGeometries(parts, false);
  windAttr(geo, (x, y) => (y > H - 2.1 ? Math.min(1, x / 2.4) * 0.9 : 0));
  return geo;
}

/* ======================================================================== */
/*  SPECIES TABLE                                                           */
/* ======================================================================== */

/**
 * A SPECIES IS A RANGE, NOT A SPECIMEN.
 *
 * This is the fix for the loudest defect in the module. Every palm in Miami
 * used to be one of six geometries; a boulevard planted with `royalA` was
 * literally the same mesh 40 times over, differing only by y-rotation and a
 * +-15% scale, and from the game camera a uniform scale on a rotationally
 * symmetric crown is not a difference you can see. A row of identical assets
 * is a stated defect and that is exactly what it was.
 *
 * So each entry carries a `base` and a variant COUNT, and `make` re-rolls the
 * whole specimen from a per-variant seed: overall height, trunk thickness and
 * taper, the direction AND amount of lean, crown diameter, frond count, frond
 * width, how steeply the crown is pitched and how far it droops, and which
 * atlas cells its blades are cut from. Four to five variants per species, each
 * a genuinely different tree.
 *
 * Stacked on top of that, per instance and costing no draw calls at all:
 *   - `tints` picks a foliage colour from a set, applied ONLY to leaf vertices
 *     (see installNatureShader) so crowns vary in hue and value while the bark
 *     stays bark;
 *   - a continuous scale, a free rotation, and for trees a small planted-crooked
 *     tilt with the base sunk to match.
 *
 * ---------------------------------------------------------------------------
 * The rest of the fields
 * ---------------------------------------------------------------------------
 * `h` is the nominal height in metres at scale 1 — every scale multiplier in
 * this file is relative to that, so the metric sanity in the art bible holds.
 *
 * `clear` is read against the SHARED occupancy grid and is about other modules.
 * `sep` is nature's own personal space, enforced even on forced placements, and
 * it is deliberately much smaller than the crown: a hedge run wants its units
 * to interlock at 3.2 m centres, so hedge sep is 1.05, not the 2.3 m its cards
 * actually span. Two seps must sum to less than the spacing a run asks for or
 * the run silently thins out.
 *
 * `cap` is the pool ceiling for the species, split across its variants. Spare
 * capacity costs 76 bytes and no draw calls (finalize() sets mesh.count), a
 * full pool costs silent missing planting — so every one is sized well above
 * what the city uses.
 *
 * `rBase` is the trunk radius at ground level, used to sink a tilted instance
 * far enough that its base does not lift off the pavement.
 *
 * `contactMax` is the largest ground footprint this species may legitimately
 * have. worldBuild measures the real one off the lowest fifth of the geometry;
 * if a crown ever sags into that band again the boot log says so by name.
 */

/**
 * PROPORTION NOTE. A botanically correct royal palm is a 15 m pole with a 6 m
 * tuft, and at game distance that renders as a telegraph pole. The art bible
 * calls for chunky, confident, readable shapes, so every palm below is stockier
 * and much more crowned than the real thing: crown spread runs 70-90% of total
 * height. `crownF` ties frond length to the trunk height the variant rolled, so
 * a short palm gets a short crown instead of a bus shelter on a stick.
 */
function palmVariant(b, r) {
  const h = b.h * (0.80 + r() * 0.44);
  // One lean, in one random compass direction. Rolling bend and sway
  // independently gives a population whose average lean is diagonal.
  const la = r() * 6.283;
  const lk = b.lean * (0.2 + r() * 1.7);
  const cells = b.cells.slice();
  if (r() < 0.5) cells.reverse();
  // A third of palms swap one of their two blade cells for another, which is
  // what stops two variants that rolled similar proportions reading as twins.
  // `swapP` exists because one swap is not like the others: swapping frondA for
  // frondC changes a crown's texture, but swapping fanA for fanBlue changes its
  // COLOUR, and a fifth of a species is the most of that a boulevard can take.
  if (b.swap && r() < (b.swapP ?? 0.34)) cells[0] = b.swap;
  return makePalm({
    seed: b.seed * 31 + Math.floor(r() * 8192),
    h,
    rBot: b.rBot * (0.86 + r() * 0.30),
    rTop: b.rTop * (0.84 + r() * 0.34),
    bark: b.bark,
    crownshaft: b.crownshaft,
    bend: Math.cos(la) * lk,
    sway: Math.sin(la) * lk,
    bulge: (b.bulge || 0) * (0.5 + r() * 1.0),
    sides: b.sides,
    fronds: Math.max(7, b.fronds + Math.round((r() - 0.5) * (b.frondVar || 4))),
    frondLen: h * b.crownF * (0.86 + r() * 0.30),
    frondW: b.frondW * (0.84 + r() * 0.34),
    pitch: b.pitch + (r() - 0.5) * 0.52,
    rise: b.rise * (0.80 + r() * 0.46),
    droop: b.droop * (0.82 + r() * 0.40),
    coconuts: !!b.coconuts && r() < 0.72,
    /* The crown asymmetries. Every variant rolls its own bearing for each, so
       the shape of the crown — not just its size — differs variant to variant.
       `flag` is always on and always somewhere different; the gap and the
       spiral fire on a minority, because a city where every palm is visibly
       storm-damaged is its own kind of uniform. */
    flag: (b.flag ?? 0.42) * (0.25 + r() * 0.95),
    flagDir: r() * 6.283,
    gap: r() < 0.36 ? 0.28 + r() * 0.40 : 0,
    gapDir: r() * 6.283,
    spiral: r() < 0.42,
    skirt: b.skirt ? Math.round(b.skirt * (0.55 + r() * 0.9)) : 0,
    cells,
  });
}

/** Clumping palm: stem count is the variant's loudest choice. */
function clumpVariant(b, r) {
  return makeClumpPalm({
    seed: b.seed * 31 + Math.floor(r() * 8192),
    h: b.h * (0.80 + r() * 0.46),
    stems: b.stems + Math.round((r() - 0.5) * 2.4),
    taper: b.taper * (0.7 + r() * 0.7),
    splay: b.splay * (0.6 + r() * 0.9),
    rBot: b.rBot * (0.86 + r() * 0.3),
    bark: b.bark,
    fronds: b.fronds,
    frondLen: b.h * b.crownF * (0.88 + r() * 0.28),
    frondW: b.frondW * (0.86 + r() * 0.3),
    pitch: b.pitch + (r() - 0.5) * 0.4,
    cells: b.cells,
  });
}

function whorlVariant(b, r) {
  return makeWhorl({
    seed: b.seed * 31 + Math.floor(r() * 8192),
    trunkH: b.trunkH * (0.6 + r() * 0.9),
    rBot: b.rBot * (0.85 + r() * 0.35),
    bark: b.bark,
    leaves: Math.max(5, b.leaves + Math.round((r() - 0.5) * (b.leafVar || 4))),
    len: b.len * (0.82 + r() * 0.40),
    wide: b.wide * (0.86 + r() * 0.30),
    pitch: b.pitch + (r() - 0.5) * 0.42,
    pitchVar: b.pitchVar,
    rise: b.rise * (0.85 + r() * 0.34),
    droop: b.droop * (0.82 + r() * 0.4),
    rank: b.rank,
    cell: b.cell,
    flex: b.flex,
  });
}

function treeVariant(b, r) {
  const h = b.h * (0.80 + r() * 0.44);
  const la = r() * 6.283;
  const lk = (b.lean || 0.04) * (0.2 + r() * 1.7);
  return makeTree({
    seed: b.seed * 31 + Math.floor(r() * 8192),
    h,
    trunkF: b.trunkF * (0.88 + r() * 0.26),
    rBot: b.rBot * (0.85 + r() * 0.32),
    rTop: b.rTop * (0.85 + r() * 0.32),
    bark: b.bark,
    bend: Math.cos(la) * lk,
    sway: Math.sin(la) * lk,
    limbs: Math.max(1, b.limbs + (r() < 0.4 ? 1 : 0)),
    canopyR: h * b.crownF * (0.86 + r() * 0.30),
    canopyF: b.canopyF * (0.84 + r() * 0.34),
    cell: b.cells && r() < 0.3 ? b.cells[Math.floor(r() * b.cells.length)] : b.cell,
  });
}

function bushVariant(b, r) {
  // `hVar` widens the height roll for the species that get planted in long
  // runs. A hedge line whose units are all within +-19% of each other reads as
  // one extruded box however many variants it has; at +-31% it reads as a
  // hedge someone has been clipping for years.
  const hv = b.hVar ?? 0.38;
  return makeBush({
    seed: b.seed * 31 + Math.floor(r() * 8192),
    w: b.w * (0.86 + r() * 0.30),
    h: b.h * (1.01 - hv * 0.5 + r() * hv),
    cell: b.cell,
    cards: b.cards,
    depth: b.depth ? b.depth * (0.85 + r() * 0.3) : 0,
    top: b.top,
  });
}

/**
 * Per-instance foliage tint sets.
 *
 * NOT new colours — these are MULTIPLIERS against the atlas, which is already
 * painted from PALETTE. Every one sits between 0xd0 and 0xff per channel: far
 * enough apart that two neighbouring crowns read as two plants, near enough to
 * white that nothing leaves the Miami grade or goes muddy. The shader applies
 * them to leaf vertices only, so bark and stone are untouched.
 */
const TINT_SETS = {
  palm: [0xffffff, 0xf4fbe4, 0xe0f1ea, 0xfff5dc, 0xe8f7cc, 0xdaeadd, 0xfaf0da, 0xecf8d4],
  canopy: [0xffffff, 0xeff8de, 0xdcedE2, 0xfdf3d6, 0xe4f4c9, 0xd3e5d4, 0xf6efd6, 0xe2f2dd],
  shrub: [0xffffff, 0xedf8d5, 0xd5ebd0, 0xfaf4d3, 0xe0f2c3, 0xcce2cb, 0xf2ecce, 0xd9efd6],
  bloom: [0xffffff, 0xffe7f0, 0xffd7c6, 0xfff0d2, 0xf4e0ff, 0xffe0e0, 0xfff8e6, 0xffd6e8],
  // A Bismarckia's whole point is that it is NOT green, and the multiply can
  // only ever take colour away — so this set varies the warmth of the silver
  // and nothing else. A green tint here would quietly undo the cell.
  glaucous: [0xffffff, 0xf3f7f0, 0xe9f3f6, 0xfbf4e8, 0xeef5ea, 0xf7f2ec],
  none: [0xffffff],
};

const SPECIES = {
  royalA: {
    label: 'Royal Palm', tier: TIER.LARGE, h: 13.5, rad: 1.7, cap: 1300, clear: 2.8, sep: 1.5,
    debris: PALETTE.PALM_FROND, variants: 8, tints: 'palm', rBase: 0.55, contactMax: 1.9,
    make: palmVariant,
    base: {
      seed: 11, h: 13.0, rBot: 0.55, rTop: 0.42, bark: 'barkRoyal', crownshaft: true,
      lean: 0.028, bulge: 0.12, fronds: 13, frondVar: 5, crownF: 0.40, frondW: 0.50,
      pitch: 0.34, rise: 0.44, droop: 0.98, cells: ['frondA', 'frondB'], swap: 'frondC',
      // A royal is a groomed street tree: it is combed by the wind but nobody
      // lets it keep a skirt.
      flag: 0.34,
    },
  },
  royalB: {
    label: 'Royal Palm', tier: TIER.LARGE, h: 10.4, rad: 1.6, cap: 1100, clear: 2.6, sep: 1.45,
    debris: PALETTE.PALM_FROND, variants: 7, tints: 'palm', rBase: 0.50, contactMax: 1.8,
    make: palmVariant,
    base: {
      seed: 23, h: 10.4, rBot: 0.50, rTop: 0.40, bark: 'barkRoyal', crownshaft: true,
      lean: 0.040, bulge: 0.16, fronds: 12, frondVar: 5, crownF: 0.44, frondW: 0.54,
      pitch: 0.42, rise: 0.48, droop: 1.02, cells: ['frondB', 'frondA'], swap: 'frondD',
      flag: 0.38,
    },
  },
  queenPalm: {
    label: 'Queen Palm', tier: TIER.LARGE, h: 11.2, rad: 1.6, cap: 900, clear: 2.6, sep: 1.4,
    debris: PALETTE.PALM_FROND, variants: 6, tints: 'palm', rBase: 0.40, contactMax: 1.7,
    make: palmVariant,
    base: {
      seed: 29, h: 11.2, rBot: 0.40, rTop: 0.33, bark: 'barkQueen', crownshaft: false,
      lean: 0.060, bulge: 0.06, fronds: 14, frondVar: 4, crownF: 0.42, frondW: 0.42,
      // The queen palm's signature: long, fine, plumose fronds hanging almost
      // vertically off a slender grey trunk.
      pitch: 0.06, rise: 0.34, droop: 1.28, cells: ['frondC', 'frondA'], swap: 'frondD',
      flag: 0.46, skirt: 3,
    },
  },
  coconutA: {
    label: 'Coconut Palm', tier: TIER.LARGE, h: 10.6, rad: 1.7, cap: 1100, clear: 2.7, sep: 1.5,
    debris: PALETTE.PALM_FROND, variants: 7, tints: 'palm', rBase: 0.48, contactMax: 1.8,
    make: palmVariant,
    base: {
      seed: 37, h: 10.6, rBot: 0.48, rTop: 0.34, bark: 'barkCoco', crownshaft: false,
      lean: 0.115, bulge: 0, fronds: 11, frondVar: 4, crownF: 0.46, frondW: 0.50,
      pitch: 0.10, rise: 0.40, droop: 1.10, coconuts: true,
      cells: ['frondB', 'frondA'], swap: 'frondD',
      // A coconut on a seafront is the most obviously wind-combed tree there is.
      flag: 0.62, skirt: 2,
    },
  },
  coconutB: {
    label: 'Coconut Palm', tier: TIER.LARGE, h: 8.0, rad: 1.6, cap: 800, clear: 2.5, sep: 1.4,
    debris: PALETTE.PALM_FROND, variants: 5, tints: 'palm', rBase: 0.46, contactMax: 1.7,
    make: palmVariant,
    base: {
      seed: 41, h: 8.0, rBot: 0.46, rTop: 0.32, bark: 'barkCoco', crownshaft: false,
      lean: 0.165, bulge: 0, fronds: 10, frondVar: 4, crownF: 0.53, frondW: 0.56,
      pitch: -0.05, rise: 0.36, droop: 1.16, coconuts: true,
      cells: ['frondA', 'frondB'], swap: 'frondC',
      flag: 0.70, skirt: 3,
    },
  },
  sabal: {
    label: 'Sabal Palm', tier: TIER.LARGE, h: 8.4, rad: 1.5, cap: 1100, clear: 2.4, sep: 1.35,
    debris: PALETTE.PALM_FROND, variants: 6, tints: 'palm', rBase: 0.40, contactMax: 1.6,
    make: palmVariant,
    base: {
      // frondW 1.02, not 1.25. `palmVariant` multiplies it by 0.84-1.18, so at
      // 1.25 a blade came out up to 1.5x WIDER than it is long and fourteen of
      // them tiled the crown solid whatever their pitch. A costapalmate fan is
      // about as wide as long; at 1.02 the blades read as blades.
      seed: 53, h: 8.4, rBot: 0.40, rTop: 0.35, bark: 'barkFib', crownshaft: false,
      lean: 0.030, bulge: 0, fronds: 14, frondVar: 5, crownF: 0.37, frondW: 1.02,
      pitch: 0.34, rise: 0.58, droop: 0.80, cells: ['fanA'],
      /* One variant in six carries the silver fan instead of the green one.
         There are only a dozen park parcels in the whole city, so however hard
         a park weights a Bismarckia there will never be many of them — and a
         handful of specimens is not enough silver to change what the planting
         reads AS from the game camera. A silver-fanned fan palm is a real and
         common Miami plant (Latania, the glaucous sabal forms), it costs one
         extra pool, and it spreads the one non-green hue in the file across the
         medians, the street lines and the plazas where the camera actually is. */
      swap: 'fanBlue', swapP: 0.17,
      // The straw petticoat of shed fronds is the ONE thing that tells a sabal
      // apart from every other palm on the street at 60 m.
      flag: 0.30, skirt: 7,
    },
  },
  /* Saw palmetto, not a tree.
     This entry used to be a 3.6 m trunk with a 3 m fan on top of it, i.e. a
     5.8 m palm — and every caller uses it as ground-level mass: the ring round
     a piece of public art, the chunky band inside a plaza border. Four palms at
     4.6 m radius around a 6 m sculpture simply hid the sculpture. A palmetto is
     a clumping shrub with a stub of trunk, it is the commonest plant in south
     Florida, and it is what those call sites were always asking for. */
  fanShort: {
    label: 'Saw Palmetto', tier: TIER.SMALL, h: 2.1, rad: 1.5, cap: 1100, clear: 1.2, sep: 0.85,
    debris: PALETTE.PALM_FROND, variants: 5, tints: 'palm', rBase: 0.34, contactMax: 1.2,
    make: palmVariant,
    base: {
      seed: 67, h: 1.15, rBot: 0.34, rTop: 0.30, bark: 'barkFib', crownshaft: false,
      lean: 0.16, bulge: 0, fronds: 13, frondVar: 5, crownF: 1.15, frondW: 1.30,
      // Pitched up and barely drooping, and a gentle flag. On a 1.1 m trunk the
      // contact band is only ~40 cm off the ground, so a frond that sagged the
      // way a coconut's does would land IN it and hand a waist-high shrub the
      // pass radius of a car.
      // Silver saw palmetto is the commonest glaucous plant in south Florida
      // and it puts the hue at ankle height, against paving, where a plaza
      // border otherwise reads as one green texture with dots in it.
      pitch: 0.42, rise: 0.60, droop: 0.62, cells: ['fanA'], flag: 0.35,
      swap: 'fanBlue', swapP: 0.30,
    },
  },
  arecaClump: {
    label: 'Areca Palm', tier: TIER.LARGE, h: 7.0, rad: 2.0, cap: 900, clear: 2.4, sep: 1.5,
    debris: PALETTE.PALM_FROND, variants: 5, tints: 'palm', rBase: 0.36, contactMax: 1.5,
    make: clumpVariant,
    base: {
      seed: 173, h: 6.6, stems: 5, taper: 0.40, splay: 0.085, rBot: 0.17,
      bark: 'barkQueen', fronds: 8, crownF: 0.50, frondW: 0.42, pitch: 0.34,
      cells: ['frondC', 'frondA', 'frondB'],
    },
  },
  /* THE ONE WITH THE WRONG PROPORTIONS.
     Not "the tall one" — that was the first guess and measuring killed it. The
     variant roll (0.80-1.24) and the instance scale (0.84-1.18) compound to a
     2.2x spread, so the built population of a "13.5 m" royal palm already runs
     from 11.6 m to 24.6 m and the skyline of a palm line is anything but flat.
     What every palm above DOES share is a PROPORTION: a fat crown sitting
     straight on top of a trunk about twice the crown's width. Scale cannot
     break that, and it is the proportion, not the height, that makes a
     boulevard read as one asset stamped forty times.
     A Washingtonia inverts it — a long bare stick, a crown a fifth of its
     height, and a shaggy petticoat of shed fronds hanging under it. It reuses
     the sabal's fan cell and the sabal's boot bark, so the whole species costs
     five pool slots and not a pixel of new atlas. */
  washingtonia: {
    // 15.5 m nominal, and that number is measured rather than chosen: at a
    // nominal 17 the tall tail of the built population came out past 25 m,
    // taller than the midrises it stands between. At 15.5 it measures 13-23 m,
    // the same band the royals occupy — which is correct. The difference
    // between this palm and a royal is meant to be its shape, not its size.
    label: 'Fan Palm', tier: TIER.LARGE, h: 15.5, rad: 1.3, cap: 700, clear: 2.5, sep: 1.5,
    debris: PALETTE.PALM_FROND, variants: 5, tints: 'palm', rBase: 0.38, contactMax: 1.1,
    make: palmVariant,
    base: {
      seed: 193, h: 15.5, rBot: 0.38, rTop: 0.30, bark: 'barkFib', crownshaft: false,
      // See sabal: a blade wider than it is long tiles a fan crown into a plate.
      lean: 0.030, bulge: 0.05, fronds: 13, frondVar: 4, crownF: 0.21, frondW: 1.06,
      pitch: 0.30, rise: 0.55, droop: 0.86, cells: ['fanA'],
      // crownF 0.21, not the sabal's 0.37: the crown has to stay SMALL relative
      // to the trunk, or this is just a royal palm seen from further away.
      // The petticoat is the other half of the species — nine shed fronds, two
      // more than a sabal, and on a trunk this bare it reads as a collar at
      // 200 m where the crown itself has minified to a dot.
      flag: 0.28, skirt: 9,
    },
  },
  /* THE ONE THAT IS NOT GREEN.
     Thirty species and every single one is a green mass, so from the game
     camera all the planting in Miami is one material with a bumpy top. A
     Bismarckia is a stiff silver-blue disc on a fat short trunk: different
     hue, different silhouette, and a genuine specimen tree — so a handful in
     the parks, the plaza panels and the yards is the honest number, not a
     boulevard of them. `clear` and `sep` are large because the crown really is
     nearly as wide as the plant is tall. */
  bismarck: {
    label: 'Bismarck Palm', tier: TIER.LARGE, h: 8.0, rad: 2.1, cap: 420, clear: 3.0, sep: 1.9,
    debris: PALETTE.PALM_FROND, variants: 4, tints: 'glaucous', rBase: 0.62, contactMax: 1.6,
    make: palmVariant,
    base: {
      /* MEASURED. crownF 0.70 with frondW 1.45 built a blade 0.70x the palm's
         height LONG and 1.0x its height WIDE — on a 9 m specimen, a single
         7.6 x 13 m sheet, fifteen of them overlapping into one silver plate
         15 m across floating on a stub of trunk. From the game camera that is
         not a specimen palm, it is a cabbage. At 0.54 / 0.98 the crown still
         spans about 1.1x the plant's height, which is the proportion this
         species is here for, and the individual fans read as fans. */
      seed: 197, h: 7.6, rBot: 0.62, rTop: 0.50, bark: 'barkFib', crownshaft: false,
      lean: 0.020, bulge: 0.10, fronds: 15, frondVar: 4, crownF: 0.54, frondW: 0.98,
      // Stiff and held high — a Bismarckia does not hang. `droop` well under
      // `rise` keeps every blade tip above its own attachment point, which is
      // also what keeps a 5 m crown out of the contact band the physics
      // measures on a trunk only 7.6 m tall.
      pitch: 0.46, rise: 0.52, droop: 0.44, cells: ['fanBlue'],
      flag: 0.20,
    },
  },

  banyan: {
    label: 'Banyan Tree', tier: TIER.LARGE, h: 13.0, rad: 2.6, cap: 650, clear: 4.2, sep: 2.4,
    debris: PALETTE.TREE_CANOPY, variants: 3, tints: 'canopy', rBase: 0.95, contactMax: 2.6,
    make: treeVariant,
    base: {
      seed: 71, h: 13.0, trunkF: 0.42, rBot: 0.95, rTop: 0.55, bark: 'barkOak',
      lean: 0.03, limbs: 3, crownF: 0.49, canopyF: 0.92,
      cell: 'canopyA', cells: ['canopyA', 'canopyOlive'],
    },
  },
  liveOak: {
    label: 'Live Oak', tier: TIER.LARGE, h: 10.5, rad: 2.1, cap: 800, clear: 3.6, sep: 1.9,
    debris: PALETTE.TREE_CANOPY, variants: 3, tints: 'canopy', rBase: 0.60, contactMax: 2.2,
    make: treeVariant,
    base: {
      seed: 83, h: 10.5, trunkF: 0.46, rBot: 0.60, rTop: 0.36, bark: 'barkOak',
      lean: 0.045, limbs: 2, crownF: 0.45, canopyF: 1.0,
      cell: 'canopyB', cells: ['canopyB', 'canopyA', 'canopyOlive'],
    },
  },
  mahogany: {
    label: 'Mahogany', tier: TIER.LARGE, h: 12.0, rad: 2.2, cap: 600, clear: 3.6, sep: 2.0,
    debris: PALETTE.TREE_CANOPY_DARK, variants: 3, tints: 'canopy', rBase: 0.62, contactMax: 2.2,
    make: treeVariant,
    base: {
      seed: 89, h: 12.0, trunkF: 0.55, rBot: 0.62, rTop: 0.34, bark: 'barkOak',
      lean: 0.035, limbs: 3, crownF: 0.38, canopyF: 0.80,
      cell: 'canopyOlive', cells: ['canopyOlive', 'canopyB'],
    },
  },
  tabebuia: {
    label: 'Tabebuia', tier: TIER.LARGE, h: 8.2, rad: 1.7, cap: 650, clear: 3.0, sep: 1.5,
    debris: PALETTE.FLOWER_YELLOW, variants: 3, tints: 'bloom', rBase: 0.36, contactMax: 1.6,
    make: treeVariant,
    base: {
      seed: 97, h: 8.2, trunkF: 0.52, rBot: 0.36, rTop: 0.22, bark: 'barkOak',
      lean: 0.06, limbs: 2, crownF: 0.43, canopyF: 0.86, cell: 'canopyYel',
    },
  },
  poinciana: {
    label: 'Royal Poinciana', tier: TIER.LARGE, h: 9.4, rad: 2.4, cap: 550, clear: 3.6, sep: 2.0,
    debris: PALETTE.CAR_RED, variants: 3, tints: 'bloom', rBase: 0.55, contactMax: 2.0,
    make: treeVariant,
    base: {
      // The flame tree: a wide, flat, umbrella crown on a short fluted trunk.
      // canopyF well under 1 is what makes it spread rather than mound.
      seed: 103, h: 9.4, trunkF: 0.44, rBot: 0.55, rTop: 0.34, bark: 'barkOak',
      lean: 0.05, limbs: 3, crownF: 0.55, canopyF: 0.62, cell: 'canopyRed',
    },
  },
  jacaranda: {
    label: 'Jacaranda', tier: TIER.LARGE, h: 8.8, rad: 2.0, cap: 500, clear: 3.2, sep: 1.8,
    debris: PALETTE.ACCENT_LILAC, variants: 3, tints: 'bloom', rBase: 0.40, contactMax: 1.8,
    make: treeVariant,
    base: {
      seed: 107, h: 8.8, trunkF: 0.50, rBot: 0.40, rTop: 0.24, bark: 'barkOak',
      lean: 0.055, limbs: 2, crownF: 0.46, canopyF: 0.74, cell: 'canopyPurple',
    },
  },
  bougain: {
    label: 'Bougainvillea', tier: TIER.MEDIUM, h: 4.6, rad: 1.5, cap: 750, clear: 2.4, sep: 1.1,
    debris: PALETTE.FLOWER_MAGENTA, variants: 3, tints: 'bloom', rBase: 0.22, contactMax: 1.2,
    make: treeVariant,
    base: {
      seed: 101, h: 4.6, trunkF: 0.38, rBot: 0.22, rTop: 0.13, bark: 'barkOak',
      lean: 0.08, limbs: 2, crownF: 0.52, canopyF: 0.94, cell: 'canopyPink',
    },
  },
  seagrapeT: {
    /* MEASURED, not chosen. At h 5.0 / crownF 0.62 the built population ran
       6.4-10.3 m tall with a 6-10 m crown — taller than the mangroves, as wide
       as a banyan, and standing on the seawall where it is the closest thing to
       the camera in the waterfront frames. A sea grape is a spreading coastal
       SHRUB-tree; the numbers below measure 4.2-8.1 m with a flat 4.7 m crown,
       which is both correct and small enough that its leaves come out leaf
       sized. canopyF 0.58 is what makes it spread instead of mound. */
    label: 'Sea Grape', tier: TIER.MEDIUM, h: 4.4, rad: 1.9, cap: 650, clear: 2.8, sep: 1.4,
    debris: PALETTE.TREE_CANOPY, variants: 3, tints: 'canopy', rBase: 0.30, contactMax: 1.4,
    make: treeVariant,
    base: {
      // trunkF was 0.34 and the crown hung into the contact band; makeTree now
      // lifts it regardless, but a coastal shrub-tree with a visible fork also
      // just looks more like a sea grape.
      seed: 113, h: 4.4, trunkF: 0.46, rBot: 0.30, rTop: 0.19, bark: 'barkOak',
      lean: 0.11, limbs: 3, crownF: 0.52, canopyF: 0.58, cell: 'seagrape',
    },
  },
  mangrove: {
    label: 'Mangrove', tier: TIER.MEDIUM, h: 4.2, rad: 1.8, cap: 550, clear: 2.6, sep: 1.1,
    debris: PALETTE.TREE_CANOPY_DARK, variants: 3, tints: 'canopy', rBase: 0.40, contactMax: 1.5,
    make: treeVariant,
    base: {
      seed: 127, h: 4.2, trunkF: 0.50, rBot: 0.40, rTop: 0.16, bark: 'barkMang',
      lean: 0.14, limbs: 4, crownF: 0.60, canopyF: 0.70, cell: 'canopyB',
    },
  },

  /* 2,315 instances in the city, and it had TWO geometries. Nothing else in
     this file is repeated a thousand times each, so the hedge run is where "a
     row of identical assets" was literally true. Four variants and a wider roll
     costs two extra pools and nothing per frame. */
  hedge: {
    label: 'Hedge', tier: TIER.SMALL, h: 1.25, rad: 1.7, cap: 4200, clear: 0.0, sep: 1.05,
    debris: PALETTE.HEDGE, variants: 4, tints: 'shrub', contactMax: 2.1,
    // 1.1 m deep: a clipped municipal hedge, not a topiary cube. See makeBush.
    make: bushVariant,
    base: { seed: 131, w: 3.3, h: 1.25, cell: 'shrubA', cards: 2, depth: 1.1, hVar: 0.62 },
  },
  shrub: {
    label: 'Shrub', tier: TIER.SMALL, h: 1.5, rad: 0.95, cap: 2800, clear: 0.7, sep: 0.6,
    debris: PALETTE.HEDGE, variants: 4, tints: 'shrub', contactMax: 1.6,
    make: bushVariant,
    base: { seed: 137, w: 1.9, h: 1.5, cell: 'shrubA', cards: 3 },
  },
  hibiscus: {
    label: 'Hibiscus', tier: TIER.SMALL, h: 1.7, rad: 1.0, cap: 2000, clear: 0.7, sep: 0.62,
    debris: PALETTE.CAR_RED, variants: 3, tints: 'none', contactMax: 1.7,
    // Like the croton, the cell already carries its own colour — a tint
    // multiplier would only wash the flowers back toward the leaves.
    make: bushVariant,
    base: { seed: 191, w: 2.0, h: 1.7, cell: 'hibiscus', cards: 3 },
  },
  sago: {
    label: 'Sago Palm', tier: TIER.SMALL, h: 1.1, rad: 0.9, cap: 1600, clear: 0.7, sep: 0.6,
    debris: PALETTE.TREE_CANOPY_DARK, variants: 3, tints: 'none', rBase: 0.30, contactMax: 1.2,
    make: whorlVariant,
    base: {
      seed: 179, trunkH: 0.36, rBot: 0.30, bark: 'barkFib', leaves: 15, leafVar: 5,
      len: 1.30, wide: 0.30, pitch: 0.46, pitchVar: 0.34, rise: 0.46, droop: 0.52,
      rank: 0, cell: 'cycad', flex: 0.09,
    },
  },
  traveller: {
    label: "Traveller's Palm", tier: TIER.MEDIUM, h: 4.0, rad: 1.6, cap: 700, clear: 1.8, sep: 1.05,
    debris: PALETTE.TREE_CANOPY, variants: 3, tints: 'canopy', rBase: 0.26, contactMax: 1.4,
    make: whorlVariant,
    base: {
      seed: 181, trunkH: 1.00, rBot: 0.26, bark: 'barkFib', leaves: 9, leafVar: 3,
      len: 3.10, wide: 0.34, pitch: 1.05, pitchVar: 0.26, rise: 0.62, droop: 0.40,
      rank: 1, cell: 'paddle', flex: 0.62,
    },
  },
  croton: {
    label: 'Croton', tier: TIER.SMALL, h: 1.35, rad: 0.9, cap: 2400, clear: 0.6, sep: 0.58,
    debris: PALETTE.FLOWER_ORANGE, variants: 4, tints: 'none', contactMax: 1.5,
    // No tint set: the whole point of a croton is that the atlas cell is
    // already five colours, and multiplying a variegated leaf just greys it.
    make: bushVariant,
    base: { seed: 139, w: 1.8, h: 1.35, cell: 'croton', cards: 3 },
  },
  // sep 0.8, not 0.45: a bloom clump is a 2.2 m card, so anything closer than
  // ~1.6 m is one clump standing inside another. That was the map's single
  // biggest cluster of overlapping props before the bed grid was widened, and
  // the spacing set is what keeps it fixed when a new planting pattern lands.
  flowerPink: {
    label: 'Flower Bed', tier: TIER.SMALL, h: 0.95, rad: 1.1, cap: 2200, clear: 0.6, sep: 0.8,
    debris: PALETTE.FLOWER_PINK, variants: 2, tints: 'bloom', contactMax: 1.95,
    make: bushVariant,
    base: { seed: 149, w: 2.2, h: 0.95, cell: 'canopyPink', cards: 2 },
  },
  flowerYellow: {
    label: 'Flower Bed', tier: TIER.SMALL, h: 0.95, rad: 1.1, cap: 2200, clear: 0.6, sep: 0.8,
    debris: PALETTE.FLOWER_YELLOW, variants: 2, tints: 'bloom', contactMax: 1.95,
    make: bushVariant,
    base: { seed: 151, w: 2.2, h: 0.95, cell: 'canopyYel', cards: 2 },
  },
  ornGrass: {
    label: 'Ornamental Grass', tier: TIER.TINY, h: 1.15, rad: 0.6, cap: 3000, clear: 0.5, sep: 0.36,
    debris: PALETTE.GRASS_DRY, variants: 3, tints: 'shrub', contactMax: 1.3,
    make: bushVariant,
    base: { seed: 157, w: 1.5, h: 1.15, cell: 'grassTuft', cards: 3, top: false },
  },
  groundcover: {
    label: 'Groundcover', tier: TIER.TINY, h: 0.42, rad: 1.2, cap: 2600, clear: 0.0, sep: 0.85,
    debris: PALETTE.HEDGE, variants: 2, tints: 'shrub', contactMax: 2.4,
    // A mat, so it is built as a slab (depth) rather than crossed cards, and it
    // keeps its top card — from the game camera the top card IS the plant.
    make: bushVariant,
    base: { seed: 163, w: 2.6, h: 0.42, cell: 'groundcov', cards: 2, depth: 2.0 },
  },
  agave: {
    label: 'Agave', tier: TIER.SMALL, h: 1.25, rad: 0.7, cap: 900, clear: 0.6, sep: 0.62,
    debris: PALETTE.GRASS_DRY, variants: 3, tints: 'none', contactMax: 1.4,
    make: (b, r) => makeRosette(b.cell, b.w * (0.82 + r() * 0.4), b.h * (0.8 + r() * 0.45),
      2 + Math.floor(r() * 2.9)),
    base: { seed: 167, w: 1.7, h: 1.25, cell: 'agave' },
  },

  planterS: {
    label: 'Planter', tier: TIER.MEDIUM, h: 2.0, rad: 1.0, cap: 900, clear: 1.3, sep: 1.0,
    debris: PALETTE.PLANTER, tints: 'shrub',
    geo: () => makePlanter(2.0, 2.0, 0.85),
  },
  planterL: {
    label: 'Raised Planter', tier: TIER.MEDIUM, h: 2.6, rad: 2.4, cap: 700, clear: 2.6, sep: 1.4,
    debris: PALETTE.PLANTER, tints: 'shrub',
    geo: () => makePlanter(5.0, 2.2, 1.05),
  },
  pergola: {
    label: 'Shade Structure', tier: TIER.XLARGE, h: 3.2, rad: 3.4, cap: 140, clear: 3.6, sep: 2.2,
    debris: PALETTE.WOOD_DECK,
    geo: () => makePergola(6.4, 4.2, 3.0),
  },
  fountainS: {
    label: 'Fountain', tier: TIER.XLARGE, h: 3.4, rad: 3.2, cap: 110, clear: 3.6, sep: 2.6,
    debris: PALETTE.WATER_POOL,
    geo: () => makeFountain(1.0, 1),
  },
  fountainL: {
    label: 'Grand Fountain', tier: TIER.HUGE, h: 6.0, rad: 5.2, cap: 60, clear: 5.6, sep: 4.4,
    debris: PALETTE.WATER_POOL,
    geo: () => makeFountain(1.7, 2),
  },
  bandshell: {
    label: 'Bandshell', tier: TIER.HUGE, h: 8.4, rad: 7.5, cap: 24, clear: 8.5, sep: 5.5,
    debris: PALETTE.CONCRETE_WARM,
    geo: () => makeBandshell(),
  },
  playground: {
    label: 'Playground', tier: TIER.XLARGE, h: 2.7, rad: 4.0, cap: 50, clear: 4.5, sep: 3.2,
    debris: PALETTE.FABRIC_AQUA,
    geo: () => makePlayground(),
  },
  hoop: {
    label: 'Basketball Hoop', tier: TIER.MEDIUM, h: 3.6, rad: 0.6, cap: 70, clear: 0.9, sep: 0.4,
    debris: PALETTE.STEEL,
    geo: () => makeHoop(),
  },
  parkLamp: {
    label: 'Park Lamp', tier: TIER.MEDIUM, h: 4.3, rad: 0.4, cap: 1400, clear: 0.9, sep: 0.45,
    debris: PALETTE.LAMP_POST,
    geo: () => makeParkLamp(),
  },
  flagUS: {
    label: 'Flag Pole', tier: TIER.MEDIUM, h: 9.5, rad: 0.5, cap: 100, clear: 1.2, sep: 0.5,
    debris: PALETTE.STEEL,
    geo: () => makeFlagpole('sw_coral'),
  },
  flagCity: {
    label: 'Flag Pole', tier: TIER.MEDIUM, h: 9.5, rad: 0.5, cap: 110, clear: 1.2, sep: 0.5,
    debris: PALETTE.STEEL,
    geo: () => makeFlagpole('sw_aqua'),
  },
};

const PALMS = ['royalA', 'royalB', 'queenPalm', 'coconutA', 'coconutB', 'sabal',
  'fanShort', 'arecaClump', 'washingtonia', 'bismarck'];
const SHADE = ['banyan', 'liveOak', 'mahogany', 'tabebuia', 'poinciana', 'jacaranda', 'bougain'];
/** Everything that reads as a tree from 40 m — used for stats only. */
const CANOPY = [...SHADE, 'seagrapeT', 'mangrove', 'traveller'];

/**
 * Knee-to-chest planting, in rough order of how loud it is.
 *
 * Kept as one list because half a dozen call sites were each carrying their own
 * hand-written weighted mix of the same four species, which is how a park, a
 * plaza border and a forecourt all ended up with the same ground layer. Drawing
 * from one table with per-site weights keeps them different from each other and
 * makes adding a species a one-line change instead of a six-line one.
 */
const UNDER = [
  ['shrub', 20], ['ornGrass', 16], ['croton', 14], ['sago', 11], ['hibiscus', 11],
  ['agave', 9], ['fanShort', 8], ['groundcover', 7], ['traveller', 4],
];

/* ======================================================================== */
/*  MERGE BUCKETS                                                           */
/* ======================================================================== */

/**
 * Every static ground surface in every park and plaza in the city ends up in
 * one of these, and each becomes exactly one mesh. `matFn` is lazy so a bucket
 * nobody fills costs nothing, not even a texture generation.
 */
/**
 * Ground surfaces stack by POLYGON OFFSET, not by height.
 *
 * streets.js paves every block with a sidewalk slab drawn at
 * polygonOffsetFactor -1. At a 40-degree camera 60 m out, one offset unit is
 * worth about 5 cm of depth on a near-horizontal plane — far more than the
 * 1.5 cm we sit above it — so a park lawn placed only by y quietly loses the
 * depth test and the whole park renders as bare pavement. (It did.) Everything
 * here therefore claims an explicit layer above the sidewalk's, matching the
 * scheme streets.js already uses: 1 sidewalk, 5 road markings, 7 ironwork.
 */
function layer(params, depth) {
  return ground({
    ...params,
    polygonOffset: true,
    polygonOffsetFactor: -depth,
    polygonOffsetUnits: -depth * 2,
  });
}

const BUCKET_MATS = {
  /* TURF IS THE BRIGHTEST THING IN THE CITY AND IT SHOULD NOT BE.
   *
   * Measured off the park, waterfront and skyline frames: the lawn panels were
   * reading brighter and more saturated than the sky haze, the pastel facades
   * and every tree canopy standing on them — a flat acid lime that announced
   * itself from 430 m. The texture is not the problem (materials.js paints a
   * good patchy turf, and PALETTE.GRASS is already authored a notch down for
   * exactly this reason); the problem is that a 0.98-rough albedo that high
   * under a 3.5x key light has nowhere to go but the top of the tone curve,
   * which is the bible's own "nothing large should clip" rule.
   *
   * A near-NEUTRAL multiply, deliberately: the three channels are within 3% of
   * each other, so this takes ~23% of the VALUE off and leaves the hue and the
   * saturation exactly where the palette put them. A greener multiply would
   * have darkened it and made it more acid at the same time.
   */
  lawnA: () => layer({ map: Textures.grass(), color: 0xc6cec8, roughness: 0.98 }, 3),
  // The mowing stripe. Same texture, ~14% darker again — mowers lay the blades
  // in opposite directions and that is exactly what you see from the air.
  lawnB: () => layer({ map: Textures.grass(), color: 0xaab2ac, roughness: 0.98 }, 3),
  plazaBase: () => layer({
    map: Textures.paving(512, PALETTE.PLAZA, 'rgba(150,140,120,0.5)', 4), roughness: 0.9,
  }, 3),
  plazaInlay: () => layer({
    map: Textures.paving(512, PALETTE.PLAZA_ALT, 'rgba(120,106,84,0.7)', 10), roughness: 0.86,
  }, 4),
  // The pattern only reads if the accent genuinely contrasts. An 8% darker
  // cream on cream is invisible from the game camera — which is precisely why
  // the plazas looked like empty slabs. Terracotta paver, same family as the
  // crossing aprons streets.js lays, so the city stays coherent.
  plazaAccent: () => layer({
    map: Textures.paving(512, PALETTE.BRICK_PAVER, 'rgba(108,62,42,0.6)', 8), roughness: 0.9,
  }, 4),
  path: () => layer({
    map: Textures.paving(512, PALETTE.BRICK_PAVER, 'rgba(112,68,48,0.55)', 14), roughness: 0.92,
  }, 4),
  mulch: () => layer({ map: Textures.sand(), color: 0x8a6a4c, roughness: 1.0 }, 4),
  sandPit: () => layer({ map: Textures.sand(), roughness: 1.0 }, 4),
  courtHard: () => layer({ color: PALETTE.PATINA, roughness: 0.82 }, 4),
  courtClay: () => layer({ color: PALETTE.TERRACOTTA, roughness: 0.95 }, 4),
  courtLine: () => layer({ color: PALETTE.ROAD_LINE, roughness: 0.7 }, 6),
  // Boxes and steps: they have real height, so they only need enough offset to
  // win where their base face is coplanar with the pavement.
  stone: () => layer({ map: Textures.concrete(512, PALETTE.CONCRETE_WARM), roughness: 0.9 }, 2),
  kerb: () => layer({ color: PALETTE.CURB, roughness: 0.88 }, 2),
  deck: () => layer({ map: Textures.wood(512, PALETTE.WOOD_DECK, 8), roughness: 0.82 }, 3),
  pond: () => pondMaterial(),
};

class Buckets {
  constructor() {
    /** @type {Map<string, THREE.BufferGeometry[]>} */
    this.map = new Map();
  }

  add(key, geo) {
    // Strip the atlas-only attributes. A bucket mixes primitives — `tile` and
    // `box` carry none, `disc` and `ringWall` are tagged for the foliage
    // shader — and mergeGeometries returns NULL when the inputs disagree on
    // their attribute set, which silently deletes the whole bucket. That is how
    // every kerb in the city vanished the first time this was wired up.
    for (const a of ['aWind', 'aTint', 'aGlow']) {
      if (geo.attributes[a]) geo.deleteAttribute(a);
    }
    let a = this.map.get(key);
    if (!a) { a = []; this.map.set(key, a); }
    a.push(geo);
    return geo;
  }

  flush(ctx) {
    let calls = 0, tris = 0;
    for (const [key, geos] of this.map) {
      if (!geos.length) continue;
      const merged = BufferGeometryUtils.mergeGeometries(geos, false);
      if (!merged) continue;
      const m = new THREE.Mesh(merged, BUCKET_MATS[key]());
      m.name = `nature-${key}`;
      m.receiveShadow = true;
      // Ground planes casting shadows onto themselves is pure acne; the only
      // bucket with real height is `stone`, and it earns its shadow.
      m.castShadow = key === 'stone';
      ctx.addDecor(m, 'nature');
      calls++;
      tris += (merged.index ? merged.index.count : merged.attributes.position.count) / 3;
    }
    return { calls, tris };
  }
}

/* ======================================================================== */
/*  WHERE PLANTING IS ALLOWED                                               */
/* ======================================================================== */

/**
 * Four independent reasons a site is not plantable, and the shared occupancy
 * grid answers none of them.
 *
 * Buildings claim occupancy as a SQUARE sized to their circumradius, which on
 * a 40 m parcel swallows the entire pavement — so every kerbside planting in
 * this file passes `force` and skips the read. That bought us street trees and
 * cost us the two tests that actually matter: a full census of all 5,036
 * plants found ~350 standing inside a building's massing, and nothing at all
 * stopped two forced plantings landing on the same square metre.
 *
 * So nature keeps its own answers:
 *   WATER       layout.isWater — mangroves are the one sanctioned exception.
 *   CARRIAGEWAY layout.isRoad — true on a median too, which is why island
 *               planting has to say so explicitly.
 *   FOOTPRINTS  the buildings' MEASURED world AABBs. A trunk may stand right
 *               against a facade; it may not stand in the lobby. Measured, not
 *               derived from the parcel, so it tracks whatever buildings.js
 *               does next.
 *   SPACING     a private point set that forced placements still respect, so
 *               nature can ignore the buildings' over-claim without also
 *               ignoring itself.
 */

const FP_CELL = 24;
/** @type {Map<number, {x0:number,x1:number,z0:number,z1:number}[]>} */
let FOOTPRINTS = new Map();

const hashKey = (x, z, cell) =>
  (Math.floor(x / cell) + 4096) * 8192 + (Math.floor(z / cell) + 4096);

function buildFootprints(ctx) {
  FOOTPRINTS = new Map();
  const grp = ctx.groups && ctx.groups.buildings;
  if (!grp) return 0;
  const box = new THREE.Box3();
  let n = 0;
  for (const root of grp.children) {
    box.setFromObject(root);
    if (!Number.isFinite(box.min.x) || !(box.max.x > box.min.x)) continue;
    // 0.3 m of clearance: a trunk rendered flush against a wall still reads as
    // growing through it.
    const r = {
      x0: box.min.x - 0.3, x1: box.max.x + 0.3,
      z0: box.min.z - 0.3, z1: box.max.z + 0.3,
    };
    const cx0 = Math.floor(r.x0 / FP_CELL), cx1 = Math.floor(r.x1 / FP_CELL);
    const cz0 = Math.floor(r.z0 / FP_CELL), cz1 = Math.floor(r.z1 / FP_CELL);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const k = (cx + 4096) * 8192 + (cz + 4096);
        let a = FOOTPRINTS.get(k);
        if (!a) { a = []; FOOTPRINTS.set(k, a); }
        a.push(r);
      }
    }
    n++;
  }
  return n;
}

function inBuilding(x, z) {
  const a = FOOTPRINTS.get(hashKey(x, z, FP_CELL));
  if (!a) return false;
  for (const r of a) if (x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) return true;
  return false;
}

/**
 * Is there a genuinely open circle of radius `r` here, clear of every building
 * and of the carriageway?
 *
 * `inBuilding` alone answers "is this point in a lobby", which is not the same
 * question as "is there a yard here": a point 40 cm from a curtain wall passes
 * it, and a live oak planted there grows through the third floor. Sampling the
 * circle instead of the point is what makes a forced placement in the middle of
 * a parcel defensible.
 */
function openYard(x, z, r) {
  if (inBuilding(x, z)) return false;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * 6.283;
    if (inBuilding(x + Math.cos(a) * r, z + Math.sin(a) * r)) return false;
  }
  return true;
}

/**
 * How much open pavement there actually is between the kerb and the wall.
 *
 * The parcel says one thing and the building says another: buildings.js caps
 * its pair of setbacks at a third of the parcel depth, so on a shallow lot the
 * facade stands a metre inside the setback this file assumed, and the entire
 * foundation planting line lands in the lobby and is refused. Marching in from
 * the kerb against the measured footprints turns "no planting at all" into
 * "planting against the wall", which is what foundation planting is.
 * (nx, nz) points INWARD, away from the kerb.
 */
function wallDepth(x, z, nx, nz, max) {
  for (let d = 0.6; d <= max; d += 0.35) {
    if (inBuilding(x + nx * d, z + nz * d)) return d;
  }
  return max;
}

const SEP_CELL = 4;
/** @type {Map<number, number[]>} flat [x, z, r, ...] per cell */
let PLANTED = new Map();

/** Is there room for something of personal-space radius `r` centred here? */
function sepFree(x, z, r) {
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const a = PLANTED.get(hashKey(x + i * SEP_CELL, z + j * SEP_CELL, SEP_CELL));
      if (!a) continue;
      for (let k = 0; k < a.length; k += 3) {
        const dx = x - a[k], dz = z - a[k + 1], rr = r + a[k + 2];
        if (dx * dx + dz * dz < rr * rr) return false;
      }
    }
  }
  return true;
}

function sepTake(x, z, r) {
  const k = hashKey(x, z, SEP_CELL);
  let a = PLANTED.get(k);
  if (!a) { a = []; PLANTED.set(k, a); }
  a.push(x, z, r);
}

/**
 * Claim a rectangle in the SHARED grid.
 *
 * Steps, seat walls and amphitheatre terraces are merged surfaces, so they
 * never went through addInstanced and never claimed anything — and the plaza
 * planting that runs after them dropped live oaks into the middle of a flight
 * of steps. A disc at the centroid is not enough for a 20 m run.
 */
function claimBox(ctx, x, z, w, d, r = 1.4) {
  const nx = Math.max(1, Math.ceil(w / 3));
  const nz = Math.max(1, Math.ceil(d / 3));
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= nz; j++) {
      const px = x - w / 2 + (w * i) / nx;
      const pz = z - d / 2 + (d * j) / nz;
      ctx.occupy(px, pz, r);
      sepTake(px, pz, r);
    }
  }
}

/* ======================================================================== */
/*  PLACEMENT                                                               */
/* ======================================================================== */

/**
 * Mix a key and a variant index into a seed.
 *
 * The variant seed MUST NOT be `index` — several species share base seeds and a
 * plain index would make royalA-v2 and royalB-v2 roll the identical sequence of
 * jitters, which is the repetition problem one level up.
 */
function variantSeed(key, v) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  return (Math.imul(h ^ (v + 1), 0x9e3779b1) >>> 0) || 1;
}

/**
 * A well-mixed hash of a world position, 0..2^31.
 *
 * Used to pick a variant and a tint per instance. It must MIX, not just add:
 * the first version was `round(x*7.3 + z*13.1) % n`, and a median runs down a
 * constant x at a constant 9.5 m step, so the term changed by the same amount
 * every tree and every palm on Brickell Avenue drew the same variant.
 */
function posHash(x, z) {
  let h = Math.imul(Math.round(x * 16) + 0x9e3779b9, 0x85ebca6b);
  h ^= Math.imul(Math.round(z * 16) + 0x165667b1, 0xc2b2ae35);
  h ^= h >>> 15;
  return (Math.imul(h, 0x27d4eb2f) >>> 1);
}

/**
 * Check that what a species puts on the ground really is its trunk.
 *
 * worldBuild measures the lowest fifth of the geometry and hands the result
 * straight to the consumption physics, so a crown that sags into that band
 * silently gives a 30 cm sea grape a 3.4 m pass radius. Measuring the same way
 * it does, at build time, turns that from a bug someone has to notice into a
 * line in the boot log naming the species.
 */
function auditContact(key, geo) {
  const def = SPECIES[key];
  if (!def.contactMax) return;
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const hi = bb.min.y + (bb.max.y - bb.min.y) * 0.20;
  const p = geo.attributes.position;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) > hi) continue;
    const x = p.getX(i), z = p.getZ(i);
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  if (!(x1 > x0)) return;
  const r = Math.hypot(x1 - x0, z1 - z0) / 2;
  if (r > def.contactMax) badContact.push(`${key} ${r.toFixed(2)}m > ${def.contactMax}m`);
}
const badContact = [];

const _factories = {};
function factoryFor(key, variant) {
  const fk = `${key}|${variant}`;
  if (!_factories[fk]) {
    _factories[fk] = () => {
      const def = SPECIES[key];
      const geometry = def.make
        ? def.make(def.base, makeRNG(variantSeed(key, variant)))
        : def.geo();
      auditContact(key, geometry);
      return { geometry, material: atlasMaterial() };
    };
  }
  return _factories[fk];
}

const stats = { trees: 0, palms: 0, bushes: 0, features: 0, beds: 0, instances: 0, capped: 0 };
/**
 * Why sites were refused. Reported every boot, because the failure mode of a
 * placement rule is silence: a bad `sep` or an over-wide footprint just thins
 * the city out and nothing says so. If `building` or `spacing` runs away, the
 * planting has gone somewhere it should not have been asked to go.
 */
const rej = { water: 0, road: 0, building: 0, spacing: 0, occupied: 0 };

/**
 * Place one instanced species. Returns the Consumable, or null if the ground
 * was already claimed by a building or another plant.
 */
function plant(ctx, key, x, z, rot, scale, opts = {}) {
  const def = SPECIES[key];

  /* Invariants first, cheapest test first. These hold for FORCED placements
     too — `force` is only ever meant to overrule the buildings' over-claimed
     occupancy square, never the bay, the carriageway or a lobby. */
  if (!opts.shoreline && ctx.layout.isWater(x, z)) { rej.water++; return null; }
  if (!opts.island && ctx.layout.isRoad(x, z)) { rej.road++; return null; }
  if (inBuilding(x, z)) { rej.building++; return null; }
  const sep = opts.sep ?? def.sep;
  if (sep > 0 && !sepFree(x, z, sep)) { rej.spacing++; return null; }

  const clear = opts.clear ?? def.clear;
  if (clear > 0) {
    // `force` skips the read but still writes. Buildings claim a SQUARE of
    // occupancy cells sized to their footprint radius, which on a 40 m block
    // swallows the pavement strip as well — so a street tree that is
    // geometrically fine would be rejected. The kerb strip is ours by
    // construction, so we claim it and let props.js work around us.
    if (!opts.force && !ctx.isFree(x, z, clear)) { rej.occupied++; return null; }
    ctx.occupy(x, z, opts.force ? Math.min(clear, 1.7) : clear);
  } else if (def.h >= 1.1) {
    /* `clear: 0` means "do not RESERVE a clearance", not "this plant is not
       there". A hedge unit, a croton, a palmetto — everything from knee height
       up — is a solid object a person walks around, and pedestrians.js picks
       its standing spots with `ctx.isFree(x, z, 0)`, i.e. one 3 m cell. Passing
       clear 0 skipped the write as well as the read, so the 2,300 hedges were
       invisible to the crowd and the commonest overlapping pair on the map was
       a pedestrian standing inside a hedge. Radius 0 claims exactly the cell the
       plant stands in and nothing more, so it cannot blanket a park the way a
       real clearance would. */
    ctx.occupy(x, z, 0);
  }
  if (sep > 0) sepTake(x, z, sep);

  /* Which of this species' shapes, and what colour crown.
     Both come from the POSITION, not from a counter: a run of street trees
     calls plant() in a loop and any counter-driven choice cycles v0, v1, v2,
     v0, v1, v2 down the whole avenue, which is a pattern the eye locks onto
     faster than it notices the repetition it was meant to hide. `tintIndex`
     stays honoured where a caller genuinely wants a run to step through the
     set, but it now seeds the hash instead of indexing it directly. */
  const h = posHash(x + (opts.tintIndex || 0) * 0.37, z);
  const vN = def.variants || 1;
  const vi = vN > 1 ? h % vN : 0;
  const set = TINT_SETS[def.tints || 'none'];
  const tint = set[(h >>> 7) % set.length];

  /* Planted crooked. A tilt rotates the instance about its base CENTRE, so half
     the base disc goes under the pavement and half lifts off it; sinking by
     rBase*sin(tilt) puts the high edge back on the ground and buries the low
     one, which is what a real tree in a real tree pit looks like. Kept to 2.3
     deg — beyond that a 13 m palm's crown translates several metres sideways
     and starts to overhang things it does not stand over. */
  let tiltX = 0, tiltZ = 0, sink = 0;
  if (def.rBase && !opts.noTilt) {
    const ta = ((h >>> 13) % 1024) / 1024 * 6.283;
    const tk = (((h >>> 3) % 512) / 512) * 0.040;
    tiltX = Math.cos(ta) * tk;
    tiltZ = Math.sin(ta) * tk;
    sink = def.rBase * scale * tk * 1.05;
  }

  const c = ctx.addInstanced(`nat-${key}-v${vi}`, factoryFor(key, vi), {
    position: _v3.set(x, ctx.Y_WALK + (opts.y || 0) - sink, z),
    rotationY: rot,
    tiltX,
    tiltZ,
    scale,
    hex: tint,
    tier: opts.tier || def.tier,
    radius: def.rad * scale,
    height: def.h * scale,
    label: def.label,
    kind: key,
    // Split across the variants, with slack: the position hash is even but not
    // perfectly even, and a pool that fills drops planting silently.
    capacity: Math.ceil((def.cap / vN) * 1.7) + 24,
    castShadow: true,
    receiveShadow: false,
    debrisColor: def.debris,
    decor: opts.decor,
  });
  // A full pool returns null. Counting it would report planting that is not on
  // screen, which is exactly how a capacity ceiling hides for weeks.
  if (!c && !opts.decor) { stats.capped++; return null; }
  stats.instances++;
  if (PALMS.includes(key)) stats.palms++;
  else if (CANOPY.includes(key)) stats.trees++;
  else stats.bushes++;
  return c;
}

/**
 * Try a frontage site, then walk it toward the kerb.
 *
 * The nominal setback is derived from the parcel, but buildings.js caps the
 * pair of setbacks at a third of the parcel depth, so on a shallow lot the
 * building line sits well inside where we wanted the hedge. Nudging outward
 * turns "hedge inside the shopfront, therefore rejected, therefore bare kerb"
 * into a hedge 60 cm further out. (nx, nz) points at the kerb.
 */
function plantOut(ctx, key, x, z, nx, nz, rot, scale, opts, steps = 3, step = 0.6) {
  for (let i = 0; i <= steps; i++) {
    const c = plant(ctx, key, x + nx * i * step, z + nz * i * step, rot, scale, opts);
    if (c) return c;
  }
  return null;
}

/** Circular tree pit / mulch ring under a street tree. Grounds it visually. */
function treePit(B, x, z, r, y) {
  B.add('mulch', disc(r, 8, x, y, z, null));
}

/* -------------------------------------------------------------- medians --- */

/**
 * How far short of a junction streets.js stops the raised island, and the
 * shortest run it will build one on at all.
 *
 * These MIRROR streets.js: NOSE there is CROSS_GAP + CROSS_W + 1.6 = 6.3, and
 * `if (b - a < 18) continue`. This file used to pull back only 3 m and had no
 * minimum length, so it planted royal palms on 40-odd stretches where no island
 * exists — a tree standing 14 cm above bare carriageway, which is precisely the
 * "floating, and growing out of a road" pair of defects. If streets.js retunes
 * its island, this has to follow; there is no way to import the constants
 * because they are module-private over there.
 */
const MEDIAN_NOSE = 6.3;
const MEDIAN_MIN_RUN = 18;
/** The island tapers to a point over its last 3 m; keep the trunks off that. */
const MEDIAN_TAPER = 4.5;

/**
 * Boulevard median PLANTING.
 *
 * streets.js owns the median surface, its kerb rings and the low hedge spine
 * (it says so in its own comment). What it leaves us is the thing that makes
 * Brickell Ave read as Brickell Ave from the menu-hero camera: a continuous
 * line of royal palms marching down the middle of the city, with colour at
 * their feet. Soil sits at y=0.142, just under Y_WALK.
 *
 * The line is laid on a GLOBAL LATTICE, not from the start of each run: the
 * island is chopped into a run per city block, and restarting the rhythm at
 * every junction is what made a boulevard planted at a constant 12 m read as a
 * different spacing every block. Quantising z to a shared step means the palms
 * carry straight through the junctions — which is the whole point of an avenue.
 */
function buildMedians(ctx) {
  const { layout } = ctx;
  const S = WORLD.SIZE;

  /** A median may not run over water, and a bridge deck is 1.2 m above us. */
  const clearAt = (x, z) => {
    if (layout.isWater(x, z)) return false;
    for (const br of layout.bridges) {
      if (Math.abs(x - br.x) < br.width / 2 + 4 && Math.abs(z - br.z) < br.length / 2 + 4) return false;
    }
    return true;
  };

  for (const road of layout.medians) {
    if (road.axis !== 'x') continue;              // all three are north/south
    const half = Math.max(2.6, road.medianW * 0.5 - 0.6);
    const rng = makeRNG(Math.round(road.pos * 977) ^ 0x3b1f);

    // Break the strip at every cross street so the island does not pave over
    // the junctions.
    const cuts = [-S];
    for (const rz of layout.roadsZ) {
      cuts.push(rz.pos - rz.half - MEDIAN_NOSE, rz.pos + rz.half + MEDIAN_NOSE);
    }
    cuts.push(S);
    cuts.sort((a, b) => a - b);

    /** @type {{z0:number,z1:number}[]} */
    const runs = [];
    for (let i = 0; i < cuts.length - 1; i += 2) {
      // Walk the segment in 5 m steps and keep only the contiguous dry runs;
      // the river crossing sits inside a single 170 m segment, so testing the
      // midpoint alone would happily bridge it.
      // 2 m steps, not 5: streets.js bisects its wet/dry flip to 25 cm, so a
      // coarse sample here can keep 5 m of run that has no island under it and
      // stand a palm on the river.
      let start = null;
      for (let z = cuts[i]; z <= cuts[i + 1] + 0.01; z += 2) {
        const zz = Math.min(z, cuts[i + 1]);
        if (clearAt(road.pos, zz)) {
          if (start === null) start = zz;
        } else if (start !== null) {
          runs.push({ z0: start, z1: zz - 2 }); start = null;
        }
      }
      if (start !== null) runs.push({ z0: start, z1: cuts[i + 1] });
    }

    // Keep off the hedge spine streets.js runs down the centreline.
    const spine = Math.min(1.05, half - 0.75);
    const lane = (s) => road.pos + s * (spine + 0.55 + rng() * Math.max(0.2, half - spine - 1.4));

    /* One species for the whole avenue. Rolling the dice per palm gives a
       median that is 40% royal, 30% sabal and 30% coconut in no order at all,
       which reads as a nursery clearance rather than a planting scheme.
       The species is one choice; the SPECIMEN is not — five geometry variants
       and eight crown tints ride underneath, so the avenue is a scheme made of
       individuals rather than a stamp repeated 40 times. */
    const key = rng.weighted([['royalA', 40], ['royalB', 24], ['queenPalm', 14],
      ['sabal', 12], ['coconutA', 10]]);
    /* A second, subordinate species threaded through at every seventh position
       — the way a real avenue gets replanted a few trees at a time. The
       Washingtonia earns the largest share of it precisely because it is the
       one that is a different HEIGHT: from the menu-hero camera the median is
       a ruled line of crowns at a constant altitude, and a spike every seventh
       tree is what turns that line into a rhythm. */
    const infill = rng.weighted([['washingtonia', 28], ['royalB', 22],
      ['queenPalm', 20], ['sabal', 18], ['coconutA', 12]]);
    /* Per ROAD, not per run and not global: the lattice still has to be shared
       along one avenue or the palms stop lining up through the junctions, but
       three boulevards planted at exactly 9.5 m are three copies of the same
       avenue seen from different angles. */
    const STEP = 8.6 + rng() * 2.4;
    let step = 0;

    for (const run of runs) {
      if (run.z1 - run.z0 < MEDIAN_MIN_RUN) continue;   // streets.js built no island here
      const z0 = run.z0 + MEDIAN_TAPER, z1 = run.z1 - MEDIAN_TAPER;
      if (z1 - z0 < STEP * 0.5) continue;

      /* FORCED, like the street-tree line and for exactly the same reason.
         A raised island is nature's ground by construction — streets.js builds
         the kerb ring and the soil and nothing else places anything on it — but
         the occupancy grid does not know that: buildings claim a SQUARE sized to
         their circumradius, and a tower set back from Biscayne Blvd blankets the
         middle of the road. Reading that grid cost the underplanting almost
         entirely: 4 clumps of colour across all three boulevards, against 130
         once the read is skipped. The palms mostly survived it (their step is
         wider, so more of them fall in a gap between claims) but the ribbon at
         their feet — the thing that makes an avenue read as planted rather than
         as a hedge in a gutter — did not exist. The invariants that matter (the
         bay, the carriageway proper, a building's measured footprint, our own
         spacing) are all still enforced inside plant(); `force` only ever
         overrules the over-claim. */
      for (let z = Math.ceil(z0 / STEP) * STEP; z <= z1; z += STEP) {
        plant(ctx, step++ % 7 === 3 ? infill : key,
          road.pos + (rng() - 0.5) * 0.4, z, rng() * 6.283,
          0.92 + rng() * 0.26, { y: -0.012, clear: 2.0, island: true, force: true });
        // Colour at their feet, on the half-step, so the underplanting reads as
        // a continuous ribbon rather than a ring around each trunk.
        const mid = z + STEP * 0.5;
        if (mid > z1) continue;
        for (const s of [-1, 1]) {
          const roll = rng();
          // Sago and hibiscus at 30-40 cm and 1.7 m give the ribbon two heights
          // instead of one, which is the difference between a planted median
          // and a strip of coloured carpet.
          const under = roll < 0.42 ? (rng.chance(0.5) ? 'flowerPink' : 'flowerYellow')
            : roll < 0.56 ? 'croton'
            : roll < 0.66 ? 'sago'
            : roll < 0.76 ? 'hibiscus'
            : roll < 0.88 ? 'ornGrass' : 'groundcover';
          plant(ctx, under, lane(s), mid, rng() * 6.283, 0.75 + rng() * 0.45,
            { y: -0.012, clear: 0.4, island: true, force: true, tintIndex: step });
        }
      }
    }
  }
}

/* --------------------------------------------------------- street trees --- */

/**
 * Street trees along a block's public frontages.
 *
 * Spacing is by street class, not random: a real street-tree line is a
 * RHYTHM, and scattering them is what makes procedural cities look like
 * someone spilled the trees. Boulevards get palms, quiet streets get shade.
 */
function buildStreetTrees(ctx, B, b, rng) {
  // Sit in the grass verge streets.js lays 1.55-3.05 m behind the kerb.
  // Buildings fill 70-82% of a parcel, so this is also the only reliably empty
  // ground; on a small lot the gap is barely a metre, hence the scaling term.
  const inset = Math.max(1.75, Math.min(2.35, Math.min(b.w, b.d) * 0.06));
  const grand = b.onSpine || b.onBoulevard;

  let run = 0;
  for (const fr of b.frontageStreets) {
    const firstRun = run++ === 0;
    const cls = fr.road.cls;
    // Real street-tree spacing is 8-12 m, and the wider end of that was leaving
    // 16 m holes on quiet streets and skipping short frontages entirely
    // (`len < spacing * 0.9` below). Tightening the rhythm is the cheapest
    // density there is: it costs no draw call, only instances in a pool that is
    // already open.
    const spacing = cls === ROAD_CLASS.BOULEVARD ? 9.5
      : cls === ROAD_CLASS.AVENUE ? 11.5 : 13.5;
    const horiz = fr.side === 'n' || fr.side === 's';
    const len = horiz ? b.w : b.d;
    if (len < spacing * 0.9) continue;
    const n = Math.max(1, Math.floor((len - 5) / spacing));
    const gap = (len - 5) / n;

    /* Give the whole run one species so the line reads as a planting scheme —
       but a real street gets replanted in patches, so about one tree in six is
       a second species. Without that, "one species per run" and "one geometry
       per species" multiplied out to a literal repeating stamp; the accent is
       what breaks the rhythm at a scale the eye reads as a street rather than
       as noise. */
    const palmy = grand ? rng.chance(0.82) : rng.chance(0.42);
    const key = palmy
      ? rng.weighted(grand
        // Only a boulevard is wide enough for a Washingtonia: a 17 m palm on a
        // 13.5 m quiet street is a flagpole standing over two-storey shopfronts.
        ? [['royalA', 22], ['royalB', 16], ['washingtonia', 12], ['queenPalm', 13],
          ['coconutA', 13], ['sabal', 11], ['arecaClump', 7], ['coconutB', 6]]
        : [['royalA', 24], ['royalB', 18], ['queenPalm', 15],
          ['coconutA', 15], ['sabal', 13], ['arecaClump', 8], ['coconutB', 7]])
      : rng.weighted([['liveOak', 24], ['banyan', 12], ['tabebuia', 18],
        ['poinciana', 16], ['jacaranda', 12], ['mahogany', 10], ['bougain', 8]]);
    /* The accent is not "a smaller palm" — a 2 m palmetto standing one in six
       down a line of 13 m royals reads as a gap in the line, not as variety.
       It has to be another TREE, differing in crown rather than in height.
       On a boulevard the Washingtonia is the BEST possible accent and a poor
       run species, so it is weighted the opposite way round here: a single
       17 m spike every sixth tree breaks the skyline of the line it is
       threaded through, where a whole avenue of them just moves that skyline
       up and flattens it again. */
    const accent = palmy
      ? rng.weighted(grand
        ? [['washingtonia', 30], ['sabal', 18], ['queenPalm', 17], ['coconutA', 15],
          ['arecaClump', 12], ['royalB', 8]]
        : [['sabal', 26], ['queenPalm', 24], ['coconutA', 22],
          ['arecaClump', 18], ['royalB', 10]])
      : rng.weighted([['tabebuia', 24], ['poinciana', 22], ['jacaranda', 20],
        ['bougain', 14], ['liveOak', 10], ['traveller', 10]]);
    const accentAt = 2 + rng.int(0, 3);

    for (let i = 0; i <= n; i++) {
      const t = -len / 2 + 2.5 + gap * i;
      let x, z, nx = 0, nz = 0, ax = 0, az = 0;
      if (fr.side === 'n') { x = b.x + t; z = b.z - b.d / 2 + inset; nz = -1; ax = 1; }
      else if (fr.side === 's') { x = b.x + t; z = b.z + b.d / 2 - inset; nz = 1; ax = 1; }
      else if (fr.side === 'w') { x = b.x - b.w / 2 + inset; z = b.z + t; nx = -1; az = 1; }
      else { x = b.x + b.w / 2 - inset; z = b.z + t; nx = 1; az = 1; }

      // Nudge toward the kerb rather than lose the tree — on a shallow parcel
      // buildings.js has already eaten the setback this inset assumed — but
      // only twice: three steps would stand the trunk on the kerb itself.
      // The two runs meeting at a corner both want the last 2.5 m of it and
      // `force` stops occupancy arbitrating; the spacing set does it instead,
      // and unlike a blanket corner skip it only drops the tree when there
      // really is another one there.
      const c = plantOut(ctx, i % 6 === accentAt % 6 ? accent : key, x, z, nx, nz,
        rng() * 6.283, 0.84 + rng() * 0.34, { force: true, tintIndex: i }, 2, 0.45);
      if (!c) continue;
      const px = c.position.x, pz = c.position.z;
      treePit(B, px, pz, 1.05, ctx.Y_WALK + 0.02);
      // Under-planting beside the pit, ALONG the kerb line rather than behind
      // it: a metre inland is exactly where the foundation hedge runs, and a
      // collar of grass there quietly deletes one hedge unit per street tree.
      if (rng.chance(0.6)) {
        const s = rng.sign();
        plant(ctx, rng.weighted(UNDER),
          px + ax * s * 1.5, pz + az * s * 1.5,
          rng() * 6.283, 0.7 + rng() * 0.4, { clear: 0.35, force: true, tintIndex: i });
      }
    }
  }
}

/* ---------------------------------------------------------------- parks --- */

/** Mown lawn with alternating stripes, filling a rectangle. */
function lawn(B, x0, z0, x1, z1, y, alongX, stripeW) {
  const w = x1 - x0, d = z1 - z0;
  if (w < 0.5 || d < 0.5) return;
  const len = alongX ? d : w;
  const n = Math.max(1, Math.round(len / stripeW));
  const sw = len / n;
  for (let i = 0; i < n; i++) {
    const key = i % 2 ? 'lawnB' : 'lawnA';
    if (alongX) {
      B.add(key, tile(w, sw, (x0 + x1) / 2, z0 + sw * (i + 0.5), y, 8));
    } else {
      B.add(key, tile(sw, d, x0 + sw * (i + 0.5), (z0 + z1) / 2, y, 8));
    }
  }
}

/** Painted court with line markings and a chain-link-free open edge. */
function court(B, x, z, w, d, y, kind, rot) {
  const surf = kind === 'clay' ? 'courtClay' : 'courtHard';
  const rotQuad = (gw, gd, gx, gz, gy) => {
    const g = tile(gw, gd, 0, 0, gy, 4);
    g.rotateY(rot);
    g.translate(x + gx * Math.cos(rot) - gz * Math.sin(rot), 0, z + gx * Math.sin(rot) + gz * Math.cos(rot));
    return g;
  };
  B.add(surf, rotQuad(w, d, 0, 0, y));
  const L = 0.14;
  const line = (gw, gd, gx, gz) => B.add('courtLine', rotQuad(gw, gd, gx, gz, y + 0.012));
  line(w - 1.6, L, 0, -(d - 1.6) / 2);
  line(w - 1.6, L, 0, (d - 1.6) / 2);
  line(L, d - 1.6, -(w - 1.6) / 2, 0);
  line(L, d - 1.6, (w - 1.6) / 2, 0);
  line(L, d - 1.6, 0, 0);                       // halfway / net line
  if (kind === 'clay') {
    line(w * 0.5, L, 0, -d * 0.16);
    line(w * 0.5, L, 0, d * 0.16);
  } else {
    // Two key rectangles + a centre circle stand-in.
    line(w * 0.22, L, -(w * 0.5 - w * 0.11), -d * 0.15);
    line(w * 0.22, L, -(w * 0.5 - w * 0.11), d * 0.15);
    line(w * 0.22, L, (w * 0.5 - w * 0.11), -d * 0.15);
    line(w * 0.22, L, (w * 0.5 - w * 0.11), d * 0.15);
  }
}

/**
 * A park block. Not a lawn — a lawn is the defect this file exists to fix.
 * Every park gets: striped turf, a path loop, a hedge frontage, at least one
 * bed, a canopy layer and one hero feature sized to the parcel.
 */
function parkBlock(ctx, B, b, rng) {
  const y = ctx.Y_WALK + 0.015;
  // Leave the sidewalk band that streets.js already paved showing all the way
  // round: a lawn that runs to the kerb reads as a green rectangle dropped on
  // the map rather than as a park with a footpath around it.
  const edge = Math.min(3.0, Math.max(1.2, b.sidewalk * 0.55));
  const hw = b.w / 2 - edge, hd = b.d / 2 - edge;
  const x0 = b.x - hw, x1 = b.x + hw, z0 = b.z - hd, z1 = b.z + hd;

  lawn(B, x0, z0, x1, z1, y, b.w >= b.d, 4.2);
  // A kerb line where the turf meets the paving — contact, not a floating edge.
  B.add('kerb', box(hw * 2 + 0.36, 0.20, 0.18, b.x, y + 0.10, z0, 1));
  B.add('kerb', box(hw * 2 + 0.36, 0.20, 0.18, b.x, y + 0.10, z1, 1));
  B.add('kerb', box(0.18, 0.20, hd * 2, x0, y + 0.10, b.z, 1));
  B.add('kerb', box(0.18, 0.20, hd * 2, x1, y + 0.10, b.z, 1));

  /* --- path loop -------------------------------------------------------- */
  const pin = Math.min(4.5, Math.min(hw, hd) * 0.42);
  const py = y + 0.03;
  const pw = b.streetLife > 0.55 ? 2.8 : 2.2;
  const hasLoop = Math.min(b.w, b.d) > 20;
  /** Lamp stations along the walk, filled in after the hero feature. */
  const lampSites = [];
  /** The walking loop, kept in scope so the bedding below can stay off it. */
  const loop = { x0: x0 + pin, x1: x1 - pin, z0: z0 + pin, z1: z1 - pin, bow: 0 };
  if (hasLoop) {
    const px0 = loop.x0, px1 = loop.x1, pz0 = loop.z0, pz1 = loop.z1;
    // A slightly bowed loop reads as a designed park, an exact rectangle reads
    // as a spreadsheet.
    const bow = Math.min(2.2, Math.min(hw, hd) * 0.14);
    loop.bow = bow;
    B.add('path', ribbon([
      { x: px0, z: pz0 }, { x: (px0 + px1) / 2, z: pz0 - bow }, { x: px1, z: pz0 },
      { x: px1 + bow, z: (pz0 + pz1) / 2 }, { x: px1, z: pz1 },
      { x: (px0 + px1) / 2, z: pz1 + bow }, { x: px0, z: pz1 },
      { x: px0 - bow, z: (pz0 + pz1) / 2 }, { x: px0, z: pz0 },
    ], pw, py, 3));
    // A spur out to the street on the frontage side.
    const fr = b.frontageStreets[0];
    if (fr) {
      const s = fr.side;
      const a = s === 'n' ? { x: b.x, z: pz0 } : s === 's' ? { x: b.x, z: pz1 }
        : s === 'w' ? { x: px0, z: b.z } : { x: px1, z: b.z };
      const c = s === 'n' ? { x: b.x, z: z0 } : s === 's' ? { x: b.x, z: z1 }
        : s === 'w' ? { x: x0, z: b.z } : { x: x1, z: b.z };
      B.add('path', ribbon([a, c], pw, py, 3));
    }
    /* Lamps stand OUTSIDE the walking surface — on the grass, half a metre
       clear of the path edge. On it, a 4 m post is an obstacle in the middle of
       the only route through the park, and the pedestrian crowd walks through
       it. Stepping round the loop in ~14 m stations is what a municipal park
       actually does, and it is what stops the path being a black stripe once
       nightFactor comes up. */
    const off = pw * 0.5 + 0.75;
    const legs = [
      [px0, pz0 - off, px1, pz0 - off], [px1 + off, pz0, px1 + off, pz1],
      [px1, pz1 + off, px0, pz1 + off], [px0 - off, pz1, px0 - off, pz0],
    ];
    for (const [ax, az, bx, bz] of legs) {
      const L = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.round(L / 14));
      for (let i = 0; i <= n; i++) {
        lampSites.push([ax + (bx - ax) * (i / n), az + (bz - az) * (i / n)]);
      }
    }
  } else {
    B.add('path', ribbon([{ x: x0, z: b.z }, { x: x1, z: b.z }], pw, py, 3));
    const n = Math.max(1, Math.round((hw * 2) / 14));
    for (let i = 0; i <= n; i++) {
      lampSites.push([x0 + (hw * 2) * (i / n), b.z + pw * 0.5 + 0.75]);
    }
  }

  /* --- hedge frontage + low wall --------------------------------------- */
  const walled = rng.chance(0.45);
  for (const fr of b.frontageStreets) {
    const horiz = fr.side === 'n' || fr.side === 's';
    const len = (horiz ? b.w : b.d) - 3;
    if (len < 6) continue;
    const n = Math.max(1, Math.floor(len / 3.2));
    for (let i = 0; i < n; i++) {
      const t = -len / 2 + (i + 0.5) * (len / n);
      let hx, hz, rot;
      if (fr.side === 'n') { hx = b.x + t; hz = z0 + 0.9; rot = 0; }
      else if (fr.side === 's') { hx = b.x + t; hz = z1 - 0.9; rot = 0; }
      else if (fr.side === 'w') { hx = x0 + 0.9; hz = b.z + t; rot = Math.PI / 2; }
      else { hx = x1 - 0.9; hz = b.z + t; rot = Math.PI / 2; }
      // Sit ON the turf, never on top of the wall. The wall is a 0.42 m plinth
      // 55 cm in FRONT of this line, so lifting the hedge to meet its coping
      // left a 34 cm gap of daylight under every hedge unit on a walled park —
      // 430-odd of them, the largest single grounding defect in the module. A
      // low wall with a hedge standing behind it at grade is what the real
      // thing looks like anyway.
      plant(ctx, 'hedge', hx, hz, rot, 0.92 + rng() * 0.2, { clear: 0, tintIndex: i });
    }
    if (walled) {
      const wy = ctx.Y_WALK;
      if (horiz) {
        B.add('stone', box(len + 1.2, 0.42, 0.5, b.x, wy + 0.21,
          fr.side === 'n' ? z0 + 0.35 : z1 - 0.35, 1.5));
      } else {
        B.add('stone', box(0.5, 0.42, len + 1.2,
          fr.side === 'w' ? x0 + 0.35 : x1 - 0.35, wy + 0.21, b.z, 1.5));
      }
    }
  }

  /* --- one hero feature ------------------------------------------------- */
  // BEFORE the beds and the canopy scatter: the feature needs 5-9 m of clear
  // ground, and whatever runs first wins the occupancy grid. Running it last is
  // how every bandshell, court and pond in the city ended up rejected.
  const keep = parkFeature(ctx, B, b, rng, y);

  /* Where bedding may NOT go. Two things and no others: the hero feature's own
     surface, and the walking surface.
     This replaces `ctx.isFree` for everything soft below. Inside a planted park
     the occupancy grid reads "claimed" essentially everywhere — see the note on
     parkFeature — so testing against it refused almost every flower in the
     city. What a bloom clump actually has to avoid is a pond and a footpath;
     standing under the edge of a canopy is not a fault, it is planting. */
  const pathHalf = pw * 0.5 + 0.75;
  const inKeep = (px, pz) => {
    for (const k of keep) {
      const dx = px - k.x, dz = pz - k.z;
      if (dx * dx + dz * dz < k.r * k.r) return true;
    }
    if (!hasLoop) return Math.abs(pz - b.z) < pathHalf && px > x0 && px < x1;
    // Signed distance to the loop RECTANGLE's boundary; the ring is a band of
    // width pw either side of it, so |sd| is the test, not sd.
    const dxo = Math.max(loop.x0 - px, px - loop.x1);
    const dzo = Math.max(loop.z0 - pz, pz - loop.z1);
    const ax = Math.max(dxo, 0), az = Math.max(dzo, 0);
    const sd = Math.hypot(ax, az) + Math.min(Math.max(dxo, dzo), 0);
    // `bow` bulges the ribbon outward at the middle of each leg, so the band
    // has to be that much wider than the ribbon itself.
    return Math.abs(sd) < pathHalf + loop.bow;
  };

  /* --- path lighting ---------------------------------------------------- */
  // After the hero feature, so a bandshell or a pond has already claimed the
  // ground it needs and a lamp cannot land inside the basin.
  for (let i = 0; i < lampSites.length; i++) {
    const [lx, lz] = lampSites[i];
    if (plant(ctx, 'parkLamp', lx, lz, rng() * 6.283, 0.94 + rng() * 0.16,
      { clear: 0.8, noTilt: true })) {
      B.add('plazaInlay', disc(0.55, 8, lx, y + 0.028, lz, null));
    }
  }

  /* --- SPECIMENS: the plants a weighted mix will never deliver ----------- */
  /*
   * Third in the running order, straight after the hero feature and the lamps,
   * and that position is the whole point.
   *
   * A specimen cannot come out of a mix, and the arithmetic is not subtle. The
   * groves, the walk line and the yards all call plant() WITHOUT `force`, so
   * `clear` is read against the shared occupancy grid — and inside a planted
   * park that grid reads "claimed" almost everywhere (see the note on
   * parkFeature). The species carrying the LARGEST clearances are therefore
   * rejected first and hardest, which is exactly backwards: a Bismarckia's 3 m
   * clearance is large *because* it is a feature plant. Measured, the mixes
   * alone put SEVEN of them in the whole of Miami, and running this block after
   * the groves only lifted that to nineteen — by then sixty-odd grove trees
   * have taken the spacing set and there is nowhere on the lawn left to stand.
   *
   * So the park asks for two to four by name, before the scatter, forced past
   * the over-claim exactly the way the street-tree line and the median already
   * are. The invariants that matter — the bay, the carriageway, a building's
   * measured footprint, nature's own spacing — are all still enforced inside
   * plant(); `force` only ever overrules the buildings' over-claimed square.
   */
  const specN = Math.min(4, 2 + Math.round(b.area / 1600));
  for (let i = 0; i < specN; i++) {
    // Weighted hard toward the two species that change how the CITY reads —
    // the only silver plant in it, and the one with a bare trunk and a small
    // crown instead of a crown on a stub.
    const key = rng.weighted([['bismarck', 44], ['washingtonia', 26],
      ['poinciana', 12], ['banyan', 10], ['traveller', 8]]);
    for (let t = 0; t < 14; t++) {
      const sx = b.x + (rng() - 0.5) * b.w * 0.74;
      const sz = b.z + (rng() - 0.5) * b.d * 0.74;
      if (inKeep(sx, sz)) continue;
      if (plant(ctx, key, sx, sz, rng() * 6.283, 0.92 + rng() * 0.26,
        { force: true, clear: 2.6, tintIndex: i })) {
        // A mulch ring a third wider than a street tree's: a specimen standing
        // in bare mown turf reads as a tree someone forgot to remove.
        treePit(B, sx, sz, 1.35, y + 0.02);
        break;
      }
    }
  }

  /* --- shade along the walk --------------------------------------------- */
  /* One species, one spacing, one offset: a path you can follow by its trees is
     the cheapest possible signal that somebody DESIGNED this park rather than
     seeded it. Runs after the hero feature so a court or a pond still wins the
     ground it needs. */
  if (Math.min(b.w, b.d) > 26) {
    const alongX = b.w >= b.d;
    const key = rng.weighted([['royalA', 21], ['liveOak', 19], ['sabal', 13],
      ['tabebuia', 13], ['coconutA', 11], ['queenPalm', 10], ['jacaranda', 8],
      ['washingtonia', 5]]);
    const runLen = (alongX ? hw : hd) * 2 - pin * 2;
    const n = Math.max(2, Math.round(runLen / 9));
    for (const s of [-1, 1]) {
      const off = (alongX ? hd : hw) - pin - 2.4;
      for (let i = 0; i <= n; i++) {
        const t = -runLen / 2 + (runLen / n) * i;
        const px = alongX ? b.x + t : b.x + s * off;
        const pz = alongX ? b.z + s * off : b.z + t;
        if (plant(ctx, key, px, pz, rng() * 6.283, 0.86 + rng() * 0.30,
          { clear: 1.8, tintIndex: i })) {
          treePit(B, px, pz, 1.0, y + 0.02);
        }
      }
    }
  }

  /* --- flower beds ------------------------------------------------------ */
  /*
   * ONE random shot per bed used to decide it, tested against
   * isFree(centre, max(bw,bd)/2). The occupancy grid is 3 m coarse and rounds
   * that test up to "nothing claimed within 6 m", so a 7 x 5 m bed demanded a
   * clear 12 m square in a park whose middle is already a pond or a court and
   * whose edges are a tree line. Almost every site was refused and the parks
   * had next to no colour in them — 111 blooms in beds across the whole city.
   * Try a handful of sites instead of one, keep them off the path loop by
   * construction, and test the bed's own narrow half-width.
   */
  const beds = 2 + rng.int(0, 2);
  // Beds go inside the walk, never across it. A park with a loop is bounded by
  // the ring; a park too small for one carries a single straight path through
  // the middle, so there the rule is "off the centre line" instead.
  const keepIn = hasLoop ? pin + pw * 0.5 + 1.0 : 0;
  for (let i = 0; i < beds; i++) {
    const bw = 3.4 + rng() * 4.0, bd = 2.4 + rng() * 3.0;
    const rx = Math.max(0, hw - keepIn - bw * 0.5);
    const rz = Math.max(0, hd - keepIn - bd * 0.5);
    let bx = 0, bz = 0, ok = false;
    for (let t = 0; t < 12 && !ok; t++) {
      bx = b.x + (rng() * 2 - 1) * rx;
      bz = b.z + (rng() * 2 - 1) * rz;
      if (!hasLoop && Math.abs(bz - b.z) < pw * 0.5 + 0.8 + bd * 0.5) continue;
      // Corners as well as the centre: a 7 x 5 m kerbed bed half on the pond
      // is worse than no bed, and the centre alone does not catch that.
      ok = !inKeep(bx, bz) && !inKeep(bx - bw / 2, bz - bd / 2)
        && !inKeep(bx + bw / 2, bz - bd / 2) && !inKeep(bx - bw / 2, bz + bd / 2)
        && !inKeep(bx + bw / 2, bz + bd / 2)
        && !ctx.layout.isWater(bx, bz) && !inBuilding(bx, bz);
    }
    if (!ok) continue;
    stats.beds++;
    // Claim it, or props.js drops a traffic cone in the middle of the petunias.
    ctx.occupy(bx, bz, Math.max(bw, bd) * 0.45);
    // A RAISED bed: soil 15 cm up inside a 22 cm edging. The soil used to sit
    // 3.5 cm above the turf inside the same edging, so the bed read as a shallow
    // pit with the flowers at the bottom of it, and every bloom was planted a
    // further 5 cm below the soil it was supposed to be growing in.
    // 11 cm of soil inside a 22 cm edging, and the plants set 2 cm into it.
    // It was 15 cm proud with the plants sitting on top, which put their bases
    // 32 cm above grade — past the 28 cm the placement audit allows before it
    // calls a prop floating, and it looked it.
    const soil = 0.11;
    B.add('mulch', tile(bw, bd, bx, bz, y + soil, 3));
    B.add('kerb', box(bw + 0.4, 0.22, 0.22, bx, y + 0.11, bz - bd / 2, 1));
    B.add('kerb', box(bw + 0.4, 0.22, 0.22, bx, y + 0.11, bz + bd / 2, 1));
    B.add('kerb', box(0.22, 0.22, bd, bx - bw / 2, y + 0.11, bz, 1));
    B.add('kerb', box(0.22, 0.22, bd, bx + bw / 2, y + 0.11, bz, 1));
    const key = rng.chance(0.5) ? 'flowerPink' : 'flowerYellow';
    // A bloom clump is a 2.2 m card. Gridding them at 1.4 m centres stacked
    // every clump halfway through its neighbour — 117 overlapping pairs, more
    // than a seventh of the whole map's total, for a mass of colour that a
    // 1.9 m grid draws just as solidly with two thirds of the instances.
    const cols = Math.max(2, Math.round(bw / 1.9)), rows = Math.max(1, Math.round(bd / 1.9));
    for (let cx = 0; cx < cols; cx++) {
      for (let cz = 0; cz < rows; cz++) {
        plant(ctx, key,
          bx - bw / 2 + (cx + 0.5) * (bw / cols),
          bz - bd / 2 + (cz + 0.5) * (bd / rows),
          rng() * 6.283, 0.75 + rng() * 0.35, { clear: 0, y: 0.015 + soil - 0.02 });
      }
    }
  }

  /* --- drifts of colour ------------------------------------------------- */
  /*
   * A kerbed bed needs a clear 7 x 5 m rectangle and a 24 m deep park has not
   * got one: hedge frontage, path ring, the walk's tree line and the hero
   * feature between them account for every square metre. Seventeen beds in the
   * whole city was the result, so most of Miami's parks had no colour in them.
   *
   * A drift needs no rectangle. Half a dozen clumps of ONE colour in a loose
   * ellipse is how bedding is actually planted, and it survives anywhere a
   * single clump fits.
   *
   * Test each CLUMP, and test it against `inKeep` — the pond, the court, the
   * apron, the footpath — rather than against the shared occupancy grid. The
   * grid cannot answer this: it rounds any radius up to whole 3 m cells, so one
   * park lamp claims 81 m² and a grove of a hundred trees claims the parcel,
   * and the whole city ended up with 185 flowers in it. `clear: 0` for the
   * mirror-image reason: a clump that CLAIMED ground would blanket a 9 m square
   * and refuse the other five clumps of its own drift. Spacing inside the drift
   * is the private `sep` set's job.
   */
  const driftN = Math.max(3, Math.round(b.area / 420));
  for (let i = 0; i < driftN; i++) {
    // A drift is ONE plant repeated — mixing species inside it turns a designed
    // sweep of colour into a jumble. Crotons drift too: they read as a mass of
    // orange at a distance where individual leaves have long since minified out.
    const key = rng.weighted([['flowerPink', 30], ['flowerYellow', 30],
      ['croton', 15], ['hibiscus', 13], ['groundcover', 12]]);
    const dx = b.x + (rng() - 0.5) * b.w * 0.80;
    const dz = b.z + (rng() - 0.5) * b.d * 0.80;
    const a = rng() * 3.14, ra = 2.8 + rng() * 2.6, rb = 1.9 + rng() * 1.0;
    for (let k = 0; k < 6; k++) {
      // Even angular spread, jittered radius: a clump ring, not a solid blob.
      const t = (k / 6) * 6.283 + rng() * 0.5;
      const u = Math.cos(t) * ra * (0.6 + rng() * 0.4);
      const v = Math.sin(t) * rb * (0.6 + rng() * 0.4);
      const px = dx + u * Math.cos(a) - v * Math.sin(a);
      const pz = dz + u * Math.sin(a) + v * Math.cos(a);
      if (inKeep(px, pz)) continue;
      plant(ctx, key, px, pz, rng() * 6.283, 0.72 + rng() * 0.3,
        { clear: 0, tintIndex: i });
    }
  }

  /* --- canopy: groves, not confetti ------------------------------------- */
  /*
   * Scattering trees uniformly across the parcel is the single loudest
   * "procedurally generated" tell there is — you get an even grey-green fur
   * with no shape to it. A real park is a few GROVES of one species with open
   * mown lawn between them, so pick a handful of grove centres, give each its
   * own species, and cluster around them with a sqrt falloff (uniform in area,
   * so the grove is dense at the middle and frays at the edge).
   */
  /* A park is where the two specimen palms belong: the Bismarckia needs 5 m of
     clear crown and reads as a deliberate planting rather than as street
     furniture, and the Washingtonia gives a grove an emergent above its own
     canopy line. Both stay at single-figure weights — a park full of specimens
     is a nursery. */
  const coastal = () => rng.weighted([['royalA', 15], ['coconutA', 15], ['seagrapeT', 19],
    ['sabal', 11], ['banyan', 9], ['queenPalm', 8], ['arecaClump', 7],
    ['traveller', 5], ['poinciana', 6], ['washingtonia', 6], ['bismarck', 5]]);
  const inland = () => rng.weighted([['banyan', 13], ['liveOak', 15], ['royalA', 10],
    ['royalB', 7], ['tabebuia', 9], ['poinciana', 9], ['jacaranda', 8],
    ['mahogany', 7], ['arecaClump', 6], ['traveller', 4], ['bougain', 4], ['sabal', 3],
    ['washingtonia', 5], ['bismarck', 4]]);
  const speciesFor = b.bayfront ? coastal : inland;

  const treeN = Math.max(7, Math.round(b.area / 40));
  const groveN = Math.max(2, Math.min(6, Math.round(b.area / 780)));
  let planted = 0;
  for (let gi = 0; gi < groveN && planted < treeN; gi++) {
    const gx = b.x + (rng() - 0.5) * b.w * 0.72;
    const gz = b.z + (rng() - 0.5) * b.d * 0.72;
    const gr = Math.min(Math.min(b.w, b.d) * 0.24, 7 + rng() * 7);
    const key = speciesFor();
    const n = Math.ceil(treeN / groveN);
    for (let i = 0; i < n && planted < treeN; i++) {
      const a = rng() * 6.283, dd = Math.sqrt(rng()) * gr;
      // Every third grove gets a second species threaded through it, which is
      // what stops a grove reading as a stamp.
      const k = gi % 3 === 2 && rng.chance(0.3) ? speciesFor() : key;
      if (plant(ctx, k, gx + Math.cos(a) * dd, gz + Math.sin(a) * dd,
        rng() * 6.283, 0.85 + rng() * 0.35)) planted++;
    }
  }
  // Whatever the groves could not fit goes out as specimen trees on the lawn.
  for (let i = 0; planted < treeN && i < treeN * 2; i++) {
    const tx = b.x + (rng() - 0.5) * b.w * 0.86;
    const tz = b.z + (rng() - 0.5) * b.d * 0.86;
    if (plant(ctx, speciesFor(), tx, tz, rng() * 6.283, 0.85 + rng() * 0.35)) planted++;
  }


  /* Understorey follows the groves rather than the parcel: shrub masses belong
     under the canopy edge, not marooned in the middle of the mown lawn.
     Five things in the mix rather than two — a park whose entire ground layer
     is one shrub and one grass is a green carpet with trees standing on it. */
  const shrubN = Math.max(5, Math.round(b.area / 78));
  for (let i = 0; i < shrubN; i++) {
    const sx = b.x + (rng() - 0.5) * b.w * 0.88;
    const sz = b.z + (rng() - 0.5) * b.d * 0.88;
    if (inKeep(sx, sz)) continue;
    // `clear: 0` and force: same argument as the drifts. The understorey used
    // to read the occupancy grid and therefore mostly landed on the two or
    // three cells a park had left, in a clump, at the edge.
    plant(ctx, rng.weighted(UNDER), sx, sz,
      rng() * 6.283, 0.8 + rng() * 0.45, { clear: 0, force: true, tintIndex: i });
  }

  blockShoreline(ctx, b, rng);
}

/**
 * Height of a feature's own paved apron above Y_WALK.
 *
 * Park surfaces stack: lawn at Y_WALK+0.015, a court/apron/sandpit a further
 * 55 mm on top of that. `plant` positions from Y_WALK, so anything standing on
 * an apron has to add the pair back or it is buried in its own paving.
 */
const DECK = 0.07;

/**
 * The thing that makes a given park memorable. Sized to the parcel.
 *
 * Returns the KEEP-OUT discs it wants respected, in world space.
 *
 * It already claims those in the shared occupancy grid, but inside a park that
 * grid is useless as a query: `occupy` rounds any radius up to whole 3 m cells
 * in every direction, so a single park lamp with a 0.8 m clearance blankets
 * 81 m² and a grove of a hundred trees blankets the entire parcel. Every
 * subsequent `isFree` therefore answers "no" everywhere, which is why the city
 * had 185 flowers in it. The bedding needs a test that means "not in the pond,
 * not on the court" and nothing more, and only this function knows where those
 * are.
 */
function parkFeature(ctx, B, b, rng, y) {
  const small = Math.min(b.w, b.d);
  const cx = b.x + (rng() - 0.5) * b.w * 0.16;
  const cz = b.z + (rng() - 0.5) * b.d * 0.16;
  const roll = rng();
  /** @type {{x:number,z:number,r:number}[]} */
  const keep = [];

  if (small > 30 && b.area > 1500 && roll < 0.30) {
    /* Pond with a fountain in it. */
    const pr = Math.max(4.5, Math.min(11, small * 0.26));
    B.add('pond', disc(pr, 22, cx, y + 0.04, cz, null));
    B.add('kerb', ringWall(pr, pr + 0.5, 0.34, y, 22, 'stoneTex', cx, cz));
    ctx.occupy(cx, cz, pr + 1);
    keep.push({ x: cx, z: cz, r: pr + 1.2 });
    plant(ctx, 'fountainL', cx, cz, rng() * 6.283, 0.9 + rng() * 0.25, { clear: 0, y: 0.05 });
    for (let i = 0; i < 10; i++) {
      const a = rng() * 6.283, d = pr + 2.2 + rng() * 3;
      plant(ctx, rng.chance(0.5) ? 'ornGrass' : 'shrub',
        cx + Math.cos(a) * d, cz + Math.sin(a) * d, rng() * 6.283, 0.85 + rng() * 0.4, { tintIndex: i });
    }
    stats.features++;
  } else if (small > 24 && roll < 0.46) {
    /* Sports court. */
    const kind = rng.chance(0.55) ? 'hard' : 'clay';
    const rot = b.w >= b.d ? 0 : Math.PI / 2;
    const cw = Math.min(26, b.w * 0.66), cd = Math.min(15, b.d * 0.66);
    court(B, cx, cz, Math.max(cw, cd), Math.min(cw, cd), y + 0.055, kind, rot);
    ctx.occupy(cx, cz, Math.max(cw, cd) * 0.5);
    keep.push({ x: cx, z: cz, r: Math.max(cw, cd) * 0.5 + 0.8 });
    if (kind === 'hard') {
      // Just INSIDE the baseline. Outside it the post stands on turf while
      // claiming the court's height, which floats it 5.5 cm; inside, it is on
      // its own surface and the backboard overhangs the key, which is where a
      // backboard belongs. DECK is that surface: a feature apron sits 55 mm
      // above the lawn, which itself sits 15 mm above Y_WALK.
      const half = Math.max(cw, cd) * 0.5 - 0.35;
      plant(ctx, 'hoop', cx - Math.cos(rot) * half, cz - Math.sin(rot) * half,
        rot + Math.PI, 1, { clear: 0, y: DECK });
      plant(ctx, 'hoop', cx + Math.cos(rot) * half, cz + Math.sin(rot) * half,
        rot, 1, { clear: 0, y: DECK });
    }
    stats.features++;
  } else if (small > 20 && roll < 0.62) {
    /* Playground on sand. */
    const pw = Math.min(16, b.w * 0.5), pd = Math.min(12, b.d * 0.5);
    B.add('sandPit', tile(pw, pd, cx, cz, y + 0.055, 5));
    B.add('kerb', box(pw + 0.4, 0.26, 0.3, cx, y + 0.13, cz - pd / 2, 1));
    B.add('kerb', box(pw + 0.4, 0.26, 0.3, cx, y + 0.13, cz + pd / 2, 1));
    B.add('kerb', box(0.3, 0.26, pd, cx - pw / 2, y + 0.13, cz, 1));
    B.add('kerb', box(0.3, 0.26, pd, cx + pw / 2, y + 0.13, cz, 1));
    ctx.occupy(cx, cz, Math.max(pw, pd) * 0.5);
    keep.push({ x: cx, z: cz, r: Math.max(pw, pd) * 0.5 + 0.8 });
    plant(ctx, 'playground', cx + 1.2, cz, rng.chance(0.5) ? 0 : Math.PI, 1,
      { clear: 0, y: DECK });
    stats.features++;
  } else if (small > 34 && roll < 0.74) {
    /* Bandshell facing an arc of amphitheatre steps. */
    plant(ctx, 'bandshell', cx, cz - b.d * 0.24, 0, 0.9 + rng() * 0.2, { clear: 0 });
    let deepest = 0;
    for (let i = 0; i < 4; i++) {
      const r = 9 + i * 2.4;
      B.add('stone', box(r * 1.5, 0.42 * (i + 1), 1.9, cx, y + 0.21 * (i + 1), cz + b.d * 0.02 + i * 2.2, 2));
      deepest = i * 2.2;
    }
    // Merged surfaces claim nothing on their own, and a disc at the centroid
    // does not cover a 27 m arc of terraces — which is how live oaks ended up
    // growing out of the seating.
    claimBox(ctx, cx, cz + b.d * 0.02 + deepest / 2, 9 * 1.5 + 12, deepest + 2.4, 1.6);
    ctx.occupy(cx, cz, Math.min(b.w, b.d) * 0.40);
    keep.push({ x: cx, z: cz - b.d * 0.24, r: 9.5 });
    keep.push({ x: cx, z: cz + b.d * 0.02 + deepest / 2, r: 13.5 });
    stats.features++;
  } else if (roll < 0.88) {
    /* A small fountain on a paved apron, ringed with planters and a pergola. */
    const aw = Math.min(16, b.w * 0.52), ad = Math.min(16, b.d * 0.52);
    B.add('plazaBase', tile(aw, ad, cx, cz, y + 0.055, 6));
    B.add('plazaAccent', tile(aw, 1.6, cx, cz - ad / 2 + 0.8, y + 0.07, 2));
    B.add('plazaAccent', tile(aw, 1.6, cx, cz + ad / 2 - 0.8, y + 0.07, 2));
    plant(ctx, 'fountainS', cx, cz, rng() * 6.283, 1.0 + rng() * 0.3, { clear: 0, y: DECK });
    ctx.occupy(cx, cz, 4.0);
    keep.push({ x: cx, z: cz, r: Math.max(aw, ad) * 0.5 + 0.6 });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * 6.283 + 0.7;
      plant(ctx, 'planterS', cx + Math.cos(a) * 5.6, cz + Math.sin(a) * 5.6, a, 1,
        { clear: 1.1, force: true, y: DECK });
    }
    if (rng.chance(0.4) && aw > 12) {
      plant(ctx, 'pergola', cx + aw * 0.34, cz, Math.PI / 2, 1,
        { clear: 2.5, force: true, y: DECK });
    }
    stats.features++;
  } else {
    /* Public art on a plinth, ringed with paving. */
    B.add('plazaInlay', disc(5.2, 16, cx, y + 0.055, cz, null));
    B.add('plazaAccent', disc(6.0, 16, cx, y + 0.05, cz, null));
    keep.push({ x: cx, z: cz, r: 6.4 });
    placeSculpture(ctx, cx, cz, rng, true, DECK);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * 6.283 + 0.4;
      plant(ctx, 'fanShort', cx + Math.cos(a) * 4.6, cz + Math.sin(a) * 4.6, a, 1,
        { clear: 1.4, force: true, y: 0.065 });
    }
    stats.features++;
  }
  return keep;
}

/* --------------------------------------------------------------- plazas --- */

/**
 * A civic plaza. Patterned paving is the whole point: a plaza that is one flat
 * cream rectangle is the defect the project lead flagged, and pattern costs
 * nothing because it merges into the same two meshes as every other plaza.
 */
function plazaBlock(ctx, B, b, rng) {
  const y = ctx.Y_WALK + 0.015;
  const hw = b.w / 2 - 0.5, hd = b.d / 2 - 0.5;

  B.add('plazaBase', tile(hw * 2, hd * 2, b.x, b.z, y, 5.5));

  /* Border band in the terracotta paver, then a pattern inside it. */
  const band = 2.4;
  const iy = y + 0.03;
  B.add('plazaAccent', tile(hw * 2, band, b.x, b.z - hd + band / 2, iy, 2.0));
  B.add('plazaAccent', tile(hw * 2, band, b.x, b.z + hd - band / 2, iy, 2.0));
  B.add('plazaAccent', tile(band, hd * 2 - band * 2, b.x - hw + band / 2, b.z, iy, 2.0));
  B.add('plazaAccent', tile(band, hd * 2 - band * 2, b.x + hw - band / 2, b.z, iy, 2.0));

  const style = rng.int(0, 2);
  const medR = Math.min(hw, hd) * 0.55;
  if (style === 0) {
    // Concentric medallion: accent ring, cream field, accent bullseye.
    B.add('plazaAccent', disc(medR, 22, b.x, iy, b.z, null));
    B.add('plazaInlay', disc(medR * 0.74, 22, b.x, iy + 0.012, b.z, null));
    B.add('plazaAccent', disc(medR * 0.30, 18, b.x, iy + 0.024, b.z, null));
    for (let i = 0; i < 8; i++) {
      // Radial spokes out of the medallion — this is what stops a plaza
      // reading as a slab with a circle painted on it.
      const a = (i / 8) * 6.283 + 0.39;
      const l = Math.min(hw, hd) - medR - band - 0.5;
      if (l < 2) break;
      const g = tile(l, 1.5, medR + l / 2, 0, iy, 2.0);
      g.rotateY(-a);
      g.translate(b.x, 0, b.z);
      B.add('plazaAccent', g);
    }
  } else if (style === 1) {
    // A chequer of accent squares — reads beautifully from the 3/4 camera.
    const cells = Math.max(3, Math.min(6, Math.round(Math.min(hw, hd) / 4)));
    const cw = (hw * 2 - band * 2) / cells, cd = (hd * 2 - band * 2) / cells;
    for (let i = 0; i < cells; i++) {
      for (let j = 0; j < cells; j++) {
        if ((i + j) % 2) continue;
        B.add(i % 2 ? 'plazaAccent' : 'plazaInlay', tile(cw * 0.92, cd * 0.92,
          b.x - hw + band + (i + 0.5) * cw, b.z - hd + band + (j + 0.5) * cd, iy, 2.0));
      }
    }
  } else {
    // Diagonal ribbons across the square. A band at perpendicular offset o
    // inside a square of half-size H is 2*(H*sqrt2 - |o|) long; overrun that
    // and the inlay spills onto the roadway.
    const Hh = Math.min(hw, hd);
    for (let i = -3; i <= 3; i++) {
      const o = i * 4.2;
      const len = 2 * (Hh * 1.414 - Math.abs(o)) - 1.4;
      if (len < 4) continue;
      const g = tile(len, 2.2, 0, o, iy, 2.0);
      g.rotateY(Math.PI * 0.25);
      g.translate(b.x, 0, b.z);
      B.add(i % 2 ? 'plazaInlay' : 'plazaAccent', g);
    }
  }

  /* --- the centrepiece, claimed first ----------------------------------- */
  const cx = b.x, cz = b.z;
  const small = Math.min(b.w, b.d);

  if (inBuilding(cx, cz)) {
    /* A hand-placed landmark already stands here — Government Center, the
       arena, the amphitheatre. buildings.js gets the middle of the block; this
       file used to build a SECOND amphitheatre on top of the first and thread
       six rows of stepped seating through its walls. The edge planting below
       still runs, which is all a landmark forecourt should have. */
  } else if (b.landmark && /Amphitheatre|Amphitheater/i.test(b.landmark) && small > 26) {
    /* The hand-placed hero: a bandshell facing a bowl of stepped seating. */
    plant(ctx, 'bandshell', cx, cz - hd * 0.52, 0, 1.15, { clear: 0 });
    for (let i = 0; i < 6; i++) {
      const w = Math.min(b.w * 0.86, 20 + i * 4.5);
      B.add('stone', box(w, 0.44 * (i + 1), 2.0, cx, ctx.Y_WALK + 0.22 * (i + 1),
        cz - hd * 0.20 + i * 2.3, 2));
    }
    // The terraces run 13 m deep and are merged surfaces, so they claim nothing
    // by themselves; the disc below only covers the middle of the bowl.
    claimBox(ctx, cx, cz - hd * 0.20 + 5.75, Math.min(b.w * 0.86, 42.5), 15, 1.7);
    ctx.occupy(cx, cz, small * 0.44);
  } else if (small > 25) {
    plant(ctx, 'fountainL', cx, cz, rng() * 6.283, 1.0 + rng() * 0.25, { clear: 0 });
    ctx.occupy(cx, cz, 6.0);
  } else if (rng.chance(0.72)) {
    plant(ctx, 'fountainS', cx, cz, rng() * 6.283, 1.05 + rng() * 0.3, { clear: 0 });
    ctx.occupy(cx, cz, 4.0);
  } else {
    placeSculpture(ctx, cx, cz, rng, true);
  }
  stats.features++;

  /* Seating steps against one edge — plazas are for sitting on.
     BEFORE the planting, not after: these are merged `stone` geometry that
     claims no ground of its own, and running them last let the green panels and
     the palm allée put live oaks in the middle of a flight of steps. */
  const along0 = b.w >= b.d;
  const sgn0 = rng.chance(0.5) ? -1 : 1;
  const seatOff = (along0 ? hd : hw) - 4.8;
  const seatX = along0 ? b.x : b.x + sgn0 * seatOff;
  const seatZ = along0 ? b.z + sgn0 * seatOff : b.z;
  if (small > 20 && rng.chance(0.7) && !inBuilding(seatX, seatZ)) {
    const along = along0;
    const sgn = sgn0;
    const runL = Math.min(20, (along ? b.w : b.d) * 0.55);
    for (let i = 0; i < 3; i++) {
      const soff = (along ? hd : hw) - 5.5 + i * 1.4;
      if (along) {
        B.add('stone', box(runL, 0.4 * (i + 1), 1.5, b.x, ctx.Y_WALK + 0.2 * (i + 1), b.z + sgn * soff, 2));
      } else {
        B.add('stone', box(1.5, 0.4 * (i + 1), runL, b.x + sgn * soff, ctx.Y_WALK + 0.2 * (i + 1), b.z, 2));
      }
    }
    const mid = (along ? hd : hw) - 5.5 + 1.4;
    if (along) claimBox(ctx, b.x, b.z + sgn * mid, runL, 4.7, 1.3);
    else claimBox(ctx, b.x + sgn * mid, b.z, 4.7, runL, 1.3);
  }

  /* --- green panels ----------------------------------------------------- */
  // A plaza with no turf at all is a car park with pattern on it. Two kerbed
  // lawn panels break the paving up and give the palms something to stand in.
  if (Math.min(b.w, b.d) > 19) {
    const panels = Math.min(4, Math.max(2, Math.round((b.w * b.d) / 700)));
    for (let i = 0; i < panels; i++) {
      const a = (i / panels) * 6.283 + 0.8;
      const gw = Math.min(hw * 0.6, 7.5 + rng() * 4);
      const gd = Math.min(hd * 0.6, 5.5 + rng() * 4);
      const gx = b.x + Math.cos(a) * (hw - gw / 2 - band - 0.8);
      const gz = b.z + Math.sin(a) * (hd - gd / 2 - band - 0.8);
      if (gw < 3 || gd < 3) continue;
      B.add('lawnA', tile(gw, gd, gx, gz, y + 0.055, 8));
      B.add('kerb', box(gw + 0.34, 0.30, 0.3, gx, y + 0.145, gz - gd / 2, 1));
      B.add('kerb', box(gw + 0.34, 0.30, 0.3, gx, y + 0.145, gz + gd / 2, 1));
      B.add('kerb', box(0.3, 0.30, gd, gx - gw / 2, y + 0.145, gz, 1));
      B.add('kerb', box(0.3, 0.30, gd, gx + gw / 2, y + 0.145, gz, 1));
      // A kerbed 7 x 5 m turf panel is exactly the site a Bismarckia is planted
      // on in the real Brickell — one specimen, nothing else in the box.
      plant(ctx, rng.weighted([['liveOak', 26], ['jacaranda', 19], ['poinciana', 17],
        ['bougain', 14], ['tabebuia', 11], ['bismarck', 13]]), gx, gz,
      rng() * 6.283, 0.8 + rng() * 0.3, { clear: 1.6, y: 0.06 });
      for (let k = 0; k < 5; k++) {
        plant(ctx, rng.weighted(UNDER),
          gx + (rng() - 0.5) * gw * 0.7, gz + (rng() - 0.5) * gd * 0.7,
          rng() * 6.283, 0.75 + rng() * 0.4, { clear: 0.7, y: 0.06, tintIndex: k });
      }
    }
  }

  /* --- an allée of palms, because a plaza wants shade lines -------------- */
  const alongX = b.w >= b.d;
  const runLen = (alongX ? b.w : b.d) - 8;
  const off = (alongX ? hd : hw) * 0.62;
  if (runLen > 12) {
    const n = Math.max(2, Math.round(runLen / 8.5));
    const key = rng.weighted([['royalA', 31], ['queenPalm', 22], ['sabal', 18],
      ['washingtonia', 12], ['arecaClump', 10], ['royalB', 9]]);
    for (let s = -1; s <= 1; s += 2) {
      for (let i = 0; i <= n; i++) {
        const t = -runLen / 2 + (runLen / n) * i;
        const px = alongX ? b.x + t : b.x + s * off;
        const pz = alongX ? b.z + s * off : b.z + t;
        if (plant(ctx, key, px, pz, rng() * 6.283, 0.88 + rng() * 0.28,
          { clear: 2.2, tintIndex: i })) {
          B.add('plazaInlay', disc(1.15, 8, px, y + 0.045, pz, null));
        }
      }
    }
    /* Lamps on the allée, between every second pair of palms. A plaza is the
       one public space that is genuinely used after dark, and an unlit one is
       a grey slab in every night frame. */
    const ln = Math.max(1, Math.round(runLen / 15));
    for (let s = -1; s <= 1; s += 2) {
      for (let i = 0; i <= ln; i++) {
        const t = -runLen / 2 + (runLen / ln) * i;
        const px = alongX ? b.x + t : b.x + s * off * 0.60;
        const pz = alongX ? b.z + s * off * 0.60 : b.z + t;
        plant(ctx, 'parkLamp', px, pz, rng() * 6.283, 1, { clear: 0.9, noTilt: true });
      }
    }
  }

  /* Raised planters around the edges. Forced: a plaza has no building on it,
     so the only thing occupancy can be objecting to is our own planting, and a
     planter tucked beside a palm is exactly what a plaza looks like. */
  const pn = Math.max(3, Math.round((b.w + b.d) / 16));
  for (let i = 0; i < pn; i++) {
    const a = (i / pn) * 6.283 + rng() * 0.4;
    const px = b.x + Math.cos(a) * hw * 0.76;
    const pz = b.z + Math.sin(a) * hd * 0.76;
    plant(ctx, rng.chance(0.4) ? 'planterL' : 'planterS', px, pz,
      Math.abs(Math.cos(a)) > 0.5 ? Math.PI / 2 : 0, 1, { clear: 1.0, force: true });
  }

  /* A run of chunky ground-level mass in the border band. Fan palms mostly,
     with agave and croton threaded in: three completely different silhouettes
     at knee-to-waist height is what keeps a big paved square from reading as
     one texture with dots on it. */
  const fn = Math.max(3, Math.round((b.w + b.d) / 14));
  for (let i = 0; i < fn; i++) {
    const a = (i / fn) * 6.283 + 0.5;
    plant(ctx, rng.weighted([['fanShort', 26], ['sago', 20], ['agave', 18],
      ['croton', 16], ['hibiscus', 12], ['traveller', 8]]),
    b.x + Math.cos(a) * hw * 0.55, b.z + Math.sin(a) * hd * 0.55,
    rng() * 6.283, 0.9 + rng() * 0.3, { clear: 1.2, force: true, tintIndex: i });
  }

  if (rng.chance(0.5) && small > 20) {
    plant(ctx, 'pergola', b.x + (rng() - 0.5) * hw * 0.9, b.z + (rng() - 0.5) * hd * 0.9,
      rng.chance(0.5) ? 0 : Math.PI / 2, 1, { clear: 2.6, force: true });
  }
  if (b.landmark && small > 18) {
    for (let i = -1; i <= 1; i++) {
      plant(ctx, i === 0 ? 'flagUS' : 'flagCity',
        b.x + i * 3.2, b.z - hd * 0.72, 0, 1, { clear: 1.0, force: true });
    }
  }

  blockShoreline(ctx, b, rng);
}

function placeSculpture(ctx, x, z, rng, force = false, dy = 0) {
  const hex = rng.pick([
    PALETTE.ACCENT_HOT, PALETTE.ACCENT_SUN, PALETTE.ACCENT_AQUA,
    PALETTE.STUCCO_CORAL, PALETTE.ACCENT_LILAC, PALETTE.PATINA,
  ]);
  // Same invariants as plant(): public art is not exempt from the bay or a
  // building, and `force` only ever overrules the occupancy grid.
  if (ctx.layout.isWater(x, z) || ctx.layout.isRoad(x, z) || inBuilding(x, z)) return null;
  if (!sepFree(x, z, 1.9)) return null;
  if (!force && !ctx.isFree(x, z, 2.6)) return null;
  ctx.occupy(x, z, 2.6);
  sepTake(x, z, 1.9);
  const c = ctx.addInstanced('nat-sculpture', () => ({
    geometry: makeSculpture(0x5c17),
    material: painted(0xffffff, 0.46, 0.10),
  }), {
    position: _v3.set(x, ctx.Y_WALK + dy, z),
    rotationY: rng() * 6.283,
    scale: 0.9 + rng() * 0.5,
    hex,
    tier: TIER.XLARGE,
    radius: 1.6,
    height: 5.4,
    label: 'Public Art',
    kind: 'sculpture',
    capacity: 90,
    castShadow: true,
    debrisColor: hex,
  });
  stats.instances++;
  return c;
}

/* ---------------------------------------------------- water's edge etc. --- */

/**
 * Mangroves standing in the shallows at the foot of a seawall.
 *
 * THE ONE SANCTIONED EXCEPTION to "nothing in the water". A mangrove in 30 cm
 * of water at the foot of the wall is what makes a coast read as a coast
 * instead of as the place the ground texture stops, and it is the only thing
 * in this file allowed to pass `shoreline`.
 *
 * `(nx, nz)` points at the water and `t` runs along the edge. March out to find
 * where the land ACTUALLY stops rather than trusting the parcel line — a
 * bayfront parcel can end 14 m short of the bay — and refuse anything more than
 * a couple of metres past it, because further out is not a mangrove, it is a
 * tree in the sea. A bridge deck sits 1.2 m over the water, so keep clear of
 * those too or the fringe grows up through the carriageway.
 */
function mangroveFringe(ctx, rng, ax, az, nx, nz, len, spacing, reach) {
  let placed = 0;
  const steps = Math.max(1, Math.round(len / spacing));
  for (let i = 0; i <= steps; i++) {
    const t = -len / 2 + (len / steps) * i + (rng() - 0.5) * spacing * 0.3;
    const px = ax - nz * t, pz = az + nx * t;
    let wet = -1;
    for (let d = 0; d <= reach; d += 0.5) {
      if (ctx.layout.isWater(px + nx * d, pz + nz * d)) { wet = d; break; }
    }
    if (wet < 0) continue;
    // One offset for both axes — two draws would put a diagonal fringe on a
    // different point in x than in z the day one of these edges is not axial.
    const off = wet + 0.7 + rng() * 1.5;
    const ox = px + nx * off, oz = pz + nz * off;
    let underBridge = false;
    for (const br of ctx.layout.bridges) {
      if (Math.abs(ox - br.x) < br.width / 2 + 5 && Math.abs(oz - br.z) < br.length / 2 + 5) {
        underBridge = true; break;
      }
    }
    if (underBridge) continue;
    if (plant(ctx, 'mangrove', ox, oz, rng() * 6.283, 0.8 + rng() * 0.4,
      { shoreline: true, clear: 0, force: true, y: -0.55 })) placed++;
  }
  return placed;
}

/**
 * Fringe whichever side of a block faces open water.
 *
 * Called from every block type, because the coast does not care about zoning:
 * the bay runs past parks, plazas and towers, and only the six promenade
 * parcels used to get a shoreline at all. Blocks that turn out not to reach the
 * water simply plant nothing — `bayfront` is true up to 58 m inland, so most of
 * them are in that position and the march is what settles it.
 */
function blockShoreline(ctx, b, rng) {
  if (!b.bayfront && !b.riverwalk) return;
  const seaward = b.bayfront ? 'e' : (b.z > 0 ? 'n' : 's');
  const along = seaward === 'n' || seaward === 's';
  const runL = (along ? b.w : b.d) - 4;
  if (runL < 8) return;
  const nx = along ? 0 : (seaward === 'e' ? 1 : -1);
  const nz = along ? (seaward === 's' ? 1 : -1) : 0;
  // 22 m of reach: on this coast a parcel is usually separated from the water
  // by the seawall road and its apron, and a short march stops on the tarmac
  // and gives up. Over-reaching costs nothing — the fringe is planted at
  // whatever waterline it finds — and where two blocks find the same stretch of
  // wall the spacing set dedupes them.
  mangroveFringe(ctx, rng, b.x + nx * (b.w / 2), b.z + nz * (b.d / 2),
    nx, nz, runL, 11, 22);
}

/**
 * Promenade / dock apron / riverwalk planting.
 *
 * These blocks sit on the seawall, so they get the coastal palette: sea
 * grapes and mangroves at the edge, a palm line down the walk, and timber
 * decking rather than turf where it is a dock.
 */
function waterfrontBlock(ctx, B, b, rng) {
  const y = ctx.Y_WALK + 0.015;
  const hw = b.w / 2 - 0.5, hd = b.d / 2 - 0.5;
  const dock = b.subtype === 'dock' || b.zone === ZONE.MARINA;

  B.add(dock ? 'deck' : 'plazaBase', tile(hw * 2, hd * 2, b.x, b.z, y, dock ? 4 : 5.5));
  if (!dock) {
    // A terracotta ribbon running the length of the walk, the way the real
    // Baywalk is banded. It also gives the promenade a direction.
    B.add('plazaAccent', tile(hw * 2, 2.2, b.x, b.z - hd + 1.1, y + 0.03, 2.0));
    B.add('plazaAccent', tile(hw * 2, 2.2, b.x, b.z + hd - 1.1, y + 0.03, 2.0));
    B.add('plazaAccent', tile(2.4, hd * 2 - 4.4, b.x - hw * 0.16, b.z, y + 0.03, 2.0));
  }

  // The bay is east, so the seaward edge is +x. Plant the walk on the inland
  // side and let the coastal scrub hold the edge.
  const walkX = b.x - hw * 0.52;
  const n = Math.max(1, Math.round((hd * 2) / 8));
  for (let i = 0; i <= n; i++) {
    const pz = b.z - hd + (hd * 2 / n) * i;
    const key = rng.weighted([['royalA', 23], ['coconutA', 20], ['royalB', 13],
      ['queenPalm', 13], ['sabal', 13], ['arecaClump', 10], ['washingtonia', 8]]);
    if (plant(ctx, key, walkX, pz, rng() * 6.283, 0.88 + rng() * 0.34,
      { force: true, tintIndex: i })) {
      B.add('plazaInlay', disc(1.2, 8, walkX, y + 0.045, pz, null));
    }
    // A lamp between every second pair of palms, offset onto the paving side so
    // the two lines read as one lit promenade rather than as two rows.
    if (i % 2 === 1) {
      plant(ctx, 'parkLamp', walkX + 3.1, pz - (hd / Math.max(1, n)),
        rng() * 6.283, 1, { clear: 0.9, force: true, noTilt: true });
    }
  }

  /* A turf strip between the walk and the paving — the promenade is a park,
     not an apron, and an unbroken cream slab is the defect being fixed here. */
  if (hw > 5 && !dock) {
    const gw = Math.min(6.5, hw * 0.5);
    const gx = b.x + hw * 0.30;
    B.add('lawnA', tile(gw, hd * 2 - 5.0, gx, b.z, y + 0.05, 8));
    B.add('kerb', box(0.28, 0.28, hd * 2 - 5.0, gx - gw / 2, y + 0.14, b.z, 1));
    B.add('kerb', box(0.28, 0.28, hd * 2 - 5.0, gx + gw / 2, y + 0.14, b.z, 1));
    /* Specimens down the turf strip, forced for the same reason as the park's.
       A promenade is the one place in the city where the camera is guaranteed
       to be looking along a planted line against open water, so it is where a
       silver crown or a 20 m spike buys the most. Every third station, so the
       strip stays a lawn with plants on it rather than a second tree line. */
    const sn = Math.max(1, Math.round(hd * 2 / 22));
    for (let i = 0; i < sn; i++) {
      const pz = b.z - hd + (hd * 2 / sn) * (i + 0.5);
      plant(ctx, rng.weighted([['bismarck', 40], ['washingtonia', 26],
        ['traveller', 14], ['seagrapeT', 12], ['coconutA', 8]]),
      gx + (rng() - 0.5) * gw * 0.3, pz, rng() * 6.283, 0.92 + rng() * 0.24,
      { force: true, clear: 2.4, y: 0.05, tintIndex: i });
    }
  }

  const edgeX = b.x + hw * 0.78;
  const en = Math.max(2, Math.round((hd * 2) / 4.4));
  for (let i = 0; i < en; i++) {
    const pz = b.z - hd + (hd * 2 / en) * (i + 0.5);
    plant(ctx, rng.weighted([['seagrapeT', 28], ['mangrove', 19], ['shrub', 13],
      ['hibiscus', 10], ['ornGrass', 10], ['croton', 8], ['agave', 7], ['sago', 5]]),
    edgeX + (rng() - 0.5) * 2.0, pz, rng() * 6.283, 0.85 + rng() * 0.4,
    { tintIndex: i, force: true });
  }

  // Mangroves in the shallows off the seaward (+x) edge. A dock apron gets none
  // — a mangrove between the finger piers is a boat hazard, not a shoreline.
  if (!dock) mangroveFringe(ctx, rng, b.x + hw, b.z, 1, 0, hd * 2, 9, 18);
  // Planted terraces stepping down to the water.
  if (b.w > 26 && rng.chance(0.7)) {
    for (let i = 0; i < 2; i++) {
      B.add('stone', box(1.6, 0.36 * (i + 1), hd * 2 * 0.9,
        b.x + hw * 0.52 + i * 1.7, ctx.Y_WALK + 0.18 * (i + 1), b.z, 2));
    }
  }

  /* Furniture: shade, colour and a landmark every few blocks. */
  const pn = Math.max(2, Math.round(hd * 2 / 14));
  for (let i = 0; i < pn; i++) {
    const pz = b.z - hd + (hd * 2 / pn) * (i + 0.5);
    plant(ctx, rng.chance(0.45) ? 'planterL' : 'planterS', b.x - hw * 0.1, pz,
      Math.PI / 2, 1, { clear: 1.4 });
  }
  if (rng.chance(0.55)) plant(ctx, 'pergola', b.x - hw * 0.2, b.z, Math.PI / 2, 1, {});
  if (rng.chance(0.45)) plant(ctx, 'fountainS', b.x - hw * 0.1, b.z + hd * 0.45, rng() * 6.283, 1.1, {});
  if (rng.chance(0.35)) placeSculpture(ctx, b.x - hw * 0.1, b.z - hd * 0.45, rng);
}

/* ------------------------------------------------------------ built lots -- */

/**
 * Everything that is not open space still gets planting: street trees on the
 * frontage, and a strip of shrubs in the setback so the sidewalk edge is
 * never a bare cream band.
 */
function builtBlock(ctx, B, b, rng) {
  buildStreetTrees(ctx, B, b, rng);

  /* Foundation planting.
     On EVERY public frontage, not just the busiest one: a corner lot with a
     planted south side and a bare east side reads as an unfinished model, and
     the frontage is exactly the strip the player's camera spends the game
     looking at. */
  const inset = Math.max(2.3, Math.min(b.sidewalk * 0.8, Math.min(b.w, b.d) * 0.5 * 0.15));
  let fi = 0;
  // A dead-quiet lot gets no hedge line, but it still gets its shoreline: this
  // used to `return` here, which meant the calmest bayfront lots — exactly the
  // ones with nothing else happening on them — were the bare stretches of wall.
  for (const fr of (b.streetLife < 0.22 ? [] : b.frontageStreets)) {
    const horiz = fr.side === 'n' || fr.side === 's';
    const len = (horiz ? b.w : b.d) - 6;
    if (len < 8) continue;
    // Secondary frontages get a thinner, quieter line — a full hedge on all
    // four sides of every block is its own kind of wallpaper.
    const density = fi++ === 0 ? 3.4 : 4.6;
    const n = Math.floor(len / density);
    for (let i = 0; i < n; i++) {
      const t = -len / 2 + (i + 0.5) * (len / n);
      // Kerb point and the inward normal, then ask the measured footprint how
      // far in the wall actually is and sit 1 m in front of it.
      let kx, kz, nx = 0, nz = 0, rot;
      if (fr.side === 'n') { kx = b.x + t; kz = b.z - b.d / 2; nz = 1; rot = 0; }
      else if (fr.side === 's') { kx = b.x + t; kz = b.z + b.d / 2; nz = -1; rot = 0; }
      else if (fr.side === 'w') { kx = b.x - b.w / 2; kz = b.z + t; nx = 1; rot = Math.PI / 2; }
      else { kx = b.x + b.w / 2; kz = b.z + t; nx = -1; rot = Math.PI / 2; }
      const d = Math.max(1.5, Math.min(inset, wallDepth(kx, kz, nx, nz, inset + 3.5) - 1.0));
      const px = kx + nx * d, pz = kz + nz * d;
      if (rng.chance(0.58)) {
        plantOut(ctx, 'hedge', px, pz, -nx, -nz, rot, 0.85 + rng() * 0.2,
          { clear: 1.2, tintIndex: i, force: true }, 2, 0.5);
      } else {
        plantOut(ctx, rng.weighted(UNDER), px, pz, -nx, -nz,
          rng() * 6.283, 0.8 + rng() * 0.4,
          { clear: 1.0, tintIndex: i, force: true }, 2, 0.5);
      }
    }
  }

  /* SIDE AND REAR YARDS.
     The frontage line above only plants the strip the street sees. Buildings
     fill 70-82% of a parcel, so the remaining 18-30% is service yards, light
     wells and car-park edges — real ground, in shot from the high 3/4 camera,
     and until now bare.

     These are FORCED, and they have to be: buildings claim occupancy as a
     square sized to their circumradius, which blankets the whole parcel, so
     reading that grid places nothing at all (measured: 12 trees across all 216
     blocks). What replaces the read is a stronger test than the read was —
     `openYard` demands a genuinely clear 5 m circle against the buildings'
     MEASURED bounding boxes, so a tree only lands where there is a yard, not
     merely where the grid happens not to have been claimed. props.js runs after
     us and works around what we then claim. */
  const yardN = Math.round(b.area / 620);
  for (let i = 0; i < yardN; i++) {
    const yx = b.x + (rng() - 0.5) * b.w * 0.92;
    const yz = b.z + (rng() - 0.5) * b.d * 0.92;
    if (!openYard(yx, yz, 2.6)) continue;
    /* The yards are where the Bismarckia actually gets distributed. There are
       only a dozen park parcels in the whole city, so however hard the parks
       weight a specimen there are never going to be many of them; side and
       rear yards number in the hundreds, they are in shot from the high 3/4
       camera all game, and a silver crown in a service yard between two coral
       stucco walls is the single cheapest piece of hue variety on the map. */
    const key = rng.weighted([['liveOak', 13], ['mahogany', 11], ['sabal', 11],
      ['queenPalm', 10], ['royalB', 9], ['arecaClump', 8], ['poinciana', 8],
      ['jacaranda', 7], ['coconutB', 6], ['banyan', 4], ['bismarck', 9],
      ['washingtonia', 4]]);
    if (plant(ctx, key, yx, yz, rng() * 6.283, 0.82 + rng() * 0.34,
      { force: true, clear: 2.4, tintIndex: i })) {
      treePit(B, yx, yz, 1.0, ctx.Y_WALK + 0.02);
    } else {
      // No room for a canopy is not a reason for bare tarmac — a shrub mass
      // fits in a metre and still breaks the slab up.
      plant(ctx, rng.weighted(UNDER), yx, yz,
        rng() * 6.283, 0.8 + rng() * 0.4, { force: true, clear: 1.0, tintIndex: i });
    }
  }

  // Runs first, and on its own guards, so a lot too narrow for the sea-grape
  // row below still gets its waterline planted.
  blockShoreline(ctx, b, rng);

  /* COASTAL EDGE ON A BUILT LOT.
     The bay and the river run past far more towers than promenades — only six
     blocks in the whole city are zoned promenade — so without this the seawall
     reads as a bare cream band for most of its length. A row of sea grapes and
     palms along the water-facing side is cheap and it is what actually holds
     that edge together from the menu-hero camera. */
  if (!b.bayfront && !b.riverwalk) return;
  const seaward = b.bayfront ? 'e' : (b.z > 0 ? 'n' : 's');
  const along = seaward === 'n' || seaward === 's';
  const runL = (along ? b.w : b.d) - 6;
  if (runL < 8) return;
  const en = Math.max(2, Math.round(runL / 6.5));
  /* The row sat 2.0 m in from the parcel line and was refused almost outright:
     `buildStreetTrees` runs first and plants its line at an inset of 1.75-2.35,
     so on any lot whose seaward side is also a frontage the two rows want the
     same strip and the spacing set — correctly — keeps the one that got there
     first. The audit found 19 sea grapes in the whole city, on a coastline this
     row exists to hold together. Marching INWARD instead of insisting on one
     depth puts the scrub behind the street trees, which is where a seawall
     planting belongs anyway. */
  const inx = along ? 0 : (seaward === 'e' ? -1 : 1);
  const inz = along ? (seaward === 's' ? -1 : 1) : 0;
  for (let i = 0; i <= en; i++) {
    const t = -runL / 2 + (runL / en) * i;
    const off = (along ? b.d : b.w) / 2 - 2.0;
    const ex = along ? b.x + t : b.x + (seaward === 'e' ? off : -off);
    const ez = along ? b.z + (seaward === 's' ? off : -off) : b.z + t;
    const key = rng.weighted([['seagrapeT', 24], ['coconutA', 15], ['royalB', 11],
      ['queenPalm', 7], ['shrub', 11], ['hibiscus', 9], ['ornGrass', 8],
      ['croton', 7], ['bismarck', 8]]);
    plantOut(ctx, key, ex, ez, inx, inz, rng() * 6.283, 0.85 + rng() * 0.35,
      { clear: 1.2, force: true, tintIndex: i }, 3, 1.4);
  }
}

/* ======================================================================== */
/*  ENTRY POINT                                                             */
/* ======================================================================== */

export function buildNature(ctx) {
  const { layout } = ctx;
  const B = new Buckets();

  stats.trees = 0; stats.palms = 0; stats.bushes = 0;
  stats.features = 0; stats.beds = 0; stats.instances = 0; stats.capped = 0;
  rej.water = 0; rej.road = 0; rej.building = 0; rej.spacing = 0; rej.occupied = 0;
  badContact.length = 0;

  // Before any planting: the shader reads nightFactor and the hole from these
  // uniforms on its very first frame.
  installClock(ctx);

  // Buildings run before us, so their assembled geometry is on the scene and
  // can be measured. Nothing else can tell us where a wall actually is.
  PLANTED = new Map();
  const nFoot = buildFootprints(ctx);

  buildMedians(ctx);

  for (const b of layout.blocks) {
    const rng = makeRNG(b.seed ^ 0x51ab);
    // `bayfront` reaches 58 m inland, so it is not on its own a reason to
    // treat a block as seawall — only the promenade and dock bands are.
    const onWater = b.subtype === 'promenade' || b.subtype === 'dock';
    switch (b.zone) {
      case ZONE.PARK:
        // A bayfront "park" that is really the promenade wants the coastal
        // treatment, not a lawn on the seawall.
        if (onWater) waterfrontBlock(ctx, B, b, rng);
        else parkBlock(ctx, B, b, rng);
        break;
      case ZONE.PLAZA:
        if (onWater) waterfrontBlock(ctx, B, b, rng);
        else plazaBlock(ctx, B, b, rng);
        break;
      case ZONE.MARINA:
        // Nobody else builds on a marina apron, so it would otherwise render
        // as a bare grey void — see the project-lead defect list.
        waterfrontBlock(ctx, B, b, rng);
        break;
      default:
        builtBlock(ctx, B, b, rng);
        break;
    }
  }

  const merged = B.flush(ctx);

  console.info(
    `[nature] ${stats.palms} palms + ${stats.trees} trees + ${stats.bushes} shrubs/beds, `
    + `${stats.features} park features, ${stats.beds} flower beds | ${stats.instances} instances in `
    + `${Object.keys(_factories).length + 1} pools + ${merged.calls} merged meshes `
    + `(${Math.round(merged.tris / 1000)}k static tris) | `
    + `${nFoot} building footprints avoided | refused `
    + `${rej.building} in-building, ${rej.spacing} too close, ${rej.occupied} occupied, `
    + `${rej.water} in water, ${rej.road} on road`
    + (stats.capped ? ` | WARNING ${stats.capped} plantings dropped, a pool is FULL` : '')
  );
  // Silence here is the point: it means every species still puts nothing but
  // trunk on the ground, so the consumption physics is measuring the right
  // thing. A line means a crown has sagged into the contact band again.
  if (badContact.length) {
    console.warn(`[nature] CONTACT BAND is not trunk on: ${badContact.join(', ')}`);
  }
}
