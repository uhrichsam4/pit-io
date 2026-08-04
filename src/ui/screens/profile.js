/**
 * PROFILE SCREEN — who the player is, everything they have done, and the one
 * button that undoes all of it.
 *
 * Every number on this screen comes from profile.data. Nothing is estimated and
 * nothing is invented: a stat the player has never generated shows "—" rather
 * than a plausible zero-with-a-percentage, and "member since" is absent because
 * the profile model has no creation timestamp to derive it from. Inventing one
 * would be a lie that looks like a feature.
 *
 * The whole body re-renders from one builder, so onProfileChange after a
 * purchase, an equip or a reset needs no diffing. Clicks are delegated from the
 * page root, which survives that re-render.
 */

import { page, esc, shortNum, wireNav, icon, emptyState } from '../shell.js';
import { ic, modeIcon } from '../icons.js';
import { profile as globalProfile, xpForLevel } from '../../meta/profile.js';
import { listModes, getMode } from '../../gameplay/modes.js';
import { rankBadge } from '../../meta/leaderboard.js';
import { getItem, previewSVG, RARITY } from '../../meta/cosmetics.js';
import '../css/profile.css';

const AV_COLORS = ['#ff3d8b', '#ffc93c', '#37e6d5', '#4dff9e', '#ff9430', '#b46bff', '#4dc4ff'];

/** The equipped strip, in the order a player thinks about their look. */
const COSMETIC_KINDS = [
  { kind: 'skin', label: 'Skin' },
  { kind: 'trail', label: 'Trail' },
  { kind: 'rim', label: 'Rim' },
  { kind: 'nameplate', label: 'Plate' },
  { kind: 'icon', label: 'Icon' },
];

function hashOf(s) {
  let h = 0;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function colorFor(id) { return AV_COLORS[hashOf(id) % AV_COLORS.length]; }

/**
 * The equipped item, from the CATALOGUE.
 *
 * This screen used to invent both halves of the Equipped strip: a swatch
 * colour hashed out of the item id, and a name derived from the id string.
 * Both were lies. A player wearing Classic Void — hot pink lip — saw a purple
 * ball; Sunset Drive rendered teal; the hand-drawn Flamingo emblem became the
 * letter "F"; and every name disagreed with the one the store had just shown
 * them. cosmetics.js already draws all sixty items correctly at any size, so
 * there was never a reason to guess.
 */
function equippedItem(id) { return id ? getItem(id) : null; }

function pct(part, whole) {
  if (!whole) return '—';
  return `${Math.round((part / whole) * 100)}%`;
}

function duration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

/* --------------------------------------------------------- achievements --- */

/**
 * Pull an achievement list out of whatever shape the progression module
 * exposes. `achievementState()` is preferred because it carries the unlock
 * flags with it; the array exports are the fallback for a progression module
 * that only publishes its content. Returns null when there is nothing to show,
 * which makes the caller omit the section entirely rather than render an empty
 * box the player can never fill.
 */
function collectAchievements(progression) {
  if (!progression) return null;
  let raw = null;
  if (typeof progression.achievementState === 'function') {
    try {
      const r = progression.achievementState();
      if (Array.isArray(r) && r.length) raw = r;
    } catch { /* fall through to the plain lists */ }
  }
  if (!raw) {
    for (const k of ['ACHIEVEMENTS', 'achievements', 'ALL_ACHIEVEMENTS', 'list', 'listAchievements']) {
      const v = progression[k];
      if (Array.isArray(v) && v.length) { raw = v; break; }
      if (typeof v === 'function') {
        try {
          const r = v.call(progression);
          if (Array.isArray(r) && r.length) { raw = r; break; }
        } catch { /* wrong function, keep looking */ }
      }
    }
  }
  if (!raw || !raw.length) return null;

  const tiers = Array.isArray(progression.ACHIEVEMENT_TIERS) ? progression.ACHIEVEMENT_TIERS : [];
  return raw.map((a, i) => {
    if (!a || typeof a !== 'object') return null;
    const tier = tiers.find((t) => t.id === a.tier);
    return {
      id: a.id || a.key || `ach-${i}`,
      name: a.name || a.title || a.label || 'Achievement',
      req: a.requirement || a.desc || a.description || a.blurb || a.hint || '',
      icon: typeof a.icon === 'string' && a.icon.length <= 4 ? a.icon : '🏅',
      color: (tier && tier.color) || '',
      unlocked: typeof a.unlocked === 'boolean' ? a.unlocked : null,
      goal: Number(a.goal || a.target || 0) || 0,
      stat: a.stat || a.metric || '',
      progressFn: typeof a.progress === 'function' ? a.progress : null,
    };
  }).filter(Boolean);
}

/** 0..1, or null when we genuinely cannot tell how far along the player is. */
function achProgress(a, profile) {
  if (a.progressFn) {
    try {
      const v = a.progressFn(profile);
      if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.min(1, v > 1 && a.goal ? v / a.goal : v));
      if (v && typeof v === 'object' && Number.isFinite(Number(v.value))) {
        const goal = Number(v.goal || a.goal || 0);
        if (goal > 0) return Math.max(0, Math.min(1, Number(v.value) / goal));
      }
    } catch { /* an achievement that throws simply has no bar */ }
  }
  if (a.goal > 0 && a.stat && Number.isFinite(Number(profile.data.stats[a.stat]))) {
    return Math.max(0, Math.min(1, Number(profile.data.stats[a.stat]) / a.goal));
  }
  return null;
}

/* =========================================================== registration === */

export function registerProfile(shell, deps = {}) {
  const profile = deps.profile || globalProfile;
  const progression = deps.progression || null;

  let copyTimer = null;

  const avatar = (cls = '') => {
    const d = profile.data;
    const initial = String(d.name || 'P').trim().charAt(0).toUpperCase() || 'P';
    const art = d.icon ? previewSVG(d.icon, 96) : '';
    return `<span class="avatar ${art ? 'art ' : ''}${cls}" style="--ac:${colorFor(d.icon || d.id)};--rc:var(--sun)">` +
      `${art || esc(initial)}</span>`;
  };

  const headHtml = () => {
    const d = profile.data;
    const badge = rankBadge({ wins: d.stats.wins, totalScore: d.stats.totalScore, matches: d.stats.matches });
    const need = xpForLevel(d.level);
    const p = Math.max(0, Math.min(1, d.xp / Math.max(1, need)));
    // 2πr for r=44 in the ring's 100x100 viewBox.
    const CIRC = 276.46;
    return `
      <section class="panel pf-head">
        <div class="pf-id">
          <div class="lvl-ring">
            <svg viewBox="0 0 100 100" aria-hidden="true">
              <circle class="trk" cx="50" cy="50" r="44"></circle>
              <circle class="val" cx="50" cy="50" r="44"
                      style="stroke-dasharray:${(p * CIRC).toFixed(2)} ${CIRC}"></circle>
            </svg>
            ${avatar('xl')}
            <span class="lvl-num">${d.level}</span>
          </div>
          <div class="pf-meta">
            <h2 class="pf-name">${esc(d.name || 'Player')}</h2>
            <div class="pf-chips">
              <span class="tier-badge" style="--tc:${badge.color}"><i></i>${esc(badge.label)}</span>
              <span class="chip sun">${icon('coin')} ${esc(shortNum(d.coins))}</span>
              ${d.streak.days > 1 ? `<span class="chip hot">🔥 ${d.streak.days}-day streak</span>` : ''}
            </div>
            <div class="pf-xp">
              <div class="bar xp"><i style="width:${(p * 100).toFixed(1)}%"></i></div>
              <span class="tiny muted num">${esc(shortNum(d.xp))} / ${esc(shortNum(need))} XP to level ${d.level + 1}</span>
            </div>
          </div>
        </div>
        <button class="code-btn tappable" data-act="copy-code" aria-label="Copy friend code ${esc(d.id)}">
          <span class="code-k">Friend code</span>
          <span class="code-v num">${esc(d.id)}</span>
          <span class="code-ico" aria-hidden="true">⧉</span>
        </button>
      </section>`;
  };

  const cosmeticsHtml = () => {
    const eq = profile.data.equipped || {};
    const tiles = COSMETIC_KINDS.map(({ kind, label }) => {
      const id = eq[kind] || '';
      const it = equippedItem(id);
      const name = it ? it.name : 'None';
      const rc = it && RARITY[it.rarity] ? RARITY[it.rarity].color : 'var(--stroke-hi)';
      return `
        <button class="cos rarity-${esc(it ? it.rarity : 'common')}" data-cos="${esc(kind)}"
                style="--cc:${esc(rc)}"
                aria-label="${esc(label)}: ${esc(name)}. Change in store">
          <span class="cos-pv">${it ? previewSVG(it, 64) : ''}</span>
          <span class="cos-k">${esc(label)}</span>
          <span class="cos-v">${esc(name)}</span>
        </button>`;
    }).join('');
    return `
      <section class="pf-sec">
        <div class="sec-head"><h3>Equipped</h3><span class="tiny muted">Tap to change</span></div>
        <div class="cos-strip">${tiles}</div>
      </section>`;
  };

  const statsHtml = () => {
    const s = profile.data.stats;
    const tiles = [
      ['Matches', String(s.matches)],
      ['Wins', String(s.wins)],
      ['Win rate', pct(s.wins, s.matches)],
      ['Top 3 rate', pct(s.top3, s.matches)],
      ['Total score', shortNum(s.totalScore)],
      ['Best match', shortNum(s.bestScore)],
      ['Biggest hole', `${(Number(s.biggestHole) || 0).toFixed(1)} m`],
      ['Devoured', shortNum(s.objectsDevoured)],
      ['Rivals eaten', String(s.rivalsEaten)],
      ['Time played', duration(s.playTimeSec)],
    ];
    return `
      <section class="pf-sec">
        <div class="sec-head"><h3>Lifetime</h3></div>
        <div class="stat-grid">
          ${tiles.map(([l, v]) => `<div class="stat-tile"><span class="sv">${esc(v)}</span><span class="sl">${esc(l)}</span></div>`).join('')}
        </div>
      </section>`;
  };

  const modesHtml = () => {
    const byMode = profile.data.stats.byMode || {};
    const ids = listModes().map((m) => m.id);
    // Events and any retired mode the player actually played still deserve a
    // row — otherwise their matches vanish from their own history.
    for (const k of Object.keys(byMode)) if (!ids.includes(k)) ids.push(k);
    const rows = ids.map((id) => {
      const m = getMode(id);
      const st = byMode[id];
      const played = !!(st && st.matches);
      return `
        <div class="row mode-row${played ? '' : ' unplayed'}">
          <span class="m-ico" style="--mc:${esc(m.accent || '#37e6d5')}">${modeIcon(id, null)}</span>
          <span class="nm-wrap">
            <span class="nm">${esc(m.name)}</span>
            <span class="sub">${played
              ? `${st.matches} played · ${st.wins} ${st.wins === 1 ? 'win' : 'wins'}`
              : 'Not played yet'}</span>
          </span>
          <span class="sc">${played ? esc(shortNum(st.bestScore)) : '—'}</span>
        </div>`;
    }).join('');
    return `
      <section class="pf-sec">
        <div class="sec-head"><h3>By mode</h3><span class="tiny muted">Best score</span></div>
        <div class="panel panel-flush"><div class="rows">${rows}</div></div>
      </section>`;
  };

  const achievementsHtml = () => {
    const list = collectAchievements(progression);
    if (!list) return '';
    const unlockedMap = profile.data.achievements || {};
    let unlocked = 0;
    const cells = list.map((a) => {
      const done = a.unlocked != null ? a.unlocked : !!unlockedMap[a.id];
      if (done) unlocked++;
      const prog = done ? 1 : achProgress(a, profile);
      const bar = (!done && prog != null)
        ? `<div class="bar ach-bar"><i style="width:${(prog * 100).toFixed(0)}%"></i></div>` : '';
      const tint = done && a.color ? ` style="--tc:${esc(a.color)}"` : '';
      return `
        <div class="ach${done ? ' done' : ' locked'}"${tint}>
          <span class="ach-ico" aria-hidden="true">${esc(a.icon)}</span>
          <span class="ach-nm">${esc(a.name)}</span>
          ${a.req ? `<span class="ach-rq">${esc(a.req)}</span>` : ''}
          ${bar}
        </div>`;
    }).join('');
    return `
      <section class="pf-sec">
        <div class="sec-head"><h3>Achievements</h3><span class="tiny muted num">${unlocked} / ${list.length}</span></div>
        <div class="ach-grid">${cells}</div>
      </section>`;
  };

  /**
   * The screen a brand-new player is invited to open from the lobby was the
   * deadest one in the app: ten stat tiles reading 0 / 0 / — / — / 0, seven
   * identical dimmed "Not played yet" rows, then thirty grey achievement
   * cards. None of it is information — it is a spreadsheet of zeros wearing a
   * progress screen's clothes. Until there is a match on the record the whole
   * lower half collapses to one card that says what to do next and dangles the
   * closest award.
   */
  const isFresh = () => !(profile.data.stats && profile.data.stats.matches > 0);

  /** The locked achievement the player is nearest to. Bait, and honest bait. */
  const nextAward = () => {
    const list = collectAchievements(progression);
    if (!list) return null;
    const unlockedMap = profile.data.achievements || {};
    let best = null;
    for (const a of list) {
      const done = a.unlocked != null ? a.unlocked : !!unlockedMap[a.id];
      if (done) continue;
      const p = achProgress(a, profile);
      const v = p == null ? 0 : p;
      if (!best || v > best.p) best = { a, p: v };
    }
    return best;
  };

  const freshHtml = () => {
    const award = nextAward();
    return `
      <section class="pf-sec pf-fresh">
        ${emptyState({
          art: ic('empty-hole', null),
          head: 'No matches on the record yet',
          sub: 'Play one match and this page fills up: lifetime totals, a breakdown by mode, and thirty awards to chase.',
          cta: 'Pick a mode and play',
          act: 'go-modes',
          accent: '#ff3d8b',
        })}
        ${award ? `
        <div class="panel pf-bait">
          <div class="bait-k">Closest award</div>
          <div class="bait-row">
            <span class="bait-ico" aria-hidden="true">${esc(award.a.icon)}</span>
            <span class="bait-txt">
              <b>${esc(award.a.name)}</b>
              ${award.a.req ? `<i>${esc(award.a.req)}</i>` : ''}
            </span>
          </div>
          <div class="bar bait-bar"><i style="width:${(award.p * 100).toFixed(0)}%"></i></div>
        </div>` : ''}
      </section>`;
  };

  const dangerHtml = () => `
    <section class="pf-danger">
      <button class="btn btn-ghost danger" data-act="reset">Reset progress</button>
      <p class="tiny muted">Wipes level, coins, cosmetics and every stat on this device. This cannot be undone.</p>
    </section>`;

  const contentHtml = () => (isFresh()
    ? `${headHtml()}${cosmeticsHtml()}${freshHtml()}${dangerHtml()}`
    : `${headHtml()}${cosmeticsHtml()}${statsHtml()}${modesHtml()}${achievementsHtml()}${dangerHtml()}`);

  const copyCode = async (btn) => {
    const code = profile.data.id;
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(code);
        ok = true;
      }
    } catch { ok = false; }
    if (!ok) {
      // No clipboard API on an insecure origin, which is exactly how this game
      // is served on a phone over the LAN. Fall back to the old selection copy.
      try {
        const ta = document.createElement('textarea');
        ta.value = code;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;left:-9999px;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch { ok = false; }
    }
    if (ok) {
      shell.toast(`Friend code ${code} copied`, 'ok');
      if (btn) {
        btn.classList.add('copied');
        if (copyTimer) clearTimeout(copyTimer);
        copyTimer = setTimeout(() => {
          copyTimer = null;
          if (btn.isConnected) btn.classList.remove('copied');
        }, 1400);
      }
    } else {
      shell.toast(`Your friend code is ${code}`, 'info', 3200);
    }
  };

  shell.register('profile', {
    title: 'Profile',

    render() {
      return page({
        title: 'Profile',
        body: `<div class="wrap pf">${contentHtml()}</div>`,
      });
    },

    mount(root) {
      wireNav(root, shell);

      root.addEventListener('click', async (e) => {
        const cos = e.target.closest('[data-cos]');
        if (cos) {
          if (shell.has('store')) shell.go('store', { tab: cos.dataset.cos });
          else shell.toast('The store is not available yet', 'info');
          return;
        }
        const a = e.target.closest('[data-act]');
        if (!a) return;
        if (a.dataset.act === 'go-modes') {
          if (shell.has('modes')) shell.go('modes');
          else shell.back();
        } else if (a.dataset.act === 'copy-code') {
          copyCode(a);
        } else if (a.dataset.act === 'reset') {
          const yes = await shell.confirm(
            'Reset all progress? Your level, coins, cosmetics and stats are wiped.',
            { ok: 'Reset everything', cancel: 'Keep my progress' },
          );
          if (!yes) return;
          profile.reset();
          shell.toast('Progress reset', 'ok');
        }
      });
    },

    unmount() {
      if (copyTimer) { clearTimeout(copyTimer); copyTimer = null; }
    },

    onProfileChange(root) {
      const wrap = root.querySelector('.pf');
      if (wrap) wrap.innerHTML = contentHtml();
    },
  });

  return shell;
}
