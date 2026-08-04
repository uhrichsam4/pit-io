# Performance — measured, not guessed

Run `node tools/perf-audit.mjs` to reproduce. Numbers below are from the
`hole-mid` preset.

## Where the frame goes

```
386 instanced pools    3.08 M tris   (288 of them cast shadows: 1.75 M)
525 meshes             0.81 M tris
reported               869 draw calls, 5.09 M triangles
```

There is **no single hog**. The largest pool is 68 k triangles. This is a long
tail, so optimisation has to be structural rather than a hunt for one bad asset.

## Important caveat on these numbers

They are measured under **SwiftShader**, a software renderer, because that is
what the headless harness uses. A real GPU processes 5 M triangles without
difficulty — the figure looks alarming here and is far less significant on the
machine a player is actually using. Draw calls (869) are already comfortably
inside the 1,500 budget.

So: worth improving, not urgent, and not worth trading visual quality for.

## The three real wins, in order of value

### 1. Vehicles are split into one pool per paint colour  — owner: vehicles.js

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

### 2. Pedestrian fall poses are pre-allocated per agent — owner: pedestrians.js

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

### 3. Pedestrians cast shadows from three separate part pools — owner: pedestrians.js

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
