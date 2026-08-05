/**
 * Wire protocol shared by the client and the Node server.
 *
 * DESIGN
 * ------
 * The city is generated from a shared integer seed, and generation is fully
 * deterministic (see src/core/rng.js — mulberry32, no Math.random anywhere in
 * world building). That means every client independently produces an identical
 * set of Consumables with identical ids. So we never have to replicate the
 * world: we replicate *events against it*.
 *
 *  - Each client owns its own hole and simulates its own movement + eating.
 *    That keeps the game feeling instant, which matters far more here than
 *    perfect anti-cheat.
 *  - Clients report the ids they swallowed. The server rebroadcasts them so all
 *    peers delete the same objects.
 *  - The server is authoritative for the things a client must not be trusted
 *    with or must not disagree about: the match clock, hole-vs-hole kills, and
 *    the roster.
 *
 * Everything is JSON. At 15 Hz with a dozen players this is a few KB/s, which
 * is not worth the complexity of a binary codec.
 */

export const PROTOCOL_VERSION = 4;

/** client -> server */
export const C2S = {
  HELLO: 'hello',     // { name, version }
  STATE: 'state',     // { x, z, r, score, dir:[x,z] }
  ATE: 'ate',         // { ids:[...], score }
  CLAIM_KILL: 'kill', // { victimId }  — server validates radii before granting
  PING: 'ping',       // { t }
  READY: 'ready',     // { on }        — pre-lobby "I am at my keyboard"
  START: 'start',     // {}            — host only; begins the match
  RENAME: 'rename',   // { name }      — chosen in the pre-lobby, before play
};

/** server -> client */
export const S2C = {
  WELCOME: 'welcome',   // { id, seed, roster, timeLeft, tickRate }
  SNAPSHOT: 'snap',     // { t, holes:[[id,x,z,r,score,alive],...] }
  CONSUMED: 'eaten',    // { ids:[...] }        objects removed by anyone
  JOIN: 'join',         // { id, name, color }
  LEAVE: 'leave',       // { id }
  KILL: 'kill',         // { killerId, victimId, reward }
  MATCH: 'match',       // { phase, timeLeft }
  /**
   * The pre-lobby roster. Sent on every change rather than polled, because the
   * whole point of a waiting room is seeing someone arrive the moment they do.
   * `hostId` is whoever may press start; it moves to the next player if the
   * host leaves, so a lobby can never be stranded with nobody able to begin.
   */
  LOBBY: 'lobby',       // { phase, hostId, players:[{id,name,color,armed,loaded}] }
  PONG: 'pong',         // { t }
  ERROR: 'error',       // { message }
};

export const TICK_RATE = 15;
export const SNAPSHOT_INTERVAL = 1000 / TICK_RATE;

/** Palette used to colour remote players, indexed by join order. */
export const PLAYER_COLORS = [
  0xff4d8d, 0x4dd2ff, 0xffd93c, 0x8bff6b, 0xb388ff, 0xff9f43,
  0x64ffda, 0xff6b6b, 0xa0e7e5, 0xf6a6ff, 0x7cf2a0, 0xffa8c5,
];

export function encode(type, data) {
  return JSON.stringify({ t: type, d: data });
}

export function decode(raw) {
  try {
    const m = JSON.parse(raw);
    if (!m || typeof m.t !== 'string') return null;
    return m;
  } catch {
    return null;
  }
}
