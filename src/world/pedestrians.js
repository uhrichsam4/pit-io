/**
 * PEDESTRIANS — the crowd that makes Miami read as a city instead of a model.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS BUILT THIS WAY
 * ---------------------------------------------------------------------------
 * A thousand people cannot be a thousand Object3Ds, and they cannot be one
 * static InstancedMesh either — a crowd that slides is worse than no crowd.
 * So the body is split into SIX instanced part meshes (head, hair, torso, arms,
 * thighs, shins) plus a handful of sparse accessory meshes, and every frame we
 * write the joint matrices for each agent straight into the instance buffers.
 * One agent therefore costs 0 draw calls and ~10 matrix writes; the whole crowd
 * costs twelve draws in the main pass plus four in the shadow pass, whatever
 * its size.
 *
 * Left/right limbs share one pool with two instances per agent (slot 2i / 2i+1)
 * rather than two pools, because a limb is symmetric enough not to need
 * mirroring and it halves the number of draws.
 *
 * ---------------------------------------------------------------------------
 * THE WALK CYCLE IS DRIVEN BY DISTANCE, NOT BY TIME
 * ---------------------------------------------------------------------------
 * `phase` advances by the metres actually travelled divided by the stride the
 * current leg amplitude produces, so the foot that is on the ground is
 * genuinely stationary in world space at mid-stance. Drive the phase off a
 * clock instead and every pedestrian moonwalks — that is the single most
 * common tell in a cheap crowd system.
 *
 * The thigh angle is a TRIANGLE wave in sin-space rather than a sine, and the
 * hip height is solved from whichever leg is straight. Together those two make
 * the planted sole a fixed point in world space: measured drift over a full
 * stance is 12 mm, against 140 mm for the naive sinusoidal cycle.
 *
 * ---------------------------------------------------------------------------
 * BEING EATEN — the handover
 * ---------------------------------------------------------------------------
 * The consume system animates ONE rigid object per swallow, so an agent made of
 * ten separately-posed instances cannot be handed to it directly. Every agent
 * therefore also owns a slot in a merged "fall body" pool: one arms-flailing
 * person, one matrix. THAT slot is the object the registry holds, and it is the
 * object the hole tips into the pit — nothing is spawned to stand in for it.
 *
 * The handover works exactly the way vehicles.js hands a car over: the moment
 * the consumable reports WOBBLE (the hole has taken ground from under it) this
 * module stops driving that agent entirely, collapses its ten animated parts,
 * and lets the consume system own the transform. Come back when the state says
 * IDLE again — the hole moved off, or the respawner brought them back — and the
 * agent stands up and carries on.
 *
 * Until then the fall-body slot is kept collapsed AND its authored scale is
 * kept at zero, so that any `restore()` the consume system performs while the
 * agent is on its feet (respawn, regained support) draws nothing. That is the
 * whole trick that lets one pool be invisible for 1,400 people and visible for
 * the two currently falling. Pool visibility itself is refcounted, so a crowd
 * with nobody falling costs no draw calls at all.
 *
 * The bug this replaces: the agent was KILLED at state >= FALLING while the
 * merged pool was `visible = false`, so a swallowed pedestrian blinked out of
 * existence while every other prop in the city visibly tipped and fell in.
 *
 * ---------------------------------------------------------------------------
 * COLOUR
 * ---------------------------------------------------------------------------
 * PALETTE has no skin or hair entries and it is owned by another pass, so the
 * sets below are assembled ENTIRELY from existing PALETTE values that happen to
 * sit in the right place on the wheel (palm trunk and timber for skin, tar seam
 * and butter for hair). Nothing here invents a colour. If skin ever gets first
 * class palette entries these arrays should point at them instead.
 */

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { PALETTE, TIER } from '../config.js';
import { makeRNG } from '../core/rng.js';
import { solid } from '../core/materials.js';
import { RoadNetwork } from './roadNetwork.js';
import { ZONE } from './cityLayout.js';

/* ============================================================== palette === */

/** Skin: warm timber and palm-trunk values, pale sand through deep walnut. */
const SKIN = [
  PALETTE.STUCCO_PEACH, PALETTE.SAND, PALETTE.WOOD_LIGHT, PALETTE.STUCCO_SAND,
  PALETTE.DIRT, PALETTE.PALM_TRUNK, PALETTE.PALM_TRUNK_DARK, PALETTE.WOOD_DARK,
  PALETTE.WOOD_LIGHT, PALETTE.PALM_TRUNK, PALETTE.STUCCO_PEACH, PALETTE.DIRT,
];

/** Hair: warm near-black, browns, auburn, blonde, grey. */
const HAIR = [
  PALETTE.TAR_SEAM, PALETTE.TAR_SEAM, PALETTE.WOOD_DARK, PALETTE.PALM_TRUNK_DARK,
  PALETTE.BRICK_DARK, PALETTE.STUCCO_BUTTER, PALETTE.GRAVEL, PALETTE.CONCRETE_DARK,
  PALETTE.TAR_SEAM, PALETTE.WOOD_DARK,
];

/** Everyday tops. Miami dresses loud; these are the fabric + pastel families. */
const TOP_CASUAL = [
  PALETTE.FABRIC_CORAL, PALETTE.FABRIC_AQUA, PALETTE.FABRIC_SUN, PALETTE.FABRIC_SKY,
  PALETTE.FABRIC_PINK, PALETTE.FABRIC_LIME, PALETTE.FABRIC_WHITE,
  PALETTE.STUCCO_MINT, PALETTE.STUCCO_LILAC, PALETTE.STUCCO_PEACH,
  PALETTE.STUCCO_AQUA, PALETTE.CAR_WHITE, PALETTE.NEON_AQUA, PALETTE.NEON_PINK,
];

/** Office: shirt whites, sky blues, and a few blazer darks. */
const TOP_OFFICE = [
  PALETTE.STUCCO_WHITE, PALETTE.CAR_WHITE, PALETTE.STUCCO_SKY, PALETTE.GLASS_SKY,
  PALETTE.SIGN_DARK, PALETTE.CAR_NAVY, PALETTE.STEEL_DARK, PALETTE.STUCCO_PINK,
];

/** Tourists wear the loudest thing they own. */
const TOP_TOURIST = [
  PALETTE.NEON_AQUA, PALETTE.NEON_PINK, PALETTE.FABRIC_SUN, PALETTE.FABRIC_LIME,
  PALETTE.NEON_ORANGE, PALETTE.FABRIC_CORAL, PALETTE.FABRIC_SKY,
];

const TOP_SPORT = [
  PALETTE.NEON_GREEN, PALETTE.NEON_AQUA, PALETTE.CAR_CORAL, PALETTE.FABRIC_SUN,
  PALETTE.CAR_WHITE, PALETTE.NEON_PINK, PALETTE.CAR_GRAPHITE,
];

/** Bottoms: denim navy, chino sand, graphite, black. */
const BOTTOM_LONG = [
  PALETTE.CAR_NAVY, PALETTE.CAR_NAVY, PALETTE.STEEL_DARK, PALETTE.CAR_GRAPHITE,
  PALETTE.WOOD_DECK, PALETTE.STUCCO_SAND, PALETTE.SIGN_DARK, PALETTE.GRAVEL,
];

/** Shorts / skirts read as a lighter, brighter band above bare legs. */
const BOTTOM_SHORT = [
  PALETTE.CAR_WHITE, PALETTE.STUCCO_SAND, PALETTE.FABRIC_SKY, PALETTE.CAR_NAVY,
  PALETTE.FABRIC_CORAL, PALETTE.STUCCO_MINT, PALETTE.WOOD_DECK,
];

const HAT_COLORS = [
  PALETTE.FABRIC_WHITE, PALETTE.STUCCO_SAND, PALETTE.FABRIC_SUN,
  PALETTE.FABRIC_CORAL, PALETTE.CAR_NAVY, PALETTE.SIGN_DARK,
];

const BAG_COLORS = [
  PALETTE.SIGN_DARK, PALETTE.CAR_NAVY, PALETTE.FABRIC_CORAL, PALETTE.WOOD_DARK,
  PALETTE.CAR_GRAPHITE, PALETTE.FABRIC_AQUA, PALETTE.NEON_ORANGE,
];

const BIKE_COLORS = [
  PALETTE.CAR_TEAL, PALETTE.CAR_CORAL, PALETTE.CAR_WHITE, PALETTE.CAR_YELLOW,
  PALETTE.CAR_GRAPHITE, PALETTE.NEON_PINK,
];

/**
 * Coat colours. Deliberately no near-blacks: the collar, the pale chest and the
 * socks are all BAKED, and a multiplying instance tint takes them down with the
 * coat, so a tar-black dog would erase every marking the model has.
 */
const DOG_COLORS = [
  PALETTE.WOOD_LIGHT, PALETTE.PALM_TRUNK, PALETTE.GRAVEL, PALETTE.CONCRETE_DARK,
  PALETTE.STUCCO_SAND, PALETTE.WOOD_DARK, PALETTE.PALM_TRUNK_DARK, PALETTE.SAND,
];

/** Phone bodies and camera gear: matte black, graphite, the odd rose-gold. */
const GEAR_DARK = [
  PALETTE.SIGN_DARK, PALETTE.CAR_GRAPHITE, PALETTE.TAR_SEAM, PALETTE.STEEL_DARK,
];
const PHONE_COLORS = [
  PALETTE.SIGN_DARK, PALETTE.CAR_GRAPHITE, PALETTE.STUCCO_PEACH,
  PALETTE.CAR_WHITE, PALETTE.TAR_SEAM, PALETTE.STUCCO_LILAC,
];
/** Takeaway cups: the lid is dark, the sleeve is kraft or a chain's colour. */
const CUP_COLORS = [
  PALETTE.FABRIC_WHITE, PALETTE.STUCCO_SAND, PALETTE.WOOD_LIGHT,
  PALETTE.CAR_WHITE, PALETTE.FABRIC_CORAL, PALETTE.STUCCO_MINT,
];
/** Doormen and valets: the whole point is that they read as staff, not crowd. */
const UNIFORM_DARK = [
  PALETTE.SIGN_DARK, PALETTE.TAR_SEAM, PALETTE.CAR_NAVY, PALETTE.STEEL_DARK,
];

/** Guayabera whites and pastels — the uniform of a Miami park table. */
const TOP_GUAYABERA = [
  PALETTE.FABRIC_WHITE, PALETTE.CAR_WHITE, PALETTE.STUCCO_CREAM,
  PALETTE.STUCCO_SKY, PALETTE.STUCCO_MINT, PALETTE.STUCCO_BUTTER,
  PALETTE.STUCCO_SAND,
];

/** After dark, outside a club. */
const TOP_NIGHT = [
  PALETTE.SIGN_DARK, PALETTE.NEON_PINK, PALETTE.TAR_SEAM, PALETTE.NEON_AQUA,
  PALETTE.CAR_WHITE,
];

/** What is laid out on a vendor's blanket or table. */
const GOODS_COLORS = [
  PALETTE.FABRIC_CORAL, PALETTE.FABRIC_SUN, PALETTE.FABRIC_AQUA,
  PALETTE.NEON_PINK, PALETTE.STUCCO_SAND, PALETTE.FABRIC_LIME,
];
/**
 * Bedding and bundled belongings.
 *
 * MID VALUES ONLY, and that is a rendering constraint rather than a taste one:
 * this tint multiplies the baked cardboard mat and the two bags as well as the
 * roll it is meant to colour, so a near-black navy turned the whole group into
 * one black shape. These read as blues, greys and faded canvas and still let
 * the baked parts through.
 */
const BEDDING_COLORS = [
  PALETTE.FABRIC_SKY, PALETTE.STUCCO_SKY, PALETTE.STEEL_DARK, PALETTE.STUCCO_SAND,
  PALETTE.GRAVEL, PALETTE.WOOD_DECK, PALETTE.CAR_TEAL, PALETTE.STUCCO_MINT,
];
/**
 * PIGEONS ARE PAINTED, NOT TINTED.
 *
 * They used to take a single per-instance grey from the pavement family, which
 * put a pale sand-grey lump on bone-coloured paving with no value separation at
 * all — 46 of them read as litter. The bird now bakes its own plumage (blue-grey
 * body, near-black head, pale wing bar, coral feet) and the instance tint is a
 * near-white wash that only shifts it warm or cool, so the value break against
 * the pavement survives whatever it is standing on.
 */
const PIGEON_COLORS = [
  PALETTE.FABRIC_WHITE, PALETTE.CAR_WHITE, PALETTE.STUCCO_WHITE,
  PALETTE.CAR_TRIM, PALETTE.CAR_SILVER, PALETTE.FABRIC_WHITE,
];
const PIGEON_BODY = PALETTE.GLASS_SMOKE;     // 0x8fa6b0 — the blue-grey back
const PIGEON_HEAD = PALETTE.CAR_GRAPHITE;    // distinctly darker head and neck
const PIGEON_BAR = PALETTE.CAR_SILVER;       // the pale wing bar
const PIGEON_FOOT = PALETTE.NEON_ORANGE;     // coral legs and feet
/**
 * WHAT THE PER-INSTANCE TINT ACTUALLY DRIVES, kind by kind.
 *
 * The tint multiplies EVERY vertex of a prop, so a kind whose parts are genuine
 * different materials cannot also use the tint for one of them. The rule these
 * props now follow: bake the materials, and reserve the tint for the single
 * part that is supposed to vary — the vendor's soft goods, the table's cloth,
 * the sleeping bag's fabric. Where nothing should vary (a chrome trolley, a
 * blue-grey pigeon) the tint is a near-neutral wash so the bake reads true.
 */
const STREET_HEX = {
  streetMat: PALETTE.FABRIC_CORAL,     // the folded fabric and the caps
  streetTable: PALETTE.FABRIC_WHITE,   // the cloth only
  streetCooler: PALETTE.FABRIC_SKY,    // the tub; the lid is baked pale
  bedroll: PALETTE.CAR_NAVY,           // the roll only; the bags are baked
  trolley: 0xdde3e7,                   // near-neutral: chrome and frame are baked
  soapbox: PALETTE.WOOD_DECK,
  signCard: 0xd8b48a,
  pigeon: PALETTE.FABRIC_WHITE,
  pigeonPeck: PALETTE.FABRIC_WHITE,
};

/** Cooler tubs, so a street is not lined with identical sky-blue boxes. */
// Mid-value tubs only. The lid is baked pale and MULTIPLIED by this, so a
// near-black tub would take the white lid down with it.
const COOLER_COLORS = [
  PALETTE.FABRIC_SKY, PALETTE.CAR_CORAL, PALETTE.CAR_TEAL, PALETTE.STUCCO_WHITE,
  PALETTE.CAR_ORANGE, PALETTE.STUCCO_SKY, PALETTE.CAR_MINT,
];
/** Market cloths: whites, creams and washed pastels. */
const CLOTH_COLORS = [
  PALETTE.FABRIC_WHITE, PALETTE.CAR_WHITE, PALETTE.STUCCO_CREAM,
  PALETTE.STUCCO_SKY, PALETTE.STUCCO_MINT, PALETTE.STUCCO_PINK,
];
/** Kraft browns for a torn-up cardboard sign. */
const CARD_COLORS = [0xd8b48a, 0xc9a175, 0xe0c29c, 0xcfae8b];

/* ============================================================ dimensions === */

/**
 * One "body unit" is one metre on a 1.79 m adult, and every agent is then
 * scaled 0.88-1.06 so the crowd has real height variation. Joint heights are
 * measured from the sole.
 */
/**
 * PROPORTION. The rig used to be 51% leg with a small head, which is a shop
 * mannequin, not a person — and 1,900 mannequins is what a reviewer sees first.
 * The legs are 8% shorter, the trunk carries the difference and the head is 6%
 * bigger, which lands the figure at ~6.5 heads: still an adult, but chunky and
 * stylised the way the rest of the city is.
 *
 * Everything downstream is DERIVED, never re-typed. The sitting poses solve the
 * shin angle from the seat height and the walk solves hip height from the
 * planted leg, so a literal 0.42 anywhere below would silently put every
 * sitter's shoes through the pavement the moment these numbers moved.
 */
const THIGH_L = 0.386;
const SHIN_L = 0.386;
const SHOE_H = 0.056;
const LEG_L = THIGH_L + SHIN_L;
/** Knee joint to the sole, along the shin axis — what a seated leg has to reach. */
const SOLE_L = SHIN_L + SHOE_H - 0.012;
const ANKLE_Y = 0.047;      // sole to ankle when the leg is straight
const HIP_Y = ANKLE_Y + LEG_L + 0.008;   // hip joint, shoe on ground
const SHOULDER_Y = 0.568;   // above the hip joint
const NECK_Y = 0.585;       // above the hip joint
const SHOULDER_X = 0.185;
const HIP_X = 0.094;
/** Crown height above the neck base — sets the declared consumable height. */
const HEAD_TOP = 0.325;
const BODY_H = HIP_Y + NECK_Y + HEAD_TOP;

/* ================================================================ modes === */

const MODE = {
  WALK: 0,      // following a block's sidewalk loop
  APPROACH: 1,  // stepping off the loop toward a crossing kerb
  WAIT: 2,      // at the kerb, watching the signal
  CROSS: 3,     // in the marked crosswalk
  IDLE: 4,      // standing / chatting
  SIT: 5,       // on a bench, a chair, a step, a lawn
  CYCLE: 6,     // in the kerb lane
  FLEE: 7,      // the hole is close: arms up, run
  RETURN: 8,    // walking back to the spot they bolted from
  GAZE: 9,      // stopped mid-pavement, head up at the skyline
  FILM: 10,     // part of a shoot: to camera, operating, boom, reflector, posing
  QUEUE: 11,    // in a line at a door or a counter
  SERVE: 12,    // a server working a terrace: table, table, pass, repeat
  ESCORT: 13,   // a child locked to the adult they are with
  GOTO: 14,     // walking to an assigned spot, then adopting `thenMode`
};

/**
 * Where a hand-held item rides. One instanced pool serves every one of these:
 * a phone, a coffee, a camera, a boom pole, a reflector and a busker's drum are
 * the same six-sided prism at six different scales, so the whole of "what the
 * city is holding" costs exactly one draw call.
 */
const AT = {
  HAND_R: 0,    // in the right hand, tracking the arm swing
  HAND_L: 1,
  CHEST: 2,     // lanyard, slung camera — rides the leaning torso
  BOOM: 3,      // long pole angled up and forward over the subject
  BOOM_MIC: 4,  // the blimp on the end of that pole
  PANEL: 5,     // reflector / clapper held up in front of the chest
  DRUM: 6,      // bucket drum between the knees
  SEAT: 7,      // the crate they are sitting ON, standing on the ground
  FACE: 8,      // sunglasses across the eyes — rides the head, not the torso
};

/* ============================================================= geometry === */

/**
 * Attach a constant greyscale multiplier as a vertex colour.
 *
 * Instance colour and vertex colour both multiply into diffuse, which is how a
 * single per-agent tint still produces a dark shoe on a pale leg: the shoe
 * verts carry 0.3 and the rest carry 1.0.
 */
function shadeGeo(geo, k) {
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  col.fill(k);
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/**
 * Attach an explicit linear-space RGB to every vertex (fall-body only), keeping
 * whatever greyscale shading the part already carried so the shoes stay dark.
 */
function paintGeo(geo, hex) {
  const c = new THREE.Color(hex);   // ColorManagement converts sRGB -> linear
  const n = geo.attributes.position.count;
  const prev = geo.attributes.color;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const k = prev ? prev.array[i * 3] : 1;
    col[i * 3] = c.r * k; col[i * 3 + 1] = c.g * k; col[i * 3 + 2] = c.b * k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

function box(w, h, d, x, y, z, k = 1) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return shadeGeo(g, k);
}

/**
 * A box with all twelve edges chamfered. 24 unique corners, 44 triangles.
 *
 * A raw 90-degree box edge is the loudest tell of cheap 3D and the art bible
 * bans it outright, but a properly rounded box costs hundreds of triangles.
 * This is the cheap honest answer: one flat chamfer on every edge and corner,
 * which is all the key light needs to draw a bright line down every silhouette.
 *
 * Winding is decided per triangle by testing the facet normal against the box
 * centre rather than by reasoning about sign conventions, so there is no family
 * of faces that can quietly end up inside out. Indexed and carrying position /
 * normal / uv, because mergeGeometries refuses to mix indexed with non-indexed
 * or geometries with different attribute sets.
 */
function bevBox(w, h, d, x = 0, y = 0, z = 0, k = 1, c = 0) {
  const H = [w / 2, h / 2, d / 2];
  const ch = c > 0 ? c : Math.min(0.018, Math.min(w, h, d) * 0.20);
  const IN = H.map((e) => Math.max(1e-4, e - ch));
  /** The vertex of corner `s` that lies on the face normal to `ax`. */
  const V = (s, ax) => [0, 1, 2].map((i) => s[i] * (i === ax ? H[i] : IN[i]));

  const pos = [];
  const push = (p) => { pos.push(p[0] + x, p[1] + y, p[2] + z); };
  const tri = (a, b, cc) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = cc[0] - a[0], vy = cc[1] - a[1], vz = cc[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const gx = (a[0] + b[0] + cc[0]) / 3, gy = (a[1] + b[1] + cc[1]) / 3,
          gz = (a[2] + b[2] + cc[2]) / 3;
    if (nx * gx + ny * gy + nz * gz < 0) { push(a); push(cc); push(b); }
    else { push(a); push(b); push(cc); }
  };
  const quad = (a, b, cc, dd) => { tri(a, b, cc); tri(a, cc, dd); };

  const SG = [-1, 1];
  // Six inset faces.
  for (let ax = 0; ax < 3; ax++) {
    const u = (ax + 1) % 3, v = (ax + 2) % 3;
    for (const s of SG) {
      const ring = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sv]) => {
        const cor = [];
        cor[ax] = s; cor[u] = su; cor[v] = sv;
        return V(cor, ax);
      });
      quad(ring[0], ring[1], ring[2], ring[3]);
    }
  }
  // Twelve edge chamfers.
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      const kAx = 3 - i - j;
      for (const si of SG) {
        for (const sj of SG) {
          const c1 = []; c1[i] = si; c1[j] = sj; c1[kAx] = -1;
          const c2 = []; c2[i] = si; c2[j] = sj; c2[kAx] = 1;
          quad(V(c1, i), V(c2, i), V(c2, j), V(c1, j));
        }
      }
    }
  }
  // Eight corner facets.
  for (const sx of SG) for (const sy of SG) for (const sz of SG) {
    const cor = [sx, sy, sz];
    tri(V(cor, 0), V(cor, 1), V(cor, 2));
  }

  const n = pos.length / 3;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  g.setIndex([...Array(n).keys()]);
  g.computeVertexNormals();
  return shadeGeo(g, k);
}

/**
 * A chamfered bar: a regular prism scaled so its FLAT faces land exactly on the
 * requested half-extents (the corners are then inside the box, not outside it).
 * `seg` 6 gives 24 triangles against a bevBox's 44 — the right trade for a leg,
 * a rail or a slat, where only the long edges are ever seen.
 */
function bar(w, h, d, x, y, z, k = 1, seg = 6) {
  const g = new THREE.CylinderGeometry(0.5, 0.5, 1, seg, 1, false, Math.PI / seg);
  const f = 1 / Math.cos(Math.PI / seg);
  g.scale(w * f, h, d * f);
  g.translate(x, y, z);
  return shadeGeo(g, k);
}

/** The same prism lying along +z, tapered front to back. Bodies, tails, necks. */
function barZ(rFront, rBack, len, x, y, z, k = 1, seg = 6, sx = 1, sy = 1) {
  const g = new THREE.CylinderGeometry(rFront, rBack, len, seg, 1, false, Math.PI / seg);
  g.rotateX(Math.PI / 2);
  if (sx !== 1 || sy !== 1) g.scale(sx, sy, 1);
  g.translate(x, y, z);
  return shadeGeo(g, k);
}

/**
 * Re-shade a geometry as a vertical gradient — pale sock at the bottom of a
 * leg, scuffed wear at the base of a crate, a darker jaw under a skull. Free
 * detail: it adds no vertices at all, and it is the only way to get a second
 * tone out of a part that has to stay one draw call.
 */
function gradY(geo, y0, y1, k0, k1) {
  const pos = geo.attributes.position;
  const col = geo.attributes.color;
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, (pos.getY(i) - y0) / Math.max(1e-5, y1 - y0)));
    const k = k0 + (k1 - k0) * t;
    col.array[i * 3] *= k; col.array[i * 3 + 1] *= k; col.array[i * 3 + 2] *= k;
  }
  return geo;
}

/**
 * A part in an explicit colour: what it becomes when the instance tint is white.
 *
 * Instance colour and vertex colour both multiply into diffuse, so a prop whose
 * parts are genuinely different MATERIALS — a steel leg, a white cloth, a black
 * stock block — has to carry those as absolute vertex colours and keep the
 * per-instance tint for the one part that is meant to vary. Values above 1 are
 * legal and deliberate: they let a part stay pale under a saturated tint.
 */
function hue(geo, hex, k = 1) {
  if (k !== 1 && geo.attributes.color) {
    const a = geo.attributes.color.array;
    for (let i = 0; i < a.length; i++) a[i] *= k;
  }
  return paintGeo(geo, hex);
}

/**
 * Sit a finished prop exactly ON the ground plane.
 *
 * Anything assembled out of rotated parts lands a few millimetres off, and both
 * directions are an automatic review failure: sunk props z-fight the paving,
 * floating ones read as stickers. Measuring the merged result once at build
 * time is cheaper and far more reliable than hand-solving every rotation.
 */
function ground(geo) {
  geo.computeBoundingBox();
  const min = geo.boundingBox.min.y;
  if (min !== 0) { geo.translate(0, -min, 0); geo.computeBoundingBox(); }
  return geo;
}

/**
 * A limb / trunk segment hanging DOWN from its joint at the origin.
 * `thetaStart` puts a flat face forward rather than an edge, which is what
 * makes a 5- or 6-sided prism read as chunky rather than as a spike.
 */
function limb(rTop, rBot, len, seg, k = 1, squashZ = 1, open = false) {
  const g = new THREE.CylinderGeometry(rTop, rBot, len, seg, 1, open, Math.PI / seg);
  g.translate(0, -len / 2, 0);
  if (squashZ !== 1) g.scale(1, 1, squashZ);
  return shadeGeo(g, k);
}

/** Same, but rising UP from the joint (torso). */
function trunk(rBot, rTop, len, seg, k = 1, squashZ = 1, open = false) {
  const g = new THREE.CylinderGeometry(rTop, rBot, len, seg, 1, open, Math.PI / seg);
  g.translate(0, len / 2, 0);
  if (squashZ !== 1) g.scale(1, 1, squashZ);
  return shadeGeo(g, k);
}

/**
 * Torso: pivot at the hip joint.
 *
 * The trunk is subdivided vertically for ONE reason: it buys a collar band at
 * the neck and a belt line at the waist out of vertex colour, at 12 extra
 * triangles and no extra draw. A person whose shirt, collar and waistband are
 * three tones stops reading as a painted cylinder from ten metres.
 *
 * The shoulder yoke used to be a hard-cornered box slab laid across a hexagonal
 * chest, which read as a crate strapped to the front — it is now a chamfered
 * eight-sided prism, so the deltoid line curves the way a shoulder does.
 */
function torsoGeo() {
  const parts = [];
  const body = trunk(0.158, 0.205, 0.653, 6, 1.0, 0.68, true);
  body.translate(0, -0.085, 0);
  parts.push(body);
  // Waistband: a narrow ring standing 1 cm proud of the trunk, aligned to the
  // same hexagon so it cannot poke through unevenly. Crisper than shading the
  // trunk's own vertices, which would smear the belt over a third of the shirt.
  const belt = new THREE.CylinderGeometry(0.180, 0.180, 0.042, 6, 1, true, Math.PI / 6);
  belt.scale(1, 1, 0.70);
  belt.translate(0, 0.098, 0);
  parts.push(shadeGeo(belt, 0.55));
  // Shirt collar, standing above the yoke around the neck.
  const collar = new THREE.CylinderGeometry(0.084, 0.080, 0.055, 6, 1, true, Math.PI / 6);
  collar.scale(1, 1, 0.90);
  collar.translate(0, 0.618, 0.004);
  parts.push(shadeGeo(collar, 0.80));
  // Shoulders, not a plate: an eight-sided prism that TAPERS inward as it
  // rises, so the deltoid line slopes the way a shoulder does instead of
  // sitting on the chest like a lid.
  const yoke = new THREE.CylinderGeometry(0.5 * 0.84, 0.5, 0.185, 8, 1, false, Math.PI / 8);
  yoke.scale(0.398 * 1.0824, 1, 0.248 * 1.0824);
  yoke.translate(0, SHOULDER_Y - 0.058, 0);
  parts.push(shadeGeo(yoke, 1.0));
  return BufferGeometryUtils.mergeGeometries(parts, false);
}

/**
 * Head: pivot at the neck base. Skin tint.
 *
 * THE FACE IS FOUR SMALL SOLIDS AND A GRADIENT, and it is the single highest
 * value thirty triangles in this file: two dark eyes, a brow-and-nose wedge and
 * a darker jaw turn a faceless dummy into a person at three metres, which is
 * where the camera spends the whole first minute of a match.
 *
 * Everything here is shaded GREYSCALE rather than coloured, because the fall
 * body bakes this same geometry to an absolute skin hex and reads the first
 * channel back as a multiplier — a blue eye would come out of that as a blue
 * skin tone.
 */
function headGeo() {
  const parts = [];
  const neck = limb(0.052, 0.058, 0.078, 5, 0.86, 1, true);
  neck.translate(0, 0.058, 0);
  parts.push(neck);
  const skull = new THREE.SphereGeometry(0.121, 7, 3);
  skull.scale(1, 1.16, 0.95);
  skull.translate(0, 0.185, 0.004);
  shadeGeo(skull, 1.0);
  // Jaw shading: the underside of a head is always in shadow, and painting it
  // is what gives the sphere a chin instead of a horizon.
  gradY(skull, 0.075, 0.175, 0.74, 1.0);
  parts.push(skull);
  // Eyes. Small solids rather than cards, so they never read as a decal
  // edge-on, and standing ~1 mm proud of the skull so they cannot z-fight it.
  for (const s of [-1, 1]) {
    parts.push(box(0.024, 0.028, 0.020, s * 0.044, 0.196, 0.106, 0.13));
  }
  // Brow and nose in one wedge — a four-sided cone is six triangles and reads
  // as a profile from the side, which two eyes alone never do.
  const nose = new THREE.ConeGeometry(0.016, 0.032, 4, 1, false, Math.PI / 4);
  nose.rotateX(Math.PI / 2);
  nose.scale(0.85, 0.80, 1);
  nose.translate(0, 0.166, 0.106);
  parts.push(shadeGeo(nose, 0.90));
  return BufferGeometryUtils.mergeGeometries(parts, false);
}

/**
 * Hair: a cap over the skull, pivot at the neck base. Per-agent scaled.
 *
 * THE HAIRLINE IS WHY THE CROWD WAS FACELESS. The old cap ran a full 98 degrees
 * from the crown at a radius larger than the skull's, which means it enclosed
 * the front of the head down past the eye line — a helmet, not hair. Anything
 * put on the face would have been rendered inside it. It is two pieces now: a
 * full crown down to the brow, and a back-and-sides band below that with a
 * 70-degree wedge left open at the front.
 */
function hairGeo() {
  const parts = [];
  const crown = new THREE.SphereGeometry(0.131, 6, 2, 0, Math.PI * 2, 0, 1.30);
  crown.scale(1, 1.14, 1.0);
  crown.translate(0, 0.178, -0.006);
  parts.push(shadeGeo(crown, 1.0));
  const back = new THREE.SphereGeometry(
    0.131, 6, 1, Math.PI / 2 + 0.62, Math.PI * 2 - 1.24, 1.26, 0.52);
  back.scale(1, 1.14, 1.0);
  back.translate(0, 0.178, -0.006);
  parts.push(shadeGeo(back, 0.92));
  return BufferGeometryUtils.mergeGeometries(parts, false);
}

/**
 * Arm: pivot at the shoulder, ending in a HAND.
 *
 * A blunt cylinder stub at the end of an arm is what made the old crowd read as
 * shop dummies. The hand is a squashed four-by-two sphere — eight triangles —
 * and the cuff ring above it gives the sleeve somewhere to end, so the
 * arm/shirt break is a shape rather than only a colour change.
 */
const ARM_L = 0.545;
function armGeo() {
  const parts = [];
  parts.push(limb(0.062, 0.048, ARM_L, 5, 1.0, 1, true));
  // Cuff: a short flared ring where a sleeve or a watch strap would sit.
  const cuff = new THREE.CylinderGeometry(0.052, 0.050, 0.036, 5, 1, true, Math.PI / 5);
  cuff.translate(0, -ARM_L + 0.052, 0);
  parts.push(shadeGeo(cuff, 0.70));
  // A four-segment sphere is a pencil tip, not a hand. A chunky box at the
  // same triangle cost reads as a fist from three metres and from forty.
  const hand = new THREE.BoxGeometry(0.070, 0.086, 0.058);
  hand.rotateX(0.18);
  hand.translate(0, -ARM_L - 0.030, 0.008);
  parts.push(shadeGeo(hand, 1.05));
  return BufferGeometryUtils.mergeGeometries(parts, false);
}

/** Thigh: pivot at the hip. The hem of a short leg is baked in as a band. */
function thighGeo() {
  const g = limb(0.095, 0.078, THIGH_L, 5, 1.0, 1, true);
  gradY(g, -THIGH_L, -THIGH_L + 0.05, 0.86, 1.0);
  return g;
}

/**
 * Shin + shoe: pivot at the knee.
 *
 * The shoe is one box subdivided once vertically, which costs eight triangles
 * and buys a pale SOLE line all the way round the side — the contrasting shoe
 * sole the crowd was missing, without a second solid.
 */
function shinGeo() {
  const parts = [];
  parts.push(limb(0.076, 0.061, SHIN_L, 5, 1.0, 1, true));
  // Upper and sole as two solids. A shading gradient across one box gave a
  // smear; two boxes give the crisp pale sole line a shoe actually has.
  const y0 = -SHIN_L - SHOE_H + 0.012;
  parts.push(box(0.102, 0.019, 0.222, 0, y0 + 0.0095, 0.040, 0.86));
  parts.push(box(0.094, SHOE_H - 0.019, 0.206, 0, y0 + 0.019 + (SHOE_H - 0.019) * 0.5,
    0.036, 0.26));
  return BufferGeometryUtils.mergeGeometries(parts, false);
}

/**
 * Sun hat / cap / hard hat: one geometry, widened or narrowed per agent.
 * The crown is deliberately oversized (0.126 vs a 0.086 skull section at brim
 * height) so even the narrowest scale still covers the head instead of letting
 * it poke out of the sides.
 */
function hatGeo() {
  const parts = [];
  const crown = new THREE.CylinderGeometry(0.072, 0.134, 0.108, 6, 1, false, Math.PI / 6);
  crown.translate(0, 0.310, 0);
  parts.push(shadeGeo(crown, 1.0));
  const brim = new THREE.CylinderGeometry(0.160, 0.160, 0.016, 8, 1, false);
  brim.translate(0, 0.257, 0.014);
  parts.push(shadeGeo(brim, 0.92));
  // Hat band — the one detail that separates a cap from a bucket at 3 m.
  const band = new THREE.CylinderGeometry(0.137, 0.137, 0.026, 6, 1, true, Math.PI / 6);
  band.translate(0, 0.268, 0);
  parts.push(shadeGeo(band, 0.55));
  return BufferGeometryUtils.mergeGeometries(parts, false);
}

/**
 * Backpack / shoulder bag / tote. Pivot at the hip, rides the torso.
 *
 * One geometry, three silhouettes: the placer squashes it and slides it to the
 * hip to make a shoulder bag or a flat tote out of the same 92 triangles. A
 * crowd where a third of the people are carrying something, and not all the
 * same something, is most of what stops 1,900 figures reading as clones.
 */
function bagGeo() {
  const parts = [];
  parts.push(bevBox(0.255, 0.30, 0.150, 0, 0.300, -0.170, 1.0, 0.014));
  parts.push(box(0.262, 0.115, 0.158, 0, 0.408, -0.174, 0.80));        // flap
  parts.push(box(0.048, 0.038, 0.022, 0, 0.352, -0.252, 0.28));        // buckle
  for (const s of [-1, 1]) {
    parts.push(box(0.042, 0.285, 0.030, s * 0.086, 0.370, -0.088, 0.62));
  }
  return BufferGeometryUtils.mergeGeometries(parts, false);
}

/**
 * Hi-vis vest or a server's apron: a boxy shell that has to sit PROUD of the
 * hexagonal torso underneath, or it renders inside the shirt and vanishes.
 */
function overlayGeo() {
  return box(0.40, 0.38, 0.285, 0, 0.215, 0, 1.0);
}

/** Bicycle, pivot at the ground under the saddle. */
function bikeGeo() {
  const parts = [];
  for (const zz of [0.52, -0.52]) {
    // A thin open cylinder reads as a wheel for a tenth of a torus's triangles.
    const w = new THREE.CylinderGeometry(0.335, 0.335, 0.036, 10, 1, true);
    w.rotateZ(Math.PI / 2);
    w.translate(0, 0.335, zz);
    parts.push(shadeGeo(w, 0.34));
  }
  parts.push(box(0.045, 0.045, 0.95, 0, 0.60, 0, 1.0));      // top tube
  parts.push(box(0.045, 0.34, 0.045, 0, 0.44, -0.22, 1.0));  // seat tube
  parts.push(box(0.045, 0.40, 0.045, 0, 0.46, 0.40, 1.0));   // head tube
  parts.push(box(0.135, 0.05, 0.30, 0, 0.80, -0.34, 0.36));  // saddle
  parts.push(box(0.44, 0.038, 0.038, 0, 0.90, 0.46, 0.5));   // bars
  return BufferGeometryUtils.mergeGeometries(parts, false);
}

/** Skateboard, pivot at the ground. */
function boardGeo() {
  const parts = [];
  parts.push(box(0.20, 0.030, 0.78, 0, 0.095, 0, 1.0));
  for (const zz of [0.24, -0.24]) parts.push(box(0.20, 0.055, 0.075, 0, 0.045, zz, 0.28));
  return BufferGeometryUtils.mergeGeometries(parts, false);
}

/**
 * A dog on a lead, pivot at the ground. Three breeds, ~0.5 m at the shoulder.
 *
 * The old one was five axis-aligned boxes with a single flat slab standing in
 * for each PAIR of legs — no snout, no ears, no neck, no individual legs. At
 * 0.5 m tall on a pavement the camera gets closer to a dog than to anything
 * else in the city, so it is built the way the animal is: a tapered barrel with
 * a real chest and haunch, a skull with a muzzle and ears on a neck, four
 * separate legs with a gap between each pair, and a tapering tail.
 *
 * MARKINGS, NOT ONE FLAT COAT. The coat is the per-instance tint, but the
 * chest, muzzle and paws are baked pale and the ears and back baked dark, so a
 * single tint produces a dog with a blaze, a pale chest and socks. That is
 * worth more than a per-instance collar hue, which a multiplying tint cannot
 * deliver anyway — the collar is baked bright per breed instead.
 *
 * @param {'short'|'lean'|'fluffy'} breed
 */
const DOG_BREEDS = ['short', 'lean', 'fluffy'];
function dogGeo(breed = 'short') {
  const B = {
    // shoulder  bodyLen  girth  legR  headS  ears     tail        collar
    short:  { sh: 0.27, bl: 0.50, gr: 0.112, lr: 0.040, hs: 0.94, ear: 'drop', tail: 'low',  col: PALETTE.CAR_RED },
    lean:   { sh: 0.46, bl: 0.42, gr: 0.096, lr: 0.030, hs: 0.86, ear: 'rose', tail: 'whip', col: PALETTE.CAR_TEAL },
    fluffy: { sh: 0.37, bl: 0.40, gr: 0.130, lr: 0.036, hs: 1.00, ear: 'prick', tail: 'curl', col: PALETTE.CAR_YELLOW },
  }[breed];
  const parts = [];
  const Y = B.sh;                       // spine height
  const zF = B.bl * 0.5, zB = -B.bl * 0.5;

  /* --- barrel: chest, waist, haunch. A dog is deeper than it is wide. ----- */
  const chest = barZ(B.gr * 0.86, B.gr * 1.06, B.bl * 0.40, 0, Y, zF - B.bl * 0.20,
    1.0, 6, 0.88, 1.08);
  gradY(chest, Y - B.gr, Y, 1.30, 0.96);           // pale chest and belly
  parts.push(chest);
  const waist = barZ(B.gr * 1.06, B.gr * 0.90, B.bl * 0.32, 0, Y - 0.004, 0,
    1.0, 6, 0.88, 1.08);
  gradY(waist, Y - B.gr, Y, 1.16, 0.92);
  parts.push(waist);
  const rump = barZ(B.gr * 0.90, B.gr * 1.02, B.bl * 0.38, 0, Y - 0.006,
    zB + B.bl * 0.18, 1.0, 6, 0.88, 1.08);
  gradY(rump, Y - B.gr, Y, 1.12, 0.88);
  parts.push(rump);

  /* --- neck and head ----------------------------------------------------- */
  const neckLen = B.hs * (B.ear === 'rose' ? 0.19 : 0.15);
  const neck = new THREE.CylinderGeometry(B.gr * 0.56, B.gr * 0.78, neckLen, 6, 1, false, Math.PI / 6);
  neck.rotateX(1.05);                                // raked up and forward
  neck.translate(0, Y + neckLen * 0.34, zF - 0.02 + neckLen * 0.42);
  parts.push(shadeGeo(neck, 1.08));

  const hx = zF + neckLen * 0.72 - 0.015;
  const hy = Y + neckLen * 0.66;
  const skull = bevBox(0.128 * B.hs, 0.112 * B.hs, 0.145 * B.hs, 0, hy, hx, 0.94, 0.014);
  parts.push(skull);
  const muzzle = bevBox(0.070 * B.hs, 0.064 * B.hs, 0.098 * B.hs,
    0, hy - 0.020 * B.hs, hx + 0.108 * B.hs, 1.28, 0.010);
  parts.push(muzzle);
  // Nose and eyes. Twenty-four triangles, and the difference between an animal
  // and a shape: at 0.5 m the camera gets closer to a dog than to any other
  // prop in the city.
  const snout = new THREE.SphereGeometry(0.020 * B.hs, 4, 2);
  snout.scale(1.15, 0.85, 0.9);
  snout.translate(0, hy + 0.002 * B.hs, hx + 0.156 * B.hs);
  parts.push(hue(shadeGeo(snout, 1.0), PALETTE.SIGN_DARK));
  for (const s of [-1, 1]) {
    parts.push(box(0.017 * B.hs, 0.019 * B.hs, 0.014 * B.hs,
      s * 0.042 * B.hs, hy + 0.022 * B.hs, hx + 0.048 * B.hs, 0.13));
  }

  for (const s of [-1, 1]) {
    if (B.ear === 'drop') {
      // A folded ear hanging beside the cheek.
      const e = bar(0.030 * B.hs, 0.130 * B.hs, 0.080 * B.hs,
        s * 0.074 * B.hs, hy - 0.038 * B.hs, hx - 0.012, 0.70, 6);
      e.rotateZ(s * -0.14);
      parts.push(e);
    } else {
      const e = new THREE.ConeGeometry(0.042 * B.hs, 0.082 * B.hs, 3, 1, false, Math.PI / 3);
      e.scale(1, 1, 0.55);
      e.rotateZ(s * (B.ear === 'rose' ? 0.34 : 0.18));
      e.translate(s * 0.046 * B.hs, hy + 0.078 * B.hs, hx - 0.012);
      parts.push(shadeGeo(e, 0.72));
    }
  }

  /* --- collar, baked bright so it survives a dark coat -------------------- */
  const collar = new THREE.CylinderGeometry(B.gr * 0.72, B.gr * 0.80, 0.036, 8, 1, true, Math.PI / 8);
  collar.rotateX(1.05);
  collar.translate(0, Y + neckLen * 0.30, zF - 0.02 + neckLen * 0.38);
  parts.push(hue(shadeGeo(collar, 1.0), B.col, 1.85));
  parts.push(hue(box(0.020, 0.024, 0.008, 0, Y + neckLen * 0.16, zF + 0.055, 1.0),
    PALETTE.CAR_YELLOW, 1.7));                        // name tag

  /* --- four legs, with a gap between each pair ---------------------------- */
  // The rear pair is TWO segments with a hock between them. Four identical
  // straight rods is what made the old dog read as a table with a head.
  const top = Y - B.gr * 0.55;
  const legSeg = (s, x, y0, y1, z0, z1, rA, rB, k) => {
    const len = Math.hypot(y1 - y0, z1 - z0);
    const g = new THREE.CylinderGeometry(rA, rB, len, 5, 1, false, Math.PI / 5);
    g.rotateX(Math.atan2(z1 - z0, y1 - y0));
    g.translate(s * x, (y0 + y1) / 2, (z0 + z1) / 2);
    return shadeGeo(g, k);
  };
  for (const s of [-1, 1]) {
    const fx = B.gr * 0.50, fz = zF - 0.075;
    const fl = legSeg(s, fx, top, 0.030, fz, fz + 0.014, B.lr * 1.30, B.lr * 0.86, 0.94);
    gradY(fl, 0, 0.075, 1.34, 0.96);
    parts.push(fl);
    parts.push(box(B.lr * 2.2, 0.030, B.lr * 2.9, s * fx, 0.016, fz + 0.020, 1.26));
    // Rear: thigh raked back to a hock, then a shank forward to the paw.
    const rx = B.gr * 0.50, rz = zB + 0.085, hockY = top * 0.44, hockZ = rz - 0.085;
    parts.push(legSeg(s, rx, top + 0.020, hockY, rz, hockZ, B.lr * 1.55, B.lr * 0.92, 0.94));
    const rl = legSeg(s, rx, hockY, 0.030, hockZ, hockZ + 0.052, B.lr * 0.92, B.lr * 0.80, 0.94);
    gradY(rl, 0, 0.075, 1.34, 0.96);
    parts.push(rl);
    parts.push(box(B.lr * 2.2, 0.030, B.lr * 2.9, s * rx, 0.016, hockZ + 0.058, 1.26));
  }

  /* --- tail: two tapering segments, tapering and lifting ------------------ */
  // Direction (0, sin a, -cos a): a cylinder runs along +y, so rotateX(a - PI/2)
  // aims it backward and up by `a`.
  const tSpec = { low: [0.45, 0.85], whip: [0.15, 0.55], curl: [1.15, 2.15] }[B.tail];
  let ty = Y + B.gr * 0.34, tz = zB + 0.02;
  for (let i = 0; i < 2; i++) {
    const len = 0.135 - i * 0.030;
    const ang = tSpec[i];
    const g = new THREE.CylinderGeometry(0.024 - i * 0.008, 0.032 - i * 0.007, len, 5, 1, false, Math.PI / 5);
    g.rotateX(ang - Math.PI / 2);
    g.translate(0, ty + Math.sin(ang) * len * 0.5, tz - Math.cos(ang) * len * 0.5);
    parts.push(shadeGeo(g, 0.88 - i * 0.04));
    ty += Math.sin(ang) * len;
    tz -= Math.cos(ang) * len;
  }
  return ground(BufferGeometryUtils.mergeGeometries(parts, false));
}

/**
 * THE UNIVERSAL HAND-HELD.
 *
 * A unit six-sided prism centred on its own origin, scaled per instance. That
 * one geometry is a phone at (0.075, 0.145, 0.018), a coffee at (0.075, 0.11,
 * 0.075), a camera body, a 2.4 m boom pole, a reflector panel and a bucket
 * drum — so every object the crowd is carrying shares a single draw call
 * instead of costing one pool per prop. Six sides rather than four because a
 * chamfered corner catches the key light and a cube does not.
 */
function itemGeo() {
  const g = new THREE.CylinderGeometry(0.5, 0.5, 1, 6, 1, false, Math.PI / 6);
  return shadeGeo(g, 1.0);
}

/**
 * Ring light. A torus rather than a flat annulus: a zero-thickness ring is
 * exactly the razor-edge geometry the art bible bans, and the tube gives the
 * bloom something with a highlight roll-off to sit on.
 *
 * Authored in the XY plane, so it faces the instance's local +z — the same
 * "forward" every body part uses.
 */
function ringGeo() {
  return shadeGeo(new THREE.TorusGeometry(0.86, 0.14, 5, 14), 1.0);
}

/**
 * The tripod shared by camera rigs and light stands: three splayed legs, a
 * riser, and a head that differs per variant.
 *
 * Built pivot-at-the-ground because these are registered consumables — the
 * lowest fifth of this mesh is the splayed feet, which is exactly the contact
 * patch worldBuild measures for the support physics.
 */
const TRI_ALU = 0x9aa2a8;      // anodised leg tube
const TRI_BLACK = 0x2b2e32;    // head, clamps, camera body
const TRI_RUBBER = 0x1e2023;   // foot
function tripodGeo(head) {
  const parts = [];
  const LEG_LEN = 1.30;
  const SPLAY = 0.30;                       // radians off vertical
  const cs = Math.cos(SPLAY), sn = Math.sin(SPLAY);
  const apex = LEG_LEN * cs;

  /**
   * A section of one leg, measured as a distance range DOWN the leg from the
   * apex. Legs used to be constant-diameter four-sided rods with no clamps and
   * no feet, which is what made them read as square sticks; two telescoping
   * sections with a clamp collar at the joint and a rubber foot is the whole
   * difference between a stick and a tripod.
   */
  const seg = (ang, t0, t1, r0, r1, hex, sides = 6) => {
    const L = t1 - t0, tc = (t0 + t1) / 2;
    const g = new THREE.CylinderGeometry(r0, r1, L, sides, 1, false, Math.PI / sides);
    g.rotateX(SPLAY);
    g.translate(0, apex - tc * cs, -tc * sn);
    g.rotateY(ang);
    return hue(shadeGeo(g, 1.0), hex);
  };

  const angs = [];
  for (let k = 0; k < 3; k++) angs.push((k / 3) * Math.PI * 2 + Math.PI / 6);
  for (const ang of angs) {
    parts.push(seg(ang, 0.02, 0.74, 0.030, 0.032, TRI_ALU));       // upper section
    parts.push(seg(ang, 0.70, 0.775, 0.048, 0.044, TRI_BLACK, 8)); // clamp collar
    parts.push(seg(ang, 0.775, 1.245, 0.021, 0.022, TRI_ALU));     // lower section
    parts.push(seg(ang, 1.245, 1.30, 0.030, 0.034, TRI_RUBBER, 6));// rubber foot
    // The clamp lever sticking out of the collar.
    const lev = bevBox(0.052, 0.014, 0.020, 0, 0, 0, 1.0, 0.004);
    lev.rotateZ(0.5);
    lev.translate(0.062, apex - 0.735 * cs, -0.735 * sn);
    lev.rotateY(ang);
    parts.push(hue(lev, TRI_BLACK, 1.4));
  }
  // Mid-level spreader: the triangle that stops a tripod walking. Each bar runs
  // perpendicular to the radius through the midpoint of the leg pair.
  const R = 0.80 * sn, SY = apex - 0.80 * cs;
  for (let k = 0; k < 3; k++) {
    const phi = angs[k] + Math.PI / 3;
    const b = bevBox(R * Math.sqrt(3), 0.017, 0.017, 0, 0, 0, 1.0, 0.004);
    b.rotateY(phi);
    b.translate(-R * 0.5 * Math.sin(phi), SY, -R * 0.5 * Math.cos(phi));
    parts.push(hue(b, TRI_ALU, 0.86));
  }

  const collar = new THREE.CylinderGeometry(0.058, 0.066, 0.075, 8, 1, false, Math.PI / 8);
  collar.translate(0, apex - 0.022, 0);
  parts.push(hue(shadeGeo(collar, 1.0), TRI_BLACK));
  const riser = new THREE.CylinderGeometry(0.026, 0.034, 0.30, 6, 1, false, Math.PI / 6);
  riser.translate(0, apex + 0.14, 0);
  parts.push(hue(shadeGeo(riser, 1.0), TRI_ALU, 1.05));

  /* --- fluid head: a ball-and-plate block with a pan handle ---------------
   * `y` is pinned so the camera body still lands at 1.62 m: the operator's arm
   * angles downstream are SOLVED against that height, and moving the rig
   * without moving them puts two straight arms into thin air. */
  const y = apex + 0.227;
  const ball = new THREE.SphereGeometry(0.054, 6, 4);
  ball.scale(1, 0.86, 1);
  ball.translate(0, y, 0);
  parts.push(hue(shadeGeo(ball, 1.0), TRI_BLACK));
  parts.push(hue(bevBox(0.132, 0.034, 0.168, 0, y + 0.056, 0.004, 1.0, 0.008), TRI_BLACK, 1.25));
  const pan = bevBox(0.020, 0.020, 0.34, 0, 0, 0, 1.0, 0.005);
  pan.rotateX(0.436);                       // raking back 25 degrees
  pan.translate(0.062, y + 0.020 - 0.072, 0.150);
  parts.push(hue(pan, TRI_BLACK, 0.9));
  parts.push(hue(bevBox(0.026, 0.026, 0.090, 0.062, y - 0.115, 0.300, 1.0, 0.006),
    TRI_RUBBER));                           // the grip on the end of it

  const hy = y + 0.073;
  if (head === 'camera') {
    // Cine language: a boxy body, a matte box on the lens, a top handle, a rear
    // battery block and a tally light. It points -z, so a rig placed facing its
    // subject has the lens on the subject.
    parts.push(hue(bevBox(0.165, 0.150, 0.285, 0, hy + 0.078, 0.010, 1.0, 0.010), TRI_BLACK, 1.3));
    parts.push(hue(bevBox(0.150, 0.030, 0.240, 0, hy + 0.156, 0.010, 1.0, 0.008), TRI_BLACK, 0.8));
    const lens = new THREE.CylinderGeometry(0.050, 0.058, 0.150, 8, 1, false, Math.PI / 8);
    lens.rotateX(Math.PI / 2);
    lens.translate(0, hy + 0.078, -0.195);
    parts.push(hue(shadeGeo(lens, 1.0), TRI_BLACK, 0.65));
    const ring = new THREE.CylinderGeometry(0.062, 0.062, 0.022, 8, 1, false, Math.PI / 8);
    ring.rotateX(Math.PI / 2);
    ring.translate(0, hy + 0.078, -0.150);
    parts.push(hue(shadeGeo(ring, 1.0), TRI_ALU, 0.9));            // focus ring
    // Matte box: a square hood on the front of the lens with a top flag.
    parts.push(hue(bevBox(0.150, 0.145, 0.075, 0, hy + 0.078, -0.290, 1.0, 0.008), TRI_BLACK, 0.9));
    const flag = bevBox(0.170, 0.010, 0.105, 0, 0, 0, 1.0, 0.004);
    flag.rotateX(-0.42);
    flag.translate(0, hy + 0.166, -0.316);
    parts.push(hue(flag, TRI_BLACK, 1.5));
    // Top handle on two risers.
    for (const sz of [-1, 1]) {
      parts.push(hue(bevBox(0.026, 0.058, 0.026, 0, hy + 0.196, 0.010 + sz * 0.085, 1.0, 0.006),
        TRI_BLACK, 1.1));
    }
    parts.push(hue(bevBox(0.032, 0.026, 0.250, 0, hy + 0.232, 0.010, 1.0, 0.007), TRI_BLACK, 1.5));
    // Rear battery block and the monitor flipped out to the side.
    parts.push(hue(bevBox(0.130, 0.110, 0.070, 0, hy + 0.072, 0.180, 1.0, 0.008), TRI_BLACK, 0.75));
    const mon = bevBox(0.135, 0.098, 0.014, 0, 0, 0, 1.0, 0.004);
    mon.rotateY(0.55);
    mon.translate(0.145, hy + 0.126, 0.030);
    parts.push(hue(mon, PALETTE.STUCCO_SKY, 1.15));
    parts.push(hue(bevBox(0.145, 0.108, 0.010, 0.152, hy + 0.126, 0.041, 1.0, 0.004),
      TRI_BLACK, 1.1));
    // Tally light. Small, and the only warm thing on a grey rig.
    parts.push(hue(box(0.020, 0.014, 0.010, 0.052, hy + 0.140, -0.132, 1.0),
      PALETTE.CAR_RED, 2.4));
  } else {
    // Light stand: a yoke and a boss. The glowing ring itself is a separate
    // instance in the emissive pool, so it can be dimmed with the daylight and
    // pulled the instant the stand is taken.
    // The arms straddle 1.61-1.81 m, because the ring is posed at 1.78 m by
    // buildRigs and has to sit between them.
    for (const s of [-1, 1]) {
      parts.push(hue(bevBox(0.028, 0.210, 0.028, s * 0.118, hy + 0.168, 0, 1.0, 0.006),
        TRI_BLACK, 1.2));
      const knob = new THREE.CylinderGeometry(0.026, 0.026, 0.020, 6, 1, false, Math.PI / 6);
      knob.rotateZ(Math.PI / 2);
      knob.translate(s * 0.136, hy + 0.266, 0);
      parts.push(hue(shadeGeo(knob, 1.0), TRI_ALU));
    }
    parts.push(hue(bevBox(0.264, 0.030, 0.030, 0, hy + 0.072, 0, 1.0, 0.007), TRI_BLACK, 1.2));
  }
  return ground(BufferGeometryUtils.mergeGeometries(parts, false));
}

/**
 * THE SHADOW PROXY — docs/PERF_FINDINGS.md, win 3.
 *
 * The crowd used to cast from three separate part pools: shins (3,126 x 22),
 * torso (1,563 x 24) and thighs (3,126 x 10). That is 137 k triangles and three
 * shadow-pass draw calls a frame to produce something that lands on the
 * pavement as a person-shaped smudge a few pixels across — and it was already
 * inconsistent, because the head and the arms did not cast at all, so every
 * pedestrian in Miami was throwing a headless shadow.
 *
 * One coarse body volume per person instead: 18 triangles, one draw call,
 * WITH a head. 28 k triangles against 137 k.
 *
 * WHY IT IS STILL DRAWN IN THE BEAUTY PASS. three's shadow map skips anything
 * the main camera would skip — `object.visible`, `material.visible` and the
 * camera's own layer mask are all consulted in the shadow traversal — so there
 * is no such thing as a shadow-only object. `colorWrite: false` with
 * `depthWrite: false` is the next best thing: the proxy rasterises and writes
 * absolutely nothing, on a MeshBasicMaterial whose fragment shader is a single
 * constant. It costs one draw call and no pixels.
 *
 * The profile is deliberately a little narrower than the body it stands in
 * for. A shadow that is slightly too small reads as a shadow; one that is too
 * big reads as a stain.
 */
function shadowProxyGeo() {
  // Profile in a 0..1 unit body: ankles, hips, shoulders, crown.
  const pts = [
    new THREE.Vector2(0.105, 0.00),
    new THREE.Vector2(0.140, 0.52),
    new THREE.Vector2(0.150, 0.84),
    new THREE.Vector2(0.070, 1.00),
  ];
  const g = new THREE.LatheGeometry(pts, 4, Math.PI / 4);
  return shadeGeo(g, 1.0);
}

/** Standing height of the unit proxy — everything else is scaled from it. */
const PROXY_H = BODY_H;

/**
 * Hip height for the ground-sitting sprawl, SOLVED so the heel lands on the
 * paving at every body scale. Derived from the leg lengths rather than typed,
 * because the last time this was a literal it silently stopped being true.
 *   sole = hip - THIGH_L*cos(-1.45) - SOLE_L*cos(-1.02)
 */
const SPRAWL_HIP = +(THIGH_L * Math.cos(1.45) + SOLE_L * Math.cos(1.02) - 0.005).toFixed(4);
/** Hip height that puts both soles on a skateboard deck at 0.11 m. */
const BOARD_HIP = +(0.11 + (THIGH_L + SOLE_L) * Math.cos(0.30)).toFixed(4);

/* ------------------------------------------------ street-life fittings --- */

/**
 * The kit the long tail of the city carries with it — see docs/STREET_LIFE.md.
 *
 * These are BUILDINGS' worth of nothing individually and a whole layer of the
 * city collectively: a blanket of sunglasses on the pavement, a folding table
 * of phone cases, a bedroll and two bundled bags in a doorway, a shopping
 * trolley, a soapbox, a cooler of cold drinks. Each is one merged geometry in
 * one instanced pool and a real consumable with a measured footprint, exactly
 * like a bin or a bench, because a player has to be able to eat them.
 *
 * They are modelled to the same standard as everything else in the city. A
 * person's belongings are not a joke prop.
 */
/**
 * The blanket and what is laid out on it.
 *
 * THE BUG THIS REPLACES: the blanket took the same per-instance hex as the
 * wares and was 4.5 cm thick, so on warm brick paving the whole prop rendered
 * as nine identical flat rectangles floating with no mat under them. The mat
 * now carries its OWN baked colour — a dark striped bazaar blanket with a
 * lighter border and a fringe — and only the soft goods take the pitch tint, so
 * there is always a dark ground under bright stock whatever the tint is.
 */
const MAT_DARK = 0x454b7c;      // indigo ground — light enough to read as CLOTH
const MAT_STRIPE = 0x9d84ba;    // the woven stripe
const MAT_EDGE = 0xcbb99c;      // bleached border band
function vendorMatGeo() {
  const parts = [];
  const W = 1.66, D = 1.16, T = 0.026;
  // Ground cloth. Bevelled, because a 2.6 cm slab with square edges is a decal
  // with a shadow and nothing else.
  parts.push(hue(bevBox(W, T, D, 0, T / 2, 0, 1.0, 0.010), MAT_DARK));
  // Woven stripes, standing 3 mm proud so nothing is coplanar with anything.
  for (let i = -1; i <= 1; i++) {
    parts.push(hue(box(W - 0.14, 0.005, 0.130, 0, T + 0.002, i * 0.30, 1.0),
      i === 0 ? MAT_EDGE : MAT_STRIPE));
  }
  // Border band on all four sides.
  for (const s of [-1, 1]) {
    parts.push(hue(box(W, 0.006, 0.075, 0, T + 0.001, s * (D / 2 - 0.045), 1.0), MAT_EDGE));
    parts.push(hue(box(0.075, 0.006, D - 0.15, s * (W / 2 - 0.045), T + 0.001, 0, 1.0), MAT_EDGE));
  }
  // Fringe: eight short tabs on the two long edges. This is the single detail
  // that says "cloth lying on the ground" rather than "painted rectangle".
  for (let i = 0; i < 4; i++) {
    const x = -W / 2 + 0.26 + i * (W - 0.52) / 3;
    for (const s of [-1, 1]) {
      parts.push(hue(box(0.055, 0.010, 0.075, x, 0.006, s * (D / 2 + 0.030), 1.0), MAT_EDGE, 0.88));
    }
  }
  // A fold-over lip at one corner, so the cloth has a thickness you can see.
  const lip = bevBox(0.34, 0.022, 0.26, 0, 0, 0, 1.0, 0.008);
  lip.rotateY(0.42);
  lip.rotateX(-0.30);
  lip.translate(W / 2 - 0.20, T + 0.028, D / 2 - 0.17);
  parts.push(hue(lip, MAT_STRIPE));

  /* --- four kinds of stock, not nine copies of one cuboid ----------------- */
  // A row of stacked sunglasses cases: baked near-black, so they read against
  // whatever the pitch colour is.
  for (let i = 0; i < 5; i++) {
    parts.push(hue(bevBox(0.115, 0.048, 0.075, -0.56 + i * 0.135, T + 0.026, 0.36, 1.0, 0.008),
      PALETTE.SIGN_DARK));
    if (i % 2 === 0) {
      parts.push(hue(bevBox(0.105, 0.040, 0.068, -0.56 + i * 0.135, T + 0.070, 0.36, 1.0, 0.008),
        PALETTE.CAR_GRAPHITE));
    }
  }
  // Two low piles of folded fabric. THESE take the pitch tint — they are the
  // goods whose colour is supposed to vary from blanket to blanket.
  for (let p = 0; p < 2; p++) {
    const px = -0.36 + p * 0.46;
    for (let i = 0; i < 3; i++) {
      parts.push(bevBox(0.30 - i * 0.02, 0.038, 0.22 - i * 0.015,
        px + (i % 2) * 0.015, T + 0.020 + i * 0.038, -0.06, 1.0 - i * 0.07, 0.008));
    }
  }
  // A fanned row of phone cases on a shallow ramp.
  const ramp = bevBox(0.44, 0.05, 0.22, 0, 0, 0, 1.0, 0.008);
  ramp.rotateX(-0.24);
  ramp.translate(0.44, T + 0.030, -0.30);
  parts.push(hue(ramp, PALETTE.WOOD_DARK));
  for (let i = 0; i < 4; i++) {
    const c = bevBox(0.070, 0.012, 0.132, 0, 0, 0, 1.0, 0.004);
    c.rotateX(-0.24);
    c.rotateY(-0.16 + i * 0.10);
    c.translate(0.30 + i * 0.095, T + 0.068 + i * 0.006, -0.30);
    parts.push(hue(c, i % 2 ? PALETTE.CAR_TRIM : PALETTE.SIGN_DARK));
  }
  // A small pyramid of caps.
  const caps = [[-0.62, 0.40, 0], [-0.50, 0.40, 0], [-0.56, 0.40, 1]];
  for (const [cx, cz, tier] of caps) {
    const dome = new THREE.SphereGeometry(0.058, 5, 3, 0, Math.PI * 2, 0, 1.65);
    dome.scale(1, 0.72, 1);
    dome.translate(cx, T + 0.014 + tier * 0.056, -cz);
    parts.push(shadeGeo(dome, 1.0));
    parts.push(hue(box(0.075, 0.012, 0.052, cx, T + 0.016 + tier * 0.056, -cz + 0.060, 1.0),
      PALETTE.SIGN_DARK, 1.6));
  }
  return ground(BufferGeometryUtils.mergeGeometries(parts, false));
}

/**
 * Trestle table with a cloth and stacked stock.
 *
 * Legs, top, skirt and all five stock blocks used to take the SAME instance
 * hex, so the whole prop rendered as one solid lime-green toy with nothing
 * separating the table from what was on it. Everything except the cloth is
 * baked now — dark steel trestles, four contrasting lines of stock, a kraft box
 * on the under-shelf — and the instance tint drives only the cloth, which is
 * the one part of a market table that genuinely varies from pitch to pitch.
 */
const STEEL_LEG = 0x4a5157;
function foldTableGeo() {
  const parts = [];
  const TOP_Y = 0.735;
  /* --- trestle frame ----------------------------------------------------- */
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(hue(bar(0.046, TOP_Y - 0.02, 0.046, sx * 0.615, (TOP_Y - 0.02) / 2,
        sz * 0.275, 1.0, 6), STEEL_LEG));
      parts.push(hue(bevBox(0.062, 0.016, 0.062, sx * 0.615, 0.008, sz * 0.275, 1.0, 0.005),
        STEEL_LEG, 0.7));                                   // foot pad
    }
    // Cross-brace: an X between each pair of legs. Without it a trestle reads
    // as four sticks that happen to be under a plank.
    for (const d of [-1, 1]) {
      const b = bevBox(0.028, 0.86, 0.024, 0, 0, 0, 1.0, 0.006);
      b.rotateX(d * 0.655);
      b.translate(sx * 0.615, 0.358, 0);
      parts.push(hue(b, STEEL_LEG, 0.86));
    }
  }
  // Rails along the long sides and the under-shelf they carry.
  for (const sz of [-1, 1]) {
    parts.push(hue(bevBox(1.28, 0.030, 0.030, 0, 0.26, sz * 0.275, 1.0, 0.007), STEEL_LEG, 0.9));
  }
  parts.push(hue(bevBox(1.20, 0.020, 0.50, 0, 0.275, 0, 1.0, 0.006), PALETTE.WOOD_DARK));
  parts.push(hue(bevBox(0.42, 0.26, 0.34, -0.34, 0.415, 0.02, 1.0, 0.010), PALETTE.WOOD_DECK));
  parts.push(hue(box(0.42, 0.012, 0.10, -0.34, 0.548, 0.02, 1.0), PALETTE.WOOD_DARK, 0.8));

  /* --- table top and cloth. ONLY the cloth takes the instance tint. ------- */
  parts.push(hue(bevBox(1.42, 0.036, 0.66, 0, TOP_Y - 0.020, 0, 1.0, 0.008), PALETTE.WOOD_DARK));
  parts.push(bevBox(1.46, 0.026, 0.70, 0, TOP_Y + 0.012, 0, 1.0, 0.008));       // cloth top
  // Gingham: alternate squares knocked back, so the cloth is a CHECKED cloth
  // rather than a white plank. Nine thin plates, no second draw call.
  for (let cx = 0; cx < 6; cx++) {
    for (let cz = 0; cz < 3; cz++) {
      if ((cx + cz) % 2) continue;
      parts.push(box(0.225, 0.004, 0.215, -0.60 + cx * 0.24, TOP_Y + 0.026,
        -0.22 + cz * 0.22, 0.74));
    }
  }
  for (const sz of [-1, 1]) {
    parts.push(bevBox(1.46, 0.30, 0.026, 0, TOP_Y - 0.135, sz * 0.350, 0.92, 0.008));
    parts.push(box(1.46, 0.030, 0.032, 0, TOP_Y - 0.278, sz * 0.350, 0.62));    // hem
  }
  for (const sx of [-1, 1]) {
    parts.push(bevBox(0.026, 0.30, 0.70, sx * 0.730, TOP_Y - 0.135, 0, 0.92, 0.008));
    parts.push(box(0.032, 0.030, 0.70, sx * 0.730, TOP_Y - 0.278, 0, 0.62));
  }
  // A fold turned back at one corner, so the cloth is cloth and not a box.
  const fold = bevBox(0.30, 0.020, 0.24, 0, 0, 0, 1.0, 0.008);
  fold.rotateY(0.55);
  fold.rotateZ(0.22);
  fold.translate(0.60, TOP_Y + 0.038, 0.24);
  parts.push(shadeGeo(fold, 0.80));

  /* --- four contrasting lines of stock ------------------------------------ */
  // Black phone-case blocks.
  for (let i = 0; i < 2; i++) {
    parts.push(hue(bevBox(0.24, 0.070, 0.19, -0.50, TOP_Y + 0.060 + i * 0.070, -0.10, 1.0, 0.008),
      i ? PALETTE.CAR_GRAPHITE : PALETTE.SIGN_DARK));
  }
  // A stack of caps.
  for (let i = 0; i < 3; i++) {
    const c = new THREE.CylinderGeometry(0.082, 0.086, 0.036, 8, 1, false, Math.PI / 8);
    c.translate(-0.16, TOP_Y + 0.045 + i * 0.036, 0.13);
    parts.push(hue(shadeGeo(c, 1.0), i === 1 ? PALETTE.CAR_WHITE : PALETTE.CAR_RED));
  }
  parts.push(hue(bevBox(0.14, 0.014, 0.10, -0.16, TOP_Y + 0.045, 0.20, 1.0, 0.005),
    PALETTE.SIGN_DARK));                                    // peak of the bottom cap
  // A pile of folded white shirts.
  for (let i = 0; i < 3; i++) {
    parts.push(hue(bevBox(0.28 - i * 0.018, 0.036, 0.20 - i * 0.012,
      0.16 + (i % 2) * 0.012, TOP_Y + 0.045 + i * 0.036, -0.09, 1.0, 0.006),
    i === 1 ? PALETTE.STUCCO_SKY : PALETTE.CAR_WHITE));
  }
  // A chrome jewellery tray with pieces laid out on it.
  parts.push(hue(bevBox(0.36, 0.022, 0.24, 0.50, TOP_Y + 0.038, 0.08, 1.0, 0.006),
    PALETTE.CAR_TRIM));
  for (let i = 0; i < 4; i++) {
    parts.push(hue(box(0.055, 0.014, 0.040, 0.38 + (i % 2) * 0.115,
      TOP_Y + 0.056, 0.02 + ((i / 2) | 0) * 0.100, 1.0),
    i % 3 ? PALETTE.CAR_YELLOW : PALETTE.NEON_AQUA));
  }
  return ground(BufferGeometryUtils.mergeGeometries(parts, false));
}

/**
 * Cooler on the pavement, lid ajar. Cold drinks, two dollars.
 *
 * It was a plain blue box with a flat slab on top and a nub for a handle: no
 * parting line, no moulded lip, no hinge, no latch, no drain, and the lid the
 * same colour as the body so the two never read as separate parts. Now the lid
 * is a genuinely separate moulding — pale against a tinted body, overhanging on
 * a lip, hinged at the back and standing part open on a stack of ice and
 * bottles, which is the thing that sells it outright.
 */
function coolerGeo() {
  const parts = [];
  const W = 0.60, D = 0.38, BH = 0.31;
  // Body, slightly tapered so it draft-releases like a real moulding, with the
  // scuffs a cooler that lives on a pavement actually has.
  const body = bevBox(W, BH, D, 0, BH / 2 + 0.012, 0, 0.62, 0.016);
  gradY(body, 0.012, 0.10, 0.80, 1.0);
  parts.push(body);
  parts.push(bevBox(W + 0.016, 0.022, D + 0.016, 0, 0.012, 0, 0.46, 0.006));   // base rail
  // Recessed grab channel down each end.
  for (const s of [-1, 1]) {
    parts.push(bevBox(0.024, 0.11, 0.20, s * (W / 2 - 0.004), BH * 0.62, 0, 0.30, 0.006));
  }
  // Moulded lip: overhangs the body, and it is the overhang that reads as
  // "these are two parts" even before the colour does.
  parts.push(bevBox(W + 0.030, 0.030, D + 0.030, 0, BH + 0.028, 0, 1.30, 0.008));
  // Parting line as a RIM, not a slab: a full plate across the opening reads
  // as a dark tray sitting on the ice it is supposed to be beside.
  for (const sz of [-1, 1]) {
    parts.push(box(W + 0.034, 0.009, 0.026, 0, BH + 0.046, sz * (D / 2 + 0.004), 0.16));
  }
  for (const sx of [-1, 1]) {
    parts.push(box(0.026, 0.009, D + 0.034, sx * (W / 2 + 0.004), BH + 0.046, 0, 0.16));
  }

  /* --- what is inside, visible because the lid is up --------------------- */
  // Ice: lumpy and bleached, not a flat slab in shadow.
  for (let i = 0; i < 5; i++) {
    parts.push(hue(bevBox(0.15 + (i % 3) * 0.04, 0.090 + (i % 2) * 0.02, 0.16 + (i % 2) * 0.06,
      -0.20 + i * 0.10, BH + 0.016 + (i % 2) * 0.014, -0.06 + (i % 3) * 0.06, 1.0, 0.012),
    PALETTE.STUCCO_WHITE, 2.1));
  }
  for (let i = 0; i < 4; i++) {
    const b = new THREE.CylinderGeometry(0.030, 0.030, 0.090, 6, 1, false, Math.PI / 6);
    b.rotateZ(0.30 + (i % 2) * 0.2);
    b.translate(-0.18 + i * 0.12, BH + 0.072, -0.05 + (i % 2) * 0.10);
    parts.push(hue(shadeGeo(b, 1.0),
      [PALETTE.CAR_RED, PALETTE.CAR_GREEN, PALETTE.NEON_ORANGE, PALETTE.CAR_BLUE][i]));
  }

  /* --- the lid, hinged at the back and standing part open ---------------- */
  const lid = [];
  lid.push(bevBox(W + 0.030, 0.052, D + 0.030, 0, 0, 0, 1.42, 0.012));
  lid.push(bevBox(W - 0.10, 0.020, D - 0.10, 0, 0.034, 0, 1.20, 0.008));       // top recess
  for (const s of [-1, 1]) {
    lid.push(bevBox(0.10, 0.026, 0.05, s * 0.20, 0.046, 0, 1.05, 0.006));      // moulded ribs
  }
  const lidGeo = BufferGeometryUtils.mergeGeometries(lid, false);
  lidGeo.translate(0, 0.026, D / 2 + 0.015);
  lidGeo.rotateX(-0.42);                                     // hinged open at the back
  lidGeo.translate(0, BH + 0.052, -D / 2 - 0.015);
  parts.push(lidGeo);
  for (const s of [-1, 1]) {
    parts.push(bevBox(0.075, 0.026, 0.030, s * 0.16, BH + 0.058, -D / 2 - 0.012, 0.26, 0.006));
  }
  // Latch on the front face, and the drain plug boss low on one side.
  parts.push(bevBox(0.085, 0.050, 0.020, 0, BH - 0.020, D / 2 + 0.010, 1.25, 0.006));
  parts.push(bevBox(0.045, 0.030, 0.014, 0, BH - 0.055, D / 2 + 0.012, 0.28, 0.005));
  const plug = new THREE.CylinderGeometry(0.032, 0.036, 0.028, 8, 1, false, Math.PI / 8);
  plug.rotateZ(Math.PI / 2);
  plug.translate(-W / 2 - 0.008, 0.070, 0.06);
  parts.push(shadeGeo(plug, 0.34));

  /* --- folding wire handle on each end ----------------------------------- */
  for (const s of [-1, 1]) {
    const x = s * (W / 2 + 0.020);
    parts.push(bevBox(0.020, 0.020, 0.20, x, BH * 0.70, 0, 0.22, 0.005));
    for (const sz of [-1, 1]) {
      parts.push(bevBox(0.018, 0.100, 0.018, x, BH * 0.70 - 0.050, sz * 0.095, 0.22, 0.005));
      // The lug the wire handle actually pivots on, or it hangs in mid-air.
      parts.push(bevBox(0.030, 0.034, 0.032, x - Math.sign(x) * 0.014, BH * 0.70 - 0.100,
        sz * 0.095, 0.40, 0.006));
    }
  }
  return ground(BufferGeometryUtils.mergeGeometries(parts, false));
}

/**
 * A rolled sleeping bag and two bundled bags — someone's belongings, kept
 * together the way anyone keeps their things together.
 */
/**
 * A municipal outreach board — where to go for help, posted where it is needed.
 *
 * Deliberately plain and deliberately official. The scene it stands in is
 * somebody's life, and the point of putting a service board next to it is that
 * help exists, not that the scene is decorated.
 */
function outreachBoardGeo() {
  const parts = [];
  // Two posts and a board. Municipal, square, unremarkable — which is the point.
  for (const sx of [-0.34, 0.34]) {
    const post = new THREE.CylinderGeometry(0.034, 0.038, 1.44, 6);
    post.translate(sx, 0.72, 0);
    parts.push(hue(post, PALETTE.STEEL_DARK, 1.25));
  }
  parts.push(hue(bevBox(0.94, 0.64, 0.045, 0, 1.04, 0, 1.0, 0.012), PALETTE.SIGN_GREEN ?? 0x1f6f5c, 1.0));
  // A heading and three lines of text, as geometry. Legible as "a notice".
  parts.push(hue(bevBox(0.74, 0.055, 0.012, 0, 1.27, 0.028, 1.0, 0), PALETTE.FABRIC_WHITE, 1.0));
  for (let i = 0; i < 3; i++) {
    parts.push(hue(bevBox(0.56, 0.034, 0.012, -0.07, 1.10 - i * 0.12, 0.028, 1.0, 0),
      PALETTE.FABRIC_WHITE, 0.86));
  }
  parts.push(hue(bevBox(0.18, 0.18, 0.012, 0.31, 0.87, 0.028, 1.0, 0), PALETTE.STUCCO_MINT, 1.1));
  return ground(BufferGeometryUtils.mergeGeometries(parts, false));
}

function bedrollGeo() {
  const parts = [];
  // The flattened board underneath. This is the part that actually says
  // "someone sleeps here" rather than "a pipe was left on the pavement", and it
  // is also what grounds the group — without it three objects float side by
  // side with no relationship to each other.
  const mat = bevBox(1.12, 0.026, 0.72, 0.02, 0.013, 0.06, 1.0, 0.008);
  parts.push(hue(mat, PALETTE.WOOD_DECK, 1.55));
  parts.push(hue(bevBox(1.06, 0.008, 0.030, 0.02, 0.028, -0.16, 1.0, 0.003),
    PALETTE.WOOD_DARK, 0.8));                       // the crease it was folded on

  // Rolled sleeping bag. Takes the instance tint, so a street has navy, green
  // and faded-blue rolls rather than nineteen identical navy ones.
  const roll = new THREE.CylinderGeometry(0.155, 0.155, 0.82, 8, 1, false, Math.PI / 8);
  roll.rotateZ(Math.PI / 2);
  roll.translate(0, 0.182, -0.02);
  parts.push(shadeGeo(roll, 1.0));
  // The spiral end, so the roll reads as rolled from the side.
  for (const s of [-1, 1]) {
    const cap = new THREE.CylinderGeometry(0.098, 0.098, 0.020, 8, 1, false, Math.PI / 8);
    cap.rotateZ(Math.PI / 2);
    cap.translate(s * 0.412, 0.182, -0.02);
    parts.push(shadeGeo(cap, 0.66));
  }
  // Two cords tying it. A roll with no strap is a pipe.
  for (const s of [-1, 1]) {
    const cord = new THREE.CylinderGeometry(0.163, 0.163, 0.026, 8, 1, true, Math.PI / 8);
    cord.rotateZ(Math.PI / 2);
    cord.translate(s * 0.21, 0.182, -0.02);
    parts.push(hue(shadeGeo(cord, 1.0), PALETTE.SIGN_DARK));
  }

  // Two bundled bags, in their OWN colours, slumped rather than spherical: one
  // leaning against the roll, one settled beside it.
  const bagA = new THREE.SphereGeometry(0.215, 6, 4);
  bagA.scale(1.02, 0.76, 0.88);
  bagA.scale(1.0, 1.0, 1.0);
  bagA.rotateZ(-0.30);
  bagA.rotateX(0.20);
  // Leaning ON the roll, not parked beside it: the overlap is what makes three
  // objects read as one person's things.
  bagA.translate(0.30, 0.196, 0.176);
  parts.push(hue(shadeGeo(bagA, 1.0), 0x5f7a4a));                       // dark green
  parts.push(hue(bevBox(0.13, 0.030, 0.11, 0.31, 0.322, 0.176, 1.0, 0.008),
    PALETTE.SIGN_DARK, 0.9));                                           // its handle
  const bagB = new THREE.SphereGeometry(0.175, 6, 4);
  bagB.scale(1.14, 0.64, 0.92);
  bagB.rotateZ(0.34);
  bagB.rotateX(-0.16);
  bagB.translate(-0.34, 0.135, 0.30);
  parts.push(hue(shadeGeo(bagB, 1.0), 0x9db8c6));                       // faded tarp blue
  parts.push(hue(bevBox(0.055, 0.036, 0.34, -0.33, 0.180, 0.26, 1.0, 0.008),
    PALETTE.STUCCO_SAND, 0.9));                                         // a webbing strap
  return ground(BufferGeometryUtils.mergeGeometries(parts, false));
}

/**
 * A supermarket trolley.
 *
 * THE NESTING TAPER IS THE WHOLE READ. It used to be a straight-sided charcoal
 * cage on straight legs, everything one value of steel, with grey boxes inside
 * indistinguishable from the frame — nothing about it said supermarket. The
 * basket now narrows to 0.62 of the rear width with the floor raking up toward
 * the front, the bars are bright chrome against a dark frame, the handle is
 * coloured plastic, there is a child-seat flap and a parcel shelf, and the
 * contents are recognisable things rather than boxes.
 */
const CHROME = 0xe4eaee;
const TROLLEY_FRAME = 0x51585e;
function trolleyGeo() {
  const parts = [];
  const RW = 0.56, FW = RW * 0.62, BL = 0.80, BH = 0.36;
  const RY = 0.46, FY = 0.60;          // floor height at the rear / at the front
  const wAt = (t) => RW + (FW - RW) * t;
  const yAt = (t) => RY + (FY - RY) * t;
  const zAt = (t) => -BL / 2 + t * BL;   // -z is the handle end, +z the nose

  /* --- basket: tapering side and end walls, as bright chrome bars --------- */
  for (let i = 0; i <= 5; i++) {
    const t = i / 5, z = zAt(t);
    for (const sx of [-1, 1]) {
      const h = BH + (1 - t) * 0.02;
      parts.push(hue(bar(0.020, h, 0.020, sx * wAt(t) / 2, yAt(t) + h / 2, z, 1.0, 6), CHROME));
    }
  }
  // A longitudinal member has to follow BOTH slopes: the floor rising toward
  // the nose and the wall drawing in toward it. The yaw is negative on the +x
  // side because the front is the narrow end.
  const along = (w, h, x0, y0, k) => {
    // u is where this member sits across the basket, as a fraction of the half
    // width; its x therefore runs from u*RW/2 at the rear to u*FW/2 at the nose.
    const u = x0 / ((RW + FW) / 4);
    const b = bevBox(w, h, BL, 0, 0, 0, 1.0, 0.005);
    b.rotateX(-Math.atan2(FY - RY, BL));
    b.rotateY(Math.atan2(u * (FW - RW) / 2, BL));
    b.translate(x0, (RY + FY) / 2 + y0, 0);
    return hue(b, CHROME, k);
  };
  for (let r = 0; r < 3; r++) {         // horizontal rails down each side
    for (const sx of [-1, 1]) parts.push(along(0.018, 0.018, sx * (RW + FW) / 4, 0.06 + r * 0.13, 0.94));
  }
  for (const [t, sw] of [[0, RW], [1, FW]]) {
    for (let i = 0; i < 4; i++) {
      const x = -sw / 2 + (i / 3) * sw;
      parts.push(hue(bar(0.018, BH, 0.018, x, yAt(t) + BH / 2, zAt(t), 1.0, 6), CHROME));
    }
    parts.push(hue(bevBox(sw + 0.03, 0.020, 0.020, 0, yAt(t) + BH, zAt(t), 1.0, 0.005), CHROME));
  }
  // Floor as five tapering slats rather than one rectangular slab: a slab wide
  // enough for the back sticks 5 cm out through the narrow front wall.
  for (let i = 0; i < 5; i++) {
    const u = (i / 4 - 0.5) * 2 * 0.86;
    parts.push(along(0.030, 0.016, u * (RW + FW) / 4, 0, 0.80));
  }
  for (const sx of [-1, 1]) parts.push(along(0.026, 0.026, sx * (RW + FW) / 4, BH, 1.06));

  /* --- handle end: bright plastic bar and a hinged child seat ------------- */
  for (const sx of [-1, 1]) {
    parts.push(hue(bar(0.024, 0.30, 0.024, sx * RW / 2, RY + BH + 0.15, zAt(0) - 0.02, 1.0, 6),
      TROLLEY_FRAME));
  }
  const grip = new THREE.CylinderGeometry(0.026, 0.026, RW + 0.06, 8, 1, false, Math.PI / 8);
  grip.rotateZ(Math.PI / 2);
  grip.translate(0, RY + BH + 0.29, zAt(0) - 0.02);
  parts.push(hue(shadeGeo(grip, 1.0), PALETTE.CAR_RED));
  const flap = bevBox(RW - 0.06, 0.020, 0.24, 0, 0, 0, 1.0, 0.006);
  flap.rotateX(-1.15);                                   // folded up against the end
  flap.translate(0, RY + BH * 0.66, zAt(0) + 0.10);
  parts.push(hue(flap, PALETTE.CAR_RED, 0.72));
  for (const sx of [-1, 1]) {
    parts.push(hue(bevBox(0.020, 0.020, 0.05, sx * (RW / 2 - 0.06), RY + BH * 0.66,
      zAt(0) + 0.03, 1.0, 0.005), TROLLEY_FRAME));       // hinge knuckles
  }

  /* --- frame, parcel shelf, swivel yokes, castors ------------------------- */
  for (const sx of [-1, 1]) {
    for (const [t, dz] of [[0, 0.05], [1, -0.06]]) {
      parts.push(hue(bar(0.026, yAt(t), 0.026, sx * wAt(t) / 2 * 0.92, yAt(t) / 2,
        zAt(t) + dz, 1.0, 6), TROLLEY_FRAME));
    }
    parts.push(hue(bevBox(0.020, 0.020, BL - 0.10, sx * RW / 2 * 0.88, 0.155, 0.005, 1.0, 0.005),
      TROLLEY_FRAME));
  }
  for (let i = 0; i < 4; i++) {
    parts.push(hue(bevBox(RW * 0.86, 0.014, 0.020, 0, 0.155, -0.28 + i * 0.19, 1.0, 0.004),
      CHROME, 0.7));                                     // lower parcel shelf
  }
  for (const sx of [-1, 1]) {
    for (const [t, dz] of [[0, 0.05], [1, -0.06]]) {
      const x = sx * wAt(t) / 2 * 0.92, z = zAt(t) + dz;
      parts.push(hue(bevBox(0.070, 0.060, 0.036, x, 0.098, z, 1.0, 0.008), TROLLEY_FRAME, 0.8));
      const w = new THREE.CylinderGeometry(0.055, 0.055, 0.028, 8, 1, false, Math.PI / 8);
      w.rotateZ(Math.PI / 2);
      w.translate(x, 0.055, z);
      parts.push(hue(shadeGeo(w, 1.0), PALETTE.SIGN_DARK));
      const hub = new THREE.CylinderGeometry(0.020, 0.020, 0.034, 6, 1, false, Math.PI / 6);
      hub.rotateZ(Math.PI / 2);
      hub.translate(x, 0.055, z);
      parts.push(hue(shadeGeo(hub, 1.0), CHROME));
    }
  }

  /* --- contents you can name ---------------------------------------------- */
  const bagA = new THREE.SphereGeometry(0.19, 6, 4);
  bagA.scale(1.05, 0.90, 0.86);
  bagA.scale(0.92, 0.92, 0.92);
  bagA.translate(0.00, RY + 0.16, -0.16);
  parts.push(hue(shadeGeo(bagA, 1.0), PALETTE.CAR_GRAPHITE));
  const bagB = new THREE.SphereGeometry(0.155, 6, 4);
  bagB.scale(1.0, 0.94, 0.90);
  bagB.scale(0.88, 0.88, 0.88);
  bagB.translate(-0.03, RY + 0.17, 0.12);
  parts.push(hue(shadeGeo(bagB, 1.0), PALETTE.BIN_BLUE));
  const blanket = new THREE.CylinderGeometry(0.068, 0.068, 0.20, 7, 1, false, Math.PI / 7);
  blanket.rotateZ(Math.PI / 2);
  blanket.rotateY(0.30);
  blanket.translate(-0.01, RY + 0.10, 0.20);
  parts.push(hue(shadeGeo(blanket, 1.0), PALETTE.FABRIC_CORAL));
  parts.push(hue(bevBox(0.22, 0.17, 0.17, -0.09, RY + 0.26, -0.04, 1.0, 0.010),
    PALETTE.WOOD_DECK));
  parts.push(hue(box(0.225, 0.012, 0.05, -0.09, RY + 0.346, -0.04, 1.0),
    PALETTE.WOOD_DARK, 0.9));                            // tape down the box seam
  return ground(BufferGeometryUtils.mergeGeometries(parts, false));
}

/**
 * A wooden crate: a soapbox to stand on, a stool to sit on, a stall counter.
 *
 * It was named a crate and rendered as a smooth single-colour box with a lid
 * rim, which reads as a plastic tote. It is built like a crate now: five boards
 * a side with a 1 cm gap between them, corner posts standing proud, rim cleats
 * top and bottom, a hand hole cut through two opposite ends, per-board timber
 * variation and a faded stencil block on one face.
 */
function crateGeo() {
  const parts = [];
  const W = 0.46, D = 0.38, H = 0.40;
  const POST = 0.038, T = 0.016;
  const nB = 5, gap = 0.010;
  const bh = (H - 0.055 - (nB - 1) * gap) / nB;     // board height

  // Corner posts, standing proud of the boards on all four verticals.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(bevBox(POST, H, POST, sx * (W / 2 - POST / 2 + 0.004), H / 2,
        sz * (D / 2 - POST / 2 + 0.004), 0.80, 0.006));
    }
  }
  // Boards. Timber tone wanders per board; the middle board of the two ends is
  // split to leave a hand hole.
  for (let i = 0; i < nB; i++) {
    const y = 0.030 + bh / 2 + i * (bh + gap);
    const k = 0.90 + ((i * 7 + 3) % 5) * 0.055;
    for (const sz of [-1, 1]) {
      parts.push(bevBox(W - POST * 1.6, bh, T, 0, y, sz * (D / 2 - T / 2), k, 0.004));
    }
    for (const sx of [-1, 1]) {
      if (i === 2) {
        for (const s2 of [-1, 1]) {
          parts.push(bevBox(T, bh, (D - POST * 1.6 - 0.14) / 2,
            sx * (W / 2 - T / 2), y,
            s2 * ((D - POST * 1.6) / 4 + 0.035), k * 0.97, 0.004));
        }
      } else {
        parts.push(bevBox(T, bh, D - POST * 1.6, sx * (W / 2 - T / 2), y, 0, k * 0.97, 0.004));
      }
    }
  }
  // Rim cleats top and bottom, which is what stops a stack of boards splaying.
  for (const y of [0.018, H - 0.020]) {
    for (const sz of [-1, 1]) {
      parts.push(box(W + 0.014, 0.036, 0.024, 0, y, sz * (D / 2 - 0.004), 0.68));
    }
    for (const sx of [-1, 1]) {
      parts.push(box(0.024, 0.036, D - 0.03, sx * (W / 2 - 0.004), y, 0, 0.68));
    }
  }
  parts.push(bevBox(W - 0.02, 0.020, D - 0.02, 0, H - 0.006, 0, 0.94, 0.006));   // top slat deck
  // A faded stencil block on one face — deliberately abstract, no lettering.
  // Flush with the boards, not standing off them: a stencil is ink, not a sign.
  // Inside ONE board, and 1.5 mm proud of it. Spanning two boards made it
  // bridge the gap between them and read as a card taped to the crate.
  const sy = 0.030 + bh / 2 + 3 * (bh + gap);
  parts.push(hue(box(0.21, bh * 0.78, 0.004, 0.02, sy, D / 2 + 0.0015, 1.0),
    PALETTE.STUCCO_SAND, 1.15));
  parts.push(hue(box(0.14, bh * 0.20, 0.004, -0.005, sy + bh * 0.16, D / 2 + 0.0035, 1.0),
    PALETTE.SIGN_DARK));
  parts.push(hue(box(0.09, bh * 0.16, 0.004, -0.03, sy - bh * 0.16, D / 2 + 0.0035, 1.0),
    PALETTE.SIGN_DARK, 0.9));
  return ground(BufferGeometryUtils.mergeGeometries(parts, false));
}

/**
 * A hand-lettered cardboard sign, propped against a leg or a bag.
 *
 * It was a perfectly rectangular, perfectly flat plate — nothing about the
 * outline or the thickness said cardboard. It has a torn top edge, two sides
 * that are not parallel, a visible corrugated flute along the cut edge and a
 * soft bend across the middle, so it reads as a piece of box someone tore up.
 */
const CARD_BROWN = 0xb8895c;
function signCardGeo() {
  const parts = [];
  // An irregular outline: one torn edge along the top, sides a few degrees off
  // parallel, and a corner knocked off.
  const pts = [
    [-0.215, 0.000], [0.198, -0.012], [0.226, 0.150], [0.212, 0.286],
    [0.128, 0.302], [0.052, 0.280], [-0.030, 0.310], [-0.118, 0.288],
    [-0.196, 0.306], [-0.228, 0.176],
  ];
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();
  const board = new THREE.ExtrudeGeometry(shape, { depth: 0.016, bevelEnabled: false });
  board.translate(0, 0, -0.008);
  // ExtrudeGeometry is non-indexed and mergeGeometries refuses to mix indexed
  // with non-indexed, so give it a trivial index rather than losing the merge.
  board.setIndex([...Array(board.attributes.position.count).keys()]);
  // A soft bend across the middle: nothing that has been carried under an arm
  // is still flat.
  const bp = board.attributes.position;
  for (let i = 0; i < bp.count; i++) {
    const y = bp.getY(i);
    if (y > 0.14) {
      const t = (y - 0.14);
      bp.setZ(i, bp.getZ(i) - t * t * 1.9);
    }
  }
  board.computeVertexNormals();
  shadeGeo(board, 1.0);
  gradY(board, 0.24, 0.31, 1.0, 1.22);                 // bleached torn edge
  parts.push(hue(board, CARD_BROWN));
  // The corrugated flute, exposed along the cut bottom edge.
  for (let i = 0; i < 7; i++) {
    // 2 cm deep against a 1.6 cm board, so the flute PROTRUDES and is visible
    // instead of being buried inside the card it is meant to be the edge of.
    parts.push(hue(box(0.048, 0.014, 0.021, -0.180 + i * 0.062, 0.006, 0, 1.0),
      CARD_BROWN, i % 2 ? 0.50 : 1.25));
  }
  // Two lines of writing, blocked in. Deliberately abstract: legible text on a
  // sign held by someone in this position would be putting words in a
  // stranger's mouth for entertainment.
  for (let i = 0; i < 3; i++) {
    const ly = 0.232 - i * 0.056;
    const line = new THREE.BoxGeometry(0.27 - i * 0.055, 0.017, 0.003);
    line.rotateZ(0.028 - i * 0.03);
    line.translate(-0.015 + i * 0.018, ly,
      0.0095 - (ly > 0.14 ? Math.pow(ly - 0.14, 2) * 1.9 : 0));
    parts.push(hue(shadeGeo(line, 1.0), PALETTE.SIGN_DARK, 1.2));
  }
  const g = BufferGeometryUtils.mergeGeometries(parts, false);
  // Leaning back, and canted a few degrees, the way a propped sign always is.
  g.rotateX(-0.34);
  g.rotateZ(0.07);
  return ground(g);
}

/**
 * A pigeon. Two poses — head up, and head down pecking — because a flock in
 * which every bird holds the same attitude reads as a decal of a bird repeated.
 *
 * What makes it a bird rather than a pebble, in order of importance: the value
 * break (dark head against a mid body against a pale wing bar), the head lifted
 * clear of the body on a visible neck, and a tail long enough to break the blob
 * silhouette. All three were missing.
 */
function pigeonGeo(pose = 'stand') {
  const peck = pose === 'peck';
  const parts = [];
  const tilt = peck ? 0.26 : 0.05;

  /* --- legs: thin, and the only orange on the bird ------------------------ */
  for (const s of [-1, 1]) {
    parts.push(hue(box(0.011, 0.046, 0.011, s * 0.021, 0.026, 0.006, 1.0), PIGEON_FOOT));
    parts.push(hue(box(0.026, 0.011, 0.042, s * 0.021, 0.006, 0.014, 1.0), PIGEON_FOOT, 0.80));
  }

  /* --- body: deep breast tapering back to the tail ------------------------ */
  const body = new THREE.SphereGeometry(0.070, 6, 3);
  body.scale(0.86, 0.92, 1.30);
  body.rotateX(tilt);
  body.translate(0, 0.098, 0.006);
  hue(shadeGeo(body, 1.0), PIGEON_BODY);
  gradY(body, 0.045, 0.120, 1.26, 0.86);        // pale breast, darker mantle
  parts.push(body);

  /* --- folded wings, swept along the flanks and only 2 cm thick ----------- */
  for (const s of [-1, 1]) {
    const w = box(0.017, 0.044, 0.128, 0, 0, 0, 1.0);
    w.rotateZ(s * 0.06);
    w.rotateX(tilt + 0.08);
    w.translate(s * 0.046, 0.102, -0.014);
    parts.push(hue(w, PIGEON_BODY, 0.78));
    const bandBar = box(0.021, 0.013, 0.068, 0, 0, 0, 1.0);
    bandBar.rotateZ(s * 0.06);
    bandBar.rotateX(tilt + 0.08);
    bandBar.translate(s * 0.049, 0.085, -0.030);
    parts.push(hue(bandBar, PIGEON_BAR, 1.25));
  }

  /* --- neck and head, lifted clear of the shoulders ----------------------- */
  const hy = peck ? 0.102 : 0.178;
  const hz = peck ? 0.112 : 0.058;
  const nAng = Math.atan2(hz - 0.030, hy - 0.115);
  const nLen = Math.hypot(hz - 0.030, hy - 0.115) + 0.028;
  const neck = new THREE.CylinderGeometry(0.024, 0.038, nLen, 5, 1, false, Math.PI / 5);
  neck.rotateX(nAng);
  neck.translate(0, 0.115 + Math.cos(nAng) * nLen * 0.42, 0.030 + Math.sin(nAng) * nLen * 0.42);
  hue(shadeGeo(neck, 1.0), PIGEON_HEAD, 1.06);
  parts.push(neck);

  const head = new THREE.SphereGeometry(0.034, 5, 3);
  head.scale(1, 0.98, 1.10);
  head.translate(0, hy, hz);
  parts.push(hue(shadeGeo(head, 1.0), PIGEON_HEAD));
  const beak = new THREE.ConeGeometry(0.010, 0.026, 4, 1, false, Math.PI / 4);
  beak.rotateX(peck ? Math.PI * 0.88 : Math.PI / 2);
  beak.translate(0, hy - (peck ? 0.024 : 0.002), hz + (peck ? 0.016 : 0.040));
  parts.push(hue(shadeGeo(beak, 1.0), PALETTE.SIGN_DARK));

  /* --- tail: a flat fan that WIDENS to the tip, raked down --------------- */
  // A tapered prism laid flat is a fan for 24 triangles; a box is a plank, and
  // a plank sticking out of a sphere is what made these read as litter.
  // rFront is the end nearest the body, so the SMALL radius goes there and the
  // fan opens toward the tip. The other way round is a spike.
  const tail = barZ(0.028, 0.062, 0.150, 0, 0, 0, 1.0, 6, 1.30, 0.22);
  tail.rotateX(peck ? 0.32 : -0.16);
  tail.translate(0, peck ? 0.116 : 0.078, -0.152);
  parts.push(hue(tail, PIGEON_BODY, 0.88));
  const band = box(0.086, 0.012, 0.026, 0, 0, 0, 1.0);
  band.rotateX(peck ? 0.32 : -0.16);
  band.translate(0, peck ? 0.142 : 0.066, -0.222);
  parts.push(hue(band, PIGEON_BAR, 0.90));
  return ground(BufferGeometryUtils.mergeGeometries(parts, false));
}

/**
 * The merged body used ONLY for the tumble after a swallow: one mesh, arms
 * thrown up, legs kicking. Cartoon panic, no ragdoll.
 */
function fallBodyGeo(skin, hair, top, bottom, withBike, bikeHex) {
  const parts = [];
  const add = (g, hex, ty, tz, rx, sx) => {
    if (rx) g.rotateX(rx);
    if (sx) g.rotateZ(sx);
    g.translate(0, ty, tz || 0);
    parts.push(paintGeo(g, hex));
  };

  add(torsoGeo(), top, HIP_Y, 0, 0.22);
  add(headGeo(), skin, HIP_Y + NECK_Y - 0.02, 0.12, 0.12);
  add(hairGeo(), hair, HIP_Y + NECK_Y - 0.02, 0.12, 0.12);

  // Arms flung up and out.
  for (const s of [-1, 1]) {
    const a = armGeo();
    a.rotateX(-2.35);
    a.rotateZ(s * 0.45);
    a.translate(s * SHOULDER_X, HIP_Y + SHOULDER_Y, 0.06);
    parts.push(paintGeo(a, skin));
  }
  // Legs kicking in opposite directions — one up, one trailing almost straight
  // down. The trailing leg is not a style choice: the merged body's own origin
  // is the standing agent's foot position, so if BOTH legs come up the mesh's
  // lowest point sits 15 cm above its origin and every stationary pedestrian
  // audits as floating. One leg down keeps the contact point honest, and reads
  // as a stumble rather than a swimming pose.
  const kick = [0.85, -0.22];
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? -1 : 1;
    const t = thighGeo();
    t.rotateX(kick[i]);
    t.translate(s * HIP_X, HIP_Y, 0);
    parts.push(paintGeo(t, bottom));
    const sh = shinGeo();
    sh.rotateX(kick[i] + 0.5);
    sh.translate(
      s * HIP_X,
      HIP_Y - THIGH_L * Math.cos(kick[i]),
      -THIGH_L * Math.sin(kick[i])
    );
    parts.push(paintGeo(sh, bottom));
  }
  if (withBike) {
    const b = bikeGeo();
    b.rotateZ(0.5);
    b.translate(0.2, 0.05, 0);
    parts.push(paintGeo(b, bikeHex));
  }
  return BufferGeometryUtils.mergeGeometries(parts, false);
}

/* ========================================================= instance pool === */

const SRGB_TO_LINEAR = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

function makePool(group, geo, mat, count, cast, name) {
  const m = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
  m.name = `ped-${name}`;
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, count) * 3), 3);
  m.instanceColor.setUsage(THREE.StaticDrawUsage);
  m.castShadow = cast;
  m.receiveShadow = true;
  // Instances are scattered over the whole map, so a single bounding sphere is
  // useless — culling has to happen per pool, and there is only one pool.
  m.frustumCulled = false;
  m.instanceMatrix.array.fill(0);   // everything starts collapsed / invisible
  // An empty pool would still cost a draw call for a degenerate instance.
  if (count <= 0) m.visible = false;
  group.add(m);
  return m;
}

function setInstanceColor(mesh, slot, hex) {
  const a = mesh.instanceColor.array;
  a[slot * 3] = SRGB_TO_LINEAR(((hex >> 16) & 255) / 255);
  a[slot * 3 + 1] = SRGB_TO_LINEAR(((hex >> 8) & 255) / 255);
  a[slot * 3 + 2] = SRGB_TO_LINEAR((hex & 255) / 255);
}

/**
 * Compose one instance matrix straight into the buffer.
 *
 * M = T(p) * Ry(yaw) * S(s) * T(l) * Rx(swing) * S(g)
 *
 * Hand-rolled rather than THREE.Matrix4 because this runs ~10x per agent per
 * frame; the object churn of compose() is the whole frame budget at 900 agents.
 */
function poseInto(arr, slot, px, py, pz, yaw, s, lx, ly, lz, swing, gx, gy, gz) {
  const c = Math.cos(yaw), sh = Math.sin(yaw);
  const ca = Math.cos(swing), sa = Math.sin(swing);
  const kx = s * gx, ky = s * gy, kz = s * gz;
  const o = slot << 4;
  arr[o] = kx * c;
  arr[o + 1] = 0;
  arr[o + 2] = -kx * sh;
  arr[o + 3] = 0;
  arr[o + 4] = ky * sh * sa;
  arr[o + 5] = ky * ca;
  arr[o + 6] = ky * c * sa;
  arr[o + 7] = 0;
  arr[o + 8] = kz * sh * ca;
  arr[o + 9] = -kz * sa;
  arr[o + 10] = kz * c * ca;
  arr[o + 11] = 0;
  arr[o + 12] = px + s * (c * lx + sh * lz);
  arr[o + 13] = py + s * ly;
  arr[o + 14] = pz + s * (-sh * lx + c * lz);
  arr[o + 15] = 1;
}

function clearInstance(arr, slot) {
  const o = slot << 4;
  for (let i = 0; i < 16; i++) arr[o + i] = 0;
}

/* ================================================================ build === */

export function buildPedestrians(ctx) {
  const { layout, registry, scene } = ctx;
  const rng = makeRNG((layout.seed ^ 0x9e37ba) >>> 0);
  const Y_WALK = ctx.Y_WALK ?? 0.155;

  // Shared with the traffic system if it got here first; both need identical
  // lane geometry and identical signal phases or cars and people disagree.
  // Duck-typed rather than instanceof, because `ctx.roads` is a name another
  // module could plausibly claim for something else entirely.
  const shared = ctx.roads;
  const usable = shared && shared.sidewalks && shared.crossings && shared.lightFor;
  const net = usable ? shared : new RoadNetwork(layout);
  if (!shared) ctx.roads = net;

  const group = ctx.group('pedestrians');

  /* ---------------------------------------------------- sidewalk graph --- */
  const paths = buildPaths(net);
  linkCrossings(net, paths);
  if (!paths.length) return;

  /* --------------------------------------------------------- materials --- */
  // One material for every body part: same program, so the twelve draws batch
  // as well as WebGL allows. vertexColors carries the baked shoe/tyre shading,
  // instanceColor carries the per-agent skin/hair/shirt tint.
  const matBody = solid({
    color: 0xffffff, vertexColors: true, roughness: 0.80, metalness: 0.0,
    envMapIntensity: 0.45,
  });
  const matGear = solid({
    color: 0xffffff, vertexColors: true, roughness: 0.42, metalness: 0.30,
    envMapIntensity: 0.8,
  });
  // Ring lights are the one thing here that emits. Cloned out of the cache
  // because `emissiveIntensity` is driven per frame off nightFactor and the
  // cache hands the same instance to anyone who asks for the same parameters.
  const matGlow = solid({
    color: 0xfff3df, vertexColors: true, roughness: 0.55, metalness: 0.0,
    emissive: 0xffe9c4, emissiveIntensity: 0.25, envMapIntensity: 0.4,
  }).clone();
  // Writes neither colour nor depth: it exists only to be seen by the sun.
  // MeshBasic, not MeshStandard, so the pixels it does rasterise are free.
  const matShadow = new THREE.MeshBasicMaterial({
    colorWrite: false, depthWrite: false,
    // The proxy is an open lathe, so the default FrontSide -> BackSide shadow
    // flip would depend on the surface being closed. Rendering both faces into
    // the depth map costs nothing at 24 triangles and cannot be wrong.
    shadowSide: THREE.DoubleSide,
  });

  /* ------------------------------------------------------------ agents --- */
  // The whole city has ~27 km of pavement. Even at the top of the budget that
  // is one person every 23 m if you spread them evenly, which reads as a ghost
  // town everywhere. So: hard concentration onto the spines and the gathering
  // spots, and genuinely empty back lots.
  //
  // ORDER MATTERS. The placers that need a SPECIFIC piece of ground — a chair
  // that exists, a venue door, 3 m of clear pavement for a tripod — run first
  // and take what they need. Free-roaming walkers get whatever is left, and
  // they can go anywhere, so they are the ones that should absorb the rounding.
  const TOTAL = 1450;
  /**
   * The pavement has to keep MOVING. Walkers used to take whatever the other
   * placers left, and when the street-life layer arrived it ate two thirds of
   * them: the census went from 685 people walking to 219, which reads as a city
   * full of statues however good the statues are. Walkers now have a floor.
   */
  const WALK_FLOOR = 560;
  const agents = [];
  const furniture = collectFurniture(ctx);
  const venues = findVenues(ctx, rng, paths);
  const shoots = [];

  // Everything already standing on the pavement, with its MEASURED footprint.
  // Built before the placers so they can ask "is this spot actually empty"
  // instead of asking the 9 m occupancy grid.
  let obstacles = buildObstacleField(ctx);

  // FIRST: the long tail needs the specific ground — a park table nobody is
  // using, a quiet stretch of frontage, room for a blanket. Run it after the
  // walkers and there is nothing left but the middle of the pavement.
  const streetProps = [];
  const nStreet = placeStreetLife(
    ctx, rng, paths, furniture, obstacles, agents, Y_WALK, streetProps, 235);
  // Their kit is registered NOW, not with the rest of the module, so that the
  // walking corridor below is carved around the blankets and folding tables
  // too. A stream of commuters walking through a vendor's stock is the same
  // defect as a stream walking through a bench.
  const nStreetProps = buildStreetProps(ctx, streetProps);
  obstacles = buildObstacleField(ctx);
  const corridor = buildClearance(paths, obstacles);

  placeSeated(ctx, rng, furniture, agents, 250);
  placeTerraceLife(ctx, rng, furniture, agents, 120);
  placeVenueLife(ctx, rng, venues, agents, Y_WALK, 210);
  placeCreators(ctx, rng, paths, venues, agents, Y_WALK, shoots, 150);
  placeBuskers(ctx, rng, paths, agents, Y_WALK, 60);
  placeGatherings(ctx, rng, paths, agents, Y_WALK, agents.length + 250);
  placeCyclists(ctx, rng, net, agents);
  placeCrossingQueues(ctx, rng, net, agents, Y_WALK, 180);
  placeWalkers(ctx, rng, paths, agents, Y_WALK,
    Math.max(WALK_FLOOR, TOTAL - agents.length));
  placeCourtLife(ctx, rng, agents, Y_WALK, 140);
  placeChildren(ctx, rng, agents, 110);

  const N = agents.length;
  if (!N) return;

  /* -------------------------------------------- nobody stands in a bench --- */
  const cleared = clearCrowd(agents, obstacles);

  // WHERE EACH PERSON BELONGS. A pedestrian that has been swallowed comes back
  // 30 s later like every other prop, and "comes back" has to mean back to
  // their chair, their queue, their pitch — not standing in the road in a
  // generic idle. Captured once, after every placer has had its say.
  for (const a of agents) {
    a.homeMode = a.mode;
    a.homeX = a.x; a.homeY = a.y; a.homeZ = a.z; a.homeYaw = a.yaw;
    if (!a.homePath) { a.homePath = a.path; a.homeS = a.s; }
  }

  let nHat = 0, nBag = 0, nOverlay = 0, nBike = 0, nBoard = 0;
  let nItem = 0;
  // Dogs are pooled BY BREED. Three silhouettes cost two extra draw calls out
  // of a 450-call budget, and a city where every dog is the same animal is the
  // thing a reviewer notices from the pavement.
  const nDogB = [0, 0, 0];
  for (const a of agents) {
    if (a.hat) a.hatSlot = nHat++;
    if (a.bag) a.bagSlot = nBag++;
    if (a.overlay) a.overlaySlot = nOverlay++;
    if (a.bike) a.bikeSlot = nBike++;
    if (a.board) a.boardSlot = nBoard++;
    if (a.dog) a.dogSlot = nDogB[a.dogBreed]++;
    if (a.items) for (const it of a.items) it.slot = nItem++;
  }
  const nDog = nDogB[0] + nDogB[1] + nDogB[2];
  const nGlow = shoots.reduce((n, s) => n + (s.ring ? 1 : 0), 0);

  /* ------------------------------------------------------------- pools --- */
  const P = {
    // Only the trunk and legs cast. Every extra caster is both another
    // shadow-pass draw call AND another N x geometry of shadow triangles, and
    // a head or an arm hides inside the torso's own shadow at any sun angle
    // this rig uses.
    head: makePool(group, headGeo(), matBody, N, false, 'head'),
    hair: makePool(group, hairGeo(), matBody, N, false, 'hair'),
    torso: makePool(group, torsoGeo(), matBody, N, false, 'torso'),
    arms: makePool(group, armGeo(), matBody, N * 2, false, 'arms'),
    thighs: makePool(group, thighGeo(), matBody, N * 2, false, 'thighs'),
    shins: makePool(group, shinGeo(), matBody, N * 2, false, 'shins'),
    // The ONLY caster in the crowd. See shadowProxyGeo.
    shadow: makePool(group, shadowProxyGeo(), matShadow, N, true, 'shadow'),
    hat: makePool(group, hatGeo(), matBody, nHat, false, 'hat'),
    bag: makePool(group, bagGeo(), matBody, nBag, false, 'bag'),
    overlay: makePool(group, overlayGeo(), matBody, nOverlay, false, 'vest'),
    bike: makePool(group, bikeGeo(), matGear, nBike, true, 'bike'),
    board: makePool(group, boardGeo(), matGear, nBoard, false, 'board'),
    dog0: makePool(group, dogGeo(DOG_BREEDS[0]), matBody, nDogB[0], false, 'dog-short'),
    dog1: makePool(group, dogGeo(DOG_BREEDS[1]), matBody, nDogB[1], false, 'dog-lean'),
    dog2: makePool(group, dogGeo(DOG_BREEDS[2]), matBody, nDogB[2], false, 'dog-fluffy'),
    // Every phone, coffee, camera, boom, reflector and drum in Miami, in one
    // pool. See itemGeo() for why that is possible at all.
    item: makePool(group, itemGeo(), matGear, nItem, false, 'item'),
    glow: makePool(group, ringGeo(), matGlow, nGlow, false, 'ringlight'),
  };

  for (let i = 0; i < N; i++) {
    const a = agents[i];
    setInstanceColor(P.head, i, a.skin);
    setInstanceColor(P.hair, i, a.hair);
    setInstanceColor(P.torso, i, a.top);
    setInstanceColor(P.arms, i * 2, a.armHex);
    setInstanceColor(P.arms, i * 2 + 1, a.armHex);
    setInstanceColor(P.thighs, i * 2, a.bottom);
    setInstanceColor(P.thighs, i * 2 + 1, a.bottom);
    setInstanceColor(P.shins, i * 2, a.legHex);
    setInstanceColor(P.shins, i * 2 + 1, a.legHex);
    if (a.hat) setInstanceColor(P.hat, a.hatSlot, a.hatHex);
    if (a.bag) setInstanceColor(P.bag, a.bagSlot, a.bagHex);
    if (a.overlay) setInstanceColor(P.overlay, a.overlaySlot, a.overlayHex);
    if (a.bike) setInstanceColor(P.bike, a.bikeSlot, a.bikeHex);
    if (a.board) setInstanceColor(P.board, a.boardSlot, a.boardHex);
    if (a.dog) setInstanceColor(P[`dog${a.dogBreed}`], a.dogSlot, a.dogHex);
    if (a.items) for (const it of a.items) setInstanceColor(P.item, it.slot, it.hex);
  }
  for (const k in P) P[k].instanceColor.needsUpdate = true;

  /* -------------------------------------------------------- consumables --- */
  const fallPools = registerConsumables(ctx, agents, rng);
  // The tripods and light stands stand on the pavement under their own weight,
  // so they are real consumables with measured footprints — not scenery. The
  // glowing ring is the exception: it is bolted to a stand that can be eaten,
  // so it lives in this module's pool and is pulled when its stand goes.
  buildRigs(ctx, shoots, P.glow);

  /* ------------------------------------------------------------ runtime --- */
  const state = {
    net, agents, paths, P,
    // Runtime decisions (who crosses, which way they turn) run off their own
    // seeded stream so a screenshot taken after N fixed frames is repeatable.
    rng: makeRNG((layout.seed ^ 0x2b71cd) >>> 0),
    time: 0,
    focus: new THREE.Vector3(0, 0, 0),
    focusSrc: null,
    holes: [],
    holeT: 99,
    Y_WALK,
    layout,
    registry,
    scene,
    fallPools,
    matGlow,
    shoots,
    venues,
    obstacles,
    // Anything that only has to be right a few times a second: the day/night
    // response, the venue migration, and pulling a ring light whose stand has
    // just been eaten. Running these per frame for 1,450 agents buys nothing.
    slowT: 0,
    night: 0,
    glowDirty: true,
  };

  scene.userData.pedestrianUpdate = (dt) => updateCrowd(state, dt);
  // Deliberately NOT publishing the agent array: agents point at their sidewalk
  // path and the path points back, and the screenshot harness serialises
  // whatever DEV can reach. A cyclic 900-element graph breaks page.evaluate.
  scene.userData.pedestrianCount = N;
  // A FLAT census instead. Reviewers need to check that the crowd is a mix and
  // that the mix moves with the clock, and the only alternative to this is
  // reaching into the agent graph — which is exactly what breaks the harness.
  scene.userData.pedestrianStats = () => census(state);

  const count = (fn) => agents.filter(fn).length;
  const walkers = count((a) => a.mode <= MODE.CROSS);
  const sitting = count((a) => a.mode === MODE.SIT);
  const standing = count((a) => a.mode === MODE.IDLE || a.mode === MODE.QUEUE);
  const filming = count((a) => a.mode === MODE.FILM);
  console.info(
    `[pedestrians] ${N} agents — ${walkers} walking, ${standing} standing/queueing, ` +
    `${sitting} seated, ${filming} on ${shoots.length} shoots, ${nBike} cycling, ` +
    `${count((a) => a.mode === MODE.SERVE)} serving, ${count((a) => a.mode === MODE.ESCORT)} children, ` +
    `${nDog} dogs | ${Object.keys(P).length} crowd draw calls + ${state.fallPools.size} fall pools ` +
    `(hidden until someone is swallowed) | ${nItem} held items, ${nGlow} ring lights | ` +
    `${venues.length} venues, ${paths.length} sidewalk loops, ${net.crossings.length} crossings`
  );
  console.info(
    `[pedestrians] clearance: ${obstacles.n} measured obstacles | ` +
    `${corridor.samples} corridor samples (${corridor.blocked} fully blocked) | ` +
    `${cleared.fixed} people moved out of furniture, ${cleared.stuck} left tight`
  );
  // What is closing the footway, for whoever owns the planting: a hedge or a
  // shrub bed sitting ON the pavement centreline is the one case this pass
  // cannot steer around, and it is the top of this list by a factor of three.
  console.info('[pedestrians] corridor closed by:', Object.entries(corridor.why)
    .sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} ${n}`).join(', '));
  console.info(
    `[pedestrians] street life: ${nStreet} characters, ${nStreetProps} pieces of kit`);
}

/** Plain numbers only — see why at the publish site. */
const MODE_NAME = Object.keys(MODE);
function census(st) {
  const modes = {};
  const roles = {};
  let held = 0, dogs = 0;
  /**
   * LIVE regression counter for "people standing inside the furniture".
   *
   * A build-time audit only ever sees frame zero, and the defect it is looking
   * for is mostly produced by MOVEMENT — a walker drifting into a planter three
   * minutes into the match. Counting it here, against the same measured
   * footprints the corridor was carved from, is the only way a reviewer can
   * check it at the moment they are looking at the frame. Sitters and cyclists
   * are excluded: a person on a bench is inside that bench on purpose.
   */
  let inProps = 0;
  const inPropsBy = {};
  for (const a of st.agents) {
    if (a.held) { held++; continue; }
    const m = MODE_NAME[a.mode] || 'UNKNOWN';
    modes[m] = (modes[m] || 0) + 1;
    if (a.role) roles[a.role] = (roles[a.role] || 0) + 1;
    if (a.dog) dogs++;
    // SIT and CYCLE are exempt for the obvious reason. So is SERVE: a waiter
    // whose whole job is weaving between the tables is inside the terrace
    // furniture by design, and counting them made the metric lie by a third.
    if (a.mode !== MODE.SIT && a.mode !== MODE.CYCLE && a.mode !== MODE.SERVE
        && st.obstacles && !spotIsClear(st.obstacles, a.x, a.z, WALK_R * 0.82)) {
      inProps++;
      inPropsBy[m] = (inPropsBy[m] || 0) + 1;
    }
  }
  return {
    agents: st.agents.length,
    inThePit: held,
    night: +(st.night).toFixed(3),
    shoots: st.shoots.length,
    venues: st.venues.length,
    dogs,
    inProps,
    inPropsBy,
    modes,
    roles,
  };
}

/* ======================================================= obstacle field === */

/**
 * EVERYTHING ALREADY STANDING ON THE PAVEMENT, from the registry.
 *
 * `ctx.isFree` is a 3 m occupancy grid that answers "has anyone claimed
 * anywhere near here", and it rounds any non-zero radius up to a 9x9 m
 * neighbourhood. Used as a placement test it rejects almost every candidate on
 * a busy frontage, which is why the crowd placers stopped consulting it for
 * individual people — and why a review then found people standing inside
 * benches, shelters, planters and kiosks.
 *
 * The registry has what is actually needed: the MEASURED contact radius of
 * every object worldBuild sized from its geometry. This grid indexes exactly
 * those, so a person can stand 40 cm from a bollard and 1.6 m from a bus
 * shelter, which is what a real pavement looks like.
 *
 * What is deliberately NOT an obstacle:
 *   · anything under 34 cm tall — a manhole, a kerb inlay, a painted marking.
 *     You walk over those.
 *   · anything over ~4.2 m of contact radius — that is a building, and its
 *     half-diagonal would blanket the pavement in front of it. The sidewalk
 *     graph already runs outside the building line.
 *   · vehicles and boats — they live on the carriageway, in bays and on the
 *     water, and a crossing pedestrian has to be able to walk in front of one.
 */
const OBST_CELL = 5;
const OBST_STRIDE = 6;      // x, z, halfX, halfZ, cos(yaw), sin(yaw)
const NOT_OBSTACLE = /^(sedan|suv|hatchback|pickup|sports|convertible|taxi|police|supercar|roadster|gtCoupe|deliveryVan|boxTruck|flatbed|garbageTruck|cementMixer|cityBus|articBus|shuttleBus|ambulance|scooter|motorcycle|bicycle|motorYacht|sailBoat|waterTaxi|skiff|sportFisher|cruiseShip|jetSki|pedestrian|dog)$/;

/**
 * The contact footprint of a pool's geometry as a LOCAL half-extent pair.
 *
 * `Consumable.radius` is the half-DIAGONAL of that patch, and treating it as a
 * circle is catastrophically wrong for the two prop families that line a
 * pavement. A 4 m hedge 0.8 m deep has a half-diagonal of 2.04 m, so as a
 * circle it blocks two and a half metres of footway either side of itself —
 * measured, that mistake alone closed 8,400 of the city's 27,000 corridor
 * stations and made the whole clearance pass fall back to "no idea". As an
 * oriented box it blocks 40 cm, which is what a hedge actually does.
 *
 * Measured off the lowest quarter of the mesh, the same band worldBuild sizes
 * the consumption physics from, so the two agree by construction.
 */
const _contactBox = new WeakMap();
function contactBox(geometry) {
  let m = _contactBox.get(geometry);
  if (m) return m;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const hiY = bb.min.y + (bb.max.y - bb.min.y) * 0.25;
  const pos = geometry.attributes.position;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > hiY) continue;
    const x = pos.getX(i), z = pos.getZ(i);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (!(maxX > minX)) { minX = bb.min.x; maxX = bb.max.x; minZ = bb.min.z; maxZ = bb.max.z; }
  m = { hx: (maxX - minX) / 2, hz: (maxZ - minZ) / 2 };
  _contactBox.set(geometry, m);
  return m;
}

function buildObstacleField(ctx) {
  const cells = new Map();
  const kinds = new Map();
  let n = 0;
  for (const c of ctx.registry.byId.values()) {
    if (c.height < 0.34) continue;
    // A big footprint that is also tall is a building; a big footprint that is
    // low is a fountain basin or a raised planter, and people really do have to
    // walk round those.
    if (c.radius > 5.5 || c.radius < 0.07) continue;
    if (c.height > 6 && c.radius > 1.6) continue;
    if (NOT_OBSTACLE.test(c.kind)) continue;

    let hx, hz;
    if (c.pool && c.pool.geometry) {
      const bx = contactBox(c.pool.geometry);
      const sc = typeof c.scale === 'number' ? c.scale : 1;
      hx = bx.hx * sc; hz = bx.hz * sc;
    } else {
      // Mesh-backed props have no shared geometry to measure, so fall back to
      // the inscribed square of the declared radius rather than to the circle.
      hx = hz = c.radius * 0.707;
    }
    if (hx < 0.05 && hz < 0.05) continue;
    const yaw = c.rotationY || 0;
    const k = (Math.floor(c.position.x / OBST_CELL) + 2048) * 8192
            + (Math.floor(c.position.z / OBST_CELL) + 2048);
    let b = cells.get(k);
    if (!b) { b = []; cells.set(k, b); kinds.set(k, []); }
    b.push(c.position.x, c.position.z, hx, hz, Math.cos(yaw), Math.sin(yaw));
    kinds.get(k).push(c.kind);
    n++;
  }
  return { cells, kinds, n };
}

/**
 * Signed clearance of a point against one oriented contact box.
 * Returns the penetration depth (>0 when inside) and the escape direction.
 */
const _pen = { depth: 0, nx: 0, nz: 0 };
function boxPenetration(b, q, x, z, pr) {
  const dx = x - b[q], dz = z - b[q + 1];
  const co = b[q + 4], si = b[q + 5];
  // World -> the box's own frame (rotation about Y by -yaw).
  const lx = dx * co - dz * si;
  const lz = dx * si + dz * co;
  const hx = b[q + 2], hz = b[q + 3];
  const ox = Math.abs(lx) - hx, oz = Math.abs(lz) - hz;
  if (ox >= pr || oz >= pr) { _pen.depth = -1; return _pen; }
  if (ox > 0 || oz > 0) {
    // Outside the box: distance to the nearest face or corner.
    const ex = Math.max(ox, 0), ez = Math.max(oz, 0);
    const d = Math.hypot(ex, ez);
    if (d >= pr) { _pen.depth = -1; return _pen; }
    const sx = lx < 0 ? -1 : 1, sz = lz < 0 ? -1 : 1;
    let px = ex > 0 ? sx : 0, pz = ez > 0 ? sz : 0;
    const l = Math.hypot(px, pz) || 1;
    px /= l; pz /= l;
    _pen.depth = pr - d;
    _pen.nx = px * co + pz * si;
    _pen.nz = -px * si + pz * co;
    return _pen;
  }
  // Inside: push out through the nearest face.
  const outX = pr - ox, outZ = pr - oz;   // ox, oz are negative here
  const sx = lx < 0 ? -1 : 1, sz = lz < 0 ? -1 : 1;
  if (outX < outZ) { _pen.depth = outX; _pen.nx = sx * co; _pen.nz = -sx * si; }
  else { _pen.depth = outZ; _pen.nx = sz * si; _pen.nz = sz * co; }
  return _pen;
}

/**
 * Push a point out of anything it is standing inside.
 *
 * Iterative because a person wedged between a planter and a bench has to be
 * moved out of both, and moving them off one can put them into the other.
 * Four passes settles every case in the city; beyond that the spot is simply
 * full and the caller should try somewhere else.
 */
const _clearOut = { x: 0, z: 0, moved: 0 };
function clearOfProps(field, x, z, pr) {
  let ox = x, oz = z, worst = 0;
  for (let pass = 0; pass < 4; pass++) {
    let px = 0, pz = 0, hit = 0;
    const cx = Math.floor(ox / OBST_CELL), cz = Math.floor(oz / OBST_CELL);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const b = field.cells.get((cx + i + 2048) * 8192 + (cz + j + 2048));
        if (!b) continue;
        for (let q = 0; q < b.length; q += OBST_STRIDE) {
          const p = boxPenetration(b, q, ox, oz, pr);
          if (p.depth <= 0) continue;
          if (pass === 0 && p.depth > worst) worst = p.depth;
          px += p.nx * p.depth; pz += p.nz * p.depth;
          hit++;
        }
      }
    }
    if (!hit) break;
    ox += px; oz += pz;
  }
  _clearOut.x = ox; _clearOut.z = oz;
  _clearOut.moved = worst;
  return true;
}

/** Is this spot clear of furniture? Cheap version of the above. */
function spotIsClear(field, x, z, pr) {
  const cx = Math.floor(x / OBST_CELL), cz = Math.floor(z / OBST_CELL);
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const b = field.cells.get((cx + i + 2048) * 8192 + (cz + j + 2048));
      if (!b) continue;
      for (let q = 0; q < b.length; q += OBST_STRIDE) {
        if (boxPenetration(b, q, x, z, pr).depth > 0) return false;
      }
    }
  }
  return true;
}

/* ========================================================= sidewalk data === */

/**
 * Turn RoadNetwork's per-block waypoint loops into flat arc-length paths.
 *
 * Arc length rather than "segment index + t" because pedestrian separation is
 * a 1-D problem along the loop: two people bunch up when their `s` values are
 * close, and that is a single subtraction.
 */
function buildPaths(net) {
  const out = [];
  for (const sw of net.sidewalks) {
    const pts = sw.points;
    const n = pts.length;
    if (n < 6) continue;
    const b = sw.block;
    // A parcel this small is all building; its "sidewalk" would be indoors.
    if (Math.min(b.w, b.d) < 19) continue;
    const px = new Float32Array(n + 1);
    const pz = new Float32Array(n + 1);
    const cum = new Float32Array(n + 1);
    for (let i = 0; i < n; i++) { px[i] = pts[i].x; pz[i] = pts[i].z; }
    px[n] = px[0]; pz[n] = pz[0];
    for (let i = 0; i < n; i++) {
      cum[i + 1] = cum[i] + Math.hypot(px[i + 1] - px[i], pz[i + 1] - pz[i]);
    }
    out.push({
      block: b,
      px, pz, cum, n,
      total: cum[n],
      streetLife: sw.streetLife,
      // Wide blocks carry two lanes of foot traffic; a 20 m parcel cannot.
      // The offset is always to the walker's right, so one stream hugs the
      // kerb and the other the shopfronts, and the cap has to keep the inbound
      // stream off the building line on the tightest parcels.
      lat: Math.min(1.35, Math.max(0.30, (Math.min(b.w, b.d) - 16) * 0.07)),
      hooks: new Array(n).fill(null),
      agents: [],
      /** Free lateral band, per CLEAR_STEP of arc. Filled by buildClearance. */
      clearLo: null, clearHi: null, clearN: 0,
    });
  }
  return out;
}

/* ------------------------------------------------- walking corridor --- */

const CLEAR_STEP = 1.0;      // metres of arc per sample
const CLEAR_PAD = 1.30;      // along-track dilation: advance warning of a bench
const WALK_R = 0.26;         // a walking person's shoulder half-width + margin

/**
 * Carve the free walking corridor out of each pavement loop.
 *
 * A walker's position is (arc length, lateral offset), and the lateral offset
 * used to be a free choice inside +-`lat`. On a Brickell frontage that band is
 * full of benches, planters, bins and bus shelters, so a stream of people
 * walked straight through the street furniture — the loudest single defect in
 * the crowd, and one a static placement fix cannot touch because the people
 * are MOVING.
 *
 * So the band is measured instead. Every metre of every loop stores the widest
 * lateral interval that is genuinely free, and `stepWalk` steers inside it. The
 * along-track test is dilated by CLEAR_PAD so the interval closes a metre and a
 * bit BEFORE the obstacle, which turns a clip into a swerve.
 *
 * When a loop is completely blocked at some point — a shelter that spans the
 * whole pavement — the interval falls back to the full band rather than to
 * nothing: an unavoidable clip is better than a person frozen or teleported.
 */
function buildClearance(paths, field) {
  let blocked = 0, samples = 0;
  const why = {};
  for (const p of paths) {
    const n = Math.max(4, Math.ceil(p.total / CLEAR_STEP));
    const lo = new Float32Array(n);
    const hi = new Float32Array(n);
    // Never narrower than 1.05 m either side. `p.lat` is derived from the
    // BLOCK size, not from the pavement, so a small parcel gets a 40 cm band —
    // and a band that narrow is closed by anything within half a metre of the
    // centreline, which measured out as 12,400 of the city's 27,200 stations
    // reporting "no way through" on pavement that is plainly walkable.
    const lim = Math.max(p.lat * 1.35, 1.05);
    for (let i = 0; i < n; i++) {
      const s = i * CLEAR_STEP;
      const sm = sampleLoop(p, s, 0);
      const inv = 1 / (Math.hypot(sm.dx, sm.dz) || 1);
      const ux = sm.dx * inv, uz = sm.dz * inv;
      // Right-hand normal of the loop's own direction. `stepWalk` measures lat
      // along the walker's direction of travel, so a walker going the other way
      // sees the interval mirrored — hence the symmetric band below.
      const nx = -uz, nz = ux;

      // Collect the blocked lateral intervals at this station.
      let aLo = -lim, aHi = lim;
      const cx = Math.floor(sm.x / OBST_CELL), cz = Math.floor(sm.z / OBST_CELL);
      const spans = [];
      for (let gi = -1; gi <= 1; gi++) {
        for (let gj = -1; gj <= 1; gj++) {
          const b = field.cells.get((cx + gi + 2048) * 8192 + (cz + gj + 2048));
          if (!b) continue;
          for (let q = 0; q < b.length; q += OBST_STRIDE) {
            const dx = b[q] - sm.x, dz = b[q + 1] - sm.z;
            const hx = b[q + 2], hz = b[q + 3], co = b[q + 4], si = b[q + 5];
            // The box's own axes in world space, projected onto the loop's
            // frame. This is the box's bounding extent along and across the
            // pavement — exact for anything square-on to the street, which is
            // almost everything, and conservative otherwise.
            const axU = co * ux - si * uz, azU = si * ux + co * uz;
            const halfAlong = hx * Math.abs(axU) + hz * Math.abs(azU);
            const along = dx * ux + dz * uz;
            if (Math.abs(along) > halfAlong + CLEAR_PAD) continue;
            const axN = co * nx - si * nz, azN = si * nx + co * nz;
            const halfLat = hx * Math.abs(axN) + hz * Math.abs(azN);
            const lat = dx * nx + dz * nz;
            const w = halfLat + WALK_R;
            if (lat - w > lim || lat + w < -lim) continue;
            spans.push([lat - w, lat + w, field.kinds.get(
              (cx + gi + 2048) * 8192 + (cz + gj + 2048))[q / OBST_STRIDE]]);
          }
        }
      }
      if (spans.length) {
        // Sweep the blocked spans in order and keep the widest gap between
        // them that still lies inside the loop's own lateral band.
        spans.sort((u, v) => u[0] - v[0]);
        let cur = -lim, best = -1;
        for (const sp of spans) {
          if (sp[0] > cur) {
            const end = Math.min(sp[0], lim);
            if (end - cur > best) { best = end - cur; aLo = cur; aHi = end; }
          }
          if (sp[1] > cur) cur = sp[1];
          if (cur >= lim) break;
        }
        if (cur < lim && lim - cur > best) { best = lim - cur; aLo = cur; aHi = lim; }
        // Genuinely no way through — a shelter across the whole footway. Take
        // the least-bad line rather than the whole band: an unavoidable brush
        // past the corner beats walking through the middle of it.
        if (best <= 0) {
          let bestLat = 0, bestPen = Infinity;
          for (let t = -1; t <= 1; t += 0.1) {
            const cand = t * lim;
            let pen = 0;
            for (const sp of spans) {
              if (cand > sp[0] && cand < sp[1]) {
                pen = Math.max(pen, Math.min(cand - sp[0], sp[1] - cand));
              }
            }
            if (pen < bestPen) { bestPen = pen; bestLat = cand; }
          }
          aLo = aHi = bestLat;
          blocked++;
          for (const sp of spans) why[sp[2]] = (why[sp[2]] || 0) + 1;
        }
      }
      lo[i] = aLo; hi[i] = aHi;
      samples++;
    }
    p.clearLo = lo; p.clearHi = hi; p.clearN = n;
  }
  return { samples, blocked, why };
}

/**
 * The final placement sweep: nobody is standing inside the street furniture.
 *
 * Runs after every placer, because the placers legitimately fight over the same
 * ground and only the finished crowd knows where everyone ended up. Two kinds
 * of agent are deliberately left alone:
 *
 *   · anyone SITTING. A person on a bench, on a café chair or on the grass is
 *     supposed to be inside that bench's footprint — that is what sitting is.
 *   · anyone whose position is a hard requirement of their behaviour: a
 *     presenter on their mark, a doorman on the door, a valet at the kerb.
 *     Those are moved by at most a nudge, and never off their spot.
 *
 * Walkers are handled through `lat` rather than through x/z, because their
 * position is regenerated from (arc length, lateral offset) on every tick and
 * writing x/z directly would be undone on frame one.
 */
function clearCrowd(agents, field) {
  let fixed = 0, stuck = 0;
  const band = { lo: 0, hi: 0 };
  for (const a of agents) {
    if (a.mode === MODE.SIT || a.mode === MODE.CYCLE) continue;
    const pr = a.bike ? 0.42 : WALK_R;

    if (a.path) {
      // Snap the walker's lane into the measured corridor, then rebuild x/z
      // from it so the very first rendered frame already agrees with the sim.
      clearanceAt(a.path, a.s, a.dir, band);
      const mid = (band.lo + band.hi) * 0.5;
      let lat = a.latTarget;
      if (lat < band.lo || lat > band.hi) {
        lat = band.hi - band.lo > 0.7
          ? Math.max(band.lo + 0.2, Math.min(band.hi - 0.2, lat))
          : mid;
        fixed++;
      }
      a.latTarget = a.lat = lat;
      const sm = sampleLoop(a.path, a.s, 0);
      const inv = 1 / (Math.hypot(sm.dx, sm.dz) || 1);
      const ux = sm.dx * inv * a.dir, uz = sm.dz * inv * a.dir;
      a.x = sm.x + (-uz) * lat;
      a.z = sm.z + ux * lat;
      a.yaw = Math.atan2(ux, uz);
      continue;
    }

    if (spotIsClear(field, a.x, a.z, pr)) continue;
    clearOfProps(field, a.x, a.z, pr);
    // A stationary character has a REASON to be where they are. Two metres is
    // the most that can be given away before a doorman is no longer on the
    // door; past that, leave them and let the placement read as tight rather
    // than teleport them across the pavement.
    const dx = _clearOut.x - a.x, dz = _clearOut.z - a.z;
    if (dx * dx + dz * dz > 4) { stuck++; continue; }
    a.x = _clearOut.x; a.z = _clearOut.z;
    fixed++;
  }
  return { fixed, stuck };
}

/** Free lateral band at arc length `s` on loop `p`, for a walker heading `dir`. */
function clearanceAt(p, s, dir, out) {
  if (!p.clearLo) { out.lo = -p.lat * 1.3; out.hi = p.lat * 1.3; return out; }
  let i = Math.round(s / CLEAR_STEP) % p.clearN;
  if (i < 0) i += p.clearN;
  // `lat` in stepWalk is measured along the RIGHT of travel; the profile is
  // stored along the right of the loop's own winding, so a walker going
  // backwards sees it mirrored.
  if (dir >= 0) { out.lo = p.clearLo[i]; out.hi = p.clearHi[i]; }
  else { out.lo = -p.clearHi[i]; out.hi = -p.clearLo[i]; }
  return out;
}

/**
 * Attach every crossing to the two sidewalk loops it joins.
 *
 * Done through a coarse bucket grid: the naive version is 400 crossings x 400
 * loops x 40 points and costs most of a second of boot time.
 */
function linkCrossings(net, paths) {
  const CELL = 24;
  const grid = new Map();
  const key = (x, z) => (Math.floor(x / CELL) + 2048) * 4096 + (Math.floor(z / CELL) + 2048);
  for (let pi = 0; pi < paths.length; pi++) {
    const p = paths[pi];
    for (let i = 0; i < p.n; i++) {
      const k = key(p.px[i], p.pz[i]);
      let bucket = grid.get(k);
      if (!bucket) { bucket = []; grid.set(k, bucket); }
      bucket.push(pi, i);
    }
  }
  const nearest = (x, z) => {
    let best = null, bd = 81;   // 9 m, squared
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const bucket = grid.get((cx + ox + 2048) * 4096 + (cz + oz + 2048));
        if (!bucket) continue;
        for (let q = 0; q < bucket.length; q += 2) {
          const p = paths[bucket[q]], i = bucket[q + 1];
          const dx = p.px[i] - x, dz = p.pz[i] - z;
          const d2 = dx * dx + dz * dz;
          if (d2 < bd) { bd = d2; best = { path: p, index: i }; }
        }
      }
    }
    return best;
  };

  for (const cr of net.crossings) {
    const ea = nearest(cr.a.x, cr.a.z);
    const eb = nearest(cr.b.x, cr.b.z);
    if (!ea || !eb || ea.path === eb.path) continue;
    // The carriageway this crossing spans, so the walker's height can drop off
    // the kerb and climb back up on the far side.
    cr.roadCentre = cr.axis === 'z' ? cr.ix.z : cr.ix.x;
    cr.roadHalf = cr.axis === 'z' ? cr.ix.halfZ : cr.ix.halfX;
    // A walker on a north/south crosswalk moves with the north/south traffic,
    // whose lanes carry axis 'x' — see roadNetwork's lane conventions.
    cr.vehAxis = cr.axis === 'z' ? 'x' : 'z';
    cr.ends = [
      { at: cr.a, path: ea.path, index: ea.index, other: 1 },
      { at: cr.b, path: eb.path, index: eb.index, other: 0 },
    ];
    for (const e of cr.ends) {
      if (!e.path.hooks[e.index]) e.path.hooks[e.index] = [];
      e.path.hooks[e.index].push({ crossing: cr, end: e });
    }
  }
}

/* ============================================================== spawning === */

/**
 * ACCESSORY RATES ARE DELIBERATELY HIGH.
 *
 * A crowd of 1,900 bodies built from one body plan reads as one body plan
 * repeated, however good the body plan is. Hats, bags, phones and sunglasses
 * are four different SILHOUETTES for the price of four small instanced pools,
 * and Miami is a city where a lot of people are wearing sunglasses.
 */
const ARCHETYPES = [
  { key: 'resident', label: 'Local', w: 28, speed: [1.05, 1.42], tops: TOP_CASUAL, longLeg: 0.5, hat: 0.22, bag: 0.26, sleeves: 0.10, phone: 0.34, cup: 0.12, shades: 0.30 },
  { key: 'office', label: 'Office Worker', w: 20, speed: [1.35, 1.70], tops: TOP_OFFICE, longLeg: 0.94, hat: 0.06, bag: 0.66, sleeves: 0.66, phone: 0.38, cup: 0.34, lanyard: 0.55, shades: 0.22 },
  { key: 'tourist', label: 'Tourist', w: 19, speed: [0.75, 1.10], tops: TOP_TOURIST, longLeg: 0.10, hat: 0.62, bag: 0.62, sleeves: 0.02, phone: 0.48, camera: 0.30, gaze: 0.55, shades: 0.45 },
  { key: 'jogger', label: 'Jogger', w: 6, speed: [2.55, 3.30], tops: TOP_SPORT, longLeg: 0.05, hat: 0.28, bag: 0.08, sleeves: 0.0, shades: 0.38 },
  { key: 'server', label: 'Server', w: 5, speed: [1.10, 1.40], tops: TOP_OFFICE, longLeg: 0.85, apron: true, sleeves: 0.4 },
  { key: 'worker', label: 'Site Worker', w: 6, speed: [0.95, 1.25], tops: TOP_SPORT, longLeg: 0.95, hivis: true, sleeves: 0.5, shades: 0.20 },
  { key: 'skater', label: 'Skateboarder', w: 3, speed: [3.0, 4.0], tops: TOP_CASUAL, longLeg: 0.25, board: true, hat: 0.42, shades: 0.30 },
  { key: 'dogwalker', label: 'Dog Walker', w: 5, speed: [0.95, 1.25], tops: TOP_CASUAL, longLeg: 0.4, dog: true, hat: 0.20, bag: 0.18, phone: 0.18, shades: 0.28 },
  { key: 'shopper', label: 'Shopper', w: 8, speed: [0.90, 1.25], tops: TOP_CASUAL, longLeg: 0.35, bag: 0.88, hat: 0.30, phone: 0.30, shades: 0.30 },
];

/** A child: same rig, two thirds the height, and never carrying anything. */
const ARCH_CHILD = {
  key: 'child', label: 'Kid', speed: [1.0, 1.35], tops: TOP_TOURIST,
  longLeg: 0.18, hat: 0.24, sleeves: 0.05,
};
const ARCH_CREATOR = {
  key: 'creator', label: 'Content Creator', speed: [1.0, 1.3], tops: TOP_CASUAL,
  longLeg: 0.35, sleeves: 0.2, hat: 0.18,
};
const ARCH_CREW = {
  key: 'crew', label: 'Camera Operator', speed: [1.0, 1.3], tops: TOP_OFFICE,
  longLeg: 0.9, sleeves: 0.5, hat: 0.35,
};
const ARCH_DOORMAN = {
  key: 'doorman', label: 'Doorman', speed: [0.9, 1.1], tops: UNIFORM_DARK,
  longLeg: 1.0, sleeves: 0.9,
};
const ARCH_BUSKER = {
  key: 'busker', label: 'Busker', speed: [0.9, 1.2], tops: TOP_TOURIST,
  longLeg: 0.3, sleeves: 0.1, hat: 0.45,
};

/* --- the street-life cast. Same rig, same standard as everyone else. --- */

/** Retirees at the park tables: guayaberas, long trousers, wide hats. */
const ARCH_PLAYER = {
  key: 'player', label: 'Domino Player', speed: [0.8, 1.0], tops: TOP_GUAYABERA,
  longLeg: 0.92, sleeves: 0.55, hat: 0.50,
};
const ARCH_VENDOR = {
  key: 'vendor', label: 'Street Vendor', speed: [0.9, 1.15], tops: TOP_CASUAL,
  longLeg: 0.60, sleeves: 0.25, hat: 0.42,
};
const ARCH_SPEAKER = {
  key: 'speaker', label: 'Street Preacher', speed: [0.9, 1.1], tops: TOP_OFFICE,
  longLeg: 0.90, sleeves: 0.70, hat: 0.16,
};
const ARCH_TAICHI = {
  key: 'taichi', label: 'Tai Chi', speed: [0.7, 0.95], tops: TOP_SPORT,
  longLeg: 0.70, sleeves: 0.30, hat: 0.06,
};
/**
 * Someone resting on the street with their things.
 *
 * Deliberately identical in every respect that the renderer can see: the same
 * body, the same colour sets, the same range of hats and bags as the office
 * worker walking past. The ONLY thing that distinguishes them in the frame is
 * that they are sitting down and their belongings are next to them, which is
 * the whole and only point.
 */
const ARCH_RESTING = {
  key: 'resting', label: 'Local', speed: [0.8, 1.05], tops: TOP_CASUAL,
  longLeg: 0.62, sleeves: 0.30, hat: 0.30, bag: 0.35,
};
/** On the court. Sport tops, shorts, no bags, no hats to speak of. */
const ARCH_BALLER = {
  key: 'baller', label: 'Player', speed: [1.05, 1.35], tops: TOP_SPORT,
  longLeg: 0.10, sleeves: 0.04, hat: 0.10,
};
/** Watching from the fence line. Ordinary people, ordinary clothes. */
const ARCH_COURTSIDE = {
  key: 'courtside', label: 'Spectator', speed: [0.85, 1.15], tops: TOP_CASUAL,
  longLeg: 0.45, sleeves: 0.22, hat: 0.30, bag: 0.30,
};
const ARCH_RESIDENT = ARCHETYPES[0];
const ARCH_PROMOTER = {
  key: 'promoter', label: 'Club Promoter', speed: [1.0, 1.25], tops: TOP_NIGHT,
  longLeg: 0.80, sleeves: 0.35,
};

const ARCH_TOTAL = ARCHETYPES.reduce((s, a) => s + a.w, 0);

function pickArchetype(rng, allowSpecial) {
  let r = rng() * ARCH_TOTAL;
  for (const a of ARCHETYPES) {
    r -= a.w;
    if (r <= 0) {
      if (!allowSpecial && (a.board || a.dog)) return ARCHETYPES[0];
      return a;
    }
  }
  return ARCHETYPES[0];
}

const BAG_PACK = [1, 1, 1];

/** Rough luminance-weighted distance between two sRGB hexes, 0..1. */
function hexFar(a, b) {
  const dr = (((a >> 16) & 255) - ((b >> 16) & 255)) / 255;
  const dg = (((a >> 8) & 255) - ((b >> 8) & 255)) / 255;
  const db = ((a & 255) - (b & 255)) / 255;
  return Math.sqrt(dr * dr * 0.30 + dg * dg * 0.59 + db * db * 0.11);
}

/**
 * Put a dog on the end of somebody's lead.
 *
 * Breed picks the POOL, so it also picks the silhouette (short-legged, tall and
 * lean, or fluffy) and the baked collar colour. Scale then wobbles it inside
 * the breed, so two dachshunds on the same street are not the same dachshund.
 */
function giveDog(a, rng) {
  a.dog = true;
  a.dogBreed = rng.weighted([[0, 38], [1, 30], [2, 32]]);
  a.dogHex = rng.pick(DOG_COLORS);
  a.dogScale = 0.80 + rng() * 0.22;
  a.dogPhase = rng() * 6.28;
}

/** Everything about an agent that never changes after the build. */
function makeAgent(rng, arch) {
  const skin = rng.pick(SKIN);
  const hair = rng.pick(HAIR);
  const top = rng.pick(arch.tops);
  const longLeg = rng.chance(arch.longLeg ?? 0.5);
  const pool = longLeg ? BOTTOM_LONG : BOTTOM_SHORT;
  /**
   * TROUSERS ARE FORCED AWAY FROM THE SKIN TONE.
   *
   * Half the bottoms in the palette are tans and half the skins are tans, so by
   * chance one figure in five came out with legs the same colour as their arms
   * — which at three metres reads as a shirt on a naked person, not as a person
   * in chinos. Four re-rolls is enough to make that vanishingly rare without
   * skewing the palette.
   */
  let bottom = rng.pick(pool);
  for (let t = 0; t < 4 && hexFar(bottom, skin) < 0.20; t++) bottom = rng.pick(pool);
  const sleeves = rng.chance(arch.sleeves ?? 0.2);

  const a = {
    arch,
    label: arch.label,
    size: 0.885 + rng() * 0.175,
    skin, hair, top, bottom,
    /** Long sleeves take the shirt colour, short sleeves show bare arm. */
    armHex: sleeves ? top : skin,
    /** Trousers run into the shoe; shorts leave a bare shin. */
    legHex: longLeg ? bottom : skin,
    // Hair is only ever scaled UP from the skull, never down: a hairScale below
    // 1 opens a bald patch where the head pokes through the cap.
    hairScale: 1.0 + rng() * 0.13,
    hairTall: rng.chance(0.34) ? 1.10 + rng() * 0.14 : 1.0,

    hat: false, hatHex: 0, hatScale: 1, hatSlot: -1,
    bag: false, bagHex: 0, bagSlot: -1, bagLX: 0, bagG: BAG_PACK,
    overlay: false, overlayHex: 0, overlaySlot: -1,
    bike: false, bikeHex: 0, bikeSlot: -1,
    board: false, boardHex: 0, boardSlot: -1,
    dog: false, dogHex: 0, dogSlot: -1, dogBreed: 0, dogScale: 0.88,

    mode: MODE.WALK,
    x: 0, y: 0, z: 0, yaw: 0,
    phase: rng() * Math.PI * 2,
    speed: rng.range(arch.speed[0], arch.speed[1]),
    curSpeed: 0,
    path: null, s: 0, dir: 1, seg: 0,
    lat: 0, latTarget: 0,
    tx: 0, tz: 0,
    crossing: null, crossEnd: null, crossT: 0,
    wait: 0,
    lane: null, laneS: 0,
    hipY: HIP_Y,
    lean: 0.045 + rng() * 0.03,
    idleSeed: rng() * 100,
    chatPartner: null,
    acc: 0,
    dead: false,
    /** True while the consume system owns the body. See the handover note. */
    held: false,
    c: null, pool: null, slot: -1,

    /** Hand-held props. Slots are assigned once the whole crowd exists. */
    items: null,
    /** Sub-behaviour tag: 'presenter', 'boom', 'doorman', 'queuer', ... */
    role: null,
    /** Head-up-at-the-skyline timer, and the interval between doing it. */
    gazeT: 0, gazeEvery: 0,
    /** Walking while reading: slower, head down, one arm locked up in front. */
    phoneWalk: false,
  };

  if (rng.chance(arch.hat ?? 0)) {
    a.hat = true;
    a.hatHex = rng.pick(HAT_COLORS);
    a.hatScale = arch.key === 'tourist' ? 1.25 : 0.90;
  }
  if (rng.chance(arch.bag ?? 0)) {
    a.bag = true;
    a.bagHex = rng.pick(BAG_COLORS);
    // Three carries out of one mesh. `g` squashes the authored backpack into a
    // satchel or a flat tote and drags its authored offset with it; `lx` slides
    // the whole thing round to the hip.
    const style = rng.weighted([[0, 46], [1, 32], [2, 22]]);
    if (style === 0) { a.bagLX = 0; a.bagG = [1, 1, 1]; }
    else if (style === 1) { a.bagLX = (rng.chance(0.5) ? 1 : -1) * 0.20; a.bagG = [0.80, 0.78, 0.62]; }
    else { a.bagLX = (rng.chance(0.5) ? 1 : -1) * 0.24; a.bagG = [0.90, 0.94, 0.40]; }
  }
  if (arch.hivis) {
    a.overlay = true;
    a.overlayHex = PALETTE.NEON_YELLOW;
    a.hat = true;
    a.hatHex = rng.chance(0.5) ? PALETTE.CRANE_YELLOW : PALETTE.CAR_WHITE;
    a.hatScale = 0.92;
  }
  if (arch.apron) {
    a.overlay = true;
    a.overlayHex = rng.chance(0.5) ? PALETTE.STUCCO_WHITE : PALETTE.SIGN_DARK;
  }
  if (arch.board) {
    a.board = true;
    a.boardHex = rng.pick(TOP_CASUAL);
  }
  if (arch.dog) giveDog(a, rng);

  /* --- what they are carrying ------------------------------------------- */
  // A phone is the single most common thing in a modern hand, and "head down,
  // one arm locked up in front" is a silhouette a player recognises from
  // 40 metres. It is also the cheapest possible variation: one prism.
  if (rng.chance(arch.phone ?? 0)) {
    a.phoneWalk = rng.chance(0.62);
    addItem(a, AT.HAND_R, 0.078, 0.150, 0.019, rng.pick(PHONE_COLORS), 0.55);
    if (a.phoneWalk) a.speed *= 0.86;      // nobody reads and strides
  }
  if (rng.chance(arch.cup ?? 0)) {
    addItem(a, AT.HAND_L, 0.078, 0.115, 0.078, rng.pick(CUP_COLORS), 0);
  }
  if (rng.chance(arch.camera ?? 0)) {
    addItem(a, AT.CHEST, 0.135, 0.095, 0.075, rng.pick(GEAR_DARK), 0);
  }
  if (rng.chance(arch.lanyard ?? 0)) {
    // The badge, not the cord: a 5 cm card is all that reads, and it is the
    // one thing that says "works in that tower" rather than "is on holiday".
    addItem(a, AT.CHEST, 0.058, 0.085, 0.006, rng.pick(TOP_TOURIST), 0, 0, -0.05);
  }
  // Sunglasses: a dark band across the eyes, riding the head. It is the single
  // cheapest way to make two people with the same face read as different, and
  // it costs one more instance in the pool every hand-held already shares.
  if (rng.chance(arch.shades ?? 0)) {
    addItem(a, AT.FACE, 0.136, 0.038, 0.024,
      rng.chance(0.24) ? rng.pick(GEAR_DARK) : PALETTE.SIGN_DARK, 0);
  }
  if (rng.chance(arch.gaze ?? 0)) {
    a.gazeEvery = 16 + rng() * 26;
    a.gazeT = rng() * a.gazeEvery;
  }
  return a;
}

/**
 * Attach a hand-held. `sw` is an extra tilt on top of whatever the attachment
 * point already does, `dy` lifts it along the body.
 */
function addItem(a, at, gx, gy, gz, hex, sw = 0, yaw = 0, dy = 0) {
  if (!a.items) a.items = [];
  a.items.push({ slot: -1, at, gx, gy, gz, hex, sw, yaw, dy });
  return a.items[a.items.length - 1];
}

/** Drop an agent onto a sidewalk loop at arc length `s`. */
function joinPath(rng, a, path, s, dir) {
  a.mode = MODE.WALK;
  a.path = path;
  a.s = ((s % path.total) + path.total) % path.total;
  a.dir = dir;
  a.seg = 0;
  a.latTarget = path.lat * (0.55 + rng() * 0.5);
  a.lat = a.latTarget;
  path.agents.push(a);
}

function placeWalkers(ctx, rng, paths, agents, yWalk, budget) {
  if (budget <= 0) return;

  /*
   * Allocate per loop rather than sampling one agent at a time: sampling gives
   * a Poisson scatter, and a Poisson scatter on a busy frontage still leaves
   * 30 m gaps. An explicit count spread evenly along the loop with a little
   * jitter is what makes Brickell Ave read as continuous foot traffic.
   *
   * The exponent is brutal on purpose. The city has 27 km of pavement and the
   * budget is ~900 walkers; spread evenly that is one person every 30 m, which
   * looks abandoned EVERYWHERE. Weighting by (streetLife - 0.34)^3.6 spends
   * almost the whole budget on the ~90 loops the hero cameras actually see and
   * leaves the warehouse district genuinely, correctly deserted.
   *
   * DON'T SOFTEN THIS EXPECTING DENSER STREETS — it was tried and measured.
   * Against a floored, gentler curve (0.18 + max(0, life - 0.30))^1.8, which
   * cuts the spine-to-side-street ratio from ~120x to ~9x:
   *
   *     curve        occupied 100 m cells   busiest 5 cells   median   within 70 m of
   *                                                                    crowd / street-level
   *     ^3.6         109                    76 72 54 53 49    8        27 / 26
   *     floored^1.8  111                    71 64 51 50 41    10       31 / 25
   *
   * i.e. no material difference at any camera, because the binding constraint
   * is the head count, not its distribution. 1,555 people over a city this size
   * is ~10 per hectare however you spread them. Pavement reads busier only with
   * more agents, and the density brief caps this module at 1,600.
   */
  const raw = new Float64Array(paths.length);
  let sum = 0;
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    raw[i] = Math.pow(Math.max(0, p.streetLife - 0.34), 3.6) * p.total;
    sum += raw[i];
  }
  if (sum <= 0) return;
  const k = budget / sum;

  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    const want = raw[i] * k;
    // Stochastic rounding: without it every loop under half a person rounds to
    // zero and the quiet half of the city loses its last two pedestrians.
    let n = Math.floor(want);
    if (rng() < want - n) n++;
    if (n > 42) n = 42;
    for (let j = 0; j < n; j++) {
      const a = makeAgent(rng, pickArchetype(rng, true));
      const s = ((j + rng() * 0.85) / n) * path.total;
      joinPath(rng, a, path, s, rng.chance(0.5) ? 1 : -1);
      a.y = yWalk;
      a.phase = rng() * Math.PI * 2;
      // Resolve the loop position NOW rather than on the first tick. Their
      // consumable is registered from x/z, and a walker left at the default
      // (0,0) puts 900 people in one spatial-hash cell at the map origin —
      // and any child attached to them starts the match there too.
      const sm = sampleLoop(path, a.s, 0);
      a.x = sm.x; a.z = sm.z;
      a.yaw = Math.atan2(sm.dx * a.dir, sm.dz * a.dir);
      agents.push(a);
    }
  }
}

/**
 * Standing and sitting clusters: café frontages, park lawns, plazas and the
 * bay promenade. These are what turn "people commuting" into "a city".
 */
function placeGatherings(ctx, rng, paths, agents, yWalk, cap) {
  const { layout } = ctx;
  for (const path of paths) {
    if (agents.length >= cap) break;
    const b = path.block;
    const r = makeRNG((b.seed ^ 0x51ae) >>> 0);
    const zone = b.zone;

    const isCafe = (zone === ZONE.RETAIL || zone === ZONE.LOWRISE) && b.streetLife > 0.40;
    const isGreen = zone === ZONE.PARK || zone === ZONE.PLAZA;
    const isProm = b.bayfront || b.riverwalk;
    // A tower on a busy street has a forecourt, a lobby door and a smoking
    // corner, and that is exactly where the CBD cameras are pointed — without
    // this the whole Brickell core has walkers but no standing crowd.
    const isLobby = b.streetLife > 0.58
      && (zone === ZONE.TOWER || zone === ZONE.MIDRISE || zone === ZONE.LANDMARK);
    if (!isCafe && !isGreen && !isProm && !isLobby) continue;

    // CLUSTERS, not scatter. Six people spread over a 60 m block read as six
    // strangers standing in a field; the same six in two knots of three read
    // as a café terrace and a conversation. Clustering is most of the "alive".
    const groups = isGreen ? r.int(2, 4) : isCafe ? r.int(2, 3) : r.int(1, 2);

    for (let gi = 0; gi < groups; gi++) {
      // Café and promenade knots hug the frontage where the tables are; park
      // knots sit out on the lawn. Three attempts at a centre, because a busy
      // retail frontage is already thick with props.
      let cx = 0, cz = 0, placed = false;
      for (let t = 0; t < 3 && !placed; t++) {
        if (isGreen) {
          cx = b.x + (r() - 0.5) * b.w * 0.62;
          cz = b.z + (r() - 0.5) * b.d * 0.62;
        } else {
          const inset = 3.0 + r() * 2.6;
          const hw = b.w / 2 - inset, hd = b.d / 2 - inset;
          if (hw < 2 || hd < 2) break;
          const per = 2 * (hw + hd) * 2;
          let u = r() * per;
          if (u < hw * 2) { cx = b.x - hw + u; cz = b.z - hd; }
          else if ((u -= hw * 2) < hd * 2) { cx = b.x + hw; cz = b.z - hd + u; }
          else if ((u -= hd * 2) < hw * 2) { cx = b.x + hw - u; cz = b.z + hd; }
          else { cx = b.x - hw; cz = b.z + hd - (u - hw * 2); }
        }
        placed = !layout.isWater(cx, cz) && !layout.isRoad(cx, cz) && ctx.isFree(cx, cz, 0);
      }
      if (!placed) continue;

      // Only the group's CENTRE is tested against the prop occupancy grid.
      // ctx.isFree() rounds ANY non-zero radius up to a 9x9 m neighbourhood, so
      // testing every member that way rejected 98% of them and left the cafes
      // and lawns empty. Someone standing beside a cafe chair is correct; a
      // group standing inside a ficus is not, and the centre test catches that.
      ctx.occupy(cx, cz, 0);

      const size = isGreen ? r.int(3, 6) : r.int(2, 5);
      const gaze = r() * Math.PI * 2;
      const first = agents.length;
      for (let i = 0; i < size; i++) {
        if (agents.length >= cap) break;
        // Ring the group around its centre so nobody stands inside anyone.
        const ang = gaze + (i / size) * Math.PI * 2 + (r() - 0.5) * 0.5;
        const rad = 0.85 + r() * (isGreen ? 2.4 : 1.2);
        const x = cx + Math.cos(ang) * rad;
        const z = cz + Math.sin(ang) * rad;
        if (layout.isWater(x, z) || layout.isRoad(x, z)) continue;

        const arch = isCafe && r.chance(0.16)
          ? ARCHETYPES[4]                       // a server working the terrace
          : pickArchetype(r, false);
        const a = makeAgent(r, arch);
        a.x = x; a.z = z; a.y = yWalk;
        // Everyone in a knot faces roughly its centre — that inward focus is
        // what makes a cluster read as a conversation and not as a queue.
        a.yaw = Math.atan2(cx - x, cz - z) + (r() - 0.5) * 0.7;
        // A SEAT HAS TO EXIST. This placer invents its own sitters, so the only
        // honest place to put one is a surface that is already there: the lawn,
        // or the paving of the promenade. Sitting at bench height on bare
        // pavement puts the hips 52 cm up with nothing underneath — the
        // "floating prop" automatic failure with a person in it. Real benches
        // and cafe chairs are filled by placeSeated, which reads the furniture
        // props.js actually built.
        const groundSit = isGreen || isProm;
        if (groundSit && r.chance(isGreen ? 0.46 : 0.24)
            && arch.key !== 'jogger' && !arch.board) {
          a.mode = MODE.SIT;
          // Solved, not guessed: with the sprawl pose the heel sits
          // 0.293 below the hip joint, so this is the hip height that puts the
          // shoe on the ground for every body scale.
          a.hipY = SPRAWL_HIP + r() * 0.020;
          a.sitSprawl = true;
          a.lean = 0.10 + r() * 0.18;
          a.seatYaw = a.yaw;
        } else {
          a.mode = MODE.IDLE;
          a.lean = 0.01 + r() * 0.04;
        }
        a.idleSeed = r() * 100;
        agents.push(a);
      }
      // Pair them off so the idle animation has someone to gesture at.
      for (let i = first; i < agents.length - 1; i += 2) {
        agents[i].chatPartner = agents[i + 1];
        agents[i + 1].chatPartner = agents[i];
      }
    }
  }
}

/**
 * Seed the kerbs with people already waiting for the light.
 *
 * Without this the city starts with every pedestrian mid-block and it takes
 * half a minute of play before the first queue forms — and every screenshot is
 * taken in the first two seconds. The city is supposed to have been alive for
 * hours before the player arrived.
 */
function placeCrossingQueues(ctx, rng, net, agents, yWalk, budget) {
  const linked = net.crossings.filter((c) => c.ends);
  if (!linked.length) return;
  let spent = 0;
  /*
   * Busiest junctions first — but "busiest" is TWO things, and this used to
   * only look at one of them.
   *
   * streetLife is a property of the BLOCK: how much retail bustle is on its
   * frontage. It says nothing about how big the junction is. Sorting on it
   * alone sent the whole 180-agent budget to shopfront corners and skipped the
   * six-lane signalised crossings — which is exactly where every gameplay
   * camera in this game is pointed, and why the street-level preset framed a
   * major junction with bare pavement on all four corners.
   *
   * cr.roadHalf is the half-width of the carriageway the crossing spans, so it
   * is a direct measure of how important the junction is. Both terms count now,
   * and the queue LENGTH scales with the junction too: a big crossing gets a
   * line at each kerb, a side street gets nobody, which is what they look like.
   */
  const bigness = (c) => Math.min(1, c.roadHalf / 13);
  const order = linked
    .map((c) => ({
      c,
      big: bigness(c),
      w: (c.ends[0].path.streetLife + c.ends[1].path.streetLife) * 0.30
        + bigness(c) * 0.55 + rng() * 0.20,
    }))
    .sort((a, b) => b.w - a.w);

  for (const { c, big } of order) {
    if (spent >= budget) break;
    for (let e = 0; e < 2; e++) {
      const n = big > 0.8 ? rng.weighted([[1, 18], [2, 30], [3, 30], [4, 22]])
        : big > 0.55 ? rng.weighted([[0, 20], [1, 34], [2, 30], [3, 16]])
          : rng.weighted([[0, 46], [1, 34], [2, 20]]);
      const end = c.ends[e];
      // Which way is "back from the kerb" for this end.
      const away = c.axis === 'z'
        ? Math.sign(end.at.z - c.roadCentre)
        : Math.sign(end.at.x - c.roadCentre);
      for (let i = 0; i < n && spent < budget; i++) {
        const a = makeAgent(rng, pickArchetype(rng, true));
        a.crossing = c;
        a.crossEnd = end;
        // Fan out across the paint, and let the back of the queue stand a step
        // further from the kerb so three people are a queue, not a totem pole.
        a.crossOff = (i - (n - 1) / 2) * 0.85 + (rng() - 0.5) * 0.35;
        aimCrossing(a, end);
        const back = (i % 2) * 0.75 * away;
        if (c.axis === 'z') a.tz += back; else a.tx += back;
        a.x = a.tx; a.z = a.tz; a.y = yWalk;
        a.mode = MODE.WAIT;
        a.wait = rng() * 0.6;
        const other = c.ends[1 - e].at;
        a.yaw = Math.atan2(other.x - a.x, other.z - a.z);
        agents.push(a);
        spent++;
      }
    }
  }
}

/** Cyclists ride the kerb lane and stop at reds like everyone else. */
function placeCyclists(ctx, rng, net, agents) {
  const { layout } = ctx;
  const kerbLanes = net.lanes.filter((l) => l.kerbLane);
  if (!kerbLanes.length) return;
  const want = 72;
  for (let i = 0; i < want; i++) {
    const lane = rng.pick(kerbLanes);
    const range = net.sRange(lane);
    const s = range.lo + rng() * (range.hi - range.lo);
    const a = makeAgent(rng, ARCHETYPES[0]);
    a.label = 'Cyclist';
    a.arch = { ...ARCHETYPES[0], key: 'cyclist', label: 'Cyclist' };
    a.mode = MODE.CYCLE;
    a.lane = lane;
    a.laneS = s;
    a.laneLo = range.lo;
    a.laneHi = range.hi;
    a.speed = 4.6 + rng() * 2.4;
    a.curSpeed = a.speed;
    a.bike = true;
    a.bikeHex = rng.pick(BIKE_COLORS);
    a.hipY = 0.74;
    a.lean = 0.44 + rng() * 0.16;
    a.hat = rng.chance(0.5);
    if (a.hat) { a.hatHex = rng.pick(HAT_COLORS); a.hatScale = 0.90; }
    a.bag = rng.chance(0.3);
    if (a.bag) a.bagHex = rng.pick(BAG_COLORS);
    // Both hands are on the bars. A phone in a cyclist's fist is a bug, not a
    // behaviour.
    a.items = null;
    a.phoneWalk = false;
    sampleCyclist(a, net);
    if (layout.isWater(a.x, a.z)) continue;
    agents.push(a);
  }
}

/* ============================================== furniture that already exists */

/**
 * Find every seat props.js actually built, and where its cushion is.
 *
 * People sitting NEXT to a bench instead of on it is the single most obvious
 * tell that a crowd was scattered rather than placed, so the seats are read
 * straight out of the shared prop pools rather than guessed from the layout.
 * `ctx.props` is handed to every module by worldBuild for exactly this kind of
 * cross-module question, and pedestrians run last, so the furniture is final.
 *
 * The numbers are the seat height and the seat run measured off props.js's own
 * geometry functions. They are a soft contract with that module: if a bench
 * gets taller the sitters float, which is why the audit checks them.
 */
const SEAT_KINDS = [
  //  key             seatY  halfRun  capacity  layout
  ['cafeChair', 0.47, 0.00, 1, 'chair'],
  ['benchSlat', 0.50, 0.60, 2, 'front'],
  ['benchBackless', 0.46, 0.54, 2, 'front'],
  ['benchConcrete', 0.56, 0.68, 2, 'front'],
  ['picnicTable', 0.49, 0.58, 4, 'picnic'],
];

/**
 * How busy the street is at an arbitrary point.
 *
 * Seats come out of the prop pools as bare coordinates with no block attached,
 * and "is this a spine café or a bench behind a warehouse" decides whether it
 * should be full or empty. A 48 m bucket grid over the block list answers it in
 * constant time and is built once.
 */
function makeLifeLookup(layout) {
  const CELL = 48;
  const grid = new Map();
  const key = (cx, cz) => (cx + 2048) * 4096 + (cz + 2048);
  for (const b of layout.blocks) {
    const x0 = Math.floor((b.x - b.w / 2) / CELL), x1 = Math.floor((b.x + b.w / 2) / CELL);
    const z0 = Math.floor((b.z - b.d / 2) / CELL), z1 = Math.floor((b.z + b.d / 2) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = key(cx, cz);
        const prev = grid.get(k);
        if (prev === undefined || (b.streetLife ?? 0) > prev) grid.set(k, b.streetLife ?? 0.35);
      }
    }
  }
  return (x, z) => grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL))) ?? 0.3;
}

const _eul = new THREE.Euler();
function slotYaw(pool, i) {
  const q = pool.slotRot[i];
  if (!q) return 0;
  return _eul.setFromQuaternion(q, 'YXZ').y;
}

function collectFurniture(ctx) {
  const out = { seats: [], tables: [], byBlock: new Map() };
  const pools = ctx.props && ctx.props.pools;
  if (!pools) return out;

  const tablePool = pools.get('cafeTable');
  if (tablePool) {
    for (let i = 0; i < tablePool.count; i++) {
      const p = tablePool.slotPos[i];
      out.tables.push({ x: p.x, y: p.y, z: p.z });
    }
  }

  for (const [key, seatY, halfRun, cap, kind] of SEAT_KINDS) {
    const pool = pools.get(key);
    if (!pool) continue;
    for (let i = 0; i < pool.count; i++) {
      const p = pool.slotPos[i];
      const yaw = slotYaw(pool, i);
      const cs = Math.cos(yaw), sn = Math.sin(yaw);
      for (let k = 0; k < cap; k++) {
        // Spread the sitters along the seat run, leaving a gap at each end so
        // nobody's hip hangs off the timber.
        let ox = cap > 1 ? (k / (cap - 1) - 0.5) * 2 * halfRun : 0;
        let oz = 0;
        let face = yaw;
        if (kind === 'picnic') {
          // Two benches either side of the table, everyone facing inward.
          const side = k < 2 ? 1 : -1;
          ox = ((k % 2) - 0.5) * 2 * halfRun;
          oz = side * 0.76;
          face = side > 0 ? yaw + Math.PI : yaw;
        }
        out.seats.push({
          key, kind, seatY,
          // local +x runs along the seat, local +z is the way the sitter faces
          x: p.x + cs * ox + sn * oz,
          y: p.y,
          z: p.z - sn * ox + cs * oz,
          yaw: face,
          taken: false,
        });
      }
    }
  }
  return out;
}

/** Café tables cluster; a terrace is a set of tables within a few metres. */
function tableClusters(furniture) {
  const left = furniture.tables.slice();
  const out = [];
  while (left.length) {
    const seed = left.pop();
    const group = [seed];
    for (let i = left.length - 1; i >= 0; i--) {
      const t = left[i];
      if (Math.hypot(t.x - seed.x, t.z - seed.z) < 7.5) { group.push(t); left.splice(i, 1); }
    }
    let cx = 0, cz = 0, cy = 0;
    for (const t of group) { cx += t.x; cz += t.z; cy += t.y; }
    out.push({ tables: group, x: cx / group.length, y: cy / group.length, z: cz / group.length });
  }
  return out;
}

/* ============================================================== seating === */

/**
 * Sit people on the furniture that is really there.
 *
 * Occupancy is weighted by how busy the street is, so a café on the spine is
 * three-quarters full and a bench on a service road has one person eating lunch
 * on it — which is the difference between a crowd that was placed and a crowd
 * that was sprinkled.
 */
function placeSeated(ctx, rng, furniture, agents, cap) {
  if (!furniture.seats.length) return;
  const lifeAt = makeLifeLookup(ctx.layout);
  let spent = 0;
  // Shuffle so the same chairs are not always the occupied ones, and bias café
  // chairs to the front of the queue — an empty terrace is the loudest "nobody
  // lives here" signal a street can send.
  const order = furniture.seats.map((s) => ({ s, k: rng() + (s.kind === 'chair' ? 0.45 : 0) }))
    .sort((p, q) => q.k - p.k);

  for (const { s } of order) {
    if (spent >= cap) break;
    if (s.taken) continue;
    const life = lifeAt(s.x, s.z);
    const want = s.kind === 'chair' ? 0.30 + life * 0.55 : 0.16 + life * 0.42;
    if (!rng.chance(want)) continue;

    const a = makeAgent(rng, pickArchetype(rng, false));
    s.taken = true;
    a.x = s.x; a.z = s.z; a.y = s.y;
    a.yaw = s.yaw + (rng() - 0.5) * 0.34;
    // The direction the SEAT points. A sitter's body is bolted to it; only the
    // shoulders and head are allowed to turn. See stepSit.
    a.seatYaw = a.yaw;
    a.mode = MODE.SIT;
    a.role = s.kind === 'chair' ? 'diner' : 'sitter';
    // hipY is measured from the SOLE and then scaled by the agent's height, so
    // it has to be divided back out or a tall person floats off the bench.
    a.hipY = s.seatY / a.size;
    a.sitSprawl = false;
    a.lean = 0.06 + rng() * 0.16;
    a.idleSeed = rng() * 100;
    // Somebody at a café table has a drink in front of them nine times in ten.
    if (s.kind === 'chair' && rng.chance(0.62)) {
      addItem(a, AT.HAND_R, 0.075, 0.105, 0.075, rng.pick(CUP_COLORS), 0);
    }
    agents.push(a);
    spent++;
  }

  // Pair adjacent sitters into conversations — two people on one bench who are
  // not looking at each other read as two strangers, which is a colder city.
  for (let i = agents.length - spent; i < agents.length - 1; i++) {
    const a = agents[i], b = agents[i + 1];
    if (!a || !b || a.mode !== MODE.SIT || b.mode !== MODE.SIT) continue;
    if (Math.hypot(a.x - b.x, a.z - b.z) < 1.5 && rng.chance(0.7)) {
      a.chatPartner = b; b.chatPartner = a;
    }
  }
}

/**
 * Café and restaurant life AROUND the tables: servers working the terrace,
 * a queue at the counter, and people standing about with a drink.
 */
function placeTerraceLife(ctx, rng, furniture, agents, cap) {
  const clusters = tableClusters(furniture);
  if (!clusters.length) return;
  const { layout } = ctx;
  let spent = 0;
  clusters.sort((a, b) => b.tables.length - a.tables.length);

  for (const cl of clusters) {
    if (spent >= cap) break;
    if (cl.tables.length < 2) continue;

    /* --- the server ----------------------------------------------------- */
    // A route through the tables and back to a pass point just off the
    // terrace: the walk between them is the whole behaviour.
    const route = [];
    for (const t of cl.tables.slice(0, 4)) {
      route.push({ x: t.x + (rng() - 0.5) * 0.9, z: t.z + (rng() - 0.5) * 0.9, wait: 1.6 + rng() * 2.8 });
    }
    // The pass: a spot two metres off the far side of the cluster, which is
    // where the door would be on a terrace this shape.
    const ang = rng() * Math.PI * 2;
    const px = cl.x + Math.cos(ang) * 2.6, pz = cl.z + Math.sin(ang) * 2.6;
    const doorOK = !layout.isWater(px, pz) && !layout.isRoad(px, pz);
    if (doorOK) {
      route.push({ x: px, z: pz, wait: 2.2 + rng() * 3.4 });
    }
    if (route.length >= 2) {
      const w = makeAgent(rng, ARCHETYPES[4]);       // server
      w.mode = MODE.SERVE;
      w.role = 'server';
      w.route = route;
      w.routeI = 0;
      w.wait = rng() * 2;
      w.x = route[0].x; w.z = route[0].z; w.y = cl.y;
      w.tx = w.x; w.tz = w.z;
      w.items = null;
      // A tray reads better than a hand: a flat panel held at chest height.
      addItem(w, AT.HAND_L, 0.28, 0.030, 0.34, PALETTE.SIGN_DARK, 0);
      agents.push(w);
      spent++;
    }

    /* --- a knot standing with a drink ------------------------------------ */
    const knot = rng.int(0, 3);
    for (let i = 0; i < knot && spent < cap; i++) {
      const aa = rng() * Math.PI * 2;
      const rr = 2.2 + rng() * 1.6;
      const x = cl.x + Math.cos(aa) * rr, z = cl.z + Math.sin(aa) * rr;
      if (layout.isWater(x, z) || layout.isRoad(x, z)) continue;
      const a = makeAgent(rng, pickArchetype(rng, false));
      a.x = x; a.z = z; a.y = cl.y;
      a.yaw = Math.atan2(cl.x - x, cl.z - z) + (rng() - 0.5) * 0.6;
      a.mode = MODE.IDLE;
      a.role = 'terrace';
      a.lean = 0.01 + rng() * 0.05;
      if (rng.chance(0.55)) addItem(a, AT.HAND_R, 0.075, 0.11, 0.075, rng.pick(CUP_COLORS), 0);
      agents.push(a);
      spent++;
      if (i > 0) {
        const prev = agents[agents.length - 2];
        if (prev.mode === MODE.IDLE) { prev.chatPartner = a; a.chatPartner = prev; }
      }
    }

    if (!doorOK) continue;

    /* --- the queue at the counter ---------------------------------------- */
    // The line runs back from the door ACROSS the terrace's outward direction,
    // so it hugs the frontage instead of walking out into the tables. Every
    // slot is a fixed point checked against the ground before anyone is put on
    // it, so a queue can never end up in the carriageway.
    const qux = -Math.sin(ang), quz = Math.cos(ang);   // perpendicular to the door normal
    const qLen = rng.weighted([[0, 26], [1, 26], [2, 26], [3, 22]]);
    for (let k = 0; k < qLen && spent < cap; k++) {
      const qx = px + qux * (0.95 + k * 0.78);
      const qz = pz + quz * (0.95 + k * 0.78);
      if (layout.isWater(qx, qz) || layout.isRoad(qx, qz)) break;
      const a = makeAgent(rng, pickArchetype(rng, false));
      a.x = qx; a.z = qz; a.y = cl.y;
      a.yaw = Math.atan2(px - qx, pz - qz);
      a.mode = MODE.IDLE;
      a.role = 'queuer';         // hands-in-front, shuffling stance
      a.lean = 0.01 + rng() * 0.04;
      a.idleSeed = rng() * 100;
      if (rng.chance(0.34)) addItem(a, AT.HAND_R, 0.078, 0.150, 0.019, rng.pick(PHONE_COLORS), 0.55);
      agents.push(a);
      spent++;
    }

    /* --- coming and going through the door -------------------------------- */
    // Two waypoints and a long dwell at each: the walk to the door, the pause
    // in it, the walk back out to the pavement. It reuses the server's route
    // loop because "someone repeatedly moving between two spots" is exactly
    // what that already is — the only difference is where and how long.
    const patrons = rng.weighted([[0, 34], [1, 40], [2, 26]]);
    for (let k = 0; k < patrons && spent < cap; k++) {
      const away = 3.6 + rng() * 2.4;
      const side = (rng() - 0.5) * 3.0;
      const ox = px + Math.cos(ang) * away + qux * side;
      const oz = pz + Math.sin(ang) * away + quz * side;
      if (layout.isWater(ox, oz) || layout.isRoad(ox, oz)) continue;
      const a = makeAgent(rng, pickArchetype(rng, false));
      a.mode = MODE.SERVE;
      a.role = 'patron';
      a.route = [
        // At the door: standing in it, i.e. arriving or on their way out.
        { x: px + qux * -0.55, z: pz + quz * -0.55, wait: 5 + rng() * 9 },
        { x: ox, z: oz, wait: 4 + rng() * 8 },
      ];
      a.routeI = rng.chance(0.5) ? 0 : 1;
      a.wait = rng() * 5;
      a.x = a.route[a.routeI].x; a.z = a.route[a.routeI].z; a.y = cl.y;
      a.tx = a.x; a.tz = a.z;
      agents.push(a);
      spent++;
    }
  }
}

/* =============================================================== venues === */

/**
 * Doors worth standing outside: a point on the building line of a busy retail
 * or low-rise frontage, with the outward normal that a doorman would face.
 *
 * Derived from the sidewalk loop rather than from the block rectangle, because
 * the loop is the ground people can actually stand on — a point computed from
 * b.w/2 lands inside the wall on any parcel that got a setback.
 */
function findVenues(ctx, rng, paths) {
  const { layout } = ctx;
  const out = [];
  for (const path of paths) {
    const b = path.block;
    const zone = b.zone;
    const nightly = zone === ZONE.RETAIL || zone === ZONE.LOWRISE
      || zone === ZONE.LANDMARK || zone === ZONE.MIDRISE;
    if (!nightly || b.streetLife < 0.46) continue;
    const r = makeRNG((b.seed ^ 0x7c31) >>> 0);
    const n = b.streetLife > 0.7 ? r.int(1, 3) : 1;
    for (let k = 0; k < n; k++) {
      const i = r.int(0, path.n - 1);
      const lx = path.px[i], lz = path.pz[i];
      // Inward = toward the block centre = toward the building face.
      let nx = b.x - lx, nz = b.z - lz;
      const len = Math.hypot(nx, nz) || 1;
      nx /= len; nz /= len;
      const dx = lx + nx * 1.5, dz = lz + nz * 1.5;
      if (layout.isWater(dx, dz) || layout.isRoad(dx, dz)) continue;
      // The queue runs along the frontage, i.e. perpendicular to the normal.
      out.push({
        x: dx, z: dz, y: ctx.Y_WALK,
        // Facing OUT of the door, which is what a doorman and a queue both do.
        yaw: Math.atan2(-nx, -nz),
        tx: -nz, tz: nx,
        life: b.streetLife,
        block: b,
        // The loop this door sits on, and how far round it — a queuer who is
        // out walking has to be able to find the way back.
        path, s: path.cum[i],
        stands: [],
      });
    }
  }
  // Busiest first: the budget should be spent where the cameras point.
  out.sort((a, b2) => b2.life - a.life);
  return out.slice(0, 34);
}

/**
 * Doormen, valets, arriving groups and the queue itself.
 *
 * The queue is what changes with the clock: every queuer is assigned a slot and
 * a personal "when do I go out" threshold, and at build time only the daytime
 * share of them is standing in it. The rest are ordinary walkers who peel off
 * the pavement as nightFactor rises. See the venue clock in updateSlow().
 */
function placeVenueLife(ctx, rng, venues, agents, yWalk, cap) {
  let spent = 0;
  // engine.js publishes nightFactor before buildWorld runs, so the city can be
  // built already at the right time of day instead of snapping to it on frame 1.
  const night = ctx.scene.userData.nightFactor ?? 0;
  for (const v of venues) {
    if (spent >= cap) break;

    /* --- doorman -------------------------------------------------------- */
    const d = makeAgent(rng, ARCH_DOORMAN);
    d.x = v.x + v.tx * 0.9; d.z = v.z + v.tz * 0.9; d.y = yWalk;
    d.yaw = v.yaw;
    d.mode = MODE.IDLE;
    d.role = 'doorman';
    d.lean = 0.01;
    d.items = null;
    d.venue = v;
    if (rng.chance(0.45)) { d.hat = true; d.hatHex = PALETTE.SIGN_DARK; d.hatScale = 0.88; }
    agents.push(d); spent++;

    /* --- valet at the kerb ---------------------------------------------- */
    if (v.life > 0.6 && rng.chance(0.5) && spent < cap) {
      const val = makeAgent(rng, ARCH_DOORMAN);
      // Out toward the kerb: v.yaw points out of the door, so +forward is the
      // road side.
      val.x = v.x + Math.sin(v.yaw) * 3.4;
      val.z = v.z + Math.cos(v.yaw) * 3.4;
      val.y = yWalk;
      val.yaw = v.yaw + Math.PI * 0.5;
      val.mode = MODE.IDLE;
      val.role = 'valet';
      val.overlay = true;
      val.overlayHex = PALETTE.FABRIC_CORAL;
      val.items = null;
      addItem(val, AT.HAND_R, 0.05, 0.05, 0.05, PALETTE.CHROME, 0);   // keys
      if (!ctx.layout.isWater(val.x, val.z)) { agents.push(val); spent++; }
    }

    /* --- club promoter -------------------------------------------------- */
    // Only after dark, and by the same mechanism as the queue: they walk the
    // frontage all day like anyone else and peel off to work the pavement when
    // the venue comes to life. See updateSlow for the migration.
    if (v.life > 0.5 && rng.chance(0.55) && spent < cap) {
      const pr = makeAgent(rng, ARCH_PROMOTER);
      pr.venue = v;
      pr.promoter = true;
      pr.nightAt = 0.34 + rng() * 0.14;
      pr.lean = 0.02;
      pr.idleSeed = rng() * 100;
      pr.items = null;
      // The stack of cards in the outstretched hand.
      addItem(pr, AT.HAND_R, 0.085, 0.055, 0.012, rng.pick([
        PALETTE.NEON_PINK, PALETTE.NEON_AQUA, PALETTE.FABRIC_SUN]), 0);
      pr.homePath = v.path;
      pr.homeS = v.s + (rng() - 0.5) * 22;
      // A couple of metres out from the door and turned along the pavement,
      // which is where you actually work a queue from.
      const m = promoterMark(v);
      if (night > pr.nightAt) {
        pr.x = m.x; pr.z = m.z; pr.y = yWalk;
        pr.yaw = v.yaw + Math.PI * 0.5;
        pr.mode = MODE.IDLE;
        pr.role = 'promoter';
      } else {
        joinPath(rng, pr, v.path, pr.homeS, rng.chance(0.5) ? 1 : -1);
        const sm = sampleLoop(v.path, pr.s, 0);
        pr.x = sm.x; pr.z = sm.z; pr.y = yWalk;
      }
      agents.push(pr);
      v.stands.push(pr);
      spent++;
    }

    /* --- the queue ------------------------------------------------------ */
    const len = Math.round(2 + v.life * 6);
    for (let k = 0; k < len && spent < cap; k++) {
      const a = makeAgent(rng, pickArchetype(rng, false));
      a.venue = v;
      a.queueK = k;
      a.role = 'queuer';
      // Personal threshold: the queue therefore GROWS through the evening
      // instead of appearing all at once at a magic hour.
      a.nightAt = 0.16 + (k / Math.max(1, len)) * 0.55 + rng() * 0.1;
      a.lean = 0.01 + rng() * 0.05;
      a.idleSeed = rng() * 100;
      a.phoneWalk = false;
      if (rng.chance(0.3)) addItem(a, AT.HAND_R, 0.078, 0.150, 0.019, rng.pick(PHONE_COLORS), 0.55);
      // Home is a stretch of the venue's own pavement, so the walk out to the
      // queue and back is always a few metres along the frontage, never a
      // straight line across the middle of the block.
      a.homePath = v.path;
      a.homeS = v.s + (rng() - 0.5) * 26;
      if (night > a.nightAt) {
        const q = venueSlot(v, k);
        a.x = q.x; a.z = q.z; a.y = yWalk;
        a.yaw = Math.atan2(v.x - a.x, v.z - a.z);
        a.mode = MODE.QUEUE;
      } else {
        joinPath(rng, a, v.path, a.homeS, rng.chance(0.5) ? 1 : -1);
        const sm = sampleLoop(v.path, a.s, 0);
        a.x = sm.x; a.z = sm.z; a.y = yWalk;
      }
      agents.push(a);
      v.stands.push(a);
      spent++;
    }
  }
}

/** Where a promoter works from: clear of the queue, across the footfall. */
function promoterMark(v) {
  return {
    x: v.x + v.tx * 1.6 + Math.sin(v.yaw) * 2.4,
    z: v.z + v.tz * 1.6 + Math.cos(v.yaw) * 2.4,
  };
}

/** Where the k-th person in a venue queue stands. */
function venueSlot(v, k) {
  // Serpentine rather than a straight 8 m line: a real queue folds against the
  // frontage, and a straight one walks off the end of the pavement.
  const row = Math.floor(k / 5);
  const i = k % 5;
  // The fold steps OUT toward the kerb, never back into the wall.
  return {
    x: v.x + v.tx * (1.9 + i * 0.82) + Math.sin(v.yaw) * (row * 0.95),
    z: v.z + v.tz * (1.9 + i * 0.82) + Math.cos(v.yaw) * (row * 0.95),
  };
}

/* ====================================================== content creators === */

/**
 * SHOOTS. The thing the brief actually asked for.
 *
 * A shoot is a presenter, a rig on the ground, and nought to three crew, put
 * where a real creator would film: the bay promenade, the riverwalk, a park, a
 * plaza, and outside the busiest restaurant frontages. The backdrop matters, so
 * the presenter always has their BACK to the view and the camera looks at them
 * across it — which also happens to be the framing that reads best from the
 * game's own 3/4 camera.
 *
 * The tripod and the light stand are registered consumables (they stand on the
 * pavement; the hole should be able to tip them over). The ring itself, the
 * boom and the reflector are carried or bolted, so they are accessories.
 */
function placeCreators(ctx, rng, paths, venues, agents, yWalk, shoots, cap) {
  const { layout } = ctx;
  const spots = [];

  for (const path of paths) {
    const b = path.block;
    const prom = b.bayfront || b.riverwalk;
    const green = b.zone === ZONE.PARK || b.zone === ZONE.PLAZA;
    const hot = b.streetLife > 0.58
      && (b.zone === ZONE.RETAIL || b.zone === ZONE.LOWRISE || b.zone === ZONE.LANDMARK);
    if (!prom && !green && !hot) continue;
    const r = makeRNG((b.seed ^ 0x2d19) >>> 0);
    // A shoot needs about 3 x 3 m of clear pavement, and props.js has already
    // claimed most of the good frontage, so each candidate gets several tries
    // at a position rather than one. One attempt rejected 19 shoots in 20 and
    // the whole feature came out as three creators in the entire city.
    const n = prom ? r.int(1, 2) : green ? r.int(1, 2) : (r.chance(0.55) ? 1 : 0);
    for (let k = 0; k < n; k++) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const i = r.int(0, path.n - 1);
        // Stand back from the kerb line so the rig is never in the carriageway.
        let nx = b.x - path.px[i], nz = b.z - path.pz[i];
        const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l;
        const off = green ? 4.0 + r() * 9 : 1.9 + r() * 1.6;
        const x = path.px[i] + nx * off, z = path.pz[i] + nz * off;
        if (!ctx.isFree(x, z, 0)) continue;
        spots.push({
          x, z,
          // The presenter looks back along the pavement, so the camera has the
          // street or the bay behind them.
          yaw: Math.atan2(-nx, -nz),
          kind: prom ? 'promenade' : green ? 'park' : 'street',
          life: b.streetLife,
        });
        break;
      }
    }
  }
  // A couple outside the hottest venues: creators film queues and doormen.
  for (const v of venues.slice(0, 10)) {
    if (rng.chance(0.4)) {
      spots.push({
        x: v.x + v.tx * -2.4, z: v.z + v.tz * -2.4,
        yaw: v.yaw + Math.PI, kind: 'venue', life: v.life,
      });
    }
  }

  let spent = 0;
  for (const sp of spots) {
    if (spent >= cap) break;
    if (layout.isWater(sp.x, sp.z) || layout.isRoad(sp.x, sp.z)) continue;
    if (!ctx.isFree(sp.x, sp.z, 0)) continue;
    ctx.occupy(sp.x, sp.z, 1.2);

    const cs = Math.cos(sp.yaw), sn = Math.sin(sp.yaw);
    // local +z is the way the presenter faces, i.e. toward the camera.
    const at = (fwd, side) => ({
      x: sp.x + sn * fwd + cs * side,
      z: sp.z + cs * fwd - sn * side,
    });

    const shoot = { x: sp.x, z: sp.z, y: yWalk, yaw: sp.yaw, rig: null, ring: null };

    /* --- the presenter --------------------------------------------------- */
    const p = makeAgent(rng, ARCH_CREATOR);
    p.x = sp.x; p.z = sp.z; p.y = yWalk;
    p.yaw = sp.yaw;
    p.mode = MODE.FILM;
    p.role = 'presenter';
    p.lean = 0.02 + rng() * 0.05;
    p.idleSeed = rng() * 100;
    p.items = null;
    // Half of them are talking into a hand mic, the rest gesture at the camera.
    if (rng.chance(0.45)) addItem(p, AT.HAND_R, 0.048, 0.19, 0.048, rng.pick(GEAR_DARK), -0.5);
    agents.push(p); spent++;

    /* --- the rig --------------------------------------------------------- */
    const solo = rng.chance(0.42);       // phone on a tripod, no operator
    const rigAt = at(2.05 + rng() * 0.5, (rng() - 0.5) * 0.5);
    // tripodGeo puts the lens on local -z, so a rig standing at the presenter's
    // yaw has the lens looking straight back down the line at them.
    shoot.rig = { x: rigAt.x, z: rigAt.z, y: yWalk, yaw: sp.yaw, head: 'camera' };
    ctx.occupy(rigAt.x, rigAt.z, 0.7);

    if (!solo) {
      const op = makeAgent(rng, ARCH_CREW);
      const opAt = at(2.85 + rng() * 0.4, (rng() - 0.5) * 0.4);
      op.x = opAt.x; op.z = opAt.z; op.y = yWalk;
      op.yaw = sp.yaw + Math.PI;
      op.mode = MODE.FILM;
      op.role = 'operator';
      op.idleSeed = rng() * 100;
      op.items = null;
      agents.push(op); spent++;
    }

    /* --- ring light ------------------------------------------------------ */
    if (rng.chance(0.62)) {
      const lAt = at(1.75 + rng() * 0.4, (rng.chance(0.5) ? 1 : -1) * (0.95 + rng() * 0.4));
      shoot.ring = {
        x: lAt.x, z: lAt.z, y: yWalk,
        yaw: Math.atan2(sp.x - lAt.x, sp.z - lAt.z),
        r: 0.36 + rng() * 0.12,
      };
      ctx.occupy(lAt.x, lAt.z, 0.7);
    }

    /* --- boom op --------------------------------------------------------- */
    if (!solo && rng.chance(0.42) && spent < cap) {
      const bm = makeAgent(rng, ARCH_CREW);
      const bAt = at(1.5 + rng() * 0.4, (rng.chance(0.5) ? 1 : -1) * (1.35 + rng() * 0.3));
      bm.x = bAt.x; bm.z = bAt.z; bm.y = yWalk;
      bm.yaw = Math.atan2(sp.x - bAt.x, sp.z - bAt.z);
      bm.mode = MODE.FILM;
      bm.role = 'boom';
      bm.idleSeed = rng() * 100;
      bm.items = null;
      addItem(bm, AT.BOOM, 0.030, 2.35, 0.030, PALETTE.CAR_GRAPHITE, 0);
      addItem(bm, AT.BOOM_MIC, 0.085, 0.30, 0.085, PALETTE.TAR_SEAM, 0);
      agents.push(bm); spent++;
    }

    /* --- reflector ------------------------------------------------------- */
    if (rng.chance(0.32) && spent < cap) {
      const rf = makeAgent(rng, ARCH_CREW);
      const rAt = at(1.25 + rng() * 0.4, (rng.chance(0.5) ? 1 : -1) * (1.5 + rng() * 0.3));
      rf.x = rAt.x; rf.z = rAt.z; rf.y = yWalk;
      rf.yaw = Math.atan2(sp.x - rAt.x, sp.z - rAt.z);
      rf.mode = MODE.FILM;
      rf.role = 'reflector';
      rf.idleSeed = rng() * 100;
      rf.items = null;
      addItem(rf, AT.PANEL, 0.66, 0.90, 0.020,
        rng.chance(0.5) ? PALETTE.CHROME : PALETTE.STUCCO_BUTTER, 0);
      agents.push(rf); spent++;
    }

    /* --- someone posing, someone shooting them --------------------------- */
    if (rng.chance(0.34) && spent < cap - 1) {
      const poseAt = at(-1.5 - rng() * 0.8, (rng.chance(0.5) ? 1 : -1) * (1.6 + rng()));
      const shotAt = at(-3.4 - rng() * 0.8, (rng() - 0.5) * 1.2);
      if (!layout.isRoad(poseAt.x, poseAt.z) && !layout.isRoad(shotAt.x, shotAt.z)) {
        const poser = makeAgent(rng, pickArchetype(rng, false));
        poser.x = poseAt.x; poser.z = poseAt.z; poser.y = yWalk;
        poser.yaw = Math.atan2(shotAt.x - poseAt.x, shotAt.z - poseAt.z);
        poser.mode = MODE.FILM;
        poser.role = 'poser';
        poser.idleSeed = rng() * 100;
        agents.push(poser);
        const shooter = makeAgent(rng, pickArchetype(rng, false));
        shooter.x = shotAt.x; shooter.z = shotAt.z; shooter.y = yWalk;
        shooter.yaw = Math.atan2(poseAt.x - shotAt.x, poseAt.z - shotAt.z);
        shooter.mode = MODE.FILM;
        shooter.role = 'shooter';
        shooter.idleSeed = rng() * 100;
        shooter.items = null;
        addItem(shooter, AT.HAND_R, 0.078, 0.150, 0.019, rng.pick(PHONE_COLORS), 0.2);
        agents.push(shooter);
        spent += 2;
      }
    }

    /* --- one or two people stopping to watch ----------------------------- */
    const watchers = rng.weighted([[0, 40], [1, 32], [2, 20], [3, 8]]);
    for (let k = 0; k < watchers && spent < cap; k++) {
      const wAt = at(-0.4 + rng() * 1.4, (rng.chance(0.5) ? 1 : -1) * (2.1 + rng() * 1.1));
      if (layout.isRoad(wAt.x, wAt.z) || layout.isWater(wAt.x, wAt.z)) continue;
      const w = makeAgent(rng, pickArchetype(rng, false));
      w.x = wAt.x; w.z = wAt.z; w.y = yWalk;
      w.yaw = Math.atan2(sp.x - wAt.x, sp.z - wAt.z);
      w.mode = MODE.IDLE;
      w.role = 'onlooker';
      w.idleSeed = rng() * 100;
      agents.push(w); spent++;
    }

    shoots.push(shoot);
  }
}

/**
 * Stand the camera tripods and light stands up as real consumables, and hang
 * the glowing ring off the light stands.
 */
function buildRigs(ctx, shoots, glowPool) {
  let g = 0;
  for (const s of shoots) {
    if (s.rig) {
      const c = ctx.addInstanced('filmTripod', () => ({
        geometry: tripodGeo('camera'),
        material: solid({
          color: 0xffffff, vertexColors: true, roughness: 0.44, metalness: 0.35,
          envMapIntensity: 0.9,
        }),
      }), {
        position: new THREE.Vector3(s.rig.x, s.rig.y, s.rig.z),
        rotationY: s.rig.yaw,
        capacity: 140,
        tier: ctx.TIER.SMALL,
        label: 'Camera Tripod',
        kind: 'tripod',
        debrisColor: PALETTE.CAR_GRAPHITE,
        score: 6,
      });
      s.rigC = c;
    }
    if (s.ring) {
      const c = ctx.addInstanced('filmLightStand', () => ({
        geometry: tripodGeo('light'),
        material: solid({
          color: 0xffffff, vertexColors: true, roughness: 0.44, metalness: 0.30,
          envMapIntensity: 0.9,
        }),
      }), {
        position: new THREE.Vector3(s.ring.x, s.ring.y, s.ring.z),
        rotationY: s.ring.yaw,
        capacity: 140,
        tier: ctx.TIER.SMALL,
        label: 'Ring Light',
        kind: 'lightstand',
        debrisColor: PALETTE.NEON_WHITE,
        score: 6,
      });
      s.ringC = c;
      s.glowSlot = g;
      setInstanceColor(glowPool, g, PALETTE.NEON_WHITE);
      // The ring sits on the yoke at the top of the stand; +z is the way the
      // stand faces, so the ring faces the presenter with it.
      // 1.78 m puts the ring centred between the yoke arms (1.61 - 1.81), which
      // is also roughly where a real one sits: just above the subject's eyes.
      poseInto(
        glowPool.instanceMatrix.array, g,
        s.ring.x, s.ring.y + 1.78, s.ring.z, s.ring.yaw, 1,
        0, 0, 0, 0, s.ring.r, s.ring.r, s.ring.r
      );
      g++;
    }
  }
  if (g) {
    glowPool.instanceColor.needsUpdate = true;
    glowPool.instanceMatrix.needsUpdate = true;
  }
}

/* ========================================================== street life === */

/**
 * THE LONG TAIL — docs/STREET_LIFE.md.
 *
 * A city is not only commuters. What separates Brickell from a crowd
 * simulation is the people who are not going anywhere: domino players, a
 * vendor with a blanket of sunglasses, someone asleep on a bench in the sun,
 * a preacher with an indifferent crowd, someone doing tai chi in the park at
 * an odd hour, a rough sleeper with their belongings in the shade behind a
 * block, a promoter outside a club at midnight.
 *
 * HOW THEY ARE TREATED. Exactly the same as everyone else: the same rig, the
 * same modelling standard, the same consumption contract, no exaggerated
 * silhouettes and no captions. A rough sleeper here is a person sitting down
 * with their things beside them, and their things are modelled with the same
 * care as a café table. Nothing in this section is a punchline.
 *
 * WHERE THEY GO. By plausibility, never evenly:
 *   · domino and chess at park and plaza tables
 *   · vendors where there is footfall — the promenade, the retail spine
 *   · buskers and preachers where there is room to stand and be seen
 *   · people resting in the QUIET parts: the shaded side of a block, the
 *     service frontage, the back of a lot. Explicitly not on the polished
 *     Brickell Avenue frontage, which is both where they are not in the real
 *     city and where putting them would read as set dressing.
 */
function placeStreetLife(ctx, rng, paths, furniture, field, agents, yWalk, props, cap) {
  const { layout } = ctx;
  let spent = 0;
  const clear = (x, z, r) => spotIsClear(field, x, z, r)
    && !layout.isWater(x, z) && !layout.isRoad(x, z);

  /**
   * Find standing room near a pavement loop.
   * `side` +1 walks in toward the building line, -1 out toward the kerb.
   */
  const pitch = (path, r, side, lo, hi, need) => {
    const b = path.block;
    for (let t = 0; t < 10; t++) {
      const i = r.int(0, path.n - 1);
      let nx = b.x - path.px[i], nz = b.z - path.pz[i];
      const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l;
      const off = (lo + r() * (hi - lo)) * side;
      const x = path.px[i] + nx * off, z = path.pz[i] + nz * off;
      if (!clear(x, z, need)) continue;
      return { x, z, nx, nz, yaw: Math.atan2(-nx * side, -nz * side) };
    }
    return null;
  };

  const person = (r, arch, x, z, yaw, mode, role) => {
    const a = makeAgent(r, arch);
    a.x = x; a.z = z; a.y = yWalk;
    a.yaw = yaw;
    a.mode = mode;
    a.role = role;
    a.idleSeed = r() * 100;
    a.items = null;
    agents.push(a); spent++;
    return a;
  };

  /* --- dominoes and chess at the park tables --------------------------- */
  // Real tables, not invented ones: four people round a table that is not
  // there is the "floating prop" failure with people in it.
  const tables = furniture.seats.filter((s) => s.kind === 'picnic' && !s.taken);
  const byTable = new Map();
  for (const s of tables) {
    const k = `${Math.round(s.x / 3)}:${Math.round(s.z / 3)}`;
    if (!byTable.has(k)) byTable.set(k, []);
    byTable.get(k).push(s);
  }
  // Sub-budget, deliberately. The city has ~90 usable park tables and a table
  // seats four with two watching, so a single unbounded pass at this feature
  // spends the WHOLE street-life budget on dominoes and leaves nothing for the
  // vendors, the preachers or anyone resting — which is exactly what happened
  // the first time it ran.
  const gameCap = Math.round(cap * 0.34);
  const groups = [...byTable.values()].filter((g) => g.length >= 2);
  for (const g of groups) {
    if (spent >= gameCap) break;
    const r = makeRNG(((Math.round(g[0].x) * 73856093) ^ (Math.round(g[0].z) * 19349663)) >>> 0);
    if (!r.chance(0.34)) continue;
    const game = r.chance(0.62) ? 'domino' : 'chess';
    const play = Math.min(g.length, r.int(2, 4));
    for (let k = 0; k < play; k++) {
      const s = g[k];
      s.taken = true;
      // Retirees, mostly. A guayabera and a wide hat is the Miami of it.
      const a = person(r, ARCH_PLAYER, s.x, s.z, s.yaw + (r() - 0.5) * 0.20,
        MODE.SIT, 'boardgame');
      a.hipY = s.seatY / a.size;
      a.seatYaw = a.yaw;
      a.sitSprawl = false;
      a.lean = 0.20 + r() * 0.10;
      if (r.chance(0.55)) { a.hat = true; a.hatHex = rng.pick(HAT_COLORS); a.hatScale = 1.18; }
      // The tile or the piece in their hand. Deliberately a HELD item and not
      // a prop on the table: a consumable resting on a 0.75 m table top audits
      // as a floating prop, and this reads better anyway — you can see who is
      // about to play.
      addItem(a, AT.HAND_R, game === 'domino' ? 0.030 : 0.036,
        game === 'domino' ? 0.062 : 0.070, 0.016,
        game === 'domino' ? PALETTE.FABRIC_WHITE : PALETTE.WOOD_DARK, 0);
      if (spent >= gameCap) break;
    }
    // Spectators. A domino game without anyone leaning over it is a chore.
    // Ringed on the TABLE, not on one of its seats: a seat is 0.8 m off-centre
    // and the ring drawn round it puts half the onlookers with their backs to
    // the game and the other half three metres up the path.
    let tx = 0, tz = 0;
    for (const s of g) { tx += s.x; tz += s.z; }
    tx /= g.length; tz /= g.length;
    const watch = r.weighted([[0, 32], [1, 34], [2, 24], [3, 10]]);
    for (let k = 0; k < watch && spent < gameCap; k++) {
      const ang = r() * Math.PI * 2, rad = 1.45 + r() * 0.45;
      const x = tx + Math.cos(ang) * rad, z = tz + Math.sin(ang) * rad;
      if (!clear(x, z, WALK_R)) continue;
      person(r, pickArchetype(r, false), x, z,
        Math.atan2(tx - x, tz - z), MODE.IDLE, 'spectator');
    }
  }

  /* --- everything that hangs off a pavement loop ------------------------ */
  for (const path of paths) {
    if (spent >= cap) break;
    const b = path.block;
    const r = makeRNG((b.seed ^ 0x7d31ab) >>> 0);
    const life = b.streetLife ?? 0.3;
    const green = b.zone === ZONE.PARK || b.zone === ZONE.PLAZA;
    const prom = b.bayfront || b.riverwalk;
    const busy = life > 0.52 || prom || green;
    const quiet = life < 0.46 && !prom;

    /* --- someone selling something off a blanket or a table ------------- */
    if (busy && r.chance(prom ? 0.30 : 0.17)) {
      const p = pitch(path, r, 1, 2.4, 4.2, 1.3);
      if (p) {
        const onTable = r.chance(0.45);
        // A table's tint drives its CLOTH and a blanket's drives its soft
        // goods; everything else on both is baked. Same reason the two draw
        // from different palettes — a lime-green tablecloth is a bad market
        // stall, a lime-green pile of shirts is an ordinary one.
        props.push({ kind: onTable ? 'streetTable' : 'streetMat', x: p.x, z: p.z, y: yWalk,
          yaw: p.yaw, hex: r.pick(onTable ? CLOTH_COLORS : GOODS_COLORS) });
        // Behind their own stock, facing the footfall.
        const bx = p.x - Math.sin(p.yaw) * (onTable ? 0.72 : 1.10);
        const bz = p.z - Math.cos(p.yaw) * (onTable ? 0.72 : 1.10);
        if (clear(bx, bz, WALK_R * 0.7)) {
          const a = person(r, ARCH_VENDOR, bx, bz, p.yaw, onTable ? MODE.IDLE : MODE.SIT, 'vendor');
          if (!onTable) {
            a.hipY = 0.415 / a.size;
            a.seatYaw = a.yaw;
            a.sitSprawl = false;
            a.lean = 0.14;
            addItem(a, AT.SEAT, 0.42 / a.size, 0.40 / a.size, 0.38 / a.size,
              PALETTE.WOOD_DECK, 0, 0.3, 0.20 / a.size);
          }
          if (r.chance(0.5)) {
            props.push({ kind: 'streetCooler', x: bx + Math.cos(p.yaw) * 0.85,
              z: bz - Math.sin(p.yaw) * 0.85, y: yWalk, yaw: p.yaw,
              hex: r.pick(COOLER_COLORS) });
          }
        }
        // Someone actually buying, half the time.
        if (r.chance(0.5)) {
          const cx = p.x + Math.sin(p.yaw) * 1.15, cz = p.z + Math.cos(p.yaw) * 1.15;
          if (clear(cx, cz, WALK_R)) {
            person(r, pickArchetype(r, false), cx, cz, p.yaw + Math.PI, MODE.IDLE, 'spectator');
          }
        }
      }
    }

    /* --- a preacher, and the crowd that is mostly not listening --------- */
    if ((green || prom || life > 0.62) && r.chance(0.10)) {
      const p = pitch(path, r, 1, 3.0, 6.0, 1.8);
      if (p) {
        const a = person(r, ARCH_SPEAKER, p.x, p.z, p.yaw, MODE.IDLE, 'preacher');
        addItem(a, AT.HAND_L, 0.13, 0.19, 0.045, PALETTE.WOOD_DARK, 0);
        // The crate goes BESIDE them, not under them. Standing a pedestrian on
        // a 40 cm prop puts their contact point 40 cm off the pavement, which
        // is the "floating prop" automatic failure with a person in it — and
        // the physics would then measure their support against thin air.
        const kx = p.x + Math.sin(p.yaw - 1.5) * 0.75;
        const kz = p.z + Math.cos(p.yaw - 1.5) * 0.75;
        if (clear(kx, kz, 0.35)) props.push({ kind: 'soapbox', x: kx, z: kz, y: yWalk, yaw: p.yaw });
        const crowd = r.int(1, 4);
        for (let k = 0; k < crowd && spent < cap; k++) {
          const ang = p.yaw + (k / crowd - 0.5) * 1.7 + (r() - 0.5) * 0.3;
          const rad = 2.2 + r() * 1.6;
          const x = p.x + Math.sin(ang) * rad, z = p.z + Math.cos(ang) * rad;
          if (!clear(x, z, WALK_R)) continue;
          // Indifferent as often as attentive — that is what makes it read.
          person(r, pickArchetype(r, false), x, z,
            Math.atan2(p.x - x, p.z - z) + (r() - 0.5) * 0.9,
            MODE.IDLE, r.chance(0.55) ? 'audience' : 'spectator');
        }
      }
    }

    /* --- tai chi / yoga on the grass at an odd hour --------------------- */
    if (green && r.chance(0.26)) {
      const n = r.int(1, 4);
      const cx = b.x + (r() - 0.5) * b.w * 0.4, cz = b.z + (r() - 0.5) * b.d * 0.4;
      const face = r() * Math.PI * 2;
      for (let k = 0; k < n && spent < cap; k++) {
        const x = cx + (k - (n - 1) / 2) * 1.9 + (r() - 0.5) * 0.4;
        const z = cz + (r() - 0.5) * 0.8;
        if (!clear(x, z, WALK_R)) continue;
        const a = person(r, ARCH_TAICHI, x, z, face, MODE.IDLE, 'taichi');
        a.idleSeed = k * 0.7;      // in loose unison, not in lockstep
      }
    }

    /* --- someone feeding the pigeons ------------------------------------ */
    if ((green || prom) && r.chance(0.22)) {
      const p = pitch(path, r, 1, 2.0, 5.0, 1.2);
      if (p) {
        const a = person(r, ARCH_RESIDENT, p.x, p.z, p.yaw, MODE.SIT, 'feeder');
        a.hipY = 0.42 / a.size;
        a.seatYaw = a.yaw;
        a.sitSprawl = false;
        a.lean = 0.10;
        addItem(a, AT.SEAT, 0.42 / a.size, 0.40 / a.size, 0.38 / a.size,
          PALETTE.WOOD_DECK, 0, 0, 0.20 / a.size);
        // Most of the birds in front of someone scattering crumbs are head
        // down; the ones at the back of the group are the ones watching.
        flock(props, r, p.x, p.z, yWalk, r.int(5, 8), 0.9, 1.8, 0.62);
      }
    }

    /* --- a flock on the paving with nobody feeding it -------------------- */
    // Pigeons are not a prop that belongs to a person. A plaza or a promenade
    // has them whether or not anyone is sitting there, and scattering them in
    // loose groups rather than singly is what makes them read as birds.
    if ((green || prom || life > 0.58) && r.chance(0.20)) {
      const p = pitch(path, r, 1, 1.6, 4.4, 1.0);
      if (p) flock(props, r, p.x, p.z, yWalk, r.int(5, 8), 0.4, 1.7, 0.5);
    }

    /* --- somebody having an argument with nobody ------------------------ */
    if (busy && r.chance(0.09)) {
      const p = pitch(path, r, 1, 1.9, 3.4, 0.9);
      if (p) person(r, pickArchetype(r, false), p.x, p.z, p.yaw, MODE.IDLE, 'arguer');
    }

    /* --- the quiet, out-of-the-way places ------------------------------- */
    // Concentrated where they actually are — the shaded side of a block, the
    // service frontage, the back of a lot — and never on the polished
    // Brickell Avenue face of a tower.
    if (quiet && r.chance(0.30)) {
      // Hard against the building line, out of the walking stream.
      const p = pitch(path, r, 1, 3.6, 5.4, 1.1);
      if (p) {
        const a = person(r, ARCH_RESTING, p.x, p.z, p.yaw + Math.PI, MODE.SIT, 'streetRest');
        // Sitting on the ground with their back to the wall. Uses the SAME
        // sprawl geometry the park sitters use — 0.288 is the solved hip height
        // that puts the heel on the pavement at every body scale — rather than
        // an invented pose, because an invented one puts the shoes through the
        // paving for exactly the people it would be worst to get wrong.
        a.hipY = SPRAWL_HIP + r() * 0.020;
        a.seatYaw = a.yaw;
        a.sitSprawl = true;
        a.lean = 0.05 + r() * 0.06;
        const bx = p.x + Math.sin(a.yaw + 1.5) * 0.95;
        const bz = p.z + Math.cos(a.yaw + 1.5) * 0.95;
        if (clear(bx, bz, 0.58)) {
          props.push({ kind: 'bedroll', x: bx, z: bz, y: yWalk, yaw: a.yaw,
            hex: r.pick(BEDDING_COLORS) });
        }
        if (r.chance(0.40)) {
          // Propped against the leg rather than standing free in front of them:
          // 45 cm out and canted 20 degrees off square is what a sign resting
          // on somebody actually does.
          const off = a.yaw + 0.55;
          const sx = p.x + Math.sin(off) * 0.46, sz = p.z + Math.cos(off) * 0.46;
          props.push({ kind: 'signCard', x: sx, z: sz, y: yWalk,
            yaw: a.yaw + 0.34, hex: r.pick(CARD_COLORS) });
        }
        if (r.chance(0.28)) {
          const tx = p.x + Math.sin(a.yaw - 1.5) * 1.15, tz = p.z + Math.cos(a.yaw - 1.5) * 1.15;
          if (clear(tx, tz, 0.6)) {
            props.push({ kind: 'trolley', x: tx, z: tz, y: yWalk, yaw: a.yaw + 1.57 });
          }
        }
        /* An outreach board a few metres along the same frontage, facing the
           footway so it can actually be read. Often, not always — a sign on
           every corner would be its own kind of untrue. */
        if (r.chance(0.55)) {
          const along = a.yaw + Math.PI / 2;
          const d = 3.2 + r() * 2.6;
          const ox = p.x + Math.sin(along) * d, oz = p.z + Math.cos(along) * d;
          if (clear(ox, oz, 0.7)) {
            props.push({ kind: 'outreachBoard', x: ox, z: oz, y: yWalk, yaw: a.yaw + Math.PI });
          }
        }
        // A dog, sometimes. Company, and the reason people stop.
        if (r.chance(0.20)) {
          giveDog(a, r);
        }
      }
    }
  }

  /* --- asleep on a bench in the sun ------------------------------------- */
  const benches = furniture.seats.filter((s) => s.kind !== 'chair' && s.kind !== 'picnic');
  for (const s of benches) {
    if (spent >= cap) break;
    if (s.taken) continue;
    if (!rng.chance(0.012)) continue;
    // The WHOLE bench, not one slot of it. A bench is authored as three or
    // four sitting positions along its run; claiming one and leaving the rest
    // open puts the next sitter inside the person already lying there.
    for (const o of benches) {
      if (Math.abs(o.x - s.x) < 1.3 && Math.abs(o.z - s.z) < 1.3) o.taken = true;
    }
    // Turned a quarter so their length runs ALONG the timber. `s.yaw` is the
    // direction a SITTER faces, which is across the bench; lying down that way
    // would put most of them in mid-air beside it.
    const along = s.yaw + (rng.chance(0.5) ? Math.PI / 2 : -Math.PI / 2);
    const a = person(rng, pickArchetype(rng, false), s.x, s.z, along, MODE.SIT, 'asleep');
    a.lying = true;
    a.hipY = s.seatY / a.size;
    a.seatYaw = along;
    a.lean = 1.34;                 // torso down along the seat
    if (rng.chance(0.5)) { a.hat = true; a.hatHex = rng.pick(HAT_COLORS); a.hatScale = 1.15; }
  }

  return spent;
}

/**
 * Stand the street-life kit up as real consumables.
 *
 * Same contract as everything else in the city: measured footprint, correct
 * ground contact, edible. One pool per kind, and every one of them small.
 */
const STREET_PROPS = {
  streetMat: { geo: vendorMatGeo, label: 'Street Vendor Mat', cap: 90, score: 6, tier: 'SMALL' },
  streetTable: { geo: foldTableGeo, label: 'Folding Table', cap: 90, score: 6, tier: 'SMALL' },
  streetCooler: { geo: coolerGeo, label: 'Drinks Cooler', cap: 90, score: 4, tier: 'TINY' },
  bedroll: { geo: bedrollGeo, label: 'Bedroll', cap: 140, score: 4, tier: 'TINY' },
  outreachBoard: { geo: outreachBoardGeo, label: 'Outreach Point', cap: 60, score: 6,
    tier: 'SMALL', debris: 0x1f6f5c },
  trolley: { geo: trolleyGeo, label: 'Trolley', cap: 90, score: 5, tier: 'SMALL',
    debris: PALETTE.STEEL_DARK },
  soapbox: { geo: crateGeo, label: 'Crate', cap: 90, score: 3, tier: 'TINY' },
  signCard: { geo: signCardGeo, label: 'Cardboard Sign', cap: 120, score: 2, tier: 'TINY',
    debris: CARD_BROWN },
  // Two poses in two pools. A flock in which every bird holds the same
  // attitude reads as one bird stamped out eight times, and the second draw
  // call is the cheapest fix there is.
  pigeon: { geo: () => pigeonGeo('stand'), label: 'Pigeon', cap: 240, score: 1, tier: 'TINY',
    debris: PIGEON_BODY },
  pigeonPeck: { geo: () => pigeonGeo('peck'), label: 'Pigeon', cap: 240, score: 1, tier: 'TINY',
    debris: PIGEON_BODY },
};

/**
 * A loose flock of pigeons around a point, mixing the two poses.
 *
 * `peckFrac` of them have their heads down. Every bird gets its own yaw, so a
 * group never lines up — the one thing that would instantly give away that
 * these are eight copies of two meshes.
 */
function flock(props, r, x, z, y, n, rMin, rSpan, peckFrac) {
  for (let k = 0; k < n; k++) {
    const ang = r() * Math.PI * 2;
    const rad = rMin + Math.sqrt(r()) * rSpan;
    props.push({
      kind: r.chance(peckFrac) ? 'pigeonPeck' : 'pigeon',
      x: x + Math.sin(ang) * rad, z: z + Math.cos(ang) * rad,
      y, yaw: r() * 6.28, hex: r.pick(PIGEON_COLORS),
    });
  }
}

/** Deterministic 0..1 from a world position. */
function jitter(x, z) {
  const h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return h - Math.floor(h);
}

function buildStreetProps(ctx, list) {
  const pos = new THREE.Vector3();
  let n = 0;
  for (const p of list) {
    const def = STREET_PROPS[p.kind];
    if (!def) continue;
    pos.set(p.x, p.y, p.z);
    const c = ctx.addInstanced(`street_${p.kind}`, () => ({
      geometry: def.geo(),
      material: solid({
        color: 0xffffff, vertexColors: true, roughness: 0.80, metalness: 0.0,
        envMapIntensity: 0.45,
      }),
    }), {
      position: pos,
      rotationY: p.yaw,
      // ANTI-REPETITION: a hashed size wobble per piece, so a row of vendor
      // tables is not a row of identical vendor tables.
      scale: (def.scale ?? 1) * (0.90 + jitter(p.x, p.z) * 0.20),
      hex: p.hex ?? STREET_HEX[p.kind] ?? PALETTE.FABRIC_WHITE,
      capacity: def.cap,
      tier: ctx.TIER[def.tier],
      label: def.label,
      kind: p.kind,
      // The tint is not always the colour of the prop any more — a pigeon is
      // tinted near-white and painted blue-grey — so debris takes the kind's
      // own colour where one is declared.
      debrisColor: def.debris ?? p.hex ?? STREET_HEX[p.kind] ?? PALETTE.FABRIC_WHITE,
      score: def.score,
      castShadow: true,
    });
    if (c) n++;
  }
  return n;
}

/* ============================================================== buskers === */

/** A singer or a bucket drummer with a small ring of people watching. */
function placeBuskers(ctx, rng, paths, agents, yWalk, cap) {
  const { layout } = ctx;
  let spent = 0;
  const cands = paths.filter((p) => {
    const b = p.block;
    return b.streetLife > 0.55 || b.zone === ZONE.PLAZA || b.zone === ZONE.PARK
      || b.bayfront || b.riverwalk;
  });
  for (const path of cands) {
    if (spent >= cap) break;
    const b = path.block;
    const r = makeRNG((b.seed ^ 0x41b7) >>> 0);
    // Tuned against the census, not guessed: 0.26 landed 6 pitches across the
    // whole city once placement started succeeding at all, which is too few for
    // a promenade and a plaza to both have one.
    if (!r.chance(0.38)) continue;
    // SEVERAL TRIES AT A PITCH, not one. A busker wants exactly the ground
    // props.js wants — the busy frontage two metres in from the kerb — and it
    // gets there first. With a single attempt the whole feature placed zero
    // buskers in the entire city; this is the same fix placeCreators already
    // carries, for the same reason.
    let bx = 0, bz = 0, nx = 0, nz = 0, found = false;
    for (let attempt = 0; attempt < 8 && !found; attempt++) {
      const i = r.int(0, path.n - 1);
      nx = b.x - path.px[i]; nz = b.z - path.pz[i];
      const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l;
      // Widen the search as attempts fail: a plaza or a lawn has clear ground
      // further in, and that is where a pitch with room for an audience is.
      const off = 2.2 + r() * (1.6 + attempt * 0.9);
      bx = path.px[i] + nx * off;
      bz = path.pz[i] + nz * off;
      found = !layout.isWater(bx, bz) && !layout.isRoad(bx, bz) && ctx.isFree(bx, bz, 0);
    }
    if (!found) continue;
    ctx.occupy(bx, bz, 1.4);

    const drummer = r.chance(0.45);
    const a = makeAgent(r, ARCH_BUSKER);
    a.x = bx; a.z = bz; a.y = yWalk;
    a.yaw = Math.atan2(-nx, -nz);
    a.role = drummer ? 'drummer' : 'singer';
    a.items = null;
    a.idleSeed = r() * 100;
    if (drummer) {
      a.mode = MODE.SIT;
      a.hipY = 0.44 / a.size;
      a.sitSprawl = false;
      a.seatYaw = a.yaw;
      a.lean = 0.16;
      addItem(a, AT.DRUM, 0.34, 0.42, 0.34, r.pick([PALETTE.BIN_BLUE, PALETTE.BIN_GREY, PALETTE.CAR_WHITE]), 0);
      // The crate they are sitting ON. Without it a bucket drummer's hips hang
      // 44 cm above the pavement with nothing underneath. Item geometry is
      // scaled by the body, so world metres are divided back out here.
      addItem(a, AT.SEAT, 0.42 / a.size, 0.415 / a.size, 0.38 / a.size,
        r.pick([PALETTE.WOOD_DECK, PALETTE.BIN_GREY, PALETTE.WOOD_DARK]), 0, 0.4,
        0.2075 / a.size);
    } else {
      a.mode = MODE.FILM;              // stands and performs; same pose family
      a.role = 'singer';
      a.lean = 0.05;
      addItem(a, AT.HAND_R, 0.045, 0.18, 0.045, PALETTE.SIGN_DARK, -0.75);
    }
    agents.push(a); spent++;

    const crowd = r.int(1, 4);
    for (let k = 0; k < crowd && spent < cap; k++) {
      const ang = a.yaw + (k / crowd - 0.5) * 2.0 + (r() - 0.5) * 0.4;
      const rad = 1.9 + r() * 1.5;
      const x = bx + Math.sin(ang) * rad, z = bz + Math.cos(ang) * rad;
      if (layout.isWater(x, z) || layout.isRoad(x, z)) continue;
      const w = makeAgent(r, pickArchetype(r, false));
      w.x = x; w.z = z; w.y = yWalk;
      w.yaw = Math.atan2(bx - x, bz - z);
      w.mode = MODE.IDLE;
      w.role = 'audience';
      w.idleSeed = r() * 100;
      if (r.chance(0.28)) addItem(w, AT.HAND_R, 0.078, 0.150, 0.019, r.pick(PHONE_COLORS), 0.3);
      agents.push(w); spent++;
    }
  }
}

/* ============================================================== families === */

/**
 * Attach children to adults already walking. A child is a normal agent locked
 * to the adult's frame, so it never drifts, never has to path-find, and stops
 * dead when the adult stops.
 */
/**
 * People on and around the basketball courts.
 *
 * The courts are real rectangles reserved in cityLayout and built by props.js,
 * which hands their footprints over on `ctx.courts`. Everyone here is staged
 * against those coordinates, so nobody stands inside the fence line or on a
 * hoop's footing.
 *
 * HONEST LIMIT: there is no dribble or shoot animation in this rig, so players
 * use the standing idle. They are positioned as a game though — two loose
 * teams spread between the keys rather than a ring of people facing nowhere —
 * which is what actually reads as a game from the air.
 */
function placeCourtLife(ctx, rng, agents, yWalk, cap) {
  const courts = ctx.courts || [];
  if (!courts.length) return 0;
  let spent = 0;

  for (const c of courts) {
    if (spent >= cap) break;
    const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
    const X = (lx, lz) => c.x + lx * cs + lz * sn;
    const Z = (lx, lz) => c.z - lx * sn + lz * cs;
    const y = Number.isFinite(c.y) ? c.y : yWalk;

    const mk = (arch, lx, lz, faceLx, faceLz, mode) => {
      if (spent >= cap) return null;
      const a = makeAgent(rng, arch);
      a.x = X(lx, lz); a.z = Z(lx, lz); a.y = y;
      // Face a point in court space, converted to a world yaw.
      const wx = X(faceLx, faceLz) - a.x, wz = Z(faceLx, faceLz) - a.z;
      a.yaw = Math.atan2(wx, wz);
      a.mode = mode;
      a.role = 'court';
      a.idleSeed = rng() * 100;
      a.items = null;
      a.phoneWalk = false;
      agents.push(a); spent++;
      return a;
    };

    /* --- the game. Two loose teams, weighted toward one end the way a real
       half-court game is, everyone facing the live basket. --- */
    const live = rng.chance(0.5) ? 1 : -1;          // which basket is in play
    const hoopLx = live * (c.w / 2 - 1.6);
    const n = 6 + Math.floor(rng() * 5);            // 6-10 on court
    for (let i = 0; i < n; i++) {
      // Clustered around the live key, with one or two hanging back.
      const back = i >= n - 2;
      const lx = back
        ? -live * (2 + rng() * (c.w * 0.22))
        : live * (c.w * 0.18 + rng() * (c.w * 0.26));
      const lz = (rng() - 0.5) * (c.d * 0.62);
      const a = mk(ARCH_BALLER, lx, lz, hoopLx, 0, MODE.IDLE);
      if (a) a.size = 0.98 + rng() * 0.10;          // taller on average
    }

    /* --- watching. Along the touchline inside the fence, facing the court. */
    const w = 3 + Math.floor(rng() * 5);
    for (let i = 0; i < w; i++) {
      const side = rng.chance(0.62) ? -1 : 1;
      const lz = side * (c.d / 2 + 0.9 + rng() * 0.9);
      const lx = (rng() - 0.5) * (c.w * 0.8);
      mk(ARCH_COURTSIDE, lx, lz, lx, 0, MODE.IDLE);
    }
  }
  return spent;
}

function placeChildren(ctx, rng, agents, cap) {
  const adults = [];
  for (const a of agents) {
    if (a.mode !== MODE.WALK || a.arch.key === 'jogger' || a.board || a.bike) continue;
    if (a.escortCount) continue;
    adults.push(a);
  }
  if (!adults.length) return;
  let spent = 0;
  for (let i = 0; i < adults.length && spent < cap; i++) {
    const ad = adults[i];
    if (!rng.chance(0.16)) continue;
    const n = rng.chance(0.25) ? 2 : 1;
    for (let k = 0; k < n && spent < cap; k++) {
      const c = makeAgent(rng, ARCH_CHILD);
      c.size = 0.56 + rng() * 0.16;
      c.mode = MODE.ESCORT;
      c.escort = ad;
      c.escortSide = (k === 0 ? 1 : -1) * (rng.chance(0.5) ? 1 : -1);
      c.escortOff = 0.42 + rng() * 0.18;
      c.escortBack = 0.05 + rng() * 0.3;
      c.speed = ad.speed;
      c.x = ad.x; c.z = ad.z; c.y = ad.y;
      c.yaw = ad.yaw;
      c.items = null;
      c.phoneWalk = false;
      agents.push(c);
      spent++;
    }
    ad.escortCount = n;
    // A parent with a child in tow does not stride.
    ad.speed = Math.min(ad.speed, 1.15);
  }
}

/* =========================================================== consumables === */

/**
 * Give every agent a registry entry backed by a merged-body pool, and park that
 * pool where it cannot be seen until the hole actually takes someone.
 *
 * TWO THINGS KEEP IT INVISIBLE, and both are load-bearing:
 *
 *  1. Every slot's live matrix is collapsed (`pool.hide`), so the mesh draws
 *     nothing while its 1,400 people are walking about as animated parts.
 *  2. Pool VISIBILITY is refcounted, so a crowd with nobody falling costs zero
 *     draw calls rather than six, and — the part that matters — the
 *     `pool.restore()` the respawner performs 30 s after a swallow lands on a
 *     mesh that is not being drawn. Without that, every respawning pedestrian
 *     would flash up for a frame as a rigid arms-in-the-air doll.
 *
 * The AUTHORED transform is deliberately left correct. It is what the consume
 * system measures the fall against and what tools/prop-audit reads to check the
 * declared physics against the real mesh; zeroing it to force invisibility
 * would make both of them lie.
 *
 * WHY THE POOLS ARE SMALL (docs/PERF_FINDINGS.md, win 2)
 * -----------------------------------------------------
 * An InstancedMesh pays vertex cost for its whole `count`, not for the
 * instances that happen to be visible. One pool of 831 people therefore cost
 * 160 k triangles the instant a SINGLE person fell into a hole — and late game,
 * with a hole eating a pavement, that is exactly when the frame is busiest.
 *
 * The obvious fix is a small pool leased on demand, but that breaks the
 * gameplay contract outright: the object that falls has to BE the placed
 * instance, and a leased slot is a copy standing in for it. So the pool is cut
 * into fixed BUCKETS instead. Each person keeps their own permanent slot — the
 * registry entry, the authored transform and the respawn all behave exactly as
 * before — but only the ~64-person bucket containing someone who is actually
 * falling is ever drawn. Same contract, a thirteenth of the triangles.
 *
 * Consecutive agents are also spatially close (the walker placer fills one
 * pavement loop at a time), so a hole swallowing a group tends to light up one
 * bucket rather than ten.
 *
 * @returns {Map<InstancedProp, {n:number}>} the refcount table
 */
const FALL_BUCKET = 64;

function registerConsumables(ctx, agents, rng) {
  const variants = new Map();
  const fallPools = new Map();

  const claim = (c) => {
    if (!c) return;
    const pool = c.pool;
    pool.hide(c.slot);
    if (!fallPools.has(pool)) { fallPools.set(pool, { n: 0 }); pool.mesh.visible = false; }
  };

  const poolFor = (a) => {
    // Four colourways so the crowd going down the hole is not four hundred
    // identical dolls, without paying for a per-agent material.
    const family = a.bike ? 'cycle'
      : a.overlay ? 'hivis'
        : a.arch.key === 'tourist' ? 'tourist'
          : a.arch.key === 'office' ? 'office' : 'casual';
    if (!variants.has(family)) {
      const spec = {
        casual: [PALETTE.WOOD_LIGHT, PALETTE.TAR_SEAM, PALETTE.FABRIC_AQUA, PALETTE.CAR_NAVY],
        office: [PALETTE.STUCCO_PEACH, PALETTE.WOOD_DARK, PALETTE.STUCCO_WHITE, PALETTE.STEEL_DARK],
        tourist: [PALETTE.SAND, PALETTE.STUCCO_BUTTER, PALETTE.NEON_PINK, PALETTE.CAR_WHITE],
        hivis: [PALETTE.PALM_TRUNK, PALETTE.TAR_SEAM, PALETTE.NEON_YELLOW, PALETTE.CAR_GRAPHITE],
        cycle: [PALETTE.PALM_TRUNK_DARK, PALETTE.TAR_SEAM, PALETTE.NEON_AQUA, PALETTE.CAR_GRAPHITE],
      }[family];
      let geo = null;
      variants.set(family, {
        family,
        n: 0,
        // One BufferGeometry shared by every bucket of this family: the buckets
        // exist to shrink the DRAW, not to duplicate the mesh.
        geo: () => (geo ||= fallBodyGeo(
          spec[0], spec[1], spec[2], spec[3], family === 'cycle', PALETTE.CAR_TEAL)),
      });
    }
    return variants.get(family);
  };

  const pos = new THREE.Vector3();
  for (const a of agents) {
    const v = poolFor(a);
    const key = `pedFall_${v.family}_${(v.n++ / FALL_BUCKET) | 0}`;
    pos.set(a.x, a.y, a.z);
    const c = ctx.addInstanced(key, () => ({
      geometry: v.geo(),
      material: solid({
        color: 0xffffff, vertexColors: true, roughness: 0.78, metalness: 0.0,
        envMapIntensity: 0.45,
      }),
    }), {
      position: pos,
      rotationY: a.yaw,
      scale: a.size,
      capacity: FALL_BUCKET,
      tier: a.bike ? TIER.MEDIUM : TIER.SMALL,
      radius: a.bike ? 0.75 : 0.36,
      height: BODY_H * a.size,
      label: a.label,
      kind: 'pedestrian',
      dynamic: true,
      castShadow: false,
      receiveShadow: false,
      debrisColor: a.top,
      score: a.bike ? 7 : 4,
    });
    if (!c) continue;
    a.c = c;
    a.pool = c.pool;
    a.slot = c.slot;
    claim(c);
  }

  // A dog is its own snack.
  for (const a of agents) {
    if (!a.dog) continue;
    pos.set(a.x + 0.9, a.y, a.z);
    // One pool per breed, so the animal that tips into the pit is the animal
    // that was standing there — the same contract every other prop has.
    const breed = DOG_BREEDS[a.dogBreed];
    const c = ctx.addInstanced(`pedFall_dog_${breed}`, () => ({
      geometry: paintGeo(dogGeo(breed), PALETTE.PALM_TRUNK),
      material: solid({
        color: 0xffffff, vertexColors: true, roughness: 0.8, metalness: 0.0,
      }),
    }), {
      position: pos,
      capacity: 60,
      tier: TIER.SMALL,
      // Matches what poseAgent draws, or the hole eats a different-sized dog.
      scale: a.size * a.dogScale,
      label: 'Small Dog',
      kind: 'dog',
      dynamic: true,
      castShadow: false,
      receiveShadow: false,
      debrisColor: a.dogHex,
      score: 3,
    });
    if (!c) continue;
    a.dogC = c;
    claim(c);
  }
  return fallPools;
}

/**
 * Hand a body over to the consume system, or take it back.
 *
 * Refcounted because one pool serves hundreds of people and any number of them
 * can be in the pit at once. Releasing also collapses the slot, so the merged
 * body vanishes the same frame the animated one reappears.
 */
function setFallBodyLive(st, c, on) {
  if (!c || !c.pool || c.slot < 0) return;
  const rec = st.fallPools.get(c.pool);
  if (!rec) return;
  if ((c._pedLive === true) === on) return;
  c._pedLive = on;
  if (!on) c.pool.hide(c.slot);
  rec.n += on ? 1 : -1;
  if (rec.n < 0) rec.n = 0;
  c.pool.mesh.visible = rec.n > 0;
}

/**
 * The same handover, for the dog on the end of the lead.
 *
 * Kept separate from the owner's because the two are independent consumables
 * with independent states — the hole can take either one first — and because
 * this has to run on every tick of the owner's life cycle, including the ticks
 * where the owner themselves is in the pit.
 */
function stepDogHandover(st, a) {
  const ds = a.dogC.state;
  setFallBodyLive(st, a.dogC, ds === 1 || ds === 2);
  if (ds >= 1 && !a.dogHeld) { a.dogHeld = true; hideDog(st, a); }
  else if (ds === 0) a.dogHeld = false;
}

/* ================================================================ update === */

/**
 * LOD bands, measured from the camera's look-at. Inside NEAR everyone is
 * simulated and re-posed every frame; out to MID at ~28 Hz; beyond that ~10 Hz.
 * A 5-pixel figure animating at 10 Hz is indistinguishable from 60, and the
 * saving is most of the crowd's frame cost on a wide shot.
 */
const NEAR2 = 75 * 75;
const MID2 = 190 * 190;
/**
 * Past this the whole person is under two pixels even on the widest preset, so
 * the instance is collapsed to a zero matrix. Worth doing: 1,180 agents of
 * ~180 triangles is a fifth of a million triangles that would otherwise be
 * rasterised into aliasing noise on the menu-hero shot.
 */
const CULL2 = 420 * 420;

function updateCrowd(st, dt) {
  if (dt <= 0) dt = 1 / 60;
  st.time += dt;

  resolveFocus(st);
  st.holeT += dt;
  if (st.holeT > 0.4) { st.holeT = 0; collectHoles(st); }

  st.slowT += dt;
  if (st.slowT > 0.25) { updateSlow(st, st.slowT); st.slowT = 0; }

  const { agents, P } = st;
  const fx = st.focus.x, fz = st.focus.z;

  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];

    // A dog is its own consumable and OUTLIVES ITS OWNER, so its handover has
    // to run before the owner's — every branch below `continue`s, and a dog
    // whose owner went down the hole first would then never get handed over:
    // its animated instance stayed frozen on the pavement while the merged body
    // fell invisibly, which is the vanishing bug this module exists to not have.
    if (a.dogC) stepDogHandover(st, a);

    /* ---- who owns this body? -------------------------------------------
     * Exactly the handover vehicles.js performs. WOBBLE means the hole has
     * taken ground from under them: from that moment the consume system owns
     * the transform, we collapse the ten animated parts, and the merged fall
     * body — the object the registry has always held — becomes the visible
     * one. Come back at IDLE and they stand up again.
     */
    const c = a.c;
    if (c) {
      if (c.state >= 1 && c.state <= 2) {
        if (!a.held) {
          a.held = true;
          a.dead = true;
          detachPath(a);
          a.crossing = null;
          // The dog is left standing: it is its own consumable and the hole
          // takes it a moment later, on its own terms.
          hideAgent(st, a, i, false);
          setFallBodyLive(st, c, true);
        }
        continue;
      }
      if (c.state === 3) {                 // GONE: below the world, awaiting respawn
        if (!a.dead) { a.dead = true; detachPath(a); hideAgent(st, a, i, false); }
        if (a.held) { a.held = false; setFallBodyLive(st, c, false); }
        continue;
      }
      // IDLE. Either they were never touched, or the hole moved off, or the
      // respawner has just put them back on the pavement.
      if (a.held || a.dead) {
        a.held = false;
        setFallBodyLive(st, c, false);
        reviveAgent(st, a);
      }
    } else if (a.dead) {
      continue;
    }

    const dx = a.x - fx, dz = a.z - fz;
    const d2 = st.noFocus ? 0 : dx * dx + dz * dz;
    if (d2 > CULL2) {
      if (!a.culled) { a.culled = true; hideAgent(st, a, i); }
      continue;
    }
    a.culled = false;
    // Far agents still walk, just in coarser steps. Nothing teleports, so the
    // only artefact is a slightly lower animation frequency 250 m away.
    const interval = d2 < NEAR2 ? 0 : d2 < MID2 ? 1 / 28 : 1 / 10;
    a.acc += dt;
    if (a.acc < interval) continue;
    const sdt = a.acc > 0.34 ? 0.34 : a.acc;
    a.acc = 0;

    panicCheck(st, a, sdt);

    switch (a.mode) {
      case MODE.WALK: stepWalk(st, a, sdt); break;
      case MODE.APPROACH: stepApproach(st, a, sdt); break;
      case MODE.WAIT: stepWait(st, a, sdt); break;
      case MODE.CROSS: stepCross(st, a, sdt); break;
      case MODE.CYCLE: stepCycle(st, a, sdt); break;
      case MODE.SIT: stepSit(st, a, sdt); break;
      case MODE.FLEE: stepFlee(st, a, sdt); break;
      case MODE.RETURN: stepReturn(st, a, sdt); break;
      case MODE.GAZE: stepGaze(st, a, sdt); break;
      case MODE.QUEUE: stepQueue(st, a, sdt); break;
      case MODE.SERVE: stepServe(st, a, sdt); break;
      case MODE.ESCORT: stepEscort(st, a, sdt); break;
      case MODE.GOTO: stepGoto(st, a, sdt); break;
      case MODE.FILM: stepFilm(st, a, sdt); break;
      default: stepIdle(st, a, sdt); break;
    }

    poseAgent(st, a, i);

    if (c) {
      c.position.x = a.x; c.position.y = a.y; c.position.z = a.z;
      const sp = a.pool.slotPos[a.slot];
      if (sp) sp.set(a.x, a.y, a.z);
      const sr = a.pool.slotRot[a.slot];
      if (sr) sr.set(0, Math.sin(a.yaw * 0.5), 0, Math.cos(a.yaw * 0.5));
      st.registry.rehash(c);
    }
    if (a.dogC) {
      a.dogC.position.x = a.dogX; a.dogC.position.z = a.dogZ;
      const sp = a.dogC.pool.slotPos[a.dogC.slot];
      if (sp) sp.set(a.dogX, a.y, a.dogZ);
      st.registry.rehash(a.dogC);
    }
  }

  for (const k in P) {
    // The ring lights are bolted to the ground: uploading 40 unchanged matrices
    // every frame for the rest of the match is the kind of free cost that adds
    // up across seven modules doing the same thing.
    if (k === 'glow') {
      if (!st.glowDirty) continue;
      st.glowDirty = false;
    }
    P[k].instanceMatrix.needsUpdate = true;
  }
}

/* ---------------------------------------------------------- slow tick --- */

/**
 * Everything that only has to be right a few times a second.
 *
 * DAY/NIGHT: engine.js owns the cycle and publishes nightFactor; this module
 * only reads it. Two things respond — the ring lights come up as the sun goes
 * down, and the venue queues fill. The queues are the interesting one: each
 * queuer carries their own threshold, so the line outside a club GROWS through
 * the evening and drains through the small hours instead of teleporting into
 * existence at some magic hour.
 */
function updateSlow(st, dt) {
  const night = st.scene.userData.nightFactor ?? 0;
  st.night = night;

  // A ring light is on in daylight too — that is rather the point of one — but
  // it only reads as a light source once the sun is off it.
  if (st.matGlow) st.matGlow.emissiveIntensity = 0.22 + night * night * 2.9;

  /* --- pull the ring off any stand that is being eaten ------------------ */
  const P = st.P;
  for (const s of st.shoots) {
    if (s.glowSlot === undefined) continue;
    const live = !s.ringC || s.ringC.state === 0;
    if (live === s.glowOn) continue;
    s.glowOn = live;
    st.glowDirty = true;
    if (live) {
      poseInto(
        P.glow.instanceMatrix.array, s.glowSlot,
        s.ring.x, s.ring.y + 1.78, s.ring.z, s.ring.yaw, 1,
        0, 0, 0, 0, s.ring.r, s.ring.r, s.ring.r
      );
    } else {
      clearInstance(P.glow.instanceMatrix.array, s.glowSlot);
    }
  }

  /* --- the venue clock -------------------------------------------------- */
  for (const v of st.venues) {
    for (const a of v.stands) {
      if (a.dead || a.mode === MODE.FLEE || a.mode === MODE.RETURN) continue;
      const wants = night > a.nightAt;

      /* --- the promoter works the pavement, they do not join the queue --- */
      if (a.promoter) {
        const onStation = a.role === 'promoter';
        const heading = a.mode === MODE.GOTO && a.thenMode === MODE.IDLE;
        if (wants && !onStation && !heading && a.mode === MODE.WALK) {
          const m = promoterMark(v);
          detachPath(a);
          a.tx = m.x; a.tz = m.z;
          a.mode = MODE.GOTO;
          a.thenMode = MODE.IDLE;
          a.thenRole = 'promoter';
        } else if (!wants && (onStation || heading) && a.homePath) {
          const sm = sampleLoop(a.homePath, a.homeS, 0);
          a.role = null;
          a.thenRole = null;
          a.mode = MODE.GOTO;
          a.thenMode = MODE.WALK;
          a.tx = sm.x; a.tz = sm.z;
        }
        continue;
      }

      const inLine = a.mode === MODE.QUEUE || (a.mode === MODE.GOTO && a.thenMode === MODE.QUEUE);
      // Only peel off when they are already near the door. GOTO walks in a
      // straight line, and a straight line from the far side of a block goes
      // through the building.
      const near = (a.x - v.x) * (a.x - v.x) + (a.z - v.z) * (a.z - v.z) < 22 * 22;
      if (wants && !inLine && a.mode === MODE.WALK && near) {
        const q = venueSlot(v, a.queueK);
        detachPath(a);
        a.tx = q.x; a.tz = q.z;
        a.mode = MODE.GOTO;
        a.thenMode = MODE.QUEUE;
      } else if (!wants && inLine && a.homePath) {
        // Last call. Back onto the pavement they came off.
        const sm = sampleLoop(a.homePath, a.homeS, 0);
        a.mode = MODE.GOTO;
        a.thenMode = MODE.WALK;
        a.tx = sm.x; a.tz = sm.z;
      }
    }
  }
}

/**
 * Put someone back on their feet after the hole let go of them, or after the
 * respawner brought them back. They return to the life they had, not to a
 * generic idle in the middle of the road.
 */
function reviveAgent(st, a) {
  a.dead = false;
  a.held = false;
  a.culled = false;
  a.acc = 0;
  a.curSpeed = 0;
  a.crossing = null;
  const m = a.homeMode ?? MODE.IDLE;
  if (m === MODE.WALK && a.homePath) {
    joinPath(st.rng, a, a.homePath, a.homeS, st.rng.chance(0.5) ? 1 : -1);
    a.lastHookSeg = -1;
    const sm = sampleLoop(a.homePath, a.s, 0);
    a.x = sm.x; a.z = sm.z; a.y = st.Y_WALK;
  } else {
    a.mode = m;
    a.x = a.homeX; a.z = a.homeZ; a.y = a.homeY; a.yaw = a.homeYaw;
    if (m === MODE.SERVE) { a.routeI = 0; a.wait = 0; }
    // Back on the same bench, facing the same way, not still twisted round from
    // whatever they were looking at when the ground went.
    if (m === MODE.SIT) { a.seatYaw = a.homeYaw; a.sitTurn = 0; a.headTurn = 0; }
  }
  a.phase = st.rng() * Math.PI * 2;
}

/**
 * A content module cannot reach the camera, so LOD keys off the shadow rig's
 * target: the engine re-centres it on the visible frustum every frame, which is
 * within a few tens of metres of what the player is actually looking at.
 */
function resolveFocus(st) {
  if (!st.focusSrc) {
    let sunTarget = null;
    for (const o of st.scene.children) {
      if (o.isCamera) { st.focusSrc = o; break; }
      // The engine re-centres the shadow rig on the visible frustum every
      // frame, so its target is within a few tens of metres of the look-at
      // point — the best proxy a content module can reach.
      if (o.isDirectionalLight && o.castShadow && o.target) sunTarget = o.target;
    }
    if (!st.focusSrc) st.focusSrc = sunTarget;
    // Nothing found: never cull, rather than culling the whole crowd.
    if (!st.focusSrc) { st.focus.set(0, 0, 0); st.noFocus = true; return; }
  }
  st.focus.copy(st.focusSrc.position);
}

/** Live holes, for the panic response. Refreshed a few times a second. */
function collectHoles(st) {
  const out = st.holes;
  out.length = 0;
  for (const o of st.scene.children) {
    if (!o.visible || !o.name || !o.name.startsWith('hole-')) continue;
    let r = 0;
    for (const ch of o.children) if (ch.scale.x > r) r = ch.scale.x;
    if (r < 0.2) continue;
    out.push({ x: o.position.x, z: o.position.z, r });
  }
}

/** Collapse every instance this agent owns. Used by the handover and by LOD. */
function hideAgent(st, a, i, withDog = true) {
  const P = st.P;
  clearInstance(P.head.instanceMatrix.array, i);
  clearInstance(P.hair.instanceMatrix.array, i);
  clearInstance(P.torso.instanceMatrix.array, i);
  clearInstance(P.shadow.instanceMatrix.array, i);
  clearInstance(P.arms.instanceMatrix.array, i * 2);
  clearInstance(P.arms.instanceMatrix.array, i * 2 + 1);
  clearInstance(P.thighs.instanceMatrix.array, i * 2);
  clearInstance(P.thighs.instanceMatrix.array, i * 2 + 1);
  clearInstance(P.shins.instanceMatrix.array, i * 2);
  clearInstance(P.shins.instanceMatrix.array, i * 2 + 1);
  if (a.hatSlot >= 0) clearInstance(P.hat.instanceMatrix.array, a.hatSlot);
  if (a.bagSlot >= 0) clearInstance(P.bag.instanceMatrix.array, a.bagSlot);
  if (a.overlaySlot >= 0) clearInstance(P.overlay.instanceMatrix.array, a.overlaySlot);
  if (a.bikeSlot >= 0) clearInstance(P.bike.instanceMatrix.array, a.bikeSlot);
  if (a.boardSlot >= 0) clearInstance(P.board.instanceMatrix.array, a.boardSlot);
  // The phone goes down the hole with its owner: a coffee cup left hovering
  // over the pit is exactly the kind of stray geometry the rubric fails.
  if (a.items) {
    const mi = P.item.instanceMatrix.array;
    for (const it of a.items) if (it.slot >= 0) clearInstance(mi, it.slot);
  }
  if (withDog) hideDog(st, a);
}

function hideDog(st, a) {
  if (a.dogSlot >= 0) clearInstance(st.P[`dog${a.dogBreed}`].instanceMatrix.array, a.dogSlot);
}

/* ------------------------------------------------------------ behaviour --- */

/**
 * Cartoon fright. The hole is a physical threat the crowd can see coming, so
 * they scatter with their arms in the air well before they are swallowed —
 * that anticipation is most of the comedy.
 */
function panicCheck(st, a, dt) {
  if (a.mode === MODE.CYCLE) return;
  const holes = st.holes;
  let best = -1, bx = 0, bz = 0;
  for (let i = 0; i < holes.length; i++) {
    const h = holes[i];
    const dx = a.x - h.x, dz = a.z - h.z;
    const d2 = dx * dx + dz * dz;
    const trigger = h.r * 2.6 + 5.5;
    if (d2 < trigger * trigger && (best < 0 || d2 < best)) { best = d2; bx = dx; bz = dz; }
  }
  if (best >= 0) {
    const d = Math.sqrt(best) || 0.001;
    a.fleeX = bx / d; a.fleeZ = bz / d;
    if (a.mode !== MODE.FLEE) {
      // Remember where they belong so the street refills once the hole moves
      // on, instead of leaving a permanent hole in the crowd.
      // `a.crossEnd` is NOT cleared when a crossing completes, so it has to be
      // gated on `a.crossing` — otherwise a diner who crossed the street an
      // hour ago runs back to that kerb instead of back to their table.
      if (a.path) { a.retPath = a.path; a.retS = a.s; }
      else if (a.crossing && a.crossEnd) { a.retPath = a.crossEnd.path; a.retS = a.crossEnd.path.cum[a.crossEnd.index]; }
      else {
        a.retPath = null;
        a.retX = a.x; a.retY = a.y; a.retZ = a.z;
        a.retMode = a.mode; a.retYaw = a.yaw;
      }
      detachPath(a);
      a.crossing = null;
      a.mode = MODE.FLEE;
      a.fleeT = 0;
    }
  } else if (a.mode === MODE.FLEE) {
    a.fleeT += dt;
    // Give up panicking a second after the danger has gone.
    if (a.fleeT > 1.1) {
      a.mode = MODE.RETURN;
      if (a.retPath) {
        const sm = sampleLoop(a.retPath, a.retS, 0);
        a.tx = sm.x; a.tz = sm.z;
      } else {
        a.tx = a.retX; a.tz = a.retZ;
      }
    }
  }
}

function stepReturn(st, a, dt) {
  if (!gotoPoint(a, a.tx, a.tz, groundY(st, a.x, a.z), dt)) return;
  if (a.retPath) {
    joinPath(st.rng, a, a.retPath, a.retS, st.rng.chance(0.5) ? 1 : -1);
    a.lastHookSeg = a.seg;
  } else {
    // SNAP to the exact mark, don't just arrive near it. gotoPoint stops within
    // 28 cm, which on a loop is invisible but on a chair is the difference
    // between sitting on the seat and hovering beside it — and the same 28 cm
    // walks a presenter off their tripod's framing and a queuer out of the line.
    a.x = a.retX; a.z = a.retZ;
    if (a.retY !== undefined) a.y = a.retY;
    a.mode = a.retMode ?? MODE.IDLE;
    a.yaw = a.retYaw ?? a.yaw;
  }
}

/**
 * Position on a loop at arc length s, walking out from the cached segment
 * pointer. Writes into a module scratch: this runs once per walking agent per
 * frame and a fresh literal each time is 600 garbage objects a frame.
 */
const _sm = { seg: 0, x: 0, z: 0, dx: 0, dz: 0 };
const _band = { lo: 0, hi: 0 };
function sampleLoop(p, s, seg) {
  const cum = p.cum;
  let i = seg;
  if (i < 0 || i >= p.n) i = 0;
  let guard = 0;
  while (s >= cum[i + 1] && guard++ < p.n) i = (i + 1) % p.n;
  guard = 0;
  while (s < cum[i] && guard++ < p.n) i = (i - 1 + p.n) % p.n;
  const l0 = cum[i], l1 = cum[i + 1];
  const t = l1 > l0 ? (s - l0) / (l1 - l0) : 0;
  const ax = p.px[i], az = p.pz[i];
  const bx = p.px[i + 1], bz = p.pz[i + 1];
  _sm.seg = i;
  _sm.x = ax + (bx - ax) * t;
  _sm.z = az + (bz - az) * t;
  _sm.dx = bx - ax;
  _sm.dz = bz - az;
  return _sm;
}

function stepWalk(st, a, dt) {
  const p = a.path;
  if (!p) { a.mode = MODE.IDLE; return; }

  /* --- separation, resolved along the loop's own arc length ------------- */
  let brake = 1;
  let push = 0;
  const list = p.agents;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    // A gazer is still standing on the loop, so the stream has to see them or
    // it walks straight through the one person who has stopped.
    if (o === a || o.dead || (o.mode !== MODE.WALK && o.mode !== MODE.GAZE)) continue;
    let ds = o.s - a.s;
    if (ds > p.total * 0.5) ds -= p.total;
    else if (ds < -p.total * 0.5) ds += p.total;
    const gap = ds * a.dir;                    // >0 means "in front of me"
    const dl = o.lat - a.lat;
    if (gap > 0 && gap < 1.7 && Math.abs(dl) < 0.55) {
      if (o.dir === a.dir) brake = Math.min(brake, Math.max(0.15, gap / 1.7));
      else brake = Math.min(brake, 0.6);
    }
    if (Math.abs(gap) < 1.1 && Math.abs(dl) < 0.8) {
      push += (dl >= 0 ? -1 : 1) * (1.1 - Math.abs(gap)) * 0.9;
    }
  }

  const target = a.speed * brake;
  a.curSpeed += (target - a.curSpeed) * Math.min(1, dt * 6);
  const dist = a.curSpeed * dt;
  a.s += a.dir * dist;
  if (a.s >= p.total) a.s -= p.total;
  else if (a.s < 0) a.s += p.total;

  const sm = sampleLoop(p, a.s, a.seg);
  a.seg = sm.seg;

  // Keep right: the offset is measured along the right-hand normal of travel,
  // so the two directions of foot traffic automatically split into two lanes.
  const inv = 1 / (Math.hypot(sm.dx, sm.dz) || 1);
  const ux = sm.dx * inv * a.dir, uz = sm.dz * inv * a.dir;
  const nx = -uz, nz = ux;
  let want = Math.max(-p.lat * 1.3, Math.min(p.lat * 1.3, a.latTarget + push));
  /* --- steer inside the free corridor ---------------------------------
   * Looked up a metre and a half AHEAD, not underfoot: by the time a bench is
   * beside you it is too late to walk round it, and `lat` only closes at
   * 4/s. The band itself was already dilated by CLEAR_PAD at build time, so
   * between the two a walker starts leaning out of the way about 2.5 m early.
   */
  clearanceAt(p, a.s + a.dir * 1.5, a.dir, _band);
  if (want < _band.lo) want = _band.lo;
  else if (want > _band.hi) want = _band.hi;
  a.lat += (want - a.lat) * Math.min(1, dt * 4);
  // And a hard stop at the station they are actually on, so a walker who has
  // been shoved sideways by the crowd still cannot end up inside a planter.
  clearanceAt(p, a.s, a.dir, _band);
  if (a.lat < _band.lo) a.lat = _band.lo;
  else if (a.lat > _band.hi) a.lat = _band.hi;

  a.x = sm.x + nx * a.lat;
  a.z = sm.z + nz * a.lat;
  a.y = st.Y_WALK;
  turnTo(a, Math.atan2(ux, uz), dt, 7);
  advancePhase(a, dist);

  /* --- stop and look up? -------------------------------------------------- */
  // A tourist who never stops is a commuter. The pause is what separates the
  // two archetypes at a glance, and it costs one countdown per agent.
  if (a.gazeEvery > 0) {
    a.gazeT -= dt;
    if (a.gazeT <= 0) {
      a.gazeT = a.gazeEvery * (0.7 + st.rng() * 0.6);
      a.gazeHold = 2.4 + st.rng() * 4.0;
      a.mode = MODE.GAZE;
      // Face the nearest tall thing: the block they are walking around.
      a.yaw = Math.atan2(p.block.x - a.x, p.block.z - a.z);
      return;
    }
  }

  /* --- take a crossing? -------------------------------------------------- */
  const hooks = p.hooks[sm.seg];
  if (hooks && a.seg !== a.lastHookSeg) {
    a.lastHookSeg = a.seg;
    // Deliberately high. Every gameplay camera in this game frames a junction,
    // so the crossings are where the crowd is actually on screen: a queue at
    // each kerb and a stream on the zebra when the light goes green.
    if (st.rng() < 0.40) {
      const h = hooks[(st.rng() * hooks.length) | 0];
      detachPath(a);
      a.crossing = h.crossing;
      a.crossEnd = h.end;
      // Spread across the width of the painted crossing, so a group waiting
      // for the light is a line of people at the kerb, not one person-shaped
      // pile of nine people.
      a.crossOff = (st.rng() - 0.5) * 2.2;
      aimCrossing(a, h.end);
      a.mode = MODE.APPROACH;
    }
  } else if (!hooks) {
    a.lastHookSeg = -1;
  }
}

/** Target one end of a crossing, offset across the width of the paint. */
function aimCrossing(a, end) {
  const off = a.crossOff || 0;
  if (a.crossing.axis === 'z') { a.tx = end.at.x + off; a.tz = end.at.z; }
  else { a.tx = end.at.x; a.tz = end.at.z + off; }
}

function detachPath(a) {
  if (!a.path) return;
  const q = a.path.agents.indexOf(a);
  if (q >= 0) a.path.agents.splice(q, 1);
  a.path = null;
}

/** Walk the last couple of metres from the loop out to the kerb. */
function stepApproach(st, a, dt) {
  if (gotoPoint(a, a.tx, a.tz, st.Y_WALK, dt)) {
    a.mode = MODE.WAIT;
    a.wait = 0.15 + st.rng() * 0.35;   // look before you step off
  }
}

function stepWait(st, a, dt) {
  const cr = a.crossing;
  if (!cr) { a.mode = MODE.IDLE; return; }
  a.wait -= dt;
  a.curSpeed = 0;
  advancePhase(a, 0);
  // Face the far kerb while waiting — a queue of people all looking the same
  // way is what makes a signalled crossing read as a crossing.
  const other = cr.ends[a.crossEnd.other];
  turnTo(a, Math.atan2(other.at.x - a.x, other.at.z - a.z), dt, 5);
  if (a.wait > 0) return;
  const light = st.net.lightFor(cr.ix, cr.vehAxis, st.time);
  if (light !== 'green') return;
  a.mode = MODE.CROSS;
  a.crossT = 0;
  aimCrossing(a, other);
}

function stepCross(st, a, dt) {
  const cr = a.crossing;
  if (!cr) { a.mode = MODE.IDLE; return; }
  // People hustle across; nobody strolls a crosswalk on a 16 s cycle.
  const old = a.speed;
  a.speed = old * 1.25;
  const arrived = gotoPoint(a, a.tx, a.tz, kerbHeight(st, cr, a.x, a.z), dt);
  a.speed = old;
  if (!arrived) return;
  const end = cr.ends[a.crossEnd.other];
  joinPath(st.rng, a, end.path, end.path.cum[end.index], st.rng.chance(0.5) ? 1 : -1);
  a.lastHookSeg = end.index;
  a.crossing = null;
  a.y = st.Y_WALK;
}

/** Height under a walker mid-crossing: off the kerb, over the road, back up. */
function kerbHeight(st, cr, x, z) {
  const p = cr.axis === 'z' ? z : x;
  const d = Math.abs(p - cr.roadCentre) - cr.roadHalf;
  if (d >= 0.7) return st.Y_WALK;
  if (d <= 0) return 0.026;
  return 0.026 + (st.Y_WALK - 0.026) * (d / 0.7);
}

function stepIdle(st, a, dt) {
  a.curSpeed = 0;
  advancePhase(a, 0);
  // Slow weight shift, and a glance at whoever they are talking to.
  const t = st.time + a.idleSeed;
  if (a.chatPartner && !a.chatPartner.dead) {
    const p = a.chatPartner;
    turnTo(a, Math.atan2(p.x - a.x, p.z - a.z) + Math.sin(t * 0.5) * 0.12, dt, 2);
  } else {
    turnTo(a, a.yaw + Math.sin(t * 0.23) * 0.02, dt, 1.4);
  }
}

/**
 * Sitting.
 *
 * This used to fall through to stepIdle, and stepIdle turns the whole body to
 * face whoever you are talking to. On a bench that is a 90-degree swivel: two
 * people paired into a conversation both rotated square to each other and ended
 * up sitting sideways across the slats with their legs through the armrest.
 *
 * A seat does not turn. So the BODY is pinned to the seat's own direction and
 * only the shoulders and the head are allowed to move — which is what a person
 * on a bench actually does, and reads as attention rather than as a lazy susan.
 */
const SIT_TWIST = 0.42;     // shoulders, radians off the seat direction
const SIT_HEAD = 0.60;      // and the head can add this much again
function stepSit(st, a, dt) {
  a.curSpeed = 0;
  advancePhase(a, 0);
  const base = a.seatYaw ?? a.yaw;
  // Ease back onto the seat line — this also un-swivels anyone whose yaw was
  // left pointing somewhere else by a flee-and-return.
  turnTo(a, base + Math.sin((st.time + a.idleSeed) * 0.31) * 0.03, dt, 1.6);

  let want = 0;
  const p = a.chatPartner;
  if (p && !p.dead) {
    want = Math.atan2(p.x - a.x, p.z - a.z) - base;
    while (want > Math.PI) want -= Math.PI * 2;
    while (want < -Math.PI) want += Math.PI * 2;
  }
  const tw = want < -SIT_TWIST ? -SIT_TWIST : want > SIT_TWIST ? SIT_TWIST : want;
  const rest = want - tw;
  const hd = rest < -SIT_HEAD ? -SIT_HEAD : rest > SIT_HEAD ? SIT_HEAD : rest;
  const k = Math.min(1, dt * 3);
  a.sitTurn = (a.sitTurn || 0) + (tw - (a.sitTurn || 0)) * k;
  a.headTurn = (a.headTurn || 0) + (hd - (a.headTurn || 0)) * k;
}

/* ------------------------------------------- the behaviours added this pass */

/** Stopped on the pavement, head back at the skyline. Tourists do this a lot. */
function stepGaze(st, a, dt) {
  a.curSpeed = 0;
  advancePhase(a, 0);
  a.gazeHold -= dt;
  turnTo(a, a.yaw + Math.sin((st.time + a.idleSeed) * 0.35) * 0.03, dt, 1.2);
  if (a.gazeHold <= 0) a.mode = a.path ? MODE.WALK : MODE.IDLE;
}

/**
 * Anyone who is part of a shoot: presenter, operator, boom, reflector, poser,
 * or a busker working a pitch. They hold their mark; the pose does the acting.
 */
function stepFilm(st, a, dt) {
  a.curSpeed = 0;
  advancePhase(a, 0);
  const t = st.time + a.idleSeed;
  const sway = (a.role === 'presenter' || a.role === 'singer') ? 0.09 : 0.025;
  turnTo(a, (a.homeYaw ?? a.yaw) + Math.sin(t * 0.8) * sway, dt, 2.0);
}

/** In line at a door. Shuffles up when the slot in front comes free. */
function stepQueue(st, a, dt) {
  const v = a.venue;
  if (v) {
    const q = venueSlot(v, a.queueK);
    const dx = q.x - a.x, dz = q.z - a.z;
    if (dx * dx + dz * dz > 0.30) { gotoPoint(a, q.x, q.z, st.Y_WALK, dt); return; }
  }
  a.curSpeed = 0;
  advancePhase(a, 0);
  const t = st.time + a.idleSeed;
  turnTo(a, v ? Math.atan2(v.x - a.x, v.z - a.z) + Math.sin(t * 0.4) * 0.10 : a.yaw, dt, 1.8);
}

/**
 * A server working a terrace: table, table, back to the pass, repeat. The
 * WALKING between the stops is the behaviour — a waiter standing still is
 * indistinguishable from a customer.
 */
function stepServe(st, a, dt) {
  const route = a.route;
  if (!route || route.length < 2) { a.mode = MODE.IDLE; return; }
  if (a.wait > 0) {
    a.wait -= dt;
    a.curSpeed = 0;
    advancePhase(a, 0);
    const nx = route[a.routeI];
    turnTo(a, Math.atan2(nx.x - a.x, nx.z - a.z), dt, 2.2);
    return;
  }
  const wp = route[a.routeI];
  if (gotoPoint(a, wp.x, wp.z, a.homeY ?? st.Y_WALK, dt)) {
    a.wait = wp.wait;
    a.routeI = (a.routeI + 1) % route.length;
  }
}

/**
 * A child locked into the adult's frame. Solved as a position rather than
 * simulated, so a family never drifts apart, never has to path-find, and stops
 * the instant the adult does — and the walk cycle still runs off real distance
 * travelled, so the kid's feet do not slide either.
 */
function stepEscort(st, a, dt) {
  const ad = a.escort;
  if (!ad) { a.mode = MODE.IDLE; return; }
  // Their adult is in the pit, or below the world waiting on the respawner.
  // STAY IN ESCORT and stand still: dropping to IDLE stranded the child on the
  // pavement for the rest of the match, because nothing ever put them back in
  // the family — one swallow near a park and the city filled up with lone
  // toddlers standing in the road.
  if (ad.dead || ad.held) {
    a.curSpeed = 0;
    advancePhase(a, 0);
    turnTo(a, Math.atan2(ad.x - a.x, ad.z - a.z), dt, 1.5);
    return;
  }
  const cs = Math.cos(ad.yaw), sn = Math.sin(ad.yaw);
  let off = a.escortSide * a.escortOff;
  let tx = ad.x + cs * off - sn * a.escortBack;
  let tz = ad.z - sn * off - cs * a.escortBack;
  /* --- swap sides rather than walk the child through a planter ---------
   * The adult is steered by the measured pavement corridor; the child is
   * simply pinned half a metre to one side of them, so on the kerb side of a
   * row of bins the parent goes round and the toddler goes through. Measured:
   * 28 of the 116 people standing inside furniture after twenty seconds were
   * escorted children. Trying the other hand first, and falling in directly
   * behind if neither hand is clear, is what a parent actually does. */
  if (st.obstacles && !spotIsClear(st.obstacles, tx, tz, WALK_R * 0.7)) {
    off = -off;
    const ax = ad.x + cs * off - sn * a.escortBack;
    const az = ad.z - sn * off - cs * a.escortBack;
    if (spotIsClear(st.obstacles, ax, az, WALK_R * 0.7)) {
      a.escortSide = -a.escortSide;
      tx = ax; tz = az;
    } else {
      // Single file, in the adult's own footsteps.
      tx = ad.x - sn * (a.escortBack + 0.34);
      tz = ad.z - cs * (a.escortBack + 0.34);
    }
  }
  const dx = tx - a.x, dz = tz - a.z;
  const d = Math.hypot(dx, dz);
  const step = Math.min(d, Math.max(ad.curSpeed * 1.4, 0.35) * dt);
  if (d > 1e-5) { a.x += (dx / d) * step; a.z += (dz / d) * step; }
  a.y = ad.y;
  a.curSpeed = step / Math.max(1e-4, dt);
  turnTo(a, ad.yaw, dt, 6);
  advancePhase(a, step);
}

/** Walk to an assigned spot, then become whatever you went there to be. */
function stepGoto(st, a, dt) {
  if (!gotoPoint(a, a.tx, a.tz, groundY(st, a.x, a.z), dt)) return;
  const m = a.thenMode ?? MODE.IDLE;
  if (m === MODE.WALK && a.homePath) {
    joinPath(st.rng, a, a.homePath, a.homeS, st.rng.chance(0.5) ? 1 : -1);
    a.lastHookSeg = -1;
  } else {
    a.mode = m;
  }
  // A promoter arriving on their mark starts working; the same person walking
  // home at dawn stops being one. Carried on the errand rather than set at
  // departure so the role changes when they get there, not while they walk.
  if (a.thenRole !== undefined) { a.role = a.thenRole; a.thenRole = undefined; }
}

function stepFlee(st, a, dt) {
  const sp = a.speed * 2.1 + 1.2;
  a.curSpeed += (sp - a.curSpeed) * Math.min(1, dt * 8);
  const d = a.curSpeed * dt;
  a.x += a.fleeX * d;
  a.z += a.fleeZ * d;
  a.y = groundY(st, a.x, a.z);
  turnTo(a, Math.atan2(a.fleeX, a.fleeZ), dt, 9);
  advancePhase(a, d);
}

/**
 * Panicking agents run off the kerb, so their feet have to find the roadway.
 * Only the two carriageway families are checked — alleys and diagonals are not
 * paved yet and a 15 cm error on one of those is not worth the loop.
 */
function groundY(st, x, z) {
  const L = st.layout;
  for (const r of L.roadsX) if (Math.abs(x - r.pos) < r.half) return 0.028;
  for (const r of L.roadsZ) if (Math.abs(z - r.pos) < r.half) return 0.028;
  return st.Y_WALK;
}

function stepCycle(st, a, dt) {
  const net = st.net;
  const lane = a.lane;
  let target = a.speed;

  const nx = net.nextJunction(lane, a.laneS);
  if (nx) {
    const stopDist = lane.axis === 'x' ? nx.ix.stopX : nx.ix.stopZ;
    const gap = nx.distance - stopDist;
    const light = net.lightFor(nx.ix, lane.axis, st.time);
    if (light !== 'green' && gap < 12) target = gap < 1.2 ? 0 : a.speed * Math.max(0, gap / 12);
  }
  a.curSpeed += (target - a.curSpeed) * Math.min(1, dt * 2.6);
  const dist = a.curSpeed * dt;
  a.laneS += dist;

  if (a.laneS > a.laneHi) a.laneS = a.laneLo;
  sampleCyclist(a, net);
  if (st.layout.isWater(a.x, a.z)) {
    // Ride on past the bay or the river channel rather than pedalling into it.
    a.laneS += 60;
    if (a.laneS > a.laneHi) a.laneS = a.laneLo;
    sampleCyclist(a, net);
  }
  a.y = 0.02;
  // Pedalling is driven by wheel travel, same principle as the walk cycle.
  a.phase += dist * 2.6;
  if (a.phase > 1e6) a.phase = 0;
}

/** Place a cyclist in the kerb lane, outboard of the parked cars. */
function sampleCyclist(a, net) {
  const lane = a.lane;
  const half = lane.road.half;
  const out = Math.max(1.4, half - 3.2);
  if (lane.axis === 'x') {
    // travelling along z; right hand (the kerb) is -x going +z
    a.x = lane.road.pos + (lane.dir > 0 ? -out : out);
    a.z = a.laneS * lane.dir;
    a.yaw = lane.dir > 0 ? 0 : Math.PI;
  } else {
    a.x = a.laneS * lane.dir;
    a.z = lane.road.pos + (lane.dir > 0 ? out : -out);
    a.yaw = lane.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
  }
}

/** Walk toward a point; true once inside 0.28 m. */
function gotoPoint(a, tx, tz, y, dt) {
  const dx = tx - a.x, dz = tz - a.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.28) { a.y = y; return true; }
  a.curSpeed += (a.speed - a.curSpeed) * Math.min(1, dt * 6);
  const step = Math.min(d, a.curSpeed * dt);
  a.x += (dx / d) * step;
  a.z += (dz / d) * step;
  a.y = y;
  turnTo(a, Math.atan2(dx, dz), dt, 8);
  advancePhase(a, step);
  return false;
}

function turnTo(a, want, dt, rate) {
  let d = want - a.yaw;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  a.yaw += d * Math.min(1, dt * rate);
}

/**
 * The anti-sliding contract: phase is a function of ground distance covered.
 * One stride pair moves the body 2*L*sin(A) per pi of phase, so dphi is
 * dist*pi / (2*L*sin A) and the planted foot never moves in world space.
 */
function advancePhase(a, dist) {
  const A = legAmplitude(a);
  if (dist <= 1e-5) {
    // Standing: ease the cycle back to the nearest legs-together stance rather
    // than freezing mid-step, which is the other classic crowd tell.
    const t = a.phase % Math.PI;
    a.phase += (t > Math.PI * 0.5 ? Math.PI - t : -t) * 0.12;
    return;
  }
  a.phase += (dist * Math.PI) / Math.max(0.08, 2 * LEG_L * Math.sin(A));
  if (a.phase > 1e6) a.phase = a.phase % (Math.PI * 2);
}

/**
 * Triangle wave, -1 at psi = pi/2 (heel strike) rising to +1 at 3pi/2 (toe
 * off) and back. Used as the driver for sin(thigh) so the planted foot travels
 * backward at a constant speed — see the anti-slide note in poseAgent.
 */
const TAU = Math.PI * 2;
function tri(psi) {
  let w = (((psi - Math.PI * 0.5) % TAU) + TAU) % TAU / Math.PI;   // 0..2
  return w <= 1 ? 2 * w - 1 : 3 - 2 * w;
}

function legAmplitude(a) {
  const v = a.curSpeed;
  return Math.min(0.62, Math.max(0.10, 0.11 + v * 0.20));
}

/* ----------------------------------------------------------------- pose --- */

function poseAgent(st, a, i) {
  const P = st.P;
  const s = a.size;
  const yaw = a.yaw;
  const phi = a.phase;
  const sinP = Math.sin(phi);

  let thighL, thighR, shinL, shinR, armL, armR, hip, lean, twist;
  /** Extra head pitch on top of the lean. Negative looks up. */
  let headExtra = 0;
  /** Extra head YAW, for looking at someone you are not squared up to. */
  let headTurn = 0;

  if (a.mode === MODE.SIT) {
    hip = a.hipY;
    const spread = a.sitSprawl ? -1.50 : -1.34;
    thighL = spread - 0.05; thighR = spread + 0.05;
    if (a.sitSprawl) {
      shinL = -0.95; shinR = -1.02;
    } else {
      // SOLVE the shin angle from the seat height instead of authoring it.
      // Seats in this city run 0.46-0.56 m and bodies scale 0.885-1.06, so a
      // fixed pose puts a tall person's shoes 7 cm through the pavement and a
      // short person's 2 cm above it. Dropping a perpendicular from the knee
      // to the ground makes every sitter's sole land on the ground for free,
      // and a seat too high to reach correctly leaves the feet dangling.
      const knee = THIGH_L * Math.cos(spread);
      const reach = (hip - knee) / SOLE_L;     // knee joint to the sole
      const bend = reach >= 1 ? 0 : Math.acos(Math.max(-1, reach));
      shinL = bend + 0.04; shinR = bend - 0.05;
    }
    lean = a.lean + Math.sin(st.time * 0.6 + a.idleSeed) * 0.02;
    // A sitter cannot swivel: the bench does not turn. `sitTurn` is a
    // shoulder twist off the seat's own direction, clamped in stepSit.
    twist = Math.sin(st.time * 0.33 + a.idleSeed) * 0.10 + (a.sitTurn || 0);
    headTurn = a.headTurn || 0;
    armL = -0.55; armR = -0.50;
    if (a.role === 'drummer') {
      // Both hands beating the bucket, out of phase.
      const b = Math.sin(st.time * 5.2 + a.idleSeed);
      armL = -0.92 - Math.max(0, b) * 0.34;
      armR = -0.92 - Math.max(0, -b) * 0.34;
      lean = 0.22;
      twist = b * 0.07;
    } else if (a.lying) {
      /* --- asleep on a bench ------------------------------------------
       * The torso goes down ALONG the seat rather than the legs coming up,
       * because the hip stays where a hip on a bench is and the shoes stay off
       * the pavement. `lean` is already ~1.34 rad from the placer, so all this
       * has to do is straighten the legs out along the timber and stop the
       * idle sway that would have them breathing like a metronome. */
      thighL = -1.62; thighR = -1.58;
      shinL = 0.06; shinR = 0.02;
      lean = a.lean + Math.sin(st.time * 0.32 + a.idleSeed) * 0.012;
      twist = 0.06;
      armL = -1.05; armR = -0.30;
      headExtra = -0.55;                 // head resting back, not chin on chest
    } else if (a.role === 'boardgame') {
      // Elbows on the table, a tile going down every few seconds.
      const play = Math.max(0, Math.sin(st.time * 0.55 + a.idleSeed * 3.1));
      armL = -1.16 - play * 0.30;
      armR = -1.02 + Math.sin(st.time * 0.31 + a.idleSeed) * 0.06;
      lean = 0.26 + play * 0.06;
      twist = Math.sin(st.time * 0.4 + a.idleSeed) * 0.07;
      headExtra = 0.24;                  // looking down at the board
    } else if (a.role === 'vendor') {
      const g = Math.sin(st.time * 0.42 + a.idleSeed);
      armL = -0.70 + g * 0.22; armR = -0.48;
      lean = 0.12;
    } else if (a.role === 'feeder') {
      // One hand out low, scattering; the other resting on the knee.
      const s2 = Math.sin(st.time * 1.05 + a.idleSeed);
      armL = -0.86 - Math.max(0, s2) * 0.34;
      armR = -0.52;
      lean = 0.16; headExtra = 0.22;
    } else if (a.role === 'streetRest') {
      /* --- sitting on the ground with their back against the wall ------
       * The LEGS are left exactly as the sprawl pose put them, so the heels
       * land on the paving like every other ground sitter's. Only the arms and
       * the head change: forearms resting on the knees, back settled against
       * the wall. Posed to look comfortable rather than collapsed — the
       * difference between a person resting and a caricature is entirely in
       * this pose, and the brief is explicit that it must be the former. */
      armL = -1.02 + Math.sin(st.time * 0.28 + a.idleSeed) * 0.03;
      armR = -0.96;
      lean = a.lean + Math.sin(st.time * 0.4 + a.idleSeed) * 0.02;
      twist = Math.sin(st.time * 0.22 + a.idleSeed) * 0.05;
      headExtra = 0.04;
    } else if (a.chatPartner && !a.chatPartner.dead) {
      // Talking over a table: one hand comes up off the top.
      const g = Math.max(0, Math.sin(st.time * 1.3 + a.idleSeed));
      armL = -0.55 - g * 0.55;
      twist += g * 0.06;
    }
  } else if (a.mode === MODE.CYCLE) {
    hip = a.hipY;
    // Pedals are 180 degrees apart; the knee tracks the crank.
    const c1 = Math.cos(phi), c2 = Math.cos(phi + Math.PI);
    thighL = -1.05 + c1 * 0.30;
    thighR = -1.05 + c2 * 0.30;
    shinL = thighL + 0.95 + c1 * 0.42;
    shinR = thighR + 0.95 + c2 * 0.42;
    lean = a.lean;
    twist = 0;
    armL = -1.05; armR = -1.05;
  } else if (a.mode === MODE.IDLE || a.mode === MODE.WAIT || a.mode === MODE.QUEUE
             || a.mode === MODE.GAZE || a.mode === MODE.FILM) {
    const t = st.time * 0.8 + a.idleSeed;
    const shift = Math.sin(t * 0.55);
    hip = HIP_Y - 0.012 + shift * 0.006;
    thighL = 0.10 + shift * 0.05; thighR = -0.12 - shift * 0.05;
    shinL = thighL - 0.04; shinR = thighR + 0.02;
    lean = a.lean + Math.sin(t * 0.7) * 0.012;
    twist = shift * 0.10;
    // A talker gestures with one hand.
    const gest = a.chatPartner ? Math.max(0, Math.sin(t * 1.6)) : 0;
    armL = 0.05 + shift * 0.06 - gest * 0.85;
    armR = -0.05 - shift * 0.06;

    if (a.mode === MODE.GAZE) headExtra = -0.44 + Math.sin(t * 0.5) * 0.05;

    /* --- what the standing roles are actually doing ---------------------- */
    // NOTE: armL drives the arm at -x, which on a figure facing +z is the
    // figure's RIGHT arm. AT.HAND_R rides that same arm; keep them in step.
    switch (a.role) {
      case 'presenter': case 'singer': {
        const g = Math.sin(t * 1.7);
        // Mic to the mouth if they have one, otherwise both hands talking.
        armL = a.items ? -1.42 - Math.max(0, g) * 0.06 : -0.50 - Math.max(0, g) * 0.85;
        armR = -0.30 - Math.max(0, -g) * 0.80;
        twist = g * 0.11;
        lean = 0.03;
        headExtra = -0.04 + g * 0.03;
        break;
      }
      case 'operator': {
        /*
         * Hands ON the camera, and the angle is SOLVED, not authored.
         *
         * This used to be -1.18 / -1.12, which is 68 degrees forward. On a rig
         * with no elbow that puts both hands 1.2 m up and half a metre out —
         * below the camera head and short of it — so the operator stood there
         * with two straight parallel arms reaching into thin air. At street
         * level it read as a sleepwalker, and parallel arms are the specific
         * tell that gives a crowd system away.
         *
         * tripodGeo puts the camera body at 1.62 m. The hand rides 0.50 along
         * the arm from a shoulder at ~1.41 m, so cos(swing) = (1.41 - 1.58)/0.50
         * and the arm has to come UP past horizontal to reach it.
         */
        const drift = Math.sin(t * 0.5) * 0.04;
        armL = -1.92 + drift;
        // Never exactly parallel: the offhand rides the focus ring, a little
        // lower and a little further round than the hand on the body.
        armR = -1.74 - drift;
        lean = 0.13; headExtra = 0.16;
        break;
      }
      case 'boom':
        // Pole overhead in both hands, watching the subject.
        armL = -2.05 + Math.sin(t * 0.6) * 0.05;
        armR = -1.85 + Math.sin(t * 0.6) * 0.05;
        lean = 0.03; headExtra = -0.10;
        break;
      case 'reflector':
        armL = -1.48; armR = -1.44;
        lean = 0.02;
        break;
      case 'shooter':
        // Phone up, arm locked, elbow out: the universal "filming you" stance.
        armL = -1.30 + Math.sin(t * 0.5) * 0.03;
        armR = -0.10;
        lean = 0.05; headExtra = 0.06;
        break;
      case 'poser': {
        // Weight on one hip, one arm out. Held longer and steadier than idle.
        const p2 = Math.sin(t * 0.35);
        armL = -0.55 + p2 * 0.30; armR = 0.32;
        twist = 0.20 + p2 * 0.08;
        lean = 0.02;
        break;
      }
      case 'doorman':
        // Hands clasped in front: the whole silhouette of "you are not coming in".
        armL = -0.42; armR = -0.40;
        twist = Math.sin(t * 0.25) * 0.05;
        lean = 0.0;
        break;
      case 'valet':
        armL = -0.34; armR = -0.10 - Math.max(0, Math.sin(t * 0.9)) * 0.5;
        break;
      case 'queuer': {
        // A queue reads by its STILLNESS. The default idle gestures, which made
        // a line at a door look like a party. Hands low and in front — or the
        // phone up, because that is what half a queue is really doing.
        const onPhone = !!a.items;
        armL = onPhone ? -1.02 + Math.sin(t * 0.4) * 0.03 : -0.26 + shift * 0.04;
        armR = -0.22 - shift * 0.04;
        headExtra = onPhone ? 0.30 : 0.02;
        break;
      }
      case 'onlooker': case 'audience':
        headExtra = -0.06;
        break;

      /* ---- the street-life cast ---------------------------------------- */
      case 'spectator':
        // Watching something at waist height — a board, a blanket of goods.
        // Arms folded, weight settled: the stillness is the whole read.
        armL = -0.72; armR = -0.68;
        headExtra = 0.20;
        twist = Math.sin(t * 0.22) * 0.05;
        lean = 0.06;
        break;
      case 'vendor': {
        // Standing behind their own table, one hand out to whoever stops.
        const g = Math.sin(t * 0.85);
        armL = -0.62 - Math.max(0, g) * 0.62;
        armR = -0.34;
        lean = 0.05;
        twist = g * 0.09;
        break;
      }
      case 'preacher': {
        // One arm up and open, the other holding the book. Emphatic, not
        // frantic — a real speaker works in long slow beats.
        const g = Math.sin(t * 0.9);
        armL = -2.05 - Math.max(0, g) * 0.28;
        armR = a.items ? -1.10 : -0.40 - Math.max(0, -g) * 0.5;
        lean = 0.02;
        twist = g * 0.14;
        headExtra = -0.16 + g * 0.04;
        break;
      }
      case 'taichi': {
        /*
         * Tai chi in the park: the arms travel through a slow circle and the
         * knees stay soft. Everything here runs at a THIRD of the idle rate,
         * which is what makes it read as a deliberate form and not as somebody
         * waving. The idleSeed is spaced by the placer, so a group of four
         * moves in loose unison rather than in lockstep.
         */
        const w = t * 0.30;
        const c1 = Math.cos(w), s1 = Math.sin(w);
        armL = -1.32 + c1 * 0.62;
        armR = -1.32 - c1 * 0.62;
        twist = s1 * 0.26;
        // Soft knees and a settled stance.
        hip = HIP_Y - 0.085 + Math.sin(w * 2) * 0.012;
        thighL = 0.24; thighR = -0.26;
        shinL = -0.16; shinR = 0.14;
        lean = 0.01;
        headTurn = s1 * 0.2;
        break;
      }
      case 'arguer': {
        // Somebody having it out with nobody. Both hands going, no partner to
        // gesture at — which is exactly what makes a passer-by look twice.
        const g = Math.sin(t * 2.3), h = Math.sin(t * 1.7 + 1.2);
        armL = -0.70 - Math.max(0, g) * 1.05;
        armR = -0.58 - Math.max(0, h) * 0.92;
        twist = g * 0.20;
        lean = 0.06 + Math.max(0, g) * 0.05;
        headExtra = -0.10 + h * 0.06;
        break;
      }
      case 'promoter': {
        // Cards held out to the pavement, the other hand waving people over.
        const g = Math.sin(t * 1.15);
        armL = -1.24 - Math.max(0, g) * 0.14;
        armR = -0.44 - Math.max(0, -g) * 0.62;
        twist = 0.16 + g * 0.08;
        lean = 0.04;
        break;
      }
      default: break;
    }
  } else {
    const A = legAmplitude(a);
    const sA = Math.sin(A);
    const psi = phi + 0.35;
    /*
     * THE ANTI-SLIDE CURVE.
     * A plain `thigh = A*sin(phi)` moves the foot sinusoidally under a body
     * that travels at constant speed, so the planted foot skates back and forth
     * by ~20% of the stride. Ramping sin(thigh) LINEARLY instead makes the
     * foot's backward speed constant and exactly equal to the walk speed, so
     * the sole is genuinely nailed to the pavement through the whole stance.
     */
    thighL = Math.asin(sA * tri(psi));
    thighR = Math.asin(sA * tri(psi + Math.PI));
    // The knee only bends on the swing leg, peaking as it passes the stance
    // leg — that is the beat that reads as a step rather than a scissor.
    const cL = Math.cos(psi);
    const kL = Math.max(0, cL);
    const kR = Math.max(0, -cL);
    // Fade the knee out as the stride shortens, or someone stuck behind a
    // queue stands there with one knee hoisted in the air.
    const kk = Math.min(1, A / 0.30) * 1.15;
    shinL = thighL + kL * kL * kk;
    shinR = thighR + kR * kR * kk;
    // Hip height is solved from whichever leg is straight and planted, which
    // is what keeps the shoes on the ground for every stride length.
    hip = 0.047 + LEG_L * Math.cos(cL > 0 ? thighR : thighL);
    const armA = A * 0.78;
    if (a.mode === MODE.FLEE) {
      // Arms straight up, waving. Cartoon terror, nothing gory.
      const w = Math.sin(phi * 1.7) * 0.35;
      armL = -2.45 + w; armR = -2.45 - w;
      lean = 0.16;
      twist = w * 0.18;
    } else {
      armL = armA * sinP; armR = -armA * sinP;
      lean = a.lean + A * 0.10;
      twist = -0.13 * A * sinP;
      if (a.arch.key === 'jogger') {
        // A runner's arms are held high and drive hard; the extra forward lean
        // is what stops a fast walk cycle reading as a comedy speed-walk.
        armL = -0.62 + armA * 1.55 * sinP;
        armR = -0.62 - armA * 1.55 * sinP;
        lean = 0.17 + A * 0.10;
      } else if (a.phoneWalk) {
        // Head down, one arm locked up in front. Reads from 40 m.
        armL = -0.95 + Math.sin(st.time * 0.6 + a.idleSeed) * 0.03;
        armR = -armA * 0.55 * sinP;
        headExtra = 0.30;
        lean = a.lean + 0.03;
      } else if (a.items) {
        // Carrying something: that arm stops swinging and holds it steady.
        for (const it of a.items) {
          if (it.at === AT.HAND_R) armL = -0.52 + armA * 0.25 * sinP;
          else if (it.at === AT.HAND_L) armR = -0.52 - armA * 0.25 * sinP;
        }
      }
    }
    if (a.board) {
      // Riding, not walking: knees bent over the deck, shoulders turned across
      // it, arms out. Hip height is solved so the soles land on the deck top.
      hip = BOARD_HIP;
      thighL = -0.30; thighR = 0.30;
      shinL = 0.30; shinR = -0.30;
      armL = -0.95 + Math.sin(st.time * 1.3 + a.idleSeed) * 0.12;
      armR = 0.85;
      lean = 0.11;
      twist = -0.52;
    }
  }

  const cl = Math.cos(lean), sl = Math.sin(lean);
  const px = a.x, py = a.y, pz = a.z;

  const mTorso = P.torso.instanceMatrix.array;
  poseInto(mTorso, i, px, py, pz, yaw + twist, s, 0, hip, 0, lean, 1, 1, 1);

  /* --- the one thing that casts ---------------------------------------
   * A single coarse volume, stretched to the height this person actually
   * occupies right now. Driven off `hip` rather off a constant so a sitter
   * throws a sitter's shadow and a cyclist a cyclist's, and off `lean` so
   * somebody asleep along a bench does not cast a standing silhouette. */
  const stand = (hip + NECK_Y * cl + HEAD_TOP) / PROXY_H;
  poseInto(
    P.shadow.instanceMatrix.array, i, px, py, pz, yaw + twist * 0.5, s,
    0, 0, 0, 0, 1, Math.max(0.18, stand) * PROXY_H, 1
  );

  // Neck and shoulders ride the leaning torso.
  const neckY = hip + NECK_Y * cl;
  const neckZ = NECK_Y * sl;
  const shY = hip + SHOULDER_Y * cl;
  const shZ = SHOULDER_Y * sl;

  const headSwing = lean * 0.35 + headExtra + (a.mode === MODE.FLEE ? -0.18 : 0);
  const headYaw = yaw + twist * 0.5 + headTurn + Math.sin(st.time * 0.4 + a.idleSeed) * 0.09;
  // Face-mounted items solve against these; see AT.FACE in poseItems.
  a._hSwing = headSwing; a._hYaw = headYaw;
  poseInto(P.head.instanceMatrix.array, i, px, py, pz, headYaw, s, 0, neckY, neckZ, headSwing, 1, 1, 1);
  poseInto(
    P.hair.instanceMatrix.array, i, px, py, pz, headYaw, s,
    0, neckY, neckZ, headSwing, a.hairScale, a.hairTall, a.hairScale
  );
  if (a.hatSlot >= 0) {
    // Only the brim and crown WIDTH scale — scaling y would drag the whole hat
    // down the joint axis and bury a cap inside the skull.
    poseInto(
      P.hat.instanceMatrix.array, a.hatSlot, px, py, pz, headYaw, s,
      0, neckY, neckZ, headSwing, a.hatScale, 1, a.hatScale
    );
  }

  const mArms = P.arms.instanceMatrix.array;
  poseInto(mArms, i * 2, px, py, pz, yaw, s, -SHOULDER_X, shY, shZ, armL, 1, 1, 1);
  poseInto(mArms, i * 2 + 1, px, py, pz, yaw, s, SHOULDER_X, shY, shZ, armR, 1, 1, 1);

  const mTh = P.thighs.instanceMatrix.array;
  const mSh = P.shins.instanceMatrix.array;
  poseInto(mTh, i * 2, px, py, pz, yaw, s, -HIP_X, hip, 0, thighL, 1, 1, 1);
  poseInto(mTh, i * 2 + 1, px, py, pz, yaw, s, HIP_X, hip, 0, thighR, 1, 1, 1);
  poseInto(
    mSh, i * 2, px, py, pz, yaw, s,
    -HIP_X, hip - THIGH_L * Math.cos(thighL), -THIGH_L * Math.sin(thighL), shinL, 1, 1, 1
  );
  poseInto(
    mSh, i * 2 + 1, px, py, pz, yaw, s,
    HIP_X, hip - THIGH_L * Math.cos(thighR), -THIGH_L * Math.sin(thighR), shinR, 1, 1, 1
  );

  if (a.bagSlot >= 0) {
    const bg = a.bagG;
    poseInto(P.bag.instanceMatrix.array, a.bagSlot, px, py, pz, yaw + twist, s,
      a.bagLX, hip, 0, lean, bg[0], bg[1], bg[2]);
  }
  if (a.overlaySlot >= 0) {
    poseInto(P.overlay.instanceMatrix.array, a.overlaySlot, px, py, pz, yaw + twist, s, 0, hip, 0, lean, 1, 1, 1);
  }
  if (a.bikeSlot >= 0) {
    poseInto(P.bike.instanceMatrix.array, a.bikeSlot, px, 0.02, pz, yaw, s, 0, 0, 0, 0, 1, 1, 1);
  }
  if (a.boardSlot >= 0) {
    // The deck stays aligned with travel while the rider's shoulders twist.
    poseInto(P.board.instanceMatrix.array, a.boardSlot, px, py, pz, yaw, s, 0, 0, 0.02, 0, 1, 1, 1);
  }
  if (a.dogSlot >= 0) {
    // Trots just ahead and to one side, on a lead we do not draw — a 2 cm
    // cylinder at this distance is aliasing, not a leash.
    const ox = Math.cos(yaw) * 0.85, oz = -Math.sin(yaw) * 0.85;
    a.dogX = px + ox + Math.sin(yaw) * 0.55;
    a.dogZ = pz + oz + Math.cos(yaw) * 0.55;
    const trot = Math.sin(a.phase * 1.4 + a.dogPhase) * 0.05;
    poseInto(
      P[`dog${a.dogBreed}`].instanceMatrix.array, a.dogSlot, a.dogX, py, a.dogZ,
      yaw + 0.3 + trot, s * a.dogScale, 0, 0, 0, trot * 0.6, 1, 1, 1
    );
  }
  if (a.items) poseItems(st, a, hip, shY, shZ, armL, armR, lean, twist, yaw, px, py, pz, s);
}

/**
 * Put the hand-helds where the hands are.
 *
 * One pool, one geometry, six attachment rules. The hand is solved from the arm
 * angle rather than parented, because there is no scene graph here to parent
 * to — the whole crowd is raw matrices.
 */
const BOOM_ANG = 1.15;
/** Distance from the shoulder joint to the middle of the hand blob. */
const HAND_R = ARM_L + 0.022;
function poseItems(st, a, hip, shY, shZ, armL, armR, lean, twist, yaw, px, py, pz, s) {
  const arr = st.P.item.instanceMatrix.array;
  const items = a.items;
  const t = st.time + a.idleSeed;
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    if (it.slot < 0) continue;
    let lx = 0, ly = 0, lz = 0, sw = 0, yw = it.yaw;
    switch (it.at) {
      case AT.HAND_R:
        // HAND_R rides the palm, which is now a real hand blob at the end of
        // the arm rather than the cut face of a cylinder.
        lx = -SHOULDER_X * 0.94;
        ly = shY - HAND_R * Math.cos(armL);
        lz = shZ - HAND_R * Math.sin(armL);
        sw = armL + it.sw;
        break;
      case AT.HAND_L:
        lx = SHOULDER_X * 0.94;
        ly = shY - HAND_R * Math.cos(armR);
        lz = shZ - HAND_R * Math.sin(armR);
        sw = armR + it.sw;
        break;
      case AT.CHEST: {
        const h = SHOULDER_Y - 0.29 + it.dy;
        ly = hip + h * Math.cos(lean);
        lz = h * Math.sin(lean) + 0.125;
        sw = lean + it.sw;
        yw += twist;
        break;
      }
      case AT.BOOM: {
        // Butt just above the raised hands, tip out over the subject's head.
        const ang = BOOM_ANG + Math.sin(t * 0.45) * 0.04;
        a._boomAng = ang;
        lx = 0.05; ly = hip + 1.05; lz = 0.95;
        sw = ang;
        break;
      }
      case AT.BOOM_MIC: {
        const ang = a._boomAng ?? BOOM_ANG;
        const L = 0.95;                       // half the pole: the far end
        lx = 0.05;
        ly = hip + 1.05 + L * Math.cos(ang);
        lz = 0.95 + L * Math.sin(ang);
        sw = ang;
        break;
      }
      case AT.PANEL:
        ly = hip + 0.70;
        lz = 0.48;
        sw = -0.30 + Math.sin(t * 0.4) * 0.04;
        break;
      case AT.DRUM:
        // Standing on the ground between the knees, not floating at hip height.
        ly = 0.24; lz = 0.36;
        break;
      case AT.SEAT:
        // The crate under a busker. Authored in WORLD metres at build time and
        // divided by the body scale there, because this is the one item whose
        // height has to match the ground rather than the person.
        ly = it.dy; lz = -0.055;
        break;
      case AT.FACE: {
        // Sunglasses. They ride the HEAD's own yaw and pitch, not the torso's:
        // a pair that stays square to the chest while somebody looks up at the
        // skyline is worse than no pair at all. Solved from the same neck joint
        // and swing the head pool was posed with, stashed by poseAgent.
        const hs = a._hSwing || 0;
        const hc = Math.cos(hs), hsn = Math.sin(hs);
        ly = hip + NECK_Y * Math.cos(lean) + 0.190 * hc - 0.112 * hsn;
        lz = NECK_Y * Math.sin(lean) + 0.190 * hsn + 0.112 * hc;
        sw = hs + it.sw;
        yw = it.yaw + (a._hYaw ?? yaw) - yaw;
        break;
      }
      default: break;
    }
    poseInto(arr, it.slot, px, py, pz, yaw + yw, s, lx, ly, lz, sw, it.gx, it.gy, it.gz);
  }
}

/* ================================================================ probe === */

/**
 * The geometry of this module, exposed for measurement.
 *
 * Every prop here is sized by worldBuild from the LOWEST FIFTH of its own mesh,
 * so "did that rebuild change the physics footprint" is a question about
 * geometry alone — and answering it should not require booting a browser, a
 * WebGL context and a whole city. Nothing in the game reads this.
 */
export const GEOMETRY_UNDER_TEST = {
  dogShort: () => dogGeo('short'),
  dogLean: () => dogGeo('lean'),
  dogFluffy: () => dogGeo('fluffy'),
  pigeon: () => pigeonGeo('stand'),
  pigeonPeck: () => pigeonGeo('peck'),
  streetMat: vendorMatGeo,
  streetTable: foldTableGeo,
  streetCooler: coolerGeo,
  bedroll: bedrollGeo,
  outreachBoard: outreachBoardGeo,
  trolley: trolleyGeo,
  soapbox: crateGeo,
  signCard: signCardGeo,
  tripod: () => tripodGeo('camera'),
  lightstand: () => tripodGeo('light'),
  pedHead: headGeo,
  pedHair: hairGeo,
  pedTorso: torsoGeo,
  pedArm: armGeo,
  pedThigh: thighGeo,
  pedShin: shinGeo,
  pedHat: hatGeo,
  pedBag: bagGeo,
  pedFallBody: () => fallBodyGeo(0xe0bd8e, 0x413b34, 0x3ecfb2, 0x2a4d80, false, 0),
};
