/**
 * Full-flow QA. Runs the sequence a player actually takes, on one map, and
 * reports PASS/FAIL per checkpoint with the number that decided it.
 *
 * Nothing here asserts "it worked" from the absence of an exception — every
 * check reads a real counter, position or DOM node. That is the whole point:
 * this session's recurring bug has been code that reports success while doing
 * nothing.
 *
 *   node qa.mjs <baseUrl> [mapId]
 */
import { chromium } from 'playwright';
import { appendFileSync, writeFileSync } from 'node:fs';
/* Synchronous appends. console.log block-buffers to a file and through a pipe,
   so a run that hangs shows NOTHING — which is how three QA attempts looked
   identical to a crash. */
const OUT = process.env.QA_OUT || '/tmp/qa-out.txt';
writeFileSync(OUT, '');
const say = (m) => { appendFileSync(OUT, m + '\n'); console.log(m); };

const BASE = process.argv[2] || 'http://localhost:4173/';
const MAP  = process.argv[3] || 'miami';
const URL  = BASE + (BASE.includes('?') ? '&' : '?') + 'map=' + MAP;

/* A QA run that hangs is worse than one that fails: it reads as "still going"
   forever and nobody learns anything. Hard ceiling, then report and exit. */
const WATCHDOG = setTimeout(() => {
  say('\n*** QA TIMED OUT after 6 min — last checkpoint above is where it stopped');
  process.exit(2);
}, 6 * 60 * 1000);
WATCHDOG.unref?.();

const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const pg = await b.newPage();
const pageErrors = [], consoleErrors = [], bad404 = [];
pg.on('pageerror', e => pageErrors.push(String(e).slice(0, 200)));
pg.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
pg.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) bad404.push(r.status() + ' ' + r.url().split('/').slice(-1)[0]); });

const R = { map: MAP, url: URL, checks: [] };
const check = (name, pass, detail) => {
  R.checks.push({ name, pass: !!pass, detail: String(detail) });
  // Stream, do not buffer: a run that hangs must still show how far it got.
  say(`${pass ? ' PASS' : '*FAIL'}  ${name.padEnd(38)} ${detail}`);
};
const step = (s) => say(`--- ${s}`);

await pg.goto(URL, { waitUntil: 'load' });
await pg.waitForFunction('!!window.DEV && !!window.__GAME__', null, { timeout: 240000 });
await pg.mouse.click(300, 200);
await new Promise(r => setTimeout(r, 1200));

// ---- 1. MAIN MENU must not be running a match -----------------------------
step('menu');
const menu = await pg.evaluate(() => {
  const g = window.__GAME__;
  return { phase: String(g.match.phase), bots: g.bots.length, holes: g.holes.length,
           player: !!g.player, island: !!g.onIsland,
           mapId: g.map ? g.map.id : '?', objects: g.allConsumables.length };
});
check('menu: no match running', menu.bots === 0 && menu.holes === 0 && !menu.player, JSON.stringify(menu));
check('world built', menu.objects > 10000, menu.objects + ' consumables');
check('correct map loaded', menu.mapId === MAP, menu.mapId);

// ---- 2. PLAY -> Bayfront pre-lobby ----------------------------------------
step('pre-lobby');
const lobby = await pg.evaluate(async () => {
  const g = window.__GAME__;
  g.queueMatch('classic');
  await new Promise(r => setTimeout(r, 600));
  return { island: !!g.onIsland, phase: String(g.match.phase),
           lobbyLeft: g.lobbyLeft, playerOnIsland: g.player
             ? Math.hypot(g.player.position.x - 4000, g.player.position.z) < 400 : false };
});
check('Play enters Bayfront island', lobby.island, JSON.stringify(lobby));
check('30s pre-lobby clock armed', lobby.lobbyLeft > 25 && lobby.lobbyLeft <= 30, 'lobbyLeft=' + lobby.lobbyLeft);
check('no match gameplay on island', lobby.phase === 'menu', 'phase=' + lobby.phase);

// The clock must actually tick in real time (a previous bug burnt it instantly).
step('clock tick (3s)');
const ticked = await pg.evaluate(async () => {
  const g = window.__GAME__; const a = g.lobbyLeft;
  /* Count FRAMES as well as seconds. The lobby clock is driven by the rAF loop,
     and headless Chromium throttles rAF to a few fps with no compositor — so a
     slow clock here means a slow page, not a broken clock. Reporting frames
     makes that distinguishable instead of a mystery FAIL. */
  let frames = 0;
  const t0 = performance.now();
  await new Promise((done) => {
    const tick = () => { frames++;
      if (performance.now() - t0 >= 3000) return done();
      requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  return { before: a, after: g.lobbyLeft, frames,
           fps: +(frames / ((performance.now() - t0) / 1000)).toFixed(1) };
});
{
  /* Per FRAME, not per second: at 4 fps a correct clock still only advances a
     few hundredths. The real invariant is "dt is being applied", so compare the
     drop against the frames that actually rendered. */
  const drop = ticked.before - ticked.after;
  const perFrame = ticked.frames ? drop / ticked.frames : 0;
  check('lobby clock advances with dt', perFrame > 0.004 && perFrame < 0.9,
    `${ticked.before.toFixed(1)} -> ${ticked.after.toFixed(1)} over ${ticked.frames} frames `
    + `(${ticked.fps} fps, ${perFrame.toFixed(4)}s/frame)`);
}

// ---- 3. START MATCH -> spawn must be dry and useful ------------------------
step('start match + spawn');
const spawn = await pg.evaluate(async () => {
  const g = window.__GAME__;
  g.startNow();
  await new Promise(r => setTimeout(r, 1600));
  const p = g.player;
  const v = g._validateSpawn(p.position.x, p.position.z);
  let near = 0;
  for (const c of g.allConsumables) {
    if (!c || c.state !== 0) continue;
    const dx = c.position.x - p.position.x, dz = c.position.z - p.position.z;
    if (dx*dx + dz*dz < 900 && c.tier && c.tier.id <= 1) near++;
  }
  return { x: Math.round(p.position.x), z: Math.round(p.position.z),
           inWater: g.layout.isWater(p.position.x, p.position.z),
           validatorOk: v.ok, why: v.why, starterProps: near,
           phase: String(g.match.phase), island: !!g.onIsland,
           duration: g.matchDuration, bots: g.bots.length };
});
check('spawned on dry ground', !spawn.inWater, `(${spawn.x}, ${spawn.z}) water=${spawn.inWater}`);
check('spawn passes the validator', spawn.validatorOk, spawn.why);
check('starter props within 30m', spawn.starterProps >= 6, spawn.starterProps + ' props');
check('left the island for the match', !spawn.island, 'onIsland=' + spawn.island);
check('4:00 match duration', spawn.duration === 240, spawn.duration + 's');
check('bots present', spawn.bots > 0, spawn.bots + ' bots');

// ---- 4. GAMEPLAY: eat things, check systems are live -----------------------
step('gameplay (3.2s)');
const play = await pg.evaluate(async () => {
  const g = window.__GAME__, a = window.__AUDIO__;
  const p = g.player, s0 = p.score;
  /* Steer from a rAF loop instead of 200 sequential `await setTimeout(16)`.
     Under headless throttling each of those 16 ms waits really costs ~250 ms,
     so the original block took ~50 s and looked exactly like a hang. Driving
     the heading from the frame callback costs one await total and follows the
     page's real frame rate, whatever it happens to be. */
  /* Drive the SIMULATION, not the clock. rAF runs at ~1.3 fps in this harness,
     so four wall-clock seconds of "play" is five frames and the hole never
     reaches anything — the first run reported +0 score and that was the test's
     fault, not the game's. stepSimulation is the same function the render loop
     calls, so this is real gameplay at a deterministic rate. */
  if (g.match.phase !== 'playing' && g.match.setPhase) g.match.setPhase('playing');
  /* STEER THROUGH input.update(), not desiredDir.
     stepSimulation does `player.desiredDir.copy(this.input.update())` at
     game.js:1585 BEFORE hole.update runs, so anything written to desiredDir
     just ahead of the step is overwritten and discarded. This check therefore
     used to measure a completely stationary hole and still pass — the score it
     saw came from props toppling in on their own near the spawn. Replacing
     input.update is the same contract the real Input class honours: return a
     world-space direction each frame. */
  const realInput = g.input.update.bind(g.input);
  let step = 0;
  g.input.update = () => ({ x: Math.cos(step * 0.02), y: Math.sin(step * 0.013),
                            copy(v) { return v; } });
  // desiredDir is a THREE.Vector2; copy() reads .x/.y off the argument.
  for (step = 0; step < 900; step++) g.stepSimulation(1 / 60);
  g.input.update = realInput;
  const cov = a && a.coverage ? a.coverage() : null;
  return {
    scoreGained: p.score - s0, radius: +p.radius.toFixed(2),
    powerups: !!g.powerups, pickups: g.powerups && g.powerups.pickups ? g.powerups.pickups.length : -1,
    events: !!g.events, heatTier: g.events && g.events.heat ? g.events.heat.tierOf(p) : -1,
    voiceMode: g.voice ? g.voice.mode : 'none',
    voiceAssets: g.voice && g.voice.manifest ? g.voice.manifest.size : 0,
    soundsFired: cov ? cov.firedCount : -1, soundsTotal: cov ? cov.total : -1,
    neverFired: cov ? cov.never : [], missingMethods: cov ? cov.missingMethods : [],
  };
});
check('player actually eats', play.scoreGained > 0, '+' + play.scoreGained + ' score');
check('power-up pickups placed', play.pickups > 0, play.pickups + ' pickups');
check('events system live', play.events, String(play.events));
check('voice pack loaded', play.voiceAssets === 111 && play.voiceMode === 'audio',
      `${play.voiceAssets} assets, mode=${play.voiceMode}`);
check('no audio contract names missing', play.missingMethods.length === 0, JSON.stringify(play.missingMethods));
check('sounds fired during play', play.soundsFired >= 5, `${play.soundsFired}/${play.soundsTotal}`);

// ---- 5. DEVOUR + RESPAWN ---------------------------------------------------
step('pvp + respawn');
const pvp = await pg.evaluate(async () => {
  const g = window.__GAME__, p = g.player;
  const bot = g.holes.find(h => h !== p && h.alive);
  if (!bot) return { skipped: true };
  p.reset(300, 300, 90000); bot.reset(300, 300, 90000 / 1.35); bot.spawnGrace = 0;
  const before = bot.score;
  g.consume._resolvePvP(g.holes);
  const eaten = !bot.alive;
  /* match.update() returns immediately unless the phase is PLAYING
     (match.js: `if (this.phase !== PHASE.PLAYING) return;`), so on the first
     run the countdown consumed the frames and the 2.6 s respawn timer never
     advanced — four checks failed for one reason, none of them the game's.
     Force the phase, then give the timer comfortably more than it needs. */
  if (g.match.phase !== 'playing') {
    if (g.match._setPhase) g.match._setPhase('playing');
    else g.match.phase = 'playing';
  }
  /* Just past the respawn, not far past it. RESPAWN_TIME is 2.6 s (156 frames)
     and RESPAWN_GRACE is 5 s (300 more), so driving 600 frames respawns the
     victim AND lets its grace expire — which is correct behaviour reported as a
     failure. Stop as soon as it is back, then sample. */
  let framesRun = 0;
  for (let i = 0; i < 600; i++) {
    g.match.update(1/60); framesRun++;
    if (bot.alive) break;
  }
  return { eaten, respawned: bot.alive, framesRun,
           keptFraction: before ? +(bot.score / before).toFixed(2) : -1,
           respawnDry: !g.layout.isWater(bot.position.x, bot.position.z),
           farFromKiller: Math.hypot(bot.position.x - p.position.x, bot.position.z - p.position.z) > 40,
           hasGrace: bot.spawnGrace > 0 };
});
if (!pvp.skipped) {
  check('bigger player devours smaller', pvp.eaten, String(pvp.eaten));
  check('victim respawns', pvp.respawned, String(pvp.respawned));
  check('victim keeps ~50%', Math.abs(pvp.keptFraction - 0.5) < 0.12, 'kept ' + pvp.keptFraction);
  check('respawn is dry', pvp.respawnDry, String(pvp.respawnDry));
  check('respawn away from killer', pvp.farFromKiller, String(pvp.farFromKiller));
  check('respawn grace applied', pvp.hasGrace, `${pvp.hasGrace} after ${pvp.framesRun} frames`);
}

// ---- 6. OUT OF BOUNDS ------------------------------------------------------
step('out of bounds');
const oob = await pg.evaluate(async () => {
  const g = window.__GAME__, p = g.player;
  g.shrink = { cx: 0, cz: 0, r0: 400, r1: 200, radius: 200, from: 0, to: 1, announced: true };
  p.reset(0, 260, 60000);
  const before = p.score;
  for (let i = 0; i < 60; i++) g._updateBounds(1/60, g.shrink);
  const warned = !!document.querySelector('.ob-warn.on');
  for (let i = 0; i < 200; i++) g._updateBounds(1/60, g.shrink);
  const inside = Math.hypot(p.position.x, p.position.z) < 200;
  g.shrink = null;
  return { warned, halved: Math.abs(p.score - Math.round(before*0.5)) <= 1, inside,
           dry: !g.layout.isWater(p.position.x, p.position.z), controllable: p.alive };
});
check('out-of-bounds warning shows', oob.warned, String(oob.warned));
check('penalty halves score', oob.halved, String(oob.halved));
check('teleports back inside', oob.inside, String(oob.inside));
check('teleport lands dry', oob.dry, String(oob.dry));
check('controllable after teleport', oob.controllable, String(oob.controllable));

// ---- 7. RESULTS + RESET ----------------------------------------------------
step('results + reset');
const reset = await pg.evaluate(async () => {
  const g = window.__GAME__, a = window.__AUDIO__;
  g.match.timeLeft = 0.01;
  for (let i = 0; i < 40; i++) g.match.update(1/60);
  await new Promise(r => setTimeout(r, 700));
  const loops = a && a.loopCount ? a.loopCount('') : -1;
  return { phase: String(g.match.phase), loopsLeft: loops,
           captions: document.querySelectorAll('.vo-cap').length };
});
check('match reaches results', reset.phase === 'results', 'phase=' + reset.phase);
check('no audio loops survive the match', reset.loopsLeft <= 0, reset.loopsLeft + ' loops');

// ---- summary ---------------------------------------------------------------
R.pageErrors = pageErrors.slice(0, 5);
R.consoleErrors = consoleErrors.slice(0, 5);
R.http4xx = bad404.slice(0, 5);
check('no page errors', pageErrors.length === 0, pageErrors.length + ' errors');
check('no 4xx responses', bad404.length === 0, bad404.length + ' bad responses');

const failed = R.checks.filter(c => !c.pass);
say(`\n=== QA ${MAP.toUpperCase()} — ${R.checks.length - failed.length}/${R.checks.length} passed ===`);

if (R.pageErrors.length) console.log('\nPAGE ERRORS:', R.pageErrors);
if (R.consoleErrors.length) console.log('CONSOLE ERRORS:', R.consoleErrors);
if (R.http4xx.length) console.log('HTTP 4xx:', R.http4xx);
clearTimeout(WATCHDOG);
await b.close();
process.exit(failed.length ? 1 : 0);
