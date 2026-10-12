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
- [ ] Human: `core/build-wasm.sh gridlee`, publish the new core, add
      `core/scoremap/gridlee.json`, pass the golden replay.

## Notes for the agent

- Files you may touch: the paths above. No native/WASM build here.
- `core/scoremap/gridlee.json` is produced by the human with
  `core/scoremap/README.md`; do not invent addresses.
