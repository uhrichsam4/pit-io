/**
 * The swallow system — how the city physically goes down the hole.
 *
 * An object is never deleted where it stands. It goes through a sequence:
 *
 *   1. ATTRACT  once it fits, it is genuinely accelerated toward the centre.
 *               This is integrated velocity, not a pose offset — a bin visibly
 *               skids, a car rolls on its wheels, a palm leans further the
 *               closer it gets. The object's registry position moves with it,
 *               so the capture test and the spatial hash stay honest.
 *   2. TIP      when its centre reaches the lip it pivots about the contact
 *               edge, exactly like something overbalancing off a kerb. Tall
 *               things go over much further than squat ones.
 *   3. PLUNGE   contact is broken and real gravity takes it, spiralling in.
 *               Nothing shrinks until it is well inside the throat, so the
 *               fall is always clearly visible above ground first.
 *
 * THE FIT RULE
 * ------------
 * An object is only ever pulled if the opening is genuinely wider than the
 * object's own footprint (plus the tier gate that paces progression). Anything
 * too big is not tugged, not tilted, not nudged — it sits solidly on the
 * ground, which is what makes the hole read as a real physical opening rather
 * than a scripted delete volume.
 */

import * as THREE from 'three';
import { HOLE, MATCH } from '../config.js';
import { STATE, BACKING } from './entities.js';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qRoll = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _pivot = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * How a given object behaves on its way in. Chosen from what the object
 * actually is — "everything spirals and shrinks" is what makes a swallow read
 * as a delete effect instead of as physics.
 *
 *  SLIDE   flat litter — skids over the lip and drops almost at once
 *  ROLL    anything on wheels — rolls as it is drawn in, then noses over
 *  TOPPLE  tall and thin (signs, lamp posts, hydrants, bollards) — goes over
 *          about its base like a felled post
 *  LEAN    trees and palms — lean further and further, then rotate and fall
 *  SINK    buildings and large structures — shudder, shed debris, then settle
 *          and tilt into the opening under their own weight
 */
export const FALL = { SLIDE: 0, ROLL: 1, TOPPLE: 2, LEAN: 3, SINK: 4 };

/** Gravity for the plunge. Exaggerated: real g feels floaty at this scale. */
const G = 26.0;

/**
 * The hole must be this multiple of an object's own footprint radius before it
 * can be taken. Slightly under 1 because a footprint radius is a bounding
 * circle and most props do not fill theirs.
 */
const FIT = 0.92;

/** Peak inward acceleration at the lip, m/s^2. */
const SUCK_ACCEL = 26.0;

const ROLLING = /car|sedan|suv|taxi|van|truck|bus|pickup|hatch|sport|convert|police|ambul|shuttle|mixer|excav|loader|dumper|flatbed|garbage|cart|stand|scooter|bike|bicycle|barrel|drum|trolley|wheelie/i;
const TREES = /palm|tree|royal|sabal|coconut|banyan|canopy|frond|bougain|tabebuia/i;

function profileFor(c) {
  if (c.crumbles || c.tier.id >= 6) return FALL.SINK;
  const k = c.kind || '';
  if (TREES.test(k)) return FALL.LEAN;
  if (ROLLING.test(k)) return FALL.ROLL;
  // Slenderness decides the rest: a 2.5 m sign post topples, a bench slides.
  const slender = c.height / Math.max(0.25, c.radius * 2);
  if (slender > 1.9 && c.height > 1.2) return FALL.TOPPLE;
  return FALL.SLIDE;
}

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
    /** Objects currently being dragged toward a lip. */
    /** @type {Set<import('./entities.js').Consumable>} */
    this.attracted = new Set();
    this._query = [];
    /** Eat-size multiplier, dropped during the end-of-match frenzy. */
    this.eatScale = 1.0;
    /** Set true in networked matches: the server owns kills and scores. */
    this.networked = false;
    /** Consumers subscribe for kill-feed / audio / netcode. */
    this.onSwallow = null;
    this.onHoleEaten = null;
    this.onClaimKill = null;
  }

  setFrenzy(on) {
    this.eatScale = on ? MATCH.FRENZY_EAT_SCALE : 1.0;
  }

  /**
   * Can this hole take this object *at all*?
   * Two gates, both of which must pass:
   *   - the tier gate, which paces progression, and
   *   - the FIT gate: the opening must actually be wider than the object.
   * The fit gate is what guarantees a bus never vanishes into a hole it plainly
   * would not go through.
   */
  canEat(hole, c) {
    if (hole.radius < c.radius * FIT) return false;
    return hole.radius >= c.eatRadius * this.eatScale;
  }

  /**
   * @param {number} dt
   * @param {import('./hole.js').Hole[]} holes
   * @param {number} t
   */
  update(dt, holes, t) {
    for (const hole of holes) {
      if (!hole.alive) continue;
      this._processHole(hole, dt, t);
    }
    this._updateAttracted(dt, t);
    this._updateFalling(dt, t);
    this._resolvePvP(holes);
  }

  /* ------------------------------------------------------------ attract --- */

  /** Lazily-created per-object motion state. Reused, never allocated per frame. */
  _dyn(c) {
    let d = c._dyn;
    if (!d) {
      d = c._dyn = {
        // world offset from the object's authored resting place
        ox: 0, oy: 0, oz: 0,
        vx: 0, vz: 0,
        roll: 0,     // wheel rotation, radians
        lean: 0,     // lean toward the hole, radians
        hole: null,
        baseX: c.position.x,
        baseZ: c.position.z,
        baseY: c.object ? c.object.position.y : 0,
      };
    }
    return d;
  }

  _processHole(hole, dt, t) {
    const R = hole.radius * HOLE.INFLUENCE_F;
    const list = this.registry.query(hole.position.x, hole.position.z, R, this._query);
    if (list.length === 0) return;

    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.state === STATE.FALLING || c.state === STATE.GONE) continue;
      // Too big: it stays solidly put. No tug, no tilt, no nudge.
      if (!this.canEat(hole, c)) continue;

      const dx = hole.position.x - c.position.x;
      const dz = hole.position.z - c.position.z;
      const d = Math.hypot(dx, dz);

      // Its centre has reached the lip — hand it to the fall sequence.
      if (d <= hole.radius * 0.90) {
        this._capture(hole, c, t);
        continue;
      }
      if (d > R) continue;

      const dyn = this._dyn(c);
      dyn.hole = hole;
      c.state = STATE.WOBBLE;
      this.attracted.add(c);
    }
  }

  /**
   * Integrate everything currently being dragged in. Separated from the query
   * loop so an object caught between two holes is only stepped once.
   */
  _updateAttracted(dt, t) {
    if (this.attracted.size === 0) return;
    for (const c of [...this.attracted]) {
      if (c.state === STATE.FALLING || c.state === STATE.GONE) {
        this.attracted.delete(c);
        continue;
      }
      const dyn = c._dyn;
      const hole = dyn && dyn.hole;
      if (!hole || !hole.alive) { this._release(c, dt); continue; }

      const dx = hole.position.x - c.position.x;
      const dz = hole.position.z - c.position.z;
      const d = Math.hypot(dx, dz) || 1e-4;
      const R = hole.radius * HOLE.INFLUENCE_F;

      if (d > R * 1.05 || !this.canEat(hole, c)) { this._release(c, dt); continue; }

      const nx = dx / d, nz = dz / d;
      // Pull strengthens sharply near the lip, so an object is nudged at the
      // edge of the field and yanked once it is committed.
      const pull = Math.max(0, Math.min(1, 1 - (d - hole.radius) / Math.max(0.001, R - hole.radius)));
      const accel = SUCK_ACCEL * (0.18 + 0.82 * pull * pull);

      dyn.vx += nx * accel * dt;
      dyn.vz += nz * accel * dt;
      // Ground friction, so light things skitter and heavy things resist.
      const drag = Math.exp(-(2.6 + 6.0 / Math.max(1, c.radius * 2)) * dt);
      dyn.vx *= drag; dyn.vz *= drag;

      const stepX = dyn.vx * dt, stepZ = dyn.vz * dt;
      dyn.ox += stepX; dyn.oz += stepZ;
      c.position.x = dyn.baseX + dyn.ox;
      c.position.z = dyn.baseZ + dyn.oz;
      this.registry.rehash(c);

      const travelled = Math.hypot(stepX, stepZ);
      const profile = c._profile ?? (c._profile = profileFor(c));

      // Ground gives way under the leading edge as it nears the lip.
      dyn.oy = -pull * pull * Math.min(0.35, c.height * 0.12);

      switch (profile) {
        case FALL.ROLL:
          // Roll about the axis perpendicular to travel. Wheel radius is
          // approximated from the object's height, which is close enough that
          // the wheels never visibly skid.
          dyn.roll += travelled / Math.max(0.25, c.height * 0.22);
          dyn.lean = pull * 0.10;
          break;
        case FALL.LEAN:
          // A tree does not slide much; it leans, and it leans a long way.
          dyn.lean = pull * pull * 0.42;
          dyn.vx *= 0.90; dyn.vz *= 0.90;
          break;
        case FALL.TOPPLE:
          dyn.lean = pull * pull * 0.30;
          break;
        case FALL.SINK:
          dyn.lean = pull * 0.06;
          dyn.vx *= 0.55; dyn.vz *= 0.55;
          break;
        default:
          dyn.lean = pull * 0.16;
          break;
      }
      // A little jitter as it drags over the ground.
      const jit = pull * 0.03 * Math.sin(t * 26 + c.id * 1.7);

      this._writeAttractedTransform(c, dyn, nx, nz, jit);
    }
  }

  /** Compose and apply the current attracted pose. */
  _writeAttractedTransform(c, dyn, nx, nz, jit) {
    const profile = c._profile;
    // Lean axis: horizontal, perpendicular to the direction of the hole, so
    // the object tips *toward* the opening.
    _axis.set(nz, 0, -nx).normalize();
    _q.setFromAxisAngle(_axis, dyn.lean + jit);

    if (profile === FALL.ROLL && dyn.roll !== 0) {
      // Rolling is about the same horizontal axis, and composes on top.
      _qRoll.setFromAxisAngle(_axis, dyn.roll);
      _q.multiply(_qRoll);
    }

    if (c.backing === BACKING.INSTANCE) {
      const p = c.pool;
      _v.set(
        p.slotPos[c.slot].x + dyn.ox,
        p.slotPos[c.slot].y + dyn.oy,
        p.slotPos[c.slot].z + dyn.oz
      );
      _q2.copy(_q).multiply(p.slotRot[c.slot]);
      p.setTransform(c.slot, _v, _q2, p.slotScale[c.slot]);
    } else if (c.object) {
      if (!c._baseP) {
        c._baseP = c.object.position.clone();
        c._baseQ = c.object.quaternion.clone();
      }
      c.object.position.set(
        c._baseP.x + dyn.ox, c._baseP.y + dyn.oy, c._baseP.z + dyn.oz
      );
      c.object.quaternion.copy(c._baseQ).premultiply(_q);
    }
  }

  /** The hole moved away before it could take this — ease it back home. */
  _release(c, dt) {
    const dyn = c._dyn;
    if (!dyn) { this.attracted.delete(c); c.state = STATE.IDLE; return; }
    const k = 1 - Math.exp(-6.0 * dt);
    dyn.ox += (0 - dyn.ox) * k;
    dyn.oz += (0 - dyn.oz) * k;
    dyn.oy += (0 - dyn.oy) * k;
    dyn.lean += (0 - dyn.lean) * k;
    dyn.vx *= 0.82; dyn.vz *= 0.82;
    c.position.x = dyn.baseX + dyn.ox;
    c.position.z = dyn.baseZ + dyn.oz;
    this.registry.rehash(c);
    this._writeAttractedTransform(c, dyn, 0, 1, 0);

    if (Math.abs(dyn.ox) < 0.01 && Math.abs(dyn.oz) < 0.01 && Math.abs(dyn.lean) < 0.01) {
      dyn.ox = dyn.oz = dyn.oy = dyn.lean = 0;
      dyn.vx = dyn.vz = 0;
      this._restore(c);
      this.attracted.delete(c);
      c.state = STATE.IDLE;
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

  /* ------------------------------------------------------------ capture --- */

  /**
   * Play the full swallow for an object a REMOTE player ate: same animation,
   * no score, no shake, no popup.
   */
  captureRemote(hole, c, t) {
    if (!c || c.state === STATE.FALLING || c.state === STATE.GONE) return;
    this._capture(hole, c, t, true);
  }

  _capture(hole, c, t, remote = false) {
    this.registry.remove(c);
    this.attracted.delete(c);
    c.state = STATE.FALLING;
    c.fallT = 0;
    c.eatenBy = hole;

    const dyn = c._dyn;
    if (c.backing === BACKING.INSTANCE) {
      const proxy = c.pool.leaseProxy(c.slot);
      // leaseProxy restores the authored slot transform, but the object has
      // been sliding for the last second — inherit where it ACTUALLY is, or it
      // snaps back to its parking spot for one frame before falling.
      if (dyn) {
        proxy.position.set(
          c.pool.slotPos[c.slot].x + dyn.ox,
          c.pool.slotPos[c.slot].y + dyn.oy,
          c.pool.slotPos[c.slot].z + dyn.oz
        );
      }
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

    const profile = c._profile ?? (c._profile = profileFor(c));
    c._style = profile;

    const dx = hole.position.x - c.position.x;
    const dz = hole.position.z - c.position.z;
    const dlen = Math.hypot(dx, dz) || 1;
    c._nx = dx / dlen;
    c._nz = dz / dlen;
    c._angle = Math.atan2(c.position.z - hole.position.z, c.position.x - hole.position.x);
    c._entryR = dlen;

    // Tip pivot: the contact edge nearest the void.
    c._pivot = new THREE.Vector3(
      c._startPos.x + c._nx * c.radius * 0.9,
      c._startPos.y,
      c._startPos.z + c._nz * c.radius * 0.9
    );
    c._tipAxis = new THREE.Vector3(c._nz, 0, -c._nx).normalize();
    c._tipTarget =
      profile === FALL.LEAN ? Math.PI * (0.55 + Math.random() * 0.20)
      : profile === FALL.TOPPLE ? Math.PI * (0.48 + Math.random() * 0.18)
      : profile === FALL.ROLL ? Math.PI * (0.30 + Math.random() * 0.14)
      : profile === FALL.SINK ? Math.PI * (0.10 + Math.random() * 0.08)
      : Math.PI * (0.22 + Math.random() * 0.14);

    c._spinAxis = new THREE.Vector3(
      Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5
    ).normalize();
    c._spinRate = 2.2 + Math.random() * 3.6 + Math.min(4, c.radius * 0.4);
    // Carry the roll it built up while being dragged in.
    c._roll = dyn ? dyn.roll : 0;

    // Heavier things hang on the lip longer before they commit.
    const heft = Math.min(1, c.radius / 6);
    c._tShake = profile === FALL.SINK ? 0.30 + heft * 0.16 : 0;
    c._tTip = profile === FALL.SINK ? 0.55 + heft * 0.35
      : profile === FALL.LEAN ? 0.42 + heft * 0.20
      : profile === FALL.TOPPLE ? 0.34 + heft * 0.18
      : profile === FALL.ROLL ? 0.24 + heft * 0.16
      : 0.16 + heft * 0.12;
    c._tPlunge = 0.45 + Math.min(0.8, c.radius * 0.055) + (profile === FALL.SINK ? 0.4 : 0);
    c._fallDur = c._tShake + c._tTip + c._tPlunge;
    c._plungeVY = 0;
    c._plungeY = 0;
    c._tipQuat = null;

    this.falling.push(c);

    // In a networked match the server owns every hole's score, so crediting it
    // locally would double-count the moment the next snapshot lands.
    const gained = remote ? 0 : hole.addScore(c.score, c.label);

    this._captureFx(hole, c, remote);
    if (this.onSwallow) this.onSwallow(hole, c, gained, remote);
  }

  _captureFx(hole, c, remote) {
    const fx = this.effects;
    const big = c.tier.id >= 5;
    _v.set(c.position.x, Math.max(0.1, c.height * 0.35), c.position.z);
    if (c._style === FALL.SINK || big) {
      fx.puff(_v, 0xf3ead8, 26, Math.max(1.5, c.radius * 0.9), 6.5, 1.5 + c.radius * 0.12, 1.3);
      fx.chunks(_v, c.debrisColor, 14, Math.max(0.35, c.radius * 0.16), 8, c.radius * 0.7);
      fx.shockwave(hole.position, hole.radius * 0.9, hole.radius * 2.4, 0xffffff, 0.55);
      if (!remote) fx.addShake(Math.min(0.9, 0.18 + c.radius * 0.03));
    } else {
      fx.puff(_v, 0xe8e2d2, 7, Math.max(0.35, c.radius * 0.7), 2.6, 0.42 + c.radius * 0.1, 0.55);
      if (c.tier.id >= 3) {
        fx.chunks(_v, c.debrisColor, 5, Math.max(0.16, c.radius * 0.14), 4.5, c.radius * 0.5);
        if (!remote) fx.addShake(0.05 + c.radius * 0.012);
      }
    }
    if (hole.isPlayer && !remote) {
      fx.popup(_v, `+${c.score}`, big ? 0xffc93c : 0xffffff, big);
    }
  }

  /* --------------------------------------------------------------- fall --- */

  _updateFalling(dt, t) {
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const c = this.falling[i];
      const hole = c.eatenBy;
      const obj = c.object;
      c.fallT += dt;
      if (!obj) { this._finishFall(c, i); continue; }

      let tt = c.fallT;
      const pitDepth = Math.max(6, hole.radius * HOLE.PIT_DEPTH_F);

      /* ---- 0. structural failure (buildings only) ---------------------- */
      if (c._tShake > 0) {
        if (tt < c._tShake) {
          const k = 1 - tt / c._tShake;
          const a = k * 0.16 * Math.min(3, 0.6 + c.radius * 0.06);
          obj.position.set(
            c._startPos.x + (Math.random() - 0.5) * a * 3,
            c._startPos.y - (1 - k) * 0.5,
            c._startPos.z + (Math.random() - 0.5) * a * 3
          );
          if (Math.random() < dt * 22) {
            _v.set(
              c.position.x + (Math.random() - 0.5) * c.radius * 1.6,
              c.height * (0.2 + Math.random() * 0.7),
              c.position.z + (Math.random() - 0.5) * c.radius * 1.6
            );
            this.effects.chunks(_v, c.debrisColor, 2, Math.max(0.2, c.radius * 0.1), 3, 0.6);
          }
          continue;
        }
        tt -= c._tShake;
      }

      /* ---- 1. overbalance about the contact edge ----------------------- */
      if (tt < c._tTip) {
        const k = tt / c._tTip;
        // Ease in: it resists, then goes. That hesitation is the whole point.
        const e = k * k * (3 - 2 * k) * (0.55 + 0.45 * k);
        const ang = c._tipTarget * e;

        _q.setFromAxisAngle(c._tipAxis, ang);
        _pivot.copy(c._pivot);
        _pivot.x += c._nx * e * c.radius * 0.55;
        _pivot.z += c._nz * e * c.radius * 0.55;
        // The lip itself gives way as the weight comes onto it.
        _pivot.y -= e * e * Math.min(4.0, 0.4 + c.radius * 0.55);

        _rel.copy(c._startPos).sub(c._pivot).applyQuaternion(_q);
        obj.position.copy(_pivot).add(_rel);

        // Keep any rolling it arrived with, underneath the tip rotation.
        _q2.copy(_q);
        if (c._roll) {
          _qRoll.setFromAxisAngle(c._tipAxis, c._roll);
          _q2.multiply(_qRoll);
        }
        obj.quaternion.copy(c._startQuat).premultiply(_q2);

        c._plungeY = obj.position.y;
        c._plungeVY = -e * 5.5;
        c._tipQuat = _q2.clone();
        continue;
      }
      tt -= c._tTip;

      /* ---- 2. plunge --------------------------------------------------- */
      const k = Math.min(1, tt / c._tPlunge);
      c._plungeVY -= G * dt;
      c._plungeY += c._plungeVY * dt;

      const swirlRate = 2.0 + Math.min(5.0, 14 / Math.max(1.2, hole.radius));
      const swirl = c._angle - k * swirlRate;
      const rr = c._entryR * (1 - k) * (1 - k * 0.35);

      obj.position.set(
        hole.position.x + Math.cos(swirl) * rr,
        Math.max(c._plungeY, c._startPos.y - pitDepth * 1.1),
        hole.position.z + Math.sin(swirl) * rr
      );

      _q2.setFromAxisAngle(c._spinAxis, c._spinRate * k);
      if (c._tipQuat) _q2.multiply(c._tipQuat);
      obj.quaternion.copy(c._startQuat).premultiply(_q2);

      // Shrink only once it is genuinely inside the throat, so nothing is ever
      // seen deflating while still above ground.
      const depth = (c._startPos.y - obj.position.y) / Math.max(1, pitDepth);
      const shrink = 1 - Math.max(0, depth - 0.35) * 0.95;
      _s.copy(c._startScale).multiplyScalar(Math.max(0.08, shrink));
      obj.scale.copy(_s);

      if (k >= 1 || obj.position.y < c._startPos.y - pitDepth) this._finishFall(c, i);
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
          if (n.isMesh && n.geometry && !n.geometry.__shared) n.geometry.dispose();
        });
      }
    }
    c.object = null;
    c.state = STATE.GONE;
    this.falling.splice(index, 1);
  }

  /* ---------------------------------------------------------------- pvp --- */

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

        // Kills involving a networked hole are the server's call, not ours —
        // two clients each resolving locally would disagree about who died.
        if (this.networked && (a.type === 'remote' || b.type === 'remote')) {
          if (a.isPlayer && this.onClaimKill) this.onClaimKill(b);
          continue;
        }

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
