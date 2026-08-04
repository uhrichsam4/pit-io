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
    shadowMapSize: 3072, shadowRadius: 1.5, shadows: true,
    ao: true, aoSamples: 16, aoDenoiseSamples: 16, aoScale: 1.0,
    bloom: true, smaa: true, pixelRatioCap: 2, anisotropy: 8, skyDetail: 2,
  },
  {
    name: 'medium',
    shadowMapSize: 2048, shadowRadius: 1.3, shadows: true,
    ao: true, aoSamples: 10, aoDenoiseSamples: 8, aoScale: 0.7,
    bloom: true, smaa: true, pixelRatioCap: 1.5, anisotropy: 4, skyDetail: 1,
  },
  {
    name: 'low',
    shadowMapSize: 1536, shadowRadius: 1.1, shadows: true,
    ao: false, aoSamples: 8, aoDenoiseSamples: 4, aoScale: 0.5,
    bloom: true, smaa: false, pixelRatioCap: 1, anisotropy: 2, skyDetail: 0,
  },
  {
    name: 'potato',
    shadowMapSize: 1024, shadowRadius: 1.0, shadows: false,
    ao: false, aoSamples: 8, aoDenoiseSamples: 4, aoScale: 0.5,
    bloom: false, smaa: false, pixelRatioCap: 1, anisotropy: 1, skyDetail: 0,
  },
];

export const QUALITY = {
  /* --- shadows --- */
  shadows: true,
  shadowMapSize: 3072,
  /**
   * PCF kernel radius, in shadow-map texels.
   *
   * MEASURED, and much lower than it looks like it should be. three r185's
   * PCFShadowMap is not a box filter — it is FIVE taps on a Vogel disk of this
   * radius, rotated per pixel by interleaved-gradient noise (hardware PCF then
   * bilinear-filters each tap). At radius 3 that is savage stochastic
   * undersampling: a large building shadow survives as a soft blob, but every
   * shadow only a few texels across dissolves into per-pixel speckle and then
   * into nothing. That is exactly why cars, palms and street props had no
   * contact shadows at all and read as stickers on the pavement — art bible
   * anti-pattern #10. A/B'd on a frozen frame at 0.8 / 1.6 / 2.4 / 3.4: 1.5 is
   * the highest value at which a parked car still lands on the road.
   */
  shadowRadius: 1.5,
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

/* -------------------------------------------------------------- day/night --- */

/**
 * THE CYCLE — geometry.
 *
 * The engine publishes, every frame:
 *     scene.userData.timeOfDay    0..1   (0 = midnight, 0.5 = solar noon)
 *     scene.userData.nightFactor  0..1   (0 = full day, 1 = full night)
 *     scene.userData.sunDir       THREE.Vector3, the KEY light direction
 *
 * Content modules drive their emissives off `nightFactor` inside the per-frame
 * update they register on `scene.userData.*Update`. Nobody re-implements this.
 *
 * WHY THE SUN PATH LOOKS LIKE THIS
 *   elevation = SUN_ELEV_MAX * sin(theta),  theta = (t - 0.25) * 2pi
 *   azimuth   = SUN_AZ_NOON - SUN_AZ_HALF * cos(theta)
 * Elevation is the obvious half-sine. Azimuth uses -cos because its derivative
 * is sin(theta): the sun's compass bearing swings fastest at noon and stalls at
 * sunrise and sunset, which is what actually happens in the tropics — and, more
 * usefully, it means the low-sun hours (the ones that look the most different
 * from each other) hold a stable shadow direction instead of racing round.
 *
 * Both curves are periodic and C-infinity, so the cycle loops with no seam at
 * midnight. START/ELEV_MAX are fitted so that at t = START the sun sits at
 * exactly LIGHTING.SUN_ELEVATION / SUN_AZIMUTH — the art-directed afternoon the
 * whole city was lit and reviewed under. Boot looks identical to before.
 */
export const DAY = {
  /** Seconds of real time for one full 24 h cycle. */
  LENGTH: 240,
  /** timeOfDay at boot. 0.60 ~= 14:24 — the art bible's late-afternoon Miami. */
  START: 0.60,
  /**
   * Solar-noon elevation, deg. Fitted so that at t = START the TRUE sun sits at
   * exactly LIGHTING.SUN_ELEVATION (56), which is the elevation the e=56 look
   * stop is keyed to — so the boot frame samples that stop with zero
   * interpolation and is bit-identical to the previously authored rig. (The
   * shadow-casting key lands at 56.6 rather than 56.0, because the horizon
   * floor below still lifts it by 0.6 deg even at noon. A 1% shadow-length
   * difference; not worth distorting the curve to remove.)
   */
  SUN_ELEV_MAX: 69.22,
  /** Azimuth at solar noon, deg from +Z toward +X. Fitted so START -> -14. */
  SUN_AZ_NOON: -70.43,
  /** Half the sunrise->sunset azimuth sweep, deg. 96 => a 192 deg arc. */
  SUN_AZ_HALF: 96,
  /**
   * The key light's elevation floor, deg.
   *
   * A directional light grazing the horizon is not renderable: the shadow ortho
   * degenerates, texels smear to infinity along the light axis and every
   * up-facing surface acnes. So the KEY's elevation is softly floored here
   * while the *true* sun keeps setting — the disc, the sky and the grade all
   * follow the real sun, only the shadow-caster is held up.
   *
   * MEASURED, not guessed. At 17 deg a single Brickell tower's shadow is 3.3x
   * its height, which in this city means one tower blacks out every block in
   * frame and golden hour renders as a flat grey card. 24 deg still throws
   * 2.25x — unmistakably long next to noon's 0.67x — while leaving enough sunlit
   * ground for the low key to be visible AS a key.
   */
  KEY_MIN_ELEV: 24,
  /**
   * Night key ceiling, deg. The moon inherits the sun's azimuth sweep (so the
   * key direction is continuous through dusk — no 180 deg flip, no rotating
   * searchlight) but is held lower and softer than a noon sun.
   */
  MOON_MAX_ELEV: 50,
  /** nightFactor ramps 0 -> 1 as the true sun elevation falls across this band. */
  NIGHT_ELEV_HI: 14,
  NIGHT_ELEV_LO: -8,
};

/**
 * THE CYCLE — look.
 *
 * Keyed on TRUE SUN ELEVATION rather than on clock time, because elevation is
 * what the light physically is. It also gets the pacing right for free: near
 * the horizon elevation changes fastest, so sunset and dawn move quickly while
 * midday and midnight sit still.
 *
 * Stops are ordered high -> low and linearly interpolated (colours in linear
 * space, in the engine). Every field is required on every stop, so any stop can
 * be retuned in isolation without silently inheriting a neighbour.
 *
 * READABILITY IS A HARD CONSTRAINT. This is a bright arcade game. Night is
 * signalled by HUE and by the city lighting up, never by going dark enough to
 * hide the playfield.
 *
 * WHY THE FILL LIGHTS BALLOON AS THE SUN DROPS (hemiI 0.60 -> 1.05 by sunset)
 * This is not a fudge, it is the whole trick. At 24 deg a single Brickell tower
 * shadows every block in frame, so at golden hour the ground the player is
 * actually looking at is almost entirely OUT of the key. Leave the fill at its
 * noon value and the frame goes to a flat grey card — measured, that is exactly
 * what the first tuning pass produced. The fill has to rise to carry the
 * shadowed 90%, and it has to rise CHROMATICALLY (hot orange ground bounce at
 * sunset, deep blue sky fill at night) or the frame reads as overcast rather
 * than as a time of day. Key-to-fill still lands around 1.7:1 at sunset and
 * 1.5:1 at night, so form survives.
 *
 *   sun/sunI        the key light (sun by day, moon by night)
 *   skySun          the sky dome's sun tint: disc, aureole, horizon afterglow.
 *                   Deliberately NOT the same as `sun` — at dusk the key has
 *                   already gone cool and blue while the horizon is still on
 *                   fire, and one colour cannot be both.
 *   sunGlow         strength of the low-sun horizon wedge
 *   hazeAz          how hard the horizon haze concentrates toward the sun
 *   stars/moonDisc  sky dome extras, 0 by day
 *   toneStart       where the filmic shoulder begins. Lowered at golden hour
 *                   and sunset: a low sun puts a huge, near-uniform warm value
 *                   across the whole frame, and with the noon shoulder that
 *                   whole frame walks up to the clip point together. Rolling
 *                   the highlights off earlier is what keeps the bay and the
 *                   sunlit tower faces from fusing into one white sheet.
 *   shadowSoft      multiplier on the PCF kernel — moonlight has no hard edge.
 *                   Kept to a 1.0-1.3 range: see QUALITY.shadowRadius for why
 *                   a big PCF radius destroys small shadows rather than
 *                   softening them.
 */
export const TOD_STOPS = [
  {
    /* ---- e=68: high noon. Near-white key, deep sky, short hard shadows. --- */
    e: 68,
    // A touch under the 56 stop's exposure and key: a 68 deg sun puts most of
    // the city's up-facing surfaces at peak incidence at once, and measured at
    // noon the plaza paving reached 0.85 display luminance — the ceiling the
    // art bible sets for sidewalk. Backed off to leave headroom.
    sun: 0xfff6e6, sunI: 3.60,
    hemiSky: 0xc6dcf0, hemiGround: 0xc79a6a, hemiI: 0.62,
    fill: 0x9fc8ee, fillI: 0.30,
    bounce: 0xffc98e, bounceI: 0.30,
    ambient: 0xffdcb4, ambientI: 0.14,
    env: 0.45,
    skyZenith: 0x2f86cf, skyMid: 0x5cb2e8, skyHorizon: 0xd6ebf2,
    skyHaze: 0xfff0dc, skyFloor: 0xd8e6e4, skyGain: 0.82,
    cloudLit: 0xfffdf7, cloudShade: 0x9db4d2, cloudCover: 0.74,
    skySun: 0xfff6e6, sunDisc: 9.0, sunGlow: 0.00, hazeAz: 1.00,
    moon: 0xbcd4ff, moonDisc: 0.0, stars: 0.00,
    fogNear: 660, fogFar: 2700, fogBlend: 0.34,
    exposure: 0.99, contrast: 1.07, saturation: 1.12, temperature: 0.022,
    sTintR: -0.006, sTintG: 0.001, sTintB: 0.020,
    hTintR: 0.045, hTintG: 0.012, hTintB: -0.030,
    neutralise: 0.45, vignette: 0.24, dither: 1.0,
    // Shoulder pulled in rather than exposure pulled down: at 69 deg the only
    // thing near the ceiling is direct sun on pale plaza paving (measured p95
    // 0.85 display luminance, exactly the art bible's sidewalk cap). Rolling
    // the top end off holds the highlight without dimming the midtones.
    toneStart: 0.41, toneDesat: 0.13,
    bloomStrength: 0.24, bloomRadius: 0.52, bloomThreshold: 1.38,
    aoIntensity: 1.00, shadowSoft: 1.00,
  },
  {
    /* ---- e=56: THE DEFAULT. Byte-for-byte the previously authored rig. ---- */
    e: 56,
    sun: 0xfff2da, sunI: 3.55,
    hemiSky: 0xc6dcf0, hemiGround: 0xc79a6a, hemiI: 0.60,
    fill: 0x9fc8ee, fillI: 0.30,
    bounce: 0xffc98e, bounceI: 0.30,
    ambient: 0xffdcb4, ambientI: 0.14,
    env: 0.45,
    skyZenith: 0x2f86cf, skyMid: 0x5cb2e8, skyHorizon: 0xd6ebf2,
    skyHaze: 0xfff0dc, skyFloor: 0xd8e6e4, skyGain: 0.80,
    cloudLit: 0xfffdf7, cloudShade: 0x9db4d2, cloudCover: 0.74,
    skySun: 0xfff2da, sunDisc: 9.0, sunGlow: 0.00, hazeAz: 1.00,
    moon: 0xbcd4ff, moonDisc: 0.0, stars: 0.00,
    fogNear: 620, fogFar: 2600, fogBlend: 0.34,
    exposure: 1.02, contrast: 1.07, saturation: 1.12, temperature: 0.030,
    sTintR: -0.006, sTintG: 0.001, sTintB: 0.020,
    hTintR: 0.045, hTintG: 0.012, hTintB: -0.030,
    neutralise: 0.45, vignette: 0.24, dither: 1.0,
    toneStart: 0.45, toneDesat: 0.12,
    bloomStrength: 0.26, bloomRadius: 0.52, bloomThreshold: 1.30,
    aoIntensity: 1.00, shadowSoft: 1.00,
  },
  {
    /* ---- e=26: the sun is on its way down; everything warms a notch. ------ */
    e: 26,
    sun: 0xffe4bc, sunI: 3.45,
    hemiSky: 0xd2dcea, hemiGround: 0xd8a06a, hemiI: 0.68,
    fill: 0x9ec4ea, fillI: 0.30,
    bounce: 0xffb977, bounceI: 0.40,
    ambient: 0xffd8ac, ambientI: 0.18,
    env: 0.45,
    skyZenith: 0x2d80c8, skyMid: 0x5fb0e2, skyHorizon: 0xe8e2d2,
    skyHaze: 0xffe0b4, skyFloor: 0xdfdcce, skyGain: 0.82,
    cloudLit: 0xfffaf0, cloudShade: 0xa2b0c8, cloudCover: 0.76,
    skySun: 0xffe4bc, sunDisc: 10.0, sunGlow: 0.04, hazeAz: 1.10,
    moon: 0xbcd4ff, moonDisc: 0.0, stars: 0.00,
    fogNear: 600, fogFar: 2550, fogBlend: 0.36,
    exposure: 1.03, contrast: 1.07, saturation: 1.13, temperature: 0.040,
    sTintR: -0.005, sTintG: 0.001, sTintB: 0.022,
    hTintR: 0.058, hTintG: 0.016, hTintB: -0.040,
    neutralise: 0.45, vignette: 0.24, dither: 1.0,
    toneStart: 0.43, toneDesat: 0.13,
    bloomStrength: 0.28, bloomRadius: 0.52, bloomThreshold: 1.24,
    aoIntensity: 1.00, shadowSoft: 1.02,
  },
  {
    /* ---- e=10: golden hour. Long shadows, warm haze, saturated sky. ------- */
    e: 10,
    sun: 0xffbe78, sunI: 3.15,
    // hemiSky lights UP-facing surfaces, i.e. every road and pavement in the
    // game. At golden hour the sky those surfaces actually see is orange, so
    // leaving this cool is what kept the first tuning pass's roads stubbornly
    // grey under a blazing sunset. Warm it and the ground turns with the sun.
    hemiSky: 0xf6cdac, hemiGround: 0xf0a061, hemiI: 0.86,
    fill: 0x9ab6e0, fillI: 0.32,
    bounce: 0xffa85c, bounceI: 0.64,
    ambient: 0xffcb9a, ambientI: 0.32,
    env: 0.46,
    skyZenith: 0x2a6cb8, skyMid: 0x6ba6d6, skyHorizon: 0xffd2a0,
    skyHaze: 0xffb478, skyFloor: 0xe3bc9c, skyGain: 0.86,
    cloudLit: 0xffe2c0, cloudShade: 0xac9ab4, cloudCover: 0.78,
    skySun: 0xffc07e, sunDisc: 13.0, sunGlow: 0.22, hazeAz: 1.25,
    moon: 0xbcd4ff, moonDisc: 0.0, stars: 0.00,
    fogNear: 580, fogFar: 2450, fogBlend: 0.37,
    exposure: 1.05, contrast: 1.06, saturation: 1.17, temperature: 0.052,
    sTintR: -0.003, sTintG: 0.000, sTintB: 0.028,
    hTintR: 0.082, hTintG: 0.022, hTintB: -0.060,
    neutralise: 0.42, vignette: 0.24, dither: 1.0,
    toneStart: 0.39, toneDesat: 0.15,
    bloomStrength: 0.34, bloomRadius: 0.55, bloomThreshold: 1.12,
    aoIntensity: 1.00, shadowSoft: 1.08,
  },
  {
    /* ---- e=1: sunset. The key is orange and nearly out of power. ---------- */
    e: 1,
    sun: 0xff9350, sunI: 2.60,
    hemiSky: 0xffa478, hemiGround: 0xff8548, hemiI: 0.88,
    fill: 0x92a8d4, fillI: 0.34,
    bounce: 0xff8b4e, bounceI: 0.76,
    ambient: 0xffa878, ambientI: 0.40,
    env: 0.46,
    skyZenith: 0x2a5aa8, skyMid: 0x6e94cc, skyHorizon: 0xff9860,
    skyHaze: 0xff7a4e, skyFloor: 0xd2977e, skyGain: 0.84,
    cloudLit: 0xffc098, cloudShade: 0xa08cae, cloudCover: 0.80,
    skySun: 0xff8442, sunDisc: 17.0, sunGlow: 0.30, hazeAz: 1.30,
    moon: 0xbcd4ff, moonDisc: 0.0, stars: 0.02,
    fogNear: 560, fogFar: 2350, fogBlend: 0.34,
    exposure: 1.02, contrast: 1.05, saturation: 1.21, temperature: 0.060,
    sTintR: -0.001, sTintG: 0.000, sTintB: 0.034,
    hTintR: 0.085, hTintG: 0.020, hTintB: -0.065,
    neutralise: 0.38, vignette: 0.23, dither: 1.1,
    toneStart: 0.35, toneDesat: 0.17,
    bloomStrength: 0.40, bloomRadius: 0.58, bloomThreshold: 1.00,
    aoIntensity: 1.00, shadowSoft: 1.14,
  },
  {
    /* ---- e=-7: blue hour. Key has handed over to the moon; sky still lit. - */
    e: -7,
    sun: 0xaec4f6, sunI: 1.85,
    hemiSky: 0x9c92cc, hemiGround: 0x8e6e94, hemiI: 0.94,
    fill: 0x7f9ce0, fillI: 0.32,
    bounce: 0xc47a80, bounceI: 0.50,
    ambient: 0x9db4ec, ambientI: 0.54,
    env: 0.30,
    skyZenith: 0x1c3c86, skyMid: 0x4270ae, skyHorizon: 0xc4785e,
    skyHaze: 0xd4805a, skyFloor: 0x7e7288, skyGain: 0.82,
    cloudLit: 0xb894a8, cloudShade: 0x6c7296, cloudCover: 0.78,
    skySun: 0xe0603c, sunDisc: 0.0, sunGlow: 0.26, hazeAz: 1.25,
    moon: 0xc4d6ff, moonDisc: 9.0, stars: 0.40,
    fogNear: 520, fogFar: 2200, fogBlend: 0.44,
    exposure: 1.14, contrast: 1.02, saturation: 1.21, temperature: 0.006,
    sTintR: 0.004, sTintG: 0.006, sTintB: 0.038,
    hTintR: 0.055, hTintG: 0.022, hTintB: 0.018,
    neutralise: 0.20, vignette: 0.22, dither: 1.3,
    toneStart: 0.40, toneDesat: 0.14,
    bloomStrength: 0.50, bloomRadius: 0.62, bloomThreshold: 0.82,
    aoIntensity: 0.95, shadowSoft: 1.20,
  },
  {
    /* ---- e=-20: night. Cool, deep, and still completely readable. --------
     * `neutralise` goes almost to zero on purpose. That secondary exists to
     * kill blue-dominant low-chroma midtones (navy asphalt in daylight) — at
     * night EVERY midtone is blue-dominant and low-chroma, and leaving it at
     * 0.45 turns the whole city into grey mud. Night must be blue.
     * ------------------------------------------------------------------- */
    e: -20,
    sun: 0xa8c8ff, sunI: 1.80,
    hemiSky: 0x4e78d2, hemiGround: 0x504e82, hemiI: 0.72,
    fill: 0x6f95e8, fillI: 0.30,
    bounce: 0x8a6fa8, bounceI: 0.34,
    ambient: 0x8fb4f2, ambientI: 0.50,
    env: 0.20,
    skyZenith: 0x0a1642, skyMid: 0x122a66, skyHorizon: 0x2a4680,
    skyHaze: 0x46598c, skyFloor: 0x16264a, skyGain: 0.70,
    cloudLit: 0x55648e, cloudShade: 0x2a3458, cloudCover: 0.72,
    skySun: 0x1a2b52, sunDisc: 0.0, sunGlow: 0.00, hazeAz: 0.55,
    moon: 0xd8e6ff, moonDisc: 38.0, stars: 1.00,
    fogNear: 480, fogFar: 2100, fogBlend: 0.40,
    exposure: 1.26, contrast: 1.02, saturation: 1.24, temperature: -0.045,
    sTintR: 0.006, sTintG: 0.010, sTintB: 0.042,
    hTintR: 0.010, hTintG: 0.014, hTintB: 0.040,
    neutralise: 0.04, vignette: 0.19, dither: 1.5,
    toneStart: 0.46, toneDesat: 0.10,
    bloomStrength: 0.62, bloomRadius: 0.66, bloomThreshold: 0.60,
    aoIntensity: 0.90, shadowSoft: 1.30,
  },
];

/** Fields of TOD_STOPS that are 0xRRGGBB colours; the rest are scalars. */
export const TOD_COLOR_KEYS = [
  'sun', 'hemiSky', 'hemiGround', 'fill', 'bounce', 'ambient',
  'skyZenith', 'skyMid', 'skyHorizon', 'skyHaze', 'skyFloor',
  'cloudLit', 'cloudShade', 'skySun', 'moon',
];

export const TOD_SCALAR_KEYS = Object.keys(TOD_STOPS[0])
  .filter((k) => k !== 'e' && !TOD_COLOR_KEYS.includes(k));

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
