/**
 * MAPS.
 *
 * A map is a seed plus a biome. The city generator is fully deterministic from
 * its seed, so a different seed is already a different city — different street
 * grid, different blocks, different skyline — for free. The biome is what makes
 * it a different PLACE: palette, ground treatment, sky, and a post-build pass.
 *
 * This is deliberately not a map-production system. It is the smallest thing
 * that gets a second playable city into the build, using the generator, the
 * traffic, the crowds, the props and the physics that already exist.
 *
 * SWITCHING A MAP RELOADS THE PAGE. The world is built once, synchronously, at
 * boot, and every Consumable id in a multiplayer room is derived from that
 * build — swapping it in place would desynchronise every client in the room and
 * leave the physics holding references into a scene that no longer exists.
 */

export const MAPS = [
  {
    id: 'miami',
    name: 'Miami',
    blurb: 'Brickell and Downtown. Sun, glass, palms and traffic.',
    icon: '🌴',
    accent: '#ff3d8b',
    seed: 20260803,
    biome: 'tropical',
    timeOfDay: null,        // whatever the clock says
  },
  {
    id: 'snowfall',
    name: 'Snowfall City',
    blurb: 'A snowbound old town. Plowed roads, warm windows, cold light.',
    icon: '❄️',
    accent: '#9fd4ff',
    seed: 77120451,
    biome: 'snow',
    /** Overcast winter midday. 0.72 was dusk, and the engine's own low-sun
     *  exposure boost stacked with the grade below and blew the city out. */
    timeOfDay: 0.32,
    /**
     * The winter look. This is what actually makes the map read as snowbound —
     * the city's colour lives in its VERTEX data, not in its materials, so no
     * amount of material retinting reaches it. A grade reaches all of it at
     * once: pull the saturation down, push the temperature cold, and split-tone
     * the shadows blue against warm highlights so lit windows still glow.
     */
    grade: {
      saturation: 0.55,
      temperature: -0.32,
      // BELOW 1. Snow is bright by itself and the ground is now near-white;
      // multiplying exposure on top of that clipped the whole frame to paper.
      exposure: 0.82,
      contrast: 1.06,
      shadowTint: [0.62, 0.74, 0.95],
      highlightTint: [1.0, 0.97, 0.92],
    },
    test: true,
  },
];

const KEY = 'miami-devour:map';

export function getMap(id) {
  return MAPS.find((m) => m.id === id) || MAPS[0];
}

/** The map this page load is building. URL wins, then the saved choice. */
export function activeMap() {
  let id = '';
  try {
    id = new URLSearchParams(location.search).get('map') || '';
    if (!id) id = localStorage.getItem(KEY) || '';
  } catch { /* private mode or non-browser */ }
  return getMap(id);
}

/**
 * Choose a map and reload into it. Returns nothing — the page goes away.
 * Any ?room= is preserved: a room's seed still comes from the server, but the
 * biome is a client-side choice and switching it must not drop you out.
 */
export function selectMap(id) {
  const m = getMap(id);
  try { localStorage.setItem(KEY, m.id); } catch { /* ignore */ }
  const q = new URLSearchParams(location.search);
  q.set('map', m.id);
  location.href = `${location.origin}${location.pathname}?${q.toString()}`;
}
