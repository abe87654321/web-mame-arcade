/**
 * Real LiveKit A/V flow (T41). Runs only with `WMA_LIVEKIT_E2E=1`, against a
 * LiveKit server you provide via `LIVEKIT_URL` / `LIVEKIT_API_KEY` /
 * `LIVEKIT_API_SECRET` (e.g. `docker compose -f deploy/docker-compose.yml up -d
 * livekit`). Unlike the mock spec, the viewer's video badge only appears if the
 * relay-issued token is accepted and the canvas+audio tracks actually reach the
 * viewer, so this asserts token issuance + media handshake.
 *
 * CI skips this (no LiveKit server); it is a local/staging check.
 */
import { test } from "@playwright/test";
import { missingAssets, runVideoFlow } from "./support/livekit-flow";

test.describe("LiveKit A/V (real, T41)", () => {
  test.skip(
    process.env.WMA_LIVEKIT_E2E !== "1",
    "set WMA_LIVEKIT_E2E=1 with LIVEKIT_* to run the real handshake",
  );
  test.skip(missingAssets() !== null, missingAssets() ?? "");

  test("the canvas+audio track reaches a viewer through LiveKit", async ({
    browser,
  }) => {
    await runVideoFlow(browser);
  });
});
