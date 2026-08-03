/**
 * Procedural audio. No sample files — every sound is synthesised with the Web
 * Audio API at runtime, which keeps the build self-contained and lets each
 * effect scale continuously with what just happened (a cone and a skyscraper
 * use the same synth, an octave and a half apart).
 *
 * Browsers block audio until a user gesture, so nothing is created until
 * `unlock()` is called from a click/keypress.
 */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Audio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.ready = false;
    this._noiseBuf = null;
    this._lastChomp = 0;
    this._musicNodes = [];
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    this.ctx = new AC();

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.85;

    // A gentle bus compressor keeps a pile-up of simultaneous swallows from
    // clipping, which happens constantly in the late game.
    this.comp = this.ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.knee.value = 22;
    this.comp.ratio.value = 7;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.18;

    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = 0.9;
    this.musicBus = this.ctx.createGain();
    this.musicBus.gain.value = 0.24;

    this.sfxBus.connect(this.comp);
    this.musicBus.connect(this.comp);
    this.comp.connect(this.master);
    this.master.connect(this.ctx.destination);

    // shared noise buffer, 2 s of white noise
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this._noiseBuf = buf;

    this.ready = true;
  }

  setVolume(v) { if (this.master) this.master.gain.value = clamp(v, 0, 1); }
  setMuted(m) { if (this.master) this.master.gain.value = m ? 0 : 0.85; }

  _noise(dur, { gain = 0.3, type = 'lowpass', freq = 900, q = 1, sweepTo = null }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.value = freq;
    filt.Q.value = q;
    if (sweepTo !== null) {
      filt.frequency.setValueAtTime(freq, ctx.currentTime);
      filt.frequency.exponentialRampToValueAtTime(
        Math.max(40, sweepTo), ctx.currentTime + dur
      );
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(gain, ctx.currentTime + Math.min(0.02, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    src.connect(filt); filt.connect(g); g.connect(this.sfxBus);
    src.start();
    src.stop(ctx.currentTime + dur + 0.02);
    return g;
  }

  _tone(freq, dur, { gain = 0.2, type = 'sine', slideTo = null, delay = 0 }) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(this.sfxBus);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
    return g;
  }

  /**
   * The core "something fell in" sound.
   * @param {number} size 0..1 — how big the swallowed thing was
   */
  chomp(size = 0) {
    if (!this.ready || !this.enabled) return;
    const now = this.ctx.currentTime;
    // Rate-limit: in the late game dozens land per frame and it turns to mush.
    if (now - this._lastChomp < 0.022) return;
    this._lastChomp = now;

    const s = clamp(size, 0, 1);
    // Air rushing past the lip: a filtered noise burst sweeping downward.
    this._noise(0.10 + s * 0.34, {
      gain: 0.10 + s * 0.20,
      type: 'bandpass',
      freq: 1900 - s * 1200,
      q: 0.8 + s * 1.5,
      sweepTo: 260 - s * 180,
    });
    // Body: a short falling tone. Bigger objects, lower pitch.
    this._tone(
      (330 - s * 210) * (0.94 + Math.random() * 0.12),
      0.13 + s * 0.30,
      { gain: 0.05 + s * 0.09, type: 'triangle', slideTo: (120 - s * 80) }
    );
  }

  /** Heavy structural collapse — buildings, towers. */
  crumble(size = 1) {
    if (!this.ready || !this.enabled) return;
    const s = clamp(size, 0, 1);
    this._noise(0.55 + s * 0.75, {
      gain: 0.20 + s * 0.24, type: 'lowpass', freq: 620, sweepTo: 90,
    });
    this._tone(58 + Math.random() * 22, 0.7 + s * 0.5, {
      gain: 0.16 + s * 0.14, type: 'sine', slideTo: 26,
    });
    // debris rattle
    for (let i = 0; i < 5; i++) {
      setTimeout(() => {
        if (!this.ready) return;
        this._noise(0.07, { gain: 0.05, type: 'highpass', freq: 1600 + Math.random() * 2400 });
      }, 60 + i * 70 + Math.random() * 60);
    }
  }

  /** Reward sting when the hole crosses into a new size tier. */
  levelUp(tierIndex = 0) {
    if (!this.ready || !this.enabled) return;
    const root = 392 * Math.pow(2, clamp(tierIndex, 0, 6) / 12);
    [0, 4, 7, 12].forEach((semi, i) => {
      this._tone(root * Math.pow(2, semi / 12), 0.42, {
        gain: 0.10, type: 'triangle', delay: i * 0.055,
      });
    });
  }

  /** Player ate another hole. */
  devourPlayer() {
    if (!this.ready || !this.enabled) return;
    this._noise(0.9, { gain: 0.30, type: 'lowpass', freq: 2400, sweepTo: 70 });
    this._tone(180, 0.8, { gain: 0.16, type: 'sawtooth', slideTo: 42 });
    [0, 3, 7, 10, 14].forEach((s, i) =>
      this._tone(523.25 * Math.pow(2, s / 12), 0.3, {
        gain: 0.08, type: 'square', delay: 0.04 * i,
      })
    );
  }

  /** Player was eaten. */
  death() {
    if (!this.ready || !this.enabled) return;
    this._tone(320, 1.0, { gain: 0.18, type: 'sawtooth', slideTo: 40 });
    this._noise(0.8, { gain: 0.16, type: 'lowpass', freq: 900, sweepTo: 60 });
  }

  countdownBeep(final = false) {
    if (!this.ready || !this.enabled) return;
    this._tone(final ? 880 : 587.33, final ? 0.5 : 0.16, {
      gain: 0.14, type: 'triangle',
    });
  }

  /**
   * A simple generative bed: a slow synth-pop pulse with a shifting bass.
   * Deliberately sparse — this game is loud enough on its own.
   */
  startMusic() {
    if (!this.ready || !this.enabled || this._musicTimer) return;
    const ctx = this.ctx;
    const scale = [0, 3, 5, 7, 10]; // minor pentatonic
    const bassRoots = [55, 61.74, 49, 65.41];
    let step = 0;

    const pad = ctx.createGain();
    pad.gain.value = 0.0;
    pad.connect(this.musicBus);

    const tick = () => {
      if (!this.ready) return;
      const bar = Math.floor(step / 8) % bassRoots.length;
      const root = bassRoots[bar];

      // bass pulse
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = root;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(220, ctx.currentTime);
      f.frequency.exponentialRampToValueAtTime(90, ctx.currentTime + 0.28);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.linearRampToValueAtTime(0.16, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.30);
      o.connect(f); f.connect(g); g.connect(this.musicBus);
      o.start(); o.stop(ctx.currentTime + 0.34);

      // sparse melody every other step
      if (step % 2 === 0 && Math.random() < 0.7) {
        const semi = scale[Math.floor(Math.random() * scale.length)];
        const oct = Math.random() < 0.35 ? 4 : 3;
        const freq = root * Math.pow(2, oct) * Math.pow(2, semi / 12) / 2;
        const mo = ctx.createOscillator();
        mo.type = 'triangle';
        mo.frequency.value = freq;
        const mg = ctx.createGain();
        mg.gain.setValueAtTime(0.0001, ctx.currentTime);
        mg.gain.linearRampToValueAtTime(0.055, ctx.currentTime + 0.03);
        mg.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.55);
        mo.connect(mg); mg.connect(this.musicBus);
        mo.start(); mo.stop(ctx.currentTime + 0.6);
      }
      step++;
    };

    tick();
    this._musicTimer = setInterval(tick, 340);
  }

  stopMusic() {
    if (this._musicTimer) { clearInterval(this._musicTimer); this._musicTimer = null; }
  }

  /** Continuous low rumble whose level tracks the player's size. */
  updateAmbience(radius) {
    if (!this.ready || !this.enabled) return;
    if (!this._rumble) {
      const src = this.ctx.createBufferSource();
      src.buffer = this._noiseBuf;
      src.loop = true;
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 110;
      const g = this.ctx.createGain();
      g.gain.value = 0;
      src.connect(f); f.connect(g); g.connect(this.musicBus);
      src.start();
      this._rumble = g;
      this._rumbleFilter = f;
    }
    const t = clamp((radius - 3) / 40, 0, 1);
    this._rumble.gain.value = t * 0.22;
    this._rumbleFilter.frequency.value = 70 + t * 90;
  }
}

export const audio = new Audio();
