/**
 * MIAMI DEVOUR — FICTIONAL VOICE CAST + LINE LIBRARY.
 *
 * ###########################################################################
 * # ABSOLUTE RULE — READ BEFORE ADDING A SINGLE LINE                        #
 * #                                                                         #
 * # Every voice in this file is an ORIGINAL FICTIONAL CHARACTER. Nobody in  #
 * # here is, resembles, is named after, or is voiced "in the style of" a    #
 * # real person. No celebrity. No identifiable streamer, actor, athlete or  #
 * # politician. No catchphrase lifted from a real person or a real show.    #
 * # No real police force, agency, department, call sign, slogan or ten-code #
 * # — the responder agency in this game is the invented "City Response",    #
 * # and its procedure words are invented too, so nothing here can be heard  #
 * # as a recording of a real service.                                       #
 * #                                                                         #
 * # If you are about to add a line because it sounds like somebody: stop.   #
 * # That is the exact thing this file exists to prevent. A voiceDirection   #
 * # describes AGE, TIMBRE, PACE and ATTITUDE. It never names a human being. #
 * ###########################################################################
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS
 *
 * Pure data. No Web Audio, no <audio>, no fetch, no scheduling, no state. The
 * playback layer (cooldown bookkeeping, concurrency cap, distance culling,
 * caption display, asset loading) lives elsewhere and imports from here. That
 * split is deliberate: this corpus is also read by the OFFLINE generation
 * pass that turns each line into an audio asset, and that pass runs in Node
 * with no DOM. A single `import` of a browser API here would break it.
 *
 * ---------------------------------------------------------------------------
 * THE `id` IS AN ASSET FILENAME. IT IS IMMUTABLE.
 *
 * Each line's `id` becomes the base name of a generated audio file. Once a
 * line has been generated and shipped, changing its id orphans the asset and
 * silently mutes the line — the loader asks for a file that is not there and
 * a missing voice clip looks exactly like a voice that simply did not trigger.
 * So: ids are append-only. Retire a line by deleting it; never rename one.
 *
 * Ids are constrained to [a-z0-9-] for reasons that have all bitten somebody:
 *   - macOS (APFS, case-insensitive by default) and Windows would collapse
 *     `Notice-Mina` and `notice-mina` into one file, so the second generated
 *     clip overwrites the first and one line plays the wrong voice. The
 *     selftest therefore checks uniqueness CASE-INSENSITIVELY.
 *   - Windows still refuses to create `con.mp3`, `aux.mp3`, `nul.mp3`, so
 *     reserved device basenames are rejected outright.
 *   - No spaces, dots or slashes: these ids get concatenated into shell
 *     commands, URLs and a CSV manifest by the generation pass.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TEXT LOOKS SLIGHTLY ODD
 *
 * Every line is BOTH spoken by a TTS engine AND printed as a caption. The
 * caption path ends at `hud.pushFeed()`, which assigns to `innerHTML`. Rather
 * than trust every future caller to escape, the corpus itself is kept free of
 * `< > & "` and the ASCII apostrophe, so a caption physically cannot open a
 * tag or break out of an attribute. Contractions use the typographic
 * apostrophe U+2019 (’) instead — it is not an HTML delimiter, and every TTS
 * engine reads "that’s" and "that's" identically. Callers should still escape;
 * this is a second lock on the same door, not a licence to skip the first.
 *
 * Lines are short on purpose. Twelve words is roughly two seconds of speech,
 * which is the longest a reaction can be before the hole has moved on and the
 * NPC is shouting about a bench that no longer exists.
 *
 * ---------------------------------------------------------------------------
 * SHAPE
 *
 *   CAST            [{ id, displayName, blurb, voiceDirection, role,
 *                      color, cooldown }]
 *   CATEGORY_META   { category: { label, defaultCooldown, priority } }
 *   CATEGORIES      [category, ...] in declaration order
 *   LINES           { category: { castId: [line, ...] } }      <- spec shape
 *   CAPTION         { lineId: text }
 *   line            { id, cast, text, category, weight, cooldown }
 *
 * `LINES` is GENERATED from a flat authoring list at the bottom-of-file build
 * step, never hand-nested. Hand-nesting means the category appears twice (as
 * the key and as the field) and the cast appears twice, and the day those two
 * copies disagree is the day a tourist starts reading the dispatcher's lines
 * with nothing in the console to explain it.
 *
 * Everything exported is deep-frozen. The playback layer will want to stamp
 * "last played at" somewhere: it must key that off `line.id` in its own map.
 * Writing it onto the line object would leak per-match state into a module
 * singleton that outlives the match — and, since ESM is strict mode, the
 * freeze turns that mistake into a thrown error instead of a slow leak.
 */

/* ========================================================================== */
/* LIMITS                                                                     */
/* ========================================================================== */

/** ~2 s of speech. Past this a reaction lands after the moment it reacts to. */
export const MAX_WORDS = 12;

/** Belt to the word-count braces: catches one absurdly long compound word. */
export const MAX_CHARS = 76;

/** A category with fewer than this cannot vary, so the city sounds like a loop. */
export const MIN_LINES_PER_CATEGORY = 3;

/** Filename-safe slug: lowercase, digits, single hyphens, 3..48 chars. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX = 48;

/* Windows refuses to create a file with one of these basenames, extension or
   not. The generation pass writes one file per id, so an id of `con` produces
   a build that works on the author's Mac and fails on a colleague's PC. */
const RESERVED_BASENAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/* A tripwire, not a content filter. It exists so that a future contributor in
   a hurry cannot quietly land a real agency name, a social handle, a URL or
   casual profanity in a corpus that gets spoken aloud to every player. If a
   legitimate line trips it, widen the line — do not widen the regex. */
const FORBIDDEN = [
  { why: 'real agency or force name', re: /\b(fbi|cia|dea|nypd|lapd|swat|police department|sheriff)\b/i },
  { why: 'link or social handle', re: /(https?:|www\.|@[a-z0-9])/i },
  { why: 'profanity', re: /\b(damn|hell|crap|ass|arse|bastard|piss|shit|f+u+c+k\w*|bitch)\b/i },
  { why: 'markup or quoting hazard', re: /[<>&"']/ },
  { why: 'control character', re: /[\u0000-\u001f\u007f]/ },
];

/* ========================================================================== */
/* THE CAST                                                                   */
/* ========================================================================== */

/**
 * Ten voices, one per role in the design brief, so an NPC of any kind has a
 * voice that fits it without borrowing one that does not.
 *
 * Names were invented for this file and checked against nobody real; they are
 * deliberately plain-but-uncommon so they cannot be mistaken for a reference.
 *
 * FIELDS
 *   role      matches the brief's role list; the NPC system maps a pedestrian
 *             kind to a role, not to a specific voice, so recasting a role is
 *             a one-line change here rather than a sweep through the world.
 *   color     caption accent. `hud.pushFeed(html, color, kind)` takes a hex
 *             string, so captions can be colour-coded by speaker — and per the
 *             accessibility rule colour is never the ONLY signal: the caption
 *             also carries displayName.
 *   cooldown  seconds before THIS VOICE speaks again, at all, anywhere. The
 *             per-line cooldown stops one sentence repeating; this one stops
 *             a single character narrating the entire match.
 */
export const CAST = [
  {
    id: 'mina-sol',
    displayName: 'Mina Sol',
    role: 'tourist',
    blurb: 'Three days into her first trip. Filming the sinkhole is the best thing that has happened to her all week.',
    voiceDirection:
      'Woman, late twenties. Bright forward mid-range with a laugh sitting just under every line. Fast, clipped, ' +
      'sentences rising at the end. Delighted rather than frightened. A small intake of breath before the punchline.',
    color: '#ffd166',
    cooldown: 9,
  },
  {
    id: 'orla-fenn',
    displayName: 'Orla Fenn',
    role: 'local',
    blurb: 'Lives four floors up on this block and knows exactly what everything on the street cost.',
    voiceDirection:
      'Woman, forties. Warm low alto with a little sandpaper on the consonants. Measured pace that accelerates when ' +
      'she is alarmed, then drops back. Protective, tired, faintly exasperated. Never shrill, never screams.',
    color: '#7ee0c2',
    cooldown: 10,
  },
  {
    id: 'dax-perrone',
    displayName: 'Dax Perrone',
    role: 'restaurant',
    blurb: 'Line cook on a smoke break by the back door, still holding a tray he refuses to put down.',
    voiceDirection:
      'Man, thirties. Mid baritone with a nasal edge, pitched to carry over an extractor fan. Rapid, flat, deadpan. ' +
      'Annoyed about the furniture rather than afraid of the hole. Ends lines abruptly, no fade.',
    color: '#ff9f5a',
    cooldown: 11,
  },
  {
    id: 'jun-marrow',
    displayName: 'Jun Marrow',
    role: 'creator',
    blurb: 'Films everything vertically. Would sooner lose the scooter than lose the shot.',
    voiceDirection:
      'Androgynous, early twenties, light tenor. Performed energy aimed at a camera held at arm’s length: punchy, ' +
      'over-articulated, heavy upward inflection, occasional squeak on the loudest word. Excited and mercenary.',
    color: '#c084fc',
    cooldown: 12,
  },
  {
    id: 'tavo-reyes',
    displayName: 'Tavo Reyes',
    role: 'driver',
    blurb: 'Twenty-two years driving these streets. Has an opinion about the road closure, and about you.',
    voiceDirection:
      'Man, fifties. Gravelly baritone with big chest resonance, delivered through an open car window. Unhurried, ' +
      'sardonic, leans weight onto the final word of every sentence. Sounds like he is about to use the horn.',
    color: '#ffe066',
    cooldown: 12,
  },
  {
    id: 'marla-quist',
    displayName: 'Marla Quist',
    role: 'security',
    blurb: 'Guards a plaza that is currently one third smaller than it was this morning.',
    voiceDirection:
      'Woman, thirties. Firm, level, radio-clear diction with trained projection — loud without shouting. Even pace, ' +
      'downward inflection, no filler words. Professional calm with a hairline crack starting to show.',
    color: '#4dd2ff',
    cooldown: 10,
  },
  {
    id: 'ike-dorsett',
    displayName: 'Ike Dorsett',
    role: 'cityworker',
    blurb: 'Public works. Came to fix a water main. This has become a considerably larger form to fill in.',
    voiceDirection:
      'Man, sixties. Dry rumbling low bass, slow, entirely unbothered. Long pauses mid-sentence. Reports a ' +
      'catastrophe in the cadence of a weather forecast. Never raises pitch, never hurries.',
    color: '#f4a259',
    cooldown: 14,
  },
  {
    id: 'dispatch-vale',
    displayName: 'Vale — City Response',
    role: 'dispatch',
    /* "City Response" is an invented municipal service. It is not a real
       agency and must never be renamed to one; see the rule at the top. */
    blurb: 'The voice on the City Response channel. City Response is an invented service that exists only in this game.',
    voiceDirection:
      'Woman, forties, heard through a narrow band-limited radio with a click at the start of each transmission. ' +
      'Clipped procedural cadence, completely level, no emotion and no jokes. Short phrases, hard stops.',
    color: '#ff6b6b',
    cooldown: 13,
  },
  {
    id: 'zee-mabry',
    displayName: 'Zee Mabry',
    role: 'teen',
    blurb: 'Was up by six points. The court is now a slope.',
    voiceDirection:
      'Teenager, sixteen, unsettled tenor that cracks upward under excitement. Very fast, words overlapping, ' +
      'consonants half-swallowed. Competitive first and alarmed second — the score matters more than the hole.',
    color: '#ff4fd8',
    cooldown: 9,
  },
  {
    id: 'odetta-frame',
    displayName: 'Odetta Frame',
    role: 'elder',
    blurb: 'Feeds the birds from the same bench every morning. The bench is gone. The birds are fine.',
    voiceDirection:
      'Woman, late seventies. Thin, clear, high soprano with a gentle natural tremor. Slow and deliberate with ' +
      'generous pauses. Amused, unhurried, entirely unimpressed — she has seen worse than this.',
    color: '#a3e635',
    cooldown: 16,
  },
];

/* ========================================================================== */
/* CATEGORIES                                                                 */
/* ========================================================================== */

/**
 * Per-category policy that belongs with the words rather than with the player.
 *
 *   label            caption/debug heading, human readable.
 *   defaultCooldown  seconds before the same LINE may play again, unless the
 *                    line overrides it. Chosen per category because a "notice"
 *                    fires constantly and a storm alert fires twice a match.
 *                    240 s is one Classic match (see modes.js), so anything at
 *                    or above it is effectively once-per-match.
 *   priority         tie-break for the 2–3 voice concurrency cap. When the cap
 *                    is full the lower number is the one that gets dropped, so
 *                    a warning always beats a tourist enjoying herself.
 */
export const CATEGORY_META = {
  notice: { label: 'Notice', defaultCooldown: 25, priority: 1 },
  flee: { label: 'Flee', defaultCooldown: 20, priority: 2 },
  nearMiss: { label: 'Near miss', defaultCooldown: 30, priority: 3 },
  propEaten: { label: 'Prop eaten', defaultCooldown: 25, priority: 2 },
  carDanger: { label: 'Car in danger', defaultCooldown: 30, priority: 3 },
  creator: { label: 'Creator', defaultCooldown: 40, priority: 1 },
  policeWarning: { label: 'Response warning', defaultCooldown: 35, priority: 4 },
  court: { label: 'Basketball court', defaultCooldown: 60, priority: 2 },
  zoo: { label: 'Animal habitat', defaultCooldown: 60, priority: 2 },
  stormStart: { label: 'Storm begins', defaultCooldown: 240, priority: 4 },
  stormEnd: { label: 'Storm clears', defaultCooldown: 240, priority: 2 },
  heatUp: { label: 'Heat rising', defaultCooldown: 60, priority: 4 },
  heatDown: { label: 'Heat falling', defaultCooldown: 60, priority: 2 },
  powerup: { label: 'Power-up reaction', defaultCooldown: 45, priority: 3 },
  matchStart: { label: 'Match start', defaultCooldown: 999, priority: 3 },
  matchEnd: { label: 'Match end', defaultCooldown: 999, priority: 3 },
};

/** Declaration order, which is also the order a debug overlay should list. */
export const CATEGORIES = Object.freeze(Object.keys(CATEGORY_META));

/* ========================================================================== */
/* THE SCRIPT                                                                 */
/* ========================================================================== */

/**
 * Authoring form: flat, one array per category, category stamped on during the
 * build. `weight` is a relative pick weight inside the (category, cast) pool —
 * 1 is normal, below 1 is a line that should stay a surprise. The rare louder
 * comic lines sit at 0.25–0.5 with a long cooldown so a player hears them
 * occasionally rather than every match.
 *
 * @param {string} id    immutable, filename-safe; see the header.
 * @param {string} cast  must exist in CAST.
 * @param {string} text  <= MAX_WORDS words, no markup characters.
 * @param {{weight?:number, cooldown?:number}} [opts]
 */
function ln(id, cast, text, opts) {
  return { id, cast, text, weight: opts?.weight ?? 1, cooldown: opts?.cooldown };
}

const SCRIPT = {
  /* First sighting. The commonest category by a wide margin, so it needs the
     most variety — a repeated "notice" is the line players hear most often. */
  notice: [
    ln('notice-mina-sinkhole', 'mina-sol', 'Uh... is that a sinkhole?'),
    ln('notice-mina-street-thing', 'mina-sol', 'Wait, wait, the street’s doing a thing.'),
    ln('notice-orla-not-this-morning', 'orla-fenn', 'That wasn’t there this morning.'),
    ln('notice-dax-eating-patio', 'dax-perrone', 'Hey! Something’s eating the patio.'),
    ln('notice-tavo-new-pothole', 'tavo-reyes', 'Whoa. New pothole, huh?'),
    ln('notice-marla-movement-plaza', 'marla-quist', 'I’ve got movement in the plaza.'),
    ln('notice-ike-that-is-a-hole', 'ike-dorsett', 'Well. That’s a hole.'),
    ln('notice-odetta-how-unusual', 'odetta-frame', 'Oh. How unusual.'),
    ln('notice-zee-look-at-the-ground', 'zee-mabry', 'Yo, look at the ground!'),
    ln('notice-jun-seeing-this-sidewalk', 'jun-marrow', 'Chat, are you seeing this sidewalk?'),
    /* The one stronger comic line the brief allows, verbatim from it. Rare and
       aimed at the city, not at a player — 0.25 weight, 150 s lockout. */
    ln('notice-tavo-what-the-heck', 'tavo-reyes', 'What the heck is happening downtown?',
      { weight: 0.25, cooldown: 150 }),
  ],

  flee: [
    ln('flee-mina-nope', 'mina-sol', 'Nope, nope, nope!'),
    ln('flee-orla-off-the-sidewalk', 'orla-fenn', 'Everyone off the sidewalk, now!'),
    ln('flee-dax-out-the-back', 'dax-perrone', 'Out the back! Out the back!'),
    ln('flee-jun-running-and-filming', 'jun-marrow', 'Running and filming! Running and filming!'),
    ln('flee-tavo-reversing', 'tavo-reyes', 'I’m reversing. I’m reversing!'),
    ln('flee-zee-go-go-go', 'zee-mabry', 'Go, go, go, go!'),
    ln('flee-marla-clear-the-plaza', 'marla-quist', 'Clear the plaza! Move!'),
    ln('flee-odetta-walk-briskly', 'odetta-frame', 'I shall walk briskly, thank you.'),
    ln('flee-ike-leaving-now', 'ike-dorsett', 'Yep. I’m leaving now.'),
  ],

  nearMiss: [
    ln('near-miss-mina-way-too-close', 'mina-sol', 'That was way too close!'),
    ln('near-miss-zee-got-my-shoe', 'zee-mabry', 'It got my shoe! It got my shoe!'),
    ln('near-miss-dax-one-more-step', 'dax-perrone', 'One more step and that was me.'),
    /* Taunting the player is the joke; it stays rare so it never reads mean. */
    ln('near-miss-tavo-you-missed', 'tavo-reyes', 'You missed. Try harder.', { weight: 0.4 }),
    ln('near-miss-orla-my-actual-heart', 'orla-fenn', 'My heart. My actual heart.'),
    ln('near-miss-jun-that-was-the-clip', 'jun-marrow', 'Clip that! That was the clip!'),
    ln('near-miss-odetta-nearly-the-bench', 'odetta-frame', 'Goodness. Nearly took the whole bench.'),
    ln('near-miss-marla-backing-off', 'marla-quist', 'Too close. Backing off.'),
  ],

  propEaten: [
    ln('prop-eaten-orla-my-table', 'orla-fenn', 'My table just disappeared!'),
    ln('prop-eaten-dax-whole-patio', 'dax-perrone', 'There goes the whole patio.'),
    ln('prop-eaten-dax-espresso-machine', 'dax-perrone', 'Not the espresso machine. Anything but that.'),
    ln('prop-eaten-ike-city-property', 'ike-dorsett', 'That bench was city property.'),
    ln('prop-eaten-odetta-sitting-there', 'odetta-frame', 'I was sitting there. Recently.'),
    ln('prop-eaten-marla-barrier-and-sign', 'marla-quist', 'It took the barrier. And the sign.'),
    ln('prop-eaten-tavo-parking-meter', 'tavo-reyes', 'There went a whole parking meter.'),
    ln('prop-eaten-mina-whole-palm-tree', 'mina-sol', 'It ate a palm tree. A whole palm tree.'),
    ln('prop-eaten-zee-bike-rack', 'zee-mabry', 'It ate the bike rack!'),
  ],

  carDanger: [
    ln('car-danger-tavo-move-the-car', 'tavo-reyes', 'Move the car! Move the car!'),
    ln('car-danger-orla-that-is-my-car', 'orla-fenn', 'That’s my car. That’s my car!'),
    ln('car-danger-marla-van-off-plaza', 'marla-quist', 'Get the van off the plaza!'),
    ln('car-danger-dax-truck-sliding', 'dax-perrone', 'The delivery truck is sliding!'),
    ln('car-danger-ike-nobody-park-here', 'ike-dorsett', 'Nobody park on this block.'),
    ln('car-danger-mina-taxi-tilting', 'mina-sol', 'Is that taxi tilting?'),
    ln('car-danger-jun-get-the-angle', 'jun-marrow', 'The car’s going in! Get the angle!'),
    ln('car-danger-tavo-not-the-taxi', 'tavo-reyes', 'Not the taxi. Anything but the taxi.'),
  ],

  /* Mostly Jun, because the creator category IS the creator. Two outside
     voices exist so a block with no scooter in it can still use the category. */
  creator: [
    ln('creator-jun-not-going-to-believe', 'jun-marrow', 'Chat, you’re not going to believe this!'),
    ln('creator-jun-new-upload', 'jun-marrow', 'New upload, and it’s a sinkhole.'),
    ln('creator-jun-like-subscribe-evacuate', 'jun-marrow', 'Like, subscribe, evacuate!', { weight: 0.5 }),
    ln('creator-jun-getting-closer', 'jun-marrow', 'Hold on, I’m getting closer.'),
    ln('creator-jun-somebody-clip-that', 'jun-marrow', 'Somebody clip that. Somebody clip that!'),
    ln('creator-mina-please-be-filming', 'mina-sol', 'Are you filming? Please be filming.'),
    ln('creator-zee-put-me-in-the-video', 'zee-mabry', 'Put me in the video!'),
  ],

  /* Responder warnings. Invented service, invented procedure words, no real
     call signs and no ten-codes — a real code is the fastest way for a comedy
     line to start sounding like a recording of an actual incident. */
  policeWarning: [
    ln('police-warning-marla-street-furniture', 'marla-quist', 'Hey! Stop eating the street furniture!'),
    ln('police-warning-ike-not-a-parking-space', 'ike-dorsett', 'That is not a parking space!'),
    ln('police-warning-vale-move-away-plaza', 'dispatch-vale', 'Please move away from the plaza!'),
    ln('police-warning-vale-bigger-containment', 'dispatch-vale', 'We need a bigger containment unit!'),
    ln('police-warning-marla-keep-back', 'marla-quist', 'Everybody, keep back!'),
    ln('police-warning-vale-headed-downtown', 'dispatch-vale', 'The sinkhole is headed downtown!'),
    ln('police-warning-marla-brand-new-patrol-car', 'marla-quist', 'That was a brand-new patrol car!'),
    ln('police-warning-ike-step-away-crosswalk', 'ike-dorsett', 'Step away from the crosswalk. Please.'),
    ln('police-warning-vale-hold-perimeter', 'dispatch-vale', 'All units, hold the perimeter.'),
  ],

  /* The basketball courts reserved in cityLayout.js — `b.court` blocks, mesh
     name 'basketball-court'. Zee is the resident, everyone else is a bystander. */
  court: [
    ln('court-zee-going-under', 'zee-mabry', 'Hey, the court is going under!'),
    ln('court-zee-game-point', 'zee-mabry', 'That was game point!'),
    ln('court-zee-my-ball', 'zee-mabry', 'My ball. My ball went in the hole.'),
    ln('court-odetta-children-lost-court', 'odetta-frame', 'The children have lost their court.'),
    ln('court-mina-hoop-tipped-over', 'mina-sol', 'The hoop just tipped over!'),
    ln('court-marla-everyone-off-court', 'marla-quist', 'Everyone off the court. Right now.'),
  ],

  /* The reserved park habitat clearing. Kept gentle on purpose: animals in
     distress is the one place this game's comedy stops being funny, so every
     line here is about getting them out safely, never about eating them. */
  zoo: [
    ln('zoo-marla-safe-route', 'marla-quist', 'The animals need a safe route!'),
    ln('zoo-odetta-open-the-far-gate', 'odetta-frame', 'Open the far gate for the birds.'),
    ln('zoo-ike-fence-down-at-habitat', 'ike-dorsett', 'Fence is down at the habitat.'),
    ln('zoo-mina-flamingos-are-calm', 'mina-sol', 'The flamingos are so calm about this.'),
    ln('zoo-orla-count-the-animals', 'orla-fenn', 'Somebody count the animals, please.'),
    ln('zoo-odetta-pelicans-flew-off', 'odetta-frame', 'The pelicans have simply flown off.'),
  ],

  stormStart: [
    ln('storm-start-ike-off-the-bay', 'ike-dorsett', 'Storm coming in off the bay.'),
    ln('storm-start-orla-looks-mean', 'orla-fenn', 'Get inside. This one looks mean.'),
    ln('storm-start-dax-umbrellas-in', 'dax-perrone', 'Bring the umbrellas in! Now!'),
    ln('storm-start-vale-low-visibility', 'dispatch-vale', 'Storm alert. All units, low visibility.'),
    ln('storm-start-mina-raining-sideways', 'mina-sol', 'It’s raining sideways. Amazing.'),
    ln('storm-start-tavo-rain-plus-sinkhole', 'tavo-reyes', 'Rain and a sinkhole. Wonderful.'),
  ],

  /* An event that announces its arrival and never its departure leaves the
     player unsure whether the weather still matters. Cheap to author, and it
     is the audio half of the storm's fade-out. */
  stormEnd: [
    ln('storm-end-ike-worst-of-it-gone', 'ike-dorsett', 'That’s the worst of it gone.'),
    ln('storm-end-odetta-little-sunshine', 'odetta-frame', 'There. A little sunshine already.'),
    ln('storm-end-dax-everything-soaked', 'dax-perrone', 'Everything out here is soaked.'),
    ln('storm-end-mina-lot-of-water', 'mina-sol', 'Okay. That was a lot of water.'),
  ],

  heatUp: [
    ln('heat-up-vale-level-rising', 'dispatch-vale', 'Response level rising. Stay clear.'),
    ln('heat-up-marla-bring-the-barriers', 'marla-quist', 'We’re escalating. Bring the barriers.'),
    ln('heat-up-ike-big-trucks', 'ike-dorsett', 'They’re calling in the big trucks.'),
    ln('heat-up-vale-units-inbound', 'dispatch-vale', 'Containment units inbound to your block.'),
    ln('heat-up-tavo-now-you-are-in-trouble', 'tavo-reyes', 'Now you’re in trouble, my friend.'),
    ln('heat-up-orla-lights-and-sirens', 'orla-fenn', 'Here come the lights and the sirens.'),
  ],

  /* Heat decay is invisible without this — the player needs to hear that
     backing off worked, or the meter reads as a punishment with no exit. */
  heatDown: [
    ln('heat-down-vale-standing-down', 'dispatch-vale', 'Response standing down. Perimeter holding.'),
    ln('heat-down-marla-all-quiet', 'marla-quist', 'Lost sight of it. All quiet.'),
    ln('heat-down-ike-calmed-down-fast', 'ike-dorsett', 'Well. That calmed down fast.'),
    ln('heat-down-tavo-gave-up-already', 'tavo-reyes', 'They gave up already?'),
  ],

  /* Reaction to a power-up being live — written for Vacuum Boost, because a
     wider suction radius is the one power-up a bystander can actually SEE. */
  powerup: [
    ln('powerup-jun-look-at-that-pull', 'jun-marrow', 'It just got hungrier. Look at that pull!'),
    ln('powerup-mina-everything-sliding', 'mina-sol', 'Everything’s sliding toward it!'),
    ln('powerup-dax-hold-on-to-something', 'dax-perrone', 'Hold on to something!'),
    ln('powerup-marla-pulling-harder', 'marla-quist', 'It’s pulling harder. Fall back.'),
  ],

  /* Ordinary-morning lines. They play BEFORE anything has gone wrong, so none
     of them may mention the hole — that is the joke. */
  matchStart: [
    ln('match-start-mina-show-me-something', 'mina-sol', 'Okay Miami. Show me something.'),
    ln('match-start-tavo-watch-the-road', 'tavo-reyes', 'Beautiful day. Watch the road.'),
    ln('match-start-jun-say-hello-downtown', 'jun-marrow', 'We’re live! Say hello, downtown.'),
    ln('match-start-vale-quiet-morning', 'dispatch-vale', 'All units, normal patrol. Quiet morning.'),
    ln('match-start-zee-first-basket', 'zee-mabry', 'First basket of the day. Easy.'),
    ln('match-start-odetta-same-bench', 'odetta-frame', 'Same bench, same birds. Lovely.'),
  ],

  matchEnd: [
    ln('match-end-ike-somebody-has-paperwork', 'ike-dorsett', 'Well. Somebody has paperwork to do.'),
    ln('match-end-orla-is-it-over', 'orla-fenn', 'Is it over? Is it actually over?'),
    ln('match-end-mina-best-holiday', 'mina-sol', 'Best holiday I’ve ever had.'),
    ln('match-end-jun-the-whole-video', 'jun-marrow', 'That’s the video. That’s the whole video.'),
    ln('match-end-vale-incident-closed', 'dispatch-vale', 'Incident closed. Begin the damage survey.'),
    ln('match-end-odetta-new-bench', 'odetta-frame', 'I shall need a new bench.'),
    ln('match-end-tavo-need-a-ride', 'tavo-reyes', 'Anyone need a ride out of here?'),
    ln('match-end-dax-we-are-closed', 'dax-perrone', 'We’re closed. Obviously.'),
  ],
};

/* ========================================================================== */
/* BUILD                                                                      */
/* ========================================================================== */

/* Everything below is derived. Nothing here decides content; it only reshapes
   SCRIPT into the lookups the runtime needs, and freezes the result. */

const BY_ID = new Map();
const CAST_BY_ID = new Map();
const FLAT_BY_CATEGORY = new Map(); // category -> frozen [line, ...]
const EMPTY = Object.freeze([]);

/* Every line object in declaration order, INCLUDING any that share an id.
   BY_ID would silently swallow a duplicate — the second `set` overwrites the
   first and the corpus quietly loses a line — so the selftest walks this
   instead. That miss is not hypothetical: the duplicate-id case was the one
   fault the first version of the selftest failed to catch. */
const ALL_LINES = [];

for (const c of CAST) CAST_BY_ID.set(c.id, Object.freeze(c));

/** @type {Record<string, Record<string, ReadonlyArray<object>>>} */
export const LINES = {};

/** id -> text. Captions must work with audio muted, missing or still loading. */
export const CAPTION = {};

for (const category of CATEGORIES) {
  const meta = CATEGORY_META[category];
  const rows = SCRIPT[category] || [];
  const byCast = {};
  const flat = [];

  for (const row of rows) {
    /* The category and cooldown are stamped here rather than typed per line:
       the key is the single source of truth for which bucket a line is in, and
       most lines want the category default. A line that carries its own
       `cooldown` from ln() keeps it. */
    const line = Object.freeze({
      id: row.id,
      cast: row.cast,
      text: row.text,
      category,
      weight: row.weight,
      cooldown: row.cooldown ?? meta.defaultCooldown,
    });

    (byCast[line.cast] ||= []).push(line);
    flat.push(line);
    ALL_LINES.push(line);
    BY_ID.set(line.id, line);
    CAPTION[line.id] = line.text;
  }

  for (const k of Object.keys(byCast)) Object.freeze(byCast[k]);
  LINES[category] = Object.freeze(byCast);
  FLAT_BY_CATEGORY.set(category, Object.freeze(flat));
}

Object.freeze(CAST);
Object.freeze(CATEGORY_META);
Object.freeze(LINES);
Object.freeze(CAPTION);
Object.freeze(ALL_LINES);

/* Precomputed once. `allIds()` is called by the offline generation pass and by
   the manifest writer, both of which would otherwise rebuild this array per
   call in a loop over every line. Keyed off BY_ID, so it is the list of
   DISTINCT asset filenames — which is what a generator wants even in the
   broken case where two lines claim the same id. */
const ALL_IDS = Object.freeze([...BY_ID.keys()]);

/* ========================================================================== */
/* LOOKUPS                                                                    */
/* ========================================================================== */

/**
 * Lines in a category, optionally narrowed to one voice.
 *
 * Returns a SHARED FROZEN array — never a copy — because this sits behind the
 * NPC reaction path, which asks on every trigger. Do not sort or splice it;
 * the freeze will throw if you try, which is the intended outcome.
 *
 * With `castId`, an exact match only: an unknown category or a voice with
 * nothing to say in that category returns []. Callers that need a fallback
 * should call again without `castId` rather than have this function silently
 * substitute a different character's voice — a security guard delivering a
 * tourist's line is worse than saying nothing.
 *
 * @param {string} category
 * @param {string} [castId]
 * @returns {ReadonlyArray<object>}
 */
export function linesFor(category, castId) {
  if (!castId) return FLAT_BY_CATEGORY.get(category) || EMPTY;
  const byCast = LINES[category];
  return (byCast && byCast[castId]) || EMPTY;
}

/** One line by its immutable id, or undefined. Frozen. */
export function byId(id) {
  return BY_ID.get(id);
}

/** Every line id, in declaration order. Frozen; the generation pass iterates it. */
export function allIds() {
  return ALL_IDS;
}

/** One cast member by id, or undefined. Frozen. */
export function castById(id) {
  return CAST_BY_ID.get(id);
}

/**
 * Weighted pick. Pure — it holds no state, so cooldown enforcement stays the
 * caller's job (it needs the clock, and this file has no clock).
 *
 * `rnd` takes the game's seeded RNG directly: `makeRNG()` returns a callable
 * that yields [0,1), so `pickLine(cat, id, game.rng)` is deterministic and
 * replayable, which matters because bots trigger these too.
 *
 * @param {string} category
 * @param {string|null} [castId]  null/undefined = any voice in the category
 * @param {() => number} [rnd]
 * @returns {object|null}
 */
export function pickLine(category, castId, rnd = Math.random) {
  const pool = linesFor(category, castId || undefined);
  if (pool.length === 0) return null;
  if (pool.length === 1) return pool[0];

  let total = 0;
  for (const l of pool) total += l.weight;
  let r = rnd() * total;
  for (const l of pool) {
    r -= l.weight;
    if (r <= 0) return l;
  }
  // Floating point can leave r a hair above zero after the last subtraction.
  return pool[pool.length - 1];
}

/* ========================================================================== */
/* SELFTEST                                                                   */
/* ========================================================================== */

const wordCount = (s) => s.trim().split(/\s+/).length;

/**
 * Validate the whole corpus. NOT run on import: this module is in the client
 * bundle, the walk allocates, and a data file that logs on import ends up in
 * every player's console. Call it from the dev harness or from the offline
 * generation pass — the generation pass in particular must refuse to spend
 * money on a corpus that does not pass.
 *
 * Errors are things that break the build or the game. Warnings are smells that
 * a human should look at but that must not block generation — notably the
 * id/category prefix check: ids are immutable and categories are not, so a
 * renamed category legitimately leaves old ids with the old prefix.
 *
 * @returns {{ok: boolean, errors: string[], warnings: string[], stats: object}}
 */
export function __selftest() {
  const errors = [];
  const warnings = [];
  const seenExact = new Set();
  const seenLower = new Map(); // lowercased id -> first id that claimed it
  const seenText = new Map();  // normalised text -> first id that said it
  const castLineCount = new Map();

  /* ---- cast ---- */
  const castIds = new Set();
  for (const c of CAST) {
    if (castIds.has(c.id)) errors.push(`duplicate cast id "${c.id}"`);
    castIds.add(c.id);
    castLineCount.set(c.id, 0);
    if (!SLUG_RE.test(c.id) || c.id.length > SLUG_MAX) {
      errors.push(`cast id "${c.id}" is not a filesystem-safe slug`);
    }
    for (const field of ['displayName', 'blurb', 'voiceDirection', 'role', 'color']) {
      if (typeof c[field] !== 'string' || c[field].trim() === '') {
        errors.push(`cast "${c.id}" is missing ${field}`);
      }
    }
    if (!/^#[0-9a-f]{6}$/i.test(c.color || '')) {
      errors.push(`cast "${c.id}" color must be #rrggbb (hud.pushFeed takes a hex string)`);
    }
    if (!(c.cooldown >= 0)) errors.push(`cast "${c.id}" needs a non-negative cooldown`);
  }

  /* ---- categories present ---- */
  for (const category of CATEGORIES) {
    const n = linesFor(category).length;
    if (n < MIN_LINES_PER_CATEGORY) {
      errors.push(`category "${category}" has ${n} line(s), needs ${MIN_LINES_PER_CATEGORY}`);
    }
    const voices = Object.keys(LINES[category] || {}).length;
    if (voices < 2) warnings.push(`category "${category}" only uses ${voices} voice(s)`);
  }
  for (const key of Object.keys(SCRIPT)) {
    if (!CATEGORY_META[key]) errors.push(`SCRIPT has category "${key}" with no CATEGORY_META entry`);
  }

  /* ---- lines ----
     Walks ALL_LINES, not ALL_IDS. Iterating the id list would ask BY_ID for
     each id and therefore see a duplicated id exactly once — the collision
     that silently deletes a line is invisible from the key side. */
  for (const line of ALL_LINES) {
    const id = line.id;

    if (seenExact.has(id)) errors.push(`duplicate line id "${id}" — one of the two is lost`);
    seenExact.add(id);

    if (!SLUG_RE.test(id)) errors.push(`id "${id}" is not [a-z0-9] with single hyphens`);
    if (id.length > SLUG_MAX) errors.push(`id "${id}" is ${id.length} chars, max ${SLUG_MAX}`);
    if (RESERVED_BASENAMES.has(id)) errors.push(`id "${id}" is a reserved Windows device name`);

    /* Case-insensitive, because the asset files land on case-insensitive
       filesystems where two ids differing only in case become one file. */
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

    if (!CATEGORY_META[line.category]) errors.push(`line "${id}" has unknown category "${line.category}"`);
    if (!linesFor(line.category).includes(line)) errors.push(`line "${id}" is not filed under its category`);
    if (!(LINES[line.category]?.[line.cast] || []).includes(line)) {
      errors.push(`line "${id}" is not filed under its cast`);
    }

    const t = line.text;
    if (typeof t !== 'string' || t.trim() === '') {
      errors.push(`line "${id}" has no text`);
      continue;
    }
    if (t !== t.trim()) errors.push(`line "${id}" has leading/trailing whitespace`);
    if (/\s{2,}/.test(t)) errors.push(`line "${id}" has a double space (TTS reads it as a stumble)`);
    if (wordCount(t) > MAX_WORDS) errors.push(`line "${id}" is ${wordCount(t)} words, max ${MAX_WORDS}`);
    if (t.length > MAX_CHARS) errors.push(`line "${id}" is ${t.length} chars, max ${MAX_CHARS}`);
    for (const f of FORBIDDEN) {
      if (f.re.test(t)) errors.push(`line "${id}" trips the ${f.why} tripwire`);
    }

    const norm = t.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    if (seenText.has(norm)) {
      warnings.push(`line "${id}" duplicates the text of "${seenText.get(norm)}" (two paid-for assets, one sentence)`);
    } else {
      seenText.set(norm, id);
    }

    if (!(line.weight > 0) || !Number.isFinite(line.weight)) {
      errors.push(`line "${id}" needs a finite weight above zero`);
    }
    if (!(line.cooldown >= 0) || !Number.isFinite(line.cooldown)) {
      errors.push(`line "${id}" needs a finite non-negative cooldown`);
    }

    if (CAPTION[id] !== t) errors.push(`CAPTION["${id}"] does not match the line text`);

    const prefix = line.category.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
    if (!id.startsWith(`${prefix}-`)) {
      warnings.push(`id "${id}" does not start with its category prefix "${prefix}-"`);
    }
  }

  if (Object.keys(CAPTION).length !== ALL_IDS.length) {
    errors.push('CAPTION and the line index are different sizes');
  }
  /* States the same invariant as the per-line duplicate check from the other
     direction: one authored line in, one distinct asset id out. */
  if (ALL_LINES.length !== BY_ID.size) {
    errors.push(`${ALL_LINES.length} lines collapsed into ${BY_ID.size} ids — some id is used twice`);
  }

  /* A voice with no lines is an NPC that opens its mouth and says nothing. */
  for (const [id, n] of castLineCount) {
    if (n === 0) warnings.push(`cast "${id}" has no lines and would be silent`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      casts: CAST.length,
      categories: CATEGORIES.length,
      lines: ALL_LINES.length,
      perCategory: Object.fromEntries(CATEGORIES.map((c) => [c, linesFor(c).length])),
    },
  };
}
