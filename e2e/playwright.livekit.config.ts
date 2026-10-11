import { defineConfig } from "@playwright/test";

/**
 * LiveKit A/V e2e config (T41). Two modes, selected by `WMA_LIVEKIT_E2E`:
 *
 * - default (`WMA_LIVEKIT_E2E` unset): a "basic" run. The relay is started with
 *   dummy LiveKit credentials (so it mints tokens) and Vite is built with
 *   `VITE_LIVEKIT_MODE=mock`, so the UI flow is exercised without a LiveKit
 *   server. `livekit.basic.e2e.ts` runs; the real spec skips.
 * - real (`WMA_LIVEKIT_E2E=1`): the real flow. The relay is started with the
 *   `LIVEKIT_*` you provide (e.g. the deploy compose) and Vite uses the real
 *   livekit-client; `livekit.real.e2e.ts` runs and asserts token issuance +
 *   media handshake. CI skips this (no LiveKit server).
 *
 * These specs still need the built WASM core and ROM (gitignored), so they are
 * not part of `pnpm test`/CI, matching the netplay harness (T26).
 */
const real = process.env.WMA_LIVEKIT_E2E === "1";
const livekitUrl = process.env.LIVEKIT_URL ?? "wss://livekit.invalid";
const livekitKey = process.env.LIVEKIT_API_KEY ?? "devkey";
const livekitSecret =
  process.env.LIVEKIT_API_SECRET ?? "devsecret_at_least_32_characters_long";

export default defineConfig({
  testDir: ".",
  testMatch: "**/livekit.*.e2e.ts",
  timeout: 600_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:5173",
    channel: "chromium",
    trace: "retain-on-failure",
    launchOptions: {
      args: [
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
      ],
    },
  },
  webServer: [
    {
      command:
        `WMA_RELAY_SECRET=dev LIVEKIT_URL=${livekitUrl} ` +
        `LIVEKIT_API_KEY=${livekitKey} LIVEKIT_API_SECRET=${livekitSecret} ` +
        `pnpm --filter @wma/relay start`,
      cwd: "..",
      port: 8787,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: real
        ? "pnpm --filter @wma/web dev"
        : "VITE_LIVEKIT_MODE=mock pnpm --filter @wma/web dev",
      cwd: "..",
      url: "http://localhost:5173",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
