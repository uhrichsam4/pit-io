/**
 * THE LOBBY — the front door.
 *
 * This is the screen the player lands on and returns to after every match, so
 * two things drive its design:
 *
 *   1. It is re-entered constantly. The shell rebuilds a screen from scratch on
 *      every navigation, so render() is a single template string and mount()
 *      does nothing more expensive than grabbing refs. There are NO timers here
 *      at all — every "live" number is either computed at render time or pushed
 *      in by onProfileChange(). A lobby that ticks once a second is a lobby that
 *      drains a phone while the player reads the mode list.
 *
 *   2. Everything below the identity bar is a launchpad. The only thing that is
 *      allowed to be visually loud is PLAY, then the limited-time event. Every
 *      other tile is a colourful but quiet door.
 *
 * Thumb reach: the hero PLAY button sits in the upper-middle where the layout
 * calls for it, and a compact PLAY dock slides up from the bottom edge the
 * moment the hero scrolls out of view, so on a small phone a match is always
 * one bottom-of-screen tap away.
 */

import '../css/lobby.css';
import { esc, shortNum } from '../shell.js';
import { profile as sharedProfile, xpForLevel } from '../../meta/profile.js';
import { getMode, listModes, activeEvent } from '../../gameplay/modes.js';

/** Where the whole meta layer agrees to keep "the mode I am about to play". */
export const LOBBY_SELECTED_KEY = 'miami-devour:mode';

const BUILD = 'v1.0.0';
const WEEK_MS = 6048e5;

/* ------------------------------------------------------- selected mode --- */

/** The mode the player last chose. Always returns a mode id that exists. */
export function selectedMode() {
  let id = null;
  try { id = localStorage.getItem(LOBBY_SELECTED_KEY); } catch { /* private mode */ }
  // getMode() falls back to MODES[0] for anything unknown, so this round-trip
  // both validates the id and accepts limited-time event ids.
  return id && getMode(id).id === id ? id : 'classic';
}

/** Remember the player's choice. Ignores ids that are not a real mode. */
export function setSelectedMode(id) {
  const mode = getMode(id);
  if (!id || mode.id !== id) return selectedMode();
  try { localStorage.setItem(LOBBY_SELECTED_KEY, id); } catch { /* private mode */ }
  return id;
}

/* ------------------------------------------------------------- helpers --- */

const TILES = [
  { key: 'public',  ico: '🌐', name: 'Public Match',    cc: '#ff3d8b', to: ['play', { intent: 'public' }] },
  { key: 'friends', ico: '👥', name: 'Play w/ Friends', cc: '#37e6d5', to: ['play', { intent: 'friends' }] },
  { key: 'modes',   ico: '🎯', name: 'Game Modes',      cc: '#8b5cf6', to: ['modes', {}] },
  { key: 'board',   ico: '🏆', name: 'Leaderboards',    cc: '#ffc93c', to: ['leaderboard', {}] },
  { key: 'store',   ico: '🛍️', name: 'Store',           cc: '#4dff9e', to: ['store', {}] },
  { key: 'profile', ico: '🪪', name: 'Profile',         cc: '#4dd2ff', to: ['profile', {}] },
];

const AVATAR_COLORS = ['#ff3d8b', '#ffc93c', '#37e6d5', '#4dff9e', '#8b5cf6', '#4dd2ff', '#ff9430', '#c58cff'];

/** Stable colour per equipped icon id, so an avatar does not change every boot. */
function avatarColor(id) {
  const s = String(id || 'hole-01');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/**
 * Names reach innerHTML on the leaderboard, the kill feed and the end screen.
 * esc() covers HTML, but the characters below are stripped outright so a name
 * cannot be *designed* to look like markup wherever it lands next.
 */
const NAME_BANNED = /[<>&"\u0027\u0060\\\u0000-\u001f\u007f]/g;

export function cleanName(raw) {
  return String(raw == null ? '' : raw)
    .replace(NAME_BANNED, '')
    .replace(/\s+/g, ' ')
    .slice(0, 16)
    .trim();
}

/** First character of the name, or the hole. Array.from so an emoji survives. */
function avatarGlyph(name) {
  const first = Array.from(String(name || ''))[0];
  return first ? first.toUpperCase() : '🕳';
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Coins are read at a glance: grouped digits until they stop fitting. */
function fmtCoins(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  return v >= 1e5 ? shortNum(v) : v.toLocaleString('en-US');
}

function fmtSpan(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(1, m)}m`;
}

/**
 * When the event rotation flips. activeEvent() indexes EVENTS by whole weeks
 * since Jan 1, so the boundary is Jan 1 + n*7d — and it re-bases on New Year,
 * which is why the year end clamps the countdown.
 */
function eventEndsInMs(now = Date.now()) {
  const d = new Date(now);
  const yearStart = new Date(d.getFullYear(), 0, 1).getTime();
  const nextYear = new Date(d.getFullYear() + 1, 0, 1).getTime();
  const idx = Math.floor((now - yearStart) / WEEK_MS);
  return Math.max(0, Math.min(yearStart + (idx + 1) * WEEK_MS, nextYear) - now);
}

/**
 * Cosmetics ship in a sibling module that may load after us. It is cached at
 * module scope so the store subtitle is exact from the second lobby visit on,
 * and merely vague on the first.
 */
let cosmetics = null;
let cosmeticsTried = false;

function loadCosmetics() {
  if (cosmetics || cosmeticsTried) return Promise.resolve(cosmetics);
  cosmeticsTried = true;
  return import('../../meta/cosmetics.js')
    .then((m) => { cosmetics = m && Array.isArray(m.ITEMS) ? m : null; return cosmetics; })
    .catch(() => null);
}

function storeSubtitle(profile) {
  if (!cosmetics) return 'Skins, trails and rim effects';
  const coins = profile.data.coins;
  let unowned = 0;
  let affordable = 0;
  for (const it of cosmetics.ITEMS) {
    if (!it || !it.kind || profile.owns(it.kind, it.id)) continue;
    unowned++;
    if (!it.unlock && Number(it.price) > 0 && Number(it.price) <= coins) affordable++;
  }
  if (affordable > 0) return `${affordable} you can afford now`;
  if (unowned > 0) return `${unowned} still locked · keep earning`;
  return 'Every cosmetic unlocked';
}

/** Honest, from real stats — the lobby never invents a rank. */
function boardSubtitle(profile) {
  const s = profile.data.stats;
  if (s.wins > 0) return `Best finish 1st · ${s.wins} ${s.wins === 1 ? 'win' : 'wins'}`;
  if (s.top3 > 0) return 'Best finish · top 3';
  if (s.matches > 0) return `${s.matches} ranked ${s.matches === 1 ? 'match' : 'matches'}`;
  return 'Unranked — play a match';
}

/* Subtitles below return PLAIN text: render() escapes them, sync() assigns them
   with textContent. Pre-escaping here would print "&amp;" on the live update. */

function publicSubtitle(net) {
  if (net && net.connected) {
    const here = (net.peers && typeof net.peers.size === 'number' ? net.peers.size : 0) + 1;
    return `Live · ${here} in ${String(net.room || 'miami').slice(0, 12)}`;
  }
  return 'AI backfill · instant match';
}

function friendsSubtitle(profile) {
  const n = Array.isArray(profile.data.friends) ? profile.data.friends.length : 0;
  return n > 0 ? `${n} ${n === 1 ? 'friend' : 'friends'} · private room` : 'Invite with your code';
}

/**
 * Daily challenge counts live on the profile; progression owns generating them.
 * If progression is here but the day's set has not been rolled yet, roll it —
 * otherwise the lobby would show "no challenges" until the player happened to
 * open the rewards screen.
 */
function ensureDailies(profile, progression) {
  if (!progression || typeof progression.rollDailies !== 'function') return;
  const cur = profile.data.daily && profile.data.daily.challenges;
  if (Array.isArray(cur) && cur.length) return;
  try {
    profile.rollDaily(() => {
      const rolled = progression.rollDailies();
      return Array.isArray(rolled) ? rolled : [];
    });
  } catch { /* progression not ready: the streak line alone is still true */ }
}

function dailyState(profile, progression) {
  ensureDailies(profile, progression);
  const list = (profile.data.daily && Array.isArray(profile.data.daily.challenges))
    ? profile.data.daily.challenges : [];
  let done = 0;
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const goal = Number(c.goal) || 0;
    const prog = Number(c.progress != null ? c.progress : c.value) || 0;
    if (c.claimed || c.done || c.complete || (goal > 0 && prog >= goal)) done++;
  }
  const streak = profile.data.streak || { days: 0, best: 0 };
  return { total: list.length, done, days: Math.max(0, streak.days || 0), best: Math.max(0, streak.best || 0) };
}

function dailyLines(st) {
  const head = st.days > 1 ? `${st.days}-day streak` : 'Daily rewards';
  let sub;
  if (st.total > 0) sub = `${st.done} of ${st.total} challenges done`;
  else if (st.best > 1) sub = `Best streak ${st.best} days`;
  else sub = 'Play every day to build a streak';
  return { head, sub, pct: st.total > 0 ? Math.round((st.done / st.total) * 100) : 0 };
}

/* ------------------------------------------------------------ clipboard --- */

/** navigator.clipboard is unavailable over plain http on a LAN-tested phone. */
function legacyCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0;user-select:text;-webkit-user-select:text';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(() => true, () => legacyCopy(text));
  }
  return Promise.resolve(legacyCopy(text));
}

/* ================================================================ screen === */

const STATE = new WeakMap();

export function registerLobby(shell, deps = {}) {
  const profile = deps.profile || sharedProfile;
  const net = deps.net || null;

  /* ----------------------------------------------------------- render --- */

  function renderIdentity() {
    const d = profile.data;
    const name = cleanName(d.name);
    const pct = Math.round(Math.max(0, Math.min(1, profile.levelProgress())) * 100);
    const need = xpForLevel(d.level);
    return `
      <header class="lob-id">
        <button class="lob-av" data-go="profile" aria-label="Open your profile">
          <span class="avatar" style="--ac:${avatarColor(d.icon)}">${esc(avatarGlyph(name))}</span>
        </button>

        <div class="lob-idmid">
          <button class="lob-name${name ? '' : ' unset'}" data-act="edit-name"
                  aria-label="Edit your player name">
            <span class="nm-txt">${name ? esc(name) : 'Set your name'}</span>
            <span class="nm-pen" aria-hidden="true">✎</span>
          </button>
          <input class="lob-nameinput" type="text" maxlength="16" hidden
                 autocomplete="off" autocorrect="off" autocapitalize="words"
                 spellcheck="false" enterkeyhint="done" aria-label="Player name" />
        </div>

        <button class="lob-coins" data-go="store" aria-label="Coins — open the store">
          <span class="ci" aria-hidden="true">🪙</span>
          <span class="cv num">${fmtCoins(d.coins)}</span>
        </button>

        <div class="lob-xprow">
          <span class="lob-lvl">LV<b class="num">${d.level}</b></span>
          <span class="bar xp"><i style="width:${pct}%"></i></span>
          <span class="lob-xptxt num tiny">${shortNum(d.xp)}/${shortNum(need)}</span>
        </div>
      </header>`;
  }

  function renderPlay() {
    const mode = getMode(selectedMode());
    return `
      <section class="lob-hero">
        <button class="btn btn-lg btn-block lob-playbtn" data-act="play">PLAY</button>
        <button class="lob-mode" data-act="modes" style="min-height:var(--row-h)"
                aria-label="Change game mode">
          <span class="lm-ico" aria-hidden="true">${esc(mode.icon)}</span>
          <span class="lm-txt">
            <b>${esc(mode.name)}</b>
            <i>${fmtDuration(mode.duration)} · ${(mode.botCount || 0) + 1} players${mode.limited ? ' · Limited' : ''}</i>
          </span>
          <span class="lm-cta">CHANGE<span aria-hidden="true">›</span></span>
        </button>
      </section>`;
  }

  function renderEvent() {
    const ev = activeEvent();
    if (!ev) return '';
    return `
      <button class="lob-event" data-act="event"
              style="--cc:${esc(ev.accent || '#ff3d8b')};min-height:var(--evt-h)"
              aria-label="Limited time event: ${esc(ev.name)}">
        <span class="ev-glow" aria-hidden="true"></span>
        <span class="ev-ico" aria-hidden="true">${esc(ev.icon)}</span>
        <span class="ev-body">
          <span class="ev-top">
            <span class="ev-kicker">LIMITED TIME</span>
            <span class="chip live">LIVE</span>
          </span>
          <span class="ev-name">${esc(ev.name)}</span>
          <span class="ev-blurb">${esc(ev.blurb)}</span>
          <span class="ev-meta">Ends in ${fmtSpan(eventEndsInMs())} · ${fmtDuration(ev.duration)} · ${esc((ev.rules && ev.rules[0]) || 'Special rules')}</span>
        </span>
        <span class="ev-go" aria-hidden="true">›</span>
      </button>`;
  }

  function tileSubtitle(key) {
    switch (key) {
      case 'public': return publicSubtitle(net);
      case 'friends': return friendsSubtitle(profile);
      case 'modes': return `${listModes().length} modes · ${getMode(selectedMode()).name}`;
      case 'board': return boardSubtitle(profile);
      case 'store': return storeSubtitle(profile);
      case 'profile': return `Level ${profile.data.level} · ${profile.data.stats.matches} played`;
      default: return '';
    }
  }

  function renderTiles() {
    return `
      <div class="lob-tiles">
        ${TILES.map((t, i) => `
          <button class="tile" data-tile="${t.key}"
                  style="--cc:${t.cc};--i:${i};min-height:var(--tile-h)">
            <span class="tile-ico" aria-hidden="true">${t.ico}</span>
            <span class="tile-name">${esc(t.name)}</span>
            <span class="tile-sub" data-sub="${t.key}">${esc(tileSubtitle(t.key))}</span>
          </button>`).join('')}
      </div>`;
  }

  function renderDaily() {
    const l = dailyLines(dailyState(profile, deps.progression));
    return `
      <button class="lob-daily" data-go="rewards" style="min-height:var(--row-h)"
              aria-label="Daily rewards and challenges">
        <span class="dl-ico" aria-hidden="true">🔥</span>
        <span class="dl-txt">
          <b data-daily="head">${esc(l.head)}</b>
          <i data-daily="sub">${esc(l.sub)}</i>
          <span class="bar dl-bar"><i data-daily="bar" style="width:${l.pct}%"></i></span>
        </span>
        <span class="dl-go" aria-hidden="true">›</span>
      </button>`;
  }

  function renderFooter() {
    return `
      <footer class="lob-foot">
        <button class="icon-btn" data-go="settings" aria-label="Settings">⚙</button>
        <button class="lob-code" data-act="copy-code" aria-label="Copy your friend code">
          <span class="fc-k tiny muted">MIAMI DEVOUR ${BUILD} · FRIEND CODE</span>
          <span class="fc-v num">${esc(profile.data.id || '------')}</span>
        </button>
      </footer>`;
  }

  function render() {
    return `
      ${renderIdentity()}
      <div class="page-body lob-body">
        <div class="wrap-wide lob-wrap">
          ${renderPlay()}
          ${renderEvent()}
          ${renderTiles()}
          ${renderDaily()}
          ${renderFooter()}
        </div>
      </div>
      <div class="lob-dock" aria-hidden="true">
        <div class="wrap-wide">
          <button class="btn btn-block lob-dockbtn" data-act="play" tabindex="-1">
            <span>PLAY</span><em>${esc(getMode(selectedMode()).name)}</em>
          </button>
        </div>
      </div>`;
  }

  /* ------------------------------------------------------------ live --- */

  /**
   * Patch the numbers in place. The lobby is on screen while coins land from a
   * match reward, so a full re-render here would flash every tile and restart
   * the entrance animation on each coin.
   */
  function sync(root) {
    const st = STATE.get(root);
    if (!st) return;
    const d = profile.data;

    const name = cleanName(d.name);
    if (!st.editing) {
      const btn = st.nameBtn;
      btn.classList.toggle('unset', !name);
      btn.querySelector('.nm-txt').textContent = name || 'Set your name';
      st.avatar.textContent = avatarGlyph(name);
      st.avatar.style.setProperty('--ac', avatarColor(d.icon));
    }

    st.lvl.textContent = String(d.level);
    st.xpFill.style.width = `${Math.round(Math.max(0, Math.min(1, profile.levelProgress())) * 100)}%`;
    st.xpTxt.textContent = `${shortNum(d.xp)}/${shortNum(xpForLevel(d.level))}`;
    st.coins.textContent = fmtCoins(d.coins);

    for (const [key, el] of st.subs) el.textContent = tileSubtitle(key);

    const l = dailyLines(dailyState(profile, deps.progression));
    st.dailyHead.textContent = l.head;
    st.dailySub.textContent = l.sub;
    st.dailyBar.style.width = `${l.pct}%`;
  }

  /* ----------------------------------------------------------- mount --- */

  function startPlay(shellRef) {
    const id = selectedMode();
    if (typeof deps.onPlay === 'function') deps.onPlay(id);
    else shellRef.toast('No match wiring — cannot start', 'bad');
  }

  function beginEdit(root) {
    const st = STATE.get(root);
    if (!st || st.editing) return;
    st.editing = true;
    st.nameInput.value = cleanName(profile.data.name);
    st.nameBtn.hidden = true;
    st.nameInput.hidden = false;
    st.nameInput.focus();
    st.nameInput.select();
  }

  function endEdit(root, commit) {
    const st = STATE.get(root);
    if (!st || !st.editing) return;
    st.editing = false;
    st.nameInput.hidden = true;
    st.nameBtn.hidden = false;
    if (commit) {
      const next = cleanName(st.nameInput.value);
      if (next !== profile.data.name) {
        profile.data.name = next;
        profile.save();                     // emits -> onProfileChange -> sync()
        st.shell.toast(next ? `Hi, ${next}` : 'Name cleared', next ? 'ok' : 'info');
      }
    }
    sync(root);
  }

  function mount(root, ctx) {
    const shellRef = ctx.shell;
    const q = (sel) => root.querySelector(sel);

    const subs = new Map();
    for (const el of root.querySelectorAll('[data-sub]')) subs.set(el.dataset.sub, el);

    const st = {
      shell: shellRef,
      editing: false,
      io: null,
      avatar: q('.lob-av .avatar'),
      nameBtn: q('.lob-name'),
      nameInput: q('.lob-nameinput'),
      lvl: q('.lob-lvl b'),
      xpFill: q('.lob-xprow .bar > i'),
      xpTxt: q('.lob-xptxt'),
      coins: q('.lob-coins .cv'),
      subs,
      dailyHead: q('[data-daily="head"]'),
      dailySub: q('[data-daily="sub"]'),
      dailyBar: q('[data-daily="bar"]'),
    };
    STATE.set(root, st);

    // One delegated handler on the page element: it dies with the node, so
    // there is nothing to unbind and nothing that can leak per lobby visit.
    root.addEventListener('click', (e) => {
      const go = e.target.closest('[data-go]');
      if (go) { shellRef.go(go.dataset.go); return; }

      const tile = e.target.closest('[data-tile]');
      if (tile) {
        const def = TILES.find((t) => t.key === tile.dataset.tile);
        if (def) shellRef.go(def.to[0], def.to[1]);
        return;
      }

      const act = e.target.closest('[data-act]');
      if (!act) return;
      switch (act.dataset.act) {
        case 'play': startPlay(shellRef); break;
        case 'modes': shellRef.go('modes'); break;
        case 'event': {
          const ev = activeEvent();
          // `preselect` is what the modes screen reads; `event` is kept so a
          // future caller-side rename does not silently land on nothing.
          shellRef.go('modes', ev ? { preselect: ev.id, event: ev.id } : {});
          break;
        }
        case 'edit-name': beginEdit(root); break;
        case 'copy-code': {
          const code = String(profile.data.id || '');
          copyText(code).then((ok) => {
            shellRef.toast(ok ? `Friend code ${code} copied` : `Your friend code is ${code}`, ok ? 'ok' : 'info', 2600);
          });
          break;
        }
        default: break;
      }
    });

    st.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); endEdit(root, true); }
      else if (e.key === 'Escape') { e.preventDefault(); endEdit(root, false); }
    });
    st.nameInput.addEventListener('blur', () => endEdit(root, true));

    // The bottom dock only exists to rescue thumb reach once the hero PLAY has
    // scrolled away; on a desktop the hero never leaves and this never fires.
    const body = q('.lob-body');
    const hero = q('.lob-playbtn');
    const dock = q('.lob-dock');
    if (body && hero && dock && typeof IntersectionObserver === 'function') {
      st.io = new IntersectionObserver((entries) => {
        for (const en of entries) {
          const on = !en.isIntersecting;
          dock.classList.toggle('on', on);
          dock.setAttribute('aria-hidden', on ? 'false' : 'true');
          const b = dock.querySelector('.lob-dockbtn');
          if (b) b.tabIndex = on ? 0 : -1;
        }
      }, { root: body, threshold: 0.4 });
      st.io.observe(hero);
    }

    // Store affordability needs the cosmetics catalogue; it is loaded lazily so
    // a first paint never waits on it, then patched in when it arrives.
    if (!cosmetics) {
      loadCosmetics().then((m) => {
        if (m && STATE.has(root)) sync(root);
      });
    }
  }

  function unmount(root) {
    const st = STATE.get(root);
    if (st && st.io) st.io.disconnect();
    STATE.delete(root);
  }

  shell.register('lobby', {
    title: 'Lobby',
    render,
    mount,
    unmount,
    onProfileChange: sync,
  });

  return shell;
}
