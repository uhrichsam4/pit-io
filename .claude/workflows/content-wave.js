export const meta = {
  name: 'miami-content-wave',
  description: 'Content wave: buildings, streets, props, vehicles+traffic AI, pedestrians, nature, water',
  phases: [
    { title: 'Content', detail: '7 parallel content modules, disjoint files' },
    { title: 'Integrate', detail: 'repair breakage, verify all presets render clean' },
  ],
};

const CWD = '/Users/sam/untitled folder 6';

const COMMON = `
PROJECT: ${CWD}  (cd there first; the path contains a space, so QUOTE IT)

MIAMI DEVOUR — a Hole.io-style city-eating game in Three.js r0.185, ES modules, Vite.
A Vite dev server is ALREADY RUNNING on http://localhost:5173 with HMR. Do not start another.

MANDATORY READING, in order, before you write anything:
  1. docs/ART_DIRECTION.md      <- the law
  2. docs/REVIEW_RUBRIC.md      <- how your work will be judged
  3. src/world/worldBuild.js    <- the content-module contract (ctx API)
  4. src/world/cityLayout.js    <- the layout data you consume (rich: parcels,
                                   heightClass, style, streetLife, onSpine,
                                   frontageStreets, landmarks, alleys, diagonals)
  5. src/core/materials.js      <- Textures.* generators + ground/solid/glass/
                                   painted/emissive/foliage factories
  6. src/render/palette.js      <- every colour. Use it; do not invent colours.
  7. src/world/roadNetwork.js   <- shared lane + sidewalk + traffic-light graph
  8. The files you own.

VERIFY YOUR WORK CONSTANTLY:
  cd "${CWD}" && node tools/shot.mjs --presets <names> --out shots/<your-slug> --w 1600 --h 900
  Presets: hole-small, street-level, hole-mid, hole-big, brickell-skyline,
           downtown-wide, waterfront, river, park, intersection, construction, menu-hero
  Then READ the .png files with the Read tool and LOOK AT THEM. Judge honestly
  against the rubric. Never claim a visual result you have not seen.
  shots/<dir>/report.json must have an empty 'errors' array for your files.

Do at least 5 render-look-fix cycles. Stop only when the images genuinely beat
Hole.io on the rubric, not when the code merely runs.

CRITICAL RULES:
- Edit ONLY the files under "YOU OWN". Six other agents are editing this same
  working tree right now. Touching their files destroys their work.
- If a screenshot shows a defect in a file you do not own, note it in your report
  instead of fixing it. Same for errors in report.json from other people's files.
- Never rename or remove an export another module already imports. Adding is fine.
- No new npm dependencies. No binary assets. Everything procedural.
- Performance matters: instance anything repeated, merge anything static. Report
  your module's draw-call and triangle contribution.
- Comment WHY, not WHAT, matching the existing style.

PERFORMANCE BUDGET — this is currently BLOWN and it is everyone's problem.
Measured right now on the 'menu-hero' preset (whole city visible):
  5,228 draw calls / 815k triangles.   Target: <= 1,500 draw calls / <= 1.8M tris.

The main offender is that each building is a Group of many small meshes. Rules:
  - Anything that repeats across the map MUST be one InstancedMesh, shared
    globally — not one per block, not one per building. Roof AC units, kerb
    props, parked cars, shrubs, railings, balcony slabs: all instanced.
  - Anything static and unique should be merged. A single building should cost
    at most ~3 draw calls (opaque body / glass / emissive), achieved with
    BufferGeometryUtils.mergeGeometries — NOT a Group of 40 boxes.
  - Individually-swallowable objects must stay individually addressable, so
    merge WITHIN an object, never across two objects that can be eaten
    separately.
Measure with `node tools/shot.mjs --presets menu-hero,street-level` and report
the drawCalls/triangles delta your module caused. If you push the total up,
you are not finished.

Your final message is a REPORT: what you built, counts produced, measured perf,
presets inspected, what still looks wrong, what you need from others.
`;

phase('Content');

const content = await parallel([
  /* ------------------------------------------------------------ 1. buildings */
  () => agent(`${COMMON}

YOU OWN: src/world/buildings.js

Today every building is a flat extruded box with a tiled window texture. The art
bible calls that an automatic failure. Rebuild the architecture of Brickell and
Downtown Miami properly.

Requirements:
1. TOWERS. A Brickell tower is not a box. Give it: a retail podium with a
   distinct material and a canopy, a shaft with real articulation (balcony
   slabs, vertical fins, corner glazing, a service core expressed as a
   different material), setbacks, and a CROWN — a stepped top, a sculpted cap,
   a crane-free parapet with mechanical penthouse, mast, aviation light.
   Vary plan shapes: rectangular, chamfered, elliptical, curved-face, twisted
   stacks, two towers on a shared podium.
2. ROOFS. Visible almost every frame from the 3/4 camera. Every building needs
   a populated roof: parapet, AC units, vents, ducts, water tanks, stair
   bulkheads, satellite dishes, helipads on the big ones, and pools + loungers
   on the residential towers. Use Textures.rooftop().
3. MIDRISE / RESIDENTIAL. Balcony stacks, banded floors, Deco stepping,
   pastel stucco. Look at Miami: colour is the point.
4. STOREFRONTS. A retail parcel is a ROW of individually edible shops with
   awnings, signage, display windows, roll-down doors, A-boards, and a
   distinct cornice per unit. Vary widths.
5. PARKING GARAGES. Open decks with visible ramps, parked cars inside on each
   level (instanced, cheap), spandrel panels, stair towers, a rooftop level.
6. CONSTRUCTION. Exposed slabs, a concrete core, tower crane with counterweight
   and cable, scaffolding, safety netting, hoarding, portacabins, materials
   stacked on the slabs. These are some of the most interesting silhouettes in
   the city — make them count.
7. LANDMARKS. layout.landmarks carries a name + style tag ('deco','glass',
   'civic','arena','tower'). Hand-build hero geometry for each: an arena with a
   big-span roof, a Deco tower with a stepped illuminated crown, a civic block
   with a colonnade. These anchor the skyline.
8. BEVELS. No razor 90-degree edges anywhere. Chamfer or inset.
9. VARIETY. Use block.seed for determinism, block.heightClass / block.style /
   block.zone / block.parcels to drive choices. If a parcel list exists, build
   per parcel, not per block. A skyline where everything is the same height or
   the same colour is a failure.

Each building must still register as a Consumable via ctx.addMesh with sane
radius/height/tier and crumbles:true, and must still sit exactly on ctx.Y_WALK
with no gap and no intersection into the pavement.

Also: EXPORT a list of the building root objects you create as
ctx.fadeableBuildings (an array) so the occlusion-fade system can register them.
Just push each building's root Group onto ctx.fadeableBuildings (create the
array if it does not exist).

Target 350-700 buildings. Verify with brickell-skyline, downtown-wide,
street-level, hole-big, construction, menu-hero.
`, { label: 'buildings', phase: 'Content' }),

  /* -------------------------------------------------------------- 2. streets */
  () => agent(`${COMMON}

YOU OWN: src/world/streets.js

CONFIRMED DEFECTS the project lead has already seen in screenshots — fix these
first and prove each one with a screenshot before moving on:
  (a) BLOCKER: crosswalk "stripes" render as big cream squares scattered loose
      across the carriageway, at the wrong size, spacing and orientation. Look
      at shots/lead-all/intersection.png and shots/lead-all/hole-small.png.
  (b) A thin MAGENTA/PINK line runs along block edges where the kerb meets the
      road — a stray colour or z-fight. Find it and kill it.
  (c) Sidewalks are one featureless slab per block; no kerb nose, no gutter, no
      joints, no ramps.
  (d) Lane markings are sparse and mechanical; no turn arrows, no stop bars.
  (e) BLOCKER: you own the big base ground plane, and it currently extends as a
      dark grey rectangle straight out under the bay and the marina basins —
      see shots/lead-all/waterfront.png, the grey wedges sticking into the
      water. Clip the land to the actual coastline from layout.isWater /
      layout waterPolys, so the shore silhouette is correct and no land shows
      under the sea. Coordinate with water.js via your report.

Rebuild it:
1. CROSSWALKS. Proper zebra bars, correctly aligned to each approach, sized to
   the road, inset from the stop line, with a stop bar. They must read as road
   marking, never as loose squares. This is a listed automatic failure — fix it
   first and screenshot the 'intersection' preset to prove it.
2. LANE MARKINGS. Correct per road class: centre double-yellow on boulevards,
   dashed white lane dividers, solid white edge lines, turn arrows near
   junctions, bus-lane tint, hatched medians, parking bays marked at the kerb.
   Use src/world/roadNetwork.js so markings agree with where cars actually drive.
3. SIDEWALKS. Real kerb profile with a rounded nose, a gutter channel, kerb
   ramps at every crossing, tree pits / planting strips, expansion joints, tonal
   slab variation, and wider sidewalks on blocks flagged onSpine.
4. INTERSECTIONS. Asphalt patching, manhole covers, drain grates, junction box
   lids, painted keep-clear boxes.
5. MEDIANS. Roads with r.median get a raised planted median: kerb, soil, grass,
   low hedge — leave palm placement to nature.js but DO create the median
   surface and kerb.
6. BRIDGES. layout.bridges — build actual structures: deck, parapet railings,
   piers into the river, a slight camber, and lighting standards. A bridge is
   currently a flat slab.
7. ALLEYS / DIAGONALS. layout.alleys and layout.diagonals exist as data and are
   currently unpaved gaps. Pave them: narrower, rougher, service-lane texture.
8. WEAR. Tyre polish in the wheel tracks, oil staining at junctions, patch
   repairs, faded paint. Subtle — do not make it grubby, this is a bright game.

EVERY ground-level surface you create MUST use a material from materials.ground()
or be passed through applyHoleCut, or holes will not cut through it. Verify by
screenshotting a hole on each surface type.

Watch for z-fighting: markings, patches and crosswalks are coplanar with the
road. Use small, consistent y offsets and say what scheme you used.

Verify with intersection, street-level, hole-small, downtown-wide, river.
`, { label: 'streets', phase: 'Content' }),

  /* ---------------------------------------------------------------- 3. props */
  () => agent(`${COMMON}

YOU OWN: src/world/props.js

The user has explicitly asked for a dense, alive, highly interactive city. Right
now there are only ~10 prop types and a few hundred instances. That is the single
biggest thing making the early game boring, because the early game is entirely
about eating small things.

Build a large, varied, well-modelled prop vocabulary. Required types, at minimum:
  traffic cones, trash bins (municipal + wheelie + recycling), benches (several
  designs), street signs (stop, one-way, parking, street-name, no-entry),
  mailboxes, parking meters, planters (round, square, long trough), café tables,
  café chairs, patio umbrellas, bicycles, bike racks with locked bikes,
  e-scooters (parked in rows), food carts, hot-dog stands, lamp posts (several
  designs incl. Deco twin-globe), palm-uplighters, bus stops with shelter +
  bench + timetable + advertising panel, newspaper boxes, construction barriers
  (jersey barriers, plastic water barriers, A-frame barricades), traffic
  barrels, crates and pallets, scaffolding stacks, sandbags, portaloos,
  fire hydrants, bollards (several), utility boxes, phone/charging kiosks,
  ATM kiosks, shop display racks, produce crates outside grocers, sandwich
  boards, potted palms, hanging flower baskets on lamp posts, beach-style
  loungers and parasols near the waterfront, picnic tables in parks,
  drinking fountains, dog-waste stations, bus-stop trash cans, newspaper
  vending rows, valet stands outside hotels, red-carpet stanchions and rope,
  outdoor heaters, string-light poles over café terraces.

Rules:
1. DENSITY TARGET: 9,000-16,000 prop instances across the map. Distribute with
   block.streetLife (0..1) so spines and cafés are crowded and back lots are
   sparse. Cluster believably: café furniture in groups around a storefront,
   scooters in rows, barriers in lines along a construction hoarding.
2. INSTANCING: every repeated prop must go through ctx.addInstanced. One pool
   per type. Set a realistic capacity. Report total pools and instances.
3. GEOMETRY QUALITY: bevelled, readable silhouettes, correct real-world scale
   (cone 0.7 m, bench 2 m, lamp post 7 m, bus shelter 4 m long). No razor edges.
   Small props still need to look good at 4 m from the camera.
4. GROUNDING: everything sits exactly on the sidewalk/plaza surface at
   ctx.Y_WALK. Nothing floats, nothing sinks. Use ctx.isFree / ctx.occupy so
   props do not interpenetrate each other or the buildings.
5. TIERS: assign TIER so the growth curve feels right. Litter/cones = TINY,
   bins/benches/signs = SMALL, bikes/scooters/umbrellas/carts = MEDIUM,
   lamp posts/bus shelters = MEDIUM or LARGE. Read src/config.js TIER.
6. COLOUR: from PALETTE only. Use per-instance colour (pass hex) for variety.
7. PLACEMENT CONTEXT: use block.zone. Construction blocks get barriers, crates,
   portaloos and scaffolding. Parks get picnic tables and drinking fountains.
   Waterfront gets loungers, parasols, mooring cleats. Retail gets café clusters
   and sandwich boards.

Verify with street-level, hole-small, intersection, park, construction. Zoom in:
these are the objects the player spends the first minute of every match eating,
so they have to hold up close.
`, { label: 'props', phase: 'Content' }),

  /* ------------------------------------------------- 4. vehicles + traffic AI */
  () => agent(`${COMMON}

YOU OWN: src/world/vehicles.js

The user has explicitly asked for a city that feels ACTIVE: "Cars, taxis, buses,
delivery vans, and other vehicles should drive along roads, follow lanes, stop at
intersections, and move through traffic."

Today traffic is a set of instances sliding along a fixed line, ignoring
junctions, driving through each other and through red lights. Replace it with a
real micro-traffic simulation built on src/world/roadNetwork.js, which already
gives you lanes (correct right-hand-drive offsets), junction positions along each
lane, and a non-conflicting traffic-light phase function.

1. TRAFFIC SIM. Each vehicle is (lane, s, speed). Per frame:
   - car-following: keep a safe headway from the vehicle ahead in the same lane
     (an IDM-style or simple proportional model is fine) — no interpenetration
   - traffic lights: query network.lightFor(ix, lane.axis, time); decelerate to
     stop cleanly at the stop line on amber/red, creep forward in a queue, pull
     away smoothly on green
   - turning: at a junction, sometimes turn onto a crossing kerb lane via a
     short arc; yield to cross traffic before entering
   - despawn/respawn at map edges so density stays constant
   Keep it O(n) with a per-lane sorted list, not O(n^2).
2. VEHICLE VARIETY. Sedan, SUV, hatchback, pickup, sports car, convertible,
   TAXI (with roof sign and livery), city BUS (articulated variant too),
   DELIVERY VAN, box truck, garbage truck, cement mixer, flatbed, police car,
   ambulance, airport shuttle. Distinct silhouettes, not one box recoloured.
3. GEOMETRY QUALITY. Real proportions, bevelled bodies, wheels that are visible
   and sit on the road, windows as a separate darker material, lights as small
   emissive quads, number plates, wing mirrors. They must look good from 4 m.
4. PARKED VEHICLES. Line the kerbs in marked bays, fill garage decks, angle-park
   in surface lots. These are static and should be instanced.
5. BOATS. In the marina basins and along the river: motor yachts, sailing boats
   with masts, water taxis, a small cruise vessel at the port. Some idling with
   a gentle bob, some moored. Use layout marina/water data.
6. CONSTRUCTION MACHINERY. Excavators, wheel loaders, dumpers, cement mixers,
   a tower-crane base, scissor lifts — placed on construction blocks.
7. CONSUMABLES. Every vehicle is edible at the right tier. Moving ones are
   dynamic:true and MUST call registry.rehash after moving (see the existing
   traffic updater). When one is swallowed mid-drive it must leave the sim
   cleanly without stalling the queue behind it.

Export your per-frame update through ctx.scene.userData.trafficUpdate (a function
of dt) exactly as today, so game.js keeps working. You may also set
ctx.scene.userData.trafficDebug for stats.

Density target: 1,200-2,200 vehicles, of which several hundred are moving.
Verify with intersection (watch the lights over several shots), street-level,
downtown-wide, waterfront, construction.
`, { label: 'vehicles+traffic', phase: 'Content' }),

  /* ----------------------------------------------------------- 5. pedestrians */
  () => agent(`${COMMON}

YOU OWN: src/world/pedestrians.js  (NEW FILE — create it)

The user has explicitly asked for pedestrians: "Pedestrians should walk along
sidewalks, cross streets, gather near cafés and parks, and move naturally through
the city. Include a mix of residents, tourists, office workers, and cyclists."

Build a crowd system from scratch on top of src/world/roadNetwork.js, which gives
you per-block sidewalk loops (dense waypoints), crossings at every junction, and
the traffic-light phase function.

1. MODULE SHAPE. Export `buildPedestrians(ctx)` following the same contract as
   the other world modules (see worldBuild.js). Register your per-frame update as
   ctx.scene.userData.pedestrianUpdate = (dt) => {...}. Do NOT edit worldBuild.js
   — the orchestrator will be wired up separately; just export the function with
   exactly the name `buildPedestrians`.
2. CHARACTERS. Low-poly but well-proportioned humans, ~1.75 m: head, torso,
   arms, legs. Several body types. Distinct outfits by archetype:
     office worker (shirt/blazer, bag), tourist (shorts, camera, backpack,
     sun hat), resident (casual), jogger (sportswear), server (apron),
     construction worker (hi-vis + hard hat), cyclist (on a bike), dog walker
     (with a small dog), skateboarder.
   Use per-instance colour for skin, hair, top and bottom so a handful of
   geometries produce hundreds of visibly different people.
3. ANIMATION. They must not slide. A convincing cheap walk cycle: alternating
   leg swing, counter-swinging arms, slight torso bob and lean, all driven by a
   per-agent phase advanced by actual distance travelled. Implement it by
   writing per-part instance matrices (one InstancedMesh per body part, agents
   share an index) — this keeps it to a handful of draw calls for hundreds of
   pedestrians. Idle agents (café, park) get a standing/chatting variant.
4. BEHAVIOUR.
   - walk the sidewalk loops, with local avoidance so they do not overlap
   - at a corner, sometimes take a crossing: WAIT at the kerb for the light,
     then cross in the marked crosswalk, then join the next block's loop
   - gather: clusters standing near café furniture, benches, park lawns, and
     the waterfront promenade; some sitting
   - cyclists ride in the kerb lane and stop at lights
   - density from block.streetLife, so spines are busy and back lots are quiet
5. CONSUMABLES. Pedestrians ARE edible (TIER.SMALL or MEDIUM). This is a
   cartoon game — they should tumble in comically, not gorily. No blood, no
   ragdoll horror: they wave their arms and drop. Keep it playful.
   When one is swallowed it must leave the crowd sim cleanly.
6. PERFORMANCE. Target 500-1,200 pedestrians at under 20 draw calls and under
   1.5 ms/frame. Only simulate detailed animation near the camera; distant
   agents can update at a lower rate. Report your measured cost.

Verify with street-level, intersection, park, hole-small, waterfront. Take
several shots a second apart and confirm the crowd actually moves and that legs
are stepping rather than sliding.
`, { label: 'pedestrians', phase: 'Content' }),

  /* --------------------------------------------------------------- 6. nature */
  () => agent(`${COMMON}

YOU OWN: src/world/nature.js

Parks and planting currently amount to a green plane plus crude palm cards.

1. PALMS. Miami's signature. Several species: tall royal palms with a smooth
   grey trunk and a green crownshaft, shorter fan palms, coconut palms with
   fruit, thin sabals. Real curved trunks with texture rings, fronds as
   properly shaped alpha cards arranged in a believable crown with droop,
   and a gentle wind sway (a vertex-shader sway is ideal — cheap and alive).
   Palms line the boulevards, fill medians, and cluster in parks.
2. SHADE TREES. Banyan-like broadleaf canopies, flowering trees (pink/magenta
   bougainvillea, yellow tabebuia), hedges, shrub masses, ornamental grasses.
3. PARKS. Not a flat lawn: mown grass with mowing stripes, path networks in
   a contrasting paving, flower beds, hedge borders, low retaining walls,
   playgrounds, basketball/tennis courts with markings, a bandshell,
   amphitheatre steps, public art, a pond with a fountain.
4. PLAZAS. Patterned paving (use Textures.paving with different cell counts),
   raised planters, water features, seating steps, shade structures, flag
   poles, sculpture.
5. FOUNTAINS. Real geometry plus animated water: jets, a rippling basin
   surface, spray particles if cheap. These are landmarks at street level.
6. WATERFRONT PLANTING. Sea grapes, mangroves at the water's edge, palms along
   the promenade, planted terraces.
7. GROUND COVER. Where a block is park or plaza you own the surface. Make sure
   it uses materials.ground() so holes cut through it.

Palms and trees are Consumables (TIER.LARGE for palms). Hedges and flower beds
should be edible too at a smaller tier. Target 1,500-3,000 trees/palms total.

Instance aggressively — a park full of individually-meshed shrubs will blow the
draw-call budget. Report counts and cost.

Verify with park, street-level, brickell-skyline, waterfront, hole-mid.
`, { label: 'nature', phase: 'Content' }),

  /* ---------------------------------------------------------------- 7. water */
  () => agent(`${COMMON}

YOU OWN: src/world/water.js

Biscayne Bay and the Miami River are the backdrop to half the map and currently
they are a single flat animated plane with a straight edge.

CONFIRMED DEFECTS the project lead has seen — open shots/lead-all/waterfront.png
and shots/lead-all/river.png before you start:
  (a) BLOCKER: the bay reads as flat uniform cyan speckled with random white
      blobs. It looks like scum on a swimming pool, not water. The foam/sparkle
      term is far too strong and uniform, and there is no depth gradient.
  (b) BLOCKER: dark grey wedges of the LAND base plane jut out into the bay at
      the coastline, and the marina basins that cityLayout cut into the shore
      render as dark grey land rather than water. The coastline silhouette is
      wrong. Coordinate with streets.js (it owns the base ground plane) — if
      the fix belongs there, say so in your report, but make the water side
      correct regardless.
  (c) No seawall detail, no promenade edge, no visible boats or docks.

1. WATER SHADER. Keep it stylised and bright but make it genuinely good:
   depth-graded colour (turquoise shallows to deep cyan), animated normals from
   several octaves of wave, sun specular, fresnel sky reflection, a real
   screen-space or planar reflection of the skyline if you can afford it (the
   Brickell towers reflecting in the bay is the money shot), refraction hint,
   caustic sparkle, and foam.
2. SHORELINE. Foam that follows the ACTUAL coast, including the marina basins
   and Brickell Key cut into the land by cityLayout (layout.isWater and any
   waterPolys/marina data). A straight foam line down a curved shore is a
   giveaway. Same for the river: it bends (riverCenterAt / riverHalfAt).
3. SEAWALL + PROMENADE EDGE. Proper seawall with coping, tide staining,
   mooring bollards, ladders, fenders, steps down to the water.
4. MARINA. Floating pontoons and finger docks with decking, piles, cleats,
   fuel dock, gangways. Boats are vehicles.js's job — build the infrastructure
   they sit in and make sure the basins actually hold water.
5. RIVER. Bulkheads on both banks, a riverwalk edge, and bridge piers meeting
   the water believably (streets.js builds the bridges — leave those alone, but
   make the water read correctly around them).
6. WAKES + LIFE. Gentle wake trails behind moving boats if cheap, drifting
   sparkle, occasional gull. Keep it subtle.
7. UNDERWATER / EDGE CASES. From the 3/4 camera you sometimes see the water
   edge against the seawall — no gap, no z-fighting, no visible plane edge.
   The bay must extend far enough that it never ends on screen.

Keep the exported function name buildWater(ctx) and keep publishing your time
uniform as ctx.scene.userData.waterUniforms.uTime (game.js drives it), or if you
change that, ALSO keep the old key working.

Verify with waterfront, river, menu-hero, brickell-skyline, hole-big.
`, { label: 'water', phase: 'Content' }),
]);

phase('Integrate');

const integration = await agent(`${COMMON}

YOU OWN: any file, but ONLY to repair integration breakage and to wire modules in.
Do not do aesthetic work — that is other agents' job.

Seven agents just finished editing in parallel:
  buildings.js, streets.js, props.js, vehicles.js, pedestrians.js (new),
  nature.js, water.js

Their reports:
${content.map((r, i) => `--- agent ${i + 1} ---\n${(r || 'FAILED — no report').slice(0, 2600)}`).join('\n\n')}

YOUR JOB, in order:
1. WIRE UP PEDESTRIANS. src/world/pedestrians.js exports buildPedestrians(ctx)
   but nothing calls it. Add it to the MODULES list in src/world/worldBuild.js
   (import it, add ['pedestrians', buildPedestrians]). Then make src/game.js call
   scene.userData.pedestrianUpdate(dt) each frame exactly where it already calls
   trafficUpdate(dt).
2. Run: node tools/shot.mjs --all --out shots/content-check --w 1600 --h 900
3. Read shots/content-check/report.json. Drive 'errors' to EMPTY. Fix every
   runtime error regardless of which file it is in.
4. Read EVERY png. Fix outright breakage only: missing ground, black screens,
   geometry at the wrong scale, objects floating or buried, holes not cutting
   through a surface, z-fighting, exceptions, a module that silently produced
   nothing.
5. Check the budget: report total draw calls and triangles per preset. If draw
   calls exceed ~600 or the city takes more than ~4 s to build, find the worst
   offender and say which module owns it (do not rewrite their art — report it).
6. Re-run until --all is clean.

Report: final per-preset stats, the (empty) error list, and a prioritised,
deduplicated list of the biggest remaining VISUAL problems with the owning file
for each — this feeds directly into the critic wave.
`, { label: 'content-integration', phase: 'Integrate' });

return { content, integration };
