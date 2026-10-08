---
description: Stub for netplay determinism checks (golden replay / two-tab). Not ready until T24–T26.
agent: plan
---

Netplay determinism checks are not available yet — they require the netplay patch (T20), lockstep loop
(T24), desync detection (T25) and the two-tab harness (T26). Until then, the closest check is the native
record/playback determinism spike (T02): record a session, replay twice, compare the RAM hash.

When the prerequisites exist, this command will:
1. Run the golden-replay suite: replay stored input logs against the WASM core and the native verifier,
   asserting equal final RAM hash and score.
2. Run two browser tabs under `tc netem` profiles (50/100/150 ms, 1% loss) and assert equal per-60-frame hashes.
Report PASS/FAIL and attach the failing frame and hash.
