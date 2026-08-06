/**
 * Instanced prop pools.
 *
 * Miami has tens of thousands of small objects, so every repeated prop lives as
 * one slot inside an InstancedMesh: one draw call for 6,000 cones.
 *
 * WHY THERE IS NO PROXY MESH
 * --------------------------
 * An earlier design hid the instance and leased a stand-in Mesh to animate the
 * fall. That is one bug away from leaving a duplicate on the ground — and it
 * did exactly that, because hiding a slot only takes effect when the instance
 * buffer is uploaded, and nothing was uploading it. The prop the player is
 * pulling in is now THE PLACED INSTANCE ITSELF: its matrix is animated in
 * place, so there is no second object that can be left behind, and the thing
 * that tips into the hole is provably the thing that was standing there.
 *
 * The cost of that is per-frame matrix uploads, which is why `flush()` narrows
 * the upload to exactly the rows that changed.
 */

/**
 * Below this height a static prop stops casting. Set from the measured shadow
 * pass, not from taste: everything under it in the caster list was street
 * furniture whose shadow is a few pixels at the gameplay camera.
 */
const SHADOW_MIN_HEIGHT = 1.8;

/**
 * Metres of slack added to a pool's fitted bounding sphere before that sphere
 * is allowed to cull anything. This covers float slop in the fit itself only —
 * instances that MOVE away from where they were authored are handled by
 * _growBounds(), which is called from every path that writes a live transform.
 */
const CULL_SLOP = 1.0;


import * as THREE from 'three';

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _euler = new THREE.Euler();
const _zero = new THREE.Vector3(0, -99999, 0);
const _one = new THREE.Vector3(1, 1, 1);
const _identQ = new THREE.Quaternion();
const _nil = new THREE.Vector3(0, 0, 0);

export class InstancedProp {
  /**
   * @param {THREE.BufferGeometry} geometry
   * @param {THREE.Material} material
   * @param {number} capacity
   * @param {object} [opts]
   */
  constructor(geometry, material, capacity, opts = {}) {
    this.geometry = geometry;
    this.material = material;
    this.capacity = capacity;
    this.count = 0;
    this.name = opts.name || 'prop';

    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.name = `inst-${this.name}`;
    this.mesh.castShadow = opts.castShadow ?? true;
    /**
     * Exempt from the height-based shadow cull. A sedan is 1.4 m tall and would
     * fail it, but a car's shadow is the thing that makes it look like it is ON
     * the road rather than hovering over it — and unlike a bench it MOVES, so
     * the eye tracks it. Anything that moves sets this.
     */
    this.keepShadow = !!opts.keepShadow;
    this.mesh.receiveShadow = opts.receiveShadow ?? true;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    /**
     * Off until finalize() arms it. An InstancedMesh's bounding sphere is
     * meaningless while instances are still being added, and three caches the
     * first sphere it is handed forever — so a pool that is never finalised
     * keeps today's behaviour of drawing unconditionally.
     */
    this.mesh.frustumCulled = false;
    /** Set by _armCulling(); gates every bounds-maintenance path below. */
    this._culled = false;
    /**
     * Radius of ONE instance at its largest authored scale, metres. The pad
     * used when a live transform is written outside the fitted sphere: the
     * sphere holds instance ORIGINS, and an origin on the boundary still has
     * this much geometry hanging off it.
     */
    this._instRadius = 0;

    this.useColor = !!opts.color;
    if (this.useColor) {
      this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(capacity * 3), 3
      );
      this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }

    /** @type {number[]} hex per slot */
    this.slotHex = new Array(capacity).fill(null);
    /**
     * The AUTHORED resting transform of each slot. The live matrix in the
     * instance buffer is free to be animated away from this (an object being
     * dragged into a hole); this is what it returns to when it respawns.
     */
    this.slotPos = [];
    this.slotRot = [];
    this.slotScale = [];

    /**
     * Slots whose matrix changed since the last flush. Uploading the whole
     * buffer for a pool of 1,150 bollards because two of them moved is the
     * difference between this being free and this costing megabytes a frame,
     * so the upload is narrowed to exactly the rows that changed.
     */
    this._dirtySlots = new Set();
    this._dirtyAll = true;
    /** Reused by flush() so coalescing costs no allocation. */
    this._sorted = [];
  }

  /** Mark one slot's matrix for upload. */
  _touch(slot) {
    if (this._dirtyAll) return;
    this._dirtySlots.add(slot);
  }

  /**
   * @returns {number} slot index
   */
  add(position, rotationY = 0, scale = 1, hex = null, tiltX = 0, tiltZ = 0) {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    _euler.set(tiltX, rotationY, tiltZ);
    _q.setFromEuler(_euler);
    const sv = typeof scale === 'number'
      ? _s.set(scale, scale, scale)
      : _s.set(scale.x, scale.y, scale.z);
    _m4.compose(position, _q, sv);
    this.mesh.setMatrixAt(i, _m4);
    if (this.useColor && hex !== null) {
      _v.set(
        ((hex >> 16) & 255) / 255,
        ((hex >> 8) & 255) / 255,
        (hex & 255) / 255
      );
      // three expects linear-space instance colours
      _v.set(
        THREE.MathUtils.clamp(_v.x ** 2.2, 0, 1),
        THREE.MathUtils.clamp(_v.y ** 2.2, 0, 1),
        THREE.MathUtils.clamp(_v.z ** 2.2, 0, 1)
      );
      this.mesh.instanceColor.setXYZ(i, _v.x, _v.y, _v.z);
    }
    this.slotHex[i] = hex;
    this.slotPos[i] = position.clone();
    this.slotRot[i] = new THREE.Quaternion().copy(_q);
    this.slotScale[i] = new THREE.Vector3().copy(sv);
    this._dirtyAll = true;
    // Normally a no-op: everything is added before finalize() arms culling.
    // A pool that is topped up afterwards would otherwise be culled against a
    // sphere that predates its newest instances.
    if (this._culled) this._growBounds(position);
    return i;
  }

  /**
   * Write an arbitrary transform into a live slot. This is how a prop is
   * animated: the REAL placed instance moves, tilts and falls. There is no
   * stand-in mesh, so there is nothing that can be left behind.
   */
  setTransform(slot, position, quaternion, scale) {
    _m4.compose(position, quaternion, scale);
    this.mesh.setMatrixAt(slot, _m4);
    this._touch(slot);
    /*
     * This is the ONLY way a live instance leaves the sphere finalize() fitted:
     * a car drives, an animal walks, a prop tips into a hole. Grow the sphere
     * to cover it, or the pool gets culled while one of its instances is on
     * screen — an object that pops out of existence, which is the exact failure
     * frustum culling on a moving pool is famous for.
     *
     * A zero scale is the "parked off-world" convention (vehicles.js writes
     * (0, -9999, 0) at scale 0 to retire a headlight decal); dragging the
     * sphere down there would make it useless, and the instance is invisible
     * anyway.
     */
    if (this._culled && scale && (scale.x !== 0 || scale.y !== 0 || scale.z !== 0)) {
      this._growBounds(position);
    }
  }

  /** Collapse a slot to nothing. Used when a prop has fallen out of the world. */
  hide(slot) {
    _m4.compose(_zero, _identQ, _nil);
    this.mesh.setMatrixAt(slot, _m4);
    this._touch(slot);
  }

  /** Put a slot back exactly where it was authored. Used by the respawner. */
  restore(slot) {
    _m4.compose(this.slotPos[slot], this.slotRot[slot], this.slotScale[slot]);
    this.mesh.setMatrixAt(slot, _m4);
    this._touch(slot);
  }

  /** Move a slot's authored resting place (respawn at a different spot). */
  reseat(slot, position, quaternion) {
    this.slotPos[slot].copy(position);
    if (quaternion) this.slotRot[slot].copy(quaternion);
    if (this._culled) this._growBounds(position);
    this.restore(slot);
  }

  /**
   * Widen the culling sphere so it contains `p` plus one instance's worth of
   * geometry. Monotonic on purpose — it only ever grows, never shrinks. A
   * sphere that is too big costs a draw call that would have been skipped; a
   * sphere that is too small deletes an object the player can see, and the
   * second failure is not worth a single frame of the first.
   *
   * One distanceTo per moved instance per frame. The traffic updater writes
   * ~1,500 transforms a frame and the whole simulation costs 2.1 ms, so this
   * is noise — and it is on the simulation side of a render-bound frame.
   */
  _growBounds(p) {
    const bs = this.mesh.boundingSphere;
    if (!bs) return;
    if (bs.radius < 0) { bs.center.copy(p); bs.radius = this._instRadius; return; }
    const need = bs.center.distanceTo(p) + this._instRadius;
    if (need > bs.radius) bs.radius = need;
  }

  /**
   * Turn on frustum culling for this pool, once its bounding sphere is real.
   *
   * WHY THIS IS WORTH DOING WHEN A POOL SPANS THE WHOLE MAP. It is not, for
   * the ~250 pools that do — the sphere covers the city and the test always
   * passes. It is worth doing for two other cases, both measured:
   *
   *   - the ~90 pools that are LOCAL (the zoo, the boats, the film shoot, the
   *     one-off landmarks). At the gameplay camera that is 86 draw calls a
   *     frame, counting both the beauty pass and the shadow pass, which three
   *     tests against the shadow ortho — a 120-280 m box, far tighter than the
   *     view frustum;
   *   - the SPAWN ISLAND. It lives at x = 4000, four kilometres off the city
   *     grid, and game.js shows it without hiding Miami. Every city pool was
   *     being submitted in full while the player sat in the lobby looking at a
   *     park: measured at 718 draws / 8.56 M triangles for a city that is not
   *     within 3 km of the frame. With this on it is 125 draws / 1.75 M.
   *
   * The sphere is fitted from the authored transforms and then only ever grows
   * (see _growBounds), so it can be conservative but never wrong.
   */
  _armCulling() {
    if (this.count <= 0) return;
    const bs = this.mesh.boundingSphere;
    if (!bs || !Number.isFinite(bs.radius) || bs.radius < 0) return;

    const geo = this.geometry;
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    let maxScale = 1;
    for (let i = 0; i < this.count; i++) {
      const s = this.slotScale[i];
      if (!s) continue;
      const m = Math.max(s.x, s.y, s.z);
      if (m > maxScale) maxScale = m;
    }
    this._instRadius = (geo.boundingSphere ? geo.boundingSphere.radius : 0) * maxScale;

    bs.radius += CULL_SLOP;
    this._culled = true;
    this.mesh.frustumCulled = true;
  }

  flush() {
    const attr = this.mesh.instanceMatrix;
    if (this._dirtyAll) {
      this.mesh.count = this.count;
      attr.clearUpdateRanges();
      attr.needsUpdate = true;
      if (this.useColor) this.mesh.instanceColor.needsUpdate = true;
      this._dirtyAll = false;
      this._dirtySlots.clear();
      return;
    }
    const n = this._dirtySlots.size;
    if (n === 0) return;
    attr.clearUpdateRanges();

    /*
     * Each update range becomes its own bufferSubData call, and driver
     * overhead per call dominates the 64 bytes it carries. One range per
     * changed row was fine for the two cones the player is nibbling; a 30 m
     * hole destabilises several hundred slots in a single pool and turned one
     * upload into several hundred. So: coalesce runs, and past a sixth of the
     * pool just send the whole buffer, which is one call either way.
     */
    if (n * 6 >= this.count) {
      attr.needsUpdate = true;
      this._dirtySlots.clear();
      return;
    }

    const slots = this._sorted;
    slots.length = 0;
    for (const s of this._dirtySlots) slots.push(s);
    slots.sort((a, b) => a - b);
    let start = slots[0], prev = slots[0];
    for (let i = 1; i < slots.length; i++) {
      const s = slots[i];
      // Bridging a one- or two-row gap re-sends up to 128 wasted bytes and
      // saves a whole call, which is a trade worth making every time.
      if (s <= prev + 2) { prev = s; continue; }
      attr.addUpdateRange(start * 16, (prev - start + 1) * 16);
      start = s; prev = s;
    }
    attr.addUpdateRange(start * 16, (prev - start + 1) * 16);
    attr.needsUpdate = true;
    this._dirtySlots.clear();
  }

  /**
   * Decide whether this pool is worth rendering into the shadow map.
   *
   * A manhole cover, a drain grate, a painted marking or a kerb inlay lies flat
   * on the ground: its shadow is geometrically hidden underneath itself and
   * contributes nothing a player can see. But it still costs a full re-draw of
   * every instance in the shadow pass, and there are thousands of them.
   *
   * The test is deliberately conservative — it only rejects genuinely flat
   * geometry, so the contact shadows that ground props (cones, bins, benches)
   * are untouched. Those are the whole reason the shadow filter was retuned.
   *
   * @returns {{disabled:boolean, height:number, saved:number}}
   */
  /**
   * Should this pool cast a shadow at all?
   *
   * MEASURED, not guessed. perf-audit reports the shadow pass at 3.6 M of the
   * frame's 9.25 M triangles — 39% of all triangle work, spent rendering the
   * scene a second time. The caster list was topped by street furniture:
   * benches at 78 k, planters at 63 k, hydrants at 61 k, trolleys at 39 k.
   *
   * At this game's camera — 40 m up at 54 degrees — a 0.8 m hydrant casts a
   * shadow a few pixels across. A bench casts a smudge. Neither is worth a
   * tenth of a million triangles a frame, and turning them off is invisible
   * unless you are looking for it. What DOES read, and is kept: anything tall
   * enough to throw a shadow with length (trees, palms, lamp columns, poles),
   * anything that moves (every vehicle), and every building.
   *
   * The old rule only caught FLAT things — under 12 cm — which is why a
   * knee-high bench sailed through it.
   */
  optimiseShadows() {
    if (!this.mesh.castShadow) return { disabled: false, height: 0, saved: 0 };
    const geo = this.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const h = bb.max.y - bb.min.y;
    const w = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z);

    // Flat as paint: road markings, manhole covers, mats.
    const flat = h < 0.12 || (h < 0.3 && h / Math.max(0.01, w) < 0.10);
    // Short static furniture. Vehicles and anything animated set keepShadow.
    const stubby = !this.keepShadow && h < SHADOW_MIN_HEIGHT;
    if (!flat && !stubby) return { disabled: false, height: h, saved: 0 };

    this.mesh.castShadow = false;
    const tris = (geo.index ? geo.index.count / 3
                            : (geo.attributes.position?.count || 0) / 3) * this.count;
    return { disabled: true, height: h, saved: tris };
  }

  /** Trim the buffer to what was actually used and compute bounds. */
  finalize() {
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.useColor) this.mesh.instanceColor.needsUpdate = true;
    this.mesh.computeBoundingSphere();
    // Every instance is placed by now, so the sphere finally means something.
    this._armCulling();
    this._dirtyAll = false;
    this._dirtySlots.clear();
    return this.mesh;
  }
}

/**
 * Registry so world modules can share instanced pools by key without passing
 * references through six layers of function calls.
 */
export class PropLibrary {
  constructor(scene) {
    this.scene = scene;
    /** @type {Map<string, InstancedProp>} */
    this.pools = new Map();
  }

  /**
   * @param {string} key
   * @param {() => {geometry: THREE.BufferGeometry, material: THREE.Material, capacity?: number, opts?: object}} factory
   */
  pool(key, factory, capacity = 2048, opts = {}) {
    let p = this.pools.get(key);
    if (!p) {
      const { geometry, material } = factory();
      p = new InstancedProp(geometry, material, capacity, { name: key, ...opts });
      this.pools.set(key, p);
      this.scene.add(p.mesh);
    }
    return p;
  }

  finalizeAll() {
    let instances = 0;
    let shadowSaved = 0;
    let shadowPools = 0;
    let culledPools = 0;
    for (const p of this.pools.values()) {
      p.finalize();
      instances += p.count;
      if (p._culled) culledPools++;
      const o = p.optimiseShadows();
      if (o.disabled) { shadowSaved += o.saved; shadowPools++; }
    }
    return {
      pools: this.pools.size, instances,
      shadowPoolsDisabled: shadowPools,
      shadowTrisSaved: Math.round(shadowSaved),
      culledPools,
    };
  }

  flushAll() {
    for (const p of this.pools.values()) p.flush();
    /*
     * props.js drives its shared night-glow uniform from `onBeforeRender` on
     * the pool meshes, and says so in a comment that names the reason: "the
     * pools are frustumCulled = false, so it is guaranteed every frame".
     * Arming culling breaks that promise — a culled mesh is never drawn and
     * never fires the hook. props.js publishes `scene.userData.propsUpdate`
     * for exactly this, documented as the same idempotent setter and safe to
     * call as well as the render hook, so call it. game.js runs flushAll()
     * once per simulation tick.
     *
     * Belt and braces: the hook still fires from whichever pool draws first,
     * so in practice this only matters on a frame where no prop pool is on
     * screen at all — and on such a frame nothing that reads the uniform is
     * being drawn either.
     */
    const sync = this.scene && this.scene.userData.propsUpdate;
    if (typeof sync === 'function') sync();
  }
}
