import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
p.setDefaultTimeout(240000);
const errs = [];
p.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
p.on('pageerror', e => errs.push('PAGEERROR ' + String(e && e.message)));
await p.goto('http://localhost:5173/', { waitUntil:'domcontentloaded', timeout: 120000 });
await p.waitForFunction('!!window.DEV', null, { timeout: 300000 });
const info = await p.evaluate(() => {
  const g = window.DEV.game;
  const eng = g.engine;
  return {
    tex: (window.__T && window.__T()) || null,
    children: eng.scene.children.length,
    nightFactor: eng.scene.userData.nightFactor,
    env: !!eng.scene.environment,
  };
});
console.log(JSON.stringify(info));
console.log('ERRORS', JSON.stringify(errs.slice(0,15), null, 1));
await b.close();
