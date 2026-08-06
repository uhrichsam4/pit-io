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
import { VoiceSystem } from './audio/voice.js';
import { install as installPowerups } from './gameplay/powerupGlue.js';
import { install as installEvents } from './gameplay/eventGlue.js';
import { install as installPhone } from './phone/phone.js';
import { mount as mountPhone } from './ui/phone-ui.js';
import { TIER_LIST } from './config.js';
import { EntityRegistry, STATE } from './gameplay/entities.js';
import { Hole } from './gameplay/hole.js';
import { ConsumeSystem } from './gameplay/consume.js';
import { Input } from './gameplay/input.js';
import { spawnBots } from './gameplay/ai.js';
import { Match, PHASE } from './gameplay/match.js';
import { getMode } from './gameplay/modes.js';
import { activeMap } from './gameplay/maps.js';
import { applySnow } from './world/snow.js';
import { setBiome as setNatureBiome } from './world/nature.js';
import { setPropBiome } from './world/props.js';
import { buildWorld } from './world/worldBuild.js';
import { buildBayfront } from './world/bayfront.js';
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
 * How long the waiting room holds before it launches anyway. Mirrors
 * LOBBY_MAX_WAIT in server/server.js — the offline lobby has to feel the same
 * as the online one.
 */
/** What counts as a person for proximity dialogue. Mirrors the `person` matcher
 *  in modes.js so the two cannot drift apart about what a pedestrian is. */
const PERSON_RX = /ped|person|tourist|worker|office|jogger|cyclist|busker|vendor|crowd|diner|waiter|child|kid|baller|courtside|resting|local/i;

/** Seconds outside the ring before the penalty lands. */
const BOUNDS_GRACE = 3;

const LOBBY_WAIT = 30;
/** ...and how many players would make it start early, if there were any. */
const LOBBY_TARGET = 15;

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
    /**
     * Which city this page load is building. Offline the map's own seed picks
     * the layout; in a room the SERVER's seed wins, because every client has to
     * build a byte-identical city for id-based replication to work — but the
     * biome is still a local choice, so a snow room is snowy for whoever picked
     * it without desynchronising anyone.
     */
    this.map = activeMap();
    let worldSeed = this.map.seed;
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
    // BEFORE buildWorld: nature.js swaps species at plant time, and planting
    // happens during the build. Setting it afterwards would be a no-op.
    setNatureBiome(this.map.biome);
    /* Props need the biome too. nature.js swaps SPECIES; props.js swaps PROPS,
       and a potted palm is the latter — 346 of them stood in the snow because
       only half the world was told what season it is. */
    setPropBiome(this.map.biome);
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
    /**
     * The spawn island. Built once and parked far off the city grid, hidden
     * until somebody is waiting in a room — see enterIsland().
     */
    /** Biome pass. Runs on the finished city; see src/world/snow.js. */
    if (this.map.biome === 'snow') {
      applySnow(eng.scene, makeRNG(worldSeed ^ 0x50a1));
    }
    // The colour grade is what actually sells the biome — see maps.js.
    if (this.map.grade && eng.post && eng.post.setBiomeGrade) {
      eng.post.setBiomeGrade(this.map.grade);
    }
    if (this.map.timeOfDay != null && eng.setTimeOfDay) {
      eng.setTimeOfDay(this.map.timeOfDay);
    }

    this.island = buildBayfront(eng.scene);

    this.trafficUpdate = eng.scene.userData.trafficUpdate || null;
    /* Zoo animals, published by animals.js the same way vehicles.js publishes
       traffic. Null when the seed produced no zoo site, which is a legal
       outcome — reserveZoo fails closed rather than putting a zoo in the bay. */
    this.animalUpdate = eng.scene.userData.animalUpdate || null;
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
    /* Dialogue triggers. Driven off the REAL swallow event rather than a timer,
       so people react to what actually happened to them. The VoiceSystem owns
       all the rate limiting — per-line and per-voice cooldowns, a hard cap of
       three concurrent lines, and a distance cutoff — so calling this on every
       swallow is safe; it drops what it cannot afford. */
    this._voiceFor = (hole, c) => {
      if (!this.voice || !hole || !hole.isPlayer || !c) return;
      const kind = c.kind || '';
      let cat = null;
      if (/car|sedan|suv|taxi|van|truck|bus|pickup|scooter|motor/i.test(kind)) cat = 'carDanger';
      else if (/hoop|ballBasket|fenceChain|courtFlood/i.test(kind)) cat = 'court';
      else if (c.tier && c.tier.id >= 3) cat = 'propEaten';
      else if (Math.random() < 0.05) cat = 'notice';
      if (cat) this.voice.say(cat, { x: c.position.x, z: c.position.z });
    };

    /**
     * PROXIMITY DIALOGUE — people react to the hole ARRIVING, not only to being
     * eaten.
     *
     * The swallow trigger below fires when something is consumed, which meant
     * the only way to hear anybody was to destroy them. Walking a hole down a
     * crowded street produced silence, which is the opposite of the brief:
     * pedestrians are supposed to notice at a distance, look, point and panic.
     *
     * Cheap on purpose. It samples on a timer rather than every frame, walks
     * the consumable list once, and stops at the first person close enough —
     * the VoiceSystem's own cooldowns and its hard three-line cap do the rest
     * of the rationing, so this only has to avoid being expensive.
     */
    this._voiceProx = (dt) => {
      if (!this.voice || !this.player || !this.player.alive) return;
      this._proxT = (this._proxT || 0) - dt;
      if (this._proxT > 0) return;
      this._proxT = 1.1;                       // sample about once a second

      const p = this.player.position;
      // Scales with the hole: a 2 m opening is noticed late, a 20 m one early.
      const reach = Math.min(46, 11 + this.player.radius * 2.2);
      const r2 = reach * reach;
      let best = null, bestD2 = r2;
      for (const c of this.allConsumables) {
        if (!c || c.state !== STATE.IDLE) continue;
        if (!PERSON_RX.test(c.kind || '')) continue;
        const dx = c.position.x - p.x, dz = c.position.z - p.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; best = c; }
      }
      if (!best) return;

      // Close enough to be alarming versus merely noticed. Two registers, so a
      // crowd sounds like people at different distances rather than a chorus.
      const near = bestD2 < (reach * 0.45) ** 2;
      this.voice.say(near ? 'flee' : 'notice', { x: best.position.x, z: best.position.z });
    };

    this.consume.onSwallow = (hole, c, gained, remote) => {
      this._voiceFor(hole, c);
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
        /* swallow() is the richer entry point: it runs _describe() on the real
           Consumable — material, mass, tier — and routes to _collapse or _light
           itself. The old split threw all of that away and passed a bare number,
           so a wooden bench and a glass storefront made the same noise. */
        audio.swallow(c, { remote });
        if (c.tier.id >= 6) this.engine.flash(0.18, 0xffe6b0);
      } else if (!remote) {
        /* Rivals make noise too, positioned, so you can hear one working nearby.
           The scheduler's own slot allocator caps concurrency, so this cannot
           storm the mixer. */
        audio.swallow(c, { distant: true });
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
    /* NPC dialogue. Built here but SILENT until a gesture unlocks the audio
       context, and fully functional as captions even if the voice pack was
       never generated — which is the state anyone gets on a fresh clone, so it
       is a first-class path rather than an error case. */
    this.voice = new VoiceSystem({
      rng: Math.random,
      getListener: () => (this.player
        ? { x: this.player.position.x, z: this.player.position.z, radius: this.player.radius }
        : null),
      onCaption: (c) => { if (this.hud && this.hud.showCaption) this.hud.showCaption(c); },
      onCaptionClear: () => { if (this.hud && this.hud.clearCaptions) this.hud.clearCaptions(); },
    });

    /* Power-ups. install() wraps the consume step and sets consume.reachHook,
       so it must run after this.consume exists. It is idempotent — a second
       call replaces the first rather than stacking two wrappers. */
    this.powerups = installPowerups(this);
    /* Storm + police. Wraps consume.onSwallow to feed Heat, so it must install
       AFTER that callback is assigned or it would wrap undefined. */
    this.events = installEvents(this);
    /* The phone. Installs after events, because it reads heat tiers and the
       active event to decide when somebody would plausibly ring you. Its UI is
       mounted separately so a headless harness can drive the call engine with
       no DOM at all. */
    this.phone = installPhone(this);
    if (this.phone && this.uiRoot) {
      try { this.phoneUI = mountPhone(this.uiRoot, this.phone); }
      catch (err) { console.error('[phone] UI mount failed', err); }
    }

    /* Fetch the voice manifest IMMEDIATELY, not on the first gesture.
       It used to load inside armAudio, which fires once and deletes its own
       listeners — so if that single fetch lost a race with anything, the
       manifest stayed empty forever, mode stayed 'captions', and every line
       rendered as text with no voice. That is precisely the reported symptom:
       subtitles appear, nobody speaks. Measured in that state: assets 0,
       played 0, captions 1, with the whole output chain verified healthy
       (voiceBus 0.62, not muted, master 0.85) — nothing was broken except that
       there was no audio to play.
       A JSON fetch needs no AudioContext, and attachContext() promotes the mode
       to 'audio' the moment one exists, so doing it here is strictly earlier
       and strictly safer. */
    this.voice.load('audio/voice/manifest.json');

    const armAudio = () => {
      audio.unlock();
      audio.startMusic();
      // Route dialogue through the engine's own voice bus so the master, mute
      // and ducking controls reach it too — a second independent output would
      // ignore every one of them.
      if (audio.ctx) this.voice.attachContext(audio.ctx, audio.voiceBus || null);
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
        this.enterIsland();
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
        this.enterIsland();
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
   * Is this a legal place to put a hole?
   *
   * The old spawn only asked isWater(), then fell back to a HARDCODED point
   * after sixty misses with no validation at all — so a bad draw or an
   * imperfect water mask could put the player in Biscayne Bay with nothing to
   * eat. "Not water" is also not sufficient: a spawn on an empty lawn is dry
   * and still a dead start, because the whole first minute of this game is
   * eating litter.
   *
   * @returns {{ok:boolean, why:string, props:number}}
   */
  _validateSpawn(x, z) {
    const lim = WORLD.SIZE * 0.86;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return { ok: false, why: 'nan', props: 0 };
    if (Math.abs(x) > lim || Math.abs(z) > lim) return { ok: false, why: 'outside', props: 0 };
    if (this.layout && this.layout.isWater && this.layout.isWater(x, z)) {
      return { ok: false, why: 'water', props: 0 };
    }
    if (x > WORLD.BAY_EDGE - 12) return { ok: false, why: 'bay', props: 0 };
    /* Inside the ring, with margin. Without this the out-of-bounds penalty
       respawned players OUTSIDE the boundary it had just punished them for
       crossing, restarting the countdown on landing — an inescapable loop. */
    const ring = this.shrink;
    if (ring && ring.radius &&
        Math.hypot(x - ring.cx, z - ring.cz) > ring.radius * 0.72) {
      return { ok: false, why: 'outside-ring', props: 0 };
    }

    /* Somewhere to START. A hole opens at 2 m and can only take litter, so a
       spawn is only good if there is litter within a few seconds of it. This is
       the check the old code never made, and the reason a technically-valid
       spawn could still be unplayable. */
    let small = 0;
    let blocked = false;
    for (const c of this.allConsumables) {
      if (!c || c.state !== STATE.IDLE) continue;
      const dx = c.position.x - x, dz = c.position.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 900) continue;
      if (c.radius > 3 && d2 < (c.radius + 2.5) * (c.radius + 2.5)) { blocked = true; break; }
      if (c.tier && c.tier.id <= 1) small++;
    }
    if (blocked) return { ok: false, why: 'inside-object', props: small };
    if (small < 6) return { ok: false, why: 'no-starters', props: small };
    return { ok: true, why: 'ok', props: small };
  }

  /**
   * A validated spawn point.
   *
   * @param {number} salt  0 uses the shared city RNG. Anything else draws from
   *   its own stream keyed on that number — the city RNG is seeded from the
   *   room seed and every client runs the same sequence, so without a salt
   *   every player in a room is handed the SAME square metre.
   */
  _spawnPoint(salt = 0) {
    const rng = salt
      ? makeRNG(((this.worldSeed ?? 0) ^ Math.imul(salt, 2654435761)) >>> 0)
      : this.rng;

    let best = null;
    for (let tries = 0; tries < 240; tries++) {
      const brickell = rng() < 0.5;
      const x = rng.range(-WORLD.SIZE * 0.75, WORLD.BAY_EDGE - 60);
      const z = brickell
        ? rng.range(WORLD.RIVER_HALF_W + 50, WORLD.SIZE * 0.8)
        : rng.range(-WORLD.SIZE * 0.8, -WORLD.RIVER_HALF_W - 50);
      const v = this._validateSpawn(x, z);
      if (v.ok) return { x, z };
      if (v.why === 'no-starters' && (!best || v.props > best.props)) best = { x, z, props: v.props };
    }
    if (best) {
      console.warn(`[spawn] no ideal point in 240 tries; best dry had ${best.props} starters`);
      return { x: best.x, z: best.z };
    }

    /* Deterministic sweep. The old fallback was a hardcoded coordinate checked
       against nothing — if it happened to be water, the player spawned in the
       sea. A grid search can only return a point it has validated. */
    for (let ring = 0; ring < 14; ring++) {
      const r = 40 + ring * 30;
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2;
        const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
        if (this._validateSpawn(x, z).ok) {
          console.warn('[spawn] fell back to grid sweep');
          return { x, z };
        }
      }
    }
    console.error('[spawn] NO valid spawn anywhere — check the layout');
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
    this.leaveIsland();
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
    if (k > 0) this._updateBounds(dt, s);
  }

  /**
   * The ring is a WARNING, not a wall.
   *
   * It used to snap every hole back to the rim and multiply its velocity by 0.2
   * on the same frame — every frame. Standing on the boundary therefore meant
   * being teleported onto the line and having your speed destroyed repeatedly,
   * which is exactly the "permanently stuck on the red circle" report: you were
   * not blocked from turning around, you were being re-pinned faster than you
   * could accelerate away.
   *
   * Now you may leave. Outside, drag builds with depth so it feels wrong to be
   * there, a 3-2-1 clock runs, and driving back in cancels it. Only at zero is
   * there a consequence, and the consequence never leaves you stranded: half
   * your score, and a validated dry respawn you control immediately.
   */
  _updateBounds(dt, s) {
    for (const h of this.holes) {
      if (!h.alive) { h.obTime = 0; continue; }
      const dx = h.position.x - s.cx;
      const dz = h.position.z - s.cz;
      const d = Math.hypot(dx, dz);
      const lim = Math.max(8, s.radius - h.radius);

      if (d <= lim) {
        // Back inside. Cancel, do not decay — returning must be an immediate
        // reprieve or the countdown reads as unfair.
        if (h.obTime) { h.obTime = 0; if (h.isPlayer) this._boundsUI(null); }
        continue;
      }

      const over = d - lim;
      const nx = dx / (d || 1), nz = dz / (d || 1);

      /* Outward motion is resisted, inward motion is not. This is what makes
         turning around work: heading back toward the city you keep full speed,
         so the fix for being outside is always available and always effective. */
      const outward = h.velocity.x * nx + h.velocity.z * nz;
      if (outward > 0) {
        const bite = Math.min(1, over / 45) * 0.85 + 0.15;
        h.velocity.x -= nx * outward * bite;
        h.velocity.z -= nz * outward * bite;
      }
      // A gentle pull home, never a teleport.
      h.velocity.x -= nx * Math.min(over, 30) * 0.22 * dt;
      h.velocity.z -= nz * Math.min(over, 30) * 0.22 * dt;

      // Hard stop well outside, so nobody drives to the horizon during the 3s.
      if (over > 120) {
        h.position.x = s.cx + nx * (lim + 120);
        h.position.z = s.cz + nz * (lim + 120);
        h.syncVisual();
      }

      h.obTime = (h.obTime || 0) + dt;
      if (h.isPlayer) {
        this._boundsUI(Math.max(0, BOUNDS_GRACE - h.obTime), nx, nz, h);
        /* One tick per whole second, rising in urgency. The 3-2-1 was silent —
           audio.outOfBoundsTick() existed with zero call sites. */
        const left = Math.ceil(Math.max(0, BOUNDS_GRACE - h.obTime));
        if (left !== this._obLastTick) { this._obLastTick = left; audio.outOfBoundsTick(left); }
      } else if (h.obTime === 0) this._obLastTick = -1;
      if (h.obTime >= BOUNDS_GRACE) this._boundsPenalty(h);
    }
  }

  /**
   * Ran out of time outside. Halve the score, put them somewhere real, and
   * hand control straight back — the one thing this must never do is produce
   * another stuck player.
   */
  _boundsPenalty(h) {
    h.obTime = 0;
    const before = h.score;
    /* reset() is the one path that rewrites score, radius, display radius and
       tier together. Assigning this.score alone leaves the hole drawn at its
       old size and eating at its old tier. */
    const p = this._spawnPoint(Math.floor(this.match.elapsed * 7) + 13);
    h.reset(p.x, p.z, Math.round(before * 0.5));
    h.spawnGrace = Math.max(h.spawnGrace || 0, HOLE.RESPAWN_GRACE);
    h.alive = true;
    h.respawnAt = 0;
    h.syncVisual();

    if (h.isPlayer) {
      this._boundsUI(null);
      this._obLastTick = -1;
      audio.scorePenalty();
      audio.teleport();
      if (this.hud) {
        const lost = (before - h.score).toLocaleString('en-US');
        this.hud.pushFeed(`<b>OUT OF BOUNDS</b> — lost ${lost}`, '#ff5470');
      }
      this.effects.addShake(0.5);
    }
    this.effects.puff(
      new THREE.Vector3(p.x, 1.2, p.z), h.color.getHex(), 30, h.radius * 1.1, 8, 1.2, 1.0
    );
  }

  /**
   * The warning itself: seconds remaining plus an arrow that points back at the
   * city, rotated into SCREEN space so it agrees with what the camera shows.
   * `null` hides it.
   */
  _boundsUI(secs, nx, nz, h) {
    let el = this._obEl;
    if (secs == null) { if (el) el.classList.remove('on'); return; }
    if (!el) {
      el = document.createElement('div');
      el.className = 'ob-warn';
      el.innerHTML = '<div class="ob-arrow">\u2191</div>'
        + '<div class="ob-num"></div>'
        + '<div class="ob-cap">RETURN TO THE CITY</div>';
      document.body.appendChild(el);
      this._obEl = el;
      this._obNum = el.querySelector('.ob-num');
      this._obArrow = el.querySelector('.ob-arrow');
    }
    el.classList.add('on');
    this._obNum.textContent = String(Math.max(1, Math.ceil(secs)));

    // Direction home in screen space: the angle between where the camera looks
    // and where safety is. Without this the arrow points at a world direction
    // the player has no way to map onto their screen.
    // this.engine.camera — game.js has no `camera` of its own, and reading one
    // threw every frame the warning was up, which would have taken the whole
    // out-of-bounds system down with it.
    const cam = this.engine && this.engine.camera;
    if (cam) {
      const fx = cam.position.x - h.position.x;
      const fz = cam.position.z - h.position.z;
      const ang = Math.atan2(-nx, -nz) - Math.atan2(fx, fz);
      this._obArrow.style.transform = `rotate(${ang}rad)`;
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
    if (p === PHASE.PLAYING) {
      this.screens.clear();
      /* matchStart() and matchEnd() have existed in the audio engine for as
         long as matches have, with ZERO call sites — the round simply began and
         ended in silence. Nothing announced either edge. */
      audio.matchStart();
    }
    if (p === PHASE.RESULTS) {
      if (this.player) this.player.desiredDir.set(0, 0);
      for (const b of this.bots) b.hole.desiredDir.set(0, 0);
      audio.matchEnd(!!(this.player && this.match.leader === this.player));
      /* Every loop must die with the round, or a siren or storm bed carries
         into the results screen and then into the next match. */
      if (audio.stopAllLoops) audio.stopAllLoops();
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
  /* ------------------------------------------------------------ island --- */

  /**
   * Every match now begins in the waiting room, not straight into the city.
   *
   * Online the server owns the rule — fifteen players or thirty seconds,
   * whichever comes first — and this client just waits to be told. Offline
   * there is no server and never will be fifteen players, so the same thirty
   * seconds runs locally against the AI backfill. One entry point either way,
   * so solo and multiplayer cannot drift into behaving differently.
   */
  queueMatch(modeId) {
    this.mode = getMode(modeId || (this.mode && this.mode.id));
    this._joinMode = this.mode.id;
    this.enterIsland();
    // The clock must exist BEFORE the screen mounts. reset() renders and paints
    // immediately, so setting lobbyLeft afterwards meant the first paint read
    // null and the countdown showed an em-dash until the next tick — which is
    // exactly the "is this thing working?" moment a waiting room cannot afford.
    this.lobbyLeft = this.net ? null : LOBBY_WAIT;
    if (this.meta) {
      this.meta.show();
      this.meta.reset('prelobby', { code: this.netCfg && this.netCfg.enabled ? this.netCfg.room : null });
    }
  }

  /** Countdown for the offline waiting room. Returns seconds left, or null. */
  _tickLobby(dt) {
    if (this.lobbyLeft == null) return;
    this.lobbyLeft -= dt;
    if (this.lobbyLeft <= 0) {
      this.lobbyLeft = null;
      this.startMatch(this._joinMode);
    }
  }

  /** Skip the wait. The lobby's own button, and the host's, both land here. */
  startNow() {
    if (this.net) { if (this.net.startMatch) this.net.startMatch(); return; }
    this.lobbyLeft = null;
    this.startMatch(this._joinMode);
  }


  /**
   * Drop the player onto the spawn island to wait in.
   *
   * Reuses the machinery that already exists rather than adding a lobby mode:
   * a normal Hole, the normal follow camera, and the same circular clamp Last
   * Hole Standing uses for its closing ring. The only thing that is special is
   * that nothing here is edible — the island carries no Consumables at all, so
   * "you cannot eat the park" needs no rule.
   */
  enterIsland() {
    if (!this.island) return;
    this.onIsland = true;
    this.island.show();
    this.paused = false;

    for (const h of this.holes) { this.engine.scene.remove(h.group); h.dispose(); }
    this.holes.length = 0;
    this.bots.length = 0;

    const n = this.net && this.net.id ? this.net.id : 1;
    const sp = this.island.spawns[(n - 1) % this.island.spawns.length];
    this.player = new Hole({
      type: 'player', name: this.playerName(), color: this._playerColor(),
      x: sp.x, z: sp.z,
    });
    if (this.net) this.player.netId = this.net.id;
    this.engine.scene.add(this.player.group);
    this.holes.push(this.player);
    if (this.net) this._syncPeerHoles();

    this.engine._camTarget.set(sp.x, 0, sp.z);
    this.engine._boom = 1;
    if (this.hud) this.hud.root.style.opacity = '0';
  }

  leaveIsland() {
    if (!this.island) return;
    this.lobbyLeft = null;
    this.onIsland = false;
    this.island.hide();
  }

  /** Hold every hole inside the island. The ring clamp, on a fixed circle. */
  _clampToIsland() {
    const b = this.island && this.island.bounds;
    if (!b) return;
    for (const h of this.holes) {
      const dx = h.position.x - b.cx, dz = h.position.z - b.cz;
      const d = Math.hypot(dx, dz);
      const lim = Math.max(8, b.r - h.radius);
      if (d <= lim) continue;
      const inv = lim / (d || 1);
      h.position.x = b.cx + dx * inv;
      h.position.z = b.cz + dz * inv;
      h.velocity.x *= 0.2; h.velocity.z *= 0.2;
      h.syncVisual();
    }
  }

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

    // Waiting on the spawn island: the player drives, nothing else runs. The
    // match clock is not started, there are no bots and nothing is edible, so
    // this is deliberately NOT the match path — it is just movement.
    if (this.onIsland) {
      this._tickLobby(dt);
      if (this.player && this.player.alive) {
        this.player.desiredDir.copy(this.input.update());
      }
      for (const h of this.holes) h.update(dt, t);
      this._clampToIsland();
      if (this.net && this.player) this.net.update(this.player, t);
      this.effects.update(dt);
      if (this.voice) { this.voice.update(dt); this._voiceProx(dt); }
      return;
    }

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
    /* Animals get the live hole list so they can flee. They are clamped to
       their own pens inside animals.js — containment is not this loop's job,
       and doing it here would let any other caller bypass it. */
    if (this.animalUpdate) this.animalUpdate(dt, this.holes);
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
      /* The CANONICAL radius, not the surged one. Mass Surge inflates
         hole.radius ~15% and this latch is monotonic, so a surge that grazes a
         tier threshold SPENDS the unlock — chime, feed line and all — and when
         the player genuinely reaches that size `tier > this._tierReached` is
         false and it never announces. The exposed window is the 13% of radius
         below every threshold, so it lands in most matches. */
      const rTier = (this.powerups && typeof this.powerups.baseRadius === 'function')
        ? this.powerups.baseRadius(this.player)
        : this.player.radius;
      let tier = 0;
      for (let i = 0; i < TIER_LIST.length; i++) {
        if (rTier >= TIER_LIST[i].eatRadius) tier = i;
      }
      if (tier > this._tierReached) {
        this._tierReached = tier;
        audio.levelUp(tier);
        if (this.hud) {
          this.hud.pushFeed(`<b>UNLOCKED</b> — ${TIER_LIST[tier].label}`, '#37e6d5');
        }
      }
      /* Position, not just size. updateAmbience doubles as the listener update
         (audio.js:1744) and it was being called with the radius alone, so
         _hasListener stayed false for the whole match and _place() returned
         `pan: 0, att: 1` for everything. Every sound in the game was playing
         dead-centre at full volume no matter where it happened — no stereo, no
         distance falloff, a car tipping over 300 m away exactly as loud as one
         under your feet. */
      audio.updateAmbience(this.player.radius, this.player.position.x, this.player.position.z);
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
    } else if (this.onIsland && this.player) {
      this.engine.updateCamera(this.player.position, this.player.displayRadius, dt, 0);
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
