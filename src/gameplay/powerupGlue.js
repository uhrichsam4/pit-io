/**
 * MIAMI DEVOUR — power-ups, wired into the live match.
 *
 * WHY THIS FILE EXISTS AT ALL
 *   gameplay/powerups.js is deliberately inert: a balance table, a pickup
 *   spawner and a set of PURE readers that never write to a hole, never move a
 *   prop and never award a point. Something has to sample those readers and
 *   apply them to the real simulation. That is this file, and it is kept apart
 *   from game.js for one reason: game.js is edited by everybody, and the seam
 *   where a power-up reaches the physics is the one place a mistake silently
 *   turns into "score with no visible eat".
 *
 * THE ONE LINE game.js NEEDS
 *   At the end of Game.init(), next to installDevTools(this):
 *
 *       this.powerups = (await import('./gameplay/powerupGlue.js')).install(this);
 *
 *   Nothing else. No import statement (the dynamic import matches how
 *   dev/devtools.js and meta/ are already loaded), no call in the frame loop,
 *   no call in startMatch or on match end — install() hooks all of those from
 *   the outside. If the line is never added the game runs exactly as it did
 *   before; if it is added twice the second install replaces the first
 *   cleanly (the previous one is uninstalled first).
 *
 * WHAT IT TOUCHES, AND WHAT IT REFUSES TO
 *   - consume.reachHook / consume.pullHook   Vacuum Boost. Numbers only. The
 *     prop is moved by ConsumeSystem's own integrator and swallowed by
 *     ConsumeSystem._capture, which is the ONLY function in the game that calls
 *     hole.addScore. This file never adds score, never hides a prop and never
 *     creates one.
 *   - hole.speed (an instance-level accessor)  Turbo Drain's top speed, applied
 *     at the exact point hole.update() computes the desired velocity.
 *   - hole.velocity (one extra convergence step)  Turbo Drain's turn rate.
 *   - hole.radius (recomputed from hole.score every tick)  Mass Surge. Never
 *     hole.score, never addScore.
 *
 * @see CLAUDE_OVERNIGHT_POWERUPS_EVENTS_AUDIO.md section 1
 * @see gameplay/powerups.js — "RECOMMENDED CONSUME WIRING"
 */

import * as THREE from 'three';
import { PowerupSystem, POWERUPS, POWERUP_ID } from './powerups.js';
import { Hole } from './hole.js';
import { PHASE } from './match.js';
import { HOLE } from '../config.js';
import { audio } from '../core/audio.js';
import { makeRNG } from '../core/rng.js';

/**
 * Scratch for the feedback emitters. Module scope and declared BEFORE the class
 * that uses it: three separate TDZ bugs have shipped in this codebase from a
 * const that was only reached at runtime "so the order does not matter".
 */
const _pos = new THREE.Vector3();

/**
 * The UNBOOSTED speed getter, captured once from the prototype.
 *
 * Turbo Drain works by shadowing `speed` on the individual hole with an
 * accessor that multiplies this. Read from the prototype descriptor rather than
 * re-deriving the formula here: a copy of `BASE_SPEED * (r/r0)^0.375` in a
 * second file is a number that drifts the first time hole.js is retuned, and
 * the drift would be invisible.
 */
const BASE_SPEED_GET = Object.getOwnPropertyDescriptor(Hole.prototype, 'speed')?.get || null;
if (!BASE_SPEED_GET) {
  // Loud, because the alternative is Turbo Drain quietly doing nothing.
  console.error('[powerups] Hole.prototype has no `speed` getter — Turbo Drain disabled');
}

/** Particles per second for the vacuum swirl and the turbo trail. */
const SWIRL_RATE = 14;
const SWIRL_MAX_DT = 0.25;   // a stalled tab must not emit a hundred at once

class PowerupGlue {
  /** @param {import('../game.js').Game} game */
  constructor(game) {
    this.game = game;

    this.sys = new PowerupSystem({
      // Its OWN stream, seeded from the world seed. Not game.rng: drawing from
      // that would shift every later bot spawn point by the number of pickup
      // placement attempts, so a build with power-ups and one without would
      // disagree about the whole match. Keyed on worldSeed so every client in a
      // room still places pickups identically.
      rng: makeRNG(((game.worldSeed ?? 0) ^ 0x9017d3f1) >>> 0),
      layout: game.layout || null,
      effects: game.effects || null,
      registry: game.registry || null,
      scene: game.engine ? game.engine.scene : null,
      // Deliberately NOT audio: PowerupSystem probes for `powerupStart` /
      // `powerup`, and core/audio.js ships `powerupPickup` / `powerupSpawn` /
      // `powerupLoop` / `powerupEnd`. The probe would silently fall back to a
      // generic UI click. Every cue is fired explicitly below, by verified name.
      audio: null,
    });

    /** Holes whose `speed` getter is currently shadowed. */
    this._boosted = new Set();
    /** Holes whose radius currently carries a Mass Surge. */
    this._surged = new Set();
    /** Live audio loop handles, keyed by power-up id. Player only. */
    this._loops = new Map();

    this._armed = false;
    this._armedPlayer = null;
    this._swirlT = 0;
    this._installed = false;

    this._wireCallbacks();
  }

  /* ===================================================================== */
  /*  INSTALL / UNINSTALL                                                  */
  /* ===================================================================== */

  install() {
    const g = this.game;
    if (this._installed) return this;
    this._installed = true;

    /* --- Vacuum Boost reaches the real physics ------------------------- */
    // Two numbers, and that is the entire contract. ConsumeSystem widens its
    // own query and integrates its own acceleration; nothing here is allowed
    // to touch a Consumable.
    this._prevReach = g.consume.reachHook;
    this._prevPull = g.consume.pullHook;
    this._prevLimit = g.consume.pullLimit;
    g.consume.reachHook = (hole) => this.sys.queryRadiusMultiplier(hole);
    g.consume.pullHook = (hole, c, dist, baseR) => this.sys.pullAccel(hole, c, dist, baseR);
    g.consume.pullLimit = POWERUPS.vacuum.cfg.maxPulled;

    /* --- per-frame ------------------------------------------------------ */
    // stepSimulation rather than frame(): it is the one deterministic tick, it
    // is what the dev harness calls directly, and it already receives the dt
    // that game.js has clamped to 1/20 s.
    const inner = g.stepSimulation.bind(g);
    this._innerStep = inner;
    // Whether stepSimulation was the prototype method or somebody else's own
    // property. uninstall() has to put back what it found, not a bound copy.
    this._stepWasOwn = Object.prototype.hasOwnProperty.call(g, 'stepSimulation');
    this._patchedStep = (dt) => {
      // BEFORE the tick: the radius Mass Surge is lending must already be in
      // place when hole.update() springs the drawn opening and when
      // consume.update() runs its overlap tests, or the boost is a frame late
      // and the visual and the physics disagree for that frame.
      this.preStep();
      inner(dt);
      this.postStep(dt);
    };
    g.stepSimulation = this._patchedStep;
    return this;
  }

  /** Undo everything, in the reverse order. Used by a re-install and by tests. */
  uninstall() {
    const g = this.game;
    if (!this._installed) return;
    this.teardown();
    // Only unwrap if nothing else wrapped us afterwards — restoring the inner
    // function over a later wrapper would silently delete that system instead.
    if (g.stepSimulation === this._patchedStep) {
      if (this._stepWasOwn) g.stepSimulation = this._innerStep;
      else delete g.stepSimulation;      // uncover Game.prototype.stepSimulation
    }
    g.consume.reachHook = this._prevReach ?? null;
    g.consume.pullHook = this._prevPull ?? null;
    g.consume.pullLimit = this._prevLimit ?? 0;
    this.sys.dispose();
    this._installed = false;
  }

  /* ===================================================================== */
  /*  MATCH LIFECYCLE                                                      */
  /* ===================================================================== */

  /**
   * Pickups are placed at the COUNTDOWN edge, not at the first playing frame.
   *
   * game._validateSpawn walks every consumable in the city, and _findSpot may
   * call it dozens of times. That cost is real, and the countdown is exactly
   * where the game already absorbs a hitch — during play it would be a visible
   * stall. (game._spawnPoint budgets 240 of the same calls, so this is well
   * inside what the codebase already pays.)
   */
  _arm() {
    const g = this.game;
    this.sys.clearAll();
    this._boosted.clear();
    this._surged.clear();
    // The layout only exists after init(); a mode change never rebuilds it, but
    // re-reading is free and a null layout silently disables the off-road pass.
    this.sys.layout = g.layout || null;
    const placed = this.sys.spawnInto((x, z) => g._validateSpawn(x, z));
    this._armed = true;
    this._armedPlayer = g.player || null;
    if (placed < 1) console.warn('[powerups] no pickups could be placed this round');
  }

  /**
   * Match over, restart, or back to the lobby.
   *
   * "No residue" means every one of these, and they are listed separately
   * because clearAll() alone is not enough: it empties the power-up system but
   * leaves the player's hole carrying a shadowed speed getter, a 15% radius and
   * a wind loop into the results screen.
   */
  teardown() {
    for (const hole of Array.from(this._boosted)) this._unpatchSpeed(hole);
    for (const hole of Array.from(this._surged)) this._restoreRadius(hole);
    for (const [, h] of this._loops) { try { h.stop(0.3); } catch { /* dead handle */ } }
    this._loops.clear();
    this.sys.clearAll();
    this._armed = false;
    this._armedPlayer = null;
  }

  /* ===================================================================== */
  /*  PER FRAME                                                            */
  /* ===================================================================== */

  preStep() {
    const g = this.game;
    const phase = g.match ? g.match.phase : null;
    const live = phase === PHASE.COUNTDOWN || phase === PHASE.PLAYING;

    // startMatch() always constructs a NEW player Hole, so its identity is the
    // one reliable "this is a different round" signal. Phase alone is not:
    // a net-driven restart can go PLAYING -> PLAYING without ever passing
    // through RESULTS, and the old round's pickups would stay on the map.
    if (live && (!this._armed || g.player !== this._armedPlayer)) this._arm();
    else if (!live && this._armed) this.teardown();
    if (!this._armed) return;

    for (const hole of g.holes) {
      this._syncSpeed(hole);
      this._syncRadius(hole);
    }
  }

  postStep(dt) {
    const g = this.game;
    if (!this._armed) return;
    // PLAYING only. During the countdown the pickups are already placed and
    // visible, but nothing may be collected and no timer may run: three seconds
    // of a 13-second Turbo Drain spent standing still is not a power-up.
    if (g.match && g.match.phase !== PHASE.PLAYING) return;

    // Timers, pickups, collection and respawns. Driven by the clamped dt, so a
    // backgrounded tab cannot burn power-up seconds.
    this.sys.update(dt, g.holes, g.clock ? g.clock.elapsedTime : 0);

    for (const hole of g.holes) {
      this._applyTurn(hole, dt);
      // An eat during consume.update() re-solved hole.radius from the score
      // curve, which drops the surge. Put it back before anything downstream
      // (camera, minimap, occlusion, the net snapshot) reads the frame.
      this._syncRadius(hole);
    }

    this._feedback(dt);

    // The active-power-up rail. Probed, never required — hud.js belongs to
    // another pass and this must not break if the method is ever renamed.
    // Called every frame with the full list, which is the shape hud.js asks
    // for: it diffs, and a row that stops being listed is what makes it fire
    // the end notification. Nothing calls it after the match ends because the
    // HUD is hidden in RESULTS and hud.reset() wipes the rail for the next
    // round — announcing three expiries over the results card would be noise.
    const hud = g.hud;
    if (hud && typeof hud.setPowerups === 'function' && g.player) {
      hud.setPowerups(this.sys.activeFor(g.player));
    }
  }

  /* ===================================================================== */
  /*  TURBO DRAIN                                                          */
  /* ===================================================================== */

  /**
   * Shadow (or un-shadow) the hole's `speed` getter.
   *
   * hole.update() computes its target velocity as `this.desiredDir * this.speed`
   * — so an own-property accessor on the instance IS the point where the
   * desired velocity is computed, without hole.js being edited and without any
   * other hole in the match being affected. `delete` restores the prototype
   * getter exactly.
   *
   * TUNNELLING. The shipped multiplier is 1.35, hard-clamped by
   * powerups.MAX_SAFE_SPEED_MULT (1.6). Position is a plain Euler step and
   * game.js clamps dt at 1/20 s, so the furthest a hole can jump between two
   * overlap tests is speed * 0.05 m. Speed grows as (r/r0)^0.375 while the
   * radius grows linearly, so the worst jump-to-radius ratio is at the START
   * radius: 19.5 * 0.05 * 1.35 / 2.0 = 0.66. A prop can only be skipped when
   * that ratio reaches 1.0, and it only improves as the hole grows (at r = 34
   * it is 0.11). The clamp keeps a careless config edit inside the same bound.
   */
  _syncSpeed(hole) {
    if (!BASE_SPEED_GET) return;
    // A remote hole's motion is interpolated from the server in net/client.js;
    // nothing local may write its velocity or its speed.
    if (hole.type === 'remote') return;
    const want = hole.alive && this.sys.isActive(hole, POWERUP_ID.TURBO);
    const has = this._boosted.has(hole);
    if (want && !has) {
      const sys = this.sys;
      Object.defineProperty(hole, 'speed', {
        configurable: true,
        enumerable: false,
        get() { return BASE_SPEED_GET.call(this) * sys.speedMultiplier(this); },
      });
      this._boosted.add(hole);
    } else if (!want && has) {
      this._unpatchSpeed(hole);
    }
  }

  _unpatchSpeed(hole) {
    // Deleting the own property uncovers the prototype getter again — the value
    // is bit-for-bit what it was before the boost, with no residual multiplier.
    if (Object.prototype.hasOwnProperty.call(hole, 'speed')) delete hole.speed;
    this._boosted.delete(hole);
  }

  /**
   * Turn responsiveness, applied as ONE extra convergence step per frame.
   *
   * hole.update() already ran `v += (T - v) * (1 - e^(-A*dt))`. Applying a
   * second lerp toward the SAME target with `1 - e^(-A*(m-1)*dt)` composes
   * exactly:
   *
   *     T - v2 = (T - v0) * e^(-A*dt) * e^(-A*(m-1)*dt) = (T - v0) * e^(-A*m*dt)
   *
   * which is identical to having run hole.update with HOLE.ACCEL * m. It is not
   * an approximation, and it cannot cause tunnelling because it never raises
   * the target — only how fast the velocity reaches a top speed it can never
   * exceed. The one cost is that this frame's position was integrated before
   * the correction, so the extra responsiveness lands one frame later; at
   * 1/20 s worst case that is 50 ms on a 13-second power-up.
   */
  _applyTurn(hole, dt) {
    if (!(dt > 0) || !hole.alive || hole.type === 'remote') return;
    const m = this.sys.turnMultiplier(hole);
    if (m <= 1) return;
    // hole.speed here is already the boosted getter, so both lerps converge on
    // the same target — which is what makes the composition above exact.
    const spd = hole.speed;
    const tvx = hole.desiredDir.x * spd;
    const tvz = hole.desiredDir.y * spd;
    const k = 1 - Math.exp(-HOLE.ACCEL * (m - 1) * dt);
    hole.velocity.x += (tvx - hole.velocity.x) * k;
    hole.velocity.z += (tvz - hole.velocity.z) * k;
  }

  /* ===================================================================== */
  /*  MASS SURGE                                                           */
  /* ===================================================================== */

  /**
   * HOW THE TEMPORARY SIZE STAYS OUT OF THE PERMANENT SCORE->RADIUS SYSTEM
   *
   * The permanent relationship is `radius = Hole.radiusFor(score)`, and it is
   * re-derived from score inside Hole.addScore() and Hole.reset(). The surge is
   * a pure function of elapsed time that multiplies that value:
   *
   *     hole.radius = scaleRadius(hole, Hole.radiusFor(hole.score))
   *
   * The BASE is recomputed from score on every single call, never from the
   * hole's current radius. That is the whole separation:
   *   - the surge cannot compound — two ticks multiply the same canonical base;
   *   - an eat during a surge grows the base by exactly what the curve says,
   *     because addScore did its own radiusFor(score) and we re-derive it;
   *   - hole.score is never read except as the input to that curve, and is
   *     never written here at all. The surge buys REACH, not points: what it
   *     swallows pays its ordinary score through ConsumeSystem._capture.
   *
   * EXACTLY 1.0 ON EXPIRY. While the effect is live the multiplier decays down
   * its release ramp, so the last frame before it is deleted leaves a radius a
   * hair above the base. The `_surged` set exists so that the frame the effect
   * disappears we write `Hole.radiusFor(hole.score)` once, restoring the
   * identity `hole.radius === Hole.radiusFor(hole.score)` bit-for-bit rather
   * than leaving floating-point residue behind.
   */
  _syncRadius(hole) {
    // net/client.js interpolates a remote hole's radius from the wire; the
    // server is the authority on how big somebody else is.
    if (hole.type === 'remote') return;
    if (this.sys.isActive(hole, POWERUP_ID.MASS) && hole.alive) {
      hole.radius = this.sys.scaleRadius(hole, Hole.radiusFor(hole.score));
      this._surged.add(hole);
    } else if (this._surged.has(hole)) {
      this._restoreRadius(hole);
    }
  }

  _restoreRadius(hole) {
    hole.radius = Hole.radiusFor(hole.score);
    this._surged.delete(hole);
  }

  /* ===================================================================== */
  /*  FEEDBACK                                                             */
  /* ===================================================================== */

  _wireCallbacks() {
    const sys = this.sys;

    sys.onSpawn = (p) => {
      // Positional and quiet: most spawns are off screen and distance
      // attenuation decides whether the player hears it at all.
      audio.powerupSpawn(p.x, p.z);
    };

    // (hole, def, state) — `state` carries the ACTUAL duration, which is not
    // def.duration once Vacuum Boost's EXTEND stacking has lengthened it.
    sys.onPickup = (hole, def, st) => {
      if (!hole || !hole.isPlayer) return;      // a bot's pickup is not a cue
      audio.powerupPickup(def.id);
      // The continuous bed. Idempotent by kind in core/audio.js, so collecting
      // a second Vacuum Boost extends the timer and changes nothing here.
      this._loops.set(def.id, audio.powerupLoop(def.id));
      this._banner(def, st);
    };

    sys.onExpire = (hole, def) => {
      if (!hole || !hole.isPlayer || !def) return;
      // powerupEnd() also stops the matching loop — the two are one event, and
      // making the caller remember both is how a wind bed outlives its boost.
      audio.powerupEnd(def.id);
      this._loops.delete(def.id);
      // No end notification is pushed from here on purpose. The row vanishing
      // out of setPowerups() is what makes hud.js announce it, and hud.js
      // dedupes a second one within 1.5 s — so pushing one as well would be
      // either a duplicate card or a silent dependency on that dedupe window.
    };
  }

  /**
   * The pickup card: `VACUUM BOOST — 30s`.
   *
   * hud.js owns the presentation and ships showPowerupBanner() for exactly
   * this. Both calls are probed rather than assumed: hud.js belongs to another
   * pass, and a power-up must never be lost to a HUD method that has not landed
   * yet — hence the kill-feed fallback, which is verified to exist.
   */
  _banner(def, st) {
    const hud = this.game.hud;
    if (!hud) return;
    const seconds = Math.round(st && st.duration ? st.duration : def.duration);
    if (typeof hud.showPowerupBanner === 'function') {
      hud.showPowerupBanner({
        id: def.id, kind: 'get', name: def.name, icon: def.icon,
        css: def.css, description: def.description, seconds,
      });
    } else if (typeof hud.pushFeed === 'function') {
      hud.pushFeed(`<b>${def.icon} ${def.name}</b> — ${seconds}s`, def.css, 'powerup');
    }
  }

  /**
   * The two continuous visuals, player only.
   *
   * Both go through Effects' pooled particle ring, and both are rate-limited in
   * SECONDS rather than per frame so they cost the same at 30 fps and at 144.
   * Deliberately sparse: the rule the review applies is that an effect must
   * never obscure the hole or a rival, and a 34 m rim emitting every frame is
   * a wall of dust.
   */
  _feedback(dt) {
    const g = this.game;
    const p = g.player;
    const fx = g.effects;
    if (!p || !p.alive || !fx) return;

    const vac = this.sys.isActive(p, POWERUP_ID.VACUUM);
    const tur = this.sys.isActive(p, POWERUP_ID.TURBO);
    if (!vac && !tur) { this._swirlT = 0; return; }

    this._swirlT += Math.min(dt, SWIRL_MAX_DT);
    const gap = 1 / SWIRL_RATE;
    if (this._swirlT < gap) return;
    this._swirlT -= gap;

    if (vac) {
      // On the boosted reach, tangential, so it reads as air spiralling in
      // rather than as debris being thrown out.
      const reach = this.sys.vacuumReach(p);
      const a = (g.clock ? g.clock.elapsedTime : 0) * 2.1;
      _pos.set(
        p.position.x + Math.cos(a) * reach * 0.82,
        0.5 + p.displayRadius * 0.05,
        p.position.z + Math.sin(a) * reach * 0.82
      );
      fx.puff(_pos, POWERUPS.vacuum.color, 2, reach * 0.06, 1.2, 0.30, 0.55);
    }
    if (tur) {
      const vx = p.velocity.x, vz = p.velocity.z;
      const sp = Math.hypot(vx, vz);
      if (sp > 1.5) {
        const r = p.displayRadius;
        _pos.set(p.position.x - (vx / sp) * r * 1.05, 0.25 + r * 0.04,
                 p.position.z - (vz / sp) * r * 1.05);
        fx.puff(_pos, POWERUPS.turbo.color, 2, r * 0.12, 0.8, 0.22 + r * 0.02, 0.4);
      }
    }
  }
}

/**
 * Wire power-ups into a running Game.
 *
 * @param {import('../game.js').Game} game
 * @returns {PowerupSystem} the live system — HUD, minimap and netcode read
 *          activeFor() / nearbyPickups() / serialize() off this. The glue that
 *          owns it hangs off `.glue` for teardown and for the debug overlay.
 */
export function install(game) {
  if (!game || !game.consume) {
    console.error('[powerups] install(game) needs a Game with a ConsumeSystem');
    return null;
  }
  // Idempotent: a second install (hot reload, a test harness) replaces the
  // first instead of stacking two step wrappers on the same game.
  const prev = game.powerups && game.powerups.glue;
  if (prev && typeof prev.uninstall === 'function') prev.uninstall();

  const glue = new PowerupGlue(game).install();
  glue.sys.glue = glue;
  return glue.sys;
}

export { PowerupGlue };
