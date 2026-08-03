/**
 * Road + sidewalk graph.
 *
 * PURE DATA, derived from cityLayout. No THREE objects, no behaviour — this is
 * the shared substrate that vehicles.js and pedestrians.js both drive on, so
 * traffic and foot traffic agree about where a lane is, where a kerb is, and
 * when a light is green.
 *
 * Conventions
 * -----------
 * Right-hand traffic. For a road running along +z, "forward = +z" has its right
 * hand pointing toward -x, so keep-right lanes sit at negative x offsets. For a
 * road running along +x, right points toward +z. Both are derived below rather
 * than hardcoded, because getting this backwards makes every car in the city
 * drive on the wrong side and it is surprisingly hard to see.
 *
 * Coordinates
 * -----------
 * A lane is an infinite-ish straight line. A vehicle's state is (lane, s) where
 * s is metres travelled along the lane's own direction. `sampleLane` turns that
 * back into world x/z. Turning at a junction means hopping to a crossing lane at
 * the s that corresponds to the same intersection.
 */

import { WORLD } from '../config.js';
import { ROAD_CLASS } from './cityLayout.js';

/** Lane width, and the offsets used for 1-, 2- and 3-lane-per-direction roads. */
export const LANE_W = 3.4;

/** Seconds per full traffic-light cycle, and the green share per axis. */
export const LIGHT_CYCLE = 16.0;
export const LIGHT_GREEN = 0.42;   // fraction of the cycle each axis gets green
export const LIGHT_AMBER = 0.06;   // fraction spent amber before the swap

export class RoadNetwork {
  /** @param {ReturnType<import('./cityLayout.js').buildLayout>} layout */
  constructor(layout) {
    this.layout = layout;
    /** @type {Lane[]} */
    this.lanes = [];
    /** @type {Intersection[]} */
    this.intersections = [];
    /** Intersections keyed by "rxIndex:rzIndex" for O(1) lookup. */
    this._ixByKey = new Map();
    /** @type {SidewalkPath[]} */
    this.sidewalks = [];
    /** @type {Crossing[]} */
    this.crossings = [];

    this._buildLanes();
    this._buildIntersections();
    this._linkLanesToIntersections();
    this._buildSidewalks();
  }

  /* ------------------------------------------------------------- lanes --- */

  _buildLanes() {
    const { roadsX, roadsZ } = this.layout;
    const S = WORLD.SIZE;

    const lanesFor = (cls) => {
      if (cls === ROAD_CLASS.BOULEVARD) return 2;
      if (cls === ROAD_CLASS.AVENUE) return 2;
      return 1;
    };

    // Roads running north/south (constant x, travel along z).
    for (let ri = 0; ri < roadsX.length; ri++) {
      const r = roadsX[ri];
      const n = lanesFor(r.cls);
      const medianPad = r.median ? (r.medianW || 0) * 0.5 : 0;
      for (let dir of [1, -1]) {
        // forward=+z -> right is -x ; forward=-z -> right is +x
        const rightSign = dir > 0 ? -1 : 1;
        for (let k = 0; k < n; k++) {
          // Lane 0 is the kerb lane, lane n-1 hugs the centreline/median.
          const inward = (n - 0.5 - k) * LANE_W + medianPad;
          const offset = rightSign * inward;
          this.lanes.push(makeLane({
            id: this.lanes.length,
            axis: 'x',            // the road's fixed coordinate is x
            roadIndex: ri,
            road: r,
            cross: r.pos + offset,
            dir,
            index: k,
            kerbLane: k === 0,
            min: -S - 30,
            max: S + 30,
            speed: speedFor(r.cls),
          }));
        }
      }
    }

    // Roads running east/west (constant z, travel along x).
    for (let ri = 0; ri < roadsZ.length; ri++) {
      const r = roadsZ[ri];
      const n = lanesFor(r.cls);
      const medianPad = r.median ? (r.medianW || 0) * 0.5 : 0;
      for (let dir of [1, -1]) {
        // forward=+x -> right is +z ; forward=-x -> right is -z
        const rightSign = dir > 0 ? 1 : -1;
        for (let k = 0; k < n; k++) {
          const inward = (n - 0.5 - k) * LANE_W + medianPad;
          const offset = rightSign * inward;
          this.lanes.push(makeLane({
            id: this.lanes.length,
            axis: 'z',
            roadIndex: ri,
            road: r,
            cross: r.pos + offset,
            dir,
            index: k,
            kerbLane: k === 0,
            min: -S - 30,
            max: WORLD.BAY_EDGE + 30,
            speed: speedFor(r.cls),
          }));
        }
      }
    }
  }

  /* ----------------------------------------------------- intersections --- */

  _buildIntersections() {
    const { roadsX, roadsZ } = this.layout;
    for (let i = 0; i < roadsX.length; i++) {
      for (let j = 0; j < roadsZ.length; j++) {
        const rx = roadsX[i], rz = roadsZ[j];
        // Junctions that fall in the bay or the river simply do not exist.
        if (this.layout.isWater(rx.pos, rz.pos)) continue;
        const ix = {
          id: this.intersections.length,
          x: rx.pos, z: rz.pos,
          ri: i, rj: j,
          halfX: rx.half, halfZ: rz.half,
          /** Stop line distance from the centre, per axis. */
          stopX: rz.half + 2.6,
          stopZ: rx.half + 2.6,
          /**
           * Which axis holds green first. Alternating it in a checkerboard means
           * a car cruising down a street meets a mix of reds instead of hitting
           * every junction in phase, which looks far more like real traffic.
           */
          phaseOffset: ((i + j) % 2) * 0.5,
          signalled: rx.cls !== ROAD_CLASS.STREET || rz.cls !== ROAD_CLASS.STREET,
        };
        this.intersections.push(ix);
        this._ixByKey.set(`${i}:${j}`, ix);
      }
    }
  }

  _linkLanesToIntersections() {
    for (const lane of this.lanes) {
      const list = [];
      for (const ix of this.intersections) {
        if (lane.axis === 'x') {
          if (ix.ri !== lane.roadIndex) continue;
          list.push({ ix, s: this.sFor(lane, ix.x, ix.z) });
        } else {
          if (ix.rj !== lane.roadIndex) continue;
          list.push({ ix, s: this.sFor(lane, ix.x, ix.z) });
        }
      }
      list.sort((a, b) => a.s - b.s);
      lane.junctions = list;
    }
  }

  /* --------------------------------------------------------- sidewalks --- */

  _buildSidewalks() {
    // One closed loop of waypoints per block, sitting just outside the building
    // line. Pedestrians walk these; at corners they may take a crossing.
    for (const b of this.layout.blocks) {
      const inset = 2.2;
      const hw = b.w / 2 - inset;
      const hd = b.d / 2 - inset;
      if (hw < 3 || hd < 3) continue;
      const pts = [
        { x: b.x - hw, z: b.z - hd },
        { x: b.x + hw, z: b.z - hd },
        { x: b.x + hw, z: b.z + hd },
        { x: b.x - hw, z: b.z + hd },
      ];
      // Subdivide the long edges so walkers do not travel in 70 m straight
      // hops — they need intermediate points to sidestep props and each other.
      const dense = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], c = pts[(i + 1) % pts.length];
        const len = Math.hypot(c.x - a.x, c.z - a.z);
        const n = Math.max(1, Math.round(len / 7));
        for (let k = 0; k < n; k++) {
          const t = k / n;
          dense.push({ x: a.x + (c.x - a.x) * t, z: a.z + (c.z - a.z) * t });
        }
      }
      this.sidewalks.push({
        block: b,
        points: dense,
        /** Perimeter length, for uniform sampling. */
        length: perimeter(dense),
        streetLife: b.streetLife ?? 0.4,
      });
    }

    // Crossings: at every intersection, one per approach, linking the kerbs on
    // either side of the roadway. Pedestrians use these to change block.
    for (const ix of this.intersections) {
      const { x, z, halfX, halfZ } = ix;
      // north/south crossing (walker travels along z, over the E/W road)
      for (const sx of [-1, 1]) {
        this.crossings.push({
          ix,
          axis: 'z',
          a: { x: x + sx * (halfX + 3.2), z: z - halfZ - 2.4 },
          b: { x: x + sx * (halfX + 3.2), z: z + halfZ + 2.4 },
          length: (halfZ + 2.4) * 2,
        });
      }
      // east/west crossing (walker travels along x, over the N/S road)
      for (const sz of [-1, 1]) {
        this.crossings.push({
          ix,
          axis: 'x',
          a: { x: x - halfX - 2.4, z: z + sz * (halfZ + 3.2) },
          b: { x: x + halfX + 2.4, z: z + sz * (halfZ + 3.2) },
          length: (halfX + 2.4) * 2,
        });
      }
    }
  }

  /* ----------------------------------------------------------- queries --- */

  /** Distance along `lane` of the world point (x,z) projected onto it. */
  sFor(lane, x, z) {
    return lane.axis === 'x' ? z * lane.dir : x * lane.dir;
  }

  /** World position at distance s along a lane. Writes into `out`. */
  sampleLane(lane, s, out = { x: 0, z: 0 }) {
    if (lane.axis === 'x') {
      out.x = lane.cross;
      out.z = s * lane.dir;
    } else {
      out.x = s * lane.dir;
      out.z = lane.cross;
    }
    return out;
  }

  /** Heading in radians for a lane, suitable for mesh.rotation.y. */
  headingOf(lane) {
    if (lane.axis === 'x') return lane.dir > 0 ? 0 : Math.PI;
    return lane.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
  }

  /** s at which this lane leaves the map. */
  sRange(lane) {
    const a = this.sFor(lane, lane.min, lane.min);
    const b = this.sFor(lane, lane.max, lane.max);
    return a < b ? { lo: a, hi: b } : { lo: b, hi: a };
  }

  /**
   * The next junction a vehicle at `s` will reach, or null.
   * Returns { ix, s, distance }.
   */
  nextJunction(lane, s) {
    const js = lane.junctions;
    for (let i = 0; i < js.length; i++) {
      if (js[i].s > s) return { ix: js[i].ix, s: js[i].s, distance: js[i].s - s };
    }
    return null;
  }

  /**
   * Light state for an axis at an intersection.
   * @returns {'green'|'amber'|'red'}
   */
  lightFor(ix, axis, time) {
    if (!ix.signalled) return 'green';
    const t = ((time / LIGHT_CYCLE) + ix.phaseOffset) % 1;
    // First half of the cycle belongs to the north/south roads (axis 'x' lanes,
    // which travel along z); the second half to east/west.
    const mine = axis === 'x' ? t < 0.5 : t >= 0.5;
    if (!mine) return 'red';
    const local = axis === 'x' ? t / 0.5 : (t - 0.5) / 0.5;
    if (local > LIGHT_GREEN / 0.5 + LIGHT_AMBER / 0.5) return 'red';
    if (local > LIGHT_GREEN / 0.5) return 'amber';
    return 'green';
  }

  /**
   * Lanes crossing `lane` at intersection `ix`, for turning. Returns lanes on
   * the perpendicular road, kerb-lane first (you turn into the outside lane).
   */
  turnOptions(lane, ix) {
    const wantAxis = lane.axis === 'x' ? 'z' : 'x';
    const roadIndex = lane.axis === 'x' ? ix.rj : ix.ri;
    const out = [];
    for (const l of this.lanes) {
      if (l.axis !== wantAxis || l.roadIndex !== roadIndex) continue;
      if (!l.kerbLane) continue;
      out.push(l);
    }
    return out;
  }

  /** Pick a random point on a sidewalk loop, weighted by street life. */
  randomSidewalkPoint(rng) {
    if (!this.sidewalks.length) return null;
    // Weighted so cafés and spines get crowds and back lots stay quiet.
    let total = 0;
    for (const s of this.sidewalks) total += 0.15 + s.streetLife;
    let r = rng() * total;
    for (const s of this.sidewalks) {
      r -= 0.15 + s.streetLife;
      if (r <= 0) {
        const i = Math.floor(rng() * s.points.length);
        return { path: s, index: i, point: s.points[i] };
      }
    }
    const s = this.sidewalks[this.sidewalks.length - 1];
    return { path: s, index: 0, point: s.points[0] };
  }

  stats() {
    return {
      lanes: this.lanes.length,
      intersections: this.intersections.length,
      sidewalkLoops: this.sidewalks.length,
      sidewalkPoints: this.sidewalks.reduce((n, s) => n + s.points.length, 0),
      crossings: this.crossings.length,
    };
  }
}

/* ---------------------------------------------------------------- utils --- */

function makeLane(o) {
  o.junctions = [];
  return o;
}

function speedFor(cls) {
  if (cls === ROAD_CLASS.BOULEVARD) return 15.5;  // ~55 km/h
  if (cls === ROAD_CLASS.AVENUE) return 12.5;
  return 9.5;
}

function perimeter(pts) {
  let L = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    L += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return L;
}

/**
 * @typedef {{id:number, axis:'x'|'z', roadIndex:number, road:object, cross:number,
 *            dir:1|-1, index:number, kerbLane:boolean, min:number, max:number,
 *            speed:number, junctions:{ix:object,s:number}[]}} Lane
 * @typedef {{id:number,x:number,z:number,ri:number,rj:number,halfX:number,
 *            halfZ:number,stopX:number,stopZ:number,phaseOffset:number,
 *            signalled:boolean}} Intersection
 * @typedef {{block:object, points:{x:number,z:number}[], length:number,
 *            streetLife:number}} SidewalkPath
 * @typedef {{ix:object, axis:'x'|'z', a:{x:number,z:number}, b:{x:number,z:number},
 *            length:number}} Crossing
 */
