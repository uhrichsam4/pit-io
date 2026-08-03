/**
 * Game: wires the engine, the world, the holes and the UI into one loop.
 */

import * as THREE from 'three';
import { CAMERA, HOLE, MATCH, WORLD, PALETTE, DEBUG } from './config.js';
import { Engine } from './core/engine.js';
import { buildEnvironment } from './core/materials.js';
import { makeRNG } from './core/rng.js';
import { Effects } from './render/effects.js';
import { updateHoleUniforms } from './render/groundShader.js';
import { OcclusionSystem } from './render/occlusion.js';
import { audio } from './core/audio.js';
import { TIER_LIST } from './config.js';
import { EntityRegistry } from './gameplay/entities.js';
import { Hole } from './gameplay/hole.js';
import { ConsumeSystem } from './gameplay/consume.js';
import { Input } from './gameplay/input.js';
import { spawnBots } from './gameplay/ai.js';
import { Match, PHASE } from './gameplay/match.js';
import { buildWorld } from './world/worldBuild.js';
import { HUD } from './ui/hud.js';
import { Screens } from './ui/screens.js';
import { NetClient, readNetConfig } from './net/client.js';

/** Scratch, so the per-frame window update allocates nothing. */
const _bufSize = new THREE.Vector2();

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

    const { layout, ctx } = buildWorld(eng.scene, this.registry, eng.renderer, worldSeed);
    this.layout = layout;
    this.worldCtx = ctx;
    this.trafficUpdate = eng.scene.userData.trafficUpdate || null;
    this.pedestrianUpdate = eng.scene.userData.pedestrianUpdate || null;
    this.waterUniforms = eng.scene.userData.waterUniforms || null;

    /* --- see-through fade for anything that hides the hole --------------- */
    this.occlusion = new OcclusionSystem(eng.camera);
    // Content modules advertise what may be faded. Fall back to walking the
    // building group so this keeps working if a module forgets to opt in.
    const fadeables = (ctx && ctx.fadeableBuildings) || null;
    if (fadeables && fadeables.length) {
      for (const o of fadeables) this.occlusion.register(o);
    } else {
      for (const name of ['buildings', 'structures']) {
        this.occlusion.registerGroup(eng.scene.getObjectByName(name));
      }
    }
    console.info(`[game] occlusion candidates: ${this.occlusion.candidates.length}`);

    this.hud = new HUD(this.uiRoot, eng.camera);

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
      // keeps raycasting against geometry that is halfway down the pit.
      if (c.object) this.occlusion.unregister(c.object);
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
      const p = this._spawnPoint();
      h.reset(p.x, p.z, Math.round(h.score * 0.45));
    };

    this.screens.onPlay = () => this.startMatch();
    this.screens.clear();
    this.screens.showMenu({ objects: this.registry.aliveCount.toLocaleString() });
    this.match.phase = PHASE.MENU;

    // Idle camera drifting over the skyline behind the menu.
    this._menuAngle = 0;

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && this.match.phase === PHASE.MENU) this.startMatch();
    });

    const { installDevTools } = await import('./dev/devtools.js');
    installDevTools(this);

    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  /** Bind the network client to the local simulation. Safe to call offline. */
  _wireNet() {
    const net = this.net;
    if (!net) return;

    // A remote player ate something: play the full swallow animation locally so
    // the world stays visually consistent, but credit nobody.
    net.onConsumed = (ids) => {
      for (const id of ids) {
        const c = this.registry.byId.get(id);
        if (!c) continue;
        const eater = this._nearestHoleTo(c) || this.player;
        this.consume.captureRemote(eater, c, this.clock.elapsedTime);
      }
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

    this.consume.onClaimKill = (victim) => {
      if (victim.netId != null) net.claimKill(victim.netId);
    };
  }

  /** Create/destroy Hole avatars so they match the server roster. */
  _syncPeerHoles() {
    const net = this.net;
    if (!net) return;
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

  _spawnPoint(i = 0, n = 1) {
    // Spread spawns across both districts, never on water or inside a tower.
    for (let tries = 0; tries < 60; tries++) {
      const brickell = this.rng() < 0.5;
      const x = this.rng.range(-WORLD.SIZE * 0.75, WORLD.BAY_EDGE - 50);
      const z = brickell
        ? this.rng.range(WORLD.RIVER_HALF_W + 50, WORLD.SIZE * 0.8)
        : this.rng.range(-WORLD.SIZE * 0.8, -WORLD.RIVER_HALF_W - 50);
      if (this.layout.isWater(x, z)) continue;
      return { x, z };
    }
    return { x: 0, z: 120 };
  }

  startMatch() {
    // reset world state for a fresh round
    for (const h of this.holes) {
      this.engine.scene.remove(h.group);
      h.dispose();
    }
    this.holes.length = 0;
    this.bots.length = 0;

    const p = this._spawnPoint();
    this.player = new Hole({
      type: 'player',
      name: this.net ? this.netCfg.name : 'You',
      color: PALETTE.ACCENT_HOT,
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
      this.bots = spawnBots(MATCH.BOT_COUNT, this.registry, this.rng, () => this._spawnPoint());
      for (const b of this.bots) {
        this.engine.scene.add(b.hole.group);
        this.holes.push(b.hole);
      }
    }

    this.consume.setFrenzy(false);
    this.match.start(this.holes);
    this.engine._camTarget.copy(this.player.position);
  }

  _onPhase(p) {
    if (p === PHASE.COUNTDOWN) this.screens.showCountdown(this.match.countdown);
    if (p === PHASE.PLAYING) this.screens.clear();
    if (p === PHASE.RESULTS) {
      this.screens.showResults(this.match.rankings(), this.player);
    }
  }

  /** One deterministic simulation tick. Safe to call outside the render loop. */
  stepSimulation(dt) {
    const t = this.clock.elapsedTime;
    const phase = this.match.phase;
    this.match.update(dt);
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
      this.consume.update(dt, this.holes, t);
    }
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

    // Fade anything standing between the camera and the player's hole. Runs
    // after movement so it reacts in the same frame the hole slides under a
    // podium, and before the draw so there is no one-frame flash of solid.
    if (this.occlusion && this.player) {
      this.occlusion.update(dt, this.player.position, this.player.displayRadius);
    }

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
      this.hud.root.style.opacity = phase === PHASE.RESULTS ? '0.25' : '0';
    }

    // The shader opens its x-ray window at the hole's screen position, so it
    // must be projected with the camera matrices this frame will actually draw
    // with — hence here, after the camera block, and in drawing-buffer pixels
    // (gl_FragCoord) rather than CSS pixels.
    if (this.occlusion && this.player) {
      const db = this.engine.renderer.getDrawingBufferSize(_bufSize);
      this.occlusion.updateWindow(
        this.player.position, this.player.displayRadius, db.x, db.y
      );
    }

    this.engine.render(dt);
  }
}
