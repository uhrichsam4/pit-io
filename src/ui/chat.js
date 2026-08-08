/**
 * IN-GAME CHAT — press T, say something, see what everyone else said.
 *
 * Works in the PRE-LOBBY and DURING A MATCH. It is one surface with one key,
 * not a waiting-room feature: the owner asked for "a game chat thing", and a
 * chat that disappears when the round starts is a lobby widget wearing a
 * costume.
 *
 * ---------------------------------------------------------------------------
 * MOUNTING — the whole integration surface
 *
 *   import { mount as mountChat } from './ui/chat.js';
 *   const chat = mountChat(game.uiRoot, api);
 *   ...
 *   chat.unmount();
 *
 * `root` must be #ui-root, NOT #hud-layer. game.js drives HUD visibility by
 * writing `hud.root.style.opacity = '0'` (game.js:1461, :1507, :1552) and it
 * does that for the whole time the player is standing on the Bayfront island —
 * which is exactly when this chat has to be readable. Mounted inside the HUD
 * layer the chat would be invisible in the pre-lobby, i.e. broken in half the
 * places it was asked for. The layer therefore sets its own
 * `font-size: calc(16px * var(--s, 1))` so the em model matches the HUD's
 * anyway (the same trade phone-ui.js makes; see phone.css).
 *
 * API — every hook OPTIONAL. The chat is fully usable with `api` undefined.
 *   api.me()        -> {name, color}   who the local player is, read per send
 *   api.input       the gameplay Input instance. `input.reset()` is called when
 *                   the box opens — see THE INPUT TRAP; a key held at that
 *                   moment never had its keydown blocked and would otherwise
 *                   stay latched in `keys` while the player types.
 *   api.onSend(text, msg)   a locally accepted message. Attach a transport here.
 *   api.onOpen() / api.onClose()
 *   api.isActive()  -> boolean. When false the layer is hidden. Without it the
 *                   built-in rule is used: hidden while the meta shell is
 *                   showing a screen other than 'prelobby' (shell.js stamps
 *                   `el.dataset.screen`, shell.js:180), visible otherwise.
 *
 * CONTROLLER (what mount() returns)
 *   open() . close() . toggle() . isOpen()
 *   send(text) -> boolean          the local player says something
 *   receive({from, text, color, kind, me}) -> boolean   a message from anywhere
 *   system(text) -> boolean        a grey house line
 *   clear() . setVisible(on) . visible()
 *   count() -> messages retained . stats() -> counters
 *   el . unmount()
 *
 * ---------------------------------------------------------------------------
 * MULTIPLAYER — NOT WIRED, AND DELIBERATELY SO
 *
 * Protocol v4 (src/net/protocol.js, read through src/net/client.js) has no chat
 * message. C2S is HELLO STATE ATE CLAIM_KILL PING READY START RENAME; S2C is
 * WELCOME SNAPSHOT CONSUMED JOIN LEAVE KILL MATCH LOBBY PONG ERROR. Inventing a
 * client-side CHAT frame would be a message the server drops on the floor —
 * silently, because `_handle()`'s switch ends in a bare `default: break`
 * (client.js:167). So this file ships the LOCAL path complete and stops at the
 * transport boundary: `send()` renders and then calls `api.onSend`, and
 * `receive()` renders whatever a transport hands it. Cross-player chat needs a
 * CHAT verb added to protocol.js AND relayed by server/server.js, and neither
 * of those is this file's to write.
 *
 * ---------------------------------------------------------------------------
 * THE INPUT TRAP — the actual engineering problem here
 *
 * src/gameplay/input.js:74-91 listens for keydown on WINDOW and does two things
 * with NO target check:
 *
 *   this.keys.add(e.code)                    // for EVERY key
 *   arrows and Space get e.preventDefault()  // and it skips e.repeat
 *
 * For a text field that is not one bug, it is four:
 *   1. Space never reaches the field, so a sentence has no gaps.
 *   2. Arrows never move the caret; worse, a HELD arrow works and a TAP does
 *      not, because the preventDefault is skipped on `e.repeat`.
 *   3. W A S D are movement keys. Typing the word "was" DRIVES THE HOLE while
 *      the player types — the part the audio mixer never had to face, because a
 *      volume slider takes no letters.
 *   4. game.js:547 starts a match on Space when the phase is MENU and the meta
 *      layer is hidden. A space bar that reaches window can begin the round
 *      from inside a half-typed message.
 *
 * THE FIX is the one hud.js already carries (`_panelKeyGuard`, hud.js:1543) and
 * phone-ui.js copied (`_installKeyGuard`, phone-ui.js:1072): a BUBBLE-phase
 * keydown listener on this layer's own root that stopPropagation()s the keys.
 * It works because window is the LAST hop of the bubble phase, so stopping the
 * event at a descendant means input.js's listener is never called at all.
 *
 * Two things are different here and both are deliberate:
 *
 *   . While the field has focus the guard stops EVERY key, not just the arrows
 *     and Space. `keys.add(e.code)` runs for all of them and W/A/S/D steer. The
 *     audio panel's narrower guard would leave the hole driving.
 *   . keyup is NEVER stopped. input.js clears a key on keyup (`ku`,
 *     input.js:86); swallowing that would strand any key that was already down
 *     when the box opened, and the hole would drive into the bay for ever.
 *     Blocked keydown plus allowed keyup means the held-key set can only
 *     shrink, which is the safe direction.
 *
 * Escape is handled by a CAPTURE listener on window instead, for the reason
 * phone-ui.js:1094 writes down: game.js registered its pause-menu keydown on
 * window first (game.js:557) and a bubble listener added later cannot get in
 * front of it. So the first Escape closes the chat and is swallowed; the second
 * one reaches game.js and opens the pause menu.
 *
 * T is opened from that same capture listener, and the listener returns early
 * whenever the event target is an editable element that is not this one — the
 * pre-lobby and lobby name fields both contain the letter T and neither of them
 * is going to lose it to this file.
 *
 * ---------------------------------------------------------------------------
 * GEOMETRY — WHY THE DOCK SITS WHERE IT SITS
 *
 * The left column is already full. Measured in this repo, at 375x812 (--s 0.78,
 * 1em = 12.48px) and at 1280x800 (--s 0.853, 1em = 13.65px), distances given
 * from the BOTTOM of the viewport:
 *
 *                       375x812              1280x800
 *   #hud-size          13 .. 100 px         14 .. 110 px   (bottom-left meter)
 *   #phone-rail       161 .. 205 px        176 .. 220 px   (the phone button)
 *   #hud-feed      top-left, bottom edge at 778 / 763 px   (the kill feed)
 *   #hud-map           13 .. 155 px, x 220..362 / 1110..1266  (bottom-RIGHT)
 *
 * The gap between the size meter and the phone rail is 61 px on a phone and
 * 66 px on a desktop. That is three lines of chat and no input box, so docking
 * there and expanding on open would put an opaque panel straight over the phone
 * button — precisely the failure the owner sent a screenshot of.
 *
 * So the dock's floor is the TOP of the highest visible occupant of its own
 * column, plus 8 px: 213 px on a phone, 228 px on a desktop. Closed and open
 * use the SAME floor, so nothing jumps when the box opens; it only grows
 * upward, and its ceiling is the bottom edge of whatever is overhead — the kill
 * feed in a match, the pre-lobby's own panels in the waiting room. Measured
 * with a full 40-line log open: the dock is 312x209 at 375x812 and 341x381 at
 * 1280x800, and intersects ZERO of the 14 elements the HUD and the meta shell
 * are painting at that moment.
 *
 * Nothing here is a hardcoded guess. Occupants are re-measured on every change
 * to the shell's DOM and at 4 Hz besides, so if the phone rail is hidden the
 * floor drops on its own; `data-chat-avoid` and `data-chat-ceiling` are the
 * published opt-in for anything this file cannot know about.
 *
 * AND IF THERE IS NO ROOM, THERE IS NO CHAT. When the surviving band cannot
 * hold the control row and one line, the layer hides itself until it can. That
 * is the correct answer, not a degraded one: something else owns the column,
 * and a chat drawn over it is the exact failure this task exists to fix. It is
 * also why the chat can be absent on a small screen behind a full-width modal
 * card, and back the moment the card is answered.
 *
 * An element at `opacity: 0` still occupies layout, so visibility is decided by
 * walking up for an INLINE `style.opacity === '0'` (which is how game.js hides
 * the HUD) and for display:none / visibility:hidden. COMPUTED opacity is
 * deliberately not used: this project's headless harness does not advance CSS
 * transitions, so #hud-layer reads `opacity: 0` mid-match there while being
 * fully visible in a real browser (phone.css says the same about animations).
 *
 * MOBILE. The virtual keyboard is measured off `window.visualViewport` and
 * added to the floor, so the input box is never underneath it. There is no T
 * key on a phone, so the closed state is a real 44 px CHAT button in the same
 * slot the input box takes when open — one control row, no reflow.
 *
 * ---------------------------------------------------------------------------
 * SAFETY
 *
 * . Message text and player names NEVER touch innerHTML. Rows are built with
 *   createElement and written with textContent, which is escaping by
 *   construction rather than escaping by remembering. `esc()` below exists for
 *   the one static template in `_shell()` and is used nowhere else; hud.js's
 *   `escapeHtml` (hud.js:206) and shell.js's `esc` (shell.js:305) are the same
 *   primitive for the same reason.
 * . Text is capped at MAX_LEN (120) characters, control characters and bidi
 *   overrides are stripped (U+202E alone can reverse a whole rendered line),
 *   and whitespace is collapsed.
 * . Sending is rate limited: a 5-token bucket refilling one token every 1.5 s,
 *   plus a 350 ms floor between two sends. Over the limit the message is
 *   dropped and the player is told once per bucket.
 * . The feed is capped at MAX_MSGS (60) rows, so a hostile or looping transport
 *   cannot grow the DOM without bound.
 * . Colours arriving from outside are validated against a hex pattern before
 *   they are written to a custom property.
 *
 * ACCESSIBILITY. Colour is never the only signal: every line prints its
 * sender's NAME, system lines carry the word "system" as their author plus a
 * distinct glyph, and the character counter is a NUMBER. The log is a
 * `role="log"` live region, focus is visible on every control, every tap target
 * carries a 44 px floor (not an em one — --s bottoms out at 0.78 and 2.6em of
 * that is 32 px), and every animation is off under prefers-reduced-motion.
 */

/* Same reason hud.js and phone-ui.js import their own sheets: index.html
   hand-links every other css/*.css and will never know about this one, and an
   unstyled chat is a column of full-width text across the play area. */
import './css/chat.css';

/* ==========================================================================
 * CONSTANTS  (module scope, above every use — this project has shipped four
 * temporal-dead-zone bugs and `node --check` catches none of them)
 * ======================================================================== */

/** Mirrored by --ch-tap in chat.css so a test can assert one number. */
export const TAP_PX = 44;
/** Longest message a player can send. Also the input's maxlength. */
export const MAX_LEN = 120;
/** Longest sender name rendered. Longer names are cut, not wrapped. */
export const MAX_NAME = 18;

/** Rows retained in the DOM. The scrollback ceiling, and the memory ceiling. */
const MAX_MSGS = 60;
/** Seconds before a line fades out of the closed view. Still in scrollback. */
const FADE_AFTER = 10;

/** Rate limit: bucket size, seconds per token, and a hard floor between sends. */
const BURST = 5;
const REFILL_S = 1.5;
const MIN_GAP_S = 0.35;

/** The one timer: visibility, geometry and the fade sweep. 4 Hz, like hud.js. */
const TICK_MS = 250;

/** Clearance kept from whatever the dock is avoiding. */
const GAP_PX = 8;
/** Share of the viewport the open log may take, and the closed one. */
const OPEN_VH = 0.42;
const CLOSED_VH = 0.30;
/** Never collapse below this, whatever the measurement says. */
const MIN_LOG_PX = 44;

/**
 * Everything the dock gets out of the way of.
 *
 * The HUD ids are grep-verified against src/ui/styles.css and phone.css. The
 * four shell classes are the meta layer's own card primitives — `.panel`
 * (tokens.css:190), `.modal-card` (:538), `.empty-state` (:568) and
 * `.sticky-actions` (:632) — so a screen built out of the shell's parts is
 * avoided without this file knowing anything about that screen. `.shell-modal`
 * is deliberately NOT here: it is a full-viewport backdrop, and its card is.
 *
 * `data-chat-avoid` is the opt-in for anything that is neither, which is the
 * hook a redesigned pre-lobby HUD should reach for if it draws its own
 * furniture in the bottom-left column.
 *
 * Floor or ceiling is decided by geometry, not by which list an element is in
 * — see _measure(). The split is kept only because the two names document what
 * each entry is normally doing.
 */
const AVOID_SEL = '#hud-size, #hud-tierup, #phone-rail, #hud-map, '
  + '.shell .sticky-actions, [data-chat-avoid]';
const CEIL_SEL = '#hud-feed, .shell .panel, .shell .modal-card, .shell .empty-state, '
  + '[data-chat-ceiling]';

/** Meta screens the chat stays on top of when api.isActive is not supplied. */
const SHELL_OK = new Set(['prelobby']);

/** Fallback sender colour: the HUD's aqua. */
const FALLBACK_COLOR = '#37e6d5';
/** System lines. Grey on purpose — house voice, not a player. */
const SYSTEM_COLOR = '#9fb0c9';

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/* C0 and C1 controls, zero-width marks and the bidi overrides. U+202E on its
   own can reverse an entire rendered line, which is a real chat abuse and not
   a theoretical one. Written as escapes: literal control characters inside a
   regex literal are invisible in review and one of them is a newline. */
const NASTY_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

/* ==========================================================================
 * HELPERS
 * ======================================================================== */

/**
 * Escape untrusted text before it goes anywhere near innerHTML.
 *
 * Used by `_shell()` and by nothing else: every message and every name in this
 * file is written with textContent instead. Kept because a future edit that
 * reaches for innerHTML should find the tool sitting right here rather than
 * decide it does not need one. Mirrors hud.js:206 and shell.js:305.
 */
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
  ));
}

/** Strip the dangerous, collapse the ugly, cap the length. */
function cleanText(raw) {
  return String(raw == null ? '' : raw)
    .replace(NASTY_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LEN);
}

/** Same treatment for a name, with its own cap. */
function cleanName(raw) {
  const n = String(raw == null ? '' : raw)
    .replace(NASTY_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
  return n || 'Player';
}

/**
 * A colour this file is willing to write into a custom property.
 * Accepts '#rgb' / '#rrggbb' strings and THREE-style integers (0xff3d8b).
 */
function cleanColor(c) {
  if (typeof c === 'number' && Number.isFinite(c)) {
    return `#${((c >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`;
  }
  const s = String(c == null ? '' : c).trim();
  return HEX_RE.test(s) ? s : FALLBACK_COLOR;
}

/** Is the event going to a field where somebody is legitimately typing? */
function isEditable(el) {
  if (!el || !el.tagName) return false;
  const t = el.tagName;
  if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return true;
  return el.isContentEditable === true;
}

/**
 * Is this element actually on screen?
 *
 * NOT a computed-opacity test. game.js hides the HUD by writing an INLINE
 * `style.opacity = '0'` on #hud-layer, which is exact and cheap to read; the
 * computed value is unreliable in this project's headless harness, where CSS
 * transitions never advance and #hud-layer therefore reports opacity 0 during
 * a match it is fully visible in. Reading the inline property up the chain
 * catches the real mechanism and ignores the artifact.
 */
function onScreen(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const view = el.ownerDocument && el.ownerDocument.defaultView;
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n.style && n.style.opacity === '0') return false;
    if (n.hasAttribute && n.hasAttribute('hidden')) return false;
    const cs = view && view.getComputedStyle(n);
    if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
  }
  return true;
}

/** Monotonic seconds. */
function nowS() {
  return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
}

/* ==========================================================================
 * CHAT
 * ======================================================================== */

class Chat {
  /**
   * @param {HTMLElement} root  #ui-root — see MOUNTING above
   * @param {object|null} api
   */
  constructor(root, api = null) {
    this.api = api || null;
    this._open = false;
    this._destroyed = false;
    /** setVisible() override. null = follow api.isActive / the built-in rule. */
    this._forced = null;
    this._shown = true;
    /** Written by _measure(): is there a column to draw in at all? */
    this._room = true;

    /** Rows currently in the DOM, oldest first: {el, at, faded}. */
    this._msgs = [];
    /** Last value written for each custom property, so the tick stays cheap. */
    this._css = {};

    /** Token bucket. */
    this._tokens = BURST;
    this._lastRefill = nowS();
    this._lastSend = -Infinity;
    this._warnedAt = -Infinity;

    this._counters = { sent: 0, received: 0, dropped: 0, blocked: 0 };

    /* ---------------- DOM ------------------------------------------------ */
    const layer = document.createElement('div');
    layer.id = 'chat-layer';
    layer.innerHTML = this._shell();
    root.appendChild(layer);
    this.root = layer;

    const $ = (s) => layer.querySelector(s);
    this.dock = $('#chat-dock');
    this.logEl = $('#chat-log');
    this.barEl = $('#chat-bar');
    this.fabEl = $('#chat-fab');
    this.inputEl = $('#chat-input');
    this.sendEl = $('#chat-send');
    this.countEl = $('#chat-count');

    this._installKeyGuard();
    this._installWindowKeys();
    this._wire();
    /* Measure BEFORE deciding visibility — _shouldShow() reads `_room`, which
       only _measure() writes — and decide it before the first tick. Mounting
       while the main menu is up would otherwise show a chat dock over it for
       one tick: a quarter of a second on paper, and measurably longer than that
       wherever the browser throttles timers. */
    this._measure();
    this._syncVisible();
    this._watchShell();
    this._startTick();
  }

  /* ------------------------------------------------------------------ DOM */

  /**
   * The static shell. The ONLY innerHTML in this file, and every value in it is
   * a literal written here — no player text, no api text, nothing from a
   * transport. Messages are built in `_append()` with textContent.
   */
  _shell() {
    /* Drawn, not typed. The speech-bubble emoji have a patchy history on older
       Android and shell.js:320 already had to replace two emoji in this UI for
       exactly that reason. Everything in this project is procedural anyway. */
    const bubble = '<svg class="ch-ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
      + '<path d="M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H9.6L5 20.2V16.5H4A1.5 1.5 0 0 1 2.5 15V7A1.5 1.5 0 0 1 4 5.5Z"'
      + ' fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>'
      + '<circle cx="8.4" cy="11" r="1.05" fill="currentColor"/>'
      + '<circle cx="12" cy="11" r="1.05" fill="currentColor"/>'
      + '<circle cx="15.6" cy="11" r="1.05" fill="currentColor"/></svg>';
    const arrow = '<svg class="ch-ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
      + '<path d="M3.4 20.2 21 12 3.4 3.8 6 12l-2.6 8.2Z" fill="currentColor"/></svg>';

    return `
      <div id="chat-dock">
        <div id="chat-log" role="log" aria-live="polite" aria-relevant="additions"
             aria-label="Game chat" tabindex="-1"></div>

        <div id="chat-row">
          <button id="chat-fab" type="button" aria-expanded="false"
                  aria-controls="chat-input" aria-label="Open chat">
            ${bubble}
            <span class="ch-fab-l">${esc('Chat')}</span>
            <kbd class="ch-key">T</kbd>
          </button>

          <div id="chat-bar" hidden>
            <span class="ch-say" aria-hidden="true">SAY</span>
            <input id="chat-input" type="text" maxlength="${MAX_LEN}"
                   autocomplete="off" autocorrect="off" autocapitalize="sentences"
                   spellcheck="false" enterkeyhint="send" inputmode="text"
                   aria-label="Chat message" placeholder="Say something..." />
            <output id="chat-count" for="chat-input" hidden>0</output>
            <button id="chat-send" type="button" aria-label="Send message">${arrow}</button>
          </div>
        </div>
      </div>`;
  }

  /* ------------------------------------------------------------- the trap */

  /**
   * THE FIX. See THE INPUT TRAP in the header for why every line of this
   * matters. Bubble phase on this layer's own root, so it runs before
   * input.js's window listener ever sees the key.
   */
  _installKeyGuard() {
    this._keyGuard = (e) => {
      /* Escape is let through on purpose, exactly as hud.js:1544 does. It is
         consumed earlier, in the capture listener below, whenever this chat is
         the thing that should answer it; when it is not, game.js owns it. */
      if (e.key === 'Escape') return;

      if (this._typing()) {
        /* EVERY key. `keys.add(e.code)` runs unconditionally at input.js:76 and
           W A S D are the movement keys, so a guard as narrow as the audio
           panel's is the difference between a chat box and a steering wheel. */
        e.stopPropagation();
        return;
      }
      /* Not typing: guard only the set input.js actually preventDefaults, so
         this layer cannot quietly eat a shortcut somebody adds later. */
      if (/^Arrow/.test(e.code) || e.code === 'Space') e.stopPropagation();
    };
    this.root.addEventListener('keydown', this._keyGuard);
  }

  /** Does the chat input have focus right now? */
  _typing() {
    return !!this.inputEl && this.root.ownerDocument.activeElement === this.inputEl;
  }

  /**
   * T to open, Escape to close — both on window, CAPTURE phase.
   *
   * Capture because game.js registered its pause-menu keydown on window first
   * (game.js:557) and a later bubble listener cannot run in front of it, which
   * is the same conclusion phone-ui.js:1094 reached. Only the two keys this
   * file consumes are stopped; everything else passes through untouched.
   */
  _installWindowKeys() {
    this._onWinKey = (e) => {
      if (this._destroyed) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;

      if (e.key === 'Escape' || e.code === 'Escape') {
        if (!this._open) return;              // game.js owns it — pause menu
        e.preventDefault();
        e.stopPropagation();
        this.close();
        return;
      }

      if (e.code !== 'KeyT' || e.repeat) return;
      if (this._open || !this._shown) return;
      /* The pre-lobby name field and the lobby rename field both contain the
         letter T. Never take a key out of a field somebody is typing in — that
         is the exact mistake input.js makes and this file exists to survive. */
      if (isEditable(e.target) && e.target !== this.inputEl) return;
      /* Without this the 't' that opened the box is inserted INTO the box: the
         default action runs after every keydown listener, against whatever has
         focus by then, which is the input we just focused. */
      e.preventDefault();
      e.stopPropagation();
      this.open();
    };
    window.addEventListener('keydown', this._onWinKey, true);
  }

  /* ------------------------------------------------------------- plumbing */

  _wire() {
    this.fabEl.addEventListener('click', () => this.open());

    this.sendEl.addEventListener('click', () => {
      this._submit();
      /* Tapping Send on a phone must not dismiss the keyboard, or every message
         after the first costs an extra tap to start again. */
      if (this._open && this.inputEl) this.inputEl.focus();
    });

    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      /* Enter while an IME candidate window is open COMMITS the candidate; it
         does not mean "send". Sending there would post a half-composed word and
         swallow the keystroke that was meant to finish it. keyCode 229 is the
         same signal for engines that do not set isComposing. */
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      if (!this.inputEl.value.trim()) { this.close(); return; }
      this._submit();
    });

    this.inputEl.addEventListener('input', () => this._syncCount());

    /* Losing focus closes an EMPTY box. A half-typed message is kept: a stray
       tap on the city should not throw away a sentence. */
    this.inputEl.addEventListener('blur', () => {
      if (this._open && !this.inputEl.value.trim()) this.close();
    });

    /* The virtual keyboard changes the usable viewport without changing
       window.innerHeight, so the dock has to be measured against
       visualViewport or the input box ends up underneath the keys. */
    this._onVV = () => this._measure();
    window.addEventListener('resize', this._onVV);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', this._onVV);
      window.visualViewport.addEventListener('scroll', this._onVV);
    }
  }

  _startTick() {
    /* One timer for three jobs, at the same 4 Hz hud.js polls its own
       visibility at (hud.js:1836). Polled rather than observed because the two
       things being watched — an inline opacity written every frame by game.js,
       and a message ageing past its fade — are both invisible to a
       MutationObserver and to a ResizeObserver, and a 4 Hz style read is
       cheaper than either would be here. */
    this._tickT = setInterval(() => {
      if (this._destroyed) return;
      this._bindShell();        // the shell may have been built after we were
      this._measure();          // writes _room, which _syncVisible reads
      this._syncVisible();
      this._sweep();
    }, TICK_MS);
  }

  /**
   * React to a screen change the moment it happens, not up to a tick later.
   *
   * The tick alone was not enough, and the number says why: measured in this
   * project's headless harness a 250 ms setInterval is delivered about once
   * every four seconds, so `queueMatch()` -> pre-lobby left the chat hidden
   * long enough for a screenshot to catch it. A real browser throttles a
   * backgrounded tab the same way. Navigation is a DOM event, so observe the
   * DOM: the shell replaces the contents of `.shell-layer` on every go()
   * (shell.js:189) and toggles `.shell-hidden` on itself (tokens.css:87).
   *
   * Coalesced onto one animation frame, because a screen that rebuilds a
   * roster row fires this too and there is no reason to measure twice.
   */
  _watchShell() {
    if (typeof MutationObserver !== 'function') return;
    this._mo = new MutationObserver(() => {
      if (this._pending || this._destroyed) return;
      this._pending = true;
      requestAnimationFrame(() => {
        this._pending = false;
        if (this._destroyed) return;
        this._measure();
        this._syncVisible();
      });
    });
    this._bindShell();
  }

  /** Attach the observer once the shell exists. Cheap and idempotent. */
  _bindShell() {
    if (this._moBound || !this._mo) return;
    const shell = document.querySelector('.shell');
    if (!shell) return;
    this._mo.observe(shell, {
      attributes: true, attributeFilter: ['class'], childList: true, subtree: true,
    });
    this._moBound = true;
  }

  /* ----------------------------------------------------------- visibility */

  /**
   * The built-in rule, used when api.isActive is not supplied.
   *
   * `_room` comes first and overrides everything including setVisible(): if the
   * column is occupied there is nowhere to draw, and drawing anyway is the bug
   * this task was opened for.
   */
  _shouldShow() {
    if (this._room === false) return false;
    if (this._forced !== null) return this._forced;
    if (this.api && typeof this.api.isActive === 'function') {
      try { return !!this.api.isActive(); } catch { return true; }
    }
    const shell = document.querySelector('.shell');
    if (shell && !shell.classList.contains('shell-hidden')) {
      const page = shell.querySelector('.screen-page');
      const at = page && page.dataset ? page.dataset.screen : '';
      return SHELL_OK.has(at);
    }
    return true;
  }

  _syncVisible() {
    const show = this._shouldShow();
    if (show === this._shown) return;
    this._shown = show;
    this.root.classList.toggle('ch-hidden', !show);
    if (!show && this._open) this.close();
  }

  setVisible(on) {
    this._forced = (on === null || on === undefined) ? null : !!on;
    this._syncVisible();
    return this;
  }

  visible() { return this._shown; }

  /* ------------------------------------------------------------- geometry */

  /**
   * Work out how much of the left column this chat is allowed to have, and
   * write it as pixel custom properties.
   *
   * THE COLUMN. Only things that horizontally overlap the dock's own column can
   * matter, and the column is measured at its OPEN width, never its current
   * one — otherwise an element between the closed and open widths would be
   * invisible to the measurement right up until the moment the player opened
   * the box, and the chat would appear and then vanish in their hand. The
   * arithmetic mirrors --ch-w-open in chat.css, the same way TAP_PX mirrors
   * --ch-tap.
   *
   * The half-screen test this replaced was too crude in both directions: it let
   * the minimap push the dock up the page on a 375 px phone (the map starts at
   * x 220, inside the left half) and it treated a centred desktop card at
   * x 466 as an obstacle when the dock ends at x 355.
   *
   * FLOOR vs CEILING. An occupant whose BOTTOM edge is in the lowest quarter of
   * the viewport is sitting on the bottom edge with the dock — it raises the
   * floor to its top. Anything higher is overhead — it lowers the ceiling to
   * its bottom. Two passes, one rule each, no ordering to get wrong.
   *
   * NO ROOM MEANS NO CHAT. When the surviving band cannot hold the control row
   * and one line, `_room` goes false and the layer hides. That is not a
   * degraded state, it is the correct one: something else owns this column, and
   * a chat that overlaps it is the exact failure this whole task exists to fix.
   * Measured: the pre-lobby's full-width "Pick a name" card at 375x812 leaves a
   * 63 px band where 96 px is needed, so the chat stays out of the way until
   * the card is answered; the same card at 1280x800 is centred at x 466..814,
   * misses the dock's column entirely, and the chat is untouched.
   */
  _measure() {
    if (this._destroyed) return;
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;

    /* Base: the same 1.05em inset every other HUD element uses, in px. Read off
       the layer so it tracks --s without re-deriving it. */
    const em = parseFloat(getComputedStyle(this.root).fontSize) || 16;
    const base = Math.round(1.05 * em);

    /* The dock's column at its widest. Mirrors --ch-w-open. */
    const colL = Math.max(base, this.dock ? this.dock.getBoundingClientRect().left : base);
    const colR = colL + Math.min(25 * em, vw - 2.1 * em);
    /** Does `r` share any horizontal space with the dock's column? */
    const inColumn = (r) => r.right > colL && r.left < colR;

    const seen = [];
    for (const el of document.querySelectorAll(`${AVOID_SEL}, ${CEIL_SEL}`)) {
      if (el === this.root || this.root.contains(el)) continue;
      if (!onScreen(el)) continue;
      const r = el.getBoundingClientRect();
      if (!inColumn(r)) continue;
      seen.push({ top: Math.round(vh - r.top), bottom: Math.round(vh - r.bottom) });
    }

    /* Pass 1 — the floor. Anything resting on the bottom edge. */
    let floor = base;
    for (const o of seen) if (o.bottom < vh * 0.25) floor = Math.max(floor, o.top + GAP_PX);

    /* The virtual keyboard. visualViewport shrinks; window.innerHeight does
       not. Anything under ~80px is browser chrome, not a keyboard. */
    const vv = window.visualViewport;
    if (vv) {
      const covered = vh - (vv.height + vv.offsetTop);
      if (covered > 80) floor += Math.round(covered);
    }
    floor = Math.max(0, Math.min(floor, vh - 2 * TAP_PX));

    /* Pass 2 — the ceiling. Anything overhead. */
    let ceil = vh;
    for (const o of seen) if (o.bottom > floor) ceil = Math.min(ceil, o.bottom - GAP_PX);

    /* Room for the control row, a gap and at least one line of chat. */
    const need = TAP_PX + GAP_PX + MIN_LOG_PX;
    this._room = (ceil - floor) >= need;

    const band = Math.max(MIN_LOG_PX, ceil - floor - TAP_PX - GAP_PX);
    const open = Math.max(MIN_LOG_PX, Math.min(band, Math.round(vh * OPEN_VH)));
    const closed = Math.max(MIN_LOG_PX, Math.min(band, Math.round(vh * CLOSED_VH)));

    const set = (k, v) => {
      if (this._css[k] === v) return;
      this._css[k] = v;
      this.root.style.setProperty(k, `${v}px`);
    };
    set('--ch-floor', floor);
    set('--ch-max', open);
    set('--ch-max-closed', closed);
  }

  /* ----------------------------------------------------------- open/close */

  isOpen() { return this._open; }

  open() {
    if (this._destroyed || this._open || !this._shown) return this;
    this._open = true;
    this.root.classList.add('ch-open');
    this.barEl.hidden = false;
    this.fabEl.hidden = true;
    this.fabEl.setAttribute('aria-expanded', 'true');

    /* A key that was ALREADY down when the box opened never had its keydown
       stopped, so input.js is holding it in `keys` with a tap latch running.
       Without this the hole keeps driving in that direction for as long as the
       player types. input.js:279 exists for exactly this shape of problem — the
       pause menu hit it first. */
    const inp = this.api && this.api.input;
    if (inp && typeof inp.reset === 'function') {
      try { inp.reset(); } catch { /* a broken Input must not eat the chat */ }
    }

    this._measure();
    this._syncCount();
    this.inputEl.focus();
    /* Opening reveals the whole scrollback; land on the newest line. */
    this.logEl.scrollTop = this.logEl.scrollHeight;

    if (this.api && typeof this.api.onOpen === 'function') {
      try { this.api.onOpen(); } catch (e) { console.warn('[chat] onOpen failed', e); }
    }
    return this;
  }

  close() {
    if (this._destroyed || !this._open) return this;
    this._open = false;
    this.root.classList.remove('ch-open');
    this.barEl.hidden = true;
    this.fabEl.hidden = false;
    this.fabEl.setAttribute('aria-expanded', 'false');
    this.inputEl.value = '';
    this._syncCount();
    if (this._typing()) this.inputEl.blur();
    this._measure();

    if (this.api && typeof this.api.onClose === 'function') {
      try { this.api.onClose(); } catch (e) { console.warn('[chat] onClose failed', e); }
    }
    return this;
  }

  toggle() { return this._open ? this.close() : this.open(); }

  _syncCount() {
    const left = MAX_LEN - (this.inputEl.value || '').length;
    /* A NUMBER, not a colour: the counter has to mean something in greyscale. */
    this.countEl.textContent = String(left);
    this.countEl.hidden = left > 24;
    this.countEl.classList.toggle('low', left <= 8);
  }

  /* -------------------------------------------------------------- sending */

  _submit() {
    if (!this.inputEl.value.trim()) return;
    if (this.send(this.inputEl.value)) {
      this.inputEl.value = '';
      this._syncCount();
    }
  }

  /**
   * The local player says something.
   *
   * This is the transport boundary. Everything before `api.onSend` happens
   * here; everything after it needs a protocol message that does not exist —
   * see MULTIPLAYER in the header.
   *
   * @returns {boolean} true when the message was accepted and rendered
   */
  send(text) {
    const body = cleanText(text);
    if (!body) return false;
    if (!this._takeToken()) {
      this._counters.blocked++;
      const t = nowS();
      /* Tell them once per bucket, not once per keystroke. */
      if (t - this._warnedAt > REFILL_S) {
        this._warnedAt = t;
        this.system('Slow down - too many messages.');
      }
      return false;
    }

    let who = { name: 'You', color: FALLBACK_COLOR };
    if (this.api && typeof this.api.me === 'function') {
      try {
        const m = this.api.me() || {};
        who = { name: m.name || 'You', color: m.color };
      } catch { /* keep the default */ }
    }

    const msg = {
      from: cleanName(who.name),
      text: body,
      color: cleanColor(who.color),
      kind: 'say',
      me: true,
    };
    this._append(msg);
    this._counters.sent++;

    if (this.api && typeof this.api.onSend === 'function') {
      try { this.api.onSend(body, msg); }
      catch (e) { console.warn('[chat] onSend failed', e); }
    }
    return true;
  }

  /** Token bucket. Refilled lazily, so an idle player gets a full burst back. */
  _takeToken() {
    const t = nowS();
    const gained = (t - this._lastRefill) / REFILL_S;
    if (gained >= 1) {
      this._tokens = Math.min(BURST, this._tokens + Math.floor(gained));
      this._lastRefill = t;
    }
    if (t - this._lastSend < MIN_GAP_S) return false;
    if (this._tokens < 1) return false;
    this._tokens--;
    this._lastSend = t;
    return true;
  }

  /**
   * A message from anywhere else — a transport, a bot, a test.
   * @param {{from?:string, text:string, color?:string|number, kind?:string, me?:boolean}} m
   */
  receive(m) {
    if (this._destroyed || !m) return false;
    const body = cleanText(m.text);
    if (!body) return false;
    this._append({
      from: cleanName(m.from),
      text: body,
      color: m.kind === 'system' ? SYSTEM_COLOR : cleanColor(m.color),
      kind: m.kind === 'system' ? 'system' : 'say',
      me: !!m.me,
    });
    this._counters.received++;
    return true;
  }

  /** A house line. Grey, glyphed, authored "system" so colour is not alone. */
  system(text) {
    const body = cleanText(text);
    if (!body) return false;
    this._append({ from: 'system', text: body, color: SYSTEM_COLOR, kind: 'system', me: false });
    return true;
  }

  /* --------------------------------------------------------------- render */

  /**
   * Build one row.
   *
   * createElement + textContent, never innerHTML. The name and the body are the
   * two strings in this whole file that can come from another human, and this
   * is the one place they are written to the DOM.
   */
  _append(msg) {
    const row = document.createElement('div');
    row.className = `ch-msg${msg.me ? ' me' : ''}`;
    row.dataset.kind = msg.kind;
    row.style.setProperty('--nc', msg.color);

    if (msg.kind === 'system') {
      const ic = document.createElement('span');
      ic.className = 'ch-sys-ic';
      ic.setAttribute('aria-hidden', 'true');
      ic.textContent = '•';            // a bullet, not an emoji
      row.appendChild(ic);
    }

    const nm = document.createElement('b');
    nm.className = 'ch-nm';
    nm.textContent = msg.from;
    row.appendChild(nm);

    const sep = document.createElement('span');
    sep.className = 'ch-sep';
    sep.setAttribute('aria-hidden', 'true');
    sep.textContent = ':';
    row.appendChild(sep);

    const tx = document.createElement('span');
    tx.className = 'ch-tx';
    tx.textContent = msg.text;
    row.appendChild(tx);

    /* A stuck scrollbar is worse than a jumping one: only follow the tail when
       the player is already at the tail. Read BEFORE the row is inserted. */
    const atEnd = this.logEl.scrollHeight - this.logEl.scrollTop - this.logEl.clientHeight < 24;

    this.logEl.appendChild(row);
    this._msgs.push({ el: row, at: nowS(), faded: false });
    this._trim();
    /* Age the older lines HERE as well as on the tick. Measured in this
       project's headless harness, a 250 ms setInterval delivers about one call
       every four seconds, and a browser throttles timers harder still in a
       backgrounded tab — so a fade that only ever ran on the clock would leave
       stale lines on screen exactly when a conversation is busiest. A new
       message is the other moment the closed view is worth tidying. */
    this._sweep();
    if (!this._open || atEnd) this.logEl.scrollTop = this.logEl.scrollHeight;
    return row;
  }

  /** Hard cap on retained rows. A transport cannot grow the DOM without end. */
  _trim() {
    while (this._msgs.length > MAX_MSGS) {
      const m = this._msgs.shift();
      this._counters.dropped++;
      if (m.el && m.el.parentNode) m.el.parentNode.removeChild(m.el);
    }
  }

  /**
   * Age lines out of the CLOSED view.
   *
   * `.faded` is display:none while the box is closed and merely dimmed while it
   * is open, so the history is always one keypress away. A CLASS, not an
   * animation: this project's headless harness never advances a transition, and
   * a line that is only "gone" at the end of a 400 ms fade would never leave.
   */
  _sweep() {
    if (this._open) return;
    const t = nowS();
    for (const m of this._msgs) {
      if (m.faded || t - m.at < FADE_AFTER) continue;
      m.faded = true;
      m.el.classList.add('faded');
    }
  }

  /* ----------------------------------------------------------------- misc */

  clear() {
    for (const m of this._msgs) if (m.el && m.el.parentNode) m.el.parentNode.removeChild(m.el);
    this._msgs.length = 0;
    return this;
  }

  count() { return this._msgs.length; }

  stats() {
    return {
      sent: this._counters.sent,
      received: this._counters.received,
      dropped: this._counters.dropped,
      blocked: this._counters.blocked,
      retained: this._msgs.length,
      open: this._open,
    };
  }

  unmount() {
    if (this._destroyed) return;
    this._destroyed = true;
    clearInterval(this._tickT);
    if (this._mo) { try { this._mo.disconnect(); } catch { /* already gone */ } this._mo = null; }
    window.removeEventListener('keydown', this._onWinKey, true);
    window.removeEventListener('resize', this._onVV);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this._onVV);
      window.visualViewport.removeEventListener('scroll', this._onVV);
    }
    this.root.removeEventListener('keydown', this._keyGuard);
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    if (typeof globalThis !== 'undefined' && globalThis.__CHAT__ === this._facade) {
      globalThis.__CHAT__ = null;
    }
  }
}

/* ==========================================================================
 * MOUNT
 * ======================================================================== */

/** @type {Chat|null} the instance a bare unmount() tears down. */
let _current = null;

/**
 * Build the chat and put it on screen.
 *
 * @param {HTMLElement} root  #ui-root — NOT #hud-layer, see MOUNTING
 * @param {object} [api]      see the header; every hook is optional
 * @returns {object} the controller
 */
export function mount(root, api = null) {
  if (_current) unmount();
  const ui = new Chat(root, api);
  _current = ui;

  const facade = {
    open: () => (ui.open(), facade),
    close: () => (ui.close(), facade),
    toggle: () => (ui.toggle(), facade),
    isOpen: () => ui.isOpen(),

    send: (t) => ui.send(t),
    receive: (m) => ui.receive(m),
    system: (t) => ui.system(t),

    clear: () => (ui.clear(), facade),
    setVisible: (on) => (ui.setVisible(on), facade),
    visible: () => ui.visible(),
    count: () => ui.count(),
    stats: () => ui.stats(),

    get el() { return ui.root; },
    get ui() { return ui; },
    unmount: () => unmount(),
  };
  ui._facade = facade;

  /* The same console handle the phone and the audio engine expose, for the same
     reason: "is chat even mounted?" must be answerable from a console or a
     harness without reaching into a module's private state. */
  if (typeof globalThis !== 'undefined') globalThis.__CHAT__ = facade;
  return facade;
}

/** Tear down the mounted chat. Safe to call twice. */
export function unmount() {
  if (!_current) return;
  const ui = _current;
  _current = null;
  ui.unmount();
}
