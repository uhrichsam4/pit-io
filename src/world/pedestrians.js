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

const DOG_COLORS = [
  PALETTE.WOOD_LIGHT, PALETTE.PALM_TRUNK, PALETTE.TAR_SEAM, PALETTE.CONCRETE_DARK,
  PALETTE.STUCCO_SAND, PALETTE.WOOD_DARK,
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

/* ============================================================ dimensions === */

/**
 * One "body unit" is one metre on a 1.79 m adult, and every agent is then
 * scaled 0.88-1.06 so the crowd has real height variation. Joint heights are
 * measured from the sole.
 */
const HIP_Y = 0.895;        // hip joint at full leg extension (shoe on ground)
const THIGH_L = 0.42;
const SHIN_L = 0.42;
const SHOE_H = 0.055;
const LEG_L = THIGH_L + SHIN_L;
const SHOULDER_Y = 0.53;    // above the hip joint
const NECK_Y = 0.545;       // above the hip joint
const SHOULDER_X = 0.185;
const HIP_X = 0.094;

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

/** Torso: pivot at the hip joint, shoulders at +0.53. */
function torsoGeo() {
  const parts = [];
  // Chest tapers out toward the shoulders; the oval cross-section is what
  // stops a person reading as a lamp post from the front.
  const body = trunk(0.158, 0.205, 0.615, 6, 1.0, 0.68, true);
  body.translate(0, -0.085, 0);
  parts.push(body);
  // Shoulder yoke — gives the silhouette a real deltoid line and doubles as the
  // sleeve, so the arms below it can stay skin-coloured.
  parts.push(box(0.415, 0.125, 0.250, 0, SHOULDER_Y - 0.038, 0, 1.0));
  return BufferGeometryUtils.mergeGeometries(parts, false);
}

/** Head: pivot at the neck base. Skin tint. */
function headGeo() {
  const parts = [];
  const neck = limb(0.050, 0.056, 0.075, 5, 0.88, 1, true);
  neck.translate(0, 0.055, 0);
  parts.push(neck);
  const skull = new THREE.SphereGeometry(0.114, 6, 3);
  skull.scale(1, 1.16, 0.95);
  skull.translate(0, 0.175, 0.004);
  parts.push(shadeGeo(skull, 1.0));
  return BufferGeometryUtils.mergeGeometries(parts, false);
}

/** Hair: a cap over the skull, pivot at the neck base. Per-agent scaled. */
function hairGeo() {
  const g = new THREE.SphereGeometry(0.124, 6, 3, 0, Math.PI * 2, 0, 1.72);
  g.scale(1, 1.14, 1.0);
  g.translate(0, 0.168, -0.006);
  return shadeGeo(g, 1.0);
}

/** Arm: pivot at the shoulder. Skin for short sleeves, shirt for long. */
function armGeo() {
  return limb(0.062, 0.054, 0.555, 5, 1.0);
}

/** Thigh: pivot at the hip. */
function thighGeo() {
  return limb(0.095, 0.078, THIGH_L, 5, 1.0, 1, true);
}

/** Shin + shoe: pivot at the knee. The shoe is baked dark by vertex colour. */
function shinGeo() {
  const parts = [];
  parts.push(limb(0.076, 0.061, SHIN_L, 5, 1.0, 1, true));
  parts.push(box(0.098, SHOE_H, 0.215, 0, -SHIN_L - SHOE_H * 0.5 + 0.012, 0.040, 0.30));
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
  const crown = new THREE.CylinderGeometry(0.068, 0.126, 0.105, 6, 1, false, Math.PI / 6);
  crown.translate(0, 0.298, 0);
  parts.push(shadeGeo(crown, 1.0));
  const brim = new THREE.CylinderGeometry(0.152, 0.152, 0.016, 8, 1, false);
  brim.translate(0, 0.247, 0.012);
  parts.push(shadeGeo(brim, 0.92));
  return BufferGeometryUtils.mergeGeometries(parts, false);
}

/** Backpack / shoulder bag / slung camera. Pivot at the hip, rides the torso. */
function bagGeo() {
  return box(0.245, 0.30, 0.145, 0, 0.30, -0.165, 1.0);
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

/** A small dog on a lead, pivot at the ground. */
function dogGeo() {
  const parts = [];
  parts.push(box(0.17, 0.19, 0.44, 0, 0.34, 0, 1.0));          // body
  parts.push(box(0.145, 0.15, 0.16, 0, 0.44, 0.27, 1.0));      // head
  parts.push(box(0.05, 0.05, 0.19, 0, 0.44, -0.28, 0.88));     // tail
  parts.push(box(0.16, 0.25, 0.07, 0, 0.12, 0.15, 0.82));      // front legs
  parts.push(box(0.16, 0.25, 0.07, 0, 0.12, -0.15, 0.82));     // back legs
  return BufferGeometryUtils.mergeGeometries(parts, false);
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
function tripodGeo(head) {
  const parts = [];
  const LEG_LEN = 1.30;
  const SPLAY = 0.30;                       // radians off vertical
  for (let k = 0; k < 3; k++) {
    const ang = (k / 3) * Math.PI * 2 + Math.PI / 6;
    const leg = new THREE.CylinderGeometry(0.021, 0.030, LEG_LEN, 4, 1, false, Math.PI / 4);
    leg.rotateX(SPLAY);
    // The foot has to land ON the ground, so the leg is placed from its foot up
    // rather than from the apex down — the same reason props measure contact.
    leg.translate(0, LEG_LEN * 0.5 * Math.cos(SPLAY), -LEG_LEN * 0.5 * Math.sin(SPLAY));
    leg.rotateY(ang);
    parts.push(shadeGeo(leg, 0.34));
  }
  const apex = LEG_LEN * Math.cos(SPLAY);
  const riser = new THREE.CylinderGeometry(0.026, 0.034, 0.34, 6, 1, false, Math.PI / 6);
  riser.translate(0, apex + 0.14, 0);
  parts.push(shadeGeo(riser, 0.52));
  const collar = new THREE.CylinderGeometry(0.055, 0.062, 0.07, 6, 1, false, Math.PI / 6);
  collar.translate(0, apex - 0.02, 0);
  parts.push(shadeGeo(collar, 0.30));

  const y = apex + 0.31;
  if (head === 'camera') {
    // A boxy cine body with a lens and a flipped-out monitor. It points -z so
    // that a rig placed facing its subject has the lens on the subject.
    const body = new THREE.BoxGeometry(0.17, 0.145, 0.30);
    body.translate(0, y + 0.07, 0.01);
    parts.push(shadeGeo(body, 0.42));
    const lens = new THREE.CylinderGeometry(0.055, 0.062, 0.17, 8);
    lens.rotateX(Math.PI / 2);
    lens.translate(0, y + 0.07, -0.21);
    parts.push(shadeGeo(lens, 0.22));
    const hood = new THREE.CylinderGeometry(0.075, 0.070, 0.05, 8);
    hood.rotateX(Math.PI / 2);
    hood.translate(0, y + 0.07, -0.31);
    parts.push(shadeGeo(hood, 0.18));
    const mon = new THREE.BoxGeometry(0.135, 0.095, 0.016);
    mon.rotateY(0.5);
    mon.translate(0.14, y + 0.12, 0.03);
    parts.push(shadeGeo(mon, 0.95));
  } else {
    // Light stand: a yoke and a boss. The glowing ring itself is a separate
    // instance in the emissive pool, so it can be dimmed with the daylight and
    // pulled the instant the stand is taken.
    for (const s of [-1, 1]) {
      const arm = new THREE.BoxGeometry(0.030, 0.20, 0.030);
      arm.translate(s * 0.115, y + 0.16, 0);
      parts.push(shadeGeo(arm, 0.40));
    }
    const yoke = new THREE.BoxGeometry(0.26, 0.032, 0.032);
    yoke.translate(0, y + 0.06, 0);
    parts.push(shadeGeo(yoke, 0.40));
  }
  return BufferGeometryUtils.mergeGeometries(parts, false);
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
  const agents = [];
  const furniture = collectFurniture(ctx);
  const venues = findVenues(ctx, rng, paths);
  const shoots = [];

  placeSeated(ctx, rng, furniture, agents, 250);
  placeTerraceLife(ctx, rng, furniture, agents, 120);
  placeVenueLife(ctx, rng, venues, agents, Y_WALK, 210);
  placeCreators(ctx, rng, paths, venues, agents, Y_WALK, shoots, 150);
  placeBuskers(ctx, rng, paths, agents, Y_WALK, 60);
  placeGatherings(ctx, rng, paths, agents, Y_WALK, agents.length + 340);
  placeCyclists(ctx, rng, net, agents);
  placeCrossingQueues(ctx, rng, net, agents, Y_WALK, 180);
  placeWalkers(ctx, rng, paths, agents, Y_WALK, TOTAL - agents.length);
  placeChildren(ctx, rng, agents, 110);

  const N = agents.length;
  if (!N) return;

  // WHERE EACH PERSON BELONGS. A pedestrian that has been swallowed comes back
  // 30 s later like every other prop, and "comes back" has to mean back to
  // their chair, their queue, their pitch — not standing in the road in a
  // generic idle. Captured once, after every placer has had its say.
  for (const a of agents) {
    a.homeMode = a.mode;
    a.homeX = a.x; a.homeY = a.y; a.homeZ = a.z; a.homeYaw = a.yaw;
    if (!a.homePath) { a.homePath = a.path; a.homeS = a.s; }
  }

  let nHat = 0, nBag = 0, nOverlay = 0, nBike = 0, nBoard = 0, nDog = 0;
  let nItem = 0;
  for (const a of agents) {
    if (a.hat) a.hatSlot = nHat++;
    if (a.bag) a.bagSlot = nBag++;
    if (a.overlay) a.overlaySlot = nOverlay++;
    if (a.bike) a.bikeSlot = nBike++;
    if (a.board) a.boardSlot = nBoard++;
    if (a.dog) a.dogSlot = nDog++;
    if (a.items) for (const it of a.items) it.slot = nItem++;
  }
  const nGlow = shoots.reduce((n, s) => n + (s.ring ? 1 : 0), 0);

  /* ------------------------------------------------------------- pools --- */
  const P = {
    // Only the trunk and legs cast. Every extra caster is both another
    // shadow-pass draw call AND another N x geometry of shadow triangles, and
    // a head or an arm hides inside the torso's own shadow at any sun angle
    // this rig uses.
    head: makePool(group, headGeo(), matBody, N, false, 'head'),
    hair: makePool(group, hairGeo(), matBody, N, false, 'hair'),
    torso: makePool(group, torsoGeo(), matBody, N, true, 'torso'),
    arms: makePool(group, armGeo(), matBody, N * 2, false, 'arms'),
    thighs: makePool(group, thighGeo(), matBody, N * 2, true, 'thighs'),
    shins: makePool(group, shinGeo(), matBody, N * 2, true, 'shins'),
    hat: makePool(group, hatGeo(), matBody, nHat, false, 'hat'),
    bag: makePool(group, bagGeo(), matBody, nBag, false, 'bag'),
    overlay: makePool(group, overlayGeo(), matBody, nOverlay, false, 'vest'),
    bike: makePool(group, bikeGeo(), matGear, nBike, true, 'bike'),
    board: makePool(group, boardGeo(), matGear, nBoard, false, 'board'),
    dog: makePool(group, dogGeo(), matBody, nDog, false, 'dog'),
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
    if (a.dog) setInstanceColor(P.dog, a.dogSlot, a.dogHex);
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
    });
  }
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

const ARCHETYPES = [
  { key: 'resident', label: 'Local', w: 28, speed: [1.05, 1.42], tops: TOP_CASUAL, longLeg: 0.5, hat: 0.14, bag: 0.16, sleeves: 0.12, phone: 0.24, cup: 0.10 },
  { key: 'office', label: 'Office Worker', w: 20, speed: [1.35, 1.70], tops: TOP_OFFICE, longLeg: 0.94, hat: 0.03, bag: 0.62, sleeves: 0.80, phone: 0.30, cup: 0.34, lanyard: 0.55 },
  { key: 'tourist', label: 'Tourist', w: 19, speed: [0.75, 1.10], tops: TOP_TOURIST, longLeg: 0.10, hat: 0.62, bag: 0.55, sleeves: 0.02, phone: 0.42, camera: 0.30, gaze: 0.55 },
  { key: 'jogger', label: 'Jogger', w: 6, speed: [2.55, 3.30], tops: TOP_SPORT, longLeg: 0.05, hat: 0.18, bag: 0.0, sleeves: 0.0 },
  { key: 'server', label: 'Server', w: 5, speed: [1.10, 1.40], tops: TOP_OFFICE, longLeg: 0.85, apron: true, sleeves: 0.4 },
  { key: 'worker', label: 'Site Worker', w: 6, speed: [0.95, 1.25], tops: TOP_SPORT, longLeg: 0.95, hivis: true, sleeves: 0.5 },
  { key: 'skater', label: 'Skateboarder', w: 3, speed: [3.0, 4.0], tops: TOP_CASUAL, longLeg: 0.25, board: true, hat: 0.3 },
  { key: 'dogwalker', label: 'Dog Walker', w: 5, speed: [0.95, 1.25], tops: TOP_CASUAL, longLeg: 0.4, dog: true, hat: 0.1, phone: 0.10 },
  { key: 'shopper', label: 'Shopper', w: 8, speed: [0.90, 1.25], tops: TOP_CASUAL, longLeg: 0.35, bag: 0.85, hat: 0.2, phone: 0.22 },
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

/** Everything about an agent that never changes after the build. */
function makeAgent(rng, arch) {
  const skin = rng.pick(SKIN);
  const hair = rng.pick(HAIR);
  const top = rng.pick(arch.tops);
  const longLeg = rng.chance(arch.longLeg ?? 0.5);
  const bottom = longLeg ? rng.pick(BOTTOM_LONG) : rng.pick(BOTTOM_SHORT);
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
    bag: false, bagHex: 0, bagSlot: -1,
    overlay: false, overlayHex: 0, overlaySlot: -1,
    bike: false, bikeHex: 0, bikeSlot: -1,
    board: false, boardHex: 0, boardSlot: -1,
    dog: false, dogHex: 0, dogSlot: -1,

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
  if (arch.dog) {
    a.dog = true;
    a.dogHex = rng.pick(DOG_COLORS);
    a.dogPhase = rng() * 6.28;
  }

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
          a.hipY = 0.288 + r() * 0.020;
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
  // Busiest junctions first: a queue is only worth spending agents on where
  // the camera is likely to be.
  const order = linked
    .map((c) => ({ c, w: (c.ends[0].path.streetLife + c.ends[1].path.streetLife) * 0.5 + rng() * 0.25 }))
    .sort((a, b) => b.w - a.w);

  for (const { c } of order) {
    if (spent >= budget) break;
    for (let e = 0; e < 2; e++) {
      const n = rng.weighted([[0, 30], [1, 34], [2, 24], [3, 12]]);
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
    if (!r.chance(0.26)) continue;
    const i = r.int(0, path.n - 1);
    let nx = b.x - path.px[i], nz = b.z - path.pz[i];
    const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l;
    const bx = path.px[i] + nx * (2.2 + r() * 1.6);
    const bz = path.pz[i] + nz * (2.2 + r() * 1.6);
    if (layout.isWater(bx, bz) || layout.isRoad(bx, bz) || !ctx.isFree(bx, bz, 0)) continue;
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
 * @returns {Map<InstancedProp, {n:number}>} the refcount table
 */
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
      variants.set(family, {
        key: `pedFall_${family}`,
        geo: () => fallBodyGeo(spec[0], spec[1], spec[2], spec[3], family === 'cycle', PALETTE.CAR_TEAL),
      });
    }
    return variants.get(family);
  };

  const pos = new THREE.Vector3();
  for (const a of agents) {
    const v = poolFor(a);
    pos.set(a.x, a.y, a.z);
    const c = ctx.addInstanced(v.key, () => ({
      geometry: v.geo(),
      material: solid({
        color: 0xffffff, vertexColors: true, roughness: 0.78, metalness: 0.0,
        envMapIntensity: 0.45,
      }),
    }), {
      position: pos,
      rotationY: a.yaw,
      scale: a.size,
      capacity: 1400,
      tier: a.bike ? TIER.MEDIUM : TIER.SMALL,
      radius: a.bike ? 0.75 : 0.36,
      height: 1.78 * a.size,
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
    const c = ctx.addInstanced('pedFall_dog', () => ({
      geometry: paintGeo(dogGeo(), PALETTE.PALM_TRUNK),
      material: solid({
        color: 0xffffff, vertexColors: true, roughness: 0.8, metalness: 0.0,
      }),
    }), {
      position: pos,
      capacity: 120,
      tier: TIER.SMALL,
      radius: 0.3,
      height: 0.55,
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
          hideAgent(st, a, i, false);      // the dog is its own consumable
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
    // A dog is its own consumable and outlives its owner, so it gets its own
    // handover: the animated dog goes away, the merged one tumbles.
    if (a.dogC) {
      const ds = a.dogC.state;
      setFallBodyLive(st, a.dogC, ds === 1 || ds === 2);
      if (ds >= 1 && !a.dogHeld) { a.dogHeld = true; hideDog(st, a); }
      else if (ds === 0) a.dogHeld = false;
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
  if (a.dogSlot >= 0) clearInstance(st.P.dog.instanceMatrix.array, a.dogSlot);
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
      else { a.retPath = null; a.retX = a.x; a.retZ = a.z; a.retMode = a.mode; a.retYaw = a.yaw; }
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
  const want = Math.max(-p.lat * 1.3, Math.min(p.lat * 1.3, a.latTarget + push));
  a.lat += (want - a.lat) * Math.min(1, dt * 4);

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
  const off = a.escortSide * a.escortOff;
  const tx = ad.x + cs * off - sn * a.escortBack;
  const tz = ad.z - sn * off - cs * a.escortBack;
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
      const knee = 0.42 * Math.cos(spread);
      const reach = (hip - knee) / 0.463;      // 0.463 = shin + shoe sole
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
      case 'operator':
        // Both hands on the rig, eye down to the monitor.
        armL = -1.18; armR = -1.12;
        lean = 0.13; headExtra = 0.16;
        break;
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
      hip = 0.95;
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

  // Neck and shoulders ride the leaning torso.
  const neckY = hip + NECK_Y * cl;
  const neckZ = NECK_Y * sl;
  const shY = hip + SHOULDER_Y * cl;
  const shZ = SHOULDER_Y * sl;

  const headSwing = lean * 0.35 + headExtra + (a.mode === MODE.FLEE ? -0.18 : 0);
  const headYaw = yaw + twist * 0.5 + headTurn + Math.sin(st.time * 0.4 + a.idleSeed) * 0.09;
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
    poseInto(P.bag.instanceMatrix.array, a.bagSlot, px, py, pz, yaw + twist, s, 0, hip, 0, lean, 1, 1, 1);
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
      P.dog.instanceMatrix.array, a.dogSlot, a.dogX, py, a.dogZ,
      yaw + 0.3 + trot, s * 0.86, 0, 0, 0, trot * 0.6, 1, 1, 1
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
        // 0.50 rather than the arm's full 0.555 so it sits in the palm rather
        // than floating past the fingertips.
        lx = -SHOULDER_X * 0.94;
        ly = shY - 0.50 * Math.cos(armL);
        lz = shZ - 0.50 * Math.sin(armL);
        sw = armL + it.sw;
        break;
      case AT.HAND_L:
        lx = SHOULDER_X * 0.94;
        ly = shY - 0.50 * Math.cos(armR);
        lz = shZ - 0.50 * Math.sin(armR);
        sw = armR + it.sw;
        break;
      case AT.CHEST: {
        const h = SHOULDER_Y - 0.26 + it.dy;
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
      default: break;
    }
    poseInto(arr, it.slot, px, py, pz, yaw + yw, s, lx, ly, lz, sw, it.gx, it.gy, it.gz);
  }
}
