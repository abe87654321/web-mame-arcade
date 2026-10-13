# Contract · Input log (closed match)

Source of truth for the artifact the relay closes on `game.end` and the verifier
(`docs/05-leaderboard-verifier.md`, T33) replays. The log is what a finished match
*is*: one start state plus every frame's inputs (docs/04, docs/00).

## Storage

- One artifact per match. Key convention: `match/<room>/<logId>.json.gz`.
- Encoding: **gzip** of the UTF-8 bytes of a single JSON object (`encodeInputLog`).
  A match is ~1 KB/s of play compressed; gzip collapses the long neutral runs.
- `matches.replay_key` (docs/contracts/db-schema.sql) stores this key. The DB write
  is T34; T30 only produces the object and its key.
- Consumers: the verifier (T33) replays the log natively; the browser replay page
  (T35) fetches the same artifact via `GET /api/replays/:key` and replays it in the
  WASM core. Both decode with the shared `decodeInputLog`.

## JSON model

```jsonc
{
  "v": 1,                         // InputLog version (INPUT_LOG_VERSION)
  "room": "<relay room id>",
  "meta": {
    "driver": "gridlee",
    "core_hash": "<64-hex>",      // WASM core hash (contracts/core-version.md)
    "mame_commit": "<40-hex>",    // commit the core was built from
    "rom_hash": "<64-hex>",
    "dips": { "Difficulty": "Medium" },   // string|number values
    "mode": "solo" | "coop"       // derived at close (versus is later)
  },
  "start": {
    "frame": 0,                   // startFrame from game.start
    "input_delay": 2,             // inputDelay from game.start
    "players": [{ "slot": 0, "name": "alice" }],   // seated at start, slot order
    "start_state_key": null       // null = the frame-0 boot state is the start state
  },
  "end": {
    "frame": 120,                 // last stepped frame (game.end.frame)
    "scores": [{ "slot": 0, "score": 42 }]   // per slot (T32); 0 if unreported
  },
  "frames": [[0, 0], [1, 0], [0, 0]]   // dense, see below
}
```

### `frames`

- `frames[i]` is **absolute frame** `start.frame + i`; so
  `frames.length === end.frame - start.frame + 1` and `end.frame >= start.frame`.
- Each entry is an array aligned to `start.players` order: `frames[i][j]` is player
  `start.players[j].slot`'s 16-bit mask (docs/contracts/input-packet.md) for that frame.
- A frame/slot whose mask was never seen is `0` (neutral). The relay stores each
  `(frame, slot)` **first write wins** (matching the T25 hash rule), so an overlapping
  redundant packet cannot change a frame already recorded.
- The first `start.input_delay` frames are neutral by construction (docs/03): the
  lockstep pre-fills them and no peer emits a mask inside the delay window.

## Why these fields

- `core_hash` + `mame_commit` + `rom_hash` + `dips`: the exact machine to rebuild
  (docs/contracts/core-version.md). A verifier whose `mame_commit` differs must reject
  the replay outright.
- `start.frame` + `input_delay` + `players`: which frames carry input and for whom.
- `start_state_key`: `null` means boot-from-frame-0 (the core is frozen at load and every
  peer starts at identical state, docs/03); a non-null key would name an uploaded save
  state. T30 always writes `null`.
- `end.scores`: display scores captured live (T32); the leaderboard value is only ever
  what the verifier reads from RAM (T33), never this number.

## Rules

- The log is **append-only while live**: `game.start` opens it, each binary `input`
  frame appends, `game.end` closes it and writes the artifact. Inputs after close are
  rejected.
- Only the host (lowest occupied player slot) may `game.end`; the relay stamps the
  end frame and refuses a non-host (`not_host`) or a room that is not `playing`
  (`not_playing`).
- A closed log's `frames` are truncated at `end.frame`; any input for a later frame is
  dropped.
