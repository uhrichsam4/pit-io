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
 * The hip also rises and falls by exactly the geometric amount the leg split
 * demands (`0.5 * L * (1 - cos A)`), which is what keeps the shoes touching the
 * pavement through the whole cycle instead of skating 3 cm above it.
 *
 * ---------------------------------------------------------------------------
 * BEING EATEN
 * ---------------------------------------------------------------------------
 * The consume system animates ONE object per swallow, so an agent made of ten
 * instances cannot be handed to it directly. Instead every agent also owns a
 * slot in an invisible "fall body" pool: a single merged, arms-flailing person.
 * That pool is what the registry sees. When the hole takes an agent, the
 * consume system leases a proxy of the merged body and tumbles it, and we
 * simply stop writing the agent's animated parts. No blood, no ragdoll — the
 * little person waves their arms and drops down the drain.
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
const HIP_X = 0.088;

/* ================================================================ modes === */

const MODE = {
  WALK: 0,      // following a block's sidewalk loop
  APPROACH: 1,  // stepping off the loop toward a crossing kerb
  WAIT: 2,      // at the kerb, watching the signal
  CROSS: 3,     // in the marked crosswalk
  IDLE: 4,      // standing / chatting
  SIT: 5,       // on a bench, a step, a lawn
  CYCLE: 6,     // in the kerb lane
  FLEE: 7,      // the hole is close: arms up, run
  RETURN: 8,    // walking back to the spot they bolted from
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
  const body = trunk(0.150, 0.196, 0.615, 6, 1.0, 0.66, true);
  body.translate(0, -0.085, 0);
  parts.push(body);
  // Shoulder yoke — gives the silhouette a real deltoid line and doubles as the
  // sleeve, so the arms below it can stay skin-coloured.
  parts.push(box(0.40, 0.115, 0.235, 0, SHOULDER_Y - 0.035, 0, 1.0));
  return BufferGeometryUtils.mergeGeometries(parts, false);
}

/** Head: pivot at the neck base. Skin tint. */
function headGeo() {
  const parts = [];
  const neck = limb(0.050, 0.056, 0.075, 5, 0.88, 1, true);
  neck.translate(0, 0.055, 0);
  parts.push(neck);
  const skull = new THREE.SphereGeometry(0.109, 6, 3);
  skull.scale(1, 1.16, 0.95);
  skull.translate(0, 0.175, 0.004);
  parts.push(shadeGeo(skull, 1.0));
  return BufferGeometryUtils.mergeGeometries(parts, false);
}

/** Hair: a cap over the skull, pivot at the neck base. Per-agent scaled. */
function hairGeo() {
  const g = new THREE.SphereGeometry(0.118, 6, 3, 0, Math.PI * 2, 0, 1.72);
  g.scale(1, 1.14, 1.0);
  g.translate(0, 0.168, -0.006);
  return shadeGeo(g, 1.0);
}

/** Arm: pivot at the shoulder. Skin for short sleeves, shirt for long. */
function armGeo() {
  return limb(0.053, 0.045, 0.555, 5, 1.0);
}

/** Thigh: pivot at the hip. */
function thighGeo() {
  return limb(0.079, 0.064, THIGH_L, 5, 1.0, 1, true);
}

/** Shin + shoe: pivot at the knee. The shoe is baked dark by vertex colour. */
function shinGeo() {
  const parts = [];
  parts.push(limb(0.062, 0.050, SHIN_L, 5, 1.0, 1, true));
  parts.push(box(0.088, SHOE_H, 0.205, 0, -SHIN_L - SHOE_H * 0.5 + 0.012, 0.037, 0.30));
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
  // Legs kicking in opposite directions.
  const kick = [0.55, -0.75];
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
  const net = ctx.roads || (ctx.roads = new RoadNetwork(layout));

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

  /* ------------------------------------------------------------ agents --- */
  // The whole city has ~27 km of pavement. Even at the top of the budget that
  // is one person every 23 m if you spread them evenly, which reads as a ghost
  // town everywhere. So: hard concentration onto the spines and the gathering
  // spots, and genuinely empty back lots.
  const TOTAL = 1180;
  const agents = [];
  placeGatherings(ctx, rng, paths, agents, Y_WALK, 400);
  placeCyclists(ctx, rng, net, agents);
  placeWalkers(ctx, rng, paths, agents, Y_WALK, TOTAL - agents.length);

  const N = agents.length;
  if (!N) return;

  let nHat = 0, nBag = 0, nOverlay = 0, nBike = 0, nBoard = 0, nDog = 0;
  for (const a of agents) {
    if (a.hat) a.hatSlot = nHat++;
    if (a.bag) a.bagSlot = nBag++;
    if (a.overlay) a.overlaySlot = nOverlay++;
    if (a.bike) a.bikeSlot = nBike++;
    if (a.board) a.boardSlot = nBoard++;
    if (a.dog) a.dogSlot = nDog++;
  }

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
  }
  for (const k in P) P[k].instanceColor.needsUpdate = true;

  /* -------------------------------------------------------- consumables --- */
  registerConsumables(ctx, agents, rng);

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
  };

  scene.userData.pedestrianUpdate = (dt) => updateCrowd(state, dt);
  // Deliberately NOT publishing the agent array: agents point at their sidewalk
  // path and the path points back, and the screenshot harness serialises
  // whatever DEV can reach. A cyclic 900-element graph breaks page.evaluate.
  scene.userData.pedestrianCount = N;

  const walkers = agents.filter((a) => a.mode <= MODE.CROSS).length;
  const idles = agents.filter((a) => a.mode === MODE.IDLE || a.mode === MODE.SIT).length;
  console.info(
    `[pedestrians] ${N} agents (${walkers} walking, ${idles} gathered, ${nBike} cycling, ` +
    `${nDog} dogs) | ${Object.keys(P).length} draw calls | ` +
    `${paths.length} sidewalk loops, ${net.crossings.length} crossings`
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
      // The offset is always to the walker's right, so the cap also has to keep
      // the inbound stream off the building line on the tightest parcels.
      lat: Math.min(0.95, Math.max(0.30, (Math.min(b.w, b.d) - 16) * 0.05)),
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
  { key: 'resident', label: 'Local', w: 30, speed: [1.05, 1.42], tops: TOP_CASUAL, longLeg: 0.5, hat: 0.14, bag: 0.16, sleeves: 0.12 },
  { key: 'office', label: 'Office Worker', w: 22, speed: [1.35, 1.70], tops: TOP_OFFICE, longLeg: 0.94, hat: 0.03, bag: 0.62, sleeves: 0.80 },
  { key: 'tourist', label: 'Tourist', w: 20, speed: [0.75, 1.10], tops: TOP_TOURIST, longLeg: 0.10, hat: 0.62, bag: 0.55, sleeves: 0.02 },
  { key: 'jogger', label: 'Jogger', w: 6, speed: [2.55, 3.30], tops: TOP_SPORT, longLeg: 0.05, hat: 0.18, bag: 0.0, sleeves: 0.0 },
  { key: 'server', label: 'Server', w: 5, speed: [1.10, 1.40], tops: TOP_OFFICE, longLeg: 0.85, apron: true, sleeves: 0.4 },
  { key: 'worker', label: 'Site Worker', w: 6, speed: [0.95, 1.25], tops: TOP_SPORT, longLeg: 0.95, hivis: true, sleeves: 0.5 },
  { key: 'skater', label: 'Skateboarder', w: 3, speed: [3.0, 4.0], tops: TOP_CASUAL, longLeg: 0.25, board: true, hat: 0.3 },
  { key: 'dogwalker', label: 'Dog Walker', w: 5, speed: [0.95, 1.25], tops: TOP_CASUAL, longLeg: 0.4, dog: true, hat: 0.1 },
];

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
    c: null, pool: null, slot: -1,
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
  return a;
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
   * The exponent is brutal on purpose. Weight ~ (streetLife - 0.16)^2.4, so a
   * spine at 1.0 gets ~40x the people per metre of a back lot at 0.3.
   */
  const raw = new Float64Array(paths.length);
  let sum = 0;
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    raw[i] = Math.pow(Math.max(0, p.streetLife - 0.16), 2.4) * p.total;
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
    if (n > 26) n = 26;
    for (let j = 0; j < n; j++) {
      const a = makeAgent(rng, pickArchetype(rng, true));
      const s = ((j + rng() * 0.85) / n) * path.total;
      joinPath(rng, a, path, s, rng.chance(0.5) ? 1 : -1);
      a.y = yWalk;
      a.phase = rng() * Math.PI * 2;
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
    if (!isCafe && !isGreen && !isProm) continue;

    let count = 0;
    if (isCafe) count = r.int(2, 5);
    else if (isGreen) count = r.int(3, 7);
    else count = r.int(1, 4);
    count = Math.round(count * (0.55 + b.streetLife));
    let added = 0;

    for (let i = 0; i < count; i++) {
      // Café crowds hug the frontage; park crowds spread over the lawn.
      // Three attempts: props.js has already claimed the tables and planters,
      // and one unlucky draw should not cost the block a person.
      const spread = isGreen ? 0.34 : 0.44;
      let x = 0, z = 0, ok = false;
      for (let t = 0; t < 3 && !ok; t++) {
        x = b.x + (r() - 0.5) * b.w * spread * 2 * (isCafe ? 0.9 : 1);
        z = b.z + (r() - 0.5) * b.d * spread * 2 * (isCafe ? 0.9 : 1);
        ok = !layout.isWater(x, z) && !layout.isRoad(x, z) && ctx.isFree(x, z, 0.42);
      }
      if (!ok) continue;
      ctx.occupy(x, z, 0.40);

      const arch = isCafe && r.chance(0.18)
        ? ARCHETYPES[4]                       // a server working the terrace
        : pickArchetype(r, false);
      const a = makeAgent(r, arch);
      a.x = x; a.z = z; a.y = yWalk;
      a.yaw = r() * Math.PI * 2;
      // A third of any café or lawn group is sitting down.
      const sitChance = isGreen ? 0.42 : isCafe ? 0.45 : 0.22;
      if (r.chance(sitChance) && arch.key !== 'jogger' && !arch.board) {
        a.mode = MODE.SIT;
        a.hipY = isGreen && r.chance(0.5) ? 0.30 : 0.52;
        a.sitSprawl = a.hipY < 0.4;
        a.lean = 0.10 + r() * 0.18;
      } else {
        a.mode = MODE.IDLE;
        a.lean = 0.01 + r() * 0.04;
      }
      a.idleSeed = r() * 100;
      agents.push(a);
      added++;
    }

    // Two people in a group face each other, which reads instantly as talking.
    for (let i = agents.length - added; i < agents.length - 1; i += 2) {
      const p = agents[i], q = agents[i + 1];
      if (!p || !q || p.mode > MODE.SIT) continue;
      const dx = q.x - p.x, dz = q.z - p.z;
      if (dx * dx + dz * dz > 16) continue;
      p.yaw = Math.atan2(dx, dz);
      q.yaw = Math.atan2(-dx, -dz);
      p.chatPartner = q; q.chatPartner = p;
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
    sampleCyclist(a, net);
    if (layout.isWater(a.x, a.z)) continue;
    agents.push(a);
  }
}

/* =========================================================== consumables === */

/**
 * Give every agent a registry entry backed by an invisible merged-body pool.
 *
 * The pool mesh is never drawn (visible = false costs nothing in three's
 * projection pass); it exists purely so the consume system has one rigid object
 * to lease and tumble when the hole takes someone.
 */
function registerConsumables(ctx, agents, rng) {
  const variants = new Map();

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
    c.pool.mesh.visible = false;   // the animated parts are the visible crowd
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
    c.pool.mesh.visible = false;
  }
}

/* ================================================================ update === */

const NEAR2 = 95 * 95;
const MID2 = 230 * 230;
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

  const { agents, P } = st;
  const fx = st.focus.x, fz = st.focus.z;

  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    if (a.dead) continue;

    // The consume system owns the agent the instant it is captured.
    const c = a.c;
    if (c && c.state >= 2) { killAgent(st, a, i); continue; }
    if (a.dogC && a.dogC.state >= 2) { hideDog(st, a); a.dogSlot = -1; a.dogC = null; }

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
      case MODE.FLEE: stepFlee(st, a, sdt); break;
      case MODE.RETURN: stepReturn(st, a, sdt); break;
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

  for (const k in P) P[k].instanceMatrix.needsUpdate = true;
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

function killAgent(st, a, i) {
  a.dead = true;
  // The dog outlives its owner: it is a separate consumable, and hiding it
  // here would delete an object the registry still says is standing there.
  hideAgent(st, a, i, !a.dogC);
  if (a.path) {
    const q = a.path.agents.indexOf(a);
    if (q >= 0) a.path.agents.splice(q, 1);
  }
}

/** Collapse every instance this agent owns. Used by both death and culling. */
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
      if (a.path) { a.retPath = a.path; a.retS = a.s; }
      else if (a.crossEnd) { a.retPath = a.crossEnd.path; a.retS = a.crossEnd.path.cum[a.crossEnd.index]; }
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
    if (o === a || o.dead || o.mode !== MODE.WALK) continue;
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

  /* --- take a crossing? -------------------------------------------------- */
  const hooks = p.hooks[sm.seg];
  if (hooks && a.seg !== a.lastHookSeg) {
    a.lastHookSeg = a.seg;
    if (st.rng() < 0.22) {
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
    a.wait = 0.25 + Math.random() * 0.5;   // look before you step off
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

  if (a.mode === MODE.SIT) {
    hip = a.hipY;
    const spread = a.sitSprawl ? -1.50 : -1.34;
    thighL = spread - 0.05; thighR = spread + 0.05;
    shinL = a.sitSprawl ? -0.95 : 0.06;
    shinR = a.sitSprawl ? -1.02 : -0.02;
    lean = a.lean + Math.sin(st.time * 0.6 + a.idleSeed) * 0.02;
    twist = Math.sin(st.time * 0.33 + a.idleSeed) * 0.10;
    armL = -0.55; armR = -0.50;
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
  } else if (a.mode === MODE.IDLE || a.mode === MODE.WAIT) {
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

  const headSwing = lean * 0.35 + (a.mode === MODE.FLEE ? -0.18 : 0);
  const headYaw = yaw + twist * 0.5 + Math.sin(st.time * 0.4 + a.idleSeed) * 0.09;
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
}
