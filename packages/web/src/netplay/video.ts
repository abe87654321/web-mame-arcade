/**
 * LiveKit A/V publisher/subscriber (T41). Thin, injectable wrappers over the
 * {@link LiveKitFactory} surface so the host's publish and a viewer's watch are
 * unit-tested with a fake room:
 *
 * - {@link createVideoPublisher}: the host publishes `canvas.captureStream()`
 *   plus the tapped MAME audio (see `../audio/capture.ts`).
 * - {@link createVideoSubscriber}: a viewer attaches the remote A/V stream.
 *
 * A/V is display-only: neither wrapper ever touches the core or the lockstep.
 */
import type { LiveKitFactory, VideoRoom } from "./livekit";

export interface VideoPublisherDeps {
  factory: LiveKitFactory;
  /** The shared MAME canvas (the video source). */
  canvas: { captureStream(frameRate?: number): MediaStream };
  /** The tapped MAME audio stream, or null when unavailable. */
  getAudioStream: () => MediaStream | null;
  /** Capture frame rate; default 60 (docs/04). */
  frameRate?: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface VideoPublisher {
  /** Connect and start publishing; idempotent while already publishing. */
  start(url: string, token: string): Promise<void>;
  /** Stop publishing and disconnect. */
  stop(): void;
  isPublishing(): boolean;
}

export function createVideoPublisher(deps: VideoPublisherDeps): VideoPublisher {
  const frameRate = deps.frameRate ?? 60;
  let room: VideoRoom | null = null;

  function buildStream(): MediaStream {
    const stream = deps.canvas.captureStream(frameRate);
    const audio = deps.getAudioStream();
    if (audio) {
      for (const track of audio.getAudioTracks()) stream.addTrack(track);
    }
    return stream;
  }

  return {
    async start(url: string, token: string): Promise<void> {
      if (room) return;
      const next = deps.factory.createRoom();
      try {
        await next.connect(url, token);
        await next.publish(buildStream());
        room = next;
        deps.log?.("video-publish", { url });
      } catch (error: unknown) {
        next.disconnect().catch(() => {});
        deps.log?.("video-publish-error", { error: String(error) });
      }
    },
    stop(): void {
      const current = room;
      room = null;
      current?.disconnect().catch(() => {});
    },
    isPublishing: () => room !== null,
  };
}

export interface VideoSubscriberDeps {
  factory: LiveKitFactory;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface VideoSubscriber {
  /** Connect and watch; `onStream` gets the remote stream (or null on end). */
  start(
    url: string,
    token: string,
    onStream: (stream: MediaStream | null) => void,
  ): Promise<void>;
  /** Stop watching and disconnect. */
  stop(): void;
}

export function createVideoSubscriber(deps: VideoSubscriberDeps): VideoSubscriber {
  let room: VideoRoom | null = null;

  return {
    async start(
      url: string,
      token: string,
      onStream: (stream: MediaStream | null) => void,
    ): Promise<void> {
      if (room) return;
      const next = deps.factory.createRoom();
      try {
        await next.connect(url, token);
        next.onStream(onStream);
        next.onStreamEnded(() => onStream(null));
        room = next;
        deps.log?.("video-subscribe", { url });
      } catch (error: unknown) {
        next.disconnect().catch(() => {});
        deps.log?.("video-subscribe-error", { error: String(error) });
        onStream(null);
      }
    },
    stop(): void {
      const current = room;
      room = null;
      current?.disconnect().catch(() => {});
    },
  };
}
