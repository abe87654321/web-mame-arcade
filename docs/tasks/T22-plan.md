# T22 · Relay: rooms + signalling — implementation plan

**Goal:** implement the room lifecycle and WebRTC signalling relay — `room.join` (HS256 token
check), `room.state` snapshot/broadcast and `rtc.signal` routing — as a transport-agnostic core
plus a `ws` server and `node` entrypoint in `packages/relay/`.

Docs: 03, 06, contracts/ws-messages. Depends: T21.

## Decisions

- **Transport-agnostic core + `ws` binding.** `RoomManager` (rooms) and `createRelay` (dispatch)
  hold all logic and are unit-tested; `server.ts` only moves frames and owns liveness. `ws` (pure
  JS) is used instead of the `uWebSockets.js` named in docs/06 — the high-performance swap and
  Redis pub/sub are T44 scale-out work.
- **HS256 JWT via `node:crypto`.** `createHs256Verifier(secret, { now, clockToleranceSec })`
  checks `alg`, HMAC signature, `sub` and `exp`, throwing `TokenError` (`code: invalid_token`).
  No external crypto dependency; the API (T34) issues tokens and can later swap to RS256/JWKS.
- **`room.state` fields nullable pre-game.** `game`/`coreHash`/`romHash` are null until the host
  picks a game; `dips` is `{}` and `status` `"waiting"`. Tightened in `packages/protocol` and
  `docs/contracts/ws-messages.md` first (golden rule #2).
- **Node native type stripping, no `tsx`.** `pnpm --filter @wma/relay start` runs
  `node src/main.ts`. Runtime-loaded modules use explicit `.ts` import specifiers (mandatory under
  strip-only mode); `allowImportingTsExtensions` is in the shared tsconfig base and
  `erasableSyntaxOnly` guards the packages Node executes. Verified `node` loads the workspace
  `@wma/protocol` source through the pnpm symlink before feature work.

## Files

- `packages/protocol/src/messages.ts`, `index.ts` (+ `.ts` specifiers), `messages.test.ts` — nullable
  `room.state`.
- `docs/contracts/ws-messages.md` — pinned shapes, token claims, relay error codes.
- `packages/relay/src/token.ts` — `TokenVerifier`, `createHs256Verifier`, `TokenError`.
- `packages/relay/src/room.ts` — `RoomManager`, `RelayError`, `RoomMember`.
- `packages/relay/src/relay.ts` — `createRelay({ verifier })` → `handle` / `leave`, `Outbound`.
- `packages/relay/src/server.ts` — `createRelayServer`, `ws` binding at `/ws`, heartbeats, close.
- `packages/relay/src/main.ts` — entrypoint (`WMA_RELAY_SECRET`, `PORT`, `HOST`).
- `packages/relay/src/index.ts` — re-exports.
- `packages/relay/package.json`, `tsconfig.json` — deps, scripts, `erasableSyntaxOnly`.
- `docs/06-backend-deploy.md`, `docs/tasks/README.md` — record the transport choice; tick the task.

## Scope

- In: rooms, slot assignment, join/leave, `room.state`, `rtc.signal`, token verification, JSON
  dispatch, error replies, `ws` server, integration tests.
- Out: uWebSockets.js and Redis pub/sub (T44); binary `input` and `game.start`/`chat`/`hash`/
  `score.live`/`game.end` (T24/T30/T32/T36, replies `unsupported`); WebRTC client + coturn (T23);
  nginx/TLS (T42).

## Acceptance criteria

- [x] `room.join` verifies the HS256 token and seats players 0-3 (viewers slot-less, `room_full`
      past 4); reconnect reuses the slot.
- [x] `room.state` is broadcast on join/leave with nullable game fields pre-game.
- [x] `rtc.signal` is routed only to the target slot in the sender's room (`unknown_peer`/`not_joined`).
- [x] `ws` server runs at `/ws` with heartbeats and graceful close; `pnpm --filter @wma/relay start`
      boots.
- [x] Tests added: `token.test.ts`, `room.test.ts`, `relay.test.ts`, `server.test.ts`.
- [x] `pnpm lint && pnpm typecheck && pnpm test` pass.
