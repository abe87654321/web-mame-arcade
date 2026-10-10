# T25 · Desync detection + resync — implementation plan

**Goal:** every seated player hashes the machine every 60 frames; the relay compares
same-frame hashes and broadcasts `desync` on a mismatch; the host answers with a full
`state.snapshot` that peers fetch, load and resume from; every desync/resync is logged.

Docs: 03. Depends: T24.

## Decisions

- **Relay owns comparison.** `hash` is relay-ward only (docs/03, `contracts/ws-messages.md`);
  the relay stamps the sender slot and compares per frame, then broadcasts `desync`. Peers do
  not compare hashes directly, so there is one authority and no split-brain.
- **In-memory snapshot blob endpoint (not object storage yet).** `state.snapshot.blobUrl`
  points at `POST/GET /rooms/:id/snapshot` on the relay (`server.ts`), latest-per-room, size
  capped. MinIO/object storage is T30; the contract shape is unchanged.
- **Native frame-clock reset on load.** `netplay_load_state` restores the save buffer but does
  **not** reset `s_next_frame`/`s_pending`, and `netplay_set_inputs` drops `frame < s_next_frame`.
  A peer that loads a snapshot behind its own clock would refuse every subsequent input. Add
  `netplay_set_frame(frame)` (clear `s_pending < frame`) and expose it on `Core.load(state, frame)`.
  T40 rollback needs the same primitive.
- **Hash cadence is frame-derived, never wall-clock** (`frame % 60 == 0 && frame > 0`), so it is
  identical on every peer (AGENTS.md determinism rule).

## Files

- `docs/contracts/ws-messages.md` — `## Pinned in T25`.
- `packages/relay/src/room.ts` — per-room hashes, `recordHash`, `snapshotForResync`.
- `packages/relay/src/relay.ts` — `hash`/`desync`/`state.snapshot` dispatch, injected `log`.
- `packages/relay/src/server.ts` — in-memory snapshot blob routes.
- `packages/web/src/netplay/lockstep.ts` — `hash`/`hashInterval`/`onHash`, `resync(frame)`.
- `packages/web/src/netplay/session.ts` — `onDesync`, `onStateSnapshot`.
- `packages/web/src/netplay/match.ts` — hash send, host snapshot, load+resync, logging.
- `packages/web/src/netplay/index.ts` — exports.
- `core/patches/netplay/netplay.{h,cpp}`, `netplay_post.js` — `netplay_set_frame` + glue.
- `packages/web/src/core/{module,types,mame-core}.ts` — `setFrame`, `Core.load(state, frame?)`.

## Scope

- In: hash cadence, relay comparison + `desync`, host `state.snapshot` routing + blob store,
  web fetch/load/resync, native frame reset, logging.
- Out: object storage (T30), viewer/late-join snapshot target selection (T31), rollback (T40).

## Acceptance criteria

- [ ] Hash emitted by a seated player every 60 frames; relay broadcasts `desync` only on a
      genuine same-frame mismatch.
- [ ] Host `state.snapshot` fans out; a desynced peer fetches, loads and continues from the
      snapshot frame without stalling.
- [ ] Every desync/resync logged with room/frame (game/coreHash when available).
- [ ] Tests added in protocol/relay/web; `pnpm lint && pnpm typecheck && pnpm test` pass.

## Notes for the agent

- Files you may touch: the paths above.
- Files you must not touch: `mame/**` (except via `core/patches/`). The `netplay_set_frame`
  C++ change and the WASM rebuild are human-reviewed / human-run per AGENTS.md.
