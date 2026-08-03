/**
 * Nature + public space: parks, plazas, palms, shade trees, hedges, fountains.
 * BASELINE IMPLEMENTATION — expected to be replaced with a AAA version.
 */

import * as THREE from 'three';
import { TIER, PALETTE, WORLD } from '../config.js';
import { makeRNG } from '../core/rng.js';
import { Textures, ground, solid, foliage } from '../core/materials.js';
import { ZONE } from './cityLayout.js';

function palmGeometry() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.22, 0.38, 9, 8, 4);
  // gentle S-curve
  const pos = trunk.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = (y + 4.5) / 9;
    pos.setX(i, pos.getX(i) + Math.sin(t * 2.1) * 0.55);
  }
  pos.needsUpdate = true;
  trunk.computeVertexNormals();
  trunk.translate(0, 4.5, 0);
  parts.push(trunk);
  return trunk;
}

export function buildNature(ctx) {
  const { layout } = ctx;
  const group = ctx.group('nature');

  const grassMat = ground({
    map: Textures.grass(),
    roughnessMap: Textures.roughness(256, 220, 0.2),
    roughness: 0.98,
  });
  const plazaMat = ground({
    map: Textures.paving(512, '#e8e2d4', 'rgba(160,152,138,0.45)', 5),
    roughness: 0.9,
  });

  const frondMat = foliage(Textures.frond());
  const trunkMat = solid({ color: PALETTE.PALM_TRUNK, roughness: 0.9 });

  for (const b of layout.blocks) {
    const r = makeRNG(b.seed ^ 0x51ab);
    if (b.zone === ZONE.PARK) {
      const g = new THREE.Mesh(
        new THREE.PlaneGeometry(b.w * 0.98, b.d * 0.98).rotateX(-Math.PI / 2),
        grassMat
      );
      const uv = g.geometry.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * b.w / 8, uv.getY(i) * b.d / 8);
      g.position.set(b.x, ctx.Y_WALK + 0.02, b.z);
      g.receiveShadow = true;
      ctx.addDecor(g, 'nature');
      scatterPalms(ctx, b, r, trunkMat, frondMat, 7);
    } else if (b.zone === ZONE.PLAZA) {
      const g = new THREE.Mesh(
        new THREE.PlaneGeometry(b.w * 0.98, b.d * 0.98).rotateX(-Math.PI / 2),
        plazaMat
      );
      const uv = g.geometry.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * b.w / 6, uv.getY(i) * b.d / 6);
      g.position.set(b.x, ctx.Y_WALK + 0.02, b.z);
      g.receiveShadow = true;
      ctx.addDecor(g, 'nature');
      scatterPalms(ctx, b, r, trunkMat, frondMat, 4);
    } else {
      // street palms along the block edge
      scatterPalms(ctx, b, r, trunkMat, frondMat, 3, true);
    }
  }
}

function scatterPalms(ctx, b, r, trunkMat, frondMat, count, edgeOnly = false) {
  for (let i = 0; i < count; i++) {
    let x, z;
    if (edgeOnly) {
      const side = r.int(0, 3);
      const t = 0.15 + r() * 0.7;
      if (side === 0) { x = b.x - b.w / 2 + b.w * t; z = b.z - b.d / 2 + 2.2; }
      else if (side === 1) { x = b.x - b.w / 2 + b.w * t; z = b.z + b.d / 2 - 2.2; }
      else if (side === 2) { x = b.x - b.w / 2 + 2.2; z = b.z - b.d / 2 + b.d * t; }
      else { x = b.x + b.w / 2 - 2.2; z = b.z - b.d / 2 + b.d * t; }
    } else {
      x = b.x + (r() - 0.5) * b.w * 0.82;
      z = b.z + (r() - 0.5) * b.d * 0.82;
    }
    if (!ctx.isFree(x, z, 2.4)) continue;
    ctx.occupy(x, z, 2.4);

    const g = new THREE.Group();
    g.position.set(x, ctx.Y_WALK, z);
    const s = 0.82 + r() * 0.5;
    g.scale.setScalar(s);
    g.rotation.y = r() * Math.PI * 2;

    const trunk = new THREE.Mesh(palmGeometry(), trunkMat);
    trunk.castShadow = true;
    g.add(trunk);

    const nf = 7 + r.int(0, 3);
    for (let f = 0; f < nf; f++) {
      const a = (f / nf) * Math.PI * 2 + r() * 0.4;
      const card = new THREE.Mesh(new THREE.PlaneGeometry(5.4, 2.6), frondMat);
      card.position.set(Math.cos(a) * 1.9 + Math.sin(2.1) * 0.55, 9.1, Math.sin(a) * 1.9);
      card.rotation.set(-0.42 - r() * 0.3, -a + Math.PI, 0);
      card.castShadow = true;
      g.add(card);
    }

    ctx.addMesh(g, {
      group: 'nature',
      position: new THREE.Vector3(x, 0, z),
      radius: 1.5 * s,
      height: 10 * s,
      tier: TIER.LARGE,
      kind: 'palm',
      label: 'Palm Tree',
      debrisColor: PALETTE.PALM_FROND,
    });
  }
}
