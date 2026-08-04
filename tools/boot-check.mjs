#!/usr/bin/env node
/**
 * DOES THE GAME ACTUALLY RUN?
 *
 * Run this after ANY change to src/world/ or src/core/. It is the only check
 * that catches the class of bug `node --check` cannot see.
 *
 *   node tools/boot-check.mjs              # against the dev server on :5173
 *   node tools/boot-check.mjs --port 4173  # against a built bundle
 *   node tools/boot-check.mjs --json
 *
 * Exit 0 = the city built and nothing threw. Exit 1 = it is broken, and the
 * error is printed with the file and line.
 *
 * WHY THIS EXISTS. `gLoungeSofa` was named by the prop registry, given a
 * material and a tint palette, and placed by two functions — but the geometry
 * was never written. The module threw the instant the registry was evaluated
 * and the game did not boot at all. Every agent and every check in this project
 * was running `node --check`, which passed, because a ReferenceError is not a
 * syntax error: the file parses perfectly while being fatal. The game was dead
 * for an unknown length of time behind a wall of green checkmarks.
 *
 * A registry that names a function is a promise the parser does not verify.
 * Only executing it does.
 */

import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i < 0 ? d : argv[i + 1];
};
const AS_JSON = argv.includes('--json');
const PORT = Number(flag('port', 5173));
const BUDGET_MS = Number(flag('timeout', 420000));

const log = (...a) => { if (!AS_JSON) console.log(...a); };

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--disable-dev-shm-usage'],
});
// Small viewport on purpose: this check is about whether the world builds, and
// a big framebuffer under SwiftShader costs minutes for nothing.
const page = await browser.newPage({ viewport: { width: 480, height: 360 } });

const uncaught = [];
const errors = [];
page.on('pageerror', (e) => uncaught.push(String(e.stack || e).split('\n').slice(0, 5).join('\n    ')));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });

const t0 = Date.now();
let built = false;
try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('!!window.DEV && !!window.__GAME__', null, { timeout: BUDGET_MS });
  built = true;
} catch (e) {
  // Falling out here is usually a throw during the world build, which is
  // already captured above — report that rather than the unhelpful timeout.
  if (!uncaught.length) uncaught.push(`world never finished building: ${String(e.message).split('\n')[0]}`);
}

const stats = built ? await page.evaluate(() => {
  const g = window.__GAME__;
  const s = window.DEV.stats ? window.DEV.stats() : {};
  return {
    objects: g.registry ? g.registry.aliveCount : null,
    triangles: s.triangles, drawCalls: s.drawCalls,
    geometries: s.geometries, programs: s.programs,
    screens: (g.meta || g.shell)?.screens ? [...(g.meta || g.shell).screens.keys()].length : 0,
  };
}).catch(() => ({})) : {};

const secs = ((Date.now() - t0) / 1000).toFixed(1);
const ok = built && uncaught.length === 0;

if (AS_JSON) {
  console.log(JSON.stringify({ ok, port: PORT, seconds: +secs, stats, uncaught, errors }, null, 2));
} else {
  log(`\n${ok ? 'BOOT OK' : 'BOOT FAILED'}  (:${PORT}, ${secs}s)`);
  if (built) {
    log(`  objects ${stats.objects?.toLocaleString?.() ?? '?'}` +
        `  triangles ${stats.triangles ? (stats.triangles / 1e6).toFixed(2) + 'M' : '?'}` +
        `  draws ${stats.drawCalls ?? '?'}` +
        `  meta screens ${stats.screens}`);
  }
  for (const u of uncaught) log(`\n  UNCAUGHT: ${u}`);
  if (errors.length) {
    log(`\n  ${errors.length} console error(s):`);
    for (const e of [...new Set(errors)].slice(0, 8)) log(`    ${e}`);
  }
}

await browser.close();
process.exit(ok ? 0 : 1);
