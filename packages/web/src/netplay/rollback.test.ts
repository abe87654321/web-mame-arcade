import { describe, expect, it } from "vitest";
import type { FrameInputs } from "../core/types";
import { buildInputPacket } from "./inputs";
import { createRollback, type RollbackDeps } from "./rollback";
import type { LockstepStatus } from "./lockstep";

/**
 * Deterministic fake machine: state is a 64-bit fold of every stepped
 * (frame, inputs) pair. `load` restores the fold and the frame clock, so a
 * rollback that replays the same frames reaches exactly the same state.
 */
function fakeMachine() {
  const steps: { frame: number; inputs: FrameInputs }[] = [];
  const loads: number[] = [];
  const stepHashes = new Map<number, number>();
  let state = 0n;
  let lastFrame = -1;
  const MASK = (1n << 64n) - 1n;
  const mix = (current: bigint, frame: number, inputs: FrameInputs): bigint => {
    let value = (current * 1_000_003n + BigInt(frame + 1) * 17n) & MASK;
    for (const input of inputs) value = (value * 31n + BigInt(input)) & MASK;
    return value;
  };
  return {
    steps,
    loads,
    stepHashes,
    step(frame: number, inputs: FrameInputs) {
      if (frame !== lastFrame + 1) {
        throw new Error(`step ${frame} after ${lastFrame}`);
      }
      state = mix(state, frame, inputs);
      lastFrame = frame;
      stepHashes.set(frame, Number(state & 0xffffffffn));
      steps.push({ frame, inputs: [...inputs] as unknown as FrameInputs });
    },
    save(): Uint8Array {
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setBigUint64(0, state, true);
      return bytes;
    },
    load(bytes: Uint8Array, frame: number): void {
      state = new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);
      lastFrame = frame;
      loads.push(frame);
    },
    hash(): number {
      return Number(state & 0xffffffffn);
    },
    lastFrame: () => lastFrame,
    state: () => state,
  };
}

function packet(player: number, firstFrame: number, inputs: number[]): Uint8Array {
  return buildInputPacket({ player, ackFrame: 0, frames: inputs, endFrame: firstFrame + inputs.length - 1 });
}

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function deps(core = fakeMachine(), overrides: Partial<RollbackDeps> = {}): RollbackDeps & {
  core: ReturnType<typeof fakeMachine>;
} {
  return {
    core,
    mySlot: 0,
    players: [0, 1],
    inputDelay: 0,
    startFrame: 0,
    sendInput: () => {},
    now: () => 0,
    ...overrides,
  } as RollbackDeps & { core: ReturnType<typeof fakeMachine> };
}

describe("createRollback", () => {
  it("predicts missing remote input from the last confirmed mask", () => {
    const core = fakeMachine();
    const rollback = createRollback(deps(core, { inputDelay: 0 }));

    rollback.tick(0x01);
    rollback.tick(0x02);

    expect(core.steps).toEqual([
      { frame: 0, inputs: [0x01, 0, 0, 0] },
      { frame: 1, inputs: [0x02, 0, 0, 0] },
    ]);
    expect(rollback.frame()).toBe(2);
    expect(rollback.stats().predictions).toBe(2);
  });

  it("rewinds to the saved state and re-simulates when a late mask differs", () => {
    const core = fakeMachine();
    const rollback = createRollback(deps(core, { inputDelay: 0 }));

    rollback.tick(0x01);
    rollback.tick(0x02);
    // The peer's real frame 0 is 7, not the predicted 0.
    rollback.onBytes(packet(1, 0, [7]));
    rollback.tick(0x03);

    expect(core.loads).toEqual([-1]);
    const replay = core.steps.slice(-3);
    expect(replay).toEqual([
      { frame: 0, inputs: [0x01, 7, 0, 0] },
      { frame: 1, inputs: [0x02, 7, 0, 0] },
      { frame: 2, inputs: [0x03, 7, 0, 0] },
    ]);
    expect(rollback.frame()).toBe(3);
    expect(rollback.stats().rollbacks).toBe(1);
  });

  it("does not roll back when the late mask equals the prediction", () => {
    const core = fakeMachine();
    const rollback = createRollback(deps(core, { inputDelay: 0 }));

    rollback.tick(0x01);
    rollback.onBytes(packet(1, 0, [0]));
    rollback.tick(0x02);

    expect(core.loads).toEqual([]);
    expect(rollback.stats().rollbacks).toBe(0);
  });

  it("converges to the same state as a zero-latency run", () => {
    const local = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x01, 0x03, 0x07, 0x0f];
    const peer = [0x10, 0x20, 0x00, 0x40, 0x04, 0x00, 0x08, 0x80, 0x02, 0x01, 0x00, 0x04];

    const fast = fakeMachine();
    const fastLoop = createRollback(deps(fast, { inputDelay: 0 }));
    const slow = fakeMachine();
    const slowLoop = createRollback(deps(slow, { inputDelay: 0 }));

    for (let i = 0; i < local.length; i++) {
      fastLoop.onBytes(packet(1, i, [peer[i]!]));
      fastLoop.tick(local[i]!);

      slowLoop.tick(local[i]!);
      if (i >= 3) slowLoop.onBytes(packet(1, i - 3, [peer[i - 3]!]));
    }
    // Flush the last three late packets.
    for (let i = local.length - 3; i < local.length; i++) {
      slowLoop.onBytes(packet(1, i, [peer[i]!]));
    }
    fastLoop.tick(0);
    slowLoop.tick(0);

    expect(slow.lastFrame()).toBe(fast.lastFrame());
    expect(slow.state()).toBe(fast.state());
    expect(slow.hash()).toBe(fast.hash());
    expect(slowLoop.stats().rollbacks).toBeGreaterThan(0);
  });

  it("stops predicting once a peer is more than the window behind", () => {
    const core = fakeMachine();
    const time = clock();
    const stalls: number[] = [];
    const escalations: number[] = [];
    const statuses: LockstepStatus[] = [];
    const rollback = createRollback(
      deps(core, {
        inputDelay: 0,
        window: 2,
        now: time.now,
        onStatus: (status) => statuses.push(status),
        onStall: (frame) => stalls.push(frame),
        onStallEscalate: (frame) => escalations.push(frame),
      }),
    );

    for (let i = 0; i < 4; i++) rollback.tick(i + 1);

    // last confirmed peer frame is -1, so frames 0 and 1 fit the window.
    expect(core.steps.map((step) => step.frame)).toEqual([0, 1]);
    expect(rollback.frame()).toBe(2);
    expect(rollback.scheduledFrame()).toBe(4);

    time.advance(2_000);
    rollback.tick(9);
    expect(stalls).toEqual([2]);
    expect(statuses).toContain("waiting");

    time.advance(6_000);
    rollback.tick(10);
    expect(escalations).toEqual([2]);
  });

  it("keeps the input delay window neutral", () => {
    const core = fakeMachine();
    const rollback = createRollback(deps(core, { inputDelay: 2 }));

    rollback.tick(0xff);

    expect(core.steps).toEqual([
      { frame: 0, inputs: [0, 0, 0, 0] },
      { frame: 1, inputs: [0, 0, 0, 0] },
      { frame: 2, inputs: [0xff, 0, 0, 0] },
    ]);
  });

  it("reports a hash only once the frame can no longer be corrected", () => {
    const core = fakeMachine();
    const hashes: { frame: number; crc32: number }[] = [];
    const rollback = createRollback(
      deps(core, {
        players: [0],
        inputDelay: 0,
        window: 2,
        hashInterval: 2,
        hash: () => core.hash(),
        onHash: (frame, crc32) => hashes.push({ frame, crc32 }),
      }),
    );

    for (let i = 0; i < 5; i++) rollback.tick(i + 1);

    // Frame 2 is a boundary; it becomes final once current > 2 + window.
    expect(rollback.frame()).toBe(5);
    expect(hashes.map((hash) => hash.frame)).toEqual([2]);
  });

  it("emits only the corrected hash for a boundary that was rolled back", () => {
    const core = fakeMachine();
    const hashes: { frame: number; crc32: number }[] = [];
    const rollback = createRollback(
      deps(core, {
        inputDelay: 0,
        window: 3,
        hashInterval: 2,
        hash: () => core.hash(),
        onHash: (frame, crc32) => hashes.push({ frame, crc32 }),
      }),
    );

    rollback.tick(0x01);
    rollback.tick(0x02);
    rollback.tick(0x03); // frame 2 boundary stepped with peer predicted 0
    rollback.onBytes(packet(1, 0, [7])); // forces a rewind/rebuild of frame 2
    // Confirm the following frames so the loop can advance past the window.
    rollback.onBytes(packet(1, 1, [0, 0, 0, 0, 0]));
    rollback.tick(0x04);
    rollback.tick(0x05);
    rollback.tick(0x06);

    expect(hashes).toHaveLength(1);
    expect(hashes[0]?.frame).toBe(2);
    expect(hashes[0]?.crc32).toBe(core.stepHashes.get(2));
  });

  it("can correct frame 0 from the boot snapshot", () => {
    const core = fakeMachine();
    const rollback = createRollback(deps(core, { inputDelay: 0 }));

    rollback.tick(0x01);
    rollback.onBytes(packet(1, 0, [5]));
    rollback.tick(0x02);

    expect(core.loads).toEqual([-1]);
    expect(core.steps.at(-1)).toEqual({ frame: 1, inputs: [0x02, 5, 0, 0] });
  });

  it("refuses to start when the state cannot be snapshotted", () => {
    const failing = fakeMachine();
    failing.save = () => {
      throw new Error("no save");
    };
    expect(() => createRollback(deps(failing))).toThrow(/rollback/i);

    const empty = fakeMachine();
    empty.save = () => new Uint8Array(0);
    expect(() => createRollback(deps(empty))).toThrow(/rollback/i);
  });

  it("refuses a ring that would exceed the memory budget", () => {
    const big = fakeMachine();
    big.save = () => new Uint8Array(1024);
    expect(() =>
      createRollback(deps(big, { window: 8, maxMemoryBytes: 4_096 })),
    ).toThrow(/memory/i);
  });

  it("freezes while paused and reconciles buffered packets on resume", () => {
    const core = fakeMachine();
    const rollback = createRollback(deps(core, { inputDelay: 0 }));

    rollback.tick(0x01);
    rollback.pause();
    rollback.tick(0x02);
    rollback.onBytes(packet(1, 0, [7]));
    expect(core.steps.map((step) => step.frame)).toEqual([0]);
    expect(rollback.paused()).toBe(true);

    rollback.resume();
    rollback.tick(0x03);
    expect(core.loads).toEqual([-1]);
    expect(rollback.frame()).toBe(2);
  });

  it("degrades to wait-only after sustained slow ticks", () => {
    const core = fakeMachine();
    let t = 0;
    const rollback = createRollback(
      deps(core, {
        players: [0],
        inputDelay: 0,
        perfNow: () => {
          t += 25;
          return t;
        },
      }),
    );

    for (let i = 0; i < 60; i++) rollback.tick(i & 0xffff);

    expect(rollback.stats().degraded).toBe(true);
    expect(rollback.stats().emaCostMs).toBeGreaterThan(20);
  });

  it("stops predicting new frames once degraded", () => {
    const core = fakeMachine();
    let t = 0;
    const rollback = createRollback(
      deps(core, {
        inputDelay: 0,
        perfNow: () => {
          t += 25;
          return t;
        },
      }),
    );

    for (let i = 0; i < 60; i++) {
      rollback.onBytes(packet(1, i, [0]));
      rollback.tick(0x01);
    }
    expect(rollback.stats().degraded).toBe(true);

    const stepped = core.steps.length;
    rollback.tick(0x02); // peer frame 60 is missing
    expect(core.steps.length).toBe(stepped);
    expect(rollback.frame()).toBe(60);
  });

  it("degrades after a rollback storm", () => {
    const core = fakeMachine();
    const rollback = createRollback(
      deps(core, { inputDelay: 0, perfNow: () => 0 }),
    );

    for (let i = 0; i < 62; i++) {
      rollback.tick(0x01);
      rollback.onBytes(packet(1, i, [i + 1]));
    }

    expect(rollback.stats().rollbacks).toBeGreaterThan(20);
    expect(rollback.stats().degraded).toBe(true);
  });

  it("does not meter paused ticks", () => {
    const core = fakeMachine();
    let t = 0;
    const rollback = createRollback(
      deps(core, {
        players: [0],
        inputDelay: 0,
        perfNow: () => {
          t += 25;
          return t;
        },
      }),
    );

    rollback.pause();
    for (let i = 0; i < 100; i++) rollback.tick(0);
    expect(rollback.stats().emaCostMs).toBe(0);
    expect(rollback.stats().degraded).toBe(false);
  });

  it("resumes from a resync frame with a fresh window", () => {
    const core = fakeMachine();
    const rollback = createRollback(deps(core, { inputDelay: 0 }));
    rollback.tick(0x01);
    rollback.tick(0x02);

    rollback.resync(1);
    expect(rollback.frame()).toBe(2);
    expect(rollback.status()).toBe("running");

    rollback.tick(0x09);
    expect(core.steps.at(-1)).toEqual({ frame: 2, inputs: [0x09, 0, 0, 0] });
  });
});
