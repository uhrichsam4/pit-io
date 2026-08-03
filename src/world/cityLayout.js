/**
 * City layout: the street grid and block zoning for Brickell + Downtown Miami.
 *
 * Geography (game space, metres):
 *   +x = east  -> Biscayne Bay lives beyond WORLD.BAY_EDGE
 *   +z = south -> Brickell
 *   -z = north -> Downtown
 *   The Miami River runs east/west through z = 0 and splits the two districts.
 *
 * This module produces PURE DATA. No THREE objects. Every content module
 * (streets, buildings, props, nature, vehicles) reads the same layout so the
 * city stays coherent no matter who generated which piece.
 */

import { WORLD, DISTRICT } from '../config.js';
import { makeRNG } from '../core/rng.js';

/** Block zoning archetypes. */
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

/**
 * @typedef {{x:number,z:number,w:number,d:number,district:string,zone:string,
 *            seed:number, edges:{n:boolean,s:boolean,e:boolean,w:boolean},
 *            frontage:'n'|'s'|'e'|'w', area:number}} Block
 */

export function buildLayout(seed = 20260803) {
  const rng = makeRNG(seed);
  const S = WORLD.SIZE;
  const B = WORLD.BLOCK;
  const riverTop = WORLD.RIVER_Z - WORLD.RIVER_HALF_W;
  const riverBot = WORLD.RIVER_Z + WORLD.RIVER_HALF_W;

  /* ------------------------------------------------------------ roads --- */
  /** @type {{pos:number, half:number, cls:string, name:string}[]} */
  const roadsX = [];
  const roadsZ = [];

  // North/south roads. Brickell Avenue and Biscayne Boulevard are the two
  // signature boulevards; everything else is a numbered street.
  let idx = 0;
  for (let x = -S + B * 0.5; x <= WORLD.BAY_EDGE - 12; x += B) {
    let cls = ROAD_CLASS.STREET;
    let half = WORLD.ROAD_W;
    let name = `${idx + 1} Ave`;
    if (idx % 4 === 2) { cls = ROAD_CLASS.AVENUE; half = WORLD.AVENUE_W; }
    roadsX.push({ pos: Math.round(x), half, cls, name, axis: 'x' });
    idx++;
  }
  // Promote the two closest to signature boulevards.
  const brickellAve = nearest(roadsX, 120);
  brickellAve.cls = ROAD_CLASS.BOULEVARD;
  brickellAve.half = WORLD.AVENUE_W + 5;
  brickellAve.name = 'Brickell Ave';
  const biscayne = nearest(roadsX, 258);
  biscayne.cls = ROAD_CLASS.BOULEVARD;
  biscayne.half = WORLD.AVENUE_W + 6;
  biscayne.name = 'Biscayne Blvd';

  idx = 0;
  for (let z = -S + B * 0.5; z <= S - B * 0.5; z += B) {
    // Skip anything that would land inside the river channel.
    if (z > riverTop - 18 && z < riverBot + 18) { idx++; continue; }
    let cls = ROAD_CLASS.STREET;
    let half = WORLD.ROAD_W;
    if (idx % 4 === 1) { cls = ROAD_CLASS.AVENUE; half = WORLD.AVENUE_W; }
    roadsZ.push({ pos: Math.round(z), half, cls, name: `${idx + 1} St`, axis: 'z' });
    idx++;
  }
  const flagler = nearest(roadsZ, -232);
  if (flagler) {
    flagler.cls = ROAD_CLASS.BOULEVARD;
    flagler.half = WORLD.AVENUE_W + 3;
    flagler.name = 'Flagler St';
  }
  const brickellCity = nearest(roadsZ, 210);
  if (brickellCity) {
    brickellCity.cls = ROAD_CLASS.BOULEVARD;
    brickellCity.half = WORLD.AVENUE_W + 3;
    brickellCity.name = 'SW 8th St';
  }

  /* ----------------------------------------------------------- bridges --- */
  // Two bridges span the river, on Brickell Ave and Biscayne Blvd.
  const bridges = [brickellAve.pos, biscayne.pos].map((x) => ({
    x, z: WORLD.RIVER_Z, width: 26, length: WORLD.RIVER_HALF_W * 2 + 30,
  }));

  /* ------------------------------------------------------------ blocks --- */
  /** @type {Block[]} */
  const blocks = [];
  const sw = WORLD.SIDEWALK_W;

  const xEdges = buildEdges(roadsX, -S, WORLD.BAY_EDGE);
  const zEdges = buildEdges(roadsZ, -S, S);

  for (let i = 0; i < xEdges.length - 1; i++) {
    for (let j = 0; j < zEdges.length - 1; j++) {
      const x0 = xEdges[i].hi, x1 = xEdges[i + 1].lo;
      const z0 = zEdges[j].hi, z1 = zEdges[j + 1].lo;
      const w = x1 - x0, d = z1 - z0;
      if (w < 16 || d < 16) continue;
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;

      // Carve out the river.
      if (cz + d / 2 > riverTop && cz - d / 2 < riverBot) continue;
      // Carve out the bay.
      if (cx + w / 2 > WORLD.BAY_EDGE) continue;

      const district = cz > 0 ? DISTRICT.BRICKELL : DISTRICT.DOWNTOWN;
      blocks.push({
        x: cx, z: cz, w, d,
        district,
        zone: ZONE.MIDRISE, // assigned below
        seed: rng.int(1, 1e9),
        area: w * d,
        edges: {
          w: i > 0, e: i < xEdges.length - 2,
          n: j > 0, s: j < zEdges.length - 2,
        },
        frontage: 'n',
        sidewalk: sw,
      });
    }
  }

  /* ------------------------------------------------------------ zoning --- */
  const bayDist = (b) => WORLD.BAY_EDGE - b.x;
  const riverDist = (b) => Math.abs(b.z - WORLD.RIVER_Z);

  for (const b of blocks) {
    const r = makeRNG(b.seed);
    const nearBay = bayDist(b) < 110;
    const nearRiver = riverDist(b) < 120;
    const onBoulevard =
      Math.abs(b.x - brickellAve.pos) < B || Math.abs(b.x - biscayne.pos) < B;

    if (b.district === DISTRICT.BRICKELL) {
      // Brickell: dense, tall, glassy, polished.
      b.zone = r.weighted([
        [ZONE.TOWER, onBoulevard ? 62 : nearBay ? 48 : 34],
        [ZONE.MIDRISE, 22],
        [ZONE.RETAIL, 12],
        [ZONE.LOWRISE, 8],
        [ZONE.PARKING, 7],
        [ZONE.CONSTRUCTION, 6],
        [ZONE.PLAZA, 6],
        [ZONE.PARK, 4],
      ]);
    } else {
      // Downtown: bigger footprints, more variety, more public space.
      b.zone = r.weighted([
        [ZONE.TOWER, onBoulevard ? 26 : 15],
        [ZONE.MIDRISE, 26],
        [ZONE.RETAIL, 20],
        [ZONE.LOWRISE, 16],
        [ZONE.PARKING, 12],
        [ZONE.CONSTRUCTION, 7],
        [ZONE.PLAZA, 9],
        [ZONE.PARK, 7],
      ]);
    }

    // Bayfront strip is park / marina, never built up.
    if (bayDist(b) < 66) {
      b.zone = b.district === DISTRICT.DOWNTOWN
        ? (r.chance(0.62) ? ZONE.PARK : ZONE.PLAZA)
        : (r.chance(0.42) ? ZONE.PARK : ZONE.TOWER);
      if (r.chance(0.22)) b.zone = ZONE.MARINA;
    }
    // River bank promenade.
    if (nearRiver && riverDist(b) < 52 && r.chance(0.45)) {
      b.zone = r.chance(0.5) ? ZONE.PARK : ZONE.PLAZA;
    }
    b.frontage = r.pick(['n', 's', 'e', 'w']);
  }

  /* --------------------------------------------------------- landmarks --- */
  // A handful of hand-placed hero blocks so the skyline has anchors.
  const landmarks = [
    { name: 'Bayfront Arena', x: 236, z: -376, r: 88 },
    { name: 'Freedom Tower', x: 262, z: -300, r: 60 },
    { name: 'Miami Tower', x: 150, z: -196, r: 60 },
    { name: 'Government Center', x: -10, z: -246, r: 70 },
    { name: 'Brickell City Centre', x: 66, z: 168, r: 80 },
    { name: 'Panorama Tower', x: 130, z: 300, r: 62 },
    { name: 'Icon Brickell', x: 232, z: 92, r: 70 },
  ];
  for (const lm of landmarks) {
    let best = null, bestD = 1e9;
    for (const b of blocks) {
      const d = Math.hypot(b.x - lm.x, b.z - lm.z);
      if (d < bestD) { bestD = d; best = b; }
    }
    if (best && bestD < 120) {
      best.zone = ZONE.LANDMARK;
      best.landmark = lm.name;
    }
  }

  /* ------------------------------------------------------------- parks --- */
  // Guarantee at least one big green lung per district.
  forceZone(blocks, 268, -180, ZONE.PARK, 'Bayfront Park');
  forceZone(blocks, 236, 60, ZONE.PARK, 'Brickell Point');
  forceZone(blocks, -160, -120, ZONE.PLAZA, 'Civic Plaza');

  return {
    seed,
    roadsX, roadsZ, blocks, bridges, landmarks,
    river: { z: WORLD.RIVER_Z, halfW: WORLD.RIVER_HALF_W, top: riverTop, bot: riverBot },
    bayEdge: WORLD.BAY_EDGE,
    size: S,
    named: { brickellAve, biscayne, flagler, brickellCity },
    /** True if (x,z) is on a road surface. */
    isRoad(x, z) {
      for (const r of roadsX) if (Math.abs(x - r.pos) < r.half) return true;
      for (const r of roadsZ) if (Math.abs(z - r.pos) < r.half) return true;
      return false;
    },
    isWater(x, z) {
      if (x > WORLD.BAY_EDGE) return true;
      if (z > riverTop && z < riverBot) {
        for (const br of bridges) if (Math.abs(x - br.x) < br.width / 2) return false;
        return true;
      }
      return false;
    },
  };
}

/* ------------------------------------------------------------- helpers --- */

function nearest(list, target) {
  let best = null, bd = 1e9;
  for (const r of list) {
    const d = Math.abs(r.pos - target);
    if (d < bd) { bd = d; best = r; }
  }
  return best;
}

/** Convert road centrelines into [lo,hi] occupied spans, plus the outer walls. */
function buildEdges(roads, min, max) {
  const edges = [{ lo: min - 40, hi: min }];
  for (const r of roads) edges.push({ lo: r.pos - r.half, hi: r.pos + r.half });
  edges.push({ lo: max, hi: max + 40 });
  edges.sort((a, b) => a.lo - b.lo);
  return edges;
}

function forceZone(blocks, x, z, zone, name) {
  let best = null, bd = 1e9;
  for (const b of blocks) {
    const d = Math.hypot(b.x - x, b.z - z);
    if (d < bd) { bd = d; best = b; }
  }
  if (best) { best.zone = zone; best.landmark = name; }
}
