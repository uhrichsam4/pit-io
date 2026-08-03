/**
 * Buildings: towers, midrises, storefronts, garages, construction sites and
 * landmarks. BASELINE IMPLEMENTATION — expected to be replaced with a AAA version.
 */

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { TIER, PALETTE } from '../config.js';
import { makeRNG } from '../core/rng.js';
import { Textures, solid, glass } from '../core/materials.js';
import { ZONE } from './cityLayout.js';

const GLASS_TINTS = [PALETTE.GLASS_TEAL, PALETTE.GLASS_BLUE, PALETTE.GLASS_MINT, 0x9fd8f0, 0x7fe0d0];
const STUCCO_TINTS = [
  PALETTE.STUCCO_PINK, PALETTE.STUCCO_CORAL, PALETTE.STUCCO_CREAM,
  PALETTE.STUCCO_LILAC, PALETTE.STUCCO_AQUA, 0xffe0a8, 0xbfe8ff,
];

function boxWithUV(w, h, d, uScale = 1, vScale = 1) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  // faces: +x, -x, +y, -y, +z, -z (4 verts each)
  const spans = [
    [d, h], [d, h], [w, d], [w, d], [w, h], [w, h],
  ];
  for (let f = 0; f < 6; f++) {
    const [su, sv] = spans[f];
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, uv.getX(k) * (su / uScale), uv.getY(k) * (sv / vScale));
    }
  }
  uv.needsUpdate = true;
  return g;
}

export function buildBuildings(ctx) {
  const { layout, Y_WALK } = ctx;
  const group = ctx.group('buildings');

  for (const b of layout.blocks) {
    const r = makeRNG(b.seed ^ 0x9e37);
    switch (b.zone) {
      case ZONE.TOWER: tower(ctx, group, b, r, false); break;
      case ZONE.LANDMARK: tower(ctx, group, b, r, true); break;
      case ZONE.MIDRISE: midrise(ctx, group, b, r); break;
      case ZONE.RETAIL:
      case ZONE.LOWRISE: retailRow(ctx, group, b, r); break;
      case ZONE.PARKING: garage(ctx, group, b, r); break;
      case ZONE.CONSTRUCTION: construction(ctx, group, b, r); break;
      default: break; // parks/plazas/marina handled elsewhere
    }
  }
}

function footprint(b, r, fill = 0.78) {
  const w = b.w * (fill + r() * 0.12);
  const d = b.d * (fill + r() * 0.12);
  return { w: Math.max(10, w), d: Math.max(10, d) };
}

function tower(ctx, group, b, r, isLandmark) {
  const { w, d } = footprint(b, r, isLandmark ? 0.82 : 0.70);
  const baseH = isLandmark ? 120 + r() * 90 : 55 + r() * 105;
  const tint = r.pick(GLASS_TINTS);
  const floors = Math.max(8, Math.round(baseH / 3.5));

  const mat = glass({
    map: Textures.glass(tint, 24, 14),
    roughness: 0.10, metalness: 0.62, color: 0xffffff,
  });

  const g = new THREE.Group();
  g.position.set(b.x, ctx.Y_WALK, b.z);

  // podium
  const podH = 8 + r() * 8;
  const pod = new THREE.Mesh(
    boxWithUV(w * 1.06, podH, d * 1.06, 9, 4.2),
    solid({ map: Textures.concrete(512, '#efe9dc'), roughness: 0.9 })
  );
  pod.position.y = podH / 2;
  pod.castShadow = true; pod.receiveShadow = true;
  g.add(pod);

  // stacked setbacks
  let y = podH, cw = w, cd = d;
  const tiers = 1 + (r() < 0.55 ? 1 : 0) + (isLandmark ? 1 : 0);
  for (let i = 0; i < tiers; i++) {
    const h = (baseH - podH) * (i === tiers - 1 ? 1 : 0.55 / tiers + 0.25);
    const m = new THREE.Mesh(boxWithUV(cw, h, cd, 9, 3.6), mat);
    m.position.y = y + h / 2;
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);
    y += h;
    cw *= 0.78 + r() * 0.1; cd *= 0.78 + r() * 0.1;
  }

  // crown
  const crown = new THREE.Mesh(
    new THREE.BoxGeometry(cw * 0.5, 6 + r() * 10, cd * 0.5),
    solid({ color: 0xe8eef2, roughness: 0.4, metalness: 0.3 })
  );
  crown.position.y = y + 4;
  crown.castShadow = true;
  g.add(crown);

  ctx.addMesh(g, {
    parent: group,
    position: new THREE.Vector3(b.x, 0, b.z),
    radius: Math.max(w, d) * 0.5,
    height: baseH,
    tier: isLandmark ? TIER.LANDMARK : TIER.MASSIVE,
    kind: 'tower',
    label: b.landmark || (isLandmark ? 'Landmark Tower' : 'Glass Tower'),
    crumbles: true,
    debrisColor: tint,
  });
  ctx.occupy(b.x, b.z, Math.max(w, d) * 0.5);
}

function midrise(ctx, group, b, r) {
  const { w, d } = footprint(b, r, 0.80);
  const h = 20 + r() * 34;
  const tint = r.pick(STUCCO_TINTS);
  const floors = Math.max(4, Math.round(h / 3.4));
  const m = new THREE.Mesh(
    boxWithUV(w, h, d, 9, 3.4),
    solid({ map: Textures.stucco(tint, 10, 7), roughness: 0.72 })
  );
  const g = new THREE.Group();
  g.position.set(b.x, ctx.Y_WALK, b.z);
  m.position.y = h / 2;
  m.castShadow = true; m.receiveShadow = true;
  g.add(m);

  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(w * 1.02, 0.8, d * 1.02),
    solid({ color: PALETTE.ROOF, roughness: 0.9 })
  );
  roof.position.y = h + 0.4;
  roof.castShadow = true;
  g.add(roof);

  ctx.addMesh(g, {
    parent: group,
    position: new THREE.Vector3(b.x, 0, b.z),
    radius: Math.max(w, d) * 0.5,
    height: h,
    tier: TIER.MASSIVE,
    kind: 'midrise',
    label: 'Apartment Block',
    crumbles: true,
    debrisColor: tint,
  });
  ctx.occupy(b.x, b.z, Math.max(w, d) * 0.5);
}

function retailRow(ctx, group, b, r) {
  // Split the block into a row of individual shops so a mid-size hole can eat
  // them one at a time.
  const along = b.w >= b.d ? 'x' : 'z';
  const len = along === 'x' ? b.w : b.d;
  const depth = (along === 'x' ? b.d : b.w) * 0.62;
  const n = Math.max(2, Math.floor(len / 16));
  const unit = (len * 0.9) / n;

  for (let i = 0; i < n; i++) {
    const t = -len * 0.45 + unit * (i + 0.5);
    const x = along === 'x' ? b.x + t : b.x;
    const z = along === 'x' ? b.z : b.z + t;
    const h = 6 + r() * 7;
    const tint = r.pick(STUCCO_TINTS);
    const w = along === 'x' ? unit * 0.94 : depth;
    const d = along === 'x' ? depth : unit * 0.94;

    const g = new THREE.Group();
    g.position.set(x, ctx.Y_WALK, z);
    const m = new THREE.Mesh(
      boxWithUV(w, h, d, 8, 8),
      solid({ map: Textures.storefront(tint), roughness: 0.66 })
    );
    m.position.y = h / 2;
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);

    const awn = new THREE.Mesh(
      new THREE.BoxGeometry(w * 0.9, 0.25, 1.8),
      solid({ color: r.pick([0xff6b8a, 0x3ecfb2, 0xffc93c, 0x6aa9ff]), roughness: 0.6 })
    );
    awn.position.set(0, 3.4, (along === 'x' ? d : w) * 0.5 + 0.8);
    awn.castShadow = true;
    g.add(awn);

    ctx.addMesh(g, {
      parent: group,
      position: new THREE.Vector3(x, 0, z),
      radius: Math.max(w, d) * 0.5,
      height: h,
      tier: TIER.HUGE,
      kind: 'storefront',
      label: 'Storefront',
      crumbles: true,
      debrisColor: tint,
    });
    ctx.occupy(x, z, Math.max(w, d) * 0.5);
  }
}

function garage(ctx, group, b, r) {
  const { w, d } = footprint(b, r, 0.80);
  const levels = 3 + Math.floor(r() * 4);
  const lh = 3.2;
  const g = new THREE.Group();
  g.position.set(b.x, ctx.Y_WALK, b.z);
  const mat = solid({ map: Textures.concrete(512, '#e4dfd2'), roughness: 0.94 });

  const geos = [];
  for (let i = 0; i < levels; i++) {
    const slab = new THREE.BoxGeometry(w, 0.45, d);
    slab.translate(0, i * lh, 0);
    geos.push(slab);
    // perimeter spandrel
    for (const [ox, oz, bw, bd] of [
      [0, -d / 2, w, 0.5], [0, d / 2, w, 0.5],
      [-w / 2, 0, 0.5, d], [w / 2, 0, 0.5, d],
    ]) {
      const s = new THREE.BoxGeometry(bw, 1.0, bd);
      s.translate(ox, i * lh + 0.9, oz);
      geos.push(s);
    }
  }
  const m = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(geos, false), mat);
  m.castShadow = true; m.receiveShadow = true;
  g.add(m);

  ctx.addMesh(g, {
    parent: group,
    position: new THREE.Vector3(b.x, 0, b.z),
    radius: Math.max(w, d) * 0.5,
    height: levels * lh,
    tier: TIER.MASSIVE,
    kind: 'garage',
    label: 'Parking Garage',
    crumbles: true,
    debrisColor: 0xe4dfd2,
  });
  ctx.occupy(b.x, b.z, Math.max(w, d) * 0.5);
}

function construction(ctx, group, b, r) {
  const { w, d } = footprint(b, r, 0.72);
  const h = 14 + r() * 40;
  const g = new THREE.Group();
  g.position.set(b.x, ctx.Y_WALK, b.z);

  // concrete core + exposed slabs
  const core = new THREE.Mesh(
    new THREE.BoxGeometry(w * 0.34, h, d * 0.34),
    solid({ color: 0xd9d3c6, roughness: 0.95 })
  );
  core.position.y = h / 2;
  core.castShadow = true;
  g.add(core);

  const floors = Math.max(2, Math.round(h / 3.6));
  const geos = [];
  for (let i = 1; i <= floors; i++) {
    const s = new THREE.BoxGeometry(w, 0.35, d);
    s.translate(0, i * 3.6, 0);
    geos.push(s);
  }
  const slabs = new THREE.Mesh(
    BufferGeometryUtils.mergeGeometries(geos, false),
    solid({ color: 0xcfc9bb, roughness: 0.95 })
  );
  slabs.castShadow = true; slabs.receiveShadow = true;
  g.add(slabs);

  ctx.addMesh(g, {
    parent: group,
    position: new THREE.Vector3(b.x, 0, b.z),
    radius: Math.max(w, d) * 0.5,
    height: h,
    tier: TIER.MASSIVE,
    kind: 'construction',
    label: 'Construction Site',
    crumbles: true,
    debrisColor: 0xd9d3c6,
  });
  ctx.occupy(b.x, b.z, Math.max(w, d) * 0.5);
}
