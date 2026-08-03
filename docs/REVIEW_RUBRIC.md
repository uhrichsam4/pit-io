# Visual Review Rubric

Used by every critic pass. The job is **not** to be encouraging. The job is to
find the reason a player would say "this looks like a hobby project" and name it
precisely enough that someone can fix it in one sitting.

## The blind test

Before scoring anything, run this:

1. Look at the screenshot with no context.
2. Write one sentence: *"If I saw this next to a Hole.io screenshot and did not
   know which was which, I would pick ___ because ___."*
3. If the answer is not "ours", the pass **fails**, regardless of how many
   individual boxes below are ticked.

You are allowed to conclude that ours wins. You are not allowed to conclude it
by ignoring something ugly in the frame.

## Scoring — every category is 1–10, and 8 is the floor

| # | Category | 10 looks like |
|---|---|---|
| 1 | **First-glance readability** | You instantly parse ground / props / buildings / the hole. Nothing camouflages into anything else. |
| 2 | **Colour & grade** | Warm sunlit Miami. Asphalt warm-grey, sidewalks bone not white, pastel facades, turquoise water. No navy ground, no clipped whites, no muddy mids. |
| 3 | **Light & shadow** | A clear key direction. Soft warm shadows that actually land. Contact shadows under every object. No acne, no peter-panning, no floating props. |
| 4 | **Silhouette & shape language** | Confident chunky forms, bevelled edges, no razor-thin geometry, no untextured boxes standing in for buildings. |
| 5 | **Surface detail** | Materials read at both 40 m and 4 m. No visible tiling. No stretched or swimming UVs. Roofs have detail — they are on screen constantly. |
| 6 | **Density & life** | The street looks lived-in: props, traffic, pedestrians, planting. Empty pavement is a failure. |
| 7 | **Architectural variety** | A skyline with real rhythm — different heights, widths, crowns, colours, setbacks. Not a copy-paste forest. |
| 8 | **The hole itself** | Unmistakably the darkest, most attention-grabbing thing on screen. Clean cut, believable depth, readable lip. |
| 9 | **Composition** | The frame is worth looking at. Depth cues, foreground/midground/background separation, no camera clipping through geometry. |
| 10 | **Polish** | No z-fighting, no gaps at seams, no popping, no stray geometry, no shader artefacts, no NaNs. |

## Automatic failures

Any one of these fails the pass outright, whatever the scores say:

- Navy, purple, or blue-grey asphalt.
- Sidewalks blown to featureless white.
- A building that is an untextured flat box.
- Crosswalk or lane markings that read as random white rectangles.
- Props floating above, or sunk into, the ground.
- Visible z-fighting anywhere.
- The camera clipping inside a building in a preset shot.
- Objects visibly popping, deflating, or disappearing without falling in.
- The player's hole hidden behind geometry with no fade.
- A runtime error in `report.json`.

## How to report

For each finding give:

- **Where** — preset name, and where in the frame.
- **What** — the specific defect, not a vibe.
- **Which file** — the module that owns it.
- **Severity** — `blocker` (automatic failure), `major` (drops a score below 8),
  `minor` (polish).

Do not report anything you have not seen in an image you actually opened.
Do not report the same defect twice under different names.
Rank by severity, then by how cheap the fix is.
