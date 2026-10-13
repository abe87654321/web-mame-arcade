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

## Save-integrity check (WASM)

`e2e/save-integrity.e2e.ts` answers a question the cost spike above does not:
**is the save state complete enough to netplay?** MAME only promises that for
drivers flagged `MACHINE_SUPPORTS_SAVE` (`gamedrv.h:76`), and netplay's desync
recovery, viewer late-join snapshots and replay all depend on a save that reloads
into a machine which continues identically (docs/00, docs/03).

The T28 round-trip (`save-hash.lua`, `spike.e2e.ts`) only hashes *right after* a
load, so a save that silently dropped device state still passes it. This spec
replays the future twice on the **real netplay seam** (`Core.save`/`Core.load` →
`netplay_save_state`/`netplay_set_frame`) and compares the engine CRC32 at the
same frame: step to `boot`, `save()`; step `span` frames (forward hash);
`load(snapshot, boot-1)`; step the *same* frames with the *same* inputs (reload
hash). `PASS` iff the two match.

```sh
pnpm --filter @wma/e2e test:e2e        # needs built cores + ROMs; not in CI
```

The spec is a **diagnostic**: it asserts only harness self-consistency (the core
does not move without an explicit step; two reloads agree) and *reports* the
`forward == reload` verdict per driver in a `SAVE-INTEGRITY <driver> ...` line.
Flip that report into an assertion once the recovery path is trusted, to make it a
regression gate.

| Driver | MACHINE_SUPPORTS_SAVE | core.save() | forward == reload | verdict |
| --- | --- | --- | --- | --- |
| gridlee | yes | yes | **no** | FAIL |
| twinbee | yes | yes | **no** | FAIL |
| raiden | yes | **throws** ("does not support save states") | — | NO_SAVE |
| raiden2 | yes | **throws** ("does not support save states") | — | NO_SAVE |
| twincobr | no | yes | no | FAIL |

### Finding (2026-10, MAME `b67e5bc`) — tracked as T46

Every driver that exposes a save buffer reloads it **consistently** (`reload ==
reload2`, and no background stepping) but the reloaded machine does **not**
reproduce the uninterrupted future one frame later (`forward != reload` at
`--span 1`), **even with all-zero inputs** (`WMA_SI_MASK=0`): not an input/edge
artifact. Worse, the load does not even re-hash to the saved value
(`afterLoad != atSave`). It is not a harness artifact — it uses the real
`Core.save`/`Core.load` (`netplay_save_state`/`netplay_set_frame`) and the exact
frame convention `match.ts:669` uses for `state.snapshot` recovery (save at
`lockstep.frame() - 1`, load that frame, resume `+1`). Further anomalies:

- **raiden / raiden2**: their WASM cores have no save buffer (`Core.save()`
  throws) even though the drivers are flagged `MACHINE_SUPPORTS_SAVE` in MAME.
- **twinbee**: `core.save()` returns ~18.9 MB (a full GX400 state) but still fails
  the continuation.

This puts the premise of T25 desync recovery, T31 viewer late-join snapshots and
T35 replay in doubt. Root cause is under investigation in **T46**
(`docs/tasks/T46-save-load-continuation.md`); likely candidates are the
`scheduler` presave/postload timer re-ordering, the scheduler clock after load,
and the unsaved ioport live state.
