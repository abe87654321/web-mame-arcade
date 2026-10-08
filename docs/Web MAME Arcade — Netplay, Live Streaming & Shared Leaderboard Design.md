# Web MAME Arcade — Netplay, Live Streaming & Shared Leaderboard Design

Oct 7, 2026 · @abe

## Goals and scope

The recommended design runs MAME as WebAssembly inside each player's browser, synchronises players by exchanging inputs (not video), lets viewers watch by replaying the same input stream, and verifies every leaderboard score on an Ubuntu server with native headless MAME.

Requirements taken from the brief:

- **Play in the browser.** A player picks a game from your ROM library and plays it on a web page with keyboard or gamepad.
- **Online multiplayer.** Two to four players in different places play the same machine at the same time (P1/P2 on one cabinet), with low input lag.
- **Live spectating.** Anyone can open a room and watch a match live while it is played.
- **Shared leaderboard.** Players see a common high-score board per game, plus a live scoreboard while a match runs.
- **Ubuntu hosting.** All server components run on Ubuntu (24.04 LTS assumed).

Out of scope for v1: arbitrary uploads of ROMs by users, mobile touch controls, and games whose MAME drivers lack save-state support (they can still be played solo, just not online).

## What the MAME source tells us

MAME already has everything needed for browser play, but its browser main loop is driven by the wall clock, so netplay needs one small C++ patch. Findings from the `mamedev/mame` master branch (commit `b67e5bc`, 7 Oct 2026):

| Area | Where in the source | What it means for us |
| --- | --- | --- |
| Browser build | `docs/source/initialsetup/compilingmame.rst`, section *Emscripten Javascript and HTML* | Official path: Emscripten 6.0.2+, `embuilder build sdl3 sdl3_ttf`, then `emmake make SUBTARGET=x SOURCES=src/mame/.../driver.cpp`. One small build per game family, because full MAME is too big for a browser. |
| Browser main loop | `src/emu/machine.cpp`, `running_machine::emscripten_main_loop()` (\~line 1401) | Called by `emscripten_set_main_loop` at the display rate; each call advances emulated time by a fixed 1/60 s. It advances whenever the browser asks, so peers drift apart. **This is the function we patch** so it only advances when frame N's inputs from all players are known. |
| JS control hooks | `machine.cpp` \~lines 1449–1477 | Exported helpers already exist: `emscripten_soft_reset`, `emscripten_hard_reset`, `emscripten_exit`, `emscripten_save(name)`, `emscripten_load(name)`. Useful for room control (reset, late-join state transfer). |
| In-memory save states | `src/emu/save.h`: `save_manager::write_buffer()` / `read_buffer()`, class `rewinder` | States can be captured to a RAM buffer without touching the file system (this is what MAME's rewind uses). This makes rollback netplay and late-join possible. |
| Save-state support per game | `src/emu/gamedrv.h`, flag `MACHINE_SUPPORTS_SAVE` | Only drivers with this flag can do rollback, late join or verification snapshots. Filter the online catalogue on it. |
| Scripted input | `docs/source/luascript/ref-input.rst`: `field:set_value(v)`, `field:clear_value()` on `manager.machine.ioport.ports[tag]` | Inputs can be injected per field, which is how the server-side verifier replays a match. |
| Score reading | `plugins/hiscore/` (`hiscore.dat` + `init.lua`, reads RAM with `mem:read_u8(addr)`) | `hiscore.dat` already maps where thousands of games keep their high-score table in RAM. We reuse those addresses to read live scores and final scores. |

MAME emulation is deterministic: the same build, same ROM set, same settings and the same input on the same frame produce the same result. Every design choice below relies on that.

## Architecture options

Choose option C: browser emulation for players and viewers, with the server only relaying inputs and re-checking scores. It gives the lowest lag and the lowest server bill.

|  | A. Server-side emulation (cloud gaming) | B. Browser emulation, peer-to-peer only | C. Hybrid (recommended) |
| --- | --- | --- | --- |
| Where MAME runs | One native MAME process per room on Ubuntu; video encoded and streamed to every player | In each player's browser (WASM) | In each player's and viewer's browser (WASM), plus a headless native MAME on the server for score checks |
| Input lag | Network round trip + encode/decode, typically 50–120 ms | Lowest: one-way trip, hidden by input delay or rollback | Same as B |
| Server cost | High: 1 CPU core + video encoder per room | Very low: signalling only | Low: input relay + a verifier that runs faster than real time |
| Spectating | Free: just more viewers on the same stream | Viewers need the input stream from a player | Viewers receive the input stream from the relay; optional video fallback |
| Cheating / fake scores | Impossible, server is the authority | Easy, clients report scores | Prevented: the server replays the input log and computes the score itself |
| ROMs leave the server | No | Yes, sent to browsers | Yes, sent to browsers (see the ROM section) |
| Best for | Weak devices, strict ROM control | Hobby prototype | A public site with leaderboards |

If your ROM rights do not allow sending ROM files to browsers, use option A instead: the netplay, streaming and leaderboard sections below still apply, with the server's MAME as the only emulator.

## System architecture

Emulation happens in browsers; the Ubuntu server only serves files, relays inputs, stores data and re-checks scores.

&#91;embedded content: system architecture · 3 browsers, 8 server services\]

Players send inputs to each other directly and also to the room relay, which records the match and streams it to viewers. After a match, the relay queues the input log in Redis and a verifier replays it in native MAME before the score reaches PostgreSQL. Every browser loads pages, cores and ROMs from Nginx; coturn steps in only when two players cannot connect directly.

## Emulation core: MAME to WebAssembly

Build one small WASM bundle per driver family on an Ubuntu build machine, add a \~300-line netplay patch, and publish the bundles as versioned static files.

**Build steps (Ubuntu 24.04):**

```bash
sudo apt install build-essential git python3 libsdl2-dev
git clone https://github.com/emscripten-core/emsdk && cd emsdk
./emsdk install latest && ./emsdk activate latest && source ./emsdk_env.sh
embuilder build sdl3 sdl3_ttf
cd ~/mame   # your fork with the netplay patch
emmake make SUBTARGET=pacman SOURCES=src/mame/pacman/pacman.cpp -j$(nproc)
# output: pacman.js + pacman.wasm  -> upload to /static/cores/pacman/<git-sha>/
```

Also build the same fork natively (`make SUBTARGET=... -j$(nproc)`) for the server verifier. Both must come from the same commit, or replays will not match.

**The netplay patch (in your fork):**

1. **Frame gate.** In `running_machine::emscripten_main_loop()`, before stepping the scheduler, call `netplay_ready(frame)`. If inputs for that frame are missing, return without stepping; the browser calls again next refresh.
2. **Input injection.** Export `netplay_set_inputs(frame, p1, p2, p3, p4)` with `EMSCRIPTEN_KEEPALIVE`. At the start of each frame, write the bitmasks into the ioport fields (the C++ equivalent of Lua's `field:set_value`). Local keyboard and gamepad input never reaches MAME directly; it goes to JavaScript first.
3. **State buffers.** Export `netplay_save_state(ptr)` and `netplay_load_state(ptr)` built on `save_manager::write_buffer()` / `read_buffer()`, for rollback and late join.
4. **State hash.** Export `netplay_hash()` that returns a CRC32 of main RAM, for desync detection.
5. **Frame clock.** Step by the game's real screen period (for example 60.6 Hz for Pac-Man), not the fixed 1/60 s in the stock loop, so one netplay frame equals one emulated video frame.

**Browser wrapper:** a TypeScript module loads the core, mounts the ROM zip into Emscripten's virtual file system, and starts MAME with identical options on every peer: `-skip_gameinfo`, an empty per-session `-nvram_directory`, no `.ini` files, and the same DIP switch values chosen by the room host. Any setting that differs between peers causes a desync. Serve pages with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` if you enable WASM threads.

## Netplay protocol

Start with delay-based lockstep (2–3 frames of input delay over WebRTC data channels) and add rollback per game once it is stable. Lockstep is simple and works for every save-state game; rollback feels better in fighting games but costs one save state per frame.

**Transport.** Players connect peer-to-peer with WebRTC data channels in unreliable, unordered mode (lowest latency). A signalling service exchanges SDP offers; `coturn` on your Ubuntu server provides STUN/TURN for players behind strict NAT. Every input packet also goes to the room relay over a WebSocket, which feeds spectators and the score verifier.

**Input packet** (about 12 bytes, sent every frame):

```text
room_seq:u32  frame:u32  player:u8  buttons:u16  ack_frame:u32
```

Each packet repeats the last 8 frames of that player's input, so a lost packet costs nothing.

**Lockstep loop, per frame N:**

1. Read local controls and schedule them for frame N + D (D = input delay, 2–3 frames, adjusted from measured ping).
2. Send that input to all peers and to the relay.
3. When inputs from every player for frame N have arrived, call `netplay_set_inputs(N, …)` and let MAME step one frame.
4. If an input is late, wait (the game freezes briefly). After 2 seconds without input, show "waiting for player" and pause.

**Rollback upgrade (per game, opt-in):** predict a missing remote input as "same as last frame" and step anyway, saving a state every frame into a ring of 8 buffers. When the real input arrives and differs, load the state from that frame and re-run the frames up to now in one browser tick. Enable it only for games where a save plus up to 8 re-simulated frames fits in one 16 ms frame on a mid-range laptop; test this per driver.

**Desync detection.** Every 60 frames each peer sends `netplay_hash()`. On a mismatch, the room host sends a full save state (`netplay_save_state`) and everyone loads it. Log every desync with the game and core version; repeated desyncs mean that driver or build is not deterministic and should be removed from online play.

**Late join and reconnect.** A joining player or viewer receives the latest save state from the host plus the inputs since that state, then fast-forwards to live.

## Live streaming to spectators

Viewers watch by running the same WASM core and replaying the players' input stream, which costs about 1 KB/s per viewer instead of 2–4 Mbit/s of video. Offer a video stream only as a fallback for devices that cannot run the core.

**Path 1: input-replay spectating (default).**

- The viewer page loads the same core version, receives the latest save state from the relay, then subscribes to the room's input stream over WebSocket.
- The viewer runs 2–5 seconds behind live, which smooths network jitter and stops players from watching the spectator stream to cheat.
- Picture and sound are pixel-perfect, and the same mechanism gives free replays: a finished match is just the start state plus the input log.
- Fan-out: one relay process (Node.js or Go with `uWebSockets`) can push input streams to tens of thousands of viewers; add Redis pub/sub between relay nodes to scale out.

**Path 2: video fallback (optional).**

- The room host's browser captures the game canvas and audio with `canvas.captureStream(60)` and Web Audio, and publishes them over WebRTC to a [LiveKit](https://github.com/livekit/livekit) SFU self-hosted on Ubuntu.
- Up to a few hundred viewers watch through LiveKit directly with under 500 ms delay. For larger audiences, LiveKit Egress converts the room into HLS for a CDN (5–10 s delay).
- Simulcast (three resolutions) lets each viewer get a quality their connection can hold. This path uses the host's upload bandwidth, so make it opt-in.

**Viewer features:** player names, live score overlay (from the scoreboard feed below), chat over the same WebSocket, viewer count, and a "watch from start" button that replays the input log.

## Shared leaderboard and live scoreboard

A score enters the shared leaderboard only after the server has replayed the match's input log in native MAME and read the same score from RAM. Players never send a score number the server trusts.

**Live scoreboard (during a match).** The browser reads the score bytes each second using the addresses from `hiscore.dat` and pushes them to the relay, which broadcasts them to players and viewers. This is display only. For games where `hiscore.dat` maps only the saved table, add a small per-game file `scoremap.json` with the RAM address and format (BCD or binary) of the current score, found once with MAME's debugger.

**Verified leaderboard (after a match):**

1. When the game ends, the relay closes the input log: core version, ROM set hash, DIP settings, start state, and every frame's inputs.
2. A verifier worker starts native headless MAME from the same commit: `mame pacman -video none -sound none -nothrottle -autoboot_script verify.lua`.
3. `verify.lua` feeds each frame's inputs with `field:set_value()` and, at the last frame, reads the score with `mem:read_u8()` at the `scoremap.json` address.
4. Classic 1980s drivers usually run many times faster than real time when unthrottled, so a long match verifies in seconds to a minute. Measure each game before launch and size the worker pool from that.
5. If the score matches what the client showed, it is written to PostgreSQL and to a Redis sorted set (`ZADD lb:pacman:alltime <score> <user>`); otherwise the match is flagged.

**Boards to offer:** all-time, this week, today, per country, and between friends, each per game and per mode (solo, co-op, versus). Each entry links to its replay, so anyone can watch how a record was set.

## Backend services and Ubuntu deployment

Six small services on one Ubuntu 24.04 server are enough for launch; each runs in Docker so you can split them across machines later.

| Service | Job | Suggested tech | Port / path |
| --- | --- | --- | --- |
| Web + static | Pages, WASM cores, ROM downloads with signed URLs | Nginx (HTTP/2, COOP/COEP headers, Brotli) | 443 `/`, `/static/cores/` |
| API | Accounts, game catalogue, rooms, leaderboards | Node.js (Fastify) or Go, JWT sessions | 443 `/api/` |
| Room relay | Signalling, input log, spectator fan-out, chat, live scores | Go or Node.js + `uWebSockets`, Redis pub/sub | 443 `/ws/` |
| TURN | NAT traversal for WebRTC | `coturn` | 3478 UDP/TCP, 5349 TLS |
| Verifier workers | Replay input logs in headless native MAME | MAME native build + `verify.lua`, jobs from a Redis queue | internal |
| Video SFU (optional) | Video fallback for viewers | LiveKit server + Egress | 7880, UDP 50000–60000 |

**Data stores:** PostgreSQL for users, games, matches and scores; Redis for live rooms, sorted-set leaderboards and the job queue; object storage (local disk or S3-compatible such as MinIO) for ROMs, cores and replay logs (about 1 KB per second of play, compressed).

**Core tables:**

```sql
games(id, rom_set, driver, core_version, supports_save, netplay_mode, max_players)
users(id, name, country, created_at)
matches(id, game_id, mode, core_version, rom_hash, dip_settings, started_at, ended_at, replay_key, status)
match_players(match_id, user_id, slot)
scores(id, match_id, user_id, game_id, score, verified_at)
```

**Room flow:** a player creates a room through the API, the relay assigns a room ID, peers join through the relay's signalling channel, the host chooses the game and DIP settings, and the relay records the input log from the first frame.

**Starting server size:** 8 vCPU, 16 GB RAM, 1 Gbit/s. Input-replay spectating keeps bandwidth low; the video SFU is the first thing to move to its own machine if you enable it.

## ROMs, licensing and security

Owning ROM files does not by itself give the right to send them to the public, so check the rights for each game before it goes into the online catalogue. I am not a lawyer; get advice for the countries you serve.

- **ROM rights.** Option C sends ROM files to every player's and viewer's browser, which is distribution. Use it only for games you have a licence for, ones released for free use by their rights holders, or homebrew. For other games, use option A (server-side emulation), where ROMs never leave your server.
- **MAME's licence.** MAME is GPL-2.0-or-later as a whole. Serving your patched WASM build to the public means offering the matching source code, including the netplay patch: link your fork's exact commit from the site.
- **ROM delivery.** Serve ROMs only through short-lived signed URLs after login, never from a public directory listing. This limits scraping; it does not make distribution legal if the rights are missing.
- **Cheating.** Scores are never trusted from clients (see the verifier). Input timing bots are still possible; flag inhumanly consistent input patterns for review.
- **Abuse.** Rate-limit room creation and chat, require login for leaderboard entries, and add report/mute for chat.
- **Privacy.** WebRTC peer-to-peer reveals players' IP addresses to each other. Offer a "relay only" setting that forces traffic through TURN for players who do not want that.

## Roadmap and risks

Build in four phases, each ending with something playable; do not start the next phase until the gate at the end of the current one is met.

1. **Solo play in the browser.** WASM build of one driver (Pac-Man), ROM loading, keyboard and gamepad, Nginx with the right headers. Gate: runs at full speed in Chrome, Firefox and Safari.
2. **Two-player lockstep.** Netplay patch, signalling + TURN, lockstep with input delay, desync hashing. Gate: a 30-minute match between Paris and a distant city with zero desyncs.
3. **Spectating and leaderboard.** Relay input log, input-replay viewers, live score overlay, headless verifier, Redis/PostgreSQL boards, replays. Gate: verifier reproduces 100% of 200 test matches.
4. **Scale and polish.** Rollback for selected games, video fallback through LiveKit, more drivers, friends and country boards, monitoring.

| Risk | Effect | Mitigation |
| --- | --- | --- |
| A driver is not fully deterministic | Desyncs, failed verification | Run 200 automated replay tests per game before listing it online; keep only drivers that pass |
| Save states slow for heavy drivers | Rollback impossible, slow late join | Lockstep only for those games; late join waits for the next save point |
| Browser frame timing jitter | Stutter in lockstep | Small input buffer, frame pacing by `performance.now()`, not only `requestAnimationFrame` |
| Different core versions in one room | Instant desync | Room locks to one core hash; the client downloads that exact version |
| ROM rights unclear | Legal exposure | Online catalogue limited to licensed or free titles; option A for the rest |
| Upstream MAME changes the main loop | Patch breaks on update | Keep the patch small, in its own files, and pin each game to a tested commit |
