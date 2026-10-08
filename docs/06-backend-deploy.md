# 06 · Backend services and Ubuntu deployment

| Service | Job | Tech | Port / path |
| --- | --- | --- | --- |
| Web + static | Pages, WASM cores, signed ROM URLs | Nginx (HTTP/2, COOP/COEP, Brotli) | 443 `/`, `/static/cores/` |
| API | Accounts, catalogue, rooms, leaderboards | Node 22 + Fastify, JWT | 443 `/api/` |
| Room relay | Signalling, input log, fan-out, chat, live scores | Node 22 + uWebSockets.js, Redis pub/sub | 443 `/ws/` |
| TURN | NAT traversal | coturn | 3478 UDP/TCP, 5349 TLS |
| Verifier | Replay input logs | native MAME + verify.lua, Redis queue | internal |
| Video SFU (optional) | Video fallback | LiveKit + Egress | 7880, UDP 50000-60000 |

Data: PostgreSQL (users, games, matches, scores), Redis (rooms, boards, queue), object storage
(local disk or MinIO) for ROMs, cores, replay logs (~1 KB per second of play, compressed).

Schema: `contracts/db-schema.sql`.

Room flow: create room via API → relay assigns ID → peers join via relay signalling → host sets game + DIPs →
relay records input log from frame 0.

Starting server: 8 vCPU, 16 GB RAM, 1 Gbit/s, Ubuntu 24.04, Docker Compose (`deploy/docker-compose.yml`).
Move the SFU to its own machine first if video fallback is enabled.
