# T28 netplay feasibility spike

Decision input for the rollback (T40) and server-authoritative (T45) tracks: how
big is a MAME state, and what does saving/loading/hashing it cost per frame?

- **Native** — `core/spike/native-save-hash.sh <driver>` boots a free driver
  headless, then times `machine:buffer_save()` / `buffer_load()` and checks a
  save → advance → load round-trip restores the same RAM hash
  (`core/spike/save-hash.lua`).
- **WASM** — `pnpm --filter @wma/e2e test:spike` boots the netplay-armed core in
  a page (a room route freezes it at frame 0) and times `Core.save()/load()/hash()`
  (`e2e/spike.e2e.ts`, needs a Dev build and the built core + ROM).

Both use the same driver and MAME commit so the state sizes match. Numbers below
are wall-clock on one dev machine; they are indicative, not a guarantee.

## Results — gridlee

MAME commit `b67e5bc`, core hash `d26f80aa…`.

| Host | State bytes | save ms | load ms | hash ms | round-trip |
| --- | ---: | ---: | ---: | ---: | --- |
| native (`--boot 120 --iters 100`) | 1 848 286 | 1.13 | 0.38 | — | PASS |
| WASM (`--iters 50`) | 1 848 286 | 4.85 | 1.79 | 9.32 | PASS |

- Native `hash` is not comparable: MAME's Lua API exposes only `buffer_save/load`,
  not the patched `netplay_hash()`; the Lua reference fold used for the equality
  check (~20 ms over 1.8 MB byte-by-byte) is not the engine's C CRC32.
- WASM `hash` is the engine `netplay_hash()` (CRC32 over the full save buffer).

## Read for the roadmap

- **State size ≈ 1.8 MB** for gridlee — a rollback ring of 8 frames is ~15 MB per
  peer, and grows with each driver.
- **WASM save ≈ 4.9 ms/frame**, load ≈ 1.8 ms, hash ≈ 9.3 ms. A rollback frame
  must fit save + re-sim of the missed frames + occasional hash in the ~16 ms
  budget; at ~5 ms just to snapshot, T40 rollback is tight on this build.
- **Server-authoritative (T45) needs memory, not per-frame snapshots**: the
  native save/load cost is small (sub-millisecond to ~1 ms) and off the client,
  which is consistent with running one authoritative instance per match.
- Every driver must be measured; gridlee is the smallest free case, not the worst.
