export const meta = {
  name: 'miami-review-fanout',
  description: 'Capture once, then 20 read-only reviewers in parallel, then route findings to fixers and verify',
  phases: [
    { title: 'Capture', detail: 'one agent renders the whole evidence set' },
    { title: 'Review', detail: '20 parallel read-only reviewers, one lens each' },
    { title: 'Fix', detail: 'findings routed to the file that owns them' },
    { title: 'Verify', detail: 're-capture, re-test, confirm nothing regressed' },
  ],
};

const CWD = '/Users/sam/untitled folder 6';
const SHOTS = 'shots/review';

/** Which file owns which class of defect. Findings are routed by this. */
const OWNERS = {
  streets: 'src/world/streets.js',
  layout: 'src/world/cityLayout.js',
  water: 'src/world/water.js',
  props: 'src/world/props.js',
  nature: 'src/world/nature.js',
  buildings: 'src/world/buildings.js',
  materials: 'src/core/materials.js + src/render/palette.js',
  vehicles: 'src/world/vehicles.js',
  pedestrians: 'src/world/pedestrians.js',
  hole: 'src/gameplay/hole.js + src/render/groundShader.js + src/render/effects.js',
  physics: 'src/gameplay/consume.js + src/gameplay/entities.js + src/core/pools.js',
  occlusion: 'src/render/occlusion.js + src/game.js',
  lighting: 'src/core/engine.js + src/core/quality.js + src/render/postfx.js',
  ui: 'src/ui/hud.js + src/ui/screens.js + src/ui/styles.css + src/ui/minimap.js',
  flow: 'src/game.js + src/gameplay/match.js',
  ai: 'src/gameplay/ai.js',
};

const FINDINGS = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'blindTest', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    blindTest: { type: 'string', description: 'One sentence: shown this beside Hole.io blind, which would you pick and why.' },
    findings: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'owner', 'evidence', 'what', 'fix'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          owner: { type: 'string', description: 'one of: ' + Object.keys(OWNERS).join(', ') },
          evidence: { type: 'string', description: 'exact image filename, and where in the frame' },
          what: { type: 'string', description: 'the specific defect, not a vibe' },
          fix: { type: 'string', description: 'concrete suggested fix' },
        },
      },
    },
  },
};

const BASE = `
PROJECT: ${CWD}  (cd there first; the path has a space, so QUOTE IT)
MIAMI DEVOUR — a Hole.io-style Miami city-eating game in Three.js.

Read docs/ART_DIRECTION.md and docs/REVIEW_RUBRIC.md before anything else.
`;

/* ---------------------------------------------------------------- capture */

phase('Capture');

await agent(`${BASE}

You are the CAPTURE agent. Twenty reviewers are waiting on you, and they will
read your output rather than rendering their own — that is what makes twenty
parallel reviewers affordable. Be thorough; they cannot ask for more later.

Render EVERYTHING into ${SHOTS}/ :

1. Every preset, day:
   node tools/shot.mjs --all --out ${SHOTS}/day --w 1600 --h 900
2. Every preset, night:
   node tools/shot.mjs --all --out ${SHOTS}/night --w 1600 --h 900 --script "__GAME__.engine.setTimeOfDay(0.87)"
3. Golden hour, the presets where it matters:
   node tools/shot.mjs --presets brickell-skyline,street-level,waterfront,park --out ${SHOTS}/golden --script "__GAME__.engine.setTimeOfDay(0.74)"
4. Every hole size — the player's actual experience:
   for r in 2 4 8 16 32: shoot hole-mid with --script "DEV.setSize(<r>)"
   into ${SHOTS}/size-<r>
5. UI, at three resolutions, with --ui:
   1280x720, 1920x1080, and 2560x1440 into ${SHOTS}/ui-<w>
6. The end-of-match screen:
   --ui --script "__GAME__.screens.showResults(__GAME__.match.summary(__GAME__.player), __GAME__.player)"
   into ${SHOTS}/ui-results
7. A swallow sequence:
   node tools/seq.mjs --size 7 --frames 8 --out ${SHOTS}/seq
8. Occlusion behaviour: the 'occlusion' preset day and night.

Then run and SAVE the machine-readable reports so reviewers can read them
without launching a browser:
   node tools/prop-audit.mjs --json  > ${SHOTS}/prop-audit.txt
   node tools/perf-audit.mjs         > ${SHOTS}/perf-audit.txt
   node tools/consume-test.mjs       > ${SHOTS}/consume-test.txt  2>&1
   node tools/restart-test.mjs       > ${SHOTS}/restart-test.txt  2>&1

RUN ONE TOOL AT A TIME — nothing else is competing with you right now, and
serial is faster than thrashing. If a shot times out, lower the resolution for
that one and note it.

Report: the full list of files written, and any runtime errors verbatim.
`, { label: 'capture', phase: 'Capture' });

/* ----------------------------------------------------------------- review */

phase('Review');

const LENSES = [
  ['roads-markings', 'day/intersection.png, day/street-level.png, day/downtown-wide.png, day/hole-small.png',
   `Lane markings, centre lines, turn arrows, stop bars, box junctions, bus and cycle lanes, hatching, parking bays, worn paint. Do markings read as ROAD MARKING or as loose white shapes? Do they line up with where cars actually drive?`],
  ['intersections', 'day/intersection.png, day/street-level.png, night/intersection.png',
   `Junction geometry: kerb radii, crossings on every approach, stop lines, signals, keep-clear boxes, drainage. Does traffic path through the junction make sense? Anything misaligned or unfinished?`],
  ['sidewalks-kerbs', 'day/street-level.png, day/crowd.png, day/intersection.png',
   `Kerb profile and continuity, gutter, ramps at crossings, expansion joints, slab variation, tree pits, drain and manhole covers. Any sidewalk that stops mid-block, any kerb that steps or breaks.`],
  ['prop-placement', 'day/street-level.png, day/crowd.png, day/park.png, day/construction.png',
   `Are props placed LOGICALLY? Street furniture on sidewalks facing the street, café furniture outside its restaurant, construction props in construction zones, nothing in the carriageway or on a crossing. Floating, sunk, overlapping, awkwardly rotated, wrongly scaled, or unreachable props. Also read ${SHOTS}/prop-audit.txt.`],
  ['prop-quality', 'day/street-level.png, day/crowd.png, size-2/hole-mid.png',
   `Model and material QUALITY up close. Anything still reading as a placeholder: untextured, flat-shaded, razor-edged, no detail. These are what the player stares at for the first minute of every match.`],
  ['repetition', 'day/street-level.png, day/downtown-wide.png, day/brickell-skyline.png, day/park.png',
   `ANTI-REPETITION is a stated requirement. Hunt for rows of identical assets, identical rotations, identical colours, obvious copy-paste rhythm in props, buildings, trees and vehicles.`],
  ['architecture', 'day/brickell-skyline.png, day/downtown-wide.png, day/menu-hero.png, day/hole-big.png',
   `Skyline rhythm and silhouette: height, width, colour and crown variety. Any building still an under-articulated box. Podiums, setbacks, crowns. Do landmarks read as landmarks?`],
  ['facades', 'day/street-level.png, day/intersection.png, day/crowd.png',
   `Facades at close range: window and mullion rhythm, storey height (should read ~3.4 m), balconies, ground-floor glazing, entrances, signage, awnings. Stretched or mis-scaled facade textures.`],
  ['rooftops', 'day/rooftops.png, day/brickell-skyline.png, night/rooftops.png',
   `Roofs are on screen almost every frame from this camera. Parapets, plant, ducts, tanks, stair bulkheads, helipads, pools. Any bare or untextured roof.`],
  ['glass', 'day/brickell-skyline.png, golden/brickell-skyline.png, night/brickell-skyline.png',
   `Curtain wall quality: mullion grid, per-pane variation, reflections, spandrels, lit interiors. Does glass read as glass at distance and up close, at all three times of day?`],
  ['water', 'day/waterfront.png, day/river.png, night/waterfront.png, golden/waterfront.png',
   `Bay and river: depth grading, foam following the real coastline, reflections, sun and moon glitter, shoreline silhouette, marina basins holding water. AT NIGHT the bay must be DARKER than the lit city — a previous review measured it glowing brighter, which is a blocker.`],
  ['parks-planting', 'day/park.png, day/street-level.png, day/waterfront.png',
   `Parks and plazas: are they bare? Paths, beds, hedges, benches, play equipment, water features, lawn quality. Planting that reads as designed rather than scattered.`],
  ['trees', 'day/street-level.png, day/park.png, day/brickell-skyline.png',
   `Palms and trees specifically: species variety, trunk height and lean, crown size, frond quality and droop, colour variation. Do they look like flat cards? Are they repeated? Do any obscure the player?`],
  ['vehicles', 'day/intersection.png, day/street-level.png, day/crowd.png, night/intersection.png',
   `Vehicle model quality, proportions, glass, wheels sitting on the road, lights, variety including Miami luxury and exotics. Placement: in lanes and bays, not on pavements or in scenery. Headlights at night.`],
  ['pedestrians', 'day/crowd.png, day/street-level.png, day/park.png, night/crowd.png',
   `Do the people look like people? Poses, proportions, clothing variety, behaviours, café crowds, groups, content creators. Anyone standing inside a bench, planter or shelter. Conga lines or repeated patterns.`],
  ['the-hole', 'size-2/hole-mid.png, size-8/hole-mid.png, size-32/hole-mid.png, seq/f00.png, seq/f04.png',
   `The hole itself: is it unmistakably the darkest, most attention-grabbing thing on screen at EVERY size? Lip quality, depth, the torn edge, the contact shadow. And in the seq frames: do objects visibly slide, tip and fall, with nothing spinning wildly, orbiting, hovering or stuck on the rim?`],
  ['occlusion', 'day/occlusion.png, night/occlusion.png, day/street-level.png',
   `ONLY large buildings may fade. Confirm the fade is subtle, that the building's silhouette stays readable, and that the hole is clearly visible underneath. CRITICALLY: check no tree, car, bench, sign or small prop is fading anywhere in any image — that is a defect.`],
  ['lighting-shadows', 'day/street-level.png, day/brickell-skyline.png, day/park.png, golden/street-level.png',
   `Shadow presence, direction, softness and correctness. Do shadows GROUND objects, or do props look like stickers on the pavement? Acne, peter-panning, swimming, missing contact shadows. Exposure: nothing large clipping white or crushed black.`],
  ['night', 'night/street-level.png, night/brickell-skyline.png, night/crowd.png, night/waterfront.png',
   `Night must read as night by HUE and by the city lighting up — never by being too dark to play. Check: lit windows, streetlights, headlights, signage, neon. Is the playfield still clearly readable? Is anything invisible?`],
  ['ui-and-flow', 'ui-1280/hole-mid.png, ui-1920/hole-mid.png, ui-2560/hole-mid.png, ui-results/hole-mid.png',
   `HUD at three resolutions: overlap, clipping, unreadable text, scaling, minimap legibility, leaderboard correctness, size meter. The results screen: layout, hierarchy, both buttons present. Also read ${SHOTS}/restart-test.txt for the flow regression results.`],
];

const reviews = await parallel(LENSES.map(([key, files, brief]) => () => agent(`${BASE}

REVIEW LENS: ${key.toUpperCase()}

You are a READ-ONLY reviewer. Do NOT edit any file. Your entire job is to look
hard and report precisely.

The evidence is already rendered — do NOT run any screenshot tool, and do not
launch a browser. Nineteen other reviewers are working from the same images.

Open these with the Read tool, plus any others in ${SHOTS}/ you want:
  ${files}

${brief}

METHOD
1. Actually open the images. You may not report anything you have not seen.
2. Apply docs/REVIEW_RUBRIC.md, including its blind test.
3. Be HARSH. Your job is to find the reason a player would call this a hobby
   project. "Looks good" is a failed review. If you genuinely cannot find a
   real defect, say so and explain what you checked — but do not invent one,
   and do not report anything you cannot point at in a specific image.
4. Every finding needs: the exact image filename, where in the frame, the
   specific defect, and a concrete fix.
5. Route each finding to the file that owns it:
${Object.entries(OWNERS).map(([k, v]) => `     ${k.padEnd(12)} ${v}`).join('\n')}

Return the structured object. Nothing else.
`, { label: `review:${key}`, phase: 'Review', schema: FINDINGS })));

const valid = reviews.filter(Boolean);
const all = valid.flatMap((r) => r.findings || []);
const blockers = all.filter((f) => f.severity === 'blocker');
log(`${valid.length}/${LENSES.length} lenses reported · ${all.length} findings (${blockers.length} blockers)`);
for (const r of valid) log(`  · ${r.verdict}: ${r.blindTest}`);

/* -------------------------------------------------------------------- fix */

phase('Fix');

const byOwner = new Map();
for (const f of all) {
  const key = OWNERS[f.owner] ? f.owner : null;
  if (!key) continue;
  if (!byOwner.has(key)) byOwner.set(key, []);
  byOwner.get(key).push(f);
}
const dropped = all.length - [...byOwner.values()].reduce((n, a) => n + a.length, 0);
if (dropped) log(`${dropped} finding(s) had no valid owner and were dropped`);

const owners = [...byOwner.entries()].sort((a, b) => b[1].length - a[1].length);
log(`routing to ${owners.length} module(s): ${owners.map(([k, v]) => `${k}(${v.length})`).join(' ')}`);

const fixes = await parallel(owners.map(([owner, findings]) => () => agent(`${BASE}

FIX PASS — you own: ${OWNERS[owner]}

Twenty independent reviewers went over a full evidence set and raised
${findings.length} finding(s) against your module. Other agents are fixing other
modules in this same tree right now, so edit ONLY the files listed above.

FINDINGS:
${findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.evidence}
   PROBLEM: ${f.what}
   SUGGESTED: ${f.fix}`).join('\n\n')}

RULES
- Fix every blocker and every major. Fix minors if cheap.
- If you believe a finding is wrong, say so WITH evidence — which image, what
  you actually see. Do not silently ignore it.
- Reproduce before you change, and screenshot after to prove the fix:
    node tools/shot.mjs --presets <relevant> --out shots/fix-${owner} --w 1600 --h 900
  Read the PNGs. Never claim a fix you have not seen work.
- Keep tools/consume-test.mjs passing. Keep draw calls <= 1,500.
- Never rename or remove an export another module imports.
- THE MACHINE IS SHARED: one headless tool at a time.

Report per finding: FIXED / PARTIAL / REJECTED (with evidence), plus your
before/after numbers.
`, { label: `fix:${owner}`, phase: 'Fix' })));

/* ----------------------------------------------------------------- verify */

phase('Verify');

const verify = await agent(`${BASE}

FINAL VERIFICATION. You may edit any file, but only to repair breakage.

Fix reports:
${fixes.map((r, i) => `--- ${owners[i] ? owners[i][0] : i} ---\n${(r || 'FAILED').slice(0, 1400)}`).join('\n\n')}

DO, pasting real output:
1. Boot the game. window.DEV must appear with zero page errors. If a module
   throws, fixing it is the top priority.
2. node tools/consume-test.mjs
3. node tools/restart-test.mjs
4. node tools/prop-audit.mjs      — anything worse than ${SHOTS}/prop-audit.txt
   is a regression; find the cause and fix it.
5. node tools/perf-audit.mjs      — draw calls and triangles
6. node tools/shot.mjs --all --out shots/verified-day --w 1600 --h 900
   node tools/shot.mjs --all --out shots/verified-night --w 1600 --h 900 --script "__GAME__.engine.setTimeOfDay(0.87)"
   'errors' EMPTY in both. Read every image; fix outright breakage.
7. Append to docs/FINAL_QA.md: what this round fixed, the measurements, and
   every defect still outstanding with its owning file. Be honest — a clean
   report that hides a defect is worse than a messy one that names it.
`, { label: 'verify', phase: 'Verify' });

return {
  lenses: valid.length,
  findings: all.length,
  blockers: blockers.length,
  verdicts: valid.map((r) => r.verdict),
  verify,
};
