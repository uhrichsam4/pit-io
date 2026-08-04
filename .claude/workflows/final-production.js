export const meta = {
  name: 'miami-final-production',
  description: 'Final production pass: 6 focused agents across city design, props, architecture, physics, UX and city life, then integrated verification',
  phases: [
    { title: 'Production', detail: '6 parallel agents on disjoint file ownership' },
    { title: 'Integrate', detail: 'fix cross-module breakage, re-verify everything together' },
    { title: 'Signoff', detail: 'full-map final test at every hole size, day and night' },
  ],
};

const CWD = '/Users/sam/untitled folder 6';

const COMMON = `
PROJECT: ${CWD}  (cd there first; the path has a space, so QUOTE IT)
MIAMI DEVOUR — a Hole.io-style Miami city-eating game in Three.js r0.185.
A Vite dev server is already running on http://localhost:5173.

This is the FINAL PRODUCTION PASS. The goal is a premium, polished, bright
Miami city game with no obvious bugs, misplaced objects, unfinished areas or
low-quality visuals. DO NOT merely report problems — FIX them.

READ FIRST: docs/ART_DIRECTION.md, docs/REVIEW_RUBRIC.md, docs/PERF_FINDINGS.md,
src/world/worldBuild.js (the content contract), src/render/palette.js.

=== THE GAMEPLAY CONTRACT — everything you add or change must respect it ===

Consumption is PURELY GEOMETRIC. There is no size class or tier gate.
  · worldBuild MEASURES each object's ground-contact footprint from its
    geometry and sets radius / height / passRadius itself. Values you pass to
    ctx.addInstanced / ctx.addMesh are IGNORED unless you pass exactSize:true.
    FIX PHYSICS BY FIXING GEOMETRY, never by passing a different number.
  · An object reacts when a hole takes enough ground from under it AND the
    opening is large enough relative to that object — 50% of what would
    swallow it for light props, ~62% a bus, ~75% a storefront, 85% a tower.
  · It topples about the last edge of ground still under it under real gravity,
    and passes through when the opening exceeds passRadius (the NARROW way
    through, not the footprint).
  · Buildings NEVER slide, drag or drift toward a hole. Lateral motion for them
    is zero by design. They tilt and collapse where they stand.
  · The object that falls IS the placed instance. Nothing is spawned to stand
    in for it. Never add code that hides an object and spawns a copy.
  · Objects are removed only once fully below ground, then respawn after 30 s.

Anything you place MUST: sit exactly on the surface beneath it (road y=0,
sidewalk ctx.Y_WALK, plaza, park, bridge deck, garage floor all differ); not
intersect other props, kerbs, buildings or the carriageway; not block a path
the player, the bots or the crowd need; and go through ctx.addInstanced /
ctx.addMesh so it is edible. Use ctx.occupy / ctx.isFree to claim ground.

=== THE DAY/NIGHT CONTRACT ===
engine.js publishes every frame:
    scene.userData.timeOfDay    0..1   (0 midnight, 0.5 noon)
    scene.userData.nightFactor  0..1   (0 day, 1 night)
    scene.userData.sunDir       Vector3 key direction, mutated in place
    scene.userData.dayNight     { keyColor, keyIntensity, skyHi, skyLo,
                                  hazeColor, fogColor, ambientLevel }
Read nightFactor in your per-frame update to drive emissive intensity. Do not
re-implement the cycle. Under navigator.webdriver the clock boots FROZEN at
afternoon so screenshots are deterministic; ask for another hour explicitly:
  --script "__GAME__.engine.setTimeOfDay(0.85)"

=== TOOLS ===
  node tools/prop-audit.mjs          size + placement audit (cheap, no screenshots)
  node tools/consume-test.mjs        physics regression — MUST keep passing
  node tools/restart-test.mjs        end-of-match + full restart regression
  node tools/perf-audit.mjs          per-pool triangle and draw-call breakdown
  node tools/shot.mjs --presets a,b --out shots/<slug> --w 1600 --h 900
  node tools/seq.mjs --size 7 --frames 6 --out shots/<slug>
  node tools/net-test.mjs            multiplayer (needs npm run server)
READ the PNGs with the Read tool. Never claim a visual result you have not seen.

THE MACHINE IS SHARED between six agents. Run ONE headless tool at a time.
Prefer prop-audit and perf-audit (cheap) over full screenshot sweeps. If a
screenshot times out, lower the resolution or wait — never retry in a loop.

RULES
- Edit ONLY the files under "YOU OWN". Five other agents are editing this tree.
- Never rename or remove an export another module imports. Adding is fine.
- No new npm dependencies. No binary assets. Everything procedural.
- ANTI-REPETITION is a stated requirement. Vary scale, rotation, colour, shape
  and placement. A row of identical assets is a defect.
- PERFORMANCE: read docs/PERF_FINDINGS.md. Draw calls <= 1,500. Do not increase
  the triangle count without saying so. Report your module's numbers.
- Comment WHY, not WHAT.

Your final message is a REPORT: what you FIXED (not just found), counts and
measurements before/after, presets inspected, what is still wrong, and anything
another module must do.
`;

phase('Production');

const work = await parallel([

  /* ------------------------------------------------ 1. city design ------- */
  () => agent(`${COMMON}

YOU OWN: src/world/cityLayout.js, src/world/streets.js, src/world/water.js

AREA 1 — MAP LAYOUT AND CITY DESIGN.

Inspect the whole of Brickell and Downtown and make the city read as a real
Miami district rather than a generated grid.

1. ROADS AND JUNCTIONS. Every road must terminate sensibly — no road that
   simply stops, runs into a building, or dead-ends at the map edge without a
   reason. Junctions must be geometrically clean: kerb radii, correct lane
   alignment through the intersection, stop bars where cars actually stop,
   crossings on every approach that needs one. Check that lane markings agree
   with where roadNetwork.js actually puts vehicles.
2. UNFINISHED OR EMPTY AREAS. Sweep the map for blocks that read as blank:
   bare slabs, dark voids, parcels with nothing on them, stretches of road with
   no frontage. Every parcel must have a reason to exist — a building, a car
   park with markings, a fenced lot, a plaza, a park.
3. SIDEWALKS, KERBS, MEDIANS. Continuous kerb lines with a real profile and
   gutter, ramps at crossings, planted medians, expansion joints, tree pits,
   drain and manhole covers. No sidewalk that stops mid-block.
4. WATERFRONT. Seawall, promenade, steps to the water, marina basins that
   actually hold water, piers, boardwalk, mooring furniture. The shoreline
   silhouette must match what cityLayout cut — no land showing under the sea,
   no basins rendering as grey ground.
5. WATER QUALITY AND THE DAY/NIGHT CONTRACT. Drive the water surface from
   scene.userData.sunDir / nightFactor / dayNight in your per-frame update.
   A previous review measured the bay at night as an electric cyan sheet
   BRIGHTER THAN THE CITY, because the sun was baked in at build time. Verify
   with a night screenshot that the bay is darker than the lit city.
6. HOLE-CUT DISCIPLINE. Every ground-level surface must use materials.ground()
   or applyHoleCut, or holes will not cut through it. Screenshot a hole on each
   surface type you add or change.

Verify: intersection, street-level, downtown-wide, waterfront, river,
hole-small, plus a night pass. Run prop-audit and consume-test.
`, { label: '1-city-design', phase: 'Production' }),

  /* ------------------------------------------- 2. props & environment ---- */
  () => agent(`${COMMON}

YOU OWN: src/world/props.js, src/world/nature.js

AREA 2 — PROP PLACEMENT AND ENVIRONMENT DETAIL.

1. AUDIT EVERY PROP. Run node tools/prop-audit.mjs and drive your kinds'
   floating / sunken / in-water counts to ZERO and the overlap count down.
   Report before/after. Note the audit's ground test does not know local
   surface height, so confirm each flag before acting — hanging baskets are
   supposed to be off the ground.
2. LOGICAL PLACEMENT. Street furniture on sidewalks facing the street; café
   furniture outside the restaurant it belongs to; construction props inside
   construction zones; waterfront props near the bay; trees in planters, tree
   pits and green areas. Nothing in the carriageway, on a crossing, on a
   bridge deck it does not belong to, or somewhere a player cannot reach.
3. UPGRADE THE MODELS. Replace anything that still reads as a placeholder.
   Better silhouettes, bevelled edges, material and colour variation, small
   details (bolts, slats, handles, signage, wear). These are what the player
   stares at for the first minute of every match, so they must hold up close.
4. ANTI-REPETITION. Vary scale, rotation, colour and model within every type.
   Two identical benches side by side at the same angle is the defect.
5. DENSITY WITHOUT CLUTTER. The city must feel alive but stay fair to play in:
   no prop walls blocking a street, no pile-ups that trap the hole, clear
   routes through every block.
6. NATURE. Vary palms and trees substantially — species, trunk height, lean,
   crown size, frond droop, hue. Parks and plazas must not be bare: paths,
   beds, hedges, benches, play equipment, water features. Trees must not
   obscure the player: keep crowns clear of the camera corridor (trees are NOT
   registered with the occlusion fade, and must not be — only buildings fade).
7. THE PHYSICS CONTRACT. A tree's footprint is measured from its TRUNK (lowest
   fifth of geometry). Make sure trunk geometry sits where the visual trunk is
   and crowns do not dip into that band.

Verify: street-level, crowd, park, intersection, construction, waterfront.
Run prop-audit and consume-test.
`, { label: '2-props-environment', phase: 'Production' }),

  /* ------------------------------------ 3. architecture & materials ------ */
  () => agent(`${COMMON}

YOU OWN: src/world/buildings.js, src/core/materials.js, src/render/palette.js

AREA 3 — BUILDINGS, ARCHITECTURE AND TEXTURES.

1. ARCHITECTURE. Miami-style variety: glass curtain wall, Deco banding, pastel
   stucco, balcony stacks, vertical fins, setbacks with planted terraces,
   expressed cores, cornices, real crowns. No two neighbours may read as the
   same asset recoloured — use the per-block seed for determinism.
2. GROUND FLOOR. What the player actually drives past: deep shopfronts with
   real glazing, entrance canopies, lobbies hinted behind glass, awnings,
   address numbers, signage, planters at the base.
3. ROOFTOPS. On screen almost every frame from this camera. Parapets, AC
   plant, ducts, water tanks, stair bulkheads, dishes, helipads, and pools with
   loungers and bars on residential towers.
4. TEXTURES — remove anything blurry, flat, stretched, obviously repeated or
   placeholder-looking. Roads, sidewalks, concrete, grass, plants, water,
   vehicles, buildings, props, signs. Kill visible tiling: larger canvases
   where it pays, multi-octave noise, per-tile variation. Matched colour +
   roughness + normal maps for anything the camera gets close to. Roughness is
   where most of the realism lives.
5. NIGHT. Lit windows, illuminated crowns, rooftop neon, storefront fascias,
   signage — all driven by nightFactor. An unlit skyline at night is the thing
   to avoid.
6. KEEP EVERY EXISTING EXPORT WORKING — buildings, streets, props, nature,
   vehicles and water all call Textures.* and ground/solid/glass/painted/
   emissive/foliage. Removing or renaming breaks five modules.
7. THE PHYSICS CONTRACT. Buildings are sized from measured geometry. Anything
   sprawling outside its own parcel (a crane jib, a canopy) inflates that
   measurement and makes the building react to holes it should not. Keep
   geometry inside its lot with the base flush to ctx.Y_WALK.
8. BUDGET. Texture generation must stay under ~800 ms at boot. Merge each
   building to as few meshes as possible. Report draw calls and triangles.

Verify: brickell-skyline, downtown-wide, rooftops, street-level, construction,
menu-hero, plus a night pass.
`, { label: '3-architecture-textures', phase: 'Production' }),

  /* -------------------------------------------------- 4. physics --------- */
  () => agent(`${COMMON}

YOU OWN: src/gameplay/consume.js, src/gameplay/entities.js,
         src/core/pools.js, src/world/worldBuild.js

AREA 4 — GAMEPLAY PHYSICS AND OBJECT INTERACTIONS.

You own the rules every other module builds against. Be rigorous and prove
everything with measurements.

1. TEST EVERY CATEGORY AT EVERY HOLE SIZE. Systematically: for hole radius
   2, 4, 8, 16, 32 and near max, and for each major prop family (litter,
   street furniture, signs and posts, bicycles and scooters, cars, buses and
   trucks, trees, café furniture, construction plant, storefronts, towers,
   pedestrians, boats) record: does it react when it should, does it stay put
   when it should, does it topple convincingly, does it fall in and disappear
   cleanly, does it respawn. Produce a TABLE. Fix every disagreement between
   what the player can see and what the physics does.
2. THINGS THAT SHOULD FIT BUT CANNOT BE EATEN. This was a reported bug class.
   Hunt for any object whose passRadius or measured footprint disagrees with
   its visible size, and fix the measurement rather than special-casing.
3. THINGS THAT MOVE WHILE TOO LARGE. Especially buildings. Verify a small hole
   moves a storefront/tower by EXACTLY 0, and that lateral motion for the SINK
   profile stays zero at all times.
4. RIM DEFECTS. No object may be left clipped through the rim, hovering,
   jittering, spinning unstably, orbiting, or stuck across the opening. There
   is an anti-lodge guard — verify it works and tune it.
5. CLEAN REMOVAL AND RESPAWN. An object disappears only after it is fully
   below the world, is then completely inert (invisible, uncollidable,
   unqueryable, unedible), and returns after the delay in its correct place.
   No duplicates, no ghosts, no leftover collision.
6. PERFORMANCE. docs/PERF_FINDINGS.md documents the pool structure. If you can
   reduce cost without changing behaviour (instance compaction, cheaper
   queries, fewer per-frame allocations), do it and measure it.
7. THE TEST SUITES ARE YOURS TO EXTEND. tools/consume-test.mjs and
   tools/restart-test.mjs must keep passing; add cases for anything you fix so
   it cannot regress.

Verify: consume-test, restart-test, prop-audit, seq captures at several sizes.
`, { label: '4-physics', phase: 'Production' }),

  /* --------------------------------------- 5. camera, UI, game flow ------ */
  () => agent(`${COMMON}

YOU OWN: src/game.js, src/ui/*, src/render/occlusion.js, src/core/engine.js,
         src/core/quality.js, src/render/postfx.js, src/dev/devtools.js,
         src/gameplay/match.js, src/gameplay/ai.js, src/gameplay/input.js

AREA 5 — CAMERA, VISIBILITY, UI AND GAME FLOW.

1. VISIBILITY RULES — get this exactly right.
   ONLY large buildings and major structures fade when they block the camera's
   view of the hole. Trees, palms, cars, benches, signs and ordinary props must
   stay SOLID. The threshold is currently a 6 m footprint and 8 m height in
   game.js — verify it holds in practice and that nothing small is fading.
   The fade must be subtle and smooth, and restore promptly when the player
   moves out. Where a small prop does hide the hole, the answer is camera
   framing, not fading the prop.
2. CAMERA. Smooth follow at every hole size from 2 m to max, no snapping,
   no clipping through geometry, no jitter. Verify the framing shows a useful
   amount of playfield at each size.
3. UI. Minimap, leaderboard, score, size/progression meter, kill feed, timer,
   countdown, frenzy announcement. Check at 1280x720, 1920x1080, 2560x1440 and
   phone landscape: no overlap, no unreadable text, no clipping, correct
   rankings, smooth transitions.
4. GAME FLOW. Lobby to match to end screen to restart, and lobby again. Run
   node tools/restart-test.mjs — it asserts that gameplay truly freezes at the
   end and that a restart fully restores the city with no duplicates, no stuck
   objects, no old scores and no leftover AI. Extend it if you find a gap.
5. AI. Bots must be genuinely fun: no getting stuck, no driving into the bay
   or the river, no piling onto one spot, no oscillating, and a real spread of
   threat. Run several headless matches and report the score spread.
6. LIGHTING AND SHADOWS. Shadows must ground buildings, cars, trees, props and
   pedestrians without becoming harsh or crushing the image. Keep the city
   bright and readable at every hour — night reads as night by hue and by the
   city lighting up, never by being too dark to play.

Verify: every preset day and night, restart-test, plus UI captures with --ui at
several resolutions.
`, { label: '5-camera-ui-flow', phase: 'Production' }),

  /* ------------------------------------------------ 6. city life -------- */
  () => agent(`${COMMON}

YOU OWN: src/world/vehicles.js, src/world/pedestrians.js

AREA 6 — TRAFFIC, PEDESTRIANS AND CITY LIFE.

1. TRAFFIC CORRECTNESS. Cars must follow lanes, keep headway, stop at red,
   queue, turn, park and pull out — without driving through each other, the
   kerb, buildings or scenery, and without gridlock. Fix any vehicle path that
   crosses a footway, a building footprint or the water.
2. VEHICLE VARIETY AND QUALITY. Sedans, SUVs, hatchbacks, pickups,
   convertibles, taxis with livery, buses, articulated buses, delivery vans,
   box trucks, service vehicles, police, ambulance, motorcycles, scooters, and
   Miami luxury and exotic cars that feel genuinely distinct and polished.
   Proper proportions, separate darker glass, visible wheels on the road,
   emissive lights, mirrors, plates. Headlights and tail lights on at night.
3. PEDESTRIANS. Commuters, tourists, office workers, joggers, cyclists,
   families, dog walkers, people on phones, groups talking, people sitting.
   Café crowds seated and eating with waiters moving between tables. Nightlife
   queues, doormen, valet. CONTENT CREATORS filming — tripods, ring lights,
   boom mics, small crews, people posing.
4. THE STREET-LIFE LAYER. Read docs/STREET_LIFE.md and build it: buskers with
   small audiences, domino and chess games with spectators, vendors with
   blankets and folding tables, preachers, people asleep on benches, rough
   sleepers with belongings placed in the quiet out-of-the-way parts of the
   city rather than the polished frontage, and Miami eccentrics. Follow that
   document's section on treating these characters with the same care as
   everyone else — same modelling standard, never played for laughs.
5. NO WALKING INTO THINGS. Pedestrians must not stand inside benches,
   planters or shelters. A previous review found ~30 such cases: query the
   registry (which has measured radii) rather than the coarse occupancy grid.
6. A KNOWN BUG. A consumed pedestrian is killed at state >= 2 and vanishes
   instead of falling in. Every other prop visibly tips and falls. Stop driving
   an agent once state >= 1 and let the consume system own its transform, the
   way vehicles.js does. Prove it with a seq capture.
7. VARIED MOVEMENT. No obvious repeated patterns, no empty-feeling areas, no
   conga lines. Density from block.streetLife and shifting with nightFactor.
8. PERFORMANCE. docs/PERF_FINDINGS.md documents two wins in your files: cars
   allocate ONE POOL PER PAINT COLOUR (collapse to one pool per body type with
   per-instance colour), and ~1,500 pedestrian fall-pose instances are
   pre-allocated for the handful ever falling. Both are pure savings. Also
   consider a single low-poly shadow proxy per pedestrian instead of three
   part pools casting. Measure and report.

Verify: intersection, crowd, street-level, waterfront, plus consume-test,
prop-audit, perf-audit and a seq capture of a pedestrian falling in.
`, { label: '6-city-life', phase: 'Production' }),
]);

/* ------------------------------------------------------------------------- */

phase('Integrate');

const integrate = await agent(`${COMMON}

YOU OWN: any file, to repair cross-module breakage and finish unfinished work.

Six agents just did a production pass in parallel. Their reports:
${work.map((r, i) => `--- agent ${i + 1} ---\n${(r || 'FAILED — no report').slice(0, 2200)}`).join('\n\n')}

DO, in order, pasting real output for each:

1. Does it boot? Load the page and confirm window.DEV appears with no page
   errors. If a module throws, fix it — that is the highest priority.
2. node tools/consume-test.mjs      — every property must hold
3. node tools/restart-test.mjs      — freeze, end screen, full restore
4. node tools/prop-audit.mjs        — report kinds flagged, overlaps,
   floating, sunken, in-water. Anything WORSE than the last run is a
   regression: find who caused it and fix it.
5. node tools/perf-audit.mjs        — draw calls and triangles, day and night
6. npm run server & then node tools/net-test.mjs

Then resolve the cross-module issues the six could not, because they only own
their own files. Watch specifically for: two modules placing objects in the
same space, a module relying on an export another changed, geometry that
sprawls outside its parcel, and anything that regressed the physics contract.

Do not do aesthetic work. Fix breakage and inconsistency.
`, { label: 'integrate', phase: 'Integrate' });

/* ------------------------------------------------------------------------- */

phase('Signoff');

const signoff = await agent(`${COMMON}

YOU OWN: any file, to fix what you find. This is the last pass before the game
is called finished.

Integration report:
${(integrate || 'FAILED — no report').slice(0, 3000)}

Run a FINAL INTEGRATED TEST across the whole map and FIX everything you find.

1. FULL VISUAL SWEEP, DAY AND NIGHT.
   node tools/shot.mjs --all --out shots/final-day --w 1600 --h 900
   node tools/shot.mjs --all --out shots/final-night --w 1600 --h 900 --script "__GAME__.engine.setTimeOfDay(0.87)"
   'errors' must be EMPTY in both. READ every image. Judge against
   docs/REVIEW_RUBRIC.md, including its blind test. Fix every blocker and
   every major finding.

2. EVERY HOLE SIZE. r = 2, 4, 8, 16, 32, near-max. For each, confirm:
   something edible is always nearby; objects react only when they should;
   the hole is never hidden by scenery; the camera framing is right; movement
   is smooth. Report a table.

3. THE FULL LOOP. Lobby -> match -> end screen -> Play Again -> match ->
   Return to Lobby. No leftover state, no old scores, no missing city.

4. REGRESSIONS. consume-test, restart-test, prop-audit, perf-audit, net-test.
   All must pass. Paste the numbers.

5. WRITE docs/FINAL_QA.md — an honest record of what was verified, the
   measurements, and every defect still outstanding with the file that owns
   it. Do not hide anything: a clean report that conceals a defect is worse
   than a messy one that names it.

The bar: a premium, polished, bright Miami city game with detailed roads,
correctly placed props, high-quality visuals, clean UI, smooth performance,
believable physics, lively streets and no obvious bugs.
`, { label: 'signoff', phase: 'Signoff' });

return { work, integrate, signoff };
