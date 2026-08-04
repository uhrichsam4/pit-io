export const meta = {
  name: 'miami-prop-quality',
  description: 'Photograph every prop kind alone, judge each one, then rebuild the ones that are not good enough',
  phases: [
    { title: 'Catalogue', detail: 'photograph all ~211 prop kinds in isolation' },
    { title: 'Judge', detail: 'parallel reviewers grade every kind individually' },
    { title: 'Rebuild', detail: 'remake the failing models, by owning module' },
    { title: 'Reshoot', detail: 're-photograph and confirm each rebuilt kind improved' },
  ],
};

const CWD = '/Users/sam/untitled folder 6';
const CAT = 'shots/catalogue';

const OWNERS = {
  props: 'src/world/props.js',
  nature: 'src/world/nature.js',
  vehicles: 'src/world/vehicles.js',
  pedestrians: 'src/world/pedestrians.js',
  streets: 'src/world/streets.js',
  buildings: 'src/world/buildings.js',
  water: 'src/world/water.js',
  materials: 'src/core/materials.js + src/render/palette.js',
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
PROJECT: ${CWD}  (cd there first; the path has a space, so QUOTE IT)
MIAMI DEVOUR — a Hole.io-style Miami city-eating game in Three.js.
Read docs/ART_DIRECTION.md first.

THE STANDARD: this city must not contain a single prop that looks cheaped out
on. Every object should read as deliberately made — believable proportions,
bevelled edges rather than raw boxes, material and colour variation, and enough
small detail (slats, bolts, handles, signage, wear) to hold up close, because
the player drives past these at three metres for the whole first minute.
`;

/* -------------------------------------------------------------- catalogue */

phase('Catalogue');

const cat = await agent(`${BASE}

You are the CATALOGUE agent. Nothing downstream can start until you finish.

Photograph EVERY prop kind in the city, alone and close up:

  cd "${CWD}" && node tools/prop-catalogue.mjs --out ${CAT} --size 340

There are roughly 211 kinds, so this takes a while. Let it run. If it reports
kinds that timed out, re-run just those with --match.

Then build contact sheets so reviewers can scan many at once:
  node tools/compare.mjs --sheet ${CAT} --out ${CAT}/sheet.png --cols 6

Report: how many kinds were photographed, which timed out, and any runtime
errors verbatim. ${CAT}/catalogue.json lists every kind with its instance
count, measured size and triangle count.
`, { label: 'catalogue', phase: 'Catalogue' });

/* ------------------------------------------------------------------ judge */

phase('Judge');

// Split the alphabet so each reviewer owns a slice and every kind is judged
// exactly once.
const SLICES = [
  ['a-b', 'kinds starting a through b'],
  ['c-d', 'kinds starting c through d'],
  ['e-g', 'kinds starting e through g'],
  ['h-l', 'kinds starting h through l'],
  ['m-p', 'kinds starting m through p'],
  ['q-s', 'kinds starting q through s'],
  ['t-z', 'kinds starting t through z'],
];

const graded = await parallel(SLICES.map(([slice, desc]) => () => agent(`${BASE}

You are a MODEL QUALITY JUDGE. Read-only — do NOT edit any file.

Catalogue agent's report:
${(cat || 'catalogue may be incomplete — work with whatever is in the directory').slice(0, 1200)}

YOUR SLICE: ${desc}.
List ${CAT}/ and read EVERY png whose filename falls in your slice. Also read
${CAT}/catalogue.json for each kind's instance count, measured size and
triangle count.

For each kind, grade it:
  good  — genuinely well made. Would not embarrass the game in a close-up.
  weak  — recognisable and correctly proportioned, but plain: missing detail,
          flat colour, no wear, too few sides, reads as "programmer art".
  bad   — a placeholder. An untextured box, a cylinder standing in for an
          object, wrong proportions, razor edges, unreadable silhouette, or
          simply not identifiable as the thing it is named after.

Be honest and be harsh. A grade of "good" for something plain wastes the whole
exercise. Equally, do not mark something bad because it is SMALL — a bollard
is allowed to be simple; judge it against what that object should look like.

Weight your attention by instance count: a kind with 1,200 copies in the city
matters far more than one with 3.

For every weak or bad kind, write a CONCRETE rebuild instruction — what shape
it should be, what parts it needs, what materials and colour variation, what
detail would make it read. "Make it better" is useless; "give the bench cast
iron end frames with a scroll, five timber slats with gaps, and vary the timber
tone per instance" is useful.

Route each to its owning module:
${Object.entries(OWNERS).map(([k, v]) => `  ${k.padEnd(12)} ${v}`).join('\n')}
Street furniture and city clutter is props; trees and planting is nature;
anything on wheels or in the water is vehicles; people is pedestrians; road
surface, kerbs, markings and signage gantries is streets.

Return the structured object covering EVERY kind in your slice.
`, { label: `judge:${slice}`, phase: 'Judge', schema: GRADES })));

const all = graded.filter(Boolean).flatMap((g) => g.graded || []);
const bad = all.filter((g) => g.grade === 'bad');
const weak = all.filter((g) => g.grade === 'weak');
const good = all.filter((g) => g.grade === 'good');
log(`graded ${all.length} kinds — ${good.length} good, ${weak.length} weak, ${bad.length} bad`);

/* ---------------------------------------------------------------- rebuild */

phase('Rebuild');

const byOwner = new Map();
for (const g of [...bad, ...weak]) {
  if (!OWNERS[g.owner]) continue;
  if (!byOwner.has(g.owner)) byOwner.set(g.owner, []);
  byOwner.get(g.owner).push(g);
}
const owners = [...byOwner.entries()].sort((a, b) => b[1].length - a[1].length);
log(`rebuilding across ${owners.length} module(s): ${owners.map(([k, v]) => `${k}(${v.length})`).join(' ')}`);

const rebuilt = await parallel(owners.map(([owner, items]) => () => agent(`${BASE}

REBUILD PASS — you own: ${OWNERS[owner]}

Every prop kind in the city was photographed alone and graded by independent
reviewers. ${items.length} of yours did not meet the standard. REMAKE THEM.

${items.map((g, i) => `${i + 1}. ${g.kind}  [${g.grade}]
   VERDICT: ${g.verdict}
   REBUILD: ${g.rebuild || '(no instruction given — use your judgement against the standard)'}`).join('\n\n')}

Reference images are in ${CAT}/<kind>.png — LOOK at each one before you remake it.

HOW TO REBUILD WELL
- Start from what the object actually is. A parking meter has a post, a head
  with a display and a coin slot, a base plate. Build those parts.
- Bevel or chamfer everything. Raw box edges are the single loudest tell.
- Give it material variation: a metal frame and timber slats are different
  materials, not one grey.
- Vary per instance: colour, scale, rotation, and where sensible the model
  itself (two or three variants of a bench, not one repeated 400 times).
- Add the small stuff that sells it: bolts, joints, handles, signage, a strap,
  visible wear at the base.
- Keep the silhouette readable from the game camera — this is a stylised game
  seen from 40 metres up, so detail must survive at that distance too.

CONSTRAINTS
- Edit ONLY the files listed above. Other agents are working in this tree.
- worldBuild MEASURES ground-contact geometry to derive the physics footprint,
  so changing a model changes its physics. Keep the lowest fifth of the
  geometry as the part that genuinely rests on the ground, and re-run
  node tools/consume-test.mjs to confirm nothing regressed.
- Triangle budget: these are instanced thousands of times. A bench may afford
  ~150 triangles; a bollard may not afford 150. Check the counts in
  ${CAT}/catalogue.json and keep the expensive kinds lean. Report your delta.
- No new npm dependencies, no binary assets — everything procedural.

VERIFY: re-photograph your kinds and LOOK at them:
  node tools/prop-catalogue.mjs --match <your,kinds> --out shots/rebuilt-${owner}
Read every image. If it still looks cheap, do it again.

Report per kind: what you rebuilt and what it now has.
`, { label: `rebuild:${owner}`, phase: 'Rebuild' })));

/* ---------------------------------------------------------------- reshoot */

phase('Reshoot');

const reshoot = await agent(`${BASE}

FINAL CHECK on the prop rebuild.

Rebuild reports:
${rebuilt.map((r, i) => `--- ${owners[i] ? owners[i][0] : i} ---\n${(r || 'FAILED').slice(0, 1200)}`).join('\n\n')}

DO:
1. Confirm the game still boots with no page errors.
2. node tools/consume-test.mjs — the physics contract must still hold. A
   rebuilt model changes its measured footprint, so this is the real risk.
3. node tools/prop-audit.mjs — nothing newly floating, sunken or oversized.
4. Re-photograph everything: node tools/prop-catalogue.mjs --out shots/catalogue-v2
   then node tools/compare.mjs --sheet shots/catalogue-v2 --out shots/catalogue-v2/sheet.png --cols 6
5. Compare against ${CAT}/. For each kind that was graded weak or bad, say
   whether it actually improved. Name any that did not.
6. node tools/perf-audit.mjs — report the triangle delta. Rebuilding models
   adds geometry; say by how much.

Then append to docs/FINAL_QA.md a section "Prop quality pass": how many kinds
were graded, how many rebuilt, which are still below standard and why.

Be honest. Naming a prop that is still poor is far more useful than claiming
they are all fixed.
`, { label: 'reshoot', phase: 'Reshoot' });

return {
  graded: all.length, good: good.length, weak: weak.length, bad: bad.length,
  rebuiltModules: owners.map(([k, v]) => `${k}:${v.length}`),
  reshoot,
};
