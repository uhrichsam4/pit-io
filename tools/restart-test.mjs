#!/usr/bin/env node
/**
 * End-of-match and restart regression.
 *
 * Asserts the properties a restart must have: gameplay actually freezes when
 * the match ends, and a new match starts on a fully restored city rather than
 * on the leftovers of the last one.
 *
 *   node tools/restart-test.mjs      (needs `npm run dev` on 5173)
 */
import { chromium } from 'playwright';
const b = await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
const p = await b.newPage({viewport:{width:400,height:260}});
p.setDefaultTimeout(300000);
const errs=[]; p.on('pageerror',e=>errs.push(String(e.stack||e).split('\n')[0]));
await p.goto('http://localhost:5173/',{waitUntil:'domcontentloaded'});
await p.waitForFunction('!!window.DEV',null,{timeout:300000});

const r = await p.evaluate(() => {
  const g = window.__GAME__;
  const out = {};
  const pristine = g.registry.aliveCount;

  // --- play a match and eat a lot of the city ----------------------------
  DEV.play(true); DEV.hideUI(true);
  DEV.setSize(30);
  for (let i=0;i<8;i++){
    const pt = g._spawnPoint();
    g.player.position.set(pt.x,0,pt.z);
    DEV.devour(70);
    for (let f=0; f<40; f++) g.stepSimulation(1/60);
  }
  for (let f=0; f<120; f++) g.stepSimulation(1/60);
  out.afterEating = { alive: g.registry.aliveCount, eaten: pristine - g.registry.aliveCount,
                      falling: g.consume.falling.length, pendingRespawn: g.consume.respawns.length,
                      destabilised: g.consume.attracted.size };

  // --- end the match ------------------------------------------------------
  g.match.timeLeft = 0.001;
  g.stepSimulation(1/60);
  out.phase = g.match.phase;

  // FREEZE: nothing may move or be consumed after the match ends.
  const before = { alive:g.registry.aliveCount, score:Math.round(g.player.score),
                   px:+g.player.position.x.toFixed(3), pz:+g.player.position.z.toFixed(3) };
  g.player.desiredDir.set(1,1);                 // try to drive
  for (let f=0; f<120; f++) g.stepSimulation(1/60);
  const after = { alive:g.registry.aliveCount, score:Math.round(g.player.score),
                  px:+g.player.position.x.toFixed(3), pz:+g.player.position.z.toFixed(3) };
  out.frozen = { moved:+(Math.hypot(after.px-before.px, after.pz-before.pz)).toFixed(3),
                 consumedAfterEnd: before.alive - after.alive,
                 scoreDrift: after.score - before.score };

  // --- the end screen ------------------------------------------------------
  const sum = g.match.summary(g.player);
  out.summary = { rank:sum.rank, total:sum.total, score:sum.score,
                  diameter:+sum.diameter.toFixed(1), winner:sum.winner&&sum.winner.name,
                  devoured:sum.stats.devoured, hasButtons:false };
  g.screens.showResults(sum, g.player);
  out.summary.hasButtons = !!(document.getElementById('again-btn') && document.getElementById('lobby-btn'));

  // --- restart -------------------------------------------------------------
  g.startMatch();
  const dupIds = new Set(); let dupes = 0;
  for (const c of g.registry.byId.values()){ if (dupIds.has(c.id)) dupes++; dupIds.add(c.id); }
  let badState=0, belowWorld=0, tilted=0;
  for (const c of g.allConsumables){
    if (c.state !== 0) badState++;
    if (c.position.y < -100) belowWorld++;
    if (c._dyn && Math.abs(c._dyn.tilt) > 0.001) tilted++;
  }
  out.afterRestart = {
    alive: g.registry.aliveCount, pristine,
    fullyRestored: g.registry.aliveCount === pristine,
    duplicateIds: dupes, notIdle: badState, parkedBelowWorld: belowWorld, stillTilted: tilted,
    falling: g.consume.falling.length, pendingRespawn: g.consume.respawns.length,
    destabilised: g.consume.attracted.size,
    holes: g.holes.length, bots: g.bots.length,
    playerScore: Math.round(g.player.score), playerRadius: +g.player.radius.toFixed(2),
    phase: g.match.phase, timeLeft: Math.round(g.match.timeLeft),
    statsCleared: g.match.stats.devoured === 0,
  };

  // --- and it must still be playable ---------------------------------------
  g.match.countdown = 0; g.match._setPhase('playing');
  for (let f=0; f<180; f++) g.stepSimulation(1/60);
  out.newMatchRuns = { botsAte: pristine - g.registry.aliveCount, holes: g.holes.length };

  // --- return to lobby ------------------------------------------------------
  g.returnToLobby();
  out.lobby = { phase:g.match.phase, holes:g.holes.length, player:!!g.player,
                alive:g.registry.aliveCount };
  return out;
});

console.log(JSON.stringify(r,null,1));
console.log('page errors:', errs.length, errs.slice(0,4));
await b.close();
