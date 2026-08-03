export const meta = {
  name: 'miami-living-city',
  description: 'Living city + visual upgrade: day/night cycle, shadows, vehicle & pedestrian life, café/nightlife dressing, richer materials',
  phases: [
    { title: 'Contract', detail: 'establish the day/night contract every module hooks into' },
    { title: 'Build', detail: '7 parallel modules: vehicles, pedestrians, props, materials, buildings, nature, streets' },
    { title: 'Verify', detail: 'stability + physics + visual sweep at every hole size' },
  ],
};

const CWD = '/Users/sam/untitled folder 6';

const COMMON = `
PROJECT: ${CWD}  (cd there first; the path has a space, so QUOTE IT)
MIAMI DEVOUR — a Hole.io-style city-eating game in Three.js r0.185.
A Vite dev server is already running on http://localhost:5173.

READ FIRST: docs/ART_DIRECTION.md, docs/REVIEW_RUBRIC.md, src/world/worldBuild.js
(the content-module contract), src/render/palette.js, src/core/materials.js.

=== THE GAMEPLAY CONTRACT — EVERYTHING YOU ADD MUST RESPECT IT ===

Consumption is PURELY GEOMETRIC now. There is no size class.
  · worldBuild MEASURES each object's ground-contact footprint from its
    geometry and sets radius / height / passRadius itself. The values you pass
    to ctx.addInstanced / ctx.addMesh are IGNORED unless you pass
    exactSize: true. So you fix physics by fixing GEOMETRY, never by tweaking
    a number.
  · An object reacts when a hole takes enough ground from under it AND the
    opening is big enough relative to that object (50% of what would swallow
    it for light props, up to 85% for a tower).
  · It topples about the last edge of ground still under it, under real
    gravity, and passes through when the opening exceeds its passRadius — the
    NARROW way through, not its footprint.
  · The object that falls is the placed instance itself. Nothing is spawned to
    stand in for it. Do not add any code that hides an object and spawns a copy.

So anything you add MUST:
  · sit exactly on the surface under it (road y=0, sidewalk y=ctx.Y_WALK, plaza,
    park, bridge deck, garage floor all differ — use the right one),
  · not intersect other props, buildings, kerbs or the carriageway,
  · not block a path the player or the bots need,
  · have geometry whose lowest 20% is the part that actually rests on the
    ground, because that is what the physics measures,
  · go through ctx.addInstanced (repeated) or ctx.addMesh (unique). Never add
    raw meshes to the scene for anything that should be edible.
Use ctx.occupy / ctx.isFree to claim ground so modules do not stack on
each other.

=== THE DAY/NIGHT CONTRACT ===

src/core/engine.js owns the cycle and publishes, every frame:
    scene.userData.timeOfDay    0..1   (0 = midnight, 0.5 = noon)
    scene.userData.nightFactor  0..1   (0 = full day, 1 = full night)
    scene.userData.sunDir       THREE.Vector3
Content modules read nightFactor to drive their own emissive intensity —
lit windows, streetlights, headlights, signage, neon. Read it in your
per-frame update (the one you register on scene.userData.*Update); do NOT
re-implement the cycle.

=== TOOLS ===
  node tools/prop-audit.mjs        # size + placement audit (cheap, no screenshots)
  node tools/consume-test.mjs      # physics regression — MUST keep passing
  node tools/shot.mjs --presets a,b --out shots/<slug> --w 1600 --h 900
  node tools/seq.mjs --size 7 --frames 6 --out shots/<slug>
Then READ the PNGs with the Read tool. Never claim a visual result you have
not seen.

THE MACHINE IS SHARED. Run ONE headless tool at a time. Prefer prop-audit
(cheap) over full screenshot sweeps. If a screenshot times out, do not retry in
a loop — reduce the resolution or wait.

RULES
- Edit ONLY the files under "YOU OWN". Six other agents are editing this tree.
- Never rename or remove an export another module imports. Adding is fine.
- No new npm dependencies. No binary assets. Everything procedural.
- Budget: <= 1,500 draw calls, <= 2.2M triangles on menu-hero. Report yours.
- ANTI-REPETITION is a stated goal. Vary scale, rotation, colour, shape and
  placement. A row of identical assets is a defect.
- Comment WHY, not WHAT.

Your final message is a REPORT: what you built, counts, measured perf, presets
inspected, what still looks wrong, what you need from others.
`;

/* ------------------------------------------------------------------------- */

phase('Contract');

const lighting = await agent(`${COMMON}

YOU OWN:
  src/core/engine.js
  src/core/quality.js
  src/render/postfx.js

ROLE: the day/night cycle, the shadow system, and the night lighting model.
You go FIRST because every other module hooks into the contract you publish.

1. PUBLISH THE CONTRACT IMMEDIATELY, before anything else, so the other six
   agents can build against it:
       scene.userData.timeOfDay    0..1
       scene.userData.nightFactor  0..1
       scene.userData.sunDir       THREE.Vector3
   Also expose engine.setTimeOfDay(t) and engine.dayLengthSeconds so the game
   and the dev harness can drive it. Default: a full cycle over ~4 real
   minutes, starting at bright afternoon.

2. THE CYCLE. A smooth, continuous transition through bright Miami day →
   golden hour → sunset → dusk → night → sunrise → day. Everything must
   interpolate: sun position and colour, sky gradient, horizon haze, fog
   colour and density, ambient/hemisphere/bounce, exposure, and the grade's
   temperature and split-tone. No stepping, no popping, no banding.
     day      warm high sun, blue sky, crisp shadows
     sunset   low orange/pink key, long shadows, warm haze, saturated sky
     night    cool low ambient, moon as a soft key, deep blue sky
   THE GAME MUST STAY PLAYABLE AND BRIGHT AT NIGHT. This is a colourful,
   readable arcade game, not a horror game. Night should read as *night* by
   hue and by the city lighting up, NOT by being dark enough to hide the
   playfield. Keep a floor on ambient so the ground, props and the hole are
   always clearly readable. State the luminance floor you chose.

3. SHADOWS. High quality and stable: buildings, vehicles, trees, props,
   pedestrians and the hole's own contact shadow. Soft, correctly oriented to
   the sun (and to the moon at night), softening with distance, updating as
   objects and the sun move. No acne, no peter-panning, no visible cascade
   seam, no shadow swimming as the camera moves. They must GROUND objects —
   the most common failure is a prop that looks like a sticker on the pavement.
   Tune the shadow frustum to the camera distance, which swings from 40 m to
   340 m as the hole grows.

4. NIGHT ILLUMINATION SUPPORT. You provide the framework; content modules
   provide the emissive geometry. Make sure bloom, exposure and the grade make
   emissive light read well at night without smearing. Consider a cheap
   light-bloom pass rather than hundreds of real point lights — the budget will
   not take real lights per streetlamp.

5. PERFORMANCE. Report draw calls, triangles and frame cost at day and at
   night. Do not let the cycle cost more than a fraction of a millisecond.

DO NOT change the Engine surface game.js relies on: .scene .camera .renderer
.sun .sunDir .hemi ._camTarget ._dist .updateCamera() .render() .flash()
.resize() ._setShadowExtent().

Verify at several times of day with:
  node tools/shot.mjs --presets brickell-skyline,street-level,hole-mid --out shots/tod-<n>
  --script "__GAME__.engine.setTimeOfDay(0.5)"   (and 0.75, 0.85, 0.0, 0.25)
Read every image.
`, { label: 'day-night+shadows', phase: 'Contract' });

/* ------------------------------------------------------------------------- */

phase('Build');

const built = await parallel([
  () => agent(`${COMMON}

The day/night agent has published the contract. Its report:
${(lighting || 'FAILED — build against scene.userData.nightFactor anyway').slice(0, 2500)}

YOU OWN: src/world/vehicles.js

ROLE: every vehicle in Miami, how it looks and how it drives.

1. MODEL QUALITY. Cars currently read as repeated game pieces. Rebuild them
   with real proportions and detail: distinct body shapes, a proper greenhouse
   (windscreen/side glass/rear) as a separate darker material, wheels with
   visible rims and tyres that sit correctly on the road, headlights and tail
   lights as small emissive quads, indicators, grille, bumpers, wing mirrors,
   number plates, and a hint of interior where the glass is transparent.
   Bevel everything — no razor box edges.
2. VARIETY, MIAMI FLAVOUR. Sedans, SUVs, hatchbacks, pickups, convertibles,
   TAXIS with roof signs and livery, city buses, articulated buses, DELIVERY
   VANS with signage, box trucks, garbage trucks, cement mixers, flatbeds,
   police, ambulance, airport shuttles, MOTORCYCLES, SCOOTERS, and — this is
   Miami — LUXURY AND EXOTIC CARS: low supercars, convertibles with the roof
   down, sports coupes. Make the exotics genuinely distinct and polished:
   low, wide, sculpted, with high-gloss and metallic paint finishes.
   Wide colour range, including pastels and Miami brights.
3. TRAFFIC BEHAVIOUR. Build on src/world/roadNetwork.js (lanes with correct
   right-hand offsets, junctions, non-conflicting signal phases). Vehicles must
   follow lanes, keep a safe headway, stop cleanly at red and pull away on
   green, queue at junctions, TURN onto crossing lanes, park and pull out,
   taxis stop at the kerb to pick up and drop off, delivery vans double-park
   briefly with hazards. Add occasional energetic Miami driving — a quicker
   getaway, a lane change — WITHOUT constant collisions. No interpenetration,
   no gridlock, no cars driving through each other or through the kerb.
4. THE PHYSICS CONTRACT. Traffic must yield to the consume system at
   state >= 1 (a vehicle losing ground support stops being driven — this is
   already in the file, keep it). A vehicle destabilised and then released must
   rejoin traffic cleanly. A consumed vehicle must leave the sim without
   stalling the queue behind it. Verify with tools/consume-test.mjs.
5. BOATS AND WATERFRONT. More life on Biscayne Bay: motor yachts, sailing
   boats, water taxis, jet skis, a small cruise vessel, boats moving slowly
   with wakes, moored boats bobbing.
6. PERFORMANCE. Everything instanced. Report vehicle counts, draw calls and
   triangles before/after. LOD distant vehicles if you need the budget.
7. NIGHT. Headlights and tail lights must come on with nightFactor, and the
   headlight cones should read on the road without needing real lights.

Verify with intersection, street-level, crowd, waterfront, hole-mid, plus
consume-test and prop-audit.
`, { label: 'vehicles', phase: 'Build' }),

  () => agent(`${COMMON}

The day/night agent has published the contract. Its report:
${(lighting || 'FAILED — build against scene.userData.nightFactor anyway').slice(0, 2500)}

YOU OWN: src/world/pedestrians.js

ROLE: the people of Miami and what they are doing.

1. A KNOWN BUG, FIX IT FIRST. When a pedestrian is consumed the agent is killed
   at state >= 2, so the person vanishes instantly instead of falling into the
   hole. Every other prop visibly tips and falls. Make a consumed pedestrian
   animate its fall like everything else — the simplest correct approach is to
   stop driving it once state >= 1 and let the consume system own its
   transform, the way vehicles.js does. Verify by watching a seq capture.
2. BEHAVIOURS, not just walkers. Commuters striding, tourists ambling and
   stopping to look up, office workers with coffee and lanyards, joggers,
   cyclists, families with children, people walking dogs, people looking at
   phones while walking, groups standing and talking, people sitting on
   benches and on steps, buskers.
3. CAFE AND RESTAURANT LIFE. People seated at outdoor tables eating and
   talking, waiters moving between tables and the door, customers queueing,
   people entering and leaving. Cluster them around the café furniture that
   props.js places — coordinate through your report if you need it placed
   differently.
4. NIGHTLIFE. Queues outside venues, doormen, groups arriving, valet
   attendants, people milling on busy sidewalks. Denser at night — read
   nightFactor to shift the crowd mix and density over the cycle.
5. CONTENT CREATORS — the user asked for these specifically. Small filming
   setups on sidewalks, outside restaurants, in parks and at the waterfront:
   a person to camera with a phone or camera on a TRIPOD, RING LIGHTS,
   a boom MICROPHONE, a two or three person crew, people posing for photos,
   someone holding a reflector. Put them where a real creator would film —
   good backdrops, the promenade, in front of landmarks.
6. ANIMATION QUALITY. No sliding feet: the walk cycle must be driven by
   distance travelled. Idle, standing-and-talking, sitting, and filming
   variants. Arms should swing counter to legs; add a little torso bob.
7. PERFORMANCE. Target 800-1,600 people at under ~20 draw calls, under
   1.5 ms/frame. Animate detail near the camera and update distant agents at a
   lower rate. Report measured cost.

Verify with crowd, street-level, park, waterfront, and a seq capture proving a
pedestrian visibly falls in rather than vanishing.
`, { label: 'pedestrians', phase: 'Build' }),

  () => agent(`${COMMON}

The day/night agent has published the contract. Its report:
${(lighting || 'FAILED — build against scene.userData.nightFactor anyway').slice(0, 2500)}

YOU OWN: src/world/props.js

ROLE: the dressing that makes a street look inhabited.

1. RESTAURANT AND CAFE AREAS. Full outdoor dining sets: tables with cloths,
   chairs of several designs, parasols and awnings, MENU BOARDS and A-boards,
   food displays and pastry cases, drinks on tables, planters and rope
   dividers marking the terrace edge, heat lamps, string lights overhead,
   ice buckets, service stations. Cluster them properly outside the storefront
   they belong to rather than scattering.
2. NIGHTLIFE AND HOTELS. Rooftop lounge furniture, hotel entrance canopies,
   VALET stands and key boards, stanchions and rope for queues, red carpet,
   bar setups, DJ booths on roofs, neon and lightbox signage, cigarette bins,
   bouncer podiums.
3. STOREFRONT DRESSING. Display racks, produce crates outside grocers, clothes
   rails, sandwich boards, window signage, roll-down shutters, delivery
   pallets, bicycle racks with locked bikes.
4. CURBSIDE AND CITY CLUTTER. Bins of several types, benches, planters,
   parking meters, mailboxes, newspaper boxes, utility boxes, phone/charging
   kiosks, fire hydrants, bollards, tree grates, drain covers, traffic cones
   and barriers, scaffolding, portaloos, skips, sandbags.
5. ANTI-REPETITION. This is called out explicitly by the user. Vary scale,
   rotation, colour and model within every type. Two identical benches next to
   each other at the same angle is the defect to eliminate.
6. NIGHT. Signage, menu boards, kiosks and string lights must light up with
   nightFactor.
7. PLACEMENT DISCIPLINE. Everything grounded exactly, nothing overlapping,
   nothing blocking a pavement the player or a pedestrian needs to use.
   Run tools/prop-audit.mjs and drive your kinds' float/sunk/water counts to
   zero and the overlap count down. Report before/after.

Target 12,000-20,000 prop instances. Verify with street-level, crowd,
intersection, park, construction, and prop-audit.
`, { label: 'props-dressing', phase: 'Build' }),

  () => agent(`${COMMON}

The day/night agent has published the contract. Its report:
${(lighting || 'FAILED — build against scene.userData.nightFactor anyway').slice(0, 2500)}

YOU OWN: src/core/materials.js, src/render/palette.js

ROLE: every surface in the city.

The user's complaint is that roads, sidewalks, grass, concrete and water look
flat and repetitive. Fix that at source.

1. KILL VISIBLE TILING. Larger canvases where it pays, multi-octave noise,
   and detail that does not announce a repeat period. Where a surface covers
   a huge area (roads, pavement, grass, water), consider a second detail layer
   at a different scale, or hash-based per-tile variation, so the eye cannot
   lock onto the repeat.
2. RICHER GROUND. Asphalt with aggregate, tar seams, patch repairs, oil
   staining, tyre polish in the wheel tracks, faded paint. Sidewalk with slab
   joints, tonal variation per slab, worn corners, staining at kerbs, tree pit
   grates. Grass with mowing stripes, wear paths, colour variation. Concrete
   with form marks and pour lines. Sand and waterfront decking.
3. BUILDINGS. Sharper curtain-wall glass with a believable mullion grid,
   per-pane tonal variation, sky-gradient reflection, spandrel bands and lit
   interiors that respond to night. Stucco with punched windows and balconies.
   Storefront with awning, signage band and display glass. Rooftop with
   gravel, seams and patches. Brick, timber decking, painted metal.
4. MATCHED MAPS. Colour + roughness + a normal derived from a height field for
   everything the camera gets close to. Roughness is where most of the realism
   lives — oil glossy, sealant glossy, tyre paths polished, dry concrete matte.
5. NIGHT. Provide what the content modules need to light up: emissive window
   variants, neon, and an environment map that changes with the cycle. If you
   change buildEnvironment, keep its signature.
6. KEEP EVERY EXISTING EXPORT WORKING. buildings/streets/props/nature/vehicles
   all call Textures.* and ground/solid/glass/painted/emissive/foliage.
   Adding is fine; removing or renaming breaks five modules.
7. BUDGET. Texture generation runs at boot and must stay under ~800 ms total.
   Report the measured figure.

Verify with street-level, intersection, brickell-skyline, park, waterfront.
`, { label: 'materials', phase: 'Build' }),

  () => agent(`${COMMON}

The day/night agent has published the contract. Its report:
${(lighting || 'FAILED — build against scene.userData.nightFactor anyway').slice(0, 2500)}

YOU OWN: src/world/buildings.js

ROLE: the architecture, and making Brickell and Downtown stop looking like
repeated assets.

1. ANTI-REPETITION IS THE HEADLINE. Vary massing, plan shape, height, width,
   crown, podium, colour and facade treatment so no two neighbours read as the
   same asset recoloured. Use the layout's per-block seed for determinism.
2. FACADE QUALITY. Clearer glass and window detail, balcony stacks, vertical
   fins, expressed cores, string courses, cornices, setbacks with planted
   terraces. Miami colour: pastel stucco, Deco banding, coral and cream and
   mint alongside the teal glass.
3. ROOFTOPS. On screen almost every frame from this camera. Parapets, AC
   plant, ducts, water tanks, stair bulkheads, dishes, helipads, and on the
   residential towers POOLS, loungers, parasols, rooftop bars and pergolas —
   which also feeds the nightlife the user asked for.
4. SIGNAGE. Building names, hotel signage, rooftop neon, illuminated crowns,
   storefront fascias. All of it should light with nightFactor — an unlit
   Miami skyline at night is the thing to avoid.
5. GROUND FLOOR. This is what the player actually drives past: deep shopfronts
   with real glazing, entrance canopies, lobby interiors hinted behind glass,
   awnings, address numbers, planters at the base.
6. THE PHYSICS CONTRACT. Buildings are sized from measured geometry now.
   Anything sprawling outside its own parcel (a crane jib, a canopy) inflates
   that measurement and makes the building react to holes it should not.
   Keep geometry inside its lot, base flush to ctx.Y_WALK.
7. BUDGET. Merge each building down to as few meshes as possible. Report draw
   calls and triangles.

Verify with brickell-skyline, downtown-wide, rooftops, street-level,
construction, and at night via the day/night contract.
`, { label: 'buildings', phase: 'Build' }),

  () => agent(`${COMMON}

The day/night agent has published the contract. Its report:
${(lighting || 'FAILED — build against scene.userData.nightFactor anyway').slice(0, 2500)}

YOU OWN: src/world/nature.js

ROLE: planting, parks and public space.

1. PALMS MUST STOP LOOKING REPEATED — called out explicitly. Vary species,
   trunk height, trunk lean and curve, crown size, frond count, frond droop,
   green hue and saturation, and per-instance rotation. A boulevard of
   identical palms at identical heights is the defect.
2. MORE PLANTING VARIETY. Royal palms, coconut palms, sabals, fan palms,
   sea grapes, banyans, live oaks, flowering trees (bougainvillea, tabebuia),
   hedges, shrub masses, ornamental grasses, flower beds, groundcover.
3. CAMERA DISCIPLINE — the user reports foliage blocking the player. Trees
   near the player must not obscure the hole for long. The occlusion system
   (src/render/occlusion.js) fades buildings; trees are not registered with it.
   Either register tall foliage as fadeable via ctx.fadeableBuildings, or keep
   crowns clear of the camera corridor. Say which you chose and prove it with
   a screenshot of the hole under a street tree.
4. PARKS AND PLAZAS. Mown grass with stripes, path networks, flower beds,
   hedge borders, low walls, playgrounds, courts with markings, bandshells,
   amphitheatre steps, public art, ponds with fountains, picnic areas.
5. WATERFRONT PLANTING. Sea grapes, mangroves at the water's edge, palms along
   the promenade, planted terraces.
6. NIGHT. Uplighting on palms and feature trees, lit fountains, park path
   lighting — driven by nightFactor.
7. THE PHYSICS CONTRACT. A tree's footprint is measured from its TRUNK (the
   lowest fifth of its geometry), which is correct — make sure trunk geometry
   actually sits where the visual trunk is, and that crowns do not dip into
   that band.

Verify with park, street-level, brickell-skyline, waterfront, and prop-audit.
`, { label: 'nature', phase: 'Build' }),

  () => agent(`${COMMON}

The day/night agent has published the contract. Its report:
${(lighting || 'FAILED — build against scene.userData.nightFactor anyway').slice(0, 2500)}

YOU OWN: src/world/streets.js

ROLE: the ground plane the player spends the whole match looking at.

1. ROAD MARKING DEPTH. Lane lines with correct dash rhythm per road class,
   double-yellow centres, turn arrows, stop bars, box junctions, bus lane
   tint, cycle lanes, hatched medians, give-way triangles, speed markings,
   and disabled/loading bay symbols. Worn and faded in the wheel tracks.
2. PARKING DETAIL — asked for explicitly. Marked kerbside bays, angled bays in
   surface lots, numbered spaces, painted kerbs (loading zones), meters
   coordinated with props.js, ramps and thresholds into garages.
3. KERBS AND PAVEMENT. A real kerb profile with a rounded nose, gutter
   channel, kerb ramps at every crossing, expansion joints, slab variation,
   tree pits, drain grates, manhole covers, utility box lids, service covers,
   pavement seams and patch repairs.
4. WATERFRONT EDGE. Promenade paving, seawall coping, steps down to the water,
   mooring cleats, railings, boardwalk decking.
5. ANTI-REPETITION. The sidewalk repeat period must not be visible. Coordinate
   with the materials agent — if the texture repeats every 3 m, say so in your
   report rather than fighting it in geometry.
6. NIGHT. Wet-look sheen under streetlights if cheap, and make sure markings
   stay readable at night.
7. HOLE-CUT DISCIPLINE. EVERY ground-level surface you create must use
   materials.ground() or be passed through applyHoleCut, or the hole will not
   cut through it. Verify by screenshotting a hole on each surface type you
   add — road, pavement, plaza, parking bay, promenade.

Verify with intersection, street-level, hole-small, waterfront, downtown-wide.
`, { label: 'streets', phase: 'Build' }),
]);

/* ------------------------------------------------------------------------- */

phase('Verify');

const verify = await agent(`${COMMON}

YOU OWN: any file, but ONLY to repair breakage or finish an unfinished fix.
No new features.

Seven agents just rebuilt the city in parallel. Their reports:
${built.map((r, i) => `--- agent ${i + 1} ---\n${(r || 'FAILED — no report').slice(0, 2200)}`).join('\n\n')}

DO, in order, and paste real output for each:

1. PHYSICS REGRESSION — the highest priority.
   node tools/consume-test.mjs
   Every property must hold:
     · bridging: a hole too small must move a large object by EXACTLY 0
     · progressive support loss with continuous tilt
     · visible toppling: bench and car peak tilt in the tens of degrees
     · no duplicate: slot scale 0 after removal, gone from the registry
     · respawn after the delay
   If a content agent's new geometry broke any of these, fix the geometry.

2. SIZE + PLACEMENT AUDIT.
   node tools/prop-audit.mjs
   Report kinds flagged, overlapping pairs, floating, sunken, in-water.
   Anything that got worse than the last run is a regression — find the cause.

3. EVERY HOLE SIZE — the user asked for this explicitly.
   Test the map at r = 2 (start), 5, 10, 20, 40 and near max. For each:
     · does the player always have something edible nearby?
     · do objects react only when they should?
     · is the hole ever hidden by scenery (buildings OR trees)?
     · is movement smooth, and the frame budget met?
   Use DEV.setSize / DEV.teleport and stepSimulation. Report a table.

4. FULL VISUAL SWEEP AT DAY AND NIGHT.
   node tools/shot.mjs --all --out shots/city-day --w 1600 --h 900
   node tools/shot.mjs --all --out shots/city-night --w 1600 --h 900 --script "__GAME__.engine.setTimeOfDay(0.9)"
   'errors' must be EMPTY in both. Read every image. Fix outright breakage
   only: black screens, missing ground, geometry at the wrong scale, floating
   or buried objects, holes not cutting a surface, z-fighting, exceptions.
   Confirm the city is still bright and readable at night.

5. MULTIPLAYER still passes: npm run server & then node tools/net-test.mjs

6. Report per-preset draw calls and triangles against the budget
   (<= 1,500 calls, <= 2.2M tris).

Be honest about what is still wrong. A clean report that hides a defect is
worse than a messy one that names it.
`, { label: 'stability-verify', phase: 'Verify' });

return { lighting, built, verify };
