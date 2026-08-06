#!/usr/bin/env node
/**
 * PLACEMENT AUDIT — measures where every object in the finished world actually
 * is, against where it is supposed to be. MEASUREMENT ONLY: this tool writes
 * nothing but its report.
 *
 *   node tools/place-audit.mjs                          # both maps, :5173
 *   node tools/place-audit.mjs --maps miami             # one map
 *   node tools/place-audit.mjs --url http://localhost:4173/
 *   node tools/place-audit.mjs --json /tmp/place.json   # machine-readable too
 *   node tools/place-audit.mjs --top 40                 # longer worst-of lists
 *
 * WHAT IT ANSWERS
 *   1. VERTICAL ERROR   the sole of the object against the ground under it,
 *                       histogrammed, split into AUTHORING bugs (the geometry's
 *                       own lowest vertex is not at y = 0, so every instance of
 *                       that kind is wrong by the same amount) and PLACEMENT
 *                       bugs (geometry fine, the y it was handed is not).
 *   2. ON THE ROAD      isRoad(x,z) true, minus the things that belong there.
 *   3. IN WATER         isWater(x,z) true, minus the things that float or grow.
 *   4. INTERPENETRATION pairs closer than 0.55 x the sum of contact radii.
 *   5. ROCKS + SCENERY  where the rock-like kinds actually are.
 *
 * =========================================================================
 * FOUR THINGS THIS TOOL GETS RIGHT THAT A NAIVE VERSION GETS WRONG. All four
 * were caught by running it, not by reasoning about it, and each was worth
 * hundreds of false defects.
 * =========================================================================
 *
 * (a) THE METRIC IS THE MESH SOLE, NOT `consumable.position.y`.
 *     They are different numbers. A Consumable's `position` is its PHYSICS
 *     anchor: vehicles.js offsets it deliberately (`seatY`, vehicles.js:2989)
 *     and every hull is authored with y = 0 AT THE WATERLINE
 *     (vehicles.js:3186). What a player sees sunk or floating is the lowest
 *     geometry, so that is what is measured. Both are reported; the sole
 *     decides.
 *
 * (b) THE SOLE IS TILT-AWARE. nature.js plants trees crooked ON PURPOSE and
 *     sinks them by `rBase * scale * tilt * 1.05` so the high edge of the base
 *     disc lands on the pavement and the low edge buries (nature.js:6359-6372).
 *     Measuring the untilted base centre reports every one of ~1,000 trees as
 *     "sunk 3 cm" — a deliberate, documented, invisible effect. So the test is
 *     the CONTACT PATCH, transformed by the instance's real rotation: an object
 *     is on the ground when its sole STRADDLES the ground plane, floating when
 *     its whole sole is above it, sunk when its whole sole is below it.
 *
 * (c) THE PLACER'S GROUND SAMPLER CANNOT SEE ANYTHING ABOVE 0.30 m
 *     (GROUND_CEIL, props.js:6043). Real structures stand higher: the seawall
 *     coping is at 1.36 m (water.js:139) and 128 mooring bollards stand on it.
 *     Sampled against the 0.30 m ground those read as floating 1.32 m, which is
 *     the single largest fake defect on the map. A second sampler, built only
 *     over the cells that came out suspicious, resolves what each one is
 *     actually standing on.
 *
 * (d) A BOUNDING CIRCLE IS THE WRONG SHAPE FOR A BUILDING. A storefront's
 *     radius is the circle through the corners of its parcel, so two adjacent
 *     storefronts on the same block ALWAYS trip a circle-overlap test — 114 of
 *     them did. The circle test the brief specifies is reported as the headline
 *     number, and a rectangle test is reported beside it as the one to act on.
 *
 * HEADLESS TIMING. Chromium renders this scene at ~1.3 fps under software GL
 * and throttles rAF AND setTimeout to match, so an in-page `setTimeout(16)`
 * really costs ~250 ms. This audit is therefore STATIC: load, wait for the
 * world to exist, measure once. It never simulates and never waits on a frame.
 * (Same lesson as tools/qa-flow.mjs.)
 *
 * OUTPUT IS WRITTEN SYNCHRONOUSLY, line by line, for the reason qa-flow.mjs
 * gives: console.log block-buffers through a pipe, so a run that hangs prints
 * nothing at all and is indistinguishable from a crash.
 */

import { chromium } from 'playwright';
import { appendFileSync, writeFileSync } from 'node:fs';

/* ------------------------------------------------------------------ args -- */
const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const URL_BASE = String(flag('url', 'http://localhost:5173/'));
const MAPS = String(flag('maps', 'miami,snowfall')).split(',').map((s) => s.trim()).filter(Boolean);
const TOP = Number(flag('top', 25));
const JSON_OUT = flag('json', null);
const OUT = String(flag('out', '/tmp/place-audit.txt'));

writeFileSync(OUT, '');
const say = (m = '') => { appendFileSync(OUT, m + '\n'); console.log(m); };

/* A run that hangs reads as "still going" forever and nobody learns anything.
   Hard ceiling, then report where it stopped and exit non-zero. */
const WATCHDOG = setTimeout(() => {
  say('\n*** PLACE-AUDIT TIMED OUT after 25 min — the last line above is where it stopped');
  process.exit(2);
}, 25 * 60 * 1000);
WATCHDOG.unref?.();

/* ================================================================= SYMBOLS ==
 * Every name below was read out of the source, not guessed, and carries the
 * file:line it came from. This codebase fails SILENTLY on a wrong name — a kerb
 * pass once placed zero objects because it guessed 'sidewalk' when the mesh is
 * 'streets-land' — so the audit ALSO reports any live `kind` that matches none
 * of these tables rather than quietly dropping it.
 * ========================================================================== */
const SYM = {
  /** props.js:6043 and props.js:6077 — the placer's own two constants. */
  GROUND_CEIL: 0.30,
  GROUND_MIN: 0.115,

  /** Ceiling for the second, lazily-built sampler that resolves what a
   *  suspicious object is really standing on. Above the seawall coping
   *  (1.36 m, water.js:139) and any pontoon or terrace deck. */
  DECK_CEIL: 6.0,

  /** streets.js:99 — the sidewalk top. nature.js:6375 plants at exactly this. */
  Y_WALK: 0.155,

  /** vehicles.js:4965 — the waterline every hull is authored around. */
  BOAT_Y: 0.12,

  /** water.js:139 — the seawall coping. Mooring furniture stands on it. */
  SEAWALL_TOP: 1.36,

  /**
   * Groups the ground sampler must not treat as ground.
   *  - 'buildings' : props.js:6090 skips it for the same reason — no walkable
   *                  surface of its own, and by far the most triangles.
   *  - 'bayfront'  : the spawn island (bayfront.js:1073, ISLAND at x = 4000),
   *                  built AFTER buildWorld. No consumable lives on it.
   */
  skipGroups: ['buildings', 'bayfront'],

  /**
   * Meshes that sit on the ground but are not the ground any placer saw.
   * 'snow-accumulation' (snow.js:222) is added by applySnow AFTER every placer
   * has run, and lays kerbside drifts 10-22 cm proud of the sidewalk
   * (snow.js:200). Counting those as ground reports the whole snowfall map as
   * sunk. Its presence is reported separately instead.
   */
  skipMeshNames: ['snow-accumulation'],

  /**
   * The ONLY props props.js ever places with onRoad = true: the lane-closure
   * taper at props.js:8163-8168 ("This is the one place in the module that
   * WANTS the carriageway"). Everything else on the carriageway is a defect by
   * the placer's own rule at props.js:6381.
   */
  roadLegitProps: ['cone', 'barrel', 'aframe'],

  /** vehicles.js FLEET keys, road half — vehicles.js:3047-3242. */
  vehicleKinds: ('sedan suv hatchback pickup sports convertible supercar roadster gtCoupe taxi '
    + 'police deliveryVan boxTruck flatbed flatbedLoad garbageTruck cementMixer cityBus articBus '
    + 'shuttleBus ambulance scooter motorcycle cruiser bicycle excavator wheelLoader siteDumper '
    + 'craneBase scissorLift roadRoller').split(' '),

  /** placeBoats() only ever puts these where isWater is true (vehicles.js:4991). */
  boatKinds: 'motorYacht sailBoat waterTaxi skiff sportFisher cruiseShip jetSki'.split(' '),

  /**
   * Things that are SUPPOSED to be over water.
   *  - the boats above;
   *  - 'mangrove'      — nature.js:6311, `opts.shoreline` bypasses the water
   *                      test for exactly this species;
   *  - 'mooringBollard','pontoon','buoy' — water.js's own marine furniture
   *                      (water.js:2285-2298, kinds grepped from water.js).
   */
  waterLegitKinds: 'mangrove mooringBollard pontoon buoy'.split(' '),

  /** pedestrians.js:4806 / :4836 — the walking crowd. dynamic:true, it moves. */
  crowdKinds: ['pedestrian', 'dog'],

  /**
   * ROCK-LIKE KINDS. Grepped, not assumed. There is NO key called 'rock' or
   * 'boulder' in props.js DEFS (props.js:5375-5895, 131 keys) or in nature.js
   * SPECIES (nature.js:5285-5852, 43 keys). The only rock in the world is
   * zoo.js's `zooRock`, label 'Boulder' (zoo.js:1061). ('rock' at
   * cityLayout.js:103 is a habitat SURFACE type, and 'boulder' at
   * animals.js:2075 is a stub inside a self-test, not a placed prop.)
   */
  rockKinds: ['zooRock'],
  /** Stone-NAMED street furniture. Furniture, not scenery — reported apart. */
  stoneFurnitureKinds: ['bollardStone', 'benchConcrete', 'planterUrn'],

  /** props.js DEFS keys — props.js:5375-5895. */
  propKinds: ('cone bollard bollardStone bollardBell hydrant standpipe uplighter cleat binMuni '
    + 'binWheelie binMesh trashBags benchSlat benchCurve benchConcrete benchBackless picnicTable '
    + 'lounger signStop signNoEntry signOneWay signParking signStreet sandwichBoard valetStand '
    + 'stanchion mailbox meter newsBox utilityBox atmKiosk phoneKiosk fountain dogStation '
    + 'planterRound planterSquare planterTrough pottedPalm cafeTable cafeTableCloth cafeTableSquare '
    + 'cafeChair bistroChair barStool menuBoard hostStand pastryCase serviceStation terraceRail '
    + 'terraceHedge plantScreen terraceRope stringArch terraceAwning iceBucket gelatoCase chairStack '
    + 'barrelTable porteCochere carpetRunner velvetRope bouncerPodium keyBoard cigBin lightboxSign '
    + 'outdoorBar djBooth speakerStack luggageCart drinksTub loungeSofa loungeTable clothesRail '
    + 'produceStand flowerStand deliveryStack stockTrolley aboardPoster dumpster busBench payStation '
    + 'wayfindTotem newsKiosk meshFence pottedFicus binTwin busStopFlag manholeCover manholeSquare '
    + 'drainGrate cellarHatch planterUrn planterModern hoopStreet courtFlood fenceChain ballBasket '
    + 'bagBackpack bagDuffel bottleSport outreachSign benchTeak chessTable bbqGrill umbrella parasol '
    + 'parasolSquare heater stringPole bicycle bikeRack scooter lampModern lampDeco lampDecoBasket '
    + 'lampPark busShelter foodCart hotdogStand displayRack produceCrate jersey waterBarrier aframe '
    + 'barrel crate pallet scaffold cableDrum sandbags portaloo').split(' '),

  /** nature.js SPECIES keys — nature.js:5285-5852. Plus 'sculpture' (:7539). */
  natureKinds: ('bareTree spruce royalA royalB queenPalm coconutA coconutB sabal fanShort arecaClump '
    + 'washingtonia bismarck banyan liveOak mahogany tabebuia poinciana jacaranda bougain seagrapeT '
    + 'mangrove hedge shrub hibiscus sago traveller croton flowerPink flowerYellow ornGrass '
    + 'groundcover agave planterS planterL pergola fountainS fountainL bandshell playground hoop '
    + 'parkLamp flagUS flagCity sculpture').split(' '),

  /** zoo.js ZOO_DEFS keys — zoo.js:997-1115. */
  zooKinds: ('zooArch zooGateWall zooTurnstile zooTicketBooth zooFenceMesh zooFenceGlass '
    + 'zooFenceTimber zooWallStone zooGatePen zooRail zooPlatform zooInfoBoard zooSignpost '
    + 'zooFoodCart zooRock zooLog zooShed zooBayCanopy zooFeedCrate zooHoseReel zooBuggy zooBench '
    + 'zooBin zooLamp zooPlanter').split(' '),

  /** pedestrians.js STREET_PROPS keys (:4426-4445) plus its one-offs. */
  streetPropKinds: ('streetMat streetTable streetCooler bedroll outreachBoard trolley soapbox '
    + 'signCard pigeon pigeonPeck tripod lightstand venue').split(' '),

  /** water.js kinds — grepped from water.js (only three exist). */
  waterKinds: 'mooringBollard pontoon buoy'.split(' '),

  /** buildings.js kinds — the literals passed to register(), buildings.js:4789. */
  buildingKinds: 'storefront garage lot construction tower midrise landmark'.split(' '),

  /** animals.js keys are built as `animal-${species}-${variant}` (animals.js:1242). */
  animalPrefix: 'animal-',

  /** Metres of vertical slack that still counts as "on the ground". */
  OK_BAND: 0.03,

  /** Interpenetration: d < FIT * (ra + rb). Matches props.js:6193 (SCENERY_FIT
   *  is 0.62 there; the brief asks for 0.55, which is stricter). */
  PEN_FIT: 0.55,
  /** Rectangle test: metres of mutual penetration on BOTH axes to count. */
  BOX_BITE: 0.10,

  TOP,
};

/* ======================================================== IN-PAGE MEASURE ==
 * Everything below runs inside the page and may not close over anything from
 * this file except its CFG argument.
 * ========================================================================== */
function measureWorld(CFG) {
  const g = window.__GAME__;
  const scene = g.engine.scene;
  const layout = g.layout;
  const all = g.allConsumables || [];
  const notes = [];

  /* ------------------------------------------------------------ sampler -- */
  /**
   * A port of props.js's private `Ground` class (props.js:6081-6167). It is a
   * PORT because props.js does not export it; the port is validated by the
   * result — if it were wrong the well-placed majority of 28,000 objects would
   * not land in the +-3 cm band.
   *
   * Two additions over the original:
   *   - every triangle remembers which mesh contributed it, so a sunk object
   *     can be ATTRIBUTED to the surface over it rather than merely counted;
   *   - `wantCells` restricts the build to a set of cells, which is what makes
   *     the high-ceiling second pass affordable.
   */
  function buildSampler(ceil, wantCells) {
    const CELL = 6;
    const grid = new Map();
    const tri = [];
    const triSrc = [];
    const srcNames = [];
    const srcIndex = new Map();
    const skipGroups = new Set(CFG.skipGroups);
    const skipMeshNames = new Set(CFG.skipMeshNames);
    let skippedNamed = 0;

    const cellKey = (i, j) => (i + 4096) * 16384 + (j + 4096);
    const topGroupOf = (n) => {
      let name = n.name || '(unnamed)';
      for (let p = n; p && p.parent; p = p.parent) if (p.parent === scene) name = p.name || name;
      return name;
    };
    const srcId = (label) => {
      let i = srcIndex.get(label);
      if (i === undefined) { i = srcNames.length; srcNames.push(label); srcIndex.set(label, i); }
      return i;
    };

    const addMesh = (n) => {
      const geo = n.geometry;
      const pos = geo && geo.attributes && geo.attributes.position;
      if (!pos) return;
      if (!geo.boundingBox) geo.computeBoundingBox();
      n.updateWorldMatrix(true, false);
      const m = n.matrixWorld.elements;
      const bb = geo.boundingBox;
      // Cheap reject: a mesh entirely above the ceiling cannot be a surface.
      let bMinY = Infinity;
      for (const cx of [bb.min.x, bb.max.x]) {
        for (const cy of [bb.min.y, bb.max.y]) {
          for (const cz of [bb.min.z, bb.max.z]) {
            const wy = m[1] * cx + m[5] * cy + m[9] * cz + m[13];
            if (wy < bMinY) bMinY = wy;
          }
        }
      }
      if (bMinY > ceil) return;

      const sid = srcId(topGroupOf(n) + '/' + (n.name || 'mesh')
        + (n.material && n.material.name ? '/' + n.material.name : ''));

      const idx = geo.index;
      const cnt = idx ? idx.count : pos.count;
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
        if (hi > ceil) continue;
        // Upward-facing only: the underside of a slab is not somewhere to stand.
        const ny = (az[1] - az[0]) * (ax[2] - ax[0]) - (ax[1] - ax[0]) * (az[2] - az[0]);
        if (ny <= 0) continue;
        const i0 = Math.floor(Math.min(ax[0], ax[1], ax[2]) / CELL);
        const i1 = Math.floor(Math.max(ax[0], ax[1], ax[2]) / CELL);
        const j0 = Math.floor(Math.min(az[0], az[1], az[2]) / CELL);
        const j1 = Math.floor(Math.max(az[0], az[1], az[2]) / CELL);
        // The base plane is emitted as a few enormous quads; bucketing those
        // into every cell they touch would put the whole city in one bucket.
        // They are below GROUND_MIN anyway, so nothing is lost by dropping them.
        if (i1 - i0 > 24 || j1 - j0 > 24) continue;
        if (wantCells) {
          let hit = false;
          for (let i2 = i0; i2 <= i1 && !hit; i2++) {
            for (let j2 = j0; j2 <= j1; j2++) if (wantCells.has(cellKey(i2, j2))) { hit = true; break; }
          }
          if (!hit) continue;
        }
        const base = tri.length;
        tri.push(ax[0], az[0], ay[0], ax[1], az[1], ay[1], ax[2], az[2], ay[2]);
        triSrc.push(sid);
        for (let i2 = i0; i2 <= i1; i2++) {
          for (let j2 = j0; j2 <= j1; j2++) {
            if (wantCells && !wantCells.has(cellKey(i2, j2))) continue;
            const k = cellKey(i2, j2);
            let b = grid.get(k);
            if (!b) { b = []; grid.set(k, b); }
            b.push(base);
          }
        }
      }
    };

    scene.traverse((n) => {
      if (!n.isMesh || n.isInstancedMesh) return;
      if (skipMeshNames.has(n.name)) { skippedNamed++; return; }
      for (let p = n; p; p = p.parent) if (skipGroups.has(p.name)) return;
      addMesh(n);
    });

    /** Highest upward surface under (x,z) at or below maxY. {y, src} or null. */
    const at = (x, z, maxY) => {
      const b = grid.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
      if (!b) return null;
      let bestY = null, bestSrc = -1;
      for (let n = 0; n < b.length; n++) {
        const i = b[n];
        const ax = tri[i], az = tri[i + 1], bx = tri[i + 3], bz = tri[i + 4];
        const cx = tri[i + 6], cz = tri[i + 7];
        const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        if (d > -1e-9 && d < 1e-9) continue;
        const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
        if (l1 < 0 || l1 > 1) continue;
        const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
        if (l2 < 0 || l2 > 1) continue;
        const l3 = 1 - l1 - l2;
        if (l3 < 0) continue;
        const y = l1 * tri[i + 2] + l2 * tri[i + 5] + l3 * tri[i + 8];
        if (maxY !== undefined && y > maxY) continue;
        if (bestY === null || y > bestY) { bestY = y; bestSrc = triSrc[i / 9]; }
      }
      return bestY === null ? null : { y: bestY, src: srcNames[bestSrc] };
    };

    return { at, cellKey, CELL, tris: (tri.length / 9) | 0, meshes: srcNames.length, cells: grid.size, skippedNamed };
  }

  const ground = buildSampler(CFG.GROUND_CEIL, null);
  notes.push(`ground sampler (ceiling ${CFG.GROUND_CEIL} m, the placer's own): ${ground.tris} upward `
    + `triangles from ${ground.meshes} meshes in ${ground.cells} cells`
    + (ground.skippedNamed ? `; ${ground.skippedNamed} snow-accumulation mesh(es) excluded` : ''));

  /* -------------------------------------------------- contact geometry -- */
  /**
   * The CONTACT PATCH of a geometry: horizontal extent of the lowest fifth,
   * and the local y of its sole. Identical band to worldBuild.measureGeometry
   * (worldBuild.js:83) so the numbers here mean the same thing the physics
   * means. Cached per geometry — there are ~200 of them and ~28,000 instances.
   */
  const patchCache = new WeakMap();
  const contactPatch = (geo) => {
    let p = patchCache.get(geo);
    if (p) return p;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const h = bb.max.y - bb.min.y;
    const hiLocal = bb.min.y + h * 0.20;
    const pos = geo.attributes.position;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > hiLocal) continue;
      const x = pos.getX(i), z = pos.getZ(i);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    if (!(maxX > minX)) { minX = bb.min.x; maxX = bb.max.x; minZ = bb.min.z; maxZ = bb.max.z; }
    p = { soleY: bb.min.y, minX, maxX, minZ, maxZ, h };
    patchCache.set(geo, p);
    return p;
  };

  /** World y of a local point under quaternion q and scale s, plus origin y. */
  const worldY = (q, s, lx, ly, lz, oy) => {
    const x = q.x, y = q.y, z = q.z, w = q.w;
    const m10 = 2 * (x * y + z * w);
    const m11 = 1 - 2 * (x * x + z * z);
    const m12 = 2 * (y * z - x * w);
    return m10 * (s.x * lx) + m11 * (s.y * ly) + m12 * (s.z * lz) + oy;
  };

  /** World-space AABB of an assembled (non-instanced) object. */
  const objectBox = (obj) => {
    let loY = Infinity, loX = Infinity, hiX = -Infinity, loZ = Infinity, hiZ = -Infinity;
    obj.updateWorldMatrix(true, true);
    obj.traverse((n) => {
      if (!n.isMesh || !n.geometry) return;
      if (!n.geometry.boundingBox) n.geometry.computeBoundingBox();
      const bb = n.geometry.boundingBox;
      const m = n.matrixWorld.elements;
      for (const cx of [bb.min.x, bb.max.x]) {
        for (const cy of [bb.min.y, bb.max.y]) {
          for (const cz of [bb.min.z, bb.max.z]) {
            const wx = m[0] * cx + m[4] * cy + m[8] * cz + m[12];
            const wy = m[1] * cx + m[5] * cy + m[9] * cz + m[13];
            const wz = m[2] * cx + m[6] * cy + m[10] * cz + m[14];
            if (wy < loY) loY = wy;
            if (wx < loX) loX = wx; if (wx > hiX) hiX = wx;
            if (wz < loZ) loZ = wz; if (wz > hiZ) hiZ = wz;
          }
        }
      }
    });
    return Number.isFinite(loY) ? { loY, loX, hiX, loZ, hiZ } : null;
  };

  /* ------------------------------------------------------ layout tests -- */
  const medians = layout.medians || [];
  const onMedian = (x, z) => {
    for (let i = 0; i < medians.length; i++) {
      const r = medians[i];
      const v = r.axis === 'x' ? x : z;
      if (Math.abs(v - r.pos) < (r.medianW || 0) / 2) return true;
    }
    return false;
  };
  const blocks = layout.blocks || [];
  const blockAt = (x, z) => {
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (Math.abs(x - b.x) <= b.w / 2 && Math.abs(z - b.z) <= b.d / 2) return b;
    }
    return null;
  };
  const zoo = layout.zoo;
  const inZoo = (x, z) => !!zoo
    && Math.abs(x - zoo.x) <= zoo.w / 2 && Math.abs(z - zoo.z) <= zoo.d / 2;

  /* ------------------------------------------------------ module lookup -- */
  const known = new Map();
  const tag = (list, name) => { for (const k of list) if (!known.has(k)) known.set(k, name); };
  tag(CFG.propKinds, 'props.js');
  tag(CFG.natureKinds, 'nature.js');
  tag(CFG.zooKinds, 'zoo.js');
  tag(CFG.streetPropKinds, 'pedestrians.js');
  tag(CFG.crowdKinds, 'pedestrians.js(crowd)');
  tag(CFG.vehicleKinds, 'vehicles.js');
  tag(CFG.boatKinds, 'vehicles.js(boat)');
  tag(CFG.waterKinds, 'water.js');
  tag(CFG.buildingKinds, 'buildings.js');
  const moduleOf = (k) => known.get(k)
    || (k && k.startsWith(CFG.animalPrefix) ? 'animals.js' : null);

  /* ---------------------------------------------------- per-consumable -- */
  const rows = [];
  let islandSkipped = 0;
  for (let i = 0; i < all.length; i++) {
    const c = all[i];
    if (!c || !c.position) continue;
    const x = c.position.x, z = c.position.z;
    // The spawn island is parked 4 km east; nothing there is part of the city.
    if (Math.abs(x) > 1500 || Math.abs(z) > 1500) { islandSkipped++; continue; }

    let soleLow = null, soleHigh = null, geoSoleY = null, tilt = 0;
    let hx = c.radius || 0, hz = c.radius || 0, backing = 'mesh';

    if (c.pool && c.slot !== undefined && c.pool.slotPos && c.pool.slotPos[c.slot]) {
      backing = 'instance';
      const p = contactPatch(c.pool.geometry);
      const q = c.pool.slotRot[c.slot];
      const s = c.pool.slotScale[c.slot];
      const oy = c.pool.slotPos[c.slot].y;
      geoSoleY = p.soleY;
      // The four corners of the sole, transformed by this instance's REAL
      // rotation — which is what makes a deliberately tilted tree read as
      // planted rather than as sunk (nature.js:6359-6372).
      let lo = Infinity, hi = -Infinity;
      for (const lx of [p.minX, p.maxX]) {
        for (const lz of [p.minZ, p.maxZ]) {
          const wy = worldY(q, s, lx, p.soleY, lz, oy);
          if (wy < lo) lo = wy; if (wy > hi) hi = wy;
        }
      }
      soleLow = lo; soleHigh = hi;
      // Tilt angle: how far the instance's local +Y has fallen from world +Y.
      const upY = worldY(q, { x: 1, y: 1, z: 1 }, 0, 1, 0, 0);
      tilt = Math.acos(Math.max(-1, Math.min(1, upY)));
      hx = Math.abs(p.maxX - p.minX) / 2 * Math.abs(s.x);
      hz = Math.abs(p.maxZ - p.minZ) / 2 * Math.abs(s.z);
      // Yaw folds the local patch into world axes; take the conservative circle.
      const rr = Math.hypot(hx, hz);
      hx = rr; hz = rr;
    } else if (c.object) {
      const b = objectBox(c.object);
      if (b) {
        soleLow = b.loY; soleHigh = b.loY;
        hx = (b.hiX - b.loX) / 2; hz = (b.hiZ - b.loZ) / 2;
        geoSoleY = b.loY - (c.object.position ? c.object.position.y : 0);
      }
    }

    const gr = ground.at(x, z);
    rows.push({
      i,
      kind: c.kind || '?',
      label: c.label || c.kind || '?',
      module: moduleOf(c.kind),
      backing,
      x: +x.toFixed(2), z: +z.toFixed(2),
      posY: +c.position.y.toFixed(4),
      soleLow: soleLow === null ? null : +soleLow.toFixed(4),
      soleHigh: soleHigh === null ? null : +soleHigh.toFixed(4),
      geoSoleY: geoSoleY === null ? null : +geoSoleY.toFixed(4),
      tilt: +tilt.toFixed(4),
      hx: +hx.toFixed(3), hz: +hz.toFixed(3),
      r: +(c.radius || 0).toFixed(3),
      h: +(c.height || 0).toFixed(3),
      tier: c.tier ? c.tier.id : -1,
      dynamic: !!c.dynamic,
      gy: gr === null ? null : +gr.y.toFixed(4),
      gsrc: gr === null ? null : gr.src,
      deckY: null, deckSrc: null,
      road: !!layout.isRoad(x, z),
      water: !!layout.isWater(x, z),
      median: onMedian(x, z),
      zoo: inZoo(x, z),
      zone: (blockAt(x, z) || {}).zone || null,
      subtype: (blockAt(x, z) || {}).subtype || null,
    });
  }
  if (islandSkipped) {
    notes.push(`${islandSkipped} consumable(s) outside the 1500 m city square were skipped `
      + '(the spawn island is parked at x = 4000)');
  }

  /* ------------------------------- second pass: what is REALLY under it -- */
  /* The placer's sampler is blind above 0.30 m, so anything standing on the
     seawall coping, a pontoon or a terrace deck reads as floating by over a
     metre. Rebuild a sampler with a 6 m ceiling, but ONLY over the cells that
     came out suspicious — a full-map high-ceiling sampler is many times the
     triangles for no extra information. */
  const OK = CFG.OK_BAND;
  const suspicious = rows.filter((r) => r.soleLow === null ? false
    : (r.gy === null || r.soleLow > r.gy + OK || r.soleHigh < r.gy - OK));
  const wantCells = new Set();
  for (const r of suspicious) {
    const i = Math.floor(r.x / ground.CELL), j = Math.floor(r.z / ground.CELL);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) wantCells.add(ground.cellKey(i + di, j + dj));
  }
  let deckResolved = 0;
  if (wantCells.size) {
    const deck = buildSampler(CFG.DECK_CEIL, wantCells);
    notes.push(`deck sampler (ceiling ${CFG.DECK_CEIL} m, ${wantCells.size} suspicious cells only): `
      + `${deck.tris} triangles from ${deck.meshes} meshes`);
    for (const r of suspicious) {
      const d = deck.at(r.x, r.z, r.soleLow + 0.06);
      if (!d) continue;
      r.deckY = +d.y.toFixed(4);
      r.deckSrc = d.src;
      if (Math.abs(r.soleLow - d.y) <= OK) deckResolved++;
    }
  }
  notes.push(`${suspicious.length} object(s) failed against the 0.30 m ground; `
    + `${deckResolved} of them are standing correctly on a structure above that ceiling`);

  /* ------------------------------------------------ 4. interpenetration -- */
  /* Uniform grid, each object inserted into every cell its contact circle
     touches. A naive O(n^2) over 28,000 objects does not finish. */
  const PCELL = 4;
  const pgrid = new Map();
  for (let n = 0; n < rows.length; n++) {
    const o = rows[n];
    if (o.dynamic) continue;              // it moves; where it is now proves nothing
    if (o.r <= 0.01) continue;
    const r = Math.min(o.r, 60);
    const i0 = Math.floor((o.x - r) / PCELL), i1 = Math.floor((o.x + r) / PCELL);
    const j0 = Math.floor((o.z - r) / PCELL), j1 = Math.floor((o.z + r) / PCELL);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = (i + 8192) * 20000 + (j + 8192);
        let b = pgrid.get(k);
        if (!b) { b = []; pgrid.set(k, b); }
        b.push(n);
      }
    }
  }
  const seen = new Set();
  const pairs = [];
  let circleCount = 0, boxCount = 0;
  for (const bucket of pgrid.values()) {
    for (let a = 0; a < bucket.length; a++) {
      for (let b = a + 1; b < bucket.length; b++) {
        const ia = bucket[a], ib = bucket[b];
        const key = ia < ib ? ia * 100000 + ib : ib * 100000 + ia;
        if (seen.has(key)) continue;
        seen.add(key);
        const A = rows[ia], B = rows[ib];
        const reach = (A.r + B.r) * CFG.PEN_FIT;
        const dx = A.x - B.x, dz = A.z - B.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= reach * reach) continue;
        const d = Math.sqrt(d2);
        circleCount++;
        // Rectangle test: how far the two contact footprints actually bite into
        // each other on each world axis. This is the honest one for anything
        // that is not round — see the header note (d).
        const biteX = (A.hx + B.hx) - Math.abs(dx);
        const biteZ = (A.hz + B.hz) - Math.abs(dz);
        const boxHit = biteX > CFG.BOX_BITE && biteZ > CFG.BOX_BITE;
        if (boxHit) boxCount++;
        /* A building, an arena or a construction parcel is a SHELL with usable
           ground inside it: an amphitheatre's bar stools stand on its plaza,
           and a site's crates stand in its yard. Both tests treat that parcel
           as a filled rectangle, so those pairs are geometry of the test rather
           than defects in the world. Flagged, not hidden. */
        const structural = (o) => o.backing === 'mesh' || o.r > 8;
        pairs.push({
          a: A.kind, b: B.kind, x: A.x, z: A.z,
          depth: +(reach - d).toFixed(3), d: +d.toFixed(3),
          ra: A.r, rb: B.r,
          bite: +Math.min(biteX, biteZ).toFixed(3),
          boxHit,
          structural: structural(A) || structural(B),
        });
      }
    }
  }
  pairs.sort((p, q) => q.depth - p.depth);
  const boxPairs = pairs.filter((p) => p.boxHit).sort((p, q) => q.bite - p.bite);
  const propPairs = boxPairs.filter((p) => !p.structural);

  const tally = (list) => {
    const m = new Map();
    for (const p of list) {
      const k = p.a < p.b ? `${p.a} x ${p.b}` : `${p.b} x ${p.a}`;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  return {
    map: g.map ? g.map.id : '?',
    total: all.length,
    measured: rows.length,
    notes,
    rows,
    unknownKinds: [...new Set(rows.filter((r) => !r.module).map((r) => r.kind))],
    pen: {
      circleTotal: circleCount,
      boxTotal: boxCount,
      propTotal: propPairs.length,
      worstCircle: pairs.slice(0, CFG.TOP * 2),
      worstBox: boxPairs.slice(0, CFG.TOP * 2),
      worstProp: propPairs.slice(0, CFG.TOP * 2),
      byKindCircle: tally(pairs).slice(0, 40),
      byKindBox: tally(boxPairs).slice(0, 40),
      byKindProp: tally(propPairs).slice(0, 40),
    },
    zooRect: zoo ? { x: zoo.x, z: zoo.z, w: zoo.w, d: zoo.d } : null,
  };
}

/* ==================================================== NODE-SIDE ANALYSIS == */
const fixed = (v, n = 3) => (v === null || v === undefined || Number.isNaN(v) ? '  n/a' : v.toFixed(n));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

const BUCKETS = [
  ['sunk  > 1.00 m', (e) => e <= -1.0],
  ['sunk  0.50-1.00', (e) => e > -1.0 && e <= -0.5],
  ['sunk  0.25-0.50', (e) => e > -0.5 && e <= -0.25],
  ['sunk  0.10-0.25', (e) => e > -0.25 && e <= -0.10],
  ['sunk  0.03-0.10', (e) => e > -0.10 && e <= -0.03],
  ['ON THE GROUND', (e) => e > -0.03 && e < 0.03],
  ['float 0.03-0.10', (e) => e >= 0.03 && e < 0.10],
  ['float 0.10-0.25', (e) => e >= 0.10 && e < 0.25],
  ['float 0.25-0.50', (e) => e >= 0.25 && e < 0.50],
  ['float 0.50-1.00', (e) => e >= 0.50 && e < 1.0],
  ['float > 1.00 m', (e) => e >= 1.0],
];

function analyse(R, S) {
  const rows = R.rows;
  const OK = S.OK_BAND;
  const boat = new Set(S.boatKinds);
  const vehicle = new Set(S.vehicleKinds);
  const crowd = new Set(S.crowdKinds);
  const roadLegit = new Set(S.roadLegitProps);
  const waterLegit = new Set(S.waterLegitKinds.concat(S.boatKinds));
  const rock = new Set(S.rockKinds);
  const stoneFurn = new Set(S.stoneFurnitureKinds);

  /* ---- 1. vertical error ---------------------------------------------- */
  /* An object is ON THE GROUND when its sole straddles the ground plane:
     floating if the whole sole is above it, sunk if the whole sole is below. */
  const vert = [];
  const voids = [];
  const onDeck = [];
  const dyn = [];
  const overWater = [];
  for (const r of rows) {
    if (r.soleLow === null) continue;
    // Boats are authored with y = 0 at the waterline (vehicles.js:3186) and
    // float over water that has no ground triangle at all. Not a placement
    // question; reported in section 3 instead.
    if (boat.has(r.kind)) continue;
    /* Anything standing over open water has no "ground" in the sense this
       section measures — the sampler returns the bay floor at -0.90 m or the
       water plane at 0.12 m, and the difference between those two answers is
       not a defect in the object. A mangrove is SUPPOSED to have its roots
       under water (nature.js:6311 `opts.shoreline`) and a buoy is supposed to
       float half-submerged (geometry authored with its sole at -0.28).
       Measured in section 3 instead of being counted as sunk here. */
    if (r.water) { overWater.push(r); continue; }
    // Standing correctly on a structure above the sampler's 0.30 m ceiling.
    if (r.deckY !== null && Math.abs(r.soleLow - r.deckY) <= OK) { onDeck.push(r); continue; }
    if (r.gy === null) { voids.push(r); continue; }
    r.err = r.soleLow > r.gy + 1e-9 && r.soleHigh > r.gy
      ? +(r.soleLow - r.gy).toFixed(4)
      : (r.soleHigh < r.gy ? +(r.soleHigh - r.gy).toFixed(4) : 0);
    // Straddling counts as zero: it is exactly what a tilted plant is meant to do.
    if (r.soleLow <= r.gy && r.soleHigh >= r.gy) r.err = 0;
    r.anchorErr = +(r.posY - r.gy).toFixed(4);
    if (r.dynamic) { dyn.push(r); continue; }
    vert.push(r);
  }

  const hist = BUCKETS.map(([name, f]) => [name, vert.filter((r) => f(r.err)).length]);

  const byKind = new Map();
  for (const r of vert) {
    let e = byKind.get(r.kind);
    if (!e) {
      e = { kind: r.kind, module: r.module, n: 0, errs: [], geoSoleY: r.geoSoleY, tilted: 0 };
      byKind.set(r.kind, e);
    }
    e.n++;
    e.errs.push(r.err);
    if (r.tilt > 0.002) e.tilted++;
    if (e.geoSoleY === null) e.geoSoleY = r.geoSoleY;
  }
  const kinds = [];
  for (const e of byKind.values()) {
    const s = e.errs.slice().sort((a, b) => a - b);
    const med = quantile(s, 0.5);
    const p05 = quantile(s, 0.05), p95 = quantile(s, 0.95);
    const bad = e.errs.filter((v) => Math.abs(v) > OK).length;
    const frac = bad / e.n;
    const spread = p95 - p05;
    /* AUTHORING vs PLACEMENT — the split that decides who fixes what.
       The geometry's own lowest vertex is supposed to be at y = 0. When it is
       not, every instance is wrong by the same amount and the fix is one edit
       in the geometry function. When the geometry is fine but the y varies, the
       fix is in whatever computed that y. Tight spread + nearly all instances
       bad is the first; a long tail is the second. */
    let cls;
    if (!bad) cls = 'ok';
    else if (Math.abs(e.geoSoleY ?? 0) > 0.02 || (frac > 0.9 && spread < 0.04)) cls = 'AUTHORING';
    else if (frac > 0.5) cls = 'MIXED';
    else cls = 'PLACEMENT';
    kinds.push({ ...e, med, p05, p95, bad, frac, spread, cls, errs: undefined });
  }
  kinds.sort((a, b) => b.bad - a.bad || Math.abs(b.med) - Math.abs(a.med));

  const worstInstances = vert.filter((r) => Math.abs(r.err) > OK)
    .sort((a, b) => Math.abs(b.err) - Math.abs(a.err));

  /* ---- 2. on the road -------------------------------------------------- */
  const onRoad = rows.filter((r) => r.road);
  const roadClass = (r) => {
    // isRoad() is true over the bridges, so anything floating in the river
    // under one lands here. It is a water question, not a road question.
    if (r.water) return 'over water under a bridge (see section 3)';
    if (crowd.has(r.kind) || r.dynamic) return 'crowd / moving traffic';
    if (vehicle.has(r.kind)) return 'parked vehicle (belongs)';
    if (roadLegit.has(r.kind)) return 'lane closure (props.js onRoad=true)';
    if (r.median) return 'raised median island (legit)';
    if (r.gy !== null && r.gy >= S.GROUND_MIN) return 'kerb-height surface inside road corridor';
    if (r.deckY !== null) return 'on a bridge / raised deck';
    if (r.gy === null) return 'no ground under it at all';
    return 'DEFECT: standing on the carriageway';
  };
  const roadGroups = new Map();
  for (const r of onRoad) {
    const c = roadClass(r);
    let e = roadGroups.get(c);
    if (!e) { e = { cls: c, n: 0, kinds: new Map() }; roadGroups.set(c, e); }
    e.n++;
    e.kinds.set(r.kind, (e.kinds.get(r.kind) || 0) + 1);
  }
  const roadDefects = onRoad.filter((r) => roadClass(r) === 'DEFECT: standing on the carriageway');
  const roadDefectKinds = new Map();
  for (const r of roadDefects) roadDefectKinds.set(r.kind, (roadDefectKinds.get(r.kind) || 0) + 1);

  /* ---- 3. in water ----------------------------------------------------- */
  const inWater = rows.filter((r) => r.water);
  const waterTally = new Map();
  for (const r of inWater) {
    const key = (waterLegit.has(r.kind) ? '(belongs) ' : '') + r.kind;
    waterTally.set(key, (waterTally.get(key) || 0) + 1);
  }
  const waterDefects = inWater.filter((r) => !waterLegit.has(r.kind));

  /* ---- 5. rocks and scenery -------------------------------------------- */
  const rockRows = rows.filter((r) => rock.has(r.kind));
  const stoneRows = rows.filter((r) => stoneFurn.has(r.kind));
  const place = (r) => {
    if (r.water) return 'in water';
    if (r.road) return r.median ? 'road corridor / median' : 'ON THE ROAD';
    if (r.zoo) return 'zoo district';
    if (r.zone === 'park') return 'park block';
    if (r.zone === 'plaza') return 'plaza block';
    if (r.zone === null) return 'between blocks (kerb strip / verge)';
    return 'CITY CORE (' + r.zone + ')';
  };
  const where = (list) => {
    const m = new Map();
    for (const r of list) m.set(place(r), (m.get(place(r)) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  return {
    vert, voids, onDeck, dyn, overWater, hist, kinds, worstInstances,
    onRoad, roadGroups, roadDefects, roadDefectKinds,
    inWater, waterTally, waterDefects,
    rockRows, rockWhere: where(rockRows), stoneRows, stoneWhere: where(stoneRows),
  };
}

/* ------------------------------------------------------------- printing -- */
function report(R, A, S) {
  const T = S.TOP;
  say('');
  say('='.repeat(100));
  say(`MAP ${R.map.toUpperCase()}   ${R.total} consumables, ${R.measured} inside the city square`);
  say('='.repeat(100));
  for (const n of R.notes) say('  note: ' + n);
  if (R.unknownKinds.length) {
    say(`  note: ${R.unknownKinds.length} kind(s) matched no grepped symbol table `
      + `(reported, never assumed): ${R.unknownKinds.slice(0, 24).join(', ')}`);
  }
  say(R.zooRect
    ? `  note: zoo district at (${R.zooRect.x}, ${R.zooRect.z}), ${R.zooRect.w} x ${R.zooRect.d} m`
    : '  note: this seed produced NO zoo district — the rock section will be empty');

  /* ---- 1 --------------------------------------------------------------- */
  say('');
  say('--- 1. VERTICAL ERROR  (sole of the mesh against the ground under it) ------------');
  say('    An object is ON THE GROUND when its contact patch straddles the ground plane.');
  say('    Floating = whole sole above it. Sunk = whole sole below it.');
  say(`    static measured ${A.vert.length}   moving (crowd/traffic, reported apart) ${A.dyn.length}`);
  say(`    standing on a structure above the placer's ${S.GROUND_CEIL} m ceiling `
    + `(seawall, pontoon, deck): ${A.onDeck.length}`);
  say(`    over open water (mangroves, buoys, hulls — see section 3): ${A.overWater.length}`);
  say(`    no surface beneath at all: ${A.voids.length}`);
  const tot = A.vert.length || 1;
  for (const [name, n] of A.hist) {
    const pct = (n / tot) * 100;
    say(`    ${pad(name, 16)} ${lpad(n, 6)}  ${lpad(pct.toFixed(2) + '%', 8)}  ${'#'.repeat(Math.round(pct / 2))}`);
  }
  const badTotal = A.vert.filter((r) => Math.abs(r.err) > S.OK_BAND).length;
  say(`    >>> OUT OF TOLERANCE (>${S.OK_BAND} m): ${badTotal} of ${A.vert.length} `
    + `(${((badTotal / tot) * 100).toFixed(2)}%)`);

  const authoring = A.kinds.filter((k) => k.cls === 'AUTHORING');
  const placement = A.kinds.filter((k) => k.cls === 'PLACEMENT');
  const mixed = A.kinds.filter((k) => k.cls === 'MIXED');
  say('');
  say('    KINDS BY CAUSE — this is the split that decides who fixes what:');
  say(`      AUTHORING  geometry is not base-anchored (or every instance is off by the`);
  say(`                 same amount) -> fix the geometry once: `
    + `${authoring.length} kinds, ${authoring.reduce((s, k) => s + k.bad, 0)} instances`);
  say(`      MIXED      most instances wrong but the spread is too wide to be the mesh: `
    + `${mixed.length} kinds, ${mixed.reduce((s, k) => s + k.bad, 0)} instances`);
  say(`      PLACEMENT  geometry fine, a minority of instances wrong -> fix the caller: `
    + `${placement.length} kinds, ${placement.reduce((s, k) => s + k.bad, 0)} instances`);
  say(`      clean      ${A.kinds.filter((k) => k.cls === 'ok').length} kinds, no instance out of tolerance`);

  say('');
  say(`    WORST KINDS BY AFFECTED INSTANCES (top ${T})`);
  say(`    ${pad('kind', 20)}${pad('module', 22)}${lpad('n', 6)}${lpad('bad', 6)}`
    + `${lpad('%bad', 7)}${lpad('median', 9)}${lpad('p05', 9)}${lpad('p95', 9)}`
    + `${lpad('geoSole', 9)}  cause`);
  for (const k of A.kinds.slice(0, T)) {
    if (!k.bad) break;
    say(`    ${pad(k.kind, 20)}${pad(k.module || '(unknown)', 22)}${lpad(k.n, 6)}${lpad(k.bad, 6)}`
      + `${lpad((k.frac * 100).toFixed(0) + '%', 7)}${lpad(fixed(k.med), 9)}${lpad(fixed(k.p05), 9)}`
      + `${lpad(fixed(k.p95), 9)}${lpad(fixed(k.geoSoleY), 9)}  ${k.cls}`);
  }

  say('');
  say(`    WORST ${T} INDIVIDUAL OBJECTS`);
  say(`    ${pad('kind', 20)}${lpad('err', 9)}${lpad('soleLow', 9)}${lpad('ground', 9)}`
    + `${lpad('x', 9)}${lpad('z', 9)}  surface under it`);
  for (const r of A.worstInstances.slice(0, T)) {
    say(`    ${pad(r.kind, 20)}${lpad(fixed(r.err), 9)}${lpad(fixed(r.soleLow), 9)}`
      + `${lpad(fixed(r.gy), 9)}${lpad(r.x, 9)}${lpad(r.z, 9)}  ${r.gsrc || '-'}`);
  }

  if (A.voids.length) {
    const vk = new Map();
    for (const r of A.voids) vk.set(r.kind, (vk.get(r.kind) || 0) + 1);
    say('');
    say(`    NO SURFACE BENEATH (${A.voids.length}) — over open water, off the ground mesh,`);
    say(`    or on something above the ${S.DECK_CEIL} m deck ceiling:`);
    for (const [k, n] of [...vk.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      const ex = A.voids.find((r) => r.kind === k);
      say(`      ${pad(k, 22)} ${lpad(n, 6)}   e.g. (${ex.x}, ${ex.z}) water=${ex.water}`);
    }
  }
  if (A.dyn.length) {
    const bad = A.dyn.filter((r) => Math.abs(r.err) > S.OK_BAND);
    say('');
    say(`    MOVING OBJECTS (${A.dyn.length}) are excluded from the table above: their y is`);
    say('    driven by the crowd/traffic sim, so where they stand at menu proves nothing.');
    say(`    For the record, ${bad.length} of them are currently out of tolerance.`);
  }

  /* ---- 2 --------------------------------------------------------------- */
  say('');
  say('--- 2. ON THE ROAD  (layout.isRoad true) ----------------------------------------');
  say(`    ${A.onRoad.length} objects sit where isRoad() is true. Broken down honestly:`);
  for (const e of [...A.roadGroups.values()].sort((a, b) => b.n - a.n)) {
    const top = [...e.kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([k, n]) => `${k} ${n}`).join(', ');
    say(`      ${pad(e.cls, 42)} ${lpad(e.n, 6)}   ${top}`);
  }
  say('');
  say('    DEFECTS — on the carriageway, below kerb height, not a vehicle and not the');
  say(`    lane-closure taper props.js is allowed to put there: ${A.roadDefects.length}`);
  if (A.roadDefects.length) {
    say(`      ${pad('kind', 22)}${pad('module', 20)}${lpad('n', 6)}   example`);
    for (const [k, n] of [...A.roadDefectKinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, T)) {
      const ex = A.roadDefects.find((r) => r.kind === k);
      say(`      ${pad(k, 22)}${pad(ex.module || '(unknown)', 20)}${lpad(n, 6)}   `
        + `(${ex.x}, ${ex.z}) ground ${fixed(ex.gy)}`);
    }
  }

  /* ---- 3 --------------------------------------------------------------- */
  say('');
  say('--- 3. IN WATER  (layout.isWater true) ------------------------------------------');
  say(`    ${A.inWater.length} objects. ${A.waterDefects.length} of them do not belong there.`);
  say('    "(belongs)" = a boat (vehicles.js placeBoats), a mangrove (nature.js shoreline),');
  say('    or water.js marine furniture standing on the seawall / a pontoon.');
  say(`      ${pad('kind', 28)}${lpad('n', 6)}`);
  for (const [k, n] of [...A.waterTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, T + 10)) {
    say(`      ${pad(k, 28)}${lpad(n, 6)}`);
  }
  if (A.waterDefects.length) {
    say('    examples:');
    for (const r of A.waterDefects.slice(0, 10)) {
      say(`      ${pad(r.kind, 22)} (${r.x}, ${r.z})  sole ${fixed(r.soleLow)}  `
        + `ground ${fixed(r.gy)}  module ${r.module || '?'}`);
    }
  }

  /* ---- 4 --------------------------------------------------------------- */
  say('');
  say('--- 4. INTERPENETRATION  (static objects only) ----------------------------------');
  say(`    circle test, d < ${S.PEN_FIT} x (ra + rb) as the brief specifies: `
    + `${R.pen.circleTotal} pairs`);
  say(`    rectangle test, both footprints biting >${S.BOX_BITE} m into each other: `
    + `${R.pen.boxTotal} pairs`);
  say(`    rectangle test, EXCLUDING pairs that involve a building or a parcel-sized`);
  say(`    one-off mesh: ${R.pen.propTotal} pairs   <<< THIS IS THE ACTIONABLE NUMBER`);
  say('    Why the first two are inflated: a building\'s radius is the circle through the');
  say('    corners of its parcel, so two adjacent storefronts on one block always trip');
  say('    the circle test; and an arena or a construction site is a SHELL with usable');
  say('    ground inside it, so its bar stools and crates always trip the rectangle one.');
  say('');
  say('    COMMONEST PROP-ON-PROP OVERLAPS BY KIND (no buildings involved)');
  for (const [k, n] of R.pen.byKindProp.slice(0, T)) say(`      ${pad(k, 48)}${lpad(n, 6)}`);
  say('');
  say(`    WORST ${T} PROP-ON-PROP PAIRS BY RECTANGLE BITE`);
  say(`      ${pad('a', 20)}${pad('b', 20)}${lpad('bite', 8)}${lpad('dist', 8)}`
    + `${lpad('ra', 7)}${lpad('rb', 7)}${lpad('x', 9)}${lpad('z', 9)}`);
  for (const p of R.pen.worstProp.slice(0, T)) {
    say(`      ${pad(p.a, 20)}${pad(p.b, 20)}${lpad(p.bite.toFixed(2), 8)}`
      + `${lpad(p.d.toFixed(2), 8)}${lpad(p.ra.toFixed(2), 7)}${lpad(p.rb.toFixed(2), 7)}`
      + `${lpad(p.x, 9)}${lpad(p.z, 9)}`);
  }
  say('');
  say('    COMMONEST OVERLAPS INCLUDING BUILDINGS (low confidence, see above)');
  for (const [k, n] of R.pen.byKindBox.slice(0, 12)) say(`      ${pad(k, 48)}${lpad(n, 6)}`);
  say('');
  say(`    WORST ${T} PAIRS BY OVERLAP DEPTH (circle test, as the brief specifies)`);
  say(`      ${pad('a', 20)}${pad('b', 20)}${lpad('depth', 8)}${lpad('dist', 8)}`
    + `${lpad('ra', 7)}${lpad('rb', 7)}${lpad('bite', 7)}${lpad('x', 9)}${lpad('z', 9)}`);
  for (const p of R.pen.worstCircle.slice(0, T)) {
    say(`      ${pad(p.a, 20)}${pad(p.b, 20)}${lpad(p.depth.toFixed(2), 8)}`
      + `${lpad(p.d.toFixed(2), 8)}${lpad(p.ra.toFixed(2), 7)}${lpad(p.rb.toFixed(2), 7)}`
      + `${lpad(p.bite.toFixed(2), 7)}${lpad(p.x, 9)}${lpad(p.z, 9)}`);
  }

  /* ---- 5 --------------------------------------------------------------- */
  say('');
  say('--- 5. ROCKS AND SCENERY --------------------------------------------------------');
  say(`    Rock-like kinds in this world, grepped not guessed: ${S.rockKinds.join(', ')}`);
  say("    There is no key called 'rock' or 'boulder' in props.js DEFS (131 keys) or in");
  say("    nature.js SPECIES (43 keys). The only rock is zoo.js zooRock, label 'Boulder'.");
  say(`    ${A.rockRows.length} rock instances. Where they are:`);
  for (const [k, n] of A.rockWhere) say(`      ${pad(k, 42)}${lpad(n, 6)}`);
  if (A.rockRows.length) {
    const rs = A.rockRows.filter((r) => r.err !== undefined).map((r) => r.err).sort((a, b) => a - b);
    if (rs.length) {
      say(`      vertical error: median ${fixed(quantile(rs, 0.5))}  p05 ${fixed(quantile(rs, 0.05))}`
        + `  p95 ${fixed(quantile(rs, 0.95))}  out of tolerance `
        + `${rs.filter((v) => Math.abs(v) > S.OK_BAND).length}/${rs.length}`);
    }
    say('      A median of +0.020 m is AUTHORED, not a defect: zoo.js places rocks and');
    say('      logs at `yGround + 0.02` (zoo.js:2235, :2242, :2252).');
    const out = A.rockRows.filter((r) => !r.zoo);
    say(`      rocks OUTSIDE the zoo district: ${out.length}`);
    for (const r of out.slice(0, 12)) {
      say(`        (${r.x}, ${r.z})  zone=${r.zone || 'none'} road=${r.road} water=${r.water}`);
    }
    if (!out.length) {
      say('      >>> So the owner\'s "some rocks are in the wrong place" is NOT about');
      say('      >>> zooRock: every rock on the map is inside its own zoo pen. Look at the');
      say('      >>> IN WATER and INTERPENETRATION sections for the misplaced scenery.');
    }
  }
  say('');
  say(`    Stone-NAMED street furniture (${S.stoneFurnitureKinds.join(', ')}) — `
    + `${A.stoneRows.length} instances, for contrast. These are furniture, not scenery,`);
  say('    and the city core is where they belong:');
  for (const [k, n] of A.stoneWhere) say(`      ${pad(k, 42)}${lpad(n, 6)}`);

  /* ---- ranked table ---------------------------------------------------- */
  const defects = [];
  for (const k of A.kinds) {
    if (!k.bad || k.cls === 'ok') continue;
    defects.push({
      cls: `VERTICAL/${k.cls}`, kind: k.kind, n: k.bad,
      detail: `median ${fixed(k.med)} m, geoSole ${fixed(k.geoSoleY)}, `
        + `${(k.frac * 100).toFixed(0)}% of ${k.n}`,
      owner: k.module || 'unknown',
      weight: k.cls === 'AUTHORING' ? 1.4 : 1.2,
    });
  }
  for (const [k, n] of A.roadDefectKinds) {
    defects.push({
      cls: 'ON THE ROAD', kind: k, n,
      detail: 'standing on the carriageway below kerb height',
      owner: (A.roadDefects.find((r) => r.kind === k) || {}).module || 'unknown',
      weight: 3.0,
    });
  }
  {
    const wk = new Map();
    for (const r of A.waterDefects) wk.set(r.kind, (wk.get(r.kind) || 0) + 1);
    for (const [k, n] of wk) {
      defects.push({
        cls: 'IN WATER', kind: k, n, detail: 'isWater true and does not belong there',
        owner: (A.waterDefects.find((r) => r.kind === k) || {}).module || 'unknown',
        weight: 3.0,
      });
    }
  }
  for (const [k, n] of R.pen.byKindProp.slice(0, 15)) {
    defects.push({
      cls: 'INTERPENETRATION', kind: k, n,
      detail: 'prop footprints bite into each other', owner: '-', weight: 0.8,
    });
  }
  defects.sort((a, b) => b.n * b.weight - a.n * a.weight);

  say('');
  say(`=== RANKED DEFECT TABLE — ${R.map.toUpperCase()} ` + '='.repeat(56));
  say(`  ${pad('#', 4)}${pad('class', 22)}${pad('kind', 32)}${lpad('count', 7)}  ${pad('owner', 22)}detail`);
  defects.slice(0, 45).forEach((d, i) => {
    say(`  ${pad(i + 1, 4)}${pad(d.cls, 22)}${pad(d.kind, 32)}${lpad(d.n, 7)}  `
      + `${pad(d.owner, 22)}${d.detail}`);
  });

  return { defects, badTotal };
}

/* ==================================================================== RUN == */
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--disable-dev-shm-usage'],
});

const results = {};
for (const map of MAPS) {
  const url = URL_BASE + (URL_BASE.includes('?') ? '&' : '?') + 'map=' + map;
  say(`\n### loading ${url}`);
  // Small viewport on purpose: this audit never looks at a pixel, and a big
  // framebuffer under SwiftShader costs minutes for nothing.
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  page.setDefaultTimeout(420000);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.stack || e).split('\n')[0]));

  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('!!window.DEV && !!window.__GAME__ && !!window.__GAME__.layout',
      null, { timeout: 420000 });
  } catch (e) {
    say(`*** ${map}: world never finished building — ${String(e.message).split('\n')[0]}`);
    for (const pe of pageErrors.slice(0, 3)) say('    PAGE ERROR: ' + pe);
    await page.close();
    continue;
  }
  say(`    built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const R = await page.evaluate(measureWorld, SYM);
  const A = analyse(R, SYM);
  const summary = report(R, A, SYM);
  results[map] = {
    map: R.map, total: R.total, measured: R.measured,
    notes: R.notes, unknownKinds: R.unknownKinds,
    histogram: A.hist,
    kinds: A.kinds,
    worstInstances: A.worstInstances.slice(0, TOP).map((r) => ({
      kind: r.kind, err: r.err, soleLow: r.soleLow, gy: r.gy, x: r.x, z: r.z, gsrc: r.gsrc,
    })),
    onDeck: A.onDeck.length,
    voids: A.voids.length,
    overWater: A.overWater.length,
    movingExcluded: A.dyn.length,
    onRoad: A.onRoad.length,
    roadDefects: [...A.roadDefectKinds.entries()].map(([k, n]) => ({ kind: k, n })),
    inWater: A.inWater.length,
    waterDefectCount: A.waterDefects.length,
    waterDefects: [...new Set(A.waterDefects.map((r) => r.kind))],
    penCircle: R.pen.circleTotal,
    penBox: R.pen.boxTotal,
    penProp: R.pen.propTotal,
    penWorstProp: R.pen.worstProp.slice(0, TOP),
    penByKindProp: R.pen.byKindProp,
    penByKindBox: R.pen.byKindBox,
    rocks: { total: A.rockRows.length, where: A.rockWhere },
    stoneFurniture: { total: A.stoneRows.length, where: A.stoneWhere },
    ranked: summary.defects.slice(0, 45),
    pageErrors: pageErrors.slice(0, 5),
  };
  if (pageErrors.length) {
    say('');
    say(`    ${pageErrors.length} page error(s) during build:`);
    for (const pe of [...new Set(pageErrors)].slice(0, 5)) say('      ' + pe);
  }
  await page.close();
}

/* ------------------------------------------------------------ cross-map -- */
say('');
say('='.repeat(100));
say('CROSS-MAP SUMMARY');
say('='.repeat(100));
say(`  ${pad('map', 12)}${lpad('objects', 9)}${lpad('offGround', 11)}${lpad('onDeck', 8)}`
  + `${lpad('void', 7)}${lpad('roadDef', 9)}${lpad('waterDef', 10)}${lpad('overlap', 9)}${lpad('rocks', 7)}`);
for (const [m, r] of Object.entries(results)) {
  const off = r.histogram.reduce((s, [n, c]) => s + (n === 'ON THE GROUND' ? 0 : c), 0);
  const rd = r.roadDefects.reduce((s, d) => s + d.n, 0);
  say(`  ${pad(m, 12)}${lpad(r.measured, 9)}${lpad(off, 11)}${lpad(r.onDeck, 8)}${lpad(r.voids, 7)}`
    + `${lpad(rd, 9)}${lpad(r.waterDefectCount, 10)}${lpad(r.penProp, 9)}${lpad(r.rocks.total, 7)}`);
}
say('  offGround = static objects whose sole misses the ground by more than '
  + SYM.OK_BAND + ' m.');
say('  overlap   = prop-on-prop rectangle overlaps only; buildings excluded.');
say('  The total object count moves by a couple of hundred between runs: the traffic');
say('  sim spawns and retires vehicles during the frames before the audit reads the');
say('  world. Every number above is for STATIC objects unless it says otherwise.');

if (JSON_OUT && typeof JSON_OUT === 'string') {
  writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
  say(`\n  JSON written to ${JSON_OUT}`);
}
say(`\n  text report at ${OUT}`);

clearTimeout(WATCHDOG);
await browser.close();
process.exit(0);
