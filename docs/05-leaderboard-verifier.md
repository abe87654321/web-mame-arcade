# 05 · Shared leaderboard and score verifier

A score enters the leaderboard only after the server replays the input log in native MAME and reads the same
score from RAM. Clients never submit a trusted score.

## Live scoreboard (display only)
- Browser reads score bytes once per second (addresses from `hiscore.dat` or per-game
  `core/scoremap/<driver>.json`, one entry per slot:
  `{ "v": 1, "players": [ { "slot": 0, "cpu": ":maincpu", "space": "program", "addr": "0x4e80", "len": 3, "format": "bcd" } ] }`;
  see docs/contracts/scoremap.md), sends `score.live` to relay.
- Relay stamps the sender's slot and broadcasts to players and viewers.

## Verified leaderboard
1. On game end the relay closes the input log (core hash, MAME commit, ROM hash, DIP settings, start state, per-frame inputs)
   and pushes a job to Redis list `verify:jobs`. The job carries the match identity and the seated roster (slot + user id),
   so the verifier can write the `matches` / `match_players` rows (T34); `replay_key` is UNIQUE, so a redelivered job
   updates rather than duplicates.
2. Worker runs: `mame <driver> -video none -sound none -nothrottle -autoboot_script core/verify.lua`
   with the log path in an env var.
3. `verify.lua` feeds inputs with `field:set_value()` each frame; at the last frame reads score via `mem:read_u8()`.
4. Measure per game how fast it replays unthrottled; size the worker pool from that.
5. Match → insert into `scores` (PostgreSQL) and mark the match `verified`. Mismatch → flag the match (`status = 'flagged'`).
   (The `ZADD lb:<driver>:<period>` write-through is deferred; T34 reads boards from PostgreSQL — see below.)

## Anti-cheat input analysis (T36)
After `ensureMatch` upserts the match row, the verifier worker reads the closed input log and runs a pure,
deterministic analysis (`packages/verifier/src/anti-cheat.ts`) per player slot:
- **`periodic_input`** — the mask column repeats on a fixed period (`p ≤ 60`, `p ≤ N/4`, ≥ 95 % lag-`p`
  equality, at least two distinct masks): a recorded or scripted loop.
- **`uniform_hold`** — every press/release lasts exactly the same number of frames across ≥ 8 runs: a
  mechanical autofire cadence.
A column can trip both (e.g. a regular `0/1` toggle): the two reasons are recorded as distinct
`match_flags` rows on purpose.
Matches shorter than 360 analysed frames (after the neutral input-delay prefix) are never flagged.
Findings are **advisory**: they are written as `match_flags` rows (`db-schema.sql`) and logged as an
`anti-cheat` event; they do not change `matches.status` or the verified score. The analysis never touches
the emulation path and cannot break verification (a bad/missing log is logged as `anti-cheat-error`).

## API + boards (T34)
`packages/api` (Fastify) issues the relay join JWTs and serves the catalogue and boards:
- `POST /api/auth/register` / `POST /api/auth/login` — scrypt-hashed passwords; the JWT `sub` is the `users.id`.
- `GET /api/games` — the catalogue (seeded from `packages/web/public/games.json`).
- `GET /api/matches/:id` and `GET /api/matches/:id/replay` — match detail and the replay link.
- `GET /api/leaderboards/:driver?period=all|week|day` — verified scores from PostgreSQL `scores`, best score per user,
  each entry linked to its replay. Boards are **derived from the `scores` table** (single source of truth); Redis sorted
  sets as a read cache can land later.

## Boards
All-time, weekly, daily, per country, friends; per game and mode (solo, co-op, versus). Each entry links to its replay.
T34 implements all-time/weekly (7 days)/daily (24 h) over PostgreSQL; country/friends/mode boards are later work.
