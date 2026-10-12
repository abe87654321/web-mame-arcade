import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, encodeInput } from "@wma/protocol";
import type { Core, FrameInputs } from "../core/types";
import { createMatch, type LobbyState, type MatchDeps, type MatchStatus } from "./match";
import type { MetricsSnapshot } from "./metrics";
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
    save: vi.fn(() => new Uint8Array([9, 9])),
    hash: vi.fn(() => 0xabc),
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

const GAME = {
  driver: "gridlee",
  coreHash: "a".repeat(64),
  mameCommit: "b".repeat(40),
  romHash: "c".repeat(64),
  dips: {},
};

/** Parsed JSON messages the fake socket sent (binary packets excluded). */
function jsonSent(socket: FakeWebSocket): Record<string, unknown>[] {
  return socket.sent
    .filter((m): m is string => typeof m === "string")
    .map((m) => JSON.parse(m) as Record<string, unknown>);
}

function harness(inputDelay?: number, overrides: Partial<MatchDeps> = {}) {
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
    // Omit when undefined so the adaptive path runs (defaults to 2 with no RTT).
    ...(inputDelay === undefined ? {} : { inputDelay }),
    onStatus: (status) => statuses.push(status),
    onLobby: (lobby) => lobbies.push(lobby),
    ...overrides,
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

  it("feeds each slot its own scripted stream at the scheduled frame", async () => {
    const { socket, core, match } = harness(2, {
      inputScript: (slot, f) =>
        slot === 0 && f === 2 ? 0x08 : slot === 1 && f === 2 ? 0x04 : 0,
    });
    await flush();

    socket.emitMessage(JSON.stringify(roomState(0, [0])));
    await flush();
    socket.emitMessage(JSON.stringify({ t: "game.start", startFrame: 0, inputDelay: 2 }));
    await flush();

    // The wall-clock sampled mask is ignored when a script is present.
    match.tick(0xffff);

    expect(core.steps.map((s) => s.frame)).toEqual([0, 1, 2]);
    expect(core.steps[2]?.inputs).toEqual([0x08, 0, 0, 0]);
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

  it("reports connection metrics for the dev overlay", async () => {
    const snapshots: MetricsSnapshot[] = [];
    const { socket, match } = harness(0, {
      onMetrics: (snapshot) => snapshots.push(snapshot),
    });
    await flush();
    socket.emitMessage(JSON.stringify(roomState(0, [0, 1])));
    await flush();
    socket.emitMessage(JSON.stringify({ t: "game.start", startFrame: 0, inputDelay: 0 }));
    await flush();

    // Peer 1's frame 0 arrives over the relay; the next tick emits a snapshot.
    socket.emitMessage(peerPacket(1, 0, [0x02]));
    match.tick(0x01);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.peers.map((p) => p.slot)).toEqual([1]);
    expect(snapshots[0]?.peers[0]).toMatchObject({ relay: 1, received: 1 });
    expect(match.metrics()?.peers[0]?.relay).toBe(1);
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

  it("sends a frame hash every 60 frames while playing", async () => {
    const { socket, match } = harness(0);
    await flush();
    socket.emitMessage(JSON.stringify(roomState(0, [0])));
    await flush();
    socket.emitMessage(JSON.stringify({ t: "game.start", startFrame: 0, inputDelay: 0 }));
    await flush();

    for (let i = 0; i < 61; i++) match.tick(0x01);

    expect(socket.sent).toContain(
      JSON.stringify({ t: "hash", frame: 60, crc32: 0xabc }),
    );
    match.close();
  });

  it("asks the relay to resend inputs when the lockstep stalls (T31)", async () => {
    let clock = 0;
    const { socket, match } = harness(0, { now: () => clock });
    await flush();
    socket.emitMessage(JSON.stringify(roomState(0, [0, 1])));
    await flush();
    socket.emitMessage(JSON.stringify({ t: "game.start", startFrame: 0, inputDelay: 0 }));
    await flush();
    // Peer slot 1 never sends; tick until the loop stalls past the wait timeout.
    for (let i = 0; i < 3; i++) match.tick(0x01);
    clock = 3000;
    match.tick(0x01);
    expect(jsonSent(socket).find((m) => m.t === "input.request")).toMatchObject({
      t: "input.request",
      fromFrame: 0,
    });
    match.close();
  });

  it("has the host answer a desync with a state.snapshot at its own frame", async () => {
    const createSnapshot = vi.fn(async () => "http://relay/rooms/r/snapshot/1");
    const { socket, match } = harness(0, { createSnapshot });
    await flush();
    socket.emitMessage(JSON.stringify(roomState(0, [0])));
    await flush();
    socket.emitMessage(JSON.stringify({ t: "game.start", startFrame: 0, inputDelay: 0 }));
    await flush();
    // Advance the host past the flagged frame; the snapshot must carry the
    // host's own position, not the relay's (older) desync frame.
    for (let i = 0; i < 61; i++) match.tick(0x01);

    socket.emitMessage(JSON.stringify({ t: "desync", frame: 30 }));
    await flush();

    expect(createSnapshot).toHaveBeenCalledOnce();
    expect(socket.sent).toContain(
      JSON.stringify({
        t: "state.snapshot",
        frame: 60,
        blobUrl: "http://relay/rooms/r/snapshot/1",
      }),
    );
    match.close();
  });

  it("leaves the snapshot to the host when a non-host sees a desync", async () => {
    const createSnapshot = vi.fn(async () => "http://relay/rooms/r/snapshot/1");
    const { socket, match } = harness(0, { createSnapshot });
    await flush();
    socket.emitMessage(JSON.stringify(roomState(1, [0, 1])));
    await flush();
    socket.emitMessage(JSON.stringify({ t: "game.start", startFrame: 0, inputDelay: 0 }));
    await flush();

    socket.emitMessage(JSON.stringify({ t: "desync", frame: 60 }));
    await flush();

    expect(createSnapshot).not.toHaveBeenCalled();
    expect(socket.sent.some((m) => String(m).includes("state.snapshot"))).toBe(false);
    match.close();
  });

  it("fetches, loads and resumes from a host snapshot", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchSnapshot = vi.fn(async () => bytes);
    const { socket, core, match } = harness(0, { fetchSnapshot });
    await flush();
    socket.emitMessage(JSON.stringify(roomState(0, [0, 1])));
    await flush();
    socket.emitMessage(JSON.stringify({ t: "game.start", startFrame: 0, inputDelay: 0 }));
    await flush();

    socket.emitMessage(
      JSON.stringify({ t: "state.snapshot", frame: 100, blobUrl: "http://relay/blob/2" }),
    );
    await flush();

    expect(fetchSnapshot).toHaveBeenCalledWith("http://relay/blob/2");
    expect(core.load).toHaveBeenCalledWith(bytes, 100);
    expect(match.frame()).toBe(101);
    match.close();
  });

  it("has the host announce the game once with game.set (T30)", async () => {
    const { socket, match } = harness(0, { game: GAME });
    await flush();
    socket.emitMessage(JSON.stringify(roomState(0, [0, 1])));
    await flush();

    const sets = jsonSent(socket).filter((m) => m.t === "game.set");
    expect(sets).toHaveLength(1);
    expect(sets[0]).toEqual({
      t: "game.set",
      driver: "gridlee",
      coreHash: "a".repeat(64),
      mameCommit: "b".repeat(40),
      romHash: "c".repeat(64),
      dips: {},
    });
    match.close();
  });

  it("does not announce the game from a non-host (T30)", async () => {
    const { socket, match } = harness(0, { game: GAME });
    await flush();
    socket.emitMessage(JSON.stringify(roomState(1, [0, 1])));
    await flush();

    expect(jsonSent(socket).some((m) => m.t === "game.set")).toBe(false);
    match.close();
  });

  it("publishes a live-join snapshot periodically while hosting (T31)", async () => {
    const createSnapshot = vi.fn(async () => "http://relay/rooms/r/snapshot/1");
    let clock = 0;
    const { socket, match } = harness(0, {
      game: GAME,
      createSnapshot,
      now: () => clock,
      snapshotIntervalMs: 5000,
    });
    await flush();
    socket.emitMessage(JSON.stringify(roomState(0, [0])));
    await flush();
    socket.emitMessage(JSON.stringify({ t: "game.start", startFrame: 0, inputDelay: 0 }));
    await flush();
    for (let i = 0; i < 5; i++) match.tick(0x01); // arms the interval, publishes nothing yet
    await flush();
    expect(createSnapshot).not.toHaveBeenCalled();

    clock = 5000;
    match.tick(0x01);
    await flush();
    expect(createSnapshot).toHaveBeenCalledOnce();
    expect(jsonSent(socket).find((m) => m.t === "viewer.snapshot")).toMatchObject({
      t: "viewer.snapshot",
      blobUrl: "http://relay/rooms/r/snapshot/1",
    });
    match.close();
  });

  it("does not publish live-join snapshots from a non-host (T31)", async () => {
    const createSnapshot = vi.fn(async () => "http://relay/x");
    let clock = 0;
    const { socket, match } = harness(0, {
      game: GAME,
      createSnapshot,
      now: () => clock,
    });
    await flush();
    socket.emitMessage(JSON.stringify(roomState(1, [0, 1])));
    await flush();
    socket.emitMessage(JSON.stringify({ t: "game.start", startFrame: 0, inputDelay: 0 }));
    await flush();
    clock = 100_000;
    match.tick(0x01);
    await flush();
    expect(createSnapshot).not.toHaveBeenCalled();
    match.close();
  });

  it("sends game.end when the host closes a playing match (T30)", async () => {
    const { socket, match } = harness(0, { game: GAME });
    await flush();
    socket.emitMessage(JSON.stringify(roomState(0, [0])));
    await flush();
    socket.emitMessage(JSON.stringify({ t: "game.start", startFrame: 0, inputDelay: 0 }));
    await flush();
    match.tick(0x01);

    match.close();

    const ends = jsonSent(socket).filter((m) => m.t === "game.end");
    expect(ends).toEqual([{ t: "game.end", frame: 0 }]);
  });

  it("host toggles A/V and publishes on livekit.access (T41)", async () => {
    const start = vi.fn(async () => {});
    const stop = vi.fn();
    const publisher = {
      start,
      stop,
      isPublishing: () => false,
    } as unknown as import("./video").VideoPublisher;
    const { socket, match } = harness(0, { video: publisher });
    await flush();
    socket.emitMessage(JSON.stringify(roomState(0, [0])));
    await flush();
    socket.emitMessage(JSON.stringify({ t: "game.start", startFrame: 0, inputDelay: 0 }));
    await flush();

    expect(match.setVideo(true)).toBe(true);
    expect(jsonSent(socket)).toContainEqual({ t: "video.set", enabled: true });

    socket.emitMessage(
      JSON.stringify({
        t: "livekit.access",
        url: "wss://lk",
        room: "r",
        token: "lk-jwt",
      }),
    );
    await flush();
    expect(start).toHaveBeenCalledWith("wss://lk", "lk-jwt");

    // The relay fans the toggle back; disabling stops our publisher.
    socket.emitMessage(JSON.stringify({ t: "video.set", enabled: false }));
    await flush();
    expect(stop).toHaveBeenCalled();
    expect(match.lobby().video).toBe(false);
    match.close();
  });

  it("refuses setVideo for a non-host (T41)", async () => {
    const { socket, match } = harness();
    await flush();
    socket.emitMessage(JSON.stringify(roomState(1, [0, 1])));
    await flush();
    expect(match.isHost()).toBe(false);
    expect(match.setVideo(true)).toBe(false);
    expect(jsonSent(socket).some((m) => m.t === "video.set")).toBe(false);
    match.close();
  });

  it("pauses the room collaboratively and freezes stepping (T29)", async () => {
    const { socket, core, match } = harness(0);
    await flush();
    socket.emitMessage(JSON.stringify(roomState(0, [0])));
    await flush();
    socket.emitMessage(JSON.stringify({ t: "game.start", startFrame: 0, inputDelay: 0 }));
    await flush();

    expect(match.setPaused(true)).toBe(true);
    expect(jsonSent(socket)).toContainEqual({ t: "player.pause", paused: true });
    expect(match.status()).toBe("paused");
    expect(match.lobby().paused).toBe(true);

    // Paused: no frame is stepped even though the local input is sampled.
    match.tick(0x01);
    expect(core.steps).toEqual([]);

    // Clearing our own intent (tab shown again) resumes the loop.
    expect(match.setPaused(false)).toBe(true);
    expect(jsonSent(socket)).toContainEqual({ t: "player.pause", paused: false });
    expect(match.status()).toBe("running");
    expect(match.lobby().paused).toBe(false);
    match.tick(0x01);
    expect(core.steps.length).toBeGreaterThan(0);
    match.close();
  });

  it("stays paused while our tab is hidden even if a peer resumes (T29)", async () => {
    const { socket, match } = harness(0);
    await flush();
    socket.emitMessage(JSON.stringify(roomState(0, [0])));
    await flush();
    socket.emitMessage(JSON.stringify({ t: "game.start", startFrame: 0, inputDelay: 0 }));
    await flush();

    match.setPaused(true);
    // A peer's resume aggregate arrives while our own tab is still hidden: the
    // effective pause must stay on because the two intents are OR-ed.
    socket.emitMessage(JSON.stringify({ t: "player.pause", paused: false, player: 1 }));
    await flush();
    expect(match.status()).toBe("paused");
    expect(match.lobby().paused).toBe(true);
    match.close();
  });

  it("pauses locally when a peer pauses (T29)", async () => {
    const { socket, core, match } = harness(0);
    await flush();
    socket.emitMessage(JSON.stringify(roomState(0, [0])));
    await flush();
    socket.emitMessage(JSON.stringify({ t: "game.start", startFrame: 0, inputDelay: 0 }));
    await flush();

    socket.emitMessage(JSON.stringify({ t: "player.pause", paused: true, player: 1 }));
    await flush();
    expect(match.status()).toBe("paused");
    match.tick(0x01);
    expect(core.steps).toEqual([]);

    socket.emitMessage(JSON.stringify({ t: "player.pause", paused: false, player: 1 }));
    await flush();
    expect(match.status()).toBe("running");
    match.tick(0x01);
    expect(core.steps.length).toBe(1);
    match.close();
  });

  it("refuses to pause before the match starts (T29)", async () => {
    const { match } = harness(0);
    await flush();
    expect(match.setPaused(true)).toBe(false);
    match.close();
  });

  it("escalates a persistent stall to a host snapshot (T29)", async () => {
    const createSnapshot = vi.fn(async () => "http://relay/rooms/r/snapshot/1");
    let clock = 0;
    const { socket, match } = harness(0, {
      createSnapshot,
      now: () => clock,
      stallEscalateMs: 6000,
    });
    await flush();
    socket.emitMessage(JSON.stringify(roomState(0, [0, 1])));
    await flush();
    socket.emitMessage(JSON.stringify({ t: "game.start", startFrame: 0, inputDelay: 0 }));
    await flush();

    // Peer 1 sends frame 0, then goes silent: the loop stalls at frame 1.
    socket.emitMessage(peerPacket(1, 0, [0x02]));
    match.tick(0x01);
    expect(match.frame()).toBe(1);

    clock = 2000;
    match.tick(0x01); // arms the wait timer
    clock = 4000;
    match.tick(0x01); // enters "waiting", sends input.request
    expect(jsonSent(socket).find((m) => m.t === "input.request")).toBeDefined();
    expect(createSnapshot).not.toHaveBeenCalled();

    clock = 10_000;
    match.tick(0x01); // escalates one interval later
    await flush();
    expect(createSnapshot).toHaveBeenCalledOnce();
    expect(socket.sent).toContain(
      JSON.stringify({
        t: "state.snapshot",
        frame: 0,
        blobUrl: "http://relay/rooms/r/snapshot/1",
      }),
    );
    match.close();
  });

  it("leaves stall escalation to the host (T29)", async () => {
    const createSnapshot = vi.fn(async () => "http://relay/x");
    let clock = 0;
    const { socket, match } = harness(0, {
      createSnapshot,
      now: () => clock,
      stallEscalateMs: 6000,
    });
    await flush();
    socket.emitMessage(JSON.stringify(roomState(1, [0, 1])));
    await flush();
    socket.emitMessage(JSON.stringify({ t: "game.start", startFrame: 0, inputDelay: 0 }));
    await flush();

    socket.emitMessage(peerPacket(0, 0, [0x01]));
    match.tick(0x02);
    clock = 100_000;
    match.tick(0x02);
    await flush();
    expect(createSnapshot).not.toHaveBeenCalled();
    match.close();
  });

  it("ignores an out-of-order older snapshot (T29)", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const pending: ((value: Uint8Array) => void)[] = [];
    const fetchSnapshot = vi.fn(
      () => new Promise<Uint8Array>((resolve) => pending.push(resolve)),
    );
    const { socket, core, match } = harness(0, { fetchSnapshot });
    await flush();
    socket.emitMessage(JSON.stringify(roomState(0, [0])));
    await flush();
    socket.emitMessage(JSON.stringify({ t: "game.start", startFrame: 0, inputDelay: 0 }));
    await flush();

    socket.emitMessage(
      JSON.stringify({ t: "state.snapshot", frame: 110, blobUrl: "http://relay/110" }),
    );
    socket.emitMessage(
      JSON.stringify({ t: "state.snapshot", frame: 100, blobUrl: "http://relay/100" }),
    );
    await flush();

    // The newer frame resolves first, then the older one: the older must be
    // ignored rather than rewinding the match.
    pending[0]?.(bytes);
    await flush();
    pending[1]?.(bytes);
    await flush();

    expect(core.load).toHaveBeenCalledWith(bytes, 110);
    expect(core.load).not.toHaveBeenCalledWith(bytes, 100);
    expect(match.frame()).toBe(111);
    match.close();
  });

  it("keeps a pre-start pause across game.start (T29)", async () => {
    const { socket, core, match } = harness(0);
    await flush();
    socket.emitMessage(JSON.stringify(roomState(0, [0])));
    await flush();

    // Hidden in the lobby: no lockstep yet, so no message, but the intent sticks.
    expect(match.setPaused(true)).toBe(false);

    socket.emitMessage(JSON.stringify({ t: "game.start", startFrame: 0, inputDelay: 0 }));
    await flush();
    expect(match.status()).toBe("paused");
    expect(jsonSent(socket)).toContainEqual({ t: "player.pause", paused: true });
    match.tick(0x01);
    expect(core.steps).toEqual([]);
    match.close();
  });

  it("sizes the input delay from measured peer RTT (T29)", async () => {
    const socket = new FakeWebSocket();
    const pc = new FakePeerConnection();
    pc.statsRttSeconds = 0.045; // 45 ms → ceil(45/16.67)+1 = 4 frames
    const core = fakeCore();
    const match = createMatch({
      core,
      config,
      socketFactory: fakeSocketFactory(socket),
      factory: fakeRtcFactory([pc]),
      now: () => 0,
    });
    socket.open();
    socket.emitMessage(JSON.stringify(roomState(0, [0, 1], [1])));
    await flush();

    expect(match.start()).toBe(true);
    expect(jsonSent(socket)).toContainEqual({
      t: "game.start",
      startFrame: 0,
      inputDelay: 4,
    });
    match.close();
  });
});

describe("createMatch (live scoreboard, T32)", () => {
  function scoreHarness(overrides: Partial<MatchDeps> = {}) {
    const socket = new FakeWebSocket();
    const pc = new FakePeerConnection();
    const core = fakeCore();
    const rows: { slot: number; score: number }[][] = [];
    let clock = 0;
    const match = createMatch({
      core,
      config,
      socketFactory: fakeSocketFactory(socket),
      factory: fakeRtcFactory([pc]),
      now: () => clock,
      inputDelay: 0,
      game: GAME,
      onScores: (r) => rows.push(r),
      ...overrides,
    });
    socket.open();
    return { socket, pc, core, match, rows, setClock: (t: number) => (clock = t) };
  }

  async function start(match: ReturnType<typeof createMatch>, socket: FakeWebSocket) {
    socket.emitMessage(JSON.stringify(roomState(0, [0])));
    await flush();
    socket.emitMessage(JSON.stringify({ t: "game.start", startFrame: 0, inputDelay: 0 }));
    await flush();
    // The relay re-broadcasts room.state as playing after game.start.
    socket.emitMessage(JSON.stringify({ ...roomState(0, [0]), status: "playing" }));
    await flush();
  }

  it("samples our own slot at most once per interval and sends score.live", async () => {
    const { socket, core, match, rows, setClock } = scoreHarness();
    (core.readScore as ReturnType<typeof vi.fn>).mockReturnValue(1234);
    await flush();
    await start(match, socket);

    // First tick arms the cadence and samples immediately.
    match.tick(0x01);
    expect(core.readScore).toHaveBeenCalledWith(0);
    expect(jsonSent(socket).find((m) => m.t === "score.live")).toMatchObject({
      t: "score.live",
      score: 1234,
    });

    // Within the interval: no further sample.
    (core.readScore as ReturnType<typeof vi.fn>).mockClear();
    match.tick(0x01);
    match.tick(0x01);
    expect(core.readScore).not.toHaveBeenCalled();

    // After the interval: sampled again.
    setClock(1000);
    match.tick(0x01);
    expect(core.readScore).toHaveBeenCalledTimes(1);
    expect(rows.at(-1)).toEqual([{ slot: 0, score: 1234 }]);
    match.close();
  });

  it("swallows a CoreCapabilityError from readScore (no scoremap yet)", async () => {
    const { socket, core, match } = scoreHarness();
    (core.readScore as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("no scoremap");
    });
    await flush();
    await start(match, socket);

    expect(() => match.tick(0x01)).not.toThrow();
    expect(jsonSent(socket).some((m) => m.t === "score.live")).toBe(false);
    match.close();
  });

  it("merges a peer's score.live into the scoreboard", async () => {
    const { socket, core, match, rows } = scoreHarness();
    (core.readScore as ReturnType<typeof vi.fn>).mockReturnValue(1);
    await flush();
    await start(match, socket);
    match.tick(0x01);

    socket.emitMessage(
      JSON.stringify({ t: "score.live", player: 1, score: 99, frame: 90 }),
    );
    await flush();
    expect(rows.at(-1)).toEqual([
      { slot: 0, score: 1 },
      { slot: 1, score: 99 },
    ]);
    expect(match.scores()).toEqual([
      { slot: 0, score: 1 },
      { slot: 1, score: 99 },
    ]);
    match.close();
  });

  it("does not report a score before the game is set (no log)", async () => {
    const { socket, core, match } = scoreHarness({ game: undefined });
    (core.readScore as ReturnType<typeof vi.fn>).mockReturnValue(5);
    await flush();
    await start(match, socket);
    match.tick(0x01);
    expect(core.readScore).not.toHaveBeenCalled();
    match.close();
  });

  it("stops sampling once the room is no longer playing", async () => {
    const { socket, core, match, setClock } = scoreHarness();
    (core.readScore as ReturnType<typeof vi.fn>).mockReturnValue(10);
    await flush();
    await start(match, socket);
    match.tick(0x01); // samples once
    (core.readScore as ReturnType<typeof vi.fn>).mockClear();

    // The relay flips the room to ended (e.g. after game.end).
    socket.emitMessage(
      JSON.stringify({ ...roomState(0, [0]), status: "ended" }),
    );
    await flush();
    setClock(5000);
    match.tick(0x01);
    expect(core.readScore).not.toHaveBeenCalled();
    match.close();
  });
});
