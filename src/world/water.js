/**
 * Biscayne Bay + the Miami River. Animated stylised water with depth-tinted
 * shallows, drifting caustic sparkle and a foam line along the seawall.
 * BASELINE IMPLEMENTATION — expected to be replaced with a AAA version.
 */

import * as THREE from 'three';
import { WORLD, PALETTE } from '../config.js';

const VERT = /* glsl */ `
  uniform float uTime;
  varying vec2 vWorld;
  varying vec3 vNormalW;
  varying float vWave;

  void main() {
    vec3 p = position;
    vec4 wp = modelMatrix * vec4(p, 1.0);
    vWorld = wp.xz;

    float w1 = sin(wp.x * 0.055 + uTime * 0.85) * 0.30;
    float w2 = sin(wp.z * 0.078 - uTime * 1.15) * 0.22;
    float w3 = sin((wp.x + wp.z) * 0.031 + uTime * 0.55) * 0.34;
    float h = w1 + w2 + w3;
    vWave = h;
    wp.y += h;

    // analytic normal from the same three waves
    float dx = cos(wp.x * 0.055 + uTime * 0.85) * 0.055 * 0.30
             + cos((wp.x + wp.z) * 0.031 + uTime * 0.55) * 0.031 * 0.34;
    float dz = cos(wp.z * 0.078 - uTime * 1.15) * 0.078 * 0.22
             + cos((wp.x + wp.z) * 0.031 + uTime * 0.55) * 0.031 * 0.34;
    vNormalW = normalize(vec3(-dx, 1.0, -dz));

    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */ `
  uniform vec3  uDeep, uShallow, uFoam, uSunDir, uSunColor;
  uniform float uTime, uShoreX;
  varying vec2  vWorld;
  varying vec3  vNormalW;
  varying float vWave;

  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
  float noise(vec2 p){
    vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
    return mix(mix(hash(i),hash(i+vec2(1,0)),u.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y);
  }

  void main() {
    // depth proxy: distance from the seawall
    float shore = clamp((vWorld.x - uShoreX) / 150.0, 0.0, 1.0);
    vec3 col = mix(uShallow, uDeep, pow(shore, 0.75));

    // moving sparkle
    float s = noise(vWorld * 0.24 + vec2(uTime * 0.32, -uTime * 0.19));
    float s2 = noise(vWorld * 0.62 - vec2(uTime * 0.5, uTime * 0.3));
    float glint = smoothstep(0.72, 0.98, s * 0.65 + s2 * 0.5);
    col += vec3(1.0, 0.99, 0.94) * glint * 0.35;

    // sun specular off the analytic normal
    vec3 V = normalize(cameraPosition - vec3(vWorld.x, 0.0, vWorld.y));
    vec3 H = normalize(normalize(uSunDir) + V);
    float spec = pow(max(dot(vNormalW, H), 0.0), 90.0);
    col += uSunColor * spec * 1.5;

    // fresnel sky tint at grazing angles
    float fres = pow(1.0 - max(dot(vNormalW, V), 0.0), 3.0);
    col = mix(col, vec3(0.72, 0.90, 0.99), fres * 0.45);

    // wave crest foam
    col = mix(col, uFoam, smoothstep(0.55, 0.86, vWave) * 0.5);

    // shoreline foam band
    float band = 1.0 - smoothstep(0.0, 7.0, vWorld.x - uShoreX);
    float wig = noise(vec2(vWorld.y * 0.35, uTime * 0.7)) * 2.6;
    band = 1.0 - smoothstep(0.0, 7.0 + wig, vWorld.x - uShoreX);
    col = mix(col, uFoam, clamp(band, 0.0, 1.0) * 0.75);

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function buildWater(ctx) {
  const { scene, layout } = ctx;
  const g = ctx.group('water');

  const uniforms = {
    uTime: { value: 0 },
    uDeep: { value: new THREE.Color(PALETTE.SEA_DEEP) },
    uShallow: { value: new THREE.Color(PALETTE.SEA_SHALLOW) },
    uFoam: { value: new THREE.Color(PALETTE.SEA_FOAM) },
    uFoamColor: { value: new THREE.Color(PALETTE.SEA_FOAM) },
    uSunDir: { value: new THREE.Vector3(0.42, 0.62, -0.66).normalize() },
    uSunColor: { value: new THREE.Color(0xfff3dd) },
    uShoreX: { value: WORLD.BAY_EDGE },
  };
  const mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms });

  // Bay
  const bayW = 1500;
  const bay = new THREE.Mesh(
    new THREE.PlaneGeometry(bayW, WORLD.SIZE * 2 + 900, 160, 200).rotateX(-Math.PI / 2),
    mat
  );
  bay.position.set(WORLD.BAY_EDGE + bayW / 2 - 4, -0.35, 0);
  bay.receiveShadow = false;
  g.add(bay);

  // River
  const river = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD.SIZE + WORLD.BAY_EDGE + 40, WORLD.RIVER_HALF_W * 2, 200, 12)
      .rotateX(-Math.PI / 2),
    mat
  );
  river.position.set((WORLD.BAY_EDGE - WORLD.SIZE) / 2, -0.35, layout.river.z);
  g.add(river);

  // Seawall along the bay edge
  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(2.0, 1.5, WORLD.SIZE * 2 + 80),
    new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.92 })
  );
  wall.position.set(WORLD.BAY_EDGE - 1, 0.35, 0);
  wall.castShadow = true;
  wall.receiveShadow = true;
  g.add(wall);

  ctx.waterUniforms = uniforms;
  scene.userData.waterUniforms = uniforms;
  return g;
}
