import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, encodeInput } from "@wma/protocol";
import type { Core, FrameInputs } from "../core/types";
import { createMatch, type LobbyState, type MatchStatus } from "./match";
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

function roomState(self: number | null, slots: number[], ready: number[] = []) {
  return {
    t: "room.state",
    room: "r",
    self,
    players: slots.map((slot) => ({ slot, name: `p${slot}`, ready: ready.includes(slot) })),
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
  const lobbies: LobbyState[] = [];
  const match = createMatch({
    core,
    config,
    socketFactory: fakeSocketFactory(socket),
    factory: fakeRtcFactory([pc]),
    now: () => 0,
    inputDelay,
    onStatus: (status) => statuses.push(status),
    onLobby: (lobby) => lobbies.push(lobby),
  });
  socket.open();
  return { socket, pc, core, match, statuses, lobbies };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("createMatch", () => {
  it("lets the lowest-slot host start once peers are ready", async () => {
    const { socket, match } = harness();
    await flush();

    socket.emitMessage(JSON.stringify(roomState(0, [0, 1], [1])));
    await flush();

    expect(match.isHost()).toBe(true);
    expect(match.canStart()).toBe(true);
    expect(socket.sent.some((m) => String(m).includes("game.start"))).toBe(false);

    expect(match.start()).toBe(true);
    expect(socket.sent).toContain(
      JSON.stringify({ t: "game.start", startFrame: 0, inputDelay: 2 }),
    );
    expect(match.status()).toBe("waiting-for-peers");
    match.close();
  });

  it("lets a lone player start a solo netplay game", async () => {
    const { socket, match } = harness();
    await flush();

    socket.emitMessage(JSON.stringify(roomState(0, [0])));
    await flush();

    expect(match.canStart()).toBe(true);
    expect(match.start()).toBe(true);
    match.close();
  });

  it("does not let a non-host start", async () => {
    const { socket, match } = harness();
    await flush();

    socket.emitMessage(JSON.stringify(roomState(1, [0, 1])));
    await flush();

    expect(match.isHost()).toBe(false);
    expect(match.start()).toBe(false);
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

  it("exposes a lobby snapshot with names, host/self and readiness", async () => {
    const { socket, match } = harness();
    await flush();

    socket.emitMessage(JSON.stringify(roomState(0, [0, 1], [1])));
    await flush();

    const lobby = match.lobby();
    expect(lobby.roomStatus).toBe("waiting");
    expect(lobby.isHost).toBe(true);
    expect(lobby.players).toEqual([
      { slot: 0, name: "p0", host: true, self: true, connected: true, ready: false },
      { slot: 1, name: "p1", host: false, self: false, connected: true, ready: true },
    ]);
    match.close();
  });

  it("emits onLobby on room.state and channel open", async () => {
    const { socket, lobbies } = harness();
    await flush();

    socket.emitMessage(JSON.stringify(roomState(0, [0, 1])));
    await flush();

    expect(lobbies.length).toBeGreaterThan(0);
    expect(lobbies.at(-1)?.players).toHaveLength(2);
  });

  it("gates canStart on host, peers connected and all non-host ready", async () => {
    const { socket, match } = harness();
    await flush();
    socket.emitMessage(JSON.stringify(roomState(0, [0, 1])));
    await flush();

    // Connected, but slot 1 has not readied.
    expect(match.canStart()).toBe(false);
    expect(match.lobby().canStart).toBe(false);

    socket.emitMessage(JSON.stringify({ t: "player.ready", ready: true, player: 1 }));
    await flush();

    expect(match.canStart()).toBe(true);
    expect(match.lobby().canStart).toBe(true);
    match.close();
  });

  it("does not gate a lone host on readiness", async () => {
    const { socket, match } = harness();
    await flush();
    socket.emitMessage(JSON.stringify(roomState(0, [0])));
    await flush();

    expect(match.canStart()).toBe(true);
    match.close();
  });

  it("setReady sends player.ready through the relay", async () => {
    const { socket, match } = harness();
    await flush();
    socket.emitMessage(JSON.stringify(roomState(0, [0, 1])));
    await flush();

    expect(match.setReady(true)).toBe(true);
    expect(socket.sent).toContain(JSON.stringify({ t: "player.ready", ready: true }));
    match.close();
  });

  it("marks the lobby disconnected when the relay socket closes", async () => {
    const { socket, match } = harness();
    await flush();
    socket.emitMessage(JSON.stringify(roomState(0, [0, 1])));
    await flush();

    socket.close();

    expect(match.lobby().roomStatus).toBe("disconnected");
    expect(match.setReady(true)).toBe(false);
    match.close();
  });
});
