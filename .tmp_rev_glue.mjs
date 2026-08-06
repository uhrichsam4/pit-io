/* Adversarial harness for powerupGlue lifecycle. */
import * as THREE from 'three';
import { install, PowerupGlue } from './src/gameplay/powerupGlue.js';
import { ConsumeSystem } from './src/gameplay/consume.js';
import { EntityRegistry } from './src/gameplay/entities.js';
import { Hole } from './src/gameplay/hole.js';
import { PHASE } from './src/gameplay/match.js';
import { POWERUP_ID, POWERUPS } from './src/gameplay/powerups.js';

const fxStub = new Proxy({}, { get: () => () => {} });
const hudStub = { calls: [], setPowerups(l) { this.calls.push(l.length); },
  showPowerupBanner() {}, pushFeed() {} };

function makeGame() {
  const reg = new EntityRegistry();
  const consume = new ConsumeSystem(null, reg, fxStub);
  consume.respawnEnabled = false;
  const g = {
    worldSeed: 1234,
    layout: null,
    effects: fxStub,
    registry: reg,
    engine: { scene: null },
    consume,
    holes: [],
    bots: [],
    player: null,
    hud: hudStub,
    clock: { elapsedTime: 0 },
    match: { phase: PHASE.LOADING },
    _validateSpawn: (x, z) => ({ ok: true }),
    stepCount: 0,
    stepSimulation(dt) { this.stepCount++; for (const h of this.holes) h.update(dt, this.clock.elapsedTime); },
  };
  g.player = new Hole({ type: 'player', x: 0, z: 0 });
  g.holes.push(g.player);
  return g;
}

const g = makeGame();
const sys = install(g);
const glue = sys.glue;
console.log('installed?', !!sys, 'reachHook', typeof g.consume.reachHook,
  'pullHook', typeof g.consume.pullHook, 'pullLimit', g.consume.pullLimit);

let expires = 0, pickups = 0;
const origExpire = sys.onExpire;
sys.onExpire = (h, d) => { expires++; origExpire && origExpire(h, d); };
const origPickup = sys.onPickup;
sys.onPickup = (h, d, s) => { pickups++; origPickup && origPickup(h, d, s); };

/* --- go live -------------------------------------------------------- */
g.match.phase = PHASE.PLAYING;
g.stepSimulation(1 / 60);
console.log('armed?', glue._armed, 'pickups placed', sys.pickups.length);

/* --- grant a boost manually, then kill the player -------------------- */
sys.grant(g.player, POWERUP_ID.VACUUM);
sys.grant(g.player, POWERUP_ID.TURBO);
sys.grant(g.player, POWERUP_ID.MASS);
g.stepSimulation(1 / 60);
console.log('after grant: boosted', glue._boosted.size, 'surged', glue._surged.size,
  'own speed prop?', Object.prototype.hasOwnProperty.call(g.player, 'speed'),
  'radius', g.player.radius.toFixed(4), 'base', Hole.radiusFor(g.player.score).toFixed(4));

const speedBoosted = g.player.speed;
delete g.player.speed;
const speedBase = g.player.speed;
console.log('speed mult observed', (speedBoosted / speedBase).toFixed(4));
// put it back the way _syncSpeed would
g.stepSimulation(1 / 60);

/* THE DEATH PATH */
expires = 0;
g.player.alive = false;
g.stepSimulation(1 / 60);
console.log('DEATH: onExpire fired', expires, 'times for 3 active power-ups;',
  'glue._loops still holds', glue._loops.size, 'handles;',
  'sys effects left', JSON.stringify(sys.residue()));
g.stepSimulation(1 / 60);
console.log('after next step: boosted', glue._boosted.size, 'surged', glue._surged.size,
  'own speed prop?', Object.prototype.hasOwnProperty.call(g.player, 'speed'),
  'radius == base?', g.player.radius === Hole.radiusFor(g.player.score));

/* --- PLAYING -> PLAYING restart (net) with a live boost -------------- */
g.player.alive = true;
sys.grant(g.player, POWERUP_ID.TURBO);
g.stepSimulation(1 / 60);
const oldPlayer = g.player;
console.log('pre-restart: boosted', glue._boosted.size, 'oldPlayer has own speed?',
  Object.prototype.hasOwnProperty.call(oldPlayer, 'speed'));
// simulate a net restart: brand new player hole, phase never leaves PLAYING
const np = new Hole({ type: 'player', x: 5, z: 5 });
g.holes.length = 0; g.holes.push(np); g.player = np;
g.stepSimulation(1 / 60);
console.log('post-restart: armed', glue._armed, 'boosted', glue._boosted.size,
  'OLD player STILL has own speed prop?',
  Object.prototype.hasOwnProperty.call(oldPlayer, 'speed'),
  '| loops still held', glue._loops.size);

/* --- match end -------------------------------------------------------- */
sys.grant(g.player, POWERUP_ID.MASS);
g.stepSimulation(1 / 60);
g.match.phase = PHASE.RESULTS;
g.stepSimulation(1 / 60);
console.log('after RESULTS: armed', glue._armed, 'residue', JSON.stringify(sys.residue()),
  'boosted', glue._boosted.size, 'surged', glue._surged.size, 'loops', glue._loops.size,
  'player radius == base?', g.player.radius === Hole.radiusFor(g.player.score));

/* --- uninstall -------------------------------------------------------- */
glue.uninstall();
console.log('after uninstall: reachHook', g.consume.reachHook, 'pullHook', g.consume.pullHook,
  'pullLimit', g.consume.pullLimit,
  'stepSimulation own prop?', Object.prototype.hasOwnProperty.call(g, 'stepSimulation'));
const before = g.stepCount;
g.stepSimulation(1 / 60);
console.log('inner still runs?', g.stepCount === before + 1);
