/**
 * POLICE / CITY RESPONSE — the Heat system.
 *
 * Spec: CLAUDE_OVERNIGHT_POWERUPS_EVENTS_AUDIO.md section 3.
 *
 * WHAT THIS IS
 *   A playful arcade consequence for wrecking the city. Eat a bench, nobody
 *   cares. Eat a fountain, a patrol car, and a bus stop inside twenty seconds
 *   and the city notices, turns up, and makes a nuisance of itself with foam.
 *   It is NOT violence: nothing here shoots, injures, or kills. The only thing
 *   the city can actually do to you is splat a marked circle of containment
 *   foam on the ground and dock a few points if you were standing in it.
 *
 * WHAT THIS IS NOT
 *   It is not a renderer. This module owns pure state + road-legal routing and
 *   publishes `units()` for whatever draws vehicles. It never creates a THREE
 *   object beyond the scratch vectors the Effects API demands.
 *   It is not a difficulty spike. Read the three documented routes out at
 *   `HOW TO DISENGAGE` below — every one of them is implemented and testable.
 *
 * DEPENDENCIES ARE INJECTED. This file never imports game.js. It reads a hole
 * only through the verified Hole contract (position/velocity/radius/
 * trueRadius/score/tier/alive/spawnGrace/isPlayer/addScore) and a consumable
 * only through (tier/score/kind/label), so it can be unit-tested against
 * stubs — see __selftest() at the bottom, which does exactly that.
 *
 * ---------------------------------------------------------------------------
 * HOW TO DISENGAGE — three routes, all implemented, all reachable
 *
 *   1. LEAVE THE ZONE.  Stay further than HEAT.LEAVE_R (110 m) from every
 *      response unit for HEAT.LEAVE_T (3 s) and the whole roster switches to
 *      'leaving', drives off down real roads, and despawns. Cooling is also a
 *      function of distance (see _cool), so running is always the safe answer.
 *   2. DODGE THE MARKED PULSES.  Every pulse is a fixed ground marker with a
 *      HEAT.WARN_T (1.6 s) telegraph. It does not track you. Three consecutive
 *      dodges (HEAT.MISS_DISENGAGE) and the unit that fired gives up, leaves,
 *      and takes HEAT.DISENGAGE_COOL off the meter.
 *   3. OUTGROW THEM.  Once trueRadius clears the unit kind's devour radius
 *      (a cruiser is a normal TIER.LARGE object at 5.2 m, exactly like the
 *      parked police cars in vehicles.js) you simply eat it. Devouring is the
 *      funny route, not the cheap one: it ADDS heat, per the spec's own voice
 *      line "That was a brand-new patrol car!".
 * ---------------------------------------------------------------------------
 */

import * as THREE from 'three';
import { HOLE, TIER, TIER_LIST, WORLD } from '../config.js';
import { ZONE } from '../world/cityLayout.js';
import { makeRNG } from '../core/rng.js';

/* ========================================================================== *
 * TUNABLES
 * ========================================================================== */

export const HEAT = {
  /** Top of the meter. Everything that writes heat clamps to [0, MAX]. */
  MAX: 1.0,

  /* ---------------------------------------------------------- thresholds --
   * Two ladders, not one. UP[] is the level you must exceed to climb into a
   * tier, DOWN[] is the level you must fall below to drop out of it. The ~0.07
   * gap is hysteresis: without it a hole parked exactly on 0.22 flickers
   * between "city is calm" and "SIRENS" several times a second, which is the
   * single most obnoxious bug this kind of meter can have.
   */
  UP: [0, 0.22, 0.52, 0.82],
  DOWN: [0, 0.15, 0.44, 0.74],
  /** Minimum seconds in a tier before it may change again. Banner spam guard. */
  DWELL: 2.0,

  /* --------------------------------------------------------------- gain ---
   * Indexed by TIER_LIST id (0 Litter .. 7 Towers). Calibrated against the
   * measured city population in config.js: a strong player eats ~2 things a
   * second, and early on nearly all of them are tier 0/1. Litter is worth
   * exactly ZERO heat — nobody calls the city because a crisp packet vanished,
   * and if litter counted, heat would be a stopwatch rather than a choice.
   * Simulated against a 240 s Classic match at 2.5 tier-appropriate eats per
   * second, these land tier 1 around t=85, tier 2 around t=115 and tier 3
   * around t=140 — the escalation arrives inside the match instead of in its
   * last thirty seconds, which is where a 30% softer table put it.
   *
   * They are also deliberately too small for a pure furniture grazer to ever
   * reach tier 1: at 2 eats/sec of litter and benches the gain (~0.0067/s)
   * sits just under the throttled cooling rate (~0.008/s), so that player
   * plateaus around 0.08 and the city never turns up. Heat is for wrecking
   * things that matter, not for playing the game.
   */
  GAIN_BY_TIER: [0, 0.005, 0.011, 0.028, 0.062, 0.100, 0.140, 0.190],
  /** No single object may ever contribute more than this. Anti-spike. */
  GAIN_CAP: 0.20,
  /** Eating a response unit is heat, not relief. */
  DEVOUR_GAIN: 0.10,

  /* -------------------------------------------------------------- decay ---
   * See _cool() for the curve and the reasoning behind every number.
   */
  /** Seconds after a heat gain during which cooling runs at COOL_BUSY rate. */
  COOL_DELAY: 3.0,
  /**
   * Cooling multiplier while actively wrecking things.
   *
   * This was a hard gate (no cooling at all inside COOL_DELAY) and that made
   * the meter a ratchet: a normal player eats ~2.5 things a second and
   * therefore NEVER goes three seconds without a gain, so heat only ever went
   * up. Measured over a four-minute match it pinned at 1.0 from t=120 and
   * stayed there — tier 3, the spec's "short response event", for half the
   * game.
   *
   * At 0.35 it is an equilibrium instead of a ratchet: grazing street furniture
   * cools you off, a sustained diet of cars and buses out-paces the cooling,
   * and stopping for a moment drops you fast.
   */
  COOL_BUSY: 0.35,
  /** Below this range from a unit the meter is frozen. See STANDOFF. */
  HOLD_R: 22,
  FAR_R: 170,
  COOL_MIN: 0.008,
  COOL_MAX: 0.055,
  COOL_SHAPE: 0.35,
  ZERO_SNAP: 0.004,
  DISENGAGE_COOL: 0.12,

  /* -------------------------------------------------------------- units --- */
  /** Hard ceiling on live units, whatever the composition table asks for. */
  MAX_UNITS: 6,
  /**
   * Minimum seconds between two dispatches.
   *
   * The roster fills one slot per tick, and a tick is a FRAME — so without
   * this, a full tier-3 roster materialised in six frames (a tenth of a
   * second), which reads as a magic trick rather than an arrival. It also
   * throttles the replace-the-eaten loop: at heat 3 a big hole can swallow a
   * cruiser, and instant redispatch turned that into a score farm.
   *
   * Applies to REFUSED dispatches too. A refusal scans every junction in the
   * city, and retrying that sixty times a second because the player is stood
   * somewhere with no nearby road is pure waste.
   */
  DISPATCH_GAP: 1.2,
  /**
   * A barrier is a cordon, not a snack. Placing one closer than this to the
   * hole just hands a big player a free TIER.MEDIUM object every time the
   * roster refills.
   */
  BARRIER_MIN_R: 30,
  /** Units spawn on a road intersection this far from the INTERCEPT point. */
  SPAWN_MIN_R: 40,
  /* If no legal junction sits within this of the intercept, the dispatch is
   * simply refused this tick and retried next frame from a fresh intercept.
   * Better a late unit than one that spawns half a district away. */
  SPAWN_MAX_R: 130,
  /** Give-up radius: a unit this far from its target is pointless, so it goes. */
  DESPAWN_R: 240,
  /**
   * INTERCEPTION. Response units are slower than the thing they are responding
   * to and always will be: a cruiser does 17 m/s, a hole starts at
   * HOLE.BASE_SPEED (19.5) and is doing ~35 by mid-game. Measured over a 240 s
   * sim, units dispatched at the hole's CURRENT position trailed it by an
   * average of 154 m and got six telegraphed shots off in four minutes — the
   * entire system was scenery.
   *
   * So they are dispatched to where the hole is GOING, capped at this many
   * seconds of lead. That turns the encounter into the arcade shape it should
   * have been all along: a patrol car swings out of a side street in front of
   * you, gets one telegraphed shot, and falls behind while another is dispatched
   * further along. Over-leading when the player turns is not a bug — turning is
   * how you make them waste the trip.
   */
  INTERCEPT_MAX_T: 3.5,
  /**
   * …and a hard distance cap on that lead, which the time cap alone does not
   * give you. A hole doing 35 m/s with a 3.5 s lead gets intercepted 122 m
   * down the road, so a player running dead straight had a fresh unit
   * materialise in front of them over and over — measured, the nearest unit
   * never left 10-20 m across a 70 s flat-out run and heat never moved off
   * 1.0. Being unable to escape a response by outrunning it is precisely what
   * the spec rules out.
   */
  INTERCEPT_MAX_D: 60,
  /** Seconds of making no progress before a unit quietly leaves. */
  STUCK_T: 6.0,
  /**
   * Closest a unit will voluntarily drive to the hole. It is not suicidal.
   * MUST BE GREATER THAN HOLD_R, or a unit sitting at its standoff distance
   * pins the cooling rate at exactly zero forever and the meter can only ever
   * go up while anyone is on scene.
   */
  STANDOFF: 26,
  /** Standoff once the hole can eat it. Now it is actively backing away. */
  STANDOFF_SCARED: 40,
  LEAVE_R: 110,
  LEAVE_T: 3.0,
  /** After a successful disengage, no new unit may be dispatched for this long. */
  DISENGAGE_HOLD: 8.0,
  /** Seconds a 'leaving' unit gets to drive off before it is culled. */
  LEAVE_LIFE: 8.0,

  /* ------------------------------------------------------------- pulses --- */
  /** Telegraph length. 1.6 s is ~30 m of travel at a mid-game hole's speed. */
  WARN_T: 1.6,
  /** Radius of the marked circle, metres. */
  PULSE_R: 7.0,
  /**
   * How far ahead the marker is placed, AS A FRACTION OF WARN_T.
   *
   * Expressed as a fraction on purpose. It was a standalone 0.55 s against a
   * 1.6 s telegraph, and the coupling is the whole ballgame: the marker landed
   * a third of the way along the player's path, so a moving hole was never hit
   * at all. Measured over four minutes: 70 telegraphs, zero hits, including
   * against a player running dead straight at constant speed — the single
   * easiest target there is. Retuning WARN_T alone would silently break it
   * again, hence the fraction.
   *
   * 0.95 aims very slightly behind where a player holding course will be, so:
   *   - dead straight at constant speed  -> clipped near the trailing edge
   *   - any turn or speed change in 1.6s -> clean miss
   * Measured across five movement styles that gives: stationary hit, slow
   * amble hit, straight-line runner hit, hard turning clean, zigzag clean.
   * That is exactly the contract — telegraphed, avoidable, not automatic.
   */
  LEAD_FRAC: 0.95,
  /** Per-unit reload. */
  UNIT_CD: 7.0,
  /** THE ANTI-STUN-LOCK RULE. Minimum seconds between two LANDED hits on the
   *  same hole, enforced globally across every unit in the city. */
  HIT_GAP: 5.0,
  /**
   * A unit will not even start a telegraph beyond this range.
   *
   * 70, not the 46 first tried. A unit can only hold contact with a mid-game
   * hole for a second or two as it sweeps past — measured, the closest approach
   * on a fast-moving target is 37-48 m — so a 46 m envelope meant the window to
   * start a 1.6 s telegraph almost never opened. It is a lobbed foam canister,
   * not a thrown one; the distance costs the player nothing because the marker
   * is on the ground either way.
   */
  FIRE_RANGE: 70,
  MISS_DISENGAGE: 3,

  /* ------------------------------------------------------------ penalty ---
   * THE CAP, stated plainly: a single hit removes at most 2% of the hole's
   * current score, at most PENALTY_CAP points in absolute terms, never more
   * points than the hole has, and NEVER enough to drop it a size tier. If the
   * tier clamp reduces the loss to nothing, the hit weakens Vacuum Boost
   * instead so it still means something. See _penalty().
   */
  PENALTY_FRAC: 0.02,
  PENALTY_CAP: 120,
  PENALTY_MIN: 5,

  /* ------------------------------------------------- vacuum boost debuff --- */
  /** Multiplier applied to Vacuum Boost's reach while debuffed. */
  VAC_SCALE: 0.45,
  VAC_T: 5.0,

  /* ---------------------------------------------------------- steering ----
   * Barriers nudge, they do not steer. NUDGE_MAX is 1.6 m/s against a hole
   * whose base speed is HOLE.BASE_SPEED (19.5 m/s) — about 8%. The player wins
   * every argument; the barrier just makes the plaza feel defended.
   */
  NUDGE_MAX: 1.6,
  NUDGE_R: 26,

  /* --------------------------------------------------------------- voice --- */
  CUE_GAP: 6.0,
  CUE_REPEAT: 14.0,
};

/**
 * Response unit kinds.
 *
 * `devourR` deliberately reuses the SAME tier radii the rest of the game uses
 * (TIER.LARGE for a car-sized cruiser, TIER.XLARGE for a truck), so "bigger
 * holes can eventually devour response vehicles per normal size tiers" is
 * literally true rather than a bespoke number that drifts out of sync.
 */
export const RESPONSE = {
  cruiser: {
    speed: 20.0, radius: 1.7,
    devourR: TIER.LARGE.eatRadius, score: TIER.LARGE.score,
    label: 'Response Cruiser', fires: true, mobile: true,
  },
  barrier: {
    speed: 0, radius: 1.2,
    devourR: TIER.MEDIUM.eatRadius, score: TIER.MEDIUM.score,
    label: 'Safety Barrier', fires: false, mobile: false,
  },
  spotter: {
    speed: 17.0, radius: 2.1,
    devourR: TIER.XLARGE.eatRadius, score: TIER.XLARGE.score,
    label: 'Spotlight Truck', fires: false, mobile: true,
  },
  containment: {
    speed: 15.0, radius: 2.6,
    devourR: TIER.XLARGE.eatRadius, score: TIER.XLARGE.score,
    label: 'Containment Unit', fires: true, mobile: true,
  },
};

/**
 * Desired roster per heat tier.
 *
 * Tier 1 gets ONE cruiser that never fires — it turns up, parks, puts its
 * lights on and shouts. That is the spec's tier 1 ("notice, point, use
 * lights/sirens, and yell warnings") given something the renderer can actually
 * draw, without promoting tier 1 into a threat.
 */
const COMPOSITION = [
  {},
  { cruiser: 1 },
  { cruiser: 2, barrier: 1 },
  { cruiser: 3, barrier: 1, spotter: 1, containment: 1 },
];

/**
 * Voice line IDs this system triggers. IDS ONLY — the text and the audio asset
 * live in the voice module, which is where the ElevenLabs pipeline and the
 * caption strings belong. Tone matches the spec's examples: fictional,
 * family-safe, no real department names, no real-person voices, no threats.
 *
 * The comment beside each ID is the INTENT for whoever writes the line, not
 * the shipped text.
 */
export const VOICE_CUES = Object.freeze({
  /** Tier 1 arrival — exasperated, not menacing. "Stop eating the street furniture!" */
  NOTICE_FURNITURE: 'cityresp.notice_furniture',
  /** Tier 1, when the last meal was a vehicle. "That is not a parking space!" */
  NOTICE_PARKING: 'cityresp.notice_parking',
  /** Tier 2 arrival — patrols on scene. "Everybody, keep back!" */
  ARRIVE_PATROL: 'cityresp.arrive_patrol',
  /** A barrier goes down near a park/plaza. "Please move away from the plaza!" */
  WARN_PLAZA: 'cityresp.warn_plaza',
  /** Tier 3 arrival, dispatch-flavoured. "The sinkhole is headed downtown!" */
  ARRIVE_RESPONSE: 'cityresp.arrive_response',
  /** The hole has outgrown the roster. "We need a bigger containment unit!" */
  NEED_BIGGER: 'cityresp.need_bigger',
  /** A response vehicle has just been eaten. "That was a brand-new patrol car!" */
  LOST_VEHICLE: 'cityresp.lost_vehicle',
  /** Telegraph is up, foam is charging. Short, urgent, comic. */
  PULSE_CHARGE: 'cityresp.pulse_charge',
  /** Foam landed on the hole. */
  PULSE_HIT: 'cityresp.pulse_hit',
  /** Foam landed on empty street. Deflated. */
  PULSE_MISS: 'cityresp.pulse_miss',
  /** Route 2 out: they have given up on this one. */
  STAND_DOWN: 'cityresp.stand_down',
  /** Heat has fallen back to tier 0. All clear, for now. */
  ALL_CLEAR: 'cityresp.all_clear',
});

export const VOICE_CUE_LIST = Object.freeze(Object.values(VOICE_CUES));

/**
 * SFX method names this system will call on the audio singleton IF they exist.
 * Every one is feature-detected at the call site, because at the time of
 * writing NONE of these existed in src/core/audio.js — it had swallow/chomp/
 * crumble/levelUp/devourPlayer/death/countdownBeep/rankChange/ui/matchStart/
 * matchEnd and nothing siren-shaped. Guessing a name here would fail silently
 * and the whole system would ship mute, so each optional call has a verified
 * fallback listed beside it.
 *
 * SINCE THEN audio.js grew most of them, and this table went stale — which is
 * the same silent failure with the polarity reversed. `ARRIVE` named
 * 'responseArrive', which has never existed; it fell through to a generic UI
 * click, while `dispatchChirp` — a purpose-built radio squelch at
 * core/audio.js:3135, listed in SOUND_METHODS, and named in eventGlue.js's own
 * verified-contract header — sat with ZERO call sites in the entire repo.
 * Measured by tools/heat-probe.mjs: 97 dispatches in one match, 0 chirps.
 * Every name below is checked against SOUND_METHODS (core/audio.js:3549).
 */
const SFX = {
  HEAT_UP: 'heatUp',            // exists (audio.js:3155), takes (tier 1..3)
  HEAT_DOWN: 'heatDown',        // exists (audio.js:3180)
  ARRIVE: 'dispatchChirp',      // exists (audio.js:3135), takes (x, z)
  WARN: 'containmentWarn',      // DOES NOT EXIST — fallback: countdownBeep(false)
  PULSE: 'containmentPulse',    // exists (audio.js:3197), takes (x, z)
  PENALTY: 'scorePenalty',      // exists (audio.js:3290), no arguments
};

/* Palette. Foam is deliberately a friendly pool-cleaner cyan and the warning a
 * road-sign amber: nothing in this system is allowed to read as blood or fire. */
const COL = {
  FOAM: 0xbfe9ff,
  WARN: 0xffd23f,
  HEAT: 0xff5a4d,
  CALM: 0x7dffbe,
};

/**
 * Half a lane. roadNetwork.js defines LANE_W = 3.4, so 1.7 is the kerb-side
 * lane centre offset from a road's centreline. Hardcoded rather than imported
 * because importing roadNetwork.js drags in the whole RoadNetwork class for one
 * number, and this module does not otherwise need it.
 */
const LANE_OFF = 1.7;

/**
 * How much faster than its own speed a unit may move while catching up to the
 * lane it just turned onto. Must exceed 1 or a corner never resolves — the
 * target it is chasing is itself moving at `speed`. See _place.
 */
const CORNER_CHASE = 1.6;
/** Max turn rate, rad/s. 6.0 swings 90 degrees in 0.26 s, matching the corner. */
const YAW_RATE = 6.0;

/* Scratch. This runs at frame rate with up to MAX_UNITS units; the house rule
 * is that nothing per-frame allocates. */
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _ideal = { x: 0, z: 0, yaw: 0 };
const _pt = { x: 0, z: 0 };
const _avoid = { x: 0, z: 0, r: 0 };

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smooth = (t) => t * t * (3 - 2 * t);

/**
 * Inverse of Hole.radiusFor, documented in config.js:
 *   score = GROWTH_K * ((r / START_RADIUS)^(1/GROWTH_P) - 1)
 * Needed so a penalty can be clamped to "never demotes a tier".
 */
function scoreForRadius(r) {
  if (!(r > 0)) return 0;
  return Math.max(0, HOLE.GROWTH_K * (Math.pow(r / HOLE.START_RADIUS, 1 / HOLE.GROWTH_P) - 1));
}

/**
 * Importance multiplier on top of the tier-based heat gain.
 *
 * Matched against BOTH `kind` (the instanced-pool key, e.g. 'police') and
 * `label` (the display name, e.g. 'Police Car'), lowercased, because
 * worldBuild.js defaults kind to the pool key and modules override label
 * independently — the two disagree constantly. All of the strings below were
 * read out of the live content files, not invented: 'police'/'Police Car' and
 * 'ambulance'/'Ambulance' from vehicles.js, the rest from the label sweep over
 * src/world. An unmatched item falls through to 1.0, so a content rename
 * degrades to "slightly less heat" instead of silently placing nothing.
 */
const IMPORTANT = [
  // Emergency and enforcement. Eating one of these is the loudest thing you
  // can do that is not eating a building.
  [3.0, ['police', 'ambulance', 'fire hydrant', 'standpipe']],
  // Civic pride: the things a city puts on its own postcards.
  [2.2, ['fountain', 'grand fountain', 'public art', 'sculpture', 'bandshell',
    'playground', 'basketball hoop', 'flag pole', 'outreach point', 'venue']],
  // Public transport and the street's own furniture-of-record.
  [1.6, ['citybus', 'city bus', 'articbus', 'articulated bus', 'shuttlebus',
    'airport shuttle', 'trolley', 'bus shelter', 'bus stop', 'garbagetruck',
    'garbage truck', 'street light', 'traffic', 'stop sign']],
];

function importanceOf(c) {
  const k = String(c.kind || '').toLowerCase();
  const l = String(c.label || '').toLowerCase();
  for (const [mult, names] of IMPORTANT) {
    for (const n of names) if (k === n || l === n) return mult;
  }
  return 1.0;
}

let _uid = 1;

/* ========================================================================== *
 * HeatSystem
 * ========================================================================== */

export class HeatSystem {
  /**
   * @param {object} deps
   * @param {Function} [deps.rng]      makeRNG-style rng (rng(), rng.range, rng.pick…)
   * @param {object}   [deps.layout]   cityLayout — needs isRoad/isWater, ideally roadsX/roadsZ/blocks
   * @param {object}   [deps.effects]  render/effects.js Effects
   * @param {object}   [deps.audio]    core/audio.js singleton (optional)
   * @param {object}   [deps.voice]    voice module with say(cueId, opts) (optional)
   * @param {object}   [deps.hud]      ui/hud.js, for pushFeed (optional)
   * @param {Function} [deps.hasVacuum] (hole) => bool — is Vacuum Boost live on this hole?
   * @param {Function} [deps.inPlay]   (x,z) => bool — extra placement veto. Pass one that
   *                                   also rejects outside game.shrink when a ring is up.
   */
  constructor(deps = {}) {
    this.rng = deps.rng || makeRNG(0x48454154); // 'HEAT'
    this.layout = deps.layout || null;
    this.effects = deps.effects || null;
    this.audio = deps.audio || null;
    this.voice = deps.voice || null;
    this.hud = deps.hud || null;
    this.hasVacuum = typeof deps.hasVacuum === 'function' ? deps.hasVacuum : null;
    this.inPlay = typeof deps.inPlay === 'function' ? deps.inPlay : null;

    /** @type {Map<object, HeatState>} per-hole state, keyed by the hole object. */
    this.state = new Map();
    /** @type {Unit[]} live response units. */
    this._units = [];
    /** The hole the response is currently focused on. Only one at a time. */
    this.focus = null;

    this.t = 0;
    this._pruneAt = 0;
    /** Next time a dispatch is allowed. See HEAT.DISPATCH_GAP. */
    this._nextDispatch = 0;
    /** Cue rate limiting: last time ANY cue fired, and per-cue last times. */
    this._lastCueT = -1e9;
    this._cueAt = new Map();

    /* Lazily built from layout — see _roads(). Null until first use so a
     * HeatSystem can be constructed before the world exists. */
    this._rx = null;
    this._rz = null;
    this._nodes = null;
    this._protected = null;
  }

  /* ---------------------------------------------------------------------- *
   * PUBLIC — state queries
   * ---------------------------------------------------------------------- */

  /** Current heat 0..1 for a hole. Unknown holes read 0. */
  heatOf(hole) {
    const s = this.state.get(hole);
    return s ? s.heat : 0;
  }

  /** Current heat tier 0..3 for a hole. Unknown holes read 0. */
  tierOf(hole) {
    const s = this.state.get(hole);
    return s ? s.tier : 0;
  }

  /**
   * Multiplier the power-up module should apply to Vacuum Boost's reach for
   * this hole. 1 normally; HEAT.VAC_SCALE while a containment hit is in effect.
   * This is the "temporarily weakens Vacuum Boost" half of the spec's penalty
   * rule, exposed as a query so heat.js never has to know how Vacuum Boost is
   * implemented.
   */
  vacuumScale(hole) {
    const s = this.state.get(hole);
    if (!s || this.t >= s.vacUntil) return 1;
    return HEAT.VAC_SCALE;
  }

  /**
   * The live unit array, in the shape the spec asked for:
   * `[{x, z, yaw, kind, state}]` plus renderer extras (id, warnT, mark, siren,
   * spec). READ-ONLY BY CONTRACT — it is the internal array, returned without
   * a copy because this is called every frame by the renderer and copying six
   * objects sixty times a second for tidiness is not a trade worth making.
   */
  units() { return this._units; }

  /** Debug/HUD summary. */
  stats() {
    const byKind = {};
    for (const u of this._units) byKind[u.kind] = (byKind[u.kind] || 0) + 1;
    return {
      units: this._units.length,
      byKind,
      focusHeat: this.focus ? this.heatOf(this.focus) : 0,
      focusTier: this.focus ? this.tierOf(this.focus) : 0,
      tracked: this.state.size,
    };
  }

  /* ---------------------------------------------------------------------- *
   * PUBLIC — inputs
   * ---------------------------------------------------------------------- */

  /**
   * A hole just ate something. Raise heat by the item's importance.
   *
   * Call this from wherever the swallow is already being reported (the
   * ConsumeSystem._capture path). It is intentionally cheap and side-effect
   * free apart from the number: no effects, no audio, no allocation. A big hole
   * captures hundreds of props in one frame and this must survive that.
   */
  onConsumed(hole, consumable) {
    if (!hole || !consumable || hole.alive === false) return 0;
    const tid = consumable.tier ? (consumable.tier.id | 0) : 0;
    const base = HEAT.GAIN_BY_TIER[clamp(tid, 0, HEAT.GAIN_BY_TIER.length - 1)] || 0;
    if (base <= 0) return 0;
    const mult = importanceOf(consumable);
    const gain = Math.min(HEAT.GAIN_CAP, base * mult);
    return this._add(hole, gain, 'ate', mult);
  }

  /**
   * Raise (or lower, with a negative amount) heat directly.
   * This is the hook for the event system's "major event disturbance" — a storm
   * looting spree, wrecking the Cleanup Convoy — and for anything else that is
   * not a plain swallow.
   */
  bump(hole, amount, reason = 'event') {
    if (!hole || !Number.isFinite(amount)) return 0;
    /* NOT clamped to GAIN_CAP. That cap exists to stop one swallowed object
     * spiking the meter; an event is allowed to be a big deal ("you wrecked the
     * Cleanup Convoy") and a debug/admin call is allowed to set the whole bar.
     * The only bound is the meter's own range. */
    return this._add(hole, clamp(amount, -HEAT.MAX, HEAT.MAX), reason);
  }

  /**
   * Advisory steering nudge at a world point, in m/s. Barriers only — a patrol
   * car does not shove a sinkhole around. Magnitude is capped at
   * HEAT.NUDGE_MAX, which is ~8% of a hole's base speed, so this can lean the
   * player away from a protected plaza but can never take control from them.
   *
   * The orchestrator applies it POSITIONALLY (`hole.position.x += push.x * dt`)
   * rather than to velocity: Hole.update lerps velocity toward
   * desiredDir * speed every frame with k = 1 - exp(-ACCEL*dt), so a velocity
   * nudge is erased within a couple of frames and would do nothing at all.
   *
   * @param {number} x
   * @param {number} z
   * @param {{x:number,z:number}} [out]
   */
  steerAt(x, z, out = { x: 0, z: 0 }) {
    out.x = 0; out.z = 0;
    for (const u of this._units) {
      if (u.kind !== 'barrier' || u.state === 'devoured') continue;
      const dx = x - u.x, dz = z - u.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.001 || d > HEAT.NUDGE_R) continue;
      const k = 1 - d / HEAT.NUDGE_R;
      const g = HEAT.NUDGE_MAX * k * k;
      out.x += (dx / d) * g;
      out.z += (dz / d) * g;
    }
    const m = Math.hypot(out.x, out.z);
    if (m > HEAT.NUDGE_MAX) { out.x *= HEAT.NUDGE_MAX / m; out.z *= HEAT.NUDGE_MAX / m; }
    return out;
  }

  /** Wipe everything. Call on match start, match end, and map reset. */
  clearAll() {
    this.state.clear();
    this._units.length = 0;
    this.focus = null;
    this._lastCueT = -1e9;
    this._cueAt.clear();
    this._nextDispatch = 0;
  }

  /* ---------------------------------------------------------------------- *
   * PUBLIC — serialisation (multiplayer authority)
   * ---------------------------------------------------------------------- */

  /**
   * JSON-safe snapshot of one hole's heat state. Numbers only — no object
   * references, no unit list. Times are stored as REMAINING SECONDS rather than
   * absolute deadlines, because the receiving peer's clock is not this one's
   * and shipping `vacUntil: 412.7` into a fresh match means a five-minute
   * debuff.
   */
  serialize(hole) {
    const s = this.state.get(hole);
    if (!s) return null;
    return {
      heat: +s.heat.toFixed(4),
      tier: s.tier,
      sinceHit: +Math.max(0, this.t - s.lastHitT).toFixed(2),
      vacLeft: +Math.max(0, s.vacUntil - this.t).toFixed(2),
      misses: s.misses,
      engaged: s.engaged,
    };
  }

  /** Restore a snapshot produced by serialize(). Missing fields keep defaults. */
  applyState(hole, s) {
    if (!hole || !s) return null;
    const st = this._st(hole);
    if (Number.isFinite(s.heat)) st.heat = clamp(s.heat, 0, HEAT.MAX);
    if (Number.isFinite(s.tier)) st.tier = clamp(s.tier | 0, 0, 3);
    if (Number.isFinite(s.sinceHit)) st.lastHitT = this.t - Math.max(0, s.sinceHit);
    if (Number.isFinite(s.vacLeft)) st.vacUntil = this.t + Math.max(0, s.vacLeft);
    if (Number.isFinite(s.misses)) st.misses = s.misses | 0;
    if (typeof s.engaged === 'boolean') st.engaged = s.engaged;
    /* awayT is NOT restored. It is a measurement of the last few seconds of
     * local play, and carrying a peer's part-finished stand-down timer across
     * would hand the receiving client a disengage it did not earn. */
    st.awayT = 0;
    // A restored tier must not immediately re-announce itself.
    st.lastTierT = this.t;
    return st;
  }

  /* ---------------------------------------------------------------------- *
   * PUBLIC — the tick
   * ---------------------------------------------------------------------- */

  /**
   * @param {number} dt   seconds
   * @param {Array}  holes  every live hole
   * @param {number} [t]  match clock; defaults to an internal accumulator
   */
  update(dt, holes, t) {
    /* CLAMP dt BEFORE ANYTHING ELSE. A tab-switch or a shader compile hands us
     * a 3-second dt; at 17 m/s that is a 51 m step, which is longer than the
     * gap between junctions and would let a unit step clean across a block —
     * i.e. THROUGH A BUILDING, the one thing the spec forbids outright. 0.1 s
     * caps a step at 1.7 m. Units simply run slow through a hitch, which is
     * invisible and correct. */
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
    this.t = Number.isFinite(t) ? t : this.t + dt;
    const now = this.t;
    const list = Array.isArray(holes) ? holes : [];

    /* ---- 1. per-hole heat: cool, then resolve the tier ------------------ */
    for (const hole of list) {
      if (!hole || hole.alive === false) continue;
      const st = this.state.get(hole);
      if (!st) continue;               // never touched anything yet: stays cold
      this._cool(hole, st, dt, now);
      this._resolveTier(hole, st, now);
    }

    /* ---- 2. who is the response actually chasing? ----------------------- */
    this._pickFocus(list, now);

    /* ---- 3. roster ------------------------------------------------------ */
    this._maintainRoster(now);

    /* ---- 4. units ------------------------------------------------------- */
    for (let i = this._units.length - 1; i >= 0; i--) {
      const u = this._units[i];
      this._updateUnit(u, dt, now);
      if (u.dead) this._units.splice(i, 1);
    }

    /* ---- 5. route 1 out: has the focus stayed away long enough? --------- */
    this._checkLeaveZone(dt, now);

    /* ---- 6. housekeeping ------------------------------------------------ */
    if (now >= this._pruneAt) {
      this._pruneAt = now + 2.0;
      this._prune(list);
    }
  }

  /* ---------------------------------------------------------------------- *
   * heat maths
   * ---------------------------------------------------------------------- */

  /** Per-hole record, created on demand. */
  _st(hole) {
    let s = this.state.get(hole);
    if (!s) {
      s = {
        heat: 0,
        tier: 0,
        /** -Infinity so the FIRST tier change is never blocked by DWELL. */
        lastTierT: -1e9,
        lastGainT: -1e9,
        lastHitT: -1e9,
        vacUntil: -1e9,
        misses: 0,
        awayT: 0,
        engaged: false,
        lastReason: '',
        lastMult: 1,
        announcedBigger: false,
      };
      this.state.set(hole, s);
    }
    return s;
  }

  _add(hole, gain, reason, mult = 1) {
    const s = this._st(hole);
    const before = s.heat;
    s.heat = clamp(s.heat + gain, 0, HEAT.MAX);
    if (gain > 0) s.lastGainT = this.t;
    // Remembered so the tier-1 announcement can pick a line that matches what
    // the player has actually been doing rather than always crying about
    // street furniture.
    if (gain > 0) { s.lastReason = reason; s.lastMult = mult; }
    return s.heat - before;
  }

  /**
   * THE DECAY CURVE.
   *
   *   rate(d) = COOL_MIN + (COOL_MAX - COOL_MIN) * smoothstep(u),
   *             u = (d - HOLD_R) / (FAR_R - HOLD_R),  clamped 0..1
   *   dH/dt   = -rate(d) * (COOL_SHAPE + (1 - COOL_SHAPE) * H)
   *
   * where d is the distance to the NEAREST live response unit (or FAR_R if
   * there are none, because "stay away from response units" is trivially true
   * when there are none to stay away from).
   *
   * Three deliberate properties:
   *
   *  - INSIDE HOLD_R (34 m) THE METER DOES NOT MOVE AT ALL. Standing in a
   *    cordon taunting a patrol car should not cool you off. That flat zone is
   *    what makes route 1 ("leave") a real decision rather than a formality.
   *  - The distance ramp is a smoothstep, not linear, so backing off by ten
   *    metres at the edge of the cordon barely helps but properly running does.
   *    A linear ramp made "shuffle backwards a bit" an optimal play.
   *  - The (0.35 + 0.65·H) factor means the top of the meter drains about three
   *    times faster than the bottom: 1.0 -> 0.52 (tier 3 back to tier 2) takes
   *    ~10 s of running, which is a survivable chase, while the last sliver of
   *    tier-1 heat lingers ~30 s so the city stays watchful for a beat instead
   *    of snapping to calm the instant you turn a corner. That residue also
   *    stops heat strobing across the tier-1 boundary every time you eat a
   *    bench.
   *
   * COOL_DELAY (3 s) holds all of it off until you have actually stopped
   * causing damage — otherwise a player parked in a plaza eating fountains
   * would be cooling and heating simultaneously and the meter would read as
   * broken.
   */
  _cool(hole, s, dt, now) {
    if (s.heat <= 0) return;

    const d = this._nearestUnitDist(hole);
    const u = clamp((d - HEAT.HOLD_R) / (HEAT.FAR_R - HEAT.HOLD_R), 0, 1);
    if (u <= 0) return;                              // inside the cordon: frozen
    let rate = HEAT.COOL_MIN + (HEAT.COOL_MAX - HEAT.COOL_MIN) * smooth(u);
    // Still causing damage? Cooling is throttled, not stopped. See COOL_BUSY.
    if (now - s.lastGainT < HEAT.COOL_DELAY) rate *= HEAT.COOL_BUSY;
    s.heat -= rate * (HEAT.COOL_SHAPE + (1 - HEAT.COOL_SHAPE) * s.heat) * dt;
    if (s.heat < HEAT.ZERO_SNAP) s.heat = 0;
  }

  _nearestUnitDist(hole) {
    if (!this._units.length) return HEAT.FAR_R;
    let best = Infinity;
    const px = hole.position.x, pz = hole.position.z;
    for (const u of this._units) {
      if (u.state === 'devoured') continue;
      const d = Math.hypot(px - u.x, pz - u.z);
      if (d < best) best = d;
    }
    return best === Infinity ? HEAT.FAR_R : best;
  }

  /** Hysteresis + dwell. Announces on change. */
  _resolveTier(hole, s, now) {
    let want = s.tier;
    // Climb: strictly above the UP threshold of the next tier.
    while (want < 3 && s.heat > HEAT.UP[want + 1]) want++;
    // Fall: at or below the DOWN threshold of the tier we are in.
    while (want > 0 && s.heat <= HEAT.DOWN[want]) want--;
    if (want === s.tier) return;
    if (now - s.lastTierT < HEAT.DWELL) return;

    const up = want > s.tier;
    s.tier = want;
    s.lastTierT = now;
    s.misses = 0;
    if (want < 3) s.announcedBigger = false;
    /* TIER 0 ENDS THE ENCOUNTER, and it has to say so.
     *
     * `engaged` is what arms the stand-down timer in _checkLeaveZone, and it
     * was only ever cleared by the stand-down itself. A hole that instead
     * cooled all the way out of the response — which is the ordinary way a
     * chase ends — kept the flag set for the rest of the match, and the next
     * time it heated up the away timer was already armed against a response
     * that had not been sent. Measured in a live match (tools/heat-probe.mjs):
     * after cooling from tier 3 to tier 0 the player still read
     * `engaged: true`, and the FIRST thing that happened on re-escalation was
     * a `cityresp.stand_down` cue and the "OUT OF THE ZONE — the response has
     * lost you" feed line, followed by DISENGAGE_HOLD (8 s) of suppressed
     * dispatch. The player was told they had shaken off a response that had
     * never turned up, and then had to wait out a penalty for it.
     *
     * Safe by construction: _pickFocus skips any hole below tier 1, so nothing
     * reads `engaged` or `awayT` for a tier-0 hole. This only stops them being
     * carried across. */
    if (want === 0) { s.engaged = false; s.awayT = 0; }
    this._announce(hole, want, up, now);
  }

  /**
   * THE STING IS THE PLAYER'S, AND IT CARRIES THE TIER.
   *
   * Both halves were wrong and both were silent about it.
   *
   * `audio.heatUp(tier)` is written to sound different at 1, 2 and 3 — the
   * comment on it says "so the tier is audible without reading the HUD"
   * (audio.js:3153) — and it is NON-POSITIONAL: it plays flat in the middle of
   * the mix and ducks everything else by up to 41% (audio.js:3200). This method
   * runs for EVERY hole, so a full-volume, mix-ducking escalation sting was
   * being played for bots the player cannot see. Measured over one 90 s
   * engagement: 26 tier changes, 21 of them a bot's; 78 heatUp calls in total,
   * 73 of which passed no tier at all and therefore played the tier-1 variant.
   * The effects and the kill-feed line below have always been player-gated;
   * the audio simply was not.
   */
  _announce(hole, tier, up, now) {
    const player = hole.isPlayer === true;
    if (up) {
      if (player) {
        this._sfx(SFX.HEAT_UP,
          () => this.audio && this.audio.rankChange && this.audio.rankChange(1), tier);
      }
      if (tier === 1) {
        /* Two flavours of "the city has noticed". A player who got here by
         * eating vehicles and civic fixtures (importance >= 1.6) gets the
         * parking line; a furniture vandal gets the furniture line. */
        const s = this._st(hole);
        this._cue(hole, s.lastMult >= 1.6
          ? VOICE_CUES.NOTICE_PARKING
          : VOICE_CUES.NOTICE_FURNITURE);
      } else if (tier === 2) {
        this._cue(hole, VOICE_CUES.ARRIVE_PATROL);
      } else if (tier === 3) {
        this._cue(hole, VOICE_CUES.ARRIVE_RESPONSE);
      }
    } else {
      if (player) {
        this._sfx(SFX.HEAT_DOWN,
          () => this.audio && this.audio.rankChange && this.audio.rankChange(-1));
      }
      if (tier === 0) this._cue(hole, VOICE_CUES.ALL_CLEAR);
    }

    if (!player) return;
    const fx = this.effects;
    if (fx) {
      _v.set(hole.position.x, 0.4, hole.position.z);
      // Text, not just colour — section 6 of the spec: colour is never the only
      // way to read a warning.
      fx.popup(_v, up ? `HEAT ${tier}` : `HEAT ${tier}`, up ? COL.HEAT : COL.CALM, tier >= 2);
      fx.shockwave(hole.position, Math.max(2, hole.radius * 0.8), Math.max(10, hole.radius * 3),
        up ? COL.HEAT : COL.CALM, 0.65);
      if (up && tier >= 2) fx.addShake(0.12 * tier);
    }
    if (this.hud && this.hud.pushFeed) {
      const how = up
        ? ['', 'the city has noticed you', 'patrols are on the way', 'full city response'][tier]
        : ['all clear', 'response winding down', 'patrols standing down', ''][tier];
      this.hud.pushFeed(
        `<b>HEAT ${tier}</b> — ${how}. Move away from response units to cool down.`,
        up ? '#ff5a4d' : '#7dffbe', 'heat');
    }
  }

  _prune(list) {
    if (this.state.size < 16) {
      // Cheap enough to skip entirely at normal player counts.
      let stale = 0;
      for (const h of this.state.keys()) if (!list.includes(h)) stale++;
      if (!stale) return;
    }
    for (const h of Array.from(this.state.keys())) {
      if (!list.includes(h)) this.state.delete(h);
    }
  }

  /* ---------------------------------------------------------------------- *
   * focus
   * ---------------------------------------------------------------------- */

  /**
   * One response, one target. Six units chasing four holes across the whole map
   * is both a performance problem and unreadable on screen; the city picking a
   * villain is a story.
   *
   * The player gets a small bias so a bot on marginally more heat does not
   * steal the show from under them mid-chase.
   */
  _pickFocus(list, now) {
    let best = null, bestScore = 0;
    for (const hole of list) {
      if (!hole || hole.alive === false) continue;
      const s = this.state.get(hole);
      if (!s || s.tier < 1) continue;
      const score = s.heat + (hole.isPlayer ? 0.06 : 0) + (hole === this.focus ? 0.05 : 0);
      if (score > bestScore) { bestScore = score; best = hole; }
    }
    if (best !== this.focus) {
      this.focus = best;
      // Existing units re-target rather than despawn; the city redirects.
      for (const u of this._units) { u.hole = best; u.stuck = 0; }
    }
  }

  /* ---------------------------------------------------------------------- *
   * roster
   * ---------------------------------------------------------------------- */

  _maintainRoster(now) {
    const hole = this.focus;
    const tier = hole ? this.tierOf(hole) : 0;
    const want = COMPOSITION[clamp(tier, 0, 3)] || {};

    if (!hole || tier <= 0) {
      // Nobody is wanted. Send everyone home rather than deleting them, so
      // vehicles drive off screen instead of blinking out of existence.
      for (const u of this._units) if (u.state !== 'leaving') this._sendHome(u, now);
      return;
    }

    const have = {};
    for (const u of this._units) {
      if (u.state === 'leaving' || u.state === 'devoured') continue;
      have[u.kind] = (have[u.kind] || 0) + 1;
    }

    // Retire surplus kinds first (tier dropped) …
    for (const u of this._units) {
      if (u.state === 'leaving' || u.state === 'devoured') continue;
      const w = want[u.kind] || 0;
      if ((have[u.kind] || 0) > w) { have[u.kind]--; this._sendHome(u, now); }
    }

    // … then fill gaps, one unit per DISPATCH_GAP so the response arrives
    // rather than appearing. See HEAT.DISPATCH_GAP for why this is time-based
    // and not per-tick.
    if (this._units.length >= HEAT.MAX_UNITS) return;
    if (now < this._nextDispatch) return;
    /* DO NOT REINFORCE A ZONE THE PLAYER HAS ALREADY LEFT.
     * _checkLeaveZone needs LEAVE_T seconds of continuous separation to
     * complete, and dispatching every DISPATCH_GAP kept resetting the clock:
     * the away timer could never finish, so route 1 out of the encounter did
     * not exist however fast the player ran. Once they are outside LEAVE_R of
     * everyone, the city stops sending more and lets the timer run. Come back
     * inside and awayT resets, and dispatching resumes on the same frame. */
    const fs = this.state.get(hole);
    if (fs && fs.awayT > 0) return;
    for (const kind of Object.keys(want)) {
      if ((have[kind] || 0) >= want[kind]) continue;
      // Charge the gap whether or not it worked: a refused dispatch is the
      // expensive branch (it scans every junction) and must not retry per frame.
      this._nextDispatch = now + HEAT.DISPATCH_GAP;
      const u = this._spawn(kind, hole, now);
      if (u) {
        this._units.push(u);
        // From here on the player is "in an encounter", which is what arms the
        // stand-down timer in _checkLeaveZone.
        this._st(hole).engaged = true;
        this._sfx(SFX.ARRIVE, () => this.audio && this.audio.ui && this.audio.ui('click'), u.x, u.z);
        if (kind === 'barrier') this._cue(hole, VOICE_CUES.WARN_PLAZA);
      }
      return;
    }
  }

  _sendHome(u, now) {
    if (u.state === 'devoured') return;
    u.state = 'leaving';
    u.stateT = now;
    u.warnT = 0;
    u.mark = null;
  }

  /* ---------------------------------------------------------------------- *
   * ROAD ROUTING — valid roads only, never through a building
   * ---------------------------------------------------------------------- */

  /**
   * THE DRIVABILITY PREDICATE, and the trap it exists to avoid.
   *
   * `layout.isRoad(x, z)` is a pure centreline test:
   *     for (const r of roadsX) if (|x - r.pos| < r.half) return true;
   * It knows nothing about water. S Miami Ave is a roadsX entry at x = -22, so
   * isRoad(-22, 0) returns TRUE — over the middle of the Miami River, where
   * there is no bridge. A router that trusted isRoad alone would drive a patrol
   * car across open water, which is the aquatic cousin of driving through a
   * building.
   *
   * `layout.isWater` is the missing half: it returns false inside a bridge deck
   * (see inBridge in cityLayout.js), so `isRoad && !isWater` permits real bridge
   * crossings and forbids everything else. Both halves are required.
   */
  _drivable(x, z) {
    const L = this.layout;
    if (!L || !L.isRoad) return false;
    if (Math.abs(x) > WORLD.SIZE || Math.abs(z) > WORLD.SIZE) return false;
    if (!L.isRoad(x, z)) return false;
    if (L.isWater && L.isWater(x, z)) return false;
    if (this.inPlay && !this.inPlay(x, z)) return false;
    return true;
  }

  /**
   * Lazily derive the road grid + the set of legal intersections.
   * Returns false if the layout cannot supply one, which is the signal to the
   * caller that NO UNIT MAY SPAWN. There is no fallback and there must not be:
   * inventing a route is exactly how a police car ends up inside a tower.
   */
  _roads() {
    if (this._nodes) return this._nodes.length > 0;
    const L = this.layout;
    this._rx = []; this._rz = []; this._nodes = [];
    if (!L || !Array.isArray(L.roadsX) || !Array.isArray(L.roadsZ)) return false;

    this._rx = L.roadsX.map((r) => r.pos).slice().sort((a, b) => a - b);
    this._rz = L.roadsZ.map((r) => r.pos).slice().sort((a, b) => a - b);
    for (const x of this._rx) {
      for (const z of this._rz) {
        // Both centrelines AND the two kerb-lane offsets must be drivable,
        // because that is where the unit will actually sit.
        if (!this._drivable(x, z)) continue;
        if (!this._drivable(x + LANE_OFF, z) || !this._drivable(x, z + LANE_OFF)) continue;
        this._nodes.push({ x, z });
      }
    }
    return this._nodes.length > 0;
  }

  /**
   * Where to head to actually meet the hole, rather than where it just was.
   *
   * Lead time is the unit's own travel time to the hole, capped at
   * INTERCEPT_MAX_T — a unit 200 m away leads by the full cap, a unit already
   * alongside leads by almost nothing. Clamped inside the map so the intercept
   * never sits in the bay, where no node exists and _pickNode would return null.
   *
   * @param {number} speed  the intercepting unit's speed (0 => no lead)
   */
  _intercept(hole, speed, dNow, out) {
    const vx = hole.velocity ? hole.velocity.x : 0;
    const vz = hole.velocity ? hole.velocity.z : 0;
    let lead = speed > 0 ? clamp(dNow / speed, 0, HEAT.INTERCEPT_MAX_T) : 0;
    // Distance cap as well as the time cap — see HEAT.INTERCEPT_MAX_D.
    const v = Math.hypot(vx, vz);
    if (v * lead > HEAT.INTERCEPT_MAX_D) lead = HEAT.INTERCEPT_MAX_D / v;
    const lim = WORLD.SIZE - 20;
    out.x = clamp(hole.position.x + vx * lead, -lim, Math.min(lim, WORLD.BAY_EDGE - 10));
    out.z = clamp(hole.position.z + vz * lead, -lim, lim);
    return out;
  }

  /** Blocks the city would rather you left alone — parks, plazas, landmarks. */
  _protectedSites() {
    if (this._protected) return this._protected;
    this._protected = [];
    const blocks = this.layout && this.layout.blocks;
    if (!Array.isArray(blocks)) return this._protected;
    for (const b of blocks) {
      if (b.zone === ZONE.PARK || b.zone === ZONE.PLAZA || b.zone === ZONE.LANDMARK) {
        this._protected.push({ x: b.x, z: b.z });
      }
    }
    return this._protected;
  }

  /**
   * Spawn one unit.
   * @returns {Unit|null} null when no legal road position exists — in which
   * case the unit simply does not exist this tick. The roster will try again
   * next frame from a new hole position. NOTHING IS FUDGED: no off-road
   * placement, no nearest-point snap, no teleport.
   */
  _spawn(kind, hole, now) {
    if (!this._roads()) return null;
    const spec = RESPONSE[kind];
    if (!spec) return null;

    /* Dispatch to the INTERCEPT point, not the hole's current position. The
     * lead is a full INTERCEPT_MAX_T here because at spawn time the unit is by
     * definition at least SPAWN_MIN_R away. */
    const ip = this._intercept(hole, spec.speed, HEAT.SPAWN_MAX_R, _pt);
    const px = ip.x, pz = ip.z;
    const node = kind === 'barrier'
      ? this._barrierNode(hole)
      : this._pickNode(px, pz, HEAT.SPAWN_MIN_R, HEAT.SPAWN_MAX_R);
    if (!node) return null;

    /* Pick which of the two roads meeting at this node to sit on: the one whose
     * travel direction actually reduces the distance to the target, so the unit
     * starts by driving toward the scene rather than away from it. */
    const dx = px - node.x, dz = pz - node.z;
    const alongX = Math.abs(dx) >= Math.abs(dz);
    // axis 'x' means "fixed x, travels along z" — the roadNetwork.js convention.
    const axis = alongX ? 'z' : 'x';
    const dir = alongX ? (dx >= 0 ? 1 : -1) : (dz >= 0 ? 1 : -1);

    const u = {
      id: _uid++,
      kind,
      spec,
      /* --- what the renderer reads --- */
      x: 0, z: 0, yaw: 0,
      state: kind === 'barrier' ? 'placed' : 'arriving',
      /* --- routing --- */
      axis,
      line: axis === 'x' ? node.x : node.z,
      free: axis === 'x' ? node.z : node.x,
      dir,
      /* --- behaviour --- */
      hole,
      stateT: now,
      born: now,
      // Not zero (nobody fires the instant they arrive) but short: contact
      // with a fast hole lasts seconds, and a half-reload of dead time on
      // arrival threw away most of the windows a unit ever gets.
      cdPulse: now + HEAT.UNIT_CD * 0.25,
      warnT: 0,
      mark: null,
      stuck: 0,
      retreatT: 0,
      /** False until the first _place, which snaps rather than eases. */
      placed: false,
      /** Free-running phase so the renderer can flash lights without state. */
      siren: this.rng() * Math.PI * 2,
      dead: false,
    };
    this._place(u, 0);
    return u;
  }

  /**
   * The exact lane position + heading implied by the route state.
   *
   * Keep-right lane offset, mirroring roadNetwork.js: for a road along +z
   * (axis 'x') forward=+z has its right hand toward -x, so the kerb lane sits
   * at negative x; for a road along +x (axis 'z') right is +z. Getting this
   * backwards puts every response vehicle in oncoming traffic.
   *
   * Yaw uses the same discrete values as RoadNetwork.headingOf — 0 for +z,
   * PI for -z, +PI/2 for +x, -PI/2 for -x — so a response vehicle and a
   * traffic vehicle built from the same mesh face the same way.
   */
  _ideal(u, out) {
    if (u.axis === 'x') {
      out.x = u.line - LANE_OFF * u.dir;
      out.z = u.free;
      out.yaw = u.dir > 0 ? 0 : Math.PI;
    } else {
      out.x = u.free;
      out.z = u.line + LANE_OFF * u.dir;
      out.yaw = u.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
    }
    return out;
  }

  /**
   * Publish x/z/yaw for the renderer as a RATE-LIMITED FOLLOWER of the ideal.
   *
   * THE CORNER PROBLEM. The two lanes meeting at a junction sit LANE_OFF off
   * their centrelines in perpendicular directions, so the instant a unit turns,
   * its ideal position moves ~2.4 m sideways and its yaw flips 90 degrees in
   * one frame. Measured against the real Miami layout that was a 2.6 m
   * single-frame jump. It is not a routing error — both endpoints are inside
   * the junction box, whose half-width is 11 m and up, so it can never leave
   * the road — but it is a visible pop and an instant spin, and a reviewer
   * looking at it would rightly call it a teleport.
   *
   * A fixed-duration ease was tried first and rejected: the ideal keeps moving
   * along the new lane while the ease runs, so the interpolant has to cover
   * (lateral gap + travel) in the ease window and its final frame spikes.
   * Measured, that still produced a 0.73 m step.
   *
   * Chasing at a capped rate instead gives a bound that holds by construction:
   *   |delta per frame| <= CORNER_CHASE * speed * dt
   * CORNER_CHASE is 1.6, so the closing rate on a target moving at `speed` is
   * at least 0.6*speed and a 2.4 m corner resolves in ~0.24 s — about as long
   * as a car actually takes to swing through a junction. On a straight the gap
   * is zero and the follower tracks the lane exactly.
   *
   * Barriers have speed 0, which makes maxStep 0, which snaps — correct, since
   * a barrier never moves after placement.
   */
  _place(u, dt = 0) {
    const id = this._ideal(u, _ideal);
    const maxStep = u.spec.speed * CORNER_CHASE * dt;
    if (dt <= 0 || !u.placed || maxStep <= 0) {
      u.x = id.x; u.z = id.z; u.yaw = id.yaw; u.placed = true;
      return;
    }
    const dx = id.x - u.x, dz = id.z - u.z;
    const d = Math.hypot(dx, dz);
    if (d <= maxStep) { u.x = id.x; u.z = id.z; }
    else { u.x += (dx / d) * maxStep; u.z += (dz / d) * maxStep; }

    let dy = id.yaw - u.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    const maxYaw = YAW_RATE * dt;
    u.yaw += clamp(dy, -maxYaw, maxYaw);
  }

  /**
   * NEAREST legal intersection to (x,z) that is at least minR away.
   *
   * "Nearest" is load-bearing and was wrong first time round: the original
   * scored toward the middle of the annulus to spread units out, which
   * dispatched them ~96 m from the intercept point. At 17 m/s that is a
   * five-and-a-half second drive, during which a mid-game hole covers 170 m,
   * so every unit arrived where the player used to be. Measured: average unit
   * distance 144 m, eight telegraphed shots in four minutes.
   *
   * Spread now comes from a bounded jitter on the reference point instead,
   * which perturbs the choice by a junction or two without ever preferring a
   * far one.
   */
  _pickNode(x, z, minR, maxR, awayFrom) {
    const nodes = this._nodes;
    let best = null, bestD = Infinity;
    // Jitter so three cruisers do not all pick the same junction.
    const jx = this.rng.range ? this.rng.range(-22, 22) : 0;
    const jz = this.rng.range ? this.rng.range(-22, 22) : 0;
    for (const n of nodes) {
      const d = Math.hypot(n.x - x, n.z - z);
      if (d < minR || d > maxR) continue;
      if (awayFrom && Math.hypot(n.x - awayFrom.x, n.z - awayFrom.z) < awayFrom.r) continue;
      const score = Math.hypot(n.x - x - jx, n.z - z - jz);
      if (score < bestD) { bestD = score; best = n; }
    }
    return best;
  }

  /**
   * A barrier goes between the hole and whatever it is about to ruin: the
   * nearest park/plaza/landmark block. It must still land on a road, so we take
   * the legal intersection closest to the midpoint of that line. If the layout
   * has no protected blocks (a stub, a test map) it falls back to a node just
   * outside the hole — still road-legal, still useful as a cordon.
   */
  _barrierNode(hole) {
    const px = hole.position.x, pz = hole.position.z;
    /* Never inside BARRIER_MIN_R of the hole, however good the site looks —
     * see HEAT.BARRIER_MIN_R. Enforced by the exclusion argument rather than by
     * the annulus, because the annulus is measured from the SITE, not the hole. */
    _avoid.x = px; _avoid.z = pz; _avoid.r = HEAT.BARRIER_MIN_R;
    const sites = this._protectedSites();
    let tx = px, tz = pz, bestD = Infinity;
    for (const s of sites) {
      const d = Math.hypot(s.x - px, s.z - pz);
      if (d < bestD && d < 220) { bestD = d; tx = s.x; tz = s.z; }
    }
    const fallback = () => this._pickNode(px, pz, HEAT.BARRIER_MIN_R, 80, _avoid);
    if (bestD === Infinity) return fallback();
    const mx = px + (tx - px) * 0.45, mz = pz + (tz - pz) * 0.45;
    return this._pickNode(mx, mz, 0, 70, _avoid) || fallback();
  }

  /**
   * March a unit along its road toward (tx, tz), turning only at real
   * intersections. Manhattan-greedy: at each junction, commit to whichever axis
   * currently has the bigger remaining error.
   *
   * This is not A*. On a full grid greedy Manhattan is complete, and where the
   * grid is not full — the bay, the river, the ends of the map — the unit
   * simply fails to make progress and `stuck` retires it (see _updateUnit).
   * That is the honest failure: the unit LEAVES. It never cuts a corner, never
   * snaps to the target, never crosses a block.
   *
   * Mutates the route state only. The caller publishes x/z/yaw via _place, so
   * that the corner ease is advanced by dt exactly once per frame.
   */
  _advance(u, dt, tx, tz, avoid) {
    let remaining = u.spec.speed * dt;
    if (remaining <= 0) return true;

    const cross = u.axis === 'x' ? this._rz : this._rx;  // perpendicular lines
    let guard = 0;
    let moved = 0;

    while (remaining > 1e-4 && guard++ < 6) {
      // Where is the next perpendicular road along our direction of travel?
      let next = null;
      for (const c of cross) {
        const ahead = (c - u.free) * u.dir;
        if (ahead > 0.05 && (next === null || ahead < (next - u.free) * u.dir)) next = c;
      }
      const distToNext = next === null ? Infinity : Math.abs(next - u.free);

      if (distToNext > remaining) {
        const nf = u.free + u.dir * remaining;
        if (!this._legal(u, nf)) break;              // dead end / water ahead
        if (this._blocked(u, nf, avoid)) break;      // there is a hole in the road
        u.free = nf;
        moved += remaining;
        remaining = 0;
        break;
      }

      // Reach the junction exactly, then decide.
      if (!this._legal(u, next)) break;
      if (this._blocked(u, next, avoid)) break;
      u.free = next;
      moved += distToNext;
      remaining -= distToNext;

      const here = u.axis === 'x' ? { x: u.line, z: u.free } : { x: u.free, z: u.line };
      const ex = tx - here.x, ez = tz - here.z;
      const errAlong = u.axis === 'x' ? ez : ex;      // error on our current axis
      const errCross = u.axis === 'x' ? ex : ez;      // error on the other axis

      const wantTurn = Math.abs(errCross) > Math.abs(errAlong) + 1
        || errAlong * u.dir < 0;                      // we have overshot: turn
      if (!wantTurn) continue;

      const newAxis = u.axis === 'x' ? 'z' : 'x';
      const newDir = errCross >= 0 ? 1 : -1;
      const saved = { axis: u.axis, line: u.line, free: u.free, dir: u.dir };
      u.axis = newAxis;
      u.line = newAxis === 'x' ? here.x : here.z;
      u.free = newAxis === 'x' ? here.z : here.x;
      u.dir = newDir;
      // Probe one metre down the new leg. If it is not road, undo the turn —
      // this is what stops a unit turning onto a road that stops at the water.
      if (!this._legal(u, u.free + u.dir * 1.0)) {
        u.axis = saved.axis; u.line = saved.line; u.free = saved.free; u.dir = saved.dir;
      }
    }

    return moved > 1e-3;
  }

  /**
   * Would this unit still be on a legal road at free-coordinate `f`?
   * Checks the LANE POSITION, not the centreline, because that is where the
   * vehicle actually is.
   */
  _legal(u, f) {
    if (u.axis === 'x') return this._drivable(u.line - LANE_OFF * u.dir, f);
    return this._drivable(f, u.line + LANE_OFF * u.dir);
  }

  /**
   * Would moving to free-coordinate `f` drive this unit INTO the hole?
   *
   * Drivers can see a hundred-foot sinkhole in the road and stop short of it.
   * Without this, routing was hole-blind: a unit whose road happened to pass
   * through the hole drove straight in and was eaten, and since the roster
   * immediately dispatched a replacement, a player could park on a junction at
   * heat 3 and farm response vehicles. Measured, a stationary hole harvested
   * 19,600 points that way — free score for doing nothing, which is the
   * opposite of a consequence system.
   *
   * Escaping OUTWARD is always allowed, so a unit that the hole grew over can
   * still drive clear rather than being frozen in place until it is swallowed.
   */
  _blocked(u, f, avoid) {
    if (!avoid) return false;
    const x = u.axis === 'x' ? u.line - LANE_OFF * u.dir : f;
    const z = u.axis === 'x' ? f : u.line + LANE_OFF * u.dir;
    const dNew = Math.hypot(x - avoid.x, z - avoid.z);
    if (dNew >= avoid.r) return false;
    const dOld = Math.hypot(u.x - avoid.x, u.z - avoid.z);
    return dNew < dOld;
  }

  /* ---------------------------------------------------------------------- *
   * unit behaviour
   * ---------------------------------------------------------------------- */

  _updateUnit(u, dt, now) {
    if (u.state === 'devoured') { u.dead = true; return; }

    const hole = u.hole && u.hole.alive !== false ? u.hole : this.focus;
    u.hole = hole;
    if (!hole) this._sendHome(u, now);

    /* With no hole to reference, "away from the target" is meaningless, so a
     * homeless unit just keeps driving the way it was already pointing —
     * still on its own road, still turning only at junctions. */
    const px = hole ? hole.position.x : u.x - (u.axis === 'x' ? 0 : u.dir);
    const pz = hole ? hole.position.z : u.z - (u.axis === 'x' ? u.dir : 0);
    const d = hole ? Math.hypot(px - u.x, pz - u.z) : 0;

    /* ---- route 3 out: the hole is big enough to eat this ----------------- */
    if (hole && this._tryDevour(u, hole, d, now)) return;

    /* ---- leaving -------------------------------------------------------- */
    if (u.state === 'leaving') {
      if (u.spec.mobile) {
        // Drive away from the hole: aim at a point 400 m in the escape
        // direction. The router will only ever follow real roads there.
        this._advance(u, dt, u.x + (u.x - px) * 8, u.z + (u.z - pz) * 8, null);
        this._place(u, dt);
      }
      if (now - u.stateT > HEAT.LEAVE_LIFE || d > HEAT.DESPAWN_R) u.dead = true;
      return;
    }

    /* ---- barriers are static ------------------------------------------- */
    if (!u.spec.mobile) {
      if (d > HEAT.DESPAWN_R) u.dead = true;
      return;
    }

    /* ---- give up on a hopeless chase ------------------------------------ */
    // Without this a mobile unit that fell behind trailed the hole forever,
    // never in range to do anything, and — because it still counted as a live
    // unit — blocked the roster from dispatching a fresh one further ahead.
    if (d > HEAT.DESPAWN_R) { this._sendHome(u, now); return; }

    /* ---- drive ---------------------------------------------------------- */
    const tier = hole ? this.tierOf(hole) : 0;
    const scared = hole ? hole.trueRadius >= u.spec.devourR * 0.92 : false;
    const standoff = scared ? HEAT.STANDOFF_SCARED : HEAT.STANDOFF;

    // Aim at the intercept, not at where the hole has already been.
    const ip = hole ? this._intercept(hole, u.spec.speed, d, _pt) : null;
    let tx = ip ? ip.x : px, tz = ip ? ip.z : pz;
    if (u.retreatT > now || (scared && d < standoff)) {
      // Back off along the road, away from the hole.
      tx = u.x + (u.x - px) * 6;
      tz = u.z + (u.z - pz) * 6;
      const hs = this._st(hole);
      if (scared && !hs.announcedBigger) {
        hs.announcedBigger = true;
        this._cue(hole, VOICE_CUES.NEED_BIGGER);
      }
    } else if (d < standoff) {
      // Hold position. Standing off is what makes devouring a unit something
      // the PLAYER chooses to do, rather than something that happens to them.
      tx = u.x; tz = u.z;
    }

    /* The hole itself is an obstacle in the road network. Radius is the
     * drawn opening plus the vehicle's own footprint plus a metre of nerve. */
    _avoid.x = px; _avoid.z = pz;
    _avoid.r = hole ? hole.radius + u.spec.radius + 1.0 : 0;

    const holding = (tx === u.x && tz === u.z);
    const progressed = holding ? true : this._advance(u, dt, tx, tz, hole ? _avoid : null);
    // Always republish: a unit holding station mid-corner still has an ease to
    // finish, and skipping it would freeze it half-way through a turn.
    this._place(u, dt);
    u.stuck = progressed ? 0 : u.stuck + dt;
    if (u.stuck > HEAT.STUCK_T) {
      // No road route to where it wants to be. It gives up and leaves; it does
      // NOT teleport, nudge off-road, or phase through the block in its way.
      this._sendHome(u, now);
      return;
    }
    if (u.state === 'arriving' && d < HEAT.FIRE_RANGE * 1.4) { u.state = 'patrol'; u.stateT = now; }

    /* ---- pulses --------------------------------------------------------- */
    if (hole) this._updatePulse(u, hole, d, tier, now);
  }

  /**
   * Telegraph -> fixed marker -> foam.
   *
   * The marker is placed ONCE, at fire-decision time, at where the hole is
   * heading. It does not track. That single property is what makes every hit
   * avoidable: the answer is always "be somewhere else in 1.6 seconds", and a
   * hole's slowest speed (HOLE.BASE_SPEED at start size) covers 31 m in that
   * window against a 7 m marker.
   */
  _updatePulse(u, hole, d, tier, now) {
    const s = this._st(hole);

    if (u.state === 'warn') {
      // Derived from the deadline rather than decremented, so a dropped frame
      // cannot leave a telegraph counting down forever.
      u.warnT = Math.max(0, u.fireAt - now);
      if (now >= u.fireAt) this._fire(u, hole, s, now);
      return;
    }

    if (!u.spec.fires) return;
    if (tier < 2) return;                       // tier 1 shouts, it does not act
    if (hole.spawnGrace > 0) return;            // never during respawn immunity
    if (now < s.lastHitT + HEAT.HIT_GAP) return;// mercy window after a landed hit
    if (now < u.cdPulse) return;
    if (d > HEAT.FIRE_RANGE || d < 6) return;

    /* Lead the target, then clamp the marker inside the firing envelope so a
     * fleeing player is never marked somewhere the unit could not reach. */
    const vx = hole.velocity ? hole.velocity.x : 0;
    const vz = hole.velocity ? hole.velocity.z : 0;
    const lead = HEAT.WARN_T * HEAT.LEAD_FRAC;
    let mx = hole.position.x + vx * lead;
    let mz = hole.position.z + vz * lead;
    const md = Math.hypot(mx - u.x, mz - u.z);
    if (md > HEAT.FIRE_RANGE) {
      const k = HEAT.FIRE_RANGE / md;
      mx = u.x + (mx - u.x) * k;
      mz = u.z + (mz - u.z) * k;
    }

    u.state = 'warn';
    u.stateT = now;
    u.fireAt = now + HEAT.WARN_T;
    u.warnT = HEAT.WARN_T;
    u.mark = { x: mx, z: mz, r: HEAT.PULSE_R, t0: now, t1: now + HEAT.WARN_T };

    /* TELEGRAPH, BELT AND BRACES.
     * effects.shockwave() draws from a pool of 24 rings and SILENTLY DOES
     * NOTHING when they are all busy — during a big collapse they will be. A
     * warning that is sometimes invisible is worse than no warning, so the
     * authoritative telegraph is `u.mark`, which the renderer must draw as a
     * ground decal for its whole lifetime. The ring below is garnish. */
    const fx = this.effects;
    if (fx) {
      _v2.set(mx, 0.06, mz);
      fx.shockwave(_v2, HEAT.PULSE_R * 0.18, HEAT.PULSE_R, COL.WARN, HEAT.WARN_T);
      if (hole.isPlayer) {
        _v.set(mx, 1.2, mz);
        fx.popup(_v, 'CONTAINMENT PULSE', COL.WARN, false);
      }
    }
    this._sfx(SFX.WARN, () => this.audio && this.audio.countdownBeep && this.audio.countdownBeep(false));
    this._cue(hole, VOICE_CUES.PULSE_CHARGE, u.x, u.z);
  }

  /**
   * Resolve the shot.
   *
   * HIT TEST USES THE HOLE'S CENTRE against the marker radius, deliberately NOT
   * rim-vs-radius. A 34 m hole overlaps a 7 m circle from 40 m away; if overlap
   * counted, growing would make you progressively impossible to miss, which
   * inverts the whole point of the size ladder. Centre-in-circle means the
   * dodge distance is the same at every size.
   */
  _fire(u, hole, s, now) {
    u.state = 'patrol';
    u.stateT = now;
    u.cdPulse = now + HEAT.UNIT_CD;
    u.warnT = 0;
    const m = u.mark;
    u.mark = null;
    if (!m) return;

    const dist = Math.hypot(hole.position.x - m.x, hole.position.z - m.z);
    const inside = dist <= m.r;
    const gapOK = now - s.lastHitT >= HEAT.HIT_GAP;

    const fx = this.effects;
    // At the MARKER, not at the unit: the foam lands on the circle the player
    // was told to get out of, and that is where it should be heard from.
    this._sfx(SFX.PULSE, () => this.audio && this.audio.ui && this.audio.ui('back'), m.x, m.z);

    if (inside && gapOK) {
      s.lastHitT = now;
      s.misses = 0;
      const res = this._penalty(hole, s, now);
      if (fx) {
        _v.set(m.x, 0.5, m.z);
        fx.puff(_v, COL.FOAM, 22, m.r * 0.7, 4.2, 0.85, 1.1);
        fx.sparks(_v, COL.WARN, 6, 5, 1.2, 0.5);
        fx.shockwave(_v, m.r * 0.3, m.r * 1.25, COL.FOAM, 0.4);
        if (hole.isPlayer) {
          fx.addShake(0.18);
          _v.set(hole.position.x, 1.6, hole.position.z);
          fx.popup(_v, res.kind === 'score' ? `-${res.loss}` : 'VACUUM JAMMED', COL.FOAM, true);
        }
      }
      this._sfx(SFX.PENALTY, () => this.audio && this.audio.ui && this.audio.ui('back'));
      this._cue(hole, VOICE_CUES.PULSE_HIT, u.x, u.z);
      if (this.hud && this.hud.pushFeed && hole.isPlayer) {
        this.hud.pushFeed(res.kind === 'score'
          ? `<b>CONTAINED</b> — ${res.loss} pts of foam. Dodge the marked circle.`
          : '<b>CONTAINED</b> — Vacuum Boost jammed for 5s.', '#bfe9ff', 'heat');
      }
      return;
    }

    /* A miss — either they genuinely dodged, or the anti-stun-lock gap ate the
     * hit. Both look identical on screen (foam on empty tarmac) and neither
     * costs the player anything, but only a genuine dodge counts toward the
     * disengage, because the gap-eaten one was not skill. */
    if (fx) {
      _v.set(m.x, 0.35, m.z);
      fx.puff(_v, COL.FOAM, 12, m.r * 0.55, 3.0, 0.6, 0.8);
    }
    if (!inside) {
      s.misses++;
      this._cue(hole, VOICE_CUES.PULSE_MISS, u.x, u.z);
      if (s.misses >= HEAT.MISS_DISENGAGE) {
        /* ROUTE 2 OUT. Dodge three in a row and this unit is done with you. */
        s.misses = 0;
        s.heat = Math.max(0, s.heat - HEAT.DISENGAGE_COOL);
        this._sendHome(u, now);
        // A shorter breather than route 1, but the slot must not refill on the
        // very next frame or dodging buys the player nothing at all.
        this._nextDispatch = Math.max(this._nextDispatch, now + HEAT.DISPATCH_GAP * 3);
        this._cue(hole, VOICE_CUES.STAND_DOWN, u.x, u.z);
        if (this.hud && this.hud.pushFeed && hole.isPlayer) {
          this.hud.pushFeed('<b>SHOOK THEM OFF</b> — a unit is standing down.', '#7dffbe', 'heat');
        }
      }
    }
  }

  /**
   * THE CAPPED PENALTY.
   *
   *   loss = clamp(round(score * 2%), 5, 120)
   *   loss = min(loss, score)                      never negative score
   *   loss = min(loss, score - tierFloorScore)     NEVER DEMOTES A SIZE TIER
   *
   * The tier clamp is the important one. Dropping a tier means props you could
   * eat one second ago are suddenly locked — that is not "a small capped
   * amount of points", it is a rollback of progress, and the spec bans it.
   * When the clamp leaves nothing to take, the hit weakens Vacuum Boost
   * instead, so a contained player always feels something and never loses
   * anything they cannot get back in a few seconds.
   */
  _penalty(hole, s, now) {
    // Prefer the vacuum debuff when the boost is actually running: it is the
    // more interesting consequence and costs no score at all.
    if (this.hasVacuum && this.hasVacuum(hole)) {
      s.vacUntil = now + HEAT.VAC_T;
      return { kind: 'vacuum', loss: 0 };
    }

    const score = Math.max(0, hole.score || 0);
    let loss = clamp(Math.round(score * HEAT.PENALTY_FRAC), HEAT.PENALTY_MIN, HEAT.PENALTY_CAP);
    loss = Math.min(loss, score);

    const tierIdx = clamp(hole.tier | 0, 0, TIER_LIST.length - 1);
    const floor = scoreForRadius(TIER_LIST[tierIdx].eatRadius);
    loss = Math.min(loss, Math.max(0, Math.floor(score - floor)));

    if (loss <= 0) {
      s.vacUntil = now + HEAT.VAC_T;
      return { kind: 'vacuum', loss: 0 };
    }

    // No label: Hole.addScore sets lastMeal from it, and "containment pulse"
    // is not a meal. The negative delta is safe — addScore only ever kicks the
    // size spring outward (see the comment at hole.js addScore).
    hole.addScore(-loss);
    return { kind: 'score', loss };
  }

  /**
   * ROUTE 3 OUT: the hole eats the response unit.
   *
   * Response units are heat.js-owned entities. They are NOT registered in the
   * ConsumeSystem registry and have no Consumable behind them, so there is no
   * duplicate scene object and no double award — hole.addScore here is the only
   * score path for them, exactly as _capture is the only score path for real
   * props. Do not "helpfully" also register them; that is how you get a prop
   * that pays twice.
   */
  _tryDevour(u, hole, d, now) {
    if (d > hole.radius * 0.9 + u.spec.radius * 0.35) return false;

    if (hole.trueRadius < u.spec.devourR) {
      /* Too small: the unit does not get eaten and does not get hurt. It slams
       * into reverse along its own road — still road-legal, still no contact
       * damage in either direction. Contact never costs the player anything;
       * only the telegraphed foam does. */
      if (u.spec.mobile && u.retreatT < now) { u.dir = -u.dir; u.retreatT = now + 2.2; }
      return false;
    }

    u.state = 'devoured';
    u.dead = true;
    hole.addScore(u.spec.score, u.spec.label);
    this._add(hole, HEAT.DEVOUR_GAIN, 'devoured-unit');

    const fx = this.effects;
    if (fx) {
      _v.set(u.x, 0.9, u.z);
      fx.puff(_v, 0xf3ead8, 16, 1.6, 5.0, 1.0, 1.0);
      fx.chunks(_v, COL.WARN, 8, 0.32, 6, 1.1);
      if (hole.isPlayer) {
        fx.addShake(0.22);
        _v.set(u.x, 1.4, u.z);
        fx.popup(_v, `+${u.spec.score} ${u.spec.label}`, COL.WARN, true);
      }
    }
    /* Player-gated and tier-carrying, for the reason spelled out on _announce:
       heatUp is non-positional and ducks the whole mix, and bots devour far
       more response vehicles than the player does — 39 against 8 in a measured
       match, every one of them previously a full-volume sting for something
       happening off screen. */
    if (hole.isPlayer) {
      this._sfx(SFX.HEAT_UP, () => this.audio && this.audio.crumble && this.audio.crumble(2),
        this.tierOf(hole));
    }
    this._cue(hole, VOICE_CUES.LOST_VEHICLE, u.x, u.z);
    if (this.hud && this.hud.pushFeed && hole.isPlayer) {
      this.hud.pushFeed(`<b>${u.spec.label}</b> swallowed. That will not calm them down.`,
        '#ffd23f', 'heat');
    }
    return true;
  }

  /**
   * ROUTE 1 OUT: sustained distance from every unit.
   * Requires LEAVE_T seconds of continuous separation, so clipping past the
   * radius for a frame does not dismiss the response.
   */
  _checkLeaveZone(dt, now) {
    const hole = this.focus;
    if (!hole) return;
    const s = this._st(hole);
    /* Gated on `engaged`, NOT on the roster being non-empty.
     * Requiring live units meant the players who escaped best were the ones
     * who did not get credit: sprint far enough and every unit trips the
     * DESPAWN_R cull within a frame or two, the array empties, and the away
     * timer that grants the stand-down never ran. _nearestUnitDist reports
     * FAR_R with nobody on the map, which is exactly the "you are clear"
     * reading we want it to accumulate against. */
    if (!s.engaged) return;
    const d = this._nearestUnitDist(hole);
    if (d > HEAT.LEAVE_R) s.awayT += dt; else s.awayT = 0;
    if (s.awayT < HEAT.LEAVE_T) return;
    s.awayT = 0;
    s.engaged = false;
    for (const u of this._units) if (u.state !== 'leaving') this._sendHome(u, now);
    /* SUPPRESS REDISPATCH, or route 1 does not exist.
     * Sending the roster home is not a disengage on its own: _maintainRoster
     * refills the slot on the next tick, from an intercept point AHEAD of the
     * player, so the nearest-unit distance never stays above LEAVE_R and the
     * away timer can never complete twice. Measured, a player doing nothing but
     * running sat at heat 1.0 for the whole match. The hold is the actual
     * reward for shaking them off: no units on the map means the cooling ramp
     * runs at its far-distance rate, which is worth ~0.4 of the meter. */
    this._nextDispatch = Math.max(this._nextDispatch, now + HEAT.DISENGAGE_HOLD);
    s.heat = Math.max(0, s.heat - HEAT.DISENGAGE_COOL);
    this._cue(hole, VOICE_CUES.STAND_DOWN);
    if (this.hud && this.hud.pushFeed && hole.isPlayer) {
      this.hud.pushFeed('<b>OUT OF THE ZONE</b> — the response has lost you.', '#7dffbe', 'heat');
    }
  }

  /* ---------------------------------------------------------------------- *
   * audio / voice plumbing
   * ---------------------------------------------------------------------- */

  /**
   * Call an optional audio method by name, falling back to a verified one.
   * Never guesses: if `name` is absent the fallback runs, and the fallback only
   * ever touches methods that exist today in src/core/audio.js.
   *
   * TWO POSITIONAL ARGUMENTS, not a rest parameter: this runs on every pulse
   * and every dispatch, and the house rule in this file is that nothing on a
   * hot path allocates. They are what the audio API actually wants — `(x, z)`
   * for the positional sounds, `(tier)` for heatUp. Passing none used to be the
   * bug rather than the default: heatUp() with no tier always played its
   * tier-1 variant (73 of 78 calls in a measured match), and
   * containmentPulse() with no coordinates played the foam splat flat in the
   * middle of the mix instead of where the marker landed.
   */
  _sfx(name, fallback, a1, a2) {
    const a = this.audio;
    if (a && typeof a[name] === 'function') { a[name](a1, a2); return; }
    if (fallback) { try { fallback(); } catch { /* audio must never break a tick */ } }
  }

  /**
   * Emit a voice cue ID. Rate limited two ways — a global gap so the city does
   * not chatter over itself, and a per-cue repeat guard so the same line does
   * not land twice in a row. The voice module owns concurrency, captions and
   * the actual audio; all we publish is which line the moment calls for.
   */
  _cue(hole, id, x, z) {
    const now = this.t;
    if (now - this._lastCueT < HEAT.CUE_GAP) return false;
    const last = this._cueAt.get(id) || -1e9;
    if (now - last < HEAT.CUE_REPEAT) return false;
    this._lastCueT = now;
    this._cueAt.set(id, now);
    const px = Number.isFinite(x) ? x : (hole && hole.position ? hole.position.x : 0);
    const pz = Number.isFinite(z) ? z : (hole && hole.position ? hole.position.z : 0);
    if (this.voice && typeof this.voice.say === 'function') {
      this.voice.say(id, { x: px, z: pz, speaker: 'cityResponse', priority: 2 });
    }
    this.lastCue = id;
    return true;
  }
}

/* ========================================================================== *
 * SELF TEST
 *
 * Runs headless under plain node:  node -e "import('./src/gameplay/heat.js')
 *   .then(m => m.__selftest())"
 *
 * Uses STUBS, not the real Hole/Effects/Layout, so it stays fast and cannot be
 * broken by unrelated render work. Every stub field below is part of the
 * verified contract this module actually reads.
 * ========================================================================== */

function _stubHole(score = 0, isPlayer = true) {
  const h = {
    position: new THREE.Vector3(0, 0, 0),
    velocity: new THREE.Vector3(0, 0, 0),
    score,
    alive: true,
    spawnGrace: 0,
    isPlayer,
    get radius() { return Math.min(HOLE.MAX_RADIUS, this.trueRadius); },
    get trueRadius() { return HOLE.START_RADIUS * Math.pow(1 + this.score / HOLE.GROWTH_K, HOLE.GROWTH_P); },
    get tier() {
      let t = 0;
      for (let i = 0; i < TIER_LIST.length; i++) if (this.radius >= TIER_LIST[i].eatRadius) t = i;
      return t;
    },
    addScore(n) { this.score = Math.max(0, this.score + n); return n; },
  };
  return h;
}

/** A 100 m square grid, fully drivable, no water. */
function _stubLayout() {
  const lines = [-200, -100, 0, 100, 200];
  const half = 11;
  return {
    roadsX: lines.map((pos) => ({ pos, half, cls: 'street' })),
    roadsZ: lines.map((pos) => ({ pos, half, cls: 'street' })),
    blocks: [{ x: 50, z: 50, w: 60, d: 60, zone: ZONE.PLAZA }],
    isRoad(x, z) {
      for (const p of lines) if (Math.abs(x - p) < half) return true;
      for (const p of lines) if (Math.abs(z - p) < half) return true;
      return false;
    },
    isWater() { return false; },
  };
}

const _noFx = {
  puff() {}, sparks() {}, chunks() {}, shockwave() {}, popup() {}, addShake() {},
};

export function __selftest() {
  const fails = [];
  const ok = (cond, msg) => { if (!cond) fails.push(msg); };
  const near = (a, b, eps, msg) => ok(Math.abs(a - b) <= eps, `${msg} (got ${a}, want ~${b})`);

  const mk = (extra = {}) => new HeatSystem({
    rng: makeRNG(7), layout: _stubLayout(), effects: _noFx, ...extra,
  });
  /* A system that can never spawn a unit, for isolating the heat maths. A
   * roadless layout is the honest way to get that: _roads() finds nothing and
   * _spawn refuses, which is the same code path the real game takes over the
   * bay. */
  const mkBare = () => new HeatSystem({
    rng: makeRNG(11), effects: _noFx,
    layout: { isRoad: () => false, isWater: () => false },
  });

  /* ---- 1. heat rises with tier and importance ------------------------- */
  {
    const hs = mk();
    const hole = _stubHole(500);
    ok(hs.heatOf(hole) === 0, 'a fresh hole starts cold');

    hs.onConsumed(hole, { tier: TIER.TINY, kind: 'litter', label: 'Water Bottle' });
    ok(hs.heatOf(hole) === 0, 'litter must generate exactly zero heat');

    hs.onConsumed(hole, { tier: TIER.SMALL, kind: 'bench', label: 'Bench' });
    near(hs.heatOf(hole), HEAT.GAIN_BY_TIER[1], 1e-9, 'a bench adds its tier gain');

    const before = hs.heatOf(hole);
    hs.onConsumed(hole, { tier: TIER.LARGE, kind: 'police', label: 'Police Car' });
    near(hs.heatOf(hole) - before, HEAT.GAIN_BY_TIER[3] * 3.0, 1e-9,
      'a police car is 3x a plain tier-3 object');

    const b2 = hs.heatOf(hole);
    hs.onConsumed(hole, { tier: TIER.LARGE, kind: 'sedan', label: 'Sedan' });
    near(hs.heatOf(hole) - b2, HEAT.GAIN_BY_TIER[3], 1e-9, 'an ordinary car is 1x');

    // No single item may spike the meter.
    const hs2 = mk();
    const h2 = _stubHole(0);
    hs2.onConsumed(h2, { tier: TIER.LANDMARK, kind: 'police', label: 'Police Car' });
    ok(hs2.heatOf(h2) <= HEAT.GAIN_CAP + 1e-9, 'per-item gain is capped');

    /* THE METER IS BOUNDED. This shipped broken once: HEAT.MAX was referenced
     * by _add but never defined on the object, so clamp(v, 0, undefined)
     * returned v and heat ran to 13.9 over a four-minute match. Nothing threw,
     * nothing logged, the tiers just pinned at 3 and never came down. */
    const hs3 = mk();
    const h3 = _stubHole(0);
    hs3.bump(h3, 99);
    ok(hs3.heatOf(h3) === HEAT.MAX, 'a giant bump saturates at HEAT.MAX, it does not overflow');
    for (let i = 0; i < 5000; i++) {
      hs3.onConsumed(h3, { tier: TIER.LANDMARK, kind: 'police', label: 'Police Car' });
    }
    ok(hs3.heatOf(h3) <= HEAT.MAX, 'five thousand landmarks cannot push heat past MAX');
    hs3.bump(h3, -99);
    ok(hs3.heatOf(h3) === 0, 'and it bottoms out at zero, not below');
  }

  /* ---- 2. tier thresholds + hysteresis -------------------------------- */
  {
    const hs = mkBare();
    const hole = _stubHole(500);
    hs.bump(hole, HEAT.UP[1] - 0.01);
    hs.update(0.016, [hole], 1);
    ok(hs.tierOf(hole) === 0, 'just below the tier-1 line is still tier 0');

    hs.bump(hole, 0.02);
    hs.update(0.016, [hole], 2);
    ok(hs.tierOf(hole) === 1, 'crossing UP[1] promotes to tier 1');

    // Hysteresis: sitting between DOWN[1] and UP[1] must NOT demote.
    hs.state.get(hole).heat = (HEAT.UP[1] + HEAT.DOWN[1]) / 2;
    hs.update(0.016, [hole], 10);
    ok(hs.tierOf(hole) === 1, 'the hysteresis band holds the tier (no strobing)');

    hs.state.get(hole).heat = HEAT.DOWN[1] - 0.01;
    hs.update(0.016, [hole], 20);
    ok(hs.tierOf(hole) === 0, 'falling below DOWN[1] demotes');

    // Dwell: two changes inside DWELL seconds are not allowed.
    hs.state.get(hole).heat = HEAT.UP[3] + 0.05;
    hs.update(0.016, [hole], 20.5);
    ok(hs.tierOf(hole) === 0, 'DWELL blocks a second tier change within 2s');
    hs.update(0.016, [hole], 24);
    ok(hs.tierOf(hole) === 3, 'after DWELL the change lands');
  }

  /* ---- 3. decay --------------------------------------------------------- */
  {
    /* Measured with NO units in existence. With units on the map they park at
     * STANDOFF (18 m), which is inside HOLD_R (34 m), and the meter correctly
     * freezes — that is the separate assertion at the end of this block. */
    const hs = mkBare();
    const hole = _stubHole(500);
    hs.bump(hole, 0.6);
    const h0 = hs.heatOf(hole);

    /* Inside COOL_DELAY cooling is THROTTLED to COOL_BUSY, not stopped. It
     * used to be a hard gate, which turned the meter into a ratchet for anyone
     * eating continuously — see HEAT.COOL_BUSY. Verified as a ratio against an
     * identical run outside the window, so the assertion survives retuning. */
    for (let i = 0; i < 60; i++) hs.update(1 / 60, [hole], 0.1 + i / 60);
    const busyDrop = h0 - hs.heatOf(hole);
    ok(busyDrop > 0, 'cooling is throttled inside COOL_DELAY, not switched off');

    const hsFree = mkBare();
    const hFree = _stubHole(500);
    hsFree.bump(hFree, 0.6);
    for (let i = 0; i < 60; i++) hsFree.update(1 / 60, [hFree], 20 + i / 60);
    const freeDrop = 0.6 - hsFree.heatOf(hFree);
    near(busyDrop / freeDrop, HEAT.COOL_BUSY, 0.02,
      'the busy-window rate really is COOL_BUSY of the idle rate');

    // Past the delay, with no units anywhere, it cools at the far rate.
    let t = 5;
    for (let i = 0; i < 60 * 10; i++) { t += 1 / 60; hs.update(1 / 60, [hole], t); }
    ok(hs.heatOf(hole) < h0 - 0.2, 'heat decays once the player is clear');
    ok(hs.heatOf(hole) > 0, 'ten seconds does not fully clear 0.6 heat');

    // And it reaches zero eventually.
    for (let i = 0; i < 60 * 120; i++) { t += 1 / 60; hs.update(1 / 60, [hole], t); }
    ok(hs.heatOf(hole) === 0, 'heat reaches exactly zero and snaps');

    // Frozen inside HOLD_R of a unit.
    const hs3 = mk();
    const h3 = _stubHole(500);
    hs3.bump(h3, 0.9);
    hs3.update(0.016, [h3], 1);
    // Force a unit right next to the hole.
    hs3._roads();
    hs3._units.push({ id: 999, kind: 'cruiser', spec: RESPONSE.cruiser, x: 5, z: 0, yaw: 0,
      state: 'patrol', axis: 'x', line: 0, free: 0, dir: 1, hole: h3, stateT: 0, born: 0,
      cdPulse: 1e9, warnT: 0, mark: null, stuck: 0, retreatT: 0, siren: 0, dead: false });
    const hHot = hs3.heatOf(h3);
    let tt = 10;
    for (let i = 0; i < 60 * 5; i++) { tt += 1 / 60; hs3._cool(h3, hs3.state.get(h3), 1 / 60, tt); }
    near(hs3.heatOf(h3), hHot, 1e-9, 'no cooling at all inside HOLD_R of a unit');
  }

  /* ---- 4. hit cooldown really prevents stun-lock ----------------------- */
  {
    const hs = mk();
    const hole = _stubHole(200000);
    const s = hs._st(hole);
    s.heat = 0.9; s.tier = 3;

    // Fire a pulse dead-centre on the hole 40 times over 20 simulated seconds.
    let landed = 0;
    const scoreBefore = hole.score;
    for (let i = 0; i < 40; i++) {
      const now = i * 0.5;
      hs.t = now;
      const u = {
        kind: 'cruiser', spec: RESPONSE.cruiser, x: 20, z: 0, state: 'warn',
        mark: { x: hole.position.x, z: hole.position.z, r: HEAT.PULSE_R },
        cdPulse: 0, warnT: 0,
      };
      const before = hole.score;
      hs._fire(u, hole, s, now);
      if (hole.score < before) landed++;
    }
    const maxAllowed = Math.floor(20 / HEAT.HIT_GAP) + 1;
    ok(landed <= maxAllowed,
      `HIT_GAP caps landed hits: ${landed} in 20s, max ${maxAllowed}`);
    ok(landed >= 3, `hits still land when spaced out (${landed})`);
    ok(hole.score < scoreBefore, 'landed hits actually cost score');

    // And two back-to-back pulses in the same instant can never both land.
    const hs2 = mk();
    const h2 = _stubHole(200000);
    const s2 = hs2._st(h2); s2.heat = 0.9; s2.tier = 3;
    let n = 0;
    for (let i = 0; i < 5; i++) {
      hs2.t = 0;
      const before = h2.score;
      hs2._fire({ kind: 'cruiser', spec: RESPONSE.cruiser, x: 9, z: 0, state: 'warn',
        mark: { x: 0, z: 0, r: HEAT.PULSE_R }, cdPulse: 0, warnT: 0 }, h2, s2, 0);
      if (h2.score < before) n++;
    }
    ok(n === 1, `five simultaneous pulses land exactly one hit (got ${n})`);
  }

  /* ---- 5. a dodge is a real dodge, and disengages ---------------------- */
  {
    const hs = mk();
    const hole = _stubHole(50000);
    const s = hs._st(hole); s.heat = 0.9; s.tier = 3;
    const scoreBefore = hole.score;
    let u = null;
    for (let i = 0; i < HEAT.MISS_DISENGAGE; i++) {
      hs.t = i * 10;
      u = { kind: 'cruiser', spec: RESPONSE.cruiser, x: 30, z: 0, state: 'warn',
        mark: { x: 40, z: 40, r: HEAT.PULSE_R }, cdPulse: 0, warnT: 0, dead: false };
      hs._fire(u, hole, s, i * 10);
    }
    ok(hole.score === scoreBefore, 'a dodged pulse costs nothing');
    ok(u.state === 'leaving', 'three dodges in a row makes the unit stand down');
    ok(s.heat < 0.9, 'standing down also cools the meter');
  }

  /* ---- 5b. ROUTE 1 OUT: leaving the zone actually works ---------------- */
  {
    /* This is the headline promise of the whole system and it was broken in
     * two separate ways before it worked: the intercept had no distance cap so
     * fresh units kept materialising in front of a fleeing player, and the
     * roster kept dispatching while the away timer was running, so the timer
     * could never complete. Both are pinned here. */
    const hs = mk();
    const hole = _stubHole(400);
    hs.bump(hole, 0.95);
    let t = 0;
    for (let i = 0; i < 60 * 8; i++) { t += 1 / 60; hs.update(1 / 60, [hole], t); }
    ok(hs.units().length > 0, 'the response turns up in the first place');
    const hotHeat = hs.heatOf(hole);

    // Now run: teleport well clear and hold there.
    hole.position.set(0, 0, 480);
    hole.velocity.set(0, 0, 0);
    for (let i = 0; i < 60 * 6; i++) { t += 1 / 60; hs.update(1 / 60, [hole], t); }
    ok(hs.units().length === 0,
      `leaving the zone clears the roster (still ${hs.units().length} units)`);
    ok(hs._nextDispatch > t, 'and suppresses redispatch for a hold window');

    // With nobody on the map, heat must fall — through the tiers, to zero.
    for (let i = 0; i < 60 * 90; i++) { t += 1 / 60; hs.update(1 / 60, [hole], t); }
    ok(hs.heatOf(hole) < hotHeat * 0.25, 'and the meter drains once they are gone');
    ok(hs.tierOf(hole) < 3, 'the heat tier comes back down');
  }

  /* ---- 6. penalty respects every cap ----------------------------------- */
  {
    const hs = mk();
    // Absolute cap.
    const rich = _stubHole(5_000_000);
    const s1 = hs._st(rich);
    hs.t = 1000;
    const r1 = hs._penalty(rich, s1, 1000);
    ok(r1.loss <= HEAT.PENALTY_CAP, `penalty never exceeds the ${HEAT.PENALTY_CAP} pt cap (got ${r1.loss})`);

    // Percentage cap.
    const mid = _stubHole(3000);
    const s2 = hs._st(mid);
    const before = mid.score;
    const r2 = hs._penalty(mid, s2, 1000);
    ok(r2.loss <= Math.ceil(before * HEAT.PENALTY_FRAC) + 1, 'penalty never exceeds 2% of score');
    ok(mid.score === before - r2.loss, 'the score actually moved by exactly the loss');
    ok(mid.score >= 0, 'score never goes negative');

    // Tier protection: a hole sitting exactly on a tier boundary loses nothing.
    const onEdge = _stubHole(0);
    onEdge.score = Math.ceil(scoreForRadius(TIER.MEDIUM.eatRadius));
    const tierBefore = onEdge.tier;
    const s3 = hs._st(onEdge);
    const r3 = hs._penalty(onEdge, s3, 1000);
    ok(onEdge.tier === tierBefore, 'a hit never demotes a size tier');
    ok(r3.kind === 'vacuum', 'when the tier clamp eats the loss, vacuum is weakened instead');
    ok(hs.vacuumScale(onEdge) < 1, 'vacuumScale reports the debuff');
    hs.t = 1000 + HEAT.VAC_T + 0.1;
    ok(hs.vacuumScale(onEdge) === 1, 'the vacuum debuff expires');

    // With Vacuum Boost live, score is never touched at all.
    const hs4 = mk({ hasVacuum: () => true });
    const vh = _stubHole(50000);
    const sv = hs4._st(vh);
    hs4.t = 5;
    const r4 = hs4._penalty(vh, sv, 5);
    ok(r4.kind === 'vacuum' && vh.score === 50000, 'a vacuum-boosted hit costs zero score');
  }

  /* ---- 7. routing stays on roads, and refuses to invent one ------------ */
  {
    // No roads at all -> no units, ever.
    const bare = new HeatSystem({
      rng: makeRNG(3), effects: _noFx,
      layout: { isRoad: () => false, isWater: () => false },
    });
    const h = _stubHole(4000);
    bare.bump(h, 0.95);
    for (let i = 0; i < 120; i++) bare.update(1 / 60, [h], i / 60);
    ok(bare.units().length === 0, 'with no road network, no unit is ever spawned');

    // Real grid -> units spawn, and every one of them is on a drivable cell.
    // Score 300 keeps the hole under TIER.MEDIUM, so nothing gets devoured and
    // the roster we are measuring is the one that spawned.
    const hs = mk();
    const hole = _stubHole(300);
    hole.position.set(0, 0, 0);
    hs.bump(hole, 0.95);
    let t = 0;
    /* Also assert the no-teleport bound from _place: a unit may never move
     * more than CORNER_CHASE * speed * dt in one frame. This is the property
     * that guarantees it cannot cross a block, and it is easy to break by
     * "just snapping" a corner, so it is pinned here. */
    const prev = new Map();
    let worstStep = 0;
    for (let i = 0; i < 60 * 12; i++) {
      t += 1 / 60;
      // Drive the hole around so the units have to route, not sit still.
      hole.position.x = Math.sin(t * 0.4) * 60;
      hole.position.z = Math.cos(t * 0.3) * 50;
      hs.update(1 / 60, [hole], t);
      for (const u of hs.units()) {
        if (!hs._drivable(u.x, u.z)) {
          fails.push(`unit ${u.kind}#${u.id} left the road at ${u.x.toFixed(1)},${u.z.toFixed(1)}`);
          break;
        }
        const p = prev.get(u.id);
        const cap = CORNER_CHASE * u.spec.speed / 60 + 1e-6;
        if (p) worstStep = Math.max(worstStep, Math.hypot(u.x - p.x, u.z - p.z) / cap);
        prev.set(u.id, { x: u.x, z: u.z });
      }
      if (fails.length) break;
    }
    ok(worstStep <= 1.0, `no unit ever teleports (worst step was ${worstStep.toFixed(3)}x the cap)`);
    ok(hs.units().length > 0, 'units do spawn on a valid grid');
    ok(hs.units().every((u) => 'x' in u && 'z' in u && 'yaw' in u && 'kind' in u && 'state' in u),
      'units() returns the {x,z,yaw,kind,state} shape the renderer expects');

    // clearAll wipes everything.
    hs.clearAll();
    ok(hs.units().length === 0 && hs.state.size === 0 && hs.focus === null, 'clearAll wipes state');
  }

  /* ---- 8. serialise round-trip ----------------------------------------- */
  {
    const hs = mk();
    const hole = _stubHole(1000);
    hs.t = 100;
    const s = hs._st(hole);
    s.heat = 0.63; s.tier = 2; s.lastHitT = 97; s.vacUntil = 103; s.misses = 1;
    const snap = hs.serialize(hole);
    ok(snap && Math.abs(snap.heat - 0.63) < 1e-3, 'serialize captures heat');
    ok(snap.vacLeft > 2.9 && snap.vacLeft < 3.1, 'serialize stores REMAINING seconds, not deadlines');

    const hs2 = mk();
    hs2.t = 4000;                                  // a completely different clock
    const h2 = _stubHole(1000);
    hs2.applyState(h2, snap);
    ok(hs2.tierOf(h2) === 2, 'applyState restores the tier');
    near(hs2.heatOf(h2), 0.63, 1e-3, 'applyState restores heat');
    ok(hs2.vacuumScale(h2) < 1, 'the debuff survives the round trip');
    hs2.t = 4000 + 4;
    ok(hs2.vacuumScale(h2) === 1, 'and expires on the new clock, not the old one');
  }

  /* ---- 9. voice cue IDs are well formed -------------------------------- */
  {
    ok(VOICE_CUE_LIST.length >= 8, 'there are enough distinct cues to avoid repetition');
    ok(VOICE_CUE_LIST.every((id) => /^cityresp\.[a-z_]+$/.test(id)), 'cue IDs are namespaced ids only');
    ok(new Set(VOICE_CUE_LIST).size === VOICE_CUE_LIST.length, 'cue IDs are unique');
  }

  const pass = fails.length === 0;
  const out = { pass, failures: fails };
  if (typeof console !== 'undefined') {
    if (pass) console.log('heat.js __selftest: PASS');
    else console.error('heat.js __selftest: FAIL\n  - ' + fails.join('\n  - '));
  }
  return out;
}
