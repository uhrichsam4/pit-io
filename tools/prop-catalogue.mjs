#!/usr/bin/env node
/**
 * Photograph every prop kind in the city, one at a time, close up.
 *
 * In a busy street shot you cannot tell WHICH prop is letting the frame down —
 * a reviewer says "the props look cheap" and nobody can act on it. This puts
 * each kind alone in frame at a consistent distance and light, so quality can
 * be judged and fixed per kind.
 *
 *   node tools/prop-catalogue.mjs                      # every kind
 *   node tools/prop-catalogue.mjs --match bench,sign   # only matching kinds
 *   node tools/prop-catalogue.mjs --out shots/cat2 --size 360
 *
 * Writes one PNG per kind plus catalogue.json (kind, counts, measured size,
 * triangle count) so a reviewer can correlate what it looks like with what it
 * costs.
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const OUT = resolve(String(flag('out', 'shots/catalogue')));
const SIZE = Number(flag('size', 340));
const MATCH = flag('match', null);
const LIMIT = Number(flag('limit', 0));
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
page.setDefaultTimeout(300000);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.stack || e).split('\n')[0]));

await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction('!!window.DEV && !!window.__GAME__', null, { timeout: 300000 });

/**
 * Content agents are editing this tree while the catalogue runs, and every save
 * triggers an HMR reload that destroys the execution context mid-shoot. Retry
 * around it rather than dying two thirds of the way through 211 kinds.
 */
async function resilient(fn) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (!/Execution context was destroyed|__GAME__|registry|Target closed/.test(String(e))) throw e;
      await page.waitForFunction('!!window.DEV && !!window.__GAME__', null, { timeout: 300000 });
      await page.evaluate(() => {
        window.DEV.play(true); window.DEV.hideUI(true); window.DEV.clearBots();
        window.__GAME__.player.position.set(-9000, 0, -9000);
      }).catch(() => {});
    }
  }
  throw new Error('page kept reloading — try again when the tree is quiet');
}

/** One representative instance per kind, with its measured size and cost. */
const kinds = await resilient(() => page.evaluate((matchCsv) => {
  const g = window.__GAME__;
  window.DEV.play(true);
  window.DEV.hideUI(true);
  window.DEV.clearBots();
  // Park the hole far away so no prop is mid-topple while being photographed.
  g.player.position.set(-9000, 0, -9000);

  const filters = matchCsv ? String(matchCsv).split(',').map((s) => s.trim().toLowerCase()) : null;
  const best = new Map();
  for (const c of g.registry.byId.values()) {
    if (filters && !filters.some((f) => (c.kind || '').toLowerCase().includes(f))) continue;
    const e = best.get(c.kind);
    if (!e) best.set(c.kind, { c, n: 1 });
    else {
      e.n++;
      // Prefer an instance away from the map edge and out of the water, so the
      // backdrop is ordinary city rather than an accident of where it sits.
      const score = (x) => Math.abs(x.position.x) + Math.abs(x.position.z);
      if (score(c) < score(e.c)) e.c = c;
    }
  }

  const tri = (geo) => (geo?.index ? geo.index.count / 3
                                   : (geo?.attributes?.position?.count || 0) / 3);
  const out = [];
  for (const [kind, e] of best) {
    const c = e.c;
    let triangles = 0;
    if (c.backing === 1 && c.pool) triangles = tri(c.pool.geometry);
    else if (c.object) c.object.traverse((n) => { if (n.isMesh) triangles += tri(n.geometry); });
    out.push({
      kind, count: e.n, id: c.id,
      x: +c.position.x.toFixed(1), z: +c.position.z.toFixed(1),
      radius: +c.radius.toFixed(2), height: +c.height.toFixed(2),
      passRadius: +c.passRadius.toFixed(2),
      triangles: Math.round(triangles),
      backing: c.backing === 1 ? 'instanced' : 'mesh',
    });
  }
  out.sort((a, b) => a.kind.localeCompare(b.kind));
  return out;
}, MATCH));

const list = LIMIT > 0 ? kinds.slice(0, LIMIT) : kinds;
console.log(`${list.length} kind(s) to photograph -> ${OUT}`);

let shot = 0;
for (const k of list) {
  await resilient(() => page.evaluate(({ id, height, radius }) => {
    const g = window.__GAME__;
    const c = g.registry.byId.get(id);
    if (!c) return;
    // Frame from the object's own size so a cone and a tower are both filled.
    const extent = Math.max(radius * 2, height, 0.6);
    const dist = extent * 2.6 + 2.2;
    g.devCam = {
      x: c.position.x, z: c.position.z,
      dist,
      // Look down harder on flat things, more level on tall ones.
      pitch: height > radius * 2 ? 20 : 38,
      yaw: -35,
    };
    // Aim slightly above the base so the object sits in the middle of frame.
    g.engine._camTarget.set(c.position.x, 0, c.position.z);
    window.DEV.render(8, 1 / 24);
  }, k));

  const file = join(OUT, `${k.kind.replace(/[^\w.-]/g, '_')}.png`);
  try {
    await page.screenshot({ path: file, timeout: 120000 });
    shot++;
  } catch {
    console.log(`  ! timed out on ${k.kind}`);
  }
  if (shot % 25 === 0) console.log(`  ${shot}/${list.length}`);
}

writeFileSync(join(OUT, 'catalogue.json'), JSON.stringify({ kinds: list, errors }, null, 2));
console.log(`\nphotographed ${shot}/${list.length}`);
console.log(`index: ${join(OUT, 'catalogue.json')}`);
if (errors.length) console.log(`runtime errors: ${errors.length}`, errors.slice(0, 3));
await browser.close();
