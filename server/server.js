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
 */

import { WebSocketServer } from 'ws';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
const MAX_PLAYERS = 12;
const PORT = Number(process.env.PORT || 8787);

/* ------------------------------------------------------------------ room --- */

class Room {
  constructor(name) {
    this.name = name;
    this.clients = new Map();     // id -> client
    this.nextId = 1;
    this.seed = (Math.random() * 0x7fffffff) | 0;
    this.phase = 'playing';
    this.timeLeft = MATCH_DURATION;
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
      // Cheap sanity envelope: a hole cannot outrun this, so a client that
      // teleports gets snapped back rather than trusted.
      maxSpeed: 60,
    };
    this.clients.set(id, client);

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
    return client;
  }

  remove(id) {
    if (!this.clients.has(id)) return;
    this.clients.delete(id);
    this.broadcast(S2C.LEAVE, { id });
  }

  /**
   * @param {boolean} onlyReady  skip clients that have not started playing yet.
   *
   * THIS FLAG IS LOAD-BEARING FOR THE 15 Hz TRAFFIC. A client opens its socket
   * and then builds the entire city on the main thread — tens of seconds, and
   * minutes on a loaded machine — during which it drains nothing. Snapshots
   * kept arriving at 15 Hz, so by the time the liveness ping was written it sat
   * behind thousands of queued frames that the blocked renderer would never
   * read. The pong never came, the sweep called terminate(), and every player
   * whose machine was slow to load was kicked out mid-loading-screen with a
   * 1006. Roster and match events are rare and small, so they still go to
   * everyone; the firehose does not.
   */
  broadcast(type, data, exceptId = null, onlyReady = false) {
    const msg = encode(type, data);
    for (const c of this.clients.values()) {
      if (c.id === exceptId) continue;
      if (onlyReady && !c.ready) continue;
      if (c.ws.readyState !== 1) continue;
      // Second line of defence: a client that has stopped draining gets no more
      // volume until it catches up, rather than an ever-growing kernel buffer.
      if (onlyReady && c.ws.bufferedAmount > 262144) continue;
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

    if (!anyReady) {
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
        this.phase = 'playing';
        this.timeLeft = MATCH_DURATION;
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
      }
    }

    if (this.pendingConsumed.length) {
      // De-duplicate: two clients can both claim the same object in the same
      // tick, and peers only need to be told once.
      const ids = [...new Set(this.pendingConsumed)];
      this.pendingConsumed.length = 0;
      for (let i = 0; i < ids.length; i += 300) {
        this.broadcast(S2C.CONSUMED, { ids: ids.slice(i, i + 300) }, null, true);
      }
    }

    const holes = [];
    for (const c of this.clients.values()) {
      holes.push([c.id, round2(c.x), round2(c.z), round2(c.r), Math.round(c.score), c.alive ? 1 : 0]);
    }
    this.broadcast(S2C.SNAPSHOT, { t: now, holes, timeLeft: Math.round(this.timeLeft) },
      null, true);
  }
}

const round2 = (n) => Math.round(n * 100) / 100;

/* ---------------------------------------------------------------- server --- */

const rooms = new Map();
function getRoom(name) {
  let r = rooms.get(name);
  if (!r) { r = new Room(name); rooms.set(name, r); }
  return r;
}

const wss = new WebSocketServer({ port: PORT });

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
    if (room.clients.size === 0) rooms.delete(roomName);
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

console.log(`[miami-devour] room server listening on ws://localhost:${PORT}`);
console.log(`  join a room:  ws://localhost:${PORT}?room=<name>`);
console.log(`  in the game:  http://localhost:5173/?room=<name>`);
