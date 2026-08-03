/**
 * THE PALETTE — owned by the art-direction pass.
 *
 * Bright, sun-drenched Miami. Every colour in the game comes from here so the
 * whole city can be re-graded from one file. See docs/ART_DIRECTION.md §3.
 *
 * Re-exported by src/config.js, so `import { PALETTE } from '../config.js'`
 * keeps working everywhere.
 */

export const PALETTE = {
  /* ---- sky & atmosphere ---- */
  SKY_TOP: 0x2f8fd8,
  SKY_HORIZON: 0xbfe8f7,
  SUN: 0xfff4dc,
  FOG: 0xcfeaf6,

  /* ---- water ---- */
  SEA_DEEP: 0x0a7ea8,
  SEA_SHALLOW: 0x36d2c8,
  SEA_FOAM: 0xeafcff,

  /* ---- ground: keep asphalt WARM, never blue ---- */
  ASPHALT: 0x6b6a66,
  ASPHALT_LIGHT: 0x7c7a74,
  SIDEWALK: 0xd9d3c7,
  SIDEWALK_ALT: 0xe6e0d4,
  CURB: 0xbdb6a8,
  GRASS: 0x63c65a,
  GRASS_DARK: 0x3f9e46,
  SAND: 0xf2e0b8,

  /* ---- architecture ---- */
  GLASS_TEAL: 0x6fd6e8,
  GLASS_BLUE: 0x5aa9e6,
  GLASS_MINT: 0x93e6cf,
  CONCRETE: 0xf0ece2,
  STUCCO_PINK: 0xffc9d4,
  STUCCO_CORAL: 0xff9d84,
  STUCCO_CREAM: 0xfff0d2,
  STUCCO_LILAC: 0xd7c6f2,
  STUCCO_AQUA: 0xa8ecec,
  ROOF: 0xb8bdc7,

  /* ---- nature ---- */
  PALM_TRUNK: 0xb08a5e,
  PALM_FROND: 0x4fbf5f,

  /* ---- the hole ---- */
  HOLE_VOID: 0x0b0a14,
  HOLE_RIM: 0x1a1826,

  /* ---- UI / accents ---- */
  ACCENT_HOT: 0xff4d8d,
  ACCENT_SUN: 0xffc93c,
  ACCENT_AQUA: 0x37e6d5,
};
