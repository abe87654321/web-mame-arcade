# Contract · Core build identity

Every peer and viewer must run the **exact same emulation core**. The verifier must run a
native core built from the **same MAME commit**. A build is identified by a hash of its
artifact plus the commit it was built from.

## Fields

| Name | Meaning | Format |
| --- | --- | --- |
| `core_hash` | sha256 of the **WASM** core artifact served to browsers | lowercase hex, 64 chars |
| `mame_commit` | full git commit of `mame/` the core was built from | lowercase hex, 40 chars |
| `rom_hash` | sha256 of the ROM zip served for the driver | lowercase hex, 64 chars |
| `netplay_patch` | sha256 of the netplay patch series the core was built with (`manifest.json`) | lowercase hex, 64 chars |

`netplay_patch` identifies the exact `core/patches/` source (see `docs/02-emulation-core.md`) that
produced `core_hash`. It is recorded for provenance; the cross-peer key remains `core_hash`.

`core_hash` is defined **only for the WASM artifact**, because that is the byte-identical
cross-peer key (`docs/02-emulation-core.md`): the same build produces the same bytes on
every machine. The native verifier binary is **not** expected to match `core_hash`; a native
build instead varies by `(mame_commit, toolchain, arch)`. The verifier therefore identifies
its core by `mame_commit` and must be built from the same commit as the WASM core — a
different `mame_commit` invalidates the replay. Native binary hashes are recorded per build
only as provenance, never compared across machines.

## Where it lives

- **Toolchain/emulator pins** (which versions produce a build) live in
  `core/versions.json`; `docs/02-emulation-core.md` mirrors them for humans. A test
  (`core/test/version-pins.test.mjs`) keeps the two in sync.
- **Wire:** `room.state` carries `coreHash` and `romHash` (`contracts/ws-messages.md`);
  a room locks to one `core_hash` for its whole life.
- **Database:** `games.core_version` and `matches.core_version` store the WASM `core_hash`;
  `matches.mame_commit` stores the commit the match's core was built from. The pair is what
  the verifier needs to rebuild and replay a match.
- **Input log:** the closed log records `core_version`, `mame_commit`, `rom_hash`, DIP
  settings and the start state (`docs/05-leaderboard-verifier.md`).

## Rule

If a peer or viewer reports a different `core_hash` than the room, it is a desync: drop and
re-fetch the exact WASM core build. If the verifier's `mame_commit` differs from the match's,
the replay is rejected outright.
