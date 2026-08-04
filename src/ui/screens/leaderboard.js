/**
 * LEADERBOARD SCREEN — podium, board tabs, metric selector, honest source line.
 *
 * The screen never decides what is true; src/meta/leaderboard.js does. All this
 * file does is make the difference between "live server board" and "your own
 * local history" impossible to miss, because a player who thinks a local board
 * is global will believe they are 1st in the world.
 *
 * State (board + metric) lives in the closure rather than in the DOM, so
 * leaving to a profile and coming back lands on the tab you were reading.
 */

import { page, esc, wireNav } from '../shell.js';
import { profile as globalProfile } from '../../meta/profile.js';
import {
  BOARDS, BOARD_LABELS, METRICS, getMetric, formatMetric, load, localBoard,
  rankBadge, push,
} from '../../meta/leaderboard.js';
import '../css/leaderboard.css';

/** Avatars are procedural — no image assets exist anywhere in this project. */
const AV_COLORS = ['#ff3d8b', '#ffc93c', '#37e6d5', '#4dff9e', '#ff9430', '#b46bff', '#4dc4ff'];
const PODIUM_RING = { 1: '#ffc93c', 2: '#d7dde6', 3: '#ff9430' };

/** Rows shown below the podium before we stop and pin the player instead. */
const MAX_LIST = 50;

function hashOf(s) {
  let h = 0;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function avatarHtml(e, cls = '', ring = '') {
  const c = AV_COLORS[hashOf(e.id || e.name) % AV_COLORS.length];
  const initial = String(e.name || '?').trim().charAt(0).toUpperCase() || '?';
  const rc = ring ? `;--rc:${ring}` : '';
  return `<span class="avatar ${cls}" style="--ac:${c}${rc}">${esc(initial)}</span>`;
}

function agoText(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

/* ------------------------------------------------------------- fragments --- */

function badgeHtml(e) {
  const b = rankBadge(e);
  return `<span class="tier-badge" style="--tc:${b.color}"><i></i>${esc(b.label)}</span>`;
}

function rowHtml(e, metric) {
  const rank = e.rank == null ? '–' : e.rank;
  const cls = [
    'row',
    e.isMe ? 'me' : '',
    e.rank && e.rank <= 3 ? `p${e.rank}` : '',
    e.unknown ? 'unknown' : '',
  ].filter(Boolean).join(' ');
  const lvl = Number.isFinite(Number(e.level)) && Number(e.level) > 0
    ? `<span class="lv">Lv ${Math.round(e.level)}</span>` : '';
  const sub = e.unknown
    ? `<span class="no-data">${esc(e.note || 'No score on this board yet')}</span>`
    : `${badgeHtml(e)}${lvl}`;
  return `
    <div class="${cls}">
      <span class="rk">${esc(rank)}</span>
      ${avatarHtml(e)}
      <span class="nm-wrap">
        <span class="nm">${esc(e.name)}${e.isMe ? '<b class="you">YOU</b>' : ''}</span>
        <span class="sub">${sub}</span>
      </span>
      <span class="sc">${esc(formatMetric(e.value, metric))}</span>
    </div>`;
}

function podHtml(e, metric) {
  if (!e) return '';
  const r = e.rank || 1;
  return `
    <div class="pod p${r}${e.isMe ? ' me' : ''}" style="--pc:${PODIUM_RING[r] || '#d7dde6'}">
      ${r === 1 ? '<div class="crown" aria-hidden="true">👑</div>' : ''}
      <div class="pod-ring">
        ${avatarHtml(e, 'big', PODIUM_RING[r])}
        <span class="pod-medal">${r}</span>
      </div>
      <div class="pod-nm">${esc(e.name)}</div>
      <div class="pod-sc">${esc(formatMetric(e.value, metric))}</div>
      <div class="plinth"><span>${r}</span></div>
    </div>`;
}

function podiumHtml(top, metric) {
  if (!top.length) return '';
  // 2 – 1 – 3 left to right; that arrangement is the whole point of a podium.
  const order = [top[1], top[0], top[2]].filter(Boolean);
  return `<div class="podium count-${top.length}">${order.map((e) => podHtml(e, metric)).join('')}</div>`;
}

function skeletonHtml() {
  const row = '<div class="sk-row"><span class="sk sk-rk"></span><span class="sk sk-av"></span><span class="sk sk-nm"></span><span class="sk sk-sc"></span></div>';
  return `
    <div class="lb-skeleton" aria-busy="true" aria-label="Loading board">
      <div class="podium sk-podium">
        <div class="pod p2"><div class="sk sk-pav"></div><div class="sk sk-pnm"></div><div class="plinth"></div></div>
        <div class="pod p1"><div class="sk sk-pav big"></div><div class="sk sk-pnm"></div><div class="plinth"></div></div>
        <div class="pod p3"><div class="sk sk-pav"></div><div class="sk sk-pnm"></div><div class="plinth"></div></div>
      </div>
      <div class="panel panel-flush sk-list">${row.repeat(5)}</div>
    </div>`;
}

function emptyHtml(data, shell) {
  const friends = data.board === 'friends';
  const canFriends = friends && shell.has('friends');
  const head = friends ? 'No friends yet' : 'Nothing on this board yet';
  const sub = friends
    ? 'Add a friend code and their scores show up here.'
    : (data.source === 'server'
      ? 'No scores have been submitted. Play a match and yours will be the first.'
      : 'Play a match and your first result lands here.');
  return `
    <div class="lb-empty">
      <div class="lb-empty-ico" aria-hidden="true">${friends ? '👥' : '🏆'}</div>
      <div class="lb-empty-h">${esc(head)}</div>
      <div class="lb-empty-s">${esc(sub)}</div>
      ${canFriends ? '<button class="btn btn-ghost" data-act="friends">Add friends</button>' : ''}
    </div>`;
}

function sourceHtml(data) {
  if (!data) {
    return '<span class="chip">Checking</span><span class="src-txt">Looking for a server…</span>';
  }
  if (data.source === 'server') {
    return `<span class="chip live">Live</span><span class="src-txt" data-ago="${data.updated}">updated ${esc(agoText(data.updated))}</span>`;
  }
  return `<span class="chip local">Local</span><span class="src-txt">— not connected to a server. Showing your own history.</span>`;
}

function bodyHtml(data, shell, profile) {
  if (!data.entries.length) return emptyHtml(data, shell);
  const top = data.entries.slice(0, 3);
  const rest = data.entries.slice(3, 3 + MAX_LIST);
  const shown = new Set([...top, ...rest]);
  const me = data.me || (data.source === 'server' ? {
    // On a server board we have not reached yet, say so plainly rather than
    // quietly leaving the player unable to find themselves.
    id: profile.data.id,
    name: profile.data.name || 'Player',
    level: profile.data.level,
    rank: null, value: null, isMe: true, unknown: true,
    note: 'Not on this board yet — finish a match',
  } : null);
  const pinned = me && !shown.has(me);
  return `
    ${podiumHtml(top, data.metric)}
    ${rest.length ? `<div class="panel panel-flush lb-list"><div class="rows">${
      rest.map((e) => rowHtml(e, data.metric)).join('')
    }</div></div>` : ''}
    ${data.note ? `<p class="lb-note tiny muted">${esc(data.note)}</p>` : ''}
    ${pinned ? `<div class="pin-wrap"><div class="pin-label tiny muted">Your position</div><div class="panel panel-flush"><div class="rows">${rowHtml(me, data.metric)}</div></div></div>` : ''}`;
}

/* =========================================================== registration === */

export function registerLeaderboard(shell, deps = {}) {
  const profile = deps.profile || globalProfile;

  const state = {
    board: 'global',
    metric: 'totalScore',
    data: null,
    loading: false,
    token: 0,
    timer: null,
  };

  const tabsHtml = () => `
    <div class="tabs boards" role="tablist" aria-label="Board">
      ${BOARDS.map((b) => `<button role="tab" data-board="${b}" aria-selected="${b === state.board}">${esc(BOARD_LABELS[b])}</button>`).join('')}
    </div>
    <div class="tabs metrics" role="tablist" aria-label="Ranked by">
      ${METRICS.map((m) => `<button role="tab" data-metric="${m.id}" aria-selected="${m.id === state.metric}" aria-label="${esc(m.label)}">${esc(m.short)}</button>`).join('')}
    </div>`;

  shell.register('leaderboard', {
    title: 'Leaderboards',

    render({ params }) {
      if (params && BOARDS.includes(params.board)) state.board = params.board;
      if (params && METRICS.some((m) => m.id === params.metric)) state.metric = params.metric;
      return page({
        title: 'Leaderboards',
        actions: '<button class="icon-btn" data-act="refresh" aria-label="Refresh board">&#8635;</button>',
        body: `
          <div class="wrap lb">
            ${tabsHtml()}
            <div class="lb-source" data-src="loading">${sourceHtml(null)}</div>
            <div class="lb-body">${skeletonHtml()}</div>
          </div>`,
      });
    },

    mount(root) {
      wireNav(root, shell);
      const bodyEl = root.querySelector('.lb-body');
      const srcEl = root.querySelector('.lb-source');

      const paint = () => {
        const d = state.data;
        srcEl.dataset.src = state.loading && !d ? 'loading' : (d ? d.source : 'loading');
        srcEl.innerHTML = sourceHtml(state.loading && !d ? null : d);
        if (state.loading && !d) { bodyEl.innerHTML = skeletonHtml(); return; }
        if (!d) return;
        bodyEl.innerHTML = bodyHtml(d, shell, profile);
        // Stagger the entrance so the podium builds instead of appearing.
        const rows = bodyEl.querySelectorAll('.lb-list .row');
        for (let i = 0; i < rows.length && i < 14; i++) {
          rows[i].style.setProperty('--d', `${i * 26}ms`);
          rows[i].classList.add('in');
        }
      };

      const refresh = async (force) => {
        const mine = ++state.token;
        state.loading = true;
        const btn = root.querySelector('[data-act="refresh"]');
        if (btn) btn.classList.add('spin');
        if (force) state.data = null;
        paint();
        let d;
        try {
          d = await load({ board: state.board, metric: state.metric, force });
        } catch {
          // load() is written not to throw, but a screen must never die on it.
          d = {
            board: state.board, metric: state.metric, source: 'local', updated: Date.now(),
            entries: localBoard(state.metric), note: '', error: 'load failed', me: null,
          };
          d.me = d.entries.find((e) => e.isMe) || null;
        }
        if (mine !== state.token || !root.isConnected) return;
        state.loading = false;
        state.data = d;
        if (btn) btn.classList.remove('spin');
        paint();
      };

      root.addEventListener('click', (e) => {
        const b = e.target.closest('[data-board]');
        if (b) {
          if (b.dataset.board === state.board) return;
          state.board = b.dataset.board;
          for (const t of root.querySelectorAll('[data-board]')) {
            t.setAttribute('aria-selected', String(t.dataset.board === state.board));
          }
          state.data = null;
          refresh(false);
          return;
        }
        const m = e.target.closest('[data-metric]');
        if (m) {
          if (m.dataset.metric === state.metric) return;
          state.metric = m.dataset.metric;
          for (const t of root.querySelectorAll('[data-metric]')) {
            t.setAttribute('aria-selected', String(t.dataset.metric === state.metric));
          }
          state.data = null;
          refresh(false);
          return;
        }
        const a = e.target.closest('[data-act]');
        if (!a) return;
        if (a.dataset.act === 'refresh') {
          refresh(true);
          shell.toast(`Refreshing ${getMetric(state.metric).label.toLowerCase()}…`, 'info', 1200);
        } else if (a.dataset.act === 'friends' && shell.has('friends')) {
          shell.go('friends');
        }
      });

      // One cheap ticker keeps "updated 12s ago" honest. It no-ops on a local
      // board, where there is no freshness to report.
      state.timer = setInterval(() => {
        if (!root.isConnected || !state.data || state.data.source !== 'server') return;
        const t = srcEl.querySelector('[data-ago]');
        if (!t) return;
        const next = `updated ${agoText(Number(t.dataset.ago))}`;
        if (t.textContent !== next) t.textContent = next;
      }, 1000);

      // Get our own row onto the server board before anyone reads it. Silent:
      // a player who never asked about matchmaking should not see it fail.
      push();
      refresh(false);
    },

    unmount() {
      if (state.timer) { clearInterval(state.timer); state.timer = null; }
      state.token++;                       // strand any in-flight paint
      state.loading = false;
    },

    onProfileChange(root) {
      // Only the local board is derived from the profile; a server board would
      // need a refetch, and silently refetching on every coin change is rude.
      if (!state.data || state.data.source !== 'local') return;
      const all = localBoard(state.metric);
      const entries = state.data.board === 'friends' ? all : all.filter((e) => !e.unknown);
      state.data = { ...state.data, entries, me: entries.find((e) => e.isMe) || null };
      const bodyEl = root.querySelector('.lb-body');
      if (bodyEl) bodyEl.innerHTML = bodyHtml(state.data, shell, profile);
    },
  });

  return shell;
}
