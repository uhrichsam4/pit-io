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
 * where it z-fights with its own faces. Instead we use **alpha-hash /
 * stochastic transparency**: an interleaved-gradient-noise threshold discards
 * fragments. It stays in the opaque pass, needs no sorting, and costs one
 * texture-free instruction.
 *
 * Two things keep it from reading as "broken render":
 *   - the dissolve is confined to a PORTHOLE — a soft screen-space disc centred
 *     on the hole. Beyond it the object is untouched. A registered root is a
 *     whole building, so dissolving the root uniformly turned a 200 m tower
 *     into a column of static in every wide shot; opening a window exactly
 *     where the player is looking reads as a deliberate x-ray instead;
 *   - a Fresnel rim is held near-solid at the porthole's edge, so the
 *     silhouette of the building stays legible — you always know what you are
 *     underneath. It is released toward the centre, or a glass tower's mullions
 *     re-close the opening as a wire mesh.
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

/**
 * Interleaved-gradient noise rather than an ordered Bayer matrix.
 *
 * A 4x4 Bayer threshold at 1:1 produces a coarse, obviously structured checker
 * that reads as "broken render" across a large surface — and an occluding tower
 * at street level can cover half the frame. IGN is a single fract() but its
 * pattern is fine-grained and non-repeating enough that the eye integrates it
 * as translucency instead of resolving the dots.
 */
const DITHER = /* glsl */ `
  float ocDither(vec2 p) {
    return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
  }
`;

const PARS_FRAG = /* glsl */ `
  uniform float uOccFade;        // 1 = solid, 0 = fully dissolved (per object)
  uniform vec2  uOccCenter;      // player hole, in screen pixels
  uniform float uOccRadius;      // hole's on-screen radius, in pixels
  uniform vec2  uOccResolution;
  varying vec3 vOccViewPos;
  varying vec3 vOccViewNormal;
  ${DITHER}
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
    // The x-ray is a PORTHOLE, not a whole-object dissolve.
    //
    // An earlier version also took the whole body down to ~40% opacity and only
    // opened further near the hole. That is fine for a 12 m awning and
    // catastrophic for a 200 m tower: the fading object is a single registered
    // root, so a tower that happens to sit on the camera->hole ray dissolved
    // from its crown to its podium, and 60% stochastic discard across that much
    // screen reads as television static, not as glass. It wrecked every wide
    // shot in the review set. Outside the porthole the object now stays exactly
    // as solid as it ever was, so the skyline is never touched.
    float d = distance(gl_FragCoord.xy, uOccCenter);
    // Floors keep a small hole from opening a porthole too tight to see
    // through; the ceiling stops a late-game hole from opening the whole frame.
    //
    // MEASURED, and much tighter than the first version. At r=30 on the
    // hole-big preset uOccRadius is 103 px, so an outer of rPx * 3.6 opened a
    // 372 px disc — a fifth of the frame — and 90% stochastic discard across
    // that much screen is exactly the television static this porthole exists to
    // avoid. The player only has to see the OPENING plus enough margin to read
    // where its lip is; anything past ~2x the hole radius is noise for nothing.
    float rPx = clamp(uOccRadius, 26.0, 150.0);
    float inner = max(rPx * 1.15, 42.0);  // fully x-rayed
    float outer = max(rPx * 2.10, 112.0); // fully solid again
    float window = 1.0 - smoothstep(inner, outer, d);

    // Guarded rather than early-returned: this block is spliced into the middle
    // of three's main(), so an early return would skip every later chunk
    // (lighting, fog, tone mapping) and emit an undefined colour.
    if (window > 0.001) {
      vec3 V = normalize(-vOccViewPos);
      float fres = 1.0 - abs(dot(normalize(vOccViewNormal), V));
      float rim = smoothstep(0.34, 0.95, fres);

      float keep = mix(1.0, uOccFade, window);

      // Edges stay solid, which is what preserves the outline — but only at the
      // porthole's soft edge. Held everywhere, the retained fresnel on a glass
      // tower's mullions filled the opening with a wire mesh and the hole
      // stayed hidden, which defeats the entire feature.
      keep = mix(keep, 1.0, rim * 0.82 * (1.0 - window * 0.78));

      if (ocDither(gl_FragCoord.xy) > keep) discard;

      // Cool the surviving fragments and lift the rim so the opening reads as a
      // deliberate x-ray. Gated by the window for the same reason as the discard:
      // tinting the solid part of the tower blue announced the bug from 400 m.
      // Pushed harder than the first version. The surviving fragments ARE the
      // artefact — there is no way to make 10% of a facade's pixels read as
      // anything but noise while they still look like facade. Turned into a
      // single flat cyan they stop reading as a broken material and start
      // reading as the same holographic sheet the rim is drawn on.
      float ghost = (1.0 - uOccFade) * window;
      diffuseColor.rgb = mix(diffuseColor.rgb,
                             diffuseColor.rgb * 0.45 + vec3(0.16, 0.30, 0.42),
                             ghost * 0.85);
      diffuseColor.rgb += vec3(0.30, 0.55, 0.85) * rim * ghost * 0.55;
    }
  }
`;

/**
 * The x-ray window: where the player's hole is on screen, and how big. Shared
 * by every patched material because the value is the same for all of them.
 */
export const sharedWindow = {
  uOccCenter: { value: new THREE.Vector2(-1e4, -1e4) },
  uOccRadius: { value: 60 },
  uOccResolution: { value: new THREE.Vector2(1, 1) },
};

/**
 * Patch a material so it can be faded. Idempotent.
 * @template {THREE.Material} T
 * @param {T} material
 * @returns {T}
 */
export function applyOcclusionFade(material) {
  if (!material || material.userData.__occFade) return material;
  // MeshBasicMaterial's vertex shader only declares `objectNormal` under
  // USE_ENVMAP / USE_SKINNING, so the fresnel rim patch below would fail to
  // compile on unlit materials. They are signage and light panels — nothing
  // whose silhouette matters — so they are simply left solid.
  if (material.isMeshBasicMaterial && !material.envMap) return material;
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
    // The window uniforms are identical for every object, so they can be shared
    // objects — three's per-material upload skipping is harmless when the value
    // never differs between draws.
    shader.uniforms.uOccCenter = sharedWindow.uOccCenter;
    shader.uniforms.uOccRadius = sharedWindow.uOccRadius;
    shader.uniforms.uOccResolution = sharedWindow.uOccResolution;
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
    `${prevKey ? prevKey.call(material) : ''}|occfade-v4`;
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

const _proj = new THREE.Vector3();
const _edge = new THREE.Vector3();
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
    this.minFade = opts.minFade ?? 0.10;
    /** Seconds to fade out / back in. Out is faster — responsiveness wins. */
    this.fadeOutRate = opts.fadeOutRate ?? 9.0;
    this.fadeInRate = opts.fadeInRate ?? 4.0;
    /** Rays are cast at the hole centre plus a ring, so wide holes are covered. */
    this.ringSamples = opts.ringSamples ?? 6;

    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = false;

    /** @type {THREE.Object3D[]} roots that may be faded */
    this.candidates = [];
    /**
     * root -> how many of this frame's samples it blocked.
     *
     * A COUNT, not a flag. One ray clipping the edge of a 30 m hole used to
     * dissolve a whole tower, and at that size the hole was plainly visible
     * round it — so the frame paid a fifth of its pixels in stochastic discard
     * to reveal something already on screen. Fading in proportion to how much
     * of the opening is actually hidden is what keeps the x-ray for the case it
     * was built for (a small hole disappearing under a podium) and off
     * everywhere else.
     * @type {Map<THREE.Object3D, number>}
     */
    this._hitThisFrame = new Map();
    /** Fraction of the hole that must be hidden before anything starts to go. */
    this.blockedFloor = opts.blockedFloor ?? 0.34;
    /** @type {Map<THREE.Object3D, number>} root -> current fade */
    this.fades = new Map();
    this._enabled = true;
  }

  /**
   * Register an object as fadeable. `root` is what fades as a unit (a whole
   * building group); every mesh under it is patched and wired.
   */
  register(root) {
    if (!root) return;
    if (root.userData.__occRegistered) {
      // Already known. It may have been dropped by unregister() because it was
      // swallowed; props come back after RESPAWN_DELAY and the whole city comes
      // back on a match restart, so re-arming has to be possible — and cheap.
      // The patched materials and the parts list survive, so this is a push.
      if (root.userData.__occParts && this.candidates.indexOf(root) < 0) {
        root.userData.occFade = 1;
        this.candidates.push(root);
      }
      return;
    }
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

  /**
   * Drop an object (it was swallowed).
   *
   * Restoring the material is not optional. A building removed while it was
   * mid-fade keeps its private clone, and that clone's uOccFade is frozen at
   * whatever it had reached — so when the prop respawns thirty seconds later,
   * or when a restart puts the whole city back, it comes back permanently
   * half-dissolved and never fades again because it is no longer a candidate.
   * That is the single most visible failure this system can produce.
   */
  unregister(root) {
    const i = this.candidates.indexOf(root);
    if (i >= 0) this.candidates.splice(i, 1);
    this.fades.delete(root);
    if (root && root.userData.__occRegistered) {
      root.userData.occFade = 1;
      this._pushFade(root);
      this._setFadeMaterials(root, false);
    }
  }

  /** Convenience: register every direct child of a group. */
  registerGroup(group) {
    if (!group) return;
    for (const child of group.children) this.register(child);
  }

  setEnabled(on) {
    this._enabled = on;
    if (!on) {
      // Put every object back on its SHARED material as well as resetting the
      // value: leaving a clone mounted means the object never picks up a later
      // change to the real material, and it costs a draw-call state change for
      // nothing.
      for (const root of this.candidates) {
        root.userData.occFade = 1;
        this._pushFade(root);
        this._setFadeMaterials(root, false);
      }
      this.fades.clear();
    }
  }

  /** Force everything back to solid without changing what is registered. */
  resetAll() {
    for (const root of this.candidates) {
      if ((root.userData.occFade ?? 1) >= 1 && !root.userData.__occFaded) continue;
      root.userData.occFade = 1;
      this._pushFade(root);
      this._setFadeMaterials(root, false);
    }
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} holePos world position of the player's hole
   * @param {number} holeRadius
   */
  /**
   * Project the hole to screen space so the shader knows where to open its
   * window. Called every frame regardless of whether anything is occluding.
   * @param {number} w drawing-buffer width in pixels
   * @param {number} h drawing-buffer height in pixels
   */
  updateWindow(holePos, holeRadius, w, h) {
    sharedWindow.uOccResolution.value.set(w, h);
    _proj.copy(holePos).project(this.camera);
    const cx = (_proj.x * 0.5 + 0.5) * w;
    const cy = (_proj.y * 0.5 + 0.5) * h; // gl_FragCoord origin is bottom-left
    sharedWindow.uOccCenter.value.set(cx, cy);

    // Radius in pixels: project a point one hole-radius to the side and measure.
    _edge.copy(holePos);
    _edge.x += holeRadius;
    _edge.project(this.camera);
    const ex = (_edge.x * 0.5 + 0.5) * w;
    const ey = (_edge.y * 0.5 + 0.5) * h;
    sharedWindow.uOccRadius.value = Math.max(28, Math.hypot(ex - cx, ey - cy));
  }

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

    const samples = ring + 1;
    const seen = new Set();
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
      // One sample counts ONCE per root however many of its faces it passes
      // through, or a building with a podium, a shaft and a canopy on the same
      // ray reports three quarters of the hole hidden from a single ray.
      seen.clear();
      for (const h of hits) {
        const root = this._rootOf(h.object);
        if (!root || seen.has(root)) continue;
        seen.add(root);
        this._hitThisFrame.set(root, (this._hitThisFrame.get(root) || 0) + 1);
      }
    }

    // Ease every candidate toward its target. Only objects that are currently
    // mid-fade cost anything, so this stays cheap with hundreds of buildings.
    const outK = 1 - Math.exp(-this.fadeOutRate * dt);
    const inK = 1 - Math.exp(-this.fadeInRate * dt);
    const floor = this.blockedFloor;

    for (const root of this.candidates) {
      const blocked = (this._hitThisFrame.get(root) || 0) / samples;
      // Proportional, with a dead band: clipping one edge of a wide hole is not
      // an occlusion, it is a hole with a building next to it.
      const k = blocked <= floor ? 0
        : Math.min(1, (blocked - floor) / (1 - floor));
      const target = 1 - (1 - this.minFade) * (k * k * (3 - 2 * k));
      const cur = root.userData.occFade ?? 1;

      if (Math.abs(cur - target) < 0.002) {
        if (cur !== target) {
          root.userData.occFade = target;
          if (target >= 1) this._setFadeMaterials(root, false);
          else this._pushFade(root);
        }
        continue;
      }
      const ease = target < cur ? outK : inK;
      const next = cur + (target - cur) * ease;
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
