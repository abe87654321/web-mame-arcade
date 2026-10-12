# T32b · Scoremap core read — implementation plan

**Goal:** give the browser core a real `Core.readScore(slot)` by reading a
driver's score bytes out of emulated memory through a new native hook, then
decoding them with the T32a scoremap. This is the half that a human builds: it
adds a C++ ABI entry and needs a WASM rebuild + a discovered gridlee address.

Docs: 05, contracts/ws-messages, contracts/scoremap. Depends: T32a (done).

## Decisions

- **A new C ABI `netplay_read_bytes(cpu, space, addr, out, len)`** on the
  existing netplay patch (`core/patches/netplay/`), wrapped by a
  `NetplayHooks.readMemory` JS method. The read is a pure address-space access
  and never mutates the machine; it never reaches `core.step`.
- **`Core.readScore(slot)` decodes via the scoremap** passed on `CoreOptions`:
  `readMemory` returns the raw bytes, `decodeScore` combines them per
  `format`/`endian` (docs/contracts/scoremap.md).
- **The scoremap is fetched from `/static/scoremap/<driver>.json`**; a 404 means
  "no live score for this driver" (not an error), so the sampler keeps skipping
  it (T32a already swallows the `CoreCapabilityError`).
- **The C++ and WASM rebuild are human-run** (slow; AGENTS.md) and every C++ line
  is human-reviewed. The decode/loader/`readScore` JS lands and is unit-tested
  against a faked module; the golden replay is re-run after the rebuild.

## Files

- `core/patches/netplay/netplay.h`, `netplay.cpp`, `netplay_post.js` — the read ABI.
- `core/scoremap/README.md` — the discovery procedure (new).
- `core/publish-web.sh` + `core/test/publish-web.test.mjs` — one-command core+scoremap publish (new).
- `packages/web/src/core/scoremap.ts` + `.test.ts` — loader + `decodeScore` (new).
- `packages/web/src/core/module.ts` — `NetplayHooks.readMemory`.
- `packages/web/src/core/types.ts` — `CoreOptions.score`.
- `packages/web/src/core/mame-core.ts` + `.test.ts` — real `readScore`.
- `packages/web/src/core/browser.ts` + `.test.ts` — fetch the scoremap.
- `packages/web/src/core/index.ts` — export the loader/decoder.
- `packages/web/src/app/app.ts` — pass the scoremap URL in `browserCoreLoader`.
- `docs/02-emulation-core.md` — note the native score read.

## Scope

- In: native `netplay_read_bytes`, `readMemory`, `decodeScore`/loader,
  `Core.readScore`, scoremap fetch wiring, discovery README.
- Out: the actual gridlee address (`core/scoremap/gridlee.json`) and the WASM
  rebuild + `games.json`/public artifact update — human, with the README.
- Out: verification/leaderboard (T33).

## Acceptance criteria

- [ ] `netplay.h` declares and `netplay.cpp` defines `netplay_read_bytes`; the
      glue exposes `readMemory` (the patch test's cwrap-declaration check passes).
- [ ] `decodeScore` matches docs/contracts/scoremap.md (binary + BCD, both
      endians; rejects invalid BCD and a length mismatch).
- [ ] `loadScoreMap` parses a valid file and treats a 404 as "no scoremap".
- [ ] `MameCore.readScore(slot)` returns the decoded score via a faked
      `readMemory`; throws `CoreCapabilityError` without a scoremap or hook.
- [ ] `loadBrowserCore` fetches `/static/scoremap/<driver>.json` and passes it in.
- [ ] Tests added; `pnpm lint && pnpm typecheck && pnpm test` pass.
- [ ] Human: `core/build-wasm.sh gridlee`, then `core/publish-web.sh gridlee`
      (copies the core to `public/`, updates `games.json` `coreVersion`, copies the
      scoremap), add `core/scoremap/gridlee.json`, pass the golden replay.

## Post-review follow-ups

- **Determinism:** `netplay_read_bytes` now reads RAM through
  `address_space::get_read_ptr` per byte instead of `read_byte`, and refuses a
  handler-mapped address. `read_byte` would run the address space's read handler,
  and gridlee's `analog_port_r` (0x9500, AS_PROGRAM) mutates save state that
  feeds `netplay_hash` — a wall-clock-paced read with a side effect would desync
  peers and the verifier. Only RAM is readable now (documented in the contract).
- **Compile fix:** `device_memory_interface::space()` returns a reference and
  asserts; use `has_space()` then bind the reference.
- **Precision:** `decodeScore` accumulates with BigInt and rejects a value above
  `Number.MAX_SAFE_INTEGER` instead of silently rounding a wide entry.
- `loadScoreMap` treats only a **404** as "no scoremap"; other non-ok statuses
  throw (a 5xx is a deploy error, not a missing map).

## Notes for the agent

- Files you may touch: the paths above. No native/WASM build here.
- `core/scoremap/gridlee.json` is produced by the human with
  `core/scoremap/README.md`; do not invent addresses.

## Discovery (resolved)

- **gridlee score found: 3-byte BCD at `0x0433` (program space, big-endian).**
  `core/scoremap/gridlee.json` is committed and published. The value was located
  by adding a dev-only RAM-capture hook to the play page
  (`?scorewatch=1` → `/tmp/gridlee_ram.log`, see `packages/web/src/scorewatch.ts`)
  while playing in a local browser, then matching two reported
  `frame ↔ score` points: `0800` and `002600`. `x0434 x0435` alone is the
  score/100 in BCD; the leading `x0433` is the high digit (0 for scores < 10000).
- The scoreboard is only rendered on the netplay play/watch routes, so it was
  verified in an online room via the relay.
