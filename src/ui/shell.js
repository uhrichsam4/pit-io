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
   * Anything interactive must be reachable with a thumb. Enforced rather than
   * trusted, because a 30 px button is invisible as a bug on a desktop review
   * and infuriating on a phone.
   */
  _enforceTapTargets(el) {
    for (const b of el.querySelectorAll('button, .tappable, [role="button"]')) {
      b.style.minHeight = b.style.minHeight || 'var(--tap)';
      if (!b.hasAttribute('type') && b.tagName === 'BUTTON') b.setAttribute('type', 'button');
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

  /** Simple confirm, so no screen reaches for window.confirm on a phone. */
  confirm(question, { ok = 'Confirm', cancel = 'Cancel' } = {}) {
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
      const done = (v) => { wrap.remove(); resolve(v); };
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
