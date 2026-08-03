import { Game } from './game.js';

const canvas = document.getElementById('scene');
const uiRoot = document.getElementById('ui-root');

const game = new Game(canvas, uiRoot);
window.__GAME__ = game;

game.init().catch((err) => {
  console.error('[main] init failed', err);
  uiRoot.innerHTML = `<div class="screen"><h1>OOPS</h1><p style="font-family:monospace">${
    String(err && err.stack ? err.stack : err)
  }</p></div>`;
});
