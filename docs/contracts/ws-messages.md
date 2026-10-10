# Contract · Relay WebSocket messages (JSON, except `input` which is binary)

Every JSON message: `{ "t": "<type>", ...fields }`.

| Type | Direction | Fields | Purpose |
| --- | --- | --- | --- |
| `room.join` | client → relay | room, role (`player`/`viewer`), token | join a room |
| `room.state` | relay → client | room, self, players[], game, coreHash, romHash, dips, status | room snapshot (`self` = recipient's slot or null; game fields null pre-game) |
| `rtc.signal` | both | to, sdp?, candidate? (client); from, to, sdp?, candidate? (relay) | WebRTC signalling relay |
| `game.start` | host → relay → all | startFrame, inputDelay | begins input log; relay fans it out and sets status `playing` |
| `input` | player → relay | binary input packet | recorded + fanned out |
| `state.snapshot` | host → relay → client | frame, blobUrl | late join / desync recovery |
| `hash` | player → relay | frame, crc32 | desync detection |
| `desync` | relay → players | frame | trigger resync |
| `score.live` | player → relay → all | player, score, frame | live scoreboard (display only) |
| `game.end` | host → relay | frame | closes log, queues verification |
| `chat` | both | text | chat |
| `error` | relay → client | code, message | errors |

Types live in `packages/protocol/src/messages.ts` (zod schemas). Both relay and web import them.
Use `parseMessage` / `safeParseMessage` (the `anyMessage` discriminated union), or the narrower
`clientMessage` / `serverMessage` unions for direction checks. Objects are strict: unknown fields are
rejected. `input` is binary and deliberately **not** in the JSON union — tag it with `INPUT_TYPE`
(`"input"`) and codec it with `encodeInput`/`decodeInput`.

## Pinned in T22
- `room.state.players` is `{ slot: 0-3, name: string }[]` in slot order.
- `room.state.game`, `coreHash`, `romHash` are **null until the host picks a game and DIPs**; before
  that `dips` is `{}` and `status` is `"waiting"`. Once a game is set they carry the driver, the WASM
  core hash and ROM hash (both lowercase sha256 hex).
- `room.state` is broadcast to every member on join, leave and game/DIP change.
- `rtc.signal` keeps `sdp`/`candidate` as opaque shapes (`docs/03` pins the SDP/candidate handling for
  T23); `to` must name an occupied slot in the sender's room.

## Pinned in T23
- `room.state.self` is the recipient's own player slot (`0-3`) or `null` for a viewer. Each member
  receives a personal snapshot, so `self` differs per recipient.
- `rtc.signal` is sent client → relay with `to`; the relay **stamps `from`** (the sender's own slot)
  on the forwarded relay → client message and ignores any client-supplied `from`. `from` is therefore
  optional on the wire and always present on a forwarded signal.
- Negotiation (docs/03): the lower slot of a pair offers, the higher answers; the offerer creates the
  data channel with `{ ordered: false, maxRetransmits: 0 }`.

## Pinned in T24
- `game.start` is sent host → relay; the relay verifies the sender is the **lowest occupied
  player slot** (`not_host` otherwise, `already_started` if the room already started), records
  `startFrame`/`inputDelay`, then fans the message out to **every** member and broadcasts the
  updated `room.state` with `status: "playing"`. So `game.start` is valid in both directions.
- Binary `input` frames are accepted by the socket binding and currently dropped (the append-only
  log and spectator fan-out land with T30/T31). They are never JSON-validated.
- `room.state.status` becomes `"playing"` on a successful `game.start`; `snapshot` reflects it.

## Auth
`room.join.token` is an HS256 JWT. Claims: `sub` (required, non-empty user id), `name` (optional
display name), `exp` (required, unix seconds). The relay verifies it with the shared secret and rejects
an invalid/expired token before adding the member. Issuance is the API's job (T34).

## Relay error codes
Relay replies to a client problem with `error { code, message }`. Codes used in T22:
`invalid_token`, `room_full`, `already_joined`, `not_joined`, `unknown_peer`, `bad_message`,
`unsupported`. T24 adds `not_host` (a non-host sent `game.start`) and `already_started`
(`game.start` on an already-playing room). A connection belongs to one room at a time: a
`room.join` for a different room is rejected with `already_joined`, while replaying `room.join`
for the same room is an idempotent no-op (a role change on that replay is applied).
