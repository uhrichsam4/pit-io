/**
 * CITY EVENTS — the reusable, data-driven event manager.
 *
 * An event is a temporary, city-wide reason to move and to fight over a
 * specific patch of Miami. It is NOT a game mode and NOT a boss: it never
 * forks the match loop, never edits the world build, and never owns a mesh.
 *
 * ---------------------------------------------------------------------------
 * THE ARCHITECTURAL RULE THAT SHAPES THIS WHOLE FILE
 * ---------------------------------------------------------------------------
 * This module produces DESCRIPTORS AND INTENT, never side effects on other
 * systems. It does not import the renderer, the HUD, vehicles.js,
 * pedestrians.js or consume.js, and it does not create a single THREE object.
 *
 *   - the weather look     -> `env()`, a per-frame descriptor the renderer maps
 *                             onto its own sky/rain/grade however it likes
 *   - traffic / crowd      -> intent FLAGS on that same descriptor
 *                             (trafficSpeedScale, pedShelterUrge, headlightBias)
 *   - the HUD              -> `onBanner` / `onMarker` callbacks
 *   - loose-prop wind      -> `windForce(c, out)`, an acceleration, integrated
 *                             by whoever already owns prop motion
 *   - storm debris         -> `debris()`, a validated list of POSITIONS; the
 *                             orchestrator turns them into real Consumables
 *
 * Why so hands-off: every one of those systems is written and tuned by someone
 * else, in parallel. An event that reaches into vehicles.js to halve a speed
 * is an event that breaks the moment the traffic model is retuned, and it
 * breaks SILENTLY — which in this codebase is the expensive kind of breakage.
 * A flag that nobody reads is a visible no-op; a mutation into a renamed field
 * is a bug nobody finds for three builds.
 *
 * ---------------------------------------------------------------------------
 * SPEC RULES ENFORCED HERE (docs: CLAUDE_OVERNIGHT_POWERUPS_EVENTS_AUDIO §2)
 * ---------------------------------------------------------------------------
 *   1. At most ONE major event at a time. `major: true` events refuse to start
 *      while another major event runs; start() returns null, it does not queue
 *      and it does not stomp.
 *   2. Every event announces: banner payload + map marker {x,z,r} + countdown
 *      + an audio sting id.
 *   3. Nothing spawns in water. Nothing is removed from the world. No physics
 *      is touched. clearAll() is exhaustive — see the residue list on it.
 *
 * ---------------------------------------------------------------------------
 * PUBLIC INTERFACE
 * ---------------------------------------------------------------------------
 *   new EventManager({ rng, layout, effects, audio?, scene?, validate?,
 *                      quality?, audioBridge? })
 *   .update(dt, { elapsed, duration, holes, player })
 *   .active()                -> runtime event object | null
 *   .start(id, opts?)        -> runtime | null   (opts: duration, warning, force, ctx)
 *   .stop(reason?)           -> boolean
 *   .clearAll()              -> void          (exhaustive reset)
 *   .plan(duration)          -> { id, at } | null   (one deterministic draw)
 *   .env()                   -> the per-frame descriptor (LIVE object, do not keep)
 *   .windForce(c, out?)      -> {x,z} acceleration, m/s^2. Zero for non-TINY.
 *   .debris()                -> validated debris item data
 *   .progress()              -> { taken, total, clusters:[...] }
 *   .claim(itemId, hole)     -> cluster completion bonus, or 0
 *   .countdown()             -> seconds left in the current phase
 *   .schedule                -> { enabled, earliest, latest, tailGuard, ... }
 *   .onBanner / .onMarker / .onSting / .onDebris   (assignable callbacks)
 *
 *   exports: EventManager, TROPICAL_STORM, CLEANUP_CONVOY (data only),
 *            EVENT_DEFS, defineEvent, EVENT_PHASE, STORM_LIMITS,
 *            RAIN_QUALITY, __selftest
 */

import { TIER, WORLD } from '../config.js';
import { QUALITY, QUALITY_TIERS } from '../core/quality.js';
import { STATE } from './entities.js';

/* ========================================================================== *
 * MATH HELPERS — local, tiny, allocation-free.
 * ========================================================================== */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Hermite ease. Used for every ramp so nothing in the storm starts abruptly. */
function smoothstep(a, b, x) {
  if (b === a) return x >= b ? 1 : 0;
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/**
 * Stateless 0..1 hash of an integer id.
 *
 * WHY NOT rng(): windForce() is called from a hot loop over props, and drawing
 * from the shared RNG there would (a) allocate nothing but (b) advance a stream
 * that the city build, the bot spawner and the event schedule all read from —
 * i.e. the map would differ between two clients purely because one of them
 * rendered more frames of rain. Every per-prop random in this file is a hash of
 * something stable instead.
 */
function hash01(i) {
  let h = Math.imul((i | 0) ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Accept either a bare `() => number` or the decorated rng from core/rng.js.
 * The orchestrator passes `game.rng` (decorated); tests pass Math.random.
 */
function rngAdapter(r) {
  const base = typeof r === 'function' ? r : Math.random;
  if (typeof base.range === 'function') return base;
  const out = () => base();
  out.range = (lo, hi) => lo + base() * (hi - lo);
  out.int = (lo, hi) => Math.floor(lo + base() * (hi - lo + 1));
  out.pick = (arr) => arr[Math.floor(base() * arr.length)];
  out.chance = (p) => base() < p;
  return out;
}

/**
 * Current renderer quality tier NAME.
 *
 * TRAP: `QUALITY` does not carry a `name` — applyQualityTier() copies every
 * key of the tier EXCEPT that one (see core/quality.js), so `QUALITY.name` is
 * undefined and a switch on it silently falls through to the default forever.
 * engine.js recovers the tier by matching shadowMapSize (engine.js ~line 392);
 * this does the same thing rather than inventing a second source of truth.
 */
function inferQualityName() {
  const i = QUALITY_TIERS.findIndex((t) => t.shadowMapSize === QUALITY.shadowMapSize);
  return (QUALITY_TIERS[i] || QUALITY_TIERS[0]).name;
}

/* ========================================================================== *
 * READABILITY CEILINGS
 *
 * These are CEILINGS, not targets, and they are the reason the storm is safe
 * to ship. Gameplay readability is the spec's non-negotiable: the player must
 * always be able to see lane markings, their own rim, and every rival hole.
 *
 * The argument for each number (these are reasoned bounds, not hardware
 * measurements — treat them as the budget a look pass may spend UP TO, and
 * re-derive them if the grade changes):
 *
 *   CLOUD_DARKNESS_MAX 0.42
 *     `cloudDarkness` is meant to be applied as a lerp of the live TOD stop
 *     toward an overcast one. The grade already loses a large slice of key
 *     intensity between the e=56 and e=-7 stops, and the hole's own interior
 *     renders near-black. Past roughly 0.4 the road surface value falls toward
 *     the pit interior value, and the ONLY thing still telling you where the
 *     hole is, is the rim highlight — at which point rivals at the edge of
 *     frame are guesswork. A storm has to read as a mood shift, not a dimmer.
 *
 *   RAIN_DENSITY_MAX 0.62
 *     Rain streaks are high-frequency near-vertical detail. Lane markings are
 *     high-frequency near-vertical detail. At pixelRatioCap 1 (the low/potato
 *     tiers) they alias into the same grey mush, and the player loses the road
 *     grid that the whole city's navigation depends on. Density above ~0.6
 *     buys atmosphere at the cost of the map.
 *
 *   WETNESS_MAX 0.85
 *     Full 1.0 gloss asphalt is a mirror: lane paint disappears into the
 *     reflection of the sky. 0.85 keeps a dry-ish core in the paint while the
 *     asphalt darkens and specs up.
 *
 *   LIGHTNING_FLASH_MAX 0.30 / LIGHTNING_MIN_GAP 3.2 s
 *     A flash is an ADDITIVE exposure pulse. The spec calls for "occasional
 *     SAFE lightning". 0.3 is a visible kick that cannot white out the frame,
 *     and the minimum gap keeps it from ever becoming a strobe — this is an
 *     accessibility floor, not a taste call, so it is enforced in the
 *     scheduler and not left to content.
 * ========================================================================== */
export const STORM_LIMITS = {
  CLOUD_DARKNESS_MAX: 0.42,
  RAIN_DENSITY_MAX: 0.62,
  WETNESS_MAX: 0.85,
  LIGHTNING_FLASH_MAX: 0.30,
  LIGHTNING_MIN_GAP: 3.2,
  /** Apparent wind speed handed to palms / rain slant, m/s. Cosmetic only. */
  WIND_SPEED_MAX: 13,
  /**
   * HARD CAP on windForce(), in m/s^2. See windForce() for the full derivation
   * and for the offset clamp the caller must also apply.
   */
  WIND_ACCEL_MAX: 0.9,
  /** Above this footprint radius a prop is furniture, not litter: no wind. */
  WIND_PROP_RADIUS_MAX: 0.75,
  /** Traffic never drops below this fraction of free-flow speed. */
  TRAFFIC_SPEED_FLOOR: 0.60,
};

/* ========================================================================== *
 * QUALITY LADDER FOR RAIN
 *
 * The spec: "Low settings use fewer particles and a shader/texture effect
 * instead of thousands of individual raindrops." So the tier changes the
 * TECHNIQUE, not just a count — `rainMode: 'sheet'` tells the renderer to use
 * scrolling screen-space/box-volume rain instead of instanced drops.
 *
 * `rainBudget` is a hard instance cap the renderer must respect; `rainDensity`
 * from env() is the 0..1 fill INSIDE that budget. Two separate numbers on
 * purpose: the storm ramps density up and down continuously, and the budget
 * must not move with it or a quality drop mid-storm reallocates buffers.
 * ========================================================================== */
export const RAIN_QUALITY = {
  high:   { rainMode: 'particles', rainBudget: 2600, splashes: true,  puddles: true,  streakLen: 1.0 },
  medium: { rainMode: 'particles', rainBudget: 1400, splashes: true,  puddles: true,  streakLen: 0.9 },
  /* 'low' is the tier the spec singles out: a handful of near-camera drops for
     parallax, and everything else carried by a scrolling sheet. */
  low:    { rainMode: 'sheet',     rainBudget: 360,  splashes: false, puddles: true,  streakLen: 0.8 },
  /* Potato keeps wetness and the lightning pulse — both are essentially free
     and are what actually communicates "storm" — and spends nothing on drops. */
  potato: { rainMode: 'sheet',     rainBudget: 0,    splashes: false, puddles: false, streakLen: 0.7 },
};

/* ========================================================================== *
 * EVENT A — TROPICAL STORM ALERT (built)
 * ========================================================================== */

/**
 * Every knob the storm has. Nothing below this line hardcodes a storm number;
 * a tuner edits this object and nothing else.
 *
 * Duration: the spec window is 45–60 s. `duration` is clamped into
 * [minDuration, maxDuration] on start, so a bad override cannot produce a
 * three-minute storm.
 */
export const TROPICAL_STORM = {
  id: 'tropical-storm',
  name: 'TROPICAL STORM ALERT',
  short: 'STORM',
  icon: '🌀',
  /* Cyan, matched to the HUD's t1 accent. Deliberately NOT the ring's
     magenta (#ff3d8b) — an event marker that reads as the shrink ring is a
     player mistake waiting to happen. */
  color: '#5fd8ff',
  blurb: 'Wind, rain and loose debris. Grab the clusters before a rival does.',
  major: true,
  implemented: true,

  timing: {
    /** Lead time between the alert and landfall. The countdown the HUD shows. */
    warning: 6,
    duration: 52,
    minDuration: 45,
    maxDuration: 60,
    /** Seconds of the duration spent ramping in / out. build+ease < duration. */
    build: 9,
    ease: 11,
    /**
     * A hint of wind before landfall, so the palms move while the banner is up
     * and the alert is not a lie. Capped hard — this plays during normal play.
     */
    preGust: 0.14,
  },

  /** Look. Every field is a 0..1 the renderer maps however it wants. */
  visual: {
    cloudDarkness: 0.38,     // <= STORM_LIMITS.CLOUD_DARKNESS_MAX
    rainDensity: 0.58,       // <= STORM_LIMITS.RAIN_DENSITY_MAX
    wetness: 0.80,           // <= STORM_LIMITS.WETNESS_MAX
    /** Wetness lags the rain: roads stay slick after the downpour eases. */
    wetnessDecay: 0.10,      // per second, once rain is falling less than wetness
    lightning: {
      /** Strikes per minute at full intensity. */
      rate: 7,
      flash: 0.28,           // <= STORM_LIMITS.LIGHTNING_FLASH_MAX
      /** Seconds the additive pulse takes to decay to nothing. */
      falloff: 0.42,
      /** Camera shake per strike, at full intensity. effects.addShake units. */
      shake: 0.10,
    },
  },

  /**
   * Wind. `heading` is the direction the wind BLOWS TOWARD, in radians on the
   * XZ plane (0 = +X, PI/2 = +Z), matching the rest of the world's convention.
   * Miami storms come off the bay, so the default pushes inland (-X).
   */
  wind: {
    heading: Math.PI,        // blowing west, off Biscayne Bay toward Brickell
    /** Slow direction wander, radians of half-amplitude. */
    swing: 0.32,
    swingPeriod: 17,
    /** Gust envelope: two incommensurable periods so it never sounds like a loop. */
    gustA: 4.7,
    gustB: 11.3,
    /** Gust modulation depth, 0..1 of the peak speed. */
    gustDepth: 0.45,
    /** Loose-prop drift enabled at all. Kill switch for the whole force path. */
    movesProps: true,
  },

  /** Intent flags for systems this module refuses to touch directly. */
  npc: {
    /**
     * 0.66 of free-flow at peak, floored at TRAFFIC_SPEED_FLOOR.
     *
     * WHY NOT SLOWER: vehicles.js runs an IDM car-following model with
     * intersection reservations. Halving the free-flow speed does not read as
     * "careful driving", it reads as a jam — and a jam at a reservation is how
     * you get the permanently stuck cars the spec explicitly forbids. A third
     * off is unmistakable on screen and leaves throughput intact.
     */
    trafficSpeedScale: 0.66,
    /**
     * How badly pedestrians want to be indoors, 0..1. pedestrians.js decides
     * what that means (shelter seek, umbrella, faster walk). Peaks slightly
     * BEFORE the rain does — people move when the sky goes dark, not when they
     * are already wet — which is what `shelterLead` buys.
     */
    pedShelterUrge: 1.0,
    shelterLead: 0.18,
    /**
     * Added to nightFactor for lamp decisions, clamped by the consumer.
     * vehicles.js computes `lit = smoothstep(0.06, 0.42, night)`, so 0.5 fully
     * lights headlights, tail lamps and beams in broad daylight. 0.55 gives a
     * little headroom without asking the consumer to unclamp anything.
     */
    headlightBias: 0.55,
  },

  /**
   * Debris field. POSITIONS ONLY — this module never creates a mesh or a
   * Consumable. See EventManager._placeDebris for the validation chain.
   */
  debris: {
    enabled: true,
    clusters: 4,
    /** Radius of one cluster's scatter, metres. */
    clusterRadius: 15,
    itemsMin: 9,
    itemsMax: 15,
    /** Cluster centres this far apart, so the field is a map-wide decision. */
    minSeparation: 95,
    /**
     * Never materialise a crate inside or next to a live hole's rim. A prop
     * that appears already overlapping an opening is a free score at best and
     * a physics pop at worst.
     */
    minHoleClearance: 30,
    /**
     * Debris on a carriageway would sit in the IDM model's path. vehicles.js
     * has no idea this module exists and will drive through or stall on it, so
     * the field stays on the sidewalks, plazas and parks.
     */
    keepOffRoads: true,
    attemptsPerCluster: 80,
    attemptsPerItem: 14,
    /** Placement bounds. Mirrors game._validateSpawn's own guards. */
    bounds: {
      xMin: -WORLD.SIZE * 0.78,
      xMax: WORLD.BAY_EDGE - 40,
      zMin: -WORLD.SIZE * 0.78,
      zMax: WORLD.SIZE * 0.78,
    },
  },

  /**
   * What a debris item is. `tier` decides who can eat it — an early player
   * gets the branches and umbrellas, a mid-game player takes the carts. That
   * tier spread is what makes a cluster contested rather than a race.
   */
  debrisKinds: [
    { kind: 'storm-branch',   label: 'Palm branch',    tier: TIER.TINY,   radius: 0.55, height: 0.35, passRadius: 0.30, weight: 3 },
    { kind: 'storm-umbrella', label: 'Patio umbrella', tier: TIER.SMALL,  radius: 0.85, height: 2.20, passRadius: 0.45, weight: 3 },
    { kind: 'storm-sign',     label: 'Torn sign',      tier: TIER.SMALL,  radius: 0.70, height: 1.60, passRadius: 0.38, weight: 2 },
    { kind: 'storm-crate',    label: 'Cargo crate',    tier: TIER.MEDIUM, radius: 0.80, height: 0.90, passRadius: 0.62, weight: 2 },
    { kind: 'storm-cart',     label: 'Vendor cart',    tier: TIER.MEDIUM, radius: 1.10, height: 1.55, passRadius: 0.70, weight: 1 },
  ],

  rewards: {
    /**
     * Debris is worth 5x its tier. A 12-item cluster lands around 400–700
     * points, which against the measured 527k total city score is a good
     * minute of early play and a rounding error at the end — deliberately so.
     * An event that decides the match is an event that punishes whoever was
     * on the wrong side of the map when it fired.
     */
    scoreMul: 5,
    /** Paid once, to the hole that takes >= clearFraction of one cluster. */
    clusterBonus: 250,
    clearFraction: 0.75,
    bonusLabel: 'Storm haul',
  },

  /**
   * Sound.
   *
   * The `id` fields are IDS, not calls — they go out on `onSting` so a HUD,
   * a caption track or a different audio backend can react without this
   * module knowing anything about audio.
   *
   * `audio` is an OPTIONAL direct route into the src/core/audio.js singleton,
   * expressed as METHOD NAMES so it stays data rather than code. Every name
   * below was grepped against audio.js, not guessed:
   *     eventWarning()  eventSting(kind)  stormStart()  stormLoop()
   *     rainLoop()      thunder(distance) stormEnd()
   * Every call is `typeof`-guarded, so a renamed or removed method degrades to
   * silence instead of throwing in the middle of a match. It deliberately does
   * NOT fall back to ui()/rankChange(): a storm warning that clicks like a menu
   * button is worse than silence.
   *
   * `stormLoop()` and `rainLoop()` return handles with `.setIntensity(0..1.5)`
   * and `.stop(fade)`; the manager drives intensity off the same envelope the
   * visuals use, and stops both beds on every exit path — including clearAll —
   * because "no audio loops continue after match restart" is on the spec's
   * test checklist.
   */
  sounds: {
    warn: 'event-storm-warn',
    start: 'event-storm-start',
    loop: 'event-storm-wind-loop',
    thunder: 'event-storm-thunder',
    end: 'event-storm-end',
    audio: {
      warn: 'eventWarning',
      sting: 'eventSting',
      start: 'stormStart',
      loops: ['stormLoop', 'rainLoop'],
      thunder: 'thunder',
      end: 'stormEnd',
    },
  },
};

/* ========================================================================== *
 * EVENT B — THE CLEANUP CONVOY  (DATA + DESIGN ONLY. NOT IMPLEMENTED.)
 * ========================================================================== *
 *
 * The spec's second event concept, recorded here so the shape is agreed before
 * anyone writes it. `implemented: false` makes EventManager.start() refuse it
 * outright rather than half-run an empty event — a no-op event that still
 * banners and still blocks the one-major-event slot is the worst of both.
 *
 * WHAT IT IS
 *   An interactive MOVING EVENT ZONE. A convoy of city utility vehicles —
 *   flatbed, cement mixer, garbage truck, scissor lift, a couple of cruisers
 *   for the lights — drives a pre-planned route along real roads and parks up
 *   on a marked block. Around it: cones, barriers, work lamps, a crowd of
 *   onlookers, and a pile of genuinely valuable equipment.
 *
 * WHAT IT IS EXPLICITLY NOT
 *   Not a boss. There is no health bar, no damage, nothing to defeat, and the
 *   convoy never attacks. The tension is a CONTESTED SPACE with a clock on it:
 *   the equipment is worth a lot, every rival can see the marker, and the
 *   convoy packs up and leaves whether you got there or not. The player's
 *   decision is "is it worth crossing the map for", not "can I win the fight".
 *
 * HOW IT WOULD SLOT IN WITHOUT BREAKING ANYTHING
 *   - Route: sampled from layout.roadsX / roadsZ centrelines only. The convoy
 *     must never be placed by coordinate guess — that is exactly the failure
 *     mode where a truck spawns inside a parcel.
 *   - Vehicles: it does NOT get its own driving model. It hands the route to
 *     whoever owns traffic and reads back positions, or it is a scripted
 *     spline with the traffic model told to yield. Two driving models on one
 *     road network is how you get the permanent gridlock the spec forbids.
 *   - Equipment: same DATA-ONLY path as storm debris — validated points, and
 *     the orchestrator makes the Consumables. Tiered LARGE/XLARGE so it is a
 *     mid-game prize; a 2 m hole should be able to see it and want it.
 *   - Departure: everything the event added is removed by the same clearAll()
 *     path, whether the convoy left on time or the match ended under it.
 *
 * PROGRESS UI (the spec asks for it explicitly)
 *   { phase, secondsLeft, equipmentTaken, equipmentTotal, leader, yourShare }
 *   — enough for a compact "CLEANUP CONVOY  7/12  0:34" strip. Same
 *   onBanner/onMarker channel as the storm; the marker MOVES with the convoy,
 *   which is the one genuinely new renderer requirement.
 * ========================================================================== */
export const CLEANUP_CONVOY = {
  id: 'cleanup-convoy',
  name: 'CLEANUP CONVOY',
  short: 'CONVOY',
  icon: '🚧',
  color: '#ffc93c',
  blurb: 'City crews are clearing a block. Their kit is worth a fortune.',
  major: true,
  /** NOT BUILT. start() refuses this id; see the block above. */
  implemented: false,

  timing: { warning: 8, duration: 75, minDuration: 60, maxDuration: 90, arrive: 18, depart: 14 },

  /** The zone moves: it is anchored to the convoy head, not to a fixed point. */
  zone: { follows: 'convoy-head', radius: 34, markerFollows: true },

  convoy: {
    /** Kinds are names already present in vehicles.js — no new content needed. */
    order: ['police', 'flatbed', 'cementMixer', 'garbageTruck', 'scissorLift', 'police'],
    spacing: 11,
    speed: 7.5,
    /** Route is sampled from layout road centrelines at plan time. Never authored. */
    routeFrom: 'layout.roads',
    /** Lights and sirens on for the whole event; it is a work crew, not a chase. */
    beacons: true,
  },

  equipment: {
    count: 12,
    scatterRadius: 22,
    keepOffRoads: false,        // the crew is working IN the road; that is the point
    kinds: [
      { kind: 'convoy-barrier', label: 'Barrier',     tier: TIER.SMALL,  weight: 3 },
      { kind: 'convoy-lamp',    label: 'Work lamp',   tier: TIER.MEDIUM, weight: 2 },
      { kind: 'convoy-pallet',  label: 'Pallet load', tier: TIER.MEDIUM, weight: 2 },
      { kind: 'convoy-genny',   label: 'Generator',   tier: TIER.LARGE,  weight: 2 },
      { kind: 'convoy-skip',    label: 'Skip',        tier: TIER.XLARGE, weight: 1 },
    ],
  },

  npc: { trafficSpeedScale: 0.80, pedShelterUrge: 0, crowdDraw: 0.7 },

  rewards: { scoreMul: 4, clearBonus: 600, clearFraction: 0.7, bonusLabel: 'Convoy haul' },

  sounds: {
    warn: 'event-convoy-warn',
    start: 'event-convoy-arrive',
    loop: 'event-convoy-worksite-loop',
    end: 'event-convoy-depart',
  },
};

/** Registry. `defineEvent` lets a later pass add events without editing this. */
export const EVENT_DEFS = new Map([
  [TROPICAL_STORM.id, TROPICAL_STORM],
  [CLEANUP_CONVOY.id, CLEANUP_CONVOY],
]);

export function defineEvent(def) {
  if (!def || !def.id) throw new Error('[cityEvents] defineEvent needs an id');
  EVENT_DEFS.set(def.id, def);
  return def;
}

/** Event lifecycle phases. `IDLE` only ever appears on the manager, not on a run. */
export const EVENT_PHASE = {
  WARNING: 'warning',   // announced, not yet landed; the countdown is running
  ACTIVE: 'active',     // ramping in, holding, ramping out — one continuous phase
  CLEARING: 'clearing', // over; descriptor is decaying back to neutral
  DONE: 'done',
};

/* ========================================================================== *
 * THE MANAGER
 * ========================================================================== */

export class EventManager {
  /**
   * @param {object} deps
   * @param {Function} deps.rng      seeded RNG (core/rng.js makeRNG, or bare fn)
   * @param {object}   deps.layout   cityLayout — isWater(x,z) / isRoad(x,z)
   * @param {object}   [deps.effects] render/effects.js — used ONLY for thunder shake
   * @param {object}   [deps.audio]   core/audio.js singleton, optional
   * @param {object}   [deps.scene]   THREE.Scene — descriptor is published to
   *                                  scene.userData.storm, the convention every
   *                                  other content module already reads
   *                                  (nightFactor, timeOfDay, sunDir)
   * @param {Function} [deps.validate] (x,z) => boolean | {ok:boolean}
   *   THE DEBRIS VALIDATOR. Do NOT pass game._validateSpawn here: that answers
   *   "may a HOLE open here", which demands six starter props within 30 m and
   *   rejects anything within 3 m of an object — both are the wrong question
   *   for a crate, and the second one rejects exactly the interesting spots.
   *   Pass a debris-shaped predicate, e.g.
   *     (x, z) => !layout.isWater(x, z) && !layout.isRoad(x, z) && !occupied(x, z, 1.2)
   *   Water and bounds are re-checked here regardless; belt and braces, because
   *   "spawned in the bay" is the one failure the spec calls out by name.
   * @param {string|Function} [deps.quality] override the inferred quality tier
   */
  constructor(deps = {}) {
    this.rng = rngAdapter(deps.rng);
    this.layout = deps.layout || null;
    this.effects = deps.effects || null;
    this.audio = deps.audio || null;
    /**
     * Set false to keep the module on the `onSting` channel only and make no
     * direct calls into audio.js. For tests, and for anyone rebuilding the
     * audio layer who wants one place to cut the cord.
     */
    this.audioBridge = deps.audioBridge !== false;
    this.scene = deps.scene || null;
    this.validate = typeof deps.validate === 'function' ? deps.validate : null;
    this._qualityOverride = deps.quality || null;

    /* --- HUD / audio channels. Assign these; this module never imports UI. --- */
    /** @type {null|(payload:object)=>void} */
    this.onBanner = null;
    /** @type {null|(marker:object|null)=>void} */
    this.onMarker = null;
    /** @type {null|(id:string, opts:object)=>void} */
    this.onSting = null;
    /** @type {null|(items:object[], ev:object)=>void} */
    this.onDebris = null;

    /**
     * Scheduling. Deterministic: one draw per match, taken the first time
     * update() sees a duration, so every client in a room agrees on when the
     * storm lands as long as their RNG streams agree.
     */
    this.schedule = {
      enabled: true,
      /** Start window as a fraction of match duration. */
      earliest: 0.28,
      latest: 0.62,
      /** Seconds of clean match that must remain after the event ends. */
      tailGuard: 18,
      maxPerMatch: 1,
      /** Which event the scheduler is allowed to fire. */
      pool: [TROPICAL_STORM.id],
    };

    /** @type {object|null} */
    this._active = null;
    this._plan = null;
    this._planned = false;
    this._fired = 0;
    this._elapsed = 0;
    /** >0 while the descriptor is easing back to neutral after an event. */
    this._clearing = 0;
    /** Last sting id raised. Purely for debugging / the audio pass. */
    this.lastSting = null;
    this._qualityAt = -1;
    this._qualityName = 'high';

    /**
     * THE DESCRIPTOR. One object, mutated in place, handed out by env().
     *
     * It is read every frame by the renderer, vehicles and pedestrians, so it
     * must never be reallocated — a consumer that caches the reference (and
     * they will) would silently freeze on a stale copy. Consumers must treat
     * it as read-only.
     */
    this._env = this._neutralEnv();
    this._windScratch = { x: 0, z: 0 };

    this._publish();
  }

  /* --------------------------------------------------------------- state --- */

  _neutralEnv() {
    return {
      /** Identity of whatever is driving this, or null. */
      id: null,
      phase: null,
      /**
       * TRUE ONLY WHILE AN EVENT IS RUNNING — it goes false the instant the
       * event ends, while every scalar below keeps decaying for another second
       * or so. DRIVE VISUALS OFF THE SCALARS, NEVER OFF THIS FLAG: gating the
       * rain on `active` snaps it off between two frames and undoes the whole
       * point of the clearing tail. Use it for bookkeeping and for "is there an
       * event" UI, not as a render switch.
       */
      active: false,
      /** 0..1 master envelope. Everything else is derived from it. */
      intensity: 0,

      /* --- look --- */
      cloudDarkness: 0,
      rainDensity: 0,
      wetness: 0,
      lightningFlash: 0,
      /** True for exactly the one frame a bolt fires. For audio / one-shots. */
      strike: false,
      windVec: { x: 0, z: 0 },   // metres per second, XZ plane
      windSpeed: 0,

      /* --- quality --- */
      quality: 'high',
      rainMode: 'particles',
      rainBudget: 0,
      splashes: false,
      puddles: false,
      streakLen: 1,

      /* --- intent flags for other systems --- */
      trafficSpeedScale: 1,
      pedShelterUrge: 0,
      headlightBias: 0,
    };
  }

  _resetEnv() {
    const e = this._env;
    const n = this._neutralEnv();
    for (const k of Object.keys(n)) {
      if (k === 'windVec') { e.windVec.x = 0; e.windVec.z = 0; continue; }
      e[k] = n[k];
    }
  }

  /**
   * Mirror the descriptor onto scene.userData.
   *
   * WHY: every content module in this codebase already reads its cross-cutting
   * inputs from scene.userData (nightFactor, timeOfDay, sunDir) inside the
   * update hook it registered there. Publishing the storm the same way means
   * vehicles.js and pedestrians.js can consume it without importing gameplay
   * code and without the orchestrator threading a reference through them.
   */
  _publish() {
    if (this.scene) this.scene.userData.storm = this._env;
  }

  /* ------------------------------------------------------------ callbacks --- */

  _banner(payload) {
    if (typeof this.onBanner === 'function') this.onBanner(payload);
  }

  _marker(m) {
    if (typeof this.onMarker === 'function') this.onMarker(m);
  }

  /**
   * Raise an audio cue by ID on the `onSting` channel.
   *
   * The audio module owns the SOUND; this owns WHEN. The named-method bridge in
   * _audio() is the loud path; this is the id path, and it exists so captions,
   * a different backend, or a test harness can hear the same timeline without
   * audio.js being present at all.
   */
  _sting(id, opts) {
    if (!id) return;
    this.lastSting = id;
    const o = opts || {};
    if (typeof this.onSting === 'function') this.onSting(id, o);
    /* Generic hook, in case a later audio pass prefers one id-driven entry
       point to the named methods below. Guarded: it does not exist today. */
    const a = this.audio;
    if (a && typeof a.event === 'function') a.event(id, o);
  }

  /**
   * Call a named method on the audio singleton, if it is there.
   *
   * WHY BY NAME AND WHY GUARDED: audio.js is written by a different pass and
   * its storm surface landed after this file. A missing method here must cost
   * silence and nothing else — and it must not throw, because WebAudio calls
   * can raise on a closed or suspended context and an exception thrown from
   * the event update would take the match loop with it.
   */
  _audio(name, ...args) {
    if (!name || this.audioBridge === false) return null;
    const a = this.audio;
    if (!a) return null;
    const fn = a[name];
    if (typeof fn !== 'function') return null;
    try {
      return fn.apply(a, args);
    } catch (err) {
      console.warn(`[cityEvents] audio.${name}() threw`, err);
      return null;
    }
  }

  /** Stop every continuous bed this event started. Safe to call twice. */
  _stopLoops(ev, fade) {
    if (!ev || !ev.loops) return;
    for (const h of ev.loops) {
      if (h && typeof h.stop === 'function') {
        try { h.stop(fade); } catch (err) { void err; }
      }
    }
    ev.loops = null;
  }

  /* -------------------------------------------------------------- queries --- */

  /** The running event, or null. */
  active() { return this._active; }

  /** Live descriptor. Read-only for callers; do not retain a snapshot. */
  env() { return this._env; }

  /** Validated debris data for the running event. Empty array when idle. */
  debris() { return this._active ? this._active.debris : EMPTY; }

  /**
   * Seconds left in the phase a player cares about: time to landfall while the
   * alert is up, time to clear once it has landed.
   *
   * The HUD polls this; the manager does NOT push a banner every frame. hud.js
   * only touches the DOM when a human-visible value changed, and a 60 Hz
   * countdown push would defeat that on purpose-built code.
   */
  countdown() {
    const ev = this._active;
    if (!ev) return 0;
    return Math.max(0, ev.phase === EVENT_PHASE.WARNING ? ev.warnLeft : ev.timeLeft);
  }

  /** Debris progress, for the event strip. */
  progress() {
    const ev = this._active;
    if (!ev) return { taken: 0, total: 0, clusters: [] };
    return {
      taken: ev.taken,
      total: ev.debris.length,
      clusters: ev.clusters.map((c) => ({ x: c.x, z: c.z, taken: c.taken, total: c.total })),
    };
  }

  /* -------------------------------------------------------------- control --- */

  /**
   * Start an event by id.
   *
   * @returns {object|null} the runtime, or null with a reason logged. Refusing
   *   is normal control flow (a major event is already up, the id is not built
   *   yet, the match has no room left), so this never throws.
   */
  start(id, opts = {}) {
    const def = EVENT_DEFS.get(id);
    if (!def) { console.warn(`[cityEvents] unknown event '${id}'`); return null; }
    if (def.implemented === false) {
      console.warn(`[cityEvents] '${id}' is a design stub, not a runnable event`);
      return null;
    }
    /* RULE 1: ONE SLOT. The spec's rule is "at most one major event at a time
       in Classic Devour"; this manager holds exactly one slot, which enforces
       that and is also the honest shape — two concurrent events would need two
       descriptors, two markers and a banner priority scheme nobody has asked
       for. Refuse; do not queue, do not replace. Replacing silently would mean
       an event that announced itself and then vanished.
       `force` exists for the orchestrator and devtools only, and it stops the
       incumbent cleanly first — it never stacks. */
    if (this._active) {
      if (!opts.force) return null;
      this.stop('superseded');
    }

    const t = def.timing || {};
    const duration = clamp(
      opts.duration ?? t.duration ?? 50,
      t.minDuration ?? 30,
      t.maxDuration ?? 120,
    );
    const warning = Math.max(0, opts.warning ?? t.warning ?? 5);

    const ev = {
      id: def.id,
      def,
      name: def.name,
      color: def.color,
      icon: def.icon,
      /** Seconds since start(), including the warning lead. */
      t: 0,
      warning,
      duration,
      total: warning + duration,
      phase: EVENT_PHASE.WARNING,
      warnLeft: warning,
      timeLeft: duration,
      intensity: 0,
      /** @type {object|null} */
      marker: null,
      /** @type {object[]} */
      debris: [],
      /** @type {object[]} */
      clusters: [],
      taken: 0,
      /** Deterministic strike times, seconds from landfall. */
      strikes: [],
      strikeI: 0,
      /** Wind phase offsets, drawn once so gusts are identical on every client. */
      windPhaseA: this.rng.range(0, 6.283),
      windPhaseB: this.rng.range(0, 6.283),
      windPhaseS: this.rng.range(0, 6.283),
      /** Continuous audio beds, held so every exit path can stop them. */
      loops: null,
      /** Last intensity pushed to those beds; see the throttle in _updateStorm. */
      loopIntensity: -1,
    };

    if (def.id === TROPICAL_STORM.id) this._initStorm(ev, opts);

    this._active = ev;
    this._fired++;

    /* RULE 2: banner + marker + countdown + sting, on every event, always. */
    this._banner({
      kind: 'alert',
      id: ev.id,
      name: def.name,
      short: def.short,
      icon: def.icon,
      color: def.color,
      message: def.name,
      sub: def.blurb,
      seconds: warning > 0 ? warning : duration,
      countdownTo: warning > 0 ? 'landfall' : 'clear',
      sting: (def.sounds && def.sounds.warn) || null,
    });
    this._marker(ev.marker);
    this._sting(def.sounds && def.sounds.warn, { lead: warning });
    this._audio(def.sounds && def.sounds.audio && def.sounds.audio.warn);

    return ev;
  }

  /**
   * End the running event.
   *
   * The descriptor is NOT snapped to zero: CLEARING lets the rain and wetness
   * decay over a second or so. A storm that vanishes between two frames looks
   * like a bug even when it is a clean shutdown. clearAll() is the one that
   * snaps, because that is a teardown, not an ending.
   */
  stop(reason = 'ended') {
    const ev = this._active;
    if (!ev) return false;

    const silent = reason === 'clear-all' || reason === 'superseded';
    const A = (ev.def.sounds && ev.def.sounds.audio) || null;

    /* AUDIO TEARDOWN FIRST, and on both paths. `stormEnd()` releases the beds
       itself with a musical fade and plays the departing roll; a silent stop
       cuts them short by hand instead. Either way nothing continuous survives
       this method — that is the invariant clearAll() depends on. */
    const ended = !silent && A ? this._audio(A.end) : null;
    /* Only trust stormEnd() to have released the beds if it was actually there
       to call. Otherwise cut them by hand — an orphaned bed is exactly the bug
       this ordering exists to prevent. */
    if (ended) ev.loops = null;
    else this._stopLoops(ev, silent ? 0.25 : 2.0);

    if (!silent) {
      this._banner({
        kind: 'end',
        id: ev.id,
        name: ev.name,
        short: ev.def.short,
        icon: ev.icon,
        color: ev.color,
        message: `${ev.def.short || ev.name} CLEARING`,
        sub: ev.debris.length ? `${ev.taken}/${ev.debris.length} debris taken` : '',
        seconds: 0,
        sting: (ev.def.sounds && ev.def.sounds.end) || null,
      });
      this._sting(ev.def.sounds && ev.def.sounds.end, { reason });
    }
    this._marker(null);

    ev.phase = EVENT_PHASE.DONE;
    this._active = null;
    /* Hand the debris list back so the orchestrator can retire whatever it
       spawned. It owns those Consumables; this module only ever knew the
       coordinates. */
    if (typeof this.onDebris === 'function' && ev.debris.length) {
      this.onDebris([], ev);
    }
    if (silent) this._resetEnv();
    else {
      /* `active` drops now; the scalars decay over the next second or so. See
         the note on the flag in _neutralEnv(). */
      this._env.active = false;
      this._env.phase = EVENT_PHASE.CLEARING;
      this._clearing = 1;
    }
    this._publish();
    return true;
  }

  /**
   * EXHAUSTIVE TEARDOWN. Called on match end, restart, mode change and death
   * of the whole game object.
   *
   * Everything this manager can leave behind, in one place, so the list can be
   * audited against __selftest():
   *   1. the running event                    -> stopped, silently
   *   2. the per-frame descriptor              -> every field back to neutral
   *   3. scene.userData.storm                  -> neutral (kept, not deleted:
   *      a consumer holding the reference must see zeros, not a crash)
   *   4. the map marker                        -> onMarker(null)
   *   5. debris data                           -> dropped, and onDebris([]) so
   *      the orchestrator despawns what it made
   *   6. the schedule                          -> unplanned, counter zeroed, so
   *      the next match draws a fresh landfall time
   *   7. the clearing tail                     -> cancelled
   *   8. lightning bookkeeping                 -> reset with the event
   */
  clearAll() {
    /* stop() already pushes the empty debris list, which is what tells the
       orchestrator to despawn whatever it made. Do not repeat it here. */
    if (this._active) this.stop('clear-all');
    this._marker(null);
    this._banner({ kind: 'clear', id: null, message: '', seconds: 0 });
    this._resetEnv();
    this._clearing = 0;
    this._plan = null;
    this._planned = false;
    this._fired = 0;
    this._elapsed = 0;
    this.lastSting = null;
    this._publish();
  }

  /* ----------------------------------------------------------- scheduling --- */

  /**
   * Draw the landfall time. Idempotent per match.
   *
   * Deterministic on purpose: in multiplayer every client must agree on when
   * the storm arrives without a packet, and the only way to get that for free
   * is one draw from the seeded stream at a well-defined moment.
   */
  plan(duration) {
    if (this._planned) return this._plan;
    this._planned = true;
    this._plan = null;

    const s = this.schedule;
    if (!s.enabled || !(duration > 0) || !s.pool.length) return null;

    const id = s.pool.length === 1 ? s.pool[0] : this.rng.pick(s.pool);
    const def = EVENT_DEFS.get(id);
    if (!def || def.implemented === false) return null;

    const t = def.timing || {};
    const total = (t.warning || 0) + (t.duration || 45);
    const lo = duration * s.earliest;
    const hi = Math.min(duration * s.latest, duration - total - s.tailGuard);
    /* A match too short to fit the event plus its tail simply has no event.
       Better than a storm that is still raining on the results screen. */
    if (hi <= lo) return null;

    this._plan = { id, at: this.rng.range(lo, hi) };
    return this._plan;
  }

  /* ---------------------------------------------------------------- frame --- */

  /**
   * @param {number} dt   seconds
   * @param {object} ctx  { elapsed, duration, holes, player }
   */
  update(dt, ctx = {}) {
    /* A backgrounded tab hands back one enormous dt. vehicles.js clamps at
       0.2 for the same reason: without this the storm can fast-forward through
       its entire envelope in a single frame, firing every lightning strike at
       once and ending before it visibly began. */
    if (!(dt > 0)) return;
    if (dt > 0.2) dt = 0.2;

    this._elapsed = ctx.elapsed ?? (this._elapsed + dt);

    /* Quality can change mid-storm (the adaptive fallback walks tiers down).
       Re-read it twice a second — cheap enough to be honest, rare enough that
       the renderer is not asked to resize a particle buffer every frame. */
    if (this._elapsed - this._qualityAt > 0.5 || this._qualityAt < 0) {
      this._qualityAt = this._elapsed;
      const q = this._qualityOverride;
      this._qualityName = typeof q === 'function' ? q()
        : typeof q === 'string' ? q
        : inferQualityName();
    }

    if (!this._active) {
      this._autoStart(ctx);
      this._decayClearing(dt);
      this._publish();
      return;
    }

    const ev = this._active;
    ev.t += dt;

    if (ev.phase === EVENT_PHASE.WARNING) {
      ev.warnLeft = Math.max(0, ev.warning - ev.t);
      if (ev.t >= ev.warning) this._landfall(ev, ctx);
    }
    if (ev.phase === EVENT_PHASE.ACTIVE) {
      ev.timeLeft = Math.max(0, ev.total - ev.t);
    }

    if (ev.id === TROPICAL_STORM.id) this._updateStorm(ev, dt, ctx);

    if (ev.t >= ev.total) { this.stop('ended'); this._publish(); return; }
    this._publish();
  }

  _autoStart(ctx) {
    const s = this.schedule;
    if (!s.enabled || this._fired >= s.maxPerMatch) return;
    const duration = ctx.duration;
    if (!(duration > 0)) return;
    if (!this._planned) this.plan(duration);
    const p = this._plan;
    if (!p) return;
    if (this._elapsed >= p.at) {
      /* Consume the plan whether or not start() succeeds, so a refusal does not
         retry sixty times a second for the rest of the match. */
      this._plan = null;
      this.start(p.id, { ctx });
    }
  }

  /** Ease the descriptor back to neutral after an event ends. */
  _decayClearing(dt) {
    if (!this._clearing) return;
    const e = this._env;
    const k = Math.exp(-2.2 * dt);
    e.intensity *= k;
    e.cloudDarkness *= k;
    e.rainDensity *= k;
    e.wetness *= Math.exp(-0.55 * dt);   // roads dry slower than the sky clears
    e.lightningFlash = 0;
    e.strike = false;
    e.windSpeed *= k;
    e.windVec.x *= k;
    e.windVec.z *= k;
    e.trafficSpeedScale = 1 - (1 - e.trafficSpeedScale) * k;
    e.pedShelterUrge *= k;
    e.headlightBias *= k;
    if (e.intensity < 0.004 && e.wetness < 0.01) {
      this._clearing = 0;
      this._resetEnv();
    }
  }

  _landfall(ev, ctx) {
    ev.phase = EVENT_PHASE.ACTIVE;
    ev.warnLeft = 0;
    this._banner({
      kind: 'start',
      id: ev.id,
      name: ev.name,
      short: ev.def.short,
      icon: ev.icon,
      color: ev.color,
      message: ev.def.short ? `${ev.def.short} INBOUND` : ev.name,
      sub: ev.debris.length ? `${ev.clusters.length} debris clusters on the map` : '',
      seconds: ev.duration,
      countdownTo: 'clear',
      sting: (ev.def.sounds && ev.def.sounds.start) || null,
    });
    this._sting(ev.def.sounds && ev.def.sounds.start, {});
    /* The beds start here and are stopped by stop() on EVERY exit path; an
       ambience loop that outlives its event is the "loops continue after
       restart" bug in the spec's audio checklist. */
    this._sting(ev.def.sounds && ev.def.sounds.loop, { loop: true });
    const A = (ev.def.sounds && ev.def.sounds.audio) || null;
    if (A) {
      this._audio(A.sting, ev.id);
      this._audio(A.start);
      const loops = [];
      for (const name of A.loops || []) {
        const h = this._audio(name);
        if (h) loops.push(h);
      }
      ev.loops = loops.length ? loops : null;
      ev.loopIntensity = -1;
    }
    /* Hand the debris field over exactly once, at landfall rather than at the
       alert: the point of the lead time is that players get a warning, not a
       head start on the loot. */
    if (ev.debris.length && typeof this.onDebris === 'function') {
      this.onDebris(ev.debris, ev);
    }
    void ctx;
  }

  /* ================================================================ STORM === */

  _initStorm(ev, opts) {
    const cfg = ev.def;
    this._placeDebris(ev, (opts && opts.ctx) || {});
    ev.marker = this._stormMarker(ev);

    /* Lightning times, drawn ONCE. A per-frame probability roll would desync
       clients and would also, over 50 seconds, occasionally produce a strobe.
       Pre-scheduling lets the MIN_GAP be a guarantee rather than a hope. */
    const L = cfg.visual.lightning;
    const strikes = [];
    const window0 = cfg.timing.build * 0.5;
    const window1 = ev.duration - cfg.timing.ease * 0.35;
    const expected = Math.max(0, Math.round((L.rate / 60) * (window1 - window0)));
    let t = window0;
    for (let i = 0; i < expected; i++) {
      const step = Math.max(
        STORM_LIMITS.LIGHTNING_MIN_GAP,
        (window1 - window0) / Math.max(1, expected) * this.rng.range(0.55, 1.45),
      );
      t += step;
      if (t > window1) break;
      strikes.push(t);
    }
    ev.strikes = strikes;
    ev.strikeI = 0;
  }

  /**
   * Storm envelope. 0 before landfall (bar a hint of pre-gust), ramps up over
   * `build`, holds, ramps down over `ease`.
   */
  _stormIntensity(ev) {
    const T = ev.def.timing;
    if (ev.phase === EVENT_PHASE.WARNING) {
      // Pre-gust only: the palms start moving while the banner is still up.
      const k = ev.warning > 0 ? clamp01(ev.t / ev.warning) : 1;
      return T.preGust * k * k;
    }
    const u = ev.t - ev.warning;                    // seconds since landfall
    const up = smoothstep(0, Math.max(0.1, T.build), u);
    const down = 1 - smoothstep(ev.duration - Math.max(0.1, T.ease), ev.duration, u);
    return clamp01(Math.min(up, down));
  }

  _updateStorm(ev, dt, ctx) {
    const cfg = ev.def;
    const V = cfg.visual;
    const W = cfg.wind;
    const N = cfg.npc;
    const e = this._env;
    const i = this._stormIntensity(ev);
    ev.intensity = i;

    e.id = ev.id;
    e.phase = ev.phase;
    e.active = true;
    e.intensity = i;

    /* --- look. Every ceiling applied here, not in the config, so a content
       edit can never raise them by accident. --- */
    e.cloudDarkness = Math.min(V.cloudDarkness, STORM_LIMITS.CLOUD_DARKNESS_MAX) * i;
    /* Rain arrives faster than it leaves — the smoothstep front loads it in
       over the first fifth of the envelope, then the linear tail lets it fade
       across the whole ease instead of hanging at full density until the last
       two seconds. That asymmetry is both how a squall behaves and what gives
       the wetness lag below something to lag behind. */
    e.rainDensity = Math.min(V.rainDensity, STORM_LIMITS.RAIN_DENSITY_MAX)
      * smoothstep(0.06, 0.42, i) * (0.35 + 0.65 * i);

    /* Wetness lags: roads keep their sheen after the rain eases. Rises with the
       rain, falls on its own slow clock. */
    const wetTarget = Math.min(V.wetness, STORM_LIMITS.WETNESS_MAX) * i;
    if (wetTarget > e.wetness) e.wetness += (wetTarget - e.wetness) * (1 - Math.exp(-1.6 * dt));
    else e.wetness = Math.max(wetTarget, e.wetness - V.wetnessDecay * dt);

    /* --- wind. Deterministic: phases were drawn once at start(). --- */
    const gust = 1 - W.gustDepth * 0.5
      + W.gustDepth * 0.5 * (
        Math.sin(ev.t * (6.283 / W.gustA) + ev.windPhaseA) * 0.6
        + Math.sin(ev.t * (6.283 / W.gustB) + ev.windPhaseB) * 0.4
      );
    const heading = W.heading
      + W.swing * Math.sin(ev.t * (6.283 / W.swingPeriod) + ev.windPhaseS);
    const speed = STORM_LIMITS.WIND_SPEED_MAX * i * clamp(gust, 0.25, 1.35);
    e.windSpeed = speed;
    e.windVec.x = Math.cos(heading) * speed;
    e.windVec.z = Math.sin(heading) * speed;
    ev.gust = gust;
    ev.heading = heading;

    /* --- lightning. Pre-scheduled; MIN_GAP is guaranteed by construction. --- */
    e.strike = false;
    e.lightningFlash = Math.max(0, e.lightningFlash - dt / Math.max(0.05, V.lightning.falloff));
    const sinceLandfall = ev.t - ev.warning;
    while (ev.strikeI < ev.strikes.length && sinceLandfall >= ev.strikes[ev.strikeI]) {
      ev.strikeI++;
      const f = Math.min(V.lightning.flash, STORM_LIMITS.LIGHTNING_FLASH_MAX) * (0.7 + 0.3 * i);
      e.lightningFlash = Math.max(e.lightningFlash, f);
      e.strike = true;
      /* Thunder is a rumble, so it gets a shake and a sting — no screen effect
         beyond the flash the renderer already applies from the descriptor. */
      if (this.effects && typeof this.effects.addShake === 'function') {
        this.effects.addShake(V.lightning.shake * i);
      }
      this._sting(cfg.sounds.thunder, { strength: i });
      /* audio.thunder(distance): 0 is an overhead crack, 1 a roll on the
         horizon. Walk it closer as the storm peaks — same bolt, nearer sky —
         and never all the way to 0, because the crack is the loudest thing the
         mixer makes and this fires several times a match. It is internally
         rate-limited too, so a burst cannot stack into distortion. */
      const A = cfg.sounds.audio;
      if (A) this._audio(A.thunder, clamp(0.85 - 0.45 * i, 0.35, 1));
    }

    /* --- quality tier --- */
    const q = RAIN_QUALITY[this._qualityName] || RAIN_QUALITY.high;
    e.quality = this._qualityName;
    e.rainMode = q.rainMode;
    e.rainBudget = q.rainBudget;
    e.splashes = q.splashes;
    e.puddles = q.puddles;
    e.streakLen = q.streakLen;

    /* --- intent flags. Other systems read these; nobody is reached into. --- */
    e.trafficSpeedScale = 1 - (1 - Math.max(N.trafficSpeedScale, STORM_LIMITS.TRAFFIC_SPEED_FLOOR)) * i;
    /* Shelter urge leads the rain — people move when the sky darkens. */
    e.pedShelterUrge = clamp01(N.pedShelterUrge * clamp01(i + N.shelterLead));
    e.headlightBias = N.headlightBias * smoothstep(0.05, 0.5, i);

    /* Drive the audio beds off the same envelope as the visuals, but only when
       the value has actually moved: setIntensity schedules a WebAudio param
       ramp, and scheduling one every frame on every bed is both pointless and
       the classic way to build a thousand-event automation queue. */
    if (ev.loops && Math.abs(i - ev.loopIntensity) > 0.03) {
      ev.loopIntensity = i;
      for (const h of ev.loops) {
        if (h && typeof h.setIntensity === 'function') {
          try { h.setIntensity(i); } catch (err) { void err; }
        }
      }
    }

    void ctx;
  }

  /** Marker over the debris field; falls back to the storm core if none landed. */
  _stormMarker(ev) {
    const cl = ev.clusters;
    if (!cl.length) {
      return { x: 0, z: 0, r: 220, id: ev.id, color: ev.color, label: ev.def.short, kind: 'storm' };
    }
    let cx = 0, cz = 0;
    for (const c of cl) { cx += c.x; cz += c.z; }
    cx /= cl.length; cz /= cl.length;
    let r = 0;
    for (const c of cl) r = Math.max(r, Math.hypot(c.x - cx, c.z - cz) + c.r);
    return {
      x: cx, z: cz, r: Math.max(60, r),
      id: ev.id, color: ev.color, label: ev.def.short, kind: 'storm',
      /* Cluster pips, so the minimap can show WHERE the loot is rather than a
         single vague blob the size of downtown. */
      points: cl.map((c) => ({ x: c.x, z: c.z, r: c.r })),
    };
  }

  /* --------------------------------------------------------------- debris --- */

  /**
   * Is (x,z) a legal place to drop debris?
   *
   * Order matters: the cheap analytic rejections run before the supplied
   * callback, which may be doing a spatial query.
   */
  _spotOk(x, z, cfg) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    const B = cfg.bounds;
    if (x < B.xMin || x > B.xMax || z < B.zMin || z > B.zMax) return false;
    /* THE ONE FAILURE THE SPEC NAMES: nothing in the water, ever. Checked here
       even when a validate() callback was supplied, because a caller passing a
       hole-spawn validator would technically also cover it — and one day
       somebody will pass one that does not. */
    const L = this.layout;
    if (L && typeof L.isWater === 'function' && L.isWater(x, z)) return false;
    if (cfg.keepOffRoads && L && typeof L.isRoad === 'function' && L.isRoad(x, z)) return false;
    if (this.validate) {
      const v = this.validate(x, z);
      if (v === false || (v && typeof v === 'object' && v.ok === false)) return false;
    }
    return true;
  }

  _placeDebris(ev, ctx) {
    const cfg = ev.def.debris;
    if (!cfg || !cfg.enabled) return;

    const kinds = ev.def.debrisKinds;
    const rewards = ev.def.rewards;
    const holes = (ctx && ctx.holes) || [];
    const B = cfg.bounds;
    const centres = [];

    for (let c = 0; c < cfg.clusters; c++) {
      let cx = 0, cz = 0, found = false;
      for (let a = 0; a < cfg.attemptsPerCluster; a++) {
        cx = this.rng.range(B.xMin, B.xMax);
        cz = this.rng.range(B.zMin, B.zMax);
        if (!this._spotOk(cx, cz, cfg)) continue;
        let clash = false;
        for (const p of centres) {
          if (Math.hypot(cx - p.x, cz - p.z) < cfg.minSeparation) { clash = true; break; }
        }
        if (clash) continue;
        for (const h of holes) {
          if (!h || !h.position) continue;
          const clear = cfg.minHoleClearance + (h.radius || 0);
          if (Math.hypot(cx - h.position.x, cz - h.position.z) < clear) { clash = true; break; }
        }
        if (clash) continue;
        found = true;
        break;
      }
      /* A cluster that cannot find a home is simply not placed. Never relax the
         constraints to hit a count — that is how a crate ends up in the bay. */
      if (!found) continue;
      centres.push({ x: cx, z: cz, r: cfg.clusterRadius });
    }

    const items = [];
    let uid = 1;
    for (let ci = 0; ci < centres.length; ci++) {
      const c = centres[ci];
      const want = this.rng.int(cfg.itemsMin, cfg.itemsMax);
      let placed = 0;
      for (let i = 0; i < want; i++) {
        let ix = 0, iz = 0, ok = false;
        for (let a = 0; a < cfg.attemptsPerItem; a++) {
          /* sqrt keeps the scatter areal rather than centre-heavy: a cluster
             should look dropped by the wind, not poured out of a bucket. */
          const rad = Math.sqrt(this.rng()) * cfg.clusterRadius;
          const ang = this.rng.range(0, 6.283);
          ix = c.x + Math.cos(ang) * rad;
          iz = c.z + Math.sin(ang) * rad;
          if (this._spotOk(ix, iz, cfg)) { ok = true; break; }
        }
        if (!ok) continue;
        const k = pickWeighted(kinds, this.rng);
        items.push({
          id: `${ev.id}-${uid++}`,
          cluster: ci,
          x: ix,
          /** Ground level. Everything in this city rests on y = 0. */
          y: WORLD.GROUND_Y,
          z: iz,
          rotationY: this.rng.range(0, 6.283),
          kind: k.kind,
          label: k.label,
          tier: k.tier,
          radius: k.radius,
          height: k.height,
          passRadius: k.passRadius,
          score: Math.round(k.tier.score * rewards.scoreMul),
          /** Set by claim(). Null while nobody has taken it. */
          claimedBy: null,
        });
        placed++;
      }
      c.total = placed;
      c.taken = 0;
      c.bonusPaid = false;
    }

    /* Drop clusters that ended up empty, so progress() never reports 0/0 rows
       and the marker is not stretched around a point with nothing at it.
       REINDEX as we go: `it.cluster` is an index into `centres`, and claim()
       looks it up in `ev.clusters`. Filtering one without remapping the other
       is the classic parallel-array bug — it would silently pay the completion
       bonus for the wrong cluster, or for none. */
    const remap = new Map();
    ev.clusters = [];
    for (let i = 0; i < centres.length; i++) {
      const c = centres[i];
      if (!c.total) continue;
      remap.set(i, ev.clusters.length);
      ev.clusters.push(c);
    }
    ev.debris = [];
    for (const it of items) {
      const ni = remap.get(it.cluster);
      if (ni === undefined) continue;
      it.cluster = ni;
      ev.debris.push(it);
    }
    ev.taken = 0;
  }

  /**
   * Mark one debris item as eaten.
   *
   * The orchestrator calls this from whatever hook it already has on capture.
   * THIS DOES NOT AWARD SCORE — the item's own `score` was carried by the real
   * Consumable and paid by ConsumeSystem._capture, which is the only legitimate
   * path. The return value is the CLUSTER COMPLETION BONUS, which the caller
   * pays with hole.addScore(bonus, label) if it is non-zero.
   *
   * @returns {number} bonus points, or 0
   */
  claim(itemId, hole) {
    const ev = this._active;
    if (!ev) return 0;
    const it = ev.debris.find((d) => d.id === itemId);
    if (!it || it.claimedBy) return 0;
    it.claimedBy = hole || true;
    ev.taken++;
    const c = ev.clusters[it.cluster];
    if (!c) return 0;
    c.taken++;
    const R = ev.def.rewards;
    if (!c.bonusPaid && c.total > 0 && c.taken / c.total >= R.clearFraction) {
      c.bonusPaid = true;
      return R.clusterBonus;
    }
    return 0;
  }

  /* ----------------------------------------------------------------- wind --- */

  /**
   * Wind force on a loose prop, as an ACCELERATION in m/s^2 on the XZ plane.
   *
   * @param {object} c    a Consumable
   * @param {object} [out] reused {x,z}; the shared scratch is returned if omitted
   * @returns {{x:number,z:number}}
   *
   * THE CAP, AND WHY IT IS SAFE
   *   STORM_LIMITS.WIND_ACCEL_MAX is 0.9 m/s^2 — about a tenth of gravity.
   *   This function returns acceleration only; the CALLER integrates it, and
   *   the caller must do two things or the cap means nothing:
   *
   *     1. apply linear drag, e.g.  v += (a - 3*v) * dt
   *        At the 0.9 cap that gives a terminal drift of 0.3 m/s.
   *     2. clamp the accumulated offset from the prop's authored rest position
   *        to about +/- 1.5 m.
   *
   *   Clamp (2) is not optional. This module cannot see collision, kerbs, walls
   *   or the shoreline, and the gust term is signed and oscillating rather than
   *   steady — so without a leash a can would, over a 52 s storm, occasionally
   *   walk somewhere absurd. With it, the whole effect is a visible jitter
   *   around where the prop has always been, which is exactly the spec's
   *   "roll/slide a little in wind, but never become chaotic physics spam".
   *
   * WHAT IS EXCLUDED, AND WHY EACH ONE MATTERS
   *   - anything not TIER.TINY. Litter blows about; a bench does not, and a
   *     bench that does undermines every weight cue the consume system spent
   *     its whole design on.
   *   - anything with a footprint over WIND_PROP_RADIUS_MAX. Tier is authored
   *     content and content drifts; this is the second gate that catches a
   *     mis-tagged 3 m object.
   *   - anything not in STATE.IDLE. A prop that is wobbling or falling is being
   *     eaten. Adding a sideways force there fights ConsumeSystem's suction and
   *     support solve for the object's own centre — the visible result is props
   *     skating around a hole's rim instead of going in.
   *
   * PERFORMANCE CONTRACT
   *   O(1), allocation-free, no RNG. But it is the CALLER's job to only ask
   *   about props it is already iterating — typically the registry.query()
   *   result around the camera or the player. Walking all ~23,800 consumables
   *   every frame to add a 0.3 m/s jitter to litter nobody can see is the
   *   "physics spam" this design exists to prevent.
   */
  windForce(c, out) {
    const o = out || this._windScratch;
    o.x = 0; o.z = 0;

    const ev = this._active;
    if (!ev || !ev.def.wind || !ev.def.wind.movesProps) return o;
    const e = this._env;
    if (e.intensity <= 0.02) return o;
    if (!c || !c.tier) return o;
    if (c.tier.id !== TIER.TINY.id) return o;
    if (c.state !== STATE.IDLE) return o;
    if ((c.radius || 0) > STORM_LIMITS.WIND_PROP_RADIUS_MAX) return o;

    /* Per-prop variation from a stable hash, never from the RNG stream: two
       cans a metre apart should not move in lockstep, and the city seed must
       not depend on how many frames of rain a client rendered. */
    const h = hash01(c.id || 0);
    /* Lighter litter catches more wind. radius is 0.16..0.72 across the city's
       TINY tier, so this spans roughly 1.0 down to 0.55. */
    const light = clamp(0.45 / Math.max(0.14, c.radius || 0.3), 0.5, 1.0);
    const a = STORM_LIMITS.WIND_ACCEL_MAX
      * clamp01(e.intensity)
      * clamp(ev.gust || 1, 0.25, 1.35)
      * (0.55 + 0.9 * h)
      * light;
    const mag = Math.min(a, STORM_LIMITS.WIND_ACCEL_MAX);

    const speed = e.windSpeed || 1;
    o.x = (e.windVec.x / speed) * mag;
    o.z = (e.windVec.z / speed) * mag;
    return o;
  }
}

const EMPTY = Object.freeze([]);

/** Weighted pick over a `weight` field. Local: rng.weighted wants pairs. */
function pickWeighted(list, rng) {
  let total = 0;
  for (const k of list) total += k.weight || 1;
  let r = rng() * total;
  for (const k of list) { r -= (k.weight || 1); if (r <= 0) return k; }
  return list[list.length - 1];
}

/* ========================================================================== *
 * SELF TEST
 *
 * Headless, no THREE objects, no DOM. Run it from node:
 *   node -e "import('./src/gameplay/cityEvents.js').then(m=>console.log(m.__selftest()))"
 *
 * Covers the four properties that are expensive to discover in a live match:
 *   1. only ONE major event can be active
 *   2. a full duration lifecycle: warning -> landfall -> peak -> clear
 *   3. clearAll() leaves no residue
 *   4. windForce() is 0 for anything that is not TINY
 * ========================================================================== */
export function __selftest() {
  const checks = [];
  const ok = (name, cond, detail) => checks.push({ name, pass: !!cond, detail: cond ? '' : (detail || '') });

  /* Deterministic RNG so a failure is reproducible. Same generator the city
     uses, seeded independently of it. */
  let s = 424242 >>> 0;
  const rng = () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /* A layout stand-in with a real water mask: everything east of the bay edge,
     plus a river band, so the placement rejections are actually exercised. */
  const layout = {
    isWater: (x, z) => x > WORLD.BAY_EDGE || Math.abs(z) < WORLD.RIVER_HALF_W,
    isRoad: (x, z) => (Math.abs(x % WORLD.BLOCK) < WORLD.ROAD_W) || (Math.abs(z % WORLD.BLOCK) < WORLD.ROAD_W),
  };
  const scene = { userData: {} };
  const banners = [];
  const markers = [];
  const debrisPushes = [];

  const mgr = new EventManager({ rng, layout, scene, quality: 'low' });
  mgr.onBanner = (b) => banners.push(b);
  mgr.onMarker = (m) => markers.push(m);
  mgr.onDebris = (items) => debrisPushes.push(items.length);

  /* ---------------------------------------------------- 1. only one active --- */
  const first = mgr.start(TROPICAL_STORM.id);
  ok('start returns a runtime', !!first);
  const second = mgr.start(TROPICAL_STORM.id);
  ok('second major event refused', second === null);
  ok('still exactly one active', mgr.active() === first);
  ok('unimplemented event refused', mgr.start(CLEANUP_CONVOY.id) === null);
  ok('unknown event refused', mgr.start('no-such-event') === null);
  ok('announced with a banner', banners.length === 1 && banners[0].kind === 'alert');
  ok('announced with a marker', markers.length === 1 && markers[0] && Number.isFinite(markers[0].r));
  ok('announced with a countdown', banners[0].seconds === TROPICAL_STORM.timing.warning);
  ok('announced with a sting id', banners[0].sting === TROPICAL_STORM.sounds.warn);

  /* ------------------------------------------------------ debris placement --- */
  const items = mgr.debris();
  ok('debris placed', items.length > 0, `got ${items.length}`);
  let dry = true, offRoad = true, inBounds = true;
  for (const it of items) {
    if (layout.isWater(it.x, it.z)) dry = false;
    if (layout.isRoad(it.x, it.z)) offRoad = false;
    if (Math.abs(it.x) > WORLD.SIZE || Math.abs(it.z) > WORLD.SIZE) inBounds = false;
  }
  ok('no debris in water', dry);
  ok('no debris on a carriageway', offRoad);
  ok('all debris inside the map', inBounds);
  ok('debris carries no mesh', items.every((it) => !it.object && !it.mesh));
  ok('every item points at a real cluster',
    items.every((it) => !!first.clusters[it.cluster]));
  ok('cluster totals match the item list',
    first.clusters.reduce((n, c) => n + c.total, 0) === items.length);

  /* claim(): bookkeeping only — the bonus is a RETURN VALUE the caller pays. */
  const c0 = items.filter((it) => it.cluster === 0);
  let bonus = 0;
  const need = Math.ceil(first.clusters[0].total * TROPICAL_STORM.rewards.clearFraction);
  for (let i = 0; i < need; i++) bonus += mgr.claim(c0[i].id, { id: 1 });
  ok('cluster bonus paid once at the clear fraction', bonus === TROPICAL_STORM.rewards.clusterBonus, `${bonus}`);
  ok('claiming the same item twice pays nothing', mgr.claim(c0[0].id, { id: 1 }) === 0);
  ok('progress tracks claims', mgr.progress().taken === need);

  /* ------------------------------------------------------- 2. full lifecycle --- */
  const dt = 1 / 30;
  const total = first.total;
  let sawWarning = false, sawActive = false, peak = 0, maxCloud = 0, maxRain = 0, maxFlash = 0;
  let strikeTimes = [];
  let elapsed = 0;
  for (let i = 0; i < Math.ceil((total + 6) / dt); i++) {
    elapsed += dt;
    mgr.update(dt, { elapsed, duration: 240, holes: [], player: null });
    const e = mgr.env();
    if (mgr.active() && mgr.active().phase === EVENT_PHASE.WARNING) sawWarning = true;
    if (mgr.active() && mgr.active().phase === EVENT_PHASE.ACTIVE) sawActive = true;
    peak = Math.max(peak, e.intensity);
    maxCloud = Math.max(maxCloud, e.cloudDarkness);
    maxRain = Math.max(maxRain, e.rainDensity);
    maxFlash = Math.max(maxFlash, e.lightningFlash);
    if (e.strike) strikeTimes.push(elapsed);
  }
  ok('warning phase ran', sawWarning);
  ok('active phase ran', sawActive);
  ok('reached full intensity', peak > 0.98, `peak ${peak.toFixed(3)}`);
  ok('event ended on time', mgr.active() === null);
  ok('debris handed over once', debrisPushes.length >= 1 && debrisPushes[0] === items.length);
  ok('end banner fired', banners.some((b) => b.kind === 'end'));
  ok('marker cleared at the end', markers[markers.length - 1] === null);

  /* readability ceilings — these are the ones that must never regress */
  ok('cloud darkness capped', maxCloud <= STORM_LIMITS.CLOUD_DARKNESS_MAX + 1e-6, `${maxCloud}`);
  ok('rain density capped', maxRain <= STORM_LIMITS.RAIN_DENSITY_MAX + 1e-6, `${maxRain}`);
  ok('lightning flash capped', maxFlash <= STORM_LIMITS.LIGHTNING_FLASH_MAX + 1e-6, `${maxFlash}`);
  let gapOk = true;
  for (let i = 1; i < strikeTimes.length; i++) {
    if (strikeTimes[i] - strikeTimes[i - 1] < STORM_LIMITS.LIGHTNING_MIN_GAP - 1e-3) gapOk = false;
  }
  ok('no lightning strobe', gapOk, `${strikeTimes.length} strikes`);

  /* quality tier honoured: 'low' must use the sheet, not thousands of drops */
  ok('low quality uses the sheet', RAIN_QUALITY.low.rainMode === 'sheet');

  /* the descriptor decays rather than snapping, then reaches true neutral */
  for (let i = 0; i < 300; i++) mgr.update(dt, { elapsed: (elapsed += dt), duration: 240, holes: [] });
  const settled = mgr.env();
  ok('descriptor settles to neutral', settled.intensity === 0 && settled.wetness === 0 && settled.active === false);
  ok('traffic released', settled.trafficSpeedScale === 1);

  /* ------------------------------------------------- 3. clearAll: no residue --- */
  /* A stand-in for the audio singleton that models the one property that
     matters here: loops are HANDLES that stay live until stopped. "No audio
     loop survives a match restart" is on the spec's test checklist, so it is
     part of the residue check rather than a separate concern. */
  const audioLog = [];
  const liveLoops = new Set();
  const fakeLoop = (name) => {
    const h = {
      name, active: true, intensity: -1,
      setIntensity(v) { this.intensity = v; return this; },
      stop() { if (this.active) { this.active = false; liveLoops.delete(this); } return this; },
    };
    liveLoops.add(h);
    return h;
  };
  const fakeAudio = {
    eventWarning() { audioLog.push('warn'); return this; },
    eventSting(k) { audioLog.push(`sting:${k}`); return this; },
    stormStart() { audioLog.push('start'); return this; },
    stormLoop() { audioLog.push('stormLoop'); return fakeLoop('storm'); },
    rainLoop() { audioLog.push('rainLoop'); return fakeLoop('rain'); },
    thunder(d) { audioLog.push(`thunder:${d.toFixed(2)}`); return this; },
    /* Mirrors the real stormEnd(), which releases both beds itself. */
    stormEnd() { audioLog.push('end'); for (const h of Array.from(liveLoops)) h.stop(); return this; },
  };

  const mgr2 = new EventManager({ rng, layout, scene, quality: 'high', audio: fakeAudio });
  let lastMarker2 = 'unset';
  mgr2.onMarker = (m) => { lastMarker2 = m; };
  mgr2.start(TROPICAL_STORM.id);
  for (let i = 0; i < 400; i++) mgr2.update(dt, { elapsed: i * dt, duration: 240, holes: [] });
  ok('storm is running before clearAll', mgr2.active() !== null && mgr2.env().intensity > 0);
  ok('audio bridge announced', audioLog[0] === 'warn' && audioLog.includes('start'));
  ok('audio beds running', liveLoops.size === 2);
  ok('bed intensity follows the envelope',
    Array.from(liveLoops).every((h) => h.intensity > 0.5));
  mgr2.clearAll();
  ok('no audio bed survives clearAll', liveLoops.size === 0);
  const e2 = mgr2.env();
  const residue = [];
  if (mgr2.active() !== null) residue.push('active');
  if (e2.active !== false || e2.id !== null || e2.phase !== null) residue.push('descriptor identity');
  for (const k of ['intensity', 'cloudDarkness', 'rainDensity', 'wetness', 'lightningFlash',
    'windSpeed', 'pedShelterUrge', 'headlightBias', 'rainBudget']) {
    if (e2[k] !== 0) residue.push(k);
  }
  if (e2.trafficSpeedScale !== 1) residue.push('trafficSpeedScale');
  if (e2.strike !== false) residue.push('strike');
  if (e2.windVec.x !== 0 || e2.windVec.z !== 0) residue.push('windVec');
  if (mgr2.debris().length !== 0) residue.push('debris');
  if (mgr2.progress().total !== 0) residue.push('progress');
  if (lastMarker2 !== null) residue.push('marker');
  if (scene.userData.storm !== e2) residue.push('scene.userData.storm detached');
  if (scene.userData.storm.active !== false) residue.push('scene.userData.storm live');
  if (mgr2._planned !== false || mgr2._plan !== null) residue.push('schedule');
  if (mgr2.countdown() !== 0) residue.push('countdown');
  ok('clearAll leaves no residue', residue.length === 0, residue.join(', '));
  /* clearAll must be safe to call twice, and on an idle manager. */
  mgr2.clearAll();
  ok('clearAll is idempotent', mgr2.active() === null && mgr2.env().intensity === 0);

  /* ...and a storm that ends NATURALLY must release its beds too — that is a
     different code path (stormEnd) from the teardown above (_stopLoops). */
  audioLog.length = 0;
  const run2 = mgr2.start(TROPICAL_STORM.id);
  ok('a cleared manager can start again', !!run2);
  /* Cache the length: active() goes null the moment the event ends, and
     re-reading it as the loop bound would throw on the last iteration. */
  const frames2 = Math.ceil(((run2 ? run2.total : 0) + 3) / dt);
  for (let i = 0; i < frames2; i++) {
    mgr2.update(dt, { elapsed: i * dt, duration: 240, holes: [] });
  }
  ok('natural end releases the beds', liveLoops.size === 0 && audioLog.includes('end'));
  ok('thunder routed to audio', audioLog.some((l) => l.startsWith('thunder')));
  mgr2.clearAll();

  /* ------------------------------------------- 4. windForce: TINY props only --- */
  const mgr3 = new EventManager({ rng, layout, quality: 'high' });
  mgr3.start(TROPICAL_STORM.id);
  for (let i = 0; i < 900; i++) mgr3.update(dt, { elapsed: i * dt, duration: 240, holes: [] });
  ok('storm at strength for the wind test', mgr3.env().intensity > 0.5);

  const mk = (tier, radius, state) => ({ id: 7 + tier.id, tier, radius, state });
  const tiny = mk(TIER.TINY, 0.3, STATE.IDLE);
  const fTiny = mgr3.windForce(tiny, { x: 0, z: 0 });
  ok('TINY prop gets a force', Math.hypot(fTiny.x, fTiny.z) > 0);
  ok('TINY force is under the cap',
    Math.hypot(fTiny.x, fTiny.z) <= STORM_LIMITS.WIND_ACCEL_MAX + 1e-9,
    `${Math.hypot(fTiny.x, fTiny.z)}`);

  const zeros = [];
  for (const t of [TIER.SMALL, TIER.MEDIUM, TIER.LARGE, TIER.XLARGE, TIER.HUGE, TIER.MASSIVE, TIER.LANDMARK]) {
    const f = mgr3.windForce(mk(t, 0.3, STATE.IDLE), { x: 0, z: 0 });
    if (f.x !== 0 || f.z !== 0) zeros.push(t.label);
  }
  ok('non-TINY props get exactly zero', zeros.length === 0, zeros.join(', '));

  const big = mgr3.windForce(mk(TIER.TINY, 2.0, STATE.IDLE), { x: 0, z: 0 });
  ok('oversized TINY gets zero', big.x === 0 && big.z === 0);
  for (const st of [STATE.WOBBLE, STATE.FALLING, STATE.GONE]) {
    const f = mgr3.windForce(mk(TIER.TINY, 0.3, st), { x: 0, z: 0 });
    if (f.x !== 0 || f.z !== 0) ok(`state ${st} must not get wind`, false);
  }
  ok('props being eaten get zero', true);
  ok('malformed input is safe',
    mgr3.windForce(null, { x: 0, z: 0 }).x === 0 && mgr3.windForce({}, { x: 0, z: 0 }).x === 0);
  mgr3.clearAll();
  ok('no wind once cleared', mgr3.windForce(tiny, { x: 0, z: 0 }).x === 0);

  const failed = checks.filter((c) => !c.pass);
  return { ok: failed.length === 0, passed: checks.length - failed.length, total: checks.length, failed, checks };
}
