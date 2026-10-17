# 08 · Roadmap and risks

| Phase | Deliverable | Gate (must pass before next phase) |
| --- | --- | --- |
| 0. Determinism spike | Native MAME record/playback of one free ROM, compared twice | Identical RAM hash after 10 min replay, 10/10 runs |
| 1. Solo in browser | WASM core, ROM loading, keyboard + gamepad, Nginx headers | Full speed in Chrome, Firefox, Safari |
| 2. Two-player lockstep | Netplay patch, signalling, TURN, lockstep, desync hash | 30-min remote match, zero desyncs |
| 3. Spectating + leaderboard | Relay input log, viewers, live score, verifier, boards, replays | Verifier reproduces 200/200 test matches |
| 4. Scale + polish | Rollback for chosen games, LiveKit fallback, more drivers, monitoring | Load test: 1 000 viewers on one relay |
| 5. Strong-sync (SLO C) | Server-authoritative native emulation + video (T45) | Absolute sync at fixed latency; cost is one sim + video per match |

| Risk | Mitigation |
| --- | --- |
| Driver not deterministic | 200 automated replay tests per game before listing online |
| Heavy save states | Lockstep only; late join waits for next save point |
| Browser frame jitter | Small input buffer; pace with `performance.now()` |
| Mixed core versions in a room | Room locked to one core hash |
| ROM rights unclear | Online catalogue limited; option A for the rest |
| Upstream MAME changes main loop | Small isolated patch; pin each game to a tested commit |
| WASM frame cost / main-thread contention | T54 decision spike: profile the tick, then choose main-thread isolation (Worker/OffscreenCanvas/AudioWorklet), a T45 server-authoritative pilot, or neither. Do not trade T53 correctness for unmeasured optimization. |

## T54 · Netplay performance strategy (open decision)

The measured WASM frame cost (10–15 ms on the headless dev machine) and the remaining 3–6 ms of
non-core tick overhead mean two different investments are possible:

- **Worker isolation** (Option 3): removes main-thread contention, but does not reduce the emulated
  frame cost. 4–8 person-weeks, no server cost.
- **Server-authoritative native emulation + video** (T45/Option 4): absolute sync and weak-client
  support, but felt latency becomes `RTT + 40–100 ms` and the server pays for one simulation + video
  bandwidth per match. 6–10 person-weeks plus operations.

T54 is a timeboxed profiling + decision task; it does not implement either option. Its output is a
go/no-go memo with measured numbers and cost assumptions, recorded in
`docs/tasks/T54-netplay-performance-strategy.md` and this roadmap. Trigger a follow-up only when a
decision criterion is met (ranked/cross-region/weak clients, or non-core tick overhead > 5–8 ms).
