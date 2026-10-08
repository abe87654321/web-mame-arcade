# Task list

One task = one opencode session = one branch (`task/<id>`). Do them in numeric order; a task may start only
when every listed dependency is done (a later task whose dependencies are already met may start earlier).
Mark done by changing `[ ]` to `[x]` in the same PR.
Each task: read the listed docs only, plan first (Plan agent), then build, then run `/review-task <id>`.

## Phase 0 · Foundations and determinism spike
- [x] **T00 Repo scaffold** – pnpm workspace (`pnpm-workspace.yaml`) with `packages/protocol`, `web`, `relay`,
  `api`, `verifier`; TS strict, eslint, vitest; CI workflow (lint + typecheck + test); `.gitignore`
  (`node_modules`, `roms/`, `*.wasm`, `core/out/`, `.env`); `.nvmrc`; and the `.opencode/` agents
  (`reviewer`, `determinism-auditor`) + commands (`/next-task`, `/review-task`, `/netplay-check`) that the
  loop in `DEVELOPMENT.md` needs. Docs: 00, contracts/db-schema. Done when `pnpm test` passes in CI and the
  documented workflows actually exist. This unblocks everything below.
- [x] **T01 MAME submodule + native build script** – add fork as `mame/`, `core/build-native.sh <driver>` builds one
  free driver (from mamedev.org/roms) and prints the binary sha256. Docs: 01, 02. Human runs the first full build.
- [x] **T02 Determinism spike** – script records a 10-min session with MAME `-record`, plays it back twice with
  `-playback`, and compares a RAM hash from a Lua script at the end. Docs: 01, 08. Done when 10/10 runs match.
  Note: T00/T01 are prerequisites; this is the first gate that must pass before any netplay work.
- [x] **T03 Contracts & version pinning** – make `docs/contracts/` the single source of truth: reconcile the
  outdated `design.md` input packet (L95) and `games.rom_set` (L167) with `contracts/input-packet.md` /
  `contracts/db-schema.sql`, and pin emsdk (replace "latest" in docs/02), Node and MAME commit. Record how the
  core hash is stored per match. Docs: 00, 02, contracts/*. Depends: T00.

## Phase 1 · Solo play in the browser
- [ ] **T10 WASM build script** – `core/build-wasm.sh <driver>` via emsdk; outputs to `core/out/<driver>/<sha>/`. Docs: 02.
- [ ] **T11 Core wrapper** – `web/src/core/` typed `Core` interface (load, step, save, load, hash, readScore) around the
  stock WASM build; ROM zip mounted into FS. Docs: 02. Depends: T10.
- [ ] **T12 Input layer** – keyboard + Gamepad API → 16-bit mask per contract; remapping UI. Docs: contracts/input-packet. Depends: T11.
- [ ] **T13 Game page + catalogue** – game list from a static JSON, play page, Nginx dev config with COOP/COEP. Depends: T11.

## Phase 2 · Two-player lockstep
- [ ] **T20 Netplay patch** – frame gate, `netplay_set_inputs`, `netplay_save_state/load_state`, `netplay_hash`,
  frame clock, in `core/patches/`. Docs: 01, 02. Human reviews every C++ line. Depends: T10.
- [ ] **T21 Protocol package** – `encodeInput/decodeInput`, zod message schemas, round-trip + fuzz tests. Docs: contracts/*. Depends: T00.
- [ ] **T22 Relay: rooms + signalling** – `room.join`, `room.state`, `rtc.signal`, auth token check. Docs: 03, 06, contracts/ws-messages. Depends: T21.
- [ ] **T23 WebRTC peer connection** – data channel (unordered, maxRetransmits 0), coturn in docker-compose. Docs: 03. Depends: T22.
- [ ] **T24 Lockstep loop** – input delay D, 8-frame redundancy, wait/pause behaviour. Docs: 03. Depends: T20, T23.
- [ ] **T25 Desync detection + resync** – `hash` every 60 frames, `state.snapshot` recovery, logging. Docs: 03. Depends: T24.
- [ ] **T26 Netplay test harness** – Playwright opens two tabs, runs a scripted input file, asserts equal hashes;
  Linux `tc netem` profiles (50/100/150 ms, 1% loss). Depends: T24, T25.

## Phase 3 · Spectating and leaderboard
- [ ] **T30 Relay input log** – define `docs/contracts/input-log.md` (core/rom hash, DIPs, start state, per-frame
  inputs, end score), append-only log per match, close on `game.end`, upload to object storage (local disk or
  MinIO). Docs: 04, 05, contracts/input-log. Depends: T21, T24.
- [ ] **T31 Viewer page** – load state + subscribe to inputs, 3 s buffer, catch-up after stalls. Docs: 04. Depends: T11, T30.
- [ ] **T32 Live scoreboard** – `scoremap` discovery procedure (MAME debugger + `hiscore.dat`) written to
  `core/scoremap/<driver>.json`, loader, `score.live` messages, overlay UI. Docs: 05, contracts/ws-messages. Depends: T24.
- [ ] **T33 Verifier worker** – Redis job → native MAME + `verify.lua` → compare → write scores / flag. Docs: 05. Depends: T01, T21, T30.
- [ ] **T34 API + leaderboards** – Fastify, auth/JWT, schema migrations, board endpoints (Redis sorted sets), replay links. Docs: 05, 06. Depends: T33.
- [ ] **T35 Replays** – "watch from start" using the stored log. Depends: T31.
- [ ] **T36 Anti-cheat input analysis** – flag inhumanly regular / recorded input patterns from the log for review.
  Docs: 05, 07. Depends: T30, T33.

## Phase 4 · Scale and polish
- [ ] **T40 Rollback** (per game flag) – Docs: 03. Depends: T25.
- [ ] **T41 LiveKit video fallback** – Docs: 04. Depends: T31.
- [ ] **T42 Production deploy** – docker-compose for Ubuntu 24.04, TLS, backups, monitoring (Prometheus + Grafana). Docs: 06. Depends: T23, T34.
- [ ] **T43 Load test** – 1 000 simulated viewers on one relay (k6 or a Node script). Docs: 04. Depends: T30.
- [ ] **T44 Relay scale-out** – Redis pub/sub between relay nodes so inputs/spectator fan-out spans processes.
  Docs: 04, 06. Depends: T30, T43.
