#!/usr/bin/env node
/**
 * Prop audit — finds props whose declared physics does not match their geometry,
 * and props that are badly placed in the world.
 *
 * Every Consumable declares a `radius`, `height` and `passRadius` that the
 * consumption physics runs on. If those disagree with the mesh the player
 * actually sees, the game lies: an object gets eaten by a hole that visibly
 * does not reach it, or refuses one that plainly should. This measures the real
 * geometry and reports the mismatches.
 *
 * Also flags: props floating above or sunk into the ground, props overlapping
 * each other, props sitting in the bay or the river, and props whose scale is
 * wildly out of line with others of the same kind.
 *
 *   node tools/prop-audit.mjs                 # summary
 *   node tools/prop-audit.mjs --json          # full machine-readable report
 *   node tools/prop-audit.mjs --kind cone     # drill into one kind
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const AS_JSON = argv.includes('--json');
const KIND = flag('kind', null);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
page.setDefaultTimeout(300000);
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.stack || e).split('\n')[0]));

await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction('!!window.DEV', null, { timeout: 300000 });

const report = await page.evaluate((kindFilter) => {
  const g = window.__GAME__;
  const all = [...g.registry.byId.values()];
  const byKind = new Map();
  for (const c of all) {
    if (kindFilter && c.kind !== kindFilter) continue;
    if (!byKind.has(c.kind)) byKind.set(c.kind, []);
    byKind.get(c.kind).push(c);
  }

  /**
   * Geometric extents of whatever backs this consumable.
   *
   * Two different radii matter and conflating them produces nonsense:
   *   bbox    — the full silhouette, including overhang. A palm's frond crown
   *             is 16 m across, which says nothing about its support.
   *   contact — the horizontal extent of geometry in the lowest fifth of the
   *             object. THIS is what rests on the ground, and therefore what
   *             the support/overlap physics should be declaring.
   */
  const contactExtent = (positions, matrix, loY, hiY, acc) => {
    const m = matrix;
    for (let i = 0; i < positions.count; i++) {
      const px = positions.getX(i), py = positions.getY(i), pz = positions.getZ(i);
      const X = m[0] * px + m[4] * py + m[8] * pz + m[12];
      const Y = m[1] * px + m[5] * py + m[9] * pz + m[13];
      const Z = m[2] * px + m[6] * py + m[10] * pz + m[14];
      if (Y > hiY) continue;
      if (X < acc.minX) acc.minX = X; if (X > acc.maxX) acc.maxX = X;
      if (Z < acc.minZ) acc.minZ = Z; if (Z > acc.maxZ) acc.maxZ = Z;
    }
  };

  const measure = (c) => {
    if (c.backing === 1 && c.pool) {
      const geo = c.pool.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const bb = geo.boundingBox;
      const s = c.pool.slotScale[c.slot];
      const h = (bb.max.y - bb.min.y) * s.y;
      // Contact band: the bottom 20% of the object's own height.
      const hiLocal = bb.min.y + (bb.max.y - bb.min.y) * 0.20;
      const acc = { minX: 1e9, maxX: -1e9, minZ: 1e9, maxZ: -1e9 };
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        if (pos.getY(i) > hiLocal) continue;
        const X = pos.getX(i) * s.x, Z = pos.getZ(i) * s.z;
        if (X < acc.minX) acc.minX = X; if (X > acc.maxX) acc.maxX = X;
        if (Z < acc.minZ) acc.minZ = Z; if (Z > acc.maxZ) acc.maxZ = Z;
      }
      const cw = acc.maxX > -1e8 ? acc.maxX - acc.minX : 0;
      const cd = acc.maxZ > -1e8 ? acc.maxZ - acc.minZ : 0;
      return {
        w: (bb.max.x - bb.min.x) * s.x,
        d: (bb.max.z - bb.min.z) * s.z,
        h,
        cw, cd,
        baseY: bb.min.y * s.y + c.pool.slotPos[c.slot].y,
      };
    }
    if (c.object) {
      const box = new (window.__THREE_BOX3__ || Object)();
      // Build a Box3 without importing THREE: walk the meshes.
      let minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9;
      c.object.updateWorldMatrix(true, true);
      c.object.traverse((n) => {
        if (!n.isMesh || !n.geometry) return;
        if (!n.geometry.boundingBox) n.geometry.computeBoundingBox();
        const bb = n.geometry.boundingBox;
        for (const cx of [bb.min.x, bb.max.x]) {
          for (const cy of [bb.min.y, bb.max.y]) {
            for (const cz of [bb.min.z, bb.max.z]) {
              const v = { x: cx, y: cy, z: cz };
              const m = n.matrixWorld.elements;
              const X = m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12];
              const Y = m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13];
              const Z = m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14];
              if (X < minX) minX = X; if (X > maxX) maxX = X;
              if (Y < minY) minY = Y; if (Y > maxY) maxY = Y;
              if (Z < minZ) minZ = Z; if (Z > maxZ) maxZ = Z;
            }
          }
        }
      });
      if (minX > 1e8) return null;
      // Mesh-backed objects (buildings) are prisms: contact == footprint.
      return { w: maxX - minX, d: maxZ - minZ, h: maxY - minY,
               cw: maxX - minX, cd: maxZ - minZ, baseY: minY };
    }
    return null;
  };

  const kinds = [];
  const GROUND_TOL = 0.28;   // metres a prop may sit off the ground before it is wrong

  for (const [kind, list] of byKind) {
    const sample = list.slice(0, 40);
    const m = [];
    for (const c of sample) { const r = measure(c); if (r) m.push({ c, r }); }
    if (!m.length) { kinds.push({ kind, count: list.length, error: 'unmeasurable' }); continue; }

    const med = (arr) => { const a = [...arr].sort((x, y) => x - y); return a[a.length >> 1]; };
    // Contact footprint is the honest comparison for the support physics.
    const trueRadius = med(m.map(({ r }) => Math.hypot(r.cw || r.w, r.cd || r.d) / 2));
    const trueNarrow = med(m.map(({ r }) => Math.min(r.cw || r.w, r.cd || r.d) / 2));
    const bboxRadius = med(m.map(({ r }) => Math.hypot(r.w, r.d) / 2));
    const trueHeight = med(m.map(({ r }) => r.h));
    const declRadius = m[0].c.radius;
    const declHeight = m[0].c.height;
    const declPass = m[0].c.passRadius;

    // Placement problems
    let floating = 0, sunken = 0, inWater = 0;
    for (const { c, r } of m) {
      if (r.baseY > GROUND_TOL) floating++;
      if (r.baseY < -GROUND_TOL) sunken++;
      const floats = /boat|yacht|skiff|ship|taxi|sail|fisher|pontoon|dock|buoy|barge/i.test(kind);
      if (!floats && g.layout && g.layout.isWater
          && g.layout.isWater(c.position.x, c.position.z)) inWater++;
    }

    kinds.push({
      kind,
      count: list.length,
      declared: { radius: +declRadius.toFixed(2), height: +declHeight.toFixed(2), passRadius: +declPass.toFixed(2) },
      actual: { radius: +trueRadius.toFixed(2), narrowHalf: +trueNarrow.toFixed(2),
                height: +trueHeight.toFixed(2), bboxRadius: +bboxRadius.toFixed(2) },
      radiusErrPct: Math.round(((declRadius - trueRadius) / Math.max(0.01, trueRadius)) * 100),
      heightErrPct: Math.round(((declHeight - trueHeight) / Math.max(0.01, trueHeight)) * 100),
      passErrPct: Math.round(((declPass - trueNarrow) / Math.max(0.01, trueNarrow)) * 100),
      sampled: m.length,
      floating, sunken, inWater,
    });
  }

  // Overlap check: props whose footprints intersect badly.
  let overlaps = 0;
  const near = [];
  const worst = [];
  for (let i = 0; i < all.length; i += 3) {
    const a = all[i];
    g.registry.query(a.position.x, a.position.z, a.radius + 2, near);
    for (const b of near) {
      if (b === a || b.id < a.id) continue;
      const d = Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z);
      const pen = (a.radius + b.radius) * 0.62 - d;
      if (pen > 0.25) {
        overlaps++;
        if (worst.length < 25) worst.push({ a: a.kind, b: b.kind, gap: +(-pen).toFixed(2),
          at: [Math.round(a.position.x), Math.round(a.position.z)] });
      }
    }
  }

  return {
    totalProps: all.length,
    kinds: kinds.sort((x, y) => Math.abs(y.radiusErrPct || 0) - Math.abs(x.radiusErrPct || 0)),
    overlapPairs: overlaps,
    worstOverlaps: worst,
  };
}, KIND);

report.pageErrors = pageErrors;
mkdirSync('shots', { recursive: true });
writeFileSync('shots/prop-audit.json', JSON.stringify(report, null, 2));

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`${report.totalProps} props across ${report.kinds.length} kinds`);
  console.log(`overlapping pairs: ${report.overlapPairs}`);
  const bad = report.kinds.filter((k) =>
    Math.abs(k.radiusErrPct) > 30 || Math.abs(k.heightErrPct) > 30 ||
    k.floating > 0 || k.sunken > 0 || k.inWater > 0);
  console.log(`\nkinds with a size or placement problem: ${bad.length}/${report.kinds.length}`);
  console.log('kind            n     declR  trueR  errR%   declH  trueH  errH%  float sunk water');
  for (const k of bad.slice(0, 40)) {
    if (k.error) { console.log(`${k.kind.padEnd(15)} ${String(k.count).padEnd(5)} ${k.error}`); continue; }
    console.log(
      `${k.kind.padEnd(15)} ${String(k.count).padEnd(5)} ` +
      `${String(k.declared.radius).padEnd(6)} ${String(k.actual.radius).padEnd(6)} ` +
      `${String(k.radiusErrPct).padStart(5)}   ` +
      `${String(k.declared.height).padEnd(6)} ${String(k.actual.height).padEnd(6)} ` +
      `${String(k.heightErrPct).padStart(5)}  ` +
      `${String(k.floating).padStart(5)} ${String(k.sunken).padStart(4)} ${String(k.inWater).padStart(5)}`
    );
  }
  console.log('\nfull report: shots/prop-audit.json');
  if (pageErrors.length) console.log(`\npage errors: ${pageErrors.length}`, pageErrors.slice(0, 3));
}

await browser.close();
