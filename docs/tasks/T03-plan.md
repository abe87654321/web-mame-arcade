# T03 Contracts & version pinning — implementation plan

**Goal:** make the contracts and the pinned toolchain/emulator versions a single,
machine-checked source of truth, and define exactly how a core build is identified
and stored per match.

## Context / why this is a re-open

An earlier docs-only commit (`2dfc22d`, "docs(T03)...") already reconciled the
`design.md` input packet and `games.rom_set`, replaced emsdk `latest` with `6.0.2`,
and wrote the `docs/02` pin table — and it flipped the README checkbox to `[x]`.
It shipped **no tests** and left two loose ends that `T02-results.md:49` assigns to
T03:

1. the pins are prose, never asserted anywhere, so they can silently drift; and
2. `core_version` is described inconsistently — `contracts/db-schema.sql` calls it
   "git sha of the fork" while `docs/02` calls it the `(sha256, MAME commit)` pair.

This plan closes both.

## Decisions

- **Pins get one machine-readable home:** `core/versions.json`
  (`node`, `emsdk`, `mameCommit`). `docs/02` mirrors it for humans; a test keeps them
  equal. `core/build-native.sh` reads the commit from there instead of hardcoding it.
- **Core build identity is the WASM sha256.** A core build is identified by
  `core_hash` = sha256 of the WASM artifact (the cross-peer key, `docs/02`), pinned
  together with the exact `mame_commit` that produced it. The new contract
  `docs/contracts/core-version.md` is the definition; DB columns are
  `core_version` (the hash) + `mame_commit`, wire messages keep `coreHash`/`romHash`.
- Keep the DB change minimal: add `mame_commit text NOT NULL` to `matches`; fix the
  `games.core_version` comment. No migration code (that is T34).

## Files

- `docs/contracts/core-version.md` — new contract: core_hash / mame_commit, DB
  mapping, wire mapping, equality rule.
- `docs/contracts/db-schema.sql` — fix `games.core_version` comment; add
  `matches.mame_commit`.
- `core/versions.json` — new machine source of pins.
- `core/build-native.sh` — read `mameCommit` from `core/versions.json`.
- `core/test/version-pins.test.mjs` — assert pins agree across
  `.nvmrc`, `package.json`, `.github/workflows/ci.yml`, `docs/02`, `design.md`,
  `core/build-native.sh`, the submodule **gitlink in HEAD** (so it runs in CI without a
  submodule checkout) plus the working tree when present, and forbid emsdk `latest`.
- `core/test/build-native.test.mjs` — assert the dry-run commit against `versions.json`
  instead of a second hardcoded literal.
- `docs/02-emulation-core.md` — point the pin table at `core/versions.json`; align
  the core_version paragraph with the new contract.
- `docs/05-leaderboard-verifier.md` — record `mame_commit` in the closed input log.
- `docs/Web MAME Arcade … Design.md` — add `mame_commit` to the `matches` core-table
  line.
- `docs/tasks/README.md` — keep T03 `[x]` (already true).

## Scope

- In: pin single-source-of-truth + assertions, core_version contract, doc alignment.
- Out: build-wasm (T10), actual core hash computation (T10/T11), DB migrations (T34),
  changing MAME or emsdk versions.

## Acceptance criteria

- [x] `core/versions.json` exists and is read by `core/build-native.sh`.
- [x] `core_version` has one definition across `contracts/*`, `docs/02` and design.md:
      `core_hash` is the WASM sha256, `mame_commit` is separate, the native verifier
      matches on `mame_commit` only.
- [x] `core/test/version-pins.test.mjs` fails if any pinned value drifts or emsdk
      `latest` reappears; the gitlink check runs in CI, the working-tree check skips
      when `mame/` is not initialised.
- [x] No emsdk `latest` outside historical plan docs.
- [x] `pnpm lint && pnpm typecheck && pnpm test` pass.
