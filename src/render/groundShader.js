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
 *
 * ---------------------------------------------------------------------------
 * THE TEAR
 * ---------------------------------------------------------------------------
 * The cut edge is not a circle. `HOLE_EDGE_GLSL` below defines a three-octave
 * periodic wobble sampled on the unit circle — periodic *by construction*, so
 * there is no seam at atan()'s ±pi branch cut, which is what a naive
 * noise(angle) does and it shows up as one ugly notch that never moves.
 *
 * gameplay/hole.js imports the exact same snippet for the dirt collar it draws
 * on top of the cut. If the two ever disagree the collar floats over the void
 * on one side and buries the lip on the other, so they must stay shared.
 */

import * as THREE from 'three';
import { HOLE, PALETTE } from '../config.js';

const MAX = HOLE.MAX_HOLES;

/** How far the tear deviates from a perfect circle, as a fraction of radius. */
export const EDGE_AMP = 0.075;

/** xyz = (worldX, worldZ, radius), w = enabled flag. */
const holeData = [];
/** rgb = owner colour, w = per-hole edge seed. */
const holeTint = [];
for (let i = 0; i < MAX; i++) {
  holeData.push(new THREE.Vector4(0, 0, 0, 0));
  holeTint.push(new THREE.Vector4(1, 1, 1, 0));
}

export const holeUniforms = {
  uHoles: { value: holeData },
  uHoleTint: { value: holeTint },
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
    // displayRadius, not radius: the ground opening has to breathe with the
    // gulp animation or the dirt collar detaches from the cut for a few frames
    // after every swallow.
    const r = h.displayRadius != null ? h.displayRadius : h.radius;
    v.set(h.position.x, h.position.z, r, h.alive ? 1 : 0);
    const c = holeTint[i];
    c.x = h.color ? h.color.r : 1;
    c.y = h.color ? h.color.g : 1;
    c.z = h.color ? h.color.b : 1;
    c.w = h.edgeSeed != null ? h.edgeSeed : 0;
  }
  for (let i = n; i < MAX; i++) holeData[i].w = 0;
  holeUniforms.uHoleCount.value = n;
  holeUniforms.uTime.value = time;
}

/**
 * Shared torn-edge maths. `dir` must be a UNIT vector in the hole's local XZ
 * frame; sampling the noise on the circle rather than on the angle is what
 * keeps it seamless. Returns roughly -0.5..0.5.
 *
 * Exported as source so gameplay/hole.js can compile the identical function
 * into its lip material.
 */
export const HOLE_EDGE_GLSL = /* glsl */ `
  // sin-free hash. This runs on every ground fragment within reach of a hole,
  // eight taps at a time; a sin() per tap is measurable even on real hardware
  // and brutal under the SwiftShader rasteriser the screenshot harness uses.
  float hcHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float hcNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hcHash(i), hcHash(i + vec2(1.0, 0.0)), u.x),
               mix(hcHash(i + vec2(0.0, 1.0)), hcHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  // Two octaves. The low one gives the big geological lobes, the high one the
  // crumbled bite marks. A third octave is not worth its cost: at gameplay
  // camera distances it lands inside a pixel.
  float hcEdge(vec2 dir, float seed) {
    float w = (hcNoise(dir * 2.6 + seed * 19.7) - 0.5) * 1.00
            + (hcNoise(dir * 6.6 + seed * 11.3 + 41.0) - 0.5) * 0.52;
    return w * 0.66;
  }
`;

const CUT_PARS = /* glsl */ `
  #define MAX_HOLES ${MAX}
  uniform vec4  uHoles[MAX_HOLES];
  uniform vec4  uHoleTint[MAX_HOLES];
  uniform int   uHoleCount;
  uniform vec3  uRimColor;
  uniform float uTime;
  varying vec3  vHoleWorldPos;
  ${HOLE_EDGE_GLSL}
`;

const CUT_VERTEX = /* glsl */ `
  vHoleWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;

const CUT_FRAGMENT = /* glsl */ `
  {
    float rim = 0.0;      // tight contact shadow hugging the tear
    float halo = 0.0;     // wide owner-coloured bleed, so rivals read at a glance
    vec3  haloCol = vec3(1.0);

    for (int i = 0; i < MAX_HOLES; i++) {
      if (i >= uHoleCount) break;
      vec4 h = uHoles[i];
      if (h.w < 0.5) continue;

      vec2 d = vHoleWorldPos.xz - h.xy;
      float dist = length(d);
      float r = h.z;
      // Cheap reject BEFORE the noise taps: the tear can never exceed 1.05r and
      // the widest halo lobe dies by r*1.34 + 0.85, so anything past this is
      // provably unaffected. Most ground pixels in a city-wide frame are
      // nowhere near any hole, and skipping their noise taps is what pays for
      // the multi-octave edge in the first place.
      if (dist > r * 1.45 + 1.2) continue;

      vec2 dir = d / max(dist, 1e-4);
      float edge = r * (1.0 + ${EDGE_AMP.toFixed(4)} * hcEdge(dir, uHoleTint[i].w));

      if (dist < edge) discard;

      float t = dist - edge;
      // Two-lobe occlusion: a near-black core in the first few centimetres so
      // the lip reads as a hard cut, then a soft ambient falloff.
      float core = 1.0 - smoothstep(0.0, max(0.20, r * 0.085), t);
      float soft = 1.0 - smoothstep(0.0, max(0.85, r * 0.34), t);
      rim = max(rim, max(core, soft * 0.52));

      float g = soft * soft;
      if (g > halo) { halo = g; haloCol = uHoleTint[i].rgb; }
    }

    if (rim > 0.0) {
      // Owner colour first, contact shadow on top: the darkest band must always
      // win at the very edge or the hole stops being the darkest thing around.
      diffuseColor.rgb = mix(diffuseColor.rgb, haloCol * 0.5, halo * 0.22);
      diffuseColor.rgb = mix(diffuseColor.rgb, uRimColor, pow(rim, 1.35) * 0.96);
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
    shader.uniforms.uHoleTint = holeUniforms.uHoleTint;
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
  material.customProgramCacheKey = () => 'holecut-v4';
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
