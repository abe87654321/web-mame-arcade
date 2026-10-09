import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, encodeInput } from "@wma/protocol";
import type { Core, FrameInputs } from "../core/types";
import { createMatch, type MatchStatus } from "./match";
import {
  FakePeerConnection,
  FakeWebSocket,
  fakeRtcFactory,
  fakeSocketFactory,
} from "./test-fakes";

function fakeCore() {
  const steps: { frame: number; inputs: FrameInputs }[] = [];
  return {
    steps,
    load: vi.fn(async () => {}),
    step(frame: number, inputs: FrameInputs) {
      steps.push({ frame, inputs });
    },
    save: vi.fn(),
    hash: vi.fn(),
    readScore: vi.fn(),
    reset: vi.fn(),
    destroy: vi.fn(),
  } as unknown as Core & { steps: { frame: number; inputs: FrameInputs }[] };
}

function roomState(self: number | null, slots: number[]) {
  return {
    t: "room.state",
    room: "r",
    self,
    players: slots.map((slot) => ({ slot, name: `p${slot}` })),
    game: null,
    coreHash: null,
    romHash: null,
    dips: {},
    status: "waiting",
  };
}

function peerPacket(player: number, firstFrame: number, inputs: number[]): ArrayBuffer {
  const bytes = encodeInput({
    version: PROTOCOL_VERSION,
    player,
    ackFrame: 0,
    firstFrame,
    inputs,
  });
  return bytes.buffer as ArrayBuffer;
}

const config = {
  relayUrl: "ws://relay.test/ws",
  token: "jwt",
  room: "r",
  role: "player" as const,
  iceServers: [],
};

function harness(inputDelay = 2) {
  const socket = new FakeWebSocket();
  const pc = new FakePeerConnection();
  const core = fakeCore();
  const statuses: MatchStatus[] = [];
  const match = createMatch({
    core,
    config,
    socketFactory: fakeSocketFactory(socket),
    factory: fakeRtcFactory([pc]),
    now: () => 0,
    inputDelay,
    onStatus: (status) => statuses.push(status),
  });
  socket.open();
  return { socket, pc, core, match, statuses };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("createMatch", () => {
  it("has the lowest-slot host send game.start once peers are ready", async () => {
    const { socket, match } = harness();
    await flush();

    socket.emitMessage(JSON.stringify(roomState(0, [0, 1])));
    await flush();

    expect(socket.sent).toContain(
      JSON.stringify({ t: "game.start", startFrame: 0, inputDelay: 2 }),
    );
    expect(match.status()).toBe("waiting-for-peers");
    match.close();
  });

  it("does not have a non-host send game.start", async () => {
    const { socket, match } = harness();
    await flush();

    socket.emitMessage(JSON.stringify(roomState(1, [0, 1])));
    await flush();

    expect(socket.sent.some((m) => String(m).includes("game.start"))).toBe(false);
    match.close();
  });

  it("steps the lockstep after game.start and routes inputs both ways", async () => {
    const { socket, pc, core, match } = harness(0);
    await flush();
    socket.emitMessage(JSON.stringify(roomState(0, [0, 1])));
    await flush();
    socket.emitMessage(JSON.stringify({ t: "game.start", startFrame: 0, inputDelay: 0 }));
    await flush();

    // Peer 1's frame 0 arrives over the relay as a binary input packet.
    socket.emitMessage(peerPacket(1, 0, [0x02]));
    match.tick(0x01);

    expect(core.steps).toEqual([{ frame: 0, inputs: [0x01, 0x02, 0, 0] }]);
    // The local input went out over the data channel and to the relay.
    expect(pc.dataChannels[0]?.sent.at(-1)).toBeInstanceOf(ArrayBuffer);
    expect(
      socket.sent.some((m) => m instanceof ArrayBuffer),
    ).toBe(true);
    match.close();
  });

  it("holds game.start until the core has loaded", async () => {
    const socket = new FakeWebSocket();
    const pc = new FakePeerConnection();
    const core = fakeCore();
    let resolveLoad: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      resolveLoad = resolve;
    });
    (core as unknown as { load: () => Promise<void> }).load = vi.fn(() => gate);
    const statuses: MatchStatus[] = [];
    const match = createMatch({
      core,
      config,
      socketFactory: fakeSocketFactory(socket),
      factory: fakeRtcFactory([pc]),
      now: () => 0,
      inputDelay: 0,
      onStatus: (status) => statuses.push(status),
    });
    socket.open();
    socket.emitMessage(JSON.stringify(roomState(0, [0, 1])));
    await flush();
    socket.emitMessage(JSON.stringify({ t: "game.start", startFrame: 0, inputDelay: 0 }));
    await flush();

    expect(statuses).not.toContain("running");

    resolveLoad();
    await flush();
    expect(match.status()).toBe("running");
    match.close();
  });

  it("closes the session and socket", async () => {
    const { socket, match } = harness();
    await flush();

    match.close();

    expect(socket.closes).toBe(1);
  });
});
