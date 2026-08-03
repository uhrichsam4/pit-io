/**
 * Street furniture: cones, bins, benches, planters, signs, café tables,
 * umbrellas, hydrants, bollards, newspaper boxes, streetlights.
 * BASELINE IMPLEMENTATION — expected to be replaced with a AAA version.
 */

import * as THREE from 'three';
import { TIER } from '../config.js';
import { makeRNG } from '../core/rng.js';
import { solid } from '../core/materials.js';

const DEFS = {
  cone: {
    tier: TIER.TINY, radius: 0.34, height: 0.75, cap: 2600, label: 'Traffic Cone',
    hex: 0xff6a2b,
    geo: () => {
      const c = new THREE.ConeGeometry(0.32, 0.68, 12, 1);
      c.translate(0, 0.34, 0);
      const base = new THREE.BoxGeometry(0.62, 0.06, 0.62);
      base.translate(0, 0.03, 0);
      return mergeSimple([c, base]);
    },
  },
  bin: {
    tier: TIER.SMALL, radius: 0.44, height: 1.05, cap: 1400, label: 'Trash Bin',
    hex: 0x3d7a55,
    geo: () => {
      const c = new THREE.CylinderGeometry(0.42, 0.34, 1.0, 14, 1);
      c.translate(0, 0.5, 0);
      const lid = new THREE.CylinderGeometry(0.46, 0.46, 0.09, 14, 1);
      lid.translate(0, 1.02, 0);
      return mergeSimple([c, lid]);
    },
  },
  bench: {
    tier: TIER.SMALL, radius: 0.95, height: 0.85, cap: 900, label: 'Bench',
    hex: 0xc98b52,
    geo: () => {
      const parts = [];
      const seat = new THREE.BoxGeometry(2.0, 0.11, 0.6); seat.translate(0, 0.46, 0);
      const back = new THREE.BoxGeometry(2.0, 0.52, 0.1); back.translate(0, 0.74, -0.26);
      parts.push(seat, back);
      for (const s of [-1, 1]) {
        const leg = new THREE.BoxGeometry(0.1, 0.44, 0.52);
        leg.translate(s * 0.82, 0.22, 0);
        parts.push(leg);
      }
      return mergeSimple(parts);
    },
  },
  planter: {
    tier: TIER.SMALL, radius: 0.7, height: 1.2, cap: 900, label: 'Planter',
    hex: 0xd8cfbe,
    geo: () => {
      const box = new THREE.BoxGeometry(1.3, 0.75, 1.3); box.translate(0, 0.38, 0);
      const soil = new THREE.BoxGeometry(1.1, 0.1, 1.1); soil.translate(0, 0.78, 0);
      const bush = new THREE.SphereGeometry(0.52, 10, 8); bush.translate(0, 1.05, 0);
      return mergeSimple([box, soil, bush]);
    },
  },
  hydrant: {
    tier: TIER.TINY, radius: 0.24, height: 0.8, cap: 500, label: 'Hydrant',
    hex: 0xe23b3b,
    geo: () => {
      const b = new THREE.CylinderGeometry(0.2, 0.24, 0.66, 10); b.translate(0, 0.33, 0);
      const cap = new THREE.SphereGeometry(0.2, 10, 7); cap.translate(0, 0.68, 0);
      return mergeSimple([b, cap]);
    },
  },
  bollard: {
    tier: TIER.TINY, radius: 0.16, height: 0.9, cap: 1200, label: 'Bollard',
    hex: 0x39404d,
    geo: () => {
      const b = new THREE.CylinderGeometry(0.13, 0.15, 0.86, 10); b.translate(0, 0.43, 0);
      return b;
    },
  },
  table: {
    tier: TIER.SMALL, radius: 0.62, height: 0.78, cap: 800, label: 'Café Table',
    hex: 0xf2ede2,
    geo: () => {
      const top = new THREE.CylinderGeometry(0.55, 0.55, 0.06, 16); top.translate(0, 0.74, 0);
      const stem = new THREE.CylinderGeometry(0.06, 0.06, 0.72, 8); stem.translate(0, 0.36, 0);
      const foot = new THREE.CylinderGeometry(0.3, 0.32, 0.05, 12); foot.translate(0, 0.03, 0);
      return mergeSimple([top, stem, foot]);
    },
  },
  umbrella: {
    tier: TIER.MEDIUM, radius: 1.15, height: 2.4, cap: 500, label: 'Patio Umbrella',
    hex: 0xff8fa8,
    geo: () => {
      const pole = new THREE.CylinderGeometry(0.05, 0.05, 2.3, 8); pole.translate(0, 1.15, 0);
      const top = new THREE.ConeGeometry(1.15, 0.55, 12, 1); top.translate(0, 2.25, 0);
      return mergeSimple([pole, top]);
    },
  },
  sign: {
    tier: TIER.SMALL, radius: 0.3, height: 2.6, cap: 900, label: 'Street Sign',
    hex: 0x8d949e,
    geo: () => {
      const pole = new THREE.CylinderGeometry(0.055, 0.055, 2.5, 8); pole.translate(0, 1.25, 0);
      const plate = new THREE.BoxGeometry(0.9, 0.28, 0.05); plate.translate(0, 2.3, 0);
      return mergeSimple([pole, plate]);
    },
  },
  streetlight: {
    tier: TIER.MEDIUM, radius: 0.4, height: 7.2, cap: 1400, label: 'Streetlight',
    hex: 0x9aa3ad, castShadow: true,
    geo: () => {
      const pole = new THREE.CylinderGeometry(0.11, 0.16, 7.0, 10); pole.translate(0, 3.5, 0);
      const arm = new THREE.BoxGeometry(1.7, 0.12, 0.12); arm.translate(0.8, 7.0, 0);
      const head = new THREE.BoxGeometry(0.7, 0.16, 0.32); head.translate(1.55, 6.9, 0);
      return mergeSimple([pole, arm, head]);
    },
  },
};

function mergeSimple(geos) {
  // Lightweight merge without the utils import: all inputs are non-indexed-safe
  // BufferGeometries with matching attributes.
  const merged = [];
  let vCount = 0;
  const posArrays = [], normArrays = [], uvArrays = [], indexArrays = [];
  for (const g of geos) {
    const ng = g.index ? g.toNonIndexed() : g;
    posArrays.push(ng.attributes.position.array);
    normArrays.push(ng.attributes.normal.array);
    uvArrays.push(ng.attributes.uv ? ng.attributes.uv.array : new Float32Array(ng.attributes.position.count * 2));
    vCount += ng.attributes.position.count;
    if (ng !== g) g.dispose();
  }
  const pos = new Float32Array(vCount * 3);
  const norm = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  let o3 = 0, o2 = 0;
  for (let i = 0; i < posArrays.length; i++) {
    pos.set(posArrays[i], o3);
    norm.set(normArrays[i], o3);
    uv.set(uvArrays[i], o2);
    o3 += posArrays[i].length;
    o2 += uvArrays[i].length;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}

export function buildProps(ctx) {
  const { layout } = ctx;
  const factories = {};
  for (const key of Object.keys(DEFS)) {
    const def = DEFS[key];
    factories[key] = () => ({
      geometry: def.geo(),
      material: solid({ color: 0xffffff, roughness: 0.62, metalness: 0.04 }),
    });
  }

  const place = (key, x, z, rotY, rng, scale = 1) => {
    const def = DEFS[key];
    if (!ctx.isFree(x, z, def.radius + 0.3)) return null;
    ctx.occupy(x, z, def.radius + 0.3);
    return ctx.addInstanced(key, factories[key], {
      position: new THREE.Vector3(x, ctx.Y_WALK, z),
      rotationY: rotY,
      scale,
      hex: def.hex,
      tier: def.tier,
      radius: def.radius * scale,
      height: def.height * scale,
      label: def.label,
      kind: key,
      capacity: def.cap,
      castShadow: true,
    });
  };

  for (const b of layout.blocks) {
    const r = makeRNG(b.seed ^ 0x2b7d);
    const perim = 2 * (b.w + b.d);
    const n = Math.round(perim / 7);

    for (let i = 0; i < n; i++) {
      const t = r();
      const p = perimeterPoint(b, r(), 2.0);
      const key = r.weighted([
        ['cone', 10], ['bin', 8], ['bench', 8], ['planter', 9],
        ['hydrant', 4], ['bollard', 9], ['sign', 7], ['streetlight', 6],
        ['table', 6], ['umbrella', 3],
      ]);
      place(key, p.x, p.z, r() * Math.PI * 2, r);
    }

    // café clusters
    if (r.chance(0.35)) {
      const cx = b.x + (r() - 0.5) * b.w * 0.5;
      const cz = b.z + (r() - 0.5) * b.d * 0.5;
      for (let i = 0; i < 5; i++) {
        place('table', cx + (r() - 0.5) * 6, cz + (r() - 0.5) * 6, r() * 6.28, r);
      }
      place('umbrella', cx, cz, r() * 6.28, r);
    }
  }
}

function perimeterPoint(b, t, inset) {
  const w = b.w - inset * 2, d = b.d - inset * 2;
  const per = 2 * (w + d);
  let u = t * per;
  if (u < w) return { x: b.x - w / 2 + u, z: b.z - d / 2 };
  u -= w;
  if (u < d) return { x: b.x + w / 2, z: b.z - d / 2 + u };
  u -= d;
  if (u < w) return { x: b.x + w / 2 - u, z: b.z + d / 2 };
  u -= w;
  return { x: b.x - w / 2, z: b.z + d / 2 - u };
}
