/**
 * The swallow system — how the city physically goes down the hole.
 *
 * ELIGIBILITY IS PHYSICAL, NOT A TIER LOOKUP.
 * There is no size class deciding what may be eaten. Two questions decide
 * everything, and both are geometry:
 *
 *   1. Does the opening take ground out from under this object?
 *      ANY hole does this to ANY object it overlaps. A hole a quarter the size
 *      of a car still removes the ground under one wheel, and that wheel drops.
 *   2. Can the object pass through once it has tipped?
 *      Compared against `passRadius` — the smallest cross-section the object
 *      can present — NOT its footprint. A car is 4.4 m long and under 2 m
 *      wide; nose-first it goes through an opening far smaller than itself.
 *
 * An earlier version gated on a tier constant as well, which is what made a
 * 1 m bench refuse a hole three times its size. That gate is gone.
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

/** Peak inward acceleration at the lip, m/s^2. */
const SUCK_ACCEL = 30.0;

/** Below this much overlap the object is still solidly supported. */
const TILT_START_LOSS = 0.04;

/**
 * Gravity used for the topple. The object is treated as a rigid body pivoting
 * about the last edge of ground still under it, so the angular acceleration is
 * proportional to how far its centre of mass has swung past that edge — which
 * is why a topple starts almost imperceptibly and then goes over hard.
 */
const G_TORQUE = 15.0;

/** Angle past which a body that fits is committed and gravity simply takes it. */
const PASS_ANGLE = 0.95;   // ~54 degrees

/**
 * ANTI-LODGE.
 *
 * The disc model can put a body in a stalemate that the eye does not accept: a
 * wheel loader with a third of its ground gone sits dead still, because its
 * centre of mass is five centimetres inside the last supporting edge and the
 * torque comes out negative. The old code waited 1.6 s and then simply
 * captured it — the loader vanished from a standing start, which is the
 * "objects popping without falling in" failure in the rubric.
 *
 * Instead, a body that has been destabilised for longer than ANTILODGE_T
 * without resolving gets a steadily growing nudge added to its angular
 * acceleration. It always goes over under the normal gravity model, so the
 * player sees it fail. HARD_T is a backstop that should never be reached.
 */
const ANTILODGE_T = 0.85;
const ANTILODGE_GAIN = 2.6;
const HARD_T = 8.0;

/**
 * 0 for a traffic cone, 1 for a skyscraper. Mass proxy is footprint area times
 * height; the curve is logarithmic because the range spans a 0.7 m cone to a
 * 190 m tower — six orders of magnitude.
 */
function heaviness(c) {
  const mass = c.radius * c.radius * Math.max(0.4, c.height);
  return Math.min(1, Math.log10(1 + mass) / 5.2);
}

/**
 * How big the opening must be, relative to what it would need to SWALLOW this
 * body, before it can move it AT ALL.
 *
 * This is the rule that stops a small hole dragging a tower around. It is
 * expressed as hole-size-versus-object rather than as an absolute mass
 * threshold, because that is the thing a player can actually see: a hole half
 * the size of a bench tips the bench; a hole half the size of a tower is a
 * pothole in its car park.
 *
 *   light props   0.50  — a hole half of what it needs already unbalances them
 *   a bus         ~0.62
 *   a storefront  ~0.75
 *   a tower       0.85  — near enough to swallow it, or it does not budge
 */
function minMoveRatio(c) {
  return 0.5 + heaviness(c) * 0.35;
}

/**
 * Once the ratio gate above is satisfied, how much of its base must be gone
 * before it starts to go over. Deliberately LOW and nearly uniform: past the
 * gate, behaviour should be governed by the gravity model rather than by
 * another arbitrary cutoff. An earlier version scaled this with mass too, and
 * double-gating made cars barely react at all.
 */
function stabilityThreshold(c) {
  return TILT_START_LOSS + heaviness(c) * 0.06;
}

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
  // `crumbles` is a DEBRIS hint, not a structural class: props.js sets it on
  // anything made of stone, which includes a 0.9 m civic bench, a chess table,
  // a jersey barrier and a 1.4 m planter urn. Treating those as buildings gave
  // roughly a thousand small props the shudder-then-settle animation and — now
  // that a building's lateral motion is pinned at zero — stopped them sliding
  // at all. SINK is for things with the mass of a structure.
  if (c.tier.id >= 6 || (c.crumbles && (c.height >= 3.5 || c.radius >= 6))) return FALL.SINK;
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
    /** Monotonic tick counter. Only used to tell "moved this frame" apart from
     *  "moved some frame ago" without storing a timestamp per prop. */
    this._frame = 0;

    /* ---------------------------------------------------------------------
     * OPTIONAL EXTERNAL SUCTION (Vacuum Boost lives here, and nothing else).
     *
     * Both default to null, which is the whole point: with no hook installed
     * this file behaves EXACTLY as it did before, so a power-up module that
     * fails to load costs nothing. gameplay/powerupGlue.js is what fills them
     * in; gameplay/powerups.js supplies the pure functions behind them.
     *
     * Neither hook may consume, score or hide anything. They return NUMBERS.
     * The prop is then moved by this file's own integrator and swallowed by the
     * ordinary _touchObject -> _updateSupport -> _capture path, which is the
     * only path that calls hole.addScore. That is deliberate: a power-up that
     * awarded score directly, or hid a prop, or spawned a copy, produces the
     * two worst bugs in the review rubric.
     * ------------------------------------------------------------------- */

    /**
     * Multiplier on the per-hole SEARCH radius.
     * @type {?(hole:object)=>number}   returns 1 when nothing is boosting.
     *
     * Widening the search on its own changes NOTHING about what may be eaten —
     * every candidate still has to lose real ground in _touchObject. It only
     * produces candidates for the pull below.
     */
    this.reachHook = null;

    /**
     * Inward acceleration, m/s², for a candidate the support test did not take.
     * @type {?(hole:object, c:object, dist:number, baseR:number)=>number}
     */
    this.pullHook = null;

    /**
     * Per-hole cap on how many props one frame's pull may move. 0 = no cap.
     * Not a correctness guard (capture stays geometric) but a readability one:
     * two dozen props sliding at once is already more motion than the eye can
     * follow, and it bounds the per-frame rehash cost.
     */
    this.pullLimit = 0;

    /** Props currently being dragged by the pull hook but NOT yet destabilised. */
    this.pulled = new Set();

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
   * Can this object physically pass through this opening, once tipped?
   * Compared against passRadius (smallest presented cross-section), not the
   * footprint — that distinction is the whole point.
   */
  canPassThrough(hole, c) {
    return hole.radius >= c.passRadius * this.eatScale;
  }

  /**
   * Kept for callers that just want "will this ever go in". Eligibility is now
   * purely geometric; nothing consults a size class.
   */
  canEat(hole, c) {
    return this.canPassThrough(hole, c);
  }

  /* ---------------------------------------------------------------------
   * Introspection. The regression tools have to assert against the SAME
   * predicates the simulation runs on — a test that re-derives the rule from
   * the doc comment passes happily while the code does something else.
   * ------------------------------------------------------------------- */

  /** Smallest opening that can disturb `c` at all. Below this: zero motion. */
  moveThreshold(c) { return c.passRadius * minMoveRatio(c) * this.eatScale; }
  /** Smallest opening that can swallow `c`. */
  eatThreshold(c) { return c.passRadius * this.eatScale; }
  heaviness(c) { return heaviness(c); }
  stabilityThreshold(c) { return stabilityThreshold(c); }
  profileFor(c) { return c._profile ?? (c._profile = profileFor(c)); }
  overlapFraction(d, pr, hr) { return overlapFraction(d, pr, hr); }

  /**
   * How far a body may topple before it wedges against the far side of an
   * opening too small to swallow it. A hole that is nearly big enough lets it
   * go almost all the way over; a small one only lets a corner dip in.
   */
  restAngle(hole, c) {
    const need = Math.max(0.05, c.passRadius * this.eatScale);
    const ratio = hole.radius / need;
    if (ratio >= 1) return Math.PI;
    return Math.max(0.10, Math.min(1.25, ratio * ratio * 1.25));
  }

  /** @param {number} dt @param {import('./hole.js').Hole[]} holes @param {number} t */
  update(dt, holes, t) {
    this._now += dt;
    this._frame++;
    for (const hole of holes) {
      if (!hole.alive) continue;
      this._processHole(hole, dt, t);
    }
    // BEFORE _updateSupport: a prop the pull just handed over is already in
    // `attracted`, and the settle pass must see that and let go of it rather
    // than fight the topple integrator for the same transform.
    this._settlePulled(dt);
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
        tilt: 0,                  // current topple angle about the support edge
        tiltVel: 0,               // angular velocity, rad/s
        loss: 0,                  // unsupported fraction, 0..1
        pivotX: 0, pivotZ: 0,     // the last edge of ground still under it
        settled: false,           // wedged in an opening too small to pass
        nx: 0, nz: 1,             // unit direction toward the opening
        hole: null,
        stuck: 0,                 // seconds spent destabilised without resolving
        commit: 0,                // anti-lodge shove, 0..1
        pullFrame: -1,            // last tick an external suction hook moved it
      };
    }
    return d;
  }

  /**
   * Authored resting position of a prop, whatever backs it.
   *
   * For a mesh this is the FOOTPRINT CENTRE, which is not always the object's
   * own origin — see Consumable._poseOff.
   */
  _restPos(c, out) {
    if (c.backing === BACKING.INSTANCE && c.pool) return out.copy(c.pool.slotPos[c.slot]);
    if (c._restP) return out.copy(c._restP);
    return out.copy(c.position);
  }

  _processHole(hole, dt, t) {
    // Reach far enough to catch anything the opening overlaps at all, even a
    // building many times its size — that object still loses ground.
    const baseR = Math.max(hole.radius * HOLE.INFLUENCE_F, hole.radius + 14);
    // Vacuum Boost widens the SEARCH and nothing else. `|| 1` because a hook
    // that returns 0/NaN must degrade to the unboosted reach rather than
    // collapse the query to a point — this codebase fails silently, and a
    // query radius of zero would read as "the city stopped being edible".
    const R = this.reachHook ? baseR * (this.reachHook(hole) || 1) : baseR;
    const list = this.registry.query(hole.position.x, hole.position.z, R, this._query);

    if (!this.pullHook || !(R > baseR)) {
      // Untouched fast path: no suction installed, or none active on this hole.
      for (let i = 0; i < list.length; i++) this._touchObject(hole, list[i]);
    } else {
      let budget = this.pullLimit > 0 ? this.pullLimit : list.length;
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        this._touchObject(hole, c);
        // ONE integrator per prop, ever. `attracted` is the authority on who
        // owns a prop's transform: if _touchObject just claimed it — or if
        // another hole already had it — the support loop moves it and the pull
        // must keep its hands off, or the two damping terms compound and heavy
        // props crawl.
        if (budget > 0 && !this.attracted.has(c) && this._vacuumPull(hole, c, dt, baseR)) {
          budget--;
        }
      }
    }

    // Objects wider than the query reach are found by centre distance alone, so
    // a hole under the corner of a 33 m car park lands outside every cell the
    // query walked. There are ~160 of them; test them exactly.
    //
    // Deliberately NOT offered to the pull: everything on this list has a
    // footprint over 14 m, which is a tower, a pontoon or a superblock. They
    // are excluded by the hook's own size gate anyway, and a building does not
    // slide — see the contract in _updateSupport.
    const large = this.registry.large;
    for (let i = 0; i < large.length; i++) {
      const c = large[i];
      const dx = hole.position.x - c.position.x;
      const dz = hole.position.z - c.position.z;
      if (dx * dx + dz * dz <= R * R) continue;      // the query already had it
      this._touchObject(hole, c);
    }
  }

  /**
   * VACUUM BOOST'S ACTUAL PULL — a real acceleration on a real prop.
   *
   * The prop physically travels: velocity, drag, an offset from its authored
   * resting place, a rehash so the spatial index follows it, and a pose write.
   * Nothing here consumes it. It arrives at the opening still standing, loses
   * its ground in the ordinary _touchObject test, topples through
   * _updateSupport and is swallowed by _capture — the one function that calls
   * hole.addScore. No score is granted here, no prop is hidden here, and no
   * copy of anything is ever created.
   *
   * WHY IT SETS WOBBLE
   * The three external updaters that own a moving body's matrix — cars, boats
   * (world/vehicles.js) and pedestrians (world/pedestrians.js) — all yield the
   * transform the moment `state >= 1` and all take it back at IDLE. Without
   * that handshake the traffic updater would rewrite the car's matrix from its
   * lane every frame and the suction would show up as a jitter rather than as
   * motion. _settlePulled owns the trip back to IDLE.
   *
   * @returns {boolean} true if this prop was actually moved this frame
   */
  _vacuumPull(hole, c, dt, baseR) {
    if (!(dt > 0)) return false;
    if (c.state === STATE.FALLING || c.state === STATE.GONE) return false;
    // One suction per prop per tick. Two boosted holes reaching the same bench
    // would otherwise add their accelerations together and fire it across the
    // street, which is neither of their power-ups doing what it says.
    if (c._dyn && c._dyn.pullFrame === this._frame) return false;

    const dx = hole.position.x - c.position.x;
    const dz = hole.position.z - c.position.z;
    const d = Math.hypot(dx, dz);
    // Normalising a zero vector is how a prop that has slid to the exact centre
    // starts spinning on the spot.
    if (d < 1e-3) return false;

    const a = this.pullHook(hole, c, d, baseR);
    if (!(a > 0)) return false;

    // A BUILDING DOES NOT SLIDE. Not a little, not with heavy damping — the
    // same contract _updateSupport states in capitals. A suction that dragged a
    // storefront across its own plot would be a new way to break it.
    const profile = c._profile ?? (c._profile = profileFor(c));
    if (profile === FALL.SINK) return false;

    const dyn = this._dyn(c);
    const inv = 1 / d;
    dyn.vx += dx * inv * a * dt;
    dyn.vz += dz * inv * a * dt;
    // The SAME damping law the attracted loop uses for its own slide, so a prop
    // crossing from the suction into the support path does not visibly change
    // how it moves at the handover. powerups.pullDrag() mirrors this
    // expression; if one is ever retuned, retune both.
    const grip = Math.exp(-(3.2 + 6.0 / Math.max(1, c.radius * 2)) * dt);
    dyn.vx *= grip; dyn.vz *= grip;

    const stepX = dyn.vx * dt, stepZ = dyn.vz * dt;
    dyn.ox += stepX; dyn.oz += stepZ;
    if (profile === FALL.ROLL) {
      dyn.roll += Math.hypot(stepX, stepZ) / Math.max(0.25, c.height * 0.22);
    }

    this._restPos(c, _rest);
    c.position.x = _rest.x + dyn.ox;
    c.position.z = _rest.z + dyn.oz;
    // Without the rehash the spatial index keeps the prop in the cell it came
    // from, and the very query that is dragging it stops finding it.
    this.registry.rehash(c);
    // tilt is still 0 here, so this composes to "standing, translated" — the
    // prop slides in upright and only starts to go over when it loses ground.
    this._composePivotPose(c, dyn);
    this._writePose(c);

    if (c.state === STATE.IDLE) c.state = STATE.WOBBLE;
    dyn.pullFrame = this._frame;
    this.pulled.add(c);
    return true;
  }

  /**
   * Let go of props the suction is no longer holding.
   *
   * Three things have to happen or the pull leaves litter behind:
   *   1. the residual velocity has to be bled off — _updateSupport reads
   *      dyn.vx/vz, so a prop dropped by an expiring Vacuum Boost would
   *      otherwise get a free running start the next time a hole came near it;
   *   2. the prop has to be handed back to IDLE, or the traffic and crowd
   *      updaters keep it held forever and a car dies in a live lane;
   *   3. the set has to empty, or it grows for the whole match.
   *
   * It keeps whatever ground it covered. It slid there; that is where it is.
   */
  _settlePulled(dt) {
    if (this.pulled.size === 0) return;
    for (const c of this.pulled) {
      const dyn = c._dyn;
      // Still under suction this tick: _vacuumPull owns it.
      if (dyn && dyn.pullFrame === this._frame) continue;

      // Handed over, eaten, or reset. Whoever owns it now also owns its state.
      if (!dyn || c.state === STATE.FALLING || c.state === STATE.GONE ||
          this.attracted.has(c)) {
        this.pulled.delete(c);
        continue;
      }

      const grip = Math.exp(-(3.2 + 6.0 / Math.max(1, c.radius * 2)) * dt);
      dyn.vx *= grip; dyn.vz *= grip;
      const stepX = dyn.vx * dt, stepZ = dyn.vz * dt;
      dyn.ox += stepX; dyn.oz += stepZ;

      this._restPos(c, _rest);
      c.position.x = _rest.x + dyn.ox;
      c.position.z = _rest.z + dyn.oz;
      this.registry.rehash(c);
      this._composePivotPose(c, dyn);
      this._writePose(c);

      // Coasted to a stop: hand the body back. 5 cm/s is below the threshold at
      // which the eye reads motion at this camera distance.
      if (Math.hypot(dyn.vx, dyn.vz) < 0.05) {
        dyn.vx = 0; dyn.vz = 0;
        if (c.state === STATE.WOBBLE && !dyn.hole) c.state = STATE.IDLE;
        this.pulled.delete(c);
      }
    }
  }

  /** Does this opening take enough ground from under `c` to destabilise it? */
  _touchObject(hole, c) {
    if (c.state === STATE.FALLING || c.state === STATE.GONE) return;

    const dx = hole.position.x - c.position.x;
    const dz = hole.position.z - c.position.z;
    const d = Math.hypot(dx, dz);
    // An opening far too small for this body cannot move it, however much
    // ground it technically removes.
    if (hole.radius < this.moveThreshold(c)) return;

    const loss = overlapFraction(d, Math.max(0.12, c.radius), hole.radius);
    // Heavier bodies need more of their base gone before they react at all.
    if (loss < stabilityThreshold(c)) return;

    const dyn = this._dyn(c);
    // If two openings are under it, the one taking more of its footprint wins.
    if (dyn.hole && dyn.hole !== hole && dyn.loss > loss) return;
    dyn.hole = hole;
    dyn.loss = loss;
    if (d > 1e-3) {
      const inv = 1 / d;
      dyn.nx = dx * inv;
      dyn.nz = dz * inv;
    }
    // Otherwise keep the last direction: normalising a zero vector is how an
    // object that has slid to the exact centre starts spinning on the spot.

    c.state = STATE.WOBBLE;
    this.attracted.add(c);
  }

  /**
   * Integrate every object that currently has ground missing from under it.
   *
   * The model is a rigid body pivoting about the last edge of ground still
   * supporting it — which is the rim of the opening on the object's side, not
   * the object's own edge. Gravity acts at the centre of mass; the torque is
   * proportional to how far that mass has swung horizontally past the pivot.
   * So a wide object with a corner over the hole barely stirs, and the further
   * it goes the harder it goes, which is what "believable weight" means.
   */
  _updateSupport(dt, t) {
    if (this.attracted.size === 0) return;
    // Iterated in place. Copying the Set every frame allocated an array the
    // size of everything a late-game hole is touching — hundreds of entries,
    // sixty times a second, for nothing. Deleting during iteration is defined.
    for (const c of this.attracted) {
      if (c.state === STATE.FALLING || c.state === STATE.GONE) {
        this.attracted.delete(c);
        continue;
      }
      const dyn = c._dyn;
      const hole = dyn && dyn.hole;
      if (!hole || !hole.alive) { this._regainSupport(c, dt); continue; }

      // Re-measure: the opening may have moved on, or grown.
      const dx = hole.position.x - c.position.x;
      const dz = hole.position.z - c.position.z;
      const d = Math.hypot(dx, dz);
      const loss = overlapFraction(d, Math.max(0.12, c.radius), hole.radius);
      if (loss < stabilityThreshold(c) || hole.radius < this.moveThreshold(c)) {
        this._regainSupport(c, dt);
        continue;
      }

      dyn.loss = loss;
      if (d > 1e-3) {
        const inv = 1 / d;
        dyn.nx = dx * inv;
        dyn.nz = dz * inv;
      }

      const profile = c._profile ?? (c._profile = profileFor(c));

      /* ---- nothing left holding it up at all ----------------------------
       * The support disc is a bounding circle, so it keeps reporting partial
       * support for a body whose whole narrow cross-section is already inside
       * the opening — a wheel loader with all four wheels over the void, told
       * by the maths that 70% of it is still on tarmac. When the object cannot
       * be touching ground anywhere, it is falling, full stop.
       */
      if (d + this.eatThreshold(c) <= hole.radius) { this._capture(hole, c, t); continue; }

      /* ---- the pivot: the rim of the opening on the supported side ------ */
      // Ground still exists outside the hole, so the body hinges on the lip
      // between itself and that ground.
      dyn.pivotX = hole.position.x - dyn.nx * hole.radius;
      dyn.pivotZ = hole.position.z - dyn.nz * hole.radius;

      /* ---- gravity torque about that pivot ------------------------------ */
      // Horizontal distance from the pivot to the centre of mass, measured
      // along the direction of the opening. Positive means the mass is out
      // over the void.
      const comLever0 = (c.position.x - dyn.pivotX) * dyn.nx
                      + (c.position.z - dyn.pivotZ) * dyn.nz;
      const comH = Math.max(0.12, c.comHeight);
      const L = Math.max(0.35, Math.hypot(comLever0, comH));

      // Rotate the mass by the angle it has already turned through.
      const phi0 = Math.atan2(comH, comLever0);
      const phi = phi0 - dyn.tilt;
      const lever = Math.cos(phi) * L;      // horizontal arm, signed

      // Only the unsupported share of the body is actually cantilevered.
      // Share of the body actually hanging over nothing, measured from the
      // point at which THIS body starts to care.
      const thr = stabilityThreshold(c);
      const cantilever = Math.min(1, Math.max(0, (loss - thr) / Math.max(0.12, 0.55 - thr)));
      let alpha = (G_TORQUE * lever * cantilever) / (L * L);

      // Friction and the remaining contact resist the very start of a topple,
      // so a barely-overlapping object creaks rather than instantly rolling.
      alpha -= Math.sign(dyn.tiltVel || 1) * 0.9 * (1 - cantilever);

      /* ---- anti-lodge ---------------------------------------------------- */
      dyn.stuck += dt;
      const fits = this.canPassThrough(hole, c);
      if (fits && dyn.stuck > ANTILODGE_T) {
        // Grows from nothing, so the object leans, then goes — it is never
        // teleported out of a standing start.
        dyn.commit = Math.min(1, dyn.commit + (dyn.stuck - ANTILODGE_T) * dt);
        alpha += dyn.commit * ANTILODGE_GAIN;
      } else if (!fits) {
        dyn.commit = 0;
      }

      // Wheels give way easily; a building resists its own mass.
      const inertia = profile === FALL.ROLL ? 0.75
        : profile === FALL.LEAN ? 1.15
        : profile === FALL.SINK ? 2.6
        : 1.0;

      /* ---- can it actually go through? ---------------------------------- */
      if (!fits) {
        /*
         * TOO BIG TO SWALLOW — BUT NOT NECESSARILY UNMOVED.
         *
         * A body that cannot pass settles nose-down in the opening at the
         * angle the rim allows. Two things were wrong with letting the free
         * integrator do that against a hard clamp: it re-applied a bounce on
         * every frame it overshot, so a wedged prop shivered on the rim for
         * the rest of the match; and for anything heavy the constant friction
         * term swamped a torque that scales as 1/L, so a 126 m tower with an
         * opening 95% of the way to swallowing it stood perfectly upright and
         * gave the player nothing at all to read.
         *
         * So the wedge angle is solved as a damped spring toward the lean the
         * geometry justifies. It converges, it never oscillates, and the lean
         * grows visibly as the player's hole approaches the size it needs.
         */
        const rest = this.restAngle(hole, c);
        let lean = rest * cantilever * (1 - 0.75 * heaviness(c));
        // A leaning skyscraper sweeps its crown across a whole block, so a
        // structure only ever creaks. It goes over properly once it fits.
        if (profile === FALL.SINK) lean = Math.min(lean, 0.10);
        // Critically damped, so it approaches the lean and stops there instead
        // of ringing. Heavier bodies take longer to get there.
        const w = 5.0 / Math.sqrt(inertia);
        dyn.tiltVel += (-(dyn.tilt - lean) * w * w - 2 * w * dyn.tiltVel) * dt;
        dyn.tilt += dyn.tiltVel * dt;
        if (dyn.tilt < 0) { dyn.tilt = 0; dyn.tiltVel = Math.max(0, dyn.tiltVel); }
        if (dyn.tilt > rest) { dyn.tilt = rest; dyn.tiltVel = Math.min(0, dyn.tiltVel); }
        dyn.settled = Math.abs(dyn.tilt - lean) < 0.02;
      } else {
        dyn.tiltVel += (alpha / inertia) * dt;
        dyn.tiltVel *= Math.exp(-1.1 * dt);
        dyn.tilt += dyn.tiltVel * dt;
        if (dyn.tilt < 0) { dyn.tilt = 0; dyn.tiltVel = Math.max(0, dyn.tiltVel); }
        dyn.settled = false;
      }

      if (fits && (dyn.tilt >= PASS_ANGLE || loss > 0.92)) {
        // Past the balance point with room to pass: gravity owns it now.
        this._capture(hole, c, t);
        continue;
      } else if (fits && dyn.stuck > HARD_T) {
        // Backstop. Reaching this means the commit ramp above failed, which it
        // should not; capture rather than leave something trembling forever.
        this._capture(hole, c, t);
        continue;
      }

      /* ---- it also slides and rolls toward the opening -------------------
       * A BUILDING DOES NOT SLIDE. Not a little, not with heavy damping —
       * exactly zero, at every moment, by contract. It tilts and collapses
       * where it stands. The old exponential damping still let a tower drift
       * 30 m across its own plot before it went in.
       */
      if (profile === FALL.SINK) {
        dyn.vx = 0; dyn.vz = 0; dyn.ox = 0; dyn.oz = 0;
      } else {
        // Suction has nothing left to pull against once the body is over the
        // middle of the opening, and the pull direction there is meaningless.
        // Without this an object too wide to fit crept to the centre and sat
        // in the void, which is the "stuck across the opening" defect.
        const centred = Math.min(1, d / Math.max(0.35, hole.radius * 0.3));
        const slideDrive = cantilever * (0.25 + 0.75 * Math.min(1, dyn.tilt / 0.6));
        const accel = SUCK_ACCEL * 0.5 * slideDrive * centred;
        dyn.vx += dyn.nx * accel * dt;
        dyn.vz += dyn.nz * accel * dt;
        let damp = 3.2 + 6.0 / Math.max(1, c.radius * 2);
        if (profile === FALL.LEAN) damp += 2.4;      // a trunk is rooted
        if (!fits) damp += 6.0;                      // wedged: it grinds to a stop
        const grip = Math.exp(-damp * dt);
        dyn.vx *= grip; dyn.vz *= grip;

        const stepX = dyn.vx * dt, stepZ = dyn.vz * dt;
        dyn.ox += stepX; dyn.oz += stepZ;
        if (profile === FALL.ROLL) {
          dyn.roll += Math.hypot(stepX, stepZ) / Math.max(0.25, c.height * 0.22);
        }
      }

      this._restPos(c, _rest);
      c.position.x = _rest.x + dyn.ox;
      c.position.z = _rest.z + dyn.oz;
      this.registry.rehash(c);

      this._composePivotPose(c, dyn);
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
    dyn.tiltVel *= 0.6;
    dyn.settled = false;
    dyn.stuck = 0;
    dyn.commit = 0;
    dyn.vx *= 0.82; dyn.vz *= 0.82;
    dyn.loss = 0;

    this._restPos(c, _rest);
    c.position.x = _rest.x + dyn.ox;
    c.position.z = _rest.z + dyn.oz;
    this.registry.rehash(c);
    this._composePivotPose(c, dyn);
    this._writePose(c);

    if (Math.abs(dyn.ox) < 0.01 && Math.abs(dyn.oz) < 0.01 && Math.abs(dyn.tilt) < 0.01) {
      dyn.ox = dyn.oz = dyn.oy = dyn.tilt = dyn.tiltVel = 0;
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

  /**
   * Pose for a body that is toppling but has not yet let go.
   *
   * It rotates about the ground edge, not about its own centre — that is the
   * difference between a bench pivoting off a kerb and a bench spinning in
   * place. The whole body swings, so the far end lifts as the near end drops.
   */
  _composePivotPose(c, dyn) {
    const pose = this._pose(c);
    _axis.set(dyn.nz, 0, -dyn.nx).normalize();
    _q.setFromAxisAngle(_axis, dyn.tilt);

    this._restPos(c, _rest);
    // Where the body is standing right now, before rotation.
    _v.set(_rest.x + dyn.ox, this._restY(c), _rest.z + dyn.oz);
    _pivot.set(dyn.pivotX, this._restY(c), dyn.pivotZ);
    // Keep the hinge within the body's own footprint: a pivot further away
    // than the object is long would sling it across the street.
    _rel.copy(_v).sub(_pivot);
    const reach = Math.max(0.2, c.radius * 1.25);
    if (_rel.length() > reach) {
      _rel.setLength(reach);
      _pivot.copy(_v).sub(_rel);
    }
    _rel.applyQuaternion(_q);
    pose.pos.copy(_pivot).add(_rel);
    // Never let the topple push it up through the pavement.
    if (pose.pos.y > this._restY(c)) pose.pos.y = this._restY(c);

    if (c._profile === FALL.ROLL && dyn.roll !== 0) {
      _qRoll.setFromAxisAngle(_axis, dyn.roll);
      _q.multiply(_qRoll);
    }
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
   *
   * The pose is solved in PHYSICS space, whose origin is the footprint centre.
   * A mesh whose own origin sits elsewhere is shifted back by that offset on
   * the way out, so the geometry lands where the maths says the body is.
   */
  _writePose(c) {
    const pose = c._poseT;
    if (!pose) return;
    if (c.backing === BACKING.INSTANCE && c.pool && c.slot >= 0) {
      c.pool.setTransform(c.slot, pose.pos, pose.quat, pose.scale);
    } else if (c.object) {
      c.object.position.copy(pose.pos);
      if (c._poseOff) c.object.position.sub(c._poseOff);
      c.object.quaternion.copy(pose.quat);
      c.object.scale.copy(pose.scale);
    }
  }

  /** Put a prop back exactly as authored. */
  _resetPose(c) {
    if (c.backing === BACKING.INSTANCE && c.pool && c.slot >= 0) {
      c.pool.restore(c.slot);
    } else if (c.object && c._restObjP) {
      c.object.position.copy(c._restObjP);
      c.object.quaternion.copy(c._restQ);
      c.object.scale.copy(c._restS);
    }
  }

  /* ------------------------------------------------------------ capture --- */

  /**
   * Same animation for a prop a REMOTE player took: no score, no shake.
   *
   * `hole` may legitimately be missing — a client that is still on the menu,
   * or one whose holes are all dead, has nothing to attribute the swallow to,
   * and the whole plunge animation is built around a hole position. Dropping
   * the event is correct there: startMatch() rebuilds the city from scratch
   * anyway, so nothing carries over. Without this guard the CONSUMED broadcast
   * threw on every id and killed the frame loop.
   */
  captureRemote(hole, c, t) {
    if (!hole || !c || c.state === STATE.FALLING || c.state === STATE.GONE) return;
    this._capture(hole, c, t, true);
  }

  /** One-time allocation of the vectors the plunge animation writes into. */
  _fallScratch(c) {
    if (c._startPos) return;
    c._startPos = new THREE.Vector3();
    c._startQuat = new THREE.Quaternion();
    c._startScale = new THREE.Vector3(1, 1, 1);
    c._pivot = new THREE.Vector3();
    c._tipAxis = new THREE.Vector3(1, 0, 0);
    c._spinAxis = new THREE.Vector3(0, 1, 0);
    c._tipQuat = new THREE.Quaternion();
  }

  _capture(hole, c, t, remote = false) {
    this._fallScratch(c);
    this.registry.remove(c);
    this.attracted.delete(c);
    c.state = STATE.FALLING;
    c.fallT = 0;
    c.eatenBy = hole;

    const dyn = this._dyn(c);
    const profile = c._profile ?? (c._profile = profileFor(c));
    c._style = profile;

    // Start the fall from exactly where it currently stands, mid-topple.
    // Every vector below is pre-allocated on the Consumable: a big hole can
    // capture hundreds of props in a single frame, and this used to mint seven
    // objects for each of them.
    this._composePivotPose(c, dyn);
    const pose = this._pose(c);
    c._startPos.copy(pose.pos);
    c._startQuat.copy(pose.quat);
    c._startScale.copy(pose.scale);

    const dx = hole.position.x - c.position.x;
    const dz = hole.position.z - c.position.z;
    const dlen = Math.hypot(dx, dz) || 1;
    c._nx = dx / dlen;
    c._nz = dz / dlen;
    c._angle = Math.atan2(c.position.z - hole.position.z, c.position.x - hole.position.x);
    c._entryR = dlen;

    // It pivots about the contact edge it still has — the side away from the
    // opening — which is what a real object overbalancing off a ledge does.
    c._pivot.set(
      c._startPos.x + c._nx * c.radius * 0.9,
      c._startPos.y,
      c._startPos.z + c._nz * c.radius * 0.9
    );
    c._tipAxis.set(c._nz, 0, -c._nx).normalize();
    c._tipFrom = dyn.tilt;
    c._tipVel = dyn.tiltVel;
    // Never LESS than the lean it already has. A building could reach the
    // 54-degree commit angle while losing support and then be handed a 20
    // degree target, so the first thing it did on the way down was stand back
    // up — a swallow that visibly ran backwards.
    c._tipTarget = Math.max(dyn.tilt + 0.14,
      profile === FALL.LEAN ? Math.PI * (0.55 + Math.random() * 0.20)
      : profile === FALL.TOPPLE ? Math.PI * (0.48 + Math.random() * 0.18)
      : profile === FALL.ROLL ? Math.PI * (0.30 + Math.random() * 0.14)
      : profile === FALL.SINK ? Math.PI * (0.10 + Math.random() * 0.08)
      : Math.PI * (0.22 + Math.random() * 0.14));

    // Spin about a MOSTLY VERTICAL axis, and only a little. A random 3D axis
    // with a large rate reads as a chaotic tumble, not as something heavy
    // dropping down a shaft.
    c._spinAxis.set(
      (Math.random() - 0.5) * 0.35, 1, (Math.random() - 0.5) * 0.35
    ).normalize();
    // Total rotation over the whole plunge, radians. Heavier things turn less.
    c._spinTotal = (0.5 + Math.random() * 0.45) / (1 + c.radius * 0.10);
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
    c._hasTipQuat = false;

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
        // The hinge itself creeps toward the void as the lip crumbles under
        // the weight — but not for a building, which by contract has zero
        // lateral motion and simply drops through its own footprint.
        if (c._style !== FALL.SINK) {
          _pivot.x += c._nx * e * c.radius * 0.55;
          _pivot.z += c._nz * e * c.radius * 0.55;
        }
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
        c._tipQuat.copy(_q2);
        c._hasTipQuat = true;
        continue;
      }
      tt -= c._tTip;

      /* ---- 2. plunge ---------------------------------------------------- */
      const k = Math.min(1, tt / c._tPlunge);
      c._plungeVY -= G * dt;
      c._plungeY += c._plungeVY * dt;

      // Drift toward the centre, NOT an orbit. The old code swung through more
      // than a full revolution on the way down, which read as the object flying
      // around the rim. A fraction of a turn is enough to suggest a drain.
      // A building does neither: zero lateral motion, at every moment, so it
      // goes down through the ground it was standing on.
      const sink = c._style === FALL.SINK;
      const swirl = sink ? c._angle : c._angle - k * 0.45;
      const rr = sink ? c._entryR : c._entryR * (1 - k) * (1 - k) * (1 - k * 0.4);

      /**
       * How deep the shaft is allowed to be for THIS body.
       *
       * The pit is only `pitDepth` deep, and clamping the plunge to it created
       * a deadlock: removal wanted the body fully under the ground plane, but
       * a 12 m palm dropping into a 2 m hole could never get low enough to
       * satisfy that, so it stopped dead at the pit floor and waited for the
       * three-times-duration timer to delete it out of the air. Every tall
       * object in the game was doing that — a palm hung motionless for 2.8 s
       * and a tower for 9 s before blinking out. Below the ground plane nobody
       * can see the difference, so the shaft simply has to be deep enough that
       * the honest geometric test can fire.
       */
      const floor = c._startPos.y - Math.max(pitDepth * 1.1, c.height * 0.7 + 2);

      pose.pos.set(
        hole.position.x + Math.cos(swirl) * rr,
        Math.max(c._plungeY, floor),
        hole.position.z + Math.sin(swirl) * rr
      );

      // Eased, bounded rotation that settles rather than accelerating.
      _q2.setFromAxisAngle(c._spinAxis, c._spinTotal * (1 - (1 - k) * (1 - k)));
      if (c._hasTipQuat) _q2.multiply(c._tipQuat);
      pose.quat.copy(c._startQuat).premultiply(_q2);

      // Only once it is well inside the throat, and never while any of it is
      // still above the ground plane.
      const depth = (c._startPos.y - pose.pos.y) / Math.max(1, pitDepth);
      const shrink = Math.max(0.08, 1 - Math.max(0, depth - 0.35) * 0.95);
      pose.scale.copy(c._startScale).multiplyScalar(shrink);
      this._writePose(c);

      // Removed ONLY once the whole body is under the ground plane, measured
      // against what it is RIGHT NOW: the pose origin is the base, so the
      // highest point it can present at any rotation is height*scale above it,
      // and the plunge is already shrinking it. Using the authored height
      // instead is what produced the deadlock above.
      const topY = pose.pos.y + c.height * shrink;
      if (topY < -0.75) { this._finishFall(c, i); continue; }
      if (k >= 1) {
        // Safety net: force it down at a constant rate instead of vanishing.
        c._plungeVY = Math.min(c._plungeVY, -12);
        if (c.fallT > c._fallDur * 4) this._finishFall(c, i);
      }
    }
  }

  _finishFall(c, index) {
    if (c.backing === BACKING.INSTANCE && c.pool && c.slot >= 0) {
      c.pool.hide(c.slot);
    } else if (c.object) {
      // Kept, not disposed: it has to be able to come back.
      c.object.visible = false;
    }
    // Make it completely inert: out of the world, out of the physics, and
    // holding no state that could drive another frame of motion. It cannot be
    // seen, queried, hit or eaten again until the respawner brings it back.
    c.state = STATE.GONE;
    c.eatenBy = null;
    c._hasTipQuat = false;
    c._plungeVY = 0;
    if (c._dyn) {
      const d = c._dyn;
      d.ox = d.oy = d.oz = 0; d.vx = d.vz = 0;
      d.tilt = 0; d.tiltVel = 0; d.roll = 0; d.loss = 0;
      d.hole = null; d.settled = false; d.stuck = 0; d.commit = 0;
    }
    c.position.y = -9999;      // nothing can overlap it while it is away
    this.attracted.delete(c);
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
      dyn.roll = 0; dyn.tilt = 0; dyn.tiltVel = 0; dyn.loss = 0;
      dyn.hole = null; dyn.settled = false; dyn.stuck = 0; dyn.commit = 0;
    }
    c.state = STATE.IDLE;
    c.fallT = 0;
    c.eatenBy = null;
    c._hasTipQuat = false;
    // y was parked far below the world while it was gone, so restore it from
    // the authored resting place rather than carrying -9999 back up.
    c.position.set(at.x, this._restY(c), at.z);

    if (c.backing === BACKING.INSTANCE && c.pool && c.slot >= 0) {
      c.pool.restore(c.slot);
    } else if (c.object) {
      c.object.visible = true;
      if (c._restObjP) {
        c.object.position.copy(c._restObjP);
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


  /* -------------------------------------------------------------- reset --- */

  /**
   * Put the entire city back exactly as it was built.
   *
   * A restart cannot just make new holes: by the end of a round thousands of
   * objects are eaten, mid-fall, mid-topple or queued for respawn, and the
   * registry has no memory of any of them. This walks the master list from
   * worldBuild and restores every one — transform, physics state, visibility,
   * collision and registry membership — so the next match starts on a city
   * that is indistinguishable from a fresh load.
   *
   * @param {import('./entities.js').Consumable[]} all every consumable ever made
   * @returns {{restored:number, wasFalling:number, wasGone:number}}
   */
  resetAll(all) {
    const stats = { restored: 0, wasFalling: 0, wasGone: 0, wasTilted: 0 };

    // Drop every in-flight interaction first, so nothing writes a transform
    // after we have put it back.
    this.falling.length = 0;
    this.attracted.clear();
    // Props the suction hook was dragging are in-flight interactions too. The
    // loop below puts every one of them back at its authored spot, so leaving
    // them in this set would have _settlePulled writing a pose over a prop the
    // reset had already restored.
    this.pulled.clear();
    this.respawns.length = 0;
    this._now = 0;
    this.eatScale = 1.0;

    for (const c of all) {
      if (c.state === STATE.FALLING) stats.wasFalling++;
      else if (c.state === STATE.GONE) stats.wasGone++;
      else if (c._dyn && c._dyn.tilt > 0.001) stats.wasTilted++;

      // Physics state
      c.state = STATE.IDLE;
      c.fallT = 0;
      c.eatenBy = null;
      c._hasTipQuat = false;
      c._plungeVY = 0;
      c._plungeY = 0;
      c._style = undefined;
      if (c._dyn) {
        const d = c._dyn;
        d.ox = d.oy = d.oz = 0;
        d.vx = d.vz = 0;
        d.roll = 0; d.tilt = 0; d.tiltVel = 0; d.loss = 0;
        d.hole = null; d.settled = false; d.stuck = 0; d.commit = 0;
      }

      // Transform + visibility, back to exactly where it was authored.
      this._restPos(c, _rest);
      c.position.set(_rest.x, this._restY(c), _rest.z);
      if (c.backing === BACKING.INSTANCE && c.pool && c.slot >= 0) {
        c.pool.restore(c.slot);
      } else if (c.object) {
        c.object.visible = true;
        if (c._restObjP) {
          c.object.position.copy(c._restObjP);
          c.object.quaternion.copy(c._restQ);
          c.object.scale.copy(c._restS);
        }
      }

      // Back into the registry, so it is collidable and edible again. add()
      // would double-insert anything still registered, which would corrupt the
      // spatial hash and leave phantom collisions.
      if (!this.registry.byId.has(c.id)) this.registry.add(c);
      stats.restored++;
    }

    this.registry.initialCount = this.registry.aliveCount;
    return stats;
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
        /* TRUE radius, not the drawn one. Both are clamped to MAX_RADIUS in the
           late game, and comparing clamped values there says every large hole
           is the same size as every other — which is precisely when players
           notice they cannot eat someone visibly smaller. */
        if (a.trueRadius < b.trueRadius * HOLE.PVP_RATIO) continue;
        /* Respawn immunity. HOLE.RESPAWN_GRACE has existed since respawns did,
           and NOTHING checked it here — so a player who had just been eaten,
           halved and teleported could be eaten again the moment they landed,
           by anyone who followed them. The grace also protects the eater from
           farming a spawn. */
        if (b.spawnGrace > 0) continue;
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
