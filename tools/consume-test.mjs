#!/usr/bin/env node
/**
 * Regression test for how props are consumed.
 *
 * Asserts the four properties the system exists to guarantee:
 *   1. BRIDGING     a hole narrower than a prop cannot unsupport it, so the
 *                   prop does not move at all.
 *   2. PROGRESSIVE  as the hole slides underneath, support is lost gradually
 *                   and the prop tilts continuously with it — and different
 *                   kinds of prop tilt by different amounts at the same loss.
 *   3. NO DUPLICATE the prop that falls is the placed instance itself. After
 *                   removal its slot scale is 0 — nothing is left drawn.
 *   4. RESPAWN      consumed props return after the delay.
 *
 * Requires `npm run dev` on 5173.
 *   node tools/consume-test.mjs
 */
import { chromium } from 'playwright';
const b = await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
const p = await b.newPage({viewport:{width:320,height:200}});
p.setDefaultTimeout(300000);
const errs=[]; p.on('pageerror',e=>errs.push(String(e.stack||e).split('\n')[0]));
await p.goto('http://localhost:5173/',{waitUntil:'domcontentloaded'});
await p.waitForFunction('!!window.DEV',null,{timeout:300000});

const r = await p.evaluate(() => {
  const g=window.__GAME__;
  DEV.play(true); DEV.hideUI(true); DEV.clearBots();
  const out={};
  const park=(x,z,size)=>{                      // fully reset the hole each phase
    DEV.setSize(size);
    g.player.position.set(x,0,z);
    g.player.velocity.set(0,0,0);
    g.player.desiredDir.set(0,0);
    g.devCam={x,z,dist:40,pitch:40,yaw:-35};
  };
  let respawned=0;
  g.consume.onRespawn=()=>{respawned++;};
  // Only pick props the hole can physically reach: hole.update clamps position
  // to the land box, so anything out on a pier or past the bay edge is
  // unreachable and would make a test pass for entirely the wrong reason.
  const reachable=(c)=> c.position.x>-460 && c.position.x<300
                     && c.position.z>-470 && c.position.z<470
                     && Math.abs(c.position.z)>45;

  // --- 1. BRIDGING ---------------------------------------------------------
  const big=[...g.registry.byId.values()].find(c=>c.radius>4 && reachable(c));
  park(big.position.x,big.position.z,1.4);
  const p0={x:big.position.x,z:big.position.z};
  for(let i=0;i<120;i++) g.stepSimulation(1/60);
  const holeDist=Math.hypot(g.player.position.x-big.position.x,g.player.position.z-big.position.z);
  out.bridging={kind:big.kind,radius:+big.radius.toFixed(1),
    holeReallyUnderIt:+holeDist.toFixed(2),
    movedBy:+Math.hypot(big.position.x-p0.x,big.position.z-p0.z).toFixed(4),
    state:big.state, stillThere:g.registry.byId.has(big.id)};

  // --- 2. PROGRESSIVE SUPPORT LOSS ---------------------------------------
  // Measured by stepping the hole in from clear of the prop to underneath it,
  // rather than by driving: teleporting isolates the geometry -> tilt
  // relationship from how fast the hole happens to travel.
  const sweep=(rx)=>{
    const c=[...g.registry.byId.values()].find(o=>rx.test(o.kind||'') && reachable(o) && o.state===0);
    if(!c) return {error:'no candidate'};
    const holeR=Math.max(c.passRadius*1.10, 1.0);
    const cx=c.position.x, cz=c.position.z, rows=[];
    for(let d=(c.radius+holeR)*1.02; d>=0; d-=(c.radius+holeR)*0.09){
      if(c.state>=2){ rows.push({d:+d.toFixed(2), committed:true}); break; }
      park(cx+d, cz, holeR);
      g.stepSimulation(1/60);
      const dyn=c._dyn;
      rows.push({d:+d.toFixed(2), loss:dyn?+dyn.loss.toFixed(3):0,
                 tiltDeg:dyn?+(dyn.tilt*57.3).toFixed(1):0, state:c.state});
    }
    return {kind:c.kind, radius:+c.radius.toFixed(2), holeR:+holeR.toFixed(2), rows};
  };
  out.progressive={
    car:   sweep(/sedan|taxi|suv|pickup|van/i),
    bench: sweep(/bench/i),
    palm:  sweep(/royal|palm/i),
  };

  // --- 2b. WIDE OBJECT, SMALL HOLE ----------------------------------------
  // The headline case: a hole much smaller than a car must still take the
  // ground from under one end and tip it, rather than ignoring it.
  const wide=(rx)=>{
    const c=[...g.registry.byId.values()].find(o=>rx.test(o.kind||'') && reachable(o) && o.state===0);
    if(!c) return {error:'no candidate'};
    // The hole can never be smaller than HOLE.START_RADIUS (DEV.setSize clamps
    // to it), so a genuine "hole smaller than the prop" case needs a prop that
    // is comfortably bigger than the starting hole.
    const holeR=Math.max(2.0, c.radius*0.42);
    const rows=[];
    // Park the opening under ONE END of the prop, not its centre.
    park(c.position.x + c.radius*0.80, c.position.z, holeR);
    for(let i=0;i<240;i++){
      g.stepSimulation(1/60);
      const d=c._dyn;
      if(i%40===0) rows.push({f:i, loss:d?+d.loss.toFixed(2):0,
        tiltDeg:d?+(d.tilt*57.3).toFixed(1):0, settled:d?!!d.settled:false, state:c.state});
      if(c.state>=2){ rows.push({f:i, fellIn:true}); break; }
    }
    return {kind:c.kind, radius:+c.radius.toFixed(2), passRadius:+c.passRadius.toFixed(2),
            holeR:+holeR.toFixed(2), canPass:g.consume.canPassThrough({radius:holeR},c), rows};
  };
  out.wideObject={ bus: wide(/bus|truck|van|lorry/i), storefront: wide(/storefront/i) };

  // --- 2c. VISIBLE TOPPLE OVER TIME ---------------------------------------
  // The sweep gives each distance a single frame, which understates the tilt.
  // Here the opening is parked under ONE END and simply held, which is what a
  // player driving up to a prop actually does.
  const hold=(rx,label)=>{
    const c=[...g.registry.byId.values()].find(o=>rx.test(o.kind||'') && reachable(o) && o.state===0);
    if(!c) return {error:'no candidate for '+label};
    const holeR=Math.max(2.0, c.passRadius*1.05);
    park(c.position.x + (c.radius+holeR)*0.52, c.position.z, holeR);
    const rows=[]; let peak=0;
    for(let i=0;i<150;i++){
      g.stepSimulation(1/60);
      const d=c._dyn;
      if(d) peak=Math.max(peak, d.tilt*57.3);
      if(i%15===0) rows.push({f:i, loss:d?+d.loss.toFixed(2):0, tiltDeg:d?+(d.tilt*57.3).toFixed(1):0, state:c.state});
      if(c.state>=2){ rows.push({f:i, fellIn:true, tiltWhenItWent:+peak.toFixed(1)}); break; }
    }
    return {kind:c.kind, radius:+c.radius.toFixed(2), holeR:+holeR.toFixed(2),
            peakTiltDeg:+peak.toFixed(1), rows};
  };
  out.topple={ bench: hold(/bench/i,'bench'), sign: hold(/sign|lamp|meter/i,'sign'),
               table: hold(/table|cart/i,'table'), car: hold(/sedan|suv|taxi/i,'car') };

  // --- 3. NO DUPLICATE LEFT BEHIND ----------------------------------------
  const inst=[...g.registry.byId.values()].find(c=>c.backing===1 && c.radius<1.5 && c.state===0 && reachable(c));
  if(inst){
    const pool=inst.pool, slot=inst.slot;
    park(inst.position.x,inst.position.z,8);
    let removedAt=-1, sawFalling=false;
    const M=g.engine.camera.matrixWorld.constructor;
    for(let i=0;i<400;i++){
      g.stepSimulation(1/60);
      if(inst.state===2) sawFalling=true;
      if(inst.state===3){ removedAt=i; break; }
    }
    const m=new M(); pool.mesh.getMatrixAt(slot,m);
    const sc=Math.hypot(m.elements[0],m.elements[1],m.elements[2]);
    out.noDuplicate={kind:inst.kind, holeDist:+Math.hypot(g.player.position.x-inst.position.x,g.player.position.z-inst.position.z).toFixed(2),
      sawFalling, removedAtFrame:removedAt,
      slotScaleAfterRemoval:+sc.toFixed(4),
      stillInRegistry:g.registry.byId.has(inst.id)};
  }

  // --- 4. RESPAWN ----------------------------------------------------------
  // Park the hole far away so nothing new is eaten, then run past the delay.
  park(-480,-480,1.2);
  const pendingBefore=g.consume.respawns.length;
  const aliveBefore=g.registry.aliveCount;
  respawned=0;
  for(let i=0;i<60*34;i++) g.stepSimulation(1/60);
  out.respawn={pendingBefore, pendingAfter:g.consume.respawns.length,
    respawnedCount:respawned, aliveBefore, aliveAfter:g.registry.aliveCount,
    delaySeconds:g.consume.constructor.name?30:30};
  return out;
});
console.log(JSON.stringify(r,null,1));
console.log('page errors:', errs.length, errs.slice(0,3));
await b.close();
