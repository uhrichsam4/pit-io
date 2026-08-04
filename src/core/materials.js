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
 * THE MINIFICATION PROBLEM — read this before "adding more detail"
 * ---------------------------------------------------------------------------
 * A road tile is 9 m of world across a 512 px map. From the gameplay camera
 * that tile lands on ~40 screen pixels, so the renderer is sampling mip 3-4 and
 * EVERY feature below about 1 m has already been averaged into the base colour.
 * That is why a texture packed with aggregate, cracks and oil stains still
 * renders as a flat grey card: all of it is real, none of it survives.
 *
 * Two independent fixes, and they are both needed:
 *
 *   1. WITHIN the tile, the loudest features must be metres wide, not
 *      centimetres. Every ground generator now carries a deliberate 1-3 m
 *      tonal band on top of its fine detail.
 *   2. ACROSS tiles, `worldDetail()` below multiplies in a WORLD-SPACE field
 *      sampled at ~60-100 m. It never mips away (it is huge), it is not tied
 *      to the tile grid, and it is what stops the eye locking onto the repeat.
 *      This is the single biggest change in this file.
 *
 * Three more layers sit on top of those, all in `worldDetail`, all optional
 * per family, and all aimed at a different slice of the same problem:
 *
 *   `far`     a SECOND read of the world field at ~3x the size and rotated 34
 *             degrees. One 70 m field over a 1040 m map is fifteen visible
 *             copies; cross-fading a 220 m band into it moves most of the
 *             energy to a period four times wider than the world.
 *   `detail`  a second read of the surface's own colour map at ~2.9x and
 *             rotated 26 degrees, luminance only, normalised by the map's mean.
 *             This owns the 5-30 m band, which is where the gameplay camera
 *             actually lives and where a 9 m road tile announces itself.
 *   `slab`    per-slab tone hashed off the slab's WORLD index instead of baked
 *             into the tile, so the mosaic of paving tones never repeats. Faded
 *             out by fwidth before it can alias.
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

/**
 * Boot-time cost of every generator in this file, in ms.
 * Read it back with `Textures.stats()` — the budget is ~800 ms.
 */
const _stats = { ms: 0, count: 0, envMs: 0, byKey: {} };

function cached(key, make) {
  let v = _cache.get(key);
  if (v === undefined) {
    // Only `tex-*` keys are counted: the same cache holds the material
    // factories, and their cost is shader compilation, not generation.
    const meter = key.charCodeAt(0) === 116 /* t */ && key.startsWith('tex-');
    const t0 = meter ? performance.now() : 0;
    v = make();
    if (meter) {
      const dt = performance.now() - t0;
      _stats.ms += dt; _stats.count++; _stats.byKey[key] = Math.round(dt * 10) / 10;
    }
    _cache.set(key, v);
  }
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

/**
 * sRGB byte -> linear 0..1.
 *
 * Needed whenever a constant painted on a canvas has to be compared with, or
 * mixed into, `diffuseColor` in a shader: three uploads colour maps as sRGB and
 * the sampler hands the fragment shader LINEAR values. Authoring a shader
 * constant straight from the hex would land it about a stop and a half too
 * bright.
 */
function lin1(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
const linTriple = (hex) => srgb(hex).map(lin1);

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

/**
 * Stretch a field to fill 0..1 exactly.
 *
 * fBm normalised by total amplitude only ever occupies the middle of the range
 * (the octaves average out), so an un-stretched fBm used as a modulation field
 * delivers maybe a third of the contrast you asked for. Every band that feeds
 * the world-space breakup goes through this so the tuning numbers mean what
 * they say.
 */
function normalise(f) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < f.length; i++) { if (f[i] < lo) lo = f[i]; if (f[i] > hi) hi = f[i]; }
  const s = hi > lo ? 1 / (hi - lo) : 1;
  const out = new Float32Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = (f[i] - lo) * s;
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
/**
 * Mean LINEAR luminance of a colour canvas, on a 1-in-16 sample grid.
 *
 * The second detail layer (see `worldDetail`) re-samples the surface's own
 * colour map at a different scale and divides by this, so what it adds is the
 * map's *variation* and not its brightness. Get this wrong and every road in
 * the city shifts a stop. Subsampled because it is only ever a normalising
 * constant: 16k samples of a 262k-texel map agree with the full mean to about
 * 0.2%, and cost a tenth of a millisecond instead of four.
 */
function meanLuminance(c, size) {
  const d = ctx2d(c).getImageData(0, 0, size, size).data;
  let sum = 0, n = 0;
  for (let y = 0; y < size; y += 4) {
    for (let x = 0; x < size; x += 4) {
      const o = (y * size + x) << 2;
      sum += 0.2126 * lin1(d[o]) + 0.7152 * lin1(d[o + 1]) + 0.0722 * lin1(d[o + 2]);
      n++;
    }
  }
  return n ? sum / n : 0.2;
}

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
  // Which tuning row worldDetail() should use. See MACRO below.
  map.userData.family = opts.family || 'default';
  // Normalising constant for the second detail layer, and the slab grid the
  // per-slab shader hash has to line up with. Both are properties of the
  // PIXELS, so they travel with the texture rather than with the caller.
  map.userData.meanLuma = meanLuminance(colourCanvas, size);
  if (opts.cells) map.userData.cells = opts.cells;
  return map;
}

/* =============================================== WORLD-SPACE BREAKUP === */

/**
 * The de-tiling layer.
 *
 * Every ground and facade material multiplies in one extra texture fetch of a
 * shared, three-band noise field indexed by WORLD POSITION at 50-100 m per
 * tile. Three properties make it the right tool:
 *
 *   · it is enormous, so it never mips away — unlike the 2 cm aggregate in the
 *     asphalt map, it is still fully present at 400 m;
 *   · its period has nothing to do with the surface's own tile grid, and the
 *     two beat against each other, so there is no countable repeat;
 *   · it is world-indexed, so a road, the sidewalk beside it and the plaza
 *     behind it all darken together — which reads as one weathered city rather
 *     than three surfaces that each happen to be mottled.
 *
 * RGB carry three decorrelated fBm bands at ~1/2, ~1/8 and ~1/25 of the tile,
 * so a single fetch yields variation at three scales. Cost: one texture read
 * and about a dozen ALU ops per fragment.
 *
 * The projection is planar-by-normal rather than triplanar: horizontal faces
 * index on XZ, vertical faces on (x+z, y). One `step`, no blend weights, no
 * second fetch. The field is low-contrast enough that the switchover at 45 deg
 * is invisible.
 */
const MACRO_PARS = /* glsl */ `
  uniform sampler2D uMacroMap;
  uniform vec4 uMacroA;      // x 1/metres, y albedo, z roughness, w hue
  varying vec3 vMacroPos;
  varying vec3 vMacroNrm;
`;

const MACRO_VERTEX = /* glsl */ `
  #ifdef USE_INSTANCING
    vMacroPos = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
    vMacroNrm = normalize( mat3( modelMatrix ) * mat3( instanceMatrix ) * objectNormal );
  #else
    vMacroPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
    vMacroNrm = normalize( mat3( modelMatrix ) * objectNormal );
  #endif
`;

/**
 * Declared at main() scope so the roughness hook further down can reuse them.
 *
 * `mcSlabR` is always declared, even on a surface with no slab grid, because
 * MACRO_ROUGH reads it unconditionally and the two injections are assembled
 * independently.
 */
const MACRO_HEAD = /* glsl */ `
  vec2 mcUV = mix(
    vec2( ( vMacroPos.x + vMacroPos.z ) * 0.7071, vMacroPos.y ),
    vMacroPos.xz,
    step( 0.55, abs( vMacroNrm.y ) )
  ) * uMacroA.x;
  vec3 mcF = texture2D( uMacroMap, mcUV ).rgb - 0.5;
  float mcSlabR = 0.0;
`;

/**
 * The SECOND macro band, and the reason the field stopped being countable.
 *
 * One fetch of a 70 m field is a 70 m pattern, and the map is 1040 m across —
 * fifteen copies of the same set of light and dark lobes, which from the
 * skyline preset is a grid you can point at. This re-reads the same field at
 * roughly a third of the frequency and rotated 34 degrees, then CROSS-FADES
 * rather than adds: the total contrast is unchanged (so none of the tuning
 * below had to move), but most of the energy now sits at 200-300 m on an axis
 * that shares no factor with the near band. The two periods only realign after
 * several kilometres, which is four times the width of the world.
 *
 * The channels are swizzled (`mcW.gbr`) so the far band's broad lobes do not
 * land on the same channel as the near band's — otherwise the two correlate and
 * you get one pattern with soft edges instead of two scales of variation.
 */
function macroFar(scale, weight) {
  return /* glsl */ `
  {
    vec2 fUV = vec2( mcUV.x * 0.8290 - mcUV.y * 0.5592,
                     mcUV.x * 0.5592 + mcUV.y * 0.8290 ) * ${(1 / scale).toFixed(5)};
    vec3 mcW = texture2D( uMacroMap, fUV ).rgb - 0.5;
    mcF = mix( mcF, mcW.gbr, ${weight.toFixed(4)} );
  }
`;
}

const MACRO_BODY = /* glsl */ `
  float mcT = mcF.r + mcF.g * 0.62 + mcF.b * 0.34;
  diffuseColor.rgb *= 1.0 + mcT * uMacroA.y;
  // A pure brightness wobble reads as dirt. Letting the warm/cool axis drift
  // with it is what makes it read as sun-bleach, damp and age instead.
  diffuseColor.rgb *= vec3( 1.0 + mcF.r * uMacroA.w, 1.0 - mcF.r * uMacroA.w * 0.2,
                            1.0 - mcF.r * uMacroA.w );
`;

/**
 * A second octave of the surface's OWN colour map, at an unrelated scale.
 *
 * The world field above fixes variation above ~50 m. It does nothing for the
 * 5-30 m band, which is exactly the band the gameplay camera lives in and
 * exactly where a 9 m road tile announces itself. Re-reading the same map at
 * ~2.9x the tile and rotated 26 degrees gives that band real structure —
 * asphalt patches, oil, the soft polished sweeps — at a size and angle that
 * cannot line up with the copy underneath it.
 *
 * Only the LUMINANCE of the second read is used, divided by the map's own mean,
 * so this is a pure value modulation: no hue shift, no brightness drift, and
 * nothing to retune if the base colour changes. Restricted to surfaces with no
 * straight-line features — on paving or brick a rotated second copy of the
 * joints would read as a plaid.
 */
function macroDetail(scale, weight, meanLuma) {
  return /* glsl */ `
  #ifdef USE_MAP
  {
    vec2 dUV = vec2( vMapUv.x * 0.8988 - vMapUv.y * 0.4384,
                     vMapUv.x * 0.4384 + vMapUv.y * 0.8988 ) * ${scale.toFixed(5)};
    float dL = dot( texture2D( map, dUV ).rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
    diffuseColor.rgb *= clamp(
      1.0 + ( dL * ${(1 / Math.max(0.01, meanLuma)).toFixed(4)} - 1.0 ) * ${weight.toFixed(4)},
      0.55, 1.7 );
  }
  #endif
`;
}

/**
 * Per-slab tone, hashed in WORLD space instead of baked into the tile.
 *
 * The mosaic of light and dark slabs is the whole read of a sidewalk, and it
 * was painted into a 4.8 m tile — so the same twenty slabs, in the same order,
 * repeated down every block. Nothing about the world field fixes that: it
 * varies over tens of metres and the mosaic is the thing repeating at five.
 *
 * So the tone is moved out of the texture and into a hash of the slab's world
 * index. The index has to match the generator exactly, including the half-slab
 * course offset and the canvas Y flip (v = 0 is the BOTTOM of the tile, so
 * canvas row j counts down from cells-1), or the hash cells straddle the joints
 * and you get tonal steps in the middle of slabs.
 *
 * Faded out by `fwidth` once a slab is under ~3 px: a per-pixel hash has no mip
 * chain, and left running at skyline distance it is pure aliasing noise.
 */
function macroSlab(cells, tone, rough) {
  const C = cells.toFixed(1);
  return /* glsl */ `
  #ifdef USE_MAP
  {
    vec2 sc = vMapUv * ${C};
    float px = max( fwidth( sc.x ), fwidth( sc.y ) );
    float aa = 1.0 - smoothstep( 0.28, 0.80, px );
    if ( aa > 0.003 ) {
      float rowIn = floor( sc.y ) - floor( sc.y / ${C} ) * ${C};
      float shift = mod( ${(cells - 1).toFixed(1)} - rowIn, 2.0 ) * 0.5;
      vec2 cell = vec2( floor( sc.x - shift ), floor( sc.y ) );
      vec3 p3 = fract( cell.xyx * vec3( 0.1031, 0.1030, 0.0973 ) );
      p3 += dot( p3, p3.yzx + 33.33 );
      vec2 hh = fract( ( p3.xx + p3.yz ) * p3.zy );
      diffuseColor.rgb *= 1.0 + ( hh.x - 0.5 ) * ${tone.toFixed(4)} * aa;
      // One slab in fifteen was lifted and relaid out of a different batch.
      diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 1.09, 1.035, 0.90 ),
                               step( 0.935, hh.y ) * 0.6 * aa );
      mcSlabR = ( hh.y - 0.5 ) * ${rough.toFixed(4)} * aa;
    }
  }
  #endif
`;
}

/**
 * Turf that has been walked off.
 *
 * A lawn is never uniformly a lawn: there is a bald ring under every tree, a
 * strip worn along the line people actually take, and a scorched patch where
 * the irrigation does not reach. Keyed on the world field's low tail, so the
 * worn ground is continuous across every separate lawn mesh in the park and
 * has no relationship to the grass tile.
 */
function macroWear(hex, threshold, strength) {
  const c = linTriple(hex);
  return /* glsl */ `
  {
    float wk = smoothstep( ${threshold.toFixed(3)}, ${(threshold + 0.30).toFixed(3)}, -mcT )
             * ${strength.toFixed(4)};
    diffuseColor.rgb = mix( diffuseColor.rgb,
      vec3( ${c[0].toFixed(4)}, ${c[1].toFixed(4)}, ${c[2].toFixed(4)} )
      * ( 0.86 + mcF.b * 0.55 ), wk );
  }
`;
}

/** Optional: mown-lawn banding. Only injected for surfaces that ask for it. */
const MACRO_STRIPE = /* glsl */ `
  {
    // The phase wanders with the broad band, so the bands bend and fade in and
    // out instead of striping the entire city in one direction.
    float ph = dot( mcUV, uMacroB.zw ) * uMacroB.x + mcF.r * 9.0;
    float band = sin( ph ) * ( 0.55 + mcF.g );
    diffuseColor.rgb *= 1.0 + band * uMacroB.y;
  }
`;

/**
 * Optional: a gradient up the building.
 *
 * A real tower is not one colour from podium to crown. Glass high up mirrors
 * the zenith and reads bright and cool; glass near the street mirrors the city
 * and reads dark and warm. Masonry just gets grubbier the lower you go. Both
 * are the same ramp with different constants, and it is the cheapest way to put
 * depth into a skyline made of extruded prisms.
 */
const MACRO_HEIGHT = /* glsl */ `
  {
    float hk = clamp( vMacroPos.y * uMacroC.x, 0.0, 1.0 );
    hk = ( hk * hk * ( 3.0 - 2.0 * hk ) ) - 0.35;   // pivot below mid-height
    diffuseColor.rgb *= 1.0 + hk * uMacroC.y;
    diffuseColor.rgb *= vec3( 1.0 - hk * uMacroC.z * 0.7, 1.0, 1.0 + hk * uMacroC.z );
  }
`;

const MACRO_ROUGH = /* glsl */ `
  roughnessFactor = clamp(
    roughnessFactor * ( 1.0 + ( mcF.g * 0.7 + mcF.b ) * uMacroA.z + mcSlabR ), 0.045, 1.0 );
`;

/**
 * Per-surface tuning. Keyed on the `family` tag `pack()` stamps onto a colour
 * map, so a caller that just asks for `Textures.grass()` gets lawn-grade
 * variation without knowing this exists.
 *
 *   m         world size of one field tile, metres
 *   a         peak brightness swing (the field is normalised to +-0.5)
 *   r         roughness swing — this is where wet/dry and polish live
 *   h         warm/cool drift
 *   stripe    [1/metres, strength, angle deg] for mown banding
 *   rise      [metres, value ramp, hue ramp] gradient up a building
 *   far       [scale, cross-fade] second world band, see macroFar
 *   detail    [uv scale, weight] second read of the map itself, see macroDetail
 *   slab      [tone, roughness] per-slab world hash, see macroSlab. Needs the
 *             texture to have declared its `cells`.
 *   wear      [colour, threshold, strength] walked-off turf, see macroWear
 *
 * COST. `far` and `detail` are one extra texture fetch each. They are on for
 * the five surfaces that fill the frame and off for everything else: a facade
 * is a few hundred square metres seen once, and it does not have a repeat
 * problem worth a fetch.
 */
const MACRO = {
  //                metres albedo rough  hue
  asphalt: {
    m: 88, a: 0.31, r: 0.42, h: 0.055,
    far: [3.10, 0.44], detail: [0.3413, 1.35],
  },
  paving: {
    m: 71, a: 0.24, r: 0.38, h: 0.048,
    far: [3.10, 0.40], slab: [0.115, 0.26],
  },
  // Turf is the one surface where big albedo variation is not a defect: a lawn
  // really is a patchwork, and a flat green plane is the fakest thing in frame.
  grass: {
    m: 57, a: 0.52, r: 0.24, h: 0.105, stripe: [7.5, 0.052, 24],
    far: [2.70, 0.38], detail: [0.3830, 0.85],
    wear: [PALETTE.GRASS_WORN, 0.52, 0.55],
  },
  sand: {
    m: 66, a: 0.26, r: 0.30, h: 0.060,
    far: [2.90, 0.38], detail: [0.3627, 0.75],
  },
  concrete: { m: 46, a: 0.19, r: 0.30, h: 0.040, far: [3.30, 0.34] },
  rooftop: {
    m: 49, a: 0.30, r: 0.42, h: 0.055,
    far: [3.00, 0.40], detail: [0.3471, 1.05],
  },
  wood:      { m: 38, a: 0.20, r: 0.32, h: 0.050 },
  brick:     { m: 44, a: 0.17, r: 0.28, h: 0.040, rise: [125, 0.15, 0.03] },
  facade:    { m: 52, a: 0.13, r: 0.26, h: 0.032, rise: [125, 0.17, 0.035] },
  // Glass must NOT get an albedo wobble — a curtain wall is machine-made and
  // blotchy glass reads as dirt on the lens. It gets a roughness break, which
  // shows up as some sheets being cleaner than others, plus the height ramp:
  // the crown mirrors the zenith, the podium mirrors the street.
  glass:     { m: 60, a: 0.03, r: 0.34, h: 0.008, rise: [175, 0.34, 0.10] },
  default:   { m: 78, a: 0.18, r: 0.30, h: 0.042 },
};

const _macroMats = [];

/**
 * Patch a material with the world-space breakup. Chains onto whatever
 * onBeforeCompile is already there (the hole cutter, usually).
 */
function worldDetail(material, family = 'default', gain = 1) {
  if (material.userData.__macro) return material;
  const t = MACRO[family] || MACRO.default;
  material.userData.__macro = family;

  const uA = { value: new THREE.Vector4(1 / t.m, t.a * gain, t.r * gain, t.h * gain) };
  const uMap = { value: Textures.macroField() };
  let uB = null;
  if (t.stripe) {
    const rad = (t.stripe[2] * Math.PI) / 180;
    uB = { value: new THREE.Vector4(t.stripe[0], t.stripe[1] * gain, Math.cos(rad), Math.sin(rad)) };
  }
  let uC = null;
  if (t.rise) {
    uC = { value: new THREE.Vector4(1 / t.rise[0], t.rise[1] * gain, t.rise[2] * gain, 0) };
  }
  material.userData.macroUniforms = { uMacroA: uA, uMacroB: uB, uMacroC: uC };

  /*
   * Everything below is baked into the shader SOURCE rather than into a
   * uniform. It is all constant for the life of the material — the family's
   * tuning row, the caller's gain, and two properties of the texture — and the
   * alternative is five more vec4s on every ground draw for numbers that never
   * move. The cost is that `gain` and the texture now have to appear in the
   * program cache key; see `tag` at the bottom.
   */
  const ud = (material.map && material.map.userData) || {};
  const far = t.far ? macroFar(t.far[0], t.far[1]) : '';
  const detail = (t.detail && material.map && ud.meanLuma)
    ? macroDetail(t.detail[0], t.detail[1] * gain, ud.meanLuma) : '';
  const slab = (t.slab && material.map && ud.cells)
    ? macroSlab(ud.cells, t.slab[0] * gain, t.slab[1] * gain) : '';
  const wear = t.wear ? macroWear(t.wear[0], t.wear[1], t.wear[2] * gain) : '';

  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    shader.uniforms.uMacroMap = uMap;
    shader.uniforms.uMacroA = uA;
    if (uB) shader.uniforms.uMacroB = uB;
    if (uC) shader.uniforms.uMacroC = uC;

    const pars = MACRO_PARS
      + (uB ? 'uniform vec4 uMacroB;\n' : '')
      + (uC ? 'uniform vec4 uMacroC;\n' : '');
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${pars}`)
      .replace('#include <project_vertex>', `${MACRO_VERTEX}\n#include <project_vertex>`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${pars}`)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>\n${MACRO_HEAD}${far}${MACRO_BODY}`
        + `${uB ? MACRO_STRIPE : ''}${uC ? MACRO_HEIGHT : ''}`
        + `${detail}${slab}${wear}`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>\n${MACRO_ROUGH}`
      );
  };

  // The hole cutter pins a constant cache key; two materials whose injected
  // source differs must not share a compiled program. Since the gain and the
  // texture's own constants are now literals in that source, they are part of
  // the identity of the program and have to be in the key.
  const prevKey = material.customProgramCacheKey;
  const tag = `macro-${family}-${gain.toFixed(2)}-${uB ? 's' : ''}${uC ? 'r' : ''}`
    + `${far ? 'F' : ''}${wear ? 'W' : ''}`
    + `${detail ? `D${Math.round(ud.meanLuma * 1000)}` : ''}`
    + `${slab ? `S${ud.cells}` : ''}`;
  material.customProgramCacheKey = () => (prevKey ? prevKey.call(material) : '') + '|' + tag;
  material.needsUpdate = true;
  _macroMats.push(material);
  return material;
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
  /** Boot cost of every generator that has run, for the budget report. */
  stats() {
    return {
      ms: Math.round(_stats.ms),
      generators: _stats.count,
      envMs: _stats.envMs || 0,
      byKey: { ..._stats.byKey },
    };
  },

  /**
   * The world-space breakup field (see `worldDetail`).
   *
   * Three decorrelated, seamless fBm bands in RGB so one fetch buys three
   * scales of variation. Each band is stretched to the full 0..1 range —
   * un-stretched fBm sits in the middle third and would deliver a third of the
   * contrast the tuning table asks for.
   *
   * 256 px over a ~70 m tile is 27 cm/texel. That is deliberately coarse: this
   * field exists to survive minification, and anything finer is the surface
   * map's job.
   */
  macroField(size = 256) {
    return cached(`tex-macro-${size}`, () => {
      const rand = mulberry32(0x6b1f22d);
      // cells 2/7/23 over the tile -> features at roughly 1/2, 1/8 and 1/25 of
      // it. Deliberately non-harmonic so the three bands never line up into a
      // single visible blob.
      const broad = normalise(fbm(size, 2, 2, rand));
      const mid = normalise(fbm(size, 7, 2, rand));
      const fine = normalise(fbm(size, 23, 2, rand));

      const c = canvas(size);
      const g = ctx2d(c);
      const img = g.createImageData(size, size);
      const d = img.data;
      for (let i = 0, o = 0; i < size * size; i++, o += 4) {
        d[o] = broad[i] * 255;
        d[o + 1] = mid[i] * 255;
        d[o + 2] = fine[i] * 255;
        d[o + 3] = 255;
      }
      g.putImageData(img, 0, 0);

      const t = new THREE.CanvasTexture(c);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.NoColorSpace;   // a modulation field, not a colour
      t.anisotropy = 1;                    // it is never seen at a grazing scale
      t.needsUpdate = true;
      return t;
    });
  },

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

      // A 9 m tile at 512 px. Feature sizes in metres, so the choice of `cells`
      // is a real decision rather than a knob:
      //   cells  3 -> 3.0 m paving runs   (survives to 400 m)
      //   cells  7 -> 1.3 m chip clusters (survives to ~120 m)
      //   cells 24 -> 37 cm patches       (gone past ~50 m)
      //   cells/4 -> 7 cm aggregate       (only for the normal map)
      // Three octaves rather than two on the coarse band: a two-octave field
      // off a 2x2 lattice is one light blob and one dark blob, and THAT is a
      // countable repeat on the tile grid. The extra octaves break the shape
      // without adding another period.
      const macro = normalise(fbm(size, 3, 3, rand));  // paving runs
      const band = normalise(fbm(size, 7, 2, rand));   // chip clusters
      const mid = fbm(size, 24, 2, rand);
      // 18 cm chippings. The 7 cm `grit` band below is what a chip seal
      // actually is, but at the gameplay camera 7 cm is a third of a pixel and
      // all it contributes is shimmer; this band is the coarsest thing that
      // still reads as individual stone rather than as tone, and it is what
      // gives the normal map something the sun can catch.
      const chip = fbm(size, size >> 3, 2, rand);
      const grit = fbm(size, size >> 2, 2, rand);

      const col = canvas(size);
      const gc = paintBase(col, size, base, [
        // The two coarse bands carry most of the visible tonal life, because
        // they are the only ones with any chance of surviving the mip chain.
        // A road that varies in HUE reads as mud; one that varies in VALUE
        // reads as asphalt, so the tints are barely off neutral.
        { f: macro, amp: 0.120, tint: [1.10, 1.0, 0.86] },
        { f: band, amp: 0.112, tint: [1.02, 1.0, 0.96] },
        // Everything under half a metre is HALVED from what it was. At 40 m the
        // old settings rendered as an even sandpaper hiss over the whole
        // carriageway — technically aggregate, visually video noise, and the
        // art bible is explicit that detail comes from shape and light rather
        // than from a busy albedo. The energy moved up into the two bands above
        // and into the world-space layers in worldDetail().
        { f: mid, amp: 0.038 },
        { f: grit, amp: 0.046, tint: [1.0, 0.99, 0.97] },
      ]);

      const hgt = canvas(size);
      const gh = paintGrey(hgt, size, 128, [
        { f: grit, amp: 0.80 },
        { f: chip, amp: 0.55 },
        { f: mid, amp: 0.30 },
        { f: band, amp: 0.22 },
        { f: macro, amp: 0.18 },
      ]);

      const rgh = canvas(size);
      const gr = paintGrey(rgh, size, 236, [
        { f: band, amp: 0.30 },
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
        // Backed off from 0.22: this was the single biggest reason the
        // carriageway sat only four percent below the sidewalk in value. Six
        // overlapping lifts at 0.22 each is a road painted lighter than the
        // colour it was authored as.
        polish(gc, css(srgb(PALETTE.ASPHALT_LIGHT), 0.13));
        polish(gr, 'rgba(176,176,176,0.6)');
      }

      /* Chip-seal shading: the gaps BETWEEN the coarse chippings are in
         permanent shadow, and that is what makes a chip seal read as stone
         rather than as a grey sheet. Multiplied on at the end so it darkens the
         seams and the repairs too, exactly as the real thing does. Tied to the
         same field that drives the normal map, so the dark is always in the
         hollows and the two channels agree under any sun angle. */
      {
        const chipN = normalise(chip);
        const img = gc.getImageData(0, 0, size, size);
        const d = img.data;
        for (let i = 0, o = 0; i < size * size; i++, o += 4) {
          const k = 1 - Math.max(0, 0.52 - chipN[i]) * 0.30;
          d[o] *= k; d[o + 1] *= k; d[o + 2] *= k;
        }
        gc.putImageData(img, 0, 0);
      }

      /* NOTE for anyone tempted to add wheel tracks here: UVs on this surface
         are world XZ, so a stripe at constant u runs north-south on EVERY
         road. It would read as a wheel path on the avenues and as a transverse
         resurfacing band, repeating every 9 m, on the cross streets. Wheel
         polish has to stay isotropic (the soft sweeps above) unless it is
         drawn per-road in streets.js where the direction is known. */

      // normalScale down from 0.9: with the 18 cm chip band now in the height
      // field there is more relief to catch, and the 7 cm grain was the other
      // half of the shimmer the albedo rebalance above was fixing.
      return pack(col, hgt, rgh, size, {
        normalStrength: 1.35, normalScale: 0.76, family: 'asphalt',
      });
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

      const macro = normalise(fbm(size, 3, 3, rand));  // pour-to-pour tone
      const mid = fbm(size, 16, 3, rand);
      const fine = fbm(size, size >> 3, 2, rand);
      // Blowholes and sand-streaks off the form face. Direction-free, so it is
      // the one thing this generator can push hard without striping the bridge
      // decks and park paths that share it.
      const pit = contrast(fbm(size, size >> 2, 1, rand), 2.4);

      const col = canvas(size);
      const gc = paintBase(col, size, rgb, [
        { f: macro, amp: 0.075, tint: [1.1, 1.0, 0.85] },
        { f: mid, amp: 0.035 },
        { f: fine, amp: 0.03 },
        { f: pit, amp: 0.028 },
      ]);
      const hgt = canvas(size);
      const gh = paintGrey(hgt, size, 128, [
        { f: pit, amp: 0.70 },
        { f: fine, amp: 0.55 },
        { f: mid, amp: 0.35 },
      ]);
      const rgh = canvas(size);
      const gr = paintGrey(rgh, size, 232, [{ f: mid, amp: 0.16 }, { f: macro, amp: 0.18 }]);

      /* Board-form marks: cast concrete is poured against plywood in courses
         and keeps the joint for life — a hairline recess with a lip of grout
         bleed under it. That mark is what says "cast in place" rather than
         "grey box".
         Held DELIBERATELY faint. The same generator dresses the seawall and
         the podiums (vertical, where this reads perfectly) and the bridge
         decks and park paths (horizontal, world-UV, where the same lines
         would stripe the ground). Six courses per tile and a whisper of
         albedo is the setting that helps the walls without hurting the paths. */
      const courses = 6;
      for (let i = 0; i <= courses; i++) {
        const y = i * (size / courses) + (rand() - 0.5) * 3;
        gc.fillStyle = 'rgba(112,102,86,0.11)'; gc.fillRect(0, y, size, 1.8);
        gc.fillStyle = 'rgba(255,250,238,0.09)'; gc.fillRect(0, y + 1.8, size, 1.4);
        gh.fillStyle = 'rgba(70,70,70,0.7)'; gh.fillRect(0, y, size, 1.8);
        gh.fillStyle = 'rgba(196,196,196,0.5)'; gh.fillRect(0, y + 1.8, size, 1.4);
        gr.fillStyle = 'rgba(255,255,255,0.10)'; gr.fillRect(0, y, size, 3.2);
      }

      /* Pour lines: the deeper day-joints between whole lifts. */
      for (let i = 0; i < 3; i++) {
        const y = (i + 0.5) * (size / 3) + (rand() - 0.5) * 20;
        gc.fillStyle = 'rgba(120,110,94,0.16)'; gc.fillRect(0, y, size, 2.4);
        gh.fillStyle = 'rgba(72,72,72,0.75)'; gh.fillRect(0, y, size, 2.4);
      }

      /* Form-tie pockets, on the course lines where the ties actually are —
         and the rust bleed running out of the ones that were never made good.
         Two tones of ochre over three centimetres is a tiny mark, but it is the
         difference between concrete that has stood in salt air for thirty years
         and concrete that was extruded this morning. */
      for (let i = 0; i < 30; i++) {
        const x = rand() * size;
        const y = Math.round(rand() * courses) * (size / courses) + (size / courses) * 0.5;
        const r = 1.8 + rand() * 1.4;
        if (rand() < 0.34) {
          const h = r * (5 + rand() * 14);
          const bleed = gc.createLinearGradient(0, y, 0, y + h);
          bleed.addColorStop(0, 'rgba(150,96,52,0.30)');
          bleed.addColorStop(0.25, 'rgba(158,112,66,0.16)');
          bleed.addColorStop(1, 'rgba(158,112,66,0)');
          gc.fillStyle = bleed;
          gc.fillRect(x - r * 1.1, y, r * 2.2, h);
        }
        gc.fillStyle = 'rgba(120,110,94,0.22)';
        gc.beginPath(); gc.arc(x, y, r, 0, 7); gc.fill();
        gh.fillStyle = 'rgba(60,60,60,0.9)';
        gh.beginPath(); gh.arc(x, y, r, 0, 7); gh.fill();
      }

      /* Rain streaking under the top edge — reads as vertical on facades. */
      for (let i = 0; i < 14; i++) {
        const x = rand() * size;
        const w = 3 + rand() * 14;
        const h = size * (0.2 + rand() * 0.7);
        const grad = gc.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, 'rgba(126,116,98,0.20)');
        grad.addColorStop(1, 'rgba(126,116,98,0)');
        gc.fillStyle = grad;
        gc.save(); gc.translate(x, 0); gc.fillRect(0, 0, w, h); gc.restore();
        gr.fillStyle = 'rgba(255,255,255,0.12)';
        gr.fillRect(x, 0, w, h);
      }

      return pack(col, hgt, rgh, size, {
        normalStrength: 0.8, normalScale: 0.65, normalSize: 256, family: 'concrete',
      });
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

      const macro = normalise(fbm(size, 3, 3, rand));
      const fine = fbm(size, size >> 3, 2, rand);
      const grain = fbm(size, size >> 2, 1, rand);

      const col = canvas(size);
      const gc = paintBase(col, size, rgb, [
        { f: macro, amp: 0.065, tint: [1.12, 1.0, 0.82] },
        { f: fine, amp: 0.03 },
        { f: grain, amp: 0.035 },
      ]);
      const hgt = canvas(size);
      const gh = paintGrey(hgt, size, 132, [{ f: grain, amp: 0.35 }, { f: fine, amp: 0.25 }]);
      const rgh = canvas(size);
      const gr = paintGrey(rgh, size, 226, [{ f: macro, amp: 0.20 }, { f: fine, amp: 0.10 }]);

      const step = size / cells;

      /*
       * SLAB LAYOUT
       * A perfect NxN grid is the tell that this is a texture: real paving is
       * laid in courses that break joint, and the eye reads that offset long
       * before it reads any individual slab. Alternate rows are shifted by half
       * a slab, and every row gets its own sub-slab jitter, so no two courses
       * line up and the vertical joints never form a continuous line across
       * the tile. `shift` still lands on a whole number of half-slabs, which is
       * what keeps the pattern seamless at the tile edge.
       */
      const rowShift = [];
      for (let j = 0; j < cells; j++) rowShift.push((j % 2) * 0.5);

      /*
       * Per-slab tone — MOSTLY MOVED OUT OF THE TEXTURE.
       *
       * The mosaic of light and dark slabs is the strongest thing a sidewalk
       * has, and baking it here meant the same twenty slabs in the same order
       * every 4.8 m down every block. `macroSlab` in worldDetail() now hashes
       * the tone off the slab's WORLD index instead, so no two slabs in the
       * city agree by accident. What is left baked is a third of the old
       * amplitude, kept because the shader hash fades out with distance and
       * something has to hold the surface together when it does.
       *
       * Each slab is painted at x AND x-size. Only the last one in an offset
       * row has its second copy on canvas — but that copy is the other half of
       * the slab that straddles the tile edge, and painting it separately with
       * a fresh random tone is a visible tonal seam every few metres.
       */
      for (let j = 0; j < cells; j++) {
        const off = rowShift[j] * step;
        for (let i = 0; i < cells; i++) {
          const v = (rand() - 0.5) * 2;
          const x = i * step + off;
          gc.fillStyle = v > 0
            ? `rgba(255,247,228,${v * 0.040})`
            : `rgba(92,84,68,${-v * 0.036})`;
          gc.fillRect(x, j * step, step, step);
          gc.fillRect(x - size, j * step, step, step);
          gr.fillStyle = v > 0 ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)';
          gr.fillRect(x, j * step, step, step);
          gr.fillRect(x - size, j * step, step, step);
        }
      }

      /*
       * Broom finish. Wet concrete is dragged with a stiff brush before it
       * goes off, and the direction is whatever way the man laying that course
       * was walking — so it alternates course to course and the sheen flips
       * with it. Height only: in albedo this is a moiré generator, in the
       * normal map it is the reason one course catches the sun and the next
       * one does not, which is worth more than any amount of albedo mottle.
       */
      gh.lineWidth = 0.9;
      for (let j = 0; j < cells; j++) {
        const y0 = j * step, y1 = y0 + step;
        const across = j % 2 === 0;
        const span = across ? step : size;
        const n = Math.max(4, Math.round(span / 3.4));
        for (let k = 0; k < n; k++) {
          const t = (k + 0.35 + rand() * 0.3) / n;
          gh.strokeStyle = rand() < 0.5
            ? 'rgba(206,206,206,0.30)' : 'rgba(56,56,56,0.24)';
          gh.beginPath();
          if (across) { const y = y0 + t * step; gh.moveTo(0, y); gh.lineTo(size, y); }
          else { const x = t * size; gh.moveTo(x, y0); gh.lineTo(x, y1); }
          gh.stroke();
        }
      }

      /*
       * JOINTS. Widened from a hairline to ~5 cm of world.
       * What you see of a slab joint from 40 m is not the 8 mm sealant gap, it
       * is the chamfered arris either side of it — a dark band three or four
       * times the gap. Drawing the true gap width makes a sidewalk that is
       * technically correct and visually blank, which is what it was.
       */
      const jointW = Math.max(2.2, step * 0.085);
      gc.strokeStyle = typeof line === 'string' ? line : css(srgb(PALETTE.SIDEWALK_JOINT), 0.55);
      gc.lineWidth = jointW;
      gh.strokeStyle = 'rgba(40,40,40,0.95)';
      gh.lineWidth = jointW;
      gr.strokeStyle = 'rgba(252,252,252,0.65)';
      gr.lineWidth = jointW;
      /* Course joints run right across; cross joints only within their row. */
      for (let j = 0; j <= cells; j++) {
        for (const g of [gc, gh, gr]) {
          g.beginPath(); g.moveTo(0, j * step); g.lineTo(size, j * step); g.stroke();
        }
      }
      /* The cross-joint set {off + i*step} is already periodic modulo `size`,
         so cells of them cover the row exactly once with no seam. */
      for (let j = 0; j < cells; j++) {
        const off = rowShift[j] * step;
        for (let i = 0; i < cells; i++) {
          const x = i * step + off;
          for (const g of [gc, gh, gr]) {
            g.beginPath(); g.moveTo(x, j * step); g.lineTo(x, (j + 1) * step); g.stroke();
          }
        }
      }

      /* Worn arrises: the top edge of each slab is chipped and catches light. */
      const chamfer = Math.max(1.4, step * 0.05);
      gh.strokeStyle = 'rgba(198,198,198,0.6)';
      gh.lineWidth = chamfer;
      for (let j = 0; j <= cells; j++) {
        gh.beginPath(); gh.moveTo(0, j * step - jointW); gh.lineTo(size, j * step - jointW); gh.stroke();
      }
      for (let j = 0; j < cells; j++) {
        const off = rowShift[j] * step;
        for (let i = 0; i < cells; i++) {
          const x = i * step + off - jointW;
          gh.beginPath(); gh.moveTo(x, j * step); gh.lineTo(x, (j + 1) * step); gh.stroke();
        }
      }

      /* Corner wear + a couple of faint stains. */
      for (let j = 0; j < cells; j++) {
        const off = rowShift[j] * step;
        for (let i = 0; i < cells; i++) {
          if (rand() > 0.4) continue;
          const cx = i * step + off;
          const cy = (j + (rand() < 0.5 ? 0 : 1)) * step;
          const r = step * (0.12 + rand() * 0.14);
          wrapped(gc, size, () => {
            const rg = gc.createRadialGradient(cx, cy, 0, cx, cy, r);
            rg.addColorStop(0, 'rgba(118,108,90,0.22)');
            rg.addColorStop(1, 'rgba(118,108,90,0)');
            gc.fillStyle = rg;
            gc.beginPath(); gc.arc(cx, cy, r, 0, 7); gc.fill();
          });
        }
      }
      /* Damp / dirt patches, metres across so they still read from the air. */
      for (let i = 0; i < 5; i++) {
        const x = rand() * size, y = rand() * size, r = size * (0.10 + rand() * 0.16);
        wrapped(gc, size, () => {
          const rg = gc.createRadialGradient(x, y, 0, x, y, r);
          rg.addColorStop(0, 'rgba(126,114,92,0.17)');
          rg.addColorStop(1, 'rgba(126,114,92,0)');
          gc.fillStyle = rg; gc.beginPath(); gc.arc(x, y, r, 0, 7); gc.fill();
        });
        wrapped(gr, size, () => {
          const rg = gr.createRadialGradient(x, y, 0, x, y, r);
          rg.addColorStop(0, 'rgba(120,120,120,0.5)');
          rg.addColorStop(1, 'rgba(120,120,120,0)');
          gr.fillStyle = rg; gr.beginPath(); gr.arc(x, y, r, 0, 7); gr.fill();
        });
      }

      /* A few cracked and spalled slabs. One in twelve, height-led with only a
         whisper of albedo, because a black line drawn on a slab reads as a
         drawing and a crevice that catches a shadow reads as concrete. */
      for (let j = 0; j < cells; j++) {
        const off = rowShift[j] * step;
        for (let i = 0; i < cells; i++) {
          if (rand() > 0.085) continue;
          const x0 = i * step + off + step * (0.15 + rand() * 0.3);
          const y0 = j * step + step * 0.04;
          const seed = rand() * 1000;
          gh.strokeStyle = 'rgba(48,48,48,0.85)'; gh.lineWidth = 1.5;
          gc.strokeStyle = 'rgba(104,96,80,0.16)'; gc.lineWidth = 1.3;
          for (const g of [gh, gc]) {
            g.save();
            g.beginPath(); g.rect(i * step + off, j * step, step, step); g.clip();
            meander(g, size, x0, y0, step * 1.25, 4, 0.85, mulberry32(seed));
            g.restore();
            g.save();
            g.beginPath(); g.rect(i * step + off - size, j * step, step, step); g.clip();
            g.translate(-size, 0);
            meander(g, size, x0, y0, step * 1.25, 4, 0.85, mulberry32(seed));
            g.restore();
          }
        }
      }

      // `cells` travels with the texture so macroSlab() can line its world-space
      // hash up with the grid that was actually painted here.
      return pack(col, hgt, rgh, size, {
        normalStrength: 1.25, normalScale: 0.85, family: 'paving', cells,
      });
    });
  },

  /** Mown lawn. Clumpy, saturated, with blade-scale normal detail. */
  grass(size = 512) {
    return cached(`tex-grass-${size}`, () => {
      const rand = mulberry32(0x7c1b44);
      const base = srgb(PALETTE.GRASS);
      const dark = srgb(PALETTE.GRASS_DARK);
      const light = srgb(PALETTE.GRASS_LIGHT);

      // A lawn tile is 6-8 m. `cells: 2` puts the loudest band at 3-4 m, which
      // is the only scale that still exists once the camera is 150 m up.
      const patchy = normalise(fbm(size, 3, 3, rand));
      const clump = contrast(fbm(size, 6, 3, rand), 1.5);
      const mid = fbm(size, 22, 2, rand);
      const blade = fbm(size, size >> 2, 2, rand);

      // Lawn is one of the few surfaces where LOUD albedo variation is correct:
      // real turf is a patchwork of light and dark clumps, and a flat green
      // plane is the most obviously fake thing in a toy city.
      const spread = [(light[0] - dark[0]) / 150, (light[1] - dark[1]) / 150, (light[2] - dark[2]) / 150];
      const col = canvas(size);
      const gc = paintBase(col, size, base, [
        { f: patchy, amp: 0.40, tint: spread },
        { f: clump, amp: 0.34, tint: spread },
        // Turf shifts hue as well as value — thin, hungry grass goes yellow,
        // thick shaded grass goes blue-green. Driving the two bands in opposite
        // hue directions is what stops it reading as one green with a dimmer.
        { f: mid, amp: 0.20, tint: [0.6, 1.0, 0.5] },
        { f: patchy, amp: 0.16, tint: [1.1, 0.45, -0.4] },
        { f: blade, amp: 0.12, tint: [0.7, 1.0, 0.6] },
      ]);
      const hgt = canvas(size);
      paintGrey(hgt, size, 128, [{ f: blade, amp: 0.9 }, { f: mid, amp: 0.45 }]);
      const rgh = canvas(size);
      paintGrey(rgh, size, 240, [{ f: clump, amp: 0.14 }, { f: patchy, amp: 0.16 }]);

      /* Sun-scorched patches — Miami lawns are never uniformly green. Bigger
         and stronger than before: at 2-4 m across they survive to the horizon,
         and they are the difference between "lawn" and "green paint". */
      const dry = srgb(PALETTE.GRASS_DRY);
      for (let i = 0; i < 7; i++) {
        const x = rand() * size, y = rand() * size, r = size * (0.10 + rand() * 0.20);
        wrapped(gc, size, () => {
          const rg = gc.createRadialGradient(x, y, 0, x, y, r);
          rg.addColorStop(0, css(dry, 0.40));
          rg.addColorStop(0.55, css(dry, 0.16));
          rg.addColorStop(1, css(dry, 0));
          gc.fillStyle = rg; gc.beginPath(); gc.arc(x, y, r, 0, 7); gc.fill();
        });
      }
      /* ...and the opposite: lush, over-watered dark patches near the sprinklers. */
      for (let i = 0; i < 5; i++) {
        const x = rand() * size, y = rand() * size, r = size * (0.09 + rand() * 0.16);
        wrapped(gc, size, () => {
          const rg = gc.createRadialGradient(x, y, 0, x, y, r);
          rg.addColorStop(0, css(dark, 0.34));
          rg.addColorStop(1, css(dark, 0));
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

      return pack(col, hgt, rgh, size, {
        normalStrength: 1.3, normalScale: 0.9, family: 'grass',
      });
    });
  },

  /** Beach / bunker sand: wind ripples plus grain sparkle. */
  sand(size = 512) {
    return cached(`tex-sand-${size}`, () => {
      const rand = mulberry32(0x5aa207);
      const base = srgb(PALETTE.SAND);
      const wet = srgb(PALETTE.SAND_WET);

      const dune = normalise(fbm(size, 3, 3, rand));
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
      const gc = paintBase(col, size, base, [
        // Damp sand is a lot darker than dry sand and the boundary between them
        // wanders in metre-scale lobes. That is the read from any distance.
        { f: dune, amp: 0.24, tint: [(wet[0] - base[0]) / 180, (wet[1] - base[1]) / 180, (wet[2] - base[2]) / 180] },
        { f: ripple, amp: 0.05 },
        { f: grain, amp: 0.07 },
      ]);
      const hgt = canvas(size);
      paintGrey(hgt, size, 128, [{ f: ripple, amp: 0.75 }, { f: grain, amp: 0.5 }, { f: dune, amp: 0.4 }]);
      const rgh = canvas(size);
      // Damp sand is also much glossier than dry sand: the strongest cue there
      // is, and it costs one extra band.
      paintGrey(rgh, size, 244, [{ f: dune, amp: 0.34 }]);

      /* Scuffs: footfall churns the ripples flat and lifts drier sand. */
      for (let i = 0; i < 9; i++) {
        const x = rand() * size, y = rand() * size, r = size * (0.03 + rand() * 0.07);
        wrapped(gc, size, () => {
          const rg = gc.createRadialGradient(x, y, 0, x, y, r);
          rg.addColorStop(0, 'rgba(255,246,220,0.20)');
          rg.addColorStop(1, 'rgba(255,246,220,0)');
          gc.fillStyle = rg; gc.beginPath(); gc.arc(x, y, r, 0, 7); gc.fill();
        });
      }

      // Full-res normal: sand is all grain sparkle, and that is the first thing
      // a half-resolution normal map throws away.
      return pack(col, hgt, rgh, size, {
        normalStrength: 1.0, normalScale: 0.8, family: 'sand',
      });
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

        /* Opaque spandrel band hiding the floor slab. Darkened and given a
           hard shadow under the transom: at skyline distance the mullion grid
           is sub-pixel and THIS band is the only thing left carrying the
           storey rhythm, so it has to be the strongest mark on the facade. */
        const sy = yTop + visionH;
        gc.fillStyle = css(mix(spandrel, tint, 0.28));
        gc.fillRect(0, sy, size, spandrelH);
        const sg = gc.createLinearGradient(0, sy, 0, sy + spandrelH);
        sg.addColorStop(0.0, 'rgba(10,18,24,0.42)');   // shadow cast by the transom
        sg.addColorStop(0.22, 'rgba(255,255,255,0.14)');
        sg.addColorStop(1.0, 'rgba(0,0,0,0.26)');
        gc.fillStyle = sg; gc.fillRect(0, sy, size, spandrelH);
        gh.fillStyle = 'rgb(96,96,96)'; gh.fillRect(0, sy, size, spandrelH);
        gr.fillStyle = 'rgb(228,228,228)'; gr.fillRect(0, sy, size, spandrelH);
      }

      /* Mullions: raised aluminium ribs. Horizontal transoms read heavier than
         the vertical mullions, which is how real curtain wall looks.
         Each rib gets a lit edge and a shadow edge rather than being one flat
         stroke — that pair is what makes the grid read as extruded metal
         instead of as a drawn line, and it survives one more mip level. */
      const mvW = Math.max(1.2, bw * 0.055);
      const mhW = Math.max(1.6, fh * 0.055);
      const drawRibs = (horiz) => {
        const n = horiz ? floors : bays;
        const p = horiz ? fh : bw;
        const w = horiz ? mhW : mvW;
        for (let i = 0; i <= n; i++) {
          const a = i * p;
          const put = (g, style, o, t) => {
            g.fillStyle = style;
            if (horiz) g.fillRect(0, a + o, size, t); else g.fillRect(a + o, 0, t, size);
          };
          put(gc, css(mullion, 0.90), -w * 0.5, w);
          put(gc, 'rgba(255,255,255,0.34)', -w * 0.5, Math.max(0.8, w * 0.32));
          put(gc, 'rgba(16,26,34,0.40)', w * 0.5, Math.max(0.8, w * 0.34));
          put(gh, 'rgb(232,232,232)', -w * 0.5, w);
          put(gh, 'rgb(40,40,40)', w * 0.5, Math.max(0.8, w * 0.34));
          put(gr, 'rgb(206,206,206)', -w * 0.5, w);   // brushed alu, not glass
        }
      };
      drawRibs(true);
      drawRibs(false);

      return pack(col, hgt, rgh, size, {
        normalStrength: 0.9, normalScale: 0.7, normalSize: 256, family: 'glass',
      });
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
        { f: patch, amp: 0.055, tint: [1.05, 1.0, 0.92] },
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

      return pack(col, hgt, rgh, size, {
        normalStrength: 1.1, normalScale: 0.8, normalSize: 256, family: 'facade',
      });
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
      /* Illegible "lettering": blocks, not text — text at this size is mush.
         The neon colour varies per shop: one aqua sign repeated down a whole
         retail spine is the most countable repeat in the frame. */
      const neon = srgb([PALETTE.NEON_AQUA, PALETTE.NEON_PINK, PALETTE.NEON_YELLOW,
        PALETTE.NEON_ORANGE, PALETTE.NEON_GREEN][(hex >> 4 | 0) % 5]);
      const wordN = 3 + Math.floor(rand() * 3);
      let lx = P(0.10);
      for (let w = 0; w < wordN; w++) {
        const ww = P(0.06 + rand() * 0.13);
        gc.fillStyle = css(neon, 0.85);
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

      /* Plinth. buildings.js pins its trim UVs to a texel inside this band —
         keep it plain, unlit wall. */
      gc.fillStyle = css(shade(wall, 0.82));
      gc.fillRect(0, P(0.90), size, P(0.10));
      gh.fillStyle = 'rgb(160,160,160)'; gh.fillRect(0, P(0.90), size, P(0.10));

      return pack(col, hgt, rgh, size, {
        normalStrength: 1.0, normalScale: 0.8, normalSize: 256, family: 'facade',
      });
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

      const macro = normalise(fbm(size, 3, 3, rand));
      const gravel = fbm(size, size >> 2, 2, rand);
      const mid = fbm(size, 18, 2, rand);

      const col = canvas(size);
      const gc = paintBase(col, size, base, [
        { f: macro, amp: 0.125, tint: [1.1, 1.0, 0.85] },
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

      return pack(col, hgt, rgh, size, {
        normalStrength: 1.35, normalScale: 0.9, family: 'rooftop',
      });
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

      const macro = normalise(fbm(size, 3, 3, rand));
      const fine = fbm(size, size >> 3, 2, rand);

      const col = canvas(size);
      const gc = paintBase(col, size, base, [
        { f: macro, amp: 0.090, tint: [1.1, 1.0, 0.86] },
        { f: fine, amp: 0.04 },
      ]);
      const hgt = canvas(size);
      const gh = paintGrey(hgt, size, 130, [{ f: fine, amp: 0.4 }]);
      const rgh = canvas(size);
      const gr = paintGrey(rgh, size, 214, [{ f: macro, amp: 0.20 }]);

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

      return pack(col, hgt, rgh, size, {
        normalStrength: 0.9, normalScale: 0.6, normalSize: 256, family: 'concrete',
      });
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

      return pack(col, hgt, rgh, size, {
        normalStrength: 1.4, normalScale: 1.0, family: 'brick',
      });
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

      return pack(col, hgt, rgh, size, {
        normalStrength: 1.2, normalScale: 0.85, family: 'wood',
      });
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

/** The family tag `pack()` stamped on a colour map, if there is one. */
function familyOf(params, fallback) {
  const m = params.map;
  return (m && m.userData && m.userData.family) || fallback;
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
  const fam = familyOf(params, 'default');
  const key = `ground-${fam}-${JSON.stringify(paramKey(p))}`;
  return cached(key, () => {
    const m = applyHoleCut(new THREE.MeshStandardMaterial({
      roughness: 0.95,
      metalness: 0.0,
      envMapIntensity: 0.30,
      dithering: true,
      ...p,
    }));
    // Ground is where the de-tiling matters most: it is the surface that fills
    // the frame, and the one whose tile grid the player stares at all game.
    return worldDetail(m, fam, 1);
  });
}

/**
 * Standard opaque material for anything above ground.
 *
 * Anything with a colour map gets the world breakup too, at half strength — a
 * mapped `solid()` is a building facade or a big structure, and those suffer
 * from exactly the same flatness. Unmapped ones (props, hedges, painted metal)
 * are left alone: they are small, they already vary by instance colour, and a
 * world-space blotch across a traffic cone is noise.
 */
export function solid(params) {
  const p = withCompanions(params);
  const fam = familyOf(params, null);
  const key = `solid-${fam || '-'}-${JSON.stringify(paramKey(p))}`;
  return cached(key, () => {
    const m = new THREE.MeshStandardMaterial({
      roughness: 0.72,
      metalness: 0.0,
      envMapIntensity: 0.65,
      dithering: true,
      ...p,
    });
    return fam ? worldDetail(m, fam, 0.85) : m;
  });
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
  const fam = familyOf(params, null);
  const key = `glass-${fam || '-'}-${JSON.stringify(paramKey(p))}`;
  return cached(key, () => {
    const m = new THREE.MeshStandardMaterial({
      roughness: 0.20,
      metalness: 0.80,
      envMapIntensity: 2.4,
      dithering: true,
      ...p,
    });
    return fam ? worldDetail(m, fam, 1) : m;
  });
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
 * One equirectangular sky, painted for a given point in the cycle.
 *
 * The ground half matters more than it looks: from the game's high 3/4 camera
 * the mirror direction off a vertical facade points at the horizon and below,
 * so it is the WARM half of this map that lands on the towers. Making it warm
 * is what keeps a wall of glass from reading as a wall of navy.
 *
 * `s` is one row of ENV_STOPS below.
 */
function paintEnvironment(g, W, H, s) {
  const top = srgb(s.top);
  const mid = srgb(s.mid);
  const hor = srgb(s.hor);
  const haze = srgb(s.haze);

  /* Upper half: sky. v=0 is the zenith in equirectangular. */
  const sky = g.createLinearGradient(0, 0, 0, H * 0.5);
  sky.addColorStop(0.00, css(top));
  sky.addColorStop(0.45, css(mid));
  sky.addColorStop(0.86, css(hor));
  sky.addColorStop(1.00, css(mix(hor, haze, 0.65)));
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H * 0.5);

  /* Lower half: the city and the bay. */
  const gnd = g.createLinearGradient(0, H * 0.5, 0, H);
  gnd.addColorStop(0.00, css(mix(haze, srgb(s.gndHi), 0.35)));
  gnd.addColorStop(0.22, css(srgb(s.gndHi)));
  gnd.addColorStop(0.60, css(srgb(s.gndMid)));
  gnd.addColorStop(1.00, css(shade(srgb(s.gndMid), 0.72)));
  g.fillStyle = gnd;
  g.fillRect(0, H * 0.5, W, H * 0.5);

  /* Bay: a broad turquoise band over roughly a third of the azimuth. */
  const bay = g.createLinearGradient(0, H * 0.5, 0, H * 0.86);
  bay.addColorStop(0.0, css(shade(srgb(PALETTE.SEA_SHALLOW), s.water), 0.85));
  bay.addColorStop(0.5, css(shade(srgb(PALETTE.SEA_MID), s.water), 0.8));
  bay.addColorStop(1.0, css(srgb(PALETTE.SEA_DEEP), 0.0));
  g.fillStyle = bay;
  g.fillRect(W * 0.58, H * 0.5, W * 0.34, H * 0.36);

  /* Green wedge for the park side, so reflections aren't monochrome. */
  const park = g.createLinearGradient(0, H * 0.5, 0, H * 0.72);
  park.addColorStop(0, css(shade(srgb(PALETTE.GRASS), s.water), 0.5));
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

  /* Sun / moon, at the elevation this stop is keyed to. */
  const sx = W * 0.70, sy = H * (0.5 - s.sunEl * 0.5);
  if (s.sunI > 0.001) {
    const glow = g.createRadialGradient(sx, sy, 0, sx, sy, H * 0.42);
    glow.addColorStop(0.00, css(srgb(s.sunCol), s.sunI));
    glow.addColorStop(0.06, css(srgb(s.sunCol), s.sunI * 0.85));
    glow.addColorStop(0.30, css(srgb(s.sunCol), s.sunI * 0.22));
    glow.addColorStop(1.00, css(srgb(s.sunCol), 0));
    g.fillStyle = glow;
    g.fillRect(0, 0, W, H * 0.62);
  }

  /*
   * After dark, the horizon ring is not the sky — it is the city.
   * A tower reflects the horizon back at the camera, so this warm sodium band
   * IS the night look of every glass facade in the game. Without it the towers
   * mirror an empty navy dome and read as black cardboard.
   */
  if (s.cityGlow > 0.001) {
    const cg = g.createLinearGradient(0, H * 0.40, 0, H * 0.60);
    cg.addColorStop(0.0, css(srgb(s.cityCol), 0));
    cg.addColorStop(0.5, css(srgb(s.cityCol), s.cityGlow));
    cg.addColorStop(1.0, css(srgb(s.cityCol), s.cityGlow * 0.35));
    g.fillStyle = cg;
    g.fillRect(0, H * 0.40, W, H * 0.20);
    /* Uneven: downtown is bright, the bay side is not. */
    const rnd = mulberry32(0x9e3b1);
    for (let i = 0; i < 22; i++) {
      const x = rnd() * W;
      const r = W * (0.03 + rnd() * 0.09);
      const rg = g.createRadialGradient(x, H * 0.51, 0, x, H * 0.51, r);
      rg.addColorStop(0, css(srgb(s.cityCol), s.cityGlow * 0.75));
      rg.addColorStop(1, css(srgb(s.cityCol), 0));
      g.fillStyle = rg;
      g.beginPath(); g.ellipse(x, H * 0.51, r, r * 0.5, 0, 0, 7); g.fill();
    }
  }

  /* Fair-weather cumulus, flattened toward the horizon like real perspective. */
  const rand = mulberry32(0x51c0d);
  const cl = srgb(s.cloud);
  const cs = srgb(s.cloudShade);
  for (let i = 0; i < 44; i++) {
    const t = Math.pow(rand(), 0.6);
    const y = H * (0.06 + t * 0.38);
    const x = rand() * W;
    const flat = 0.22 + (1 - t) * 0.7;
    const rx = W * (0.02 + rand() * 0.07);
    const ry = rx * flat;
    g.fillStyle = css(cl, 0.16 + rand() * 0.42);
    g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, 7); g.fill();
    g.fillStyle = css(cs, 0.10 + rand() * 0.16);
    g.beginPath(); g.ellipse(x, y + ry * 0.55, rx * 0.85, ry * 0.5, 0, 0, 7); g.fill();
  }
}

/**
 * The cycle, as reflections see it. Four stops, keyed on the same nightFactor
 * the engine publishes.
 *
 *   at    nightFactor this stop is authored for
 *   sunEl sun height as a fraction of the way from horizon to zenith
 *   water how much of its daytime brightness the bay keeps
 *
 * Four rather than a continuous rebuild because a PMREM costs real time and a
 * mid-game hitch is worse than a swap the player cannot see: the map is a
 * blurred irradiance probe, so the step between neighbouring stops is a small
 * change in a low-frequency term, and the engine is simultaneously ramping
 * `environmentIntensity` across it.
 */
const ENV_STOPS = [
  {
    at: 0.0, // full day
    top: PALETTE.SKY_TOP, mid: PALETTE.SKY_MID, hor: PALETTE.SKY_HORIZON,
    haze: PALETTE.SKY_HAZE, gndHi: PALETTE.SIDEWALK, gndMid: PALETTE.ASPHALT_LIGHT,
    cloud: 0xfffcf6, cloudShade: 0xbeccda, water: 1.0,
    sunEl: 0.42, sunCol: 0xfffff6, sunI: 1.0,
    cityCol: 0xffb45a, cityGlow: 0.0,
  },
  {
    at: 0.34, // golden hour — the whole dome goes amber and the sun drops
    top: PALETTE.ENV_GOLD_TOP, mid: PALETTE.ENV_GOLD_MID, hor: PALETTE.ENV_GOLD_HOR,
    haze: PALETTE.ENV_GOLD_HAZE,
    gndHi: PALETTE.ENV_GOLD_GND, gndMid: PALETTE.ENV_GOLD_GND_LO,
    cloud: PALETTE.ENV_GOLD_CLOUD, cloudShade: PALETTE.ENV_GOLD_CLOUD_SHADE, water: 0.86,
    sunEl: 0.10, sunCol: PALETTE.ENV_GOLD_SUN, sunI: 1.0,
    cityCol: PALETTE.CITY_GLOW, cityGlow: 0.0,
  },
  {
    at: 0.72, // dusk — sun gone, afterglow on the horizon, city coming on
    top: PALETTE.ENV_DUSK_TOP, mid: PALETTE.ENV_DUSK_MID, hor: PALETTE.ENV_DUSK_HOR,
    haze: PALETTE.ENV_DUSK_HAZE,
    gndHi: PALETTE.ENV_DUSK_GND, gndMid: PALETTE.ENV_DUSK_GND_LO,
    cloud: PALETTE.ENV_DUSK_CLOUD, cloudShade: PALETTE.ENV_DUSK_CLOUD_SHADE, water: 0.42,
    sunEl: -0.04, sunCol: PALETTE.ENV_DUSK_SUN, sunI: 0.55,
    cityCol: PALETTE.CITY_GLOW, cityGlow: 0.30,
  },
  {
    at: 1.0, // night — the horizon is sodium, the dome is deep blue
    top: PALETTE.ENV_NIGHT_TOP, mid: PALETTE.ENV_NIGHT_MID, hor: PALETTE.ENV_NIGHT_HOR,
    haze: PALETTE.ENV_NIGHT_HAZE,
    gndHi: PALETTE.ENV_NIGHT_GND, gndMid: PALETTE.ENV_NIGHT_GND_LO,
    cloud: PALETTE.ENV_NIGHT_CLOUD, cloudShade: PALETTE.ENV_NIGHT_CLOUD_SHADE, water: 0.22,
    sunEl: 0.30, sunCol: PALETTE.MOON, sunI: 0.16,   // the moon
    cityCol: PALETTE.CITY_GLOW, cityGlow: 0.52,
  },
];

const _env = {
  maps: [],
  scene: null,
  index: -1,
};

/**
 * Pick the environment map for a point in the cycle and hang it on the scene.
 * Safe to call every frame — it only touches `scene.environment` on a change.
 * @param {number} nightFactor 0 = full day, 1 = full night
 */
export function setEnvironmentPhase(nightFactor) {
  if (!_env.scene || !_env.maps.length) return;
  const nf = nightFactor < 0 ? 0 : nightFactor > 1 ? 1 : nightFactor;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < ENV_STOPS.length; i++) {
    const d = Math.abs(ENV_STOPS[i].at - nf);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best === _env.index) return;
  _env.index = best;
  _env.scene.environment = _env.maps[best];
}

/**
 * Reflected environment, plus the driver that keeps it in step with the cycle.
 *
 * Signature unchanged: `buildEnvironment(renderer, scene)`, returns the day
 * PMREM texture — which is also what the scene starts on, so nothing about the
 * boot frame moves.
 */
export function buildEnvironment(renderer, scene) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  const W = 512, H = 256;
  const t0 = performance.now();
  _env.maps.length = 0;
  for (const s of ENV_STOPS) {
    const c = canvas(W, H);
    paintEnvironment(ctx2d(c), W, H, s);
    const tex = new THREE.CanvasTexture(c);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    _env.maps.push(pmrem.fromEquirectangular(tex).texture);
    tex.dispose();
  }
  pmrem.dispose();
  _stats.envMs = Math.round((performance.now() - t0) * 10) / 10;

  _env.scene = scene;
  _env.index = 0;
  scene.environment = _env.maps[0];
  // The light rig owns overall IBL strength; fall back if that export moves.
  scene.environmentIntensity = (Q.LIGHTING && Q.LIGHTING.ENV_INTENSITY) || 0.5;

  installCycleDriver(scene);
  return _env.maps[0];
}

let _driverInstalled = false;

/**
 * Keep `scene.environment` in step with the cycle.
 *
 * The game loop only pumps the update hooks that existed before this file did
 * (traffic, pedestrians), so the swap rides `scene.onBeforeRender`, which
 * three calls once per `renderer.render`. Chained, never replaced — another
 * module already owns this slot (buildings.js drives its lit windows from it)
 * and stomping it would silently switch the whole skyline off.
 *
 * `scene.userData.materialsUpdate` is the same thing as a plain hook, for
 * whoever eventually pumps per-module updates properly.
 */
function installCycleDriver(scene) {
  const update = () => {
    const nf = scene.userData.nightFactor;
    if (typeof nf === 'number') setEnvironmentPhase(nf);
  };
  scene.userData.materialsUpdate = update;
  // Boot cost of the procedural texture library, for whoever is checking the
  // budget. A live function, not a snapshot: most generators run lazily during
  // buildWorld, which is after this.
  scene.userData.textureStats = () => Textures.stats();
  if (_driverInstalled) return;
  _driverInstalled = true;
  const prev = scene.onBeforeRender;
  scene.onBeforeRender = function (...a) { prev.apply(this, a); update(); };
  update();
}

export const MaterialLib = {
  Textures, ground, solid, glass, painted, emissive, foliage, setEnvironmentPhase,
};
