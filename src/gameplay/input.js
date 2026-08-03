/**
 * Input: WASD/arrows, pointer-steer, touch stick and gamepad, resolved into a
 * single normalised direction in WORLD XZ.
 *
 * THREE THINGS THIS FILE EXISTS TO GET RIGHT
 * ------------------------------------------
 * 1. POINTER STEER MUST NOT FIGHT THE CAMERA. The camera looks down at 54
 *    degrees, so a screen offset is not a ground offset: the same number of
 *    pixels up-screen is 1/sin(pitch) times further across the ground than the
 *    same number of pixels sideways. Steering with the raw screen vector makes
 *    the hole veer off the cursor on every diagonal — it felt like the game was
 *    disagreeing with you. So the screen vector is aspect-corrected, then
 *    un-foreshortened by the pitch, and only then rotated by the camera yaw.
 *
 * 2. OPPOSING KEYS MUST NOT CANCEL. Holding A and tapping D used to sum to
 *    zero and stop the hole dead mid-turn. Each axis resolves to the most
 *    RECENTLY pressed of its two keys, which is what makes a reversal read as
 *    instant instead of as a stall.
 *
 * 3. SHORT INPUTS MUST SURVIVE A SLOW FRAME. At 25 fps a 30 ms tap can land
 *    entirely between two update() calls. Presses are latched for a minimum
 *    hold, and a fresh direction is held briefly against being overwritten —
 *    a small buffer, not auto-pilot.
 */

import * as THREE from 'three';
import { CAMERA } from '../config.js';

/** Minimum time (s) a key press is honoured, however briefly it was held. */
const TAP_LATCH = 0.09;
/** How long (s) a just-changed direction resists being softened. */
const TURN_BUFFER = 0.07;

/** Radial deadzone and full-throw point for each analog source. */
const GAMEPAD_DEAD = 0.22;
const TOUCH_DEAD_PX = 7;
const TOUCH_THROW_PX = 62;
const POINTER_DEAD = 0.10;
const POINTER_THROW = 0.42;

const KEY_LEFT = ['KeyA', 'ArrowLeft'];
const KEY_RIGHT = ['KeyD', 'ArrowRight'];
const KEY_UP = ['KeyW', 'ArrowUp'];
const KEY_DOWN = ['KeyS', 'ArrowDown'];

export class Input {
  constructor(domElement) {
    this.el = domElement;
    this.keys = new Set();
    /** code -> seconds-of-life remaining on the tap latch. */
    this._latch = new Map();
    /** Monotonic press counter, so "most recent key on this axis" is cheap. */
    this._seq = new Map();
    this._seqN = 0;

    this.dir = new THREE.Vector2();      // raw, camera/screen space
    this.worldDir = new THREE.Vector2(); // rotated into world space
    this._smooth = new THREE.Vector2();  // analog low-pass (never used for keys)
    this.pointerActive = false;
    this.pointerVec = new THREE.Vector2();
    this.touchId = null;
    this.touchOrigin = new THREE.Vector2();
    this.touchNow = new THREE.Vector2();
    /** 'keys' | 'pointer' | 'touch' | 'gamepad' — most recent source wins. */
    this.mode = 'keys';
    this.gamepadIndex = -1;

    this._turnHold = 0;
    this._last = performance.now();

    // Without this a drag on a phone scrolls the page instead of steering.
    if (domElement && domElement.style) domElement.style.touchAction = 'none';

    const kd = (e) => {
      if (e.repeat) return;
      if (!this.keys.has(e.code)) {
        this.keys.add(e.code);
        this._seq.set(e.code, ++this._seqN);
        this._latch.set(e.code, TAP_LATCH);
      }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        e.preventDefault();
      }
      this.mode = 'keys';
    };
    const ku = (e) => this.keys.delete(e.code);
    // Losing focus mid-hold used to leave the hole driving into the bay.
    const blur = () => { this.keys.clear(); this._latch.clear(); this.pointerActive = false; this.touchId = null; };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('blur', blur);

    const pd = (e) => {
      if (e.pointerType === 'touch') {
        if (this.touchId !== null) return;
        this.touchId = e.pointerId;
        this.touchOrigin.set(e.clientX, e.clientY);
        this.touchNow.copy(this.touchOrigin);
        this.mode = 'touch';
      } else {
        this.pointerActive = true;
        this._setPointer(e);
        this.mode = 'pointer';
      }
    };
    const pm = (e) => {
      if (e.pointerType === 'touch') {
        if (e.pointerId !== this.touchId) return;
        this.touchNow.set(e.clientX, e.clientY);
      } else if (this.pointerActive) {
        this._setPointer(e);
      }
    };
    const pu = (e) => {
      if (e.pointerId === this.touchId) this.touchId = null;
      if (e.pointerType !== 'touch') this.pointerActive = false;
    };
    const ctx = (e) => e.preventDefault();
    domElement.addEventListener('pointerdown', pd);
    window.addEventListener('pointermove', pm);
    window.addEventListener('pointerup', pu);
    window.addEventListener('pointercancel', pu);
    domElement.addEventListener('contextmenu', ctx);

    const gc = (e) => { this.gamepadIndex = e.gamepad.index; this.mode = 'gamepad'; };
    const gd = () => { this.gamepadIndex = -1; };
    window.addEventListener('gamepadconnected', gc);
    window.addEventListener('gamepaddisconnected', gd);

    this._dispose = () => {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
      window.removeEventListener('blur', blur);
      domElement.removeEventListener('pointerdown', pd);
      window.removeEventListener('pointermove', pm);
      window.removeEventListener('pointerup', pu);
      window.removeEventListener('pointercancel', pu);
      domElement.removeEventListener('contextmenu', ctx);
      window.removeEventListener('gamepadconnected', gc);
      window.removeEventListener('gamepaddisconnected', gd);
    };
  }

  /**
   * Screen offset of the cursor from the centre of the frame, corrected so that
   * one unit means the same distance on the GROUND in both axes.
   */
  _setPointer(e) {
    const w = window.innerWidth || 1, h = window.innerHeight || 1;
    const ax = ((e.clientX / w) * 2 - 1) * (w / h);
    const ay = (e.clientY / h) * 2 - 1;
    // sin(pitch) is the vertical squash the ground plane picks up from a
    // top-down-ish camera; dividing it out turns screen-up into ground-forward.
    const sp = Math.max(0.25, Math.sin(THREE.MathUtils.degToRad(CAMERA.PITCH)));
    this.pointerVec.set(ax, ay / sp);
  }

  /** Axis value from the most recently pressed of two opposing key sets. */
  _axis(negCodes, posCodes) {
    let negSeq = -1, posSeq = -1;
    for (const c of negCodes) if (this._held(c)) negSeq = Math.max(negSeq, this._seq.get(c) || 0);
    for (const c of posCodes) if (this._held(c)) posSeq = Math.max(posSeq, this._seq.get(c) || 0);
    if (negSeq < 0 && posSeq < 0) return 0;
    // Last press wins outright — opposing keys must never sum to a dead stop.
    return posSeq > negSeq ? 1 : -1;
  }

  _held(code) {
    return this.keys.has(code) || (this._latch.get(code) || 0) > 0;
  }

  /** Radial deadzone with rescaling, so the first millimetre past it is gentle. */
  static _shape(x, y, dead, throwLen) {
    const len = Math.hypot(x, y);
    if (len <= dead) return null;
    const m = Math.min(1, (len - dead) / Math.max(0.0001, throwLen - dead));
    // Mild expo: precise near centre, still reaches full throw. A linear ramp
    // makes a thumbstick feel numb; anything past ~1.6 makes it feel dead.
    const shaped = m * m * 0.35 + m * 0.65;
    return { x: (x / len) * shaped, y: (y / len) * shaped };
  }

  _gamepad() {
    if (!navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    let gp = this.gamepadIndex >= 0 ? pads[this.gamepadIndex] : null;
    if (!gp || !gp.connected) {
      gp = null;
      for (const p of pads) if (p && p.connected) { gp = p; break; }
    }
    if (!gp) return null;
    let ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
    // D-pad is a legitimate way to play this and reads as digital.
    const b = gp.buttons || [];
    const pressed = (i) => !!(b[i] && (b[i].pressed || b[i].value > 0.5));
    if (pressed(12)) ay = -1;
    if (pressed(13)) ay = 1;
    if (pressed(14)) ax = -1;
    if (pressed(15)) ax = 1;
    return Input._shape(ax, ay, GAMEPAD_DEAD, 1.0);
  }

  /** @returns {THREE.Vector2} world-space XZ direction, length 0..1 */
  update() {
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0.0005, (now - this._last) / 1000));
    this._last = now;
    for (const [k, v] of this._latch) {
      const n = v - dt;
      if (n <= 0) this._latch.delete(k); else this._latch.set(k, n);
    }

    const d = this.dir.set(0, 0);
    let digital = false;

    /* ---- keyboard (highest priority: it is unambiguous) --------------- */
    const kx = this._axis(KEY_LEFT, KEY_RIGHT);
    const ky = this._axis(KEY_UP, KEY_DOWN);
    if (kx || ky) {
      d.set(kx, ky);
      digital = true;
      this.mode = 'keys';
    } else if (this.touchId !== null) {
      /* ---- touch joystick -------------------------------------------- */
      let dx = this.touchNow.x - this.touchOrigin.x;
      let dy = this.touchNow.y - this.touchOrigin.y;
      const len = Math.hypot(dx, dy);
      // Floating stick: once the finger is past full throw the origin follows
      // it, so a long drag never leaves the stick pinned in a stale direction.
      if (len > TOUCH_THROW_PX) {
        const k = (len - TOUCH_THROW_PX) / len;
        this.touchOrigin.x += dx * k;
        this.touchOrigin.y += dy * k;
        dx -= dx * k; dy -= dy * k;
      }
      const s = Input._shape(dx, dy, TOUCH_DEAD_PX, TOUCH_THROW_PX);
      if (s) { d.set(s.x, s.y); this.mode = 'touch'; }
    } else if (this.pointerActive) {
      /* ---- hold-to-steer mouse --------------------------------------- */
      const s = Input._shape(this.pointerVec.x, this.pointerVec.y, POINTER_DEAD, POINTER_THROW);
      if (s) { d.set(s.x, s.y); this.mode = 'pointer'; }
    } else {
      /* ---- gamepad ---------------------------------------------------- */
      const s = this._gamepad();
      if (s) { d.set(s.x, s.y); this.mode = 'gamepad'; }
    }

    if (d.lengthSq() > 1) d.normalize();

    /* ---- buffer: keep a reversal instant, keep analog from chattering -- */
    if (digital) {
      // Digital input goes through untouched. Any smoothing here is felt as lag.
      this._smooth.copy(d);
      this._turnHold = TURN_BUFFER;
    } else {
      const turning = this._smooth.dot(d) < 0.55 && d.lengthSq() > 0.02;
      if (turning) this._turnHold = TURN_BUFFER;
      // While the buffer is open a direction change is applied whole; after it
      // closes the analog value is low-passed so a shaky thumb does not buzz.
      const k = this._turnHold > 0 ? 1 : 1 - Math.exp(-26 * dt);
      this._smooth.lerp(d, k);
      this._turnHold = Math.max(0, this._turnHold - dt);
      d.copy(this._smooth);
    }

    /* ---- screen space -> world XZ ------------------------------------- */
    const yaw = THREE.MathUtils.degToRad(CAMERA.YAW);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    this.worldDir.set(d.x * c + d.y * s, -d.x * s + d.y * c);
    if (this.worldDir.lengthSq() > 1) this.worldDir.normalize();
    return this.worldDir;
  }

  dispose() { this._dispose(); }
}
