import { chromium } from 'playwright';
const browser = await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
const page = await browser.newPage({viewport:{width:320,height:200}});
page.setDefaultTimeout(300000);
await page.goto('http://localhost:5173/',{waitUntil:'domcontentloaded'});
await page.waitForFunction('!!window.DEV',null,{timeout:300000});
const out = await page.evaluate(() => {
  const g = window.__GAME__;
  const res = { onRoad:{}, total:0 };
  for (const c of g.registry.byId.values()){
    res.total++;
    if (g.layout.isRoad && g.layout.isRoad(c.position.x, c.position.z)) res.onRoad[c.kind]=(res.onRoad[c.kind]||0)+1;
  }
  return res;
});
console.log('total', out.total);
for (const [k,n] of Object.entries(out.onRoad).sort((a,b)=>b[1]-a[1])) console.log('  ', k.padEnd(16), n);
await browser.close();
