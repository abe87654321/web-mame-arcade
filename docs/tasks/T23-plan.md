# T23 · WebRTC peer connection — implementation plan

**Goal:** connect 2-4 browser peers with unordered, unreliable WebRTC data channels
(`{ ordered: false, maxRetransmits: 0 }`), signalling over the T22 relay (`rtc.signal`), plus a
coturn service in `deploy/docker-compose.yml`.

Docs: 03. Depends: T22 (done).

## Decisions

- **Full N-peer mesh.** One `RTCPeerConnection` per pair of player slots. Deterministic negotiation:
  the **lower slot initiates** (creates the channel and offers), the higher slot answers; one offerer
  per pair, so no glare.
- **Two contract changes, contract-first (golden rule #2).**
  - `room.state` gains `self` (the recipient's slot, or null for viewers): without it a client cannot
    know which side of a pair it is. The relay already builds a personal snapshot per connection, so
    no new broadcast is needed.
  - `rtc.signal` gains an optional `from`. A receiver only sees `to` (its own slot), so in a 3-4 player
    room it cannot tell which peer a signal came from. The relay **stamps `from`** with the sender's
    slot and overwrites any client-supplied value.
- **Injected WebRTC surface, not globals.** Node has no `RTCPeerConnection`; the app already injects
  every browser global (`AppEnv`). `types.ts` defines structural `PeerConnectionLike`/`WebSocketLike`,
  `browser.ts` binds the real constructors, and tests use fakes. No jsdom.
- **Transport only; no emulation path touched.** No clock/randomness in the core, so a golden replay
  does not apply (that is T26). Evidence is the unit/fuzz suite.
- **coturn `use-auth-secret`.** Shared secret, realm and external IP come from `deploy/.env`
  (gitignored); production credentials are short-lived and minted by the API (T34). Host networking
  exposes the UDP relay range.
- **No UI wiring** (T24 lockstep owns it); the module is exercised by unit tests only.

## Files

- `docs/contracts/ws-messages.md`, `docs/03-netplay-protocol.md` — pin negotiation, `self`, `from`,
  data-channel options, TURN.
- `packages/protocol/src/messages.ts`, `messages.test.ts` — `room.state.self`; `rtc.signal.from`
  (optional, relay-stamped).
- `packages/relay/src/room.ts`, `relay.ts` (+ `room.test.ts`, `relay.test.ts`, `server.test.ts`) —
  `signal()` returns `{ target, from }`; snapshot carries `self`; forwarded signal carries `from`.
- `packages/web/src/netplay/`
  - `types.ts` — injected WebRTC/WebSocket surface + `NetplayConfig`/`IceServer`.
  - `peer.ts` — one concern: unreliable unordered channel, offer/answer, trickle ICE with buffering.
  - `mesh.ts` — full mesh via `room.state`, lower-slot-offers, signals routed by `from`.
  - `relay-client.ts` — WebSocket join + `serverMessage` parse + send.
  - `session.ts` — composes relay client + mesh; consumes `room.state`/`rtc.signal`.
  - `browser.ts` — real-constructor adapters.
  - `config.ts` — ICE servers from `VITE_*`.
  - `index.ts` — re-exports.
  - tests: `peer.test.ts`, `mesh.test.ts`, `relay-client.test.ts`, `session.test.ts`,
    `browser.test.ts`, `config.test.ts`, `index.test.ts`, plus `test-fakes.ts`.
- `deploy/docker-compose.yml`, `deploy/turnserver.conf`, `deploy/.env.example`; `.gitignore`
  `!**/.env.example`.
- `docs/tasks/README.md` — tick the task.

## Scope

- In: peer wrapper, N-peer mesh, relay WebSocket client, session, browser/ICE adapters, coturn,
  protocol/relay changes for `self` and `from`.
- Out: lockstep loop / desync (T24/T25), input log and `input` frames (T30), UI, Playwright harness
  (T26), real TURN credential issuance (T34), production compose (T42).

## Acceptance criteria

- [x] `room.state.self` is the recipient's slot (null for viewers); relay sends a personal snapshot.
- [x] The relay stamps `from` on forwarded `rtc.signal` and overwrites a client-supplied `from`.
- [x] Initiator creates a data channel with `{ ordered: false, maxRetransmits: 0 }`; lower slot offers.
- [x] Remote ICE candidates arriving before the remote description are buffered and flushed.
- [x] A `room.state` reconciles the mesh (add/remove peers); signals route to the sender's peer.
- [x] coturn runs from compose with `use-auth-secret`; `docker compose config` is valid.
- [x] Tests added and `pnpm lint && pnpm typecheck && pnpm test` pass.
