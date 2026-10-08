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

## Risks
- WASM reproducibility across machines is not yet proven; `core_hash` is only a valid
  cross-peer key if a fixed commit + toolchain yields identical bytes. Validate by
  rebuilding and comparing `core_hash`; may need `-s DETERMINISTIC`.
