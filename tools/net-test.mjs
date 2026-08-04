#!/usr/bin/env node
/**
 * Multiplayer integration test.
 *
 * Boots two real browser clients into the same room and asserts the four
 * things that must hold for this architecture to work at all:
 *   1. both clients receive the same world seed and therefore build identical
 *      cities (same object count, same Consumable ids),
 *   2. a player's position and size replicate to the other client,
 *   3. objects one player swallows disappear on the other client too,
 *   4. neither page throws.
 *
 * Requires: `npm run dev` on 5173 and `npm run server` on 8787.
 *   node tools/net-test.mjs
 *
 * The clients are pumped with DEV.simulate, not DEV.render. Only the
 * simulation talks to the network, and one drawn frame of this city costs
 * seconds under software GL — pumping through the renderer made the run last
 * longer than a whole match, so the server started its next round underneath
 * the test and every assertion ended up measuring the restart instead of the
 * sync. Exits non-zero on any failure.
 */
import { chromium } from 'playwright';

// A fresh room per run. Rooms are created on demand and destroyed when the last
// client leaves, so a fixed name would inherit the clock of a previous run that
// had not finished tearing down.
const ROOM = 'nettest-' + Date.now().toString(36);
const b = await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});

const errs = [];
const mk = async (name) => {
  const p = await b.newPage({viewport:{width:480,height:300}});
  p.setDefaultTimeout(240000);
  p.on('pageerror', (e) => errs.push(`${name}: ${String(e.stack || e).split('\n')[0]}`));
  await p.goto(`http://localhost:5173/?room=${ROOM}&name=${name}`, {waitUntil:'domcontentloaded'});
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
const step = (p) => p.evaluate(() => { DEV.simulate(1 / 30, 1 / 60); });
const pump = async (n = 12) => {
  for (let i = 0; i < n; i++) { await step(A); await step(B); await A.waitForTimeout(90); }
};
await pump(8);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  — ${detail}`);
};

/* 1. one seed, one city --------------------------------------------------- */
const world = (p) => p.evaluate(() => {
  const g = window.__GAME__;
  // Hash the id set rather than shipping 28k ids across the bridge.
  let h = 2166136261 >>> 0;
  for (const id of g.registry.byId.keys()) { h ^= id; h = Math.imul(h, 16777619) >>> 0; }
  return { seed: g.net && g.net.seed, initial: g.registry.initialCount, idHash: h };
});
const wA = await world(A), wB = await world(B);
check('same world',
  wA.seed === wB.seed && wA.initial === wB.initial && wA.idHash === wB.idHash,
  `seed ${wA.seed}/${wB.seed}, ${wA.initial}/${wB.initial} objects, idHash ${wA.idHash}/${wB.idHash}`);

/* 2. transform replication ------------------------------------------------ */
await A.evaluate(() => { const g = window.__GAME__; g.player.position.set(150, 0, 200); DEV.setSize(7); });
await pump(20);
const peers = (p) => p.evaluate(() => window.__GAME__.holes.filter(h => h.type === 'remote')
  .map(h => ({ name: h.name, x: Math.round(h.position.x), z: Math.round(h.position.z),
               r: +h.radius.toFixed(1), alive: h.alive })));
const seenB = await peers(B), seenA = await peers(A);
console.log('  B sees:', JSON.stringify(seenB));
console.log('  A sees:', JSON.stringify(seenA));
check('position + size sync',
  seenB.length === 1 && Math.abs(seenB[0].x - 150) < 6 && Math.abs(seenB[0].z - 200) < 6 && seenB[0].r > 6,
  `Bravo sees Alpha at ${seenB[0] ? `${seenB[0].x},${seenB[0].z} r=${seenB[0].r}` : 'nothing'}`);
check('roster is symmetric', seenA.length === 1 && seenB.length === 1,
  `A sees ${seenA.length} peer(s), B sees ${seenB.length}`);

/* 3. consumption replication ---------------------------------------------- */
await A.evaluate(() => DEV.devour(45));
// Drain: A flushes what it already ate WITHOUT simulating any more, so both
// counts are read at the same instant in A's timeline. Pumping A's whole
// simulation here means its 7 m hole keeps eating while B catches up, and the
// two numbers can never meet.
for (let i = 0; i < 14; i++) {
  await A.evaluate(() => { const g = window.__GAME__; g.net.update(g.player, g.clock.elapsedTime); });
  await step(B);
  await A.waitForTimeout(90);
}
const aliveA = await A.evaluate(() => window.__GAME__.registry.aliveCount);
const aliveB = await B.evaluate(() => window.__GAME__.registry.aliveCount);
check('consumption sync', aliveA === aliveB, `A=${aliveA} B=${aliveB}`);

/* 4. no page errors ------------------------------------------------------- */
check('no page errors', errs.length === 0, errs.length ? errs.slice(0, 4).join(' / ') : 'none');

await b.close();
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} check(s) failed` : '\nall checks passed');
process.exit(failed.length ? 1 : 0);
