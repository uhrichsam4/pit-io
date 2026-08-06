#!/usr/bin/env node
/**
 * MIAMI DEVOUR — OFFLINE VOICE GENERATION (ElevenLabs).
 *
 * This script turns the game's two line libraries — src/audio/voicelines.js
 * (street NPCs) and src/phone/callers.js (the in-game phone) — into a folder of
 * small, loudness-matched mp3s plus a manifest the game loads by id. It runs on
 * a laptop or in CI. It must NEVER run at gameplay time and the game must never
 * see the API key — the browser only ever fetches finished audio by URL.
 *
 * The phone library is OPTIONAL. If src/phone/callers.js is absent, exports
 * nothing this adapter recognises, or throws while loading, the NPC lines are
 * generated exactly as before and the run says which of those happened. Pass
 * --no-phone to skip it deliberately.
 *
 * ---------------------------------------------------------------------------
 * THE CONTENT GATE
 *
 * Every line from both libraries is checked before anything is planned, and a
 * line that fails is never sent, never written and never reaches the manifest —
 * see POLICY_RULES. This is enforced HERE, in the tool that spends the money
 * and writes the assets, and not only in the modules that author the lines,
 * because that is the last point where refusing still costs nothing. The
 * libraries' own validators (`validateLines()` / `__selftest()`) are run too
 * and a failure from either aborts the run.
 *
 * `--policy` runs the whole gate and exits: no network, no cost, exit 1 if
 * anything is forbidden.
 *
 *   node tools/generate-voices.mjs                 # DRY RUN (the default)
 *   node tools/generate-voices.mjs --go            # actually spend credits
 *   node tools/generate-voices.mjs --secrets-help  # just the setup commands
 *
 * ---------------------------------------------------------------------------
 * WHY DRY RUN IS THE DEFAULT
 *
 * Every character sent to ElevenLabs is billed against a finite monthly quota,
 * and a bad `--only` filter or a library refactor that changes every line id
 * can burn the whole allowance in ninety seconds. So the bare command does the
 * safe thing: it prints the exact lines it would send, the per-cast and total
 * character count, and stops. You have to type `--go` to spend money. A tool
 * that costs real money on its happy path is a tool that eventually costs
 * money by accident.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE KEY COMES FROM, AND WHERE IT NEVER GOES
 *
 * Only `process.env`. Not a CLI argument (argv is visible to every other
 * process on the box via `ps` and lands in shell history), not a file the
 * script hunts for on disk, never a literal in source.
 *
 * A missing key is the NORMAL state — most runs of this repo have no key and
 * do not want one. So a missing key prints the setup instructions and exits 0.
 * It is not a crash and it must not fail CI.
 *
 * Three independent layers keep the key out of the output:
 *   1. It lives in a closure inside createKeyring() and is never returned. The
 *      caller gets `request()`, not the string.
 *   2. redact() scrubs every live key value AND anything key-shaped out of
 *      every line this script prints, including uncaught exception stacks —
 *      because a fetch failure deep in undici can quote request state, and
 *      "probably does not include headers" is not a security control.
 *   3. writeJsonSafe() re-scans each JSON payload immediately before it hits
 *      the disk and throws if redaction changed anything. If a key ever finds
 *      a path into the manifest, the run dies instead of shipping it.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE FILES GO
 *
 *   public/audio/voice/<id>.mp3      finished, trimmed, loudness-matched
 *   public/audio/voice/manifest.json id -> { url, ms, cast, voice, source }
 *   .voice-cache/raw/<hash>.mp3      the untouched API response
 *   .voice-cache/index.json          content-hash cache, resolved voice ids,
 *                                    and the stock voice directory
 *
 * `url` IS A BARE FILENAME. src/audio/voice.js resolves a relative asset url
 * against the manifest's own url, so `x.mp3` beside
 * `/audio/voice/manifest.json` is `/audio/voice/x.mp3`. Writing a path there
 * once produced `/audio/voice/audio/voice/x.mp3`: the manifest loaded fine and
 * all 111 files 404'd, which the game reports as "no voice pack" rather than as
 * a broken path. --url-base exists for a CDN and refuses a relative value.
 *
 * public/audio/voice/ is already in .gitignore and Vite copies public/ into
 * dist/ at build time, so the finished audio deploys with no extra wiring.
 *
 * The raw downloads deliberately do NOT live under public/. Vite's copyDir()
 * is a plain readdirSync walk with no dotfile filter (verified in
 * node_modules/vite/dist/node/chunks/node.js), so a `.raw/` folder inside
 * public/ would be copied into dist/ and deployed — shipping every un-mastered
 * duplicate to players. .voice-cache/ at the repo root sidesteps that, and the
 * script drops a self-ignoring `.gitignore` (`*`, which in git's matcher does
 * cover the .gitignore itself) into it so the directory can never be committed
 * without touching the repo's root .gitignore.
 *
 * Keeping the raw response is the single biggest quota saver here. The cache
 * key is split in two: a SOURCE hash over everything the API sees (text, voice,
 * model, format, settings) and a POST hash over the ffmpeg mastering settings.
 * Change the loudness target and only ffmpeg re-runs — off the raw file, for
 * free. Only a text or voice change costs a credit.
 *
 * ---------------------------------------------------------------------------
 * VERIFIED API SURFACE (checked against ElevenLabs docs, do not re-derive)
 *
 *   POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=
 *        header: xi-api-key
 *        body:   { text, model_id, voice_settings:{ stability, similarity_boost,
 *                  style, use_speaker_boost, speed }, seed,
 *                  apply_text_normalization }
 *        200 -> binary audio (application/octet-stream)
 *   GET  https://api.elevenlabs.io/v2/voices?search=&page_size=&voice_type=
 *        -> { voices: [{ voice_id, name, description, labels, category }] }
 *   GET  https://api.elevenlabs.io/v1/user/subscription
 *        -> { tier, character_count, character_limit, ... }
 *
 *   429 = too_many_concurrent_requests | system_busy  -> back off, do NOT
 *         assume the key is dead. Free-tier concurrency is 2, which is why
 *         --concurrency defaults to 2.
 *   400/401 = insufficient quota or bad key -> retire this key slot, roll on.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, statSync,
  readdirSync, renameSync, copyFileSync,
} from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ======================================================== configuration === */

const API_BASE = 'https://api.elevenlabs.io';

/**
 * eleven_multilingual_v2 is the default for a reason: it is the quality model
 * that every account tier can call, and it ignores nothing in the request we
 * send. The turbo/flash models are half price per character but audibly
 * thinner, and these clips are generated once and shipped forever — paying
 * double for assets you never regenerate is the correct trade.
 */
const DEFAULT_MODEL = 'eleven_multilingual_v2';

/** 128 kbps mp3 is the default output format available on every plan. */
const DEFAULT_FORMAT = 'mp3_44100_128';

/** Characters per credit, per model. Estimate only — billing is theirs. */
const CREDIT_RATE = {
  eleven_multilingual_v2: 1,
  eleven_multilingual_v1: 1,
  eleven_english_sts_v2: 1,
  eleven_v3: 1,
  eleven_turbo_v2_5: 0.5,
  eleven_turbo_v2: 0.5,
  eleven_flash_v2_5: 0.5,
  eleven_flash_v2: 0.5,
};

/**
 * Mastering settings. Bump POST_VERSION whenever anything in here changes in a
 * way that alters the output bytes — it forces a re-master off the cached raw
 * downloads without touching the API.
 *
 *  -16 LUFS is the loudness these barks sit at. It is quieter than a music
 *  master on purpose: a voice line is a gameplay signal layered on top of a
 *  synthesised mix that is already close to full scale (see src/core/audio.js,
 *  which soft-clips at 0.92), and a bark mastered to -9 would duck the entire
 *  game every time a tourist speaks.
 *
 *  Mono, always. These play through positional panning, so a stereo file is
 *  downmixed on the way in — the second channel is pure wasted download.
 *
 *  60 ms of lead and 100 ms of tail are KEPT rather than trimmed to zero. A
 *  hard cut at the first sample of speech clicks, and a hard cut on the last
 *  clips the natural decay of a shout.
 */
const POST_VERSION = 1;
const MASTER = {
  lufs: -16, truePeak: -1.5, lra: 11,
  leadSilence: 0.06, tailSilence: 0.10, threshold: '-45dB',
  rate: 44100, channels: 1, bitrate: '96k',
};

/**
 * voiceDirection -> voice_settings. First match wins and the order is
 * deliberate: a line directed "panicked but amused" is a panic read.
 *
 * Low stability = more emotional range and more variance between takes; high
 * stability = flat and consistent. A dispatcher must sound the same every
 * time (0.68); a tourist watching a sinkhole eat a hotdog cart must not.
 */
const DIRECTION_HINTS = [
  { re: /panic|frantic|scream|terrif|freak|hysteric/i, stability: 0.28, style: 0.55, speed: 1.08 },
  { re: /excit|hyped|thrill|amped|stream|creator|influenc/i, stability: 0.35, style: 0.50, speed: 1.05 },
  { re: /worried|nervous|anxious|uneasy|alarm/i, stability: 0.40, style: 0.35, speed: 1.03 },
  { re: /amused|cheer|breezy|sunny|playful|delight|bubbly/i, stability: 0.45, style: 0.38, speed: 1.00 },
  { re: /gruff|gravel|tough|grizzled|weathered/i, stability: 0.60, style: 0.25, speed: 0.97 },
  { re: /authorit|command|officer|dispatch|announce|official|security/i, stability: 0.68, style: 0.22, speed: 0.98 },
  { re: /deadpan|dry|bored|weary|flat|unimpressed/i, stability: 0.75, style: 0.10, speed: 0.96 },
  { re: /elderly|older|gentle|kindly|unhurried/i, stability: 0.70, style: 0.15, speed: 0.92 },
];
const BASE_SETTINGS = {
  stability: 0.5, similarity_boost: 0.75, style: 0.2, use_speaker_boost: true, speed: 1.0,
};

/** Words that carry no signal when searching the voice library. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'the', 'with', 'of', 'in', 'on', 'to', 'for', 'is', 'as',
  'who', 'that', 'this', 'their', 'his', 'her', 'its', 'very', 'quite', 'but',
  'or', 'sounds', 'sound', 'like', 'voice', 'speaks', 'speaking', 'tone',
  'slightly', 'somewhat', 'bit', 'little', 'always', 'often',
]);

/** A bark is one breath. Anything longer is almost certainly a mistake. */
const LONG_LINE_CHARS = 220;

/* ========================================================= phone callers === */

/**
 * The in-game phone's line library. Written by another module and NOT REQUIRED
 * TO EXIST: if the file is absent, or exports nothing this adapter recognises,
 * the run generates the NPC lines exactly as before and says so out loud. A
 * missing phone library is a normal state, not a failure — the two libraries
 * ship independently.
 */
const PHONE_LIBRARY = 'src/phone/callers.js';

/**
 * Export names the phone library may plausibly use. Wider than the NPC list
 * because that module is being written concurrently and the house rule about
 * never guessing an API name cuts both ways: rather than assume one spelling
 * and silently generate zero phone lines, accept every reasonable one and
 * PRINT which shape matched.
 */
const PHONE_CAST_NAMES = [
  'CALLERS', 'PHONE_CAST', 'PHONE_CALLERS', 'CONTACTS', 'PHONE_CONTACTS',
  'CAST', 'VOICE_CAST', 'callers', 'contacts', 'cast',
];
const PHONE_LINE_NAMES = [
  'PHONE_LINES', 'CALL_LINES', 'CALLS', 'MESSAGES', 'DIALOGUE', 'SCRIPT',
  'LINES', 'VOICE_LINES', 'lines', 'calls', 'messages', 'script',
];

/**
 * Stock voices the NPC cast ALREADY SHIPPED WITH.
 *
 * Not a preference — a reconstruction. Every pair here was read out of
 * public/audio/voice/manifest.json (the `voice` field on all 111 assets) and
 * cross-checked against docs/AUDIO_ASSET_MANIFEST.md §2. These ten voices are
 * therefore PROVEN to work on this account's plan, which matters because free
 * tiers cannot use Shared Voice Library voices and can use the built-in
 * defaults.
 *
 * It exists for two reasons, both of which cost money if ignored:
 *
 *  1. .voice-cache/ is gitignored and is not present in a fresh clone. Without
 *     this table a re-run has no memory of which voice each NPC used, searches
 *     the library again, can legitimately get a different answer, and
 *     regenerates all 111 shipped clips in a different voice at full price.
 *  2. It RESERVES those ten names, so a phone caller is never handed a voice a
 *     street NPC is already using. The phone is supposed to sound like other
 *     people.
 *
 * Names, not ids. No ElevenLabs voice id appears anywhere in this repository or
 * its history (verified: `git log --all -S` on five stock ids, plus a
 * full-history grep for `voice_id`), so hardcoding one here would be a guess.
 * Names are resolved to ids once, through the cached stock directory, for zero
 * characters.
 */
const VOICE_NAME_BY_CAST = {
  'mina-sol': 'Jessica',
  'orla-fenn': 'Alice',
  'dax-perrone': 'Chris',
  'jun-marrow': 'Will',
  'tavo-reyes': 'Bill',
  'marla-quist': 'Matilda',
  'ike-dorsett': 'Daniel',
  'dispatch-vale': 'Brian',
  'zee-mabry': 'Eric',
  'odetta-frame': 'Lily',
};

/* ======================================================= content policy === */

/**
 * THE HARD GATE. Nothing that trips this is ever sent to the API, and nothing
 * that trips it can reach public/audio/voice/.
 *
 * This is deliberately enforced HERE and not only in the line libraries. This
 * file is the last point before a line becomes (a) a paid API call and (b) a
 * binary asset committed to the repo and served to players. A policy that lives
 * only in the module that authors the lines is one careless import away from
 * being bypassed; a policy in the tool that spends the money cannot be.
 *
 * The libraries' own validators run too — __selftest() from voicelines.js and
 * validateLines() from the phone library, whichever exist. This is a floor, not
 * a replacement.
 *
 * Scope, stated honestly: this is a tripwire against carelessness in a corpus
 * authored inside this repository by known hands. It is not an adversarial
 * filter and cannot be. If a legitimate line trips it, REWRITE THE LINE — do
 * not widen the pattern. That rule is copied verbatim from voicelines.js
 * because it is the only rule that keeps a denylist meaningful over time.
 */

/**
 * Slur and hate-speech stems, base64 so that this repository does not itself
 * contain a plain-text list of slurs. Decoded once at load. Matching is done
 * per token (exact, or stem + a common inflection) rather than by substring,
 * because a bare substring match rejects "spice" and "raccoon" — and a filter
 * that cries wolf is a filter people start disabling.
 */
const HATE_STEMS = Buffer.from(
  'bmlnZyxuaWdyLGZhZ2csZmFnb3Qsa2lrZSxzcGljLGNoaW5rLGdvb2ssd2V0YmFjayx0cmFubnks'
  + 'cmV0YXJkLHJhZ2hlYWQsdG93ZWxoZWFkLGNvb24sZHlrZSxwYWtpLGd5cCxtb25nb2xvaWQsY3Jp'
  + 'cHBsZSxoYWxmYnJlZWQsemlwcGVyaGVhZCxiZWFuZXI=',
  'base64',
).toString('utf8').split(',');

/** Inflections that still leave a stem a slur. Anything else is a real word. */
const STEM_TAILS = ['', 's', 'es', 'ed', 'ing', 'er', 'ers', 'ish', 'a', 'o', 'as', 'os', 'y', 'ies'];

/**
 * Ordinary words that collide with a stem under the rule above.
 *
 * Keep this list SHORT and check every addition against the stem it exempts.
 * "coons" was in here and should never have been: the words it was meant to
 * protect ("raccoon", "cocoon") do not START with the stem, so the rule above
 * already lets them through, while the exception was quietly disabling one of
 * the 22 stems entirely. Caught by the test that asserts every stem still
 * fires — which is the only reason a denylist with an exception list is safe
 * to have at all.
 */
const STEM_EXCEPTIONS = new Set(['spicy', 'spices', 'spicier', 'gypsy', 'gypsies']);

/** Leetspeak folding, so `f4gg0t` is caught by the same stem as `faggot`. */
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i' };

function foldToken(t) {
  let s = '';
  for (const ch of String(t).toLowerCase()) {
    if (LEET[ch]) s += LEET[ch];
    else if (ch >= 'a' && ch <= 'z') s += ch;
  }
  return s;
}

/**
 * Rules that are readable in the clear. Every one of these is a category the
 * brief names as forbidden AT ANY SETTING — the "Mature Dialogue" toggle can
 * unlock a sharper joke, never anything on this list.
 */
const POLICY_RULES = [
  {
    why: 'sexual content',
    re: /\b(sex|sexy|sexual|porn|nude|naked|horny|orgasm|blowjob|handjob|jerk\s*off|boobs?|tits?|nipples?|genital|penis|vagina|dick|cock|pussy|whore|slut|hooker|strip\s*club|masturbat\w*)\b/i,
  },
  {
    why: 'threat of violence against a person',
    re: /\b(kill|murder|shoot|stab|strangle|behead|lynch|bomb|rape|assault)\b[^.?!]{0,24}\b(you|him|her|them|us|me|yourself|everyone|somebody|someone)\b/i,
  },
  {
    why: 'threat of violence against a person',
    re: /\b(i(?:’|')?ll|i\s+will|gonna|going\s+to)\b[^.?!]{0,20}\b(kill|murder|shoot|stab|hurt|beat|bomb|burn)\b/i,
  },
  {
    // No line in a game about a sinkhole needs to name a protected class. The
    // rule is blunt on purpose: naming one is the precondition for almost every
    // way this corpus could harass a group, so the whole construction is out.
    why: 'names a protected group (nothing in this corpus needs to)',
    // `disabled` and `handicapped` are matched only as PERSON nouns. Bare, they
    // reject "the line is disabled" and "you parked in the handicapped space",
    // both of which are perfectly ordinary things for a caller to say in this
    // game — and a gate that blocks ordinary lines is a gate somebody turns off.
    re: /\b(muslims?|islamic?|jews?|jewish|christians?|hindus?|sikhs?|buddhists?|black\s+people|white\s+people|asians?|arabs?|latinos?|latinas?|hispanics?|mexicans?|africans?|immigrants?|illegals?|refugees?|gays?|lesbians?|bisexuals?|transgender|transsexuals?|queers?|autistic|the\s+disabled|disabled\s+(?:people|person|folks)|the\s+handicapped(?!\s+(?:space|spot|bay|stall|ramp|zone|parking|sign)))\b/i,
  },
  {
    why: 'harassment or dehumanising generalisation',
    re: /\b(all|those|these|you)\s+\w{3,15}s\s+(are|should\s+be|deserve|belong)\b/i,
  },
  {
    // Impersonation. A tripwire, not proof: no list of brands can be complete.
    // What it does catch is the careless case — reaching for a real force or a
    // real company because it is the first name that came to mind.
    why: 'real agency, force or public body',
    re: /\b(fbi|cia|dea|atf|nsa|nypd|lapd|chpd|mpd|swat|scotland\s*yard|met\s*police|police\s+department|sheriff(?:’|')?s?\s+(office|department)|national\s+guard|coast\s*guard|fema|homeland\s+security|miami\s*(?:dade)?\s*(?:police|fire|pd))\b/i,
  },
  {
    why: 'real company or brand',
    re: /\b(google|apple|microsoft|amazon|meta|facebook|instagram|tiktok|twitter|youtube|netflix|uber|lyft|tesla|nike|adidas|mcdonald|starbucks|walmart|coca[\s-]?cola|pepsi|disney|playstation|xbox|nintendo|rockstar\s+games|iphone|android|whatsapp|snapchat|twitch|discord)\b/i,
    // "® / ™" is a separate, unambiguous tell.
  },
  { why: 'trademark or registered mark', re: /[™®©]/ },
  { why: 'link or social handle', re: /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|gg|tv)\b|@[a-z0-9_]{2,})/i },
  { why: 'control character', re: /[\u0000-\u001f\u007f]/ },
];

/**
 * Check one line's text.
 * @returns {string[]} the reasons it is not allowed. Empty means allowed.
 */
export function checkLinePolicy(text) {
  const s = String(text ?? '');
  const hits = [];
  for (const rule of POLICY_RULES) if (rule.re.test(s)) hits.push(rule.why);

  for (const raw of s.split(/[^\p{L}\p{N}@$!]+/u)) {
    if (!raw) continue;
    const tok = foldToken(raw);
    if (!tok || STEM_EXCEPTIONS.has(tok)) continue;
    for (const stem of HATE_STEMS) {
      if (!tok.startsWith(stem)) continue;
      if (!STEM_TAILS.includes(tok.slice(stem.length))) continue;
      hits.push('slur or hate speech');
      break;
    }
  }
  // Same reason twice is noise in a report that a human has to read.
  return [...new Set(hits)];
}

/**
 * Run the gate over a whole library.
 *
 * @param {Array<{id:string,text:string}>} lines
 * @returns {{ok:boolean, violations:Array<{id:string,why:string[]}>}}
 */
export function checkLibraryPolicy(lines) {
  const violations = [];
  for (const line of lines ?? []) {
    const why = checkLinePolicy(line?.text);
    if (why.length) violations.push({ id: line?.id ?? '(no id)', cast: line?.cast ?? '', why });
  }
  return { ok: violations.length === 0, violations };
}

/** The throwing form, for a caller that wants the run to die rather than skip. */
export function assertLibraryPolicy(lines) {
  const { ok, violations } = checkLibraryPolicy(lines);
  if (!ok) {
    throw new Error(`content policy: ${violations.length} line(s) rejected — `
      + violations.slice(0, 5).map((v) => `${v.id} (${v.why.join('; ')})`).join(', '));
  }
  return true;
}

/* ============================================================= redaction === */

/**
 * The last line of defence. Every string this script prints goes through here.
 *
 * Two passes: the exact key values we know about, and a shape-based sweep for
 * anything that looks like a credential we have never seen — an error body
 * that echoes a key back, a stack frame that quotes a header. Being noisy about
 * a false positive is free; leaking once is not.
 */
const KNOWN_SECRETS = new Set();

/**
 * Two different jobs, two different tolerances for a false positive.
 *
 * PRINT_SHAPES is paranoid, because over-redacting a line of terminal output
 * costs nothing. It includes a bare 32+ hex run to catch legacy-format keys.
 *
 * WRITE_SHAPES is precise, because a false positive there ABORTS THE RUN. The
 * bare-hex rule cannot be used here: this script's own cache index is full of
 * sha256 content hashes, and including it meant the write guard refused to
 * save the cache — which would have quietly turned every re-run into a full
 * re-generation at full price. (Found by the guard firing during testing,
 * which is the guard doing its job in both directions.) The `sk_` prefix and
 * the header name are specific enough that no data this tool produces can
 * collide with them.
 */
const PRINT_SHAPES = [
  /\bsk_[A-Za-z0-9]{16,}/g,      // current ElevenLabs key format
  /\bxi-api-key["'\s:=]+\S+/gi,  // the header itself, however it got quoted
  /\b[0-9a-f]{32,}\b/g,          // legacy 32-hex keys — also matches sha256
];
const WRITE_SHAPES = [
  /\bsk_[A-Za-z0-9]{16,}/g,
  /\bxi-api-key["'\s:=]+\S+/gi,
];

function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 8) KNOWN_SECRETS.add(value);
}

function scrub(input, shapes) {
  let s = typeof input === 'string' ? input : String(input ?? '');
  for (const secret of KNOWN_SECRETS) {
    if (secret && s.includes(secret)) s = s.split(secret).join('[REDACTED]');
  }
  for (const re of shapes) s = s.replace(re, '[REDACTED]');
  return s;
}

/** For anything that reaches a terminal. Over-redacts on purpose. */
function redact(input) { return scrub(input, PRINT_SHAPES); }

/** For anything that reaches the disk. Exact about what counts as a secret. */
function containsSecret(text) { return scrub(text, WRITE_SHAPES) !== text; }

/* ================================================================= output === */

const out = {
  json: false,
  quiet: false,
  say(...parts) { if (!this.json && !this.quiet) console.log(redact(parts.join(' '))); },
  // Warnings go to stderr unconditionally, including under --json. They cannot
  // corrupt a stdout JSON payload from there, and a warning that a cast has no
  // voice is exactly the thing a CI log needs to keep.
  warn(...parts) { if (!this.quiet) console.warn(redact(`  ! ${parts.join(' ')}`)); },
  fail(...parts) { console.error(redact(`  x ${parts.join(' ')}`)); },
};

// A rejected promise deep inside fetch prints a stack Node formats itself,
// bypassing out.say(). Intercept both terminal handlers so nothing reaches the
// terminal unredacted, no matter which layer throws.
process.on('uncaughtException', (err) => {
  console.error(redact(err?.stack || String(err)));
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error(redact(err?.stack || String(err)));
  process.exit(1);
});

/* ============================================================== arguments === */

function parseArgs(argv) {
  const a = argv.slice();
  const has = (...names) => names.some((n) => a.includes(`--${n}`));
  const val = (name, dflt) => {
    const i = a.indexOf(`--${name}`);
    if (i < 0) return dflt;
    const v = a[i + 1];
    return v === undefined || v.startsWith('--') ? dflt : v;
  };

  return {
    // Dry run unless --go. --dry-run is accepted so the safe intent can be
    // stated out loud in a CI file, but it is also what you get by default.
    dryRun: !has('go', 'execute', 'write') || has('dry-run'),
    force: has('force'),
    strict: has('strict'),
    json: has('json'),
    quiet: has('quiet'),
    verbose: has('verbose'),
    prune: has('prune'),
    quotaOnly: has('quota'),
    secretsOnly: has('secrets-help', 'secrets'),
    schemaOnly: has('schema'),
    help: has('help', 'h'),
    noFfmpeg: has('no-ffmpeg'),
    only: val('only', '') ? String(val('only', '')).split(',').map((s) => s.trim()).filter(Boolean) : [],
    limit: Number(val('limit', '0')) || 0,
    model: String(val('model', DEFAULT_MODEL)),
    format: String(val('format', DEFAULT_FORMAT)),
    concurrency: Math.max(1, Math.min(8, Number(val('concurrency', '2')) || 2)),
    outDir: resolve(ROOT, String(val('out', 'public/audio/voice'))),
    cacheDir: resolve(ROOT, String(val('cache', '.voice-cache'))),
    library: String(val('library', 'src/audio/voicelines.js')),
    /* The phone's line library. --no-phone skips it entirely; a missing file is
       not an error either way. */
    phoneLibrary: has('no-phone') ? '' : String(val('phone', PHONE_LIBRARY)),
    /* Generate lines flagged as mature. They are still gated at RUNTIME by the
       player's setting (default off) — this only controls whether the asset
       exists at all, which is the useful lever for a build that must not carry
       the sharper takes in its bundle. */
    mature: !has('no-mature'),
    policyOnly: has('policy'),
    voicePool: String(val('voice-pool', 'default')),
    /**
     * EMPTY BY DEFAULT — the manifest stores a BARE FILENAME.
     *
     * src/audio/voice.js resolves a relative asset url against the MANIFEST's
     * url, so `x.mp3` beside `/audio/voice/manifest.json` is
     * `/audio/voice/x.mp3` and stays correct if the pack ever moves to a hashed
     * directory. Storing `audio/voice/x.mp3` here instead produced
     * `/audio/voice/audio/voice/x.mp3` and every single file 404'd while the
     * manifest itself loaded perfectly — the failure looked like "no voice
     * pack", not like a broken path. The guard in main() refuses any relative
     * non-empty value for the same reason.
     */
    urlBase: String(val('url-base', '')),
  };
}

const HELP = `
miami devour — offline voice generation

  node tools/generate-voices.mjs [flags]

  (no flags)         DRY RUN. Lists every line that would be generated and the
                     estimated character cost. Makes zero network calls.
  --go               Actually call ElevenLabs and write audio. Spends credits.

  --only a,b         Only lines whose id, cast, category or LIBRARY matches.
                     "--only phone" and "--only npc" select a whole library.
  --limit N          Generate at most N clips this run (quota airbag).
  --force            Ignore the content cache and regenerate.
  --prune            Move orphaned mp3s to .voice-cache/orphans/ (never deletes).

  --phone PATH       Phone caller library. Default ${PHONE_LIBRARY}.
                     A missing file is fine: the NPC lines still generate.
  --no-phone         Skip the phone library entirely.
  --no-mature        Do not generate lines flagged mature. (They are gated at
                     runtime by the player's setting regardless; this decides
                     whether the audio exists at all.)
  --policy           Run the content-policy gate over every line and stop.
                     Costs nothing, makes no network call.

  --model ID         Default ${DEFAULT_MODEL}.
  --format F         Default ${DEFAULT_FORMAT}.
  --concurrency N    Default 2 — the free plan's concurrent-request cap.
  --voice-pool P     default | community | personal | all. Default "default"
                     (ElevenLabs stock voices, present on every account).
  --no-ffmpeg        Skip trimming and loudness matching.
  --out DIR          Default public/audio/voice.
  --cache DIR        Default .voice-cache.

  --quota            Print remaining characters per key slot. Costs nothing.
  --schema           Print how the line library was parsed, then stop.
  --secrets-help     Print the secret setup commands, then stop.
  --json             Machine-readable summary on stdout.
  --verbose          Echo each request (with the auth header redacted).
  --strict           Exit non-zero when the line library is missing.
`;

/* ================================================================ keyring === */

/**
 * Holds key material in a closure and hands out a request function, never the
 * strings. Nothing outside this factory can reach a key, which is why the
 * public `slots` array — the thing that gets logged and summarised — physically
 * cannot contain one.
 *
 * Rotation policy, and why it is not simply "roll on any error":
 *   401/400  the key is dead or out of quota. Retire the slot, retry the same
 *            line on the next one.
 *   403      forbidden, usually a key without TTS permission. Same treatment.
 *   429      ambiguous. `too_many_concurrent_requests` and `system_busy` are
 *            both transient and both mean "wait", not "this key is bad" —
 *            rotating on those would burn through every slot in a stampede and
 *            report a false quota failure. Back off first; only roll to the
 *            next slot if the body actually mentions quota, or if the backoff
 *            budget is exhausted.
 *   5xx      theirs, not ours. Back off, retry, never rotate.
 */
function createKeyring(env) {
  const keys = [];
  const slots = [];

  const add = (label, raw) => {
    // `export KEY="sk_..."` pasted through a .env parser keeps its quotes, and
    // a key copied out of a web page picks up a trailing newline. Both produce
    // a 401 that looks exactly like an expired key and costs an hour.
    let k = String(raw ?? '').trim();
    if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
      k = k.slice(1, -1).trim();
    }
    if (!k) return;
    if (keys.includes(k)) return; // same key in two vars is one key
    registerSecret(k);
    keys.push(k);
    slots.push({ slot: label, index: slots.length + 1, state: 'ready', calls: 0, chars: 0, note: '' });
  };

  // A single var may hold several comma-separated keys; _2.._9 are separate
  // vars for owners who find comma-splitting fragile. Both work, order is
  // stable, and the run reports slot numbers only.
  for (const part of String(env.ELEVENLABS_API_KEY ?? '').split(',')) {
    add(`ELEVENLABS_API_KEY#${slots.length + 1}`, part);
  }
  for (let n = 2; n <= 9; n++) {
    const name = `ELEVENLABS_API_KEY_${n}`;
    if (env[name]) add(name, env[name]);
  }

  let cursor = 0;
  const alive = () => slots.filter((s) => s.state === 'ready').length;

  const advance = (why) => {
    slots[cursor].state = 'retired';
    slots[cursor].note = why;
    const start = cursor;
    do { cursor = (cursor + 1) % slots.length; }
    while (slots[cursor].state !== 'ready' && cursor !== start);
    return slots[cursor].state === 'ready';
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * One authenticated request, with rotation and backoff. Returns
   * { ok, status, buf, json, text, slot } — `slot` is the label, never a key.
   */
  async function request(path, { method = 'GET', body = null, accept = 'application/json', verbose = false } = {}) {
    if (!slots.length) return { ok: false, status: 0, error: 'no key slots' };

    let backoffMs = 2000;
    let attempts = 0;
    const maxAttempts = 4 + slots.length;

    while (attempts < maxAttempts) {
      attempts++;
      const slot = slots[cursor];
      if (slot.state !== 'ready') {
        if (!advance('skipped')) return { ok: false, status: 0, error: 'all key slots retired' };
        continue;
      }

      if (verbose) {
        // The auth header is deliberately NOT reproduced here, not even as a
        // placeholder. Writing `xi-api-key: <slot>` seems safe and is not: the
        // print scrubber matches the header name plus the next token, so it
        // redacted the slot label along with it and --verbose lost the one
        // fact it exists to report. Naming the slot on its own, and never
        // rendering the header at all, is both safer and more useful.
        out.say(`      [${slot.slot}] ${method} ${path}`
          + (body ? `\n      body ${JSON.stringify(body).slice(0, 180)}` : ''));
      }

      let res;
      try {
        res = await fetch(`${API_BASE}${path}`, {
          method,
          headers: {
            'xi-api-key': keys[cursor],
            accept,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        // Transport failure. Never a key problem; back off and try again.
        if (attempts >= maxAttempts) return { ok: false, status: 0, error: redact(err?.message || 'network error') };
        await sleep(backoffMs); backoffMs = Math.min(backoffMs * 2, 30000);
        continue;
      }

      slot.calls++;

      if (res.ok) {
        const buf = accept.startsWith('audio') || accept === 'application/octet-stream'
          ? Buffer.from(await res.arrayBuffer())
          : null;
        const text = buf ? null : await res.text();
        let json = null;
        if (text) { try { json = JSON.parse(text); } catch { /* not json, fine */ } }
        return { ok: true, status: res.status, buf, json, text, slot: slot.slot };
      }

      // Error bodies can echo request state. Everything derived from one is
      // redacted before it is stored, let alone printed.
      const raw = await res.text().catch(() => '');
      const detail = redact(raw).slice(0, 300);
      const quotaish = /quota|credit|insufficient|exceeded|limit reached/i.test(detail);

      if (res.status === 401 || res.status === 400 || res.status === 403) {
        const why = quotaish ? 'out of quota' : `rejected (HTTP ${res.status})`;
        out.warn(`key slot ${slot.slot} retired: ${why}`);
        if (!advance(why)) return { ok: false, status: res.status, error: `all key slots retired (${why})`, detail };
        continue;
      }

      if (res.status === 429) {
        if (quotaish) {
          out.warn(`key slot ${slot.slot} retired: quota exhausted`);
          if (!advance('quota exhausted')) return { ok: false, status: 429, error: 'all key slots retired', detail };
          continue;
        }
        // Concurrency or their traffic. Waiting is the whole fix.
        if (attempts >= maxAttempts) return { ok: false, status: 429, error: 'rate limited', detail };
        await sleep(backoffMs); backoffMs = Math.min(backoffMs * 2, 30000);
        continue;
      }

      if (res.status >= 500) {
        if (attempts >= maxAttempts) return { ok: false, status: res.status, error: 'upstream error', detail };
        await sleep(backoffMs); backoffMs = Math.min(backoffMs * 2, 30000);
        continue;
      }

      return { ok: false, status: res.status, error: `HTTP ${res.status}`, detail };
    }
    return { ok: false, status: 0, error: 'retries exhausted' };
  }

  return {
    /** Public metadata only. Safe to log, safe to JSON.stringify. */
    slots,
    get count() { return slots.length; },
    get alive() { return alive(); },
    get activeSlot() { return slots[cursor]?.slot ?? null; },
    creditsUsed(chars) { if (slots[cursor]) slots[cursor].chars += chars; },
    request,
  };
}

/* ======================================================== line library ===== */

/**
 * Load and normalise src/audio/voicelines.js.
 *
 * The library is owned by another module and may legitimately be shaped as
 * named exports, a default object, a flat array, or a cast/category tree. The
 * house rule about never guessing an API name applies with force here: the
 * failure mode of a wrong guess is not a crash, it is a run that quietly
 * generates ZERO lines and reports success — exactly the kerb pass that placed
 * no objects for a whole build.
 *
 * So this adapter never guesses silently. It records which shape matched,
 * prints the counts, and treats "matched a shape but found no lines" as a hard
 * error with the module's real export names dumped for comparison. --schema
 * prints the whole parse so the library's author can check alignment without
 * spending a credit.
 *
 * @param {string} libraryPath
 * @param {{castNames?:string[], lineNames?:string[], synthesiseCasts?:boolean,
 *          source?:string}} [opts]
 *   `source` tags every cast and line ('npc' | 'phone') so the report and the
 *   manifest can tell the two libraries apart after they are merged.
 *   `synthesiseCasts` is for a library that files its lines under a caller id
 *   without also exporting a caller table — legal, but it means no
 *   voiceDirection, so it is warned about rather than accepted silently.
 * @returns {Promise<{ok:boolean, reason?:string, exports?:string[],
 *                     casts:Map<string,object>, lines:object[], shape:string}>}
 */
export async function loadVoiceLibrary(libraryPath = 'src/audio/voicelines.js', opts = {}) {
  const castNames = opts.castNames ?? ['CAST', 'VOICE_CAST', 'CASTS', 'VOICE_CASTS', 'cast', 'casts', 'voices', 'VOICES'];
  const lineNames = opts.lineNames ?? ['LINES', 'VOICE_LINES', 'lines', 'voiceLines', 'LINE_LIBRARY', 'library'];
  const source = opts.source ?? 'npc';
  const abs = resolve(ROOT, libraryPath);
  if (!existsSync(abs)) {
    return { ok: false, reason: 'missing', path: abs, casts: new Map(), lines: [], shape: 'none' };
  }

  let mod;
  try {
    mod = await import(pathToFileURL(abs).href);
  } catch (err) {
    return { ok: false, reason: `import failed: ${redact(err?.message || err)}`, path: abs, casts: new Map(), lines: [], shape: 'none' };
  }

  const exportNames = Object.keys(mod);
  // A default export that carries the data is as valid as named exports; merge
  // it under the named ones so an explicit named export always wins.
  const root = (mod.default && typeof mod.default === 'object')
    ? { ...mod.default, ...mod }
    : mod;

  const pick = (...names) => {
    for (const n of names) {
      const v = root[n];
      if (v && typeof v === 'object') return { key: n, value: v };
    }
    return null;
  };

  const castSrc = pick(...castNames);
  const lineSrc = pick(...lineNames);

  if (!lineSrc || (!castSrc && !opts.synthesiseCasts)) {
    return {
      ok: false,
      reason: `could not find ${!castSrc ? 'a cast table' : ''}${!castSrc && !lineSrc ? ' or ' : ''}${!lineSrc ? 'a line table' : ''}`,
      exports: exportNames, path: abs, casts: new Map(), lines: [], shape: 'unrecognised',
    };
  }

  /* --- casts ------------------------------------------------------------- */
  const casts = new Map();
  const castEntries = !castSrc ? []
    : Array.isArray(castSrc.value)
      ? castSrc.value.map((c) => [c?.id ?? c?.key ?? c?.name, c])
      : Object.entries(castSrc.value);

  for (const [rawId, def] of castEntries) {
    const id = String(rawId ?? '').trim();
    if (!id || !def || typeof def !== 'object') continue;
    casts.set(id, {
      id,
      source,
      name: def.displayName ?? def.name ?? def.label ?? id,
      // `role` ("tourist", "taxi-driver", "dispatcher") is the single most
      // useful search term there is, because the ElevenLabs voice library
      // labels voices by use case. Worth far more than any adjective.
      role: def.role ?? '',
      // Several plausible field names for the same idea; whichever the library
      // uses, we read it. Missing direction is survivable (we fall back to the
      // cast name) but is reported, because an undirected voice is a coin flip.
      voiceDirection: def.voiceDirection ?? def.direction ?? def.voice ?? def.description ?? '',
      voiceId: def.voiceId ?? def.voice_id ?? null,
      // A pinned stock voice by NAME. Cheaper and far more legible than an id,
      // and it is the only form this repository has ever recorded — see
      // VOICE_NAME_BY_CAST.
      voiceName: def.voiceName ?? def.voice_name ?? def.stockVoice ?? null,
      voiceSettings: def.voiceSettings ?? def.voice_settings ?? null,
      model: def.model ?? def.model_id ?? null,
    });
  }

  /* --- lines ------------------------------------------------------------- */
  // Walk whatever tree we were handed. A leaf is a string or an object with a
  // `text` field; the path to it becomes the fallback id, which is why an
  // explicit `id` in the library is strongly preferred — reordering an array
  // renames path-derived ids and invalidates their cache entries.
  const found = [];
  const walk = (node, path) => {
    if (node == null) return;
    if (typeof node === 'string') { found.push({ text: node, path: [...path] }); return; }
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, [...path, String(i)])); return; }
    if (typeof node !== 'object') return;
    if (typeof node.text === 'string' || typeof node.line === 'string') {
      found.push({ ...node, text: node.text ?? node.line, path: [...path] });
      return;
    }
    for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
  };
  walk(lineSrc.value, []);

  /** Whoever is speaking, under whichever field name this library chose. */
  const speakerOf = (raw) => String(
    raw.cast ?? raw.castId ?? raw.voice ?? raw.speaker ?? raw.from ?? raw.caller ?? raw.contact ?? '',
  ).trim();

  /**
   * A library may file its lines under a caller id without exporting a caller
   * table. That is legal and it still generates — but every synthesised cast
   * has an EMPTY voiceDirection, so its voice is chosen by name alone. The
   * caller is told, loudly, once per cast.
   */
  const synthesised = [];
  if (!castSrc && opts.synthesiseCasts) {
    for (const raw of found) {
      const id = speakerOf(raw) || String((raw.path ?? [])[0] ?? '').trim();
      if (!id || casts.has(id)) continue;
      casts.set(id, {
        id, source, name: id, role: '', voiceDirection: '',
        voiceId: null, voiceName: null, voiceSettings: null, model: null, synthesised: true,
      });
      synthesised.push(id);
    }
  }

  const lines = [];
  const rejected = [];
  const seen = new Set();

  for (const raw of found) {
    const path = raw.path ?? [];
    const castFromPath = path.find((seg) => casts.has(seg)) ?? null;
    const cast = speakerOf(raw) || String(castFromPath ?? '').trim();
    const afterCast = castFromPath ? path[path.indexOf(castFromPath) + 1] : path[0];
    const category = String(raw.category ?? raw.kind ?? raw.tag ?? raw.event ?? afterCast ?? 'misc');
    const id = String(raw.id ?? raw.key ?? path.join('.') ?? '').trim();
    const text = String(raw.text ?? '').trim();

    if (!text) { rejected.push({ id, why: 'empty text' }); continue; }
    if (!id) { rejected.push({ id: '(none)', why: 'no id and no path' }); continue; }
    if (!cast || !casts.has(cast)) {
      rejected.push({ id, why: cast ? `unknown cast "${cast}"` : 'no cast could be determined' });
      continue;
    }
    if (seen.has(id)) { rejected.push({ id, why: 'duplicate id' }); continue; }
    seen.add(id);

    /* Is this one of the sharper lines the "Mature Dialogue" setting unlocks?
       Five plausible spellings, because guessing one and being wrong would
       silently mark every mature line as mild — and the flag is what --no-mature
       and the run report are counting. Which field actually matched is
       reported, so a mismatch is visible instead of assumed. */
    const matureField = raw.mature !== undefined ? 'mature'
      : raw.isMature !== undefined ? 'isMature'
        : raw.adult !== undefined ? 'adult'
          : raw.explicit !== undefined ? 'explicit'
            : (raw.tier !== undefined || raw.rating !== undefined) ? (raw.tier !== undefined ? 'tier' : 'rating')
              : null;
    const mature = matureField === 'tier' || matureField === 'rating'
      ? /mature|strong|adult|explicit/i.test(String(raw.tier ?? raw.rating))
      : Boolean(matureField && raw[matureField]);

    lines.push({ id, cast, category, text, source, mature, matureField });
  }

  const shape = `${castSrc ? castSrc.key : `synthesised(${synthesised.length})`} + ${lineSrc.key}`;
  if (!lines.length) {
    return {
      ok: false,
      reason: `parsed "${shape}" but extracted 0 usable lines`,
      exports: exportNames, rejected, path: abs, casts, lines: [], shape,
    };
  }

  return { ok: true, casts, lines, rejected, shape, exports: exportNames, path: abs, synthesised, mod };
}

/**
 * Load the phone's caller library. NEVER throws, and a missing file is a
 * NORMAL, reported outcome — the phone module is written by other hands and
 * may not exist yet. Nothing about the NPC pass depends on this succeeding.
 */
export async function loadPhoneLibrary(libraryPath = PHONE_LIBRARY) {
  if (!libraryPath) return { ok: false, reason: 'disabled (--no-phone)', casts: new Map(), lines: [], shape: 'none' };
  try {
    return await loadVoiceLibrary(libraryPath, {
      castNames: PHONE_CAST_NAMES,
      lineNames: PHONE_LINE_NAMES,
      synthesiseCasts: true,
      source: 'phone',
    });
  } catch (err) {
    // loadVoiceLibrary already catches an import failure; this is the belt for
    // a module that throws at *evaluation* time in a way that escapes it.
    return {
      ok: false, reason: `threw while loading: ${redact(err?.message || err)}`,
      casts: new Map(), lines: [], shape: 'none',
    };
  }
}

/**
 * Fold the phone library into the NPC one.
 *
 * Two collisions matter and both are silent if you do not look for them:
 *
 *   cast id  — a phone caller sharing an id with a street NPC would overwrite
 *              that NPC's voice direction and hand both characters one voice.
 *              Renamed to `phone-<id>` and reported.
 *   line id  — an id IS a filename. A phone line colliding with an NPC line
 *              would overwrite a clip that already shipped, which reads in game
 *              as "one NPC suddenly says something about a phone call". These
 *              are REJECTED, never renamed: ids are immutable by contract
 *              (see the header of src/audio/voicelines.js).
 */
export function mergeLibraries(npc, phone) {
  const casts = new Map(npc.casts);
  const lines = [...npc.lines];
  const npcLineIds = new Set(npc.lines.map((l) => l.id));
  const renamed = [];
  const dropped = [];

  const idMap = new Map();
  for (const cast of phone.casts.values()) {
    let id = cast.id;
    if (casts.has(id)) {
      id = `phone-${cast.id}`;
      renamed.push({ from: cast.id, to: id });
    }
    idMap.set(cast.id, id);
    casts.set(id, { ...cast, id });
  }

  for (const line of phone.lines) {
    if (npcLineIds.has(line.id)) {
      dropped.push({ id: line.id, why: 'line id already exists in the NPC library — ids are filenames and are immutable' });
      continue;
    }
    lines.push({ ...line, cast: idMap.get(line.cast) ?? line.cast });
  }

  return { casts, lines, renamed, dropped };
}

/* ============================================================== hashing ==== */

const sha = (s) => createHash('sha256').update(s).digest('hex');

/** Filesystem-safe, collision-checked by the caller. */
const safeName = (id) => String(id).toLowerCase()
  .replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 90) || 'line';

/**
 * Everything the API sees. Two lines with the same source hash are the same
 * audio, so identical text spoken by the same cast is generated once and the
 * second id simply points at the first file — free, and common in a bark
 * library where several triggers share a "Nope, nope, nope!".
 */
function sourceHashOf(line, voiceId, settings, cfg) {
  return sha(JSON.stringify({
    text: line.text, voiceId, settings,
    model: cfg.model, format: cfg.format,
  }));
}

/** Only the mastering. Changing this re-runs ffmpeg, never the API. */
function postHashOf() {
  return sha(JSON.stringify({ v: POST_VERSION, ...MASTER })).slice(0, 16);
}

/* ================================================== voice_settings/voice === */

/** Derive voice_settings from the cast's written direction. */
export function settingsFor(cast) {
  if (cast.voiceSettings) return { ...BASE_SETTINGS, ...cast.voiceSettings };
  const text = `${cast.voiceDirection} ${cast.name}`;
  for (const hint of DIRECTION_HINTS) {
    if (hint.re.test(text)) {
      const { re, ...vals } = hint;
      return { ...BASE_SETTINGS, ...vals };
    }
  }
  return { ...BASE_SETTINGS };
}

const keywordsOf = (s) => String(s).toLowerCase().match(/[a-z][a-z'-]{2,}/g)?.filter((w) => !STOPWORDS.has(w)) ?? [];

/**
 * The account's stock voice directory, fetched ONCE and cached forever.
 *
 * GET /v2/voices is a metadata read: it costs ZERO characters, which is the
 * whole reason a name can be used as the pin instead of an id. `voice_type` is
 * what keeps a free-tier account out of trouble — Shared Voice Library voices
 * are not usable there, the built-in defaults are, and `--voice-pool default`
 * asks for exactly the usable set.
 *
 * Returns null rather than throwing when there is no key or the run is dry.
 * Callers treat null as "cannot resolve yet", which is already how an
 * unresolved cast is handled.
 */
async function stockDirectory({ keyring, cache, cfg }) {
  const hit = cache.stock;
  if (hit && hit.pool === cfg.voicePool && Array.isArray(hit.voices) && hit.voices.length) {
    return hit.voices;
  }
  if (cfg.dryRun || !keyring.count) return null;

  const query = new URLSearchParams({
    page_size: '100',
    ...(cfg.voicePool === 'all' ? {} : { voice_type: cfg.voicePool }),
  });
  const res = await keyring.request(`/v2/voices?${query}`, { verbose: cfg.verbose });
  if (!res.ok || !Array.isArray(res.json?.voices)) {
    out.warn(`stock voice directory unavailable: ${res.error ?? 'no voices returned'}`);
    return null;
  }
  const voices = res.json.voices.map((v) => ({
    id: v.voice_id,
    name: String(v.name ?? ''),
    labels: v.labels ?? {},
    description: String(v.description ?? ''),
  })).filter((v) => v.id);
  // Cached under the pool it was fetched for: switching --voice-pool must not
  // silently reuse a directory that does not contain the requested voices.
  cache.stock = { pool: cfg.voicePool, fetchedAt: new Date().toISOString(), voices };
  out.say(`  voice pool:   ${voices.length} "${cfg.voicePool}" voices (1 metadata call, 0 characters)`);
  return voices;
}

const byName = (dir, name) => (dir ?? []).find(
  (v) => v.name.toLowerCase() === String(name ?? '').toLowerCase(),
) ?? null;

/**
 * Resolve every cast to a concrete voice_id.
 *
 * Order of precedence, most explicit first:
 *   1. cast.voiceId in the library      — deterministic, zero API calls
 *   2. env VOICE_ID_<CAST>              — pin a voice without editing source
 *   3. a pinned stock voice NAME         — cast.voiceName, or the shipped table
 *                                          VOICE_NAME_BY_CAST; resolved through
 *                                          the cached directory for 0 characters
 *   4. the resolved-voice cache          — the search runs once, ever
 *   5. GET /v2/voices?search=<direction> — scored, deterministic tie-break
 *
 * There is deliberately NO step 6. If resolution fails the cast is SKIPPED with
 * a specific instruction, because the alternative — falling back to some
 * hardcoded voice id — would silently give the elderly park visitor whatever
 * voice happened to be first, and nobody would notice until playtest.
 *
 * Casts are also kept distinct: a voice already claimed by an earlier cast is
 * passed over while any alternative remains. Six NPCs sharing one voice is the
 * failure this cast list exists to avoid — and it is now also what guarantees
 * a phone caller never answers in a street NPC's voice, because both libraries
 * are resolved in ONE pass against ONE `taken` set. Order matters here: the NPC
 * casts are resolved first (they have shipped assets to match), so a collision
 * always costs the phone caller a preference, never an NPC a re-generation.
 */
async function resolveVoices({ casts, keyring, cache, cfg, env }) {
  const taken = new Set();
  const unresolved = [];

  // NPCs first — see the note above about who yields in a collision.
  const ordered = [...casts.values()].sort((a, b) => {
    const rank = (c) => (c.source === 'phone' ? 1 : 0);
    return rank(a) - rank(b) || String(a.id).localeCompare(String(b.id));
  });

  for (const cast of ordered) {
    if (cast.voiceId) { cast.voiceSource = 'library'; taken.add(cast.voiceId); continue; }

    const envKey = `VOICE_ID_${cast.id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
    if (env[envKey]) {
      cast.voiceId = String(env[envKey]).trim();
      cast.voiceSource = `env ${envKey}`;
      taken.add(cast.voiceId);
      continue;
    }

    const pinnedName = cast.voiceName ?? VOICE_NAME_BY_CAST[cast.id] ?? null;
    if (pinnedName) {
      const dir = await stockDirectory({ keyring, cache, cfg });
      const hit = byName(dir, pinnedName);
      if (hit) {
        cast.voiceId = hit.id;
        cast.voiceName = hit.name;
        cast.voiceSource = `pinned name "${hit.name}"`;
        taken.add(cast.voiceId);
        cache.voices = cache.voices ?? {};
        cache.voices[cast.id] = { voiceId: hit.id, name: hit.name, direction: cast.voiceDirection, via: 'name' };
        continue;
      }
      if (dir) {
        // The directory loaded and the name is not in it. Say so — silently
        // falling through to a search would recast a shipped character.
        out.warn(`cast "${cast.id}" pins stock voice "${pinnedName}", which is not in the `
          + `"${cfg.voicePool}" pool (${dir.length} voices). Falling back to a search.`);
      }
    }

    const cached = cache.voices?.[cast.id];
    if (cached?.voiceId && cached.direction === cast.voiceDirection) {
      cast.voiceId = cached.voiceId;
      cast.voiceName = cached.name;
      cast.voiceSource = 'cache';
      taken.add(cast.voiceId);
      continue;
    }

    if (cfg.dryRun || !keyring.count) { unresolved.push(cast.id); continue; }

    const words = keywordsOf(`${cast.role} ${cast.voiceDirection || cast.name}`);
    const query = new URLSearchParams({
      search: words.slice(0, 8).join(' '),
      page_size: '60',
      ...(cfg.voicePool === 'all' ? {} : { voice_type: cfg.voicePool }),
    });
    const res = await keyring.request(`/v2/voices?${query}`, { verbose: cfg.verbose });
    if (!res.ok || !Array.isArray(res.json?.voices)) {
      out.warn(`voice search failed for cast "${cast.id}": ${res.error ?? 'no voices returned'}`);
      unresolved.push(cast.id);
      continue;
    }

    // Score on keyword overlap across name, description and labels, with a
    // bonus for a matching gender/age label. Ties break on voice_id so a
    // re-run after a cache wipe picks the same voice as last time.
    const want = new Set(words);
    const gender = /\b(woman|female|she|her|lady)\b/i.test(cast.voiceDirection) ? 'female'
      : /\b(man|male|he|his|guy)\b/i.test(cast.voiceDirection) ? 'male' : null;
    const age = /\b(teen|young|kid|youth)\b/i.test(cast.voiceDirection) ? 'young'
      : /\b(elderly|older|senior|old)\b/i.test(cast.voiceDirection) ? 'old' : null;

    const scored = res.json.voices.map((v) => {
      const hay = `${v.name ?? ''} ${v.description ?? ''} ${Object.values(v.labels ?? {}).join(' ')}`.toLowerCase();
      let score = 0;
      for (const w of want) if (hay.includes(w)) score += 2;
      if (gender && String(v.labels?.gender ?? '').toLowerCase().includes(gender)) score += 3;
      if (age && String(v.labels?.age ?? '').toLowerCase().includes(age)) score += 2;
      return { v, score };
    }).sort((a, b) => b.score - a.score || String(a.v.voice_id).localeCompare(String(b.v.voice_id)));

    const chosen = scored.find((s) => !taken.has(s.v.voice_id));
    if (chosen) {
      cast.voiceId = chosen.v.voice_id;
      cast.voiceName = chosen.v.name;
      cast.voiceSource = `search (score ${chosen.score})`;
    } else {
      /**
       * Every search result is already spoken for — or the search returned
       * nothing at all, which is what happens to a caller with no
       * voiceDirection to search on.
       *
       * The old code ended `?? scored[0]` here, which quietly handed the cast a
       * voice another character was already using. Distinctness is the entire
       * point of the cast list, so instead take the first UNCLAIMED voice from
       * the stock directory, deterministically by id, and say out loud that a
       * preference was not honoured.
       */
      const dir = await stockDirectory({ keyring, cache, cfg });
      const free = (dir ?? [])
        .filter((v) => !taken.has(v.id))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
      if (!free) { unresolved.push(cast.id); continue; }
      cast.voiceId = free.id;
      cast.voiceName = free.name;
      cast.voiceSource = 'first unclaimed stock voice';
      out.warn(`cast "${cast.id}" had no distinct search match; assigned stock voice `
        + `"${free.name}". Give it a voiceDirection, or pin one with voiceName, `
        + `to choose deliberately.`);
    }
    taken.add(cast.voiceId);
    cache.voices = cache.voices ?? {};
    cache.voices[cast.id] = { voiceId: cast.voiceId, name: cast.voiceName, direction: cast.voiceDirection };
  }

  return { unresolved };
}

/* =============================================================== planning == */

/**
 * Decide what would be generated. Pure — no network, no writes — so --dry-run
 * and the real run share one code path and can never disagree about what the
 * run is about to do.
 */
export function planGeneration({ casts, lines, cache, cfg }) {
  const post = postHashOf();
  const jobs = [];
  const cached = [];
  const skipped = [];
  /* Rejected by the content policy. Kept apart from `skipped` because these are
     not a scheduling decision — they are lines that must never be spoken, and
     they get their own section in the report and their own exit code. */
  const blocked = [];
  const byHash = new Map();
  const byFile = new Map();

  // `--only phone` / `--only npc` select a whole library, which is the filter
  // you actually want when one of the two changed and the other did not.
  const match = (line) => !cfg.only.length || cfg.only.some((f) =>
    line.id.startsWith(f) || line.cast === f || line.category === f || line.source === f);

  for (const line of lines) {
    if (!match(line)) continue;

    /**
     * THE GATE, and it is here rather than in the reporting layer on purpose:
     * planGeneration() is the only thing that decides what gets sent, so a line
     * rejected here cannot become an API call, cannot become an mp3, and cannot
     * appear in the manifest. Refusing at render time would already be too
     * late — the money is spent and the file is on disk.
     */
    const why = checkLinePolicy(line.text);
    if (why.length) {
      blocked.push({ ...line, why: `content policy: ${why.join('; ')}` });
      continue;
    }

    /* Mature lines are gated at RUNTIME by the player's setting, which defaults
       off. --no-mature is a separate, stronger lever: do not even create the
       asset, so a public build cannot carry it at all. */
    if (line.mature && !cfg.mature) {
      skipped.push({ ...line, why: 'flagged mature and --no-mature was passed' });
      continue;
    }

    const cast = casts.get(line.cast);

    // A dry run must still cost a cast whose voice has not been looked up yet.
    // Voice resolution needs a network call, which a dry run refuses to make,
    // so on a first run EVERY cast is unresolved — and skipping those lines
    // made the estimate read "0 characters", which is the one number the owner
    // opened this report to see. The character count does not depend on which
    // voice is chosen, so cost it with a sentinel and flag the pending lookup.
    // (The sentinel deliberately poisons the hash so a pending line can never
    // be mistaken for a cache hit. After the first live run the resolved voice
    // ids are cached and dry runs are exact again.)
    const pending = !cast?.voiceId;
    if (pending && !cfg.dryRun) {
      skipped.push({ ...line, why: 'no voice resolved for this cast' });
      continue;
    }
    if (!cast) { skipped.push({ ...line, why: `unknown cast "${line.cast}"` }); continue; }

    if (/\[[a-z ]{2,20}\]/i.test(line.text) && !/v3/.test(cfg.model)) {
      // v3 audio tags are spoken aloud verbatim by v2 models. Better to catch
      // it here than to ship a tourist who literally says "bracket whispering".
      out.warn(`line "${line.id}" contains a [bracket tag] but model ${cfg.model} is not a v3 model — it will be read out loud`);
    }
    if (line.text.length > LONG_LINE_CHARS) {
      out.warn(`line "${line.id}" is ${line.text.length} chars; barks should be one breath`);
    }

    const settings = settingsFor(cast);
    const src = sourceHashOf(line, cast.voiceId ?? '(voice-pending)', settings, cfg);

    // Choose the owning filename deterministically: first id (sorted) wins, so
    // the file that exists on disk does not depend on library iteration order.
    let file = byHash.get(src);
    if (!file) {
      // Two different ids can sanitise to one filename ("a/b" and "a.b" both
      // become "a-b"). Suffix the hash and register the RESOLVED name, or the
      // third collision quietly overwrites the second.
      let base = safeName(line.id);
      if (byFile.has(base)) base = `${base}-${src.slice(0, 6)}`;
      file = `${base}.mp3`;
      byHash.set(src, file);
      byFile.set(base, line.id);
    }

    const prev = cache.lines?.[line.id];
    const onDisk = existsSync(join(cfg.outDir, file));
    const fresh = !cfg.force && prev?.sourceHash === src && prev?.postHash === post && onDisk;

    const job = {
      id: line.id, cast: line.cast, category: line.category, text: line.text,
      voiceId: cast.voiceId, voiceName: cast.voiceName ?? null, settings, pending,
      sourceHash: src, postHash: post, file,
      // A raw download already present means the API call is free even if the
      // finished mp3 is gone or the mastering changed.
      rawCached: existsSync(join(cfg.cacheDir, 'raw', `${src}.mp3`)),
      chars: line.text.length,
      // Which library this came from, carried all the way to the manifest so a
      // reader can tell a phone call from a street bark without a lookup table.
      source: line.source ?? 'npc',
      mature: Boolean(line.mature),
    };

    if (fresh) cached.push(job); else jobs.push(job);
  }

  // Deduplicate work: several ids can share one source hash, and one API call
  // covers all of them. Extra ids become aliases onto the owning job.
  const unique = [];
  const aliasOf = new Map();
  for (const job of jobs.sort((a, b) => a.id.localeCompare(b.id))) {
    const owner = unique.find((u) => u.sourceHash === job.sourceHash);
    if (owner) { aliasOf.set(job.id, owner); job.aliasOf = owner.id; job.file = owner.file; }
    else unique.push(job);
  }

  // Apply --limit BEFORE costing the run, or the dry run quotes a price for
  // work it has already decided not to do — which is the one number the owner
  // is reading this output for.
  if (cfg.limit && unique.length > cfg.limit) {
    const dropped = unique.splice(cfg.limit);
    for (const d of dropped) skipped.push({ ...d, why: `over --limit ${cfg.limit}` });
  }

  // A job whose raw download is already cached is a re-master: real work, zero
  // characters. Only jobs that will actually hit the API are costed.
  const billable = unique.filter((j) => !j.rawCached || cfg.force);
  const chars = billable.reduce((n, j) => n + j.chars, 0);
  const rate = CREDIT_RATE[cfg.model] ?? 1;

  const byCast = {};
  const bySource = {};
  for (const j of billable) {
    byCast[j.cast] = (byCast[j.cast] ?? 0) + j.chars;
    const s = bySource[j.source] ?? (bySource[j.source] = { lines: 0, chars: 0 });
    s.lines++; s.chars += j.chars;
  }

  return {
    jobs: unique, aliases: [...aliasOf.entries()].map(([id, o]) => ({ id, ownerId: o.id, file: o.file })),
    cached, skipped, blocked, chars, credits: Math.round(chars * rate),
    byCast, bySource, postHash: post,
    matureCount: unique.filter((j) => j.mature).length,
  };
}

/* ================================================================ ffmpeg === */

const hasBin = (bin) => {
  try { return spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0; }
  catch { return false; }
};

/**
 * Trim dead air and match loudness.
 *
 * silenceremove only ever trims the START of a stream, so the trailing silence
 * is removed by reversing the audio, trimming its new start, and reversing back
 * — the standard ffmpeg idiom, verified against this filter chain before it was
 * written down. If ffmpeg is missing the raw file is copied through unchanged
 * and the manifest records normalised:false, because a slightly hot bark is a
 * far better outcome than a build that fails on a machine without ffmpeg.
 */
function master(rawPath, outPath, cfg) {
  if (cfg.noFfmpeg || !cfg.ffmpeg) {
    copyFileSync(rawPath, outPath);
    return { normalised: false };
  }
  const chain = [
    `silenceremove=start_periods=1:start_duration=0:start_silence=${MASTER.leadSilence}:start_threshold=${MASTER.threshold}:detection=peak`,
    'areverse',
    `silenceremove=start_periods=1:start_duration=0:start_silence=${MASTER.tailSilence}:start_threshold=${MASTER.threshold}:detection=peak`,
    'areverse',
    `loudnorm=I=${MASTER.lufs}:TP=${MASTER.truePeak}:LRA=${MASTER.lra}`,
  ].join(',');

  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', rawPath, '-af', chain,
    '-ar', String(MASTER.rate), '-ac', String(MASTER.channels), '-b:a', MASTER.bitrate,
    outPath,
  ], { encoding: 'utf8' });

  if (r.status !== 0 || !existsSync(outPath)) {
    out.warn(`ffmpeg failed for ${outPath}: ${redact(r.stderr || '').slice(0, 200)} — shipping the raw file`);
    copyFileSync(rawPath, outPath);
    return { normalised: false };
  }
  return { normalised: true };
}

/**
 * Clip length in ms. ffprobe when available; otherwise derive it from the
 * constant bitrate we just encoded at, which is accurate to a frame or two and
 * is flagged in the manifest as an estimate so nobody builds tight timing on it.
 */
function durationMs(path, cfg) {
  if (cfg.ffprobe) {
    const r = spawnSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path,
    ], { encoding: 'utf8' });
    const secs = Number(String(r.stdout ?? '').trim());
    if (Number.isFinite(secs) && secs > 0) return { ms: Math.round(secs * 1000), exact: true };
  }
  const bytes = statSync(path).size;
  const kbps = cfg.noFfmpeg || !cfg.ffmpeg
    ? (Number(String(cfg.format).split('_')[2]) || 128)
    : (Number(String(MASTER.bitrate).replace(/\D/g, '')) || 96);
  return { ms: Math.round((bytes * 8) / kbps), exact: false };
}

/* ============================================================ safe writes == */

function ensureDir(dir) { mkdirSync(dir, { recursive: true }); }

/**
 * The invariant that makes the manifest safe to commit to a CDN: nothing
 * leaves this process without being re-scanned. If redaction changes the bytes
 * we were about to write, a secret reached a data structure it should never
 * have reached, and the correct response is to die loudly rather than publish.
 */
function writeJsonSafe(path, obj) {
  const body = JSON.stringify(obj, null, 2);
  if (containsSecret(body)) {
    throw new Error(`refusing to write ${path}: payload contained a key or an auth header`);
  }
  writeFileSync(path, `${body}\n`);
}

/** Make the cache directory un-committable without editing the root .gitignore. */
function armCacheDir(cacheDir) {
  ensureDir(join(cacheDir, 'raw'));
  const ignore = join(cacheDir, '.gitignore');
  if (!existsSync(ignore)) {
    writeFileSync(ignore, '# written by tools/generate-voices.mjs\n'
      + '# "*" covers this file too, so the whole directory stays out of git.\n*\n');
  }
}

/* ============================================================ instructions = */

/**
 * Placeholders only — this function must never interpolate a real value, which
 * is why it takes no arguments and reads no environment.
 */
export function secretSetupInstructions() {
  return `
================================================================================
SUPPLYING THE ELEVENLABS KEY  (placeholders only — never paste a real key into
                               a file that git can see)
================================================================================

LOCAL — one shell session, no shell history, no file on disk
  The prompt form is the safe one: the key is never an argument, so it cannot
  appear in \`ps\`, in ~/.zsh_history, or in a screen recording of your terminal.

    zsh :  read -rs "ELEVENLABS_API_KEY?ElevenLabs key: " && export ELEVENLABS_API_KEY
    bash:  read -rsp 'ElevenLabs key: ' ELEVENLABS_API_KEY && export ELEVENLABS_API_KEY

  Then, in that same shell:

    node tools/generate-voices.mjs            # dry run, costs nothing
    node tools/generate-voices.mjs --go       # generate

  Rotating more than one key (the script rolls to the next slot on a quota
  error and reports the slot number, never the value):

    export ELEVENLABS_API_KEY='<key-one>,<key-two>'     # comma-separated, or
    export ELEVENLABS_API_KEY_2='<key-two>'             # separate variables
    export ELEVENLABS_API_KEY_3='<key-three>'

  If you keep keys in a local .env, note that THIS SCRIPT DOES NOT READ IT — by
  design, the key only ever arrives through the environment. Your shell can
  load it for you, and .env is already gitignored:

    set -a && source .env && set +a

RENDER — the deployed service
  The game server never needs this key: all generation happens offline and the
  browser only fetches finished mp3s. Set it only if you intend to run
  generation from a Render job or shell.

  Dashboard route (recommended):
    1. Render dashboard -> the "pit-io" service -> Environment
    2. Add Environment Variable
         Key:   ELEVENLABS_API_KEY
         Value: <paste-key-here>
    3. Save. Render restarts the service; the value is write-only afterwards.

  Blueprint route — add this to render.yaml under the existing envVars list.
  "sync: false" is the documented way to declare a secret that Render prompts
  for and stores, so the value is never committed:

      - key: ELEVENLABS_API_KEY
        sync: false

  Rotating on Render: add the new key, redeploy, confirm, then remove the old
  one. Never edit in place — a failed deploy with no old key is an outage.

IF A KEY IS EVER EXPOSED
  Revoke it first at elevenlabs.io -> Profile -> API Keys, then issue a new one.
  Scrubbing a commit is the second step, never the first: a key in a pushed
  commit is already public.
`.trimEnd();
}

/* ================================================================== main === */

async function main(argv) {
  const cfg = parseArgs(argv);
  out.json = cfg.json;
  // --schema and --json exist to be piped into jq. Anything conversational on
  // stdout makes the output unparseable, so the human header is suppressed and
  // only the payload is printed.
  out.quiet = cfg.quiet || cfg.schemaOnly;

  if (cfg.help) { console.log(HELP); return 0; }
  if (cfg.secretsOnly) { console.log(secretSetupInstructions()); return 0; }

  /**
   * The 404 guard. A relative --url-base is concatenated onto a manifest that
   * already lives in that directory, so `--url-base audio/voice` writes
   * `audio/voice/x.mp3`, which the loader resolves against
   * `/audio/voice/manifest.json` into `/audio/voice/audio/voice/x.mp3`. Every
   * file 404s and the game silently falls back to captions. Absolute paths and
   * full origins are fine; nothing else is.
   */
  if (cfg.urlBase && !/^(https?:\/\/|\/)/.test(cfg.urlBase)) {
    out.fail(`--url-base "${cfg.urlBase}" is relative. It would be joined onto a manifest that`);
    out.fail('already sits in that folder and every asset url would 404. Use "" (the default,');
    out.fail('a bare filename), a root-absolute path like /audio/voice, or a full https:// origin.');
    return 1;
  }

  cfg.ffmpeg = hasBin('ffmpeg');
  cfg.ffprobe = hasBin('ffprobe');

  out.say('');
  out.say('  miami devour — voice generation');
  out.say(`  mode: ${cfg.dryRun ? 'DRY RUN (nothing will be sent; pass --go to generate)' : 'LIVE — this run spends credits'}`);
  out.say('');

  /* --- 1. the line library ---------------------------------------------- */
  const lib = await loadVoiceLibrary(cfg.library);
  if (!lib.ok) {
    out.say(`  line library: NOT USABLE — ${lib.reason}`);
    out.say(`  looked at:    ${relative(ROOT, lib.path ?? cfg.library)}`);
    if (lib.exports) out.say(`  it exports:   ${lib.exports.join(', ') || '(nothing)'}`);
    out.say('');
    out.say('  This script expects the library to export a cast table and a line table:');
    out.say('');
    out.say('    export const CAST = {');
    out.say("      tourist: { name: 'Amused Tourist',");
    out.say("                 voiceDirection: 'cheerful woman, mid-30s, delighted rather than scared' },");
    out.say('    };');
    out.say('    export const LINES = [');
    out.say("      { id: 'tourist.notice.0', cast: 'tourist', category: 'notice',");
    out.say('        text: \'Uh... is that a sinkhole?\' },');
    out.say('    ];');
    out.say('');
    out.say('  A cast/category tree ({ tourist: { notice: [\'...\'] } }) is also accepted;');
    out.say('  ids are then derived from the path, so prefer explicit ids — reordering');
    out.say('  an array renames path-derived ids and invalidates their cache entries.');
    out.say('');
    if (cfg.json) console.log(JSON.stringify({ ok: false, reason: lib.reason, exports: lib.exports ?? [] }, null, 2));
    // Not a crash by default: the library is authored elsewhere and may simply
    // not exist yet. CI that cares can ask for --strict.
    return cfg.strict ? 1 : 0;
  }

  out.say(`  line library: ${lib.lines.length} lines across ${lib.casts.size} casts  (parsed as ${lib.shape})`);
  for (const r of lib.rejected ?? []) out.warn(`line "${r.id}" ignored — ${r.why}`);

  /* --- 1b. the phone's caller library ------------------------------------ */
  // Absent is normal. The NPC pass must not care, and it must SAY that it does
  // not care — "0 phone lines" printed nowhere is how a whole feature ships
  // silent.
  const phone = await loadPhoneLibrary(cfg.phoneLibrary);
  if (phone.ok) {
    out.say(`  phone lines:  ${phone.lines.length} lines across ${phone.casts.size} callers `
      + `(${relative(ROOT, phone.path)}, parsed as ${phone.shape})`);
    for (const r of phone.rejected ?? []) out.warn(`phone line "${r.id}" ignored — ${r.why}`);
    if (phone.synthesised?.length) {
      out.warn(`phone library exports no caller table; ${phone.synthesised.length} caller(s) `
        + `were inferred from the lines and have no voiceDirection: ${phone.synthesised.join(', ')}`);
    }
  } else {
    out.say(`  phone lines:  none — ${phone.reason}`);
    out.say(`                (${cfg.phoneLibrary || '--no-phone'}) — generating the NPC lines only.`);
  }

  const merged = mergeLibraries(lib, phone.ok ? phone : { casts: new Map(), lines: [] });
  for (const r of merged.renamed) {
    out.warn(`phone caller "${r.from}" collides with an NPC cast id; using "${r.to}" for voice assignment`);
  }
  for (const d of merged.dropped) out.fail(`phone line "${d.id}" DROPPED — ${d.why}`);

  for (const c of merged.casts.values()) {
    if (!c.voiceDirection) out.warn(`cast "${c.id}" has no voiceDirection; voice choice will be close to arbitrary`);
  }

  /* --- 1c. the libraries' own validators --------------------------------- */
  // voicelines.js says in its own header that "the generation pass in
  // particular must refuse to spend money on a corpus that does not pass".
  // It was never actually called from here. It is now.
  for (const [label, mod] of [['voicelines.js', lib.mod], ['callers.js', phone.mod]]) {
    if (!mod) continue;
    const fn = mod.validateLines ?? mod.__selftest ?? mod.selftest ?? null;
    if (typeof fn !== 'function') {
      out.warn(`${label} exports no validateLines()/__selftest(); only this tool's own policy gate applies to it`);
      continue;
    }
    let verdict;
    try { verdict = fn(); } catch (err) {
      // A validator that THROWS on violation is a valid contract too, and the
      // brief for the phone library asks for exactly that shape.
      out.fail(`${label} validator threw: ${redact(err?.message || err)}`);
      return 1;
    }
    if (verdict && verdict.ok === false) {
      out.fail(`${label} validator reported ${verdict.errors?.length ?? '?'} error(s):`);
      for (const e of (verdict.errors ?? []).slice(0, 12)) out.fail(`  ${e}`);
      return 1;
    }
    const warnings = verdict?.warnings ?? [];
    out.say(`  validator:    ${label} passed`
      + (warnings.length ? ` (${warnings.length} warning(s))` : ''));
    for (const w of warnings.slice(0, 6)) out.warn(`${label}: ${w}`);
  }

  /* --- 1d. the hard content gate ------------------------------------------ */
  // Runs over BOTH libraries, before any planning, and before any key is even
  // read. Costs nothing and makes no network call, so it can never be skipped
  // for being expensive.
  const policy = checkLibraryPolicy(merged.lines);
  if (!policy.ok) {
    out.say('');
    out.fail(`CONTENT POLICY: ${policy.violations.length} line(s) are not allowed at any setting.`);
    for (const v of policy.violations) out.fail(`  ${v.id} [${v.cast}] — ${v.why.join('; ')}`);
    out.say('');
    out.say('  These lines will NOT be generated. Rewrite them; do not widen the rules.');
    out.say('');
  } else {
    out.say(`  policy gate:  ${merged.lines.length} line(s) checked, none rejected`);
  }

  if (cfg.policyOnly) {
    if (cfg.json) {
      console.log(JSON.stringify({
        ok: policy.ok, checked: merged.lines.length, violations: policy.violations,
      }, null, 2));
    }
    return policy.ok ? 0 : 1;
  }

  if (cfg.schemaOnly) {
    const dump = {
      shape: lib.shape,
      phoneShape: phone.ok ? phone.shape : null,
      casts: [...merged.casts.values()].map((c) => ({
        id: c.id, source: c.source, name: c.name,
        voiceDirection: c.voiceDirection, voiceId: c.voiceId, voiceName: c.voiceName,
      })),
      lines: merged.lines,
      rejected: [...(lib.rejected ?? []), ...(phone.rejected ?? [])],
      dropped: merged.dropped,
      policy: policy.violations,
    };
    console.log(JSON.stringify(dump, null, 2));
    return 0;
  }

  /* --- 2. keys ----------------------------------------------------------- */
  const keyring = createKeyring(process.env);
  if (keyring.count) {
    out.say(`  api keys:     ${keyring.count} slot${keyring.count === 1 ? '' : 's'} `
      + `(${keyring.slots.map((s) => s.slot).join(', ')})`);
  } else {
    out.say('  api keys:     none in the environment');
  }

  if (!keyring.count && !cfg.dryRun) {
    // The normal state, not an error. Say what to do and leave quietly.
    out.say('');
    out.say('  Nothing was generated: there is no ELEVENLABS_API_KEY in the environment.');
    out.say('  Re-run without --go for a free dry run of exactly what would be sent.');
    console.log(secretSetupInstructions());
    return 0;
  }

  if (cfg.quotaOnly) {
    // Reports the slot that is currently live, not all of them: request() owns
    // the rotation cursor and only moves it on a failure, which is the correct
    // behaviour for generation and means "poll every slot" is not something
    // this keyring can express without leaking the selection logic outward.
    // Costs no characters — /v1/user/subscription is a metadata read.
    if (!keyring.count) { out.say('  no keys to query'); return 0; }
    const res = await keyring.request('/v1/user/subscription', { verbose: cfg.verbose });
    if (!res.ok) { out.fail(`quota query failed: ${res.error}`); return 1; }
    const s = res.json ?? {};
    const left = Number(s.character_limit ?? 0) - Number(s.character_count ?? 0);
    out.say(`  ${res.slot}: tier ${s.tier ?? '?'}  ${s.character_count ?? '?'} / ${s.character_limit ?? '?'} used`
      + `  (${Number.isFinite(left) ? left : '?'} characters left)`);
    return 0;
  }

  /* --- 3. cache + voices ------------------------------------------------- */
  const cachePath = join(cfg.cacheDir, 'index.json');
  let cache = { version: 1, lines: {}, voices: {} };
  if (existsSync(cachePath)) {
    try { cache = { ...cache, ...JSON.parse(readFileSync(cachePath, 'utf8')) }; }
    catch { out.warn('cache index unreadable — starting fresh (this may cost credits)'); }
  }

  const { unresolved } = await resolveVoices({ casts: merged.casts, keyring, cache, cfg, env: process.env });
  for (const id of unresolved) {
    out.warn(cfg.dryRun
      ? `cast "${id}" has no pinned voice — a live run would search for one`
      : `cast "${id}" could not be matched to a voice; set voiceId in the library or VOICE_ID_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`);
  }

  // Which voice each character ends up with is the single fact that is
  // impossible to recover after the fact from an mp3, so print the whole table.
  const assigned = [...merged.casts.values()].filter((c) => c.voiceId);
  if (assigned.length) {
    out.say('');
    out.say('  voice assignment');
    for (const c of assigned.sort((a, b) => String(a.source).localeCompare(String(b.source)) || a.id.localeCompare(b.id))) {
      out.say(`    ${String(c.source).padEnd(6)} ${c.id.padEnd(22)} ${String(c.voiceName ?? '(id only)').padEnd(12)} ${c.voiceSource}`);
    }
    // Distinctness is a promise this tool makes; measure it rather than assume.
    const ids = assigned.map((c) => c.voiceId);
    const dupes = ids.filter((v, i) => ids.indexOf(v) !== i);
    if (dupes.length) out.warn(`${new Set(dupes).size} voice(s) are shared by more than one character`);
  }

  /* --- 4. plan ----------------------------------------------------------- */
  const plan = planGeneration({ casts: merged.casts, lines: merged.lines, cache, cfg });

  out.say('');
  out.say(`  to generate:  ${plan.jobs.length}`
    + `   already current: ${plan.cached.length}`
    + `   aliased to an identical line: ${plan.aliases.length}`
    + (plan.skipped.length ? `   skipped: ${plan.skipped.length}` : '')
    + (plan.blocked.length ? `   BLOCKED BY POLICY: ${plan.blocked.length}` : ''));

  if (cfg.dryRun) {
    out.say('');
    // Every line is printed in full. This listing IS the review step: it is
    // the last point at which a line can be read by a human before it becomes
    // a paid-for asset that ships in the game.
    let pendingCount = 0;
    for (const j of plan.jobs) {
      if (j.pending) pendingCount++;
      const tag = j.rawCached ? 'remaster' : 'generate';
      out.say(`    ${tag.padEnd(9)} ${String(j.source).padEnd(6)} ${j.id.padEnd(38)} `
        + `${String(j.chars).padStart(3)} ch  ${j.cast}${j.mature ? ' [mature]' : ''}${j.pending ? ' *' : ''}`);
      out.say(`              "${j.text}"`);
    }
    // Skips are a diagnostic, not a review artefact — cap the wall of text.
    for (const s of plan.skipped.slice(0, 12)) out.say(`    skip      ${s.id.padEnd(38)} ${s.why}`);
    if (plan.skipped.length > 12) out.say(`    skip      ... and ${plan.skipped.length - 12} more`);
    // Policy rejections are NOT capped. Every one is a line somebody wrote that
    // is not going to exist, and the author has to be able to see all of them.
    for (const b of plan.blocked) out.fail(`blocked   ${b.id.padEnd(38)} ${b.why}`);

    out.say('');
    out.say('  estimated cost');
    for (const [src, s] of Object.entries(plan.bySource).sort((a, b) => b[1].chars - a[1].chars)) {
      out.say(`    ${`[${src}]`.padEnd(24)} ${String(s.chars).padStart(6)} characters over ${s.lines} line(s)`);
    }
    for (const [cast, n] of Object.entries(plan.byCast).sort((a, b) => b[1] - a[1])) {
      out.say(`    ${cast.padEnd(24)} ${String(n).padStart(6)} characters`);
    }
    out.say(`    ${'TOTAL'.padEnd(24)} ${String(plan.chars).padStart(6)} characters`
      + `  ~= ${plan.credits} credits on ${cfg.model}`);
    if (plan.matureCount) {
      out.say('');
      out.say(`  ${plan.matureCount} of these are flagged MATURE. They are still gated in game by the`);
      out.say('  player\'s Mature Dialogue setting, which is off by default. --no-mature keeps');
      out.say('  them out of the build entirely.');
    }
    if (pendingCount) {
      out.say('');
      out.say(`  * ${pendingCount} line(s) belong to a cast whose voice is not resolved YET. A dry run`);
      out.say('    makes no network call, and resolving a voice needs one — so this says nothing');
      out.say('    about whether a voice is pinned. A live run resolves each cast once and caches');
      out.say('    it; the character count above does not depend on the outcome, so the estimate');
      out.say('    holds either way.');
      out.say('    To pin a voice: voiceName on the cast entry (a stock voice name, resolved for');
      out.say('    0 characters), or voiceId, or export VOICE_ID_<CAST_ID_IN_CAPS_WITH_UNDERSCORES>.');
      out.say(`    The ${Object.keys(VOICE_NAME_BY_CAST).length} NPC casts are already pinned by name in this tool, so they will`);
      out.say('    resolve to the same voices they shipped with.');
    }
    out.say('');
    out.say('  Read the lines above before spending anything. Then:  --go');
    out.say('');
    if (cfg.json) {
      console.log(JSON.stringify({
        ok: plan.blocked.length === 0, dryRun: true, model: cfg.model, format: cfg.format,
        phoneLibrary: phone.ok ? relative(ROOT, phone.path) : null,
        phoneLines: phone.ok ? phone.lines.length : 0,
        toGenerate: plan.jobs.map((j) => ({
          id: j.id, cast: j.cast, source: j.source, chars: j.chars,
          remaster: j.rawCached, mature: j.mature,
        })),
        cached: plan.cached.length, aliases: plan.aliases.length,
        skipped: plan.skipped.map((s) => ({ id: s.id, why: s.why })),
        blocked: plan.blocked.map((b) => ({ id: b.id, why: b.why })),
        characters: plan.chars, estimatedCredits: plan.credits, bySource: plan.bySource,
        mature: plan.matureCount,
        ffmpeg: cfg.ffmpeg, keySlots: keyring.slots.map((s) => s.slot),
      }, null, 2));
    }
    // A dry run that found forbidden content is not a success, even though it
    // spent nothing: CI has to be able to fail on it.
    return plan.blocked.length ? 1 : 0;
  }

  /* A live run refuses outright. There is no --force past this. */
  if (plan.blocked.length) {
    out.fail(`refusing to generate: ${plan.blocked.length} line(s) failed the content policy.`);
    for (const b of plan.blocked) out.fail(`  ${b.id} — ${b.why}`);
    return 1;
  }

  /* --- 5. generate -------------------------------------------------------- */
  if (!cfg.ffmpeg) out.warn('ffmpeg not found — clips ship untrimmed and unnormalised (manifest records normalised:false)');

  ensureDir(cfg.outDir);
  armCacheDir(cfg.cacheDir);

  const results = new Map();
  const failures = [];
  let cursor = 0;

  const worker = async () => {
    while (cursor < plan.jobs.length) {
      const job = plan.jobs[cursor++];
      const rawPath = join(cfg.cacheDir, 'raw', `${job.sourceHash}.mp3`);
      const outPath = join(cfg.outDir, job.file);

      if (!existsSync(rawPath) || cfg.force) {
        const res = await keyring.request(
          `/v1/text-to-speech/${encodeURIComponent(job.voiceId)}?output_format=${encodeURIComponent(cfg.format)}`,
          {
            method: 'POST',
            accept: 'audio/mpeg',
            verbose: cfg.verbose,
            body: {
              text: job.text,
              model_id: cfg.model,
              voice_settings: job.settings,
              // A stable seed derived from the content hash means a cache wipe
              // regenerates audio that matches what shipped, instead of a
              // subtly different read of every line in the game.
              seed: parseInt(job.sourceHash.slice(0, 8), 16) % 4294967295,
              apply_text_normalization: 'auto',
            },
          },
        );

        if (!res.ok || !res.buf?.length) {
          out.fail(`${job.id}: ${res.error ?? 'empty response'}${res.detail ? ` — ${res.detail}` : ''}`);
          failures.push({ id: job.id, error: res.error ?? 'empty response' });
          if (/all key slots retired/.test(String(res.error))) { cursor = plan.jobs.length; }
          continue;
        }

        // Write to a temp name and rename: a half-written raw file that the
        // next run treats as a cache hit is a silently truncated bark.
        const tmp = `${rawPath}.part`;
        writeFileSync(tmp, res.buf);
        renameSync(tmp, rawPath);
        keyring.creditsUsed(job.chars);
      }

      const { normalised } = master(rawPath, outPath, cfg);
      const dur = durationMs(outPath, cfg);
      results.set(job.id, {
        file: job.file, ms: dur.ms, exact: dur.exact, cast: job.cast, normalised,
        voice: job.voiceName ?? null, source: job.source, mature: job.mature,
      });
      cache.lines[job.id] = {
        sourceHash: job.sourceHash, postHash: job.postHash, file: job.file,
        ms: dur.ms, cast: job.cast, model: cfg.model, voiceId: job.voiceId,
        voice: job.voiceName ?? null, source: job.source, mature: job.mature,
        generated: new Date().toISOString(),
      };
      out.say(`    ok  ${job.id.padEnd(34)} ${String(dur.ms).padStart(5)} ms  ${job.cast}`);
    }
  };

  await Promise.all(Array.from({ length: cfg.concurrency }, worker));

  /* --- 6. manifest --------------------------------------------------------- */
  /**
   * Everything current on disk goes in, not just this run's output: the
   * manifest DESCRIBES THE FOLDER, and a partial run must not orphan clips a
   * previous run paid for.
   *
   * THE URL RULE. `url` is a BARE FILENAME. src/audio/voice.js resolves a
   * relative asset url against the manifest's own url, so `x.mp3` next to
   * `/audio/voice/manifest.json` is `/audio/voice/x.mp3`, and the pack survives
   * being moved to a hashed directory. Writing `audio/voice/x.mp3` here once
   * produced `/audio/voice/audio/voice/x.mp3`: the manifest loaded, every asset
   * 404'd, and the game reported "no voice pack" rather than a broken path.
   * --url-base is kept for a CDN (absolute urls are taken verbatim) and is
   * refused if it is relative.
   */
  const manifestLines = {};
  const addEntry = (id, file, ms, cast, extra = {}) => {
    manifestLines[id] = {
      url: cfg.urlBase ? `${cfg.urlBase.replace(/\/+$/, '')}/${file}` : file,
      ms, cast, ...extra,
    };
  };

  /**
   * Carry forward whatever the previous manifest described that is still on
   * disk. Without this a run that touches one line rewrites the manifest with
   * only that line in it — and the other 111 mp3s, already committed and
   * already paid for, become unreachable while sitting right there in the
   * folder. Anything this run knows about overwrites these below.
   */
  const priorPath = join(cfg.outDir, 'manifest.json');
  let carried = 0;
  if (existsSync(priorPath)) {
    try {
      const prior = JSON.parse(readFileSync(priorPath, 'utf8'));
      const table = prior.assets || prior.lines || prior.entries || {};
      for (const [id, v] of Object.entries(table)) {
        const f = typeof v === 'string' ? v : v?.url;
        if (!f || /^(https?:|data:|blob:|\/)/.test(f)) continue;   // absolute: not ours to vouch for
        const base = String(f).split('/').pop();
        if (!existsSync(join(cfg.outDir, base))) continue;
        addEntry(id, base, v?.ms ?? 0, v?.cast ?? '', {
          ...(v?.voice ? { voice: v.voice } : {}),
          ...(v?.source ? { source: v.source } : {}),
        });
        carried++;
      }
    } catch { out.warn('previous manifest.json unreadable — it will be replaced, not merged'); }
  }

  for (const j of plan.cached) {
    const c = cache.lines[j.id];
    if (c && existsSync(join(cfg.outDir, c.file))) {
      addEntry(j.id, c.file, c.ms, c.cast, {
        ...(c.voice ? { voice: c.voice } : {}),
        source: c.source ?? j.source ?? 'npc',
        ...(c.mature ? { mature: true } : {}),
      });
    }
  }
  for (const [id, r] of results) {
    addEntry(id, r.file, r.ms, r.cast, {
      ...(r.voice ? { voice: r.voice } : {}),
      source: r.source, ...(r.mature ? { mature: true } : {}),
    });
  }
  for (const a of plan.aliases) {
    const owner = results.get(a.ownerId) ?? cache.lines[a.ownerId];
    if (owner && existsSync(join(cfg.outDir, a.file))) {
      addEntry(a.id, a.file, owner.ms, owner.cast, {
        ...(owner.voice ? { voice: owner.voice } : {}),
        source: owner.source ?? 'npc',
      });
      cache.lines[a.id] = { ...cache.lines[a.ownerId], file: a.file };
    }
  }

  const manifest = {
    version: 1,
    generated: new Date().toISOString(),
    pipeline: {
      model: cfg.model,
      format: cfg.format,
      normalised: cfg.ffmpeg && !cfg.noFfmpeg,
      loudness: `I=${MASTER.lufs} TP=${MASTER.truePeak} LRA=${MASTER.lra}`,
      channels: MASTER.channels,
      msExact: cfg.ffprobe,
    },
    counts: {
      lines: Object.keys(manifestLines).length,
      generated: results.size,
      reused: plan.cached.length,
      aliased: plan.aliases.length,
      carried,
      phone: Object.values(manifestLines).filter((l) => l.source === 'phone').length,
      failed: failures.length,
    },
    /* `assets` and `lines` are THE SAME OBJECT, written twice.
       src/audio/voice.js reads `json.assets || json.entries || json.lines`, and
       the pack currently deployed uses `assets` while that file's own doc
       comment describes `lines`. Emitting one key and not the other has already
       cost this project a release where the loader registered zero assets and
       reported a successful load. They cannot drift: there is one object. */
    assets: manifestLines,
    lines: manifestLines,
  };

  writeJsonSafe(join(cfg.outDir, 'manifest.json'), manifest);
  writeJsonSafe(cachePath, cache);

  /* --- 7. prune ------------------------------------------------------------ */
  if (cfg.prune) {
    // Moved, never unlinked. A regenerated library plus a typo'd --only should
    // not be able to destroy audio that cost real money.
    const keep = new Set(Object.values(manifestLines).map((l) => l.url.split('/').pop()));
    keep.add('manifest.json');
    const orphanDir = join(cfg.cacheDir, 'orphans');
    let moved = 0;
    for (const f of readdirSync(cfg.outDir)) {
      if (keep.has(f) || f.startsWith('.')) continue;
      ensureDir(orphanDir);
      renameSync(join(cfg.outDir, f), join(orphanDir, f));
      moved++;
    }
    if (moved) out.say(`  pruned:       ${moved} orphaned file(s) moved to ${relative(ROOT, orphanDir)}`);
  }

  /* --- 8. report ----------------------------------------------------------- */
  out.say('');
  out.say(`  manifest:     ${relative(ROOT, join(cfg.outDir, 'manifest.json'))}  (${manifest.counts.lines} lines`
    + `, ${manifest.counts.phone} of them phone`
    + (carried ? `, ${carried} carried forward from the previous manifest` : '') + ')');
  out.say(`  generated:    ${results.size}    reused: ${plan.cached.length}    failed: ${failures.length}`);
  for (const s of keyring.slots) {
    out.say(`  ${s.slot}: ${s.calls} call(s), ~${s.chars} characters, ${s.state}${s.note ? ` (${s.note})` : ''}`);
  }
  if (failures.length) {
    out.say('');
    for (const f of failures) out.fail(`${f.id}: ${f.error}`);
  }

  if (cfg.json) {
    console.log(JSON.stringify({
      ok: failures.length === 0,
      dryRun: false,
      manifest: relative(ROOT, join(cfg.outDir, 'manifest.json')),
      counts: manifest.counts,
      // Slot metadata only. There is no code path that puts a key in here.
      keySlots: keyring.slots,
      failures,
    }, null, 2));
  }

  console.log(secretSetupInstructions());
  return failures.length ? 1 : 0;
}

/* ============================================================ entry point == */

// Only run when invoked directly, so the exported functions can be imported by
// a test harness without the CLI firing.
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}

export {
  main, parseArgs, redact, createKeyring, master, durationMs, POST_VERSION, MASTER,
  PHONE_LIBRARY, VOICE_NAME_BY_CAST,
};
