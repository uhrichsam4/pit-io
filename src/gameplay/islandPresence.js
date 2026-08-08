/**
 * ISLAND PRESENCE — the other players, standing in the plaza with you.
 *
 * WHY THIS FILE EXISTS
 *   The waiting room was a movement sandbox with exactly one hole in it: yours.
 *   Everything that made it feel like a lobby was DOM stacked over the top of
 *   the island, which is the failure the owner photographed. A Fortnite-style
 *   pre-match works the other way round: the roster is the WORLD. You see the
 *   other players because they are standing there, you walk over to them, and
 *   the overlay is a thin strip that never covers the plaza.
 *
 *   So this module puts every other player in the lobby into the scene as a
 *   real Hole, with a name over their head, and keeps them inside the island.
 *
 * WHAT IT OWNS, AND WHAT IT REFUSES TO
 *   - Ghost Holes for AI-filled slots (offline only). Created, driven, clamped
 *     and disposed here. They are pushed into `game.holes` for one reason: the
 *     ground cut is uploaded from that array by groundShader.updateHoleUniforms,
 *     and a hole that does not cut the ground is a black bowl sitting on grass.
 *   - Positions for network peers whose first SNAPSHOT has not landed yet.
 *     Nothing else: once the server has told us where a real player is, that is
 *     where they are. This module never invents a position it could know.
 *   - The nameplate layer, and the speech bubbles a chat system can raise.
 *   - It creates NO bots, NO scores, NO consumables, and it never runs during a
 *     match. It adds no key handler of any kind — see the note under say().
 *
 * @see game.js enterIsland() / _clampToIsland() — the machinery this extends
 * @see net/client.js SNAPSHOT — the only source of real remote positions
 */

import * as THREE from 'three';
import { Hole } from './hole.js';
import { HOLE, MATCH } from '../config.js';
import { PLAYER_COLORS } from '../net/protocol.js';

/* ========================================================== constants === */
/* Module scope and declared BEFORE anything reads them. Four TDZ bugs have
   shipped in this project from a const that was "only reached at runtime". */

/**
 * Names for the AI-filled slots.
 *
 * DUPLICATED ON PURPOSE, and it is a known inaccuracy. gameplay/ai.js keeps its
 * NAMES and COLORS as module-private consts and spawnBots() draws from them
 * with the game RNG at startMatch() time — so the seven bots you actually play
 * against cannot be named until the match begins, and predicting the draw would
 * mean consuming the shared RNG and changing the city. The vocabulary matches
 * so the plaza reads as the same cast; the individual names will not survive
 * into the round. Fixing that properly means exporting NAMES/COLORS from ai.js
 * (not this file's to edit) — see the report.
 */
const AI_NAMES = [
  'Vortex', 'Cyclone', 'Abyss', 'Sinkhole', 'Maelstrom', 'Rift', 'Chasm',
  'Nova', 'Riptide', 'Undertow', 'Eclipse', 'Zenith', 'Kraken', 'Tempest',
];

/**
 * WHERE THE OTHER PLAYERS STAND, AND WHY NOT ON island.spawns.
 *
 * island.spawns is a 62 m ring — a MATCH-START spread, sized so nobody lands on
 * a landmark or inside somebody else. Measured on the live build, the island
 * camera sits 55 m out and frames roughly 64 x 40 m of ground (the player's
 * 4.2 m opening drew 83 px wide at 1280 px, so ~20 px/m). On that ring the
 * nearest other player is 32 m away and every single one is off-screen: you
 * land in an empty park. That is the exact opposite of "see the other users".
 *
 * So the plaza is a phyllotaxis spiral centred on the player's OWN spawn point:
 * golden-angle apart, radius growing 15 -> 33 m for seven. Six of the seven are
 * inside the opening shot, the seventh is a few seconds' walk, and the spiral
 * guarantees the spread rather than hoping for it — computed min separation
 * 19.05 m, which is 5.67 m of clearance left even with two neighbours swinging
 * toward each other at full wander AND both hole radii subtracted.
 */
const GOLDEN_ANGLE = 2.399963229728653;
const MEET_R0 = 15;
const MEET_DR = 3.0;
const MEET_PHASE = 0.6;

/**
 * Wander amplitude, metres. The Lissajous below peaks at 1.34x this, so 3.5 is
 * a 4.7 m swing — milling around, not migrating, and it is what keeps the
 * 19.05 m spacing above from ever closing to a touch.
 */
const LEASH = 3.5;

/** Wander frequencies, Hz. Coprime-ish so the path does not visibly repeat. */
const WANDER_HZ_A = 0.21;
const WANDER_HZ_B = 0.53;

/**
 * Nameplate fade band, metres from the CAMERA (not from the player). The near
 * edge sits just past the standing camera distance so the closest plates are
 * solid; everything across the park thins out instead of piling up.
 */
const FADE_NEAR = 58;
const FADE_FAR = 165;

/** Within this many metres of you, a player is "nearby" — the meet-up cue. */
const NEAR_M = 12;

/** Never draw more than this many plates at once, nearest first. */
const MAX_TAGS = 8;

/** Speech bubble lifetime, seconds. Counted down in update(), never a timer. */
const SAY_SECONDS = 6;

const STYLE_ID = 'island-presence-style';

const CSS = `
#island-presence {
  position: absolute; inset: 0; overflow: hidden;
  pointer-events: none;
  /* Sibling of #hud-layer (z 1) and #screens (z 5) inside #ui-root. Deliberately
     the LOWEST interactive-looking layer: a nameplate is ambient information and
     must never cover the countdown, the chat feed or a meta screen (.shell, z 20). */
  z-index: 2;
  contain: layout paint;
}
#island-presence .ip-tag {
  position: absolute; top: 0; left: 0;
  display: flex; align-items: center; gap: 0.42em;
  max-width: min(74vw, 26em);
  padding: 0.26em 0.6em 0.26em 0.42em;
  border-radius: 999px;
  background: rgba(6, 12, 24, 0.78);
  border: 1px solid rgba(255, 255, 255, 0.18);
  box-shadow: 0 0.25em 0.9em rgba(2, 6, 14, 0.55);
  /* px floor, not em: an em floor lands under 10 px on a 375 px phone, which is
     the exact mistake the accessibility bar in this project calls out. */
  font: 800 clamp(12px, 2.7vw, 15px)/1.15 var(--font, system-ui, sans-serif);
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.75);
  white-space: nowrap;
  opacity: 0;
  transition: opacity 140ms ease;
  will-change: transform, opacity;
}
#island-presence .ip-dot {
  flex: none; width: 0.66em; height: 0.66em; border-radius: 50%;
  background: var(--ac, #ff4d8d);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.85);
}
#island-presence .ip-nm {
  flex: 0 1 auto; min-width: 0; max-width: 8.5em;
  overflow: hidden; text-overflow: ellipsis;
}
/* The state word is why colour is never the only signal: "AI", "Nearby" and
   "Loading" are readable with the whole palette discarded. */
#island-presence .ip-st {
  flex: none;
  font-size: 0.72em; font-weight: 900; letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.62);
}
#island-presence .ip-tag.near { border-color: rgba(255, 255, 255, 0.55); }
#island-presence .ip-tag.near .ip-st { color: #4dd2ff; }
#island-presence .ip-say {
  flex: none;
  max-width: 14em; overflow: hidden; text-overflow: ellipsis;
  padding-left: 0.5em; margin-left: 0.1em;
  border-left: 1px solid rgba(255, 255, 255, 0.22);
  font-weight: 600; color: #ffe07a;
}
#island-presence .ip-say:empty { display: none; }
/* Your own bubble: no name, no state chip, no divider — just the words, so it
   reads as speech rather than as a second nameplate. */
#island-presence .ip-tag.self .ip-nm,
#island-presence .ip-tag.self .ip-st { display: none; }
#island-presence .ip-tag.self .ip-say {
  padding-left: 0; margin-left: 0; border-left: 0; color: #fff;
}
@media (prefers-reduced-motion: reduce) {
  #island-presence .ip-tag { transition: none; }
}
`;

/* Scratch. One vector for the whole module — projection happens once per tag
   per frame and allocating a Vector3 in that loop is pure garbage. */
const _v = new THREE.Vector3();

/* ============================================================== state === */

/** @type {import('../game.js').Game|null} */
let game = null;
let layer = null;
let styleEl = null;

/**
 * id -> presence record.
 * `kind` is 'ai' (a ghost this module owns) or 'peer' (a real player whose Hole
 * belongs to game._syncPeerHoles and whose position belongs to the server).
 * @type {Map<string, {id:string, kind:'ai'|'peer', name:string, color:number,
 *   hole:import('./hole.js').Hole, home:{x:number,z:number}, ph:number,
 *   el:HTMLElement, nmEl:HTMLElement, stEl:HTMLElement, sayEl:HTMLElement,
 *   sayLeft:number, measure:boolean, w:number, h:number, dist:number,
 *   sx:number, sy:number, alpha:number, lastAlpha:number, state:string}>}
 */
const people = new Map();

/** Cached viewport, so a resize invalidates the measured plate boxes. */
let vw = 0;
let vh = 0;

/** Centre of the plaza for this visit to the island. See plazaAnchor(). */
let anchor = null;

/**
 * Own-property bookkeeping for the leaveIsland shadow — see install().
 * `innerLeave` is the RAW value found on the game, never a bound copy: putting
 * a bound copy back on uninstall replaces the prototype method with a
 * permanently-bound one, and powerupGlue.js carries a comment about that exact
 * mistake.
 */
let patchedLeave = null;
let innerLeave = null;
let leaveWasOwn = false;

/* ============================================================ helpers === */

function hexOf(n) {
  return `#${(n >>> 0).toString(16).padStart(6, '0')}`;
}

/** The island circle, read from the same object _clampToIsland() reads. */
function bounds() {
  return (game && game.island && game.island.bounds) || null;
}

/**
 * Which spawn slot the local player took.
 *
 * enterIsland() picks `spawns[(n - 1) % spawns.length]` where n is the network
 * id, or 1 offline. Mirrored exactly. Only the fallback for plazaAnchor() —
 * the live player position is preferred — but get it wrong and a game that has
 * not built its player yet assembles the crowd on the far side of the park.
 */
function playerSlot(len) {
  const n = game && game.net && game.net.id ? game.net.id : 1;
  return (n - 1) % len;
}

/**
 * Hold a point inside the island.
 *
 * The SAME circle and the SAME margin as Game._clampToIsland(), on purpose: two
 * containment rules that disagree by a metre is how something ends up standing
 * in Biscayne Bay. game.js clamps every hole in the list after this module has
 * moved its ghosts, so this is belt-and-braces — but a ghost that arrives
 * outside the ring would be visibly teleported by that second pass, and the
 * teleport is what the player would see.
 */
function clampToIsland(p, radius) {
  const b = bounds();
  if (!b) return;
  const dx = p.x - b.cx;
  const dz = p.z - b.cz;
  const d = Math.hypot(dx, dz);
  const lim = Math.max(8, b.r - radius);
  if (d <= lim) return;
  const inv = lim / (d || 1);
  p.x = b.cx + dx * inv;
  p.z = b.cz + dz * inv;
}

/** How much room a plaza of `n` people needs around its centre, in metres. */
function plazaOuterRadius(n) {
  return MEET_R0 + Math.max(0, n - 1) * MEET_DR + LEASH * 1.34 + HOLE.START_RADIUS;
}

/**
 * The centre of the plaza, captured ONCE when it is first populated.
 *
 * WHERE. The player's ACTUAL position, not the spawn point enterIsland() meant
 * to put them on. On the live build those are two different places — the city
 * clamp in Hole.update() teleports the local hole to (3824, 0) whatever its
 * spawn, 200 m from spawns[0] — and a crowd assembled around the intended spawn
 * is a crowd the player never sees. Anchoring on the real position is also just
 * correct: the others should be standing around you, wherever "you" turns out
 * to be. The spawn slot is the fallback for the frame before a player exists.
 *
 * THEN PULLED INLAND SO THE WHOLE SPIRAL FITS. Clamping the individual standing
 * spots instead does not work, and the failure is not subtle: with the anchor
 * 176 m out on a 178 m island, every outward spot in the spiral is squashed
 * onto the same boundary circle and they land on top of each other. Measured
 * before this clamp existed: minimum separation between two holes 0.62 m,
 * against 19.05 m by design. Moving the CENTRE instead keeps every spacing in
 * the spiral exactly as computed, because the whole figure translates rigidly.
 *
 * Captured once, so the crowd does not trail the player around the park.
 *
 * @param {number} n how many people will stand in it
 */
function plazaAnchor(n) {
  if (anchor) return anchor;
  if (!game) return null;

  let x;
  let z;
  if (game.player) {
    x = game.player.position.x;
    z = game.player.position.z;
  } else {
    const spawns = game.island && game.island.spawns;
    if (!spawns || spawns.length === 0) return null;
    const sp = spawns[playerSlot(spawns.length)];
    x = sp.x;
    z = sp.z;
  }

  const b = bounds();
  if (b) {
    const lim = Math.max(0, b.r - plazaOuterRadius(n));
    const dx = x - b.cx;
    const dz = z - b.cz;
    const d = Math.hypot(dx, dz);
    if (d > lim) {
      const k = lim / (d || 1);
      x = b.cx + dx * k;
      z = b.cz + dz * k;
    }
  }

  anchor = { x, z };
  return anchor;
}

/**
 * Standing spot number `i` in the plaza. See the MEET_* constants for why this
 * is a spiral around the player rather than a point off island.spawns.
 *
 * The clamp is defence in depth only: plazaAnchor() has already guaranteed the
 * whole spiral fits inside the ring, so on a 178 m island this never fires. It
 * stays because a collapsed plaza must never be the failure mode if that
 * radius ever changes — but note that if it DOES fire it squashes spacing, so
 * the anchor clamp is the real containment, not this.
 */
function plazaSlot(i) {
  const a = anchor;
  if (!a) return null;
  const r = MEET_R0 + i * MEET_DR;
  const th = i * GOLDEN_ANGLE + MEET_PHASE;
  const p = { x: a.x + Math.cos(th) * r, z: a.z + Math.sin(th) * r };
  clampToIsland(p, HOLE.START_RADIUS + LEASH * 1.34);
  return p;
}

/* ======================================================= ghost motion === */

/**
 * A ghost's own update(), shadowed onto the instance.
 *
 * WHY THE PROTOTYPE IS NOT CALLED. Hole.prototype.update() ends with the CITY
 * bounds — `if (position.x > WORLD.BAY_EDGE - r*0.2)` with BAY_EDGE = 330 — and
 * the island sits at x = 4000. Measured on the live build: a hole spawned at
 * (4022, 20) is slammed to x = 329.6 by that clamp on its first frame and then
 * dragged back onto the island circle by _clampToIsland(), landing on
 * (3824, 0) — the west edge — and it stays pinned there forever. Sixty frames
 * of full-throttle input moved it 0.00 m. Calling the prototype here would
 * stack every ghost on that one point.
 *
 * Shadowing a method on a single Hole is an established technique in this
 * codebase — powerupGlue.js does exactly this to `hole.speed` — so the game's
 * `for (const h of this.holes) h.update(dt, t)` drives these without game.js
 * knowing they exist.
 *
 * The path is a two-frequency Lissajous evaluated straight from `t`, not an
 * integration. That is deliberate: it cannot drift, it cannot accumulate error,
 * it is bounded by construction (so nobody ever reaches the water or another
 * ghost), and it costs four trig calls per ghost per frame on a frame that is
 * already render-bound.
 */
function stepGhost(rec, dt, t) {
  const h = rec.hole;
  if (dt <= 0) return;                     // paused: hold still, do not drift

  const px = h.position.x;
  const pz = h.position.z;

  const a = rec.ph;
  const rx = rec.leash;
  h.position.x = rec.home.x
    + Math.cos(t * WANDER_HZ_A + a) * rx
    + Math.cos(t * WANDER_HZ_B + a * 2.1) * rx * 0.34;
  h.position.z = rec.home.z
    + Math.sin(t * WANDER_HZ_A * 0.81 + a * 1.3) * rx
    + Math.sin(t * WANDER_HZ_B * 0.89 + a) * rx * 0.34;

  clampToIsland(h.position, h.radius);

  // Velocity is what the collar shader reads for its drag streaks, so it has to
  // be the velocity the hole actually travelled at, not the one it wanted.
  const inv = 1 / Math.max(dt, 1 / 240);
  h.velocity.x = (h.position.x - px) * inv;
  h.velocity.z = (h.position.z - pz) * inv;

  // The day/night contract. Copied from Hole.update(): the pit is unlit, so
  // these uniforms are the only way the throat knows the sun has gone. Read off
  // the parent every frame rather than held, so a disposed scene is never pinned.
  h.pitMaterial.uniforms.uTime.value = t;
  const sd = h.group.parent && h.group.parent.userData;
  if (sd) {
    h.pitMaterial.uniforms.uNight.value = sd.nightFactor || 0;
    if (sd.sunDir) {
      const sx = sd.sunDir.x;
      const sz = sd.sunDir.z;
      const m = Math.hypot(sx, sz);
      if (m > 1e-4) h.pitMaterial.uniforms.uSunXZ.value.set(sx / m, sz / m);
    }
  }

  h.group.visible = true;
  h.syncVisual(t);
}

/* ========================================================== the roster === */

function makeTag(rec) {
  const el = document.createElement('div');
  el.className = 'ip-tag';
  el.setAttribute('aria-hidden', 'true');   // the roster panel is the a11y surface

  const dot = document.createElement('span');
  dot.className = 'ip-dot';
  dot.style.setProperty('--ac', hexOf(rec.color));

  const nm = document.createElement('span');
  nm.className = 'ip-nm';
  nm.textContent = rec.name;

  const st = document.createElement('span');
  st.className = 'ip-st';
  st.textContent = rec.state;

  const say = document.createElement('span');
  say.className = 'ip-say';

  el.append(dot, nm, st, say);
  layer.appendChild(el);

  rec.el = el;
  rec.nmEl = nm;
  rec.stEl = st;
  rec.sayEl = say;
  rec.measure = true;
  rec.w = 0;
  rec.h = 0;
  rec.lastAlpha = -1;
}

/** Create the AI-filled slots. Offline only — online the room is real people. */
function fillOffline() {
  const mode = game.mode;
  const want = Math.max(0, (mode && mode.botCount != null) ? mode.botCount : MATCH.BOT_COUNT);
  // The ground cut is a fixed-size uniform array. Past MAX_HOLES a hole draws
  // its pit with no opening beneath it, which looks broken rather than busy.
  const room = Math.max(0, HOLE.MAX_HOLES - game.holes.length);
  const n = Math.min(want, room);
  if (n <= 0) return;

  // Size the plaza BEFORE placing anybody: the anchor has to know how much room
  // the spiral needs, and it is memoised on first call.
  if (!plazaAnchor(n)) return;

  for (let i = 0; i < n; i++) {
    const sp = plazaSlot(i);

    const id = `ai:${i}`;
    const name = AI_NAMES[i % AI_NAMES.length];
    const color = PLAYER_COLORS[(i + 1) % PLAYER_COLORS.length];

    const hole = new Hole({ type: 'bot', name, color, x: sp.x, z: sp.z });
    const rec = {
      id, kind: 'ai', name, color, hole,
      home: { x: sp.x, z: sp.z },
      // Wander phase on a DIFFERENT irrational to the ring angle, or neighbours
      // in the spiral would breathe in step and the plaza would look scripted.
      ph: i * 1.7320508075688772,
      leash: LEASH,
      el: null, nmEl: null, stEl: null, sayEl: null,
      sayLeft: 0, measure: true, w: 0, h: 0,
      dist: 0, sx: 0, sy: 0, alpha: 0, lastAlpha: -1,
      state: 'AI',
    };
    // Shadow the instance method so the game's own loop drives it. See stepGhost.
    hole.update = (dt, t) => stepGhost(rec, dt, t);

    game.engine.scene.add(hole.group);
    game.holes.push(hole);
    people.set(id, rec);
    makeTag(rec);
  }
}

/**
 * Track the network roster.
 *
 * Peers already have Holes — game.enterIsland() calls _syncPeerHoles() and
 * game.stepSimulation() pumps net.update() on the island, so their positions
 * are the real interpolated SNAPSHOT positions. Verified: server.js broadcasts
 * S2C.SNAPSHOT every tick unconditionally, including while phase === 'lobby'.
 *
 * The one thing this module fixes is the gap before a peer's first snapshot:
 * _syncPeerHoles() builds them at (0, 0), which is in the city, 4 km from the
 * island — and the island clamp then piles them all on one point. Until a real
 * position arrives they get a spawn slot of their own. That is not faking a
 * position; it is placing a player whose position has not been sent yet.
 */
function syncPeers() {
  const net = game.net;
  if (!net) return;

  const live = new Set();
  let slot = 0;

  /* The placement pass is conditional; the SWEEP below is not. An early return
     on an empty roster would strand the plates of everyone who just left —
     _syncPeerHoles() disposes their Hole out from under us, and a plate over a
     disposed hole is a name floating on nothing. Sized off the roster, so a
     room that fills up spreads wider rather than packing everybody into the
     seven-player spiral. */
  for (const p of (net.peers.size && plazaAnchor(net.peers.size) ? net.peers.values() : [])) {
    if (!p.hole) continue;                 // no avatar yet; nothing to label
    const id = `net:${p.id}`;
    live.add(id);

    const sp = plazaSlot(slot);
    slot++;

    let rec = people.get(id);
    if (!rec) {
      rec = {
        id, kind: 'peer', name: p.name || 'Player',
        color: p.color != null ? p.color : PLAYER_COLORS[p.id % PLAYER_COLORS.length],
        hole: p.hole,
        home: { x: sp.x, z: sp.z },
        ph: 0, leash: 0,
        el: null, nmEl: null, stEl: null, sayEl: null,
        sayLeft: 0, measure: true, w: 0, h: 0,
        dist: 0, sx: 0, sy: 0, alpha: 0, lastAlpha: -1,
        state: 'Loading',
      };
      people.set(id, rec);
      makeTag(rec);
    }

    // The hole is rebuilt by _syncPeerHoles across rounds; follow the live one.
    rec.hole = p.hole;

    if (p.buffer && p.buffer.length > 0) {
      if (rec.state !== '') { rec.state = ''; rec.stEl.textContent = ''; rec.measure = true; }
    } else {
      // Park them, and say so in words rather than by leaving a hole at origin.
      p.hole.position.x = sp.x;
      p.hole.position.z = sp.z;
      clampToIsland(p.hole.position, p.hole.radius);
      p.hole.syncVisual(game.clock ? game.clock.elapsedTime : 0);
      if (rec.state !== 'Loading') {
        rec.state = 'Loading'; rec.stEl.textContent = 'Loading'; rec.measure = true;
      }
    }

    const nm = p.name || 'Player';
    if (nm !== rec.name) { rec.name = nm; rec.nmEl.textContent = nm; rec.measure = true; }
  }

  // Drop plates for peers that have gone. Their Hole is game.js's to dispose.
  for (const [id, rec] of people) {
    if (rec.kind !== 'peer' || live.has(id)) continue;
    if (rec.el) rec.el.remove();
    people.delete(id);
  }
}

/* ============================================================== labels === */

/**
 * Project every plate, fade it by distance, and suppress the ones that would
 * overlap.
 *
 * Overlap suppression is greedy nearest-first over at most MAX_TAGS boxes — 28
 * rectangle tests at the cap — and it is the difference between a lobby and a
 * pile of text. The plate that survives a collision is always the closer one,
 * because that is the player you are about to walk into.
 */
function layoutTags(camera) {
  const w = window.innerWidth || 1;
  const h = window.innerHeight || 1;
  if (w !== vw || h !== vh) {
    vw = w; vh = h;
    for (const rec of people.values()) rec.measure = true;
  }

  const me = game.player;
  const order = [];

  for (const rec of people.values()) {
    const hole = rec.hole;
    rec.alpha = 0;
    if (!hole || !hole.alive) continue;
    // Your own plate exists only while you are saying something. A permanent
    // nameplate over your own hole is one more thing between you and the park.
    if (rec.kind === 'self' && rec.sayLeft <= 0) continue;

    _v.set(hole.position.x, 2.6 + hole.displayRadius * 0.9, hole.position.z);
    const dist = camera.position.distanceTo(_v);
    rec.dist = dist;
    _v.project(camera);
    // Behind the camera: project() mirrors the point, which would slap the
    // plate on the opposite side of the screen. Same guard as HUD.syncPopups.
    if (_v.z > 1) continue;
    if (dist > FADE_FAR) continue;

    rec.sx = (_v.x * 0.5 + 0.5) * w;
    rec.sy = (-_v.y * 0.5 + 0.5) * h;
    // Only label a hole that is actually on screen. A generous margin here
    // pins plates to the edge for players who are nowhere in shot, which is a
    // border of floating names — the clutter this is supposed to avoid.
    if (rec.sx < -8 || rec.sx > w + 8 || rec.sy < -8 || rec.sy > h + 8) continue;

    rec.alpha = dist <= FADE_NEAR ? 1 : 1 - (dist - FADE_NEAR) / (FADE_FAR - FADE_NEAR);
    order.push(rec);
  }

  order.sort((a, b) => a.dist - b.dist);

  const boxes = [];
  let shown = 0;
  for (const rec of order) {
    if (shown >= MAX_TAGS) { rec.alpha = 0; continue; }

    if (rec.measure) {
      rec.w = rec.el.offsetWidth || 90;
      rec.h = rec.el.offsetHeight || 22;
      rec.measure = false;
    }
    const scale = Math.max(0.72, Math.min(1.06, 62 / Math.max(1, rec.dist)));
    const bw = rec.w * scale;
    const bh = rec.h * scale;

    /* Keep the whole plate on screen.
       Measured at 375 px: a name plus a chat bubble is 142 px wide, so a player
       standing near the edge of frame had a third of their name clipped off by
       the layer's overflow. Nudging the plate in beats clipping it — it is
       still unmistakably over that hole, and it is still readable, which a
       half-name is not. Only ever a nudge: the hole itself is already known to
       be on screen by the cull above. */
    const padX = bw / 2 + 4;
    const padY = bh + 4;
    if (bw + 8 < w) rec.sx = Math.min(Math.max(rec.sx, padX), w - padX);
    if (bh + 8 < h) rec.sy = Math.min(Math.max(rec.sy, padY), h - 4);

    const x0 = rec.sx - bw / 2;
    const y0 = rec.sy - bh;

    let hit = false;
    for (const b of boxes) {
      if (x0 < b[2] && x0 + bw > b[0] && y0 < b[3] && y0 + bh > b[1]) { hit = true; break; }
    }
    if (hit) { rec.alpha = 0; continue; }
    boxes.push([x0, y0, x0 + bw, y0 + bh]);
    shown++;

    // Nearby: the meet-up cue. The word changes too, so the highlight is never
    // colour-only. A peer mid-load keeps saying so — that is the more useful fact.
    if (rec.kind === 'peer' && rec.state !== 'Loading') {
      const near = !!me && Math.hypot(
        rec.hole.position.x - me.position.x, rec.hole.position.z - me.position.z
      ) < NEAR_M;
      const want = near ? 'Nearby' : '';
      if (want !== rec.state) {
        rec.state = want; rec.stEl.textContent = want; rec.measure = true;
      }
      rec.el.classList.toggle('near', near);
    } else if (rec.kind === 'ai' && me) {
      const near = Math.hypot(
        rec.hole.position.x - me.position.x, rec.hole.position.z - me.position.z
      ) < NEAR_M;
      const want = near ? 'Nearby' : 'AI';
      if (want !== rec.state) {
        rec.state = want; rec.stEl.textContent = want; rec.measure = true;
      }
      rec.el.classList.toggle('near', near);
    }

    /* Order matters. scale() BEFORE the percentage offsets, so the -50%/-100%
       are measured in the scaled frame and the plate really is centred on the
       hole and sitting on top of it — the collision boxes above assume exactly
       that. Getting this backwards leaves distant plates drifting right and
       down out of their own hit boxes. */
    rec.el.style.transform =
      `translate(${rec.sx.toFixed(1)}px,${rec.sy.toFixed(1)}px) ` +
      `scale(${scale.toFixed(3)}) translate(-50%,-100%)`;
  }

  for (const rec of people.values()) {
    const a = rec.alpha;
    // Only touch the style when it actually moved: this runs every frame for
    // every plate and a no-op write still dirties the compositor.
    if (Math.abs(a - rec.lastAlpha) < 0.015) continue;
    rec.lastAlpha = a;
    rec.el.style.opacity = a.toFixed(3);
  }
}

/* =============================================================== API === */

/**
 * Wire the module to a Game.
 *
 * Idempotent: a second install replaces the first rather than stacking two
 * layers on one page. Returns the API, or null if the game has no island.
 */
export function install(g) {
  if (!g || !g.engine || !g.uiRoot) {
    console.error('[presence] install(game) needs a Game with an engine and uiRoot');
    return null;
  }
  if (!g.island) {
    console.warn('[presence] no spawn island on this game — nothing to populate');
    return null;
  }
  uninstall();
  game = g;

  styleEl = document.getElementById(STYLE_ID);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = STYLE_ID;
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);
  }

  layer = document.createElement('div');
  layer.id = 'island-presence';
  g.uiRoot.appendChild(layer);

  /* Leaving the island must clear the plaza even if update() is wired inside
     the island branch of the loop and therefore never runs off-island. Shadow
     the instance method — the same own-property trick powerupGlue.js uses on
     stepSimulation, restored the same careful way in uninstall(). */
  leaveWasOwn = Object.prototype.hasOwnProperty.call(g, 'leaveIsland');
  innerLeave = g.leaveIsland;
  patchedLeave = function patchedLeaveIsland(...args) {
    clearAll();
    return innerLeave.apply(this, args);
  };
  g.leaveIsland = patchedLeave;

  console.info('[presence] island presence installed');
  return { update, clearAll, uninstall, roster, say, count };
}

/**
 * One frame.
 *
 * Safe to call every frame regardless of where the game is: off the island it
 * clears and returns, so a wiring that forgets to gate on `onIsland` still
 * leaves no residue.
 *
 * @param {number} dt seconds
 */
export function update(dt) {
  if (!game || !layer) return;

  if (!game.onIsland) {
    if (people.size) clearAll();
    return;
  }

  if (game.net) {
    syncPeers();
  } else if (count() === 0) {
    // count(), not people.size: the local player's own speech-bubble record
    // lives in the same map, and gating on the raw size would let one early
    // say('me') convince this that the plaza was already populated.
    fillOffline();
  }

  // Speech bubbles expire on the frame clock, NOT on setTimeout. A pending
  // timer that fires after the match has started is exactly the class of leak
  // this project keeps hitting; there is no timer in this file to leak.
  if (dt > 0) {
    for (const rec of people.values()) {
      if (rec.sayLeft <= 0) continue;
      rec.sayLeft -= dt;
      if (rec.sayLeft <= 0) {
        rec.sayLeft = 0;
        rec.sayEl.textContent = '';
        rec.measure = true;
      }
    }
  }

  const cam = game.engine && game.engine.camera;
  if (cam) layoutTags(cam);
}

/**
 * Tear the plaza down. Zero residue: no meshes in the scene, no entries left in
 * game.holes, no DOM, no timers (there are none to clear).
 */
export function clearAll() {
  for (const rec of people.values()) {
    if (rec.el) rec.el.remove();
    if (rec.kind !== 'ai') continue;

    const h = rec.hole;
    // Only dispose what is still ours. startMatch() disposes every hole in the
    // list and empties it; if it got there first, the Hole is already gone and
    // disposing its materials a second time would throw.
    const i = game ? game.holes.indexOf(h) : -1;
    if (i >= 0) {
      game.holes.splice(i, 1);
      if (h.group.parent) h.group.parent.remove(h.group);
      h.dispose();
    }
  }
  people.clear();
  // The next visit to the island gets a fresh plaza around wherever the player
  // lands then. Leaving this set is how the crowd would end up assembling on
  // last round's spot.
  anchor = null;
}

/** Remove the module completely. */
export function uninstall() {
  clearAll();
  if (game && patchedLeave) {
    // Only unwrap if nothing else wrapped us afterwards — restoring the inner
    // function over a later wrapper would silently delete that system instead.
    if (game.leaveIsland === patchedLeave) {
      if (leaveWasOwn) game.leaveIsland = innerLeave;
      else delete game.leaveIsland;         // uncover Game.prototype.leaveIsland
    }
  }
  patchedLeave = null;
  innerLeave = null;
  leaveWasOwn = false;
  if (layer) { layer.remove(); layer = null; }
  if (styleEl) { styleEl.remove(); styleEl = null; }
  vw = 0; vh = 0;
  game = null;
}

/** How many other players are standing in the plaza right now. */
export function count() {
  let n = 0;
  for (const rec of people.values()) if (rec.kind !== 'self') n++;
  return n;
}

/**
 * Who is here, for anything that wants to render the same roster as a list.
 *
 * ONE source of truth, on purpose: a waiting-room strip that shows a different
 * set of names from the plaza the player is looking at is worse than no strip.
 *
 * @returns {{id:string, name:string, color:number, kind:'ai'|'peer',
 *   distance:number, nearby:boolean}[]} nearest first
 */
export function roster() {
  const me = game && game.player;
  const out = [];
  for (const rec of people.values()) {
    if (rec.kind === 'self') continue;     // you are not one of the other players
    const d = me && rec.hole
      ? Math.hypot(rec.hole.position.x - me.position.x, rec.hole.position.z - me.position.z)
      : Infinity;
    out.push({
      id: rec.id, name: rec.name, color: rec.color, kind: rec.kind,
      distance: d, nearby: d < NEAR_M,
    });
  }
  out.sort((a, b) => a.distance - b.distance);
  return out;
}

/**
 * Raise a speech bubble over somebody's head.
 *
 * The wiring a chat system wants: the message lands in the feed AND over the
 * speaker, so "who said that" is answered by looking at the plaza rather than
 * by reading a name in a list.
 *
 * THIS MODULE ADDS NO KEY HANDLER. The T-to-chat key and its input guard belong
 * to whoever owns the chat box — src/gameplay/input.js listens for keydown on
 * WINDOW and preventDefaults the arrows and Space with no target check, so a
 * text field without a bubble-phase stopPropagation guard on its own root
 * cannot be typed in and steers the hole while you type. See
 * HUD._installAudioSettings for the guard that works.
 *
 * YOURSELF COUNTS. Pass 'me' (or your own network id) and the bubble goes over
 * your own hole. Without that, say() is nearly useless offline — the only
 * person typing is you, and a chat where your own line appears in a list but
 * nowhere in the world is the "wall of DOM over the game" problem again in
 * miniature. The self plate carries no name and no state chip: it exists only
 * while you are actually saying something.
 *
 * @param {string|number} id a roster() id, a raw network peer id, or 'me'
 * @param {string} text
 * @param {number} [seconds]
 * @returns {boolean} false when nobody by that id is in the plaza
 */
export function say(id, text, seconds = SAY_SECONDS) {
  const key = String(id);
  const rec = people.get(key)
    || people.get(`net:${key}`)
    || people.get(`ai:${key}`)
    || (isLocalId(key) ? selfRecord() : null);
  if (!rec || !rec.sayEl) return false;
  // textContent, never innerHTML: names and messages come off the wire.
  rec.sayEl.textContent = String(text || '').slice(0, 90);
  rec.sayLeft = Math.max(0.5, seconds);
  rec.measure = true;
  return true;
}

/** Does this id mean the local player? */
function isLocalId(key) {
  if (key === 'me' || key === 'self' || key === 'you') return true;
  return !!(game && game.net && game.net.id != null && key === String(game.net.id));
}

/** The local player's own bubble plate, built on first use. */
function selfRecord() {
  if (!game || !game.player || !layer) return null;
  let rec = people.get('self');
  if (rec) { rec.hole = game.player; return rec; }
  rec = {
    id: 'self', kind: 'self', name: '', color: game.player.color.getHex(),
    hole: game.player,
    home: { x: 0, z: 0 }, ph: 0, leash: 0,
    el: null, nmEl: null, stEl: null, sayEl: null,
    sayLeft: 0, measure: true, w: 0, h: 0,
    dist: 0, sx: 0, sy: 0, alpha: 0, lastAlpha: -1,
    state: '',
  };
  people.set('self', rec);
  makeTag(rec);
  rec.el.classList.add('self');
  return rec;
}
