---
description: Two-tab netplay determinism check (equal per-60-frame hashes) and netem profiles. T26.
agent: plan
---

Run the netplay determinism harness and report PASS/FAIL. It opens two browser tabs in one relay
room, feeds each a distinct frame-indexed input stream via the gated `window.__WMA_TEST_INPUT__`
hook, starts the match, and asserts every per-60-frame `hash` both tabs report is identical (and
that neither tab received a `desync`).

Prerequisites: the built WASM core and the ROM for the chosen driver
(`packages/web/public/static/cores/<driver>/<coreVersion>/` and `packages/web/public/roms/<driver>.zip`).
Build the core with `core/build-wasm.sh gridlee` if missing; install the browser once with
`pnpm --filter @wma/e2e exec playwright install chromium`.

1. Two-tab equal-hash check:
   - `pnpm --filter @wma/e2e test:e2e`
2. Under simulated bad networks (Linux `tc netem`; needs sudo):
   - `pnpm --filter @wma/e2e test:e2e:netem` (profiles 50/100/150 ms, 1% loss)

Report PASS/FAIL and, on failure, attach the failing frame and both hashes. For the broader
golden-replay suite (WASM core vs native verifier), see the determinism spike (T02).
