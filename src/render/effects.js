/**
 * Particle + impulse feedback: dust puffs, debris chunks, ring shockwaves and
 * floating score numbers. One pooled Points cloud for sparks/dust, one pooled
 * InstancedMesh for solid debris, one pooled ring pool for shockwaves.
 */

import * as THREE from 'three';

const MAX_PARTICLES = 3000;
const MAX_DEBRIS = 900;
const MAX_RINGS = 24;

const P_VERT = /* glsl */ `
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

const P_FRAG = /* glsl */ `
  varying float vLife;
  varying vec3  vColor;
  void main() {
    if (vLife <= 0.0) discard;
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    float soft = 1.0 - smoothstep(0.06, 0.25, r2);
    float a = soft * clamp(vLife, 0.0, 1.0);
    gl_FragColor = vec4(vColor, a);
    #include <colorspace_fragment>
  }
`;

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.time = 0;

    // ---- soft particles (dust, sparks) ---------------------------------
    const g = new THREE.BufferGeometry();
    this.pPos = new Float32Array(MAX_PARTICLES * 3);
    this.pVel = new Float32Array(MAX_PARTICLES * 3);
    this.pSize = new Float32Array(MAX_PARTICLES);
    this.pLife = new Float32Array(MAX_PARTICLES);
    this.pMaxLife = new Float32Array(MAX_PARTICLES);
    this.pColor = new Float32Array(MAX_PARTICLES * 3);
    this.pDrag = new Float32Array(MAX_PARTICLES);
    g.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.pSize, 1));
    g.setAttribute('aLife', new THREE.BufferAttribute(this.pLife, 1));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.pColor, 3));
    g.setDrawRange(0, MAX_PARTICLES);
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

    // ---- solid debris chunks -------------------------------------------
    const chunk = new THREE.BoxGeometry(1, 1, 1);
    // Bevel the cube slightly by scaling a second, rotated copy is overkill;
    // a plain cube reads fine at debris scale.
    this.debrisMat = new THREE.MeshStandardMaterial({
      roughness: 0.8, metalness: 0.02, vertexColors: false,
    });
    this.debris = new THREE.InstancedMesh(chunk, this.debrisMat, MAX_DEBRIS);
    this.debris.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_DEBRIS * 3), 3
    );
    this.debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debris.frustumCulled = false;
    this.debris.castShadow = true;
    this.debris.count = MAX_DEBRIS;
    scene.add(this.debris);
    this.dPos = new Float32Array(MAX_DEBRIS * 3);
    this.dVel = new Float32Array(MAX_DEBRIS * 3);
    this.dRot = new Float32Array(MAX_DEBRIS * 4);
    this.dSpin = new Float32Array(MAX_DEBRIS * 3);
    this.dScale = new Float32Array(MAX_DEBRIS);
    this.dLife = new Float32Array(MAX_DEBRIS);
    this.dHead = 0;
    this._hideAllDebris();

    // ---- shockwave rings -------------------------------------------------
    this.rings = [];
    const ringGeo = new THREE.RingGeometry(0.72, 1.0, 64, 1);
    ringGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < MAX_RINGS; i++) {
      const m = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({
          color: 0xffffff, transparent: true, opacity: 0,
          depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
        })
      );
      m.visible = false;
      m.renderOrder = 5;
      m.frustumCulled = false;
      scene.add(m);
      this.rings.push({ mesh: m, life: 0, maxLife: 1, r0: 1, r1: 2 });
    }

    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._sv = new THREE.Vector3();
    this._col = new THREE.Color();

    /** Camera shake accumulator, read by the camera rig. */
    this.shake = 0;
    /** Score popups drained by the HUD each frame. */
    this.popups = [];
  }

  _hideAllDebris() {
    const m = new THREE.Matrix4().makeScale(0, 0, 0);
    m.setPosition(0, -9999, 0);
    for (let i = 0; i < MAX_DEBRIS; i++) this.debris.setMatrixAt(i, m);
    this.debris.instanceMatrix.needsUpdate = true;
  }

  /** @param {THREE.Vector3} pos */
  puff(pos, hex = 0xffffff, count = 14, spread = 1.0, speed = 3.0, size = 0.5, life = 0.75) {
    this._col.setHex(hex);
    for (let i = 0; i < count; i++) {
      const k = this.pHead;
      this.pHead = (this.pHead + 1) % MAX_PARTICLES;
      const a = Math.random() * Math.PI * 2;
      const u = Math.random();
      const rr = Math.sqrt(u) * spread;
      this.pPos[k * 3] = pos.x + Math.cos(a) * rr;
      this.pPos[k * 3 + 1] = pos.y + Math.random() * spread * 0.5;
      this.pPos[k * 3 + 2] = pos.z + Math.sin(a) * rr;
      const s = speed * (0.35 + Math.random() * 0.9);
      this.pVel[k * 3] = Math.cos(a) * s;
      this.pVel[k * 3 + 1] = (0.5 + Math.random()) * s * 0.75;
      this.pVel[k * 3 + 2] = Math.sin(a) * s;
      this.pSize[k] = size * (0.6 + Math.random() * 0.9);
      const l = life * (0.7 + Math.random() * 0.7);
      this.pLife[k] = 1;
      this.pMaxLife[k] = l;
      this.pDrag[k] = 1.6 + Math.random() * 1.4;
      const j = 0.88 + Math.random() * 0.24;
      this.pColor[k * 3] = this._col.r * j;
      this.pColor[k * 3 + 1] = this._col.g * j;
      this.pColor[k * 3 + 2] = this._col.b * j;
    }
  }

  chunks(pos, hex = 0xcccccc, count = 8, scale = 0.5, speed = 5, spread = 1) {
    this._col.setHex(hex);
    for (let i = 0; i < count; i++) {
      const k = this.dHead;
      this.dHead = (this.dHead + 1) % MAX_DEBRIS;
      const a = Math.random() * Math.PI * 2;
      const rr = Math.random() * spread;
      this.dPos[k * 3] = pos.x + Math.cos(a) * rr;
      this.dPos[k * 3 + 1] = pos.y + Math.random() * spread;
      this.dPos[k * 3 + 2] = pos.z + Math.sin(a) * rr;
      const s = speed * (0.4 + Math.random());
      this.dVel[k * 3] = Math.cos(a) * s;
      this.dVel[k * 3 + 1] = (0.8 + Math.random() * 1.4) * s * 0.6;
      this.dVel[k * 3 + 2] = Math.sin(a) * s;
      this.dRot[k * 4] = 0; this.dRot[k * 4 + 1] = 0;
      this.dRot[k * 4 + 2] = 0; this.dRot[k * 4 + 3] = 1;
      this.dSpin[k * 3] = (Math.random() - 0.5) * 14;
      this.dSpin[k * 3 + 1] = (Math.random() - 0.5) * 14;
      this.dSpin[k * 3 + 2] = (Math.random() - 0.5) * 14;
      this.dScale[k] = scale * (0.45 + Math.random() * 1.1);
      this.dLife[k] = 1.1 + Math.random() * 0.7;
      const j = 0.85 + Math.random() * 0.3;
      this.debris.instanceColor.setXYZ(
        k, (this._col.r * j) ** 1.0, (this._col.g * j) ** 1.0, (this._col.b * j) ** 1.0
      );
    }
  }

  shockwave(pos, r0, r1, hex = 0xffffff, life = 0.5) {
    for (const R of this.rings) {
      if (R.life > 0) continue;
      R.life = life; R.maxLife = life; R.r0 = r0; R.r1 = r1;
      R.mesh.position.set(pos.x, 0.06, pos.z);
      R.mesh.material.color.setHex(hex);
      R.mesh.visible = true;
      return;
    }
  }

  popup(pos, text, hex = 0xffffff, big = false) {
    this.popups.push({ pos: pos.clone(), text, hex, big, t: 0 });
  }

  addShake(amount) { this.shake = Math.min(1.6, this.shake + amount); }

  update(dt) {
    this.time += dt;
    // particles
    let anyAlive = false;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.pLife[i] <= 0) continue;
      anyAlive = true;
      const ml = this.pMaxLife[i] || 1;
      this.pLife[i] -= dt / ml;
      if (this.pLife[i] <= 0) { this.pLife[i] = 0; this.pSize[i] = 0; continue; }
      const drag = Math.exp(-this.pDrag[i] * dt);
      this.pVel[i * 3] *= drag;
      this.pVel[i * 3 + 1] = this.pVel[i * 3 + 1] * drag - 5.2 * dt;
      this.pVel[i * 3 + 2] *= drag;
      this.pPos[i * 3] += this.pVel[i * 3] * dt;
      this.pPos[i * 3 + 1] += this.pVel[i * 3 + 1] * dt;
      this.pPos[i * 3 + 2] += this.pVel[i * 3 + 2] * dt;
    }
    this.pGeo.attributes.position.needsUpdate = true;
    this.pGeo.attributes.aLife.needsUpdate = true;
    this.pGeo.attributes.aSize.needsUpdate = true;
    this.pGeo.attributes.aColor.needsUpdate = true;

    // debris
    let debrisDirty = false;
    for (let i = 0; i < MAX_DEBRIS; i++) {
      if (this.dLife[i] <= 0) continue;
      debrisDirty = true;
      this.dLife[i] -= dt;
      this.dVel[i * 3 + 1] -= 22 * dt;
      this.dPos[i * 3] += this.dVel[i * 3] * dt;
      this.dPos[i * 3 + 1] += this.dVel[i * 3 + 1] * dt;
      this.dPos[i * 3 + 2] += this.dVel[i * 3 + 2] * dt;
      if (this.dPos[i * 3 + 1] < 0.06) {
        this.dPos[i * 3 + 1] = 0.06;
        this.dVel[i * 3 + 1] *= -0.34;
        this.dVel[i * 3] *= 0.62;
        this.dVel[i * 3 + 2] *= 0.62;
        this.dSpin[i * 3] *= 0.5; this.dSpin[i * 3 + 2] *= 0.5;
      }
      this._q.set(this.dRot[i * 4], this.dRot[i * 4 + 1], this.dRot[i * 4 + 2], this.dRot[i * 4 + 3]);
      const tq = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(this.dSpin[i * 3] * dt, this.dSpin[i * 3 + 1] * dt, this.dSpin[i * 3 + 2] * dt)
      );
      this._q.multiply(tq).normalize();
      this.dRot[i * 4] = this._q.x; this.dRot[i * 4 + 1] = this._q.y;
      this.dRot[i * 4 + 2] = this._q.z; this.dRot[i * 4 + 3] = this._q.w;

      const fade = Math.min(1, this.dLife[i] / 0.35);
      const sc = this.dScale[i] * fade;
      this._v.set(this.dPos[i * 3], this.dPos[i * 3 + 1], this.dPos[i * 3 + 2]);
      this._sv.set(sc, sc, sc);
      this._m4.compose(this._v, this._q, this._sv);
      this.debris.setMatrixAt(i, this._m4);
      if (this.dLife[i] <= 0) {
        this._m4.makeScale(0, 0, 0); this._m4.setPosition(0, -9999, 0);
        this.debris.setMatrixAt(i, this._m4);
      }
    }
    if (debrisDirty) {
      this.debris.instanceMatrix.needsUpdate = true;
      this.debris.instanceColor.needsUpdate = true;
    }

    // rings
    for (const R of this.rings) {
      if (R.life <= 0) continue;
      R.life -= dt;
      const t = 1 - Math.max(0, R.life) / R.maxLife;
      const e = 1 - Math.pow(1 - t, 3);
      const r = R.r0 + (R.r1 - R.r0) * e;
      R.mesh.scale.set(r, 1, r);
      R.mesh.material.opacity = (1 - t) * 0.55;
      if (R.life <= 0) { R.mesh.visible = false; R.mesh.material.opacity = 0; }
    }

    this.shake *= Math.exp(-5.5 * dt);
    for (let i = this.popups.length - 1; i >= 0; i--) {
      this.popups[i].t += dt;
      if (this.popups[i].t > 1.25) this.popups.splice(i, 1);
    }
  }
}
