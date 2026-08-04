/**
 * The Hole — player, bot and remote-peer avatar.
 *
 * Visually a hole is four pieces:
 *   1. the ground cut (handled globally in render/groundShader.js)
 *   2. a pit interior: an inside-out funnel whose walls swirl away into darkness
 *   3. a torn-earth collar: raised dirt sitting exactly on the cut, with cracks
 *      radiating outward and grit drifting off the trailing edge
 *   4. a tier-up burst ring, fired when the hole crosses a size class
 *
 * Gameplay-wise it is a position, a radius derived from score, and a speed that
 * decays as it grows so early-game feels nimble and late-game feels titanic.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PIT IS SO DARK
 * ---------------------------------------------------------------------------
 * docs/ART_DIRECTION.md §3: the hole must be the darkest thing on screen *by a
 * wide margin*, and that contrast is the whole game. The previous shader tinted
 * the whole throat with the owner colour and the hole came back from review as
 * a bright magenta bowl in a sunlit city — the exact opposite of the brief. So
 * everything here is budgeted in linear radiance: the wall base sits around
 * 0.02, the brightest striation ridge around 0.05, and the ONLY thing allowed
 * above 0.2 is the hot lip — a band 1.4% of the radius wide, measured from the
 * ground cut itself. Owner identity is carried by that thin lip, by the
 * coloured halo in the ground shader, and by the collar's emissive rim; never
 * by lifting the void.
 *
 * ---------------------------------------------------------------------------
 * WHY SQUASH-AND-STRETCH IS A SPRING
 * ---------------------------------------------------------------------------
 * An exponential decay can only ever sag back to rest; it has no overshoot, so
 * every swallow felt like a fade rather than a gulp. A second-order spring at
 * zeta ~0.45 rings once, hard, and settles — that single overshoot is what
 * makes a bite feel chunky.
 */

import * as THREE from 'three';
import { HOLE, WORLD, PALETTE, TIER_LIST } from '../config.js';
import { HOLE_EDGE_GLSL, EDGE_AMP } from '../render/groundShader.js';
import { activeEffects } from '../render/effects.js';

/** Scratch for the lip-grit emitter; this runs for every hole every frame. */
const _grit = new THREE.Vector3();

/* ========================================================================== */
/*  PIT INTERIOR                                                              */
/* ========================================================================== */

const PIT_VERT = /* glsl */ `
  varying vec2  vUv;
  varying vec2  vDirH;
  varying float vR;
  void main() {
    vUv = uv;
    // Horizontal outward direction in object space. The hole group is never
    // rotated, so this doubles as the world direction — which is what the sun
    // term needs, and it dodges the non-uniform scale that would wreck a
    // normalMatrix-transformed normal.
    vDirH = normalize(position.xz + vec2(1e-5));
    // Radius in profile units. The fragment shader measures depth from the
    // per-pixel ground cut using this, NOT from the uv row, because the uv rows
    // are a 64-gon and anchoring the hot lip to them drew a visibly faceted
    // pink polygon instead of a circle.
    vR = length(position.xz);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const PIT_FRAG = /* glsl */ `
  uniform vec3  uWall;      // dark earth the upper throat is cut through
  uniform vec3  uVoid;      // the bottom: as close to nothing as we dare
  uniform vec3  uTint;      // owner colour — glow and lip only, never the walls
  uniform vec3  uLipHot;    // hot kiss of light right on the opening
  uniform float uTime;
  uniform float uPulse;     // swallow ring, -1..1
  uniform float uFlash;     // tier-up celebration, 0..1
  uniform vec2  uSunXZ;     // horizontal sun direction, for a faint wall catch
  uniform float uNight;     // scene.userData.nightFactor, 0 day .. 1 night
  uniform float uSeed;      // must match the ground cut's torn edge
  varying vec2  vUv;
  varying vec2  vDirH;
  varying float vR;
  ${HOLE_EDGE_GLSL}

  void main() {
    // Descent measured from the ACTUAL torn cut, not from the mesh's top row.
    float edge = 1.0 + ${EDGE_AMP.toFixed(4)} * hcEdge(vDirH, uSeed);
    float below = edge - vR;
    // The overhang — mesh above the tear — is NOT discarded. At the far lip the
    // view rays graze just inside the cut and continue away and downward, so
    // without that collar of geometry they pass clean under the ground plane
    // and out to the sky: a pale wedge across the top of every hole. It is what
    // seals the funnel against y=0. It just has to be pure shadow, never lip.
    float outside = step(below, 0.0);
    float d = clamp(below / max(0.25, edge), 0.0, 1.0);
    // Depth along the wall, used only for the spiral shear: the striations have
    // to twist with real vertical distance, which radius does not track.
    float dv = clamp(1.0 - vUv.y, 0.0, 1.0);
    float a  = vUv.x;                    // 0..1 around

    /* ---- swirling striations --------------------------------------------
       Two banded fields sheared by depth. 'twist' is what turns concentric
       rings into a spiral, and the depth term inside 'spin' is what makes the
       spiral accelerate as it descends — that acceleration is the entire
       reason it reads as suction rather than as a striped cone. Every angular
       frequency is an integer so the field is continuous across the uv seam. */
    float twist = dv * 2.7;
    float spin  = uTime * (0.06 + dv * 0.55);
    float b1 = 0.5 + 0.5 * sin((a + twist + spin) * 6.28318 * 7.0);
    float b2 = 0.5 + 0.5 * sin((a + twist * 2.4 + uTime * (0.03 + dv * 0.95)) * 6.28318 * 19.0);
    float striae = mix(b1, b2, 0.42);
    striae *= striae * striae;           // thin ridges, wide grooves

    // Break the corduroy with noise sampled ON THE CIRCLE, so it is periodic
    // in 'a' and there is no seam where uv wraps.
    striae *= 0.30 + 0.70 * hcNoise(vDirH * 7.0 + vec2(dv * 9.0 - uTime * 0.75, 0.0));

    /* ---- the void --------------------------------------------------------
       DIMMED AFTER DARK, and this shader is the only thing in the game that
       has to do it by hand: every other surface is lit by the rig, so when the
       sun goes the whole city drops with it — while an unlit pit painted from
       constant uniforms does not. Measured on the hole-mid preset at
       timeOfDay 0.87, the throat sat at 0.30 display luminance against a
       0.21 road: the hole had stopped being the darkest thing on screen, which
       is the one property the art bible says it must never lose. Held at a
       quarter after dark it lands at ~0.08 against the same road. */
    float lit = 1.0 - 0.76 * uNight;
    vec3 wall = uWall * lit;
    vec3 voidc = uVoid * lit;
    vec3 col = mix(wall, voidc, smoothstep(0.0, 0.34, d));
    col *= exp(-d * 4.6);                // hard ambient falloff down the throat
    col += wall * striae * 2.1 * (1.0 - smoothstep(0.05, 0.55, d));

    // Sun catch on the up-sun side of the throat. This is the term that gives
    // the pit a direction; without it a big hole collapses into a flat disc,
    // which is the specific failure the brief calls out. The wall's INWARD
    // normal is -vDirH, hence the negation.
    float sun = max(0.0, dot(-vDirH, uSunXZ));
    col += wall * pow(sun, 2.0) * 2.6 * (1.0 - smoothstep(0.0, 0.62, d));

    /* ---- inner glow ------------------------------------------------------
       Something is burning down there. Deliberately starved: the owner tint is
       a fully saturated accent, and at even 0.02 linear it stains the whole
       throat violet — which is how the previous version ended up reading as a
       magenta bruise instead of a hole. */
    float glowBand = smoothstep(0.90, 0.50, d) * smoothstep(0.14, 0.42, d);
    col += uTint * glowBand * (0.0075 + 0.024 * uFlash) * (0.7 + 0.5 * striae);

    /* ---- hot lip ---------------------------------------------------------
       Three percent of the wall height. It has to be a KISS: bloom widens it,
       and anything fatter turns the hole into a neon doughnut at close camera
       distances while adding nothing at the distance the game is actually
       played at. */
    // 'below' is a RADIAL distance, and near the top the wall is near-vertical,
    // so a band that looks reasonable as a number projects enormous on the far
    // side of the opening where the wall faces the camera. 0.8% of the radius.
    float lip = smoothstep(0.014, 0.0, max(below, 0.0)) * (1.0 - outside);
    float lipPow = lip * lip * lip;
    col += uLipHot * lipPow * (0.75 + 0.9 * uFlash + 0.5 * max(uPulse, 0.0));
    col += uTint * lipPow * lip * (0.55 + 1.4 * uFlash);

    // Never let the very bottom pick up anything at all.
    col *= smoothstep(-0.02, 0.22, 1.0 - dv);
    // Overhang to pure void, so the seal reads as an undercut shadow.
    col = mix(col, voidc * 0.4, outside);

    gl_FragColor = vec4(max(col, 0.0), 1.0);
    #include <colorspace_fragment>
  }
`;

/* ========================================================================== */
/*  TORN-EARTH COLLAR                                                         */
/* ========================================================================== */

const LIP_PARS_VERT = /* glsl */ `
  attribute float aAng;
  attribute float aT;
  uniform float uRadius;
  uniform float uWidth;
  uniform float uLift;
  uniform float uSeed;
  varying float vT;
  varying float vAng;
  varying vec2  vDir;
  ${HOLE_EDGE_GLSL}
`;

/**
 * Vertex displacement. The geometry is a plain unit annulus; the real shape is
 * built here so `uRadius` (which changes every frame) can drive the inner edge
 * while `uWidth` stays independent of it — a uniformly scaled ring would make
 * a 60 m hole throw 50 m cracks.
 */
const LIP_VERT = /* glsl */ `
  vDir = vec2(cos(aAng), sin(aAng));
  vAng = aAng;
  vT = aT;
  float edgeR = uRadius * (1.0 + ${EDGE_AMP.toFixed(4)} * hcEdge(vDir, uSeed));
  float rr = edgeR + uWidth * aT;
  // Lifted earth: the ground was pushed UP as it tore, highest right at the
  // tear and gone by a third of the way out. The angular frequency has to stay
  // LOW — at 9.7 the noise lattice put thirty lobes around the circle and the
  // collar came out fluted like a pie crust.
  float rough = 0.55 + 0.45 * hcNoise(vDir * 3.4 + uSeed * 13.0);
  float bump = pow(max(0.0, 1.0 - aT * 2.9), 2.0);
  transformed = vec3(vDir.x * rr, uLift * bump * rough, vDir.y * rr);
`;

const LIP_NORMAL = /* glsl */ `
  {
    vec2 dir2 = vec2(cos(aAng), sin(aAng));
    float rough2 = 0.55 + 0.45 * hcNoise(dir2 * 3.4 + uSeed * 13.0);
    // -dy/dr of the bump profile above, so the collar's outer face catches the
    // sun and its inner face falls into the pit's shadow.
    float slope = uLift * rough2 * 4.4 * max(0.0, 1.0 - aT * 2.9) / max(0.35, uWidth);
    objectNormal = normalize(vec3(dir2.x * slope, 1.0, dir2.y * slope));
    // Chunky, irregular clods — but gently: a strong tangential term here reads
    // as machined fluting, which is the opposite of torn.
    objectNormal = normalize(objectNormal
      + vec3(dir2.y, 0.0, -dir2.x) * (hcNoise(dir2 * 5.3 + uSeed * 5.0) - 0.5) * 0.45);
  }
`;

const LIP_PARS_FRAG = /* glsl */ `
  uniform float uRadius;
  uniform float uWidth;
  uniform float uSeed;
  uniform float uHtime;
  uniform vec2  uVel;         // world XZ velocity, for the dust wake
  uniform float uSpeed;       // 0..1 normalised
  uniform vec3  uDirtDark;
  uniform vec3  uDirtLight;
  uniform vec3  uOwner;
  uniform float uPulse;
  uniform float uFlash;
  varying float vT;
  varying float vAng;
  varying vec2  vDir;
  ${HOLE_EDGE_GLSL}
`;

const LIP_FRAG = /* glsl */ `
  {
    // ---- fractured earth ------------------------------------------------
    // Damp, freshly opened ground at the tear; dry dust by the time it reaches
    // the pavement. Getting that value ramp the wrong way round is what turns
    // the collar into a sand doughnut.
    float grit = hcNoise(vDir * 34.0 + vT * 9.0 + uSeed * 3.0);
    float clod = hcNoise(vDir * 7.5 - vT * 3.0 + uSeed * 7.0);
    float dry = smoothstep(0.02, 0.30, vT) * 0.85 + clod * 0.28;
    vec3 dirt = mix(uDirtDark * 0.62, uDirtLight, clamp(dry, 0.0, 1.0));
    dirt *= 0.66 + 0.42 * grit;
    diffuseColor.rgb = dirt;

    // ---- radiating cracks -------------------------------------------------
    // A FIXED 40 cells around the circle, one candidate crack per cell, each
    // with its own length, offset and wander. The count is fixed on purpose:
    // deriving it from the radius re-randomises the whole pattern every time
    // the hole grows past a rounding boundary, which pops. Size instead opens
    // more of the cells, so cracks fade in as the hole gets hungrier.
    const float cells = 40.0;
    float sizeK = clamp(uRadius / 14.0, 0.0, 1.0);
    float thresh = 0.56 - 0.40 * sizeK;
    float ca = (vAng / 6.28318 + 1.0) * cells;
    float crack = 0.0;
    for (int k = -1; k <= 1; k++) {
      float ci = floor(ca) + float(k);
      float idc = mod(ci, cells);                 // wrap so the seam matches
      float h1 = hcHash(vec2(idc, uSeed * 91.0 + 3.0));
      float h2 = hcHash(vec2(idc + 37.0, uSeed * 57.0 + 8.0));
      float gate = smoothstep(thresh - 0.12, thresh + 0.02, h2);
      if (gate <= 0.001) continue;
      // Wildly uneven lengths. Equal-length spokes read as a drawn sunburst,
      // which is exactly what a fractured slab does not look like.
      float len = 0.16 + h1 * h1 * 0.9;
      if (vT > len) continue;
      // Wander: cracks are not radial spokes, they wobble as they propagate.
      float off = h1 + sin(vT * (5.0 + h1 * 9.0) + h1 * 24.0) * (0.10 + h1 * 0.14) * vT;
      float dx = (ca - ci) - off;
      // Width is in CELL units — one fortieth of the circumference — so a real
      // 3 cm fissure is a third of a pixel from the gameplay camera. These are
      // stylised on purpose: chunky enough to read at a glance, which is the
      // whole shape language of the game.
      float wide = (0.075 + 0.090 * h2) * (1.0 - vT / len);
      float c = smoothstep(wide, wide * 0.15, abs(dx)) * (1.0 - smoothstep(0.35, 1.0, vT / len));
      crack = max(crack, c * gate);
    }

    // ---- dust wake --------------------------------------------------------
    // A hole on the move drags a skirt of grit behind it.
    float trail = clamp(dot(vDir, -uVel), 0.0, 1.0);
    trail = pow(trail, 2.0) * uSpeed;
    float dust = trail * (1.0 - smoothstep(0.05, 0.85, vT))
               * (0.25 + 0.75 * hcNoise(vDir * 26.0 + vec2(uHtime * 1.4, 0.0)));

    // ---- coverage ---------------------------------------------------------
    // The innermost sliver is left mostly clear on purpose: that is where the
    // ground shader's contact shadow lives, and burying it under dirt is what
    // makes a hole read as a sticker instead of a cut.
    // The outer boundary RADIUS varies with angle, not just its opacity — that
    // is the difference between a torn edge and a disc with a soft vignette.
    float collar = smoothstep(0.0, 0.04, vT)
                 * (1.0 - smoothstep(0.05 + clod * 0.12, 0.24 + clod * 0.34, vT));
    collar *= 0.72 + 0.45 * clod;
    float rimBand = smoothstep(0.10, 0.0, vT);    // owner glow, see LIP_EMISSIVE
    float a = clamp(collar, 0.0, 1.0);
    a = max(a, crack * 0.9);
    a = max(a, dust * 0.55);
    a = max(a, rimBand * rimBand * 0.9);
    // Feather the outermost ring so the mesh never ends on a hard circle.
    a *= 1.0 - smoothstep(0.82, 1.0, vT);

    // Cracks are a hole in the pavement, not a stain: near-black, with a thin
    // sunlit shoulder of displaced material on one side so they have relief.
    float shoulder = smoothstep(0.25, 0.55, crack) - smoothstep(0.55, 0.85, crack);
    diffuseColor.rgb = mix(diffuseColor.rgb, uDirtDark * 0.10, crack);
    diffuseColor.rgb += uDirtLight * shoulder * 0.18;
    diffuseColor.rgb = mix(diffuseColor.rgb, uDirtLight * 1.15, dust * 0.6);
    diffuseColor.a *= a;
  }
`;

/**
 * Owner identity lives here rather than in the void: a thin emissive kiss on
 * the innermost slice of the collar, boosted by the swallow pulse and the
 * tier-up flash. Costs no extra draw call and always sits exactly on the tear.
 */
const LIP_EMISSIVE = /* glsl */ `
  {
    // Wide enough to survive the gameplay zoom. At 0.035 of the collar this was
    // 15 cm on a 7 m hole — under a pixel from 120 m out, and four rival holes
    // read as four identical black blobs.
    float band = smoothstep(0.10, 0.0, vT);
    float k = band * band * (0.34 + 0.45 * max(uPulse, 0.0) + 1.6 * uFlash);
    totalEmissiveRadiance += uOwner * k;
  }
`;

/* ========================================================================== */
/*  SHARED GEOMETRY                                                           */
/* ========================================================================== */

/**
 * Built once and shared by every hole — up to 12 of them exist, and they are
 * torn down and rebuilt on every match restart. `__shared` marks them so
 * dispose() leaves them alone.
 */
let _pitGeo = null;
let _capGeo = null;
let _lipGeo = null;
let _burstGeo = null;

/**
 * Funnel profile. A straight cone reads as a party hat; a real drain is nearly
 * vertical for the first metre (that is the cut through the earth's crust) and
 * only then flares away. Radius 1.0 at the lip so the wall meets the ground
 * plane exactly at the nominal cut, with the wobble amplitude covered by
 * starting the collar slightly inside it.
 */
/**
 * Top radius is 1.045, not 1.0. hcEdge is bounded at ±0.50, so the tear reaches
 * 1.0375r at most; a mesh that stops at exactly 1.0 leaves a sliver of nothing
 * along the angles where the tear reaches furthest, and — worse — leaves the
 * far lip open to the sky. Kept as tight as the bound allows, because every
 * millimetre of overhang is undercut depth at the near lip.
 *
 * The y exponent is steep (1.55) so the wall is near-vertical for the first
 * metre: that is the cut through the crust, and it holds the undercut to ~3%
 * of the pit's depth.
 */
function pitProfileR(v) { return 0.030 + 1.015 * Math.pow(v, 0.40); }
function pitProfileY(v) { return -Math.pow(1 - v, 1.85); }

function buildPitGeometry() {
  const RAD = 64, H = 6;
  // Start from a cylinder purely for its known-good winding and uv layout, then
  // push the vertices onto the funnel profile.
  const g = new THREE.CylinderGeometry(1, 1, 1, RAD, H, true);
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const v = uv.getY(i);                       // 1 at the top row
    const x = pos.getX(i), z = pos.getZ(i);
    const len = Math.hypot(x, z) || 1;
    const r = pitProfileR(v);
    pos.setXYZ(i, (x / len) * r, pitProfileY(v), (z / len) * r);
  }
  g.computeVertexNormals();
  g.__shared = true;
  return g;
}

function buildLipGeometry() {
  const SEG = 96, RINGS = 4;
  const count = (SEG + 1) * (RINGS + 1);
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const ang = new Float32Array(count);
  const tt = new Float32Array(count);
  let p = 0;
  for (let j = 0; j <= RINGS; j++) {
    // Bunch the rings toward the inner edge, where the collar geometry lives.
    const t = Math.pow(j / RINGS, 1.45);
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      pos[p * 3] = Math.cos(a) * (1 + t);
      pos[p * 3 + 1] = 0;
      pos[p * 3 + 2] = Math.sin(a) * (1 + t);
      nor[p * 3 + 1] = 1;
      ang[p] = a;
      tt[p] = t;
      p++;
    }
  }
  const idx = [];
  for (let j = 0; j < RINGS; j++) {
    for (let i = 0; i < SEG; i++) {
      const a0 = j * (SEG + 1) + i;
      const a1 = a0 + 1;
      const b0 = a0 + (SEG + 1);
      const b1 = b0 + 1;
      // Winding chosen so the face normal comes out +Y — the collar is drawn
      // single-sided and would be culled from the game's top-down camera if
      // these were reversed.
      idx.push(a0, a1, b0, a1, b1, b0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('aAng', new THREE.BufferAttribute(ang, 1));
  g.setAttribute('aT', new THREE.BufferAttribute(tt, 1));
  g.setIndex(idx);
  g.__shared = true;
  return g;
}

function sharedGeometries() {
  if (!_pitGeo) {
    _pitGeo = buildPitGeometry();
    // Faces UP: seen from the game's overhead camera, a down-facing cap is
    // back-face culled and the funnel's throat shows sky.
    _capGeo = new THREE.CircleGeometry(0.06, 16);
    _capGeo.rotateX(-Math.PI / 2);
    _capGeo.__shared = true;
    _lipGeo = buildLipGeometry();
    // Thin. At 0.70 the tier-up ring was a 4 m wide pink smear rather than a
    // shockfront, and additive blending made it worse.
    _burstGeo = new THREE.RingGeometry(0.885, 1.0, 96, 1);
    _burstGeo.rotateX(-Math.PI / 2);
    _burstGeo.__shared = true;
  }
}

/* Sun direction, matching core/quality.js LIGHTING (azimuth -14, elevation 56).
 * Hardcoded rather than imported so the pit shader cannot be broken by another
 * agent restructuring the lighting module; it only needs to be approximately
 * right for a wall-catch term. */
const SUN_XZ = new THREE.Vector2(-0.135, 0.543).normalize();

let _holeId = 1;

/** Highest tier index whose eatRadius this radius has reached. */
function tierFor(radius) {
  let t = 0;
  for (let i = 0; i < TIER_LIST.length; i++) if (radius >= TIER_LIST[i].eatRadius) t = i;
  return t;
}

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
    /** Per-hole torn-edge seed. Golden-ratio stride so ids 1..12 all differ. */
    this.edgeSeed = (this.id * 0.6180339887498949) % 1;

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
    /** Squash-and-stretch spring state (displacement + velocity). */
    this.pulse = 0;
    this.pulseV = 0;
    this.displayRadius = this.radius;
    this._radiusV = 0;
    /** Tier-up celebration, 1 -> 0 over ~0.9 s. */
    this.tier = tierFor(this.radius);
    this.tierFlash = 0;
    /** True for the frame the hole crosses into a new size class. */
    this.tierUp = false;
    this._burstT = -1;
    this._gritT = 0;
    /** Kill-feed / HUD. */
    this.lastMeal = null;
    this.killedBy = null;

    this.group = new THREE.Group();
    this.group.name = `hole-${this.id}`;
    this._buildVisual();
    this.syncVisual();
  }

  _buildVisual() {
    sharedGeometries();

    /* --- pit interior ---------------------------------------------------- */
    this.pitMaterial = new THREE.ShaderMaterial({
      vertexShader: PIT_VERT,
      fragmentShader: PIT_FRAG,
      side: THREE.BackSide,
      uniforms: {
        // PALETTE.HOLE_RIM is a violet near-black. Straight, it makes the whole
        // throat read as a bruise once the striations multiply it up, so it is
        // pulled toward mulch: still near-black, but warm enough to read as
        // earth rather than as a UI colour.
        //
        // 0.34, not 0.10. At a tenth the mix is still blue-dominant (30,25,36),
        // and the grade's shadow tint then adds another 0.02 of linear blue on
        // top of a wall whose own linear value is around 0.015 — so it more
        // than doubles the blue channel and the 30 m pit measured out violet at
        // r:b 0.81. A third of the way over lands warm-neutral (52,41,44) and
        // survives that addition as dark earth.
        uWall: { value: new THREE.Color(PALETTE.HOLE_RIM)
          .lerp(new THREE.Color(PALETTE.MULCH), 0.34) },
        uVoid: { value: new THREE.Color(PALETTE.HOLE_VOID) },
        uTint: { value: this.color.clone() },
        uLipHot: { value: new THREE.Color(PALETTE.HOLE_GLOW) },
        uSunXZ: { value: SUN_XZ.clone() },
        uNight: { value: 0 },
        uSeed: { value: this.edgeSeed },
        uTime: { value: 0 },
        uPulse: { value: 0 },
        uFlash: { value: 0 },
      },
    });
    this.pit = new THREE.Mesh(_pitGeo, this.pitMaterial);
    this.pit.frustumCulled = false;
    this.pit.renderOrder = -2;
    this.group.add(this.pit);

    /* --- bottom plug so we never see sky through the funnel's throat ------ */
    this.cap = new THREE.Mesh(
      _capGeo,
      new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false })
    );
    this.cap.frustumCulled = false;
    this.cap.renderOrder = -3;
    this.group.add(this.cap);

    /* --- torn-earth collar ------------------------------------------------ */
    this.lipMaterial = this._makeLipMaterial();
    this.lip = new THREE.Mesh(_lipGeo, this.lipMaterial);
    this.lip.frustumCulled = false;
    this.lip.castShadow = false;
    this.lip.receiveShadow = false;
    this.lip.renderOrder = 3;
    this.group.add(this.lip);

    /* --- tier-up burst ---------------------------------------------------- */
    this.burstMaterial = new THREE.MeshBasicMaterial({
      color: this.color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.burst = new THREE.Mesh(_burstGeo, this.burstMaterial);
    this.burst.position.y = 0.09;
    this.burst.renderOrder = 6;
    this.burst.frustumCulled = false;
    this.burst.visible = false;
    this.group.add(this.burst);

    // Legacy alias: older code (and dev tooling) reached for `.ring`.
    this.ring = this.burst;
    this.ringMaterial = this.burstMaterial;
  }

  _makeLipMaterial() {
    const m = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.98,
      metalness: 0.0,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      emissive: new THREE.Color(0x000000),
    });
    const u = {
      uRadius: { value: 1 },
      uWidth: { value: 2 },
      uLift: { value: 0.2 },
      uSeed: { value: this.edgeSeed },
      uHtime: { value: 0 },
      uVel: { value: new THREE.Vector2() },
      uSpeed: { value: 0 },
      // Straight PALETTE.DIRT under a 3.5x key light renders as beach sand and
      // the collar turns into a doughnut of it. Pulled back toward mulch.
      uDirtDark: { value: new THREE.Color(PALETTE.MULCH) },
      uDirtLight: { value: new THREE.Color(PALETTE.MULCH)
        .lerp(new THREE.Color(PALETTE.DIRT), 0.5) },
      uOwner: { value: this.color.clone() },
      uPulse: { value: 0 },
      uFlash: { value: 0 },
    };
    this.lipUniforms = u;
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${LIP_PARS_VERT}`)
        .replace('#include <beginnormal_vertex>',
          `#include <beginnormal_vertex>\n${LIP_NORMAL}`)
        .replace('#include <begin_vertex>',
          `#include <begin_vertex>\n${LIP_VERT}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${LIP_PARS_FRAG}`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n${LIP_FRAG}`)
        .replace('#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>\n${LIP_EMISSIVE}`);
    };
    m.customProgramCacheKey = () => 'holelip-v1';
    return m;
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
    const grew = this.radius - prev;
    // Kick the spring, don't set it: velocity impulses accumulate naturally
    // when several things go down at once, so a mouthful hits harder than a
    // crumb without any special-casing. Scaled by the RELATIVE size of the meal
    // so eating a bench at r=40 does not shake the world.
    // grew can come back NEGATIVE when the radius is set from outside the score
    // curve (dev harness, a netcode snapshot, a retuned GROWTH_* constant) and
    // addScore then re-solves it. A negative impulse would suck the hole inward
    // on a swallow, which is the exact opposite of the feedback we want, so the
    // spring is only ever kicked outward.
    const rel = Math.max(0, grew) / Math.max(0.15, this.radius);
    this.pulseV = Math.min(12.0, this.pulseV + Math.min(9.0, 1.6 + rel * 90.0));
    this.chompImpulse = Math.min(1, this.chompImpulse + 0.4);

    const t = tierFor(this.radius);
    if (t > this.tier) {
      this.tier = t;
      this.tierUp = true;
      this.tierFlash = 1;
      this._burstT = 0;
      this.pulseV += 7.0;
    }
    return grew;
  }

  reset(x, z, score = 0) {
    this.position.set(x, 0, z);
    this.velocity.set(0, 0, 0);
    this.score = score;
    this.radius = Hole.radiusFor(score);
    this.displayRadius = this.radius;
    this._radiusV = 0;
    this.pulse = 0;
    this.pulseV = 0;
    this.tier = tierFor(this.radius);
    this.tierFlash = 0;
    this._burstT = -1;
    this.alive = true;
    this.killedBy = null;
    this.syncVisual();
  }

  /** @param {number} dt seconds */
  update(dt, t) {
    this.tierUp = false;
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

    // --- feedback ---------------------------------------------------------
    // Silent resync. addScore() owns the celebratory transition, but the radius
    // can also be set from outside (dev harness, netcode snapshots) and without
    // this the next crumb the hole eats would fire a fireworks display for a
    // tier it crossed ten seconds ago.
    this.tier = tierFor(this.radius);
    this.chompImpulse *= Math.exp(-9.0 * dt);
    this.tierFlash *= Math.exp(-3.4 * dt);
    if (this._burstT >= 0) {
      this._burstT += dt;
      if (this._burstT > 0.85) this._burstT = -1;
    }

    // Squash-and-stretch spring. Semi-implicit Euler, clamped dt so a stalled
    // tab resuming with a 200 ms frame cannot make it explode.
    const sdt = Math.min(dt, 1 / 30);
    const K = 210, C = 13.5;
    this.pulseV += (-K * this.pulse - C * this.pulseV) * sdt;
    this.pulse += this.pulseV * sdt;
    // Bounded, because impulses ACCUMULATE: a whole city block going down in
    // one frame is a dozen addScore calls, and unbounded that slammed the
    // amplitude to its clamp and opened the drawn ground 22% wider than the
    // gameplay capture radius — objects visibly hovering over the void without
    // being eaten.
    this.pulse = THREE.MathUtils.clamp(this.pulse, -0.35, 0.35);

    // Display radius on its own, softer spring so growth overshoots and settles
    // rather than easing in — the overshoot is what reads as "it just ate".
    const RK = 120, RC = 15;
    this._radiusV += ((this.radius - this.displayRadius) * RK - RC * this._radiusV) * sdt;
    this.displayRadius += this._radiusV * sdt;
    // Never let the visual opening fall far under the gameplay radius, or
    // objects get captured outside the drawn lip.
    if (this.displayRadius < this.radius * 0.94) {
      this.displayRadius = this.radius * 0.94;
      this._radiusV = Math.max(this._radiusV, 0);
    }

    this._spillGrit(dt);

    this.pitMaterial.uniforms.uTime.value = t;
    // The day/night contract: engine.js republishes these every frame and the
    // pit is unlit, so this is the only way the throat knows the sun has gone.
    // Read off the parent rather than held as a reference — a hole is created
    // and disposed several times a match and must never pin a stale scene.
    const sd = this.group.parent && this.group.parent.userData;
    if (sd) {
      this.pitMaterial.uniforms.uNight.value = sd.nightFactor || 0;
      if (sd.sunDir) {
        const sx = sd.sunDir.x, sz = sd.sunDir.z;
        const m = Math.hypot(sx, sz);
        if (m > 1e-4) this.pitMaterial.uniforms.uSunXZ.value.set(sx / m, sz / m);
      }
    }
    this.syncVisual(t);
  }

  /**
   * Loose grit tumbling off the trailing lip while the hole moves. It is what
   * makes a hole feel like it is ploughing through the street rather than
   * sliding over a decal, and it costs two particles out of a pool that is
   * usually idle.
   */
  _spillGrit(dt) {
    const vx = this.velocity.x, vz = this.velocity.z;
    const sp = Math.sqrt(vx * vx + vz * vz);
    this._gritT -= dt;
    if (sp < 1.6 || this._gritT > 0) return;
    const fx = activeEffects();
    if (!fx) return;
    // Emission rate rises with speed but is floored, so a 60 m hole crawling
    // along does not out-emit the entire rest of the frame.
    this._gritT = 0.07 + 0.09 * (1 - Math.min(1, sp / 14));
    const r = this.displayRadius;
    // Behind the direction of travel, with enough angular spread that the
    // trail is a skirt rather than a jet.
    const a = Math.atan2(-vz, -vx) + (Math.random() - 0.5) * 1.5;
    _grit.set(
      this.position.x + Math.cos(a) * r * 1.02,
      0.06 + r * 0.02,
      this.position.z + Math.sin(a) * r * 1.02
    );
    fx.puff(_grit, PALETTE.DUST, 2, r * 0.14, 0.9 + sp * 0.05,
      0.10 + r * 0.032, 0.45 + r * 0.01);
  }

  syncVisual(t = 0) {
    const r = this.displayRadius;
    const p = this.pulse;
    // Volume-preserving-ish: wider means shallower, and vice versa. The gains
    // are large relative to the spring's amplitude (a mid-size meal peaks at
    // p ~= 0.13, a building at ~0.3) because the previous 0.085 gain moved the
    // lip by one percent — mathematically a pulse, visually nothing.
    // The lower clamp keeps the drawn opening from ever shrinking meaningfully
    // below the gameplay capture radius.
    const wide = Math.max(0.94, 1 + p * 0.38);
    const deep = 1 - p * 0.55;
    // Rim brightness, separate from the geometric squash. The player's rim
    // breathes and a rival's does not: bot palette entry 0 (#ff4d8d) is within
    // a few percent of the player's hot pink, and in a scrum that one cue is
    // the difference between "that is me" and "that WAS me".
    const glow = p + (this.isPlayer ? 0.12 + 0.12 * Math.sin(t * 2.6) : 0);

    this.group.position.set(this.position.x, 0, this.position.z);

    // ONE radius drives the ground cut, the pit and the collar. All three apply
    // the same torn-edge function, so if their radii disagree by even a percent
    // the pit's overhang escapes the cut on one side while the collar floats
    // over the void on the other. render/groundShader.js reads this field.
    this.cutRadius = r * wide;

    // Floor of 6.5 m, not 4.5: gameplay/consume.js plunges objects to
    // max(6, radius * PIT_DEPTH_F), and a funnel shallower than the fall lets
    // a swallowed bench pop out of the bottom of its own hole.
    const pitDepth = Math.max(6.5, r * HOLE.PIT_DEPTH_F);
    this.pit.scale.set(this.cutRadius, pitDepth * deep, this.cutRadius);
    this.cap.scale.set(r, 1, r);
    this.cap.position.y = -pitDepth * deep + 0.02;

    const u = this.lipUniforms;
    if (u) {
      u.uRadius.value = this.cutRadius;
      // Collar width in METRES, deliberately sublinear: cracks around a 60 m
      // hole should look like a shattered plate, not like a second crater.
      u.uWidth.value = Math.min(14, 0.85 + r * 0.52);
      // The collar heaves with the gulp too — the earth is being pushed up by
      // whatever just went down.
      u.uLift.value = Math.min(0.9, 0.045 + r * 0.038) * (1 + Math.max(0, p) * 0.9);
      u.uHtime.value = t;
      const sp = Math.hypot(this.velocity.x, this.velocity.z);
      if (sp > 0.001) u.uVel.value.set(this.velocity.x / sp, this.velocity.z / sp);
      u.uSpeed.value = Math.min(1, sp / 11);
      u.uPulse.value = glow;
      u.uFlash.value = this.tierFlash;
    }

    this.pitMaterial.uniforms.uPulse.value = glow;
    this.pitMaterial.uniforms.uFlash.value = this.tierFlash;

    // Tier-up burst: a ring that leaves the lip fast and thins as it goes.
    if (this._burstT >= 0) {
      const k = this._burstT / 0.85;
      const e = 1 - Math.pow(1 - k, 2.6);
      const br = r * (1.0 + e * 2.6);
      this.burst.visible = true;
      this.burst.scale.set(br, 1, br);
      this.burstMaterial.opacity = Math.pow(1 - k, 1.4) * 1.15;
    } else if (this.burst.visible) {
      this.burst.visible = false;
      this.burstMaterial.opacity = 0;
    }
  }

  dispose() {
    // Geometry is shared between every hole and survives match restarts; only
    // the per-hole materials are ours to free.
    this.pitMaterial.dispose();
    this.cap.material.dispose();
    this.lipMaterial.dispose();
    this.burstMaterial.dispose();
  }
}
