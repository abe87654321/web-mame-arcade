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

## Lockstep loop, per frame N
1. Read local controls, schedule them for frame N + D (D = 2-3, tuned from measured ping).
2. Send to all peers and to the relay.
3. When all players' inputs for N are present: `core.step(N, inputs)`.
4. Late input → wait. After 2 s without input → show "waiting for player", pause.

## Rollback (opt-in per game)
Predict missing remote input = last known; save state every frame in a ring of 8; on mismatch load the
state of that frame and re-simulate up to now in one browser tick. Enable only if save + 8 re-sim frames
fit in 16 ms on a mid-range laptop.

## Desync detection
Every 60 frames each peer sends `netplay_hash()`. Mismatch → host sends full state, everyone loads it.
Log game + core version; repeated desyncs ⇒ remove the driver from online play.

## Late join / reconnect
Joiner receives the latest host state + inputs since, then fast-forwards to live.
