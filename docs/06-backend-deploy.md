# 06 · Backend services and Ubuntu deployment

| Service | Job | Tech | Port / path |
| --- | --- | --- | --- |
| Web + static | Pages, WASM cores, signed ROM URLs | Nginx (HTTP/2, COOP/COEP, Brotli) | 443 `/`, `/static/cores/` |
| API | Accounts, catalogue, rooms, leaderboards | Node 24 + Fastify, JWT | 443 `/api/` |
| Room relay | Signalling, input log, fan-out, chat, live scores | Node 24 + uWebSockets.js, Redis pub/sub | 443 `/ws` |
| TURN | NAT traversal | coturn | 3478 UDP/TCP, 5349 TLS |
| Verifier | Replay input logs | native MAME + verify.lua, Redis queue | internal |
| Video SFU (optional) | Video fallback | LiveKit + Egress | 7880, UDP 50000-60000 |

Data: PostgreSQL (users, games, matches, scores), Redis (rooms, boards, queue), object storage
(local disk or MinIO) for ROMs, cores, replay logs (~1 KB per second of play, compressed).

Schema: `contracts/db-schema.sql`.

Room flow: create room via API → relay assigns ID → peers join via relay signalling → host sets game + DIPs →
relay records input log from frame 0.

Relay implementation (T22): `packages/relay` runs on the pinned Node with native type stripping
(`pnpm --filter @wma/relay start`; env `WMA_RELAY_SECRET`, `PORT` default 8787, `HOST`). It listens at
`/ws` and verifies `room.join` tokens as HS256 JWTs. T22 uses the pure-JS `ws` server for
testability; the `uWebSockets.js` swap and Redis pub/sub between relay processes are the T44
scale-out work. nginx/TLS fronting is T42.

Input log (T30): on `game.start` the relay opens an append-only log and appends every binary
`input` frame; on the host's `game.end` it closes the log and writes the gzip(JSON) artifact
(`docs/contracts/input-log.md`) to **local disk** (`WMA_LOG_DIR`, default `data/input-logs`) and
enqueues a verification job. The `LogStore`/`JobQueue` interfaces keep a MinIO/S3 backend and the
Redis `verify:jobs` list as drop-ins (T33/T42); the relay's in-memory job sink is the T30 default.

Starting server: 8 vCPU, 16 GB RAM, 1 Gbit/s, Ubuntu 24.04, Docker Compose (`deploy/docker-compose.yml`).
Move the SFU to its own machine first if video fallback is enabled.

## API (T34)
`packages/api` runs on the pinned Node with native type stripping
(`pnpm --filter @wma/api start`). Env: `WMA_API_SECRET` (or `WMA_RELAY_SECRET`, the shared
HS256 secret), `WMA_PG_URL` (or `DATABASE_URL`), optional `PORT` (default 8080), `HOST`,
`WMA_TOKEN_TTL_SEC` and `WMA_LOG_BASE_URL` (replay links). It serves `/healthz`,
`/api/auth/{register,login}`, `/api/games`, `/api/matches/:id`, `/api/matches/:id/replay`
and `/api/leaderboards/:driver`. Schema from `docs/contracts/db-schema.sql` via
`pnpm --filter @wma/api migrate`; the catalogue is loaded with `pnpm --filter @wma/api seed`.
`users` stores a scrypt `password_hash`; the issued JWT `sub` is the `users.id`, so the
verifier writes `match_players.user_id` directly from the roster in the job.

Match rows: the relay's `ClosedLog` carries the roster (slot + user id), `rom_hash`, DIPs,
mode and the match window; the relay forwards them on the `verify:jobs` job and the verifier
upserts `games`/`matches`/`match_players` (status `ended`) before replaying, flipping the
match to `verified` (or `flagged` on failure). `matches.replay_key` is UNIQUE, so a
redelivered job updates rather than duplicates.
