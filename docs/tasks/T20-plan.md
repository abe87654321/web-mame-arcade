# T20 Netplay patch — implementation plan

**Goal:** add the netplay patch to `core/patches/` exposing a frame gate, `netplay_set_inputs`,
`netplay_save_state`/`netplay_load_state`, `netplay_hash` and a real-frame clock, plus the
`Module.netplay` glue the wrapper (`packages/web/src/core/module.ts`) already expects. Docs: 01, 02.
Depends: T10. Human reviews every C++ line.

## Decisions (confirmed)
- **Delivery: git-format patch series + `core/patches/apply.sh`.** The pinned `mame/` submodule stays
  pristine; the build scripts apply the patch, build, then revert (trap), so the tree is clean between
  builds and `core_hash` ties to a recorded patch hash. No fork remote, no submodule bump (keeps the
  T01/T02 determinism baseline).
- **Mask -> field mapping is generic in C++:** bind by `ioport_type` + `field.player()`; no per-driver
  JSON in T20.
- **`netplay_hash` = CRC32 of the `save_manager` buffer** (full registered machine state). Changed
  from "all memory regions" after the determinism audit: `memory_manager::regions()` holds ROM
  regions that can contain uninitialised bytes, so raw-region CRC diverges across peers. The save
  buffer is fully initialised and covers main RAM plus device state.

## Verified MAME API surface (pinned commit `b67e5bcb`)
- `running_machine::emscripten_main_loop()` `machine.cpp:1401`; fixed `HZ_TO_ATTOSECONDS(60)` `:1415`;
  hooks `machine.h:352-367`.
- Public accessors: `scheduler()` `machine.h:121`, `save():122`, `memory():123`, `ioport():124`,
  `time():158`, `scheduled_event_pending():159`, `paused():144`,
  `emscripten_get_running_machine()` `:358`.
- `ioport_manager::ports()` `ioport.h:946`; `ioport_port::fields()` `:774`; `ioport_field::type()`,
  `player()`, `set_value()` `:592/:593/:595`; per-frame aggregate `ioport.cpp:1217/1624`; OSD term
  `machine().input().seq_pressed(seq())` `ioport.cpp:1244`.
- `save_manager::write_buffer/read_buffer` `save.cpp:367/387`; size = `HEADER_SIZE(32) + Σ entries`
  `save.cpp:414-416` (mirrors private `ram_state::get_size` `save.cpp:598`).
- `memory_manager::regions()` `emumem.h:2710`; `memory_region::base()/bytes()` `:2579/:2581`.
- First screen: `screen_device_enumerator(machine.root_device()).first()` `screen.h:512`; `frame_period()`
  `screen.h:378`.
- `util::crc32_creator::simple(data,len)` `hashing.h:170`.
- Build wiring: `scripts/src/emu.lua:168-207`, `scripts/genie.lua:1140` (`--post-js`).

## Files
New (ours; `apply.sh` copies `netplay/*` into `mame/`):
- `core/patches/apply.sh` — `apply|revert|status|hash`.
- `core/patches/netplay/netplay.h`, `netplay.cpp`, `netplay_post.js`.
- `core/patches/netplay/0001-machine.patch`, `0002-ioport.patch`, `0003-save.patch`, `0004-build.patch`.
Modified (repo):
- `core/build-wasm.sh`, `core/build-native.sh`, `core/test/build-wasm.test.mjs`,
  `core/test/netplay-patch.test.mjs` (new).
Docs:
- `docs/02-emulation-core.md`, `docs/contracts/core-version.md`, `docs/tasks/README.md`, this file.
Upstream files changed only via patches: `src/emu/machine.cpp`, `src/emu/ioport.cpp`, `src/emu/save.h`,
`src/emu/save.cpp`, `scripts/src/emu.lua`, `scripts/genie.lua`.

## C ABI (`extern "C"`, `EMSCRIPTEN_KEEPALIVE`)
```
void     netplay_enable(void);
void     netplay_set_inputs(uint32_t frame, uint16_t p1, uint16_t p2, uint16_t p3, uint16_t p4);
int      netplay_ready(uint32_t frame);
void     netplay_step(uint32_t frame);
int      netplay_state_size(void);
int      netplay_save_state(uint8_t *buf);
int      netplay_load_state(const uint8_t *buf);
uint32_t netplay_hash(void);
```
Internal C++ helpers used by the patches: `bool netplay_input_active()`,
`bool netplay_try_run_frame(running_machine &, uint32_t frame)`, `uint32_t netplay_next_frame()`.

## Behaviour
- **One frame clock shared by JS and the rAF loop.** `netplay_try_run_frame(frame)` is the only stepper:
  if `!ready(frame)` return false without stepping (the gate); else inject the frame's masks, advance the
  scheduler until `time() >= start + frame_period` (`first_screen()->frame_period()`, 60 Hz fallback),
  set `next = frame+1`. `emscripten_main_loop()` calls it when netplay is active, pumping video instead
  when the frame is not ready; JS `netplay_step(frame)` calls the same function, so no double-step.
- **Input injection:** bind once at first `netplay_set_inputs` by walking `ioport().ports()` -> `fields()`:
  joystick/buttons by `field.player()==n` and `IPT_JOYSTICK_*`/`IPT_BUTTON1..6`, `IPT_START{n+1}`,
  `IPT_COIN{n+1}`. Every bound field is written each frame (stale bits clear). While netplay is active the
  ioport hook ignores the local OSD sequence, so only injected inputs count. `netplay_ready` requires all
  four masks (idle slots send 0); an explicit active-player count is a T24 refinement.
- **Save/load:** `netplay_state_size()` -> JS `_malloc` -> `write_buffer`/`read_buffer` via the new
  `save_manager::buffer_size()`.
- **Hash:** CRC32 of the `save_manager` buffer (`write_buffer` over `buffer_size()`).
- **Input frames are write-once:** a duplicate for an already-recorded or already-stepped frame is
  ignored, and overflow refuses new frames instead of evicting a needed one, so arrival order cannot
  change the effective input.

## Tests (first, red)
`core/test/netplay-patch.test.mjs` (skips cleanly when `mame/makefile` is absent):
apply/revert restores a pristine tree, idempotent apply, stable `hash`, and every `cwrap('<name>'` in
`netplay_post.js` has a matching declaration in `netplay.h`/`netplay.cpp`.

## Commands / acceptance
- `node --test core/test/netplay-patch.test.mjs` — red before `apply.sh`/patches, green after.
- `bash core/patches/apply.sh status|hash`, `apply`, `revert`.
- `node --test core/test/build-wasm.test.mjs` — dry-run shows the apply step and `netplay_patch`.
- `pnpm lint && pnpm typecheck && pnpm test` — pass; nothing under `mame/**`, no `*.wasm`, no `roms/`.
- Human-only (slow, >10 min): `source emsdk_env.sh && core/build-wasm.sh gridlee` -> a new
  `core/out/gridlee/<core_hash>/` with `netplay_patch` in `manifest.json`, tree clean afterwards.

## Commits
1. `docs(T20): implementation plan`
2. `test(core): failing T20 patch/apply tests`
3. `feat(core): netplay C++ module and MAME patch series`
4. `feat(core): apply netplay patches during builds and record the patch hash`
5. `docs(T20): describe netplay patch application and manifest field`

## Risks / open items
- **Golden replay deferred:** the harness is T26 and the lockstep loop is T24 (`netplay-check.md`).
  T20's determinism rests on the T02 native spike and the human WASM smoke test; note this in the PR.
- Cannot compile C++ here (emsdk, >10 min, human-owned); first real compile is the human build.
- `mame/` currently has untracked `scripts/*.a` build outputs: `apply.sh` only inspects tracked files and
  only removes files it created.
- `mame/` is a shallow submodule; patches target the pinned commit's exact context.

## Determinism-auditor follow-ups (recorded, not T20 blockers)
- **Native/verifier path:** this ABI is browser-only by design; the verifier (T33) replays via
  `verify.lua`, not `netplay_*`. The native build compiles `netplay.cpp` as dead code (safe). If T33
  ever wants to share the gate, add a native `current_machine()`.
- **Analog inputs:** only digital controls are mapped; games with paddles/dials/lightguns still read the
  local OSD. Refuse netplay for such drivers until the protocol covers analog (see `input-packet.md`).
- **Scheduled file save/load:** the netplay loop does not service `m_saveload_schedule`; T24 owns the
  loop semantics.
- **DIP/options + core/ROM hash:** forcing emulation-affecting options, and a `netplay_init(core_hash,
  rom_hash, dip_signature)` handshake, belong to the match descriptor (T30/T33).
- **Stable field pointers:** `s_fields` caches `ioport_field*`; rebuild bindings on machine reset once
  T24 resets within a session.

## Post-review follow-ups (determinism-auditor + reviewer, recorded)
The verified build `core/out/gridlee/70b2077a…` was produced before these were noted; fixing any of them
touches the core and requires a rebuild, so they are deferred rather than silently changing the artifact.
- **F1 — input-window bound is count-based, not distance-based.** `netplay_set_inputs` refuses once
  `s_pending.size() >= MAX_PENDING` (arrival-order dependent). Bound by frame distance
  (`frame > s_next_frame + MAX_LOOKAHEAD`) instead, which is identical on every peer.
- **F2 — `netplay_load_state` does not rewind the frame clock.** Add a frame argument, set
  `s_next_frame = frame`, drop stale pending; needed for T25 resync / T40 rollback.
- **F3 — bindings/pending survive a machine reset.** Add `netplay_reset()` (clear state, rebuild
  bindings) and call it from the reset notifier.
- **F4/F5 — set_value vs the verifier's Lua injection and the missing `core/inputmap/`.** The verifier
  must set every mapped bit every frame with the same bit->field mapping; today the mapping is hard-coded
  in `netplay.cpp` and `core/inputmap/<driver>.json` does not exist. Single-source it before T33.
- **F6 — native verifier cannot use the ABI.** `current_machine()` is Emscripten-only; add
  `netplay_attach(running_machine&)` if T33 is to share the gate (the `build-native.sh` comment
  overstates "same patched source").
- **F7 — `netplay_hash()` is a mutating read** (`write_buffer` runs `dispatch_presave`); peers must
  sample hashes at the same frame boundary. Document the cadence in `docs/03` and cover it in T26.
- **F8 — the netplay loop skips the `m_saveload_schedule` branch** present in the stock loop; a scheduled
  file save/load would hang. Mirror the stock branch (same as the T24 item above).
- **Nits:** stale top comment in `netplay.cpp` still describes the rejected regions-sorted hash
  (fix on the next rebuild); `netplay_enable` is exported but not wired in `NetplayHooks`, so activation
  is implicit at the first `set_inputs` (confirm before lockstep); `git diff --check` flags whitespace
  inside the `.patch` context; pin `LC_ALL=C` in `build-native.sh` for consistency.
