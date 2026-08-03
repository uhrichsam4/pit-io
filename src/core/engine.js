/**
 * Engine: renderer, scene, sky dome, light rig, shadow fitting, camera rig and
 * the post-processing chain. Owns nothing about gameplay — game.js drives it.
 *
 * The public surface game.js and dev/devtools.js rely on:
 *   .scene .camera .renderer .sun .sunDir .hemi ._camTarget ._dist
 *   .updateCamera(target, radius, dt, shake)  .render(dt)  .flash(a, hex)
 *   .resize()  ._setShadowExtent(e)
 */

import * as THREE from 'three';
import { CAMERA, PALETTE, QUALITY } from '../config.js';
import { GRADE, LIGHTING, QUALITY_TIERS, applyQualityTier } from './quality.js';
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
  uniform vec3 uCloudLit, uCloudShade;
  uniform float uTime, uCloudCover, uDrift, uSunDisc;
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
    col = mix(col, uHaze, haze * (0.34 + 0.24 * max(azimuthal, 0.0)));

    // Below the horizon line the dome becomes distant sea haze.
    col = mix(col, uFloor, smoothstep(0.0, -0.055, d.y));

    /* ---- sun ----------------------------------------------------------- */
    float cd = dot(d, sd);
    // ~0.5 deg core with a soft limb, then two decades of aureole.
    float core = smoothstep(0.99988, 0.999955, cd);
    float aureole = pow(max(cd, 0.0), 2200.0) * 1.1
                  + pow(max(cd, 0.0), 120.0) * 0.28
                  + pow(max(cd, 0.0), 9.0) * 0.085;
    col += uSunColor * aureole;
    col += uSunColor * core * uSunDisc;

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
    // tightly. PCF spreads its taps by `radius`, so softness is tunable.
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

    this._buildSky();
    this._buildLights();
    this._buildComposer();

    this._followPos = new THREE.Vector3();
    this._camTarget = new THREE.Vector3();
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
    this.sunDir = dirFrom(LIGHTING.SUN_AZIMUTH, LIGHTING.SUN_ELEVATION);

    const g = LIGHTING.SKY_GAIN;
    const geo = new THREE.SphereGeometry(1, 48, 28);
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      defines: { CLOUD_OCT: 2 + Math.max(0, QUALITY.skyDetail) },
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
        uSunDir: { value: this.sunDir.clone() },
        uCloudLit: { value: litColor(LIGHTING.CLOUD_LIT, g * 1.60) },
        uCloudShade: { value: litColor(LIGHTING.CLOUD_SHADE, g * 1.00) },
        uCloudCover: { value: LIGHTING.CLOUD_COVER },
        uDrift: { value: LIGHTING.CLOUD_DRIFT },
        uSunDisc: { value: 9.0 },
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
    const lean = Math.min(extent * 0.45, 60);
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
    s.normalBias = THREE.MathUtils.clamp(texel * 1.4 * QUALITY.shadowBiasScale, 0.012, 0.55);
    s.bias = -0.05 / (c.far - c.near);
    s.radius = QUALITY.shadowRadius;
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
    this.skyMat.needsUpdate = true;
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

    // materials.buildEnvironment() runs after this constructor and sets its own
    // IBL strength; the balance between IBL and the analytic rig is a lighting
    // decision, so re-assert it once the map exists.
    if (!this._envApplied && this.scene.environment) {
      this.scene.environmentIntensity = LIGHTING.ENV_INTENSITY;
      this._envApplied = true;
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
