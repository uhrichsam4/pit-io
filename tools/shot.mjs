#!/usr/bin/env node
/**
 * Headless screenshot harness for MIAMI DEVOUR.
 *
 * Boots the game in headless Chromium (SwiftShader WebGL), drives it into an
 * exact state through window.DEV, and writes PNGs. This is how every visual
 * review in this project is performed — no human in the loop, fully repeatable.
 *
 * Usage:
 *   node tools/shot.mjs --presets hole-small,brickell-skyline --out shots/round1
 *   node tools/shot.mjs --all --out shots/full --w 1600 --h 900
 *   node tools/shot.mjs --presets hole-mid --ui           # keep the HUD visible
 *   node tools/shot.mjs --script "DEV.setSize(20); DEV.devour(60);" --presets hole-mid
 *
 * Flags:
 *   --presets a,b,c   preset names (see src/dev/devtools.js)
 *   --all             every preset
 *   --out DIR         output directory (default: shots/latest)
 *   --w --h           viewport size (default 1600x900)
 *   --port            vite port (default 5173); the server must already be up
 *   --ui              keep the HUD/screens visible
 *   --bots            keep AI holes in frame
 *   --script "JS"     extra JS evaluated after the preset is applied
 *   --settle N        extra forced frames before capture (default 12)
 *   --json            print a JSON report to stdout
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const argv = process.argv.slice(2);
function flag(name, def = null) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  return v;
}
const has = (n) => argv.includes(`--${n}`);

const PORT = Number(flag('port', 5173));
const W = Number(flag('w', 1600));
const H = Number(flag('h', 900));
const OUT = resolve(String(flag('out', 'shots/latest')));
const SETTLE = Number(flag('settle', 8));
const EXTRA = flag('script', null);
const KEEP_UI = has('ui');
const KEEP_BOTS = has('bots');
const AS_JSON = has('json');

mkdirSync(OUT, { recursive: true });

const log = (...a) => { if (!AS_JSON) console.log(...a); };

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--disable-dev-shm-usage',
  ],
});
const page = await browser.newPage({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
});
// Software GL renders this city slowly; the defaults are far too tight.
page.setDefaultTimeout(180000);

const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => pageErrors.push(String(e && e.stack ? e.stack : e)));

const url = `http://localhost:${PORT}/`;
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

// Wait for the dev harness to install (i.e. the whole city finished building).
await page.waitForFunction('!!window.DEV', null, { timeout: 180000 });

const allPresets = await page.evaluate('Object.keys(window.DEV.PRESETS)');
let presets;
if (has('all')) presets = allPresets;
else {
  const raw = flag('presets', 'hole-small');
  presets = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}
const unknown = presets.filter((p) => !allPresets.includes(p));
if (unknown.length) {
  console.error(`Unknown preset(s): ${unknown.join(', ')}\nAvailable: ${allPresets.join(', ')}`);
  await browser.close();
  process.exit(2);
}

const report = { url, viewport: { w: W, h: H }, shots: [], errors: [] };

const DEV_RETRIES = 8;

/**
 * Run something against window.DEV, surviving a page reload.
 *
 * Several agents work this tree at once and every file they save makes Vite
 * full-reload the page. A reload mid-run wipes window.DEV, and the next
 * evaluate died with "Cannot read properties of undefined" — which looks
 * exactly like a code bug in whatever module was last touched, and had people
 * chasing ghosts. Re-wait for the harness and replay the step instead. The
 * reload also rebuilds the world, so the step must be replayed from the
 * preset, not resumed; that is why the caller passes the whole shot sequence.
 */
async function withDev(fn, what) {
  for (let attempt = 0; attempt < DEV_RETRIES; attempt++) {
    try {
      await page.waitForFunction('!!window.DEV', null, { timeout: 180000 });
      return await fn();
    } catch (e) {
      const gone = /window\.DEV|Cannot read properties of undefined|Execution context was destroyed|Target closed/.test(
        String(e && e.message)
      );
      if (!gone || attempt === DEV_RETRIES - 1) throw e;
      log(`  … page reloaded during ${what}; retrying (${attempt + 1}/${DEV_RETRIES - 1})`);
      // Back off: during a save storm several reloads land in a row, and
      // retrying instantly just races the next one.
      await page.waitForTimeout(700 + attempt * 600);
    }
  }
  return undefined;
}

for (const name of presets) {
  const shot = await withDev(async () => {
    await page.evaluate(
      ([n, keepUI, keepBots, settle, extra]) => {
        window.DEV.shot(n, { showUI: keepUI, clearBots: !keepBots });
        if (keepUI) window.DEV.hideUI(false);
        if (extra) {
          // eslint-disable-next-line no-eval
          (0, eval)(extra);
        }
        window.DEV.render(settle);
        return true;
      },
      [name, KEEP_UI, KEEP_BOTS, SETTLE, EXTRA]
    );
    // A couple of real animation frames so anything time-based has settled.
    await page.waitForTimeout(220);
    // The braces matter. Every DEV method returns `this` for chaining, and
    // playwright serialises whatever an evaluate resolves to — so returning
    // DEV drags the entire game object graph across the bridge and dies with
    // "object reference chain is too long" once the scene gets deep enough.
    await page.evaluate((n) => { window.DEV.render(n); }, 4);

    const file = join(OUT, `${name}.png`);
    await page.screenshot({ path: file, timeout: 180000 });
    // Read stats before anything can reload us, so the row always matches the
    // frame that was just captured.
    const stats = await page.evaluate('window.DEV.stats()');
    const note = await page.evaluate((n) => window.DEV.PRESETS[n].note, name);
    return { preset: name, file, note, stats };
  }, name);

  report.shots.push(shot);
  log(`✓ ${name.padEnd(20)} -> ${shot.file}   [${shot.stats.drawCalls} calls, r=${shot.stats.playerRadius}]`);
}

report.errors = [...pageErrors, ...consoleErrors];
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));

if (report.errors.length) {
  log(`\n⚠ ${report.errors.length} runtime error(s):`);
  for (const e of report.errors.slice(0, 12)) log('  ' + e.split('\n')[0]);
}

if (AS_JSON) console.log(JSON.stringify(report, null, 2));
else log(`\nWrote ${report.shots.length} shot(s) to ${OUT}`);

await browser.close();
process.exit(report.errors.length ? 1 : 0);
