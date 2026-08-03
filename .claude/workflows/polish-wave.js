export const meta = {
  name: 'miami-polish-wave',
  description: 'Placement + density polish: fix floating/overlapping/misplaced props, verify every prop is reachable and fair',
  phases: [
    { title: 'Polish', detail: 'per-module placement and density passes, in parallel' },
    { title: 'Verify', detail: 're-audit, re-test physics, confirm nothing regressed' },
  ],
};

const CWD = '/Users/sam/untitled folder 6';

const COMMON = `
PROJECT: ${CWD}  (cd there first; the path has a space, so QUOTE IT)
MIAMI DEVOUR — a Hole.io-style city-eating game in Three.js.
A Vite dev server is already running on http://localhost:5173.

WHAT JUST CHANGED — read this before you touch anything.

1. PROP SIZE IS NO LONGER HAND-DECLARED. src/world/worldBuild.js now MEASURES
   each prop's ground-contact footprint from its geometry and overrides the
   radius/height/passRadius you pass to ctx.addInstanced / ctx.addMesh. An
   audit found the hand-declared numbers systematically wrong (a city bus
   declaring 3.2 m against a true 5.98 m). So:
     - Do NOT try to fix physics behaviour by tweaking the radius you pass. It
       is ignored. Fix the GEOMETRY, and the physics follows.
     - If a prop genuinely needs a hand-set size, pass exactSize: true and say
       why in a comment.

2. CONSUMPTION IS PURELY GEOMETRIC. There is no tier gate any more. An object
   is destabilised by ANY hole that takes ground from under it, and passes
   through when the opening exceeds its passRadius (the narrow way through).
   Objects topple about the edge of remaining support under real gravity.

YOUR JOB IS PLACEMENT AND DENSITY, NOT SIZE OR PHYSICS.

TOOLS:
  node tools/prop-audit.mjs            # size + placement audit, writes shots/prop-audit.json
  node tools/prop-audit.mjs --kind X   # drill into one kind
  node tools/consume-test.mjs          # physics regression — must keep passing
  node tools/shot.mjs --presets a,b --out shots/<slug> --w 1600 --h 900
Then READ the PNGs with the Read tool. Never claim a visual result you have not seen.

IMPORTANT: the machine is shared. Run ONE headless tool at a time, and prefer
tools/prop-audit.mjs (cheap, no screenshots) over full screenshot sweeps.

CURRENT AUDIT (shots/prop-audit.json has the full data):
  23,814 props across 129 kinds
  1,868 overlapping pairs
  20 kinds still flagged, mostly for placement rather than size

KNOWN PLACEMENT PROBLEMS — confirm each yourself before acting, the audit's
ground test does not know local surface height (road 0.0, sidewalk ~0.155,
plaza, bridge decks all differ), so some flags are false positives:
  · bollard        40/40 sampled flagged floating, 8 in water
  · hangBasket     40/40 flagged floating — these HANG from lamp posts, so this
                   is expected; confirm and ignore
  · pedestrian     4 floating
  · suv/pickup/taxi/hatchback/cityBus/deliveryVan/police  1-4 floating each
  · storefront     15 flagged in water
  · 1,868 overlapping prop pairs across the map

RULES:
- Edit ONLY the files under "YOU OWN". Other agents are editing this same tree.
- No new npm dependencies. No binary assets.
- Keep the performance budget: <= 1,500 draw calls, <= 1.8M triangles on
  menu-hero. Report your numbers.
- Comment WHY, not WHAT.

Your final message is a REPORT: what you fixed, counts before/after from
prop-audit, what you confirmed was a false positive, and what you could not fix.
`;

phase('Polish');

const results = await parallel([
  () => agent(`${COMMON}

YOU OWN: src/world/props.js

You own 15,000+ instances across ~61 pools — most of the city's prop count and
most of the audit's flags.

1. GROUNDING. Every prop must sit exactly on the surface beneath it. The
   surfaces differ: road y=0, sidewalk/plaza y=ctx.Y_WALK, park lawns, bridge
   decks, garage floors. A prop placed at Y_WALK on a road floats 15 cm; one
   placed at 0 on a sidewalk sinks. Work out the correct surface per placement
   site and use it. Verify with node tools/prop-audit.mjs — the 'float'/'sunk'
   columns for your kinds must go to zero (except genuinely suspended props
   like hangBasket, which you should confirm and leave).
2. IN-WATER PROPS. Anything of yours reported in water is misplaced unless it
   is dock furniture. Use layout.isWater() to reject those sites.
3. OVERLAPS. 1,868 pairs interpenetrate. Café clusters legitimately sit close,
   but a bin inside a bench is a defect. Tighten ctx.occupy/ctx.isFree usage:
   claim the real measured footprint, not a guess, and reject a site if it is
   taken. Report the pair count before and after.
4. NATURAL PLACEMENT. Props should read as deliberately placed, not scattered:
   bins and benches against the kerb facing the street, café furniture in
   groups outside the storefront it belongs to, barriers in continuous lines
   along a hoarding, scooters in tidy rows, signs at junctions facing traffic.
   Random scatter is the thing to eliminate.
5. FAIRNESS ACROSS THE MATCH. The player starts with a 2 m radius hole
   (HOLE.START_RADIUS) and must always have something to eat nearby. Check the
   distribution: sample points across the map and confirm a small hole always
   has edible props within a short drive. Report the measurement.

Verify with prop-audit and with street-level / crowd / intersection shots.
`, { label: 'props-placement', phase: 'Polish' }),

  () => agent(`${COMMON}

YOU OWN: src/world/vehicles.js

1. FLOATING VEHICLES. The audit flags 1-4 floating instances each for suv,
   pickup, taxi, hatchback, cityBus, deliveryVan, police. Find them and fix the
   cause, not the symptom — most likely a lane or a parking bay whose surface
   height is wrong, or a garage deck placement. Confirm with prop-audit that
   the float counts reach zero.
2. PARKED VEHICLES vs GEOMETRY. Vehicle footprints are now measured from the
   mesh (a city bus is 5.98 m contact radius, not the 3.2 m that was declared).
   Check that parking bays, kerbside parking and garage decks are actually
   large enough for the vehicles you put in them — with the true sizes, some
   may now interpenetrate kerbs, walls or each other.
3. TRAFFIC AND THE PHYSICS. Traffic now yields to the consume system at
   state >= 1 (a vehicle losing ground support stops being driven). Verify
   that a car destabilised by a hole and then released — the hole moves on —
   rejoins traffic cleanly rather than being stranded or teleporting.
4. BOATS. skiff/sportFisher/motorYacht/waterTaxi are correctly in water; the
   audit's 'sunk' flag for them is about the hull sitting below the water
   plane, which is right. Confirm and ignore, but DO check they sit at a
   believable draught and are inside the marina basins rather than on land.
5. DENSITY AND VARIETY. Confirm the mix of vehicle types is spread across the
   map rather than clustered, and that construction machinery is on
   construction blocks.

Verify with prop-audit (float counts) and intersection / street-level /
waterfront / construction shots.
`, { label: 'vehicles-placement', phase: 'Polish' }),

  () => agent(`${COMMON}

YOU OWN: src/world/nature.js

1. TREES AND THE NEW FOOTPRINT RULE. Trees are now measured at ground contact,
   so a royal palm's physics footprint is its TRUNK (~0.75 m), not its 16 m
   frond crown. That is correct and much better. But it means a palm is now
   destabilised only when the hole is genuinely under its trunk — check that
   palms still read as satisfying to eat, and that the trunk geometry actually
   sits where the visual trunk is.
2. GROUNDING. Every tree, shrub, hedge, flower bed and park feature must meet
   the ground exactly. Check park lawns, planted medians, raised planters and
   the promenade separately — they are at different heights.
3. PLANTING THAT READS AS DESIGNED. Street trees evenly spaced along the kerb
   line rather than jittered; median planting continuous; park planting in
   beds and groves rather than uniform noise; nothing growing out of a road or
   through a building.
4. PARKS AND PLAZAS. Earlier waves reported park and plaza blocks rendering as
   bare slabs. Confirm whether that is still true and fill them properly:
   paths, beds, benches (coordinate with props via your report), lawn edging,
   water features, play equipment.
5. NOTHING IN THE WATER. Use layout.isWater() to reject planting sites, except
   deliberate mangroves at the shoreline.

Verify with prop-audit and park / waterfront / street-level shots.
`, { label: 'nature-placement', phase: 'Polish' }),

  () => agent(`${COMMON}

YOU OWN: src/world/buildings.js

1. THE AUDIT FLAGS AGAINST YOU:
     construction  declared radius 36% under its true footprint
     storefront    15 instances reported sitting in water
     tower/landmark/storefront heights disagree strongly with measurement
   Sizes are now auto-measured, so the numbers themselves are fixed — but
   investigate WHY they disagreed. A construction site measuring 22.6 m against
   a declared 9.6 m suggests geometry (a crane jib, scaffolding) reaching far
   outside the parcel it belongs to. Anything sprawling outside its own lot is
   a placement bug: it will overlap the street, the pavement and its
   neighbours.
2. STOREFRONTS IN WATER. 15 of them. Find out whether the parcel is genuinely
   over water or whether the row is being laid out past the end of its block,
   and fix the placement.
3. FOOTPRINT DISCIPLINE. Every building must sit inside its own parcel with
   its base flush to ctx.Y_WALK — no gap under it, no sinking into the
   pavement, nothing overhanging the carriageway except deliberate awnings and
   canopies.
4. BUILDINGS AND THE NEW PHYSICS. A building is destabilised by any hole that
   takes ground from under it and passes through when the opening exceeds its
   narrow half-width. Sanity-check that the resulting thresholds feel right:
   a small storefront should go before a tower. Report the passRadius spread
   across your building types (read it off the Consumables at runtime).
5. UNBUILT PARCELS. Earlier waves reported blocks rendering as bare slabs or
   dark voids. Confirm and fill anything still empty.

Verify with prop-audit, brickell-skyline, downtown-wide, construction,
street-level.
`, { label: 'buildings-placement', phase: 'Polish' }),
]);

phase('Verify');

const verify = await agent(`${COMMON}

YOU OWN: any file, but ONLY to repair breakage or finish an unfinished fix.

Four agents just did placement passes in parallel on props, vehicles, nature
and buildings. Their reports:
${results.map((r, i) => `--- agent ${i + 1} ---\n${(r || 'FAILED — no report').slice(0, 2600)}`).join('\n\n')}

DO, in order:
1. node tools/prop-audit.mjs
   Report the before/after: kinds flagged, overlapping pairs, floating, sunken,
   in-water. The starting point was 20 kinds flagged and 1,868 overlapping
   pairs. Anything that got WORSE is a regression — find who caused it and fix
   it.
2. node tools/consume-test.mjs
   All properties must still hold: bridging, progressive support loss with
   continuous tilt, visible toppling (bench and car peak tilt should be tens of
   degrees, not fractions), no duplicate left behind (slot scale 0 after
   removal), and respawn. Paste the numbers.
3. node tools/shot.mjs --all --out shots/polish-check --w 1600 --h 900
   'errors' must be empty. Read every png and fix outright breakage only.
4. Report per-preset drawCalls/triangles against the budget.

Report honestly: what improved, what regressed, what is still wrong.
`, { label: 'polish-verify', phase: 'Verify' });

return { results, verify };
