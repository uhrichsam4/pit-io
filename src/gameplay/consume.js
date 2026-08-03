/**
 * The swallow system — how the city physically goes down the hole.
 *
 * THE OBJECT THAT FALLS IS THE OBJECT THAT WAS STANDING THERE.
 * Props live as slots in an InstancedMesh, and it is that slot's matrix which
 * is animated. Nothing is spawned to stand in for it, so there is no second
 * copy that can be left behind, and what tips into the hole is provably the
 * prop the player drove up to.
 *
 * SUPPORT, NOT A TRIGGER RADIUS
 * -----------------------------
 * The driving quantity is how much of the prop's footprint still has ground
 * under it. It is computed as the real circle-circle overlap between the prop's
 * footprint and the opening:
 *
 *   support = 1 - overlap(propDisc, holeDisc) / area(propDisc)
 *
 * and everything falls out of that one number:
 *
 *   - A hole narrower than the prop can never take much of its footprint, so
 *     the prop BRIDGES the gap and stays solidly put. That is the "too small"
 *     case, and it is geometry rather than a special case.
 *   - As the hole slides under one side, that side loses support first. The
 *     prop tilts toward the opening, slides, and (if it is on wheels) rolls.
 *     The tilt is continuous in the support fraction, so a hole creeping under
 *     a bench visibly takes it over degree by degree.
 *   - Once more than half the footprint is unsupported the centre of mass is
 *     over the void: it commits, pivots about its remaining contact edge, and
 *     gravity takes it.
 *   - Fully engulfed, it drops straight down and is only removed once it is
 *     below the ground plane.
 *
 * Motion differs by what the thing is (SLIDE / ROLL / TOPPLE / LEAN / SINK) —
 * "everything spirals and shrinks" is what makes a swallow read as a delete
 * effect instead of as physics.
 *
 * RESPAWN
 * -------
 * A consumed prop returns after RESPAWN_DELAY at its original spot (or a
 * nearby one if a hole is sitting on it), fully consumable again. Instanced
 * props reuse their own slot; mesh-backed ones are hidden rather than disposed
 * so they can simply be shown again.
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
const _rest = new THREE.Vector3();
const _qRest = new THREE.Quaternion();
const _sRest = new THREE.Vector3();

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
const G = 21.0;

/**
 * The hole must be this multiple of an object's own footprint radius before it
 * can be taken. Slightly under 1 because a footprint radius is a bounding
 * circle and most props do not fill theirs.
 */
const FIT = 0.92;

/** Peak inward acceleration at the lip, m/s^2. */
const SUCK_ACCEL = 30.0;

/**
 * Unsupported fraction at which the centre of mass is over the void and the
 * prop commits to falling. Exactly 0.5 for a uniform disc; a touch under,
 * because real props carry their mass low and toward their base.
 */
const COMMIT_SUPPORT_LOSS = 0.46;

/** Below this much loss the prop is still solidly supported: no motion at all. */
const TILT_START_LOSS = 0.05;

/** Seconds before a consumed prop returns to the world. */
export const RESPAWN_DELAY = 30;

/**
 * Fraction of a prop's footprint that overlaps a hole of radius `hr` whose
 * centre is `d` away. Standard circle-circle lens area, normalised by the
 * prop's own area — this is the single number the whole system runs on.
 */
function overlapFraction(d, pr, hr) {
  if (d >= pr + hr) return 0;              // clear of each other
  if (d <= hr - pr) return 1;              // prop entirely over the opening
  if (d <= pr - hr) {
    // Opening entirely inside the prop's footprint: it bridges, and the most
    // it can ever lose is the area of the opening itself.
    return (hr * hr) / (pr * pr);
  }
  const pr2 = pr * pr, hr2 = hr * hr, d2 = d * d;
  const a1 = Math.acos(Math.min(1, Math.max(-1, (d2 + pr2 - hr2) / (2 * d * pr))));
  const a2 = Math.acos(Math.min(1, Math.max(-1, (d2 + hr2 - pr2) / (2 * d * hr))));
  const lens = pr2 * (a1 - Math.sin(2 * a1) / 2) + hr2 * (a2 - Math.sin(2 * a2) / 2);
  return Math.min(1, lens / (Math.PI * pr2));
}

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
    /** Props currently mid-fall. */
    this.falling = [];
    /** Props currently losing support but still on the surface. */
    this.attracted = new Set();
    /** @type {{c:object, at:number}[]} consumed props waiting to come back. */
    this.respawns = [];
    this._now = 0;
    this._query = [];
    /** Eat-size multiplier, dropped during the end-of-match frenzy. */
    this.eatScale = 1.0;
    /** Set true in networked matches: the server owns kills and scores. */
    this.networked = false;
    /** Set false to disable the respawner (used by tests). */
    this.respawnEnabled = true;
    this.onSwallow = null;
    this.onHoleEaten = null;
    this.onClaimKill = null;
    this.onRespawn = null;
  }

  setFrenzy(on) {
    this.eatScale = on ? MATCH.FRENZY_EAT_SCALE : 1.0;
  }

  /**
   * Whether this hole is capable of taking this prop at all.
   *
   * The physical half of the rule is that the opening must be wider than the
   * prop's own footprint — otherwise the prop simply bridges the gap, which is
   * what the overlap maths says anyway. The tier gate on top of it is what
   * paces progression.
   */
  canEat(hole, c) {
    if (hole.radius < c.radius * FIT) return false;
    return hole.radius >= c.eatRadius * this.eatScale;
  }

  /** @param {number} dt @param {import('./hole.js').Hole[]} holes @param {number} t */
  update(dt, holes, t) {
    this._now += dt;
    for (const hole of holes) {
      if (!hole.alive) continue;
      this._processHole(hole, dt, t);
    }
    this._updateSupport(dt, t);
    this._updateFalling(dt, t);
    this._updateRespawns(holes);
    this._resolvePvP(holes);
  }

  /* ----------------------------------------------------------- support --- */

  /** Lazily-created per-prop motion state. Reused, never allocated per frame. */
  _dyn(c) {
    let d = c._dyn;
    if (!d) {
      d = c._dyn = {
        ox: 0, oy: 0, oz: 0,      // offset from the authored resting place
        vx: 0, vz: 0,
        roll: 0,                  // wheel rotation, radians
        tilt: 0,                  // current lean toward the opening, radians
        loss: 0,                  // unsupported fraction, 0..1
        nx: 0, nz: 1,             // unit direction toward the opening
        hole: null,
      };
    }
    return d;
  }

  /** Authored resting position of a prop, whatever backs it. */
  _restPos(c, out) {
    if (c.backing === BACKING.INSTANCE && c.pool) return out.copy(c.pool.slotPos[c.slot]);
    if (c._restP) return out.copy(c._restP);
    return out.copy(c.position);
  }

  _processHole(hole, dt, t) {
    const R = hole.radius * HOLE.INFLUENCE_F;
    const list = this.registry.query(hole.position.x, hole.position.z, R, this._query);
    if (list.length === 0) return;

    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.state === STATE.FALLING || c.state === STATE.GONE) continue;
      // A hole too small for this prop cannot unsupport it: it bridges.
      if (!this.canEat(hole, c)) continue;

      const dx = hole.position.x - c.position.x;
      const dz = hole.position.z - c.position.z;
      const d = Math.hypot(dx, dz);
      const loss = overlapFraction(d, Math.max(0.12, c.radius), hole.radius);
      if (loss < TILT_START_LOSS) continue;

      const dyn = this._dyn(c);
      // If two holes are under it, the one taking more of its footprint wins.
      if (dyn.hole && dyn.hole !== hole && dyn.loss > loss) continue;
      dyn.hole = hole;
      dyn.loss = loss;
      const inv = 1 / (d || 1e-4);
      dyn.nx = dx * inv;
      dyn.nz = dz * inv;

      // More than half the footprint over the void: the centre of mass has
      // nothing under it and it goes.
      if (loss >= COMMIT_SUPPORT_LOSS) { this._capture(hole, c, t); continue; }

      c.state = STATE.WOBBLE;
      this.attracted.add(c);
    }
  }

  /**
   * Integrate every prop that is currently losing support. The tilt is a
   * continuous function of how much ground it has lost, so a hole creeping
   * under a bench takes it over degree by degree rather than in one step.
   */
  _updateSupport(dt, t) {
    if (this.attracted.size === 0) return;
    for (const c of [...this.attracted]) {
      if (c.state === STATE.FALLING || c.state === STATE.GONE) {
        this.attracted.delete(c);
        continue;
      }
      const dyn = c._dyn;
      const hole = dyn && dyn.hole;
      if (!hole || !hole.alive || !this.canEat(hole, c)) { this._regainSupport(c, dt); continue; }

      // Re-measure this frame: the hole may have moved on.
      const dx = hole.position.x - c.position.x;
      const dz = hole.position.z - c.position.z;
      const d = Math.hypot(dx, dz);
      const loss = overlapFraction(d, Math.max(0.12, c.radius), hole.radius);
      if (loss < TILT_START_LOSS) { this._regainSupport(c, dt); continue; }
      if (loss >= COMMIT_SUPPORT_LOSS) { this._capture(hole, c, t); continue; }

      dyn.loss = loss;
      const inv = 1 / (d || 1e-4);
      dyn.nx = dx * inv;
      dyn.nz = dz * inv;

      // 0 at first contact, 1 at the commit threshold.
      const u = Math.min(1, (loss - TILT_START_LOSS) / (COMMIT_SUPPORT_LOSS - TILT_START_LOSS));
      const profile = c._profile ?? (c._profile = profileFor(c));

      // It slides as it loses grip, harder the more of it is hanging.
      const accel = SUCK_ACCEL * (0.10 + 0.90 * u * u);
      dyn.vx += dyn.nx * accel * dt;
      dyn.vz += dyn.nz * accel * dt;
      const grip = Math.exp(-(2.6 + 6.0 / Math.max(1, c.radius * 2)) * dt);
      dyn.vx *= grip; dyn.vz *= grip;

      let lateral = 1;
      let tiltGain = 0.55;
      switch (profile) {
        case FALL.ROLL:  tiltGain = 0.34; break;
        // A tree barely shifts its base; it rotates about it, a long way.
        case FALL.LEAN:  tiltGain = 0.85; lateral = Math.exp(-1.6 * dt); break;
        case FALL.TOPPLE: tiltGain = 0.70; break;
        // A building goes down where it stands.
        case FALL.SINK:  tiltGain = 0.14; lateral = Math.exp(-5.0 * dt); break;
        default: break;
      }
      dyn.vx *= lateral; dyn.vz *= lateral;

      const stepX = dyn.vx * dt, stepZ = dyn.vz * dt;
      dyn.ox += stepX; dyn.oz += stepZ;

      // The unsupported side drops as the ground goes out from under it.
      dyn.tilt = u * u * tiltGain;
      dyn.oy = -u * u * Math.min(0.45, c.height * 0.16);
      if (profile === FALL.ROLL) {
        dyn.roll += Math.hypot(stepX, stepZ) / Math.max(0.25, c.height * 0.22);
      }

      this._restPos(c, _rest);
      c.position.x = _rest.x + dyn.ox;
      c.position.z = _rest.z + dyn.oz;
      this.registry.rehash(c);

      // A shudder as it grinds over the failing edge.
      const jit = u * 0.03 * Math.sin(t * 26 + c.id * 1.7);
      this._composeSurfacePose(c, dyn, jit);
      this._writePose(c);
    }
  }

  /** The hole moved off before it could take this — settle back onto the ground. */
  _regainSupport(c, dt) {
    const dyn = c._dyn;
    if (!dyn) { this.attracted.delete(c); c.state = STATE.IDLE; return; }
    const k = 1 - Math.exp(-6.0 * dt);
    dyn.ox += -dyn.ox * k;
    dyn.oz += -dyn.oz * k;
    dyn.oy += -dyn.oy * k;
    dyn.tilt += -dyn.tilt * k;
    dyn.vx *= 0.82; dyn.vz *= 0.82;
    dyn.loss = 0;

    this._restPos(c, _rest);
    c.position.x = _rest.x + dyn.ox;
    c.position.z = _rest.z + dyn.oz;
    this.registry.rehash(c);
    this._composeSurfacePose(c, dyn, 0);
    this._writePose(c);

    if (Math.abs(dyn.ox) < 0.01 && Math.abs(dyn.oz) < 0.01 && Math.abs(dyn.tilt) < 0.01) {
      dyn.ox = dyn.oz = dyn.oy = dyn.tilt = 0;
      dyn.vx = dyn.vz = 0;
      dyn.hole = null;
      this._resetPose(c);
      this.attracted.delete(c);
      c.state = STATE.IDLE;
    }
  }

  /* -------------------------------------------------------------- poses --- */

  /** Scratch pose carried per prop while it is animating. */
  _pose(c) {
    let p = c._poseT;
    if (!p) {
      p = c._poseT = {
        pos: new THREE.Vector3(),
        quat: new THREE.Quaternion(),
        scale: new THREE.Vector3(1, 1, 1),
      };
    }
    return p;
  }

  /** Pose for a prop still on the surface, tilting toward the opening. */
  _composeSurfacePose(c, dyn, jit) {
    const pose = this._pose(c);
    // Tilt about the horizontal axis perpendicular to the opening, so the prop
    // goes over toward it rather than sideways.
    _axis.set(dyn.nz, 0, -dyn.nx).normalize();
    _q.setFromAxisAngle(_axis, dyn.tilt + jit);
    if (c._profile === FALL.ROLL && dyn.roll !== 0) {
      _qRoll.setFromAxisAngle(_axis, dyn.roll);
      _q.multiply(_qRoll);
    }
    this._restPos(c, _rest);
    pose.pos.set(_rest.x + dyn.ox, this._restY(c) + dyn.oy, _rest.z + dyn.oz);
    pose.quat.copy(_q).multiply(this._restQuat(c, _qRest));
    pose.scale.copy(this._restScale(c, _sRest));
  }

  _restY(c) {
    if (c.backing === BACKING.INSTANCE && c.pool) return c.pool.slotPos[c.slot].y;
    return c._restP ? c._restP.y : 0;
  }

  _restQuat(c, out) {
    if (c.backing === BACKING.INSTANCE && c.pool) return out.copy(c.pool.slotRot[c.slot]);
    return c._restQ ? out.copy(c._restQ) : out.identity();
  }

  _restScale(c, out) {
    if (c.backing === BACKING.INSTANCE && c.pool) return out.copy(c.pool.slotScale[c.slot]);
    return c._restS ? out.copy(c._restS) : out.set(1, 1, 1);
  }

  /**
   * Push the current pose at whatever backs this prop. For an instanced prop
   * this writes the REAL slot matrix — there is no stand-in object.
   */
  _writePose(c) {
    const pose = c._poseT;
    if (!pose) return;
    if (c.backing === BACKING.INSTANCE && c.pool && c.slot >= 0) {
      c.pool.setTransform(c.slot, pose.pos, pose.quat, pose.scale);
    } else if (c.object) {
      c.object.position.copy(pose.pos);
      c.object.quaternion.copy(pose.quat);
      c.object.scale.copy(pose.scale);
    }
  }

  /** Put a prop back exactly as authored. */
  _resetPose(c) {
    if (c.backing === BACKING.INSTANCE && c.pool && c.slot >= 0) {
      c.pool.restore(c.slot);
    } else if (c.object && c._restP) {
      c.object.position.copy(c._restP);
      c.object.quaternion.copy(c._restQ);
      c.object.scale.copy(c._restS);
    }
  }

  /* ------------------------------------------------------------ capture --- */

  /** Same animation for a prop a REMOTE player took: no score, no shake. */
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

    // Remember where it belongs, so it can come back.
    if (c.backing !== BACKING.INSTANCE && c.object && !c._restP) {
      c._restP = c.object.position.clone();
      c._restQ = c.object.quaternion.clone();
      c._restS = c.object.scale.clone();
    }

    const dyn = this._dyn(c);
    const profile = c._profile ?? (c._profile = profileFor(c));
    c._style = profile;

    // Start the fall from exactly where it currently stands, mid-tilt.
    this._composeSurfacePose(c, dyn, 0);
    const pose = this._pose(c);
    c._startPos.copy(pose.pos);
    c._startQuat = pose.quat.clone();
    c._startScale = pose.scale.clone();

    const dx = hole.position.x - c.position.x;
    const dz = hole.position.z - c.position.z;
    const dlen = Math.hypot(dx, dz) || 1;
    c._nx = dx / dlen;
    c._nz = dz / dlen;
    c._angle = Math.atan2(c.position.z - hole.position.z, c.position.x - hole.position.x);
    c._entryR = dlen;

    // It pivots about the contact edge it still has — the side away from the
    // opening — which is what a real object overbalancing off a ledge does.
    c._pivot = new THREE.Vector3(
      c._startPos.x + c._nx * c.radius * 0.9,
      c._startPos.y,
      c._startPos.z + c._nz * c.radius * 0.9
    );
    c._tipAxis = new THREE.Vector3(c._nz, 0, -c._nx).normalize();
    c._tipFrom = dyn.tilt;
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
    c._roll = dyn.roll;

    const heft = Math.min(1, c.radius / 6);
    c._tShake = profile === FALL.SINK ? 0.30 + heft * 0.16 : 0;
    c._tTip = profile === FALL.SINK ? 0.55 + heft * 0.35
      : profile === FALL.LEAN ? 0.42 + heft * 0.20
      : profile === FALL.TOPPLE ? 0.34 + heft * 0.18
      : profile === FALL.ROLL ? 0.30 + heft * 0.16
      : 0.24 + heft * 0.12;
    c._tPlunge = 0.45 + Math.min(0.8, c.radius * 0.055) + (profile === FALL.SINK ? 0.4 : 0);
    c._fallDur = c._tShake + c._tTip + c._tPlunge;
    c._plungeVY = 0;
    c._plungeY = c._startPos.y;
    c._tipQuat = null;

    this.falling.push(c);

    // In a networked match the server owns every hole's score.
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
      const pose = this._pose(c);
      c.fallT += dt;

      let tt = c.fallT;
      const pitDepth = Math.max(6, hole.radius * HOLE.PIT_DEPTH_F);

      /* ---- 0. structural failure (buildings only) ---------------------- */
      if (c._tShake > 0 && tt < c._tShake) {
        const k = 1 - tt / c._tShake;
        const a = k * 0.16 * Math.min(3, 0.6 + c.radius * 0.06);
        pose.pos.set(
          c._startPos.x + (Math.random() - 0.5) * a * 3,
          c._startPos.y - (1 - k) * 0.5,
          c._startPos.z + (Math.random() - 0.5) * a * 3
        );
        this._writePose(c);
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
      if (c._tShake > 0) tt -= c._tShake;

      /* ---- 1. overbalance about the remaining contact edge -------------- */
      if (tt < c._tTip) {
        const k = tt / c._tTip;
        // Ease in: it resists, then goes. Continues from the lean it already
        // had, so there is no jump between losing support and falling.
        const e = k * k * (3 - 2 * k) * (0.55 + 0.45 * k);
        const ang = c._tipFrom + (c._tipTarget - c._tipFrom) * e;

        _q.setFromAxisAngle(c._tipAxis, ang);
        _pivot.copy(c._pivot);
        _pivot.x += c._nx * e * c.radius * 0.55;
        _pivot.z += c._nz * e * c.radius * 0.55;
        // The lip itself gives way as the weight comes onto it.
        _pivot.y -= e * e * Math.min(4.0, 0.4 + c.radius * 0.55);

        _rel.copy(c._startPos).sub(c._pivot).applyQuaternion(_q);
        pose.pos.copy(_pivot).add(_rel);

        _q2.copy(_q);
        if (c._roll) {
          _qRoll.setFromAxisAngle(c._tipAxis, c._roll);
          _q2.multiply(_qRoll);
        }
        pose.quat.copy(c._startQuat).premultiply(_q2);
        pose.scale.copy(c._startScale);
        this._writePose(c);

        c._plungeY = pose.pos.y;
        c._plungeVY = -e * 3.0;
        c._tipQuat = _q2.clone();
        continue;
      }
      tt -= c._tTip;

      /* ---- 2. plunge ---------------------------------------------------- */
      const k = Math.min(1, tt / c._tPlunge);
      c._plungeVY -= G * dt;
      c._plungeY += c._plungeVY * dt;

      const swirlRate = 2.0 + Math.min(5.0, 14 / Math.max(1.2, hole.radius));
      const swirl = c._angle - k * swirlRate;
      const rr = c._entryR * (1 - k) * (1 - k * 0.35);
      const floor = c._startPos.y - pitDepth * 1.1;

      pose.pos.set(
        hole.position.x + Math.cos(swirl) * rr,
        Math.max(c._plungeY, floor),
        hole.position.z + Math.sin(swirl) * rr
      );

      _q2.setFromAxisAngle(c._spinAxis, c._spinRate * k);
      if (c._tipQuat) _q2.multiply(c._tipQuat);
      pose.quat.copy(c._startQuat).premultiply(_q2);

      // Only once it is well inside the throat, and never while any of it is
      // still above the ground plane.
      const depth = (c._startPos.y - pose.pos.y) / Math.max(1, pitDepth);
      const shrink = 1 - Math.max(0, depth - 0.35) * 0.95;
      pose.scale.copy(c._startScale).multiplyScalar(Math.max(0.08, shrink));
      this._writePose(c);

      // Removed only once it is genuinely below ground.
      const below = pose.pos.y < -Math.max(1.5, c.height * 0.6);
      if (below || k >= 1) this._finishFall(c, i);
    }
  }

  _finishFall(c, index) {
    if (c.backing === BACKING.INSTANCE && c.pool && c.slot >= 0) {
      c.pool.hide(c.slot);
    } else if (c.object) {
      // Kept, not disposed: it has to be able to come back.
      c.object.visible = false;
    }
    c.state = STATE.GONE;
    this.falling.splice(index, 1);

    if (this.respawnEnabled) {
      this.respawns.push({ c, at: this._now + RESPAWN_DELAY });
    }
  }

  /* ------------------------------------------------------------ respawn --- */

  /**
   * Bring consumed props back so the city does not strip-mine itself to a bare
   * plate over a long match. A prop will not return under a hole that is
   * sitting on its spot — it just waits and tries again.
   */
  _updateRespawns(holes) {
    if (this.respawns.length === 0) return;
    for (let i = this.respawns.length - 1; i >= 0; i--) {
      const entry = this.respawns[i];
      if (this._now < entry.at) continue;
      const c = entry.c;

      this._restPos(c, _rest);
      let blocked = false;
      for (const h of holes) {
        if (!h.alive) continue;
        const dx = h.position.x - _rest.x;
        const dz = h.position.z - _rest.z;
        if (dx * dx + dz * dz < (h.radius + c.radius) ** 2) { blocked = true; break; }
      }
      if (blocked) { entry.at = this._now + 2; continue; }

      this.respawns.splice(i, 1);
      this._respawn(c, _rest);
    }
  }

  _respawn(c, at) {
    const dyn = c._dyn;
    if (dyn) {
      dyn.ox = dyn.oy = dyn.oz = 0;
      dyn.vx = dyn.vz = 0;
      dyn.roll = 0; dyn.tilt = 0; dyn.loss = 0; dyn.hole = null;
    }
    c.state = STATE.IDLE;
    c.fallT = 0;
    c.eatenBy = null;
    c._tipQuat = null;
    c.position.set(at.x, c.position.y, at.z);

    if (c.backing === BACKING.INSTANCE && c.pool && c.slot >= 0) {
      c.pool.restore(c.slot);
    } else if (c.object) {
      c.object.visible = true;
      if (c._restP) {
        c.object.position.copy(c._restP);
        c.object.quaternion.copy(c._restQ);
        c.object.scale.copy(c._restS);
      }
    }
    this.registry.add(c);

    // A small puff so it does not simply blink into existence.
    _v.set(at.x, Math.max(0.15, c.height * 0.25), at.z);
    this.effects.puff(_v, 0xffffff, 5, Math.max(0.3, c.radius * 0.6), 1.6, 0.3 + c.radius * 0.08, 0.4);
    if (this.onRespawn) this.onRespawn(c);
  }

  /* ---------------------------------------------------------------- pvp --- */

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
        if (Math.hypot(dx, dz) > a.radius * 0.85) continue;

        // Kills involving a networked hole are the server's call: two clients
        // resolving locally would disagree about who died.
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
