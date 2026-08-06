/**
 * MIAMI DEVOUR — IN-GAME PHONE: CALLER CAST + LINE LIBRARY.
 *
 * ###########################################################################
 * # CONTENT POLICY. THIS IS ENFORCED BY CODE IN THIS FILE, NOT BY REVIEW.   #
 * #                                                                         #
 * # 1. Every caller is an ORIGINAL FICTIONAL CHARACTER. No real person,     #
 * #    likeness, catchphrase, police department, agency, company or brand.  #
 * #    The responder service is the invented "City Response" — the same     #
 * #    invented service used by src/audio/voicelines.js — and it exists     #
 * #    only inside this game.                                               #
 * #                                                                         #
 * # 2. "Mature Dialogue" is a player setting and it DEFAULTS TO OFF.        #
 * #    When it is off, a mature line is never SELECTED — it is removed from #
 * #    the pool before the weighted draw, not censored at render time.      #
 * #    See linesFor()/pickLine(): with mature off the pool physically does  #
 * #    not contain them, so there is no path by which one can be spoken.    #
 * #                                                                         #
 * # 3. When it is on, stronger lines become eligible but stay RARE and      #
 * #    REACTIVE: low weights (see MATURE_WEIGHT), a long cooldown floor,    #
 * #    and never on the `ambient` trigger. Measured share of picks with     #
 * #    mature ON is ~5% — see __selftest().stats.matureShareOn.             #
 * #                                                                         #
 * # 4. FORBIDDEN AT ANY SETTING, hard-filtered, with fixtures that prove    #
 * #    the filter works: slurs, hate speech, harassment of protected        #
 * #    groups, sexual content, threats, and impersonation of any real       #
 * #    person, company, department or brand.                                #
 * #                                                                         #
 * # validateLines() runs AT MODULE LOAD (bottom of file) and THROWS. A      #
 * # violating line cannot be imported, so it cannot ship. A policy that     #
 * # lives only in a comment is not enforced; this one halts the build.      #
 * ###########################################################################
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS
 *
 * Pure data plus its own validator. No playback, no DOM, no Web Audio, no
 * fetch, no timers, no state. The phone's call/SMS runtime, its cooldown
 * bookkeeping and its UI all live elsewhere and import from here.
 *
 * That split is not cosmetic. This module is also imported by the OFFLINE
 * generation pass (tools/generate-voices.mjs) which runs in Node with no DOM,
 * so a single browser API here would break paid asset generation.
 *
 * ---------------------------------------------------------------------------
 * AUDIO PATH — READ BEFORE WIRING ANYTHING
 *
 * Voice playback through the Web Audio graph is silent in this project and
 * five attempts to fix it failed. Dialogue now plays through an
 * HTMLAudioElement. The phone MUST use the same path: see
 * `VoiceSystem._startEl(handle, url, place, cast)` in src/audio/voice.js:1149,
 * which does `new Audio(url)` and is the proven-audible route. Do not build a
 * new Web Audio chain for phone calls.
 *
 * ---------------------------------------------------------------------------
 * THE `id` IS AN ASSET FILENAME. IT IS IMMUTABLE.
 *
 * Each line id becomes the base name of a generated mp3 and the key in
 * public/audio/<pack>/manifest.json. Renaming one orphans the paid asset and
 * silently mutes the line — a missing clip is indistinguishable from a line
 * that simply did not trigger. Ids are APPEND-ONLY. Retire a line by deleting
 * it; never rename one.
 *
 * Ids are [a-z0-9] with single hyphens because these strings become filenames
 * on case-insensitive disks (two ids differing only in case collapse into one
 * file and one line plays in the wrong voice — the uniqueness check below is
 * therefore case-insensitive) and because Windows still refuses to create
 * `con.mp3`, `aux.mp3` and friends.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TEXT LOOKS SLIGHTLY ODD
 *
 * Every line is BOTH spoken by TTS and printed as a caption, and the caption
 * path ends at `hud.pushFeed(html, color, kind)` (src/ui/hud.js:929) which
 * assigns to `innerHTML`. So the corpus itself is restricted to a small
 * character set — see TEXT_CHARSET — with no `< > & " '`. Contractions use the
 * typographic apostrophe U+2019 (’), which is not an HTML delimiter and which
 * every TTS engine reads identically to the ASCII one.
 *
 * The same charset rule closes a filter-evasion hole for free: masked
 * profanity (`f*ck`, `sh!t`) cannot be written here at all, and a TTS engine
 * reads an asterisk out loud anyway.
 *
 * ---------------------------------------------------------------------------
 * SHAPE
 *
 *   CAST          [{ id, displayName, role, pool, blurb, voiceDirection,
 *                    color, avatarSeed, cooldown }]
 *   TRIGGERS      ['grew-large', 'ate-car', ...] in declaration order
 *   TRIGGER_META  { trigger: { label, defaultCooldown, priority,
 *                              matureAllowed } }
 *   POOLS         { poolName: [castId, ...] }   the owner's eight line pools
 *   LINES         { trigger: { castId: [line, ...] } }
 *   CAPTION       { lineId: text }
 *   line          { id, cast, text, trigger, category, weight, mature,
 *                   matureTier, cooldown }
 *
 * `category` is a DERIVED ALIAS of `trigger`, present for one reason: the
 * offline generator reads `raw.category ?? raw.kind ?? raw.tag ?? raw.event`
 * (tools/generate-voices.mjs:627) and knows nothing about the word "trigger".
 * Without the alias every phone line lands in the generator's report under the
 * category "0" (the array index it falls back to) and `--only ate-building`
 * matches nothing. The two fields are stamped from the same source in the
 * build step, so they cannot drift.
 *
 * `LINES` is GENERATED from the flat SCRIPT below, never hand-nested. Hand
 * nesting writes the trigger twice and the cast twice, and the day the two
 * copies disagree is the day the taxi driver reads the dispatcher's lines with
 * nothing in the console to explain it.
 */

/* ========================================================================== */
/* LIMITS                                                                     */
/* ========================================================================== */

/**
 * A phone line may run slightly longer than a shouted street bark (12 words in
 * voicelines.js) because the player is holding the handset and the moment is
 * not passing them by. Fourteen is about 2.5 s of speech.
 */
export const MAX_WORDS = 14;

/** Belt to the word-count braces: catches one absurdly long compound word. */
export const MAX_CHARS = 88;

/** Below this a trigger cannot vary and the caller sounds like a loop. */
export const MIN_LINES_PER_TRIGGER = 6;

/** Filename-safe slug: lowercase, digits, single hyphens. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX = 56;

/**
 * The only characters a spoken/captioned line may contain. Letters, digits,
 * spaces, sentence punctuation, hyphen, and U+2019. Everything else is either
 * an innerHTML hazard, a TTS mispronunciation, or a way to smuggle masked
 * profanity past a word-boundary filter.
 */
const TEXT_CHARSET = /^[A-Za-z0-9 ,.!?;:’-]+$/;

/* Windows refuses to create a file with one of these basenames. The generator
   writes one file per id, so an id of `con` builds fine on a Mac and fails on
   a colleague's PC. */
const RESERVED_BASENAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** Mature lines are big-moment reactions, so they get a long lockout. */
const MATURE_COOLDOWN_FLOOR = 180;

/**
 * THE DELIBERATE GRADIENT, stated out loud because the brief asked for it.
 *
 *   mild    "damn", "hell", "crap"        weight 0.30
 *   medium  "ass", "bastard", "pissed"    weight 0.16
 *   strong  "shit", "bullshit"            weight 0.06
 *
 * An ordinary mild line has weight 1.0, so inside a pool of ~22 mild lines a
 * `mild` mature line is about a 1.3% pick and a `strong` one about 0.27%. The
 * ratio between the tiers (5 : 2.7 : 1) is the point: turning the setting on
 * should colour the dialogue, not replace it. Measured aggregate share of all
 * picks with mature ON is ~5%; __selftest() reports the real number rather
 * than trusting this comment.
 */
export const MATURE_WEIGHT = Object.freeze({ mild: 0.30, medium: 0.16, strong: 0.06 });

/** The setting defaults OFF. Public and family-friendly play is the default. */
export const MATURE_DEFAULT = false;

/* ========================================================================== */
/* TRIGGERS                                                                   */
/* ========================================================================== */

/**
 * The moments the phone reacts to. This set is CLOSED: validateLines() rejects
 * any line carrying a trigger that is not a key here, because a typo'd trigger
 * is a line that exists, validates as text, generates an mp3, and is never
 * once selected. That is the exact silent-failure shape this codebase keeps
 * producing.
 *
 *   defaultCooldown  seconds before the same LINE may be used again.
 *   priority         tie-break for the caller's own concurrency rules; higher
 *                    wins when two moments land together.
 *   matureAllowed    false means a mature line filed here is a HARD ERROR, not
 *                    a low-weight one. `ambient` is idle filler and mature
 *                    lines must be reactive, so mature is banned there.
 *                    `entered-zoo` is banned for the same reason the NPC zoo
 *                    category is gentle: animals in distress is the one place
 *                    this game's comedy stops being funny.
 */
export const TRIGGER_META = Object.freeze({
  'grew-large':   { label: 'Grew large',        defaultCooldown: 120, priority: 3, matureAllowed: true },
  'ate-car':      { label: 'Ate a vehicle',     defaultCooldown: 100, priority: 2, matureAllowed: true },
  'ate-building': { label: 'Ate a building',    defaultCooldown: 150, priority: 5, matureAllowed: true },
  'heat-up':      { label: 'Heat rising',       defaultCooldown: 120, priority: 4, matureAllowed: true },
  'entered-zoo':  { label: 'Entered the park',  defaultCooldown: 180, priority: 3, matureAllowed: false },
  'powerup':      { label: 'Power-up live',     defaultCooldown: 110, priority: 2, matureAllowed: true },
  'storm-near':   { label: 'Storm closing in',  defaultCooldown: 240, priority: 3, matureAllowed: true },
  'high-score':   { label: 'Record score',      defaultCooldown: 240, priority: 5, matureAllowed: true },
  'ambient':      { label: 'Ambient chatter',   defaultCooldown: 90,  priority: 1, matureAllowed: false },
});

/** Declaration order. A debug overlay should list them in this order. */
export const TRIGGERS = Object.freeze(Object.keys(TRIGGER_META));

const TRIGGER_SET = new Set(TRIGGERS);

/* ========================================================================== */
/* THE CAST                                                                   */
/* ========================================================================== */

/**
 * Nine original fictional callers, one per role in the brief.
 *
 * Names were invented for this file. They are deliberately plain-but-uncommon
 * so that none of them reads as a reference to anybody real, and none of them
 * reuses a name from the NPC cast in src/audio/voicelines.js — the phone cast
 * is a SEPARATE set of characters with separate assets.
 *
 * FIELDS
 *   role         short machine-ish role tag; the phone UI groups contacts by it.
 *   pool         which of the owner's eight line pools this caller carries.
 *   blurb        one or two lines of contact-card text, shown in Contacts.
 *   voiceDirection  AGE, TIMBRE, PACE, ATTITUDE for the TTS pass. It never
 *                names a human being and never says "in the style of" — the
 *                validator rejects both, because that phrasing is exactly how
 *                a fictional character quietly becomes an impersonation.
 *   color        caption/contact accent, #rrggbb. `hud.pushFeed(html, color,
 *                kind)` takes a hex string. Colour is never the only signal:
 *                the caption also carries displayName.
 *   avatarSeed   integer seed for the procedural avatar. HAND-ASSIGNED and
 *                unique, never derived from array position — deriving it from
 *                the index means reordering this array silently redraws every
 *                face in the player's contact list.
 *   cooldown     seconds before THIS CALLER contacts the player again, at all,
 *                for any reason. The per-line cooldown stops one sentence
 *                repeating; this stops one character narrating the whole match.
 */
export const CAST = [
  {
    id: 'rae-tolliver',
    displayName: 'Rae Tolliver',
    role: 'local',
    pool: 'locals',
    blurb: 'Lives three blocks from wherever the ground is opening. Has never once been alarmed by it.',
    voiceDirection:
      'Woman, thirties. Bright, slightly cracked mid-range with too much air behind it. Very fast, tumbling, ' +
      'sentences colliding into each other. Delighted by catastrophe. Laughs in the middle of words.',
    color: '#ffd166',
    avatarSeed: 1091,
    cooldown: 40,
  },
  {
    id: 'bo-castellan',
    displayName: 'Bo Castellan',
    role: 'shopowner',
    pool: 'shops',
    blurb: 'Runs a corner store that has been insured, re-insured, and quietly dropped by two providers.',
    voiceDirection:
      'Man, fifties. Thin, tight tenor pitched half a step higher than it should be. Starts sentences twice. ' +
      'Anxious, apologetic, always slightly out of breath. Trails off rather than finishing.',
    color: '#7ee0c2',
    avatarSeed: 1187,
    cooldown: 55,
  },
  {
    id: 'kit-solano',
    displayName: 'Kit Solano',
    role: 'streamer',
    pool: 'creators',
    blurb: 'Filming the sinkhole from whichever rooftop has signal. Would rather lose the tripod than the shot.',
    voiceDirection:
      'Androgynous, early twenties, light tenor. Performed energy aimed at a camera held at arm’s length: punchy, ' +
      'over-articulated, hard upward inflection, squeaks on the loudest word. Excited and openly mercenary.',
    color: '#c084fc',
    avatarSeed: 1259,
    cooldown: 35,
  },
  {
    id: 'dez-arbogast',
    displayName: 'Dez Arbogast',
    role: 'driver',
    pool: 'drivers',
    blurb: 'Twenty-two years behind the wheel in this city. Knows every shortcut you have destroyed.',
    voiceDirection:
      'Man, fifties. Gravelly baritone with big chest resonance, heard over an idling engine. Unhurried and ' +
      'sardonic, leaning weight onto the final word of every sentence. Amused more often than angry.',
    color: '#ffe066',
    avatarSeed: 1367,
    cooldown: 45,
  },
  {
    id: 'wren-adler',
    displayName: 'Wren — City Response',
    role: 'dispatch',
    pool: 'response',
    /* "City Response" is an INVENTED municipal service, shared with the NPC
       cast in src/audio/voicelines.js for consistency. It is not a real agency
       and must never be renamed to one. The validator rejects real agency and
       department names outright. */
    blurb: 'The duty voice on the City Response channel. City Response is an invented service that exists only in this game.',
    voiceDirection:
      'Woman, forties, heard through a narrow band-limited radio with a click at the top of each transmission. ' +
      'Clipped procedural cadence, completely level, no jokes and no filler. Short phrases, hard stops.',
    color: '#ff6b6b',
    avatarSeed: 1451,
    cooldown: 60,
  },
  {
    id: 'nula-brant',
    displayName: 'Nula Brant',
    role: 'foodtruck',
    pool: 'shops',
    blurb: 'Runs a food truck that has outrun three storms, two festivals and one of your better afternoons.',
    voiceDirection:
      'Woman, forties. Warm low alto with a rasp on the long vowels, projected over a griddle. Brisk, practical, ' +
      'dry. Never panics. Ends most lines on a downward beat, as if already turning back to the grill.',
    color: '#ff9f5a',
    avatarSeed: 1523,
    cooldown: 50,
  },
  {
    id: 'bexley-thorne',
    displayName: 'Bexley Thorne',
    role: 'condo',
    pool: 'condo',
    blurb: 'Fourteenth floor, bay side. Chairs a residents board that has opened a file on you.',
    voiceDirection:
      'Man, sixties. Polished, resonant upper baritone with immaculate diction and a faint drawl on the vowels. ' +
      'Slow, unhurried, every sentence delivered as a verdict. Affronted rather than frightened. Never shouts.',
    color: '#4dd2ff',
    avatarSeed: 1613,
    cooldown: 65,
  },
  {
    id: 'wendell-osei',
    displayName: 'Wendell Osei',
    role: 'park',
    pool: 'park',
    blurb: 'Keeper at the city park habitat. Counts every animal twice on days like this.',
    voiceDirection:
      'Man, forties. Steady mid baritone, quiet and close to the microphone, as if not wanting to startle ' +
      'something. Measured pace, gentle downward inflection. Competent, tired, protective. Never raises his voice.',
    color: '#a3e635',
    avatarSeed: 1709,
    cooldown: 70,
  },
  {
    id: 'unknown-caller',
    displayName: 'Unknown Caller',
    role: 'announcer',
    pool: 'destruction',
    blurb: 'No number, no name, no explanation. Calls only when something enormous is about to happen.',
    voiceDirection:
      'Ambiguous age and gender. Very low, very quiet, close-mic, with a long room tail behind it. Extremely slow, ' +
      'long pauses between short phrases. Amused, patient, entirely unhurried. Never emotional, never loud.',
    color: '#ff4fd8',
    avatarSeed: 1801,
    cooldown: 150,
  },
];

/**
 * The owner's eight authoring pools, mapped onto the cast. Kept as data because
 * the phone UI groups Contacts by pool and because a future caller must be
 * filed into an existing pool rather than inventing a ninth silently.
 */
export const POOLS = Object.freeze({
  locals: Object.freeze(['rae-tolliver']),
  drivers: Object.freeze(['dez-arbogast']),
  shops: Object.freeze(['bo-castellan', 'nula-brant']),
  creators: Object.freeze(['kit-solano']),
  response: Object.freeze(['wren-adler']),
  condo: Object.freeze(['bexley-thorne']),
  park: Object.freeze(['wendell-osei']),
  destruction: Object.freeze(['unknown-caller']),
});

/* ========================================================================== */
/* CONTENT FILTER                                                             */
/* ========================================================================== */

/*
 * TWO SEPARATE LISTS, BECAUSE THEY ANSWER TWO DIFFERENT QUESTIONS.
 *
 *   FORBIDDEN  — never allowed, at ANY setting, in ANY field. Slurs, hate
 *                speech, harassment of protected groups, sexual content,
 *                threats, impersonation of anything real. Tripping this is a
 *                thrown error at import.
 *
 *   PROFANITY  — allowed ONLY on a line marked mature:true, which the player
 *                must opt into. Tripping it on a mature:false line is also a
 *                thrown error, because "we filter it at render time" is how
 *                you end up shipping a family-friendly build that swears.
 *
 * WHY THE SLUR PATTERNS ARE BASE64
 *
 * A working hate-speech filter needs the actual strings. Putting them in
 * plaintext means every grep, every code search, every diff and every reviewer
 * eats them, and it makes this file unpleasant to open. They are stored
 * encoded and decoded once at load. The obvious failure mode of that choice —
 * a decode that silently yields nothing, leaving a filter that matches nothing
 * while every check reports green — is specifically defended against: the
 * decode is asserted non-empty and well-formed below, and validateLines() runs
 * a live canary through the scanner before it will validate anything.
 *
 * NORMALISATION, AND WHY THERE ARE THREE PASSES OVER TWO VIEWS
 *
 * A filter that only matches exact lowercase words is decoration. Text is
 * NFKD-folded, stripped of combining marks and lowercased, then split into TWO
 * parallel views — one plain, one with the leet substitutions applied — and
 * each pass runs over both:
 *
 *   W  word-boundary match on `wordy`           catches "RETARD", "n1gg3r"
 *   S  substring match on `squeezed`            catches "n i g g e r", "s.h.i.t"
 *   C  word-boundary match on `collapsedWords`  catches "faaaggot", "shiiiit"
 *
 * THE TWO VIEWS ARE NOT OPTIONAL, and this is the bug that proves it. With a
 * single leet-folded view, `!` folds to `i`, so "Holy shit!" normalised to
 * "holy shiti" and `\bshit\b` did not match — a mature:false line ending in an
 * exclamation mark could carry any profanity in the list straight past the
 * gate. Every check reported green; the corpus was validated by a filter that
 * was not looking. The plain view exists so punctuation cannot disarm a
 * pattern and the leet view exists so digits cannot; a hit in either is a hit.
 * validateLines() carries a permanent canary for it.
 *
 * S and C are set PER PATTERN, never automatically, because substring matching
 * is a Scunthorpe machine. Four entries in the table are W-only for exactly
 * that reason: one ethnic term is a substring of a country's name, another of
 * a common misspelling of "spiky", a third of "squawk", and one ableist term
 * of "retardant". Every one of those would otherwise reject innocent English.
 * The C pass anchors on WORD BOUNDARIES rather than matching as a substring
 * for the same reason: run-collapsing "Nigeria" leaves "nigeria", and a
 * substring pass over that would report a country as a slur.
 *
 * None of those words is written out here. The examples are described rather
 * than spelled so that this file stays free of readable slurs in every diff,
 * grep and code search — which is the entire reason the table is encoded.
 *
 * __selftest() pins both directions: fixtures that must trip, and a list of
 * innocent English that must not.
 */

/** base64 of the pattern, then '.' and the views it may match. */
const SLUR_B64 = [
  // The first entry is W+S only, not C: its run-collapsed form is the name of
  // an African country, and a filter that flags Niger is a filter somebody
  // deletes. The S pass still catches every realistic spacing of it.
  'bmlnZ2Vy.S', 'bmlnZ2Vycw==.SC', 'bmlnZ2E=.S',
  'bmlnZ2Fz.SC', 'bmlnZ2xldA==.SC', 'c2FuZG5pZ2dlcg==.SC',
  'Y29vbg==.W', 'amlnYWJvbw==.SC', 'cG9yY2htb25rZXk=.SC',
  'c3BlYXJjaHVja2Vy.SC', 'Y2hpbms=.S', 'Y2hpbmtz.SC',
  'Z29vaw==.W', 'Z29va3M=.S', 'c2xvcGVoZWFk.SC',
  'emlwcGVyaGVhZA==.SC', 'amFw.W', 'amFwcw==.W',
  'd2V0YmFjaw==.SC', 'd2V0YmFja3M=.SC', 'YmVhbmVy.SC',
  'YmVhbmVycw==.SC', 'c3BpYw==.W', 'c3BpY3M=.S',
  'cmFnaGVhZA==.SC', 'cmFnaGVhZHM=.SC', 'dG93ZWxoZWFk.SC',
  'dG93ZWxoZWFkcw==.SC', 'Y2FtZWwgam9ja2V5.SC', 'cGFraQ==.W',
  'cGFraXM=.W', 'Y3VycnkgbXVuY2hlcg==.SC', 'YWJv.W',
  'YWJvcw==.W', 'Y29vbGll.S', 'aGFsZmJyZWVk.SC',
  'cmVkc2tpbg==.SC', 'cmVkc2tpbnM=.SC', 'c3F1YXc=.W',
  'aW5qdW4=.S', 'Z3lwbw==.W', 'Z3lwcG8=.S',
  'cGlrZXk=.W', 'cGlrZXlz.W', 'a2FmZmly.S',
  'a2FmZmlycw==.SC', 'a2lrZQ==.W', 'a2lrZXM=.S',
  'aGVlYg==.W', 'Y2hyaXN0a2lsbGVy.SC', 'Y2hyaXN0IGtpbGxlcg==.SC',
  'c2h5bG9jaw==.SC', 'bW9oYW1tZWRhbg==.SC', 'cGFwaXN0.SC',
  'ZmFnZ290.SC', 'ZmFnZ290cw==.SC', 'ZmFnb3Q=.S',
  'ZmFn.W', 'ZmFncw==.W', 'ZHlrZQ==.W',
  'ZHlrZXM=.S', 'dHJhbm55.S', 'dHJhbm5pZXM=.SC',
  'c2hlbWFsZQ==.SC', 'c2hlbWFsZXM=.SC', 'bGFkeWJveQ==.SC',
  'aGVzaGU=.W', 'cXVlZXJiYWl0.SC', 'cG9vZg==.W',
  'cG9vZnRlcg==.SC', 'YmF0dHkgYm95.SC', 'cmV0YXJk.W',
  'cmV0YXJkcw==.SC', 'cmV0YXJkZWQ=.SC', 'dGFyZA==.W',
  'bW9uZ29sb2lk.SC', 'c3Bhc3RpYw==.SC', 'c3Bheg==.W',
  'Y3JpcHBsZQ==.SC', 'Y3JpcA==.W', 'd2luZG93IGxpY2tlcg==.SC',
  'ZHJvb2xlcnM=.SC', 'Y3VudA==.W', 'Y3VudHM=.S',
  'd2hvcmU=.S', 'd2hvcmVz.SC', 'c2x1dA==.W',
  'c2x1dHM=.S', 'c2thbms=.S', 'c2thbmtz.SC',
  'YmltYm8=.S',
];

/**
 * `atob` is global in every browser and in Node >= 16 (package.json requires
 * >= 20). The Buffer branch is reached through globalThis rather than as a bare
 * identifier so a bundler never tries to shim it into the client bundle.
 */
function decodeB64(s) {
  const g = /** @type {any} */ (globalThis);
  if (typeof g.atob === 'function') return g.atob(s);
  if (g.Buffer) return g.Buffer.from(s, 'base64').toString('latin1');
  throw new Error('callers.js: no base64 decoder — the slur filter cannot be built');
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const collapseRuns = (s) => s.replace(/(.)\1+/g, '$1');

/** A substring pass on anything shorter than this eats ordinary English. */
const MIN_SQUEEZE_LEN = 5;
/** A collapsed form shorter than this is too close to a real word. */
const MIN_COLLAPSE_LEN = 5;

/**
 * Build the slur table. Every row is checked as it is built: a pattern that
 * decoded to junk, to the empty string, or to something with characters other
 * than [a-z ] means the encoding is broken and the filter would silently pass
 * everything. That throws here rather than 200 lines later.
 *
 * The minimum lengths are enforced STRUCTURALLY rather than trusted to the
 * author of the table, so a future entry cannot re-open the Scunthorpe hole by
 * being flagged S or C when it is too short to survive it.
 */
const SLURS = (() => {
  const rows = [];
  for (const row of SLUR_B64) {
    const dot = row.lastIndexOf('.');
    const flags = row.slice(dot + 1);
    const plain = decodeB64(row.slice(0, dot));
    if (!/^[a-z]+(?: [a-z]+)*$/.test(plain) || plain.length < 3) {
      throw new Error(`callers.js: slur pattern ${row.slice(0, 8)}… decoded to an unusable value`);
    }
    const letters = plain.replace(/[^a-z]/g, '');
    const collapsed = collapseRuns(letters);
    rows.push({
      word: new RegExp(`\\b${escapeRe(plain).replace(/ /g, '\\s+')}\\b`),
      squeeze: (flags.includes('S') && letters.length >= MIN_SQUEEZE_LEN) ? letters : null,
      // Word-boundary, not substring: see the header note about Nigeria.
      collapse: (flags.includes('C') && collapsed.length >= MIN_COLLAPSE_LEN)
        ? new RegExp(`\\b${escapeRe(collapseRuns(plain))}\\b`)
        : null,
    });
  }
  return Object.freeze(rows);
})();

/**
 * Hate speech and harassment of protected groups, written as CONSTRUCTIONS
 * rather than as words. The group nouns here are ordinary English and are not
 * themselves banned — "immigrants" is a fine word. What is banned is the
 * dehumanising or exclusionary frame around them.
 */
const HATE_PATTERNS = Object.freeze([
  { why: 'dehumanising language', re: /\b(subhuman|untermensch|vermin|cockroaches|infest(?:ed|ing|ation)?)\b/ },
  { why: 'call for violence against a group', re: /\b(gas|lynch|exterminate|eradicate|cleanse|purge|deport)\s+(the|all|them|those|these)\b/ },
  { why: 'call for violence against a group', re: /\b(hate|kill|shoot|hang|burn|drown)\s+(?:all\s+)?(jews|muslims|christians|hindus|sikhs|buddhists|blacks|whites|asians|latinos|arabs|africans|mexicans|immigrants|migrants|refugees|gays|lesbians|queers|trans\s+people|disabled\s+people|women|men)\b/ },
  { why: 'exclusion of a protected group', re: /\b(no|not)\s+(jews|muslims|blacks|whites|asians|gays|women|immigrants|migrants|disabled)\s+(allowed|welcome|here|served)\b/ },
  { why: 'exclusion of a protected group', re: /\bgo\s+back\s+to\s+(your|their)\s+(own\s+)?(country|countries)\b/ },
  { why: 'group-based degradation', re: /\b(jews|muslims|blacks|whites|asians|gays|women|immigrants|migrants|disabled\s+people)\s+(are|were)\s+(all\s+)?(scum|filth|animals|trash|parasites|criminals|subhuman)\b/ },
  { why: 'genocidal reference', re: /\b(final\s+solution|racial\s+purity|master\s+race|ethnic\s+cleansing|white\s+power|heil\s+\w+)\b/ },
]);

/** Sexual content. A caller in this game has no reason to go near any of it. */
const SEXUAL_PATTERNS = Object.freeze([
  { why: 'sexual content', re: /\b(sex|sexy|sexual|sexually|porn|porno|pornographic|erotic|erotica|nude|nudes|naked|topless|orgasm|orgasms|masturbat(?:e|es|ing|ion)|blowjob|handjob|anal|genitals?|penis|vagina|boobs|titties|nipples|horny|aroused|foreplay|fetish|hookup|sext(?:ing)?)\b/ },
  { why: 'sexual proposition', re: /\b(sleep\s+with\s+me|come\s+to\s+bed|take\s+(?:it|them|your\s+\w+)\s+off)\b/ },
  { why: 'sexual content involving minors', re: /\b(child|children|kid|kids|minor|minors|teen|teens|underage)\b[^.!?]{0,24}\b(sex|sexual|nude|nudes|naked|porn)\b/ },
]);

/**
 * Threats. Deliberately absolute: any explicit construction of "I/we will do
 * violence to a person" is rejected, rather than trying to detect whether the
 * target happens to be a real human being. A phone caller in a comedy game has
 * no line that needs this shape, so a strict rule costs nothing and a lenient
 * one costs everything.
 */
const THREAT_PATTERNS = Object.freeze([
  { why: 'threat of violence', re: /\b(?:i|we|they|he|she)\s*(?:will|shall|am\s+going\s+to|are\s+going\s+to|is\s+going\s+to)\s+(kill|murder|shoot|stab|strangle|beat|bomb|burn|hurt|maim|torture|end)\s+(you|him|her|them|your|his|her|their)\b/ },
  { why: 'threat of violence', re: /\b(i|we)\s+(will|shall)\s+(find|hunt|come\s+for)\s+(you|him|her|them)\b/ },
  { why: 'threat of violence', re: /\b(death\s+threat|kill\s+list|hit\s+list|watch\s+your\s+back|you\s+are\s+dead|sleep\s+with\s+one\s+eye)\b/ },
  { why: 'mass violence', re: /\b(shoot\s+up|blow\s+up|bomb)\s+(?:a|the|your|his|her|their)?\s*(school|schools|mall|church|mosque|synagogue|temple|hospital|crowd|classroom|office)\b/ },
  { why: 'incitement', re: /\b(kill\s+yourself|kys)\b/ },
]);

/**
 * Impersonation of anything real. This list can never be exhaustive — that is
 * stated plainly rather than pretended away — so it is built from the classes
 * of thing most likely to be typed by accident: real law-enforcement and
 * government bodies, the handful of globally famous brands, and the structural
 * tells of a real reference (a URL, a social handle, a trademark mark, or a
 * voiceDirection that names a performance to imitate).
 *
 * Brand names that are also ordinary English words are deliberately NOT here.
 * An entry for "target" or "apple" or "shell" would reject correct lines every
 * week until somebody deleted the whole filter to get their work done, and a
 * filter that gets deleted protects nobody.
 */
const IMPERSONATION_PATTERNS = Object.freeze([
  { why: 'real agency or force', re: /\b(fbi|cia|nsa|dea|atf|nypd|lapd|chpd|swat|interpol|scotland\s+yard|homeland\s+security|secret\s+service|national\s+guard|state\s+troopers?|highway\s+patrol|police\s+department|sheriffs?(?:\s+(?:office|department))?|coast\s+guard|marshals\s+service)\b/i },
  { why: 'real brand or company', re: /\b(mcdonalds|burger\s+king|starbucks|coca[\s-]?cola|pepsi|nestle|nike|adidas|reebok|microsoft|google|alphabet|facebook|meta|instagram|whatsapp|twitter|tiktok|snapchat|youtube|twitch|netflix|spotify|disney|pixar|marvel|nintendo|playstation|xbox|samsung|sony|toyota|honda|nissan|chevrolet|cadillac|ferrari|lamborghini|porsche|bugatti|maserati|tesla|bmw|mercedes|volkswagen|uber|lyft|airbnb|walmart|costco|ikea|rockstar\s+games|grand\s+theft\s+auto)\b/i },
  { why: 'link, handle or email', re: /(https?:\/\/|www\.|\.com\b|\.net\b|\.org\b|@[a-z0-9])/i },
  { why: 'trademark or copyright mark', re: /[™®©]/ },
  { why: 'named impersonation of a performance', re: /\b(in\s+the\s+style\s+of|sounds?\s+(?:just\s+)?like\s+(?:the\s+)?(?:actor|singer|rapper|comedian|president|celebrity)|impression\s+of|impersonat(?:e|es|ing|ion)|do(?:ing)?\s+a[n]?\s+\w+\s+voice\s+from|voiced\s+by)\b/i },
]);

/**
 * Profanity, gated behind the Mature Dialogue setting.
 *
 * Tiers are for reporting only — a line's weight comes from MATURE_WEIGHT and
 * the author's choice, not from which word tripped. `squeeze` is set on the two
 * words worth defending against separator evasion and NOT on short ones:
 * `\bass\b` is safe, but "ass" as a substring matches class, pass, grass,
 * mass, assess and embassy.
 */
const PROFANITY = Object.freeze([
  /* "bloody" sits in MILD, not medium. The phone runtime in src/phone/phone.js
     carries its own independent denylist and it read a "bloody" line as no
     stronger than a mild one — it was right, and a tier the two modules
     disagree about is a tier that means nothing. */
  { tier: 'mild', re: /\b(damn|damned|damnit|dammit|goddamn|goddamned|hell|crap|crappy|sucks|screwed|freaking|frigging|frickin|friggin|bloody|blimey)\b/, squeeze: null },
  { tier: 'medium', re: /\b(ass|asses|asshole|assholes|arse|arsehole|bastard|bastards|piss|pissed|pissing|bugger|buggered|douche|douchebag|jackass|dumbass|prick|wanker|tosser)\b/, squeeze: null },
  { tier: 'strong', re: /\b(shit|shite|shitty|shithead|bullshit|f+u+c+k\w*|motherf\w*|wtf|stfu|bollocks)\b/, squeeze: ['bullshit', 'motherfucker'] },
]);

/**
 * Fold text into the views the scanners match against.
 *
 * NFKD + combining-mark strip means "ｎａｋｅｄ" and "nàkéd" both become "naked".
 * LEET folds the digit and symbol substitutions.
 *
 * TWO views come back, plain and leet-folded, and a hit in either is a hit.
 * Folding is not free: `!` -> `i` turns "shit!" into "shiti", so a single
 * folded view silently loses every pattern that ends a sentence. Keeping the
 * unfolded view alongside it costs one extra regex test and closes that hole.
 *
 * @returns {{raw: string, views: {wordy: string, squeezed: string,
 *            collapsedWords: string}[]}}
 */
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g', '@': 'a', $: 's', '!': 'i', '|': 'i', '+': 't', '(': 'c' };
const LEET_RE = /[01345789@$!|+(]/g;

export function normalizeForScan(input) {
  const raw = String(input == null ? '' : input);
  const base = raw.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const leet = base.replace(LEET_RE, (ch) => LEET[ch] || ch);
  const views = [];
  for (const s of (leet === base ? [base] : [base, leet])) {
    const wordy = s.replace(/[^a-z]+/g, ' ').trim();
    views.push({
      wordy,
      squeezed: s.replace(/[^a-z]/g, ''),
      // Runs collapsed but word gaps preserved, so the C pass can anchor on
      // \b instead of matching "niger" inside "nigeria".
      collapsedWords: collapseRuns(wordy),
    });
  }
  return { raw, views };
}

/**
 * The hard filter. Runs on line text AND on every human-readable cast field,
 * because a caller named after a real person is exactly the risk this exists
 * for and nobody would catch it by only scanning dialogue.
 *
 * @returns {string[]} one string per violation; empty means clean.
 */
export function scanForbidden(text) {
  const n = normalizeForScan(text);
  const hits = [];
  for (const s of SLURS) {
    let why = null;
    for (const v of n.views) {
      if (s.word.test(v.wordy)) { why = 'slur or hate term (word)'; break; }
      if (s.squeeze && v.squeezed.includes(s.squeeze)) { why = 'slur or hate term (spaced or punctuated)'; break; }
      if (s.collapse && s.collapse.test(v.collapsedWords)) { why = 'slur or hate term (letter-stretched)'; break; }
    }
    if (why) hits.push(why);
  }
  for (const group of [HATE_PATTERNS, SEXUAL_PATTERNS, THREAT_PATTERNS]) {
    for (const p of group) {
      if (n.views.some((v) => p.re.test(v.wordy))) hits.push(p.why);
    }
  }
  // Impersonation runs on the ORIGINAL string: its tells are punctuation
  // (`.com`, `@`, `™`) which `wordy` has already thrown away.
  for (const p of IMPERSONATION_PATTERNS) if (p.re.test(n.raw)) hits.push(p.why);
  return hits;
}

/**
 * The mature gate. Returns the tiers a string trips; empty means the string is
 * clean enough for a mature:false line.
 */
export function scanProfanity(text) {
  const n = normalizeForScan(text);
  const hits = [];
  for (const p of PROFANITY) {
    const hit = n.views.some((v) => p.re.test(v.wordy)
      || (p.squeeze && p.squeeze.some((w) => v.squeezed.includes(w))));
    if (hit) hits.push(p.tier);
  }
  return hits;
}

/* ========================================================================== */
/* THE SCRIPT                                                                 */
/* ========================================================================== */

/**
 * Authoring form: flat, one array per trigger, trigger stamped on in the build.
 *
 * @param {string} id    immutable, filename-safe; see the header.
 * @param {string} cast  must exist in CAST.
 * @param {string} text  <= MAX_WORDS words, TEXT_CHARSET only.
 * @param {{weight?:number, cooldown?:number}} [opts]
 */
function ln(id, cast, text, opts) {
  return {
    id, cast, text,
    weight: opts?.weight ?? 1,
    cooldown: opts?.cooldown,
    mature: false,
    matureTier: null,
  };
}

/**
 * A mature line. The weight comes from the tier, not from the author, so the
 * gradient cannot be quietly flattened one line at a time. The cooldown floor
 * is applied in the build step.
 *
 * @param {'mild'|'medium'|'strong'} tier
 */
function mat(id, cast, text, tier) {
  const weight = MATURE_WEIGHT[tier];
  if (!(weight > 0)) throw new Error(`callers.js: line "${id}" has unknown mature tier "${tier}"`);
  return { id, cast, text, weight, cooldown: undefined, mature: true, matureTier: tier };
}

const SCRIPT = {
  /* ---- the hole crossed a size threshold -------------------------------- */
  'grew-large': [
    ln('grew-large-rae-you-got-bigger', 'rae-tolliver', 'You got bigger! You definitely got bigger!'),
    ln('grew-large-rae-whole-intersection', 'rae-tolliver', 'That is a whole intersection now. Your intersection.'),
    ln('grew-large-rae-measuring-with-thumb', 'rae-tolliver', 'I am measuring you with my thumb. You are winning.'),
    ln('grew-large-bo-size-of-a-manhole', 'bo-castellan', 'You were the size of a manhole an hour ago.'),
    ln('grew-large-bo-please-stop-growing', 'bo-castellan', 'Please stop growing. I am asking politely.'),
    ln('grew-large-bo-moved-stock-upstairs', 'bo-castellan', 'I moved the stock upstairs. That buys me a week.'),
    ln('grew-large-kit-look-at-the-scale', 'kit-solano', 'Chat, look at the scale on this thing!'),
    ln('grew-large-kit-need-a-wider-lens', 'kit-solano', 'I need a wider lens. I actually need a wider lens.'),
    ln('grew-large-kit-that-is-geography', 'kit-solano', 'That is not a sinkhole anymore. That is geography.'),
    ln('grew-large-dez-took-my-shortcut', 'dez-arbogast', 'You just took out my shortcut. Both lanes of it.'),
    ln('grew-large-dez-cannot-drive-around', 'dez-arbogast', 'I cannot drive around you anymore. Congratulations.'),
    ln('grew-large-dez-watch-the-overpass', 'dez-arbogast', 'Getting big out there. Watch the overpass.'),
    ln('grew-large-wren-exceeded-containment', 'wren-adler', 'City Response. You have exceeded our containment radius.'),
    ln('grew-large-wren-revising-perimeter', 'wren-adler', 'Revising the perimeter outward. Third time this hour.'),
    ln('grew-large-nula-wider-than-my-truck', 'nula-brant', 'You are wider than my truck now. Congratulations.'),
    ln('grew-large-nula-moving-the-truck', 'nula-brant', 'I am moving the truck. No hard feelings.'),
    ln('grew-large-nula-growth-spurt', 'nula-brant', 'Growth spurt, huh? I know the feeling.'),
    ln('grew-large-bex-you-have-doubled', 'bexley-thorne', 'You have doubled. The board will be furious.'),
    ln('grew-large-bex-see-you-from-fourteen', 'bexley-thorne', 'I can see you from the fourteenth floor now.'),
    ln('grew-large-bex-whatever-you-are-fed', 'bexley-thorne', 'Whatever you are being fed, it is working.'),
    ln('grew-large-wendell-size-of-duck-pond', 'wendell-osei', 'You are the size of the duck pond. Please note that.'),
    ln('grew-large-wendell-moved-the-smalls', 'wendell-osei', 'I have moved the smaller animals. Just in case.'),
    ln('grew-large-unknown-bigger-good', 'unknown-caller', 'Bigger. Good. Keep going.'),
    ln('grew-large-unknown-new-word-for-you', 'unknown-caller', 'They will need a new word for you soon.'),
    /* mature */
    mat('grew-large-bo-damn-thing-doubled', 'bo-castellan', 'The damn thing doubled. It doubled while I watched.', 'mild'),
    mat('grew-large-dez-hell-of-a-size', 'dez-arbogast', 'That is a hell of a size for a hole.', 'mild'),
    mat('grew-large-rae-holy-hell-city-block', 'rae-tolliver', 'Holy hell, you are the size of a city block!', 'mild'),
    mat('grew-large-nula-size-of-that-bastard', 'nula-brant', 'Look at the size of that bastard.', 'medium'),
  ],

  /* ---- swallowed a vehicle ---------------------------------------------- */
  'ate-car': [
    ln('ate-car-rae-car-is-gone', 'rae-tolliver', 'That car is gone! It is completely gone!'),
    ln('ate-car-rae-that-was-a-nice-car', 'rae-tolliver', 'That was a nice car. Was.'),
    ln('ate-car-rae-do-the-blue-one', 'rae-tolliver', 'Do it again. Do it to the blue one.'),
    ln('ate-car-bo-not-the-delivery-van', 'bo-castellan', 'Tell me that was not the delivery van.'),
    ln('ate-car-bo-supplier-questions', 'bo-castellan', 'My supplier is going to have questions.'),
    ln('ate-car-bo-was-anyone-in-it', 'bo-castellan', 'Was anyone in it? Please say no.'),
    ln('ate-car-kit-clip-the-car', 'kit-solano', 'Clip that! The car! Clip the car!'),
    ln('ate-car-kit-slow-motion-on-that', 'kit-solano', 'Slow motion on that one. Chat is losing it.'),
    ln('ate-car-kit-three-hundred-watched', 'kit-solano', 'Three hundred people just watched a sedan vanish.'),
    ln('ate-car-dez-that-was-a-cab', 'dez-arbogast', 'Hey! Hey! That was a cab! Somebody’s cab!'),
    ln('ate-car-dez-hope-not-the-yellow', 'dez-arbogast', 'I hope that was not the yellow one. Was it yellow?'),
    ln('ate-car-dez-never-lost-a-car', 'dez-arbogast', 'Twenty-two years and I never lost a car like that.'),
    ln('ate-car-dez-rerouting-everything', 'dez-arbogast', 'I am rerouting. I am rerouting everything.'),
    ln('ate-car-wren-vehicle-lost', 'wren-adler', 'City Response. Vehicle lost to the aperture. Log it.'),
    ln('ate-car-wren-unit-not-there', 'wren-adler', 'That unit is not responding. Because it is not there.'),
    ln('ate-car-wren-confirm-unoccupied', 'wren-adler', 'Confirm the vehicle was unoccupied. Confirm it now.'),
    ln('ate-car-nula-generator-in-truck-bed', 'nula-brant', 'My generator was in that truck bed.'),
    ln('ate-car-nula-walking-home', 'nula-brant', 'Great. Now I am walking home.'),
    ln('ate-car-bex-collector-vehicle', 'bexley-thorne', 'That was a collector vehicle. It was in a magazine.'),
    ln('ate-car-bex-cost-more-than-street', 'bexley-thorne', 'I hope you enjoyed it. It cost more than your street.'),
    ln('ate-car-bex-driver-on-foot', 'bexley-thorne', 'My driver is on foot now. Do you understand that?'),
    ln('ate-car-wendell-took-the-park-van', 'wendell-osei', 'The park van. You took the park van.'),
    ln('ate-car-unknown-steel-glass-rubber', 'unknown-caller', 'Steel. Glass. Rubber. Good.'),
    ln('ate-car-unknown-one-less-driving-away', 'unknown-caller', 'One less thing driving away from you.'),
    /* mature */
    mat('ate-car-dez-damn-that-was-a-cab', 'dez-arbogast', 'Damn it! That was somebody’s cab!', 'mild'),
    mat('ate-car-bex-hell-of-a-car', 'bexley-thorne', 'That was a hell of a car. Was.', 'mild'),
    mat('ate-car-rae-ate-the-whole-damn-car', 'rae-tolliver', 'You ate the whole damn car!', 'mild'),
    mat('ate-car-bo-supplier-will-be-pissed', 'bo-castellan', 'My supplier is going to be pissed. Very pissed.', 'medium'),
    mat('ate-car-kit-holy-shit-the-car', 'kit-solano', 'Holy shit. Chat, the car is gone.', 'strong'),
  ],

  /* ---- swallowed a building or a landmark ------------------------------- */
  'ate-building': [
    ln('ate-building-rae-a-whole-building', 'rae-tolliver', 'The building. You took a building. A whole building!'),
    ln('ate-building-rae-used-to-live-there', 'rae-tolliver', 'I used to live there! Two addresses ago!'),
    ln('ate-building-rae-best-thing-ever-seen', 'rae-tolliver', 'That is the best thing I have ever seen. Truly.'),
    ln('ate-building-bo-landlords-building', 'bo-castellan', 'That was my landlord’s building. I feel complicated.'),
    ln('ate-building-bo-closing-early', 'bo-castellan', 'Okay. Okay. I am closing early. I am closing now.'),
    ln('ate-building-bo-took-the-corner-store', 'bo-castellan', 'You took the corner store. I was the corner store.'),
    ln('ate-building-kit-a-building-chat', 'kit-solano', 'A building. Chat. A building.'),
    ln('ate-building-kit-biggest-video-of-my-life', 'kit-solano', 'This is the biggest video of my life.'),
    ln('ate-building-kit-someone-will-ask-if-real', 'kit-solano', 'Someone will ask if this is real. It is real.'),
    ln('ate-building-dez-block-off-my-map', 'dez-arbogast', 'That block is off my map now. Permanently.'),
    ln('ate-building-dez-fare-there-this-morning', 'dez-arbogast', 'I picked up a fare there this morning. This morning!'),
    ln('ate-building-wren-structure-lost', 'wren-adler', 'City Response. Structure lost. Repeat, structure lost.'),
    ln('ate-building-wren-past-the-manual', 'wren-adler', 'Escalate. This is past anything in the manual.'),
    ln('ate-building-wren-evacuate-adjacent', 'wren-adler', 'Evacuate the adjacent block. In that order.'),
    ln('ate-building-nula-commissary-kitchen', 'nula-brant', 'My commissary kitchen was in there.'),
    ln('ate-building-nula-need-a-bigger-truck', 'nula-brant', 'I am going to need a bigger truck.'),
    ln('ate-building-bex-protected-landmark', 'bexley-thorne', 'That was a landmark! A protected landmark!'),
    ln('ate-building-bex-calling-attorneys', 'bexley-thorne', 'I am calling my attorney. I am calling several.'),
    ln('ate-building-bex-ground-floor-rent', 'bexley-thorne', 'Do you know what the ground floor rented for?'),
    ln('ate-building-bex-had-a-view-of-that', 'bexley-thorne', 'My unit had a view of that. Had.'),
    ln('ate-building-wendell-aviary-was-next', 'wendell-osei', 'The aviary was next to that. Was.'),
    ln('ate-building-wendell-animal-hospital', 'wendell-osei', 'Tell me the animal hospital is still standing.'),
    ln('ate-building-unknown-foundations', 'unknown-caller', 'Foundations. Now we are talking.'),
    ln('ate-building-unknown-skyline-negotiable', 'unknown-caller', 'The skyline is negotiable after all.'),
    /* mature */
    mat('ate-building-bex-damn-landmark', 'bexley-thorne', 'That was a damn landmark! A protected one!', 'mild'),
    mat('ate-building-rae-what-the-hell', 'rae-tolliver', 'What the hell was that? Do it again!', 'mild'),
    mat('ate-building-bo-crap-there-goes-the-block', 'bo-castellan', 'Oh crap. There goes the whole block.', 'mild'),
    mat('ate-building-dez-kiss-my-ass-goodbye', 'dez-arbogast', 'That whole block can kiss my ass goodbye.', 'medium'),
    mat('ate-building-wren-somebody-will-be-pissed', 'wren-adler', 'Structure lost. Somebody upstairs will be pissed.', 'medium'),
    mat('ate-building-kit-absolute-bullshit', 'kit-solano', 'Chat, that is a building. That is absolute bullshit.', 'strong'),
  ],

  /* ---- the heat tier went up (src/gameplay/heat.js tierOf) --------------- */
  'heat-up': [
    ln('heat-up-rae-they-are-coming', 'rae-tolliver', 'They are coming for you. I am so excited.'),
    ln('heat-up-rae-lights-and-sirens', 'rae-tolliver', 'Lights! Sirens! This is the good part!'),
    ln('heat-up-bo-units-outside-my-shop', 'bo-castellan', 'There are units outside my shop. Because of you.'),
    ln('heat-up-bo-did-not-tell-them', 'bo-castellan', 'I did not tell them anything. On the record.'),
    ln('heat-up-kit-units-incoming', 'kit-solano', 'Chat, response units incoming! Do not miss this!'),
    ln('heat-up-kit-chase-is-the-content', 'kit-solano', 'The chase is the content. It is always the content.'),
    ln('heat-up-kit-filming-you-not-them', 'kit-solano', 'I am not filming the units. I am filming you.'),
    ln('heat-up-dez-two-blocks-north-clear', 'dez-arbogast', 'Two blocks north is clear. Two blocks. Move.'),
    ln('heat-up-dez-take-the-alley', 'dez-arbogast', 'I would take the alley. If I were a hole.'),
    ln('heat-up-dez-checkpoint-amateur-hour', 'dez-arbogast', 'They set up a checkpoint. Amateur hour.'),
    ln('heat-up-wren-escalating-next-tier', 'wren-adler', 'City Response. Escalating a tier. Stay clear.'),
    ln('heat-up-wren-all-units-converge', 'wren-adler', 'All units, converge. You know the address.'),
    ln('heat-up-wren-only-courtesy-call', 'wren-adler', 'This is your only courtesy call. Understood?'),
    ln('heat-up-wren-containment-inbound', 'wren-adler', 'Containment is inbound. Bring the heavy barriers.'),
    ln('heat-up-nula-i-forgot-which-way', 'nula-brant', 'They asked me which way you went. I forgot.'),
    ln('heat-up-nula-truck-packed-gone', 'nula-brant', 'Truck is packed. I am gone. Good luck.'),
    ln('heat-up-bex-i-called-them', 'bexley-thorne', 'I called them. Obviously I called them.'),
    ln('heat-up-bex-response-time-disappointing', 'bexley-thorne', 'The response time was disappointing. I said so.'),
    ln('heat-up-bex-very-public-problem', 'bexley-thorne', 'You have made this a very public problem.'),
    ln('heat-up-wendell-keep-it-from-the-park', 'wendell-osei', 'Whatever happens, keep it away from the park.'),
    ln('heat-up-unknown-they-noticed', 'unknown-caller', 'They noticed. That was always the plan.'),
    ln('heat-up-unknown-pressure-suits-you', 'unknown-caller', 'Pressure. It suits you.'),
    /* mature */
    mat('heat-up-rae-oh-hell-yes', 'rae-tolliver', 'Oh hell yes, here they come!', 'mild'),
    mat('heat-up-dez-every-damn-unit', 'dez-arbogast', 'Every damn unit in the city is on your street.', 'mild'),
    mat('heat-up-bex-this-crap-dealt-with', 'bexley-thorne', 'I want this crap dealt with today.', 'mild'),
    mat('heat-up-wren-pain-in-my-ass', 'wren-adler', 'This has become a pain in my ass. Stand clear.', 'medium'),
    mat('heat-up-nula-properly-pissed', 'nula-brant', 'They are pissed. Properly pissed. Move.', 'medium'),
    mat('heat-up-kit-holy-shit-look-at-them', 'kit-solano', 'Chat, this got real. Holy shit, look at them.', 'strong'),
  ],

  /* ---- entered the park habitat (cityLayout.js b.subtype === 'zoo') ------
     No mature lines here, on purpose. Animals in distress is the one place
     this game's comedy stops being funny, and TRIGGER_META enforces it. */
  'entered-zoo': [
    ln('entered-zoo-wendell-you-are-in-the-park', 'wendell-osei', 'You are in the park. Careful. Please be careful.'),
    ln('entered-zoo-wendell-gates-are-open', 'wendell-osei', 'Gates are open. Everything on four legs is out.'),
    ln('entered-zoo-wendell-flamingos-unbothered', 'wendell-osei', 'The flamingos are unbothered. They have seen worse.'),
    ln('entered-zoo-wendell-stay-off-east-path', 'wendell-osei', 'Stay off the east path. That is the nursery.'),
    ln('entered-zoo-wendell-leave-the-animals', 'wendell-osei', 'Take the fences. Take the signs. Leave the animals.'),
    ln('entered-zoo-rae-say-hi-to-the-goats', 'rae-tolliver', 'Are you at the park? Say hi to the goats!'),
    ln('entered-zoo-rae-banned-from-the-park', 'rae-tolliver', 'I have been banned from that park. Long story.'),
    ln('entered-zoo-kit-be-nice-in-comments', 'kit-solano', 'Chat, we are at the park. Be nice in the comments.'),
    ln('entered-zoo-kit-channel-is-over', 'kit-solano', 'If one animal gets hurt, this channel is over.'),
    ln('entered-zoo-wren-perimeter-breached', 'wren-adler', 'City Response. Park perimeter breached. Handle it gently.'),
    ln('entered-zoo-wren-welfare-team-north-gate', 'wren-adler', 'Animal welfare team to the north gate. Priority.'),
    ln('entered-zoo-bo-i-sell-to-the-park', 'bo-castellan', 'The park? I sell to the park. Please be gentle.'),
    ln('entered-zoo-nula-weekend-stand', 'nula-brant', 'I do the weekend stand there. Do not eat my spot.'),
    ln('entered-zoo-bex-public-amenity', 'bexley-thorne', 'The park is a public amenity. Which I fund.'),
    ln('entered-zoo-dez-park-roads-are-narrow', 'dez-arbogast', 'Park roads are narrow. Mind the pedestrians.'),
    ln('entered-zoo-unknown-even-i-have-limits', 'unknown-caller', 'Not here. Even I have limits.'),
  ],

  /* ---- a power-up is live (src/gameplay/powerups.js POWERUP_ORDER) ------- */
  powerup: [
    ln('powerup-rae-did-you-get-faster', 'rae-tolliver', 'What was that? Did you just get faster?'),
    ln('powerup-rae-eat-more-of-it', 'rae-tolliver', 'Whatever you just ate, eat more of it.'),
    ln('powerup-rae-desk-slid-sideways', 'rae-tolliver', 'Everything on my desk just slid sideways.'),
    ln('powerup-bo-rack-sliding-to-door', 'bo-castellan', 'My display rack is sliding toward the door.'),
    ln('powerup-bo-pull-feels-stronger', 'bo-castellan', 'Is the pull stronger? It feels stronger.'),
    ln('powerup-kit-it-powered-up', 'kit-solano', 'Chat, it powered up. It actually powered up!'),
    ln('powerup-kit-tripod-is-walking', 'kit-solano', 'My tripod is walking toward the hole. On its own.'),
    ln('powerup-kit-run-and-keep-filming', 'kit-solano', 'This is the part where I run and keep filming.'),
    ln('powerup-dez-picked-up-speed', 'dez-arbogast', 'You just picked up speed. I can hear it.'),
    ln('powerup-dez-i-want-one', 'dez-arbogast', 'Whatever that was, I want one.'),
    ln('powerup-wren-behaviour-changed', 'wren-adler', 'City Response. Target behaviour changed. Stand off.'),
    ln('powerup-wren-something-boosted-it', 'wren-adler', 'Something boosted it. Nobody engage until I say.'),
    ln('powerup-nula-napkins-flew-across', 'nula-brant', 'My napkins just flew across the street.'),
    ln('powerup-nula-everything-unbolted', 'nula-brant', 'Everything unbolted is heading your way.'),
    ln('powerup-bex-balcony-furniture-moving', 'bexley-thorne', 'My balcony furniture is moving. It is bolted down.'),
    ln('powerup-bex-beyond-a-nuisance', 'bexley-thorne', 'This is beyond a nuisance now.'),
    ln('powerup-wendell-pull-reached-the-pond', 'wendell-osei', 'The pull reached the pond. The ducks noticed.'),
    ln('powerup-wendell-take-it-elsewhere', 'wendell-osei', 'Whatever you took, please take it somewhere else.'),
    ln('powerup-unknown-take-all-of-it', 'unknown-caller', 'Yes. Take it. Take all of it.'),
    ln('powerup-unknown-a-gift', 'unknown-caller', 'A gift. Use it before it forgets you.'),
    /* mature */
    mat('powerup-rae-hell-of-a-boost', 'rae-tolliver', 'Whatever that was, it is one hell of a boost.', 'mild'),
    mat('powerup-bo-everything-sliding-damn-it', 'bo-castellan', 'Everything in my shop is sliding. Damn it!', 'mild'),
    mat('powerup-kit-holy-shit-it-powered-up', 'kit-solano', 'It powered up. Holy shit, chat, it powered up!', 'strong'),
  ],

  /* ---- the storm event is arriving (eventGlue scene.userData.storm) ------ */
  'storm-near': [
    ln('storm-near-rae-storm-coming-great', 'rae-tolliver', 'Storm coming! Storm coming! This will be great!'),
    ln('storm-near-rae-balcony-with-snacks', 'rae-tolliver', 'I am on the balcony with snacks. Do not disappoint me.'),
    ln('storm-near-bo-boarding-the-windows', 'bo-castellan', 'I am boarding the windows. For the weather. Only that.'),
    ln('storm-near-bo-rain-and-you', 'bo-castellan', 'Rain and you on the same afternoon. Wonderful.'),
    ln('storm-near-kit-wind-taking-my-mic', 'kit-solano', 'The wind is taking my microphone. Stay tuned.'),
    ln('storm-near-kit-storm-plus-you', 'kit-solano', 'Storm footage plus you equals a very good night.'),
    ln('storm-near-dez-roads-flood-fast', 'dez-arbogast', 'Roads flood fast here. Do not be under the causeway.'),
    ln('storm-near-dez-nobody-sane-driving', 'dez-arbogast', 'Nobody is driving in this. Nobody sane.'),
    ln('storm-near-wren-weather-advisory', 'wren-adler', 'City Response. Weather advisory. Visibility dropping.'),
    ln('storm-near-wren-shelter-posture', 'wren-adler', 'All units, shelter posture. The perimeter holds itself.'),
    ln('storm-near-wren-we-lose-the-cameras', 'wren-adler', 'We lose the cameras in this. Remember that.'),
    ln('storm-near-nula-awning-is-down', 'nula-brant', 'Awning is down. Truck is shaking. Call you back.'),
    ln('storm-near-nula-rain-brings-business', 'nula-brant', 'Rain always brings me business. You do not.'),
    ln('storm-near-bex-building-sways', 'bexley-thorne', 'The building sways in this. I am told that is normal.'),
    ln('storm-near-bex-terrace-in-the-bay', 'bexley-thorne', 'My terrace furniture is in the bay. Thank you, weather.'),
    ln('storm-near-wendell-bringing-birds-in', 'wendell-osei', 'Bringing the birds in. Give me twenty minutes.'),
    ln('storm-near-wendell-animals-not-amused', 'wendell-osei', 'Storm and a sinkhole. The animals are not amused.'),
    ln('storm-near-unknown-the-sky-is-helping', 'unknown-caller', 'The sky is helping. It usually does.'),
    /* mature */
    mat('storm-near-dez-what-a-damn-day', 'dez-arbogast', 'Rain and a sinkhole. What a damn day.', 'mild'),
    /* Was "Bloody marvellous." The phone runtime's independent denylist does
       not carry "bloody" at all, so the line was flagged mature while reading
       as clean to the other module — it would have spent the rare mature
       budget on nothing. Reworded to a word BOTH denylists recognise. Safe to
       rename because no phone audio has been generated yet; once it has, this
       id is frozen forever. */
    mat('storm-near-bex-damn-this-weather', 'bexley-thorne', 'My terrace furniture is in the bay. Damn this weather.', 'mild'),
    mat('storm-near-nula-rain-in-the-fryer', 'nula-brant', 'Rain in the truck, rain in the fryer. I am pissed.', 'medium'),
  ],

  /* ---- a score record fell ---------------------------------------------- */
  'high-score': [
    ln('high-score-rae-top-of-the-board', 'rae-tolliver', 'You are top of the board! I am screaming!'),
    ln('high-score-rae-everyone-knows', 'rae-tolliver', 'I told everyone. Everyone knows. You are famous.'),
    ln('high-score-kit-new-record-witnessed', 'kit-solano', 'New record! Chat, we witnessed a new record!'),
    ln('high-score-kit-number-in-thumbnail', 'kit-solano', 'That number is going in the thumbnail.'),
    ln('high-score-kit-beat-the-old-score', 'kit-solano', 'You just beat the old top score. On camera.'),
    ln('high-score-dez-best-run-i-have-seen', 'dez-arbogast', 'Best run I have seen, and I see everything.'),
    ln('high-score-dez-ride-is-free', 'dez-arbogast', 'Ride is free today. You earned it.'),
    ln('high-score-wren-new-maximum-recorded', 'wren-adler', 'City Response. New maximum recorded. Nobody is pleased.'),
    ln('high-score-wren-worst-day-this-city', 'wren-adler', 'You are officially the worst day this city has had.'),
    ln('high-score-nula-first-plate-on-me', 'nula-brant', 'Record run. Come by. First plate is on me.'),
    ln('high-score-nula-naming-something-spicy', 'nula-brant', 'I am naming something after you. Something spicy.'),
    ln('high-score-bex-record-and-lawsuit', 'bexley-thorne', 'You have set a record. I have set a lawsuit.'),
    ln('high-score-bex-impressive-repulsive', 'bexley-thorne', 'Impressive. Repulsive. Both, somehow.'),
    ln('high-score-bo-broke-a-window', 'bo-castellan', 'They say you broke a record. You broke a window.'),
    ln('high-score-wendell-lowest-in-my-book', 'wendell-osei', 'Highest score in the city. Lowest in my book.'),
    ln('high-score-unknown-records-swallowed', 'unknown-caller', 'A record. Records are made to be swallowed.'),
    /* mature */
    mat('high-score-kit-a-damn-record', 'kit-solano', 'A record. A damn record. Chat, we were here.', 'mild'),
    mat('high-score-dez-best-damn-run', 'dez-arbogast', 'Best damn run I have ever seen out here.', 'mild'),
    mat('high-score-bex-absolute-ass-of-this-city', 'bexley-thorne', 'You have made an absolute ass of this city.', 'medium'),
    mat('high-score-rae-absolute-unit', 'rae-tolliver', 'You broke the record! You absolute unit! Holy shit!', 'strong'),
  ],

  /* ---- idle chatter. Plays when nothing in particular has happened, so no
     line here may react to a specific event, and no line here may be mature. */
  ambient: [
    ln('ambient-rae-just-saying-hi', 'rae-tolliver', 'Hey. Nothing is wrong. I just wanted to say hi.'),
    ln('ambient-rae-you-look-busy', 'rae-tolliver', 'You busy? You look busy. I can hold.'),
    ln('ambient-rae-chart-on-my-wall', 'rae-tolliver', 'I made a chart of your best days. It is on my wall.'),
    ln('ambient-rae-nobody-believes-me', 'rae-tolliver', 'Nobody believes me about you. Nobody. I have photos.'),
    ln('ambient-rae-i-take-requests', 'rae-tolliver', 'Do you take requests? I have a list of requests.'),
    ln('ambient-bo-mostly-fine', 'bo-castellan', 'Just checking in. The shop is fine. Mostly fine.'),
    ln('ambient-bo-wrong-number-pine', 'bo-castellan', 'Sorry, wrong number. Actually no. Avoid Pine Street.'),
    ln('ambient-bo-restocked-already', 'bo-castellan', 'I restocked. Please do not make me regret restocking.'),
    ln('ambient-bo-let-it-ring', 'bo-castellan', 'My insurance called me. I let it ring.'),
    ln('ambient-bo-could-you-not-be', 'bo-castellan', 'If you are nearby, could you not be? Please?'),
    ln('ambient-kit-chat-asks-breakfast', 'kit-solano', 'Chat wants to know what you had for breakfast.'),
    ln('ambient-kit-slow-stream-today', 'kit-solano', 'Slow stream today. Do something. Anything. Please.'),
    ln('ambient-kit-forty-viewers', 'kit-solano', 'I am at forty viewers. Forty. Help me out here.'),
    ln('ambient-kit-feed-is-waiting', 'kit-solano', 'No pressure, but the whole feed is waiting on you.'),
    ln('ambient-kit-roof-angle', 'kit-solano', 'I set up on the roof. Great angle. Terrible wind.'),
    ln('ambient-dez-traffic-is-clear', 'dez-arbogast', 'Traffic is clear. Enjoy it while it lasts.'),
    ln('ambient-dez-parked-two-blocks', 'dez-arbogast', 'I am parked two blocks over. Just so you know.'),
    ln('ambient-dez-fare-asked-about-you', 'dez-arbogast', 'A fare asked about you. I said no comment.'),
    ln('ambient-dez-twenty-two-years', 'dez-arbogast', 'Twenty-two years on these streets. Never a dull shift.'),
    ln('ambient-dez-scenic-or-fast', 'dez-arbogast', 'You want the scenic route or the fast one?'),
    ln('ambient-wren-routine-check', 'wren-adler', 'City Response, routine check. Nothing to report. Yet.'),
    ln('ambient-wren-channel-monitored', 'wren-adler', 'This channel is monitored. Consider that a courtesy.'),
    ln('ambient-wren-all-quiet-downtown', 'wren-adler', 'All quiet downtown. Keep it that way.'),
    ln('ambient-wren-wellness-check', 'wren-adler', 'Logging this as a wellness check. Do not comment.'),
    ln('ambient-wren-standing-by', 'wren-adler', 'City Response, standing by. We are always standing by.'),
    ln('ambient-nula-lunch-rush-done', 'nula-brant', 'Lunch rush is done. Come by if you are still hungry.'),
    ln('ambient-nula-saved-you-something', 'nula-brant', 'I saved you something. I do not know why.'),
    ln('ambient-nula-truck-on-sixth', 'nula-brant', 'Truck is on Sixth today. Just so we are clear.'),
    ln('ambient-nula-business-is-good', 'nula-brant', 'Business is good. That usually means you are coming.'),
    ln('ambient-nula-two-tacos-left', 'nula-brant', 'Two tacos left. Do not take the whole cart.'),
    ln('ambient-bex-board-meets-thursday', 'bexley-thorne', 'The board meets Thursday. Your name is on the agenda.'),
    ln('ambient-bex-pay-not-to-have-view', 'bexley-thorne', 'I pay a great deal to not have this view.'),
    ln('ambient-bex-concierge-instructions', 'bexley-thorne', 'My concierge has instructions regarding you.'),
    ln('ambient-bex-property-values', 'bexley-thorne', 'Property values, dear. Property values.'),
    ln('ambient-bex-unlicensed', 'bexley-thorne', 'I am told you are unlicensed. Is that true?'),
    ln('ambient-wendell-rounds-done', 'wendell-osei', 'Morning rounds are done. Everyone is accounted for.'),
    ln('ambient-wendell-pelicans-watching', 'wendell-osei', 'The pelicans are watching you. They tell me things.'),
    ln('ambient-wendell-park-is-quiet', 'wendell-osei', 'Park is quiet. I would like it to stay quiet.'),
    ln('ambient-wendell-feeding-time', 'wendell-osei', 'Feeding time in ten minutes. Please be elsewhere.'),
    ln('ambient-wendell-fixed-the-fence', 'wendell-osei', 'I fixed the fence. Again. For you. Thanks for that.'),
    ln('ambient-unknown-you-answered', 'unknown-caller', 'You answered. Interesting.'),
    ln('ambient-unknown-keeping-score', 'unknown-caller', 'The city is keeping score. So am I.'),
    ln('ambient-unknown-not-yet-soon', 'unknown-caller', 'Not yet. Soon.'),
    ln('ambient-unknown-ground-watching-back', 'unknown-caller', 'I have been watching the ground. It watches back.'),
    ln('ambient-unknown-thank-me-now', 'unknown-caller', 'Do not thank me later. Thank me now.'),
  ],
};

/* ========================================================================== */
/* BUILD                                                                      */
/* ========================================================================== */

/* Everything below is derived. Nothing here decides content; it reshapes
   SCRIPT into the lookups the runtime needs and freezes the result. */

const CAST_BY_ID = new Map();
for (const c of CAST) CAST_BY_ID.set(c.id, Object.freeze(c));
Object.freeze(CAST);

const BY_ID = new Map();

/**
 * Every built line in declaration order, INCLUDING any sharing an id. BY_ID
 * would swallow a duplicate silently — the second `set` overwrites the first
 * and the corpus quietly loses a line — so the validator walks this instead.
 */
const ALL_LINES = [];

/** trigger -> frozen [line] : every line, mature included. */
const ALL_BY_TRIGGER = new Map();
/** trigger -> frozen [line] : mature:false only. This is the DEFAULT pool. */
const MILD_BY_TRIGGER = new Map();

const EMPTY = Object.freeze([]);

/**
 * trigger -> castId -> [line]. THE COMPLETE CORPUS, MATURE LINES INCLUDED.
 *
 * ###########################################################################
 * # DO NOT SELECT DIALOGUE BY WALKING THIS OBJECT.                          #
 * #                                                                         #
 * # LINES is the GENERATOR's view: the offline pass must see every line it  #
 * # has to synthesise, including the mature ones, or the assets do not      #
 * # exist when the player turns the setting on. It therefore has NO         #
 * # knowledge of the Mature Dialogue setting, and anything that picks from  #
 * # it directly has silently opted out of the policy.                       #
 * #                                                                         #
 * # Runtime code must use linesFor(trigger, {mature}) or pickLine(), which  #
 * # is where the setting is applied — by building a pool that does not      #
 * # contain the ineligible lines at all.                                    #
 * #                                                                         #
 * # A consumer that legitimately needs the whole corpus (an asset manifest, #
 * # a debug overlay, a line-count report) is fine here, and must carry its  #
 * # own gate if it ever renders one of these to a player.                   #
 * ###########################################################################
 *
 * @type {Record<string, Record<string, ReadonlyArray<object>>>}
 */
export const LINES = {};

/** id -> text. Captions must work with audio muted, missing or still loading. */
export const CAPTION = {};

for (const trigger of TRIGGERS) {
  const meta = TRIGGER_META[trigger];
  const rows = SCRIPT[trigger] || [];
  const byCast = {};
  const all = [];
  const mild = [];

  for (const row of rows) {
    /* Trigger and cooldown are stamped here rather than typed per line: the
       key is the single source of truth for which bucket a line is in. A
       mature line is floored to MATURE_COOLDOWN_FLOOR so "rare" is enforced by
       the data and not by remembering to type a number. */
    const base = row.cooldown ?? meta.defaultCooldown;
    const line = Object.freeze({
      id: row.id,
      cast: row.cast,
      text: row.text,
      trigger,
      // Derived alias for tools/generate-voices.mjs — see the header.
      category: trigger,
      weight: row.weight,
      mature: row.mature,
      matureTier: row.matureTier,
      cooldown: row.mature ? Math.max(base, MATURE_COOLDOWN_FLOOR) : base,
    });

    (byCast[line.cast] ||= []).push(line);
    all.push(line);
    if (!line.mature) mild.push(line);
    ALL_LINES.push(line);
    BY_ID.set(line.id, line);
    CAPTION[line.id] = line.text;
  }

  for (const k of Object.keys(byCast)) Object.freeze(byCast[k]);
  LINES[trigger] = Object.freeze(byCast);
  ALL_BY_TRIGGER.set(trigger, Object.freeze(all));
  MILD_BY_TRIGGER.set(trigger, Object.freeze(mild));
}

Object.freeze(LINES);
Object.freeze(CAPTION);
Object.freeze(ALL_LINES);

/* Precomputed once: allIds() is called by the offline generation pass and the
   manifest writer, both of which would otherwise rebuild the array per call.
   Keyed off BY_ID, so it is the list of DISTINCT asset filenames. */
const ALL_IDS = Object.freeze([...BY_ID.keys()]);

/* ========================================================================== */
/* LOOKUPS                                                                    */
/* ========================================================================== */

/**
 * The eligible pool for a trigger.
 *
 * THIS IS THE POLICY BOUNDARY. With mature off the returned array physically
 * does not contain a mature line, so no caller — however badly written — can
 * select one. There is no downstream filter to forget.
 *
 * Returns a SHARED FROZEN array, never a copy, when no cast filter is given.
 * Do not sort or splice it; the freeze throws, which is the intended outcome.
 *
 * @param {string} trigger
 * @param {{mature?: boolean, cast?: string}} [opts]
 * @returns {ReadonlyArray<object>}
 */
export function linesFor(trigger, opts) {
  const mature = opts?.mature === true;
  const pool = (mature ? ALL_BY_TRIGGER : MILD_BY_TRIGGER).get(trigger) || EMPTY;
  const castId = opts?.cast;
  if (!castId) return pool;
  // Exact match only. A caller wanting a fallback must ask again without the
  // cast filter rather than have this silently substitute another character —
  // the dispatcher reading the streamer's lines is worse than saying nothing.
  const out = pool.filter((l) => l.cast === castId);
  return out.length ? Object.freeze(out) : EMPTY;
}

/**
 * Weighted pick from the eligible pool. Pure: it holds no state, so cooldown
 * bookkeeping stays with the caller (it needs the clock; this file has none).
 *
 * `rng` takes the game's seeded RNG directly — `makeRNG()` in src/core/rng.js
 * returns a callable yielding [0,1) — so phone events are replayable.
 *
 * `recent` is a Set or Array of recently used ids. They are skipped unless
 * skipping them would empty the pool, in which case the whole pool is used:
 * repeating a line is better than the phone going silent at a big moment.
 *
 * @param {string} trigger
 * @param {{mature?: boolean, cast?: string, rng?: () => number,
 *          recent?: Set<string>|string[]}} [opts]
 * @returns {object|null}
 */
export function pickLine(trigger, opts) {
  const pool = linesFor(trigger, opts);
  if (pool.length === 0) return null;

  let candidates = pool;
  const recent = opts?.recent;
  if (recent) {
    const has = recent instanceof Set
      ? (id) => recent.has(id)
      : Array.isArray(recent) ? (id) => recent.includes(id) : null;
    if (has) {
      const fresh = pool.filter((l) => !has(l.id));
      if (fresh.length) candidates = fresh;
    }
  }
  if (candidates.length === 1) return candidates[0];

  const rng = typeof opts?.rng === 'function' ? opts.rng : Math.random;
  let total = 0;
  for (const l of candidates) total += l.weight;
  let r = rng() * total;
  for (const l of candidates) {
    r -= l.weight;
    if (r <= 0) return l;
  }
  // Floating point can leave r a hair above zero after the last subtraction.
  return candidates[candidates.length - 1];
}

/** One line by its immutable id, or undefined. Frozen. */
export function byId(id) {
  return BY_ID.get(id);
}

/** One caller by id, or undefined. Frozen. */
export function castById(id) {
  return CAST_BY_ID.get(id);
}

/** Every line id, in declaration order. Frozen; the generation pass iterates it. */
export function allIds() {
  return ALL_IDS;
}

/** Whether a trigger may carry mature lines at all. */
export function isMatureAllowed(trigger) {
  return TRIGGER_META[trigger]?.matureAllowed === true;
}

/* ========================================================================== */
/* ENFORCEMENT                                                                */
/* ========================================================================== */

const wordCount = (s) => s.trim().split(/\s+/).length;

/**
 * Strings that MUST trip scanForbidden(). Run before any validation so a
 * filter that has silently stopped working cannot certify a library as clean.
 * This is the specific failure this project keeps producing: everything
 * reports green because the thing doing the reporting is dead.
 */
const CANARIES = Object.freeze([
  'you should go back to your own country',                 // hate construction
  'send me nudes right now',                                // sexual
  'i will kill you and your family',                        // threat
  'this is the fbi, open the door',                         // impersonation
  'find me at http://example.com',                          // link
]);

/**
 * Validate a corpus and THROW on any violation. Called at module load with no
 * arguments, which validates the shipped library; __selftest() calls it with
 * explicit fixtures to prove that it actually rejects them.
 *
 * @param {{lines?: object[], cast?: object[], full?: boolean}} [corpus]
 * @returns {{ok: true, warnings: string[], stats: object}}
 * @throws {Error} listing every violation found.
 */
export function validateLines(corpus) {
  const lines = corpus?.lines ?? ALL_LINES;
  const cast = corpus?.cast ?? CAST;
  // Structural checks (is the line filed under its own trigger and cast?) only
  // make sense for the real corpus, which is the only thing that has an index.
  const full = corpus?.full ?? (!corpus?.lines && !corpus?.cast);

  const errors = [];
  const warnings = [];

  /* ---- 0. the filter itself ------------------------------------------- */
  if (SLURS.length < 40) {
    errors.push(`the slur denylist decoded to ${SLURS.length} patterns — expected at least 40`);
  }
  for (const canary of CANARIES) {
    if (scanForbidden(canary).length === 0) {
      errors.push(`the content filter is BROKEN: it passed the canary "${canary}"`);
    }
  }
  if (scanProfanity('what the hell is happening').length === 0) {
    errors.push('the profanity filter is BROKEN: it passed a known profanity canary');
  }
  /* Regression canary for the leet-fold bug: `!` folds to `i`, so a
     single-view normaliser turned "shit!" into "shiti" and matched nothing.
     Any profanity word terminating a sentence must still be seen. */
  for (const canary of ['holy shit!', 'oh hell!', 'sh1t', 'd4mn it']) {
    if (scanProfanity(canary).length === 0) {
      errors.push(`the profanity filter is BROKEN: it passed the canary "${canary}"`);
    }
  }
  if (scanForbidden('the flamingos are unbothered').length !== 0) {
    errors.push('the content filter rejects an innocent control string — it is over-matching');
  }

  /* ---- 1. cast --------------------------------------------------------- */
  const castIds = new Set();
  const seeds = new Set();
  const castLineCount = new Map();
  for (const c of cast) {
    if (castIds.has(c.id)) errors.push(`duplicate caller id "${c.id}"`);
    castIds.add(c.id);
    castLineCount.set(c.id, 0);

    if (!SLUG_RE.test(c.id) || c.id.length > SLUG_MAX) {
      errors.push(`caller id "${c.id}" is not a filesystem-safe slug`);
    }
    for (const field of ['displayName', 'role', 'pool', 'blurb', 'voiceDirection', 'color']) {
      if (typeof c[field] !== 'string' || c[field].trim() === '') {
        errors.push(`caller "${c.id}" is missing ${field}`);
      }
    }
    if (!/^#[0-9a-f]{6}$/i.test(c.color || '')) {
      errors.push(`caller "${c.id}" color must be #rrggbb (hud.pushFeed takes a hex string)`);
    }
    if (!Number.isSafeInteger(c.avatarSeed) || c.avatarSeed <= 0) {
      errors.push(`caller "${c.id}" needs a positive integer avatarSeed`);
    } else if (seeds.has(c.avatarSeed)) {
      errors.push(`caller "${c.id}" reuses avatarSeed ${c.avatarSeed} — two callers would share a face`);
    } else {
      seeds.add(c.avatarSeed);
    }
    if (!(c.cooldown >= 0) || !Number.isFinite(c.cooldown)) {
      errors.push(`caller "${c.id}" needs a finite non-negative cooldown`);
    }
    /* The cast text is scanned too. A caller NAMED after a real person is the
       single likeliest way this file breaks policy, and no amount of scanning
       dialogue would catch it. */
    for (const field of ['displayName', 'blurb', 'voiceDirection', 'role']) {
      for (const why of scanForbidden(c[field] || '')) {
        errors.push(`caller "${c.id}" ${field} trips the hard filter: ${why}`);
      }
    }
    if (full && POOLS[c.pool] && !POOLS[c.pool].includes(c.id)) {
      errors.push(`caller "${c.id}" claims pool "${c.pool}" but POOLS does not list it`);
    }
    if (full && !POOLS[c.pool]) errors.push(`caller "${c.id}" has unknown pool "${c.pool}"`);
  }

  /* ---- 2. lines -------------------------------------------------------- */
  const seenExact = new Set();
  const seenLower = new Map();
  const seenText = new Map();
  let matureCount = 0;
  const tierCount = { mild: 0, medium: 0, strong: 0 };

  for (const line of lines) {
    const id = String(line?.id ?? '');

    if (seenExact.has(id)) errors.push(`duplicate line id "${id}" — one of the two is lost`);
    seenExact.add(id);

    if (!SLUG_RE.test(id)) errors.push(`id "${id}" is not [a-z0-9] with single hyphens`);
    if (id.length > SLUG_MAX) errors.push(`id "${id}" is ${id.length} chars, max ${SLUG_MAX}`);
    if (RESERVED_BASENAMES.has(id)) errors.push(`id "${id}" is a reserved Windows device name`);

    // Case-insensitive: these ids become files on case-insensitive disks,
    // where two ids differing only in case collapse into one clip.
    const lower = id.toLowerCase();
    if (seenLower.has(lower) && seenLower.get(lower) !== id) {
      errors.push(`id "${id}" collides with "${seenLower.get(lower)}" on a case-insensitive disk`);
    }
    seenLower.set(lower, id);

    if (!castIds.has(line.cast)) {
      errors.push(`line "${id}" has cast "${line.cast}" which is not in CAST`);
    } else {
      castLineCount.set(line.cast, castLineCount.get(line.cast) + 1);
    }

    if (!TRIGGER_SET.has(line.trigger)) {
      errors.push(`line "${id}" has unknown trigger "${line.trigger}" — it would never be selected`);
    }
    if (line.category !== line.trigger) {
      errors.push(`line "${id}" has category "${line.category}" but trigger "${line.trigger}" — the generator alias drifted`);
    }

    const t = line.text;
    if (typeof t !== 'string' || t.trim() === '') {
      errors.push(`line "${id}" has no text`);
      continue;
    }
    if (t !== t.trim()) errors.push(`line "${id}" has leading or trailing whitespace`);
    if (/\s{2,}/.test(t)) errors.push(`line "${id}" has a double space (TTS reads it as a stumble)`);
    if (!TEXT_CHARSET.test(t)) {
      errors.push(`line "${id}" uses a character outside the allowed set (no < > & " or ASCII apostrophe; use U+2019)`);
    }
    if (wordCount(t) > MAX_WORDS) errors.push(`line "${id}" is ${wordCount(t)} words, max ${MAX_WORDS}`);
    if (t.length > MAX_CHARS) errors.push(`line "${id}" is ${t.length} chars, max ${MAX_CHARS}`);

    /* ---- the hard filter. Applies at EVERY setting. ---- */
    for (const why of scanForbidden(t)) {
      errors.push(`line "${id}" is FORBIDDEN CONTENT at any setting: ${why}`);
    }

    /* ---- the mature gate ---- */
    const prof = scanProfanity(t);
    if (line.mature !== true && line.mature !== false) {
      errors.push(`line "${id}" must set mature explicitly to true or false`);
    }
    if (!line.mature && prof.length) {
      errors.push(`line "${id}" is mature:false but contains ${prof.join('/')} profanity`);
    }
    if (line.mature) {
      matureCount++;
      if (!MATURE_WEIGHT[line.matureTier]) {
        errors.push(`line "${id}" is mature but has no valid matureTier`);
      } else {
        tierCount[line.matureTier]++;
        if (line.weight !== MATURE_WEIGHT[line.matureTier]) {
          errors.push(`line "${id}" is tier ${line.matureTier} but weight is ${line.weight}, not ${MATURE_WEIGHT[line.matureTier]}`);
        }
      }
      if (!isMatureAllowed(line.trigger)) {
        errors.push(`line "${id}" is mature but trigger "${line.trigger}" forbids mature lines`);
      }
      if (!(line.cooldown >= MATURE_COOLDOWN_FLOOR)) {
        errors.push(`line "${id}" is mature with cooldown ${line.cooldown}s, floor is ${MATURE_COOLDOWN_FLOOR}s`);
      }
      if (!prof.length) {
        warnings.push(`line "${id}" is flagged mature but trips no profanity pattern — is the flag right?`);
      }
    }

    if (!(line.weight > 0) || !Number.isFinite(line.weight)) {
      errors.push(`line "${id}" needs a finite weight above zero`);
    }
    if (!(line.cooldown >= 0) || !Number.isFinite(line.cooldown)) {
      errors.push(`line "${id}" needs a finite non-negative cooldown`);
    }

    const norm = t.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    if (seenText.has(norm)) {
      warnings.push(`line "${id}" duplicates the text of "${seenText.get(norm)}" (two paid-for assets, one sentence)`);
    } else {
      seenText.set(norm, id);
    }

    if (full) {
      if (CAPTION[id] !== t) errors.push(`CAPTION["${id}"] does not match the line text`);
      if (!ALL_BY_TRIGGER.get(line.trigger)?.includes(line)) {
        errors.push(`line "${id}" is not filed under its trigger`);
      }
      if (!(LINES[line.trigger]?.[line.cast] || []).includes(line)) {
        errors.push(`line "${id}" is not filed under its cast`);
      }
      if (!line.mature && !MILD_BY_TRIGGER.get(line.trigger)?.includes(line)) {
        errors.push(`line "${id}" is mild but missing from the default (mature-off) pool`);
      }
      if (line.mature && MILD_BY_TRIGGER.get(line.trigger)?.includes(line)) {
        errors.push(`POLICY BREACH: mature line "${id}" is present in the mature-off pool`);
      }
      if (!id.startsWith(`${line.trigger}-`)) {
        warnings.push(`id "${id}" does not start with its trigger prefix "${line.trigger}-"`);
      }
    }
  }

  /* ---- 3. corpus-wide -------------------------------------------------- */
  if (full) {
    for (const trigger of TRIGGERS) {
      const n = MILD_BY_TRIGGER.get(trigger).length;
      if (n < MIN_LINES_PER_TRIGGER) {
        errors.push(`trigger "${trigger}" has ${n} mild line(s), needs ${MIN_LINES_PER_TRIGGER} — the default build must never run dry`);
      }
      const voices = Object.keys(LINES[trigger] || {}).length;
      if (voices < 2) warnings.push(`trigger "${trigger}" only uses ${voices} caller(s)`);
    }
    for (const key of Object.keys(SCRIPT)) {
      if (!TRIGGER_META[key]) errors.push(`SCRIPT has trigger "${key}" with no TRIGGER_META entry`);
    }
    if (Object.keys(CAPTION).length !== ALL_IDS.length) {
      errors.push('CAPTION and the line index are different sizes');
    }
    if (ALL_LINES.length !== BY_ID.size) {
      errors.push(`${ALL_LINES.length} lines collapsed into ${BY_ID.size} ids — an id is used twice`);
    }
    for (const [id, n] of castLineCount) {
      if (n === 0) warnings.push(`caller "${id}" has no lines and would never call`);
    }
  }

  if (errors.length) {
    throw new Error(
      `src/phone/callers.js: ${errors.length} content-policy or integrity violation(s).\n` +
      errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n')
    );
  }

  return {
    ok: true,
    warnings,
    stats: {
      callers: cast.length,
      triggers: TRIGGERS.length,
      lines: lines.length,
      mild: lines.length - matureCount,
      mature: matureCount,
      matureTiers: { ...tierCount },
      slurPatterns: SLURS.length,
    },
  };
}

/* ========================================================================== */
/* SELFTEST                                                                   */
/* ========================================================================== */

/**
 * Fixtures that MUST be rejected. The point of this list is to prove the
 * filter works rather than to prove the current library happens to be clean —
 * a validator that has quietly stopped matching would pass the library and
 * fail here.
 *
 * The slur cases are built by re-encoding from the same table (there is no way
 * to write them here without putting slurs back into the source), which makes
 * those three circular on the WORDS but not on the MACHINERY: they exercise
 * the leet-fold, the separator squeeze and the run-collapse, which are the
 * parts that actually break. Every other fixture is written in plain English
 * and is fully independent of the pattern table.
 */
function forbiddenFixtures() {
  const slur = decodeB64('cmV0YXJkZWQ=');            // ableist slur, S+C flagged
  const slur2 = decodeB64('ZmFnZ290');               // anti-LGBTQ slur, S+C flagged
  return [
    // -- slur machinery: leet, spacing, punctuation, stretching --------------
    [`you are being ${slur}`, 'plain slur'],
    [`you are being ${slur.replace(/e/g, '3').replace(/a/g, '4')}`, 'leet-folded slur'],
    [`you are being ${slur.split('').join(' ')}`, 'space-separated slur'],
    [`you are being ${slur.split('').join('.')}`, 'punctuation-separated slur'],
    [`stop being a ${slur2.replace('a', 'aaaa')}`, 'letter-stretched slur'],
    [`stop being a ${slur2.toUpperCase()}`, 'uppercase slur'],
    // -- hate speech / harassment of protected groups ------------------------
    ['go back to your own country', 'exclusionary hate'],
    ['immigrants are all vermin', 'dehumanising language'],
    ['we should deport them all', 'call for violence against a group'],
    ['no muslims allowed here', 'exclusion of a protected group'],
    ['kill all immigrants', 'call for violence against a group'],
    ['they want ethnic cleansing', 'genocidal reference'],
    // -- sexual content ------------------------------------------------------
    ['send me some nudes', 'sexual'],
    ['that was extremely erotic', 'sexual'],
    ['teen porn is on the channel', 'sexual involving minors'],
    // -- threats -------------------------------------------------------------
    ['i will kill you tonight', 'threat'],
    ['we will find you wherever you go', 'threat'],
    ['you should kill yourself', 'incitement'],
    ['someone will shoot up the school', 'mass violence'],
    // -- impersonation of something real -------------------------------------
    ['this is the fbi speaking', 'real agency'],
    ['the sheriffs department is coming', 'real agency'],
    ['i am calling from starbucks', 'real brand'],
    ['it drove off in a lamborghini', 'real brand'],
    ['visit www.example.org for more', 'link'],
    ['read the manual at https://example.com/x', 'link'],
    ['sounds just like the president', 'named impersonation'],
    ['do an impression of the singer', 'named impersonation'],
  ];
}

/**
 * Innocent strings that MUST NOT be rejected. This is the half of the test
 * that stops the filter from being widened until it is useless: substring
 * matching is a Scunthorpe machine and these are the words it eats first.
 */
const CLEAN_FIXTURES = Object.freeze([
  'the class passed the grass and the embassy',
  'a fire retardant foam covered the assessment area',
  'she squawked at the spikey shrubs near Pakistan',
  'the analysis of the therapist was buried in the bassline',
  'a cocoon in the tree and a raccoon on the road',
  'shiitake mushrooms on the scunthorpe road',
  'the specialist bought a cassette and some mussels',
  'Niger and Nigeria are countries, and niggling doubts are not',
  'he was a papal historian who studied crippling debt', // two religious/ableist patterns must not fire
  'the bass drum, the mass transit, the assassin novel',
  'Holy smoke, the flamingos are unbothered!',
]);

/**
 * ACCEPTED FALSE POSITIVES, pinned so they are documented behaviour rather
 * than a surprise at 2am.
 *
 * A few genuine slurs are spelled identically to ordinary English words. The
 * filter flags them, which means a legitimate line about a narrow gap of light
 * or about an earth embankment holding water back is REJECTED and must be
 * reworded — the two fixtures below spell out which words those are. That is
 * the deliberate trade: the cost is one rewrite, and the alternative — deleting
 * the pattern — is a real hole in a shipped hate-speech filter.
 *
 * If you arrived here because your line was rejected: reword the line. Do not
 * remove the pattern, and do not add an exception — an exception list is the
 * first thing an actual slur gets smuggled through.
 */
const KNOWN_OVERMATCH = Object.freeze([
  // Built from the encoded table rather than typed, so the two words stay out
  // of the plaintext of this file like every other pattern.
  `a ${decodeB64('Y2hpbms=')} of light under the door`,
  `the ${decodeB64('ZHlrZQ==')} held the water back`,
]);

/**
 * Headless. No DOM, no audio, no game. Run it from a node harness:
 *
 *     import { __selftest } from './src/phone/callers.js';
 *     const r = __selftest();
 *     if (!r.ok) { console.error(r.failures); process.exit(1); }
 *
 * @param {{draws?: number, seed?: number}} [opts]
 */
export function __selftest(opts) {
  const failures = [];
  const notes = [];
  const ok = (cond, msg) => { if (!cond) failures.push(msg); };

  /* ---- 1. the shipped library validates ------------------------------- */
  let report = null;
  try {
    report = validateLines();
  } catch (err) {
    failures.push(`validateLines() threw on the shipped library: ${err.message}`);
  }

  /* ---- 2. the filter rejects things it must reject --------------------- */
  for (const [text, why] of forbiddenFixtures()) {
    const hits = scanForbidden(text);
    ok(hits.length > 0, `filter MISSED a ${why} fixture: "${text}"`);
  }

  /* ---- 3. the filter does not eat innocent English --------------------- */
  for (const text of CLEAN_FIXTURES) {
    const hits = scanForbidden(text);
    ok(hits.length === 0, `filter FALSE-POSITIVED on "${text}" (${hits.join(', ')})`);
  }
  // The known, accepted over-matches are pinned in the OTHER direction: if one
  // of these stops tripping, somebody has quietly removed a slur pattern.
  for (const text of KNOWN_OVERMATCH) {
    ok(scanForbidden(text).length > 0,
      `a documented over-match stopped firing: "${text}" — was a slur pattern deleted?`);
  }

  /* ---- 3b. the profanity gate survives punctuation and leet ------------ */
  for (const text of ['Holy shit!', 'oh hell!', 'that is sh1t', 'd4mn it', 'BULLSHIT']) {
    ok(scanProfanity(text).length > 0, `profanity gate MISSED "${text}"`);
  }
  for (const text of ['the shell of the building', 'we passed the class', 'a hello from Miami']) {
    ok(scanProfanity(text).length === 0, `profanity gate FALSE-POSITIVED on "${text}"`);
  }

  /* ---- 4. validateLines() itself throws on a bad line ------------------ */
  // Not "the scanner returns hits" — the exported enforcement function must
  // actually refuse the corpus, because that is what runs at module load.
  const badCorpus = (text, extra) => ({
    cast: CAST,
    full: false,
    lines: [{
      id: 'fixture-bad-line', cast: 'rae-tolliver', text,
      trigger: 'ambient', category: 'ambient', weight: 1,
      mature: false, matureTier: null, cooldown: 90, ...extra,
    }],
  });
  const throws = (corpus, label) => {
    let threw = false;
    try { validateLines(corpus); } catch { threw = true; }
    ok(threw, `validateLines() did NOT throw for ${label}`);
  };
  throws(badCorpus('go back to your own country'), 'a hate-speech line');
  throws(badCorpus('send me some nudes'), 'a sexual line');
  throws(badCorpus('i will kill you tonight'), 'a threat');
  throws(badCorpus('this is the fbi speaking'), 'an impersonation');
  throws(badCorpus('what the hell is going on'), 'profanity on a mature:false line');
  throws(badCorpus('a perfectly fine line', { id: 'Fixture-Bad-Line' }), 'a non-slug id');
  throws(badCorpus('a perfectly fine line', { trigger: 'not-a-trigger', category: 'not-a-trigger' }), 'an unknown trigger');
  throws(badCorpus('a perfectly fine line', { cast: 'nobody' }), 'an unknown cast');
  throws(badCorpus('what the hell is going on', { mature: true, matureTier: 'mild', weight: MATURE_WEIGHT.mild, cooldown: 180 }),
    'a mature line on the ambient trigger');
  throws(badCorpus('a line with a <b> tag in it'), 'markup in the text');
  throws(badCorpus("that isn't allowed in a caption"), 'an ASCII apostrophe');
  throws(badCorpus('this line is masked with an f*ck in it'), 'masked profanity');
  // And a clean line must NOT throw, or the test above proves nothing.
  let cleanThrew = false;
  try { validateLines(badCorpus('a perfectly fine line')); } catch { cleanThrew = true; }
  ok(!cleanThrew, 'validateLines() threw on a clean fixture line — it rejects everything');

  /* ---- 5. mature OFF selects zero mature lines ------------------------- */
  // The headline guarantee. Thousands of draws, every trigger, default opts
  // and explicit mature:false, plus the per-cast filtered path.
  const draws = opts?.draws ?? 4000;
  let seed = (opts?.seed ?? 0x1a2b3c) >>> 0;
  const rng = () => {
    // xorshift32 — deterministic so a failure is reproducible.
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 4294967296;
  };

  let offDraws = 0, offMature = 0, offNull = 0;
  for (let i = 0; i < draws; i++) {
    const trigger = TRIGGERS[i % TRIGGERS.length];
    // Alternate between "no opts at all" and "mature explicitly false", and
    // every third draw also pins a caller, so the cast-filtered path is
    // covered too — that path builds a NEW array and is where a mature line
    // could realistically leak back in.
    const shape = i % 3;
    const o = shape === 0 ? { rng }
      : shape === 1 ? { rng, mature: false }
        : { rng, mature: false, cast: CAST[i % CAST.length].id };
    const line = pickLine(trigger, o);
    offDraws++;
    if (!line) { offNull++; continue; }
    if (line.mature) offMature++;
  }
  ok(offMature === 0, `POLICY BREACH: ${offMature} mature line(s) selected in ${offDraws} draws with mature OFF`);
  ok(offNull < draws * 0.2, `${offNull}/${offDraws} draws returned null — a trigger or caller pool is empty`);

  // Belt and braces: assert it structurally too, not only statistically.
  for (const trigger of TRIGGERS) {
    const pool = linesFor(trigger);
    ok(pool.every((l) => !l.mature), `linesFor("${trigger}") with mature off contains a mature line`);
    for (const c of CAST) {
      ok(linesFor(trigger, { cast: c.id }).every((l) => !l.mature),
        `linesFor("${trigger}", {cast:"${c.id}"}) with mature off contains a mature line`);
    }
  }

  /* ---- 6. mature ON is rare, and actually reachable -------------------- */
  let onMature = 0, onDraws = 0;
  for (let i = 0; i < draws; i++) {
    const trigger = TRIGGERS[i % TRIGGERS.length];
    const line = pickLine(trigger, { rng, mature: true });
    if (!line) continue;
    onDraws++;
    if (line.mature) onMature++;
  }
  const share = onDraws ? onMature / onDraws : 0;
  ok(onMature > 0, 'with mature ON, no mature line was ever selected — the pool is not wired up');
  ok(share < 0.12, `with mature ON, mature lines were ${(share * 100).toFixed(1)}% of picks — that is a stream, not a spice`);
  notes.push(`mature share with the setting ON: ${(share * 100).toFixed(2)}% over ${onDraws} draws`);

  /* ---- 7. recency and determinism -------------------------------------- */
  const all = linesFor('ambient');
  const recent = new Set(all.slice(0, all.length - 1).map((l) => l.id));
  const forced = pickLine('ambient', { recent, rng });
  ok(forced && forced.id === all[all.length - 1].id, 'recent[] did not steer the pick to the one fresh line');
  const exhausted = pickLine('ambient', { recent: new Set(all.map((l) => l.id)), rng });
  ok(exhausted !== null, 'an exhausted recent[] returned null instead of falling back to the full pool');

  let a = 0x99, b = 0x99;
  const mk = (s) => () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const seqA = Array.from({ length: 40 }, () => pickLine('ate-car', { rng: mk(a++) })?.id);
  const seqB = Array.from({ length: 40 }, () => pickLine('ate-car', { rng: mk(b++) })?.id);
  ok(seqA.join() === seqB.join(), 'pickLine is not deterministic for a given rng — replays will diverge');

  /* ---- 8. index integrity ---------------------------------------------- */
  ok(allIds().length === ALL_LINES.length, 'allIds() and ALL_LINES disagree — an id is duplicated');
  ok(Object.keys(CAPTION).length === allIds().length, 'CAPTION is a different size to the id index');
  for (const id of allIds()) ok(typeof byId(id)?.text === 'string', `byId("${id}") did not round-trip`);
  for (const c of CAST) ok(castById(c.id) === c, `castById("${c.id}") did not round-trip`);
  ok(Object.isFrozen(linesFor('ambient')), 'linesFor() returned a mutable array');

  const perTrigger = {};
  for (const t of TRIGGERS) {
    perTrigger[t] = {
      mild: MILD_BY_TRIGGER.get(t).length,
      mature: ALL_BY_TRIGGER.get(t).length - MILD_BY_TRIGGER.get(t).length,
    };
  }

  return {
    ok: failures.length === 0,
    failures,
    notes,
    warnings: report?.warnings ?? [],
    stats: {
      ...(report?.stats ?? {}),
      pools: Object.keys(POOLS).length,
      perTrigger,
      matureShareOn: Number((share * 100).toFixed(2)),
      forbiddenFixtures: forbiddenFixtures().length,
      cleanFixtures: CLEAN_FIXTURES.length,
    },
  };
}

/* ==========================================================================
 * ENFORCE AT LOAD.
 *
 * Last statement in the file, after every const it reads is initialised —
 * `node --check` does not catch a temporal dead zone and four have shipped in
 * this project. A violating line now throws on import and the game does not
 * boot, which is the entire point: a content policy that only warns is a
 * content policy that ships.
 * ========================================================================== */
validateLines();
