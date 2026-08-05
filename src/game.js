/**
 * Game: wires the engine, the world, the holes and the UI into one loop.
 */

import * as THREE from 'three';
import { CAMERA, HOLE, MATCH, WORLD, PALETTE, DEBUG, QUALITY } from './config.js';
import { Engine } from './core/engine.js';
import { buildEnvironment } from './core/materials.js';
import { makeRNG } from './core/rng.js';
import { Effects } from './render/effects.js';
import { updateHoleUniforms } from './render/groundShader.js';
import { OcclusionSystem } from './render/occlusion.js';
import { audio } from './core/audio.js';
import { TIER_LIST } from './config.js';
import { EntityRegistry, STATE } from './gameplay/entities.js';
import { Hole } from './gameplay/hole.js';
import { ConsumeSystem } from './gameplay/consume.js';
import { Input } from './gameplay/input.js';
import { spawnBots } from './gameplay/ai.js';
import { Match, PHASE } from './gameplay/match.js';
import { getMode } from './gameplay/modes.js';
import { buildWorld } from './world/worldBuild.js';
import { HUD, uiState } from './ui/hud.js';
import { Screens } from './ui/screens.js';
import { NetClient, readNetConfig } from './net/client.js';
import { installMeta } from './ui/meta.js';
import { profile } from './meta/profile.js';
import * as progression from './meta/progression.js';
import * as leaderboard from './meta/leaderboard.js';

/** Scratch, so the per-frame window update allocates nothing. */
const _bufSize = new THREE.Vector2();

/**
 * Kind matchers for the daily-challenge tracks. progression.js counts
 * 'vehicles' / 'people' / 'buildings' from the swallow path (everything else it
 * derives itself at match end), and modes.js keeps its equivalents private, so
 * the patterns are restated here. Keep them in step with modes.js RX.
 */
const CH = {
  vehicle: /car|sedan|suv|taxi|van|truck|bus|pickup|hatch|sport|convert|police|ambul|shuttle|mixer|excav|loader|dumper|flatbed|garbage|motor|scooter|bike|bicycle|exotic|super|luxur/i,
  person: /ped|person|tourist|worker|office|jogger|cyclist|dog|busker|vendor|crowd|diner|waiter/i,
  building: /tower|midrise|storefront|garage|construction|landmark|building|block/i,
};

/**
 * Team Devour identities. Two teams, both drawn from the game's own accents so
 * a teammate's rim reads as "mine" at a glance from the gameplay camera.
 */
// Short on purpose: the end card puts these in a fixed-width column beside a
// bar and a score, and "Team Flamingo" ellipsised to "Team Fla…" on a 390 px
// phone. Neither name collides with a bot handle in ai.js.
const TEAMS = [
  { id: 0, name: 'Team Pink', hex: 0xff3d8b },
  { id: 1, name: 'Team Aqua', hex: 0x37e6d5 },
];

/**
 * Last Hole Standing's closing ring.
 *
 * Centred on the middle of the LAND, not of the coordinate system: the bay
 * takes everything east of WORLD.BAY_EDGE, so a ring centred on the origin
 * would spend half its area over water. r0 covers the far corner of the map so
 * the ring starts genuinely open.
 */
const RING_CX = (WORLD.BAY_EDGE - WORLD.SIZE) / 2;
const RING_R0 = Math.hypot(WORLD.SIZE + RING_CX, WORLD.SIZE) + 20;
/** Fraction of the match by which the ring has finished closing. */
const RING_CLOSED_AT = 0.88;

/**
 * Score that puts a hole at exactly `r`. The inverse of Hole.radiusFor, which
 * is the documented way to set a size without hardcoding one — see the note on
 * HOLE.GROWTH_K in config.js. Modes set a starting DIAMETER-ish radius, and
 * every hole in the match has to open on it.
 */
function scoreForRadius(r) {
  const t = Math.max(1, (Number(r) || HOLE.START_RADIUS) / HOLE.START_RADIUS);
  return Math.max(0, Math.round(HOLE.GROWTH_K * (Math.pow(t, 1 / HOLE.GROWTH_P) - 1)));
}

/**
 * Names reach innerHTML in the kill feed, the HUD board and the end screen.
 * Same rule as the lobby's editor: strip anything that could be *designed* to
 * look like markup rather than relying on escaping at every destination.
 */
const NAME_BANNED = /[<>&"\u0027\u0060\\\u0000-\u001f\u007f]/g;

function safeName(raw) {
  return String(raw == null ? '' : raw)
    .replace(NAME_BANNED, '')
    .replace(/\s+/g, ' ')
    .slice(0, 16)
    .trim();
}

export class Game {
  constructor(canvas, uiRoot) {
    this.engine = new Engine(canvas);
    this.registry = new EntityRegistry();
    this.effects = new Effects(this.engine.scene);
    this.consume = new ConsumeSystem(this.engine.scene, this.registry, this.effects);
    this.input = new Input(canvas);
    this.match = new Match();
    this.screens = new Screens(uiRoot);
    this.hud = null;
    this.uiRoot = uiRoot;
    this.rng = makeRNG(0xa11ce);
    this.clock = new THREE.Clock();
    this.holes = [];
    this.bots = [];
    this.player = null;
    /** The meta layer's Shell, once installed. Null if it failed to load. */
    this.meta = null;
    /** The mode the CURRENT round is being played under. Never null. */
    this.mode = getMode('classic');
    /** Match length in seconds for this round — mode.duration, not MATCH.DURATION. */
    this.matchDuration = MATCH.DURATION;
    /** Team roster when the mode has teams:2, else null. */
    this.teams = null;
    /** Last Hole Standing's closing ring, else null. */
    this.shrink = null;
    this._acc = 0;
    this._frames = 0;
    this._fpsT = 0;
    this.fps = 60;
  }

  async init() {
    const eng = this.engine;
    buildEnvironment(eng.renderer, eng.scene);
    // Let the loading screen paint before the synchronous city build blocks.
    // Deliberately NOT requestAnimationFrame: a backgrounded tab never fires it
    // and boot would hang, which breaks automated screenshotting.
    await new Promise((r) => setTimeout(r, 40));

    /* --- multiplayer: connect BEFORE building, we need the room's seed ---- */
    // World generation is fully deterministic from a seed, so every client in
    // a room builds a byte-identical city with identical Consumable ids. That
    // is what lets us replicate events ("object 8241 was eaten") instead of
    // replicating the world.
    this.netCfg = readNetConfig();
    this.net = null;
    let worldSeed = 20260803;
    if (this.netCfg.enabled) {
      this.screens.showLoading(`Joining “${this.netCfg.room}”…`);
      const net = new NetClient(this.netCfg);
      const ok = await net.connect();
      if (ok) {
        this.net = net;
        worldSeed = net.seed;
        this.consume.networked = true;
        console.info(`[net] joined room "${this.netCfg.room}" as #${net.id}, seed ${worldSeed}`);
      } else {
        console.warn(`[net] could not join (${net.error}); falling back to offline`);
      }
      this.screens.showLoading('Building Miami…');
    }

    this.worldSeed = worldSeed;
    const { layout, ctx } = buildWorld(eng.scene, this.registry, eng.renderer, worldSeed);
    this.layout = layout;
    // Hand the authoritative geometry to the two systems that place holes on
    // the map. Both of them reconstruct the bay edge and the river bend from
    // constants when they are not given a layout, and that reconstruction does
    // not know about the marina basins, the Brickell Key cuts or the exact
    // bridge decks — which is how a bot ends up steering into the water.
    this.match.layout = layout;
    this.worldCtx = ctx;
    this.allConsumables = (ctx && ctx.allConsumables) || [];
    this.trafficUpdate = eng.scene.userData.trafficUpdate || null;
    this.pedestrianUpdate = eng.scene.userData.pedestrianUpdate || null;
    this.waterUniforms = eng.scene.userData.waterUniforms || null;

    /* --- see-through fade for anything that hides the hole --------------- */
    this.occlusion = new OcclusionSystem(eng.camera);
    // Content modules advertise what may be faded. Fall back to walking the
    // building group so this keeps working if a module forgets to opt in.
    // ONLY large structures fade. A tree, a car, a bench or a sign that
    // dissolves as you drive past reads as a rendering fault, not as a
    // camera aid — and with thousands of small props on screen it would make
    // the whole city shimmer. Anything below this footprint stays solid and
    // the player reads the hole's position from the ground cut instead.
    //
    // MEASURED, and lowered from 6 m x 8 m. That height gate was excluding 48
    // of the city's 352 buildings — every single-storey retail block, some of
    // them 37 m across and 7.7 m tall. At a 54-degree camera a 7.7 m parapet
    // hides ~5.6 m of ground behind it, which is more than enough to swallow a
    // small hole whole; "the player's hole hidden behind geometry with no fade"
    // is an automatic review failure. Nothing prop-scale can slip in at 5 m x
    // 5 m either: this list only ever contains buildings, and the smallest one
    // in the city is a 12 m-wide storefront.
    const FADE_MIN_RADIUS = 5;
    const FADE_MIN_HEIGHT = 5;
    const _fb = new THREE.Box3();
    const bigEnough = (o) => {
      _fb.setFromObject(o);
      if (!Number.isFinite(_fb.min.x)) return false;
      const w = _fb.max.x - _fb.min.x, d = _fb.max.z - _fb.min.z;
      const h = _fb.max.y - _fb.min.y;
      return Math.hypot(w, d) / 2 >= FADE_MIN_RADIUS && h >= FADE_MIN_HEIGHT;
    };

    const fadeables = (ctx && ctx.fadeableBuildings) || null;
    const candidates = (fadeables && fadeables.length)
      ? fadeables
      : ['buildings', 'structures']
          .map((n) => eng.scene.getObjectByName(n))
          .filter(Boolean)
          .flatMap((g) => g.children);

    let skipped = 0;
    /** Every root that is allowed to fade, kept so a restart can re-arm them. */
    this.fadeRoots = [];
    for (const o of candidates) {
      if (bigEnough(o)) { this.occlusion.register(o); this.fadeRoots.push(o); }
      else skipped++;
    }
    /**
     * Buildings that were swallowed and so dropped from the fade set. They come
     * back — props respawn after 30 s and a restart restores the whole city —
     * and a building that is standing again but is no longer a fade candidate
     * is a hole you cannot see behind a tower. Polled rather than hooked
     * because consume.js exposes no restore callback.
     * @type {import('./gameplay/entities.js').Consumable[]}
     */
    this._occSuspended = [];
    // Same roots the fade uses: the camera boom must not pass through them.
    // One ray a frame, against the identical bounding-sphere set the occlusion
    // pass already walks seven times.
    eng.camColliders = this.fadeRoots;
    console.info(
      `[game] occlusion candidates: ${this.occlusion.candidates.length} ` +
      `(${skipped} too small to fade)`
    );

    this.hud = new HUD(this.uiRoot, eng.camera);
    // The meta layer is glass, so anything left under it shows through. frame()
    // hides the HUD outside a match, but the first frame may be seconds away on
    // a slow device and the lobby must never open over a ghost score panel.
    this.hud.root.style.opacity = '0';

    this._wireNet();

    this._tierReached = 0;
    this.consume.onSwallow = (hole, c, gained, remote) => {
      if (this.net && !remote && hole.isPlayer) this.net.reportAte(c.id);
      if (c.tier.id >= 5 && this.hud) {
        this.hud.pushFeed(
          `<b>${hole.name}</b> devoured a ${c.label}`,
          `#${hole.color.getHexString()}`
        );
      }
      // A swallowed building must stop being a fade candidate, or the system
      // keeps raycasting against geometry that is halfway down the pit. Queue
      // it for re-arming: it is coming back.
      if (c.object && c.object.userData.__occRegistered) {
        this.occlusion.unregister(c.object);
        this._occSuspended.push(c);
      }
      if (hole.isPlayer && !remote) {
        const st = this.match.stats;
        if (st) {
          st.devoured++;
          if (c.score > st.biggestMealScore) {
            st.biggestMealScore = c.score;
            st.biggestMeal = c.label;
          }
          st.peakRadius = Math.max(st.peakRadius, hole.radius);
        }
        this._trackChallenge(c);
      }
      if (hole.isPlayer) {
        if (c.crumbles || c.tier.id >= 6) audio.crumble(Math.min(1, c.radius / 22));
        else audio.chomp(Math.min(1, c.radius / 5));
        if (c.tier.id >= 6) this.engine.flash(0.18, 0xffe6b0);
      }
    };
    this.consume.onHoleEaten = (a, b) => {
      if (this.hud) {
        this.hud.pushFeed(
          `<b>${a.name}</b> swallowed <b>${b.name}</b>`,
          `#${a.color.getHexString()}`
        );
      }
      const st = this.match.stats;
      if (st) { if (a.isPlayer) st.rivalsEaten++; if (b.isPlayer) st.timesEaten++; }
      if (a.isPlayer) { this.engine.flash(0.30, 0xffffff); audio.devourPlayer(); }
      if (b.isPlayer) { this.engine.flash(0.45, 0xff3d8b); audio.death(); }
    };

    // Browsers only allow audio after a gesture, so arm it on the first one.
    const armAudio = () => {
      audio.unlock();
      audio.startMusic();
      window.removeEventListener('pointerdown', armAudio);
      window.removeEventListener('keydown', armAudio);
    };
    window.addEventListener('pointerdown', armAudio);
    window.addEventListener('keydown', armAudio);

    this.match.onPhase = (p) => this._onPhase(p);
    this.match.onFrenzy = (on) => {
      this.consume.setFrenzy(on);
      if (this.hud) this.hud.pushFeed('<b>FRENZY</b> — everything is edible!', '#ffc93c');
    };
    this.match.onRespawn = (h) => {
      // Match re-applies HOLE.RESPAWN_KEEP (and the field-median floor) right
      // after this returns, so the two must not disagree — a hard-coded number
      // here just made the hole snap to a different size for one frame.
      const p = this._spawnPoint();
      h.reset(p.x, p.z, Math.round(h.score * HOLE.RESPAWN_KEEP));
    };

    /* --- modes: the seams the mode data drives ---------------------------- */
    // The clock the day/night cycle was on before a mode pinned it, so a round
    // of Neon Nights does not leave the whole game stuck at dusk afterwards.
    this._bootTimeOfDay = eng.timeOfDay;
    this._bootCyclePaused = !!eng.cyclePaused;
    this._installTeamPvP();
    // Cosmetics only decide what the player's hole LOOKS like, so a catalogue
    // that fails to load must cost the colour and nothing else.
    try { this._cosmetics = await import('./meta/cosmetics.js'); }
    catch (e) { this._cosmetics = null; console.warn('[game] cosmetics unavailable', e); }

    this.screens.onPlay = () => this.startMatch(this.mode && this.mode.id);
    this.screens.onLobby = () => this.returnToLobby();
    this.screens.onMenu = () => this.showLobby();

    /* --- the meta layer --------------------------------------------------- */
    try {
      this.meta = await installMeta(this, this.uiRoot);
    } catch (err) {
      // A front end that cannot boot must not cost the game. Screens keeps a
      // one-button fallback title card for exactly this.
      console.error('[game] meta layer failed to install', err);
      this.meta = null;
    }

    this.screens.clear();
    this.screens.showMenu();
    this.match.phase = PHASE.MENU;

    // Idle camera drifting over the skyline behind the lobby.
    this._menuAngle = 0;

    window.addEventListener('keydown', (e) => {
      // Space is a shortcut for the fallback title card only. In the lobby the
      // space bar belongs to the name field, and starting a match from under
      // the store would be indistinguishable from a crash.
      if (e.code !== 'Space' || this.match.phase !== PHASE.MENU) return;
      if (this.meta && this.meta.visible) return;
      this.startMatch();
    });

    // Escape: pause in, resume out.
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Escape' && e.key !== 'Escape') return;
      const playing = this.match.phase === PHASE.PLAYING || this.match.phase === PHASE.COUNTDOWN;
      if (playing && !(this.meta && this.meta.visible)) {
        e.preventDefault();
        this.openPause();
        return;
      }
      // Only the pause screen itself resumes. Escape while the player is deeper
      // in the menu — reading Settings — should take them back one screen, and
      // the shell already owns that.
      if (playing && this.meta && this.meta.visible) {
        e.preventDefault();
        const at = this.meta._el && this.meta._el.dataset.screen;
        if (at === 'pause') this.resumeFromPause();
        else this.meta.back();
      }
    });

    const { installDevTools } = await import('./dev/devtools.js');
    installDevTools(this);

    // Arriving with ?room= means the player followed an invite. They land in
    // the WAITING ROOM, not mid-match: dropping the first arrival into a live
    // game alone meant their friend joined a round already in progress with a
    // stranger's score on the board. The host starts it when everyone is in.
    //
    // If the connection failed there is no room to wait in, so fall through to
    // an offline match rather than stranding them on a roster of nobody.
    if (this.netCfg.enabled) {
      const q = new URLSearchParams(location.search);
      this._joinMode = q.get('mode') || undefined;
      if (this.net && this.meta) {
        this.meta.show();
        this.meta.reset('prelobby', { code: this.netCfg.room });
      } else {
        this.startMatch(this._joinMode);
      }
    }

    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  /** Bind the network client to the local simulation. Safe to call offline. */
  _wireNet() {
    const net = this.net;
    if (!net) return;

    // A remote player ate something: play the full swallow animation locally so
    // the world stays visually consistent, but credit nobody.
    //
    // Two things must not happen here. Applying it before the local match has a
    // hole means there is nothing to fall into (captureRemote used to be handed
    // null and threw on every id in the batch, which killed the page's frame
    // loop). Applying it after the local match has ended breaks the end-of-match
    // freeze: stepSimulation returns early in RESULTS, so anything started now
    // would hang in mid-air over the results screen until the restart.
    net.onConsumed = (ids) => {
      if (this.match.phase === PHASE.RESULTS) return;
      for (const id of ids) {
        const c = this.registry.byId.get(id);
        if (!c) continue;
        const eater = this._nearestHoleTo(c) || this.player;
        this.consume.captureRemote(eater, c, this.clock.elapsedTime);
      }
    };

    // The server owns the match clock for the whole room. When it starts the
    // next round the local match has to follow it: without this a client that
    // reached its own results screen sat there for ever, stopped sending state,
    // and was evicted by the server's silence timeout — so multiplayer worked
    // for exactly one match and then died.
    net.onMatch = (d) => {
      // The host pressed start, or the previous round ended. Either way the
      // server owns the transition and every client follows it, so nobody is
      // playing while somebody else is still on the roster.
      if (d.phase === 'playing' && this.match.phase !== PHASE.PLAYING
          && this.match.phase !== PHASE.COUNTDOWN) {
        this.startMatch(this._joinMode);
      }
      if (d.phase === 'lobby' && this.meta) {
        // Back to the waiting room between rounds.
        this.paused = false;
        this.meta.show();
        this.meta.reset('prelobby', { code: this.netCfg ? this.netCfg.room : '' });
      }
      if (typeof d.timeLeft === 'number') this.match.timeLeft = d.timeLeft;
    };

    net.onKill = (killerId, victimId, reward) => {
      const killer = this._holeForNet(killerId);
      const victim = this._holeForNet(victimId);
      if (!victim) return;
      victim.alive = false;
      victim.killedBy = killer || null;
      victim.respawnAt = HOLE.RESPAWN_TIME;
      if (killer) {
        this.effects.shockwave(killer.position, killer.radius, killer.radius * 3.6,
          victim.color.getHexString ? victim.color.getHex() : 0xffffff, 0.8);
      }
      if (this.hud && killer) {
        this.hud.pushFeed(`<b>${killer.name}</b> swallowed <b>${victim.name}</b>`,
          `#${killer.color.getHexString()}`);
      }
      if (victim.isPlayer) { this.engine.flash(0.45, 0xff3d8b); audio.death(); }
      else if (killer && killer.isPlayer) { this.engine.flash(0.30, 0xffffff); audio.devourPlayer(); }
    };

    net.onRoster = () => this._syncPeerHoles();

    // A dropped socket used to be invisible: the rivals stopped moving, nothing
    // else was ever eaten, and the round played out in an empty city with no
    // hint that the room had gone.
    net.onDisconnect = () => {
      console.warn('[net] connection lost — finishing this round offline');
      for (const p of net.peers.values()) {
        if (p.hole) p.hole.alive = false;
      }
      net.peers.clear();
      this._syncPeerHoles();
      if (this.hud) this.hud.pushFeed('<b>Disconnected</b> from the room', '#ff9f43');
    };

    this.consume.onClaimKill = (victim) => {
      if (victim.netId != null) net.claimKill(victim.netId);
    };
  }

  /** Create/destroy Hole avatars so they match the server roster. */
  _syncPeerHoles() {
    const net = this.net;
    if (!net) return;
    // startMatch() disposes every hole in the list, peers included, but the
    // peer record still points at the dead one. Without this the `if (p.hole)`
    // guard below matched a disposed avatar and quietly refused to rebuild it,
    // so from the second round on an online match showed no rivals at all.
    for (const p of net.peers.values()) {
      if (p.hole && !this.holes.includes(p.hole)) p.hole = null;
    }
    for (const p of net.peers.values()) {
      if (p.hole) continue;
      const h = new Hole({ type: 'remote', name: p.name, color: p.color, x: 0, z: 0 });
      h.netId = p.id;
      p.hole = h;
      this.engine.scene.add(h.group);
      this.holes.push(h);
    }
    // Drop avatars whose peer has gone.
    for (let i = this.holes.length - 1; i >= 0; i--) {
      const h = this.holes[i];
      if (h.type !== 'remote') continue;
      if (net.peers.has(h.netId)) continue;
      this.engine.scene.remove(h.group);
      h.dispose();
      this.holes.splice(i, 1);
    }
    this.match.holes = this.holes;
  }

  _holeForNet(id) {
    if (this.net && id === this.net.id) return this.player;
    for (const h of this.holes) if (h.netId === id) return h;
    return null;
  }

  /** Best guess at which hole ate an object, for the remote-swallow animation. */
  _nearestHoleTo(c) {
    let best = null, bd = Infinity;
    for (const h of this.holes) {
      if (!h.alive) continue;
      const d = Math.hypot(h.position.x - c.position.x, h.position.z - c.position.z);
      if (d < bd) { bd = d; best = h; }
    }
    return best;
  }

  /**
   * @param {number} salt  0 uses the shared city RNG (offline: the player and
   *   each bot draw in turn, so they all differ). Anything else draws from its
   *   own stream keyed on that number.
   *
   * The salt exists for multiplayer. The city RNG is seeded from the room seed
   * and every client runs it through exactly the same sequence, so every player
   * asking for "a spawn point" was handed the SAME square metre — two players
   * materialised inside one another and whoever grew first ate the other before
   * either had touched a key. Keyed on the network id, each player gets their
   * own point and every client agrees about where everyone started.
   */
  _spawnPoint(salt = 0) {
    const rng = salt
      ? makeRNG(((this.worldSeed ?? 0) ^ Math.imul(salt, 2654435761)) >>> 0)
      : this.rng;
    // Spread spawns across both districts, never on water or inside a tower.
    for (let tries = 0; tries < 60; tries++) {
      const brickell = rng() < 0.5;
      const x = rng.range(-WORLD.SIZE * 0.75, WORLD.BAY_EDGE - 50);
      const z = brickell
        ? rng.range(WORLD.RIVER_HALF_W + 50, WORLD.SIZE * 0.8)
        : rng.range(-WORLD.SIZE * 0.8, -WORLD.RIVER_HALF_W - 50);
      if (this.layout.isWater(x, z)) continue;
      return { x, z };
    }
    return { x: 0, z: 120 };
  }

  /**
   * Put the world back to its just-built state.
   *
   * Recreating the holes is not enough: by the end of a round thousands of
   * objects are eaten, mid-fall, mid-topple or queued to respawn, traffic and
   * crowds have wandered, and the effects pools are full. Everything that
   * carries state across a match has to be rewound, or the next round starts
   * on a half-eaten city with phantom collisions.
   */
  resetWorld() {
    const r = this.consume.resetAll(this.allConsumables);

    // Push every restored instance matrix to the GPU in one go, or the city
    // stays visually eaten even though the simulation says otherwise.
    if (this.worldCtx && this.worldCtx.props) {
      for (const pool of this.worldCtx.props.pools.values()) {
        pool._dirtyAll = true;
        pool.flush();
      }
    }

    // Content modules may expose their own rewind (traffic queues, crowd
    // agents). Optional by design: a module without one is still correct,
    // because its objects were just restored above.
    const ud = this.engine.scene.userData;
    if (typeof ud.trafficReset === 'function') ud.trafficReset();
    if (typeof ud.pedestrianReset === 'function') ud.pedestrianReset();

    // Clear anything still in flight visually.
    this.effects.popups.length = 0;
    this.effects.shake = 0;
    this.engine.flash(0);
    if (this.occlusion) {
      // Re-arm every building the last match ate. Without this the fade set
      // shrinks by one for every tower swallowed and never grows back, so by
      // the third round most of Brickell no longer x-rays.
      for (const root of this.fadeRoots) this.occlusion.register(root);
      this._occSuspended.length = 0;
      this.occlusion.resetAll();
    }
    this._tierReached = 0;

    console.info(
      `[game] world reset: ${r.restored} objects restored ` +
      `(${r.wasGone} eaten, ${r.wasFalling} mid-fall, ${r.wasTilted} tilted)`
    );
    return r;
  }

  /**
   * Begin a round.
   *
   * @param {string} [modeId] a src/gameplay/modes.js id. Omitted keeps the mode
   *   the last round was played under, which is what "Play Again" wants.
   */
  startMatch(modeId) {
    this.paused = false;
    const mode = getMode(modeId || (this.mode && this.mode.id));
    this.mode = mode;
    if (this.meta) this.meta.hide();
    uiState.reset();
    // Mode-locked dailies filter on this, and it must be set BEFORE the first
    // swallow reports a challenge track.
    try { progression.setActiveMode(mode.id); }
    catch (e) { console.warn('[game] setActiveMode failed', e); }

    // Rewind the city before anything else, so the new match starts on a
    // complete map rather than on the leftovers of the last one.
    this.resetWorld();
    this._applyModeScoring(mode);
    this._applyModeTimeOfDay(mode);

    for (const h of this.holes) {
      this.engine.scene.remove(h.group);
      h.dispose();
    }
    this.holes.length = 0;
    this.bots.length = 0;

    const startScore = scoreForRadius(mode.startRadius);
    const p = this._spawnPoint(this.net ? this.net.id : 0);
    this.player = new Hole({
      type: 'player',
      name: this.playerName(),
      color: this._playerColor(),
      x: p.x, z: p.z,
    });
    if (this.net) this.player.netId = this.net.id;
    this.engine.scene.add(this.player.group);
    this.holes.push(this.player);

    if (this.net) {
      // Online it is real players only: bots are simulated per-client and would
      // desync instantly, so a room of humans is exactly what everyone sees.
      this._syncPeerHoles();
    } else {
      this.bots = spawnBots(
        Math.max(0, mode.botCount ?? MATCH.BOT_COUNT),
        this.registry, this.rng, () => this._spawnPoint(), this.layout
      );
      for (const b of this.bots) {
        this.engine.scene.add(b.hole.group);
        this.holes.push(b.hole);
      }
    }

    // Every hole opens at the mode's starting size. reset() re-solves radius
    // from score through the same curve the rest of the match uses, so nothing
    // here can disagree with Hole.radiusFor.
    if (startScore > 0) {
      for (const h of this.holes) h.reset(h.position.x, h.position.z, startScore);
    }

    this._applyTeams(mode);

    this.consume.setFrenzy(false);
    this.match.start(this.holes, mode);
    this._applyModeDuration(mode);
    this._startShrink(mode);
    this.engine._camTarget.copy(this.player.position);
    // A round must never open on a boom still retracted into last round's wall.
    this.engine._boom = 1;
  }

  /* ======================================================================= */
  /*  MODES                                                                  */
  /* ======================================================================= */

  /**
   * Stamp the mode's scoring onto the city.
   *
   * Every consumable carries the points it is worth, and the swallow path, the
   * floating "+N", the HUD and the bot value function all read that one field.
   * Rewriting it once per match is therefore the whole of `scoreFor` — no
   * conditional anywhere in the hot path, and Car Crunch's worthless bench is
   * still perfectly edible, it simply pays nothing.
   */
  _applyModeScoring(mode) {
    const all = this.allConsumables;
    if (!all || !all.length) return;
    const scoreFor = typeof mode.scoreFor === 'function' ? mode.scoreFor : null;
    let changed = 0;
    for (const c of all) {
      // The authored value, captured the first time we ever touch this object.
      if (c.__baseScore === undefined) c.__baseScore = c.score;
      // Restore before asking: modes.js's `base(c)` reads c.score, so handing
      // it last round's already-modified number would compound every match.
      c.score = c.__baseScore;
      if (!scoreFor) continue;
      let v;
      try { v = scoreFor(c); }
      catch { v = c.__baseScore; }
      v = Math.max(0, Math.round(Number(v) || 0));
      if (v !== c.score) { c.score = v; changed++; }
    }
    console.info(`[game] mode "${mode.id}": rescored ${changed}/${all.length} objects`);
  }

  /** Pin the clock for a mode that wants one, or hand it back to the cycle. */
  _applyModeTimeOfDay(mode) {
    if (typeof mode.timeOfDay === 'number') this.engine.setTimeOfDay(mode.timeOfDay, true);
    else this.engine.setTimeOfDay(this._bootTimeOfDay ?? 0.35, this._bootCyclePaused);
  }

  /**
   * Match length. Match.start() always arms MATCH.DURATION because that is the
   * only length it knows about, so the mode's length is written straight after
   * — the countdown phase does not touch the clock, so nothing is lost.
   */
  _applyModeDuration(mode) {
    const dur = Math.max(30, Math.round(mode.duration || MATCH.DURATION));
    this.matchDuration = dur;
    this.match.timeLeft = dur;
    // MATCH.ANNOUNCE_AT is in absolute seconds against the default length, so
    // on a 90 s event round "2:00 remaining" would fire on the first tick.
    // Marking the unreachable milestones as already spoken keeps the escalation
    // honest without forking match.js.
    for (const at of MATCH.ANNOUNCE_AT) {
      if (at >= dur) this.match._announced.add(`t${at}`);
    }
  }

  /**
   * Deal holes into two teams and recolour them.
   *
   * The player is always on team 0 and the bots alternate from team 1, so an
   * eight-hole lobby splits 4/4 with the player's side one bot short. Colour is
   * not decoration here: it is the only way to tell at a glance whether the
   * hole bearing down on you is a threat or a teammate.
   */
  _applyTeams(mode) {
    if (mode.teams !== 2) {
      this.teams = null;
      for (const h of this.holes) h.team = 0;
      return;
    }
    this.teams = TEAMS;
    let n = 0;
    for (const h of this.holes) {
      h.team = h.isPlayer ? 0 : (n++ % 2 === 0 ? 1 : 0);
      this._recolorHole(h, TEAMS[h.team].hex);
    }
  }

  /** Repaint every surface that carries a hole's identity colour. */
  _recolorHole(h, hex) {
    h.color.setHex(hex);
    if (h.pitMaterial) h.pitMaterial.uniforms.uTint.value.setHex(hex);
    if (h.lipUniforms) h.lipUniforms.uOwner.value.setHex(hex);
    if (h.burstMaterial) h.burstMaterial.color.setHex(hex);
  }

  /**
   * Team Devour forbids swallowing a teammate, and consume.js resolves PvP
   * against a flat list with no concept of teams.
   *
   * Rather than fork or duplicate that resolver — it owns the size ratio, the
   * overlap test, the kill reward, the shockwave and the net claim — it is
   * handed one CROSS-TEAM PAIR at a time. Same complexity, same rules, and a
   * teammate is simply never a candidate. Installed once; free-for-all modes
   * take the original path untouched.
   */
  _installTeamPvP() {
    const base = ConsumeSystem.prototype._resolvePvP;
    const pair = [null, null];
    this.consume._resolvePvP = (holes) => {
      if (!this.teams) { base.call(this.consume, holes); return; }
      for (let i = 0; i < holes.length; i++) {
        for (let j = i + 1; j < holes.length; j++) {
          if (holes[i].team === holes[j].team) continue;
          pair[0] = holes[i];
          pair[1] = holes[j];
          base.call(this.consume, pair);
        }
      }
      pair[0] = pair[1] = null;
    };
  }

  /* -------------------------------------------------- the closing ring --- */

  _startShrink(mode) {
    if (!mode.shrink) {
      this.shrink = null;
      if (this.ringGroup) this.ringGroup.visible = false;
      return;
    }
    const from = this.matchDuration * Math.min(0.9, Math.max(0, mode.shrink.startAt ?? 0.25));
    this.shrink = {
      cx: RING_CX,
      cz: 0,
      r0: RING_R0,
      r1: Math.max(40, mode.shrink.endRadius || 90),
      from,
      to: Math.max(from + 10, this.matchDuration * RING_CLOSED_AT),
      radius: RING_R0,
      announced: false,
    };
    this._ensureRing();
    this.ringGroup.visible = false;      // only once it starts moving
  }

  /** Two additive rings on the ground: a hard line and a soft shoulder. */
  _ensureRing() {
    if (this.ringGroup) return;
    const g = new THREE.Group();
    g.name = 'shrink-ring';
    const band = (inner, opacity) => {
      const geo = new THREE.RingGeometry(inner, 1.0, 128, 1);
      geo.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: 0xff3d8b,
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }));
      m.frustumCulled = false;
      m.renderOrder = 5;
      g.add(m);
      return m;
    };
    // Widths are fractions of the ring radius, so the wall stays the same
    // apparent thickness whether it is 600 m across or 90.
    this.ringGlow = band(0.93, 0.16);
    this.ringLine = band(0.988, 0.85);
    g.position.y = 0.35;
    g.visible = false;
    this.engine.scene.add(g);
    this.ringGroup = g;
  }

  /**
   * Close the play area and hold every hole inside it.
   *
   * A hard wall rather than damage: this game has no health, and "you stop
   * growing outside the ring" is enforced by there being no outside — pushed
   * back onto the shrinking island, a hole that is losing has to fight for the
   * same block as everyone else, which is the point of the mode.
   */
  _updateShrink(dt) {
    const s = this.shrink;
    if (!s) return;
    const e = this.match.elapsed;
    const k = Math.min(1, Math.max(0, (e - s.from) / Math.max(1, s.to - s.from)));
    s.radius = s.r0 + (s.r1 - s.r0) * (k * k * (3 - 2 * k));

    if (k > 0) {
      if (!s.announced) {
        s.announced = true;
        if (this.hud) this.hud.pushFeed('<b>THE RING IS CLOSING</b>', '#ff3d8b');
      }
      this.ringGroup.visible = true;
      this.ringGroup.position.set(s.cx, 0.35, s.cz);
      this.ringGlow.scale.set(s.radius, 1, s.radius);
      this.ringLine.scale.set(s.radius, 1, s.radius);
    }

    for (const h of this.holes) {
      if (!h.alive) continue;
      const dx = h.position.x - s.cx;
      const dz = h.position.z - s.cz;
      const d = Math.hypot(dx, dz);
      // Measured to the hole's own rim, so a 30 m hole is not half outside.
      const lim = Math.max(8, s.radius - h.radius);
      if (d <= lim) continue;
      const inv = lim / (d || 1);
      h.position.x = s.cx + dx * inv;
      h.position.z = s.cz + dz * inv;
      h.velocity.x *= 0.2;
      h.velocity.z *= 0.2;
      h.syncVisual();
    }
  }

  /* ------------------------------------------------------------ player --- */

  /** The name this player's hole carries. Profile first, then the net config. */
  playerName() {
    let n = '';
    try { n = safeName(profile.data.name); } catch { n = ''; }
    if (!n && this.net) n = safeName(this.netCfg.name);
    return n || 'You';
  }

  /** Equipped skin's rim colour, or the house pink if cosmetics are missing. */
  _playerColor() {
    if (!this._cosmetics) return PALETTE.ACCENT_HOT;
    try {
      const id = profile.data.equipped && profile.data.equipped.skin;
      const c = this._cosmetics.skinColors(id);
      return new THREE.Color(c.rim || c.glow || PALETTE.ACCENT_HOT).getHex();
    } catch {
      return PALETTE.ACCENT_HOT;
    }
  }

  /** Fold one swallow into the daily challenges that count object kinds. */
  _trackChallenge(c) {
    const kind = String((c && c.kind) || '');
    let track = null;
    if (CH.vehicle.test(kind)) track = 'vehicles';
    else if (CH.person.test(kind)) track = 'people';
    else if (c && (c.crumbles || (c.tier && c.tier.id >= 6) || CH.building.test(kind))) {
      track = 'buildings';
    }
    if (!track) return;
    // A broken daily must never be able to interrupt a swallow.
    try { progression.progressChallenge(track, 1); } catch { /* ignore */ }
  }

  _onPhase(p) {
    if (p === PHASE.COUNTDOWN) this.screens.showCountdown(this.match.countdown);
    if (p === PHASE.PLAYING) this.screens.clear();
    if (p === PHASE.RESULTS) {
      if (this.player) this.player.desiredDir.set(0, 0);
      for (const b of this.bots) b.hole.desiredDir.set(0, 0);
      audio.stopMusic();
      const summary = this._finalSummary();
      this.screens.showResults(summary, this.player, this._grantRewards(summary));
    }
  }

  /**
   * How the round is reported.
   *
   * Free-for-all is whatever Match ranked. Team Devour is decided on POOLED
   * score, so the placement the player is shown — and the placement their
   * rewards, their win count and their leaderboard row are computed from — is
   * their team's, not their own.
   */
  _finalSummary() {
    const s = this.match.summary(this.player);
    s.mode = this.mode;
    if (!this.teams) return s;

    const totals = [0, 0];
    for (const h of this.holes) totals[h.team | 0] += h.score;
    const mine = this.player ? (this.player.team | 0) : 0;
    const other = mine === 1 ? 0 : 1;
    s.teams = TEAMS
      .map((t, i) => ({
        id: t.id,
        name: t.name,
        color: `#${t.hex.toString(16).padStart(6, '0')}`,
        score: Math.round(totals[i]),
        mine: i === mine,
      }))
      .sort((a, b) => b.score - a.score);
    s.won = totals[mine] > totals[other];
    s.rank = totals[mine] >= totals[other] ? 1 : 2;
    s.total = 2;
    return s;
  }

  /**
   * Pay the round out. Both halves are isolated: a progression bug or an
   * unreachable leaderboard must cost the player their XP line, never their
   * end screen.
   */
  _grantRewards(summary) {
    let breakdown = null;
    try {
      breakdown = progression.grantMatchRewards({
        ...summary,
        mode: this.mode.id,
        durationSec: Math.round(this.match.elapsed),
      });
    } catch (err) {
      console.warn('[game] match rewards failed', err);
    }
    try {
      const p = leaderboard.push();
      if (p && typeof p.catch === 'function') {
        p.catch((err) => console.warn('[game] leaderboard push failed', err));
      }
    } catch (err) {
      console.warn('[game] leaderboard push failed', err);
    }
    return breakdown;
  }

  /** Leave the match and go back to the lobby, on a fully restored city. */
  /* ------------------------------------------------------------- pause --- */

  /**
   * Freeze the match and raise the Escape menu.
   *
   * `paused` zeroes dt in the loop rather than stopping it, so the city keeps
   * DRAWING while nothing moves — the point of a pause menu is to look at where
   * you are. The network keeps pumping for the same reason it does on the
   * results screen: a client that stops sending state is dropped by the room's
   * silence timeout, and pausing must not eject you from a multiplayer match.
   */
  openPause() {
    if (!this.meta) return;
    if (this.match.phase !== PHASE.PLAYING && this.match.phase !== PHASE.COUNTDOWN) return;
    this.paused = true;
    // Drop any held direction, or releasing the key behind the menu leaves the
    // hole drifting when play resumes.
    if (this.player) this.player.desiredDir.set(0, 0);
    if (this.input && this.input.reset) this.input.reset();
    if (this.hud) this.hud.root.style.opacity = '0';
    this.meta.show();
    this.meta.reset('pause');
  }

  resumeFromPause() {
    if (!this.meta) return;
    this.meta.hide();
    this.paused = false;
    if (this.input && this.input.reset) this.input.reset();
  }

  /** What the pause card shows about the run so far. */
  pauseSnapshot() {
    const p = this.player;
    const ranks = this.match.rankings ? this.match.rankings() : [];
    const t = Math.max(0, Math.round(this.match.timeLeft || 0));
    return {
      score: p ? p.score : 0,
      diameter: p ? p.radius * 2 : 0,
      rank: p ? (ranks.indexOf(p) + 1 || 0) : 0,
      total: ranks.length,
      timeLeft: `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`,
    };
  }

  returnToLobby() {
    // Leaving from the Escape menu must not carry the freeze out with it, or
    // the lobby's camera drift stops and the next match starts dead.
    this.paused = false;
    this.resetWorld();
    for (const h of this.holes) {
      this.engine.scene.remove(h.group);
      h.dispose();
    }
    this.holes.length = 0;
    this.bots.length = 0;
    this.player = null;
    this.match.holes = [];
    this.match.phase = PHASE.MENU;
    this.teams = null;
    this.shrink = null;
    if (this.ringGroup) this.ringGroup.visible = false;
    // An event that pinned the clock must not leave the lobby stuck at dusk.
    this.engine.setTimeOfDay(this._bootTimeOfDay ?? 0.35, this._bootCyclePaused);
    if (this.hud) this.hud.root.style.opacity = '0';
    this.screens.clear();
    this.screens.showMenu();
  }

  /**
   * Show the front end. Called by screens.showMenu(), which is the seam the
   * rest of the game has always used for "go back to the title".
   */
  showLobby() {
    if (this.meta) {
      this.meta.show();
      this.meta.reset('lobby');
      return;
    }
    this.screens.showFallbackMenu(this.registry.aliveCount);
  }

  /**
   * Join a room by invite code.
   *
   * The city is generated from the ROOM's seed and is built exactly once, at
   * boot — that determinism is what lets the network replicate events instead
   * of geometry. So joining is a reload onto the URL net/client.js already
   * reads, which is the only way to guarantee every client in the room has a
   * byte-identical city.
   */
  joinRoom(info = {}) {
    const code = String(info.code || info.room || '').trim();
    if (!code) {
      if (this.meta) this.meta.toast('That room code is empty', 'bad');
      return;
    }
    const q = new URLSearchParams();
    q.set('room', code);
    const name = this.playerName();
    if (name) q.set('name', name);
    if (info.mode) q.set('mode', String(info.mode));
    location.search = q.toString();
  }

  /**
   * Apply a Settings quality level. `tier` indexes core/quality.js QUALITY_TIERS
   * and `adaptive` is the engine's own downward fallback — which has to be
   * turned off for a fixed level, or the engine quietly overrides the choice.
   */
  applyQuality(level) {
    if (!level) return;
    try {
      QUALITY.adaptive = !!level.adaptive;
      this.engine.setQualityTier(level.tier | 0);
    } catch (err) {
      console.warn('[game] quality change failed', err);
    }
  }

  /** One deterministic simulation tick. Safe to call outside the render loop. */
  stepSimulation(dt) {
    const t = this.clock.elapsedTime;
    const phase = this.match.phase;
    this.match.update(dt);

    // The match is over: nothing moves. Traffic, crowds, bots, physics,
    // scoring and consumption all stop dead so the end screen is presented
    // over a still city rather than one that carries on being eaten.
    //
    // The network is the one exception. It moves no geometry, and a client that
    // stops pumping it stops sending state, never hears the server start the
    // next round, and is dropped by the silence timeout. Remote holes do keep
    // interpolating — the other players really are still playing, and the
    // leaderboard behind the end card should say so.
    if (phase === PHASE.RESULTS) {
      if (this.net && this.player) this.net.update(this.player, t);
      return;
    }

    if (this.trafficUpdate) this.trafficUpdate(dt);
    if (this.pedestrianUpdate) this.pedestrianUpdate(dt);
    if (phase === PHASE.PLAYING || phase === PHASE.COUNTDOWN) {
      if (phase === PHASE.PLAYING && this.player && this.player.alive && !this.devCam) {
        this.player.desiredDir.copy(this.input.update());
      } else if (this.player && this.devCam) {
        this.player.desiredDir.set(0, 0);
      }
      for (const b of this.bots) {
        if (phase === PHASE.PLAYING) b.ctrl.update(dt, this.holes, t);
        else b.hole.desiredDir.set(0, 0);
      }
      for (const h of this.holes) h.update(dt, t);
      // AFTER the holes have moved and BEFORE anything is swallowed, so a hole
      // can never eat from a position the ring has already taken back.
      if (phase === PHASE.PLAYING) this._updateShrink(dt);
      this.consume.update(dt, this.holes, t);
    }
    this._reviveFadeCandidates();
    // Push our state up and advance the interpolated remote holes. Done after
    // the local sim so peers receive the position they will actually see us at.
    if (this.net && this.player) {
      this.net.update(this.player, t);
      if (this.net.serverTimeLeft != null) this.match.timeLeft = this.net.serverTimeLeft;
    }
    // Upload every instance matrix that changed this frame. Without this a
    // prop that has been hidden or animated keeps drawing at its old transform
    // — which is precisely how a consumed prop was being left standing on the
    // ground while its fall played out.
    if (this.worldCtx && this.worldCtx.props) this.worldCtx.props.flushAll();

    this.effects.update(dt);
  }

  /**
   * Put swallowed buildings back into the fade set once they have respawned.
   * O(number currently eaten), and that list is empty for most of a match.
   */
  _reviveFadeCandidates() {
    const q = this._occSuspended;
    if (!q || q.length === 0) return;
    for (let i = q.length - 1; i >= 0; i--) {
      const c = q[i];
      if (c.state !== STATE.IDLE) continue;
      q.splice(i, 1);
      if (c.object) this.occlusion.register(c.object);
    }
  }

  loop() {
    requestAnimationFrame(this.loop);
    const raw = this.clock.getDelta();
    const dt = this.paused ? 0 : Math.min(raw, 1 / 20);
    this._frames++;
    this._fpsT += raw;
    if (this._fpsT >= 0.5) {
      this.fps = this._frames / this._fpsT;
      this._frames = 0; this._fpsT = 0;
    }
    this.frame(dt);
  }

  /**
   * A complete simulate-and-draw pass. Called by the rAF loop, and directly by
   * the dev harness so a fresh frame can be forced even when the tab is hidden.
   */
  frame(dt) {
    const t = this.clock.elapsedTime;
    const phase = this.match.phase;

    if (phase === PHASE.COUNTDOWN && !this.devCam) {
      this.screens.showCountdown(this.match.countdown);
    }

    if (this.waterUniforms) this.waterUniforms.uTime.value = t;

    this.stepSimulation(dt);
    updateHoleUniforms(this.holes, t);

    // Size-tier chime + a rumble bed that grows with the hole.
    if (this.player) {
      let tier = 0;
      for (let i = 0; i < TIER_LIST.length; i++) {
        if (this.player.radius >= TIER_LIST[i].eatRadius) tier = i;
      }
      if (tier > this._tierReached) {
        this._tierReached = tier;
        audio.levelUp(tier);
        if (this.hud) {
          this.hud.pushFeed(`<b>UNLOCKED</b> — ${TIER_LIST[tier].label}`, '#37e6d5');
        }
      }
      audio.updateAmbience(this.player.radius);
    }

    // camera
    if (this.devCam) {
      const c = this.devCam;
      const pitch = THREE.MathUtils.degToRad(c.pitch);
      const yaw = THREE.MathUtils.degToRad(c.yaw);
      const y = Math.sin(pitch) * c.dist;
      const h = Math.cos(pitch) * c.dist;
      this.engine._camTarget.set(c.x, 0, c.z);
      this.engine._dist = c.dist;
      this.engine.camera.position.set(c.x + Math.sin(yaw) * h, y, c.z + Math.cos(yaw) * h);
      this.engine.camera.lookAt(c.x, 0, c.z);
      this.engine._setShadowExtent(THREE.MathUtils.clamp(58 + c.dist * 1.35, 70, 360));
      this.engine.sun.target.position.set(c.x, 0, c.z);
      this.engine.sun.position.set(
        c.x + this.engine.sunDir.x * 320, this.engine.sunDir.y * 320,
        c.z + this.engine.sunDir.z * 320
      );
    } else if (this.player && (phase === PHASE.PLAYING || phase === PHASE.COUNTDOWN || phase === PHASE.RESULTS)) {
      const tgt = this.player.alive
        ? this.player.position
        : (this.player.killedBy ? this.player.killedBy.position : this.player.position);
      this.engine.updateCamera(tgt, this.player.displayRadius, dt, this.effects.shake);
    } else {
      // slow orbit over Brickell behind the menu
      this._menuAngle += dt * 0.055;
      const r = 300;
      const cx = 90 + Math.cos(this._menuAngle) * r;
      const cz = 120 + Math.sin(this._menuAngle) * r;
      this.engine._camTarget.set(cx, 0, cz);
      this.engine._dist = 260;
      this.engine.camera.position.set(cx + 150, 190, cz + 190);
      this.engine.camera.lookAt(cx, 24, cz);
      this.engine.sun.target.position.set(cx, 0, cz);
      this.engine.sun.position.set(
        cx + this.engine.sunDir.x * 320, this.engine.sunDir.y * 320,
        cz + this.engine.sunDir.z * 320
      );
    }

    // HUD
    if (this.devHideUI) {
      // dev screenshots run without chrome
    } else if (this.hud && (phase === PHASE.PLAYING || phase === PHASE.COUNTDOWN)) {
      this.hud.setTimer(this.match.timeLeft);
      this.hud.setLeaderboard(this.holes, this.player);
      if (this.player) this.hud.setSize(this.player);
      this.hud.syncPopups(this.effects, this.engine.camera);
      this.hud.drawMinimap(this.holes, this.player, this.layout);
      this.hud.root.style.opacity = '1';
    } else if (this.hud) {
      // Fully out on the results screen. At 0.25 the frozen leaderboard and a
      // couple of stale feed lines were still legible either side of the end
      // card — it read as a UI that had failed to clear, not as context.
      this.hud.root.style.opacity = '0';
    }

    // Fade anything standing between the camera and the player's hole, and open
    // the shader's x-ray window at the hole's screen position.
    //
    // BOTH must run AFTER the camera block and BEFORE the draw. The raycast is
    // camera-relative, so running it earlier tested last frame's viewpoint —
    // harmless while following at 20 m/s, wrong the moment the dev harness or a
    // respawn teleports the camera. The window is projected with the matrices
    // this frame will actually draw with, in drawing-buffer pixels
    // (gl_FragCoord) rather than CSS pixels.
    if (this.occlusion && this.player) {
      this.engine.camera.updateMatrixWorld();
      this.occlusion.update(dt, this.player.position, this.player.displayRadius);
      const db = this.engine.renderer.getDrawingBufferSize(_bufSize);
      this.occlusion.updateWindow(
        this.player.position, this.player.displayRadius, db.x, db.y
      );
    }

    this.engine.render(dt);
  }
}
