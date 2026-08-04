/**
 * The cosmetic store.
 *
 * Everything here is cosmetic and everything is bought with coins earned by
 * playing. There is no real money in this project: no price in currency, no
 * purchase flow, no "buy coins" button. Do not add one.
 *
 * THREE THINGS THIS SCREEN GETS RIGHT, because they are the classic mistakes:
 *
 *  1. A card shows exactly ONE state — price, Owned, Equipped, or its unlock
 *     requirement. Never a price next to a tick.
 *  2. `onProfileChange` PATCHES in place. Rebuilding the grid after every
 *     purchase throws away the scroll position and re-fires the entrance
 *     animation, so buying three things in a row feels like the app crashing.
 *  3. The coin balance counts DOWN after a purchase rather than snapping. The
 *     reward for spending is watching the number move.
 */

import { esc, page, wireNav } from '../shell.js';
import { profile as defaultProfile } from '../../meta/profile.js';
import {
  CATEGORIES, RARITY, RARITY_ORDER, SETS,
  getItem, getSet, itemsOf, itemsOfSet, previewSVG, featuredSet, msLeft,
} from '../../meta/cosmetics.js';
import '../css/store.css';

/** Long category names do not fit six-across on a phone; the full label lives
 *  in the tab's aria-label and on the detail sheet. */
const TAB_LABEL = {
  skin: 'Skins', trail: 'Trails', rim: 'Rims',
  nameplate: 'Plates', icon: 'Icons', emote: 'Emotes',
};

const KINDS = CATEGORIES.map((c) => c.kind);
const RANK = Object.fromEntries(RARITY_ORDER.map((r, i) => [r, RARITY_ORDER.length - i]));

/** Anything above this is worth a confirm — a mis-tap costs hours of play. */
const CONFIRM_ABOVE = 1500;

/* Screen-level state. A screen object is registered once and reused, so this
   is where "which tab was I on" survives a navigation. */
const state = { tab: KINDS[0], sheet: null, scroll: 0 };

let P = defaultProfile;
let shellRef = null;
let shownCoins = null;   // the number currently painted, which lags the real one
let coinRaf = 0;
let onKeyDown = null;

/* ------------------------------------------------------------- helpers --- */

const catLabel = (kind) => (CATEGORIES.find((c) => c.kind === kind) || {}).label || kind;

/** The equipped id for a kind. Emotes are a wheel, so slot 0 is "equipped". */
function equippedId(kind) {
  const eq = P.data.equipped || {};
  if (kind === 'emote') return eq.emote || (Array.isArray(eq.emotes) ? eq.emotes[0] : null);
  return eq[kind];
}

function unlockMet(unlock) {
  if (!unlock) return true;
  if (unlock.level) return P.data.level >= unlock.level;
  if (unlock.achievement) return !!(P.data.achievements || {})[unlock.achievement];
  return true;
}

/** Exactly one of: equipped | owned | locked | buy | claim. */
function stateOf(it) {
  if (P.owns(it.kind, it.id)) return equippedId(it.kind) === it.id ? 'equipped' : 'owned';
  if (it.unlock && !unlockMet(it.unlock)) return 'locked';
  return it.price > 0 ? 'buy' : 'claim';
}

function shortReq(unlock) {
  if (!unlock) return 'Locked';
  if (unlock.level) return `Lv ${unlock.level}`;
  return 'Feat';
}

function longReq(unlock) {
  if (!unlock) return 'Locked';
  if (unlock.label) return unlock.label;
  if (unlock.level) return `Reach level ${unlock.level}`;
  return 'Complete an achievement';
}

/** A coin, drawn rather than fetched. Hole in the middle, naturally. */
function coinGlyph(cls = 'coin') {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">` +
    `<circle cx="12" cy="12" r="10.4" fill="#ffc93c"/>` +
    `<circle cx="12" cy="12" r="10.4" fill="none" stroke="#a97600" stroke-width="1.5"/>` +
    `<ellipse cx="12" cy="12.4" rx="4.4" ry="5" fill="#3a2600"/>` +
    `<path d="M6.4 8.6a7 7 0 0 1 6.4-3.2" fill="none" stroke="#fff6d5" stroke-width="1.4" ` +
    `stroke-linecap="round" opacity="0.85"/></svg>`;
}

/* ---------------------------------------------------------- card markup --- */

function stateHTML(it, st) {
  switch (st) {
    case 'equipped':
      return `<span class="cos-state eq">&#10003; Equipped</span>`;
    case 'owned':
      return `<span class="cos-state own">Owned</span>`;
    case 'locked':
      return `<span class="cos-state lock">&#128274; ${esc(shortReq(it.unlock))}</span>`;
    case 'claim':
      return `<span class="cos-state claim">Claim</span>`;
    default:
      return `<span class="cos-state price${P.canAfford(it.price) ? '' : ' short'}">` +
        `${coinGlyph()}<b class="num">${it.price}</b></span>`;
  }
}

function stateWords(it, st) {
  if (st === 'equipped') return 'equipped';
  if (st === 'owned') return 'owned';
  if (st === 'locked') return longReq(it.unlock);
  if (st === 'claim') return 'free to claim';
  return `${it.price} coins`;
}

function cardHTML(it, i) {
  const st = stateOf(it);
  return `<button class="cos-card rarity-${it.rarity} st-${st}" data-item="${esc(it.id)}" ` +
    `data-state="${st}" style="--i:${Math.min(i, 11)}" ` +
    `aria-label="${esc(`${it.name}. ${RARITY[it.rarity].label}. ${stateWords(it, st)}`)}">` +
    `<i class="cos-strip"></i>` +
    `<span class="cos-pv">${previewSVG(it, 96)}</span>` +
    `<span class="cos-name">${esc(it.name)}</span>` +
    `${stateHTML(it, st)}</button>`;
}

/**
 * Rarity descending so the aspirational items are the first thing you see, and
 * within a rarity: what you own, then what you can buy, then what is locked.
 */
function sortItems(list) {
  const order = { equipped: 0, owned: 1, claim: 2, buy: 3, locked: 4 };
  return list.slice().sort((a, b) => (
    (RANK[b.rarity] || 0) - (RANK[a.rarity] || 0) ||
    order[stateOf(a)] - order[stateOf(b)] ||
    a.name.localeCompare(b.name)
  ));
}

function gridHTML(kind) {
  const items = sortItems(itemsOf(kind));
  if (!items.length) return `<div class="empty">Nothing here yet.</div>`;
  return items.map(cardHTML).join('');
}

/* -------------------------------------------------------- set banner ----- */

function setOwnedCount(set) {
  return itemsOfSet(set.id).filter((it) => P.owns(it.kind, it.id)).length;
}

function endsChip(set) {
  const left = msLeft(set);
  if (left === Infinity) return '';
  if (left <= 0) return `<span class="chip">Vaulted</span>`;
  const days = Math.floor(left / 864e5);
  const hours = Math.floor(left / 36e5);
  return `<span class="chip sun">&#9201; ${days >= 1 ? `${days}d left` : `${hours}h left`}</span>`;
}

function setCardHTML(set, first) {
  const items = itemsOfSet(set.id);
  const owned = setOwnedCount(set);
  const pct = items.length ? Math.round((owned / items.length) * 100) : 0;
  const done = owned === items.length && items.length > 0;
  const minis = items.map((it) => {
    const mine = P.owns(it.kind, it.id);
    return `<button class="set-mini${mine ? ' mine' : ''} rarity-${it.rarity}" data-item="${esc(it.id)}" ` +
      `aria-label="${esc(`${it.name}, ${mine ? 'owned' : catLabel(it.kind)}`)}">` +
      `<span class="mini-pv">${previewSVG(it, 64)}</span>` +
      `<span class="mini-tick" aria-hidden="true">&#10003;</span></button>`;
  }).join('');

  return `<article class="set-card${done ? ' done' : ''}" data-set="${esc(set.id)}" ` +
    `style="--sc:${esc(set.accent)}">` +
    `<div class="set-top">` +
      `<span class="set-kicker">${first ? 'Featured Collection' : 'Collection'}</span>` +
      `<span class="set-chips">${endsChip(set)}${done ? `<span class="chip aqua">Complete</span>` : ''}</span>` +
    `</div>` +
    `<h2 class="set-name">${esc(set.name)}</h2>` +
    `<p class="set-blurb">${esc(set.blurb)}</p>` +
    `<div class="set-minis">${minis}</div>` +
    `<div class="set-prog">` +
      `<div class="bar"><i data-set-bar="${esc(set.id)}" style="width:${pct}%"></i></div>` +
      `<span class="set-frac num" data-set-frac="${esc(set.id)}">${owned}/${items.length}</span>` +
    `</div>` +
    `<p class="set-note tiny">${done ? `&#9733; ${esc(set.flourish)}` : `Complete the set: ${esc(set.flourish)}`}</p>` +
  `</article>`;
}

function bannerHTML() {
  const feat = featuredSet();
  const ordered = [feat, ...SETS.filter((s) => s.id !== feat.id)];
  const cards = ordered.map((s, i) => setCardHTML(s, i === 0)).join('');
  const dots = ordered.map((s, i) =>
    `<button class="set-dot" data-dot="${i}" aria-label="${esc(`Show ${s.name}`)}" ` +
    `aria-current="${i === 0}"><i style="--dc:${esc(s.accent)}"></i></button>`
  ).join('');
  return `<div class="set-rail" tabindex="-1">${cards}</div><div class="set-dots">${dots}</div>`;
}

/* ------------------------------------------------------------- sheet ----- */

function sheetFootHTML(it) {
  const st = stateOf(it);
  const coins = P.data.coins;
  if (st === 'equipped') {
    return `<p class="sheet-note">Equipped right now.</p>` +
      `<button class="btn btn-block" disabled aria-disabled="true">Equipped</button>`;
  }
  if (st === 'owned') {
    return `<p class="sheet-note">In your collection.</p>` +
      `<button class="btn btn-aqua btn-block" data-act="equip">Equip</button>`;
  }
  if (st === 'locked') {
    return `<p class="sheet-note">&#128274; Not for sale &mdash; this one is earned.</p>` +
      `<button class="btn btn-block" disabled aria-disabled="true">${esc(longReq(it.unlock))}</button>`;
  }
  if (st === 'claim') {
    return `<p class="sheet-note">Requirement met.</p>` +
      `<button class="btn btn-sun btn-block" data-act="buy">Claim for free</button>`;
  }
  const short = it.price - coins;
  if (short > 0) {
    return `<p class="sheet-note bad">Need <b class="num">${short}</b> more coins.</p>` +
      `<button class="btn btn-block" disabled aria-disabled="true">${coinGlyph()}<b class="num">${it.price}</b></button>`;
  }
  return `<p class="sheet-note">Balance after: <b class="num">${coins - it.price}</b></p>` +
    `<button class="btn btn-block" data-act="buy">Buy &#183; ${coinGlyph()}<b class="num">${it.price}</b></button>`;
}

function sheetHTML(it) {
  const set = it.set ? getSet(it.set) : null;
  return `<div class="cos-sheet panel rarity-${it.rarity}" role="dialog" aria-modal="true" ` +
    `aria-label="${esc(it.name)}">` +
    `<span class="sheet-grab" aria-hidden="true"></span>` +
    `<button class="icon-btn sheet-x" data-sheet="close" aria-label="Close">&#10005;</button>` +
    `<div class="sheet-hero">${previewSVG(it, 168)}</div>` +
    `<h2 class="sheet-name">${esc(it.name)}</h2>` +
    `<div class="sheet-tags">` +
      `<span class="chip rar-chip">${esc(RARITY[it.rarity].label)}</span>` +
      `<span class="chip">${esc(catLabel(it.kind))}</span>` +
      `${set ? `<span class="chip" style="border-color:${esc(set.accent)}">${esc(set.name)}</span>` : ''}` +
    `</div>` +
    `<p class="sheet-desc">${esc(it.desc)}</p>` +
    `<div class="sheet-foot">${sheetFootHTML(it)}</div>` +
  `</div>`;
}

function openSheet(root, id) {
  const it = getItem(id);
  if (!it) return;
  closeSheet(root, true);
  state.sheet = id;
  const wrap = document.createElement('div');
  wrap.className = 'cos-sheet-scrim';
  wrap.innerHTML = sheetHTML(it);
  root.appendChild(wrap);
  const btn = wrap.querySelector('.sheet-foot .btn:not([disabled])') || wrap.querySelector('.sheet-x');
  if (btn) btn.focus({ preventScroll: true });
}

function closeSheet(root, immediate = false) {
  state.sheet = null;
  const wrap = root.querySelector('.cos-sheet-scrim');
  if (!wrap) return;
  if (immediate) { wrap.remove(); return; }
  // animationend rather than a timer: nothing to clean up if the screen is torn
  // down mid-close, and reduced motion (0.01ms animations) still fires it.
  wrap.classList.add('closing');
  wrap.addEventListener('animationend', () => wrap.remove(), { once: true });
}

/* ------------------------------------------------------------ actions --- */

async function buy(it) {
  const price = it.price;
  if (price > 0 && !P.canAfford(price)) {
    shellRef.toast(`Need ${price - P.data.coins} more coins`, 'bad');
    return;
  }
  if (price >= CONFIRM_ABOVE) {
    const ok = await shellRef.confirm(`Spend ${price} coins on ${it.name}?`, { ok: 'Buy it' });
    if (!ok) return;
  }
  // purchase() spends and grants in one step, so a failed affordability check
  // cannot leave the player short of coins and short of the item.
  if (P.purchase(it.kind, it.id, price)) {
    shellRef.toast(price > 0 ? `Bought ${it.name}` : `${it.name} claimed`, 'ok');
  } else {
    shellRef.toast('Could not buy that', 'bad');
  }
}

function equip(it) {
  if (!P.equip(it.kind, it.id)) { shellRef.toast('You do not own that', 'bad'); return; }
  const d = P.data;
  // profile.publicRecord() reads d.icon and d.nameplate, not d.equipped.* — the
  // leaderboard row and the friends list are built from those, so both copies
  // move together or a bought icon never appears next to your name.
  if (it.kind === 'icon') d.icon = it.id;
  if (it.kind === 'nameplate') d.nameplate = it.id;
  // The in-match emote wheel is the ARRAY equipped.emotes; equip() only writes
  // the scalar. Newest equip takes slot 0, wheel capped at four.
  if (it.kind === 'emote') {
    const wheel = Array.isArray(d.equipped.emotes) ? d.equipped.emotes : [];
    d.equipped.emotes = [it.id, ...wheel.filter((x) => x !== it.id)].slice(0, 4);
  }
  P.save();
  shellRef.toast(`${it.name} equipped`, 'ok');
}

/**
 * Six category labels do not fit across a phone, so the strip scrolls. Keep the
 * selected tab on screen — an invisible active tab reads as a broken control.
 * (`.store-tabs` is position:sticky, so it is the offsetParent of its buttons.)
 */
function revealTab(root) {
  const strip = root.querySelector('.store-tabs');
  const sel = strip && strip.querySelector('[aria-selected="true"]');
  if (!strip || !sel || strip.scrollWidth <= strip.clientWidth) return;
  strip.scrollLeft = sel.offsetLeft - (strip.clientWidth - sel.offsetWidth) / 2;
}

/* -------------------------------------------------------- live patching --- */

/** Motion the player has switched off, or cannot see, is not worth a tween. */
function skipTween() {
  if (typeof document !== 'undefined' && document.hidden) return true;
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch { return false; }
}

function syncCoins(root) {
  const el = root.querySelector('.coin-val');
  if (!el) return;
  const target = P.data.coins;
  // A hidden tab never services rAF: tweening there would freeze the balance on
  // a stale number until the next profile change. Snap instead.
  if (shownCoins === null || shownCoins === target || skipTween()) {
    shownCoins = target;
    el.textContent = String(target);
    return;
  }
  const from = shownCoins;
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const pill = root.querySelector('.store-coins');
  if (pill) {
    pill.classList.remove('bump');
    void pill.offsetWidth;   // forced reflow: restarts the animation on a repeat buy
    pill.classList.add('bump');
  }
  cancelAnimationFrame(coinRaf);
  const step = (now) => {
    const k = Math.min(1, (now - t0) / 520);
    const e = 1 - Math.pow(1 - k, 3);
    shownCoins = Math.round(from + (target - from) * e);
    el.textContent = String(shownCoins);
    if (k < 1) coinRaf = requestAnimationFrame(step);
    else { shownCoins = target; el.textContent = String(target); coinRaf = 0; }
  };
  coinRaf = requestAnimationFrame(step);
}

/** Patch states in place. No innerHTML on the grid: scroll and animations stay. */
function patch(root) {
  for (const card of root.querySelectorAll('.cos-card')) {
    const it = getItem(card.dataset.item);
    if (!it) continue;
    const st = stateOf(it);
    if (card.dataset.state === st) continue;
    card.classList.remove('st-equipped', 'st-owned', 'st-locked', 'st-buy', 'st-claim');
    card.classList.add(`st-${st}`);
    card.dataset.state = st;
    const slot = card.querySelector('.cos-state');
    if (slot) slot.outerHTML = stateHTML(it, st);
    card.setAttribute('aria-label', `${it.name}. ${RARITY[it.rarity].label}. ${stateWords(it, st)}`);
  }

  for (const mini of root.querySelectorAll('.set-mini')) {
    const it = getItem(mini.dataset.item);
    if (it) mini.classList.toggle('mine', P.owns(it.kind, it.id));
  }
  for (const set of SETS) {
    const items = itemsOfSet(set.id);
    const owned = setOwnedCount(set);
    const frac = root.querySelector(`[data-set-frac="${set.id}"]`);
    const bar = root.querySelector(`[data-set-bar="${set.id}"]`);
    if (frac) frac.textContent = `${owned}/${items.length}`;
    if (bar) bar.style.width = `${items.length ? Math.round((owned / items.length) * 100) : 0}%`;
    const card = root.querySelector(`.set-card[data-set="${set.id}"]`);
    if (card) card.classList.toggle('done', items.length > 0 && owned === items.length);
  }

  if (state.sheet) {
    const it = getItem(state.sheet);
    const foot = root.querySelector('.cos-sheet .sheet-foot');
    if (it && foot) foot.innerHTML = sheetFootHTML(it);
  }
  syncCoins(root);
}

/* ------------------------------------------------------------- screen --- */

export function registerStore(shell, deps = {}) {
  P = deps.profile || defaultProfile;
  shellRef = shell;

  shell.register('store', {
    title: 'Store',

    render({ params }) {
      if (params && KINDS.includes(params.tab)) state.tab = params.tab;
      const coins = shownCoins === null ? P.data.coins : shownCoins;
      const tabs = CATEGORIES.map((c) =>
        `<button role="tab" data-tab="${c.kind}" aria-selected="${c.kind === state.tab}" ` +
        `aria-label="${esc(c.label)}">${esc(TAB_LABEL[c.kind] || c.label)}</button>`
      ).join('');

      return page({
        title: 'Store',
        back: true,
        actions: `<div class="store-coins" aria-live="polite" aria-label="Coin balance">` +
          `${coinGlyph()}<span class="coin-val num">${coins}</span></div>`,
        body: `<div class="wrap-wide store-wrap">
            <section class="store-sets">${bannerHTML()}</section>
            <div class="tabs-anchor"></div>
            <div class="tabs store-tabs" role="tablist" aria-label="Cosmetic categories">${tabs}</div>
            <div class="grid-auto store-grid" data-kind="${state.tab}">${gridHTML(state.tab)}</div>
            <p class="store-foot tiny muted center">Every item here is cosmetic. Coins are earned by playing.</p>
          </div>`,
      });
    },

    mount(root, ctx) {
      wireNav(root, ctx.shell);
      shellRef = ctx.shell;
      const body = root.querySelector('.page-body');
      const rail = root.querySelector('.set-rail');

      root.addEventListener('click', async (e) => {
        const tab = e.target.closest('[data-tab]');
        if (tab) {
          if (tab.dataset.tab === state.tab) return;
          state.tab = tab.dataset.tab;
          for (const b of root.querySelectorAll('[data-tab]')) {
            b.setAttribute('aria-selected', String(b.dataset.tab === state.tab));
          }
          const grid = root.querySelector('.store-grid');
          grid.dataset.kind = state.tab;
          grid.innerHTML = gridHTML(state.tab);
          revealTab(root);
          // Land on the top of the new category, but never yank the player back
          // down if they were still looking at the collection banner.
          // offsetTop is measured from .screen-page (the nearest positioned
          // ancestor), so the header height has to come back off it to get an
          // offset inside the scroll container.
          const anchor = root.querySelector('.tabs-anchor');
          if (body && anchor) {
            const top = Math.max(0, anchor.offsetTop - body.offsetTop);
            if (body.scrollTop > top) body.scrollTop = top;
          }
          return;
        }

        const dot = e.target.closest('[data-dot]');
        if (dot && rail) {
          rail.scrollTo({ left: rail.clientWidth * Number(dot.dataset.dot), behavior: 'smooth' });
          return;
        }

        const act = e.target.closest('[data-act]');
        if (act) {
          const it = getItem(state.sheet);
          if (!it) return;
          if (act.dataset.act === 'buy') await buy(it);
          else if (act.dataset.act === 'equip') equip(it);
          return;
        }

        if (e.target.closest('[data-sheet="close"]') ||
            (state.sheet && e.target.classList.contains('cos-sheet-scrim'))) {
          closeSheet(root);
          return;
        }

        const card = e.target.closest('[data-item]');
        if (card) openSheet(root, card.dataset.item);
      });

      if (rail) {
        rail.addEventListener('scroll', () => {
          const i = Math.round(rail.scrollLeft / Math.max(1, rail.clientWidth));
          for (const d of root.querySelectorAll('[data-dot]')) {
            d.setAttribute('aria-current', String(Number(d.dataset.dot) === i));
          }
        }, { passive: true });
      }

      onKeyDown = (e) => { if (e.key === 'Escape' && state.sheet) closeSheet(root); };
      document.addEventListener('keydown', onKeyDown);

      if (body && state.scroll) body.scrollTop = state.scroll;
      revealTab(root);
      syncCoins(root);
    },

    unmount(root) {
      const body = root.querySelector('.page-body');
      state.scroll = body ? body.scrollTop : 0;
      state.sheet = null;
      cancelAnimationFrame(coinRaf);
      coinRaf = 0;
      if (onKeyDown) document.removeEventListener('keydown', onKeyDown);
      onKeyDown = null;
    },

    onProfileChange(root) { patch(root); },
  });

  return shell;
}
