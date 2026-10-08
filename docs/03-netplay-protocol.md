# 03 · Netplay protocol

Start with delay-based lockstep; add rollback per game once stable.

## Transport
- WebRTC data channels, unreliable + unordered, peer-to-peer. Signalling via the relay WS. coturn for strict NAT.
- Every input packet is also sent to the relay (feeds viewers + verifier).
- Wire format: see `contracts/input-packet.md`. Each packet repeats the last 8 frames of input.

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
