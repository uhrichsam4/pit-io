/**
 * Shared material + procedural texture library.
 *
 * No binary assets ship with this game: every texture is drawn into a canvas at
 * load time. That keeps the whole thing a single self-contained build while
 * still giving surfaces real high-frequency detail (asphalt grain, concrete
 * mottling, window grids, foliage cards).
 *
 * IMPORTANT: any material used for a surface at ground level must be created
 * through `ground()` (or passed through `applyHoleCut`) or holes will not cut
 * through it.
 */

import * as THREE from 'three';
import { PALETTE, QUALITY } from '../config.js';
import { applyHoleCut } from '../render/groundShader.js';

const _cache = new Map();

function canvas(size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function texFromCanvas(c, repeat = 1, aniso = true) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = aniso ? QUALITY.anisotropy : 1;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

function dataTex(c, repeat = 1) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = QUALITY.anisotropy;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** value-noise field helper used by several generators */
function noiseField(ctx, size, cells, alpha, hue) {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  const grid = [];
  for (let i = 0; i <= cells; i++) {
    grid[i] = [];
    for (let j = 0; j <= cells; j++) grid[i][j] = Math.random();
  }
  const step = size / cells;
  const smooth = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = x / step, gy = y / step;
      const i0 = Math.floor(gx) % cells, j0 = Math.floor(gy) % cells;
      const fx = smooth(gx - Math.floor(gx)), fy = smooth(gy - Math.floor(gy));
      const a = grid[i0][j0], b = grid[i0 + 1][j0];
      const c2 = grid[i0][j0 + 1], d2 = grid[i0 + 1][j0 + 1];
      const v = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c2 * (1 - fx) * fy + d2 * fx * fy;
      const k = (v - 0.5) * alpha * 255;
      const o = (y * size + x) * 4;
      d[o] = Math.max(0, Math.min(255, d[o] + k * (hue ? hue[0] : 1)));
      d[o + 1] = Math.max(0, Math.min(255, d[o + 1] + k * (hue ? hue[1] : 1)));
      d[o + 2] = Math.max(0, Math.min(255, d[o + 2] + k * (hue ? hue[2] : 1)));
    }
  }
  ctx.putImageData(img, 0, 0);
}

/* --------------------------------------------------------------- textures --- */

export const Textures = {
  asphalt(size = 512) {
    return cached('tex-asphalt', () => {
      const c = canvas(size); const g = c.getContext('2d');
      g.fillStyle = '#5c6470'; g.fillRect(0, 0, size, size);
      noiseField(g, size, 64, 0.30);
      noiseField(g, size, 12, 0.14);
      // aggregate speckle
      for (let i = 0; i < size * 9; i++) {
        const v = 140 + Math.random() * 110;
        g.fillStyle = `rgba(${v},${v},${v + 6},${0.05 + Math.random() * 0.14})`;
        const s = Math.random() * 2.2 + 0.4;
        g.fillRect(Math.random() * size, Math.random() * size, s, s);
      }
      // faint tar seams
      g.strokeStyle = 'rgba(30,32,38,0.30)';
      for (let i = 0; i < 7; i++) {
        g.lineWidth = 0.7 + Math.random() * 1.6;
        g.beginPath();
        let x = Math.random() * size, y = Math.random() * size;
        g.moveTo(x, y);
        for (let k = 0; k < 7; k++) {
          x += (Math.random() - 0.5) * 90; y += (Math.random() - 0.5) * 90;
          g.lineTo(x, y);
        }
        g.stroke();
      }
      return texFromCanvas(c, 1);
    });
  },

  concrete(size = 512, base = '#f0ece2') {
    return cached(`tex-concrete-${base}`, () => {
      const c = canvas(size); const g = c.getContext('2d');
      g.fillStyle = base; g.fillRect(0, 0, size, size);
      noiseField(g, size, 48, 0.16);
      noiseField(g, size, 8, 0.10);
      for (let i = 0; i < size * 4; i++) {
        g.fillStyle = `rgba(120,116,108,${0.02 + Math.random() * 0.05})`;
        g.fillRect(Math.random() * size, Math.random() * size, Math.random() * 3, Math.random() * 3);
      }
      return texFromCanvas(c, 1);
    });
  },

  /** Paving slabs for sidewalks and plazas. */
  paving(size = 512, base = '#d9d3c7', line = 'rgba(150,144,132,0.55)', cells = 8) {
    return cached(`tex-paving-${base}-${cells}`, () => {
      const c = canvas(size); const g = c.getContext('2d');
      g.fillStyle = base; g.fillRect(0, 0, size, size);
      noiseField(g, size, 40, 0.13);
      const step = size / cells;
      for (let i = 0; i <= cells; i++) {
        // per-slab tonal variation
        for (let j = 0; j < cells; j++) {
          const v = (Math.random() - 0.5) * 12;
          g.fillStyle = `rgba(255,255,255,${Math.max(0, v) / 255 * 6})`;
          g.fillRect(i * step, j * step, step, step);
          g.fillStyle = `rgba(0,0,0,${Math.max(0, -v) / 255 * 6})`;
          g.fillRect(i * step, j * step, step, step);
        }
      }
      g.strokeStyle = line; g.lineWidth = 1.6;
      for (let i = 0; i <= cells; i++) {
        g.beginPath(); g.moveTo(i * step, 0); g.lineTo(i * step, size); g.stroke();
        g.beginPath(); g.moveTo(0, i * step); g.lineTo(size, i * step); g.stroke();
      }
      return texFromCanvas(c, 1);
    });
  },

  grass(size = 512) {
    return cached('tex-grass', () => {
      const c = canvas(size); const g = c.getContext('2d');
      g.fillStyle = '#5cbf55'; g.fillRect(0, 0, size, size);
      noiseField(g, size, 30, 0.26, [0.6, 1.0, 0.5]);
      noiseField(g, size, 90, 0.20, [0.7, 1.0, 0.6]);
      for (let i = 0; i < size * 14; i++) {
        const dark = Math.random() < 0.5;
        g.strokeStyle = dark
          ? `rgba(48,132,58,${0.10 + Math.random() * 0.25})`
          : `rgba(140,220,110,${0.08 + Math.random() * 0.22})`;
        g.lineWidth = 0.8;
        const x = Math.random() * size, y = Math.random() * size;
        g.beginPath(); g.moveTo(x, y);
        g.lineTo(x + (Math.random() - 0.5) * 3, y - 2 - Math.random() * 4);
        g.stroke();
      }
      return texFromCanvas(c, 1);
    });
  },

  sand(size = 256) {
    return cached('tex-sand', () => {
      const c = canvas(size); const g = c.getContext('2d');
      g.fillStyle = '#f2e0b8'; g.fillRect(0, 0, size, size);
      noiseField(g, size, 60, 0.14);
      for (let i = 0; i < size * 6; i++) {
        g.fillStyle = `rgba(190,170,130,${0.05 + Math.random() * 0.10})`;
        g.fillRect(Math.random() * size, Math.random() * size, 1.4, 1.4);
      }
      return texFromCanvas(c, 1);
    });
  },

  /**
   * Curtain-wall glass: mullion grid + per-pane tonal variation + a few lit
   * interiors. `hex` tints the glass, `floors`/`bays` set the grid density.
   */
  glass(hex = 0x6fd6e8, floors = 16, bays = 10, size = 512) {
    return cached(`tex-glass-${hex}-${floors}-${bays}`, () => {
      const c = canvas(size); const g = c.getContext('2d');
      const col = new THREE.Color(hex);
      const r = (col.r * 255) | 0, gg = (col.g * 255) | 0, b = (col.b * 255) | 0;
      g.fillStyle = `rgb(${r},${gg},${b})`;
      g.fillRect(0, 0, size, size);

      const fh = size / floors, bw = size / bays;
      for (let f = 0; f < floors; f++) {
        for (let i = 0; i < bays; i++) {
          const v = (Math.random() - 0.5) * 0.38;
          const lit = Math.random() < 0.09;
          let rr, gg2, bb;
          if (lit) {
            rr = 255; gg2 = 236; bb = 190;
          } else {
            rr = Math.max(0, Math.min(255, r * (1 + v)));
            gg2 = Math.max(0, Math.min(255, gg * (1 + v)));
            bb = Math.max(0, Math.min(255, b * (1 + v * 0.6)));
          }
          g.fillStyle = `rgb(${rr | 0},${gg2 | 0},${bb | 0})`;
          g.fillRect(i * bw, f * fh, bw, fh);
          // sky reflection gradient inside each pane
          const grad = g.createLinearGradient(i * bw, f * fh, i * bw, f * fh + fh);
          grad.addColorStop(0, 'rgba(255,255,255,0.30)');
          grad.addColorStop(0.42, 'rgba(255,255,255,0.06)');
          grad.addColorStop(1, 'rgba(20,60,90,0.16)');
          g.fillStyle = grad;
          g.fillRect(i * bw, f * fh, bw, fh);
        }
      }
      // mullions
      g.strokeStyle = 'rgba(240,244,248,0.75)';
      g.lineWidth = Math.max(1.2, size / 320);
      for (let f = 0; f <= floors; f++) {
        g.beginPath(); g.moveTo(0, f * fh); g.lineTo(size, f * fh); g.stroke();
      }
      g.lineWidth = Math.max(1.0, size / 420);
      for (let i = 0; i <= bays; i++) {
        g.beginPath(); g.moveTo(i * bw, 0); g.lineTo(i * bw, size); g.stroke();
      }
      // spandrel band under each floor line
      g.fillStyle = 'rgba(255,255,255,0.14)';
      for (let f = 0; f < floors; f++) g.fillRect(0, f * fh + fh * 0.80, size, fh * 0.20);
      return texFromCanvas(c, 1);
    });
  },

  /** Stucco / painted-render facade with punched windows. */
  stucco(hex = 0xffc9d4, floors = 8, bays = 6, size = 512) {
    return cached(`tex-stucco-${hex}-${floors}-${bays}`, () => {
      const c = canvas(size); const g = c.getContext('2d');
      const col = new THREE.Color(hex);
      g.fillStyle = `#${col.getHexString()}`;
      g.fillRect(0, 0, size, size);
      noiseField(g, size, 44, 0.10);

      const fh = size / floors, bw = size / bays;
      const winW = bw * 0.50, winH = fh * 0.46;
      for (let f = 0; f < floors; f++) {
        for (let i = 0; i < bays; i++) {
          const x = i * bw + (bw - winW) / 2;
          const y = f * fh + fh * 0.26;
          const lit = Math.random() < 0.12;
          g.fillStyle = lit ? 'rgba(255,238,196,0.95)' : 'rgba(58,86,104,0.88)';
          roundRect(g, x, y, winW, winH, 2);
          g.fill();
          const grad = g.createLinearGradient(x, y, x, y + winH);
          grad.addColorStop(0, 'rgba(255,255,255,0.42)');
          grad.addColorStop(0.55, 'rgba(255,255,255,0.04)');
          grad.addColorStop(1, 'rgba(255,255,255,0.16)');
          g.fillStyle = grad;
          roundRect(g, x, y, winW, winH, 2); g.fill();
          // sill
          g.fillStyle = 'rgba(255,255,255,0.55)';
          g.fillRect(x - 1.5, y + winH, winW + 3, 2.2);
        }
        // floor shadow line
        g.fillStyle = 'rgba(0,0,0,0.05)';
        g.fillRect(0, f * fh + fh - 1.5, size, 1.5);
      }
      return texFromCanvas(c, 1);
    });
  },

  /** Small-shop frontage: awning stripe, signage band, big display window. */
  storefront(hex = 0xfff0d2, size = 512) {
    return cached(`tex-storefront-${hex}`, () => {
      const c = canvas(size); const g = c.getContext('2d');
      const col = new THREE.Color(hex);
      g.fillStyle = `#${col.getHexString()}`; g.fillRect(0, 0, size, size);
      noiseField(g, size, 40, 0.09);
      // signage band
      g.fillStyle = 'rgba(30,38,52,0.92)';
      g.fillRect(0, size * 0.06, size, size * 0.13);
      // glass
      const grad = g.createLinearGradient(0, size * 0.24, 0, size);
      grad.addColorStop(0, 'rgba(150,215,235,0.95)');
      grad.addColorStop(0.5, 'rgba(96,176,205,0.9)');
      grad.addColorStop(1, 'rgba(58,120,150,0.95)');
      g.fillStyle = grad;
      g.fillRect(size * 0.06, size * 0.26, size * 0.88, size * 0.62);
      g.strokeStyle = 'rgba(250,250,250,0.9)'; g.lineWidth = 6;
      g.strokeRect(size * 0.06, size * 0.26, size * 0.88, size * 0.62);
      g.beginPath();
      g.moveTo(size * 0.5, size * 0.26); g.lineTo(size * 0.5, size * 0.88);
      g.lineWidth = 4; g.stroke();
      return texFromCanvas(c, 1);
    });
  },

  /** Roughness map with mottled variation — breaks up uniform specular. */
  roughness(size = 256, base = 190, amp = 0.22) {
    return cached(`tex-rough-${base}-${amp}`, () => {
      const c = canvas(size); const g = c.getContext('2d');
      g.fillStyle = `rgb(${base},${base},${base})`; g.fillRect(0, 0, size, size);
      noiseField(g, size, 26, amp);
      noiseField(g, size, 80, amp * 0.6);
      return dataTex(c, 1);
    });
  },

  /** Soft radial blob — used for contact shadows under props. */
  blobShadow(size = 128) {
    return cached('tex-blob', () => {
      const c = canvas(size); const g = c.getContext('2d');
      const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grad.addColorStop(0, 'rgba(0,0,0,0.55)');
      grad.addColorStop(0.55, 'rgba(0,0,0,0.24)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad; g.fillRect(0, 0, size, size);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    });
  },

  /** Palm frond alpha card. */
  frond(size = 256) {
    return cached('tex-frond', () => {
      const c = canvas(size); const g = c.getContext('2d');
      g.clearRect(0, 0, size, size);
      g.strokeStyle = '#3f9e46'; g.lineWidth = 5;
      g.beginPath(); g.moveTo(8, size / 2); g.quadraticCurveTo(size * 0.5, size * 0.34, size - 6, size * 0.46); g.stroke();
      for (let i = 0; i < 34; i++) {
        const t = i / 33;
        const x = 8 + (size - 14) * t;
        const y = size / 2 + (size * 0.34 - size / 2) * 2 * t * (1 - t) + (size * 0.46 - size / 2) * t * t;
        const len = Math.sin(Math.PI * t) * size * 0.30 + 6;
        g.strokeStyle = i % 2 ? '#59c163' : '#4bb055';
        g.lineWidth = 3.2;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + len * 0.28, y - len); g.stroke();
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + len * 0.28, y + len); g.stroke();
      }
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = QUALITY.anisotropy;
      return t;
    });
  },
};

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function cached(key, make) {
  let v = _cache.get(key);
  if (!v) { v = make(); _cache.set(key, v); }
  return v;
}

/* -------------------------------------------------------------- materials --- */

/** Ground-level material: hole-cut applied automatically. */
export function ground(params) {
  const key = `ground-${JSON.stringify(paramKey(params))}`;
  return cached(key, () => applyHoleCut(new THREE.MeshStandardMaterial({
    roughness: 0.95, metalness: 0.0, ...params,
  })));
}

/** Standard opaque material for anything above ground. */
export function solid(params) {
  const key = `solid-${JSON.stringify(paramKey(params))}`;
  return cached(key, () => new THREE.MeshStandardMaterial({
    roughness: 0.72, metalness: 0.0, ...params,
  }));
}

/** Glossy architectural glass. */
export function glass(params) {
  const key = `glass-${JSON.stringify(paramKey(params))}`;
  return cached(key, () => new THREE.MeshStandardMaterial({
    roughness: 0.12, metalness: 0.55, envMapIntensity: 1.4, ...params,
  }));
}

/** Painted metal / plastic props: slight sheen, saturated colour. */
export function painted(hex, roughness = 0.45, metalness = 0.05) {
  return cached(`painted-${hex}-${roughness}-${metalness}`, () => new THREE.MeshStandardMaterial({
    color: hex, roughness, metalness,
  }));
}

/** Unlit emissive material for signage and lights. */
export function emissive(hex, intensity = 1.0) {
  return cached(`emissive-${hex}-${intensity}`, () => new THREE.MeshBasicMaterial({
    color: new THREE.Color(hex).multiplyScalar(intensity),
    toneMapped: false,
  }));
}

/** Foliage: double-sided, alpha-tested, slightly translucent look. */
export function foliage(map, hex = 0xffffff) {
  return cached(`foliage-${hex}-${map ? map.uuid : 'none'}`, () => new THREE.MeshStandardMaterial({
    map, color: hex, transparent: true, alphaTest: 0.42,
    side: THREE.DoubleSide, roughness: 0.85, metalness: 0.0,
  }));
}

function paramKey(p) {
  const o = {};
  for (const k of Object.keys(p).sort()) {
    const v = p[k];
    if (v && v.isTexture) o[k] = v.uuid;
    else if (v && v.isColor) o[k] = v.getHex();
    else o[k] = v;
  }
  return o;
}

/**
 * Environment map: a tiny procedural sky cube so glass has something to
 * reflect. Cheap, and it is the single biggest upgrade to how the towers read.
 */
export function buildEnvironment(renderer, scene) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  const size = 256;
  const c = canvas(size);
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, size);
  const top = new THREE.Color(PALETTE.SKY_TOP);
  const hor = new THREE.Color(PALETTE.SKY_HORIZON);
  const gnd = new THREE.Color(0x9a9384);
  grad.addColorStop(0.0, `#${top.getHexString()}`);
  grad.addColorStop(0.44, `#${hor.getHexString()}`);
  grad.addColorStop(0.52, '#f7efe0');
  grad.addColorStop(1.0, `#${gnd.getHexString()}`);
  g.fillStyle = grad; g.fillRect(0, 0, size, size);
  // sun blob
  const sg = g.createRadialGradient(size * 0.72, size * 0.24, 0, size * 0.72, size * 0.24, size * 0.14);
  sg.addColorStop(0, 'rgba(255,255,240,1)');
  sg.addColorStop(1, 'rgba(255,255,240,0)');
  g.fillStyle = sg; g.fillRect(0, 0, size, size);
  // a few clouds
  for (let i = 0; i < 26; i++) {
    g.fillStyle = `rgba(255,255,255,${0.10 + Math.random() * 0.25})`;
    const x = Math.random() * size, y = Math.random() * size * 0.42;
    g.beginPath(); g.ellipse(x, y, 10 + Math.random() * 34, 4 + Math.random() * 9, 0, 0, 7); g.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const rt = pmrem.fromEquirectangular(tex);
  scene.environment = rt.texture;
  scene.environmentIntensity = 0.55;
  tex.dispose();
  pmrem.dispose();
  return rt.texture;
}

export const MaterialLib = { Textures, ground, solid, glass, painted, emissive, foliage };
