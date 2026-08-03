/**
 * The Hole — player, bot and remote-peer avatar.
 *
 * Visually a hole is three pieces:
 *   1. the ground cut (handled globally in render/groundShader.js)
 *   2. a pit interior: an inside-out cone whose walls fall away into darkness
 *   3. a coloured lip ring that identifies the owner
 *
 * Gameplay-wise it is a position, a radius derived from score, and a speed that
 * decays as it grows so early-game feels nimble and late-game feels titanic.
 */

import * as THREE from 'three';
import { HOLE, WORLD, PALETTE } from '../config.js';

const PIT_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vLocal;
  void main() {
    vUv = uv;
    vLocal = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const PIT_FRAG = /* glsl */ `
  uniform vec3  uRim;
  uniform vec3  uDeep;
  uniform vec3  uTint;
  uniform float uTime;
  varying vec2 vUv;
  varying vec3 vLocal;

  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
  float noise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f*f*(3.0-2.0*f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), u.x),
               mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
  }

  void main() {
    // vUv.y: 1 at the lip, 0 at the bottom of the cone.
    float depth = clamp(vUv.y, 0.0, 1.0);

    // Spiral striations drifting downward — reads as motion/suction.
    float spiral = noise(vec2(vUv.x * 26.0 + depth * 5.0, depth * 7.0 - uTime * 0.55));
    float bands  = 0.5 + 0.5 * sin(vUv.x * 50.2831 + depth * 12.0 - uTime * 1.7);

    vec3 col = mix(uDeep, uRim, pow(depth, 2.1));
    col = mix(col, col * 1.55, spiral * 0.22 * depth);
    col += uTint * bands * 0.05 * depth * depth;

    // Hot lip: a thin bright kiss of light right at the opening.
    float lip = smoothstep(0.86, 1.0, depth);
    col = mix(col, uTint * 0.55 + vec3(0.05), lip * 0.55);

    // Fade the very bottom to pure void.
    col *= smoothstep(-0.05, 0.30, depth);

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

let _holeId = 1;

export class Hole {
  /**
   * @param {object} o
   * @param {'player'|'bot'|'remote'} o.type
   * @param {string} o.name
   * @param {number} o.color hex
   */
  constructor(o = {}) {
    this.id = o.id ?? _holeId++;
    this.type = o.type || 'bot';
    this.isPlayer = this.type === 'player';
    this.name = o.name || 'Hole';
    this.color = new THREE.Color(o.color ?? PALETTE.ACCENT_HOT);

    this.position = new THREE.Vector3(o.x ?? 0, 0, o.z ?? 0);
    this.velocity = new THREE.Vector3();
    this.desiredDir = new THREE.Vector2();

    this.score = 0;
    this.radius = HOLE.START_RADIUS;
    this.alive = true;
    this.respawnAt = 0;
    this.eatCount = 0;
    /** Set for one frame when the hole swallows something — drives feedback. */
    this.chompImpulse = 0;
    /** Squash-and-stretch state so growth has weight. */
    this.pulse = 0;
    this.displayRadius = this.radius;
    /** Kill-feed / HUD. */
    this.lastMeal = null;
    this.killedBy = null;

    this.group = new THREE.Group();
    this.group.name = `hole-${this.id}`;
    this._buildVisual();
    this.syncVisual();
  }

  _buildVisual() {
    // --- pit interior: inside-out truncated cone -------------------------
    const depth = HOLE.PIT_DEPTH_F;
    const geo = new THREE.CylinderGeometry(1.075, 0.30, depth, 72, 6, true);
    geo.translate(0, -depth / 2, 0);

    this.pitMaterial = new THREE.ShaderMaterial({
      vertexShader: PIT_VERT,
      fragmentShader: PIT_FRAG,
      side: THREE.BackSide,
      uniforms: {
        uRim: { value: new THREE.Color(PALETTE.HOLE_RIM) },
        uDeep: { value: new THREE.Color(PALETTE.HOLE_VOID) },
        uTint: { value: this.color.clone() },
        uTime: { value: 0 },
      },
    });
    this.pit = new THREE.Mesh(geo, this.pitMaterial);
    this.pit.frustumCulled = false;
    this.pit.renderOrder = -2;
    this.group.add(this.pit);

    // --- bottom plug so we never see sky through the cone tip ------------
    const capGeo = new THREE.CircleGeometry(0.32, 40);
    capGeo.rotateX(Math.PI / 2);
    capGeo.translate(0, -depth + 0.02, 0);
    this.cap = new THREE.Mesh(
      capGeo,
      new THREE.MeshBasicMaterial({ color: 0x000000 })
    );
    this.cap.frustumCulled = false;
    this.cap.renderOrder = -3;
    this.group.add(this.cap);

    // --- owner lip ring ---------------------------------------------------
    const ringGeo = new THREE.RingGeometry(1.0, 1.085, 84, 1);
    ringGeo.rotateX(-Math.PI / 2);
    this.ringMaterial = new THREE.MeshBasicMaterial({
      color: this.color,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.ring = new THREE.Mesh(ringGeo, this.ringMaterial);
    this.ring.position.y = 0.045;
    this.ring.renderOrder = 4;
    this.ring.frustumCulled = false;
    this.group.add(this.ring);
  }

  /** Score -> radius curve. */
  static radiusFor(score) {
    return Math.min(
      HOLE.MAX_RADIUS,
      HOLE.START_RADIUS * Math.pow(1 + score / HOLE.GROWTH_K, HOLE.GROWTH_P)
    );
  }

  get speed() {
    return HOLE.BASE_SPEED * Math.pow(this.radius / HOLE.START_RADIUS, -HOLE.SPEED_P) *
           (this.radius / HOLE.START_RADIUS) ** 0.62;
  }

  addScore(n, label) {
    this.score += n;
    const prev = this.radius;
    this.radius = Hole.radiusFor(this.score);
    this.eatCount++;
    if (label) this.lastMeal = label;
    // Bigger relative jumps produce a bigger visual burp.
    this.pulse = Math.min(1.0, this.pulse + 0.35 + (this.radius - prev) * 1.2);
    this.chompImpulse = Math.min(1, this.chompImpulse + 0.4);
    return this.radius - prev;
  }

  reset(x, z, score = 0) {
    this.position.set(x, 0, z);
    this.velocity.set(0, 0, 0);
    this.score = score;
    this.radius = Hole.radiusFor(score);
    this.displayRadius = this.radius;
    this.alive = true;
    this.killedBy = null;
    this.syncVisual();
  }

  /** @param {number} dt seconds */
  update(dt, t) {
    if (!this.alive) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;

    // --- movement --------------------------------------------------------
    const spd = this.speed;
    const targetVX = this.desiredDir.x * spd;
    const targetVZ = this.desiredDir.y * spd;
    const k = 1 - Math.exp(-HOLE.ACCEL * dt);
    this.velocity.x += (targetVX - this.velocity.x) * k;
    this.velocity.z += (targetVZ - this.velocity.z) * k;

    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;

    // --- bounds ----------------------------------------------------------
    const lim = WORLD.SIZE - this.radius * 0.35;
    if (this.position.x > WORLD.BAY_EDGE - this.radius * 0.2) {
      this.position.x = WORLD.BAY_EDGE - this.radius * 0.2;
      this.velocity.x *= 0.2;
    }
    if (this.position.x < -lim) { this.position.x = -lim; this.velocity.x *= 0.2; }
    if (this.position.z > lim) { this.position.z = lim; this.velocity.z *= 0.2; }
    if (this.position.z < -lim) { this.position.z = -lim; this.velocity.z *= 0.2; }

    // --- feedback decay ---------------------------------------------------
    this.pulse *= Math.exp(-6.5 * dt);
    this.chompImpulse *= Math.exp(-9.0 * dt);

    // Display radius eases toward true radius with an overshoot so each meal
    // gives a springy "gulp".
    const springK = 1 - Math.exp(-9.0 * dt);
    this.displayRadius += (this.radius - this.displayRadius) * springK;

    this.pitMaterial.uniforms.uTime.value = t;
    this.syncVisual(t);
  }

  syncVisual(t = 0) {
    const r = this.displayRadius;
    const gulp = 1 + this.pulse * 0.075;
    this.group.position.set(this.position.x, 0, this.position.z);
    this.pit.scale.set(r * gulp, r * (1 + this.pulse * 0.16), r * gulp);
    this.cap.scale.set(r, r, r);
    this.ring.scale.set(r * gulp, 1, r * gulp);
    this.ringMaterial.opacity = 0.55 + 0.4 * (0.5 + 0.5 * Math.sin(t * 2.2 + this.id));
  }

  dispose() {
    this.pit.geometry.dispose();
    this.pitMaterial.dispose();
    this.cap.geometry.dispose();
    this.cap.material.dispose();
    this.ring.geometry.dispose();
    this.ringMaterial.dispose();
  }
}
