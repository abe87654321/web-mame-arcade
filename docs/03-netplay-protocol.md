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
  - **Known limitation (deferred to T30/T33/T40).** After any resync the loop re-samples this
    client's own masks for the first frames after the snapshot frame. If the relay's first-wins
    input log already holds a different value for one of those frames, a verifier replay could
    diverge. Reconciling it (preserve our own already-sent masks with a coordinated frame clock,
    or let the log follow the snapshot) is the input-log/rollback work, not this task.

## Rollback (opt-in per game)
Predict missing remote input = last known; save state every frame in a ring of 8; on mismatch load the
state of that frame and re-simulate up to now in one browser tick. Enable only if save + 8 re-sim frames
fit in 16 ms on a mid-range laptop.

## Desync detection
Every 60 frames each peer sends `netplay_hash()` to the relay (`hash {frame, crc32}`). The relay
compares hashes **per frame across players**; a genuine same-frame mismatch broadcasts `desync`.
The host (lowest slot) then saves its state and sends `state.snapshot {frame, blobUrl}` labelled
with **its own last stepped frame** (not the relay's, which lags), and everyone else fetches the
blob, `core.load(bytes, frame)` + resyncs the lockstep to `frame + 1`. Log game + core version;
repeated desyncs ⇒ remove the driver from online play.

## Late join / reconnect
Joiner receives the latest host state + inputs since, then fast-forwards to live.

## Known open issue: save/load continuation is not reproducible (T46)
Everything above that recovers by `core.load(save())` + continue (desync `state.snapshot`,
viewer late-join, replay boot snapshot) currently rests on an **unproven** assumption. The
`e2e/save-integrity.e2e.ts` check shows that on the real netplay seam a reloaded snapshot does
**not** reproduce the uninterrupted future (`forward != reload`, even with all-zero inputs at
span 1), and `afterLoad != atSave`; `raiden`/`raiden2` `Core.save()` throws despite
`MACHINE_SUPPORTS_SAVE`. Until T46 (`docs/tasks/T46-save-load-continuation.md`) root-causes and
fixes this, treat snapshot-based recovery as best-effort, not bit-exact.
