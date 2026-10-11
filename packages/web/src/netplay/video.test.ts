import { describe, expect, it, vi } from "vitest";
import type { LiveKitFactory, VideoRoom } from "./livekit";
import { createVideoPublisher, createVideoSubscriber } from "./video";

class FakeMediaStream {
  private tracks: MediaStreamTrack[] = [];
  constructor(tracks: MediaStreamTrack[] = []) {
    this.tracks = [...tracks];
  }
  getTracks(): MediaStreamTrack[] {
    return [...this.tracks];
  }
  getAudioTracks(): MediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === "audio");
  }
  addTrack(track: MediaStreamTrack): void {
    this.tracks.push(track);
  }
  removeTrack(track: MediaStreamTrack): void {
    this.tracks = this.tracks.filter((t) => t !== track);
  }
}

function asStream(stream: FakeMediaStream): MediaStream {
  return stream as unknown as MediaStream;
}

function fakeTrack(id: string, kind: MediaStreamTrack["kind"] = "audio"): MediaStreamTrack {
  return { id, kind } as unknown as MediaStreamTrack;
}

class FakeRoom implements VideoRoom {
  readonly connect = vi.fn(async (url: string, token: string) => {
    void url;
    void token;
  });
  readonly disconnect = vi.fn(async () => {});
  readonly publish = vi.fn(async (stream: MediaStream) => {
    void stream;
  });
  trackCb: ((track: MediaStreamTrack) => void) | null = null;
  endCb: ((track: MediaStreamTrack) => void) | null = null;
  onTrack(callback: (track: MediaStreamTrack) => void): void {
    this.trackCb = callback;
  }
  onTrackEnded(callback: (track: MediaStreamTrack) => void): void {
    this.endCb = callback;
  }
}

function factory() {
  const rooms: FakeRoom[] = [];
  const f: LiveKitFactory = {
    createRoom: () => {
      const room = new FakeRoom();
      rooms.push(room);
      return room;
    },
  };
  return { f, rooms };
}

describe("createVideoPublisher", () => {
  it("connects, publishes canvas video + tapped audio", async () => {
    const { f, rooms } = factory();
    const canvasStream = new FakeMediaStream();
    const canvas = { captureStream: () => asStream(canvasStream) };
    const audioTrack = fakeTrack("a1");
    const audioStream = new FakeMediaStream([audioTrack]);
    const publisher = createVideoPublisher({
      factory: f,
      canvas,
      getAudioStream: () => asStream(audioStream),
    });
    await publisher.start("wss://lk", "token");
    expect(publisher.isPublishing()).toBe(true);
    expect(rooms[0]!.connect).toHaveBeenCalledWith("wss://lk", "token");
    expect(rooms[0]!.publish).toHaveBeenCalledTimes(1);
    // The tapped audio track was added to the captured canvas stream.
    expect(canvasStream.getAudioTracks()).toContain(audioTrack);
    expect(rooms[0]!.publish.mock.calls[0]![0]).toBe(asStream(canvasStream));
  });

  it("is idempotent while publishing and disconnects on stop", async () => {
    const { f, rooms } = factory();
    const publisher = createVideoPublisher({
      factory: f,
      canvas: { captureStream: () => asStream(new FakeMediaStream()) },
      getAudioStream: () => null,
    });
    await publisher.start("u", "t");
    await publisher.start("u", "t");
    expect(rooms).toHaveLength(1);
    publisher.stop();
    expect(rooms[0]!.disconnect).toHaveBeenCalled();
    expect(publisher.isPublishing()).toBe(false);
  });

  it("cleans up and logs when connect fails", async () => {
    const rooms: FakeRoom[] = [];
    const failing: LiveKitFactory = {
      createRoom: () => {
        const room = new FakeRoom();
        room.connect.mockRejectedValueOnce(new Error("no route"));
        rooms.push(room);
        return room;
      },
    };
    const log = vi.fn();
    const publisher = createVideoPublisher({
      factory: failing,
      canvas: { captureStream: () => asStream(new FakeMediaStream()) },
      getAudioStream: () => null,
      log,
    });
    await publisher.start("u", "t");
    expect(rooms[0]!.disconnect).toHaveBeenCalled();
    expect(publisher.isPublishing()).toBe(false);
    expect(log).toHaveBeenCalledWith("video-publish-error", expect.anything());
  });
});

describe("createVideoSubscriber", () => {
  const FakeStream = FakeMediaStream as unknown as typeof MediaStream;

  it("accumulates per-track subscriptions into one stream", async () => {
    const { f, rooms } = factory();
    const subscriber = createVideoSubscriber({
      factory: f,
      MediaStream: FakeStream,
    });
    const onStream = vi.fn();
    await subscriber.start("u", "t", onStream);
    expect(rooms[0]!.connect).toHaveBeenCalled();

    // LiveKit subscribes video then audio as separate tracks.
    const video = fakeTrack("v1", "video");
    const audio = fakeTrack("a1", "audio");
    rooms[0]!.trackCb?.(video);
    const afterVideo = onStream.mock.calls.at(-1)![0] as FakeMediaStream;
    expect(afterVideo.getTracks()).toEqual([video]);

    rooms[0]!.trackCb?.(audio);
    const afterAudio = onStream.mock.calls.at(-1)![0] as FakeMediaStream;
    expect(afterAudio).toBe(afterVideo);
    expect(afterAudio.getTracks()).toEqual([video, audio]);

    // Removing one track does not end the stream; removing the last does.
    rooms[0]!.endCb?.(video);
    expect(onStream).toHaveBeenLastCalledWith(afterAudio);
    expect(afterAudio.getTracks()).toEqual([audio]);
    rooms[0]!.endCb?.(audio);
    expect(onStream).toHaveBeenLastCalledWith(null);

    subscriber.stop();
    expect(rooms[0]!.disconnect).toHaveBeenCalled();
  });

  it("reports null when the connection fails", async () => {
    const failing: LiveKitFactory = {
      createRoom: () => {
        const room = new FakeRoom();
        room.connect.mockRejectedValueOnce(new Error("nope"));
        return room;
      },
    };
    const onStream = vi.fn();
    await createVideoSubscriber({ factory: failing }).start("u", "t", onStream);
    expect(onStream).toHaveBeenCalledWith(null);
  });
});
