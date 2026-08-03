/**
 * Streets: the ground plane, roadways, sidewalks, curbs, lane markings and
 * crosswalks. Everything here is hole-cuttable and merged aggressively —
 * the entire road network is a handful of draw calls.
 */

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { WORLD, PALETTE } from '../config.js';
import { Textures, ground } from '../core/materials.js';
import { ROAD_CLASS } from './cityLayout.js';

const Y_BASE = -0.03;
const Y_ROAD = 0.0;
const Y_MARK = 0.022;
export const Y_WALK = 0.155;

function plane(w, d, x, z, y) {
  const g = new THREE.PlaneGeometry(w, d, 1, 1);
  g.rotateX(-Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

/** UV-scaled plane so tiled textures keep a constant world-space density. */
function tiledPlane(w, d, x, z, y, unitsPerTile) {
  const g = plane(w, d, x, z, y);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * (w / unitsPerTile), uv.getY(i) * (d / unitsPerTile));
  }
  uv.needsUpdate = true;
  return g;
}

/**
 * A quad strip running along +x whose z limits vary per column.
 *
 * The river centreline bends, so the land either side of it cannot be a
 * rectangle. Emitting one rectangle per column would step the bank line by up
 * to a metre every column; a strip shares the vertices between columns, so the
 * bank follows the bend exactly. UVs are world-space, which also means two
 * strips butted together tile continuously with no seam.
 *
 * @param {number[]} xs        ascending column positions
 * @param {(x:number)=>number} loAt  z of the -z edge at that column
 * @param {(x:number)=>number} hiAt  z of the +z edge at that column
 */
function xStrip(xs, loAt, hiAt, y, unitsPerTile) {
  const pos = [];
  const uv = [];
  const idx = [];
  const k = 1 / unitsPerTile;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    const lo = loAt(x);
    const hi = hiAt(x);
    pos.push(x, y, lo, x, y, hi);
    uv.push(x * k, lo * k, x * k, hi * k);
  }
  for (let i = 0; i < xs.length - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    // Winding chosen so the face normal comes out +Y (see computeVertexNormals).
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * The river channel, as the ground modules need it.
 *
 * cityLayout owns the bent centreline; this is the shared reader so the ground
 * cut, the lane markings and water.js all agree on where the water is. Falling
 * back to the straight band keeps this working if a future layout drops the
 * bend helpers.
 */
export function riverChannel(layout) {
  const r = (layout && layout.river) || {};
  const centerAt = typeof r.centerAt === 'function' ? r.centerAt : () => WORLD.RIVER_Z;
  const halfAt = typeof r.halfAt === 'function' ? r.halfAt : () => WORLD.RIVER_HALF_W;
  return {
    centerAt,
    halfAt,
    /** -z bank at x. */
    top: (x) => centerAt(x) - halfAt(x),
    /** +z bank at x. */
    bot: (x) => centerAt(x) + halfAt(x),
    /** Widest cut over [x0,x1] — used to keep a road out of the water. */
    spanOver(x0, x1) {
      let top = Infinity, bot = -Infinity;
      for (let i = 0; i <= 8; i++) {
        const x = x0 + ((x1 - x0) * i) / 8;
        top = Math.min(top, centerAt(x) - halfAt(x));
        bot = Math.max(bot, centerAt(x) + halfAt(x));
      }
      return { top, bot };
    },
  };
}

export function buildStreets(ctx) {
  const { scene, layout } = ctx;
  const S = WORLD.SIZE;
  const group = new THREE.Group();
  group.name = 'streets';
  scene.add(group);

  /* ------------------------------------------------------------- base --- */
  const baseGeo = tiledPlane(
    (S + WORLD.BAY_EDGE) + 60, S * 2 + 60,
    (WORLD.BAY_EDGE - S) / 2, 0, Y_BASE, 12
  );
  const baseMat = ground({
    map: Textures.asphalt(),
    roughnessMap: Textures.roughness(256, 205, 0.20),
    color: 0x8d8b84,
    roughness: 1.0,
  });
  const base = new THREE.Mesh(baseGeo, baseMat);
  base.receiveShadow = true;
  base.name = 'ground-base';
  group.add(base);

  /* ------------------------------------------------------------ roads --- */
  const roadGeos = [];
  for (const r of layout.roadsX) {
    roadGeos.push(tiledPlane(r.half * 2, S * 2 + 40, r.pos, 0, Y_ROAD, 10));
  }
  for (const r of layout.roadsZ) {
    roadGeos.push(tiledPlane(S + WORLD.BAY_EDGE + 40, r.half * 2, (WORLD.BAY_EDGE - S) / 2, r.pos, Y_ROAD + 0.004, 10));
  }
  const roadMat = ground({
    map: Textures.asphalt(),
    roughnessMap: Textures.roughness(256, 200, 0.22),
    color: 0xffffff,
    roughness: 1.0,
  });
  const roads = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(roadGeos, false), roadMat);
  roads.receiveShadow = true;
  roads.name = 'roads';
  group.add(roads);

  /* --------------------------------------------------------- markings --- */
  const markGeos = [];
  const dash = (x, z, w, d) => markGeos.push(plane(w, d, x, z, Y_MARK));

  for (const r of layout.roadsX) {
    const lanes = r.cls === ROAD_CLASS.STREET ? 1 : 2;
    // centre line(s)
    for (let li = 0; li < lanes; li++) {
      const off = lanes === 1 ? 0 : (li === 0 ? -0.7 : 0.7);
      for (let z = -S; z < S; z += 9) {
        if (layout.isWater(r.pos, z + 2.5)) continue;
        let onCross = false;
        for (const rz of layout.roadsZ) if (Math.abs(z - rz.pos) < rz.half + 3) { onCross = true; break; }
        if (onCross) continue;
        dash(r.pos + off, z, 0.34, 4.6);
      }
    }
    // edge lines
    for (const s of [-1, 1]) {
      const x = r.pos + s * (r.half - 0.85);
      markGeos.push(plane(0.24, S * 2, x, 0, Y_MARK));
    }
  }
  for (const r of layout.roadsZ) {
    const lanes = r.cls === ROAD_CLASS.STREET ? 1 : 2;
    for (let li = 0; li < lanes; li++) {
      const off = lanes === 1 ? 0 : (li === 0 ? -0.7 : 0.7);
      for (let x = -S; x < WORLD.BAY_EDGE; x += 9) {
        let onCross = false;
        for (const rx of layout.roadsX) if (Math.abs(x - rx.pos) < rx.half + 3) { onCross = true; break; }
        if (onCross) continue;
        dash(x, r.pos + off, 4.6, 0.34);
      }
    }
    for (const s of [-1, 1]) {
      const z = r.pos + s * (r.half - 0.85);
      markGeos.push(plane(S + WORLD.BAY_EDGE, 0.24, (WORLD.BAY_EDGE - S) / 2, z, Y_MARK));
    }
  }

  // Zebra crossings on every intersection approach.
  for (const rx of layout.roadsX) {
    for (const rz of layout.roadsZ) {
      if (layout.isWater(rx.pos, rz.pos)) continue;
      const stripes = 6;
      for (const s of [-1, 1]) {
        for (let i = 0; i < stripes; i++) {
          const t = (i + 0.5) / stripes;
          const x = rx.pos - rx.half + t * rx.half * 2;
          markGeos.push(plane(rx.half * 2 / stripes * 0.55, 3.4, x, rz.pos + s * (rz.half + 2.2), Y_MARK));
        }
        for (let i = 0; i < stripes; i++) {
          const t = (i + 0.5) / stripes;
          const z = rz.pos - rz.half + t * rz.half * 2;
          markGeos.push(plane(3.4, rz.half * 2 / stripes * 0.55, rx.pos + s * (rx.half + 2.2), z, Y_MARK));
        }
      }
    }
  }

  const markMat = ground({ color: 0xf3f0e4, roughness: 0.72, metalness: 0.0 });
  const marks = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(markGeos, false), markMat);
  marks.receiveShadow = false;
  marks.name = 'markings';
  group.add(marks);

  /* --------------------------------------------------- sidewalks/curbs --- */
  const walkGeos = [];
  const curbGeos = [];
  for (const b of layout.blocks) {
    const sw = b.sidewalk;
    const w = b.w, d = b.d;
    // sidewalk slab covering the whole block; the building pad sits on top
    walkGeos.push(tiledPlane(w, d, b.x, b.z, Y_WALK, 3.0));
    // curb: four thin boxes around the perimeter
    const cw = 0.42;
    for (const [ox, oz, bw, bd] of [
      [0, -d / 2 + cw / 2, w, cw],
      [0, d / 2 - cw / 2, w, cw],
      [-w / 2 + cw / 2, 0, cw, d],
      [w / 2 - cw / 2, 0, cw, d],
    ]) {
      const g = new THREE.BoxGeometry(bw, Y_WALK + 0.02, bd);
      g.translate(b.x + ox, (Y_WALK + 0.02) / 2 - 0.01, b.z + oz);
      curbGeos.push(g);
    }
    b._swInset = sw;
  }

  const walkMat = ground({
    map: Textures.paving(512, '#ded8cb', 'rgba(150,144,132,0.5)', 6),
    roughnessMap: Textures.roughness(256, 210, 0.16),
    roughness: 0.94,
  });
  const walks = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(walkGeos, false), walkMat);
  walks.receiveShadow = true;
  walks.name = 'sidewalks';
  group.add(walks);

  const curbMat = ground({ color: PALETTE.CURB, roughness: 0.88 });
  const curbs = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(curbGeos, false), curbMat);
  curbs.castShadow = false;
  curbs.receiveShadow = true;
  curbs.name = 'curbs';
  group.add(curbs);

  /* ---------------------------------------------------------- bridges --- */
  const bridgeGeos = [];
  for (const br of layout.bridges) {
    const g = new THREE.BoxGeometry(br.width, 1.2, br.length);
    g.translate(br.x, 0.6, br.z);
    bridgeGeos.push(g);
  }
  if (bridgeGeos.length) {
    const bridgeMat = ground({ color: 0xdad4c6, roughness: 0.9 });
    const bridge = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(bridgeGeos, false), bridgeMat);
    bridge.receiveShadow = true;
    bridge.castShadow = true;
    bridge.name = 'bridges';
    group.add(bridge);
  }

  return group;
}
