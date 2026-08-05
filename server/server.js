#!/usr/bin/env node
/**
 * MIAMI DEVOUR — multiplayer room server.
 *
 *   npm run server            # ws://localhost:8787
 *   PORT=9000 npm run server
 *
 * Authoritative for: the roster, the match clock, and hole-vs-hole kills.
 * Relays: player transforms and swallowed-object ids.
 * See src/net/protocol.js for the reasoning behind that split.
 *
 * Rooms are created on demand from the ?room= query parameter, so two browser
 * tabs pointed at ?room=test are immediately in the same match.
 *
 * The meta layer's REST surface (rooms browser, invite codes, leaderboard) is
 * mounted on this SAME listener — see http.js. The game protocol below is
 * untouched by it: `ws` handles the upgrade, plain requests fall through to the
 * JSON handler.
 */

import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';

import { createStore, MAX_PLAYERS } from './store.js';
import { createHttpHandler } from './http.js';

// Pull the shared constants out of the ES module without bundling: the client
// protocol file is plain JS with no browser dependencies, so we can import it.
const {
  C2S, S2C, TICK_RATE, SNAPSHOT_INTERVAL, PLAYER_COLORS, PROTOCOL_VERSION,
  encode, decode,
} = await import('../src/net/protocol.js');

const MATCH_DURATION = 150;
const INTERMISSION = 10;
const PVP_RATIO = 1.18;
const PVP_REWARD = 0.62;
const PORT = Number(process.env.PORT || 8787);

// Room descriptors + the persisted leaderboard. MAX_PLAYERS comes from here so
// the roster cap the REST browser advertises and the cap the socket enforces
// can never drift apart.
const store = createStore();

/* ------------------------------------------------------------------ room --- */

class Room {
  constructor(name) {
    this.name = name;
    this.clients = new Map();     // id -> client
    this.nextId = 1;
    this.seed = (Math.random() * 0x7fffffff) | 0;
    /**
     * A room opens as a WAITING ROOM, not mid-match. The old behaviour dropped
     * whoever arrived first into a running game alone, and their friend joined
     * a match already in progress with a stranger's score on the board.
     * The host presses start when everyone is in.
     */
    this.phase = 'lobby';
    this.timeLeft = MATCH_DURATION;
    /** Whoever may press start. Moves on if they leave, so no lobby strands. */
    this.hostId = null;
    this.pendingConsumed = [];
    this.lastTick = Date.now();
    this.colorCursor = 0;
  }

  add(ws, name) {
    if (this.clients.size >= MAX_PLAYERS) return null;
    const id = this.nextId++;
    const client = {
      id, ws,
      name: String(name || `Player ${id}`).slice(0, 16),
      color: PLAYER_COLORS[this.colorCursor++ % PLAYER_COLORS.length],
      x: 0, z: 0, r: 1.15, score: 0, alive: true,
      lastSeen: Date.now(),
      // Set by the first STATE. A client is connected long before it can play:
      // it opens the socket, then builds the whole city synchronously, which
      // takes tens of seconds on a phone and minutes on a loaded machine. See
      // tick() — the match clock does not run until somebody is actually in it.
      ready: false,
      /**
       * Pre-lobby "I am at my keyboard". Distinct from `ready` above, which
       * means "has finished building the city" — a player can be loaded and
       * still be away making tea.
       */
      armed: false,
      // Cheap sanity envelope: a hole cannot outrun this, so a client that
      // teleports gets snapped back rather than trusted.
      maxSpeed: 60,
    };
    this.clients.set(id, client);
    if (this.hostId === null || !this.clients.has(this.hostId)) this.hostId = id;

    ws.send(encode(S2C.WELCOME, {
      id,
      seed: this.seed,
      timeLeft: this.timeLeft,
      phase: this.phase,
      tickRate: TICK_RATE,
      roster: [...this.clients.values()].map((c) => ({
        id: c.id, name: c.name, color: c.color,
      })),
    }));
    this.broadcast(S2C.JOIN, { id, name: client.name, color: client.color }, id);
    this.broadcastLobby();
    return client;
  }

  remove(id) {
    if (!this.clients.has(id)) return;
    this.clients.delete(id);
    this.broadcast(S2C.LEAVE, { id });
    // The host leaving must not leave a room nobody can start. Oldest player
    // present inherits it.
    if (this.hostId === id) {
      const next = [...this.clients.keys()].sort((a, b) => a - b)[0];
      this.hostId = next === undefined ? null : next;
    }
    this.broadcastLobby();
  }

  /** The waiting-room roster. Pushed on every change, never polled. */
  lobbyState() {
    return {
      phase: this.phase,
      hostId: this.hostId,
      players: [...this.clients.values()].map((c) => ({
        id: c.id, name: c.name, color: c.color, armed: !!c.armed, loaded: !!c.ready,
      })),
    };
  }

  broadcastLobby() {
    this.broadcast(S2C.LOBBY, this.lobbyState());
  }

  /**
   * @param {?{lossy:boolean}} opts  `lossy` marks a message that a client may
   *   simply not be sent — see below. EVERYTHING ELSE MUST BE DELIVERED: the
   *   consumed-id relay is the only record that an object is gone, there is no
   *   re-send and no reconciliation, so one dropped CONSUMED leaves that object
   *   standing on that client for the rest of the match.
   *
   * Snapshots are the exception, and gating them is load-bearing. A client
   * opens its socket and then builds the entire city on the main thread — tens
   * of seconds, minutes on a loaded machine — during which it drains nothing.
   * At 15 Hz that queued thousands of frames, so when the liveness ping was
   * finally written it sat behind all of them and the blocked renderer never
   * reached it. No pong, so the sweep called terminate(), and every player
   * whose machine was slow to load was kicked out mid-loading-screen with a
   * 1006. A snapshot is pure current state and the next one supersedes it, so
   * skipping one costs nothing.
   */
  broadcast(type, data, exceptId = null, opts = null) {
    const lossy = !!(opts && opts.lossy);
    const msg = encode(type, data);
    for (const c of this.clients.values()) {
      if (c.id === exceptId) continue;
      if (c.ws.readyState !== 1) continue;
      if (lossy && (!c.ready || c.ws.bufferedAmount > 262144)) continue;
      c.ws.send(msg);
    }
  }

  handle(client, msg) {
    client.lastSeen = Date.now();
    switch (msg.t) {
      case C2S.STATE: {
        const d = msg.d || {};
        client.ready = true;
        if (typeof d.x === 'number' && typeof d.z === 'number') {
          client.x = d.x; client.z = d.z;
        }
        // Radius and score only ever go up during a life; reject rollbacks so a
        // dropped packet cannot shrink someone on everyone else's screen.
        if (typeof d.r === 'number' && d.r >= 0 && d.r < 200) {
          client.r = client.alive ? Math.max(client.r, d.r) : d.r;
        }
        if (typeof d.score === 'number' && d.score >= client.score) {
          client.score = d.score;
        }
        break;
      }
      case C2S.ATE: {
        const ids = Array.isArray(msg.d?.ids) ? msg.d.ids.slice(0, 400) : [];
        if (ids.length) this.pendingConsumed.push(...ids);
        break;
      }
      case C2S.CLAIM_KILL: {
        const victim = this.clients.get(msg.d?.victimId);
        if (!victim || !victim.alive || victim.id === client.id) break;
        // Server-side validation: the claimed eater must actually be bigger and
        // actually be on top of the victim.
        const d = Math.hypot(client.x - victim.x, client.z - victim.z);
        if (client.r < victim.r * PVP_RATIO) break;
        if (d > client.r * 1.3) break;
        victim.alive = false;
        const reward = Math.max(20, Math.round(victim.score * PVP_REWARD));
        client.score += reward;
        client.r = Math.max(client.r, victim.r);
        this.broadcast(S2C.KILL, { killerId: client.id, victimId: victim.id, reward });
        setTimeout(() => {
          if (this.clients.has(victim.id)) {
            victim.alive = true;
            victim.score = Math.round(victim.score * 0.45);
            victim.r = 1.15;
          }
        }, 2600);
        break;
      }
      case C2S.READY: {
        client.armed = !!msg.d?.on;
        this.broadcastLobby();
        break;
      }
      case C2S.RENAME: {
        // Chosen in the pre-lobby before anyone plays. Same sanitising as
        // everywhere else a name reaches another player's screen.
        const n = String(msg.d?.name || '').replace(/[<>&"'`\\\u0000-\u001f]/g, '')
          .replace(/\s+/g, ' ').trim().slice(0, 16);
        if (n) { client.name = n; this.broadcastLobby(); }
        break;
      }
      case C2S.START: {
        // Host only, and only out of the waiting room. Anyone can spam this;
        // the check is here rather than trusting the button to be hidden.
        if (client.id !== this.hostId) break;
        if (this.phase !== 'lobby') break;
        this.phase = 'playing';
        this.timeLeft = MATCH_DURATION;
        for (const c of this.clients.values()) { c.score = 0; c.r = 1.15; c.alive = true; }
        this.broadcast(S2C.MATCH, { phase: 'playing', timeLeft: this.timeLeft, seed: this.seed });
        this.broadcastLobby();
        break;
      }
      case C2S.PING:
        client.ws.send(encode(S2C.PONG, { t: msg.d?.t }));
        break;
      default:
        break;
    }
  }

  tick() {
    const now = Date.now();
    const dt = (now - this.lastTick) / 1000;
    this.lastTick = now;

    // Drop clients whose socket has gone. `lastSeen` is refreshed by the
    // WebSocket-level pong as well as by application messages, which is the
    // whole point: a client spends its entire load inside a synchronous world
    // build during which it cannot send a single game message, and on a busy
    // machine that build runs for minutes. Keyed on application messages alone
    // this backstop evicted joining clients mid-load — the loader finished, the
    // player was already gone from the room, and multiplayer silently degraded
    // to a solo city with a dead socket. The browser's network stack answers
    // pings while the renderer is blocked, so pong is the honest liveness
    // signal and this timeout only ever catches a socket that is really dead.
    for (const c of [...this.clients.values()]) {
      if (now - c.lastSeen > 180000) {
        try { c.ws.close(); } catch { /* already gone */ }
        this.remove(c.id);
      }
    }
    if (this.clients.size === 0) return;

    // Hold the clock until at least one client has finished loading and started
    // sending state. The room was created by the first HELLO, so without this
    // the 150 s round is already ticking while everybody is still building the
    // city — join a fresh room on a slow machine and you arrive at the results
    // screen, or, worse, several rounds later. Snapshots still go out below so
    // the roster and the lobby are live while people load.
    let anyReady = false;
    for (const c of this.clients.values()) if (c.ready) { anyReady = true; break; }

    if (this.phase === 'lobby') {
      // A waiting room has no clock. Snapshots still go out below so the
      // roster stays live while people load.
    } else if (!anyReady) {
      // nothing to time yet
    } else if (this.phase === 'playing') {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) {
        this.timeLeft = INTERMISSION;
        this.phase = 'results';
        this.broadcast(S2C.MATCH, { phase: this.phase, timeLeft: this.timeLeft });
      }
    } else {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) {
        this.phase = 'lobby';
        this.timeLeft = MATCH_DURATION;
        for (const c of this.clients.values()) c.armed = false;
        // The seed is fixed for the life of the room. Clients build the city
        // once, synchronously, at page load — they cannot adopt a new seed
        // mid-session, and a player who joined before the re-roll would be
        // matching object ids against a different city than one who joined
        // after it, which is the whole basis of the replication scheme. A new
        // city means a new room; a new round means the same city restored,
        // exactly as the offline game does it.
        for (const c of this.clients.values()) {
          c.score = 0; c.r = 1.15; c.alive = true;
        }
        this.broadcast(S2C.MATCH, {
          phase: this.phase, timeLeft: this.timeLeft, seed: this.seed,
        });
        this.broadcastLobby();
      }
    }

    if (this.pendingConsumed.length) {
      // De-duplicate: two clients can both claim the same object in the same
      // tick, and peers only need to be told once.
      const ids = [...new Set(this.pendingConsumed)];
      this.pendingConsumed.length = 0;
      for (let i = 0; i < ids.length; i += 300) {
        this.broadcast(S2C.CONSUMED, { ids: ids.slice(i, i + 300) });
      }
    }

    const holes = [];
    for (const c of this.clients.values()) {
      holes.push([c.id, round2(c.x), round2(c.z), round2(c.r), Math.round(c.score), c.alive ? 1 : 0]);
    }
    this.broadcast(S2C.SNAPSHOT, { t: now, holes, timeLeft: Math.round(this.timeLeft) },
      null, { lossy: true });
  }
}

const round2 = (n) => Math.round(n * 100) / 100;

/* ---------------------------------------------------------------- server --- */

const rooms = new Map();
function getRoom(name) {
  let r = rooms.get(name);
  if (!r) {
    r = new Room(name);
    rooms.set(name, r);
    // A room is born one of two ways — reserved over REST (the invite-code
    // flow) or conjured by the first ?room= socket. Binding here rather than at
    // reservation time means both kinds show up in the browser identically.
    store.attachLive(name, r);
  }
  return r;
}

const httpServer = createServer(createHttpHandler({ store, version: PROTOCOL_VERSION }));
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const roomName = (url.searchParams.get('room') || 'miami').slice(0, 24);
  const room = getRoom(roomName);
  let client = null;

  // Browsers answer WebSocket pings in the network stack, not in JS, so this
  // keeps working while the page is blocked building the city — which is
  // precisely when the room must not evict it.
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
    if (client) client.lastSeen = Date.now();
  });

  ws.on('message', (raw) => {
    const msg = decode(raw.toString());
    if (!msg) return;
    if (!client) {
      if (msg.t !== C2S.HELLO) return;
      if (msg.d?.version !== PROTOCOL_VERSION) {
        ws.send(encode(S2C.ERROR, {
          message: `Protocol mismatch: server ${PROTOCOL_VERSION}, client ${msg.d?.version}`,
        }));
        ws.close();
        return;
      }
      client = room.add(ws, msg.d?.name);
      if (!client) {
        ws.send(encode(S2C.ERROR, { message: 'Room is full' }));
        ws.close();
      }
      return;
    }
    room.handle(client, msg);
  });

  const bye = () => {
    if (client) room.remove(client.id);
    if (room.clients.size === 0) {
      rooms.delete(roomName);
      // The descriptor outlives the live room for a few minutes so a private
      // code stays joinable while everyone is between matches.
      store.detachLive(roomName);
    }
  };
  ws.on('close', bye);
  ws.on('error', bye);
});

setInterval(() => {
  for (const room of rooms.values()) room.tick();
}, SNAPSHOT_INTERVAL);

// Liveness. A socket that misses two consecutive pings is genuinely gone.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* socket already closing */ }
  }
}, 15000);

// Last line of defence. This process is authoritative for the clock, the roster
// and hole-vs-hole kills in every live match on it; a bug in one REST request
// must never be able to end all of them. Log and keep serving.
process.on('unhandledRejection', (e) => {
  console.warn('[server] unhandled rejection:', (e && e.message) || e);
});
process.on('uncaughtException', (e) => {
  console.warn('[server] uncaught exception:', (e && e.stack) || e);
});

// The leaderboard write is debounced, so a Ctrl-C between matches would
// otherwise drop the last few minutes of play.
let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (closing) process.exit(0);
    closing = true;
    try { store.dispose(); } catch { /* nothing left to save */ }
    process.exit(0);
  });
}

httpServer.listen(PORT, () => {
  console.log(`[miami-devour] room server listening on ws://localhost:${PORT}`);
  console.log(`  join a room:  ws://localhost:${PORT}?room=<name>`);
  console.log(`  in the game:  http://localhost:5173/?room=<name>`);
  console.log(`  meta REST:    http://localhost:${PORT}/api/health`);
});
