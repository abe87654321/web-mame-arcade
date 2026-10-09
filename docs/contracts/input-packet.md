# Contract · Input packet (binary, little-endian)

Sent every frame over the WebRTC data channel to each peer, and over WS to the relay.

| Offset | Field | Type | Notes |
| --- | --- | --- | --- |
| 0 | version | u8 | protocol version, currently 1 |
| 1 | player | u8 | slot 0-3 |
| 2 | ack_frame | u32 | latest frame received from the receiver |
| 6 | first_frame | u32 | frame of inputs[0] |
| 10 | count | u8 | 1-8 frames carried (newest last) |
| 11 | inputs | u16 × count | button bitmask per frame |

Button bitmask (bit → field): 0 up, 1 down, 2 left, 3 right, 4 B1, 5 B2, 6 B3, 7 B4, 8 B5, 9 B6,
10 start, 11 coin, 12-15 reserved. Mapping to MAME ioport fields per driver lives in
`core/inputmap/<driver>.json`.

Bits 12-15 are reserved and unused. The v1 input layer (T12) carries digital controls only:
gamepad analog sticks are quantised to the four direction bits (deadzone + hysteresis), not sent
as analog values. True analog inputs (wheels, paddles, spinners) require a protocol extension and
are out of scope until then.

Implementation: `packages/protocol/src/input.ts` — button bits plus `encodeInput`/`decodeInput`
(little-endian, `INPUT_HEADER_SIZE = 11`, `MAX_FRAMES = 8`). `decodeInput` rejects a wrong
`version`, a `player` outside 0-3, a `count` outside 1-8, and any length that disagrees with `count`.
`packages/web/src/input/` turns devices into a mask. `InputPacket` is the decoded shape.

## Local input config vs host default
Which physical key/button/axis feeds each bit is **per-browser local configuration**, never sent
over the wire — only the resulting mask is. Each peer therefore keeps its own mapping and never
inherits another player's. A room/host announces an `InputConfig` as a *default*; a peer stores
only its own overrides (`LocalInputConfig`, `wma.input.local` in localStorage) and resolves them
over that default. Consequently two peers may emit different masks for the same physical gesture,
but they replay each other's *masks*, so this is not a desync source.
