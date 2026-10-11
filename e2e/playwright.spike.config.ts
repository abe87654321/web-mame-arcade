import { defineConfig } from "@playwright/test";

/**
 * Spike-only Playwright config (T28). The save/load/hash spike times the WASM
 * core only, so it needs neither the relay nor a netplay match: a room route
 * arms the frozen core, and a `?token=` is enough to define the netplay env.
 * It reuses a running Vite dev server (so it can run alongside a local dev
 * setup) and starts none itself if 5173 is already up.
 *
 * Run: pnpm --filter @wma/e2e test:spike
 */
export default defineConfig({
  testDir: ".",
  testMatch: "**/spike.e2e.ts",
  timeout: 600_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
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
      command: "pnpm --filter @wma/web dev",
      cwd: "..",
      url: "http://localhost:5173",
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
