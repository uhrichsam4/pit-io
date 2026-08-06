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

/* ---------------------------------------------------------- sound test ---
 * Press Shift+A in game.
 *
 * This exists because I could not answer "can you hear it?" from here. A
 * headless browser reports an AudioContext as `running` while rendering no
 * samples — a reference oscillator patched straight into the master bus
 * measured exactly zero — so every automated check I built could only prove a
 * sound was CALLED, never that it made a noise. Counting call sites is how the
 * game shipped with sirens as the only audible cue while the instrumentation
 * said 16 of 34 effects were firing.
 *
 * So the ears are yours. Each row plays one sound in isolation, on demand,
 * with nothing else competing for the scheduler. Anything silent here is a
 * real defect in that effect; anything audible here but missing in play is a
 * wiring or priority problem instead. That distinction is the whole point, and
 * it is not one I can make without you.
 */
function soundTest() {
  const P = document.createElement('div');
  P.id = 'sfx-test';
  P.innerHTML = '<h4>Sound test — click each, note what is silent'
    + '<button id="sfx-x">close</button></h4><div id="sfx-rows"></div>';
  document.body.appendChild(P);
  const rows = P.querySelector('#sfx-rows');

  // Each entry: label, and a thunk that fires exactly one sound.
  const one = (n, fn) => ({ n, fn });
  const LIST = [
    one('ui click', () => audio.ui('click')),
    one('ui confirm', () => audio.ui('confirm')),
    one('countdown beep', () => audio.countdownBeep(false)),
    one('countdown final', () => audio.countdownBeep(true)),
    one('match start', () => audio.matchStart()),
    one('match end', () => audio.matchEnd(true)),
    one('chomp (small eat)', () => audio.chomp(0.4)),
    one('crumble (building)', () => audio.crumble(0.8)),
    one('level up', () => audio.levelUp(2)),
    one('rank change', () => audio.rankChange(1)),
    one('devour player', () => audio.devourPlayer()),
    one('death', () => audio.death()),
    one('car tip', () => audio.carTip(0, 0)),
    one('car slide', () => audio.carSlide(0, 0, 0.6)),
    one('clatter', () => audio.clatter(0.5, 0, 0)),
    one('creak', () => audio.creak(0, 0, 0.6)),
    one('power-up pickup', () => audio.powerupPickup('vacuum')),
    one('power-up end', () => audio.powerupEnd('vacuum')),
    one('event warning', () => audio.eventWarning()),
    one('event sting', () => audio.eventSting()),
    one('thunder', () => audio.thunder(0.4)),
    one('heat up', () => audio.heatUp(2)),
    one('heat down', () => audio.heatDown()),
    one('dispatch chirp', () => audio.dispatchChirp(0, 0)),
    one('containment pulse', () => audio.containmentPulse(0, 0)),
    one('out-of-bounds tick', () => audio.outOfBoundsTick(2)),
    one('teleport', () => audio.teleport()),
    one('score penalty', () => audio.scorePenalty()),
  ];
  for (const it of LIST) {
    const b = document.createElement('button');
    b.textContent = it.n;
    b.onclick = () => {
      try { it.fn(); b.dataset.hit = (Number(b.dataset.hit || 0) + 1); }
      catch (e) { b.textContent = it.n + ' — THREW: ' + e.message; b.className = 'bad'; }
    };
    rows.appendChild(b);
  }
  // Loops and a real voice line need their own handling.
  for (const [label, start] of [
    ['siren (loop 4s)', () => audio.siren('cruiser', 0, 0)],
    ['storm bed (loop 4s)', () => audio.stormLoop()],
    ['rain bed (loop 4s)', () => audio.rainLoop()],
  ]) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => {
      const h = start();
      if (h && h.stop) setTimeout(() => h.stop(0.2), 4000);
    };
    rows.appendChild(b);
  }
  const v = document.createElement('button');
  v.textContent = 'NPC voice line';
  v.onclick = () => {
    const g = window.__GAME__;
    if (g && g.voice) g.voice.say('notice', { force: true, priority: 99 });
  };
  rows.appendChild(v);

  P.querySelector('#sfx-x').onclick = () => P.remove();
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'A' && e.shiftKey && !e.repeat) {
    if (document.getElementById('sfx-test')) return;
    audio.unlock();
    soundTest();
  }
});

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
