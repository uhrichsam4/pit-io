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

const report = await page.evaluate(async (kindFilter) => {
  const THREE = await import('/node_modules/three/build/three.module.js');
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
      // A building is NOT a plain prism. Awnings, canopies, cornices, balconies
      // and roof plant all widen its bounding box, and a sandwich board or a
      // produce stand standing correctly UNDER a shop awning then reads as a
      // prop buried inside the shop. Take the same contact band as everything
      // else — geometry in the lowest fifth — for the footprint the overlap
      // test uses. `w`/`d` stay the full box, because that is what worldBuild
      // declares as the object's radius and the size columns compare against it.
      const hiY = minY + (maxY - minY) * 0.20;
      let bx0 = 1e9, bx1 = -1e9, bz0 = 1e9, bz1 = -1e9;
      c.object.traverse((n) => {
        if (!n.isMesh || !n.geometry) return;
        const pos = n.geometry.attributes.position;
        if (!pos) return;
        const e = n.matrixWorld.elements;
        for (let i = 0; i < pos.count; i++) {
          const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
          const Y = e[1] * px + e[5] * py + e[9] * pz + e[13];
          if (Y > hiY) continue;
          const X = e[0] * px + e[4] * py + e[8] * pz + e[12];
          const Z = e[2] * px + e[6] * py + e[10] * pz + e[14];
          if (X < bx0) bx0 = X; if (X > bx1) bx1 = X;
          if (Z < bz0) bz0 = Z; if (Z > bz1) bz1 = Z;
        }
      });
      const okBand = bx1 > bx0 && bz1 > bz0;
      return { w: maxX - minX, d: maxZ - minZ, h: maxY - minY,
               cw: maxX - minX, cd: maxZ - minZ, baseY: minY,
               bandX: okBand ? (bx0 + bx1) / 2 : (minX + maxX) / 2,
               bandZ: okBand ? (bz0 + bz1) / 2 : (minZ + maxZ) / 2,
               bandW: okBand ? bx1 - bx0 : maxX - minX,
               bandD: okBand ? bz1 - bz0 : maxZ - minZ };
    }
    return null;
  };

  const kinds = [];
  const GROUND_TOL = 0.28;   // metres a prop may sit off its surface before it is wrong

  /**
   * What is actually underneath a prop.
   *
   * The first version of this compared the prop's base against y = 0 and called
   * anything else floating or sunken. Miami is not flat: the sidewalk is at
   * 0.155, the bay surface at 0.12, the seawall coping at 1.36 and the river
   * bridge decks at 1.20. So the audit reported all 154 mooring bollards as
   * floating (they sit on the seawall, 2 cm proud of the coping), every boat as
   * sunken (a hull is meant to be below the waterline) and the four cars on the
   * bridge as floating, while a prop genuinely hanging in the air over an
   * ordinary street was indistinguishable from any of them. It cried wolf 200
   * times and could not have caught the one case it exists for.
   *
   * So: cast down at the prop and take the first real surface. Only the ground
   * groups are candidates — instanced pools are excluded because a ray that
   * clips a seagull 2.3 m up or a palm crown 9 m up is not the ground, and
   * because intersecting 3,700-instance pools 200 times is minutes of work.
   * Rays are only cast for props the cheap y=0 test already doubts, which keeps
   * this to a couple of hundred casts.
   */
  const surfaces = [];
  for (const n of g.engine.scene.children) {
    if (n.isInstancedMesh) continue;
    if (!/^(streets|water|buildings|nature|props|decor|misc)$/.test(n.name || '')) continue;
    surfaces.push(n);
  }
  const _ray = new THREE.Raycaster();
  _ray.far = 600;
  const _down = new THREE.Vector3(0, -1, 0);
  const _org = new THREE.Vector3();
  const surfaceUnder = (c, baseY) => {
    _org.set(c.position.x, baseY + 80, c.position.z);
    _ray.set(_org, _down);
    const hits = _ray.intersectObjects(surfaces, true);
    for (const h of hits) {
      if (h.object.isInstancedMesh) continue;
      let root = h.object, mine = false;
      while (root) { if (root === c.object) { mine = true; break; } root = root.parent; }
      if (mine) continue;
      return h.point.y;
    }
    return null;
  };

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
    const declRadius = med(m.map(({ c }) => c.radius));
    const declHeight = med(m.map(({ c }) => c.height));
    const declPass = med(m.map(({ c }) => c.passRadius));
    /**
     * The error is the MEDIAN OF THE PER-INSTANCE ERRORS, not the error between
     * two medians. Buildings of one kind vary enormously — storefronts run from
     * one storey to four — and comparing the first instance's declared height
     * against the kind's median measured height reported a 43% error on a set
     * where every single object was declaring its own size correctly. Four of
     * the five kinds this tool was flagging as mis-sized were that arithmetic.
     */
    const errPct = (f, t) => {
      const e = m.map(({ c, r }) => (f(c) - t(r)) / Math.max(0.01, t(r)));
      return Math.round(med(e) * 100);
    };

    // Placement problems, measured against the surface the prop stands on.
    const floats = /boat|yacht|skiff|ship|watertaxi|sail|fisher|pontoon|dock|buoy|barge|jetski|mangrove/i.test(kind);
    let floating = 0, sunken = 0, inWater = 0;
    const offenders = [];
    for (const { c, r } of m) {
      const wet = !floats && g.layout && g.layout.isWater
        && g.layout.isWater(c.position.x, c.position.z);
      let surf;
      if (Math.abs(r.baseY) > GROUND_TOL || wet) {
        // A boat or a mangrove is meant to sit in the water, so its surface is
        // the waterline, not the seabed.
        surf = floats ? 0 : surfaceUnder(c, r.baseY);
        const gap = surf === null ? r.baseY : r.baseY - surf;
        const at = [Math.round(c.position.x), Math.round(c.position.z)];
        if (gap > GROUND_TOL) { floating++; offenders.push({ id: c.id, gap: +gap.toFixed(2), over: +(surf ?? 0).toFixed(2), at }); }
        else if (gap < -GROUND_TOL && !floats) { sunken++; offenders.push({ id: c.id, gap: +gap.toFixed(2), over: +(surf ?? 0).toFixed(2), at }); }
      }
      // isWater() is a LAYOUT polygon test, and quays, piers, pontoons and the
      // seawall coping all overhang it — all 154 mooring bollards, which stand
      // on 1.36 m of seawall, were being reported as standing in the bay. A
      // prop is only in the water when the water is the thing under it.
      if (wet && surf !== undefined && surf !== null && surf > 0.30) continue;
      if (wet) inWater++;
    }

    kinds.push({
      kind,
      count: list.length,
      declared: { radius: +declRadius.toFixed(2), height: +declHeight.toFixed(2), passRadius: +declPass.toFixed(2) },
      actual: { radius: +trueRadius.toFixed(2), narrowHalf: +trueNarrow.toFixed(2),
                height: +trueHeight.toFixed(2), bboxRadius: +bboxRadius.toFixed(2) },
      radiusErrPct: errPct((c) => c.radius, (r) => Math.hypot(r.cw || r.w, r.cd || r.d) / 2),
      heightErrPct: errPct((c) => c.height, (r) => r.h),
      passErrPct: errPct((c) => c.passRadius, (r) => Math.min(r.cw || r.w, r.cd || r.d) / 2),
      sampled: m.length,
      floating, sunken, inWater,
      offenders: offenders.slice(0, 6),
    });
  }

  /**
   * Overlap check on the REAL oriented contact rectangle, not on a circle.
   *
   * `radius` is the circumscribed radius of the contact patch — for a 22 m x 12
   * m shopfront that is 12.7 m, so two of them standing shoulder to shoulder in
   * a terrace, sharing a party wall exactly as a retail parade should, "overlap"
   * on any test that treats them as discs. That reported 772 pairs, almost all
   * of them correct architecture, and buried the handful of cases where two
   * modules really had put something in the same place. Measured with true
   * world boxes, the entire city has ONE pair of intersecting buildings, and it
   * is a 0.6 m party wall.
   *
   * So: each prop becomes the rectangle its lowest fifth actually occupies,
   * turned to its own heading, and a pair is in conflict only when the
   * separating-axis test finds real penetration on every axis. The 0.9 factor
   * leaves a little slack for touching kerbs and shared walls.
   */
  const _rectCache = new WeakMap();
  const localContact = (pool) => {
    let r = _rectCache.get(pool.geometry);
    if (r) return r;
    const geo = pool.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const hiLocal = bb.min.y + (bb.max.y - bb.min.y) * 0.20;
    const pos = geo.attributes.position;
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > hiLocal) continue;
      const x = pos.getX(i), z = pos.getZ(i);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    if (!(maxX > minX)) { minX = bb.min.x; maxX = bb.max.x; minZ = bb.min.z; maxZ = bb.max.z; }
    r = { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2,
          hx: (maxX - minX) / 2, hz: (maxZ - minZ) / 2 };
    _rectCache.set(geo, r);
    return r;
  };
  const rectOf = (c) => {
    if (c._auditRect) return c._auditRect;
    let r;
    if (c.backing === 1 && c.pool) {
      const L = localContact(c.pool);
      const s = c.pool.slotScale[c.slot], p = c.pool.slotPos[c.slot];
      const rot = c.rotationY || 0;
      const ca = Math.cos(rot), sa = Math.sin(rot);
      const lx = L.cx * s.x, lz = L.cz * s.z;
      r = { x: p.x + lx * ca + lz * sa, z: p.z - lx * sa + lz * ca,
            hx: L.hx * s.x, hz: L.hz * s.z, rot };
    } else if (c.object) {
      const m = measure(c);
      if (!m) return null;
      // The contact band, world-aligned — see measure().
      r = { x: m.bandX, z: m.bandZ, hx: m.bandW / 2, hz: m.bandD / 2, rot: 0 };
    } else return null;
    c._auditRect = r;
    return r;
  };
  const sat = (a, b) => {
    const ra = rectOf(a), rb = rectOf(b);
    if (!ra || !rb) return 0;
    const dx = rb.x - ra.x, dz = rb.z - ra.z;
    let worstPen = Infinity;
    const proj = (r, ax, az) =>
      Math.abs(r.hx * (Math.cos(r.rot) * ax - Math.sin(r.rot) * az))
      + Math.abs(r.hz * (Math.sin(r.rot) * ax + Math.cos(r.rot) * az));
    for (const r of [ra, rb]) {
      for (let axis = 0; axis < 2; axis++) {
        const ax = axis === 0 ? Math.cos(r.rot) : -Math.sin(r.rot);
        const az = axis === 0 ? Math.sin(r.rot) : Math.cos(r.rot);
        const pen = (proj(ra, ax, az) + proj(rb, ax, az)) * 0.9
                  - Math.abs(dx * ax + dz * az);
        if (pen <= 0) return 0;
        if (pen < worstPen) worstPen = pen;
      }
    }
    return worstPen;
  };

  let overlaps = 0, containerPairs = 0, propPairs = 0;
  const near = [];
  const worst = [];
  for (let i = 0; i < all.length; i += 3) {
    const a = all[i];
    g.registry.query(a.position.x, a.position.z, a.radius + 2, near);
    for (const b of near) {
      if (b === a || b.id < a.id) continue;
      const pen = sat(a, b);
      if (pen > 0.25) {
        overlaps++;
        // A mesh-backed consumable is a container, not a neighbour: a
        // construction site IS its hoarding and the crates and the excavator
        // inside it, and a shopfront's stall riser sits under its own awning
        // with the café furniture on it. Those are authored to interpenetrate.
        // The occupancy grid only governs prop-against-prop, so that is the
        // number that means "two modules put something in the same place".
        if (a.backing !== 1 || b.backing !== 1) containerPairs++;
        else propPairs++;
        // Keep them all and rank afterwards. Keeping the first 25 found meant
        // the "worst overlaps" list was really "overlaps with the lowest object
        // ids", which is one corner of one district, and it hid every genuinely
        // bad pair behind whatever happened to be built first.
        worst.push({ a: a.kind, b: b.kind, overlap: +pen.toFixed(2),
          propPair: a.backing === 1 && b.backing === 1,
          at: [Math.round(a.position.x), Math.round(a.position.z)] });
      }
    }
  }

  worst.sort((x, y) => y.overlap - x.overlap);
  const byPair = {};
  for (const w of worst) {
    const k = `${w.a} x ${w.b}`;
    byPair[k] = (byPair[k] || 0) + 1;
  }
  const pairCounts = Object.entries(byPair).sort((x, y) => y[1] - x[1]).slice(0, 20)
    .map(([pair, n]) => ({ pair, n }));

  return {
    totalProps: all.length,
    kinds: kinds.sort((x, y) => Math.abs(y.radiusErrPct || 0) - Math.abs(x.radiusErrPct || 0)),
    overlapPairs: overlaps,
    overlapInsideContainers: containerPairs,
    overlapPropVsProp: propPairs,
    overlapPairKinds: pairCounts,
    worstOverlaps: worst.slice(0, 40),
    worstPropVsProp: worst.filter((w) => w.propPair).slice(0, 20),
  };
}, KIND);

report.pageErrors = pageErrors;
mkdirSync('shots', { recursive: true });
writeFileSync('shots/prop-audit.json', JSON.stringify(report, null, 2));

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`${report.totalProps} props across ${report.kinds.length} kinds`);
  console.log(`overlapping pairs: ${report.overlapPairs} ` +
    `(${report.overlapPropVsProp} prop-vs-prop, ` +
    `${report.overlapInsideContainers} inside a building or site)`);
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
  if (report.overlapPairKinds.length) {
    console.log('\noverlapping pairs by kind:');
    for (const p of report.overlapPairKinds.slice(0, 12)) {
      console.log(`  ${String(p.n).padStart(5)}  ${p.pair}`);
    }
    console.log('worst prop-vs-prop (the ones the occupancy grid should have stopped):');
    for (const w of report.worstPropVsProp.slice(0, 10)) {
      console.log(`  ${String(w.overlap).padStart(6)} m  ${w.a} x ${w.b}  at ${w.at.join(',')}`);
    }
  }
  console.log('\nfull report: shots/prop-audit.json');
  if (pageErrors.length) console.log(`\npage errors: ${pageErrors.length}`, pageErrors.slice(0, 3));
}

await browser.close();
