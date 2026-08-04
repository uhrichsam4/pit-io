# Street life — the characters that make a city read as real

A city is not only commuters and tourists. What makes Brickell and Downtown feel
*lived in* rather than *populated* is the long tail: the people who are not
going anywhere, the ones doing something odd, the ones who are clearly local.
Without them a crowd reads as traffic made of humans.

This is a required content layer, owned by `src/world/pedestrians.js`.

## The archetypes

Beyond the commuter/tourist/worker set already specified:

**People who are stationary and doing something**
- Rough sleepers and people living on the street: sitting against a wall with
  a blanket and belongings, a shopping trolley or bundled bags, a cardboard
  sign, a sleeping bag under an awning or in a doorway, someone with a dog.
  Concentrate them where they actually are in a city — underpasses, behind the
  bus station, the quiet side of a block, riverbank benches — not on the
  polished Brickell Avenue frontage.
- Street performers: a busker with a guitar, a drummer on buckets, a
  saxophonist on the promenade, a statue performer painted silver, a
  breakdancer with a small ring of onlookers.
- Preachers and soapbox speakers with a small hostile or indifferent crowd.
- People selling things off a blanket or a folding table: sunglasses, phone
  cases, fruit, cold drinks from a cooler.
- Chess and dominoes players at park tables with spectators.
- Someone asleep on a bench in the sun. Someone feeding pigeons.

**People who are visibly eccentric**
- Somebody arguing loudly with nobody.
- Somebody in an absurd outfit — a full costume in 30-degree heat, a mascot
  handing out flyers, someone rollerblading in swimwear.
- A parrot on a shoulder. A person walking an unusual pet.
- Someone doing yoga or tai chi in the park at an odd hour.

**Miami specifically**
- Retirees playing dominoes, guayaberas, wide hats.
- Beach-adjacent people cutting through the city in swimwear with towels.
- Gym crowd, cyclists in full kit, rollerbladers on the promenade.
- Club promoters handing out cards outside venues at night.
- Someone washing a supercar by hand outside a condo.

## How to treat them

Render these people with exactly the same care as everyone else. They are part
of the texture of the city, not a punchline: no exaggerated or degrading
silhouettes, no signage or animation played for laughs at their expense, and no
gameplay that singles them out. A rough sleeper is a person sitting down with
their belongings — modelled and animated to the same standard as the office
worker walking past them.

## Placement rules

- Cluster by plausibility, not evenly. Buskers where there is footfall and a
  wall to play against; rough sleepers in the quiet, shaded, out-of-the-way
  places; domino players in parks; promoters outside venues after dark.
- Use `block.streetLife` for density and the district for character: Downtown
  is scruffier and more mixed, Brickell is polished and corporate.
- Shift the mix over the day/night cycle: office workers thin out after dark,
  nightlife and promoters appear, buskers move to the promenade.

## Gameplay rules — non-negotiable

Everything here is a Consumable and must obey the same contract as every other
prop:

- Correct ground placement on whatever surface it stands on.
- Sized from measured geometry (worldBuild does this automatically).
- Reacts only when a hole takes enough ground from under it.
- Visibly falls in — a consumed person must tip and fall like everything else,
  never vanish on the spot.
- Never blocks a path the player, the bots or the crowd need.
- Seated and lying figures still need a sane contact footprint, or the physics
  will treat them as something they are not.
