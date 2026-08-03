/**
 * Engine: renderer, scene, sun/sky, camera rig and the post-processing chain.
 * Owns nothing about gameplay — game.js drives it.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { CAMERA, PALETTE, QUALITY, WORLD } from '../config.js';

/* ------------------------------------------------------------------ sky --- */

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_Position.z = gl_Position.w; // always at the far plane
  }
`;

const SKY_FRAG = /* glsl */ `
  uniform vec3 uTop, uHorizon, uSun, uSunDir;
  uniform float uTime;
  varying vec3 vDir;

  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
  float noise(vec2 p){
    vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
    return mix(mix(hash(i),hash(i+vec2(1,0)),u.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y);
  }
  float fbm(vec2 p){
    float v=0.0, a=0.5;
    for(int i=0;i<5;i++){ v+=a*noise(p); p*=2.03; a*=0.5; }
    return v;
  }

  void main() {
    vec3 d = normalize(vDir);
    float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
    float grad = pow(clamp(d.y, 0.0, 1.0), 0.62);
    vec3 col = mix(uHorizon, uTop, grad);

    // warm haze sitting on the horizon line
    float haze = pow(1.0 - clamp(abs(d.y) * 3.4, 0.0, 1.0), 2.0);
    col = mix(col, vec3(1.0, 0.94, 0.84), haze * 0.30);

    // sun glow
    float sd = max(0.0, dot(d, normalize(uSunDir)));
    col += uSun * pow(sd, 220.0) * 1.4;
    col += uSun * pow(sd, 9.0) * 0.16;

    // drifting fair-weather cumulus, projected onto the dome
    if (d.y > 0.015) {
      vec2 uv = d.xz / (d.y + 0.22);
      float t = uTime * 0.006;
      float c = fbm(uv * 0.75 + vec2(t, t * 0.42));
      float c2 = fbm(uv * 1.9 + vec2(-t * 1.7, t * 0.9));
      float mask = smoothstep(0.56, 0.80, c * 0.72 + c2 * 0.34);
      mask *= smoothstep(0.0, 0.30, d.y);
      float shade = smoothstep(0.50, 0.92, c);
      vec3 cloud = mix(vec3(0.80, 0.85, 0.92), vec3(1.0), shade);
      col = mix(col, cloud, mask * 0.92);
    }

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/* --------------------------------------------------------------- grading --- */

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uVignette: { value: 0.30 },
    uSaturation: { value: 1.13 },
    uContrast: { value: 1.045 },
    uLift: { value: new THREE.Vector3(0.004, 0.006, 0.014) },
    uGain: { value: new THREE.Vector3(1.015, 1.0, 0.985) },
    uAberration: { value: 0.0012 },
    uFlash: { value: 0.0 },
    uFlashColor: { value: new THREE.Color(1, 1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVignette, uSaturation, uContrast, uAberration, uFlash;
    uniform vec3 uLift, uGain, uFlashColor;
    varying vec2 vUv;
    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);

      // gentle lateral chromatic aberration toward the corners
      vec2 off = c * uAberration * (0.5 + r2 * 2.4);
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;

      col = col * uGain + uLift;
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSaturation);
      col = (col - 0.5) * uContrast + 0.5;

      float vig = 1.0 - uVignette * smoothstep(0.15, 0.78, r2);
      col *= vig;

      col = mix(col, uFlashColor, uFlash);
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `,
};

/* ---------------------------------------------------------------- engine --- */

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;

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
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.98;
    this.renderer.shadowMap.enabled = QUALITY.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = true;

    this.maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    QUALITY.anisotropy = Math.min(QUALITY.anisotropy, this.maxAniso);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(PALETTE.FOG, 420, 1650);

    this.camera = new THREE.PerspectiveCamera(
      CAMERA.FOV, window.innerWidth / window.innerHeight, CAMERA.NEAR, CAMERA.FAR
    );
    this.camera.position.set(40, 50, 40);
    this.camera.lookAt(0, 0, 0);

    this._buildSky();
    this._buildLights();
    this._buildComposer();

    this._followPos = new THREE.Vector3();
    this._camTarget = new THREE.Vector3();
    this._dist = CAMERA.DIST_BASE;
    this._shakeOffset = new THREE.Vector3();
    this.time = 0;

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
  }

  _buildSky() {
    this.sunDir = new THREE.Vector3(0.42, 0.62, -0.66).normalize();
    const geo = new THREE.SphereGeometry(1, 40, 24);
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      uniforms: {
        uTop: { value: new THREE.Color(PALETTE.SKY_TOP) },
        uHorizon: { value: new THREE.Color(PALETTE.SKY_HORIZON) },
        uSun: { value: new THREE.Color(PALETTE.SUN) },
        uSunDir: { value: this.sunDir.clone() },
        uTime: { value: 0 },
      },
    });
    this.sky = new THREE.Mesh(geo, this.skyMat);
    this.sky.scale.setScalar(2000);
    this.sky.renderOrder = -1000;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
  }

  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0xbfe8ff, 0x8f8f7a, 0.55);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff3dd, 1.85);
    this.sun.position.copy(this.sunDir).multiplyScalar(300);
    this.sun.castShadow = QUALITY.shadows;
    const s = this.sun.shadow;
    s.mapSize.set(QUALITY.shadowMapSize, QUALITY.shadowMapSize);
    s.camera.near = 1;
    s.camera.far = 900;
    s.bias = -0.00035;
    s.normalBias = 0.42;
    s.radius = 2.0;
    this._setShadowExtent(150);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.fill = new THREE.DirectionalLight(0xa8d8ff, 0.24);
    this.fill.position.set(-0.5, 0.42, 0.72).multiplyScalar(200);
    this.scene.add(this.fill);

    this.ambient = new THREE.AmbientLight(0xffffff, 0.10);
    this.scene.add(this.ambient);
  }

  _setShadowExtent(e) {
    const c = this.sun.shadow.camera;
    c.left = -e; c.right = e; c.top = e; c.bottom = -e;
    c.updateProjectionMatrix();
    this._shadowExtent = e;
  }

  _buildComposer() {
    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(size.x, size.y);

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    this.bloom = new UnrealBloomPass(size.clone(), 0.42, 0.72, 0.86);
    this.bloom.enabled = QUALITY.bloom;
    this.composer.addPass(this.bloom);

    this.gradePass = new ShaderPass(GradeShader);
    this.composer.addPass(this.gradePass);

    this.composer.addPass(new OutputPass());

    try {
      this.smaa = new SMAAPass();
      this.composer.addPass(this.smaa);
    } catch (e) {
      console.warn('[engine] SMAA unavailable', e);
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

    // Keep the shadow frustum tight around whatever we can actually see.
    const want = THREE.MathUtils.clamp(58 + d * 1.35, 70, 340);
    if (Math.abs(want - this._shadowExtent) > 12) this._setShadowExtent(want);
    this.sun.target.position.set(this._camTarget.x, 0, this._camTarget.z);
    this.sun.position.set(
      this._camTarget.x + this.sunDir.x * 320,
      this.sunDir.y * 320,
      this._camTarget.z + this.sunDir.z * 320
    );
  }

  render(dt) {
    this.time += dt;
    this.skyMat.uniforms.uTime.value = this.time;
    this.sky.position.copy(this.camera.position);
    const f = this.gradePass.uniforms.uFlash;
    if (f.value > 0) f.value = Math.max(0, f.value - dt * 2.6);
    this.composer.render(dt);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY.pixelRatioCap));
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
  }
}
