# T02 Determinism spike — implementation plan

**Goal:** Prove on one free driver (`gridlee`) that native MAME
`-record`/`-playback` is deterministic: a fixed 10-minute input session,
replayed, yields the same RAM hash every time. Phase 0 gate (docs/08).

**Decisions (confirmed):**
- Strict mode: 10 independent recordings, each played back twice.
- Session length: 36 000 emulated frames (~10 min at gridlee's ~59 Hz).

## Files
- `core/determinism/spike.lua` — returns `run(mode, frames, out)`; drives a
  deterministic input schedule when `mode == "record"`, hashes all memory
  shares + regions at `frames`, writes the hash, and exits the machine.
- `core/determinism-spike.sh` — orchestrates rounds/runs with fresh
  cfg/nvram dirs, shared input dir, and compares all hashes.
- `core/test/determinism-spike.test.mjs` — CLI/`--dry-run` tests (always) plus
  a short integration test skipped when the binary/ROM are absent.

## Commands
- Fast checks: `node --test core/test/determinism-spike.test.mjs`
- Full gate:
  `core/determinism-spike.sh --frames 36000 --rounds 10 --replays 2`
  expected `RESULT: PASS (30/30 runs match)`.
- Repo-wide: `pnpm lint && pnpm typecheck && pnpm test`

## Key source findings that shaped it
- Record captures Lua-injected inputs: `record_port` stores
  `port.live().digital` (mame/src/emu/ioport.cpp:3236) and `set_value` feeds it
  (ioport.cpp:773, :1258).
- The per-frame Lua hook fires under `-video none`
  (mame/src/emu/video.cpp:229 → luaengine.cpp:787).
- `io` is available to scripts (mame/plugins/hiscore/init.lua:40); Lua 5.4
  integer bitwise ops give a 64-bit FNV-1a.
- gridlee RAM is entirely in shares and it supports save states
  (mame/src/mame/bally/gridlee.cpp:290,291,302,469).

## Acceptance
- [x] Tests added and pass.
- [x] `pnpm lint && pnpm typecheck && pnpm test` pass.
- [x] 10/10 (30/30) runs match — see `T02-results.md`.
