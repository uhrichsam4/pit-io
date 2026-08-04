/**
 * Game modes.
 *
 * THE CONTRACT. A mode is data plus a few optional hooks — it never forks the
 * game loop. Everything a mode can change is expressed here, so adding a mode
 * is writing one object rather than threading conditionals through the match.
 *
 *   id            stable key, used in saves and on the wire
 *   name, blurb   what the card says
 *   rules         short bullet list for the mode card
 *   icon, accent  visual identity for the card
 *   duration      match length in seconds
 *   startRadius   the hole every player starts at
 *   botCount      how many AI opponents fill the match
 *   scoreFor(c)   points for consuming Consumable `c`; 0 means "does not count"
 *   canEat(c)     optional hard filter — false means the mode forbids it
 *   teams         2 for team play, 0 for free-for-all
 *   shrink        { startAt, endRadius } to close the map in, or null
 *   rewards       { xp, coins } baseline, scaled by placement
 *
 * A mode returning 0 from scoreFor still lets the object be EATEN — it simply
 * earns nothing. That is deliberate: blocking consumption outright makes the
 * world feel broken, whereas a bus that gives no points in Crowd Control just
 * makes you stop bothering with buses.
 */

import { TIER } from '../config.js';

/** Kind matchers, shared so modes agree on what a "vehicle" is. */
const RX = {
  vehicle: /car|sedan|suv|taxi|van|truck|bus|pickup|hatch|sport|convert|police|ambul|shuttle|mixer|excav|loader|dumper|flatbed|garbage|motor|scooter|bike|bicycle|exotic|super|luxur/i,
  person: /ped|person|tourist|worker|office|jogger|cyclist|dog|busker|vendor|crowd|diner|waiter/i,
  building: /tower|midrise|storefront|garage|construction|landmark|building|block/i,
};

const isVehicle = (c) => RX.vehicle.test(c.kind || '');
const isPerson = (c) => RX.person.test(c.kind || '');
const isBuilding = (c) => c.crumbles || c.tier.id >= 6 || RX.building.test(c.kind || '');

/** Default scoring: whatever the object is worth. */
const base = (c) => c.score;

export const MODES = [
  {
    id: 'classic',
    name: 'Classic Devour',
    blurb: 'Eat the city. Grow. Be the biggest hole in Miami.',
    rules: [
      'Everything counts',
      'Grow to unlock bigger targets',
      'Swallow rivals once you outgrow them',
    ],
    icon: '🕳️',
    accent: '#ff3d8b',
    duration: 150,
    startRadius: 2,
    botCount: 7,
    teams: 0,
    shrink: null,
    scoreFor: base,
    rewards: { xp: 120, coins: 40 },
  },
  {
    id: 'car-crunch',
    name: 'Car Crunch',
    blurb: 'Only what drives counts. Hunt the traffic.',
    rules: [
      'Vehicles only score',
      'Luxury and exotics are worth double',
      'Everything else is still edible, just worthless',
    ],
    icon: '🚗',
    accent: '#ffc93c',
    duration: 150,
    startRadius: 3,
    botCount: 7,
    teams: 0,
    shrink: null,
    scoreFor(c) {
      if (!isVehicle(c)) return 0;
      const lux = /exotic|super|luxur|sport|convert/i.test(c.kind || '');
      return Math.round(c.score * (lux ? 2 : 1) * 1.4);
    },
    rewards: { xp: 130, coins: 45 },
  },
  {
    id: 'crowd-control',
    name: 'Crowd Control',
    blurb: 'The sidewalks are packed. Go where the people are.',
    rules: [
      'Only people score',
      'Busy areas are worth the trip',
      'Cafés, queues and the promenade are the hot spots',
    ],
    icon: '🚶',
    accent: '#37e6d5',
    duration: 150,
    startRadius: 2,
    botCount: 7,
    teams: 0,
    shrink: null,
    scoreFor(c) { return isPerson(c) ? Math.round(Math.max(6, c.score) * 3) : 0; },
    rewards: { xp: 130, coins: 45 },
  },
  {
    id: 'building-rush',
    name: 'Building Rush',
    blurb: 'Start big. Take the skyline apart.',
    rules: [
      'Everyone starts large',
      'Only structures score',
      'Towers are worth a fortune',
    ],
    icon: '🏙️',
    accent: '#8b5cf6',
    duration: 150,
    startRadius: 14,
    botCount: 7,
    teams: 0,
    shrink: null,
    scoreFor(c) { return isBuilding(c) ? Math.round(c.score * 1.25) : 0; },
    rewards: { xp: 150, coins: 55 },
  },
  {
    id: 'last-hole',
    name: 'Last Hole Standing',
    blurb: 'The map closes in. Outlast everyone.',
    rules: [
      'The play area shrinks',
      'Outside the ring you stop growing',
      'Last hole alive wins',
    ],
    icon: '⭕',
    accent: '#ff6b6b',
    duration: 180,
    startRadius: 2.5,
    botCount: 7,
    teams: 0,
    shrink: { startAt: 0.25, endRadius: 90 },
    scoreFor: base,
    rewards: { xp: 170, coins: 65 },
  },
  {
    id: 'team-devour',
    name: 'Team Devour',
    blurb: 'Two teams. One city. Combined scores decide it.',
    rules: [
      'Two teams, scores pooled',
      'You cannot swallow a teammate',
      'Coordinate — split the map or stack a district',
    ],
    icon: '🤝',
    accent: '#4dd2ff',
    duration: 165,
    startRadius: 2,
    botCount: 7,
    teams: 2,
    shrink: null,
    scoreFor: base,
    rewards: { xp: 140, coins: 50 },
  },
];

/** Rotating limited-time events. `activeEvent()` picks by the ISO week. */
export const EVENTS = [
  {
    id: 'neon-nights',
    name: 'Neon Nights',
    blurb: 'Miami after dark. Everything glows, everything counts double.',
    rules: ['Permanent night', 'Double score', 'Bonus coins'],
    icon: '🌴',
    accent: '#ff4fd8',
    duration: 150,
    startRadius: 2,
    botCount: 7,
    teams: 0,
    shrink: null,
    timeOfDay: 0.88,
    scoreFor(c) { return Math.round(c.score * 2); },
    rewards: { xp: 200, coins: 90 },
    limited: true,
  },
  {
    id: 'rush-hour',
    name: 'Rush Hour',
    blurb: 'Gridlock. Short, fast, and only traffic counts.',
    rules: ['90 seconds', 'Vehicles only', 'Start big, move fast'],
    icon: '🚦',
    accent: '#ffa53c',
    duration: 90,
    startRadius: 4,
    botCount: 7,
    teams: 0,
    shrink: null,
    scoreFor(c) { return isVehicle(c) ? Math.round(c.score * 2) : 0; },
    rewards: { xp: 180, coins: 80 },
    limited: true,
  },
];

const ALL = [...MODES, ...EVENTS];

export function getMode(id) {
  return ALL.find((m) => m.id === id) || MODES[0];
}

export function listModes() { return MODES.slice(); }

/** The event on rotation this week. Deterministic, so every client agrees. */
export function activeEvent() {
  const now = new Date();
  const week = Math.floor((now - new Date(now.getFullYear(), 0, 1)) / 6048e5);
  return EVENTS[week % EVENTS.length];
}

/**
 * Placement multiplier for end-of-match rewards. First place earns roughly
 * double last place — enough to matter, not so much that a bad match feels
 * like wasted time.
 */
export function rewardFor(mode, rank, players) {
  const m = getMode(mode.id || mode);
  const share = players > 1 ? 1 - (rank - 1) / (players - 1) : 1;
  const mult = 0.55 + share * 0.9;
  return {
    xp: Math.round(m.rewards.xp * mult),
    coins: Math.round(m.rewards.coins * mult),
  };
}

/** Tier list a mode actually rewards, for the mode card's "targets" row. */
export function targetsOf(mode) {
  const m = getMode(mode.id || mode);
  if (m.id === 'car-crunch') return ['Cars', 'Buses', 'Trucks', 'Exotics'];
  if (m.id === 'crowd-control') return ['Pedestrians', 'Crowds', 'Cafés'];
  if (m.id === 'building-rush') return ['Storefronts', 'Garages', 'Towers'];
  return Object.values(TIER).map((t) => t.label);
}
