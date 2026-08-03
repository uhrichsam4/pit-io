export const meta = {
  name: 'miami-feel-wave',
  description: 'Game feel + presentation: hole visuals & VFX, HUD/screens, balance & AI, audio',
  phases: [
    { title: 'Feel', detail: '4 parallel agents on disjoint files' },
    { title: 'Integrate', detail: 'verify, measure, report' },
  ],
};

const CWD = '/Users/sam/untitled folder 6';

const COMMON = `
PROJECT: ${CWD}  (cd there first; the path contains a space, so QUOTE IT)
MIAMI DEVOUR — a Hole.io-style Miami city-eating game in Three.js r0.185.
A Vite dev server is ALREADY RUNNING on http://localhost:5173. Do not start another.

MANDATORY READING before you write anything:
  docs/ART_DIRECTION.md, docs/REVIEW_RUBRIC.md, src/game.js, src/config.js,
  and the files you own.

VERIFY:
  cd "${CWD}" && node tools/shot.mjs --presets <names> --out shots/<slug> --w 1600 --h 900
  Add --ui to keep the HUD visible (essential for the UI agent).
  Add --script "JS" to run arbitrary DEV calls before the capture, e.g.
    --script "DEV.setSize(12); DEV.devour(50);"
  DEV API: DEV.play(), DEV.setSize(r), DEV.teleport(x,z), DEV.devour(radius),
  DEV.render(n, dt), DEV.simulate(seconds), DEV.stats(), DEV.hideUI(bool),
  DEV.shot(presetName), DEV.clearBots().
  Then READ the PNGs with the Read tool and LOOK at them. Never claim a visual
  result you have not seen. report.json 'errors' must be empty for your files.

RULES:
- Edit ONLY the files under "YOU OWN". Three other agents are editing this same
  tree right now.
- Never rename or remove an export another module imports. Adding is fine.
- No new npm dependencies. No binary assets.
- Comment WHY, not WHAT.
- Do at least 4 look-fix cycles.

CURRENT STATE (measured, whole-city 'menu-hero' preset):
  956 draw calls, 3.83M triangles, 23,806 consumable objects.
Draw calls are healthy. TRIANGLES ARE ~2x THE TARGET (1.8M) — the city got very
dense in the last wave. If your work touches geometry, do not add to that, and
if you can cheaply reduce it (LOD, lower-poly distant instances, decimating
props the camera never gets near) that is genuinely valuable. Report your delta.

Your final message is a REPORT: what changed, what you measured, which presets
you inspected, what still needs work, what you need from others.
`;

phase('Feel');

const results = await parallel([
  () => agent(`${COMMON}

YOU OWN:
  src/gameplay/hole.js
  src/render/groundShader.js
  src/render/effects.js

ROLE: the hole itself, and every bit of feedback that fires when it eats.

The hole is the main character and the single most important thing on screen.
Right now it is a dark cone with a coloured ring and a modest particle burst.

1. THE VOID. Make the pit genuinely read as a bottomless drain: a deeper,
   richer interior gradient, swirling striations that speed up as they descend,
   a subtle inner glow, and a hot lip. It must be unmistakably the darkest thing
   in the frame at every size, without becoming a flat black disc.
2. THE LIP. A convincing rim: a soft contact-shadow ring on the ground (already
   in groundShader), a slight lifted-earth lip, cracks radiating outward that
   scale with hole size, and dust/grit sitting at the edge. The edge should read
   as torn ground, not as a vector circle. Keep the existing subtle wobble but
   make it feel geological rather than noisy.
3. GROWTH FEEDBACK. A satisfying, chunky pulse on every swallow, with squash
   and stretch that scales with the size of the meal. A distinct, celebratory
   moment when the hole crosses into a new tier.
4. VFX (effects.js). Much better: dust plumes with real turbulence and
   lifetime-driven colour, debris chunks that tumble and settle, spark/glint
   accents on glass, a proper expanding shockwave ring with a leading edge,
   and screen-space grit near the lip. Everything must be pooled — no
   allocation on the hot path. Keep the existing public API
   (puff, chunks, shockwave, popup, addShake, update, .shake, .popups) working;
   src/game.js and src/gameplay/consume.js call all of it.
5. MULTI-HOLE. groundShader supports up to 12 holes. Make sure rival holes read
   clearly and are visually distinct by owner colour, including on the minimap.
6. PERFORMANCE. Particles must not cost more than ~1 ms/frame at full tilt.

Verify with: hole-small, hole-mid, hole-big, occlusion, intersection, and
capture mid-swallow frames using
  --script "DEV.setSize(10); DEV.devour(40);" --settle 2
so you can actually see objects in flight.
`, { label: 'hole+vfx', phase: 'Feel' }),

  () => agent(`${COMMON}

YOU OWN:
  src/ui/hud.js
  src/ui/screens.js
  src/ui/styles.css
  src/ui/minimap.js   (new file, if you want to split it out)

ROLE: the entire player-facing interface.

The current HUD is a functional placeholder: a timer chip, a leaderboard panel,
a size meter, a canvas minimap, a kill feed and floating score numbers. It works
but it does not look like a shipped game.

Deliver a genuinely polished, characterful UI in keeping with the bright Miami
art direction (see PALETTE in src/render/palette.js):

1. TITLE / MENU. A real title screen worthy of the game: strong typography,
   an animated gradient, a play button with weight, a short how-to-play, and a
   name entry field. Remember the camera is slowly orbiting the skyline behind
   it — the UI must sit over that legibly.
2. HUD. Timer, leaderboard, size/progress meter, kill feed, minimap. Make it
   readable at a glance in a busy frame: proper contrast, drop shadows or
   scrims where needed, tabular numerals, smooth animated transitions on score
   and rank changes. Rank changes should be felt.
3. SIZE / UNLOCK METER. This is the core progression read. Show the current
   tier, the next unlock, and progress toward it, with a satisfying animation
   and a celebration when a tier is crossed. TIER_LIST is exported from config.
4. MINIMAP. Better than a flat canvas grid: show land/water/parks, the road
   network, all holes coloured by owner with the player emphasised, and pips
   for nearby high-value targets. Keep it cheap — it redraws every frame.
5. SCORE POPUPS. Floating numbers that feel good: scale punch, colour by tier,
   slight arc, clean fade. They are anchored to world positions by hud.syncPopups.
6. RESULTS SCREEN. Final placement, the full ranking, the player's best meal,
   objects devoured, a play-again button.
7. FEEDBACK STATES. Countdown, FRENZY announcement in the last 30 s, being
   eaten (and the respawn timer), and a "too big to eat" hint early on.
8. RESPONSIVE + TOUCH. Must work at 1280x720 through 2560x1440, and on a phone
   in landscape with a touch joystick that does not fight the HUD.

CONTRACT — src/game.js calls all of these; keep them working:
  new HUD(uiRoot, camera); hud.root (the layer element);
  hud.setTimer(s), hud.setLeaderboard(holes, me), hud.setSize(hole),
  hud.pushFeed(html, color), hud.syncPopups(effects, camera),
  hud.drawMinimap(holes, me, layout)
  new Screens(uiRoot); screens.onPlay, screens.clear(), screens.showLoading(t),
  screens.showMenu(stats), screens.showCountdown(n), screens.showResults(ranks, me)
You may ADD methods; if you need game.js to call something new, say so clearly
in your report instead of editing game.js.

Verify with --ui, e.g.
  node tools/shot.mjs --presets hole-mid,hole-small --out shots/ui-check --ui --w 1600 --h 900
and read the images. Also check the menu and results screens by scripting
  --script "DEV.hideUI(false); __GAME__.screens.showResults(__GAME__.match.rankings(), __GAME__.player);"
`, { label: 'ui', phase: 'Feel' }),

  () => agent(`${COMMON}

YOU OWN:
  src/gameplay/ai.js
  src/gameplay/match.js
  src/gameplay/input.js
  src/config.js   (the HOLE / MATCH / TIER blocks only — do NOT touch the
                   re-exports at the top, and do NOT edit palette.js/quality.js)

ROLE: game feel, balance and opponents.

1. BALANCE PASS. Play the whole growth curve and tune it. Concretely:
   - starting size vs the size of the smallest props, so the first 10 seconds
     are immediately satisfying
   - the growth curve (HOLE.GROWTH_K / GROWTH_P) so each tier unlock lands at a
     good pace across a 150 s match
   - movement speed vs size (a huge hole should feel powerful and weighty, not
     sluggish; a tiny hole should feel nippy)
   - camera distance ramp so the playfield always shows a useful amount
   - tier thresholds and score values so no tier is a dead zone
   Measure this, do not guess: use DEV.simulate() and the bots to run whole
   matches headlessly and report the score/radius curve over time, the time to
   each tier unlock, and the final score spread across 8 players. Iterate on the
   numbers until the curve looks right, and put the resulting numbers and the
   reasoning in comments.
2. AI. Bots must be genuinely fun opponents: better target selection (value
   density vs travel time), real fleeing with map awareness so they do not get
   cornered, hunting smaller players, contesting rich areas, difficulty spread
   so some are pushovers and some are threats, and rubber-banding that is
   subtle rather than obvious. They must never pile into the same spot, never
   drive into the bay, and never oscillate.
3. MATCH. Countdown, the last-30s FRENZY, respawn rules, and end-of-match
   ranking. Add a sense of escalation: announcements at milestones, and the
   leader being marked.
4. INPUT. Tighten it: deadzones, acceleration curve, a keyboard feel that is
   crisp, pointer-steer that does not fight the camera yaw, touch joystick, and
   gamepad. Add a subtle input-buffer so direction changes feel instant.

Do NOT change the exported names of anything (spawnBots, BotController, Match,
PHASE, Input) — game.js imports them all.

Verify by running headless matches and reporting real numbers, plus screenshots
of a mid-match state with bots visible (use --bots).
`, { label: 'balance+ai', phase: 'Feel' }),

  () => agent(`${COMMON}

YOU OWN:
  src/core/audio.js

ROLE: the entire soundtrack and sound effects, fully synthesised (Web Audio,
no sample files — the build ships no binary assets).

The current implementation is a working skeleton: filtered-noise chomps, a
crumble, a level-up arpeggio, a death sting, and a sparse generative bass line.

Make it genuinely good:
1. SWALLOW SOUNDS. A family of them that scales continuously with object size
   and varies by material — a plastic cone, a metal bin, a glass storefront and
   a concrete tower should all sound like themselves. consume.js passes you the
   Consumable; use c.kind / c.tier / c.radius. Layer: an air-rush, a body
   thump, and a granular debris tail. Rate-limit and voice-steal properly, and
   make a rapid burst of swallows sound like a satisfying cascade rather than
   mush.
2. THE HOLE'S PRESENCE. A continuous, size-scaled sub-bass rumble and a subtle
   wind/suction bed that intensifies near big objects.
3. MUSIC. A proper generative track with Miami character — synthwave-adjacent,
   bright, driving but not fatiguing over a 150 s match. Give it structure:
   an intro, a build, a clear intensification when FRENZY starts in the last
   30 seconds, and a resolution at the end. Sidechain it gently to big events.
4. UI + EVENT AUDIO. Countdown beeps, tier-unlock fanfare, eating a rival,
   being eaten, match start and match end, leaderboard position change.
5. MIX. Buses, a limiter, and no clipping when twenty things are swallowed at
   once. Provide setVolume / setMuted / a music-vs-sfx balance.
6. SPATIALISATION. Pan and attenuate by distance from the player's hole using
   the existing WebAudio graph (a PannerNode per voice is fine if pooled).

CONTRACT — src/game.js calls: audio.unlock(), audio.startMusic(),
audio.chomp(size), audio.crumble(size), audio.levelUp(tier), audio.devourPlayer(),
audio.death(), audio.updateAmbience(radius), and exports the singleton 'audio'.
Keep all of those working. You may add methods; if you need game.js to call
something new, say so in your report rather than editing game.js.

You cannot hear your work, so be rigorous a different way: write a small Node
script that instantiates the graph against a stub AudioContext (or use
OfflineAudioContext in the browser via DEV) to assert that no voice exceeds
0 dBFS, that voices are released, and that a 200-swallow burst does not leave
oscillators running. Report those measurements.
`, { label: 'audio', phase: 'Feel' }),
]);

phase('Integrate');

const integration = await agent(`${COMMON}

YOU OWN: any file, but ONLY to repair breakage. No aesthetic work.

Four agents just finished in parallel:
  hole.js + groundShader.js + effects.js
  ui/*
  ai.js + match.js + input.js + config.js
  audio.js

Their reports:
${results.map((r, i) => `--- agent ${i + 1} ---\n${(r || 'FAILED — no report').slice(0, 2500)}`).join('\n\n')}

DO:
1. node tools/shot.mjs --all --out shots/feel-check --w 1600 --h 900
2. Drive shots/feel-check/report.json 'errors' to EMPTY.
3. node tools/shot.mjs --presets hole-mid,hole-small,menu-hero --out shots/feel-ui --ui
   and confirm the HUD renders correctly over the game.
4. node tools/net-test.mjs   — multiplayer must still pass all three checks.
   (Start the room server first if it is not running: npm run server &)
5. Read every png. Fix outright breakage only.
6. Report per-preset drawCalls/triangles and the final error list.
`, { label: 'feel-integration', phase: 'Integrate' });

return { results, integration };
