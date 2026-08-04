#!/usr/bin/env node
/**
 * Acceptance test for the META LAYER — lobby, matchmaking, modes, leaderboards,
 * store, progression, settings.
 *
 * This is the gate the whole meta-layer wave is judged against. It does not
 * screenshot and eyeball; it MEASURES, because the failures that matter here
 * are the ones a screenshot flatters: a 31px tap target, a row that overflows
 * 8px to the right, a timer left running after unmount, a purchase that did not
 * persist.
 *
 *   node tools/meta-test.mjs                        # full run, phone + desktop
 *   node tools/meta-test.mjs --out shots/meta       # keep the screenshots
 *   node tools/meta-test.mjs --no-match             # skip the match leg (fast)
 *   node tools/meta-test.mjs --json
 *
 * Exit code is the number of BLOCKERS (capped at 250), so CI and agents can
 * branch on it. Majors and minors are reported but do not fail the run.
 *
 * NAVIGATION. It prefers clicking the real lobby tiles, because that also
 * proves they are wired; it falls back to the shell router only when no tile
 * for a screen exists. A screen reachable by shell.go() but not by any tile is
 * itself reported — an unreachable screen is a screen the player does not have.
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const has = (n) => argv.includes(`--${n}`);

const PORT = Number(flag('port', 5173));
const OUT = resolve(String(flag('out', 'shots/meta')));
const AS_JSON = has('json');
const DO_MATCH = !has('no-match');
const TAP_MIN = 44;

/** Every screen the meta layer promises, and how the player is meant to reach it. */
const SCREENS = [
  { name: 'lobby', via: null, must: ['play'] },
  { name: 'play', via: /public match|play with friends|friends/i, must: [] },
  { name: 'modes', via: /game modes|modes/i, must: [] },
  { name: 'leaderboard', via: /leaderboard/i, must: [] },
  { name: 'store', via: /store/i, must: [] },
  { name: 'profile', via: /profile/i, must: [] },
  { name: 'rewards', via: /daily|challenge|reward|streak/i, must: [] },
  { name: 'settings', via: /settings/i, must: [] },
];

const VIEWPORTS = [
  { id: 'phone', w: 390, h: 844 },      // iPhone 14/15 portrait
  { id: 'small', w: 360, h: 640 },      // the small-Android floor
  { id: 'land', w: 844, h: 390 },       // phone on its side
  { id: 'desktop', w: 1440, h: 900 },
];

mkdirSync(OUT, { recursive: true });
const log = (...a) => { if (!AS_JSON) console.log(...a); };

const findings = [];
const add = (severity, screen, what, evidence = '') =>
  findings.push({ severity, screen, what, evidence: String(evidence).slice(0, 400) });

/* ------------------------------------------------------------------ boot --- */

const browser = await chromium.launch({
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--disable-dev-shm-usage',
  ],
});
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  hasTouch: true,
  isMobile: true,
});
page.setDefaultTimeout(180000);

const consoleErrors = [];
const pageErrors = [];
const badRequests = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e && e.stack ? e.stack : e)));
page.on('response', (r) => {
  if (r.status() >= 400 && new URL(r.url()).port === String(PORT)) {
    badRequests.push(`${r.status()} ${r.url()}`);
  }
});

log(`▸ booting http://localhost:${PORT}/ …`);
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('!!window.DEV', null, { timeout: 300000 });
log('  city built');

/**
 * Survive Vite's full-reload. Agents are saving files while this runs, and a
 * reload mid-test wipes window.DEV — which reads exactly like a code bug in
 * whatever was last touched. Replay the step instead of chasing the ghost.
 */
async function resilient(fn, what, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      await page.waitForFunction('!!window.DEV', null, { timeout: 300000 });
      return await fn();
    } catch (e) {
      const msg = String(e && e.message);
      const transient = /window\.DEV|undefined|Execution context was destroyed|Target closed|Timeout/.test(msg);
      if (!transient || i === tries - 1) throw e;
      log(`  … ${what} interrupted; retrying (${i + 1}/${tries - 1})`);
      await page.waitForTimeout(800 + i * 700);
    }
  }
}

/* ------------------------------------------------- is the shell even here --- */

const shellInfo = await page.evaluate(() => {
  const g = window.__GAME__;
  const shell = window.__SHELL__ || (g && g.shell) || (window.DEV && window.DEV.shell) || null;
  return {
    hasShellEl: !!document.querySelector('.shell'),
    hasShellObj: !!shell,
    screens: shell && shell.screens ? [...shell.screens.keys()] : [],
    tokensLoaded: [...document.styleSheets].some((s) => (s.href || '').includes('tokens.css')),
    cssHrefs: [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.getAttribute('href')),
  };
});

if (!shellInfo.hasShellEl) {
  add('blocker', 'shell', 'No .shell element in the DOM — the meta layer is not installed at all');
}
if (!shellInfo.tokensLoaded) {
  add('blocker', 'shell', 'tokens.css is not loaded — every meta screen will be unstyled',
    shellInfo.cssHrefs.join(', '));
}
for (const s of SCREENS) {
  if (shellInfo.hasShellObj && !shellInfo.screens.includes(s.name)) {
    add('blocker', s.name, 'Screen is not registered with the shell');
  }
}
log(`  shell: ${shellInfo.hasShellEl ? 'present' : 'MISSING'}, ` +
    `screens registered: ${shellInfo.screens.join(', ') || '(none discoverable)'}`);

/* ------------------------------------------------------------ probes --- */

/** Everything measurable about the screen currently on display. */
const AUDIT = `(() => {
  const root = document.querySelector('.shell .screen-page') || document.querySelector('.shell');
  if (!root) return { missing: true };
  const vw = window.innerWidth;

  // Tap targets. Measure what is ACTUALLY rendered, not the CSS min-height:
  // a flex child can be squashed below its min-height by its parent.
  const taps = [];
  for (const el of root.querySelectorAll('button, [role=button], .tappable, input, select, a')) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;              // hidden, not small
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (r.height < ${TAP_MIN} - 0.5 || r.width < 24) {
      taps.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className || '').toString().slice(0, 60),
        text: (el.textContent || '').trim().slice(0, 34),
        w: +r.width.toFixed(1), h: +r.height.toFixed(1),
      });
    }
  }

  // Horizontal overflow: the page body must never scroll sideways.
  const overflow = [];
  for (const el of root.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    if (r.right > vw + 1.5 || r.left < -1.5) {
      overflow.push({
        cls: (el.className || '').toString().slice(0, 60),
        text: (el.textContent || '').trim().slice(0, 30),
        left: +r.left.toFixed(1), right: +r.right.toFixed(1), vw,
      });
    }
  }

  // Text that is clipped rather than wrapped or ellipsised.
  const clipped = [];
  for (const el of root.querySelectorAll('*')) {
    if (el.children.length) continue;
    const t = (el.textContent || '').trim();
    if (!t) continue;
    const cs = getComputedStyle(el);
    if (cs.overflow === 'visible' && cs.textOverflow !== 'ellipsis') continue;
    if (el.scrollWidth > el.clientWidth + 2 && cs.textOverflow !== 'ellipsis') {
      clipped.push({ text: t.slice(0, 30), scroll: el.scrollWidth, client: el.clientWidth });
    }
  }

  // Placeholder text that escaped into a shipping build.
  const body = root.textContent || '';
  const placeholders = (body.match(/\\bTODO\\b|lorem ipsum|placeholder|coming soon|undefined|\\bNaN\\b|\\[object Object\\]/gi) || []);

  return {
    missing: false,
    screen: root.dataset ? root.dataset.screen : null,
    taps, overflow, clipped,
    placeholders: [...new Set(placeholders)],
    docScrollX: document.documentElement.scrollWidth > window.innerWidth + 1,
    nodes: root.querySelectorAll('*').length,
    textLen: body.trim().length,
  };
})()`;

/** Click a lobby control whose text matches, and report whether it moved us. */
async function clickInto(rx) {
  return page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    const root = document.querySelector('.shell');
    if (!root) return null;
    const hits = [...root.querySelectorAll('button, .tile, [role=button], .tappable')]
      .filter((el) => re.test((el.textContent || '').trim()));
    if (!hits.length) return null;
    hits[0].click();
    return (hits[0].textContent || '').trim().slice(0, 40);
  }, rx.source);
}

async function goTo(name) {
  return page.evaluate((n) => {
    const g = window.__GAME__;
    const shell = window.__SHELL__ || (g && g.shell) || (window.DEV && window.DEV.shell);
    if (!shell || !shell.has || !shell.has(n)) return false;
    shell.go(n);
    return true;
  }, name);
}

async function home() {
  await page.evaluate(() => {
    const g = window.__GAME__;
    const shell = window.__SHELL__ || (g && g.shell) || (window.DEV && window.DEV.shell);
    if (shell && shell.reset) shell.reset('lobby');
  });
  await page.waitForTimeout(220);
}

/* ---------------------------------------------------- walk every screen --- */

const perScreen = {};

for (const vp of VIEWPORTS) {
  await page.setViewportSize({ width: vp.w, height: vp.h });
  await page.waitForTimeout(200);
  log(`\n▸ ${vp.id}  ${vp.w}x${vp.h}`);

  for (const s of SCREENS) {
    await resilient(async () => {
      if (s.name === 'lobby') {
        await home();
      } else {
        await home();
        const clicked = s.via ? await clickInto(s.via) : null;
        if (!clicked) {
          const routed = await goTo(s.name);
          if (!routed) {
            if (vp.id === 'phone') add('blocker', s.name, 'Screen is unreachable — no lobby control leads to it and the router does not know it');
            return;
          }
          if (vp.id === 'phone') {
            add('major', s.name, 'No lobby control reaches this screen; only shell.go() does — the player cannot get here');
          }
        }
      }
      await page.waitForTimeout(420);

      const a = await page.evaluate(AUDIT);
      if (!a || a.missing) { add('blocker', s.name, 'Nothing rendered'); return; }

      // Landed where we meant to?
      if (a.screen && a.screen !== s.name && s.name !== 'play') {
        add('major', s.name, `Navigation landed on "${a.screen}" instead`);
      }

      if (a.textLen < 40) {
        add('blocker', s.name, 'Screen is effectively empty', `${a.textLen} chars of text, ${a.nodes} nodes`);
      }
      for (const t of a.taps.slice(0, 8)) {
        add('major', s.name, `Tap target ${t.w}x${t.h}px is under the ${TAP_MIN}px floor`,
          `${t.tag}.${t.cls} "${t.text}" @${vp.id}`);
      }
      for (const o of a.overflow.slice(0, 6)) {
        add('major', s.name, `Element overflows the viewport horizontally`,
          `.${o.cls} "${o.text}" right=${o.right} vw=${o.vw} @${vp.id}`);
      }
      for (const c of a.clipped.slice(0, 4)) {
        add('minor', s.name, 'Text is clipped rather than wrapped or ellipsised',
          `"${c.text}" ${c.scroll}>${c.client} @${vp.id}`);
      }
      if (a.docScrollX) add('major', s.name, 'The document itself scrolls horizontally', `@${vp.id}`);
      for (const p of a.placeholders) {
        add(/undefined|NaN|object Object/i.test(p) ? 'blocker' : 'major',
          s.name, `Placeholder or broken value rendered: "${p}"`, `@${vp.id}`);
      }

      perScreen[s.name] = perScreen[s.name] || {};
      perScreen[s.name][vp.id] = {
        nodes: a.nodes, text: a.textLen,
        taps: a.taps.length, overflow: a.overflow.length,
      };

      const file = join(OUT, `${s.name}-${vp.id}.png`);
      await page.screenshot({ path: file, timeout: 180000 });
      log(`  ✓ ${s.name.padEnd(12)} ${String(a.nodes).padStart(4)} nodes  ` +
          `${a.taps.length ? `${a.taps.length} small taps  ` : ''}` +
          `${a.overflow.length ? `${a.overflow.length} overflow  ` : ''}-> ${file}`);
    }, `${s.name}@${vp.id}`);
  }
}

/* ------------------------------------------------------ leak check --- */

// A screen that leaves a timer running is a dead battery. Count them across a
// full tour and compare against the baseline.
const leak = await resilient(async () => {
  const before = await page.evaluate(() => {
    let n = 0;
    const oi = window.setInterval;
    window.__leakCount = 0;
    window.setInterval = function (...a) { window.__leakCount++; return oi.apply(this, a); };
    const oc = window.clearInterval;
    window.clearInterval = function (...a) { window.__leakCount--; return oc.apply(this, a); };
    return n;
  });
  for (const s of SCREENS) { await goTo(s.name); await page.waitForTimeout(260); }
  await home();
  await page.waitForTimeout(400);
  return page.evaluate(() => window.__leakCount);
}, 'leak sweep');

if (typeof leak === 'number' && leak > 1) {
  add('major', 'shell',
    `${leak} setInterval(s) still running after touring every screen and returning to the lobby`,
    'each screen must clear its timers in unmount()');
}

/* ----------------------------------------------------------- the match --- */

let matchReport = null;
if (DO_MATCH) {
  log('\n▸ match leg');
  matchReport = await resilient(async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await home();

    const before = await page.evaluate(() => {
      const p = window.__PROFILE__ || null;
      return p ? { xp: p.data.xp, coins: p.data.coins, matches: p.data.stats.matches, level: p.data.level } : null;
    });

    const started = await page.evaluate(() => {
      const root = document.querySelector('.shell');
      const btn = root && [...root.querySelectorAll('button')]
        .find((b) => /^\s*play\s*$/i.test((b.textContent || '').trim()));
      if (btn) { btn.click(); return 'tile'; }
      const g = window.__GAME__;
      if (g && g.startMatch) { g.startMatch(); return 'api'; }
      return null;
    });
    if (!started) { add('blocker', 'lobby', 'No way to start a match from the lobby'); return null; }
    if (started === 'api') add('blocker', 'lobby', 'The PLAY button does not exist or is not wired; had to call startMatch() directly');

    await page.waitForTimeout(600);
    const phaseAfterStart = await page.evaluate(() => window.__GAME__?.match?.phase);
    if (!/countdown|playing/.test(String(phaseAfterStart))) {
      add('blocker', 'lobby', `Pressing PLAY did not start a match (phase=${phaseAfterStart})`);
      return null;
    }

    // Shell must get out of the way once play begins.
    const shellVisible = await page.evaluate(() => {
      const el = document.querySelector('.shell');
      if (!el) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05;
    });
    if (shellVisible) add('blocker', 'match', 'The meta shell is still covering the screen during play');

    // Run the clock out fast rather than waiting 150 real seconds.
    await page.evaluate(() => {
      const g = window.__GAME__;
      g.match.timeLeft = 3;
      if (g.match.countdown > 0) g.match.countdown = 0.05;
    });
    for (let i = 0; i < 90; i++) {
      const done = await page.evaluate(() => {
        const g = window.__GAME__;
        for (let k = 0; k < 4; k++) g.frame(1 / 30);
        return g.match.phase === 'results';
      });
      if (done) break;
      await page.waitForTimeout(60);
    }

    const phase = await page.evaluate(() => window.__GAME__?.match?.phase);
    if (phase !== 'results') {
      add('blocker', 'match', `Match never reached the results phase (stuck at ${phase})`);
      return { phase };
    }
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(OUT, 'results-phone.png'), timeout: 180000 });

    const after = await page.evaluate(() => {
      const p = window.__PROFILE__ || null;
      const txt = document.body.textContent || '';
      return {
        prof: p ? { xp: p.data.xp, coins: p.data.coins, matches: p.data.stats.matches, level: p.data.level } : null,
        mentionsXp: /\bxp\b/i.test(txt),
        mentionsCoins: /coin/i.test(txt),
        hasAgain: /play again/i.test(txt),
        hasLobby: /lobby|menu/i.test(txt),
      };
    });

    if (!after.hasAgain) add('major', 'results', 'No "Play Again" on the end screen');
    if (!after.hasLobby) add('major', 'results', 'No way back to the lobby from the end screen');

    if (before && after.prof) {
      const gainedXp = after.prof.xp !== before.xp || after.prof.level > before.level;
      const gainedCoins = after.prof.coins > before.coins;
      const counted = after.prof.matches === before.matches + 1;
      if (!counted) add('blocker', 'progression', 'The finished match was not recorded in lifetime stats',
        `matches ${before.matches} -> ${after.prof.matches}`);
      if (!gainedXp) add('blocker', 'progression', 'No XP was awarded for finishing a match');
      if (!gainedCoins) add('major', 'progression', 'No coins were awarded for finishing a match');
      if (!after.mentionsXp) add('major', 'results', 'The end screen never mentions XP — rewards are invisible');
    } else if (!after.prof) {
      add('minor', 'progression', 'window.__PROFILE__ is not exposed, so reward persistence could not be verified');
    }

    // Back to the lobby, on a restored world.
    const returned = await page.evaluate(() => {
      const root = document.querySelector('#screens, .shell') || document.body;
      const btn = [...root.querySelectorAll('button')]
        .find((b) => /lobby|menu/i.test(b.textContent || ''));
      if (btn) { btn.click(); return true; }
      return false;
    });
    await page.waitForTimeout(1200);
    const home2 = await page.evaluate(() => ({
      phase: window.__GAME__?.match?.phase,
      lobby: !!document.querySelector('.shell [data-screen="lobby"]'),
      shellShown: (() => {
        const el = document.querySelector('.shell');
        if (!el) return false;
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && +cs.opacity > 0.05;
      })(),
    }));
    if (returned && !home2.lobby) {
      add('blocker', 'results', 'Return to Lobby did not land on the lobby screen', JSON.stringify(home2));
    }
    if (returned && !home2.shellShown) {
      add('blocker', 'results', 'Returning to the lobby left the meta shell hidden — the player is stranded');
    }

    return { before, after, phase, returned, home: home2 };
  }, 'match');
}

/* ------------------------------------------------------------- runtime --- */

for (const e of pageErrors) add('blocker', 'runtime', 'Uncaught exception', e.split('\n').slice(0, 3).join(' | '));
for (const e of [...new Set(consoleErrors)].slice(0, 20)) add('major', 'runtime', 'Console error', e);
for (const r of [...new Set(badRequests)].slice(0, 20)) add('blocker', 'runtime', 'Failed request', r);

/* -------------------------------------------------------------- report --- */

const by = (s) => findings.filter((f) => f.severity === s);
const report = {
  when: new Date().toISOString(),
  url: `http://localhost:${PORT}/`,
  shell: shellInfo,
  perScreen,
  match: matchReport,
  counts: { blocker: by('blocker').length, major: by('major').length, minor: by('minor').length },
  findings,
};
writeFileSync(join(OUT, 'meta-report.json'), JSON.stringify(report, null, 2));

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  log(`\n${'='.repeat(66)}`);
  log(`BLOCKERS ${report.counts.blocker}   MAJOR ${report.counts.major}   MINOR ${report.counts.minor}`);
  log('='.repeat(66));
  for (const sev of ['blocker', 'major', 'minor']) {
    const list = by(sev);
    if (!list.length) continue;
    log(`\n${sev.toUpperCase()}`);
    // Collapse the repeats — the same 30px button on four viewports is one bug.
    const seen = new Map();
    for (const f of list) {
      const k = `${f.screen}|${f.what}`;
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    for (const [k, n] of seen) {
      const [screen, what] = k.split('|');
      const ex = list.find((f) => f.screen === screen && f.what === what);
      log(`  [${screen}] ${what}${n > 1 ? `  (x${n})` : ''}`);
      if (ex.evidence) log(`      ${ex.evidence}`);
    }
  }
  log(`\nScreenshots + meta-report.json in ${OUT}`);
}

await browser.close();
process.exit(Math.min(250, report.counts.blocker));
