import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const SIZE = Number(process.env.SIZE || 520);
const b = await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
const p = await b.newPage({viewport:{width:SIZE,height:SIZE}});
p.setDefaultTimeout(300000);
await p.goto('http://localhost:5173/',{waitUntil:'domcontentloaded'});
const ready = () => p.waitForFunction('!!window.DEV && !!window.__GAME__',null,{timeout:300000});
const resilient = async (fn) => {
  for (let i=0;i<8;i++){ try { await ready(); return await fn(); }
    catch(e){ if(!/destroyed|__GAME__|Target closed|registry/.test(String(e))) throw e; await new Promise(r=>setTimeout(r,2500)); } }
  throw new Error('page kept reloading');
};
for (const s of JSON.parse(process.env.SHOTS)) {
  try {
    const r = await resilient(() => p.evaluate((s) => {
      const g = window.__GAME__;
      window.DEV.play(true); window.DEV.hideUI(true); window.DEV.clearBots();
      g.player.position.set(-9000,0,-9000);
      const cam = g.engine.camera;
      if (!cam.__aimPatched) {
        const base = Object.getPrototypeOf(cam).lookAt;
        cam.__aimPatched = true;
        cam.lookAt = function (x, y, z) { base.call(cam, x, (y||0) + (window.__AIMY||0), z); };
      }
      window.__AIMY = s.aimY ?? 0;
      let target=null, best=1e9;
      for (const c of g.registry.byId.values()) {
        if (c.kind!==s.kind) continue;
        const d = Math.abs(c.position.x - (s.nearX ?? 0)) + Math.abs(c.position.z - (s.nearZ ?? 0));
        if (d<best){best=d;target=c;}
      }
      if (!target) return { err: 'no ' + s.kind };
      let ax = target.position.x, az = target.position.z;
      if (s.aimTrim && target.object && target.object.children[1]) {
        // The marina's geometry is authored in world space, so the trim mesh's
        // own bounding box IS the fuel dock's world position.
        const geo = target.object.children[1].geometry;
        if (!geo.boundingBox) geo.computeBoundingBox();
        ax = (geo.boundingBox.min.x + geo.boundingBox.max.x) / 2;
        az = (geo.boundingBox.min.z + geo.boundingBox.max.z) / 2;
      }
      g.devCam = { x: ax + (s.dx||0), z: az + (s.dz||0), dist: s.dist, pitch: s.pitch, yaw: s.yaw ?? -35 };
      g.engine._camTarget.set(g.devCam.x, 0, g.devCam.z);
      window.DEV.render(s.frames || 14, 1/24);
      return { png: g.engine.renderer.domElement.toDataURL('image/png'),
               aim:[+ax.toFixed(1), +az.toFixed(1)] };
    }, s));
    if (r.err) { console.log(s.name, r.err); continue; }
    writeFileSync(`shots/rebuilt-water/${s.name}.png`, Buffer.from(r.png.split(',')[1],'base64'));
    console.log(s.name.padEnd(18), 'aim', JSON.stringify(r.aim));
  } catch (e) { console.log(s.name, 'FAILED', String(e).slice(0,100)); }
}
await b.close();
