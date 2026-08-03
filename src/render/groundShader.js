/**
 * Multi-hole ground cutter.
 *
 * Every surface a hole can open in (asphalt, sidewalk, grass, plaza, sand, dock
 * decking) uses a material patched by `applyHoleCut`. The fragment shader
 * discards inside any active hole and darkens a soft rim just outside it, which
 * is what sells the "the ground is actually gone" illusion — objects that have
 * dropped below y=0 become visible only through the discarded region, because
 * everywhere else the opaque ground still wins the depth test.
 *
 * All patched materials share ONE uniform block, so adding a hole is a single
 * write per frame regardless of how many ground meshes exist.
 */

import * as THREE from 'three';
import { HOLE, PALETTE } from '../config.js';

const MAX = HOLE.MAX_HOLES;

/** xyz = (worldX, worldZ, radius), w = enabled flag. */
const holeData = [];
for (let i = 0; i < MAX; i++) holeData.push(new THREE.Vector4(0, 0, 0, 0));

export const holeUniforms = {
  uHoles: { value: holeData },
  uHoleCount: { value: 0 },
  uRimColor: { value: new THREE.Color(PALETTE.HOLE_RIM) },
  uTime: { value: 0 },
};

/** Called once per frame by the game loop with the live list of holes. */
export function updateHoleUniforms(holes, time) {
  const n = Math.min(holes.length, MAX);
  for (let i = 0; i < n; i++) {
    const h = holes[i];
    const v = holeData[i];
    v.set(h.position.x, h.position.z, h.radius, h.alive ? 1 : 0);
  }
  for (let i = n; i < MAX; i++) holeData[i].w = 0;
  holeUniforms.uHoleCount.value = n;
  holeUniforms.uTime.value = time;
}

const CUT_PARS = /* glsl */ `
  #define MAX_HOLES ${MAX}
  uniform vec4  uHoles[MAX_HOLES];
  uniform int   uHoleCount;
  uniform vec3  uRimColor;
  uniform float uTime;
  varying vec3  vHoleWorldPos;

  // Cheap value noise, used to break up the rim so it never reads as a
  // mathematically perfect circle under a close camera.
  float hcHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float hcNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hcHash(i), hcHash(i + vec2(1.0, 0.0)), u.x),
               mix(hcHash(i + vec2(0.0, 1.0)), hcHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
`;

const CUT_VERTEX = /* glsl */ `
  vHoleWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;

const CUT_FRAGMENT = /* glsl */ `
  {
    float rim = 0.0;
    for (int i = 0; i < MAX_HOLES; i++) {
      if (i >= uHoleCount) break;
      vec4 h = uHoles[i];
      if (h.w < 0.5) continue;

      vec2 d = vHoleWorldPos.xz - h.xy;
      float dist = length(d);
      float r = h.z;

      // Organic wobble on the cut edge, scaled so big holes wobble more in
      // absolute terms but the same amount in relative terms.
      float ang = atan(d.y, d.x);
      float wob = (hcNoise(vec2(ang * 2.4, uTime * 0.10 + float(i) * 7.3)) - 0.5)
                * r * 0.035;
      float edge = r + wob;

      if (dist < edge) discard;

      // Soft contact-shadow ring hugging the lip.
      float ring = 1.0 - smoothstep(edge, edge + max(0.55, r * 0.42), dist);
      rim = max(rim, ring);
    }
    if (rim > 0.0) {
      float k = pow(rim, 1.55);
      diffuseColor.rgb = mix(diffuseColor.rgb, uRimColor, k * 0.92);
    }
  }
`;

/**
 * Patch any THREE material so holes cut through it.
 * Safe to call on MeshStandardMaterial, MeshPhysicalMaterial, MeshLambertMaterial.
 * @template {THREE.Material} T
 * @param {T} material
 * @returns {T} the same material, for chaining
 */
export function applyHoleCut(material) {
  if (material.userData.__holeCut) return material;
  material.userData.__holeCut = true;

  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    shader.uniforms.uHoles = holeUniforms.uHoles;
    shader.uniforms.uHoleCount = holeUniforms.uHoleCount;
    shader.uniforms.uRimColor = holeUniforms.uRimColor;
    shader.uniforms.uTime = holeUniforms.uTime;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${CUT_PARS}`)
      .replace(
        '#include <project_vertex>',
        `${CUT_VERTEX}\n#include <project_vertex>`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${CUT_PARS}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>\n${CUT_FRAGMENT}`
      );
  };

  // Force a fresh program; two materials with identical parameters but different
  // onBeforeCompile must not share a cached program.
  material.customProgramCacheKey = () => 'holecut-v3';
  material.needsUpdate = true;
  return material;
}

/**
 * Convenience: standard ground material with the cut already applied.
 */
export function makeGroundMaterial(params = {}) {
  const m = new THREE.MeshStandardMaterial({
    roughness: 0.94,
    metalness: 0.0,
    ...params,
  });
  return applyHoleCut(m);
}

/** JS-side mirror of the shader test — used by gameplay to avoid eating "through" ground. */
export function isInsideAnyHole(x, z, holes, pad = 0) {
  for (const h of holes) {
    if (!h.alive) continue;
    const dx = x - h.position.x;
    const dz = z - h.position.z;
    const r = h.radius + pad;
    if (dx * dx + dz * dz < r * r) return h;
  }
  return null;
}
