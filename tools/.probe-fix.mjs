import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl','--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.setDefaultTimeout(180000);
page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0,400)));
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('!!window.DEV', null, { timeout: 180000 });
const out = await page.evaluate(() => {
  const L = window.DEV.game.layout;
  const riv = L.river;
  const samples = [];
  for (let x = -520; x <= 340; x += 60) samples.push([x, +riv.centerAt(x).toFixed(1), +riv.halfAt(x).toFixed(1)]);
  return {
    riverKeys: Object.keys(riv),
    riverZ: riv.z, samples,
    roadsX: L.roadsX.map(r => ({ pos: r.pos, half: r.half, cls: r.cls, name: r.name })),
    roadsZ: L.roadsZ.map(r => ({ pos: r.pos, half: r.half, cls: r.cls, name: r.name })),
    bridges: L.bridges,
    isWaterAt0: [ L.isWater(0, 0), L.isWater(0, 20), L.isWater(0, 30), L.isWater(-300, 0), L.isWater(200, 0) ],
    blocksNearRiver: L.blocks.filter(b => Math.abs(b.z) < 40).length,
    layoutKeys: Object.keys(L),
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
