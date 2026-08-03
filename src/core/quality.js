/**
 * Renderer quality + camera framing — owned by the engine/lighting pass.
 * Re-exported by src/config.js so existing imports keep working.
 */

export const QUALITY = {
  /** Adjusted at runtime by the engine after probing the device. */
  shadows: true,
  shadowMapSize: 2048,
  bloom: true,
  ssao: true,
  pixelRatioCap: 2,
  anisotropy: 8,
};

export const CAMERA = {
  /** Pitch in degrees above the horizon. Hole.io-ish high 3/4 view. */
  PITCH: 54,
  YAW: -35,
  /** distance = DIST_BASE + radius*DIST_PER_R (then smoothed) */
  DIST_BASE: 44,
  DIST_PER_R: 5.6,
  FOV: 42,
  NEAR: 0.5,
  FAR: 3000,
  FOLLOW_LERP: 5.5,
  ZOOM_LERP: 2.0,
};
