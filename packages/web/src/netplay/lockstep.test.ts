import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, decodeInput, encodeInput } from "@wma/protocol";
import type { FrameInputs } from "../core/types";
import { createLockstep, type LockstepStatus } from "./lockstep";

function fakeCore() {
  const steps: { frame: number; inputs: FrameInputs }[] = [];
  return {
    steps,
    step(frame: number, inputs: FrameInputs) {
      steps.push({ frame, inputs });
    },
  };
}

function clock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("createLockstep", () => {
  it("steps the initial delay frames as neutral, then the sampled input", () => {
    const core = fakeCore();
    const sent: Uint8Array[] = [];
    const lockstep = createLockstep({
      core,
      mySlot: 0,
      players: [0],
      inputDelay: 2,
      startFrame: 0,
      sendInput: (packet) => sent.push(packet),
      now: () => 0,
    });

    lockstep.tick([0x10, 0, 0, 0]);

    expect(core.steps.map((s) => s.frame)).toEqual([0, 1, 2]);
    expect(core.steps[0]?.inputs).toEqual([0, 0, 0, 0]);
    expect(core.steps[2]?.inputs).toEqual([0x10, 0, 0, 0]);
    expect(lockstep.frame()).toBe(3);

    const packet = decodeInput(sent[0]!);
    expect(packet.player).toBe(0);
    expect(packet.firstFrame).toBe(0);
    expect(packet.inputs).toEqual([0, 0, 0x10]);
  });

  it("blocks until every player's input for the frame is present", () => {
    const core = fakeCore();
    const lockstep = createLockstep({
      core,
      mySlot: 0,
      players: [0, 1],
      inputDelay: 0,
      startFrame: 0,
      sendInput: () => {},
      now: () => 0,
    });

    lockstep.tick([0x01, 0, 0, 0]);
    expect(core.steps).toHaveLength(0);
    expect(lockstep.frame()).toBe(0);

    lockstep.onBytes(
      // peer 1 sends frame 0; hand-built packet via the public codec.
      encodePeer(1, 0, [0x02]),
    );
    lockstep.tick([0x01, 0, 0, 0]);

    expect(core.steps.map((s) => s.frame)).toEqual([0]);
    expect(core.steps[0]?.inputs).toEqual([0x01, 0x02, 0, 0]);
    expect(lockstep.frame()).toBe(1);
  });

  it("repeats the last 8 frames in each packet", () => {
    const sent: Uint8Array[] = [];
    const lockstep = createLockstep({
      core: fakeCore(),
      mySlot: 0,
      players: [0],
      inputDelay: 0,
      startFrame: 0,
      sendInput: (packet) => sent.push(packet),
      now: () => 0,
    });

    for (let i = 0; i < 10; i++) lockstep.tick([i + 1, 0, 0, 0]);

    const packet = decodeInput(sent.at(-1)!);
    expect(packet.firstFrame).toBe(2);
    expect(packet.inputs).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("surfaces waiting after the timeout and resumes when inputs arrive", () => {
    const core = fakeCore();
    const time = clock();
    const statuses: LockstepStatus[] = [];
    const lockstep = createLockstep({
      core,
      mySlot: 0,
      players: [0, 1],
      inputDelay: 0,
      startFrame: 0,
      sendInput: () => {},
      now: time.now,
      onStatus: (status) => statuses.push(status),
      waitTimeoutMs: 2000,
    });

    lockstep.tick([0x01, 0, 0, 0]);
    time.advance(1999);
    lockstep.tick([0x01, 0, 0, 0]);
    expect(lockstep.status()).toBe("running");

    time.advance(1);
    lockstep.tick([0x01, 0, 0, 0]);
    expect(lockstep.status()).toBe("waiting");

    lockstep.onBytes(encodePeer(1, 0, [0x02, 0x02, 0x02, 0x02, 0x02, 0x02]));
    lockstep.tick([0x01, 0, 0, 0]);
    expect(lockstep.status()).toBe("running");
    expect(statuses).toEqual(["waiting", "running"]);
    expect(core.steps.map((s) => s.frame)).toEqual([0, 1, 2, 3]);
  });

  it("ignores a packet that tries to speak for our slot", () => {
    const core = fakeCore();
    const lockstep = createLockstep({
      core,
      mySlot: 0,
      players: [0],
      inputDelay: 0,
      startFrame: 0,
      sendInput: () => {},
      now: () => 0,
    });

    lockstep.onBytes(encodePeer(0, 5, [0x09]));
    lockstep.tick([0x01, 0, 0, 0]);

    expect(core.steps.map((s) => s.frame)).toEqual([0]);
    expect(core.steps[0]?.inputs[0]).toBe(0x01);
  });

  it("bounds how far the local schedule runs ahead of the simulation", () => {
    const sent: Uint8Array[] = [];
    const lockstep = createLockstep({
      core: fakeCore(),
      mySlot: 0,
      players: [0, 1],
      inputDelay: 0,
      startFrame: 0,
      sendInput: (packet) => sent.push(packet),
      now: () => 0,
      maxLookahead: 2,
    });

    for (let i = 0; i < 10; i++) lockstep.tick([0x01, 0, 0, 0]);

    expect(decodeInput(sent.at(-1)!).firstFrame).toBe(0);
    expect(decodeInput(sent.at(-1)!).inputs).toHaveLength(2);
  });

  it("keeps two wired peers on the same frames with the same inputs", () => {
    const coreA = fakeCore();
    const coreB = fakeCore();
    const a = createLockstep({
      core: coreA,
      mySlot: 0,
      players: [0, 1],
      inputDelay: 2,
      startFrame: 0,
      sendInput: (packet) => b.onBytes(packet),
      now: () => 0,
    });
    const b = createLockstep({
      core: coreB,
      mySlot: 1,
      players: [0, 1],
      inputDelay: 2,
      startFrame: 0,
      sendInput: (packet) => a.onBytes(packet),
      now: () => 0,
    });

    for (let i = 0; i < 30; i++) {
      a.tick([0x01, 0, 0, 0]);
      b.tick([0, 0x02, 0, 0]);
    }

    // A tick carries a packet to the peer but is stepped before the peer's
    // reply is processed, so the two are at most one tick apart; everything
    // they have both simulated must be identical.
    expect(Math.abs(a.frame() - b.frame())).toBeLessThanOrEqual(1);
    const common = Math.min(coreA.steps.length, coreB.steps.length);
    expect(common).toBeGreaterThan(20);
    expect(coreA.steps.slice(0, common)).toEqual(coreB.steps.slice(0, common));
  });

  it("never lets the wall clock reach the core", () => {
    const core = fakeCore();
    const now = vi.fn(() => 123);
    const lockstep = createLockstep({
      core,
      mySlot: 0,
      players: [0],
      inputDelay: 0,
      startFrame: 0,
      sendInput: () => {},
      now,
    });

    for (let i = 0; i < 5; i++) lockstep.tick([0x01, 0, 0, 0]);

    // `now` is only consulted once the loop is blocked; the emulation path
    // (core.step) receives frame numbers and masks, nothing else.
    expect(core.steps).toHaveLength(5);
  });
});

function encodePeer(player: number, frame: number, inputs: number[]): Uint8Array {
  return encodeInput({
    version: PROTOCOL_VERSION,
    player,
    ackFrame: 0,
    firstFrame: frame,
    inputs,
  });
}
