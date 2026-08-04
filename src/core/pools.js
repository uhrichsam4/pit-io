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
    this.mesh.receiveShadow = opts.receiveShadow ?? true;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;

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
    this.restore(slot);
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
  optimiseShadows() {
    if (!this.mesh.castShadow) return { disabled: false, height: 0, saved: 0 };
    const geo = this.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const h = geo.boundingBox.max.y - geo.boundingBox.min.y;
    // Also weigh how wide it is: a 10 cm tall but 3 m wide slab is a road
    // marking; a 10 cm tall, 10 cm wide object is a kerb stone with a shadow.
    const w = Math.max(
      geo.boundingBox.max.x - geo.boundingBox.min.x,
      geo.boundingBox.max.z - geo.boundingBox.min.z
    );
    const flat = h < 0.12 || (h < 0.3 && h / Math.max(0.01, w) < 0.10);
    if (!flat) return { disabled: false, height: h, saved: 0 };
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
    for (const p of this.pools.values()) {
      p.finalize();
      instances += p.count;
      const o = p.optimiseShadows();
      if (o.disabled) { shadowSaved += o.saved; shadowPools++; }
    }
    return {
      pools: this.pools.size, instances,
      shadowPoolsDisabled: shadowPools,
      shadowTrisSaved: Math.round(shadowSaved),
    };
  }

  flushAll() {
    for (const p of this.pools.values()) p.flush();
  }
}
