# Web MAME Arcade

Browser arcade built on MAME: players run MAME (WebAssembly) in the browser, play online
together by exchanging inputs, viewers watch by replaying the same input stream, and an
Ubuntu server verifies every leaderboard score by replaying the match in native MAME.

## Repo layout
- `mame/`            git submodule: our MAME fork. Never edit upstream files except via `core/patches/`.
- `core/`            netplay patch (`patches/`), build scripts for WASM + native builds, `verify.lua`.
- `packages/protocol/` shared TypeScript types + encoders for input packets and WS messages. Single source of truth.
- `web/`             frontend (TypeScript, Vite). Loads WASM cores, netplay loop, viewer, leaderboard UI.
- `relay/`           room relay (Node 22, uWebSockets.js): signalling, input log, spectator fan-out, chat, live scores.
- `api/`             REST API (Node 22, Fastify): accounts, catalogue, rooms, leaderboards.
- `verifier/`        worker that pulls jobs from Redis and runs headless native MAME.
- `deploy/`          docker-compose, nginx, coturn, livekit configs for Ubuntu 24.04.
- `docs/`            design docs. Read only what the task needs (see below).

## Commands
- Install: `pnpm install`
- Test all: `pnpm test` · one package: `pnpm --filter <pkg> test`
- Lint/types: `pnpm lint && pnpm typecheck`
- WASM core: `core/build-wasm.sh <driver>`   (slow; ask the human to run it if it exceeds 10 min)
- Native core: `core/build-native.sh <driver>`
- Local stack: `docker compose -f deploy/docker-compose.yml up`

## Golden rules
1. Determinism first. Anything that touches emulation must give identical results on every peer:
   same core build hash, ROM hash, DIP settings, options, input-per-frame. No wall-clock time,
   no Math.random, no locale-dependent code in the emulation path.
2. Protocol changes start in `packages/protocol/` and `docs/contracts/`, then both ends.
3. Never commit ROMs, `.wasm` builds or secrets. ROMs live in `roms/` (gitignored).
4. Never trust a score from a client. Only the verifier writes to `scores`.
5. One task = one branch = one focused commit series. Work from `docs/tasks/`.
6. Every change ships with tests; netplay/verifier changes also need a golden-replay test.

## Design docs (load on demand with the Read tool, only when relevant)
- Overview, chosen architecture, diagram: @docs/00-overview.md
- Findings in the MAME source: @docs/01-mame-source-notes.md
- WASM build + netplay patch: @docs/02-emulation-core.md
- Netplay protocol: @docs/03-netplay-protocol.md
- Spectating / streaming: @docs/04-spectating.md
- Leaderboard + verifier: @docs/05-leaderboard-verifier.md
- Backend services + deployment: @docs/06-backend-deploy.md
- ROMs, licensing, security: @docs/07-roms-licensing-security.md
- Roadmap + risks: @docs/08-roadmap-risks.md
- Contracts: @docs/contracts/input-packet.md @docs/contracts/ws-messages.md @docs/contracts/db-schema.sql
- Task list: @docs/tasks/README.md
