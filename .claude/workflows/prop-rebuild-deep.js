export const meta = {
  name: 'prop-rebuild-deep',
  description: 'Re-judge every prop kind, then rebuild the failures in small sharded batches until nothing is left below standard',
  phases: [
    { title: 'Regrade', detail: 'photograph and independently re-judge all ~220 kinds' },
    { title: 'Rebuild', detail: 'small batches, sequential per file so two agents never edit one file' },
    { title: 'Verify', detail: 'reshoot, re-judge the rebuilt kinds, physics regression' },
  ],
};

/* =========================================================================
 * WHY THIS EXISTS, AND WHY IT IS SHAPED LIKE THIS
 *
 * The first quality wave judged all 220 prop kinds and flagged 185. It then
 * handed every failure in a module to ONE agent — 117 kinds to a single
 * props.js agent. One agent cannot deeply remake 117 models; it runs out of
 * context and starts producing box-with-a-bevel work, which is the exact
 * failure being fixed.
 *
 * So: shard by COUNT, not by module. ~14 kinds per agent, which is a batch an
 * agent can actually look at, think about and verify one by one.
 *
 * THE COLLISION PROBLEM. Sharding by count means several agents want the same
 * file — props.js holds 117 of the failures. Two agents editing one 4,500-line
 * file concurrently will clobber each other. Worktrees would isolate them but
 * then an 8-way merge of one file has to be resolved, which is its own way to
 * lose work silently.
 *
 * The answer here: batches for a given FILE run SEQUENTIALLY (one agent in that
 * file at a time), and the per-file chains run in PARALLEL with each other.
 * Concurrency equals the number of distinct files, which is safe by
 * construction, and depth per model is preserved. props.js is the long pole and
 * that is fine — this is overnight work and correctness beats wall-clock.
 * ====================================================================== */

const CWD = '/Users/sam/untitled folder 6';

/** Kinds per agent. Small enough that every model gets real attention. */
const BATCH = 14;
/** Re-judge and rebuild again while anything is still failing, at most this often. */
const MAX_ROUNDS = 3;

const OWNERS = {
  props: 'src/world/props.js',
  nature: 'src/world/nature.js',
  vehicles: 'src/world/vehicles.js',
  pedestrians: 'src/world/pedestrians.js',
  streets: 'src/world/streets.js',
  buildings: 'src/world/buildings.js',
  water: 'src/world/water.js',
};

const GRADES = {
  type: 'object',
  additionalProperties: false,
  required: ['graded'],
  properties: {
    graded: {
      type: 'array',
      maxItems: 60,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'grade', 'owner', 'verdict'],
        properties: {
          kind: { type: 'string' },
          grade: { type: 'string', enum: ['good', 'weak', 'bad'] },
          owner: { type: 'string', description: 'one of: ' + Object.keys(OWNERS).join(', ') },
          verdict: { type: 'string', description: 'what is specifically wrong, or why it is good' },
          rebuild: { type: 'string', description: 'concrete instruction for how to remake it' },
        },
      },
    },
  },
};

const BASE = `
PROJECT: ${CWD}   (cd there first; the path contains a space, so QUOTE IT)
MIAMI DEVOUR — a Hole.io-style Miami city-eating game in Three.js. Everything
is procedural: no binary assets, no textures on disk, no npm additions.
Read docs/ART_DIRECTION.md before you judge or build anything.

THE STANDARD, and it is not negotiable: this city must not contain a single
prop that looks cheaped out on. Every object reads as deliberately made —
believable proportions, chamfered edges rather than raw box corners, more than
one material, and enough small detail (slats, bolts, handles, signage, wear at
the base) to hold up at THREE METRES, because that is how close the player is
for the whole first minute of a match.

The tell for failure is almost always one of these:
  - a raw box or cylinder with no bevel
  - one flat colour across parts that would really be different materials
  - the thing the object is NAMED for is missing (a cable drum with no cable)
  - flat alpha cards standing in for something with real volume
  - identical copies repeated hundreds of times with no variation
`;

/* ---------------------------------------------------------------- regrade */

async function regrade(round) {
  phase('Regrade');
  const dir = `shots/regrade-${round}`;

  const cat = await agent(`${BASE}

CATALOGUE PASS (round ${round}).

Photograph EVERY prop kind in the city alone, on a neutral ground plane, from
the game's own camera angle, at a size where its detail is judgeable.

  node tools/prop-catalogue.mjs --out ${dir}

Read the tool first — it already knows how to enumerate every registered kind
and write a catalogue.json with triangle counts and instance counts beside the
images. Use its existing flags; do not write a new harness.

This machine is running several agent waves at once and is heavily loaded, so
the shoot is slow and may be interrupted by Vite reloading the page. If the
tool has a resume or --match flag, use it to fill in whatever is missing rather
than restarting the whole sweep.

Report: how many kinds were photographed, where they are, and any kind that
failed to render.`, { label: `catalogue:r${round}`, phase: 'Regrade' });

  // Judge in parallel slices. Independent reviewers, each seeing only its own
  // slice, so no reviewer can be anchored by another's leniency.
  const SLICES = [
    ['a-c', 'kinds whose name starts a through c'],
    ['d-f', 'kinds whose name starts d through f'],
    ['g-l', 'kinds whose name starts g through l'],
    ['m-p', 'kinds whose name starts m through p'],
    ['q-s', 'kinds whose name starts q through s'],
    ['t-z', 'kinds whose name starts t through z'],
  ];

  const graded = await parallel(SLICES.map(([slice, desc]) => () => agent(`${BASE}

JUDGE PASS (round ${round}) — your slice: ${desc}.

Images are in ${dir}/. The catalogue agent reported:
${String(cat || 'catalogue may be incomplete — work with whatever is in the directory').slice(0, 1000)}

LOOK AT EVERY IMAGE IN YOUR SLICE. Open it. Do not grade from the source code
and do not grade from the file name — the whole point of this pass is that
somebody actually looked.

Grade each kind:
  good  ships as is — you would not be embarrassed by it at three metres
  weak  recognisable but cheap: missing detail, flat materials, no variation
  bad   does not read as the thing it is meant to be, or is visibly broken

Be harsh. In the previous round only 16% of kinds were good, and that was the
correct call. Do not grade generously to be kind; a "weak" you wave through is a
prop the player sees a thousand times.

For anything not good, write:
  verdict — what is specifically wrong, in terms of what you can SEE
  rebuild — a concrete instruction: what parts it should be built from, what
            materials, what detail. Specific enough to act on without guessing.

Also note the triangle count from ${dir}/catalogue.json in your verdict when a
kind is expensive, so the rebuild knows its budget.`,
    { label: `judge:${slice}`, phase: 'Regrade', schema: GRADES })));

  const all = [];
  for (const g of graded) if (g && Array.isArray(g.graded)) all.push(...g.graded);

  // Dedupe: slices can overlap at their boundaries, and the worse grade wins.
  const rank = { good: 0, weak: 1, bad: 2 };
  const byKind = new Map();
  for (const g of all) {
    const prev = byKind.get(g.kind);
    if (!prev || (rank[g.grade] || 0) > (rank[prev.grade] || 0)) byKind.set(g.kind, g);
  }
  const kinds = [...byKind.values()];
  const failing = kinds.filter((g) => g.grade !== 'good' && OWNERS[g.owner]);
  log(`round ${round}: ${kinds.length} judged, ${failing.length} below standard ` +
      `(${kinds.filter((k) => k.grade === 'bad').length} bad, ` +
      `${kinds.filter((k) => k.grade === 'weak').length} weak)`);
  return { kinds, failing, dir };
}

/* ---------------------------------------------------------------- rebuild */

/**
 * One batch of kinds, all in the same file. Returns the agent's report.
 */
function rebuildBatch(owner, items, round, idx, total, dir) {
  return agent(`${BASE}

REBUILD — round ${round}, batch ${idx + 1} of ${total} for ${OWNERS[owner]}.

YOU OWN EXACTLY ONE FILE: ${OWNERS[owner]}
Other agents are working elsewhere in this tree. Do not touch any other file.
No other agent is in YOUR file right now, so you can edit it freely — batches
for the same file are run one after another precisely so that is true.

These ${items.length} kinds were photographed alone and judged below standard.
REMAKE THEM. All of them. Not a tweak — look at what the object actually is and
build it out of the parts it would really have.

${items.map((g, i) => `${i + 1}. ${g.kind}   [${g.grade}]
   SEEN: ${g.verdict}
   DO:   ${g.rebuild || '(no instruction given — apply the standard yourself)'}`).join('\n\n')}

Reference images: ${dir}/<kind>.png — OPEN EACH ONE before you rebuild it.
You cannot fix what you have not looked at.

HOW TO REBUILD WELL
- Start from the real object. A parking meter is a post, a head with a display
  and a coin slot, and a base plate. Build those parts, then detail them.
- Chamfer or bevel every hard edge. Raw box corners are the loudest tell.
- Two materials minimum where two materials are real: a metal frame and timber
  slats are not one grey.
- Vary per instance — colour, scale, rotation, and where it matters the model
  itself. Two or three bench variants, not one bench repeated four hundred times.
- Add the small stuff that sells it: bolts, joints, handles, a strap, a hinge,
  signage, wear at the ground line.
- It is a stylised game seen from 40 m as well as 3 m. The SILHOUETTE has to
  read at distance; the detail has to hold up close. Both, not one.

CONSTRAINTS THAT WILL BITE YOU
- worldBuild MEASURES ground-contact geometry to derive each prop's physics
  footprint, so changing a model changes how it is eaten. Keep the lowest fifth
  of the geometry as the part that genuinely rests on the ground.
- Triangle budget: these are instanced in their thousands. Check the instance
  count and current triangle count in ${dir}/catalogue.json. A bench at 2,000
  instances cannot afford what a landmark at 3 instances can. Report your delta.
- Everything procedural. No new dependencies, no image files.

VERIFY BEFORE YOU FINISH — this is not optional:
  1. node --check ${OWNERS[owner]}
  2. node tools/prop-catalogue.mjs --match ${items.map((g) => g.kind).join(',')} --out shots/rb-${round}-${owner}-${idx}
  3. OPEN every image you just produced and look at it. If it still looks cheap,
     do it again. You are the last reviewer before it ships.
  4. node tools/consume-test.mjs — confirm the physics did not regress.

Report per kind: what it is built from now, its triangle delta, and one line on
what changed visually. If you could not finish a kind, say which and why —
do not claim a kind you did not rebuild.`,
  { label: `rb:${owner}#${idx + 1}`, phase: 'Rebuild' });
}

/* -------------------------------------------------------------------- run */

let round = 1;
let lastFailing = [];
const history = [];

while (round <= MAX_ROUNDS) {
  const { kinds, failing, dir } = await regrade(round);
  history.push({ round, judged: kinds.length, failing: failing.length });
  lastFailing = failing;

  if (!failing.length) { log(`round ${round}: everything is at standard — stopping`); break; }

  phase('Rebuild');

  // Group by owning file, then split each group into batches this size.
  const byOwner = new Map();
  for (const g of failing) {
    if (!byOwner.has(g.owner)) byOwner.set(g.owner, []);
    byOwner.get(g.owner).push(g);
  }

  const plan = [...byOwner.entries()].map(([owner, items]) => {
    const batches = [];
    for (let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH));
    return { owner, batches };
  }).sort((a, b) => b.batches.length - a.batches.length);

  log(`round ${round} rebuild plan: ` +
      plan.map((p) => `${p.owner} ${p.batches.length}x`).join(', ') +
      ` — ${plan.length} file(s) in parallel, batches within a file run in sequence`);

  // Chains run concurrently with each other; batches inside a chain run one at
  // a time, so exactly one agent is ever inside a given file.
  await parallel(plan.map(({ owner, batches }) => async () => {
    const out = [];
    for (let i = 0; i < batches.length; i++) {
      out.push(await rebuildBatch(owner, batches[i], round, i, batches.length, dir));
    }
    return out;
  }));

  round++;
}

/* ------------------------------------------------------------------ verify */

phase('Verify');

const verdict = await agent(`${BASE}

FINAL VERIFICATION of the prop rebuild.

Rounds run: ${history.map((h) => `r${h.round}: ${h.failing}/${h.judged} failing`).join(', ')}

Do all of this and report honestly, including anything still wrong:

1. node --check on every file under src/world/ and src/core/materials.js.
2. node tools/consume-test.mjs — the physics regression suite. Nothing may have
   regressed: props must still lose support, tip, and fall cleanly into the hole.
3. node tools/prop-audit.mjs — placement. Nothing floating, sunken, in the water
   or mis-sized. Compare against the last known-good numbers if the tool prints
   them.
4. node tools/perf-audit.mjs — triangle count and draw calls for the whole city.
   Report the totals and whether the rebuild made the city more expensive. If
   triangles went up more than 25%, say so plainly and name the worst kinds.
5. Boot the game headlessly (tools/shot.mjs) and confirm zero console errors.

Then take a final look: photograph a representative street slice of the city at
the game camera and say, as a harsh reviewer, whether it now meets the standard.

Report: the numbers from each tool, what is still below standard, and what you
would do next. Do not report success you did not verify.`,
  { label: 'verify', phase: 'Verify', effort: 'high' });

return {
  rounds: history,
  stillFailing: lastFailing.map((g) => ({ kind: g.kind, grade: g.grade, owner: g.owner })),
  verdict: String(verdict || '').slice(0, 6000),
};
