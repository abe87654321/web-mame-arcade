# T11 Core wrapper — implementation plan

**Goal:** a typed `Core` interface at `packages/web/src/core/` that loads a stock
`core/out/<driver>/<core_hash>/` WASM bundle, verifies it against `manifest.json`, mounts the
ROM zip into the Emscripten FS, and exposes `load/step/save/load/hash/readScore/reset/destroy`.
Docs: 02.

## Decisions (confirmed)
- **Core interface scope:** define the full typed interface now. `MameCore` implements
  `load()` (boot), `load(state)`, `reset()`, `destroy()` against the stock build and throws a
  typed `CoreCapabilityError` for `step/save/hash` (need the T20 netplay patch) and `readScore`
  (needs T32 scoremap). The stock Emscripten build only exposes `Module` + `JSMAME`
  (`mame/scripts/resources/emscripten/emscripten_post.js`, `mame/scripts/genie.lua:1133-1140`).
- **Location:** `packages/web/src/core/` inside `@wma/web` (matches docs/02), not a new package.

## Files
- `packages/web/src/core/types.ts` — `Core`, `CoreOptions`, `CoreManifest`, `FrameInputs`, `StateHash`.
- `packages/web/src/core/errors.ts` — `CoreCapabilityError`.
- `packages/web/src/core/module.ts` — structural `CoreModule` (`Module` + `JSMAME` + optional `NetplayHooks`).
- `packages/web/src/core/manifest.ts` — `parseManifest`, `sha256Hex`, `verifyArtifact`.
- `packages/web/src/core/options.ts` — `buildMameArgs` (fixed, deterministic command line).
- `packages/web/src/core/rom.ts` — `mountRom` (write the zip into the Emscripten FS).
- `packages/web/src/core/mame-core.ts` — `MameCore implements Core`, capability gating.
- `packages/web/src/core/loader.ts` — `loadCoreBundle`: verify all artifacts, then boot.
- `packages/web/src/core/browser.ts` — `loadBrowserCore`: fetch + verify + classic-script injection.
- `packages/web/src/core/index.ts` — public barrel.
- `*.test.ts` beside each source file (Vitest).
- `docs/tasks/README.md` — tick T11.

## Key source findings
- `core/build-wasm.sh` writes `manifest.json` with `driver, core_hash, mame_commit, emsdk,
  artifacts{ name -> sha256 }`; `core_hash` is the sha256 of the `.wasm` (`contracts/core-version.md`).
- The generated `.js` is **not** `MODULARIZE`d: it reads a pre-seeded global `Module`, runs
  `preRun`, and auto-starts `main` (`INVOKE_RUN`). So the ROM must be mounted in `preRun`, before
  the runtime boots. The wrapper's pure logic is testable with fake modules.
- `JSMAME` exposes `save/load/soft_reset/hard_reset/exit` (`emscripten_post.js`).

## Commands / acceptance
- `pnpm --filter @wma/web test` — all core tests pass.
- `pnpm lint && pnpm typecheck && pnpm test` — pass; nothing under `mame/**`, no `*.wasm`, no `roms/`.
- Human-only (slow): `source emsdk_env.sh && core/build-wasm.sh gridlee` then serve
  `core/out` and load via `loadBrowserCore`. The browser adapter is verified-by-fakes until a real
  artifact exists; exact Emscripten config is confirmed then.

## Risks
- No WASM artifact exists yet; the real `Module.arguments`/`preRun`/auto-run behaviour is confirmed
  only after the human build. If MAME needs `callMain`/`noInitialRun`, adjust only `browser.ts`.
- Artifacts are fetched once to hash and again by the injected script (browser cache expected).
- Determinism: `buildMameArgs`, `mountRom`, `parseManifest`, `sha256Hex` are pure and free of
  clock/locale/random. No emulation code changes in T11, so no golden replay required.
