# 02 · Emulation core: MAME → WebAssembly + netplay patch

## Build (Ubuntu 24.04)
```bash
sudo apt install build-essential git python3 \
  libsdl2-dev libsdl2-ttf-dev libfontconfig-dev libpulse-dev \
  qt6-base-dev qt6-base-dev-tools qmake6
git clone https://github.com/emscripten-core/emsdk && cd emsdk
./emsdk install 6.0.2 && ./emsdk activate 6.0.2 && source ./emsdk_env.sh
embuilder build sdl3 sdl3_ttf
cd mame && emmake make SUBTARGET=<name> SOURCES=src/mame/<path>/<driver>.cpp -j$(nproc)
# output <name>.js + <name>.wasm → static/cores/<driver>/<git-sha>/
```
Host deps above cover the emscripten build and the native build (MAME needs Qt6's `qmake6`/`moc`
to generate the single-driver Makefile even for the default SDL build).
Build the native verifier binary from the **same commit** (`make SUBTARGET=... -j$(nproc)`).
`core/build-native.sh <driver>` wraps this for one free driver and prints the binary sha256; it was
first validated with `gridlee` at pinned commit `b67e5bc`.

## Pinned versions (never use "latest")
| Tool | Pinned value | Where |
| --- | --- | --- |
| emsdk / Emscripten | `6.0.2` | build scripts, CI |
| Node.js | `24` | `.nvmrc`, `engines` |
| MAME commit | `b67e5bc` | `mame/` submodule (upstream `mamedev/mame`; the project fork starts at T20) |

Every WASM and native build is keyed by its output sha256 and the MAME commit; the pair is stored as
`core_version` on `games` and `matches` (`contracts/db-schema.sql`) and must match between every peer and the
verifier. A different value means a desync and a failed replay. The native build is made reproducible for a
fixed commit+toolchain by stripping debug info (it embeds the absolute build path) and the link-time
build-id (hashed over that path), and by pinning the embedded version to the commit (`NEW_GIT_VERSION`).
`core/build-native.sh` prints the arch and gcc version next to the hash, so a hash is only meaningful for
its recorded `(commit, toolchain, arch)` triple. Byte-identical native binaries across architectures require
the pinned build container in T42; the cross-peer key is the WASM core hash (T10/T11).

## Netplay patch (`core/patches/`, keep it small and in its own files)
1. **Frame gate** – in `running_machine::emscripten_main_loop()`, call `netplay_ready(frame)` before
   stepping; if inputs for that frame are missing, return without stepping.
2. **Input injection** – `EMSCRIPTEN_KEEPALIVE netplay_set_inputs(frame, p1, p2, p3, p4)`; at frame start
   write bitmasks into ioport fields (C++ equivalent of `field:set_value`). Local input never reaches MAME directly.
3. **State buffers** – `netplay_save_state(ptr)` / `netplay_load_state(ptr)` on `save_manager::write_buffer/read_buffer`.
4. **State hash** – `netplay_hash()` = CRC32 of main RAM.
5. **Frame clock** – step one emulated video frame (game's real screen period, e.g. 60.6 Hz), not fixed 1/60 s.

## Browser wrapper (`web/src/core/`)
- Loads the core, mounts the ROM zip into Emscripten's FS, starts MAME with identical options on every peer:
  `-skip_gameinfo`, empty per-session `-nvram_directory`, no `.ini`, DIP values from the room host.
- Exposes a typed `Core` interface: `load()`, `step(frame, inputs)`, `save()`, `load(state)`, `hash()`, `readScore()`.
- If WASM threads are enabled, serve with `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`.
