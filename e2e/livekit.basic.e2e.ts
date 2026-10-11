/**
 * Basic LiveKit A/V UI flow (T41), always run by `test:e2e:livekit`. Vite is
 * started with `VITE_LIVEKIT_MODE=mock` (see playwright.livekit.config.ts), so
 * the browser uses a fake LiveKit room that delivers a synthetic track
 * immediately: this exercises join / share / watch / stop / leave and the video
 * UI without a LiveKit server. The media handshake is covered by the real spec.
 */
import { test } from "@playwright/test";
import { missingAssets, runVideoFlow } from "./support/livekit-flow";

test.describe("LiveKit A/V UI (mock, T41)", () => {
  test.skip(
    process.env.WMA_LIVEKIT_E2E === "1",
    "real mode runs livekit.real.e2e.ts",
  );
  test.skip(missingAssets() !== null, missingAssets() ?? "");

  test("host shares, a viewer watches, the host stops, the viewer leaves", async ({
    browser,
  }) => {
    await runVideoFlow(browser);
  });
});
