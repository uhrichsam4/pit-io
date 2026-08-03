/**
 * Full-screen overlays: loading, title/menu, countdown and results.
 * BASELINE — expected to be replaced with a AAA pass.
 */

export class Screens {
  constructor(root) {
    this.root = root;
    const el = document.createElement('div');
    el.id = 'screens';
    el.style.position = 'absolute';
    el.style.inset = '0';
    el.style.pointerEvents = 'none';
    root.appendChild(el);
    this.el = el;
    this.onPlay = null;
    this.showLoading('Building Miami…');
  }

  clear() { this.el.innerHTML = ''; this.el.style.pointerEvents = 'none'; }

  showLoading(text = 'Loading…') {
    this.el.innerHTML = `
      <div id="loading">
        <div class="spin"></div>
        <div style="opacity:.75;font-size:15px;letter-spacing:.4px">${text}</div>
      </div>`;
    this.el.style.pointerEvents = 'auto';
  }

  showMenu(stats = {}) {
    this.el.innerHTML = `
      <div class="screen">
        <h1>MIAMI<br/>DEVOUR</h1>
        <p>You are a hole in Brickell. Swallow the city — cones first, then cars,
           then the towers themselves. Eat rivals. Be the biggest before the clock runs out.</p>
        <button class="btn" id="play-btn">PLAY</button>
        <div class="hint">WASD / arrows / drag to move &nbsp;·&nbsp; ${stats.objects ?? ''} objects in the city</div>
      </div>`;
    this.el.style.pointerEvents = 'auto';
    const b = this.el.querySelector('#play-btn');
    b.addEventListener('click', () => { if (this.onPlay) this.onPlay(); });
  }

  showCountdown(n) {
    const label = n <= 0 ? 'GO!' : String(Math.ceil(n));
    this.el.innerHTML = `
      <div class="screen" style="background:transparent;backdrop-filter:none">
        <h1 style="font-size:clamp(70px,16vw,180px)">${label}</h1>
      </div>`;
    this.el.style.pointerEvents = 'none';
  }

  showResults(rankings, me) {
    const rank = rankings.findIndex((h) => h === me) + 1;
    const suffix = rank === 1 ? 'st' : rank === 2 ? 'nd' : rank === 3 ? 'rd' : 'th';
    this.el.innerHTML = `
      <div class="screen">
        <h1>${rank}${suffix} PLACE</h1>
        <div class="results panel" style="padding:14px">
          ${rankings.slice(0, 8).map((h, i) => `
            <div class="row ${h === me ? 'me' : ''}">
              <span class="rank">${i + 1}</span>
              <span class="dot" style="background:#${h.color.getHexString()}"></span>
              <span class="nm">${h.name}</span>
              <span class="sc">${Math.round(h.score).toLocaleString()}</span>
            </div>`).join('')}
        </div>
        <button class="btn" id="again-btn">PLAY AGAIN</button>
      </div>`;
    this.el.style.pointerEvents = 'auto';
    this.el.querySelector('#again-btn').addEventListener('click', () => {
      if (this.onPlay) this.onPlay();
    });
  }
}
