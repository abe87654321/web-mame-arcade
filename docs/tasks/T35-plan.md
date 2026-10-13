# T35 · Replays (watch from start) — implementation plan

**Goal:** let a viewer open a **closed** match at `#/game/<driver>/replay/<key>`,
fetch its stored input log (`match/<room>/<id>.json.gz`, served at
`GET /api/replays/:key`), and replay it from the start on the same frozen WASM
core the match ran on — deterministically, with play/pause, restart and a frame
progress indicator.

Docs: 04, 05, contracts/input-log. Depends: T31 (done). Replay links come from
T34's API (done); this task adds the route the links will point at.

## Decisions

- **Route carries the driver: `#/game/<driver>/replay/<key>`.** Keeping the driver
  in the URL mirrors the watch route and lets the app resolve the catalogue entry
  (and therefore the core URL) *before* decoding, so a log whose core cannot be
  built is rejected up front. `key` is `encodeURIComponent`-encoded (it contains
  `/`), captured as one `[^/]+` path segment by `parseRoute`.
- **The core is armed (`netplay: true`) even without a room.** A replay steps the
  core from outside the lockstep exactly like the viewer does, so the core must be
  frozen at boot and driven only by the controller's `tick`.
- **The core identity is verified against the log before stepping.**
  `entry.coreVersion === log.meta.core_hash`, `entry.romHash === log.meta.rom_hash`
  and `entry.mameCommit === log.meta.mame_commit`, or the route shows an error and
  never replays. A mismatched core is a guaranteed false replay (docs/contracts/
  core-version.md).
- **Replay steps only log frames.** `frames[i]` is absolute `start.frame + i`; the
  mask row is aligned to `start.players` order, not slot order, so `frameInputsAt`
  maps `row[j]` to `start.players[j].slot`. Frames before `start.frame` are neutral.
  No clock reading reaches `core.step` (AGENTS.md determinism rule).
- **Restart uses a boot snapshot, not a re-`load()`.** The controller captures
  `core.save()` once at frame `start.frame` (T20 seam) and `restart()` does
  `core.load(boot, start.frame - 1)`: `netplay_set_frame` resumes at
  `frame + 1`, so this makes the next stepped frame `start.frame` (for the
  `start.frame === 0` case the `uint32` clock wraps). Same recovery path T25
  uses — no fresh boot, no clock. A log with `start.frame > 0` and a null
  `start_state_key` is not supported (the boot snapshot is the frame-0 state);
  T30 always writes `start.frame = 0`, so this cannot occur today.
- **Arbitrary seek is out of scope.** With no intermediate snapshots a seek would
  re-step from boot; "watch from start" only needs play/pause/restart. A scrub bar
  can come with replay snapshots later.
- **The log fetch is injectable.** Default fetches `/api/replays/<key>` (base from
  `VITE_API_URL`) and gunzips via `DecompressionStream("gzip")`; both are injected,
  so unit tests and the e2e need no API server.

## Files

- `docs/04-spectating.md` — `## Implemented in T35` (Watch UI: "watch from start").
- `docs/contracts/input-log.md` — one line: the web reads the same artifact via
  `GET /api/replays/:key`.
- `packages/web/src/core/gzip.ts` — `gunzip(bytes)` over `DecompressionStream` (new).
- `packages/web/src/netplay/replay.ts` — pure, clock-injected replay controller +
  `frameInputsAt` (new).
- `packages/web/src/netplay/index.ts` — export the replay surface.
- `packages/web/src/app/router.ts` — `replay` route kind, `replayHref`, parse branch.
- `packages/web/src/app/replay-view.ts` — DOM-free overlay (new).
- `packages/web/src/app/app.ts` — `loadReplay` seam, replay route wiring, teardown.
- `packages/web/src/core/gzip.test.ts`, `packages/web/src/netplay/replay.test.ts`,
  `packages/web/src/app/{router,replay-view,app}.test.ts`.
- `e2e/replay.e2e.ts` — golden: replay a generated closed log to the committed CRC32.
- `docs/tasks/README.md` — tick T35.

## Scope

- In: closed-log fetch + decode, core/ROM/commit verification, deterministic
  from-the-start replay, play/pause/restart/progress overlay, the replay route.
- Out: a UI entry point that links to replays (T34 shipped the API only; leaderboard/
  match-detail UI is later), arbitrary scrubbing, replay snapshots, anti-cheat (T36),
  server-side replay (T45).

## Acceptance criteria

- [ ] A closed log at `GET /api/replays/:key` plays at
      `#/game/<driver>/replay/<key>` from `start.frame` to `end.frame` on the
      frozen core, reaching status `ended`.
- [ ] A log whose `core_hash`/`rom_hash`/`mame_commit` do not match the catalogue
      entry is refused (error view, no stepping).
- [ ] Play/pause, restart (boot-snapshot reload) and a frame progress indicator work.
- [ ] No clock/randomness reaches `core.step`; the same `now` sequence yields the
      same step trace.
- [ ] Tests added: gzip round-trip, `frameInputsAt`/cadence/pause/restart/end,
      router replay route + `replayHref`, replay view, app wiring; golden e2e.
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass.

## Post-review follow-ups

- **Blocker fixed:** `.replay-host` had no CSS and was appended after the
  full-viewport `#canvas`, so the controls/progress rendered below the fold and
  were unreachable in a real browser (unit tests use a fake DOM; the e2e only
  polls `core.hash()`). Added a fixed-position `.replay-host` + panel styling in
  `packages/web/index.html`, matching the lobby/viewer overlays.
- Clamped the progress readout to `end.frame` (it showed `frame+1 / end.frame`
  once ended) and disabled the pause/restart controls until a replay exists.
- Corrected the restart plan text to `core.load(boot, start.frame - 1)` and
  documented that `start.frame > 0` with a null `start_state_key` is unsupported
  (T30 always writes `start.frame = 0`).
- Broadened coverage: all three identity fields (`core_hash`/`rom_hash`/
  `mame_commit`) and a malformed artifact now have app tests; the view tests
  cover the ended clamp and disabled controls.
- **Deferred (documented):** `/api` is not proxied by the Vite dev server, so a
  developer needs `VITE_API_URL`; production nginx fronts the URL and the e2e
  intercepts it. Replay links/leaderboard UI remain later work (T34 shipped the
  API only).

## Notes for the agent

- Files you may touch: the paths above.
- Files you must not touch: `mame/**` (except via `core/patches/`);
  `packages/protocol/**`, `packages/relay/**`, `packages/api/**` (the codec and the
  replay route already exist). No native/WASM rebuild is needed for this task.
- Force `LoadCoreOptions.netplay: true` on the replay load path, or the core runs
  its own loop and `step` is unavailable.
- The InputLog fixture must satisfy the strict zod schema (`frames[i].length ===
  players.length`, delay window neutral) or `decodeInputLog` throws.
- The e2e golden is skipped until the WASM core and ROM exist (gitignored), matching
  `e2e/golden-replay.e2e.ts`; it routes `**/api/replays/**` itself, so no API is needed.
- Verify `/api` is proxied by the Vite dev server (or `VITE_API_URL` is set) so the
  real page can fetch `/api/replays/<key>`.
