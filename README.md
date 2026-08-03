# MIAMI DEVOUR

A bright, playful, multiplayer city-eating game built in Three.js. You are a hole
in the ground in Brickell. Start by swallowing traffic cones. End by swallowing
the skyline.

![preset: brickell-skyline](shots/latest/brickell-skyline.png)

## Run it

```bash
npm install
npm run dev
```

Then open <http://localhost:5173>.

For multiplayer, start the room server in a second terminal:

```bash
npm run server
```

and open <http://localhost:5173/?room=miami> in two or more tabs. Everyone in the
same `?room=` shares a match. Optional query parameters:

| Parameter | Meaning |
|---|---|
| `?room=NAME` | join/create a multiplayer room (omit for solo + bots) |
| `?name=NAME` | your display name |
| `?server=host:port` | point at a non-default room server |
| `?debug=1` | enable debug overlays |

## How it plays

- **Move** with WASD, the arrow keys, a gamepad stick, or by dragging.
- You can only swallow things smaller than your hole. Everything else you drive
  underneath and ignore.
- Every swallow grows you, which unlocks the next tier: street furniture → bikes
  and carts → cars and palms → buses and boats → storefronts → whole buildings →
  landmark towers.
- Rival holes are food too, once you are ~18% bigger than they are. Being eaten
  costs you half your score and a short respawn.
- The last 30 seconds are a **frenzy**: size requirements drop and everything is
  suddenly on the menu.

## Architecture

```
src/
  config.js            WORLD / HOLE / MATCH / TIER constants (re-exports palette + quality)
  game.js              wires engine + world + holes + UI into one loop
  core/
    engine.js          renderer, sun/sky rig, camera, post-processing chain
    quality.js         QUALITY + CAMERA tunables
    materials.js       procedural canvas textures + shared material factories
    pools.js           InstancedMesh pools with proxy-mesh leasing
    audio.js           fully synthesised SFX + generative music
    rng.js             seeded mulberry32 — the city is deterministic
  render/
    palette.js         every colour in the game
    groundShader.js    the multi-hole ground cutter
    effects.js         particles, debris, shockwaves, screen shake
  world/
    cityLayout.js      pure-data street grid + block zoning for Brickell/Downtown
    streets.js         roads, sidewalks, curbs, markings, bridges
    buildings.js       towers, midrises, storefronts, garages, construction
    props.js           street furniture
    vehicles.js        traffic, parked cars, boats, machinery
    nature.js          parks, plazas, palms, fountains
    water.js           Biscayne Bay + the Miami River
    worldBuild.js      orchestrator; defines the content-module contract
  gameplay/
    entities.js        Consumable registry + spatial hash
    hole.js            the hole: growth curve, movement, pit visual
    consume.js         suction, capture, the tumble, hole-vs-hole
    ai.js              bot opponents
    match.js           match state machine
    input.js           keyboard / pointer / touch / gamepad
  net/
    protocol.js        wire format, shared with the server
    client.js          snapshot interpolation + event reporting
  ui/                  HUD, minimap, screens
  dev/devtools.js      window.DEV — the automated screenshot harness
server/server.js       authoritative room server
tools/shot.mjs         headless screenshot driver
tools/compare.mjs      A/B and contact-sheet builder
docs/ART_DIRECTION.md  the visual law
```

### Two ideas worth knowing

**The hole is a shader, not geometry.** Every ground surface uses a material
patched by `applyHoleCut()`, which discards fragments inside any active hole and
darkens a soft rim just outside it. Objects that have dropped below `y = 0` are
therefore only visible through the cut, because everywhere else the opaque
ground still wins the depth test. One shared uniform block means adding a hole
costs a single write per frame regardless of how many ground meshes exist.

**Instanced until swallowed.** Repeated props live as one slot inside an
`InstancedMesh` — one draw call for thousands of cones. The instant a prop is
captured, its slot is zeroed and it leases a real `Mesh` from a free list, so it
gets full individual physics for the second it spends falling. Cheap when
sleeping, correct when it matters.

### Determinism and multiplayer

World generation uses only the seeded RNG in `core/rng.js`, so the same seed
produces a byte-identical city with identical `Consumable` ids on every client.
That is what lets multiplayer replicate *events against the world* (`ids 41, 42
were eaten`) instead of replicating the world itself. The server stays
authoritative for the match clock, the roster, and hole-vs-hole kills.

## Development

```bash
# screenshot any canonical view, headless
node tools/shot.mjs --presets hole-small,brickell-skyline --out shots/check

# every preset
node tools/shot.mjs --all --out shots/full --w 1600 --h 900

# blind A/B two runs
node tools/compare.mjs --ab shots/before shots/after --out shots/ab.png --blind
```

`shots/<dir>/report.json` records draw calls, triangle counts and any runtime
errors for each shot. Preset names are defined in `src/dev/devtools.js`.
