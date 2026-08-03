/**
 * AI opponents.
 *
 * DESIGN
 * ------
 * A bot is three things stacked:
 *
 *   1. A PLANNER that picks a goal every ~0.6-1.6 s. It scores candidate spots
 *      by value density divided by travel time, so a fat cluster 40 m away
 *      beats a fatter one 200 m away — the thing the old planner got wrong was
 *      dividing by a nearly-flat cost, which made every bot sprint across the
 *      map at the same rich block.
 *
 *   2. A CONTEXT STEERER that runs every frame. It fans 16 candidate headings
 *      out of the hole, scores each for "gets me to my goal", "gets me away
 *      from things that can eat me", "does not end in Biscayne Bay" and "is not
 *      the heading four other bots are already using", then slew-limits the
 *      chosen heading. Interest-vs-danger context steering is what makes the
 *      fleeing actually work: a bot backed against the seawall finds the one
 *      remaining escape lane instead of pinning itself, and the slew limit is
 *      what stops the oscillation you get from re-deciding every frame.
 *
 *   3. A PERSONALITY dealt at spawn — skill, aggression, caution — so a lobby
 *      contains pushovers and genuine threats rather than seven clones.
 *
 * MAP AWARENESS. game.js does not hand the layout to spawnBots (it is built
 * after the call site), so this module reconstructs the two pieces of geometry
 * that matter — the bay edge and the bent river channel — from the same
 * constants cityLayout.js uses. Pass `layout` as the optional 5th argument to
 * spawnBots and the authoritative isWater() is used instead.
 */

import * as THREE from 'three';
import { HOLE, WORLD, MATCH } from '../config.js';
import { riverCenterAt, riverHalfAt } from '../world/cityLayout.js';
import { Hole } from './hole.js';

const NAMES = [
  'Vortex', 'Cyclone', 'Abyss', 'Sinkhole', 'Maelstrom', 'Rift', 'Chasm',
  'Nova', 'Riptide', 'Undertow', 'Eclipse', 'Zenith', 'Kraken', 'Tempest',
];
const COLORS = [
  0xff4d8d, 0x4dd2ff, 0xffd93c, 0x8bff6b, 0xb388ff,
  0xff9f43, 0x64ffda, 0xff6b6b, 0xa0e7e5, 0xf6a6ff,
];

/* ========================================================== map awareness === */

/**
 * The three road crossings that carry a river bridge, from cityLayout's X_PLAN
 * (S Miami Ave, Brickell Ave, Biscayne Blvd). A bot that wants the far bank
 * routes through one of these instead of swimming.
 */
const BRIDGE_X = [-22, 128, 260];

/**
 * Open water that is NOT the bay or the river: the two marina basins and the
 * Brickell Key cuts. Mirrors the AABBs in cityLayout.buildLayout(); kept
 * deliberately slightly fat so a bot aims for dry land, not the kerb.
 */
const WATER_BOXES = [
  { x0: 278, x1: 999, z0: -348, z1: -288 },  // Miamarina
  { x0: 286, x1: 999, z0: 270, z1: 300 },    // Brickell Marina
  { x0: 277, x1: 300, z0: 30, z1: 181 },     // Key Cut West
  { x0: 277, x1: 999, z0: 149, z1: 181 },    // Key Cut South
];

/** True over open water. `layout` (when supplied) is authoritative. */
export function isWaterAt(x, z, layout) {
  if (layout && layout.isWater) return layout.isWater(x, z);
  if (x > WORLD.BAY_EDGE) return true;
  const c = riverCenterAt(x), h = riverHalfAt(x);
  if (z > c - h && z < c + h) return true;
  if (z > WORLD.RIVER_Z - WORLD.RIVER_HALF_W && z < WORLD.RIVER_Z + WORLD.RIVER_HALF_W) {
    // The straight band is water everywhere except on a bridge deck.
    let onBridge = false;
    for (let i = 0; i < BRIDGE_X.length; i++) {
      if (Math.abs(x - BRIDGE_X[i]) < 16) { onBridge = true; break; }
    }
    if (!onBridge) return true;
  }
  for (let i = 0; i < WATER_BOXES.length; i++) {
    const b = WATER_BOXES[i];
    if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1) return true;
  }
  return false;
}

/**
 * Soft cost in 0..1 for standing at (x,z): 1 is "do not go there".
 * Soft rather than binary so steering slides along a shoreline instead of
 * jamming into it, which is what produced the old bots-parked-on-the-seawall.
 */
function travelCost(x, z, layout, margin) {
  if (isWaterAt(x, z, layout)) return 1;
  let c = 0;
  // map edges
  const edge = Math.min(
    WORLD.BAY_EDGE - x, x + WORLD.SIZE, WORLD.SIZE - z, z + WORLD.SIZE
  );
  if (edge < margin) c = Math.max(c, 1 - edge / margin);
  // riverbank
  const rc = riverCenterAt(x);
  const rh = Math.max(riverHalfAt(x), WORLD.RIVER_HALF_W);
  const bank = Math.abs(z - rc) - rh;
  if (bank < margin) {
    let onBridge = false;
    for (let i = 0; i < BRIDGE_X.length; i++) {
      if (Math.abs(x - BRIDGE_X[i]) < 20) { onBridge = true; break; }
    }
    if (!onBridge) c = Math.max(c, 1 - Math.max(0, bank) / margin);
  }
  return Math.min(1, c);
}

/** Nudge a point onto dry, in-bounds land. Used for respawns and goal fixups. */
export function clampToLand(x, z, layout) {
  let px = THREE.MathUtils.clamp(x, -WORLD.SIZE + 30, WORLD.BAY_EDGE - 26);
  let pz = THREE.MathUtils.clamp(z, -WORLD.SIZE + 30, WORLD.SIZE - 30);
  if (!isWaterAt(px, pz, layout)) return { x: px, z: pz };
  // Push off the river first — it is the only water that cuts the map in half.
  const c = riverCenterAt(px);
  const side = pz >= c ? 1 : -1;
  pz = c + side * (riverHalfAt(px) + 34);
  pz = THREE.MathUtils.clamp(pz, -WORLD.SIZE + 30, WORLD.SIZE - 30);
  if (!isWaterAt(px, pz, layout)) return { x: px, z: pz };
  // Otherwise walk west out of the bay / a basin.
  for (let i = 0; i < 12 && isWaterAt(px, pz, layout); i++) px -= 26;
  return { x: THREE.MathUtils.clamp(px, -WORLD.SIZE + 30, WORLD.BAY_EDGE - 26), z: pz };
}

/* ================================================================== steer === */

const DIRS = 16;
const DIR_X = new Float32Array(DIRS);
const DIR_Z = new Float32Array(DIRS);
for (let i = 0; i < DIRS; i++) {
  const a = (i / DIRS) * Math.PI * 2;
  DIR_X[i] = Math.cos(a);
  DIR_Z[i] = Math.sin(a);
}
const _score = new Float32Array(DIRS);

export const BOT_MODE = { FARM: 'farm', HUNT: 'hunt', FLEE: 'flee' };

export class BotController {
  /**
   * @param {Hole} hole
   * @param {import('./entities.js').EntityRegistry} registry
   * @param {*} rng
   * @param {object} [opts] { flock, layout, skill }
   */
  constructor(hole, registry, rng, opts = {}) {
    this.hole = hole;
    this.registry = registry;
    this.rng = rng;
    this.layout = opts.layout || null;
    /** Shared board so bots can see each other's intentions. */
    this.flock = opts.flock || { claims: [] };
    this.claim = { id: hole.id, x: hole.position.x, z: hole.position.z, r: hole.radius, prey: null };
    this.flock.claims.push(this.claim);

    /* --- personality ---------------------------------------------------- */
    // Skill is dealt by spawnBots so the roster is spread deterministically
    // rather than every bot rolling mid-table.
    this.skill = opts.skill ?? (MATCH.BOT_SKILL_MIN + rng() * (MATCH.BOT_SKILL_MAX - MATCH.BOT_SKILL_MIN));
    // Aggression and caution are rolled independently of skill: a clumsy but
    // fearless bot and a sharp but timid one are different opponents, and that
    // is most of what makes a lobby feel populated.
    this.aggression = 0.2 + rng() * 0.8;
    this.caution = 0.25 + rng() * 0.75;

    this.mode = BOT_MODE.FARM;
    this.goal = new THREE.Vector2(hole.position.x, hole.position.z);
    /** Set when the goal is on the far bank: cross here first. */
    this.waypoint = null;
    this.goalValue = 0;
    this.replanIn = rng() * 0.8;
    this.heading = rng() * Math.PI * 2;
    this.wander = rng() * Math.PI * 2;
    this.prey = null;
    this.threat = null;
    this.panic = 0;
    this._q = [];
    this._lastX = hole.position.x;
    this._lastZ = hole.position.z;
    this._stuck = 0;
    this._react = 0;
    this._seenThreat = null;
    this._committed = null;
    this._huntT = 0;
    this._dt = 1 / 60;
    this._lastScore = 0;
    /** Own points-per-second, smoothed. Drives the hunt cost/benefit call. */
    this.income = 0;
  }

  dispose() {
    const i = this.flock.claims.indexOf(this.claim);
    if (i >= 0) this.flock.claims.splice(i, 1);
  }

  /* --------------------------------------------------------------- tick --- */

  update(dt, holes, t) {
    const h = this.hole;
    if (!h.alive) { this.claim.prey = null; return; }

    this.claim.x = h.position.x;
    this.claim.z = h.position.z;
    this.claim.r = h.radius;

    this._dt = dt;
    this._react = Math.max(0, this._react - dt);
    // Own income, points per second, smoothed over a couple of seconds. This is
    // the opportunity cost the hunt decision is measured against.
    const ds = Math.max(0, h.score - this._lastScore);
    this._lastScore = h.score;
    this.income += (ds / dt - this.income) * (1 - Math.exp(-dt / 2.5));
    // A goal is worth less the longer it goes unreached — the block may have
    // been stripped by someone else on the way over. Time-based, so replan
    // frequency (i.e. skill) does not change how committed a bot is.
    this.goalValue *= Math.exp(-dt * 0.14);
    this._scan(holes);
    this._chooseMode(dt);

    this.replanIn -= dt;
    if (this.mode === BOT_MODE.FARM && this.replanIn <= 0) {
      // Sharper bots think more often, which is most of what "skill" reads as.
      this.replanIn = 1.6 - 0.95 * this.skill + this.rng() * 0.35;
      this._replan(holes);
    }

    // A bot that has barely moved for a while has walked into a corner its
    // steering could not see out of. Force a fresh, deliberately distant goal.
    const moved = Math.hypot(h.position.x - this._lastX, h.position.z - this._lastZ);
    this._lastX = h.position.x; this._lastZ = h.position.z;
    this._stuck = moved < h.speed * dt * 0.25 ? this._stuck + dt : 0;
    if (this._stuck > 1.1) {
      this._stuck = 0;
      this._escape();
    }

    this._steer(dt, holes, t);
  }

  /* --------------------------------------------------------- perception --- */

  _scan(holes) {
    const h = this.hole;
    let threat = null, threatD = 1e9;
    let prey = null, preyScore = -1;

    // Caution buys early warning; a timid bot reacts a long way out, a bold one
    // only when the thing is nearly on top of it.
    //
    // These ranges are deliberately NOT generous. The first tuning pass gave
    // bots ~300 m of warning and the measured result was a 150 s match with
    // ZERO kills: everyone spent the round running from someone. PvP is the
    // drama, so a bot has to be catchable.
    const alertF = 0.70 + 0.55 * this.caution + 0.25 * this.skill;

    let lead = 1;
    for (let i = 0; i < holes.length; i++) if (holes[i].score > lead) lead = holes[i].score;
    /** 0 = leading, 1 = nowhere. Drives the rubber band. */
    this.behind = THREE.MathUtils.clamp(1 - h.score / lead, 0, 1);

    for (let i = 0; i < holes.length; i++) {
      const o = holes[i];
      if (o === h || !o.alive) continue;
      const dx = o.position.x - h.position.x;
      const dz = o.position.z - h.position.z;
      const d = Math.hypot(dx, dz);

      if (o.radius >= h.radius * HOLE.PVP_RATIO * 0.92) {
        const range = (30 + o.radius * 4.0) * alertF;
        if (d < range && d < threatD) { threat = o; threatD = d; }
      } else if (h.radius >= o.radius * HOLE.PVP_RATIO * 1.05) {
        // Never kick someone who just respawned; it is the main thing that made
        // a losing bot's match unrecoverable.
        if (o.spawnGrace > 0) continue;
        const eta = this._interceptTime(o, d);
        // Chase budget. Two holes running flat out close at only ~10 m/s even
        // at a 1.7x size ratio, so a 5 s budget abandoned every pursuit before
        // it got inside the ~30 m capture distance. Aggressive bots commit.
        let budget = 2.5 + 8.0 * this.aggression;
        // Commitment: a target already being chased keeps its slot for a while
        // even if the numbers wobble, otherwise the bot swaps prey and neither
        // chase ever completes.
        if (o === this._committed && this._huntT < 6) budget *= 1.5;
        if (eta > budget) continue;

        // IS THE CHASE WORTH IT? Measured: bots with high aggression finished
        // LAST, because a 10 s pursuit costs more food than the kill pays. So
        // compare the payout against what this bot ACTUALLY earns per second
        // (this.income, an EMA of its own score rate — the planner's goalValue
        // was tried first and overestimates by ~10x, which vetoed every hunt).
        // Skill gates the judgement, not the style: a sharp bot demands a good
        // deal, a poor one chases anything that moves.
        const payout = o.score * HOLE.PVP_REWARD;
        if (payout < this.income * eta * (0.35 + 0.80 * this.skill)) continue;

        // Prefer fat, close prey — and back off if two bots already want it.
        let contested = 0;
        for (const c of this.flock.claims) if (c.prey === o.id && c.id !== h.id) contested++;
        const s = (payout + 120) / (1 + eta) * (contested ? 0.35 : 1);
        if (s > preyScore) { preyScore = s; prey = o; }
      }
    }
    // Reaction delay. A weak bot literally does not see the threat for up to
    // half a second, which is the difference between escaping and being lunch —
    // and it is a much more human-looking weakness than bad steering.
    if (threat && threat !== this._seenThreat) {
      this._react = (1 - this.skill) * 0.55;
      this._seenThreat = threat;
    }
    if (!threat) this._seenThreat = null;
    this.threat = this._react > 0 ? null : threat;
    this.threatD = threatD;
    this.prey = prey;
    if (prey && prey === this._committed) this._huntT += this._dt;
    else { this._committed = prey; this._huntT = 0; }
  }

  /** Rough seconds to close on a moving target, ignoring obstacles. */
  _interceptTime(o, d) {
    const closing = Math.max(2, this.hole.speed - o.speed * 0.85);
    return d / closing;
  }

  _chooseMode(dt) {
    const h = this.hole;
    if (this.threat) {
      // Sprint trigger. Kept SHORT on purpose — see the note in _scan. The
      // long-range avoidance lives in the planner (it biases goals away from
      // the threat), so a bot still keeps its distance without spending the
      // whole match at full throttle in a straight line.
      // Rubber band, part 2: a bot that is losing takes more risks and keeps
      // eating with a big hole nearby. It reads as nerve, not as assistance.
      const panicRange = (14 + this.threat.radius * 1.9)
        * (0.60 + 0.75 * this.caution) * (1 - 0.30 * this.behind);
      if (this.threatD < panicRange || this.panic > 0) {
        this.mode = BOT_MODE.FLEE;
        this.panic = Math.max(this.panic, 0.9);
      }
    }
    // Panic bleeds off even while the threat is still in view, so a bot that
    // has opened a gap goes back to eating instead of running the whole match.
    this.panic = Math.max(0, this.panic - dt * (this.threat ? 0.55 : 1.6));
    if (this.mode === BOT_MODE.FLEE && !this.threat && this.panic <= 0) this.mode = BOT_MODE.FARM;
    if (this.mode !== BOT_MODE.FLEE) {
      this.mode = this.prey ? BOT_MODE.HUNT : BOT_MODE.FARM;
    }
    this.claim.prey = this.mode === BOT_MODE.HUNT && this.prey ? this.prey.id : null;
  }

  /* ------------------------------------------------------------- plan --- */

  /**
   * Pick a farming goal. Candidates are scored as
   *     value(edible score in a disc) / (travel time + dwell)
   * with penalties for other bots' claims and for anything that is not land.
   */
  _replan(holes) {
    const h = this.hole;
    const rng = this.rng;

    // Rubber band: a bot far behind the leader looks further afield, considers
    // more options and reads a wider area. It gains reach and judgement, never
    // points and never speed — an invisible nudge rather than a rubber wall.
    const behind = this.behind || 0;
    const band = 1 + MATCH.RUBBER_MAX * behind;

    const samples = 5 + Math.round(this.skill * 9) + Math.round(behind * 5);
    const reach = (70 + h.radius * 9) * band;
    const sniff = (26 + h.radius * 3.2) * (1 + 0.3 * behind);  // value disc
    const speed = Math.max(4, h.speed);

    let best = null, bestScore = -1;
    for (let i = 0; i < samples; i++) {
      // One candidate in three is a long probe, so bots migrate to fresh
      // districts once their own block is stripped instead of orbiting a
      // patch of bare pavement.
      const far = (i % 3 === 2);
      const ang = rng() * Math.PI * 2;
      const dist = far ? reach * (0.7 + rng() * 0.9) : 18 + rng() * reach * 0.55;
      let x = h.position.x + Math.cos(ang) * dist;
      let z = h.position.z + Math.sin(ang) * dist;
      x = THREE.MathUtils.clamp(x, -WORLD.SIZE + 30, WORLD.BAY_EDGE - 26);
      z = THREE.MathUtils.clamp(z, -WORLD.SIZE + 30, WORLD.SIZE - 30);
      if (isWaterAt(x, z, this.layout)) continue;

      const list = this.registry.query(x, z, sniff, this._q);
      let value = 0;
      for (let k = 0; k < list.length; k++) {
        const c = list[k];
        if (h.radius < c.eatRadius) continue;
        // Cap so one landmark does not outweigh a whole rich street: a bot that
        // parks next to a single tower stops looking like it is playing.
        value += Math.min(c.score, 900);
      }
      if (value <= 0) continue;

      const travel = Math.hypot(x - h.position.x, z - h.position.z);
      // Dwell is how long the bot will actually spend eating that disc; without
      // it, distant piles always lose to whatever is underfoot.
      const dwell = 2.5 + sniff / speed;
      let s = value / (travel / speed + dwell);

      // Avoid the threat's half of the map.
      if (this.threat) {
        const td = Math.hypot(x - this.threat.position.x, z - this.threat.position.z);
        s *= THREE.MathUtils.clamp(td / (70 + this.threat.radius * 5), 0.12, 1.35);
      }
      // Crowd rules. Avoiding EVERY other bot equally was measured to produce a
      // match with zero kills — seven bots politely farming seven separate
      // districts. So the penalty is signed by relative size: run from what can
      // eat you, keep your elbows out around peers, and actively contest a rich
      // block held by something you could swallow.
      for (const c of this.flock.claims) {
        if (c.id === h.id) continue;
        const cd = Math.hypot(x - c.x, z - c.z);
        const near = 46 + h.radius * 3;
        if (cd >= near) continue;
        const closeness = 1 - cd / near;
        if (c.r >= h.radius * HOLE.PVP_RATIO * 0.92) s *= 1 - 0.85 * closeness;
        else if (h.radius >= c.r * HOLE.PVP_RATIO) s *= 1 + 0.55 * closeness * this.aggression;
        else s *= 1 - 0.45 * closeness;
      }
      // Crossing the river costs a detour to a bridge; price it in.
      if (this._crossesRiver(h.position.x, h.position.z, x, z)) s *= 0.55;
      // A weak bot picks a worse option on purpose.
      s *= 1 - (1 - this.skill) * 0.55 * rng();

      if (s > bestScore) { bestScore = s; best = { x, z }; }
    }

    if (best) {
      // Hysteresis: only abandon a goal we are still travelling to for a clearly
      // better one. Without this the planner flip-flops every replan and the
      // bot visibly stutters between two directions.
      const dGoal = Math.hypot(this.goal.x - h.position.x, this.goal.y - h.position.z);
      const committed = dGoal > 14 && this.goalValue > 0;
      if (!committed || bestScore > this.goalValue * 1.35) {
        this.goal.set(best.x, best.z);
        this.goalValue = bestScore;
      }
      // NOTE: the stale-goal decay is applied per SECOND in update(), not here.
      // Decaying it per replan made skill actively harmful — a sharp bot
      // replans every 0.65 s, so it decayed its own commitment twice as fast as
      // a dim one and spent the match thrashing between two blocks. Measured:
      // the skill-1.00 bot finished last in two runs out of three.
    } else {
      this.goalValue = 0;
      this._escape();
    }
    this._routeRiver();
  }

  /** Head somewhere else entirely — used when stuck or when the block is bare. */
  _escape() {
    const h = this.hole;
    this.wander += 1.7 + this.rng() * 2.4;
    const d = 130 + this.rng() * 190;
    const p = clampToLand(
      h.position.x + Math.cos(this.wander) * d,
      h.position.z + Math.sin(this.wander) * d,
      this.layout
    );
    this.goal.set(p.x, p.z);
    this.goalValue = 0;
    this._routeRiver();
  }

  _crossesRiver(x0, z0, x1, z1) {
    const c0 = riverCenterAt(x0), c1 = riverCenterAt(x1);
    return (z0 - c0) * (z1 - c1) < 0;
  }

  /** If the goal is on the far bank, aim at the nearest bridge deck first. */
  _routeRiver() {
    this.waypoint = null;
    const h = this.hole;
    if (!this._crossesRiver(h.position.x, h.position.z, this.goal.x, this.goal.y)) return;
    let bx = BRIDGE_X[0], bd = 1e9;
    for (const x of BRIDGE_X) {
      const d = Math.abs(x - h.position.x) + Math.abs(x - this.goal.x) * 0.6;
      if (d < bd) { bd = d; bx = x; }
    }
    this.waypoint = new THREE.Vector2(bx, riverCenterAt(bx));
  }

  /* ------------------------------------------------------------ steer --- */

  _steer(dt, holes, t) {
    const h = this.hole;
    const r = h.radius;

    /* ---- 1. where do we WANT to go ---------------------------------- */
    let wx = 0, wz = 0;
    if (this.mode === BOT_MODE.FLEE && this.threat) {
      // Away from the threat, but the real escape direction comes out of the
      // context scan below — this is only the seed.
      wx = h.position.x - this.threat.position.x;
      wz = h.position.z - this.threat.position.z;
    } else if (this.mode === BOT_MODE.HUNT && this.prey) {
      const eta = Math.min(3.5, this._interceptTime(
        this.prey, Math.hypot(this.prey.position.x - h.position.x, this.prey.position.z - h.position.z)
      ));
      // Lead the target. Weak bots lead badly, which is why they miss.
      const lead = eta * (0.35 + 0.65 * this.skill);
      wx = this.prey.position.x + this.prey.velocity.x * lead - h.position.x;
      wz = this.prey.position.z + this.prey.velocity.z * lead - h.position.z;
    } else {
      const tgt = this.waypoint || this.goal;
      const gx = this.waypoint ? this.waypoint.x : this.goal.x;
      const gz = this.waypoint ? this.waypoint.y : this.goal.y;
      wx = gx - h.position.x;
      wz = gz - h.position.z;
      if (this.waypoint && Math.abs(h.position.z - this.waypoint.y) < WORLD.RIVER_HALF_W * 0.5) {
        this.waypoint = null;   // deck cleared, resume the real goal
      }
      void tgt;
    }
    let wl = Math.hypot(wx, wz);
    if (wl < 0.001) {
      this.wander += (this.rng() - 0.5) * dt * 2.2;
      wx = Math.cos(this.wander); wz = Math.sin(this.wander); wl = 1;
    }
    wx /= wl; wz /= wl;

    /* ---- 2. score 16 headings --------------------------------------- */
    // Probe far enough ahead that the shoreline is seen before it is hit, but
    // not so far that a bot refuses a good street because the bay is 200 m on.
    const probe = THREE.MathUtils.clamp(16 + r * 3.0, 18, 110);
    const margin = 14 + r * 1.6;
    let bestI = 0, bestS = -1e9;
    for (let i = 0; i < DIRS; i++) {
      const dx = DIR_X[i], dz = DIR_Z[i];
      let s = 2.2 * (dx * wx + dz * wz);

      // Land legality, sampled at half and full probe so a near shoreline
      // outranks a far one.
      const nx = h.position.x + dx * probe, nz = h.position.z + dz * probe;
      const mx = h.position.x + dx * probe * 0.5, mz = h.position.z + dz * probe * 0.5;
      s -= 5.5 * travelCost(nx, nz, this.layout, margin);
      s -= 3.5 * travelCost(mx, mz, this.layout, margin);

      // Danger. Every threat, not just the nearest, so a bot pinched between
      // two big holes threads the gap instead of running into the second one.
      for (let k = 0; k < holes.length; k++) {
        const o = holes[k];
        if (o === h || !o.alive) continue;
        if (o.radius < h.radius * HOLE.PVP_RATIO * 0.92) continue;
        const od = Math.hypot(o.position.x - h.position.x, o.position.z - h.position.z);
        const danger = (60 + o.radius * 6);
        if (od > danger) continue;
        const ax = (o.position.x - h.position.x) / (od || 1);
        const az = (o.position.z - h.position.z) / (od || 1);
        const towards = dx * ax + dz * az;      // +1 straight at it
        const w = (1 - od / danger);
        s -= w * w * 7.0 * Math.max(0, towards + 0.25);
      }

      // Personal space between bots of similar size — stops the pile-ups.
      for (let k = 0; k < holes.length; k++) {
        const o = holes[k];
        if (o === h || !o.alive || o === this.prey) continue;
        const od = Math.hypot(o.position.x - h.position.x, o.position.z - h.position.z);
        const near = 30 + (o.radius + r) * 1.6;
        if (od > near) continue;
        const ax = (o.position.x - h.position.x) / (od || 1);
        const az = (o.position.z - h.position.z) / (od || 1);
        s -= (1 - od / near) * 1.1 * Math.max(0, dx * ax + dz * az);
      }
      _score[i] = s;
      if (s > bestS) { bestS = s; bestI = i; }
    }

    /* ---- 3. sub-sample the winner and slew toward it ----------------- */
    // Parabolic interpolation across the winning bin's neighbours: 16 bins is
    // 22.5 deg apart and steering to bin centres alone reads as notchy.
    const l = _score[(bestI + DIRS - 1) % DIRS];
    const c = _score[bestI];
    const rr = _score[(bestI + 1) % DIRS];
    const denom = (l - 2 * c + rr);
    const off = Math.abs(denom) > 1e-5
      ? THREE.MathUtils.clamp(0.5 * (l - rr) / denom, -1, 1) : 0;
    let want = ((bestI + off) / DIRS) * Math.PI * 2;

    // Low-frequency wobble instead of per-frame jitter: noise that changes
    // every frame just cancels itself out in the velocity smoothing.
    want += Math.sin(t * 0.9 + h.id * 2.3) * (1 - this.skill) * 0.30;

    // Slew limit. This is the single line that removes oscillation: the
    // heading is a state, not a fresh decision every frame.
    let d = want - this.heading;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    // Panic turns fast, cruise turns lazily; big holes turn slower than small
    // ones, which is where their weight comes from.
    const turn = (this.mode === BOT_MODE.FLEE ? 6.0 : 3.4) *
                 (0.55 + 0.45 * this.skill) * (1 / (1 + r * 0.02));
    this.heading += THREE.MathUtils.clamp(d, -turn * dt, turn * dt);

    // Throttle: ease off only when almost on top of the goal, so bots do not
    // creep. Fleeing is always full commitment.
    let thr = 1;
    if (this.mode === BOT_MODE.FARM) {
      const dg = Math.hypot(this.goal.x - h.position.x, this.goal.y - h.position.z);
      thr = THREE.MathUtils.clamp(dg / Math.max(6, r * 1.2), 0.45, 1);
    }
    h.desiredDir.set(Math.cos(this.heading) * thr, Math.sin(this.heading) * thr);
  }
}

/**
 * @param {number} count
 * @param {import('./entities.js').EntityRegistry} registry
 * @param {*} rng
 * @param {(i:number,n:number)=>{x:number,z:number}} spawnPoint
 * @param {*} [layout] optional city layout — enables exact water tests
 */
export function spawnBots(count, registry, rng, spawnPoint, layout = null) {
  const bots = [];
  const used = [...NAMES];
  const flock = { claims: [] };
  for (let i = 0; i < count; i++) {
    const ni = rng.int(0, used.length - 1);
    const name = used.splice(ni, 1)[0] || `Bot ${i + 1}`;
    const p = spawnPoint(i, count);
    const safe = clampToLand(p.x, p.z, layout);
    const hole = new Hole({
      type: 'bot',
      name,
      color: COLORS[i % COLORS.length],
      x: safe.x, z: safe.z,
    });
    // Deal skill evenly across the band instead of rolling it. Seven
    // independent rolls cluster in the middle, and a lobby of seven mid-table
    // bots is exactly the "opponents are scenery" failure we are fixing: this
    // guarantees a pushover at the bottom and a real threat at the top.
    const skill = count > 1
      ? MATCH.BOT_SKILL_MIN + (i / (count - 1)) * (MATCH.BOT_SKILL_MAX - MATCH.BOT_SKILL_MIN)
      : 0.7;
    bots.push({
      hole,
      ctrl: new BotController(hole, registry, rng, { flock, layout, skill }),
    });
  }
  return bots;
}
