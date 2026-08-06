/**
 * World builder — orchestrates every content module against one shared context.
 *
 * CONTRACT FOR CONTENT MODULES
 * ----------------------------
 * Each module exports `build(ctx)` and may only touch its own domain.
 * `ctx` provides:
 *   scene      THREE.Scene
 *   layout     data from cityLayout.buildLayout()
 *   registry   EntityRegistry — never call .add() directly, use the helpers
 *   props      PropLibrary (instanced pools)
 *   rng        seeded RNG
 *   groups     named THREE.Group per module, already parented to the scene
 *   addInstanced(poolKey, factory, opts) -> Consumable
 *   addMesh(object3D, opts) -> Consumable
 *   addDecor(object3D)  — scenery that is NOT edible (parented, no registry entry)
 *   occupy(x, z, r)     — claim ground so modules don't overlap props
 *   isFree(x, z, r)
 *   Y_WALK     sidewalk top height
 *
 * opts for addInstanced/addMesh:
 *   position (Vector3) rotationY scale hex
 *   tier (TIER.*) radius height label kind crumbles debrisColor eatRadius score
 */

import * as THREE from 'three';
import { WORLD, TIER } from '../config.js';
import { makeRNG } from '../core/rng.js';
import { PropLibrary } from '../core/pools.js';
import { Consumable, BACKING } from '../gameplay/entities.js';
import { buildLayout } from './cityLayout.js';
import { buildStreets, Y_WALK } from './streets.js';

import { buildWater } from './water.js';
import { buildBuildings } from './buildings.js';
import { buildNature } from './nature.js';
import { buildProps } from './props.js';
import { buildVehicles } from './vehicles.js';
import { buildPedestrians } from './pedestrians.js';
import { buildZoo } from './zoo.js';
import { buildAnimals } from './animals.js';

// Order matters: pedestrians read the occupancy grid to keep crowds off props
// and they share the road network's signal phases with traffic, so they run
// last — after every module that claims ground has claimed it.
const MODULES = [
  ['water', buildWater],
  ['buildings', buildBuildings],
  ['nature', buildNature],
  ['props', buildProps],
  /* The zoo's built fabric — gates, pens, paths, ponds, back-of-house — goes in
     with the other ground-claiming passes, BEFORE traffic and crowds so they
     route around it, and before animals so the pens exist to contain them. */
  ['zoo', buildZoo],
  ['vehicles', buildVehicles],
  ['pedestrians', buildPedestrians],
  /* Animals last. They need the pens that props.js fenced and the ground that
     everything before them claimed, and — unlike every other module here — they
     MOVE, so they must not be competing for occupancy with a pass that has not
     run yet. A no-op when the seed produced no zoo site. */
  ['animals', buildAnimals],
];


/**
 * Measure what an object actually puts on the ground.
 *
 * Content modules hand-declare `radius`/`height`, and an audit of all 129 prop
 * kinds found them systematically wrong — a city bus declaring 3.2 m against a
 * true 5.98 m contact footprint, a construction site declaring 9.6 against
 * 22.6. The consumption physics runs on those numbers, so the game was
 * computing support loss for objects roughly half the size of the ones the
 * player can see. Measuring the geometry removes a whole class of that bug and
 * keeps it removed when the art changes.
 *
 * Two extents matter and must not be conflated:
 *   contact — geometry in the lowest fifth of the object. This is what rests on
 *             the ground, so it is what support and overlap must use. A palm's
 *             16 m frond crown says nothing about how it is held up.
 *   narrow  — the smaller horizontal side of that contact patch, which is the
 *             way an elongated object goes down a hole.
 */
const _geoCache = new WeakMap();
function measureGeometry(geometry) {
  let m = _geoCache.get(geometry);
  if (m) return m;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const height = bb.max.y - bb.min.y;
  const hiLocal = bb.min.y + height * 0.20;
  const pos = geometry.attributes.position;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > hiLocal) continue;
    const x = pos.getX(i), z = pos.getZ(i);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  // Degenerate contact band (a sphere on a stick): fall back to full extents.
  if (!(maxX > minX)) { minX = bb.min.x; maxX = bb.max.x; minZ = bb.min.z; maxZ = bb.max.z; }
  const cw = maxX - minX, cd = maxZ - minZ;
  m = {
    height,
    baseY: bb.min.y,
    contactRadius: Math.hypot(cw, cd) / 2,
    narrowHalf: Math.min(cw, cd) / 2,
  };
  _geoCache.set(geometry, m);
  return m;
}

/** Coarse occupancy grid so modules don't stack props on top of each other. */
class Occupancy {
  constructor(cell = 3) {
    this.cell = cell;
    this.map = new Map();
  }
  _k(x, z) {
    return (Math.floor(x / this.cell) + 4096) * 8192 + (Math.floor(z / this.cell) + 4096);
  }
  occupy(x, z, r) {
    const c = this.cell;
    const n = Math.max(0, Math.ceil(r / c));
    for (let i = -n; i <= n; i++) {
      for (let j = -n; j <= n; j++) {
        this.map.set(this._k(x + i * c, z + j * c), r);
      }
    }
  }
  isFree(x, z, r) {
    const c = this.cell;
    const n = Math.max(0, Math.ceil(r / c));
    for (let i = -n; i <= n; i++) {
      for (let j = -n; j <= n; j++) {
        if (this.map.has(this._k(x + i * c, z + j * c))) return false;
      }
    }
    return true;
  }
}

export function buildWorld(scene, registry, renderer, seed = 20260803) {
  const t0 = performance.now();
  const layout = buildLayout(seed);
  const props = new PropLibrary(scene);
  const occ = new Occupancy(3);
  const rng = makeRNG(seed ^ 0x5f3a);

  const groups = {};
  const _v = new THREE.Vector3();

  const ctx = {
    scene, layout, registry, props, rng, renderer,
    Y_WALK,
    TIER,
    groups,
    occ,
    stats: { consumables: 0, meshes: 0, instances: 0, measured: 0, corrected: 0 },

    /**
     * EVERY consumable ever created, alive or eaten.
     *
     * The registry only holds what is currently standing, so it cannot be used
     * to restore a match — by the end of a round most of the city is missing
     * from it. A restart walks this list instead, which is the only way to put
     * the city back exactly as it was built.
     */
    allConsumables: [],

    group(name) {
      let g = groups[name];
      if (!g) { g = new THREE.Group(); g.name = name; scene.add(g); groups[name] = g; }
      return g;
    },

    occupy: (x, z, r) => occ.occupy(x, z, r),
    isFree: (x, z, r) => occ.isFree(x, z, r),

    /**
     * @param {string} key pool identifier
     * @param {() => {geometry, material}} factory built once per key
     */
    addInstanced(key, factory, opts) {
      const pool = props.pool(key, factory, opts.capacity || 3000, {
        castShadow: opts.castShadow !== false,
        receiveShadow: opts.receiveShadow ?? false,
        // Exempts the pool from the height-based shadow cull in pools.js.
        // Anything that MOVES sets this; a parked bench does not.
        keepShadow: !!opts.keepShadow,
        color: opts.hex !== undefined && opts.hex !== null,
      });
      const pos = opts.position;
      const slot = pool.add(
        pos, opts.rotationY || 0, opts.scale ?? 1, opts.hex ?? null,
        opts.tiltX || 0, opts.tiltZ || 0
      );
      if (slot < 0) return null;
      if (opts.decor) return null;

      // Ground truth from the mesh, scaled by this instance. Authored values
      // are kept only as a fallback, or when a module opts out explicitly.
      const gm = measureGeometry(pool.geometry);
      const sc = typeof opts.scale === 'number' ? (opts.scale ?? 1) : 1;
      const measured = opts.exactSize ? null : {
        radius: gm.contactRadius * sc,
        height: gm.height * sc,
        passRadius: Math.max(0.12, gm.narrowHalf * sc * 1.02),
      };
      if (measured) {
        ctx.stats.measured++;
        const declared = opts.radius ?? 0.5;
        if (Math.abs(declared - measured.radius) / Math.max(0.05, measured.radius) > 0.35) {
          ctx.stats.corrected++;
        }
      }

      const c = new Consumable({
        backing: BACKING.INSTANCE,
        pool, slot,
        position: pos,
        radius: measured ? measured.radius : (opts.radius ?? 0.5),
        height: measured ? measured.height : (opts.height ?? 1),
        passRadius: opts.passRadius ?? (measured ? measured.passRadius : undefined),
        tier: opts.tier || TIER.TINY,
        eatRadius: opts.eatRadius,
        score: opts.score,
        rotationY: opts.rotationY || 0,
        scale: opts.scale ?? 1,
        kind: opts.kind || key,
        label: opts.label || key,
        dynamic: opts.dynamic,
        crumbles: opts.crumbles,
        debrisColor: opts.debrisColor,
        sfx: opts.sfx,
      });
      registry.add(c);
      ctx.allConsumables.push(c);
      ctx.stats.consumables++;
      return c;
    },

    addMesh(object, opts) {
      (opts.parent || ctx.group(opts.group || 'misc')).add(object);
      if (opts.decor) return null;
      let pos = opts.position || object.position;
      // Buildings and other one-off meshes: measure the assembled object.
      let mRadius = opts.radius ?? 1;
      let mHeight = opts.height ?? 1;
      let mPass = opts.passRadius;
      if (!opts.exactSize) {
        object.updateWorldMatrix(true, true);
        const box = new THREE.Box3().setFromObject(object);
        if (Number.isFinite(box.min.x) && box.max.x > box.min.x) {
          const w = box.max.x - box.min.x, d = box.max.z - box.min.z;
          mRadius = Math.hypot(w, d) / 2;
          mHeight = Math.max(0.2, box.max.y - box.min.y);
          mPass = mPass ?? Math.max(0.12, Math.min(w, d) / 2 * 1.02);
          // The support disc has to sit under the footprint the player can
          // see. Usually the authored anchor already does — a building's
          // parcel centre lands within 0.72 m of its measured box, and that
          // gap is awning and canopy asymmetry rather than a misplaced
          // building, so moving the disc onto it would be less right, not
          // more. What has to be caught is an anchor that is not on the object
          // at all: the merged marina pontoons carry world-space geometry and
          // were declaring a 51 m support disc 11.4 m from the deck it belongs
          // to. Only override when the disagreement is that kind of size.
          // Keep the authored Y — that is the surface the object rests on, and
          // the box bottom includes foundations that must not lift it.
          const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
          if (Math.hypot(cx - pos.x, cz - pos.z) > Math.max(1.5, mRadius * 0.18)) {
            pos = new THREE.Vector3(cx, pos.y, cz);
          }
          ctx.stats.measured++;
          if (Math.abs((opts.radius ?? 1) - mRadius) / Math.max(0.05, mRadius) > 0.35) {
            ctx.stats.corrected++;
          }
        }
      }

      const c = new Consumable({
        backing: BACKING.MESH,
        object,
        position: pos,
        radius: mRadius,
        height: mHeight,
        passRadius: mPass,
        tier: opts.tier || TIER.SMALL,
        eatRadius: opts.eatRadius,
        score: opts.score,
        kind: opts.kind || 'mesh',
        label: opts.label || opts.kind || 'thing',
        dynamic: opts.dynamic,
        crumbles: opts.crumbles,
        debrisColor: opts.debrisColor,
        sfx: opts.sfx,
      });
      registry.add(c);
      ctx.allConsumables.push(c);
      ctx.stats.consumables++;
      ctx.stats.meshes++;
      return c;
    },

    addDecor(object, groupName = 'decor') {
      ctx.group(groupName).add(object);
      return object;
    },

    /** Random point inside a block, inset from the edges. */
    pointInBlock(b, inset, r) {
      const w = Math.max(1, b.w - inset * 2);
      const d = Math.max(1, b.d - inset * 2);
      return _v.set(
        b.x - w / 2 + r() * w,
        Y_WALK,
        b.z - d / 2 + r() * d
      ).clone();
    },
  };

  buildStreets(ctx);

  for (const [name, fn] of MODULES) {
    const ts = performance.now();
    try {
      fn(ctx);
    } catch (e) {
      console.error(`[worldBuild] module "${name}" failed:`, e);
    }
    if (typeof console.debug === 'function') {
      console.debug(`[worldBuild] ${name}: ${(performance.now() - ts).toFixed(0)}ms`);
    }
  }

  const pstats = props.finalizeAll();
  ctx.stats.instances = pstats.instances;
  registry.initialCount = registry.aliveCount;

  scene.userData.buildStats = ctx.stats;
  console.info(
    `[worldBuild] ${registry.aliveCount} consumables | ` +
    `${pstats.pools} pools / ${pstats.instances} instances | ` +
    `${(performance.now() - t0).toFixed(0)}ms | ` +
    `${ctx.stats.measured} sized from geometry ` +
    `(${ctx.stats.corrected} were off by >35% as authored) | ` +
    `${pstats.shadowPoolsDisabled} flat pools skip the shadow pass ` +
    `(-${(pstats.shadowTrisSaved / 1000).toFixed(0)}k tris)`
  );

  return { layout, props, ctx };
}
