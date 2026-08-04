/**
 * SETTINGS — everything applies the instant it is touched.
 *
 * There is no Save button and there is no Cancel. On a phone, a settings screen
 * that batches changes behind a commit is a screen where the player cannot hear
 * what the music slider did. Every control here writes straight into
 * profile.data.settings, calls profile.save(), and pushes the value at whatever
 * subsystem owns it.
 *
 * Three of these settings have to survive a reload without this screen ever
 * being opened, so the appliers are exported: call applySettings(deps) once at
 * boot and the saved audio mix, quality tier, FPS meter and reduced-motion
 * preference all come back.
 */

import { esc, page, wireNav, icon } from '../shell.js';
import '../css/settings.css';
import { profile } from '../../meta/profile.js';

/* ========================================================================= */
/* QUALITY                                                                   */
/* ========================================================================= */

/**
 * The five choices the player sees, and what each one means in engine terms.
 * `tier` indexes src/core/quality.js QUALITY_TIERS (0 = high … 3 = potato);
 * `adaptive` is QUALITY.adaptive, the engine's own downward fallback.
 *
 * Exported so the integrator does not have to re-derive the mapping — pass
 * `level.tier` to applyQualityTier() and `level.adaptive` to QUALITY.adaptive.
 */
export const QUALITY_LEVELS = [
  { id: 'auto', label: 'Auto', tier: 1, adaptive: true, hint: 'Starts at Medium and drops a notch if the frame rate cannot keep up.' },
  { id: 'low', label: 'Low', tier: 3, adaptive: false, hint: 'No shadows, no bloom, no AA. The longest battery life.' },
  { id: 'medium', label: 'Medium', tier: 2, adaptive: false, hint: 'Shadows and bloom on, ambient occlusion off.' },
  { id: 'high', label: 'High', tier: 1, adaptive: false, hint: 'Shadows, AO and bloom. The intended look on a modern phone.' },
  { id: 'ultra', label: 'Ultra', tier: 0, adaptive: false, hint: 'Full-resolution AO, 3K shadows, 2x pixel ratio. Desktop class.' },
];

export function qualityLevel(id) {
  return QUALITY_LEVELS.find((q) => q.id === id) || QUALITY_LEVELS[0];
}

/* ========================================================================= */
/* APPLIERS — usable without ever opening the screen                         */
/* ========================================================================= */

let _audio = null;
let _audioTried = false;

/**
 * The audio singleton, if there is one. deps.audio wins; otherwise the module
 * is imported lazily — game.js already has it loaded, so this resolves from
 * cache rather than costing a request.
 */
function withAudio(deps, fn) {
  const a = (deps && deps.audio) || _audio;
  if (a) { try { fn(a); } catch { /* a dead AudioContext must not break the UI */ } return; }
  if (_audioTried) return;
  _audioTried = true;
  import('../../core/audio.js')
    .then((m) => { _audio = m.audio; try { fn(_audio); } catch { /* as above */ } })
    .catch(() => { /* no audio module: every control here still works */ });
}

/**
 * tokens.css is a frozen contract and only honours the OS-level
 * prefers-reduced-motion query, so the in-app toggle ships the rule it needs.
 * Injected once, into a stylesheet this module owns.
 */
const RM_STYLE_ID = 'md-reduced-motion';
function ensureReducedMotionStyle() {
  if (document.getElementById(RM_STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = RM_STYLE_ID;
  s.textContent = `
    .reduced-motion .shell *, .reduced-motion .shell *::before, .reduced-motion .shell *::after,
    .reduced-motion #ui-root *, .reduced-motion #ui-root *::before, .reduced-motion #ui-root *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
    }
    .reduced-motion .shell .page-body { scroll-behavior: auto !important; }`;
  document.head.appendChild(s);
}

export function applyReducedMotion(on) {
  ensureReducedMotionStyle();
  document.documentElement.classList.toggle('reduced-motion', !!on);
}

/* --- FPS meter ---------------------------------------------------------- */

let _fpsEl = null;
let _fpsRaf = 0;

/**
 * A self-contained readout, so "Show FPS" is a real setting on its own rather
 * than a flag waiting for somebody else to honour it. If the integrator wires
 * deps.onShowFps and draws a nicer one, this still costs nothing when off.
 */
export function applyShowFps(on) {
  if (!on) {
    if (_fpsRaf) { cancelAnimationFrame(_fpsRaf); _fpsRaf = 0; }
    if (_fpsEl) { _fpsEl.remove(); _fpsEl = null; }
    return;
  }
  if (_fpsEl) return;

  _fpsEl = document.createElement('div');
  _fpsEl.id = 'md-fps';
  _fpsEl.setAttribute('aria-hidden', 'true');
  // Bottom-left, not the customary top-left: the shell's back button lives in
  // the top-left corner of every meta screen and the kill feed lives there
  // during a match, so a readout parked there sits on top of both.
  _fpsEl.style.cssText = [
    'position:fixed',
    'bottom:calc(6px + env(safe-area-inset-bottom,0px))',
    'left:calc(6px + env(safe-area-inset-left,0px))',
    'z-index:9999',
    'padding:2px 7px',
    'border-radius:999px',
    'background:rgba(4,8,16,0.72)',
    'border:1px solid rgba(255,255,255,0.22)',
    'color:#4dff9e',
    'font:700 11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
    'font-variant-numeric:tabular-nums',
    'pointer-events:none',
  ].join(';');
  document.body.appendChild(_fpsEl);

  let last = performance.now();
  let acc = 0;
  let frames = 0;
  const tick = (now) => {
    _fpsRaf = requestAnimationFrame(tick);
    acc += now - last;
    last = now;
    frames++;
    if (acc < 400) return;
    const game = window.__GAME__;
    // The engine's own smoothed number is the honest one when it exists;
    // rAF deltas here would only measure how fast the browser calls us back.
    const fps = game && Number.isFinite(game.fps) ? game.fps : (frames * 1000) / acc;
    _fpsEl.textContent = `${Math.round(fps)} FPS`;
    _fpsEl.style.color = fps >= 50 ? '#4dff9e' : fps >= 30 ? '#ffc93c' : '#ff3d8b';
    acc = 0;
    frames = 0;
  };
  _fpsRaf = requestAnimationFrame(tick);
}

/**
 * Push every saved setting at the subsystem that owns it. Call once at boot.
 * @param {{audio?:object, onQuality?:Function, onShowFps?:Function}} [deps]
 */
export function applySettings(deps = {}) {
  const s = profile.data.settings;
  withAudio(deps, (a) => {
    a.setMusicVolume(s.music);
    a.setSfxVolume(s.sfx);
  });
  applyReducedMotion(s.reducedMotion);
  applyShowFps(s.showFps);
  if (deps.onShowFps) { try { deps.onShowFps(!!s.showFps); } catch { /* host's problem */ } }
  if (deps.onQuality) { try { deps.onQuality(s.quality, qualityLevel(s.quality)); } catch { /* host's problem */ } }
  return s;
}

/* ========================================================================= */
/* MARKUP                                                                    */
/* ========================================================================= */

function sliderRow({ key, icon, name, desc, value }) {
  const v = Math.round(value * 100);
  return `
    <div class="st-row st-slider">
      <div class="st-label">
        <span class="st-ico" aria-hidden="true">${icon}</span>
        <span class="st-text"><b>${name}</b><small>${desc}</small></span>
        <output class="st-val num" data-out="${key}">${v}</output>
      </div>
      <input class="sl" type="range" min="0" max="100" step="1" value="${v}"
             style="--v:${v}%" data-slider="${key}" aria-label="${name} volume" />
    </div>`;
}

function toggleRow({ key, icon, name, desc, on }) {
  return `
    <button class="st-row st-toggle" role="switch" aria-checked="${on ? 'true' : 'false'}" data-toggle="${key}">
      <span class="st-label">
        <span class="st-ico" aria-hidden="true">${icon}</span>
        <span class="st-text"><b>${name}</b><small>${desc}</small></span>
      </span>
      <span class="sw" aria-hidden="true"><i></i></span>
    </button>`;
}

function bodyHtml() {
  const s = profile.data.settings;
  const q = qualityLevel(s.quality);
  const code = profile.data.id || '------';

  return `<div class="wrap stack st-root">

      <section class="panel st-sec">
        <h3>Audio</h3>
        ${sliderRow({ key: 'music', icon: '🎵', name: 'Music', desc: 'Synth soundtrack', value: s.music })}
        ${sliderRow({ key: 'sfx', icon: '🔊', name: 'Sound effects', desc: 'Chomps, crumbles, crowd', value: s.sfx })}
      </section>

      <section class="panel st-sec">
        <h3>Graphics</h3>
        <div class="st-row st-block">
          <div class="st-label">
            <span class="st-ico" aria-hidden="true">✨</span>
            <span class="st-text"><b>Quality</b><small data-quality-hint>${esc(q.hint)}</small></span>
          </div>
          <div class="seg" role="radiogroup" aria-label="Graphics quality">
            ${QUALITY_LEVELS.map((l) => `
              <button role="radio" aria-checked="${l.id === q.id ? 'true' : 'false'}"
                      data-quality="${l.id}">${l.label}</button>`).join('')}
          </div>
        </div>
        ${toggleRow({ key: 'showFps', icon: '📈', name: 'Show FPS', desc: 'Frame rate readout in the corner', on: s.showFps })}
      </section>

      <section class="panel st-sec">
        <h3>Gameplay</h3>
        ${toggleRow({ key: 'invertY', icon: '🔄', name: 'Invert drag', desc: 'Drag away from where you want to go', on: s.invertY })}
        ${toggleRow({ key: 'reducedMotion', icon: '🌀', name: 'Reduced motion', desc: 'Calms screen shake and menu animation', on: s.reducedMotion })}
      </section>

      <section class="panel st-sec">
        <h3>Account</h3>
        <div class="st-row st-block">
          <div class="st-label">
            <span class="st-ico" aria-hidden="true">${icon('card')}</span>
            <span class="st-text"><b>Friend code</b><small>Give this to a friend so they can add you</small></span>
          </div>
          <button class="code-copy" data-copy="${esc(code)}">
            <b class="code">${esc(code)}</b>
            <span class="code-cta">COPY</span>
          </button>
        </div>
      </section>

      <section class="st-sec st-danger">
        <button class="btn btn-ghost btn-block danger" data-reset>Reset progress</button>
        <p class="tiny muted center st-danger-note">
          Wipes your level, coins, cosmetics, stats and achievements on this device.
          There is no undo and no cloud backup.
        </p>
      </section>

      <p class="st-about tiny center muted">
        MIAMI DEVOUR — built in the browser with Three.js.<br />
        Every texture, sound and icon in this game is generated in code.<br />
        No ads, no trackers, no purchases.
      </p>
    </div>`;
}

/* ========================================================================= */
/* SCREEN                                                                    */
/* ========================================================================= */

/**
 * @param {import('../shell.js').Shell} shell
 * @param {{audio?:object, onQuality?:Function, onShowFps?:Function}} [deps]
 */
export function registerSettings(shell, deps = {}) {
  const set = (key, value) => {
    profile.data.settings[key] = value;
    profile.save();
  };

  shell.register('settings', {
    title: 'Settings',

    render() {
      return page({ title: 'Settings', body: bodyHtml() });
    },

    mount(root) {
      wireNav(root, shell);

      /* --- sliders: fire on input so the mix moves under the thumb ------- */
      root.addEventListener('input', (e) => {
        const sl = e.target.closest('[data-slider]');
        if (!sl) return;
        const key = sl.dataset.slider;
        const pct = Math.max(0, Math.min(100, Number(sl.value) || 0));
        const v = pct / 100;
        sl.style.setProperty('--v', `${pct}%`);
        const out = root.querySelector(`[data-out="${key}"]`);
        if (out) out.textContent = String(pct);
        set(key, v);
        withAudio(deps, (a) => {
          if (key === 'music') a.setMusicVolume(v);
          else a.setSfxVolume(v);
        });
      });

      // A volume you cannot hear is a volume you cannot set. One blip when the
      // thumb is released, never during the drag.
      root.addEventListener('change', (e) => {
        const sl = e.target.closest('[data-slider="sfx"]');
        if (!sl) return;
        withAudio(deps, (a) => a.ui('click'));
      });

      root.addEventListener('click', async (e) => {
        /* --- toggles --------------------------------------------------- */
        const tg = e.target.closest('[data-toggle]');
        if (tg) {
          const key = tg.dataset.toggle;
          const on = tg.getAttribute('aria-checked') !== 'true';
          tg.setAttribute('aria-checked', on ? 'true' : 'false');
          set(key, on);
          if (key === 'reducedMotion') applyReducedMotion(on);
          if (key === 'showFps') {
            applyShowFps(on);
            if (deps.onShowFps) { try { deps.onShowFps(on); } catch { /* host's problem */ } }
          }
          withAudio(deps, (a) => a.ui('click'));
          return;
        }

        /* --- quality --------------------------------------------------- */
        const q = e.target.closest('[data-quality]');
        if (q) {
          const level = qualityLevel(q.dataset.quality);
          for (const b of root.querySelectorAll('[data-quality]')) {
            b.setAttribute('aria-checked', b === q ? 'true' : 'false');
          }
          const hint = root.querySelector('[data-quality-hint]');
          if (hint) hint.textContent = level.hint;
          set('quality', level.id);
          if (deps.onQuality) {
            try { deps.onQuality(level.id, level); }
            catch (err) { console.warn('[settings] onQuality failed', err); }
          }
          shell.toast(`Quality: ${level.label}`, 'info', 1400);
          return;
        }

        /* --- friend code ----------------------------------------------- */
        const copy = e.target.closest('[data-copy]');
        if (copy) {
          const ok = await copyText(copy.dataset.copy);
          shell.toast(ok ? 'Friend code copied' : 'Could not copy — long-press the code', ok ? 'ok' : 'bad');
          return;
        }

        /* --- reset ------------------------------------------------------ */
        if (e.target.closest('[data-reset]')) {
          const yes = await shell.confirm(
            'Reset everything? Your level, coins, cosmetics and achievements on this device are gone for good.',
            { ok: 'Reset it all', cancel: 'Keep playing' },
          );
          if (!yes) return;
          profile.reset();
          applySettings(deps);
          shell.toast('Progress reset', 'ok');
          // Re-render from the fresh profile: the friend code changed and every
          // control is back at its default.
          const host = root.querySelector('.st-root');
          if (host) {
            host.outerHTML = bodyHtml();
            for (const b of root.querySelectorAll('button')) b.style.minHeight = 'var(--tap)';
          }
        }
      });
    },

    unmount() { /* no timers, no window listeners — nothing to release */ },
  });

  return shell;
}

/**
 * Clipboard with a fallback. navigator.clipboard is unavailable on http origins
 * and rejects outright in some in-app browsers, which is exactly where a player
 * is most likely to be sharing a friend code.
 */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export default registerSettings;
