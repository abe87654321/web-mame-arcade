import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { liveKitFactoryFromEnv, mockLiveKitFactory } from "./livekit";

/**
 * `liveKitFactoryFromEnv` is security-relevant (T41): the mock delivers a
 * synthetic track instead of real A/V, so it must be selected only when
 * `VITE_LIVEKIT_MODE=mock` AND `DEV` — a leaked build env in production must
 * still get the real adapter.
 */
const fakeTrack = { id: "synthetic" } as unknown as MediaStreamTrack;

describe("LiveKit factory selection (T41)", () => {
  const originalDocument = (globalThis as { document?: unknown }).document;

  beforeEach(() => {
    // A minimal document so the mock's synthetic canvas yields a track.
    (globalThis as { document?: unknown }).document = {
      createElement: () => ({
        width: 0,
        height: 0,
        captureStream: () => ({ getVideoTracks: () => [fakeTrack] }),
      }),
    };
  });

  afterEach(() => {
    (globalThis as { document?: unknown }).document = originalDocument;
  });

  const emitsTrack = async (room: {
    onTrack: (cb: (track: MediaStreamTrack) => void) => void;
  }): Promise<boolean> => {
    const onTrack = vi.fn();
    room.onTrack(onTrack);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return onTrack.mock.calls.length > 0;
  };

  it("emits a synthetic track only when mode=mock and DEV", async () => {
    const room = liveKitFactoryFromEnv({
      VITE_LIVEKIT_MODE: "mock",
      DEV: true,
    }).createRoom();
    expect(await emitsTrack(room)).toBe(true);
  });

  it("uses the real adapter when mock mode leaks outside DEV", async () => {
    const room = liveKitFactoryFromEnv({
      VITE_LIVEKIT_MODE: "mock",
      DEV: false,
    }).createRoom();
    // The real room registers a LiveKit listener that never fires without a
    // server, so no synthetic track is delivered.
    expect(await emitsTrack(room)).toBe(false);
  });

  it("mockLiveKitFactory publishes no-op and disconnects cleanly", async () => {
    const room = mockLiveKitFactory().createRoom();
    await expect(room.connect("wss://lk", "token")).resolves.toBeUndefined();
    await expect(room.publish({ getTracks: () => [] } as unknown as MediaStream)).resolves.toBeUndefined();
    await expect(room.disconnect()).resolves.toBeUndefined();
  });
});
