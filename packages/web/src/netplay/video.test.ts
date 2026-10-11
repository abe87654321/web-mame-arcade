import { describe, expect, it, vi } from "vitest";
import type { LiveKitFactory, VideoRoom } from "./livekit";
import { createVideoPublisher, createVideoSubscriber } from "./video";

class FakeMediaStream {
  private readonly tracks: MediaStreamTrack[] = [];
  constructor(tracks: MediaStreamTrack[] = []) {
    this.tracks.push(...tracks);
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
  streamCb: ((stream: MediaStream) => void) | null = null;
  endCb: (() => void) | null = null;
  onStream(callback: (stream: MediaStream) => void): void {
    this.streamCb = callback;
  }
  onStreamEnded(callback: () => void): void {
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
  it("connects and forwards the remote stream and its end", async () => {
    const { f, rooms } = factory();
    const subscriber = createVideoSubscriber({ factory: f });
    const onStream = vi.fn();
    await subscriber.start("u", "t", onStream);
    expect(rooms[0]!.connect).toHaveBeenCalled();
    const remote = asStream(new FakeMediaStream());
    rooms[0]!.streamCb?.(remote);
    expect(onStream).toHaveBeenCalledWith(remote);
    rooms[0]!.endCb?.();
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
