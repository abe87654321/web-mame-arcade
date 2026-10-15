# Contract · Scoremap (live score reads)

Source of truth for `core/scoremap/<driver>.json`, consumed by the browser
(`Core.readScore`, T32b) and — in the same shape — by the native verifier's
`verify.lua` (T33). The schema is `scoreMap` / `scoreMapEntry` in
`packages/protocol/src/scoremap.ts`.

A scoremap says where each seated slot's **live** score lives in emulated memory
and how to turn those bytes into a decimal number. It is **display only**: a
score read never mutates the machine and never enters the emulation path
(AGENTS.md determinism rule). The leaderboard value is only ever what the
verifier reads on replay (docs/05).

## JSON model

```jsonc
{
  "v": 1,                                   // SCOREMAP_VERSION
  "players": [
    {
      "slot": 0,                            // 0-3
      "cpu": ":maincpu",                    // CPU device tag
      "space": "program",                   // "program" (AS_PROGRAM) | "io" (AS_IO)
      "addr": "0x4e80",                     // 0x-prefixed hex byte address
      "len": 3,                             // 1-8 bytes
      "format": "bcd",                      // "bcd" | "binary"
      "endian": "little"                    // optional; default "little"
      "divisor": 10                         // optional; default 1 (see below)
    }
  ]
}
```

- `slot` must be unique within `players`; a slot without an entry has no live
  score (the browser skips it; the log's `end.scores` defaults it to 0).
- `space` maps to MAME's address-space enum: `program` → `AS_PROGRAM`,
  `io` → `AS_IO`.
- `divisor` (optional, ≥1): the decoded value is divided by it (integer
  division). Some games store the score **scaled** — e.g. twinbee/cobra keep the
  score ×10 — so a `divisor` of 10 recovers the on-screen score. Omitting it
  means 1 (no scaling).

## Decoding

`len` bytes are read from `(cpu, space)` starting at `addr`, in increasing
address order.

**Only RAM-backed addresses are readable.** The read fetches a direct host
pointer for each byte and **refuses** a handler-mapped address (where no direct
pointer exists), returning no score. This is deliberate: running an address-space
read handler could mutate machine state and desync peers, because a live score is
read on a wall-clock cadence *outside* the determinism-critical lockstep. In
practice `io` space is almost always handler-mapped and so will be refused; put a
scoremap only on program/work RAM.

- **`binary`** — the bytes form one integer. `endian: "little"` (default) treats
  the lowest address as the least-significant byte; `"big"` the reverse.
- **`bcd`** — each byte holds two decimal digits (high nibble = tens, low nibble
  = ones). The bytes are placed **most-significant-byte first** (i.e. reversed
  when `endian` is `"little"`), each byte emitting its high nibble then its low
  nibble, and the concatenated digit string is parsed as decimal.
  - A nibble greater than 9 is an invalid BCD digit and the read errors.
  - Worked example: `12345` stored little-endian as bytes `45 23 01` decodes as
    `01 23 45` → digits `"012345"` → `12345`.

Always verify the decoded number against the on-screen score during discovery;
flip `endian` if the value is bit-reversed or scrambled.

## Discovery

Per driver, find the address once with MAME's built-in Cheat Search (or the
debugger) and confirm it with a Watch — see `core/scoremap/README.md` for the
step-by-step procedure. `hiscore.dat` (mame/plugins/hiscore) lists addresses for
many games and is a good starting hint; gridlee has no entry.

## Where it is served

The canonical file lives at `core/scoremap/<driver>.json`. The browser fetches a
copy from `/static/scoremap/<driver>.json` (a missing 404 means "no live score"
for that driver, not an error).
