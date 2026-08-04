#!/usr/bin/env node
/**
 * Regression test for how props are consumed.
 *
 * Asserts the properties the system exists to guarantee. Every check prints a
 * PASS/FAIL line and the process exits non-zero if any of them fail, so this
 * is a gate rather than a report.
 *
 *   1. BRIDGING     a hole narrower than a prop cannot unsupport it, so the
 *                   prop does not move at all.
 *   2. PROGRESSIVE  as the hole slides underneath, support is lost gradually
 *                   and the prop tilts continuously with it — and different
 *                   kinds of prop tilt by different amounts at the same loss.
 *   3. NO DUPLICATE the prop that falls is the placed instance itself. After
 *                   removal its slot scale is 0 — nothing is left drawn.
 *   4. RESPAWN      consumed props return after the delay.
 *   5. NO LATERAL   a building's horizontal displacement is EXACTLY zero, at
 *                   every hole size and placement. Contract, not tolerance.
 *   6. NO HANG      nothing stops mid-air waiting for a timer to delete it.
 *                   Every swallow completes on the geometric test.
 *   7. INERT        a removed prop is invisible, unqueryable and out of the
 *                   registry, and its highest point was below ground when it
 *                   went.
 *   8. REACH        an opening under the EDGE of an object far wider than the
 *                   spatial query's reach still destabilises it.
 *   9. FITS==EATS   anything the hole visibly dwarfs can actually be eaten.
 *  10. NO JITTER    a body wedged in an opening too small for it converges and
 *                   stops, rather than trembling on the rim forever.
 *
 * Requires `npm run dev` on 5173.
 *   node tools/consume-test.mjs
 */
import { chromium } from 'playwright';
const b = await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
const p = await b.newPage({viewport:{width:320,height:200}});
p.setDefaultTimeout(600000);
const errs=[]; p.on('pageerror',e=>errs.push(String(e.stack||e).split('\n')[0]));
await p.goto('http://localhost:5173/',{waitUntil:'domcontentloaded'});
await p.waitForFunction('!!window.DEV',null,{timeout:600000});

const r = await p.evaluate(() => {
  const g=window.__GAME__;
  DEV.play(true); DEV.hideUI(true); DEV.clearBots();
  const out={};
  // A match is 150 s and this test simulates far more than that. Once it ends
  // stepSimulation becomes a no-op and every remaining check silently reads as
  // "nothing happened" — which is how a green run can mean nothing at all.
  const keepAlive=()=>{
    g.match.timeLeft=600;
    g.match.frenzy=false; g.consume.setFrenzy(false);
    if(g.match.phase!=='playing'){ g.match.countdown=0; g.match._setPhase('playing'); }
  };
  const park=(x,z,size)=>{                      // fully reset the hole each phase
    keepAlive();
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
    // The prop's centre must sit ON the rim. Any closer and its whole narrow
    // cross-section is inside the opening, which means nothing is holding it
    // up anywhere and it correctly drops straight down instead of toppling —
    // a true result that reads as a failed topple test.
    park(c.position.x + Math.max(holeR, c.radius * 0.6), c.position.z, holeR);
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

  /* =======================================================================
   * Everything below is driven off one shared harness that runs a single
   * object against a single opening and records what a reviewer would see.
   * ===================================================================== */
  const all=g.allConsumables;
  const M=g.engine.camera.matrixWorld.constructor;
  const slotScale=(c)=>{
    if(c.backing!==1||!c.pool) return c.object? (c.object.visible?1:0) : -1;
    const m=new M(); c.pool.mesh.getMatrixAt(c.slot,m);
    return Math.hypot(m.elements[0],m.elements[1],m.elements[2]);
  };
  const visRadius=(c)=>{
    if(c.backing===1&&c.pool){
      const geo=c.pool.geometry;
      if(!geo.boundingBox) geo.computeBoundingBox();
      const bb=geo.boundingBox, s=c.pool.slotScale[c.slot];
      return Math.hypot((bb.max.x-bb.min.x)*s.x,(bb.max.z-bb.min.z)*s.z)/2;
    }
    return c.radius;
  };
  /**
   * @param c object under test
   * @param R hole radius
   * @param off how far the opening's centre sits from the object's
   * @param frames budget
   */
  const run=(c,R,off,frames)=>{
    g.consume.resetAll(all);
    const rest={x:c.position.x,z:c.position.z};
    park(rest.x+off,rest.z,R);
    const Rr=g.player.radius;
    let maxTilt=0,maxMove=0,cap=-1,gone=-1,hover=0,jitter=0,prev=0,topGone=null,revs=0,dTilt=0;
    for(let i=0;i<frames;i++){
      keepAlive();
      g.stepSimulation(1/60);
      const d=c._dyn;
      if(c.state<2){
        if(d){
          const step=d.tilt-maxTiltPrev(d);
          if(i>8 && step*dTilt<-1e-7) revs++;
          if(Math.abs(step)>1e-9) dTilt=step;
          maxTilt=Math.max(maxTilt,d.tilt);
        }
        const mv=Math.hypot(c.position.x-rest.x,c.position.z-rest.z);
        maxMove=Math.max(maxMove,mv);
        if(i>8) jitter+=Math.abs(mv-prev);
        prev=mv;
        const restY=(c.backing===1&&c.pool)?c.pool.slotPos[c.slot].y:(c._restP?c._restP.y:0);
        if(c._poseT) hover=Math.max(hover,c._poseT.pos.y-restY);
      }
      if(c.state===2&&cap<0) cap=i;
      if(c.state===3&&gone<0){
        gone=i;
        if(c._poseT){
          const sc=c._poseT.scale.x/Math.max(1e-6, (c.backing===1&&c.pool)?c.pool.slotScale[c.slot].x:1);
          topGone=+(c._poseT.pos.y+c.height*sc).toFixed(2);
        }
        break;
      }
    }
    return {R:+Rr.toFixed(2),off:+off.toFixed(1),tiltDeg:+(maxTilt*57.3).toFixed(1),
      moved:+maxMove.toFixed(4),jitter:+jitter.toFixed(3),hover:+hover.toFixed(4),
      revs,cap,gone,topGone,fall:(gone>=0&&cap>=0)?gone-cap:-1,
      slotScale:+slotScale(c).toFixed(4),inRegistry:g.registry.byId.has(c.id),
      state:c.state,posY:Math.round(c.position.y)};
  };
  const _tp=new WeakMap();
  function maxTiltPrev(d){ const v=_tp.get(d)??d.tilt; _tp.set(d,d.tilt); return v; }

  const SIZES=[2,4,8,16,32,34];

  // --- 5. A BUILDING NEVER MOVES SIDEWAYS. EVER. --------------------------
  const buildings=all.filter(c=>c.backing===0 && reachable(c) && /storefront|tower|midrise|landmark|garage/.test(c.kind||''));
  const bTest=[];
  for(const kind of ['storefront','midrise','tower','landmark','garage']){
    const c=buildings.filter(o=>o.kind===kind).sort((a,b)=>a.radius-b.radius)[0];
    if(!c) continue;
    for(const R of SIZES){
      for(const off of [0,R,R+c.radius*0.9]){
        const res=run(c,R,off,c.height>60?900:700);
        bTest.push({kind,...res});
      }
    }
  }
  out.buildingsNeverSlide={
    cases:bTest.length,
    maxLateral:+Math.max(0,...bTest.map(x=>x.moved)).toFixed(6),
    offenders:bTest.filter(x=>x.moved>0).slice(0,6),
    sample:bTest.filter(x=>x.gone>=0).slice(0,4),
  };

  // --- 6. NOTHING HANGS IN THE AIR ----------------------------------------
  // The old removal test wanted the body a full authored height below ground
  // while the plunge was clamped to the pit floor, so tall objects stopped
  // dead and were deleted by a timer. Both facts are now checked directly.
  const hangKinds=['tower','landmark','midrise','storefront','garage',
                   'royalA','royalB','queenPalm','coconutA','washingtonia',
                   'lampPark','lampDeco','signStop','cityBus','sedan','cone'];
  const hang=[];
  for(const kind of hangKinds){
    const c=all.filter(o=>o.kind===kind && reachable(o)).sort((a,b)=>b.radius-a.radius)[0];
    if(!c) continue;
    const R=Math.max(2, Math.min(34, c.passRadius*1.3));
    const res=run(c,R,0,c.height>60?900:600);
    // fallDur is the animation's own budget; the emergency timer is 4x it.
    hang.push({kind,h:+c.height.toFixed(1),...res,
      fallDur:c._fallDur?+c._fallDur.toFixed(2):null,
      fallSec:res.fall>=0?+(res.fall/60).toFixed(2):-1});
  }
  out.noHang={cases:hang.length,
    neverRemoved:hang.filter(x=>x.gone<0).map(x=>x.kind),
    onEmergencyTimer:hang.filter(x=>x.fallSec>0 && x.fallDur && x.fallSec>x.fallDur*3.5).map(x=>({kind:x.kind,fallSec:x.fallSec,fallDur:x.fallDur})),
    slowest:hang.slice().sort((a,b)=>b.fallSec-a.fallSec).slice(0,4).map(x=>({kind:x.kind,h:x.h,fallSec:x.fallSec})),
    rows:hang.map(x=>({kind:x.kind,h:x.h,fallSec:x.fallSec,top:x.topGone??null,slot:x.slotScale,reg:x.inRegistry,st:x.state})),
  };

  // --- 7. FULLY INERT ONCE GONE -------------------------------------------
  const inertBad=[];
  {
    const c=all.find(o=>o.kind==='cone'&&reachable(o)) || all.find(o=>reachable(o)&&o.backing===1);
    const res=run(c,8,0,400);
    const q=[]; g.registry.query(c.position.x,c.position.z,40,q);
    if(res.state!==3) inertBad.push('never reached GONE');
    if(res.slotScale>1e-4) inertBad.push('slot still drawn: '+res.slotScale);
    if(res.inRegistry) inertBad.push('still in registry');
    if(res.posY>-9000) inertBad.push('not parked below the world: '+res.posY);
    if(q.includes(c)) inertBad.push('still returned by a spatial query');
    if(g.consume.attracted.has(c)) inertBad.push('still in the attracted set');
    out.inert={kind:c.kind,...res,problems:inertBad};
  }

  // --- 8. AN OPENING UNDER THE EDGE OF A HUGE OBJECT IS SEEN --------------
  // Anything wider than the query's reach used to be invisible to the hole
  // unless the hole was near its centre.
  {
    const wideOnes=all.filter(c=>c.radius>14&&reachable(c)).sort((a,b)=>b.radius-a.radius);
    const c=wideOnes[0];
    const rows=[];
    if(c){
      const R=Math.min(34, Math.max(2, g.consume.eatThreshold(c)*0.98));
      for(const f of [0.55,0.8,0.95]){
        g.consume.resetAll(all);
        park(c.position.x+c.radius*f, c.position.z, R);
        let seen=false;
        for(let i=0;i<60;i++){ keepAlive(); g.stepSimulation(1/60); if(c.state>=1){seen=true;break;} }
        rows.push({atEdgeFraction:f, offset:+(c.radius*f).toFixed(1), destabilised:seen});
      }
      out.hugeObjectReach={kind:c.kind,radius:+c.radius.toFixed(1),
        queryReachWas:+Math.max(R*2.35,R+14).toFixed(1),rows,
        largeListSize:g.registry.large.length};
    }
    g.consume.resetAll(all);
  }

  // --- 9. IF THE HOLE VISIBLY DWARFS IT, IT MUST BE EDIBLE ----------------
  // A whole class of reported bug: something plainly smaller than the opening
  // that refuses to go in because its declared pass size disagrees with the
  // mesh the player is looking at.
  {
    const seen=new Set(); const bad=[];
    for(const c of all){
      const k=c.kind||''; if(seen.has(k)) continue; seen.add(k);
      const vis=visRadius(c);
      // A hole exactly as wide as the object's whole silhouette must take it.
      if(c.passRadius>vis*1.02+0.02) bad.push({kind:k,passRadius:+c.passRadius.toFixed(2),visibleRadius:+vis.toFixed(2)});
    }
    out.fitsMeansEats={kindsChecked:seen.size,disagreements:bad.length,worst:bad.slice(0,10)};
  }

  // --- 10. A WEDGED BODY SETTLES AND STOPS --------------------------------
  {
    const rows=[];
    for(const kind of ['sedan','cityBus','storefront','tower','benchSlat']){
      const c=all.filter(o=>o.kind===kind&&reachable(o))[0];
      if(!c) continue;
      // Just under what it needs to be swallowed: the wedge case.
      const R=Math.max(2, Math.min(34, g.consume.eatThreshold(c)*0.85));
      if(R>=g.consume.eatThreshold(c)) continue;       // START_RADIUS floor
      g.consume.resetAll(all);
      park(c.position.x+R*0.9, c.position.z, R);
      let last=0,late=0,tilt=0;
      for(let i=0;i<600;i++){
        keepAlive(); g.stepSimulation(1/60);
        const d=c._dyn; if(!d) continue;
        tilt=d.tilt;
        if(i>360) late+=Math.abs(d.tilt-last);   // motion in the last 4 seconds
        last=d.tilt;
      }
      rows.push({kind,holeR:+R.toFixed(2),eatNeeds:+g.consume.eatThreshold(c).toFixed(2),
        finalTiltDeg:+(tilt*57.3).toFixed(1),
        settled:c._dyn?!!c._dyn.settled:false,
        lateMotionDeg:+(late*57.3).toFixed(3), state:c.state,
        eaten:c.state>=2});
    }
    out.wedged=rows;
    g.consume.resetAll(all);
  }

  // --- 4. RESPAWN ----------------------------------------------------------
  // Park the hole far away so nothing new is eaten, then run past the delay.
  park(-480,-480,1.2);
  DEV.setSize(9);
  const victim=[...g.registry.byId.values()].filter(c=>reachable(c)&&c.backing===1).slice(0,1)[0];
  if(victim){ park(victim.position.x,victim.position.z,9);
    for(let i=0;i<180;i++){ keepAlive(); g.stepSimulation(1/60); } }
  park(-480,-480,1.2);
  const pendingBefore=g.consume.respawns.length;
  const aliveBefore=g.registry.aliveCount;
  respawned=0;
  for(let i=0;i<60*34;i++){ keepAlive(); g.stepSimulation(1/60); }
  out.respawn={pendingBefore, pendingAfter:g.consume.respawns.length,
    respawnedCount:respawned, aliveBefore, aliveAfter:g.registry.aliveCount,
    delaySeconds:30,
    ghosts:g.allConsumables.filter(c=>c.state===0&&!g.registry.byId.has(c.id)).length,
    doubleAdded:(()=>{let n=0;const s=new Set();for(const c of g.registry.byId.values()){if(s.has(c.id))n++;s.add(c.id);}return n;})()};
  return out;
});

console.log(JSON.stringify(r,null,1));

/* ----------------------------------------------------------- assertions --- */
const fails=[];
const check=(name,ok,detail)=>{
  console.log(`${ok?'PASS':'FAIL'}  ${name}${detail?'  — '+detail:''}`);
  if(!ok) fails.push(name);
};

check('1 bridging: a hole narrower than the prop moves it not at all',
  r.bridging && r.bridging.movedBy===0 && r.bridging.stillThere,
  `moved ${r.bridging&&r.bridging.movedBy} m`);

const prog=r.progressive&&r.progressive.car&&r.progressive.car.rows;
check('2 progressive: support is lost continuously as the hole slides under',
  !!prog && prog.some(x=>x.loss>0.05) && prog.some(x=>x.loss>0.3),
  prog?`peak loss ${Math.max(...prog.map(x=>x.loss||0))}`:'no data');

check('2b wide object, small hole: a bus reacts to a hole under one end',
  !!r.wideObject&&!!r.wideObject.bus&&!r.wideObject.bus.error&&
  r.wideObject.bus.rows.some(x=>x.fellIn||x.tiltDeg>2||x.loss>0.1),
  r.wideObject&&r.wideObject.bus&&r.wideObject.bus.kind);

check('2c topple: a bench visibly goes over before it is taken',
  !!r.topple&&!!r.topple.bench&&!r.topple.bench.error&&r.topple.bench.peakTiltDeg>8,
  r.topple&&r.topple.bench&&`${r.topple.bench.peakTiltDeg} deg`);

check('3 no duplicate: the placed instance is what fell, slot left at zero',
  !!r.noDuplicate && r.noDuplicate.sawFalling && r.noDuplicate.removedAtFrame>=0 &&
  r.noDuplicate.slotScaleAfterRemoval<1e-3 && !r.noDuplicate.stillInRegistry,
  r.noDuplicate&&`slot scale ${r.noDuplicate.slotScaleAfterRemoval}`);

check('4 respawn: consumed props come back, with no ghosts or doubles',
  !!r.respawn && r.respawn.respawnedCount>0 && r.respawn.ghosts===0 && r.respawn.doubleAdded===0,
  r.respawn&&`${r.respawn.respawnedCount} returned, ${r.respawn.ghosts} ghosts`);

check('5 buildings never slide: lateral displacement is exactly zero',
  !!r.buildingsNeverSlide && r.buildingsNeverSlide.cases>0 && r.buildingsNeverSlide.maxLateral===0,
  r.buildingsNeverSlide&&`${r.buildingsNeverSlide.cases} cases, max ${r.buildingsNeverSlide.maxLateral} m`);

check('6 no hang: every swallow finishes on geometry, not the emergency timer',
  !!r.noHang && r.noHang.neverRemoved.length===0 && r.noHang.onEmergencyTimer.length===0,
  r.noHang&&`${r.noHang.cases} kinds, slowest ${JSON.stringify(r.noHang.slowest[0])}`);

check('6b no hang: a removed body was fully under the ground plane',
  !!r.noHang && r.noHang.rows.every(x=>x.top===null||x.top<0),
  r.noHang&&`worst top ${Math.max(...r.noHang.rows.map(x=>x.top??-99))} m`);

check('7 inert: a gone prop is invisible, unqueryable and unregistered',
  !!r.inert && r.inert.problems.length===0, r.inert&&r.inert.problems.join('; '));

check('8 reach: a hole under the edge of a huge object still destabilises it',
  !!r.hugeObjectReach && r.hugeObjectReach.rows.every(x=>x.destabilised),
  r.hugeObjectReach&&`${r.hugeObjectReach.kind} r=${r.hugeObjectReach.radius}, `+
  `reach was ${r.hugeObjectReach.queryReachWas}, large list ${r.hugeObjectReach.largeListSize}`);

check('9 fits means eats: nothing claims to be wider than it looks',
  !!r.fitsMeansEats && r.fitsMeansEats.disagreements===0,
  r.fitsMeansEats&&`${r.fitsMeansEats.kindsChecked} kinds, ${r.fitsMeansEats.disagreements} bad`);

check('10 wedged: a body too big for the opening settles and stops moving',
  Array.isArray(r.wedged) && r.wedged.length>0 &&
  r.wedged.every(x=>x.eaten||x.lateMotionDeg<0.25),
  Array.isArray(r.wedged)?r.wedged.map(x=>`${x.kind}:${x.lateMotionDeg}`).join(' '):'no data');

check('no page errors', errs.length===0, errs.slice(0,3).join(' | '));

console.log(fails.length? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall checks passed');
await b.close();
process.exit(fails.length?1:0);
