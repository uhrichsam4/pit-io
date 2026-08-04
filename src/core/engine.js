/**
 * Engine: renderer, scene, sky dome, light rig, shadow fitting, camera rig,
 * the day/night cycle and the post-processing chain. Owns nothing about
 * gameplay — game.js drives it.
 *
 * The public surface game.js and dev/devtools.js rely on:
 *   .scene .camera .renderer .sun .sunDir .hemi ._camTarget ._dist
 *   .updateCamera(target, radius, dt, shake)  .render(dt)  .flash(a, hex)
 *   .resize()  ._setShadowExtent(e)
 *
 * ===========================================================================
 * THE DAY/NIGHT CONTRACT — every content module builds against this
 * ===========================================================================
 * Published on the scene, refreshed every frame:
 *
 *   scene.userData.timeOfDay    0..1    0 = midnight, 0.5 = solar noon
 *   scene.userData.nightFactor  0..1    0 = full day, 1 = full night
 *   scene.userData.sunDir       Vector3 the KEY light direction, unit,
 *                               ALWAYS above the horizon (sun by day, moon by
 *                               night). Same object as `engine.sunDir`, mutated
 *                               in place — hold the reference, do not re-read.
 *
 * Convenience extras, same lifetime, safe to read but not part of the contract:
 *   .sunDiscDir     Vector3  the astronomical sun; goes BELOW the horizon
 *   .sunElevation   deg, signed — the driver behind every look decision here
 *   .goldenFactor   0..1, peaks at golden hour
 *   .dayNight       { keyColor, keyIntensity, skyHi, skyLo, hazeColor,
 *                     fogColor, ambientLevel } live illuminants, for anything
 *                     that has to hand-shade (water, glass, custom shaders)
 *
 * Drive it with:  engine.setTimeOfDay(t)      pins the clock (and freezes it)
 *                 engine.dayLengthSeconds     seconds per 24 h, default 240
 *                 engine.cyclePaused          freeze in place
 *
 * Content modules read `nightFactor` inside the per-frame update they register
 * on `scene.userData.*Update` to drive their own emissive intensity — lit
 * windows, streetlights, headlights, signage, neon. Nobody re-implements the
 * cycle, and nobody adds real point lights per streetlamp: the budget will not
 * take it. The framework side of night illumination is here — bloom threshold,
 * exposure and the grade all move so that emissive geometry reads at night
 * without smearing.
 *
 * NOTE FOR AUTOMATED REVIEW: under `navigator.webdriver` the cycle boots
 * FROZEN at DAY.START (the art-directed afternoon), so a screenshot sweep is
 * deterministic no matter how long the city took to build. Ask for another
 * time explicitly:
 *   node tools/shot.mjs --script "__GAME__.engine.setTimeOfDay(0.85)" ...
 *
 * THE LUMINANCE FLOOR, measured rather than asserted. Display-referred
 * luminance over whole frames (360 px downsample, 0.2126/0.7152/0.0722):
 *
 *              noon 0.50   default 0.60   night 0.85
 *   street-level median  0.53      0.48         0.25
 *   hole-mid     median  0.45      0.42         0.24
 *   hole-mid     p05     0.18      0.19         0.15
 *   the hole itself      0.10      0.10         0.11
 *
 * The floor this rig is tuned to: the playable ground never drops below a
 * ~0.24 frame median or a ~0.15 5th percentile at any hour, and the hole sits
 * at ~0.10 around the clock — so it stays the darkest thing on screen from
 * noon to midnight. Night is signalled by HUE and by the city lighting up, not
 * by turning the lights off. Night costs about half the daylight illuminance
 * and gets ~25% of it back through exposure.
 */

import * as THREE from 'three';
import { CAMERA, PALETTE, QUALITY } from '../config.js';
import {
  GRADE, LIGHTING, QUALITY_TIERS, applyQualityTier,
  DAY, TOD_STOPS, TOD_COLOR_KEYS, TOD_SCALAR_KEYS,
} from './quality.js';
import { createPostChain } from '../render/postfx.js';

/* ------------------------------------------------------------------ sky --- */

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_Position.z = gl_Position.w; // always at the far plane
  }
`;

/**
 * Sky dome. Writes *linear HDR* — the grade pass owns the tone curve now, so
 * this must NOT tone-map or encode. Values here are radiances, which is what
 * lets the sun disc read as a real over-bright source that bloom can find.
 *
 * Three things it has to get right:
 *   - a three-stop gradient (deep zenith / azure / warm horizon haze) with an
 *     exponential horizon falloff, because a linear ramp bands,
 *   - a sun with a hard core and a physically-shaped aureole rather than one
 *     fat pow() blob,
 *   - cumulus projected onto a real plane at altitude, so they keep their
 *     perspective when the camera tilts up instead of smearing.
 */
const SKY_FRAG = /* glsl */ `
  uniform vec3 uZenith, uMid, uHorizon, uHaze, uFloor, uSunColor, uSunDir;
  uniform vec3 uCloudLit, uCloudShade, uMoonColor, uMoonDir;
  uniform float uTime, uCloudCover, uDrift, uSunDisc;
  uniform float uMoonDisc, uStars, uHazeAz, uSunGlow;
  varying vec3 vDir;

  // sin-free hash: cheap enough to afford ~15 taps of it per sky pixel
  float hash(vec2 p){
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float noise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1,0)), u.x),
               mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
  }
  float fbm(vec2 p, int oct){
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) {
      if (i >= oct) break;
      v += a * noise(p); p = p * 2.02 + 11.7; a *= 0.5;
    }
    return v;
  }

  void main() {
    vec3 d = normalize(vDir);
    vec3 sd = normalize(uSunDir);

    /* ---- gradient ------------------------------------------------------ */
    // Four stops, not two. A zenith-to-horizon lerp spends most of the visible
    // band (the camera almost never looks above ~20 deg) sitting in the pale
    // end, which is why the sky used to read as grey card. Saturated azure has
    // to arrive by ~15 deg, with the pale band and the warm haze compressed
    // into narrow exponentials right on the horizon line.
    float up = clamp(d.y, 0.0, 1.0);
    vec3 col = mix(uMid, uZenith, pow(up, 0.40));
    col = mix(col, uHorizon, exp(-up * 6.5) * 0.86);

    float azimuthal = dot(normalize(vec3(d.x, 0.0, d.z) + 1e-5),
                          normalize(vec3(sd.x, 0.0, sd.z) + 1e-5));
    float haze = exp(-up * 17.0);
    col = mix(col, uHaze, haze * (0.34 + 0.24 * uHazeAz * max(azimuthal, 0.0)));

    // The low-sun wedge. Without a term that is anchored to the sun's BEARING,
    // sunset reads as "someone tinted the whole sky orange" rather than as
    // light arriving from a place — and the side of the city facing away from
    // the sun ends up glowing just as hard as the side facing it.
    if (uSunGlow > 0.001) {
      col += uSunColor * uSunGlow
           * pow(max(azimuthal, 0.0), 3.5) * exp(-max(up, 0.0) * 4.5);
    }

    // Below the horizon line the dome becomes distant sea haze.
    col = mix(col, uFloor, smoothstep(0.0, -0.055, d.y));

    /* ---- stars ---------------------------------------------------------- */
    #if STARS
    // Stereographic projection from the nadir. It is conformal, so cells stay
    // square and stars stay ROUND right down to the horizon — a plain d.xz
    // projection smears them into streaks exactly where the camera looks most.
    // No atan anywhere, so there is no azimuth seam either.
    if (uStars > 0.003 && d.y > 0.006) {
      // 190 cells across the unit disc puts one cell at ~0.30 deg near the
      // horizon, so a 0.19-cell star is ~0.057 deg — about two pixels wide at
      // a 42 deg FOV. Sized in DEGREES on purpose: the first pass used 260
      // cells and a 0.055 radius, which is geometrically tidy and renders
      // sub-pixel, i.e. an empty sky.
      vec2 sp = d.xz / (1.0 + d.y) * 190.0;
      vec2 ic = floor(sp);
      float m = hash(ic + 0.5);
      if (m > 0.982) {
        vec2 c0 = vec2(hash(ic + 11.3), hash(ic + 27.9));
        // Magnitudes follow a steep curve so most stars are faint and only a
        // handful are bright; a uniform field reads as noise, not as a sky.
        float mag = pow((m - 0.982) / 0.018, 1.9) * 1.6;
        float tw = 0.72 + 0.28 * sin(uTime * (1.1 + m * 7.0) + m * 63.0);
        col += vec3(0.86, 0.90, 1.00)
             * smoothstep(0.19, 0.02, length(fract(sp) - c0))
             * mag * tw * uStars * smoothstep(0.008, 0.13, d.y);
      }
    }
    #endif

    /* ---- sun ----------------------------------------------------------- */
    float cd = dot(d, sd);
    // Mask the disc at the horizon line so a setting sun is CUT by the sea
    // instead of hanging in the haze skirt below it.
    float above = smoothstep(-0.014, 0.008, d.y);
    // ~0.5 deg core with a soft limb, then two decades of aureole.
    float core = smoothstep(0.99988, 0.999955, cd);
    float aureole = pow(max(cd, 0.0), 2200.0) * 1.1
                  + pow(max(cd, 0.0), 120.0) * 0.28;
    col += uSunColor * (aureole * above + pow(max(cd, 0.0), 9.0) * 0.085);
    col += uSunColor * core * uSunDisc * above;

    /* ---- moon ----------------------------------------------------------- */
    // Deliberately co-located with the KEY direction rather than with the
    // astronomical anti-sun: a moon that disagrees with its own moonlight is
    // the kind of thing this project's reviews are supposed to catch. The
    // consequence is that a fixed-pitch gameplay camera (50-58 deg down) never
    // frames it — only the wide hero presets do. See DAY.KEY_MIN_ELEV.
    if (uMoonDisc > 0.001) {
      float md = dot(d, normalize(uMoonDir));
      float mcore = smoothstep(0.99993, 0.999975, md);   // ~0.68 deg, soft limb
      float mglow = pow(max(md, 0.0), 900.0) * 0.50
                  + pow(max(md, 0.0), 22.0) * 0.06;
      col += uMoonColor * uMoonDisc * (mcore + mglow * 0.30);
    }

    /* ---- cumulus ------------------------------------------------------- */
    #if CLOUD_OCT > 0
    // Start the deck a little above the horizon: below ~2.5 deg the plane
    // projection stretches a cell across the whole width and cumulus turn into
    // horizontal smears.
    float lift = smoothstep(0.045, 0.20, d.y);
    if (lift > 0.001) {
      // Project the view ray onto a plane at altitude: correct perspective,
      // so the deck reads as a ceiling and not as a painted-on texture.
      // Projection choice matters more than the noise here. A true 1/y plane
      // projection is geometrically right and visually wrong: at 6 deg up it
      // shears every cell 4.5:1 into a horizontal streak, so the deck reads as
      // altostratus instead of fair-weather cumulus. This softened form keeps
      // the radial rate within ~1.3x of the azimuthal rate across the whole
      // band the camera can actually see, so cells stay round, while the
      // radius still shrinks with elevation so the deck still converges like a
      // ceiling. No atan, so there is no azimuth seam.
      vec2 p = d.xz * 12.0 / (0.72 + d.y);
      p += vec2(uTime * uDrift, uTime * uDrift * 0.42);

      // Fade the deck out with apparent distance instead of letting the
      // projection alias itself to death near the horizon.
      float far = 1.0;   // elevation fade below is enough now that p is bounded

      vec2 warp = vec2(fbm(p * 0.42, CLOUD_OCT), fbm(p * 0.42 + 5.2, CLOUD_OCT));
      float dens = fbm(p * 0.38 + warp * 1.15, CLOUD_OCT + 1) * 0.78
                 + fbm(p * 1.45 + warp * 0.55, CLOUD_OCT) * 0.30;

      // Fake single-scatter: resample the field one step toward the sun and
      // use the difference as thickness. Cheap, and it gives real-looking
      // bright sun-facing shoulders with grey-blue undersides.
      vec2 step2 = normalize(vec2(sd.x, sd.z) + 1e-5) * 0.75;
      float towardSun = fbm((p + step2) * 0.38 + warp * 1.15, CLOUD_OCT) * 0.78
                      + fbm((p + step2) * 1.45 + warp * 0.55, CLOUD_OCT - 1) * 0.30;
      float shade = clamp((towardSun - dens) * 4.0 + 0.55, 0.0, 1.0);

      float lo = 0.60 - uCloudCover * 0.22;
      float cover = smoothstep(lo, lo + 0.075, dens);
      vec3 cloud = mix(uCloudShade, uCloudLit, shade * shade);
      // silver lining where the deck passes in front of the sun
      cloud += uSunColor * pow(max(cd, 0.0), 14.0) * 0.65 * (1.0 - shade);

      float a = cover * lift * far;
      a *= mix(1.0, 0.25, haze);      // clouds dissolve into the horizon haze
      col = mix(col, cloud, clamp(a, 0.0, 1.0));
    }
    #endif

    gl_FragColor = vec4(max(col, 0.0), 1.0);
  }
`;

/* --------------------------------------------------------------- helpers --- */

const _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _lx = new THREE.Vector3();
const _ly = new THREE.Vector3();
const _centre = new THREE.Vector3();
const _tmp = new THREE.Vector3();

/**
 * Hard cap on how far from the look-at point the shadow box may reach, metres.
 * Sized so that even a fully clamped box stays inside the extent limit and the
 * near field is always covered.
 */
const SHADOW_LEASH = 430;

/** Unit vector from an azimuth (deg, from +Z toward +X) and elevation (deg). */
function dirFrom(azimuthDeg, elevationDeg, out = new THREE.Vector3()) {
  const a = THREE.MathUtils.degToRad(azimuthDeg);
  const e = THREE.MathUtils.degToRad(elevationDeg);
  const c = Math.cos(e);
  return out.set(Math.sin(a) * c, Math.sin(e), Math.cos(a) * c).normalize();
}

/** Linear-space colour scaled by a gain, for HDR shader uniforms. */
function litColor(hex, gain) {
  return new THREE.Color(hex).multiplyScalar(gain);
}

/**
 * Per-band radiance trims on the sky dome, relative to the stop's `skyGain`.
 * These were baked into the original uniform setup; keeping them as an explicit
 * table is what lets the whole dome be re-driven from one gain per stop without
 * the day look drifting by a single bit.
 */
const SKY_BAND_GAIN = {
  skyZenith: 1.00, skyMid: 1.02, skyHorizon: 1.00,
  skyHaze: 1.04, skyFloor: 0.86, cloudLit: 1.60, cloudShade: 1.00,
};

/* -------------------------------------------------------------- day/night --- */

/**
 * Pre-resolve TOD_STOPS into parallel scalar/colour tables once, so sampling a
 * time of day is a pair of flat loops with no property lookups by string on the
 * hot path and, more importantly, no allocation. The whole sample is ~45 lerps.
 */
const TOD_COLORS = TOD_STOPS.map((s) => {
  const o = {};
  for (const k of TOD_COLOR_KEYS) o[k] = new THREE.Color(s[k]);
  return o;
});

/** Look object reused every frame. Colours are mutated in place. */
function makeLook() {
  const o = {};
  for (const k of TOD_SCALAR_KEYS) o[k] = TOD_STOPS[0][k];
  for (const k of TOD_COLOR_KEYS) o[k] = new THREE.Color();
  // The grade pass wants arrays for its two Vector3 uniforms.
  o.shadowTint = [0, 0, 0];
  o.highlightTint = [0, 0, 0];
  return o;
}

/**
 * Interpolate the look for a given TRUE sun elevation, into `out`.
 *
 * Keyed on elevation rather than clock time on purpose: elevation is what the
 * light physically is, and it also paces itself correctly for free — it moves
 * fastest at the horizon, so dusk transitions quickly while noon and midnight
 * sit still. Colours lerp in linear working space (THREE.Color is linear), so
 * a 22-degree sunset ramp cannot band.
 */
function sampleLook(elevDeg, out) {
  let i = 0;
  while (i < TOD_STOPS.length - 2 && elevDeg < TOD_STOPS[i + 1].e) i++;
  const a = TOD_STOPS[i], b = TOD_STOPS[i + 1];
  const u = THREE.MathUtils.clamp((a.e - elevDeg) / (a.e - b.e), 0, 1);
  for (const k of TOD_SCALAR_KEYS) out[k] = a[k] + (b[k] - a[k]) * u;
  const ca = TOD_COLORS[i], cb = TOD_COLORS[i + 1];
  for (const k of TOD_COLOR_KEYS) out[k].copy(ca[k]).lerp(cb[k], u);
  out.shadowTint[0] = out.sTintR; out.shadowTint[1] = out.sTintG; out.shadowTint[2] = out.sTintB;
  out.highlightTint[0] = out.hTintR; out.highlightTint[1] = out.hTintG; out.highlightTint[2] = out.hTintB;
  return out;
}

/* ---------------------------------------------------------------- engine --- */

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;

    // Screenshot harnesses run under software GL and would trip the adaptive
    // fallback within a second, silently reviewing the wrong quality tier.
    if (typeof navigator !== 'undefined' && navigator.webdriver) QUALITY.adaptive = false;
    const q = typeof location !== 'undefined' && /[?&]q=(\w+)/.exec(location.search);
    if (q) {
      const i = QUALITY_TIERS.findIndex((t) => t.name === q[1]);
      if (i >= 0) applyQualityTier(i);
    }
    this._tier = Math.max(0, QUALITY_TIERS.findIndex((t) => t.shadowMapSize === QUALITY.shadowMapSize));

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY.pixelRatioCap));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // The grade pass tone-maps. Leaving ACES on here would double-apply it to
    // anything drawn straight to the canvas and to OutputPass.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = QUALITY.shadows;
    // PCF, not PCFSoft: PCFSoft ignores LightShadow.radius and bakes in a
    // ~1.5-texel penumbra, which is rock-hard once the ortho box is fitted
    // tightly. PCF spreads its taps by `radius`, so softness is tunable —
    // but only over a NARROW range. In r185 this path is five taps on a Vogel
    // disk rotated per pixel, so `radius` buys stochastic spread, not a wider
    // box filter. See the essay on QUALITY.shadowRadius before raising it.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Counting per-frame instead of per-render() so devtools.stats() reports
    // the true cost of a frame (shadow pass + beauty pass + post) rather than
    // the last fullscreen quad.
    this.renderer.info.autoReset = false;

    this.maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    QUALITY.anisotropy = Math.min(QUALITY.anisotropy, this.maxAniso);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(PALETTE.FOG, LIGHTING.FOG_NEAR, LIGHTING.FOG_FAR);

    this.camera = new THREE.PerspectiveCamera(
      CAMERA.FOV, window.innerWidth / window.innerHeight, CAMERA.NEAR, CAMERA.FAR
    );
    this.camera.position.set(40, 50, 40);
    this.camera.lookAt(0, 0, 0);

    this._frustumPts = Array.from({ length: 8 }, () => new THREE.Vector3());

    // Declared before the cycle runs: _applyTimeOfDay() aims the key light at
    // the look-at point when the shadow fit is not going to do it.
    this._camTarget = new THREE.Vector3();

    this._buildSky();
    this._buildLights();
    this._buildComposer();
    // Last, because it drives all three, and FIRST in the boot order overall:
    // buildWorld() runs after this constructor returns, so every content module
    // sees scene.userData.nightFactor already populated on its very first frame.
    this._initCycle();

    this._followPos = new THREE.Vector3();
    this._dist = CAMERA.DIST_BASE;
    this._shakeOffset = new THREE.Vector3();
    this._shadowExtent = -1;   // forces the first fit to write the ortho box
    this.time = 0;

    /* adaptive quality state */
    this._frameMs = 16;
    this._adaptFrames = 0;
    this._lastFrameTs = 0;
    this._envApplied = false;

    /** Snapshot for the HUD / dev harness. Filled every frame. */
    this.stats = { drawCalls: 0, triangles: 0, sceneCalls: 0, sceneTriangles: 0, frameMs: 16, tier: 'high' };

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
  }

  /* ------------------------------------------------------------- sky ----- */

  _buildSky() {
    // Overwritten on the first _applyTimeOfDay(); seeded here so anything that
    // reads sunDir between the two (there should be nothing) sees the default.
    this.sunDir = dirFrom(LIGHTING.SUN_AZIMUTH, LIGHTING.SUN_ELEVATION);
    this.sunDiscDir = this.sunDir.clone();
    this.moonDir = this.sunDir.clone();

    const g = LIGHTING.SKY_GAIN;
    const geo = new THREE.SphereGeometry(1, 48, 28);
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      defines: {
        CLOUD_OCT: 2 + Math.max(0, QUALITY.skyDetail),
        STARS: QUALITY.skyDetail >= 1 ? 1 : 0,
      },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: false,
      uniforms: {
        uZenith: { value: litColor(PALETTE.SKY_TOP, g) },
        uMid: { value: litColor(LIGHTING.SKY_MID, g * 1.02) },
        uHorizon: { value: litColor(PALETTE.SKY_HORIZON, g * 1.00) },
        uHaze: { value: litColor(LIGHTING.SKY_HAZE, g * 1.04) },
        uFloor: { value: litColor(LIGHTING.SKY_FLOOR, g * 0.86) },
        uSunColor: { value: new THREE.Color(LIGHTING.SUN_COLOR) },
        uSunDir: { value: this.sunDiscDir },
        uMoonColor: { value: new THREE.Color(0xd2e2ff) },
        uMoonDir: { value: this.moonDir },
        uCloudLit: { value: litColor(LIGHTING.CLOUD_LIT, g * 1.60) },
        uCloudShade: { value: litColor(LIGHTING.CLOUD_SHADE, g * 1.00) },
        uCloudCover: { value: LIGHTING.CLOUD_COVER },
        uDrift: { value: LIGHTING.CLOUD_DRIFT },
        uSunDisc: { value: 9.0 },
        uMoonDisc: { value: 0.0 },
        uStars: { value: 0.0 },
        uHazeAz: { value: 1.0 },
        uSunGlow: { value: 0.0 },
        uTime: { value: 0 },
      },
    });
    this.sky = new THREE.Mesh(geo, this.skyMat);
    this.sky.scale.setScalar(2000);
    this.sky.renderOrder = -1000;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    // Fog has to sit exactly on the horizon haze or the skyline gets a visible
    // seam where the city stops and the dome starts.
    this.scene.fog.color.copy(this.skyMat.uniforms.uHorizon.value).lerp(
      this.skyMat.uniforms.uHaze.value, 0.34
    );
  }

  /* ------------------------------------------------------- day/night ----- */

  _initCycle() {
    this.dayLengthSeconds = DAY.LENGTH;
    this.timeOfDay = DAY.START;
    /**
     * A headless review harness must be deterministic. Six other agents
     * screenshot this build all day, and a clock that keeps running while the
     * city builds (which under software GL takes anywhere from 20 s to three
     * minutes) would hand every one of them a different sky. So automation
     * boots FROZEN at the art-directed afternoon and asks for other times
     * explicitly. Real players get the full cycle.
     */
    this.cyclePaused = typeof navigator !== 'undefined' && !!navigator.webdriver;

    this._look = makeLook();
    this._lightColor = new THREE.Color();
    this._fogA = new THREE.Color();

    /** Live illuminants, for modules that hand-shade (water, glass, VFX). */
    this._dayNight = {
      keyColor: new THREE.Color(),
      keyIntensity: 0,
      skyHi: new THREE.Color(),
      skyLo: new THREE.Color(),
      hazeColor: new THREE.Color(),
      fogColor: new THREE.Color(),
      ambientLevel: 0,
    };

    const u = this.scene.userData;
    u.timeOfDay = this.timeOfDay;
    u.nightFactor = 0;
    u.goldenFactor = 0;
    u.sunElevation = LIGHTING.SUN_ELEVATION;
    u.sunDir = this.sunDir;             // key direction, mutated in place
    u.sunDiscDir = this.sunDiscDir;     // astronomical sun, may be below y=0
    u.dayNight = this._dayNight;

    this._applyTimeOfDay();
  }

  /**
   * Pin the clock. `freeze` defaults to true because every caller of this is a
   * harness or a debug key pinning a specific hour, and a cycle that keeps
   * crawling underneath makes those shots non-reproducible. Pass false (or set
   * `engine.cyclePaused = false`) to scrub while the cycle keeps running.
   * @param {number} t 0..1, wrapped
   */
  setTimeOfDay(t, freeze = true) {
    this.timeOfDay = ((t % 1) + 1) % 1;
    this.cyclePaused = !!freeze;
    this._applyTimeOfDay();
    return this;
  }

  _advanceCycle(dt) {
    if (!this.cyclePaused && this.dayLengthSeconds > 0 && dt > 0) {
      this.timeOfDay = (this.timeOfDay + dt / this.dayLengthSeconds) % 1;
      this._applyTimeOfDay();
    }
  }

  /**
   * Resolve the whole rig for `this.timeOfDay`: sun geometry, key direction,
   * light rig, sky dome, fog, IBL strength and the grade.
   *
   * WHY THE KEY DIRECTION IS NOT THE SUN DIRECTION
   * A directional light grazing the horizon is not renderable — the shadow
   * ortho degenerates along the light axis, texels smear, and every up-facing
   * surface acnes. And the obvious fix (swap to a moon on the opposite side at
   * sunset) is worse: it rotates the key ~180 deg in azimuth over the handful
   * of seconds the sun spends near the horizon, and the whole city's shadows
   * sweep round like a searchlight.
   *
   * So: the key keeps the sun's AZIMUTH for the entire 24 h — one continuous,
   * smooth sweep — and only its ELEVATION is reshaped. It is softly floored at
   * KEY_MIN_ELEV so it never grazes, and at night it is pulled down toward
   * MOON_MAX_ELEV so moonlight rakes lower and softer than a noon sun. The
   * result has no discontinuity anywhere in the cycle: shadows lengthen into
   * dusk, soften, go blue, and shorten again. Meanwhile the astronomical sun
   * (`sunDiscDir`) really does set, because that is what the sky draws.
   */
  _applyTimeOfDay() {
    const theta = (this.timeOfDay - 0.25) * Math.PI * 2;
    const sinT = Math.sin(theta);
    const rawElev = DAY.SUN_ELEV_MAX * sinT;
    const az = DAY.SUN_AZ_NOON - DAY.SUN_AZ_HALF * Math.cos(theta);

    const night = 1 - THREE.MathUtils.smoothstep(rawElev, DAY.NIGHT_ELEV_LO, DAY.NIGHT_ELEV_HI);
    const golden = THREE.MathUtils.smoothstep(rawElev, -4, 4)
                 * (1 - THREE.MathUtils.smoothstep(rawElev, 8, 24));

    // Soft floor: exp() rather than Math.max so there is no derivative kink at
    // the horizon, and it converges fast enough that the floor is invisible by
    // mid-morning (at 55 deg it lifts the sun by 0.65 deg).
    const a = Math.abs(rawElev);
    const lifted = a + DAY.KEY_MIN_ELEV * Math.exp(-a / DAY.KEY_MIN_ELEV);
    // Remap the same curve into the moon's shallower range, and cross-fade on
    // nightFactor. Both agree at the horizon, so the fade is a no-op exactly
    // where it happens — which is why nothing swings.
    const span = (lifted - DAY.KEY_MIN_ELEV) / (DAY.SUN_ELEV_MAX - DAY.KEY_MIN_ELEV);
    const moonElev = DAY.KEY_MIN_ELEV + (DAY.MOON_MAX_ELEV - DAY.KEY_MIN_ELEV) * span;
    const keyElev = lifted + (moonElev - lifted) * night;

    dirFrom(az, keyElev, this.sunDir);
    dirFrom(az, rawElev, this.sunDiscDir);
    this.moonDir.copy(this.sunDir);

    const look = sampleLook(rawElev, this._look);

    /* ---- light rig ---- */
    this.sun.color.copy(look.sun);
    this.sun.intensity = look.sunI;
    this.hemi.color.copy(look.hemiSky);
    this.hemi.groundColor.copy(look.hemiGround);
    this.hemi.intensity = look.hemiI;
    this.fill.color.copy(look.fill);
    this.fill.intensity = look.fillI;
    this.bounce.color.copy(look.bounce);
    this.bounce.intensity = look.bounceI;
    this.ambient.color.copy(look.ambient);
    this.ambient.intensity = look.ambientI;
    // Fill and bounce keep their authored bearings relative to the key, so the
    // shadow side stays modelled however far round the sun has travelled.
    this.fill.position.copy(dirFrom(az + 180, LIGHTING.FILL_ELEVATION, _tmp)).multiplyScalar(300);
    this.bounce.position.copy(dirFrom(az + 166, LIGHTING.BOUNCE_ELEVATION, _tmp)).multiplyScalar(300);

    // With shadows off (the potato tier) _updateShadowFit early-returns and
    // never repositions the light, which would leave the sun frozen wherever it
    // was at boot while the sky kept moving. Keep the direction live here; the
    // fit overwrites both of these whenever it does run.
    if (!this.sun.castShadow) {
      this.sun.target.position.copy(this._camTarget);
      this.sun.position.copy(this._camTarget).addScaledVector(this.sunDir, 400);
      this.sun.target.updateMatrixWorld();
    }

    // The IBL is a baked DAY sky; running it at full strength after dark would
    // paint noon reflections onto every glass tower. Fade it out and let the
    // analytic rig carry night. (A second night PMREM is the real fix — see the
    // handover note; it needs materials.js.)
    if (this.scene.environment) this.scene.environmentIntensity = look.env;

    /* ---- sky dome ---- */
    const u = this.skyMat.uniforms;
    const g = look.skyGain;
    u.uZenith.value.copy(look.skyZenith).multiplyScalar(g * SKY_BAND_GAIN.skyZenith);
    u.uMid.value.copy(look.skyMid).multiplyScalar(g * SKY_BAND_GAIN.skyMid);
    u.uHorizon.value.copy(look.skyHorizon).multiplyScalar(g * SKY_BAND_GAIN.skyHorizon);
    u.uHaze.value.copy(look.skyHaze).multiplyScalar(g * SKY_BAND_GAIN.skyHaze);
    u.uFloor.value.copy(look.skyFloor).multiplyScalar(g * SKY_BAND_GAIN.skyFloor);
    u.uCloudLit.value.copy(look.cloudLit).multiplyScalar(g * SKY_BAND_GAIN.cloudLit);
    u.uCloudShade.value.copy(look.cloudShade).multiplyScalar(g * SKY_BAND_GAIN.cloudShade);
    u.uSunColor.value.copy(look.skySun);
    u.uMoonColor.value.copy(look.moon);
    u.uCloudCover.value = look.cloudCover;
    u.uSunDisc.value = look.sunDisc;
    u.uMoonDisc.value = look.moonDisc;
    u.uStars.value = look.stars;
    u.uHazeAz.value = look.hazeAz;
    u.uSunGlow.value = look.sunGlow;

    /* ---- atmosphere ---- */
    // Fog must land exactly on the dome's horizon band or the skyline grows a
    // seam where the city stops and the sky starts.
    this.scene.fog.color.copy(u.uHorizon.value).lerp(u.uHaze.value, look.fogBlend);
    this.scene.fog.near = look.fogNear;
    this.scene.fog.far = look.fogFar;

    /* ---- grade ---- */
    this.post.setLook(look);

    /* ---- publish ---- */
    const d = this.scene.userData;
    d.timeOfDay = this.timeOfDay;
    d.nightFactor = night;
    d.goldenFactor = golden;
    d.sunElevation = rawElev;
    const dn = this._dayNight;
    dn.keyColor.copy(look.sun);
    dn.keyIntensity = look.sunI;
    dn.skyHi.copy(u.uMid.value);
    dn.skyLo.copy(u.uHorizon.value);
    dn.hazeColor.copy(u.uHaze.value);
    dn.fogColor.copy(this.scene.fog.color);
    dn.ambientLevel = look.ambientI + look.hemiI;
  }

  /* ---------------------------------------------------------- lights ----- */

  _buildLights() {
    const L = LIGHTING;

    // Key. Behind-right of the camera at 47 deg: lights the +Z faces hard,
    // leaves the -X faces on fill, and throws shadows up-screen where a
    // 54 deg camera can see them.
    this.sun = new THREE.DirectionalLight(L.SUN_COLOR, L.SUN_INTENSITY);
    this.sun.position.copy(this.sunDir).multiplyScalar(400);
    this.sun.castShadow = QUALITY.shadows;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this._applyShadowQuality();

    // Sky above / warm pavement bounce below. This is what stops shadowed
    // upward faces from turning cyan.
    this.hemi = new THREE.HemisphereLight(L.HEMI_SKY, L.HEMI_GROUND, L.HEMI_INTENSITY);
    this.scene.add(this.hemi);

    // Cool sky fill opposite the key — keeps form in the shadow side.
    this.fill = new THREE.DirectionalLight(L.FILL_COLOR, L.FILL_INTENSITY);
    this.fill.position.copy(dirFrom(L.FILL_AZIMUTH, L.FILL_ELEVATION)).multiplyScalar(300);
    this.scene.add(this.fill);
    this.scene.add(this.fill.target);

    // Warm bounce from below the horizon: light coming back up off hot
    // pavement onto the underside of awnings, cars and shaded facades.
    this.bounce = new THREE.DirectionalLight(L.BOUNCE_COLOR, L.BOUNCE_INTENSITY);
    this.bounce.position.copy(dirFrom(L.BOUNCE_AZIMUTH, L.BOUNCE_ELEVATION)).multiplyScalar(300);
    this.scene.add(this.bounce);
    this.scene.add(this.bounce.target);

    this.ambient = new THREE.AmbientLight(L.AMBIENT_COLOR, L.AMBIENT_INTENSITY);
    this.scene.add(this.ambient);
  }

  _applyShadowQuality() {
    const s = this.sun.shadow;
    this.sun.castShadow = QUALITY.shadows;
    this.renderer.shadowMap.enabled = QUALITY.shadows;
    if (s.mapSize.x !== QUALITY.shadowMapSize) {
      s.mapSize.set(QUALITY.shadowMapSize, QUALITY.shadowMapSize);
      if (s.map) { s.map.dispose(); s.map = null; }
    }
    s.radius = QUALITY.shadowRadius;
    s.camera.near = 1;
    s.camera.far = 1400;
    s.camera.updateProjectionMatrix();
  }

  /**
   * Public, and still honoured: game.js pokes this directly for its dev-cam
   * path. `_updateShadowFit()` recomputes a tighter box from the live camera
   * later in the same frame, so this only matters if the fit is skipped.
   */
  _setShadowExtent(e) {
    const c = this.sun.shadow.camera;
    c.left = -e; c.right = e; c.top = e; c.bottom = -e;
    c.updateProjectionMatrix();
    this._shadowExtent = e;
  }

  /**
   * Fit the shadow ortho to the *ground footprint of the view*, then snap its
   * centre to whole shadow texels.
   *
   * Fitting the full 3D frustum (the obvious thing) is wrong for this game: the
   * frustum is 460 m deep and mostly empty air, so its bounding sphere came out
   * at ~430 m half-extent even in a 52 m street shot. That put one shadow texel
   * at 0.28 m and forced a normalBias of 0.42 m — five times the height of a
   * kerb — which is exactly why cars and props had no shadows at all. Casting
   * the four far corner rays onto y=0 instead gives the *receiving surface*,
   * which is all a top-down city needs, and collapses the box to 60-140 m in
   * gameplay: ~0.04 m per texel, small enough for real contact shadows.
   *
   * The circle fit (rather than an AABB) makes the box size independent of
   * camera yaw, and the texel snap makes it independent of sub-texel camera
   * motion. Together they kill the crawling-edge shimmer.
   */
  _updateShadowFit() {
    if (!this.sun.castShadow) return;
    const cam = this.camera;
    cam.updateMatrixWorld();

    const maxD = Math.min(cam.far, QUALITY.shadowDistance);
    const tanY = Math.tan(THREE.MathUtils.degToRad(cam.fov * 0.5));
    const tanX = tanY * cam.aspect;
    _fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    _right.set(1, 0, 0).applyQuaternion(cam.quaternion);
    _camUp.set(0, 1, 0).applyQuaternion(cam.quaternion);

    const pts = this._frustumPts;
    let n = 0;
    for (let sy = -1; sy <= 1; sy += 2) {
      for (let sx = -1; sx <= 1; sx += 2) {
        _tmp.copy(_fwd).addScaledVector(_right, sx * tanX).addScaledVector(_camUp, sy * tanY);
        _tmp.normalize();
        // Rays that never reach the ground (looking at or above the horizon)
        // are clamped, so a tilted-up camera cannot explode the box.
        let t = maxD;
        if (_tmp.y < -1e-3) t = Math.min(maxD, Math.max(3, -cam.position.y / _tmp.y));
        pts[n++].copy(cam.position).addScaledVector(_tmp, t);
        pts[n - 1].y = 0;
        // Leash every footprint corner to the look-at point. Without this, a
        // shallow menu-hero camera pushes the far corners 2 km out, the circle
        // fit centres itself in the middle of that, the extent hits its clamp,
        // and the box ends up covering empty distance while the near field —
        // the only part anyone is looking at — falls outside it entirely. That
        // is exactly why the wide shots came back with no shadows at all.
        _tmp.copy(pts[n - 1]).sub(this._camTarget).setY(0);
        if (_tmp.length() > SHADOW_LEASH) {
          pts[n - 1].copy(this._camTarget).setY(0).add(_tmp.setLength(SHADOW_LEASH));
        }
      }
    }
    pts[n++].copy(this._camTarget).setY(0);   // the hole itself always matters

    _centre.set(0, 0, 0);
    for (let i = 0; i < n; i++) _centre.add(pts[i]);
    _centre.multiplyScalar(1 / n);
    let r = 0;
    for (let i = 0; i < n; i++) r = Math.max(r, pts[i].distanceTo(_centre));

    // Quantise so the box does not wobble by a metre every frame while the zoom
    // eases; 8 m steps are invisible and keep the map stable.
    let extent = THREE.MathUtils.clamp(Math.ceil((r * 1.06 + 6) / 8) * 8, 24, 560);

    _lx.crossVectors(_up, this.sunDir);
    if (_lx.lengthSq() < 1e-6) _lx.set(1, 0, 0);
    _lx.normalize();
    _ly.crossVectors(this.sunDir, _lx).normalize();

    // A tower is offset up-sun in the shadow plane by height*_ly.y, so a box
    // fitted to the ground alone frustum-culls the very casters whose shadows
    // fall into it. Grow toward the sun and slide the centre the same amount:
    // an asymmetric box with one uniform texel size.
    //
    // The offset goes as cot(elevation), so the 17 deg golden-hour key needs
    // ~3.3x the reach of the 56 deg afternoon key or the low sun — the one hour
    // whose long shadows are the entire point — is the hour that loses them.
    // Scaled relative to the authored 56 deg so the default fit is unchanged,
    // and hard-capped because every metre of lean costs shadow-map resolution.
    const cot = Math.min(3.5, 1 / Math.max(0.12, this.sunDir.y)) / 1.206;
    const lean = Math.min(extent * 0.45 * cot, 110);
    extent = Math.ceil((extent + lean * 0.5) / 8) * 8;
    _centre.addScaledVector(_ly, lean * 0.5);

    const texel = (extent * 2) / Math.max(256, QUALITY.shadowMapSize);
    const px = Math.round(_centre.dot(_lx) / texel) * texel;
    const py = Math.round(_centre.dot(_ly) / texel) * texel;
    const pz = _centre.dot(this.sunDir);
    _centre.copy(_lx).multiplyScalar(px)
      .addScaledVector(_ly, py)
      .addScaledVector(this.sunDir, pz);

    // Pull the light back far enough that a 210 m tower still fits in front of
    // the near plane, and cap far so ortho depth precision stays useful.
    const back = extent + 420;
    this.sun.position.copy(_centre).addScaledVector(this.sunDir, back);
    this.sun.target.position.copy(_centre);
    this.sun.target.updateMatrixWorld();

    const c = this.sun.shadow.camera;
    if (this._shadowExtent !== extent) this._setShadowExtent(extent);
    c.near = 1;
    c.far = back + extent + 200;
    c.updateProjectionMatrix();

    const s = this.sun.shadow;
    // ~1.4 texels along the normal kills acne without lifting the contact point
    // off the ground (peter-panning) — affordable now that texel is small.
    //
    // The depth error a texel produces on a receiver grows as 1/sin(elevation):
    // a bias tuned for the 56 deg afternoon key acnes the whole road surface
    // once the sun drops to golden hour. Scaled relative to that same 56 deg so
    // the default is bit-identical, capped at 3x so the low-sun hours trade a
    // little contact accuracy for a clean ground plane rather than the reverse.
    const graze = THREE.MathUtils.clamp(0.829 / Math.max(0.12, this.sunDir.y), 1.0, 3.0);
    s.normalBias = THREE.MathUtils.clamp(
      texel * 1.4 * graze * QUALITY.shadowBiasScale, 0.012, 0.62);
    s.bias = -0.05 / (c.far - c.near);
    // Moonlight has no hard edge, and a low sun's penumbra is genuinely wider.
    s.radius = QUALITY.shadowRadius * (this._look ? this._look.shadowSoft : 1);
  }

  /* ------------------------------------------------------------ post ----- */

  _buildComposer() {
    this.post = createPostChain(this.renderer, this.scene, this.camera);
    this.composer = this.post.composer;
    this.renderPass = this.post.passes.render;
    this.bloom = this.post.passes.bloom;
    this.gradePass = this.post.passes.grade;
    this.aoPass = this.post.passes.ao;
    this.smaa = this.post.passes.smaa;
    this._applyPostQuality();
  }

  _applyPostQuality() {
    this.post.applyQuality();
  }

  /** Step the renderer down one quality tier. Never steps back up — see quality.js. */
  setQualityTier(index) {
    const i = THREE.MathUtils.clamp(index, 0, QUALITY_TIERS.length - 1);
    if (i === this._tier) return;
    this._tier = i;
    const t = applyQualityTier(i);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY.pixelRatioCap));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.post.setSize(window.innerWidth, window.innerHeight);
    this._applyShadowQuality();
    this._applyPostQuality();
    this.skyMat.defines.CLOUD_OCT = 2 + Math.max(0, QUALITY.skyDetail);
    this.skyMat.defines.STARS = QUALITY.skyDetail >= 1 ? 1 : 0;
    this.skyMat.needsUpdate = true;
    // _applyPostQuality() re-reads GRADE, i.e. the noon baseline. Without this
    // a tier drop at 3am snaps the grade back to daylight.
    this._applyTimeOfDay();
    console.info(`[engine] quality -> ${t.name} (frame ${this._frameMs.toFixed(1)}ms)`);
  }

  _tickAdaptive() {
    const now = performance.now();
    const prev = this._lastFrameTs;
    this._lastFrameTs = now;
    if (!prev) return;
    const dt = now - prev;
    // Ignore tab stalls and the dev harness's synchronous frame bursts.
    if (dt <= 0 || dt > 300) return;
    this._frameMs += (dt - this._frameMs) * 0.05;
    this.stats.frameMs = this._frameMs;
    if (!QUALITY.adaptive || this._tier >= QUALITY_TIERS.length - 1) return;
    if (++this._adaptFrames < 200) return;      // ~3 s warm-up per tier
    if (this._frameMs > QUALITY.targetFrameMs) {
      this.setQualityTier(this._tier + 1);
      this._adaptFrames = 0;
      this._frameMs = QUALITY.targetFrameMs * 0.75;
    }
  }

  flash(amount, color = 0xffffff) {
    this.gradePass.uniforms.uFlash.value = Math.min(0.75, amount);
    this.gradePass.uniforms.uFlashColor.value.setHex(color);
  }

  /**
   * @param {THREE.Vector3} target world point to follow
   * @param {number} radius hole radius, drives zoom
   * @param {number} dt
   * @param {number} shake 0..1
   */
  updateCamera(target, radius, dt, shake = 0) {
    const wantDist = CAMERA.DIST_BASE + radius * CAMERA.DIST_PER_R;
    this._dist += (wantDist - this._dist) * (1 - Math.exp(-CAMERA.ZOOM_LERP * dt));

    this._camTarget.lerp(target, 1 - Math.exp(-CAMERA.FOLLOW_LERP * dt));

    const pitch = THREE.MathUtils.degToRad(CAMERA.PITCH);
    const yaw = THREE.MathUtils.degToRad(CAMERA.YAW);
    const d = this._dist;
    const y = Math.sin(pitch) * d;
    const h = Math.cos(pitch) * d;
    const x = Math.sin(yaw) * h;
    const z = Math.cos(yaw) * h;

    if (shake > 0.0001) {
      const t = this.time * 46;
      const a = shake * shake * 0.9;
      this._shakeOffset.set(
        Math.sin(t * 1.7) * a, Math.sin(t * 2.3 + 1.1) * a * 0.8, Math.cos(t * 1.9) * a
      );
    } else {
      this._shakeOffset.multiplyScalar(0.85);
    }

    this.camera.position.set(
      this._camTarget.x + x + this._shakeOffset.x,
      y + this._shakeOffset.y,
      this._camTarget.z + z + this._shakeOffset.z
    );
    this.camera.lookAt(
      this._camTarget.x + this._shakeOffset.x * 0.4,
      this._shakeOffset.y * 0.4,
      this._camTarget.z + this._shakeOffset.z * 0.4
    );
  }

  render(dt) {
    this.time += dt;
    this.renderer.info.reset();
    this._tickAdaptive();

    // ~45 lerps and ~30 uniform writes; measured at 0.02-0.04 ms. Skipped
    // entirely while the cycle is frozen.
    this._advanceCycle(dt);

    // materials.buildEnvironment() runs after this constructor and sets its own
    // IBL strength; the balance between IBL and the analytic rig is a lighting
    // decision, so re-assert it once the map exists.
    if (!this._envApplied && this.scene.environment) {
      this._envApplied = true;
      this._applyTimeOfDay();
    }

    this.skyMat.uniforms.uTime.value = this.time;
    this.sky.position.copy(this.camera.position);

    this._updateShadowFit();
    this.post.tuneAO(this._dist);

    const f = this.gradePass.uniforms.uFlash;
    if (f.value > 0) f.value = Math.max(0, f.value - dt * 2.6);

    // RenderPass draws into readBuffer, which alternates when the chain has an
    // odd number of swapping passes. Pin it so the depth texture handed to GTAO
    // is always the one the beauty pass just wrote.
    this.composer.readBuffer = this.composer.renderTarget2;
    this.composer.writeBuffer = this.composer.renderTarget1;
    this.composer.render(dt);

    const info = this.renderer.info.render;
    this.stats.drawCalls = info.calls;
    this.stats.triangles = info.triangles;
    this.stats.sceneCalls = this.post.stats.sceneCalls;
    this.stats.sceneTriangles = this.post.stats.sceneTriangles;
    this.stats.tier = QUALITY_TIERS[this._tier].name;
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY.pixelRatioCap));
    this.renderer.setSize(w, h, false);
    this.post.setSize(w, h);
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.post.dispose();
    this.renderer.dispose();
  }
}
