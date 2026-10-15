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

### Option C — in-browser cheat search (no native MAME)

When the native MAME UI is hard to reach (e.g. a remote/thin client), use the
dev-only **in-browser** cheat search (T47). It drives the same WASM core the game
runs on and reads program RAM through the core's `readMemory` hook, so it sees
exactly the memory the score lives in.

```sh
pnpm --filter @wma/web dev
# then open:  http://localhost:5173/?cheatsearch=1#/game/<driver>
```

A panel appears top-right. Workflow:

1. Play until the score is a known value (at the start of a credit it is 0).
2. Click **Reset (score 0)**.
3. Play to a new known score. The game's keyboard capture eats typed keys and
   clipboard paste, so press **Pause game**, read the score off the frozen
   screen, enter it with the on-screen keypad (no keyboard needed), pick
   `len`/`format`/`endian` (start with `3` / `bcd` / `little`), click **Filter**,
   then **Resume game**.
4. If **Filter** leaves 0 candidates, the encoding guess is wrong: click
   **Scan decode**, which tries every `len`×`format`×`endian` — packed BCD/binary
   *and* unpacked (one decimal digit per byte) — for the score and its ×10/×100
   scalings, listing the combinations that match with their addresses.
5. If the scan still finds nothing, the score is outside your window. Pick the
   range from the driver's memory map (e.g. nemesis/twinbee work RAM is
   `0x20000-0x27fff`, so `?cheatsearch=1&base=0x20000&size=0x8000`), not from the
   `hiscore.dat` table address.
6. Repeat until one address remains; check the shown hex bytes decode to the
   on-screen score (flip `endian` if scrambled).
7. **Print JSON entry** logs (and copies) the ready-to-paste `players[]` entry.

The window defaults to `:maincpu`/`program` `0x0..0x10000`. For a driver whose
score sits higher (e.g. twinbee `0x1f580`, twincobr `0x315a2`), pass the range and
CPU: `?cheatsearch=1&base=0x1e000&size=0x4000#/game/twinbee`. `hiscore.dat`
(see above) is a good hint for where each game's RAM is. The tool is inert
without `?cheatsearch=1` and is never included in a production build. While it is
armed the game's fullscreen request is suppressed (the canvas still fills the
window), so the panel stays clickable.

### 16-bit CPUs and scaled scores

Two things trip up score discovery on 68k / V30 boards; check both before giving
up on an address.

**1. Byte-lane reads (T50).** `netplay_read_bytes` must select the byte within the
native element (a 16-bit word), not read the element's first byte. Before T50 it
returned each word's **low byte for both lanes**, so *every* value was wrong and
nothing ever matched — e.g. twincobr's ROM at `0x0` read as `03 03 00 00 02 02 94 94`
instead of the real interleaved `00 03 20 00 00 02 01 94`. This is fixed in
`core/patches/netplay/netplay.cpp` (lane via `lowmask` + `BYTE8_XOR_BE/LE`, matching
MAME's own `direct_mem_read`); **a core built before the fix (or the 8-bit twinbee
core, which is unaffected) will never find a 16-bit score.** If a 16-bit driver's
reads look like each byte is duplicated (`xx xx`), rebuild the core. Note ordinary
data can also be genuinely mirrored (`xx xx` pairs) — that alone is not the bug;
the ROM cross-check above is the reliable test.

**2. Scaled scores (`divisor`).** Some games store the score **×10** (or ×100).
The raw cell then reads one decimal digit longer than the screen, e.g. twincobr at
`0x3184e` (3-byte BCD, big) reads `104900` while the screen shows `10490`. When the
matched value is a clean power-of-ten multiple of the on-screen score, keep the raw
cell and add `"divisor": 10` (docs/contracts/scoremap.md); the browser and
`verify.lua` both divide, so the leaderboard matches the screen:

```json
{ "slot": 0, "cpu": ":maincpu", "space": "program",
  "addr": "0x3184e", "len": 3, "format": "bcd", "endian": "big", "divisor": 10 }
```

**Discovery tips on 16-bit boards.** Use `?scorewatch=1&base=…` to log RAM while you
play, then correlate with the on-screen score:
- a **score** increases **irregularly** (jumps with kills); a **timer** increases at
  a near-constant rate and often saturates — don't pick those;
- the score cell should be **non-decreasing** across the session;
- scaled scores always end in 0, so the raw cell is a multiple of 10/100.

### If no stable cell exists

Some games draw the score from regenerated tiles/video RAM with no numeric cell
in RAM. If Cheat Search finds nothing stable, that driver has no readable live
score: keep the file absent (the browser treats it as "no score") and pick
another driver, rather than committing a wrong address.

## Using the discovered address

1. Write `core/scoremap/<driver>.json`.
2. Build and publish the core + scoremap + `games.json` in one step:
   ```sh
   core/build-wasm.sh gridlee     # prints the new core hash
   core/publish-web.sh gridlee    # copies the core to public/, updates games.json,
                                  # and copies core/scoremap/gridlee.json to /static/scoremap/
   ```
3. In the verifier (T33) `verify.lua` reads the same file's `addr`/`len`/`format`
   to read the final score on replay.
