/**
 * Input: WASD/arrows, pointer-steer, touch stick and gamepad, resolved into a
 * single normalised direction in CAMERA space (so "up" is always away from the
 * camera regardless of the fixed yaw).
 */

import * as THREE from 'three';
import { CAMERA } from '../config.js';

export class Input {
  constructor(domElement) {
    this.el = domElement;
    this.keys = new Set();
    this.dir = new THREE.Vector2();     // raw, camera-relative
    this.worldDir = new THREE.Vector2(); // rotated into world space
    this.pointerActive = false;
    this.pointerVec = new THREE.Vector2();
    this.touchId = null;
    this.touchOrigin = new THREE.Vector2();
    this.touchNow = new THREE.Vector2();
    this.mode = 'keys';

    this._yaw = THREE.MathUtils.degToRad(CAMERA.YAW);

    const kd = (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        e.preventDefault();
      }
      this.mode = 'keys';
    };
    const ku = (e) => this.keys.delete(e.code);
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('blur', () => this.keys.clear());

    // pointer steer: hold left mouse and the hole heads toward the cursor
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
      if (e.pointerId === this.touchId) { this.touchId = null; }
      this.pointerActive = false;
    };
    domElement.addEventListener('pointerdown', pd);
    window.addEventListener('pointermove', pm);
    window.addEventListener('pointerup', pu);
    window.addEventListener('pointercancel', pu);
    domElement.addEventListener('contextmenu', (e) => e.preventDefault());

    this._dispose = () => {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
      window.removeEventListener('pointermove', pm);
      window.removeEventListener('pointerup', pu);
    };
  }

  _setPointer(e) {
    const w = window.innerWidth, h = window.innerHeight;
    this.pointerVec.set((e.clientX / w) * 2 - 1, (e.clientY / h) * 2 - 1);
  }

  /** @returns {THREE.Vector2} world-space XZ direction, length 0..1 */
  update() {
    const d = this.dir.set(0, 0);
    const k = this.keys;
    if (k.has('KeyW') || k.has('ArrowUp')) d.y -= 1;
    if (k.has('KeyS') || k.has('ArrowDown')) d.y += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) d.x -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) d.x += 1;

    if (d.lengthSq() === 0) {
      if (this.touchId !== null) {
        const dx = this.touchNow.x - this.touchOrigin.x;
        const dy = this.touchNow.y - this.touchOrigin.y;
        const len = Math.hypot(dx, dy);
        if (len > 6) {
          const m = Math.min(1, len / 70);
          d.set((dx / len) * m, (dy / len) * m);
        }
      } else if (this.pointerActive) {
        const len = this.pointerVec.length();
        if (len > 0.04) {
          const m = Math.min(1, len / 0.42);
          d.set((this.pointerVec.x / len) * m, (this.pointerVec.y / len) * m);
        }
      } else {
        const gp = navigator.getGamepads ? navigator.getGamepads()[0] : null;
        if (gp) {
          const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
          if (Math.hypot(ax, ay) > 0.18) d.set(ax, ay);
        }
      }
    }

    if (d.lengthSq() > 1) d.normalize();

    // Rotate the screen-space intent into world space using the camera yaw.
    const c = Math.cos(this._yaw), s = Math.sin(this._yaw);
    this.worldDir.set(d.x * c + d.y * s, -d.x * s + d.y * c);
    return this.worldDir;
  }

  dispose() { this._dispose(); }
}
