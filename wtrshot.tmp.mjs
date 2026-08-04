import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

/* The project's prop-catalogue drives page.screenshot(), and under the load
   this machine is carrying that path times out and hands back a flat navy
   frame. Reading the drawing buffer inside the same task as the render skips
   the compositor entirely and is reliable. It also lets the aim point rise off
   y=0, which matters for anything standing on a 1.36 m seawall coping. */
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

const shots = JSON.parse(process.env.SHOTS);
for (const s of shots) {
  try {
    const r = await resilient(() => p.evaluate((s) => {
      const g = window.__GAME__;
      window.DEV.play(true); window.DEV.hideUI(true); window.DEV.clearBots();
      g.player.position.set(-9000,0,-9000);
      const cam = g.engine.camera;
      if (!cam.__aimPatched) {
        const base = THREE_lookAt_base(cam);
        cam.__aimPatched = true;
        cam.lookAt = function (x, y, z) { base.call(cam, x, (y||0) + (window.__AIMY||0), z); };
      }
      function THREE_lookAt_base(c){ return Object.getPrototypeOf(c).lookAt; }
      window.__AIMY = s.aimY ?? 0;

      let target=null, best=1e9;
      for (const c of g.registry.byId.values()) {
        if (c.kind!==s.kind) continue;
        const d = Math.abs(c.position.x - (s.nearX ?? 0)) + Math.abs(c.position.z - (s.nearZ ?? 0));
        if (d<best){best=d;target=c;}
      }
      if (!target) return { err: 'no ' + s.kind };
      let ax = target.position.x, az = target.position.z;
      if (s.aimTrim && target.object) {
        // Aim at the marina's painted joinery (the fuel dock), not the deck centre.
        const box = new (Object.getPrototypeOf(g.engine.scene).constructor === Object ? null : window.__THREEBox3 || Object)();
      }
      g.devCam = { x: ax + (s.dx||0), z: az + (s.dz||0), dist: s.dist, pitch: s.pitch, yaw: s.yaw ?? -35 };
      g.engine._camTarget.set(g.devCam.x, 0, g.devCam.z);
      window.DEV.render(s.frames || 14, 1/24);
      const gl = g.engine.renderer;
      return { png: gl.domElement.toDataURL('image/png'),
               pos:[+target.position.x.toFixed(1),+target.position.y.toFixed(2),+target.position.z.toFixed(1)] };
    }, s));
    if (r.err) { console.log(s.name, r.err); continue; }
    writeFileSync(`shots/rebuilt-water/${s.name}.png`, Buffer.from(r.png.split(',')[1],'base64'));
    console.log(s.name.padEnd(18), 'obj at', JSON.stringify(r.pos));
  } catch (e) { console.log(s.name, 'FAILED', String(e).slice(0,100)); }
}
await b.close();
