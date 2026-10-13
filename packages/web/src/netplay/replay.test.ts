import { describe, expect, it, vi } from "vitest";
import type { InputLog } from "@wma/protocol";
import type { Core, FrameInputs } from "../core/types";
import { createReplay, frameInputsAt, type ReplayStatus } from "./replay";

const BOOT = new Uint8Array([7, 7, 7]);

function makeLog(overrides: Partial<InputLog> = {}): InputLog {
  return {
    v: 1,
    room: "r",
    meta: {
      driver: "gridlee",
      core_hash: "a".repeat(64),
      mame_commit: "b".repeat(40),
      rom_hash: "c".repeat(64),
      dips: {},
      mode: "coop",
    },
    start: {
      frame: 0,
      input_delay: 2,
      players: [
        { slot: 0, name: "alice" },
        { slot: 1, name: "bob" },
      ],
      start_state_key: null,
    },
    end: { frame: 3, scores: [] },
    // Dense: start.frame..end.frame inclusive (4 rows).
    frames: [
      [0, 0],
      [0x11, 0x22],
      [0x33, 0x44],
      [0x55, 0x66],
    ],
    ...overrides,
  };
}

interface FakeCore {
  core: Core;
  steps: { frame: number; inputs: FrameInputs }[];
  hashValue: { current: number };
}

function fakeCore(): FakeCore {
  const steps: { frame: number; inputs: FrameInputs }[] = [];
  const hashValue = { current: 0 };
  const core = {
    load: vi.fn(),
    step: (frame: number, inputs: FrameInputs) => {
      steps.push({ frame, inputs });
    },
    save: () => BOOT,
    loadState: vi.fn(),
    hash: () => hashValue.current,
    readScore: () => 0,
    reset: vi.fn(),
    destroy: vi.fn(),
  } as unknown as Core;
  return { core, steps, hashValue };
}

describe("frameInputsAt", () => {
  it("places each row mask at its player's slot", () => {
    const log = makeLog({
      start: {
        ...makeLog().start,
        players: [
          { slot: 1, name: "one" },
          { slot: 0, name: "zero" },
        ],
      },
    });
    // Row [0x11, 0x22]: players[0]=slot1 gets 0x11, players[1]=slot0 gets 0x22.
    expect(frameInputsAt(log, 1)).toEqual([0x22, 0x11, 0, 0]);
  });

  it("is neutral before the log's start frame and past its end", () => {
    const log = makeLog({
      start: { ...makeLog().start, frame: 10 },
      end: { frame: 11, scores: [] },
      frames: [
        [0xaa, 0xbb],
        [0xcc, 0xdd],
      ],
    });
    expect(frameInputsAt(log, 9)).toEqual([0, 0, 0, 0]);
    expect(frameInputsAt(log, 10)).toEqual([0xaa, 0xbb, 0, 0]);
    expect(frameInputsAt(log, 12)).toEqual([0, 0, 0, 0]);
  });

  it("masks each value to 16 bits", () => {
    const log = makeLog({ frames: [[0x1ffff, 0]] });
    expect(frameInputsAt(log, 0)[0]).toBe(0xffff);
  });
});

describe("createReplay", () => {
  it("steps log frames in order at the frame rate", () => {
    const { core, steps } = fakeCore();
    const replay = createReplay({ core, log: makeLog(), frameMs: 100 });
    replay.tick(0); // frame 0 (neutral delay row)
    expect(steps).toEqual([{ frame: 0, inputs: [0, 0, 0, 0] }]);
    expect(replay.frame()).toBe(1);
    replay.tick(99); // not due yet
    expect(steps).toHaveLength(1);
    replay.tick(100); // frame 1
    expect(steps[1]).toEqual({ frame: 1, inputs: [0x11, 0x22, 0, 0] });
    expect(replay.frame()).toBe(2);
  });

  it("ends after the log's last frame and stops stepping", () => {
    const { core, steps } = fakeCore();
    const statuses: ReplayStatus[] = [];
    const replay = createReplay({
      core,
      log: makeLog(),
      frameMs: 100,
      onStatus: (status) => statuses.push(status),
    });
    replay.tick(0);
    replay.tick(100);
    replay.tick(200);
    replay.tick(300); // frame 3 is the last
    expect(replay.frame()).toBe(4);
    expect(replay.status()).toBe("ended");
    expect(statuses).toContain("ended");
    replay.tick(10_000); // still nothing
    expect(steps).toHaveLength(4);
  });

  it("holds when paused and resumes", () => {
    const { core, steps } = fakeCore();
    const replay = createReplay({ core, log: makeLog(), frameMs: 100 });
    replay.tick(0);
    replay.pause();
    expect(replay.status()).toBe("paused");
    replay.tick(10_000);
    expect(steps).toHaveLength(1);
    replay.play();
    expect(replay.status()).toBe("playing");
    replay.tick(10_001);
    expect(steps).toHaveLength(2);
  });

  it("restarts from the boot snapshot at start.frame", () => {
    const { core, steps } = fakeCore();
    const replay = createReplay({ core, log: makeLog(), frameMs: 100 });
    replay.tick(0);
    replay.tick(100);
    replay.restart();
    expect(core.load).toHaveBeenCalledWith(BOOT, -1);
    expect(replay.frame()).toBe(0);
    expect(replay.status()).toBe("playing");
    replay.tick(5000); // first tick after restart re-bases the cadence
    expect(steps.at(-1)).toEqual({ frame: 0, inputs: [0, 0, 0, 0] });
  });

  it("does not step the pre-roll when start.frame > 0", () => {
    const { core, steps } = fakeCore();
    const log = makeLog({
      start: { ...makeLog().start, frame: 10 },
      end: { frame: 11, scores: [] },
      frames: [
        [1, 2],
        [3, 4],
      ],
    });
    const replay = createReplay({ core, log, frameMs: 100 });
    replay.tick(0);
    expect(steps[0]?.frame).toBe(10);
  });

  it("is deterministic for the same injected clock sequence", () => {
    const a = fakeCore();
    const b = fakeCore();
    const ra = createReplay({ core: a.core, log: makeLog(), frameMs: 50 });
    const rb = createReplay({ core: b.core, log: makeLog(), frameMs: 50 });
    for (const now of [0, 10, 50, 70, 130, 400, 401, 1000]) {
      ra.tick(now);
      rb.tick(now);
    }
    expect(a.steps).toEqual(b.steps);
  });

  it("reports the current core hash", () => {
    const { core, hashValue } = fakeCore();
    hashValue.current = 123456;
    const replay = createReplay({ core, log: makeLog() });
    expect(replay.bootHash()).toBe(123456);
  });
});
