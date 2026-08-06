/**
 * THE IN-GAME PHONE — UI LAYER.
 *
 * A GTA-style pocket phone drawn over the match: a HUD button, five screens
 * (Contacts, Messages, Calls, Event Alerts, Settings), an incoming-call card
 * with Answer / Dismiss / Minimize, and a persistent chip so a minimised call
 * is never lost.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS NOT
 *
 * It is not the PhoneSystem. It selects nothing, schedules nothing and owns no
 * dialogue. It is a SINK plus a STORE: the system pushes calls, messages and
 * alerts in through the controller returned by `mount()`, and this file draws
 * them, remembers them for the match, and reports what the player did.
 *
 * The one thing it will not do is draw something the content policy forbids.
 * See CONTENT POLICY below: the filter here is the LAST gate before pixels, not
 * the only one.
 *
 * ---------------------------------------------------------------------------
 * MOUNTING  (this is the whole integration surface)
 *
 *   import { mount } from './ui/phone-ui.js';
 *   const phone = mount(game.hud.root, phoneSystem);   // or mount(game.uiRoot, …)
 *   …
 *   phone.unmount();
 *
 * `root` may be `#hud-layer` (recommended — the phone then inherits the HUD's
 * hide-outside-a-match behaviour, see HUD-OFF below) or `#ui-root`. The layer
 * sets its own absolute font-size off `--s`, so the em model is identical in
 * either parent and nothing compounds.
 *
 * CONTROLLER (what mount returns — the orchestrator and the PhoneSystem call these)
 *   open(screen?) · close() · toggle() · isOpen() · screen()
 *   incomingCall(call) -> id|null      ring, or queue behind the live one
 *   answer(id?) · dismiss(id?) · minimize(id?) · restore(id?)
 *   endCall(id?, reason?)              'ended' | 'hangup' | 'system'
 *   sayLine(id, line)                  push one more spoken line into a live call
 *   pushMessage(msg) -> id|null · pushAlert(alert) -> id|null
 *   pushCall(entry) -> id|null         history only, never rings
 *   pushContact(c) · setData(kind, list) · data(kind) -> copy
 *   settings() -> {mature, muteCalls, voicesMuted, subtitles}
 *   setSetting(key, value)
 *   badge() -> number · setVisible(on) · el · ui · unmount()
 *   stats() -> {blocked, gated, rung, answered, missed, declined, played}
 *   selftest() -> the content-policy unit test, for the console
 *
 * API (every hook OPTIONAL — the phone is fully usable with `api` undefined)
 *   api.contacts / api.messages / api.calls / api.alerts
 *        Array, or a function returning one. Read ONCE at mount as the initial
 *        state. After that the system pushes; this file does not poll. Two
 *        owners of one list is how a UI ends up disagreeing with its system.
 *   api.playsAudio   true = the PhoneSystem plays call audio itself and this
 *        file must never construct an Audio element. Default false.
 *   api.onOpen(screen) · api.onClose()
 *   api.onAnswer(call) · api.onDismiss(call) · api.onMissed(call)
 *   api.onEnd(call, reason) · api.onLine(call, line)
 *   api.onRead(kind, id) · api.onSettings(settings, changedKey)
 *
 * ---------------------------------------------------------------------------
 * CALL AUDIO — THE ELEMENT PATH, AND ONLY THE ELEMENT PATH
 *
 * Dialogue through this project's WebAudio graph is SILENT for reasons nobody
 * has found; five fixes failed. `VoiceSystem._startEl` (src/audio/voice.js:1149)
 * settled it with a human ear: the same file through `new Audio(url)` is
 * audible in the same tab at the same moment the graph is not. This file plays
 * a call line exactly that way — `new Audio(url)`, `el.volume`, `el.play()` —
 * and builds no nodes, no buses and no gain maths of its own. The level mirrors
 * _startEl's: voice volume × VOICE_EL_TRIM (0.55), because an element bypasses
 * voiceBus (0.62) and the master gain (0.85).
 *
 * A URL handed to this file is used VERBATIM. Resolving a bare manifest
 * filename against the manifest URL is the PhoneSystem's job — the last time
 * something in this project joined those two by hand it produced
 * `audio/voice/audio/voice/x.mp3` and every asset 404'd.
 *
 * ---------------------------------------------------------------------------
 * CONTENT POLICY — ENFORCED, NOT DESCRIBED
 *
 *   · Mature Dialogue is a SETTING, DEFAULT OFF, and it gates SELECTION in the
 *     PhoneSystem. This file is the second lock: a line flagged mature, or one
 *     that trips STRONG_RE while the setting is off, is DROPPED — never
 *     rendered dimmed, never rendered blurred, never rendered at all.
 *   · DENY is the hard filter. Slurs, hate speech, harassment of protected
 *     groups, sexual content, threats and impersonation of a real person,
 *     company, department or brand are refused AT EVERY SETTING. There is no
 *     flag that turns it off, and `validateLines()` throws on any of it.
 *   · Everything drawn goes through `esc()` first; the corpus is also expected
 *     to be free of markup characters (voicelines.js keeps the same rule).
 *
 * `validateLines(library)` walks any shape — array, {category: [...]},
 * {category: {cast: [...]}} — and throws a PhoneContentError listing every
 * violation. `__selftest()` runs it against known-bad strings and fails loudly
 * if the filter ever stops biting. Run it from the browser console:
 *   __PHONEUI__.selftest()      (or `import(...).then(m => m.__selftest())`)
 * Node cannot load this module: the `import './css/phone.css'` below is a Vite
 * construct, and that is the same trade hud.js makes.
 *
 * ---------------------------------------------------------------------------
 * THE INPUT TRAP (already cost this project once)
 *
 * gameplay/input.js listens for keydown on WINDOW and preventDefaults the arrow
 * keys and Space with NO target check (src/gameplay/input.js:74-85). Every
 * focusable control in an overlay is therefore keyboard-dead AND steers the
 * hole while the player types. `_installKeyGuard()` below is the same bubble
 * -phase fix hud.js already carries (`_panelKeyGuard`, hud.js:1543): arrows and
 * Space are stopped at this layer's root so they never reach that listener.
 * Escape is handled by a CAPTURE listener on window instead, because game.js
 * registered its own pause-menu handler first (game.js:478) and a later bubble
 * listener cannot get in front of it.
 *
 * ---------------------------------------------------------------------------
 * GEOMETRY — WHY EVERYTHING IS ON THE LEFT
 *
 * The minimap is `#hud-map`, bottom-right, `right/bottom: 1.05em`, 11.4em
 * square, so its top edge is 12.45em off the bottom. `#hud-status` (power-ups,
 * heat, the audio button) already owns the right column from 12.9em upward.
 * The phone rail is the LEFT mirror of that column — `left: 1.05em;
 * bottom: 12.9em`, growing UPWARD — so the button never moves when a call
 * arrives, and nothing this file draws can reach the map. The panel itself
 * stops above the same line. The sound-test panel learned this the expensive
 * way and had to be narrowed after shipping over the play area.
 *
 * MOBILE FIRST. 375 px wide is the target. `--s` floors at 0.78 there, so 1em
 * is 12.48 px and a 2.6em control would be 32 px — under the minimum. Every tap
 * target in phone.css therefore carries a `min-height: 44px` PX floor, mirrored
 * here as TAP_PX so a test can assert against the same number.
 *
 * ACCESSIBILITY. Colour is never the only signal: every call state carries a
 * WORD (Ringing / In call / Missed / Declined / Ended) and a GLYPH, unread
 * carries a COUNT, the mature tag is the word MATURE, and each toggle prints
 * its own ON/OFF word. Focus is always visible, every control is a real
 * <button>, and every animation is switched off under
 * `prefers-reduced-motion` and under the in-app `.reduced-motion` class.
 *
 * HUD-OFF. `#hud-layer.hud-off .hud-tap { display: none !important }` already
 * exists in hud.css, and hud.js stamps `.hud-off` whenever game.js fades the
 * HUD out between matches. The layer carries `hud-tap`, so mounting into
 * `#hud-layer` means the phone cannot float over the lobby or the results card.
 * Mounted anywhere else, call `setVisible(false)` yourself.
 */

import { audio } from '../core/audio.js';
/* Same reason hud.js imports its own sheet: index.html hand-links every other
   css/*.css but will not know about this one, and an unstyled phone is a pile
   of full-width text over the play area. */
import './css/phone.css';

/* ==========================================================================
 * CONSTANTS
 * ======================================================================== */

/** Minimum tap target, in real pixels. Mirrors `--ph-tap` in phone.css. */
export const TAP_PX = 44;

/** Seconds an unanswered call rings before it becomes a missed call. */
export const RING_SECONDS = 12;

/** Most calls held behind the live one. Beyond this the oldest waiting call is
 *  logged as missed rather than queued — a phone that rings six times about a
 *  moment that has passed is worse than one that drops the backlog. */
const MAX_QUEUE = 3;

/** History caps. A 20-minute match must not grow an unbounded DOM. */
const MAX_KEEP = { contacts: 64, messages: 120, calls: 60, alerts: 60 };

/**
 * localStorage key for the phone's OWN settings.
 *
 * Namespaced and versioned exactly like every other persisted key here
 * ('miami-devour:audio:v1', 'miami-devour:profile:v1', 'miami-devour:map'), so
 * a reader can tell which app owns it and a shape change is a new key rather
 * than a crash on an old blob.
 */
export const PHONE_PREFS_KEY = 'miami-devour:phone:v1';

/**
 * The HUD mixer's key — NOT a second copy of it.
 *
 * `voicesMuted` and `subtitles` already live in this blob and hud.js's audio
 * panel already writes them. Storing them again under the phone key is the
 * exact failure hud.js documents for the music/sfx sliders: two persisted
 * copies of one setting, and the player's choice silently reverting the next
 * time the other surface saves. So the phone READS and WRITES those two here,
 * and pushes the live HUD's in-memory copy along with them (see
 * `_writeShared`), which is what stops hud.js's debounced save from putting the
 * old value back.
 */
const AUDIO_PREFS_KEY = 'miami-devour:audio:v1';

/** Phone-owned defaults. Mature Dialogue is OFF, and that is the product
 *  decision, not a placeholder: family-friendly is the default state. */
export const PHONE_DEFAULTS = Object.freeze({
  mature: false,
  muteCalls: false,
  screen: 'contacts',
});

/** Shared defaults, copied from AUDIO_DEFAULTS in hud.js so a fresh install
 *  reads the same values on both surfaces. */
const SHARED_DEFAULTS = Object.freeze({ voicesMuted: false, subtitles: true });

/**
 * An element bypasses voiceBus (0.62) and the master gain (0.85), so it needs
 * its own trim. 0.55 is the number VoiceSystem uses (voice.js:104) and the two
 * must not drift, or a phone call is twice the volume of the pedestrian
 * standing next to it.
 */
const CALL_EL_TRIM = 0.55;

/** The five screens, in tab order. */
const SCREENS = Object.freeze([
  { id: 'contacts', label: 'Contacts', icon: 'contacts', title: 'Contacts' },
  { id: 'messages', label: 'Messages', icon: 'message', title: 'Messages' },
  { id: 'calls', label: 'Calls', icon: 'call', title: 'Recent calls' },
  { id: 'alerts', label: 'Alerts', icon: 'alert', title: 'Event alerts' },
  { id: 'settings', label: 'Settings', icon: 'gear', title: 'Phone settings' },
]);

const SCREEN_IDS = Object.freeze(SCREENS.map((s) => s.id));

/**
 * Call states. Each has a WORD and a GLYPH, because a coloured dot is not a
 * state — spec §6, and the same rule the heat meter and the power-up rail in
 * hud.css already follow.
 */
const CALL_STATE = Object.freeze({
  ringing: { word: 'Ringing', glyph: '◉' },
  active: { word: 'In call', glyph: '●' },
  ended: { word: 'Ended', glyph: '○' },
  missed: { word: 'Missed', glyph: '✕' },
  declined: { word: 'Declined', glyph: '⊘' },
  queued: { word: 'Waiting', glyph: '◌' },
});

/* ==========================================================================
 * CONTENT POLICY
 *
 * A tripwire in the same spirit as voicelines.js's FORBIDDEN table, widened to
 * the categories that are forbidden at EVERY setting. Two rules for anyone
 * editing it:
 *
 *   1. If a legitimate line trips a pattern, REWRITE THE LINE. Never widen the
 *      pattern to let it through. A false positive costs one dropped line; a
 *      false negative ships a slur to every player.
 *   2. These are MATCHERS, not a corpus. They are written with character
 *      classes so common leet/spacing evasions still hit, and deliberately
 *      require the doubled letters that distinguish a slur from an innocent
 *      word ("Niger", "niggardly", "Scunthorpe" and friends all pass).
 *
 * This runs over everything before it is drawn, including names and roles that
 * arrive from the PhoneSystem — an "original fictional character" whose name is
 * a real police department is exactly the thing the brief forbids.
 * ======================================================================== */

export const DENY = Object.freeze([
  /* --- slurs: race, ethnicity, religion, sexuality, gender identity, ability.
     Doubled letters required where the innocent near-neighbour lacks them. */
  { why: 'racial slur', re: /\bn[i1l!]gg[3ea]r?s?\b/i },
  { why: 'racial slur', re: /\bc[o0]{2}ns?\b(?=[^a-z]*(?:people|folk|them|those))/i },
  { why: 'ethnic slur', re: /\b(?:k[i1]kes?|w[e3]tb[a4]cks?|sp[i1]cs?|ch[i1]nks?|g[o0]{2}ks?|p[a4]k[i1]s?|r[a4]gh[e3][a4]ds?|t[o0]w[e3]lh[e3][a4]ds?|b[e3][a4]n[e3]rs?)\b/i },
  { why: 'antisemitic slur', re: /\b(?:h[e3][ey]?b[s]?|y[i1]ds?|shyl[o0]cks?)\b/i },
  { why: 'homophobic slur', re: /\b(?:f[a4]gg?[o0]ts?|f[a4]gs?|dykes?|batty ?b[o0]ys?)\b/i },
  { why: 'transphobic slur', re: /\b(?:tr[a4]nn(?:y|ies)|sh[e3]m[a4]l[e3]s?|l[a4]dyb[o0]ys?)\b/i },
  { why: 'ableist slur', re: /\b(?:r[e3]t[a4]rds?|r[e3]t[a4]rd[e3]d|sp[a4]st[i1]cs?|m[o0]ng[o0]l[o0][i1]ds?|cr[i1]ppl[e3]s?\b)/i },
  { why: 'misogynist slur', re: /\b(?:c[u\*]nts?|wh[o0]r[e3]s?|sluts?)\b/i },

  /* --- hate speech: the construction, not the vocabulary. Catches a line that
     dehumanises a group without using a single listed slur. */
  { why: 'hate speech: dehumanising a group',
    re: /\b(?:all|every|those|these)\s+(?:\w+\s+){0,2}(?:people|folks?|immigrants?|migrants?|jews?|muslims?|christians?|blacks?|whites?|asians?|latinos?|arabs?|gays?|lesbians?|trans(?:gender)?(?:\s+people)?|women|men)\s+(?:are|should|deserve|need to)\b/i },
  { why: 'hate speech: call to violence against a group',
    re: /\b(?:gas|lynch|deport|exterminate|purge|cleanse|round up|kill|hang|burn)\s+(?:all\s+|the\s+|every\s+)?(?:\w+\s+){0,2}(?:people|jews?|muslims?|immigrants?|migrants?|blacks?|whites?|asians?|gays?|trans(?:gender)?|women|men)\b/i },
  { why: 'hate speech: supremacy claim',
    re: /\b(?:white|aryan|master)\s+(?:power|pride|supremac\w+|race)\b/i },

  /* --- harassment aimed at a protected characteristic. */
  { why: 'harassment of a protected group',
    re: /\b(?:go back to your|you people always|typical\s+(?:jew|muslim|black|white|asian|arab|gay|trans|woman|women))\b/i },

  /* --- sexual content. Deliberately blunt: this is a game a child may be
     watching over a shoulder, and there is no tier at which it is allowed. */
  { why: 'sexual content',
    re: /\b(?:blow ?job|hand ?job|rim ?job|creampie|cum(?:ming|shot)?|jerk(?:ing)? off|jack(?:ing)? off|masturbat\w*|porn\w*|orgasm\w*|horny|nudes?|titt?(?:y|ies)|boobs?|dick pic|pussy|c[o0]ck(?:s|sucker)?|anal|blowing me|suck my|f[u\*]ck(?:ed|ing)? (?:me|you|her|him)|get laid|hook ?up with me)\b/i },
  { why: 'sexual content: solicitation', re: /\b(?:send (?:me )?(?:nudes|pics)|sleep with me|in bed with)\b/i },

  /* --- threats. The rule is threats against REAL people and real-world
     targets; a fictional dispatcher warning a fictional hole is the game. */
  { why: 'threat of violence against a person',
    /* The subject clause is spelled out rather than guessed at. "i am going to"
       was missing from the first draft and __selftest caught it — which is the
       entire reason a filter gets a test instead of a review. */
    re: /\b(?:i(?:'|’)?m|i am|we(?:'|’)?re|we are|i(?:'|’)?ll|i will|we will|gonna|going to)\s+(?:going to\s+|gonna\s+)?(?:\w+\s+){0,2}(?:kill|shoot|stab|bomb|behead|murder|rape)\s+(?:you|him|her|them|your)\b/i },
  { why: 'threat: real-world attack',
    re: /\b(?:shoot up|bomb|blow up|shoot)\s+(?:the\s+)?(?:school|mall|church|mosque|synagogue|hospital|airport|station)\b/i },
  { why: 'threat: doxxing', re: /\b(?:i know where you live|find you and|come to your house)\b/i },

  /* --- impersonation of a real person, company, department or brand.
     The responder agency in this game is the INVENTED "City Response"
     (voicelines.js says so in its own header). Anything that would be heard as
     a recording of a real service, or as a real brand endorsing the game, is
     out — including the platform handles and links that make a fictional line
     read as a real account. */
  { why: 'real agency, force or department',
    re: /\b(?:fbi|cia|dea|atf|nsa|nypd|lapd|lvmpd|rcmp|scotland yard|met police|miami[- ]dade|metro[- ]dade|state troopers?|coast guard|national guard|homeland security|secret service|sheriff(?:'|’)?s? (?:office|department)|police department|fire department|911 dispatch)\b/i },
  /* Ordinary English words that happen to be brands — apple, meta, target,
     ford, ups, ice — are DELIBERATELY absent. This game is about eating a
     fruit stand; blocking "apple" would refuse a legitimate line every match,
     and a filter people learn to work around is a filter that stops being
     read. Unambiguous marks only. */
  { why: 'real company or brand',
    re: /\b(?:google|microsoft|amazon|facebook|instagram|whatsapp|snapchat|tiktok|twitter|youtube|netflix|disney|marvel|nintendo|playstation|xbox|uber|lyft|airbnb|tesla|ferrari|lamborghini|porsche|toyota|chevrolet|coca[- ]?cola|pepsi|mcdonald(?:'|’)?s|starbucks|burger king|nike|adidas|rolex|gucci|walmart|fedex|verizon|t-mobile|spotify|rockstar games|grand theft auto)\b/i },
  { why: 'social handle or link', re: /(?:https?:\/\/|www\.|@[a-z0-9_]{2,})/i },
  { why: 'real public figure by title',
    re: /\b(?:the (?:president|prime minister|governor|mayor) of\s+[a-z]|president [a-z][a-z]+|senator [a-z][a-z]+)\b/i },

  /* --- structural hazards, same two as voicelines.js. A caption reaches
     innerHTML; the corpus itself stays free of anything that could open a tag,
     so escaping is the second lock on that door rather than the only one. */
  { why: 'markup or quoting hazard', re: /[<>]/ },
  { why: 'control character', re: /[\u0000-\u001f\u007f]/ },
]);

/**
 * The MATURE band: allowed only when the player has switched Mature Dialogue
 * on, and even then only on the rare reactive line the PhoneSystem picks.
 *
 * This exists so an unflagged line cannot slip through. If the PhoneSystem
 * forgets `mature: true` on a line that swears, this catches it and the line is
 * dropped while the setting is off — enforcement that does not depend on the
 * content module remembering a flag.
 */
const STRONG_RE = /\b(?:damn(?:it)?|goddamn\w*|hell|crap(?:py)?|arse\w*|ass(?:hole|hat)?|bastards?|piss(?:ed|ing)?|shit\w*|bull ?shit|f+u+c*k+\w*|f[\*u]ck\w*|bitch\w*|pricks?|wankers?|bollocks|bloody|sod off|screw (?:you|this)|jackass)\b/i;

/** Thrown by `validateLines`. Carries every violation, not just the first. */
export class PhoneContentError extends Error {
  constructor(violations) {
    const head = `phone content policy: ${violations.length} violation(s)`;
    super(`${head}\n  ${violations.map((v) => `${v.where}: ${v.why} — ${v.sample}`).join('\n  ')}`);
    this.name = 'PhoneContentError';
    this.violations = violations;
  }
}

/**
 * Is this text forbidden at EVERY setting?
 *
 * @param {string} text
 * @returns {{why: string, source: string}|null} null when the text is clean.
 */
export function isForbidden(text) {
  if (typeof text !== 'string' || text === '') return null;
  for (const rule of DENY) {
    if (rule.re.test(text)) return { why: rule.why, source: String(rule.re) };
  }
  return null;
}

/**
 * Does this text need Mature Dialogue switched on?
 * Flag first, pattern second — the pattern is the safety net for a missing flag.
 */
export function isStrong(item) {
  if (!item) return false;
  if (item.mature === true || item.strong === true) return true;
  const s = item.strength || item.tone || item.tier;
  if (typeof s === 'string' && /^(strong|mature|hard|adult)$/i.test(s)) return true;
  const t = typeof item === 'string' ? item : item.text;
  return typeof t === 'string' && STRONG_RE.test(t);
}

/** Flatten any of the shapes a line library is written in. */
function flattenLibrary(lib, path, out) {
  if (!lib) return out;
  if (Array.isArray(lib)) {
    lib.forEach((v, i) => flattenLibrary(v, `${path}[${i}]`, out));
    return out;
  }
  if (typeof lib === 'string') {
    out.push({ where: path, text: lib, item: lib });
    return out;
  }
  if (typeof lib !== 'object') return out;
  if (typeof lib.text === 'string' || typeof lib.body === 'string') {
    out.push({
      where: `${path}${lib.id ? `#${lib.id}` : ''}`,
      text: String(lib.text || lib.body),
      item: lib,
    });
    /* Fall through on purpose: a line object may also carry a `name` and a
       `role` that have to pass the same filter. */
  }
  for (const k of ['name', 'displayName', 'role', 'title', 'blurb', 'subtitle', 'preview']) {
    if (typeof lib[k] === 'string' && lib[k]) {
      out.push({ where: `${path}.${k}`, text: lib[k], item: lib });
    }
  }
  for (const [k, v] of Object.entries(lib)) {
    if (v && (Array.isArray(v) || typeof v === 'object')) flattenLibrary(v, `${path}.${k}`, out);
  }
  return out;
}

/**
 * Walk a whole line library and THROW on any violation.
 *
 * Accepts an array of lines, `{category: [line…]}`, `{category: {cast: [line…]}}`,
 * or a module namespace with LINES / CAST / MESSAGES on it — it walks whatever
 * it is handed and checks every string that looks like player-visible text.
 *
 * @param {any} library
 * @param {{label?: string, allowMature?: boolean}} [opts]
 *   `allowMature: true` only skips the mature-flag audit; DENY is never skipped.
 * @returns {{ok: true, checked: number, mature: number}}
 * @throws {PhoneContentError}
 */
export function validateLines(library, opts = {}) {
  const label = opts.label || 'library';
  const entries = flattenLibrary(library, label, []);
  const violations = [];
  let mature = 0;

  for (const e of entries) {
    const bad = isForbidden(e.text);
    if (bad) {
      violations.push({ where: e.where, why: bad.why, sample: clip(e.text, 48) });
      continue;
    }
    if (isStrong(e.item) || isStrong(e.text)) {
      mature++;
      /* A strong line that is not FLAGGED strong is a bug in the corpus, not in
         the player's settings: the selection layer keys off the flag, so an
         unflagged one would be eligible with Mature Dialogue off. */
      if (!opts.allowMature && e.item && typeof e.item === 'object'
        && e.item.mature !== true && e.item.strong !== true
        && !/^(strong|mature|hard|adult)$/i.test(String(e.item.strength || e.item.tone || ''))) {
        violations.push({
          where: e.where,
          why: 'strong language without `mature: true` — it would be eligible with Mature Dialogue OFF',
          sample: clip(e.text, 48),
        });
      }
    }
  }

  if (violations.length) throw new PhoneContentError(violations);
  return { ok: true, checked: entries.length, mature };
}

/* ==========================================================================
 * SMALL HELPERS
 * ======================================================================== */

/** Everything drawn goes through this. Same table hud.js uses. */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function clamp01(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

/** FNV-1a. Deterministic, so a contact's avatar is the same every match. */
function hashStr(s) {
  let h = 2166136261 >>> 0;
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Wall-clock HH:MM. A phone shows a clock; the match timer is the HUD's job. */
function clockTime(d) {
  const t = d instanceof Date ? d : new Date();
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}

function mmss(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Reading time for a line with no audio behind it.
 * ~2.6 words/second plus a beat, floored so a three-word line is still legible.
 */
function readSeconds(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1.9, Math.min(7, 0.9 + words * 0.38));
}

let _uid = 0;
function nextId(prefix) { return `${prefix}-${Date.now().toString(36)}-${(++_uid).toString(36)}`; }

function reduceMotion() {
  if (typeof document === 'undefined') return false;
  if (document.documentElement.classList.contains('reduced-motion')) return true;
  try {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch { return false; }
}

/** A blip through the existing UI sound. `ui` is in SOUND_METHODS (audio.js:3550)
 *  and the kinds are click|hover|back|menuOpen|menuClose|confirm|error. */
function blip(kind) {
  try { audio.ui(kind); } catch { /* no context yet, or a dead one */ }
}

/* ==========================================================================
 * ICONS — 24x24, currentColor, 1.8 stroke
 *
 * Drawn here rather than imported from ui/icons.js so this module has no
 * dependency on a file it does not own, but authored to that file's rules
 * (24x24 viewBox, `currentColor` only, stroke 1.8, round caps, no ids — a
 * duplicated <defs> id across twenty printed icons cross-wires them).
 * ======================================================================== */

const K = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';

const ICONS = {
  phone:
    `<path d="M7.6 3.6h2.1l1.5 3.7-1.8 1.4a11 11 0 0 0 5.9 5.9l1.4-1.8 3.7 1.5v2.1a2.6 2.6 0 0 1-2.9 2.6C11.4 18.4 5.6 12.6 5 6.5a2.6 2.6 0 0 1 2.6-2.9Z" ${K}/>`,
  call:
    `<path d="M7.6 3.6h2.1l1.5 3.7-1.8 1.4a11 11 0 0 0 5.9 5.9l1.4-1.8 3.7 1.5v2.1a2.6 2.6 0 0 1-2.9 2.6C11.4 18.4 5.6 12.6 5 6.5a2.6 2.6 0 0 1 2.6-2.9Z" ${K}/>`,
  hangup:
    `<path d="M3.4 13.2c4.8-4.3 12.4-4.3 17.2 0l-2 2.4-3.3-1.1-.5-2.2a11 11 0 0 0-5.6 0l-.5 2.2-3.3 1.1Z" ${K}/>`,
  message:
    `<path d="M4 6.4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7.4a2 2 0 0 1-2 2H9.4L5 19.6v-3.8a2 2 0 0 1-1-1.7Z" ${K}/>`
    + `<path d="M8 8.8h8M8 11.8h5" ${K}/>`,
  contacts:
    `<circle cx="12" cy="8.6" r="3.3" ${K}/>`
    + `<path d="M5.6 19.4c.7-3.4 3.3-5.2 6.4-5.2s5.7 1.8 6.4 5.2" ${K}/>`,
  alert:
    `<path d="M12 3.8 21 19.4H3Z" ${K}/>`
    + `<path d="M12 9.6v4.1" ${K}/><circle cx="12" cy="16.6" r="1.05" fill="currentColor"/>`,
  gear:
    `<circle cx="12" cy="12" r="3.1" ${K}/>`
    + `<path d="M12 2.6l1.1 2.2 2.4-.5.4 2.4 2.3.9-1.2 2.1 1.6 1.9-1.9 1.5.5 2.4-2.4.3-1 2.2-2.1-1.2-2.1 1.2-1-2.2-2.4-.3.5-2.4-1.9-1.5 1.6-1.9L5.1 7.6l2.3-.9.4-2.4 2.4.5Z" ${K}/>`,
  back: `<path d="M14.6 5.4 8 12l6.6 6.6" ${K}/>`,
  close: `<path d="M6.4 6.4 17.6 17.6M17.6 6.4 6.4 17.6" ${K}/>`,
  minimize: `<path d="M5.4 17.6h13.2" ${K}/><path d="M12 5.4v7.4M8.6 9.6 12 13l3.4-3.4" ${K}/>`,
  arrowIn: `<path d="M18.6 5.4 7.6 16.4" ${K}/><path d="M7.4 9.6v7h7" ${K}/>`,
  arrowOut: `<path d="M5.4 18.6 16.4 7.6" ${K}/><path d="M16.6 14.4v-7h-7" ${K}/>`,
  check: `<path d="M5.2 12.6 9.8 17l9-10" ${K}/>`,
  mute: `<path d="M4.6 9.4h3.2L12 5.8v12.4l-4.2-3.6H4.6Z" ${K}/><path d="M16 9.6 20.4 14M20.4 9.6 16 14" ${K}/>`,
};

/**
 * One icon. `size` is a CSS length; the glyph inherits colour from its box.
 * Unknown names return an empty string rather than a broken tag — but every
 * call site below uses a literal from ICONS, so an unknown name is a typo the
 * review should catch, not a runtime state to design for.
 */
function ic(name, size = '1em', cls = '') {
  const body = ICONS[name];
  if (!body) return '';
  return `<svg class="ph-i${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" width="${size}" height="${size}"`
    + ` aria-hidden="true" focusable="false">${body}</svg>`;
}

/* ==========================================================================
 * PROCEDURAL AVATARS
 *
 * 100% procedural, like every other asset in this project: two flat shapes and
 * the contact's initials, hue derived from a hash of the id so the same
 * character is the same colour every match. The INITIALS are the identity —
 * the hue is decoration, and the card would still be readable in greyscale.
 * ======================================================================== */

function initialsOf(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function avatarSvg(contact, px) {
  const name = (contact && (contact.name || contact.displayName)) || 'Unknown';
  /* contactId FIRST. A call record's own `id` is unique per call, so hashing
     that would give the same character a different colour every time they
     rang — the avatar has to key off the person, not the event. */
  const h = hashStr((contact && (contact.contactId || contact.castId || contact.id)) || name);
  const hue = h % 360;
  const hue2 = (hue + 38) % 360;
  const init = esc(initialsOf(name));
  /* No <defs>, no gradient ids: these are printed a dozen times per screen and
     duplicate ids cross-wire (icons.js makes the same rule for the same reason). */
  return `<svg class="ph-av" viewBox="0 0 40 40" width="${px}" height="${px}" role="img"`
    + ` aria-label="${esc(name)}">`
    + `<rect x="0" y="0" width="40" height="40" rx="12" fill="hsl(${hue} 46% 26%)"/>`
    + `<path d="M0 26 L40 8 V40 H0 Z" fill="hsl(${hue2} 62% 42%)" opacity="0.55"/>`
    + `<rect x="0.6" y="0.6" width="38.8" height="38.8" rx="11.6" fill="none"`
    + ` stroke="rgba(255,255,255,0.24)" stroke-width="1.2"/>`
    + `<text x="20" y="21" text-anchor="middle" dominant-baseline="central"`
    + ` font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="15"`
    + ` font-weight="800" fill="#fbf7ef">${init}</text>`
    + `</svg>`;
}

/* ==========================================================================
 * PREFERENCES
 * ======================================================================== */

function readPhonePrefs() {
  const out = { ...PHONE_DEFAULTS };
  let raw = null;
  try { raw = localStorage.getItem(PHONE_PREFS_KEY); }
  catch { return out; }                    // private mode: defaults, no crash
  if (!raw) return out;
  try {
    const saved = JSON.parse(raw);
    if (saved && typeof saved === 'object') {
      if (typeof saved.mature === 'boolean') out.mature = saved.mature;
      if (typeof saved.muteCalls === 'boolean') out.muteCalls = saved.muteCalls;
      if (SCREEN_IDS.includes(saved.screen)) out.screen = saved.screen;
    }
  } catch { /* corrupt blob: defaults, and the next write repairs it */ }
  return out;
}

function writePhonePrefs(prefs) {
  try {
    localStorage.setItem(PHONE_PREFS_KEY, JSON.stringify({
      mature: !!prefs.mature, muteCalls: !!prefs.muteCalls, screen: prefs.screen,
    }));
  } catch { /* private mode or quota: the session still works */ }
}

/** The live HUD, if this build has one. hud.js publishes it (hud.js:455). */
function liveHud() {
  const h = typeof globalThis !== 'undefined' ? globalThis.__miamiHUD : null;
  return h && typeof h === 'object' ? h : null;
}

/** The live VoiceSystem, if the game is up. main.js:16 publishes __GAME__. */
function liveVoice() {
  const g = typeof globalThis !== 'undefined' ? globalThis.__GAME__ : null;
  const v = g && g.voice;
  return v && typeof v === 'object' ? v : null;
}

function readShared() {
  const out = { ...SHARED_DEFAULTS };
  /* The live HUD is the freshest copy — it may hold an unsaved change from the
     mixer that is still inside its 350 ms save debounce. */
  const hud = liveHud();
  if (hud && typeof hud.audioPrefs === 'function') {
    try {
      const p = hud.audioPrefs();
      if (p && typeof p.voicesMuted === 'boolean') out.voicesMuted = p.voicesMuted;
      if (p && typeof p.subtitles === 'boolean') out.subtitles = p.subtitles;
      return out;
    } catch { /* fall through to storage */ }
  }
  try {
    const raw = localStorage.getItem(AUDIO_PREFS_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') {
        if (typeof saved.voicesMuted === 'boolean') out.voicesMuted = saved.voicesMuted;
        if (typeof saved.subtitles === 'boolean') out.subtitles = saved.subtitles;
      }
    }
  } catch { /* defaults */ }
  return out;
}

/**
 * Change one of the two SHARED settings, in the one place they live.
 *
 * Three writes, and all three are load-bearing:
 *   1. the audio:v1 blob, read-modify-written so the mixer's other seven values
 *      survive;
 *   2. the LIVE HUD's in-memory copy, because hud.js saves that whole object on
 *      its next slider drag and would otherwise put the old value straight
 *      back — the two-owners bug hud.js already documents for music/sfx;
 *   3. the thing that actually makes a noise.
 *
 * (3) is deliberately BOTH `audio.setVoicesMuted()` and `voice.setMuted()`.
 * The first moves `voiceBus`, which is the WebAudio path — the silent one.
 * Dialogue is audible only through `VoiceSystem._startEl`'s HTMLAudioElement,
 * and that element reads `VoiceSystem._muted`, which nothing in the game
 * currently sets: grep `voice.setMuted` across src/ and the only hits are
 * voice.js's own selftest. Muting one without the other silences the bus that
 * was already silent and leaves the audible path talking.
 */
function writeShared(key, value) {
  const v = !!value;
  let blob = null;
  try {
    const raw = localStorage.getItem(AUDIO_PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') blob = parsed;
    }
  } catch { /* fall through to the seed below */ }
  if (!blob) {
    /* No blob yet: the player has never opened the HUD mixer. Seed from the
       LIVE mixer's own state rather than writing a two-key stub, because
       hud._loadAudioPrefs() treats "no blob" as its cue to adopt the meta
       profile's music/sfx — and a stub would look like a real save and skip
       that adoption, quietly resetting a mix the player set in the meta
       Settings screen. */
    const hud = liveHud();
    try { blob = (hud && typeof hud.audioPrefs === 'function') ? hud.audioPrefs() : { ...SHARED_DEFAULTS }; }
    catch { blob = { ...SHARED_DEFAULTS }; }
  }
  blob[key] = v;
  try { localStorage.setItem(AUDIO_PREFS_KEY, JSON.stringify(blob)); }
  catch { /* private mode: the session still works */ }

  const hud = liveHud();
  if (hud) {
    if (key === 'subtitles' && typeof hud.setSubtitles === 'function') {
      /* PUBLIC method: writes hud._audioPrefs.subtitles, toggles
         html.no-subtitles and forwards to the VoiceSystem. Everything the
         phone would otherwise have to do by hand. */
      try { hud.setSubtitles(v); } catch { /* HUD mid-teardown */ }
    } else if (hud._audioPrefs && typeof hud._audioPrefs === 'object') {
      /* No public setter exists for voicesMuted. Reaching into the field is
         deliberate and is the lesser evil: the alternative is a second
         persisted copy of one switch, which is the exact bug hud.js warns
         about two comments above its own storage code. */
      try { hud._audioPrefs[key] = v; } catch { /* frozen or gone */ }
    }
    if (typeof hud._syncAudioUI === 'function') {
      try { hud._syncAudioUI(); } catch { /* the mixer's rows may not exist */ }
    }
  }

  if (key === 'voicesMuted') {
    try { audio.setVoicesMuted(v); } catch { /* dead context */ }
    const vs = liveVoice();
    if (vs && typeof vs.setMuted === 'function') {
      try { vs.setMuted(v); } catch { /* voice pack absent */ }
    }
  } else if (key === 'subtitles') {
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('no-subtitles', !v);
    }
    const vs = liveVoice();
    if (vs && typeof vs.setSubtitles === 'function') {
      try { vs.setSubtitles(v); } catch { /* voice pack absent */ }
    }
  }
}

/** Voice level for a call element, mirroring VoiceSystem._startEl exactly. */
function callVolume() {
  let voice = 1;
  const hud = liveHud();
  if (hud && typeof hud.audioPrefs === 'function') {
    try {
      const p = hud.audioPrefs();
      if (p && Number.isFinite(Number(p.voice))) voice = clamp01(p.voice);
      /* Master mute is the whole mixer, and a phone call is not exempt. */
      if (p && p.muted) voice = 0;
      if (Number.isFinite(Number(p.master))) voice *= clamp01(p.master);
    } catch { /* defaults */ }
  }
  const lvl = voice * CALL_EL_TRIM;
  /* One undefined anywhere in a product poisons the whole thing, and a NaN
     assigned to el.volume throws in Safari and silences in Chrome. This is the
     lesson from `0.9 * undefined` in voice.js:1202 — check the RESULT. */
  return Number.isFinite(lvl) ? Math.max(0, Math.min(1, lvl)) : 0.55;
}

/* ==========================================================================
 * NORMALISATION — everything from the outside lands here first
 * ======================================================================== */

/**
 * Turn whatever the PhoneSystem handed over into a record this file can draw,
 * or return null.
 *
 * Null is returned for three reasons and each one is COUNTED (`stats`), because
 * "the phone never rang" and "the phone refused the line" look identical from
 * the outside and this project has already lost a day to that class of silence.
 */
function normalizeCall(raw, ctx) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || raw.castName || raw.contactName || 'Unknown caller');
  const role = String(raw.role || raw.title || '');
  const lines = [];

  const push = (l) => {
    if (!l) return;
    const text = typeof l === 'string' ? l : String(l.text || l.caption || '');
    if (!text.trim()) return;
    lines.push({
      text: text.trim(),
      seconds: Number(l && l.seconds) > 0 ? Number(l.seconds) : 0,
      url: (l && typeof l === 'object' && (l.url || l.audioUrl)) || '',
      /* Classify the TEXT, not the container. The first version asked
         `typeof l === 'object' && isStrong(l)`, so a line handed over as a bare
         string — `{ line: 'what the hell was that' }`, which is the most
         obvious way to write one — was never flagged mature and rendered with
         the setting OFF. __selftest caught it. Passing `{ text }` keeps both
         paths: the flag when there is an object, the pattern always. */
      mature: isStrong(typeof l === 'object' ? l : { text }) || isStrong({ text }),
    });
  };
  if (Array.isArray(raw.lines)) raw.lines.forEach(push);
  else push(raw.line || raw.text || raw.subtitle);

  const record = {
    id: String(raw.id || nextId('call')),
    contactId: raw.contactId || raw.castId || raw.contact || '',
    name,
    role,
    lines,
    url: String(raw.url || raw.audioUrl || (lines[0] && lines[0].url) || ''),
    mature: isStrong(raw) || lines.some((l) => l.mature),
    priority: Number(raw.priority) || 0,
    reason: String(raw.reason || raw.trigger || ''),
    /* A preformatted `time` string wins; otherwise the phone stamps its own
       wall clock. There is deliberately no rule for a NUMBER here — "seconds
       into the match" and "epoch milliseconds" are indistinguishable from a
       bare number, and guessing wrong prints 1970 on every row. */
    at: typeof raw.time === 'string' ? raw.time : clockTime(),
    state: 'ringing',
    lineIndex: -1,
    shown: [],
    startedAt: 0,
    seconds: 0,
  };

  return gate(record, [name, role, ...lines.map((l) => l.text)], ctx, 'call');
}

function normalizeMessage(raw, ctx) {
  if (!raw) return null;
  const o = typeof raw === 'string' ? { text: raw } : raw;
  const text = String(o.text || o.body || '').trim();
  if (!text) return null;
  const record = {
    id: String(o.id || nextId('msg')),
    contactId: o.contactId || o.castId || o.contact || o.from || '',
    name: String(o.name || o.castName || o.from || 'Unknown'),
    role: String(o.role || ''),
    text,
    outgoing: !!o.outgoing,
    unread: o.unread !== false && !o.outgoing,
    mature: isStrong(o),
    at: typeof o.time === 'string' ? o.time : clockTime(),
  };
  return gate(record, [record.name, record.role, text], ctx, 'message');
}

function normalizeAlert(raw, ctx) {
  if (!raw) return null;
  const o = typeof raw === 'string' ? { text: raw } : raw;
  const title = String(o.title || o.name || 'Event').trim();
  const text = String(o.text || o.body || o.subtitle || '').trim();
  const record = {
    id: String(o.id || nextId('alert')),
    title,
    text,
    kind: String(o.kind || o.id || 'event').toLowerCase().replace(/[^a-z0-9-]/g, ''),
    severity: /^(high|urgent|critical)$/i.test(String(o.severity)) ? 'high' : 'normal',
    unread: o.unread !== false,
    mature: isStrong(o),
    at: typeof o.time === 'string' ? o.time : clockTime(),
  };
  return gate(record, [title, text], ctx, 'alert');
}

function normalizeContact(raw, ctx) {
  if (!raw) return null;
  const o = typeof raw === 'string' ? { name: raw } : raw;
  const name = String(o.name || o.displayName || '').trim();
  if (!name) return null;
  const record = {
    id: String(o.id || o.castId || name.toLowerCase().replace(/[^a-z0-9]+/g, '-')),
    name,
    role: String(o.role || ''),
    blurb: String(o.blurb || o.about || ''),
    tag: String(o.tag || ''),
  };
  return gate(record, [name, record.role, record.blurb, record.tag], ctx, 'contact');
}

/**
 * The two gates every record passes, in this order:
 *   1. DENY — forbidden at every setting, dropped and reported loudly.
 *   2. MATURE — dropped silently while the setting is off. Not dimmed, not
 *      blurred, not "tap to reveal": the brief says ineligible lines must never
 *      be SELECTED, and refusing to draw one is the last enforcement point
 *      this layer has if something upstream selected it anyway.
 */
function gate(record, texts, ctx, kind) {
  for (const t of texts) {
    const bad = isForbidden(t);
    if (!bad) continue;
    ctx.stats.blocked++;
    /* console.error, not warn: a forbidden string reaching the UI means the
       selection layer let it through, and that is a defect to fix today. */
    if (typeof console !== 'undefined' && console.error) {
      console.error(`[phone] refused a ${kind}: ${bad.why}. Fix the corpus, not this filter.`);
    }
    return null;
  }
  if (record.mature && !ctx.prefs.mature) {
    ctx.stats.gated++;
    return null;
  }
  return record;
}

/* ==========================================================================
 * THE UI
 * ======================================================================== */

export class PhoneUI {
  /**
   * @param {HTMLElement} root  #hud-layer or #ui-root
   * @param {object} [api]      the PhoneSystem's surface; every hook optional
   */
  constructor(root, api = null) {
    if (!root || typeof document === 'undefined') {
      throw new Error('PhoneUI needs a DOM element to mount into');
    }
    this.api = api && typeof api === 'object' ? api : null;
    this.prefs = readPhonePrefs();
    this.shared = readShared();
    this.stats = { blocked: 0, gated: 0, rung: 0, answered: 0, missed: 0, declined: 0, played: 0 };

    /** Per-match store. The api seeds it once; after that the system pushes. */
    this.store = { contacts: [], messages: [], calls: [], alerts: [] };

    this._open = false;
    this._screen = SCREEN_IDS.includes(this.prefs.screen) ? this.prefs.screen : 'contacts';
    this._sub = null;                 // {kind:'thread'|'call', id} | null
    this._call = null;                // the live call record
    this._queue = [];                 // calls waiting behind it
    this._minimized = false;
    this._ringT = 0;
    this._lineT = 0;
    this._tickT = 0;
    this._clockT = 0;
    this._el = null;                  // the current call's HTMLAudioElement
    /** ResizeObserver on #hud-status — see _watchStatusColumn. */
    this._ro = null;
    this._measureStatus = null;
    /** Set by mount(); the console handle and the unmount guard both use it. */
    this._facade = null;
    this._destroyed = false;

    /* ---------------- DOM ---------------------------------------------- */
    const layer = document.createElement('div');
    layer.id = 'phone-layer';
    /* `hud-tap` is hud.css's own contract: `#hud-layer.hud-off .hud-tap`
       display:none. Mounted into the HUD layer the phone therefore disappears
       with the rest of the HUD between matches, for free. */
    layer.className = 'hud-tap';
    layer.innerHTML = this._shell();
    root.appendChild(layer);
    this.root = layer;

    const $ = (s) => layer.querySelector(s);
    this.btn = $('#phone-btn');
    this.badgeEl = $('#phone-btn .ph-badge');
    this.rail = $('#phone-rail');
    this.callEl = $('#phone-call');
    this.chipEl = $('#phone-chip');
    this.panel = $('#phone-panel');
    this.titleEl = $('#phone-panel .ph-title');
    this.bodyEl = $('#phone-panel .ph-body');
    this.tabsEl = $('#phone-panel .ph-tabs');
    this.backEl = $('#phone-panel .ph-back');
    this.clockEl = $('#phone-panel .ph-clock');

    this._installKeyGuard();
    this._wire();
    this._watchStatusColumn();
    this._seed();
    this._syncTabs();
    this._renderBody();
    this._syncBadge();
    this._clockTick();

    /* Tell the system what the player's settings actually are, once, at mount.
       A PhoneSystem that has to guess the mature flag will guess wrong. */
    this._notifySettings(null);
  }

  /* ---------------------------------------------------------------- DOM -- */

  _shell() {
    const tabs = SCREENS.map((s, i) => `
      <button class="ph-tab" type="button" role="tab" data-tab="${s.id}"
              id="ph-tab-${s.id}" aria-controls="ph-body"
              aria-selected="${i === 0 ? 'true' : 'false'}"
              tabindex="${i === 0 ? '0' : '-1'}">
        ${ic(s.icon, '1.05em')}
        <span class="ph-tab-l">${esc(s.label)}</span>
        <span class="ph-tab-b" data-tabbadge="${s.id}" hidden></span>
      </button>`).join('');

    return `
      <div id="phone-rail">
        <button id="phone-btn" class="ph-fab" type="button"
                aria-expanded="false" aria-controls="phone-panel"
                aria-label="Phone" title="Phone">
          ${ic('phone', '1.15em')}
          <span class="ph-fab-l">PHONE</span>
          <span class="ph-badge" hidden aria-hidden="true">0</span>
        </button>

        <button id="phone-chip" class="ph-chip" type="button" hidden
                aria-label="Return to the call">
          <span class="ph-chip-dot" aria-hidden="true">◉</span>
          <span class="ph-chip-nm">&nbsp;</span>
          <span class="ph-chip-st">Ringing</span>
        </button>

        <!-- A LIVE REGION, not an alertdialog. The alertdialog role tells
             assistive tech that focus is about to move into this card, and it
             must not: the player is steering a hole while it rings, and
             stealing focus mid-match would be worse than missing the call.
             Assertive, because a ringing phone is an interruption by
             definition. (No backticks in here: this string is a template
             literal and one backtick in a comment ends it.) -->
        <section id="phone-call" role="region" aria-live="assertive"
                 aria-atomic="true" aria-label="Incoming call" hidden></section>
      </div>

      <section id="phone-panel" role="dialog" aria-modal="false"
               aria-label="Phone" hidden>
        <div class="ph-status" aria-hidden="true">
          <span class="ph-carrier">CITYNET</span>
          <span class="ph-sig"><i></i><i></i><i></i><i></i></span>
          <span class="ph-clock">--:--</span>
          <span class="ph-batt"><b></b></span>
        </div>
        <header class="ph-head">
          <button class="ph-back ph-icon-btn" type="button" hidden aria-label="Back">
            ${ic('back', '1.1em')}
          </button>
          <h2 class="ph-title">Contacts</h2>
          <button class="ph-x ph-icon-btn" type="button" aria-label="Close the phone">
            ${ic('close', '1.1em')}
          </button>
        </header>
        <div class="ph-body" id="ph-body" role="tabpanel" tabindex="-1"
             aria-labelledby="ph-tab-contacts"></div>
        <nav class="ph-tabs" role="tablist" aria-label="Phone screens">${tabs}</nav>
      </section>
    `;
  }

  /**
   * Keep the game's input out of the phone.
   *
   * input.js listens on WINDOW and preventDefaults the arrows and Space with no
   * target check, so without this every button here is keyboard-dead AND the
   * hole drives off while the player is reading a text message. Bubble phase:
   * it runs on the way up, before the window listener ever sees the key.
   * Escape is NOT handled here — see `_onWinKey`.
   */
  _installKeyGuard() {
    this._keyGuard = (e) => {
      if (e.key === 'Escape') return;
      /* Exactly the set input.js preventDefaults (input.js:81) and no more.
         Swallowing keys this layer has no use for is how an overlay quietly
         breaks a shortcut somebody adds six months from now. */
      if (/^Arrow/.test(e.code) || e.code === 'Space') e.stopPropagation();
    };
    this.root.addEventListener('keydown', this._keyGuard);
  }

  _wire() {
    this.btn.addEventListener('click', () => this.toggle());

    /* One delegated handler for the whole panel. Rows are rebuilt on every
       screen change, so per-row listeners would have to be torn down with them
       and one missed teardown is a leak that outlives the match. */
    this.panel.addEventListener('click', (e) => this._onPanelClick(e));
    this.panel.addEventListener('keydown', (e) => this._onTabKey(e));
    this.callEl.addEventListener('click', (e) => this._onCallClick(e));
    this.chipEl.addEventListener('click', () => this.restore());

    /* Capture phase, on window, and this is the ONE place Escape is handled.
       game.js registered its pause-menu keydown on window first (game.js:478);
       a bubble listener added later cannot run before it, and stopPropagation
       between two listeners on the same target does nothing. Capture on window
       runs before every bubble listener in the document, so the first Escape
       closes the phone and the second one — with the phone already shut and
       this handler returning early — reaches game.js and opens the pause menu,
       which is exactly the order a player expects. */
    this._onWinKey = (e) => {
      if (e.key !== 'Escape' && e.code !== 'Escape') return;
      if (this._destroyed) return;
      if (this._sub) { e.preventDefault(); e.stopPropagation(); this._back(); return; }
      if (this._open) { e.preventDefault(); e.stopPropagation(); this.close(); return; }
      if (this._call && !this._minimized && this._call.state === 'ringing') {
        e.preventDefault(); e.stopPropagation();
        this.minimize();
      }
    };
    window.addEventListener('keydown', this._onWinKey, true);

    /* Tap anywhere else closes the panel. Capture so it is seen wherever the
       tap lands, but NOTHING is stopped or consumed: gameplay/input.js owns
       pointerdown on the canvas and interfering with it would be a gameplay
       regression shipped from a phone. The call CARD is deliberately excluded —
       a ringing call is dismissed with its own buttons, never by a stray tap. */
    this._onDown = (e) => {
      if (!this._open || this._destroyed) return;
      const t = e.target;
      if (t && t.closest && t.closest('#phone-panel, #phone-btn, #phone-call, #phone-chip')) return;
      this.close();
    };
    window.addEventListener('pointerdown', this._onDown, true);
  }

  /**
   * Publish the height of the HUD's right-hand status column as `--ph-clear`.
   *
   * WHY: below 440px the panel is full-width and would sit on top of
   * #hud-status — the power-up timers and the heat meter, which grow UPWARD
   * from 12.9em on the right. Measured at 375x812 with two power-ups and heat
   * tier 3 lit, that column is 193 px tall and the panel covered 143 px of it.
   * The mobile rule in phone.css takes max(rail line, this) for the panel's
   * bottom edge, so the panel stops above whatever the column currently is.
   *
   * A ResizeObserver rather than a poll: the column's bottom is pinned, so its
   * height changing IS its top moving, and that is exactly the event we want.
   * A power-up expiring gives the panel its space back within a frame.
   */
  _watchStatusColumn() {
    const measure = () => {
      if (this._destroyed) return;
      const st = document.querySelector('#hud-status');
      if (!st) { this.root.style.setProperty('--ph-clear', '0px'); return; }
      const r = st.getBoundingClientRect();
      /* Distance from the BOTTOM of the viewport to the column's top edge.
         Zero when the column is not laid out (display:none between matches),
         which is also the right answer: nothing to avoid. */
      const clear = (r.width && r.height) ? Math.max(0, (window.innerHeight || 0) - r.top) : 0;
      this.root.style.setProperty('--ph-clear', `${Math.round(clear)}px`);
    };
    this._measureStatus = measure;
    measure();
    const st = document.querySelector('#hud-status');
    if (st && typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(measure);
      this._ro.observe(st);
    }
    /* The viewport changing moves the column too, and older Safari has no
       ResizeObserver at all — in which case this plus the measure on open() is
       the whole mechanism, and the static rail line is the floor either way. */
    window.addEventListener('resize', measure);
  }

  /** Seed from the api ONCE. See the header: this file does not poll. */
  _seed() {
    if (!this.api) return;
    const take = (v) => {
      try {
        const list = typeof v === 'function' ? v.call(this.api) : v;
        return Array.isArray(list) ? list : [];
      } catch { return []; }
    };
    for (const c of take(this.api.contacts)) this.pushContact(c, true);
    for (const m of take(this.api.messages)) this.pushMessage(m, true);
    for (const a of take(this.api.alerts)) this.pushAlert(a, true);
    for (const c of take(this.api.calls)) this.pushCall(c, true);
  }

  /* ------------------------------------------------------------ opening -- */

  isOpen() { return this._open; }
  screen() { return this._screen; }

  open(screen) {
    if (this._destroyed) return this;
    if (screen && SCREEN_IDS.includes(screen)) {
      this._screen = screen;
      this._sub = null;
    }
    if (this._open) { this._syncTabs(); this._renderBody(); return this; }
    this._open = true;
    /* Shown by the `hidden` attribute alone — no entry transition, no class
       that the resting state depends on. MEASURED, not assumed: in this
       project's own headless environment neither CSS transitions nor keyframe
       animations advance (a control transition sat at its start value after
       400 ms, and hud.js's own #hud-event banner measures opacity 0 with the
       same probe). A panel that fades in is therefore an INVISIBLE panel in
       every screenshot, and a panel that scales in reports every 44 px tap
       target as 42.7 px for as long as the stall lasts. Neither is a price
       worth paying for a 200 ms flourish. */
    this.panel.hidden = false;
    /* Re-measure on the way in: ResizeObserver covers the column CHANGING, but
       the panel may be opening for the first time since it last did. */
    if (this._measureStatus) this._measureStatus();
    this.btn.setAttribute('aria-expanded', 'true');
    this._syncTabs();
    this._renderBody();
    this._markRead(this._screen);
    /* Focus the body, not a control: a screen reader should hear the screen it
       just opened, and moving focus to the first list row would read a contact
       before the heading that says what the list is. */
    try { this.bodyEl.focus({ preventScroll: true }); } catch { /* older Safari */ }
    blip('menuOpen');
    this._emit('onOpen', this._screen);
    return this;
  }

  close() {
    if (!this._open || this._destroyed) return this;
    this._open = false;
    this._sub = null;
    this.panel.hidden = true;
    this.btn.setAttribute('aria-expanded', 'false');
    try { this.btn.focus({ preventScroll: true }); } catch { /* older Safari */ }
    blip('menuClose');
    this._emit('onClose');
    return this;
  }

  toggle() { return this._open ? this.close() : this.open(); }

  setVisible(on) {
    this.root.classList.toggle('ph-hidden', !on);
    if (!on) this.close();
    return this;
  }

  /* ------------------------------------------------------------ screens -- */

  _onPanelClick(e) {
    const t = e.target;
    if (!t || !t.closest) return;

    if (t.closest('.ph-x')) { this.close(); return; }
    if (t.closest('.ph-back')) { this._back(); return; }

    const tab = t.closest('[data-tab]');
    if (tab) {
      const id = tab.dataset.tab;
      if (!SCREEN_IDS.includes(id)) return;
      this._sub = null;
      this._screen = id;
      this.prefs.screen = id;
      writePhonePrefs(this.prefs);
      this._syncTabs();
      this._renderBody();
      this._markRead(id);
      blip('click');
      return;
    }

    const openThread = t.closest('[data-thread]');
    if (openThread) {
      this._sub = { kind: 'thread', id: openThread.dataset.thread };
      this._renderBody();
      blip('click');
      return;
    }

    const openCall = t.closest('[data-callid]');
    if (openCall) {
      this._sub = { kind: 'call', id: openCall.dataset.callid };
      this._renderBody();
      blip('click');
      return;
    }

    const tg = t.closest('[data-toggle]');
    if (tg) {
      const key = tg.dataset.toggle;
      const on = tg.getAttribute('aria-checked') !== 'true';
      this.setSetting(key, on);
      blip('click');
    }
  }

  /**
   * Roving-tabindex arrows across the tab bar.
   *
   * This is only possible BECAUSE of the key guard: the arrows would otherwise
   * be eaten by input.js and steer the hole instead of moving the selection.
   */
  _onTabKey(e) {
    if (!e.target || !e.target.closest || !e.target.closest('[data-tab]')) return;
    let d = 0;
    if (e.code === 'ArrowRight' || e.code === 'ArrowDown') d = 1;
    else if (e.code === 'ArrowLeft' || e.code === 'ArrowUp') d = -1;
    else if (e.code === 'Home') d = -SCREENS.length;
    else if (e.code === 'End') d = SCREENS.length;
    else return;
    e.preventDefault();
    const i = SCREEN_IDS.indexOf(this._screen);
    const n = Math.max(0, Math.min(SCREENS.length - 1, i + d));
    this._sub = null;
    this._screen = SCREEN_IDS[n];
    this.prefs.screen = this._screen;
    writePhonePrefs(this.prefs);
    this._syncTabs();
    this._renderBody();
    this._markRead(this._screen);
    const el = this.tabsEl.querySelector(`[data-tab="${this._screen}"]`);
    if (el) { try { el.focus({ preventScroll: true }); } catch { /* noop */ } }
  }

  _back() {
    if (!this._sub) { this.close(); return; }
    this._sub = null;
    this._renderBody();
    blip('back');
  }

  _syncTabs() {
    for (const s of SCREENS) {
      const el = this.tabsEl.querySelector(`[data-tab="${s.id}"]`);
      if (!el) continue;
      const on = s.id === this._screen;
      el.setAttribute('aria-selected', on ? 'true' : 'false');
      el.tabIndex = on ? 0 : -1;
      const n = this._unread(s.id);
      const b = el.querySelector(`[data-tabbadge="${s.id}"]`);
      if (b) {
        b.hidden = n === 0;
        b.textContent = n > 9 ? '9+' : String(n);
      }
    }
    const def = SCREENS.find((s) => s.id === this._screen) || SCREENS[0];
    this.titleEl.textContent = this._subTitle() || def.title;
    this.backEl.hidden = !this._sub;
    /* The panel is labelled by whichever tab is selected, so a screen reader
       landing in the body is told which screen it is in. */
    this.bodyEl.setAttribute('aria-labelledby', `ph-tab-${def.id}`);
  }

  _subTitle() {
    if (!this._sub) return '';
    if (this._sub.kind === 'thread') {
      /* The SAME key expression _threads() groups by. Two different ways of
         deriving one key is how a header ends up saying "Thread" over a
         conversation that plainly has a name at the top of every bubble. */
      const m = this.store.messages.find((x) => (x.contactId || x.name) === this._sub.id);
      return m ? m.name : 'Thread';
    }
    const c = this.store.calls.find((x) => x.id === this._sub.id);
    return c ? c.name : 'Call';
  }

  _renderBody() {
    if (this._destroyed) return;
    this._syncTabs();
    let html = '';
    if (this._sub && this._sub.kind === 'thread') html = this._thread(this._sub.id);
    else if (this._sub && this._sub.kind === 'call') html = this._callDetail(this._sub.id);
    else if (this._screen === 'contacts') html = this._contacts();
    else if (this._screen === 'messages') html = this._messages();
    else if (this._screen === 'calls') html = this._calls();
    else if (this._screen === 'alerts') html = this._alerts();
    else html = this._settings();
    this.bodyEl.innerHTML = html;
    this.bodyEl.scrollTop = this._sub ? this.bodyEl.scrollHeight : 0;
  }

  _empty(head, sub) {
    return `<div class="ph-empty"><b>${esc(head)}</b><span>${esc(sub)}</span></div>`;
  }

  _contacts() {
    const list = this.store.contacts;
    if (!list.length) {
      return this._empty('No contacts yet', 'People you meet in the city end up here.');
    }
    return `<ul class="ph-list" role="list">${list.map((c) => `
      <li class="ph-row" role="listitem">
        <span class="ph-row-av">${avatarSvg(c, 40)}</span>
        <span class="ph-row-tx">
          <b class="ph-row-nm">${esc(c.name)}</b>
          ${c.role ? `<span class="ph-row-rl">${esc(c.role)}</span>` : ''}
          ${c.blurb ? `<span class="ph-row-sb">${esc(clip(c.blurb, 92))}</span>` : ''}
        </span>
        ${c.tag ? `<span class="ph-tag">${esc(clip(c.tag, 12))}</span>` : ''}
      </li>`).join('')}</ul>`;
  }

  /** Messages are grouped into threads — a flat list of 40 texts from six
   *  people is a log, not a phone. */
  _threads() {
    const by = new Map();
    for (const m of this.store.messages) {
      const key = m.contactId || m.name;
      const t = by.get(key) || { key, name: m.name, role: m.role, items: [], unread: 0 };
      t.items.push(m);
      if (m.unread) t.unread++;
      t.name = m.name || t.name;
      by.set(key, t);
    }
    return [...by.values()];
  }

  _messages() {
    const threads = this._threads();
    if (!threads.length) {
      return this._empty('No messages', 'Callers text between rounds. Nothing yet.');
    }
    return `<ul class="ph-list" role="list">${threads.map((t) => {
      const last = t.items[t.items.length - 1];
      return `
      <li role="listitem">
        <button class="ph-row ph-row-btn" type="button" data-thread="${esc(t.key)}"
                aria-label="Open the conversation with ${esc(t.name)}${t.unread ? `, ${t.unread} unread` : ''}">
          <span class="ph-row-av">${avatarSvg({ id: t.key, name: t.name }, 40)}</span>
          <span class="ph-row-tx">
            <b class="ph-row-nm">${esc(t.name)}</b>
            <span class="ph-row-sb">${esc(clip(last.text, 68))}</span>
          </span>
          <span class="ph-row-meta">
            <span class="ph-time">${esc(last.at)}</span>
            ${t.unread ? `<span class="ph-badge sm">${t.unread > 9 ? '9+' : t.unread}</span>` : ''}
          </span>
        </button>
      </li>`;
    }).join('')}</ul>`;
  }

  _thread(key) {
    const items = this.store.messages.filter((m) => (m.contactId || m.name) === key);
    if (!items.length) return this._empty('Nothing here', 'This conversation is empty.');
    return `<div class="ph-thread">${items.map((m) => `
      <div class="ph-bub ${m.outgoing ? 'out' : 'in'}">
        <span class="ph-bub-tx">${esc(m.text)}</span>
        <span class="ph-bub-mt">${m.mature ? '<span class="ph-tag mature">MATURE</span>' : ''}${esc(m.at)}</span>
      </div>`).join('')}</div>`;
  }

  _calls() {
    const list = this.store.calls;
    if (!list.length) return this._empty('No calls yet', 'Answered and missed calls are logged here.');
    return `<ul class="ph-list" role="list">${list.map((c) => {
      const st = CALL_STATE[c.state] || CALL_STATE.ended;
      return `
      <li role="listitem">
        <button class="ph-row ph-row-btn" type="button" data-callid="${esc(c.id)}"
                aria-label="${esc(c.name)}, ${esc(st.word)}, ${esc(c.at)}">
          <span class="ph-row-av">${avatarSvg(c, 40)}</span>
          <span class="ph-row-tx">
            <b class="ph-row-nm">${esc(c.name)}</b>
            <span class="ph-row-sb">
              <span class="ph-st" data-state="${esc(c.state)}">
                <span aria-hidden="true">${st.glyph}</span> ${esc(st.word)}
              </span>
              ${c.seconds ? ` · ${esc(mmss(c.seconds))}` : ''}
            </span>
          </span>
          <span class="ph-row-meta"><span class="ph-time">${esc(c.at)}</span></span>
        </button>
      </li>`;
    }).join('')}</ul>`;
  }

  _callDetail(id) {
    const c = this.store.calls.find((x) => x.id === id);
    if (!c) return this._empty('Call not found', 'It may have been cleared.');
    const st = CALL_STATE[c.state] || CALL_STATE.ended;
    const said = (c.shown && c.shown.length ? c.shown : c.lines.map((l) => l.text));
    return `
      <div class="ph-detail">
        <div class="ph-detail-hd">
          ${avatarSvg(c, 56)}
          <div>
            <b>${esc(c.name)}</b>
            ${c.role ? `<span class="ph-row-rl">${esc(c.role)}</span>` : ''}
            <span class="ph-st" data-state="${esc(c.state)}">
              <span aria-hidden="true">${st.glyph}</span> ${esc(st.word)}
              ${c.seconds ? ` · ${esc(mmss(c.seconds))}` : ''} · ${esc(c.at)}
            </span>
          </div>
        </div>
        ${said.length
          ? `<div class="ph-transcript"><h3>Transcript</h3>${said
              .map((t) => `<p>${esc(t)}</p>`).join('')}</div>`
          : `<p class="ph-note">No transcript for this call.</p>`}
      </div>`;
  }

  _alerts() {
    const list = this.store.alerts;
    if (!list.length) return this._empty('No alerts', 'City events are announced here as they start.');
    return `<ul class="ph-list" role="list">${list.map((a) => `
      <li class="ph-alert ${a.severity === 'high' ? 'high' : ''}" role="listitem"
          data-kind="${esc(a.kind)}">
        <span class="ph-alert-ic" aria-hidden="true">${ic('alert', '1.05em')}</span>
        <span class="ph-row-tx">
          <b class="ph-row-nm">${esc(a.title)}</b>
          ${a.text ? `<span class="ph-row-sb wrap">${esc(a.text)}</span>` : ''}
        </span>
        <span class="ph-row-meta">
          ${a.severity === 'high' ? '<span class="ph-tag urgent">URGENT</span>' : ''}
          <span class="ph-time">${esc(a.at)}</span>
        </span>
      </li>`).join('')}</ul>`;
  }

  /**
   * Settings.
   *
   * Every switch prints its own WORD as well as moving a knob, because "which
   * side is on" is a convention, not information — the same rule the HUD mixer
   * follows, and the reason "Mute calls: ON" is spelled MUTED / AUDIBLE.
   */
  _settings() {
    const s = this.settings();
    const row = (key, name, on, onWord, offWord, desc) => `
      <button class="ph-tg" type="button" role="switch" data-toggle="${key}"
              aria-checked="${on ? 'true' : 'false'}"
              aria-describedby="ph-d-${key}">
        <span class="ph-tg-tx">
          <b>${esc(name)}</b>
          <span class="ph-tg-d" id="ph-d-${key}">${esc(desc)}</span>
        </span>
        <span class="ph-tg-st">${on ? onWord : offWord}</span>
        <span class="ph-sw" aria-hidden="true"><i></i></span>
      </button>`;

    return `
      <div class="ph-settings">
        ${row('mature', 'Mature Dialogue', s.mature, 'ON', 'OFF',
          'Off by default. Lets a caller swear on a big moment — rare, never slurs or sexual content.')}
        ${row('muteCalls', 'Mute calls', s.muteCalls, 'MUTED', 'AUDIBLE',
          'Silences call audio. Subtitles keep working.')}
        ${row('voicesMuted', 'Mute voices', s.voicesMuted, 'MUTED', 'AUDIBLE',
          'Silences every spoken line in the city. Shared with the HUD audio panel.')}
        ${row('subtitles', 'Subtitles', s.subtitles, 'ON', 'OFF',
          'Prints what is said. The voice pack may be absent — this is the dialogue then.')}
        <p class="ph-note">
          Saved on this device. Mature Dialogue and Mute calls under
          <code>${esc(PHONE_PREFS_KEY)}</code>; the two shared switches live in the
          HUD audio panel&#39;s own <code>${esc(AUDIO_PREFS_KEY)}</code>, so the
          two surfaces can never disagree.
        </p>
      </div>`;
  }

  /* ----------------------------------------------------------- settings -- */

  settings() {
    return {
      mature: !!this.prefs.mature,
      muteCalls: !!this.prefs.muteCalls,
      voicesMuted: !!this.shared.voicesMuted,
      subtitles: !!this.shared.subtitles,
    };
  }

  setSetting(key, value) {
    const v = !!value;
    if (key === 'mature' || key === 'muteCalls') {
      this.prefs[key] = v;
      writePhonePrefs(this.prefs);
      /* Muting DURING a call silences the line already in flight. Unmuting
         cannot un-skip an element that was never constructed — see
         _startAudio — so it only lifts the volume of one that is still going. */
      if (key === 'muteCalls' && this._el) {
        try { this._el.volume = v ? 0 : callVolume(); } catch { /* detached */ }
      }
    } else if (key === 'voicesMuted' || key === 'subtitles') {
      this.shared[key] = v;
      writeShared(key, v);
      if (key === 'voicesMuted' && this._el) {
        try { this._el.volume = v ? 0 : callVolume(); } catch { /* detached */ }
      }
      if (key === 'subtitles') this._paintCall();
    } else {
      return this;
    }
    /* Re-render rather than patch the one row: the settings screen is five
       rows, this happens on a tap, and a partial update is how a toggle ends up
       showing the opposite of what it stored. */
    if (this._open && this._screen === 'settings' && !this._sub) this._renderBody();
    this._notifySettings(key);
    return this;
  }

  _notifySettings(changedKey) {
    this._emit('onSettings', this.settings(), changedKey);
  }

  /* -------------------------------------------------------------- store -- */

  data(kind) { return (this.store[kind] || []).slice(); }

  setData(kind, list) {
    if (!Object.prototype.hasOwnProperty.call(this.store, kind)) return this;
    this.store[kind] = [];
    for (const item of (Array.isArray(list) ? list : [])) {
      if (kind === 'contacts') this.pushContact(item, true);
      else if (kind === 'messages') this.pushMessage(item, true);
      else if (kind === 'alerts') this.pushAlert(item, true);
      else if (kind === 'calls') this.pushCall(item, true);
    }
    this._afterStoreChange();
    return this;
  }

  pushContact(raw, quiet = false) {
    const c = normalizeContact(raw, this);
    if (!c) return null;
    const i = this.store.contacts.findIndex((x) => x.id === c.id);
    if (i >= 0) this.store.contacts[i] = c;
    else this.store.contacts.push(c);
    if (this.store.contacts.length > MAX_KEEP.contacts) this.store.contacts.shift();
    if (!quiet) this._afterStoreChange();
    return c.id;
  }

  pushMessage(raw, quiet = false) {
    const m = normalizeMessage(raw, this);
    if (!m) return null;
    this.store.messages.push(m);
    if (this.store.messages.length > MAX_KEEP.messages) this.store.messages.shift();
    /* A message from someone with no contact card creates one, so Contacts is
       never a shorter list than Messages implies. */
    if (m.contactId && !this.store.contacts.some((c) => c.id === m.contactId)) {
      this.pushContact({ id: m.contactId, name: m.name, role: m.role }, true);
    }
    if (!quiet) {
      this._afterStoreChange();
      blip('click');
    }
    return m.id;
  }

  pushAlert(raw, quiet = false) {
    const a = normalizeAlert(raw, this);
    if (!a) return null;
    this.store.alerts.unshift(a);
    if (this.store.alerts.length > MAX_KEEP.alerts) this.store.alerts.pop();
    if (!quiet) this._afterStoreChange();
    return a.id;
  }

  /** History only — this never rings. `incomingCall` is what rings. */
  pushCall(raw, quiet = false) {
    const c = normalizeCall(raw, this);
    if (!c) return null;
    /* History only. A LIVE state handed in here would put a row in the log
       claiming a call is ringing while no card is on screen and no timer is
       running — `incomingCall()` is the only door into those states. */
    const st = raw && raw.state;
    c.state = (st === 'missed' || st === 'declined' || st === 'ended') ? st : 'ended';
    c.unread = st === 'missed' ? raw.unread !== false : false;
    c.seconds = Number(raw && raw.seconds) > 0 ? Number(raw.seconds) : 0;
    this._logCall(c);
    if (!quiet) this._afterStoreChange();
    return c.id;
  }

  _logCall(c) {
    const i = this.store.calls.findIndex((x) => x.id === c.id);
    if (i >= 0) this.store.calls[i] = c;
    else this.store.calls.unshift(c);
    if (this.store.calls.length > MAX_KEEP.calls) this.store.calls.pop();
    if (c.contactId && !this.store.contacts.some((x) => x.id === c.contactId)) {
      this.pushContact({ id: c.contactId, name: c.name, role: c.role }, true);
    }
  }

  _afterStoreChange() {
    this._syncBadge();
    if (this._open) this._renderBody();
  }

  _unread(kind) {
    if (kind === 'messages') return this.store.messages.filter((m) => m.unread).length;
    if (kind === 'alerts') return this.store.alerts.filter((a) => a.unread).length;
    if (kind === 'calls') return this.store.calls.filter((c) => c.state === 'missed' && c.unread).length;
    return 0;
  }

  badge() { return this._unread('messages') + this._unread('alerts') + this._unread('calls'); }

  _syncBadge() {
    const n = this.badge();
    this.badgeEl.hidden = n === 0;
    this.badgeEl.textContent = n > 9 ? '9+' : String(n);
    /* The count is on the BUTTON's label too, so it is not a red dot that only
       a sighted player can find. */
    this.btn.setAttribute('aria-label', n ? `Phone, ${n} unread` : 'Phone');
    this._syncTabs();
  }

  _markRead(kind) {
    let hit = false;
    if (kind === 'messages') for (const m of this.store.messages) { if (m.unread) { m.unread = false; hit = true; } }
    if (kind === 'alerts') for (const a of this.store.alerts) { if (a.unread) { a.unread = false; hit = true; } }
    if (kind === 'calls') for (const c of this.store.calls) { if (c.unread) { c.unread = false; hit = true; } }
    if (hit) { this._syncBadge(); this._emit('onRead', kind, null); }
  }

  /* --------------------------------------------------------------- call -- */

  /**
   * Ring.
   *
   * One call is live at a time. Anything arriving on top of a ringing or active
   * call is QUEUED — never a second card, and never a silent drop, because a
   * dropped call is indistinguishable from a system that never fired.
   *
   * @returns {string|null} the call id, or null if the policy refused it.
   */
  incomingCall(raw) {
    if (this._destroyed) return null;
    const c = normalizeCall(raw, this);
    if (!c) return null;

    if (this._call) {
      if (this._queue.length >= MAX_QUEUE) {
        const dropped = this._queue.shift();
        dropped.state = 'missed';
        /* Unread, like any other missed call. Without this the badge undercounts
           and the only trace of the drop is a row the player never gets pointed
           at — which is the "dropped call looks like a system that never fired"
           failure this queue exists to avoid. */
        dropped.unread = true;
        this.stats.missed++;
        this._logCall(dropped);
        this._emit('onMissed', dropped);
      }
      c.state = 'queued';
      this._queue.push(c);
      /* Repaint: the live card prints "N more waiting", and it was painted when
         the queue was still empty. */
      this._paintCall();
      this._afterStoreChange();
      return c.id;
    }

    this._call = c;
    this._minimized = false;
    this.stats.rung++;
    c.state = 'ringing';
    /* The opening line is shown BEFORE the player answers. That is the whole
       accessibility position of this feature: on a fresh clone there is no
       voice pack at all, and the text is the dialogue. */
    if (c.lines.length) c.shown = [c.lines[0].text];
    this._paintCall();
    this._showCall();
    blip('confirm');

    clearTimeout(this._ringT);
    this._ringT = setTimeout(() => this._miss(), RING_SECONDS * 1000);
    return c.id;
  }

  /* Same rule as the panel: the card is present or it is not. An incoming call
     is the one thing on this layer that MUST be seen the instant it exists. */
  _showCall() {
    this.callEl.hidden = false;
    this.chipEl.hidden = true;
  }

  _hideCallCard() {
    this.callEl.hidden = true;
  }

  _onCallClick(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('[data-act="answer"]')) this.answer();
    else if (t.closest('[data-act="dismiss"]')) this.dismiss();
    else if (t.closest('[data-act="minimize"]')) this.minimize();
    else if (t.closest('[data-act="end"]')) this.endCall(null, 'hangup');
  }

  /**
   * Draw the card for the live call.
   *
   * Rebuilt wholesale on every state change. It is one small card, it changes
   * perhaps six times per call, and a patched card is how a "Ringing" label
   * survives into an answered call.
   */
  _paintCall() {
    const c = this._call;
    if (!c) { this._hideCallCard(); return; }
    const st = CALL_STATE[c.state] || CALL_STATE.ringing;
    const ringing = c.state === 'ringing';
    const showText = this.shared.subtitles;
    const said = c.shown.slice(-3);

    const acts = ringing
      ? `<button class="ph-act answer" type="button" data-act="answer">
           ${ic('call', '1.05em')}<span>Answer</span>
         </button>
         <button class="ph-act dismiss" type="button" data-act="dismiss">
           ${ic('hangup', '1.05em')}<span>Dismiss</span>
         </button>
         <button class="ph-act min" type="button" data-act="minimize">
           ${ic('minimize', '1.05em')}<span>Minimize</span>
         </button>`
      : `<button class="ph-act dismiss" type="button" data-act="end">
           ${ic('hangup', '1.05em')}<span>End call</span>
         </button>
         <button class="ph-act min" type="button" data-act="minimize">
           ${ic('minimize', '1.05em')}<span>Minimize</span>
         </button>`;

    this.callEl.innerHTML = `
      <div class="ph-call-hd">
        <span class="ph-call-av ${ringing ? 'ring' : ''}">${avatarSvg(c, 44)}</span>
        <span class="ph-call-tx">
          <span class="ph-call-k">
            <span aria-hidden="true">${st.glyph}</span> ${esc(st.word)}
            ${c.state === 'active' ? `<span class="ph-call-t">${esc(mmss(c.seconds))}</span>` : ''}
            ${c.mature ? '<span class="ph-tag mature">MATURE</span>' : ''}
          </span>
          <b class="ph-call-nm">${esc(c.name)}</b>
          ${c.role ? `<span class="ph-call-rl">${esc(c.role)}</span>` : ''}
        </span>
      </div>
      ${showText && said.length
        ? `<div class="ph-call-cap" aria-live="polite">${said
            .map((t) => `<p>${esc(t)}</p>`).join('')}</div>`
        : ''}
      ${!showText && said.length
        ? '<p class="ph-call-off">Subtitles are off — turn them on in phone settings.</p>'
        : ''}
      <div class="ph-call-acts">${acts}</div>
      ${this._queue.length
        ? `<p class="ph-call-q">${this._queue.length} more waiting</p>`
        : ''}`;
  }

  answer(id) {
    const c = this._call;
    if (!c || (id && c.id !== id) || c.state !== 'ringing') return this;
    clearTimeout(this._ringT);
    c.state = 'active';
    c.startedAt = Date.now();
    c.seconds = 0;
    this.stats.answered++;
    this._logCall(c);
    this._paintCall();
    if (this._minimized) this._paintChip();
    this._startAudio(c);
    clearInterval(this._tickT);
    this._tickT = setInterval(() => this._tick(), 1000);
    blip('confirm');
    /* onAnswer BEFORE the transcript starts walking. A call with an empty
       script ends inside _advanceLines(), and firing onEnd at a system that
       has not yet been told the call was answered is an event order nobody
       downstream can be expected to handle. */
    this._emit('onAnswer', c);
    this._afterStoreChange();
    this._advanceLines();
    return this;
  }

  dismiss(id) {
    const c = this._call;
    if (!c || (id && c.id !== id)) return this;
    clearTimeout(this._ringT);
    c.state = 'declined';
    c.unread = false;
    this.stats.declined++;
    this._logCall(c);
    blip('back');
    this._emit('onDismiss', c);
    this._clearCall();
    return this;
  }

  _miss() {
    const c = this._call;
    if (!c || c.state !== 'ringing') return;
    c.state = 'missed';
    c.unread = true;
    this.stats.missed++;
    this._logCall(c);
    this._emit('onMissed', c);
    this._clearCall();
  }

  minimize(id) {
    const c = this._call;
    if (!c || (id && c.id !== id)) return this;
    this._minimized = true;
    this._hideCallCard();
    this._paintChip();
    this.chipEl.hidden = false;
    blip('click');
    return this;
  }

  restore(id) {
    const c = this._call;
    if (!c || (id && c.id !== id)) return this;
    this._minimized = false;
    this.chipEl.hidden = true;
    this._paintCall();
    this._showCall();
    blip('click');
    return this;
  }

  /** The chip is the promise that a minimised call is not lost: name, state
   *  WORD and a live timer, in 44 px of screen. */
  _paintChip() {
    const c = this._call;
    if (!c) { this.chipEl.hidden = true; return; }
    const st = CALL_STATE[c.state] || CALL_STATE.ringing;
    this.chipEl.querySelector('.ph-chip-dot').textContent = st.glyph;
    this.chipEl.querySelector('.ph-chip-nm').textContent = clip(c.name, 14);
    this.chipEl.querySelector('.ph-chip-st').textContent =
      c.state === 'active' ? mmss(c.seconds) : st.word;
    this.chipEl.setAttribute('aria-label', `${c.name}, ${st.word}. Return to the call`);
    this.chipEl.dataset.state = c.state;
  }

  _tick() {
    const c = this._call;
    if (!c || c.state !== 'active') { clearInterval(this._tickT); return; }
    c.seconds = Math.round((Date.now() - c.startedAt) / 1000);
    const t = this.callEl.querySelector('.ph-call-t');
    if (t) t.textContent = mmss(c.seconds);
    if (this._minimized) this._paintChip();
  }

  /** Walk the transcript. Each line lands as text whether or not audio plays. */
  _advanceLines() {
    const c = this._call;
    if (!c || c.state !== 'active') return;
    c.lineIndex++;
    const line = c.lines[c.lineIndex];
    if (!line) {
      /* Out of script. If audio is still running let it finish; otherwise the
         call is over. The handle is zeroed either way, because `sayLine()`
         reads it to decide whether the walker needs restarting and a spent
         timeout id is indistinguishable from a live one. */
      this._lineT = 0;
      if (!this._el) this.endCall(c.id, 'ended');
      return;
    }
    if (c.lineIndex > 0) c.shown.push(line.text);
    this._paintCall();
    this._emit('onLine', c, line);
    const secs = line.seconds > 0 ? line.seconds : readSeconds(line.text);
    clearTimeout(this._lineT);
    this._lineT = setTimeout(() => this._advanceLines(), secs * 1000);
  }

  /** Push one more line into a live call (the system may know more than it did
   *  when the call started). */
  sayLine(id, line) {
    const c = this._call;
    if (!c || (id && c.id !== id)) return this;
    const text = typeof line === 'string' ? line : String((line && line.text) || '');
    if (!text.trim()) return this;
    if (isForbidden(text)) { this.stats.blocked++; return this; }
    if (isStrong(line || text) && !this.prefs.mature) { this.stats.gated++; return this; }
    c.lines.push({ text: text.trim(), seconds: Number(line && line.seconds) || 0, url: '', mature: false });
    if (c.state === 'active' && !this._lineT) this._advanceLines();
    return this;
  }

  /**
   * Call audio, through an HTMLAudioElement and nothing else.
   *
   * See the header: the WebAudio path in this project is silent and five
   * attempts to fix it failed, so this follows VoiceSystem._startEl exactly —
   * construct, set volume, play, retire on `ended` or `error`. No nodes, no
   * bus, no pan. Distance does not apply: the caller is on the phone.
   */
  _startAudio(c) {
    this._stopAudio();
    if (!c || !c.url) return;
    if (this.api && this.api.playsAudio) return;   // the system owns playback
    if (typeof Audio !== 'function') return;
    /* Muted means NO ELEMENT, not an element at volume 0. `new Audio(url)`
       plus play() downloads the file either way, and paying for an mp3 on a
       phone connection to then not play it is not a trade anyone agreed to.
       The cost is that unmuting DURING a call is silent until the next one;
       the subtitles carry that call, which is the whole point of them. */
    if (this.prefs.muteCalls || this.shared.voicesMuted) return;
    const el = new Audio(c.url);
    const lvl = callVolume();
    el.volume = Number.isFinite(lvl) ? lvl : 0;
    this._el = el;
    el.addEventListener('ended', () => {
      if (this._el === el) this._el = null;
      /* The script may still have lines left; only end the call when both the
         audio and the transcript are done. */
      if (this._call === c && c.lineIndex >= c.lines.length - 1) this.endCall(c.id, 'ended');
    }, { once: true });
    el.addEventListener('error', () => { if (this._el === el) this._el = null; }, { once: true });
    const p = el.play();
    if (p && p.catch) {
      p.catch(() => {
        /* Autoplay refused before the first gesture. The subtitles carry the
           call on their own, so this is not worth a console line. */
        if (this._el === el) this._el = null;
      });
    }
    this.stats.played++;
  }

  _stopAudio() {
    const el = this._el;
    this._el = null;
    if (el) { try { el.pause(); el.src = ''; } catch { /* already gone */ } }
  }

  endCall(id, reason = 'ended') {
    const c = this._call;
    if (!c || (id && c.id !== id)) return this;
    c.state = c.state === 'ringing' ? 'missed' : 'ended';
    if (c.state === 'missed') { c.unread = true; this.stats.missed++; }
    if (c.startedAt) c.seconds = Math.max(1, Math.round((Date.now() - c.startedAt) / 1000));
    this._logCall(c);
    this._emit('onEnd', c, reason);
    this._clearCall();
    return this;
  }

  /** Tear the live call down and start the next queued one, if any. */
  _clearCall() {
    clearTimeout(this._ringT);
    clearTimeout(this._lineT);
    clearInterval(this._tickT);
    this._ringT = 0; this._lineT = 0; this._tickT = 0;
    this._stopAudio();
    this._call = null;
    this._minimized = false;
    this._hideCallCard();
    this.chipEl.hidden = true;
    this._afterStoreChange();

    const next = this._queue.shift();
    if (next) {
      /* Re-enter through the front door so the queue, the ring timer and the
         stats all behave exactly as they do for a fresh call. */
      const raw = next;
      raw.state = 'ringing';
      setTimeout(() => {
        if (this._destroyed || this._call) return;
        this._call = raw;
        this.stats.rung++;
        if (raw.lines.length) raw.shown = [raw.lines[0].text];
        this._paintCall();
        this._showCall();
        blip('confirm');
        clearTimeout(this._ringT);
        this._ringT = setTimeout(() => this._miss(), RING_SECONDS * 1000);
      }, 650);
    }
  }

  /* -------------------------------------------------------------- misc -- */

  _clockTick() {
    if (this._destroyed) return;
    if (this.clockEl) this.clockEl.textContent = clockTime();
    /* Once a minute is plenty for a status-bar clock, and it costs one text
       write — this is not going anywhere near the frame loop. */
    this._clockT = setTimeout(() => this._clockTick(), 30000);
  }

  _emit(name, ...args) {
    const fn = this.api && this.api[name];
    if (typeof fn !== 'function') return;
    try { fn.call(this.api, ...args); }
    catch (err) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(`[phone] api.${name} threw`, err);
      }
    }
  }

  unmount() {
    if (this._destroyed) return;
    this._destroyed = true;
    clearTimeout(this._ringT);
    clearTimeout(this._lineT);
    clearTimeout(this._clockT);
    clearInterval(this._tickT);
    this._stopAudio();
    window.removeEventListener('keydown', this._onWinKey, true);
    window.removeEventListener('pointerdown', this._onDown, true);
    if (this._measureStatus) window.removeEventListener('resize', this._measureStatus);
    if (this._ro) { try { this._ro.disconnect(); } catch { /* already gone */ } this._ro = null; }
    this.root.removeEventListener('keydown', this._keyGuard);
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    if (typeof globalThis !== 'undefined' && globalThis.__PHONEUI__ === this._facade) {
      globalThis.__PHONEUI__ = null;
    }
  }
}

/* ==========================================================================
 * MOUNT
 * ======================================================================== */

/** @type {PhoneUI|null} the instance `unmount()` tears down when called bare. */
let _current = null;

/**
 * Build the phone and put it on screen.
 *
 * @param {HTMLElement} root  #hud-layer (recommended) or #ui-root
 * @param {object} [api]      the PhoneSystem's surface — see the header
 * @returns {object} the controller
 */
export function mount(root, api = null) {
  if (_current) unmount();
  const ui = new PhoneUI(root, api);
  _current = ui;

  const facade = {
    /* screens */
    open: (s) => (ui.open(s), facade),
    close: () => (ui.close(), facade),
    toggle: () => (ui.toggle(), facade),
    isOpen: () => ui.isOpen(),
    screen: () => ui.screen(),
    setVisible: (on) => (ui.setVisible(on), facade),

    /* calls */
    incomingCall: (c) => ui.incomingCall(c),
    answer: (id) => (ui.answer(id), facade),
    dismiss: (id) => (ui.dismiss(id), facade),
    minimize: (id) => (ui.minimize(id), facade),
    restore: (id) => (ui.restore(id), facade),
    endCall: (id, reason) => (ui.endCall(id, reason), facade),
    sayLine: (id, line) => (ui.sayLine(id, line), facade),

    /* content */
    pushMessage: (m) => ui.pushMessage(m),
    pushAlert: (a) => ui.pushAlert(a),
    pushCall: (c) => ui.pushCall(c),
    pushContact: (c) => ui.pushContact(c),
    setData: (kind, list) => (ui.setData(kind, list), facade),
    data: (kind) => ui.data(kind),

    /* settings + state */
    settings: () => ui.settings(),
    setSetting: (k, v) => (ui.setSetting(k, v), facade),
    badge: () => ui.badge(),
    stats: () => ({ ...ui.stats }),
    selftest: () => __selftest(),

    el: ui.root,
    ui,
    unmount: () => unmount(),
  };

  ui._facade = facade;
  /* Same reason hud.js publishes `globalThis.__miamiHUD`: without a handle,
     "is the phone even mounted?" is unanswerable from the console or from a
     screenshot harness. */
  if (typeof globalThis !== 'undefined') globalThis.__PHONEUI__ = facade;
  return facade;
}

/** Tear the mounted phone down. Safe to call twice. */
export function unmount(target) {
  const ui = target && target.ui ? target.ui : (target instanceof PhoneUI ? target : _current);
  if (!ui) return;
  ui.unmount();
  if (ui === _current) _current = null;
}

/* ==========================================================================
 * SELFTEST — the unit test the content policy is required to have.
 *
 * Runs in a browser (this module imports a stylesheet, which Node cannot load,
 * exactly as hud.js cannot be imported in Node):
 *   __PHONEUI__.selftest()
 *   import('/src/ui/phone-ui.js').then(m => console.log(m.__selftest()))
 *
 * It asserts the filter BITES, not that it exists. Every case below is a string
 * that must never reach a player, plus the clean lines that must survive — a
 * filter that blocks everything is as broken as one that blocks nothing.
 * ======================================================================== */

export function __selftest() {
  const errors = [];
  const check = (name, ok, detail) => { if (!ok) errors.push(`${name}${detail ? ` — ${detail}` : ''}`); };

  /* 1 — the hard filter bites, at every setting. -------------------------- */
  const mustBlock = [
    ['slur', 'you absolute f4ggot'],
    ['slur', 'that n1gger over there'],
    ['slur', 'typical tranny nonsense'],
    ['hate', 'all immigrants are vermin'],
    ['hate: violence', 'gas the jews'],
    ['hate: supremacy', 'white power forever'],
    ['sexual', 'send me nudes after the match'],
    ['sexual', 'she gave him a blowjob'],
    ['threat', 'i am going to kill you and your family'],
    ['threat: real-world', 'we should bomb the school'],
    ['impersonation: agency', 'this is the Miami-Dade police department'],
    ['impersonation: agency', 'FBI, open up'],
    ['impersonation: brand', 'sponsored by Coca-Cola'],
    ['impersonation: link', 'follow me at @realguy'],
    ['markup', 'nice <script>alert(1)</script> hole'],
  ];
  for (const [why, text] of mustBlock) {
    check(`DENY misses ${why}`, !!isForbidden(text), JSON.stringify(text));
  }

  /* 2 — and does NOT bite clean game dialogue. ---------------------------- */
  const mustPass = [
    'The whole bench just went into that pit.',
    'City Response is rolling two units to the marina.',
    'Mina here — are you seeing this?',
    'Niger is a river; Scunthorpe is a town.',
    'She was being niggardly with the fries.',
    'That is one classy hole, my friend.',
  ];
  for (const text of mustPass) {
    const bad = isForbidden(text);
    check('DENY false positive', !bad, bad ? `${text} :: ${bad.why}` : '');
  }

  /* 3 — the mature band is separate from the hard filter. ----------------- */
  check('mild line is not strong', !isStrong({ text: 'That is a big hole.' }));
  check('unflagged swear is caught as strong', isStrong({ text: 'What the hell was that' }));
  check('flag alone marks a line strong', isStrong({ text: 'nothing rude here', mature: true }));
  check('a strong line is not forbidden', !isForbidden('What the hell was that'));

  /* 4 — validateLines throws, and says what and where. -------------------- */
  let threw = null;
  try {
    validateLines({ greeting: { mina: [{ id: 'x1', text: 'this is the NYPD' }] } });
  } catch (err) { threw = err; }
  check('validateLines throws on a violation', threw instanceof PhoneContentError);
  check('the violation names its location',
    !!threw && /x1|greeting/.test(String(threw.message)), threw && threw.message);

  let ok = null;
  try {
    ok = validateLines([
      { id: 'a', text: 'Two units, marina side.' },
      { id: 'b', text: 'Damn, that was close.', mature: true },
    ]);
  } catch (err) { ok = err; }
  check('validateLines passes a clean corpus', !!ok && ok.ok === true, String(ok && ok.message));
  check('validateLines counts the mature lines', !!ok && ok.mature === 1, ok && String(ok.mature));

  let unflagged = null;
  try {
    unflagged = validateLines([{ id: 'c', text: 'Damn, that was close.' }]);
  } catch (err) { unflagged = err; }
  check('an unflagged strong line is a violation', unflagged instanceof PhoneContentError);

  /* 5 — names and roles go through the same gate as lines. ---------------- */
  const ctx = { stats: { blocked: 0, gated: 0 }, prefs: { mature: false } };
  check('a caller named after a real force is refused',
    normalizeCall({ name: 'LAPD Dispatch', line: 'hello' }, ctx) === null);
  check('a mature line is dropped with the setting off',
    normalizeCall({ name: 'Rey', line: 'What the hell was that' }, ctx) === null);
  check('the drops are counted', ctx.stats.blocked === 1 && ctx.stats.gated === 1,
    JSON.stringify(ctx.stats));
  const on = { stats: { blocked: 0, gated: 0 }, prefs: { mature: true } };
  check('a mature line survives with the setting on',
    !!normalizeCall({ name: 'Rey', line: 'What the hell was that' }, on));
  check('the hard filter ignores the mature setting',
    normalizeCall({ name: 'Rey', line: 'you f4ggot' }, on) === null);

  /* 6 — the numbers the CSS depends on. ----------------------------------- */
  check('tap floor is 44 px', TAP_PX === 44);
  check('every screen has a tab', SCREENS.length === 5 && SCREEN_IDS.length === 5);
  check('the element trim matches VoiceSystem', CALL_EL_TRIM === 0.55);

  return { ok: errors.length === 0, errors, checks: 40 - errors.length };
}
