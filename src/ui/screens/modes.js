/**
 * GAME MODES — browse the seven ways to play and pick one.
 *
 * This screen is pure presentation of src/gameplay/modes.js. Every number on a
 * card is derived from that module (duration, startRadius, rewards, targetsOf)
 * so adding a mode there lights up here with no edit in this file.
 *
 * Two things are deliberately NOT read from modes.js:
 *   - the ink colour of each card's PLAY button, computed from the mode accent
 *     so a light accent (sun, aqua) gets dark text instead of unreadable white;
 *   - the rotation countdown, which is re-derived from the SAME week arithmetic
 *     activeEvent() uses. A nominal "Monday 00:00" clock would drift away from
 *     the moment the event actually flips, and a countdown that lies about the
 *     one limited-time thing on the screen is worse than no countdown.
 */

import { page, esc, shortNum, wireNav } from '../shell.js';
import { MODES, activeEvent, targetsOf, getMode } from '../../gameplay/modes.js';
import { profile as defaultProfile } from '../../meta/profile.js';
import * as lobby from './lobby.js';
import '../css/modes.css';

const WEEK_MS = 6048e5;

/**
 * Namespace import above, and every call guarded below, on purpose: the lobby
 * owns the selection but is written by another hand. If it renames or delays
 * these exports the modes screen degrades to a local selection instead of
 * taking the whole bundle down at link time.
 */
let localSelection = MODES[0].id;

function currentSelection() {
  try {
    if (typeof lobby.selectedMode === 'function') {
      const v = lobby.selectedMode();
      if (v) return v;
    }
  } catch { /* lobby not ready — fall through to the local value */ }
  return localSelection;
}

function applySelectionTo(id) {
  localSelection = id;
  try {
    if (typeof lobby.setSelectedMode === 'function') lobby.setSelectedMode(id);
  } catch { /* selection still works for this session */ }
}

/* ----------------------------------------------------------- formatting --- */

/** 150 -> "2:30". Match lengths are always minutes-and-seconds. */
function mmss(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** startRadius is a radius; players think in diameters. 2 -> "4m". */
function startSize(mode) {
  const d = (Number(mode.startRadius) || 0) * 2;
  return `${Number(d.toFixed(1))}m`;
}

function fmtLeft(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n) => String(n).padStart(2, '0');
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d > 0 ? `${d}d ` : ''}${two(h)}:${two(m)}:${two(s % 60)}`;
}

/**
 * When the event rotation flips, in local time. Mirrors activeEvent(): weeks
 * are counted from Jan 1, and the counter resets on New Year, so the last
 * "week" of a year is short and has to be clamped.
 */
function rotationEndsAt(now = new Date()) {
  const jan1 = new Date(now.getFullYear(), 0, 1).getTime();
  const week = Math.floor((now.getTime() - jan1) / WEEK_MS);
  const nextYear = new Date(now.getFullYear() + 1, 0, 1).getTime();
  return Math.min(jan1 + (week + 1) * WEEK_MS, nextYear);
}

/** Readable text on a mode accent. WCAG relative luminance, one threshold. */
function inkFor(hex) {
  const h = String(hex || '').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (full.length !== 6 || Number.isNaN(n)) return '#ffffff';
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const L = 0.2126 * lin(((n >> 16) & 255) / 255)
          + 0.7152 * lin(((n >> 8) & 255) / 255)
          + 0.0722 * lin((n & 255) / 255);
  return L > 0.42 ? '#241505' : '#ffffff';
}

/* --------------------------------------------------------- derived facts --- */

/**
 * Facts the data implies but does not spell out.
 * The collapsed card gets only the two that differ between modes — a "8
 * players" chip on all six cards is a wrapped row that tells you nothing.
 */
function factsOf(m, full = false) {
  const out = [`<span class="chip">&#9201; ${esc(mmss(m.duration))}</span>`,
               `<span class="chip">&#9678; Starts at ${esc(startSize(m))}</span>`];
  if (!full) return out.join('');
  if (m.teams > 1) out.push(`<span class="chip">${esc(String(m.teams))} teams</span>`);
  out.push(`<span class="chip">${esc(String((m.botCount || 0) + 1))} players</span>`);
  if (m.shrink) {
    out.push(`<span class="chip">Ring closes to ${esc(String(Math.round(m.shrink.endRadius)))} m</span>`);
  }
  if (typeof m.timeOfDay === 'number' && (m.timeOfDay > 0.72 || m.timeOfDay < 0.22)) {
    out.push('<span class="chip">Night match</span>');
  }
  return out.join('');
}

function chips(list, cls = '') {
  return list.map((r) => `<span class="chip ${cls}">${esc(r)}</span>`).join('');
}

export function registerModes(shell, deps = {}) {
  const prof = deps.profile || defaultProfile;

  /** Per-mode career line. Three zeros reads as "this mode is broken". */
  function bestLine(id) {
    const s = prof && prof.data && prof.data.stats && prof.data.stats.byMode
      ? prof.data.stats.byMode[id] : null;
    if (!s || !s.matches) return 'Not played yet';
    const wins = s.wins === 1 ? '1 win' : `${s.wins || 0} wins`;
    const played = s.matches === 1 ? '1 match' : `${s.matches} matches`;
    return `${played} · ${wins} · best ${shortNum(s.bestScore || 0)}`;
  }

  function rewardBlock(m) {
    return `
      <div class="m-rew">
        <span class="rew xp">+${esc(String(m.rewards.xp))} XP</span>
        <span class="rew coin">+${esc(String(m.rewards.coins))} coins</span>
      </div>
      <p class="tiny muted m-rew-note">Baseline for finishing &mdash; placement scales it up or down.</p>`;
  }

  function featured(ev) {
    const targets = targetsOf(ev);
    return `
      <section class="ev" data-mode="${esc(ev.id)}" data-event="${esc(ev.id)}"
               style="--cc:${esc(ev.accent)};--cc-ink:${esc(inkFor(ev.accent))}">
        <div class="ev-top">
          <span class="chip live ev-live">LIVE THIS WEEK</span>
          <span class="chip ev-clock">Rotates in <b data-countdown class="num">--:--:--</b></span>
        </div>
        <div class="ev-head">
          <span class="ev-ico" aria-hidden="true">${esc(ev.icon)}</span>
          <div class="ev-title">
            <h2>${esc(ev.name)}</h2>
            <p class="ev-blurb">${esc(ev.blurb)}</p>
          </div>
        </div>
        <div class="m-chips ev-facts">${factsOf(ev, true)}</div>
        <div class="m-chips">${chips(ev.rules || [], 'rule')}</div>
        <div class="m-scores"><b>Scores</b> ${esc(targets.join(' · '))}</div>
        <div class="m-best" data-best="${esc(ev.id)}">${esc(bestLine(ev.id))}</div>
        ${rewardBlock(ev)}
        <div class="m-actions">
          <button class="btn btn-ghost m-sel" data-select="${esc(ev.id)}" aria-pressed="false">SELECT</button>
          <button class="btn m-play" data-play="${esc(ev.id)}">PLAY EVENT</button>
        </div>
      </section>`;
  }

  function modeCard(m, i) {
    const rules = m.rules || [];
    const peek = rules.slice(0, 2);
    const hidden = rules.length - peek.length;
    const targets = targetsOf(m);
    const tPeek = targets.slice(0, 3).join(' · ')
      + (targets.length > 3 ? ` +${targets.length - 3}` : '');
    const id = esc(m.id);
    return `
      <article class="m-card" data-mode="${id}" style="--cc:${esc(m.accent)};--cc-ink:${esc(inkFor(m.accent))};--i:${i}">
        <button class="m-body" data-toggle="${id}" aria-expanded="false" aria-controls="more-${id}">
          <span class="m-ico" aria-hidden="true">${esc(m.icon)}</span>
          <span class="m-main">
            <span class="m-nameline">
              <span class="m-name">${esc(m.name)}</span>
              <span class="m-tag">SELECTED</span>
            </span>
            <span class="m-blurb">${esc(m.blurb)}</span>
            <span class="m-chips">${factsOf(m)}</span>
            <span class="m-chips m-rules">${chips(peek, 'rule')}${
              hidden > 0 ? `<span class="chip rule more">+${hidden}</span>` : ''}</span>
            <span class="m-scores"><b>Scores</b> ${esc(tPeek)}</span>
            <span class="m-best" data-best="${id}">${esc(bestLine(m.id))}</span>
          </span>
          <span class="m-caret" aria-hidden="true">&#8250;</span>
        </button>
        <div class="m-more" id="more-${id}">
          <div class="m-more-in">
            <h3>How it plays</h3>
            <ul class="m-rulelist">${rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
            <h3>What scores</h3>
            <div class="m-chips">${chips(targets)}</div>
            <h3>Match setup</h3>
            <div class="m-chips">${factsOf(m, true)}</div>
            <h3>Match rewards</h3>
            ${rewardBlock(m)}
          </div>
        </div>
        <div class="m-actions">
          <button class="btn btn-ghost m-sel" data-select="${id}" aria-pressed="false">SELECT</button>
          <button class="btn m-play" data-play="${id}">PLAY</button>
        </div>
      </article>`;
  }

  function render() {
    const ev = activeEvent();
    const body = `
      <div class="wrap modes-wrap">
        ${featured(ev)}
        <h3 class="modes-sep">All modes</h3>
        <div class="m-list">${MODES.map(modeCard).join('')}</div>
        <div class="sticky-actions m-sticky">
          <button class="btn btn-lg m-go" data-play-selected>
            <span class="sf-ico" data-sf-ico aria-hidden="true">&#128371;</span>
            <span class="sf-txt">PLAY <span class="sf-name" data-sf-name>Classic Devour</span></span>
          </button>
        </div>
      </div>`;
    return page({ title: 'Game Modes', back: true, body });
  }

  /* ------------------------------------------------------- open / close --- */

  function openCard(card) {
    const more = card.querySelector('.m-more');
    if (!more) return;
    card.classList.add('open');
    const btn = card.querySelector('.m-body');
    if (btn) btn.setAttribute('aria-expanded', 'true');
    more.style.height = `${more.scrollHeight}px`;

    // Settle to auto once the growth lands, so a rotation or font change cannot
    // clip content that was measured at the old width. Driven off the running
    // animation rather than a transitionend listener: with transitions off
    // (prefers-reduced-motion, or a throttled background tab) there is no
    // transitionend, and the card would stay pinned to a stale pixel height.
    const settle = () => {
      if (more.isConnected && card.classList.contains('open')) more.style.height = 'auto';
    };
    const running = more.getAnimations ? more.getAnimations() : [];
    if (!running.length) settle();
    else Promise.all(running.map((a) => a.finished)).then(settle, () => { /* closed mid-open */ });
  }

  function closeCard(card) {
    const more = card.querySelector('.m-more');
    if (!more) return;
    card.classList.remove('open');
    const btn = card.querySelector('.m-body');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    // auto -> px -> 0, with a forced reflow between, or the browser has no
    // start value to animate from and the card snaps shut.
    more.style.height = `${more.scrollHeight}px`;
    void more.offsetHeight;
    more.style.height = '0px';
  }

  function toggleCard(root, card) {
    const wasOpen = card.classList.contains('open');
    for (const other of root.querySelectorAll('.m-card.open')) {
      if (other !== card) closeCard(other);
    }
    if (wasOpen) closeCard(card); else openCard(card);
  }

  /* ------------------------------------------------------------ refresh --- */

  function paintSelection(root) {
    const sel = currentSelection();
    for (const el of root.querySelectorAll('[data-mode]')) {
      const on = el.dataset.mode === sel;
      el.classList.toggle('sel', on);
      const b = el.querySelector('[data-select]');
      if (b) {
        b.textContent = on ? '✓ SELECTED' : 'SELECT';
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }
    const m = getMode(sel);
    const go = root.querySelector('[data-play-selected]');
    if (go) {
      go.style.setProperty('--cc', m.accent);
      go.style.setProperty('--cc-ink', inkFor(m.accent));
    }
    const ico = root.querySelector('[data-sf-ico]');
    const nm = root.querySelector('[data-sf-name]');
    if (ico) ico.textContent = m.icon;
    if (nm) nm.textContent = m.name;
  }

  function paintStats(root) {
    for (const el of root.querySelectorAll('[data-best]')) {
      el.textContent = bestLine(el.dataset.best);
    }
  }

  /** PLAY always selects first, so the lobby agrees with what just launched. */
  function play(root, id) {
    applySelectionTo(id);
    paintSelection(root);
    if (typeof deps.onPlay === 'function') deps.onPlay(id);
    else shell.toast('No match launcher wired up', 'bad');
  }

  /* -------------------------------------------------------------- mount --- */

  let timer = null;
  let raf = 0;

  function mount(root, ctx) {
    wireNav(root, shell);
    paintSelection(root);

    root.addEventListener('click', (e) => {
      const playBtn = e.target.closest('[data-play]');
      if (playBtn) { play(root, playBtn.dataset.play); return; }

      if (e.target.closest('[data-play-selected]')) { play(root, currentSelection()); return; }

      const selBtn = e.target.closest('[data-select]');
      if (selBtn) {
        const id = selBtn.dataset.select;
        if (id !== currentSelection()) {
          applySelectionTo(id);
          paintSelection(root);
          shell.toast(`${getMode(id).name} selected`, 'ok');
        }
        return;
      }

      const toggle = e.target.closest('[data-toggle]');
      if (toggle) {
        const card = toggle.closest('.m-card');
        if (card) toggleCard(root, card);
      }
    });

    // Countdown. One interval for the whole screen, cleared in unmount().
    const ev = activeEvent();
    const tick = () => {
      const el = root.querySelector('[data-countdown]');
      if (!el) return;
      const left = rotationEndsAt() - Date.now();
      if (left <= 0 && activeEvent().id !== ev.id) {
        shell.go('modes', ctx.params || {}, { replace: true });
        return;
      }
      el.textContent = fmtLeft(left);
    };
    tick();
    timer = setInterval(tick, 1000);

    // Deep link from the lobby: show the mode they asked about, already open.
    const pre = ctx.params && ctx.params.preselect;
    if (pre) {
      raf = requestAnimationFrame(() => {
        raf = 0;
        const want = String(pre);
        const card = [...root.querySelectorAll('.m-card')].find((c) => c.dataset.mode === want);
        if (!card) return;
        openCard(card);
        card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    }
  }

  function unmount() {
    if (timer) { clearInterval(timer); timer = null; }
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  /** Coins/XP land while this screen is open after a match — refresh in place
   *  rather than re-rendering, which would slam an expanded card shut. */
  function onProfileChange(root) {
    paintStats(root);
    paintSelection(root);
  }

  shell.register('modes', {
    title: 'Game Modes',
    render,
    mount,
    unmount,
    onProfileChange,
  });

  return shell;
}
