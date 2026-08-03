/**
 * DEV HARNESS — not shipped in the player-facing build path, but always
 * available on `window.DEV` so automated visual review can drive the game to
 * an exact, repeatable state before screenshotting.
 *
 * Typical use from a headless driver:
 *   DEV.shot('brickell-skyline'); await DEV.settle();
 *   DEV.shot('hole-eating-tower'); await DEV.settle();
 */

import * as THREE from 'three';
import { PHASE } from '../gameplay/match.js';
import { Hole } from '../gameplay/hole.js';

/**
 * Canonical camera setups. Each is {x, z, dist, pitch, yaw, holeR?, note}.
 * x/z are the LOOK-AT point in world space.
 */
export const PRESETS = {
  'menu-hero': { x: 120, z: 150, dist: 420, pitch: 26, yaw: -38, holeR: 6,
    note: 'Wide hero shot of the Brickell skyline from the bay side.' },
  'brickell-skyline': { x: 120, z: 220, dist: 330, pitch: 30, yaw: -40, holeR: 8,
    note: 'Brickell towers, mid-height 3/4.' },
  'downtown-wide': { x: 60, z: -280, dist: 320, pitch: 32, yaw: -35, holeR: 8,
    note: 'Downtown blocks, landmarks and public space.' },
  'street-level': { x: 60, z: 190, dist: 52, pitch: 34, yaw: -35, holeR: 2,
    note: 'Sidewalk detail: props, textures, kerbs, palms.' },
  'hole-small': { x: 60, z: 190, dist: 44, pitch: 54, yaw: -35, holeR: 1.6,
    note: 'Default gameplay framing at start size.' },
  'hole-mid': { x: 40, z: 150, dist: 120, pitch: 54, yaw: -35, holeR: 9,
    note: 'Mid-game framing, cars and palms edible.' },
  'hole-big': { x: 90, z: 170, dist: 300, pitch: 52, yaw: -35, holeR: 30,
    note: 'Late-game: hole swallowing whole city blocks.' },
  'waterfront': { x: 300, z: -140, dist: 220, pitch: 26, yaw: -60, holeR: 6,
    note: 'Biscayne Bay, seawall, marina, boats.' },
  'river': { x: 120, z: 0, dist: 200, pitch: 24, yaw: -35, holeR: 6,
    note: 'Miami River channel and bridges.' },
  'park': { x: 268, z: -180, dist: 130, pitch: 36, yaw: -35, holeR: 4,
    note: 'Bayfront Park: grass, palms, plaza.' },
  'intersection': { x: 0, z: -300, dist: 90, pitch: 46, yaw: -35, holeR: 3,
    note: 'Road markings, crosswalks, traffic.' },
  'construction': { x: -100, z: 260, dist: 140, pitch: 38, yaw: -35, holeR: 5,
    note: 'Construction site and machinery.' },
};

export function installDevTools(game) {
  const DEV = {
    game,
    PRESETS,

    /** Start a match immediately (skips the menu + countdown). */
    play(skipCountdown = true) {
      if (game.match.phase === PHASE.MENU || game.match.phase === PHASE.RESULTS) {
        game.startMatch();
      }
      if (skipCountdown) {
        game.match.countdown = 0;
        game.match._setPhase(PHASE.PLAYING);
        game.screens.clear();
      }
      return this;
    },

    pause(on = true) { game.paused = on; return this; },

    hideUI(on = true) {
      const hud = document.getElementById('hud-layer');
      const scr = document.getElementById('screens');
      if (hud) hud.style.display = on ? 'none' : '';
      if (scr) scr.style.display = on ? 'none' : '';
      game.devHideUI = on;
      return this;
    },

    /** Set the player's hole radius directly (score is back-solved). */
    setSize(radius) {
      const p = game.player;
      if (!p) return this;
      const s = Math.max(0, (Math.pow(radius / 1.15, 1 / 0.415) - 1) * 26);
      p.score = s;
      p.radius = radius;
      p.displayRadius = radius;
      return this;
    },

    teleport(x, z) {
      if (!game.player) return this;
      game.player.position.set(x, 0, z);
      game.player.velocity.set(0, 0, 0);
      game.engine._camTarget.set(x, 0, z);
      return this;
    },

    /** Freeze the follow camera at an explicit setup. */
    cam({ x, z, dist, pitch, yaw }) {
      game.devCam = {
        x: x ?? game.engine._camTarget.x,
        z: z ?? game.engine._camTarget.z,
        dist: dist ?? game.engine._dist,
        pitch: pitch ?? 54,
        yaw: yaw ?? -35,
      };
      return this;
    },

    freeCam(on = false) { if (!on) game.devCam = null; return this; },

    /** Move bots out of frame so shots are deterministic. */
    clearBots() {
      for (const b of game.bots) { b.hole.alive = false; b.hole.group.visible = false; }
      return this;
    },

    /** Apply a named preset: positions the hole, the camera and the sizes. */
    shot(name, opts = {}) {
      const p = PRESETS[name];
      if (!p) { console.warn('[DEV] unknown preset', name); return this; }
      this.play(true);
      if (opts.showUI !== true) this.hideUI(true);
      this.setSize(p.holeR ?? 2);
      this.teleport(p.x, p.z);
      this.cam(p);
      game.player.desiredDir.set(0, 0);
      if (opts.clearBots !== false) this.clearBots();
      game.forceSyncFrame = true;
      return this;
    },

    /**
     * Force `n` complete simulate+draw passes synchronously. Works even when the
     * tab is backgrounded and requestAnimationFrame is throttled, which is the
     * normal case for an automated screenshot driver.
     */
    render(n = 6, dt = 1 / 60) {
      for (let i = 0; i < n; i++) game.frame(dt);
      return this;
    },

    /** Resolve once the renderer has drawn `n` more frames (rAF, with fallback). */
    settle(n = 8) {
      this.render(n);
      return new Promise((resolve) => {
        let i = 0;
        const done = () => resolve();
        const timer = setTimeout(done, 900);
        const step = () => {
          if (++i >= n) { clearTimeout(timer); resolve(); }
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    },

    /** Advance simulation by a fixed amount without waiting in real time. */
    simulate(seconds = 1, step = 1 / 60) {
      const n = Math.round(seconds / step);
      for (let i = 0; i < n; i++) game.stepSimulation(step);
      return this;
    },

    stats() {
      const info = game.engine.renderer.info;
      return {
        fps: Math.round(game.fps),
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
        programs: info.programs ? info.programs.length : -1,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        consumables: game.registry.aliveCount,
        initialConsumables: game.registry.initialCount,
        playerRadius: game.player ? +game.player.radius.toFixed(2) : null,
        playerScore: game.player ? Math.round(game.player.score) : null,
        phase: game.match.phase,
      };
    },

    /** Bulk-eat everything within r of the player — for testing late game. */
    devour(r = 40) {
      const out = [];
      game.registry.query(game.player.position.x, game.player.position.z, r, out);
      for (const c of out) game.consume._capture(game.player, c, game.clock.elapsedTime);
      return out.length;
    },
  };

  window.DEV = DEV;
  return DEV;
}
