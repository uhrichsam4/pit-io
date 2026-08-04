/**
 * THE PALETTE — owned by the art-direction pass.
 *
 * Bright, sun-drenched Miami. Every colour in the game comes from here so the
 * whole city can be re-graded from one file. See docs/ART_DIRECTION.md §3.
 *
 * Re-exported by src/config.js, so `import { PALETTE } from '../config.js'`
 * keeps working everywhere.
 *
 * ---------------------------------------------------------------------------
 * WHY SO MANY WARM VALUES
 * ---------------------------------------------------------------------------
 * The lighting rig is a warm key sun *plus* a strong cyan hemisphere fill
 * (0xbfe8ff @ 0.55), a cyan bounce light and a sky-dominated IBL. Summed over
 * an up-facing surface the illuminant lands around r:b = 0.90 — i.e. every
 * neutral albedo renders BLUER than it was authored. Navy asphalt is the #1
 * listed automatic-failure in the art bible, and that is exactly how it
 * happens.
 *
 * So the ground and masonry albedos below are deliberately authored WARM
 * (r:b roughly 1.15–1.30). They look slightly ochre as swatches and land
 * neutral-warm on screen. Do not "correct" them back to grey.
 *
 * NAMING: everything is a plain 0xRRGGBB sRGB integer, so it can be handed
 * straight to THREE.Color, to `material.color.setHex`, or to the canvas
 * texture generators in src/core/materials.js.
 */

export const PALETTE = {
  /* ======================================================================
   * SKY & ATMOSPHERE
   * Late-afternoon, high sun, bright hazy horizon. Never grey.
   * ==================================================================== */
  SKY_TOP: 0x2f86cf,        // zenith
  SKY_MID: 0x74c1e8,        // mid dome
  SKY_HORIZON: 0xd6ebf2,    // bright hazy horizon band
  SKY_HAZE: 0xffe6c8,       // warm dust sitting right on the horizon line
  SUN: 0xfff6e2,            // sun disc / key-light tint
  SUN_DEEP: 0xffd9a0,       // sun low-angle glow, lens flare core
  FOG: 0xdfe9e3,            // distance haze — matches the horizon, faintly warm
  CLOUD: 0xfffaf0,          // lit cumulus top
  CLOUD_SHADE: 0xc9d4de,    // cumulus underside

  /* Suggested light-rig tints (engine/lighting owns the intensities). */
  LIGHT_KEY: 0xfff2d8,      // directional sun
  LIGHT_SKY: 0xbfe4ff,      // hemisphere up
  LIGHT_BOUNCE: 0xb8a682,   // hemisphere down — warm ground bounce, NOT grey
  LIGHT_FILL: 0xa8d0ff,     // cool rim/fill from the opposite side

  /* ======================================================================
   * THE CYCLE — reflected environment + after dark
   *
   * These are what the IBL is PAINTED with, not what the sky dome renders:
   * src/core/materials.js bakes one PMREM per stop and swaps between them on
   * `scene.userData.nightFactor`. The engine owns the dome and the analytic
   * rig; this set only has to make reflections believable at each hour.
   *
   * The horizon rows matter far more than the zenith rows. From the game's
   * high 3/4 camera the mirror direction off a vertical facade points at the
   * horizon and below, so a tower reflects THESE colours, not the sky.
   * ==================================================================== */
  /* Golden hour — the whole dome goes amber and the sun sits on the deck. */
  ENV_GOLD_TOP: 0x3f86c0,
  ENV_GOLD_MID: 0x8fb8d8,
  ENV_GOLD_HOR: 0xffd0a0,
  ENV_GOLD_HAZE: 0xffbe86,
  ENV_GOLD_GND: 0xe6c9a0,
  ENV_GOLD_GND_LO: 0xa9866a,
  ENV_GOLD_CLOUD: 0xfff0dc,
  ENV_GOLD_CLOUD_SHADE: 0xc8a8a4,
  ENV_GOLD_SUN: 0xffb066,

  /* Dusk — sun gone, afterglow along the horizon, the city switching on. */
  ENV_DUSK_TOP: 0x22355e,
  ENV_DUSK_MID: 0x4a5f8c,
  ENV_DUSK_HOR: 0xb08098,
  ENV_DUSK_HAZE: 0xd08a72,
  ENV_DUSK_GND: 0x6a6274,
  ENV_DUSK_GND_LO: 0x4a465a,
  ENV_DUSK_CLOUD: 0xc7a8b4,
  ENV_DUSK_CLOUD_SHADE: 0x6a6a90,
  ENV_DUSK_SUN: 0xff8a52,

  /* Night — deep blue dome, sodium horizon. Never black: this is an arcade
     game and the playfield has to stay readable (see quality.js TOD_STOPS). */
  ENV_NIGHT_TOP: 0x0b1430,
  ENV_NIGHT_MID: 0x16244a,
  ENV_NIGHT_HOR: 0x33406a,
  ENV_NIGHT_HAZE: 0x5a5470,
  ENV_NIGHT_GND: 0x3a3a4e,
  ENV_NIGHT_GND_LO: 0x24263a,
  ENV_NIGHT_CLOUD: 0x6a7098,
  ENV_NIGHT_CLOUD_SHADE: 0x353a5c,
  MOON: 0xa8c0ff,

  /* The sodium wash a lit city throws onto its own horizon. This single
     colour is what every glass facade in the game reflects after dark. */
  CITY_GLOW: 0xffab5e,

  /* Lit interiors, for the emissive window masks. Offices run cool-white and
     even; homes run warm and patchy; shopfronts are warmest and brightest. */
  WINDOW_OFFICE: 0xffecba,
  WINDOW_HOME: 0xffce8c,
  WINDOW_SHOP: 0xffecc4,
  SODIUM: 0xffb46a,         // street lamp pool at night

  /* ======================================================================
   * WATER — Biscayne Bay, not the North Atlantic
   * ==================================================================== */
  SEA_DEEP: 0x0b7fa6,
  SEA_MID: 0x14a8bd,
  SEA_SHALLOW: 0x3fd8c9,
  SEA_FOAM: 0xf0ffff,
  WATER_RIVER: 0x2296a8,    // Miami River — siltier, greener than the bay
  WATER_POOL: 0x54d9e8,     // rooftop / hotel pools
  WATER_WAKE: 0xdff9ff,
  SEAWALL: 0xc0b6a2,

  /* ======================================================================
   * GROUND — asphalt must be a WARM mid-grey. Never blue. Ever.
   * ==================================================================== */
  // r:b 1.12. Warm GREY, not brown: the key light is already warm (0xfff2da,
  // r:b 1.18) and the grade tints highlights warmer still, so a road authored
  // much past 1.15 renders as packed dirt. Authored below 1.0 renders as navy.
  //
  // MEASURED, and darker than it reads as a swatch. At 0x7b7770 the rendered
  // carriageway landed at ~0.63 screen luminance against a ~0.70 sidewalk: the
  // two surfaces were four percent apart and the whole frame read as one
  // continuous warm plane with markings floating on it — rubric category 1
  // (first-glance readability) failing outright. The road has to be the DARK
  // element the pale paving and the pastel facades sit against. Everything that
  // lightens the wearing course (tyre polish, the macro band, the sun-bleach
  // tint) was pulled back in step, so this is a real value change, not a
  // brightness swap.
  ASPHALT: 0x6c6860,
  ASPHALT_LIGHT: 0x857f74,  // sun-bleached lanes, older wearing course
  ASPHALT_DARK: 0x54504a,   // fresh overlay, shadowed lanes
  ASPHALT_PATCH: 0x5f5950,  // rectangular utility-cut repairs
  TAR_SEAM: 0x413b34,       // crack sealant — warm near-black, glossy
  OIL_STAIN: 0x4a443c,

  ROAD_LINE: 0xf2ecdc,      // lane paint — warm off-white, never pure white
  ROAD_LINE_YELLOW: 0xf3c548,
  CROSSWALK: 0xeee7d4,
  ROAD_LINE_WORN: 0xcfc7b4,

  SIDEWALK: 0xcfc5b0,       // warm bone paving, luminance ~0.78 (bible: < 0.85)
  SIDEWALK_ALT: 0xdad0ba,   // alternating slab tone
  SIDEWALK_JOINT: 0xa2977f, // recessed slab joint
  CURB: 0xc4b9a2,
  CURB_PAINT: 0xf0d78a,     // painted loading-zone kerb
  PLAZA: 0xd6cbb2,
  PLAZA_ALT: 0xc6b99e,
  BRICK_PAVER: 0xc4805e,
  GRAVEL: 0x9a9081,
  DIRT: 0x9c7f5e,
  SAND: 0xecd9ac,
  SAND_WET: 0xc9b184,

  /* ======================================================================
   * FOLIAGE — cheerful, saturated, tropical
   * ==================================================================== */
  // Greens are authored one notch DOWN in saturation from what looks right as
  // a swatch: the key light is 3.5x, the grade adds 12% saturation, and an
  // already-saturated green blows straight past the tone curve into acid lime.
  GRASS: 0x5faa55,
  GRASS_DARK: 0x3d7f3e,
  GRASS_LIGHT: 0x84c268,
  GRASS_DRY: 0xa9ae60,
  // Where the turf has actually been walked off: desire paths across a lawn,
  // the bald ring under a tree, the strip beside a bench. Read by the
  // world-space breakup in materials.js, which is why it is a WORN colour and
  // not a soil colour — you are still seeing thin grass over dust, not bare
  // earth. Bare earth is DIRT below.
  GRASS_WORN: 0x9c8f61,
  HEDGE: 0x489344,
  HEDGE_LIGHT: 0x67b158,
  MULCH: 0x6f5340,

  PALM_TRUNK: 0xa8865e,
  PALM_TRUNK_DARK: 0x7d6242,
  PALM_FROND: 0x4da457,
  PALM_FROND_DARK: 0x2d7742,
  PALM_FROND_LIGHT: 0x82c465,
  TREE_CANOPY: 0x53a153,
  TREE_CANOPY_DARK: 0x336f3d,
  TREE_CANOPY_LIGHT: 0x81be69,

  FLOWER_PINK: 0xff6fae,
  FLOWER_MAGENTA: 0xd94fc0,
  FLOWER_YELLOW: 0xffd24a,
  FLOWER_WHITE: 0xfff3e2,
  FLOWER_ORANGE: 0xff9a3d,

  /* ======================================================================
   * ARCHITECTURE — glass
   * ==================================================================== */
  GLASS_TEAL: 0x6fd6e8,
  GLASS_BLUE: 0x5aa9e6,
  GLASS_MINT: 0x93e6cf,
  GLASS_AQUA: 0x7fe0d0,
  GLASS_SKY: 0x9fd8f0,
  GLASS_SMOKE: 0x8fa6b0,
  GLASS_BRONZE: 0xd8b98c,
  GLASS_LIT: 0xffe6b0,      // an office with the lights on
  MULLION: 0xeef1ee,        // anodised aluminium frame — warm white
  MULLION_DARK: 0x5d6265,
  SPANDREL: 0x40606b,       // opaque panel between floors

  /* ======================================================================
   * ARCHITECTURE — masonry, render, concrete. Miami Deco pastels.
   * ==================================================================== */
  CONCRETE: 0xe8dfcd,       // pulled down from pure white so it cannot clip
  CONCRETE_WARM: 0xeee2c9,
  CONCRETE_DARK: 0xc0b6a0,
  PRECAST: 0xded3bd,

  STUCCO_PINK: 0xffc5d2,
  STUCCO_CORAL: 0xff9c80,
  STUCCO_CREAM: 0xffeecb,
  STUCCO_LILAC: 0xd6c4f0,
  STUCCO_AQUA: 0xa6ebe8,
  STUCCO_MINT: 0xb6ecc9,
  STUCCO_PEACH: 0xffd2a6,
  STUCCO_SAND: 0xecd9b4,
  STUCCO_WHITE: 0xf6eedf,
  STUCCO_SKY: 0xbfe4ff,
  STUCCO_BUTTER: 0xffe08a,

  BRICK: 0xb96a4f,
  BRICK_LIGHT: 0xd08b66,
  BRICK_DARK: 0x8e4c38,
  MORTAR: 0xd8cdb8,
  TERRACOTTA: 0xd2724a,

  /* ======================================================================
   * ROOFS — visible almost all the time from the 3/4 camera
   * ==================================================================== */
  ROOF: 0xb5aa96,           // was blue-grey; roofs are warm, they bake all day
  ROOF_DARK: 0x8b8172,
  ROOF_GRAVEL: 0xa79b86,
  ROOF_TAR: 0x6e675d,
  ROOF_MEMBRANE: 0xcdc4b2,
  PARAPET: 0xd2c8b4,
  AC_METAL: 0xc0c3bc,
  VENT_METAL: 0xa9aca4,
  WATER_TANK: 0x9b7a5a,
  HELIPAD: 0x53504a,
  HELIPAD_MARK: 0xf3ecda,

  /* ======================================================================
   * METALS
   * ==================================================================== */
  STEEL: 0xb7bdbb,
  STEEL_DARK: 0x6f7878,
  CHROME: 0xdfe4e2,
  ALUMINIUM: 0xc7ccc8,
  RUST: 0xa5613a,
  PATINA: 0x66b8a0,
  CRANE_YELLOW: 0xf5b323,
  SCAFFOLD: 0xbfa87c,

  /* ======================================================================
   * TIMBER
   * ==================================================================== */
  WOOD_DECK: 0xc79a68,
  WOOD_LIGHT: 0xe0bd8e,
  WOOD_DARK: 0x8a6440,
  DOCK_PILING: 0x8f7351,
  TEAK: 0xb07a44,

  /* ======================================================================
   * VEHICLES
   * ==================================================================== */
  CAR_WHITE: 0xf2efe4,
  CAR_SILVER: 0xc7cbcb,
  CAR_GRAPHITE: 0x4b5157,
  CAR_BLACK: 0x25272b,
  CAR_RED: 0xe8443f,
  CAR_CORAL: 0xff7a5e,
  CAR_ORANGE: 0xff9430,
  CAR_YELLOW: 0xffc93c,
  CAR_LIME: 0x9ada4a,
  CAR_GREEN: 0x4fbc63,
  CAR_TEAL: 0x2fb8c0,
  CAR_MINT: 0x8fe0c0,
  CAR_BLUE: 0x3a86d8,
  CAR_NAVY: 0x2a4d80,
  CAR_PURPLE: 0x9a72e0,
  CAR_PINK: 0xff7ab0,
  TAXI_YELLOW: 0xffbe1a,
  BUS_BLUE: 0x2f9fd8,
  BUS_WHITE: 0xf4f0e6,
  TRUCK_WHITE: 0xeeeae0,
  POLICE_BLUE: 0x1f4f8f,
  TYRE: 0x2a2a2e,
  CAR_GLASS: 0x8ec2d4,
  CAR_TRIM: 0xd6dad8,
  HEADLIGHT: 0xfff6da,
  TAILLIGHT: 0xff3a2a,
  INDICATOR: 0xffa62e,

  /* Boats */
  HULL_WHITE: 0xf4f1e6,
  HULL_NAVY: 0x1f4e7a,
  HULL_TEAL: 0x18808c,
  DECK_TEAK: 0xc99a5e,
  SAIL: 0xfaf6ec,

  /* ======================================================================
   * STREET PROPS
   * ==================================================================== */
  CONE_ORANGE: 0xff6a1e,
  CONE_STRIPE: 0xf5f0e4,
  BARRIER_ORANGE: 0xff7a2a,
  BARRIER_WHITE: 0xf2ecdc,
  HYDRANT_RED: 0xe83c30,
  HYDRANT_YELLOW: 0xffc42e,
  BIN_GREEN: 0x3f8f5a,
  BIN_BLUE: 0x2f7fc0,
  BIN_GREY: 0x7d7a72,
  BENCH_WOOD: 0xc08a52,
  BENCH_METAL: 0x3c4a4e,
  PLANTER: 0xd8c8ae,
  PLANTER_DARK: 0xa8967a,
  BOLLARD: 0xd6cfbf,
  BOLLARD_DARK: 0x4a5250,
  SIGN_POLE: 0x8e948f,
  SIGN_FACE: 0xf4efe2,
  SIGN_GREEN: 0x2f7d55,
  SIGN_BLUE: 0x2a5f9e,
  TRAFFIC_BODY: 0x33403c,
  LIGHT_RED: 0xff3a2e,
  LIGHT_AMBER: 0xffb023,
  LIGHT_GREEN: 0x35d96a,
  PARKING_METER: 0x5c6a6a,
  MAILBOX: 0x2f6fb0,
  NEWSSTAND: 0xd8563f,
  LAMP_POST: 0xa8aa9e,
  LAMP_GLOW: 0xffe9b0,
  TABLE_TOP: 0xf0e7d4,
  CHAIR: 0xe0d5bd,

  /* Fabric — awnings, parasols, market stalls. Deliberately punchy. */
  FABRIC_CORAL: 0xff7a72,
  FABRIC_AQUA: 0x3ecfb2,
  FABRIC_SUN: 0xffc93c,
  FABRIC_SKY: 0x6aa9ff,
  FABRIC_PINK: 0xff85b8,
  FABRIC_LIME: 0x9fd94a,
  FABRIC_WHITE: 0xf7f1e2,

  /* ======================================================================
   * SIGNAGE / NEON — bloom bait. Keep saturated and few.
   * ==================================================================== */
  NEON_PINK: 0xff3d8b,
  NEON_AQUA: 0x37e6d5,
  NEON_YELLOW: 0xffc93c,
  NEON_PURPLE: 0xa066ff,
  NEON_GREEN: 0x4dff9e,
  NEON_ORANGE: 0xff8a3d,
  NEON_BLUE: 0x49b8ff,
  NEON_WHITE: 0xfff2dd,
  SIGN_DARK: 0x2a2f3a,
  SIGN_LIGHT: 0xf4efe2,

  /* ======================================================================
   * THE HOLE — must be the darkest thing on screen by a wide margin
   * ==================================================================== */
  HOLE_VOID: 0x08070d,
  HOLE_RIM: 0x151321,
  HOLE_LIP: 0xff3d8b,
  HOLE_GLOW: 0xff6fb0,

  /* ======================================================================
   * FX — dust, debris, shockwaves
   * ==================================================================== */
  DUST: 0xdccdb2,
  SMOKE: 0xcfc8bc,
  SPARK: 0xffd88a,
  SHOCKWAVE: 0xfff0d8,

  /* ======================================================================
   * UI / ACCENTS
   * ==================================================================== */
  ACCENT_HOT: 0xff3d8b,
  ACCENT_SUN: 0xffc93c,
  ACCENT_AQUA: 0x37e6d5,
  ACCENT_LILAC: 0xb98cff,
  UI_DARK: 0x18141f,
  UI_LIGHT: 0xfdf6ea,
};

/* ==========================================================================
 * CURATED SETS
 * Pick from these instead of inventing colours — they are chosen so that any
 * random draw still sits inside the Miami grade.
 * ======================================================================== */

/** Curtain-wall tints for towers. All read blue/teal against the warm city. */
export const GLASS_TINTS = [
  PALETTE.GLASS_TEAL, PALETTE.GLASS_BLUE, PALETTE.GLASS_MINT,
  PALETTE.GLASS_AQUA, PALETTE.GLASS_SKY, PALETTE.GLASS_BRONZE,
];

/** Painted-render facades for midrises and lowrises. Deco pastels. */
export const STUCCO_TINTS = [
  PALETTE.STUCCO_PINK, PALETTE.STUCCO_CORAL, PALETTE.STUCCO_CREAM,
  PALETTE.STUCCO_LILAC, PALETTE.STUCCO_AQUA, PALETTE.STUCCO_MINT,
  PALETTE.STUCCO_PEACH, PALETTE.STUCCO_SAND, PALETTE.STUCCO_WHITE,
  PALETTE.STUCCO_SKY, PALETTE.STUCCO_BUTTER,
];

/** Weighted-ish car paints: mostly neutral metal, a few pop colours. */
export const CAR_PAINTS = [
  PALETTE.CAR_WHITE, PALETTE.CAR_WHITE, PALETTE.CAR_SILVER, PALETTE.CAR_SILVER,
  PALETTE.CAR_GRAPHITE, PALETTE.CAR_BLACK,
  PALETTE.CAR_RED, PALETTE.CAR_CORAL, PALETTE.CAR_ORANGE, PALETTE.CAR_YELLOW,
  PALETTE.CAR_LIME, PALETTE.CAR_GREEN, PALETTE.CAR_TEAL, PALETTE.CAR_MINT,
  PALETTE.CAR_BLUE, PALETTE.CAR_NAVY, PALETTE.CAR_PURPLE, PALETTE.CAR_PINK,
];

/** Awnings, parasols, beach umbrellas, market stalls. */
export const FABRIC_COLORS = [
  PALETTE.FABRIC_CORAL, PALETTE.FABRIC_AQUA, PALETTE.FABRIC_SUN,
  PALETTE.FABRIC_SKY, PALETTE.FABRIC_PINK, PALETTE.FABRIC_LIME,
  PALETTE.FABRIC_WHITE,
];

/** Signage neon. Use sparingly — these are the only things allowed to bloom. */
export const NEON_COLORS = [
  PALETTE.NEON_PINK, PALETTE.NEON_AQUA, PALETTE.NEON_YELLOW,
  PALETTE.NEON_PURPLE, PALETTE.NEON_GREEN, PALETTE.NEON_ORANGE,
  PALETTE.NEON_BLUE,
];

/** Greens for scatter foliage, so a field of hedges isn't one flat colour. */
export const FOLIAGE_GREENS = [
  PALETTE.TREE_CANOPY, PALETTE.TREE_CANOPY_DARK, PALETTE.TREE_CANOPY_LIGHT,
  PALETTE.HEDGE, PALETTE.HEDGE_LIGHT, PALETTE.PALM_FROND,
];
