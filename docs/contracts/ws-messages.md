# Contract · Relay WebSocket messages (JSON, except `input` which is binary)

Every JSON message: `{ "t": "<type>", ...fields }`.

| Type | Direction | Fields | Purpose |
| --- | --- | --- | --- |
| `room.join` | client → relay | room, role (`player`/`viewer`), token | join a room |
| `room.state` | relay → client | room, players[], game, coreHash, romHash, dips, status | room snapshot (game fields null pre-game) |
| `rtc.signal` | both | to, sdp?, candidate? | WebRTC signalling relay |
| `game.start` | host → relay | startFrame, inputDelay | begins input log |
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

## Auth
`room.join.token` is an HS256 JWT. Claims: `sub` (required, non-empty user id), `name` (optional
display name), `exp` (required, unix seconds). The relay verifies it with the shared secret and rejects
an invalid/expired token before adding the member. Issuance is the API's job (T34).

## Relay error codes
Relay replies to a client problem with `error { code, message }`. Codes used in T22:
`invalid_token`, `room_full`, `already_joined`, `not_joined`, `unknown_peer`, `bad_message`,
`unsupported`. A connection belongs to one room at a time: a `room.join` for a different room is
rejected with `already_joined`, while replaying `room.join` for the same room is an idempotent no-op
(a role change on that replay is applied).
