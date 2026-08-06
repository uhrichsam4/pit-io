/**
 * META LAYER BOOT — the one place the front end is assembled.
 *
 * Six screens were written independently against src/ui/shell.js. This module
 * is the only thing that knows they all exist: it builds the Shell, hands each
 * screen the dependencies it asked for, and gives the match a set of callbacks
 * to be started through. No screen imports another screen's host, and game.js
 * never imports a screen.
 *
 * WHY EVERY SCREEN IS LOADED WITH import() AND NOT A STATIC IMPORT.
 * A static import of eight modules means any one of them throwing at evaluation
 * time — a bad catalogue entry, a missing export after a refactor — takes the
 * whole bundle down, and with it the game. Loaded individually, a broken screen
 * costs exactly that screen: the shell registers an honest placeholder in its
 * place and everything else still works. That is worth one await at boot.
 */

import { Shell, esc, page, wireNav } from './shell.js';
import { profile } from '../meta/profile.js';
import * as progression from '../meta/progression.js';
import * as matchmaking from '../net/matchmaking.js';
import { audio } from '../core/audio.js';

/**
 * The registry. `mod` is the loader, `fn` the expected register function, and
 * `deps` builds exactly the dependency object that screen documented — passing
 * a screen something it does not use is how a rename goes unnoticed.
 */
const SCREENS = [
  {
    name: 'prelobby',
    title: 'Lobby',
    mod: () => import('./screens/prelobby.js'),
    fn: 'registerPrelobby',
    deps: (d) => ({
      net: () => d.liveNet(), code: () => d.roomCode(),
      onName: d.onName, onLeave: d.onLeaveRoom,
      lobbyInfo: d.lobbyInfo, onStartNow: d.onStartNow,
    }),
  },
  {
    name: 'pause',
    title: 'Paused',
    mod: () => import('./screens/pause.js'),
    fn: 'registerPause',
    deps: (d) => ({ onResume: d.onResume, onLobby: d.onLobbyFromPause, snapshot: d.snapshot }),
  },
  {
    name: 'lobby',
    title: 'Lobby',
    mod: () => import('./screens/lobby.js'),
    fn: 'registerLobby',
    deps: (d) => ({
      profile: d.profile,
      net: d.net,
      progression: d.progression,
      onPlay: d.onPlay,
    }),
  },
  {
    name: 'play',
    title: 'Play',
    mod: () => import('./screens/play.js'),
    fn: 'registerPlay',
    deps: (d) => ({ onPlay: d.onPlay, onJoin: d.onJoin }),
  },
  {
    name: 'modes',
    title: 'Game Modes',
    mod: () => import('./screens/modes.js'),
    fn: 'registerModes',
    deps: (d) => ({ profile: d.profile, onPlay: d.onPlay }),
  },
  {
    name: 'leaderboard',
    title: 'Leaderboards',
    mod: () => import('./screens/leaderboard.js'),
    fn: 'registerLeaderboard',
    deps: (d) => ({ profile: d.profile, progression: d.progression }),
  },
  {
    name: 'profile',
    title: 'Profile',
    mod: () => import('./screens/profile.js'),
    fn: 'registerProfile',
    deps: (d) => ({ profile: d.profile, progression: d.progression }),
  },
  {
    name: 'store',
    title: 'Store',
    mod: () => import('./screens/store.js'),
    fn: 'registerStore',
    deps: (d) => ({ profile: d.profile }),
  },
  {
    name: 'rewards',
    title: 'Rewards',
    mod: () => import('./screens/rewards.js'),
    fn: 'registerRewards',
    deps: (d) => ({ progression: d.progression }),
  },
  {
    name: 'settings',
    title: 'Settings',
    mod: () => import('./screens/settings.js'),
    fn: 'registerSettings',
    deps: (d) => ({ audio: d.audio, onQuality: d.onQuality, onShowFps: d.onShowFps }),
    /**
     * Saved audio/quality/motion/FPS preferences have to reach the engine even
     * when the player never opens Settings, so the module that owns them
     * applies them once as soon as it is here.
     */
    after: (mod, d) => { mod.applySettings(d); },
  },
];

/**
 * Stand-in for a screen that did not load. Deliberately not silent and not a
 * blank page: it names the screen, shows the real error, and always offers a
 * way out, because a dead end in the navigation stack reads as a frozen game.
 */
function registerFallback(shell, name, title, err) {
  const reason = String((err && err.message) || err || 'unknown error');
  shell.register(name, {
    title,
    render: () => page({
      title,
      body: `
        <div class="wrap">
          <div class="panel center" style="text-align:center">
            <h2>${esc(title)} is unavailable</h2>
            <p class="muted">This screen failed to load, so it has been left out
              rather than taking the rest of the game with it. Everything else
              still works.</p>
            <p class="tiny muted" style="word-break:break-word">${esc(reason)}</p>
            <button class="btn btn-block" data-nav="lobby">Back to the lobby</button>
          </div>
        </div>`,
    }),
    mount(root, ctx) { wireNav(root, ctx.shell); },
  });
}

/**
 * Build the meta layer inside `uiRoot` and leave it sitting on the lobby.
 *
 * @param {import('../game.js').Game} game
 * @param {HTMLElement} uiRoot
 * @returns {Promise<Shell>}
 */
export async function installMeta(game, uiRoot) {
  const root = document.createElement('div');
  root.className = 'shell';
  uiRoot.appendChild(root);
  const shell = new Shell(root);

  const deps = {
    profile,
    net: matchmaking,
    progression,
    audio,
    /** Start an offline match in `modeId`. The only dep the lobby truly needs. */
    /** Play always goes through the waiting room now — see Game#queueMatch. */
    onPlay: (modeId) => game.queueMatch(modeId),
    /** Join a room. game.js owns what that means — see Game#joinRoom. */
    onJoin: (info) => game.joinRoom(info || {}),
    onQuality: (id, level) => game.applyQuality(level),
    /** The Escape menu. game.js owns freezing and thawing the simulation. */
    onResume: () => game.resumeFromPause(),
    /** The live NetClient, or null offline. A getter: it is built at boot. */
    liveNet: () => game.net,
    roomCode: () => (game.netCfg ? game.netCfg.room : ''),
    onName: (n) => { try { profile.data.name = n; profile.save(); } catch { /* ignore */ } },
    onLeaveRoom: () => { location.href = location.origin + location.pathname; },
    onLobbyFromPause: () => game.returnToLobby(),
    /** Waiting-room state for the pre-lobby: count, target, seconds left. */
    lobbyInfo: () => ({
      left: game.net
        ? (game.net.lobby ? game.net.lobby.waitLeft : null)
        : (game.lobbyLeft == null ? null : Math.ceil(game.lobbyLeft)),
      count: game.net ? (game.net.lobby ? game.net.lobby.players.length : 1) : 1,
      target: game.net && game.net.lobby ? (game.net.lobby.target || 15) : 15,
      online: !!game.net,
    }),
    onStartNow: () => game.startNow(),
    snapshot: () => (game.pauseSnapshot ? game.pauseSnapshot() : null),
    /**
     * settings.js draws its own FPS readout over the viewport; the game has
     * nothing extra to do, but the hook is passed so the setting has one owner.
     */
    onShowFps: () => {},
  };

  await Promise.all(SCREENS.map(async (s) => {
    try {
      const mod = await s.mod();
      const reg = mod[s.fn];
      if (typeof reg !== 'function') throw new Error(`${s.fn}() is not exported`);
      reg(shell, s.deps(deps));
      if (!shell.has(s.name)) throw new Error(`${s.fn}() did not register "${s.name}"`);
      if (s.after) {
        try { s.after(mod, deps); }
        catch (e) { console.warn(`[meta] "${s.name}" post-register step failed`, e); }
      }
    } catch (err) {
      console.error(`[meta] screen "${s.name}" failed to load`, err);
      registerFallback(shell, s.name, s.title, err);
    }
  }));

  shell.reset('lobby');
  return shell;
}
