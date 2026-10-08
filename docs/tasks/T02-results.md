# T02 · Determinism spike — results

**Status:** PASS — 30/30 runs produced the identical RAM hash.

## Setup
- Driver: `gridlee` (free ROM, `MACHINE_SUPPORTS_SAVE`, all game RAM in memory shares).
- Binary: `mame/gridlee`
- Binary sha256: `b845aa2df3811391ca5295983a6ea832134258db20eaf71be2d192d2ae3cd34b`
- MAME commit: `b67e5bcb0b895c0e451e342068b6651af1307d0d`
- ROM: `roms/gridlee.zip` (gitignored), sha256 `df977ceba0ae1c8d0ecf489ae8423390ff5c7c76ce95f5ee6ba9bc892b18056e`.
- Build/toolchain: `x86_64`, gcc 13.3.0 (see `core/determinism-spike.sh` output / T01).

## Method
`core/determinism-spike.sh --frames 36000 --rounds 10 --replays 2`
(exactly 600 s of emulated time at gridlee's ~59 Hz refresh).

Each round records a 36 000-frame session with MAME `-record` while a Lua
autoboot script injects a fixed input schedule, then replays that `.inp`
twice with `-playback`. Every run hashes all memory shares (`:spriteram`,
`:videoram`, `:nvram`) and memory regions with FNV-1a 64-bit at the end and
writes it out; the orchestrator requires all 30 hashes to be equal.

Each run uses fresh `-cfg_directory`/`-nvram_directory` and `-noreadconfig`
so NVRAM/config state cannot leak between runs.

## Result
```
reference hash: 752c2d7d35a4a453
RESULT: PASS (30/30 runs match)
```

All 10 independent recordings and all 20 playbacks share the hash
`752c2d7d35a4a453`.

## Notes / gotchas found
- Autoboot-script globals do **not** propagate across `dofile()`; `spike.lua`
  returns a `run(mode, frames, out)` function instead.
- `emu.add_machine_frame_notifier()` silently stops firing once its returned
  subscription handle is garbage-collected; the handle is rooted in `_G`.
- `-record`/`-playback` filenames are always resolved under `-input_directory`
  (a leading `/` is stripped), so all runs share one input directory and refer
  to the `.inp` by basename.
