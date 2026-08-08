/**
 * THE PRE-LOBBY — an in-world waiting room, not a menu.
 *
 * You are standing on Bayfront island in a live camera while this is on screen.
 * So this screen is a HUD: a slim bar pinned to the top, a presence strip down
 * one side, actions along the bottom, and NOTHING in the middle. The world is
 * the background. Anything that has to be readable carries its own small plate
 * rather than putting a sheet of grey over the game.
 *
 * WHAT THIS REPLACED, AND WHY IT LOOKED BROKEN
 * --------------------------------------------
 * The previous version was a column of `.panel` cards. It rendered as three
 * opaque cards drawn ON TOP OF EACH OTHER with the roster's "LOADING…" sitting
 * across the invite code. That was not a layout mistake in this file — it was a
 * cascade one, and it only happened in a BUILT bundle:
 *
 *   src/ui/styles.css declares a global `.panel { position: absolute }` for the
 *   in-match HUD plates. index.html cancels it with `:where(.shell) .panel {
 *   position: relative }`, but that lives in an inline <style> in <head> and
 *   Vite appends the bundled stylesheet AFTER it. Equal specificity (0,1,0),
 *   later wins — so in `dist/` the absolute came back. Five screen sheets carry
 *   their own `[data-screen=…] .panel { position: relative }` and survive it.
 *   prelobby.css did not. Every panel left the flow and stacked at one origin.
 *
 * prelobby.css now carries that line, and this screen no longer leans on
 * `.panel` for anything that has to be laid out — it uses its own `.pl-plate`,
 * positioned by grid areas, which cannot stack whatever `position` it is given.
 *
 * The other half of that class of bug: tokens.css sets `.btn { display:
 * inline-flex }`, and an AUTHOR rule always beats the user-agent's
 * `[hidden] { display: none }`. `startBtn.hidden = true` therefore did nothing
 * and "Start Match" was on screen for every non-host. prelobby.css restores
 * `[hidden]` for this screen; every `.hidden =` in here depends on it.
 *
 * WHAT WAS KEPT
 * -------------
 * The flow is unchanged: name gate, invite code, pushed roster, ready toggle,
 * host start, and the 30 s clock owned by game.js. This file reads that clock,
 * it does not run one.
 *
 * THE INPUT TRAP
 * --------------
 * src/gameplay/input.js listens for keydown on WINDOW, adds every e.code to the
 * held set and preventDefaults the arrows and Space with no target check. A
 * focused text field therefore drives the hole while you type in it. There is a
 * bubble-phase guard on this screen's root — see the keyGuard comment below.
 */

import { esc, wireNav } from '../shell.js';
import '../css/prelobby.css';

const NAME_KEY = 'miami-devour:name';

/** Wait length the countdown ring is drawn against. LOBBY_WAIT in game.js and
 *  LOBBY_MAX_WAIT in server/server.js are both 30; this is only the denominator
 *  for a progress ring, so a mismatch degrades to a full ring, never to a wrong
 *  number. The number itself always comes from the clock. */
const WAIT_SPAN = 30;

/** Under this many seconds the countdown goes urgent: colour AND size AND a
 *  different word, because colour alone is not a signal. */
const URGENT_AT = 10;

/** A lobby wait is 30 s; a match is 150. Anything above this cannot be a lobby
 *  clock, so it is ignored rather than displayed — see readClock(). */
const MAX_SANE_WAIT = 60;

function savedName() {
  try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; }
}
function saveName(n) {
  try { localStorage.setItem(NAME_KEY, n); } catch { /* private mode */ }
}

/** Same rule as everywhere else a name reaches another player's screen. */
function cleanName(raw) {
  return String(raw || '')
    .replace(/[<>&"'`\\ -]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
}

const SUGGESTIONS = [
  'Sinkhole', 'Undertow', 'Riptide', 'Vortex', 'Kraken', 'Abyss',
  'Maw', 'Eclipse', 'Cyclone', 'Nightfall', 'Gulf', 'Zenith',
];

/* ========================================================================= */
/* VIEW                                                                      */
/*                                                                           */
/* Pure string builders, kept free of module state so the harness in          */
/* tools/ can render them without booting the game. Delimited by the markers  */
/* below, which are load-bearing: the offline layout test slices this exact   */
/* source out of this exact file rather than re-implementing it.              */
/* ========================================================================= */

/* __PL_VIEW_START__ */

/**
 * The whole screen. Two mutually exclusive steps — you never see both, so the
 * name gate can be a centred card without competing with the HUD.
 *
 * Every independently positioned region carries `data-pl-panel`. That attribute
 * is the contract the layout assertion is written against: if a region is not
 * marked, it is not proven not to overlap.
 */
function plMarkup(esc2, { code = '', named = false } = {}) {
  return `
    <div class="pl-root">

      <!-- Step 1: the name. The only thing on screen until it is answered, so
           there is nothing for it to collide with. -->
      <section class="pl-gate" data-step="name" ${named ? 'hidden' : ''}>
        <div class="pl-gate-card" data-pl-panel="name-card">
          <div class="pl-gate-k">Before you drop in</div>
          <h2 class="pl-gate-h">Pick a name</h2>
          <p class="pl-gate-s">This is what the other players see above your hole
            and on the scoreboard.</p>
          <div class="pl-gate-row">
            <input class="pl-input" data-name-input maxlength="16" spellcheck="false"
                   autocomplete="off" autocapitalize="words" enterkeyhint="done"
                   aria-label="Your name"
                   placeholder="Your name" value="${esc2(savedName())}" />
            <button class="icon-btn pl-dice" data-act="dice"
                    aria-label="Suggest a random name" title="Random name">&#8635;</button>
          </div>
          <button class="btn btn-block" data-act="confirm-name">Continue</button>
        </div>
      </section>

      <!-- Step 2: the HUD. Grid areas, pinned to the edges. The middle column
           of row 2 is deliberately empty — that hole in the layout IS the view
           of the island, and it is why nothing here may be centred. -->
      <div class="pl-hud" data-step="room" ${named ? '' : 'hidden'}>

        <!-- data-chat-ceiling / data-chat-avoid are src/ui/chat.js's published
             opt-in hooks (its AVOID_SEL and CEIL_SEL). The chat dock is not a
             child of this screen — it mounts to game.uiRoot beside the shell and
             measures itself — so the only way it can know where this HUD's edges
             are is to be told. Tagged: the top bar and the roster cap it from
             above, the hint and the action row push it up from below. Inert if
             chat.js is not present. -->
        <div class="pl-top" data-chat-ceiling>
          <!-- Online: the code you read out to a friend. Hidden solo, where
               there is no room to invite anyone to. -->
          <div class="pl-plate pl-invite" data-codebox data-pl-panel="invite" hidden>
            <span class="pl-invite-k">Invite code</span>
            <span class="pl-invite-v" data-code>${esc2(code || '—')}</span>
            <span class="pl-invite-btns">
              <button class="pl-mini" data-act="copy">Copy code</button>
              <button class="pl-mini" data-act="copy-link">Copy link</button>
            </span>
          </div>

          <!-- Solo: same slot, so the clock stays centred either way. -->
          <div class="pl-plate pl-solo" data-solobox data-pl-panel="solo" hidden>
            <span class="pl-invite-k">Warm-up</span>
            <span class="pl-solo-v">Solo lobby</span>
            <span class="pl-solo-s">The rest of the field fills with AI.</span>
          </div>

          <!-- THE COUNTDOWN. The largest thing on the screen, dead centre of
               the top bar, in its own grid area so nothing can ever be drawn
               over it. It reads game.lobbyLeft through deps.lobbyInfo(). -->
          <div class="pl-plate pl-clockwrap" data-clockwrap data-pl-panel="clock" role="timer">
            <div class="pl-clock-k" data-clock-kicker aria-live="polite">Match starts in</div>
            <div class="pl-clock-n"><b data-clock>--</b><span class="pl-clock-u">s</span></div>
            <div class="pl-clock-track"><i data-clock-fill style="width:100%"></i></div>
          </div>

          <div class="pl-plate pl-fill" data-pl-panel="fill">
            <span class="pl-fill-k">Players</span>
            <span class="pl-fill-v"><b data-count-n>1</b><span data-count-t>/ 15</span></span>
            <span class="pl-fill-bar"><i data-fill style="width:7%"></i></span>
          </div>
        </div>

        <!-- PRESENCE. A compact avatar strip: a column on a desktop, a
             horizontally scrolling row on a phone. It scrolls, it never grows —
             see .pl-strip { min-height: 0; overflow } in the sheet. -->
        <aside class="pl-plate pl-roster" data-pl-panel="roster" data-chat-ceiling>
          <header class="pl-roster-h">
            <span class="pl-roster-t">In the lobby</span>
            <span class="pl-roster-c" data-count>1</span>
          </header>
          <div class="pl-strip" data-players tabindex="0" role="list"
               aria-label="Players in this lobby"></div>
        </aside>

        <!-- Row 2, column 1 is deliberately UNOCCUPIED. That rectangle is the
             window onto Bayfront, and it is where the chat dock floats. Nothing
             may be placed in it. -->

        <div class="pl-foot">
          <p class="pl-hint" data-hint data-pl-panel="hint" data-chat-avoid></p>
          <div class="pl-actions" data-pl-panel="actions" data-chat-avoid>
            <button class="btn btn-ghost pl-leave" data-act="leave">Leave</button>
            <button class="btn pl-ready" data-act="ready">I'm Ready</button>
            <button class="btn btn-sun pl-start" data-act="start" hidden>Start Now</button>
          </div>
        </div>
      </div>
    </div>`;
}

/**
 * One entry per player in the presence strip.
 *
 * "LOADING…" USED TO LIVE HERE, and it is the string in the owner's screenshot.
 * The old row printed `p.loaded ? 'Waiting' : 'Loading…'` through a
 * `text-transform: uppercase`, so a stacked panel dropped the word LOADING
 * across the invite code. It is not a temporary state either: the server sets
 * `client.ready = true` inside its C2S.STATE handler and does NOT call
 * broadcastLobby() there, so the `loaded` flag on the copy of the roster this
 * client holds stays false until something unrelated (a join, a leave, a rename)
 * forces a rebroadcast. On a quiet solo room nothing ever does, and the word sat
 * there for the whole wait.
 *
 * So it is gone as a status word. Presence is now three honest states with their
 * OWN column — Ready / Here / Joining — and "Joining" is never shown for
 * yourself, because you are demonstrably on the island reading this. That is
 * true regardless of what the server's stale flag says, and it costs no server
 * change.
 */
function plRoster(esc2, list, meId, hostId) {
  if (!list.length) {
    return '<div class="pl-strip-empty">Waiting for the room…</div>';
  }
  return list.map((p) => {
    const me = p.id != null && p.id === meId;
    const host = hostId != null && p.id === hostId;
    const hex = typeof p.color === 'number'
      ? `#${p.color.toString(16).padStart(6, '0')}` : '#ff3d8b';
    const name = p.name || 'Player';
    // Ready beats everything; you are always loaded; everyone else is trusted.
    const st = p.armed ? 'ready' : ((me || p.loaded) ? 'here' : 'joining');
    const word = st === 'ready' ? 'Ready' : (st === 'here' ? 'Here' : 'Joining');
    return `<div class="pl-p${me ? ' me' : ''}" role="listitem"
                 title="${esc2(name)}${host ? ' — host' : ''}">
      <span class="pl-av" style="--ac:${hex}" aria-hidden="true">${esc2(name.slice(0, 1).toUpperCase())}</span>
      <span class="pl-p-nm">${esc2(name)}</span>
      ${me ? '<span class="pl-tag you">You</span>' : ''}
      ${host ? '<span class="pl-tag host">Host</span>' : ''}
      <span class="pl-p-st ${st}"><i aria-hidden="true"></i>${word}</span>
    </div>`;
  }).join('');
}

/* __PL_VIEW_END__ */

/* ========================================================================= */
/* THE LAYOUT ASSERTION                                                      */
/* ========================================================================= */

/* __PL_SELFTEST_START__ */

/**
 * Prove the headline bug cannot come back.
 *
 * Measures getBoundingClientRect() on every `[data-pl-panel]` that is actually
 * rendered and asserts that no two of them intersect, that none of them is off
 * the viewport, and that every control still clears the 44 px tap floor.
 *
 * Run it at more than one size — 1920x1080 and 375x812 are the two the layout
 * is designed against:
 *
 *   __selftest()                                  // whatever the window is now
 *   __selftest(null, { also: ['#chat-layer'] })   // fold in a foreign overlay
 *
 * `data-pl-panel` is searched across the WHOLE DOCUMENT, not just this screen.
 * Anything drawn over the pre-lobby by another module can therefore opt into
 * this assertion by carrying the attribute, and `opts.also` covers overlays that
 * cannot be edited. Only one screen is ever mounted, so the wide query is safe.
 *
 * Call it after the screen has settled: `.screen-page` animates in over 0.26 s
 * with a translateX, and every rect is offset for the duration.
 *
 * @param {HTMLElement} [root] defaults to the mounted pre-lobby
 * @param {{also?:string[]}} [opts] extra selectors to include in the assertion
 * @returns {{ok:boolean, viewport:{w:number,h:number}, panels:object[],
 *            overlaps:object[], offscreen:string[], smallTaps:object[]}}
 */
function plSelftest(root, opts) {
  const host = root || document.querySelector('[data-screen="prelobby"]');
  if (!host) return { ok: false, error: 'no pre-lobby mounted', viewport: null, panels: [], overlaps: [], offscreen: [], smallTaps: [] };

  /* REFUSE TO MEASURE A MOVING TARGET.
     `.screen-page` animates in over 0.26 s — pg-fade is `transform:
     scale(0.985)`, pg-in is a translateX. Called during it, every rect is
     skewed: a run at 1920x1080 reported three 43.3 px buttons (44 x 0.985) and
     panel origins 11 px off, which reads as a layout bug and is not one. A
     caller that gets `settling: true` should wait a frame or two and ask again,
     not treat the numbers as real. */
  const pageEl = host.closest ? (host.closest('.screen-page') || host) : host;
  const tf = getComputedStyle(pageEl).transform;
  if (tf && tf !== 'none' && tf !== 'matrix(1, 0, 0, 1, 0, 0)') {
    return {
      ok: false, settling: true, transform: tf,
      error: 'screen is still animating in — measure again after ~300ms',
      viewport: { w: window.innerWidth, h: window.innerHeight },
      panels: [], overlaps: [], offscreen: [], smallTaps: [],
    };
  }

  const vw = window.innerWidth, vh = window.innerHeight;
  /* Sub-pixel tolerance. Grid tracks land on fractional pixels at a fractional
     --ui-scale, and two boxes sharing an edge at x=740.6663 must not read as an
     overlap. Anything a person could SEE is far above this. */
  const EPS = 0.5;

  const seen = new Set();
  const candidates = [...document.querySelectorAll('[data-pl-panel]')];
  for (const sel of (opts && opts.also) || []) {
    for (const el of document.querySelectorAll(sel)) candidates.push(el);
  }

  const panels = [];
  for (const el of candidates) {
    if (seen.has(el)) continue;
    seen.add(el);
    // A hidden or collapsed region has no geometry to collide with. Checked by
    // measurement, not by reading the `hidden` attribute — the whole point is
    // to catch a case where `hidden` was overridden by the cascade.
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    panels.push({
      name: el.getAttribute('data-pl-panel') || el.id || el.className || el.tagName,
      x: +r.left.toFixed(2), y: +r.top.toFixed(2),
      w: +r.width.toFixed(2), h: +r.height.toFixed(2),
      right: r.right, bottom: r.bottom,
    });
  }

  const overlaps = [];
  for (let i = 0; i < panels.length; i++) {
    for (let j = i + 1; j < panels.length; j++) {
      const a = panels[i], b = panels[j];
      const ow = Math.min(a.right, b.right) - Math.max(a.x, b.x);
      const oh = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
      if (ow > EPS && oh > EPS) {
        overlaps.push({ a: a.name, b: b.name, w: +ow.toFixed(2), h: +oh.toFixed(2) });
      }
    }
  }

  const offscreen = panels
    .filter((p) => p.x < -EPS || p.y < -EPS || p.right > vw + EPS || p.bottom > vh + EPS)
    .map((p) => `${p.name} [${p.x},${p.y} ${p.w}x${p.h}]`);

  // The 44 px floor is a real px floor, not an em one: an em floor shrinks
  // below the minimum exactly where it matters, on a small phone.
  const smallTaps = [];
  for (const b of host.querySelectorAll('button, input, [role="button"]')) {
    const r = b.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.height < 43.5 || r.width < 43.5) {
      smallTaps.push({ el: b.className || b.tagName, w: +r.width.toFixed(1), h: +r.height.toFixed(1) });
    }
  }

  return {
    ok: overlaps.length === 0 && offscreen.length === 0 && smallTaps.length === 0,
    viewport: { w: vw, h: vh },
    panels: panels.map((p) => ({ name: p.name, x: p.x, y: p.y, w: p.w, h: p.h })),
    overlaps,
    offscreen,
    smallTaps,
  };
}

/* __PL_SELFTEST_END__ */

export { plSelftest as __selftest };
export { plMarkup as __markup, plRoster as __roster };

/* ========================================================================= */
/* SCREEN                                                                    */
/* ========================================================================= */

export function registerPrelobby(shell, deps = {}) {
  const net = () => (deps.net && deps.net()) || null;

  shell.register('prelobby', {
    title: 'Lobby',
    /* No page chrome. There is no back button out of a waiting room, and a
       title bar reading "Lobby" over a live island is a menu telling you it is
       a menu. The sheet lays this out edge to edge instead. */
    fullBleed: true,

    render({ params }) {
      const code = String((params && params.code) || (deps.code && deps.code()) || '');
      return plMarkup(esc, { code, named: !!savedName() });
    },

    mount(root, { shell: sh }) {
      /* ---- state, ALL of it, before anything that closes over it ---------
         Four temporal-dead-zone bugs have shipped in this project, one of them
         in this very file: `info` was read by paint() from a `const` declared
         further down, paint() threw on its first call, and because paint() ran
         BEFORE the click listener was attached the listener was never attached
         at all — a dead Continue button with no visible error. Every binding
         this screen has is declared here, at the top, and the helpers below are
         `function` declarations, which are hoisted AND initialised. Nothing in
         this mount can be reached before it exists. */
      let armed = false;
      let rosterSig = '';
      let lastLeft = null;
      let clockSpan = WAIT_SPAN;
      let fullTimer = null;
      let clockTimer = null;

      const $ = (s) => root.querySelector(s);
      const input = $('[data-name-input]');

      /* ---- helpers ------------------------------------------------------ */

      function showRoom() {
        const gate = $('[data-step="name"]');
        const hud = $('[data-step="room"]');
        if (gate) gate.hidden = true;
        if (hud) hud.hidden = false;
      }

      function commitName() {
        if (!input) return;
        const n = cleanName(input.value) || SUGGESTIONS[(Math.random() * SUGGESTIONS.length) | 0];
        saveName(n);
        const c = net();
        if (c && c.rename) c.rename(n);
        if (deps.onName) deps.onName(n);
        showRoom();
        safePaint();
      }

      /**
       * The freshest honest reading of the ONE clock. Never a second clock:
       * offline this is game.lobbyLeft (via deps.lobbyInfo), online it is the
       * server's own countdown.
       *
       * Online it prefers net.serverTimeLeft over net.lobby.waitLeft because
       * `waitLeft` only changes when the server rebroadcasts the LOBBY message
       * — on a join, a leave, a rename or a ready toggle — while snapshots carry
       * a fresh `timeLeft` several times a second. Reading the stale one made
       * the countdown sit still for the whole wait in a quiet room.
       *
       * The <= MAX_SANE_WAIT gate is a sanity envelope, not a preference: a
       * match clock is 150 s and must never be mistaken for a lobby clock if the
       * phase flag is ever behind.
       */
      function readClock(info) {
        const c = net();
        if (c && c.phase === 'lobby' && typeof c.serverTimeLeft === 'number') {
          const fromServer = Math.ceil(c.serverTimeLeft);
          if (fromServer >= 0 && fromServer <= MAX_SANE_WAIT) return fromServer;
        }
        if (info && info.left != null) return Math.max(0, Math.ceil(info.left));
        return null;
      }

      /** Clock only. Cheap enough to run four times a second. */
      function paintClock() {
        const info = (deps.lobbyInfo && deps.lobbyInfo()) || null;
        const left = readClock(info);
        if (left === lastLeft) return;
        lastLeft = left;

        const wrap = $('[data-clockwrap]');
        const n = $('[data-clock]');
        const k = $('[data-clock-kicker]');
        const fill = $('[data-clock-fill]');
        if (n) n.textContent = left == null ? '--' : String(left);
        // The ring is drawn against the largest value we have actually seen, so
        // it is still honest if the wait length ever changes.
        if (left != null && left > clockSpan) clockSpan = left;
        if (fill) {
          const pct = left == null ? 100 : Math.max(0, Math.min(100, (left / Math.max(1, clockSpan)) * 100));
          fill.style.width = `${pct}%`;
        }
        const urgent = left != null && left <= URGENT_AT;
        if (wrap) {
          wrap.classList.toggle('urgent', urgent);
          wrap.classList.toggle('idle', left == null);
        }
        // Colour is never the only signal: the word changes too, and the digits
        // physically grow (font-size, not transform, so the plate's box grows
        // downward and can never be pushed over a neighbour).
        if (k) k.textContent = left == null ? 'Waiting for the room' : (urgent ? 'Final seconds' : 'Match starts in');
      }

      /** Roster, counts, buttons, hint. Once a second, plus every server push. */
      function paint() {
        const c = net();
        const st = (c && c.lobby) || null;
        const me = c ? c.id : null;
        const info = (deps.lobbyInfo && deps.lobbyInfo()) || null;
        const online = !!(info && info.online);
        const target = (info && info.target) || (st && st.target) || 15;

        /* Offline there is no roster to push, and "Connecting…" was a lie —
           nothing is connecting. You are the one player who is definitely here,
           so say so and let the hint explain the AI backfill. */
        const list = st && Array.isArray(st.players) && st.players.length
          ? st.players
          : (online ? [] : [{ id: -1, name: savedName() || 'You', color: 0xff3d8b, armed, loaded: true }]);
        const meId = online ? me : -1;
        const hostId = st ? st.hostId : null;

        const box = $('[data-players]');
        if (box) {
          /* Rebuild only when something actually changed. A blind innerHTML
             every second threw away the strip's scroll position, which on a
             phone means a roster you cannot read past the third name. */
          const sig = `${meId}|${hostId}|${list.map((p) => `${p.id}:${p.name}:${p.armed ? 1 : 0}:${p.loaded ? 1 : 0}`).join(',')}`;
          if (sig !== rosterSig) {
            rosterSig = sig;
            box.innerHTML = plRoster(esc, list, meId, hostId);
          }
        }

        const count = $('[data-count]');
        if (count) count.textContent = `${list.length}/${target}`;

        const isHost = !!(st && me != null && st.hostId === me);

        const startBtn = $('[data-act="start"]');
        const readyBtn = $('[data-act="ready"]');
        if (readyBtn) {
          // With a launch clock running, "ready" decides nothing — the useful
          // control is skipping the wait, and that is the host's button.
          readyBtn.hidden = isHost;
          readyBtn.textContent = armed ? "I'm Not Ready" : "I'm Ready";
          readyBtn.classList.toggle('btn-ghost', armed);
          readyBtn.setAttribute('aria-pressed', armed ? 'true' : 'false');
        }
        if (startBtn) startBtn.hidden = online && !isHost;

        if (info) {
          const cn = $('[data-count-n]'), ct = $('[data-count-t]'), fill = $('[data-fill]');
          if (cn) cn.textContent = String(info.count);
          if (ct) ct.textContent = `/ ${target}`;
          if (fill) fill.style.width = `${Math.max(6, Math.min(100, (info.count / Math.max(1, target)) * 100))}%`;
          const codebox = $('[data-codebox]');
          const solobox = $('[data-solobox]');
          // Solo play has no room to invite anyone to, but the slot still has to
          // hold SOMETHING or the clock stops being centred.
          if (codebox) codebox.hidden = !online;
          if (solobox) solobox.hidden = online;
        }

        const hint = $('[data-hint]');
        if (hint) {
          const others = Math.max(0, list.length - 1);
          hint.textContent = !online
            ? 'Warming up on Bayfront. Move around — nothing here is edible.'
            : (isHost
              ? (others
                ? `${others} other player${others === 1 ? '' : 's'} here. Start whenever you like.`
                : 'Share the code to pull a friend in. You can start alone; the rest fill with AI.')
              : 'Waiting for the host to start the match.');
        }

        paintClock();
      }

      /**
       * Is this screen actually on screen?
       *
       * game.js#startMatch calls meta.hide() WITHOUT navigating (game.js:892),
       * so the pre-lobby stays mounted, `display:none`, for the whole match and
       * its timers keep firing. Harmless at one paint a second; less so now
       * that the clock is sampled four times a second. Cheap DOM walk, no
       * layout — `.shell-hidden` is on the shell root above us.
       */
      function live() {
        return !!(root.isConnected && !root.closest('.shell-hidden'));
      }

      /** paint(), but a failure can never take the screen's controls with it. */
      function safePaint() {
        if (!live()) return;
        try { paint(); } catch (e) { console.error('[prelobby] paint failed', e); }
      }
      function safeClock() {
        if (!live()) return;
        try { paintClock(); } catch (e) { console.error('[prelobby] clock failed', e); }
      }

      /* ---- wiring -------------------------------------------------------- */

      wireNav(root, sh);

      /* THE INPUT GUARD. Bubble phase on this screen's own root, so it runs
         before input.js's window listener sees the key — the same shape as
         HUD#_installAudioSettings.

         Scoped to things you TYPE into, deliberately. input.js adds every
         e.code to its held set with no target check, so typing "was" in the
         name box drives the hole off underneath the panel, Space does not
         insert a space and the arrows do not move the caret. But a guard on the
         whole root would also swallow the arrows while a BUTTON has focus,
         which would stop you steering the moment you tapped "I'm Ready" — so
         the guard asks whether the target is a text entry rather than assuming.
         `[data-pl-keycapture]` is the opt-in for anything focusable added to
         THIS subtree later. The chat box is not covered here and does not need
         to be: it mounts outside the shell and guards itself.

         Escape is let through so the pause menu still works. keyUP is never
         guarded, and must not be: a key pressed before the field was focused
         and released after it would otherwise stay latched forever and the hole
         would drive off on its own. */
      const keyGuard = (e) => {
        if (e.key === 'Escape') return;
        const t = e.target;
        if (!t || !t.tagName) return;
        const tag = t.tagName;
        const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
          || t.isContentEditable === true
          || (typeof t.closest === 'function' && !!t.closest('[data-pl-keycapture]'));
        if (typing) e.stopPropagation();
      };
      root.addEventListener('keydown', keyGuard);

      // Pushed, not polled: a friend appears the moment they connect.
      const c0 = net();
      if (c0) c0.onLobby = () => safePaint();

      // If a name was already chosen on a previous visit, tell the server about
      // it anyway — the socket connected before this screen existed and the
      // server is still calling us "Player 2".
      if (savedName() && c0 && c0.rename) c0.rename(savedName());

      /* Wire the CONTROLS BEFORE the first paint, and never let a paint failure
         escape. Painting is decoration; the buttons are the screen. Getting
         this order wrong once already shipped a dead Continue button. */
      root.addEventListener('click', async (e) => {
        const b = e.target.closest && e.target.closest('[data-act]');
        if (!b) return;
        const act = b.dataset.act;
        const c = net();
        if (act === 'dice') {
          if (input) input.value = SUGGESTIONS[(Math.random() * SUGGESTIONS.length) | 0];
          return;
        }
        if (act === 'confirm-name') { commitName(); return; }
        if (act === 'copy' || act === 'copy-link') {
          const el = $('[data-code]');
          const code = ((el && el.textContent) || '').trim();
          const text = act === 'copy' ? code : `${location.origin}/?room=${encodeURIComponent(code)}`;
          try { await navigator.clipboard.writeText(text); sh.toast('Copied', 'ok'); }
          catch { sh.toast(text, 'info', 6000); }
          return;
        }
        if (act === 'ready') {
          armed = !armed;
          if (c && c.setReady) c.setReady(armed);
          // Offline the roster is synthesised from `armed`, so force a rebuild.
          rosterSig = '';
          safePaint();
          return;
        }
        if (act === 'start') { if (deps.onStartNow) deps.onStartNow(); return; }
        if (act === 'leave') { if (deps.onLeave) deps.onLeave(); }
      });

      if (input) {
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') commitName();
        });
      }

      safePaint();
      /* Two cadences on purpose. The roster is a DOM rebuild and belongs on the
         slow one; the countdown is one text node and is the most important
         thing on the screen, so it is sampled often enough that it can never
         sit a whole second behind the clock it is reading. Neither is a clock —
         both only READ game.lobbyLeft. */
      fullTimer = setInterval(safePaint, 1000);
      clockTimer = setInterval(safeClock, 250);
      root.__plTimer = fullTimer;
      root.__plClockTimer = clockTimer;
      root.__plKeyGuard = keyGuard;
    },

    unmount(root) {
      const c = net();
      if (c) c.onLobby = null;
      if (!root) return;
      if (root.__plTimer) { clearInterval(root.__plTimer); root.__plTimer = null; }
      if (root.__plClockTimer) { clearInterval(root.__plClockTimer); root.__plClockTimer = null; }
      if (root.__plKeyGuard) { root.removeEventListener('keydown', root.__plKeyGuard); root.__plKeyGuard = null; }
    },
  });
}
