# Scoremap discovery

Per-driver files here record **where a live score lives in emulated memory**
and how to decode it, so the browser and the verifier can read it without
guessing. The file format is pinned in `docs/contracts/scoremap.md` and the
schema lives in `packages/protocol/src/scoremap.ts`.

A file is `core/scoremap/<driver>.json`:

```json
{
  "v": 1,
  "players": [
    { "slot": 0, "cpu": ":maincpu", "space": "program",
      "addr": "0x4e80", "len": 3, "format": "bcd", "endian": "little" }
  ]
}
```

The browser copies are served from `/static/scoremap/<driver>.json`; a missing
file simply means the driver has no live score. `hiscore.dat`
(`mame/plugins/hiscore/hiscore.dat`) already lists addresses for many games and
is a good first hint — **gridlee has no entry**, so it must be found below.

## Finding the address

You are looking for a small region of RAM whose **contents track the on-screen
score**. Prefer the built-in Cheat Search (no rebuild); fall back to the MAME
debugger if needed.

### Option A — Cheat Search (recommended, release build)

1. Build a native binary for the driver (this applies the netplay patch only for
   the build and reverts it afterwards):

   ```sh
   core/build-native.sh gridlee          # leaves ./mame/gridlee
   ```

2. Run with the cheat engine and the free ROMs:

   ```sh
   ./mame/gridlee -rompath roms -cheat   # ROMs live in roms/ (gitignored)
   ```

3. In game, open **Tab → Cheat → Cheat Search**:
   - **Start** the search; snapshot the current value while the score is its
     initial value (usually 0) with **`==` (Equal)**.
   - Play to a known score (e.g. 100) and search **`==` 100**, or use
     **`>` / `<` / `Changed`** to narrow while the score moves.
   - Repeat until one address (or a few) remain.
4. **Watch** the candidates (Add Watch) and verify: the value must rise with the
   score, survive a screen wipe, and not reset spuriously. Pick the stable one.
5. Note the address-space details and the byte layout:
   - `cpu`: the CPU device tag (`:maincpu` for gridlee).
   - `space`: `program` (gridlee's program RAM is `0x0080-0x07ff`).
   - `len`: how many bytes the score occupies (BCD scores are usually
     `ceil(digits / 2)` bytes; a 6-digit score is 3).
   - `format`: `bcd` for packed-decimal, `binary` for a plain integer.
6. **Verify the decode.** Put the bytes into the entry, compute the number your
   decoder would produce (docs/contracts/scoremap.md), and confirm it **equals
   the on-screen score**. If it is bit-reversed or nibble-swapped, flip
   `endian`; if it is wrong in a way swapping cannot fix, re-check the address.
7. Repeat steps 3-6 in 2-player mode for `slot: 1` (it usually has its own
   address) and add it to the same file.

### Option B — the MAME debugger (needs a debug build)

MAME's interactive debugger is compiled out of release builds; switching it on
in an existing tree requires regenerating the makefile, so build fresh:

```sh
make -C mame SUBTARGET=gridlee \
  SOURCES="src/mame/bally/gridlee.cpp,src/mame/bally/gridlee_a.cpp,src/mame/bally/gridlee_v.cpp" \
  IGNORE_GIT=1 DEBUG=1 SYMBOLS=1 -j"$(nproc)"
./mame/gridlee -debug -rompath roms
```

In the debugger: `wp` a write watchpoint over the likely RAM window
(`0x80-0x7ff` for gridlee), watch for the byte that changes on scoring, then
`memory` inspect it and confirm the value matches the display. (`help` lists
commands.) Note the debugger addresses are the same CPU-space addresses the
scoremap uses.

### If no stable cell exists

Some games draw the score from regenerated tiles/video RAM with no numeric cell
in RAM. If Cheat Search finds nothing stable, that driver has no readable live
score: keep the file absent (the browser treats it as "no score") and pick
another driver, rather than committing a wrong address.

## Using the discovered address

1. Write `core/scoremap/<driver>.json`.
2. Copy it to `packages/web/public/static/scoremap/<driver>.json` (like the core
   bundles, this publish step is manual).
3. In the verifier (T33) `verify.lua` reads the same file's `addr`/`len`/`format`
   to read the final score on replay.
