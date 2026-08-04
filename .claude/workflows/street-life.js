export const meta = {
  name: 'miami-street-life',
  description: 'The long tail of city life: buskers, rough sleepers, vendors, domino players, eccentrics, promoters',
  phases: [
    { title: 'StreetLife', detail: 'add the stationary/character layer to the crowd' },
  ],
};

const CWD = '/Users/sam/untitled folder 6';

phase('StreetLife');

const report = await agent(`
PROJECT: ${CWD}  (cd there first; the path has a space, so QUOTE IT)
MIAMI DEVOUR — a Hole.io-style city-eating game in Three.js.
A Vite dev server is already running on http://localhost:5173.

YOU OWN: src/world/pedestrians.js

READ FIRST, in this order:
  1. docs/STREET_LIFE.md   <- the spec for this task. Follow it closely,
                              including the section on how to treat these
                              characters.
  2. docs/ART_DIRECTION.md
  3. src/world/pedestrians.js  <- a previous pass has just rebuilt this file
                                  with walking behaviours, cafe life, nightlife
                                  queues and content-creator crews. You are
                                  ADDING a layer to it, not replacing it. Do not
                                  undo that work.
  4. src/world/worldBuild.js   <- the content-module contract

ROLE: add the long tail of city life — the people who are not going anywhere.

A crowd made only of walkers reads as traffic made of humans. What makes a city
feel lived in is the stationary and the odd: the busker with a ring of
onlookers, the domino game in the park, the person asleep on a bench, the
promoter outside a club, the guy arguing with nobody, someone selling
sunglasses off a blanket, a rough sleeper with a trolley in a quiet doorway.

Build the archetypes listed in docs/STREET_LIFE.md. The important qualities:

1. STATIONARY POSES, not just walk cycles. Sitting on a bench, sitting on the
   ground against a wall, lying on a bench, crouching, leaning on a railing,
   standing in a talking group, playing an instrument, holding a sign,
   gesturing. These need their own instanced part transforms — a walking rig
   frozen mid-stride reads as a bug, not as a person sitting down.

2. SMALL SCENES, not lone figures. A busker needs an audience of three or four
   at a respectful distance and a case on the ground. A domino table needs four
   players and two spectators. A preacher needs a few people ignoring him. Build
   them as composed groups placed as a unit.

3. PLAUSIBLE PLACEMENT. Buskers where there is footfall and a wall behind them.
   Rough sleepers in the quiet, shaded, out-of-the-way places — underpasses,
   the back of a block, riverbank benches — NOT on the polished Brickell
   Avenue frontage. Domino players in parks. Promoters outside venues, and only
   after dark. Use block.streetLife for density and the district for character:
   Downtown scruffier and more mixed, Brickell polished and corporate.

4. DAY/NIGHT. The engine publishes scene.userData.nightFactor (0 day, 1 night).
   Shift the mix over the cycle: office workers thin out after dark, promoters
   and club queues appear, buskers move to the promenade.

5. TREAT THEM WITH THE SAME CARE AS EVERYONE ELSE. See the spec: same modelling
   and animation standard as the office worker walking past, no exaggerated or
   degrading silhouettes, nothing played for laughs at their expense. A rough
   sleeper is a person sitting down with their belongings.

6. THE GAMEPLAY CONTRACT. Every figure and prop you add is a Consumable:
   - placed exactly on the surface beneath it (surfaces differ: road 0,
     sidewalk ctx.Y_WALK, plaza, park, bridge deck),
   - sized from measured geometry — worldBuild does this automatically, so fix
     physics by fixing GEOMETRY, never by passing a different radius,
   - a consumed person must VISIBLY TIP AND FALL like every other prop, never
     vanish on the spot. Seated and lying figures need a sane contact footprint
     in the lowest fifth of their geometry or the physics will misread them,
   - never blocks a path the player, the bots or the crowd need.

7. PERFORMANCE. Everything instanced, sharing the existing body-part pools
   where possible. Report the added instance count, draw calls and per-frame
   cost. Do not push the crowd above ~24 draw calls total.

VERIFY:
  node tools/prop-audit.mjs        (cheap — float/sunk/water for your kinds must be 0)
  node tools/consume-test.mjs      (must keep passing)
  node tools/shot.mjs --presets crowd,street-level,park,waterfront --out shots/streetlife --w 1600 --h 900
  node tools/shot.mjs --presets crowd --out shots/streetlife-night --script "__GAME__.engine.setTimeOfDay(0.88)"
  node tools/seq.mjs --size 7 --frames 6 --out shots/streetlife-fall
Read every PNG with the Read tool. Prove with the seq capture that a consumed
person visibly falls in rather than disappearing.

THE MACHINE IS SHARED — run one headless tool at a time, and prefer prop-audit
over full screenshot sweeps.

Report: archetypes built, counts, where you placed each and why, measured perf,
and anything you could not do.
`, { label: 'street-life', phase: 'StreetLife' });

return { report };
