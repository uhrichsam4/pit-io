/**
 * REWARDS — the progression hub. Level, dailies, streak, season, achievements.
 *
 * One long scrolling page rather than tabs: everything here is a reason to keep
 * playing, and a reward hidden behind a tab the player never opens is a reward
 * that did not happen. The chip row at the top jumps between sections so the
 * page stays navigable on a phone without hiding anything.
 *
 * All state lives in src/meta/progression.js. This file renders it and calls
 * claim functions — it never computes a reward itself.
 */

import { esc, shortNum, page, wireNav } from '../shell.js';
import { profile } from '../../meta/profile.js';
import * as progression from '../../meta/progression.js';

const RARITY_VAR = {
  common: 'var(--r-common)',
  rare: 'var(--r-rare)',
  epic: 'var(--r-epic)',
  legendary: 'var(--r-legendary)',
  mythic: 'var(--r-mythic)',
};

/** hh:mm:ss, always two digits, for the reroll countdown. */
function hms(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}`;
}

/** "12d 4h" / "4h 20m" / "18m" — a season end date nobody has to do maths on. */
function coarseTime(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(t / 86400);
  const h = Math.floor((t % 86400) / 3600);
  const m = Math.floor((t % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function pct(v) { return `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`; }

function dateShort(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: '2-digit' });
}

/* ------------------------------------------------------------- sections --- */

function levelCard(prog) {
  const L = prog.levelState();
  const name = profile.data.name || 'Player';
  return `
    <section class="panel lvl-card rv-in" style="--d:0ms">
      <div class="lvl-row">
        <div class="lvl-ring" style="--p:${pct(L.pct)}">
          <div class="lvl-core">
            <b class="num">${L.level}</b>
            <span>LVL</span>
          </div>
        </div>
        <div class="lvl-meta">
          <div class="lvl-name">${esc(name)}</div>
          <div class="bar xp"><i style="width:${pct(L.pct)}"></i></div>
          <div class="lvl-sub">
            <span class="num">${L.xp.toLocaleString()} / ${L.need.toLocaleString()} XP</span>
            <span class="muted">${L.remaining.toLocaleString()} XP to level ${L.level + 1}</span>
          </div>
        </div>
      </div>
    </section>`;
}

function challengeCard(c, i, prog) {
  const p = Math.min(c.progress, c.goal);
  const done = c.progress >= c.goal;
  const track = prog.TRACKS[c.track] || { icon: '🎯' };
  const modeChip = c.modes
    ? `<span class="chip ch-mode">${esc(c.modes.map(modeName).join(' / '))}</span>`
    : '';

  let action;
  if (c.claimed) action = '<div class="ch-done" aria-label="Claimed">✓</div>';
  else if (done) action = `<button class="btn btn-sun ch-claim" data-claim="${esc(c.id)}">CLAIM</button>`;
  else action = '';

  return `
    <article class="ch-card${done ? ' is-done' : ''}${c.claimed ? ' is-claimed' : ''} rv-in" style="--d:${60 + i * 45}ms">
      <div class="ch-ico" aria-hidden="true">${track.icon}</div>
      <div class="ch-body">
        <div class="ch-text">${esc(c.text)}</div>
        <div class="bar ch-bar"><i style="width:${pct(p / Math.max(1, c.goal))}"></i></div>
        <div class="ch-foot">
          <span class="num ch-prog">${fmtGoal(p, c)} / ${fmtGoal(c.goal, c)}</span>
          <span class="ch-rew">+${c.reward.xp} XP<i>·</i>🪙 ${c.reward.coins}</span>
        </div>
        ${modeChip}
      </div>
      ${action}
    </article>`;
}

/** Survive is stored in seconds and read as minutes; hole size gets its unit. */
function fmtGoal(v, c) {
  if (c.track === 'survive') return `${Math.floor(v / 60)}m`;
  if (c.track === 'bigHole') return `${Math.round(v)}m`;
  if (v >= 10000) return shortNum(v);
  return String(Math.round(v));
}

const MODE_NAMES = {
  classic: 'Classic',
  'car-crunch': 'Car Crunch',
  'crowd-control': 'Crowd Control',
  'building-rush': 'Building Rush',
  'last-hole': 'Last Hole',
  'team-devour': 'Team Devour',
  'neon-nights': 'Neon Nights',
  'rush-hour': 'Rush Hour',
};
function modeName(id) { return MODE_NAMES[id] || id; }

function dailySection(prog) {
  const list = prog.challengeState();
  const allClaimed = list.every((c) => c.claimed);
  return `
    <section id="sec-daily" class="rv-sec">
      <div class="sec-head">
        <h2>Daily Challenges</h2>
        <span class="chip sun" data-countdown title="Time until new challenges">⏳ <b class="num">${hms(prog.msUntilReroll())}</b></span>
      </div>
      <div class="stack-sm">
        ${list.map((c, i) => challengeCard(c, i, prog)).join('')}
      </div>
      ${allClaimed ? '<div class="daily-clear">All three cleared. Fresh set at midnight.</div>' : ''}
    </section>`;
}

function streakSection(prog) {
  const s = prog.streakState();
  const dots = s.days.map((d) => {
    const cls = [
      'wk-day',
      d.played ? 'played' : '',
      d.isToday ? 'today' : '',
      d.isTomorrow ? 'tomorrow' : '',
    ].filter(Boolean).join(' ');
    return `
      <div class="${cls}">
        <span class="wk-dot">${d.played ? '🔥' : d.isTomorrow ? '＋' : ''}</span>
        <span class="wk-lab">${d.label}</span>
      </div>`;
  }).join('');

  return `
    <section id="sec-streak" class="panel rv-sec">
      <div class="sec-head">
        <h2>Daily Streak</h2>
        <span class="chip hot">🔥 <b class="num">${s.current}</b> day${s.current === 1 ? '' : 's'}</span>
      </div>
      <div class="week">${dots}</div>
      <div class="wk-foot">
        <span class="muted tiny">Best streak <b class="num">${s.best}</b> days</span>
        <span class="tiny wk-cta">Play tomorrow to keep it alive</span>
      </div>
    </section>`;
}

function tierRewardHtml(reward) {
  if (reward.item) {
    const col = RARITY_VAR[reward.item.rarity] || 'var(--r-common)';
    return `
      <div class="tr-item" style="--rc:${col}">
        <span class="tr-item-glyph">🎁</span>
        <span class="tr-item-name">${esc(reward.item.name)}</span>
      </div>`;
  }
  if (reward.coins) return `<div class="tr-coins">🪙 <b class="num">${reward.coins}</b></div>`;
  if (reward.xp) return `<div class="tr-xp">⭐ <b class="num">${reward.xp}</b> XP</div>`;
  return '<div class="tr-coins">—</div>';
}

function seasonSection(prog) {
  const S = prog.SEASON;
  const sp = prog.seasonProgress();
  const claimedSet = new Set(sp.claimed);
  const claimableSet = new Set(sp.claimable);

  const cards = S.tiers.map((t) => {
    const state = claimedSet.has(t.tier) ? 'claimed'
      : claimableSet.has(t.tier) ? 'claimable'
        : 'locked';
    const isItem = !!t.reward.item;
    return `
      <article class="tr ${state}${isItem ? ' tr-big' : ''}" data-tier="${t.tier}">
        <div class="tr-head">
          <span class="tr-n num">${t.tier}</span>
          ${state === 'claimed' ? '<span class="tr-tick">✓</span>' : ''}
        </div>
        ${tierRewardHtml(t.reward)}
        ${state === 'claimable'
          ? `<button class="btn btn-sun tr-claim" data-season="${t.tier}">CLAIM</button>`
          : `<div class="tr-at num">${shortNum(t.at)} XP</div>`}
      </article>`;
  }).join('');

  const ready = sp.claimable.length;
  return `
    <section id="sec-season" class="rv-sec">
      <div class="panel season-head" style="--cc:${esc(S.accent)}">
        <div class="sh-top">
          <div class="sh-title">
            <div class="sh-name">${esc(S.name)}</div>
            <div class="sh-blurb muted tiny">${esc(S.blurb)}</div>
          </div>
          <span class="chip sh-ends">Ends in ${coarseTime(sp.endsInMs)}</span>
        </div>
        <div class="sh-bar">
          <div class="bar"><i style="width:${pct(sp.pct)}"></i></div>
          <div class="sh-sub">
            <span><b class="num">TIER ${sp.tier}</b> / ${S.tiers.length}</span>
            <span class="muted num">${sp.next ? `${(sp.next.at - sp.xp).toLocaleString()} XP to tier ${sp.next.tier}` : 'Track complete'}</span>
          </div>
        </div>
        ${ready ? `
        <div class="sh-ready">
          <span><b class="num">${ready}</b> reward${ready === 1 ? '' : 's'} waiting</span>
          <button class="btn btn-sun" data-season-all>CLAIM ALL</button>
        </div>` : ''}
        <div class="sh-free tiny">Free track — every tier is earned by playing.</div>
      </div>
      <div class="rail" data-rail>${cards}</div>
    </section>`;
}

function achievementsSection(prog) {
  const all = prog.achievementState();
  const counts = prog.achievementCounts();

  const groups = prog.ACHIEVEMENT_TIERS.map((t) => {
    const items = all.filter((a) => a.tier === t.id);
    if (!items.length) return '';
    const got = items.filter((a) => a.unlocked).length;
    const cards = items.map((a) => `
      <article class="ach${a.unlocked ? ' got' : ''}" style="--tc:${t.color}">
        <div class="ach-ico" aria-hidden="true">${a.icon}</div>
        <div class="ach-name">${esc(a.name)}</div>
        <div class="ach-desc">${esc(a.desc)}</div>
        <div class="ach-foot">${a.unlocked
          ? `<span class="ach-date">${esc(dateShort(a.at))}</span>`
          : `<span class="ach-rew">+${a.reward.xp} XP</span>`}</div>
      </article>`).join('');
    return `
      <div class="ach-group">
        <h3 style="--tc:${t.color}">${t.label} <span class="num">${got}/${items.length}</span></h3>
        <div class="ach-grid">${cards}</div>
      </div>`;
  }).join('');

  return `
    <section id="sec-ach" class="rv-sec">
      <div class="sec-head">
        <h2>Achievements</h2>
        <span class="chip aqua num">${counts.unlocked} / ${counts.total}</span>
      </div>
      <div class="bar ach-total"><i style="width:${pct(counts.unlocked / counts.total)}"></i></div>
      ${groups}
    </section>`;
}

/**
 * @param {object} prog progression module
 * @param {boolean} animate entrance stagger. Off on rebuilds — replaying the
 *        whole page's pop-in every time a reward is claimed reads as a glitch.
 */
function bodyHtml(prog, animate) {
  return `<div class="wrap stack rv-root${animate ? ' anim' : ''}">
      ${levelCard(prog)}
      <nav class="jump" aria-label="Jump to section">
        <button class="jump-chip" data-jump="sec-daily">Daily</button>
        <button class="jump-chip" data-jump="sec-streak">Streak</button>
        <button class="jump-chip" data-jump="sec-season">Season</button>
        <button class="jump-chip" data-jump="sec-ach">Awards</button>
      </nav>
      ${dailySection(prog)}
      ${streakSection(prog)}
      ${seasonSection(prog)}
      ${achievementsSection(prog)}
    </div>`;
}

/* ---------------------------------------------------------------- screen --- */

/**
 * @param {import('../shell.js').Shell} shell
 * @param {{progression?:object}} [deps]
 */
export function registerRewards(shell, deps = {}) {
  const prog = deps.progression || progression;

  shell.register('rewards', {
    title: 'Rewards',

    render() {
      return page({
        title: 'Rewards',
        actions: `
          <span class="chip sun coin-chip">🪙 <b class="num" data-coins>${shortNum(profile.data.coins)}</b></span>
          <button class="icon-btn" data-nav="settings" aria-label="Settings">⚙</button>`,
        body: bodyHtml(prog, true),
      });
    },

    mount(root) {
      wireNav(root, shell);
      const body = root.querySelector('.page-body');

      // Rebuild in place. Scroll positions are captured first because the whole
      // point of a claim is that the player stays exactly where they were.
      const rebuild = () => {
        const host = root.querySelector('.rv-root');
        if (!host) return;
        const top = body ? body.scrollTop : 0;
        const rail = root.querySelector('[data-rail]');
        const railX = rail ? rail.scrollLeft : 0;

        host.outerHTML = bodyHtml(prog, false);

        const coins = root.querySelector('[data-coins]');
        if (coins) coins.textContent = shortNum(profile.data.coins);
        if (body) body.scrollTop = top;
        const rail2 = root.querySelector('[data-rail]');
        if (rail2) rail2.scrollLeft = railX;
        // The rebuild happens long after Shell._enforceTapTargets ran, so the
        // new buttons need the 44 px floor applied again.
        for (const b of root.querySelectorAll('button')) b.style.minHeight = 'var(--tap)';
      };

      // A single claim fires several profile saves (xp, coins, achievements),
      // and each one emits. Coalescing to one rebuild per frame keeps that from
      // becoming four full re-renders of a 60-card page.
      let pending = 0;
      const refresh = () => {
        if (pending) return;
        pending = requestAnimationFrame(() => { pending = 0; rebuild(); });
      };
      root.__refresh = refresh;
      root.__cancelRefresh = () => { if (pending) cancelAnimationFrame(pending); pending = 0; };

      const scrollToTier = () => {
        const rail = root.querySelector('[data-rail]');
        if (!rail) return;
        const sp = prog.seasonProgress();
        const target = rail.querySelector(`[data-tier="${Math.max(1, sp.tier)}"]`)
          || rail.querySelector('[data-tier]');
        if (target) rail.scrollLeft = Math.max(0, target.offsetLeft - rail.clientWidth * 0.28);
      };
      requestAnimationFrame(scrollToTier);

      root.addEventListener('click', (e) => {
        const claim = e.target.closest('[data-claim]');
        if (claim) {
          const id = claim.dataset.claim;
          const c = prog.challengeState().find((x) => x.id === id);
          if (prog.claimChallenge(id)) {
            shell.toast(c ? `+${c.reward.xp} XP · ${c.reward.coins} coins` : 'Claimed', 'ok');
          } else {
            shell.toast('Already claimed', 'info');
          }
          refresh();
          return;
        }

        const tier = e.target.closest('[data-season]');
        if (tier) {
          const n = Number(tier.dataset.season);
          const def = prog.SEASON.tiers.find((t) => t.tier === n);
          if (prog.claimSeason(n)) {
            const r = def ? def.reward : {};
            const what = r.item ? r.item.name : r.coins ? `${r.coins} coins` : `${r.xp} XP`;
            shell.toast(`Tier ${n} claimed — ${what}`, 'ok');
          } else {
            shell.toast('Tier not available', 'bad');
          }
          refresh();
          return;
        }

        if (e.target.closest('[data-season-all]')) {
          const pending = prog.seasonProgress().claimable;
          let n = 0;
          for (const t of pending) if (prog.claimSeason(t)) n++;
          shell.toast(n ? `Claimed ${n} season reward${n === 1 ? '' : 's'}` : 'Nothing to claim', n ? 'ok' : 'info');
          refresh();
          return;
        }

        const jump = e.target.closest('[data-jump]');
        if (jump) {
          const sec = root.querySelector(`#${jump.dataset.jump}`);
          if (sec && body) {
            body.scrollTo({
              top: Math.max(0, sec.offsetTop - 8),
              behavior: profile.data.settings.reducedMotion ? 'auto' : 'smooth',
            });
          }
        }
      });

      // One timer for the whole screen: ticks the reroll countdown and rebuilds
      // once when the local day turns over so a lobby left open overnight shows
      // tomorrow's challenges instead of yesterday's dead ones.
      let lastRemaining = prog.msUntilReroll();
      root.__timer = setInterval(() => {
        const remaining = prog.msUntilReroll();
        const el = root.querySelector('[data-countdown] b');
        if (el) el.textContent = hms(remaining);
        if (remaining > lastRemaining) refresh();   // wrapped past midnight
        lastRemaining = remaining;
      }, 1000);
    },

    unmount(root) {
      if (root.__timer) { clearInterval(root.__timer); root.__timer = null; }
      if (root.__cancelRefresh) root.__cancelRefresh();
      root.__refresh = null;
      root.__cancelRefresh = null;
    },

    onProfileChange(root) {
      if (root.__refresh) root.__refresh();
    },
  });

  return shell;
}

export default registerRewards;
