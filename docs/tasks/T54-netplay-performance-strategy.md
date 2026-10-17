# T54 · Netplay performance strategy (decision spike)

**Status:** proposed / decision pending. No production implementation is in scope until a go/no-go
decision is recorded at the bottom of this document.

**Goal:** understand where a netplay tick spends its budget, then decide whether to invest in

- **Option 3** — move emulation/rendering/audio off the browser main thread
  (Web Worker + OffscreenCanvas + AudioWorklet), or
- **Option 4** — server-authoritative native emulation + video (T45), or
- neither: keep the current client-side lockstep/rollback and spend effort on T53 and cheaper
  optimizations.

This task exists so the decision is made from measurements and product needs, not from the
frustration of one bad match.

---

## Context (measured before this task)

T40 rollback is implemented and enabled only for `raiden`. On the headless/SwiftShader dev
machine (`pnpm --filter @wma/e2e test:rollback-budget`, warmed):

| Driver | WASM `core.step` | rollback tick (`save + step`) | 60 Hz budget |
| --- | ---: | ---: | ---: |
| commando | 10.3 ms | 15.5 ms | 16.7 ms |
| gridlee | 13.3 ms | 15.8 ms | 16.7 ms |
| raiden | 14.6 ms | 15.7 ms | 16.7 ms |

The over-load meter has seen ticks above 20 ms in the real browser/e2e environment, which means
roughly **3–6 ms of the tick is outside `core.step`** (save, hash, send, OSD/JS, browser scheduling).
That number is the entire ceiling for Option 3: moving work off the main thread can recover it, but
cannot make a 14 ms emulated frame cheaper.

Known non-performance blockers: T53 (start/arming race) keeps gridlee/jackal/rygar/commando on
lockstep; T54 must not be used as a reason to ignore T53.

---

## Option 3 — Worker / OffscreenCanvas / AudioWorklet

### What it would change

- Move the WASM MAME instance, the netplay loop, rollback ring, rendering (`OffscreenCanvas`), and
  audio (`AudioWorklet`) into a Worker.
- Keep input sampling and `RTCPeerConnection` on the main thread (WebRTC is not available in Workers);
  `WebSocket` can move.
- Use `SharedArrayBuffer` for input rings if useful (COOP/COEP is already configured).

### Expected benefit

- Removes UI/paint/GC/WebRTC/JS contention from the emulation tick.
- Smoother audio, fewer rAF hitches, fewer false "slow" rollback degradations.

### What it does **not** fix

- The 10–15 ms WASM emulation cost stays.
- Rollback still needs one extra frame of simulation per corrected frame.
- It does not improve network RTT, packet loss, or T53's boot race.
- It does not help weak CPUs enough to unlock many more rollback drivers.

### Cost

- **Engineering:** 4–8 person-weeks for an MVP, high risk.
  - Emscripten + SDL3 + bgfx + OffscreenCanvas integration;
  - audio path rewrite;
  - moving input/scheduling/rollback across a thread boundary without new timing races;
  - re-running the golden replay, save-integrity, two-tab and netem gates.
- **Infrastructure:** ~zero.
- **Ongoing:** more complex debugging, browser-specific behavior, larger tab memory (worker + WASM).
- **Opportunity cost:** those weeks cannot be spent on T53, onboarding, or a T45 pilot.

### When it becomes worth it

Only if the T54 profiling report shows **non-core tick overhead > 5–8 ms** and that overhead is
removed by isolation. If the gap is 2–3 ms, do cheaper optimizations instead:

- `-O3` / LTO / build flags;
- remove per-tick allocations (`save()` copies, packet buffers);
- reduce hash cost or move it off the hot path;
- simplify rendering/overlay work.

**Default recommendation:** do not do Option 3 first.

---

## Option 4 — Server-authoritative native MAME + video (T45)

### What it would change

One native MAME process per match on a server:

```text
clients → input aggregation (fixed D + jitter buffer) → authoritative native MAME
        → frame capture → hardware encode → LiveKit/WebRTC → clients
```

Clients send inputs and watch video. Client CPU, tab visibility, browser/GPU differences, and
rollback correctness stop mattering.

### Expected benefit

- Absolute sync: no desync, no rollback, no slow-client stalling.
- Works on weak clients, phones, hidden tabs.
- Works for drivers without save states (twincobr, gwar, …).
- Spectators and replays can reuse the same authority/log.
- Strong anti-cheat: state never leaves the server.

### What it does **not** fix

- Network latency. Felt latency becomes roughly
  `input uplink + jitter buffer + encode + video downlink + decode`, i.e. `RTT + 40–100 ms`.
- Cost: it adds one server simulation and one video stream per player.

### Latency estimates (order of magnitude)

| Scenario | RTT | Expected feel |
| --- | ---: | ---: |
| Same city/region | 10–30 ms | ~50–130 ms |
| Cross-region | 80–120 ms | ~120–220 ms |
| Cross-continent | 200 ms+ | ~240 ms+ |

For comparison, P2P rollback with `inputDelay = 2` is ~33 ms plus corrections. **Rollback wins on
latency for good, nearby clients; server-authoritative wins on consistency and weak clients.**

### Cost

- **Engineering:** 6–10 person-weeks for an MVP:
  - headless native MAME rendering/capture (EGL/OSMesa or Xvfb);
  - H.264/VP9 hardware encode (NVENC/QSV/VA-API);
  - input aggregation and room→process orchestration;
  - LiveKit publish (T41 already exists for client-side A/V);
  - crash recovery, monitoring, regional deployment.
- **Infrastructure (rough, 100 concurrent video endpoints, 720p60 @ 2.5 Mbps):**
  - ~250 Mbps sustained egress; ~2.7 TB/day at full load;
  - ~13 GPUs at 8 concurrent encodes/GPU (model-dependent);
  - cloud GPU at ~$1/hour: ~$9–10k/month at 24/7 full load; ~$2k/month at 20% average use;
  - bandwidth/egress can dominate on cloud; self-hosting is cheaper but still needs capacity.
- **Operations:** per-match process supervision, regional latency, GPU availability, capacity planning.

Numbers are indicative; the T54 report must record the assumptions.

### When it becomes worth it

- Ranked/competitive play or leaderboard integrity is the product priority.
- Cross-region play, weak devices, or drivers without save states matter.
- The cost per concurrent match is acceptable for the target mode.

**Default recommendation:** run T45 as a small pilot (one game, one region, hardware encode) before
making it the default for all games.

---

## Decision matrix

| Dimension | Option 3 Worker | Option 4 T45 |
| --- | --- | --- |
| Fixes main-thread jank | yes | yes |
| Fixes WASM frame cost | no | yes (native is much faster) |
| Absolute sync | no | yes |
| Input latency | D + network (rollback can be 2 frames) | RTT + 40–100 ms |
| Weak clients | still limited by WASM | yes |
| Engineering | 4–8 person-weeks, high risk | 6–10 person-weeks + ops |
| Infra cost | ~0 | per-match GPU/bandwidth |
| Client requirement | modern OffscreenCanvas/Worker | video decode only |
| Best for | casual 2-player, decent PCs | ranked, cross-region, weak devices |

These are not mutually exclusive: T45 replaces the client simulation for the matches it covers;
Option 3 only improves the P2P path.

---

## Plan for this task (timeboxed, no production changes)

### Phase A — profiling (2–3 days)

Extend the existing probe/e2e instrumentation (no protocol or game changes) to report per-tick:

- `core.step` time;
- `save()` time and bytes;
- hash time (every 60 frames, amortised);
- packet build/send time;
- OSD/present time;
- remaining JS/browser time;
- GC/allocation counts (Chrome DevTools or a dev-only counter).

Deliverable: a `## T54 profiling` section in `core/spike/README.md` with per-driver numbers and the
fraction of the tick spent outside `core.step`.

### Phase B — cheap optimizations assessment (2–4 days)

Measure, on one driver, whether these move the budget enough:

- `-O3` / LTO build;
- avoiding synchronous `save()` copies (if the API allows a reusable buffer);
- reducing per-tick allocations;
- simplifying overlays/rendering.

Deliverable: expected gain in ms/tick and whether it unlocks more `rollbackWindow` drivers.

### Phase C — decision memo (1 day)

Record in this file and in `docs/08-roadmap-risks.md`:

- measured overhead split;
- projected benefit/cost of Option 3;
- T45 pilot cost/latency estimate for the target region(s);
- **go/no-go** for each option and the trigger to revisit.

### Acceptance for T54

- Profiling report committed (numbers reproducible with a documented command).
- Explicit go/no-go decision with rationale and cost assumptions.
- No production code, protocol, catalogue, or core changes in this task.
- If a follow-up is chosen, a separate task/plan is created (Worker spike or T45 pilot).

---

## Decision triggers (use these instead of re-litigating)

- **Option 3 only if:** non-core tick overhead > 5–8 ms, profiling confirms it is main-thread
  contention, and cheap optimizations have already been tried.
- **T45 pilot if:** ranked/competitive/cross-region/weak-device support is required, or a driver
  cannot be made netplay-safe client-side.
- **Neither if:** the target is same-region casual play, raiden-class rollback is acceptable, and
  T53 can be fixed cheaply. In that case keep lockstep/rollback and revisit after T53.

---

## Non-goals

- Implementing Worker/OffscreenCanvas in this task.
- Implementing T45 in this task (T45 is the existing implementation task; T54 only decides whether
  and how to fund it).
- Changing netplay protocol, relay, verifier, catalogue or core builds.
- Promising "zero latency": physics and video encoding impose a floor.
