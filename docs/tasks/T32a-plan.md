# T32a · Live scoreboard (browser) — implementation plan

**Goal:** broadcast each seated player's live score (once per second) to every
member of the room, and render it for players and viewers — display only, never
part of the emulation path. `Core.readScore` stays behind `CoreCapabilityError`
until T32b; this half delivers the protocol, relay, loader and UI so the core
read lands as a drop-in later.

Docs: 05, contracts/ws-messages. Depends: T24 (done).

## Decisions

- **`score.live` is relay-stamped**, like `player.ready`/`player.pause`: the
  client may omit `player`, the relay overwrites it with the sender's own slot,
  so a seated player cannot forge another slot's score. `score` is a
  non-negative integer. (Contract change pinned under T32.)
- **Scoremap schema lives in `packages/protocol`** — one shared format for the
  browser (T32b) and the native verifier (T33). The file is a wrapper
  `{ v: 1, players: [ { slot, cpu, space, addr, len, format, endian? } ] }`;
  docs/05's inline example becomes the per-entry shape.
- **The relay records the latest score per slot** and writes them into the input
  log's `end.scores` on `game.end` (`[]` default 0 for a slot with no report),
  closing the T30 loop (docs/contracts/input-log.md).
- **Fan-out includes the sender** (display uses "→ all"); a repeated sample is
  last-write-wins, which is harmless for a display value.
- **Sampling is wall-clock paced but never touches `core.step`**: a player reads
  its own slot's score at most once per second and sends `score.live`. No clock
  or randomness reaches the emulation path (AGENTS.md determinism rule).
- `readScore` may throw `CoreCapabilityError` (stock core / no scoremap); the
  sampler swallows it, so T32a ships with the plumbing and no data.

## Files

- `docs/contracts/ws-messages.md` — `## Pinned in T32`.
- `docs/contracts/scoremap.md` — new format + decode semantics.
- `docs/05-leaderboard-verifier.md` — example becomes the `players[]` wrapper.
- `packages/protocol/src/messages.ts` — `scoreLive.player` optional, `score ≥ 0`.
- `packages/protocol/src/scoremap.ts` — `scoreMap`/`scoreMapEntry` zod schema (new).
- `packages/protocol/src/index.ts` — export the schema + types.
- `packages/protocol/src/messages.test.ts`, `packages/protocol/src/scoremap.test.ts`.
- `packages/relay/src/room.ts` — `scores` map, `recordScore`, `begin` clear, `end` scores.
- `packages/relay/src/relay.ts` — `case "score.live"` fan-out.
- `packages/relay/src/room.test.ts`, `packages/relay/src/relay.test.ts`.
- `packages/web/src/netplay/session.ts` — `onScoreLive`.
- `packages/web/src/netplay/scoreboard.ts` — pure scoreboard/cadence (new).
- `packages/web/src/netplay/match.ts` — sampling + `onScores` + `scores()`.
- `packages/web/src/netplay/viewer.ts` — `onScores` + `scores()`.
- `packages/web/src/netplay/index.ts` — export scoreboard surface.
- `packages/web/src/netplay/{session,match,viewer}.test.ts`, `scoreboard.test.ts`.
- `packages/web/src/app/scoreboard-view.ts` — DOM-free overlay (new).
- `packages/web/src/app/app.ts` — render the overlay on the play + watch routes.
- `packages/web/src/app/{scoreboard-view,viewer,app}.test.ts`.

## Scope

- In: `score.live` protocol/relay/UI, scoremap schema + loader contract, live
  sampling, viewer overlay.
- Out: the native memory read + WASM rebuild + gridlee discovery (T32b),
  verification/leaderboard writes (T33/T34), anti-cheat (T36).

## Acceptance criteria

- [ ] `score.live` is relay-stamped (client `player` ignored); rejected
      `not_joined` / `not_playing` like `hash`; fanned out to every member.
- [ ] `game.end` writes the latest per-slot scores into `end.scores` (0 default).
- [ ] A seated player samples its own slot once per second and sends `score.live`;
      a failing `readScore` is swallowed (no throw into the animation loop).
- [ ] Players and viewers render a scoreboard overlay from the received scores.
- [ ] Tests added: protocol schema + fuzz, relay scoring/end, session routing,
      match cadence, viewer, scoreboard view.
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass.

## Post-review follow-ups

- Enforced the contract's unique-slot rule with a `scoreMap.refine` + a
  duplicate-slot test (docs/contracts/scoremap.md).
- Gated the sampler on `roomStatus === "playing"` so it stops once the relay
  flips the room to `ended` (a later T32b read no longer spams `not_playing`).
- Armed the sample cadence **after** the "nothing stepped yet" check, so the
  first eligible second of a match is not skipped.
- `Core.readScore` became `readScore(slot)` here (not T32b): the per-slot
  sampler needs it; the implementation still throws until the T32b core read.

## Notes for the agent

- Files you may touch: the paths above.
- Files you must not touch: `mame/**` (except via `core/patches/`). No native
  or WASM build is needed for T32a.
- The scoremap loader (`core/scoremap.ts`) and `readScore` wire-up land in T32b.
