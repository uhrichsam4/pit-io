import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
const OUT = resolve(process.argv[2] || 'shots/bld-iso');
const VIEWS = {
  'brickell-skyline': { x: 110, z: 270, dist: 430, pitch: 30, yaw: 48 },
  'downtown-wide': { x: 80, z: -260, dist: 470, pitch: 33, yaw: 40 },
  'menu-hero': { x: 120, z: 250, dist: 560, pitch: 22, yaw: 62 },
  'street-level': { x: 100, z: -200, dist: 58, pitch: 30, yaw: -35 },
  'hole-big': { x: 110, z: 230, dist: 340, pitch: 50, yaw: -35 },
  'construction': { x: -121, z: 54, dist: 155, pitch: 34, yaw: -35 },
  'rooftops': { x: 120, z: 240, dist: 300, pitch: 62, yaw: 30 },
  'intersection': { x: 128, z: 194, dist: 125, pitch: 58, yaw: -35 },
  'downtown-civic': { x: -40, z: -190, dist: 200, pitch: 34, yaw: 45 },
  'site-close': { x: -121, z: 52, dist: 105, pitch: 26, yaw: -30 },
  'shops': { x: 96, z: -238, dist: 90, pitch: 34, yaw: 40 },
  'arena': { x: 252, z: -410, dist: 200, pitch: 30, yaw: 55 },
};
const names = (process.argv[3] || 'brickell-skyline').split(',');
mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport:{width:1400,height:800}, deviceScaleFactor:1 });
p.setDefaultTimeout(180000);
const errs=[]; p.on('pageerror', e=>errs.push(String(e).split('\n')[0]));
p.on('console', m=>{ if(m.type()==='error') errs.push(m.text().slice(0,200)); });
await p.goto('http://localhost:5173/tools/_bld.html', { waitUntil:'domcontentloaded', timeout:60000 });
await p.waitForFunction('!!window.BLD_READY', null, { timeout: 180000 });
console.log('stats', JSON.stringify(await p.evaluate('window.BLD.stats()')));
for (const n of names) {
  const v = VIEWS[n]; if (!v) { console.log('unknown view', n); continue; }
  // Six agents share this dev server; any of their saves triggers a full
  // reload that would otherwise leave us screenshotting a blank page.
  await p.waitForFunction('!!window.BLD_READY', null, { timeout: 180000 });
  await p.evaluate((vv)=>window.BLD.shot(vv, 5), v);
  await p.screenshot({ path: join(OUT, n + '.png'), timeout: 180000 });
  console.log('shot', n, JSON.stringify(await p.evaluate('window.BLD.stats()')));
}
console.log('errors', errs.slice(0,6));
await b.close();
