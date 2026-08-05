/**
 * The in-match pause menu — Escape during play.
 *
 * Deliberately NOT a full page. Everything else in the shell replaces the
 * screen; pausing has to keep the match visible behind it, because half the
 * reason you paused is to look at where you are. So this renders a centred card
 * over a light scrim rather than the usual opaque page.
 *
 * The simulation is frozen by the host before this opens. That matters: a menu
 * that leaves the world running means you come back to a smaller hole and no
 * idea who ate you, which is the single most annoying thing a pause screen can
 * do.
 */

import { esc, page, wireNav } from '../shell.js';
import '../css/pause.css';

export function registerPause(shell, deps = {}) {
  shell.register('pause', {
    title: 'Paused',
    fullBleed: true,

    render() {
      return `
        <div class="pause-wrap">
          <div class="pause-card panel">
            <div class="pause-kicker">Paused</div>
            <h2 class="pause-title">pit.io</h2>
            <div class="pause-stats" data-stats></div>
            <div class="pause-actions">
              <button class="btn btn-lg btn-block" data-act="resume">Resume</button>
              <button class="btn btn-ghost btn-block" data-nav="settings">Settings</button>
              <button class="btn btn-ghost btn-block pause-leave" data-act="lobby">Return to Lobby</button>
            </div>
            <div class="pause-hint tiny muted">Press <kbd>Esc</kbd> to resume</div>
          </div>
        </div>`;
    },

    mount(root, { shell: sh }) {
      // Settings is reached with data-nav, so the standard handler covers it —
      // and because it is a normal push, its back button returns here rather
      // than to the lobby.
      wireNav(root, sh);

      root.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        if (b.dataset.act === 'resume') deps.onResume && deps.onResume();
        if (b.dataset.act === 'lobby') deps.onLobby && deps.onLobby();
      });

      // A snapshot of the run so far. Read once at mount — the world is frozen,
      // so there is nothing to keep in sync.
      const el = root.querySelector('[data-stats]');
      const s = (deps.snapshot && deps.snapshot()) || null;
      if (el && s) {
        const tile = (v, l) => `<div class="stat-tile"><span class="sv">${esc(String(v))}</span><span class="sl">${esc(l)}</span></div>`;
        el.innerHTML = `<div class="stat-grid">
          ${tile(Math.round(s.score).toLocaleString(), 'Score')}
          ${tile(`${s.diameter.toFixed(1)}m`, 'Hole')}
          ${tile(s.rank ? `${s.rank}/${s.total}` : '—', 'Place')}
          ${tile(s.timeLeft, 'Left')}
        </div>`;
      }
    },
  });
}
