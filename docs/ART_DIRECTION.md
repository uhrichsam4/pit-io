# MIAMI DEVOUR — Art Direction Bible

**Every agent working on this project must follow this document.** It exists so
that six people building six subsystems in parallel produce one coherent game
instead of six good-looking strangers.

---

## 1. The one-sentence pitch

*Hole.io's readable, chunky, joyful toy-city language — rebuilt at the fidelity
of a modern stylised AAA title, and relocated to a sun-drenched Brickell.*

## 2. The reference we are beaten against

Every visual review compares our screenshots **side by side against Hole.io**.
The bar is not "looks decent". The bar is: *shown two images blind, a harsh
critic picks ours.*

What Hole.io gets right and we must match or beat:

| Hole.io strength | What we must do |
|---|---|
| Instant readability — you always know what's edible | Silhouettes first. Strong value separation between ground, props, buildings. |
| Bright, high-key, cheerful palette | Sunlit, saturated, zero grimness. No muddy greys, no navy asphalt. |
| Chunky, confident shapes | Generous bevels, no razor edges, no needle-thin geometry. |
| Clean flat-ish shading that never gets noisy | Detail comes from *shape and colour*, not from busy textures. |
| Everything reads at a glance from a high 3/4 camera | Design for the top-down-ish view first, eye-level second. |

Where we beat it:

- Real material response: soft shadows, ambient occlusion, glass with actual
  reflections, sun specular on water.
- Facade articulation: balconies, setbacks, crowns, podiums, awnings, signage.
- Density of life: traffic, palms bending, café clusters, boats, cranes.
- Feedback: dust, debris, shockwaves, squash-and-stretch, screen shake.

## 3. Palette — the law

Defined in `src/config.js` → `PALETTE`. **Use it. Do not invent colours.**
If you need a new colour, add it to `PALETTE` with a comment.

- **Sky**: warm-to-cool gradient, bright horizon haze. Never grey.
- **Ground / asphalt**: WARM mid-grey (`#6b6a66`-ish), *never blue-grey*. The
  single most common bug in this project is asphalt reading as navy. Watch it.
- **Sidewalk**: warm bone/sand paving, clearly lighter than the road but
  **never blown to pure white** — keep it under ~0.85 luminance.
- **Buildings**: glass towers in teal / aqua / sky-blue, masonry and stucco in
  coral, cream, pink, lilac, mint. Miami Deco pastels.
- **Accents**: hot pink `#ff3d8b`, sun yellow `#ffc93c`, aqua `#37e6d5`.
- **Water**: turquoise shallows → deep cyan, white foam. This is Biscayne Bay,
  not the North Atlantic.
- **The hole**: near-black void with a coloured lip. It must be the darkest
  thing on screen by a wide margin — that contrast is the whole game.

## 4. Lighting

- Late-afternoon Miami sun, high and slightly behind-right of the camera.
- One strong warm key + cool sky fill. Shadows are **soft, warm-tinted, and
  present** — flat unshadowed geometry is an automatic review failure.
- Exposure target: mid-grey concrete sits around 0.55–0.68 luminance. Nothing
  large should clip to pure white. Nothing large should crush to black except
  the hole.
- Bloom: subtle. It is a highlight kiss on glass and chrome, not a glow filter.

## 5. Scale and proportion

- 1 unit = 1 metre. Everything must be metrically believable.
- A person is ~1.8 m. A car is 4.4 m. A storey is 3.4 m. A city block is 68 m.
- Traffic cone 0.7 m, bench 2 m, palm 10 m, bus 11.5 m, storefront 7 m,
  midrise 20–55 m, Brickell tower 90–210 m.
- **Props must be dense enough that the early game is fun.** A block edge with
  four cones on it is a failure; it should feel littered with street life.

## 6. Geometry rules

- **Bevel everything.** Sharp 90° box edges are the #1 tell of cheap 3D. Use
  chamfered profiles or a slight edge inset on anything the camera gets near.
- **No untextured flat boxes above 10 m.** Towers need: a podium, a shaft with
  articulation (mullion rhythm, spandrels, balcony slabs, setbacks), and a
  crown. Look at Brickell — the towers have *tops*.
- Budget: aim to keep the whole city under ~1.2 M triangles and under ~450 draw
  calls. Instance anything that repeats. Merge anything static.
- Every mesh that can be swallowed must have a sane `radius` and `height` in its
  `Consumable`, or the physics will look wrong.

## 7. Density targets (the city must feel ALIVE)

| Category | Target count |
|---|---|
| Small props (cones, bins, benches, planters, signs, hydrants, bollards, tables, umbrellas) | 9,000 – 16,000 |
| Palms + trees | 1,500 – 3,000 |
| Parked + moving vehicles | 1,200 – 2,200 |
| Buildings (all types) | 350 – 700 |
| Boats | 60 – 140 |

If your module is under target, you are not finished.

## 8. Camera

Fixed yaw, high 3/4. Distance scales with hole radius. Design every asset to
read from ~40° above the horizon. Rooftops are visible almost all the time —
**roofs need detail**: AC units, vents, helipads, water tanks, pools, parapets.

## 9. Anti-patterns — automatic review failure

1. Navy or purple asphalt.
2. Blown-out white sidewalks with no visible texture.
3. Flat-shaded untextured boxes standing in for buildings.
4. Tiling so obvious you can count the repeats.
5. Props floating above or sunk into the ground plane.
6. Z-fighting on any coplanar surface.
7. A skyline that is all the same height or all the same colour.
8. Crosswalk / lane markings that read as random white rectangles.
9. Anything that pops in or out visibly as the camera moves.
10. Shadow acne, peter-panning, or missing contact shadows.

## 10. How to verify your work

```bash
node tools/shot.mjs --presets hole-small,street-level,brickell-skyline --out shots/my-check
```

Then **open the PNGs with the Read tool and actually look at them.** Do not
claim a visual result you have not seen. `report.json` in the output directory
lists any runtime errors — a non-empty `errors` array means you broke something.
