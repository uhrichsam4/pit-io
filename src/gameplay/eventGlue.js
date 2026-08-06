/**
 * EVENT GLUE — the wiring that makes cityEvents.js and heat.js LIVE.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * cityEvents.js and heat.js are both written to produce DESCRIPTORS AND INTENT
 * and nothing else. Neither one creates a THREE object, touches the HUD, or
 * knows that `game` exists. That is the right architecture and it is also why,
 * on their own, they are invisible: somebody has to turn
 *
 *     env().cloudDarkness          into an actual darker frame
 *     heat.units()                 into actual vehicles you can see and eat
 *     onDebris(items)              into actual Consumables
 *     onBanner / onMarker          into actual UI
 *
 * That somebody is this file. It is the ONLY place in the codebase that knows
 * both "what the event systems want" and "what this renderer actually has".
 *
 * ---------------------------------------------------------------------------
 * THE RULE THIS FILE OBEYS: APPLY ONLY WHAT WAS GREPPED
 * ---------------------------------------------------------------------------
 * This codebase fails SILENTLY on a wrong symbol — a material sweep once turned
 * every road green, and a kerb pass placed ZERO objects for a whole build
 * because it guessed `sidewalk` when the mesh is called `streets-land`. So every
 * external symbol touched below was read out of the file that defines it, and
 * the ones that DO NOT EXIST are listed here rather than guessed at:
 *
 *   VERIFIED AND USED
 *     engine.post.setBiomeGrade(obj|null)   render/postfx.js:394 — the only
 *         grade entry point that SURVIVES the per-frame setLook() the day/night
 *         cycle performs (postfx.js:374 applies the biome AFTER the look). A
 *         one-off write into the grade uniforms is stomped on the next frame;
 *         this is not.
 *     game.map.grade                        game.js:208 — the per-map biome
 *         bias already installed at boot. COMPOSED WITH, never clobbered.
 *     engine.flash(amount, hex)             engine.js:976, decays at 2.6/s in
 *         engine.render() (engine.js:1123). Written ONLY on a strike frame so
 *         it can never zero somebody else's flash.
 *     scene.userData.storm                  published by EventManager itself
 *         (cityEvents.js:698) once `scene` is injected. Nothing reads it yet;
 *         that is the contract channel for whoever builds rain/traffic weather.
 *     effects.puff/shockwave/popup/addShake render/effects.js:365..514
 *     layout.isRoad/isWater/roadsX/roadsZ/blocks   world/cityLayout.js:666,695
 *     registry.add/remove, Consumable       gameplay/entities.js:31,186,215
 *     consume.falling/attracted/respawns    gameplay/consume.js:222..227 —
 *         documented instance fields, purged exhaustively on teardown.
 *     audio.siren(kind,x,z,id) -> {move,stop}       core/audio.js:3077
 *     audio.dispatchChirp(x,z)                      core/audio.js:3135
 *     voice.say(category, {x,z})                    audio/voice.js:852, with
 *         the categories from audio/voicelines.js:283 (policeWarning, heatUp,
 *         heatDown, stormStart, stormEnd).
 *     mode.scoreFor(c)                      gameplay/modes.js:15
 *
 *   VERIFIED ABSENT — SO NOT DONE (see the report, not a TODO in code)
 *     There is no rain/weather renderer, no wetness handle and no traffic
 *     speed knob in this build. streets.js keeps its wet-road materials in a
 *     closure driven off `nightFactor` (streets.js:3314) with no storm input,
 *     and vehicles.js exposes only `trafficUpdate` (vehicles.js:5511) — no
 *     speed scale, no headlight override. So `trafficSpeedScale`,
 *     `pedShelterUrge` and `headlightBias` are published on the descriptor and
 *     left for whoever owns those files. Reaching in and mutating a private
 *     material array from here is exactly the silent-breakage this codebase
 *     keeps getting bitten by.
 *     windForce() is likewise NOT integrated: prop motion lives in
 *     ConsumeSystem's `_dyn` solver, which only flushes a pose for props in its
 *     `attracted` set — an IDLE prop given a wind offset would move in the data
 *     and stand perfectly still on screen. The rain volume below is this file's
 *     own, and is the only geometry the storm gets.
 *
 * ---------------------------------------------------------------------------
 * OWNERSHIP / TEARDOWN
 * ---------------------------------------------------------------------------
 * Everything this file creates, it destroys in `_teardown()`, which runs on
 * every exit from PLAYING and again from a wrapped `resetWorld()`. The audit
 * list is on that method. "No storm state, no units, no timers survive a
 * restart" is a hard requirement, and the only way to keep it true is to have
 * exactly one place that knows the whole list.
 */

import * as THREE from 'three';
import { WORLD } from '../config.js';
import { makeRNG } from '../core/rng.js';
import { audio } from '../core/audio.js';
import { PHASE } from './match.js';
import { Consumable, STATE } from './entities.js';
import { EventManager, TROPICAL_STORM, STORM_LIMITS } from './cityEvents.js';
import { HeatSystem, HEAT, RESPONSE, VOICE_CUES } from './heat.js';
import { POWERUP_ID } from './powerups.js';

/* ========================================================================== *
 * STORM LOOK — how the descriptor maps onto the grade
 *
 * cityEvents caps the DESCRIPTOR (cloudDarkness <= 0.42), but the descriptor is
 * a 0..1 intent, not an f-stop: the renderer decides what 0.42 means. These are
 * that decision, and they are deliberately conservative.
 *
 * The spec's rule is "keep lane markings, holes, rivals and important gameplay
 * objects visible". Lane paint in this city is a near-white emissive line at
 * emissiveIntensity 0.025 in daylight (streets.js:3330) sitting on mid-grey
 * asphalt — the contrast budget between those two is small, and an exposure cut
 * eats it from both ends. A 16% cut at full storm is unmistakably "the sky went
 * dark" in motion while leaving that contrast intact; 40% was a night filter
 * that made the crossings vanish.
 * ========================================================================== */
const STORM_GRADE = {
  /** Multiplied into exposure at full cloud. Floor, not a target. */
  EXPOSURE_CUT: 0.16,
  /** Multiplied into saturation at full cloud. Storms drain colour. */
  SATURATION_CUT: 0.22,
  /** ADDED to temperature (postfx.js:376 adds, it does not multiply). Cool. */
  TEMPERATURE: -0.10,
  /** Re-push the grade only when the normalised darkness moves this much. */
  EPSILON: 0.02,
  /** Lightning tint. Cool white — a warm flash reads as an explosion. */
  FLASH_HEX: 0xdfe9ff,
};

/* ========================================================================== *
 * RAIN — this file's own, because nothing else in the build has one.
 *
 * LineSegments, not Points: a GL point is a screen-aligned square and rain is a
 * streak. Two verts per drop, the streak vector following the fall direction,
 * so the wind visibly slants it. GL line width is pinned to 1px on every real
 * driver, which happens to be exactly right for rain.
 *
 * The buffer is allocated ONCE at RAIN_MAX and the quality tier moves
 * `setDrawRange` — cityEvents' own comment (RAIN_QUALITY, cityEvents.js:204)
 * makes the same point: the budget must not move with the density or a mid-storm
 * quality drop reallocates a GPU buffer in the middle of a match.
 *
 * The volume rides the camera target rather than the world, so 1200 drops cover
 * the visible frame instead of being spread over a 520 m city and never seen.
 * ========================================================================== */
const RAIN = {
  /**
   * THIS RENDERER'S CEILING, whatever the quality tier asks for.
   * RAIN_QUALITY.high requests 2600, but the whole vertex buffer is re-uploaded
   * every frame (needsUpdate is all-or-nothing on a BufferAttribute), and 1600
   * drops is already a downpour at this camera distance. 1600 * 6 floats is a
   * 38 KB upload per frame — less than one small texture — where 2600 was 62 KB
   * for rain nobody could count.
   */
  MAX: 1600,
  /** Volume half-extent in metres, XZ. Comfortably wider than the frame. */
  HALF: 78,
  /** Volume height. Drops wrap modulo this. */
  HEIGHT: 46,
  /** Terminal fall speed, m/s. Real rain is ~9; slower reads as snow. */
  FALL: 26,
  /** Streak length in seconds of travel. 0.045 * 26 = ~1.2 m of streak. */
  STREAK_T: 0.045,
  COLOR: 0xb9d2e0,
  /** Opacity at RAIN_DENSITY_MAX. Above ~0.3 the city starts to grey out. */
  OPACITY: 0.20,
};

/* ========================================================================== *
 * RESPONSE UNIT LOOK
 *
 * heat.js is explicit that `u.mark` is the AUTHORITATIVE telegraph and "the
 * renderer must draw it as a ground decal for its whole lifetime" — the
 * effects.shockwave() it also fires is garnish that silently does nothing when
 * the 24-ring pool is busy, which during a collapse it will be. So the mark
 * decals below are a fixed pool of their own, sized to MAX_UNITS, and they
 * never share with effects.js.
 * ========================================================================== */
const UNIT_COL = {
  BODY: 0xf2f4f7,
  TRIM: 0x1d2b4a,
  GLASS: 0x2a3a52,
  TYRE: 0x14161a,
  LIGHT_A: 0xff3b30,
  LIGHT_B: 0x2f7bff,
  BARRIER: 0xffb01f,
  BARRIER_ALT: 0xf5f5f5,
  FOAM: 0xbfe9ff,
  WARN: 0xffd23f,
  LAMP: 0xfff3c4,
};

/** Lightbar flash rate, Hz. 2.4 is a police bar; faster strobes. */
const LIGHTBAR_HZ = 2.4;

/**
 * Sirens are the loudest recurring thing the mixer makes, and audio.js caps
 * them at SIREN_CAP = 3 internally anyway. Drive at most two, nearest first, so
 * the cap is never the thing making the choice — a cap-driven choice is
 * whichever unit happened to be iterated first, which flickers.
 */
const MAX_SIRENS = 2;
/** Beyond this a siren is inaudible anyway; stop it rather than pay for it. */
const SIREN_RANGE = 170;

/* -------------------------------------------------------------------------- */

const _v = new THREE.Vector3();
const _push = { x: 0, z: 0 };

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* ========================================================================== *
 * VOICE CUE ROUTING
 *
 * heat.js emits its own namespaced cue ids ('cityresp.notice_furniture', …) and
 * documents them as IDs, not categories. VoiceSystem.say() takes a CATEGORY
 * from voicelines.js and returns null for anything else (voice.js:856 —
 * `cutNoLine`), so passing heat's ids straight through would be silent, and
 * silently silent, forever. This is the map, and every target below was read
 * out of CATEGORY_META (voicelines.js:283) and confirmed to have real lines.
 *
 * A cue with no entry here falls back to 'policeWarning', which is the right
 * bucket for anything the response says, so a new cue added to heat.js speaks
 * with a slightly generic line instead of not speaking at all.
 * ========================================================================== */
const CUE_TO_CATEGORY = new Map([
  [VOICE_CUES.NOTICE_FURNITURE, 'heatUp'],
  [VOICE_CUES.ARRIVE_PATROL, 'heatUp'],
  [VOICE_CUES.ARRIVE_RESPONSE, 'heatUp'],
  [VOICE_CUES.ALL_CLEAR, 'heatDown'],
  [VOICE_CUES.STAND_DOWN, 'heatDown'],
  [VOICE_CUES.NOTICE_PARKING, 'policeWarning'],
  [VOICE_CUES.WARN_PLAZA, 'policeWarning'],
  [VOICE_CUES.NEED_BIGGER, 'policeWarning'],
  [VOICE_CUES.LOST_VEHICLE, 'policeWarning'],
  [VOICE_CUES.PULSE_CHARGE, 'policeWarning'],
  [VOICE_CUES.PULSE_HIT, 'policeWarning'],
  [VOICE_CUES.PULSE_MISS, 'policeWarning'],
]);

/* ========================================================================== *
 * EventGlue
 * ========================================================================== */

export class EventGlue {
  /**
   * @param {object} game the live Game instance. Must already have `layout`,
   *   `engine`, `effects`, `consume`, `registry`, `hud` and `map` — i.e. call
   *   install() late in Game.init(), not from the constructor.
   */
  constructor(game) {
    this.game = game;
    this.scene = game.engine ? game.engine.scene : null;

    /* --- HUD channels. Assign these; this file imports no UI module. -------
     * Set either one and it OWNS presentation for that channel — the fallback
     * below stops firing, so an orchestrator that builds a proper banner strip
     * does not get a duplicate line in the kill feed underneath it. */
    /** @type {null|(payload:object)=>void} */
    this.onBanner = null;
    /** @type {null|(marker:object|null)=>void} */
    this.onMarker = null;
    /** Last marker raised, for a HUD that would rather poll than subscribe. */
    this.marker = null;

    /**
     * The PowerupSystem, if the orchestrator wants to wire it explicitly.
     * Left null it is duck-probed off the game object each time it is needed;
     * see _hasVacuum(). Never guessed at — a miss just means the containment
     * penalty takes score instead of jamming the boost, which is heat.js's own
     * documented fallback.
     */
    this.powerups = null;

    /**
     * Which mode ids may auto-schedule a major event. null = all of them.
     * The scheduler already refuses any match too short to fit the event plus
     * its tail (cityEvents.plan), so Rush Hour opts itself out; this exists for
     * a designer who wants to narrow it further without editing this file.
     */
    this.stormModes = null;

    /* --- the two systems ------------------------------------------------- */
    this.events = new EventManager({
      rng: this._seed(0x45564e54),          // 'EVNT'
      layout: game.layout || null,
      effects: game.effects || null,
      audio,
      /* Publishing to scene.userData.storm is the whole reason `scene` is
         injected: it is the convention every content module already reads its
         cross-cutting inputs from (nightFactor, timeOfDay, sunDir), so a rain
         or traffic-weather pass can consume the storm without importing
         gameplay code or threading a reference through worldBuild. */
      scene: this.scene,
      validate: (x, z) => this._debrisSpotOk(x, z),
    });
    this.events.onBanner = (p) => this._banner(p);
    this.events.onMarker = (m) => this._marker(m);
    this.events.onDebris = (items) => this._syncDebris(items);

    this.heat = new HeatSystem({
      rng: this._seed(0x48454154),          // 'HEAT'
      layout: game.layout || null,
      effects: game.effects || null,
      audio,
      /* NOT game.voice directly: heat speaks in cue ids and VoiceSystem speaks
         in categories. See CUE_TO_CATEGORY. */
      voice: { say: (id, opts) => this._sayCue(id, opts) },
      hud: game.hud || null,
      hasVacuum: (hole) => this._hasVacuum(hole),
      inPlay: (x, z) => this._inPlay(x, z),
    });

    /* --- runtime state, all of it torn down in _teardown() --------------- */
    /** @type {{c:Consumable, itemId:string}[]} live storm debris. */
    this._debris = [];
    /** Consumable -> debris item id, for the claim on swallow. */
    this._debrisOf = new Map();
    /** unit id -> view. */
    this._unitViews = new Map();
    /** kind -> [view], recycled. Bounded by HEAT.MAX_UNITS in practice. */
    this._viewPool = new Map();
    /** Rounds played since install; part of the offline RNG seed. */
    this._matchIndex = 0;
    /** Consecutive update() throws. Three and the glue disarms for good. */
    this._crashes = 0;
    /** unit id -> siren loop handle */
    this._sirens = new Map();
    /** Pooled ground decals for u.mark. */
    this._marks = [];
    /** Shared geometry/material templates, built lazily, disposed on dispose(). */
    this._templates = new Map();
    this._owned = { geo: [], mat: [] };
    this._rain = null;
    this._rainPhase = 0;

    this._gradeK = -1;          // last normalised darkness pushed to the grade
    this._gradeBase = null;     // the map's own biome grade, captured at arm()
    this._phase = null;
    this._armed = false;
    this._purgeAt = 0;
    this._installed = false;

    /* Wrapped originals, kept so uninstall() can put them back. */
    this._prevStep = null;
    this._prevReset = null;
    this._prevSwallow = null;
  }

  /* ---------------------------------------------------------------- setup -- */

  /**
   * Deterministic per-room RNG that does NOT draw from `game.rng`.
   *
   * game.rng is the city stream: _spawnPoint(salt 0) and spawnBots() both pull
   * from it, and every client in a room walks it in lockstep. Taking even one
   * draw from it here would shift every later draw for everybody, which is a
   * desync with no symptom until two players are standing in different places.
   *
   * Online the seed is the world seed alone, so every client agrees on when the
   * storm lands without a packet. Offline it also mixes in the match count, so
   * a second solo round is not a rerun of the first.
   */
  _seed(tag) {
    const g = this.game;
    const world = (g.worldSeed ?? 0) >>> 0;
    const nth = g.net ? 0 : Math.imul(this._matchIndex | 0, 0x9e3779b1);
    return makeRNG((world ^ tag ^ nth) >>> 0);
  }

  /**
   * Wrap the three seams this needs, on the INSTANCE. Nothing in game.js is
   * edited; an instance property shadows the prototype method, and
   * Game.frame() calls `this.stepSimulation(dt)`, so the wrapper is what runs.
   */
  install() {
    if (this._installed) return this;
    this._installed = true;
    const g = this.game;

    const step = g.stepSimulation.bind(g);
    this._prevStep = g.stepSimulation;
    g.stepSimulation = (dt) => {
      step(dt);
      /* AFTER the sim: holes have already moved this frame, so a response unit
         intercepts where the player IS, not where they were, and a debris
         Consumable created this frame is never queried before it is registered. */
      if (this._crashes >= 3) return;
      try { this.update(dt); this._crashes = 0; }
      catch (err) { this._crashes++; console.error('[eventGlue] update failed', err); this._panic(); }
    };

    /* resetWorld() runs at the top of startMatch(), BEFORE match.start() flips
       the phase. Belt and braces against the one ordering that could leave a
       storm crate standing in a freshly reset city. */
    const reset = g.resetWorld.bind(g);
    this._prevReset = g.resetWorld;
    g.resetWorld = () => { this._teardown(); return reset(); };

    /* WRAP, NEVER REPLACE. game.js's handler carries _voiceFor, the net report,
       the kill feed, the occlusion re-arm, the match stats, the challenge
       tracker and the chomp/crumble audio. Calling it first also means heat
       sees the swallow in the same order as everything else. */
    const prev = g.consume.onSwallow;
    this._prevSwallow = prev;
    g.consume.onSwallow = (hole, c, gained, remote) => {
      if (prev) prev(hole, c, gained, remote);
      this._onSwallow(hole, c, gained, remote);
    };

    return this;
  }

  /** Put game.js back the way it was and destroy everything this made. */
  uninstall() {
    if (!this._installed) return;
    this._installed = false;
    const g = this.game;
    if (this._prevStep) g.stepSimulation = this._prevStep;
    if (this._prevReset) g.resetWorld = this._prevReset;
    g.consume.onSwallow = this._prevSwallow || null;
    this._prevStep = this._prevReset = this._prevSwallow = null;
    this.dispose();
  }

  /**
   * Last resort: a throw inside update() must not take the match loop down.
   * Tear down whatever was half-built, and after three consecutive failures the
   * wrapper stops calling update() at all — a system that crashes every frame
   * floods the console and costs more than the feature is worth.
   */
  _panic() {
    try { this._teardown(); } catch (err) { void err; }
    this._armed = false;
    if (this._crashes >= 3) console.error('[eventGlue] disarmed after 3 failures');
  }

  /* ---------------------------------------------------------------- frame -- */

  update(dt) {
    const g = this.game;
    const phase = g.match ? g.match.phase : null;

    if (phase !== this._phase) {
      const was = this._phase;
      this._phase = phase;
      const live = phase === PHASE.PLAYING || phase === PHASE.COUNTDOWN;
      const wasLive = was === PHASE.PLAYING || was === PHASE.COUNTDOWN;
      if (live && !wasLive) this._arm();
      else if (!live && wasLive) this._teardown();
    }

    /* dt is 0 while paused (Game.loop clamps it), and the island is a movement
       sandbox with no match clock, no bots and nothing edible — no city
       response and no weather belong in either. */
    if (!(dt > 0) || phase !== PHASE.PLAYING || g.onIsland) return;
    if (!this._armed) this._arm();

    const holes = g.holes || [];

    /* --- events ---------------------------------------------------------- */
    this.events.update(dt, {
      elapsed: g.match.elapsed,
      duration: g.matchDuration,
      holes,
      player: g.player || null,
    });
    this._applyStorm(this.events.env(), dt);

    /* --- heat ------------------------------------------------------------ *
     * No `t` argument on purpose: HeatSystem accumulates its own clock from dt
     * (heat.js:626), which means it freezes with the pause instead of finding
     * that eight seconds of telegraph deadline elapsed while the menu was up. */
    this.heat.update(dt, holes);
    this._applyBarrierNudge(dt, holes);
    this._syncUnits(dt);
    this._syncMarks();
    this._syncSirens();

    /* Debris that has been eaten is queued for respawn by ConsumeSystem like
       any other prop. A storm crate reappearing under a clear sky is exactly
       the "unreset world state" the spec forbids, so the queue is swept. Once
       a second, and only while debris exists. */
    if (this._debris.length && g.clock.elapsedTime >= this._purgeAt) {
      this._purgeAt = g.clock.elapsedTime + 1;
      this._purgeRespawns();
    }
  }

  /* --------------------------------------------------------- match seams -- */

  _arm() {
    if (this._armed) return;
    /* Always tear down first. A crashed round, a mode switch or a rejoin can
       all reach this with residue, and "arm" must mean "from nothing". */
    this._teardown();
    this._armed = true;
    this._matchIndex = (this._matchIndex | 0) + 1;

    const g = this.game;

    /* The world is built long before install() is called in the normal flow,
       but a harness can construct the glue early. Re-point rather than fail. */
    if (!this.events.layout && g.layout) this.events.layout = g.layout;
    if (!this.heat.layout && g.layout) this.heat.layout = g.layout;
    if (!this.events.effects && g.effects) this.events.effects = g.effects;
    if (!this.heat.effects && g.effects) this.heat.effects = g.effects;
    if (!this.heat.hud && g.hud) this.heat.hud = g.hud;
    if (!this.events.scene && this.scene) this.events.scene = this.scene;

    /* Fresh, deterministic streams for this round. */
    this.events.rng = this._seed(0x45564e54);
    this.heat.rng = this._seed(0x48454154);

    const modeId = g.mode && g.mode.id;
    this.events.schedule.enabled =
      !this.stormModes || !modeId || this.stormModes.includes(modeId);

    /* The map's own colour bias, captured so the storm composes with it instead
       of replacing it. Snowfall City ships one (maps.js:48); Miami does not. */
    this._gradeBase = (g.map && g.map.grade) || null;
    this._gradeK = -1;
  }

  /**
   * EXHAUSTIVE TEARDOWN. The audit list, in the order things were made:
   *
   *   1. the running event + its audio beds  -> events.clearAll() (which stops
   *      every loop on every exit path — that is its stated invariant)
   *   2. scene.userData.storm                -> neutral, kept not deleted
   *   3. debris Consumables                  -> out of the registry, out of
   *      consume.falling / .attracted / .respawns, out of the scene
   *   4. heat state, units, cue timers       -> heat.clearAll()
   *   5. unit meshes                         -> out of the scene, pooled
   *   6. sirens and every other audio loop   -> stopped
   *   7. mark decals                         -> hidden
   *   8. the rain volume                     -> hidden and rewound
   *   9. the storm grade                     -> the map's own grade restored
   *  10. the marker                          -> onMarker(null)
   *
   * Safe to call twice, and safe to call before anything was ever armed.
   */
  _teardown() {
    this._armed = false;

    /* 1 + 2. clearAll also fires onDebris([]) via stop(), which lands in
       _syncDebris and does step 3 for us — but call it explicitly too, because
       a debris list can outlive an event that was already stopped. */
    try { this.events.clearAll(); } catch (err) { console.warn('[eventGlue] events.clearAll', err); }
    this._clearDebris();

    /* 4. */
    try { this.heat.clearAll(); } catch (err) { console.warn('[eventGlue] heat.clearAll', err); }

    /* 5. */
    for (const view of this._unitViews.values()) this._retireView(view);
    this._unitViews.clear();

    /* 6. Every siren this file started, by handle.
       DELIBERATELY NOT audio.stopAllLoops(): that is the verified sledgehammer
       and it would also cut the power-up beds another module owns. Every siren
       handle is held in this map from the frame it starts — _syncUnits stops
       and forgets one the instant its unit leaves heat.units() — so the map is
       the complete set and there is nothing for a sweep to find. */
    for (const h of this._sirens.values()) { try { h.stop(0.35); } catch (err) { void err; } }
    this._sirens.clear();
    if (typeof audio.loopCount === 'function' && audio.loopCount('siren:') > 0) {
      console.warn('[eventGlue] a siren outlived its handle — investigate, do not sweep');
    }

    /* 7. */
    for (const m of this._marks) m.visible = false;

    /* 8. */
    if (this._rain) { this._rain.visible = false; this._rain.geometry.setDrawRange(0, 0); }
    this._rainPhase = 0;

    /* 9. */
    this._restoreGrade();

    /* 10. */
    this._marker(null);
  }

  /** Release every GPU resource this file owns. For a full page teardown. */
  dispose() {
    this._teardown();
    for (const view of this._unitViews.values()) this._retireView(view);
    this._unitViews.clear();
    for (const pool of this._viewPool.values()) {
      for (const v of pool) { if (v.group.parent) v.group.parent.remove(v.group); }
      pool.length = 0;
    }
    this._viewPool.clear();
    for (const m of this._marks) { if (m.parent) m.parent.remove(m); }
    this._marks.length = 0;
    if (this._rain) {
      if (this._rain.parent) this._rain.parent.remove(this._rain);
      this._rain.geometry.dispose();
      this._rain.material.dispose();
      this._rain = null;
    }
    for (const g of this._owned.geo) g.dispose();
    for (const m of this._owned.mat) m.dispose();
    this._owned.geo.length = 0;
    this._owned.mat.length = 0;
    this._templates.clear();
  }

  /* ------------------------------------------------------------- channels -- */

  _banner(payload) {
    if (!payload) return;
    /* Dialogue rides the banner because that is the exact moment the event is
       announced. VoiceSystem owns ALL the rate limiting — per-category, per
       line, per cast, a global start gap, a burst damper and a hard three-line
       concurrency cap — so this just says what happened and lets it drop what
       it cannot afford. */
    if (payload.id === TROPICAL_STORM.id) {
      if (payload.kind === 'start') this._say('stormStart');
      else if (payload.kind === 'end') this._say('stormEnd');
    }

    if (typeof this.onBanner === 'function') { this.onBanner(payload); return; }

    /* Fallback so the feature is visible with no orchestrator work at all.
       'clear' is the teardown ping and has no message; never show it. */
    if (payload.kind === 'clear') return;
    const hud = this.game.hud;
    if (!hud || !hud.pushFeed) return;
    const secs = payload.seconds > 0 ? ` — ${Math.round(payload.seconds)}s` : '';
    const sub = payload.sub ? ` <i>${payload.sub}</i>` : '';
    hud.pushFeed(
      `${payload.icon || ''} <b>${payload.message || payload.name || ''}</b>${secs}${sub}`,
      payload.color || '#5fd8ff',
      'event',
    );
  }

  _marker(m) {
    this.marker = m || null;
    if (typeof this.onMarker === 'function') this.onMarker(this.marker);
  }

  /* ----------------------------------------------------------------- voice -- */

  /** Speak a VoiceSystem CATEGORY at a world point (defaults to the player). */
  _say(category, x, z) {
    const g = this.game;
    const v = g.voice;
    if (!v || typeof v.say !== 'function') return null;
    const p = g.player && g.player.position;
    const px = Number.isFinite(x) ? x : (p ? p.x : 0);
    const pz = Number.isFinite(z) ? z : (p ? p.z : 0);
    return v.say(category, { x: px, z: pz });
  }

  /** heat.js cue id -> VoiceSystem category. See CUE_TO_CATEGORY. */
  _sayCue(id, opts) {
    const cat = CUE_TO_CATEGORY.get(id) || 'policeWarning';
    const o = opts || {};
    return this._say(cat, o.x, o.z);
  }

  /* ------------------------------------------------------------- swallow --- */

  _onSwallow(hole, c, gained, remote) {
    if (!hole || !c) return;

    /* Heat. Cheap by contract (heat.js:456: no effects, no audio, no
       allocation) because a late-game hole captures hundreds of props in one
       frame and this sits directly in that path. */
    this.heat.onConsumed(hole, c);

    /* Storm debris: cityEvents pays a CLUSTER COMPLETION BONUS, and only that.
       The item's own points were carried by the real Consumable and already
       paid by ConsumeSystem._capture, which is the only legitimate path. */
    const itemId = this._debrisOf.get(c);
    if (itemId !== undefined) {
      this._debrisOf.delete(c);
      const bonus = this.events.claim(itemId, hole);
      if (bonus > 0 && typeof hole.addScore === 'function') {
        hole.addScore(bonus, TROPICAL_STORM.rewards.bonusLabel);
        const fx = this.game.effects;
        if (fx && hole.isPlayer) {
          _v.set(hole.position.x, 1.6, hole.position.z);
          fx.popup(_v, `+${bonus} ${TROPICAL_STORM.rewards.bonusLabel}`, 0x5fd8ff, true);
        }
        const hud = this.game.hud;
        if (hud && hud.pushFeed && hole.isPlayer) {
          hud.pushFeed(`<b>STORM HAUL</b> — cluster cleared, +${bonus}`, '#5fd8ff', 'event');
        }
      }
    }
    void gained; void remote;
  }

  /* ---------------------------------------------------------------- storm -- */

  /**
   * Map the descriptor onto the handles this renderer actually has.
   * Everything here is guarded: a missing method costs the effect and nothing
   * else, which is the only acceptable failure mode mid-match.
   */
  _applyStorm(env, dt) {
    if (!env) return;

    /* --- grade ----------------------------------------------------------- */
    const k = STORM_LIMITS.CLOUD_DARKNESS_MAX > 0
      ? clamp(env.cloudDarkness / STORM_LIMITS.CLOUD_DARKNESS_MAX, 0, 1)
      : 0;
    if (Math.abs(k - this._gradeK) > STORM_GRADE.EPSILON || (k === 0 && this._gradeK > 0)) {
      this._gradeK = k;
      this._pushGrade(k);
    }

    /* --- lightning ------------------------------------------------------- *
     * ONLY on the strike frame. engine.flash() is a write, not an add, and it
     * decays on its own at 2.6/s inside engine.render(); writing it every frame
     * would stomp the tier-6 swallow flash and the devour flash that game.js
     * fires through the same uniform. */
    if (env.strike && env.lightningFlash > 0) {
      const eng = this.game.engine;
      if (eng && typeof eng.flash === 'function') {
        eng.flash(Math.min(env.lightningFlash, STORM_LIMITS.LIGHTNING_FLASH_MAX),
          STORM_GRADE.FLASH_HEX);
      }
    }
    /* Thunder shake and the thunder sting are cityEvents' own — it holds the
       effects and audio references and fires both at the strike. Not repeated
       here; two shakes per bolt is a bug, not twice the drama. */

    /* --- rain ------------------------------------------------------------ */
    this._updateRain(env, dt);
  }

  /** Compose the storm bias over the map's own grade and install it. */
  _pushGrade(k) {
    const post = this.game.engine && this.game.engine.post;
    if (!post || typeof post.setBiomeGrade !== 'function') return;
    const base = this._gradeBase;
    if (k <= 0) { post.setBiomeGrade(base || null); return; }

    /* Start from a COPY of the map's grade so shadowTint / highlightTint /
       contrast survive untouched — those are the snow look, and a storm has no
       business editing them. */
    const g = base ? { ...base } : {};
    g.exposure = (base && base.exposure != null ? base.exposure : 1)
      * (1 - STORM_GRADE.EXPOSURE_CUT * k);
    g.saturation = (base && base.saturation != null ? base.saturation : 1)
      * (1 - STORM_GRADE.SATURATION_CUT * k);
    /* postfx.js:376 ADDS temperature. Adding to the map's own offset is right:
       a storm over Snowfall City is colder still. */
    g.temperature = (base && base.temperature != null ? base.temperature : 0)
      + STORM_GRADE.TEMPERATURE * k;
    post.setBiomeGrade(g);
  }

  _restoreGrade() {
    if (this._gradeK <= 0) { this._gradeK = -1; return; }
    this._gradeK = -1;
    const post = this.game.engine && this.game.engine.post;
    if (post && typeof post.setBiomeGrade === 'function') {
      post.setBiomeGrade(this._gradeBase || null);
    }
  }

  /* ----------------------------------------------------------------- rain -- */

  _ensureRain() {
    if (this._rain) return this._rain;
    const n = RAIN.MAX;
    const pos = new Float32Array(n * 6);          // 2 verts per drop
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({
      color: RAIN.COLOR,
      transparent: true,
      opacity: 0,
      /* depthWrite off so drops never punch a hole in the transparent sorting
         of everything behind them; depthTest ON so rain is correctly hidden
         by the building it is falling behind. */
      depthWrite: false,
      fog: true,
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.name = 'storm-rain';
    /* The volume is re-centred on the camera target every frame, so a frustum
       test against a stale bounding sphere would pop it in and out. */
    lines.frustumCulled = false;
    lines.visible = false;
    lines.renderOrder = 4;
    /* Seed the drop cloud once. `_d` holds the per-drop offsets INSIDE the
       volume; the object's own transform carries it to the camera. */
    const rng = makeRNG(0x5241494e);              // 'RAIN'
    const d = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      d[i * 3] = rng.range(-RAIN.HALF, RAIN.HALF);
      d[i * 3 + 1] = rng.range(0, RAIN.HEIGHT);
      d[i * 3 + 2] = rng.range(-RAIN.HALF, RAIN.HALF);
    }
    lines.userData.drops = d;
    if (this.scene) this.scene.add(lines);
    this._rain = lines;
    return lines;
  }

  _updateRain(env, dt) {
    const density = env.rainDensity || 0;
    if (density <= 0.001) {
      if (this._rain && this._rain.visible) {
        this._rain.visible = false;
        this._rain.geometry.setDrawRange(0, 0);
      }
      return;
    }
    const lines = this._ensureRain();
    /* rainBudget is the HARD instance cap for the current quality tier and does
       NOT move with the density — cityEvents allocates the two separately on
       purpose so a mid-storm tier drop never resizes a buffer. */
    const budget = Math.min(RAIN.MAX, Math.max(0, env.rainBudget | 0));
    const count = Math.min(budget, Math.round(budget * clamp(density / STORM_LIMITS.RAIN_DENSITY_MAX, 0, 1)));
    if (count <= 0) {
      lines.visible = false;
      lines.geometry.setDrawRange(0, 0);
      return;
    }

    const eng = this.game.engine;
    const centre = eng && eng._camTarget ? eng._camTarget : null;
    lines.position.set(centre ? centre.x : 0, 0, centre ? centre.z : 0);

    /* Wind slants the streak and drifts the column. windVec is m/s and capped
       at WIND_SPEED_MAX (13), so the slant tops out around 26 degrees. */
    const wx = env.windVec ? env.windVec.x : 0;
    const wz = env.windVec ? env.windVec.z : 0;
    this._rainPhase = (this._rainPhase + dt) % 1e6;

    const d = lines.userData.drops;
    const p = lines.geometry.attributes.position.array;
    const fall = RAIN.FALL;
    const sx = wx * RAIN.STREAK_T;
    const sy = fall * RAIN.STREAK_T;
    const sz = wz * RAIN.STREAK_T;
    const H = RAIN.HEIGHT;
    const drift = this._rainPhase;
    const span = RAIN.HALF * 2;

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      /* Position is DERIVED from a per-drop constant plus the shared clock, not
         integrated. An integrated cloud accumulates float error over a 52 s
         storm and, worse, cannot be rewound — this one is exact after any
         pause, any hitch and any teardown. */
      const y = H - ((d[i3 + 1] + drift * fall) % H);
      let x = d[i3] + wx * drift;
      let z = d[i3 + 2] + wz * drift;
      /* Wrap the drifted column back into the box, or the wind blows the whole
         cloud off the side of the frame within ten seconds. */
      x = ((x + RAIN.HALF) % span + span) % span - RAIN.HALF;
      z = ((z + RAIN.HALF) % span + span) % span - RAIN.HALF;
      const o = i * 6;
      p[o] = x; p[o + 1] = y; p[o + 2] = z;
      p[o + 3] = x - sx; p[o + 4] = y + sy; p[o + 5] = z - sz;
    }
    lines.geometry.attributes.position.needsUpdate = true;
    lines.geometry.setDrawRange(0, count * 2);
    lines.material.opacity = RAIN.OPACITY
      * clamp(density / STORM_LIMITS.RAIN_DENSITY_MAX, 0, 1);
    lines.visible = true;
  }

  /* --------------------------------------------------------------- debris -- */

  /**
   * THE DEBRIS VALIDATOR handed to EventManager.
   *
   * Deliberately NOT game._validateSpawn: that answers "may a HOLE open here",
   * which demands six starter props within 30 m and rejects anything within
   * 3 m of an object — the second of those rejects exactly the interesting
   * spots for a crate. cityEvents re-checks water, bounds and roads itself
   * regardless, so this only adds what it cannot know: the shrink ring and the
   * bay margin the rest of the game uses.
   */
  _debrisSpotOk(x, z) {
    if (x > WORLD.BAY_EDGE - 12) return false;
    return this._inPlay(x, z);
  }

  /** Inside the playable ring, if one is up. Shared by debris and unit spawns. */
  _inPlay(x, z) {
    const ring = this.game.shrink;
    if (!ring || !ring.radius) return true;
    /* 0.9 rather than _validateSpawn's 0.72: a hole must respawn with room to
       run, but a crate or a patrol car only has to be inside the line. */
    return Math.hypot(x - ring.cx, z - ring.cz) <= ring.radius * 0.9;
  }

  /**
   * cityEvents hands over VALIDATED POSITIONS at landfall and an empty list at
   * the end. It never makes a mesh; this does.
   */
  _syncDebris(items) {
    this._clearDebris();
    if (!items || !items.length) return;
    const g = this.game;
    if (!g.registry || !this.scene) return;

    const scoreFor = g.mode && typeof g.mode.scoreFor === 'function' ? g.mode.scoreFor : null;
    let made = 0;
    for (const it of items) {
      const object = this._debrisMesh(it);
      if (!object) continue;
      object.position.set(it.x, it.y, it.z);
      object.rotation.y = it.rotationY || 0;

      const c = new Consumable({
        object,
        position: object.position,
        radius: it.radius,
        height: it.height,
        passRadius: it.passRadius,
        tier: it.tier,
        score: it.score,
        rotationY: it.rotationY,
        kind: it.kind,
        label: it.label,
        debrisColor: 0xbfa77a,
      });
      /* Modes rescore the whole city at match start (game.js:851) off the same
         one-argument scoreFor(c). Debris is created mid-match and is not in
         allConsumables, so it has to ask for itself — otherwise a Car Crunch
         round has a vendor cart worth full points next to a bench worth zero. */
      if (scoreFor) {
        let v;
        try { v = scoreFor(c); } catch { v = c.score; }
        c.score = Math.max(0, Math.round(Number(v) || 0));
      }

      this.scene.add(object);
      g.registry.add(c);
      this._debris.push(c);
      this._debrisOf.set(c, it.id);
      made++;

      const fx = g.effects;
      if (fx) {
        _v.set(it.x, Math.max(0.2, it.height * 0.4), it.z);
        fx.puff(_v, 0xcfd8dc, 5, Math.max(0.35, it.radius * 0.8), 2.0, 0.3, 0.45);
      }
    }
    console.info(`[eventGlue] storm debris: ${made}/${items.length} placed`);
  }

  /**
   * Retire every debris Consumable, whatever state it is in.
   *
   * FOUR STATES, FOUR HOMES, and missing any one of them leaves a phantom:
   *   IDLE / WOBBLE -> in registry.cells, possibly in consume.attracted
   *   FALLING       -> in consume.falling, already out of the registry
   *   GONE          -> in consume.respawns, already out of the registry
   * registry.remove() early-returns on an id it does not hold, so it is safe to
   * call unconditionally.
   */
  _clearDebris() {
    if (!this._debris.length) { this._debrisOf.clear(); return; }
    const g = this.game;
    const cs = g.consume;
    const mine = new Set(this._debris);

    for (const c of this._debris) {
      if (g.registry) g.registry.remove(c);
      if (cs) {
        cs.attracted.delete(c);
        const fi = cs.falling.indexOf(c);
        if (fi >= 0) cs.falling.splice(fi, 1);
      }
      if (c.object) {
        if (c.object.parent) c.object.parent.remove(c.object);
        c.object.visible = true;      // pooled clones are reused; leave them clean
      }
      c.state = STATE.GONE;
    }
    if (cs && cs.respawns.length) {
      for (let i = cs.respawns.length - 1; i >= 0; i--) {
        if (mine.has(cs.respawns[i].c)) cs.respawns.splice(i, 1);
      }
    }
    this._debris.length = 0;
    this._debrisOf.clear();
  }

  /** Keep eaten debris out of the respawner while the storm is still running. */
  _purgeRespawns() {
    const cs = this.game.consume;
    if (!cs || !cs.respawns.length) return;
    const mine = new Set(this._debris);
    for (let i = cs.respawns.length - 1; i >= 0; i--) {
      const c = cs.respawns[i].c;
      if (!mine.has(c)) continue;
      cs.respawns.splice(i, 1);
      if (c.object && c.object.parent) c.object.parent.remove(c.object);
      const di = this._debris.indexOf(c);
      if (di >= 0) this._debris.splice(di, 1);
      this._debrisOf.delete(c);
    }
  }

  /* ----------------------------------------------------------------- heat -- */

  /**
   * Barriers lean the hole away from a protected plaza.
   *
   * APPLIED POSITIONALLY, not to velocity, and heat.js says why: Hole.update
   * lerps velocity toward desiredDir * speed every frame with
   * k = 1 - exp(-ACCEL*dt), so a velocity nudge is erased within a couple of
   * frames and would do precisely nothing. Capped at NUDGE_MAX (1.6 m/s against
   * a 19.5 m/s hole — about 8%), so the player wins every argument.
   */
  _applyBarrierNudge(dt, holes) {
    if (!this.heat.units().length) return;
    /* Online, remote holes are interpolated from the server every frame and
       nudging one just fights the interpolator for a frame and loses. The
       server is the authority on where a peer is; this only leans the hole this
       client actually owns. */
    const localOnly = !!this.game.net;
    for (const h of holes) {
      if (!h || h.alive === false || h.spawnGrace > 0) continue;
      if (localOnly && !h.isPlayer) continue;
      this.heat.steerAt(h.position.x, h.position.z, _push);
      if (_push.x === 0 && _push.z === 0) continue;
      h.position.x += _push.x * dt;
      h.position.z += _push.z * dt;
    }
  }

  /**
   * Is Vacuum Boost live on this hole?
   *
   * The PowerupSystem is wired into game.js by a different pass and this file
   * must not guess its field name — a wrong name here is silent forever. So:
   * an explicit `glue.powerups` if the orchestrator set one, otherwise a
   * DUCK-TYPED probe over the plausible fields, accepting only an object that
   * actually has isActive(). A miss returns false, and heat.js's documented
   * fallback is to take capped score instead of jamming the boost — a worse
   * consequence, not a broken one.
   */
  _hasVacuum(hole) {
    const p = this._powerupSystem();
    if (!p) return false;
    try { return !!p.isActive(hole, POWERUP_ID.VACUUM); }
    catch (err) { void err; return false; }
  }

  _powerupSystem() {
    if (this.powerups && typeof this.powerups.isActive === 'function') return this.powerups;
    const g = this.game;
    for (const cand of [g.powerups, g.powerupSystem, g._powerups]) {
      if (cand && typeof cand.isActive === 'function') { this.powerups = cand; return cand; }
    }
    return null;
  }

  /* ------------------------------------------------------- unit rendering -- */

  _syncUnits(dt) {
    const units = this.heat.units();
    const views = this._unitViews;

    /* Retire views whose unit is gone. heat.js splices dead units out of the
       array it hands back, so absence from it IS the death signal. */
    if (views.size) {
      const live = new Set();
      for (const u of units) live.add(u.id);
      for (const [id, view] of views) {
        if (live.has(id)) continue;
        this._retireView(view);
        views.delete(id);
        const s = this._sirens.get(id);
        if (s) { try { s.stop(0.5); } catch (err) { void err; } this._sirens.delete(id); }
      }
    }

    const t = this.game.clock ? this.game.clock.elapsedTime : 0;
    for (const u of units) {
      let view = views.get(u.id);
      if (!view) {
        view = this._takeView(u.kind);
        if (!view) continue;
        views.set(u.id, view);
        if (this.scene) this.scene.add(view.group);
      }
      const g = view.group;
      g.visible = true;
      g.position.set(u.x, 0, u.z);
      g.rotation.y = u.yaw || 0;

      /* Lightbar. A free-running phase per unit (heat.js seeds u.siren from its
         own RNG) so six cruisers do not flash in lockstep like one object. */
      if (view.lampA && view.lampB) {
        const beat = Math.sin((t * LIGHTBAR_HZ + u.siren) * Math.PI * 2);
        const on = u.state !== 'leaving' && u.state !== 'devoured';
        view.lampA.material.emissiveIntensity = on && beat > 0 ? 3.2 : 0.05;
        view.lampB.material.emissiveIntensity = on && beat <= 0 ? 3.2 : 0.05;
      }
      /* A charging containment pulse gets a visible tell on the unit itself,
         not only on the ground decal — colour is never the only cue. */
      if (view.charge) {
        const warn = u.warnT > 0;
        view.charge.visible = warn;
        if (warn) {
          const k = 1 - clamp(u.warnT / HEAT.WARN_T, 0, 1);
          view.charge.scale.setScalar(0.5 + 0.9 * k);
        }
      }
    }
    void dt;
  }

  /**
   * A body for this kind, recycled if one is free.
   *
   * POOLED, not rebuilt: a tier-3 roster cycles units all match, and each build
   * mints two new lightbar materials (they cannot be shared — the whole point
   * of the per-unit `siren` phase is that six cruisers do NOT flash in
   * lockstep). Unpooled, that is an unbounded material list and an unbounded
   * `_owned.mat` array by the end of a long round.
   */
  _takeView(kind) {
    const free = this._viewPool.get(kind);
    if (free && free.length) return free.pop();
    return this._buildView(kind);
  }

  _retireView(view) {
    if (!view) return;
    view.group.visible = false;
    if (view.group.parent) view.group.parent.remove(view.group);
    if (view.charge) view.charge.visible = false;
    const kind = view.kind;
    let free = this._viewPool.get(kind);
    if (!free) { free = []; this._viewPool.set(kind, free); }
    /* Bounded: the roster can never want more than MAX_UNITS at once, so a pool
       deeper than that is dead memory. */
    if (free.length < HEAT.MAX_UNITS && free.indexOf(view) < 0) free.push(view);
  }

  /* ---- ground decals for u.mark ---------------------------------------- */

  _syncMarks() {
    const units = this.heat.units();
    let n = 0;
    const t = this.game.clock ? this.game.clock.elapsedTime : 0;
    for (const u of units) {
      if (!u.mark || u.warnT <= 0) continue;
      const decal = this._mark(n++);
      if (!decal) break;
      decal.visible = true;
      decal.position.set(u.mark.x, 0.05, u.mark.z);
      decal.scale.setScalar(u.mark.r || HEAT.PULSE_R);
      /* Urgency reads as RATE, not just brightness: the pulse speeds up as the
         deadline closes, which is legible in peripheral vision and to anyone
         who cannot rely on the colour. */
      const k = 1 - clamp(u.warnT / HEAT.WARN_T, 0, 1);
      const hz = 2 + 6 * k;
      decal.material.opacity = 0.30 + 0.45 * (0.5 + 0.5 * Math.sin(t * hz * Math.PI * 2));
    }
    for (let i = n; i < this._marks.length; i++) this._marks[i].visible = false;
  }

  _mark(i) {
    if (i >= HEAT.MAX_UNITS) return null;
    let m = this._marks[i];
    if (m) return m;
    /* Unit radius, scaled per use — one geometry for every marker. */
    const geo = new THREE.RingGeometry(0.86, 1.0, 48, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: UNIT_COL.WARN,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this._owned.geo.push(geo);
    this._owned.mat.push(mat);
    m = new THREE.Mesh(geo, mat);
    m.name = 'containment-mark';
    m.frustumCulled = false;
    m.renderOrder = 3;
    m.visible = false;
    if (this.scene) this.scene.add(m);
    this._marks[i] = m;
    return m;
  }

  /* ---- sirens ----------------------------------------------------------- */

  _syncSirens() {
    const player = this.game.player;
    const units = this.heat.units();
    /* Nearest-first, so which two sirens you hear is a decision rather than an
       artefact of iteration order colliding with audio.js's SIREN_CAP. */
    const want = [];
    for (const u of units) {
      if (!u.spec || !u.spec.mobile) continue;
      if (u.state === 'leaving' || u.state === 'devoured') continue;
      const d = player ? Math.hypot(u.x - player.position.x, u.z - player.position.z) : 0;
      if (d > SIREN_RANGE) continue;
      want.push({ u, d });
    }
    want.sort((a, b) => a.d - b.d);
    if (want.length > MAX_SIRENS) want.length = MAX_SIRENS;

    const keep = new Set();
    for (const { u } of want) {
      keep.add(u.id);
      let h = this._sirens.get(u.id);
      if (!h || h.active === false) {
        /* Containment trucks get the two-tone; cruisers wail. audio.siren() is
           idempotent per id and repositions an existing loop, so calling it
           again is the documented way to move one. */
        h = audio.siren(u.kind === 'containment' ? 'hilo' : 'wail', u.x, u.z, u.id);
        this._sirens.set(u.id, h);
      } else {
        h.move(u.x, u.z);
      }
    }
    for (const [id, h] of this._sirens) {
      if (keep.has(id)) continue;
      try { h.stop(0.5); } catch (err) { void err; }
      this._sirens.delete(id);
    }
  }

  /* --------------------------------------------------------- mesh factory -- */

  _mat(key, opts) {
    const k = `mat:${key}`;
    let m = this._templates.get(k);
    if (m) return m;
    m = new THREE.MeshStandardMaterial({ roughness: 0.78, metalness: 0.04, ...opts });
    this._templates.set(k, m);
    this._owned.mat.push(m);
    return m;
  }

  _box(key, w, h, d) {
    const k = `geo:${key}`;
    let g = this._templates.get(k);
    if (g) return g;
    g = new THREE.BoxGeometry(w, h, d);
    this._templates.set(k, g);
    this._owned.geo.push(g);
    return g;
  }

  _cyl(key, rt, rb, h, seg = 10) {
    const k = `geo:${key}`;
    let g = this._templates.get(k);
    if (g) return g;
    g = new THREE.CylinderGeometry(rt, rb, h, seg);
    this._templates.set(k, g);
    this._owned.geo.push(g);
    return g;
  }

  _part(group, geo, mat, x, y, z, ry = 0) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    if (ry) m.rotation.y = ry;
    m.castShadow = true;
    group.add(m);
    return m;
  }

  /**
   * A response unit's body, cloned from a per-kind template.
   *
   * clone() shares geometry AND material with the template, which is exactly
   * what is wanted — except for the two lightbar lamps, whose emissiveIntensity
   * is animated per unit. Those get their own material instances.
   *
   * An unknown kind falls back to a plain box sized from RESPONSE[kind].radius
   * rather than returning null: a response unit you cannot see is worse than an
   * ugly one, and "a new kind silently placed nothing" is the exact failure
   * this codebase keeps repeating.
   */
  _buildView(kind) {
    const spec = RESPONSE[kind];
    const group = new THREE.Group();
    group.name = `response-${kind}`;
    const view = { kind, group, lampA: null, lampB: null, charge: null };
    /** A lamp material is per-unit by design; see _takeView. */
    const lamp = (hex, intensity = 0.05) => {
      const m = new THREE.MeshStandardMaterial({
        color: hex, emissive: hex, emissiveIntensity: intensity, roughness: 0.4,
      });
      this._owned.mat.push(m);
      return m;
    };

    const body = this._mat('unit-body', { color: UNIT_COL.BODY });
    const trim = this._mat('unit-trim', { color: UNIT_COL.TRIM });
    const glass = this._mat('unit-glass', { color: UNIT_COL.GLASS, roughness: 0.25, metalness: 0.2 });
    const tyre = this._mat('unit-tyre', { color: UNIT_COL.TYRE, roughness: 0.95 });

    const wheels = (w, len, r) => {
      const g = this._cyl(`wheel-${r}`, r, r, 0.24, 10);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const m = new THREE.Mesh(g, tyre);
          m.position.set(sx * (w * 0.5), r, sz * (len * 0.32));
          m.rotation.z = Math.PI / 2;
          group.add(m);
        }
      }
    };

    if (kind === 'cruiser') {
      this._part(group, this._box('cruiser-body', 1.9, 0.78, 4.5), body, 0, 0.72, 0);
      this._part(group, this._box('cruiser-cab', 1.72, 0.62, 2.0), glass, 0, 1.36, -0.15);
      /* The livery stripe. Two flat panels rather than a texture: this file has
         no business minting a texture for four vehicles. */
      this._part(group, this._box('cruiser-stripe', 1.93, 0.26, 2.6), trim, 0, 0.66, 0.2);
      wheels(1.9, 4.5, 0.34);
      const lampGeo = this._box('lamp', 0.42, 0.16, 0.3);
      view.lampA = this._part(group, lampGeo, lamp(UNIT_COL.LIGHT_A), -0.34, 1.76, -0.1);
      view.lampB = this._part(group, lampGeo, lamp(UNIT_COL.LIGHT_B), 0.34, 1.76, -0.1);
    } else if (kind === 'barrier') {
      /* A safety barrier, not a wall: waist high, striped, and obviously
         movable. It has to read as "the city would rather you didn't", not as
         collision the player will try to walk through. */
      const stripe = this._mat('barrier-a', { color: UNIT_COL.BARRIER });
      const alt = this._mat('barrier-b', { color: UNIT_COL.BARRIER_ALT });
      const panel = this._box('barrier-panel', 2.4, 0.26, 0.12);
      this._part(group, panel, stripe, 0, 0.92, 0);
      this._part(group, panel, alt, 0, 0.60, 0);
      for (const sx of [-1, 1]) {
        this._part(group, this._box('barrier-leg', 0.12, 1.0, 0.62), trim, sx * 1.06, 0.5, 0);
      }
      const beaconGeo = this._cyl('beacon', 0.1, 0.1, 0.18, 8);
      view.lampA = this._part(group, beaconGeo, lamp(UNIT_COL.BARRIER), -1.06, 1.1, 0);
      view.lampB = this._part(group, beaconGeo, lamp(UNIT_COL.BARRIER), 1.06, 1.1, 0);
    } else if (kind === 'spotter') {
      this._part(group, this._box('spotter-body', 2.3, 1.3, 6.0), body, 0, 1.0, 0);
      this._part(group, this._box('spotter-cab', 2.1, 0.9, 1.9), glass, 0, 2.0, -1.9);
      /* The mast and its lamp. Static, aimed down the road — an actual moving
         spotlight would need a real light in the rig and this is a truck, not a
         lighting change. */
      this._part(group, this._cyl('mast', 0.09, 0.09, 2.4, 8), trim, 0, 2.6, 1.6);
      this._part(group, this._box('spotter-lamp', 0.6, 0.42, 0.3),
        lamp(UNIT_COL.LAMP, 2.2), 0, 3.75, 1.6);
      wheels(2.3, 6.0, 0.44);
    } else if (kind === 'containment') {
      this._part(group, this._box('cont-body', 2.6, 1.5, 6.8), body, 0, 1.1, 0);
      this._part(group, this._box('cont-cab', 2.4, 1.0, 2.0), glass, 0, 2.2, -2.2);
      /* The foam tank. Friendly pool-cleaner cyan, per heat.js's palette note:
         nothing in this system is allowed to read as a weapon. */
      const foam = this._mat('cont-tank', { color: UNIT_COL.FOAM, roughness: 0.4, metalness: 0.25 });
      const tank = this._part(group, this._cyl('tank', 0.72, 0.72, 3.2, 14), foam, 0, 2.5, 0.9);
      tank.rotation.z = Math.PI / 2;
      tank.rotation.y = Math.PI / 2;
      /* The charge tell, shown only while a pulse is winding up. */
      const glow = new THREE.MeshBasicMaterial({
        color: UNIT_COL.FOAM, transparent: true, opacity: 0.55, depthWrite: false,
      });
      this._owned.mat.push(glow);
      view.charge = new THREE.Mesh(this._cyl('charge', 0.5, 0.5, 0.5, 12), glow);
      view.charge.position.set(0, 2.5, 2.7);
      view.charge.visible = false;
      group.add(view.charge);
      wheels(2.6, 6.8, 0.48);
    } else {
      /* Unknown kind. Size it off the spec if there is one, or a car. */
      const r = (spec && spec.radius) || 1.7;
      this._part(group, this._box(`generic-${r.toFixed(1)}`, r * 1.1, r * 0.9, r * 2.4), body, 0, r * 0.55, 0);
      console.warn(`[eventGlue] no body built for response kind '${kind}'; using a placeholder`);
    }

    return view;
  }

  /**
   * A storm debris prop.
   *
   * The kind strings come from TROPICAL_STORM.debrisKinds (cityEvents.js:363)
   * and are matched exactly. Anything unrecognised gets a crate sized from the
   * item's own radius/height, so adding a kind to the data file changes what it
   * LOOKS like, never whether it exists.
   */
  _debrisMesh(it) {
    const g = new THREE.Group();
    g.name = `debris-${it.kind}`;
    const wood = this._mat('deb-wood', { color: 0xa07845 });
    const leaf = this._mat('deb-leaf', { color: 0x4e7a3a });
    const metal = this._mat('deb-metal', { color: 0x9aa3ab, roughness: 0.5, metalness: 0.35 });
    const fabric = this._mat('deb-fabric', { color: 0xe4574c, roughness: 0.9 });
    const card = this._mat('deb-card', { color: 0xb59268 });

    switch (it.kind) {
      case 'storm-branch': {
        this._part(g, this._box('br-limb', 1.6, 0.11, 0.13), wood, 0, 0.09, 0);
        this._part(g, this._box('br-twig', 0.7, 0.07, 0.08), wood, 0.5, 0.14, 0.22, 0.7);
        this._part(g, this._box('br-frond', 1.1, 0.03, 0.34), leaf, -0.45, 0.16, 0.1, -0.5);
        this._part(g, this._box('br-frond', 1.1, 0.03, 0.34), leaf, 0.3, 0.15, -0.2, 0.9);
        break;
      }
      case 'storm-umbrella': {
        /* Blown over, not standing: a patio umbrella that survived the gust
           upright would be the one thing on screen the wind is not touching. */
        this._part(g, this._cyl('um-pole', 0.05, 0.05, 2.0, 8), metal, 0, 0.42, 0).rotation.z = 1.3;
        const canopy = new THREE.Mesh(this._cyl('um-canopy', 0.06, 0.95, 0.55, 12), fabric);
        canopy.position.set(0.82, 0.5, 0);
        canopy.rotation.z = 1.3;
        canopy.castShadow = true;
        g.add(canopy);
        break;
      }
      case 'storm-sign': {
        this._part(g, this._box('sg-post', 0.09, 1.4, 0.09), metal, 0, 0.7, 0);
        const panel = this._part(g, this._box('sg-panel', 1.1, 0.7, 0.06), card, 0, 1.28, 0);
        panel.rotation.z = 0.22;   // torn loose and hanging
        break;
      }
      case 'storm-crate': {
        this._part(g, this._box('cr-body', 1.15, 0.8, 1.15), card, 0, 0.4, 0);
        this._part(g, this._box('cr-band', 1.2, 0.08, 1.2), wood, 0, 0.72, 0);
        break;
      }
      case 'storm-cart': {
        this._part(g, this._box('ct-body', 1.5, 0.85, 0.95), metal, 0, 0.62, 0);
        this._part(g, this._box('ct-canopy', 1.7, 0.1, 1.1), fabric, 0, 1.5, 0);
        for (const sx of [-1, 1]) {
          this._part(g, this._cyl('ct-post', 0.04, 0.04, 0.6, 6), metal, sx * 0.7, 1.18, 0);
        }
        for (const sx of [-1, 1]) {
          const w = new THREE.Mesh(this._cyl('ct-wheel', 0.2, 0.2, 0.08, 10), this._mat('deb-tyre', { color: 0x22262b }));
          w.position.set(sx * 0.62, 0.2, 0.3);
          w.rotation.z = Math.PI / 2;
          g.add(w);
        }
        break;
      }
      default: {
        const r = Math.max(0.25, it.radius || 0.6);
        const h = Math.max(0.25, it.height || 0.7);
        this._part(g, this._box(`deb-generic-${r.toFixed(2)}-${h.toFixed(2)}`, r * 1.6, h, r * 1.6), card, 0, h * 0.5, 0);
        console.warn(`[eventGlue] no shape for debris kind '${it.kind}'; using a crate`);
      }
    }
    /* SHADOW BUDGET. Every one of these is a standalone mesh, i.e. its own draw
       call in the shadow pass — the rest of the city's small props are
       instanced and get one call for thousands. Four clusters of up to fifteen
       items is ~60 objects; at 3-4 parts each that would be ~220 extra shadow
       draws for a handful of crates. One caster per item (the body, always
       child 0) keeps them grounded for the cost of 60. */
    g.traverse((o) => { if (o.isMesh) o.castShadow = false; });
    if (g.children[0]) g.children[0].castShadow = true;
    return g;
  }

  /* ------------------------------------------------------------- devtools -- */

  /** Force an event to start now. Returns the runtime, or null if refused. */
  startEvent(id = TROPICAL_STORM.id, opts = {}) {
    return this.events.start(id, { force: true, ...opts, ctx: { holes: this.game.holes } });
  }

  /** Raise a hole's heat directly. For tuning and for the dev console. */
  bumpHeat(hole, amount = 0.35) {
    return this.heat.bump(hole || this.game.player, amount, 'devtool');
  }

  /** One-line summary for a debug overlay. */
  debugStats() {
    const env = this.events.env();
    return {
      event: env.id,
      phase: env.phase,
      intensity: +env.intensity.toFixed(3),
      rain: +env.rainDensity.toFixed(3),
      debris: this._debris.length,
      heat: this.heat.stats(),
      sirens: this._sirens.size,
    };
  }
}

/**
 * Build the glue, wire it into the running game and return it.
 *
 * Call this LATE in Game.init() — after `layout`, `effects`, `consume`, `hud`,
 * `voice` and `map` all exist. The recommended anchor is immediately after
 * `this.screens.onMenu = () => this.showLobby();` (game.js:409), which is past
 * every one of those and before the meta layer's await.
 *
 * @param {object} game
 * @returns {EventGlue}
 */
export function install(game) {
  if (game.eventGlue instanceof EventGlue) return game.eventGlue;
  const glue = new EventGlue(game).install();
  game.eventGlue = glue;
  return glue;
}

export default install;
