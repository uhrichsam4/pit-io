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
import { EntityRegistry } from './gameplay/entities.js';
import { Hole } from './gameplay/hole.js';
import { ConsumeSystem } from './gameplay/consume.js';
import { Input } from './gameplay/input.js';
import { spawnBots } from './gameplay/ai.js';
import { Match, PHASE } from './gameplay/match.js';
import { buildWorld } from './world/worldBuild.js';
import { HUD } from './ui/hud.js';
import { Screens } from './ui/screens.js';

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

    const { layout } = buildWorld(eng.scene, this.registry, eng.renderer);
    this.layout = layout;
    this.trafficUpdate = eng.scene.userData.trafficUpdate || null;
    this.waterUniforms = eng.scene.userData.waterUniforms || null;

    this.hud = new HUD(this.uiRoot, eng.camera);

    this.consume.onSwallow = (hole, c) => {
      if (c.tier.id >= 5 && this.hud) {
        this.hud.pushFeed(
          `<b>${hole.name}</b> devoured a ${c.label}`,
          `#${hole.color.getHexString()}`
        );
      }
      if (hole.isPlayer && c.tier.id >= 6) this.engine.flash(0.18, 0xffe6b0);
    };
    this.consume.onHoleEaten = (a, b) => {
      if (this.hud) {
        this.hud.pushFeed(
          `<b>${a.name}</b> swallowed <b>${b.name}</b>`,
          `#${a.color.getHexString()}`
        );
      }
      if (a.isPlayer) this.engine.flash(0.30, 0xffffff);
      if (b.isPlayer) this.engine.flash(0.45, 0xff3d8b);
    };

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
    this.player = new Hole({ type: 'player', name: 'You', color: PALETTE.ACCENT_HOT, x: p.x, z: p.z });
    this.engine.scene.add(this.player.group);
    this.holes.push(this.player);

    this.bots = spawnBots(MATCH.BOT_COUNT, this.registry, this.rng, () => this._spawnPoint());
    for (const b of this.bots) {
      this.engine.scene.add(b.hole.group);
      this.holes.push(b.hole);
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

    this.engine.render(dt);
  }
}
