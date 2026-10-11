import { describe, expect, it, vi } from "vitest";
import { encodeInput } from "@wma/protocol";
import type { Core, FrameInputs } from "../core/types";
import { FakeWebSocket, fakeSocketFactory } from "./test-fakes";
import { createViewer, type ViewerStatus } from "./viewer";

function fakeCore() {
  const steps: { frame: number; inputs: FrameInputs }[] = [];
  return {
    steps,
    load: vi.fn(),
    step(frame: number, inputs: FrameInputs) {
      steps.push({ frame, inputs });
    },
    save: vi.fn(() => new Uint8Array()),
    hash: vi.fn(() => 0),
    readScore: vi.fn(),
    reset: vi.fn(),
    destroy: vi.fn(),
  } as unknown as Core & { steps: { frame: number; inputs: FrameInputs }[] };
}

const config = { relayUrl: "ws://relay.test/ws", token: "jwt", room: "r" };

function viewerState(snapshot: unknown = null) {
  return {
    t: "viewer.state",
    room: "r",
    driver: "gridlee",
    coreHash: "a".repeat(64),
    mameCommit: "b".repeat(40),
    romHash: "c".repeat(64),
    dips: {},
    startFrame: 0,
    inputDelay: 2,
    players: [
      { slot: 0, name: "p0" },
      { slot: 1, name: "p1" },
    ],
    snapshot,
  };
}

function bytes(player: number, firstFrame: number, inputs: number[]): ArrayBuffer {
  return encodeInput({ version: 1, player, ackFrame: 0, firstFrame, inputs })
    .buffer as ArrayBuffer;
}

function harness(overrides: Partial<Parameters<typeof createViewer>[0]> = {}) {
  const socket = new FakeWebSocket();
  const core = fakeCore();
  const statuses: ViewerStatus[] = [];
  const viewer = createViewer({
    core,
    config,
    socketFactory: fakeSocketFactory(socket),
    now: () => 0,
    bufferMs: 3000,
    frameMs: 1000,
    onStatus: (status) => statuses.push(status),
    ...overrides,
  });
  socket.open();
  return { socket, core, viewer, statuses };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("createViewer", () => {
  it("joins the relay as a viewer", () => {
    const { socket } = harness();
    expect(socket.sent).toContain(
      JSON.stringify({ t: "room.join", room: "r", role: "viewer", token: "jwt" }),
    );
  });

  it("boots from the start when the host has no snapshot yet", async () => {
    const { socket, core, viewer } = harness();
    await flush();
    socket.emitMessage(JSON.stringify(viewerState(null)));
    await flush();

    expect(viewer.status()).toBe("buffering");
    // Frame 2: both players, mask 0x10. bufferFrames = 3 -> play from liveFrame-3.
    socket.emitMessage(bytes(0, 0, [0x10, 0x10, 0x10, 0x10, 0x10, 0x10]));
    socket.emitMessage(bytes(1, 0, [0x10, 0x10, 0x10, 0x10, 0x10, 0x10]));

    viewer.tick(0); // start: playFrame = 5 - 3 = 2
    viewer.tick(1000); // step frame 2
    expect(core.steps).toEqual([{ frame: 2, inputs: [0x10, 0x10, 0, 0] }]);
    expect(viewer.status()).toBe("playing");
    expect(viewer.frame()).toBe(3);
  });

  it("loads the host snapshot and resumes just after it", async () => {
    const snapshotBytes = new Uint8Array([7, 7, 7]);
    const fetchSnapshot = vi.fn(async () => snapshotBytes);
    const { socket, core, viewer } = harness({ fetchSnapshot });
    await flush();
    socket.emitMessage(
      JSON.stringify(
        viewerState({ frame: 120, blobUrl: "http://relay/rooms/r/snapshot/1" }),
      ),
    );
    await flush();

    expect(fetchSnapshot).toHaveBeenCalledWith("http://relay/rooms/r/snapshot/1");
    expect(core.load).toHaveBeenCalledWith(snapshotBytes, 120);

    socket.emitMessage(bytes(0, 121, [0x20, 0x20, 0x20, 0x20, 0x20, 0x20]));
    socket.emitMessage(bytes(1, 121, [0x20, 0x20, 0x20, 0x20, 0x20, 0x20]));
    viewer.tick(0);
    viewer.tick(1000);
    expect(core.steps[0]?.frame).toBeGreaterThanOrEqual(121);
  });

  it("reports connecting, then ended when the room ends", async () => {
    const { socket, viewer, statuses } = harness();
    expect(viewer.status()).toBe("connecting");
    await flush();
    socket.emitMessage(
      JSON.stringify({
        t: "room.state",
        room: "r",
        self: null,
        players: [{ slot: 0, name: "p0", ready: false }],
        game: "gridlee",
        coreHash: "a".repeat(64),
        romHash: "c".repeat(64),
        dips: {},
        status: "ended",
      }),
    );
    await flush();
    expect(viewer.status()).toBe("ended");
    expect(statuses).toContain("ended");
  });

  it("reports disconnected when the socket closes", async () => {
    const { socket, viewer } = harness();
    await flush();
    socket.close();
    expect(viewer.status()).toBe("disconnected");
  });
});
