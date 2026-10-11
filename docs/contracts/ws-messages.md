# Contract · Relay WebSocket messages (JSON, except `input` which is binary)

Every JSON message: `{ "t": "<type>", ...fields }`.

| Type | Direction | Fields | Purpose |
| --- | --- | --- | --- |
| `room.join` | client → relay | room, role (`player`/`viewer`), token | join a room |
| `room.state` | relay → client | room, self, players[], game, coreHash, romHash, dips, status | room snapshot (`self` = recipient's slot or null; game fields null pre-game) |
| `rtc.signal` | both | to, sdp?, candidate? (client); from, to, sdp?, candidate? (relay) | WebRTC signalling relay |
| `player.ready` | both | ready, player? (relay-stamped slot) | a player toggles its own lobby ready flag |
| `game.set` | host → relay → all | driver, coreHash, mameCommit, romHash, dips | host picks the game + DIPs (fills `room.state`) |
| `game.start` | host → relay → all | startFrame, inputDelay | begins input log; relay fans it out and sets status `playing` |
| `input` | player → relay → all members | binary input packet | recorded; fanned to viewers + peers as redundancy (T31) |
| `state.snapshot` | host → relay → client | frame, blobUrl | desync recovery |
| `viewer.snapshot` | host → relay → viewers | frame, blobUrl | live-join snapshot (T31) |
| `viewer.state` | relay → viewer | room, driver, coreHash, mameCommit, romHash, dips, startFrame, inputDelay, players[], snapshot (nullable) | viewer join handshake (T31) |
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
- `room.state.players` is `{ slot: 0-3, name: string, ready: boolean }[]` in slot order.
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

## Pinned in T27
- `room.state.players[].ready` is the player's lobby ready flag, default `false` on join.
- `player.ready` is a single strict schema used in both directions: a client sends
  `{ t: "player.ready", ready: boolean }`; the relay stamps the sender's own `player` slot and
  fans it out to the room as `{ t: "player.ready", ready, player }`, then re-broadcasts
  `room.state` so every lobby shows the updated flags.
- A `player.ready` from a non-seated connection (a viewer, or one that has not joined) is rejected
  with `not_joined`; `player` is relay-authoritative and any client-supplied value is ignored.
- The host's `game.start` is gated on readiness in the UI only (all peers connected and all
  non-host players ready); the relay does not enforce readiness, so a lone host may still start.

## Pinned in T25
- `hash` is sent relay-ward only, by a **seated player**, every 60 simulated frames
  (`frame % 60 == 0 && frame > 0`, the frame just stepped). The relay stamps the sender's
  own slot (the wire message carries no slot) and compares hashes **per frame, across
  players**: two distinct `crc32` values for the same `frame` is a desync.
- On a genuine same-frame mismatch the relay broadcasts `desync { frame }` to the room.
  A repeated `hash` from the same slot for the same frame is ignored (first write wins), so
  a driven peer cannot flap the comparison. A lone player never triggers a `desync`.
- `state.snapshot` is sent by the **host** (lowest occupied player slot) and only while the
  room `status` is `"playing"`; the relay fans it out to every member **except the sender**.
  The origin carries `frame` (the frame the snapshot represents, i.e. the last stepped frame)
  and `blobUrl` (absolute URL of the relay's in-memory snapshot blob).
- A receiving peer fetches `blobUrl`, calls `core.load(bytes)` with the reset frame, and
  resumes the lockstep at `frame + 1`.
- New error codes: `not_host` (a non-host sent `state.snapshot`), `not_playing`
  (`state.snapshot` before `game.start`; reused for `hash` before the game starts).
- Every desync and resync is logged with room, frame and (once available) game/`coreHash`.

## Pinned in T30
- `game.set` is sent host → relay by the **lowest occupied player slot** (same host rule
  as `game.start`; `not_host` otherwise) and only while the room is `waiting`
  (`already_started` once `playing`). It carries `driver`, `coreHash`, `mameCommit`,
  `romHash` (all lowercase hex: 64 for the hashes, 40 for the commit) and `dips`
  (string|number values). The relay records them on the room and fans the message out to
  every member, then re-broadcasts `room.state` — so `room.state.game/coreHash/romHash/dips`
  are **non-null/`{}`** after a `game.set`. `mameCommit` is kept for the input log
  (docs/contracts/input-log.md) and is not part of `room.state`.
- Binary `input` frames are accepted from seated players only, in a `playing` room, and
  appended to the match's input log (docs/contracts/input-log.md). A frame outside the
  log's open window (before `startFrame`, after `game.end`, or a repeated `(frame, slot)`)
  is ignored. The relay does not fan inputs out to peers here (viewers are T31); peers
  already exchange them P2P.
- `game.end` is sent host → relay by the lowest occupied player slot (`not_host`
  otherwise) and only in a `playing` room (`not_playing` otherwise). The relay closes the
  input log at `frame`, writes the artifact (object storage), queues a verification job
  and flips `room.state.status` to **`ended`**. `game.end` is client→relay only; the room
  learns the match ended from the refreshed `room.state`.
- `game.set`, `game.start`, `input` and `game.end` therefore require a seated player; a
  viewer or unjoined connection is rejected with `not_joined`.

## Pinned in T31
- Binary `input` frames are now fanned out by the relay to **every member of the room
  except the sender** (players + viewers). Peers already exchange inputs P2P, so the
  relayed copy is redundancy for players and the live stream for viewers. A sender's own
  inputs are never echoed back; each peer's `applyPacket` ignores packets for its own
  slot in any case, and a repeated `(frame, slot)` is first-write-wins.
- `viewer.snapshot` is sent host → relay (lowest occupied player slot, `not_host`
  otherwise; `not_playing` before `game.start`) and carries `frame` (the host's last
  stepped frame at save time) and `blobUrl`. Unlike `state.snapshot` it is **not** a
  resync: the relay records it as the room's live-join point and forwards it to
  **viewers only**. Players never receive it.
- A viewer that joins a `playing` room receives `viewer.state`: the match identity
  (`driver`, `coreHash`, `mameCommit`, `romHash`, `dips`), the start (`startFrame`,
  `inputDelay`), the seated roster `players[]` (`{ slot, name }` in slot order) and the
  latest `snapshot` (`{ frame, blobUrl }`, or `null` if the host has not produced one).
  It is relay → client only. `mameCommit` is included here because `room.state` omits it
  (docs/contracts/core-version.md) and the viewer needs it to pin the core.
- Immediately after `viewer.state`, the relay replays the recorded inputs from
  `snapshot.frame + 1` (or `startFrame` when there is no snapshot) up to the highest
  recorded frame as binary `input` packets, so a late viewer can fast-forward to live.
  `game.start` re-sends `viewer.state` to viewers so a pre-join viewer learns the roster.

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
