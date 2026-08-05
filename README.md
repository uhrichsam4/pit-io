# pit.io

A Hole.io-style city-eating game set in a stylised Miami — Brickell and
Downtown, ~27,000 edible objects, seven game modes, and a cosmetic meta layer.
Three.js, no binary assets: every texture, prop and icon is generated in code.

## Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/uhrichsam4/pit-io)

**One service, one port.** `server/server.js` serves the built game, the REST
API and the WebSocket game protocol together, so a deployment is a single URL
you can send to a friend — no CORS, no second host to keep in sync, and no
`?server=` parameter anyone has to be told about.

`render.yaml` configures the build, the start command, the Node version and a
health check, so there is nothing to fill in by hand.

## Playing with someone

Send them the deployed link, then either:

- **Play With Friends → Create Private Lobby**, and give them the six-character
  invite code to enter under **Join with Code**; or
- both open `<url>/?room=anything` with the same word.

The world is generated deterministically from a seed the server hands out, so
every client in a room builds a byte-identical city and the network only has to
replicate *events* against it, not the world itself.

## Running locally

```bash
npm install
npm run dev      # game on http://localhost:5173
npm run server   # room server + API on http://localhost:8787
```

In development those are two processes on two ports; the client only adds
`:8787` when the hostname is loopback. Built and deployed, the server serves the
game itself and everything shares one origin.

```bash
npm run build            # produces dist/
node tools/boot-check.mjs --port 8787
```

## tools/

`boot-check.mjs` is the one to run after touching anything under `src/world/`.
`node --check` only proves a file *parses* — a registry entry naming a geometry
function that was never written is a ReferenceError, not a syntax error, so the
file parses perfectly while the game fails to boot. That exact bug once took the
whole game down behind a wall of green `--check` results. Boot it.

Also here: `prop-catalogue.mjs` (photograph every prop kind alone),
`prop-audit.mjs` (placement), `consume-test.mjs` (the swallow physics contract),
`perf-audit.mjs` (triangles and draw calls), `net-test.mjs` (two real clients in
one room), `meta-test.mjs` (the meta-layer acceptance gate).

## docs/

`ART_DIRECTION.md`, `META_LAYER.md`, `PERF_FINDINGS.md`, `STREET_LIFE.md`.
