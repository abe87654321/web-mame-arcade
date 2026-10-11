import { describe, expect, it } from "vitest";
import { installAudioCapture, type AudioCaptureEnv } from "./capture";

class FakeMediaStream {
  readonly tracks: unknown[] = [];
  constructor(tracks: unknown[] = []) {
    this.tracks.push(...tracks);
  }
  addTrack(track: unknown): void {
    this.tracks.push(track);
  }
}

let trackSeq = 0;

interface FakeDest {
  stream: { getAudioTracks: () => unknown[] };
}

function makeEnv() {
  const calls: { node: unknown; destination: unknown }[] = [];
  const destinations: FakeDest[] = [];
  const proto = {
    connect(this: { context: unknown }, destination: unknown) {
      calls.push({ node: this, destination });
      return this;
    },
  };
  function makeContext() {
    const context = {
      destination: { id: "destination" },
      createMediaStreamDestination(): FakeDest {
        const track = { kind: "audio", id: `t${trackSeq++}` };
        const dest: FakeDest = { stream: { getAudioTracks: () => [track] } };
        destinations.push(dest);
        return dest;
      },
    };
    return context;
  }
  const env = {
    AudioNode: { prototype: proto },
    MediaStream: FakeMediaStream,
  } as unknown as AudioCaptureEnv;
  return { env, proto, makeContext, calls, destinations };
}

function nodeFor(proto: object, context: unknown) {
  return Object.assign(Object.create(proto), { context }) as {
    connect(destination: unknown): void;
  };
}

describe("installAudioCapture", () => {
  it("returns null until a node is connected to its context destination", () => {
    const { env, proto, makeContext } = makeEnv();
    const capture = installAudioCapture(env);
    const context = makeContext();
    const node = nodeFor(proto, context);
    expect(capture.getAudioStream()).toBeNull();
    // Connecting somewhere that is not `destination` captures nothing.
    node.connect({ id: "elsewhere" });
    expect(capture.getAudioStream()).toBeNull();
  });

  it("taps audio connected to the context destination", () => {
    const { env, proto, makeContext, destinations } = makeEnv();
    const capture = installAudioCapture(env);
    const context = makeContext();
    const node = nodeFor(proto, context);
    node.connect(context.destination);
    expect(destinations).toHaveLength(1);
    expect(capture.getAudioStream()).toBe(destinations[0]!.stream);
  });

  it("merges tracks from several contexts", () => {
    const { env, proto, makeContext } = makeEnv();
    const capture = installAudioCapture(env);
    for (let i = 0; i < 2; i++) {
      const context = makeContext();
      nodeFor(proto, context).connect(context.destination);
    }
    const stream = capture.getAudioStream() as unknown as FakeMediaStream;
    expect(stream).toBeInstanceOf(FakeMediaStream);
    expect(stream.tracks).toHaveLength(2);
  });

  it("is idempotent and dispose restores the original connect", () => {
    const { env, proto, makeContext, calls } = makeEnv();
    const original = proto.connect;
    const first = installAudioCapture(env);
    const second = installAudioCapture(env);
    expect(second).toBe(first);
    expect(proto.connect).not.toBe(original);
    const context = makeContext();
    nodeFor(proto, context).connect(context.destination);
    // One original connect + one tap connect to the media destination.
    expect(calls).toHaveLength(2);
    first.dispose();
    expect(proto.connect).toBe(original);
  });

  it("degrades to a no-op without the Web Audio APIs", () => {
    const capture = installAudioCapture({} as AudioCaptureEnv);
    expect(capture.getAudioStream()).toBeNull();
    expect(() => capture.dispose()).not.toThrow();
  });
});
