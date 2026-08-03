/**
 * The swallow system: suction, capture, the tumble down the pit, and hole-vs-hole.
 *
 * Feel notes (these are the numbers that make or break the game):
 *  - Objects lean toward the lip BEFORE they fall. Anticipation is what makes
 *    the hole feel like it has gravity rather than being a delete volume.
 *  - Capture triggers slightly inside the visual lip, so the object is already
 *    overlapping the void when it commits — never popping out of solid ground.
 *  - Falling objects spiral. A straight drop looks like an object being deleted;
 *    a spiral looks like a drain.
 */

import * as THREE from 'three';
import { HOLE, MATCH } from '../config.js';
import { STATE, BACKING } from './entities.js';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

export class ConsumeSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./entities.js').EntityRegistry} registry
   * @param {import('../render/effects.js').Effects} effects
   */
  constructor(scene, registry, effects) {
    this.scene = scene;
    this.registry = registry;
    this.effects = effects;
    /** @type {import('./entities.js').Consumable[]} */
    this.falling = [];
    this._query = [];
    this._wobbled = new Set();
    this._wobbledPrev = new Set();
    /** Eat-size multiplier, dropped during end-of-match frenzy. */
    this.eatScale = 1.0;
    /** Consumers subscribe for kill-feed / audio. */
    this.onSwallow = null;
    this.onHoleEaten = null;
  }

  setFrenzy(on) {
    this.eatScale = on ? MATCH.FRENZY_EAT_SCALE : 1.0;
  }

  canEat(hole, c) {
    return hole.radius >= c.eatRadius * this.eatScale;
  }

  /**
   * @param {number} dt
   * @param {import('./hole.js').Hole[]} holes
   * @param {number} t
   */
  update(dt, holes, t) {
    // swap wobble sets
    const tmp = this._wobbledPrev;
    this._wobbledPrev = this._wobbled;
    this._wobbled = tmp;
    this._wobbled.clear();

    for (const hole of holes) {
      if (!hole.alive) continue;
      this._processHole(hole, dt, t);
    }

    // restore anything that stopped being tugged
    for (const c of this._wobbledPrev) {
      if (this._wobbled.has(c) || c.state === STATE.FALLING) continue;
      this._restore(c);
      c.state = STATE.IDLE;
    }

    this._updateFalling(dt, t);
    this._resolvePvP(holes);
  }

  _processHole(hole, dt, t) {
    const R = hole.radius * HOLE.INFLUENCE_F;
    const list = this.registry.query(hole.position.x, hole.position.z, R, this._query);
    if (list.length === 0) return;

    const capture = hole.radius * HOLE.CAPTURE_F;
    const cap2 = capture * capture;

    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.state === STATE.FALLING) continue;
      if (!this.canEat(hole, c)) {
        // Too big: nudge nothing, but let very close misses rumble a touch.
        continue;
      }
      const dx = hole.position.x - c.position.x;
      const dz = hole.position.z - c.position.z;
      const d2 = dx * dx + dz * dz;

      // Capture when the object's near edge crosses the lip.
      const reach = capture + c.radius * 0.55;
      if (d2 < reach * reach && d2 < Math.max(cap2, reach * reach)) {
        this._capture(hole, c, t);
        continue;
      }
      if (d2 > R * R) continue;

      // --- suction lean -------------------------------------------------
      const d = Math.sqrt(d2) || 0.0001;
      const falloff = 1 - (d - capture) / Math.max(0.001, R - capture);
      const pull = Math.max(0, Math.min(1, falloff));
      if (pull <= 0.02) continue;

      this._wobbled.add(c);
      c.state = STATE.WOBBLE;

      const nx = dx / d, nz = dz / d;
      const lean = pull * pull * 0.30;
      const slide = pull * pull * Math.min(1.4, hole.radius * 0.10);
      const jit = Math.sin(t * 24 + c.id * 1.7) * pull * 0.035;

      if (c.backing === BACKING.INSTANCE) {
        const p = c.pool;
        _v.copy(p.slotPos[c.slot]);
        _v.x += nx * slide; _v.z += nz * slide;
        _v.y -= pull * 0.12 * c.height;
        _e.set(nz * lean + jit, 0, -nx * lean + jit);
        _q.setFromEuler(_e).multiply(p.slotRot[c.slot]);
        p.setTransform(c.slot, _v, _q, p.slotScale[c.slot]);
      } else if (c.object) {
        if (!c._baseP) {
          c._baseP = c.object.position.clone();
          c._baseQ = c.object.quaternion.clone();
        }
        c.object.position.copy(c._baseP);
        c.object.position.x += nx * slide * 0.5;
        c.object.position.z += nz * slide * 0.5;
        c.object.position.y -= pull * 0.06 * c.height;
        _e.set(nz * lean * 0.5 + jit * 0.4, 0, -nx * lean * 0.5 + jit * 0.4);
        _q.setFromEuler(_e);
        c.object.quaternion.copy(c._baseQ).premultiply(_q);
      }
    }
  }

  _restore(c) {
    if (c.backing === BACKING.INSTANCE && c.pool && c.slot >= 0) {
      const p = c.pool;
      p.setTransform(c.slot, p.slotPos[c.slot], p.slotRot[c.slot], p.slotScale[c.slot]);
    } else if (c.object && c._baseP) {
      c.object.position.copy(c._baseP);
      c.object.quaternion.copy(c._baseQ);
    }
  }

  _capture(hole, c, t) {
    this.registry.remove(c);
    c.state = STATE.FALLING;
    c.fallT = 0;
    c.eatenBy = hole;

    if (c.backing === BACKING.INSTANCE) {
      const proxy = c.pool.leaseProxy(c.slot);
      this.scene.add(proxy);
      c.object = proxy;
    }
    if (c.object) {
      c._startPos.copy(c.object.position);
      c._startQuat = c.object.quaternion.clone();
      c._startScale = c.object.scale.clone();
      c.object.castShadow = false;
      c.object.receiveShadow = false;
    } else {
      c._startPos.copy(c.position);
    }

    // Entry angle for the spiral.
    c._angle = Math.atan2(c.position.z - hole.position.z, c.position.x - hole.position.x);
    c._entryR = Math.hypot(c.position.x - hole.position.x, c.position.z - hole.position.z);
    c._spinAxis = new THREE.Vector3(
      Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5
    ).normalize();
    c._spinRate = 3 + Math.random() * 5 + Math.min(6, c.radius);
    c._fallDur = HOLE.FALL_TIME * (c.crumbles ? 1.55 : 1) * (0.82 + Math.min(0.9, c.radius * 0.06));

    this.falling.push(c);

    const gained = hole.addScore(c.score, c.label);

    // --- feedback --------------------------------------------------------
    const fx = this.effects;
    const big = c.tier.id >= 5;
    _v.set(c.position.x, Math.max(0.1, c.height * 0.35), c.position.z);
    if (c.crumbles || big) {
      fx.puff(_v, 0xf3ead8, 26, Math.max(1.5, c.radius * 0.9), 6.5, 1.5 + c.radius * 0.12, 1.3);
      fx.chunks(_v, c.debrisColor, 14, Math.max(0.35, c.radius * 0.16), 8, c.radius * 0.7);
      fx.shockwave(hole.position, hole.radius * 0.9, hole.radius * 2.4, 0xffffff, 0.55);
      fx.addShake(Math.min(0.9, 0.18 + c.radius * 0.03));
    } else {
      fx.puff(_v, 0xe8e2d2, 7, Math.max(0.35, c.radius * 0.7), 2.6, 0.42 + c.radius * 0.1, 0.55);
      if (c.tier.id >= 3) {
        fx.chunks(_v, c.debrisColor, 5, Math.max(0.16, c.radius * 0.14), 4.5, c.radius * 0.5);
        fx.addShake(0.05 + c.radius * 0.012);
      }
    }
    if (hole.isPlayer) {
      fx.popup(_v, `+${c.score}`, big ? 0xffc93c : 0xffffff, big);
    }
    if (this.onSwallow) this.onSwallow(hole, c, gained);
  }

  _updateFalling(dt, t) {
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const c = this.falling[i];
      const hole = c.eatenBy;
      c.fallT += dt;
      const dur = c._fallDur;
      const u = Math.min(1, c.fallT / dur);

      const obj = c.object;
      if (!obj) { this._finishFall(c, i); continue; }

      // Crumbling buildings jitter in place before they give way.
      let shakeT = 0;
      if (c.crumbles) {
        shakeT = Math.min(1, c.fallT / 0.28);
        if (shakeT < 1) {
          const a = (1 - shakeT) * 0.12;
          obj.position.set(
            c._startPos.x + (Math.random() - 0.5) * a * 3,
            c._startPos.y,
            c._startPos.z + (Math.random() - 0.5) * a * 3
          );
          continue;
        }
      }

      const p = c.crumbles ? Math.min(1, (c.fallT - 0.28) / (dur - 0.28)) : u;
      // Accelerating descent — objects hang at the lip then drop away hard.
      const drop = p * p * (2.2 - p);
      const swirl = c._angle - p * (2.4 + Math.min(4.5, 12 / Math.max(1, hole.radius)));
      const rr = c._entryR * (1 - p * 0.94);

      obj.position.set(
        hole.position.x + Math.cos(swirl) * rr,
        c._startPos.y - drop * hole.radius * HOLE.PIT_DEPTH_F * 0.85 - c.height * 0.15,
        hole.position.z + Math.sin(swirl) * rr
      );

      _q.setFromAxisAngle(c._spinAxis, c._spinRate * p);
      obj.quaternion.copy(c._startQuat).premultiply(_q);

      const shrink = 1 - p * 0.72;
      _s.copy(c._startScale).multiplyScalar(shrink);
      obj.scale.copy(_s);

      if (u >= 1) this._finishFall(c, i);
    }
  }

  _finishFall(c, index) {
    const obj = c.object;
    if (obj) {
      if (c.backing === BACKING.INSTANCE && c.pool) {
        c.pool.releaseProxy(obj);
      } else {
        if (obj.parent) obj.parent.remove(obj);
        obj.traverse((n) => {
          if (n.isMesh) {
            if (n.geometry && !n.geometry.__shared) n.geometry.dispose();
          }
        });
      }
    }
    c.object = null;
    c.state = STATE.GONE;
    this.falling.splice(index, 1);
  }

  /** Bigger holes eat smaller holes. */
  _resolvePvP(holes) {
    for (let i = 0; i < holes.length; i++) {
      const a = holes[i];
      if (!a.alive) continue;
      for (let j = 0; j < holes.length; j++) {
        if (i === j) continue;
        const b = holes[j];
        if (!b.alive) continue;
        if (a.radius < b.radius * HOLE.PVP_RATIO) continue;
        const dx = a.position.x - b.position.x;
        const dz = a.position.z - b.position.z;
        const d = Math.hypot(dx, dz);
        if (d > a.radius * 0.85) continue;

        // a swallows b
        b.alive = false;
        b.killedBy = a;
        b.respawnAt = HOLE.RESPAWN_TIME;
        const reward = Math.max(20, Math.round(b.score * HOLE.PVP_REWARD));
        a.addScore(reward, b.name);
        this.effects.shockwave(a.position, a.radius, a.radius * 3.6, b.color.getHex(), 0.8);
        this.effects.puff(
          new THREE.Vector3(b.position.x, 1.2, b.position.z),
          b.color.getHex(), 46, b.radius * 1.2, 9, 1.4, 1.1
        );
        this.effects.addShake(a.isPlayer || b.isPlayer ? 0.95 : 0.25);
        if (this.onHoleEaten) this.onHoleEaten(a, b, reward);
      }
    }
  }
}
