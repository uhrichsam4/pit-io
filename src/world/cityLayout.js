/**
 * City layout: the street grid, parcel subdivision and zoning for
 * Brickell + Downtown Miami.
 *
 * Geography (game space, metres):
 *   +x = east  -> Biscayne Bay lives beyond WORLD.BAY_EDGE
 *   +z = south -> Brickell
 *   -z = north -> Downtown
 *   The Miami River runs east/west near z = 0 and splits the two districts.
 *
 * This module produces PURE DATA. No THREE objects. Every content module
 * (streets, buildings, props, nature, vehicles) reads the same layout so the
 * city stays coherent no matter who generated which piece.
 *
 * DESIGN NOTES — why this is not a uniform grid
 * ---------------------------------------------
 * A constant BLOCK step reads as "gridworld" from the air, which is the single
 * loudest tell that a city is procedural. Real Miami has three different
 * rhythms stacked on one another:
 *   - Downtown (z < 0): long east/west superblocks, civic parcels, surface
 *     parking, Flagler St as a low-rise retail spine.
 *   - Brickell (z > 0): a much tighter grid of small, deep parcels carrying
 *     slender towers on retail podiums, hung off Brickell Ave.
 *   - The waterfront: a continuous promenade band, marina basins notched into
 *     the shore, and Brickell Key sitting off the river mouth.
 * So the road plans below are hand-authored rhythms, not loops. Block widths
 * are the *output* of the plan (71, 74, 64, 56, 44, 34, 46, 40, 48, 20, 49 m
 * west to east), and each cell is then recursively subdivided into parcels
 * separated by service alleys, which is where the fine grain comes from.
 *
 * SUB-GRID FEATURES ARE EXPRESSED AS ABSENCES.
 * streets.js draws every road in `roadsX`/`roadsZ` as a full-map-length strip,
 * so an "alley" or a "diagonal" cannot be a road entry — it would run the whole
 * map. Instead they are gaps in block coverage (the base ground plane shows
 * through) *plus* explicit `alleys` / `diagonals` data so a future streets.js
 * can pave them properly. Same story for `waterPolys`: `isWater()` is already
 * correct for the marina basins and the Brickell Key cuts, but water.js only
 * renders the straight bay + straight river today.
 */

import { WORLD, DISTRICT } from '../config.js';
import { makeRNG } from '../core/rng.js';

/** Block zoning archetypes. buildings.js switches on exactly these. */
export const ZONE = {
  TOWER: 'tower',           // glass high-rise / luxury condo
  MIDRISE: 'midrise',       // 6-14 storey office or apartment
  LOWRISE: 'lowrise',       // 2-4 storey retail / restaurant strip
  RETAIL: 'retail',         // dense storefront row, cafés, awnings
  PARKING: 'parking',       // open-deck parking garage
  CONSTRUCTION: 'construction',
  PARK: 'park',
  PLAZA: 'plaza',
  LANDMARK: 'landmark',     // arena, courthouse, tower centrepiece
  MARINA: 'marina',
};

export const ROAD_CLASS = { STREET: 'street', AVENUE: 'avenue', BOULEVARD: 'boulevard' };

/** Coarse height band. `b.heightClass` — a hint, buildings.js owns the metres. */
export const HEIGHT_CLASS = {
  GROUND: 'ground',   // 0 storeys: park, plaza, basin
  LOW: 'low',         // 1-4
  MID: 'mid',         // 5-14
  HIGH: 'high',       // 15-40
  SUPER: 'super',     // 40+, the skyline anchors
};

/** Facade language tag. Landmarks always carry one; ordinary blocks may. */
export const STYLE = {
  DECO: 'deco',       // Miami Deco masonry, banded, stepped crown
  GLASS: 'glass',     // curtain wall
  CIVIC: 'civic',     // heavy stone, colonnade, low and wide
  ARENA: 'arena',     // big-span roof, no windows
  TOWER: 'tower',     // slender residential, balcony slabs
  STUCCO: 'stucco',   // painted pastel infill
};

/** Display name stamped on every block the zoo covers. */
export const ZOO_NAME = 'Miami Metrozoo';

/**
 * The six pens, in descending order of how much ground the animal wants.
 *
 * The index is the AREA RANK of the slot the grid hands us, not a position:
 * the giraffe always ends up in the biggest pen and the aviary in the
 * smallest, whatever shape the road grid leaves behind on a given seed.
 * `kind` is the contract props.js and the animal module switch on — grass,
 * water, rock, aviary — so all four surfaces are represented on purpose.
 */
/* THESE NAMES ARE A CONTRACT WITH animals.js, not decoration.
   The first version of this table was a Miami-authentic roster — flamingo,
   alligator, panther, capybara, macaw — while animals.js modelled the species
   actually requested: elephant, giraffe, zebra, monkey, penguin, birds. Only
   `giraffe` appeared in both, so the other five were matched by INDEX, and the
   result was three elephants living in the Gator Swamp and zebras on the
   Capybara Lawn. Nothing threw; the signs just described the wrong animals.
   The species key must equal the key in animals.js SPECIES. */
export const ZOO_SPECIES = [
  { species: 'elephant', kind: 'grass', label: 'Elephant Yard' },
  { species: 'giraffe', kind: 'grass', label: 'Giraffe Paddock' },
  { species: 'zebra', kind: 'grass', label: 'Zebra Plain' },
  { species: 'monkey', kind: 'rock', label: 'Primate Rocks' },
  { species: 'penguin', kind: 'water', label: 'Penguin Cove' },
  { species: 'bird', kind: 'aviary', label: 'Wading Bird Aviary' },
];

const { STREET, AVENUE, BOULEVARD } = ROAD_CLASS;

/** Road half-width per class. Boulevards get four lanes plus a median. */
const HALF = {
  [STREET]: WORLD.ROAD_W,
  [AVENUE]: WORLD.AVENUE_W,
  [BOULEVARD]: WORLD.AVENUE_W + 4,
};

/**
 * North/south roads, west to east. Spacing is deliberately uneven: coarse and
 * cheap out west (superblocks, warehouses), progressively finer as you approach
 * the two boulevards and the bay.
 */
const X_PLAN = [
  { pos: -438, cls: STREET, name: 'SW 15 Ave' },
  { pos: -336, cls: AVENUE, name: 'SW 12 Ave' },
  { pos: -244, cls: STREET, name: 'SW 10 Ave' },
  { pos: -160, cls: AVENUE, name: 'SW 8 Ave' },
  { pos: -88, cls: STREET, name: 'SW 6 Ave' },
  // The downtown transit spine — Metrorail/Metromover runs above it.
  { pos: -22, cls: BOULEVARD, name: 'S Miami Ave', median: true, medianW: 8, transit: true },
  { pos: 56, cls: STREET, name: 'SW 1 Ave' },
  // The hero spine. Landscaped median, podium retail either side.
  { pos: 128, cls: BOULEVARD, name: 'Brickell Ave', median: true, medianW: 9, spine: true },
  { pos: 208, cls: STREET, name: 'SE 2 Ave' },
  { pos: 260, cls: BOULEVARD, name: 'Biscayne Blvd', median: true, medianW: 8 },
];

/**
 * East/west roads. The two districts run different rhythms, which is legal
 * because z is exactly what separates them: downtown gets ~58 m deep
 * superblocks, Brickell gets 18-43 m deep parcels.
 */
const Z_PLAN = [
  /* ---- Downtown (north of the river) ---- */
  { pos: -450, cls: STREET, name: 'NE 15 St' },
  { pos: -364, cls: AVENUE, name: 'NE 11 St' },
  { pos: -278, cls: STREET, name: 'NE 6 St' },
  // Flagler is a pedestrian-first retail street: narrow-ish, dense, low.
  { pos: -200, cls: BOULEVARD, name: 'Flagler St', spine: true, retail: true },
  { pos: -118, cls: STREET, name: 'SE 4 St' },
  /* ---- Brickell (south of the river) ---- */
  { pos: 84, cls: STREET, name: 'SE 5 St' },
  { pos: 142, cls: STREET, name: 'SE 8 St' },
  { pos: 194, cls: AVENUE, name: 'SE 10 St' },
  { pos: 250, cls: BOULEVARD, name: 'SW 8 St', spine: true },
  { pos: 310, cls: STREET, name: 'SE 12 St' },
  { pos: 366, cls: AVENUE, name: 'SE 15 Rd' },
  { pos: 424, cls: STREET, name: 'SE 25 Rd' },
  { pos: 478, cls: STREET, name: 'SE 32 Rd' },
];

/* ------------------------------------------------------- river geometry --- */

/**
 * The channel centreline. A ruler-straight river is the second loudest
 * proceduralism tell after the uniform grid, so it swings ~15 m either side of
 * WORLD.RIVER_Z on two out-of-phase sines.
 */
export function riverCenterAt(x) {
  const c = -9.0 * Math.sin((x + 470) / 300) + 5.5 * Math.sin((x - 60) / 118);
  return WORLD.RIVER_Z + Math.max(-15, Math.min(15, c));
}

/** Channel half-width. Flares toward the mouth, like the real thing. */
export function riverHalfAt(x) {
  const t = clamp01((x + 200) / 480);
  return WORLD.RIVER_HALF_W * (0.86 + 0.55 * t * t);
}

/**
 * True inside the water surface of the river.
 * NOTE the second clause: water.js renders a straight plane of half-width
 * WORLD.RIVER_HALF_W, so that band must always report water (and must always be
 * cleared of blocks) even where the bend has wandered off it.
 */
function inRiverWater(x, z) {
  const c = riverCenterAt(x), h = riverHalfAt(x);
  if (z > c - h && z < c + h) return true;
  return z > WORLD.RIVER_Z - WORLD.RIVER_HALF_W && z < WORLD.RIVER_Z + WORLD.RIVER_HALF_W;
}

/** Riverbank setback: how far back from the water the first parcel may start. */
const BANK = 9;

/* --------------------------------------------------------------- layout --- */

export function buildLayout(seed = 20260803) {
  const rng = makeRNG(seed);
  const S = WORLD.SIZE;
  const BAY = WORLD.BAY_EDGE;
  const riverTop = WORLD.RIVER_Z - WORLD.RIVER_HALF_W;
  const riverBot = WORLD.RIVER_Z + WORLD.RIVER_HALF_W;

  /* ------------------------------------------------------------ roads --- */
  const roadsX = X_PLAN.map((p) => mkRoad(p, 'x'));
  const roadsZ = Z_PLAN.map((p) => mkRoad(p, 'z'));

  const brickellAve = byName(roadsX, 'Brickell Ave');
  const biscayne = byName(roadsX, 'Biscayne Blvd');
  const miamiAve = byName(roadsX, 'S Miami Ave');
  const bayshoreX = BAY - 24;               // notional bayfront esplanade line
  const flagler = byName(roadsZ, 'Flagler St');
  const brickellCity = byName(roadsZ, 'SW 8 St');

  const medians = [...roadsX, ...roadsZ].filter((r) => r.median);

  /* --------------------------------------------- water beyond the grid --- */
  // Marina basins notch INTO the promenade so boats sit in sheltered inlets.
  // Placed away from the `waterfront` and `park` camera presets so the current
  // (rect-only) water.js does not leave a bald patch in a hero shot.
  // Snapped to road-free bands: a basin that swallowed half a carriageway
  // would make isWater() report open water on a live street.
  const basins = [
    { name: 'Miamarina', x0: 282, x1: BAY, z0: -344, z1: -292, kind: 'basin' },
    { name: 'Brickell Marina', x0: 290, x1: BAY, z0: 274, z1: 296, kind: 'basin' },
  ];
  // Brickell Key: a real island off the river mouth. The west cut runs north to
  // meet the river, the south cut is crossed by the causeway.
  const KEY = { x0: 296, x1: BAY, z0: 38, z1: 153 };
  // The west cut is emitted one road-free segment at a time; the two streets
  // that cross it become land causeways, which is exactly how you reach the
  // real Brickell Key. The south cut sits in the SE 8 St / SE 10 St gap.
  const channels = [];
  for (const zs of spans(roadsZ, KEY.z0 - 8, 177)) {
    if (zs.hi - zs.lo < 10) continue;
    channels.push({
      name: 'Key Cut West', x0: 281, x1: KEY.x0, z0: zs.lo, z1: zs.hi, kind: 'channel',
    });
  }
  channels.push({ name: 'Key Cut South', x0: 281, x1: BAY, z0: 153, z1: 177, kind: 'channel' });
  const waterPolys = [...basins, ...channels];

  /* ---------------------------------------------------------- bridges --- */
  // Three river crossings on the roads that would actually carry them, plus
  // the Brickell Key causeway. Each is an AABB; isWater() reports dry inside.
  const bridges = [miamiAve, brickellAve, biscayne].map((r) => ({
    x: r.pos,
    z: riverCenterAt(r.pos),
    width: r.half * 2 + 4,
    length: riverHalfAt(r.pos) * 2 + 44,
    name: `${r.name} Bridge`,
    kind: 'bridge',
  }));
  bridges.push({
    x: (KEY.x0 + BAY) / 2, z: 165, width: 22, length: 42,
    name: 'Brickell Key Causeway', kind: 'causeway',
  });

  const inBridge = (x, z) => {
    for (const b of bridges) {
      if (Math.abs(x - b.x) < b.width / 2 && Math.abs(z - b.z) < b.length / 2) return true;
    }
    return false;
  };
  const inPoly = (x, z) => {
    for (const p of waterPolys) {
      if (x > p.x0 && x < p.x1 && z > p.z0 && z < p.z1) return true;
    }
    return false;
  };

  /* --------------------------------------------------- diagonal cut ----- */
  // Downtown's rail/transit corridor slices the grid on the bias, producing the
  // wedge-shaped parcels that make a real downtown legible from the air.
  const diagonals = [
    mkDiagonal(-268, -520, 150, -152, 12, 'Metrorail Cut', ROAD_CLASS.AVENUE),
  ];

  /* ------------------------------------------------- hero public space --- */
  // Miami's downtown waterfront is a quarter-kilometre of park, not a row of
  // parcels — Bayfront/Museum Park is what lets you see the bay from inland at
  // all. Declared up front so zoning cannot build over it.
  const openSpaces = [
    { name: 'Bayfront Park', x0: 200, x1: BAY, z0: -302, z1: -74, green: 0.74 },
    // The south lobe wraps the river mouth. Keeping it open is what lets you
    // see the bay from inland at all — a solid parcel wall here would put a
    // glass facade in front of every waterfront camera angle.
    { name: 'Miami Riverwalk', x0: 142, x1: BAY, z0: -118, z1: -26, green: 0.6 },
    { name: 'Museum Park', x0: 232, x1: BAY, z0: -S, z1: -452, green: 0.72 },
    // South-bank riverwalk. Paired with 'Miami Riverwalk' on the north bank it
    // gives the channel a continuous green corridor end to end.
    { name: 'Brickell Point', x0: 40, x1: BAY, z0: 30, z1: 92, green: 0.62 },
    { name: 'Jose Marti Park', x0: -330, x1: -244, z0: 96, z1: 190, green: 0.8 },
  ];

  /* ------------------------------------------------------------ cells --- */
  const xSpans = spans(roadsX, -S, BAY);
  const zSpans = spans(roadsZ, -S, S);

  /** @type {{x0:number,x1:number,z0:number,z1:number,cx:number,cz:number}[]} */
  const cells = [];
  for (const xs of xSpans) {
    for (const zs of zSpans) {
      cells.push({
        x0: xs.lo, x1: xs.hi, z0: zs.lo, z1: zs.hi,
        // The road-free envelope this parcel came from. Water/diagonal clipping
        // pushes edges around and can shove one into a carriageway, which puts
        // a sidewalk slab on top of asphalt; every parcel is re-clamped to this.
        ox0: xs.lo, ox1: xs.hi, oz0: zs.lo, oz1: zs.hi,
        wRoad: xs.before, eRoad: xs.after, nRoad: zs.before, sRoad: zs.after,
      });
    }
  }

  /* ------------------------------------------------------- subdivision --- */
  /** @type {{x:number,z:number,w:number,d:number}[]} */
  const alleys = [];
  const parcels = [];
  for (const c of cells) {
    const district = (c.z0 + c.z1) / 2 > WORLD.RIVER_Z ? DISTRICT.BRICKELL : DISTRICT.DOWNTOWN;
    // Brickell parcels are already small; downtown superblocks want cutting up,
    // both for grain and so props/buildings density stays on target.
    const maxDepth = district === DISTRICT.BRICKELL ? 1 : 2;
    subdivide(c, rng, 0, maxDepth, parcels, alleys);
  }

  /* ------------------------------------- clip against water + diagonal --- */
  // The Key gets its own micro-grid below, so it is a keep-out for the ordinary
  // grid — listed FIRST so a bayfront parcel retreats off the island before it
  // is asked to retreat off the narrow cut beside it.
  const keepOut = [KEY, ...waterPolys];
  const kept = [];
  for (let p of parcels) {
    p = clipRiver(p);
    if (!p) continue;
    p = clipRects(p, keepOut);
    if (!p) continue;
    if (p.x1 > BAY) p.x1 = BAY;
    if (p.ox0 !== undefined) {
      p.x0 = Math.max(p.x0, p.ox0); p.x1 = Math.min(p.x1, p.ox1);
      p.z0 = Math.max(p.z0, p.oz0); p.z1 = Math.min(p.z1, p.oz1);
    }
    if (p.x1 - p.x0 < 16 || p.z1 - p.z0 < 16) continue;

    // The diagonal replaces one parcel with up to two wedge-clipped parcels.
    let split = null;
    for (const dg of diagonals) {
      const s = clipDiagonal(p, dg);
      if (s) { split = s; break; }
    }
    if (split) { for (const q of split) kept.push(q); }
    else kept.push(p);
  }

  /* ---------------------------------------------- Brickell Key micro-grid */
  // Its own rhythm: four short, deep lots on a private lane, which reads as a
  // distinct district even at menu-hero distance.
  // Rows follow the road-free spans, because streets.js runs every roadsZ the
  // full width of the map — the Key cannot pretend those crossings are absent.
  const keyX0 = KEY.x0 + 4, keyX1 = BAY - 4;
  for (const zs of spans(roadsZ, KEY.z0, KEY.z1)) {
    const d = zs.hi - zs.lo;
    if (d < 18) continue;
    if (d > 42) {
      // Deep enough for a private lane between two short, wide lots.
      const cut = (zs.lo + zs.hi) / 2;
      kept.push({ x0: keyX0, x1: keyX1, z0: zs.lo, z1: cut - 3, key: true, nRoad: zs.before });
      kept.push({ x0: keyX0, x1: keyX1, z0: cut + 3, z1: zs.hi, key: true, sRoad: zs.after });
      alleys.push({ x: (keyX0 + keyX1) / 2, z: cut, w: keyX1 - keyX0, d: 6 });
    } else {
      kept.push({
        x0: keyX0, x1: keyX1, z0: zs.lo, z1: zs.hi, key: true,
        nRoad: zs.before, sRoad: zs.after,
      });
    }
  }

  /* ----------------------------------------------------------- blocks --- */
  /** @type {Block[]} */
  const blocks = [];
  for (const p of kept) {
    const w = p.x1 - p.x0, d = p.z1 - p.z0;
    if (w < 16 || d < 16) continue;
    const cx = (p.x0 + p.x1) / 2, cz = (p.z0 + p.z1) / 2;
    if (inRiverWater(cx, cz) || cx > BAY) continue;

    const district = p.key
      ? DISTRICT.WATERFRONT
      : (cz > WORLD.RIVER_Z ? DISTRICT.BRICKELL : DISTRICT.DOWNTOWN);

    // Frontage: which sides of this parcel actually touch a public street?
    const fr = [];
    if (p.nRoad) fr.push({ side: 'n', road: p.nRoad });
    if (p.sRoad) fr.push({ side: 's', road: p.sRoad });
    if (p.wRoad) fr.push({ side: 'w', road: p.wRoad });
    if (p.eRoad) fr.push({ side: 'e', road: p.eRoad });
    fr.sort((a, b) => rank(b.road) - rank(a.road));

    blocks.push({
      x: cx, z: cz, w, d,
      district,
      zone: ZONE.MIDRISE,             // assigned below
      seed: rng.int(1, 1e9),
      area: w * d,
      edges: {
        n: !!p.nRoad, s: !!p.sRoad, w: !!p.wRoad, e: !!p.eRoad,
      },
      frontage: fr.length ? fr[0].side : 'n',
      frontageStreets: fr,
      sidewalk: WORLD.SIDEWALK_W,     // widened on spines below
      /* --- metadata added for the content modules --- */
      heightClass: HEIGHT_CLASS.MID,
      floors: 6,
      hasPodium: false,
      podiumH: 0,
      setback: 2.0,
      streetLife: 0.35,
      style: STYLE.STUCCO,
      corner: fr.length >= 2,
      onSpine: fr.some((f) => f.road.spine),
      onBoulevard: fr.some((f) => f.road.cls === BOULEVARD),
      riverwalk: false,
      bayfront: false,
      landmark: null,
      subtype: null,
      parcels: null,
    });
  }

  /* ------------------------------------------------------------ zoning --- */
  const bayD = (b) => BAY - b.x;
  const rivD = (b) => Math.abs(b.z - riverCenterAt(b.x));

  // Construction clusters — real cities build in patches, not confetti. One
  // sits under the `construction` camera preset by design.
  const siteClusters = [
    { x: -110, z: 275, r: 120 },
    { x: 70, z: -330, r: 100 },
    { x: 190, z: 40, r: 80 },
  ];

  for (const b of blocks) {
    const r = makeRNG(b.seed);
    const dBay = bayD(b);
    const dRiv = rivD(b);
    const dAve = Math.abs(b.x - brickellAve.pos);
    const dBis = Math.abs(b.x - biscayne.pos);
    const brick = b.district === DISTRICT.BRICKELL;
    const key = b.district === DISTRICT.WATERFRONT;

    // Distance to the map edge, used to taper the skyline so it does not run
    // flat-topped off the horizon.
    const edgeD = Math.min(b.x + S, S - Math.abs(b.z), 400);
    // How "downtown" this block is. Miami's density collapses hard once you go
    // west of the CBD (Overtown, Little Havana are two storeys), and that
    // gradient is most of what makes the skyline read as a skyline.
    const core = smoothstep(-430, -130, b.x);

    /* -- height potential field ----------------------------------------- */
    // A smooth field, not a per-block dice roll — this is what makes the
    // skyline read as a *massing*: a ridge along Brickell Ave, a second along
    // Biscayne, both falling away west into low-rise and tapering at the map
    // edge so nothing runs flat-topped off the horizon.
    let H = 0.05
      + 0.40 * bell(dAve, 110)                 // the Brickell Ave spine
      + 0.23 * bell(dBis, 95)                  // Biscayne Blvd
      + 0.30 * bell(dBay, 170)                 // bayfront premium
      + 0.14 * bell(dRiv, 200)
      + (brick ? 0.28 : 0.05)
      + (key ? 0.34 : 0)
      + (brick && b.onBoulevard ? 0.09 : 0)
      // Low-frequency noise, NOT a per-block dice roll. Independent random
      // heights give salt-and-pepper; a 170 m noise cell gives clusters of
      // tall and pockets of low, which is what a real skyline silhouette is.
      + 0.40 * (vnoise(b.x, b.z, 170, seed) - 0.44)
      + 0.10 * (r() - 0.5);
    H *= 0.66 + 0.34 * smoothstep(20, 190, edgeD);
    H *= 0.26 + 0.74 * core;
    H = clamp01(H);
    b.heightPotential = +H.toFixed(3);

    /* -- street life field ----------------------------------------------- */
    let L = 0.18
      + (b.onSpine ? 0.42 : 0)
      + (b.onBoulevard ? 0.16 : 0)
      + (b.corner ? 0.10 : 0)
      + 0.24 * bell(dBay, 120)
      + 0.18 * bell(dRiv, 80)
      + (brick ? 0.10 : 0)
      + 0.16 * (r() - 0.5);

    /* -- zone --------------------------------------------------------- */
    // Even in the tallest band ~25% of parcels are deliberately NOT towers.
    // An unbroken wall of same-height slabs is an automatic review failure;
    // the low punctuation is what makes the massing read as a skyline.
    let zone;
    if (H > 0.56) zone = r.weighted([[ZONE.TOWER, 78], [ZONE.MIDRISE, 14], [ZONE.CONSTRUCTION, 4], [ZONE.PLAZA, 2], [ZONE.RETAIL, 2]]);
    else if (H > 0.40) zone = r.weighted([[ZONE.TOWER, 44], [ZONE.MIDRISE, 42], [ZONE.CONSTRUCTION, 6], [ZONE.RETAIL, 8]]);
    else if (H > 0.28) zone = r.weighted([[ZONE.MIDRISE, 56], [ZONE.TOWER, 14], [ZONE.RETAIL, 18], [ZONE.PARKING, 12]]);
    else if (H > 0.18) zone = r.weighted([[ZONE.MIDRISE, 28], [ZONE.RETAIL, 22], [ZONE.LOWRISE, 24], [ZONE.PARKING, 18], [ZONE.PLAZA, 8]]);
    else if (core < 0.45) {
      // Overtown / Little Havana: two-storey commercial strip, corner stores,
      // yards and pocket parks. Multi-storey garages are a CBD thing.
      zone = r.weighted([[ZONE.LOWRISE, 40], [ZONE.RETAIL, 22], [ZONE.PARK, 16],
        [ZONE.PARKING, 10], [ZONE.PLAZA, 6], [ZONE.MIDRISE, 6]]);
    } else {
      zone = r.weighted([[ZONE.LOWRISE, 30], [ZONE.RETAIL, 14], [ZONE.PARKING, 30],
        [ZONE.PLAZA, 12], [ZONE.PARK, 14]]);
    }

    // Flagler is the one street that is low and shoppy end to end, whatever the
    // tower field wants. Every other spine keeps its height and gets a podium.
    // Only parcels whose primary door is on the spine — a back lot two parcels
    // deep is not a shopfront, and converting those flattened the whole CBD.
    const onRetailSpine = b.frontageStreets.length
      && b.frontageStreets[0].road.retail;
    if (onRetailSpine && r.chance(0.7)) zone = r.chance(0.74) ? ZONE.RETAIL : ZONE.LOWRISE;

    // Downtown keeps genuinely more surface parking and open civic space.
    if (!brick && !key && core > 0.5 && H < 0.42 && r.chance(0.20)) zone = ZONE.PARKING;

    /* -- waterfront ------------------------------------------------------ */
    // Distances measured from the parcel EDGE, not its centre: a 60 m deep
    // block whose front door is on the seawall is a waterfront block.
    const edgeBay = BAY - (b.x + b.w / 2);
    if (!key) {
      if (edgeBay < 14) {
        // The outermost band is promenade, unbroken from end to end.
        zone = r.chance(0.82) ? ZONE.PARK : ZONE.PLAZA;
        b.bayfront = true;
        b.subtype = 'promenade';
      } else if (edgeBay < 58) {
        if (brick) {
          // Brickell builds right up to the water (Icon, Una, Aston Martin).
          zone = r.weighted([[ZONE.TOWER, 52], [ZONE.PARK, 20], [ZONE.PLAZA, 14], [ZONE.MARINA, 14]]);
        } else {
          zone = r.weighted([[ZONE.PARK, 52], [ZONE.PLAZA, 18], [ZONE.MARINA, 18], [ZONE.TOWER, 12]]);
        }
        b.bayfront = true;
      }
      // Anything facing a marina basin becomes dock apron.
      for (const bs of basins) {
        if (b.x + b.w / 2 > bs.x0 - 30 && b.z + b.d / 2 > bs.z0 - 26 && b.z - b.d / 2 < bs.z1 + 26) {
          zone = r.chance(0.58) ? ZONE.MARINA : ZONE.PLAZA;
          b.subtype = 'dock';
          b.bayfront = true;
        }
      }
    }

    /* -- riverwalk -------------------------------------------------------- */
    // Same edge logic. The first 34 m off the water is public realm on both
    // banks, which is both true of Miami and what keeps the channel visible
    // from a 3/4 camera instead of walled in by towers.
    const rc = riverCenterAt(b.x);
    const nearZ = b.z > rc ? b.z - b.d / 2 : b.z + b.d / 2;
    const bankD = Math.max(0, Math.abs(nearZ - rc) - riverHalfAt(b.x));
    if (bankD < 20 && !key) {
      b.riverwalk = true;
      b.subtype = b.subtype || 'riverwalk';
      // A tall parcel still gets to be tall — Icon and Epic sit right on the
      // water — but three quarters of the first bank row is public realm.
      zone = r.weighted([[ZONE.PARK, 32], [ZONE.PLAZA, 16], [ZONE.RETAIL, 20],
        [ZONE.LOWRISE, 8], [ZONE.MARINA, 6], [ZONE.TOWER, H > 0.6 ? 30 : 4]]);
      L += 0.26;
    } else if (bankD < 70 && !key) {
      b.riverwalk = true;
      if (r.chance(0.22)) zone = r.chance(0.5) ? ZONE.PLAZA : ZONE.RETAIL;
      L += 0.14;
    }

    /* -- declared hero public space -------------------------------------- */
    for (const os of openSpaces) {
      if (key) break;          // the Key is all private lots, no public bands
      if (b.x + b.w / 2 < os.x0 || b.x - b.w / 2 > os.x1) continue;
      if (b.z + b.d / 2 < os.z0 || b.z - b.d / 2 > os.z1) continue;
      zone = r.chance(os.green) ? ZONE.PARK : ZONE.PLAZA;
      b.subtype = 'park';
      b.landmark = b.landmark || os.name;
      b._open = true;               // a hero landmark may still claim this lot
      L = Math.max(L, 0.6);
    }

    /* -- construction clusters ------------------------------------------- */
    for (const c of siteClusters) {
      const d = Math.hypot(b.x - c.x, b.z - c.z);
      if (d < c.r && r.chance(0.52 * (1 - d / c.r) + 0.12)) zone = ZONE.CONSTRUCTION;
    }

    // Nothing tall on a scrap of land: a 160 m shaft on a 14 m lot is a needle,
    // and needles read as bugs rather than architecture.
    if (!key && zone === ZONE.TOWER && (b.area < 1000 || Math.min(b.w, b.d) < 22)) {
      zone = b.area < 700 ? ZONE.LOWRISE : ZONE.MIDRISE;
    }
    // Brickell Key is a cluster of slender residential towers, full stop.
    if (key) zone = ZONE.TOWER;

    b.zone = zone;
    b.streetLife = +clamp01(L).toFixed(2);

    /* -- derived metadata ------------------------------------------------- */
    applyHeightMeta(b, H, r);
    if (b.onSpine || b.streetLife > 0.62) b.sidewalk = WORLD.SIDEWALK_W + 1.8;
    else if (!b.onBoulevard && b.streetLife < 0.28) b.sidewalk = WORLD.SIDEWALK_W - 1.4;

    // Default buildable footprint after setback. Landmarks overwrite this with
    // their hand-authored hint below.
    b.footprint = {
      w: Math.max(8, b.w - b.setback * 2),
      d: Math.max(8, b.d - b.setback * 2),
    };

    // Lot subdivision hint for shop rows, so buildings.js can vary widths
    // instead of stamping identical units.
    if (zone === ZONE.RETAIL || zone === ZONE.LOWRISE) b.parcels = lots(b, r);
  }

  /* --------------------------------------------------------- landmarks --- */
  /**
   * Hand-placed hero blocks. `w`/`d` are footprint hints in metres, `heightM`
   * the intended top, `style` tells buildings.js which language to speak.
   */
  const landmarks = [
    { name: 'Kaseya Center', x: 252, z: -410, r: 110, w: 118, d: 88, heightM: 44, style: STYLE.ARENA, zone: ZONE.MIDRISE },
    { name: 'Freedom Tower', x: 268, z: -336, r: 90, w: 40, d: 40, heightM: 78, style: STYLE.DECO, zone: ZONE.LANDMARK },
    { name: 'Bayfront Amphitheatre', x: 305, z: -246, r: 70, w: 70, d: 54, heightM: 22, style: STYLE.CIVIC, zone: ZONE.PLAZA },
    { name: 'Miami-Dade Courthouse', x: -60, z: -238, r: 90, w: 52, d: 52, heightM: 106, style: STYLE.DECO, zone: ZONE.LANDMARK },
    { name: 'Government Center', x: -28, z: -156, r: 90, w: 74, d: 58, heightM: 40, style: STYLE.CIVIC, zone: ZONE.MIDRISE },
    { name: 'Miami Tower', x: 96, z: -168, r: 80, w: 44, d: 44, heightM: 190, style: STYLE.GLASS, zone: ZONE.LANDMARK },
    { name: 'Southeast Financial Center', x: 178, z: -142, r: 80, w: 50, d: 46, heightM: 232, style: STYLE.GLASS, zone: ZONE.LANDMARK },
    { name: 'Riverwalk Market', x: 60, z: -60, r: 70, w: 54, d: 30, heightM: 14, style: STYLE.STUCCO, zone: ZONE.RETAIL },
    { name: 'Brickell City Centre', x: 92, z: 224, r: 96, w: 92, d: 60, heightM: 62, style: STYLE.GLASS, zone: ZONE.LANDMARK },
    { name: 'Four Seasons Brickell', x: 152, z: 300, r: 80, w: 40, d: 40, heightM: 240, style: STYLE.TOWER, zone: ZONE.LANDMARK },
    { name: 'Panorama Tower', x: 96, z: 396, r: 90, w: 44, d: 44, heightM: 262, style: STYLE.TOWER, zone: ZONE.LANDMARK },
    { name: 'Icon Brickell', x: 300, z: 232, r: 80, w: 46, d: 34, heightM: 176, style: STYLE.GLASS, zone: ZONE.LANDMARK },
    { name: 'Brickell Key Tower', x: 313, z: 96, r: 60, w: 26, d: 26, heightM: 158, style: STYLE.TOWER, zone: ZONE.LANDMARK },
    // Kept west of the bay/park sightline on purpose: a hero tower parked at
    // the river mouth fills the entire `waterfront` camera with glass.
    { name: 'Met Square', x: 22, z: -150, r: 80, w: 40, d: 40, heightM: 152, style: STYLE.GLASS, zone: ZONE.LANDMARK },
  ];
  for (const lm of landmarks) {
    const best = nearestBlock(blocks, lm.x, lm.z, lm.r);
    if (!best) continue;
    best.zone = lm.zone || ZONE.LANDMARK;
    best.landmark = lm.name;
    best.style = lm.style;
    best.footprint = { w: Math.min(lm.w, best.w - 4), d: Math.min(lm.d, best.d - 4) };
    best.heightM = lm.heightM;
    best.heightClass = lm.heightM > 150 ? HEIGHT_CLASS.SUPER
      : lm.heightM > 60 ? HEIGHT_CLASS.HIGH
        : lm.heightM > 20 ? HEIGHT_CLASS.MID : HEIGHT_CLASS.LOW;
    best.floors = Math.max(1, Math.round(lm.heightM / 3.4));
    best.streetLife = Math.max(best.streetLife, 0.7);
    lm.blockX = best.x; lm.blockZ = best.z;
  }

  /* ------------------------------------------------------------- parks --- */
  // Green lungs the openSpaces bands do not already guarantee.
  forceZone(blocks, -150, -128, ZONE.PLAZA, 'Civic Plaza');
  forceZone(blocks, 30, 330, ZONE.PARK, 'Simpson Park');
  forceZone(blocks, -330, 420, ZONE.PARK, 'Shenandoah Park');

  /**
   * True on any driveable surface: carriageway, service alley, diagonal cut.
   *
   * Hoisted out of the returned object because the zoo reservation below has
   * to ask the question BEFORE the layout object exists. The returned
   * `isRoad()` delegates here so there is exactly one definition — a second
   * copy that forgot about `alleys` is precisely how you get a habitat pen
   * laid across a service lane and every fence post in it silently rejected.
   */
  const isRoadAt = (x, z) => {
    for (const r of roadsX) if (Math.abs(x - r.pos) < r.half) return true;
    for (const r of roadsZ) if (Math.abs(z - r.pos) < r.half) return true;
    for (const a of alleys) {
      if (Math.abs(x - a.x) < a.w / 2 && Math.abs(z - a.z) < a.d / 2) return true;
    }
    for (const d of diagonals) if (onDiagonal(d, x, z)) return true;
    return false;
  };
  /* Stricter than the exported isWater(): no bridge exemption. A bridge deck
     is dry, but it is not ground you may fence a rhino onto. */
  const isWetAt = (x, z) => x > BAY || inRiverWater(x, z) || inPoly(x, z);

  /* --- reserve the ZOO DISTRICT -------------------------------------------
     Same rule as the basketball courts below, one order of magnitude bigger,
     and for the same reason: a habitat pen IS a clearing, and a clearing
     chosen after nature.js has run is a pen full of trees whose fence, gate
     and feed trough all come back rejected as `occupied`. The court survived
     that mistake missing a few floodlights. A zoo would not survive it at all.

     THE SITE CANNOT BE ONE BLOCK, and no amount of wishing changes that. The
     largest road-free rectangle anywhere on this map is 74 x 59 m — that is
     the widest span pair X_PLAN and Z_PLAN produce — and a zoo wants roughly
     200 x 150. So the site is a 2 x 2 group of road-free cells and the two
     avenues crossing it stay public carriageway. Every pen, path and plaza
     below is placed strictly INSIDE a cell; nothing is ever laid across a
     road, an alley or the Metrorail diagonal.

     The leftover ground the pens cannot use is deliberately left OUT of the
     contract. That is where nature.js is allowed to plant, and it is what
     makes this read as a park with animals in it rather than a car park with
     fences round it. */
  const zoo = reserveZoo({
    blocks, xSpans, zSpans, alleys, isRoadAt, isWetAt, S, BAY,
  });

  /* --- reserve basketball-court sites -------------------------------------
     Decided HERE, before nature or props run, because a court has to be a
     clearing. Deciding it inside props.js meant deciding it AFTER the park was
     planted: the first build produced four courts with one hoop each and half
     a fence, every missing piece rejected for standing where a tree already
     was. nature.js keeps these rectangles clear at the plant() funnel. */
  for (const b of blocks) {
    if (b.zone !== ZONE.PARK) continue;
    if (b.subtype === 'promenade' || b.subtype === 'dock') continue;
    /* The zoo re-zones its own blocks to PARK so buildings.js leaves them
       alone, which makes every one of them a court candidate. A half-court
       stamped through the middle of the gator swamp is not the joke it
       sounds like: the court claims the same ground the pen needs and one of
       the two loses its pieces at random. */
    if (b.zoo) continue;
    const CW = 26, CD = 15, PAD = 2.4;
    const along = b.w >= b.d;
    const spanA = along ? b.w : b.d, spanB = along ? b.d : b.w;
    /* +6, not +2. At the bare minimum the fence corner sat 0.1 m outside the
       block, on the sidewalk, and half the floodlights were rejected as
       standing on the road — a court that is exactly as wide as its park has
       no room for the things around its edge. */
    if (spanA < CW + PAD * 2 + 6 || spanB < CD + PAD * 2 + 6) continue;
    if (!makeRNG(b.seed ^ 0xc0021a).chance(0.55)) continue;
    b.court = {
      yaw: along ? 0 : Math.PI / 2,
      cw: CW, cd: CD, pad: PAD,
      hw: CW / 2 + PAD, hd: CD / 2 + PAD,
    };
  }

  /* ------------------------------------------------------------ output --- */
  const riverSamples = [];
  for (let x = -S; x <= BAY; x += 40) {
    riverSamples.push({ x, z: riverCenterAt(x), half: riverHalfAt(x) });
  }

  return {
    seed,
    roadsX, roadsZ, blocks, bridges, landmarks,
    /* --- added, but downstream-safe --- */
    alleys,
    diagonals,
    medians,
    basins,
    channels,
    waterPolys,
    brickellKey: KEY,
    /** The zoo district, or null if no site on this seed qualified. */
    zoo,
    districts: {
      brickell: { z0: riverBot, z1: S },
      downtown: { z0: -S, z1: riverTop },
    },

    river: {
      z: WORLD.RIVER_Z,
      halfW: WORLD.RIVER_HALF_W,
      top: riverTop,
      bot: riverBot,
      /** Bent centreline — water.js can ribbon along this instead of a rect. */
      centerAt: riverCenterAt,
      halfAt: riverHalfAt,
      samples: riverSamples,
    },
    bayEdge: BAY,
    size: S,
    named: { brickellAve, biscayne, flagler, brickellCity, miamiAve, bayshoreX },

    /** True if (x,z) is on a driveable surface (roads, alleys, diagonals). */
    isRoad: isRoadAt,

    /** True over open water: the bay, the river channel, basins and cuts. */
    isWater(x, z) {
      if (inBridge(x, z)) return false;
      if (x > BAY) return true;
      if (inRiverWater(x, z)) return true;
      if (inPoly(x, z)) return true;
      return false;
    },
  };
}

/* ------------------------------------------------------------- helpers --- */

function mkRoad(p, axis) {
  return {
    pos: p.pos,
    half: p.half ?? HALF[p.cls],
    cls: p.cls,
    name: p.name,
    axis,
    median: !!p.median,
    medianW: p.median ? (p.medianW ?? 7) : 0,
    transit: !!p.transit,
    spine: !!p.spine,
    retail: !!p.retail,
  };
}

function byName(list, name) {
  return list.find((r) => r.name === name) || list[0];
}

function rank(r) {
  return r.cls === BOULEVARD ? 3 : r.cls === AVENUE ? 2 : 1;
}

/**
 * Convert road centrelines into the free land spans between them, clamped to
 * [min,max]. `roads` must be sorted ascending. The clamp matters: this is also
 * called on a sub-range (Brickell Key) where most roads fall outside it.
 */
function spans(roads, min, max) {
  const out = [];
  let cur = min;
  let before = null;
  for (const r of roads) {
    const lo = r.pos - r.half, hi = r.pos + r.half;
    if (hi <= min) { before = r; continue; }
    if (lo >= max) break;
    const segHi = Math.min(lo, max);
    if (segHi - cur >= 16) out.push({ lo: cur, hi: segHi, before, after: r });
    cur = Math.max(cur, hi);
    before = r;
  }
  if (max - cur >= 16) out.push({ lo: cur, hi: max, before, after: null });
  return out;
}

/**
 * Recursively split a cell into parcels separated by a service alley.
 * Big cells almost always split; small Brickell cells almost never do. The
 * alley is a *gap*, not a road entry — see the file header for why.
 */
function subdivide(cell, rng, depth, maxDepth, out, alleys) {
  const w = cell.x1 - cell.x0, d = cell.z1 - cell.z0;
  const area = w * d;

  let p = 0;
  if (depth < maxDepth) {
    if (area > 4000) p = 0.95;
    else if (area > 2800) p = 0.72;
    else if (area > 2000) p = 0.42;
    else if (area > 1450) p = 0.20;
  }
  if (rng() > p) { out.push(cell); return; }

  // Roughly half the splits are party-wall lot lines (a 0.8 m seam), the rest
  // real service alleys. Every alley is bare ground plane until streets.js
  // paves `layout.alleys`, so an all-alley subdivision punches the city full
  // of dark slots — the party-wall variant gives the same grain for free.
  const gap = rng.chance(0.46) ? 0.8 : 6 + rng() * 2.5;
  // Split the long way unless the cell is nearly square, then coin-flip: this
  // is what produces the occasional L-shaped pair of parcels at depth 2.
  const alongX = w > d * 1.12 ? true : (d > w * 1.12 ? false : rng.chance(0.5));
  const t = 0.38 + rng() * 0.24;

  if (alongX) {
    const cut = cell.x0 + w * t;
    if (cut - gap / 2 - cell.x0 < 17 || cell.x1 - (cut + gap / 2) < 17) { out.push(cell); return; }
    if (gap > 3) alleys.push({ x: cut, z: (cell.z0 + cell.z1) / 2, w: gap, d });
    subdivide({ ...cell, x1: cut - gap / 2, eRoad: null }, rng, depth + 1, maxDepth, out, alleys);
    subdivide({ ...cell, x0: cut + gap / 2, wRoad: null }, rng, depth + 1, maxDepth, out, alleys);
  } else {
    const cut = cell.z0 + d * t;
    if (cut - gap / 2 - cell.z0 < 17 || cell.z1 - (cut + gap / 2) < 17) { out.push(cell); return; }
    if (gap > 3) alleys.push({ x: (cell.x0 + cell.x1) / 2, z: cut, w, d: gap });
    subdivide({ ...cell, z1: cut - gap / 2, sRoad: null }, rng, depth + 1, maxDepth, out, alleys);
    subdivide({ ...cell, z0: cut + gap / 2, nRoad: null }, rng, depth + 1, maxDepth, out, alleys);
  }
}

/**
 * Pull a parcel back off the (bent) river. The clip is sampled across the
 * parcel's x-span, so consecutive parcels step along the bend and the bank
 * reads as a curve rather than a line.
 */
function clipRiver(p) {
  let topB = -1e9, botB = 1e9;
  for (let i = 0; i <= 6; i++) {
    const x = p.x0 + (p.x1 - p.x0) * (i / 6);
    const c = riverCenterAt(x), h = riverHalfAt(x) + BANK;
    topB = Math.max(topB, Math.min(c - h, WORLD.RIVER_Z - WORLD.RIVER_HALF_W - BANK));
    botB = Math.min(botB, Math.max(c + h, WORLD.RIVER_Z + WORLD.RIVER_HALF_W + BANK));
  }
  if (p.z1 <= topB || p.z0 >= botB) return p;
  const north = (p.z0 + p.z1) / 2 < WORLD.RIVER_Z;
  if (north) { p.z1 = topB; p.sRoad = null; } else { p.z0 = botB; p.nRoad = null; }
  return (p.z1 - p.z0 >= 16) ? p : null;
}

/** Subtract axis-aligned water rects by pushing the parcel edge back. */
function clipRects(p, rects) {
  for (const r of rects) {
    if (p.x1 <= r.x0 || p.x0 >= r.x1 || p.z1 <= r.z0 || p.z0 >= r.z1) continue;
    // Retreat along whichever axis costs the least land.
    const cutE = p.x1 - r.x0, cutW = r.x1 - p.x0;
    const cutS = p.z1 - r.z0, cutN = r.z1 - p.z0;
    const best = Math.min(cutE, cutW, cutS, cutN);
    if (best === cutE) { p.x1 = r.x0 - 3; p.eRoad = null; }
    else if (best === cutW) { p.x0 = r.x1 + 3; p.wRoad = null; }
    else if (best === cutS) { p.z1 = r.z0 - 3; p.sRoad = null; }
    else { p.z0 = r.z1 + 3; p.nRoad = null; }
    if (p.x1 - p.x0 < 16 || p.z1 - p.z0 < 16) return null;
  }
  return p;
}

function mkDiagonal(ax, az, bx, bz, half, name, cls) {
  const dx = bx - ax, dz = bz - az;
  const len = Math.hypot(dx, dz);
  return {
    ax, az, bx, bz, half, name, cls, len,
    // unit normal; f(x,z) = n . (x,z) - c is the signed distance to the line
    nx: -dz / len, nz: dx / len,
    ux: dx / len, uz: dz / len,
    c: (-dz / len) * ax + (dx / len) * az,
  };
}

function onDiagonal(d, x, z) {
  const t = (x - d.ax) * d.ux + (z - d.az) * d.uz;
  if (t < 0 || t > d.len) return false;
  return Math.abs(d.nx * x + d.nz * z - d.c) < d.half;
}

/**
 * Cut a parcel with the diagonal corridor, returning up to two wedge parcels
 * (the largest axis-aligned rectangle either side). Returns null when the
 * parcel is clear of the corridor, so callers can keep the original.
 */
function clipDiagonal(p, d) {
  const t = ((p.x0 + p.x1) / 2 - d.ax) * d.ux + ((p.z0 + p.z1) / 2 - d.az) * d.uz;
  if (t < -70 || t > d.len + 70) return null;

  let lo = Infinity, hi = -Infinity;
  for (const [x, z] of [[p.x0, p.z0], [p.x1, p.z0], [p.x0, p.z1], [p.x1, p.z1]]) {
    const f = d.nx * x + d.nz * z - d.c;
    lo = Math.min(lo, f); hi = Math.max(hi, f);
  }
  if (lo > d.half || hi < -d.half) return null;   // clear of the corridor

  const out = [];
  stairFill(p, d.nx, d.nz, d.c + d.half, 2, out);
  stairFill(p, -d.nx, -d.nz, -(d.c - d.half), 2, out);
  return out;
}

/**
 * Cover the half-plane side of a parcel with up to 3 rectangles instead of one.
 * A single max-area rect throws away ~quarter of the parcel as dark ground; a
 * two-step staircase keeps the land, and the step itself is what makes a
 * diagonal street read as a diagonal from above.
 */
function stairFill(p, nx, nz, cc, depth, out) {
  const best = clipHalfPlane(p, nx, nz, cc);
  if (!best) return;
  out.push(best);
  if (depth <= 0) return;
  // Two residual strips (an L around `best`); recurse once into each.
  const strips = [];
  if (best.x0 - p.x0 > 18) strips.push({ ...p, x1: best.x0 - 1 });
  if (p.x1 - best.x1 > 18) strips.push({ ...p, x0: best.x1 + 1 });
  for (const s of strips) {
    if (s.x1 - s.x0 < 18 || s.z1 - s.z0 < 18) continue;
    stairFill(s, nx, nz, cc, depth - 1, out);
  }
}

/**
 * Largest axis-aligned sub-rectangle of `p` satisfying nx*x + nz*z >= cc.
 * f is linear, so only the corner that minimises it matters; sweep how much we
 * shave off the x side and solve the z side analytically.
 */
function clipHalfPlane(p, nx, nz, cc, samples = 26) {
  const w = p.x1 - p.x0, d = p.z1 - p.z0;
  let best = null, bestA = 0;
  for (let i = 0; i <= samples; i++) {
    const u = i / samples;
    let x0 = p.x0, x1 = p.x1;
    if (nx >= 0) x0 = p.x0 + u * w; else x1 = p.x1 - u * w;
    const xm = nx >= 0 ? x0 : x1;

    let z0 = p.z0, z1 = p.z1;
    if (Math.abs(nz) < 1e-6) {
      if (nx * xm < cc) continue;
    } else if (nz > 0) {
      z0 = Math.max(z0, (cc - nx * xm) / nz);
    } else {
      z1 = Math.min(z1, (cc - nx * xm) / nz);
    }
    const bw = x1 - x0, bd = z1 - z0;
    if (bw < 17 || bd < 17) continue;
    const area = bw * bd;
    if (area > bestA) {
      bestA = area;
      best = { ...p, x0, x1, z0, z1 };
    }
  }
  return best;
}

/** Split a shop block into uneven lots so storefront rows are not a comb. */
function lots(b, r) {
  const alongX = b.w >= b.d;
  const len = alongX ? b.w : b.d;
  const n = Math.max(2, Math.min(7, Math.round(len / 15)));
  const weights = [];
  let total = 0;
  for (let i = 0; i < n; i++) { const v = 0.7 + r() * 0.9; weights.push(v); total += v; }
  const out = [];
  let cur = -len / 2;
  for (let i = 0; i < n; i++) {
    const size = (len * weights[i]) / total;
    const mid = cur + size / 2;
    out.push({
      x: alongX ? b.x + mid : b.x,
      z: alongX ? b.z : b.z + mid,
      w: alongX ? size : b.w,
      d: alongX ? b.d : size,
      seed: r.int(1, 1e9),
    });
    cur += size;
  }
  return out;
}

/** Fill in heightClass / floors / podium / setback from the potential field. */
function applyHeightMeta(b, H, r) {
  switch (b.zone) {
    case ZONE.PARK:
    case ZONE.PLAZA:
    case ZONE.MARINA:
      b.heightClass = HEIGHT_CLASS.GROUND;
      b.floors = 0;
      b.setback = 0;
      b.style = STYLE.STUCCO;
      return;
    case ZONE.PARKING:
      b.heightClass = HEIGHT_CLASS.LOW;
      b.floors = 3 + Math.round(H * 5);
      b.setback = 1.5;
      b.style = STYLE.CIVIC;
      return;
    case ZONE.CONSTRUCTION:
      b.heightClass = H > 0.55 ? HEIGHT_CLASS.HIGH : HEIGHT_CLASS.MID;
      b.floors = 4 + Math.round(H * 26);
      b.setback = 3.0;
      return;
    case ZONE.RETAIL:
    case ZONE.LOWRISE:
      b.heightClass = HEIGHT_CLASS.LOW;
      b.floors = 2 + r.int(0, 2);
      b.setback = 1.2;
      b.style = r.chance(0.4) ? STYLE.DECO : STYLE.STUCCO;
      return;
    case ZONE.MIDRISE:
      b.heightClass = HEIGHT_CLASS.MID;
      b.floors = 5 + Math.round(H * 14);
      b.setback = 2.4;
      b.style = r.chance(0.3) ? STYLE.DECO : STYLE.STUCCO;
      return;
    default: break;
  }
  // Towers and landmarks.
  const superTall = H > 0.86 || b.district === DISTRICT.WATERFRONT;
  b.heightClass = superTall ? HEIGHT_CLASS.SUPER : HEIGHT_CLASS.HIGH;
  b.floors = Math.round(16 + H * 46 + (superTall ? 10 : 0));
  b.heightM = b.floors * 3.4;
  b.style = r.chance(0.72) ? STYLE.GLASS : STYLE.TOWER;
  // A tower on a busy street sits on a retail podium; a tower on a back lot
  // just meets the pavement.
  b.hasPodium = b.streetLife > 0.42 || b.onBoulevard;
  b.podiumH = b.hasPodium ? 9 + r() * 9 : 0;
  b.setback = b.hasPodium ? 1.0 : 3.5;
}

/** Nearest unclaimed block. Blocks only named by an openSpaces band count as
 *  unclaimed — a hero landmark is allowed to sit inside its own park. */
function nearestBlock(blocks, x, z, maxD) {
  let best = null, bd = 1e9;
  for (const b of blocks) {
    if (b.landmark && !b._open) continue;
    const d = Math.hypot(b.x - x, b.z - z);
    if (d < bd) { bd = d; best = b; }
  }
  return bd <= maxD ? best : null;
}

function forceZone(blocks, x, z, zone, name) {
  let best = null, bd = 1e9;
  for (const b of blocks) {
    if (b.landmark && !b._open) continue;
    const d = Math.hypot(b.x - x, b.z - z);
    if (d < bd) { bd = d; best = b; }
  }
  if (!best) return;
  best.zone = zone;
  best.landmark = name;
  best.heightClass = HEIGHT_CLASS.GROUND;
  best.floors = 0;
  best.setback = 0;
}

/* =========================================================================
 * ZOO DISTRICT
 * =========================================================================
 * Everything below is PURE DATA produced before any content module runs. See
 * the call site in buildLayout() for why it has to happen there and not in
 * props.js, and for why the site spans two carriageways.
 */

/** Interval helpers. `lo`/`hi` are edges, never centres — centres are what
 *  turn a 6 m alley into a 3 m one halfway through a refactor. */
function freeRuns(bars, min, max, minRun) {
  const out = [];
  let cur = min;
  for (const b of bars.slice().sort((p, q) => p.lo - q.lo)) {
    if (b.hi <= cur) continue;
    if (b.lo >= max) break;
    if (b.lo - cur >= minRun) out.push({ lo: cur, hi: Math.min(b.lo, max) });
    cur = Math.max(cur, b.hi);
  }
  if (max - cur >= minRun) out.push({ lo: cur, hi: max });
  return out;
}

/**
 * Edge-rect -> the {x,z,w,d} centre-and-size shape the rest of the game uses.
 *
 * Shrinks by `eps` and snaps to a 1 cm grid, and BOTH halves of that matter.
 * The first cut just rounded to 2 dp, and three rectangles came back sitting
 * 3 mm inside a service alley: isRoad() answered true, so every prop on that
 * edge would have been rejected with no error anywhere. Rounding a placement
 * rectangle may only ever move its edges INWARD.
 *
 * eps 0 is for descriptive metadata only — the site bounding box, which
 * nothing places against and which reads better as a round number.
 */
function zRect(s, eps = 0.01) {
  const x0 = Math.ceil((s.x0 + eps) * 100) / 100;
  const x1 = Math.floor((s.x1 - eps) * 100) / 100;
  const z0 = Math.ceil((s.z0 + eps) * 100) / 100;
  const z1 = Math.floor((s.z1 - eps) * 100) / 100;
  return {
    x: +((x0 + x1) / 2).toFixed(3),
    z: +((z0 + z1) / 2).toFixed(3),
    w: +(x1 - x0).toFixed(2),
    d: +(z1 - z0).toFixed(2),
  };
}

/**
 * Choose the zoo district and lay out its pens, paths, plaza and yard.
 *
 * Returns null when no site on this seed qualifies — CALLERS MUST HANDLE THAT.
 * A zoo half in the bay is worse than no zoo, so every filter here fails
 * closed rather than shuffling the site somewhere it does not belong.
 */
function reserveZoo({ blocks, xSpans, zSpans, alleys, isRoadAt, isWetAt, S, BAY }) {
  /* -- 1. the site: the best 2 x 2 group of road-free cells -------------- */
  const MIN_W = 140, MIN_D = 110, EDGE = 30, BAY_BUFFER = 90;
  let site = null, bestScore = -Infinity;

  for (let i = 0; i + 1 < xSpans.length; i++) {
    for (let j = 0; j + 1 < zSpans.length; j++) {
      const x0 = xSpans[i].lo, x1 = xSpans[i + 1].hi;
      const z0 = zSpans[j].lo, z1 = zSpans[j + 1].hi;
      if (x1 - x0 < MIN_W || z1 - z0 < MIN_D) continue;
      // Inset from the world edge, and a long way back from the bay: the zoo
      // must not eat the waterfront sightline, and half a zoo hanging off the
      // edge of the playable square is a bug report, not a district.
      if (x0 < -S + EDGE || z0 < -S + EDGE || z1 > S - EDGE) continue;
      if (x1 > BAY - BAY_BUFFER) continue;

      /* 4 m sample sweep. It counts the ground that is actually usable, so an
         alley or the Metrorail diagonal slicing the site costs it exactly the
         land it costs. ANY water disqualifies outright: zSpans contains one
         180 m band (SE 4 St to SE 5 St) that is mostly the Miami River, and
         it is by far the largest candidate on the board. */
      let land = 0, wet = false;
      for (let x = x0 + 2; x < x1 && !wet; x += 4) {
        for (let z = z0 + 2; z < z1; z += 4) {
          if (isWetAt(x, z)) { wet = true; break; }
          if (!isRoadAt(x, z)) land++;
        }
      }
      if (wet) continue;

      let heavy = 0, green = 0, blocked = false;
      for (const b of blocks) {
        if (b.x < x0 || b.x > x1 || b.z < z0 || b.z > z1) continue;
        // Never over the seawall, never on the Key, never on top of a hero.
        if (b.subtype === 'promenade' || b.subtype === 'dock'
            || b.district === DISTRICT.WATERFRONT
            || (b.landmark && !b._open)) { blocked = true; break; }
        heavy += b.area * (b.heightPotential || 0);
        if (b.zone === ZONE.PARK || b.zone === ZONE.PLAZA) green += b.area;
      }
      if (blocked) continue;

      /* Usable land first, a strong pull toward ground that is already green,
         and a 3x penalty on height potential. That last term is what keeps
         the zoo out of the CBD: flattening a tower cluster to build it is the
         one change here you would notice from every camera in the game. */
      const score = land * 16 + 1.4 * green - 3.0 * heavy;
      if (score > bestScore) {
        bestScore = score;
        site = {
          x0, x1, z0, z1,
          xs: [xSpans[i], xSpans[i + 1]],
          zs: [zSpans[j], zSpans[j + 1]],
        };
      }
    }
  }
  if (!site) return null;

  const cx = (site.x0 + site.x1) / 2, cz = (site.z0 + site.z1) / 2;

  /* -- 2. the ground the zoo actually owns ------------------------------- */
  /* Cells are cut back to their ALLEY-FREE sub-rectangles. isRoad() reports
     true on a service alley, so a pen laid across one has every fence post,
     gate and trough in that strip rejected on the carriageway test — the
     silent, zero-error-message failure this whole reservation exists to
     prevent. An alley that only crosses part of a cell is still treated as a
     full-length barrier: over-claiming here costs planting land, and planting
     land is the thing we are trying to give away. */
  const MIN_CELL = 26;
  const cells = [];
  for (const xs of site.xs) {
    for (const zs of site.zs) {
      const xBars = [], zBars = [];
      for (const a of alleys) {
        const ax0 = a.x - a.w / 2, ax1 = a.x + a.w / 2;
        const az0 = a.z - a.d / 2, az1 = a.z + a.d / 2;
        if (ax1 <= xs.lo || ax0 >= xs.hi || az1 <= zs.lo || az0 >= zs.hi) continue;
        if (a.w <= a.d) xBars.push({ lo: ax0, hi: ax1 });
        else zBars.push({ lo: az0, hi: az1 });
      }
      for (const xr of freeRuns(xBars, xs.lo, xs.hi, MIN_CELL)) {
        for (const zr of freeRuns(zBars, zs.lo, zs.hi, MIN_CELL)) {
          cells.push({ x0: xr.lo, x1: xr.hi, z0: zr.lo, z1: zr.hi });
        }
      }
    }
  }
  if (cells.length < 2) return null;

  /* -- 3. eight slots: six pens, an entrance plaza, a service yard ------- */
  // PERIM is the walkable margin left inside every cell edge, so no fence ever
  // lands on the kerb — the +6 lesson from the basketball court, generalised.
  const PERIM = 4.5, PATH = 6.5;
  const slots = cells.map((c) => ({
    x0: c.x0 + PERIM, x1: c.x1 - PERIM, z0: c.z0 + PERIM, z1: c.z1 - PERIM,
  }));
  const gaps = [];
  const A = (s) => (s.x1 - s.x0) * (s.z1 - s.z0);
  let minPen = 18;
  while (slots.length < 8) {
    slots.sort((a, b) => A(b) - A(a));
    let k = -1;
    for (let n = 0; n < slots.length; n++) {
      const s = slots[n];
      const long = Math.max(s.x1 - s.x0, s.z1 - s.z0);
      if ((long - PATH) / 2 >= minPen) { k = n; break; }
    }
    // Nothing left worth halving. Relax the minimum once or twice rather than
    // shipping a four-pen zoo, but never below 11 m — a pen you cannot walk an
    // animal into reads as a planter.
    if (k < 0) { if (minPen <= 11) break; minPen -= 3.5; continue; }
    const s = slots[k];
    if (s.x1 - s.x0 >= s.z1 - s.z0) {
      const m = (s.x0 + s.x1) / 2;
      gaps.push({ x0: m - PATH / 2, x1: m + PATH / 2, z0: s.z0, z1: s.z1 });
      slots.splice(k, 1, { ...s, x1: m - PATH / 2 }, { ...s, x0: m + PATH / 2 });
    } else {
      const m = (s.z0 + s.z1) / 2;
      gaps.push({ x0: s.x0, x1: s.x1, z0: m - PATH / 2, z1: m + PATH / 2 });
      slots.splice(k, 1, { ...s, z1: m - PATH / 2 }, { ...s, z0: m + PATH / 2 });
    }
  }
  if (slots.length < 8) return null;

  /* -- 4. roles ----------------------------------------------------------- */
  const dist = (s) => Math.hypot((s.x0 + s.x1) / 2 - cx, (s.z0 + s.z1) / 2 - cz);
  /* The two roads CROSSING the site are the biggest ones touching it — the
     outer four are ordinary streets. So the gate belongs on the crossing at
     the site centre, which is also where the path network converges. */
  slots.sort((a, b) => dist(a) - dist(b));
  const entranceSlot = slots.shift();
  /* Service yard: smallest slot left, furthest out. Deliveries at the back. */
  slots.sort((a, b) => (Math.round(A(a)) - Math.round(A(b))) || (dist(b) - dist(a)));
  const yardSlot = slots.shift();
  /* Pens biggest first so ZOO_SPECIES' size order always holds. Ties are
     broken on z then x and NOT left to sort stability: two 29.25 x 21.25 pens
     really can come out bit-identical, and "whichever the engine happened to
     compare first" is not a thing multiplayer replication can agree on. */
  slots.sort((a, b) => (Math.round(A(b)) - Math.round(A(a)))
    || (a.z0 - b.z0) || (a.x0 - b.x0));

  /* -- 5. the anchor block's seed owns every remaining decision ----------- */
  let anchor = null, ad = Infinity;
  for (const b of blocks) {
    if (b.x < site.x0 || b.x > site.x1 || b.z < site.z0 || b.z > site.z1) continue;
    const d = Math.hypot(b.x - cx, b.z - cz);
    if (d < ad) { ad = d; anchor = b; }
  }
  const zooSeed = anchor ? anchor.seed : 1;
  const rng = makeRNG(zooSeed ^ 0x200a1d);

  /* Jitter is a SHRINK, never a grow — 0..1.5 m off each side independently.
     A grow would push a pen onto the path it is supposed to be separated by,
     and nothing downstream would tell you. */
  const jitter = (s) => ({
    x0: s.x0 + rng.range(0, 1.5), x1: s.x1 - rng.range(0, 1.5),
    z0: s.z0 + rng.range(0, 1.5), z1: s.z1 - rng.range(0, 1.5),
  });

  const habitats = slots.slice(0, 6).map((s, i) => ({
    id: `zoo-${ZOO_SPECIES[i].species}`,
    species: ZOO_SPECIES[i].species,
    label: ZOO_SPECIES[i].label,
    kind: ZOO_SPECIES[i].kind,
    ...zRect(jitter(s)),
  }));

  /* Cap the plaza and the yard, and slide the plaza toward the crossing so the
     gate faces the avenue instead of floating in the middle of its slot. */
  const cap = (s, maxW, maxD, pull) => {
    const w = Math.min(s.x1 - s.x0, maxW), d = Math.min(s.z1 - s.z0, maxD);
    let mx = (s.x0 + s.x1) / 2, mz = (s.z0 + s.z1) / 2;
    if (pull) {
      mx += Math.sign(cx - mx) * Math.min(Math.abs(cx - mx), (s.x1 - s.x0 - w) / 2);
      mz += Math.sign(cz - mz) * Math.min(Math.abs(cz - mz), (s.z1 - s.z0 - d) / 2);
    }
    return zRect({ x0: mx - w / 2, x1: mx + w / 2, z0: mz - d / 2, z1: mz + d / 2 });
  };
  const entrance = { ...cap(entranceSlot, 30, 22, true), yaw: 0 };
  const yard = cap(yardSlot, 22, 16, false);

  /* -- 6. the path network ------------------------------------------------ */
  /* The split gaps, plus the two margins of each cell that FACE the crossing.
     The outward-facing two are left off the list on purpose: they stay
     plantable, so nature.js screens the zoo from the street with trees rather
     than fencing it in a bald ring. */
  // NOT `gaps.map(zRect)`. map hands its callback (value, index, array), so
  // the index lands in zRect's `eps` and rect n shrinks by n metres a side —
  // silently, because a smaller rectangle passes every containment test we
  // have. It took 2 m off one cell and 6 m off another before a road sweep
  // showed the cell areas drifting. Same trap in `cells.map` below.
  const paths = gaps.map((g) => zRect(g));
  for (const c of cells) {
    const mx = (c.x0 + c.x1) / 2, mz = (c.z0 + c.z1) / 2;
    paths.push(zRect(mx < cx
      ? { x0: c.x1 - PERIM, x1: c.x1, z0: c.z0, z1: c.z1 }
      : { x0: c.x0, x1: c.x0 + PERIM, z0: c.z0, z1: c.z1 }));
    paths.push(zRect(mz < cz
      ? { x0: c.x0, x1: c.x1, z0: c.z1 - PERIM, z1: c.z1 }
      : { x0: c.x0, x1: c.x1, z0: c.z0, z1: c.z0 + PERIM }));
  }

  /* -- 6b. LAST GATE: no placement rectangle may sit on carriageway --------
     The cell cutback above subtracts `alleys`, and xSpans/zSpans are road-free
     by construction for the orthogonal grid — but isRoadAt ALSO returns true on
     the Metrorail diagonal, and nothing here subtracts that. The diagonal is
     the one road class that survives into a finished cell.

     Measured: 14 of seeds 1..300 (4.7%) put a pen or a path on live road.
     Both shipped maps are clean (20260803 and 77120451 sample zero road), so
     this never showed in testing — but server.js gives every multiplayer room
     a random seed, so roughly one room in twenty-one would have had a giraffe
     paddock straddling a carriageway, with traffic driving through it and
     every fence post silently rejected for standing on the road.

     Sampled rather than solved: cutting a rotated diagonal out of an
     axis-aligned rect properly is a much larger change, and this module's
     stated contract is that it FAILS CLOSED. A seed with no legal zoo gets no
     zoo, which is the same outcome the site filter already produces on a
     cramped map, and every caller already handles null. */
  const onRoad = (r) => {
    if (!r) return false;
    const hw = (r.w ?? (r.x1 - r.x0)) / 2, hd = (r.d ?? (r.z1 - r.z0)) / 2;
    const cx = r.x ?? (r.x0 + r.x1) / 2, cz = r.z ?? (r.z0 + r.z1) / 2;
    for (let i = -2; i <= 2; i++) {
      for (let j = -2; j <= 2; j++) {
        if (isRoadAt(cx + (i / 2) * hw * 0.98, cz + (j / 2) * hd * 0.98)) return true;
      }
    }
    return false;
  };
  for (const r of [...habitats, ...paths, entrance, yard]) {
    if (onRoad(r)) return null;
  }

  /* -- 7. flag the covered blocks ---------------------------------------- */
  const covered = []; 
  for (const b of blocks) {
    if (b.x < site.x0 || b.x > site.x1 || b.z < site.z0 || b.z > site.z1) continue;
    b.zoo = true;
    /* Re-zone to PARK or buildings.js drops a parking garage in the gator
       swamp. Its dispatch is a switch on b.zone and PARK is the one value
       that falls through to "nature and props own this ground" — but every
       other field a builder reads has to come down with it, or a block that
       renders nothing still claims six storeys of setback and podium. */
    b.zone = ZONE.PARK;
    b.subtype = 'zoo';
    b.landmark = b.landmark || ZOO_NAME;
    b.heightClass = HEIGHT_CLASS.GROUND;
    b.floors = 0;
    b.setback = 0;
    b.hasPodium = false;
    b.podiumH = 0;
    b.parcels = null;
    b.streetLife = Math.max(b.streetLife, 0.55);
    covered.push(b);
  }

  return {
    name: ZOO_NAME,
    /** Site bounding box. Axis-aligned, hence yaw 0 — kept so consumers can
     *  use the same rotated-rect test they already use for b.court. */
    ...zRect(site, 0),
    yaw: 0,
    /** Seed every animal/prop pass should branch from, for replication. */
    seed: zooSeed,
    /** The road-free rectangles the zoo owns. Fence lines live on these. */
    cells: cells.map((c) => zRect(c)),
    habitats,
    paths,
    entrance,
    yard,
    blockCount: covered.length,
  };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const bell = (d, s) => Math.exp(-(d * d) / (2 * s * s));
const lerp = (a, b, t) => a + (b - a) * t;

/** Deterministic hash -> [0,1). */
function hash2(a, b, seed) {
  let n = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(seed, 1013904223)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise on a `cell`-metre lattice. Used for skyline massing. */
function vnoise(x, z, cell, seed) {
  const xf = x / cell, zf = z / cell;
  const xi = Math.floor(xf), zi = Math.floor(zf);
  const u = smoothstep(0, 1, xf - xi), v = smoothstep(0, 1, zf - zi);
  return lerp(
    lerp(hash2(xi, zi, seed), hash2(xi + 1, zi, seed), u),
    lerp(hash2(xi, zi + 1, seed), hash2(xi + 1, zi + 1, seed), u),
    v
  );
}

function smoothstep(a, b, x) {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/**
 * @typedef {{x:number,z:number,w:number,d:number,district:string,zone:string,
 *            seed:number, area:number,
 *            edges:{n:boolean,s:boolean,e:boolean,w:boolean},
 *            frontage:'n'|'s'|'e'|'w', sidewalk:number,
 *            heightClass:string, floors:number, hasPodium:boolean,
 *            podiumH:number, setback:number, streetLife:number, style:string,
 *            corner:boolean, onSpine:boolean, onBoulevard:boolean,
 *            riverwalk:boolean, bayfront:boolean, landmark:?string,
 *            parcels:?Array}} Block
 */
