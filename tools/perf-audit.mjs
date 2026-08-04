#!/usr/bin/env node
/**
 * Where the frame actually goes.
 *
 * Reports triangles and draw calls per instanced pool and per mesh group, plus
 * the split between the beauty pass and the shadow pass — so optimisation is
 * aimed at the top of a measured list rather than at whatever seems expensive.
 */
import { chromium } from 'playwright';
const b = await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
const p = await b.newPage({viewport:{width:640,height:400}});
p.setDefaultTimeout(300000);
await p.goto('http://localhost:5173/',{waitUntil:'domcontentloaded'});
await p.waitForFunction('!!window.DEV',null,{timeout:300000});

const r = await p.evaluate(() => {
  const g = window.__GAME__, s = g.engine.scene;
  DEV.shot('hole-mid');

  const tri = (geo) => {
    if (!geo) return 0;
    return geo.index ? geo.index.count / 3 : (geo.attributes.position?.count || 0) / 3;
  };

  const pools = [], groups = new Map();
  let instTris = 0, instCasters = 0, meshTris = 0, meshCount = 0, meshCasters = 0;

  s.traverse((n) => {
    if (n.isInstancedMesh) {
      const t = tri(n.geometry) * n.count;
      instTris += t;
      if (n.castShadow) instCasters += t;
      pools.push({ name: n.name || 'inst', count: n.count, triEach: Math.round(tri(n.geometry)),
                   tris: Math.round(t), shadow: !!n.castShadow });
    } else if (n.isMesh) {
      const t = tri(n.geometry);
      meshTris += t; meshCount++;
      if (n.castShadow) meshCasters += t;
      let root = n; while (root.parent && root.parent !== s) root = root.parent;
      const key = root.name || root.type;
      const e = groups.get(key) || { tris: 0, meshes: 0 };
      e.tris += t; e.meshes++; groups.set(key, e);
    }
  });

  const casters = pools.filter(x => x.shadow).sort((a, b2) => b2.tris - a.tris);
  pools.sort((a, b2) => b2.tris - a.tris);
  const grp = [...groups.entries()].map(([k, v]) => ({ group: k, meshes: v.meshes, tris: Math.round(v.tris) }))
                                   .sort((a, b2) => b2.tris - a.tris);
  const info = g.engine.renderer.info;
  return {
    reported: { drawCalls: info.render.calls, triangles: info.render.triangles },
    instanced: { pools: pools.length, tris: Math.round(instTris), shadowTris: Math.round(instCasters) },
    meshes: { count: meshCount, tris: Math.round(meshTris), shadowTris: Math.round(meshCasters) },
    topPools: pools.slice(0, 8),
    topCasters: casters.slice(0, 18),
    casterPools: casters.length,
    topGroups: grp.slice(0, 12),
  };
});
console.log('reported  ', JSON.stringify(r.reported));
console.log('instanced ', JSON.stringify(r.instanced));
console.log('meshes    ', JSON.stringify(r.meshes));
console.log('\ntop pools by triangles:');
for (const x of r.topPools) console.log(`  ${String(x.name).padEnd(22)} ${String(x.count).padStart(6)} x ${String(x.triEach).padStart(5)} = ${String(x.tris).padStart(8)}  shadow:${x.shadow}`);
console.log(`\ntop SHADOW CASTERS (${r.casterPools} casting pools):`);
for (const x of r.topCasters) console.log(`  ${String(x.name).padEnd(24)} ${String(x.count).padStart(6)} x ${String(x.triEach).padStart(5)} = ${String(x.tris).padStart(8)}`);
console.log('\ntop mesh groups:');
for (const x of r.topGroups) console.log(`  ${String(x.group).padEnd(22)} ${String(x.meshes).padStart(5)} meshes ${String(x.tris).padStart(9)} tris`);
await b.close();
