# 07 · ROMs, licensing, security

- **ROM rights**: option C sends ROMs to browsers = distribution. Only licensed, freely released, or homebrew titles
  online; others via option A (server-side). Get legal advice for the countries served.
- **Development/CI ROMs**: use the free ROMs MAME publishes at https://www.mamedev.org/roms/ so tests are legal to share.
- **Local dev with commercial ROMs** (`twinbee`, `raiden`, `raiden2`, `twincobr`): the zips live only in the
  gitignored `roms/` and are **never committed** (no zips, no builds). The Vite dev server serves
  `/roms/<driver>.zip` from that directory (see `packages/web/vite.config.ts`), and their
  `games.json` entries are marked `romLicensed: false`. Public release of these titles still needs
  signed short-lived URLs (option C) or server-side emulation (option A).
- **Solo-only local-dev drivers:** `twincobr` lacks `MACHINE_SUPPORTS_SAVE`; `raiden`/`raiden2`
  are flagged save-capable in MAME but their WASM cores expose an **empty save buffer**
  (`Core.save()` throws) — a still-open anomaly (T46). All three are catalogued
  `netplayMode: "none"` / `supportsSave: false` so they cannot netplay or replay (AGENTS.md
  out-of-scope rule). `gridlee` and `twinbee` are `lockstep`; the T46 scheduler fix
  (`docs/03`) makes their snapshot-based recovery reproducible.
- **MAME licence**: GPL-2.0-or-later. Publish the source of the exact fork commit (incl. netplay patch) we serve.
- **ROM delivery**: signed short-lived URLs after login; no public listing.
- **Cheating**: server verification of scores; flag inhumanly regular input patterns.
- **Abuse**: rate limits on rooms/chat; login for leaderboard; report/mute.
- **Privacy**: P2P exposes IPs; "relay only" option forces TURN.
