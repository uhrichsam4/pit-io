/**
 * MIAMI DEVOUR — the whole soundtrack, synthesised.
 *
 * No sample files, no binary assets: every kick, every pane of glass and every
 * bar of music is built out of oscillators, noise and filters at runtime. That
 * keeps the build self-contained AND — more usefully — lets a sound scale
 * *continuously* with what actually happened, which a fixed sample bank cannot.
 * A traffic cone and a forty-storey tower run through the same swallow synth,
 * three octaves and one material profile apart.
 *
 * ---------------------------------------------------------------------------
 * SIGNAL FLOW
 *
 *   swallow voices ─┐
 *   event stings  ──┼─▶ panPool ─▶ sfxBus ─▶ sfxGlue ────────┐
 *                   └────────────▶ fxSend ─▶ verb ─▶ fxRet ──┤
 *   rumble + wind ──────────────▶ ambBus ──────────────────  ┤
 *   melodic ─▶ musicDuck ─┐                                  ├─▶ evtDuck
 *   drums ────────────────┴─▶ musicOut ─▶ HP38 ─▶ musicGlue ─┘      │
 *                                                                   ▼
 *                                    dest ◀─ master ◀─ softClip ◀─ HP26
 *
 * `musicDuck` is the per-kick sidechain — drums bypass it, which is what makes
 * a sidechain read as *pump* rather than as the whole mix dipping. `evtDuck` is
 * the event sidechain: a tower going down pushes the entire bed aside.
 *
 * The last stage is a soft clipper with UNIT SLOPE below 0.72 and an asymptote
 * at 0.92, so the module's output is bounded below full scale arithmetically —
 * not by a compressor, and not by luck. There is deliberately no
 * DynamicsCompressor on the master: every engine adds an undocumented makeup
 * gain to that node, and a "limiter" there measured 2 dB LOUDER than none.
 *
 * ---------------------------------------------------------------------------
 * VOICE POLICY
 *
 * In the late game dozens of objects are captured in a single frame. Playing
 * them all at t=now is mush; dropping all but one is dead. So swallows are
 * placed on a minimum-onset grid (`_slot`) which turns a frame full of captures
 * into a fast roll, and successive swallows inside a burst climb a pitch ladder
 * — the same trick that makes a run of coins in a platformer feel like a reward
 * instead of a rattle. Anything that cannot fit in the roll window is folded
 * into one collective "cascade" roar rather than discarded silently.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT USED BY game.js (all still supported, unchanged):
 *   unlock() startMusic() chomp(size) crumble(size) levelUp(tier)
 *   devourPlayer() death() updateAmbience(radius)
 *
 * OPTIONAL RICHER CALLS. Every one degrades gracefully when it is not made,
 * which is why the module can ship ahead of the game.js changes it wants:
 *
 *   swallow(consumable)   preferred; picks light-vs-collapse itself. Also
 *                         accepted by chomp()/crumble() in place of a number.
 *                         Without it every prop of a given size sounds alike;
 *                         with it a bin, a shopfront and a palm do not.
 *   updateAmbience(radius, x, z, nearMass)
 *                         x/z turn on stereo placement and distance for EVERY
 *                         sfx voice; nearMass drives the suction bed.
 *   setMatchState(timeLeft, phase)
 *                         drives the musical arc explicitly. Without it the
 *                         arc is inferred from the updateAmbience heartbeat.
 *   matchStart() matchEnd(won) countdownBeep(final) rankChange(±1) ui(kind)
 *                         event audio nothing calls yet.
 *
 * Mix control: setVolume, setMuted/toggleMuted, setBalance (music↔sfx),
 * setMusicVolume, setSfxVolume, setVoiceVolume, debugStats.
 *
 * ---------------------------------------------------------------------------
 * POWER-UPS, EVENTS, POLICE, VOICES (the second half of the file)
 *
 * Three things were added to the graph for them, all of them additive:
 *
 *   bedDuck   sits under music + ambience ONLY. `duck(amount, seconds)` drives
 *             it, which is how a warning, a match start or a spoken line pushes
 *             the non-essential bed aside without also dipping the sfx that the
 *             player is being warned ABOUT. (`evtDuck`, the old sidechain, still
 *             ducks literally everything — that is what a tower collapsing wants
 *             and it is deliberately a different node.) `dialogDuck` is the same
 *             idea in series, driven CONTINUOUSLY by `duckLevel()` for callers
 *             that compute their own envelope per frame.
 *   voiceBus  NPC / dispatch dialogue, wired straight into the DC trap so it
 *             bypasses both ducks. A voice line must not duck itself, and the
 *             one thing a player has to be able to hear over a storm is words.
 *   _loops    a Map of key → loop handle. Every continuous sound in the game
 *             (vacuum wind, storm, rain, sirens) is keyed, so a second call for
 *             the same key returns the SAME handle instead of stacking a second
 *             voice, and `stopAllLoops()` can prove a finished match went quiet.
 *             stopMusic(), matchStart(), matchEnd() and dispose() all call it.
 *
 * Every loop fades in and out, is bounded by a dead-man's stop time, and is
 * registered in `_live` like everything else, so `debugStats().liveSources`
 * still tells the truth.
 */

import { MATCH, CAMERA } from '../config.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * A numeric argument arriving from another module, coerced or replaced.
 *
 * This is not defensive programming for its own sake. `clamp(NaN, 0, 1)` is
 * NaN, and every WebAudio setter THROWS on a non-finite value — halfway through
 * building a voice, after some nodes are connected and before their envelopes
 * are written. Measured on the offline harness: a single `heatUp(NaN)` left an
 * un-enveloped gain node at unity feeding the bus and pushed the render peak to
 * 2.09, i.e. one bad number from a caller turned into full-scale distortion for
 * everyone. A bad number has to degrade to the default, never to a throw.
 */
function num(v, d) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : d;
}

/** Deterministic RNG so a match's music is reproducible (and testable). */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ======================================================== materials ===== */

/**
 * A material is a modal model, not a preset.
 *  partials  [ratio, amplitude] pairs — the inharmonicity IS the material.
 *            Metal uses the free-bar series (1 : 2.76 : 5.40 : 8.93); wood and
 *            stone are far more damped and much closer to harmonic; glass is
 *            bright and dense.
 *  ring      seconds of tail at reference size, before size scaling.
 *  tone      how much of the voice is pitched at all. Foliage and fabric are 0:
 *            a hedge has no note, only a spectrum.
 *  tail      granular debris: centre frequency, grain count, spread in octaves.
 *  air       the suction whoosh past the lip.
 */
const MATERIALS = {
  plastic: {
    f0: 560, partials: [[1, 1], [2.14, 0.42], [3.71, 0.18]],
    ring: 0.10, tone: 0.80, click: 3000, clickQ: 0.9, clickG: 0.55,
    tail: { f: 2500, q: 1.4, count: 6, dur: 0.16, gain: 0.40, spread: 1.4 },
    air: { f: 1700, q: 0.9, gain: 0.85 },
  },
  metal: {
    f0: 780, partials: [[1, 1], [2.76, 0.58], [5.40, 0.30], [8.93, 0.14]],
    ring: 0.42, tone: 1.00, click: 4800, clickQ: 1.7, clickG: 0.7,
    tail: { f: 4200, q: 2.6, count: 9, dur: 0.34, gain: 0.30, spread: 1.8 },
    air: { f: 2100, q: 1.1, gain: 0.80 },
  },
  glass: {
    f0: 1560, partials: [[1, 1], [2.39, 0.66], [4.12, 0.42], [6.83, 0.26], [9.10, 0.14]],
    ring: 0.20, tone: 0.90, click: 7200, clickQ: 1.2, clickG: 0.65,
    tail: { f: 5400, q: 3.2, count: 14, dur: 0.44, gain: 0.36, spread: 2.2 },
    air: { f: 2600, q: 0.9, gain: 0.72 },
  },
  wood: {
    f0: 330, partials: [[1, 1], [1.94, 0.38], [3.11, 0.16]],
    ring: 0.12, tone: 0.78, click: 1500, clickQ: 0.8, clickG: 0.6,
    tail: { f: 1200, q: 1.1, count: 5, dur: 0.15, gain: 0.34, spread: 1.1 },
    air: { f: 1300, q: 0.8, gain: 0.90 },
  },
  stone: {
    f0: 208, partials: [[1, 1], [1.58, 0.32], [2.31, 0.12]],
    ring: 0.09, tone: 0.55, click: 900, clickQ: 0.7, clickG: 0.7,
    tail: { f: 760, q: 0.9, count: 8, dur: 0.30, gain: 0.46, spread: 1.5 },
    air: { f: 900, q: 0.7, gain: 1.00 },
  },
  // Tone-less materials still need weight, or a hedge and a beach parasol come
  // out 10 dB under a traffic cone and read as nothing happening. `thump` is
  // the pitchless body they get instead of modal partials.
  foliage: {
    f0: 0, partials: [], ring: 0, tone: 0, click: 3400, clickQ: 0.55, clickG: 0.9,
    thump: { f: 150, g: 0.11, d: 0.13 },
    tail: { f: 3000, q: 0.8, count: 11, dur: 0.28, gain: 1.0, spread: 1.6 },
    air: { f: 2400, q: 0.5, gain: 1.7 },
  },
  fabric: {
    f0: 0, partials: [], ring: 0, tone: 0, click: 1800, clickQ: 0.5, clickG: 0.8,
    thump: { f: 190, g: 0.08, d: 0.10 },
    tail: { f: 1600, q: 0.6, count: 5, dur: 0.17, gain: 0.9, spread: 1.0 },
    air: { f: 1200, q: 0.5, gain: 1.9 },
  },
  // Deliberately cartoon, never gory: a soft "wup" and a squeak. Hole.io eats
  // pedestrians too, and it reads as slapstick because the sound says so.
  flesh: {
    f0: 430, partials: [[1, 1], [1.50, 0.28]],
    ring: 0.10, tone: 0.62, click: 1100, clickQ: 0.8, clickG: 0.35, squeak: true,
    tail: { f: 900, q: 0.8, count: 3, dur: 0.10, gain: 0.22, spread: 0.8 },
    air: { f: 1500, q: 0.8, gain: 1.00 },
  },
  water: {
    f0: 0, partials: [], ring: 0, tone: 0, click: 2200, clickQ: 0.5, clickG: 0.9,
    splash: true,
    // A hull displacing water is a big low WHOOMP before it is a splash.
    thump: { f: 96, g: 0.20, d: 0.34 },
    tail: { f: 2000, q: 1.2, count: 12, dur: 0.42, gain: 1.0, spread: 2.4 },
    air: { f: 900, q: 0.6, gain: 1.6 },
  },
};

/**
 * kind → material. `kind` is the pool key the world modules registered with,
 * so this is a straight lookup for anything named, plus family rules for the
 * generated sets (nature species, vehicle types, building classes).
 */
const KIND_MAT = {
  /* street plastic + rubber */
  cone: 'plastic', barrel: 'plastic', waterBarrier: 'plastic', aframe: 'plastic',
  portaloo: 'plastic', binWheelie: 'plastic', binMuni: 'plastic',
  scooter: 'plastic', lounger: 'plastic', dogStation: 'plastic',
  newsBox: 'plastic', sandwichBoard: 'plastic', valetStand: 'plastic',

  /* metal */
  bollard: 'metal', hydrant: 'metal', binMesh: 'metal', bikeRack: 'metal',
  stanchion: 'metal', meter: 'metal', mailbox: 'metal', utilityBox: 'metal',
  phoneKiosk: 'metal', scaffold: 'metal', cleat: 'metal', uplighter: 'metal',
  signStop: 'metal', signNoEntry: 'metal', signOneWay: 'metal',
  signParking: 'metal', signStreet: 'metal', flagPole: 'metal',
  lampModern: 'metal', lampDeco: 'metal', lampPark: 'metal',
  bicycle: 'metal', heater: 'metal', foodCart: 'metal', hotdogStand: 'metal',
  displayRack: 'metal', 'dock-cleat': 'metal', 'sea-bollard': 'metal',
  'sea-ladder': 'metal', 'sea-fender': 'plastic', hoop: 'metal',

  /* glass-fronted / glazed */
  busShelter: 'glass', atmKiosk: 'glass', storefront: 'glass',

  /* wood */
  benchSlat: 'wood', benchBackless: 'wood', picnicTable: 'wood',
  crate: 'wood', pallet: 'wood', produceCrate: 'wood', stringPole: 'wood',
  'dock-pile': 'wood', pontoon: 'wood', pergola: 'wood', playground: 'wood',
  bandshell: 'wood', cafeTable: 'wood', cafeChair: 'wood',

  /* masonry / cast concrete */
  benchConcrete: 'stone', jersey: 'stone', bollardStone: 'stone',
  planterRound: 'stone', planterSquare: 'stone', planterTrough: 'stone',
  fountain: 'stone', fountainS: 'stone', fountainL: 'stone',
  sandbags: 'stone', sculpture: 'stone', bridge: 'stone', causeway: 'stone',
  garage: 'stone', lot: 'stone', construction: 'stone',
  midrise: 'stone', tower: 'glass', landmark: 'stone',

  /* soft goods */
  umbrella: 'fabric', parasol: 'fabric', flagUS: 'fabric', flagCity: 'fabric',

  /* living */
  pedestrian: 'flesh', dog: 'flesh', gull: 'flesh',

  /* water */
  'nav-buoy': 'water', buoy: 'water', channel: 'water', basin: 'water',
};

/** Vehicle type keys from world/vehicles.js that float rather than drive. */
const BOAT_KINDS = new Set([
  'motorYacht', 'sailBoat', 'sportFisher', 'skiff', 'waterTaxi', 'cruiseShip',
]);

/** Foliage species from world/nature.js (everything green and rustling). */
const FOLIAGE_KINDS = new Set([
  'hedge', 'shrub', 'flowerPink', 'flowerYellow', 'ornGrass',
  'planterS', 'planterL', 'bougain', 'mangrove', 'seagrapeT',
]);

/** Trunked species — a palm going over is a wooden crack, not a rustle. */
const WOODY_KINDS = new Set([
  'royalA', 'royalB', 'coconutA', 'coconutB', 'sabal', 'fanShort',
  'banyan', 'liveOak', 'tabebuia', 'pottedPalm', 'hangBasket',
]);

function materialFor(kind, tierId) {
  if (!kind) return tierId >= 5 ? MATERIALS.stone : MATERIALS.plastic;
  const direct = KIND_MAT[kind];
  if (direct) return MATERIALS[direct];
  if (kind.startsWith('nat-')) kind = kind.slice(4);
  if (FOLIAGE_KINDS.has(kind)) return MATERIALS.foliage;
  if (WOODY_KINDS.has(kind)) return MATERIALS.wood;
  if (BOAT_KINDS.has(kind)) return MATERIALS.water;
  if (KIND_MAT[kind]) return MATERIALS[KIND_MAT[kind]];
  // Anything left from vehicles.js is a car, a truck or a digger.
  if (tierId >= 3 && tierId <= 4) return MATERIALS.metal;
  if (tierId >= 5) return MATERIALS.stone;
  return MATERIALS.plastic;
}

/* ============================================================ music ===== */

const BPM = 118;
const BEAT = 60 / BPM;
const STEP = BEAT / 4;            // one 16th
const BAR = BEAT * 4;

/** Chord roots, semitones above A. i – VI – III – VII: bright, driving, Miami. */
const PROG_MAIN = [
  { root: 0, tones: [0, 3, 7, 12] },      // Am
  { root: 8, tones: [8, 12, 15, 20] },    // F
  { root: 3, tones: [3, 7, 10, 15] },     // C
  { root: 10, tones: [10, 14, 17, 22] },  // G
];
/** Frenzy: i – VII – VI – V, the V major dragging in the harmonic-minor bite. */
const PROG_FRENZY = [
  { root: 0, tones: [0, 3, 7, 12] },      // Am
  { root: 10, tones: [10, 14, 17, 22] },  // G
  { root: 8, tones: [8, 12, 15, 20] },    // F
  { root: 7, tones: [7, 11, 14, 19] },    // E major
];

const SCALE_MIN = [0, 2, 3, 5, 7, 8, 10];
const SCALE_FRENZY = [0, 2, 3, 5, 7, 8, 11];

/** A2 = 110 Hz is the bass octave; everything is derived from it. */
const A2 = 110;
const semi = (n) => A2 * Math.pow(2, n / 12);

/**
 * Bus trims, measured rather than guessed (see the offline harness in the
 * report): with these, one traffic cone lands ~10 dB under the music peak
 * instead of 23 dB under it, and a whole block going down still leaves 6 dB.
 */
const SFX_TRIM = 2.7;
// The bed sat only 2 dB under the swallows in the render, which buried both the
// cascade tail and the collapse. It belongs well behind the action.
const AMB_TRIM = 0.34;
/**
 * Voices are pre-normalised speech assets: peaks near full scale and a crest
 * factor of maybe 12 dB. At the sfx trim a single line would be the loudest
 * thing in the game by 8 dB. 0.62 puts a normalised line a shade ABOVE a
 * swallow — dialogue has to win, just not by shouting — and keeps the bus's
 * arithmetic peak (0.62 × voiceVol) inside the soft clipper's linear region.
 */
const VOICE_TRIM = 0.62;

/**
 * Backstop on the loop registry. The per-key rule already bounds the real count
 * (3 power-ups + storm + rain + SIREN_CAP = 8 worst case); this only catches a
 * caller that invents a fresh key every frame, which would otherwise add a
 * permanent noise source per frame.
 */
const LOOP_CAP = 10;
/** Concurrency cap from the mixing rules. Four wailing sirens is a headache. */
const SIREN_CAP = 3;
/**
 * Dead-man's switch on every looping source. A loop that somehow escapes both
 * stopAllLoops() and dispose() still stops itself after an hour instead of
 * running for the life of the tab.
 */
const LOOP_MAX = 3600;
/** Spoken lines on top of each other. The spec asks for 2–3; 3 is the cap. */
const VOICE_CAP = 3;

/**
 * The handle every loop-shaped call returns when it declines to make a sound
 * (not ready, muted, over a cap). Frozen and shared: callers store it, call
 * `.stop()` on it later and must never crash, and they must never be able to
 * mutate the shared instance into something that looks alive.
 */
const DEAD_LOOP = Object.freeze({
  key: null,
  active: false,
  stop() { return this; },
  move() { return this; },
  setIntensity() { return this; },
});

/**
 * kind → the sonic identity of a power-up. `root` is semitones above A2 (see
 * `semi`), `wind` the centre of its loop bed, `sweep` which way its pickup
 * gesture moves: Vacuum Boost inhales (down), Turbo Drain accelerates (up),
 * Mass Surge swells (down, an octave lower and far slower).
 */
const POWERUP_VOICE = {
  vacuum: { root: 22, arp: [0, 7, 12], sweep: -1, wind: 420, q: 3.2, sub: 46, rate: 0.6 },
  turbo: { root: 29, arp: [0, 4, 7, 12], sweep: 1, wind: 2200, q: 1.0, sub: 74, rate: 1.5 },
  mass: { root: 17, arp: [0, 5, 12], sweep: -1, wind: 210, q: 0.9, sub: 34, rate: 0.4 },
  generic: { root: 24, arp: [0, 7, 12], sweep: 1, wind: 800, q: 1.4, sub: 55, rate: 0.9 },
};

/**
 * Spec names → keys. The gameplay modules are written by other hands and will
 * call this with whatever their config object holds ('Vacuum Boost', 'vacuum',
 * 'VACUUM_BOOST'), and a wrong key here fails SILENTLY — it just plays the
 * generic sound and nobody notices the boost lost its identity.
 */
const POWERUP_ALIAS = {
  vacuum: 'vacuum', vacuumboost: 'vacuum', biggersuck: 'vacuum', suck: 'vacuum',
  turbo: 'turbo', turbodrain: 'turbo', speed: 'turbo', speedboost: 'turbo',
  mass: 'mass', masssurge: 'mass', growth: 'mass', growthburst: 'mass', grow: 'mass',
};
function powerupKey(kind) {
  if (!kind) return 'generic';
  return POWERUP_ALIAS[String(kind).toLowerCase().replace(/[^a-z]/g, '')] || 'generic';
}

/**
 * Section table. `at` is seconds elapsed in the match. The last 30 s is FRENZY
 * because MATCH.FRENZY_AT is 30 — read from config so the two never drift.
 */
const FRENZY_AT = MATCH.DURATION - MATCH.FRENZY_AT;

/* ============================================================== class === */

export class Audio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.ready = false;

    this._volume = 0.85;
    this._muted = false;
    this._musicVol = 0.50;
    this._sfxVol = 1.0;
    // Dialogue defaults to full: it is the one bus a player turns DOWN, never
    // up, and the trim below it already sets its place in the mix.
    this._voiceVol = 1.0;
    this._voicesMuted = false;

    // Seeded, not Math.random: it makes the whole synth reproducible, which is
    // the only way an offline render can be compared against another one and
    // the difference attributed to a code change rather than to noise.
    this._rnd = mulberry32(0x9e37_79b1);
    this._noiseBuf = null;
    this._live = new Set();
    this._panFree = [];
    this._panBusy = [];

    /* swallow scheduling */
    this._nextSlot = 0;
    this._combo = 0;
    this._lastSwallow = -10;
    this._pile = 0;
    this._pileAt = 0;
    this._activeVoices = 0;

    /* listener */
    this._lx = 0; this._lz = 0; this._lr = 1.15;
    this._hasListener = false;
    this._lastRadius = 0;

    /* ambience smoothing */
    this._suction = 0;
    this._nearMass = 0;

    /* music */
    this._mus = null;
    this._musicTimer = null;
    this._explicitMatchState = false;

    /* continuous sounds, by key. See _startLoop for why this is a registry. */
    this._loops = new Map();
    /* the running bed duck, tracked here and not read back off the param. */
    this._duckTarget = 1;
    this._duckUntil = 0;
    /* last-fired time per throttle key — the concurrency cap for one-shots. */
    this._throttled = new Map();
    /* spoken lines currently in flight, for the 3-at-once cap. */
    this._voicesLive = [];

    this.stats = {
      created: 0, stopped: 0, stolen: 0, folded: 0, peakVoices: 0, notes: 0,
      loopsStarted: 0, loopsStopped: 0, loopsDropped: 0,
      voicesPlayed: 0, voicesDropped: 0, throttled: 0,
    };
  }

  /* ------------------------------------------------------------ setup --- */

  /**
   * @param {BaseAudioContext} [externalCtx] inject an OfflineAudioContext to
   *   render and measure the graph offline — this is how the mix is verified.
   * @param {{safety?: boolean}} [opts] safety:false bypasses the limiter and
   *   soft-clipper so a test can read the *raw* bus peak and see real headroom.
   */
  unlock(externalCtx = null, opts = {}) {
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume();
      return this;
    }
    if (externalCtx) {
      this.ctx = externalCtx;
      this._external = true;
    } else {
      const AC = typeof window !== 'undefined'
        ? (window.AudioContext || window.webkitAudioContext) : null;
      if (!AC) { this.enabled = false; return this; }
      this.ctx = new AC({ latencyHint: 'interactive' });
    }
    this._safety = opts.safety !== false;
    this._buildGraph();
    this.ready = true;
    return this;
  }

  _buildGraph() {
    const ctx = this.ctx;
    this.nyq = ctx.sampleRate * 0.5;

    this.master = ctx.createGain();
    this.master.gain.value = this._muted ? 0 : this._volume;
    this.master.connect(ctx.destination);

    if (this._safety) {
      // Soft clip with UNIT SLOPE below the knee: normal programme passes
      // through bit-identical, and only the last 25% of the range is bent.
      // (A plain tanh curve would have added 2.5 dB of gain to everything —
      // measured: the "safe" path came out 3.6 dB hotter than the raw one.)
      this.shaper = ctx.createWaveShaper();
      // Unity below 0.72, asymptotic to 0.92 above it. `oversample: 'none'` is
      // deliberate: with 2x, the resampling filters ring and pushed the peak
      // 0.6 dB ABOVE the unprocessed signal even while the curve was in its
      // linear region — i.e. the safety net was adding level. Per-sample, the
      // transfer function is exact, the linear region is bit-transparent, and
      // the bound is arithmetic: |out| <= 0.92 * masterGain.
      const n = 4096, curve = new Float32Array(n);
      const K = 0.72, C = 0.92;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        const a = Math.abs(x);
        const y = a <= K ? a : K + (C - K) * Math.tanh((a - K) / (C - K));
        curve[i] = x < 0 ? -y : y;
      }
      this.shaper.curve = curve;
      this.shaper.oversample = 'none';
      this.shaper.connect(this.master);
      this.busIn = this.shaper;
      // Deliberately NOT a DynamicsCompressor here. Every shipping engine adds
      // an undocumented makeup gain to that node, so a "limiter" on the master
      // measured 2 dB LOUDER than no limiter at all and made the safety path
      // hotter than the raw one. A unit-slope shaper is browser-independent and
      // its bound is arithmetic: |out| <= 0.92 * masterGain, always.
    } else {
      this.busIn = this.master;
    }

    // Nothing in this game lives below 26 Hz, but pink noise, the sub sine and
    // every downward pitch sweep dump energy there. It is inaudible on any
    // speaker a player owns and it costs real headroom, so it goes.
    this.dcTrap = ctx.createBiquadFilter();
    this.dcTrap.type = 'highpass';
    this.dcTrap.frequency.value = 26;
    this.dcTrap.Q.value = 0.7;
    this.dcTrap.connect(this.busIn);

    // Event sidechain — a tower collapsing pushes music AND ambience aside.
    this.evtDuck = ctx.createGain();
    this.evtDuck.gain.value = 1;
    this.evtDuck.connect(this.dcTrap);

    // Bed sidechain — music + ambience only, and NOT the sfx bus. `duck()`
    // drives this one. The distinction is the whole reason it is a separate
    // node: when a storm warning fires, or an NPC shouts, the thing that must
    // get out of the way is the bed, while the sfx the player is being warned
    // about have to stay exactly as loud as they were. Ducking through evtDuck
    // instead would have quietened the warning along with everything else.
    this.bedDuck = ctx.createGain();
    this.bedDuck.gain.value = 1;

    // A SECOND bed duck, in series, driven continuously instead of scheduled.
    // src/audio/voice.js deliberately does not reach into this graph: it
    // publishes `voice.duckAmount` as a plain 0..1 getter and expects the
    // integrator to apply it every frame. That cannot share a param with
    // `duck()`, whose hold-and-release schedule would be cancelled and rebuilt
    // sixty times a second. Two nodes in series multiply, which is the correct
    // composition for two independent duck sources anyway: a voice line during
    // a storm warning ducks the bed by both, not by the louder of the two.
    this.dialogDuck = ctx.createGain();
    this.dialogDuck.gain.value = 1;
    this.bedDuck.connect(this.dialogDuck);
    this.dialogDuck.connect(this.evtDuck);

    /* --- sfx ----------------------------------------------------------- */
    // Glue, not limiting: it pulls a lone traffic cone up toward the music and
    // holds a block-wide collapse together. This one WANTS its makeup gain.
    this.sfxGlue = ctx.createDynamicsCompressor();
    this.sfxGlue.threshold.value = -22;
    this.sfxGlue.knee.value = 22;
    this.sfxGlue.ratio.value = 3.6;
    this.sfxGlue.attack.value = 0.003;
    this.sfxGlue.release.value = 0.16;
    this.sfxGlue.connect(this.evtDuck);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this._sfxVol * SFX_TRIM;
    this.sfxBus.connect(this.sfxGlue);

    /* --- reverb -------------------------------------------------------- */
    // Short bright plate. Generated, not loaded: a decaying noise burst with a
    // one-pole roll-off so the tail darkens the way a real room does.
    this.verb = ctx.createConvolver();
    this.verb.buffer = this._makeIR(1.35, 4.2);
    this.fxSend = ctx.createGain();
    this.fxSend.gain.value = 0.5;
    this.fxReturn = ctx.createGain();
    this.fxReturn.gain.value = 0.7;
    this.fxSend.connect(this.verb);
    this.verb.connect(this.fxReturn);
    this.fxReturn.connect(this.evtDuck);

    /* --- voices --------------------------------------------------------- */
    // Straight into the DC trap: past bedDuck AND past evtDuck. A spoken line
    // is the one thing in the mix that must not be ducked, least of all by the
    // duck it triggers itself. Its reverb send is a different matter — that
    // returns through evtDuck on purpose, so a collapse pulls the ROOM out from
    // under a line while leaving the words at full level. That is how dialogue
    // stays intelligible in a busy frame without being mixed louder.
    this.voiceGlue = ctx.createDynamicsCompressor();
    this.voiceGlue.threshold.value = -18;
    this.voiceGlue.knee.value = 16;
    this.voiceGlue.ratio.value = 3.0;
    this.voiceGlue.attack.value = 0.004;
    this.voiceGlue.release.value = 0.20;
    this.voiceGlue.connect(this.dcTrap);

    this.voiceBus = ctx.createGain();
    this.voiceBus.gain.value = this._voicesMuted ? 0 : this._voiceVol * VOICE_TRIM;
    this.voiceBus.connect(this.voiceGlue);

    /* --- ambience ------------------------------------------------------ */
    this.ambBus = ctx.createGain();
    this.ambBus.gain.value = this._sfxVol * AMB_TRIM;
    this.ambBus.connect(this.bedDuck);

    /* --- music --------------------------------------------------------- */
    this.musicOut = ctx.createGain();
    this.musicOut.gain.value = this._musicVol;
    // The track is a synth-bass track: without this the kick and the bass
    // sub-octave alone owned the bottom two octaves and the melody vanished.
    this.musicHP = ctx.createBiquadFilter();
    this.musicHP.type = 'highpass';
    this.musicHP.frequency.value = 38;
    this.musicHP.Q.value = 0.6;
    // Bus glue. The raw sequence measured a 21 dB crest factor — a loud kick
    // over a thin sustain — which is what makes generative music sound like
    // separate events rather than a track. This pulls the average up.
    this.musicGlue = ctx.createDynamicsCompressor();
    this.musicGlue.threshold.value = -26;
    this.musicGlue.knee.value = 22;
    this.musicGlue.ratio.value = 3.2;
    this.musicGlue.attack.value = 0.006;
    this.musicGlue.release.value = 0.16;
    this.musicOut.connect(this.musicHP);
    this.musicHP.connect(this.musicGlue);
    this.musicGlue.connect(this.bedDuck);

    this.musicDuck = ctx.createGain();   // per-kick pump (drums bypass it)
    this.musicDuck.gain.value = 1;
    this.musicDuck.connect(this.musicOut);

    this.musicMel = ctx.createGain();
    this.musicMel.gain.value = 1;
    this.musicMel.connect(this.musicDuck);

    this.musicDrums = ctx.createGain();
    this.musicDrums.gain.value = 1;
    this.musicDrums.connect(this.musicOut);

    // Dotted-eighth feedback delay on the lead — the single most identifiable
    // synthwave gesture, and it costs three nodes.
    this.leadDelay = ctx.createDelay(1.0);
    this.leadDelay.delayTime.value = BEAT * 0.75;
    this.leadFb = ctx.createGain();
    this.leadFb.gain.value = 0.33;
    this.leadDamp = ctx.createBiquadFilter();
    this.leadDamp.type = 'lowpass';
    this.leadDamp.frequency.value = 2600;
    this.leadSend = ctx.createGain();
    this.leadSend.gain.value = 0.34;
    this.leadSend.connect(this.leadDelay);
    this.leadDelay.connect(this.leadDamp);
    this.leadDamp.connect(this.leadFb);
    this.leadFb.connect(this.leadDelay);
    this.leadDamp.connect(this.musicMel);

    /* --- shared noise --------------------------------------------------- */
    // 3 s so nothing loops at a musically obvious period, pink-ish because
    // white noise is brittle through the resonant filters everything uses.
    const len = Math.floor(ctx.sampleRate * 3);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    let px = 0, py = 0, peak = 1e-6;
    for (let i = 0; i < len; i++) {
      const w = this._rnd() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      const pink = b0 + b1 + b2 + w * 0.1848;
      // DC blocker. Pink noise has enormous sub-audio energy; left in, it
      // showed up as a measurable DC offset on the ambience bus (-34 dBFS of
      // pure headroom loss) and made the rumble filter sag.
      py = pink - px + 0.9992 * py;
      px = pink;
      d[i] = py;
      const a = py < 0 ? -py : py;
      if (a > peak) peak = a;
    }
    const norm = 0.95 / peak;
    for (let i = 0; i < len; i++) d[i] *= norm;
    this._noiseBuf = buf;
    this._noiseDur = len / ctx.sampleRate;
  }

  /** Exponentially decaying stereo noise burst = a serviceable plate IR. */
  _makeIR(seconds, decay) {
    const ctx = this.ctx;
    const n = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const ir = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch);
      let lp = 0;
      const pre = Math.floor(ctx.sampleRate * (ch ? 0.017 : 0.011));
      for (let i = 0; i < n; i++) {
        if (i < pre) { data[i] = 0; continue; }
        const t = (i - pre) / n;
        const env = Math.pow(1 - t, decay);
        lp += ((this._rnd() * 2 - 1) - lp) * 0.42;  // darken the tail
        data[i] = lp * env;
      }
    }
    return ir;
  }

  /* ------------------------------------------------------------- mix ---- */

  setVolume(v) {
    this._volume = clamp(v, 0, 1);
    if (this.master && !this._muted) this.master.gain.value = this._volume;
    return this;
  }
  getVolume() { return this._volume; }

  setMuted(m) {
    this._muted = !!m;
    // Restore the *user's* volume, not a hardcoded default — muting and
    // unmuting used to silently reset a quiet mix back to full.
    if (this.master) this.master.gain.value = this._muted ? 0 : this._volume;
    return this;
  }
  isMuted() { return this._muted; }
  toggleMuted() { return this.setMuted(!this._muted); }

  /** 0 = music only, 0.5 = balanced (default), 1 = sfx only. */
  setBalance(b) {
    const t = clamp(b, 0, 1);
    // Equal-power, so sliding the balance never changes perceived loudness.
    this.setMusicVolume(Math.cos(t * Math.PI * 0.5) * 0.65);
    this.setSfxVolume(Math.sin(t * Math.PI * 0.5) * 1.41);
    return this;
  }

  setMusicVolume(v) {
    this._musicVol = clamp(v, 0, 1.5);
    if (this.musicOut) {
      // death() ramps this param; a live ramp would otherwise override the
      // value the player just chose and then snap back to the old one.
      const p = this.musicOut.gain;
      p.cancelScheduledValues(this._now());
      p.value = this._musicVol;
    }
    return this;
  }

  setSfxVolume(v) {
    this._sfxVol = clamp(v, 0, 1.5);
    if (this.sfxBus) this.sfxBus.gain.value = this._sfxVol * SFX_TRIM;
    if (this.ambBus) this.ambBus.gain.value = this._sfxVol * AMB_TRIM;
    return this;
  }

  /**
   * Dialogue level. A separate bus from sfx because the settings screen ships a
   * separate slider for it (spec §4) and because players who keep the game on
   * in the background turn speech down long before they turn effects down.
   */
  setVoiceVolume(v) {
    this._voiceVol = clamp(num(v, 1), 0, 1.5);
    if (this.voiceBus) {
      const p = this.voiceBus.gain;
      // Same trap setMusicVolume documents: `duck()` and playVoice() both ramp
      // params, and a live ramp elsewhere must not resurrect an old level.
      p.cancelScheduledValues(this._now());
      p.value = this._voicesMuted ? 0 : this._voiceVol * VOICE_TRIM;
    }
    return this;
  }
  getVoiceVolume() { return this._voiceVol; }

  /** "Mute voices" is its own toggle in the spec, distinct from a 0 slider. */
  setVoicesMuted(m) {
    this._voicesMuted = !!m;
    if (this.voiceBus) {
      this.voiceBus.gain.value = this._voicesMuted ? 0 : this._voiceVol * VOICE_TRIM;
    }
    // Silencing the bus would leave lines "playing" against the concurrency
    // cap, so muting also drops anything already in flight.
    if (this._voicesMuted) this.stopVoices();
    return this;
  }
  isVoicesMuted() { return this._voicesMuted; }

  /**
   * Push the non-essential bed (music + world ambience) out of the way.
   * The voice system drives this for every line; warnings, stings and the match
   * start use it too. sfx are deliberately untouched — see `bedDuck`.
   *
   * @param {number} amount 0..1, how far down (0.35 ≈ -3.7 dB)
   * @param {number} seconds how long to hold before releasing
   */
  duck(amount = 0.35, seconds = 0.8) {
    if (!this.ready || !this.bedDuck) return this;
    const p = this.bedDuck.gain;
    const now = this._now();
    const hold = Math.max(0.05, num(seconds, 0.8));
    const want = clamp(1 - num(amount, 0.35), 0.08, 1);

    // Overlapping ducks take the DEEPER target and the LATER release, and both
    // are tracked HERE rather than read back off the param.
    //
    // Reading `p.value` looks like the obvious way to find the running duck,
    // and it is wrong: an AudioParam does not move until the graph runs, so two
    // ducks fired in the same frame — a warning and its sting, thunder plus the
    // voice line reacting to it — both see 1.0. Measured on the offline
    // harness: duck(0.6) immediately followed by duck(0.1) left the bed at 93%
    // instead of 40%, because the shallow one cancelled the deep one's schedule
    // and then "restored" a level that had never dropped.
    const pending = this._duckUntil > now ? this._duckTarget : 1;
    const target = Math.min(want, pending);
    const until = Math.max(this._duckUntil, now + hold);
    this._duckTarget = target;
    this._duckUntil = until;

    // The anchor still comes from the param: mid-release it is the only honest
    // answer, and the same-frame case it gets wrong (1.0) is also the case
    // where the previous ramp has not audibly started.
    const cur = clamp(p.value === undefined ? 1 : p.value, 0.05, 1);
    p.cancelScheduledValues(now);
    p.setValueAtTime(cur, now);
    p.linearRampToValueAtTime(target, now + 0.05);
    p.setValueAtTime(target, until);
    // Slow release. A fast one is audible as the bed "coming back", which reads
    // as a mistake; 0.45 s puts it under the threshold of notice.
    p.linearRampToValueAtTime(1, until + 0.45);
    return this;
  }

  /**
   * The continuous form of the same idea, safe to call every frame.
   *
   * `src/audio/voice.js` computes its own duck envelope and publishes it as
   * `voice.duckAmount` (0..1) rather than touching this graph, so the wiring is
   * literally `audio.duckLevel(voice.duckAmount)` in the frame loop. It rides a
   * separate node from `duck()` for the reason documented on `dialogDuck`, and
   * it reuses `_set`, which drops writes that would not change anything —
   * without that, a duck of zero would still schedule an automation event per
   * frame for the entire match.
   *
   * If you drive this, pass `duck: 0` to `playVoice()` so a line is not ducked
   * for twice.
   */
  duckLevel(amount) {
    if (!this.ready || !this.dialogDuck) return this;
    const target = clamp(1 - clamp(num(amount, 0), 0, 1), 0.08, 1);
    this._set(this.dialogDuck.gain, target, this._now(), 0.05);
    return this;
  }

  /* ------------------------------------------------------ node helpers -- */

  _now() { return this.ctx.currentTime; }

  /** Register a source so we can prove nothing is left running. */
  _src(node, t0, t1, offset) {
    if (offset !== undefined) node.start(t0, offset);
    else node.start(t0);
    node.stop(t1);
    this.stats.created++;
    this._live.add(node);
    node.onended = () => {
      this._live.delete(node);
      this.stats.stopped++;
      try { node.disconnect(); } catch (e) { /* already torn down */ }
    };
    return node;
  }

  /**
   * Every noise voice enters the shared buffer at a random offset. Without it,
   * a hundred cones a minute all start on the same forty milliseconds of noise
   * and the "random" transient becomes a recognisable, repeating click.
   */
  _noiseSrc(t0, t1, rate = 1) {
    const s = this.ctx.createBufferSource();
    s.buffer = this._noiseBuf;
    s.loop = true;
    s.playbackRate.value = rate;
    return this._src(s, t0, t1, this._rnd() * (this._noiseDur - 0.05));
  }

  _hz(f) { return clamp(f, 12, this.nyq - 200); }

  /** Percussive gain envelope. Returns the time it finishes. */
  _hit(g, t0, peak, attack, decay) {
    const p = g.gain;
    const a = Math.max(0.0006, attack);
    const d = Math.max(0.01, decay);
    p.setValueAtTime(0.0001, t0);
    p.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + a);
    p.exponentialRampToValueAtTime(0.0001, t0 + a + d);
    return t0 + a + d;
  }

  /**
   * Granular debris tail. One noise source + one filter + one scripted gain
   * gives a genuinely irregular scatter of grains for three nodes, which is
   * what makes twenty simultaneous swallows affordable.
   */
  _grains(t0, dest, { gain, freq, q = 1.4, count = 8, dur = 0.3, spread = 1.5 }) {
    const ctx = this.ctx;
    const rnd = this._rnd;
    const end = t0 + dur + 0.06;
    const src = this._noiseSrc(t0, end, 0.7 + rnd() * 0.7);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = this._hz(freq);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    src.connect(f); f.connect(g); g.connect(dest);

    let t = t0;
    for (let i = 0; i < count; i++) {
      const k = i / count;
      const gd = 0.014 + rnd() * (0.030 + dur * 0.10);
      const amp = Math.max(0.0004, gain * Math.pow(1 - k, 1.35) * (0.45 + rnd() * 0.65));
      f.frequency.setValueAtTime(
        this._hz(freq * Math.pow(2, (rnd() - 0.5) * spread)), t
      );
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(amp, t + 0.0035);
      g.gain.exponentialRampToValueAtTime(0.0001, t + gd);
      // Grains never overlap on one gain node, so step past the previous one.
      t += gd + 0.002 + rnd() * (dur / count);
      if (t > t0 + dur) break;
    }
    return end;
  }

  /* ------------------------------------------------- spatialisation ----- */

  _sweepPans() {
    const now = this._now();
    for (let i = this._panBusy.length - 1; i >= 0; i--) {
      const ch = this._panBusy[i];
      if (ch.freeAt > now) continue;
      this._panBusy.splice(i, 1);
      if (this._panFree.length < 48) this._panFree.push(ch);
      else { try { ch.g.disconnect(); } catch (e) { /* noop */ } }
    }
  }

  /**
   * Where a world point sits relative to the listener: {pan, att, wet, dist}.
   *
   * Extracted from `_pan` because the long-lived positional chains (a patrol
   * car's siren, which moves for twenty seconds) cannot use the pooled one —
   * the pool would recycle the chain out from under them — and two copies of
   * the camera-yaw maths is exactly how a stereo image ends up mirrored in one
   * of them and nobody notices for a month.
   */
  _placement(x, z, spread = 1) {
    // Only place a sound in the world once someone has told us where the
    // listener is. Otherwise an object at (110, 230) would be measured against
    // a listener still sitting at the origin and attenuated into silence —
    // which is precisely what would happen the first time a caller starts
    // passing Consumables without also passing the hole position.
    // A non-finite coordinate is treated as "no position", not as an error.
    // game.js's own _validateSpawn rejects NaN positions, which is evidence
    // they occur; here one would propagate through the pan maths into
    // setValueAtTime and throw mid-voice, leaving a half-built graph running.
    if (!this._hasListener || !Number.isFinite(x) || !Number.isFinite(z)) {
      return { pan: 0, att: 1, wet: 0.7, dist: 0 };
    }
    const dx = x - this._lx, dz = z - this._lz;
    const d = Math.hypot(dx, dz);
    // Frame half-width at the ground, from the follow camera's own rule.
    const half = Math.max(14, (CAMERA.DIST_BASE + this._lr * CAMERA.DIST_PER_R) * 0.5);
    // Screen-right in world XZ for the fixed camera yaw (see engine.js).
    const yaw = CAMERA.YAW * Math.PI / 180;
    return {
      pan: clamp((dx * Math.cos(yaw) - dz * Math.sin(yaw)) / half, -1, 1) * 0.75 * spread,
      att: clamp(1.15 - d / (half * 2.6), 0.05, 1),
      wet: clamp(0.25 + d / (half * 1.6), 0.2, 1.1),
      dist: d,
    };
  }

  /**
   * Pooled {distance gain → stereo pan → sfxBus} chain, plus a reverb send that
   * grows with distance. Voices connect into `ch.g` and forget about it.
   */
  _pan(x, z, until, spread = 1) {
    this._sweepPans();
    const ctx = this.ctx;
    let ch = this._panFree.pop();
    if (!ch) {
      const g = ctx.createGain();
      const send = ctx.createGain();
      let p = null;
      if (ctx.createStereoPanner) {
        p = ctx.createStereoPanner();
        g.connect(p); p.connect(this.sfxBus);
      } else {
        g.connect(this.sfxBus);      // ancient Safari: mono, still audible
      }
      g.connect(send); send.connect(this.fxSend);
      ch = { g, p, send };
    }
    ch.freeAt = until + 0.08;
    this._panBusy.push(ch);

    const pl = this._placement(x, z, spread);
    const t = this._now();
    ch.g.gain.setValueAtTime(pl.att, t);
    ch.send.gain.setValueAtTime(pl.wet * 0.35, t);
    if (ch.p) ch.p.pan.setValueAtTime(pl.pan, t);
    return ch.g;
  }

  /* --------------------------------------------------- voice policy ----- */

  /**
   * Claim a slot on the swallow onset grid. Returns -1 when the roll window is
   * already full, which the caller folds into the collective cascade sound.
   */
  _slot(now, gap = 0.026, window = 0.30) {
    let t = Math.max(now, this._nextSlot + gap);
    if (t > now + window) return -1;
    this._nextSlot = t;
    return t;
  }

  /**
   * Loudness compensation. Incoherent voices sum as sqrt(N), so 1/sqrt(N)
   * would hold the total exactly flat; the coefficient is a shade above 1 so a
   * pile-up still gets *louder* than a single swallow, just far less than 20×.
   */
  _load() {
    // Must sweep first. `_load()` runs before `_pan()` claims a chain, so
    // without this the first swallow after a burst was scaled down by a busy
    // count that had actually expired seconds earlier — it came out inaudible.
    this._sweepPans();
    const n = this._panBusy.length;
    if (n > this.stats.peakVoices) this.stats.peakVoices = n;
    return 1 / Math.sqrt(1 + n * 1.15);
  }

  /* ============================================== the swallow family ==== */

  /**
   * Preferred entry point. Pass the Consumable and everything — material, mass,
   * stereo position — follows from it.
   * @param {object|number} c Consumable, or a 0..1 size for the legacy call.
   */
  swallow(c, opts = {}) {
    if (!this.ready || !this.enabled) return this;
    const info = this._describe(c, opts);
    if (info.heavy) this._collapse(info);
    else this._light(info);
    return this;
  }

  /** Legacy + enriched. `size` may be a 0..1 number or a Consumable. */
  chomp(size = 0, opts = {}) {
    if (!this.ready || !this.enabled) return this;
    this._light(this._describe(size, opts));
    return this;
  }

  /** Heavy structural collapse — buildings, towers. */
  crumble(size = 1, opts = {}) {
    if (!this.ready || !this.enabled) return this;
    this._collapse(this._describe(size, opts, true));
    return this;
  }

  /**
   * Normalise "whatever game.js handed us" into one shape.
   * A bare number keeps working (that is the shipped contract); a Consumable
   * unlocks material, true radius and world position.
   */
  _describe(v, opts, forceHeavy = false) {
    let radius, tierId, kind, x, z, crumbles;
    if (v && typeof v === 'object') {
      radius = v.radius ?? 1;
      tierId = v.tier ? v.tier.id : 0;
      kind = v.sfx || v.kind || null;
      crumbles = !!v.crumbles;
      if (v.position) { x = v.position.x; z = v.position.z; }
    } else {
      const s = clamp(Number(v) || 0, 0, 1);
      // The shipped call sites are chomp(min(1, r/5)) and crumble(min(1, r/22)).
      radius = forceHeavy ? 0.6 + s * 21 : 0.2 + s * 4.8;
      tierId = forceHeavy ? 6 : Math.min(4, Math.round(s * 4));
      kind = null;
      crumbles = forceHeavy;
    }
    if (opts.x !== undefined) { x = opts.x; z = opts.z; }
    const mat = opts.material ? MATERIALS[opts.material] : materialFor(kind, tierId);
    return {
      radius: clamp(radius, 0.05, 90),
      tierId, kind, x, z, mat,
      heavy: forceHeavy || crumbles || tierId >= 6,
    };
  }

  /**
   * Everything from a cigarette end to a bus. Three layers:
   *   1. air rush past the lip (suction)
   *   2. the body — a modal hit whose partials ARE the material
   *   3. a granular debris tail
   */
  _light(info) {
    const ctx = this.ctx;
    const now = this._now();
    const t0 = this._slot(now);
    if (t0 < 0) { this._fold(info, now); return; }

    const mat = info.mat;
    const r = info.radius;
    // Continuous size → pitch. Log, because loudness/pitch perception is log
    // and because radius spans 0.15 m to 40 m across the game.
    const oct = Math.log2(clamp(r, 0.12, 40) / 0.55);
    const sizeF = Math.pow(2, -oct * 0.42);
    const mass = clamp(oct / 6.2, 0, 1);           // 0 = litter, 1 = a bus

    // Burst ladder: consecutive swallows climb, so a frame full of captures
    // reads as a run rather than a rattle. Only small things climb — a bus
    // rising a tone would just sound wrong.
    if (now - this._lastSwallow > 0.42) this._combo = 0;
    this._lastSwallow = now;
    const rung = this._combo++ % 10;
    const ladder = info.tierId <= 2 ? Math.pow(2, (rung * 1.0) / 12) : 1;

    const load = this._load();
    const dur = 0.10 + mass * 0.42;
    const end = t0 + dur + mat.tail.dur * (0.6 + mass) + 0.1;
    const out = this._pan(info.x, info.z, end);

    /* --- 1. air rush ---------------------------------------------------- */
    const air = mat.air;
    const aDur = 0.07 + mass * 0.30;
    const aSrc = this._noiseSrc(t0, t0 + aDur + 0.05, 0.9 + this._rnd() * 0.3);
    const aF = ctx.createBiquadFilter();
    aF.type = 'bandpass';
    aF.Q.value = air.q + mass * 1.2;
    aF.frequency.setValueAtTime(this._hz(air.f * lerp(1.25, 0.55, mass)), t0);
    aF.frequency.exponentialRampToValueAtTime(
      this._hz(air.f * lerp(0.34, 0.12, mass)), t0 + aDur
    );
    const aG = ctx.createGain();
    this._hit(aG, t0, (0.055 + mass * 0.115) * air.gain * load, 0.012 + mass * 0.02, aDur);
    aSrc.connect(aF); aF.connect(aG); aG.connect(out);

    /* --- 2. body -------------------------------------------------------- */
    // Transient click: the moment of contact, before anything rings.
    const cSrc = this._noiseSrc(t0, t0 + 0.06, 1);
    const cF = ctx.createBiquadFilter();
    cF.type = 'bandpass';
    cF.frequency.value = this._hz(mat.click * sizeF * ladder);
    cF.Q.value = mat.clickQ;
    const cG = ctx.createGain();
    this._hit(cG, t0, 0.075 * mat.clickG * load * lerp(1, 0.55, mass), 0.001, 0.020 + mass * 0.03);
    cSrc.connect(cF); cF.connect(cG); cG.connect(out);

    if (mat.tone > 0) {
      const f0 = mat.f0 * sizeF * ladder;
      const ring = mat.ring * lerp(0.75, 2.3, mass);
      for (let i = 0; i < mat.partials.length; i++) {
        const [ratio, amp] = mat.partials[i];
        const f = f0 * ratio;
        if (f > this.nyq - 400) continue;
        const o = ctx.createOscillator();
        o.type = i === 0 ? 'triangle' : 'sine';
        o.frequency.setValueAtTime(this._hz(f), t0);
        // Everything drops in pitch as it disappears: that IS the hole.
        o.frequency.exponentialRampToValueAtTime(
          this._hz(f * lerp(0.72, 0.42, mass)), t0 + dur
        );
        const g = ctx.createGain();
        // Higher partials die first — that is what damping means.
        const pd = ring * Math.pow(0.66, i) + 0.02;
        this._hit(g, t0, 0.11 * amp * mat.tone * load * lerp(0.85, 1.25, mass), 0.002, pd);
        o.connect(g); g.connect(out);
        this._src(o, t0, t0 + pd + 0.05);
      }
      // Sub thud. Present from quite small — a concrete barrier at 1 m across
      // has body, and gating it at "big only" left the whole mid-tier weedy.
      const subAmt = clamp((mass - 0.05) / 0.45, 0, 1);
      if (subAmt > 0.02) {
        const sub = ctx.createOscillator();
        sub.type = 'sine';
        sub.frequency.setValueAtTime(this._hz(110 * lerp(1.6, 0.42, mass)), t0);
        sub.frequency.exponentialRampToValueAtTime(this._hz(34), t0 + dur * 0.9);
        const sg = ctx.createGain();
        this._hit(sg, t0, 0.165 * subAmt * load, 0.006, dur * 0.9);
        sub.connect(sg); sg.connect(out);
        this._src(sub, t0, t0 + dur + 0.05);
      }
      if (mat.squeak) {
        // Cartoon yelp: a fast up-down blip, quiet, gone in 90 ms.
        const s = ctx.createOscillator();
        s.type = 'sine';
        const f = 600 + this._rnd() * 320;
        s.frequency.setValueAtTime(f, t0);
        s.frequency.exponentialRampToValueAtTime(f * 1.7, t0 + 0.045);
        s.frequency.exponentialRampToValueAtTime(f * 0.8, t0 + 0.09);
        const g = ctx.createGain();
        this._hit(g, t0, 0.05 * load, 0.006, 0.085);
        s.connect(g); g.connect(out);
        this._src(s, t0, t0 + 0.13);
      }
    }

    if (mat.thump) {
      const th = mat.thump;
      const o = ctx.createOscillator();
      o.type = 'sine';
      const f = th.f * lerp(1.35, 0.5, mass);
      o.frequency.setValueAtTime(this._hz(f), t0);
      o.frequency.exponentialRampToValueAtTime(this._hz(f * 0.45), t0 + th.d);
      const g = ctx.createGain();
      const d = th.d * lerp(0.8, 2.0, mass);
      this._hit(g, t0, th.g * load * lerp(0.7, 1.6, mass), 0.004, d);
      o.connect(g); g.connect(out);
      this._src(o, t0, t0 + d + 0.05);
    }

    if (mat.splash) {
      // Bubbly blips under the noise: a boat going down is not a thud.
      for (let i = 0; i < 3; i++) {
        const bt = t0 + 0.02 + this._rnd() * 0.22;
        const o = ctx.createOscillator();
        o.type = 'sine';
        const f = 300 + this._rnd() * 700;
        o.frequency.setValueAtTime(f, bt);
        o.frequency.exponentialRampToValueAtTime(f * 2.1, bt + 0.05);
        const g = ctx.createGain();
        this._hit(g, bt, 0.045 * load, 0.004, 0.055);
        o.connect(g); g.connect(out);
        this._src(o, bt, bt + 0.09);
      }
    }

    /* --- 3. debris tail -------------------------------------------------- */
    const tail = mat.tail;
    this._grains(t0 + 0.02 + mass * 0.05, out, {
      gain: tail.gain * 0.16 * load * lerp(0.7, 1.35, mass),
      freq: tail.f * lerp(1.15, 0.5, mass),
      q: tail.q,
      count: Math.round(tail.count * lerp(0.7, 1.6, mass)),
      dur: tail.dur * lerp(0.75, 2.0, mass),
      spread: tail.spread,
    });

    if (mass > 0.55) this._duckEvt(0.12 + mass * 0.16, 0.22);
  }

  /**
   * Buildings. A different sound in kind, not just in size: a low failure
   * groan, a body of falling masonry, and a long gravel tail with real rubble
   * impacts scattered through it.
   */
  _collapse(info) {
    const ctx = this.ctx;
    const now = this._now();
    const t0 = Math.max(now, this._nextSlot + 0.01);
    this._nextSlot = t0;
    const r = info.radius;
    const mass = clamp((Math.log2(clamp(r, 1, 90) / 4) + 1) / 5.2, 0, 1);
    const load = this._load();
    const dur = 0.85 + mass * 1.5;
    const out = this._pan(info.x, info.z, t0 + dur + 0.7, 0.6);
    const glassy = info.mat === MATERIALS.glass;

    // Structure failing: a big filtered noise mass sweeping down.
    const n1 = this._noiseSrc(t0, t0 + dur + 0.1, 0.6 + this._rnd() * 0.3);
    const f1 = ctx.createBiquadFilter();
    f1.type = 'lowpass';
    f1.frequency.setValueAtTime(this._hz(1200 - mass * 400), t0);
    f1.frequency.exponentialRampToValueAtTime(this._hz(70), t0 + dur);
    f1.Q.value = 0.9;
    const g1 = ctx.createGain();
    this._hit(g1, t0, (0.16 + mass * 0.16) * load, 0.05 + mass * 0.06, dur);
    n1.connect(f1); f1.connect(g1); g1.connect(out);

    // The groan: a heavy sine sliding down under everything.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    const sf = 78 - mass * 28 + this._rnd() * 12;
    sub.frequency.setValueAtTime(this._hz(sf), t0);
    sub.frequency.exponentialRampToValueAtTime(this._hz(22 + mass * 6), t0 + dur * 0.95);
    const sg = ctx.createGain();
    this._hit(sg, t0, (0.16 + mass * 0.14) * load, 0.02, dur * 0.95);
    sub.connect(sg); sg.connect(out);
    this._src(sub, t0, t0 + dur + 0.1);

    // A dry snap of the frame letting go, an instant before the mass moves.
    const snapT = t0 + 0.005;
    const sn = this._noiseSrc(snapT, snapT + 0.12, 1.2);
    const sf2 = ctx.createBiquadFilter();
    sf2.type = 'bandpass';
    sf2.frequency.value = this._hz(glassy ? 3400 : 1500);
    sf2.Q.value = 1.4;
    const sg2 = ctx.createGain();
    this._hit(sg2, snapT, 0.11 * load, 0.001, 0.08);
    sn.connect(sf2); sf2.connect(sg2); sg2.connect(out);

    // Rubble: two granular passes, one bright (dust and shards), one heavy.
    this._grains(t0 + 0.10, out, {
      gain: (glassy ? 0.14 : 0.10) * load,
      freq: glassy ? 4800 : 2200, q: glassy ? 3.0 : 1.2,
      count: 16 + Math.round(mass * 14), dur: dur * 0.9, spread: 2.2,
    });
    this._grains(t0 + 0.16, out, {
      gain: 0.13 * load,
      freq: 420 - mass * 120, q: 0.9,
      count: 10 + Math.round(mass * 10), dur: dur * 1.05, spread: 1.4,
    });

    // Discrete masonry impacts, so the tail has events in it, not just texture.
    const hits = 4 + Math.round(mass * 5);
    for (let i = 0; i < hits; i++) {
      const ht = t0 + 0.12 + this._rnd() * dur * 0.85;
      const o = ctx.createOscillator();
      o.type = 'triangle';
      const f = 90 + this._rnd() * 150;
      o.frequency.setValueAtTime(this._hz(f), ht);
      o.frequency.exponentialRampToValueAtTime(this._hz(f * 0.5), ht + 0.09);
      const g = ctx.createGain();
      this._hit(g, ht, 0.05 * load, 0.002, 0.10);
      o.connect(g); g.connect(out);
      this._src(o, ht, ht + 0.14);
    }

    this._duckEvt(0.34 + mass * 0.28, 0.45 + mass * 0.3);
  }

  /**
   * When a frame captures more than the onset grid can hold, the overflow is
   * not thrown away — it is accumulated and voiced as one collective roar, so
   * a hole eating a whole block sounds enormous instead of sounding clipped.
   */
  _fold(info, now) {
    this._pile += 1 + info.tierId * 0.5;
    this.stats.folded++;
    if (now - this._pileAt < 0.22 || this._pile < 5) return;
    this._pileAt = now;
    const heap = clamp(this._pile / 26, 0.2, 1);
    this._pile = 0;

    const ctx = this.ctx;
    const t0 = now;
    const load = this._load();
    const dur = 0.32 + heap * 0.4;
    const out = this._pan(info.x, info.z, t0 + dur + 0.3, 0.4);

    const n = this._noiseSrc(t0, t0 + dur + 0.08, 0.8);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(this._hz(1800), t0);
    f.frequency.exponentialRampToValueAtTime(this._hz(220), t0 + dur);
    f.Q.value = 0.8;
    const g = ctx.createGain();
    this._hit(g, t0, 0.10 * heap * load, 0.03, dur);
    n.connect(f); f.connect(g); g.connect(out);

    this._grains(t0, out, {
      gain: 0.13 * heap * load, freq: 1500, q: 1.1,
      count: 18, dur: dur * 1.1, spread: 2.4,
    });
    this._duckEvt(0.16 * heap, 0.25);
  }

  /* ================================================= event + UI audio === */

  /** Reward sting when the hole crosses into a new size tier. */
  levelUp(tierIndex = 0) {
    if (!this.ready || !this.enabled) return this;
    const ctx = this.ctx;
    const t0 = this._now() + 0.005;
    const root = semi(24 + clamp(tierIndex, 0, 7) * 2);   // climbs with the tier
    const out = this._pan(null, null, t0 + 1.4);

    // Bright fanfare: a major-add9 arpeggio, doubled an octave up, plus a
    // shimmer sweep. Deliberately the most "major" sound in the game.
    const arp = [0, 4, 7, 11, 14];
    for (let i = 0; i < arp.length; i++) {
      const t = t0 + i * 0.058;
      const f = root * Math.pow(2, arp[i] / 12);
      for (const [mul, amp, type] of [[1, 0.085, 'triangle'], [2, 0.035, 'square']]) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(this._hz(f * mul), t);
        const g = ctx.createGain();
        const d = 0.30 + i * 0.05;
        this._hit(g, t, amp, 0.004, d);
        o.connect(g); g.connect(out);
        this._src(o, t, t + d + 0.05);
      }
    }
    // Shimmer: a resonant sweep upward through the noise.
    const ns = this._noiseSrc(t0, t0 + 0.75, 1);
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.Q.value = 6;
    nf.frequency.setValueAtTime(this._hz(900), t0);
    nf.frequency.exponentialRampToValueAtTime(this._hz(7000), t0 + 0.6);
    const ng = ctx.createGain();
    this._hit(ng, t0, 0.06, 0.05, 0.65);
    ns.connect(nf); nf.connect(ng); ng.connect(out);

    // Low confirmation thump so it lands in the body, not just the ears.
    const b = ctx.createOscillator();
    b.type = 'sine';
    b.frequency.setValueAtTime(this._hz(140), t0);
    b.frequency.exponentialRampToValueAtTime(this._hz(48), t0 + 0.28);
    const bg = ctx.createGain();
    this._hit(bg, t0, 0.20, 0.005, 0.3);
    b.connect(bg); bg.connect(out);
    this._src(b, t0, t0 + 0.4);

    this._duckEvt(0.36, 0.5);
    return this;
  }

  /** Player ate a rival hole. The biggest positive event in the game. */
  devourPlayer() {
    if (!this.ready || !this.enabled) return this;
    const ctx = this.ctx;
    const t0 = this._now() + 0.004;
    const out = this._pan(null, null, t0 + 1.8);

    // Inhale: noise sweeping down hard, long enough to feel like a vacuum.
    const n = this._noiseSrc(t0, t0 + 1.0, 0.85);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 2.2;
    f.frequency.setValueAtTime(this._hz(4200), t0);
    f.frequency.exponentialRampToValueAtTime(this._hz(90), t0 + 0.85);
    const g = ctx.createGain();
    this._hit(g, t0, 0.26, 0.06, 0.9);
    n.connect(f); f.connect(g); g.connect(out);

    // The gulp.
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(this._hz(220), t0);
    o.frequency.exponentialRampToValueAtTime(this._hz(38), t0 + 0.7);
    const og = ctx.createGain();
    const of = ctx.createBiquadFilter();
    of.type = 'lowpass';
    of.frequency.setValueAtTime(this._hz(2400), t0);
    of.frequency.exponentialRampToValueAtTime(this._hz(180), t0 + 0.7);
    this._hit(og, t0, 0.16, 0.01, 0.75);
    o.connect(of); of.connect(og); og.connect(out);
    this._src(o, t0, t0 + 0.9);

    // Triumph stab on top — a minor-add-b7 hit, sharp and gone.
    [0, 7, 12, 15, 19].forEach((s, i) => {
      const t = t0 + 0.30 + i * 0.035;
      const oo = ctx.createOscillator();
      oo.type = 'square';
      oo.frequency.setValueAtTime(this._hz(semi(24) * Math.pow(2, s / 12)), t);
      const gg = ctx.createGain();
      this._hit(gg, t, 0.05, 0.003, 0.26);
      oo.connect(gg); gg.connect(out);
      this._src(oo, t, t + 0.32);
    });

    this._duckEvt(0.5, 0.75);
    return this;
  }

  /** Player was eaten. Everything closes over. */
  death() {
    if (!this.ready || !this.enabled) return this;
    const ctx = this.ctx;
    const t0 = this._now() + 0.004;
    const out = this._pan(null, null, t0 + 2.0);

    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(this._hz(340), t0);
    o.frequency.exponentialRampToValueAtTime(this._hz(32), t0 + 1.1);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(this._hz(3000), t0);
    lp.frequency.exponentialRampToValueAtTime(this._hz(140), t0 + 1.0);
    const g = ctx.createGain();
    this._hit(g, t0, 0.19, 0.01, 1.15);
    o.connect(lp); lp.connect(g); g.connect(out);
    this._src(o, t0, t0 + 1.3);

    const n = this._noiseSrc(t0, t0 + 1.1, 0.7);
    const nf = ctx.createBiquadFilter();
    nf.type = 'lowpass';
    nf.frequency.setValueAtTime(this._hz(1400), t0);
    nf.frequency.exponentialRampToValueAtTime(this._hz(60), t0 + 0.95);
    const ng = ctx.createGain();
    this._hit(ng, t0, 0.16, 0.03, 1.0);
    n.connect(nf); nf.connect(ng); ng.connect(out);

    // A falling minor third, the universal "you lost" gesture.
    [[semi(19), 0.0], [semi(16), 0.20], [semi(12), 0.42]].forEach(([f, d]) => {
      const t = t0 + 0.05 + d;
      const oo = ctx.createOscillator();
      oo.type = 'triangle';
      oo.frequency.setValueAtTime(this._hz(f), t);
      const gg = ctx.createGain();
      this._hit(gg, t, 0.07, 0.006, 0.42);
      oo.connect(gg); gg.connect(out);
      this._src(oo, t, t + 0.48);
    });

    // Muffle the music for a beat — the world going quiet around you.
    if (this.musicOut) {
      const p = this.musicOut.gain;
      const now = this._now();
      p.cancelScheduledValues(now);
      p.setValueAtTime(this._musicVol, now);
      p.linearRampToValueAtTime(this._musicVol * 0.18, now + 0.05);
      p.linearRampToValueAtTime(this._musicVol, now + 1.9);
    }
    return this;
  }

  /** 3 / 2 / 1 / GO. */
  countdownBeep(final = false) {
    if (!this.ready || !this.enabled) return this;
    const ctx = this.ctx;
    const t0 = this._now() + 0.004;
    const out = this._pan(null, null, t0 + 1.0);
    if (final) {
      [0, 7, 12].forEach((s, i) => {
        const t = t0 + i * 0.03;
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.setValueAtTime(this._hz(semi(36) * Math.pow(2, s / 12)), t);
        const g = ctx.createGain();
        this._hit(g, t, 0.09, 0.003, 0.5);
        o.connect(g); g.connect(out);
        this._src(o, t, t + 0.56);
      });
      const b = ctx.createOscillator();
      b.type = 'sine';
      b.frequency.setValueAtTime(this._hz(120), t0);
      b.frequency.exponentialRampToValueAtTime(this._hz(42), t0 + 0.3);
      const bg = ctx.createGain();
      this._hit(bg, t0, 0.22, 0.004, 0.32);
      b.connect(bg); bg.connect(out);
      this._src(b, t0, t0 + 0.4);
    } else {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(this._hz(semi(29)), t0);
      const g = ctx.createGain();
      this._hit(g, t0, 0.10, 0.003, 0.15);
      o.connect(g); g.connect(out);
      this._src(o, t0, t0 + 0.2);
    }
    return this;
  }

  /** Leaderboard movement. Quiet on purpose — it fires often. */
  rankChange(delta = 1) {
    if (!this.ready || !this.enabled) return this;
    const ctx = this.ctx;
    const t0 = this._now() + 0.004;
    const out = this._pan(null, null, t0 + 0.5);
    const up = delta > 0;
    const steps = up ? [0, 5] : [5, 2];
    steps.forEach((s, i) => {
      const t = t0 + i * 0.075;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(this._hz(semi(36) * Math.pow(2, s / 12)), t);
      const g = ctx.createGain();
      this._hit(g, t, 0.045, 0.003, 0.14);
      o.connect(g); g.connect(out);
      this._src(o, t, t + 0.2);
    });
    return this;
  }

  /**
   * Generic UI blip.
   * kind: 'click' | 'hover' | 'back'  — the original three, byte-identical.
   *       'menuOpen' | 'menuClose' | 'confirm' | 'error'  — added for the
   *       screens the meta layer grew. They branch out below rather than being
   *       folded into the one-oscillator path, because a two-layer sound cannot
   *       be expressed as "the click but at another pitch" and pretending it
   *       can is how every UI ends up sounding like the same beep.
   */
  ui(kind = 'click') {
    if (!this.ready || !this.enabled) return this;
    if (kind === 'menuOpen' || kind === 'menuClose' || kind === 'confirm' || kind === 'error') {
      return this._uiRich(kind);
    }
    const ctx = this.ctx;
    const t0 = this._now() + 0.004;
    const out = this._pan(null, null, t0 + 0.35);
    const f = kind === 'hover' ? semi(31) : kind === 'back' ? semi(24) : semi(36);
    const o = ctx.createOscillator();
    o.type = kind === 'hover' ? 'sine' : 'triangle';
    o.frequency.setValueAtTime(this._hz(f), t0);
    if (kind === 'back') o.frequency.exponentialRampToValueAtTime(this._hz(f * 0.7), t0 + 0.09);
    const g = ctx.createGain();
    this._hit(g, t0, kind === 'hover' ? 0.028 : 0.06, 0.002, kind === 'hover' ? 0.06 : 0.12);
    o.connect(g); g.connect(out);
    this._src(o, t0, t0 + 0.2);
    return this;
  }

  /** Match start: a downbeat hit + a rising whoosh, and the music takes off. */
  matchStart() {
    if (!this.ready || !this.enabled) return this;
    const ctx = this.ctx;
    const t0 = this._now() + 0.004;
    const out = this._pan(null, null, t0 + 1.4);

    const n = this._noiseSrc(t0, t0 + 0.75, 1);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 1.6;
    f.frequency.setValueAtTime(this._hz(300), t0);
    f.frequency.exponentialRampToValueAtTime(this._hz(6000), t0 + 0.55);
    const g = ctx.createGain();
    this._hit(g, t0, 0.13, 0.4, 0.3);
    n.connect(f); f.connect(g); g.connect(out);

    const b = ctx.createOscillator();
    b.type = 'sine';
    b.frequency.setValueAtTime(this._hz(150), t0 + 0.55);
    b.frequency.exponentialRampToValueAtTime(this._hz(44), t0 + 0.95);
    const bg = ctx.createGain();
    this._hit(bg, t0 + 0.55, 0.26, 0.004, 0.42);
    b.connect(bg); bg.connect(out);
    this._src(b, t0 + 0.55, t0 + 1.05);

    // Belt and braces on the restart rule: whatever the previous round left
    // running is gone before this one makes a sound. Fast fade — a storm from
    // the last match audibly dying over the new match's downbeat would be a
    // worse bug than the one it is fixing.
    this.stopAllLoops(0.08);
    this.stopVoices();
    // The bed duck is a hold-and-release schedule; a match that started while
    // one was pending would begin with the music quietly climbing back up.
    // dialogDuck is reset too: it is driven from outside, and if the previous
    // round ended mid-line nothing would ever push it back to unity.
    for (const n of [this.bedDuck, this.dialogDuck]) {
      if (!n) continue;
      const p = n.gain;
      p.cancelScheduledValues(t0);
      p.setValueAtTime(1, t0);
    }
    this._duckTarget = 1;
    this._duckUntil = 0;

    this._explicitMatchState = true;
    this._newMatch(this._now());
    return this;
  }

  /** Match over. Resolve rather than stop — the track has to land. */
  matchEnd(won = false) {
    if (!this.ready || !this.enabled) return this;
    const ctx = this.ctx;
    const t0 = this._now() + 0.01;
    const out = this._pan(null, null, t0 + 3.2);
    // Push the arc past the end so the sequencer resolves 'outro' by itself.
    this._explicitMatchState = true;
    this._matchT0 = this._now() - MATCH.DURATION - 2;

    // A sustained tonic chord — major if you won, minor if you did not.
    const tones = won ? [0, 4, 7, 12, 16] : [0, 3, 7, 12, 15];
    for (const s of tones) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = this._hz(semi(12 + s));
      const det = ctx.createOscillator();
      det.type = 'sawtooth';
      det.detune.value = 8;
      det.frequency.value = this._hz(semi(12 + s));
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(this._hz(3200), t0);
      lp.frequency.exponentialRampToValueAtTime(this._hz(500), t0 + 2.8);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.035, t0 + 0.25);
      g.gain.setValueAtTime(0.035, t0 + 1.2);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 3.0);
      o.connect(lp); det.connect(lp); lp.connect(g); g.connect(out);
      this._src(o, t0, t0 + 3.1);
      this._src(det, t0, t0 + 3.1);
    }
    this._crash(t0, 0.5, out);
    // The round is over: every bed goes with it, slowly enough to feel like a
    // resolution rather than a cut. (stopMusic() does this too — matchEnd is
    // not currently called by game.js, and whichever one the orchestrator wires
    // up, the guarantee has to hold.)
    this.stopAllLoops(1.2);
    this.stopVoices();
    return this;
  }

  /* --------------------------------------------------------- ducking ---- */

  _duckEvt(amount, recover) {
    if (!this.evtDuck) return;
    const p = this.evtDuck.gain;
    const now = this._now();
    const target = clamp(1 - amount, 0.15, 1);
    p.cancelScheduledValues(now);
    p.setValueAtTime(Math.max(target, p.value || 1), now);
    p.linearRampToValueAtTime(target, now + 0.012);
    p.linearRampToValueAtTime(1, now + 0.012 + Math.max(0.08, recover));
  }

  /* ========================================================= ambience === */

  /**
   * The hole's own presence: a continuous sub-bass rumble whose weight tracks
   * the radius, plus a wind bed that rises as the hole nears something big.
   *
   * @param {number} radius player hole radius, metres
   * @param {number} [x] world position — enables stereo placement of every sfx
   * @param {number} [z]
   * @param {number} [nearMass] 0..1 "there is something huge next to me"
   */
  updateAmbience(radius, x, z, nearMass) {
    if (!this.ready || !this.enabled) return this;
    const ctx = this.ctx;
    const now = this._now();

    if (x !== undefined && x !== null) { this._lx = x; this._lz = z; this._hasListener = true; }
    this._lr = radius;

    if (!this._rumble) this._buildAmbience();

    const t = clamp((radius - 1.0) / 34, 0, 1);
    // Perceptual, not linear: the difference between r=2 and r=6 must be
    // obvious, and the difference between r=40 and r=50 barely matters.
    const w = Math.pow(t, 0.55);

    this._set(this._rumble.gain, 0.02 + w * 0.30, now, 0.25);
    this._set(this._rumbleF.frequency, this._hz(48 + w * 74), now, 0.4);
    this._set(this._subOsc.frequency, this._hz(29 + (1 - w) * 16), now, 0.6);
    this._set(this._subGain.gain, 0.03 + w * 0.16, now, 0.3);

    // Suction bed. Without a nearMass hint from the game we approximate it
    // from how much has just been swallowed, which correlates well enough.
    const recent = clamp((0.5 - (now - this._lastSwallow)) * 2, 0, 1);
    // Decay the fold accumulator so a burst that stopped short of the cascade
    // threshold does not sit in it forever, quietly biasing the suction bed.
    if (this._pile > 0) this._pile *= 0.97;
    const want = nearMass !== undefined
      ? clamp(nearMass, 0, 1)
      : clamp(recent * 0.7 + this._pile * 0.03, 0, 1);
    this._suction += (want - this._suction) * 0.06;
    this._nearMass = this._suction;

    this._set(this._windGain.gain, (0.012 + w * 0.055) * (0.35 + this._suction), now, 0.3);
    this._set(this._windF.frequency, this._hz(340 + this._suction * 900 + w * 160), now, 0.35);
    this._set(this._windF.Q, 0.8 + this._suction * 2.6, now, 0.35);

    this._trackMatch(now, radius);
    // The music scheduler is pumped from here as well as from its own timer:
    // background tabs throttle setInterval to 1 Hz and the track would stutter.
    if (this._mus) this._pumpMusic();
    return this;
  }

  /**
   * Where the listener is. `updateAmbience` already does this as a side effect;
   * this exists so a caller that only wants to place sounds (a menu, a replay
   * camera) does not have to pretend to update the rumble.
   */
  setListener(x, z, radius) {
    this._lx = x; this._lz = z; this._hasListener = true;
    if (radius !== undefined) this._lr = radius;
    return this;
  }

  _buildAmbience() {
    const ctx = this.ctx;

    // Rumble: filtered noise, the "mass" of the void.
    const n = ctx.createBufferSource();
    n.buffer = this._noiseBuf;
    n.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 60;
    f.Q.value = 0.75;
    const g = ctx.createGain();
    g.gain.value = 0.0;
    n.connect(f); f.connect(g); g.connect(this.ambBus);
    n.start(0, this._rnd() * (this._noiseDur - 0.05));
    // Deliberately NOT registered in _live: these three run for the session and
    // are torn down by dispose(), not by a scheduled stop.
    this._rumbleSrc = n; this._rumbleF = f; this._rumble = g;

    // Sub: a pure tone under the noise. Noise alone never feels heavy.
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = 32;
    const og = ctx.createGain();
    og.gain.value = 0;
    // Slow drift so the sub is alive rather than a test tone.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.13;
    const lg = ctx.createGain();
    lg.gain.value = 2.2;
    lfo.connect(lg); lg.connect(o.frequency);
    o.connect(og); og.connect(this.ambBus);
    o.start(); lfo.start();
    this._subOsc = o; this._subGain = og; this._subLfo = lfo;

    // Wind/suction: bandpassed noise with a slow sweep.
    const wn = ctx.createBufferSource();
    wn.buffer = this._noiseBuf;
    wn.loop = true;
    wn.playbackRate.value = 0.55;
    const wf = ctx.createBiquadFilter();
    wf.type = 'bandpass';
    wf.frequency.value = 420;
    wf.Q.value = 1.1;
    const wg = ctx.createGain();
    wg.gain.value = 0;
    const wlfo = ctx.createOscillator();
    wlfo.type = 'sine';
    wlfo.frequency.value = 0.21;
    const wlg = ctx.createGain();
    wlg.gain.value = 120;
    wlfo.connect(wlg); wlg.connect(wf.frequency);
    wn.connect(wf); wf.connect(wg); wg.connect(this.ambBus);
    wn.start(0, this._rnd() * (this._noiseDur - 0.05)); wlfo.start();
    this._windSrc = wn; this._windF = wf; this._windGain = wg; this._windLfo = wlfo;
  }

  /** Smoothed param write that skips no-op automation (this runs 60×/s). */
  _set(param, v, now, tau) {
    if (Math.abs(param.value - v) < Math.abs(v) * 0.01 + 1e-4) return;
    param.setTargetAtTime(v, now, tau);
  }

  /* ============================================================ music === */

  /**
   * The arc is driven by the match clock. game.js does not currently tell us
   * where it is, so we infer it: `updateAmbience` is only called once a player
   * hole exists, and the radius snapping back to the start size means a new
   * round began. `setMatchState()` overrides the inference the moment anyone
   * calls it, and this method then does nothing.
   */
  _trackMatch(now, radius) {
    const reset = radius <= 1.35 && this._lastRadius > 2.2;
    this._lastRadius = radius;
    if (this._matchT0 === undefined) { this._newMatch(now); return; }
    // The reset heuristic stays armed even when the game drives the arc
    // explicitly, but only once the current arc has run out. Otherwise a single
    // matchEnd() would strand the track in its outro for the rest of the
    // session, since nothing would ever tell us a new round had begun.
    if (reset && (!this._explicitMatchState || now - this._matchT0 > MATCH.DURATION)) {
      this._newMatch(now);
      return;
    }
  }

  _newMatch(t0) {
    this._matchT0 = t0;
    if (this._mus) { this._mus.riserFired = false; this._mus.outroBar = -1; }
  }

  /**
   * Explicit, preferred: call from game.js with the match clock.
   * @param {number} timeLeft seconds remaining
   * @param {string} [phase] 'countdown' | 'playing' | 'results'
   */
  setMatchState(timeLeft, phase) {
    this._explicitMatchState = true;
    if (!this.ready) return this;
    const now = this.ctx.currentTime;
    const elapsed = phase === 'countdown' ? 0 : MATCH.DURATION - timeLeft;
    // Anchor the arc to the audio clock so the sequencer, which schedules a
    // third of a second ahead, can resolve sections itself without waiting for
    // another frame to tell it where it is.
    const anchor = now - elapsed;
    if (this._matchT0 === undefined || Math.abs(anchor - this._matchT0) > 1.0) {
      this._newMatch(anchor);
    }
    if (phase === 'results') this._matchT0 = now - MATCH.DURATION - 2;
    return this;
  }

  /** Which section a given point in the match belongs to. */
  _sectionFor(elapsed) {
    if (elapsed === undefined || elapsed < 0) return 'intro';
    if (elapsed < 8) return 'intro';
    if (elapsed < 46) return 'grooveA';
    if (elapsed < 92) return 'grooveB';
    if (elapsed < FRENZY_AT) return 'build';
    if (elapsed < MATCH.DURATION + 1.5) return 'frenzy';
    return 'outro';
  }

  /**
   * A proper look-ahead scheduler. The old implementation fired one setInterval
   * per note, which drifts audibly; this queues ~0.35 s of music at a time
   * against the audio clock, so timing is sample-accurate regardless of how
   * badly the main thread is behaving during a city-wide collapse.
   */
  startMusic() {
    if (!this.ready || !this.enabled || this._mus) return this;
    const ctx = this.ctx;
    this._mus = {
      t: ctx.currentTime + 0.12,
      step: 0,
      section: 'intro',
      rnd: mulberry32(0x1a4b_7e21),
      motif: null,
      riserFired: false,
      outroBar: -1,
    };
    if (typeof setInterval === 'function') {
      this._musicTimer = setInterval(() => this._pumpMusic(), 40);
    }
    this._pumpMusic();
    return this;
  }

  stopMusic() {
    if (this._musicTimer) { clearInterval(this._musicTimer); this._musicTimer = null; }
    this._mus = null;
    // game.js calls stopMusic() and nothing else when the match reaches
    // RESULTS, so this is the one call site that is guaranteed to run at the
    // end of every round. A siren or a storm bed surviving into the results
    // screen is the exact failure the spec's checklist tests for, so the loops
    // go down here too — with a slow fade, because this is a graceful ending.
    this.stopAllLoops(0.6);
    this.stopVoices();
    return this;
  }

  /** Schedule every step that falls inside the look-ahead horizon. */
  _pumpMusic(horizon) {
    const m = this._mus;
    if (!m) return this;
    const now = this.ctx.currentTime;
    // Catch-up guard. A backgrounded tab throttles the pump to 1 Hz and can
    // stall for many seconds; without this the next pump would schedule every
    // missed 16th at a time already in the past, and Web Audio fires those
    // immediately — a whole bar of music arriving as one bang.
    if (horizon === undefined && m.t < now - 0.25) {
      const missed = Math.ceil((now - m.t) / STEP);
      const toBar = (16 - ((m.step + missed) % 16)) % 16;   // resume on a bar line
      m.step += missed + toBar;
      m.t += (missed + toBar) * STEP;
    }
    const h = horizon !== undefined ? horizon : now + 0.35;
    let guard = 0;
    while (m.t < h && guard++ < 512) {
      this._step(m, m.t);
      m.t += STEP;
      m.step++;
    }
    return this;
  }

  /** Render `seconds` of music into the schedule in one go (offline tests). */
  renderMusic(seconds) {
    if (!this._mus) this.startMusic();
    return this._pumpMusic(this._mus.t + seconds);
  }

  /* ------------------------------------------------------- music voices - */

  _kick(t, vel, dest) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(this._hz(150), t);
    o.frequency.exponentialRampToValueAtTime(this._hz(46), t + 0.055);
    const g = ctx.createGain();
    this._hit(g, t, 0.25 * vel, 0.002, 0.26);
    o.connect(g); g.connect(dest);
    this._src(o, t, t + 0.34);

    // Beater click, or the kick disappears the moment the mix gets busy.
    const n = this._noiseSrc(t, t + 0.03, 1);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = this._hz(2200); f.Q.value = 1.2;
    const ng = ctx.createGain();
    this._hit(ng, t, 0.05 * vel, 0.001, 0.016);
    n.connect(f); f.connect(ng); ng.connect(dest);

    // Sidechain the melodic side to the kick. This is the pump.
    const p = this.musicDuck.gain;
    p.cancelScheduledValues(t);
    p.setValueAtTime(1, t);
    p.linearRampToValueAtTime(0.45, t + 0.012);
    p.linearRampToValueAtTime(1, t + BEAT * 0.62);
    this.stats.notes++;
  }

  _snare(t, vel, dest) {
    const ctx = this.ctx;
    // Three-tap clap: a single burst reads as a hi-hat, three reads as hands.
    for (let i = 0; i < 3; i++) {
      const tt = t + i * 0.009;
      const n = this._noiseSrc(tt, tt + 0.2, 1);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = this._hz(1900 + i * 260);
      f.Q.value = 1.1;
      const g = ctx.createGain();
      this._hit(g, tt, 0.11 * vel * (i === 2 ? 1.25 : 0.7), 0.001, i === 2 ? 0.16 : 0.035);
      n.connect(f); f.connect(g); g.connect(dest);
    }
    // Body tone under the noise.
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(this._hz(220), t);
    o.frequency.exponentialRampToValueAtTime(this._hz(150), t + 0.09);
    const og = ctx.createGain();
    this._hit(og, t, 0.06 * vel, 0.002, 0.10);
    o.connect(og); og.connect(dest);
    this._src(o, t, t + 0.16);
    this.stats.notes++;
  }

  _hat(t, vel, open, dest) {
    const ctx = this.ctx;
    const d = open ? 0.20 : 0.036;
    const n = this._noiseSrc(t, t + d + 0.04, 1.6);
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = this._hz(7200);
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.value = this._hz(9800);
    f2.Q.value = 0.7;
    const g = ctx.createGain();
    this._hit(g, t, 0.058 * vel, 0.001, d);
    n.connect(f); f.connect(f2); f2.connect(g); g.connect(dest);
    this.stats.notes++;
  }

  _tom(t, freq, vel, dest) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(this._hz(freq), t);
    o.frequency.exponentialRampToValueAtTime(this._hz(freq * 0.6), t + 0.16);
    const g = ctx.createGain();
    this._hit(g, t, 0.13 * vel, 0.002, 0.19);
    o.connect(g); g.connect(dest);
    this._src(o, t, t + 0.24);
    this.stats.notes++;
  }

  _crash(t, vel, dest) {
    const ctx = this.ctx;
    const n = this._noiseSrc(t, t + 1.6, 1.35);
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = this._hz(4200);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.10 * vel, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
    n.connect(f); f.connect(g); g.connect(dest || this.musicDrums);
    this.stats.notes++;
  }

  _bass(t, freq, dur, vel, cutoff, dest) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(this._hz(freq), t);
    const o2 = ctx.createOscillator();
    o2.type = 'square';
    o2.frequency.setValueAtTime(this._hz(freq * 0.5), t);   // sub octave
    // Mixed well under the saw. At unity it doubled the weight of every bass
    // note an octave down and the whole track read as boom.
    const o2g = ctx.createGain();
    o2g.gain.value = 0.34;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 7;
    f.frequency.setValueAtTime(this._hz(cutoff), t);
    f.frequency.exponentialRampToValueAtTime(this._hz(cutoff * 0.35), t + dur * 0.9);
    const g = ctx.createGain();
    this._hit(g, t, 0.105 * vel, 0.006, dur);
    o.connect(f); o2.connect(o2g); o2g.connect(f); f.connect(g); g.connect(dest);
    this._src(o, t, t + dur + 0.08);
    this._src(o2, t, t + dur + 0.08);
    this.stats.notes++;
  }

  _pluck(t, freq, dur, vel, dest, sendAmt = 0) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(this._hz(freq), t);
    const o2 = ctx.createOscillator();
    o2.type = 'sawtooth';
    o2.detune.value = 6;
    o2.frequency.setValueAtTime(this._hz(freq), t);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 4;
    f.frequency.setValueAtTime(this._hz(freq * 7 + 900), t);
    f.frequency.exponentialRampToValueAtTime(this._hz(freq * 2 + 260), t + dur);
    const g = ctx.createGain();
    this._hit(g, t, 0.100 * vel, 0.004, dur);
    o.connect(f); o2.connect(f); f.connect(g); g.connect(dest);
    if (sendAmt > 0) {
      const s = ctx.createGain();
      s.gain.value = sendAmt;
      g.connect(s); s.connect(this.leadSend);
    }
    this._src(o, t, t + dur + 0.08);
    this._src(o2, t, t + dur + 0.08);
    this.stats.notes++;
  }

  /** Detuned three-saw stack per note — the pad that carries the whole track. */
  _pad(t, freqs, dur, vel, cutoff, dest) {
    const ctx = this.ctx;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 1.4;
    f.frequency.setValueAtTime(this._hz(cutoff * 0.55), t);
    f.frequency.linearRampToValueAtTime(this._hz(cutoff), t + dur * 0.6);
    f.frequency.linearRampToValueAtTime(this._hz(cutoff * 0.6), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0004, 0.044 * vel), t + dur * 0.34);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    f.connect(g); g.connect(dest);
    const send = ctx.createGain();
    send.gain.value = 0.5;
    g.connect(send); send.connect(this.fxSend);

    for (const fr of freqs) {
      for (const det of [-7, 0, 7]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = this._hz(fr);
        o.detune.value = det;
        o.connect(f);
        this._src(o, t, t + dur + 0.05);
      }
    }
    this.stats.notes++;
  }

  /* ------------------------------------------------------ the sequencer - */

  /**
   * One 16th note. Everything about the arrangement lives here: which layers
   * are awake in which section, and how busy each of them is.
   */
  _step(m, t) {
    const s16 = m.step % 16;             // position in the bar
    const bar = Math.floor(m.step / 16);
    // Sections change on bar lines only, and are resolved from the note's own
    // scheduled time rather than from "now" — the sequencer runs ahead of the
    // clock, so asking the frame loop where the match is would land the frenzy
    // downbeat up to a third of a second late.
    const elapsed = this._matchT0 === undefined ? undefined : t - this._matchT0;
    if (s16 === 0) {
      const want = this._sectionFor(elapsed);
      if (want !== m.section) {
        const prev = m.section;
        m.section = want;
        if (want === 'outro') m.outroBar = bar;
        // Frenzy gets an unmissable downbeat.
        if (want === 'frenzy') {
          this._crash(t, 1.0, this.musicDrums);
          this._duckEvt(0.2, 0.4);
        } else if (prev === 'intro') {
          this._crash(t, 0.55, this.musicDrums);
        }
      }
      // One bar of riser leading into the frenzy, fired before the switch.
      if (m.section === 'build' && !m.riserFired
          && elapsed !== undefined && elapsed >= FRENZY_AT - BAR) {
        m.riserFired = true;
        this._riser(t, BAR, this.musicDrums);
      }
    }

    const sec = m.section;
    if (sec === 'outro') { this._stepOutro(m, t, s16, bar); return; }

    const frenzy = sec === 'frenzy';
    const prog = frenzy ? PROG_FRENZY : PROG_MAIN;
    const chord = prog[bar % prog.length];
    const scale = frenzy ? SCALE_FRENZY : SCALE_MIN;
    const drums = sec !== 'intro';
    const rnd = m.rnd;

    const openness =
      sec === 'intro' ? 0.34 : sec === 'grooveA' ? 0.48
      : sec === 'grooveB' ? 0.66 : sec === 'build' ? 0.82 : 1.0;

    /* ---- intro: a pulse rather than silence ----------------------------- */
    // An intro that is 20 dB under the groove reads as "the music failed to
    // start". It gets a heartbeat and a root note, just no kit.
    if (sec === 'intro') {
      if (s16 === 0 || s16 === 8) {
        this._bass(t, semi(chord.root - 12), BEAT * 1.4, 0.55, 300, this.musicMel);
      }
      if (s16 === 0) this._kick(t, 0.30, this.musicDrums);
    }

    /* ---- drums --------------------------------------------------------- */
    if (drums) {
      if (s16 % 4 === 0) this._kick(t, s16 === 0 ? 1.0 : 0.88, this.musicDrums);
      if (frenzy && s16 === 14) this._kick(t, 0.7, this.musicDrums);

      if (sec !== 'grooveA' && (s16 === 4 || s16 === 12)) {
        this._snare(t, frenzy ? 1.0 : 0.82, this.musicDrums);
      }
      const hatEvery = (sec === 'build' || frenzy) ? 1 : 2;
      if (s16 % hatEvery === 0) {
        const accent = s16 % 4 === 2 ? 1.0 : 0.55;
        this._hat(t, accent * (0.6 + openness * 0.5), s16 === 14 && !frenzy, this.musicDrums);
      }
      // Snare roll through the riser bar. The riser alone was barely visible in
      // the render; the roll is what actually tells a player something is about
      // to happen, and FRENZY is the one moment that must not sneak up.
      if (m.riserFired && sec === 'build') {
        this._snare(t, 0.20 + (s16 / 15) * 0.85, this.musicDrums);
      }
      // Tom fill on the last beat of every 8th bar — the thing that stops a
      // 150 s loop feeling like a loop.
      if (bar % 8 === 7 && s16 >= 12) {
        this._tom(t, 190 - (s16 - 12) * 22, 0.8, this.musicDrums);
      }
    }

    /* ---- bass ---------------------------------------------------------- */
    if (sec !== 'intro') {
      const eighth = s16 % 2 === 0;
      const play = frenzy ? true : eighth;
      if (play) {
        const oct = frenzy && s16 % 8 === 6 ? 12 : 0;
        const jump = (!frenzy && s16 === 10) ? 12 : 0;
        this._bass(
          t, semi(chord.root + oct + jump), frenzy ? STEP * 0.9 : STEP * 1.7,
          s16 === 0 ? 1.0 : 0.78,
          420 + openness * 1500, this.musicMel
        );
      }
    }

    /* ---- pad ----------------------------------------------------------- */
    if (s16 === 0) {
      const voices = chord.tones.map((n) => semi(n + 24));
      this._pad(t, voices, BAR * 0.98, 0.55 + openness * 0.55,
        700 + openness * 2400, this.musicMel);
    }

    /* ---- arp ----------------------------------------------------------- */
    if (sec !== 'intro' || s16 % 4 === 0) {
      const arpEvery = (sec === 'build' || frenzy) ? 1 : 2;
      if (s16 % arpEvery === 0) {
        const idx = Math.floor(m.step / arpEvery);
        const tones = chord.tones;
        const n = tones[idx % tones.length] + (frenzy ? 24 : 12) + 12;
        this._pluck(t, semi(n), STEP * (frenzy ? 1.4 : 2.2),
          (sec === 'intro' ? 0.75 : 0.6) * (0.7 + openness * 0.4),
          this.musicMel, sec === 'intro' ? 0.45 : 0.18);
      }
    }

    /* ---- lead ---------------------------------------------------------- */
    if (sec === 'grooveB' || sec === 'build' || frenzy) {
      // Regenerate a 2-bar motif every 2 bars, then repeat it — repetition is
      // what makes generative music sound composed rather than random.
      if (s16 === 0 && bar % 2 === 0) {
        m.motif = [];
        let deg = 4 + Math.floor(rnd() * 3);
        for (let i = 0; i < 16; i++) {
          if (rnd() < (frenzy ? 0.52 : 0.34)) {
            deg = clamp(deg + Math.round((rnd() - 0.5) * 5), 0, scale.length + 4);
            m.motif.push({ i: i * 2, deg });
          }
        }
      }
      if (m.motif) {
        const pos = (bar % 2) * 16 + s16;
        for (const nte of m.motif) {
          if (nte.i !== pos) continue;
          const oct = frenzy ? 36 : 24;
          const d = nte.deg;
          const n = scale[d % scale.length] + 12 * Math.floor(d / scale.length);
          this._pluck(t, semi(n + oct), STEP * 3.0, frenzy ? 0.95 : 0.7,
            this.musicMel, 0.55);
        }
      }
    }

  }

  _stepOutro(m, t, s16, bar) {
    // Everything drains away: one tonic pad per bar, filter closing, no drums.
    if (s16 !== 0) return;
    const n = m.outroBar < 0 ? 0 : bar - m.outroBar;
    const fade = Math.max(0, 1 - n * 0.22);
    if (fade <= 0.02) return;
    this._pad(t, [semi(24), semi(27), semi(31), semi(36)],
      BAR * 1.4, 0.8 * fade, 900 * fade + 300, this.musicMel);
  }

  _riser(t, dur, dest) {
    const ctx = this.ctx;
    const n = this._noiseSrc(t, t + dur + 0.05, 1);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 3.5;
    f.frequency.setValueAtTime(this._hz(320), t);
    f.frequency.exponentialRampToValueAtTime(this._hz(11000), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.17, t + dur * 0.95);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(f); f.connect(g); g.connect(dest);

    // A second, pitched riser an octave apart. One noise sweep on its own is
    // easy to mistake for a hi-hat opening; two layers read as intent.
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(this._hz(semi(12)), t);
    o.frequency.exponentialRampToValueAtTime(this._hz(semi(36)), t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(this._hz(700), t);
    lp.frequency.exponentialRampToValueAtTime(this._hz(6000), t + dur);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.055, t + dur * 0.9);
    og.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(lp); lp.connect(og); og.connect(dest);
    this._src(o, t, t + dur + 0.05);
  }

  /* ======================================= gesture + loop primitives ==== */

  /**
   * One filtered-noise gesture — the workhorse behind every whoosh, swell,
   * wind fall and rush in the section below. Three nodes, one call, which is
   * what keeps twenty new effects from turning into two thousand lines.
   *
   * @returns {number} when it finishes, so gestures can be chained.
   */
  _swoosh(t0, dest, { f0, f1, dur, peak, q = 1.2, type = 'bandpass', attack, rate = 1 }) {
    const ctx = this.ctx;
    const src = this._noiseSrc(t0, t0 + dur + 0.08, rate);
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(this._hz(f0), t0);
    f.frequency.exponentialRampToValueAtTime(this._hz(f1), t0 + dur);
    const g = ctx.createGain();
    // Default attack is a quarter of the gesture and never under 8 ms. The
    // mixing rules forbid jump scares, and a 1 ms attack on a wideband noise
    // burst IS a jump scare no matter how quiet you make it.
    this._hit(g, t0, peak, attack === undefined ? Math.min(0.09, dur * 0.25) : attack, dur);
    src.connect(f); f.connect(g); g.connect(dest);
    return t0 + dur;
  }

  /** One decaying pitched tone, optionally gliding to `f1`. */
  _tone(t0, dest, { f0, f1, dur, peak, type = 'triangle', attack = 0.004, detune = 0 }) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.detune.value = detune;
    o.frequency.setValueAtTime(this._hz(f0), t0);
    if (f1 !== undefined) o.frequency.exponentialRampToValueAtTime(this._hz(f1), t0 + dur);
    const g = this.ctx.createGain();
    this._hit(g, t0, peak, attack, dur);
    o.connect(g); g.connect(dest);
    this._src(o, t0, t0 + dur + 0.06);
    return o;
  }

  /** A modulator wired into an AudioParam, registered so it dies with the loop. */
  _lfo(t0, hz, depth, target, type = 'sine') {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = hz;
    const g = this.ctx.createGain();
    g.gain.value = depth;
    o.connect(g); g.connect(target);
    this._src(o, t0, t0 + LOOP_MAX);
    return o;
  }

  /**
   * Minimum interval per effect key. This is the "strict concurrency cap" the
   * mixing rules ask for, applied to the effects that a physics or AI system
   * can fire dozens of times a second: three cars sliding is texture, thirty is
   * white noise, and the thirty cost thirty times the nodes to sound worse.
   *
   * @returns {boolean} true when the caller may play.
   */
  _throttle(key, gap) {
    const now = this._now();
    const last = this._throttled.get(key);
    if (last !== undefined && now - last < gap) { this.stats.throttled++; return false; }
    this._throttled.set(key, now);
    return true;
  }

  /**
   * Start a keyed loop — or hand back the one already running under that key.
   *
   * Idempotence is the entire point. `powerupLoop('vacuum')` is called from a
   * state machine that can re-enter (a second Vacuum Boost picked up while the
   * first still ticks, a hot reload, a rejoin), and the spec is explicit that
   * no loop may stack or survive a restart. One key, one voice; every handle
   * lives in `this._loops`, so `stopAllLoops()` can prove the match ended
   * silent instead of hoping it did.
   *
   * @param {string} key
   * @param {(fade: GainNode, t0: number) => object} build must connect its
   *   graph INTO `fade` and return
   *   { sources[], nodes[], peak, attack, release, dest, chain }.
   *   It must NOT connect `fade` itself — _startLoop owns that edge and the
   *   envelope on it, which is what makes every loop stoppable the same way.
   * @returns {{stop:Function, move:Function, setIntensity:Function, active:boolean}}
   */
  _startLoop(key, build) {
    if (!this.ready || !this.enabled) return DEAD_LOOP;
    const live = this._loops.get(key);
    if (live && live.active) return live;
    if (this._loops.size >= LOOP_CAP) { this.stats.loopsDropped++; return DEAD_LOOP; }

    const ctx = this.ctx;
    const t0 = this._now();
    const fade = ctx.createGain();
    fade.gain.setValueAtTime(0.0001, t0);

    const spec = build(fade, t0) || {};
    const peak = Math.max(0.0002, spec.peak === undefined ? 0.10 : spec.peak);
    const attack = Math.max(0.02, spec.attack === undefined ? 0.40 : spec.attack);
    const release = Math.max(0.03, spec.release === undefined ? 0.35 : spec.release);
    fade.connect(spec.dest || this.ambBus);
    // Every loop fades IN. A bed that arrives at full level is both the jump
    // scare the mixing rules forbid and the single loudest tell that a sound
    // is a loop rather than the world.
    fade.gain.exponentialRampToValueAtTime(peak, t0 + attack);

    const handle = {
      key,
      active: true,
      /** 0..1.5 against the loop's own peak: storm strength, boost charge. */
      setIntensity: (v) => {
        if (!handle.active) return handle;
        const t = this._now();
        const p = fade.gain;
        // Read, cancel, re-anchor. Letting a setTargetAtTime overlap the fade-in
        // ramp leaves two automations fighting over the same window and the
        // result differs between engines.
        const at = Math.max(0.0001, p.value);
        p.cancelScheduledValues(t);
        p.setValueAtTime(at, t);
        p.setTargetAtTime(Math.max(0.0002, peak * clamp(num(v, 1), 0, 1.5)), t, 0.25);
        return handle;
      },
      /** Positional loops only (sirens); a no-op on the non-positional beds. */
      move: (x, z) => { if (spec.chain) spec.chain.move(x, z); return handle; },
      stop: (fadeOut) => {
        if (!handle.active) return handle;
        handle.active = false;
        if (this._loops.get(key) === handle) this._loops.delete(key);
        this.stats.loopsStopped++;
        const t = this._now();
        const f = Math.max(0.03, fadeOut === undefined ? release : fadeOut);
        const p = fade.gain;
        // Read the running value before cancelling: cancelScheduledValues drops
        // the pending ramp but does not pin the param, so ramping to zero from
        // an un-anchored value steps first and clicks.
        const at = Math.max(0.0001, p.value);
        p.cancelScheduledValues(t);
        p.setValueAtTime(at, t);
        p.exponentialRampToValueAtTime(0.0001, t + f);
        const end = t + f + 0.05;
        // Re-scheduling stop() on an already-scheduled source is legal and the
        // last call wins — that is how the LOOP_MAX dead-man's switch set at
        // start time gets pulled forward to "now, plus the release".
        for (const s of spec.sources || []) {
          try { s.stop(end); } catch (e) { /* already stopped */ }
        }
        // Disconnect only on a real-time context. setTimeout runs on WALL clock,
        // and an OfflineAudioContext rendering 60 s in 300 ms would tear the
        // graph down in the middle of the release it is still rendering.
        if (!this._external && typeof setTimeout === 'function') {
          setTimeout(() => {
            for (const n of spec.nodes || []) { try { n.disconnect(); } catch (e) { /* noop */ } }
            try { fade.disconnect(); } catch (e) { /* noop */ }
          }, (f + 0.25) * 1000);
        }
        return handle;
      },
    };
    this._loops.set(key, handle);
    this.stats.loopsStarted++;
    return handle;
  }

  /**
   * A NON-pooled positional chain for sounds that outlive the pan pool's
   * recycler: a patrol car's siren is audible for twenty seconds and moves the
   * whole time, and `_pan` would hand its chain to a swallow after 80 ms.
   */
  _liveChain(x, z, spread = 1) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const send = ctx.createGain();
    let p = null;
    if (ctx.createStereoPanner) {
      p = ctx.createStereoPanner();
      g.connect(p); p.connect(this.sfxBus);
    } else {
      g.connect(this.sfxBus);          // ancient Safari: mono, still audible
    }
    g.connect(send); send.connect(this.fxSend);
    const chain = {
      g, p, send,
      nodes: p ? [g, p, send] : [g, send],
      move: (nx, nz) => {
        const pl = this._placement(nx, nz, spread);
        const t = this._now();
        // setTargetAtTime, not setValueAtTime: a car crossing the screen moves
        // every frame, and a stepped pan/gain at 60 Hz is 60 clicks a second.
        g.gain.setTargetAtTime(pl.att, t, 0.06);
        send.gain.setTargetAtTime(pl.wet * 0.30, t, 0.12);
        if (p) p.pan.setTargetAtTime(pl.pan, t, 0.06);
      },
    };
    const pl0 = this._placement(x, z, spread);
    g.gain.value = pl0.att;
    send.gain.value = pl0.wet * 0.30;
    if (p) p.pan.value = pl0.pan;
    return chain;
  }

  /**
   * Stop every continuous sound. Called from stopMusic(), matchStart(),
   * matchEnd() and dispose(), because "no audio loops continue after match
   * restart" is on the spec's test checklist and the only way to pass it
   * reliably is to have exactly one place that knows what is running.
   */
  stopAllLoops(fade = 0.30) {
    // Snapshot: every stop() deletes its own key, and mutating a Map while
    // iterating it skips entries.
    for (const h of Array.from(this._loops.values())) {
      try { h.stop(fade); } catch (e) { /* a dead context must not throw */ }
    }
    this._loops.clear();
    return this;
  }

  /** How many loops are live (diagnostics, and the police system's own cap). */
  loopCount(prefix) {
    if (!prefix) return this._loops.size;
    let n = 0;
    for (const k of this._loops.keys()) if (k.indexOf(prefix) === 0) n++;
    return n;
  }

  /* ============================================================ voices === */

  /**
   * Play a pre-generated dialogue buffer on the voice bus.
   *
   * The voice assets themselves are produced offline and server-side (the key
   * never reaches the client — spec §Security), so all this module does is own
   * the playback policy: a hard cap of three lines at once, distance placement,
   * and an automatic bed duck for the length of the line.
   *
   * @param {AudioBuffer} buffer decoded line
   * @param {{x?:number, z?:number, gain?:number, duck?:number, rate?:number}} opts
   * @returns {object} handle with .stop()
   */
  playVoice(buffer, opts = {}) {
    if (!this.ready || !this.enabled || !buffer || this._voicesMuted) return DEAD_LOOP;
    const now = this._now();
    // Sweep first, or a cap that filled up once stays full forever.
    for (let i = this._voicesLive.length - 1; i >= 0; i--) {
      if (this._voicesLive[i].until <= now) this._voicesLive.splice(i, 1);
    }
    // Drop, never queue. A queued line arrives after the thing it is reacting
    // to has left the screen, which is worse than not saying it at all.
    if (this._voicesLive.length >= VOICE_CAP) { this.stats.voicesDropped++; return DEAD_LOOP; }

    const ctx = this.ctx;
    const rate = clamp(num(opts.rate, 1), 0.5, 2);
    const dur = buffer.duration / rate;
    const out = this.voiceChain(opts.x, opts.z, now + dur + 0.15);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    const level = clamp(num(opts.gain, 1), 0, 1.4);
    // 8 ms in / 25 ms out. Speech assets are trimmed to the waveform and a hard
    // start on a voiced consonant clicks; this is short enough not to eat the
    // transient that makes a line intelligible.
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(level, now + 0.008);
    g.gain.setValueAtTime(level, now + Math.max(0.05, dur - 0.025));
    g.gain.linearRampToValueAtTime(0.0001, now + dur);
    src.connect(g); g.connect(out);
    this._src(src, now, now + dur + 0.05);

    const rec = { until: now + dur, src };
    this._voicesLive.push(rec);
    this.stats.voicesPlayed++;
    // Key lines duck the bed. Shallow by default: dialogue in this game is
    // colour, and a half-second -6 dB hole in the music for every "nope nope
    // nope" would be far more distracting than the line itself.
    this.duck(num(opts.duck, 0.24), dur);

    return {
      key: 'voice',
      active: true,
      stop: () => {
        const t = this._now();
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), t);
        g.gain.linearRampToValueAtTime(0.0001, t + 0.05);
        try { src.stop(t + 0.06); } catch (e) { /* already done */ }
        rec.until = 0;
        return this;
      },
      move: () => this,
      setIntensity: () => this,
    };
  }

  /**
   * A positional route into the voice bus, for a caller that wants to build its
   * own dialogue voice (a synthesised placeholder line, a radio-filtered
   * dispatch read) instead of handing over a buffer.
   *
   * Note this is a fresh chain per call rather than the pooled one: voice
   * chains are rare (three at once, by policy) and pooling them would put
   * dialogue and sfx on the same recycled node.
   */
  voiceChain(x, z, until, spread = 0.7) {
    const ctx = this.ctx;
    const chain = this._liveChain(x, z, spread);
    // Re-point it at the voice bus. _liveChain wires to sfxBus by default,
    // which is right for sirens and wrong for words.
    try { chain.g.disconnect(); } catch (e) { /* fresh node */ }
    if (chain.p) { chain.g.connect(chain.p); try { chain.p.disconnect(); } catch (e) { /* noop */ } chain.p.connect(this.voiceBus); }
    else chain.g.connect(this.voiceBus);
    chain.g.connect(chain.send);
    // Dialogue gets a fraction of the room everything else gets. A reverberant
    // voice is an unintelligible voice, and these lines are one second long.
    chain.send.gain.value = chain.send.gain.value * 0.35;
    if (!this._external && typeof setTimeout === 'function' && until !== undefined) {
      const ms = Math.max(200, (until - this._now() + 0.4) * 1000);
      setTimeout(() => { for (const n of chain.nodes) { try { n.disconnect(); } catch (e) { /* noop */ } } }, ms);
    }
    return chain.g;
  }

  /** Cut every line in flight (mute, match end, teleport). */
  stopVoices() {
    const t = this.ready ? this._now() : 0;
    for (const v of this._voicesLive) {
      try { v.src.stop(t + 0.04); } catch (e) { /* already stopped */ }
    }
    this._voicesLive.length = 0;
    return this;
  }

  /* ========================================================= power-ups === */

  /**
   * A pickup materialising in the world. Positional and quiet on purpose: this
   * fires for every spawn on the map, most of them off screen, so distance
   * attenuation is doing most of the work of deciding whether you hear it.
   */
  powerupSpawn(x, z) {
    if (!this.ready || !this.enabled) return this;
    const t0 = this._now() + 0.004;
    const out = this._pan(x, z, t0 + 1.0);
    // Two soft bells a fifth apart, the second doubled an octave up: the
    // "something appeared" gesture, borrowed from every collectible ever, and
    // deliberately NOT the same interval as levelUp's fanfare.
    const root = semi(31);
    [[0, 0.0, 0.045], [7, 0.075, 0.038], [19, 0.075, 0.016]].forEach(([s, d, amp]) => {
      this._tone(t0 + d, out, {
        f0: root * Math.pow(2, s / 12), dur: 0.42 - d, peak: amp, type: 'sine', attack: 0.006,
      });
    });
    // A breath of shimmer underneath so it reads as an object arriving rather
    // than as a UI beep that happens to be panned.
    this._swoosh(t0, out, { f0: 1800, f1: 5200, dur: 0.34, peak: 0.030, q: 2.4 });
    return this;
  }

  /**
   * Collected. Per-kind identity: Vacuum Boost inhales, Turbo Drain launches,
   * Mass Surge swells. Same three layers each time (gesture, arpeggio, body)
   * so they are recognisably siblings rather than three unrelated sounds.
   */
  powerupPickup(kind) {
    if (!this.ready || !this.enabled) return this;
    const v = POWERUP_VOICE[powerupKey(kind)];
    const t0 = this._now() + 0.004;
    const out = this._pan(null, null, t0 + 1.4);
    const root = semi(v.root);

    // 1. the gesture — down for a suction power-up, up for a speed one.
    if (v.sweep < 0) {
      this._swoosh(t0, out, { f0: 5000, f1: 240, dur: 0.36, peak: 0.115, q: 1.5, rate: 0.9 });
    } else {
      this._swoosh(t0, out, { f0: 300, f1: 6200, dur: 0.30, peak: 0.105, q: 1.7, rate: 1.2 });
    }

    // 2. the arpeggio — the part a player will hum back at you.
    v.arp.forEach((s, i) => {
      const t = t0 + 0.16 + i * 0.055;
      const f = root * Math.pow(2, s / 12);
      this._tone(t, out, { f0: f, dur: 0.34 + i * 0.05, peak: 0.075, type: 'triangle' });
      this._tone(t, out, { f0: f * 2, dur: 0.22, peak: 0.026, type: 'square' });
    });

    // 3. the body. Without it the pickup is all treble and lands nowhere.
    this._tone(t0 + 0.14, out, {
      f0: v.sub * 2.6, f1: v.sub, dur: 0.34, peak: 0.17, type: 'sine', attack: 0.005,
    });
    // Bed only: the pickup should stand out from the music, not from the world.
    this.duck(0.30, 0.55);
    return this;
  }

  /**
   * The continuous body of an active power-up. Idempotent by kind — picking up
   * a second Vacuum Boost extends the timer in the gameplay layer and changes
   * nothing here, which is exactly what "no loop may stack" means.
   *
   * @returns {object} handle: .stop([fade]) .setIntensity(0..1.5) .active
   */
  powerupLoop(kind) {
    const key = powerupKey(kind);
    const v = POWERUP_VOICE[key];
    return this._startLoop(`powerup:${key}`, (fade, t0) => {
      const ctx = this.ctx;
      const sources = [], nodes = [];

      // The swirl: a resonant band walking around the centre frequency. Two
      // modulators at incommensurate rates, because one LFO at 0.4 Hz is a
      // recognisable period and a player hears it as a fault within ten
      // seconds. 0.37 and 0.113 do not line up for over four minutes.
      const src = this._noiseSrc(t0, t0 + LOOP_MAX, v.rate);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = this._hz(v.wind);
      f.Q.value = v.q;
      sources.push(src, this._lfo(t0, 0.37, v.wind * 0.34, f.frequency));
      sources.push(this._lfo(t0, 0.113, v.wind * 0.16, f.frequency, 'triangle'));
      src.connect(f); f.connect(fade);
      nodes.push(f);

      // A body tone so the bed has weight and not just hiss. Amplitude-
      // modulated rather than static: a held sine reads as a fault tone.
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = this._hz(v.sub);
      const og = ctx.createGain();
      og.gain.value = 0.34;
      sources.push(o, this._lfo(t0, key === 'mass' ? 0.9 : 0.23, 0.16, og.gain));
      o.connect(og); og.connect(fade);
      this._src(o, t0, t0 + LOOP_MAX);
      nodes.push(og);

      return {
        // 30 s of continuous sound. Anything that reads as "loud enough" in a
        // two-second audition is fatiguing by second twenty, so this sits under
        // the ambience bed and is meant to be noticed by its absence.
        peak: key === 'turbo' ? 0.075 : 0.105,
        attack: 0.35, release: 0.45,
        dest: this.ambBus, sources, nodes,
      };
    });
  }

  /**
   * Power-down. Also stops the matching loop — the two are one event as far as
   * the gameplay layer is concerned, and making the caller remember both is how
   * a wind bed ends up outliving its boost.
   */
  powerupEnd(kind) {
    const key = powerupKey(kind);
    const live = this._loops.get(`powerup:${key}`);
    if (live) live.stop(0.35);
    if (!this.ready || !this.enabled) return this;
    const v = POWERUP_VOICE[key];
    const t0 = this._now() + 0.004;
    const out = this._pan(null, null, t0 + 1.0);
    const root = semi(v.root);

    // Spin-down: pitch and brightness falling together, which is what "the
    // machine switched off" sounds like in every language.
    this._tone(t0, out, {
      f0: root, f1: root * 0.42, dur: 0.5, peak: 0.075, type: 'triangle', attack: 0.008,
    });
    this._tone(t0, out, {
      f0: root * 1.5, f1: root * 0.63, dur: 0.42, peak: 0.030, type: 'sine', attack: 0.01,
    });
    this._swoosh(t0, out, { f0: 2600, f1: 340, dur: 0.45, peak: 0.055, q: 1.1 });
    // A soft closing thud, so the end is an event and not just a fade.
    this._tone(t0 + 0.34, out, { f0: 96, f1: 44, dur: 0.22, peak: 0.09, type: 'sine' });
    return this;
  }

  /* ============================================================ events === */

  /**
   * "Something is about to happen." Deliberately a public-address chime rather
   * than an alarm: it fires before every event and an alarm three times a match
   * trains players to dread the sound instead of reading it.
   */
  eventWarning() {
    if (!this.ready || !this.enabled) return this;
    const t0 = this._now() + 0.005;
    const out = this._pan(null, null, t0 + 1.8);
    // Rising perfect fourth, 40 ms attack. The slow attack is the difference
    // between "attention please" and a car alarm.
    [[0, 0.0], [5, 0.20]].forEach(([s, d]) => {
      const f = semi(29) * Math.pow(2, s / 12);
      this._tone(t0 + d, out, { f0: f, dur: 0.55, peak: 0.085, type: 'sine', attack: 0.04 });
      this._tone(t0 + d, out, { f0: f * 2, dur: 0.35, peak: 0.028, type: 'triangle', attack: 0.05 });
      this._tone(t0 + d, out, { f0: f * 0.5, dur: 0.6, peak: 0.045, type: 'sine', attack: 0.05 });
    });
    // Long duck: the point of a warning is that you hear what comes after it.
    this.duck(0.40, 1.5);
    return this;
  }

  /**
   * "It is happening NOW" — the banner sting. Bolder than the warning and
   * harmonically unresolved, so it pulls forward instead of closing.
   * @param {string} [kind] optional event id; only shifts the root, so two
   *   different events are distinguishable without needing two sounds.
   */
  eventSting(kind) {
    if (!this.ready || !this.enabled) return this;
    const ctx = this.ctx;
    const t0 = this._now() + 0.005;
    const out = this._pan(null, null, t0 + 2.2);
    // Deterministic per-name offset: same event, same note, every match.
    let h = 0;
    if (kind) for (let i = 0; i < String(kind).length; i++) h = (h * 31 + String(kind).charCodeAt(i)) | 0;
    const root = semi(12 + (Math.abs(h) % 5));

    // Short riser into the hit — 0.28 s, just enough to make the stab land.
    this._swoosh(t0, out, { f0: 400, f1: 4800, dur: 0.28, peak: 0.075, q: 2.6, attack: 0.2 });

    const hit = t0 + 0.28;
    for (const s of [0, 7, 12, 15]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = this._hz(root * Math.pow(2, s / 12));
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 2.5;
      lp.frequency.setValueAtTime(this._hz(4200), hit);
      lp.frequency.exponentialRampToValueAtTime(this._hz(600), hit + 0.7);
      const g = ctx.createGain();
      this._hit(g, hit, 0.055, 0.004, 0.75);
      o.connect(lp); lp.connect(g); g.connect(out);
      this._src(o, hit, hit + 0.85);
    }
    this._tone(hit, out, { f0: 120, f1: 42, dur: 0.5, peak: 0.19, type: 'sine' });
    this._crash(hit, 0.32, out);
    this.duck(0.45, 1.1);
    return this;
  }

  /** The storm rolling in: wind rising, one distant roll, sky closing over. */
  stormStart() {
    if (!this.ready || !this.enabled) return this;
    const t0 = this._now() + 0.005;
    const out = this._pan(null, null, t0 + 3.4);
    // Wind arriving over two seconds. Slow: weather does not have a transient.
    this._swoosh(t0, out, { f0: 240, f1: 900, dur: 1.9, peak: 0.10, q: 1.3, attack: 1.5, rate: 0.5 });
    // A pressure drop under it — the cinematic part, one octave in two seconds.
    this._tone(t0, out, { f0: 132, f1: 46, dur: 1.8, peak: 0.10, type: 'sine', attack: 0.5 });
    this.thunder(0.85);
    this.duck(0.40, 2.2);
    return this;
  }

  /**
   * The storm bed: gusting wind plus a low pressure rumble.
   * Idempotent; `.setIntensity(0..1.5)` follows the event's own intensity curve
   * so the storm can build and abate without restarting anything.
   */
  stormLoop() {
    return this._startLoop('storm', (fade, t0) => {
      const ctx = this.ctx;
      const sources = [], nodes = [];

      // Gusts. The rate pair (0.07 / 0.113 Hz) is chosen to be mutually
      // irrational-ish: their beat period is over four minutes, longer than a
      // Classic match, so the wind never audibly repeats within one round.
      const wn = this._noiseSrc(t0, t0 + LOOP_MAX, 0.45);
      const wf = ctx.createBiquadFilter();
      wf.type = 'bandpass';
      wf.frequency.value = this._hz(320);
      wf.Q.value = 1.5;
      sources.push(wn);
      sources.push(this._lfo(t0, 0.07, 190, wf.frequency, 'triangle'));
      sources.push(this._lfo(t0, 0.113, 95, wf.frequency));
      // Gust amplitude, not just gust colour: real wind changes level, and
      // level is what a player actually perceives as weather.
      const wg = ctx.createGain();
      wg.gain.value = 0.62;
      sources.push(this._lfo(t0, 0.09, 0.36, wg.gain, 'triangle'));
      wn.connect(wf); wf.connect(wg); wg.connect(fade);
      nodes.push(wf, wg);

      // Pressure: everything under 90 Hz, very quiet, felt more than heard.
      const rn = this._noiseSrc(t0, t0 + LOOP_MAX, 0.3);
      const rf = ctx.createBiquadFilter();
      rf.type = 'lowpass';
      rf.frequency.value = this._hz(90);
      rf.Q.value = 0.8;
      const rg = ctx.createGain();
      rg.gain.value = 0.5;
      sources.push(rn);
      rn.connect(rf); rf.connect(rg); rg.connect(fade);
      nodes.push(rf, rg);

      // Storms arrive over seconds, not milliseconds.
      return { peak: 0.155, attack: 2.0, release: 2.5, dest: this.ambBus, sources, nodes };
    });
  }

  /** Storm over: wind falls away, one last far roll, both beds released. */
  stormEnd() {
    const storm = this._loops.get('storm');
    if (storm) storm.stop(2.5);
    const rain = this._loops.get('rain');
    if (rain) rain.stop(3.0);
    if (!this.ready || !this.enabled) return this;
    const t0 = this._now() + 0.005;
    const out = this._pan(null, null, t0 + 2.6);
    this._swoosh(t0, out, { f0: 820, f1: 190, dur: 1.6, peak: 0.065, q: 1.2, attack: 0.35, rate: 0.5 });
    // A far, soft roll to punctuate the end. Not a crack: the storm is leaving.
    this.thunder(0.95);
    return this;
  }

  /**
   * @param {number} distance 0 = overhead crack, 1 = a roll on the horizon.
   *
   * One method, not two, because the whole point is the continuum: the storm
   * event can walk the distance down as it centres on the player and the sound
   * gets closer without ever switching identity.
   */
  thunder(distance = 0.6) {
    if (!this.ready || !this.enabled) return this;
    // Hard rate limit. Thunder is the loudest thing this module makes and two
    // overlapping rolls do not sound like a storm, they sound like distortion.
    if (!this._throttle('thunder', 0.9)) return this;
    const d = clamp(num(distance, 0.6), 0, 1);
    const near = 1 - d;
    const t0 = this._now() + 0.005;
    const dur = 1.1 + d * 2.4;
    // No position: thunder is the whole sky. `_pan(null, null)` also gives the
    // full 0.7 reverb send, which is most of what makes it sound enormous
    // rather than merely loud — and loud is what the mixing rules forbid.
    const out = this._pan(null, null, t0 + dur + 1.2, 0.4);

    // 1. the crack. Only near thunder has one; distance is a low-pass filter.
    if (near > 0.12) {
      this._swoosh(t0, out, {
        f0: 2600 + near * 3000, f1: 380, dur: 0.16 + d * 0.3,
        // 10 ms minimum attack even directly overhead. A 1 ms wideband
        // transient at this level is the jump scare the spec rules out.
        peak: 0.115 * Math.pow(near, 1.3), q: 0.8, type: 'highpass',
        attack: 0.010 + d * 0.05, rate: 1.3,
      });
    }
    // 2. the body, sweeping down and darkening.
    this._swoosh(t0 + 0.02, out, {
      f0: 420 - d * 180, f1: 62, dur: dur * 0.8,
      peak: 0.135 - d * 0.045, q: 0.7, type: 'lowpass',
      attack: 0.04 + d * 0.5, rate: 0.5,
    });
    // 3. the boom you feel.
    this._tone(t0 + 0.01, out, {
      f0: 68 - d * 18, f1: 24, dur: dur * 0.85,
      peak: 0.115 * (1 - d * 0.45), type: 'sine', attack: 0.02 + d * 0.30,
    });
    // 4. the roll — scattered low grains so the tail has events in it.
    this._grains(t0 + 0.2, out, {
      gain: 0.055 + d * 0.03, freq: 150 - d * 55, q: 0.8,
      count: 9 + Math.round(d * 12), dur: dur, spread: 1.5,
    });
    // Push the bed, don't raise the roof: ducking is how this reads as big.
    this.duck(0.30 + near * 0.22, dur * 0.6);
    return this;
  }

  /** Rain bed. Idempotent; intensity follows the storm's own curve. */
  rainLoop() {
    return this._startLoop('rain', (fade, t0) => {
      const ctx = this.ctx;
      const sources = [], nodes = [];

      // Hiss — the individual drops, as a spectrum rather than as events.
      const hn = this._noiseSrc(t0, t0 + LOOP_MAX, 1.25);
      const hf = ctx.createBiquadFilter();
      hf.type = 'highpass';
      hf.frequency.value = this._hz(1100);
      const hg = ctx.createGain();
      hg.gain.value = 0.55;
      sources.push(hn, this._lfo(t0, 0.053, 220, hf.frequency, 'triangle'));
      hn.connect(hf); hf.connect(hg); hg.connect(fade);
      nodes.push(hf, hg);

      // Roar — rain on roads and awnings, the part that says "heavy".
      const rn = this._noiseSrc(t0, t0 + LOOP_MAX, 0.8);
      const rf = ctx.createBiquadFilter();
      rf.type = 'bandpass';
      rf.frequency.value = this._hz(430);
      rf.Q.value = 0.6;
      const rg = ctx.createGain();
      rg.gain.value = 0.42;
      sources.push(rn, this._lfo(t0, 0.081, 0.14, rg.gain));
      rn.connect(rf); rf.connect(rg); rg.connect(fade);
      nodes.push(rf, rg);

      // Rain is the most fatiguing loop in any game. It gets the longest fade
      // and the lowest peak of anything here, and it still reads as rain
      // because it is broadband — level is not what sells it.
      return { peak: 0.095, attack: 2.6, release: 3.0, dest: this.ambBus, sources, nodes };
    });
  }

  /* ============================================================ police === */

  /**
   * A patrol siren. Positional and moving: the handle's `.move(x, z)` should be
   * called from the vehicle's update, which is what turns it from a sound into
   * information about where the response unit actually is.
   *
   * @param {string} kind 'wail' (slow sweep) | 'yelp' (fast) | 'hilo' (two-tone)
   * @param {number} x world position
   * @param {number} z
   * @param {string|number} [id] one siren per id, so a fleet can each have their
   *   own. Defaults to `kind`, which is the right thing for a single unit.
   * @returns {object} handle: .move(x,z) .stop([fade]) .setIntensity(v)
   */
  siren(kind = 'wail', x = 0, z = 0, id) {
    if (!this.ready || !this.enabled) return DEAD_LOOP;
    const k = String(kind || 'wail').toLowerCase();
    const key = `siren:${id === undefined ? k : id}`;
    const live = this._loops.get(key);
    // Idempotent AND useful: the second call repositions the siren already
    // running under this id rather than making a second one.
    if (live && live.active) { live.move(x, z); return live; }
    if (this.loopCount('siren:') >= SIREN_CAP) return DEAD_LOOP;

    return this._startLoop(key, (fade, t0) => {
      const ctx = this.ctx;
      const sources = [], nodes = [];
      const chain = this._liveChain(x, z, 1.1);

      // Sweep shape IS the siren's identity: a slow triangle is an American
      // wail, a fast sawtooth is a yelp, a square is the European two-tone.
      const shape = k === 'yelp' ? { hz: 3.4, type: 'sawtooth', lo: 660, span: 380 }
        : k === 'hilo' ? { hz: 1.35, type: 'square', lo: 620, span: 300 }
          : { hz: 0.28, type: 'triangle', lo: 620, span: 470 };

      const base = shape.lo + shape.span * 0.5;
      const mix = ctx.createGain();
      mix.gain.value = 1;
      // Two oscillators a beat apart. A single square is a test tone; the beat
      // is what makes it read as a horn with a body.
      for (const [type, det, amp] of [['square', 0, 0.5], ['sawtooth', 9, 0.28]]) {
        const o = ctx.createOscillator();
        o.type = type;
        o.detune.value = det;
        o.frequency.value = this._hz(base);
        const og = ctx.createGain();
        og.gain.value = amp;
        o.connect(og); og.connect(mix);
        this._src(o, t0, t0 + LOOP_MAX);
        sources.push(o);
        nodes.push(og);
        sources.push(this._lfo(t0, shape.hz, shape.span * 0.5, o.frequency, shape.type));
      }
      // Roll the top off. A raw square siren is all 5 kHz and it is the single
      // most fatiguing thing you can put in a mix; a real horn is a resonator.
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = this._hz(2400);
      lp.Q.value = 1.1;
      mix.connect(lp); lp.connect(fade);
      nodes.push(mix, lp, ...chain.nodes);

      return {
        // Low, and further attenuated by distance in the chain. Three of these
        // at the cap still sit under one swallow.
        peak: 0.032, attack: 0.25, release: 0.5,
        dest: chain.g, sources, nodes, chain,
      };
    });
  }

  /** Radio squelch + a blip. The "dispatch is talking about you" punctuation. */
  dispatchChirp(x, z) {
    if (!this.ready || !this.enabled) return this;
    if (!this._throttle('chirp', 0.45)) return this;
    const t0 = this._now() + 0.004;
    const out = this._pan(x, z, t0 + 0.5);
    // Band-limited noise burst = the squelch tail of a radio keying up. The
    // narrow band (700–2400 Hz) is the whole trick: it is a telephone filter,
    // and a telephone filter is what makes anything sound like a radio.
    this._swoosh(t0, out, { f0: 2400, f1: 900, dur: 0.075, peak: 0.075, q: 1.1, attack: 0.004 });
    this._tone(t0 + 0.01, out, { f0: 1560, dur: 0.05, peak: 0.045, type: 'square', attack: 0.002 });
    this._tone(t0 + 0.07, out, { f0: 1170, dur: 0.06, peak: 0.038, type: 'square', attack: 0.002 });
    // Squelch off — the little burst of hiss when the key is released.
    this._swoosh(t0 + 0.14, out, { f0: 1800, f1: 2600, dur: 0.05, peak: 0.030, q: 0.8, attack: 0.004 });
    return this;
  }

  /**
   * Heat went up. @param {number} tier 1..3 — brighter, busier and lower as the
   * response escalates, so the tier is audible without reading the HUD.
   */
  heatUp(tier = 1) {
    if (!this.ready || !this.enabled) return this;
    const n = clamp(Math.round(num(tier, 1)), 1, 3);
    const t0 = this._now() + 0.004;
    const out = this._pan(null, null, t0 + 1.4);
    const root = semi(24 + n * 2);
    // Rising minor third, doubled: "up" without being a reward. levelUp() is
    // the major-key sound in this game and Heat must not be mistaken for it.
    [[0, 0.0], [3, 0.09]].forEach(([s, d]) => {
      const f = root * Math.pow(2, s / 12);
      this._tone(t0 + d, out, { f0: f, dur: 0.36, peak: 0.070, type: 'square', attack: 0.006 });
      this._tone(t0 + d, out, { f0: f * 0.5, dur: 0.42, peak: 0.045, type: 'triangle', attack: 0.008 });
    });
    // Tier 2+ gets the alert double-blip, tier 3 a low pulse under it.
    if (n >= 2) {
      [0, 0.13].forEach((d) => {
        this._tone(t0 + 0.30 + d, out, { f0: semi(38), dur: 0.09, peak: 0.048, type: 'square' });
      });
    }
    if (n >= 3) this._tone(t0 + 0.28, out, { f0: 110, f1: 40, dur: 0.6, peak: 0.135, type: 'sine' });
    this.duck(0.20 + n * 0.07, 0.7);
    return this;
  }

  /** Heat cooled off. Quiet, resolving downward — relief, not a reward. */
  heatDown() {
    if (!this.ready || !this.enabled) return this;
    const t0 = this._now() + 0.004;
    const out = this._pan(null, null, t0 + 0.9);
    [[5, 0.0], [0, 0.10]].forEach(([s, d]) => {
      const f = semi(26) * Math.pow(2, s / 12);
      this._tone(t0 + d, out, { f0: f, dur: 0.42, peak: 0.042, type: 'sine', attack: 0.01 });
    });
    this._swoosh(t0, out, { f0: 1400, f1: 500, dur: 0.4, peak: 0.022, q: 1.4 });
    return this;
  }

  /**
   * The arcade containment gadget landing — foam, not a firearm. A wobbled
   * low-pass drop and a soft splat: deliberately cartoon, deliberately
   * non-violent, and short enough that being hit is information, not a punish.
   */
  containmentPulse(x, z) {
    if (!this.ready || !this.enabled) return this;
    if (!this._throttle('containment', 0.22)) return this;
    const ctx = this.ctx;
    const t0 = this._now() + 0.004;
    const out = this._pan(x, z, t0 + 0.9);

    // The wub. A saw through a low-pass whose cutoff is itself modulated at
    // 17 Hz — fast enough to be timbre rather than tremolo, which is the
    // difference between "gadget" and "alarm".
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(this._hz(180), t0);
    o.frequency.exponentialRampToValueAtTime(this._hz(58), t0 + 0.4);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 7;
    lp.frequency.setValueAtTime(this._hz(1600), t0);
    lp.frequency.exponentialRampToValueAtTime(this._hz(220), t0 + 0.42);
    const wob = ctx.createOscillator();
    wob.type = 'sine';
    wob.frequency.value = 17;
    const wobG = ctx.createGain();
    wobG.gain.value = 260;
    wob.connect(wobG); wobG.connect(lp.frequency);
    const g = ctx.createGain();
    this._hit(g, t0, 0.105, 0.008, 0.45);
    o.connect(lp); lp.connect(g); g.connect(out);
    this._src(o, t0, t0 + 0.55);
    this._src(wob, t0, t0 + 0.55);

    // The splat: damp, dull, over in 120 ms. Foam has no ring.
    this._swoosh(t0, out, { f0: 900, f1: 200, dur: 0.13, peak: 0.075, q: 0.6, type: 'lowpass', attack: 0.005 });
    this._grains(t0 + 0.05, out, { gain: 0.035, freq: 700, q: 0.9, count: 5, dur: 0.22, spread: 1.2 });
    return this;
  }

  /* ======================================================== match cues === */

  /**
   * Out-of-bounds countdown. @param {number} n seconds left (3, 2, 1, then 0).
   * Pitch, brightness and density all climb together as n falls; at 0 it turns
   * into a down-hit, because that is the moment the count stopped being a
   * warning and started being a consequence.
   */
  outOfBoundsTick(n = 3) {
    if (!this.ready || !this.enabled) return this;
    const k = clamp(Math.round(num(n, 3)), 0, 6);
    const t0 = this._now() + 0.004;
    const out = this._pan(null, null, t0 + 1.2);

    if (k <= 0) {
      // Time up: a falling tritone and a body hit. Unpleasant on purpose, but
      // still under the level of a collapse — this is a rule, not a disaster.
      this._tone(t0, out, { f0: semi(30), f1: semi(18), dur: 0.5, peak: 0.10, type: 'square' });
      this._tone(t0, out, { f0: 130, f1: 40, dur: 0.55, peak: 0.16, type: 'sine' });
      this._swoosh(t0, out, { f0: 2400, f1: 300, dur: 0.45, peak: 0.06, q: 1.0 });
      this.duck(0.45, 0.8);
      return this;
    }
    // urgency 0 at n=3, 1 at n=1 — three ticks that are audibly a sequence.
    const u = clamp((3 - k) / 2, 0, 1);
    const f = semi(31 + u * 7);
    this._tone(t0, out, { f0: f, dur: 0.13 + u * 0.05, peak: 0.065 + u * 0.045, type: 'square' });
    this._tone(t0, out, { f0: f * 0.5, dur: 0.16, peak: 0.030 + u * 0.03, type: 'triangle' });
    // The final tick doubles: two beeps read as "now", one reads as "soon".
    if (k <= 1) {
      this._tone(t0 + 0.12, out, { f0: f * 1.5, dur: 0.16, peak: 0.075, type: 'square' });
      this.duck(0.30, 0.5);
    }
    return this;
  }

  /** Yanked back in bounds / respawned: sucked out, then reassembled. */
  teleport() {
    if (!this.ready || !this.enabled) return this;
    const t0 = this._now() + 0.004;
    const out = this._pan(null, null, t0 + 1.4);
    // Out: everything collapses to a point.
    this._swoosh(t0, out, { f0: 5200, f1: 180, dur: 0.22, peak: 0.105, q: 2.0, attack: 0.02 });
    this._tone(t0, out, { f0: 420, f1: 60, dur: 0.24, peak: 0.055, type: 'triangle' });
    // 60 ms of nothing. The gap is the teleport; without it this is a whoosh.
    const back = t0 + 0.30;
    this._swoosh(back, out, { f0: 300, f1: 7200, dur: 0.28, peak: 0.085, q: 2.4, attack: 0.02 });
    [0, 7, 12].forEach((s, i) => {
      this._tone(back + 0.12 + i * 0.03, out, {
        f0: semi(36) * Math.pow(2, s / 12), dur: 0.35, peak: 0.040, type: 'sine', attack: 0.004,
      });
    });
    return this;
  }

  /** Points taken. A small disappointment, not a punishment. */
  scorePenalty() {
    if (!this.ready || !this.enabled) return this;
    const t0 = this._now() + 0.004;
    const out = this._pan(null, null, t0 + 0.8);
    // Falling minor second — the most "wrong" interval there is — but quiet,
    // short and low-passed. A player who is already losing points does not
    // also need to be shouted at.
    [[1, 0.0], [0, 0.11]].forEach(([s, d]) => {
      const f = semi(21 + s);
      this._tone(t0 + d, out, { f0: f, dur: 0.30, peak: 0.055, type: 'triangle', attack: 0.006 });
      this._tone(t0 + d, out, { f0: f, dur: 0.26, peak: 0.020, type: 'sawtooth', attack: 0.008, detune: -14 });
    });
    // Deflating tail.
    this._swoosh(t0 + 0.08, out, { f0: 700, f1: 220, dur: 0.34, peak: 0.030, q: 1.6 });
    return this;
  }

  /* ========================================================== physics ==== */

  /**
   * A car losing its footing on the rim: suspension unloading, then metal
   * taking weight it was not designed to take.
   */
  carTip(x, z) {
    if (!this.ready || !this.enabled) return this;
    if (this._slot(this._now(), 0.03, 0.30) < 0) return this;
    const t0 = this._now() + 0.004;
    const out = this._pan(x, z, t0 + 1.3);
    const load = this._load();
    // Suspension: a low tone bending DOWN as the weight transfers.
    this._tone(t0, out, { f0: 96, f1: 52, dur: 0.55, peak: 0.115 * load, type: 'sine', attack: 0.02 });
    // The body groan — two inharmonic partials, which is what "sheet metal"
    // means; a harmonic pair would read as a musical note.
    this._tone(t0 + 0.05, out, { f0: 305, f1: 240, dur: 0.5, peak: 0.045 * load, type: 'triangle' });
    this._tone(t0 + 0.05, out, { f0: 305 * 2.76, f1: 240 * 2.76, dur: 0.35, peak: 0.022 * load, type: 'sine' });
    // Something on the chassis letting go.
    this._grains(t0 + 0.18, out, {
      gain: 0.055 * load, freq: 2600, q: 2.2, count: 6, dur: 0.4, spread: 1.8,
    });
    return this;
  }

  /**
   * Tyres and underbody dragging across kerb and tarmac.
   * @param {number} [speed] 0..1, scales brightness and length.
   */
  carSlide(x, z, speed = 0.5) {
    if (!this.ready || !this.enabled) return this;
    if (!this._throttle('carSlide', 0.13)) return this;
    const s = clamp(num(speed, 0.5), 0, 1);
    const t0 = this._now() + 0.004;
    const dur = 0.22 + s * 0.4;
    const out = this._pan(x, z, t0 + dur + 0.3);
    const load = this._load();
    // A moving formant, not a static band: a scrape whose filter does not move
    // is a hiss, and the movement is the only cue for how fast it is going.
    this._swoosh(t0, out, {
      f0: 900 + s * 1500, f1: 500 + s * 700, dur,
      peak: (0.045 + s * 0.05) * load, q: 4.5, attack: 0.03, rate: 0.9 + s * 0.5,
    });
    // Rubber judder underneath — the low end that stops it sounding like paper.
    this._swoosh(t0, out, {
      f0: 220, f1: 150, dur: dur * 0.9, peak: 0.035 * load, q: 1.2, type: 'lowpass', attack: 0.04,
    });
    return this;
  }

  /**
   * Street furniture going over: a bin, a rack of chairs, a sign.
   * @param {number} [size] 0..1 — lowers the pitch and stretches the tumble.
   */
  clatter(size = 0.4, x, z) {
    if (!this.ready || !this.enabled) return this;
    const now = this._now();
    // One slot for the whole event, not one per tick: the roll is scheduled
    // internally, and taking a slot per impact would eat the swallow grid.
    if (this._slot(now, 0.03, 0.28) < 0) return this;
    const s = clamp(num(size, 0.4), 0, 1);
    const t0 = now + 0.004;
    const dur = 0.35 + s * 0.55;
    const out = this._pan(x, z, t0 + dur + 0.4);
    const load = this._load();
    const n = 4 + Math.round(this._rnd() * 3 + s * 3);
    let t = t0;
    for (let i = 0; i < n; i++) {
      // Decelerating tumble: bounces get closer together and quieter, which is
      // what gravity does and what a uniformly-spaced roll conspicuously fails
      // to do — evenly spaced impacts read as a machine, not an accident.
      const k = i / n;
      const amp = (0.055 + s * 0.03) * Math.pow(1 - k, 1.1) * (0.5 + this._rnd() * 0.7) * load;
      const f = (620 - s * 380) * Math.pow(2, (this._rnd() - 0.5) * 1.2);
      this._tone(t, out, { f0: f, f1: f * 0.72, dur: 0.07 + s * 0.05, peak: amp, type: 'triangle' });
      this._swoosh(t, out, {
        f0: f * 3.4, f1: f * 2.2, dur: 0.045, peak: amp * 0.8, q: 1.6, attack: 0.001,
      });
      t += 0.045 + this._rnd() * (0.10 - k * 0.06) + s * 0.02;
      if (t > t0 + dur) break;
    }
    return this;
  }

  /**
   * Structure under load — the warning a building gives before it goes.
   * @param {number} [size] 0..1 — bigger is lower and slower.
   */
  creak(x, z, size = 0.5) {
    if (!this.ready || !this.enabled) return this;
    if (!this._throttle('creak', 0.4)) return this;
    const ctx = this.ctx;
    const s = clamp(num(size, 0.5), 0, 1);
    const t0 = this._now() + 0.004;
    const dur = 0.7 + s * 0.9;
    const out = this._pan(x, z, t0 + dur + 0.4);
    const load = this._load();

    // A creak is stick-slip: the surface grips, releases, grips again. That is
    // an irregular AMPLITUDE modulation on a resonant tone — modulating pitch
    // instead gives a siren, and modulating nothing gives a hum.
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const f0 = 210 - s * 120;
    o.frequency.setValueAtTime(this._hz(f0), t0);
    o.frequency.linearRampToValueAtTime(this._hz(f0 * (1.18 + s * 0.2)), t0 + dur);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = this._hz(f0 * 3.2);
    bp.Q.value = 9;
    const g = ctx.createGain();
    this._hit(g, t0, 0.06 * load, 0.10, dur);
    // Two modulators, 9.3 and 14.7 Hz, so the stick-slip never falls into a
    // regular buzz — a single-rate tremolo at this depth sounds like a fault.
    const m1 = ctx.createOscillator();
    m1.type = 'sawtooth'; m1.frequency.value = 9.3 + s * 3;
    const m2 = ctx.createOscillator();
    m2.type = 'sine'; m2.frequency.value = 14.7;
    const mg = ctx.createGain();
    mg.gain.value = 0.035 * load;
    m1.connect(mg); m2.connect(mg); mg.connect(g.gain);
    o.connect(bp); bp.connect(g); g.connect(out);
    this._src(o, t0, t0 + dur + 0.1);
    this._src(m1, t0, t0 + dur + 0.1);
    this._src(m2, t0, t0 + dur + 0.1);

    // Dust and grit falling out of the joint.
    this._grains(t0 + dur * 0.4, out, {
      gain: 0.03 * load, freq: 3200, q: 2.4, count: 7, dur: dur * 0.6, spread: 2.0,
    });
    return this;
  }

  /* ------------------------------------------------------ richer UI ----- */

  /** The UI kinds that need more than one oscillator. See `ui()`. */
  _uiRich(kind) {
    const t0 = this._now() + 0.004;
    const out = this._pan(null, null, t0 + 0.7);
    if (kind === 'menuOpen' || kind === 'menuClose') {
      const up = kind === 'menuOpen';
      // A panel sliding: a short filtered sweep plus a soft two-note figure in
      // the direction of travel. Same material both ways, reversed — that is
      // what makes open and close feel like one another's inverse.
      this._swoosh(t0, out, {
        f0: up ? 700 : 2600, f1: up ? 2600 : 700, dur: 0.16, peak: 0.045, q: 1.4, attack: 0.012,
      });
      [0, 1].forEach((i) => {
        const s = up ? [0, 7][i] : [7, 0][i];
        this._tone(t0 + i * 0.045, out, {
          f0: semi(31) * Math.pow(2, s / 12), dur: 0.16, peak: 0.038, type: 'sine',
        });
      });
      return this;
    }
    if (kind === 'confirm') {
      // Rising major third + octave: the shortest "yes" that still has a chord
      // in it. Kept under the levelUp fanfare so the two never compete.
      [[0, 0.0], [4, 0.05], [12, 0.10]].forEach(([s, d]) => {
        this._tone(t0 + d, out, {
          f0: semi(33) * Math.pow(2, s / 12), dur: 0.26 - d, peak: 0.050, type: 'triangle',
        });
      });
      this._swoosh(t0, out, { f0: 2200, f1: 5000, dur: 0.2, peak: 0.022, q: 2.2 });
      return this;
    }
    // error: a low, flat, damped double-thud. No dissonant screech — an error
    // sound that startles gets the volume slider turned down, and then nothing
    // else in the game is audible either.
    [0, 0.11].forEach((d) => {
      this._tone(t0 + d, out, { f0: semi(13), dur: 0.20, peak: 0.055, type: 'square', attack: 0.005 });
      this._tone(t0 + d, out, { f0: semi(13) * 0.5, dur: 0.24, peak: 0.045, type: 'sine', attack: 0.006 });
    });
    return this;
  }

  /* ======================================================= diagnostics == */

  /** Everything a test or a dev overlay needs to judge the graph's health. */
  debugStats() {
    if (this.ctx) this._sweepPans();
    return {
      ready: this.ready,
      liveSources: this._live.size,
      created: this.stats.created,
      stopped: this.stats.stopped,
      panChains: this._panBusy.length + this._panFree.length,
      panBusy: this._panBusy.length,
      peakVoices: this.stats.peakVoices,
      folded: this.stats.folded,
      notes: this.stats.notes,
      section: this._mus ? this._mus.section : null,
      volume: this._volume,
      muted: this._muted,
      musicVolume: this._musicVol,
      sfxVolume: this._sfxVol,
      voiceVolume: this._voiceVol,
      voicesMuted: this._voicesMuted,
      // The loop registry is the thing a restart test asserts on: after a
      // match ends this must be 0 and `loops` must be empty.
      liveLoops: this._loops.size,
      loops: Array.from(this._loops.keys()),
      loopsStarted: this.stats.loopsStarted,
      loopsStopped: this.stats.loopsStopped,
      loopsDropped: this.stats.loopsDropped,
      liveVoices: this._voicesLive.length,
      voicesPlayed: this.stats.voicesPlayed,
      voicesDropped: this.stats.voicesDropped,
      throttled: this.stats.throttled,
      bedDuck: this.bedDuck ? this.bedDuck.gain.value : 1,
      dialogDuck: this.dialogDuck ? this.dialogDuck.gain.value : 1,
    };
  }

  /** Tear the whole graph down (used by tests; harmless in the game). */
  dispose() {
    this.stopMusic();
    // stopMusic() already fades the loops out; dispose is not a graceful
    // ending, so take them down immediately and drop the registry with them.
    this.stopAllLoops(0.02);
    this.stopVoices();
    for (const n of [this._rumbleSrc, this._subOsc, this._subLfo, this._windSrc, this._windLfo]) {
      if (n) { try { n.stop(); } catch (e) { /* already stopped */ } }
    }
    this._rumble = null;
    for (const n of this._live) { try { n.stop(); } catch (e) { /* noop */ } }
    this._live.clear();
    if (this.ctx && this.ctx.close && !this._external) this.ctx.close();
    this.ready = false;
    return this;
  }
}

export const audio = new Audio();

// Handle for the dev harness, the automated audio tests and the browser
// console — the project already publishes window.DEV for exactly this reason.
// Nothing in the game reads it; it exists so a test can reach the *same*
// singleton game.js imported (a second `import()` can hand back a different
// module instance once Vite has hot-invalidated the file).
if (typeof window !== 'undefined') window.__audio = audio;
