export const meta = {
  name: 'meta-layer',
  description: 'Build the mobile-game meta layer: lobby, modes, matchmaking, leaderboards, store, progression — then integrate and verify',
  phases: [
    { title: 'Build', detail: 'six disjoint agents write the meta screens and their systems' },
    { title: 'Integrate', detail: 'wire the shell into the game, mode rules into the match' },
    { title: 'Verify', detail: 'headless boot, every screen shot at phone + desktop, fix what breaks' },
  ],
};

/* =========================================================================
 * SHARED BRIEF — every agent gets this verbatim. It is the contract.
 * ====================================================================== */

const COMMON = `
PROJECT: "Miami Devour" — a Hole.io-style city-eating game in Three.js at
/Users/sam/untitled folder 6. Pure ES modules, Vite, NO binary assets anywhere
(every texture and icon is drawn procedurally in canvas/CSS/SVG). Dev server is
already running on http://localhost:5173.

YOU ARE BUILDING THE META LAYER: the lobby, matchmaking, game modes,
leaderboards, cosmetic store, progression and settings — the polished
mobile-game shell that wraps the existing match.

=== READ THESE FIRST. THEY ARE THE CONTRACT. DO NOT MODIFY THEM. ===

  src/ui/shell.js         screen router + navigation stack + toast/confirm
  src/ui/css/tokens.css   the design system: panel, tile, btn, chip, tabs,
                          bar, rows, avatar, stat-grid, toast, modal, layout
                          utilities, rarity ramp, responsive rules
  src/meta/profile.js     the player: level, xp, coins, owned/equipped
                          cosmetics, lifetime stats, daily, streak,
                          achievements, season, friends, settings
  src/gameplay/modes.js   the 7 game modes as data + scoring hooks

A screen is registered with the shell like this:

  shell.register('store', {
    title: 'Store',
    render({ shell, params }) { return htmlString; },   // build
    mount(root, { shell, params }) {},                  // wire listeners
    unmount(root) {},                                   // clean up timers
    onProfileChange(root) {},                           // optional live refresh
  });

Navigate with shell.go('name', params), shell.back(), shell.reset('lobby').
Feedback with shell.toast(text, 'ok'|'bad'|'info') and await shell.confirm(q).
Helpers exported from shell.js: esc(), shortNum(), page({title,back,actions,body}),
wireNav(el, shell).

=== HOW THIS MUST LOOK ===

Read docs/ART_DIRECTION.md. The register is BRIGHT MIAMI: hot pink #ff3d8b,
sun #ffc93c, aqua #37e6d5, lime #4dff9e, on dark glass plates. Think a modern
free-to-play mobile game's front end — big colourful tiles, chunky rounded
buttons that visibly depress when tapped, generous spacing, tabular numbers,
rarity colours, satisfying little entrance animations.

MOBILE FIRST, and mean it:
  - Portrait phone is the PRIMARY target. Design there, then let it breathe
    on desktop via the .wrap / .wrap-wide max-widths already in tokens.css.
  - Every tappable thing is >= 44px tall. Primary actions go near the BOTTOM
    of the screen where a thumb reaches, not the top.
  - No hover-only affordances. No tooltips carrying required information.
  - Long text must wrap or ellipsise, never overflow. Test a 16-char name.
  - Scroll containers use .page-body; never let the page itself scroll
    horizontally.

=== NON-NEGOTIABLE RULES ===

1. STAY IN YOUR FILES. You own EXACTLY the files listed in your task. Do not
   create, edit or delete anything else. Six agents are working in parallel and
   an edit outside your list will be lost or will clobber someone.
2. NO PLACEHOLDERS. No "TODO", no lorem ipsum, no stub that returns []. Every
   screen you write must be complete and work the first time it is opened.
3. ESCAPE EVERYTHING. Player names, room codes and friend names all reach
   innerHTML. Use esc() from shell.js on every interpolated value that did not
   come from your own code.
4. CLEAN UP. Any setInterval/setTimeout/addEventListener on window or document
   must be removed in unmount(). A leaked 1-second timer per screen visit is a
   dead phone battery.
5. NO NETWORK ASSETS. No CDN, no Google Fonts, no image URLs, no emoji sprite
   sheets. Emoji-as-text is fine. SVG you author inline is fine.
6. SYNTAX-CHECK before you finish: \`node --check <file>\` on every .js you
   wrote (package.json is type:module, so this works directly). Fix anything
   it reports. A syntax error takes the whole game down, not just your screen.
7. Write comments the way the rest of this codebase does: explain WHY a
   non-obvious decision was made, especially where you worked around something.
   Do not narrate what the code plainly says.
`;

/* =========================================================================
 * PHASE 1 — BUILD
 * ====================================================================== */

const BUILDERS = [
  {
    key: 'lobby',
    label: 'lobby+nav',
    files: 'src/ui/screens/lobby.js, src/ui/css/lobby.css',
    task: `
Build the MAIN LOBBY — the screen the player lands on, and the front door to
everything else. This is the first impression; it has to look like a game
people paid to install.

FILES YOU OWN (create both, nothing else):
  src/ui/screens/lobby.js    export function registerLobby(shell, deps)
  src/ui/css/lobby.css       styles scoped under [data-screen="lobby"]

\`deps\` is { profile, net } — net may be null (offline). Import profile from
'../../meta/profile.js' directly if you prefer; deps.net is the only thing you
cannot import.

THE LOBBY CONTAINS, top to bottom:

1. IDENTITY BAR (sticky at top, does not scroll away)
   - Avatar (use the .avatar component; --ac is the icon's colour), tapping it
     goes to 'profile'.
   - Player name, editable inline: tap the name to turn it into an input,
     Enter or blur commits via profile.data.name. Max 16 chars, strip
     < > & " ' \` \\ characters. If the name is empty show "Set your name" in
     muted text — a nameless player on a leaderboard is a bad first session.
   - Level badge + XP bar (.bar.xp), showing profile.levelProgress().
   - Coin counter with a 🪙 glyph, tabular numbers, tapping it goes to 'store'.

2. THE PLAY BLOCK — the biggest, brightest thing on the screen.
   - A huge primary "PLAY" button (.btn.btn-lg.btn-block) that starts a match
     immediately in the currently selected mode. Call deps.onPlay(modeId).
   - Directly under it, a compact strip showing the selected mode's icon, name
     and duration, tapping it goes to 'modes'.

3. A GRID OF LOBBY TILES (.tile, two columns on phone, four on wide screens):
     Public Match   -> shell.go('play', { intent: 'public' })
     Play w/ Friends-> shell.go('play', { intent: 'friends' })
     Game Modes     -> shell.go('modes')
     Leaderboards   -> shell.go('leaderboard')
     Store          -> shell.go('store')
     Profile        -> shell.go('profile')
   Each tile: emoji icon, name, and a live one-line subtitle that means
   something — Store shows how many items are unowned and affordable, Profile
   shows the player's level, Leaderboards shows their best rank if known,
   Public Match shows "AI backfill" when offline. Give each a distinct --cc.

4. THE LIMITED-TIME EVENT BANNER — full width, above the tiles, using
   activeEvent() from '../../gameplay/modes.js'. Name, blurb, a "LIVE" chip
   (.chip.live), and a tap target that goes to 'modes' with the event
   preselected. This is the most eye-catching element after PLAY.

5. DAILY STRIP — the player's streak (profile.data.streak.days) and today's
   challenge count with completion, from deps.progression if present; if
   deps.progression is absent, render the streak alone rather than a broken
   row. Tapping goes to 'rewards'.

6. A FOOTER ROW of small icon buttons: settings (goes to 'settings'), and a
   muted build line with the player's friend code (profile.data.id) that
   copies to the clipboard when tapped, with a toast confirming.

ALSO EXPORT from lobby.js:
  export const LOBBY_SELECTED_KEY = 'miami-devour:mode'
  export function selectedMode()          // reads localStorage, defaults 'classic'
  export function setSelectedMode(id)     // writes it
Other screens use these to agree on what "the current mode" is.

DETAILS THAT MATTER:
  - The lobby is re-entered constantly. Its render must be cheap and its mount
    must not fight an animation every time.
  - Implement onProfileChange(root) to update ONLY the numbers (coins, level,
    XP width, tile subtitles) in place. Do not re-render the whole screen on
    every coin change — the tiles will visibly flash.
  - Add a subtle staggered entrance for the tiles (animation-delay by index),
    capped so the last tile is in within ~250ms.
`,
  },

  {
    key: 'play',
    label: 'matchmaking',
    files: 'src/ui/screens/play.js, src/ui/css/play.css, src/net/matchmaking.js, server/*',
    task: `
Build MATCHMAKING — the flows that get a player into a match with other people,
plus the server side that makes it real.

FILES YOU OWN (you own ALL of server/, including editing server/server.js):
  src/ui/screens/play.js       export function registerPlay(shell, deps)
  src/ui/css/play.css          scoped under [data-screen="play"]
  src/net/matchmaking.js       the client API below
  server/store.js              (new) persistence for rooms + leaderboard
  server/http.js               (new) the REST surface
  server/server.js             (edit) mount the HTTP surface on the same port

READ FIRST: src/net/client.js, src/net/protocol.js, server/server.js. The
existing WebSocket game protocol is working and must not regress — you are
ADDING a REST surface beside it on the same port, not replacing anything.

=== THE REST CONTRACT (implement it exactly; another agent codes against it) ===

  GET  /api/health                    -> { ok:true, version:<PROTOCOL_VERSION> }

  GET  /api/rooms                     -> { rooms:[ { name, code, mode, players,
                                            max, phase, timeLeft, private } ] }
                                         private rooms are EXCLUDED from this list
  POST /api/rooms  { mode, private }  -> { room, code, mode }
  GET  /api/rooms/:code               -> one room, or 404 { error:'not found' }

  GET  /api/leaderboard?board=global|weekly&metric=totalScore|bestScore|biggestHole|wins&limit=100
                                      -> { board, metric, updated, entries:[
                                           { rank, id, name, icon, nameplate,
                                             level, totalScore, bestScore,
                                             biggestHole, wins, matches } ] }
  POST /api/profile   <publicRecord>  -> { ok:true, rank:{ global, weekly } }
  GET  /api/profile/:id               -> the public record, or 404

  Every response is JSON with permissive CORS (the game is served from :5173
  and the server is on :8787 — without CORS headers every call fails and the
  whole leaderboard silently shows nothing).

  Persist to a JSON file beside the server (server/.data/leaderboard.json),
  written atomically (write temp + rename) and debounced. Losing the board on
  restart is acceptable-ish; a corrupted half-written file that crashes the
  server on boot is not.

  "Weekly" is keyed on the ISO week; when the key changes, the weekly table
  resets and the global table does not.

  Validate every field you accept from a client: clamp names to 16 chars,
  strip control characters, reject non-finite numbers, cap array lengths. A
  leaderboard is a stored-XSS vector aimed straight at every other player.

=== src/net/matchmaking.js — the client API ===

  export const SERVER = { base(), ws() }   // derive from ?server= or :8787
  export async function health()                    -> bool
  export async function listRooms()                 -> room[]
  export async function createRoom({mode, private}) -> { room, code }
  export async function findRoom(code)              -> room | null
  export async function quickMatch(mode)  // pick the fullest joinable room in
                                          // this mode, else create one
  export async function submitProfile(record)       -> { rank } | null
  export async function fetchLeaderboard(opts)      -> { entries, ... } | null

  EVERY call must have a timeout (3s) and must resolve to null/false rather
  than throw when the server is not there. Offline is the DEFAULT state of this
  game and it has to be completely silent about it — no console errors, no
  hanging spinners, no unhandled rejections.

=== src/ui/screens/play.js — the screen ===

Registered as 'play'. params.intent is 'public' or 'friends'.

  PUBLIC MATCH tab:
    - "Quick Match" button: finds or creates a room in the selected mode and
      joins. Show a proper searching state with a cancel button — a spinner
      the player cannot escape is the single worst thing a lobby can do.
    - A live server browser: list of joinable rooms with mode, player count
      (e.g. "5/12"), phase and time left, refreshed every 4s WHILE THE SCREEN
      IS MOUNTED (clear the interval in unmount()).
    - When the server is unreachable, replace the browser with an honest,
      friendly panel: "No server found — you'll play against AI." plus a
      button that starts an offline match. Never a dead spinner. Never a
      fabricated list of fake rooms.

  PLAY WITH FRIENDS tab:
    - "Create Private Lobby": creates a private room, shows the 6-character
      invite code BIG, with copy-to-clipboard and a share button
      (navigator.share when available, silently absent when not).
    - "Join with Code": a 6-character code input — uppercase-forced,
      auto-advancing, paste-friendly — with a Join button that validates
      against GET /api/rooms/:code and reports "That code isn't a live lobby"
      rather than failing silently.
    - "Join a Friend": lists profile.data.friends with their online state where
      the server knows it, each with a Join button. Empty state explains how to
      add a friend (share your own code, which is shown here).

  BOTH tabs:
    - An AI BACKFILL row: a toggle plus a count stepper (0-11), stored in
      profile.data.settings.aiBackfill. It means "fill empty slots with bots".
      Default on, 7 bots.

  Joining a match calls deps.onJoin({ room, mode, code }); starting offline
  calls deps.onPlay(modeId). Those are provided by the integration wiring —
  call them, do not implement them.
`,
  },

  {
    key: 'modes',
    label: 'game-modes',
    files: 'src/ui/screens/modes.js, src/ui/css/modes.css',
    task: `
Build the GAME MODES screen — where the player browses and picks how they want
to play.

FILES YOU OWN (create both, nothing else):
  src/ui/screens/modes.js    export function registerModes(shell, deps)
  src/ui/css/modes.css       scoped under [data-screen="modes"]

READ FIRST: src/gameplay/modes.js. It already defines all seven modes as data
(MODES, EVENTS, getMode, activeEvent, targetsOf, rewardFor). You are building
the presentation of that data. DO NOT edit modes.js — if a field you need is
missing, derive it in your screen instead.

THE SCREEN:

1. A featured card for the LIMITED-TIME EVENT at the top, visually distinct
   from the rest — bigger, animated accent, a "LIVE THIS WEEK" chip, and a
   countdown to when the rotation flips (end of the ISO week, computed
   locally). It must be obvious this is the special one.

2. A vertical list of the six permanent mode cards, each showing:
     - icon, name, blurb
     - the rules list as chips
     - duration and starting hole size ("Starts at 4m", from startRadius*2)
     - what scores in this mode, from targetsOf()
     - the player's personal best in that mode from
       profile.data.stats.byMode[id] — matches played, wins, best score. If
       they have never played it, say "Not played yet" rather than showing
       three zeros, which reads like the mode is broken.
     - a "SELECT" / "SELECTED" state driven by selectedMode()/setSelectedMode()
       imported from './lobby.js'
     - a "PLAY" button that selects the mode and immediately calls
       deps.onPlay(modeId)

3. Tapping a card's body (not its buttons) expands it in place to show the full
   rules and the mode's reward baseline (rewards.xp / rewards.coins). One card
   open at a time. Animate the height — a card that snaps open feels cheap.

DETAILS THAT MATTER:
  - Each mode's accent colour drives its card (--cc). Six cards in six colours
    is the point: the player should learn to recognise them by colour.
  - If params.preselect is set, scroll that card into view and open it.
  - The screen must be readable on a 360px-wide phone. Chips wrap; they do not
    push the card wider than the viewport.
`,
  },

  {
    key: 'boards',
    label: 'leaderboards+profile',
    files: 'src/meta/leaderboard.js, src/ui/screens/leaderboard.js, src/ui/screens/profile.js, src/ui/css/leaderboard.css, src/ui/css/profile.css',
    task: `
Build LEADERBOARDS and the PLAYER PROFILE.

FILES YOU OWN (create all five, nothing else):
  src/meta/leaderboard.js          the client-side board model + cache
  src/ui/screens/leaderboard.js    export function registerLeaderboard(shell, deps)
  src/ui/screens/profile.js        export function registerProfile(shell, deps)
  src/ui/css/leaderboard.css       scoped under [data-screen="leaderboard"]
  src/ui/css/profile.css           scoped under [data-screen="profile"]

=== HONESTY REQUIREMENT — READ THIS TWICE ===

The boards are real or they are clearly labelled. A parallel agent is building
a REST surface on the room server (src/net/matchmaking.js exports
fetchLeaderboard() and submitProfile(); server endpoints are documented in that
file). When it answers, you show real data. When it does not — which is the
normal case for a player running this locally — you show the player's OWN
history as a local board, LABELLED "Local — not connected to a server", and
you do NOT invent other players. Fabricated rivals on a leaderboard is lying to
the user. An honest local board with one real row is fine.

Import fetchLeaderboard/submitProfile lazily inside a try/catch so that if
matchmaking.js is not ready yet your screen still renders.

=== src/meta/leaderboard.js ===

  export const BOARDS = ['global', 'weekly', 'friends']
  export const METRICS = [
    { id:'totalScore',  label:'Total score',  fmt },
    { id:'bestScore',   label:'Best match',   fmt },
    { id:'biggestHole', label:'Biggest hole', fmt },   // metres, 1dp
    { id:'wins',        label:'Wins',         fmt },
    { id:'matches',     label:'Matches',      fmt },
  ]
  export async function load({ board, metric })  // network, else local, cached
                                                 // 60s; returns
                                                 // { entries, source:'server'|'local', updated }
  export function localBoard(metric)             // the player + their friends,
                                                 // from profile data only
  export function rankBadge(rank)                // { tier:'bronze'|'silver'|
                                                 //   'gold'|'platinum'|'diamond',
                                                 //   label, color } derived from
                                                 //   lifetime wins+score
  export async function push()                   // submit publicRecord(), silent on failure

=== src/ui/screens/leaderboard.js ===

  - Tabs for Global / Weekly / Friends (.tabs).
  - A metric selector (a second, smaller tab row or a segmented control) for
    the five metrics above.
  - The top three get a PODIUM treatment above the list — bigger avatars,
    gold/silver/bronze rings, the score under each. This is the single most
    "mobile game" thing on the screen; make it look good.
  - The rest as .rows rows: rank, avatar, name, rank badge, metric value. The
    local player's row uses .row.me and, if they are outside the visible top,
    is ALSO pinned at the bottom of the list so they can always find
    themselves.
  - Pull-to-refresh is not required; a refresh icon button in the header is.
  - Show source and freshness honestly: "Live · updated 12s ago" or
    "Local — not connected to a server".
  - Empty and loading states must both be designed, not blank.

=== src/ui/screens/profile.js ===

  - Header: big avatar, name, level ring, rank badge, friend code with a copy
    button, and "member since" if you can derive it (else omit — do not invent).
  - Equipped cosmetics strip: skin, trail, rim, nameplate, icon — each a small
    preview tile that goes to 'store' with that category preselected
    (shell.go('store', { tab:<kind> })).
  - Lifetime stats in a .stat-grid: matches, wins, win rate, top-3 rate, total
    score, best match, biggest hole (metres, 1dp), objects devoured, rivals
    eaten, time played (formatted h/m).
  - Per-mode breakdown: one row per mode from profile.data.stats.byMode with
    matches / wins / best. Modes never played are listed greyed with "—", so
    the player can see what is left to try.
  - Achievements: a grid of the achievements from deps.progression if present
    (locked ones greyed with their requirement visible). If deps.progression is
    absent, omit the section entirely rather than rendering an empty box.
  - A "Reset progress" action at the very bottom, behind shell.confirm(), that
    calls profile.reset(). Destructive actions go last and never look primary.
`,
  },

  {
    key: 'store',
    label: 'store+cosmetics',
    files: 'src/meta/cosmetics.js, src/ui/screens/store.js, src/ui/css/store.css',
    task: `
Build the COSMETIC STORE and the cosmetics catalogue behind it.

FILES YOU OWN (create all three, nothing else):
  src/meta/cosmetics.js       the catalogue + procedural previews
  src/ui/screens/store.js     export function registerStore(shell, deps)
  src/ui/css/store.css        scoped under [data-screen="store"]

COSMETIC-ONLY. Nothing in this store may affect gameplay: no speed, no growth,
no score. Coins are earned by playing (profile.addCoins); there is no real
money anywhere in this project and you must not add any purchase flow, price in
currency, or "buy coins" button.

=== src/meta/cosmetics.js ===

  export const RARITY = { common, rare, epic, legendary, mythic }
    each { id, label, color, weight } — colours match tokens.css --r-*.

  export const CATEGORIES = [
    { kind:'skin',      label:'Hole Skins' },
    { kind:'trail',     label:'Trails' },
    { kind:'rim',       label:'Rim Effects' },
    { kind:'nameplate', label:'Nameplates' },
    { kind:'icon',      label:'Profile Icons' },
    { kind:'emote',     label:'Emotes' },
  ]

  export const ITEMS = [ ... ]   // every item:
    { id, kind, name, rarity, price, set?, desc, unlock? }
    - id must match the ids already in src/meta/profile.js DEFAULTS:
      skin-classic, trail-none, rim-classic, hole-01, plate-default, emote-wave
      are the free starting items and MUST have price 0 and be in the catalogue,
      or the profile screen will show equipped items that do not exist.
    - unlock: optional { level:n } or { achievement:'id' } — items gated on
      progression rather than coins. Show the requirement instead of a price.
    - Build AT LEAST: 14 skins, 10 trails, 8 rim effects, 10 nameplates,
      12 icons, 10 emotes. Price by rarity (common 150, rare 400, epic 900,
      legendary 2000, mythic 4000).

  export const SETS = [ ... ]    // seasonal Miami collections, e.g.
    "Ocean Drive", "Vice Sunset", "Art Deco", "Bayfront", "Little Havana",
    "Hurricane Season". Each { id, name, blurb, accent, items:[ids], ends? }.
    A set completed grants nothing mechanical — a nameplate flourish is fine.

  export function itemsOf(kind)
  export function getItem(id)
  export function previewSVG(item, size)   // an inline SVG string that DRAWS
                                           // the cosmetic. No images.
  export function skinColors(id)           // { core, rim, glow } for the game
                                           // to apply to the hole material
  export function trailSpec(id)            // { color, life, width, sparkle }
  export function rimSpec(id)              // { color, pulse, thickness, style }

  previewSVG is the heart of this file. A store full of grey squares is
  worthless. Each skin previews as an actual hole — a dark disc with its rim
  treatment and glow; each trail as a swooshing tapered ribbon in its colours;
  each rim as an animated ring; nameplates as an actual plate with the shape
  and colours it will have; icons as a distinct little emblem. Use gradients,
  strokes and simple shapes. They must be visually DIFFERENT from each other at
  thumbnail size — that is the whole product.

=== src/ui/screens/store.js ===

  - Category tabs (.tabs) across the six kinds; params.tab preselects one.
  - A featured SEASONAL COLLECTION banner at the top with its own accent, the
    set's items as a row, and how many the player owns of it.
  - A grid of item cards (.grid-auto). Each card:
      preview (previewSVG), name, rarity strip in the rarity colour,
      and its state: PRICE (with coin glyph) / OWNED / EQUIPPED / locked with
      its requirement. Never all four at once — the state is exactly one thing.
  - Tapping a card opens a DETAIL SHEET (bottom sheet on phone, centred card on
    desktop): a large preview, name, rarity, set membership, description, and
    the single correct action — Buy (disabled + "Need N more coins" when short),
    Equip, or "Reach level N". Buying uses profile.purchase(kind, id, price)
    and must toast the result. Equipping uses profile.equip(kind, id).
  - A coin balance pinned in the header that visibly counts down after a
    purchase — the reward for spending is seeing the number move.
  - Owned items sort ahead of locked ones within a rarity; sort by rarity
    descending overall so the aspirational items are visible immediately.
  - The store re-renders on profile change (onProfileChange) but must preserve
    the open tab and scroll position. Losing your place after every purchase is
    the classic mistake here.
`,
  },

  {
    key: 'progress',
    label: 'progression+settings',
    files: 'src/meta/progression.js, src/ui/screens/rewards.js, src/ui/screens/settings.js, src/ui/css/rewards.css, src/ui/css/settings.css',
    task: `
Build PROGRESSION (levels, daily challenges, achievements, season, streaks,
end-of-match rewards) and the SETTINGS screen.

FILES YOU OWN (create all five, nothing else):
  src/meta/progression.js       the system
  src/ui/screens/rewards.js     export function registerRewards(shell, deps)
  src/ui/screens/settings.js    export function registerSettings(shell, deps)
  src/ui/css/rewards.css        scoped under [data-screen="rewards"]
  src/ui/css/settings.css       scoped under [data-screen="settings"]

=== src/meta/progression.js ===

Build on src/meta/profile.js — it already owns level/xp/coins storage,
rollDaily(), touchStreak(), unlockAchievement() and recordMatch(). You provide
the CONTENT and the RULES.

  export const CHALLENGES = [ ... ]   // the template pool. Each:
    { id, text, goal, track, reward:{xp,coins}, modes? }
    where "track" names a countable event: 'devour', 'score', 'vehicles',
    'people', 'buildings', 'wins', 'rivals', 'survive', 'bigHole'.
    Write at least 18 distinct templates with varied goals so a week of
    dailies does not repeat.

  export function rollDailies(seedDay)   // 3 challenges, deterministic for the
                                         // day so a refresh cannot reroll them
  export function progressChallenge(track, amount)  // called during a match
  export function claimChallenge(id)     // grants reward once; returns bool

  export const ACHIEVEMENTS = [ ... ]    // at least 24. Each:
    { id, name, desc, icon, tier, check(stats) -> bool, reward:{xp,coins} }
    Cover: first win, 10/50/250 matches, 1k/10k/100k lifetime score, a 20m /
    50m / 100m hole, 100/1000/10000 objects, eat 5/25 rivals, win in every
    mode, a 7-day streak, own 10/25 cosmetics, complete a set, reach level
    10/25/50.

  export function checkAchievements()    // evaluate all, unlock + grant new
                                         // ones, return the newly unlocked

  export const SEASON = { id, name, blurb, ends, tiers:[ ... ] }
    30 tiers, each { at:<seasonXp>, reward:{ coins? , item?, xp? } }.
    Free track only — there is no paid pass in this game.

  export function seasonProgress()       // { tier, next, pct, claimable:[] }
  export function claimSeason(tier)

  export function grantMatchRewards(summary)
    // summary is what src/gameplay/match.js summary() returns plus
    // { mode, durationSec }. Uses rewardFor() from src/gameplay/modes.js for
    // the baseline, adds streak and challenge bonuses, calls profile.addXp /
    // addCoins / recordMatch, evaluates achievements, and RETURNS a structured
    // breakdown the end screen can animate:
    //   { xp:{base,bonus,total,levelsGained,before,after},
    //     coins:{base,bonus,total},
    //     challenges:[{id,text,completed,reward}],
    //     achievements:[...], season:{gained,tier,unlocked:[]} }
    // Getting this breakdown right is what makes the end of a match feel like
    // a reward instead of a scoreboard.

=== src/ui/screens/rewards.js ===

Registered as 'rewards'. The progression hub:
  - Level card: big level number, XP bar, "N XP to level M".
  - Daily challenges: three cards with progress bars, a claim button when
    complete, and a countdown to the next reroll (local midnight).
  - Streak: a 7-dot week strip showing which days were played, the current
    streak and the best. Tomorrow's dot is highlighted as "come back".
  - Season track: a horizontally scrollable tier rail with claimed / claimable
    / locked states and the reward for each. Claimable tiers must be visually
    loud — an unclaimed reward the player cannot see is a wasted reward.
  - Achievements: grid, unlocked in colour with the date, locked greyed with
    the requirement. Group by tier. Show "12 / 24" at the top.

=== src/ui/screens/settings.js ===

Registered as 'settings'. Reads and writes profile.data.settings and saves:
  - Audio: music and SFX sliders (0-100), applied live to the audio module
    via deps.audio if provided (import lazily and no-op if absent).
  - Graphics: quality select (auto / low / medium / high / ultra) and a
    "Show FPS" toggle. Call deps.onQuality(level) when it changes.
  - Gameplay: invert drag toggle, reduced motion toggle (which must actually
    set a class on document.documentElement so tokens.css can honour it).
  - Account: friend code with copy, "Reset progress" behind shell.confirm().
  - Credits/about line at the bottom.
  Use real, chunky mobile-style toggle switches and sliders — a bare
  <input type=checkbox> is an instant fail on this screen. Everything applies
  immediately; there is no Save button.
`,
  },
];

/* =========================================================================
 * RUN
 * ====================================================================== */

phase('Build');
log(`Building the meta layer: ${BUILDERS.length} disjoint agents`);

const built = await parallel(BUILDERS.map((b) => () => agent(
  `${COMMON}

=== YOUR TASK: ${b.label} ===
YOU OWN EXACTLY THESE FILES: ${b.files}
${b.task}

When you are done, run \`node --check\` on every .js file you created and fix
anything it reports. Then reply with a compact JSON summary:
{ "files": [...], "exports": { "<file>": ["names"] }, "notes": "anything the
integrator must know", "risks": "anything you could not verify" }`,
  { label: b.label, phase: 'Build' }
)));

const summaries = BUILDERS.map((b, i) => `--- ${b.label} (${b.files})\n${built[i] || 'AGENT FAILED — its files may be missing or incomplete'}`).join('\n\n');

/* ---------------------------------------------------------- integrate --- */

phase('Integrate');

const integration = await agent(`${COMMON}

=== YOUR TASK: INTEGRATION ===

Six agents just built the meta layer in parallel. Your job is to make it one
game. Here is what they report they built:

${summaries}

YOU OWN EXACTLY THESE FILES (and no screen or css file — those are theirs):
  src/ui/meta.js        (new) the meta layer's boot + wiring
  src/game.js           (edit)
  src/main.js           (edit)
  src/ui/screens.js     (edit)
  index.html            (edit)
  src/config.js         (edit, only if a mode genuinely needs a new constant)

STEP 0 — VERIFY WHAT ACTUALLY LANDED. Do not trust the summaries above. List
src/ui/screens/, src/ui/css/, src/meta/, src/net/ and read the real exports of
every file. \`node --check\` all of them. If an agent failed or left a file
broken, YOU FIX IT — a missing screen must not take the game down. Where a
screen is genuinely absent, register a small honest placeholder that says the
feature did not build, rather than letting shell.go() fail.

STEP 1 — src/ui/meta.js. Export \`installMeta(game, uiRoot)\`. It must:
  - create the .shell root element inside uiRoot and construct Shell
  - register every screen that exists: lobby, play, modes, leaderboard,
    profile, store, rewards, settings
  - supply the deps each screen expects: { profile, net, progression, audio,
    onPlay(modeId), onJoin({room,mode,code}), onQuality(level) }
  - shell.reset('lobby') and return the shell

STEP 2 — index.html: load src/ui/css/tokens.css and every screen css file
after styles.css. Order matters; tokens.css comes first.

STEP 3 — REPLACE THE OLD MENU. src/ui/screens.js currently owns the title
screen (showMenu). The lobby replaces it. Keep showLoading, showCountdown and
showResults — they are still correct — and make showMenu a no-op that hands
control to the shell, so nothing that calls it breaks. game.js calls
screens.showMenu() in two places (init and returnToLobby); both must end up on
the lobby with the world reset and the HUD hidden.

STEP 4 — MODES MUST ACTUALLY APPLY. Wire src/gameplay/modes.js into the match:
  - the selected mode's startRadius sets the starting hole (see HOLE.START_RADIUS
    usage and Hole construction in game.js — do not hardcode)
  - duration sets MATCH duration for the round
  - botCount sets how many AI opponents spawn
  - scoreFor(consumable) is applied where score is credited in the swallow
    path. Read src/gameplay/consume.js and src/game.js onSwallow. A mode
    returning 0 means the object is still EATEN, it just scores nothing —
    do not block consumption.
  - teams:2 means Team Devour: assign holes to two teams, never let a hole
    swallow a teammate, and rank by pooled team score on the end screen
  - shrink closes the play area in Last Hole Standing
  - a mode with timeOfDay set calls engine.setTimeOfDay(t) at match start
  If any of these cannot be done cleanly in the time you have, implement the
  ones you can COMPLETELY and state plainly in your reply which you did not do.
  Do not half-wire one and claim it works.

STEP 5 — REWARDS ON MATCH END. In the RESULTS phase, call
progression.grantMatchRewards({...match.summary(player), mode, durationSec})
and pass the returned breakdown to the results screen so XP, coins, completed
challenges and new achievements are shown. Also call leaderboard push() so the
board updates. Both must be wrapped so a failure cannot block the end screen.

STEP 6 — VERIFY IT BOOTS. The dev server is on http://localhost:5173. Use
tools/shot.mjs (read it first) or a small Playwright script to load the page,
assert zero console errors, assert the lobby rendered, and click through to
every screen. Fix everything you find. Do not report success on a build you
have not seen load.

Reply with: what you wired, what you fixed, what you could NOT wire and why,
and the console-error count from your final boot test.`,
  { label: 'integrate', phase: 'Integrate', effort: 'high' });

/* ------------------------------------------------------------- verify --- */

phase('Verify');

const LENSES = [
  {
    key: 'boot',
    label: 'verify:boot',
    task: `Boot the game at http://localhost:5173 headlessly and exercise EVERY
meta screen. Assert: zero uncaught exceptions, zero console errors, no 404s on
css or js, the lobby renders with a visible PLAY button, and shell.go() reaches
lobby, play, modes, leaderboard, profile, store, rewards and settings without
throwing. Then start a match from the lobby and confirm it actually plays and
reaches the results screen. Report every failure with the exact file and line.`,
  },
  {
    key: 'phone',
    label: 'verify:phone',
    task: `Screenshot every meta screen at 390x844 (iPhone portrait) AND
360x640 (small Android) AND 844x390 (landscape). Look for: horizontal overflow,
text clipping, tap targets under 44px, content hidden behind the notch or home
indicator, unreadable contrast, and anything that requires a hover to use.
Measure the tap targets in the DOM rather than eyeballing them. Report each
problem with the screen, the viewport, the element and the measured value.`,
  },
  {
    key: 'craft',
    label: 'verify:craft',
    task: `You are a harsh art director reviewing this as a shipping mobile
game's front end. Screenshot every meta screen at 1280x800 and 390x844 and
judge them against docs/ART_DIRECTION.md and against what a polished
free-to-play game looks like. Call out: grey or unstyled areas, inconsistent
spacing, mismatched corner radii, weak or missing empty states, anything that
reads as a placeholder, store previews that are indistinguishable from one
another, and any screen that looks like a form rather than a game. Be specific
and be brutal — name the element and what is wrong with it. Do NOT be
reassuring.`,
  },
];

const findings = await parallel(LENSES.map((l) => () => agent(
  `${COMMON}

=== YOUR TASK: ${l.label} — READ-ONLY REVIEW ===

The meta layer has just been integrated. ${integration ? 'The integrator reported:\n' + String(integration).slice(0, 3000) : ''}

${l.task}

You are REVIEWING, not fixing. Do not edit any file. Read tools/shot.mjs and
tools/compare.mjs first — a working headless harness already exists, use it
rather than writing a new one.

Reply as JSON:
{ "findings": [ { "screen": "...", "file": "...", "severity": "blocker"|"major"|"minor",
                  "what": "...", "evidence": "measured value or screenshot path",
                  "fix": "concrete suggestion" } ] }`,
  { label: l.label, phase: 'Verify' }
)));

const report = LENSES.map((l, i) => `--- ${l.label}\n${findings[i] || 'review agent failed'}`).join('\n\n');

phase('Fix');

const fixes = await agent(`${COMMON}

=== YOUR TASK: FIX EVERYTHING THE REVIEWERS FOUND ===

Three reviewers just went over the integrated meta layer:

${report}

Fix every blocker and every major finding. Fix the minors that are quick. You
may edit ANY file in src/ui/, src/meta/, src/net/matchmaking.js, index.html and
src/game.js — the parallel agents are finished, so there is no longer any
ownership conflict.

Rules:
  - Verify each fix, do not assume it worked. Re-run the failing check.
  - \`node --check\` everything you touch.
  - Finish with a clean boot: load http://localhost:5173, zero console errors,
    click through all eight screens, start and finish a match.
  - If a finding is WRONG — the reviewer measured something that is not
    actually a problem — say so with your evidence rather than "fixing" it.

Reply with: what you fixed, what you rejected and why, and the final
console-error count.`,
  { label: 'fix', phase: 'Fix', effort: 'high' });

return {
  built: BUILDERS.map((b, i) => ({ agent: b.label, ok: !!built[i] })),
  integrated: !!integration,
  reviewed: LENSES.map((l, i) => ({ lens: l.label, ok: !!findings[i] })),
  fixes: String(fixes || '').slice(0, 4000),
};
