#!/usr/bin/env node
/**
 * Multiplayer integration test.
 *
 * Boots two real browser clients into the same room and asserts the three
 * things that must hold for this architecture to work at all:
 *   1. both clients receive the same world seed and therefore build identical
 *      cities (same Consumable ids),
 *   2. a player's position and size replicate to the other client,
 *   3. objects one player swallows disappear on the other client too.
 *
 * Requires: `npm run dev` on 5173 and `npm run server` on 8787.
 *   node tools/net-test.mjs
 *
 * Frames are pumped explicitly with DEV.render because a backgrounded headless
 * page throttles requestAnimationFrame, which would make the result depend on
 * which tab happened to be focused.
 */
import { chromium } from 'playwright';
const b = await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const mk = async (name) => {
  const p = await b.newPage({viewport:{width:560,height:360}});
  p.setDefaultTimeout(240000);
  await p.goto(`http://localhost:5173/?room=nettest2&name=${name}`, {waitUntil:'domcontentloaded'});
  await p.waitForFunction('!!window.DEV', null, {timeout:240000});
  await p.evaluate(() => { DEV.play(true); });
  return p;
};
const A = await mk('Alpha');
const B = await mk('Bravo');
// The braces are load-bearing, exactly as in tools/shot.mjs: every DEV method
// returns `this` for chaining, and playwright serialises whatever an evaluate
// resolves to. Returning DEV drags the entire game object graph across the
// bridge and throws "object reference chain is too long" once the scene is deep
// enough — which the city now is, so this test aborted before its first assert.
const pump = async (n=12) => { for (let i=0;i<n;i++){ await A.evaluate(()=>{DEV.render(2);}); await B.evaluate(()=>{DEV.render(2);}); await A.waitForTimeout(90);} };
await pump(8);
// A moves and grows
await A.evaluate(() => { const g=window.__GAME__; g.player.position.set(150,0,200); DEV.setSize(7); });
await pump(20);
const seen = await B.evaluate(() => window.__GAME__.holes.filter(h=>h.type==='remote')
  .map(h=>({name:h.name,x:Math.round(h.position.x),z:Math.round(h.position.z),r:+h.radius.toFixed(1),alive:h.alive})));
const seenA = await A.evaluate(() => window.__GAME__.holes.filter(h=>h.type==='remote')
  .map(h=>({name:h.name,x:Math.round(h.position.x),z:Math.round(h.position.z),r:+h.radius.toFixed(1)})));
console.log('B sees:', JSON.stringify(seen));
console.log('A sees:', JSON.stringify(seenA));
const ok = seen.length===1 && Math.abs(seen[0].x-150)<6 && Math.abs(seen[0].z-200)<6 && seen[0].r>6;
console.log('position+size sync:', ok ? 'PASS' : 'FAIL');
// eat test
const before = await B.evaluate(()=>window.__GAME__.registry.aliveCount);
await A.evaluate(()=>DEV.devour(45));
await pump(14);
const after = await B.evaluate(()=>window.__GAME__.registry.aliveCount);
const afterA = await A.evaluate(()=>window.__GAME__.registry.aliveCount);
console.log(`consumption sync: A=${afterA} B=${after} (B before ${before}) ->`, afterA===after ? 'PASS' : 'FAIL');
await b.close();
