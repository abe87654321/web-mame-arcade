import { defineConfig } from "@playwright/test";

/**
 * Netplay e2e harness config (T26). Two web servers come up with the suite: the
 * relay (started with the dev secret the harness mints tokens for) and the Vite
 * dev server. `cwd: ".."` runs the filtered pnpm commands from the repo root.
 *
 * These specs are NOT part of `pnpm test`/CI: they need the built WASM core and
 * the ROM, both gitignored. Run locally with `pnpm --filter @wma/e2e test:e2e`.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.e2e.ts",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: "http://localhost:5173", trace: "retain-on-failure" },
  webServer: [
    {
      command: "WMA_RELAY_SECRET=dev pnpm --filter @wma/relay start",
      cwd: "..",
      port: 8787,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "pnpm --filter @wma/web dev",
      cwd: "..",
      url: "http://localhost:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
