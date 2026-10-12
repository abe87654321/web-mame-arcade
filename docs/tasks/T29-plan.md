# T29 · Client lockstep hardening — implementation plan

**Goal:** make the browser lockstep resilient to the stalls T28 metrics surfaced —
a hidden/occluded tab throttling `requestAnimationFrame`, mutual input loss, and a
badly-sized fixed input delay — without letting any clock reading reach `core.step`.

Docs: 03, 04, contracts/ws-messages, contracts/input-packet. Depends: T28 (done).

## Decisions

- **Pause is relay-routed and relay-aggregated.** A new `player.pause` message: a
  seated player sends its own toggle; the relay keeps the room's paused slots and
  fans one aggregate `paused` boolean to every member (players + viewers), stamping
  the sender slot (mirrors `player.ready`, T27). A leaving/disconnecting player is
  dropped from the set and `game.start` clears it, so a hidden tab cannot wedge the
  room paused. Rejected: P2P-only — viewers and late joiners would miss it.
- **Adaptive delay is chosen once, in the lobby, by the host**, from
  `RTCPeerConnection.getStats` RTT, carried by `game.start` like the fixed delay was.
  Mid-game D changes are out of scope (they would invalidate the frame schedule).
  Determinism: every peer steps the same agreed D; `ack_frame` stays play-time
  telemetry only.
- **Mutual-stall escalation reuses the T25 `state.snapshot` path.** After `onStall`
  (2 s, sends `input.request`) a still-stalled loop escalates after a further
  interval; only the host acts, and never while paused.
- **Pause gates `core.step` only.** No clock reading reaches `step`, so pause/resume
  cannot cause a desync (AGENTS.md determinism rule).

## Files

- `docs/contracts/ws-messages.md` — `player.pause` row + `## Pinned in T29`.
- `packages/protocol/src/messages.ts` — `playerPause` schema, unions, type.
- `packages/relay/src/room.ts` — `paused` set, `setPause`, clear on `begin`, drop on `leave`.
- `packages/relay/src/relay.ts` — `player.pause` dispatch (fan the aggregate).
- `packages/web/src/netplay/lockstep.ts` — `pause`/`resume`/`paused`, `onStallEscalate`.
- `packages/web/src/netplay/delay.ts` — pure `selectInputDelay` (new).
- `packages/web/src/netplay/{peer,mesh,session,types,test-fakes}.ts` — `getStats`/`rttMs`/`peerRtts`.
- `packages/web/src/netplay/match.ts` — paused status/lobby, `setPaused`, `sendRecoverySnapshot`,
  adaptive delay in `start()`, `onPlayerPause`.
- `packages/web/src/app/{app,lobby-view}.ts` — visibility wiring, `paused` status/badge.
- `packages/web/src/netplay/lockstep.test.ts` — golden step-trace regression (T29).
- `e2e/golden-replay.e2e.ts` — e2e golden (replay the frozen core to a committed CRC32).
- `docs/03-netplay-protocol.md`, `docs/04-spectating.md`, `contracts/input-packet.md`.

## Scope

- In: collaborative pause, stall escalation + host-snapshot fallback, lobby-RTT
  adaptive delay, golden-replay regression.
- Out: mid-game delay changes, rollback (T40), server-authoritative (T45),
  anti-cheat analysis (T36).

## Acceptance criteria

- [x] A hidden tab pauses the whole room via `player.pause`; our own hidden intent is
      OR-ed with the relay aggregate so a peer's resume cannot unpause us. A tab hidden
      before `game.start` still pauses the room once it begins.
- [x] A still-stalled loop escalates (host-only) to a `state.snapshot`; skipped while paused.
- [x] The host sizes D from lobby RTT and announces it in `game.start`; override wins.
- [x] Golden step-trace regression (unit) + e2e golden harness; no clock reaches `core.step`.
- [x] `pnpm lint && pnpm typecheck && pnpm test` pass.

## Post-review follow-ups

- Fixed a blocking `resume()` bug: resuming from a `waiting` pause left the status stale,
  suppressing future `onStall`/`input.request` (lockstep.test.ts regression added).
- Guarded `state.snapshot` application against out-of-order fetches (match.test.ts).
- `rttMs()` prefers the nominated succeeded candidate pair (docs/03 wording).
- **Deferred (documented in docs/03):** the resync re-samples this client's own immediate
  post-snapshot masks; reconciling that with the relay's first-wins input log is T30/T33/T40.
  A first attempt to preserve own masks skewed the two peers and was reverted.

## Notes for the agent

- Files you may touch: the paths above.
- Files you must not touch: `mame/**` (except via `core/patches/`). No native/WASM
  rebuild is needed for this task.
- The e2e golden is skipped until a human records `e2e/fixtures/golden/<driver>.json`
  from a built core (log line `GOLDEN <driver> ...`).
