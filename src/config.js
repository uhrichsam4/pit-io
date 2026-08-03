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

export const HOLE = {
  /** Starting radius, metres. */
  START_RADIUS: 1.15,
  /** radius = START_RADIUS * (1 + score/GROWTH_K)^GROWTH_P */
  GROWTH_K: 26,
  GROWTH_P: 0.415,
  MAX_RADIUS: 62,
  /** Base movement speed (m/s) at start size. */
  BASE_SPEED: 15.5,
  /** Speed multiplier falls off as the hole grows: speed = BASE*(r/r0)^SPEED_P */
  SPEED_P: 0.30,
  /** Acceleration smoothing (higher = snappier). */
  ACCEL: 11.0,
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
  /** Eating another hole requires being this much bigger. */
  PVP_RATIO: 1.18,
  /** Fraction of victim's score awarded to the eater. */
  PVP_REWARD: 0.62,
  /** Seconds a swallowed player waits before respawning. */
  RESPAWN_TIME: 2.6,
  MAX_HOLES: 12,
};

export const MATCH = {
  DURATION: 150,
  BOT_COUNT: 7,
  /** Final 30s: everything becomes edible ("frenzy"). */
  FRENZY_AT: 30,
  FRENZY_EAT_SCALE: 0.55,
};

/**
 * Size tiers. `eatRadius` is the hole radius required to swallow the object.
 * `score` is the reward. Content modules tag every consumable with a tier.
 */
export const TIER = {
  TINY: { id: 0, eatRadius: 0.0, score: 1, label: 'Litter' },
  SMALL: { id: 1, eatRadius: 1.5, score: 3, label: 'Street furniture' },
  MEDIUM: { id: 2, eatRadius: 3.2, score: 9, label: 'Bikes & carts' },
  LARGE: { id: 3, eatRadius: 6.0, score: 26, label: 'Cars & palms' },
  XLARGE: { id: 4, eatRadius: 10.5, score: 70, label: 'Buses & boats' },
  HUGE: { id: 5, eatRadius: 17.0, score: 190, label: 'Storefronts' },
  MASSIVE: { id: 6, eatRadius: 26.0, score: 520, label: 'Buildings' },
  LANDMARK: { id: 7, eatRadius: 38.0, score: 1500, label: 'Towers' },
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
