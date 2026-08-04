/**
 * PLAY — the screen that gets a player into a match with other people.
 *
 * Two tabs over one shared set of controls:
 *
 *   PUBLIC MATCH   Quick Match plus a live server browser, polled every 4 s
 *                  while this screen is mounted and never once it is not.
 *   WITH FRIENDS   Create a private lobby (a big six-character code, copy and
 *                  share), join by code, or jump into a friend's lobby.
 *
 * THE HONESTY RULE, which is most of the design of this file: this game's
 * DEFAULT state is offline. No room server is running on a laptop that just
 * opened the page, and that is not an error. So there is no spinner without a
 * cancel button, no list of invented lobbies to make the screen look busy, and
 * when the server does not answer the browser is replaced by a panel that says
 * so and offers the offline match — which is the same game, with bots.
 *
 * Ownership: this file, play.css, matchmaking.js and server/. Everything it
 * needs from the rest of the meta layer comes through shell.js, profile.js and
 * modes.js, and the two callbacks the integrator passes in.
 */

import { esc, page, wireNav } from '../shell.js';
import '../css/play.css';
import { profile } from '../../meta/profile.js';
import { listModes, activeEvent, getMode } from '../../gameplay/modes.js';
import * as MM from '../../net/matchmaking.js';

const POLL_MS = 4000;
/** A search that resolves instantly still shows for this long — a panel that
 *  flashes past reads as a glitch, not as speed. */
const MIN_SEARCH_MS = 700;
const MAX_BOTS = 11;

/** Survives navigation inside one session, so coming back to Play remembers
 *  which tab and which mode you were on. Deliberately not persisted: a stale
 *  mode choice from last week is not worth a profile field. */
const ui = { tab: 'public', mode: 'classic' };

/** Per-mount state, keyed by the element the shell hands us. A screen can be
 *  mounted, unmounted and re-mounted while an old request is still in flight,
 *  so nothing about a visit may live at module scope. */
const mounts = new WeakMap();

/* --------------------------------------------------------------- helpers --- */

const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function mmss(sec) {
  const s = Math.max(0, num(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Every mode a player can queue for: the six staples plus this week's event. */
function playableModes() {
  const list = listModes();
  const ev = activeEvent();
  return ev ? [...list, ev] : list;
}

function modeOf(id) { return getMode(id); }

/**
 * AI backfill, normalised. Stored as `{ on, count }` on
 * profile.data.settings.aiBackfill; a bare number is tolerated because it is
 * the obvious thing for another module to have written.
 */
function backfill() {
  const s = profile.data.settings || (profile.data.settings = {});
  let b = s.aiBackfill;
  if (typeof b === 'number') b = { on: b > 0, count: b };
  if (!b || typeof b !== 'object') b = { on: true, count: 7 };
  b.on = b.on !== false;
  b.count = clamp(num(b.count), 0, MAX_BOTS);
  s.aiBackfill = b;
  return b;
}

function setBackfill(patch) {
  const b = backfill();
  Object.assign(b, patch);
  b.count = clamp(num(b.count), 0, MAX_BOTS);
  profile.save();
  return b;
}

/** Friends may be bare codes or objects; both shapes reach here. */
function friendList() {
  const raw = Array.isArray(profile.data.friends) ? profile.data.friends : [];
  const out = [];
  for (const f of raw) {
    const id = MM.normalizeCode(typeof f === 'string' ? f : (f && f.id) || '');
    if (id.length < 4) continue;
    const name = typeof f === 'string' ? id : String((f && f.name) || id);
    if (!out.some((o) => o.id === id)) out.push({ id, name });
  }
  return out;
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* denied, or an insecure origin — fall through */ }
  try {
    // The execCommand path is the only thing that works on http:// LAN
    // addresses, which is exactly how two phones play this on a home network.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

const canShare = () => typeof navigator !== 'undefined' && typeof navigator.share === 'function';

/* ------------------------------------------------------------- fragments --- */

function modeStrip() {
  return playableModes().map((m) => `
    <button class="mode-chip" role="radio" data-mode="${esc(m.id)}"
            aria-checked="${m.id === ui.mode ? 'true' : 'false'}"
            style="--cc:${esc(m.accent)}">
      <span class="mc-ico">${esc(m.icon)}</span>
      <span class="mc-name">${esc(m.name)}</span>
      ${m.limited ? '<span class="mc-tag">EVENT</span>' : ''}
    </button>`).join('');
}

function skeletonRows() {
  return `<div class="skel">${'<div class="skel-row"><i></i><b></b><s></s></div>'.repeat(3)}</div>`;
}

function offlinePanel() {
  return `
    <div class="offline-note">
      <div class="off-ico" aria-hidden="true">📡</div>
      <div class="off-title">No server found — you'll play against AI.</div>
      <p class="tiny muted">Everything else works exactly the same: coins, XP,
        cosmetics and your stats all carry on.</p>
      <div class="off-actions">
        <button class="btn btn-block" data-act="offline">Play Offline vs AI</button>
        <button class="btn btn-ghost btn-block" data-act="retry">Look again</button>
      </div>
    </div>`;
}

function phaseLabel(r) {
  if (r.phase === 'playing') return `In play · ${mmss(r.timeLeft)}`;
  if (r.phase === 'results') return 'Between rounds';
  return r.players > 0 ? 'Warming up' : 'Open lobby';
}

function roomRow(r) {
  const m = modeOf(r.mode);
  const players = num(r.players);
  const max = num(r.max) || 12;
  const full = players >= max;
  const nearly = !full && players >= max - 2;
  // A full lobby stays on the list, disabled. Dropping it would quietly shrink
  // the board every time the game got popular, which reads as "nobody is
  // playing" at exactly the moment the opposite is true.
  return `
    <button class="row room-row${full ? ' full' : ''}" ${full ? 'disabled' : ''}
            data-act="join-room" data-code="${esc(r.code)}"
            style="--cc:${esc(m.accent)}">
      <span class="rr-ico" aria-hidden="true">${esc(m.icon)}</span>
      <span class="rr-main">
        <span class="rr-name">${esc(m.name)}</span>
        <span class="rr-sub tiny">#${esc(r.code)} · ${esc(phaseLabel({ ...r, players }))}</span>
      </span>
      <span class="rr-count num${nearly ? ' hot' : ''}">${players}<i>/${max}</i></span>
      <span class="rr-go" aria-hidden="true">${full ? 'FULL' : '›'}</span>
    </button>`;
}

function friendRow(f, state) {
  const room = state && state.room;
  const players = room ? num(room.players) : 0;
  const joinable = !!room && players < (num(room.max) || 12);
  // A room that exists with nobody in it is a lobby they opened and have not
  // entered — still joinable, but saying "in a lobby" would be a lie.
  const sub = !state || state.unknown
    ? 'No server — can\'t check'
    : room
      ? (players > 0
        ? `In a lobby · ${players}/${num(room.max) || 12}`
        : 'Lobby open · waiting')
      : 'Not in a lobby';
  return `
    <div class="row friend-row${joinable ? ' on' : ''}">
      <span class="avatar" aria-hidden="true">${esc(f.name.slice(0, 1).toUpperCase())}</span>
      <span class="fr-main">
        <span class="nm">${esc(f.name)}</span>
        <span class="tiny muted">#${esc(f.id)} · ${esc(sub)}</span>
      </span>
      ${joinable
        ? `<button class="btn btn-aqua btn-sm" data-act="join-room" data-code="${esc(state.room.code)}">Join</button>`
        : '<span class="fr-off tiny muted">—</span>'}
    </div>`;
}

/* ---------------------------------------------------------------- screen --- */

/**
 * @param {import('../shell.js').Shell} shell
 * @param {{onJoin?:(info:{room:string,mode:string,code:string,bots:number})=>void,
 *          onPlay?:(modeId:string)=>void}} deps
 *   onJoin  — enter an online room. onPlay — start an offline match.
 *   Both are provided by the integration wiring; this screen only calls them.
 */
export function registerPlay(shell, deps = {}) {
  const call = (fn, name, arg) => {
    if (typeof fn === 'function') { fn(arg); return true; }
    console.warn(`[play] deps.${name} was not provided`);
    shell.toast('Could not start the match', 'bad');
    return false;
  };

  const startOffline = (modeId) => call(deps.onPlay, 'onPlay', modeId || ui.mode);
  const startOnline = (info) => call(deps.onJoin, 'onJoin', {
    ...info,
    // Not part of the documented payload, but free to pass and the host would
    // otherwise have to re-read the profile to learn it.
    bots: backfill().on ? backfill().count : 0,
  });

  /* ------------------------------------------------------------ render --- */

  function render({ params }) {
    // An explicit intent always wins; without one we keep whichever tab the
    // player was last on, because "Play" is a screen people bounce in and out
    // of and re-selecting their tab every time is a small papercut.
    const intent = params && params.intent;
    if (intent === 'friends' || intent === 'public') ui.tab = intent;
    else if (ui.tab !== 'friends') ui.tab = 'public';
    if (params && params.mode) ui.mode = modeOf(params.mode).id;

    const body = `
      <div class="wrap play-wrap">
        <div class="tabs" role="tablist">
          <button role="tab" data-tab="public" aria-selected="${ui.tab === 'public'}">Public Match</button>
          <button role="tab" data-tab="friends" aria-selected="${ui.tab === 'friends'}">Play with Friends</button>
        </div>

        <div class="panel panel-tight mode-panel">
          <div class="mode-strip" role="radiogroup" aria-label="Game mode" data-el="modestrip">
            ${modeStrip()}
          </div>
          <div class="mode-blurb tiny muted" data-el="modeblurb"></div>
        </div>

        <section class="pane" data-pane="public"${ui.tab === 'public' ? '' : ' hidden'}>
          <div class="panel panel-flush browser">
            <div class="browser-head">
              <h3>Live lobbies</h3>
              <span class="chip net-chip" data-el="netchip">Checking…</span>
              <button class="icon-btn refresh" data-act="retry" aria-label="Refresh lobbies">⟳</button>
            </div>
            <div class="room-rows" data-el="roomlist">${skeletonRows()}</div>
          </div>
        </section>

        <section class="pane" data-pane="friends"${ui.tab === 'friends' ? '' : ' hidden'}>
          <div class="panel lobby-panel" data-el="lobby"></div>

          <div class="panel join-panel">
            <h3>Join with a code</h3>
            <div class="code-boxes" data-el="codeboxes">
              ${[0, 1, 2, 3, 4, 5].map((i) => `
                <input class="code-box" data-i="${i}" maxlength="1" type="text"
                       inputmode="text" autocapitalize="characters" autocorrect="off"
                       autocomplete="off" spellcheck="false"
                       aria-label="Invite code character ${i + 1}">`).join('')}
            </div>
            <div class="join-msg tiny muted" data-el="joinmsg">Six characters, letters and numbers.</div>
            <button class="btn btn-aqua btn-block" data-act="join-code" disabled>Join Lobby</button>
          </div>

          <div class="panel friends-panel">
            <h3>Friends</h3>
            <div class="mycode-row">
              <div class="mycode-label tiny muted">Your code</div>
              <div class="mycode num" data-el="mycode">${esc(profile.data.id || '------')}</div>
              <div class="mycode-actions">
                <button class="btn btn-ghost btn-sm" data-act="copy-mine">Copy</button>
                ${canShare() ? '<button class="btn btn-ghost btn-sm" data-act="share-mine">Share</button>' : ''}
              </div>
            </div>
            <div class="friend-rows" data-el="friendlist"></div>
          </div>
        </section>

        <div class="panel ai-panel">
          <div class="row-between ai-head">
            <div class="ai-copy">
              <div class="ai-title">Fill with bots</div>
              <div class="tiny muted">Empty slots become AI holes</div>
            </div>
            <button class="switch" role="switch" aria-checked="true" data-act="ai-toggle"
                    aria-label="Fill empty slots with bots"><i></i></button>
          </div>
          <div class="stepper" data-el="aistep">
            <span class="tiny muted">Bots</span>
            <div class="stepper-ctl">
              <button class="icon-btn" data-act="ai-minus" aria-label="Fewer bots">−</button>
              <span class="ai-count num" data-el="aicount">7</span>
              <button class="icon-btn" data-act="ai-plus" aria-label="More bots">+</button>
            </div>
          </div>
        </div>

        <div class="sticky-actions" data-el="actions"></div>
      </div>`;

    return page({ title: 'Play', back: true, body }) + `
      <div class="search-overlay" data-el="search" hidden>
        <div class="panel search-card">
          <div class="radar" aria-hidden="true"><i></i><i></i><i></i><b></b></div>
          <div class="search-title" data-el="searchtitle">Finding a lobby</div>
          <div class="search-sub tiny muted" data-el="searchsub"></div>
          <button class="btn btn-ghost btn-block" data-act="cancel-search">Cancel</button>
        </div>
      </div>`;
  }

  /* ------------------------------------------------------------- update --- */

  function q(ctx, sel) { return ctx.el.querySelector(sel); }

  function paintMode(ctx) {
    const m = modeOf(ui.mode);
    for (const b of ctx.el.querySelectorAll('.mode-chip')) {
      b.setAttribute('aria-checked', b.dataset.mode === ui.mode ? 'true' : 'false');
    }
    const blurb = q(ctx, '[data-el="modeblurb"]');
    if (blurb) blurb.textContent = m.blurb;
  }

  function paintBrowser(ctx) {
    const host = q(ctx, '[data-el="roomlist"]');
    const chip = q(ctx, '[data-el="netchip"]');
    if (!host || !chip) return;

    if (ctx.online === null) {
      chip.className = 'chip net-chip';
      chip.textContent = 'Checking…';
      host.innerHTML = skeletonRows();
      return;
    }
    if (!ctx.online) {
      chip.className = 'chip net-chip off';
      chip.textContent = 'Offline';
      host.innerHTML = offlinePanel();
      return;
    }
    // Joinable first, fullest first within that — the server sorts by headcount
    // alone, which would float the unjoinable rooms to the top of the list.
    const rooms = ctx.rooms.slice().sort((a, b) => {
      const af = num(a.players) >= (num(a.max) || 12);
      const bf = num(b.players) >= (num(b.max) || 12);
      return (af - bf) || (num(b.players) - num(a.players));
    });
    chip.className = 'chip net-chip live';
    chip.textContent = rooms.length ? `${rooms.length} live` : 'Connected';
    host.innerHTML = rooms.length
      ? rooms.map(roomRow).join('')
      : `<div class="empty">No public lobbies right now.<br>
           <span class="tiny">Quick Match will start one for you.</span></div>`;
  }

  function paintLobby(ctx) {
    const host = q(ctx, '[data-el="lobby"]');
    if (!host) return;
    const m = modeOf(ui.mode);
    if (!ctx.lobby) {
      host.innerHTML = `
        <h3>Private lobby</h3>
        <p class="tiny muted lobby-intro">Create a lobby and you get a six-character
          code. Anyone you send it to drops straight into your match — it never
          appears in the public browser.</p>
        <div class="lobby-mode tiny"><span class="lm-ico">${esc(m.icon)}</span>${esc(m.name)}</div>`;
      return;
    }
    const l = ctx.lobby;
    const lm = modeOf(l.mode);
    host.innerHTML = `
      <h3>Your lobby is open</h3>
      <div class="code-display" data-el="codedisplay">
        ${MM.normalizeCode(l.code).split('').map((c) => `<span>${esc(c)}</span>`).join('')}
      </div>
      <div class="lobby-meta">
        <span class="chip" style="--cc:${esc(lm.accent)}">${esc(lm.icon)} ${esc(lm.name)}</span>
        <span class="chip${num(l.players) > 0 ? ' live' : ''}">${num(l.players)}/${num(l.max) || 12} in lobby</span>
      </div>
      <div class="lobby-actions">
        <button class="btn btn-ghost" data-act="copy-code">Copy code</button>
        ${canShare() ? '<button class="btn btn-ghost" data-act="share-code">Share</button>' : ''}
        <button class="btn btn-ghost" data-act="new-code">New lobby</button>
      </div>`;
  }

  function paintFriends(ctx) {
    const host = q(ctx, '[data-el="friendlist"]');
    if (!host) return;
    const list = friendList();
    if (!list.length) {
      host.innerHTML = `
        <div class="empty friends-empty">
          <div class="fe-title">No friends added yet</div>
          <p class="tiny">Send someone your code above. When they add it, their
            lobbies show up here and you can drop in with one tap.</p>
        </div>`;
      return;
    }
    host.innerHTML = list.map((f) => friendRow(f, ctx.friendState.get(f.id))).join('');
  }

  function paintBackfill(ctx) {
    const b = backfill();
    const sw = q(ctx, '[data-act="ai-toggle"]');
    const count = q(ctx, '[data-el="aicount"]');
    const step = q(ctx, '[data-el="aistep"]');
    if (sw) sw.setAttribute('aria-checked', b.on ? 'true' : 'false');
    if (count) count.textContent = String(b.count);
    if (step) step.classList.toggle('off', !b.on);
    const minus = q(ctx, '[data-act="ai-minus"]');
    const plus = q(ctx, '[data-act="ai-plus"]');
    if (minus) minus.disabled = !b.on || b.count <= 0;
    if (plus) plus.disabled = !b.on || b.count >= MAX_BOTS;
  }

  const PRIMARY = {
    // Known-offline relabels rather than sending the player into a search that
    // cannot succeed.
    offline: 'Play Offline vs AI',
    quick: 'Quick Match',
    'enter-lobby': 'Enter Lobby',
    'create-lobby': 'Create Private Lobby',
  };

  /**
   * Safe to call on every poll: it only touches the DOM when the button should
   * actually change. Re-creating it unconditionally would swap the node out
   * from under a thumb that is mid-press.
   */
  function paintActions(ctx) {
    const host = q(ctx, '[data-el="actions"]');
    if (!host) return;
    const want = ui.tab === 'public'
      ? (ctx.online === false ? 'offline' : 'quick')
      : (ctx.lobby ? 'enter-lobby' : 'create-lobby');
    if (host.dataset.primary === want) return;
    host.dataset.primary = want;
    host.innerHTML = `<button class="btn btn-lg btn-block" data-act="${want}">${PRIMARY[want]}</button>`;
  }

  function paintTab(ctx) {
    for (const b of ctx.el.querySelectorAll('[data-tab]')) {
      b.setAttribute('aria-selected', b.dataset.tab === ui.tab ? 'true' : 'false');
    }
    for (const p of ctx.el.querySelectorAll('.pane')) {
      p.hidden = p.dataset.pane !== ui.tab;
    }
    paintActions(ctx);
  }

  /* ---------------------------------------------------------- networking --- */

  async function poll(ctx) {
    if (!ctx.alive || ctx.busy) return;
    ctx.busy = true;
    try {
      if (ui.tab === 'public') {
        const rooms = await MM.listRooms();
        if (!ctx.alive) return;
        ctx.online = rooms !== null;
        ctx.rooms = rooms || [];
        paintBrowser(ctx);
        paintActions(ctx);
      } else {
        ctx.ticks++;
        if (ctx.lobby) {
          const r = await MM.probeRoom(ctx.lobby.code);
          if (!ctx.alive) return;
          if (r) {
            ctx.online = true;
            ctx.lobby.players = num(r.players);
            ctx.lobby.max = num(r.max) || 12;
            ctx.lobby.mode = r.mode || ctx.lobby.mode;
          } else if (MM.isOffline()) {
            ctx.online = false;
          }
          paintLobby(ctx);
        }
        // Friends cost one request each, so they refresh at half the rate of
        // everything else. Eight is plenty for a phone lobby list.
        if (ctx.ticks % 2 === 1) await pollFriends(ctx);
      }
    } finally {
      ctx.busy = false;
    }
  }

  async function pollFriends(ctx) {
    const list = friendList().slice(0, 8);
    if (!list.length) { paintFriends(ctx); return; }
    const rooms = await Promise.all(list.map((f) => MM.probeRoom(f.id)));
    if (!ctx.alive) return;
    const off = MM.isOffline();
    for (let i = 0; i < list.length; i++) {
      ctx.friendState.set(list[i].id, { room: rooms[i], unknown: !rooms[i] && off });
    }
    if (!off) ctx.online = true;
    paintFriends(ctx);
  }

  /* ------------------------------------------------------------- search --- */

  function showSearch(ctx, title) {
    const el = q(ctx, '[data-el="search"]');
    if (!el) return;
    ctx.searchStart = Date.now();
    ctx.searchCancelled = false;
    const t = q(ctx, '[data-el="searchtitle"]');
    if (t) t.textContent = title;
    el.hidden = false;
    const sub = q(ctx, '[data-el="searchsub"]');
    const tickSub = () => {
      if (!sub) return;
      const s = Math.floor((Date.now() - ctx.searchStart) / 1000);
      sub.textContent = `${modeOf(ui.mode).name} · ${s}s`;
    };
    tickSub();
    clearInterval(ctx.searchTimer);
    ctx.searchTimer = setInterval(tickSub, 1000);
  }

  function hideSearch(ctx) {
    clearInterval(ctx.searchTimer);
    ctx.searchTimer = null;
    const el = q(ctx, '[data-el="search"]');
    if (el) el.hidden = true;
  }

  async function quickMatch(ctx) {
    showSearch(ctx, 'Finding a lobby');
    const mode = ui.mode;
    const [found] = await Promise.all([
      MM.quickMatch(mode),
      new Promise((r) => { ctx.timers.add(setTimeout(r, MIN_SEARCH_MS)); }),
    ]);
    if (!ctx.alive || ctx.searchCancelled) return;

    if (!found) {
      hideSearch(ctx);
      ctx.online = false;
      ctx.rooms = [];
      paintBrowser(ctx);
      paintActions(ctx);
      shell.toast('No server found — play offline instead', 'bad', 2600);
      return;
    }
    ctx.online = true;
    const t = q(ctx, '[data-el="searchtitle"]');
    if (t) t.textContent = found.created ? 'Opening a lobby' : 'Joining';
    // Let the "Joining" state land before the world build seizes the thread.
    ctx.timers.add(setTimeout(() => {
      if (!ctx.alive || ctx.searchCancelled) return;
      hideSearch(ctx);
      startOnline({ room: found.room, mode: found.mode || mode, code: found.code });
    }, 260));
  }

  /* -------------------------------------------------------- code entry --- */

  function boxes(ctx) { return [...ctx.el.querySelectorAll('.code-box')]; }

  function codeValue(ctx) {
    return MM.normalizeCode(boxes(ctx).map((b) => b.value).join(''));
  }

  function paintCodeState(ctx) {
    const btn = q(ctx, '[data-act="join-code"]');
    if (btn) btn.disabled = codeValue(ctx).length !== MM.CODE_LENGTH || !!ctx.joining;
  }

  function joinMsg(ctx, text, bad) {
    const el = q(ctx, '[data-el="joinmsg"]');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('bad', !!bad);
  }

  /** Spread pasted or fast-typed characters across the boxes from `from`. */
  function fill(ctx, text, from) {
    const chars = MM.normalizeCode(text).split('');
    const bs = boxes(ctx);
    let i = from;
    for (const c of chars) {
      if (i >= bs.length) break;
      bs[i].value = c;
      i++;
    }
    const focus = bs[Math.min(i, bs.length - 1)];
    if (focus) { focus.focus(); focus.select(); }
    paintCodeState(ctx);
  }

  async function joinByCode(ctx) {
    if (ctx.joining) return;
    const code = codeValue(ctx);
    if (code.length !== MM.CODE_LENGTH) { joinMsg(ctx, 'Enter all six characters.', true); return; }
    ctx.joining = true;
    paintCodeState(ctx);
    joinMsg(ctx, 'Checking…', false);
    const room = await MM.probeRoom(code);
    if (!ctx.alive) return;
    ctx.joining = false;
    paintCodeState(ctx);

    if (!room) {
      const offline = MM.isOffline();
      ctx.online = !offline;
      joinMsg(ctx, offline
        ? 'No server found — codes need one to check against.'
        : "That code isn't a live lobby.", true);
      shell.toast(offline ? 'No server found' : "That code isn't a live lobby", 'bad');
      return;
    }
    if (num(room.players) >= (num(room.max) || 12)) {
      joinMsg(ctx, 'That lobby is full.', true);
      return;
    }
    joinMsg(ctx, 'Joining…', false);
    startOnline({ room: room.name || room.code, mode: room.mode, code: room.code });
  }

  /* -------------------------------------------------------------- lobby --- */

  async function createLobby(ctx) {
    const btn = q(ctx, '[data-act="create-lobby"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
    // Ask for the player's own id as the code: "my code" and "my lobby" being
    // the same six characters is what makes the friends list work at all. The
    // server hands back a different one if it is taken.
    const made = await MM.createRoom({
      mode: ui.mode, private: true, code: profile.data.id,
    });
    if (!ctx.alive) return;
    if (!made) {
      ctx.online = false;
      paintActions(ctx);
      shell.toast('No server found — private lobbies need one', 'bad', 2600);
      return;
    }
    ctx.online = true;
    ctx.lobby = { ...made, players: 0, max: 12 };
    paintLobby(ctx);
    paintActions(ctx);
    shell.toast('Lobby created', 'ok');
  }

  async function shareCode(ctx, code) {
    try {
      await navigator.share({
        title: 'MIAMI DEVOUR',
        text: `Join my lobby — code ${code}`,
        url: MM.inviteUrl(code),
      });
    } catch { /* the player dismissed the sheet; nothing to say about it */ }
  }

  /* -------------------------------------------------------------- mount --- */

  function mount(el) {
    const ctx = {
      el,
      alive: true,
      busy: false,
      ticks: 0,
      /** null = not yet known, true/false = last answer from the server. */
      online: null,
      rooms: [],
      lobby: null,
      friendState: new Map(),
      joining: false,
      searchCancelled: false,
      searchTimer: null,
      searchStart: 0,
      timers: new Set(),
      poller: null,
    };
    mounts.set(el, ctx);

    wireNav(el, shell);
    paintMode(ctx);
    paintTab(ctx);
    paintLobby(ctx);
    paintFriends(ctx);
    paintBackfill(ctx);
    paintBrowser(ctx);

    el.addEventListener('click', (e) => onClick(ctx, e));
    el.addEventListener('input', (e) => onInput(ctx, e));
    el.addEventListener('keydown', (e) => onKeyDown(ctx, e));
    el.addEventListener('paste', (e) => onPaste(ctx, e));

    poll(ctx);
    ctx.poller = setInterval(() => poll(ctx), POLL_MS);
  }

  function onClick(ctx, e) {
    const tab = e.target.closest('[data-tab]');
    if (tab && ctx.el.contains(tab)) {
      if (ui.tab !== tab.dataset.tab) {
        ui.tab = tab.dataset.tab;
        ctx.ticks = 0;
        paintTab(ctx);
        poll(ctx);
      }
      return;
    }

    const chip = e.target.closest('.mode-chip');
    if (chip && ctx.el.contains(chip)) {
      ui.mode = modeOf(chip.dataset.mode).id;
      paintMode(ctx);
      if (!ctx.lobby) paintLobby(ctx);
      return;
    }

    const act = e.target.closest('[data-act]');
    if (!act || !ctx.el.contains(act)) return;
    const what = act.dataset.act;

    switch (what) {
      case 'quick':
        quickMatch(ctx);
        break;

      case 'offline':
        startOffline(ui.mode);
        break;

      case 'retry':
        ctx.online = null;
        paintBrowser(ctx);
        MM.health().then((ok) => {
          if (!ctx.alive) return;
          ctx.online = ok;
          paintBrowser(ctx);
          paintActions(ctx);
          if (ok) poll(ctx);
        });
        break;

      case 'join-room': {
        const code = MM.normalizeCode(act.dataset.code);
        const r = ctx.rooms.find((x) => MM.normalizeCode(x.code) === code);
        startOnline({ room: (r && r.name) || code, mode: (r && r.mode) || ui.mode, code });
        break;
      }

      case 'create-lobby':
        createLobby(ctx);
        break;

      case 'enter-lobby':
        if (ctx.lobby) {
          startOnline({ room: ctx.lobby.room, mode: ctx.lobby.mode, code: ctx.lobby.code });
        }
        break;

      case 'new-code':
        ctx.lobby = null;
        paintLobby(ctx);
        paintActions(ctx);
        createLobby(ctx);
        break;

      case 'copy-code':
        if (ctx.lobby) {
          copyText(ctx.lobby.code).then((ok) => {
            if (ctx.alive) shell.toast(ok ? 'Code copied' : 'Copy failed — read it out instead', ok ? 'ok' : 'bad');
          });
        }
        break;

      case 'share-code':
        if (ctx.lobby) shareCode(ctx, ctx.lobby.code);
        break;

      case 'copy-mine':
        copyText(profile.data.id || '').then((ok) => {
          if (ctx.alive) shell.toast(ok ? 'Your code is copied' : 'Copy failed — read it out instead', ok ? 'ok' : 'bad');
        });
        break;

      case 'share-mine':
        shareCode(ctx, profile.data.id || '');
        break;

      case 'join-code':
        joinByCode(ctx);
        break;

      case 'ai-toggle': {
        const b = setBackfill({ on: !backfill().on });
        paintBackfill(ctx);
        shell.toast(b.on ? `Bots on — ${b.count}` : 'Bots off', 'info', 1400);
        break;
      }

      case 'ai-minus':
        setBackfill({ count: backfill().count - 1 });
        paintBackfill(ctx);
        break;

      case 'ai-plus':
        setBackfill({ count: backfill().count + 1 });
        paintBackfill(ctx);
        break;

      case 'cancel-search':
        ctx.searchCancelled = true;
        hideSearch(ctx);
        shell.toast('Search cancelled', 'info', 1400);
        break;

      default:
        break;
    }
  }

  function onInput(ctx, e) {
    const box = e.target.closest('.code-box');
    if (!box || !ctx.el.contains(box)) return;
    const i = Number(box.dataset.i) || 0;
    const raw = MM.normalizeCode(box.value);
    if (raw.length > 1) {
      // Autofill and fast typing both deliver several characters to one box.
      box.value = '';
      fill(ctx, raw, i);
    } else {
      box.value = raw;
      if (raw) {
        const next = boxes(ctx)[i + 1];
        if (next) { next.focus(); next.select(); }
      }
      paintCodeState(ctx);
    }
    joinMsg(ctx, 'Six characters, letters and numbers.', false);
  }

  function onKeyDown(ctx, e) {
    const box = e.target.closest('.code-box');
    if (!box || !ctx.el.contains(box)) return;
    const bs = boxes(ctx);
    const i = Number(box.dataset.i) || 0;
    if (e.key === 'Backspace' && !box.value && bs[i - 1]) {
      e.preventDefault();
      bs[i - 1].value = '';
      bs[i - 1].focus();
      paintCodeState(ctx);
    } else if (e.key === 'ArrowLeft' && bs[i - 1]) {
      e.preventDefault();
      bs[i - 1].focus();
    } else if (e.key === 'ArrowRight' && bs[i + 1]) {
      e.preventDefault();
      bs[i + 1].focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      joinByCode(ctx);
    }
  }

  function onPaste(ctx, e) {
    const box = e.target.closest('.code-box');
    if (!box || !ctx.el.contains(box)) return;
    const text = e.clipboardData && e.clipboardData.getData('text');
    if (!text) return;
    e.preventDefault();
    fill(ctx, text, Number(box.dataset.i) || 0);
  }

  /* ------------------------------------------------------------ unmount --- */

  function unmount(el) {
    const ctx = mounts.get(el);
    if (!ctx) return;
    ctx.alive = false;
    clearInterval(ctx.poller);
    clearInterval(ctx.searchTimer);
    for (const t of ctx.timers) clearTimeout(t);
    ctx.timers.clear();
    mounts.delete(el);
    // The listeners are all on `el`, which the shell drops on the next
    // navigation, so they go with it. Nothing here touches window or document.
  }

  shell.register('play', { title: 'Play', render, mount, unmount });
  return shell;
}
