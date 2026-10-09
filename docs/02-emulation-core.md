# 02 · Emulation core: MAME → WebAssembly + netplay patch

## Build (Ubuntu 24.04)
```bash
sudo apt install build-essential git python3 \
  libsdl2-dev libsdl2-ttf-dev libfontconfig-dev libpulse-dev \
  qt6-base-dev qt6-base-dev-tools qmake6
git clone https://github.com/emscripten-core/emsdk && cd emsdk
./emsdk install 6.0.2 && ./emsdk activate 6.0.2 && source ./emsdk_env.sh
# from the repo root, with emsdk sourced and mame/ initialised:
core/build-wasm.sh gridlee
# writes core/out/gridlee/<core_hash>/{gridlee.html,gridlee.js,gridlee.wasm,manifest.json}
```

`core/build-wasm.sh <driver>` verifies the pinned emsdk (6.0.2) and MAME commit, runs
`embuilder build sdl3 sdl3_ttf`, then `emmake make SUBTARGET=<driver> SOURCES=... IGNORE_GIT=1
NEW_GIT_VERSION=<commit>`. The em++ link emits `gridlee.{html,js,wasm}` directly (the asmjs
target extension is set in `scripts/src/main.lua:86`); the script publishes them under
`core/out/<driver>/<core_hash>/`, where `<core_hash>` is the sha256 of the `.wasm` — the
byte-identical cross-peer key (`contracts/core-version.md`) — and writes a `manifest.json`
recording the driver, `core_hash`, `mame_commit`, `emsdk` and a sha256 per artifact (so the
`.js` loader/glue is covered too, not just the `.wasm`). The script refuses to build if `mame/`
is at a different commit or has uncommitted changes to tracked files, and it exports the exact
emsdk it verified plus `EMCC_CFLAGS=-Wno-mismatched-tags` (emsdk 6.0.2 ships Clang 23, which
promotes the bundled `3rdparty/residfp` serialization-tag mismatch to an error under MAME's
`-Werror`). Do **not** pass `STRIP_SYMBOLS=1`: `scripts/toolchain.lua:617` then adds an obsolete
"asmjs finalize" `emcc` pass that feeds the already-linked `gridlee.html` back into `wasm-ld`
and fails. `core/out/` is gitignored; publish it to `/static/cores/<driver>/<core_hash>/` at
deploy time.
Host deps above cover the emscripten build and the native build (MAME needs Qt6's `qmake6`/`moc`
to generate the single-driver Makefile even for the default SDL build).
Build the native verifier binary from the **same commit** (`make SUBTARGET=... -j$(nproc)`).
`core/build-native.sh <driver>` wraps this for one free driver and prints the binary sha256; it was
first validated with `gridlee` at pinned commit `b67e5bc`.

## Pinned versions (never use "latest")
The machine-readable source of truth is `core/versions.json`; this table mirrors it and a test
(`core/test/version-pins.test.mjs`) keeps the two equal.

| Tool | Pinned value | Where |
| --- | --- | --- |
| emsdk / Emscripten | `6.0.2` | `core/versions.json`, build scripts, CI |
| Node.js | `24` | `core/versions.json`, `.nvmrc`, `engines` |
| MAME commit | `b67e5bc` (short) | `core/versions.json` (full 40-hex), `mame/` submodule (upstream `mamedev/mame`; the project fork starts at T20) |

Every WASM build is identified by its output sha256 — `core_hash`, the byte-identical cross-peer key — and the
MAME commit it was built from. `core_version` stores the WASM hash and `mame_commit` the commit
(`contracts/core-version.md`, `contracts/db-schema.sql`); peers and viewers must agree on `core_hash`, and the
native verifier must be built from the same `mame_commit` (its own binary hash need not match). A different
`core_hash` between peers is a desync; a different `mame_commit` invalidates the replay. The native build is made reproducible for a
fixed commit+toolchain by stripping debug info (it embeds the absolute build path) and the link-time
build-id (hashed over that path), and by pinning the embedded version to the commit (`NEW_GIT_VERSION`).
`core/build-native.sh` prints the arch and gcc version next to the hash, so a hash is only meaningful for
its recorded `(commit, toolchain, arch)` triple. Byte-identical native binaries across architectures require
the pinned build container in T42; the cross-peer key is the WASM core hash (T10/T11).

## Netplay patch (`core/patches/`, keep it small and in its own files)
The submodule stays **pristine**: the patch is a git-format series applied to the working tree by
`core/patches/apply.sh {apply|revert|status|hash}`. `core/build-wasm.sh` and `core/build-native.sh`
run `apply` after the clean-tree guard and `revert` from an `EXIT` trap, so `mame/` is always clean
between builds. `apply.sh hash` is the sha256 of the series (patches + our sources) and is recorded
as `netplay_patch` in `manifest.json`, tying a `core_hash` back to the exact source
(`contracts/core-version.md`). Files: `core/patches/netplay/netplay.{h,cpp}`, `netplay_post.js` (the
`Module.netplay` glue), and `0001-machine` / `0002-ioport` / `0003-save` / `0004-build` patches.
1. **Frame gate** – in `running_machine::emscripten_main_loop()`, once netplay is active, step one game
   frame via `netplay_try_run_frame(frame)`; if that frame's inputs are missing, pump video and return
   without stepping. A netplay core is **armed at load** (`netplay_enable()` from the JS glue during
   runtime init, before `main()` starts the loop); `netplay_input_active()` activates lazily on the first
   tick, so the machine is frozen at frame 0 and cannot free-run ahead of the lockstep (T24, docs/03).
   Solo loads the same build without arming it, so the stock loop still runs.
2. **Input injection** – `netplay_set_inputs(frame, p1, p2, p3, p4)`; masks are written into the bound
   `ioport_field`s (bits 0-3 joystick, 4-9 B1-B6, 10 start, 11 coin, by `field.player()`), and while
   netplay is active `ioport_field::frame_update()` ignores the local OSD sequence so only injected
   inputs count. Mapping to MAME ioport fields is generic in C++ (`core/inputmap/<driver>.json` is a
   later, per-driver refinement).
3. **State buffers** – `netplay_state_size()` + `netplay_save_state(ptr)` / `netplay_load_state(ptr)` on
   `save_manager::write_buffer/read_buffer` (a new `save_manager::buffer_size()` sizes the buffer).
4. **State hash** – `netplay_hash()` = CRC32 of the full registered machine state (the
   `save_manager` buffer), a fully-initialised superset of main RAM. Hashing raw memory regions was
   rejected: they are ROM regions that can hold uninitialised bytes (determinism-auditor, T20).
5. **Frame clock** – one emulated video frame (the first screen's real `frame_period()`, e.g. 60.6 Hz),
   not a fixed 1/60 s.

`0004-build.patch` also widens the Emscripten `EXPORTED_FUNCTIONS` with `_free` and
`EXPORTED_RUNTIME_METHODS` with `FS` and `HEAPU8`, so the wrapper can mount the ROM and do state
save/load; `netplay_post.js` attaches the stock `JSMAME` object to `Module` (upstream defines it but
never exposes it). Newer T11/T12 fields (`Module.FS`, `Module.JSMAME`) were assumed but only wired
into the build here — the T11 tests use fakes, so a real browser boot is the check.

## Browser wrapper (`web/src/core/`)
- Loads the core, mounts the ROM zip into Emscripten's FS, starts MAME with identical options on every peer:
  `-skip_gameinfo`, empty per-session `-nvram_directory`, no `.ini`, DIP values from the room host.
- Exposes a typed `Core` interface: `load()`, `step(frame, inputs)`, `save()`, `load(state)`, `hash()`, `readScore()`.
- If WASM threads are enabled, serve with `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`.
