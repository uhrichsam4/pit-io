/**
 * Shared material + procedural texture library.
 *
 * No binary assets ship with this game: every texture is drawn into a canvas at
 * load time. That keeps the whole thing a single self-contained build while
 * still giving surfaces real high-frequency detail.
 *
 * ---------------------------------------------------------------------------
 * HOW A GENERATOR IS BUILT (read this before adding one)
 * ---------------------------------------------------------------------------
 * A convincing stylised surface needs three matched channels, not one:
 *
 *   colour     LOW contrast. The art bible is explicit — detail comes from
 *              shape and light, not from busy albedo. Anything spicier than
 *              about +-8% tonal range turns into TV static under minification.
 *   height     HIGH contrast. This is where the aggregate, joints, seams and
 *              plank gaps live. It is converted to a tangent-space normal map
 *              by `normalMapFromHeight`, and the sun does the rest.
 *   roughness  Where the story is. Oil is glossy, tar sealant is glossy, worn
 *              tyre paths are polished, dry concrete is dead matte. Varying
 *              roughness is what stops a surface reading as painted cardboard.
 *
 * Generators therefore paint three canvases side by side and hand them to
 * `pack()`, which builds the textures and staples the normal/roughness maps
 * onto `colourTexture.userData.companions`. The material factories below pick
 * those up automatically, so a caller that only asks for `map:` still gets the
 * full set. That is deliberate: streets/buildings/nature are owned by other
 * agents and must not have to know about it.
 *
 * ---------------------------------------------------------------------------
 * TILING
 * ---------------------------------------------------------------------------
 * All noise is seamless (the lattice wraps modulo `cells`), and all features
 * are either drawn wrapped or kept away from the border. Texel density targets
 * roughly 1 texel per 1.5-3 cm on surfaces the camera gets close to:
 *   road      512 px over a 10 m tile  -> 2.0 cm/texel
 *   sidewalk  512 px over a 3 m tile   -> 0.6 cm/texel
 *   grass     512 px over an 8 m tile  -> 1.6 cm/texel
 *
 * ---------------------------------------------------------------------------
 * IMPORTANT: any material used for a surface at ground level must be created
 * through `ground()` (or passed through `applyHoleCut`) or holes will not cut
 * through it.
 *
 * Everything is lazily cached, so a generator that nobody calls costs nothing.
 */

import * as THREE from 'three';
import { PALETTE, QUALITY } from '../config.js';
// Namespace import on purpose: the light rig lives in another agent's file and
// its exports move around. `Q.LIGHTING?.X` degrades to a local default instead
// of throwing a module-resolution error the way a named import would.
import * as Q from './quality.js';
import { applyHoleCut } from '../render/groundShader.js';

const _cache = new Map();

function cached(key, make) {
  let v = _cache.get(key);
  if (v === undefined) { v = make(); _cache.set(key, v); }
  return v;
}

/* ========================================================== plumbing === */

function canvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function ctx2d(c) {
  return c.getContext('2d', { willReadFrequently: true });
}

/**
 * Parse a colour to raw sRGB bytes.
 *
 * We deliberately do NOT go through THREE.Color: colour management would
 * convert to linear working space and back, and everything we paint here is
 * plain sRGB canvas data.
 */
function srgb(hex) {
  if (Array.isArray(hex)) return hex;
  if (typeof hex === 'number') return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
  let s = String(hex).replace('#', '').trim();
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const n = parseInt(s, 16) | 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

function css(rgb, a = 1) {
  return `rgba(${clamp255(rgb[0]) | 0},${clamp255(rgb[1]) | 0},${clamp255(rgb[2]) | 0},${a})`;
}

/** Blend two sRGB triples. */
function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function shade(rgb, k) {
  return [rgb[0] * k, rgb[1] * k, rgb[2] * k];
}

const luma = (rgb) => rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;

/**
 * Albedo ceiling for large surfaces, in sRGB code values.
 *
 * ~0.86 of full range. Nothing that covers a big part of the frame — paving,
 * concrete, render — is allowed above this, because at full sun an albedo any
 * higher lands on the flat top of the tone curve and the surface loses all its
 * texture. "Blown-out white sidewalks" is listed failure #2.
 */
const ALBEDO_CEIL = 212;

/**
 * Pre-warm a neutral albedo, preserving luminance.
 *
 * See the header of src/render/palette.js: the fill light and the IBL are both
 * strongly cyan, so an authored-neutral ground renders navy — the #1 listed
 * automatic-failure. Ground and masonry bases are rotated warm here (hue only,
 * brightness held) so they land neutral-warm ON SCREEN, then pulled under
 * ALBEDO_CEIL so they cannot clip.
 */
function warmBalance(rgb, k = 1, gain = 1) {
  const l0 = luma(rgb);
  const r = rgb[0] + l0 * 0.075 * k;
  const g = rgb[1] + l0 * 0.010 * k;
  const b = rgb[2] - l0 * 0.080 * k;
  // Renormalise: the warm rotation must not double as an exposure change.
  const l1 = luma([r, g, b]);
  let s = (l1 > 0.001 ? l0 / l1 : 1) * gain;
  const peak = Math.max(r, g, b) * s;
  if (peak > ALBEDO_CEIL) s *= ALBEDO_CEIL / peak;
  return [clamp255(r * s), clamp255(g * s), clamp255(b * s)];
}

/* ------------------------------------------------------------ noise --- */

/** Small fast deterministic PRNG — textures must be identical every boot. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One octave of value noise, seamless in both axes.
 *
 * The lattice is indexed modulo `cells`, so the right edge interpolates back
 * into the left edge — that wrap is the whole reason the tiling doesn't show.
 */
function octave(size, cells, rand) {
  const g = new Float32Array(cells * cells);
  for (let i = 0; i < g.length; i++) g[i] = rand();

  const out = new Float32Array(size * size);
  const step = size / cells;
  for (let y = 0; y < size; y++) {
    const gy = y / step;
    const jf = Math.floor(gy);
    const j0 = ((jf % cells) + cells) % cells;
    const j1 = (j0 + 1) % cells;
    let fy = gy - jf; fy = fy * fy * (3 - 2 * fy);
    const r0 = j0 * cells, r1 = j1 * cells;
    for (let x = 0; x < size; x++) {
      const gx = x / step;
      const xf = Math.floor(gx);
      const i0 = ((xf % cells) + cells) % cells;
      const i1 = (i0 + 1) % cells;
      let fx = gx - xf; fx = fx * fx * (3 - 2 * fx);
      const a = g[r0 + i0], b = g[r0 + i1], c = g[r1 + i0], d = g[r1 + i1];
      out[y * size + x] = (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
    }
  }
  return out;
}

/** Multi-octave fBm normalised to 0..1. */
function fbm(size, cells, octaves, rand, gain = 0.5) {
  const out = new Float32Array(size * size);
  let amp = 1, total = 0, c = cells;
  for (let o = 0; o < octaves; o++) {
    const layer = octave(size, c, rand);
    for (let i = 0; i < out.length; i++) out[i] += layer[i] * amp;
    total += amp;
    amp *= gain;
    c *= 2;
    if (c > size) break;
  }
  const inv = 1 / total;
  for (let i = 0; i < out.length; i++) out[i] *= inv;
  return out;
}

/** Sharpen a field around 0.5 — turns soft fBm into distinct blotches. */
function contrast(f, k) {
  const out = new Float32Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const v = (f[i] - 0.5) * k + 0.5;
    out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return out;
}

/* ------------------------------------------------------- plate paint --- */

/**
 * Fill a colour canvas with `base` modulated by noise layers.
 * layer = { f, amp (fraction of full range), tint ([r,g,b] multipliers) }
 */
function paintBase(c, size, base, layers) {
  const g = ctx2d(c);
  const img = g.createImageData(size, size);
  const d = img.data;
  const n = size * size;
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    let r = base[0], gg = base[1], b = base[2];
    for (let L = 0; L < layers.length; L++) {
      const lay = layers[L];
      const k = (lay.f[i] - 0.5) * lay.amp * 255;
      const t = lay.tint;
      r += t ? k * t[0] : k;
      gg += t ? k * t[1] : k;
      b += t ? k * t[2] : k;
    }
    d[o] = clamp255(r); d[o + 1] = clamp255(gg); d[o + 2] = clamp255(b); d[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return g;
}

/** Fill a single-channel (grey) canvas from noise layers. `base` is 0..255. */
function paintGrey(c, size, base, layers) {
  const g = ctx2d(c);
  const img = g.createImageData(size, size);
  const d = img.data;
  const n = size * size;
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    let v = base;
    for (let L = 0; L < layers.length; L++) v += (layers[L].f[i] - 0.5) * layers[L].amp * 255;
    const cv = clamp255(v);
    d[o] = cv; d[o + 1] = cv; d[o + 2] = cv; d[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return g;
}

/* ------------------------------------------------------ normal maps --- */

/**
 * Central-difference height -> tangent-space normal, wrapping at the borders
 * so the normal map tiles as cleanly as the colour map.
 *
 * Green is +Y-up (OpenGL convention), which is what three.js expects.
 */
function normalMapFromHeight(heightCanvas, size, strength) {
  const src = ctx2d(heightCanvas).getImageData(0, 0, size, size).data;
  const out = canvas(size);
  const g = ctx2d(out);
  const img = g.createImageData(size, size);
  const d = img.data;
  const s = strength * 4;

  for (let y = 0; y < size; y++) {
    const rowC = y * size;
    const rowU = ((y - 1 + size) % size) * size;
    const rowD = ((y + 1) % size) * size;
    for (let x = 0; x < size; x++) {
      const xl = (x - 1 + size) % size;
      const xr = (x + 1) % size;
      const hl = src[(rowC + xl) << 2];
      const hr = src[(rowC + xr) << 2];
      const hu = src[(rowU + x) << 2];
      const hd = src[(rowD + x) << 2];
      const nx = ((hl - hr) / 255) * s;
      const ny = ((hd - hu) / 255) * s;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const o = (rowC + x) << 2;
      d[o] = (nx * inv * 0.5 + 0.5) * 255;
      d[o + 1] = (ny * inv * 0.5 + 0.5) * 255;
      d[o + 2] = (inv * 0.5 + 0.5) * 255;
      d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return out;
}

/* --------------------------------------------------------- textures --- */

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

/** Box-filtered downscale via the 2D context — good enough for a height field. */
function downscale(c, n) {
  const o = canvas(n);
  const g = ctx2d(o);
  g.imageSmoothingEnabled = true;
  g.drawImage(c, 0, 0, n, n);
  return o;
}

/**
 * Bundle a colour/height/roughness triple into one texture the material
 * factories can expand. Returns the colour texture.
 *
 * `normalSize` exists purely for boot time: the normal conversion is the most
 * expensive step in the library (a full per-pixel pass plus two ImageData
 * round-trips), and facades only carry coarse relief — mullions, sills, window
 * reveals — which survives a half-resolution normal map perfectly well. Ground
 * surfaces the camera gets within a metre of keep full resolution.
 */
function pack(colourCanvas, heightCanvas, roughCanvas, size, opts = {}) {
  const map = texFromCanvas(colourCanvas);
  const companions = {};
  if (heightCanvas) {
    const ns = Math.min(size, opts.normalSize || size);
    const src = ns === size ? heightCanvas : downscale(heightCanvas, ns);
    // Halving the resolution halves the per-texel height delta, so the slope
    // has to be scaled back up or the relief quietly disappears.
    const strength = (opts.normalStrength ?? 1.0) * (size / ns);
    companions.normalMap = dataTex(normalMapFromHeight(src, ns, strength));
    companions.normalScale = opts.normalScale ?? 1.0;
  }
  if (roughCanvas) companions.roughnessMap = dataTex(roughCanvas);
  map.userData.companions = companions;
  return map;
}

/* ---------------------------------------------------------- drawing --- */

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/**
 * Draw a callback nine times, offset by +-size, so anything that crosses the
 * border of the tile reappears on the opposite edge. Cheap seamlessness for
 * vector features (seams, cracks, stains).
 */
function wrapped(g, size, draw) {
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      g.save();
      g.translate(ox * size, oy * size);
      draw();
      g.restore();
    }
  }
}

/** A wandering polyline — cracks, tar seams, joints. */
function meander(g, size, x0, y0, len, segs, spread, rand) {
  g.beginPath();
  let x = x0, y = y0;
  let a = rand() * Math.PI * 2;
  g.moveTo(x, y);
  for (let i = 0; i < segs; i++) {
    a += (rand() - 0.5) * spread;
    x += Math.cos(a) * (len / segs);
    y += Math.sin(a) * (len / segs);
    g.lineTo(x, y);
  }
  g.stroke();
}

/* =========================================================== TEXTURES === */

export const Textures = {
  /**
   * Road surface: warm aggregate wearing course, crack sealant, utility-cut
   * patches, oil drips and polished tyre paths.
   *
   * Colour stays inside ~8% so it reads as a clean grey plane from the game
   * camera; every bit of "asphalt-ness" you actually see is the normal map
   * catching the sun plus the roughness break-up.
   */
  asphalt(size = 512) {
    return cached(`tex-asphalt-${size}`, () => {
      const rand = mulberry32(0x4a51f0);
      const base = srgb(PALETTE.ASPHALT);

      const macro = fbm(size, 4, 3, rand);          // broad paving-run tone
      const grit = fbm(size, size >> 2, 2, rand);   // 4 px aggregate
      const mid = fbm(size, 24, 2, rand);           // chip clusters

      const col = canvas(size);
      const gc = paintBase(col, size, base, [
        // Only a whisper of hue variation. A road that varies in HUE reads as
        // mud; a road that varies in VALUE reads as asphalt.
        { f: macro, amp: 0.085, tint: [1.06, 1.0, 0.90] },
        { f: mid, amp: 0.075 },
        { f: grit, amp: 0.095, tint: [1.0, 0.99, 0.97] },
      ]);

      const hgt = canvas(size);
      const gh = paintGrey(hgt, size, 128, [
        { f: grit, amp: 1.0 },
        { f: mid, amp: 0.30 },
        { f: macro, amp: 0.18 },
      ]);

      const rgh = canvas(size);
      const gr = paintGrey(rgh, size, 236, [
        { f: mid, amp: 0.16 },
        { f: grit, amp: 0.10 },
      ]);

      /*
       * FEATURE CONTRAST BUDGET
       * A road tile covers 10 m and the gameplay camera sees 50-90 m of it, so
       * every distinctive mark in here is drawn 5-9 times on screen at once.
       * Anything you can pick out individually becomes "tiling so obvious you
       * can count the repeats" (listed failure #4). So the recognisable
       * features — repairs, oil, polish — are pushed almost entirely into the
       * ROUGHNESS and NORMAL channels, where they read as changes in how the
       * sun catches the surface rather than as printed-on shapes.
       */

      /* Utility-cut repairs. Roughness + a hair of height; barely any albedo. */
      for (let i = 0; i < 3; i++) {
        const w = size * (0.16 + rand() * 0.22);
        const h = size * (0.12 + rand() * 0.18);
        const x = rand() * size, y = rand() * size;
        const rot = (rand() - 0.5) * 0.14;
        const drawOn = (g, fill, stroke, lw) => wrapped(g, size, () => {
          g.save(); g.translate(x + w / 2, y + h / 2); g.rotate(rot);
          if (fill) { g.fillStyle = fill; g.fillRect(-w / 2, -h / 2, w, h); }
          if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.strokeRect(-w / 2, -h / 2, w, h); }
          g.restore();
        });
        drawOn(gc, css(srgb(PALETTE.ASPHALT_PATCH), 0.10), null, 0);
        drawOn(gh, null, 'rgba(178,178,178,0.55)', 2.2);
        drawOn(gr, 'rgba(214,214,214,0.55)', 'rgba(164,164,164,0.7)', 2.0);
      }

      /* Crack sealant: a raised, glossy bead. Visible mostly as a specular
         change, which does not repeat the way a dark line does. */
      const seam = css(srgb(PALETTE.TAR_SEAM), 0.20);
      for (let i = 0; i < 7; i++) {
        const x0 = rand() * size, y0 = rand() * size;
        const len = size * (0.5 + rand() * 0.8);
        const lw = 1.0 + rand() * 1.8;
        const s = rand() * 1000;
        gc.strokeStyle = seam; gc.lineWidth = lw; gc.lineCap = 'round';
        wrapped(gc, size, () => meander(gc, size, x0, y0, len, 9, 0.9, mulberry32(s)));
        gh.strokeStyle = 'rgba(196,196,196,0.75)'; gh.lineWidth = lw; gh.lineCap = 'round';
        wrapped(gh, size, () => meander(gh, size, x0, y0, len, 9, 0.9, mulberry32(s)));
        gr.strokeStyle = 'rgba(118,118,118,0.85)'; gr.lineWidth = lw; gr.lineCap = 'round';
        wrapped(gr, size, () => meander(gr, size, x0, y0, len, 9, 0.9, mulberry32(s)));
      }

      /* Hairline cracks: height only. In albedo they read as a black cobweb. */
      gc.strokeStyle = 'rgba(74,68,58,0.10)';
      gh.strokeStyle = 'rgba(78,78,78,0.7)';
      for (let i = 0; i < 10; i++) {
        const x0 = rand() * size, y0 = rand() * size;
        const len = size * (0.10 + rand() * 0.20);
        const s = rand() * 1000;
        gc.lineWidth = 0.6; gh.lineWidth = 0.8;
        wrapped(gc, size, () => meander(gc, size, x0, y0, len, 5, 1.5, mulberry32(s)));
        wrapped(gh, size, () => meander(gh, size, x0, y0, len, 5, 1.5, mulberry32(s)));
      }

      /* Oil drips: glossy and dead flat, only a whisper darker. */
      for (let i = 0; i < 8; i++) {
        const x = rand() * size, y = rand() * size;
        const r = size * (0.018 + rand() * 0.05);
        const stain = (g, inner, outer) => wrapped(g, size, () => {
          const rg = g.createRadialGradient(x, y, 0, x, y, r);
          rg.addColorStop(0, inner); rg.addColorStop(1, outer);
          g.fillStyle = rg; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
        });
        stain(gc, css(srgb(PALETTE.OIL_STAIN), 0.18), css(srgb(PALETTE.OIL_STAIN), 0));
        stain(gr, 'rgba(78,78,78,0.85)', 'rgba(78,78,78,0)');
      }

      /* Polished sweeps where tyres run: smoother, marginally lighter. These
         are the largest and softest features, so they are allowed the most
         albedo — soft gradients don't announce a tile edge. */
      for (let i = 0; i < 6; i++) {
        const x = rand() * size, y = rand() * size;
        const r = size * (0.14 + rand() * 0.20);
        const polish = (g, inner) => wrapped(g, size, () => {
          const rg = g.createRadialGradient(x, y, 0, x, y, r);
          rg.addColorStop(0, inner); rg.addColorStop(1, 'rgba(0,0,0,0)');
          g.fillStyle = rg; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
        });
        polish(gc, css(srgb(PALETTE.ASPHALT_LIGHT), 0.22));
        polish(gr, 'rgba(176,176,176,0.6)');
      }

      return pack(col, hgt, rgh, size, { normalStrength: 1.35, normalScale: 0.9 });
    });
  },

  /**
   * Cast-in-place concrete: podiums, seawalls, retaining walls.
   * `base` is a hint — it gets warm-balanced so it cannot go cold or clip.
   */
  concrete(size = 512, base = PALETTE.CONCRETE) {
    return cached(`tex-concrete-${size}-${base}`, () => {
      const rand = mulberry32(0x9d31c7);
      // Light masonry only needs a nudge — the callers already pass warm creams,
      // the key light is warm, and the post grade tints highlights warm again.
      // Stacking a fourth warm push turns concrete into cardboard.
      const rgb = warmBalance(srgb(base), 0.10, 0.94);

      const macro = fbm(size, 3, 3, rand);
      const mid = fbm(size, 16, 3, rand);
      const fine = fbm(size, size >> 3, 2, rand);

      const col = canvas(size);
      const gc = paintBase(col, size, rgb, [
        { f: macro, amp: 0.05, tint: [1.1, 1.0, 0.85] },
        { f: mid, amp: 0.035 },
        { f: fine, amp: 0.03 },
      ]);
      const hgt = canvas(size);
      const gh = paintGrey(hgt, size, 128, [
        { f: fine, amp: 0.55 },
        { f: mid, amp: 0.35 },
      ]);
      const rgh = canvas(size);
      const gr = paintGrey(rgh, size, 232, [{ f: mid, amp: 0.16 }, { f: macro, amp: 0.12 }]);

      /* Pour lines: faint horizontal construction joints. */
      for (let i = 0; i < 3; i++) {
        const y = (i + 0.5) * (size / 3) + (rand() - 0.5) * 20;
        gc.fillStyle = 'rgba(120,110,94,0.10)'; gc.fillRect(0, y, size, 1.6);
        gh.fillStyle = 'rgba(80,80,80,0.55)'; gh.fillRect(0, y, size, 1.6);
      }

      /* Form-tie pockets: little recessed dimples in a loose grid. */
      for (let i = 0; i < 26; i++) {
        const x = rand() * size, y = rand() * size, r = 1.6 + rand() * 1.4;
        gc.fillStyle = 'rgba(120,110,94,0.20)';
        gc.beginPath(); gc.arc(x, y, r, 0, 7); gc.fill();
        gh.fillStyle = 'rgba(64,64,64,0.85)';
        gh.beginPath(); gh.arc(x, y, r, 0, 7); gh.fill();
      }

      /* Rain streaking under the top edge — reads as vertical on facades. */
      for (let i = 0; i < 12; i++) {
        const x = rand() * size;
        const w = 2 + rand() * 9;
        const h = size * (0.2 + rand() * 0.6);
        const grad = gc.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, 'rgba(126,116,98,0.16)');
        grad.addColorStop(1, 'rgba(126,116,98,0)');
        gc.fillStyle = grad;
        gc.save(); gc.translate(x, 0); gc.fillRect(0, 0, w, h); gc.restore();
        gr.fillStyle = 'rgba(255,255,255,0.10)';
        gr.fillRect(x, 0, w, h);
      }

      return pack(col, hgt, rgh, size, { normalStrength: 0.7, normalScale: 0.6, normalSize: 256 });
    });
  },

  /**
   * Paving slabs for sidewalks and plazas.
   * Signature kept for streets.js / nature.js: (size, base, line, cells).
   */
  paving(size = 512, base = PALETTE.SIDEWALK, line = 'rgba(150,144,132,0.55)', cells = 8) {
    return cached(`tex-paving-${size}-${base}-${line}-${cells}`, () => {
      const rand = mulberry32(0x2f77a3 ^ (cells * 7919));
      // Sidewalks are the second-most-common failure (blown to white), so the
      // base is pulled under ALBEDO_CEIL. Only slightly warmed, though: paving
      // that goes past bone into tan stops reading as concrete, and the warm
      // key light plus the grade's highlight tint already push it that way.
      const rgb = warmBalance(srgb(base), 0.20, 0.93);

      const macro = fbm(size, 4, 3, rand);
      const fine = fbm(size, size >> 3, 2, rand);
      const grain = fbm(size, size >> 2, 1, rand);

      const col = canvas(size);
      const gc = paintBase(col, size, rgb, [
        { f: macro, amp: 0.035, tint: [1.1, 1.0, 0.85] },
        { f: fine, amp: 0.03 },
        { f: grain, amp: 0.035 },
      ]);
      const hgt = canvas(size);
      const gh = paintGrey(hgt, size, 132, [{ f: grain, amp: 0.35 }, { f: fine, amp: 0.25 }]);
      const rgh = canvas(size);
      const gr = paintGrey(rgh, size, 226, [{ f: macro, amp: 0.14 }, { f: fine, amp: 0.10 }]);

      const step = size / cells;

      /* Per-slab tone. Kept quiet: at a 3 m tile this pattern repeats often,
         and loud slabs are how tiling becomes countable. */
      for (let j = 0; j < cells; j++) {
        for (let i = 0; i < cells; i++) {
          const v = (rand() - 0.5) * 2;
          gc.fillStyle = v > 0
            ? `rgba(255,246,224,${v * 0.055})`
            : `rgba(96,88,72,${-v * 0.055})`;
          gc.fillRect(i * step, j * step, step, step);
          gr.fillStyle = v > 0 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
          gr.fillRect(i * step, j * step, step, step);
        }
      }

      /* Joints. Recessed in height, a touch darker and rougher in colour. */
      const jointW = Math.max(1.4, step * 0.045);
      gc.strokeStyle = typeof line === 'string' ? line : css(srgb(PALETTE.SIDEWALK_JOINT), 0.55);
      gc.lineWidth = jointW;
      gh.strokeStyle = 'rgba(46,46,46,0.95)';
      gh.lineWidth = jointW;
      gr.strokeStyle = 'rgba(252,252,252,0.65)';
      gr.lineWidth = jointW;
      for (let i = 0; i <= cells; i++) {
        for (const g of [gc, gh, gr]) {
          g.beginPath(); g.moveTo(i * step, 0); g.lineTo(i * step, size); g.stroke();
          g.beginPath(); g.moveTo(0, i * step); g.lineTo(size, i * step); g.stroke();
        }
      }

      /* Worn arrises: the top edge of each slab is chipped and catches light. */
      const chamfer = Math.max(1.2, step * 0.035);
      gh.strokeStyle = 'rgba(190,190,190,0.55)';
      gh.lineWidth = chamfer;
      for (let i = 0; i <= cells; i++) {
        gh.beginPath(); gh.moveTo(i * step - jointW, 0); gh.lineTo(i * step - jointW, size); gh.stroke();
        gh.beginPath(); gh.moveTo(0, i * step - jointW); gh.lineTo(size, i * step - jointW); gh.stroke();
      }

      /* Corner wear + a couple of very faint stains. Low contrast on purpose. */
      for (let j = 0; j < cells; j++) {
        for (let i = 0; i < cells; i++) {
          if (rand() > 0.35) continue;
          const cx = (i + (rand() < 0.5 ? 0 : 1)) * step;
          const cy = (j + (rand() < 0.5 ? 0 : 1)) * step;
          const r = step * (0.10 + rand() * 0.12);
          const rg = gc.createRadialGradient(cx, cy, 0, cx, cy, r);
          rg.addColorStop(0, 'rgba(120,110,92,0.16)');
          rg.addColorStop(1, 'rgba(120,110,92,0)');
          gc.fillStyle = rg;
          gc.beginPath(); gc.arc(cx, cy, r, 0, 7); gc.fill();
        }
      }
      for (let i = 0; i < 4; i++) {
        const x = rand() * size, y = rand() * size, r = size * (0.06 + rand() * 0.10);
        wrapped(gc, size, () => {
          const rg = gc.createRadialGradient(x, y, 0, x, y, r);
          rg.addColorStop(0, 'rgba(128,116,96,0.11)');
          rg.addColorStop(1, 'rgba(128,116,96,0)');
          gc.fillStyle = rg; gc.beginPath(); gc.arc(x, y, r, 0, 7); gc.fill();
        });
      }

      return pack(col, hgt, rgh, size, { normalStrength: 1.1, normalScale: 0.75 });
    });
  },

  /** Mown lawn. Clumpy, saturated, with blade-scale normal detail. */
  grass(size = 512) {
    return cached(`tex-grass-${size}`, () => {
      const rand = mulberry32(0x7c1b44);
      const base = srgb(PALETTE.GRASS);
      const dark = srgb(PALETTE.GRASS_DARK);
      const light = srgb(PALETTE.GRASS_LIGHT);

      const clump = contrast(fbm(size, 6, 3, rand), 1.5);
      const mid = fbm(size, 22, 2, rand);
      const blade = fbm(size, size >> 2, 2, rand);

      // Lawn is one of the few surfaces where LOUD albedo variation is correct:
      // real turf is a patchwork of light and dark clumps, and a flat green
      // plane is the most obviously fake thing in a toy city.
      const spread = [(light[0] - dark[0]) / 150, (light[1] - dark[1]) / 150, (light[2] - dark[2]) / 150];
      const col = canvas(size);
      const gc = paintBase(col, size, base, [
        { f: clump, amp: 0.42, tint: spread },
        { f: mid, amp: 0.18, tint: [0.6, 1.0, 0.5] },
        { f: blade, amp: 0.12, tint: [0.7, 1.0, 0.6] },
      ]);
      const hgt = canvas(size);
      paintGrey(hgt, size, 128, [{ f: blade, amp: 0.9 }, { f: mid, amp: 0.45 }]);
      const rgh = canvas(size);
      paintGrey(rgh, size, 240, [{ f: clump, amp: 0.10 }]);

      /* Sun-scorched patches — Miami lawns are never uniformly green. */
      const dry = srgb(PALETTE.GRASS_DRY);
      for (let i = 0; i < 5; i++) {
        const x = rand() * size, y = rand() * size, r = size * (0.06 + rand() * 0.13);
        wrapped(gc, size, () => {
          const rg = gc.createRadialGradient(x, y, 0, x, y, r);
          rg.addColorStop(0, css(dry, 0.30));
          rg.addColorStop(1, css(dry, 0));
          gc.fillStyle = rg; gc.beginPath(); gc.arc(x, y, r, 0, 7); gc.fill();
        });
      }

      /* Blade flecks: short, low-contrast, dense. They must stay short or they
         smear into streaks when the texture is minified. */
      const hg = ctx2d(hgt);
      for (let i = 0; i < size * 10; i++) {
        const x = rand() * size, y = rand() * size;
        const len = 1.6 + rand() * 3.2;
        const lean = (rand() - 0.5) * 1.6;
        const up = rand() < 0.5;
        gc.strokeStyle = up
          ? css(light, 0.09 + rand() * 0.14)
          : css(dark, 0.07 + rand() * 0.13);
        gc.lineWidth = 0.9;
        gc.beginPath(); gc.moveTo(x, y); gc.lineTo(x + lean, y - len); gc.stroke();
        hg.strokeStyle = up ? 'rgba(215,215,215,0.30)' : 'rgba(52,52,52,0.24)';
        hg.lineWidth = 0.9;
        hg.beginPath(); hg.moveTo(x, y); hg.lineTo(x + lean, y - len); hg.stroke();
      }

      return pack(col, hgt, rgh, size, { normalStrength: 1.3, normalScale: 0.9 });
    });
  },

  /** Beach / bunker sand: wind ripples plus grain sparkle. */
  sand(size = 512) {
    return cached(`tex-sand-${size}`, () => {
      const rand = mulberry32(0x5aa207);
      const base = srgb(PALETTE.SAND);
      const wet = srgb(PALETTE.SAND_WET);

      const dune = fbm(size, 4, 3, rand);
      const warp = fbm(size, 8, 2, rand);
      const grain = fbm(size, size >> 1, 1, rand);

      /* Ripples: a sine banded along a warped axis so it never looks printed. */
      const ripple = new Float32Array(size * size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const u = (x * 0.72 + y * 0.30) / size;
          ripple[i] = 0.5 + 0.5 * Math.sin((u + warp[i] * 0.16) * Math.PI * 2 * 9);
        }
      }

      const col = canvas(size);
      paintBase(col, size, base, [
        { f: dune, amp: 0.10, tint: [(wet[0] - base[0]) / 180, (wet[1] - base[1]) / 180, (wet[2] - base[2]) / 180] },
        { f: ripple, amp: 0.05 },
        { f: grain, amp: 0.07 },
      ]);
      const hgt = canvas(size);
      paintGrey(hgt, size, 128, [{ f: ripple, amp: 0.75 }, { f: grain, amp: 0.5 }, { f: dune, amp: 0.4 }]);
      const rgh = canvas(size);
      paintGrey(rgh, size, 244, [{ f: dune, amp: 0.10 }]);

      // Full-res normal: sand is all grain sparkle, and that is the first thing
      // a half-resolution normal map throws away.
      return pack(col, hgt, rgh, size, { normalStrength: 1.0, normalScale: 0.8 });
    });
  },

  /**
   * Curtain-wall glass: mullion grid, per-pane tone, sky-gradient reflection,
   * lit interiors and a spandrel band under every floor line.
   *
   * `floors` / `bays` are grid divisions PER TILE, not per building — the
   * caller decides how many metres one tile covers via its UV scale. For a
   * correctly scaled facade use `tileW = bays * 1.5 m` and
   * `tileH = floors * 3.5 m` (see also `curtainWall` below).
   */
  glass(hex = PALETTE.GLASS_TEAL, floors = 16, bays = 10, size = 512) {
    return cached(`tex-glass-${hex}-${floors}-${bays}-${size}`, () => {
      const rand = mulberry32(0x1177ab ^ (hex | 0));
      const tint = srgb(hex);
      const lit = srgb(PALETTE.GLASS_LIT);
      const spandrel = srgb(PALETTE.SPANDREL);
      const mullion = srgb(PALETTE.MULLION);

      const col = canvas(size);
      const gc = ctx2d(col);
      const hgt = canvas(size);
      const gh = ctx2d(hgt);
      const rgh = canvas(size);
      const gr = ctx2d(rgh);

      gc.fillStyle = css(tint); gc.fillRect(0, 0, size, size);
      gh.fillStyle = 'rgb(150,150,150)'; gh.fillRect(0, 0, size, size);  // glass sits proud
      // Vision glass sits around 0.6 here and the material multiplies its own
      // roughness in. Authoring a near-zero map instead produces a perfect
      // mirror of a blurred PMREM, which renders as one flat colour — the exact
      // "painted concrete" look we are trying to get away from.
      gr.fillStyle = 'rgb(152,152,152)'; gr.fillRect(0, 0, size, size);

      const fh = size / floors, bw = size / bays;
      const spandrelH = fh * 0.26;
      const visionH = fh - spandrelH;

      /*
       * Contrast has to fall as the grid gets finer. A 4x8 grid can carry a
       * loud light/dark pane mosaic and read as curtain wall; the same contrast
       * at 24x14 minifies into colour noise that looks like video compression.
       * Scale the pane variation by how many panes are competing for a pixel.
       */
      const density = Math.max(floors, bays);
      const paneAmp = 0.62 * Math.min(1, Math.max(0.34, 11 / density));

      for (let f = 0; f < floors; f++) {
        const yTop = f * fh;
        for (let i = 0; i < bays; i++) {
          const x = i * bw;
          /* Pane-to-pane contrast is the whole read of a curtain wall from a
             distance: every sheet sits at a slightly different angle and
             catches a different part of the sky, so the facade is a mosaic of
             light and dark, not a flat plane. */
          const roll = rand();
          const v = (rand() - 0.5) * paneAmp;
          const isLit = roll < 0.06;
          const isGlint = !isLit && roll < 0.14;   // catching the sun
          const isDeep = !isLit && !isGlint && roll < 0.26; // reflecting the city
          let pane;
          const k = paneAmp / 0.62;               // same falloff for the specials
          if (isLit) pane = mix(tint, lit, 0.55 + 0.45 * k);
          else if (isGlint) pane = mix(tint, [255, 253, 244], 0.62 * k);
          else if (isDeep) pane = mix(tint, [26, 52, 70], 0.42 * k);
          else pane = [
            clamp255(tint[0] * (1 + v)),
            clamp255(tint[1] * (1 + v)),
            clamp255(tint[2] * (1 + v * 0.55)),
          ];
          gc.fillStyle = css(pane);
          gc.fillRect(x, yTop, bw, visionH);

          /* Sky-gradient reflection: bright at the head of the pane where it
             catches the zenith, dropping to a dark city reflection at the sill.
             This is the single thing that makes flat glass read as glass. */
          const grad = gc.createLinearGradient(0, yTop, 0, yTop + visionH);
          grad.addColorStop(0.0, 'rgba(255,252,242,0.46)');
          grad.addColorStop(0.30, 'rgba(198,232,246,0.20)');
          grad.addColorStop(0.62, 'rgba(120,176,206,0.05)');
          grad.addColorStop(1.0, 'rgba(24,52,72,0.34)');
          gc.fillStyle = grad;
          gc.fillRect(x, yTop, bw, visionH);

          if (isLit) {
            gr.fillStyle = 'rgb(210,210,210)';     // lit interiors kill the mirror
            gr.fillRect(x, yTop, bw, visionH);
          } else if (isGlint) {
            gr.fillStyle = 'rgb(118,118,118)';     // cleanest sheets, sharpest
            gr.fillRect(x, yTop, bw, visionH);
          } else if (rand() < 0.26) {
            gr.fillStyle = 'rgba(255,255,255,0.20)';  // salt haze on the glass
            gr.fillRect(x, yTop, bw, visionH);
          }
        }

        /* Opaque spandrel band hiding the floor slab. */
        const sy = yTop + visionH;
        gc.fillStyle = css(mix(spandrel, tint, 0.35));
        gc.fillRect(0, sy, size, spandrelH);
        const sg = gc.createLinearGradient(0, sy, 0, sy + spandrelH);
        sg.addColorStop(0, 'rgba(255,255,255,0.16)');
        sg.addColorStop(1, 'rgba(0,0,0,0.22)');
        gc.fillStyle = sg; gc.fillRect(0, sy, size, spandrelH);
        gh.fillStyle = 'rgb(96,96,96)'; gh.fillRect(0, sy, size, spandrelH);
        gr.fillStyle = 'rgb(228,228,228)'; gr.fillRect(0, sy, size, spandrelH);
      }

      /* Mullions: raised aluminium ribs. Horizontal transoms read heavier than
         the vertical mullions, which is how real curtain wall looks. */
      const mvW = Math.max(1.2, bw * 0.055);
      const mhW = Math.max(1.6, fh * 0.055);
      gc.strokeStyle = css(mullion, 0.85);
      gh.strokeStyle = 'rgb(228,228,228)';
      gr.strokeStyle = 'rgb(206,206,206)';   // brushed alu, much rougher than glass
      gc.lineWidth = mhW; gh.lineWidth = mhW; gr.lineWidth = mhW;
      for (let f = 0; f <= floors; f++) {
        for (const g of [gc, gh, gr]) {
          g.beginPath(); g.moveTo(0, f * fh); g.lineTo(size, f * fh); g.stroke();
        }
      }
      gc.lineWidth = mvW; gh.lineWidth = mvW; gr.lineWidth = mvW;
      for (let i = 0; i <= bays; i++) {
        for (const g of [gc, gh, gr]) {
          g.beginPath(); g.moveTo(i * bw, 0); g.lineTo(i * bw, size); g.stroke();
        }
      }

      return pack(col, hgt, rgh, size, { normalStrength: 0.9, normalScale: 0.7, normalSize: 256 });
    });
  },

  /**
   * World-scale curtain wall. Prefer this over `glass()` in new code: give it
   * the tile size in metres and it works out the grid itself, so the mullion
   * rhythm is metrically correct instead of depending on the caller's UV
   * bookkeeping.
   */
  curtainWall({ tint = PALETTE.GLASS_TEAL, tileW = 12, tileH = 14, storey = 3.5, bay = 1.5, size = 512 } = {}) {
    const floors = Math.max(1, Math.round(tileH / storey));
    const bays = Math.max(2, Math.round(tileW / bay));
    return Textures.glass(tint, floors, bays, size);
  },

  /**
   * Stucco / painted render with punched windows, sills, balcony slabs and a
   * railing hint. `floors` / `bays` are divisions per tile (see `glass`).
   */
  stucco(hex = PALETTE.STUCCO_PINK, floors = 8, bays = 6, size = 512) {
    return cached(`tex-stucco-${hex}-${floors}-${bays}-${size}`, () => {
      const rand = mulberry32(0x33aa71 ^ (hex | 0));
      const wall = srgb(hex);
      const rand2 = mulberry32(0x811a);

      const tooth = fbm(size, size >> 3, 2, rand2);   // render texture
      const patch = fbm(size, 5, 3, rand2);           // patchy repaint

      const col = canvas(size);
      const gc = paintBase(col, size, wall, [
        { f: patch, amp: 0.045, tint: [1.05, 1.0, 0.92] },
        { f: tooth, amp: 0.05 },
      ]);
      const hgt = canvas(size);
      const gh = paintGrey(hgt, size, 138, [{ f: tooth, amp: 0.65 }, { f: patch, amp: 0.2 }]);
      const rgh = canvas(size);
      const gr = paintGrey(rgh, size, 218, [{ f: patch, amp: 0.16 }]);

      const fh = size / floors, bw = size / bays;
      const winW = bw * 0.54, winH = fh * 0.44;
      const hasBalcony = floors <= 14;

      for (let f = 0; f < floors; f++) {
        const y0 = f * fh;

        /* Balcony slab: a projecting band with its own drop shadow. That
           shadow is what gives a flat box facade real depth from the air. */
        if (hasBalcony && f > 0) {
          const by = y0 + fh * 0.04;
          gc.fillStyle = 'rgba(255,252,244,0.55)';
          gc.fillRect(0, by, size, fh * 0.055);
          gc.fillStyle = 'rgba(60,48,40,0.22)';
          gc.fillRect(0, by + fh * 0.055, size, fh * 0.05);
          gh.fillStyle = 'rgb(225,225,225)'; gh.fillRect(0, by, size, fh * 0.055);
          gh.fillStyle = 'rgb(70,70,70)'; gh.fillRect(0, by + fh * 0.055, size, fh * 0.03);
        }

        for (let i = 0; i < bays; i++) {
          const x = i * bw + (bw - winW) / 2;
          const y = y0 + fh * 0.30;
          const isLit = rand() < 0.10;

          /* Reveal: the wall is thick, so the opening has a shadowed edge. */
          gc.fillStyle = 'rgba(70,56,44,0.28)';
          roundRect(gc, x - 1.6, y - 1.6, winW + 3.2, winH + 3.2, 2.5); gc.fill();

          gc.fillStyle = isLit ? css(srgb(PALETTE.GLASS_LIT), 0.95) : 'rgba(44,68,84,0.92)';
          roundRect(gc, x, y, winW, winH, 2); gc.fill();

          const grad = gc.createLinearGradient(x, y, x, y + winH);
          grad.addColorStop(0.0, 'rgba(255,253,244,0.50)');
          grad.addColorStop(0.45, 'rgba(178,216,236,0.12)');
          grad.addColorStop(1.0, 'rgba(255,255,255,0.14)');
          gc.fillStyle = grad;
          roundRect(gc, x, y, winW, winH, 2); gc.fill();

          /* Glass is recessed and smooth; the sill projects. */
          gh.fillStyle = 'rgb(72,72,72)'; gh.fillRect(x, y, winW, winH);
          gr.fillStyle = isLit ? 'rgb(90,90,90)' : 'rgb(44,44,44)'; gr.fillRect(x, y, winW, winH);

          gc.fillStyle = 'rgba(255,250,238,0.7)';
          gc.fillRect(x - 2.5, y + winH, winW + 5, 2.6);
          gh.fillStyle = 'rgb(215,215,215)';
          gh.fillRect(x - 2.5, y + winH, winW + 5, 2.6);

          /* Railing in front of the opening on balcony floors. */
          if (hasBalcony && f > 0) {
            gc.strokeStyle = 'rgba(250,248,240,0.55)';
            gc.lineWidth = 1.0;
            const ry = y + winH * 0.52;
            gc.beginPath(); gc.moveTo(x - 3, ry); gc.lineTo(x + winW + 3, ry); gc.stroke();
            for (let k = 0; k <= 6; k++) {
              const px = x - 3 + (winW + 6) * (k / 6);
              gc.beginPath(); gc.moveTo(px, ry); gc.lineTo(px, y + winH + 1); gc.stroke();
            }
          }
        }
      }

      /* Grime collecting under sills and slabs. */
      for (let i = 0; i < 14; i++) {
        const x = rand() * size, w = 3 + rand() * 10, h = size * (0.08 + rand() * 0.24);
        const y = rand() * size;
        const grad = gc.createLinearGradient(0, y, 0, y + h);
        grad.addColorStop(0, 'rgba(96,84,68,0.13)');
        grad.addColorStop(1, 'rgba(96,84,68,0)');
        gc.fillStyle = grad; gc.fillRect(x, y, w, h);
      }

      return pack(col, hgt, rgh, size, { normalStrength: 1.1, normalScale: 0.8, normalSize: 256 });
    });
  },

  /**
   * Small-shop frontage: plinth, display glazing with mullions, signage band,
   * striped awning. Designed so a vertical repeat still reads as "another
   * storey of shopfront" rather than a broken seam.
   */
  storefront(hex = PALETTE.STUCCO_CREAM, size = 512) {
    return cached(`tex-storefront-${hex}-${size}`, () => {
      const rand = mulberry32(0x60d1f3 ^ (hex | 0));
      const wall = warmBalance(srgb(hex), 0.4, 0.97);
      const accentSet = [
        PALETTE.FABRIC_CORAL, PALETTE.FABRIC_AQUA, PALETTE.FABRIC_SUN,
        PALETTE.FABRIC_SKY, PALETTE.FABRIC_PINK,
      ];
      const accent = srgb(accentSet[(hex | 0) % accentSet.length]);

      const tooth = fbm(size, size >> 3, 2, mulberry32(0x2b));
      const patch = fbm(size, 5, 2, mulberry32(0x71));

      const col = canvas(size);
      const gc = paintBase(col, size, wall, [
        { f: patch, amp: 0.04, tint: [1.05, 1.0, 0.92] },
        { f: tooth, amp: 0.045 },
      ]);
      const hgt = canvas(size);
      const gh = paintGrey(hgt, size, 136, [{ f: tooth, amp: 0.6 }]);
      const rgh = canvas(size);
      const gr = paintGrey(rgh, size, 214, [{ f: patch, amp: 0.14 }]);

      const P = (t) => size * t;

      /* Signage band. */
      gc.fillStyle = css(srgb(PALETTE.SIGN_DARK));
      gc.fillRect(0, P(0.055), size, P(0.115));
      gh.fillStyle = 'rgb(190,190,190)'; gh.fillRect(0, P(0.055), size, P(0.115));
      gr.fillStyle = 'rgb(150,150,150)'; gr.fillRect(0, P(0.055), size, P(0.115));
      /* Illegible "lettering": blocks, not text — text at this size is mush. */
      const wordN = 3 + Math.floor(rand() * 3);
      let lx = P(0.10);
      for (let w = 0; w < wordN; w++) {
        const ww = P(0.06 + rand() * 0.13);
        gc.fillStyle = css(srgb(PALETTE.NEON_AQUA), 0.85);
        roundRect(gc, lx, P(0.088), ww, P(0.048), P(0.012)); gc.fill();
        lx += ww + P(0.035);
        if (lx > P(0.9)) break;
      }

      /* Awning: striped, projecting, with a scalloped valance. */
      const ay = P(0.175), ah = P(0.085);
      const stripes = 9;
      for (let i = 0; i < stripes; i++) {
        const sx = (size / stripes) * i;
        gc.fillStyle = i % 2 ? css(accent) : css(srgb(PALETTE.FABRIC_WHITE));
        gc.fillRect(sx, ay, size / stripes + 1, ah);
      }
      const av = gc.createLinearGradient(0, ay, 0, ay + ah);
      av.addColorStop(0, 'rgba(255,246,228,0.14)');
      av.addColorStop(1, 'rgba(40,30,24,0.34)');
      gc.fillStyle = av; gc.fillRect(0, ay, size, ah);
      gh.fillStyle = 'rgb(215,215,215)'; gh.fillRect(0, ay, size, ah);
      gr.fillStyle = 'rgb(240,240,240)'; gr.fillRect(0, ay, size, ah);
      /* Shadow the awning throws on the glass below. */
      const ash = gc.createLinearGradient(0, ay + ah, 0, ay + ah + P(0.10));
      ash.addColorStop(0, 'rgba(38,30,26,0.42)');
      ash.addColorStop(1, 'rgba(38,30,26,0)');
      gc.fillStyle = ash; gc.fillRect(0, ay + ah, size, P(0.10));

      /* Display glazing. */
      const gy = P(0.30), gH = P(0.60);
      const grad = gc.createLinearGradient(0, gy, 0, gy + gH);
      grad.addColorStop(0.0, 'rgba(196,232,246,0.96)');
      grad.addColorStop(0.30, 'rgba(126,190,216,0.94)');
      grad.addColorStop(0.72, 'rgba(60,110,140,0.94)');
      grad.addColorStop(1.0, 'rgba(96,140,164,0.94)');
      gc.fillStyle = grad;
      gc.fillRect(P(0.045), gy, size - P(0.09), gH);
      gh.fillStyle = 'rgb(84,84,84)'; gh.fillRect(P(0.045), gy, size - P(0.09), gH);
      gr.fillStyle = 'rgb(36,36,36)'; gr.fillRect(P(0.045), gy, size - P(0.09), gH);

      /* A hint of interior: warm blobs behind the glass. */
      for (let i = 0; i < 7; i++) {
        const x = P(0.08) + rand() * size * 0.84;
        const y = gy + gH * (0.35 + rand() * 0.5);
        const r = P(0.02 + rand() * 0.05);
        const rg = gc.createRadialGradient(x, y, 0, x, y, r);
        rg.addColorStop(0, 'rgba(255,226,168,0.45)');
        rg.addColorStop(1, 'rgba(255,226,168,0)');
        gc.fillStyle = rg; gc.beginPath(); gc.arc(x, y, r, 0, 7); gc.fill();
      }
      /* Raking highlight across the glass. */
      gc.save();
      gc.beginPath(); gc.rect(P(0.045), gy, size - P(0.09), gH); gc.clip();
      gc.fillStyle = 'rgba(255,255,255,0.16)';
      gc.beginPath();
      gc.moveTo(P(0.05), gy + gH); gc.lineTo(P(0.42), gy);
      gc.lineTo(P(0.60), gy); gc.lineTo(P(0.23), gy + gH);
      gc.closePath(); gc.fill();
      gc.restore();

      /* Mullions + frame. */
      const frame = css(srgb(PALETTE.MULLION), 0.95);
      gc.strokeStyle = frame; gc.lineWidth = P(0.014);
      gc.strokeRect(P(0.045), gy, size - P(0.09), gH);
      gh.strokeStyle = 'rgb(226,226,226)'; gh.lineWidth = P(0.014);
      gh.strokeRect(P(0.045), gy, size - P(0.09), gH);
      const divs = 3;
      for (let i = 1; i < divs; i++) {
        const x = P(0.045) + (size - P(0.09)) * (i / divs);
        gc.lineWidth = P(0.008); gh.lineWidth = P(0.008);
        gc.beginPath(); gc.moveTo(x, gy); gc.lineTo(x, gy + gH); gc.stroke();
        gh.beginPath(); gh.moveTo(x, gy); gh.lineTo(x, gy + gH); gh.stroke();
      }
      /* Transom over the door line. */
      gc.lineWidth = P(0.008);
      gc.beginPath(); gc.moveTo(P(0.045), gy + gH * 0.24); gc.lineTo(size - P(0.045), gy + gH * 0.24); gc.stroke();

      /* Plinth. */
      gc.fillStyle = css(shade(wall, 0.82));
      gc.fillRect(0, P(0.90), size, P(0.10));
      gh.fillStyle = 'rgb(160,160,160)'; gh.fillRect(0, P(0.90), size, P(0.10));

      return pack(col, hgt, rgh, size, { normalStrength: 1.0, normalScale: 0.8, normalSize: 256 });
    });
  },

  /**
   * Flat roof: gravel ballast over bitumen, welded membrane seams, patch
   * repairs and ponding stains. Roofs are visible almost all the time from the
   * 3/4 camera, so this one matters more than it sounds.
   */
  rooftop(size = 512) {
    return cached(`tex-rooftop-${size}`, () => {
      const rand = mulberry32(0xb3e0aa);
      const base = srgb(PALETTE.ROOF_GRAVEL);
      const tar = srgb(PALETTE.ROOF_TAR);

      const macro = fbm(size, 4, 3, rand);
      const gravel = fbm(size, size >> 2, 2, rand);
      const mid = fbm(size, 18, 2, rand);

      const col = canvas(size);
      const gc = paintBase(col, size, base, [
        { f: macro, amp: 0.09, tint: [1.1, 1.0, 0.85] },
        { f: mid, amp: 0.07 },
        { f: gravel, amp: 0.14 },
      ]);
      const hgt = canvas(size);
      const gh = paintGrey(hgt, size, 128, [{ f: gravel, amp: 1.0 }, { f: mid, amp: 0.3 }]);
      const rgh = canvas(size);
      const gr = paintGrey(rgh, size, 244, [{ f: mid, amp: 0.12 }]);

      /* Membrane seams on a 1 m-ish lap. */
      const lap = size / 5;
      for (let i = 0; i < 5; i++) {
        const y = i * lap + (rand() - 0.5) * 6;
        gc.fillStyle = css(tar, 0.35); gc.fillRect(0, y, size, 3.2);
        gh.fillStyle = 'rgba(196,196,196,0.8)'; gh.fillRect(0, y, size, 3.2);
        gr.fillStyle = 'rgba(140,140,140,0.7)'; gr.fillRect(0, y, size, 3.2);
      }

      /* Bitumen patches and ponding rings. */
      for (let i = 0; i < 6; i++) {
        const x = rand() * size, y = rand() * size;
        const w = size * (0.08 + rand() * 0.18), h = size * (0.06 + rand() * 0.14);
        wrapped(gc, size, () => {
          gc.fillStyle = css(tar, 0.30);
          roundRect(gc, x, y, w, h, 6); gc.fill();
        });
        wrapped(gr, size, () => {
          gr.fillStyle = 'rgba(120,120,120,0.6)';
          roundRect(gr, x, y, w, h, 6); gr.fill();
        });
      }
      for (let i = 0; i < 5; i++) {
        const x = rand() * size, y = rand() * size, r = size * (0.06 + rand() * 0.12);
        wrapped(gc, size, () => {
          const rg = gc.createRadialGradient(x, y, r * 0.4, x, y, r);
          rg.addColorStop(0, 'rgba(90,84,72,0.16)');
          rg.addColorStop(1, 'rgba(90,84,72,0)');
          gc.fillStyle = rg; gc.beginPath(); gc.arc(x, y, r, 0, 7); gc.fill();
        });
      }

      return pack(col, hgt, rgh, size, { normalStrength: 1.35, normalScale: 0.9 });
    });
  },

  /**
   * Parking-deck slab: power-trowelled concrete, painted stall lines,
   * expansion joints and tyre scuffing.
   */
  parkingDeck(size = 512) {
    return cached(`tex-parking-${size}`, () => {
      const rand = mulberry32(0x22c9f1);
      const base = warmBalance(srgb(PALETTE.PRECAST), 0.7, 0.88);

      const macro = fbm(size, 4, 3, rand);
      const fine = fbm(size, size >> 3, 2, rand);

      const col = canvas(size);
      const gc = paintBase(col, size, base, [
        { f: macro, amp: 0.06, tint: [1.1, 1.0, 0.86] },
        { f: fine, amp: 0.04 },
      ]);
      const hgt = canvas(size);
      const gh = paintGrey(hgt, size, 130, [{ f: fine, amp: 0.4 }]);
      const rgh = canvas(size);
      const gr = paintGrey(rgh, size, 214, [{ f: macro, amp: 0.14 }]);

      /* Sawn expansion joints. */
      gc.strokeStyle = 'rgba(96,88,74,0.42)'; gc.lineWidth = 2.4;
      gh.strokeStyle = 'rgba(40,40,40,0.9)'; gh.lineWidth = 2.4;
      for (const t of [0.0, 0.5]) {
        for (const g of [gc, gh]) {
          g.beginPath(); g.moveTo(t * size, 0); g.lineTo(t * size, size); g.stroke();
          g.beginPath(); g.moveTo(0, t * size); g.lineTo(size, t * size); g.stroke();
        }
      }

      /* Stall lines — two bays per tile. */
      gc.strokeStyle = css(srgb(PALETTE.ROAD_LINE), 0.8);
      gc.lineWidth = size * 0.016;
      for (let i = 0; i < 4; i++) {
        const x = size * (0.125 + i * 0.25);
        gc.beginPath(); gc.moveTo(x, size * 0.08); gc.lineTo(x, size * 0.92); gc.stroke();
      }

      /* Tyre scuff arcs. */
      gc.strokeStyle = 'rgba(72,66,58,0.16)';
      for (let i = 0; i < 9; i++) {
        gc.lineWidth = 2 + rand() * 5;
        gc.beginPath();
        gc.arc(rand() * size, rand() * size, size * (0.05 + rand() * 0.2),
          rand() * 6, rand() * 6);
        gc.stroke();
      }

      return pack(col, hgt, rgh, size, { normalStrength: 0.9, normalScale: 0.6, normalSize: 256 });
    });
  },

  /** Running-bond brick with recessed mortar. */
  brick(size = 512, hex = PALETTE.BRICK, rows = 16) {
    return cached(`tex-brick-${size}-${hex}-${rows}`, () => {
      const rand = mulberry32(0x99b1e2 ^ (hex | 0));
      const b0 = srgb(hex);
      const b1 = srgb(PALETTE.BRICK_LIGHT);
      const b2 = srgb(PALETTE.BRICK_DARK);
      const mortar = srgb(PALETTE.MORTAR);

      const grit = fbm(size, size >> 3, 2, rand);

      const col = canvas(size);
      const gc = paintBase(col, size, mortar, [{ f: grit, amp: 0.10 }]);
      const hgt = canvas(size);
      const gh = paintGrey(hgt, size, 64, [{ f: grit, amp: 0.25 }]);
      const rgh = canvas(size);
      const gr = paintGrey(rgh, size, 238, [{ f: grit, amp: 0.12 }]);

      const rh = size / rows;
      const cols = Math.round(rows / 2.2);
      const bwid = size / cols;
      const joint = Math.max(1.6, rh * 0.13);

      for (let r = 0; r < rows; r++) {
        const off = (r % 2) * bwid * 0.5;
        for (let c = -1; c <= cols; c++) {
          const x = c * bwid + off + joint * 0.5;
          const y = r * rh + joint * 0.5;
          const w = bwid - joint, h = rh - joint;
          const t = rand();
          const tone = t < 0.30 ? mix(b0, b2, rand() * 0.7)
            : t < 0.72 ? b0
              : mix(b0, b1, rand() * 0.8);
          gc.fillStyle = css(tone);
          gc.fillRect(x, y, w, h);
          /* Face light: bricks are slightly domed. */
          const fg = gc.createLinearGradient(0, y, 0, y + h);
          fg.addColorStop(0, 'rgba(255,240,220,0.16)');
          fg.addColorStop(1, 'rgba(40,20,10,0.14)');
          gc.fillStyle = fg; gc.fillRect(x, y, w, h);
          gh.fillStyle = 'rgb(198,198,198)'; gh.fillRect(x, y, w, h);
          gr.fillStyle = rand() < 0.2 ? 'rgb(210,210,210)' : 'rgb(228,228,228)';
          gr.fillRect(x, y, w, h);
        }
      }

      return pack(col, hgt, rgh, size, { normalStrength: 1.4, normalScale: 1.0 });
    });
  },

  /** Timber decking: boards, gaps, grain, a few knots. */
  wood(size = 512, hex = PALETTE.WOOD_DECK, boards = 8) {
    return cached(`tex-wood-${size}-${hex}-${boards}`, () => {
      const rand = mulberry32(0x7ac31d ^ (hex | 0));
      const base = srgb(hex);
      const dark = srgb(PALETTE.WOOD_DARK);
      const light = srgb(PALETTE.WOOD_LIGHT);

      const col = canvas(size);
      const gc = ctx2d(col);
      const hgt = canvas(size);
      const gh = ctx2d(hgt);
      const rgh = canvas(size);
      const gr = ctx2d(rgh);
      gh.fillStyle = 'rgb(150,150,150)'; gh.fillRect(0, 0, size, size);
      gr.fillStyle = 'rgb(196,196,196)'; gr.fillRect(0, 0, size, size);

      const bh = size / boards;
      for (let b = 0; b < boards; b++) {
        const y = b * bh;
        const tone = mix(base, rand() < 0.5 ? dark : light, rand() * 0.35);
        gc.fillStyle = css(tone);
        gc.fillRect(0, y, size, bh);

        /* Grain: long low-contrast streaks along the board. */
        for (let i = 0; i < 46; i++) {
          const gy = y + rand() * bh;
          const a = 0.03 + rand() * 0.09;
          gc.strokeStyle = rand() < 0.5 ? css(dark, a) : css(light, a);
          gc.lineWidth = 0.6 + rand() * 1.6;
          gc.beginPath();
          gc.moveTo(0, gy);
          gc.bezierCurveTo(size * 0.33, gy + (rand() - 0.5) * bh * 0.4,
            size * 0.66, gy + (rand() - 0.5) * bh * 0.4, size, gy);
          gc.stroke();
        }
        /* Knot. */
        if (rand() < 0.5) {
          const kx = rand() * size, ky = y + bh * (0.3 + rand() * 0.4);
          const kr = bh * (0.10 + rand() * 0.12);
          for (let k = 4; k > 0; k--) {
            gc.strokeStyle = css(dark, 0.20);
            gc.lineWidth = 1.4;
            gc.beginPath(); gc.ellipse(kx, ky, kr * k * 0.25, kr * k * 0.18, 0, 0, 7); gc.stroke();
          }
        }

        /* Gap between boards. */
        gc.fillStyle = css(shade(dark, 0.55), 0.85);
        gc.fillRect(0, y, size, Math.max(1.4, bh * 0.05));
        gh.fillStyle = 'rgb(40,40,40)';
        gh.fillRect(0, y, size, Math.max(1.4, bh * 0.05));
        gh.fillStyle = 'rgba(210,210,210,0.5)';
        gh.fillRect(0, y + Math.max(1.4, bh * 0.05), size, 1.5);
      }

      return pack(col, hgt, rgh, size, { normalStrength: 1.2, normalScale: 0.85 });
    });
  },

  /**
   * Roughness map with mottled variation.
   *
   * Kept for callers that predate the matched-set system. It is tagged as
   * generic so the material factories know they may replace it with the
   * roughness map that actually belongs to the colour map in use.
   */
  roughness(size = 256, base = 190, amp = 0.22) {
    return cached(`tex-rough-${size}-${base}-${amp}`, () => {
      const rand = mulberry32(0x1a2b3c ^ (base * 131));
      const c = canvas(size);
      paintGrey(c, size, base, [
        { f: fbm(size, 8, 2, rand), amp },
        { f: fbm(size, size >> 3, 2, rand), amp: amp * 0.55 },
      ]);
      const t = dataTex(c, 1);
      t.userData.__generic = true;
      return t;
    });
  },

  /** Soft radial blob — used for contact shadows under props. */
  blobShadow(size = 128) {
    return cached('tex-blob', () => {
      const c = canvas(size); const g = ctx2d(c);
      const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grad.addColorStop(0.0, 'rgba(26,18,10,0.62)');
      grad.addColorStop(0.45, 'rgba(26,18,10,0.30)');
      grad.addColorStop(1.0, 'rgba(26,18,10,0)');
      g.fillStyle = grad; g.fillRect(0, 0, size, size);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    });
  },

  /**
   * Palm frond alpha card.
   *
   * Filled leaflet polygons rather than strokes: strokes disappear into the
   * mip chain and the crown turns to fog at 40 m. Leaflets taper, lean toward
   * the tip, get longest at mid-span, and a few are torn off — that asymmetry
   * is most of what makes it read as a real frond.
   */
  frond(size = 512) {
    return cached(`tex-frond-${size}`, () => {
      const rand = mulberry32(0x0fa17e);
      const c = canvas(size);
      const g = ctx2d(c);
      g.clearRect(0, 0, size, size);

      const midY = size * 0.52;
      const x0 = size * 0.015, x1 = size * 0.985;
      // Rachis arc: starts level, droops toward the tip.
      const rach = (t) => midY - Math.sin(t * Math.PI * 0.72) * size * 0.16 + t * t * size * 0.10;

      const dark = srgb(PALETTE.PALM_FROND_DARK);
      const mid = srgb(PALETTE.PALM_FROND);
      const lite = srgb(PALETTE.PALM_FROND_LIGHT);

      const N = 46;
      for (let side = 0; side < 2; side++) {
        const dir = side === 0 ? -1 : 1;
        for (let i = 0; i < N; i++) {
          const t = (i + 0.5) / N;
          if (rand() < 0.05 && t > 0.2 && t < 0.9) continue;  // a torn-off leaflet
          const bx = x0 + (x1 - x0) * t;
          const by = rach(t);
          // Longest around 45% of the span, tapering hard at both ends.
          const len = (Math.pow(Math.sin(Math.PI * Math.pow(t, 0.85)), 0.75) * 0.40 + 0.045)
            * size * (0.86 + rand() * 0.28);
          const lean = 0.34 + t * 0.42;              // leaflets sweep to the tip
          const tipX = bx + len * lean;
          const tipY = by + dir * len * (0.92 - t * 0.25);
          const wide = Math.max(2.6, len * 0.13);

          const shadeT = (side === 0 ? 0.0 : 0.42) + rand() * 0.35;
          g.fillStyle = css(shadeT < 0.4 ? mix(lite, mid, shadeT / 0.4) : mix(mid, dark, (shadeT - 0.4) / 0.6));
          g.beginPath();
          g.moveTo(bx - wide * 0.35, by);
          g.quadraticCurveTo(
            bx + len * lean * 0.35 - dir * wide * 0.9,
            by + dir * len * 0.42,
            tipX, tipY
          );
          g.quadraticCurveTo(
            bx + len * lean * 0.35 + dir * wide * 0.9,
            by + dir * len * 0.40,
            bx + wide * 0.55, by
          );
          g.closePath();
          g.fill();
        }
      }

      /* Rachis on top: solid, slightly lighter, tapering. */
      g.lineCap = 'round';
      for (let pass = 0; pass < 2; pass++) {
        g.strokeStyle = pass === 0 ? css(dark, 0.9) : css(mix(mid, lite, 0.4), 0.95);
        g.beginPath();
        for (let i = 0; i <= 40; i++) {
          const t = i / 40;
          const x = x0 + (x1 - x0) * t;
          const y = rach(t) + (pass === 0 ? 1.5 : 0);
          if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.lineWidth = pass === 0 ? size * 0.017 : size * 0.011;
        g.stroke();
      }

      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = QUALITY.anisotropy;
      t.needsUpdate = true;
      return t;
    });
  },

  /**
   * Two-tone striped fabric for awnings, parasols and market stalls.
   * Cheap, and it stops every canopy in the city being a flat colour chip.
   */
  stripes(a = PALETTE.FABRIC_CORAL, b = PALETTE.FABRIC_WHITE, count = 8, size = 256) {
    return cached(`tex-stripes-${a}-${b}-${count}-${size}`, () => {
      const rand = mulberry32(0x5e11 ^ (a | 0));
      const ca = srgb(a), cb = srgb(b);
      const weave = fbm(size, size >> 2, 1, rand);

      const col = canvas(size);
      const gc = paintBase(col, size, ca, [{ f: weave, amp: 0.05 }]);
      const w = size / count;
      for (let i = 1; i < count; i += 2) {
        gc.fillStyle = css(cb, 0.96);
        gc.fillRect(i * w, 0, w, size);
      }
      const hgt = canvas(size);
      paintGrey(hgt, size, 128, [{ f: weave, amp: 0.5 }]);
      const rgh = canvas(size);
      paintGrey(rgh, size, 232, [{ f: weave, amp: 0.12 }]);

      return pack(col, hgt, rgh, size, { normalStrength: 0.5, normalScale: 0.4, normalSize: 128 });
    });
  },
};

/* ========================================================== MATERIALS === */

const _v2 = (n) => new THREE.Vector2(n, n);

/**
 * Expand a colour map's companion normal/roughness maps into the material
 * parameters. Explicit parameters always win, except for a roughness map that
 * was produced by the legacy generic `Textures.roughness()` helper — the
 * matched map is strictly better and the callers predate it.
 */
function withCompanions(params) {
  const m = params.map;
  const c = m && m.userData && m.userData.companions;
  if (!c) return params;
  const out = { ...params };
  if (c.normalMap && !out.normalMap) {
    out.normalMap = c.normalMap;
    if (!out.normalScale) out.normalScale = _v2(c.normalScale ?? 1);
  }
  if (c.roughnessMap && (!out.roughnessMap || out.roughnessMap.userData.__generic)) {
    out.roughnessMap = c.roughnessMap;
  }
  return out;
}

function paramKey(p) {
  const o = {};
  for (const k of Object.keys(p).sort()) {
    const v = p[k];
    if (v && v.isTexture) o[k] = v.uuid;
    else if (v && v.isColor) o[k] = v.getHex();
    else if (v && v.isVector2) o[k] = `${v.x},${v.y}`;
    else o[k] = v;
  }
  return o;
}

/**
 * Ground-level material: hole-cut applied automatically.
 *
 * envMapIntensity is deliberately low. The IBL is a blue sky, and an up-facing
 * road that reflects it at full strength is exactly how asphalt turns navy.
 */
export function ground(params) {
  const p = withCompanions(params);
  const key = `ground-${JSON.stringify(paramKey(p))}`;
  return cached(key, () => applyHoleCut(new THREE.MeshStandardMaterial({
    roughness: 0.95,
    metalness: 0.0,
    envMapIntensity: 0.30,
    dithering: true,
    ...p,
  })));
}

/** Standard opaque material for anything above ground. */
export function solid(params) {
  const p = withCompanions(params);
  const key = `solid-${JSON.stringify(paramKey(p))}`;
  return cached(key, () => new THREE.MeshStandardMaterial({
    roughness: 0.72,
    metalness: 0.0,
    envMapIntensity: 0.65,
    dithering: true,
    ...p,
  }));
}

/**
 * Glossy architectural glass — the towers live or die on this one.
 *
 * envMapIntensity is high on purpose. The rig runs the IBL at ~0.42 so that
 * roads and render don't turn blue, which leaves glass with almost nothing to
 * reflect unless it asks for several times the scene default. The product of
 * the two is what actually lands, and it wants to be about 1.
 */
export function glass(params) {
  const p = withCompanions(params);
  const key = `glass-${JSON.stringify(paramKey(p))}`;
  return cached(key, () => new THREE.MeshStandardMaterial({
    roughness: 0.20,
    metalness: 0.80,
    envMapIntensity: 2.4,
    dithering: true,
    ...p,
  }));
}

/** Painted metal / plastic props: slight sheen, saturated colour. */
export function painted(hex, roughness = 0.42, metalness = 0.04) {
  return cached(`painted-${hex}-${roughness}-${metalness}`, () => new THREE.MeshStandardMaterial({
    color: hex, roughness, metalness, envMapIntensity: 0.8, dithering: true,
  }));
}

/** Unlit emissive material for signage and lights. */
export function emissive(hex, intensity = 1.0) {
  return cached(`emissive-${hex}-${intensity}`, () => new THREE.MeshBasicMaterial({
    color: new THREE.Color(hex).multiplyScalar(intensity),
    toneMapped: false,
  }));
}

/**
 * Foliage: double-sided, alpha-tested, slightly translucent look.
 * alphaTest is kept low so leaflets survive the mip chain at distance.
 */
export function foliage(map, hex = 0xffffff) {
  return cached(`foliage-${hex}-${map ? map.uuid : 'none'}`, () => new THREE.MeshStandardMaterial({
    map, color: hex, transparent: true, alphaTest: 0.34,
    side: THREE.DoubleSide, roughness: 0.78, metalness: 0.0,
    envMapIntensity: 0.55, dithering: true,
  }));
}

/* ======================================================== ENVIRONMENT === */

/**
 * Reflected environment: a proper Miami sky + sun + warm city ground, so glass
 * towers reflect something believable instead of a flat blue wash.
 *
 * The ground half matters more than it looks: from the game's high 3/4 camera
 * the mirror direction off a vertical facade points at the horizon and below,
 * so it is the WARM half of this map that lands on the towers. Making it warm
 * is what keeps a wall of glass from reading as a wall of navy.
 */
export function buildEnvironment(renderer, scene) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  const W = 512, H = 256;
  const c = canvas(W, H);
  const g = ctx2d(c);

  const top = srgb(PALETTE.SKY_TOP);
  const mid = srgb(PALETTE.SKY_MID);
  const hor = srgb(PALETTE.SKY_HORIZON);
  const haze = srgb(PALETTE.SKY_HAZE);

  /* Upper half: sky. v=0 is the zenith in equirectangular. */
  const sky = g.createLinearGradient(0, 0, 0, H * 0.5);
  sky.addColorStop(0.00, css(top));
  sky.addColorStop(0.45, css(mid));
  sky.addColorStop(0.86, css(hor));
  sky.addColorStop(1.00, css(mix(hor, haze, 0.65)));
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H * 0.5);

  /* Lower half: the city and the bay. Warm concrete/sand with a turquoise
     wedge where Biscayne Bay sits, fading to a dark ground-bounce at nadir. */
  const gnd = g.createLinearGradient(0, H * 0.5, 0, H);
  gnd.addColorStop(0.00, css(mix(haze, srgb(PALETTE.CONCRETE), 0.35)));
  gnd.addColorStop(0.22, css(srgb(PALETTE.SIDEWALK)));
  gnd.addColorStop(0.60, css(srgb(PALETTE.ASPHALT_LIGHT)));
  gnd.addColorStop(1.00, css(shade(srgb(PALETTE.ASPHALT), 0.72)));
  g.fillStyle = gnd;
  g.fillRect(0, H * 0.5, W, H * 0.5);

  /* Bay: a broad turquoise band over roughly a third of the azimuth. */
  const bay = g.createLinearGradient(0, H * 0.5, 0, H * 0.86);
  bay.addColorStop(0.0, css(srgb(PALETTE.SEA_SHALLOW), 0.85));
  bay.addColorStop(0.5, css(srgb(PALETTE.SEA_MID), 0.8));
  bay.addColorStop(1.0, css(srgb(PALETTE.SEA_DEEP), 0.0));
  g.fillStyle = bay;
  g.fillRect(W * 0.58, H * 0.5, W * 0.34, H * 0.36);

  /* Green wedge for the park side, so reflections aren't monochrome. */
  const park = g.createLinearGradient(0, H * 0.5, 0, H * 0.72);
  park.addColorStop(0, css(srgb(PALETTE.GRASS), 0.5));
  park.addColorStop(1, css(srgb(PALETTE.GRASS_DARK), 0.0));
  g.fillStyle = park;
  g.fillRect(W * 0.06, H * 0.5, W * 0.16, H * 0.22);

  /* Horizon haze line — the join must not read as a hard edge. */
  const seam = g.createLinearGradient(0, H * 0.46, 0, H * 0.56);
  seam.addColorStop(0.0, css(haze, 0.0));
  seam.addColorStop(0.5, css(haze, 0.85));
  seam.addColorStop(1.0, css(haze, 0.0));
  g.fillStyle = seam;
  g.fillRect(0, H * 0.46, W, H * 0.10);

  /* Sun: elevation ~38 deg matches the engine's sunDir. */
  const sx = W * 0.70, sy = H * 0.29;
  const glow = g.createRadialGradient(sx, sy, 0, sx, sy, H * 0.42);
  glow.addColorStop(0.00, 'rgba(255,255,246,1)');
  glow.addColorStop(0.06, 'rgba(255,246,222,0.85)');
  glow.addColorStop(0.30, 'rgba(255,228,182,0.22)');
  glow.addColorStop(1.00, 'rgba(255,220,170,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, W, H * 0.55);

  /* Fair-weather cumulus, flattened toward the horizon like real perspective. */
  const rand = mulberry32(0x51c0d);
  for (let i = 0; i < 44; i++) {
    const t = Math.pow(rand(), 0.6);
    const y = H * (0.06 + t * 0.38);
    const x = rand() * W;
    const flat = 0.22 + (1 - t) * 0.7;
    const rx = W * (0.02 + rand() * 0.07);
    const ry = rx * flat;
    g.fillStyle = `rgba(255,252,246,${0.16 + rand() * 0.42})`;
    g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, 7); g.fill();
    g.fillStyle = `rgba(190,204,218,${0.10 + rand() * 0.16})`;
    g.beginPath(); g.ellipse(x, y + ry * 0.55, rx * 0.85, ry * 0.5, 0, 0, 7); g.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;

  const rt = pmrem.fromEquirectangular(tex);
  scene.environment = rt.texture;
  // The light rig owns overall IBL strength; fall back if that export moves.
  scene.environmentIntensity = (Q.LIGHTING && Q.LIGHTING.ENV_INTENSITY) || 0.5;
  tex.dispose();
  pmrem.dispose();
  return rt.texture;
}

export const MaterialLib = { Textures, ground, solid, glass, painted, emissive, foliage };
