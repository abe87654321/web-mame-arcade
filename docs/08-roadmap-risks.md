# 08 · Roadmap and risks

| Phase | Deliverable | Gate (must pass before next phase) |
| --- | --- | --- |
| 0. Determinism spike | Native MAME record/playback of one free ROM, compared twice | Identical RAM hash after 10 min replay, 10/10 runs |
| 1. Solo in browser | WASM core, ROM loading, keyboard + gamepad, Nginx headers | Full speed in Chrome, Firefox, Safari |
| 2. Two-player lockstep | Netplay patch, signalling, TURN, lockstep, desync hash | 30-min remote match, zero desyncs |
| 3. Spectating + leaderboard | Relay input log, viewers, live score, verifier, boards, replays | Verifier reproduces 200/200 test matches |
| 4. Scale + polish | Rollback for chosen games, LiveKit fallback, more drivers, monitoring | Load test: 1 000 viewers on one relay |

| Risk | Mitigation |
| --- | --- |
| Driver not deterministic | 200 automated replay tests per game before listing online |
| Heavy save states | Lockstep only; late join waits for next save point |
| Browser frame jitter | Small input buffer; pace with `performance.now()` |
| Mixed core versions in a room | Room locked to one core hash |
| ROM rights unclear | Online catalogue limited; option A for the rest |
| Upstream MAME changes main loop | Small isolated patch; pin each game to a tested commit |
