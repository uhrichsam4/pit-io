#!/usr/bin/env node
/**
 * Secret audit. Fails the build if a credential has escaped into anywhere it
 * can be read by someone who is not the owner.
 *
 * WHY THIS EXISTS. A key file was dropped into the repo root named
 * "11 labs api keys for claude.env.txt". It matched none of the gitignore
 * patterns at the time — `.env.*` only matches names that START with .env, and
 * Finder hides the trailing .txt, so it did not even look like a text file.
 * It sat untracked-but-not-ignored, which is the genuinely dangerous state:
 * invisible in the editor, and swept up by the next `git add -A`.
 *
 * Nobody catches that reliably by eye, so it is a script. Run it before any
 * deploy, and in CI if there ever is one:
 *
 *   npm run audit:secrets
 *
 * It never prints a secret it finds — only where it found one.
 */

import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

/**
 * Credential shapes worth failing over. Deliberately narrow: a pattern that
 * also matches ordinary hex blobs produces noise, and an audit people ignore
 * is worse than no audit.
 */
const PATTERNS = [
  { name: 'ElevenLabs key', re: /\bsk_[A-Za-z0-9]{40,}\b/ },
  { name: 'OpenAI key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { name: 'GitHub PAT', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Slack token', re: /\bxox[abposr]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

/** Directories never worth walking. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'shots', '.vite']);
/** Binary-ish extensions that would only produce false positives. */
const SKIP_EXT = /\.(png|jpe?g|gif|webp|mp3|wav|ogg|mp4|mov|zip|woff2?|ttf|ico|pdf)$/i;

const findings = [];
const note = (where, what, detail) => findings.push({ where, what, detail });

function walk(dir, onFile) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue;
    const full = join(dir, e);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, onFile);
    else if (!SKIP_EXT.test(e) && st.size < 8 * 1024 * 1024) onFile(full);
  }
}

function scanText(text, label) {
  for (const p of PATTERNS) {
    if (p.re.test(text)) note(label, p.name, null);
  }
}

/* --- 1. Tracked files. The only ones that can reach a remote. ------------ */
let tracked = [];
try {
  tracked = execSync('git ls-files -z', { cwd: ROOT, maxBuffer: 64 << 20 })
    .toString().split('\0').filter(Boolean);
} catch { /* not a git repo; the filesystem sweep below still runs */ }

for (const f of tracked) {
  if (SKIP_EXT.test(f)) continue;
  const full = join(ROOT, f);
  if (!existsSync(full)) continue;
  try { scanText(readFileSync(full, 'utf8'), `tracked: ${f}`); } catch { /* binary */ }
}

/* --- 2. Git history. A key removed from HEAD is still in the objects. ---- */
try {
  const hist = execSync('git log --all -p --no-color', { cwd: ROOT, maxBuffer: 512 << 20 }).toString();
  for (const p of PATTERNS) {
    if (p.re.test(hist)) note('git history', p.name, 'present in a past commit — rotate the key, history rewrite alone is not enough');
  }
} catch { /* history too large or no repo; not fatal */ }

/* --- 3. The built bundle. What actually ships to a browser. -------------- */
if (existsSync(join(ROOT, 'dist'))) {
  walk(join(ROOT, 'dist'), (f) => {
    try { scanText(readFileSync(f, 'utf8'), `bundle: ${relative(ROOT, f)}`); } catch { /* binary */ }
  });
}

/* --- 4. Untracked-but-not-ignored. The state that bit us. ---------------- */
try {
  const loose = execSync('git ls-files --others --exclude-standard -z', { cwd: ROOT, maxBuffer: 64 << 20 })
    .toString().split('\0').filter(Boolean);
  for (const f of loose) {
    if (SKIP_EXT.test(f)) continue;
    let text = '';
    try { text = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
    for (const p of PATTERNS) {
      if (p.re.test(text)) {
        note(`UNIGNORED: ${f}`, p.name,
          'not committed yet, but not ignored either — the next `git add -A` would commit it');
      }
    }
  }
} catch { /* ignore */ }

/* --- 5. Source must read secrets from the environment, never inline. ----- */
for (const dir of ['src', 'server', 'tools']) {
  const d = join(ROOT, dir);
  if (!existsSync(d)) continue;
  walk(d, (f) => {
    let text = '';
    try { text = readFileSync(f, 'utf8'); } catch { return; }
    scanText(text, `source: ${relative(ROOT, f)}`);
  });
}

/* --- 6. Anything VITE_-prefixed holding a secret IS shipped to the client. */
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*(VITE_[A-Z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    for (const p of PATTERNS) {
      if (p.re.test(m[2])) {
        note(`.env: ${m[1]}`, p.name,
          'VITE_-prefixed variables are INLINED INTO THE BROWSER BUNDLE — rename it without the VITE_ prefix');
      }
    }
  }
}

/* ------------------------------------------------------------------------ */
if (!findings.length) {
  console.log('audit-secrets: clean');
  console.log('  · no credential in any tracked file');
  console.log('  · no credential anywhere in git history');
  console.log('  · no credential in the built bundle');
  console.log('  · no unignored loose file holding a credential');
  console.log('  · no VITE_-prefixed secret (those would ship to the browser)');
  process.exit(0);
}

console.error(`\naudit-secrets: ${findings.length} problem(s). Values are never printed.\n`);
for (const f of findings) {
  console.error(`  ✗ ${f.what}`);
  console.error(`    at ${f.where}`);
  if (f.detail) console.error(`    ${f.detail}`);
}
console.error('\nRotate anything that reached git history or a bundle — removing it now does not un-leak it.\n');
process.exit(1);
