# 02 · Emulation core: MAME → WebAssembly + netplay patch

## Build (Ubuntu 24.04)
```bash
sudo apt install build-essential git python3 libsdl2-dev
git clone https://github.com/emscripten-core/emsdk && cd emsdk
./emsdk install latest && ./emsdk activate latest && source ./emsdk_env.sh
embuilder build sdl3 sdl3_ttf
cd mame && emmake make SUBTARGET=<name> SOURCES=src/mame/<path>/<driver>.cpp -j$(nproc)
# output <name>.js + <name>.wasm → static/cores/<driver>/<git-sha>/
```
Build the native verifier binary from the **same commit** (`make SUBTARGET=... -j$(nproc)`).
`core/build-wasm.sh` and `core/build-native.sh` wrap these and print the output hash.

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
