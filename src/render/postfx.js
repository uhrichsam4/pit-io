/**
 * Post-processing chain for MIAMI DEVOUR.
 *
 * ORDER (and why)
 *   RenderPass    scene -> linear HDR half-float target, with a depth texture
 *                 attached so the AO pass does not have to re-render the city.
 *   StatsProbe    zero-cost snapshot of the beauty-pass draw-call / triangle
 *                 counts before the fullscreen quads pollute them.
 *   GTAO          occlusion has to land *before* bloom, or creases glow.
 *   Bloom         thresholded in linear HDR, so only genuinely over-bright
 *                 pixels (sun disc, glass hits, chrome) can bloom at all.
 *   Grade         exposure -> white balance -> split tone -> contrast ->
 *                 TONE MAP -> saturation -> neutralise -> vignette -> flash
 *                 -> dither. One pass; it owns the tone curve.
 *   OutputPass    with renderer.toneMapping = NoToneMapping this is purely the
 *                 sRGB encode — the grade has already tone-mapped.
 *   SMAA          wants sRGB input, so it has to follow the encode.
 *
 * The previous chain graded *before* tone mapping and clamped to [0,1] on the
 * way through, which threw away every highlight in the scene and pinned peak
 * white at ACES(1.0) ~= 0.80. That single clamp is why the game read flat.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { GRADE, QUALITY } from '../core/quality.js';

/* ------------------------------------------------------------------ grade --- */

/**
 * The look. Kept exported under its original name because `engine.flash()`
 * pokes `uFlash` / `uFlashColor` on the ShaderPass built from it.
 */
export const GradeShader = {
  name: 'MiamiGrade',
  uniforms: {
    tDiffuse: { value: null },
    uExposure: { value: GRADE.exposure },
    uContrast: { value: GRADE.contrast },
    uSaturation: { value: GRADE.saturation },
    uTemperature: { value: GRADE.temperature },
    uShadowTint: { value: new THREE.Vector3(...GRADE.shadowTint) },
    uHighlightTint: { value: new THREE.Vector3(...GRADE.highlightTint) },
    uNeutralise: { value: GRADE.neutralise },
    uVignette: { value: GRADE.vignette },
    uAberration: { value: GRADE.aberration },
    uDither: { value: GRADE.dither },
    uToneStart: { value: GRADE.toneStart },
    uToneDesat: { value: GRADE.toneDesat },
    uFlash: { value: 0.0 },
    uFlashColor: { value: new THREE.Color(1, 1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uExposure, uContrast, uSaturation, uTemperature;
    uniform float uNeutralise, uVignette, uAberration, uDither, uFlash;
    uniform float uToneStart, uToneDesat;
    uniform vec3 uShadowTint, uHighlightTint, uFlashColor;
    varying vec2 vUv;

    float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    /**
     * Khronos PBR Neutral rather than ACES, with the shoulder start exposed.
     * ACES is the safer film curve but it desaturates bright colour hard, and
     * this game lives or dies on saturated pastel stucco and aqua glass staying
     * saturated in full sun. Neutral is *linear* below the shoulder, so midtone
     * albedo lands exactly where the art bible says it should, and only the
     * highlights get compressed.
     */
    vec3 toneMap(vec3 c){
      float START = uToneStart;
      float DESAT = uToneDesat;
      float x = min(c.r, min(c.g, c.b));
      float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
      c -= offset;
      float peak = max(c.r, max(c.g, c.b));
      if (peak < START) return c;
      float d = 1.0 - START;
      float newPeak = 1.0 - d * d / (peak + d - START);
      c *= newPeak / peak;
      float g = 1.0 - 1.0 / (DESAT * (peak - newPeak) + 1.0);
      return mix(c, vec3(newPeak), g);
    }

    // Interleaved gradient noise — cheap, stable, no texture fetch.
    float ign(vec2 p){
      return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
    }

    void main() {
      vec2 cc = vUv - 0.5;
      float r2 = dot(cc, cc);

      // Lens aberration is sampled in HDR so it survives the tone curve.
      vec2 off = cc * uAberration * (0.35 + r2 * 2.2);
      vec3 hdr;
      hdr.r = texture2D(tDiffuse, vUv + off).r;
      hdr.g = texture2D(tDiffuse, vUv).g;
      hdr.b = texture2D(tDiffuse, vUv - off).b;
      hdr = max(hdr, vec3(0.0));

      hdr *= uExposure;

      // White balance: warm the whole illuminant a touch. Late-afternoon Miami.
      hdr *= vec3(1.0 + uTemperature, 1.0 + uTemperature * 0.18, 1.0 - uTemperature * 0.90);

      // Split tone, weighted by scene luminance while still in linear.
      float lin = luma(hdr);
      float sw = 1.0 - smoothstep(0.0, 0.20, lin);
      float hw = smoothstep(0.40, 1.60, lin);
      hdr += uShadowTint * sw;
      hdr *= (1.0 + uHighlightTint * hw);
      hdr = max(hdr, vec3(0.0));

      // Contrast pivoted on 18% grey. A power curve in linear stays HDR-safe:
      // it cannot clip, unlike the old (x-0.5)*k+0.5 which crushed everything.
      hdr = pow(hdr / 0.18, vec3(uContrast)) * 0.18;

      vec3 col = toneMap(hdr);

      /* ---- display-referred from here on ---- */

      float l = luma(col);
      col = mix(vec3(l), col, uSaturation);

      // Secondary: neutralise low-chroma blue-dominant midtones. See GRADE.neutralise.
      float mx = max(col.r, max(col.g, col.b));
      float mn = min(col.r, min(col.g, col.b));
      float sat = (mx - mn) / max(mx, 1e-4);
      float blueDom = smoothstep(0.0, 0.05, col.b - max(col.r, col.g));
      float lowChroma = 1.0 - smoothstep(0.14, 0.30, sat);
      float band = smoothstep(0.02, 0.08, l) * (1.0 - smoothstep(0.62, 0.88, l));
      float k = uNeutralise * blueDom * lowChroma * band;
      float grey = (col.r + col.g) * 0.5;
      col.b = mix(col.b, grey, k * 0.85);
      col.r = mix(col.r, grey * 1.05, k * 0.55);

      col *= 1.0 - uVignette * smoothstep(0.16, 0.80, r2);
      col = mix(col, uFlashColor, uFlash);
      col = max(col, vec3(0.0));

      // Dither in a perceptual space so one unit of noise is one output code
      // value everywhere, not just in the highlights. Without this the sky
      // gradient bands into visible steps across a 900 px frame.
      vec3 enc = pow(col, vec3(1.0 / 2.2));
      float n = ign(gl_FragCoord.xy) + ign(gl_FragCoord.yx + 17.0) - 1.0;
      enc += n * (uDither / 255.0);
      col = pow(max(enc, vec3(0.0)), vec3(2.2));

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

/* ------------------------------------------------------------------ probe --- */

/**
 * Reads renderer.info straight after the beauty pass. Counting at the end of
 * the frame folds in every fullscreen quad and the shadow pass, which makes
 * the number useless for judging whether the *city* is over budget.
 */
class StatsProbe extends Pass {
  constructor(out) {
    super();
    this.needsSwap = false;
    this.out = out;
  }
  render(renderer) {
    this.out.sceneCalls = renderer.info.render.calls;
    this.out.sceneTriangles = renderer.info.render.triangles;
  }
  setSize() {}
}

/* -------------------------------------------------------------------- ao --- */

function createGTAO(scene, camera, w, h, depthTexture) {
  // Constructed with its own G-buffer first: GTAOPass.setGBuffer() dereferences
  // this.normalRenderTarget unconditionally, so that target has to exist before
  // we hand the pass an external depth texture and switch the re-render off.
  const ao = new GTAOPass(scene, camera, Math.round(w), Math.round(h));
  ao.setGBuffer(depthTexture);          // -> _renderGBuffer = false, normals from depth
  ao.output = GTAOPass.OUTPUT.Default;
  ao.blendIntensity = GRADE.aoIntensity;
  ao.updateGtaoMaterial({
    radius: GRADE.aoRadius,
    distanceExponent: GRADE.aoDistanceExponent,
    thickness: GRADE.aoThicknessMin,
    scale: GRADE.aoScalePower,
    samples: QUALITY.aoSamples,
    screenSpaceRadius: GRADE.aoScreenSpace,
  });
  ao.updatePdMaterial({
    lumaPhi: 10, depthPhi: 2, normalPhi: 3,
    radius: 4, radiusExponent: 1.0, rings: 2,
    samples: QUALITY.aoDenoiseSamples,
  });

  // The composer calls setSize() with the full framebuffer size; re-scale it so
  // QUALITY.aoScale actually buys something on slow devices.
  const baseSetSize = ao.setSize.bind(ao);
  ao.setSize = (sw, sh) => {
    const s = Math.max(0.35, Math.min(1, QUALITY.aoScale));
    baseSetSize(Math.max(1, Math.round(sw * s)), Math.max(1, Math.round(sh * s)));
    // The internal normal G-buffer is dead weight now that depth comes from the
    // composer; keep it allocated (setSize/dispose still touch it) but 1x1.
    ao.normalRenderTarget.setSize(1, 1);
  };
  ao.normalRenderTarget.setSize(1, 1);
  return ao;
}

/* ------------------------------------------------------------------ chain --- */

/**
 * Builds the whole chain. Optional passes are constructed inside try blocks so
 * a driver that chokes on one addon degrades instead of taking the game down.
 */
export function createPostChain(renderer, scene, camera) {
  const size = new THREE.Vector2();
  renderer.getSize(size);
  const pr = renderer.getPixelRatio();
  const bw = Math.max(1, Math.round(size.x * pr));
  const bh = Math.max(1, Math.round(size.y * pr));

  // A depth texture on the composer target is what lets GTAO skip its own full
  // re-render of the city into a normal buffer (several hundred draw calls).
  const depthTexture = new THREE.DepthTexture(bw, bh);
  depthTexture.format = THREE.DepthFormat;
  depthTexture.type = THREE.UnsignedIntType;
  depthTexture.minFilter = THREE.NearestFilter;
  depthTexture.magFilter = THREE.NearestFilter;

  const rt = new THREE.WebGLRenderTarget(bw, bh, {
    type: THREE.HalfFloatType,
    depthBuffer: true,
    depthTexture,
  });
  rt.texture.name = 'MiamiComposer.rt';

  const composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(pr);
  composer.setSize(size.x, size.y);

  // RenderPass has needsSwap=false, so it always draws into `readBuffer` —
  // which, with an odd number of swapping passes, alternates every frame. Pin
  // it (see Engine.render) so the depth texture GTAO reads is always the one
  // the beauty pass just wrote.
  composer.readBuffer = composer.renderTarget2;
  composer.writeBuffer = composer.renderTarget1;
  const sceneDepth = composer.renderTarget2.depthTexture;

  const stats = { sceneCalls: 0, sceneTriangles: 0 };
  const passes = {};

  passes.render = new RenderPass(scene, camera);
  composer.addPass(passes.render);

  passes.probe = new StatsProbe(stats);
  composer.addPass(passes.probe);

  try {
    passes.ao = createGTAO(scene, camera, bw, bh, sceneDepth);
    passes.ao.enabled = QUALITY.ao;
    composer.addPass(passes.ao);
  } catch (e) {
    console.warn('[postfx] GTAO unavailable, continuing without AO', e);
    passes.ao = null;
  }

  // Bloom thresholds the *pre-exposure* buffer, so the artistic threshold is
  // expressed in post-exposure terms and divided back out here.
  const bloomThreshold = () => GRADE.bloomThreshold / Math.max(0.05, GRADE.exposure);
  passes.bloom = new UnrealBloomPass(
    new THREE.Vector2(size.x, size.y),
    GRADE.bloomStrength, GRADE.bloomRadius, bloomThreshold()
  );
  passes.bloom.enabled = QUALITY.bloom;
  composer.addPass(passes.bloom);

  passes.grade = new ShaderPass(GradeShader);
  composer.addPass(passes.grade);

  passes.output = new OutputPass();
  composer.addPass(passes.output);

  try {
    passes.smaa = new SMAAPass();
    passes.smaa.enabled = QUALITY.smaa;
    composer.addPass(passes.smaa);
  } catch (e) {
    console.warn('[postfx] SMAA unavailable, falling back to no AA', e);
    passes.smaa = null;
  }

  /** Push the current QUALITY / GRADE values into the live passes. */
  function applyQuality() {
    if (passes.bloom) {
      passes.bloom.enabled = QUALITY.bloom;
      passes.bloom.strength = GRADE.bloomStrength;
      passes.bloom.radius = GRADE.bloomRadius;
      passes.bloom.threshold = bloomThreshold();
    }
    if (passes.smaa) passes.smaa.enabled = QUALITY.smaa;
    if (passes.ao) {
      passes.ao.enabled = QUALITY.ao;
      passes.ao.blendIntensity = GRADE.aoIntensity;
      passes.ao.updateGtaoMaterial({
        radius: GRADE.aoRadius,
        distanceExponent: GRADE.aoDistanceExponent,
        scale: GRADE.aoScalePower,
        samples: QUALITY.aoSamples,
        screenSpaceRadius: GRADE.aoScreenSpace,
      });
      passes.ao.updatePdMaterial({ samples: QUALITY.aoDenoiseSamples });
    }
    const u = passes.grade.uniforms;
    u.uExposure.value = GRADE.exposure;
    u.uContrast.value = GRADE.contrast;
    u.uSaturation.value = GRADE.saturation;
    u.uTemperature.value = GRADE.temperature;
    u.uShadowTint.value.set(...GRADE.shadowTint);
    u.uHighlightTint.value.set(...GRADE.highlightTint);
    u.uNeutralise.value = GRADE.neutralise;
    u.uVignette.value = GRADE.vignette;
    u.uAberration.value = GRADE.aberration;
    u.uDither.value = GRADE.dither;
    u.uToneStart.value = GRADE.toneStart;
    u.uToneDesat.value = GRADE.toneDesat;
  }

  /**
   * Keep the AO occluder depth in step with the zoom. See GRADE.aoThicknessPerDist.
   * @param {number} dist camera distance to the look-at point, metres
   */
  function tuneAO(dist) {
    if (!passes.ao || !passes.ao.enabled) return;
    const t = Math.min(GRADE.aoThicknessMax,
      Math.max(GRADE.aoThicknessMin, dist * GRADE.aoThicknessPerDist));
    passes.ao.gtaoMaterial.uniforms.thickness.value = t;
  }

  function setSize(w, h) {
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(w, h);
    if (passes.bloom) passes.bloom.setSize(w, h);
  }

  function dispose() {
    for (const p of Object.values(passes)) if (p && p.dispose) p.dispose();
    composer.renderTarget1.dispose();
    composer.renderTarget2.dispose();
  }

  return { composer, passes, stats, applyQuality, tuneAO, setSize, dispose };
}
