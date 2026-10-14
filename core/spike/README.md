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

### Root cause and fix (2026-10, MAME `b67e5bc`, T46)

The bug is in MAME's scheduler, and reproduces **natively** (no netplay involved):
`core/spike/native-save-continuation.sh <driver>` boots a native binary headless
and checks save → advance → load → advance on MAME's own
`buffer_save`/`buffer_load`.

- RAM is restored **exactly** by `buffer_load` (`SI_RAM_AFTER_LOAD_EQ_SAVE=true`),
  yet the very next frame diverges (`forward != reload` at `--span 1`) and it
  accumulates. So the fault is non-RAM state that drives the first timeslice.
- The save/load byte diff (mapped to save entries with the `WMA_SI_ENTRY` log,
  patch `0005-save-debug.patch`) lands exactly on `timer/…/m_index` — timer
  canonicalisation, not the cause of the behavioural split (normalising the
  disabled-but-active `screen_device::vblank_begin` out of the list at presave
  does not fix it).
- The decisive evidence is the scheduler clock (`WMA_SI_PRESAVE_CLOCK` /
  `WMA_SI_POSTLOAD_CLOCK`, patch `0006-schedule-debug.patch`): at save
  `time() == m_basetime` (2.2752 s), but **after `buffer_load` `time()` returns
  4.5504 s** while `m_basetime` restored to 2.2752 s. `device_scheduler::time()`
  returns the cached `m_callback_timer_expire_time` while a timer callback is
  running; that cache is **not in the save buffer**. Saving/loading from inside a
  callback (a Lua/plugin frame notifier, or netplay's frame gate) therefore leaves
  `time()` a full frame ahead of the restored machine, and every device that
  schedules relative to `time()` runs off the restored timeline.

**Fix** (`0007-schedule-clock.patch`, `device_scheduler::postload`): re-base the
callback-time cache on the restored base time —

```cpp
if (m_callback_timer != nullptr)
    m_callback_timer_expire_time = m_basetime;
```

With the fix, the native continuation passes (`SI_DET=PASS`) for gridlee at
`--span 1/60/120/240` and `--boot 120/300`, and the T02 determinism spike and T28
native round-trip still pass.

### Still open: the WASM/browser seam diverges for a different reason (T46)

The same fix was rebuilt into the WASM core and published, but
`e2e/save-integrity.e2e.ts` **still** reports `forward != reload` for gridlee (and
twinbee). The native and browser paths are not the same seam:

- In the browser the e2e drives `Core.save`/`load`/`step` from JS, so the load is
  **not** inside a timer callback and the clock bug above does not apply. Instrumenting
  `netplay_hash` confirmed `time()` is restored exactly across the load
  (`afterLoad == atSave`), while RAM is also exact (`SI_RAM_AFTER_LOAD_EQ_SAVE`), yet
  the first stepped frame diverges.
- Tested and ruled out for the WASM path: the timer `m_index` / disabled-timer
  linkage (the byte diff is only there), the quantum list (clearing it on load does
  not fix it), and input switch edges (all-zero inputs still diverge).

So the browser divergence is in the `netplay_try_run_frame` stepping seam (the one
difference from MAME's own run loop, which the native probe uses), not in
`save_manager`. It needs the same "instrument the seam" treatment applied to
`core/patches/netplay/netplay.cpp`. **T46 is not complete** until the WASM gate is
green.

**raiden / raiden2** (`Core.save()` throws with an empty save buffer) is a
separate, still-open anomaly; they are catalogued `supportsSave:false` /
`netplayMode:"none"` until then.
