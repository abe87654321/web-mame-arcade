/**
 * LiveKit wiring for the A/V fallback (T41). The rest of netplay depends only
 * on the small {@link LiveKitFactory}/{@link VideoRoom} surface, so it is tested
 * without the real `livekit-client`; the browser adapter wraps the SDK and
 * `mockLiveKitFactory` (selected by `VITE_LIVEKIT_MODE=mock` in the e2e build)
 * lets the always-on Playwright suite exercise the UI without a LiveKit server.
 *
 * Join credentials (`url`/`token`) always come from the relay's `livekit.access`
 * message; nothing here decides policy.
 */
import {
  Room,
  RoomEvent,
  type RemoteTrack,
} from "livekit-client";

/** The room members the app uses; a fake backs it in tests. */
export interface VideoRoom {
  connect(url: string, token: string): Promise<void>;
  disconnect(): Promise<void>;
  /** Publish every track of `stream` (the host's canvas + MAME audio). */
  publish(stream: MediaStream): Promise<void>;
  /** Invoked with a remote A/V stream whenever a track is subscribed. */
  onStream(callback: (stream: MediaStream) => void): void;
  /** Invoked when the last remote track is gone. */
  onStreamEnded(callback: () => void): void;
}

export interface LiveKitFactory {
  createRoom(): VideoRoom;
}

class BrowserVideoRoom implements VideoRoom {
  private readonly room = new Room();

  async connect(url: string, token: string): Promise<void> {
    await this.room.connect(url, token);
  }

  async disconnect(): Promise<void> {
    await this.room.disconnect();
  }

  async publish(stream: MediaStream): Promise<void> {
    for (const track of stream.getTracks()) {
      await this.room.localParticipant.publishTrack(track);
    }
  }

  onStream(callback: (stream: MediaStream) => void): void {
    this.room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      callback(new MediaStream([track.mediaStreamTrack]));
    });
  }

  onStreamEnded(callback: () => void): void {
    this.room.on(RoomEvent.TrackUnsubscribed, () => callback());
  }
}

/** The real adapter: one LiveKit `Room` per call. */
export function browserLiveKitFactory(): LiveKitFactory {
  return { createRoom: () => new BrowserVideoRoom() };
}

/**
 * e2e-only fake (T41): connect/publish are no-ops and a subscriber immediately
 * receives a synthetic one-frame canvas stream, so the always-on Playwright
 * suite can drive the A/V UI without a LiveKit server. Never selected in prod
 * (see `liveKitFactoryFromEnv`).
 */
export function mockLiveKitFactory(): LiveKitFactory {
  const syntheticStream = (): MediaStream => {
    const doc = (globalThis as { document?: Document }).document;
    if (doc && typeof doc.createElement === "function") {
      const canvas = doc.createElement("canvas");
      canvas.width = 2;
      canvas.height = 2;
      if (typeof canvas.captureStream === "function") return canvas.captureStream(1);
    }
    return new MediaStream();
  };
  return {
    createRoom: () => {
      let streamCallback: ((stream: MediaStream) => void) | null = null;
      return {
        async connect() {},
        async disconnect() {},
        async publish() {},
        onStream(callback) {
          streamCallback = callback;
          // Deliver a synthetic track on the next tick so the UI flow exercises
          // the same attach path as a real track subscription.
          setTimeout(() => streamCallback?.(syntheticStream()), 0);
        },
        onStreamEnded() {
          streamCallback = null;
        },
      };
    },
  };
}

/** Choose the factory from Vite build env; defaults to the real one. */
export function liveKitFactoryFromEnv(
  env: { VITE_LIVEKIT_MODE?: string } = (import.meta as unknown as {
    env?: { VITE_LIVEKIT_MODE?: string };
  }).env ?? {},
): LiveKitFactory {
  return env.VITE_LIVEKIT_MODE === "mock"
    ? mockLiveKitFactory()
    : browserLiveKitFactory();
}
