/**
 * Occlusion fade — "never lose the hole behind a tower".
 *
 * When the player's hole slides under a building, an awning, a bridge deck or a
 * parking structure, that geometry fades out so the hole is always visible,
 * then fades back in. Hole.io does the simple version of this; we do it with
 * the silhouette preserved, because a building that vanishes entirely destroys
 * your sense of where you are inside a dense block.
 *
 * HOW THE FADE IS DONE
 * --------------------
 * Not alpha blending. Turning `transparent` on and off per frame forces shader
 * recompiles and drags every faded building into the sorted transparent pass,
 * where it z-fights with its own faces. Instead we use **alpha-hash / stochastic
 * transparency**: an ordered Bayer dither compares against the fade value and
 * discards fragments. It stays in the opaque pass, needs no sorting, costs one
 * texture-free instruction, and — because SMAA and the temporal jitter of a
 * moving camera smear the dither — reads as a clean translucency.
 *
 * On top of that a Fresnel rim is boosted as the object fades, so the edges of
 * the building stay solid while the middle dissolves. That is what keeps the
 * shape legible.
 *
 * PER-OBJECT FADE WITH SHARED MATERIALS
 * -------------------------------------
 * Every tower shares one cached glass material, but each needs its own fade.
 * The obvious trick — write the value in `onBeforeRender` — silently does not
 * work: three.js only re-uploads a material's uniforms when the material *id*
 * changes between draws (`refreshMaterial` in WebGLRenderer.setProgram). Two
 * hundred towers sharing one material are drawn back to back, so only the first
 * one's value ever reaches the GPU and the whole city fades as a single unit.
 *
 * So instead: an object that is actively fading is lazily given its own clone
 * of each material. Clones hit the same program cache key, so there is no
 * shader recompile — just a private uniform block — and the differing material
 * id is exactly what makes three upload it. Clones are only ever made for
 * objects that actually fade (a handful at a time) and are cached for reuse.
 */

import * as THREE from 'three';

/** 4x4 ordered Bayer matrix, normalised. Cheap and stable under motion. */
const BAYER = /* glsl */ `
  float ocBayer(vec2 p) {
    int x = int(mod(p.x, 4.0));
    int y = int(mod(p.y, 4.0));
    int i = x + y * 4;
    // 4x4 ordered dither, unrolled: WebGL1-safe and branch-cheap.
    float m[16];
    m[0]=0.0;   m[1]=8.0;   m[2]=2.0;   m[3]=10.0;
    m[4]=12.0;  m[5]=4.0;   m[6]=14.0;  m[7]=6.0;
    m[8]=3.0;   m[9]=11.0;  m[10]=1.0;  m[11]=9.0;
    m[12]=15.0; m[13]=7.0;  m[14]=13.0; m[15]=5.0;
    float v = 0.0;
    for (int k = 0; k < 16; k++) { if (k == i) { v = m[k]; break; } }
    return (v + 0.5) / 16.0;
  }
`;

const PARS_FRAG = /* glsl */ `
  uniform float uOccFade;      // 1 = solid, 0 = fully dissolved
  varying vec3 vOccViewPos;
  varying vec3 vOccViewNormal;
  ${BAYER}
`;

const PARS_VERT = /* glsl */ `
  varying vec3 vOccViewPos;
  varying vec3 vOccViewNormal;
`;

const VERT_BODY = /* glsl */ `
  vOccViewPos = (modelViewMatrix * vec4(transformed, 1.0)).xyz;
  vOccViewNormal = normalize(normalMatrix * objectNormal);
`;

/**
 * Runs immediately after the diffuse colour is resolved:
 *  - discard by dither so the body dissolves,
 *  - keep + brighten the rim so the silhouette survives.
 */
const FRAG_BODY = /* glsl */ `
  if (uOccFade < 0.999) {
    vec3 V = normalize(-vOccViewPos);
    float fres = 1.0 - abs(dot(normalize(vOccViewNormal), V));
    float rim = smoothstep(0.42, 0.95, fres);

    // The rim keeps a much higher effective opacity than the body.
    float keep = mix(uOccFade, 1.0, rim * 0.85);
    // Never let it go fully invisible: a ghost at 12% still reads as mass.
    keep = max(keep, 0.12 + rim * 0.5);

    if (ocBayer(gl_FragCoord.xy) > keep) discard;

    // Cool the ghost slightly and lift the rim, so a faded tower looks
    // deliberately x-rayed rather than just broken.
    float ghost = 1.0 - uOccFade;
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.35 + vec3(0.10, 0.16, 0.22), ghost * 0.55);
    diffuseColor.rgb += vec3(0.35, 0.60, 0.85) * rim * ghost * 0.55;
  }
`;

/**
 * Patch a material so it can be faded. Idempotent.
 * @template {THREE.Material} T
 * @param {T} material
 * @returns {T}
 */
export function applyOcclusionFade(material) {
  if (!material || material.userData.__occFade) return material;
  material.userData.__occFade = true;

  const prev = material.onBeforeCompile;
  // Deliberately a `function`, not an arrow: three invokes this as
  // `material.onBeforeCompile(...)`, so `this` is whichever material is being
  // compiled. A cloned material must record its uniform on ITSELF — an arrow
  // would close over the original and every clone would silently share it.
  material.onBeforeCompile = function (shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    shader.uniforms.uOccFade = {
      // A clone may already have been asked to fade before its first compile.
      value: this.userData.__occPending ?? 1,
    };
    this.userData.occUniform = shader.uniforms.uOccFade;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${PARS_VERT}`)
      .replace('#include <project_vertex>', `${VERT_BODY}\n#include <project_vertex>`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${PARS_FRAG}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_BODY}`);
  };

  const prevKey = material.customProgramCacheKey;
  material.customProgramCacheKey = () =>
    `${prevKey ? prevKey.call(material) : ''}|occfade-v2`;
  material.needsUpdate = true;
  return material;
}

/**
 * Clone a material for private per-object fading. The clone keeps the same
 * program cache key, so three reuses the compiled program and this costs only
 * a uniform block — but it gets a distinct material id, which is what forces
 * the renderer to actually upload that uniform.
 */
function cloneFadeMaterial(src) {
  const m = src.clone();
  // THREE.Material.copy() does NOT carry onBeforeCompile or
  // customProgramCacheKey across — a naive clone silently loses every shader
  // patch and renders fully opaque, which is exactly the bug this exists to
  // avoid. Copy them explicitly.
  m.onBeforeCompile = src.onBeforeCompile;
  m.customProgramCacheKey = src.customProgramCacheKey;
  m.userData = { ...src.userData };
  // The uniform handle must NOT be shared — it is populated on this clone's
  // own compile, via `this` inside onBeforeCompile.
  m.userData.occUniform = null;
  m.userData.__occPending = 1;
  m.needsUpdate = true;
  return m;
}

const _camPos = new THREE.Vector3();
const _target = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);

export class OcclusionSystem {
  /**
   * @param {THREE.Camera} camera
   * @param {object} [opts]
   */
  constructor(camera, opts = {}) {
    this.camera = camera;
    /** Opacity a fully-occluding object settles at. */
    this.minFade = opts.minFade ?? 0.16;
    /** Seconds to fade out / back in. Out is faster — responsiveness wins. */
    this.fadeOutRate = opts.fadeOutRate ?? 9.0;
    this.fadeInRate = opts.fadeInRate ?? 4.0;
    /** Rays are cast at the hole centre plus a ring, so wide holes are covered. */
    this.ringSamples = opts.ringSamples ?? 6;

    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = false;

    /** @type {THREE.Object3D[]} roots that may be faded */
    this.candidates = [];
    /** @type {Set<THREE.Object3D>} */
    this._hitThisFrame = new Set();
    /** @type {Map<THREE.Object3D, number>} root -> current fade */
    this.fades = new Map();
    this._enabled = true;
  }

  /**
   * Register an object as fadeable. `root` is what fades as a unit (a whole
   * building group); every mesh under it is patched and wired.
   */
  register(root) {
    if (!root || root.userData.__occRegistered) return;
    root.userData.__occRegistered = true;
    root.userData.occFade = 1;
    root.userData.__occFaded = false;

    /** @type {{mesh:THREE.Mesh, shared:THREE.Material|THREE.Material[]}[]} */
    const parts = [];
    root.traverse((n) => {
      if (!n.isMesh) return;
      const mats = Array.isArray(n.material) ? n.material : [n.material];
      for (const m of mats) applyOcclusionFade(m);
      parts.push({ mesh: n, shared: n.material, clone: null });
    });
    if (!parts.length) return;
    root.userData.__occParts = parts;
    this.candidates.push(root);
  }

  /** Swap an object between its shared materials and its private faded clones. */
  _setFadeMaterials(root, faded) {
    const parts = root.userData.__occParts;
    if (!parts) return;
    if (faded && !root.userData.__occFaded) {
      for (const p of parts) {
        if (!p.clone) {
          p.clone = Array.isArray(p.shared)
            ? p.shared.map((m) => cloneFadeMaterial(m))
            : cloneFadeMaterial(p.shared);
        }
        p.mesh.material = p.clone;
      }
      root.userData.__occFaded = true;
    } else if (!faded && root.userData.__occFaded) {
      for (const p of parts) p.mesh.material = p.shared;
      root.userData.__occFaded = false;
    }
  }

  /** Push the current fade value into this object's private uniforms. */
  _pushFade(root) {
    const parts = root.userData.__occParts;
    if (!parts) return;
    const f = root.userData.occFade;
    for (const p of parts) {
      const list = Array.isArray(p.mesh.material) ? p.mesh.material : [p.mesh.material];
      for (const m of list) {
        const u = m.userData && m.userData.occUniform;
        if (u) u.value = f;
        else m.userData.__occPending = f; // not compiled yet; applied on compile
      }
    }
  }

  /** Drop an object (it was swallowed). */
  unregister(root) {
    const i = this.candidates.indexOf(root);
    if (i >= 0) this.candidates.splice(i, 1);
    this.fades.delete(root);
  }

  /** Convenience: register every direct child of a group. */
  registerGroup(group) {
    if (!group) return;
    for (const child of group.children) this.register(child);
  }

  setEnabled(on) {
    this._enabled = on;
    if (!on) {
      for (const root of this.candidates) root.userData.occFade = 1;
      this.fades.clear();
    }
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} holePos world position of the player's hole
   * @param {number} holeRadius
   */
  update(dt, holePos, holeRadius) {
    if (!this._enabled || this.candidates.length === 0) return;

    this._hitThisFrame.clear();
    this.camera.getWorldPosition(_camPos);

    // Sample the hole's footprint: centre plus a ring at ~70% of the radius,
    // so a wide hole under a wide podium is fully detected, not just its centre.
    const ring = Math.max(0, Math.min(10, this.ringSamples));
    const rr = Math.max(0.6, holeRadius * 0.7);

    _dir.copy(holePos).sub(_camPos);
    const dist = _dir.length();
    if (dist < 0.001) return;
    _dir.divideScalar(dist);
    _right.crossVectors(_dir, _worldUp).normalize();
    _up.crossVectors(_right, _dir).normalize();

    for (let i = -1; i < ring; i++) {
      if (i < 0) {
        _target.copy(holePos);
      } else {
        const a = (i / ring) * Math.PI * 2;
        _target.copy(holePos)
          .addScaledVector(_right, Math.cos(a) * rr)
          .addScaledVector(_up, Math.sin(a) * rr);
      }
      _origin.copy(_target).sub(_camPos);
      const len = _origin.length();
      if (len < 0.001) continue;
      _origin.divideScalar(len);

      this.raycaster.set(_camPos, _origin);
      this.raycaster.near = 0.1;
      // Stop short of the ground so we never fade something behind the hole.
      this.raycaster.far = len - 0.5;

      const hits = this.raycaster.intersectObjects(this.candidates, true);
      for (const h of hits) {
        const root = this._rootOf(h.object);
        if (root) this._hitThisFrame.add(root);
      }
    }

    // Ease every candidate toward its target. Only objects that are currently
    // mid-fade cost anything, so this stays cheap with hundreds of buildings.
    const outK = 1 - Math.exp(-this.fadeOutRate * dt);
    const inK = 1 - Math.exp(-this.fadeInRate * dt);

    for (const root of this.candidates) {
      const occluding = this._hitThisFrame.has(root);
      const target = occluding ? this.minFade : 1;
      const cur = root.userData.occFade ?? 1;

      if (Math.abs(cur - target) < 0.002) {
        if (cur !== target) {
          root.userData.occFade = target;
          if (target >= 1) this._setFadeMaterials(root, false);
          else this._pushFade(root);
        }
        continue;
      }
      const k = target < cur ? outK : inK;
      const next = cur + (target - cur) * k;
      root.userData.occFade = next;
      // Anything not fully solid renders through its private clone.
      this._setFadeMaterials(root, true);
      this._pushFade(root);
    }
  }

  _rootOf(obj) {
    let n = obj;
    while (n) {
      if (n.userData && n.userData.__occRegistered) return n;
      n = n.parent;
    }
    return null;
  }
}
