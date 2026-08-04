/**
 * The cosmetic catalogue — every skin, trail, rim effect, nameplate, profile
 * icon and emote in the game, plus the procedural previews the store draws
 * them with.
 *
 * COSMETIC ONLY. Nothing in this file may touch speed, growth or score. The
 * game reads `skinColors`, `trailSpec` and `rimSpec` to tint the hole and its
 * particles; those return colours and lifetimes, never gameplay numbers.
 *
 * NO BINARY ASSETS. `previewSVG` draws each item as an inline SVG string —
 * a real hole for a skin, a tapered ribbon for a trail, an animated ring for a
 * rim, an actual plate for a nameplate. A store full of grey squares is
 * worthless, so the previews are the product and they get the code budget.
 *
 * IDS ARE SAVE DATA. `skin-classic`, `trail-none`, `rim-classic`, `hole-01`,
 * `plate-default` and `emote-wave` are the free items src/meta/profile.js ships
 * equipped. They must stay in this catalogue, at price 0, forever — a player
 * whose equipped id is not in here sees an empty profile.
 */

/* ------------------------------------------------------------- rarity --- */

/** Colours mirror --r-* in src/ui/css/tokens.css. Weights are drop shares. */
export const RARITY = {
  common: { id: 'common', label: 'Common', color: '#9fb0c6', weight: 58 },
  rare: { id: 'rare', label: 'Rare', color: '#4dc4ff', weight: 27 },
  epic: { id: 'epic', label: 'Epic', color: '#b46bff', weight: 11 },
  legendary: { id: 'legendary', label: 'Legendary', color: '#ffb01f', weight: 3.4 },
  mythic: { id: 'mythic', label: 'Mythic', color: '#ff3d8b', weight: 0.6 },
};

/** Highest first — the store sorts on this so aspirational items sit on top. */
export const RARITY_ORDER = ['mythic', 'legendary', 'epic', 'rare', 'common'];

/** One price per rarity. Never price an item by hand; typos here are real money
 *  to a player who ground for it. */
export const PRICE = { common: 150, rare: 400, epic: 900, legendary: 2000, mythic: 4000 };

export const CATEGORIES = [
  { kind: 'skin', label: 'Hole Skins' },
  { kind: 'trail', label: 'Trails' },
  { kind: 'rim', label: 'Rim Effects' },
  { kind: 'nameplate', label: 'Nameplates' },
  { kind: 'icon', label: 'Profile Icons' },
  { kind: 'emote', label: 'Emotes' },
];

/* -------------------------------------------------------------- items --- */

/**
 * Build one catalogue entry. Price comes from the rarity table unless the item
 * is unlocked by progression instead, in which case it is not for sale at all
 * and the store shows the requirement where the price would be.
 */
function mk(kind, id, name, rarity, desc, extra = {}) {
  const it = {
    id,
    kind,
    name,
    rarity,
    price: extra.unlock || extra.free ? 0 : PRICE[rarity],
    desc,
    ...extra,
  };
  delete it.free;
  return it;
}

export const ITEMS = [
  /* ---- hole skins ------------------------------------------------------ */
  mk('skin', 'skin-classic', 'Classic Void', 'common',
    'The hole you started with. Honest, bottomless, hot pink at the lip.',
    { free: true, colors: { core: '#0a0f1a', rim: '#ff3d8b', glow: '#ff3d8b' }, pattern: 'plain' }),
  mk('skin', 'skin-neon-lip', 'Neon Lip', 'common',
    'A cold aqua ring that reads from three blocks away.',
    { colors: { core: '#08131c', rim: '#37e6d5', glow: '#37e6d5' }, pattern: 'ring' }),
  mk('skin', 'skin-aqua-fade', 'Shallow End', 'common',
    'Turquoise light spilling up out of something with no bottom.',
    { colors: { core: '#06202a', rim: '#9fe4ff', glow: '#37e6d5' }, pattern: 'bubbles' }),
  mk('skin', 'skin-checker', 'Chequer Drop', 'rare',
    'Finish-line teeth around the rim. Purely decorative. Feels faster anyway.',
    { colors: { core: '#10141c', rim: '#fbf7ef', glow: '#9fb0c6' }, pattern: 'checker' }),
  mk('skin', 'skin-sunset', 'Sunset Drive', 'rare',
    'Six-thirty on Ocean, the sky going pink over a hole in the road.',
    { colors: { core: '#2a0b3a', rim: '#ffc93c', glow: '#ff3d8b' }, pattern: 'sunburst' }),
  mk('skin', 'skin-oceanic', 'Blue Hole', 'rare',
    'Biscayne water, poured into a shape it should not be able to hold.',
    { colors: { core: '#052033', rim: '#37e6d5', glow: '#4dc4ff' }, pattern: 'waves' }),
  mk('skin', 'skin-deco-gold', 'Deco Gilt', 'rare',
    'Gold leaf, stepped edges, 1936 and proud of it.',
    { colors: { core: '#120d05', rim: '#ffc93c', glow: '#ffb01f' }, pattern: 'deco' }),
  mk('skin', 'skin-mojito', 'Mojito', 'epic',
    'Lime, mint, crushed ice and a void. Two of those are refreshing.',
    { colors: { core: '#062616', rim: '#4dff9e', glow: '#4dff9e' }, pattern: 'sparkle' }),
  mk('skin', 'skin-vapor', 'Vapour Grid', 'epic',
    'A wireframe horizon that keeps going down instead of away.',
    { colors: { core: '#1a0730', rim: '#c58cff', glow: '#ff3d8b' }, pattern: 'grid' }),
  mk('skin', 'skin-storm', 'Storm Eye', 'epic',
    'Calm in the middle, absolutely not calm anywhere else.',
    { colors: { core: '#0b1230', rim: '#b46bff', glow: '#4dc4ff' }, pattern: 'swirl' }),
  mk('skin', 'skin-chrome', 'Chrome Bumper', 'epic',
    'Polished to a mirror by a man on Bayfront who does not accept tips.',
    { colors: { core: '#151a22', rim: '#d7dde6', glow: '#9fe4ff' }, pattern: 'chrome' }),
  mk('skin', 'skin-flamingo', 'Flamingo', 'legendary',
    'Pink on pink on pink. Stands in one place looking incredible.',
    { colors: { core: '#3a0a20', rim: '#ff7fb0', glow: '#ff3d8b' }, pattern: 'feather' }),
  mk('skin', 'skin-eclipse', 'Total Eclipse', 'legendary',
    'A ring of fire around absolutely nothing. Earned, never sold.',
    {
      unlock: { level: 20, label: 'Reach level 20' },
      colors: { core: '#000000', rim: '#ffb01f', glow: '#ff9430' }, pattern: 'corona',
    }),
  mk('skin', 'skin-singularity', 'Singularity', 'mythic',
    'Light goes in. Buses go in. Opinions about the parking go in.',
    { colors: { core: '#02010a', rim: '#ff3d8b', glow: '#c58cff' }, pattern: 'stars' }),

  /* ---- trails ---------------------------------------------------------- */
  mk('trail', 'trail-none', 'No Trail', 'common',
    'Leave nothing behind. Some players swear it is faster. It is not.',
    { free: true, trail: { color: '#9fb0c6', color2: '#9fb0c6', life: 0, width: 0, sparkle: false, style: 'none' } }),
  mk('trail', 'trail-dust', 'Dust Plume', 'common',
    'Powdered sidewalk, hanging in the afternoon light.',
    { trail: { color: '#cbb79a', color2: '#8a8375', life: 0.7, width: 7, sparkle: false, style: 'dust' } }),
  mk('trail', 'trail-neon', 'Neon Wake', 'common',
    'A clean aqua stripe down the middle of the street.',
    { trail: { color: '#37e6d5', color2: '#4dff9e', life: 0.9, width: 5, sparkle: false, style: 'ribbon' } }),
  mk('trail', 'trail-foam', 'Sea Foam', 'rare',
    'Salt water where the asphalt used to be.',
    { trail: { color: '#ffffff', color2: '#37e6d5', life: 1.1, width: 6, sparkle: true, style: 'foam' } }),
  mk('trail', 'trail-sunset', 'Sunset Streak', 'rare',
    'Three bands of sky, dragged along behind you.',
    { trail: { color: '#ffc93c', color2: '#ff3d8b', life: 1.0, width: 7, sparkle: false, style: 'bands' } }),
  mk('trail', 'trail-confetti', 'Carnaval', 'rare',
    'Calle Ocho in March, following you at speed.',
    { trail: { color: '#ff9430', color2: '#4dff9e', life: 1.2, width: 6, sparkle: true, style: 'confetti' } }),
  mk('trail', 'trail-embers', 'Embers', 'epic',
    'Whatever you just ate is still complaining about it.',
    { trail: { color: '#ff9430', color2: '#ffc93c', life: 1.0, width: 5, sparkle: true, style: 'sparks' } }),
  mk('trail', 'trail-rainbow', 'Causeway', 'epic',
    'Every lane of the MacArthur at once.',
    { trail: { color: '#ff3d8b', color2: '#37e6d5', life: 1.1, width: 8, sparkle: false, style: 'rainbow' } }),
  mk('trail', 'trail-neon-tube', 'Deco Neon', 'legendary',
    'Bent glass tubing, buzzing gently, trailing a hole through Miami Beach.',
    { trail: { color: '#ffc93c', color2: '#ff3d8b', life: 1.3, width: 6, sparkle: false, style: 'tube' } }),
  mk('trail', 'trail-champion', "Champion's Wake", 'legendary',
    'Gold dust. You only get this by winning, and only once.',
    {
      unlock: { achievement: 'first-win', label: 'Win a match' },
      trail: { color: '#ffb01f', color2: '#fff6d5', life: 1.2, width: 6, sparkle: true, style: 'sparks' },
    }),
  mk('trail', 'trail-void', 'Void Ribbon', 'mythic',
    'A tear in the afternoon that seals up a second after you pass.',
    { trail: { color: '#1a0a2a', color2: '#c58cff', life: 1.5, width: 9, sparkle: true, style: 'void' } }),

  /* ---- rim effects ----------------------------------------------------- */
  mk('rim', 'rim-classic', 'Classic Lip', 'common',
    'One clean pink ring. The shape everybody recognises.',
    { free: true, rim: { color: '#ff3d8b', pulse: 0.35, thickness: 1, style: 'solid' } }),
  mk('rim', 'rim-sun', 'Sunlit Lip', 'common',
    'Warm light pooling at the edge like the sun caught on it.',
    { rim: { color: '#ffc93c', pulse: 0.5, thickness: 1.15, style: 'glow' } }),
  mk('rim', 'rim-dashed', 'Lane Marks', 'common',
    'Road markings that gave up on the road and went around the hole.',
    { rim: { color: '#9fe4ff', pulse: 0.2, thickness: 0.9, style: 'dashed' } }),
  mk('rim', 'rim-tide', 'Tideline', 'rare',
    'A wet ring that keeps rolling inward and never fills anything.',
    { rim: { color: '#37e6d5', pulse: 0.7, thickness: 1.1, style: 'tide' } }),
  mk('rim', 'rim-deco', 'Deco Ring', 'rare',
    'Stepped gold notches, straight off a Collins Avenue lobby floor.',
    { rim: { color: '#ffc93c', pulse: 0.3, thickness: 1.2, style: 'deco' } }),
  mk('rim', 'rim-havana', 'Havana Heat', 'rare',
    'Air shimmering off the edge like a hot afternoon on Calle Ocho.',
    { rim: { color: '#ff9430', pulse: 0.85, thickness: 1.05, style: 'heat' } }),
  mk('rim', 'rim-spark', 'Sparkbite', 'epic',
    'Green sparks jumping the gap every time the rim finds something metal.',
    { rim: { color: '#4dff9e', pulse: 0.9, thickness: 1, style: 'sparks' } }),
  mk('rim', 'rim-cyclone', 'Cyclone', 'legendary',
    'Three counter-turning bands. Category five, contained to one lip.',
    { rim: { color: '#b46bff', pulse: 1, thickness: 1.25, style: 'cyclone' } }),
  mk('rim', 'rim-prism', 'Prism Halo', 'mythic',
    'The rim splits daylight into pieces on its way down.',
    { rim: { color: '#ff3d8b', pulse: 1, thickness: 1.3, style: 'prism' } }),

  /* ---- nameplates ------------------------------------------------------ */
  mk('nameplate', 'plate-default', 'Standard Issue', 'common',
    'Your name on a plain dark plate. Nothing to prove yet.',
    { free: true, plate: { shape: 'rounded', c1: '#243b5a', c2: '#0e1728', edge: '#9fb0c6', flourish: 'none' } }),
  mk('nameplate', 'plate-sand', 'Sandbar', 'common',
    'Warm bone paving, the colour of the sidewalk you are eating.',
    { plate: { shape: 'rounded', c1: '#cbb79a', c2: '#6f6552', edge: '#f2e6cd', flourish: 'none' } }),
  mk('nameplate', 'plate-neon', 'Neon Strip', 'common',
    'Dark glass with a cold tube running the length of it.',
    { plate: { shape: 'cut', c1: '#0b1c28', c2: '#050a12', edge: '#37e6d5', flourish: 'none' } }),
  mk('nameplate', 'plate-ocean', 'Ocean Drive', 'rare',
    'Turquoise, chamfered, still slightly damp.',
    { plate: { shape: 'wave', c1: '#0b6f7a', c2: '#05202f', edge: '#9fe4ff', flourish: 'none' } }),
  mk('nameplate', 'plate-vice', 'Vice', 'rare',
    'Pink over purple over a synth pad you cannot quite hear.',
    { plate: { shape: 'banner', c1: '#ff3d8b', c2: '#3b0d52', edge: '#ffc93c', flourish: 'none' } }),
  mk('nameplate', 'plate-deco', 'Deco Frieze', 'rare',
    'Stepped gold ends and a black field. Hotel lobby energy.',
    { plate: { shape: 'notched', c1: '#1a1206', c2: '#080604', edge: '#ffc93c', flourish: 'none' } }),
  mk('nameplate', 'plate-bayfront', 'Bayfront', 'epic',
    'Deep water blue with a chrome edge off a boat rail.',
    { plate: { shape: 'arch', c1: '#123b6d', c2: '#061426', edge: '#d7dde6', flourish: 'none' } }),
  mk('nameplate', 'plate-havana', 'Havana', 'epic',
    'Orange stucco, painted tile, a domino table just off frame.',
    { plate: { shape: 'tab', c1: '#c9541a', c2: '#3a1406', edge: '#4dff9e', flourish: 'none' } }),
  mk('nameplate', 'plate-storm', 'Storm Warning', 'legendary',
    'Double red flags. Everyone else went inside.',
    { plate: { shape: 'cut', c1: '#3a1150', c2: '#0a0620', edge: '#b46bff', flourish: 'bolt' } }),
  mk('nameplate', 'plate-champion', 'Champion', 'legendary',
    'Laurels either side of your name, for people who finished first.',
    {
      unlock: { level: 25, label: 'Reach level 25' },
      plate: { shape: 'arch', c1: '#4a3708', c2: '#140d02', edge: '#ffb01f', flourish: 'laurel' },
    }),
  mk('nameplate', 'plate-goldleaf', 'Gold Leaf', 'mythic',
    'Hand-gilded, faintly ridiculous, extremely visible on a scoreboard.',
    { plate: { shape: 'rounded', c1: '#ffb01f', c2: '#5c3a02', edge: '#fff6d5', flourish: 'sparkle' } }),

  /* ---- profile icons --------------------------------------------------- */
  // hole-01 keeps its legacy id because profile.js ships it equipped; the rest
  // use the icon- prefix.
  mk('icon', 'hole-01', 'Little Hole', 'common',
    'A small hole. Yours. It grows on you.',
    { free: true, emblem: 'hole', c1: '#37e6d5', c2: '#0b1622' }),
  mk('icon', 'icon-palm', 'Palm', 'common',
    'Bent permanently east by thirty years of sea breeze.',
    { emblem: 'palm', c1: '#4dff9e', c2: '#08301f' }),
  mk('icon', 'icon-shades', 'Shades', 'common',
    'Worn at night, indoors, and during a category three.',
    { emblem: 'shades', c1: '#9fe4ff', c2: '#111a2a' }),
  mk('icon', 'icon-flamingo', 'Flamingo', 'rare',
    'Standing on one leg in the middle of your profile.',
    { emblem: 'flamingo', c1: '#ff7fb0', c2: '#4a0d2a' }),
  mk('icon', 'icon-wave', 'Swell', 'rare',
    'Two feet, glassy, nobody out.',
    { emblem: 'wave', c1: '#37e6d5', c2: '#052033' }),
  mk('icon', 'icon-deco', 'Deco Fan', 'rare',
    'The sunburst above every good door on Ocean Drive.',
    { emblem: 'fan', c1: '#ffc93c', c2: '#2a1d04' }),
  mk('icon', 'icon-cafecito', 'Cafecito', 'rare',
    'Thimble-sized, load-bearing.',
    { emblem: 'cafecito', c1: '#ffb01f', c2: '#2b1508' }),
  mk('icon', 'icon-pelican', 'Pelican', 'epic',
    'Sitting on a piling, judging your line through the marina.',
    { emblem: 'pelican', c1: '#d7dde6', c2: '#0f2b46' }),
  mk('icon', 'icon-cyclone', 'Cyclone', 'epic',
    'A spiral with a very specific opinion about your roof.',
    { emblem: 'cyclone', c1: '#b46bff', c2: '#160a2e' }),
  mk('icon', 'icon-sunset', 'Sundown', 'epic',
    'Half a sun, three bands of water, no filter.',
    { emblem: 'sunset', c1: '#ff9430', c2: '#3b0d52' }),
  mk('icon', 'icon-crown', 'Crown', 'legendary',
    'Heavy, gaudy, worn at a slight angle.',
    { emblem: 'crown', c1: '#ffc93c', c2: '#3d2a04' }),
  mk('icon', 'icon-skull', 'Bone Yard', 'legendary',
    'For players who eat other players. Not sold — earned.',
    {
      unlock: { achievement: 'rivals-100', label: 'Swallow 100 rivals' },
      emblem: 'skull', c1: '#fbf7ef', c2: '#2a1030',
    }),
  mk('icon', 'icon-devourer', 'Devourer', 'mythic',
    'The mark of something that finished the city and looked around for more.',
    { emblem: 'star', c1: '#ff3d8b', c2: '#1a0320' }),

  /* ---- emotes ---------------------------------------------------------- */
  mk('emote', 'emote-wave', 'Wave', 'common',
    'Friendly. Usually a lie.',
    { free: true, glyph: '👋', accent: '#ffc93c' }),
  mk('emote', 'emote-laugh', 'Cackle', 'common',
    'For when a bus goes in sideways.',
    { glyph: '😂', accent: '#4dff9e' }),
  mk('emote', 'emote-gg', 'Good Game', 'common',
    'Sportsmanship, or a very specific kind of insult.',
    { glyph: '🤝', accent: '#9fe4ff' }),
  mk('emote', 'emote-shades', 'Deal With It', 'rare',
    'Deploy immediately after eating someone twice your size.',
    { glyph: '😎', accent: '#37e6d5' }),
  mk('emote', 'emote-flamingo', 'Flamingo', 'rare',
    'Elegant. Unbothered. Standing on your leaderboard.',
    { glyph: '🦩', accent: '#ff7fb0' }),
  mk('emote', 'emote-palm', 'Palm', 'rare',
    'The universal signal for "I am not in a hurry".',
    { glyph: '🌴', accent: '#4dff9e' }),
  mk('emote', 'emote-cafecito', 'Cafecito', 'rare',
    'Offered to the whole lobby, as is traditional.',
    { glyph: '☕', accent: '#ffb01f' }),
  mk('emote', 'emote-shark', 'Shark', 'epic',
    'There is something in the bay and it has your rank.',
    { glyph: '🦈', accent: '#4dc4ff' }),
  mk('emote', 'emote-storm', 'Storm', 'epic',
    'Spins ominously above whoever is in second place.',
    { glyph: '🌀', accent: '#b46bff' }),
  mk('emote', 'emote-crown', 'Royalty', 'legendary',
    'Only fun if you are actually winning.',
    { glyph: '👑', accent: '#ffc93c' }),
  mk('emote', 'emote-hole', 'The Void', 'mythic',
    'You send a hole. The hole says nothing. Everyone understands.',
    { glyph: '🕳️', accent: '#ff3d8b' }),
];

/* --------------------------------------------------------------- sets --- */

/**
 * Seasonal Miami collections. A completed set grants a nameplate flourish and
 * a badge in the store — nothing mechanical, by design.
 */
export const SETS = [
  {
    id: 'ocean-drive',
    name: 'Ocean Drive',
    blurb: 'Turquoise water, wet chrome and a very long lunch.',
    accent: '#37e6d5',
    flourish: 'A tide-line shimmer on your nameplate.',
    items: ['skin-oceanic', 'trail-foam', 'rim-tide', 'plate-ocean', 'icon-wave', 'emote-palm'],
  },
  {
    id: 'vice-sunset',
    name: 'Vice Sunset',
    blurb: 'Pink over purple, six-thirty, top down.',
    accent: '#ff3d8b',
    flourish: 'A neon underglow on your nameplate.',
    items: ['skin-sunset', 'trail-sunset', 'plate-vice', 'icon-sunset', 'emote-shades'],
  },
  {
    id: 'art-deco',
    name: 'Art Deco',
    blurb: 'Stepped gold, bent glass tubing, 1936 forever.',
    accent: '#ffc93c',
    flourish: 'Gilt stepping on your nameplate ends.',
    items: ['skin-deco-gold', 'trail-neon-tube', 'rim-deco', 'plate-deco', 'icon-deco'],
  },
  {
    id: 'bayfront',
    name: 'Bayfront',
    blurb: 'Marina chrome, causeway lights and one furious pelican.',
    accent: '#4dc4ff',
    flourish: 'A polished chrome edge on your nameplate.',
    items: ['skin-chrome', 'trail-rainbow', 'plate-bayfront', 'icon-pelican', 'emote-shark'],
  },
  {
    id: 'little-havana',
    name: 'Little Havana',
    blurb: 'Domino tables, painted tile, cafecito at four.',
    accent: '#ff9430',
    flourish: 'Painted tilework down your nameplate edge.',
    items: ['skin-mojito', 'trail-confetti', 'rim-havana', 'plate-havana', 'icon-cafecito', 'emote-cafecito'],
  },
  {
    id: 'hurricane-season',
    name: 'Hurricane Season',
    blurb: 'Boarded windows, double red flags, and nobody on the beach.',
    accent: '#b46bff',
    flourish: 'Storm banding across your nameplate.',
    ends: '2026-11-30T23:59:59Z',
    items: ['skin-storm', 'rim-cyclone', 'plate-storm', 'icon-cyclone', 'emote-storm'],
  },
];

/* Set membership lives on SETS, and is stamped back onto each item here so the
   two can never disagree — an item claiming a set it is not listed in would
   show as permanently one short of complete. */
const BY_ID = new Map(ITEMS.map((it) => [it.id, it]));
for (const s of SETS) {
  for (const id of s.items) {
    const it = BY_ID.get(id);
    if (it) it.set = s.id;
    else console.warn(`[cosmetics] set "${s.id}" lists unknown item "${id}"`);
  }
}

/* ------------------------------------------------------------ lookups --- */

export function itemsOf(kind) {
  return ITEMS.filter((it) => it.kind === kind);
}

export function getItem(id) {
  return BY_ID.get(id) || null;
}

export function getSet(id) {
  return SETS.find((s) => s.id === id) || null;
}

/** The set an item belongs to, or null. */
export function setOf(itemId) {
  const it = BY_ID.get(itemId);
  return it && it.set ? getSet(it.set) : null;
}

/** Items of a set, in catalogue order, skipping anything unknown. */
export function itemsOfSet(setId) {
  const s = getSet(setId);
  if (!s) return [];
  return s.items.map((id) => BY_ID.get(id)).filter(Boolean);
}

/** Milliseconds left on a limited set, or Infinity if it never ends. */
export function msLeft(set, now = Date.now()) {
  if (!set || !set.ends) return Infinity;
  const t = new Date(set.ends).getTime();
  return Number.isNaN(t) ? Infinity : t - now;
}

/**
 * Which collection the store leads with: a live limited set if one is running,
 * otherwise a daily rotation so the front of the store is never the same two
 * days running.
 */
export function featuredSet(now = Date.now()) {
  const live = SETS
    .filter((s) => msLeft(s, now) > 0 && s.ends)
    .sort((a, b) => msLeft(a, now) - msLeft(b, now));
  if (live.length) return live[0];
  return SETS[Math.floor(now / 864e5) % SETS.length];
}

/* ------------------------------------------------- specs for the game --- */

const DEFAULT_SKIN = { core: '#0a0f1a', rim: '#ff3d8b', glow: '#ff3d8b' };
const DEFAULT_TRAIL = { color: '#37e6d5', color2: '#4dff9e', life: 0.9, width: 5, sparkle: false, style: 'ribbon' };
const DEFAULT_RIM = { color: '#ff3d8b', pulse: 0.35, thickness: 1, style: 'solid' };

/** Hole material colours. Copies, so the renderer cannot mutate the catalogue. */
export function skinColors(id) {
  const it = BY_ID.get(id);
  return { ...DEFAULT_SKIN, ...(it && it.colors) };
}

/** Particle-trail parameters. `life` is seconds, `width` is metres at the rim. */
export function trailSpec(id) {
  const it = BY_ID.get(id);
  return { ...DEFAULT_TRAIL, ...(it && it.trail) };
}

/** Rim-effect parameters. `pulse` is 0..1, `thickness` multiplies the base lip. */
export function rimSpec(id) {
  const it = BY_ID.get(id);
  return { ...DEFAULT_RIM, ...(it && it.rim) };
}

/* ------------------------------------------------------------ preview --- */

/* Gradient ids must be unique per rendered SVG: two <defs> sharing an id in one
   document means every url(#id) resolves to whichever came first, so half the
   store would silently wear the other half's colours. */
let _uid = 0;
const nid = (p) => `${p}${(++_uid).toString(36)}`;

/* SMIL animation, not CSS, so a preview animates wherever it is dropped —
   including screens that never load store.css. tokens.css cannot reach inside
   an SVG's <animate>, so reduced motion is honoured by simply not emitting it. */
function reducedMotion() {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch { return false; }
}

function spin(dur, dir = 1) {
  if (reducedMotion()) return '';
  return `<animateTransform attributeName="transform" attributeType="XML" type="rotate" ` +
    `from="${dir > 0 ? 0 : 360} 50 52" to="${dir > 0 ? 360 : 0} 50 52" dur="${dur}s" repeatCount="indefinite"/>`;
}

function anim(attr, from, to, dur) {
  if (reducedMotion()) return '';
  return `<animate attributeName="${attr}" values="${from};${to};${from}" dur="${dur}s" repeatCount="indefinite"/>`;
}

function hex2rgb(h) {
  const s = String(h).replace('#', '');
  const n = parseInt(s.length === 3 ? s.split('').map((c) => c + c).join('') : s, 16);
  return Number.isNaN(n) ? [255, 255, 255] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Blend two hex colours. Used to shade preview geometry without a filter. */
function mix(a, b, t) {
  const A = hex2rgb(a);
  const B = hex2rgb(b);
  const c = A.map((v, i) => Math.round(v + (B[i] - v) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function starPath(cx, cy, r1, r2, points = 5, rot = -Math.PI / 2) {
  const p = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? r2 : r1;
    const a = rot + (i * Math.PI) / points;
    p.push(`${(cx + Math.cos(a) * r).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`);
  }
  return `M${p.join(' L')} Z`;
}

function spiralPath(cx, cy, r0, r1, turns) {
  const N = 60;
  const p = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const a = t * turns * Math.PI * 2;
    const r = r0 + (r1 - r0) * t;
    p.push(`${(cx + Math.cos(a) * r).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`);
  }
  return `M${p.join(' L')}`;
}

function svgWrap(size, inner, extraClass = '') {
  return `<svg class="cos-svg ${extraClass}" width="${size}" height="${size}" viewBox="0 0 100 100" ` +
    `xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true" focusable="false">${inner}</svg>`;
}

/* ---- skins: an actual hole ---------------------------------------------- */

/** Pattern overlays are clipped to the mouth, so nothing spills onto the road. */
function skinPattern(pattern, c) {
  const { rim, glow, core } = c;
  switch (pattern) {
    case 'ring':
      return `<ellipse cx="50" cy="53" rx="22" ry="18" fill="none" stroke="${rim}" stroke-width="1.8" opacity="0.55"/>` +
        `<ellipse cx="50" cy="53" rx="14" ry="11" fill="none" stroke="${rim}" stroke-width="1.2" opacity="0.3"/>`;
    case 'bubbles':
      return [[38, 60, 4], [56, 46, 3], [48, 64, 2.4], [62, 58, 2], [42, 47, 1.8]]
        .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${rim}" stroke-width="1.2" opacity="0.6"/>`)
        .join('');
    case 'checker':
      return `<ellipse cx="50" cy="53" rx="27" ry="22.5" fill="none" stroke="${rim}" stroke-width="6" ` +
        `stroke-dasharray="7 7" opacity="0.85"/>`;
    case 'sunburst':
      return Array.from({ length: 9 }, (_, i) => {
        const a = (i / 9) * Math.PI * 2;
        return `<line x1="50" y1="53" x2="${(50 + Math.cos(a) * 30).toFixed(1)}" y2="${(53 + Math.sin(a) * 25).toFixed(1)}" ` +
          `stroke="${rim}" stroke-width="1.6" opacity="0.35"/>`;
      }).join('');
    case 'waves':
      return [44, 54, 64].map((y, i) =>
        `<path d="M22 ${y} q7 -5 14 0 t14 0 t14 0" fill="none" stroke="${rim}" stroke-width="1.6" opacity="${0.5 - i * 0.12}"/>`
      ).join('');
    case 'deco':
      return `<path d="M50 34 L58 44 L50 40 L42 44 Z" fill="${rim}" opacity="0.7"/>` +
        `<path d="M50 72 L58 62 L50 66 L42 62 Z" fill="${rim}" opacity="0.7"/>` +
        `<ellipse cx="50" cy="53" rx="18" ry="15" fill="none" stroke="${rim}" stroke-width="1.4" opacity="0.4"/>`;
    case 'sparkle':
      return [[38, 44, 3.2], [60, 62, 2.6], [52, 40, 2], [42, 64, 2.2]]
        .map(([x, y, r]) => `<path d="${starPath(x, y, r, r * 0.36, 4)}" fill="${rim}" opacity="0.85"/>`).join('');
    case 'grid':
      return Array.from({ length: 5 }, (_, i) =>
        `<line x1="${26 + i * 12}" y1="32" x2="${34 + i * 8}" y2="74" stroke="${rim}" stroke-width="1" opacity="0.35"/>`
      ).join('') + [40, 50, 60, 68].map((y, i) =>
        `<line x1="20" y1="${y}" x2="80" y2="${y}" stroke="${rim}" stroke-width="1" opacity="${0.4 - i * 0.07}"/>`
      ).join('');
    case 'swirl':
      return `<path d="${spiralPath(50, 53, 3, 26, 1.9)}" fill="none" stroke="${rim}" stroke-width="2" ` +
        `stroke-linecap="round" opacity="0.7">${spin(9)}</path>`;
    case 'chrome':
      return `<path d="M28 44 a26 22 0 0 1 44 -4" fill="none" stroke="#ffffff" stroke-width="3.5" opacity="0.5"/>` +
        `<path d="M32 64 a22 18 0 0 0 34 6" fill="none" stroke="${rim}" stroke-width="2" opacity="0.45"/>`;
    case 'feather':
      return [0, 1, 2, 3].map((i) =>
        `<path d="M${30 + i * 8} 70 q${6 + i} -18 ${14 - i * 2} -26" fill="none" stroke="${rim}" ` +
        `stroke-width="2.2" stroke-linecap="round" opacity="${0.6 - i * 0.1}"/>`
      ).join('');
    case 'corona':
      return `<ellipse cx="50" cy="53" rx="28" ry="23.5" fill="none" stroke="${glow}" stroke-width="1.6" opacity="0.9"/>` +
        Array.from({ length: 14 }, (_, i) => {
          const a = (i / 14) * Math.PI * 2;
          return `<line x1="${(50 + Math.cos(a) * 28).toFixed(1)}" y1="${(53 + Math.sin(a) * 23).toFixed(1)}" ` +
            `x2="${(50 + Math.cos(a) * 34).toFixed(1)}" y2="${(53 + Math.sin(a) * 28).toFixed(1)}" ` +
            `stroke="${glow}" stroke-width="1.4" opacity="0.55"/>`;
        }).join('');
    case 'stars':
      return [[40, 44, 2.6], [58, 50, 1.8], [46, 62, 2.2], [64, 60, 1.5], [52, 47, 1.3]]
        .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#ffffff" opacity="0.85">${anim('opacity', 0.85, 0.2, 2 + r)}</circle>`)
        .join('') + `<path d="${spiralPath(50, 53, 2, 22, 1.4)}" fill="none" stroke="${mix(core, glow, 0.6)}" stroke-width="1.4" opacity="0.5"/>`;
    default:
      return '';
  }
}

function skinPreview(item, size) {
  const c = skinColors(item.id);
  const gCore = nid('c');
  const gGlow = nid('g');
  const clip = nid('k');
  const pattern = skinPattern(item.pattern, c);
  const inner =
    `<defs>` +
      `<radialGradient id="${gCore}" cx="50%" cy="42%" r="66%">` +
        `<stop offset="0%" stop-color="#01030a"/>` +
        `<stop offset="55%" stop-color="${mix('#01030a', c.core, 0.6)}"/>` +
        `<stop offset="100%" stop-color="${c.core}"/>` +
      `</radialGradient>` +
      `<radialGradient id="${gGlow}" cx="50%" cy="50%" r="50%">` +
        `<stop offset="55%" stop-color="${c.glow}" stop-opacity="0.5"/>` +
        `<stop offset="100%" stop-color="${c.glow}" stop-opacity="0"/>` +
      `</radialGradient>` +
      `<clipPath id="${clip}"><ellipse cx="50" cy="53" rx="30" ry="25"/></clipPath>` +
    `</defs>` +
    // The road the hole sits in, so the void has something to be darker than.
    `<rect x="4" y="10" width="92" height="82" rx="16" fill="#6b6a66"/>` +
    `<rect x="4" y="10" width="92" height="82" rx="16" fill="${mix('#6b6a66', c.glow, 0.18)}" opacity="0.6"/>` +
    `<ellipse cx="50" cy="53" rx="42" ry="35" fill="url(#${gGlow})"/>` +
    `<ellipse cx="50" cy="53" rx="30" ry="25" fill="url(#${gCore})"/>` +
    `<g clip-path="url(#${clip})">${pattern}</g>` +
    `<ellipse cx="50" cy="53" rx="30" ry="25" fill="none" stroke="${c.rim}" stroke-width="4.5"/>` +
    `<ellipse cx="50" cy="53" rx="33" ry="27.5" fill="none" stroke="${c.glow}" stroke-width="2" opacity="0.35"/>` +
    `<path d="M28 44 a30 25 0 0 1 24 -14" fill="none" stroke="#ffffff" stroke-width="1.6" opacity="0.35"/>`;
  return svgWrap(size, inner, 'cos-skin');
}

/* ---- trails: a tapered ribbon ------------------------------------------- */

const TRAIL_CURVE = [[10, 84], [34, 92], [58, 42], [92, 24]];

function bez(t) {
  const [p0, p1, p2, p3] = TRAIL_CURVE;
  const u = 1 - t;
  return [
    u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
  ];
}

function bezDir(t) {
  const e = 0.001;
  const a = bez(Math.max(0, t - e));
  const b = bez(Math.min(1, t + e));
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
}

/**
 * SVG strokes cannot taper, so the ribbon is built as a closed outline: walk
 * the curve, offset both sides by a half-width that grows toward the hole, and
 * close it. Every trail preview reuses this shape and only changes its fill.
 */
function ribbonPath(width, offset = 0) {
  const N = 24;
  const top = [];
  const bot = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const [x, y] = bez(t);
    const [dx, dy] = bezDir(t);
    const hw = (width * (0.05 + 0.95 * Math.pow(t, 0.9))) / 2;
    top.push(`${(x - dy * (hw - offset)).toFixed(1)},${(y + dx * (hw - offset)).toFixed(1)}`);
    bot.push(`${(x + dy * (hw + offset)).toFixed(1)},${(y - dx * (hw + offset)).toFixed(1)}`);
  }
  return `M${top.join(' L')} L${bot.reverse().join(' L')} Z`;
}

function trailDots(spec, shape) {
  const out = [];
  const n = 9;
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    const [x, y] = bez(t);
    const col = mix(spec.color, spec.color2, t);
    const r = 1.2 + t * (spec.width * 0.34);
    if (shape === 'ring') {
      out.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="none" stroke="${col}" stroke-width="1.1" opacity="${(0.35 + t * 0.55).toFixed(2)}"/>`);
    } else if (shape === 'square') {
      const s = r * 1.7;
      out.push(`<rect x="${(x - s / 2).toFixed(1)}" y="${(y - s / 2).toFixed(1)}" width="${s.toFixed(1)}" height="${s.toFixed(1)}" ` +
        `fill="${i % 2 ? spec.color : spec.color2}" opacity="${(0.5 + t * 0.5).toFixed(2)}" transform="rotate(${i * 37} ${x.toFixed(1)} ${y.toFixed(1)})"/>`);
    } else if (shape === 'star') {
      out.push(`<path d="${starPath(x, y, r * 1.5, r * 0.5, 4)}" fill="${col}" opacity="${(0.4 + t * 0.6).toFixed(2)}"/>`);
    } else {
      out.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${col}" opacity="${(0.35 + t * 0.6).toFixed(2)}"/>`);
    }
  }
  return out.join('');
}

function trailPreview(item, size) {
  const s = trailSpec(item.id);
  const g = nid('t');
  const head = `<ellipse cx="93" cy="22" rx="9" ry="7.5" fill="#05070d" stroke="${s.color2}" stroke-width="2"/>`;
  const road = `<rect x="4" y="10" width="92" height="82" rx="16" fill="#6b6a66"/>` +
    `<rect x="4" y="10" width="92" height="82" rx="16" fill="#0b1622" opacity="0.28"/>`;
  const grad = `<defs><linearGradient id="${g}" x1="0" y1="1" x2="1" y2="0">` +
    `<stop offset="0%" stop-color="${s.color}" stop-opacity="0.15"/>` +
    `<stop offset="55%" stop-color="${mix(s.color, s.color2, 0.5)}" stop-opacity="0.75"/>` +
    `<stop offset="100%" stop-color="${s.color2}" stop-opacity="1"/>` +
    `</linearGradient></defs>`;

  let body;
  switch (s.style) {
    case 'none':
      body = `<path d="${ribbonPath(7)}" fill="none" stroke="#9fb0c6" stroke-width="1.2" ` +
        `stroke-dasharray="4 5" opacity="0.4"/>` +
        `<line x1="30" y1="34" x2="62" y2="72" stroke="#9fb0c6" stroke-width="2.4" opacity="0.5" stroke-linecap="round"/>` +
        `<circle cx="46" cy="53" r="17" fill="none" stroke="#9fb0c6" stroke-width="2.4" opacity="0.5"/>`;
      break;
    case 'dust':
      body = `<path d="${ribbonPath(s.width)}" fill="url(#${g})" opacity="0.5"/>` +
        trailDots({ ...s, width: s.width * 1.5 }, 'dot');
      break;
    case 'foam':
      body = `<path d="${ribbonPath(s.width)}" fill="url(#${g})" opacity="0.75"/>` + trailDots(s, 'ring');
      break;
    case 'bands':
      body = [0.75, 0, -0.75].map((o, i) =>
        `<path d="${ribbonPath(s.width * 0.42, o * s.width * 0.55)}" fill="${[s.color, mix(s.color, s.color2, 0.5), s.color2][i]}" opacity="0.9"/>`
      ).join('');
      break;
    case 'confetti':
      body = `<path d="${ribbonPath(s.width)}" fill="url(#${g})" opacity="0.35"/>` + trailDots(s, 'square');
      break;
    case 'sparks':
      body = `<path d="${ribbonPath(s.width)}" fill="url(#${g})" opacity="0.7"/>` + trailDots(s, 'star');
      break;
    case 'rainbow':
      body = ['#ff3d8b', '#ff9430', '#ffc93c', '#4dff9e', '#37e6d5'].map((col, i) =>
        `<path d="${ribbonPath(s.width * 0.3, (i - 2) * s.width * 0.36)}" fill="${col}" opacity="0.92"/>`
      ).join('');
      break;
    case 'tube':
      body = `<path d="${ribbonPath(s.width * 1.25)}" fill="${s.color2}" opacity="0.28"/>` +
        `<path d="${ribbonPath(s.width * 0.72)}" fill="${s.color}" opacity="0.95"/>` +
        `<path d="${ribbonPath(s.width * 0.26)}" fill="#fff6d5" opacity="0.9"/>`;
      break;
    case 'void':
      body = `<path d="${ribbonPath(s.width)}" fill="#05010f" opacity="0.95"/>` +
        `<path d="${ribbonPath(s.width, s.width * 0.42)}" fill="${s.color2}" opacity="0.55"/>` +
        trailDots({ ...s, color: '#c58cff', color2: '#ffffff', width: 3 }, 'star');
      break;
    default:
      body = `<path d="${ribbonPath(s.width)}" fill="url(#${g})"/>` + trailDots(s, 'dot');
  }
  return svgWrap(size, grad + road + body + head, 'cos-trail');
}

/* ---- rims: an animated ring --------------------------------------------- */

function rimPreview(item, size) {
  const s = rimSpec(item.id);
  const w = 3.4 * s.thickness;
  const hole = `<ellipse cx="50" cy="52" rx="27" ry="27" fill="#04070d"/>`;
  const road = `<rect x="4" y="10" width="92" height="82" rx="16" fill="#6b6a66"/>` +
    `<rect x="4" y="10" width="92" height="82" rx="16" fill="#0b1622" opacity="0.22"/>`;
  let ring;

  switch (s.style) {
    case 'glow':
      ring = `<circle cx="50" cy="52" r="27" fill="none" stroke="${s.color}" stroke-width="${w}"/>` +
        `<circle cx="50" cy="52" r="31" fill="none" stroke="${s.color}" stroke-width="3" opacity="0.35">` +
        `${anim('opacity', 0.35, 0.08, 2.4)}</circle>` +
        `<circle cx="50" cy="52" r="35" fill="none" stroke="${s.color}" stroke-width="2" opacity="0.18"/>`;
      break;
    case 'dashed':
      ring = `<g>${spin(10)}<circle cx="50" cy="52" r="27" fill="none" stroke="${s.color}" stroke-width="${w}" ` +
        `stroke-dasharray="9 7" stroke-linecap="round"/></g>`;
      break;
    case 'tide':
      ring = `<circle cx="50" cy="52" r="27" fill="none" stroke="${s.color}" stroke-width="${w}" opacity="0.9"/>` +
        [0, 1, 2].map((i) =>
          `<circle cx="50" cy="52" r="${27 + i * 4}" fill="none" stroke="${s.color}" stroke-width="1.6" opacity="${0.4 - i * 0.1}">` +
          `${anim('r', 27 + i * 4, 36 + i * 2, 3 + i * 0.6)}${anim('opacity', 0.4 - i * 0.1, 0, 3 + i * 0.6)}</circle>`
        ).join('');
      break;
    case 'deco':
      ring = `<circle cx="50" cy="52" r="27" fill="none" stroke="${s.color}" stroke-width="${w}"/>` +
        `<g>${spin(24)}${Array.from({ length: 12 }, (_, i) => {
          const a = (i / 12) * Math.PI * 2;
          const x = 50 + Math.cos(a) * 32;
          const y = 52 + Math.sin(a) * 32;
          return `<rect x="${(x - 2.4).toFixed(1)}" y="${(y - 2.4).toFixed(1)}" width="4.8" height="4.8" ` +
            `fill="${s.color}" opacity="0.8" transform="rotate(${(i * 30).toFixed(0)} ${x.toFixed(1)} ${y.toFixed(1)})"/>`;
        }).join('')}</g>`;
      break;
    case 'heat':
      ring = `<circle cx="50" cy="52" r="27" fill="none" stroke="${s.color}" stroke-width="${w}"/>` +
        [30, 33, 36].map((r, i) =>
          `<circle cx="50" cy="52" r="${r}" fill="none" stroke="${mix(s.color, '#ffc93c', i / 3)}" stroke-width="1.5" ` +
          `stroke-dasharray="3 6" opacity="${0.55 - i * 0.14}">${anim('stroke-width', 1.5, 3, 1.6 + i * 0.4)}</circle>`
        ).join('');
      break;
    case 'sparks':
      ring = `<circle cx="50" cy="52" r="27" fill="none" stroke="${s.color}" stroke-width="${w}"/>` +
        `<g>${spin(5)}${Array.from({ length: 8 }, (_, i) => {
          const a = (i / 8) * Math.PI * 2;
          return `<path d="${starPath(50 + Math.cos(a) * 33, 52 + Math.sin(a) * 33, i % 2 ? 4.5 : 3, 1.2, 4)}" ` +
            `fill="${i % 2 ? s.color : '#ffffff'}" opacity="0.9"/>`;
        }).join('')}</g>`;
      break;
    case 'cyclone':
      ring = [[27, 6, 1], [32, 9, -1], [37, 13, 1]].map(([r, dur, dir], i) =>
        `<g>${spin(dur, dir)}<circle cx="50" cy="52" r="${r}" fill="none" ` +
        `stroke="${mix(s.color, '#ffffff', i * 0.25)}" stroke-width="${(w - i * 0.6).toFixed(1)}" ` +
        `stroke-dasharray="${26 - i * 4} ${14 + i * 6}" stroke-linecap="round" opacity="${0.95 - i * 0.2}"/></g>`
      ).join('');
      break;
    case 'prism':
      ring = ['#ff3d8b', '#ffc93c', '#4dff9e', '#37e6d5', '#c58cff'].map((col, i) =>
        `<g>${spin(7 + i * 1.6, i % 2 ? -1 : 1)}<circle cx="50" cy="52" r="${27 + i * 2.2}" fill="none" ` +
        `stroke="${col}" stroke-width="2.6" stroke-dasharray="18 152" stroke-linecap="round" opacity="0.95"/></g>`
      ).join('') + `<circle cx="50" cy="52" r="27" fill="none" stroke="${s.color}" stroke-width="${w * 0.7}" opacity="0.8"/>`;
      break;
    default:
      ring = `<circle cx="50" cy="52" r="27" fill="none" stroke="${s.color}" stroke-width="${w}"/>` +
        `<circle cx="50" cy="52" r="30.5" fill="none" stroke="${s.color}" stroke-width="1.6" opacity="0.4">` +
        `${anim('opacity', 0.4, 0.12, 2.6)}</circle>`;
  }
  return svgWrap(size, road + hole + ring, 'cos-rim');
}

/* ---- nameplates: the actual plate --------------------------------------- */

/** Plate outlines. All 92 x 44 around (4,28) so every shape swaps cleanly. */
function plateShape(shape) {
  const L = 5;
  const R = 95;
  const T = 30;
  const B = 74;
  switch (shape) {
    case 'cut':
      return `M${L + 9} ${T} L${R} ${T} L${R} ${B - 9} L${R - 9} ${B} L${L} ${B} L${L} ${T + 9} Z`;
    case 'banner':
      return `M${L} ${T} L${R} ${T} L${R - 10} ${(T + B) / 2} L${R} ${B} L${L} ${B} L${L + 10} ${(T + B) / 2} Z`;
    case 'notched':
      return `M${L} ${T + 6} L${L + 7} ${T + 6} L${L + 7} ${T} L${R - 7} ${T} L${R - 7} ${T + 6} L${R} ${T + 6} ` +
        `L${R} ${B - 6} L${R - 7} ${B - 6} L${R - 7} ${B} L${L + 7} ${B} L${L + 7} ${B - 6} L${L} ${B - 6} Z`;
    case 'arch':
      return `M${L} ${B} L${L} ${T + 8} Q50 ${T - 8} ${R} ${T + 8} L${R} ${B} Z`;
    case 'tab':
      return `M${L} ${T + 8} Q${L} ${T} ${L + 8} ${T} L${R - 8} ${T} Q${R} ${T} ${R} ${T + 8} ` +
        `L${R} ${B - 8} Q${R} ${B} ${R - 8} ${B} L${L + 26} ${B} L${L + 20} ${B + 8} L${L + 14} ${B} ` +
        `L${L + 8} ${B} Q${L} ${B} ${L} ${B - 8} Z`;
    case 'wave':
      return `M${L} ${T + 6} Q${L} ${T} ${L + 6} ${T} L${R - 6} ${T} Q${R} ${T} ${R} ${T + 6} L${R} ${B - 6} ` +
        `q-12 8 -24 0 t-24 0 t-24 0 t-18 0 Z`;
    default:
      return `M${L + 10} ${T} L${R - 10} ${T} Q${R} ${T} ${R} ${T + 10} L${R} ${B - 10} Q${R} ${B} ${R - 10} ${B} ` +
        `L${L + 10} ${B} Q${L} ${B} ${L} ${B - 10} L${L} ${T + 10} Q${L} ${T} ${L + 10} ${T} Z`;
  }
}

function plateFlourish(kind, edge) {
  switch (kind) {
    case 'bolt':
      return `<path d="M84 36 L78 50 L84 50 L78 66 L90 48 L84 48 L88 36 Z" fill="${edge}" opacity="0.9"/>`;
    case 'laurel':
      return [0, 1, 2].map((i) =>
        `<path d="M${13 + i * 3} ${46 + i * 5} q6 -5 12 -2" fill="none" stroke="${edge}" stroke-width="2" ` +
        `stroke-linecap="round" opacity="${0.9 - i * 0.2}"/>` +
        `<path d="M${87 - i * 3} ${46 + i * 5} q-6 -5 -12 -2" fill="none" stroke="${edge}" stroke-width="2" ` +
        `stroke-linecap="round" opacity="${0.9 - i * 0.2}"/>`
      ).join('');
    case 'sparkle':
      return [[14, 36, 3.4], [88, 40, 2.6], [80, 68, 3]].map(([x, y, r]) =>
        `<path d="${starPath(x, y, r, r * 0.35, 4)}" fill="#fff6d5" opacity="0.95">${anim('opacity', 0.95, 0.35, 2.2)}</path>`
      ).join('');
    default:
      return '';
  }
}

function platePreview(item, size) {
  const p = item.plate || { shape: 'rounded', c1: '#243b5a', c2: '#0e1728', edge: '#9fb0c6', flourish: 'none' };
  const g = nid('p');
  const clip = nid('pc');
  const d = plateShape(p.shape);
  const inner =
    `<defs>` +
      `<linearGradient id="${g}" x1="0" y1="0" x2="0.7" y2="1">` +
        `<stop offset="0%" stop-color="${p.c1}"/>` +
        `<stop offset="100%" stop-color="${p.c2}"/>` +
      `</linearGradient>` +
      `<clipPath id="${clip}"><path d="${d}"/></clipPath>` +
    `</defs>` +
    `<path d="${d}" fill="url(#${g})"/>` +
    // A light top edge, exactly like the glass plates in tokens.css.
    `<g clip-path="url(#${clip})">` +
      `<rect x="0" y="30" width="100" height="3" fill="#ffffff" opacity="0.22"/>` +
    `</g>` +
    `<path d="${d}" fill="none" stroke="${p.edge}" stroke-width="2"/>` +
    // The furniture a real nameplate carries: avatar, name bar, level pill.
    `<circle cx="20" cy="52" r="9" fill="#05070d" stroke="${p.edge}" stroke-width="1.6"/>` +
    `<circle cx="20" cy="52" r="4" fill="${p.edge}" opacity="0.55"/>` +
    `<rect x="34" y="44" width="40" height="6" rx="3" fill="#ffffff" opacity="0.82"/>` +
    `<rect x="34" y="55" width="24" height="4.5" rx="2.2" fill="#ffffff" opacity="0.4"/>` +
    `<rect x="62" y="53" width="16" height="8" rx="4" fill="${p.edge}" opacity="0.85"/>` +
    plateFlourish(p.flourish, p.edge);
  return svgWrap(size, inner, 'cos-plate');
}

/* ---- profile icons: a distinct emblem ----------------------------------- */

function emblem(kind, c1) {
  const S = (d, w = 3.4) => `<path d="${d}" fill="none" stroke="${c1}" stroke-width="${w}" ` +
    `stroke-linecap="round" stroke-linejoin="round"/>`;
  switch (kind) {
    case 'palm':
      return S('M50 74 C48 62 47 55 53 44') +
        S('M53 44 C44 36 33 36 27 43') + S('M53 44 C62 35 74 36 79 44') +
        S('M53 44 C48 33 40 28 32 29') + S('M53 44 C60 33 70 30 76 33') +
        `<circle cx="53" cy="43" r="3" fill="${c1}"/>`;
    case 'shades':
      return `<ellipse cx="36" cy="52" rx="12" ry="9" fill="${c1}"/>` +
        `<ellipse cx="64" cy="52" rx="12" ry="9" fill="${c1}"/>` +
        S('M48 49 q2 -4 4 0', 3) + S('M24 46 L16 42', 3) + S('M76 46 L84 42', 3);
    case 'flamingo':
      return `<ellipse cx="47" cy="62" rx="14" ry="10" fill="${c1}"/>` +
        S('M52 54 C48 40 58 31 66 35 C71 38 70 44 65 45', 4) +
        `<circle cx="67" cy="35" r="4.5" fill="${c1}"/>` +
        `<path d="M71 35 L80 38 L71 40 Z" fill="#ffc93c"/>` +
        S('M43 71 L41 80', 3) + S('M51 71 L53 80', 3);
    case 'wave':
      return S('M20 58 q8 -10 16 0 t16 0 t16 0 t12 0', 4) +
        S('M22 70 q8 -9 16 0 t16 0 t16 0 t10 0', 3) +
        `<circle cx="70" cy="36" r="7" fill="${c1}" opacity="0.85"/>`;
    case 'fan':
      return [0, 1, 2].map((i) =>
        `<path d="M${28 + i * 6} 68 A${22 - i * 6} ${22 - i * 6} 0 0 1 ${72 - i * 6} 68" fill="none" ` +
        `stroke="${c1}" stroke-width="3.4" opacity="${1 - i * 0.22}"/>`
      ).join('') + `<rect x="26" y="68" width="48" height="4" rx="2" fill="${c1}"/>`;
    case 'cafecito':
      return `<path d="M32 44 H66 L62 68 H36 Z" fill="${c1}"/>` +
        S('M66 48 q9 0 9 7 t-10 6', 3) +
        `<rect x="26" y="70" width="48" height="5" rx="2.5" fill="${c1}"/>` +
        S('M44 36 q4 -5 0 -9', 2.6) + S('M54 36 q4 -5 0 -9', 2.6);
    case 'pelican':
      return `<ellipse cx="46" cy="58" rx="18" ry="12" fill="${c1}"/>` +
        S('M58 48 C60 38 70 34 76 38', 4) +
        `<path d="M74 36 L90 44 L72 46 Z" fill="#ffc93c"/>` +
        `<circle cx="70" cy="40" r="1.8" fill="#0b1622"/>` +
        S('M34 66 L30 76', 3) + S('M46 68 L46 78', 3);
    case 'cyclone':
      return `<path d="${spiralPath(50, 52, 3, 26, 2.2)}" fill="none" stroke="${c1}" stroke-width="4" ` +
        `stroke-linecap="round">${spin(7)}</path>`;
    case 'sunset':
      return `<path d="M28 58 a22 22 0 0 1 44 0 Z" fill="${c1}"/>` +
        `<rect x="22" y="63" width="56" height="4" rx="2" fill="${c1}" opacity="0.8"/>` +
        `<rect x="28" y="71" width="44" height="4" rx="2" fill="${c1}" opacity="0.55"/>` +
        `<rect x="36" y="79" width="28" height="3.5" rx="1.8" fill="${c1}" opacity="0.35"/>`;
    case 'crown':
      return `<path d="M26 68 L30 38 L41 51 L50 32 L59 51 L70 38 L74 68 Z" fill="${c1}"/>` +
        `<rect x="26" y="70" width="48" height="7" rx="3" fill="${c1}"/>` +
        `<circle cx="38" cy="62" r="2.6" fill="#ff3d8b"/><circle cx="50" cy="60" r="3" fill="#37e6d5"/>` +
        `<circle cx="62" cy="62" r="2.6" fill="#ff3d8b"/>`;
    case 'skull':
      return `<path d="M50 26 a20 20 0 0 1 20 20 v10 a10 10 0 0 1 -6 9 v7 h-28 v-7 a10 10 0 0 1 -6 -9 v-10 a20 20 0 0 1 20 -20 z" fill="${c1}"/>` +
        `<ellipse cx="42" cy="48" rx="5.5" ry="6.5" fill="#1a0320"/>` +
        `<ellipse cx="58" cy="48" rx="5.5" ry="6.5" fill="#1a0320"/>` +
        `<path d="M50 56 L46 64 h8 Z" fill="#1a0320"/>`;
    case 'star':
      return `<path d="${starPath(50, 52, 26, 11, 6)}" fill="${c1}"/>` +
        `<circle cx="50" cy="52" r="7" fill="#05070d"/>`;
    default: // 'hole'
      return `<ellipse cx="50" cy="56" rx="24" ry="19" fill="#05070d" stroke="${c1}" stroke-width="4"/>` +
        `<ellipse cx="50" cy="56" rx="13" ry="10" fill="none" stroke="${c1}" stroke-width="1.6" opacity="0.5"/>` +
        `<rect x="56" y="30" width="9" height="9" rx="2" fill="${c1}" opacity="0.9" transform="rotate(24 60 34)"/>`;
  }
}

function iconPreview(item, size) {
  const g = nid('i');
  const c1 = item.c1 || '#37e6d5';
  const c2 = item.c2 || '#0b1622';
  const inner =
    `<defs><radialGradient id="${g}" cx="42%" cy="30%" r="80%">` +
      `<stop offset="0%" stop-color="${mix(c2, c1, 0.42)}"/>` +
      `<stop offset="100%" stop-color="${c2}"/>` +
    `</radialGradient></defs>` +
    `<circle cx="50" cy="52" r="40" fill="url(#${g})"/>` +
    `<circle cx="50" cy="52" r="40" fill="none" stroke="${c1}" stroke-width="2.5" opacity="0.85"/>` +
    `<path d="M18 34 a40 40 0 0 1 32 -22" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.3"/>` +
    emblem(item.emblem, c1);
  return svgWrap(size, inner, 'cos-icon');
}

/* ---- emotes: a badge with the glyph ------------------------------------- */

function emotePreview(item, size) {
  const g = nid('e');
  const a = item.accent || '#ffc93c';
  const inner =
    `<defs><radialGradient id="${g}" cx="50%" cy="34%" r="72%">` +
      `<stop offset="0%" stop-color="${mix('#0b1622', a, 0.5)}"/>` +
      `<stop offset="100%" stop-color="#0b1622"/>` +
    `</radialGradient></defs>` +
    `<path d="M14 20 h72 a10 10 0 0 1 10 10 v40 a10 10 0 0 1 -10 10 h-38 l-14 12 v-12 h-20 a10 10 0 0 1 -10 -10 ` +
      `v-40 a10 10 0 0 1 10 -10 z" fill="url(#${g})" stroke="${a}" stroke-width="2.5"/>` +
    `<text x="50" y="50" text-anchor="middle" dominant-baseline="central" font-size="38">${item.glyph || '🙂'}</text>`;
  return svgWrap(size, inner, 'cos-emote');
}

/* ---- fallback ------------------------------------------------------------ */

function unknownPreview(size) {
  return svgWrap(size,
    `<rect x="8" y="8" width="84" height="84" rx="16" fill="#141c2c" stroke="#9fb0c6" stroke-width="2"/>` +
    `<text x="50" y="54" text-anchor="middle" dominant-baseline="central" font-size="30" fill="#9fb0c6">?</text>`,
    'cos-unknown');
}

/**
 * Draw a cosmetic as an inline SVG string.
 * @param {object|string} item catalogue entry or its id
 * @param {number} size px for width/height; the viewBox is always 100x100 so
 *                      CSS can override with width:100% and it still scales.
 */
export function previewSVG(item, size = 96) {
  const it = typeof item === 'string' ? BY_ID.get(item) : item;
  if (!it) return unknownPreview(size);
  switch (it.kind) {
    case 'skin': return skinPreview(it, size);
    case 'trail': return trailPreview(it, size);
    case 'rim': return rimPreview(it, size);
    case 'nameplate': return platePreview(it, size);
    case 'icon': return iconPreview(it, size);
    case 'emote': return emotePreview(it, size);
    default: return unknownPreview(size);
  }
}
