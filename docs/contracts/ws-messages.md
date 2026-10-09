# Contract · Relay WebSocket messages (JSON, except `input` which is binary)

Every JSON message: `{ "t": "<type>", ...fields }`.

| Type | Direction | Fields | Purpose |
| --- | --- | --- | --- |
| `room.join` | client → relay | room, role (`player`/`viewer`), token | join a room |
| `room.state` | relay → client | room, players[], game, coreHash, romHash, dips, status | room snapshot |
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
(`"input"`) and codec it with `encodeInput`/`decodeInput`. Fields the table does not pin
(`room.state.players`, `dips`, `status`, RTC `sdp`/`candidate`) use provisional shapes and may tighten
in T22.
