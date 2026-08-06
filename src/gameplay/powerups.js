/**
 * MIAMI DEVOUR — temporary power-up framework.
 *
 * WHAT THIS MODULE IS
 *   A data-driven table of temporary hole modifiers plus the machinery that
 *   spawns them in the world, hands them to a hole, ticks them down and cleans
 *   them up. It is deliberately three things at once and nothing more:
 *
 *     1. POWERUPS      — the balance table. Every tunable number lives here.
 *     2. PowerupSystem — pickup placement, collection, timers, authority sync.
 *     3. Pure readers  — queryRadiusMultiplier / pullAccel / speedMultiplier /
 *                        turnMultiplier / radiusMultiplier. These are side
 *                        -effect-free functions of (hole, elapsed time) that
 *                        other systems SAMPLE. They never write to a hole,
 *                        never award score, never move a prop themselves.
 *
 * WHY THE SPLIT IS THE WHOLE DESIGN
 *   The single most dangerous thing a power-up can do in this game is invent a
 *   second way for a prop to disappear. ConsumeSystem._capture is the only
 *   legitimate swallow: it removes the prop from the registry, starts the fall
 *   animation, and calls hole.addScore exactly once. A power-up that "helps" by
 *   granting points, hiding a mesh, or spawning a copy produces the two worst
 *   bugs in the rubric — score without a visible eat, and a duplicated scene
 *   object. So nothing in this file may mutate a Consumable. Vacuum Boost is
 *   expressed as two NUMBERS (a wider search radius and an acceleration) that
 *   ConsumeSystem applies through its own existing integrator, after which the
 *   normal geometry test captures the prop like any other. If this module were
 *   deleted mid-match every prop in the city would still be in a legal state.
 *
 * OWNERSHIP / INTEGRATION
 *   This module imports nothing from game.js. Its dependencies arrive through
 *   the constructor so it can be unit-tested headless (see __selftest at the
 *   bottom, which runs with no scene, no renderer and no audio context).
 *
 * @see CLAUDE_OVERNIGHT_POWERUPS_EVENTS_AUDIO.md section 1
 */

import * as THREE from 'three';
import { HOLE, WORLD, PALETTE } from '../config.js';
import { STATE } from './entities.js';
import { makeRNG } from '../core/rng.js';

/* ===========================================================================
 * STACK BEHAVIOUR
 *
 * Three modes, and the choice per power-up is a balance decision, not a
 * technicality:
 *
 *   REFRESH  collecting again restarts the clock at full duration. The effect
 *            never gets STRONGER, only longer-lived. Safe for anything that
 *            changes geometry or physics.
 *   EXTEND   adds the duration on top of what is left, capped. Rewards a player
 *            who chains pickups without ever doubling the magnitude.
 *   STACK    magnitude scales with the stack count, capped at maxStacks. Built
 *            and tested, but NOT used by any of the three shipped power-ups —
 *            multiplying a physics magnitude is exactly how a power-up becomes
 *            a map-clearing tool. It exists for the documented future ones
 *            (Score Multiplier is the honest candidate).
 * ========================================================================= */
export const STACK = {
  REFRESH: 'refresh',
  EXTEND: 'extend',
  STACK: 'stack',
};

/**
 * TUNNELLING CEILING FOR ANY SPEED MULTIPLIER.
 *
 * The hole integrates position with a plain Euler step (hole.js update:
 * `position.x += velocity.x * dt`) and nothing does a swept test. game.js
 * clamps the frame step at 1/20 s, so the furthest a hole can jump between two
 * overlap samples is speed * 0.05 metres.
 *
 * Speed vs size is BASE_SPEED * (r/r0)^0.375, i.e. it grows far slower than the
 * radius, so the worst ratio of "distance moved per frame" to "hole radius" is
 * at the START radius and only improves from there:
 *
 *     jump / radius  =  19.5 * 0.05 * m / 2.0  =  0.4875 * m
 *
 * A prop can only be skipped entirely when the hole leaps clean past it in one
 * frame, i.e. when that ratio reaches 1. So m = 2.05 is the hard mathematical
 * ceiling, and it assumes the pathological 20 fps frame. The shipped multiplier
 * is 1.35 (ratio 0.66) which keeps a 34% margin at the worst size and a much
 * larger one everywhere else. Anything above MAX_SAFE_SPEED_MULT is clamped on
 * the way out of speedMultiplier(), so a careless config edit cannot introduce
 * tunnelling.
 *
 * Turn responsiveness has no such limit: it scales HOLE.ACCEL, which only
 * changes how fast velocity converges on a target it can never exceed. It is
 * still capped for feel — an infinite ACCEL makes the hole read as teleporting.
 */
export const MAX_SAFE_SPEED_MULT = 1.6;
export const MAX_SAFE_TURN_MULT = 2.0;

/* ===========================================================================
 * THE TABLE
 *
 * Everything a designer would want to touch is in `cfg`. Nothing below this
 * table hardcodes a balance number; the code reads it out of the def.
 *
 * `color` is a THREE/effects hex NUMBER, `css` the same colour as a string for
 * the DOM HUD — they are kept as two fields rather than converted at call time
 * because the conversion was being done in three different places with two
 * different results. `icon` is a plain glyph so the HUD never depends on a
 * font that might not load, and it is always shown ALONGSIDE the name and the
 * seconds remaining: per the accessibility rule, colour is never the only
 * channel carrying the meaning of a power-up.
 * ========================================================================= */
export const POWERUPS = {
  /* ---------------------------------------------------------------- VACUUM */
  vacuum: {
    id: 'vacuum',
    name: 'VACUUM BOOST',
    icon: '◎',
    shape: 'ring',
    color: PALETTE.ACCENT_AQUA,       // 0x37e6d5
    css: '#37e6d5',
    description: 'Suction reaches past the rim. Loose props slide in.',
    duration: 30,                      // spec: 30 s, configurable
    spawnWeight: 1.0,
    stack: STACK.EXTEND,
    cfg: {
      /** Ceiling for EXTEND, as a multiple of `duration`. */
      maxDurationMult: 1.5,
      /** Envelope, seconds. Ramps stop the suction snapping on and off. */
      attack: 0.25,
      release: 0.80,
      /**
       * Multiplier on ConsumeSystem's search radius
       * R = max(r * HOLE.INFLUENCE_F, r + 14).
       *
       * WHY 1.6 AND NOT MORE: at the start radius R is 16 m, so this reaches
       * 25.6 m. City prop density is ~0.028/m², i.e. the widened query walks
       * ~58 candidates instead of ~22 — a cost the spatial hash absorbs. At
       * 2.5x it is 140 candidates per hole per frame with eight holes alive,
       * and it also starts hoovering a whole city block at once, which is the
       * "instant map clearing" the spec forbids.
       */
      reachMultiplier: 1.6,
      /**
       * Peak acceleration toward the hole, m/s², reached AT THE RIM.
       *
       * ConsumeSystem's own slide term peaks at SUCK_ACCEL * 0.5 = 15 m/s²,
       * and its drag is ~3.2 + 6/(2r) per second, so 22 m/s² gives a traffic
       * cone (r≈0.3, drag 13.2) a terminal slide of about 1.7 m/s and a car
       * (r≈1.7, drag 5.0) about 4.4 m/s at the rim only. That reads as "being
       * dragged in", not as "launched".
       */
      pullAccel: 22,
      /**
       * TIER GATE. A prop is eligible when its tier id is at most the hole's
       * current tier plus this. 1 == "your class plus one adjacent class",
       * which is the spec's wording. See _vacuumHeadroom for the one case
       * where it is reduced.
       */
      tierHeadroom: 1,
      /**
       * SIZE GATE, independent of tier because tier is a coarse label and
       * passRadius is the thing that actually decides whether a body fits.
       * A prop is only pulled if the hole is within 15% of being able to
       * swallow it — beyond that the player would be dragging furniture
       * around with no possible payoff.
       */
      sizeHeadroom: 1.15,
      /**
       * Per-hole cap on how many props the widened reach may pull in one
       * frame. Not a correctness guard (capture is still geometric) but a
       * performance and readability one: 24 props sliding at once is already
       * more motion than the eye can follow.
       */
      maxPulled: 24,
    },
  },

  /* ----------------------------------------------------------------- TURBO */
  turbo: {
    id: 'turbo',
    name: 'TURBO DRAIN',
    icon: '»',
    shape: 'cone',
    color: PALETTE.ACCENT_SUN,        // 0xffc93c
    css: '#ffc93c',
    description: 'Faster, and turns like it means it.',
    duration: 13,                      // spec: 12-15 s, configurable
    spawnWeight: 1.1,
    stack: STACK.REFRESH,
    cfg: {
      attack: 0.15,
      release: 0.50,
      /** See MAX_SAFE_SPEED_MULT for the derivation of the ceiling. */
      speed: 1.35,
      /** Scales HOLE.ACCEL (velocity convergence), never the top speed. */
      turn: 1.45,
      /** Trail emission rate, particles/second. 0 disables the trail. */
      trailRate: 26,
    },
  },

  /* ------------------------------------------------------------------ MASS */
  mass: {
    id: 'mass',
    name: 'MASS SURGE',
    icon: '◈',
    shape: 'octa',
    color: PALETTE.ACCENT_HOT,        // 0xff3d8b
    css: '#ff3d8b',
    description: 'Briefly wider. Score and growth are untouched.',
    duration: 12,                      // spec: 12 s, configurable
    spawnWeight: 0.85,
    stack: STACK.REFRESH,
    cfg: {
      /**
       * Attack is short so the growth reads as a surge; release is long
       * because the radius SHRINKING is the dangerous half. A prop that is
       * mid-topple over the rim when the opening contracts has to be handed
       * back to ConsumeSystem._regainSupport, which lerps it home at 6/s. A
       * 2.6 s release keeps the rim retreating slower than that recovery, so
       * props settle back onto the pavement instead of being left hanging in
       * a pose over ground that no longer has a hole in it.
       */
      attack: 0.30,
      release: 2.60,
      /** Peak radius multiplier. Spec says "for example 15%". */
      peak: 1.15,
      /**
       * How far past HOLE.MAX_RADIUS a surge may push. MAX_RADIUS is a
       * deliberate brake (camera distance is 44 + 5.6r), so the overshoot is
       * allowed but bounded — and it is temporary by construction.
       */
      maxOvershoot: 1.15,
    },
  },
};

/**
 * Stable HUD ordering. Iterating an object's keys happens to be insertion
 * ordered in every engine we ship on, but the HUD row order is a visible thing
 * and it should not depend on "happens to be".
 */
export const POWERUP_ORDER = ['vacuum', 'turbo', 'mass'];

/** String ids as constants, so a typo is a ReferenceError rather than silence. */
export const POWERUP_ID = { VACUUM: 'vacuum', TURBO: 'turbo', MASS: 'mass' };

/* ===========================================================================
 * NOT BUILT — the four optional future power-ups, per the spec's
 * "document only; do not build until asked".
 *
 *   SHIELD      Absorbs one devour attempt from a bigger hole. Would hook the
 *               PvP resolution in ConsumeSystem._resolvePvP, which is the only
 *               place a hole is eaten, and would have to be authoritative
 *               server-side or it is trivially faked by a client.
 *   MAGNET      Attracts scattered small metal/street props. Mechanically this
 *               is Vacuum Boost with a kind/material filter instead of a tier
 *               gate; it should reuse pullAccel rather than grow a second
 *               attraction path, or the two will drift apart.
 *   MULTIPLIER  Bonus points from eligible props for a short time. The ONLY
 *               correct seam is ConsumeSystem._capture, where hole.addScore is
 *               called with c.score — a multiplier applied anywhere else
 *               desynchronises score from the radius curve.
 *   RADAR       Reveals nearby pickups and high-value targets on the minimap.
 *               Purely a HUD read; needs no gameplay authority at all, which
 *               makes it the cheapest of the four.
 *
 * None of the above are implemented. The table above is the shipped set.
 * ========================================================================= */

/* ===========================================================================
 * SPAWN / WORLD CONFIG
 * ========================================================================= */
export const PICKUP_CFG = {
  /** How many pickups exist in the world at once. */
  maxLive: 5,
  /** How many of any single kind may be live at once. */
  perKindMax: 2,
  /** Minimum metres between two live pickups. The map's land span is ~850 m. */
  minSeparation: 140,
  /** Seconds a collected pickup stays gone before it comes back ELSEWHERE. */
  respawnDelay: 22,
  /**
   * ANTI-CAMPING. A collected pickup must reappear at least this far from
   * where it was taken. Without it a player parks on the respawn point and
   * farms a 30 s power-up every 22 s for the whole match, which is the exact
   * failure the spec calls out.
   */
  minRespawnMove: 120,
  /** Attempts to find a placement that satisfies validate + separation. */
  placeTries: 80,
  /** Attempts to find a placement that is ALSO off the road network. */
  offRoadTries: 40,
  /** Contact radius added to the hole's own reach. */
  pickRadius: 3.2,
  /**
   * The hole's own radius counts toward collection, but only up to here. A
   * 34 m late-game hole would otherwise sweep pickups off a whole block
   * without aiming at them.
   */
  maxHoleReach: 10,
  /** Visual: hover height, bob amplitude, bob and spin rates. */
  hoverY: 1.7,
  bobAmp: 0.32,
  bobRate: 2.1,
  spinRate: 1.35,
  /**
   * Spec 7: "a player cannot keep a power-up after death/teleport unless that
   * is an explicitly configured rule". This is that rule, and it defaults off.
   */
  keepOnDeath: false,
  /** Minimap reveal distance. The HUD decides what to do with it. */
  minimapRange: 180,
};

/* ---------------------------------------------------------------- helpers - */

/** Smoothstep with zero slope at both ends — no visible pop at the edges. */
function smoothstep(u) {
  const x = u < 0 ? 0 : u > 1 ? 1 : u;
  return x * x * (3 - 2 * x);
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/**
 * Accept either a full core/rng.js generator or a bare `() => float`.
 *
 * The bare case is what a test or a debug console hands over (Math.random),
 * and reaching for `.range` on it is a TypeError three call levels down inside
 * a placement loop — the kind of failure that reads as "no pickups spawned"
 * rather than as a crash. Fill in the two helpers this module uses and leave a
 * real RNG untouched.
 */
function normaliseRng(rng) {
  if (typeof rng !== 'function') return makeRNG(0x9e3779b1);
  if (typeof rng.range !== 'function') rng.range = (lo, hi) => lo + rng() * (hi - lo);
  if (typeof rng.weighted !== 'function') {
    rng.weighted = (entries) => {
      let total = 0;
      for (const e of entries) total += e[1];
      let r = rng() * total;
      for (const e of entries) { r -= e[1]; if (r <= 0) return e[0]; }
      return entries[entries.length - 1][0];
    };
  }
  return rng;
}

/* ===========================================================================
 * RECOMMENDED CONSUME WIRING  (read this before integrating Vacuum Boost)
 *
 * ConsumeSystem._processHole currently does:
 *
 *     const R = Math.max(hole.radius * HOLE.INFLUENCE_F, hole.radius + 14);
 *     const list = this.registry.query(hole.position.x, hole.position.z, R, buf);
 *     for (...) this._touchObject(hole, list[i]);
 *
 * The correct integration is TWO changes, both additive:
 *
 *   1. Widen the query only:
 *        const baseR = Math.max(hole.radius * HOLE.INFLUENCE_F, hole.radius + 14);
 *        const R = baseR * (powerups ? powerups.queryRadiusMultiplier(hole) : 1);
 *
 *      Widening R ON ITS OWN changes NOTHING about what gets eaten — a prop
 *      still has to fail its own stability test in _touchObject, which needs
 *      real overlap with the opening. That is the point: the wider query only
 *      produces candidates.
 *
 *   2. For each candidate that _touchObject did NOT accept (i.e. the prop is
 *      outside the opening, so it has lost no ground), apply a real pull:
 *
 *        const a = powerups.pullAccel(hole, c, d, baseR);
 *        if (a > 0) {
 *          const dyn = this._dyn(c);
 *          dyn.vx += (dx / d) * a * dt;
 *          dyn.vz += (dz / d) * a * dt;
 *          const grip = Math.exp(-powerups.pullDrag(c) * dt);
 *          dyn.vx *= grip; dyn.vz *= grip;
 *          dyn.ox += dyn.vx * dt; dyn.oz += dyn.vz * dt;
 *          this._restPos(c, scratch);
 *          c.position.x = scratch.x + dyn.ox;
 *          c.position.z = scratch.z + dyn.oz;
 *          this.registry.rehash(c);      // or the hash keeps the old cell
 *          this._writePose(c);
 *        }
 *
 *      The prop physically travels. Once it reaches the opening the ordinary
 *      _touchObject -> _updateSupport -> _capture path takes over unchanged,
 *      which means the tilt, the fall animation, the score and the kill-feed
 *      are all produced by the code that already produces them. No prop is
 *      duplicated because none is created; no score is granted here because
 *      addScore is only ever called by _capture.
 *
 *      Do NOT apply pullDrag if the prop is already in `attracted` — that loop
 *      applies its own `grip` and damping it twice makes heavy props crawl.
 * ========================================================================= */

/* ===========================================================================
 * PowerupSystem
 * ========================================================================= */
export class PowerupSystem {
  /**
   * @param {object} deps
   * @param {Function}  [deps.rng]      seeded RNG from core/rng.js. Determinism
   *                                    matters: two clients must place pickups
   *                                    identically before the server corrects
   *                                    them.
   * @param {object}    [deps.layout]   cityLayout — .isWater(x,z) .isRoad(x,z)
   * @param {object}    [deps.effects]  render/effects.js instance
   * @param {object}    [deps.registry] EntityRegistry (unused today; accepted
   *                                    so a future Magnet can query props)
   * @param {object}    [deps.audio]    core/audio.js singleton
   * @param {THREE.Scene} [deps.scene]  omit for headless: no meshes are built
   * @param {object}    [deps.config]   partial override of PICKUP_CFG
   */
  constructor(deps = {}) {
    this.rng = normaliseRng(deps.rng);
    this.layout = deps.layout || null;
    this.fx = deps.effects || null;
    this.registry = deps.registry || null;
    this.audio = deps.audio || null;
    this.scene = deps.scene || null;
    this.cfg = Object.assign({}, PICKUP_CFG, deps.config || {});

    /** Live pickups in the world. Small array; iterated every frame. */
    this.pickups = [];
    /** Collected pickups waiting to come back: {id, at, fromX, fromZ}. */
    this._pending = [];
    /**
     * Per-hole effect state. Keyed by the HOLE OBJECT, not by hole.id: ids are
     * reused across matches and a stale entry that survived a restart would
     * silently hand a fresh player somebody else's Vacuum Boost.
     * @type {Map<object, Map<string, {id:string, elapsed:number, duration:number, stacks:number}>>}
     */
    this._byHole = new Map();

    /** Internal clock, driven by dt only. Never reads wall time — a paused or
     *  stalled tab must not burn power-up seconds. */
    this.clock = 0;

    /** Retained by spawnInto so respawns can validate the new point too. */
    this._validate = null;

    /* Callbacks — the orchestrator wires HUD and audio through these rather
       than this module reaching into either. */
    this.onPickup = null;    // (hole, def, state) => void
    this.onExpire = null;    // (hole, def) => void
    this.onSpawn = null;     // (pickup) => void
    this.onDespawn = null;   // (pickup, reason) => void

    /* Shared GPU resources, built lazily and only when a scene exists. */
    this._geo = null;
    this._mats = null;
    this._freeVisuals = [];
    this._scratch = new THREE.Vector3();
  }

  /* ------------------------------------------------------------- lifecycle */

  /**
   * Seed the world with pickups.
   *
   * @param {(x:number,z:number)=>{ok:boolean}} validate the GAME's real spawn
   *        validator (game._validateSpawn). It already rejects water, the bay,
   *        out-of-bounds, points inside an object, points outside an active
   *        shrink ring, and points with nothing edible nearby — which is the
   *        whole "no unreachable pickups" requirement, sourced from the one
   *        function that is kept correct because players spawn through it too.
   * @param {number} [count] how many to place (clamped by cfg.maxLive)
   * @returns {number} how many were actually placed
   */
  spawnInto(validate, count = this.cfg.maxLive) {
    if (typeof validate !== 'function') {
      console.warn('[powerups] spawnInto needs the game spawn validator; nothing placed');
      return 0;
    }
    this._validate = validate;
    const want = Math.min(count, this.cfg.maxLive) - this.pickups.length;
    let made = 0;
    for (let i = 0; i < want; i++) {
      if (this._spawnOne(this._pickKind())) made++;
    }
    return made;
  }

  /**
   * @param {number} dt   seconds, already clamped by the caller
   * @param {Array}  holes every hole in the match, alive or not
   * @param {number} [t]  world clock, used only for visual phase
   */
  update(dt, holes, t = this.clock) {
    if (!(dt > 0)) dt = 0;
    this.clock += dt;

    this._tickEffects(dt, holes);
    this._tickPickups(dt, t);
    this._tickCollection(holes);
    this._tickRespawns();
  }

  /**
   * Give `hole` the power-up carried by `pickup`, and take the pickup out of
   * the world. Safe to call directly (tests, debug console, a server telling a
   * client what happened) — collection in update() funnels through here.
   *
   * @returns {object|null} the effect state, or null if it was refused
   */
  collect(hole, pickup) {
    if (!hole || !pickup || !pickup.alive) return null;
    const def = POWERUPS[pickup.id];
    if (!def) return null;

    this._retire(pickup, 'collected', hole);
    const st = this.grant(hole, def.id);
    if (!st) return null;

    this._pickupFx(hole, pickup, def);
    if (this.onPickup) this.onPickup(hole, def, st);
    return st;
  }

  /**
   * Start (or re-start, per the def's stack rule) an effect on a hole without
   * a pickup. This is the seam a server uses to force state onto a client and
   * the seam an event/reward system would use.
   */
  grant(hole, id, durationOverride = 0) {
    const def = POWERUPS[id];
    if (!hole || !def) return null;
    let m = this._byHole.get(hole);
    if (!m) { m = new Map(); this._byHole.set(hole, m); }

    const base = durationOverride > 0 ? durationOverride : def.duration;
    let st = m.get(id);
    if (!st) {
      st = { id, elapsed: 0, duration: base, stacks: 1 };
      m.set(id, st);
      return st;
    }

    switch (def.stack) {
      case STACK.EXTEND: {
        // Time left plus a fresh duration, capped. Rolling `elapsed` back to 0
        // and lengthening `duration` keeps the envelope's attack from firing a
        // second time, which would make the effect visibly stutter.
        const left = Math.max(0, st.duration - st.elapsed);
        const cap = base * (def.cfg.maxDurationMult ?? 1.5);
        st.duration = Math.min(cap, left + base);
        st.elapsed = 0;
        st.stacks = Math.min(st.stacks + 1, def.cfg.maxStacks ?? 99);
        break;
      }
      case STACK.STACK: {
        st.duration = base;
        st.elapsed = 0;
        st.stacks = Math.min(st.stacks + 1, def.cfg.maxStacks ?? 2);
        break;
      }
      case STACK.REFRESH:
      default: {
        // Full reset, magnitude unchanged. For Mass Surge this deliberately
        // restarts the attack ramp: the radius is already at peak, so the
        // ramp is a no-op upward and the release simply moves further away.
        st.duration = base;
        st.elapsed = 0;
        break;
      }
    }
    return st;
  }

  /** Cancel one effect early (police "weaken Vacuum Boost", debug, authority). */
  revoke(hole, id, silent = false) {
    const m = this._byHole.get(hole);
    if (!m || !m.has(id)) return false;
    m.delete(id);
    if (m.size === 0) this._byHole.delete(hole);
    if (!silent) this._expireFx(hole, POWERUPS[id]);
    return true;
  }

  isActive(hole, id) {
    const m = this._byHole.get(hole);
    return !!(m && m.has(id));
  }

  /** Seconds left, 0 when inactive. */
  remaining(hole, id) {
    const m = this._byHole.get(hole);
    const st = m && m.get(id);
    if (!st) return 0;
    return Math.max(0, st.duration - st.elapsed);
  }

  /**
   * HUD view-model, always in POWERUP_ORDER so rows never swap places under
   * the player's cursor.
   * @returns {{id,name,icon,color,css,description,remaining,duration,frac,stacks}[]}
   */
  activeFor(hole) {
    const out = [];
    const m = this._byHole.get(hole);
    if (!m) return out;
    for (const id of POWERUP_ORDER) {
      const st = m.get(id);
      if (!st) continue;
      const def = POWERUPS[id];
      const left = Math.max(0, st.duration - st.elapsed);
      out.push({
        id, name: def.name, icon: def.icon, color: def.color, css: def.css,
        description: def.description,
        remaining: left, duration: st.duration,
        frac: st.duration > 0 ? left / st.duration : 0,
        stacks: st.stacks,
      });
    }
    return out;
  }

  /**
   * Tear everything down: match end, restart, mode change.
   *
   * "No residue" means all four of these, and the reason each one is listed
   * separately is that an earlier version of this cleanup only did the first
   * and left holes carrying a Vacuum Boost into the next round.
   */
  clearAll() {
    for (const p of this.pickups.slice()) this._retire(p, 'cleared', null);
    this.pickups.length = 0;
    this._pending.length = 0;
    this._byHole.clear();
    this.clock = 0;
    this._validate = null;
  }

  /** clearAll plus the GPU resources. Only for tearing the game down. */
  dispose() {
    this.clearAll();
    for (const v of this._freeVisuals) {
      if (v.group.parent) v.group.parent.remove(v.group);
    }
    this._freeVisuals.length = 0;
    if (this._geo) {
      for (const g of Object.values(this._geo)) g.dispose();
      this._geo = null;
    }
    if (this._mats) {
      for (const m of Object.values(this._mats)) m.dispose();
      this._mats = null;
    }
  }

  /** Diagnostic used by the self-test and by the debug overlay. */
  residue() {
    let effects = 0;
    for (const m of this._byHole.values()) effects += m.size;
    return {
      pickups: this.pickups.length,
      pending: this._pending.length,
      holes: this._byHole.size,
      effects,
      pooledVisuals: this._freeVisuals.length,
    };
  }

  /* ------------------------------------------------------- net authority - */

  /**
   * Compact, JSON-safe snapshot of ONE hole's power-up state.
   *
   * Format: [[orderIndex, elapsed, duration, stacks], ...]
   * Indices rather than string ids because this rides in a 15 Hz snapshot and
   * POWERUP_ORDER is the stable index space the HUD already uses.
   * `elapsed` is sent (not just `remaining`) because the Mass Surge envelope is
   * a function of elapsed AND duration — a client given only the remainder
   * would replay the attack ramp on every snapshot.
   */
  serialize(hole) {
    const m = this._byHole.get(hole);
    if (!m || m.size === 0) return [];
    const out = [];
    for (let i = 0; i < POWERUP_ORDER.length; i++) {
      const st = m.get(POWERUP_ORDER[i]);
      if (!st) continue;
      out.push([i, +st.elapsed.toFixed(3), +st.duration.toFixed(3), st.stacks]);
    }
    return out;
  }

  /**
   * Replace a hole's entire power-up state with the authority's version.
   *
   * REPLACE, not merge. If the server does not list an effect, the client does
   * not have it — that is what makes the state unfakeable. A merge would let a
   * tampered client keep a boost forever simply by never being told to stop.
   * Silent by design: no pickup banner, no expiry chime, because the local
   * client already played those or was never entitled to them.
   */
  applyState(hole, state) {
    if (!hole) return;
    if (!Array.isArray(state) || state.length === 0) {
      this._byHole.delete(hole);
      return;
    }
    const m = new Map();
    for (const row of state) {
      if (!Array.isArray(row)) continue;
      const id = POWERUP_ORDER[row[0] | 0];
      const def = id && POWERUPS[id];
      if (!def) continue;                       // unknown index: newer server
      const duration = Number(row[2]) > 0 ? Number(row[2]) : def.duration;
      const elapsed = clamp(Number(row[1]) || 0, 0, duration);
      m.set(id, { id, elapsed, duration, stacks: Math.max(1, row[3] | 0) });
    }
    if (m.size === 0) this._byHole.delete(hole);
    else this._byHole.set(hole, m);
  }

  /* =======================================================================
   * PURE READERS
   *
   * Every one of these is a function of hole state and time. They allocate
   * nothing, mutate nothing, and return the identity value when the relevant
   * power-up is not running. Callers may sample them every frame for every
   * hole without thinking about it.
   * ===================================================================== */

  /** 0..1 envelope for one active effect. Returns 0 when it is not running. */
  _env(hole, id) {
    const m = this._byHole.get(hole);
    const st = m && m.get(id);
    if (!st) return 0;
    const def = POWERUPS[id];
    const d = st.duration;
    const e = st.elapsed;
    if (!(d > 0) || e >= d) return 0;
    const a = def.cfg.attack || 0;
    const r = def.cfg.release || 0;
    // A duration shorter than attack+release must taper, not spike: shrink both
    // ramps proportionally so the envelope still reaches its peak exactly once.
    const k = Math.min(1, d / Math.max(1e-4, a + r));
    const up = a > 0 ? e / (a * k) : 1;
    const dn = r > 0 ? (d - e) / (r * k) : 1;
    return smoothstep(Math.min(up, dn));
  }

  /**
   * VACUUM BOOST — multiplier on ConsumeSystem's search radius.
   * Exactly 1.0 when inactive, and it eases back to exactly 1.0 as the effect
   * releases so props are never abandoned mid-slide by a step change in reach.
   */
  queryRadiusMultiplier(hole) {
    const env = this._env(hole, POWERUP_ID.VACUUM);
    if (env <= 0) return 1;
    return 1 + (POWERUPS.vacuum.cfg.reachMultiplier - 1) * env;
  }

  /**
   * The reach Vacuum Boost is currently working over, in metres. Mirrors
   * ConsumeSystem._processHole's own formula, which is why `baseR` can be
   * passed in: the caller that already computed it should hand it over rather
   * than let two copies of the expression drift apart.
   */
  vacuumReach(hole, baseR) {
    const R = baseR != null
      ? baseR
      : Math.max(hole.radius * HOLE.INFLUENCE_F, hole.radius + 14);
    return R * this.queryRadiusMultiplier(hole);
  }

  /**
   * Tier ceiling the vacuum may reach to, as a tier id.
   *
   * The subtraction is the non-obvious part. hole.tier is recomputed from
   * hole.radius every frame in Hole.update, so a Mass Surge that pushes the
   * radius over a TIER_LIST threshold ALSO lifts hole.tier for its duration.
   * Left alone, running both power-ups would quietly hand the player two extra
   * classes instead of the one the spec allows, and it would do it invisibly.
   * So while a surge is up, the vacuum's own headroom is spent.
   */
  _vacuumHeadroom(hole) {
    const h = POWERUPS.vacuum.cfg.tierHeadroom;
    return this.isActive(hole, POWERUP_ID.MASS) ? Math.max(0, h - 1) : h;
  }

  /** Is this prop something Vacuum Boost is allowed to touch at all? */
  vacuumEligible(hole, c) {
    if (!c || c.state === STATE.GONE || c.state === STATE.FALLING) return false;
    const cfg = POWERUPS.vacuum.cfg;
    const tid = c.tier ? c.tier.id : 0;
    if (tid > hole.tier + this._vacuumHeadroom(hole)) return false;
    // The real gate. passRadius is the narrow way through, i.e. the number
    // canPassThrough uses, so this says "only pull what you are within 15% of
    // being able to actually swallow".
    if (c.passRadius > hole.radius * cfg.sizeHeadroom) return false;
    return true;
  }

  /**
   * VACUUM BOOST — acceleration toward the hole centre, m/s².
   *
   * Strongest at the rim, smoothstepped to exactly zero at the reach edge so
   * there is no discontinuity for a prop drifting in or out of range. Returns
   * 0 whenever the boost is off or the prop is not eligible.
   *
   * PURE. It does not touch `c`. The caller integrates it (see the wiring
   * block above), which is what makes the prop physically travel and be
   * captured by the ordinary path.
   *
   * @param {object} hole
   * @param {object} c     Consumable
   * @param {number} dist  centre-to-centre horizontal distance, metres
   * @param {number} [baseR] the un-multiplied search radius, if already known
   */
  pullAccel(hole, c, dist, baseR) {
    const env = this._env(hole, POWERUP_ID.VACUUM);
    if (env <= 0) return 0;
    if (!this.vacuumEligible(hole, c)) return 0;

    const cfg = POWERUPS.vacuum.cfg;
    const rim = Math.max(0.5, hole.radius);
    const reach = this.vacuumReach(hole, baseR);
    if (!(reach > rim) || dist >= reach) return 0;

    // Inside the rim the ordinary support/capture maths owns the prop, and
    // adding suction there just fights the topple integrator. Clamp instead of
    // returning 0 so a prop straddling the lip gets the peak value, not a hole
    // in the force field.
    const d = Math.max(dist, rim);
    const u = 1 - (d - rim) / (reach - rim);          // 1 at the rim, 0 at reach
    const fall = smoothstep(u);

    // Light things fly, heavy things are dragged. Uses passRadius against the
    // same gate the eligibility test uses, so the force tapers to its floor
    // exactly where the gate closes rather than dropping off a cliff.
    const rel = Math.min(1, c.passRadius / Math.max(0.05, rim * cfg.sizeHeadroom));
    const sizeEase = 0.35 + 0.65 * (1 - rel);

    return cfg.pullAccel * env * fall * sizeEase;
  }

  /**
   * Drag coefficient to pair with pullAccel, per second.
   *
   * Mirrors ConsumeSystem's own slide damping (3.2 + 6/(2r)) on purpose: a
   * prop that starts outside the opening under vacuum and then crosses into
   * the normal attracted path must not visibly change how it moves at the
   * handover. Do not apply this to a prop the attracted loop is already
   * damping — see the wiring note.
   */
  pullDrag(c) {
    return 3.2 + 6.0 / Math.max(1, c.radius * 2);
  }

  /**
   * TURBO DRAIN — movement speed multiplier. Exactly 1.0 when inactive.
   * Hard-clamped at MAX_SAFE_SPEED_MULT; see that constant for the tunnelling
   * derivation. Intended use: `hole.speed * powerups.speedMultiplier(hole)`.
   */
  speedMultiplier(hole) {
    const env = this._env(hole, POWERUP_ID.TURBO);
    if (env <= 0) return 1;
    const target = Math.min(POWERUPS.turbo.cfg.speed, MAX_SAFE_SPEED_MULT);
    return 1 + (target - 1) * env;
  }

  /**
   * TURBO DRAIN — turn responsiveness. Scales HOLE.ACCEL, the rate at which
   * velocity converges on the desired direction. Cannot cause tunnelling
   * because it cannot raise the top speed, only how quickly it is reached.
   * Intended use: `const k = 1 - Math.exp(-HOLE.ACCEL * turnMultiplier * dt)`.
   */
  turnMultiplier(hole) {
    const env = this._env(hole, POWERUP_ID.TURBO);
    if (env <= 0) return 1;
    const target = Math.min(POWERUPS.turbo.cfg.turn, MAX_SAFE_TURN_MULT);
    return 1 + (target - 1) * env;
  }

  /**
   * MASS SURGE — temporary radius multiplier. Exactly 1.0 when inactive.
   *
   * HOW THE TEMPORARY SIZE IS KEPT OUT OF THE PERMANENT SCORE->RADIUS SYSTEM
   * ----------------------------------------------------------------------
   * The canonical relationship is radius = Hole.radiusFor(score), and it is
   * re-derived from score inside addScore() and reset(). This module:
   *
   *   - never writes hole.radius, hole.score, or calls hole.addScore;
   *   - returns a multiplier that is a pure function of elapsed time.
   *
   * The integration contract is that the game, once per frame and AFTER
   * hole.update() and any addScore() calls, does:
   *
   *     hole.radius = powerups.scaleRadius(hole, Hole.radiusFor(hole.score));
   *
   * Because the BASE is recomputed from score every single frame, the surge
   * cannot compound: two surges multiply the same canonical base, not each
   * other, and an eat during a surge grows the base by exactly the amount the
   * curve says. When the surge ends the multiplier is exactly 1 and
   * scaleRadius short-circuits to return the base unchanged, so the identity
   * hole.radius === Hole.radiusFor(hole.score) is restored bit-for-bit with no
   * floating-point residue.
   *
   * What the surge DOES buy is reach: canPassThrough compares hole.radius to
   * c.passRadius, so for 12 seconds the player can swallow things up to 15%
   * bigger. Those props pay their ordinary score through _capture. The surge
   * changes what you can reach, never what it is worth.
   */
  radiusMultiplier(hole) {
    const env = this._env(hole, POWERUP_ID.MASS);
    if (env <= 0) return 1;
    return 1 + (POWERUPS.mass.cfg.peak - 1) * env;
  }

  /** Apply radiusMultiplier with the MAX_RADIUS overshoot cap. */
  scaleRadius(hole, baseRadius) {
    const m = this.radiusMultiplier(hole);
    if (m === 1) return baseRadius;              // exact identity, no drift
    const cap = HOLE.MAX_RADIUS * POWERUPS.mass.cfg.maxOvershoot;
    return Math.min(cap, baseRadius * m);
  }

  /* -------------------------------------------------------- minimap / HUD */

  /** Pickups within `range` of a point, for the minimap's reveal rule. */
  nearbyPickups(x, z, range = this.cfg.minimapRange, out = []) {
    out.length = 0;
    const r2 = range * range;
    for (const p of this.pickups) {
      if (!p.alive) continue;
      const dx = p.x - x, dz = p.z - z;
      if (dx * dx + dz * dz <= r2) out.push(p);
    }
    return out;
  }

  /* =======================================================================
   * INTERNALS
   * ===================================================================== */

  _tickEffects(dt, holes) {
    if (this._byHole.size === 0) return;

    // Death/teleport rule (spec 7). Done first so a dead hole's boost cannot
    // be observed for even one frame by whatever samples the readers.
    if (!this.cfg.keepOnDeath && holes) {
      for (const hole of holes) {
        if (hole && !hole.alive && this._byHole.has(hole)) {
          for (const id of Array.from(this._byHole.get(hole).keys())) {
            this.revoke(hole, id, true);
          }
        }
      }
    }

    for (const [hole, m] of this._byHole) {
      for (const st of Array.from(m.values())) {
        st.elapsed += dt;
        if (st.elapsed < st.duration) continue;
        m.delete(st.id);
        this._expireFx(hole, POWERUPS[st.id]);
        if (this.onExpire) this.onExpire(hole, POWERUPS[st.id]);
      }
      if (m.size === 0) this._byHole.delete(hole);
    }
  }

  _tickPickups(dt, t) {
    for (const p of this.pickups) {
      if (!p.group) continue;
      const y = this.cfg.hoverY + Math.sin(t * this.cfg.bobRate + p.phase) * this.cfg.bobAmp;
      p.group.position.y = y;
      p.group.rotation.y += this.cfg.spinRate * dt;
      if (p.ring) p.ring.rotation.z -= this.cfg.spinRate * 1.7 * dt;
    }
  }

  _tickCollection(holes) {
    if (!holes || this.pickups.length === 0) return;
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      if (!p.alive) continue;
      for (const hole of holes) {
        if (!hole || !hole.alive) continue;
        const reach = Math.min(hole.radius, this.cfg.maxHoleReach) + this.cfg.pickRadius;
        const dx = hole.position.x - p.x;
        const dz = hole.position.z - p.z;
        if (dx * dx + dz * dz > reach * reach) continue;
        this.collect(hole, p);
        break;                                   // one pickup, one owner
      }
    }
  }

  _tickRespawns() {
    if (this._pending.length === 0) return;
    for (let i = this._pending.length - 1; i >= 0; i--) {
      const q = this._pending[i];
      if (this.clock < q.at) continue;
      // Placement can legitimately fail — a shrink ring may have swallowed the
      // whole eligible area. Push the attempt out rather than dropping the
      // pickup, or the world slowly empties of power-ups over a long match.
      if (this._spawnOne(q.id, q.fromX, q.fromZ)) this._pending.splice(i, 1);
      else q.at = this.clock + 4;
    }
  }

  /** Weighted kind choice that respects perKindMax. */
  _pickKind() {
    const counts = Object.create(null);
    for (const p of this.pickups) counts[p.id] = (counts[p.id] || 0) + 1;
    for (const q of this._pending) counts[q.id] = (counts[q.id] || 0) + 1;
    const entries = [];
    for (const id of POWERUP_ORDER) {
      if ((counts[id] || 0) >= this.cfg.perKindMax) continue;
      entries.push([id, POWERUPS[id].spawnWeight]);
    }
    if (entries.length === 0) return POWERUP_ORDER[0];
    return this.rng.weighted(entries);
  }

  /**
   * Place one pickup.
   *
   * `avoidX/avoidZ` is the point it was collected at; the new position must be
   * at least cfg.minRespawnMove away from it. That is the anti-camping rule.
   */
  _spawnOne(id, avoidX = null, avoidZ = null) {
    if (this.pickups.length >= this.cfg.maxLive) return false;
    const validate = this._validate;
    if (!validate) return false;

    const pos = this._findSpot(avoidX, avoidZ);
    if (!pos) return false;

    const def = POWERUPS[id] || POWERUPS[POWERUP_ORDER[0]];
    const p = {
      id: def.id,
      def,
      x: pos.x,
      z: pos.z,
      color: def.color,
      css: def.css,
      icon: def.icon,
      alive: true,
      phase: this.rng() * Math.PI * 2,
      bornAt: this.clock,
      group: null,
      ring: null,
    };
    this._attachVisual(p);
    this.pickups.push(p);
    if (this.fx) {
      this._scratch.set(p.x, 0.6, p.z);
      this.fx.shockwave(this._scratch, 0.6, 6.5, def.color, 0.55);
      this.fx.puff(this._scratch, def.color, 10, 1.4, 2.2, 0.45, 0.7);
    }
    if (this.onSpawn) this.onSpawn(p);
    return true;
  }

  /**
   * Find a point the GAME's validator accepts, far enough from every other
   * pickup and from the camp point.
   *
   * Two passes on purpose: the first insists on being off the road network so
   * pickups sit on plazas, verges and forecourts where they read clearly and
   * do not get visually buried under traffic; the second drops that
   * requirement so a road-heavy map still gets its pickups. Never drops the
   * validator requirement — that one is not negotiable.
   */
  _findSpot(avoidX, avoidZ) {
    const validate = this._validate;
    const sep2 = this.cfg.minSeparation * this.cfg.minSeparation;
    const move2 = this.cfg.minRespawnMove * this.cfg.minRespawnMove;

    for (let pass = 0; pass < 2; pass++) {
      const tries = pass === 0 ? this.cfg.offRoadTries : this.cfg.placeTries;
      for (let i = 0; i < tries; i++) {
        // Same land box game._spawnPoint samples: west of the bay, clear of the
        // river channel. Anything outside it is water or off-map by definition.
        const x = this.rng.range(-WORLD.SIZE * 0.78, WORLD.BAY_EDGE - 60);
        const z = this.rng.range(-WORLD.SIZE * 0.82, WORLD.SIZE * 0.82);
        if (Math.abs(z - WORLD.RIVER_Z) < WORLD.RIVER_HALF_W + 14) continue;

        if (avoidX != null) {
          const dx = x - avoidX, dz = z - avoidZ;
          if (dx * dx + dz * dz < move2) continue;
        }
        let clash = false;
        for (const p of this.pickups) {
          const dx = x - p.x, dz = z - p.z;
          if (dx * dx + dz * dz < sep2) { clash = true; break; }
        }
        if (clash) continue;

        if (pass === 0 && this.layout && this.layout.isRoad && this.layout.isRoad(x, z)) continue;

        const v = validate(x, z);
        if (v && v.ok) return { x, z };
      }
    }
    return null;
  }

  /** Take a pickup out of the world; queue its return if it was collected. */
  _retire(p, reason, hole) {
    if (!p.alive) return;
    p.alive = false;
    const i = this.pickups.indexOf(p);
    if (i >= 0) this.pickups.splice(i, 1);
    this._releaseVisual(p);
    if (reason === 'collected') {
      this._pending.push({
        id: p.id,
        at: this.clock + this.cfg.respawnDelay,
        fromX: p.x,
        fromZ: p.z,
      });
    }
    if (this.onDespawn) this.onDespawn(p, reason, hole || null);
  }

  /* ------------------------------------------------------------- feedback */

  _pickupFx(hole, pickup, def) {
    if (this.fx) {
      this._scratch.set(pickup.x, 1.2, pickup.z);
      this.fx.shockwave(this._scratch, 1.0, 11, def.color, 0.5);
      this.fx.sparks(this._scratch, def.color, 14, 7, 0.9, 0.5);
      this.fx.puff(this._scratch, def.color, 16, 1.6, 3.0, 0.5, 0.8);
      this.fx.popup(this._scratch, def.name, def.color, true);
      if (hole.isPlayer) this.fx.addShake(0.14);
    }
    // Audio owns its own naming; a power-up cue may or may not exist yet. Probe
    // the specific names first, then fall back to a method that is verified to
    // exist (ui) so a pickup is never silent.
    this._sound(['powerupStart', 'powerup'], def.id, 'click');
  }

  _expireFx(hole, def) {
    if (!def) return;
    if (this.fx && hole && hole.position) {
      this._scratch.set(hole.position.x, 1.0, hole.position.z);
      this.fx.puff(this._scratch, def.color, 10, 2.2, 1.4, 0.6, 0.9);
      this.fx.popup(this._scratch, `${def.name} OVER`, def.color, false);
    }
    this._sound(['powerupEnd', 'powerdown'], def.id, 'back');
  }

  _sound(names, arg, uiKind) {
    const a = this.audio;
    if (!a) return;
    try {
      for (const n of names) {
        if (typeof a[n] === 'function') { a[n](arg); return; }
      }
      if (typeof a.ui === 'function') a.ui(uiKind);
    } catch (e) {
      // A power-up must never be lost to an audio graph that is not unlocked.
      console.warn('[powerups] audio cue failed', e);
    }
  }

  /* -------------------------------------------------------------- visuals */

  /**
   * Procedural pickup: a slowly spinning core inside a counter-rotating ring,
   * both emissive so they read at night as well as at noon. Geometry and
   * materials are created once and shared; whole visuals are pooled, so a
   * match that respawns pickups forty times allocates three geometries and
   * three materials in total.
   */
  _ensureGpu() {
    if (this._geo || !this.scene) return;
    this._geo = {
      ring: new THREE.TorusGeometry(1.15, 0.16, 8, 22),
      octa: new THREE.OctahedronGeometry(0.95, 0),
      cone: new THREE.ConeGeometry(0.8, 1.7, 6),
      halo: new THREE.TorusGeometry(1.9, 0.07, 6, 28),
    };
    this._mats = {};
    for (const id of POWERUP_ORDER) {
      const def = POWERUPS[id];
      this._mats[id] = new THREE.MeshStandardMaterial({
        color: def.color,
        emissive: def.color,
        // 1.2 not 3: at higher values the bloom pass turns a 2 m pickup into a
        // white blob that hides the props behind it.
        emissiveIntensity: 1.2,
        roughness: 0.35,
        metalness: 0.15,
      });
    }
  }

  _attachVisual(p) {
    if (!this.scene) return;
    this._ensureGpu();
    let v = this._freeVisuals.pop();
    if (!v) {
      const group = new THREE.Group();
      group.name = 'powerup-pickup';
      const core = new THREE.Mesh(this._geo.octa, this._mats[p.id]);
      const ring = new THREE.Mesh(this._geo.halo, this._mats[p.id]);
      ring.rotation.x = Math.PI / 2;
      group.add(core, ring);
      v = { group, core, ring };
    }
    // Swap the core geometry so each kind has its own silhouette — shape is the
    // non-colour channel that tells them apart (accessibility rule 6).
    v.core.geometry = this._geo[POWERUPS[p.id].shape] || this._geo.octa;
    v.core.material = this._mats[p.id];
    v.ring.material = this._mats[p.id];
    v.group.position.set(p.x, this.cfg.hoverY, p.z);
    v.group.visible = true;
    this.scene.add(v.group);
    p.group = v.group;
    p.ring = v.ring;
    p._visual = v;
  }

  _releaseVisual(p) {
    const v = p._visual;
    p.group = null; p.ring = null; p._visual = null;
    if (!v) return;
    v.group.visible = false;
    if (v.group.parent) v.group.parent.remove(v.group);
    this._freeVisuals.push(v);
  }
}

/* ===========================================================================
 * SELF-TEST
 *
 * Headless: no scene, no effects, no audio, no registry. Run it from the
 * orchestrator or a node harness:
 *
 *     import { __selftest } from './src/gameplay/powerups.js';
 *     const r = __selftest();
 *     if (r.failed) process.exit(1);
 *
 * Covers the four things the brief names — duration expiry, stacking, clearAll
 * residue, and radiusMultiplier returning EXACTLY 1 after expiry — plus the
 * two correctness invariants that would be silent failures: the tier/size gate
 * on the vacuum pull, and the tunnelling clamp on turbo.
 * ========================================================================= */
export function __selftest() {
  const results = [];
  let failed = 0;
  const ok = (name, cond, detail = '') => {
    results.push({ name, pass: !!cond, detail });
    if (!cond) failed++;
  };

  const fakeHole = (over = {}) => Object.assign({
    id: 1, isPlayer: true, alive: true, score: 0, radius: 4.0, tier: 2,
    position: { x: 0, y: 0, z: 0 },
  }, over);

  const fakeProp = (over = {}) => Object.assign({
    state: STATE.IDLE, radius: 0.5, passRadius: 0.31, height: 0.9,
    tier: { id: 1 }, position: { x: 10, y: 0, z: 0 },
  }, over);

  /* --- 1. duration expiry ------------------------------------------------ */
  {
    const ps = new PowerupSystem({ rng: makeRNG(7) });
    const h = fakeHole();
    ps.grant(h, POWERUP_ID.VACUUM);
    ps.update(0.5, [h]);
    ok('vacuum active after 0.5s', ps.isActive(h, POWERUP_ID.VACUUM));
    ok('vacuum remaining ~29.5',
      Math.abs(ps.remaining(h, POWERUP_ID.VACUUM) - 29.5) < 1e-6,
      String(ps.remaining(h, POWERUP_ID.VACUUM)));
    ok('reach multiplier > 1 while active', ps.queryRadiusMultiplier(h) > 1.2);

    for (let i = 0; i < 300; i++) ps.update(0.1, [h]);   // +30 s
    ok('vacuum expired', !ps.isActive(h, POWERUP_ID.VACUUM));
    ok('reach multiplier exactly 1 after expiry',
      ps.queryRadiusMultiplier(h) === 1, String(ps.queryRadiusMultiplier(h)));
    ok('pullAccel exactly 0 after expiry',
      ps.pullAccel(h, fakeProp(), 6) === 0);
    ok('no hole entry left behind', ps.residue().holes === 0);
  }

  /* --- 2. stacking ------------------------------------------------------- */
  {
    const ps = new PowerupSystem({ rng: makeRNG(8) });
    const h = fakeHole();
    ps.grant(h, POWERUP_ID.VACUUM);          // EXTEND
    ps.update(10, [h]);                      // 20 s left
    ps.grant(h, POWERUP_ID.VACUUM);          // 20 + 30 = 50, capped at 45
    const cap = POWERUPS.vacuum.duration * POWERUPS.vacuum.cfg.maxDurationMult;
    ok('EXTEND adds time', ps.remaining(h, POWERUP_ID.VACUUM) > 30);
    ok('EXTEND respects the cap',
      ps.remaining(h, POWERUP_ID.VACUUM) <= cap + 1e-9,
      String(ps.remaining(h, POWERUP_ID.VACUUM)));
    ok('EXTEND never multiplies magnitude',
      ps.queryRadiusMultiplier(h) <= POWERUPS.vacuum.cfg.reachMultiplier + 1e-9);

    ps.grant(h, POWERUP_ID.TURBO);           // REFRESH
    ps.update(5, [h]);
    ps.grant(h, POWERUP_ID.TURBO);
    ok('REFRESH restores full duration',
      Math.abs(ps.remaining(h, POWERUP_ID.TURBO) - POWERUPS.turbo.duration) < 1e-9,
      String(ps.remaining(h, POWERUP_ID.TURBO)));
    ok('two effects coexist', ps.activeFor(h).length === 2);
    ok('HUD order is stable',
      ps.activeFor(h).map((e) => e.id).join(',') === 'vacuum,turbo');
  }

  /* --- 3. mass surge: temporary, exact, and never touches score ---------- */
  {
    const ps = new PowerupSystem({ rng: makeRNG(9) });
    const h = fakeHole({ score: 1234, radius: 8 });
    ok('radiusMultiplier is exactly 1 when inactive', ps.radiusMultiplier(h) === 1);
    ok('scaleRadius is the identity when inactive', ps.scaleRadius(h, 8) === 8);

    ps.grant(h, POWERUP_ID.MASS);
    ps.update(1.0, [h]);
    const m = ps.radiusMultiplier(h);
    ok('surge is at peak after the attack ramp',
      Math.abs(m - POWERUPS.mass.cfg.peak) < 1e-6, String(m));
    ok('surge never exceeds the configured peak', m <= POWERUPS.mass.cfg.peak + 1e-9);
    ok('surge did not touch score', h.score === 1234);

    // Mid-release it must be strictly between 1 and peak, and falling.
    ps.update(10.0, [h]);                    // t = 11 of 12: 1 s into release
    const mid = ps.radiusMultiplier(h);
    ok('release is smooth, not a step', mid > 1 && mid < POWERUPS.mass.cfg.peak,
      String(mid));

    ps.update(2.0, [h]);                     // past 12 s
    ok('mass expired', !ps.isActive(h, POWERUP_ID.MASS));
    ok('radiusMultiplier is EXACTLY 1 after expiry',
      ps.radiusMultiplier(h) === 1, String(ps.radiusMultiplier(h)));
    ok('scaleRadius restores the base bit-for-bit',
      ps.scaleRadius(h, 8.123456789) === 8.123456789);
    ok('overshoot cap holds at MAX_RADIUS', (() => {
      ps.grant(h, POWERUP_ID.MASS); ps.update(1, [h]);
      return ps.scaleRadius(h, HOLE.MAX_RADIUS) <=
        HOLE.MAX_RADIUS * POWERUPS.mass.cfg.maxOvershoot + 1e-9;
    })());
  }

  /* --- 4. vacuum gating + falloff ---------------------------------------- */
  {
    const ps = new PowerupSystem({ rng: makeRNG(10) });
    const h = fakeHole({ radius: 4, tier: 2 });
    ps.grant(h, POWERUP_ID.VACUUM);
    ps.update(1.0, [h]);

    const small = fakeProp({ tier: { id: 1 }, passRadius: 0.3, radius: 0.5 });
    const rimA = ps.pullAccel(h, small, 4.0);
    const midA = ps.pullAccel(h, small, 12.0);
    const farA = ps.pullAccel(h, small, 999);
    ok('pull is strongest at the rim', rimA > midA && midA > 0, `${rimA} > ${midA}`);
    ok('pull is zero beyond reach', farA === 0);
    ok('pull inside the rim is clamped, not zero', ps.pullAccel(h, small, 0.1) === rimA);

    const tooBigTier = fakeProp({ tier: { id: 5 }, passRadius: 0.3 });
    ok('tier gate rejects far-off classes', ps.pullAccel(h, tooBigTier, 6) === 0);
    const adjacent = fakeProp({ tier: { id: 3 }, passRadius: 0.9 });
    ok('tier gate allows one adjacent class', ps.pullAccel(h, adjacent, 6) > 0);
    const tooWide = fakeProp({ tier: { id: 2 }, passRadius: 99 });
    ok('size gate rejects what cannot be swallowed',
      ps.pullAccel(h, tooWide, 6) === 0);
    const gone = fakeProp({ state: STATE.GONE });
    ok('eaten props are never pulled', ps.pullAccel(h, gone, 6) === 0);

    // A Mass Surge must SPEND the vacuum's headroom, not add to it.
    ps.grant(h, POWERUP_ID.MASS);
    ps.update(0.5, [h]);
    ok('surge + vacuum does not widen the tier gate to two classes',
      ps.pullAccel(h, adjacent, 6) === 0);
  }

  /* --- 5. turbo bounds --------------------------------------------------- */
  {
    const ps = new PowerupSystem({ rng: makeRNG(11) });
    const h = fakeHole();
    ok('speedMultiplier is exactly 1 when inactive', ps.speedMultiplier(h) === 1);
    ok('turnMultiplier is exactly 1 when inactive', ps.turnMultiplier(h) === 1);
    ps.grant(h, POWERUP_ID.TURBO);
    ps.update(1.0, [h]);
    const s = ps.speedMultiplier(h);
    ok('speed multiplier is clamped below the tunnelling ceiling',
      s <= MAX_SAFE_SPEED_MULT + 1e-9 && s > 1, String(s));
    // The bound the derivation actually rests on: worst-case metres per frame
    // must stay under the hole's own radius at the START radius.
    const jump = HOLE.BASE_SPEED * (1 / 20) * s;
    ok('worst-case frame jump stays inside the start radius',
      jump < HOLE.START_RADIUS, `${jump.toFixed(3)} m vs r=${HOLE.START_RADIUS}`);
    ok('turn multiplier is clamped',
      ps.turnMultiplier(h) <= MAX_SAFE_TURN_MULT + 1e-9);
  }

  /* --- 6. serialize / applyState ----------------------------------------- */
  {
    const ps = new PowerupSystem({ rng: makeRNG(12) });
    const a = fakeHole({ id: 1 });
    const b = fakeHole({ id: 2 });
    ps.grant(a, POWERUP_ID.VACUUM);
    ps.grant(a, POWERUP_ID.MASS);
    ps.update(2, [a, b]);
    const snap = ps.serialize(a);
    ok('serialize is JSON-safe', JSON.parse(JSON.stringify(snap)).length === 2);
    ps.applyState(b, snap);
    ok('applyState reproduces remaining time',
      Math.abs(ps.remaining(b, POWERUP_ID.VACUUM) -
               ps.remaining(a, POWERUP_ID.VACUUM)) < 1e-6);
    ok('applyState reproduces the envelope',
      Math.abs(ps.radiusMultiplier(b) - ps.radiusMultiplier(a)) < 1e-9);
    ps.applyState(b, []);
    ok('an empty authority payload strips everything',
      ps.activeFor(b).length === 0);
    ps.applyState(b, [[99, 1, 5, 1]]);
    ok('an unknown power-up index is ignored, not crashed',
      ps.activeFor(b).length === 0);
  }

  /* --- 7. death drops the boost ------------------------------------------ */
  {
    const ps = new PowerupSystem({ rng: makeRNG(13) });
    const h = fakeHole();
    ps.grant(h, POWERUP_ID.TURBO);
    ps.update(1, [h]);
    h.alive = false;
    ps.update(0.016, [h]);
    ok('a dead hole loses its power-ups', !ps.isActive(h, POWERUP_ID.TURBO));
    ok('and its multipliers are exactly 1', ps.speedMultiplier(h) === 1);
  }

  /* --- 8. spawning, anti-camping, and clearAll --------------------------- */
  {
    const ps = new PowerupSystem({ rng: makeRNG(14) });
    // Accept everything except a 60 m disc, so the placement loop has to work
    // for its answer rather than taking the first sample.
    const validate = (x, z) => ({ ok: Math.hypot(x - 100, z - 100) > 60 });
    const made = ps.spawnInto(validate, 4);
    ok('spawnInto placed pickups', made > 0, `made=${made}`);
    ok('every pickup passes the game validator',
      ps.pickups.every((p) => validate(p.x, p.z).ok));
    ok('pickups respect minimum separation', (() => {
      for (let i = 0; i < ps.pickups.length; i++) {
        for (let j = i + 1; j < ps.pickups.length; j++) {
          const a = ps.pickups[i], b = ps.pickups[j];
          if (Math.hypot(a.x - b.x, a.z - b.z) < ps.cfg.minSeparation - 1e-6) return false;
        }
      }
      return true;
    })());
    ok('never more than maxLive', ps.pickups.length <= ps.cfg.maxLive);

    const p0 = ps.pickups[0];
    const at = { x: p0.x, z: p0.z };
    const h = fakeHole({ radius: 3, position: { x: p0.x, y: 0, z: p0.z } });
    const st = ps.collect(h, p0);
    ok('collect grants the matching effect', !!st && ps.isActive(h, p0.id));
    ok('a collected pickup leaves the world', !ps.pickups.includes(p0));
    ok('and is queued to return', ps.residue().pending === 1);

    // Roll past the respawn delay and confirm it came back somewhere ELSE.
    for (let i = 0; i < 300; i++) ps.update(0.1, [h]);
    const back = ps.pickups.find((p) => p.id === p0.id);
    ok('the pickup returned', !!back);
    ok('and NOT where it was camped',
      !back || Math.hypot(back.x - at.x, back.z - at.z) >= ps.cfg.minRespawnMove - 1e-6);

    ps.clearAll();
    const r = ps.residue();
    ok('clearAll leaves no pickups', r.pickups === 0);
    ok('clearAll leaves no pending respawns', r.pending === 0);
    ok('clearAll leaves no hole state', r.holes === 0 && r.effects === 0);
    ok('clearAll resets the clock', ps.clock === 0);
    ok('and the readers are back to identity',
      ps.queryRadiusMultiplier(h) === 1 &&
      ps.speedMultiplier(h) === 1 &&
      ps.turnMultiplier(h) === 1 &&
      ps.radiusMultiplier(h) === 1);
  }

  /* --- 9. a bare RNG must not break placement ---------------------------- */
  {
    let seed = 1;
    const bare = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const ps = new PowerupSystem({ rng: bare });
    ok('spawnInto works with a bare () => float rng',
      ps.spawnInto(() => ({ ok: true }), 3) === 3);
    ps.clearAll();
  }

  /* --- 10. no validator means no pickups, and no crash ------------------- */
  {
    const ps = new PowerupSystem({ rng: makeRNG(15) });
    ok('spawnInto refuses a missing validator', ps.spawnInto(null, 3) === 0);
    ok('and places nothing', ps.pickups.length === 0);
    ok('update on an empty system is a no-op', (() => {
      ps.update(0.016, []); ps.update(0.016, null); return ps.residue().pickups === 0;
    })());
  }

  return { failed, passed: results.length - failed, total: results.length, results };
}

/* Vitest picks this up when the suite runs; harmless everywhere else. */
if (import.meta.vitest) {
  const { it, expect } = import.meta.vitest;
  it('powerups self-test', () => {
    const r = __selftest();
    expect(r.results.filter((x) => !x.pass).map((x) => x.name)).toEqual([]);
    expect(r.failed).toBe(0);
  });
}
