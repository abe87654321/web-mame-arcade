# 04 · Spectating and live streaming

## Path 1 – input-replay (default, ~1 KB/s per viewer)
- Viewer loads the same core version, gets the latest state from the relay, subscribes to the room's input stream.
- Runs 2-5 s behind live (jitter buffer + anti-cheat: players can't watch the spectator feed).
- Pixel-perfect; replays come free (start state + input log).
- Fan-out: relay on uWebSockets.js; Redis pub/sub between relay nodes to scale out.

## Path 2 – video fallback (optional, opt-in by host)
- Host captures `canvas.captureStream(60)` + Web Audio, publishes via WebRTC to self-hosted LiveKit.
- Few hundred viewers direct (<500 ms); larger audiences via LiveKit Egress → HLS → CDN (5-10 s).
- Simulcast 3 layers. Costs host upload bandwidth.

## Viewer UI
Player names, live score overlay, chat (same WS), viewer count, "watch from start".
