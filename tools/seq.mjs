#!/usr/bin/env node
/**
 * Capture a SEQUENCE of frames of a single event.
 *
 * A still cannot show physics. This drives the hole through a chosen spot and
 * writes one PNG per simulated step, so the slide -> tip -> plunge sequence can
 * actually be reviewed (and regressions in it actually seen).
 *
 *   node tools/seq.mjs --at 128,150 --size 6 --frames 10 --step 0.10 --out shots/swallow
 *   node tools/seq.mjs --preset hole-mid --frames 8 --drive 1,0
 *
 * Flags:
 *   --at X,Z        world position to place the hole (default: densest cluster)
 *   --size R        hole radius in metres (default 6)
 *   --drive DX,DZ   direction to drive the hole while capturing (default: none;
 *                   the hole is nudged toward the nearest edible cluster)
 *   --frames N      number of PNGs (default 10)
 *   --step S        simulated seconds between frames (default 0.09)
 *   --dist D        camera distance (default: framed to the hole)
 *   --pitch P       camera pitch degrees (default 40)
 *   --w --h         viewport (default 900x560)
 *   --out DIR       output directory
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

const OUT = resolve(String(flag('out', 'shots/seq')));
const W = Number(flag('w', 900));
const H = Number(flag('h', 560));
const FRAMES = Number(flag('frames', 10));
const STEP = Number(flag('step', 0.09));
const SIZE = Number(flag('size', 6));
const PITCH = Number(flag('pitch', 40));
const DIST = flag('dist', null);
const AT = flag('at', null);
const DRIVE = flag('drive', null);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.setDefaultTimeout(300000);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e && e.stack ? e.stack : e)));

await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction('!!window.DEV', null, { timeout: 300000 });

/**
 * Vite HMR reloads the page whenever anything saves a source file, which during
 * active development is constantly. A reload destroys the execution context
 * mid-capture, so every step is wrapped: on loss we wait for the harness to come
 * back, re-apply the setup, and carry on rather than dying half way through.
 */
async function resilient(fn, reSetup) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!/Execution context was destroyed|__GAME__|Target closed|reading 'frame'/.test(String(e))) throw e;
      console.log('  (page reloaded — re-establishing state)');
      await page.waitForFunction('!!window.DEV', null, { timeout: 300000 });
      if (reSetup) await reSetup();
    }
  }
  throw new Error('page kept reloading; give the tree a moment and retry');
}

const applySetup = () => page.evaluate(([at, size, pitch, dist, drive]) => {
  const g = window.__GAME__;
  window.DEV.play(true);
  window.DEV.hideUI(true);
  window.DEV.clearBots();
  window.DEV.setSize(size);

  let x, z;
  if (at) {
    [x, z] = at.split(',').map(Number);
  } else {
    // Densest cluster of things this size of hole can actually take.
    let best = null, bestN = -1;
    const all = [...g.registry.byId.values()]
      .filter((c) => g.consume.canEat(g.player, c));
    for (let i = 0; i < all.length; i += 7) {
      const a = all[i];
      let n = 0;
      for (let j = 0; j < all.length; j += 3) {
        const b = all[j];
        if (Math.hypot(b.position.x - a.position.x, b.position.z - a.position.z) < 12) n++;
      }
      if (n > bestN) { bestN = n; best = a; }
    }
    x = best ? best.position.x : 0;
    z = best ? best.position.z : 0;
  }

  g.player.position.set(x, 0, z);
  g.player.velocity.set(0, 0, 0);
  if (drive) {
    const [dx, dz] = drive.split(',').map(Number);
    const L = Math.hypot(dx, dz) || 1;
    g.player.desiredDir.set(dx / L, dz / L);
    g.__seqDrive = true;
  } else {
    g.player.desiredDir.set(0, 0);
  }

  const d = dist ? Number(dist) : Math.max(26, 12 + size * 4.5);
  g.devCam = { x, z, dist: d, pitch, yaw: -35 };
  window.DEV.render(10, 1 / 24);
  return { x: Math.round(x), z: Math.round(z), dist: d };
}, [AT, SIZE, PITCH, DIST, DRIVE]);

const setup = await resilient(applySetup);
console.log(`hole at (${setup.x}, ${setup.z}), r=${SIZE}, cam dist ${setup.dist}`);

for (let f = 0; f < FRAMES; f++) {
  const info = await resilient(() => page.evaluate(([step, drive]) => {
    if (!window.__GAME__) throw new Error('__GAME__ gone');
    const g = window.__GAME__;
    // Advance the simulation in small sub-steps so the physics integrates the
    // same way it does at runtime, then draw once.
    const sub = 1 / 60;
    let left = step;
    while (left > 0) {
      const dt = Math.min(sub, left);
      if (drive) g.player.desiredDir.set(...drive.split(',').map(Number));
      g.frame(dt);
      left -= dt;
    }
    // Keep the camera on the hole while it drives.
    if (g.devCam) { g.devCam.x = g.player.position.x; g.devCam.z = g.player.position.z; }
    g.frame(1 / 240);
    return {
      attracted: g.consume.attracted ? g.consume.attracted.size : -1,
      falling: g.consume.falling.length,
      score: Math.round(g.player.score),
      r: +g.player.radius.toFixed(2),
    };
  }, [STEP, DRIVE]), applySetup);

  const file = join(OUT, `f${String(f).padStart(2, '0')}.png`);
  await page.screenshot({ path: file, timeout: 300000 });
  console.log(`  f${f}  attracted=${info.attracted} falling=${info.falling} score=${info.score} r=${info.r}`);
}

writeFileSync(join(OUT, 'errors.json'), JSON.stringify(errors, null, 2));
if (errors.length) {
  console.log(`\n⚠ ${errors.length} runtime error(s):`);
  for (const e of errors.slice(0, 6)) console.log('  ' + e.split('\n')[0]);
}
console.log(`\nWrote ${FRAMES} frames to ${OUT}`);
await browser.close();
process.exit(errors.length ? 1 : 0);
