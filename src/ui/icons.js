/**
 * THE META LAYER'S ICON SET — hand-drawn inline SVG, one drawing language.
 *
 * WHY THIS FILE EXISTS. The shell was mixing two visual languages: hand-drawn
 * SVG (the coin, the friend card, sixty-odd cosmetic previews) sitting directly
 * beside twenty-plus raw system emoji used as app CHROME — 🌐 👥 🎯 🏆 🛍️ on the
 * lobby tiles, 🎵 🔊 ✨ 📈 🔄 🌀 down the settings list, ⭕ and 🤝 standing in for
 * two whole game modes. Emoji render in a style and a set of colours nobody
 * here chose, they differ on every OS, and half of them read as placeholders
 * ("Last Hole Standing" was a red circle). Emoji is fine inside player-authored
 * content — emotes, the kill feed. It is not fine as the interface.
 *
 * THE RULES, so a new icon lands in the same family:
 *   - 24x24 viewBox, everything drawn inside a 2px margin.
 *   - `currentColor` only. The caller owns the colour, which is what lets one
 *     glyph be aqua on a tile and dim grey in a list.
 *   - Strokes are 1.8, round cap, round join. Solid fills are used for mass,
 *     strokes for structure — the same balance the coin uses.
 *   - No text, no emoji, no gradients that need a unique id (these are printed
 *     many times per page and duplicate <defs> ids would cross-wire).
 *
 * @see src/ui/shell.js icon() — the coin and the friend card live there because
 *      they predate this file and screens import them from the shell contract.
 */

const S = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';

/* Each entry is the INNER markup of a 24x24 icon. */
const PATHS = {
  /* ---- navigation ------------------------------------------------------ */
  globe:
    `<circle cx="12" cy="12" r="9" ${S}/>` +
    `<path d="M3 12h18M12 3c2.6 2.6 2.6 15.4 0 18M12 3c-2.6 2.6-2.6 15.4 0 18" ${S}/>`,
  friends:
    `<circle cx="9" cy="8.5" r="3.2" ${S}/>` +
    `<path d="M3.2 19.2c.6-3.1 3-4.8 5.8-4.8s5.2 1.7 5.8 4.8" ${S}/>` +
    `<path d="M16.2 6.2a3 3 0 0 1 0 5.9" ${S}/>` +
    `<path d="M17.4 14.7c2.1.5 3.3 2 3.6 4.1" ${S}/>`,
  target:
    `<circle cx="12" cy="12" r="8.6" ${S}/>` +
    `<circle cx="12" cy="12" r="4.7" ${S}/>` +
    `<circle cx="12" cy="12" r="1.6" fill="currentColor"/>`,
  trophy:
    `<path d="M8 4h8v4.4a4 4 0 0 1-8 0Z" ${S}/>` +
    `<path d="M8 5.4H5.2v1.4A3.2 3.2 0 0 0 8.4 10" ${S}/>` +
    `<path d="M16 5.4h2.8v1.4A3.2 3.2 0 0 1 15.6 10" ${S}/>` +
    `<path d="M12 12.4V16" ${S}/>` +
    `<path d="M8.4 20h7.2l-.8-2.6H9.2Z" ${S}/>`,
  store:
    `<path d="M4.4 8.4h15.2l-1.1 10.2a2 2 0 0 1-2 1.8H7.5a2 2 0 0 1-2-1.8Z" ${S}/>` +
    `<path d="M8.8 10.4V7.2a3.2 3.2 0 0 1 6.4 0v3.2" ${S}/>`,
  badge:
    `<rect x="3.2" y="4.6" width="17.6" height="14.8" rx="2.8" ${S}/>` +
    `<circle cx="9" cy="10.6" r="2.4" ${S}/>` +
    `<path d="M5.6 16.4c.5-2 1.8-3 3.4-3s2.9 1 3.4 3" ${S}/>` +
    `<path d="M14.8 9.8h3.6M14.8 13h3.6" ${S}/>`,
  gear:
    `<circle cx="12" cy="12" r="3.1" ${S}/>` +
    `<path d="M12 2.6l1.1 2.2 2.4-.5.4 2.4 2.3.9-1.2 2.1 1.6 1.9-1.9 1.5.5 2.4-2.4.3-1 2.2-2.1-1.2-2.1 1.2-1-2.2-2.4-.3.5-2.4-1.9-1.5 1.6-1.9L5.1 7.6l2.3-.9.4-2.4 2.4.5Z" ${S}/>`,

  /* ---- game modes ------------------------------------------------------ */
  hole:
    `<ellipse cx="12" cy="13.4" rx="8.4" ry="6" fill="currentColor" opacity=".18"/>` +
    `<ellipse cx="12" cy="13.4" rx="8.4" ry="6" ${S}/>` +
    `<ellipse cx="12" cy="13.4" rx="4.2" ry="2.9" fill="currentColor"/>` +
    `<path d="M6.2 8.6 7.6 5.4M17.8 8.6 16.4 5.4" ${S}/>`,
  car:
    `<path d="M3.4 15.2v-2l1.9-4.1A2 2 0 0 1 7.1 8h9.8a2 2 0 0 1 1.8 1.1l1.9 4.1v2" ${S}/>` +
    `<path d="M3.4 15.2h17.2v2.4H3.4Z" ${S}/>` +
    `<circle cx="7.4" cy="17.8" r="1.7" ${S}/>` +
    `<circle cx="16.6" cy="17.8" r="1.7" ${S}/>` +
    `<path d="M6.6 13h10.8" ${S}/>`,
  pedestrian:
    `<circle cx="12" cy="4.8" r="2.1" ${S}/>` +
    `<path d="M12 7.4v6M12 9.6 8.6 12M12 9.6l3.4 2.4M12 13.4l-2.6 6M12 13.4l2.6 6" ${S}/>`,
  skyline:
    `<path d="M3.4 20.4V10l4.3-2.6V20.4" ${S}/>` +
    `<path d="M7.7 20.4V4.6l5.3-1.9v17.7" ${S}/>` +
    `<path d="M13 20.4V9.4l7.6 2.6v8.4" ${S}/>` +
    `<path d="M2.4 20.4h19.2" ${S}/>` +
    `<path d="M9.8 8.4h1.2M9.8 12h1.2M9.8 15.6h1.2M15.8 14.4h1.2M15.8 17.6h1.2" ${S}/>`,
  ring:
    `<circle cx="12" cy="12" r="8.8" ${S} stroke-dasharray="3.4 2.6"/>` +
    `<circle cx="12" cy="12" r="4.2" fill="currentColor" opacity=".22"/>` +
    `<circle cx="12" cy="12" r="4.2" ${S}/>`,
  teams:
    `<circle cx="7.6" cy="9" r="2.7" ${S}/>` +
    `<circle cx="16.4" cy="9" r="2.7" ${S}/>` +
    `<path d="M2.8 19.6c.4-2.9 2.3-4.6 4.8-4.6s4.4 1.7 4.8 4.6" ${S}/>` +
    `<path d="M12.4 19.6c.4-2.9 1.9-4.6 4-4.6s3.7 1.7 4.1 4.6" ${S} opacity=".55"/>`,
  palm:
    `<path d="M12.6 20.4c-.6-4 -.9-6.6 .6-9.4" ${S}/>` +
    `<path d="M13.2 11c-2.7-2.6-6-2.5-7.8-.3" ${S}/>` +
    `<path d="M13.2 11c2.7-2.8 6.1-2.5 7.6-.2" ${S}/>` +
    `<path d="M13.2 11c-1.5-3.3-4-4.7-6.4-4.4" ${S}/>` +
    `<path d="M13.2 11c2-3.3 5-4.2 7-3.3" ${S}/>` +
    `<circle cx="13.2" cy="10.6" r="1.1" fill="currentColor"/>`,
  traffic:
    `<rect x="7.6" y="2.6" width="8.8" height="18.8" rx="3" ${S}/>` +
    `<circle cx="12" cy="7.4" r="1.9" fill="currentColor"/>` +
    `<circle cx="12" cy="12" r="1.9" fill="currentColor" opacity=".45"/>` +
    `<circle cx="12" cy="16.6" r="1.9" fill="currentColor" opacity=".2"/>`,

  /* ---- settings -------------------------------------------------------- */
  music:
    `<path d="M9.4 17.4V5.6l9-1.8v11.6" ${S}/>` +
    `<circle cx="7" cy="17.6" r="2.6" ${S}/>` +
    `<circle cx="16" cy="15.6" r="2.6" ${S}/>`,
  speaker:
    `<path d="M4 9.4h3.2L12 5.4v13.2L7.2 14.6H4Z" ${S}/>` +
    `<path d="M15.4 9.4a4 4 0 0 1 0 5.2" ${S}/>` +
    `<path d="M18 7a7.4 7.4 0 0 1 0 10" ${S}/>`,
  sparkle:
    `<path d="M12 3.2 13.9 9l5.9 1.9-5.9 1.9L12 18.6l-1.9-5.8L4.2 10.9 10.1 9Z" ${S}/>` +
    `<path d="M18.6 3.4l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7Z" fill="currentColor"/>`,
  gauge:
    `<path d="M3.6 18.4a8.9 8.9 0 1 1 16.8 0" ${S}/>` +
    `<path d="M12 18.4 16.4 10" ${S}/>` +
    `<circle cx="12" cy="18.4" r="1.5" fill="currentColor"/>`,
  invert:
    `<path d="M8.4 4.6 5.2 7.8l3.2 3.2" ${S}/>` +
    `<path d="M5.2 7.8h9.4a4.4 4.4 0 0 1 4.4 4.4" ${S}/>` +
    `<path d="M15.6 19.4l3.2-3.2-3.2-3.2" ${S}/>` +
    `<path d="M18.8 16.2H9.4A4.4 4.4 0 0 1 5 11.8" ${S}/>`,
  motion:
    `<path d="M3.6 12h4l2.2-5.4 3.6 11.4 2.2-6h4.8" ${S}/>`,

  /* ---- rewards & progression ------------------------------------------- */
  flame:
    `<path d="M12 21c3.6 0 6-2.4 6-5.6 0-3.9-3.4-5.6-3.4-9.4-2 .9-3 2.6-3 4.4-1.1-.6-1.7-1.7-1.8-3C7.7 8.7 6 11.4 6 15.4 6 18.6 8.4 21 12 21Z" ${S}/>` +
    `<path d="M12 21c1.7 0 2.8-1.2 2.8-2.7 0-1.9-1.9-2.6-1.9-4.5-1.9 1.1-3.7 2.4-3.7 4.5C9.2 19.8 10.3 21 12 21Z" fill="currentColor" opacity=".45"/>`,
  hourglass:
    `<path d="M6.6 3h10.8M6.6 21h10.8" ${S}/>` +
    `<path d="M7.8 3v3.4L12 11l4.2-4.6V3" ${S}/>` +
    `<path d="M7.8 21v-3.4L12 13l4.2 4.6V21" ${S}/>`,
  star:
    `<path d="M12 3.4 14.6 9l6.1.8-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.8 9.4 9Z" ${S}/>`,
  gift:
    `<path d="M3.8 10.6h16.4v3H3.8Z" ${S}/>` +
    `<path d="M5.4 13.6h13.2v6.8H5.4Z" ${S}/>` +
    `<path d="M12 10.6v9.8" ${S}/>` +
    `<path d="M12 10.6C10.4 8 8.9 6.6 7.5 6.6a2 2 0 0 0 0 4Z" ${S}/>` +
    `<path d="M12 10.6c1.6-2.6 3.1-4 4.5-4a2 2 0 0 1 0 4Z" ${S}/>`,
  crown:
    `<path d="M3.6 8.2l3.2 3.6L12 5l5.2 6.8 3.2-3.6-1.6 10H5.2Z" ${S}/>` +
    `<path d="M5.2 21h13.6" ${S}/>`,
  bolt:
    `<path d="M13.4 2.6 6.2 13.4h4.8l-1.2 8 7.4-11h-5Z" ${S}/>`,
  check:
    `<path d="M4.6 12.6 9.6 17.6 19.4 6.8" ${S} stroke-width="2.4"/>`,
  lock:
    `<rect x="4.8" y="10.4" width="14.4" height="10" rx="2.6" ${S}/>` +
    `<path d="M8.4 10.4V7.8a3.6 3.6 0 0 1 7.2 0v2.6" ${S}/>` +
    `<circle cx="12" cy="15.4" r="1.5" fill="currentColor"/>`,
  clock:
    `<circle cx="12" cy="12" r="8.8" ${S}/>` +
    `<path d="M12 6.6V12l3.6 2.2" ${S}/>`,
  ruler:
    `<rect x="2.6" y="8.4" width="18.8" height="7.2" rx="1.8" ${S}/>` +
    `<path d="M7 8.4v3M11 8.4v4.4M15 8.4v3M19 8.4v4.4" ${S}/>`,
  fangs:
    `<path d="M3.6 6.6h16.8v4a8.4 8.4 0 0 1-8.4 8.4 8.4 8.4 0 0 1-8.4-8.4Z" ${S}/>` +
    `<path d="M8 10.6 9.6 15l1.6-4.4M12.8 10.6 14.4 15l1.6-4.4" ${S}/>`,
  trash:
    `<path d="M4.6 6.6h14.8" ${S}/>` +
    `<path d="M9.4 6.6V4.4h5.2v2.2" ${S}/>` +
    `<path d="M6.4 6.6l1 13.2h9.2l1-13.2" ${S}/>` +
    `<path d="M10.2 10.2v6M13.8 10.2v6" ${S}/>`,

  /* ---- empty-state art (drawn larger, still 24x24) --------------------- */
  'empty-hole':
    `<ellipse cx="12" cy="14.6" rx="9" ry="5.4" fill="currentColor" opacity=".14"/>` +
    `<ellipse cx="12" cy="14.6" rx="9" ry="5.4" ${S} stroke-dasharray="2.6 2.4"/>` +
    `<ellipse cx="12" cy="14.6" rx="4.4" ry="2.6" fill="currentColor" opacity=".5"/>` +
    `<path d="M12 3.4v4.2M8.6 4.6l1.5 3M15.4 4.6l-1.5 3" ${S}/>`,
  radar:
    `<circle cx="12" cy="12" r="9" ${S} opacity=".45"/>` +
    `<circle cx="12" cy="12" r="5.4" ${S} opacity=".7"/>` +
    `<circle cx="12" cy="12" r="1.7" fill="currentColor"/>` +
    `<path d="M12 12 19.2 7.2" ${S}/>`,
  'empty-board':
    `<path d="M4.4 20.4V12h4.2v8.4Z" ${S}/>` +
    `<path d="M9.9 20.4V7.4h4.2v13Z" ${S} stroke-dasharray="2.6 2.2"/>` +
    `<path d="M15.4 20.4v-6.2h4.2v6.2Z" ${S}/>` +
    `<path d="M2.8 20.4h18.4" ${S}/>`,
};

/**
 * One icon, as an inline SVG string.
 *
 * @param {string} name  key from PATHS; an unknown name draws nothing rather
 *                       than a "?" box — a missing glyph must never become a
 *                       visible defect in a shipped screen.
 * @param {string|null} size any CSS length, or null to let a class size it.
 * @param {string} cls   extra class, for screens that size or colour in CSS.
 */
export function ic(name, size = '1em', cls = '') {
  const body = PATHS[name];
  if (!body) return '';
  const dim = size ? ` width="${size}" height="${size}"` : '';
  return `<svg class="md-ico ic-${name} ${cls}"${dim} viewBox="0 0 24 24" ` +
    `aria-hidden="true" focusable="false">${body}</svg>`;
}

/** True when `name` is drawable. Lets a caller fall back deliberately. */
export function hasIcon(name) { return Object.prototype.hasOwnProperty.call(PATHS, name); }

/**
 * Mode id -> icon name. Kept here rather than in gameplay/modes.js: that module
 * is the game's data contract and is shared with the match, which has no
 * business knowing what the meta layer draws.
 */
export const MODE_ICON = {
  classic: 'hole',
  'car-crunch': 'car',
  'crowd-control': 'pedestrian',
  'building-rush': 'skyline',
  'last-hole': 'ring',
  'team-devour': 'teams',
  'neon-nights': 'palm',
  'rush-hour': 'traffic',
};

/** Daily-challenge track -> icon name, mirroring progression.js TRACKS. */
export const TRACK_ICON = {
  devour: 'hole',
  score: 'star',
  vehicles: 'car',
  people: 'pedestrian',
  buildings: 'skyline',
  wins: 'trophy',
  rivals: 'fangs',
  survive: 'clock',
  bigHole: 'ruler',
};

/** Draw a mode's icon, falling back to the generic hole for an unknown id. */
export function modeIcon(id, size = '1em', cls = '') {
  return ic(MODE_ICON[id] || 'hole', size, cls);
}

export default ic;
