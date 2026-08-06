/* Adversarial harness for the Vacuum Boost pull path. */
import * as THREE from 'three';
import { ConsumeSystem } from '../../../../../../Users/sam/untitled folder 6/src/gameplay/consume.js';
import { EntityRegistry, Consumable, STATE } from '../../../../../../Users/sam/untitled folder 6/src/gameplay/entities.js';
import { TIER } from '../../../../../../Users/sam/untitled folder 6/src/config.js';
import { PowerupSystem, POWERUPS, POWERUP_ID } from '../../../../../../Users/sam/untitled folder 6/src/gameplay/powerups.js';
import { Hole } from '../../../../../../Users/sam/untitled folder 6/src/gameplay/hole.js';
import { HOLE } from '../../../../../../Users/sam/untitled folder 6/src/config.js';

const fxStub = new Proxy({}, { get: () => () => {} });

function makeWorld() {
  const reg = new EntityRegistry();
  const consume = new ConsumeSystem(null, reg, fxStub);
  consume.respawnEnabled = false;
  return { reg, consume };
}

function mkProp(x, z, opts = {}) {
  // Fake instanced pool so _restPos has a stable authored anchor, the way the
  // real city does (world builders always pass a pool).
  const pos = new THREE.Vector3(x, 0, z);
  const c = new Consumable(Object.assign({
    position: pos, radius: 0.6, height: 1.0, kind: 'bench', tier: TIER.TINY, score: 7,
  }, opts));
  c.pool = { slotPos: [pos.clone()], slotRot: [new THREE.Quaternion()], slotScale: [new THREE.Vector3(1,1,1)],
             setTransform() {}, hide() {}, show() {} };
  c.slot = 0;
  return c;
}

/* ------------------------------------------------------------------ test 1 */
{
  const { reg, consume } = makeWorld();
  const sys = new PowerupSystem({});
  consume.reachHook = (h) => sys.queryRadiusMultiplier(h);
  consume.pullHook = (h, c, d, bR) => sys.pullAccel(h, c, d, bR);
  consume.pullLimit = POWERUPS.vacuum.cfg.maxPulled;

  const hole = new Hole({ type: 'player', x: 0, z: 0 });
  hole.reset(0, 0, 400);            // grow it a bit
  const baseR = Math.max(hole.radius * HOLE.INFLUENCE_F, hole.radius + 14);
  const boostR = baseR * POWERUPS.vacuum.cfg.reachMultiplier;
  // Sit the prop between baseR and boostR so ONLY the boost can see it.
  const d0 = (baseR + boostR) / 2;
  const c = mkProp(d0, 0);
  reg.add(c);

  let swallows = 0, gained = 0;
  consume.onSwallow = (h, cc, g) => { swallows++; gained += g; };

  sys.grant(hole, POWERUP_ID.VACUUM);
  const startScore = hole.score;
  let t = 0;
  const dt = 1 / 60;
  for (let i = 0; i < 60 * 40; i++) {
    t += dt;
    sys.update(dt, [hole], t);
    consume.update(dt, [hole], t);
    if (c.state === STATE.GONE) break;
  }
  console.log('T1 hole.radius', hole.radius.toFixed(2), 'baseR', baseR.toFixed(2), 'boostR', boostR.toFixed(2));
  console.log('T1 prop state', c.state, 'dist', Math.hypot(c.position.x, c.position.z).toFixed(2),
              'swallows', swallows, 'gained', gained, 'scoreDelta', hole.score - startScore);
  console.log('T1 in registry?', [...(reg.byId ? reg.byId.values() : [])].includes(c));
  console.log('T1 pulled set size', consume.pulled.size, 'attracted', consume.attracted.size);
}

/* ------------------------------------------------------------------ test 2
 * The boost expires while the prop is still in flight. Does it settle back to
 * IDLE, and is `pulled` emptied?
 */
{
  const { reg, consume } = makeWorld();
  const sys = new PowerupSystem({});
  consume.reachHook = (h) => sys.queryRadiusMultiplier(h);
  consume.pullHook = (h, c, d, bR) => sys.pullAccel(h, c, d, bR);
  consume.pullLimit = POWERUPS.vacuum.cfg.maxPulled;

  const hole = new Hole({ type: 'player', x: 0, z: 0 });
  hole.reset(0, 0, 400);
  const baseR = Math.max(hole.radius * HOLE.INFLUENCE_F, hole.radius + 14);
  const boostR = baseR * POWERUPS.vacuum.cfg.reachMultiplier;
  const c = mkProp(boostR * 0.97, 0);
  reg.add(c);

  sys.grant(hole, POWERUP_ID.VACUUM);
  let t = 0; const dt = 1 / 60;
  let sawWobble = false;
  for (let i = 0; i < 60 * 60; i++) {
    t += dt;
    sys.update(dt, [hole], t);
    consume.update(dt, [hole], t);
    if (c.state === STATE.WOBBLE) sawWobble = true;
    if (i === 120) sys.revoke(hole, POWERUP_ID.VACUUM, true);   // kill it early
  }
  console.log('T2 sawWobble', sawWobble, 'finalState', c.state,
              'pulled', consume.pulled.size, 'attracted', consume.attracted.size,
              'dyn.v', c._dyn && [c._dyn.vx.toFixed(4), c._dyn.vz.toFixed(4)],
              'offset', c._dyn && [c._dyn.ox.toFixed(2), c._dyn.oz.toFixed(2)]);
}

/* ------------------------------------------------------------------ test 3
 * No hook installed at all: byte-for-byte the old behaviour?
 */
{
  const runs = [];
  for (const withHooks of [false, true]) {
    const { reg, consume } = makeWorld();
    const sys = new PowerupSystem({});
    if (withHooks) {
      consume.reachHook = (h) => sys.queryRadiusMultiplier(h);   // returns 1, inactive
      consume.pullHook = (h, c, d, bR) => sys.pullAccel(h, c, d, bR);
      consume.pullLimit = POWERUPS.vacuum.cfg.maxPulled;
    }
    const hole = new Hole({ type: 'player', x: 0, z: 0 });
    hole.reset(0, 0, 400);
    const props = [];
    for (let i = 0; i < 30; i++) {
      const a = (i / 30) * Math.PI * 2;
      const p = mkProp(Math.cos(a) * (4 + i * 0.7), Math.sin(a) * (4 + i * 0.7));
      reg.add(p); props.push(p);
    }
    let t = 0; const dt = 1 / 60;
    for (let i = 0; i < 600; i++) { t += dt; consume.update(dt, [hole], t); }
    runs.push({ score: hole.score, states: props.map((p) => p.state).join(''),
                pos: props.map((p) => p.position.x.toFixed(4)).join(',') });
  }
  console.log('T3 identical without/with inert hooks:',
              runs[0].score === runs[1].score && runs[0].states === runs[1].states
              && runs[0].pos === runs[1].pos, runs[0].score, runs[1].score);
}
