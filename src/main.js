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
  v.textContent = 'NPC voice line (through the engine)';
  v.onclick = () => {
    const g = window.__GAME__;
    if (!g || !g.voice) return;
    /* Twice, 700 ms apart. A line whose buffer is not cached yet is captioned
       immediately and fetched in the background, so the FIRST utterance of any
       given line can legitimately be silent while the second is not. Firing
       once made that indistinguishable from total failure. */
    g.voice.say('notice', { force: true, priority: 99 });
    setTimeout(() => g.voice.say('notice', { force: true, priority: 99 }), 700);
  };
  rows.appendChild(v);

  /* THE DECIDING TEST. Plays a generated mp3 through a plain HTMLAudioElement,
     touching none of this project's code — no WebAudio graph, no buses, no
     compressor, no gain maths, no scheduler.

       audible here, silent through the engine  -> the file and the browser are
         fine and the fault is somewhere in our graph;
       silent here too -> the fault is below us: output device, tab mute, OS
         mixer, or the file itself.

     Five separate attempts to measure this from a headless browser all came
     back blind, so this is the only instrument left that can tell those two
     worlds apart, and it needs a human ear rather than a number. */
  const raw = document.createElement('button');
  raw.textContent = 'RAW mp3 — bypasses ALL game audio code';
  raw.onclick = () => {
    const el = new Audio('audio/voice/notice-mina-sinkhole.mp3');
    el.volume = 1;
    raw.textContent = 'RAW mp3 — playing...';
    el.play()
      .then(() => { raw.textContent = 'RAW mp3 — started OK (did you hear it?)'; })
      .catch((e) => {
        raw.className = 'bad';
        raw.textContent = 'RAW mp3 — REFUSED: ' + e.name + ' ' + e.message;
      });
    el.onerror = () => {
      raw.className = 'bad';
      raw.textContent = 'RAW mp3 — FILE ERROR (404 or undecodable)';
    };
  };
  rows.appendChild(raw);

  /* BINARY SEARCH THE GRAPH. The raw mp3 is audible and the engine's voice
     path is not, so the fault is inside the WebAudio graph — but the voice
     chain reads as correct and the SFX chain (sirens) demonstrably works.
     These two split the remaining space in half with an ear rather than a
     number, which is the only instrument that has been reliable tonight. */

  // A: a plain tone injected at the VOICE BUS. Everything downstream of the bus
  //    is shared with the sirens, so silence here indicts voiceBus/voiceGlue.
  const tone = document.createElement('button');
  tone.textContent = 'TONE through the VOICE bus (1s)';
  tone.onclick = () => {
    const a = window.__AUDIO__; if (!a || !a.ctx) return;
    const o = a.ctx.createOscillator(), gn = a.ctx.createGain();
    o.frequency.value = 440; gn.gain.value = 0.25;
    o.connect(gn); gn.connect(a.voiceBus || a.master);
    o.start(); setTimeout(() => { try { o.stop(); } catch (e) { void e; } }, 1000);
  };
  rows.appendChild(tone);

  // B: the REAL decoded voice buffer, straight to ctx.destination — WebAudio,
  //    but bypassing every bus this project built. Audible here plus silent
  //    through the engine means the buffer is good and a bus is eating it.
  const buf = document.createElement('button');
  buf.textContent = 'DECODED voice buffer -> straight to output';
  buf.onclick = async () => {
    const a = window.__AUDIO__; if (!a || !a.ctx) return;
    buf.textContent = 'DECODED buffer — fetching...';
    try {
      const res = await fetch('audio/voice/notice-mina-sinkhole.mp3');
      const ab = await res.arrayBuffer();
      const decoded = await a.ctx.decodeAudioData(ab);
      const src = a.ctx.createBufferSource();
      src.buffer = decoded;
      src.connect(a.ctx.destination);
      src.start();
      buf.textContent = 'DECODED buffer — playing ' + decoded.duration.toFixed(2) + 's';
    } catch (e) {
      buf.className = 'bad';
      buf.textContent = 'DECODED buffer — FAILED: ' + e.message;
    }
  };
  rows.appendChild(buf);

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
