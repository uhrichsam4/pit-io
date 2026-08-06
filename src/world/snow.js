/**
 * SNOW BIOME — a post-build pass over a finished city.
 *
 * WHY A PASS AND NOT A PARAMETER. The obvious way to make a snow map is to
 * thread a biome through the eight world modules and swap PALETTE. PALETTE is
 * referenced 198 times in nature.js alone and an unknown number of those are
 * captured at module-init, so mutating it produces a city that is half snowy
 * and half not, in ways that only show up on inspection. Rewriting all eight
 * modules to take a biome is the right long-term answer and is not a two-hour
 * job.
 *
 * This instead walks the finished scene once and re-dresses it. Every material
 * in this project is NAMED (see materials.js `cached()`), so the pass can be
 * precise about what it touches: asphalt goes near-black and wet, sidewalks and
 * ground go white, foliage goes frosted, windows go warm. Then it adds the two
 * things snow actually is — caps on every roof, and drifts along the kerbs.
 *
 * It runs ONLY when the snow map is selected, so Miami cannot be affected: the
 * material cache is per-page-load and switching maps reloads.
 */

import * as THREE from 'three';
import { solid } from '../core/materials.js';

/** Recolour rules, matched against material.name. First match wins. */
const TINT = [
  // Roads are PLOWED: wet near-black asphalt, not white. This is the single
  // strongest cue that a white city is snowbound rather than just pale.
  [/asphalt|road|streets-lane|buslane|bridge-deck/i, 0x2b2f36, { rough: 0.42, metal: 0.10 }],
  [/streets-white|streets-yellow/i, 0xd8d4c8, { rough: 0.7 }],
  // Everything walkable is under snow.
  [/sidewalk|paving|plaza|kerb|curb|streets-base|ground|lawn|grass|park/i, 0xeaf1f6, { rough: 0.94 }],
  [/sand|beach/i, 0xe4ecf2, { rough: 0.92 }],
  // Water freezes at the edges and goes steel.
  [/water|bay|river|canal/i, 0x51707f, { rough: 0.22, metal: 0.42 }],
  [/seawall|quay|dock|marina|pier/i, 0xc9d2d8, { rough: 0.88 }],
  // Foliage keeps its shape but loses its colour under frost.
  [/foliage|leaf|canopy|palm|tree|hedge|shrub|nature/i, 0x8fae9a, { rough: 0.9 }],
  // Buildings cool off; the warm windows are added separately below.
  [/stucco|facade|wall|building|midrise|tower/i, 0xb9c3cc, { rough: 0.82 }],
  [/roof/i, 0xdfe8ee, { rough: 0.9 }],
];

/** Windows glow warm against a cold city — the whole mood of the map. */
const WINDOW = /window|glass|glazing|pane/i;

function retint(mat, seen) {
  if (!mat || seen.has(mat)) return;
  seen.add(mat);
  const name = mat.name || '';
  if (!name) return;

  if (WINDOW.test(name)) {
    // Not every window is lit; a fully lit block looks like a stadium.
    if (mat.emissive) {
      mat.emissive.setHex(0xffb867);
      mat.emissiveIntensity = 0.55;
    }
    if (mat.color) mat.color.setHex(0x9fb6c4);
    mat.needsUpdate = true;
    return;
  }

  for (const [re, hex, opt] of TINT) {
    if (!re.test(name)) continue;
    if (mat.color) {
      // Multiply toward the target rather than replacing, so per-instance
      // vertex colour variation survives instead of flattening to one shade.
      const t = new THREE.Color(hex);
      mat.color.lerp(t, 0.82);
    }
    if (opt && typeof opt.rough === 'number' && 'roughness' in mat) mat.roughness = opt.rough;
    if (opt && typeof opt.metal === 'number' && 'metalness' in mat) mat.metalness = opt.metal;
    mat.needsUpdate = true;
    return;
  }
}

/**
 * Snow caps on roofs and drifts along the kerbs.
 *
 * One merged mesh for the whole city. Individually these would be several
 * hundred draw calls for decoration that never moves and is never eaten.
 */
function accumulate(scene, rng) {
  const pos = [];
  const nor = [];
  const col = [];
  const idx = [];
  const white = new THREE.Color(0xf4f9fc);
  const grey = new THREE.Color(0xd8e3ea);

  const quad = (a, b, c, d, shade) => {
    const base = pos.length / 3;
    const cc = shade ? grey : white;
    for (const v of [a, b, c, d]) {
      pos.push(v[0], v[1], v[2]);
      nor.push(0, 1, 0);
      col.push(cc.r, cc.g, cc.b);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  /* Roof caps. Every building gets a slab of snow on its top face, inset a
     little so it reads as settled rather than as a lid. */
  const box = new THREE.Box3();
  const groups = ['buildings', 'structures'];
  let roofs = 0;
  for (const gname of groups) {
    const g = scene.getObjectByName(gname);
    if (!g) continue;
    for (const o of g.children) {
      box.setFromObject(o);
      if (!Number.isFinite(box.min.x)) continue;
      const w = box.max.x - box.min.x, d = box.max.z - box.min.z;
      if (w < 3 || d < 3 || w > 120 || d > 120) continue;
      const inset = Math.min(0.9, Math.min(w, d) * 0.06);
      const y = box.max.y + 0.06;
      quad(
        [box.min.x + inset, y, box.min.z + inset],
        [box.max.x - inset, y, box.min.z + inset],
        [box.max.x - inset, y, box.max.z - inset],
        [box.min.x + inset, y, box.max.z - inset],
        false
      );
      roofs++;
    }
  }

  /* Kerbside drifts. Where a plow has been, snow ends up in a low ridge along
     the edge of the road — the detail that makes a plowed road read as plowed
     rather than just dark. Sampled off the street network's own geometry. */
  let drifts = 0;
  const streets = scene.getObjectByName('streets');
  if (streets) {
    streets.traverse((o) => {
      if (!o.isMesh || !o.geometry || drifts > 900) return;
      const n = (o.material && o.material.name) || '';
      if (!/sidewalk|kerb|curb|streets-base/i.test(n)) return;
      o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox;
      if (!bb) return;
      const w = bb.max.x - bb.min.x, d = bb.max.z - bb.min.z;
      if (Math.max(w, d) < 6) return;
      const along = w > d;
      const steps = Math.min(14, Math.floor(Math.max(w, d) / 7));
      for (let i = 0; i < steps; i++) {
        const t = (i + 0.5) / steps;
        const cx = along ? bb.min.x + w * t : (bb.min.x + bb.max.x) / 2;
        const cz = along ? (bb.min.z + bb.max.z) / 2 : bb.min.z + d * t;
        const p = o.localToWorld(new THREE.Vector3(cx, bb.max.y, cz));
        const hw = 0.5 + rng() * 0.5, hl = 1.6 + rng() * 2.4;
        const y = p.y + 0.10 + rng() * 0.12;
        if (along) {
          quad([p.x - hl, y, p.z - hw], [p.x + hl, y, p.z - hw],
            [p.x + hl, y, p.z + hw], [p.x - hl, y, p.z + hw], rng() < 0.3);
        } else {
          quad([p.x - hw, y, p.z - hl], [p.x + hw, y, p.z - hl],
            [p.x + hw, y, p.z + hl], [p.x - hw, y, p.z + hl], rng() < 0.3);
        }
        drifts++;
      }
    });
  }

  if (!pos.length) return { roofs, drifts };
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, solid({
    name: 'snow-accum', vertexColors: true, roughness: 0.95, metalness: 0,
  }));
  mesh.name = 'snow-accumulation';
  // Decoration: it receives light but casting from a flat slab buys nothing.
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return { roofs, drifts };
}

/**
 * Turn a finished city into a snowbound one.
 *
 * @param {THREE.Scene} scene
 * @param {() => number} rng  the world's seeded RNG, so snow is deterministic
 *   and a restart rebuilds exactly the same drifts.
 */
export function applySnow(scene, rng = Math.random) {
  const seen = new Set();
  scene.traverse((o) => {
    if (!o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) retint(m, seen);
  });

  // Cold overcast light. The sky and fog are the difference between "a white
  // city" and "a city in winter".
  if (scene.fog) {
    scene.fog.color.setHex(0xbcd0dc);
    if ('density' in scene.fog) scene.fog.density *= 1.5;
  }
  if (scene.background && scene.background.isColor) scene.background.setHex(0xc4d6e2);

  const acc = accumulate(scene, rng);
  console.info(`[snow] retinted ${seen.size} materials, ${acc.roofs} roof caps, ${acc.drifts} drifts`);
  return { materials: seen.size, ...acc };
}
