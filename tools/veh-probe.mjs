#!/usr/bin/env node
/**
 * Cheap vehicle probe — counts, draw calls and triangles, no screenshots.
 *
 * A full shot sweep costs seven minutes a frame on this machine under load, and
 * most of the questions asked of the traffic module ("how many are driving?",
 * "did the fleet just cost 200k triangles?") do not need a picture at all.
 *
 *   node tools/veh-probe.mjs
 */
import { chromium } from 'playwright';

const b = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage'],
});
const p = await b.newPage({ viewport: { width: 320, height: 200 } });
p.setDefaultTimeout(300000);
const errs = [];
p.on('pageerror', (e) => errs.push(String(e.stack || e).split('\n')[0]));
await p.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction('!!window.DEV', null, { timeout: 300000 });

const out = await p.evaluate(() => {
  const g = window.__GAME__;
  const scene = g.engine.scene;
  let vehTris = 0, vehCalls = 0, vehInst = 0;
  let allTris = 0, allCalls = 0;
  scene.traverse((n) => {
    if (!n.isMesh || !n.geometry) return;
    const geo = n.geometry;
    const idx = geo.index ? geo.index.count : (geo.attributes.position?.count || 0);
    const count = n.isInstancedMesh ? n.count : 1;
    const t = (idx / 3) * count;
    allTris += t;
    allCalls += 1;
    if (/^inst-(veh:|vfx:(headbeam|hazard|wake|brake|indic))/.test(n.name)) {
      vehTris += t; vehCalls += 1; vehInst += count;
    }
  });
  const dbg = scene.userData.trafficDebug ? scene.userData.trafficDebug() : null;
  return {
    traffic: dbg,
    vehicles: { drawCalls: vehCalls, instances: vehInst, triangles: Math.round(vehTris) },
    scene: { drawCalls: allCalls, triangles: Math.round(allTris) },
    stats: window.DEV.stats(),
  };
});
console.log(JSON.stringify(out, null, 1));
console.log('page errors:', errs.length, errs.slice(0, 4));
await b.close();
