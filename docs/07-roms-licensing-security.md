# 07 · ROMs, licensing, security

- **ROM rights**: option C sends ROMs to browsers = distribution. Only licensed, freely released, or homebrew titles
  online; others via option A (server-side). Get legal advice for the countries served.
- **Development/CI ROMs**: use the free ROMs MAME publishes at https://www.mamedev.org/roms/ so tests are legal to share.
- **Local dev with commercial ROMs** (`twinbee`, `raiden`, `raiden2`, `twincobr`): the zips live only in the
  gitignored `roms/` and are **never committed** (no zips, no builds). The Vite dev server serves
  `/roms/<driver>.zip` from that directory (see `packages/web/vite.config.ts`), and their
  `games.json` entries are marked `romLicensed: false`. Public release of these titles still needs
  signed short-lived URLs (option C) or server-side emulation (option A).
- **`twincobr` is solo-only:** its driver lacks `MACHINE_SUPPORTS_SAVE`, so it cannot netplay or
  replay (AGENTS.md out-of-scope rule); its `games.json` entry is `netplayMode: "none"` /
  `supportsSave: false`. The other local-dev drivers are flagged save-capable in MAME
  (`MACHINE_SUPPORTS_SAVE`) and catalogued `lockstep`, but snapshot-based recovery is currently
  not reproducible and is under investigation (T46, docs/03).
- **MAME licence**: GPL-2.0-or-later. Publish the source of the exact fork commit (incl. netplay patch) we serve.
- **ROM delivery**: signed short-lived URLs after login; no public listing.
- **Cheating**: server verification of scores; flag inhumanly regular input patterns.
- **Abuse**: rate limits on rooms/chat; login for leaderboard; report/mute.
- **Privacy**: P2P exposes IPs; "relay only" option forces TURN.
