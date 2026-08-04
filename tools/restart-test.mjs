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
// 900x560 rather than a postage stamp: the end-of-match card is part of what
// this test asserts, and a 400x260 viewport is not a layout anyone ships to.
const p = await b.newPage({viewport:{width:900,height:560}});
p.setDefaultTimeout(300000);
const errs=[]; p.on('pageerror',e=>errs.push(String(e.stack||e).split('\n')[0]));
await p.goto('http://localhost:5173/',{waitUntil:'domcontentloaded'});
await p.waitForFunction('!!window.DEV',null,{timeout:300000});

const r = await p.evaluate(() => {
  const g = window.__GAME__;
  const out = {};
  const pristine = g.registry.aliveCount;
  const occPristine = g.occlusion ? g.occlusion.candidates.length : 0;

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

  // hideUI(true) above sets #screens to display:none, which would measure the
  // card as 0x0 and report a layout failure that is purely the harness's doing.
  DEV.hideUI(false);

  // The end card has to LAY OUT, not merely exist. It shipped once as a bare
  // div whose two main blocks inherited position:absolute from .panel, so the
  // stats row and the standings list drew on top of each other in the corner
  // over an undimmed city and nobody noticed for a whole review round.
  const rect = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b2 = el.getBoundingClientRect();
    return { x: b2.left, y: b2.top, w: b2.width, h: b2.height };
  };
  const card = rect('.res-card');
  const blocks = ['.rs-head', '.rs-stats', '.rs-board', '.rs-actions'].map((s2) => ({ s: s2, r: rect(s2) }));
  let overlaps = 0, outside = 0;
  for (let i = 0; i < blocks.length; i++) {
    const A = blocks[i].r;
    if (!A || A.w < 1 || A.h < 1) { outside++; continue; }
    if (card && (A.x < card.x - 1 || A.y < card.y - 1 ||
                 A.x + A.w > card.x + card.w + 1 || A.y + A.h > card.y + card.h + 1)) outside++;
    for (let j = i + 1; j < blocks.length; j++) {
      const B2 = blocks[j].r;
      if (!B2 || B2.w < 1) continue;
      const ox = Math.min(A.x + A.w, B2.x + B2.w) - Math.max(A.x, B2.x);
      const oy = Math.min(A.y + A.h, B2.y + B2.h) - Math.max(A.y, B2.y);
      if (ox > 2 && oy > 2) overlaps++;
    }
  }
  out.resultsLayout = {
    card: card && { w: Math.round(card.w), h: Math.round(card.h) },
    onScreen: !!card && card.w > 40 && card.h > 40 &&
              card.x > -1 && card.y > -1 &&
              card.x + card.w <= window.innerWidth + 1 &&
              card.y + card.h <= window.innerHeight + 1,
    centred: !!card && Math.abs((card.x + card.w / 2) - window.innerWidth / 2) < 3,
    blocksOutsideCard: outside,
    blockOverlaps: overlaps,
  };

  DEV.hideUI(true);

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

  // A building that was swallowed leaves the see-through-fade set. If nothing
  // puts it back, the set shrinks by one per tower eaten and never recovers —
  // by round three most of Brickell no longer x-rays when it hides the hole.
  // And a building removed mid-fade keeps its private dissolved material, so
  // it comes back permanently semi-transparent.
  let stillFaded = 0, stillCloned = 0;
  for (const root of (g.fadeRoots || [])) {
    if ((root.userData.occFade ?? 1) < 0.999) stillFaded++;
    if (root.userData.__occFaded) stillCloned++;
  }
  out.afterRestart.occlusion = {
    candidates: g.occlusion ? g.occlusion.candidates.length : 0,
    pristine: occPristine,
    fullyRearmed: !!g.occlusion && g.occlusion.candidates.length === occPristine,
    stillFaded, stillOnCloneMaterial: stillCloned,
    suspendedQueue: (g._occSuspended || []).length,
  };

  // --- and it must still be playable ---------------------------------------
  g.match.countdown = 0; g.match._setPhase('playing');
  for (let f=0; f<180; f++) g.stepSimulation(1/60);
  out.newMatchRuns = { botsAte: pristine - g.registry.aliveCount, holes: g.holes.length };

  // --- return to lobby ------------------------------------------------------
  g.returnToLobby();
  out.lobby = { phase:g.match.phase, holes:g.holes.length, player:!!g.player,
                alive:g.registry.aliveCount,
                occlusionCandidates: g.occlusion ? g.occlusion.candidates.length : 0,
                menuShown: !!document.querySelector('#screens .menu-in') };

  // --- and lobby -> match one more time, because the second restart is the
  //     one that catches state that only leaks on a repeat cycle -------------
  g.startMatch();
  g.match.countdown = 0; g.match._setPhase('playing');
  for (let f=0; f<120; f++) g.stepSimulation(1/60);
  out.secondCycle = {
    phase: g.match.phase, holes: g.holes.length, bots: g.bots.length,
    alive: g.registry.aliveCount,
    occlusionCandidates: g.occlusion ? g.occlusion.candidates.length : 0,
    playerScore: Math.round(g.player.score),
  };
  return out;
});

console.log(JSON.stringify(r,null,1));
console.log('page errors:', errs.length, errs.slice(0,4));
await b.close();
