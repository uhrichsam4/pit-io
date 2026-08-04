/**
 * The UI shell — screen registry, navigation stack and the panel primitives
 * every meta screen is built from.
 *
 * THE CONTRACT every screen builds against. A screen is a plain object:
 *
 *   shell.register('store', {
 *     title: 'Store',
 *     render(ctx) { return htmlStringOrElement; },   // build the screen
 *     mount(root, ctx) {},                           // wire listeners
 *     unmount(root) {},                              // clean up
 *     onProfileChange(root) {},                      // optional live refresh
 *   });
 *
 * Then anyone can `shell.go('store')`. The shell owns the stack, the back
 * behaviour, the transitions and the safe-area padding, so six screens written
 * by six people navigate identically and no screen has to know about any other.
 *
 * MOBILE FIRST. Everything is sized in `em` off one root scale so the whole
 * interface grows and shrinks as one; hit targets have a hard 44 px floor;
 * transitions honour prefers-reduced-motion. Nothing here assumes a mouse.
 */

// The design system travels with the shell rather than with index.html. Every
// screen depends on this module, so importing it here means the tokens cannot
// be forgotten by whoever wires the page up — and forgetting them does not
// degrade gracefully, it renders the entire meta layer as unstyled text.
import './css/tokens.css';

const MIN_TAP_PX = 44;

export class Shell {
  /**
   * @param {HTMLElement} root element the shell owns entirely
   */
  constructor(root) {
    this.root = root;
    this.root.classList.add('shell');
    this.screens = new Map();
    /** @type {{name:string, params:object}[]} */
    this.stack = [];
    this.current = null;
    this._el = null;
    this._transitioning = false;

    this.layer = document.createElement('div');
    this.layer.className = 'shell-layer';
    this.root.appendChild(this.layer);

    /** Toast host, so any screen can say "Equipped" without owning a widget. */
    this.toastHost = document.createElement('div');
    this.toastHost.className = 'shell-toasts';
    this.root.appendChild(this.toastHost);

    this._onResize = () => this._scale();
    window.addEventListener('resize', this._onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', this._onResize);
    this._scale();

    /**
     * Android's back gesture and the browser back button must pop a screen, not
     * leave the game. That needs a real history entry per navigation — a bare
     * popstate listener never fires, because nothing pushed anything, and the
     * gesture unloads the page instead. Counted rather than assumed: we only
     * consume a popstate we know we caused.
     */
    this._histDepth = 0;
    this._onPop = () => {
      if (this._histDepth <= 0) return;
      this._histDepth--;
      this._popStack();
    };
    window.addEventListener('popstate', this._onPop);
  }

  /** One scale knob drives every dimension. See --ui-scale in styles.css. */
  _scale() {
    const w = window.innerWidth || 1280;
    const h = window.innerHeight || 800;
    const short = Math.min(w, h);
    // Phones get a larger relative scale so text stays readable at arm's length.
    const s = short < 520 ? 0.94 : Math.max(0.86, Math.min(1.22, Math.min(w / 1400, h / 860)));
    this.root.style.setProperty('--ui-scale', String(s));
    this.root.style.setProperty('--tap', `${MIN_TAP_PX}px`);
    this.root.classList.toggle('portrait', h > w);
    this.root.classList.toggle('compact', short < 520);
  }

  /**
   * @param {string} name
   * @param {{title?:string, render:Function, mount?:Function, unmount?:Function,
   *          onProfileChange?:Function, fullBleed?:boolean}} screen
   */
  register(name, screen) {
    this.screens.set(name, screen);
    return this;
  }

  has(name) { return this.screens.has(name); }

  /** Navigate forward. `replace` swaps the top of the stack instead of pushing. */
  go(name, params = {}, { replace = false } = {}) {
    if (!this.screens.has(name)) {
      console.warn(`[shell] no screen "${name}"`);
      return this;
    }
    if (replace && this.stack.length) this.stack.pop();
    this.stack.push({ name, params });
    if (!replace) {
      try { history.pushState({ shell: this.stack.length }, ''); this._histDepth++; }
      catch { /* sandboxed or file://: navigation still works, back does not */ }
    }
    this._show(name, params, replace ? 'replace' : 'forward');
    return this;
  }

  /**
   * Pop to the previous screen. No-op at the root.
   *
   * When we have pushed history, this delegates to history.back() and lets the
   * popstate handler do the work, so an in-app back button and the hardware
   * gesture take exactly the same path. Popping here as well would skip two
   * screens per press.
   */
  back() {
    if (this.stack.length <= 1) return this;
    if (this._histDepth > 0) { history.back(); return this; }
    this._popStack();
    return this;
  }

  _popStack() {
    if (this.stack.length <= 1) return;
    this.stack.pop();
    const top = this.stack[this.stack.length - 1];
    this._show(top.name, top.params, 'back');
  }

  /** Clear the stack and show `name` as the new root (used by "leave match"). */
  reset(name, params = {}) {
    this.stack = [{ name, params }];
    this._show(name, params, 'replace');
    return this;
  }

  /** Hide the shell entirely — the game is playing. */
  hide() {
    this.root.classList.add('shell-hidden');
    return this;
  }

  show() {
    this.root.classList.remove('shell-hidden');
    return this;
  }

  get visible() { return !this.root.classList.contains('shell-hidden'); }

  _show(name, params, direction) {
    const screen = this.screens.get(name);
    const prev = this.current;
    const prevEl = this._el;

    // Cancel any open confirm BEFORE the swap. The modal is appended to
    // this.root, not to this.layer, so clearing the layer left it — and its
    // full-screen backdrop — sitting on top of the newly rendered screen with
    // its promise never settling. Reachable with no unusual input at all: the
    // shell wires Android's back gesture to popstate, so opening Settings'
    // "reset progress" confirm and swiping back left an undismissable modal
    // over every subsequent screen. Cancel-on-navigate is what a phone does.
    this._closeModals(false);

    if (prev && prev.unmount && prevEl) {
      try { prev.unmount(prevEl); } catch (e) { console.warn('[shell] unmount failed', e); }
    }
    if (prev && prev.__unsubProfile) { prev.__unsubProfile(); prev.__unsubProfile = null; }

    const el = document.createElement('div');
    el.className = `screen-page dir-${direction}${screen.fullBleed ? ' full-bleed' : ''}`;
    el.dataset.screen = name;

    const content = screen.render({ shell: this, params });
    if (typeof content === 'string') el.innerHTML = content;
    else if (content instanceof Node) el.appendChild(content);

    // Swap immediately, then let CSS animate the incoming page. Keeping the old
    // page mounted during the transition doubles peak DOM for no benefit on a
    // phone, and screens here are cheap to rebuild.
    this.layer.innerHTML = '';
    this.layer.appendChild(el);

    this.current = screen;
    this._el = el;

    if (screen.mount) {
      try { screen.mount(el, { shell: this, params }); }
      catch (e) { console.error(`[shell] mount "${name}" failed`, e); }
    }

    // Screens that show live profile data refresh themselves rather than every
    // screen polling.
    if (screen.onProfileChange) {
      import('../meta/profile.js').then(({ profile }) => {
        if (this.current !== screen) return;
        screen.__unsubProfile = profile.onChange(() => {
          if (this.current === screen && this._el) {
            try { screen.onProfileChange(this._el); } catch { /* screen's problem */ }
          }
        });
      });
    }

    this._enforceTapTargets(el);
  }

  /**
   * Normalise controls a screen just rendered.
   *
   * The 44 px tap floor is NOT applied here — it lives in tokens.css. This pass
   * runs once, at mount, so any control a screen builds afterwards (in mount(),
   * on a tab switch, from a fetch) was created after the pass had already gone
   * by and kept whatever height its padding gave it. Worse, stamping an inline
   * min-height beats a screen's own stylesheet, so mounted controls and
   * dynamically added ones ended up obeying different rules. A stylesheet rule
   * has no such window and no such asymmetry; CSS owns size, this owns
   * semantics.
   *
   * A <button> inside a form defaults to type=submit, which reloads the page.
   * There is no form here today, and that is exactly the kind of assumption
   * that stops being true quietly.
   */
  _enforceTapTargets(el) {
    for (const b of el.querySelectorAll('button:not([type])')) {
      b.setAttribute('type', 'button');
    }
  }

  /** Transient message. Use for "Equipped", "Not enough coins", "Copied". */
  toast(text, kind = 'info', ms = 2000) {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = text;
    this.toastHost.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
    return t;
  }

  /**
   * Tear down every open confirm and settle its promise. Called on navigation.
   * @param {boolean} answer what an abandoned confirm resolves to — always
   *        false: navigating away is not consent.
   */
  _closeModals(answer = false) {
    if (!this._modalCancels || !this._modalCancels.size) return;
    for (const done of [...this._modalCancels]) {
      try { done(answer); } catch { /* a settled promise is not an error */ }
    }
    this._modalCancels.clear();
    for (const m of this.root.querySelectorAll('.shell-modal')) m.remove();
  }

  /** Simple confirm, so no screen reaches for window.confirm on a phone. */
  confirm(question, { ok = 'Confirm', cancel = 'Cancel' } = {}) {
    if (!this._modalCancels) this._modalCancels = new Set();
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'shell-modal';
      wrap.innerHTML = `
        <div class="modal-card panel">
          <div class="modal-q"></div>
          <div class="modal-actions">
            <button class="btn btn-ghost" data-a="no"></button>
            <button class="btn" data-a="yes"></button>
          </div>
        </div>`;
      wrap.querySelector('.modal-q').textContent = question;
      wrap.querySelector('[data-a="no"]').textContent = cancel;
      wrap.querySelector('[data-a="yes"]').textContent = ok;
      const done = (v) => {
        this._modalCancels.delete(done);
        wrap.remove();
        resolve(v);
      };
      this._modalCancels.add(done);
      wrap.addEventListener('click', (e) => {
        const a = e.target.closest('[data-a]');
        if (a) done(a.dataset.a === 'yes');
        else if (e.target === wrap) done(false);
      });
      this.root.appendChild(wrap);
      this._enforceTapTargets(wrap);
    });
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('popstate', this._onPop);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', this._onResize);
  }
}

/* ------------------------------------------------------------- helpers --- */

/** Escape untrusted text before it goes anywhere near innerHTML. */
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
  ));
}

/** 12345 -> "12.3k". Leaderboards and stat tiles are full of these. */
export function shortNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

/**
 * Inline SVG icons for the glyphs that are NOT safe as emoji.
 *
 * Most of the emoji in this UI are old enough to render everywhere (🏆 👑 🔥 🎯
 * are all Emoji 1.0). Two are not: 🪙 is Emoji 13.0 (2020) and 🪪 is Emoji 14.0
 * (2021), so on an Android below 11 or an iOS below 14.2 they are a tofu box —
 * and the coin is the game's CURRENCY, on screen in the lobby, the store and
 * the reward summary. A currency symbol that silently becomes ☐ on someone's
 * phone is not something to leave to a font.
 *
 * Drawn rather than imported, like every other asset in this project.
 *
 * The coin has a HOLE punched through it. That is the store's idea, not mine,
 * and it is a better one than a generic currency disc — the whole game is about
 * being a hole, so the money should be too. Kept as the single shared drawing
 * rather than one per screen.
 *
 * @param {'coin'|'card'} name
 * @param {string} size  any CSS length; pass null to let a class own the size
 * @param {string} cls   optional class, for screens that size it in their CSS
 */
export function icon(name, size = '1em', cls = '') {
  const dim = size ? ` width="${size}" height="${size}"` : '';
  const box = `class="md-ico ${cls}"${dim} viewBox="0 0 24 24" aria-hidden="true" focusable="false"`;
  if (name === 'coin') {
    return `<svg ${box}>
      <defs>
        <linearGradient id="mdCoinF" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ffe27a"/><stop offset=".55" stop-color="#ffc93c"/>
          <stop offset="1" stop-color="#dd9105"/>
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="10.2" fill="url(#mdCoinF)"/>
      <circle cx="12" cy="12" r="10.2" fill="none" stroke="#a86c00" stroke-width="1.4"/>
      <circle cx="12" cy="12" r="7.6" fill="none" stroke="#a86c00" stroke-width=".9" opacity=".45"/>
      <ellipse cx="12" cy="12.3" rx="4.1" ry="4.7" fill="#2e1d00"/>
      <ellipse cx="12" cy="11.2" rx="4.1" ry="4.7" fill="#000" opacity=".55"/>
      <path d="M6.3 8.4a7.1 7.1 0 0 1 6.2-3.3" fill="none" stroke="#fff6d5"
            stroke-width="1.5" stroke-linecap="round" opacity=".85"/>
    </svg>`;
  }
  if (name === 'card') {
    return `<svg ${box}>
      <rect x="2.5" y="5" width="19" height="14" rx="2.6" fill="#2b3d5e" stroke="#7d92b5" stroke-width="1.1"/>
      <circle cx="8.2" cy="10.8" r="2.4" fill="#ffc93c"/>
      <path d="M4.7 16.8c.7-1.8 2-2.7 3.5-2.7s2.8.9 3.5 2.7z" fill="#ffc93c"/>
      <rect x="13.8" y="9" width="5.6" height="1.5" rx=".75" fill="#8fa6c8"/>
      <rect x="13.8" y="12" width="5.6" height="1.5" rx=".75" fill="#8fa6c8" opacity=".7"/>
      <rect x="13.8" y="15" width="3.5" height="1.5" rx=".75" fill="#8fa6c8" opacity=".45"/>
    </svg>`;
  }
  return '';
}

/**
 * The one empty state, used by all eight screens.
 *
 * Every "nothing here yet" in this app was a bare sentence in a flat dark box,
 * and on a phone those were regularly the biggest element on their screen — the
 * friends board with no friends was a gold podium of one holding a score of 0
 * above 330 px of black. An empty state needs a drawn mark, one line of copy,
 * and something to DO; the last of those is the part that was always missing.
 *
 * `art` is an inline SVG string (see src/ui/icons.js) — never an emoji, and
 * never a network asset. `cta` is optional; when present it is a real button
 * carrying `data-act`, so the screen's existing delegated click handler picks
 * it up with no extra listener.
 *
 * @param {{art?:string, head:string, sub?:string, cta?:string, act?:string,
 *          accent?:string, cls?:string}} o
 */
export function emptyState({ art = '', head, sub = '', cta = '', act = '', accent = '', cls = '' }) {
  return `<div class="empty-state ${esc(cls)}"${accent ? ` style="--ec:${esc(accent)}"` : ''}>
      ${art ? `<span class="es-art" aria-hidden="true">${art}</span>` : ''}
      <div class="es-h">${esc(head)}</div>
      ${sub ? `<p class="es-s">${esc(sub)}</p>` : ''}
      ${cta ? `<button class="btn" data-act="${esc(act)}">${esc(cta)}</button>` : ''}
    </div>`;
}

/** Standard page scaffold: title bar with back, then a scrolling body. */
export function page({ title, back = true, actions = '', body = '' }) {
  return `
    <header class="page-head">
      ${back ? '<button class="icon-btn" data-nav="back" aria-label="Back">&#8249;</button>' : '<span class="spacer"></span>'}
      <h1>${esc(title)}</h1>
      <div class="head-actions">${actions}</div>
    </header>
    <div class="page-body">${body}</div>`;
}

/** Wire the standard back button. Call from a screen's mount(). */
export function wireNav(el, shell) {
  el.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (!nav) return;
    const to = nav.dataset.nav;
    if (to === 'back') shell.back();
    else shell.go(to);
  });
}
