import { chromium } from 'playwright';
const b = await chromium.launch({ args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport:{width:640,height:360} });
p.on('pageerror', e => console.log('[PAGEERROR]', String(e).split('\n')[0]));
await p.goto('http://localhost:5173/', { waitUntil:'domcontentloaded', timeout:60000 });
const res = await p.evaluate(async () => {
  const t0 = performance.now();
  const [B, L] = await Promise.all([
    import('/src/world/buildings.js'),
    import('/src/world/cityLayout.js'),
  ]);
  const layout = L.buildLayout(20260803);
  let meshes = 0, tris = 0, buildings = 0;
  const fakeGroup = { add() {} };
  const kinds = {};
  const oversize = [];
  window.__THREE = await import('/node_modules/three/build/three.module.js');
  const ctx = {
    layout, Y_WALK: 0.155,
    group: () => fakeGroup,
    occupy() {}, isFree: () => true,
    addMesh(obj, opts) {
      buildings++;
      kinds[opts.kind] = (kinds[opts.kind] || 0) + 1;
      obj.updateMatrixWorld(true);
      const bx = new window.__THREE.Box3();
      bx.setFromObject(obj);
      const ex = Math.max(bx.max.x - bx.min.x, bx.max.z - bx.min.z);
      if (ex > opts.radius * 2.9) {
        oversize.push({ kind: opts.kind, ex: +ex.toFixed(1), r: +opts.radius.toFixed(1),
          hi: +bx.max.y.toFixed(1), x: +opts.position.x.toFixed(0), z: +opts.position.z.toFixed(0) });
      }
      obj.traverse((n) => {
        if (!n.isMesh) return;
        meshes++;
        const g = n.geometry;
        tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
      });
    },
  };
  try { B.buildBuildings(ctx); } catch (e) { return { error: String(e && e.stack || e).slice(0, 900) }; }
  return {
    ms: Math.round(performance.now() - t0), buildings, meshes,
    tris: Math.round(tris), fadeables: (ctx.fadeableBuildings || []).length, kinds, oversize: oversize.sort((a,b)=>b.ex/b.r-a.ex/a.r).slice(0, 8), nOver: oversize.length,
    zones: layout.blocks.reduce((a,b)=>{a[b.zone]=(a[b.zone]||0)+1;return a;},{}),
  };
});
console.log(JSON.stringify(res, null, 1));
await b.close();
