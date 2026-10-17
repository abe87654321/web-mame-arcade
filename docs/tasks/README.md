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
- [x] **T10 WASM build script** – `core/build-wasm.sh <driver>` via emsdk; outputs to `core/out/<driver>/<sha>/`. Docs: 02.
- [x] **T11 Core wrapper** – `web/src/core/` typed `Core` interface (load, step, save, load, hash, readScore) around the
  stock WASM build; ROM zip mounted into FS. Docs: 02. Depends: T10.
- [x] **T12 Input layer** – keyboard + Gamepad API → 16-bit mask per contract; remapping UI. Docs: contracts/input-packet. Depends: T11.
  Note: the remapping UI was only a module until T52 wired it into the app (`input/setup.ts`): the play
  page now has a **Controls** panel, gamepads hot-plug and persist per browser, and a freshly connected
  pad takes **P1** while P1 is still the default keyboard (otherwise the lowest free slot). P2–P4 are
  gamepads; there is no keyboard binding for P2 because one device serves one slot, and in netplay each
  player is a separate browser/token (not a key).
- [x] **T13 Game page + catalogue** – game list from a static JSON, play page, Nginx dev config with COOP/COEP. Depends: T11.

## Phase 2 · Two-player lockstep
- [x] **T20 Netplay patch** – frame gate, `netplay_set_inputs`, `netplay_save_state/load_state`, `netplay_hash`,
  frame clock, in `core/patches/`. Docs: 01, 02. Human reviews every C++ line. Depends: T10.
- [x] **T21 Protocol package** – `encodeInput/decodeInput`, zod message schemas, round-trip + fuzz tests. Docs: contracts/*. Depends: T00.
- [x] **T22 Relay: rooms + signalling** – `room.join`, `room.state`, `rtc.signal`, auth token check. Docs: 03, 06, contracts/ws-messages. Depends: T21.
- [x] **T23 WebRTC peer connection** – data channel (unordered, maxRetransmits 0), coturn in docker-compose. Docs: 03. Depends: T22.
- [x] **T24 Lockstep loop** – input delay D, 8-frame redundancy, wait/pause behaviour. Docs: 03. Depends: T20, T23.
- [x] **T25 Desync detection + resync** – `hash` every 60 frames, `state.snapshot` recovery, logging. Docs: 03. Depends: T24.
- [x] **T26 Netplay test harness** – Playwright opens two tabs, runs a scripted input file, asserts equal hashes;
  Linux `tc netem` profiles (50/100/150 ms, 1% loss). Depends: T24, T25.
- [x] **T27 Lobby & room UI** – turn the minimal T24 start bar into a proper lobby: player slots with
  names/ready state, host-only "Start game" enabled only when all peers are connected, room status
  (waiting/playing), leave/disconnect handling, and a place for chat (T30/T36 server side). Reuses
  `room.state`/`game.start` (T22/T24); feeds the viewer (T31) and replays (T35). Docs: 03, contracts/ws-messages.
  Depends: T22, T24.
- [x] **T28 Netplay observability + save/load/hash spike** – before hardening the lockstep, make it
  measurable and gather the data the next decisions need: a pure, clock-injected metrics module
  (per-peer RTT from the input packet's `ack_frame`, jitter, gap-based loss, P2P-vs-relay source
  tally), a DEV-only frame/lag/ack overlay, and a reproducible spike measuring `save()/load()/hash()`
  ms and bytes on the WASM core and native MAME plus a state round-trip check (feeds T29/T40 and the
  SLO-C decision T45). Docs: 02, 03, 08, contracts/input-packet, contracts/ws-messages. Depends: T24,
  T25, T31. Acceptance: metrics + overlay unit tests; committed spike report (`core/spike/README.md`:
  per-driver ms/bytes + round-trip PASS); no change to the emulation path.
- [x] **T29 Client lockstep hardening** – make the browser lockstep
  resilient once the metrics show what actually stalls: visibility-aware collaborative pause (a
  hidden/occluded tab throttles `requestAnimationFrame`, so that peer stops feeding inputs and stalls
  everyone), mutual-stall recovery + a host-snapshot fallback, adaptive input delay from measured
  RTT, and a golden-replay regression. Docs: 03, 04, contracts/ws-messages, contracts/input-packet.
  Depends: T28.

## Phase 3 · Spectating and leaderboard
- [x] **T30 Relay input log** – define `docs/contracts/input-log.md` (core/rom hash, DIPs, start state, per-frame
  inputs, end score), append-only log per match, close on `game.end`, upload to object storage (local disk or
  MinIO). Docs: 04, 05, contracts/input-log. Depends: T21, T24.
- [x] **T31 Viewer page** – load state + subscribe to inputs, 3 s buffer, catch-up after stalls. Docs: 04. Depends: T11, T30.
- [x] **T32a Live scoreboard (browser)** – `scoremap` schema/loader + `score.live` messages (player samples its
  slot's score once per second, relay stamps and fans out, fills the input log's `end.scores`) + overlay UI for
  players and viewers. `readScore` stays behind `CoreCapabilityError` until T32b. Docs: 05, contracts/ws-messages. Depends: T24.
- [x] **T32b Scoremap core read** – native `netplay_read_bytes` + WASM rebuild + gridlee address discovery
  (`core/scoremap/<driver>.json`), wired into `Core.readScore`. Docs: 05, contracts/ws-messages. Depends: T32a.
  Note: gridlee score found (3-byte BCD @0x0433; `core/scoremap/gridlee.json`).
- [x] **T33 Verifier worker** – Redis job → native MAME + `verify.lua` → compare → write scores / flag. Docs: 05. Depends: T01, T21, T30.
- [x] **T34 API + leaderboards** – Fastify, auth/JWT, schema migrations, board endpoints (Redis sorted sets), replay links. Docs: 05, 06. Depends: T33.
  Note: boards are derived from PostgreSQL `scores` (ZSET write-through deferred); the verifier upserts `matches`/`match_players` from the closed log.
- [x] **T35 Replays** – "watch from start" using the stored log. Depends: T31.
- [x] **T36 Anti-cheat input analysis** – flag inhumanly regular / recorded input patterns from the log for review.
  Docs: 05, 07. Depends: T30, T33.
  Note: pure `analyzeInputLog` (periodic/uniform-hold heuristics) + advisory `match_flags` rows in the verifier; no score or status change.
  Also added a local-dev PostgreSQL service to `deploy/docker-compose.yml` (+ `deploy/.env.example`) so the `0004_match_flags`
  migration can be applied and verified locally; T42 still owns the production database (backups, monitoring).
- [x] **T46 Netplay save/load continuation is not reproducible (bug)** – `e2e/save-integrity.e2e.ts` showed that
  on the real netplay seam `Core.load(save())` + same inputs did **not** reproduce the uninterrupted future.
  Fixed three root causes in `core/patches/`: the scheduler callback clock (`0007`), the Lua resume timer
  (`0009`), and the unsaved ioport live state (netplay snapshot). gridlee/twinbee now report `forward == reload`
  at every boot/span and input tried; native stays byte-exact. raiden/raiden2 `Core.save()` throws despite
  `MACHINE_SUPPORTS_SAVE`, so they are catalogued `supportsSave:false` / `netplayMode:"none"`. Docs: 00, 03, 04.
  Plan: `docs/tasks/T46-save-load-continuation.md`.
- [ ] **T47 Scoremaps for the local-dev drivers** – discover and add `core/scoremap/<driver>.json`
  (live scoreboard + verified leaderboard) for `twinbee`/`raiden`/`raiden2`/`twincobr`, following the
  T32b workflow (`core/scoremap/README.md`, cheat search). Docs: 05, contracts/scoremap. Depends: T32b, T33.
  Note: the multi-slot decode is wired (`core/verify.lua` reads every `players[]` entry; CI guard
  `core/test/verify-lua.test.mjs`), `core/scoremap/watch.lua` is parameterized for any driver, and a dev-only
  in-browser cheat search (`?cheatsearch=1`, `packages/web/src/cheatsearch.ts`, `core/scoremap/README.md`
  Option C) lets discovery run without the native MAME UI. `twinbee` and `twincobr` are done (slot 0) — the
  latter needed the T50 byte-lane fix and a `divisor` (it stores the score ×10). T49 (raiden/raiden2 black
  screen, bad ROM sets) is fixed and the T50 core rebuild has landed, so their scoremaps can now be
  discovered. The **verified** half of the leaderboard is blocked on T48 (the replay path itself is broken).
- [x] **T50 netplay_read_bytes misreads 16-bit address spaces (bug)** – `netplay_read_bytes` (T32b)
  returns each 16-bit word's **low byte for both lanes**, so every byte read of a 68k/V30 game is wrong.
  Evidence: reading twincobr's `:maincpu`/`program` ROM at `0x0` gives `03 03 00 00 02 02 94 94` where the
  real interleaved ROM is `00 03 20 00 00 02 01 94` (the low byte duplicated); the same mirroring appears in
  RAM. This is why no score value ever matched for twincobr and blocks T47's twincobr/raiden/raiden2
  scoremaps (the 8-bit twinbee is unaffected). Fix the byte read for 16-bit spaces (correct lane selection
  via `get_read_ptr`), rebuild the WASM cores, and prove it by re-reading the ROM and re-running the cheat
  search. Docs: 02, 05, contracts/scoremap. Depends: T32b.
  Note: fix landed in `core/patches/netplay/netplay.cpp` (byte lane via `lowmask` + `BYTE8_XOR_BE/LE`,
  matching MAME's `direct_mem_read`; guarded by `core/test/netplay-patch.test.mjs`) and the twincobr WASM
  core was rebuilt/republished — re-reading the twincobr ROM at `0x0` now returns the correct
  `00 03 20 00 00 02 01 94`, and RAM discovery found the twincobr score (`0x3184e`). Once T49 fixed their ROM
  sets, the `raiden`/`raiden2` cores were rebuilt/republished too; reading raiden's `:maincpu`/`program` at
  `0xa0000` now returns the correct interleaved `00 00 00 02 12 02 24 02` (was the duplicated low byte).
- [x] **T49 raiden/raiden2 WASM cores render a black screen (bug)** – in the browser the `raiden`/`raiden2`
  cores reach "running Raiden" but draw nothing (the canvas screenshot is all black) and every
  `:maincpu`/`program` byte read in `0x00000-0x06fff` returns -1 (no direct pointer), so the score can
  neither be seen nor searched — blocking T47's raiden/raiden2 scoremaps. Reproduce `#/game/raiden`;
  investigate the WASM build (driver SOURCES / video wiring) or the ROM set. Docs: 02, 05.
  Note: not a video/build bug — the local ROM zips were the wrong MAME **version**. `roms/raiden.zip`
  was a 0.225-era `raidenj` set (missing the parent's `4.u023`; MAME #11257, 2023, renamed the sets) and
  `roms/raiden2.zip` lacked the two PALs (`jj4b01`/`jj4b02`) 0.289 requires. MAME refused to start and
  blocked on its ROM warning modal, so the canvas stayed black and no address space was populated
  (`netplay_read_bytes` → -1). Fixed by replacing both with MAME 0.289 **split sets** (`verifyroms` →
  `1 were OK`) and updating their `games.json` `romHash`. Guarded by `core/test/rom-audit.test.mjs`
  (ROM audit + romHash ↔ zip sha256, skips in CI) and `e2e/boot.e2e.ts` (asserts the emulated clock
  advances). Docs: 02.
- [ ] **T48 Fix the native verifier replay path (bug)** – `core/verify.lua` (T33) was only tested against
  mocked output and fails on a real run: it passes JSON to Lua `load()`, native MAME ships no `json` module,
  and it calls the wrong APIs (`m:input()`, `m:step()`). Implement a Lua JSON decode of the closed log,
  correct ioport input injection, and frame-accurate stepping, then un-`fixme` the `e2e/verify.e2e.ts`
  golden (two-slot fixture ready). Docs: 05, contracts/input-log, contracts/scoremap. Depends: T33.

## Phase 4 · Scale and polish
- [x] **T40 Rollback** (per game flag) – Docs: 03. Depends: T25.
  Note: bounded rollback loop (`packages/web/src/netplay/rollback.ts`): last-confirmed prediction,
  2..8 frame correctable window (per-driver `rollbackWindow`), boot-frame correction, deferred hashes,
  fixed `inputDelay = 2`, and a local over-load meter that degrades to wait-only for the rest of the
  match (>20 ms for 1 s, or >20 rewinds per 60 frames). Re-simulation is incremental (one already-shown
  frame per tick, silently), so a slow core never re-simulates a whole window in one frame; it briefly
  slows down instead. Resync now re-uses the local masks already sent for frames after the snapshot,
  closing the verifier/input-log gap previously deferred here. The per-driver probe
  (`pnpm --filter @wma/e2e test:rollback-budget`) gates on `save + one step <= 16 ms`; on the
  headless/SwiftShader dev machine that enabled gridlee, raiden, commando, jackal and rygar
  (`rollbackWindow: 8`), while twinbee/raiden2/twincobr/tankfrce/gwar/tigerh stayed `lockstep`. geminij
  fits the budget but failed the two-tab gate (desync at frame 60), so it stays `lockstep` pending T53.
  The silent-render step is a T40 core patch (`0010-netplay-silent.patch`); only gridlee's core was
  rebuilt locally. Netem run not executed locally (sudo password required).
- [x] **T41 LiveKit video fallback** – Docs: 04. Depends: T31.
- [ ] **T42 Production deploy** – docker-compose for Ubuntu 24.04, TLS, backups, monitoring (Prometheus + Grafana). Docs: 06. Depends: T23, T34.
- [ ] **T43 Load test** – 1 000 simulated viewers on one relay (k6 or a Node script). Docs: 04. Depends: T30.
- [ ] **T44 Relay scale-out** – Redis pub/sub between relay nodes so inputs/spectator fan-out spans processes.
  Docs: 04, 06. Depends: T30, T43.

## Phase 5 · Strong-sync (SLO C): server-authoritative emulation
- [ ] **T45 Server-authoritative live emulation (SLO C)** – one authoritative native MAME per match on
  the server: input aggregation with a fixed input delay + jitter buffer, frame capture + hardware
  encode, and LiveKit WebRTC publish; clients send inputs and watch video, so synchronization is
  absolute regardless of client tab/CPU/network. Reuses the native build and LiveKit (T41). Cost: one
  server sim + video bandwidth per match. Depends: T01, T41, T28.

## Ongoing · game intake
- [x] **T51 Onboard a newly-added game (repeatable)** – a runbook + read-only helper for whenever a new
  `roms/<driver>.zip` appears, so publishing never ships a black-screen core (T49), a stale `romHash`, or
  a game wrongly marked solo-only. **Every game in this arcade is meant to be played by 2+ players over
  the network**, so `netplayMode` starts at `"lockstep"` and may only fall back to `"none"` on recorded
  evidence (MAME says `savestate="unsupported"`, or `e2e/save-integrity.e2e.ts` fails).
  `pnpm onboard --list` shows every `roms/*.zip` with no catalogue entry, its sha256 (`romHash`) and
  whether `core/drivers.sh` knows it; `pnpm onboard --check <driver>` reports catalogue/`drivers.sh`
  status and, when a native build exists, runs MAME's own ROM audit (`verifyroms`) plus MAME's
  `savestate` netplay flag (`-listxml`). Full per-game flow:
  (1) `pnpm onboard --list`; (2) add the driver's `SOURCES` to `core/drivers.sh` and
  `core/build-native.sh <driver>`; (3) `pnpm onboard --check <driver>` → expect "set matches the pinned
  commit" and read the recommended netplay mode; (4) add a `packages/web/public/games.json` entry
  (name/title/`romHash`/`supportsSave`/`netplayMode`/`maxPlayers`/`romLicensed`/urls) —
  `supportsSave:true` + `netplayMode:"lockstep"` by default; (5) `core/build-wasm.sh <driver> &&
  core/publish-web.sh <driver>`; (6) **prove netplay**: `e2e/save-integrity.e2e.ts` must report
  `verdict=PASS` (forward == reload) for the driver before it ships as lockstep (twincobr is the
  counter-example: `savestate="unsupported"` and the gate FAILs, so it is `none`); (7) add an input
  fixture `e2e/fixtures/inputs/<driver>.e2e.json` so the two-tab lockstep e2e exercises it, and run
  `WMA_E2E_DRIVERS=<driver> pnpm --filter @wma/e2e test:e2e -g "netplay lockstep"`; (8) optionally
  discover `core/scoremap/<driver>.json` (T47 workflow); (9) `node --test core/test/rom-audit.test.mjs`
  and `pnpm --filter @wma/e2e test:e2e -g boot`; commit. Docs: 02, 03, 05, contracts/scoremap. Depends:
  T49, T46 (save-integrity gate), T47. Helper: `core/onboard-game.mjs`
  (`core/test/onboard-game.test.mjs`).
  Note: onboarded all seven — `commando`, `jackal`, `rygar`, `tankfrce`, `geminij` (split clone;
  `extraRomZips` mounts the parent `gemini.zip`) and `tigerh` (device ROM; `extraRomZips` mounts
  `m68705p5.zip`) as lockstep (ROM + save-integrity OK), plus `gwar` solo-only (MAME omits
  `MACHINE_SUPPORTS_SAVE`). The `extraRomZips` catalogue field (parent set / bios·device ROM mounted
  by name under `-rompath`) is the general fix for clones and MCU-bearing drivers. Netplay reliability
  of the new lockstep drivers is tracked by T53.
- [ ] **T53 Cross-peer lockstep is intermittent (reliability, bug)** – the two-tab `e2e/netplay.e2e.ts`
  is flaky even for the reference driver: one run had `gridlee`/`jackal` pass while `commando`/`rygar`/
  `tankfrce`/`gwar` FAILED with repeated `desync` at frames 60/120/180/240, and `raiden` failed once then
  passed on rerun. A direct two-core probe (two pages, identical `core.step` inputs, compare `hash()`)
  gave **non-correlating** results (`gridlee`/`commando` equal, `jackal`/`rygar` diverge), so this is a
  cross-peer **frame-0/arming alignment race** in the delay-lockstep, not a per-driver emulation bug
  (`e2e/save-integrity.e2e.ts` PASSes for every one of them single-instance). Impact: constant
  `stall-escalate` resyncs → stutter, and it does not scale to >2 players. Fix path: a deterministic
  start barrier (all peers pinned to a common frame 0 before the gate opens) and **rollback** (T40);
  re-run the two-tab e2e as the gate. Docs: 03, 04. Depends: T24, T25, T29, T40.
  Scope for the follow-up session: (a) the **frame-0/alignent race** (this task) and (b) **input
  responsiveness**: in delay-based lockstep the felt latency is `inputDelay + RTT` (worse with 3-4
  players), so a gamepad feels laggy — **rollback (T40)** is the fix, not pushing video. Measure with the
  T28 metrics + the two-tab/3-tab e2e after each change.
- [x] **T49 follow-up · raiden/raiden2 netplay re-enabled** – the T46 "raiden/raiden2 `Core.save()`
  throws" finding was a downstream symptom of the bad ROMs (T49): MAME never started, so
  `netplay_state_size()` returned 0. With the corrected 0.289 sets, `Core.save()` returns 330 KB / 1.3 MB
  and `e2e/save-integrity.e2e.ts` reports `verdict=PASS` (forward == reload == reload2, loadByteEqual) for
  both, so the catalogue flips them to `supportsSave:true` / `netplayMode:"lockstep"`. Docs: 02, 03.
