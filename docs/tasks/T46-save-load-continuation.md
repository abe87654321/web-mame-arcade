# T46 · Netplay save/load continuation is not reproducible (bug)

**Goal:** restore (or prove) the invariant every state-based netplay path assumes:
`Core.load(save())` followed by the same inputs reproduces the uninterrupted
future exactly. A peer that loads a snapshot must evolve bit-identically to the
one that never stopped.

Docs: 00, 03, 04. Depends: T20 (patch), T25 (uses it), T31/T35 (rely on it).

## Why this matters
Three shipped paths call `core.load(...)` and continue:
- T25 desync recovery / T29 mutual-stall fallback (`state.snapshot`);
- T31 viewer live-join (`viewer.snapshot`);
- T35 replay restart/boot snapshot.

If a reloaded machine diverges, a "recovered" peer silently leaves the match, a
late-joining viewer shows a different game, and replays are wrong. Today the
recovery is validated only with **fake cores** in unit tests and with an
immediate-round-trip e2e (`e2e/spike.e2e.ts` hashes right after load), so the
"continue" half was never tested on the real core.

## Reproducer
`e2e/save-integrity.e2e.ts` (on this branch) drives the real netplay seam
(`Core.save`/`Core.load`/`Core.hash` -> `netplay_save_state`/`netplay_set_frame`/
`netplay_hash`) using the exact frame convention `match.ts:669` uses for
`state.snapshot` (save at `lockstep.frame() - 1`, load that frame, resume `+1`):

```sh
pnpm --filter @wma/e2e test:e2e      # needs built cores + ROMs; not in CI
# -> SAVE-INTEGRITY <driver> verdict=... {...}
```

## Evidence (2026-10, MAME `b67e5bc`, published cores)
`WMA_SI_BOOT=120 WMA_SI_SPAN=1`, default input mask:
```
gridlee  supported=true bytes=1848286  atSave=2605694713 afterLoad=259362602  forward=4162446302 idle=4162446302 reload=2349441362 reload2=2349441362
twinbee  supported=true bytes=18916818 atSave=1386194894 afterLoad=465616279  forward=3221810452 idle=3221810452 reload=2304243533 reload2=2304243533
raiden   supported=false error="MAME core does not support save states"
raiden2  supported=false error="MAME core does not support save states"
twincobr supported=true bytes=292721   atSave=1129125927 afterLoad=2501361182 forward=2731029414 idle=2731029414 reload=1672694109 reload2=1672694109
```
gridlee with all-zero inputs (`WMA_SI_MASK=0 WMA_SI_SPAN=1`):
```
gridlee  supported=true bytes=1848286  atSave=3887998754 afterLoad=1938036465 forward=3011346165 idle=3011346165 reload=658984742 reload2=658984742
```

- **A reloaded snapshot does not reproduce the future**: `forward != reload` for
  every driver with a save buffer, even at `--span 1`, and with **all-zero
  inputs** (`WMA_SI_MASK=0`) — so it is not an input/edge artifact.
- The comparison is well-posed: `idle == forward` (nothing steps the core behind
  the loop) and `reload == reload2` (the load path is itself deterministic).
- **The load does not even re-hash to the saved value**: `afterLoad != atSave`
  for gridlee. (T28's round-trip only ever measured the boot frame, where it
  happens to hold.)
- **raiden/raiden2 throw** `"MAME core does not support save states"` from
  `Core.save()` even though both drivers are flagged `MACHINE_SUPPORTS_SAVE` in
  MAME (`seibu/raiden.cpp`, `seibu/raiden2.cpp`) — a second anomaly.

## Hypotheses to test (in the core, needs a rebuild + instrumentation)
1. `netplay_hash()` and `netplay_save_state()` both call `save.write_buffer()`,
   which runs `dispatch_presave()`; `netplay_load_state()` runs
   `dispatch_postload()`. `device_scheduler::postload()` re-inserts/re-sorts
   timers, so re-serialising after a load can produce a different byte order
   (`m_index`) than the saved buffer — is the `afterLoad != atSave` purely this
   hash instability, or does timer/scheduler *behaviour* change?
2. `netplay_try_run_frame` advances by `scheduler.time() + screen->frame_period()`.
   Does `read_buffer`/`postload` restore the scheduler clock and execute list to a
   state equivalent to the uninterrupted run? (Instrument `scheduler.time()` and
   `netplay_next_frame` around save/load.)
3. `netplay_set_frame` resets only `s_next_frame`/`s_pending`; the ioport live
   state (`ioport_field::m_live->last`, analog, impulse, toggle) is **not saved**
   (`ioport.cpp` registers no save state). Does the first post-load
   switch-edge differ? (Ruled unlikely as the sole cause — all-zero inputs still
   diverge — but relevant for coin/toggle fields.)
4. `raiden`/`raiden2`: why is `save().buffer_size()` 0 despite the MAME flag?
   (Multiple address spaces / devices state registration.)

## Scope
- In: root-cause the divergence; fix `core/patches/` if warranted; keep the
  reproducer as the gate.
- In (folded in from the multi-driver scaffold): prove the fix **per driver**.
  `e2e/golden-replay.e2e.ts` and `e2e/netplay.e2e.ts` currently hardcode `gridlee`;
  generalise them to the catalogue drivers and record their per-driver goldens, so
  a rebuilt core is validated for `twinbee`/`raiden`/`raiden2`/`twincobr` too, not
  just gridlee.
- Out: rollback (T40) and server-authoritative (T45) designs.

## Acceptance criteria
- [x] Root cause identified with core evidence (instrumented build or a minimal
      C++ test), not only black-box hashes. Three causes, all with core evidence
      (`0007` scheduler callback clock, `0009` Lua postload timer, and the unsaved
      ioport field/port live state in the netplay snapshot).
- [x] `e2e/save-integrity.e2e.ts` reports `verdict=PASS` for every driver the
      catalogue marks `supportsSave: true` (gridlee, twinbee), across every
      boot/span and input tried; raiden/raiden2 are catalogued `supportsSave:false`
      (their WASM `Core.save()` exposes an empty buffer).
- [x] The report is flipped into an assertion; the rebuilt cores pass the golden
      replay (`e2e/golden-replay.e2e.ts`, gridlee) and the netplay e2e
      (`e2e/netplay.e2e.ts`).
- [x] `pnpm lint && pnpm typecheck && pnpm test` pass.

Follow-up (separate from T46): twinbee's T29 golden is not recorded — the golden
harness is intermittently nondeterministic for twinbee (its `atSave` state is
stable, so it is a harness/boot race, not a save/load defect).

## Notes for the agent
- Files you may touch: `core/patches/**`, `core/spike/**`, `e2e/**`,
  `docs/**`, and the catalogue if `supportsSave` is wrong.
- Files you must not touch: `mame/**` (except via `core/patches/`).
- The WASM/native rebuilds are slow: ask the human to run
  `core/build-wasm.sh <driver>` (+ `core/publish-web.sh <driver>`) after a patch
  change.
- Reproducer branch: `feat/multi-driver-scaffold` (`e2e/save-integrity.e2e.ts`).
