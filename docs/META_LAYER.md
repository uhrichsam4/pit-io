# The meta layer

Everything outside the match: the lobby, matchmaking, game modes, leaderboards,
the cosmetic store, progression and settings.

The match itself was already complete. This layer is what turns it from a demo
you press Space on into something that looks and behaves like a mobile game you
installed — an identity, a reason to come back tomorrow, and somewhere to spend
what you earned.

---

## The five contracts

Six agents built this in parallel. That only works if the seams are written
down first, so these five files were authored before any of them started and
are the only things they were all allowed to depend on.

| File | Owns |
|---|---|
| `src/meta/profile.js` | The player. Identity, level, XP, coins, owned/equipped cosmetics, lifetime stats, dailies, streak, achievements, season, friends, settings. |
| `src/ui/shell.js` | Navigation. Screen registry, stack, back behaviour, transitions, toasts, confirm dialogs, tap-target enforcement. |
| `src/ui/css/tokens.css` | Looks. The design system every screen styles against. |
| `src/gameplay/modes.js` | The seven modes, as data plus scoring hooks. |
| `src/net/matchmaking.js` + `server/http.js` | The REST surface: rooms and leaderboards. |

### Why a profile singleton

Two sources of truth for "what level am I" is how a player loses cosmetics they
paid for. Progression, the store, the leaderboard and the profile screen all
read and write through `profile`, which owns the only `localStorage` write, is
debounced so a burst at match end is one write, and deep-merges saved data over
defaults so adding a field never breaks an existing save.

### Why screens are objects, not classes

```js
shell.register('store', {
  render({ shell, params }) { return html; },
  mount(root, ctx) {},
  unmount(root) {},
  onProfileChange(root) {},
});
```

Four optional functions is the entire surface. Six people can write six screens
that navigate identically without any of them importing another, and the shell
can enforce the things that are easy to get wrong once and never notice —
44 px tap targets, safe-area padding, cleaning up the profile subscription.

`onProfileChange` exists so screens showing live numbers refresh themselves
rather than every screen polling. It should patch numbers in place; a full
re-render on every coin change makes the tiles visibly flash.

### Why one `--ui-scale`

Every dimension in `tokens.css` is authored in `em` off a single root scale, so
one knob rescales the whole interface from a 360 px phone to a 2560 px panel
with no per-breakpoint duplication. The rule that makes it work: **never set
`font-size` on a container**, only on leaf text, or the `em` padding of its
descendants compounds.

---

## Game modes

A mode is data, not a fork in the game loop. Everything a mode can change is a
field:

```
duration  startRadius  botCount  teams  shrink  timeOfDay
scoreFor(consumable)   rewards{xp,coins}
```

**A mode returning 0 from `scoreFor` still lets the object be eaten.** It just
earns nothing. Blocking consumption outright makes the world feel broken —
a bus you physically cannot swallow in Crowd Control reads as a bug. A bus that
scores zero just teaches you to stop bothering with buses.

| Mode | The idea |
|---|---|
| Classic Devour | Everything counts. The default. |
| Car Crunch | Only vehicles score; exotics double. |
| Crowd Control | Only people score. Drives you to cafés, queues, the promenade. |
| Building Rush | Start at 14 m; only structures score. |
| Last Hole Standing | The play area closes in. |
| Team Devour | Two teams, pooled scores, no eating teammates. |
| Limited-time event | Rotates weekly by ISO week, so every client agrees without asking the server. |

---

## Online, honestly

"Real online leaderboards and friends lists" need a hosted backend. What exists
here is **server-persisted** leaderboards and friend codes against the room
server — real against a real host, real on a LAN, and absent when you are
playing alone on a laptop.

The rule the leaderboard was built under, and the one worth keeping:

> When the server answers, show real data. When it does not, show the player's
> own history labelled *"Local — not connected to a server"*, and **do not
> invent other players.**

Fabricated rivals would look better in a screenshot and would be a lie told to
the user every time they opened the screen. An honest local board with one real
row is the correct product.

Every network call has a 3-second timeout and resolves to `null` rather than
throwing. Offline is this game's default state and the UI has to be completely
silent about it: no console errors, no hanging spinners, no dead lists.

The REST surface rides on the room server's existing port beside the WebSocket
game protocol:

```
GET  /api/health
GET  /api/rooms                     POST /api/rooms      GET /api/rooms/:code
GET  /api/leaderboard?board=&metric=&limit=
POST /api/profile                   GET  /api/profile/:id
```

Weekly boards key on the ISO week and reset when the key changes; the global
board does not. Everything a client sends is clamped and stripped before it is
stored — a leaderboard is a stored-XSS vector pointed at every other player.

---

## The store is cosmetic. All of it.

No item in the store may affect speed, growth or score. Coins are earned by
playing. There is no real money anywhere in this project — no purchase flow, no
currency price, no "buy coins" button — and nothing here should ever add one.

Previews are procedural SVG, like every other asset in this game. A store full
of grey squares is worthless, so each skin previews as an actual hole with its
rim and glow, each trail as a tapered ribbon, each rim as an animated ring.
They have to be distinguishable at thumbnail size; that *is* the product.

---

## Progression

`profile.js` owns the storage. `progression.js` owns the content and the rules:
the challenge pool, the achievement list, the season track, and
`grantMatchRewards(summary)`.

That last one returns a structured breakdown rather than just mutating the
profile:

```js
{ xp: { base, bonus, total, levelsGained, before, after },
  coins: { base, bonus, total },
  challenges: [...], achievements: [...], season: {...} }
```

The end screen animates that breakdown. The difference between a scoreboard and
a reward is entirely in whether the player watches the numbers move.

Dailies are rolled deterministically from the day key, so refreshing the page
cannot reroll a challenge you did not like.

---

## Mobile first, and meant

- Portrait phone is the primary target; desktop is portrait with `max-width`.
- 44 px is the floor for anything tappable, enforced in JS rather than trusted.
- Primary actions sit at the **bottom**, where a thumb reaches.
- No hover-only affordances, and no tooltip carrying information you need.
- Buttons visibly depress. On a phone there is no hover, so the depress is the
  entire affordance that the tap registered.
- `prefers-reduced-motion` is honoured globally in `tokens.css`.
