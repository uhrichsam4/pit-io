#!/usr/bin/env node
/**
 * MIAMI DEVOUR — OFFLINE NPC VOICE GENERATION (ElevenLabs).
 *
 * This script turns src/audio/voicelines.js into a folder of small, loudness-
 * matched mp3 barks plus a manifest the game loads by id. It runs on a laptop
 * or in CI. It must NEVER run at gameplay time and the game must never see the
 * API key — the browser only ever fetches finished audio by URL.
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
 *   public/audio/voice/manifest.json id -> { url, ms, cast }
 *   .voice-cache/raw/<hash>.mp3      the untouched API response
 *   .voice-cache/index.json          content-hash cache + resolved voice ids
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
    voicePool: String(val('voice-pool', 'default')),
    urlBase: String(val('url-base', '/audio/voice')),
  };
}

const HELP = `
miami devour — offline voice generation

  node tools/generate-voices.mjs [flags]

  (no flags)         DRY RUN. Lists every line that would be generated and the
                     estimated character cost. Makes zero network calls.
  --go               Actually call ElevenLabs and write audio. Spends credits.

  --only a,b         Only lines whose id, cast or category starts with a or b.
  --limit N          Generate at most N clips this run (quota airbag).
  --force            Ignore the content cache and regenerate.
  --prune            Move orphaned mp3s to .voice-cache/orphans/ (never deletes).

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
 * @returns {Promise<{ok:boolean, reason?:string, exports?:string[],
 *                     casts:Map<string,object>, lines:object[], shape:string}>}
 */
export async function loadVoiceLibrary(libraryPath = 'src/audio/voicelines.js') {
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

  const castSrc = pick('CAST', 'VOICE_CAST', 'CASTS', 'VOICE_CASTS', 'cast', 'casts', 'voices', 'VOICES');
  const lineSrc = pick('LINES', 'VOICE_LINES', 'lines', 'voiceLines', 'LINE_LIBRARY', 'library');

  if (!castSrc || !lineSrc) {
    return {
      ok: false,
      reason: `could not find ${!castSrc ? 'a cast table' : ''}${!castSrc && !lineSrc ? ' or ' : ''}${!lineSrc ? 'a line table' : ''}`,
      exports: exportNames, path: abs, casts: new Map(), lines: [], shape: 'unrecognised',
    };
  }

  /* --- casts ------------------------------------------------------------- */
  const casts = new Map();
  const castEntries = Array.isArray(castSrc.value)
    ? castSrc.value.map((c) => [c?.id ?? c?.key ?? c?.name, c])
    : Object.entries(castSrc.value);

  for (const [rawId, def] of castEntries) {
    const id = String(rawId ?? '').trim();
    if (!id || !def || typeof def !== 'object') continue;
    casts.set(id, {
      id,
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

  const lines = [];
  const rejected = [];
  const seen = new Set();

  for (const raw of found) {
    const path = raw.path ?? [];
    const castFromPath = path.find((seg) => casts.has(seg)) ?? null;
    const cast = String(raw.cast ?? raw.castId ?? raw.voice ?? raw.speaker ?? castFromPath ?? '').trim();
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

    lines.push({ id, cast, category, text });
  }

  const shape = `${castSrc.key} + ${lineSrc.key}`;
  if (!lines.length) {
    return {
      ok: false,
      reason: `parsed "${shape}" but extracted 0 usable lines`,
      exports: exportNames, rejected, path: abs, casts, lines: [], shape,
    };
  }

  return { ok: true, casts, lines, rejected, shape, exports: exportNames, path: abs };
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
 * Resolve every cast to a concrete voice_id.
 *
 * Order of precedence, most explicit first:
 *   1. cast.voiceId in the library      — deterministic, zero API calls
 *   2. env VOICE_ID_<CAST>              — pin a voice without editing source
 *   3. the resolved-voice cache          — the search runs once, ever
 *   4. GET /v2/voices?search=<direction> — scored, deterministic tie-break
 *
 * There is deliberately NO step 5. If resolution fails the cast is SKIPPED with
 * a specific instruction, because the alternative — falling back to some
 * hardcoded voice id — would silently give the elderly park visitor whatever
 * voice happened to be first, and nobody would notice until playtest.
 *
 * Casts are also kept distinct: a voice already claimed by an earlier cast is
 * passed over while any alternative remains. Six NPCs sharing one voice is the
 * failure this cast list exists to avoid.
 */
async function resolveVoices({ casts, keyring, cache, cfg, env }) {
  const taken = new Set();
  const unresolved = [];

  for (const cast of casts.values()) {
    if (cast.voiceId) { cast.voiceSource = 'library'; taken.add(cast.voiceId); continue; }

    const envKey = `VOICE_ID_${cast.id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
    if (env[envKey]) {
      cast.voiceId = String(env[envKey]).trim();
      cast.voiceSource = `env ${envKey}`;
      taken.add(cast.voiceId);
      continue;
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

    const chosen = scored.find((s) => !taken.has(s.v.voice_id)) ?? scored[0];
    if (!chosen) { unresolved.push(cast.id); continue; }

    cast.voiceId = chosen.v.voice_id;
    cast.voiceName = chosen.v.name;
    cast.voiceSource = `search (score ${chosen.score})`;
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
  const byHash = new Map();
  const byFile = new Map();

  const match = (line) => !cfg.only.length || cfg.only.some((f) =>
    line.id.startsWith(f) || line.cast === f || line.category === f);

  for (const line of lines) {
    if (!match(line)) continue;
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
  for (const j of billable) byCast[j.cast] = (byCast[j.cast] ?? 0) + j.chars;

  return {
    jobs: unique, aliases: [...aliasOf.entries()].map(([id, o]) => ({ id, ownerId: o.id, file: o.file })),
    cached, skipped, chars, credits: Math.round(chars * rate), byCast, postHash: post,
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
  for (const c of lib.casts.values()) {
    if (!c.voiceDirection) out.warn(`cast "${c.id}" has no voiceDirection; voice choice will be close to arbitrary`);
  }

  if (cfg.schemaOnly) {
    const dump = {
      shape: lib.shape,
      casts: [...lib.casts.values()].map((c) => ({ id: c.id, name: c.name, voiceDirection: c.voiceDirection, voiceId: c.voiceId })),
      lines: lib.lines,
      rejected: lib.rejected,
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

  const { unresolved } = await resolveVoices({ casts: lib.casts, keyring, cache, cfg, env: process.env });
  for (const id of unresolved) {
    out.warn(cfg.dryRun
      ? `cast "${id}" has no pinned voice — a live run would search for one`
      : `cast "${id}" could not be matched to a voice; set voiceId in the library or VOICE_ID_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`);
  }

  /* --- 4. plan ----------------------------------------------------------- */
  const plan = planGeneration({ casts: lib.casts, lines: lib.lines, cache, cfg });

  out.say('');
  out.say(`  to generate:  ${plan.jobs.length}`
    + `   already current: ${plan.cached.length}`
    + `   aliased to an identical line: ${plan.aliases.length}`
    + (plan.skipped.length ? `   skipped: ${plan.skipped.length}` : ''));

  if (cfg.dryRun) {
    out.say('');
    // Every line is printed in full. This listing IS the review step: it is
    // the last point at which a line can be read by a human before it becomes
    // a paid-for asset that ships in the game.
    let pendingCount = 0;
    for (const j of plan.jobs) {
      if (j.pending) pendingCount++;
      const tag = j.rawCached ? 'remaster' : 'generate';
      out.say(`    ${tag.padEnd(9)} ${j.id.padEnd(38)} ${String(j.chars).padStart(3)} ch  ${j.cast}${j.pending ? ' *' : ''}`);
      out.say(`              "${j.text}"`);
    }
    // Skips are a diagnostic, not a review artefact — cap the wall of text.
    for (const s of plan.skipped.slice(0, 12)) out.say(`    skip      ${s.id.padEnd(38)} ${s.why}`);
    if (plan.skipped.length > 12) out.say(`    skip      ... and ${plan.skipped.length - 12} more`);

    out.say('');
    out.say('  estimated cost');
    for (const [cast, n] of Object.entries(plan.byCast).sort((a, b) => b[1] - a[1])) {
      out.say(`    ${cast.padEnd(24)} ${String(n).padStart(6)} characters`);
    }
    out.say(`    ${'TOTAL'.padEnd(24)} ${String(plan.chars).padStart(6)} characters`
      + `  ~= ${plan.credits} credits on ${cfg.model}`);
    if (pendingCount) {
      out.say('');
      out.say(`  * ${pendingCount} line(s) belong to a cast with no voice pinned yet. A live run will`);
      out.say('    search the ElevenLabs voice library once per cast and cache the choice.');
      out.say('    Voice choice does not change the character count above, so the estimate holds.');
      out.say('    To pin a voice instead of searching, set voiceId on the cast entry, or export');
      out.say('    VOICE_ID_<CAST_ID_IN_CAPS_WITH_UNDERSCORES>.');
    }
    out.say('');
    out.say('  Read the lines above before spending anything. Then:  --go');
    out.say('');
    if (cfg.json) {
      console.log(JSON.stringify({
        ok: true, dryRun: true, model: cfg.model, format: cfg.format,
        toGenerate: plan.jobs.map((j) => ({ id: j.id, cast: j.cast, chars: j.chars, remaster: j.rawCached })),
        cached: plan.cached.length, aliases: plan.aliases.length,
        skipped: plan.skipped.map((s) => ({ id: s.id, why: s.why })),
        characters: plan.chars, estimatedCredits: plan.credits,
        ffmpeg: cfg.ffmpeg, keySlots: keyring.slots.map((s) => s.slot),
      }, null, 2));
    }
    return 0;
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
      results.set(job.id, { file: job.file, ms: dur.ms, exact: dur.exact, cast: job.cast, normalised });
      cache.lines[job.id] = {
        sourceHash: job.sourceHash, postHash: job.postHash, file: job.file,
        ms: dur.ms, cast: job.cast, model: cfg.model, voiceId: job.voiceId,
        generated: new Date().toISOString(),
      };
      out.say(`    ok  ${job.id.padEnd(34)} ${String(dur.ms).padStart(5)} ms  ${job.cast}`);
    }
  };

  await Promise.all(Array.from({ length: cfg.concurrency }, worker));

  /* --- 6. manifest --------------------------------------------------------- */
  // Everything current on disk goes in, not just this run's output: the
  // manifest describes the folder, and a partial run must not orphan the
  // clips a previous run paid for.
  const manifestLines = {};
  const addEntry = (id, file, ms, cast) => {
    manifestLines[id] = { url: `${cfg.urlBase}/${file}`, ms, cast };
  };

  for (const j of plan.cached) {
    const c = cache.lines[j.id];
    if (c && existsSync(join(cfg.outDir, c.file))) addEntry(j.id, c.file, c.ms, c.cast);
  }
  for (const [id, r] of results) addEntry(id, r.file, r.ms, r.cast);
  for (const a of plan.aliases) {
    const owner = results.get(a.ownerId) ?? cache.lines[a.ownerId];
    if (owner && existsSync(join(cfg.outDir, a.file))) {
      addEntry(a.id, a.file, owner.ms, owner.cast);
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
      failed: failures.length,
    },
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
  out.say(`  manifest:     ${relative(ROOT, join(cfg.outDir, 'manifest.json'))}  (${manifest.counts.lines} lines)`);
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

export { main, parseArgs, redact, createKeyring, master, durationMs, POST_VERSION, MASTER };
