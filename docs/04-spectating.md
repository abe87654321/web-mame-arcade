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
- **Implemented in T41 (direct only):** the relay issues per-member LiveKit tokens over the
  authenticated WS (`livekit.access`, identity = the join JWT `sub`; host canPublish, viewers
  subscribe-only) and the web taps MAME's audio into the published stream. Egress → HLS **and
  simulcast** are **deferred** to a later task; only the direct LiveKit server runs today (`deploy/`).

## Viewer UI
Player names, live score overlay, chat (same WS), viewer count, "watch from start".

## Implemented in T31
- Entry point: `#/game/<driver>/room/<room>/watch` (a "Watch" control in the lobby).
- The viewer joins the relay as role `viewer` and receives `viewer.state`: the match
  identity (`driver`/`coreHash`/`mameCommit`/`romHash`/`dips`), the start
  (`startFrame`/`inputDelay`), the roster and the latest live-join snapshot.
- The host publishes `viewer.snapshot {frame, blobUrl}` every ~5 s (host-only, wall-clock);
  the relay stores it and forwards it to viewers only. A joining viewer fetches the blob,
  `core.load(bytes, frame)`, then replays the relayed inputs since that frame.
- The relay fans every binary `input` frame to all members except the sender, so viewers
  get the stream (and players get it as redundancy). The viewer's pure playback buffer
  (docs/contracts/ws-messages.md, `netplay/playback.ts`) holds 3 s behind live and catches
  up in bounded bursts after a stall. Live score overlay/chat/viewer count are later (T32/T36).
- A collaborative pause (T29, `player.pause`) is fanned to viewers too: no fresh inputs arrive
  while the room is paused, so the viewer simply drains its buffer and waits — no separate
  pause handling is needed in the playback loop.

## Implemented in T35 ("watch from start")
- Entry point: `#/game/<driver>/replay/<key>`, where `key` is the closed match's
  `matches.replay_key` (`match/<room>/<id>.json.gz`), URL-encoded because it contains
  slashes. The driver sits in the route so the catalogue entry (core URL, ROM URL) is
  known before the log is decoded.
- The page fetches the gzip artifact from `GET /api/replays/:key` (T34), gunzips it and
  decodes the closed `InputLog` (docs/contracts/input-log.md) with the shared
  `decodeInputLog`, then verifies `core_hash` / `rom_hash` / `mame_commit` against the
  catalogue entry. A mismatch is refused, never replayed.
- It boots the **same** WASM core the match used, armed (`netplay: true`) so the machine
  is frozen at boot, and steps frames `start.frame … end.frame` from the log's `frames`
  only — the offline sibling of the live viewer. Controls: play/pause, restart (reloads a
  boot snapshot via `core.load`), and a frame progress indicator; the match reaches status
  `ended` at `end.frame`. No clock reading reaches `core.step` (determinism rule).
- No new link UI: replay links come from T34's API (`/api/matches/:id/replay`, leaderboard
  `replayUrl`); a leaderboard/match page that surfaces them is later work.
