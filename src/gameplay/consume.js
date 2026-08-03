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
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _pivot = new THREE.Vector3();
const _rel = new THREE.Vector3();

/**
 * How an object goes down the hole. Chosen per object at capture time, because
 * "everything spirals and shrinks" reads as a delete effect rather than physics.
 *
 *  SLIDE   small litter — skids over the lip and drops almost immediately
 *  TIP     mid-size furniture — leans in, overbalances, then falls
 *  TOPPLE  tall and thin (palms, streetlights, signs) — a full dramatic fall
 *          rotating about its base before the trunk clears the rim
 *  CRUMBLE buildings — shudder, shed debris, then sink and tilt as a mass
 */
export const FALL = { SLIDE: 0, TIP: 1, TOPPLE: 2, CRUMBLE: 3 };

/** Gravity used by the plunge phase. Exaggerated: real g feels floaty here. */
const G = 26.0;

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
        // Too big to swallow. It stays put — but if the hole is actually
        // underneath it, tremble it so the player reads "not yet" rather than
        // "this object is scenery". Only for things that are close to edible,
        // otherwise the whole skyline would buzz.
        if (!hole.isPlayer) continue;
        if (c.eatRadius > hole.radius * 2.2) continue;
        const ddx = hole.position.x - c.position.x;
        const ddz = hole.position.z - c.position.z;
        if (ddx * ddx + ddz * ddz > (hole.radius + c.radius) ** 2) continue;

        this._wobbled.add(c);
        const shake = 0.035 * Math.min(1, hole.radius / Math.max(0.1, c.eatRadius));
        const ox = Math.sin(t * 31 + c.id) * shake;
        const oz = Math.cos(t * 27 + c.id * 1.7) * shake;
        if (c.backing === BACKING.INSTANCE) {
          const p = c.pool;
          _v.copy(p.slotPos[c.slot]); _v.x += ox; _v.z += oz;
          p.setTransform(c.slot, _v, p.slotRot[c.slot], p.slotScale[c.slot]);
        } else if (c.object) {
          if (!c._baseP) {
            c._baseP = c.object.position.clone();
            c._baseQ = c.object.quaternion.clone();
          }
          c.object.position.copy(c._baseP);
          c.object.position.x += ox;
          c.object.position.z += oz;
        }
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

  /**
   * Play the full swallow animation for an object a REMOTE player ate.
   * No score, no screen shake, no popup — their meal, our pixels.
   */
  captureRemote(hole, c, t) {
    if (!c || c.state === STATE.FALLING || c.state === STATE.GONE) return;
    this._capture(hole, c, t, true);
  }

  _capture(hole, c, t, remote = false) {
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

    // --- choose how this thing goes down -------------------------------
    const slender = c.height / Math.max(0.2, c.radius * 2);
    if (c.crumbles || c.tier.id >= 6) c._style = FALL.CRUMBLE;
    else if (slender > 2.2 && c.height > 1.8) c._style = FALL.TOPPLE;
    else if (c.tier.id >= 1) c._style = FALL.TIP;
    else c._style = FALL.SLIDE;

    // Geometry of the fall: n points from the object toward the hole centre.
    const dx = hole.position.x - c.position.x;
    const dz = hole.position.z - c.position.z;
    const dlen = Math.hypot(dx, dz) || 1;
    c._nx = dx / dlen;
    c._nz = dz / dlen;

    // Entry angle for the spiral once it is airborne.
    c._angle = Math.atan2(c.position.z - hole.position.z, c.position.x - hole.position.x);
    c._entryR = dlen;

    // Tip pivot: the object's base edge nearest the hole. Rotating about the
    // horizontal axis perpendicular to n makes the top lean into the void,
    // which is exactly how a bollard or a palm actually goes over.
    c._pivot = new THREE.Vector3(
      c._startPos.x + c._nx * c.radius * 0.85,
      c._startPos.y,
      c._startPos.z + c._nz * c.radius * 0.85
    );
    c._tipAxis = new THREE.Vector3(c._nz, 0, -c._nx).normalize();
    c._tipTarget =
      c._style === FALL.TOPPLE ? Math.PI * (0.62 + Math.random() * 0.16)
      : c._style === FALL.TIP ? Math.PI * (0.34 + Math.random() * 0.18)
      : Math.PI * 0.12;

    // Free tumble once airborne.
    c._spinAxis = new THREE.Vector3(
      Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5
    ).normalize();
    c._spinRate = 2.5 + Math.random() * 4 + Math.min(5, c.radius * 0.5);

    // Phase durations. Heavier things linger on the lip before they commit.
    const heft = Math.min(1, c.radius / 6);
    c._tSlide = c._style === FALL.CRUMBLE ? 0 : 0.055 + heft * 0.07;
    c._tTip = c._style === FALL.SLIDE ? 0.10
      : c._style === FALL.TIP ? 0.20 + heft * 0.14
      : c._style === FALL.TOPPLE ? 0.34 + heft * 0.22
      : 0;
    c._tShake = c._style === FALL.CRUMBLE ? 0.26 + heft * 0.12 : 0;
    c._tPlunge = 0.42 + Math.min(0.7, c.radius * 0.05) + (c._style === FALL.CRUMBLE ? 0.35 : 0);
    c._fallDur = c._tSlide + c._tTip + c._tShake + c._tPlunge;
    c._plungeVY = 0;
    c._plungeY = 0;

    this.falling.push(c);

    // In a networked match the server owns every hole's score, so crediting it
    // locally would double-count the moment the next snapshot lands.
    const gained = remote ? 0 : hole.addScore(c.score, c.label);

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
    if (hole.isPlayer && !remote) {
      fx.popup(_v, `+${c.score}`, big ? 0xffc93c : 0xffffff, big);
    }
    if (remote) fx.shake = Math.min(fx.shake, 0.05);
    if (this.onSwallow) this.onSwallow(hole, c, gained, remote);
  }

  /**
   * The fall is a small state machine rather than one lerp, because the thing
   * that sells it is the *order*: it slides, it tips, it commits, then gravity
   * takes it. Objects never simply fade or shrink away on the ground.
   */
  _updateFalling(dt, t) {
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const c = this.falling[i];
      const hole = c.eatenBy;
      const obj = c.object;
      c.fallT += dt;
      if (!obj) { this._finishFall(c, i); continue; }

      let tt = c.fallT;
      const pitDepth = Math.max(6, hole.radius * HOLE.PIT_DEPTH_F);

      /* ---- 0. shudder (buildings only) --------------------------------- */
      if (c._tShake > 0) {
        if (tt < c._tShake) {
          const k = 1 - tt / c._tShake;
          const a = k * 0.16 * Math.min(3, 0.6 + c.radius * 0.06);
          obj.position.set(
            c._startPos.x + (Math.random() - 0.5) * a * 3,
            c._startPos.y - (1 - k) * 0.4,
            c._startPos.z + (Math.random() - 0.5) * a * 3
          );
          // Shed masonry the whole time it is failing.
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

      /* ---- 1. slide toward the lip ------------------------------------- */
      if (tt < c._tSlide) {
        const k = tt / c._tSlide;
        const slide = k * k * Math.min(1.2, c.radius * 0.55 + 0.25);
        obj.position.set(
          c._startPos.x + c._nx * slide,
          c._startPos.y - k * 0.10 * c.height,
          c._startPos.z + c._nz * slide
        );
        // A touch of lean already building, so the tip does not start abruptly.
        _q.setFromAxisAngle(c._tipAxis, c._tipTarget * 0.12 * k);
        obj.quaternion.copy(c._startQuat).premultiply(_q);
        continue;
      }
      tt -= c._tSlide;

      /* ---- 2. tip over the edge ---------------------------------------- */
      if (tt < c._tTip) {
        const k = tt / c._tTip;
        // Ease in: it resists, then goes. That hesitation is the whole point.
        const e = k * k * (3 - 2 * k) * (0.55 + 0.45 * k);
        const ang = c._tipTarget * e;

        _q.setFromAxisAngle(c._tipAxis, ang);
        // Rotate the body about the contact edge, and let the edge itself sink
        // as the ground under it gives way.
        _pivot.copy(c._pivot);
        _pivot.x += c._nx * e * c.radius * 0.5;
        _pivot.z += c._nz * e * c.radius * 0.5;
        _pivot.y -= e * e * Math.min(3.5, 0.4 + c.radius * 0.5);

        _rel.copy(c._startPos).sub(c._pivot).applyQuaternion(_q);
        obj.position.copy(_pivot).add(_rel);
        obj.quaternion.copy(c._startQuat).premultiply(_q);

        // Hand the plunge a sensible initial velocity so there is no snap.
        c._plungeY = obj.position.y;
        c._plungeVY = -e * 5.0;
        c._tipQuat = _q.clone();
        continue;
      }
      tt -= c._tTip;

      /* ---- 3. plunge ---------------------------------------------------- */
      const k = Math.min(1, tt / c._tPlunge);
      c._plungeVY -= G * dt;
      c._plungeY += c._plungeVY * dt;

      // Spiral inward. Tighter holes swirl faster; huge holes are near-vertical.
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
      // seen deflating while still on the street.
      const depth = (c._startPos.y - obj.position.y) / Math.max(1, pitDepth);
      const shrink = 1 - Math.max(0, depth - 0.28) * 0.95;
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

        // Kills involving a networked hole are the server's call, not ours —
        // two clients each resolving locally would disagree about who died.
        if (this.networked && (a.type === 'remote' || b.type === 'remote')) {
          if (a.isPlayer && this.onClaimKill) this.onClaimKill(b);
          continue;
        }

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
