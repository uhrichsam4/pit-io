/**
 * Multiplayer client.
 *
 * Opt-in: the game only goes online when the page URL carries ?room=<name>.
 * Offline (the default) the exact same code path runs with AI opponents only,
 * so there is one game loop, not two.
 *
 * Remote holes are rendered from interpolated snapshots. We deliberately render
 * them ~100 ms in the past (one and a half server ticks) so their motion is
 * smooth rather than correct-but-jittery; for a game about being chased by a
 * big circle, smooth wins.
 */

import * as THREE from 'three';
import {
  C2S, S2C, PROTOCOL_VERSION, encode, decode, PLAYER_COLORS,
} from './protocol.js';

const INTERP_DELAY = 0.10; // seconds behind the newest snapshot

export class NetClient {
  constructor({ url, room, name }) {
    this.url = url;
    this.room = room;
    this.name = name || 'Player';
    this.connected = false;
    this.id = null;
    this.seed = null;
    this.error = null;

    /** id -> { id, name, color, buffer:[{t,x,z,r,score,alive}], hole } */
    this.peers = new Map();
    this.serverTimeLeft = null;
    this.phase = null;

    this._pendingAte = [];
    this._lastSend = 0;
    this._clockOffset = 0;
    this.rtt = 0;

    /** Consumers set these. */
    this.onWelcome = null;   // (seed, roster) => void
    this.onConsumed = null;  // (ids:number[]) => void
    this.onKill = null;      // (killerId, victimId, reward) => void
    this.onRoster = null;    // () => void
    this.onMatch = null;     // ({phase, timeLeft, seed}) => void
    this.onDisconnect = null; // () => void  — the socket dropped mid-match
  }

  connect() {
    return new Promise((resolve) => {
      let ws;
      try {
        ws = new WebSocket(`${this.url}?room=${encodeURIComponent(this.room)}`);
      } catch (e) {
        this.error = String(e);
        resolve(false);
        return;
      }
      this.ws = ws;

      const fail = (why) => {
        this.error = why;
        this.connected = false;
        resolve(false);
      };
      const timeout = setTimeout(() => fail('timeout'), 4000);

      ws.onopen = () => {
        ws.send(encode(C2S.HELLO, { name: this.name, version: PROTOCOL_VERSION }));
      };
      ws.onerror = () => { clearTimeout(timeout); fail('connection error'); };
      ws.onclose = () => {
        // Losing the socket mid-match is not a no-op: online play runs with no
        // bots, so a silent drop leaves the player alone in a city with no
        // opponents and no explanation. Tell the host so it can say so.
        const wasConnected = this.connected;
        this.connected = false;
        for (const p of this.peers.values()) p.buffer.length = 0;
        if (wasConnected && this.onDisconnect) this.onDisconnect();
      };
      ws.onmessage = (ev) => {
        const msg = decode(ev.data);
        if (!msg) return;
        if (msg.t === S2C.WELCOME) {
          clearTimeout(timeout);
          this.id = msg.d.id;
          this.seed = msg.d.seed;
          this.serverTimeLeft = msg.d.timeLeft;
          this.phase = msg.d.phase;
          for (const p of msg.d.roster) {
            if (p.id !== this.id) this._addPeer(p);
          }
          this.connected = true;
          if (this.onWelcome) this.onWelcome(msg.d.seed, msg.d.roster);
          resolve(true);
          return;
        }
        this._handle(msg);
      };
    });
  }

  _addPeer(p) {
    if (this.peers.has(p.id)) return;
    this.peers.set(p.id, {
      id: p.id,
      name: p.name,
      color: p.color ?? PLAYER_COLORS[p.id % PLAYER_COLORS.length],
      buffer: [],
      hole: null,
    });
    if (this.onRoster) this.onRoster();
  }

  _handle(msg) {
    switch (msg.t) {
      case S2C.JOIN:
        if (msg.d.id !== this.id) this._addPeer(msg.d);
        break;
      case S2C.LEAVE: {
        const p = this.peers.get(msg.d.id);
        if (p) { p.leaving = true; }
        this.peers.delete(msg.d.id);
        if (this.onRoster) this.onRoster();
        break;
      }
      case S2C.SNAPSHOT: {
        const now = performance.now() / 1000;
        for (const [id, x, z, r, score, alive] of msg.d.holes) {
          if (id === this.id) continue;
          const p = this.peers.get(id);
          if (!p) continue;
          p.buffer.push({ t: now, x, z, r, score, alive: !!alive });
          if (p.buffer.length > 24) p.buffer.shift();
        }
        if (typeof msg.d.timeLeft === 'number') this.serverTimeLeft = msg.d.timeLeft;
        break;
      }
      case S2C.CONSUMED:
        if (this.onConsumed) this.onConsumed(msg.d.ids);
        break;
      case S2C.KILL:
        if (this.onKill) this.onKill(msg.d.killerId, msg.d.victimId, msg.d.reward);
        break;
      case S2C.MATCH:
        this.phase = msg.d.phase;
        this.serverTimeLeft = msg.d.timeLeft;
        if (msg.d.seed) this.seed = msg.d.seed;
        if (this.onMatch) this.onMatch(msg.d);
        break;
      case S2C.PONG:
        this.rtt = performance.now() - msg.d.t;
        break;
      case S2C.ERROR:
        this.error = msg.d.message;
        console.warn('[net]', msg.d.message);
        break;
      default:
        break;
    }
  }

  /** Queue an object id that the local player just swallowed. */
  reportAte(id) {
    this._pendingAte.push(id);
  }

  claimKill(victimId) {
    if (!this.connected) return;
    this.ws.send(encode(C2S.CLAIM_KILL, { victimId }));
  }

  /**
   * Push local state up and advance the interpolated remote holes.
   * @param {import('../gameplay/hole.js').Hole} localHole
   */
  update(localHole, now) {
    if (!this.connected) return;

    if (now - this._lastSend > 1 / 15) {
      this._lastSend = now;
      this.ws.send(encode(C2S.STATE, {
        x: +localHole.position.x.toFixed(2),
        z: +localHole.position.z.toFixed(2),
        r: +localHole.radius.toFixed(3),
        score: Math.round(localHole.score),
      }));
      // Drain the WHOLE queue, in server-sized chunks. This used to send the
      // first 300 ids and then clear the array, so everything past 300 was
      // thrown away — and 300 is nothing: one bite of a city block at a large
      // radius queues hundreds in a single frame. The objects vanished locally
      // and stayed standing on every other client, permanently, because there
      // is no re-send and no reconciliation. Splice, so the send list and the
      // clear can never disagree.
      while (this._pendingAte.length) {
        this.ws.send(encode(C2S.ATE, { ids: this._pendingAte.splice(0, 300) }));
      }
    }

    const render = performance.now() / 1000 - INTERP_DELAY;
    for (const p of this.peers.values()) {
      if (!p.hole || p.buffer.length === 0) continue;
      const buf = p.buffer;
      let a = buf[0], b = buf[buf.length - 1];
      for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i].t <= render && buf[i + 1].t >= render) { a = buf[i]; b = buf[i + 1]; break; }
      }
      const span = Math.max(1e-4, b.t - a.t);
      const k = THREE.MathUtils.clamp((render - a.t) / span, 0, 1);
      p.hole.position.x = a.x + (b.x - a.x) * k;
      p.hole.position.z = a.z + (b.z - a.z) * k;
      p.hole.radius = a.r + (b.r - a.r) * k;
      p.hole.score = b.score;
      p.hole.alive = b.alive;
    }
  }

  disconnect() {
    if (this.ws) { try { this.ws.close(); } catch { /* already closed */ } }
    this.connected = false;
  }
}

/**
 * Where the room server is, when the URL does not say.
 *
 * In development the game is served by Vite on :5173 and the room server is a
 * separate process on :8787, so the port has to be added. Deployed, the server
 * serves the built game itself (see server/http.js), so the socket lives at the
 * SAME origin — and hardcoding :8787 there would point at a port the host does
 * not expose, which reads to the player as "multiplayer is broken".
 *
 * Shared with matchmaking.js's hostFromQuery(); the REST surface and the game
 * socket must always resolve to the same place.
 */
export function defaultHost() {
  const h = location.hostname;
  const dev = h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '';
  return dev ? `${h || 'localhost'}:8787` : location.host;
}

/**
 * Read the multiplayer intent off the page URL.
 * @returns {{enabled:boolean, room:string, url:string, name:string}}
 */
export function readNetConfig() {
  const q = new URLSearchParams(location.search);
  const room = q.get('room');
  const host = q.get('server') || defaultHost();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return {
    enabled: !!room,
    room: room || 'miami',
    url: `${proto}://${host}`,
    name: (q.get('name') || 'You').slice(0, 16),
  };
}
