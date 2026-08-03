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

const MODULES = [
  ['water', buildWater],
  ['buildings', buildBuildings],
  ['nature', buildNature],
  ['props', buildProps],
  ['vehicles', buildVehicles],
];

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
    stats: { consumables: 0, meshes: 0, instances: 0 },

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
        color: opts.hex !== undefined && opts.hex !== null,
      });
      const pos = opts.position;
      const slot = pool.add(
        pos, opts.rotationY || 0, opts.scale ?? 1, opts.hex ?? null,
        opts.tiltX || 0, opts.tiltZ || 0
      );
      if (slot < 0) return null;
      if (opts.decor) return null;
      const c = new Consumable({
        backing: BACKING.INSTANCE,
        pool, slot,
        position: pos,
        radius: opts.radius ?? 0.5,
        height: opts.height ?? 1,
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
      ctx.stats.consumables++;
      return c;
    },

    addMesh(object, opts) {
      (opts.parent || ctx.group(opts.group || 'misc')).add(object);
      if (opts.decor) return null;
      const pos = opts.position || object.position;
      const c = new Consumable({
        backing: BACKING.MESH,
        object,
        position: pos,
        radius: opts.radius ?? 1,
        height: opts.height ?? 1,
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

  console.info(
    `[worldBuild] ${registry.aliveCount} consumables | ` +
    `${pstats.pools} pools / ${pstats.instances} instances | ` +
    `${(performance.now() - t0).toFixed(0)}ms`
  );

  return { layout, props, ctx };
}
