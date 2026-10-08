# T10 WASM build script — implementation plan

**Goal:** `core/build-wasm.sh <driver>` builds one driver to WebAssembly with the pinned
emsdk and MAME commit and publishes it under `core/out/<driver>/<core_hash>/`. Docs: 02.

## Decisions (confirmed)
- **`<core_hash>` = sha256 of the `.wasm`** artifact, per `contracts/core-version.md`
  (the cross-peer identity key), not the MAME git-sha. `mame_commit` is recorded
  separately in `manifest.json`.
- **emsdk is detected, not installed:** the script uses `$EMSDK` (from a sourced
  `emsdk_env.sh`) or `--emsdk <dir>` or the `PATH`, and verifies `emcc --version`
  equals the pin (`6.0.2`). It never clones/installs emsdk.
- **Driver→SOURCES is shared:** `core/drivers.sh` holds one `DRIVER_SOURCES` map,
  sourced by both `core/build-native.sh` and `core/build-wasm.sh`.

## Files
- `core/build-wasm.sh` — new build script (CLI mirrors `build-native.sh`:
  `<driver> [--dry-run] | --list-drivers | --help`).
- `core/drivers.sh` — new shared driver→SOURCES map.
- `core/build-native.sh` — source the shared map instead of its inline copy.
- `core/test/build-wasm.test.mjs` — CLI/`--dry-run` tests (written first, red).
- `docs/02-emulation-core.md` — document the script, the `core/out` layout and manifest.
- `docs/tasks/README.md` — mark T10 `[x]`.

## Key source findings
- MAME's emscripten finalize that emits `.js`/`.wasm`/`.html` only runs under
  `STRIP_SYMBOLS=1` (`mame/scripts/toolchain.lua:584,617`); the script must pass it.
- With `SUBTARGET=gridlee` and the default `TARGET=mame`, the project/executable name is
  `mamegridlee` (`mame/makefile:959-962`), so artifacts appear as `mamegridlee.*`.

## Commands / acceptance
- `node --test core/test/build-wasm.test.mjs` — red before, 5 pass after.
- `bash core/build-wasm.sh --dry-run gridlee` — prints the `emmake` command with
  `STRIP_SYMBOLS=1` and `core/out/gridlee/<core_hash>/`.
- Human-only (slow, >10 min): `source emsdk_env.sh && core/build-wasm.sh gridlee` →
  `core/out/gridlee/<core_hash>/{mamegridlee.js,mamegridlee.wasm,manifest.json}`.
- `pnpm lint && pnpm typecheck && pnpm test` pass; no hardcoded emsdk/commit literals.

## Review follow-ups (determinism-auditor)
Applied in this branch: `LC_ALL=C`; refuse uncommitted tracked changes in `mame/`; export the
verified `EMSDK`/`EMSCRIPTEN` so the make uses the checked toolchain (`--emsdk` no longer
diverges from `$EMSDK`); record a sha256 per artifact in `manifest.json`.

Still open (not T10 blockers; track for T11/T42):
- WASM reproducibility across machines is unproven — `core_hash` is only a valid cross-peer key
  if a fixed commit + toolchain yields identical bytes. Validate with two clean builds at
  different checkout paths and `-j` values; add `-ffile-prefix-map` if path leakage shows up.
  (Note: `-sDETERMINISTIC` is unsupported in emsdk 6.x, so the earlier risk note is stale.)
- Build tree is reused in place (`mame/build`, `scripts/`); a stale tree from another
  `CONFIG`/`SOURCES`/toolchain can change bytes. Prefer a clean worktree/BUILDDIR per core build.
- `-j$(nproc)` is host-dependent; pin or record it.
- `embuilder` port libs (`sdl3`, `sdl3_ttf`) come from a mutable cache; hash the linked libs or
  build ports in a pinned container.
