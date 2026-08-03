/**
 * Vehicles: parked and moving cars, buses, bicycles, food carts, boats and
 * construction equipment. BASELINE — expected to be replaced with a AAA version.
 *
 * Moving traffic writes straight into instanced slots each frame and calls
 * registry.rehash so the spatial hash stays correct.
 */

import * as THREE from 'three';
import { TIER, WORLD } from '../config.js';
import { makeRNG } from '../core/rng.js';
import { solid } from '../core/materials.js';

const CAR_COLORS = [
  0xff5d5d, 0x4fc3f7, 0xffd54f, 0xf5f5f5, 0x37474f,
  0x81c784, 0xffab91, 0xba68c8, 0x90a4ae,
];

function carGeometry() {
  const parts = [];
  const body = new THREE.BoxGeometry(1.95, 0.72, 4.4);
  body.translate(0, 0.62, 0);
  parts.push(body);
  const cabin = new THREE.BoxGeometry(1.72, 0.62, 2.3);
  cabin.translate(0, 1.26, -0.14);
  parts.push(cabin);
  for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
    const w = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 12);
    w.rotateZ(Math.PI / 2);
    w.translate(sx * 0.92, 0.34, sz * 1.42);
    parts.push(w);
  }
  return merge(parts);
}

function busGeometry() {
  const parts = [];
  const body = new THREE.BoxGeometry(2.6, 2.9, 11.5);
  body.translate(0, 1.85, 0);
  parts.push(body);
  const roof = new THREE.BoxGeometry(2.4, 0.2, 10.8);
  roof.translate(0, 3.35, 0);
  parts.push(roof);
  for (const sz of [3.9, -3.2]) {
    for (const sx of [-1, 1]) {
      const w = new THREE.CylinderGeometry(0.52, 0.52, 0.3, 12);
      w.rotateZ(Math.PI / 2);
      w.translate(sx * 1.24, 0.52, sz);
      parts.push(w);
    }
  }
  return merge(parts);
}

function bikeGeometry() {
  const parts = [];
  for (const sz of [-0.52, 0.52]) {
    const w = new THREE.TorusGeometry(0.33, 0.045, 6, 16);
    w.translate(0, 0.33, sz);
    parts.push(w);
  }
  const frame = new THREE.BoxGeometry(0.07, 0.07, 1.0);
  frame.translate(0, 0.6, 0); parts.push(frame);
  const seat = new THREE.BoxGeometry(0.14, 0.06, 0.32);
  seat.translate(0, 0.86, -0.32); parts.push(seat);
  const bar = new THREE.BoxGeometry(0.5, 0.05, 0.05);
  bar.translate(0, 0.92, 0.44); parts.push(bar);
  return merge(parts);
}

function cartGeometry() {
  const parts = [];
  const body = new THREE.BoxGeometry(1.5, 1.0, 2.3); body.translate(0, 0.85, 0);
  const roof = new THREE.BoxGeometry(1.9, 0.12, 2.6); roof.translate(0, 2.05, 0);
  parts.push(body, roof);
  for (const sx of [-1, 1]) {
    const p = new THREE.CylinderGeometry(0.05, 0.05, 1.1, 6);
    p.translate(sx * 0.8, 1.5, 1.1); parts.push(p);
  }
  for (const sz of [-0.7, 0.7]) {
    const w = new THREE.CylinderGeometry(0.28, 0.28, 0.14, 10);
    w.rotateZ(Math.PI / 2); w.translate(0.78, 0.28, sz); parts.push(w);
  }
  return merge(parts);
}

function boatGeometry() {
  const parts = [];
  const hull = new THREE.CylinderGeometry(1.15, 0.75, 7.2, 12, 1, false, 0, Math.PI);
  hull.rotateZ(Math.PI / 2); hull.rotateY(Math.PI / 2);
  hull.translate(0, 0.7, 0);
  parts.push(hull);
  const deck = new THREE.BoxGeometry(2.2, 0.14, 7.0); deck.translate(0, 1.28, 0);
  const cabin = new THREE.BoxGeometry(1.7, 1.15, 2.6); cabin.translate(0, 1.9, -0.9);
  parts.push(deck, cabin);
  return merge(parts);
}

function excavatorGeometry() {
  const parts = [];
  const base = new THREE.BoxGeometry(2.6, 0.7, 4.0); base.translate(0, 0.7, 0);
  const cab = new THREE.BoxGeometry(2.0, 1.7, 2.2); cab.translate(0, 1.95, -0.6);
  const arm = new THREE.BoxGeometry(0.4, 0.4, 4.2); arm.rotateX(-0.7); arm.translate(0, 2.8, 1.9);
  parts.push(base, cab, arm);
  for (const sx of [-1, 1]) {
    const t = new THREE.BoxGeometry(0.7, 0.7, 4.2); t.translate(sx * 1.15, 0.35, 0);
    parts.push(t);
  }
  return merge(parts);
}

function merge(geos) {
  let vCount = 0;
  const P = [], N = [], U = [];
  for (const g of geos) {
    const ng = g.index ? g.toNonIndexed() : g;
    P.push(ng.attributes.position.array);
    N.push(ng.attributes.normal.array);
    U.push(ng.attributes.uv ? ng.attributes.uv.array : new Float32Array(ng.attributes.position.count * 2));
    vCount += ng.attributes.position.count;
  }
  const pos = new Float32Array(vCount * 3), nor = new Float32Array(vCount * 3), uv = new Float32Array(vCount * 2);
  let o3 = 0, o2 = 0;
  for (let i = 0; i < P.length; i++) {
    pos.set(P[i], o3); nor.set(N[i], o3); uv.set(U[i], o2);
    o3 += P[i].length; o2 += U[i].length;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}

const DEFS = {
  car: { geo: carGeometry, tier: TIER.LARGE, radius: 1.5, height: 1.6, cap: 2200, label: 'Car' },
  bus: { geo: busGeometry, tier: TIER.XLARGE, radius: 3.4, height: 3.5, cap: 220, label: 'City Bus' },
  bike: { geo: bikeGeometry, tier: TIER.MEDIUM, radius: 0.7, height: 1.0, cap: 700, label: 'Bicycle' },
  cart: { geo: cartGeometry, tier: TIER.LARGE, radius: 1.3, height: 2.1, cap: 260, label: 'Food Cart' },
  boat: { geo: boatGeometry, tier: TIER.XLARGE, radius: 3.6, height: 3.0, cap: 160, label: 'Boat' },
  excavator: { geo: excavatorGeometry, tier: TIER.XLARGE, radius: 2.4, height: 3.4, cap: 120, label: 'Excavator' },
};

export function buildVehicles(ctx) {
  const { layout, registry } = ctx;
  const rng = makeRNG(0x7c3a);
  const factories = {};
  for (const k of Object.keys(DEFS)) {
    factories[k] = () => ({
      geometry: DEFS[k].geo(),
      material: solid({ color: 0xffffff, roughness: 0.42, metalness: 0.12 }),
    });
  }

  const traffic = [];

  const spawn = (key, x, y, z, rotY, hex, dynamic = false) => {
    const def = DEFS[key];
    const c = ctx.addInstanced(key, factories[key], {
      position: new THREE.Vector3(x, y, z),
      rotationY: rotY,
      hex,
      tier: def.tier,
      radius: def.radius,
      height: def.height,
      label: def.label,
      kind: key,
      capacity: def.cap,
      dynamic,
      castShadow: true,
    });
    return c;
  };

  /* ---- parked cars along the kerb ------------------------------------- */
  for (const r of layout.roadsX) {
    for (let z = -WORLD.SIZE + 20; z < WORLD.SIZE - 20; z += 6.6) {
      if (layout.isWater(r.pos, z)) continue;
      let atCross = false;
      for (const rz of layout.roadsZ) if (Math.abs(z - rz.pos) < rz.half + 8) { atCross = true; break; }
      if (atCross) continue;
      for (const s of [-1, 1]) {
        if (!rng.chance(0.44)) continue;
        const x = r.pos + s * (r.half - 1.9);
        spawn('car', x, 0.02, z, s > 0 ? 0 : Math.PI, rng.pick(CAR_COLORS));
      }
    }
  }
  for (const r of layout.roadsZ) {
    for (let x = -WORLD.SIZE + 20; x < WORLD.BAY_EDGE - 20; x += 6.6) {
      let atCross = false;
      for (const rx of layout.roadsX) if (Math.abs(x - rx.pos) < rx.half + 8) { atCross = true; break; }
      if (atCross) continue;
      for (const s of [-1, 1]) {
        if (!rng.chance(0.34)) continue;
        const z = r.pos + s * (r.half - 1.9);
        spawn('car', x, 0.02, z, Math.PI / 2 * (s > 0 ? 1 : -1), rng.pick(CAR_COLORS));
      }
    }
  }

  /* ---- moving traffic --------------------------------------------------- */
  for (const r of layout.roadsX) {
    const lanes = r.half > WORLD.ROAD_W ? 2 : 1;
    for (let l = 0; l < lanes * 2; l++) {
      const dir = l % 2 === 0 ? 1 : -1;
      const off = (Math.floor(l / 2) + 0.6) * 3.4 * dir;
      const n = 3 + rng.int(0, 3);
      for (let i = 0; i < n; i++) {
        const z = -WORLD.SIZE + rng() * WORLD.SIZE * 2;
        if (layout.isWater(r.pos, z)) continue;
        const isBus = rng.chance(0.16);
        const c = spawn(
          isBus ? 'bus' : 'car', r.pos + off, 0.02, z,
          dir > 0 ? 0 : Math.PI,
          isBus ? rng.pick([0x2fa8e0, 0xf5f5f5, 0x66bb6a]) : rng.pick(CAR_COLORS),
          true
        );
        if (c) traffic.push({ c, axis: 'z', dir, speed: 7 + rng() * 6, lane: r.pos + off });
      }
    }
  }
  for (const r of layout.roadsZ) {
    const lanes = r.half > WORLD.ROAD_W ? 2 : 1;
    for (let l = 0; l < lanes * 2; l++) {
      const dir = l % 2 === 0 ? 1 : -1;
      const off = (Math.floor(l / 2) + 0.6) * 3.4 * dir;
      const n = 3 + rng.int(0, 3);
      for (let i = 0; i < n; i++) {
        const x = -WORLD.SIZE + rng() * (WORLD.SIZE + WORLD.BAY_EDGE);
        const isBus = rng.chance(0.14);
        const c = spawn(
          isBus ? 'bus' : 'car', x, 0.02, r.pos + off,
          dir > 0 ? Math.PI / 2 : -Math.PI / 2,
          isBus ? rng.pick([0x2fa8e0, 0xf5f5f5, 0x66bb6a]) : rng.pick(CAR_COLORS),
          true
        );
        if (c) traffic.push({ c, axis: 'x', dir, speed: 7 + rng() * 6, lane: r.pos + off });
      }
    }
  }

  /* ---- bikes, carts, boats, machinery ---------------------------------- */
  for (const b of layout.blocks) {
    const r = makeRNG(b.seed ^ 0x1177);
    if (r.chance(0.5)) {
      for (let i = 0; i < r.int(2, 5); i++) {
        const x = b.x + (r() - 0.5) * b.w * 0.8;
        const z = b.z + (r() - 0.5) * b.d * 0.8;
        if (!ctx.isFree(x, z, 1.0)) continue;
        ctx.occupy(x, z, 1.0);
        spawn('bike', x, ctx.Y_WALK, z, r() * 6.28, r.pick([0x2fd0c0, 0xff7a59, 0xf5f5f5, 0x3f51b5]));
      }
    }
    if (r.chance(0.22)) {
      const x = b.x + (r() - 0.5) * b.w * 0.7;
      const z = b.z + (r() - 0.5) * b.d * 0.7;
      if (ctx.isFree(x, z, 2)) {
        ctx.occupy(x, z, 2);
        spawn('cart', x, ctx.Y_WALK, z, r() * 6.28, r.pick([0xff5d8f, 0xffc93c, 0x59d1a0]));
      }
    }
  }

  // marina boats along the seawall
  for (let z = -WORLD.SIZE + 60; z < WORLD.SIZE - 60; z += 26) {
    if (!rng.chance(0.42)) continue;
    spawn('boat', WORLD.BAY_EDGE + 7 + rng() * 5, 0.15, z, Math.PI / 2, rng.pick([0xffffff, 0xf2f7ff, 0xdfe8f0]));
  }

  ctx.traffic = traffic;
  ctx.scene.userData.traffic = traffic;
  ctx.scene.userData.trafficUpdate = makeTrafficUpdater(traffic, registry);
}

function makeTrafficUpdater(traffic, registry) {
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3(1, 1, 1);
  const p = new THREE.Vector3();
  return (dt) => {
    for (let i = 0; i < traffic.length; i++) {
      const t = traffic[i];
      const c = t.c;
      if (!c || c.state === 3) continue;
      if (c.state === 2) continue; // falling: leave it to the consume system
      if (t.axis === 'z') {
        c.position.z += t.dir * t.speed * dt;
        if (c.position.z > WORLD.SIZE) c.position.z = -WORLD.SIZE;
        if (c.position.z < -WORLD.SIZE) c.position.z = WORLD.SIZE;
        e.set(0, t.dir > 0 ? 0 : Math.PI, 0);
      } else {
        c.position.x += t.dir * t.speed * dt;
        if (c.position.x > WORLD.BAY_EDGE) c.position.x = -WORLD.SIZE;
        if (c.position.x < -WORLD.SIZE) c.position.x = WORLD.BAY_EDGE;
        e.set(0, t.dir > 0 ? Math.PI / 2 : -Math.PI / 2, 0);
      }
      q.setFromEuler(e);
      p.copy(c.position);
      c.pool.slotPos[c.slot].copy(p);
      c.pool.slotRot[c.slot].copy(q);
      c.pool.setTransform(c.slot, p, q, s);
      registry.rehash(c);
    }
  };
}
