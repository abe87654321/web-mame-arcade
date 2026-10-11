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
  /**
   * Invoked once per remote track the viewer subscribes. A room subscription
   * arrives **per track** (video, then audio), so the caller must accumulate
   * them; surfacing each as its own stream and replacing `srcObject` would drop
   * all but the last track.
   */
  onTrack(callback: (track: MediaStreamTrack) => void): void;
  /** Invoked once per remote track that is unsubscribed. */
  onTrackEnded(callback: (track: MediaStreamTrack) => void): void;
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

  onTrack(callback: (track: MediaStreamTrack) => void): void {
    this.room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      callback(track.mediaStreamTrack);
    });
  }

  onTrackEnded(callback: (track: MediaStreamTrack) => void): void {
    this.room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      callback(track.mediaStreamTrack);
    });
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
  const syntheticTrack = (): MediaStreamTrack | null => {
    const doc = (globalThis as { document?: Document }).document;
    if (doc && typeof doc.createElement === "function") {
      const canvas = doc.createElement("canvas");
      canvas.width = 2;
      canvas.height = 2;
      if (typeof canvas.captureStream === "function") {
        return canvas.captureStream(1).getVideoTracks()[0] ?? null;
      }
    }
    return null;
  };
  return {
    createRoom: () => {
      return {
        async connect() {},
        async disconnect() {},
        async publish() {},
        onTrack(callback) {
          // Deliver a synthetic track on the next tick so the UI flow exercises
          // the same attach path as a real track subscription.
          setTimeout(() => {
            const track = syntheticTrack();
            if (track) callback(track);
          }, 0);
        },
        onTrackEnded() {},
      };
    },
  };
}

/**
 * Choose the factory from Vite build env; the mock is dev-only (like the e2e
 * input hook), so a leaked `VITE_LIVEKIT_MODE=mock` in a production build still
 * gets the real adapter.
 */
export function liveKitFactoryFromEnv(
  env: { VITE_LIVEKIT_MODE?: string; DEV?: boolean } = (import.meta as unknown as {
    env?: { VITE_LIVEKIT_MODE?: string; DEV?: boolean };
  }).env ?? {},
): LiveKitFactory {
  return env.VITE_LIVEKIT_MODE === "mock" && env.DEV === true
    ? mockLiveKitFactory()
    : browserLiveKitFactory();
}
