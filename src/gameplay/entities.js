/**
 * Consumable registry + uniform spatial hash.
 *
 * THE CENTRAL CONTRACT OF THE GAME.
 * Every eatable thing in Miami — a traffic cone, a bus, a 40-storey tower —
 * is registered here as a `Consumable`. The hole never knows what it is eating;
 * it only sees position, footprint and tier.
 *
 * Two backing representations are supported:
 *   1. MESH     — a standalone THREE.Object3D. Animated directly when falling.
 *   2. INSTANCE — one slot of an InstancedMesh (see core/pools.js). On capture the
 *                 slot is zeroed and a pooled proxy Mesh takes over the animation,
 *                 so we get 1 draw call for 4000 cones but full physics on the
 *                 handful that are actually falling at any moment.
 */

import * as THREE from 'three';
import { TIER } from '../config.js';

export const STATE = {
  IDLE: 0,
  WOBBLE: 1,   // inside influence radius, being tugged
  FALLING: 2,  // captured, animating into the pit
  GONE: 3,
};

export const BACKING = { MESH: 0, INSTANCE: 1 };

let _uid = 1;

export class Consumable {
  constructor(opts) {
    this.id = _uid++;
    /** @type {THREE.Object3D|null} */
    this.object = opts.object || null;
    this.backing = opts.backing ?? (opts.object ? BACKING.MESH : BACKING.INSTANCE);

    /** Instanced backing */
    this.pool = opts.pool || null;      // InstancedProp
    this.slot = opts.slot ?? -1;

    this.position = opts.position ? opts.position.clone() : new THREE.Vector3();
    /** Horizontal footprint radius — used for support + overlap tests. */
    this.radius = opts.radius ?? 0.5;
    /** Visual height, used for debris + camera shake weighting. */
    this.height = opts.height ?? this.radius * 2;

    /**
     * The smallest opening this object can actually pass through, once it has
     * tipped over. This is NOT the footprint radius: a car is 4.4 m long but
     * under 2 m wide, so nose-first it goes through a hole far smaller than
     * itself. Requiring the hole to exceed the whole footprint is what made
     * props visibly refuse to be eaten by a hole that plainly dwarfed them.
     *
     * Defaults to a conservative fraction of the footprint; content modules
     * should pass an explicit value for anything strongly elongated.
     */
    // 0.62 is the half-width of a roughly 1:1.6 rectangle whose half-diagonal
    // is `radius` — i.e. the narrow way through, which is how an elongated
    // object actually goes down. A 4.4 m car (radius ~1.7) comes out at ~1.05,
    // so an opening about 2.1 m across swallows it nose-first: far smaller than
    // the car, but not absurdly so.
    this.passRadius = opts.passRadius ?? Math.max(0.12, this.radius * 0.62);

    /** Centre-of-mass height above the ground. Drives the topple dynamics. */
    this.comHeight = opts.comHeight ?? this.height * 0.42;

    const tier = opts.tier || TIER.TINY;
    this.tier = tier;
    /** Hole radius required to eat this. Content may override per-instance. */
    this.eatRadius = opts.eatRadius ?? tier.eatRadius;
    this.score = opts.score ?? tier.score;

    /** Rotation carried from the world build (radians, Y axis). */
    this.rotationY = opts.rotationY ?? 0;
    this.scale = opts.scale ?? 1;

    this.kind = opts.kind || 'prop';
    /** Display name for the "swallowed X" kill-feed. */
    this.label = opts.label || this.kind;
    /** Objects flagged static never move on their own (skips per-frame rehash). */
    this.dynamic = !!opts.dynamic;
    /** Buildings crumble rather than tumble. */
    this.crumbles = !!opts.crumbles;
    /** Debris colour hint for the particle burst. */
    this.debrisColor = opts.debrisColor ?? 0xffffff;
    /** Sound cue key. */
    this.sfx = opts.sfx || null;

    this.state = STATE.IDLE;
    this.fallT = 0;
    this.eatenBy = null;

    /**
     * THE PHYSICS CENTRE IS NOT ALWAYS THE OBJECT'S ORIGIN.
     *
     * `position` is where the footprint actually sits — that is what the
     * support maths must run on, because it is what the player sees resting on
     * the ground. A mesh-backed object's own origin can be somewhere else
     * entirely: a merged pontoon deck carries world-space geometry with its
     * transform left at the origin, and a building's parcel anchor is not the
     * centre of the mass it grew. Measured across the live city the median gap
     * is 0.7 m and the worst is 11.4 m, which is a 51 m pontoon whose physics
     * disc sat a fifth of its own length away from the deck.
     *
     * So the fall animation solves in physics space and this offset converts
     * back to the object's frame on the way out. Zero for instanced props,
     * whose slot transform IS the footprint.
     */
    this._restP = null;      // authored physics centre (mesh backing)
    this._restQ = null;
    this._restS = null;
    this._restObjP = null;   // the object's own authored origin
    this._poseOff = null;    // physics centre - object origin
    if (this.backing === BACKING.MESH && this.object) {
      this._restP = this.position.clone();
      this._restQ = this.object.quaternion.clone();
      this._restS = this.object.scale.clone();
      this._restObjP = this.object.position.clone();
      this._poseOff = this._restP.clone().sub(this._restObjP);
    }

    /**
     * Scratch for the fall animation, created on the first capture by
     * ConsumeSystem.initFallScratch and reused for every later one.
     *
     * Not allocated here: there are 28,000 consumables and most of them are
     * never touched in a given match, so seven vectors each would be about
     * 12 MB of objects standing by for nothing. Creating them on capture keeps
     * the steady-state allocation at zero, which is the property that matters
     * — a late-game hole captures hundreds of props in a single frame.
     */
    this._startPos = null;
    this._hasTipQuat = false;
    this._cellKey = 0;
  }

  /** World-space centre used for capture tests (ground contact point). */
  get x() { return this.position.x; }
  get z() { return this.position.z; }
}

const CELL = 24; // metres

/**
 * A hole's influence query reaches `max(r*INFLUENCE_F, r + 14)` from its
 * centre, and finds objects by their CENTRE. An object of footprint radius `r`
 * therefore cannot be missed while it overlaps the opening as long as
 * `r <= 14` — which covers 27,486 of the 27,646 consumables in the city, but
 * not the 160 garages, towers, landmarks, pontoons and superblock storefronts
 * whose footprints run out to 33 m. Those were invisible to the hole whenever
 * it was under an edge rather than near the middle, so a player could stand a
 * 30 m opening under the corner of a car park and watch nothing happen.
 *
 * They are few enough to simply keep in a list and test exactly.
 */
export const LARGE_RADIUS = 14;

export class EntityRegistry {
  constructor() {
    /** @type {Map<number, Consumable>} */
    this.byId = new Map();
    /** @type {Map<number, Consumable[]>} */
    this.cells = new Map();
    /** Consumables currently animating — iterated every frame. */
    /** @type {Set<Consumable>} */
    this.active = new Set();
    /** Moving consumables (traffic) that must be re-hashed each frame. */
    /** @type {Consumable[]} */
    this.dynamics = [];
    /** Consumables too wide for the spatial query to find by centre alone. */
    /** @type {Consumable[]} */
    this.large = [];
    this.aliveCount = 0;
    this.totalScore = 0;
    /** Populated by worldBuild for the HUD "city devoured" percentage. */
    this.initialCount = 0;
  }

  _key(x, z) {
    const cx = Math.floor(x / CELL) + 4096;
    const cz = Math.floor(z / CELL) + 4096;
    return cx * 8192 + cz;
  }

  add(c) {
    this.byId.set(c.id, c);
    const k = this._key(c.position.x, c.position.z);
    c._cellKey = k;
    let bucket = this.cells.get(k);
    if (!bucket) { bucket = []; this.cells.set(k, bucket); }
    bucket.push(c);
    if (c.dynamic) this.dynamics.push(c);
    if (c.radius > LARGE_RADIUS) this.large.push(c);
    this.aliveCount++;
    this.totalScore += c.score;
    return c;
  }

  /** Call after moving a dynamic consumable. */
  rehash(c) {
    const k = this._key(c.position.x, c.position.z);
    if (k === c._cellKey) return;
    const old = this.cells.get(c._cellKey);
    if (old) {
      const i = old.indexOf(c);
      if (i >= 0) old.splice(i, 1);
    }
    c._cellKey = k;
    let bucket = this.cells.get(k);
    if (!bucket) { bucket = []; this.cells.set(k, bucket); }
    bucket.push(c);
  }

  remove(c) {
    if (!this.byId.has(c.id)) return;
    this.byId.delete(c.id);
    const bucket = this.cells.get(c._cellKey);
    if (bucket) {
      const i = bucket.indexOf(c);
      if (i >= 0) bucket.splice(i, 1);
    }
    if (c.dynamic) {
      const i = this.dynamics.indexOf(c);
      if (i >= 0) this.dynamics.splice(i, 1);
    }
    if (c.radius > LARGE_RADIUS) {
      const i = this.large.indexOf(c);
      if (i >= 0) this.large.splice(i, 1);
    }
    this.active.delete(c);
    this.aliveCount--;
  }

  /**
   * Gather consumables whose centre lies within `r` of (x,z).
   * Writes into `out` and returns it — zero allocation on the hot path.
   */
  query(x, z, r, out) {
    out.length = 0;
    const minX = Math.floor((x - r) / CELL) + 4096;
    const maxX = Math.floor((x + r) / CELL) + 4096;
    const minZ = Math.floor((z - r) / CELL) + 4096;
    const maxZ = Math.floor((z + r) / CELL) + 4096;
    const r2 = r * r;
    for (let cx = minX; cx <= maxX; cx++) {
      const base = cx * 8192;
      for (let cz = minZ; cz <= maxZ; cz++) {
        const bucket = this.cells.get(base + cz);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const c = bucket[i];
          if (c.state === STATE.GONE) continue;
          const dx = c.position.x - x;
          const dz = c.position.z - z;
          if (dx * dx + dz * dz <= r2) out.push(c);
        }
      }
    }
    return out;
  }

  /** Count of still-standing consumables at or below a given tier id. */
  countAtOrBelow(tierId) {
    let n = 0;
    for (const c of this.byId.values()) if (c.tier.id <= tierId) n++;
    return n;
  }
}
