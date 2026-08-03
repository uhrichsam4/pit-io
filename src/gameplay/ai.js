/**
 * AI opponents.
 *
 * A bot picks a goal — a dense cluster of food it can currently eat, or a
 * smaller rival to hunt — and steers toward it while fleeing anything that
 * could swallow it. Re-plans on a stagger so 7 bots never all think in the
 * same frame.
 */

import * as THREE from 'three';
import { HOLE, WORLD } from '../config.js';
import { Hole } from './hole.js';

const NAMES = [
  'Vortex', 'Cyclone', 'Abyss', 'Sinkhole', 'Maelstrom', 'Rift', 'Chasm',
  'Nova', 'Riptide', 'Undertow', 'Eclipse', 'Zenith', 'Kraken', 'Tempest',
];
const COLORS = [
  0xff4d8d, 0x4dd2ff, 0xffd93c, 0x8bff6b, 0xb388ff,
  0xff9f43, 0x64ffda, 0xff6b6b, 0xa0e7e5, 0xf6a6ff,
];

export class BotController {
  /**
   * @param {Hole} hole
   * @param {import('./entities.js').EntityRegistry} registry
   */
  constructor(hole, registry, rng) {
    this.hole = hole;
    this.registry = registry;
    this.rng = rng;
    this.goal = new THREE.Vector2(hole.position.x, hole.position.z);
    this.replanIn = rng() * 1.2;
    this.skill = 0.55 + rng() * 0.45;
    this.wander = rng() * Math.PI * 2;
    this._q = [];
    this._flee = null;
  }

  update(dt, holes, t) {
    const h = this.hole;
    if (!h.alive) return;
    this.replanIn -= dt;

    // --- threat check runs every frame, it must be reactive ---------------
    let threat = null, threatD = 1e9;
    let prey = null, preyD = 1e9;
    for (const o of holes) {
      if (o === h || !o.alive) continue;
      const d = Math.hypot(o.position.x - h.position.x, o.position.z - h.position.z);
      if (o.radius > h.radius * HOLE.PVP_RATIO * 0.94) {
        const range = 34 + o.radius * 5;
        if (d < range && d < threatD) { threat = o; threatD = d; }
      } else if (h.radius > o.radius * HOLE.PVP_RATIO * 1.04) {
        const range = 46 + h.radius * 6;
        if (d < range && d < preyD) { prey = o; preyD = d; }
      }
    }
    this._flee = threat;

    if (this.replanIn <= 0) {
      this.replanIn = 0.55 + this.rng() * 0.7;
      this._replan(prey, threat);
    }

    let gx = this.goal.x, gz = this.goal.y;
    if (threat) {
      // Run directly away, with a tangential component so bots don't get
      // pinned against the map edge.
      const dx = h.position.x - threat.position.x;
      const dz = h.position.z - threat.position.z;
      const len = Math.hypot(dx, dz) || 1;
      gx = h.position.x + (dx / len) * 90 - (dz / len) * 30;
      gz = h.position.z + (dz / len) * 90 + (dx / len) * 30;
    } else if (prey && preyD < 60 + h.radius * 5) {
      // lead the target
      gx = prey.position.x + prey.velocity.x * 0.7;
      gz = prey.position.z + prey.velocity.z * 0.7;
    }

    // keep inside the map / off the water
    gx = THREE.MathUtils.clamp(gx, -WORLD.SIZE + 24, WORLD.BAY_EDGE - 16);
    gz = THREE.MathUtils.clamp(gz, -WORLD.SIZE + 24, WORLD.SIZE - 24);
    if (Math.abs(gz - WORLD.RIVER_Z) < WORLD.RIVER_HALF_W + 12) {
      gz = WORLD.RIVER_Z + Math.sign(h.position.z - WORLD.RIVER_Z || 1) * (WORLD.RIVER_HALF_W + 26);
    }

    let dx = gx - h.position.x;
    let dz = gz - h.position.z;
    const len = Math.hypot(dx, dz);
    if (len < 1.2) {
      this.wander += (this.rng() - 0.5) * 1.4;
      dx = Math.cos(this.wander); dz = Math.sin(this.wander);
    } else {
      dx /= len; dz /= len;
    }

    // small steering noise keeps them from looking robotic
    const n = (1 - this.skill) * 0.4;
    const a = Math.sin(t * 1.7 + h.id * 2.1) * n;
    const ca = Math.cos(a), sa = Math.sin(a);
    h.desiredDir.set(dx * ca - dz * sa, dx * sa + dz * ca);
  }

  _replan(prey, threat) {
    const h = this.hole;
    if (prey) {
      this.goal.set(prey.position.x, prey.position.z);
      return;
    }
    // Sample a handful of candidate spots and score them by how much edible
    // mass sits nearby versus how far away they are.
    let best = null, bestScore = -1;
    const R = 30 + h.radius * 4;
    for (let i = 0; i < 7; i++) {
      const ang = this.rng() * Math.PI * 2;
      const dist = 20 + this.rng() * (70 + h.radius * 8);
      const x = THREE.MathUtils.clamp(h.position.x + Math.cos(ang) * dist, -WORLD.SIZE + 20, WORLD.BAY_EDGE - 20);
      const z = THREE.MathUtils.clamp(h.position.z + Math.sin(ang) * dist, -WORLD.SIZE + 20, WORLD.SIZE - 20);
      const list = this.registry.query(x, z, R, this._q);
      let value = 0;
      for (const c of list) {
        if (h.radius < c.eatRadius) continue;
        value += Math.min(c.score, 260);
      }
      if (threat) {
        const td = Math.hypot(x - threat.position.x, z - threat.position.z);
        value *= THREE.MathUtils.clamp(td / 90, 0.15, 1.4);
      }
      const cost = 1 + dist * 0.012;
      const s = value / cost;
      if (s > bestScore) { bestScore = s; best = { x, z }; }
    }
    if (best) this.goal.set(best.x, best.z);
  }
}

export function spawnBots(count, registry, rng, spawnPoint) {
  const bots = [];
  const used = [...NAMES];
  for (let i = 0; i < count; i++) {
    const ni = rng.int(0, used.length - 1);
    const name = used.splice(ni, 1)[0] || `Bot ${i + 1}`;
    const p = spawnPoint(i, count);
    const hole = new Hole({
      type: 'bot',
      name,
      color: COLORS[i % COLORS.length],
      x: p.x, z: p.z,
    });
    bots.push({ hole, ctrl: new BotController(hole, registry, rng) });
  }
  return bots;
}
