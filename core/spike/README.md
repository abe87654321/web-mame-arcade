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

(The `forward == reload` column is the original pre-fix baseline; the root causes and fixes
are in the sections below.)

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

### Second fix: the Lua resume timer broke load hashing (0009)

The native and browser paths are not the same seam. In the browser the e2e drives
`Core.save`/`load`/`step` from JS, so the load is **not** inside a timer callback and the
clock bug above does not apply (instrumenting `netplay_hash` confirmed `time()` is restored
exactly, `afterLoad == atSave`).

That path had a second, real bug: `lua_engine::on_machine_postload()` unconditionally
called `m_timer->reset()`, changing the Lua resume timer's saved bytes
(`m_enabled`/`m_start`) on every load. `netplay_hash()` hashes the whole save buffer, so a
peer that recovered via `state.snapshot` did not hash to the state it was saved from and
would report a **false desync** on every recovery. `0009-lua-engine-postload.patch` only
re-arms the timer when there are waiting tasks. After it, `loadByteEqual=true` /
`loadDiffCount=0` (round-trip byte-exact) and continuation passes for zero input,
joystick/buttons and START; native is byte-exact for the whole buffer
(`SI_SNAP_FORWARD_DIFF_COUNT=0` at every boot/span tried).

### Third fix: the unsaved ioport live state (field + port)

The browser seam still diverged for gridlee once COIN was in the input (~11-21 bytes: CPU
PC + watchdog timer); per-bit bisection showed zero/joystick-buttons/START passed, COIN
(wire bit 11) failed. The cause is that MAME's save buffer does not include the ioport live
state that seeds switch edges / impulses:

- each bound `ioport_field`'s externally-set value and live state
  (`last`/`impulse`/`toggle`/`value`/`joydir`/`lockout`), and
- each port's cached `m_live->digital`, which `ioport_port::read()` returns and which is
  only recomputed once per frame (`ioport_port::frame_update`).

`netplay_save_state`/`load_state` now append and restore both (see
`core/patches/netplay/netplay.cpp`; `netplay_debug_state` dumps the field live state for
diagnosis). After the fix `e2e/save-integrity.e2e.ts` reports `forward == reload`
(`fwdReloadDiffCount=0`) for gridlee and twinbee across zero / joystick-buttons / START /
COIN inputs and every boot/span tried; native stays byte-exact.

(Twinbee's T29 golden is not recorded: the golden harness itself is intermittently
nondeterministic for twinbee even though its `atSave` state is stable across runs — a
separate harness/boot-race issue, tracked outside T46.)

**raiden / raiden2** (`Core.save()` throws with an empty save buffer) is a
separate, still-open anomaly; they are catalogued `supportsSave:false` /
`netplayMode:"none"` until then.

## T40 rollback budget probe

`e2e/rollback-budget.e2e.ts` boots each catalogue driver's frozen netplay core and measures
`save()`, `step()` and `load()` on the WASM build, plus a silent step (rollback re-simulation
does not redraw frames the player already saw). Replay is incremental (one already-shown frame per
animation tick), so the gate is the steady tick cost `saveMs + min(stepMs, silentStepMs) ≤ 16 ms`;
the correctable window is then `rollbackWindow`. A driver without a fitting tick stays `lockstep`.

```sh
pnpm --filter @wma/e2e test:rollback-budget   # needs built cores + ROMs
```

Each run prints one line per driver:

```text
ROLLBACK-BUDGET {"driver":"gridlee","bytes":...,"saveMs":...,"loadMs":...,
                 "stepMs":...,"silentStepMs":...,"tickMs":...,"correction8Ms":...,
                 "suggestedWindow":...,"verdict":"PASS|FAIL"}
```

`tickMs` is the steady cost of one normal (or one corrected) frame; `correction8Ms` is the wall
time an 8-frame catch-up needs (spread over up to 8 ticks). The probe is machine-specific (JIT,
CPU, browser); record the table for the machine that produced the enabled catalogue entries.

### Result (2026-10, headless Chromium + SwiftShader, incremental replay)

Warmed with 60 frames before measuring. `tickMs = saveMs + min(step, silentStep)` is the steady
per-tick cost; the gate is `tickMs ≤ 16 ms`. Even the emulated frame alone costs 10-22 ms in this
environment, so only the drivers just under the line pass and the rest stay `lockstep`.

| Driver | State bytes | save ms | step ms | silent step ms | tick ms | verdict | mode |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| gridlee | 1 848 362 | 2.52 | 13.30 | 15.97 | 15.81 | PASS* | lockstep |
| twinbee | 18 917 002 | 26.48 | 15.27 | 15.09 | 41.57 | FAIL | lockstep |
| raiden | 330 511 | 1.08 | 14.65 | 15.87 | 15.73 | PASS | rollback |
| raiden2 | 1 284 471 | 2.16 | 21.24 | 43.78 | 23.41 | FAIL | lockstep |
| twincobr | 292 905 | 1.08 | 15.98 | 44.51 | 17.06 | FAIL | none |
| commando | 4 081 958 | 5.22 | 10.32 | 15.72 | 15.54 | PASS | rollback |
| jackal | 494 255 | 1.03 | 14.62 | 15.78 | 15.65 | PASS* | lockstep |
| rygar | 1 862 400 | 2.74 | 12.95 | 15.94 | 15.68 | PASS* | lockstep |
| tankfrce | 14 514 719 | 16.75 | 15.42 | 14.90 | 31.65 | FAIL | lockstep |
| gwar | 489 407 | 4.37 | 17.86 | 15.70 | 20.07 | FAIL | none |
| geminij | 1 798 400 | 2.38 | 13.44 | 15.93 | 15.81 | PASS* | lockstep |
| tigerh | 4 549 752 | 5.98 | 16.66 | 16.42 | 22.40 | FAIL | lockstep |

The PASS margins are tight on this headless/SwiftShader machine; the local over-load meter degrades
a match to wait-only if a tick costs more than 20 ms for a second. Re-run the probe on the target
hardware before widening the enabled set.

\* Fits the CPU budget but failed the two-tab gate (geminij without netem; gridlee/jackal/rygar
under `tc netem "100ms 1%"`), so they stay `lockstep` until T53's start/arming race is fixed.
The enabled set after the netem gate is **raiden and commando**.
