# 03 · Netplay protocol

Start with delay-based lockstep; add rollback per game once stable.

## Transport
- WebRTC data channels, unreliable + unordered, peer-to-peer. Signalling via the relay WS. coturn for strict NAT.
- Every input packet is also sent to the relay (feeds viewers + verifier).
- Wire format: see `contracts/input-packet.md`. Each packet repeats the last 8 frames of input.

## Signalling and negotiation (pinned in T23)
- `room.state` carries `self`, the recipient's own player slot (null for viewers), so every
  client knows its role in each pair.
- Full mesh: one `RTCPeerConnection` per pair of player slots. For a pair the **lower slot
  initiates** — it creates the data channel with `{ ordered: false, maxRetransmits: 0 }` and
  offers; the higher slot answers. Exactly one offerer per pair, so there is no glare.
- SDP and ICE cross the relay as `rtc.signal`; the relay stamps `from` (the sender's slot) on the
  forwarded message and the receiver routes it to the peer for that slot. Trickle ICE: candidates
  go out as gathered, and a peer buffers remote candidates until it has set the remote description.
- ICE servers are configured in the browser (`VITE_STUN_URL`, `VITE_TURN_URL`,
  `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL`). coturn runs from `deploy/docker-compose.yml`
  with `use-auth-secret`; the API mints short-lived TURN credentials (T34).

## Start
- A netplay (`task lockstep`) core is **frozen at boot**: the loader arms `netplay_enable()` during
  runtime init, so MAME does not free-run before the match starts. Peers therefore all sit at frame 0
  with identical machine state; only the lockstep advances frames.
- Starting is **manual**: the lowest-slot host clicks "Start game" in the lobby once every peer's data
  channel is open, then sends `game.start {startFrame, inputDelay}`. A lone player may start too, which
  plays solo under the lockstep. This avoids the first player entering a room locking out later joiners.
- `startFrame` is 0: every peer boots the same core + ROM, so frame 0 is the same state everywhere.
  Mid-game join / resume from a snapshot is T25.
- The first `inputDelay` frames (`startFrame` .. `startFrame + inputDelay - 1`) are **neutral (mask 0)**
  for every slot, by construction: the lockstep pre-fills them so the first real input lands `D` frames
  after the start without any peer inventing a mask. An input log or a test script must therefore place
  its first non-zero mask at frame `startFrame + inputDelay`; a mask written inside the delay window is
  never requested and never stepped.

## Lockstep loop, per frame N
1. Read local controls, schedule them for frame N + D (D = 2-3, tuned from measured RTT).
2. Send to all peers and to the relay.
3. When all players' inputs for N are present: `core.step(N, inputs)`.
4. Late input → wait. After 2 s without input → show "waiting for player", pause.

## Adaptive input delay (T29)
D is chosen **once, in the lobby, by the host**, from the round-trip time to every peer
(`RTCPeerConnection.getStats`, the nominated succeeded `candidate-pair`) — never mid-game, so
the frame schedule is fixed for the whole match. The host picks the worst peer's RTT rounded up
to whole 60 Hz frames plus one frame of headroom, clamped to `[2, 6]`, and announces it in
`game.start`; every peer steps that agreed value, so it stays deterministic. An explicit
override (tests/e2e) wins over the measurement. `ack_frame` remains play-time telemetry
(`docs/contracts/input-packet.md`), not the lobby measurement.

## Resilience: collaborative pause and stall recovery (T29)
- **Collaborative pause.** A hidden/occluded tab throttles `requestAnimationFrame`, so that peer
  stops feeding inputs and stalls everyone. On `visibilitychange` the client sends
  `player.pause {paused}`; the relay keeps the room's paused slots and fans one aggregate
  boolean (docs/contracts/ws-messages.md). While the room is paused every peer's lockstep is
  frozen (`core.step` is not called; inbound packets still buffer). Our own hidden intent is
  OR-ed with the relay aggregate, so a peer's resume cannot unpause a tab that is still hidden.
  Pause is control-only: no clock reading reaches `core.step`, so it cannot cause a desync.
- **Stall recovery.** After 2 s without the next frame's input the peer sends `input.request`
  (T31) and the relay resends the recorded frames. If that does not unstick the loop within a
  further interval, the **host** escalates: it saves its last stepped frame and broadcasts a
  full `state.snapshot` (T25 path), so peers still stuck on a frame both sides lost re-load one
  authority's state and resume from it. Escalation is skipped while the room is paused.
  - **Resync and the input log (fixed in T40).** After a resync the loop re-uses the local masks
    it already sent for frames after the snapshot frame instead of re-sampling the device. Those
    values are first-wins in the relay log, so a verifier replay now sees exactly the inputs the
    recovered simulation used.

## Rollback (opt-in per game, T40)
Predict missing remote input = that player's last **confirmed** mask; save state every stepped frame; on
mismatch load the state from just before the first wrong frame and re-simulate through the last stepped
frame in one browser tick. Enabled per game with `netplayMode: "rollback"`.

- **Delay.** Rollback keeps `inputDelay = 2` (announced by the host in `game.start`). Prediction hides
  the rest of the RTT, so the RTT-sized delay used by wait-based lockstep would only add felt latency.
- **Window.** The correctable window is 2..8 frames (`rollbackWindow`, default 8). A correction for
  frame `F` needs the snapshot labelled `F - 1`; the loop keeps `window + 1` recent states plus the
  boot state, and never runs more than `window` frames ahead of the slowest confirmed peer. That bound
  guarantees every late packet is still recoverable; when it is reached the loop stalls (and falls
  into the T29 `input.request` / snapshot recovery) instead of predicting past the ring.
- **Incremental replay.** A correction re-simulates **one already-shown frame per animation tick**
  (silently, without redrawing it), not the whole window in one tick. The tick budget is therefore
  `save + one step`, independent of the window; a correction needs up to `window` ticks and briefly
  slows the local game instead of blowing the frame budget. The corrected current frame is rendered
  once when catch-up finishes.
- **Budget.** Each driver is measured by `pnpm --filter @wma/e2e test:rollback-budget`: it passes when
  `saveMs + min(stepMs, silentStepMs) <= 16 ms`, and the window is then written to `games.json`
  (`rollbackWindow`). A driver with no fitting tick stays `lockstep`. The probe is machine-specific;
  record results in `core/spike/README.md`.
- **Hashes.** A frame's hash is reported only after it can no longer be corrected
  (`frame <= current - window - 1`). The relay drops hashes older than its current comparison frame,
  so reporting a predicted hash early could hide the comparison or raise a false `desync`.
- **Overload.** A local, wall-clock-only meter stops prediction for the rest of the match when the
  measured per-tick rollback cost stays above 20 ms for one second, or after more than 20 rewinds in
  60 frames. Degraded rollback waits for real inputs (like lockstep) but keeps the window/ring so
  predictions made before degradation can still be corrected. The clock never reaches `core.step`.
- **Fallback.** If the core cannot save (empty/throwing state) or the ring would exceed the memory
  budget, the client runs wait-based lockstep for that match. Mixed peers are safe: rollback only
  changes when a frame runs, not the inputs it ends up with.
- **Input log.** Only real inputs are sent, so the relay log and verifier replay are unchanged. On any
  resync the client re-uses the local masks it already sent for frames after the snapshot (they are
  first-wins in the relay log) instead of re-sampling the device, closing the divergence noted in T29.

## Desync detection
Every 60 frames each peer sends `netplay_hash()` to the relay (`hash {frame, crc32}`). The relay
compares hashes **per frame across players**; a genuine same-frame mismatch broadcasts `desync`.
The host (lowest slot) then saves its state and sends `state.snapshot {frame, blobUrl}` labelled
with **its own last stepped frame** (not the relay's, which lags), and everyone else fetches the
blob, `core.load(bytes, frame)` + resyncs the lockstep to `frame + 1`. Log game + core version;
repeated desyncs ⇒ remove the driver from online play.

## Late join / reconnect
Joiner receives the latest host state + inputs since, then fast-forwards to live.

## Save/load continuation (T46 — partial)
Everything above recovers by `core.load(save())` + continue (desync `state.snapshot`,
viewer late-join, replay boot snapshot). That invariant was **broken**. T46 found and fixed
one root cause in MAME's scheduler: `device_scheduler::time()` returns the unsaved
`m_callback_timer_expire_time` while inside a callback, so loading a state from a frame
callback (a Lua/plugin notifier) left `time()` a frame ahead of the restored `m_basetime`;
`core/patches/netplay/0007-schedule-clock.patch` re-bases it in `postload`. Verified
natively by `core/spike/native-save-continuation.sh` (`SI_DET=PASS`), with T02/T28 passing.

A second root cause was found and fixed in the browser path:
`lua_engine::on_machine_postload()` reset the Lua resume timer on every load, changing the
timer's saved bytes (`m_enabled`/`m_start`). Because `netplay_hash()` hashes the whole save
buffer, a peer that recovered via `state.snapshot` no longer hashed to the state it was
saved from and would report a **false desync** on every recovery;
`core/patches/netplay/0009-lua-engine-postload.patch` only re-arms the timer when there are
waiting tasks. After it, `e2e/save-integrity.e2e.ts` reports `loadByteEqual=true` /
`loadDiffCount=0` (the round-trip is byte-exact) and continuation passes for zero input,
joystick/buttons and START (gridlee, native RAM and full buffer both exact).

A third root cause was the **unsaved ioport live state**. MAME's save buffer does not
include an ioport field's externally-set value / live state (`last`, `impulse`, `toggle`,
…) nor the port's cached `digital` value; `ioport_port::read()` returns that cached value,
which is only recomputed once per frame. After a load the CPU therefore read a stale input
port and the first frame diverged (worst with COIN, whose edges/impulse make it visible).
`netplay_save_state`/`load_state` now append and restore this state, so the browser seam is
byte-exact (`forward == reload`, `fwdReloadDiffCount=0`) for gridlee and twinbee, over zero
/ joystick-button / START inputs, at every boot/span tried.

`raiden`/`raiden2` throw on `Core.save()` (empty save buffer) and remain catalogued
`supportsSave:false` / `netplayMode:"none"`.
