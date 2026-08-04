import { chromium } from 'playwright';
const b = await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
const p = await b.newPage({viewport:{width:400,height:400}});
p.setDefaultTimeout(300000);
await p.goto('http://localhost:5173/',{waitUntil:'domcontentloaded'});
const ready = () => p.waitForFunction('!!window.DEV && !!window.__GAME__',null,{timeout:300000});
await ready();
const shoot = async (name, kind, dist, pitch, nearest=true) => {
  await ready();
  const info = await p.evaluate(([kind, dist, pitch, nearest]) => {
    const g = window.__GAME__;
    window.DEV.play(true); window.DEV.hideUI(true); window.DEV.clearBots();
    g.player.position.set(-9000,0,-9000);
    let target=null, best=1e9;
    for (const c of g.registry.byId.values()) {
      if (c.kind!==kind) continue;
      const s = Math.abs(c.position.x)+Math.abs(c.position.z);
      if (!nearest) { target=c; break; }
      if (s<best){best=s;target=c;}
    }
    if (!target) return { err: 'no ' + kind };
    const extent = Math.max(target.radius*2, target.height, 0.6);
    g.devCam = { x: target.position.x, z: target.position.z,
                 dist: dist ?? (extent*2.6+2.2), pitch: pitch ?? 38, yaw: -35 };
    g.engine._camTarget.set(target.position.x, 0, target.position.z);
    window.DEV.render(10, 1/24);
    const cam = g.engine.camera;
    return { pos:[+target.position.x.toFixed(1),+target.position.z.toFixed(1)],
             camY:+cam.position.y.toFixed(2), calls:g.engine.renderer.info.render.calls };
  }, [kind, dist, pitch, nearest]);
  console.log(name.padEnd(16), JSON.stringify(info));
  await p.screenshot({path:`shots/rebuilt-water/_d-${name}.png`, timeout:150000});
};
await shoot('bol-near', 'mooringBollard');
await shoot('bol-high', 'mooringBollard', 70, 45);
await shoot('yacht', 'motorYacht');
await shoot('hydrant', 'hydrant');
await b.close();
