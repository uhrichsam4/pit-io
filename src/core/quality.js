/**
 * Renderer quality, light rig and colour grade — owned by the engine/lighting pass.
 * Re-exported by src/config.js so existing imports keep working.
 *
 * WHY THREE SEPARATE BLOCKS
 *   QUALITY  — things that trade frame time for fidelity. Mutated at runtime by
 *              the adaptive fallback, so nothing may cache a value from it.
 *   LIGHTING — the physical rig. These are *illuminants*, not surface colours,
 *              which is why they live here and not in PALETTE (PALETTE is the
 *              albedo law; mixing light colours into it would let a re-grade of
 *              the city silently change the time of day).
 *   GRADE    — the look. Applied once, in post, after tone mapping decisions.
 */

/* ------------------------------------------------------------------ tiers --- */

/**
 * Quality presets, cheapest last. `Engine` walks *down* this list when the
 * frame budget is blown; it never walks back up, because oscillating between
 * tiers is far more objectionable than sitting one notch too low.
 */
export const QUALITY_TIERS = [
  {
    name: 'high',
    shadowMapSize: 3072, shadowRadius: 3.0, shadows: true,
    ao: true, aoSamples: 16, aoDenoiseSamples: 16, aoScale: 1.0,
    bloom: true, smaa: true, pixelRatioCap: 2, anisotropy: 8, skyDetail: 2,
  },
  {
    name: 'medium',
    shadowMapSize: 2048, shadowRadius: 2.4, shadows: true,
    ao: true, aoSamples: 10, aoDenoiseSamples: 8, aoScale: 0.7,
    bloom: true, smaa: true, pixelRatioCap: 1.5, anisotropy: 4, skyDetail: 1,
  },
  {
    name: 'low',
    shadowMapSize: 1536, shadowRadius: 1.8, shadows: true,
    ao: false, aoSamples: 8, aoDenoiseSamples: 4, aoScale: 0.5,
    bloom: true, smaa: false, pixelRatioCap: 1, anisotropy: 2, skyDetail: 0,
  },
  {
    name: 'potato',
    shadowMapSize: 1024, shadowRadius: 1.4, shadows: false,
    ao: false, aoSamples: 8, aoDenoiseSamples: 4, aoScale: 0.5,
    bloom: false, smaa: false, pixelRatioCap: 1, anisotropy: 1, skyDetail: 0,
  },
];

export const QUALITY = {
  /* --- shadows --- */
  shadows: true,
  shadowMapSize: 3072,
  /** PCF blur kernel, in shadow-map texels. */
  shadowRadius: 3.0,
  /**
   * How much of the view depth receives shadows, in metres. The ortho box is
   * fitted to the camera frustum clipped at this distance, so a small number
   * buys sharp contact shadows at the cost of unshadowed far geometry.
   */
  shadowDistance: 640,
  /** Multiplier on the auto-derived normalBias. Raise if acne appears. */
  shadowBiasScale: 1.0,

  /* --- ambient occlusion (GTAO) --- */
  ao: true,
  aoSamples: 16,
  aoDenoiseSamples: 16,
  /** Render the AO buffer at this fraction of the display resolution. */
  aoScale: 1.0,

  /* --- post --- */
  bloom: true,
  smaa: true,
  skyDetail: 2,

  /* --- sampling --- */
  pixelRatioCap: 2,
  anisotropy: 8,

  /* --- adaptive fallback --- */
  adaptive: true,
  /** Drop a tier when the smoothed frame time stays above this (ms). */
  targetFrameMs: 19.0,

  /** Legacy alias — some older code asked for `ssao`. Kept in sync with `ao`. */
  ssao: true,
};

/** Copy a tier's values into the live QUALITY object. */
export function applyQualityTier(index) {
  const t = QUALITY_TIERS[Math.max(0, Math.min(QUALITY_TIERS.length - 1, index))];
  for (const k of Object.keys(t)) if (k !== 'name') QUALITY[k] = t[k];
  QUALITY.ssao = QUALITY.ao;
  return t;
}

/* --------------------------------------------------------------- lighting --- */

export const LIGHTING = {
  /**
   * Sun placement. Azimuth is degrees from +Z toward +X; the camera sits at
   * yaw -35 so this puts the sun just behind and to the right of the viewer.
   * That lights the +Z faces hard, leaves the -X faces on fill, and throws the
   * shadows up-screen where a 54-degree camera can actually see them.
   */
  SUN_AZIMUTH: -14,
  /**
   * High enough that horizontal and vertical faces separate in value (top 0.83
   * vs sunny wall 0.54 vs shaded wall 0.14 of the key) — at 47 deg a boxy prop
   * lit from the side reads almost flat. A 3.4 m storey still throws a 2.3 m
   * shadow, which is what sells the ground plane.
   */
  SUN_ELEVATION: 56,

  SUN_COLOR: 0xfff2da,
  SUN_INTENSITY: 3.55,

  /** Hemisphere: cool sky above, warm pavement bounce below. */
  HEMI_SKY: 0xc6dcf0,
  HEMI_GROUND: 0xc79a6a,
  HEMI_INTENSITY: 0.60,

  /** Cool sky fill opposite the key, so shadowed faces keep some form. */
  FILL_COLOR: 0x9fc8ee,
  FILL_INTENSITY: 0.30,
  FILL_AZIMUTH: 166,
  FILL_ELEVATION: 30,

  /** Warm bounce coming back up off the pavement onto shadowed walls. */
  BOUNCE_COLOR: 0xffc98e,
  BOUNCE_INTENSITY: 0.30,
  BOUNCE_AZIMUTH: 152,
  BOUNCE_ELEVATION: -22,

  /** Warm ambient floor. Keeps shadow interiors from going cyan. */
  AMBIENT_COLOR: 0xffdcb4,
  AMBIENT_INTENSITY: 0.14,

  /** Diffuse+specular strength of the procedural sky IBL from materials.js. */
  ENV_INTENSITY: 0.45,

  /* --- sky dome --- */
  SKY_ZENITH: 0x1f78c8,
  SKY_MID: 0x5cb2e8,
  SKY_HAZE: 0xfff0dc,
  /** Everything below the horizon line — the dome's "sea haze" skirt. */
  SKY_FLOOR: 0xd8e6e4,
  /**
   * Radiance multiplier for the dome. Tuned against GRADE.exposure so the
   * horizon haze lands just under clipping and the zenith around 0.5.
   */
  SKY_GAIN: 0.80,
  CLOUD_LIT: 0xfffdf7,
  CLOUD_SHADE: 0x9db4d2,
  CLOUD_COVER: 0.74,
  CLOUD_DRIFT: 0.010,

  /* --- atmosphere --- */
  FOG_NEAR: 620,
  FOG_FAR: 2600,
};

/* ------------------------------------------------------------------ grade --- */

export const GRADE = {
  /** Scene exposure, applied in linear before the tone curve. */
  exposure: 1.02,
  /**
   * Filmic shoulder. Below `toneStart` the curve is linear (so albedo lands
   * where the art bible says it should); above it, highlights roll off instead
   * of clipping. A low start is what lets exposure sit high enough for a
   * high-key look while keeping bone-white sidewalk under ~0.85 — anti-pattern
   * #2 in docs/ART_DIRECTION.md.
   */
  toneStart: 0.45,
  /** Highlight desaturation in the shoulder. Kept low: Miami stays saturated. */
  toneDesat: 0.12,
  /** Power contrast pivoted on 18% grey, applied in linear (HDR-safe). */
  contrast: 1.07,
  /** Saturation, applied after the tone curve. */
  saturation: 1.12,
  /** Global warm push. +R, -B, in linear. Miami late afternoon. */
  temperature: 0.030,
  /** Additive cool in the darks (split-tone low end). */
  shadowTint: [-0.006, 0.001, 0.020],
  /** Multiplicative warm in the highs (split-tone high end). */
  highlightTint: [0.045, 0.012, -0.030],
  /**
   * Secondary correction: pulls *low-chroma blue-dominant midtones* back to
   * neutral. It exists because the shared asphalt albedo is blue-grey
   * (#5c6470), which no believable daylight illuminant can neutralise. It
   * self-disables on any pixel whose blue is not the dominant channel, so it
   * costs nothing once that texture is warmed at source — drop it to 0 then.
   */
  neutralise: 0.45,
  vignette: 0.24,
  aberration: 0.0009,
  /** Ordered-noise dither, in output code values, to kill sky banding. */
  dither: 1.0,

  /* --- bloom: a highlight kiss, not a glow filter --- */
  bloomStrength: 0.26,
  bloomRadius: 0.52,
  /** Linear-HDR threshold. Only genuinely over-bright pixels bloom. */
  bloomThreshold: 1.30,

  /** GTAO blend strength. Grounding, not halos. */
  aoIntensity: 1.0,
  /**
   * Sample radius. SCREEN-SPACE, not world-space: the camera distance swings
   * 10x between a 1.6 m hole and a swallowed city block, and a fixed metric
   * radius that grounds a traffic cone is invisible from 400 m up. 1.0 here is
   * 100 px at the current width, so this is ~24 px.
   */
  aoScreenSpace: true,
  aoRadius: 0.24,
  aoDistanceExponent: 1.2,
  /**
   * Occluder acceptance depth, in metres of view-space Z. GTAOShader compares
   * against the *raw* uniform (it computes a screen-scaled `distanceFalloffToUse`
   * and then never uses it), so this has to be driven from the camera distance
   * by hand or the AO silently vanishes as you zoom out: at 120 m a 1 m
   * threshold rejects every real occluder in the scene.
   */
  aoThicknessPerDist: 0.075,
  aoThicknessMin: 1.2,
  aoThicknessMax: 40,
  /** Power curve on the occlusion term. >1 deepens creases. */
  aoScalePower: 1.9,
};

/* ----------------------------------------------------------------- camera --- */

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
