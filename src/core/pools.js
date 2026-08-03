/**
 * Instancing + proxy pooling.
 *
 * Miami has tens of thousands of small objects. Drawing them individually would
 * bury the GPU, so every repeated prop lives as one slot inside an InstancedMesh.
 * The moment a prop is swallowed it needs individual physics, so we zero its
 * instance slot and lease it a real Mesh from a free list — one draw call for
 * 6000 sleeping cones, real transforms for the eight that are currently falling.
 */

import * as THREE from 'three';

/** Cloned materials keyed by "<uuid>|<hex>" so proxies never recompile shaders. */
const _matCache = new Map();

function tintedMaterial(base, hex) {
  if (hex === undefined || hex === null) return base;
  const key = `${base.uuid}|${hex}`;
  let m = _matCache.get(key);
  if (!m) {
    m = base.clone();
    if (m.color) m.color.setHex(hex);
    // Match the instanced draw, which multiplies instanceColor into diffuse.
    m.vertexColors = false;
    _matCache.set(key, m);
  }
  return m;
}

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

    /** @type {number[]} hex per slot, for proxy tinting */
    this.slotHex = new Array(capacity).fill(null);
    /** Cached transforms so a proxy can inherit them exactly. */
    this.slotPos = [];
    this.slotRot = [];
    this.slotScale = [];

    /** @type {THREE.Mesh[]} */
    this._freeProxies = [];
    this._dirty = true;
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
    this._dirty = true;
    return i;
  }

  /** Write an arbitrary transform into a live slot (used by traffic). */
  setTransform(slot, position, quaternion, scale) {
    _m4.compose(position, quaternion, scale);
    this.mesh.setMatrixAt(slot, _m4);
    this._dirty = true;
  }

  hide(slot) {
    _m4.compose(_zero, _identQ, _nil);
    this.mesh.setMatrixAt(slot, _m4);
    this._dirty = true;
  }

  /** Lease a standalone Mesh matching the given slot, then hide the slot. */
  leaseProxy(slot) {
    const hex = this.slotHex[slot];
    let mesh = this._freeProxies.pop();
    const mat = tintedMaterial(this.material, hex);
    if (!mesh) {
      mesh = new THREE.Mesh(this.geometry, mat);
      mesh.castShadow = this.mesh.castShadow;
      mesh.receiveShadow = false;
    } else {
      mesh.material = mat;
      mesh.visible = true;
    }
    mesh.position.copy(this.slotPos[slot]);
    mesh.quaternion.copy(this.slotRot[slot]);
    mesh.scale.copy(this.slotScale[slot]);
    mesh.__pool = this;
    this.hide(slot);
    return mesh;
  }

  releaseProxy(mesh) {
    mesh.visible = false;
    if (mesh.parent) mesh.parent.remove(mesh);
    if (this._freeProxies.length < 64) this._freeProxies.push(mesh);
  }

  flush() {
    if (!this._dirty) return;
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.useColor) this.mesh.instanceColor.needsUpdate = true;
    this._dirty = false;
  }

  /** Trim the buffer to what was actually used and compute bounds. */
  finalize() {
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.useColor) this.mesh.instanceColor.needsUpdate = true;
    this.mesh.computeBoundingSphere();
    this._dirty = false;
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
    for (const p of this.pools.values()) { p.finalize(); instances += p.count; }
    return { pools: this.pools.size, instances };
  }

  flushAll() {
    for (const p of this.pools.values()) p.flush();
  }
}
