/**
 * MIAMI DEVOUR — THE IN-GAME PHONE. CALL ENGINE.
 *
 * ###########################################################################
 * # WHAT THIS FILE IS                                                       #
 * #                                                                         #
 * # The decision layer for the phone: WHO calls, WHEN, WITH WHICH LINE, and #
 * # HOW OFTEN. It owns no DOM, builds no UI, imports no renderer and reads  #
 * # no input. The phone UI subscribes to `onCall` / `onText` / `onCaption`  #
 * # and draws whatever it likes; the content lives in a callers module that #
 * # is INJECTED, so a second map ships its own cast without editing a line  #
 * # of this file.                                                           #
 * #                                                                         #
 * # It is also the enforcement point for the content policy. `validateLines`#
 * # runs over the whole injected library and THROWS on any violation, and   #
 * # `setLibrary()` calls it — a library that trips the denylist is REJECTED #
 * # WHOLESALE rather than partially loaded, because a half-loaded corpus is #
 * # how a banned line ends up being the only one left eligible.             #
 * ###########################################################################
 *
 * ---------------------------------------------------------------------------
 * NON-BLOCKING IS A HARD REQUIREMENT
 *
 * A call must never pause, slow, or capture input from gameplay. Concretely,
 * and these are the things this module is FORBIDDEN to do:
 *   - no `addEventListener` on window/document, ever (input.js owns the keys)
 *   - no pointer lock, no modal, no focus stealing
 *   - no writing to `game.paused`, `match.phase`, or any dt
 *   - no work proportional to the world; `update()` is O(1) plus one point-in-
 *     rect test and one small array scan when a moment actually fires
 * The wrapper `install()` puts around `stepSimulation` runs AFTER the real
 * step and swallows its own exceptions, so a bug in here costs the phone and
 * nothing else. Three consecutive throws and it disarms permanently — the
 * pattern eventGlue.js already uses (eventGlue.js:406).
 *
 * ---------------------------------------------------------------------------
 * AUDIO: THE ELEMENT PATH, AND ONLY THE ELEMENT PATH
 *
 * Voice playback through the WebAudio graph is SILENT in this project. Five
 * fixes were made against that graph and every one of them was wrong; what
 * settled it was a human ear hearing the same mp3 through `new Audio(url)` in
 * the same tab at the same moment. `VoiceSystem._startEl` (voice.js:1149) is
 * the proven path and `_startEl()` below is a deliberate mirror of it —
 * same construction, same finite-number guards on the volume product, same
 * `ended` / `error` / `loadedmetadata` handling, same retire-on-failure.
 *
 * DO NOT build an AudioContext chain in here. There is not one node in this
 * file, and that is the point.
 *
 * The NaN lesson is mirrored too: `0.9 * undefined = NaN`, and an element with
 * `volume = NaN` throws in some engines and plays at an arbitrary level in
 * others. Every factor is checked with Number.isFinite before it is used and
 * the product is re-checked afterwards, because one undefined anywhere in a
 * product poisons the whole thing (voice.js:1202).
 *
 * ---------------------------------------------------------------------------
 * THE LIBRARY CONTRACT (what a callers module must export)
 *
 * Nothing here is guessed. The adapter accepts several spellings because the
 * callers module is another agent's file, but the SHAPE it wants is:
 *
 *   CALLERS  [{ id, name, role, color, blurb?, cooldown? }]
 *   LINES    { triggerName: [line, ...] }              // or { trig: { callerId: [...] } }
 *   line     { id, caller, text, trigger, kind, mature, weight?, cooldown?, seconds? }
 *
 *   kind     'call' | 'text'      (default 'call')
 *   mature   boolean              (default false — DEFAULT OFF, see below)
 *   weight   number > 0           (default 1)
 *   cooldown seconds >= 0         (default PHONE_TUNING.LINE_COOLDOWN)
 *
 * `id` is an ASSET FILENAME. It is immutable, [a-z0-9-] only, and unique
 * case-insensitively — the same rule voicelines.js documents at length,
 * for the same reason: macOS collapses two ids that differ only in case into
 * one generated file and the second line silently plays the first one's voice.
 *
 * ---------------------------------------------------------------------------
 * CONTENT POLICY — ENFORCED, NOT DESCRIBED
 *
 *  1. MATURE DIALOGUE IS DEFAULT OFF. `getMature()` defaults to false. When it
 *     is off, mature lines are removed from the candidate set BEFORE the
 *     weighted pick. They are not filtered at render time; they are never
 *     SELECTED. `__selftest` draws 500 times with the setting off and fails if
 *     a single mature line comes back.
 *  2. WHEN ON, STRONGER LINES ARE RARE AND REACTIVE. Three independent gates:
 *     the trigger must be flagged `big`, a per-match budget of
 *     MATURE_MAX_PER_MATCH applies, and a MATURE_GAP cooldown sits on top of
 *     the ordinary call cooldowns. Even then it is a MATURE_CHANCE roll.
 *  3. FORBIDDEN AT ANY SETTING, as a hard filter with a test: slurs, hate
 *     speech, harassment of protected groups, sexual content, threats, and
 *     impersonation of any real person, company, department or brand. See
 *     DENYLIST and validateLines().
 *  4. EVERY CALLER IS AN ORIGINAL FICTIONAL CHARACTER. A line whose `caller`
 *     is not in the module's own roster is a validation error, and the roster
 *     itself is checked against the real-entity patterns.
 *
 * ---------------------------------------------------------------------------
 * RUNNING THE TESTS (no test runner is installed in this repo)
 *
 *   node -e "import('./src/phone/phone.js').then(m=>{const r=m.__selftest();
 *     console.log(r.failed?'FAIL':'ok', r.passed+'/'+r.total);
 *     for(const x of r.results) if(!x.pass) console.log(' -', x.name, x.detail);
 *     process.exit(r.failed?1:0);})"
 *
 * It imports only ../config.js, which imports nothing, so it runs in plain
 * Node with no DOM and no three.js.
 */

import { TIER, TIER_LIST } from '../config.js';

/* ========================================================================== */
/* SMALL UTILITIES                                                            */
/* ========================================================================== */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** FNV-1a. Used for deterministic seeding only, never for security. */
function hash32(s) {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * mulberry32's step, made PURE.
 *
 * The stream has to be reproducible from `serialize()`, and an opaque rng
 * closure cannot be rewound. Keeping the state as a plain integer cursor means
 * applyState() restores the exact next draw — which is the whole point of
 * shipping serialize() for multiplayer parity.
 */
function pureRandom(seed, i) {
  let t = (((seed >>> 0) + Math.imul((i | 0) + 1, 0x6d2b79f5)) | 0);
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** hud.pushFeed() assigns innerHTML. Anything this module hands it is escaped. */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** base64 -> utf8, in both a browser and Node, without importing anything. */
function fromBase64(b64) {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  /* eslint-disable-next-line no-undef */
  if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64').toString('utf8');
  throw new Error('[phone] no base64 decoder available');
}

const isFn = (f) => typeof f === 'function';
const num = (v, d) => (Number.isFinite(v) ? v : d);

/* ========================================================================== */
/* CONSTANTS THE UI AND THE TESTS SHARE                                       */
/* ========================================================================== */

/** Lifecycle of a single call. `active()` returns one only in RINGING/CONNECTED. */
export const CALL_STATE = Object.freeze({
  RINGING: 'ringing',
  CONNECTED: 'connected',
  ANSWERED: 'answered',     // terminal: ran to the end
  MISSED: 'missed',         // terminal: rang out
  DECLINED: 'declined',     // terminal: player dismissed it
  HUNGUP: 'hungup',         // terminal: player ended it early
  CLEARED: 'cleared',       // terminal: match ended / clearAll()
});

/** Terminal states, i.e. "this is history now". */
const TERMINAL = new Set([
  CALL_STATE.ANSWERED, CALL_STATE.MISSED, CALL_STATE.DECLINED,
  CALL_STATE.HUNGUP, CALL_STATE.CLEARED,
]);

export const KIND = Object.freeze({ CALL: 'call', TEXT: 'text' });

/**
 * match.js PHASE values, VERIFIED at gameplay/match.js:16-22.
 *
 * Deliberately NOT imported: match.js pulls in hole.js which pulls in three.js,
 * and this module must stay runnable in plain Node for its own tests. The cost
 * of a literal is that a rename over there would go unnoticed — so anything
 * that is not one of these five increments `stats().phaseUnknown` and logs
 * ONCE, naming the value. A silent miss is what this codebase keeps shipping;
 * a loud one is affordable.
 */
const PHASE_LIVE = new Set(['playing', 'countdown']);
const PHASE_KNOWN = new Set(['loading', 'menu', 'countdown', 'playing', 'results']);

/**
 * EVERY NUMBER, WITH ITS REASON.
 *
 * The frame of reference throughout is MATCH.DURATION = 150 s (config.js:190).
 * Rate limiting is the difference between charming and unbearable, so these
 * are deliberately mean. Exported so a tuner and the tests read the same
 * values — a magic number duplicated in a test is a test that proves nothing.
 */
export const PHONE_TUNING = Object.freeze({
  /** Unanswered after this, the call becomes a MISSED CALL. Politely, no penalty. */
  RING_SECONDS: 9,

  /** Beat between answering and the line starting, so the UI can animate. */
  CONNECT_LEAD: 0.35,

  /** Caption-only floor. A three-word text still needs long enough to read. */
  CALL_MIN_SECONDS: 3.2,

  /**
   * Hard ceiling on a connected call. An element whose `ended` never fires —
   * a suspended context on a tab switch — would otherwise hold the ONE call
   * slot for the rest of the match. voice.js calls this the zombie slot
   * (voice.js:1307) and it is invisible and permanent without a backstop.
   */
  CALL_MAX_SECONDS: 16,

  /**
   * Seconds between the START of one call and the start of the next.
   * 150 s match / 40 s = at most 3 windows, which is where MAX_CALLS_PER_MATCH
   * comes from. Wall-clock, not per-caller: this is the rule that stops the
   * phone being a radio station.
   */
  GLOBAL_CALL_GAP: 40,

  /** Extra quiet after a call ENDS, so a long call is not chased by another. */
  POST_CALL_QUIET: 10,

  /** The same character cannot call again for half a match. */
  CALLER_COOLDOWN: 75,

  /** Three calls in 150 s. Answered, missed and declined all count. */
  MAX_CALLS_PER_MATCH: 3,

  /**
   * No call of any kind before this. COUNTDOWN is 3.2 s and the hole starts at
   * radius 2.0 — the player is still working out which way is up.
   */
  WARMUP: 18,

  /**
   * The "nobody calls about a bench" rule, in two parts.
   * AMBIENT_MIN_RADIUS is TIER.LARGE.eatRadius (5.2, config.js:242) — the size
   * at which the player is eating CARS. Below it, low-value triggers are
   * dropped outright rather than queued.
   */
  AMBIENT_MIN_RADIUS: TIER.LARGE.eatRadius,
  AMBIENT_WARMUP: 35,

  /** Texts are cheap, so they are allowed to be more frequent than calls. */
  TEXT_GAP: 22,
  TEXT_CALLER_COOLDOWN: 45,
  MAX_TEXTS_PER_MATCH: 6,
  TEXT_WARMUP: 8,

  /** A specific line id cannot repeat inside this window (longer than a match). */
  LINE_COOLDOWN: 240,

  /** Default per-trigger cooldown when the TRIGGERS table does not set one. */
  TRIGGER_COOLDOWN: 45,

  /* --- mature dialogue: three gates and a dice roll --------------------- */
  /** Per match, when the setting is ON. Two, so it stays an event. */
  MATURE_MAX_PER_MATCH: 2,
  /** And never twice inside this window, even across two big moments. */
  MATURE_GAP: 70,
  /** Even on an eligible big moment it is only a chance, so it is not a tell. */
  MATURE_CHANCE: 0.35,

  /** Rows kept for the phone's Calls/Messages tabs. */
  HISTORY_MAX: 24,

  /**
   * A moment that could not fire immediately waits this long for the line to
   * clear, then is dropped. Longer and the phone reacts to something the
   * player has forgotten about, which reads as a bug.
   */
  TRIGGER_TTL: 2.5,
  /** Pending moments held at once. Small on purpose. */
  QUEUE_MAX: 4,

  /**
   * Element trim, mirroring VOICE_EL_TRIM (voice.js:104). An element bypasses
   * voiceBus (0.62) and the master gain (0.85): 0.62 * 0.85 = 0.527, rounded
   * up for presence. Without it the phone arrives twice as loud as the city.
   */
  EL_TRIM: 0.55,

  /** How far outside a storm marker still counts as "near". */
  STORM_NEAR_PAD: 140,

  /** Inset on layout.zoo before "inside" counts, so the fence line is not a switch. */
  ZOO_INSET: 4,
});

/**
 * THE MOMENTS.
 *
 * `big`     may carry a mature line, and is exempt from the ambient gates.
 * `ambient` low value: gated behind AMBIENT_MIN_RADIUS and AMBIENT_WARMUP.
 * `prefer`  what this moment wants to be. If a call is impossible but a text
 *           is allowed, the moment DOWNGRADES rather than being lost — which
 *           is how a big moment during another call still reaches the player.
 * `priority` only ever used to order two moments queued in the same frame.
 */
export const TRIGGERS = Object.freeze({
  'grew-large':   Object.freeze({ big: false, ambient: false, cooldown: 30,  priority: 2, prefer: KIND.CALL }),
  'ate-car':      Object.freeze({ big: false, ambient: true,  cooldown: 45,  priority: 1, prefer: KIND.TEXT }),
  'ate-building': Object.freeze({ big: true,  ambient: false, cooldown: 40,  priority: 3, prefer: KIND.CALL }),
  'heat-up':      Object.freeze({ big: true,  ambient: false, cooldown: 35,  priority: 3, prefer: KIND.CALL }),
  'entered-zoo':  Object.freeze({ big: false, ambient: false, cooldown: 120, priority: 2, prefer: KIND.CALL }),
  'powerup':      Object.freeze({ big: false, ambient: true,  cooldown: 40,  priority: 1, prefer: KIND.TEXT }),
  'storm-near':   Object.freeze({ big: true,  ambient: false, cooldown: 90,  priority: 3, prefer: KIND.CALL }),
  'high-score':   Object.freeze({ big: true,  ambient: false, cooldown: 60,  priority: 3, prefer: KIND.CALL }),
});

const DEFAULT_TRIGGER = Object.freeze({
  big: false, ambient: true, cooldown: PHONE_TUNING.TRIGGER_COOLDOWN,
  priority: 1, prefer: KIND.CALL,
});

/** Radii at which "you got big" is worth a phone call. TIER_LIST, LARGE upward. */
const GROWTH_THRESHOLDS = Object.freeze(
  TIER_LIST.filter((t) => t.eatRadius >= TIER.LARGE.eatRadius).map((t) => t.eatRadius)
);

/* ========================================================================== */
/* CONTENT POLICY                                                             */
/* ========================================================================== */

/** Thrown by validateLines(). Carries the full error list, not just the first. */
export class PhoneContentError extends Error {
  constructor(errors, stats) {
    const list = Array.isArray(errors) ? errors : [String(errors)];
    super(`[phone] content policy: ${list.length} violation(s)\n  - ${list.slice(0, 12).join('\n  - ')}`);
    this.name = 'PhoneContentError';
    this.errors = list;
    this.stats = stats || null;
  }
}

/** Filename-safe slug, same rule as voicelines.js:104. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX = 48;

/** Windows will not create these basenames, extension or not. */
const RESERVED_BASENAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** A phone call is a held moment, so it may run longer than an NPC shout (12). */
export const MAX_WORDS = 22;
export const MAX_CHARS = 140;

/**
 * SLUR SEEDS, BASE64-ENCODED.
 *
 * WHY ENCODED. This is a blocklist, so it has to contain the things it blocks;
 * that is not optional. What IS optional is having them sit in the repository
 * as plain greppable text, where a search, a screenshot, a code review or a
 * copy-paste into another file surfaces them for no benefit. They are decoded
 * at module load into regexes, so the filter is exactly as strong either way.
 *
 * Each seed decodes to `{ s, l }`:
 *   s  a regex fragment with leet-tolerant character classes (0/o, 1/i, 3/e,
 *      4/a, @, !, |), no inflection — INFLECT below supplies that.
 *   l  long and unambiguous enough to also be tested against the
 *      separator-stripped form of the text, which is what catches n_i_g_g_e_r.
 *
 * TO AUDIT: `DENYLIST.filter(d => d.category === 'slur').map(d => d.re.source)`.
 * TO EXTEND: decode, add, re-encode. Do NOT add a plain-text entry beside it —
 * half a list in the clear defeats the reason the other half is encoded.
 */
const SLUR_SEEDS_B64 =
  'W3sicyI6Im5baTEhfF1bZ3E2OV17Mix9W2UzYUBdcj8iLCJsIjp0cnVlfSx7InMiOiJuW2kxIXxdW2dxNjld' +
  'ezIsfVthQF1oIiwibCI6dHJ1ZX0seyJzIjoiZlthQDRdZ2c/W28wXXQ/IiwibCI6dHJ1ZX0seyJzIjoia1tp' +
  'MSF8XWtbZTNdIiwibCI6ZmFsc2V9LHsicyI6InNwW2kxIXxdW2NrXSIsImwiOmZhbHNlfSx7InMiOiJjaFtp' +
  'MSF8XW5rIiwibCI6ZmFsc2V9LHsicyI6ImdbbzBdW28wXWsiLCJsIjpmYWxzZX0seyJzIjoid1tlM110Ylth' +
  'QDRdY2siLCJsIjp0cnVlfSx7InMiOiJ0clthQDRdbm4/W3lpZTNdKyIsImwiOnRydWV9LHsicyI6InJbZTNd' +
  'dFthQDRdcmQiLCJsIjp0cnVlfSx7InMiOiJjW28wXVtvMF1uIiwibCI6ZmFsc2V9LHsicyI6InBbYUA0XWtb' +
  'aTEhfF0iLCJsIjpmYWxzZX0seyJzIjoiclthQDRdZ2hbZTNdW2FANF1kIiwibCI6dHJ1ZX0seyJzIjoiYlt' +
  'lM11bYUA0XW5bZTNdciIsImwiOmZhbHNlfSx7InMiOiJqW2kxIXxdZ2c/W2FANF1iW28wXXsxLDJ9IiwibCI6' +
  'dHJ1ZX0seyJzIjoic2hbZTNdbVthQDRdbFtlM10iLCJsIjp0cnVlfSx7InMiOiJ6W2kxIXxdcHA/W2UzXXJo' +
  'W2UzXVthQDRdZCIsImwiOnRydWV9LHsicyI6ImhbYUA0XWxmYnJbZTNdezEsMn1kIiwibCI6dHJ1ZX1d';

/** Shared inflection tail, so a seed covers -s/-es/-ed/-ing without repeating itself. */
const INFLECT = '(?:e?s|e?d|ing|z|a|ah)?';

/**
 * Neutral group nouns. These are NOT slurs and are not blocked on their own —
 * blocking "women" or "muslim" would be absurd. They only matter in the
 * co-occurrence patterns below, where a group noun sits next to hostility.
 */
const PROTECTED_NOUN =
  '(?:jew|jews|jewish|muslim|muslims|islamic|christian|christians|hindu|hindus|sikh|sikhs|' +
  'arab|arabs|asian|asians|african|africans|black|blacks|white|whites|latino|latinos|latina|' +
  'latinas|hispanic|hispanics|mexican|mexicans|chinese|indian|indians|immigrant|immigrants|' +
  'refugee|refugees|migrant|migrants|gay|gays|lesbian|lesbians|bisexual|trans|transgender|' +
  'queer|women|woman|girls|men|man|disabled|autistic|deaf|blind|jews)';

const HOSTILE_VERB =
  '(?:kill|killing|gas|gassing|hang|hanging|lynch|lynching|exterminate|exterminating|' +
  'eradicate|purge|purging|cleanse|cleansing|deport|deporting|burn|burning|shoot|shooting|' +
  'rape|raping|drown|drowning|round up|get rid of|wipe out)';

const DEHUMANISING =
  '(?:vermin|scum|subhuman|sub-human|animals|filth|parasites|parasite|inferior|degenerate|' +
  'disgusting|worthless|cockroaches|plague|infestation|not human|should not exist|' +
  'deserve to die|do not belong here)';

/**
 * Real agencies, forces, emergency numbers and brands.
 *
 * FINITE BY DESIGN and therefore incomplete — see the honesty note in
 * validateLines(). It covers the things a writer actually reaches for in a
 * Miami crime-adjacent game. Deliberately EXCLUDED are brand names that are
 * also ordinary English (apple, amazon, target, coke, shell, subway, orange):
 * a false positive on "an apple" trains authors to route around the filter,
 * which is worse than the gap.
 */
const REAL_ENTITY_SRC =
  '\\b(?:fbi|cia|dea|atf|nsa|ice|interpol|nypd|lapd|mdpd|scotland yard|met police|rcmp|' +
  'police department|sheriff(?:\'|’)?s? office|highway patrol|state troopers?|' +
  'coast guard|national guard|homeland security|secret service|swat team|' +
  'miami(?:[- ]dade)? police|miami beach police|metro dade|' +
  'rockstar games|grand theft auto|nintendo|playstation|xbox|netflix|youtube|tiktok|' +
  'instagram|facebook|twitter|snapchat|whatsapp|reddit|twitch|spotify|' +
  'uber|lyft|airbnb|doordash|mcdonald(?:\'|’)?s|burger king|wendy(?:\'|’)?s|' +
  'starbucks|coca[- ]cola|pepsi|red bull|heineken|budweiser|corona extra|' +
  'tesla|ferrari|lamborghini|porsche|toyota|honda|chevrolet|cadillac|bmw|mercedes|' +
  'google|microsoft|disney|marvel|walmart|costco|ikea|nike|adidas|gucci|rolex|ryanair)\\b';

/* --- profanity tiers ------------------------------------------------------
 * MILD is the DEFAULT-ON register. It is allowed on an unflagged line, because
 * "when OFF, only mild lines are eligible" means mild lines exist and play.
 * STRONG is what `mature: true` is FOR. A strong line that is not flagged is a
 * validation error: it would be eligible with the setting off, which would
 * make the default a lie. That is the check that keeps the toggle honest. */
const STRONG_LANG = new RegExp(
  '\\b(?:f+u+c+k\\w*|motherf\\w+|sh[i1]t+\\w*|bullsh[i1]t\\w*|b[i1]tch\\w*|bastard\\w*|' +
  'assholes?|arseholes?|dickheads?|dicks|pricks?|twats?|wankers?|bollocks|buggers?|' +
  'pissed|pissing|goddamn\\w*|jackass\\w*|douche\\w*|son of a b[i1]tch|screw you)\\b', 'i');

const MILD_LANG = /\b(?:damn|damned|hell|crap|ass|arse|sucks|sucked|screwed|freaking|frickin\w*|heck|blimey|shoot)\b/i;

/** Sexual content. Non-explicit vocabulary, but this is a family-default game. */
const SEXUAL_SRC =
  '\\b(?:sexy|sexual|sexually|porn|pornography|nudes?|naked|horny|orgasm\\w*|' +
  'masturbat\\w+|blow ?job|hand ?job|genitals?|penis|vagina|boobs|tits|titties|' +
  'erotic|fetish|strip club|stripper|hookers?|prostitutes?|escort service|onlyfans|' +
  'sleep with me|get laid)\\b';

/** Threats. Directed violence, and attacks on real-world targets. */
const THREAT_SRCS = [
  '\\b(?:i|we)\\s*(?:’|\')?(?:ll|m|re)?\\s*(?:will\\s+)?(?:kill|murder|shoot|stab|behead|burn|bomb|hurt|beat|gut)\\b[^.]{0,24}\\byou\\b',
  '\\b(?:kill|murder|shoot|stab|behead|bomb|strangle)\\s+(?:you|him|her|them|your family|your kids)\\b',
  '\\b(?:shoot up|blow up|bomb)\\s+(?:the\\s+|a\\s+)?(?:school|mall|church|mosque|synagogue|hospital|station|airport)\\b',
  '\\bdeath threats?\\b',
  '\\bi know where you live\\b',
];

/** Real-person impersonation, structurally: a real office plus a proper name. */
const REAL_TITLE_SRC =
  '\\b(?:president|vice president|senator|governor|congress(?:man|woman)|prime minister|' +
  'chancellor|pope|the king|the queen|police chief|chief of police|district attorney)\\s+' +
  '[A-Z][a-z]{2,}';

/** "in the style of <somebody>", the exact thing voicelines.js exists to stop. */
const STYLE_OF_SRC = '\\b(?:in the style of|sounds (?:just )?like|impersonat\\w+|voiced by)\\b';

/**
 * THE DENYLIST.
 *
 * Built once at module load. `field` says where the pattern is checked:
 * 'text' = line text only, 'any' = line text AND every human-readable caller
 * field (name, role, blurb, voiceDirection). A slur in a character's BLURB is
 * exactly as shippable as one in a line, which is to say not at all.
 */
function buildDenylist() {
  const out = [];
  const push = (id, category, why, re, field = 'text', norm = 'plain') =>
    out.push({ id, category, why, re, field, norm });

  /* --- 1. slurs, from the encoded seeds ------------------------------- */
  let seeds = [];
  try {
    seeds = JSON.parse(fromBase64(SLUR_SEEDS_B64));
  } catch (err) {
    /* A corrupted blob must NOT quietly produce an empty denylist — that is a
       policy that silently stops existing. Fail loudly and keep a poison
       pattern in place so nothing validates until it is fixed. */
    if (typeof console !== 'undefined' && console.error) {
      console.error('[phone] slur seed blob failed to decode; denylist is in FAIL-CLOSED mode', err);
    }
    push('slur-decode-failed', 'slur', 'slur denylist could not be built', /[\s\S]/, 'any');
    return out;
  }
  for (let i = 0; i < seeds.length; i++) {
    const s = seeds[i];
    if (!s || typeof s.s !== 'string') continue;
    push(`slur-${i}`, 'slur', 'slur or hate term', new RegExp(`\\b(?:${s.s})${INFLECT}\\b`, 'i'), 'any');
    if (s.l) {
      /* Separator-stripped pass. Only the long/unambiguous seeds, because on a
         string with no spaces a short stem collides with ordinary words. */
      push(`slur-sq-${i}`, 'slur', 'slur with separators removed',
        new RegExp(`(?:${s.s})${INFLECT}`, 'i'), 'any', 'squash');
    }
  }

  /* --- 2. hate speech / harassment of protected groups ----------------- */
  push('hate-verb-group', 'hate', 'violence urged against a protected group',
    new RegExp(`\\b${HOSTILE_VERB}\\b[^.!?]{0,28}\\b${PROTECTED_NOUN}\\b`, 'i'), 'any');
  push('hate-group-verb', 'hate', 'violence urged against a protected group',
    new RegExp(`\\b${PROTECTED_NOUN}\\b[^.!?]{0,20}\\bshould be\\b[^.!?]{0,20}\\b${HOSTILE_VERB}`, 'i'), 'any');
  push('hate-dehumanise', 'hate', 'protected group described as less than human',
    new RegExp(`\\b${PROTECTED_NOUN}\\b[^.!?]{0,24}\\b(?:are|is|were)\\b[^.!?]{0,24}\\b${DEHUMANISING}\\b`, 'i'), 'any');
  push('hate-goback', 'hate', 'harassment of a protected group',
    /\bgo back to (?:your|their) (?:own )?(?:country|countries)\b/i, 'any');
  push('hate-slogan', 'hate', 'organised hate slogan or symbol',
    /\b(?:heil hitler|white power|sieg heil|1488|14 words|gas chamber joke)\b/i, 'any');

  /* --- 3. sexual content ---------------------------------------------- */
  push('sexual', 'sexual', 'sexual content', new RegExp(SEXUAL_SRC, 'i'), 'any');

  /* --- 4. threats ------------------------------------------------------ */
  for (let i = 0; i < THREAT_SRCS.length; i++) {
    push(`threat-${i}`, 'threat', 'threat of violence', new RegExp(THREAT_SRCS[i], 'i'), 'any');
  }

  /* --- 5. impersonation ------------------------------------------------ */
  push('real-entity', 'impersonation', 'real agency, department or brand',
    new RegExp(REAL_ENTITY_SRC, 'i'), 'any');
  push('real-emergency', 'impersonation', 'real emergency number',
    /(?:^|[^\d])(?:911|999|112|101)(?:[^\d]|$)/, 'text');
  push('real-title', 'impersonation', 'real public office plus a proper name',
    new RegExp(REAL_TITLE_SRC), 'any');
  push('style-of', 'impersonation', 'written to sound like a real person',
    new RegExp(STYLE_OF_SRC, 'i'), 'any');
  push('handle-or-url', 'impersonation', 'social handle or link',
    /(?:https?:\/\/|www\.[a-z]|@[a-z0-9_]{2,})/i, 'any');

  /* --- 6. hazards ------------------------------------------------------ */
  push('markup', 'hazard', 'markup character (hud.pushFeed assigns innerHTML)', /[<>&"]/, 'text');
  push('control-char', 'hazard', 'control character', /[\u0000-\u001f\u007f]/, 'any');

  return out;
}

/** Frozen at load. Order is stable so error messages are reproducible. */
export const DENYLIST = Object.freeze(buildDenylist());

/** Lowercased, punctuation-to-space. Keeps word boundaries intact. */
function normPlain(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
}
/** Everything non-alphanumeric removed. Defeats n.i.g.g.e.r and n-i-g-g-e-r. */
function normSquash(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Run the denylist over one string.
 * @returns {null|{id,category,why}} the FIRST rule it trips, or null.
 */
export function screenText(text, field = 'text') {
  const raw = String(text == null ? '' : text);
  if (!raw) return null;
  const plain = normPlain(raw);
  const squash = normSquash(raw);
  for (const d of DENYLIST) {
    if (d.field === 'text' && field !== 'text') continue;
    const subject = d.norm === 'squash' ? squash : raw;
    if (d.re.test(subject)) return { id: d.id, category: d.category, why: d.why };
    /* Second look at the normalised form for the plain rules: "f-u-c-k" and
       "s.h.i.t" survive the raw pass but not this one. Skipped for the hazard
       rules, whose whole subject is the raw characters. */
    if (d.norm === 'plain' && d.category !== 'hazard' && d.re.test(plain)) {
      return { id: d.id, category: d.category, why: d.why };
    }
  }
  return null;
}

const wordCount = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;

/* ========================================================================== */
/* LIBRARY ADAPTER                                                            */
/* ========================================================================== */

/**
 * Turn whatever the callers module exports into the one shape this engine
 * reads. Tolerant on the way in, strict on the way out.
 *
 * Accepted for the roster:  CALLERS | CAST | callers | roster   (array or map)
 * Accepted for the lines:   PHONE_LINES | LINES | CALLS | lines (nested or flat)
 *                           or a documented `linesFor(trigger)` + `TRIGGERS`
 *
 * @returns {{callers:Map, byTrigger:Map, all:Array, count:number, sourceKeys:string[]}}
 */
export function normalizeLibrary(mod) {
  const callers = new Map();
  const byTrigger = new Map();
  const all = [];
  const sourceKeys = [];
  if (!mod || typeof mod !== 'object') return { callers, byTrigger, all, count: 0, sourceKeys };

  /* --- roster ---------------------------------------------------------- */
  const rosterSrc = mod.CALLERS || mod.CAST || mod.callers || mod.roster || mod.cast || null;
  const addCaller = (key, v) => {
    if (!v || typeof v !== 'object') return;
    const id = String(v.id ?? key ?? '').trim();
    if (!id) return;
    const name = String(v.name ?? v.displayName ?? v.label ?? id);
    callers.set(id, {
      id,
      name,
      role: String(v.role ?? v.title ?? ''),
      color: String(v.color ?? '#8fd3ff'),
      blurb: String(v.blurb ?? v.bio ?? ''),
      voiceDirection: String(v.voiceDirection ?? ''),
      avatar: v.avatar ?? v.icon ?? null,
      cooldown: num(Number(v.cooldown), PHONE_TUNING.CALLER_COOLDOWN),
    });
  };
  if (Array.isArray(rosterSrc)) {
    sourceKeys.push('roster:array');
    for (let i = 0; i < rosterSrc.length; i++) addCaller(null, rosterSrc[i]);
  } else if (rosterSrc && typeof rosterSrc === 'object') {
    sourceKeys.push('roster:object');
    for (const [k, v] of Object.entries(rosterSrc)) addCaller(k, v);
  }

  /* --- lines ----------------------------------------------------------- */
  const addLine = (trigger, raw) => {
    if (!raw) return;
    const o = typeof raw === 'string' ? { text: raw } : raw;
    const text = o.text ?? o.line ?? o.body ?? o.message ?? null;
    if (typeof text !== 'string' || !text.trim()) return;
    const trig = String(o.trigger ?? o.category ?? o.moment ?? trigger ?? '').trim();
    if (!trig) return;
    const caller = String(o.caller ?? o.callerId ?? o.cast ?? o.castId ?? o.from ?? '');
    const id = String(o.id ?? o.asset ?? o.assetId ?? `${trig}-${hash32(text).toString(36)}`);
    /* Default the kind from the TRIGGER, not to CALL.
       callers.js emits no `kind` on any line, so every one of the 240 landed as
       a call — while TRIGGERS marks 'ate-car' and 'powerup' as prefer:TEXT and
       _maybeText correctly refuses to promote a text moment into a call.
       The result was 97 lines (40.4%) that could never be selected: two whole
       triggers permanently mute, and no error anywhere, because each half was
       behaving exactly as designed. A line's kind belongs to the moment it
       describes; only an explicit `kind` on the line should override that. */
    const prefer = (TRIGGERS[trig] || DEFAULT_TRIGGER).prefer;
    const kindRaw = String(o.kind ?? o.type ?? prefer ?? KIND.CALL).toLowerCase();
    const kind = kindRaw === KIND.TEXT || kindRaw === 'sms' || kindRaw === 'message'
      ? KIND.TEXT : KIND.CALL;
    const line = {
      id,
      caller,
      text: text.trim(),
      trigger: trig,
      kind,
      mature: o.mature === true || o.adult === true,
      weight: num(Number(o.weight), 1),
      cooldown: num(Number(o.cooldown), PHONE_TUNING.LINE_COOLDOWN),
      seconds: num(Number(o.seconds), 0),
    };
    all.push(line);
    let arr = byTrigger.get(trig);
    if (!arr) { arr = []; byTrigger.set(trig, arr); }
    arr.push(line);
  };

  const eatNested = (obj, label) => {
    let took = 0;
    for (const [trig, v] of Object.entries(obj)) {
      if (Array.isArray(v)) {
        for (const e of v) { addLine(trig, e); took++; }
      } else if (v && typeof v === 'object') {
        /* { trigger: { callerId: [line, ...] } } — the voicelines.js shape. */
        for (const [callerId, list] of Object.entries(v)) {
          if (!Array.isArray(list)) continue;
          for (const e of list) {
            const withCaller = (e && typeof e === 'object') ? { caller: callerId, ...e } : { caller: callerId, text: e };
            addLine(trig, withCaller);
            took++;
          }
        }
      }
    }
    if (took) sourceKeys.push(label);
    return took;
  };

  const linesSrc = mod.PHONE_LINES || mod.LINES || mod.CALLS || mod.lines || null;
  if (Array.isArray(linesSrc)) {
    sourceKeys.push('lines:flat');
    for (const e of linesSrc) addLine(null, e);
  } else if (linesSrc && typeof linesSrc === 'object') {
    eatNested(linesSrc, 'lines:nested');
  }

  /* Documented-api style: linesFor(trigger) plus a trigger list. */
  if (all.length === 0 && isFn(mod.linesFor)) {
    const names = Array.isArray(mod.TRIGGERS) ? mod.TRIGGERS
      : (mod.TRIGGERS && typeof mod.TRIGGERS === 'object') ? Object.keys(mod.TRIGGERS)
        : Object.keys(TRIGGERS);
    let took = 0;
    for (const n of names) {
      let rows = null;
      try { rows = mod.linesFor(n); } catch { rows = null; }
      if (!Array.isArray(rows)) continue;
      for (const r of rows) { addLine(n, r); took++; }
    }
    if (took) sourceKeys.push('lines:linesFor');
  }

  return { callers, byTrigger, all, count: all.length, sourceKeys };
}

/* ========================================================================== */
/* validateLines() — THE HARD FILTER                                          */
/* ========================================================================== */

/**
 * Walk the WHOLE library and throw on any content-policy or structural
 * violation.
 *
 * This is the enforcement point the policy names. It runs over every line and
 * every caller, in both the raw and the normalised forms, and it collects
 * EVERY error rather than stopping at the first — an author fixing one line at
 * a time through eight rebuilds is an author who starts deleting the check.
 *
 * WHAT IT CANNOT DO, stated plainly rather than implied:
 *   - It cannot know every real person's name. Impersonation is caught
 *     structurally (a real office + a proper noun, a social handle, a real
 *     agency or brand from a finite list, "in the style of"). A line naming an
 *     obscure real individual in plain prose will pass. The roster rule is the
 *     real defence: every caller must be declared, and the declaration is what
 *     a human reviews.
 *   - It cannot judge tone. "Rare and reactive" is enforced at SELECTION
 *     (see _selectLine), not here.
 *
 * @param {object} library  a callers module, or an already-normalised library
 * @param {object} [opts]   { throwOnError = true, strict = false }
 * @returns {{ok:boolean, errors:string[], warnings:string[], stats:object}}
 * @throws  {PhoneContentError}
 */
export function validateLines(library, opts = {}) {
  const throwOnError = opts.throwOnError !== false;
  const lib = (library && library.byTrigger instanceof Map && Array.isArray(library.all))
    ? library
    : normalizeLibrary(library);

  const errors = [];
  const warnings = [];
  const seenExact = new Set();
  const seenLower = new Map();
  const seenText = new Map();
  const callerLineCount = new Map();
  let matureCount = 0;

  /* ---- roster ---------------------------------------------------------- */
  for (const [id, c] of lib.callers) {
    callerLineCount.set(id, 0);
    if (!SLUG_RE.test(id) || id.length > SLUG_MAX) {
      errors.push(`caller id "${id}" is not a filesystem-safe slug`);
    }
    if (!c.name || !c.name.trim()) errors.push(`caller "${id}" has no display name`);
    if (!/^#[0-9a-f]{6}$/i.test(c.color)) {
      errors.push(`caller "${id}" color must be #rrggbb (hud.pushFeed takes a hex string)`);
    }
    if (!(c.cooldown >= 0)) errors.push(`caller "${id}" needs a non-negative cooldown`);
    /* Policy over every human-readable field, not just the lines. */
    for (const field of ['name', 'role', 'blurb', 'voiceDirection']) {
      const hit = screenText(c[field], 'any');
      if (hit) errors.push(`caller "${id}" ${field} trips ${hit.id} (${hit.why})`);
    }
  }
  if (lib.callers.size === 0) errors.push('the library declares no callers');

  /* ---- lines ----------------------------------------------------------- */
  for (const line of lib.all) {
    const id = line.id;

    if (seenExact.has(id)) errors.push(`duplicate line id "${id}" — one of the two is lost`);
    seenExact.add(id);
    if (!SLUG_RE.test(id)) errors.push(`id "${id}" is not [a-z0-9] with single hyphens`);
    if (id.length > SLUG_MAX) errors.push(`id "${id}" is ${id.length} chars, max ${SLUG_MAX}`);
    if (RESERVED_BASENAMES.has(id)) errors.push(`id "${id}" is a reserved Windows device name`);
    const lower = id.toLowerCase();
    if (seenLower.has(lower) && seenLower.get(lower) !== id) {
      errors.push(`id "${id}" collides with "${seenLower.get(lower)}" on a case-insensitive disk`);
    }
    seenLower.set(lower, id);

    if (!lib.callers.has(line.caller)) {
      errors.push(`line "${id}" has caller "${line.caller}" which is not in the roster ` +
        '(every caller must be a declared original fictional character)');
    } else {
      callerLineCount.set(line.caller, callerLineCount.get(line.caller) + 1);
    }

    if (!SLUG_RE.test(line.trigger)) errors.push(`line "${id}" has trigger "${line.trigger}" which is not a slug`);
    if (line.kind !== KIND.CALL && line.kind !== KIND.TEXT) {
      errors.push(`line "${id}" kind must be 'call' or 'text'`);
    }
    if (typeof line.mature !== 'boolean') errors.push(`line "${id}" mature must be a boolean`);
    if (!(line.weight > 0) || !Number.isFinite(line.weight)) errors.push(`line "${id}" needs a finite weight above zero`);
    if (!(line.cooldown >= 0) || !Number.isFinite(line.cooldown)) errors.push(`line "${id}" needs a finite non-negative cooldown`);

    const t = line.text;
    if (t !== t.trim()) errors.push(`line "${id}" has leading/trailing whitespace`);
    if (/\s{2,}/.test(t)) errors.push(`line "${id}" has a double space (TTS reads it as a stumble)`);
    if (wordCount(t) > MAX_WORDS) errors.push(`line "${id}" is ${wordCount(t)} words, max ${MAX_WORDS}`);
    if (t.length > MAX_CHARS) errors.push(`line "${id}" is ${t.length} chars, max ${MAX_CHARS}`);

    /* THE HARD FILTER. Applies at every setting, mature or not. */
    const hit = screenText(t, 'text');
    if (hit) errors.push(`line "${id}" trips ${hit.id} — ${hit.why} — FORBIDDEN at any setting`);

    /* THE TOGGLE, KEPT HONEST. Strong language on an unflagged line would be
       eligible with Mature Dialogue OFF, which would make "default off" a
       decoration. */
    if (STRONG_LANG.test(t) && !line.mature) {
      errors.push(`line "${id}" uses strong language but is not flagged mature:true — ` +
        'it would be selectable with the default-off setting');
    }
    if (line.mature) {
      matureCount++;
      if (!STRONG_LANG.test(t) && !MILD_LANG.test(t)) {
        warnings.push(`line "${id}" is flagged mature but reads no stronger than a mild line ` +
          '(it will spend the rare mature budget for nothing)');
      }
    }
    if (/'/.test(t)) {
      warnings.push(`line "${id}" uses an ASCII apostrophe; U+2019 is safer through innerHTML`);
    }

    const norm = normPlain(t);
    if (seenText.has(norm)) {
      warnings.push(`line "${id}" duplicates the text of "${seenText.get(norm)}" (two assets, one sentence)`);
    } else {
      seenText.set(norm, id);
    }
  }

  /* ---- per-trigger sanity ---------------------------------------------- */
  for (const [trig, rows] of lib.byTrigger) {
    const mild = rows.filter((r) => !r.mature);
    if (mild.length === 0) {
      /* With Mature Dialogue off — the default, and the state most sessions run
         in — this trigger can never produce a line. That is a dead moment, not
         a taste call. */
      errors.push(`trigger "${trig}" has ${rows.length} line(s) and ALL of them are mature: ` +
        'with the default-off setting it can never fire');
    }
    if (rows.length < 2) warnings.push(`trigger "${trig}" has only ${rows.length} line(s) and cannot vary`);
    if (!TRIGGERS[trig]) warnings.push(`trigger "${trig}" is not in the built-in TRIGGERS table (it will use the default gates)`);
  }
  for (const [id, n] of callerLineCount) {
    if (n === 0) warnings.push(`caller "${id}" has no lines and would never ring`);
  }
  if (lib.all.length === 0) errors.push('the library contains no usable lines');

  const stats = {
    callers: lib.callers.size,
    lines: lib.all.length,
    triggers: lib.byTrigger.size,
    mature: matureCount,
    calls: lib.all.filter((l) => l.kind === KIND.CALL).length,
    texts: lib.all.filter((l) => l.kind === KIND.TEXT).length,
    perTrigger: Object.fromEntries([...lib.byTrigger].map(([k, v]) => [k, v.length])),
    denylistRules: DENYLIST.length,
  };

  if (opts.strict && warnings.length) errors.push(...warnings.map((w) => `strict: ${w}`));
  if (errors.length && throwOnError) throw new PhoneContentError(errors, stats);
  return { ok: errors.length === 0, errors, warnings, stats };
}

/* ========================================================================== */
/* THE ENGINE                                                                 */
/* ========================================================================== */

let _callSeq = 0;

export class PhoneSystem {
  /**
   * @param {object} deps
   * @param {Function} [deps.rng]        () => [0,1). Supplying one moves parity
   *   onto YOUR stream — the internal cursor-based stream is the one
   *   serialize()/applyState() can reproduce exactly. Prefer `seed`.
   * @param {number}   [deps.seed]       seed for the internal stream
   * @param {object}   [deps.lines]      the callers module (or a compatible one)
   * @param {object}   [deps.audio]      core/audio.js singleton, for ring/ui blips
   * @param {object}   [deps.voice]      VoiceSystem — its `manifest` Map is
   *   consulted for asset urls, so phone lines generated into the shared pack
   *   are found without a second manifest.
   * @param {Function} [deps.onCall]     (event) => void — incoming/answered/ended
   * @param {Function} [deps.onText]     (event) => void
   * @param {Function} [deps.onCaption]  (caption) => void, same shape voice.js emits
   * @param {Function} [deps.getMature]  () => boolean. DEFAULT FALSE.
   * @param {Function} [deps.getVolume]  () => 0..1
   * @param {Function} [deps.getMuted]   () => boolean
   * @param {Function} [deps.getBestScore] () => number, the personal best to beat
   * @param {object}   [deps.tuning]     partial PHONE_TUNING override
   * @param {object}   [deps.triggers]   extra/overriding trigger descriptors
   * @param {object}   [deps.hud]        optional, only for the pre-UI feed fallback
   */
  constructor(deps = {}) {
    this.T = { ...PHONE_TUNING, ...(deps.tuning || {}) };
    this.triggers = { ...TRIGGERS, ...(deps.triggers || {}) };

    this._extRng = isFn(deps.rng) ? deps.rng : null;
    this._seed = (Number.isFinite(deps.seed) ? deps.seed : 0x50484f4e) >>> 0;  // 'PHON'
    this._cursor = 0;

    this.audio = deps.audio || null;
    this.voice = deps.voice || null;
    this.hud = deps.hud || null;

    this.onCall = isFn(deps.onCall) ? deps.onCall : null;
    this.onText = isFn(deps.onText) ? deps.onText : null;
    this.onCaption = isFn(deps.onCaption) ? deps.onCaption : null;

    /* DEFAULT OFF. Not "off unless something says otherwise" — off, full stop,
       and the only way it turns on is a caller handing over a function that
       returns true or an explicit setMature(true). */
    this._mature = false;
    this._getMature = isFn(deps.getMature) ? deps.getMature : null;

    this._getVolume = isFn(deps.getVolume) ? deps.getVolume : null;
    this._getMuted = isFn(deps.getMuted) ? deps.getMuted : null;
    this._getBestScore = isFn(deps.getBestScore) ? deps.getBestScore : null;

    /** @type {{callers:Map, byTrigger:Map, all:Array, count:number}} */
    this.library = { callers: new Map(), byTrigger: new Map(), all: [], count: 0, sourceKeys: [] };
    this.libraryError = null;

    /* --- clock and scheduling state ----------------------------------- *
     * `time` is advanced ONLY by update(dt), never by wall clock. A paused
     * game that silently burns off its cooldowns produces a wall of calls the
     * instant it resumes — voice.js:1043 learned this the same way. */
    this.time = 0;

    /** @type {object|null} the ONE live call. Never two. Ever. */
    this._call = null;
    /** @type {object[]} pending moments, each with a ttl. */
    this._queue = [];

    this._cdCaller = new Map();     // callerId -> time free (calls)
    this._cdCallerText = new Map(); // callerId -> time free (texts)
    this._cdLine = new Map();       // line id  -> time free
    this._cdTrigger = new Map();    // trigger  -> time free

    this._lastCallStart = -1e6;
    this._lastCallEnd = -1e6;
    this._lastTextAt = -1e6;
    this._lastMatureAt = -1e6;

    this._callsThisMatch = 0;
    this._textsThisMatch = 0;
    this._matureThisMatch = 0;
    this._matchT = 0;               // seconds since the match went live

    /** @type {object[]} newest last; history() reverses a copy. */
    this._history = [];

    /* --- change detectors, all reset by _startMatch() ------------------ */
    this._seen = this._freshSeen();

    /** id -> absolute url, for a phone-only voice pack. */
    this._manifest = new Map();
    this._manifestSeconds = new Map();

    /** Bumped by clearAll(). Async continuations capture it and bail. */
    this._gen = 0;

    this._warned = new Set();

    this.stats = {
      moments: 0, calls: 0, texts: 0, answered: 0, missed: 0, declined: 0,
      hungup: 0, cleared: 0, mature: 0, played: 0, captionOnly: 0,
      loadFails: 0, phaseUnknown: 0,
      dropped: Object.create(null),
    };

    if (deps.lines) this.setLibrary(deps.lines);
  }

  _freshSeen() {
    return {
      radius: 0,
      grew: new Set(),
      heatTier: 0,
      powerups: new Set(),
      inZoo: false,
      eventId: null,
      bestBase: 0,
      bestFired: false,
      biggestMeal: 0,
      phase: null,
    };
  }

  /* ------------------------------------------------------------ library -- */

  /**
   * Install a callers module. VALIDATES FIRST.
   *
   * A library that trips the policy is REJECTED WHOLESALE — no partial load,
   * no "drop the bad lines and keep going". A corpus that has been edited into
   * a state where a banned line exists is a corpus nobody has reviewed, and
   * dropping four lines quietly can leave a trigger with one survivor that
   * then plays every single time.
   *
   * @returns {boolean} true if the library is now live
   */
  setLibrary(mod) {
    const lib = normalizeLibrary(mod);
    try {
      validateLines(lib);
    } catch (err) {
      this.library = { callers: new Map(), byTrigger: new Map(), all: [], count: 0, sourceKeys: lib.sourceKeys };
      this.libraryError = err;
      if (typeof console !== 'undefined' && console.error) {
        console.error('[phone] callers library REJECTED — the phone will stay silent.', err.message);
      }
      return false;
    }
    this.library = lib;
    this.libraryError = null;
    if (typeof console !== 'undefined' && console.info) {
      console.info(`[phone] library ok: ${lib.callers.size} callers, ${lib.all.length} lines, ` +
        `${lib.byTrigger.size} triggers (${lib.sourceKeys.join('+') || 'empty'})`);
    }
    return true;
  }

  /** Is there anything to say at all? */
  ready() { return this.library.all.length > 0; }

  /* -------------------------------------------------------------- assets -- */

  /**
   * Load a phone-only voice manifest. NEVER throws, NEVER rejects.
   *
   * URL RULE, and it is the one that has already cost this project a whole
   * pack: a relative url in the manifest resolves against the MANIFEST's url
   * by ordinary URL semantics. A manifest at `/audio/phone/manifest.json`
   * listing `a.mp3` means `/audio/phone/a.mp3`. Listing `audio/phone/a.mp3`
   * means `/audio/phone/audio/phone/a.mp3` and every file 404s. Never join
   * strings; always resolve.
   *
   * @returns {Promise<boolean>} true = at least one asset registered
   */
  async loadManifest(manifestUrl) {
    const gen = this._gen;
    this._manifest.clear();
    this._manifestSeconds.clear();
    if (!manifestUrl || typeof fetch !== 'function') return false;
    try {
      const res = await fetch(manifestUrl, { cache: 'force-cache' });
      if (!res || !res.ok) throw new Error(`HTTP ${res && res.status}`);
      const json = await res.json();
      if (gen !== this._gen) return false;
      const table = (json && (json.assets || json.entries || json.lines || json.voices)) || json;
      if (!table || typeof table !== 'object') throw new Error('shape');
      const base = typeof URL === 'function' ? manifestUrl : null;
      for (const [id, v] of Object.entries(table)) {
        const raw = typeof v === 'string' ? v : v && (v.url || v.file || v.path);
        if (!raw || typeof raw !== 'string') continue;
        let url = raw;
        if (base && !/^(https?:|data:|blob:|\/)/.test(raw)) {
          try {
            url = new URL(raw, new URL(base, (globalThis.location && globalThis.location.href) || 'http://x/')).href;
          } catch { url = raw; }
        }
        this._manifest.set(String(id), url);
        if (v && typeof v === 'object') {
          const secs = Number.isFinite(v.seconds) ? v.seconds : Number.isFinite(v.ms) ? v.ms / 1000 : 0;
          if (secs > 0) this._manifestSeconds.set(String(id), secs);
        }
      }
      if (this._manifest.size === 0) throw new Error('empty');
      return true;
    } catch (err) {
      this.stats.loadFails++;
      if (typeof console !== 'undefined' && console.info) {
        console.info('[phone] no phone voice pack (captions only):', err && err.message);
      }
      this._manifest.clear();
      return false;
    }
  }

  /** Asset url for a line id: the phone's own pack first, then the shared one. */
  _urlFor(id) {
    const own = this._manifest.get(id);
    if (own) return own;
    const vm = this.voice && this.voice.manifest;
    if (vm && isFn(vm.get)) {
      const shared = vm.get(id);
      if (shared) return shared;
    }
    return null;
  }

  /* --------------------------------------------------------------- mixer -- */

  setMature(on) { this._mature = !!on; return this; }

  /** The authority is the injected getter when there is one. Default FALSE. */
  matureEnabled() {
    if (this._getMature) {
      try { return this._getMature() === true; } catch { return false; }
    }
    return this._mature === true;
  }

  /**
   * Playback level for the element path.
   *
   * Mirrors _startEl's arithmetic in voice.js, including the paranoia: every
   * factor is checked for finiteness BEFORE it enters the product, and the
   * product is checked again after. `0.9 * undefined` is NaN, and a NaN volume
   * is the bug that made this project silent while every instrument said the
   * line was playing.
   */
  _level() {
    let v = 1;
    if (this._getVolume) {
      let got;
      try { got = Number(this._getVolume()); } catch { got = NaN; }
      v = Number.isFinite(got) ? got : 1;
    }
    const trim = Number.isFinite(this.T.EL_TRIM) ? this.T.EL_TRIM : PHONE_TUNING.EL_TRIM;
    let lvl = clamp(v * trim, 0, 1);
    if (!Number.isFinite(lvl)) lvl = 0.5;
    return lvl;
  }

  _muted() {
    if (!this._getMuted) return false;
    try { return this._getMuted() === true; } catch { return false; }
  }

  /* ------------------------------------------------------------- queries -- */

  /** The live call (RINGING or CONNECTED), or null. */
  active() {
    const c = this._call;
    if (!c) return null;
    return (c.state === CALL_STATE.RINGING || c.state === CALL_STATE.CONNECTED) ? c : null;
  }

  /** Recent calls and texts, newest first. A copy: the UI may not mutate it. */
  history() {
    const out = [];
    for (let i = this._history.length - 1; i >= 0; i--) out.push({ ...this._history[i] });
    return out;
  }

  /** Rows the player has not opened yet, for the badge. */
  unread() {
    let n = 0;
    for (const h of this._history) if (!h.read) n++;
    return n;
  }

  markRead(id) {
    for (const h of this._history) if (h.id === id) h.read = true;
    return this;
  }

  markAllRead() {
    for (const h of this._history) h.read = true;
    return this;
  }

  clearHistory() { this._history.length = 0; return this; }

  /** Everything a debug panel or a probe wants. MEASURE, do not assert. */
  debugStats() {
    return {
      ...this.stats,
      dropped: { ...this.stats.dropped },
      time: +this.time.toFixed(2),
      matchT: +this._matchT.toFixed(2),
      live: this._call ? { id: this._call.id, state: this._call.state, caller: this._call.callerId } : null,
      queued: this._queue.length,
      mature: { enabled: this.matureEnabled(), used: this._matureThisMatch, cap: this.T.MATURE_MAX_PER_MATCH },
      budget: { calls: this._callsThisMatch, texts: this._textsThisMatch },
      library: {
        ok: !this.libraryError,
        callers: this.library.callers.size,
        lines: this.library.all.length,
        error: this.libraryError ? this.libraryError.message : null,
      },
      assets: this._manifest.size,
    };
  }

  /* ------------------------------------------------------------ lifecycle -- */

  /**
   * Drop everything. NO RESIDUE: no ringing call, no queued moment, no timer,
   * no audio element, no per-match budget carried into the next round.
   *
   * History survives on purpose — the phone's Calls tab should still show the
   * last match. clearHistory() is separate.
   */
  clearAll() {
    this._gen++;
    const c = this._call;
    if (c) {
      this._stopAudio(c);
      c.state = CALL_STATE.CLEARED;
      c.endedAt = this.time;
      this.stats.cleared++;
      this._push(c);
      this._emit(c, 'ended');
    }
    this._call = null;
    this._queue.length = 0;
    this._callsThisMatch = 0;
    this._textsThisMatch = 0;
    this._matureThisMatch = 0;
    this._matchT = 0;
    this._lastCallStart = -1e6;
    this._lastCallEnd = -1e6;
    this._lastTextAt = -1e6;
    this._lastMatureAt = -1e6;
    this._cdCaller.clear();
    this._cdCallerText.clear();
    this._cdTrigger.clear();
    /* _cdLine deliberately survives a clear: a line the player heard 20 s ago
       should not be the first thing they hear in the next round. */
    this._seen = this._freshSeen();
    return this;
  }

  /** Free the audio and forget the system. */
  dispose() {
    this.clearAll();
    this._history.length = 0;
    this._manifest.clear();
    this.onCall = this.onText = this.onCaption = null;
    return this;
  }

  /* --------------------------------------------------------------- input -- */

  /**
   * Fire a moment. The ENGINE decides whether it becomes a call, a text, or
   * nothing at all. Never throws — this is called from gameplay code paths.
   *
   * @param {string} name  a key of TRIGGERS, or any slug the library uses
   * @param {object} [data] free-form, passed through to the UI event
   * @returns {boolean} true if it produced a call or a text
   */
  trigger(name, data = null) {
    try {
      return this._trigger(String(name || ''), data, false);
    } catch (err) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[phone] trigger failed', err);
      return false;
    }
  }

  _trigger(name, data, fromQueue) {
    if (!name) return false;
    if (!this.ready()) { this._drop('no-library'); return false; }
    const desc = this.triggers[name] || DEFAULT_TRIGGER;
    if (!fromQueue) this.stats.moments++;

    /* Per-trigger cooldown first: it is the cheapest rejection and the one
       that stops a chatty detector (a hole hovering on the zoo fence line)
       from filling the queue. */
    const cdT = this._cdTrigger.get(name);
    if (cdT !== undefined && this.time < cdT) { this._drop('trigger-cooldown'); return false; }

    /* Ambient gates. "Nobody calls about a bench": a low-value moment early in
       a match, with a small hole, is not a moment. */
    if (desc.ambient) {
      if (this._matchT < this.T.AMBIENT_WARMUP) { this._drop('ambient-early'); return false; }
      if (this._seen.radius < this.T.AMBIENT_MIN_RADIUS) { this._drop('ambient-small'); return false; }
    }

    const wantCall = desc.prefer !== KIND.TEXT;
    if (wantCall) {
      const why = this._callGate();
      if (!why) {
        if (this._ring(name, desc, data)) return true;
        /* The gates were open but the library had no CALL line for this moment
           — a map that ships only texts for it, or every call line on
           cooldown. Fall through to the text path rather than losing the
           moment: silently dropping it would make a legal library look like a
           broken trigger, which is a bug that reads as content. */
        if (this._textGate()) return false;
        return this._sendText(name, desc, data, false);
      }
      /* A call is impossible right now. Two outs, in order:
         1. queue it briefly if the blocker is transient (a live call), so a
            big moment is not simply lost to a two-second overlap;
         2. downgrade to a text, which has its own, looser budget. */
      if (!fromQueue && (why === 'call-active' || why === 'call-gap' || why === 'call-quiet')) {
        this._enqueue(name, data, desc);
      }
      this._drop(why);
      if (this._textGate()) return false;
      return this._sendText(name, desc, data, true);
    }

    if (!this._textGate()) return this._sendText(name, desc, data, false);
    this._drop('text-gate');
    /* A text-preferring moment does NOT get promoted to a call. Promoting the
       cheap moments is exactly how a phone becomes unbearable. */
    return false;
  }

  _enqueue(name, data, desc) {
    if (this._queue.length >= this.T.QUEUE_MAX) return;
    for (const q of this._queue) if (q.name === name) return;   // no duplicates
    this._queue.push({ name, data, until: this.time + this.T.TRIGGER_TTL, priority: desc.priority || 1 });
  }

  _drop(reason) {
    this.stats.dropped[reason] = (this.stats.dropped[reason] || 0) + 1;
  }

  /* ---------------------------------------------------------------- gates -- */

  /**
   * Can a call START right now? Returns null when yes, else the reason.
   *
   * ORDER MATTERS ONLY FOR THE STATS. Every one of these is a hard no.
   */
  _callGate() {
    if (this.active()) return 'call-active';                       // ONE. EVER.
    if (this._matchT < this.T.WARMUP) return 'call-warmup';
    if (this._callsThisMatch >= this.T.MAX_CALLS_PER_MATCH) return 'call-budget';
    if (this.time - this._lastCallStart < this.T.GLOBAL_CALL_GAP) return 'call-gap';
    if (this.time - this._lastCallEnd < this.T.POST_CALL_QUIET) return 'call-quiet';
    return null;
  }

  /** @returns {string|null} reason a text cannot send, or null. */
  _textGate() {
    if (this._matchT < this.T.TEXT_WARMUP) return 'text-warmup';
    if (this._textsThisMatch >= this.T.MAX_TEXTS_PER_MATCH) return 'text-budget';
    if (this.time - this._lastTextAt < this.T.TEXT_GAP) return 'text-gap';
    return null;
  }

  /**
   * MAY THIS MOMENT CARRY A MATURE LINE?
   *
   * Four independent gates, and all four must pass:
   *   1. the setting is ON (default OFF);
   *   2. the moment is flagged `big` — reactive, tied to something that
   *      actually happened;
   *   3. the per-match budget is not spent, and MATURE_GAP has elapsed;
   *   4. a MATURE_CHANCE roll, so it is not a reliable tell.
   * This is what "rare and reactive" means in code. Never one per line.
   */
  _matureAllowed(desc) {
    if (!this.matureEnabled()) return false;
    if (!desc || !desc.big) return false;
    if (this._matureThisMatch >= this.T.MATURE_MAX_PER_MATCH) return false;
    if (this.time - this._lastMatureAt < this.T.MATURE_GAP) return false;
    return this._rand() < this.T.MATURE_CHANCE;
  }

  /* ----------------------------------------------------------- selection -- */

  _rand() {
    if (this._extRng) {
      const v = Number(this._extRng());
      return Number.isFinite(v) ? clamp(v, 0, 0.9999999) : 0.5;
    }
    return pureRandom(this._seed, this._cursor++);
  }

  /**
   * Pick a line.
   *
   * THE MATURE RULE IS APPLIED HERE, BEFORE THE PICK, NOT AT RENDER TIME.
   * When mature is not allowed, mature lines are removed from `pool` and can
   * never be chosen; there is no later stage that could let one through.
   *
   * `matureOnly` narrows the pool to mature lines. It exists because RARITY IS
   * DECIDED ONCE, IN _matureAllowed, AND NOWHERE ELSE.
   *
   * MEASURED, and this is why the parameter exists. The shipped callers.js
   * also de-weights its own mature lines (it exports MATURE_WEIGHT), so
   * merging the two pools multiplied the two rarity systems together: the
   * gate passed 34.6% of the time and a mature line was still only chosen
   * 1.75% of the time — 0 mature lines in 60 calls across 20 matches with the
   * setting explicitly ON. A toggle a player turns on and never sees is a
   * broken toggle, not a rare one. Deciding "this moment is a stronger one"
   * and "which line says it" are separate jobs; this keeps them separate, and
   * the observed rate becomes the MATURE_CHANCE this file documents.
   */
  _selectLine(trigger, kind, matureAllowed, matureOnly = false) {
    const rows = this.library.byTrigger.get(trigger);
    if (!rows || rows.length === 0) return null;

    const pool = [];
    let total = 0;
    for (const line of rows) {
      if (line.kind !== kind) continue;
      if (line.mature && !matureAllowed) continue;             // <- the policy
      if (matureOnly && !line.mature) continue;
      const caller = this.library.callers.get(line.caller);
      if (!caller) continue;
      const lineFree = this._cdLine.get(line.id);
      if (lineFree !== undefined && this.time < lineFree) continue;
      const cdMap = kind === KIND.TEXT ? this._cdCallerText : this._cdCaller;
      const callerFree = cdMap.get(line.caller);
      if (callerFree !== undefined && this.time < callerFree) continue;
      pool.push(line);
      total += line.weight;
    }
    if (pool.length === 0) return null;

    /* Within the chosen pool, weight is the only thing that matters. Rarity
       was already decided upstream. */
    let r = this._rand() * total;
    for (const line of pool) {
      r -= line.weight;
      if (r <= 0) return line;
    }
    return pool[pool.length - 1];
  }

  /* ---------------------------------------------------------------- calls -- */

  _ring(trigger, desc, data) {
    const matureOk = this._matureAllowed(desc);
    /* The roll decided this moment gets a stronger line, so look in the mature
       pool FIRST rather than merging it into the mild one — see _selectLine. */
    let line = matureOk ? this._selectLine(trigger, KIND.CALL, true, true) : null;
    /* The roll passed but nothing mature was eligible (none authored for this
       trigger, or all on cooldown). Fall back to a mild line rather than
       losing the moment, and do NOT spend the mature budget on it. */
    if (!line) line = this._selectLine(trigger, KIND.CALL, false);
    if (!line) { this._drop('no-line'); return false; }

    const caller = this.library.callers.get(line.caller);
    const call = {
      id: `call-${++_callSeq}`,
      kind: KIND.CALL,
      state: CALL_STATE.RINGING,
      trigger,
      data: data || null,
      lineId: line.id,
      text: line.text,
      mature: line.mature === true,
      callerId: caller.id,
      callerName: caller.name,
      callerRole: caller.role,
      color: caller.color,
      avatar: caller.avatar,
      startedAt: this.time,
      ringUntil: this.time + this.T.RING_SECONDS,
      connectedAt: 0,
      endsAt: 0,
      endedAt: 0,
      minimized: false,
      spoken: false,
      el: null,
      /** The ringtone loop handle. Held so every exit path can stop it. */
      ring: null,
      gen: this._gen,
      read: false,
    };

    this._call = call;
    this._callsThisMatch++;
    this._lastCallStart = this.time;
    this._cdTrigger.set(trigger, this.time + num(desc.cooldown, this.T.TRIGGER_COOLDOWN));
    this._cdCaller.set(caller.id, this.time + num(caller.cooldown, this.T.CALLER_COOLDOWN));
    this._cdLine.set(line.id, this.time + num(line.cooldown, this.T.LINE_COOLDOWN));
    if (call.mature) {
      this._matureThisMatch++;
      this._lastMatureAt = this.time;
      this.stats.mature++;
    }
    this.stats.calls++;
    call.ring = this._sfx('ring');
    this._emit(call, 'incoming');
    return true;
  }

  /**
   * Answer the ringing call.
   *
   * NOTHING about this pauses the game. It starts an audio element and emits
   * an event; the simulation does not know it happened.
   */
  answer() {
    const c = this._call;
    if (!c || c.state !== CALL_STATE.RINGING) return false;
    c.state = CALL_STATE.CONNECTED;
    c.connectedAt = this.time;
    c.read = true;
    this._stopRing(c);
    this._sfx('answer');

    const url = this._urlFor(c.lineId);
    const est = this._estimateSeconds(c.lineId, c.text);
    /* Reserve the slot on an ESTIMATE first. If the element never fires
       loadedmetadata — a 404, a codec the browser refuses — the call still
       ends on its own instead of holding the one slot for the whole match. */
    c.endsAt = this.time + this.T.CONNECT_LEAD + est;

    if (url && typeof Audio === 'function') {
      this._startEl(c, url);
    } else {
      this.stats.captionOnly++;
    }
    this._caption(c);
    this._emit(c, 'answered');
    return true;
  }

  /**
   * Decline a ringing call. Terminal, and it starts the post-call quiet.
   *
   * Counts as READ: the player saw it and said no. A MISSED call stays unread
   * so the phone's badge is a badge for things the player has not seen, which
   * is the only reading of "unread" a player will make.
   */
  dismiss() {
    const c = this._call;
    if (!c || c.state !== CALL_STATE.RINGING) return false;
    c.read = true;
    this._end(c, CALL_STATE.DECLINED);
    this.stats.declined++;
    this._sfx('decline');
    return true;
  }

  /**
   * Fold the call away without ending it.
   *
   * A GTA phone call keeps talking while you drive. This is a UI hint only: no
   * audio is touched, no timer is changed. It exists so the phone panel can
   * shrink to a strip without the engine having to know what a panel is.
   */
  minimize(on = true) {
    const c = this.active();
    if (!c) return false;
    c.minimized = !!on;
    this._emit(c, 'minimized');
    return true;
  }

  /** End a connected call early. */
  hangup() {
    const c = this._call;
    if (!c) return false;
    if (c.state === CALL_STATE.RINGING) return this.dismiss();
    if (c.state !== CALL_STATE.CONNECTED) return false;
    this._end(c, CALL_STATE.HUNGUP);
    this.stats.hungup++;
    this._sfx('hangup');
    return true;
  }

  _end(call, state) {
    this._stopAudio(call);
    call.state = state;
    call.endedAt = this.time;
    this._lastCallEnd = this.time;
    if (this._call === call) this._call = null;
    this._push(call);
    this._emit(call, 'ended');
  }

  /* ---------------------------------------------------------------- texts -- */

  _sendText(trigger, desc, data, downgraded) {
    const matureOk = this._matureAllowed(desc);
    let line = matureOk ? this._selectLine(trigger, KIND.TEXT, true, true) : null;
    if (!line) line = this._selectLine(trigger, KIND.TEXT, false);
    if (!line) { this._drop('no-text-line'); return false; }

    const caller = this.library.callers.get(line.caller);
    const msg = {
      id: `text-${++_callSeq}`,
      kind: KIND.TEXT,
      state: 'received',
      trigger,
      data: data || null,
      lineId: line.id,
      text: line.text,
      mature: line.mature === true,
      callerId: caller.id,
      callerName: caller.name,
      callerRole: caller.role,
      color: caller.color,
      avatar: caller.avatar,
      startedAt: this.time,
      endedAt: this.time,
      downgraded: !!downgraded,
      spoken: false,
      read: false,
    };

    this._textsThisMatch++;
    this._lastTextAt = this.time;
    this._cdTrigger.set(trigger, this.time + num(desc.cooldown, this.T.TRIGGER_COOLDOWN));
    this._cdCallerText.set(caller.id, this.time + this.T.TEXT_CALLER_COOLDOWN);
    this._cdLine.set(line.id, this.time + num(line.cooldown, this.T.LINE_COOLDOWN));
    if (msg.mature) {
      this._matureThisMatch++;
      this._lastMatureAt = this.time;
      this.stats.mature++;
    }
    this.stats.texts++;
    this._push(msg);
    this._sfx('text');
    if (this.onText) {
      try { this.onText({ type: 'text', ...msg }); }
      catch (err) { this._warnOnce('onText', err); }
    } else {
      this._feedFallback(msg, 'MESSAGE');
    }
    return true;
  }

  /* ---------------------------------------------------------------- audio -- */

  /**
   * Play one line through an HTMLAudioElement.
   *
   * THIS IS A DELIBERATE MIRROR OF VoiceSystem._startEl (voice.js:1149) and it
   * must stay one. The WebAudio graph in this project is silent for reasons
   * nobody has found; five fixes against it failed, and the element path is
   * the one a human has actually heard. There is no AudioContext, no
   * GainNode, no panner and no bus in this method, and adding one would be
   * re-running an experiment that has already failed five times.
   *
   * The trade is the same one voice.js accepts: an element gives volume but no
   * stereo pan. A phone call has no world position, so for this feature there
   * is no trade at all.
   */
  _startEl(call, url) {
    const gen = this._gen;
    let el;
    try {
      el = new Audio(url);
    } catch (err) {
      this.stats.loadFails++;
      this.stats.captionOnly++;
      return;
    }
    let lvl = this._level();
    if (!Number.isFinite(lvl)) lvl = 0.5;
    try { el.volume = this._muted() ? 0 : lvl; } catch { /* some engines refuse */ }
    call.el = el;
    call.spoken = true;

    el.addEventListener('ended', () => {
      if (gen !== this._gen || this._call !== call) return;
      this._end(call, CALL_STATE.ANSWERED);
      this.stats.answered++;
    }, { once: true });

    el.addEventListener('error', () => {
      /* A 404 or a codec refusal. The call must still run as a caption rather
         than ending instantly, or a missing asset looks like a call that hung
         up on you. Keep the estimated endsAt and drop the element. */
      this.stats.loadFails++;
      this.stats.captionOnly++;
      call.spoken = false;
      call.el = null;
      try { el.pause(); el.src = ''; } catch { /* already gone */ }
    }, { once: true });

    el.addEventListener('loadedmetadata', () => {
      if (gen !== this._gen) return;
      if (Number.isFinite(el.duration) && el.duration > 0) {
        call.endsAt = this.time + el.duration + 0.15;
      }
    }, { once: true });

    const p = el.play();
    if (p && isFn(p.catch)) {
      p.catch(() => {
        /* Autoplay refused (no gesture yet) or the element was retired
           mid-start. Neither is worth a console line every time somebody
           rings, and the caption already carries the content. */
        this.stats.captionOnly++;
        call.spoken = false;
        call.el = null;
      });
    }
    this.stats.played++;
  }

  /** Every teardown path goes through here, so the ring dies here too. */
  _stopAudio(call) {
    this._stopRing(call);
    const el = call && call.el;
    if (!el) return;
    call.el = null;
    try { el.pause(); el.src = ''; } catch { /* already gone */ }
  }

  /**
   * Ring/answer/hangup blips.
   *
   * NOTE FOR THE ORCHESTRATOR: core/audio.js's SOUND_METHODS is a 34-name
   * contract (audio.js:3549) and there is NO phone entry in it. Rather than
   * call a name that does not exist — the failure mode this codebase keeps
   * hitting — this duck-probes for a real phone sound and otherwise falls back
   * to `ui(kind)`, whose kinds are verified: click|hover|back|menuOpen|
   * menuClose|confirm|error (audio.js:1603-1611). If a phone ringtone is added
   * to SOUND_METHODS later, it is picked up here with no change.
   */
  _sfx(what) {
    const a = this.audio;
    if (!a) return null;
    const named = { ring: 'phoneRing', answer: 'phoneAnswer', hangup: 'phoneHangup', decline: 'phoneHangup', text: 'phoneText' }[what];
    try {
      if (named && isFn(a[named])) return a[named]();
      if (!isFn(a.ui)) return null;
      if (what === 'ring') a.ui('menuOpen');
      else if (what === 'answer') a.ui('confirm');
      else if (what === 'text') a.ui('hover');
      else a.ui('back');
    } catch { /* a closed AudioContext must never cost the call */ }
    return null;
  }

  /**
   * Stop the ringtone LOOP.
   *
   * `audio.phoneRing()` is a LOOP that returns a handle (audio.js:3556, and
   * the header contract at audio.js:64 says so explicitly). Its docs also say
   * phoneAnswer/phoneHangup stop it themselves — but the MISSED path calls
   * neither, so relying on that left a ringtone looping for the rest of the
   * match every time a call rang out. The handle is held and stopped on every
   * exit instead; `.stop()` is documented safe to call more than once, so the
   * belt and the braces do not fight.
   */
  _stopRing(call) {
    const h = call && call.ring;
    if (!h) return;
    call.ring = null;
    try { if (isFn(h.stop)) h.stop(); } catch { /* already dead */ }
  }

  /* -------------------------------------------------------------- output -- */

  _estimateSeconds(id, text) {
    const known = this._manifestSeconds.get(id);
    if (known > 0) return known;
    /* ~2.6 words a second reading aloud, floor so a three-word text is still
       on screen long enough to read. */
    const words = wordCount(text);
    return Math.max(this.T.CALL_MIN_SECONDS, Math.min(this.T.CALL_MAX_SECONDS, words / 2.6 + 0.8));
  }

  /** Same caption shape voice.js emits, so a HUD can reuse showCaption(c). */
  _caption(call) {
    if (!this.onCaption) return;
    try {
      this.onCaption({
        id: call.lineId,
        text: call.text,
        castId: call.callerId,
        castName: call.callerName,
        color: call.color,
        category: `phone:${call.trigger}`,
        priority: 2,
        distance: 0,
        ttl: Math.max(this.T.CALL_MIN_SECONDS, call.endsAt - this.time),
        spoken: !!call.spoken,
        phone: true,
      });
    } catch (err) {
      this._warnOnce('onCaption', err);
    }
  }

  _emit(call, type) {
    if (this.onCall) {
      try { this.onCall({ type, ...call, el: undefined }); }
      catch (err) { this._warnOnce('onCall', err); }
      return;
    }
    /* No UI wired yet. Make the feature VISIBLE rather than silently correct:
       a missed call nobody can see is indistinguishable from a phone that
       never rang, which is exactly the class of bug this project keeps
       shipping. Escaped, because pushFeed assigns innerHTML (hud.js:929). */
    if (type === 'incoming') this._feedFallback(call, 'INCOMING CALL');
    else if (type === 'ended' && call.state === CALL_STATE.MISSED) this._feedFallback(call, 'MISSED CALL');
  }

  _feedFallback(row, label) {
    const hud = this.hud;
    if (!hud || !isFn(hud.pushFeed)) return;
    try {
      hud.pushFeed(
        `<b>${escapeHtml(label)}</b> — ${escapeHtml(row.callerName)}: ${escapeHtml(row.text)}`,
        typeof row.color === 'string' ? row.color : '#8fd3ff',
        'event',
      );
    } catch { /* a throwing HUD must not take the phone down */ }
  }

  _warnOnce(key, err) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    if (typeof console !== 'undefined' && console.warn) console.warn(`[phone] ${key} threw`, err);
  }

  _push(row) {
    this._history.push({
      id: row.id,
      at: this.time,
      kind: row.kind,
      state: row.state,
      trigger: row.trigger,
      callerId: row.callerId,
      callerName: row.callerName,
      callerRole: row.callerRole,
      color: row.color,
      avatar: row.avatar,
      lineId: row.lineId,
      text: row.text,
      mature: row.mature,
      spoken: !!row.spoken,
      read: !!row.read,
      seconds: row.endedAt > row.startedAt ? +(row.endedAt - row.startedAt).toFixed(2) : 0,
    });
    while (this._history.length > this.T.HISTORY_MAX) this._history.shift();
  }

  /* --------------------------------------------------------------- update -- */

  /**
   * One frame. Advances the clock, retires the live call, drains the queue,
   * then reads `ctx` for the moments it detects itself.
   *
   * `ctx` is READ ONLY. Nothing in this method writes to the player, the
   * match, the heat system, the power-ups, the event glue or the layout, and
   * __selftest asserts that by deep-comparing a plain ctx before and after.
   *
   * @param {number} dt seconds
   * @param {object} [ctx] { player, match, heat, powerups, events, layout }
   */
  update(dt, ctx) {
    const d = Math.min(Math.max(Number(dt) || 0, 0), 0.25);   // clamp: alt-tab
    this.time += d;

    this._matchPhase(ctx);
    if (PHASE_LIVE.has(this._seen.phase)) this._matchT += d;

    this._tickCall();
    this._drainQueue();

    if (ctx && PHASE_LIVE.has(this._seen.phase)) this._detect(ctx);
    return this;
  }

  _matchPhase(ctx) {
    const match = ctx && ctx.match;
    const phase = match && typeof match.phase === 'string' ? match.phase : null;
    /* NO CTX IS NO INFORMATION, NOT "the match ended".
       An update(dt) with no ctx — a UI-only tick, a test, a frame before the
       Match exists — used to read as a live->dead transition and call
       clearAll(), which silently binned a ringing call one frame after it
       started. The real teardown paths are the resetWorld wrapper and a phase
       that actually says 'results'. */
    if (phase === null) return;
    if (!PHASE_KNOWN.has(phase)) {
      this.stats.phaseUnknown++;
      if (!this._warned.has(`phase:${phase}`)) {
        this._warned.add(`phase:${phase}`);
        if (typeof console !== 'undefined' && console.warn) {
          console.warn(`[phone] unknown match phase "${phase}" — check gameplay/match.js PHASE`);
        }
      }
    }
    const was = this._seen.phase;
    if (phase === was) return;
    const wasLive = PHASE_LIVE.has(was);
    const isLive = PHASE_LIVE.has(phase);
    if (!wasLive && isLive) {
      /* New round. clearAll resets _seen, so re-stamp the phase after it.
         _peakScore is per-MATCH and _sessionBest is across matches; leaving
         the peak from the last round in place would mean the first match a
         player loses badly never contributes, and worse, the personal-best
         baseline for THIS round would silently be last round's peak. */
      this.clearAll();
      this._peakScore = 0;
      this._seen.phase = phase;
      this._seen.bestBase = this._bestBaseline();
      return;
    }
    if (wasLive && !isLive) {
      const best = this._peakScore;
      if (Number.isFinite(best) && best > this._sessionBest) this._sessionBest = best;
      this.clearAll();
    }
    this._seen.phase = phase;
  }

  _bestBaseline() {
    if (this._getBestScore) {
      try {
        const v = Number(this._getBestScore());
        if (Number.isFinite(v) && v > 0) return v;
      } catch { /* fall through */ }
    }
    return this._sessionBest;
  }

  /** Retire the live call: ring timeout, or the end of a connected line. */
  _tickCall() {
    const c = this._call;
    if (!c) return;
    if (c.state === CALL_STATE.RINGING) {
      if (this.time >= c.ringUntil) {
        /* A ringing call that goes unanswered times out POLITELY: it becomes a
           missed call in the log, costs the player nothing, and starts the
           post-call quiet like any other ending. */
        this._end(c, CALL_STATE.MISSED);
        this.stats.missed++;
      }
      return;
    }
    if (c.state === CALL_STATE.CONNECTED) {
      const hardStop = c.connectedAt + this.T.CALL_MAX_SECONDS;
      if (this.time >= c.endsAt || this.time >= hardStop) {
        this._end(c, CALL_STATE.ANSWERED);
        this.stats.answered++;
      }
    }
  }

  _drainQueue() {
    const q = this._queue;
    if (q.length === 0) return;
    for (let i = q.length - 1; i >= 0; i--) {
      if (this.time > q[i].until) { q.splice(i, 1); this._drop('stale'); }
    }
    if (q.length === 0) return;
    if (this._callGate()) return;                 // still blocked; wait or expire
    q.sort((a, b) => b.priority - a.priority);
    const next = q.shift();
    this._trigger(next.name, next.data, true);
  }

  /* ------------------------------------------------------------- detection -- */

  /**
   * Read the world and raise the moments. Every API used here was grepped:
   *   powerups.activeFor(hole)      gameplay/powerups.js:598
   *   powerups.baseRadius(hole)     gameplay/powerups.js:931
   *   heat.tierOf(hole)             gameplay/heat.js:524
   *   layout.zoo {x,z,w,d}          world/cityLayout.js:1426 (zRect)
   *   events.events.active()        gameplay/cityEvents.js:768 via eventGlue.js:302
   *   match.stats.biggestMealScore  game.js:339
   */
  _detect(ctx) {
    const player = ctx.player;
    if (!player || player.alive === false) return;
    const seen = this._seen;

    /* --- radius, the input half the ambient gate depends on ------------- */
    /* baseRadius() strips Mass Surge's ~15% inflation. game.js:1681 does the
       same thing for the tier chime, and for the same reason: a surge that
       grazes a threshold would otherwise SPEND the moment. */
    let r = Number(player.radius);
    const pu = ctx.powerups;
    if (pu && isFn(pu.baseRadius)) {
      const br = Number(pu.baseRadius(player));
      if (Number.isFinite(br) && br > 0) r = br;
    }
    if (Number.isFinite(r)) seen.radius = r;

    /* --- grew-large ------------------------------------------------------
       ONE MOMENT PER GROWTH SPURT, NOT ONE PER THRESHOLD. A respawn or a big
       swallow can jump two tiers between frames; marking only the lowest and
       raising the rest on the following frames produced a second "you got
       big" moment one frame after the first, about the same growth. Every
       crossed threshold is consumed here and the HIGHEST one is the moment. */
    let crossed = 0;
    for (const thr of GROWTH_THRESHOLDS) {
      if (seen.radius >= thr && !seen.grew.has(thr)) {
        seen.grew.add(thr);
        if (thr > crossed) crossed = thr;
      }
    }
    if (crossed > 0) {
      this._trigger('grew-large', { radius: +seen.radius.toFixed(2), threshold: crossed }, false);
    }

    /* --- high-score ------------------------------------------------------ */
    const score = Number(player.score);
    if (Number.isFinite(score)) {
      if (score > (this._peakScore || 0)) this._peakScore = score;
      if (!seen.bestFired && seen.bestBase > 0 && score > seen.bestBase) {
        seen.bestFired = true;
        this._trigger('high-score', { score, previous: seen.bestBase }, false);
      }
    }

    /* --- heat-up (tier transition, upward only) -------------------------- */
    const heat = ctx.heat;
    if (heat && isFn(heat.tierOf)) {
      const tier = Number(heat.tierOf(player)) || 0;
      if (tier > seen.heatTier) {
        seen.heatTier = tier;
        this._trigger('heat-up', { tier }, false);
      } else if (tier < seen.heatTier) {
        seen.heatTier = tier;         // cooled off; re-arm without a moment
      }
    }

    /* --- powerup activation --------------------------------------------- */
    if (pu && isFn(pu.activeFor)) {
      let live = null;
      try { live = pu.activeFor(player); } catch { live = null; }
      if (Array.isArray(live)) {
        const now = new Set();
        for (const p of live) { if (p && p.id) now.add(p.id); }
        for (const id of now) {
          if (!seen.powerups.has(id)) {
            const def = live.find((p) => p && p.id === id);
            this._trigger('powerup', { id, name: def ? def.name : id }, false);
            break;                    // one per frame, never a burst
          }
        }
        seen.powerups = now;
      }
    }

    /* --- entered-zoo ------------------------------------------------------ */
    const zoo = ctx.layout && ctx.layout.zoo;
    if (zoo && Number.isFinite(zoo.x) && Number.isFinite(zoo.w)) {
      const inset = this.T.ZOO_INSET;
      const hw = Math.max(0, zoo.w / 2 - inset);
      const hd = Math.max(0, zoo.d / 2 - inset);
      const px = player.position ? player.position.x : NaN;
      const pz = player.position ? player.position.z : NaN;
      const inside = Number.isFinite(px) && Number.isFinite(pz)
        && Math.abs(px - zoo.x) <= hw && Math.abs(pz - zoo.z) <= hd;
      if (inside && !seen.inZoo) this._trigger('entered-zoo', { name: zoo.name || 'zoo' }, false);
      seen.inZoo = inside;
    }

    /* --- storm-near ------------------------------------------------------- */
    const em = this._eventManager(ctx.events);
    if (em) {
      let ev = null;
      try { ev = em.active(); } catch { ev = null; }
      if (!ev) {
        seen.eventId = null;
      } else if (ev.id !== seen.eventId) {
        const m = ev.marker;
        let near = true;
        if (m && Number.isFinite(m.x) && Number.isFinite(m.r) && player.position) {
          const dx = player.position.x - m.x;
          const dz = player.position.z - m.z;
          near = Math.hypot(dx, dz) <= m.r + this.T.STORM_NEAR_PAD;
        }
        if (near) {
          seen.eventId = ev.id;
          this._trigger('storm-near', { event: ev.id, name: ev.name || null, phase: ev.phase || null }, false);
        }
      }
    }

    /* --- ate-car / ate-building, ctx-only fallback ------------------------
       noteSwallow() is the exact path and install() wires it. This is the
       belt: match.stats.biggestMealScore is a running MAXIMUM (game.js:339),
       so a crossing fires at most once and cannot storm. */
    const st = ctx.match && ctx.match.stats;
    if (st && Number.isFinite(st.biggestMealScore)) {
      const was = seen.biggestMeal;
      const now = st.biggestMealScore;
      if (now > was) {
        seen.biggestMeal = now;
        if (was < TIER.MASSIVE.score && now >= TIER.MASSIVE.score) {
          this._trigger('ate-building', { label: st.biggestMeal || null, score: now }, false);
        } else if (was < TIER.LARGE.score && now >= TIER.LARGE.score) {
          this._trigger('ate-car', { label: st.biggestMeal || null, score: now }, false);
        }
      }
    }
  }

  /** ctx.events may be the EventGlue or the EventManager itself. */
  _eventManager(events) {
    if (!events) return null;
    if (isFn(events.active)) return events;
    if (events.events && isFn(events.events.active)) return events.events;
    return null;
  }

  /**
   * Exact ate-car / ate-building, from the real swallow event.
   *
   * Kind matching mirrors game.js's `_voiceFor` (game.js:312) so the phone and
   * the NPCs agree on what a car is. Buildings are read off the TIER id rather
   * than a label regex: TIER.MASSIVE is literally "Buildings" (config.js:245).
   */
  noteSwallow(hole, c) {
    if (!hole || !hole.isPlayer || !c) return;
    const tierId = c.tier && Number.isFinite(c.tier.id) ? c.tier.id : -1;
    const kind = `${c.kind || ''} ${c.label || ''}`;
    if (tierId >= TIER.MASSIVE.id || /building|tower|storefront|hotel|condo/i.test(kind)) {
      this.trigger('ate-building', { label: c.label || c.kind || null, tier: tierId });
      return;
    }
    if (/\b(car|sedan|suv|taxi|van|truck|bus|pickup|coupe|cruiser|convertible|police)\b/i.test(kind)
      || (tierId >= TIER.LARGE.id && tierId < TIER.HUGE.id)) {
      this.trigger('ate-car', { label: c.label || c.kind || null, tier: tierId });
    }
  }

  /* ------------------------------------------------------------ multiplayer -- */

  /**
   * Everything a peer needs to make the SAME next decision.
   *
   * Includes the rng cursor, which is why the internal stream is a pure
   * function of (seed, cursor) rather than a closure: an opaque rng cannot be
   * rewound, and a phone that agrees on every cooldown but disagrees on the
   * draw is a phone that desynchronises on the first choice.
   */
  serialize() {
    const c = this._call;
    return {
      v: 1,
      t: +this.time.toFixed(3),
      matchT: +this._matchT.toFixed(3),
      seed: this._seed,
      cursor: this._cursor,
      calls: this._callsThisMatch,
      texts: this._textsThisMatch,
      matureUsed: this._matureThisMatch,
      lastCallStart: this._lastCallStart,
      lastCallEnd: this._lastCallEnd,
      lastTextAt: this._lastTextAt,
      lastMatureAt: this._lastMatureAt,
      peakScore: this._peakScore || 0,
      sessionBest: this._sessionBest || 0,
      cdCaller: Object.fromEntries(this._cdCaller),
      cdCallerText: Object.fromEntries(this._cdCallerText),
      cdLine: Object.fromEntries(this._cdLine),
      cdTrigger: Object.fromEntries(this._cdTrigger),
      seen: {
        radius: this._seen.radius,
        grew: [...this._seen.grew],
        heatTier: this._seen.heatTier,
        powerups: [...this._seen.powerups],
        inZoo: this._seen.inZoo,
        eventId: this._seen.eventId,
        bestBase: this._seen.bestBase,
        bestFired: this._seen.bestFired,
        biggestMeal: this._seen.biggestMeal,
        phase: this._seen.phase,
      },
      active: c ? {
        id: c.id, state: c.state, callerId: c.callerId, lineId: c.lineId,
        trigger: c.trigger, mature: c.mature, startedAt: c.startedAt,
        ringUntil: c.ringUntil, connectedAt: c.connectedAt, endsAt: c.endsAt,
      } : null,
    };
  }

  /**
   * Restore. Any live call is torn down first, audio and all.
   *
   * A CONNECTED call restored from a snapshot comes back CAPTION-ONLY: the
   * remaining seconds are honoured but no element is started. Re-starting
   * audio from the middle of a line would play the first two seconds over
   * again, and a snapshot is not a seek.
   */
  applyState(s) {
    if (!s || typeof s !== 'object') return this;
    const wasCall = this._call;
    if (wasCall) this._stopAudio(wasCall);
    this._call = null;
    this._queue.length = 0;

    this.time = num(Number(s.t), this.time);
    this._matchT = num(Number(s.matchT), 0);
    if (Number.isFinite(s.seed)) this._seed = s.seed >>> 0;
    this._cursor = num(Number(s.cursor), 0) | 0;
    this._callsThisMatch = num(Number(s.calls), 0);
    this._textsThisMatch = num(Number(s.texts), 0);
    this._matureThisMatch = num(Number(s.matureUsed), 0);
    this._lastCallStart = num(Number(s.lastCallStart), -1e6);
    this._lastCallEnd = num(Number(s.lastCallEnd), -1e6);
    this._lastTextAt = num(Number(s.lastTextAt), -1e6);
    this._lastMatureAt = num(Number(s.lastMatureAt), -1e6);
    this._peakScore = num(Number(s.peakScore), 0);
    this._sessionBest = num(Number(s.sessionBest), 0);

    const load = (map, obj) => {
      map.clear();
      if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) if (Number.isFinite(v)) map.set(k, v);
      }
    };
    load(this._cdCaller, s.cdCaller);
    load(this._cdCallerText, s.cdCallerText);
    load(this._cdLine, s.cdLine);
    load(this._cdTrigger, s.cdTrigger);

    const seen = this._freshSeen();
    const ss = s.seen || {};
    seen.radius = num(Number(ss.radius), 0);
    seen.grew = new Set(Array.isArray(ss.grew) ? ss.grew : []);
    seen.heatTier = num(Number(ss.heatTier), 0);
    seen.powerups = new Set(Array.isArray(ss.powerups) ? ss.powerups : []);
    seen.inZoo = !!ss.inZoo;
    seen.eventId = ss.eventId ?? null;
    seen.bestBase = num(Number(ss.bestBase), 0);
    seen.bestFired = !!ss.bestFired;
    seen.biggestMeal = num(Number(ss.biggestMeal), 0);
    seen.phase = typeof ss.phase === 'string' ? ss.phase : null;
    this._seen = seen;

    if (s.active && this.library.callers.has(s.active.callerId)) {
      const caller = this.library.callers.get(s.active.callerId);
      const line = this.library.all.find((l) => l.id === s.active.lineId);
      this._call = {
        id: s.active.id, kind: KIND.CALL, state: s.active.state,
        trigger: s.active.trigger, data: null,
        lineId: s.active.lineId, text: line ? line.text : '',
        mature: !!s.active.mature,
        callerId: caller.id, callerName: caller.name, callerRole: caller.role,
        color: caller.color, avatar: caller.avatar,
        startedAt: num(Number(s.active.startedAt), this.time),
        ringUntil: num(Number(s.active.ringUntil), this.time + this.T.RING_SECONDS),
        connectedAt: num(Number(s.active.connectedAt), 0),
        endsAt: num(Number(s.active.endsAt), this.time + this.T.CALL_MIN_SECONDS),
        endedAt: 0, minimized: false, spoken: false, el: null,
        gen: this._gen, read: s.active.state === CALL_STATE.CONNECTED,
      };
    }
    return this;
  }
}

/* Fields the constructor does not set because they are only ever numbers with
   a natural zero. Declared here so they are never `undefined` in arithmetic —
   `undefined > 0` is false but `undefined + 1` is NaN, and NaN in a threshold
   is the silent-failure shape this project keeps hitting. */
PhoneSystem.prototype._peakScore = 0;
PhoneSystem.prototype._sessionBest = 0;

/* ========================================================================== */
/* INSTALL                                                                    */
/* ========================================================================== */

/**
 * Wire a PhoneSystem into a live Game.
 *
 * WHAT IT WRAPS, and it edits no file to do it. An instance property shadows
 * the prototype method, and Game.frame() calls `this.stepSimulation(dt)`, so
 * the wrapper is what runs — the same idiom eventGlue.install() documents at
 * eventGlue.js:389.
 *
 *   stepSimulation  -> run the real step, THEN phone.update(dt, ctx). After,
 *                      so heat/powerups/events have already advanced this
 *                      frame and the tier the phone reads is the current one.
 *   resetWorld      -> phone.clearAll(). No call survives a restart.
 *   consume.onSwallow -> phone.noteSwallow(). WRAPPED, NEVER REPLACED: that
 *                      callback already carries _voiceFor, the net report, the
 *                      kill feed, the occlusion re-arm, match stats and the
 *                      challenge tracker.
 *
 * Idempotent: a second install replaces the first rather than stacking two
 * wrappers on the same game.
 *
 * @param {object} game
 * @param {object} [deps] merged over the defaults; `lines` is the callers module
 * @returns {PhoneSystem|null}
 */
export function install(game, deps = {}) {
  if (!game) {
    if (typeof console !== 'undefined' && console.error) console.error('[phone] install(game) needs a Game');
    return null;
  }
  const prev = game.phone;
  if (prev && isFn(prev.uninstall)) { try { prev.uninstall(); } catch { /* noop */ } }

  const hud = deps.hud || game.hud || null;

  const phone = new PhoneSystem({
    /* NOT game.rng. That is the city stream and every client in a room walks
       it in lockstep; taking one draw from it here shifts every later draw for
       everybody, which is a desync with no symptom until two players are
       standing in different places (eventGlue.js:370). A seed derived from the
       world seed gives the same determinism without touching it. */
    seed: ((game.worldSeed ?? 0) ^ 0x50484f4e) >>> 0,
    audio: deps.audio || game.audio || null,
    voice: deps.voice || game.voice || null,
    hud,
    lines: deps.lines || game.phoneLines || null,
    onCall: deps.onCall || null,
    onText: deps.onText || null,
    onCaption: deps.onCaption || null,
    getMature: deps.getMature || null,
    /* The element path bypasses voiceBus AND the master gain, so it has to read
       the mix itself. hud.audioPrefs() is verified at hud.js:1728 and returns
       { master, music, sfx, voice, muted, voicesMuted, subtitles }. */
    getVolume: deps.getVolume || (() => {
      if (!hud || !isFn(hud.audioPrefs)) return 1;
      const p = hud.audioPrefs();
      const m = Number(p && p.master);
      const v = Number(p && p.voice);
      return (Number.isFinite(m) ? m : 1) * (Number.isFinite(v) ? v : 1);
    }),
    getMuted: deps.getMuted || (() => {
      if (!hud || !isFn(hud.audioPrefs)) return false;
      const p = hud.audioPrefs();
      return !!(p && (p.muted || p.voicesMuted));
    }),
    getBestScore: deps.getBestScore || null,
    tuning: deps.tuning || null,
    triggers: deps.triggers || null,
  });

  /* --- the three seams -------------------------------------------------- */
  const prevStep = game.stepSimulation;
  const step = game.stepSimulation.bind(game);
  let crashes = 0;
  game.stepSimulation = (dt) => {
    step(dt);
    if (crashes >= 3) return;
    try {
      phone.update(dt, {
        player: game.player,
        match: game.match,
        heat: game.events ? game.events.heat : null,   // eventGlue.js:319
        powerups: game.powerups,                       // game.js:391 (PowerupSystem)
        events: game.events,
        layout: game.layout,
      });
      crashes = 0;
    } catch (err) {
      crashes++;
      if (typeof console !== 'undefined' && console.error) console.error('[phone] update failed', err);
      try { phone.clearAll(); } catch { /* noop */ }
      if (crashes >= 3 && console && console.error) console.error('[phone] disarmed after 3 failures');
    }
  };

  const prevReset = game.resetWorld;
  const reset = game.resetWorld.bind(game);
  game.resetWorld = () => { try { phone.clearAll(); } catch { /* noop */ } return reset(); };

  let prevSwallow = null;
  if (game.consume) {
    prevSwallow = game.consume.onSwallow;
    game.consume.onSwallow = (hole, c, gained, remote) => {
      if (prevSwallow) prevSwallow(hole, c, gained, remote);
      if (!remote) { try { phone.noteSwallow(hole, c); } catch { /* noop */ } }
    };
  }

  phone.uninstall = () => {
    game.stepSimulation = prevStep;
    game.resetWorld = prevReset;
    if (game.consume) game.consume.onSwallow = prevSwallow;
    phone.dispose();
    if (game.phone === phone) game.phone = null;
  };

  game.phone = phone;
  return phone;
}

export default install;

/* ========================================================================== */
/* SELF TEST                                                                  */
/* ========================================================================== */

/** A clean, entirely fictional library used by the tests below. */
function testLibrary(extra = []) {
  return {
    CALLERS: [
      { id: 'rue-castellan', name: 'Rue Castellan', role: 'salvage broker', color: '#ffd166', cooldown: 75 },
      { id: 'boz-halloran', name: 'Boz Halloran', role: 'tow yard night shift', color: '#7ee0c2', cooldown: 75 },
      { id: 'nell-arbo', name: 'Nell Arbo', role: 'pirate radio host', color: '#c084fc', cooldown: 75 },
    ],
    PHONE_LINES: {
      'grew-large': [
        { id: 'grew-large-rue-1', caller: 'rue-castellan', text: 'You are the size of a bus stop now. Slow down.' },
        { id: 'grew-large-boz-1', caller: 'boz-halloran', text: 'The yard cameras just lost the whole west lot.' },
      ],
      'ate-building': [
        { id: 'ate-building-rue-1', caller: 'rue-castellan', text: 'That was a whole storefront. I am not insuring that.' },
        { id: 'ate-building-nell-1', caller: 'nell-arbo', text: 'Caller says a building went down the drain. Confirm?' },
        { id: 'ate-building-nell-2', caller: 'nell-arbo', text: 'Damn, the whole block just folded up.', mature: true },
      ],
      'ate-car': [
        { id: 'ate-car-boz-1', caller: 'boz-halloran', text: 'Tell me that was not the flatbed.', kind: 'text' },
        { id: 'ate-car-rue-1', caller: 'rue-castellan', text: 'A sedan. Lovely. Send me the plates.', kind: 'text' },
      ],
      'heat-up': [
        { id: 'heat-up-nell-1', caller: 'nell-arbo', text: 'Response units are moving your way. Two of them.' },
        { id: 'heat-up-boz-1', caller: 'boz-halloran', text: 'Whatever you did, they noticed. Get off the avenue.' },
      ],
      ...Object.fromEntries(extra.map((e) => [e.trigger, [e]])),
    },
  };
}

export function __selftest() {
  const results = [];
  let failed = 0;
  const ok = (name, cond, detail = '') => {
    results.push({ name, pass: !!cond, detail: cond ? '' : String(detail) });
    if (!cond) failed++;
  };
  const quiet = (fn) => {
    const c = globalThis.console;
    globalThis.console = { log() {}, info() {}, warn() {}, error() {} };
    try { return fn(); } finally { globalThis.console = c; }
  };

  /* ---- 1. the denylist actually denies -------------------------------- */
  {
    const bad = [
      ['sexual content', 'Come over, I want to talk about porn.'],
      ['threat', 'I will kill you when I find you.'],
      ['real agency', 'This is the FBI, pull over now.'],
      ['real brand', 'Meet me behind the McDonalds on Fifth.'],
      ['social handle', 'Message me @nellarbo when you land.'],
      ['emergency number', 'Just call 911 and let them handle it.'],
      ['hate', 'They should deport all immigrants from this block.'],
      ['dehumanising', 'Immigrants are vermin and everybody knows it.'],
      ['markup', 'Look at <b>that</b> hole go.'],
      ['style of', 'Say it in the style of a famous announcer.'],
    ];
    let caught = 0;
    const missed = [];
    for (const [label, text] of bad) {
      if (screenText(text, 'text')) caught++;
      else missed.push(label);
    }
    ok('denylist catches every seeded violation', caught === bad.length, `missed: ${missed.join(', ')}`);
  }

  /* ---- 2. and does not deny ordinary English --------------------------- */
  {
    const good = [
      'The raccoon on the seawall is watching you eat a bench.',
      'I ran the numbers and the tow yard is basically a cocoon of paperwork.',
      'She flew to Pakistan last spring and still talks about it.',
      'Put some spice on it, the whole block smells like dinner.',
      'Three women and two men just ran out of the arcade.',
      'The immigrant families on Ninth are the only ones still open.',
      'Damn, that was close. Watch the crane.',
      'Black cars, white cars, all of them gone in one gulp.',
    ];
    const tripped = [];
    for (const g of good) {
      const hit = screenText(g, 'text');
      if (hit) tripped.push(`${hit.id}: ${g.slice(0, 30)}`);
    }
    ok('denylist has no false positives on ordinary lines', tripped.length === 0, tripped.join(' | '));
  }

  /* ---- 3. validateLines throws, and lists every error ------------------ */
  {
    let threw = null;
    try {
      quiet(() => validateLines({
        CALLERS: [{ id: 'nell-arbo', name: 'Nell Arbo', role: 'host', color: '#c084fc' }],
        PHONE_LINES: { 'heat-up': [
          { id: 'heat-up-bad-1', caller: 'nell-arbo', text: 'This is the FBI, stop the vehicle.' },
          { id: 'heat-up-bad-2', caller: 'nell-arbo', text: 'Call 911 right now.' },
        ] },
      }));
    } catch (e) { threw = e; }
    ok('validateLines throws on a policy violation', threw instanceof PhoneContentError, String(threw));
    ok('validateLines reports every violation, not the first',
      threw && threw.errors.length >= 2, threw ? `${threw.errors.length}` : 'no throw');
  }

  /* ---- 4. a clean fictional library passes ----------------------------- */
  {
    let rep = null, err = null;
    try { rep = quiet(() => validateLines(testLibrary())); } catch (e) { err = e; }
    ok('a clean fictional library validates', rep && rep.ok, err ? err.message : 'not ok');
  }

  /* ---- 5. strong language must be flagged mature ----------------------- */
  {
    const lib = {
      CALLERS: [{ id: 'boz-halloran', name: 'Boz Halloran', role: 'tow yard', color: '#7ee0c2' }],
      PHONE_LINES: { 'heat-up': [
        { id: 'heat-up-boz-9', caller: 'boz-halloran', text: 'They are on the avenue, get moving.' },
        { id: 'heat-up-boz-8', caller: 'boz-halloran', text: 'That is complete bullshit and you know it.' },
      ] },
    };
    const r = quiet(() => validateLines(lib, { throwOnError: false }));
    ok('unflagged strong language is a validation error',
      !r.ok && r.errors.some((e) => /not flagged mature/.test(e)), r.errors.join(' | '));

    lib.PHONE_LINES['heat-up'][1].mature = true;
    const r2 = quiet(() => validateLines(lib, { throwOnError: false }));
    ok('the same line passes once it is flagged mature', r2.ok, r2.errors.join(' | '));
  }

  /* ---- 6. a trigger whose lines are all mature is a dead trigger -------- */
  {
    const r = quiet(() => validateLines({
      CALLERS: [{ id: 'nell-arbo', name: 'Nell Arbo', role: 'host', color: '#c084fc' }],
      PHONE_LINES: { 'heat-up': [
        { id: 'heat-up-only-1', caller: 'nell-arbo', text: 'This whole thing is a damn mess.', mature: true },
      ] },
    }, { throwOnError: false }));
    ok('an all-mature trigger is rejected (dead with the default-off setting)',
      !r.ok && r.errors.some((e) => /ALL of them are mature/.test(e)), r.errors.join(' | '));
  }

  /* ---- 7. MATURE OFF: a mature line is never SELECTED ------------------- */
  {
    const p = quiet(() => new PhoneSystem({ lines: testLibrary(), seed: 11 }));
    let mature = 0, picks = 0;
    for (let i = 0; i < 500; i++) {
      const line = p._selectLine('ate-building', KIND.CALL, p._matureAllowed(TRIGGERS['ate-building']));
      if (line) { picks++; if (line.mature) mature++; }
    }
    ok('mature OFF selects a line', picks === 500, `${picks}`);
    ok('mature OFF never selects a mature line in 500 draws', mature === 0, `${mature} leaked`);
    ok('matureEnabled() defaults to false', p.matureEnabled() === false);
  }

  /* ---- 8. MATURE ON: eligible, but rare and only on big moments --------- */
  {
    const p = quiet(() => new PhoneSystem({ lines: testLibrary(), seed: 3, getMature: () => true }));
    ok('mature is refused on a non-big trigger even when ON',
      p._matureAllowed(TRIGGERS['ate-car']) === false);
    let allowed = 0;
    for (let i = 0; i < 400; i++) if (p._matureAllowed(TRIGGERS['ate-building'])) allowed++;
    /* The budget and the gap are not advanced here (nothing is consumed), so
       this measures the CHANCE gate alone: it must be a roll, not a yes. */
    ok('mature is a chance, not a guarantee', allowed > 0 && allowed < 400, `${allowed}/400`);

    const q = quiet(() => new PhoneSystem({ lines: testLibrary(), seed: 3, getMature: () => true }));
    q._seen.phase = 'playing';
    q._matchT = 999;
    let used = 0;
    for (let i = 0; i < 40; i++) {
      q.time += 30;
      q._lastCallStart = -1e6; q._lastCallEnd = -1e6; q._callsThisMatch = 0;
      q._cdTrigger.clear(); q._cdCaller.clear(); q._cdLine.clear();
      if (q._call) { q._call = null; }
      q.trigger('ate-building');
      if (q._call && q._call.mature) used++;
    }
    ok('mature never exceeds MATURE_MAX_PER_MATCH', used <= PHONE_TUNING.MATURE_MAX_PER_MATCH, `${used}`);
  }

  /* ---- 9. ONE ACTIVE CALL, EVER ---------------------------------------- */
  {
    const p = quiet(() => new PhoneSystem({ lines: testLibrary(), seed: 5 }));
    p._seen.phase = 'playing';
    p._matchT = 999;
    p._seen.radius = 20;
    const first = p.trigger('ate-building');
    const second = p.trigger('heat-up');
    ok('the first moment rings', first === true);
    ok('a second moment cannot start a second call', second === false || p.stats.calls === 1, `calls=${p.stats.calls}`);
    ok('active() returns exactly one call', p.active() && p.active().id, 'no active call');
    ok('a blocked call is recorded as call-active', (p.stats.dropped['call-active'] || 0) >= 1,
      JSON.stringify(p.stats.dropped));
  }

  /* ---- 10. a ringing call times out politely into a missed call --------- */
  {
    const p = quiet(() => new PhoneSystem({ lines: testLibrary(), seed: 7 }));
    p._seen.phase = 'playing'; p._matchT = 999; p._seen.radius = 20;
    p.trigger('ate-building');
    const id = p.active() && p.active().id;
    for (let i = 0; i < 700; i++) p.update(1 / 60, null);   // 11.7 s
    ok('an unanswered call rings out', p.active() === null);
    ok('and lands in history as MISSED',
      p.history()[0] && p.history()[0].state === CALL_STATE.MISSED && p.history()[0].id === id,
      JSON.stringify(p.history()[0] || null));
    ok('the missed call is counted', p.stats.missed === 1, `${p.stats.missed}`);
  }

  /* ---- 11. the global gap and the per-caller cooldown both bite --------- */
  {
    const p = quiet(() => new PhoneSystem({ lines: testLibrary(), seed: 9 }));
    p._seen.phase = 'playing'; p._matchT = 999; p._seen.radius = 20;
    p.trigger('ate-building');
    p.hangup();
    p.time += 5;
    ok('no second call inside POST_CALL_QUIET', p.trigger('heat-up') === false);
    p.time += PHONE_TUNING.POST_CALL_QUIET;
    ok('still no second call inside GLOBAL_CALL_GAP', p.trigger('heat-up') === false);
    p.time += PHONE_TUNING.GLOBAL_CALL_GAP;
    ok('a call is allowed once both windows have passed', p.trigger('heat-up') === true,
      JSON.stringify(p.stats.dropped));
  }

  /* ---- 12. the per-match call budget is a hard cap ---------------------- */
  {
    const p = quiet(() => new PhoneSystem({ lines: testLibrary(), seed: 13 }));
    p._seen.phase = 'playing'; p._matchT = 999; p._seen.radius = 20;
    for (let i = 0; i < 20; i++) {
      p.time += PHONE_TUNING.GLOBAL_CALL_GAP + PHONE_TUNING.POST_CALL_QUIET + 1;
      p._cdTrigger.clear(); p._cdCaller.clear(); p._cdLine.clear();
      if (p.active()) p.hangup();
      p.trigger('ate-building');
    }
    ok('never more than MAX_CALLS_PER_MATCH calls',
      p.stats.calls <= PHONE_TUNING.MAX_CALLS_PER_MATCH, `${p.stats.calls}`);
  }

  /* ---- 13. nobody calls about a bench ----------------------------------- */
  {
    const p = quiet(() => new PhoneSystem({ lines: testLibrary(), seed: 17 }));
    p._seen.phase = 'playing';
    p._matchT = 5;                       // early
    p._seen.radius = 2.0;                // start radius
    ok('an ambient moment is refused while small and early', p.trigger('ate-car') === false);
    ok('and the reason is recorded', (p.stats.dropped['ambient-early'] || 0) >= 1,
      JSON.stringify(p.stats.dropped));
    p._matchT = 999;
    ok('still refused while the hole is small', p.trigger('ate-car') === false);
    ok('the small-hole rejection is recorded', (p.stats.dropped['ambient-small'] || 0) >= 1,
      JSON.stringify(p.stats.dropped));
    p._seen.radius = 12;
    ok('and allowed once the hole is eating cars', p.trigger('ate-car') === true,
      JSON.stringify(p.stats.dropped));
  }

  /* ---- 14. nothing rings during the warmup ------------------------------ */
  {
    const p = quiet(() => new PhoneSystem({ lines: testLibrary(), seed: 19 }));
    p._seen.phase = 'playing'; p._matchT = 4; p._seen.radius = 30;
    ok('no call inside WARMUP', p.trigger('ate-building') === false);
    ok('warmup rejection recorded', (p.stats.dropped['call-warmup'] || 0) >= 1,
      JSON.stringify(p.stats.dropped));
  }

  /* ---- 15. clearAll leaves no residue ----------------------------------- */
  {
    const stops = [];
    const RealAudio = globalThis.Audio;
    globalThis.Audio = function FakeAudio() {
      this.volume = 1; this.duration = NaN; this.src = 'x';
      this.addEventListener = () => {};
      this.play = () => Promise.resolve();
      this.pause = () => stops.push('pause');
    };
    const p = quiet(() => new PhoneSystem({ lines: testLibrary(), seed: 23 }));
    p._manifest.set('ate-building-rue-1', 'blob:fake');
    p._manifest.set('ate-building-nell-1', 'blob:fake');
    p._seen.phase = 'playing'; p._matchT = 999; p._seen.radius = 20;
    p.trigger('ate-building');
    p.answer();
    const hadEl = !!(p._call && p._call.el);
    p.clearAll();
    globalThis.Audio = RealAudio;
    ok('an answered call holds an element', hadEl);
    ok('clearAll stops the audio', stops.length >= 1, `${stops.length}`);
    ok('clearAll leaves no active call', p.active() === null);
    ok('clearAll empties the queue', p._queue.length === 0);
    ok('clearAll resets the per-match budgets',
      p._callsThisMatch === 0 && p._textsThisMatch === 0 && p._matureThisMatch === 0);
    ok('the cleared call is still in history', p.history().length >= 1);
  }

  /* ---- 16. the audio path is the ELEMENT path, measured ----------------- */
  {
    const made = [];
    const played = [];
    const RealAudio = globalThis.Audio;
    globalThis.Audio = function FakeAudio(url) {
      made.push(url);
      this.volume = 1; this.duration = 2.5;
      this.addEventListener = () => {};
      this.play = () => { played.push(url); return Promise.resolve(); };
      this.pause = () => {};
    };
    const p = quiet(() => new PhoneSystem({
      lines: testLibrary(), seed: 29, getVolume: () => 0.8, getMuted: () => false,
    }));
    p._manifest.set('ate-building-rue-1', 'https://x/a.mp3');
    p._manifest.set('ate-building-nell-1', 'https://x/b.mp3');
    p._seen.phase = 'playing'; p._matchT = 999; p._seen.radius = 20;
    p.trigger('ate-building');
    p.answer();
    const vol = p._call ? p._call.el.volume : NaN;
    globalThis.Audio = RealAudio;
    ok('answering constructs exactly one HTMLAudioElement', made.length === 1, JSON.stringify(made));
    ok('and calls play() on it', played.length === 1, JSON.stringify(played));
    ok('the element volume is a finite number, never NaN',
      Number.isFinite(vol) && vol > 0 && vol <= 1, String(vol));
    ok('the level is master*voice*EL_TRIM',
      Math.abs(vol - 0.8 * PHONE_TUNING.EL_TRIM) < 1e-9, String(vol));
  }

  /* ---- 17. a NaN volume source cannot produce a NaN element volume ------ */
  {
    const RealAudio = globalThis.Audio;
    let seen = null;
    globalThis.Audio = function FakeAudio() {
      this.volume = 1; this.duration = 1;
      this.addEventListener = () => {};
      this.play = () => Promise.resolve();
      this.pause = () => {};
    };
    const p = quiet(() => new PhoneSystem({
      lines: testLibrary(), seed: 31, getVolume: () => undefined,
    }));
    p._manifest.set('ate-building-rue-1', 'https://x/a.mp3');
    p._manifest.set('ate-building-nell-1', 'https://x/b.mp3');
    p._seen.phase = 'playing'; p._matchT = 999; p._seen.radius = 20;
    p.trigger('ate-building');
    p.answer();
    seen = p._call ? p._call.el.volume : NaN;
    globalThis.Audio = RealAudio;
    ok('an undefined volume dep still yields a finite element volume',
      Number.isFinite(seen) && seen > 0, String(seen));
  }

  /* ---- 18. captions carry the voice.js shape ---------------------------- */
  {
    const caps = [];
    const p = quiet(() => new PhoneSystem({
      lines: testLibrary(), seed: 37, onCaption: (c) => caps.push(c),
    }));
    p._seen.phase = 'playing'; p._matchT = 999; p._seen.radius = 20;
    p.trigger('ate-building');
    p.answer();
    const c = caps[0];
    ok('answering emits a caption', !!c);
    ok('the caption has the fields hud.showCaption reads',
      c && typeof c.text === 'string' && typeof c.castName === 'string' && c.ttl > 0,
      JSON.stringify(c || null));
    ok('a caption-only call is marked unspoken', c && c.spoken === false);
  }

  /* ---- 19. update() never writes to ctx --------------------------------- */
  {
    const p = quiet(() => new PhoneSystem({ lines: testLibrary(), seed: 41 }));
    const ctx = {
      player: { alive: true, radius: 14, score: 5000, position: { x: 10, y: 0, z: -20 } },
      match: { phase: 'playing', stats: { biggestMealScore: 1200, biggestMeal: 'Tower' } },
      heat: { tierOf: () => 2 },
      powerups: { activeFor: () => [{ id: 'turbo', name: 'TURBO' }], baseRadius: (h) => h.radius },
      events: { events: { active: () => null } },
      layout: { zoo: { x: 0, z: 0, w: 100, d: 100, name: 'Metrozoo' } },
    };
    const before = JSON.stringify(ctx);
    for (let i = 0; i < 400; i++) p.update(1 / 60, ctx);
    ok('ctx is byte-identical after 400 frames', JSON.stringify(ctx) === before);
    ok('the detectors did raise moments', p.stats.moments > 0, `${p.stats.moments}`);
  }

  /* ---- 20. the detectors fire on the real shapes ------------------------ */
  {
    const p = quiet(() => new PhoneSystem({ lines: testLibrary(), seed: 43 }));
    const player = { alive: true, radius: 2, score: 10, position: { x: 500, y: 0, z: 500 } };
    const ctx = {
      player,
      match: { phase: 'playing', stats: { biggestMealScore: 0, biggestMeal: null } },
      heat: { tierOf: () => 0 },
      powerups: null,
      events: null,
      layout: { zoo: { x: 0, z: 0, w: 200, d: 200 } },
    };
    p.update(0.016, ctx);
    ok('a 2 m hole raises no growth moment', p.stats.moments === 0, `${p.stats.moments}`);
    player.radius = 9;                    // jumps BOTH 5.2 and 8.2 in one frame
    p.update(0.016, ctx);
    ok('crossing TIER.LARGE raises grew-large', p.stats.moments === 1, `${p.stats.moments}`);
    const before = p.stats.moments;
    p.update(0.016, ctx);
    p.update(0.016, ctx);
    ok('a two-tier jump is ONE moment, not one per threshold',
      p.stats.moments === before, `${p.stats.moments}`);

    player.position.x = 0; player.position.z = 0;
    p.update(0.016, ctx);
    ok('entering layout.zoo raises entered-zoo', p.stats.moments > before, `${p.stats.moments}`);

    const t0 = p.stats.moments;
    ctx.heat.tierOf = () => 2;
    p.update(0.016, ctx);
    ok('a heat tier transition raises heat-up', p.stats.moments > t0, `${p.stats.moments}`);
  }

  /* ---- 21. serialize / applyState reproduce the same next decision ------ */
  {
    const mk = () => {
      const p = new PhoneSystem({ lines: testLibrary(), seed: 101 });
      p._seen.phase = 'playing'; p._matchT = 999; p._seen.radius = 20;
      return p;
    };
    const a = quiet(mk);
    a.time = 50;
    a.trigger('ate-building');
    const snap = JSON.parse(JSON.stringify(a.serialize()));
    const b = quiet(mk);
    b.applyState(snap);
    ok('applyState restores the clock and the budgets',
      b.time === a.time && b._callsThisMatch === a._callsThisMatch);
    ok('applyState restores the rng cursor', b._cursor === a._cursor, `${b._cursor} vs ${a._cursor}`);
    ok('applyState restores the live call descriptor',
      b._call && a._call && b._call.lineId === a._call.lineId,
      `${b._call && b._call.lineId} vs ${a._call && a._call.lineId}`);
    /* Advance both identically and check they choose the same line. */
    a.hangup(); b.hangup();
    a.time += 200; b.time += 200;
    a.trigger('heat-up'); b.trigger('heat-up');
    ok('both sides then choose the same line',
      (a._call && a._call.lineId) === (b._call && b._call.lineId),
      `${a._call && a._call.lineId} vs ${b._call && b._call.lineId}`);
  }

  /* ---- 22. a rejected library leaves the phone inert, not half-loaded --- */
  {
    const p = quiet(() => new PhoneSystem({
      lines: {
        CALLERS: [{ id: 'nell-arbo', name: 'Nell Arbo', role: 'host', color: '#c084fc' }],
        PHONE_LINES: { 'heat-up': [
          { id: 'heat-up-ok-1', caller: 'nell-arbo', text: 'They are two blocks out.' },
          { id: 'heat-up-bad-1', caller: 'nell-arbo', text: 'This is the FBI, stop now.' },
        ] },
      },
      seed: 53,
    }));
    ok('a library with one banned line is rejected whole', p.ready() === false);
    ok('and the clean line beside it is NOT kept', p.library.all.length === 0, `${p.library.all.length}`);
    ok('the rejection is readable', !!p.libraryError, 'no libraryError');
    p._seen.phase = 'playing'; p._matchT = 999; p._seen.radius = 20;
    ok('an inert phone never rings', p.trigger('heat-up') === false);
  }

  /* ---- 23. a big moment blocked by a live call downgrades to a text ----- */
  {
    const texts = [];
    const lib = testLibrary();
    lib.PHONE_LINES['heat-up'].push({
      id: 'heat-up-rue-t1', caller: 'rue-castellan', kind: 'text',
      text: 'Cannot talk. They are on your street.',
    });
    const p = quiet(() => new PhoneSystem({ lines: lib, seed: 59, onText: (t) => texts.push(t) }));
    p._seen.phase = 'playing'; p._matchT = 999; p._seen.radius = 20;
    p.trigger('ate-building');
    ok('a call is live', !!p.active());
    p.trigger('heat-up');
    ok('the blocked moment arrives as a text instead', texts.length === 1, `${texts.length}`);
    ok('and it is marked as a downgrade', texts[0] && texts[0].downgraded === true);
    ok('the call was not interrupted', p.active() && p.active().trigger === 'ate-building');
  }

  /* ---- 24. history is a copy the UI cannot corrupt ---------------------- */
  {
    const p = quiet(() => new PhoneSystem({ lines: testLibrary(), seed: 61 }));
    p._seen.phase = 'playing'; p._matchT = 999; p._seen.radius = 20;
    p.trigger('ate-building');
    p.dismiss();
    const h = p.history();
    h[0].text = 'TAMPERED';
    ok('history() hands out a copy', p.history()[0].text !== 'TAMPERED');
    ok('a declined call is recorded as declined', p.history()[0].state === CALL_STATE.DECLINED);
    ok('a declined call counts as read', p.unread() === 0, `${p.unread()}`);

    const q = quiet(() => new PhoneSystem({ lines: testLibrary(), seed: 62 }));
    q._seen.phase = 'playing'; q._matchT = 999; q._seen.radius = 20;
    q.trigger('ate-building');
    for (let i = 0; i < 700; i++) q.update(1 / 60, null);
    ok('a MISSED call stays unread, so the badge means something', q.unread() === 1, `${q.unread()}`);
  }

  /* ---- 25. rarity is decided ONCE, not multiplied by the line weights --- */
  {
    /* REGRESSION GUARD. The shipped callers.js also de-weights its own mature
       lines, so merging the mature and mild pools multiplied two rarity
       systems and produced 0 mature lines in 60 calls with the setting ON.
       Here the mature line is weighted 100x lower than the mild ones: the
       observed rate must still track MATURE_CHANCE, because _matureAllowed is
       the only thing allowed to decide how rare this is. */
    const lib = {
      CALLERS: [{ id: 'nell-arbo', name: 'Nell Arbo', role: 'host', color: '#c084fc' }],
      PHONE_LINES: { 'ate-building': [
        { id: 'ate-building-mild-1', caller: 'nell-arbo', text: 'A building went down the drain.', weight: 100 },
        { id: 'ate-building-mild-2', caller: 'nell-arbo', text: 'Another block folded up.', weight: 100 },
        { id: 'ate-building-mat-1', caller: 'nell-arbo', text: 'That is complete bullshit.', mature: true, weight: 1 },
      ] },
    };
    const p = quiet(() => new PhoneSystem({ lines: lib, seed: 97, getMature: () => true }));
    let mature = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const allow = p._matureAllowed(TRIGGERS['ate-building']);
      const line = allow
        ? (p._selectLine('ate-building', KIND.CALL, true, true) || p._selectLine('ate-building', KIND.CALL, false))
        : p._selectLine('ate-building', KIND.CALL, false);
      if (line && line.mature) mature++;
    }
    const rate = mature / N;
    const want = PHONE_TUNING.MATURE_CHANCE;
    ok('a 100x-de-weighted mature line still lands at ~MATURE_CHANCE',
      Math.abs(rate - want) < 0.05, `observed ${(rate * 100).toFixed(1)}%, want ${(want * 100).toFixed(0)}%`);

    const off = quiet(() => new PhoneSystem({ lines: lib, seed: 97 }));
    let leaked = 0;
    for (let i = 0; i < N; i++) {
      const line = off._selectLine('ate-building', KIND.CALL, off._matureAllowed(TRIGGERS['ate-building']));
      if (line && line.mature) leaked++;
    }
    ok('and with the setting OFF it still never appears', leaked === 0, `${leaked} leaked`);
  }

  /* ---- 26. the ringtone LOOP is stopped on every exit path -------------- */
  {
    /* audio.phoneRing() is a loop returning a handle (audio.js:3556). Every
       way a call can end must stop it, and the MISSED path is the one that
       calls neither phoneAnswer nor phoneHangup. */
    const mkAudio = () => {
      const state = { started: 0, stopped: 0 };
      return [state, {
        phoneRing() { state.started++; return { stop() { state.stopped++; }, active: true }; },
        phoneAnswer() {}, phoneHangup() {}, phoneText() {},
        ui() {},
      }];
    };
    for (const [label, finish] of [
      ['answered', (p) => { p.answer(); p.time += 100; p.update(0.016, null); }],
      ['declined', (p) => p.dismiss()],
      ['missed', (p) => { for (let i = 0; i < 700; i++) p.update(1 / 60, null); }],
      ['cleared', (p) => p.clearAll()],
    ]) {
      const [state, audio] = mkAudio();
      const p = quiet(() => new PhoneSystem({ lines: testLibrary(), seed: 71, audio }));
      p._seen.phase = 'playing'; p._matchT = 999; p._seen.radius = 20;
      p.trigger('ate-building');
      ok(`ringing starts the ring loop (${label})`, state.started === 1, `${state.started}`);
      finish(p);
      ok(`the ring loop is stopped when the call is ${label}`,
        state.stopped >= 1, `started ${state.started}, stopped ${state.stopped}`);
    }
  }

  /* ---- 27. the tuning is internally consistent -------------------------- */
  {
    const T = PHONE_TUNING;
    ok('the call budget fits inside a 150 s match',
      T.WARMUP + (T.MAX_CALLS_PER_MATCH - 1) * T.GLOBAL_CALL_GAP < 150,
      `${T.WARMUP + (T.MAX_CALLS_PER_MATCH - 1) * T.GLOBAL_CALL_GAP}`);
    ok('the ring timeout is shorter than the global gap', T.RING_SECONDS < T.GLOBAL_CALL_GAP);
    ok('the ambient radius gate is a real tier threshold',
      TIER_LIST.some((t) => t.eatRadius === T.AMBIENT_MIN_RADIUS));
    ok('EL_TRIM matches the voice.js element trim (0.55)', T.EL_TRIM === 0.55);
    ok('the mature budget is smaller than the call budget',
      T.MATURE_MAX_PER_MATCH < T.MAX_CALLS_PER_MATCH + T.MAX_TEXTS_PER_MATCH);
    ok('every built-in trigger has a cooldown and a priority',
      Object.values(TRIGGERS).every((d) => d.cooldown > 0 && d.priority > 0));
  }

  return { failed, passed: results.length - failed, total: results.length, results };
}

/* Vitest picks this up when a suite exists; harmless everywhere else. */
if (import.meta.vitest) {
  const { it, expect } = import.meta.vitest;
  it('phone self-test', () => {
    const r = __selftest();
    expect(r.results.filter((x) => !x.pass).map((x) => x.name)).toEqual([]);
    expect(r.failed).toBe(0);
  });
}
