# Roadmap — deliberately not built yet

Everything here is **paused by decision, not by oversight**. The current maps
are stable and the visual direction is settled; none of this gets implemented
until it is specifically asked for.

Each entry records what it is, why it is not in yet, and what it would touch —
so picking one up later starts from a plan rather than from scratch.

---

## 1. Weather

Rain, snow, fog, wind, storms, and weather that belongs to a biome.

**Why not yet.** Weather is a *system*, not a decoration: it needs a particle
budget, a wind vector that vegetation and cloth actually read, wet-surface
materials, and a scheduler. Snowfall City currently gets its winter from a
colour grade and a static snow pass, which costs nothing per frame. Falling snow
would be the first per-frame particle load in the game.

**What it would touch.** A new weather module; `postfx.js` (wet-surface
reflectance and fog density); `nature.js` (wind response); the particle pool in
`effects.js`; `maps.js` for the per-map default.

**Do first:** the particle pooling in the optimisation list, or weather will be
the thing that makes the game stutter.

---

## 2. Time-of-day presets

Sunrise, morning, afternoon, sundown, night as authored looks.

**Why not yet.** The engine ALREADY has a continuous day/night cycle with an
interpolated grade (`setLook()`, driven by `scene.userData.timeOfDay`). What is
missing is not the capability but the *authored presets* and a way to pick one
per map or per match. That is a tuning job, and tuning five looks properly is a
day of screenshots, not an afternoon of code.

**What it would touch.** `quality.js` (the GRADE baseline), `postfx.js`
(`setLook`), `maps.js` (per-map default), a picker in the lobby.

**Note.** `setBiomeGrade()` already exists and composes over the time-of-day
look — that is the hook a preset system should use, not a competing one.

---

## 3. Cars that react to the hole

Vehicles notice a nearby hole and try to accelerate away safely.

**Why not yet.** Traffic follows lanes through a road network with intersection
handling. "Flee the hole" means leaving the lane graph, which means collision
against other vehicles, kerbs and pedestrians without the network to arbitrate
it — otherwise cars pile into buildings and each other while escaping. The
believable version is lane-aware: brake, change lane, take the next turning.

**What it would touch.** `vehicles.js` traffic AI, `roadNetwork.js` for
alternate routing, and the hole-proximity query in `consume.js`.

**Cost note.** Traffic AI is currently **1.23 ms of a 114 ms frame**. There is
plenty of CPU headroom for this; it is a correctness problem, not a performance
one.

---

## 4. Creator / VIP NPC scenes

Rare fictional set-pieces: vloggers, camera crews, food reviewers, security
details, luxury-car arrivals.

**Why not yet.** `pedestrians.js` already has the props — tripods, ring lights,
cameras, crowd groups — and already places filming crews. What is missing is
*staging*: a scene is a small cast in fixed relative positions with a reason to
be where they are, which needs an authored scene format and placement rules, not
more props.

**Important:** these must stay clearly fictional. No real person's name,
likeness, or branding.

**What it would touch.** A scene-definition format, `pedestrians.js` placement,
possibly a rare-spawn scheduler so a set-piece is a surprise rather than
wallpaper.

---

## 5. Per-map identity

Every future map gets architecture, roads, buildings, vehicles, vegetation,
weather, props and pedestrian scenes that belong to its location.

**Why not yet.** This is the big one, and Snowfall City is the honest evidence
of the gap. Its vegetation is genuinely biome-aware — `plant()` swaps species at
the single funnel every plant passes through, so palms are gone and bare trees
and spruces are in. Its roads are genuinely plowed. But its **buildings,
layout and street furniture are still Miami's**, because those modules do not
take a biome and making them take one is a rewrite of eight files, not a flag.

**The pattern that worked, and should be reused.** Find the single funnel that
every instance of a thing passes through, and swap there:

- vegetation → `plant()` in `nature.js` — one hook, reached every plant
- roads → exact material names + **clone before mutating**

**The trap that cost real time twice.** `materials.js` caches by parameter
object, so two call sites asking for the same thing get the SAME instance.
Retinting a shared material by regex turned the road overlays green. Always
clone. And never guess a material or species name — query the live scene for it,
because a wrong guess fails **silently** (the kerb-drift pass placed zero for a
whole build because it looked for `sidewalk` and the mesh is called
`streets-land`).

**What it would touch.** `buildings.js` (facade families per biome),
`cityLayout.js` (district plans), `streets.js`, `props.js`, `vehicles.js`
(regional traffic mix).

---

## Also parked

- **Old-town district** for Snowfall — square, 4–8 floor apartments, courtyards,
  narrow streets. New building geometry; a few hours, not minutes.
- **Modern condo outer district** — cheaper, mostly recolour and placement.
- **Map rotation** — `maps.js` already holds the registry; rotation is a lobby
  and server concern on top of it.
- **Deeper optimisation** — LODs, quality presets, adaptive resolution, crowd
  and physics culling. See the measurements below before starting.
- **Social hub** — name labels, emotes, spawn animation, camera reveal.
- **Metromover finish** — proportions and station detail on the spawn island.
- **Deep prop rebuild** — 185 of 220 prop kinds were graded below standard.

---

## Measurements to start from

Taken on the Miami scene, so the next person does not re-derive them.

| | |
|---|---|
| frame | **112 ms render / 2.1 ms simulation** — render-bound, overwhelmingly |
| traffic AI | 1.23 ms |
| pedestrians | 0.41 ms |
| consume/physics | 0.06 ms |
| draw calls | 748 |
| triangles | 8.14 M |
| instanced pools | 355 (instancing is **already done**) |
| pools spanning the whole map | 324 of 373 |

**Three conclusions worth keeping:**

1. **Stopping distant traffic/NPC/physics updates would save ~1.3%.** The
   simulation is not the bottleneck and optimising it is wasted effort.
2. **Per-pool frustum culling gains nothing** — 324 of 373 pools span the map by
   design, so their bounds always intersect the view. The real lever is spatial
   chunking, which is a refactor.
3. **The 478 building draw calls are load-bearing.** Each building needs its own
   material for the occlusion fade and its own transform to be eaten. Merging
   them would break both features.

The one measured win so far: culling shadow casting on static props under 1.8 m
took the frame from 9.25 M to 8.14 M triangles and 824 to 748 draw calls, with
vehicles explicitly exempted because they move and their shadows are what put
them on the road.
