# Audio asset manifest

Every sound the game can emit, where it came from, and what licence covers it.

The rule this file exists to enforce: **nothing ships whose rights are unclear.**
The spec called this out about Myinstants specifically — a library of
user-uploaded meme, film and game audio with a DMCA page, which is not a safe
default for anything redistributable. Nothing from there is used.

Last verified: 2026-08-05.

---

## 1. Procedural — the overwhelming majority

**Source:** generated at runtime by `src/core/audio.js` (~2,300 lines of
WebAudio synthesis: oscillators, filtered noise, an impulse-response reverb
built in code, spatial panning, and a scheduling slot allocator).

**Licence:** original work in this repository. No third-party rights, no
attribution requirement, no redistribution question.

This is not a cost-saving compromise. The project ships **zero binary assets** —
every texture, every mesh and every sound is generated — so procedural audio is
the house style, and it happens to make the entire licensing problem disappear.
It also means infinite variation (no two swallows are byte-identical) and no
load time.

| Group | Effects |
|---|---|
| Hole | idle hum, small/medium/large swallow, rim scrape, suction pull |
| Growth | growth tick, tier unlock, major size increase, score pop |
| Physics | car tip, car slide, car fall, street-furniture clatter, stylised structural rumble |
| Vehicles | engine pass, brake, horn, panic acceleration, bus/truck weight |
| Power-ups | start whoosh, continuous loop, clean power-down |
| Events | event warning, storm start/loop/end, thunder, rain |
| Police | siren (spatial), dispatch chirp, heat up/down, containment pulse |
| Match | out-of-bounds 3-2-1, teleport, score penalty, event sting |
| UI | menu open, hover, click, confirm, back, countdown tick, match start, results, error |
| Ambience | Miami ocean/wind/city, park, Snowfall wind |
| Music | generated per match by `renderMusic()` |

Every looping effect returns a handle with `.stop()`, and `stopAllLoops()` runs
on match end — the spec is explicit that no loop may stack or survive a restart.

---

## 2. NPC dialogue — 111 lines, ElevenLabs TTS

**Source:** ElevenLabs text-to-speech, generated offline by
`tools/generate-voices.mjs`. Never called at gameplay time; the game loads
already-rendered files by asset id.

**Files:** `public/audio/voice/*.mp3` (111 files, 3.6 MB) plus `manifest.json`.

**Licence:** ElevenLabs free tier. Output under the free plan is licensed for
**non-commercial use with attribution**. This build is a private game played
with friends and is not distributed commercially, which that covers. **If this
ever gets published, monetised, or put on a storefront, the account must be on a
paid plan first** — the existing files would need regenerating under that plan.
That is the single licence condition in this project; it is written here so
nobody has to rediscover it.

**Voice talent:** none. All ten characters are original fictional inventions
voiced by stock synthetic voices. No real person's name, likeness, voice or
catchphrase; no real police department, brand or slogan. "City Response" is an
invented service. This constraint is restated at the top of
`src/audio/voicelines.js` so it survives future edits.

| Character | Role | Stock voice |
|---|---|---|
| Mina Sol | tourist, three days in | Jessica |
| Orla Fenn | resident, knows the block | Alice |
| Dax Perrone | line cook on a smoke break | Chris |
| Jun Marrow | streamer, films vertically | Will |
| Tavo Reyes | taxi driver, 22 years | Bill |
| Marla Quist | plaza security | Matilda |
| Ike Dorsett | public works | Daniel |
| Vale | City Response dispatch (fictional service) | Brian |
| Zee Mabry | was up by six on the court | Eric |
| Odetta Frame | feeds the birds, same bench daily | Lily |

**Regenerating:** `npm run voices` (`npm run voices:dry` to preview cost).
Content-hashed, so unchanged lines are skipped and a re-run is free.

---

## 3. Sampled sound effects — evaluation only, NOT SHIPPED

Six ElevenLabs sound-generation samples exist in `samples/` for comparison
against the procedural versions: building swallow, car tipping into the pit,
Vacuum Boost whoosh, storm thunder, siren pass, crowd panic.

**Status: not referenced by the game.** `samples/` is gitignored. They are a
listening test to decide whether any procedural effect is weak enough to be
worth replacing with a file. Thunder and crowd panic are the strongest
candidates — broadband, chaotic, and genuinely hard to synthesise convincingly.

If any is promoted to shipping, it moves to `public/audio/sfx/`, gets a row in
this table, and inherits the same free-tier licence condition as §2.

---

## 4. Secret handling

The ElevenLabs key never reaches the game. It is read from `process.env` by the
generation tool only, and the client requests finished audio by asset id.

- `.env` and every `*api*key*` shape are gitignored
- `npm run audit:secrets` checks tracked files, **all of git history**, the
  built bundle, untracked-but-unignored files, source trees, and any
  `VITE_`-prefixed variable (Vite inlines those into the browser bundle)
- Currently clean on all six checks; no key has ever been committed

**Rotation:** replace the values in `.env` and re-run `npm run voices`. Nothing
else reads them. `ELEVENLABS_API_KEY_2` / `_3` are fallback slots — the
generator rotates on 401/429/402 and reports only which slot it used, never the
value.

---

## 5. Mixing

- Buses: master → music / sfx / voices, each independently settable and mutable
- Non-essential ambience ducks under warnings, match start, devours and
  important dialogue
- Spatial panning with distance falloff for vehicles, NPCs, sirens and physics
- Strict concurrency caps: a hard limit of 3 simultaneous spoken lines, plus a
  scheduling slot allocator that drops rather than stacks
- Settings persist to `localStorage`; subtitles toggle independently of voice
  volume, because captions are the primary dialogue channel when no voice pack
  is present

---

## 6. Known issue — subtitle nodes disappear (cosmetic)

**Severity: low.** Voice audio is unaffected and verified working. This is only
the on-screen text.

**Symptom.** `hud.showCaption()` called directly renders a caption and it stays
(measured: 1 node in the DOM). But captions produced by the normal
`voice.say()` path are gone within ~200 ms — measured 0 nodes, in a harness
where the deadline was still 9 seconds away.

**Ruled out by measurement, not by reasoning:**

- `clearCaptions()` is never called — a wrapped spy recorded zero calls
- the expiry timer was not at fault — the shared-array-plus-interval design was
  replaced with per-row `setTimeout`s and the behaviour did not change
- the deadline arithmetic was correct — instrumented `until` vs `now` showed
  the row had 9,000 ms remaining when it vanished
- subtitles are enabled (`subtitles: true`, no `no-subtitles` class)
- `showCaption` does not throw (`probeThrew: null`)
- reparenting the container from `document.body` into the HUD root, in case the
  shell was clearing body during a screen swap, changed nothing
- no page errors, no console errors

**The MutationObserver has now been run**, and it rules out the external
theory. Watching both the caption container and its parent during a real
`voice.say()`:

```
removals: [ { target: DIV.vo-captions, removed: DIV.vo-cap },
            { target: DIV.vo-captions, removed: DIV.vo-cap } ]
wrapStillAttached: true    wrapChildren: 0    domAtStart: 1 -> domAtEnd: 0
```

Both removals happen INSIDE `.vo-captions`, and the container itself is never
detached. So nothing outside hud.js is doing this — the caption code is removing
its own rows. That contradicts the timings, because the probe row was created
with `ttl: 20` (a 20-second deadline) and was gone inside 600 ms.

The observer cannot name the culprit: its callback runs asynchronously, so
`new Error().stack` inside it captures the microtask, not the mutator — which is
why the `stack` field came back empty.

**What is left to try.** Only three lines in `hud.js` can remove a `.vo-cap`:
the per-row fade timeout, the nested removal timeout inside it, and the
`childElementCount >= 3` eviction. Instrument all three with a distinguishing
tag rather than a stack, and one run will say which. That is a ten-minute job
for whoever picks this up; it is documented here rather than guessed at.

**Workaround: none needed.** Dialogue is audible; the text just does not
persist. Anyone relying on subtitles for accessibility is affected, which is why
this is written down rather than left to be rediscovered.
