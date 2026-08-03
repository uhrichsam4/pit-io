/**
 * Particle + impulse feedback: dust plumes, debris chunks, glass glints, ring
 * shockwaves and floating score numbers.
 *
 * Four pooled systems, four draw calls, zero allocation on the hot path:
 *   points   — soft dust, NormalBlending, lifetime-driven colour and growth
 *   glints   — tiny additive sparks, for the moment glass or chrome lets go
 *   debris   — one InstancedMesh of solid chunks that tumble, bounce and settle
 *   rings    — expanding shockwaves with a hard leading edge and a soft tail
 *
 * ---------------------------------------------------------------------------
 * THE BUDGET
 * ---------------------------------------------------------------------------
 * Everything here runs on the CPU once per frame, so the cost is bounded by
 * the pool sizes, not by how much is happening. The three things that keep it
 * under ~1 ms at full tilt:
 *
 *   1. Live counts are tracked, not discovered. When nothing is alive the
 *      update loops and — more importantly — the vertex-buffer uploads are
 *      skipped entirely. Re-uploading 3,000 dead particles every frame was
 *      most of the old cost, and it was paid whether or not anything had
 *      happened all match.
 *   2. Draw ranges and instance counts follow a high-water mark that decays,
 *      so a quiet frame does not rasterise 900 zero-scale cubes.
 *   3. No allocation. The old debris integrator built a fresh Quaternion and
 *      Euler per chunk per frame — 900 objects a frame straight into the
 *      nursery. Spin is integrated on the quaternion in place now.
 *
 * The public API (puff, chunks, shockwave, popup, addShake, update, .shake,
 * .popups) is what game.js and gameplay/consume.js call. Do not change it.
 */

import * as THREE from 'three';
import { PALETTE } from '../config.js';

const MAX_PARTICLES = 3000;
const MAX_GLINTS = 512;
const MAX_DEBRIS = 900;
const MAX_RINGS = 24;

/**
 * The live Effects instance.
 *
 * gameplay/hole.js spills grit off its own lip every frame it moves, and the
 * Hole constructor is called from four places (game.startMatch, spawnBots,
 * _syncPeerHoles, dev tooling) none of which have a reference to hand it. A
 * module-level handle is far less invasive than threading one through all of
 * them — and there is exactly one Effects in the process.
 */
let _active = null;
export function activeEffects() { return _active; }

/**
 * Flag `count` elements of an attribute for upload instead of the whole buffer.
 * `updateRanges` is consumed and cleared by WebGLAttributes after each upload,
 * so this has to be re-declared every frame the data changes.
 */
function markRange(attr, count, itemSize) {
  if (!attr) return;
  attr.clearUpdateRanges();
  if (count > 0) attr.addUpdateRange(0, count * itemSize);
  attr.needsUpdate = true;
}

/* -------------------------------------------------------------- dust ------ */

const P_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aLife;      // 1 at birth -> 0 at death
  attribute vec3  aColor;
  attribute float aSeed;
  varying float vLife;
  varying vec3  vColor;
  varying float vSeed;
  void main() {
    vLife = aLife;
    vColor = aColor;
    vSeed = aSeed;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // Dust plumes expand as they age. Doing it here rather than on the CPU
    // keeps the size attribute static after birth. Starting small and growing
    // hard is what makes neighbouring particles overlap into a single plume
    // instead of reading as a scatter of discrete white dots against the void.
    float grow = 0.55 + (1.0 - aLife) * 2.3;
    gl_PointSize = aSize * grow * (300.0 / max(0.001, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const P_FRAG = /* glsl */ `
  varying float vLife;
  varying vec3  vColor;
  varying float vSeed;
  void main() {
    if (vLife <= 0.0) discard;
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;

    // Grit: chew the disc's edge so a plume is a cloud of particles rather
    // than a cluster of airbrushed dots. Built from products of d rather than
    // atan+sin — this runs on every dust pixel of every plume, and a plume can
    // cover a quarter of the screen.
    float c2 = d.x * d.x - d.y * d.y;      // r^2 * cos(2a)
    float s2 = 2.0 * d.x * d.y;            // r^2 * sin(2a)
    float bite = 0.21 + (s2 * 1.9 + c2 * (vSeed * 2.4 - 1.2)) * 0.22;
    if (r2 > bite) discard;

    float soft = 1.0 - smoothstep(0.02, bite, r2);
    // Fade in fast, out slow: a puff should appear instantly and linger.
    float fade = smoothstep(0.0, 0.12, 1.0 - vLife) * vLife;
    // Capped below 1: dozens of overlapping plumes during a block-sized meal
    // otherwise stack into an opaque fog that veils the void, and the void
    // being the darkest thing on screen is the whole point of the game.
    gl_FragColor = vec4(vColor, soft * clamp(fade * 1.35, 0.0, 0.78));
    #include <colorspace_fragment>
  }
`;

/* ------------------------------------------------------------- glints ----- */

const G_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aLife;
  attribute vec3  aColor;
  varying float vLife;
  varying vec3  vColor;
  void main() {
    vLife = aLife;
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (300.0 / max(0.001, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const G_FRAG = /* glsl */ `
  varying float vLife;
  varying vec3  vColor;
  void main() {
    if (vLife <= 0.0) discard;
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d);
    if (r > 0.5) discard;
    // Four-point star: a glint is a specular event, not a ball of light.
    float core = exp(-r * 22.0);
    float streak = exp(-abs(d.x) * 90.0) * exp(-abs(d.y) * 9.0)
                 + exp(-abs(d.y) * 90.0) * exp(-abs(d.x) * 9.0);
    float i = (core * 1.6 + streak * 0.55) * vLife * vLife;
    gl_FragColor = vec4(vColor * i, 1.0);
  }
`;

/* -------------------------------------------------------------- rings ----- */

const R_VERT = /* glsl */ `
  varying float vT;
  void main() {
    // Radial parameter recovered from the unit annulus, so no custom attribute
    // is needed and RingGeometry can be shared by every ring in the pool.
    vT = clamp((length(position.xz) - ${(0.55).toFixed(2)}) / ${(0.45).toFixed(2)}, 0.0, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const R_FRAG = /* glsl */ `
  uniform vec3  uColor;
  uniform float uOpacity;
  uniform float uRadius;   // current world radius of the leading edge
  uniform float uTail;     // tail length, metres
  varying float vT;
  void main() {
    // Distance BEHIND the leading edge, in metres. Expressing the profile in
    // world units is what keeps a small ring crisp and a huge one from turning
    // into a soft doughnut.
    float behind = (1.0 - vT) * uRadius;
    float edge  = exp(-behind * (6.0 / max(0.4, uTail)));       // hard front
    float wash  = exp(-behind * (1.1 / max(0.4, uTail))) * 0.42; // soft tail
    // Feather the outermost sliver so the front is never a stair-stepped circle.
    float out_ = 1.0 - smoothstep(0.97, 1.0, vT);
    float a = (edge + wash) * uOpacity * out_;
    if (a <= 0.002) discard;
    gl_FragColor = vec4(uColor * (1.0 + edge * 1.4), a);
  }
`;

/* ========================================================================== */

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.time = 0;

    /* ---- soft particles (dust) ----------------------------------------- */
    const g = new THREE.BufferGeometry();
    this.pPos = new Float32Array(MAX_PARTICLES * 3);
    this.pVel = new Float32Array(MAX_PARTICLES * 3);
    this.pSize = new Float32Array(MAX_PARTICLES);
    this.pLife = new Float32Array(MAX_PARTICLES);
    this.pMaxLife = new Float32Array(MAX_PARTICLES);
    this.pColor = new Float32Array(MAX_PARTICLES * 3);
    this.pCol0 = new Float32Array(MAX_PARTICLES * 3);   // birth colour
    this.pSeed = new Float32Array(MAX_PARTICLES);
    this.pDrag = new Float32Array(MAX_PARTICLES);
    this.pTurb = new Float32Array(MAX_PARTICLES);
    g.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.pSize, 1));
    g.setAttribute('aLife', new THREE.BufferAttribute(this.pLife, 1));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.pColor, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(this.pSeed, 1));
    g.setDrawRange(0, 0);
    this.pGeo = g;
    this.points = new THREE.Points(
      g,
      new THREE.ShaderMaterial({
        vertexShader: P_VERT,
        fragmentShader: P_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.NormalBlending,
      })
    );
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    scene.add(this.points);
    this.pHead = 0;
    this.pAlive = 0;
    this.pHigh = 0;

    /* ---- additive glints ------------------------------------------------ */
    const gg = new THREE.BufferGeometry();
    this.sPos = new Float32Array(MAX_GLINTS * 3);
    this.sVel = new Float32Array(MAX_GLINTS * 3);
    this.sSize = new Float32Array(MAX_GLINTS);
    this.sLife = new Float32Array(MAX_GLINTS);
    this.sMaxLife = new Float32Array(MAX_GLINTS);
    this.sColor = new Float32Array(MAX_GLINTS * 3);
    gg.setAttribute('position', new THREE.BufferAttribute(this.sPos, 3));
    gg.setAttribute('aSize', new THREE.BufferAttribute(this.sSize, 1));
    gg.setAttribute('aLife', new THREE.BufferAttribute(this.sLife, 1));
    gg.setAttribute('aColor', new THREE.BufferAttribute(this.sColor, 3));
    gg.setDrawRange(0, 0);
    this.sGeo = gg;
    this.glints = new THREE.Points(
      gg,
      new THREE.ShaderMaterial({
        vertexShader: G_VERT,
        fragmentShader: G_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    this.glints.frustumCulled = false;
    this.glints.renderOrder = 7;
    scene.add(this.glints);
    this.sHead = 0;
    this.sAlive = 0;
    this.sHigh = 0;

    /* ---- solid debris chunks -------------------------------------------- */
    // A rubble shard, not a sugar cube. docs/ART_DIRECTION.md §6 makes sharp
    // 90-degree box edges an explicit tell of cheap 3D, and a collapsing tower
    // throws chunks big enough for the player to read their silhouette. A
    // jittered icosahedron is 20 triangles — 8 more than a box — and reads as
    // broken masonry from any angle.
    const chunk = new THREE.IcosahedronGeometry(0.62, 0);
    {
      const p = chunk.attributes.position;
      for (let i = 0; i < p.count; i++) {
        // Deterministic jitter: a hash of the index, so every hole in every
        // client gets the same silhouette and the geometry stays shareable.
        const h = Math.sin(i * 12.9898) * 43758.5453;
        const j = 0.72 + (h - Math.floor(h)) * 0.56;
        p.setXYZ(i, p.getX(i) * j, p.getY(i) * j, p.getZ(i) * j);
      }
      chunk.computeVertexNormals();
    }
    this.debrisMat = new THREE.MeshStandardMaterial({
      roughness: 0.86, metalness: 0.02,
    });
    this.debris = new THREE.InstancedMesh(chunk, this.debrisMat, MAX_DEBRIS);
    this.debris.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_DEBRIS * 3), 3
    );
    this.debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debris.frustumCulled = false;
    this.debris.castShadow = true;
    this.debris.count = 0;
    scene.add(this.debris);
    this.dPos = new Float32Array(MAX_DEBRIS * 3);
    this.dVel = new Float32Array(MAX_DEBRIS * 3);
    this.dRot = new Float32Array(MAX_DEBRIS * 4);
    this.dSpin = new Float32Array(MAX_DEBRIS * 3);
    this.dScale = new Float32Array(MAX_DEBRIS * 3);   // chunks are not cubes
    this.dLife = new Float32Array(MAX_DEBRIS);
    this.dRest = new Float32Array(MAX_DEBRIS);        // 1 once it has settled
    this.dHead = 0;
    this.dAlive = 0;
    this.dHigh = 0;
    this._debrisColorDirty = false;
    this._hideAllDebris();

    /* ---- shockwave rings -------------------------------------------------- */
    this.rings = [];
    // ONE radial segment. vT is derived from the vertex radius and interpolated
    // across the quad, which is already exactly the linear ramp the profile
    // needs — extra radial rings are pure triangle cost, and with 24 rings in
    // the pool that adds up during a collapse.
    const ringGeo = new THREE.RingGeometry(0.55, 1.0, 96, 1);
    ringGeo.rotateX(-Math.PI / 2);
    this._ringGeo = ringGeo;
    for (let i = 0; i < MAX_RINGS; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: R_VERT,
        fragmentShader: R_FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uColor: { value: new THREE.Color(0xffffff) },
          uOpacity: { value: 0 },
          uRadius: { value: 1 },
          uTail: { value: 2 },
        },
      });
      const m = new THREE.Mesh(ringGeo, mat);
      m.visible = false;
      m.renderOrder = 5;
      m.frustumCulled = false;
      scene.add(m);
      this.rings.push({ mesh: m, mat, life: 0, maxLife: 1, r0: 1, r1: 2 });
    }

    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._sv = new THREE.Vector3();
    this._col = new THREE.Color();
    /** Lifetime colour targets: dust cools and greys as it settles. */
    this._settle = new THREE.Color(PALETTE.SMOKE);

    /** Camera shake accumulator, read by the camera rig. */
    this.shake = 0;
    /** Score popups drained by the HUD each frame. */
    this.popups = [];

    _active = this;
  }

  _hideAllDebris() {
    const m = new THREE.Matrix4().makeScale(0, 0, 0);
    m.setPosition(0, -9999, 0);
    for (let i = 0; i < MAX_DEBRIS; i++) this.debris.setMatrixAt(i, m);
    this.debris.instanceMatrix.needsUpdate = true;
  }

  /* ------------------------------------------------------------ emitters -- */

  /**
   * A dust plume. Signature is load-bearing — consume.js calls it positionally.
   * @param {THREE.Vector3} pos
   */
  puff(pos, hex = 0xffffff, count = 14, spread = 1.0, speed = 3.0, size = 0.5, life = 0.75) {
    this._col.setHex(hex);
    for (let i = 0; i < count; i++) {
      const k = this.pHead;
      this.pHead = (this.pHead + 1) % MAX_PARTICLES;
      if (this.pLife[k] <= 0) this.pAlive++;
      if (k + 1 > this.pHigh) this.pHigh = k + 1;

      const a = Math.random() * Math.PI * 2;
      const u = Math.random();
      const rr = Math.sqrt(u) * spread;
      this.pPos[k * 3] = pos.x + Math.cos(a) * rr;
      this.pPos[k * 3 + 1] = pos.y + Math.random() * spread * 0.5;
      this.pPos[k * 3 + 2] = pos.z + Math.sin(a) * rr;

      // Bias the launch outward-and-up, but keep a slow-moving core: a plume
      // that all moves at one speed reads as a firework.
      const s = speed * (0.18 + Math.random() * Math.random() * 1.5);
      this.pVel[k * 3] = Math.cos(a) * s;
      this.pVel[k * 3 + 1] = (0.45 + Math.random()) * s * 0.8;
      this.pVel[k * 3 + 2] = Math.sin(a) * s;

      this.pSize[k] = size * (0.5 + Math.random() * 1.1);
      this.pLife[k] = 1;
      this.pMaxLife[k] = life * (0.6 + Math.random() * 0.9);
      this.pDrag[k] = 1.4 + Math.random() * 1.6;
      this.pTurb[k] = 0.5 + Math.random() * 1.5;
      this.pSeed[k] = Math.random();

      // Birth colour is hot and bright; update() walks it toward smoke.
      const j = 0.92 + Math.random() * 0.30;
      this.pCol0[k * 3] = this._col.r * j;
      this.pCol0[k * 3 + 1] = this._col.g * j;
      this.pCol0[k * 3 + 2] = this._col.b * j;
      this.pColor[k * 3] = this.pCol0[k * 3];
      this.pColor[k * 3 + 1] = this.pCol0[k * 3 + 1];
      this.pColor[k * 3 + 2] = this.pCol0[k * 3 + 2];
    }
  }

  /** Additive specular glints — glass letting go, chrome catching the sun. */
  sparks(pos, hex = 0xffd88a, count = 5, speed = 6, spread = 0.6, size = 0.55) {
    this._col.setHex(hex);
    for (let i = 0; i < count; i++) {
      const k = this.sHead;
      this.sHead = (this.sHead + 1) % MAX_GLINTS;
      if (this.sLife[k] <= 0) this.sAlive++;
      if (k + 1 > this.sHigh) this.sHigh = k + 1;

      const a = Math.random() * Math.PI * 2;
      const rr = Math.random() * spread;
      this.sPos[k * 3] = pos.x + Math.cos(a) * rr;
      this.sPos[k * 3 + 1] = pos.y + Math.random() * spread;
      this.sPos[k * 3 + 2] = pos.z + Math.sin(a) * rr;
      const s = speed * (0.4 + Math.random());
      this.sVel[k * 3] = Math.cos(a) * s;
      this.sVel[k * 3 + 1] = (0.7 + Math.random() * 1.2) * s * 0.7;
      this.sVel[k * 3 + 2] = Math.sin(a) * s;
      this.sSize[k] = size * (0.6 + Math.random() * 0.9);
      this.sLife[k] = 1;
      this.sMaxLife[k] = 0.30 + Math.random() * 0.35;
      // Bias toward white-hot; a coloured spark reads as a firework.
      const w = 0.45 + Math.random() * 0.4;
      this.sColor[k * 3] = this._col.r * (1 - w) + w;
      this.sColor[k * 3 + 1] = this._col.g * (1 - w) + w * 0.94;
      this.sColor[k * 3 + 2] = this._col.b * (1 - w) + w * 0.80;
    }
  }

  /** Solid tumbling debris. Signature is load-bearing. */
  chunks(pos, hex = 0xcccccc, count = 8, scale = 0.5, speed = 5, spread = 1) {
    this._col.setHex(hex);
    for (let i = 0; i < count; i++) {
      const k = this.dHead;
      this.dHead = (this.dHead + 1) % MAX_DEBRIS;
      if (this.dLife[k] <= 0) this.dAlive++;
      if (k + 1 > this.dHigh) this.dHigh = k + 1;

      const a = Math.random() * Math.PI * 2;
      const rr = Math.random() * spread;
      this.dPos[k * 3] = pos.x + Math.cos(a) * rr;
      this.dPos[k * 3 + 1] = pos.y + Math.random() * spread;
      this.dPos[k * 3 + 2] = pos.z + Math.sin(a) * rr;
      const s = speed * (0.4 + Math.random());
      this.dVel[k * 3] = Math.cos(a) * s;
      this.dVel[k * 3 + 1] = (0.8 + Math.random() * 1.4) * s * 0.6;
      this.dVel[k * 3 + 2] = Math.sin(a) * s;

      // Random unit quaternion, so chunks do not all start axis-aligned.
      const u1 = Math.random(), u2 = Math.random() * Math.PI * 2, u3 = Math.random() * Math.PI * 2;
      const r1 = Math.sqrt(1 - u1), r2 = Math.sqrt(u1);
      this.dRot[k * 4] = r1 * Math.sin(u2);
      this.dRot[k * 4 + 1] = r1 * Math.cos(u2);
      this.dRot[k * 4 + 2] = r2 * Math.sin(u3);
      this.dRot[k * 4 + 3] = r2 * Math.cos(u3);

      this.dSpin[k * 3] = (Math.random() - 0.5) * 16;
      this.dSpin[k * 3 + 1] = (Math.random() - 0.5) * 16;
      this.dSpin[k * 3 + 2] = (Math.random() - 0.5) * 16;

      // Slabs and shards, not sugar cubes. Capped: consume.js sizes debris from
      // the eaten object's radius, and an unclamped tower produces nine-metre
      // blocks that read as broken geometry rather than as rubble.
      const base = Math.min(3.4, scale * (0.45 + Math.random() * 1.05));
      this.dScale[k * 3] = base * (0.7 + Math.random() * 0.9);
      this.dScale[k * 3 + 1] = base * (0.35 + Math.random() * 0.7);
      this.dScale[k * 3 + 2] = base * (0.7 + Math.random() * 0.9);

      // Long enough to actually reach the ground. A tower sheds debris from
      // 40 m up; a flat 2 s life fades it out still airborne, which is exactly
      // the "objects disappearing without falling in" review failure.
      this.dLife[k] = 1.3 + Math.random() * 0.9
        + Math.sqrt(Math.max(0, this.dPos[k * 3 + 1]) / 11);
      this.dRest[k] = 0;
      const j = 0.82 + Math.random() * 0.36;
      this.debris.instanceColor.setXYZ(k, this._col.r * j, this._col.g * j, this._col.b * j);
      this._debrisColorDirty = true;
    }

    // Anything hard enough to throw chunks also throws a couple of glints. The
    // brighter the material the more it sparkles, which is what picks glass and
    // chrome out of a masonry collapse without the caller having to say so.
    const lum = this._col.r * 0.3 + this._col.g * 0.6 + this._col.b * 0.1;
    const n = Math.min(8, Math.round(count * 0.45 * Math.min(1.4, 0.35 + lum)));
    if (n > 0) this.sparks(pos, hex, n, speed * 1.25, spread * 0.7, 0.35 + scale * 0.5);
  }

  /** Expanding ground ring. Signature is load-bearing. */
  shockwave(pos, r0, r1, hex = 0xffffff, life = 0.5) {
    for (const R of this.rings) {
      if (R.life > 0) continue;
      R.life = life; R.maxLife = life; R.r0 = r0; R.r1 = r1;
      R.mesh.position.set(pos.x, 0.07, pos.z);
      R.mat.uniforms.uColor.value.setHex(hex);
      // Tail scales with how far the ring is going to travel.
      R.mat.uniforms.uTail.value = Math.max(0.6, (r1 - r0) * 0.28);
      R.mesh.visible = true;
      return;
    }
  }

  popup(pos, text, hex = 0xffffff, big = false) {
    this.popups.push({ pos: pos.clone(), text, hex, big, t: 0 });
  }

  addShake(amount) { this.shake = Math.min(1.6, this.shake + amount); }

  /* -------------------------------------------------------------- update -- */

  update(dt) {
    this.time += dt;
    const t = this.time;

    /* ---- dust ----------------------------------------------------------- */
    if (this.pAlive > 0) {
      let alive = 0, high = 0;
      for (let i = 0; i < this.pHigh; i++) {
        if (this.pLife[i] <= 0) continue;
        const ml = this.pMaxLife[i] || 1;
        this.pLife[i] -= dt / ml;
        if (this.pLife[i] <= 0) { this.pLife[i] = 0; this.pSize[i] = 0; continue; }
        alive++; high = i + 1;

        const i3 = i * 3;
        const x = this.pPos[i3], y = this.pPos[i3 + 1], z = this.pPos[i3 + 2];

        // Turbulence: a cheap divergence-light sin field. Real curl noise is
        // three noise gradients per axis per particle; this is four sines for
        // the whole thing and at plume scale nobody can tell the difference.
        const tb = this.pTurb[i];
        const fx = Math.sin(z * 0.55 + t * 2.1) * Math.cos(y * 0.9 - t * 1.3);
        const fz = Math.sin(x * 0.55 - t * 1.9) * Math.cos(y * 0.9 + t * 1.1);
        const fy = Math.sin((x + z) * 0.35 + t * 1.5) * 0.5;

        const drag = Math.exp(-this.pDrag[i] * dt);
        this.pVel[i3] = (this.pVel[i3] + fx * tb * 2.4 * dt) * drag;
        // Light dust is buoyant once it has slowed; heavy grit is not. Scaling
        // gravity by the particle's own drag gives that for free.
        this.pVel[i3 + 1] = (this.pVel[i3 + 1] + fy * tb * 1.4 * dt) * drag - (5.6 - tb * 1.6) * dt;
        this.pVel[i3 + 2] = (this.pVel[i3 + 2] + fz * tb * 2.4 * dt) * drag;

        this.pPos[i3] = x + this.pVel[i3] * dt;
        this.pPos[i3 + 1] = y + this.pVel[i3 + 1] * dt;
        this.pPos[i3 + 2] = z + this.pVel[i3 + 2] * dt;

        // Lifetime colour: hot bright dust cooling toward settled smoke.
        const k = 1 - this.pLife[i];
        const m = k * k;
        this.pColor[i3] = this.pCol0[i3] + (this._settle.r - this.pCol0[i3]) * m;
        this.pColor[i3 + 1] = this.pCol0[i3 + 1] + (this._settle.g - this.pCol0[i3 + 1]) * m;
        this.pColor[i3 + 2] = this.pCol0[i3 + 2] + (this._settle.b - this.pCol0[i3 + 2]) * m;
      }
      this.pAlive = alive;
      this.pHigh = high;
      this.pGeo.setDrawRange(0, high);
      // Upload only the slice that is actually in play. A ring buffer of 3,000
      // particles is 36 kB of position alone; re-sending all of it because two
      // sparks are alive is the single most expensive thing this class can do.
      markRange(this.pGeo.attributes.position, high, 3);
      markRange(this.pGeo.attributes.aLife, high, 1);
      markRange(this.pGeo.attributes.aSize, high, 1);
      markRange(this.pGeo.attributes.aColor, high, 3);
      markRange(this.pGeo.attributes.aSeed, high, 1);
    } else if (this.pHigh !== 0) {
      this.pHigh = 0;
      this.pGeo.setDrawRange(0, 0);
    }

    /* ---- glints --------------------------------------------------------- */
    if (this.sAlive > 0) {
      let alive = 0, high = 0;
      for (let i = 0; i < this.sHigh; i++) {
        if (this.sLife[i] <= 0) continue;
        const ml = this.sMaxLife[i] || 1;
        this.sLife[i] -= dt / ml;
        if (this.sLife[i] <= 0) { this.sLife[i] = 0; this.sSize[i] = 0; continue; }
        alive++; high = i + 1;
        const i3 = i * 3;
        this.sVel[i3 + 1] -= 16 * dt;
        this.sPos[i3] += this.sVel[i3] * dt;
        this.sPos[i3 + 1] += this.sVel[i3 + 1] * dt;
        this.sPos[i3 + 2] += this.sVel[i3 + 2] * dt;
      }
      this.sAlive = alive;
      this.sHigh = high;
      this.sGeo.setDrawRange(0, high);
      markRange(this.sGeo.attributes.position, high, 3);
      markRange(this.sGeo.attributes.aLife, high, 1);
      markRange(this.sGeo.attributes.aSize, high, 1);
      markRange(this.sGeo.attributes.aColor, high, 3);
    } else if (this.sHigh !== 0) {
      this.sHigh = 0;
      this.sGeo.setDrawRange(0, 0);
    }

    /* ---- debris --------------------------------------------------------- */
    if (this.dAlive > 0) {
      let alive = 0, high = 0;
      for (let i = 0; i < this.dHigh; i++) {
        if (this.dLife[i] <= 0) continue;
        alive++; high = i + 1;
        this.dLife[i] -= dt;
        const i3 = i * 3, i4 = i * 4;

        if (this.dRest[i] < 1) {
          this.dVel[i3 + 1] -= 24 * dt;
          this.dPos[i3] += this.dVel[i3] * dt;
          this.dPos[i3 + 1] += this.dVel[i3 + 1] * dt;
          this.dPos[i3 + 2] += this.dVel[i3 + 2] * dt;

          const floor = this.dScale[i3 + 1] * 0.5;
          if (this.dPos[i3 + 1] < floor) {
            this.dPos[i3 + 1] = floor;
            this.dVel[i3 + 1] *= -0.28;
            this.dVel[i3] *= 0.55;
            this.dVel[i3 + 2] *= 0.55;
            this.dSpin[i3] *= 0.42;
            this.dSpin[i3 + 1] *= 0.62;
            this.dSpin[i3 + 2] *= 0.42;
            // Settle: below a threshold it stops bouncing and lies flat. Debris
            // that jitters forever on the pavement is the tell of a fake sim.
            const vx = this.dVel[i3], vz = this.dVel[i3 + 2];
            const e = Math.abs(this.dVel[i3 + 1]) + Math.sqrt(vx * vx + vz * vz);
            if (e < 1.2) {
              this.dRest[i] = 1;
              this.dVel[i3] = this.dVel[i3 + 1] = this.dVel[i3 + 2] = 0;
              this.dSpin[i3] = this.dSpin[i3 + 1] = this.dSpin[i3 + 2] = 0;
            }
          }

          // Integrate spin directly on the quaternion: q += 0.5 * w * q.
          // Allocating an Euler and a Quaternion per chunk per frame was 900
          // objects a frame straight into the nursery.
          const qx = this.dRot[i4], qy = this.dRot[i4 + 1], qz = this.dRot[i4 + 2], qw = this.dRot[i4 + 3];
          const wx = this.dSpin[i3] * dt * 0.5, wy = this.dSpin[i3 + 1] * dt * 0.5, wz = this.dSpin[i3 + 2] * dt * 0.5;
          let nx = qx + (wx * qw + wy * qz - wz * qy);
          let ny = qy + (wy * qw + wz * qx - wx * qz);
          let nz = qz + (wz * qw + wx * qy - wy * qx);
          let nw = qw - (wx * qx + wy * qy + wz * qz);
          const inv = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw) || 1);
          this.dRot[i4] = nx * inv; this.dRot[i4 + 1] = ny * inv;
          this.dRot[i4 + 2] = nz * inv; this.dRot[i4 + 3] = nw * inv;
        }

        const fade = Math.min(1, this.dLife[i] / 0.4);
        this._q.set(this.dRot[i4], this.dRot[i4 + 1], this.dRot[i4 + 2], this.dRot[i4 + 3]);
        this._v.set(this.dPos[i3], this.dPos[i3 + 1], this.dPos[i3 + 2]);
        this._sv.set(this.dScale[i3] * fade, this.dScale[i3 + 1] * fade, this.dScale[i3 + 2] * fade);
        this._m4.compose(this._v, this._q, this._sv);
        this.debris.setMatrixAt(i, this._m4);

        if (this.dLife[i] <= 0) {
          this.dLife[i] = 0;
          this._m4.makeScale(0, 0, 0); this._m4.setPosition(0, -9999, 0);
          this.debris.setMatrixAt(i, this._m4);
          alive--;
        }
      }
      this.dAlive = alive;
      this.dHigh = high;
      this.debris.count = high;
      markRange(this.debris.instanceMatrix, high, 16);
      if (this._debrisColorDirty) {
        markRange(this.debris.instanceColor, high, 3);
        this._debrisColorDirty = false;
      }
    } else if (this.debris.count !== 0) {
      this.dHigh = 0;
      this.debris.count = 0;
    }

    /* ---- rings ----------------------------------------------------------- */
    for (const R of this.rings) {
      if (R.life <= 0) continue;
      R.life -= dt;
      const k = 1 - Math.max(0, R.life) / R.maxLife;
      // Fast out, hard stop: a shockwave decelerates, it does not coast.
      const e = 1 - Math.pow(1 - k, 3.2);
      const r = R.r0 + (R.r1 - R.r0) * e;
      R.mesh.scale.set(r, 1, r);
      R.mat.uniforms.uRadius.value = r;
      R.mat.uniforms.uOpacity.value = Math.pow(1 - k, 1.5) * 0.75;
      if (R.life <= 0) { R.mesh.visible = false; R.mat.uniforms.uOpacity.value = 0; }
    }

    this.shake *= Math.exp(-5.5 * dt);
    for (let i = this.popups.length - 1; i >= 0; i--) {
      this.popups[i].t += dt;
      if (this.popups[i].t > 1.25) this.popups.splice(i, 1);
    }
  }
}
