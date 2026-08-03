/**
 * MIAMI DEVOUR — global tuning constants.
 * Single source of truth. Every module imports from here; nobody hardcodes.
 *
 * NOTE ON OWNERSHIP (parallel development):
 *   PALETTE          lives in src/render/palette.js  (art direction owns it)
 *   QUALITY, CAMERA  live in src/core/quality.js     (engine/lighting owns them)
 * Both are re-exported below, so `import { PALETTE, CAMERA } from '../config.js'`
 * keeps working from anywhere.
 */

export { PALETTE } from './render/palette.js';
export { QUALITY, CAMERA } from './core/quality.js';

export const WORLD = {
  /** Half-extent of the playable square, in metres. Full map = 2*SIZE. */
  SIZE: 520,
  /** Street grid module. Blocks are multiples of this. */
  BLOCK: 68,
  /** Road half-width for standard streets. */
  ROAD_W: 11,
  /** Road half-width for avenues / major roads. */
  AVENUE_W: 17,
  SIDEWALK_W: 5.0,
  /** Ground plane sits at y=0 exactly. Everything rests on it. */
  GROUND_Y: 0,
  /** Bay occupies x > BAY_EDGE (east side). */
  BAY_EDGE: 330,
  /** Miami River channel runs roughly along this z, separating Brickell/Downtown. */
  RIVER_Z: 0,
  RIVER_HALF_W: 26,
};

/** District identifiers used by the layout + zoning system. */
export const DISTRICT = {
  BRICKELL: 'brickell',
  DOWNTOWN: 'downtown',
  WATERFRONT: 'waterfront',
  PARK: 'park',
  BAY: 'bay',
};

/* ===========================================================================
 * BALANCE — all of the numbers below were fitted against a MEASURED city, not
 * guessed. The population that the curve is balanced against (tools probe of
 * the live registry, seed 20260803) is:
 *
 *   tier            objects   footprint radius   score pool
 *   0 Litter          3,782     0.16 – 0.72         7.6k
 *   1 Furniture      12,459     0.18 – 1.90        62.3k
 *   2 Bikes & carts   3,434     0.26 – 2.40        48.1k
 *   3 Cars & palms    3,550     1.20 – 3.02       142.0k   <- the workhorse
 *   4 Buses & boats     214     1.60 – 4.40        27.8k   <- thin population
 *   5 Storefronts       266     4.99 – 27.0        90.4k
 *   6 Buildings          79     6.64 – 30.2        71.1k
 *   7 Towers             30    12.08 – 27.8        78.0k
 *                    ------                       ------
 *                    23,814                        527k  total city score
 *
 * Areal density is ~0.028 consumables/m² over built land, which is what sets
 * the score-per-metre-swept and therefore the whole growth curve.
 * =========================================================================== */

export const HOLE = {
  /**
   * Starting radius, metres.
   *
   * WHY 2.0 AND NOT 1.15: only 3,782 of 23,814 objects are TINY, i.e. one per
   * ~286 m² of city. A 1.15 m hole sweeps a 2.7 m corridor, so it met ~12
   * edible things in the first MINUTE — measured, and it felt like starving.
   * At 2.0 m the hole clears TIER.SMALL (1.7) on frame one, which puts 68% of
   * the city's objects on the menu immediately: ~2 eats/second from t=0.
   */
  START_RADIUS: 2.0,
  /**
   * radius = START_RADIUS * (1 + score/GROWTH_K)^GROWTH_P
   *
   * Fitted so a strong player crosses every tier threshold inside one 150 s
   * match, roughly every 25 s, with TOWERS landing right as the frenzy starts.
   * K sets how long the early game lasts; P sets how much the late game
   * accelerates. K=26/P=0.415 needed 119,000 points to reach the old tower
   * threshold — 38% of the entire city — so four of the eight tiers were dead
   * content nobody ever saw.
   *
   * INVERSE (score for a given radius), needed by any tool that sets size
   * directly:  score = GROWTH_K * ((r / START_RADIUS)^(1/GROWTH_P) - 1)
   *
   * WHY P IS HIGH (0.55, not the old 0.415). Score rate goes roughly as
   * r^1.375 (sweep width x speed), so r ends up proportional to
   * t^(P / (1 - 1.375P)). At P=0.42 that exponent is ~0.94 — the radius grows
   * almost LINEARLY, which measured out as "cars unlock while the hole is
   * already 20 m across". At P=0.55 the exponent is ~2.2: the hole stays small
   * and nimble through the first half, then genuinely runs away with itself.
   * That convex shape is what makes the tier ladder land in the right order at
   * the right sizes, and it is the arc the game is selling.
   */
  GROWTH_K: 300,
  GROWTH_P: 0.55,
  /**
   * Hard cap, and a deliberate brake rather than a formality. Camera distance
   * is 44 + 5.6r, so 34 m puts the camera at 234 m — the furthest out the city
   * still reads as a city. The runaway leader tops out here around t=130 while
   * everyone else keeps growing, which is the only lever available for pegging
   * a snowball back (score keeps accruing; only the hole stops).
   */
  MAX_RADIUS: 34,
  /**
   * Base movement speed (m/s) at START_RADIUS.
   * 19.5 m/s crosses the visible ground span (~42 m at the starting camera
   * distance) in 2.2 s — nippy without being twitchy.
   */
  BASE_SPEED: 19.5,
  /**
   * Speed vs size. hole.js computes BASE * (r/r0)^0.62 * (r/r0)^-SPEED_P, so
   * the NET exponent is 0.62 - SPEED_P = 0.375.
   *
   * That exponent is chosen against the camera, not in isolation: distance
   * grows linearly with r, so screen-relative speed is v(r)/(0.768*(44+5.6r)).
   * At 0.375 a starting hole crosses the frame in 2.2 s and a 30 m hole in
   * 3.0 s — big still reads as weighty, but it is no longer the slog that
   * 0.30 (net 0.32) produced, where a late-game hole took 3.7 s a frame.
   */
  SPEED_P: 0.245,
  /**
   * Velocity smoothing (higher = snappier). 13 => ~95% of target speed in
   * 0.23 s. Above ~16 the hole feels like it teleports between headings;
   * below ~10 small holes feel like they are on ice.
   * KNOWN GAP: this is size-independent, so a 30 m hole accelerates in the
   * same 0.23 s as a 2 m one — see the note in the AI/feel handover.
   */
  ACCEL: 13.0,
  /** An object is edible when hole.radius >= object.eatRadius. */
  /** Capture happens when object centre is within radius*CAPTURE_F. */
  CAPTURE_F: 0.94,
  /** Objects inside radius*INFLUENCE_F get suction applied. */
  INFLUENCE_F: 2.35,
  SUCTION_STRENGTH: 30.0,
  /** Time (s) for a captured object to disappear down the pit. */
  FALL_TIME: 0.85,
  /** Visual depth of the pit interior. */
  PIT_DEPTH_F: 3.4,
  /**
   * Eating another hole requires being this much bigger. 1.18 is deliberately
   * tight: it means the leaderboard's top two are almost always within eating
   * distance of each other, which is where the tension lives.
   */
  PVP_RATIO: 1.22,
  /**
   * Fraction of the victim's score awarded to the eater.
   * Lowered from 0.62 after measurement: at 0.62 a kill paid for itself twice
   * over and the leader snowballed into a 100x score spread. At 0.50 a kill is
   * a strong bonus that does not, by itself, decide the match.
   */
  PVP_REWARD: 0.50,
  /**
   * Fraction of their own score a swallowed hole keeps on respawn.
   *
   * 0.45 was measured to be a death spiral. Because radius goes as score^0.53,
   * losing 55% of your score costs ~30% of your radius, which costs ~40% of
   * your eating rate, which loses you the next fight too: bots that died three
   * times finished the match on 1% of the leader's score. 0.70 keeps a kill
   * painful (you drop a tier) without removing the victim from the game.
   * NOTE: game.js currently inlines 0.45 in its onRespawn handler. Match
   * enforces this constant afterwards, so the two cannot disagree — but
   * pointing game.js at HOLE.RESPAWN_KEEP is a one-word tidy-up.
   */
  RESPAWN_KEEP: 0.70,
  /**
   * Hard floor on a respawn, as a fraction of the CURRENT FIELD MEDIAN score.
   * This is the anti-spiral: die at t=130 with nothing and you still come back
   * able to eat cars, so the last 20 s are playable instead of a spectator
   * seat. It is invisible — it only ever fires for someone already last.
   */
  RESPAWN_FLOOR: 0.30,
  /** Seconds a swallowed player waits before respawning. */
  RESPAWN_TIME: 2.6,
  /**
   * Seconds after a respawn during which AI will not hunt you. Long enough to
   * read the map and pick a direction, short enough that it is not a shield.
   */
  RESPAWN_GRACE: 5.0,
  MAX_HOLES: 12,
};

export const MATCH = {
  DURATION: 150,
  BOT_COUNT: 7,
  /** Seconds of "3 / 2 / 1 / DEVOUR" before the clock starts. */
  COUNTDOWN: 3.2,
  /** Final 30s: everything becomes edible ("frenzy"). */
  FRENZY_AT: 30,
  FRENZY_EAT_SCALE: 0.55,
  /**
   * Clock milestones that raise an announcement, newest first in the feed.
   * Purely about escalation — the match rules do not branch on these.
   */
  ANNOUNCE_AT: [120, 90, 60, 30, 10],
  /**
   * Bot difficulty spread. Skill 0 is a pushover that wanders and mis-reads
   * threats; skill 1 plans well, flees early and hunts hard. A whole lobby at
   * one setting is the single biggest reason AI opponents read as scenery, so
   * the roster is dealt deliberately across this range.
   */
  BOT_SKILL_MIN: 0.18,
  BOT_SKILL_MAX: 1.0,
  /**
   * Rubber-banding. A bot this far BEHIND the leader (as a score fraction)
   * gets up to RUBBER_MAX extra planning range and target value — it looks
   * like a bot that has found a good street, not one that has been handed
   * points. Nothing is ever added to score directly.
   */
  RUBBER_MAX: 0.45,
};

/**
 * Size tiers. `eatRadius` is the hole radius required to swallow the object.
 * `score` is the reward. Content modules tag every consumable with a tier.
 *
 * THRESHOLDS are set against the measured footprint radii above, on the
 * Hole.io rule that the hole must look able to take the thing: the threshold
 * sits at or just above the largest footprint in the tier, so at the moment a
 * tier unlocks the hole is about as wide as its new food.
 *   cars   are r≈2.2 (4.4 m long) -> unlock at 5.0  (10 m hole)
 *   buses  are r≈4.4              -> unlock at 8.0  (16 m hole)
 *   towers are r≈12–28            -> unlock at 27.0 (54 m hole)
 *
 * SCORES are a ~2.8x geometric ladder, rescaled up from the old 1..1500 so
 * that (a) an early eat is worth reading in the HUD and (b) a finished match
 * scores in the tens of thousands rather than the hundreds.
 * XLARGE is deliberately off the ladder (130, not ~110): there are only 214
 * buses and boats in the whole city, so without a premium its unlock window
 * was a dead zone the player passed through without noticing.
 */
export const TIER = {
  TINY: { id: 0, eatRadius: 0.0, score: 2, label: 'Litter' },
  SMALL: { id: 1, eatRadius: 1.7, score: 5, label: 'Street furniture' },
  MEDIUM: { id: 2, eatRadius: 3.2, score: 14, label: 'Bikes & carts' },
  LARGE: { id: 3, eatRadius: 5.2, score: 40, label: 'Cars & palms' },
  XLARGE: { id: 4, eatRadius: 8.2, score: 130, label: 'Buses & boats' },
  HUGE: { id: 5, eatRadius: 12.5, score: 340, label: 'Storefronts' },
  MASSIVE: { id: 6, eatRadius: 18.0, score: 900, label: 'Buildings' },
  LANDMARK: { id: 7, eatRadius: 24.0, score: 2600, label: 'Towers' },
};

export const TIER_LIST = [
  TIER.TINY, TIER.SMALL, TIER.MEDIUM, TIER.LARGE,
  TIER.XLARGE, TIER.HUGE, TIER.MASSIVE, TIER.LANDMARK,
];

export const DEBUG = {
  /** ?debug=1 in the URL flips these on. */
  enabled: typeof location !== 'undefined' && /[?&]debug=1/.test(location.search),
  stats: false,
  freeCam: false,
};
