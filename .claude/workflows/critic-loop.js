export const meta = {
  name: 'miami-critic-loop',
  description: 'Harsh visual critique -> targeted fixes -> re-critique, looping until every reviewer passes the blind test',
  phases: [
    { title: 'Capture', detail: 'render the canonical preset set for this round' },
    { title: 'Critique', detail: 'independent harsh reviewers, one per dimension' },
    { title: 'Fix', detail: 'one fixer per owning file, findings routed by ownership' },
    { title: 'Verify', detail: 'blind A/B of this round against the previous one' },
  ],
};

const CWD = '/Users/sam/untitled folder 6';
const MAX_ROUNDS = Number((args && args.rounds) || 3);
const START = Number((args && args.startRound) || 1);

/** Which module owns which class of defect. Findings are routed by this. */
const OWNERS = {
  buildings: 'src/world/buildings.js',
  streets: 'src/world/streets.js',
  props: 'src/world/props.js',
  vehicles: 'src/world/vehicles.js',
  pedestrians: 'src/world/pedestrians.js',
  nature: 'src/world/nature.js',
  water: 'src/world/water.js',
  lighting: 'src/core/engine.js + src/core/quality.js + src/render/postfx.js',
  materials: 'src/core/materials.js + src/render/palette.js',
  hole: 'src/gameplay/hole.js + src/render/groundShader.js + src/render/effects.js',
  ui: 'src/ui/hud.js + src/ui/screens.js + src/ui/styles.css',
};

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'blindTest', 'scores', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    blindTest: {
      type: 'string',
      description: 'One sentence: shown this next to Hole.io blind, which would you pick and why.',
    },
    scores: {
      type: 'object',
      additionalProperties: { type: 'number' },
      description: 'Rubric category -> 1..10',
    },
    findings: {
      type: 'array',
      maxItems: 14,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'owner', 'preset', 'what', 'where'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          owner: { type: 'string', description: 'one of: ' + Object.keys(OWNERS).join(', ') },
          preset: { type: 'string' },
          where: { type: 'string', description: 'where in the frame' },
          what: { type: 'string', description: 'the specific defect, not a vibe' },
          fix: { type: 'string', description: 'concrete suggested fix' },
        },
      },
    },
  },
};

const BASE = `
PROJECT: ${CWD}  (cd there first; the path contains a space, so QUOTE IT)
MIAMI DEVOUR — a Hole.io-style city-eating game in Three.js.
A Vite dev server is already running on http://localhost:5173.

Read docs/ART_DIRECTION.md and docs/REVIEW_RUBRIC.md before anything else.

KNOWN SUSPECTS carried over from earlier waves — check these specifically, and
report them if they are still visible (do not assume they were fixed):
  · GRADE.neutralise in src/core/quality.js is 0.62. It was added to cancel a
    blue-grey asphalt albedo that has since been warmed at source, so it is
    very likely double-correcting; sunlit surfaces were measured at R:B
    1.24-1.28, which is too orange. Owner: lighting.
  · GRADE.exposure was unstable during tuning (1.62 clipped the whole frame;
    0.82-1.15 landed sanely). Verify nothing large clips white. Owner: lighting.
  · Facade UV scale vs texture grid: a texture drawn with 24 floors mapped onto
    a 3.6 m tile makes a storey 15 cm tall. Check storey height reads as ~3.4 m
    on every building. Owner: buildings.
  · Sidewalk paving repeats every 3 m. Owner: streets.
`;

let previousDir = null;

for (let round = START; round < START + MAX_ROUNDS; round++) {
  const dir = `shots/round${round}`;

  /* ------------------------------------------------------------- capture */
  phase('Capture');
  await agent(`${BASE}

Render the canonical review set for round ${round}:

  cd "${CWD}" && node tools/shot.mjs --all --out ${dir} --w 1600 --h 900

This can take several minutes under software GL — let it finish. Then confirm
${dir}/report.json exists and report:
  - the number of shots written,
  - the contents of the 'errors' array (verbatim, truncated to one line each),
  - drawCalls and triangles per preset.

If the run fails or errors is non-empty, say so plainly and clearly — do not fix
anything yourself, and do not hide it.
`, { label: `capture-r${round}`, phase: 'Capture' });

  /* ------------------------------------------------------------ critique */
  phase('Critique');
  const LENSES = [
    {
      key: 'colour-light',
      presets: 'brickell-skyline, street-level, park, waterfront, menu-hero',
      brief: `You are reviewing COLOUR, LIGHT and GRADE only.
Judge: palette discipline, warmth of the asphalt, whether sidewalks are blown
out, shadow presence/softness/direction, contact shadows, value separation
between ground and buildings, exposure (nothing large clipping white or crushed
black), bloom restraint, and whether the whole thing reads as sun-drenched
Miami rather than an overcast render.
Sample actual pixel values if you are unsure — you can read the PNGs.`,
    },
    {
      key: 'architecture',
      presets: 'brickell-skyline, downtown-wide, rooftops, construction, hole-big',
      brief: `You are reviewing ARCHITECTURE and SILHOUETTE only.
Judge: skyline rhythm (height/width/colour variety), whether any building is
still an untextured or under-articulated box, podiums, setbacks, crowns, roof
population (roofs are on screen constantly), facade detail at distance and up
close, bevelling, and whether landmarks read as landmarks.`,
    },
    {
      key: 'street-detail',
      presets: 'street-level, intersection, crowd, hole-small',
      brief: `You are reviewing STREET-LEVEL DETAIL only.
Judge: crosswalk and lane markings (do they read as road marking or as loose
white rectangles?), kerb and gutter detail, prop density and variety, whether
props are correctly grounded (nothing floating or sunk), pedestrian presence and
whether they look like people, vehicle quality, and texture density up close.
This is what the player stares at for the first minute of every match.`,
    },
    {
      key: 'water-nature',
      presets: 'waterfront, river, park, menu-hero',
      brief: `You are reviewing WATER, NATURE and PUBLIC SPACE only.
Judge: does the bay look like Biscayne Bay or like a flat cyan plane with
speckles; shoreline silhouette and whether marina basins actually hold water;
foam behaviour; reflections; palms and trees (species variety, frond quality,
whether they look like cards); parks and plazas (are they bare?); planting;
fountains.`,
    },
    {
      key: 'game-readability',
      presets: 'hole-small, hole-mid, hole-big, occlusion, intersection',
      brief: `You are reviewing GAMEPLAY READABILITY only — this is the one that
decides whether the game is playable, not just pretty.
Judge: is the hole unmistakably the darkest, most attention-grabbing thing on
screen at every size; is its lip clean and its depth believable; can you tell at
a glance what is edible; does the occlusion fade keep the hole visible under
buildings while preserving their silhouette; is the camera framing right at each
size; is anything camouflaged against anything else.`,
    },
    {
      key: 'polish',
      presets: 'all of them — sweep every png in the directory',
      brief: `You are the POLISH and DEFECT sweep. Open EVERY png in the round
directory. You are looking for concrete, objective faults only:
z-fighting, seams, gaps, geometry interpenetration, stretched or swimming UVs,
visible texture tiling, objects floating or half-buried, camera clipping through
geometry, shader artefacts, banding, aliasing, anything that is obviously
broken. Be forensic. Name the exact preset and the exact place in the frame.`,
    },
  ];

  const reviews = await parallel(LENSES.map((lens) => () => agent(`${BASE}

ROUND ${round} REVIEW — lens: ${lens.key.toUpperCase()}

Screenshots for this round are already rendered in: ${dir}
Look at these presets in particular: ${lens.presets}
(the full set is in that directory; open any others you need)

${lens.brief}

METHOD — follow it exactly:
1. Open the PNGs with the Read tool. Actually look at them. You may not report
   anything you have not seen.
2. Apply docs/REVIEW_RUBRIC.md. Run the blind test described at the top of it.
3. Be HARSH. Your job is to find the reason a player would call this a hobby
   project. "Looks good" is a failed review. If you cannot find at least three
   real defects you are not looking hard enough — but do not invent defects
   either; every finding must be visible in a specific image.
4. Route each finding to the module that owns it. Valid owners:
${Object.entries(OWNERS).map(([k, v]) => `     ${k.padEnd(12)} ${v}`).join('\n')}
5. verdict is PASS only if you would genuinely pick this over Hole.io in a blind
   comparison AND there are no blocker findings.

Return the structured object. Nothing else.
`, { label: `critic:${lens.key}`, phase: 'Critique', schema: FINDINGS_SCHEMA })));

  const valid = reviews.filter(Boolean);
  const all = valid.flatMap((r) => r.findings || []);
  const blockers = all.filter((f) => f.severity === 'blocker');
  const passes = valid.filter((r) => r.verdict === 'PASS').length;

  log(`Round ${round}: ${passes}/${valid.length} lenses PASS, ` +
      `${all.length} findings (${blockers.length} blockers)`);
  for (const r of valid) log(`  · ${r.blindTest}`);

  if (valid.length && passes === valid.length && blockers.length === 0) {
    log(`Round ${round}: every lens passed the blind test. Stopping.`);
    return { round, status: 'PASSED', reviews: valid };
  }

  /* ----------------------------------------------------------------- fix */
  phase('Fix');
  const byOwner = new Map();
  for (const f of all) {
    const key = OWNERS[f.owner] ? f.owner : 'polish-unrouted';
    if (!byOwner.has(key)) byOwner.set(key, []);
    byOwner.get(key).push(f);
  }
  // Deal with the busiest modules first; they gate everything else visually.
  const owners = [...byOwner.entries()]
    .filter(([k]) => OWNERS[k])
    .sort((a, b) => b[1].length - a[1].length);

  const unrouted = byOwner.get('polish-unrouted') || [];
  if (unrouted.length) {
    log(`${unrouted.length} finding(s) had no valid owner and were dropped:`);
    for (const f of unrouted.slice(0, 6)) log(`   ? [${f.owner}] ${f.what}`);
  }

  await parallel(owners.map(([owner, findings]) => () => agent(`${BASE}

ROUND ${round} FIX PASS — you own: ${OWNERS[owner]}

Independent harsh reviewers just went over round ${round}'s screenshots
(in ${dir}) and raised ${findings.length} finding(s) against your module.
Other agents are fixing other modules in this same working tree AT THE SAME
TIME, so edit ONLY the file(s) listed above.

FINDINGS:
${findings.map((f, i) => `${i + 1}. [${f.severity}] preset "${f.preset}", ${f.where}
   PROBLEM: ${f.what}
   SUGGESTED: ${f.fix || '(none given — use your judgement)'}`).join('\n\n')}

RULES:
- Fix every blocker. Fix every major. Fix minors if they are cheap.
- If you believe a finding is wrong, say so in your report WITH the evidence
  (which image, what you actually see) — do not silently ignore it.
- Reproduce each defect in a screenshot BEFORE you change anything, so you know
  you are fixing the real thing, then screenshot again AFTER to prove the fix:
    cd "${CWD}" && node tools/shot.mjs --presets <relevant> --out shots/r${round}-fix-${owner} --w 1600 --h 900
  Read the PNGs with the Read tool. Never claim a fix you have not seen work.
- Do not regress anything else. Check at least two other presets.
- Keep the performance budget: <= 1,500 draw calls, <= 1.8M triangles on
  menu-hero. Report your numbers.
- Never rename or remove exports other modules import.

Report: per finding, FIXED / PARTIAL / REJECTED (with evidence), plus your
before/after draw-call and triangle numbers.
`, { label: `fix:${owner}`, phase: 'Fix' })));

  /* -------------------------------------------------------------- verify */
  phase('Verify');
  const prev = previousDir;
  await agent(`${BASE}

ROUND ${round} VERIFY.

1. Re-render the full set AFTER this round's fixes:
     cd "${CWD}" && node tools/shot.mjs --all --out ${dir}-after --w 1600 --h 900
2. ${dir}-after/report.json 'errors' MUST be empty. If it is not, fix the errors
   (any file) until it is, then re-render.
3. Build a blind A/B sheet against ${prev ? `the previous round (${prev})` : `this round's BEFORE state (${dir})`}:
     node tools/compare.mjs --ab ${prev || dir} ${dir}-after --out shots/ab-r${round}.png --blind
   Open shots/ab-r${round}.png with the Read tool. For each row decide which
   side you prefer and WHY, WITHOUT reading the .key.json file first.
   Then read shots/ab-r${round}.key.json and report how many rows the newer
   build won.
4. Report the per-preset drawCalls/triangles, and state plainly whether this
   round made the game better, neutral, or worse.

Honesty matters more than a good result here. If a fix made something worse,
say which one and how.
`, { label: `verify-r${round}`, phase: 'Verify' });

  previousDir = `${dir}-after`;
}

return { status: 'ROUNDS_EXHAUSTED', rounds: MAX_ROUNDS, lastDir: previousDir };
