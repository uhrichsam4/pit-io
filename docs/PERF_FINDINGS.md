# Performance — measured, not guessed

Run `node tools/perf-audit.mjs` to reproduce. Numbers below are from the
`hole-mid` preset — which is the cheapest frame in the game. For the frame that
actually decides whether the budget holds, see the next section.

## Where the frame goes

```
359 instanced pools    3.26 M tris   (228 of them cast shadows: 1.66 M)
535 meshes             0.92 M tris
reported               761 draw calls, 5.23 M triangles
```

There is **no single hog**. The largest pool is 176 k triangles (the sedan
pool, 549 instances). This is a long tail, so optimisation has to be structural
rather than a hunt for one bad asset.

## THE WORST FRAME IS NOT `hole-mid`, AND IT IS NOT AT NOON

`hole-mid` at noon is the cheapest thing anyone measures, and quoting it is how
this file came to claim 869 calls was "comfortably inside" the budget. Swept
across eight presets x three hours, at 960x540:

```
                       noon (0.60)   dusk (0.80)   night (0.95)
brickell-skyline           1356          1470          1343
downtown-wide              1147          1221          1214
waterfront                 1115          1154          1182
hole-big                   1048          1129          1026
construction               1038          1114          1037
hole-mid                    771           840           787
```

**Worst case 1,470 of a 1,500 budget — 30 calls of headroom, not 700.** Anyone
adding a pool that is visible from the bay side should measure
`brickell-skyline` at dusk before assuming there is room.

### Why dusk costs 134 calls more than noon

It is not extra content: exactly one object is visible at dusk that is not
visible at noon (`inst-vfx:headbeam`). It is the **shadow pass**, measured by
toggling `renderer.shadowMap.enabled` on the same frame:

```
tod   nightFactor  total  no-shadow  shadow pass  key elevation (sunDir.y)
0.55       0        1334      841        493            0.923
0.80       1        1470      843        627            0.472
0.95       1        1343      843        500            0.754
```

The shadow camera's cross-section is a fixed +/-472 m at every hour, but at
dusk the key light is the moon at 0.47 elevation. Projected along a shallow
direction, that same box sweeps a long diagonal tube through the city instead
of a vertical column, so far more geometry falls inside the frustum. The
`far` plane is a constant 1,564 m and is not fitted to the depth actually
needed. Fitting it (owner: `engine.js` `_updateShadowFit`) is the obvious
~100-call win, and it needs care: get it wrong and distant shadows pop.

## Important caveat on these numbers

They are measured under **SwiftShader**, a software renderer, because that is
what the headless harness uses. A real GPU processes 5 M triangles without
difficulty — the figure looks alarming here and is far less significant on the
machine a player is actually using.

So: the triangle count is worth improving, not urgent, and not worth trading
visual quality for. The draw-call headroom at dusk is the number to watch.

## The three real wins — ALL THREE ARE NOW DONE

Kept here because the reasoning is still the reasoning, and because the next
person to read this file should not spend a day redoing them. Measured after:

| | before | after |
|---|---|---|
| instanced pools | 386 | **359** |
| of which vehicle pools | 103 | **36** |
| shadow-casting pools | 288 | **228** |
| instanced shadow triangles | 1.75 M | **1.66 M** |
| pedestrian shadow pools | 3 (137 k tris) | **1** (`ped-shadow`, 44.5 k) |
| fall-pose pools drawn at rest | 4 (290 k tris) | **0** (34 pools, all hidden) |
| `hole-mid` draw calls | 869 | **761** |

The fall poses are worth a note, because a naive reading of `perf-audit`
suggests they got worse: there are now 34 of them holding 365 k triangles.
They are **leased on demand and hidden until somebody is actually falling** —
measured in the `crowd` frame, 0 of 34 are drawn, contributing 0 draw calls and
0 rendered triangles. `perf-audit` now reports hidden pools on their own
`dormant` line so this cannot be misread again.

### 1. Vehicles are split into one pool per paint colour  — owner: vehicles.js  — DONE

```
inst-veh:sedan:0   76 x 320      inst-veh:suv:2   64 x 340
inst-veh:sedan:2   69 x 320      inst-veh:suv:3   61 x 340
inst-veh:sedan:3   72 x 320      inst-veh:suv:4   64 x 340
inst-veh:sedan:4   65 x 320      inst-veh:taxi:0  170 x 384
```

Every colour variant is its own `InstancedMesh`, so every variant is a draw
call in the beauty pass *and* another in the shadow pass. This is the single
biggest reason there are 386 pools rather than roughly 100.

`InstancedProp` already supports per-instance colour (`opts.color` +
`instanceColor`). Collapsing each body type to one pool coloured per instance
should remove well over a hundred draw calls at zero visual cost.

### 2. Pedestrian fall poses are pre-allocated per agent — owner: pedestrians.js — DONE

```
inst-pedFall_casual   817 x 192 = 157 k tris
inst-pedFall_tourist  246 x 192 =  47 k
inst-pedFall_office   233 x 192 =  45 k
inst-pedFall_hivis    196 x 192 =  38 k
```

Roughly 1,500 instances and ~290 k triangles of *falling* pose, when only a
handful of people are ever falling at once. `InstancedMesh` pays vertex cost
for its whole `count`, including instances collapsed to zero scale, so these
are largely wasted. A small shared pool leased on demand would cost almost
nothing.

### 3. Pedestrians cast shadows from three separate part pools — owner: pedestrians.js — DONE

```
ped-shins   3126 x 22 = 69 k     (castShadow true)
ped-torso   1563 x 24 = 38 k     (castShadow true)
ped-thighs  3126 x 10 = 31 k     (castShadow true)
ped-head / ped-hair / ped-arms   (castShadow false)
```

137 k triangles of shadow casting, across three draw calls per frame, to
produce what reads on screen as a small blob under each person — and it is
already inconsistent, since the head and arms do not cast. A single low-poly
shadow proxy per pedestrian would look the same and cost a fraction.

## Already handled

- **Flat ground props do not cast shadows.** Manhole covers, drain grates and
  road inlays lie flat, so their shadow is hidden underneath them. The content
  modules had already set this correctly; `InstancedProp.optimiseShadows()` now
  enforces it automatically so a newly added flat prop cannot regress it.

## Do NOT do

- **Do not disable shadow casting on small props to save triangles.** Contact
  shadows on cones, bins and benches are what stop them reading as stickers on
  the pavement, and the shadow filter was specifically retuned to restore them.
  That trade loses more than it gains.
