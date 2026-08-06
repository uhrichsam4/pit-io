/**
 * Entry point.
 *
 * Everything is owned by Game: it builds the engine and the city, then installs
 * the meta layer (src/ui/meta.js) over the top of them. No screen is registered
 * here — a second place that knows about screens is a second place to forget.
 */

import { audio } from './core/audio.js';
import { Game } from './game.js';

const canvas = document.getElementById('scene');
const uiRoot = document.getElementById('ui-root');

const game = new Game(canvas, uiRoot);
window.__GAME__ = game;
/* The audio engine is a module singleton with no reference on Game, which made
   "why is nothing playing?" unanswerable from a test harness — you could see the
   game state but not whether a single sound had been triggered. */
window.__AUDIO__ = audio;

/** The crash card is the last thing standing, so it must not itself be a bug. */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (m) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
  ));
}

game.init().catch((err) => {
  console.error('[main] init failed', err);
  // A stack trace can carry characters that close a tag, so it goes through the
  // same escaping as any other untrusted string.
  uiRoot.innerHTML = `<div class="screen"><h1>OOPS</h1><p style="font-family:monospace">${
    esc(err && err.stack ? err.stack : err)
  }</p></div>`;
});
