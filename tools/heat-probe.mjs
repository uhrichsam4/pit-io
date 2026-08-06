#!/usr/bin/env node
/**
 * HEAT / POLICE RESPONSE — LIVE-MATCH PROBE
 *
 * heat.js is unit-tested against stubs (`__selftest()`) and it passes. This
 * asks the only question that test cannot: does the system do anything in a
 * REAL match, with the real city, the real router, the real audio and the real
 * ConsumeSystem feeding it?
 *
 *   node tools/heat-probe.mjs [baseUrl] [mapId]
 *   node tools/heat-probe.mjs http://localhost:5173/ miami       (default)
 *
 * Exit 0 = every assertion passed. 1 = at least one failed. 2 = watchdog.
 *
 * ---------------------------------------------------------------------------
 * HOW IT DRIVES THE GAME, AND WHY EACH INTERVENTION IS NEEDED
 * ---------------------------------------------------------------------------
 *  1. SIMULATION, NOT WALL CLOCK. Every stage advances the world with
 *     `game.stepSimulation(1/60)` in a tight loop. Headless Chromium renders
 *     this scene at ~1.3 fps and throttles rAF AND setTimeout to match, so an
 *     in-page `await setTimeout(16)` really costs ~250 ms; anything measured
 *     against page time here would be measuring the compositor. stepSimulation
 *     is the same function the render loop calls, and eventGlue wraps it
 *     (eventGlue.js:401), so heat.update() runs exactly as it does in play.
 *
 *  2. THE VIRTUAL STICK. game.stepSimulation OVERWRITES player.desiredDir from
 *     `input.update()` every step (game.js:1583) — so setting desiredDir before
 *     the step, which is what tools/qa-flow.mjs does, has no effect whatsoever
 *     and the hole never moves. This probe replaces `input.update` with a
 *     function returning a world-space direction it controls. That is the same
 *     contract the real Input honours (input.js:270 returns `this.worldDir`,
 *     already rotated out of screen space), so the game cannot tell the
 *     difference between this and a held key.
 *
 *  3. THE MATCH CLOCK IS PINNED during the measurement stages. Left running,
 *     240 s of simulated play ends the match half way through the probe, and
 *     the closing ring (game.js:1043, from = 25% of the duration) drags every
 *     hole into a shrinking circle and halves scores out of bounds. Pinning
 *     `match.elapsed`/`match.timeLeft` freezes both. HeatSystem is unaffected:
 *     it accumulates its own clock from dt (heat.js:694) and eventGlue calls it
 *     with no `t` argument precisely so that it does (eventGlue.js:492).
 *     The pin is released for the end-of-match teardown stage.
 *
 * Everything else is the game playing itself: real swallows through
 * ConsumeSystem -> consume.onSwallow -> heat.onConsumed, real dispatch, real
 * road routing, real pulses.
 *
 * ONE OPERATIONAL WARNING. Against the Vite dev server, any edit to src/ while
 * this is running triggers an HMR reload, which kills the page mid-evaluate and
 * surfaces as "Execution context was destroyed, most likely because of a
 * navigation". That is not a game failure; it is somebody else saving a file.
 * The run is wrapped so the summary still prints, and it is worth re-running
 * before believing that particular message.
 */
import { chromium } from 'playwright';
import { appendFileSync, writeFileSync } from 'node:fs';

/* Synchronous appends, copied from tools/qa-flow.mjs for the reason stated
   there: console.log block-buffers to a file and through a pipe, so a run that
   hangs shows NOTHING and reads as a crash. */
const OUT = process.env.HEAT_OUT || process.env.QA_OUT || '/tmp/heat-probe-out.txt';
writeFileSync(OUT, '');
const say = (m) => { appendFileSync(OUT, m + '\n'); console.log(m); };

const BASE = process.argv[2] || 'http://localhost:5173/';
const MAP = process.argv[3] || 'miami';
const URL = BASE + (BASE.includes('?') ? '&' : '?') + 'map=' + MAP;

/* A probe that hangs is worse than one that fails: it reads as "still going"
   forever and nobody learns anything. Hard ceiling, then report and exit. */
const WATCHDOG = setTimeout(() => {
  say('\n*** HEAT PROBE TIMED OUT after 12 min — the last line above is where it stopped');
  process.exit(2);
}, 12 * 60 * 1000);
WATCHDOG.unref?.();

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass, detail: String(detail) });
  say(`${pass ? ' PASS' : '*FAIL'}  ${name.padEnd(44)} ${detail}`);
};
const note = (name, detail) => say(`  ..  ${name.padEnd(44)} ${detail}`);
const step = (s) => say(`\n--- ${s}`);

/**
 * heat.js tunables the assertions are stated against.
 *
 * NOT guessed — every one is read back out of the live module at runtime (the
 * dev server can `import('/src/gameplay/heat.js')` from the page) and the probe
 * FAILS if the live value disagrees with the value written here. A silently
 * retuned constant must break this file loudly rather than quietly weaken an
 * assertion.
 */
const EXPECT = {
  MAX: 1.0,
  UP: [0, 0.22, 0.52, 0.82],
  DOWN: [0, 0.15, 0.44, 0.74],
  HIT_GAP: 5.0,
  PENALTY_FRAC: 0.02,
  PENALTY_CAP: 120,
  PENALTY_MIN: 5,
  MAX_UNITS: 6,
  COOL_MIN: 0.008,
  COOL_MAX: 0.055,
  COOL_SHAPE: 0.35,
  HOLD_R: 22,
  FAR_R: 170,
  LEAVE_R: 110,
};

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 240)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text().slice(0, 200)); });

const t0 = Date.now();
say(`heat-probe  ${URL}`);
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction('!!window.DEV && !!window.__GAME__', null, { timeout: 300000 });
await page.mouse.click(300, 200);              // arm the AudioContext
await new Promise((r) => setTimeout(r, 1200));
say(`boot ${((Date.now() - t0) / 1000).toFixed(1)}s`);

/* ========================================================================== *
 * STAGE 0 — start a real match and install the probe rig
 * ========================================================================== */
step('start match + install rig');

const rig = await page.evaluate(async () => {
  const g = window.__GAME__;
  g.queueMatch('classic');
  await new Promise((r) => setTimeout(r, 600));
  g.startNow();
  await new Promise((r) => setTimeout(r, 1600));
  /* startNow lands in COUNTDOWN; the countdown is burnt by the rAF loop, which
     is throttled to ~1 fps here. Force it, exactly as qa-flow does. */
  if (g.match.phase !== 'playing' && g.match._setPhase) g.match._setPhase('playing');

  const hs = g.events && g.events.heat;
  if (!hs) return { ok: false, why: 'game.events.heat missing' };

  /* ---- read the live tunables back, for the cross-check ------------------ */
  let live = null, liveErr = null;
  try {
    const mod = await import('/src/gameplay/heat.js');
    live = JSON.parse(JSON.stringify(mod.HEAT));
  } catch (e) { liveErr = String(e).slice(0, 120); }

  /* ---- the rig ----------------------------------------------------------- */
  const HP = {};
  window.__HP__ = HP;
  HP.g = g; HP.hs = hs;

  /* Virtual stick. See the header: desiredDir set from outside is overwritten
     by input.update() inside stepSimulation, so the stick has to BE the input. */
  HP.stick = g.player.desiredDir.clone().set(0, 0);
  HP._prevInputUpdate = g.input.update.bind(g.input);
  g.input.update = () => HP.stick;
  HP.releaseInput = () => { g.input.update = HP._prevInputUpdate; };

  /* Landed hits. _penalty is called from _fire ONLY on `inside && gapOK`
     (heat.js:1570), so one call === one landed containment hit. The wrapper is
     read-only: it calls through and records what the game decided. */
  HP.hits = [];
  const rawPenalty = hs._penalty.bind(hs);
  hs._penalty = (hole, s, now) => {
    const before = hole.score, tBefore = hole.tier;
    const res = rawPenalty(hole, s, now);
    HP.hits.push({
      t: now, player: hole === g.player, isPlayer: hole.isPlayer === true,
      kind: res.kind, loss: res.loss,
      scoreBefore: before, scoreAfter: hole.score,
      tierBefore: tBefore, tierAfter: hole.tier,
    });
    return res;
  };

  /* Heat actually added to the player, per frame, straight from heat.js's own
     accounting: _add returns the CLAMPED delta, so a gain that saturated at
     HEAT.MAX counts for what it was worth and not for what it asked for. */
  HP._gain = 0;
  HP.takeGain = () => { const v = HP._gain; HP._gain = 0; return v; };
  const rawAdd = hs._add.bind(hs);
  hs._add = (hole, gain, reason, mult) => {
    const d = rawAdd(hole, gain, reason, mult);
    if (hole === g.player && d > 0) HP._gain += d;
    return d;
  };

  /* Every resolved pulse, landed or not. */
  HP.fires = 0;
  const rawFire = hs._fire.bind(hs);
  hs._fire = (u, hole, s, now) => { HP.fires++; return rawFire(u, hole, s, now); };

  /* Dispatch attempts vs refusals. A refusal is legitimate (no legal junction)
     but a probe that saw zero units needs to know which of the two it was. */
  HP.spawnTry = 0; HP.spawnNull = 0;
  const rawSpawn = hs._spawn.bind(hs);
  hs._spawn = (kind, hole, now) => {
    HP.spawnTry++;
    const u = rawSpawn(kind, hole, now);
    if (!u) HP.spawnNull++;
    return u;
  };

  /* Tier changes, for every hole — the audio assertions need to know how many
     escalations actually happened, not how many the player saw. */
  HP.announce = [];
  const rawAnnounce = hs._announce.bind(hs);
  hs._announce = (hole, tier, up, now) => {
    HP.announce.push({ t: now, f: HP.frame, player: hole === g.player, tier, up });
    return rawAnnounce(hole, tier, up, now);
  };

  /* Devoured response units, split by who ate them. heat.js plays the
     escalation sting on a devour (heat.js:1702) as well as on a tier change,
     and a bot eating patrol cars across the map would otherwise show up as
     unexplained heatUp calls. */
  HP.devours = { player: 0, bot: 0 };
  const rawDevour = hs._tryDevour.bind(hs);
  hs._tryDevour = (u, hole, d, now) => {
    const got = rawDevour(u, hole, d, now);
    if (got) HP.devours[hole === g.player ? 'player' : 'bot']++;
    return got;
  };

  /* Voice cues that actually fired (heat.js _cue returns false when the global
     gap or the per-cue repeat guard swallows one). */
  HP.cues = [];
  const rawCue = hs._cue.bind(hs);
  hs._cue = (hole, id, x, z) => {
    const fired = rawCue(hole, id, x, z);
    if (fired) HP.cues.push({ id, t: +hs.t.toFixed(1), player: hole === g.player });
    return fired;
  };

  /* Every escalation-sting call, with the frame it happened on and the tier it
     was given. Two calls on one frame is the duplicate-call signature; a tier
     argument of undefined means audio.js's tier-flavoured sting (audio.js:3155)
     always plays its tier-1 variant. Wrapped ON TOP of the coverage wrapper, so
     audio.coverage() still counts every call. */
  const A = window.__AUDIO__;
  HP.stings = [];
  for (const nm of ['heatUp', 'heatDown', 'dispatchChirp']) {
    const raw = A[nm].bind(A);
    A[nm] = (...args) => { HP.stings.push({ nm, f: HP.frame, arg: args[0] }); return raw(...args); };
  }

  /* Swallows, per hole. Wraps the CURRENT handler, which is already eventGlue's
     wrapper around game.js's — so heat still gets fed in the same order. */
  HP.swallows = 0; HP.swallowTiers = {};
  const prevSwallow = g.consume.onSwallow;
  g.consume.onSwallow = (hole, c, gained, remote) => {
    if (prevSwallow) prevSwallow(hole, c, gained, remote);
    if (hole === g.player) {
      HP.swallows++;
      const t = c && c.tier ? c.tier.id : -1;
      HP.swallowTiers[t] = (HP.swallowTiers[t] || 0) + 1;
    }
  };

  /* ---- spatial bins over the live consumable field ----------------------- */
  HP.bins = (cell) => {
    const m = new Map();
    for (const c of g.allConsumables) {
      if (!c || c.state !== 0) continue;
      const k = Math.round(c.position.x / cell) + ',' + Math.round(c.position.z / cell);
      let e = m.get(k);
      if (!e) { e = { n: 0, x: 0, z: 0 }; m.set(k, e); }
      e.n++; e.x += c.position.x; e.z += c.position.z;
    }
    return [...m.values()].map((e) => ({ n: e.n, x: e.x / e.n, z: e.z / e.n }))
      .filter((e) => !g.layout.isWater(e.x, e.z));
  };

  /**
   * The nearest dry point with NOTHING edible within `clearR` metres.
   *
   * The decay stage needs one and a "least dense 120 m cell" is not good
   * enough: the first version parked in a cell holding one prop, the hole ate
   * everything its 20 m mouth could reach plus everything that respawned, and
   * the meter never went down at all — heat.js was cooling correctly the whole
   * time and being out-earned. A guaranteed-empty neighbourhood is the only way
   * "stopped causing damage" is actually true.
   */
  HP.emptySpots = (clearR, fromX, fromZ, maxD, pad = 520) => {
    const CELL = 40;
    const grid = new Map();
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const c of g.allConsumables) {
      if (!c || c.state !== 0) continue;
      const k = Math.floor(c.position.x / CELL) + ',' + Math.floor(c.position.z / CELL);
      let a = grid.get(k);
      if (!a) { a = []; grid.set(k, a); }
      a.push(c);
      if (c.position.x < minX) minX = c.position.x;
      if (c.position.x > maxX) maxX = c.position.x;
      if (c.position.z < minZ) minZ = c.position.z;
      if (c.position.z > maxZ) maxZ = c.position.z;
    }
    /* The scan box is the props' bounding box PLUS a margin, and the margin is
       the whole point. Measured on Miami: inside the built area there is not a
       single square metre with even a 50 m clear radius — the city is wall to
       wall props — so a search bounded by the props themselves returns nothing
       and the caller silently falls back to somewhere with food in it. */
    const span = Math.ceil(clearR / CELL);
    const found = [];
    for (let x = minX - pad; x <= maxX + pad; x += CELL) {
      for (let z = minZ - pad; z <= maxZ + pad; z += CELL) {
        const d = Math.hypot(x - fromX, z - fromZ);
        if (d > maxD) continue;
        if (g.layout.isWater(x, z)) continue;
        let clear = true;
        const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
        for (let a = -span; a <= span && clear; a++) {
          for (let b = -span; b <= span && clear; b++) {
            const arr = grid.get((cx + a) + ',' + (cz + b));
            if (!arr) continue;
            for (const c of arr) {
              if (c.state !== 0) continue;
              if (Math.hypot(c.position.x - x, c.position.z - z) < clearR) { clear = false; break; }
            }
          }
        }
        if (clear) found.push({ x, z, d: Math.round(d), clearR });
      }
    }
    return found.sort((a, b) => a.d - b.d);
  };

  /* Is the straight line between two points dry the whole way? The hole is
     steered by a bearing, not by a router, so a destination on the far side of
     the bay is one it will never reach — and the first version of the decay
     stage picked exactly that and then measured a player still sitting in the
     middle of downtown. */
  HP.pathDry = (x0, z0, x1, z1, steps = 30) => {
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      if (g.layout.isWater(x0 + (x1 - x0) * k, z0 + (z1 - z0) * k)) return false;
    }
    return true;
  };

  /** Edible things still standing within r metres of the player. */
  HP.foodWithin = (r) => {
    const p = g.player;
    let n = 0;
    for (const c of g.allConsumables) {
      if (!c || c.state !== 0) continue;
      if (Math.hypot(c.position.x - p.position.x, c.position.z - p.position.z) <= r) n++;
    }
    return n;
  };

  /* ---- the driver -------------------------------------------------------- */
  /* Greedy but local: head for the best value-per-metre edible thing nearby,
     re-deciding a few times a second. `consume.canEat` (consume.js:307) is the
     game's own edibility test, so this never chases something it cannot eat. */
  HP.target = null; HP.retarget = 0;
  HP.steerGreedy = (i, reach = 170) => {
    const p = g.player;
    if (--HP.retarget <= 0 || !HP.target || HP.target.state !== 0
        || !g.consume.canEat(p, HP.target)) {
      HP.retarget = 15;
      let best = null, bestS = -1;
      const px = p.position.x, pz = p.position.z;
      for (const c of g.allConsumables) {
        if (!c || c.state !== 0) continue;
        const dx = c.position.x - px, dz = c.position.z - pz;
        const d2 = dx * dx + dz * dz;
        if (d2 > reach * reach) continue;
        if (!g.consume.canEat(p, c)) continue;
        const s = (1 + (c.tier ? c.tier.id : 0)) / Math.max(8, Math.sqrt(d2));
        if (s > bestS) { bestS = s; best = c; }
      }
      HP.target = best;
    }
    if (HP.target) HP.aim(HP.target.position.x, HP.target.position.z);
    else HP.aim(p.position.x + Math.cos(i * 0.01) * 50, p.position.z + Math.sin(i * 0.007) * 50);
  };
  HP.aim = (x, z) => {
    const p = g.player;
    const dx = x - p.position.x, dz = z - p.position.z;
    const m = Math.hypot(dx, dz);
    if (m < 0.001) HP.stick.set(0, 0); else HP.stick.set(dx / m, dz / m);
  };
  HP.park = () => HP.stick.set(0, 0);

  /* ---- match clock pin --------------------------------------------------- */
  HP.pin = null;
  HP.pinClock = (elapsed, timeLeft) => { HP.pin = { elapsed, timeLeft }; };
  HP.unpinClock = () => { HP.pin = null; };

  /* ---- the heat top-up feed ---------------------------------------------- *
   * The escape hatch, used ONLY where the report says so. It calls the same
   * entry point ConsumeSystem uses (heat.onConsumed) with a REAL Consumable
   * taken out of game.allConsumables, so the gain, the tier weighting and the
   * importance multiplier are all the game's own — the only thing faked is that
   * the prop is not actually swallowed. Nothing else about the system is
   * bypassed: dispatch, routing, pulses and penalties stay entirely real. */
  HP.fed = 0; HP.fedTiers = {};
  HP.feedTo = (level, minTier = 3) => {
    const p = g.player;
    if (hs.heatOf(p) >= level) return false;
    const px = p.position.x, pz = p.position.z;
    let pick = null, bestD = Infinity;
    for (const c of g.allConsumables) {
      if (!c || c.state !== 0 || !c.tier || c.tier.id < minTier) continue;
      const d = Math.hypot(c.position.x - px, c.position.z - pz);
      if (d < bestD) { bestD = d; pick = c; }
    }
    if (!pick) return false;
    hs.onConsumed(p, pick);
    HP.fed++;
    HP.fedTiers[pick.tier.id] = (HP.fedTiers[pick.tier.id] || 0) + 1;
    return true;
  };

  /* ---- the frame loop every stage uses ----------------------------------- */
  /* Upward tier crossings are recorded HERE, once, for the whole probe rather
     than per stage. The first version recorded them per stage and reported
     "tier 1: never" for a player who had crossed it in the previous stage —
     a probe bug that read exactly like a broken game. */
  HP.frame = 0;
  HP.stage = 'boot';
  HP.cross = {};
  HP.prevTier = 0;
  HP.hSeries = []; HP.gSeries = [];
  HP.lastFrames = 0;
  HP.run = (frames, steer, sample, stop) => {
    const out = [];
    HP.lastFrames = 0;
    for (let i = 0; i < frames; i++) {
      HP.lastFrames = i;
      if (stop && i % 10 === 0 && stop(i)) break;
      if (steer) steer(i);
      g.stepSimulation(1 / 60);
      HP.frame++;
      if (HP.pin) { g.match.elapsed = HP.pin.elapsed; g.match.timeLeft = HP.pin.timeLeft; }
      const tier = hs.tierOf(g.player);
      if (tier > HP.prevTier) {
        for (let k = HP.prevTier + 1; k <= tier; k++) {
          if (!HP.cross[k]) {
            HP.cross[k] = { t: +hs.t.toFixed(2), heat: +hs.heatOf(g.player).toFixed(3), stage: HP.stage };
          }
        }
      }
      HP.prevTier = tier;
      /* One heat sample and one gain sample per frame, for the whole probe.
         The climb analysis used to run on the escalation stage alone, and at a
         late-game size that stage saturates the meter in two seconds — five
         usable data points, which is not a measurement. */
      HP.hSeries.push(hs.heatOf(g.player));
      HP.gSeries.push(HP.takeGain());
      if (sample) { const s = sample(i); if (s) out.push(s); }
    }
    return out;
  };

  /* ---- audio coverage, plus raw counters for the heat sounds ------------- */
  HP.HEAT_SOUNDS = ['heatUp', 'heatDown', 'siren', 'dispatchChirp',
    'containmentPulse', 'scorePenalty', 'countdownBeep', 'ui'];
  HP.cov = () => {
    const a = window.__AUDIO__;
    const c = a && a.coverage ? a.coverage() : null;
    const counts = {};
    for (const nm of HP.HEAT_SOUNDS) counts[nm] = (a && a._fired && a._fired[nm]) || 0;
    return {
      firedCount: c ? c.firedCount : -1, total: c ? c.total : -1,
      never: c ? c.never : [], missingMethods: c ? c.missingMethods : [],
      counts,
      audioReady: !!(a && a.ready), audioEnabled: !!(a && a.enabled),
    };
  };

  return {
    ok: true, live, liveErr,
    phase: String(g.match.phase),
    duration: g.matchDuration,
    bots: g.bots.length, holes: g.holes.length,
    consumables: g.allConsumables.length,
    spawn: { x: Math.round(g.player.position.x), z: Math.round(g.player.position.z) },
    cov: HP.cov(),
  };
});

if (!rig.ok) { say('*FATAL ' + rig.why); await browser.close(); process.exit(1); }
check('match is playing', rig.phase === 'playing', `phase=${rig.phase}, ${rig.bots} bots, ${rig.holes} holes`);
check('game.events.heat is a live HeatSystem', true, `${rig.consumables} consumables, spawn (${rig.spawn.x}, ${rig.spawn.z})`);

/* ---- constants cross-check ------------------------------------------------ */
if (rig.live) {
  const bad = [];
  for (const [k, v] of Object.entries(EXPECT)) {
    const got = rig.live[k];
    const same = Array.isArray(v) ? JSON.stringify(v) === JSON.stringify(got) : v === got;
    if (!same) bad.push(`${k}: probe expects ${JSON.stringify(v)}, heat.js has ${JSON.stringify(got)}`);
  }
  check('probe constants match live heat.js HEAT', bad.length === 0, bad.length ? bad.join(' | ') : 'all 13 agree');
} else {
  note('constants cross-check', 'SKIPPED — could not import /src/gameplay/heat.js (' + rig.liveErr + ')');
}

const covBefore = rig.cov;
say(`\naudio.coverage() BEFORE: ${covBefore.firedCount}/${covBefore.total} fired`
  + `  ready=${covBefore.audioReady} enabled=${covBefore.audioEnabled}`);
say('  heat sounds: ' + JSON.stringify(covBefore.counts));
if (covBefore.missingMethods.length) {
  say('  SOUND_METHODS names that do not exist: ' + JSON.stringify(covBefore.missingMethods));
}

/* Everything from here to the summary runs inside one guard. Six or seven
   minutes of stepSimulation under SwiftShader can take the renderer down, and
   when it does, playwright reports "Execution context was destroyed" from
   whichever evaluate was next. A probe that dies with its findings unprinted is
   exactly the failure mode this file exists to prevent, so the summary is
   printed either way and the death is recorded as a failed check. */
try {

/* ========================================================================== *
 * STAGE 1 — NATURAL PLAY, from the real spawn, at the real starting size
 * ========================================================================== */
step('natural play from spawn (90 s of simulation)');

const nat = await page.evaluate(() => {
  const HP = window.__HP__, g = HP.g, hs = HP.hs, p = g.player;
  HP.pinClock(g.match.elapsed, g.match.timeLeft);
  HP.stage = 'natural';
  const s0 = p.score, sw0 = HP.swallows;
  let maxHeat = 0, maxTier = 0, unitFrames = 0;
  const trace = HP.run(90 * 60,
    (i) => HP.steerGreedy(i),
    (i) => {
      const h = hs.heatOf(p);
      if (h > maxHeat) maxHeat = h;
      if (hs.tierOf(p) > maxTier) maxTier = hs.tierOf(p);
      if (hs.units().length) unitFrames++;
      return i % 600 === 0
        ? [i / 60, +h.toFixed(3), hs.tierOf(p), hs.units().length, Math.round(p.score)] : null;
    });
  const others = g.holes.filter((h) => h !== p)
    .map((h) => ({ score: Math.round(h.score), heat: +hs.heatOf(h).toFixed(3), tier: hs.tierOf(h) }))
    .sort((a, b) => b.heat - a.heat);
  return {
    trace, maxHeat: +maxHeat.toFixed(3), maxTier, unitFrames,
    swallows: HP.swallows - sw0, gained: Math.round(p.score - s0),
    score: Math.round(p.score), radius: +p.radius.toFixed(2),
    moved: +Math.hypot(p.position.x, p.position.z).toFixed(0),
    others: others.slice(0, 4),
    focusIsPlayer: hs.focus === p, focusHeat: +hs.stats().focusHeat.toFixed(3),
  };
});
for (const t of nat.trace) note('t=' + t[0] + 's', `heat=${t[1]} tier=${t[2]} units=${t[3]} score=${t[4]}`);
note('natural result', `${nat.swallows} swallows, +${nat.gained} score, r=${nat.radius}, `
  + `peak heat ${nat.maxHeat} (tier ${nat.maxTier})`);
note('rival holes (top 4 by heat)', JSON.stringify(nat.others));
check('natural play raises the player\'s heat at all', nat.maxHeat > 0, `peak ${nat.maxHeat}`);

/* ========================================================================== *
 * STAGE 2 — ESCALATION through every tier
 * ========================================================================== */
step('escalation: cross tier 1, 2 and 3');

const esc = await page.evaluate(() => {
  const HP = window.__HP__, g = HP.g, hs = HP.hs, p = g.player;

  /* Put the player where a real player is two or three minutes into a match.
     The rival bots in this very run finish on 25k-45k (printed above), so
     20,000 is not a fantasy number — it is mid-table. Placed in a solidly
     dense district rather than the single richest one, because a 30 m hole
     dropped on the richest cell swallows the whole block in ONE frame and the
     climb it produces is a step, not a curve.
     THIS IS THE ONLY STATE THE PROBE WRITES in this stage. Every point of heat
     below is earned by a real swallow: ConsumeSystem._capture -> onSwallow ->
     eventGlue._onSwallow -> heat.onConsumed. */
  HP.stage = 'escalation';
  const cells = HP.bins(120).sort((a, b) => b.n - a.n);
  const spot = cells[Math.min(25, cells.length - 1)];
  p.reset(spot.x, spot.z, 12000);
  p.spawnGrace = 0;                       // heat.js:1501 mutes pulses during grace
  const intervention = `player.reset(${Math.round(spot.x)}, ${Math.round(spot.z)}, 12000)`
    + ` — 26th-densest 120 m cell, ${spot.n} props; r=${p.radius.toFixed(1)}`;

  /* ---- phase A: climb on real food only ---------------------------------- */

  const trace = [];
  const sw0 = HP.swallows, cross0 = Object.keys(HP.cross).length;
  let peakTier = hs.tierOf(p), peakHeat = hs.heatOf(p);
  let prev = hs.heatOf(p), worstFrameDip = 0, bigDips = 0;
  const sampler = (how) => (i) => {
    const h = hs.heatOf(p), t = hs.tierOf(p);
    const dip = prev - h;
    if (dip > 0) { worstFrameDip = Math.max(worstFrameDip, dip); if (dip > 0.05) bigDips++; }
    prev = h;
    if (t > peakTier) peakTier = t;
    if (h > peakHeat) peakHeat = h;
    if (i % 300 === 0) {
      trace.push([+(i / 60).toFixed(0), +h.toFixed(3), t, hs.units().length,
        Math.round(p.score), HP.swallows - sw0, how]);
    }
    return null;
  };

  HP.run(75 * 60, (i) => HP.steerGreedy(i), sampler('ate'));
  const natural = {
    peakTier, peakHeat: +peakHeat.toFixed(3), heat: +hs.heatOf(p).toFixed(3),
    swallows: HP.swallows - sw0, swallowTiers: { ...HP.swallowTiers },
  };

  /* ---- phase B: only if real eating did not get there -------------------- */
  if (peakTier < 3) {
    HP.stage = 'escalation+feed';
    HP.run(45 * 60, (i) => {
      HP.steerGreedy(i);
      if (i % 6 === 0) HP.feedTo(0.99, 3);
    }, sampler('ate+fed'));
  }

  /* DOES THE METER GO UP WHILE YOU ARE EATING?
   *
   * Per-FRAME monotonicity is not the contract and never was: heat.js cools at
   * COOL_BUSY (0.35x) even while you are eating, so the meter sawtooths between
   * swallows by design, and a route-2 disengage subtracts DISENGAGE_COOL (0.12)
   * in a single frame. What must hold is that a second in which the player did
   * real damage ends higher than it started. That is measured directly here:
   * gains are summed per second from heat.js's own _add return value, and only
   * the seconds with real damage in them are judged. */
  const H = HP.hSeries, G = HP.gSeries;
  const secs = [];
  for (let i = 0; i + 60 <= H.length; i += 60) {
    let gain = 0, worstStep = 0;
    for (let j = i + 1; j < i + 60; j++) {
      gain += G[j];
      worstStep = Math.max(worstStep, H[j - 1] - H[j]);
    }
    secs.push({ from: H[i], to: H[i + 59], gain, worstStep });
  }
  /* Judge only the seconds where the answer is not in doubt. The bar is
     heat.js's own worst case rather than a flat number, because a flat one is
     wrong at both ends of the meter: the fastest the meter can possibly cool in
     one second is COOL_MAX * (COOL_SHAPE + 0.65*H) — full distance from every
     unit, outside the COOL_BUSY window — which is 0.019/s at H=0 and 0.055/s at
     H=1. A second whose gains beat that by 25% MUST end higher.
     - from < 0.97 drops the seconds already pinned at HEAT.MAX, where there is
       no headroom left to climb into;
     - worstStep <= 0.1 drops the seconds containing a route-2 disengage, which
       subtracts DISENGAGE_COOL (0.12) outside the gain accounting entirely. */
  const maxCool = (h) => 0.055 * (0.35 + 0.65 * h);
  const busy = secs.filter((s) => s.gain > maxCool(s.from) * 1.25
    && s.from < 0.97 && s.worstStep <= 0.1);
  const busyUp = busy.filter((s) => s.to > s.from).length;
  const skipped = secs.filter((s) => s.gain > maxCool(s.from) * 1.25 && s.worstStep > 0.1).length;
  const idle = secs.filter((s) => s.gain === 0 && s.from > 0.01);
  const idleDown = idle.filter((s) => s.to < s.from).length;

  return {
    intervention, peakTier, natural, trace,
    fed: HP.fed, fedTiers: HP.fedTiers,
    heat: +hs.heatOf(p).toFixed(3), tier: hs.tierOf(p), peakHeat: +peakHeat.toFixed(3),
    swallows: HP.swallows - sw0, swallowTiers: HP.swallowTiers,
    score: Math.round(p.score), radius: +p.radius.toFixed(2),
    worstFrameDip: +worstFrameDip.toFixed(5), bigDips,
    busy: busy.length, busyUp, idle: idle.length, idleDown, skipped,
    cross: HP.cross, newCrossings: Object.keys(HP.cross).length - cross0,
    focusIsPlayer: hs.focus === p, focusHeat: +hs.stats().focusHeat.toFixed(3),
    units: hs.units().length, stats: hs.stats(),
    spawnTry: HP.spawnTry, spawnNull: HP.spawnNull,
  };
});

note('intervention', esc.intervention);
for (const t of esc.trace) note('t=' + t[0] + 's', `heat=${t[1]} tier=${t[2]} units=${t[3]} score=${t[4]} eaten=${t[5]} (${t[6]})`);
note('natural phase', `peak tier ${esc.natural.peakTier} at heat ${esc.natural.peakHeat}, `
  + `${esc.natural.swallows} real swallows by tier ${JSON.stringify(esc.natural.swallowTiers)}`);
note('top-up feed', esc.fed
  ? `${esc.fed} real Consumables pushed through heat.onConsumed by tier ${JSON.stringify(esc.fedTiers)} `
    + '(NOT swallowed — see the report)'
  : 'not needed, every tier crossed on real food');
note('upward tier crossings (whole probe)', JSON.stringify(esc.cross));
for (const k of [1, 2, 3]) {
  const c = esc.cross[k];
  check(`heat reaches tier ${k}`, !!c,
    c ? `heat-clock t=${c.t}s at heat ${c.heat}, during "${c.stage}"` : 'never');
}
check('heat climbs in every second the player does damage',
  esc.busy >= 5 && esc.busyUp === esc.busy,
  `${esc.busyUp}/${esc.busy} seconds whose gains beat the fastest possible cooling ended higher, `
  + `${esc.idleDown}/${esc.idle} idle seconds `
  + `ended lower, ${esc.skipped} seconds excluded for containing a route-2 disengage; `
  + `worst single-frame dip ${esc.worstFrameDip} (${esc.bigDips} frames dipped >0.05 — `
  + 'DISENGAGE_COOL is 0.12 and lands in one frame)');

/* ========================================================================== *
 * STAGE 3 — THE RESPONSE ON THE GROUND
 * ========================================================================== */
step('engagement: units, roads, pulses, penalties (90 s)');

const eng = await page.evaluate((HIT_GAP) => {
  const HP = window.__HP__, g = HP.g, hs = HP.hs, p = g.player, L = g.layout;
  HP.hits.length = 0;
  const fires0 = HP.fires, fed0 = HP.fed;
  const try0 = HP.spawnTry, null0 = HP.spawnNull;

  let unitFrames = 0, maxUnits = 0, sumUnits = 0, frames = 0;
  let offRoad = 0, inWater = 0, notDrivable = 0;
  const offenders = [];
  let minUnitDist = Infinity, sumUnitDist = 0, distN = 0;
  let focusFrames = 0;
  const kinds = {};
  const tierUnits = { 0: [0, 0], 1: [0, 0], 2: [0, 0], 3: [0, 0] };  // [frames, unitFrames]

  /* Hold the player at the top of the meter for the whole stage. Without this
     the response walks away after a few seconds — not because heat is broken
     but because a hole that has eaten its own district has nothing left to
     raise heat with, and the bots (all of them pinned at 1.0, see the report)
     take the focus straight back. The top-up is the documented escape hatch:
     real Consumables, real heat.onConsumed, nothing else faked.
     Two sub-phases. ROAM is the real chase — it is what proves the routing and
     what makes the hits earned. PARK is the worst case for the anti-stun-lock
     rule: a stationary hole is dead centre of every marker heat.js places (the
     lead is velocity * 1.52 s, which is zero), so every pulse that resolves
     WOULD land, and the only thing that can stop them is HIT_GAP. */
  const sampler = () => {
    frames++;
    const us = hs.units();
    const tier = hs.tierOf(p);
    if (hs.focus === p) focusFrames++;
    tierUnits[tier][0]++;
    if (us.length) { tierUnits[tier][1]++; unitFrames++; }
    maxUnits = Math.max(maxUnits, us.length);
    sumUnits += us.length;
    for (const u of us) {
      kinds[u.kind] = (kinds[u.kind] || 0) + 1;
      const onRoad = L.isRoad(u.x, u.z);
      const wet = L.isWater ? L.isWater(u.x, u.z) : false;
      const driv = hs._drivable(u.x, u.z);
      if (!onRoad) { offRoad++; if (offenders.length < 6) offenders.push({ k: u.kind, s: u.state, x: +u.x.toFixed(1), z: +u.z.toFixed(1), why: 'isRoad=false' }); }
      if (wet) { inWater++; if (offenders.length < 6) offenders.push({ k: u.kind, s: u.state, x: +u.x.toFixed(1), z: +u.z.toFixed(1), why: 'isWater=true' }); }
      if (!driv) notDrivable++;
      const d = Math.hypot(u.x - p.position.x, u.z - p.position.z);
      if (d < minUnitDist) minUnitDist = d;
      sumUnitDist += d; distN++;
    }
    return null;
  };

  HP.stage = 'engage-roam';
  HP.run(45 * 60, (i) => { HP.steerGreedy(i); if (i % 6 === 0) HP.feedTo(0.97, 3); }, sampler);
  const roamHits = HP.hits.length;
  HP.stage = 'engage-park';
  HP.run(60 * 60, (i) => { HP.park(); if (i % 6 === 0) HP.feedTo(0.97, 3); }, sampler);
  const parkHits = HP.hits.length - roamHits;

  /* Minimum gap between two LANDED hits on the same hole. heat.js enforces this
     globally across every unit in the city (HEAT.HIT_GAP), so the measurement
     is per hole, not per unit. */
  const byHole = new Map();
  for (const h of HP.hits) {
    const k = h.player ? 'player' : (h.isPlayer ? 'player?' : 'bot');
    if (!byHole.has(k)) byHole.set(k, []);
    byHole.get(k).push(h);
  }
  let minGap = Infinity, gapPairs = 0;
  const gaps = [];
  for (const list of byHole.values()) {
    list.sort((a, b) => a.t - b.t);
    for (let i = 1; i < list.length; i++) {
      const gp = list[i].t - list[i - 1].t;
      gaps.push(+gp.toFixed(3));
      if (gp < minGap) minGap = gp;
      gapPairs++;
    }
  }

  /* Penalty cap, per landed hit, against heat.js's own stated rule:
       loss = clamp(round(score * 2%), 5, 120), then min(score),
       then min(score - tierFloorScore) — and NEVER a size-tier demotion. */
  const capViolations = [], demotions = [];
  for (const h of HP.hits) {
    const allowed = Math.min(120, Math.max(5, Math.round(h.scoreBefore * 0.02)));
    if (h.kind === 'score' && h.loss > allowed) capViolations.push({ ...h, allowed });
    if (h.tierAfter < h.tierBefore) demotions.push(h);
    if (h.scoreAfter < 0) capViolations.push({ ...h, allowed, why: 'negative score' });
  }

  return {
    frames, unitFrames, maxUnits, meanUnits: +(sumUnits / frames).toFixed(2),
    focusFrames, fed: HP.fed - fed0, roamHits, parkHits,
    kinds, offRoad, inWater, notDrivable, offenders,
    minUnitDist: Number.isFinite(minUnitDist) ? +minUnitDist.toFixed(1) : -1,
    meanUnitDist: distN ? +(sumUnitDist / distN).toFixed(1) : -1,
    tierUnits,
    fires: HP.fires - fires0, hits: HP.hits.length,
    playerHits: HP.hits.filter((h) => h.player).length,
    minGap: Number.isFinite(minGap) ? +minGap.toFixed(3) : -1, gapPairs, gaps: gaps.slice(0, 20),
    capViolations, demotions: demotions.length,
    losses: HP.hits.filter((h) => h.kind === 'score').map((h) => h.loss),
    vacuumHits: HP.hits.filter((h) => h.kind === 'vacuum').length,
    heat: +hs.heatOf(p).toFixed(3), tier: hs.tierOf(p),
    focusIsPlayer: hs.focus === p,
    spawnTry: HP.spawnTry - try0, spawnNull: HP.spawnNull - null0,
    maxUnitsAllowed: 6,
  };
}, EXPECT.HIT_GAP);

note('roster', `max ${eng.maxUnits} units, mean ${eng.meanUnits}, kinds ${JSON.stringify(eng.kinds)}`);
note('unit distance to player', `min ${eng.minUnitDist} m, mean ${eng.meanUnitDist} m`);
note('frames with units, by player tier', JSON.stringify(eng.tierUnits) + '  [frames, framesWithUnits]');
note('player held the focus', `${eng.focusFrames}/${eng.frames} frames `
  + `(${(100 * eng.focusFrames / eng.frames).toFixed(0)}%), ${eng.fed} top-up feeds used`);
note('dispatch (this stage)', `${eng.spawnTry} attempts, ${eng.spawnNull} refused (no legal junction)`);

const t2 = eng.tierUnits[2], t3 = eng.tierUnits[3];
const hiFrames = t2[0] + t3[0], hiUnitFrames = t2[1] + t3[1];
/* Occupancy is not a fixed number and should not be asserted as one: the
   roster is shared with the bots through MAX_UNITS, DISPATCH_GAP paces the
   refill, and every time the player outruns the escort a route-1 stand-down
   takes DISENGAGE_HOLD (8 s) off the dispatcher. Across runs it lands between
   49% and 89%. What must be true is that units are really being dispatched and
   that the player spends most of the encounter with somebody on them. */
const dispatched = eng.spawnTry - eng.spawnNull;
check('response units spawn at tier 2+',
  hiFrames > 0 && dispatched >= 5 && hiUnitFrames > hiFrames * 0.25,
  `${dispatched} units dispatched (${eng.spawnNull} refused for want of a legal junction); `
  + `${hiUnitFrames}/${hiFrames} tier-2/3 frames `
  + `(${(100 * hiUnitFrames / hiFrames).toFixed(0)}%) had at least one on the map`);
check('roster never exceeds HEAT.MAX_UNITS', eng.maxUnits <= EXPECT.MAX_UNITS,
  `max ${eng.maxUnits} <= ${EXPECT.MAX_UNITS}`);
{
  const unitFrames = Object.values(eng.kinds).reduce((a, b) => a + b, 0);
  check('every unit sits on a road', eng.offRoad === 0 && eng.inWater === 0 && eng.notDrivable === 0,
    `${unitFrames} unit-frames checked against layout.isRoad: ${eng.offRoad} off-road, `
    + `${eng.inWater} in water, ${eng.notDrivable} failed heat._drivable `
    + `${eng.offenders.length ? JSON.stringify(eng.offenders) : ''}`);
}
check('the response focuses the player when they are hottest', eng.focusFrames > eng.frames * 0.6,
  `${eng.focusFrames}/${eng.frames} frames`);
check('containment pulses actually resolve', eng.fires > 0, `${eng.fires} pulses resolved`);
check('containment pulses actually land', eng.hits >= 2,
  `${eng.hits} landed hits (${eng.playerHits} on the player) from ${eng.fires} pulses; `
  + `${eng.roamHits} while moving, ${eng.parkHits} while parked`);
if (eng.gapPairs > 0) {
  check('no stun-lock: min gap between hits >= HIT_GAP', eng.minGap >= EXPECT.HIT_GAP - 0.02,
    `min ${eng.minGap}s over ${eng.gapPairs} consecutive pairs (HIT_GAP=${EXPECT.HIT_GAP}), gaps ${JSON.stringify(eng.gaps)}`);
} else {
  check('no stun-lock: min gap between hits >= HIT_GAP', false,
    `NOT MEASURED — only ${eng.hits} hit(s), need 2 on one hole to form a gap`);
}
check('score penalty respects its cap', eng.capViolations.length === 0 && eng.demotions === 0,
  `${eng.losses.length} score hits ${JSON.stringify(eng.losses)}, ${eng.vacuumHits} vacuum-jam hits, `
  + `${eng.capViolations.length} cap violations, ${eng.demotions} size-tier demotions`);

/* ========================================================================== *
 * STAGE 4 — DECAY: leave, and watch it come back down
 * ========================================================================== */
step('decay: leave the units behind and stop eating (120 s)');

const dec = await page.evaluate(() => {
  const HP = window.__HP__, g = HP.g, hs = HP.hs, p = g.player;

  /* TWO THINGS HAVE TO BE TRUE FOR "DECAY" TO MEAN ANYTHING, and getting here
     took three rewrites of this stage.
       1. CLEAR OF THE UNITS. _cool freezes inside HOLD_R and barely moves at
          the standoff distance, so the player has to actually run — which is
          route 1 out of the encounter and worth measuring in its own right.
       2. NOT EATING. Cooling is throttled to COOL_BUSY for COOL_DELAY after
          every gain, and a late-game hole out-earns that by an order of
          magnitude. There is nowhere to hide from this: measured below,
          Miami has essentially no ground where a 20 m hole can stand still,
          and hole.js:752 hard-clamps every hole inside WORLD.SIZE, so the
          empty ground outside the built area is unreachable by construction.
     So the player runs to the far side of the map and is then RESIZED BACK TO A
     FRESH-SPAWN HOLE. That is not a cheat invented for the probe: it is exactly
     what being devoured does to you, and heat.js keeps the meter across it
     because state is keyed by the hole object, not by its size. A 2 m hole
     standing on ground a 20 m hole has just cleared eats nothing, which is the
     only way to see the cooling curve on its own. */
  HP.stage = 'decay';
  /* Reachable means inside the box hole.js actually allows: |x|,|z| <= SIZE and
     x <= BAY_EDGE on the east. Aiming anywhere else parks the hole against an
     invisible wall, which an earlier version did — it "ran" for 75 s and
     finished exactly where it started. */
  const LIM = 500, EAST = 300;
  /* FAR *AND* AS BARE AS THE MAP ALLOWS. Distance alone is not enough and
     Snowfall proved it: the far corner there holds 204 edible props, the
     shrunken hole ate 198 of them while "parked", grew back to 32 m and drove
     its own heat back to 1.0 — a decay stage that measured nothing. Rank every
     reachable point by how much food is inside 90 m first, distance second. */
  const CELL = 40;
  let bin = new Map();
  const rebin = () => {
    bin = new Map();
    for (const c of g.allConsumables) {
      if (!c) continue;
      const k = Math.floor(c.position.x / CELL) + ',' + Math.floor(c.position.z / CELL);
      let arr = bin.get(k);
      if (!arr) { arr = []; bin.set(k, arr); }
      arr.push(c);
    }
  };
  rebin();
  /* EVERY consumable, standing or not. A prop the hole ate on the way in is
     still going to be there in a few seconds — ConsumeSystem respawns it at its
     original position — so counting only state === 0 picks a "clear" patch that
     fills back in under the parked hole. Snowfall: 196 swallows during a park
     on ground that had nothing standing within 18 m when it was chosen. */
  const foodNear = (x, z, r) => {
    let n = 0;
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL), span = Math.ceil(r / CELL);
    for (let a = -span; a <= span; a++) {
      for (let b = -span; b <= span; b++) {
        const arr = bin.get((cx + a) + ',' + (cz + b));
        if (!arr) continue;
        for (const c of arr) {
          if (Math.hypot(c.position.x - x, c.position.z - z) <= r) n++;
        }
      }
    }
    return n;
  };
  const farSpot = () => {
    let best = null, bestFood = Infinity, bestD = -1;
    for (let x = -LIM; x <= EAST; x += CELL) {
      for (let z = -LIM; z <= LIM; z += CELL) {
        const d = Math.hypot(x - p.position.x, z - p.position.z);
        if (d < 300 || g.layout.isWater(x, z)) continue;
        const food = foodNear(x, z, 90);
        if (food > bestFood || (food === bestFood && d <= bestD)) continue;
        if (!HP.pathDry(p.position.x, p.position.z, x, z)) continue;
        best = { x, z, d: Math.round(d), food }; bestFood = food; bestD = d;
      }
    }
    return best || { x: 0, z: 0, d: 0, food: -1 };
  };
  /* How much prop-free ground does the city have at all? Reported, because it
     is the reason this stage has to shrink the hole instead of parking it. */
  const inCityEmpty = HP.emptySpots(60, 0, 0, 1e9, 0)
    .filter((s) => Math.abs(s.x) <= LIM && s.x <= EAST && Math.abs(s.z) <= LIM).length;
  const dest = farSpot();

  const heat0 = hs.heatOf(p), tier0 = hs.tierOf(p), units0 = hs.units().length;
  const sw0 = HP.swallows;
  let swAtPark = 0;
  const samples = [];
  const shed = { maxNearest: 0, zeroUnitFrames: 0, firstZeroT: -1 };
  let clearedAt = -1, tierDownAt = {};
  const sampler = (phase) => (i) => {
    const st = hs.state.get(p);
    const s = {
      i, phase, h: hs.heatOf(p), tier: hs.tierOf(p),
      gain: st ? st.lastGainT : -1e9, away: st ? st.awayT : -1, engaged: st ? st.engaged : false,
      t: hs.t, nearest: hs._nearestUnitDist(p), units: hs.units().length,
    };
    if (s.units === 0 && clearedAt < 0 && samples.length > 60) clearedAt = +(s.t).toFixed(1);
    if (s.units > 0) clearedAt = -1;
    if (s.nearest > shed.maxNearest) shed.maxNearest = Math.round(s.nearest);
    if (s.units === 0) { shed.zeroUnitFrames++; if (shed.firstZeroT < 0) shed.firstZeroT = +s.t.toFixed(1); }
    for (let k = tier0; k > s.tier; k--) if (tierDownAt[k - 1] === undefined) tierDownAt[k - 1] = +s.t.toFixed(1);
    samples.push(s);
    return null;
  };

  /* Route 1 out of the encounter: run. The stand-down needs LEAVE_T (3 s) of
     continuous separation beyond LEAVE_R (110 m), and a late-game hole is
     faster than a cruiser, so this is the player's own escape route being
     exercised rather than anything the probe does to the roster. */
  const at = () => Math.hypot(p.position.x - dest.x, p.position.z - dest.z);
  HP.run(40 * 60, () => HP.aim(dest.x, dest.z), sampler('run'), () => at() < 30);
  const travelFrames = HP.lastFrames;
  const afterRun = {
    heat: +hs.heatOf(p).toFixed(3), tier: hs.tierOf(p), units: hs.units().length,
    d: Math.round(at()), food90: HP.foodWithin(90),
    secs: +(travelFrames / 60).toFixed(1),
    ranAway: Math.round(Math.max(...samples.map((s) => s.nearest))),
  };
  swAtPark = HP.swallows;
  const parkKinds = {};
  const prevSwallowHook = g.consume.onSwallow;
  g.consume.onSwallow = (hole, c, gained, remote) => {
    if (prevSwallowHook) prevSwallowHook(hole, c, gained, remote);
    if (hole === p && c) {
      const k = (c.kind || c.label || '?') + '/t' + (c.tier ? c.tier.id : '?');
      parkKinds[k] = (parkKinds[k] || 0) + 1;
    }
  };

  /* Back to a fresh-spawn hole, in place, and stop. Heat must survive the
     resize — that is asserted, not assumed. */
  /* One last, fine-grained step: park on a patch with nothing standing within
     18 m rather than wherever the run happened to stop. Snowfall needed it —
     its emptiest reachable point still had props close enough for a 2.9 m hole
     to graze, and 334 swallows over a 90 s "park" pushed heat straight back to
     1.0. Re-binned first, because the run just ate a corridor through the map
     and the field is not what it was when the destination was chosen. */
  rebin();
  /* THE QUIETEST GROUND ON THE MAP, and both halves of "quiet" were learned the
     hard way:
       - NOTHING STANDING NEARBY, counted across every state, because a prop the
         run just ate respawns at its original position and lands back under the
         parked hole (Snowfall: 196 swallows on ground that was clear when it
         was chosen);
       - AND OFF THE ROAD, because standing still on tarmac is not "stopped
         causing damage" — traffic drives into the hole. Measured: 68 sedans,
         SUVs, taxis and hatchbacks eaten during one 90 s "park".
     Searched over the whole reachable box rather than around wherever the run
     stopped: the player is being placed by p.reset for the resize anyway, so
     there is no reason to accept a worse spot, and a spot with no junction
     inside SPAWN_MAX_R also stops the escort re-forming and pinning the cooling
     rate at its standoff value. Criteria are relaxed in steps and the chosen
     spot is reported, so a map with nowhere quiet says so instead of quietly
     measuring the wrong thing. */
  const quietSpot = () => {
    for (const [clear, roadPad] of [[34, 30], [26, 22], [20, 16], [16, 12]]) {
      let best = null, bestD = -1;
      for (let x = -LIM; x <= EAST; x += 20) {
        for (let z = -LIM; z <= LIM; z += 20) {
          const d = Math.hypot(x, z);
          if (d <= bestD || g.layout.isWater(x, z)) continue;
          if (g.layout.isRoad(x, z) || g.layout.isRoad(x + roadPad, z)
              || g.layout.isRoad(x - roadPad, z) || g.layout.isRoad(x, z + roadPad)
              || g.layout.isRoad(x, z - roadPad)) continue;
          if (foodNear(x, z, clear) > 0) continue;
          best = { x, z, d: Math.round(d), clear, roadPad }; bestD = d;
        }
      }
      if (best) return best;
    }
    /* Nothing on Miami satisfies even the loosest of those — the map averages
       about seven props inside a 16 m circle — so fall back to the LEAST bad
       point rather than to wherever the run happened to stop. */
    let best = null, bestScore = Infinity;
    for (let x = -LIM; x <= EAST; x += 20) {
      for (let z = -LIM; z <= LIM; z += 20) {
        if (g.layout.isWater(x, z)) continue;
        const onRoad = g.layout.isRoad(x, z) || g.layout.isRoad(x + 14, z)
          || g.layout.isRoad(x - 14, z) || g.layout.isRoad(x, z + 14) || g.layout.isRoad(x, z - 14);
        const score = foodNear(x, z, 20) + (onRoad ? 1000 : 0) - Math.hypot(x, z) / 1000;
        if (score >= bestScore) continue;
        best = { x, z, d: Math.round(Math.hypot(x, z)), clear: foodNear(x, z, 20), roadPad: onRoad ? 0 : 14 };
        bestScore = score;
      }
    }
    return best;
  };
  const parkAt = quietSpot();
  const heatBeforeShrink = hs.heatOf(p);
  p.reset(parkAt ? parkAt.x : p.position.x, parkAt ? parkAt.z : p.position.z, 300);
  p.spawnGrace = 0;
  const heatAfterShrink = hs.heatOf(p);
  const radiusAfterShrink = +p.radius.toFixed(2);

  /* Park until the meter is empty, then STOP. Running the full 100 s regardless
     was a probe bug with a very convincing disguise: on Miami the meter fell
     1.0 -> 0 in 40 s exactly as the model says, and then the 2.9 m hole — which
     had by then eaten 424 hedges, bollards and pedestrians and grown back to
     34 m — re-escalated to tier 3 in the remaining 50 s. The end-of-stage
     readings were taken after that second climb and the whole stage reported
     "heat never decays" on top of a textbook decay curve. */
  const parkX = p.position.x, parkZ = p.position.z;
  HP.run(100 * 60, (i) => {
    HP.park();
    /* HELD AT FRESH-SPAWN SIZE for the duration of the park, and this is the
       last thing that had to be nailed down. There is no genuinely bare ground
       on either map, so the parked hole always grazes something eventually —
       and grazing is a snowball: two hedges make the mouth wider, a wider mouth
       reaches the next two, and inside a minute a 2.9 m hole is 34 m again and
       has driven its own heat back to 1.0. Measured on Snowfall: 354 swallows
       during a "park" on ground with four props within 20 m. Capping the size
       caps the intake at a trickle the cooling curve comfortably outruns; heat
       is untouched by the resize (asserted above). */
    if (i % 30 === 0 && p.radius > 4) { p.reset(parkX, parkZ, 300); p.spawnGrace = 0; }
  }, sampler('park'),
  () => hs.heatOf(p) <= 0.0011 && hs.tierOf(p) === 0);

  /* HOW LONG DOES 0.90 -> 0.30 TAKE, AND HOW LONG SHOULD IT?
   *
   * Reporting "the decay rate" as one number over the longest quiet stretch was
   * wrong and the first version did it: the longest stretch is the flat tail
   * after the meter has already hit zero, so it reported 0.00017/s and called
   * the system broken. The rate is a function of the current heat AND of the
   * distance to the nearest unit, so the honest measurement is an interval and
   * the honest yardstick is heat.js's own curve integrated over it:
   *     dH/dt = -k * (COOL_SHAPE + (1 - COOL_SHAPE) * H)
   *     t     = ln((a + b*H0) / (a + b*H1)) / (k * b)
   * with a = COOL_SHAPE, b = 1 - COOL_SHAPE and k = COOL_MAX at full distance. */
  const quietAt = (s) => s.t - s.gain > 3.0;
  let A = null, B = null;
  for (const s of samples) {
    if (!A) { if (s.phase === 'park' && quietAt(s) && s.h <= 0.90 && s.h > 0.80) A = s; continue; }
    if (!B && s.h <= 0.30) B = s;
  }
  if (!A || !B) { A = samples[0]; B = samples[samples.length - 1]; }
  const dt = B.t - A.t;
  const rate = dt > 0 ? (A.h - B.h) / dt : 0;
  const a = 0.35, b = 0.65, k = 0.055;
  const predicted = Math.log((a + b * A.h) / (a + b * B.h)) / (k * b);
  let nearSum = 0, nearN = 0;
  for (const s of samples) {
    if (s.t >= A.t && s.t <= B.t) { nearSum += Math.min(s.nearest, 170); nearN++; }
  }
  const kind = `mean distance to the nearest unit ${nearN ? Math.round(nearSum / nearN) : -1} m`;

  return {
    dest: { x: Math.round(dest.x), z: Math.round(dest.z), food: dest.food,
      travel: dest.d === undefined ? -1 : dest.d, inCityEmpty,
      parkAt: parkAt
        ? `(${Math.round(parkAt.x)}, ${Math.round(parkAt.z)}) — ${parkAt.clear} props within 20 m, `
          + (parkAt.roadPad ? `${parkAt.roadPad} m clear of any road` : 'ON A ROAD, expect traffic')
        : 'NOWHERE FOUND — parked where the run stopped' },
    swallowsWhileParked: HP.swallows - swAtPark, swallowsRunning: swAtPark - sw0,
    parkKinds: Object.entries(parkKinds).sort((a, b) => b[1] - a[1]).slice(0, 6),
    shrink: { before: +heatBeforeShrink.toFixed(4), after: +heatAfterShrink.toFixed(4),
      radius: radiusAfterShrink, radiusAtEnd: +p.radius.toFixed(2) },
    heat0: +heat0.toFixed(3), tier0, units0,
    afterRun,
    /* `units` here is the WHOLE CITY's roster, not the player's escort:
       heat.units() is global and the focus moves to whichever hole is hottest,
       so units left standing after the player cools are somebody else's
       problem. What matters for route 1 is the three fields after it. */
    end: {
      heat: +hs.heatOf(p).toFixed(4), tier: hs.tierOf(p), units: hs.units().length,
      nearest: Math.round(hs._nearestUnitDist(p)),
      focusIsPlayer: hs.focus === p,
      engaged: !!(hs.state.get(p) && hs.state.get(p).engaged),
    },
    window: { kind, from: +A.h.toFixed(4), to: +B.h.toFixed(4), secs: +dt.toFixed(1),
      nearestFrom: +A.nearest.toFixed(0), nearestTo: +B.nearest.toFixed(0) },
    rate: +rate.toFixed(5), predicted: +predicted.toFixed(1), tierDownAt, clearedAt,
    shed, 
    minTier: Math.min(...samples.map((s) => s.tier)),
    trace: samples.filter((s) => s.i % 600 === 0)
      .map((s) => [s.phase, Math.round(s.i / 60), +s.h.toFixed(3), s.tier, s.units, Math.round(s.nearest)]),
  };
});
for (const t of dec.trace) note(`${t[0]} t=+${t[1]}s`, `heat=${t[2]} tier=${t[3]} units=${t[4]} nearestUnit=${t[5]}m`);
note('ran to', `(${dec.dest.x}, ${dec.dest.z}), ${dec.dest.travel} m away — the emptiest reachable `
  + `point on the map still has ${dec.dest.food} edible props within 90 m`);
note('parked at', String(dec.dest.parkAt));
note('prop-free ground in the reachable map', `${dec.dest.inCityEmpty} points on a 40 m grid have `
  + 'a 60 m clear radius — a late-game hole cannot stand still anywhere in Miami without eating '
  + 'something, and hole.js:752 clamps it inside the map, so the stage shrinks it instead');
note('resize', `heat ${dec.shrink.before} -> ${dec.shrink.after} across `
  + `player.reset(score 300), r=${dec.shrink.radius} (r=${dec.shrink.radiusAtEnd} at the end of the park)`);
note('after the run', JSON.stringify(dec.afterRun));
check('heat survives a resize', Math.abs(dec.shrink.before - dec.shrink.after) < 1e-6,
  `${dec.shrink.before} -> ${dec.shrink.after}`);
note('swallows', `${dec.swallowsRunning} while running there, ${dec.swallowsWhileParked} while parked`
  + (dec.swallowsWhileParked ? ' — ' + JSON.stringify(dec.parkKinds) : ''));
note('tier step-downs (heat clock)', JSON.stringify(dec.tierDownAt));
check('heat decays when the player is clear', dec.end.heat < dec.heat0 * 0.5,
  `${dec.heat0} -> ${dec.end.heat} over 120 s`);
check('the cooling curve matches heat.js\'s own model',
  dec.window.secs >= dec.predicted * 0.6 && dec.window.secs <= dec.predicted * 3.0,
  `${dec.window.from} -> ${dec.window.to} took ${dec.window.secs}s, model predicts ${dec.predicted}s `
  + `at the full-distance rate (mean ${dec.rate}/s; ${dec.window.kind})`);
check('the heat tier comes back down', dec.end.tier < dec.tier0,
  `tier ${dec.tier0} -> ${dec.end.tier} (lowest seen ${dec.minTier})`);
/* "The roster clears" cannot be measured as heat.units().length: that array is
   the WHOLE CITY's response and the focus moves to whichever hole is hottest,
   so units still driving around at the end belong to a bot. What route 1
   promises the player is the three things below. */
check('the response lets the player go',
  dec.shed.maxNearest > EXPECT.LEAVE_R && dec.shed.zeroUnitFrames > 0
  && !dec.end.focusIsPlayer && !dec.end.engaged,
  `ran to ${dec.shed.maxNearest} m from the nearest unit (LEAVE_R=${EXPECT.LEAVE_R}), roster empty for `
  + `${dec.shed.zeroUnitFrames} frames from heat-clock t=${dec.shed.firstZeroT}; at the end the focus is `
  + `the player: ${dec.end.focusIsPlayer}, still engaged: ${dec.end.engaged}, `
  + `${dec.end.units} units left in the city chasing another hole`);

/* ========================================================================== *
 * STAGE 5 — END OF MATCH: clearAll leaves nothing behind
 * ========================================================================== */
step('match end: clearAll leaves zero units and zero residue');

const res = await page.evaluate(async () => {
  const HP = window.__HP__, g = HP.g, hs = HP.hs, glue = g.events, p = g.player;

  /* Put some heat and some units back on the map first — asserting that a
     teardown from an already-empty state is empty proves nothing.
     This doubles as the RE-ESCALATION measurement: the player has just cooled
     all the way to tier 0, so heating them straight back up is the commonest
     thing that happens in a real match, and how long the city takes to turn up
     the second time is worth a number. */
  HP.stage = 'reheat';
  const st0 = hs.state.get(p) || {};
  const reheat = {
    engagedBefore: !!st0.engaged, awayTBefore: +Number(st0.awayT || 0).toFixed(2),
    heatBefore: +hs.heatOf(p).toFixed(3), tierBefore: hs.tierOf(p),
    firstUnitSecs: -1, standDowns: 0, preStandDowns: 0, cues: [],
  };
  const cue0 = HP.cues.length;
  hs.bump(p, 0.95, 'probe');
  HP.pinClock(g.match.elapsed, g.match.timeLeft);
  let prevEngaged = !!st0.engaged;
  HP.run(25 * 60, (i) => HP.steerGreedy(i), (i) => {
    const st = hs.state.get(p);
    /* WITHIN 200 m OF THE PLAYER, not "anywhere in the city": heat.units() is
       global and there is nearly always a unit chasing some bot, which made an
       earlier version of this measurement report 0 s every time. */
    if (reheat.firstUnitSecs < 0 && hs._nearestUnitDist(p) < 200) {
      reheat.firstUnitSecs = +(i / 60).toFixed(2);
    }
    if (prevEngaged && st && !st.engaged) {
      reheat.standDowns++;
      /* A stand-down BEFORE anything has turned up is the symptom of a stale
         `engaged` flag: the city tells the player it has lost them, and takes
         DISENGAGE_HOLD (8 s) off the dispatcher, for an encounter that never
         happened. Location-independent, unlike the time-to-first-unit below —
         which also depends on where the player is standing (a map edge has no
         junction inside SPAWN_MAX_R) and on the global MAX_UNITS cap being
         soaked up by whichever bot is also at tier 3. */
      if (reheat.firstUnitSecs < 0) reheat.preStandDowns++;
    }
    prevEngaged = !!(st && st.engaged);
    return null;
  });
  reheat.cues = HP.cues.slice(cue0).map((c) => c.id + '@' + c.t);
  const before = {
    units: hs.units().length, state: hs.state.size, focus: !!hs.focus,
    views: glue._unitViews.size, sirens: glue._sirens.size,
    marks: glue._marks.filter((m) => m.visible).length,
    sirenLoops: window.__AUDIO__.loopCount ? window.__AUDIO__.loopCount('siren:') : -1,
  };

  /* Run the clock out for real. */
  HP.unpinClock();
  HP.releaseInput();
  g.match.timeLeft = 0.01;
  for (let i = 0; i < 30 && String(g.match.phase) !== 'results'; i++) g.stepSimulation(1 / 60);
  // A couple more steps so eventGlue.update() sees the phase change and tears down.
  for (let i = 0; i < 5; i++) g.stepSimulation(1 / 60);

  const after = {
    phase: String(g.match.phase),
    units: hs.units().length, state: hs.state.size, focus: hs.focus,
    views: glue._unitViews.size, sirens: glue._sirens.size,
    marks: glue._marks.filter((m) => m.visible).length,
    sirenLoops: window.__AUDIO__.loopCount ? window.__AUDIO__.loopCount('siren:') : -1,
    hudTier: glue._hudHeatTier, hudVal: glue._hudHeatVal,
    nextDispatch: +hs._nextDispatch.toFixed(2), heatT: +hs.t.toFixed(1),
    cueTimers: hs._cueAt.size,
  };

  // Idempotent: a second clearAll must not throw and must change nothing.
  let twice = null;
  try { hs.clearAll(); twice = { units: hs.units().length, state: hs.state.size }; }
  catch (e) { twice = { error: String(e).slice(0, 120) }; }

  return { before, after, twice, reheat, cues: HP.cues.length, cov: HP.cov() };
});

note('re-escalation from tier 0', `stale engaged=${res.reheat.engagedBefore} `
  + `awayT=${res.reheat.awayTBefore}; first unit within 200 m after `
  + `${res.reheat.firstUnitSecs}s; ${res.reheat.standDowns} stand-down(s) fired, `
  + `${res.reheat.preStandDowns} of them before any unit arrived`);
note('voice cues during the re-escalation', JSON.stringify(res.reheat.cues));
check('no stale engagement survives cooling to tier 0',
  res.reheat.tierBefore === 0 && !res.reheat.engagedBefore,
  res.reheat.tierBefore === 0
    ? `engaged=${res.reheat.engagedBefore}, awayT=${res.reheat.awayTBefore} at heat `
      + `${res.reheat.heatBefore} / tier ${res.reheat.tierBefore}`
    : `NOT MEASURABLE — the player is at tier ${res.reheat.tierBefore} / heat `
      + `${res.reheat.heatBefore} here, so the decay stage above did not finish cooling them`);
check('no phantom stand-down before the response arrives', res.reheat.preStandDowns === 0,
  `${res.reheat.preStandDowns} stand-down(s) fired with no unit on the scene; `
  + `first unit within 200 m after ${res.reheat.firstUnitSecs}s`);
note('before the whistle', JSON.stringify(res.before));
note('after the whistle', JSON.stringify(res.after));
check('match reaches results', res.after.phase === 'results', 'phase=' + res.after.phase);
check('clearAll leaves zero units', res.after.units === 0, `${res.before.units} -> ${res.after.units}`);
check('clearAll leaves zero per-hole state', res.after.state === 0, `${res.before.state} -> ${res.after.state}`);
check('clearAll drops the focus', res.after.focus === null, String(res.after.focus));
check('no unit meshes survive', res.after.views === 0, `${res.before.views} -> ${res.after.views} views`);
check('no siren loops survive', res.after.sirens === 0 && res.after.sirenLoops <= 0,
  `${res.before.sirens} -> ${res.after.sirens} handles, ${res.after.sirenLoops} live loops`);
check('no telegraph decals survive', res.after.marks === 0, `${res.before.marks} -> ${res.after.marks} visible`);
check('the HUD heat chip is taken down', res.after.hudTier === -1, `_hudHeatTier=${res.after.hudTier}`);
check('cue timers are wiped', res.after.cueTimers === 0, `${res.after.cueTimers} cue timestamps left`);
check('clearAll is idempotent', res.twice && res.twice.units === 0 && res.twice.state === 0,
  JSON.stringify(res.twice));

/* ========================================================================== *
 * AUDIO COVERAGE — before vs after
 * ========================================================================== */
step('audio coverage');
const covAfter = res.cov;
say(`  coverage: ${covBefore.firedCount}/${covBefore.total} -> ${covAfter.firedCount}/${covAfter.total}`);
const HEAT_SOUNDS = ['heatUp', 'heatDown', 'siren', 'dispatchChirp', 'containmentPulse', 'scorePenalty'];
for (const nm of HEAT_SOUNDS) {
  const a = covBefore.counts[nm] || 0, b = covAfter.counts[nm] || 0;
  say(`    ${nm.padEnd(18)} ${String(a).padStart(5)} -> ${String(b).padStart(5)}  ${b > a ? '' : '  <-- NEVER FIRED'}`);
}
say('    (context) countdownBeep ' + covBefore.counts.countdownBeep + ' -> ' + covAfter.counts.countdownBeep
  + ',  ui ' + covBefore.counts.ui + ' -> ' + covAfter.counts.ui);
const silent = HEAT_SOUNDS.filter((nm) => (covAfter.counts[nm] || 0) <= (covBefore.counts[nm] || 0));
check('every heat sound fires in a live match', silent.length === 0,
  silent.length ? 'silent: ' + silent.join(', ') : 'all ' + HEAT_SOUNDS.length + ' fired');

/* WHERE DO THE ESCALATION STINGS COME FROM, AND DO THEY CARRY THE TIER?
 *
 * audio.heatUp(tier) is written to sound different at 1, 2 and 3 — "so the tier
 * is audible without reading the HUD" (audio.js:3153). Two call sites reach it:
 * heat.js _announce (heat.js:848) and _tryDevour (heat.js:1702) via _sfx, which
 * passes NO arguments, and eventGlue._syncHud (eventGlue.js:545), which passes
 * the tier. This counts both, and counts the frames where both fired at once. */
const sting = await page.evaluate(() => {
  const HP = window.__HP__;
  const up = HP.announce.filter((a) => a.up), down = HP.announce.filter((a) => !a.up);
  const heatUps = HP.stings.filter((s) => s.nm === 'heatUp');
  const perFrame = new Map();
  for (const s of heatUps) perFrame.set(s.f, (perFrame.get(s.f) || 0) + 1);
  let doubled = 0;
  for (const n of perFrame.values()) if (n > 1) doubled++;
  const argHist = {};
  for (const s of heatUps) argHist[String(s.arg)] = (argHist[String(s.arg)] || 0) + 1;
  return {
    ups: up.length, downs: down.length,
    playerUps: up.filter((a) => a.player).length,
    botUps: up.filter((a) => !a.player).length,
    heatUpCalls: heatUps.length, doubledFrames: doubled, argHist,
    devours: HP.devours,
    heatDownArgs: HP.stings.filter((s) => s.nm === 'heatDown').length,
    chirps: HP.stings.filter((s) => s.nm === 'dispatchChirp').length,
  };
});
note('tier changes across every hole',
  `${sting.ups} up (${sting.playerUps} player / ${sting.botUps} bot), ${sting.downs} down`);
note('response units devoured', `player ${sting.devours.player}, bots ${sting.devours.bot}`);
note('audio.heatUp call arguments', JSON.stringify(sting.argHist)
  + '   ("undefined" = the tier-1 variant played for every tier)');
note('heatUp accounting', `${sting.heatUpCalls} calls vs ${sting.ups} tier-ups `
  + `+ ${sting.devours.player + sting.devours.bot} devours; `
  + `${sting.doubledFrames} frames fired it twice`);
check('the escalation sting carries its tier', (sting.argHist.undefined || 0) === 0,
  `${sting.argHist.undefined || 0} of ${sting.heatUpCalls} heatUp calls passed no tier`);
/* EXACT accounting, not a ratio. heat.js has precisely two call sites for the
   sting — _announce on a player tier-up and _tryDevour when the PLAYER eats a
   response vehicle — so the total is a sum, and any surplus is a second file
   playing it as well (which eventGlue._syncHud used to do, on the same frame).
   Two player devours can legitimately land on one frame, so "twice in a frame"
   on its own is not the test; this is. */
{
  const expected = sting.playerUps + sting.devours.player;
  check('every escalation sting has exactly one call site',
    sting.heatUpCalls === expected,
    `${sting.heatUpCalls} heatUp calls = ${sting.playerUps} player tier-ups `
    + `+ ${sting.devours.player} player devours (expected ${expected}); `
    + `${sting.botUps} bot tier-ups and ${sting.devours.bot} bot devours were silent`);
}

} catch (err) {
  const msg = String(err).split('\n')[0].slice(0, 200);
  say(`\n*FAIL  ${'probe ran to completion'.padEnd(44)} PAGE DIED — ${msg}`);
  checks.push({ name: 'probe ran to completion', pass: false, detail: 'page died: ' + msg });
}

/* ========================================================================== *
 * SUMMARY
 * ========================================================================== */
step('summary');
if (pageErrors.length) {
  say('PAGE ERRORS (' + pageErrors.length + '):');
  for (const e of pageErrors.slice(0, 6)) say('   ' + e);
}
check('no page errors', pageErrors.length === 0, pageErrors.length + ' errors');

const failed = checks.filter((c) => !c.pass);
say(`\n=== HEAT PROBE ${MAP.toUpperCase()} — ${checks.length - failed.length}/${checks.length} passed `
  + `in ${((Date.now() - t0) / 1000).toFixed(0)}s ===`);
for (const f of failed) say('   FAIL  ' + f.name + '  ' + f.detail);

clearTimeout(WATCHDOG);
await browser.close();
process.exit(failed.length ? 1 : 0);
