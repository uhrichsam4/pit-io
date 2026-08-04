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
import { HOLE } from '../config.js';
import { Hole } from '../gameplay/hole.js';

/**
 * Canonical camera setups. Each is {x, z, dist, pitch, yaw, holeR?, note}.
 * x/z are the LOOK-AT point in world space.
 */
/**
 * Canonical camera setups, tuned to the real layout so every review frames
 * actual content instead of the inside of a tower. x/z is the LOOK-AT point.
 *
 * Yaw convention: camera sits at target + (sin(yaw), _, cos(yaw)) * dist.
 * So a POSITIVE yaw puts the camera east (+x) of the target — that is the
 * bay side, which is where you want to stand to photograph Brickell.
 */
export const PRESETS = {
  'menu-hero': { x: 120, z: 250, dist: 560, pitch: 22, yaw: 62, holeR: 10,
    note: 'Hero shot: the whole Brickell skyline seen across Biscayne Bay.' },
  'brickell-skyline': { x: 110, z: 270, dist: 430, pitch: 30, yaw: 48, holeR: 10,
    note: 'Brickell towers, high 3/4 from the bay side.' },
  'downtown-wide': { x: 80, z: -260, dist: 470, pitch: 33, yaw: 40, holeR: 10,
    note: 'Downtown: superblocks, landmarks, civic plazas, Kaseya Center.' },
  // Moved west along Flagler and swung round to 125 deg. The old setup put the
  // camera 1.5 m from a curtain wall once the massing changed — every one of
  // 15 rays from the camera to the look-at box hit a building, so the frame was
  // a sheet of glass and the review was reading the occlusion fade instead of
  // the street. This spot is the only clear standing point on the spine.
  'street-level': { x: 60, z: -200, dist: 58, pitch: 34, yaw: 125, holeR: 2,
    note: 'Flagler St retail spine. Props, kerbs, storefronts, crowd, textures.' },
  'hole-small': { x: 128, z: 150, dist: 46, pitch: 54, yaw: -35, holeR: 1.6,
    note: 'Default gameplay framing at starting size.' },
  'hole-mid': { x: 110, z: 230, dist: 135, pitch: 52, yaw: -35, holeR: 9,
    note: 'Mid-game: cars, palms and street furniture all edible.' },
  'hole-big': { x: 110, z: 230, dist: 340, pitch: 50, yaw: -35, holeR: 30,
    note: 'Late game: the hole is eating whole city blocks.' },
  'waterfront': { x: 300, z: -240, dist: 250, pitch: 24, yaw: 75, holeR: 6,
    note: 'Bayfront: seawall, promenade, marina, boats, Bayfront Amphitheatre.' },
  'river': { x: 140, z: 0, dist: 235, pitch: 20, yaw: 60, holeR: 6,
    note: 'Miami River: bends, bridges, riverwalk, bulkheads.' },
  'park': { x: 290, z: -200, dist: 155, pitch: 34, yaw: 55, holeR: 4,
    note: 'Bayfront park + plaza: lawn, palms, paths, fountains.' },
  // Steep enough to look down INTO the junction rather than across it — a
  // shallower angle just fills the frame with the nearest tower.
  'intersection': { x: 128, z: 194, dist: 125, pitch: 58, yaw: -35, holeR: 3,
    note: 'Brickell Ave x SE 10 St. Crosswalks, lane paint, signals, traffic.' },
  'construction': { x: -121, z: 54, dist: 155, pitch: 34, yaw: -35, holeR: 5,
    note: 'Construction site: cranes, slabs, hoarding, machinery.' },
  'rooftops': { x: 120, z: 240, dist: 300, pitch: 62, yaw: 30, holeR: 8,
    note: 'Steep look-down. Roofs are on screen constantly — they must hold up.' },
  // Aimed at a measured crowd cluster, not just at a busy-sounding street: the
  // densest 30 m cell of live pedestrian instances in the whole layout. The old
  // spot had a building corner 8 m off the lens and a palm crown over the rest,
  // and the preset that exists to prove the city has people in it showed two.
  'crowd': { x: 30, z: -60, dist: 44, pitch: 28, yaw: 40, holeR: 1.4,
    note: 'Eye-level-ish on a busy spine: pedestrians, café clusters, signage.' },
  'occlusion': { x: 92, z: 224, dist: 90, pitch: 40, yaw: -35, holeR: 5,
    note: 'Hole tucked against Brickell City Centre — tests the see-through fade.' },
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

    /**
     * Set the player's hole radius directly, back-solving the score.
     *
     * MUST invert Hole.radiusFor using the LIVE constants. Hard-coding them
     * silently desynchronises score from radius the moment anyone retunes the
     * growth curve: the hole then snaps to a different size on its very next
     * bite, which quietly invalidates every size-dependent test and preset.
     */
    setSize(radius) {
      const p = game.player;
      if (!p) return this;
      const r = Math.min(radius, HOLE.MAX_RADIUS);
      p.score = Math.max(0,
        (Math.pow(r / HOLE.START_RADIUS, 1 / HOLE.GROWTH_P) - 1) * HOLE.GROWTH_K);
      p.radius = Hole.radiusFor(p.score);
      p.displayRadius = p.radius;
      return this;
    },

    teleport(x, z) {
      if (!game.player) return this;
      game.player.position.set(x, 0, z);
      game.player.velocity.set(0, 0, 0);
      game.engine._camTarget.set(x, 0, z);
      // The boom-collision easing is a state; a jump has no travel to ease
      // over, so a retracted boom would otherwise glide out over ~1 s and the
      // first frames of a capture would be shot from the wrong distance.
      game.engine._boom = 1;
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

    /**
     * Remove the bots so review shots are deterministic.
     *
     * Killing them is not enough: Match.update walks its hole list every tick
     * and respawns anything dead, so they were back within a frame and every
     * screenshot quietly contained stray rival holes. They have to leave the
     * list the match is iterating.
     */
    clearBots() {
      for (const b of game.bots) {
        b.hole.alive = false;
        b.hole.group.visible = false;
        game.engine.scene.remove(b.hole.group);
      }
      const botHoles = new Set(game.bots.map((b) => b.hole));
      game.holes = game.holes.filter((h) => !botHoles.has(h));
      game.bots.length = 0;
      game.match.holes = game.holes;
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
      // Advance the eased systems to steady state before anyone screenshots —
      // occlusion fades, camera smoothing, display radius. Done with a coarse
      // dt so it costs ~12 frames rather than ~40: under software GL every
      // extra frame is expensive enough to blow a screenshot timeout.
      this.render(opts.presettle ?? 14, 1 / 24);
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
