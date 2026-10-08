# 05 · Shared leaderboard and score verifier

A score enters the leaderboard only after the server replays the input log in native MAME and reads the same
score from RAM. Clients never submit a trusted score.

## Live scoreboard (display only)
- Browser reads score bytes once per second (addresses from `hiscore.dat` or per-game `core/scoremap/<driver>.json`:
  `{ "cpu": ":maincpu", "space": "program", "addr": "0x4e80", "len": 3, "format": "bcd" }`), sends `score.live` to relay.
- Relay broadcasts to players and viewers.

## Verified leaderboard
1. On game end the relay closes the input log (core hash, ROM hash, DIP settings, start state, per-frame inputs)
   and pushes a job to Redis list `verify:jobs`.
2. Worker runs: `mame <driver> -video none -sound none -nothrottle -autoboot_script core/verify.lua`
   with the log path in an env var.
3. `verify.lua` feeds inputs with `field:set_value()` each frame; at the last frame reads score via `mem:read_u8()`.
4. Measure per game how fast it replays unthrottled; size the worker pool from that.
5. Match → insert into `scores` (PostgreSQL) and `ZADD lb:<driver>:<period> <score> <user>` (Redis). Mismatch → flag match.

## Boards
All-time, weekly, daily, per country, friends; per game and mode (solo, co-op, versus). Each entry links to its replay.
