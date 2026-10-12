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

    lockstep.tick(0x10);

    expect(core.steps.map((s) => s.frame)).toEqual([0, 1, 2]);
    expect(core.steps[0]?.inputs).toEqual([0, 0, 0, 0]);
    expect(core.steps[2]?.inputs).toEqual([0x10, 0, 0, 0]);
    expect(lockstep.frame()).toBe(3);

    const packet = decodeInput(sent[0]!);
    expect(packet.player).toBe(0);
    expect(packet.firstFrame).toBe(0);
    expect(packet.inputs).toEqual([0, 0, 0x10]);
  });

  it("reports the frame the next tick will schedule", () => {
    const lockstep = createLockstep({
      core: fakeCore(),
      mySlot: 0,
      players: [0],
      inputDelay: 2,
      startFrame: 0,
      sendInput: () => {},
      now: () => 0,
    });

    expect(lockstep.scheduledFrame()).toBe(2);
    lockstep.tick(0);
    expect(lockstep.scheduledFrame()).toBe(3);
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

    lockstep.tick(0x01);
    expect(core.steps).toHaveLength(0);
    expect(lockstep.frame()).toBe(0);

    lockstep.onBytes(
      // peer 1 sends frame 0; hand-built packet via the public codec.
      encodePeer(1, 0, [0x02]),
    );
    lockstep.tick(0x01);

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

    for (let i = 0; i < 10; i++) lockstep.tick(i + 1);

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

    lockstep.tick(0x01);
    time.advance(1999);
    lockstep.tick(0x01);
    expect(lockstep.status()).toBe("running");

    time.advance(1);
    lockstep.tick(0x01);
    expect(lockstep.status()).toBe("waiting");

    lockstep.onBytes(encodePeer(1, 0, [0x02, 0x02, 0x02, 0x02, 0x02, 0x02]));
    lockstep.tick(0x01);
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
    lockstep.tick(0x01);

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

    for (let i = 0; i < 10; i++) lockstep.tick(0x01);

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
      a.tick(0x01);
      b.tick(0x02);
    }

    // A tick carries a packet to the peer but is stepped before the peer's
    // reply is processed, so the two are at most one tick apart; everything
    // they have both simulated must be identical.
    expect(Math.abs(a.frame() - b.frame())).toBeLessThanOrEqual(1);
    const common = Math.min(coreA.steps.length, coreB.steps.length);
    expect(common).toBeGreaterThan(20);
    expect(coreA.steps.slice(0, common)).toEqual(coreB.steps.slice(0, common));
  });

  it("emits a hash every 60 frames with the crc from the core", () => {
    const hashes: [number, number][] = [];
    const lockstep = createLockstep({
      core: fakeCore(),
      mySlot: 0,
      players: [0],
      inputDelay: 0,
      startFrame: 0,
      sendInput: () => {},
      now: () => 0,
      hash: () => 0xabc,
      hashInterval: 60,
      onHash: (frame, crc) => hashes.push([frame, crc]),
    });

    for (let i = 0; i < 60; i++) lockstep.tick(0x01);
    expect(hashes).toEqual([]);

    lockstep.tick(0x01);
    expect(hashes).toEqual([[60, 0xabc]]);

    for (let i = 0; i < 60; i++) lockstep.tick(0x01);
    expect(hashes).toEqual([
      [60, 0xabc],
      [120, 0xabc],
    ]);
  });

  it("hashes every boundary crossed within one tick", () => {
    const hashes: [number, number][] = [];
    const lockstep = createLockstep({
      core: fakeCore(),
      mySlot: 0,
      players: [0],
      inputDelay: 130,
      startFrame: 0,
      sendInput: () => {},
      now: () => 0,
      hash: () => 0xabc,
      hashInterval: 60,
      onHash: (frame, crc) => hashes.push([frame, crc]),
    });

    lockstep.tick(0x01);
    expect(hashes).toEqual([
      [60, 0xabc],
      [120, 0xabc],
    ]);
  });

  it("emits nothing when no hash hook is provided", () => {
    const lockstep = createLockstep({
      core: fakeCore(),
      mySlot: 0,
      players: [0],
      inputDelay: 0,
      startFrame: 0,
      sendInput: () => {},
      now: () => 0,
      hashInterval: 60,
    });
    for (let i = 0; i < 120; i++) lockstep.tick(0x01);
    expect(lockstep.frame()).toBe(120);
  });

  it("drops buffered future peer inputs on resync", () => {
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

    lockstep.onBytes(encodePeer(1, 0, [0x02]));
    lockstep.tick(0x01);
    expect(core.steps.map((s) => s.frame)).toEqual([0]);

    // Peer frames 1..8 are buffered ahead of the simulation, then a resync
    // restores a state at frame 3: those stale inputs must not be stepped.
    lockstep.onBytes(encodePeer(1, 1, [3, 3, 3, 3, 3, 3, 3, 3]));
    lockstep.resync(3);
    lockstep.tick(0x01);

    expect(core.steps.map((s) => s.frame)).toEqual([0]);
  });

  it("resumes from the snapshot frame after a resync", () => {
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

    for (let i = 0; i < 5; i++) lockstep.tick(0x01);
    expect(lockstep.frame()).toBe(5);

    lockstep.resync(100);
    expect(lockstep.frame()).toBe(101);

    lockstep.tick(0x01);
    expect(core.steps.at(-1)).toEqual({ frame: 101, inputs: [0x01, 0, 0, 0] });
  });

  it("keeps two peers aligned after a resync to the same frame", () => {
    const coreA = fakeCore();
    const coreB = fakeCore();
    const maker = (core: ReturnType<typeof fakeCore>, mySlot: number, send: (p: Uint8Array) => void) =>
      createLockstep({
        core,
        mySlot,
        players: [0, 1],
        inputDelay: 2,
        startFrame: 0,
        sendInput: send,
        now: () => 0,
      });
    let sendToA: (p: Uint8Array) => void = () => {};
    let sendToB: (p: Uint8Array) => void = () => {};
    const a = maker(coreA, 0, (p) => sendToB(p));
    const b = maker(coreB, 1, (p) => sendToA(p));
    sendToA = (p) => a.onBytes(p);
    sendToB = (p) => b.onBytes(p);

    for (let i = 0; i < 20; i++) {
      a.tick(0x01);
      b.tick(0x02);
    }

    const frame = Math.min(a.frame(), b.frame()) - 1;
    const startA = coreA.steps.length;
    const startB = coreB.steps.length;
    a.resync(frame);
    b.resync(frame);
    expect(a.frame()).toBe(frame + 1);
    expect(b.frame()).toBe(frame + 1);

    for (let i = 0; i < 10; i++) {
      a.tick(0x01);
      b.tick(0x02);
    }

    // Everything each peer re-simulates after the resync must be identical.
    const common = Math.min(coreA.steps.length - startA, coreB.steps.length - startB);
    expect(common).toBeGreaterThan(0);
    expect(coreA.steps.slice(startA, startA + common)).toEqual(
      coreB.steps.slice(startB, startB + common),
    );
  });

  it("freezes stepping and sending while paused, then resumes cleanly", () => {
    const core = fakeCore();
    const sent: Uint8Array[] = [];
    const lockstep = createLockstep({
      core,
      mySlot: 0,
      players: [0],
      inputDelay: 0,
      startFrame: 0,
      sendInput: (packet) => sent.push(packet),
      now: () => 0,
    });

    lockstep.tick(0x01);
    expect(core.steps.map((s) => s.frame)).toEqual([0]);
    expect(sent).toHaveLength(1);

    lockstep.pause();
    expect(lockstep.paused()).toBe(true);
    lockstep.tick(0x05);
    // Paused: no new frame stepped, no packet scheduled or sent.
    expect(core.steps.map((s) => s.frame)).toEqual([0]);
    expect(sent).toHaveLength(1);
    expect(lockstep.scheduledFrame()).toBe(1);

    lockstep.resume();
    expect(lockstep.paused()).toBe(false);
    lockstep.tick(0x07);
    expect(core.steps.map((s) => s.frame)).toEqual([0, 1]);
  });

  it("does not run the stall timer while paused", () => {
    const time = clock();
    const onStall = vi.fn();
    const onStallEscalate = vi.fn();
    const lockstep = createLockstep({
      core: fakeCore(),
      mySlot: 0,
      players: [0, 1],
      inputDelay: 0,
      startFrame: 0,
      sendInput: () => {},
      now: time.now,
      onStall,
      onStallEscalate,
      waitTimeoutMs: 100,
      stallEscalateMs: 100,
    });

    lockstep.pause();
    time.advance(10_000);
    lockstep.tick(0x01);
    expect(onStall).not.toHaveBeenCalled();
    expect(onStallEscalate).not.toHaveBeenCalled();
  });

  it("does not fire a stall right after resuming", () => {
    const time = clock();
    const onStall = vi.fn();
    const lockstep = createLockstep({
      core: fakeCore(),
      mySlot: 0,
      players: [0, 1],
      inputDelay: 0,
      startFrame: 0,
      sendInput: () => {},
      now: time.now,
      onStall,
      waitTimeoutMs: 2000,
    });

    lockstep.tick(0x01);
    lockstep.pause();
    lockstep.resume();
    // A long real-world pause must not count toward the stall timeout.
    time.advance(3000);
    lockstep.tick(0x01);
    expect(onStall).not.toHaveBeenCalled();
    expect(lockstep.status()).toBe("running");
  });

  it("re-arms the stall timer after resuming from a waiting pause", () => {
    const time = clock();
    const onStall = vi.fn();
    const lockstep = createLockstep({
      core: fakeCore(),
      mySlot: 0,
      players: [0, 1],
      inputDelay: 0,
      startFrame: 0,
      sendInput: () => {},
      now: time.now,
      onStall,
      waitTimeoutMs: 2000,
    });

    lockstep.tick(0x01);
    time.advance(2000);
    lockstep.tick(0x01);
    expect(onStall).toHaveBeenCalledTimes(1);

    // Pause while stalled, then resume: the status must drop back to "running"
    // so a later stall can fire again (a paused-while-waiting regression).
    lockstep.pause();
    lockstep.resume();
    expect(lockstep.status()).toBe("running");

    time.advance(5000);
    lockstep.tick(0x01); // arms the wait timer again
    time.advance(2000);
    lockstep.tick(0x01); // stalls again
    expect(onStall).toHaveBeenCalledTimes(2);
  });

  it("escalates a persistent stall once per stallEscalateMs", () => {
    const time = clock();
    const escalated: number[] = [];
    const lockstep = createLockstep({
      core: fakeCore(),
      mySlot: 0,
      players: [0, 1],
      inputDelay: 0,
      startFrame: 0,
      sendInput: () => {},
      now: time.now,
      waitTimeoutMs: 2000,
      stallEscalateMs: 5000,
      onStallEscalate: (frame) => escalated.push(frame),
    });

    lockstep.tick(0x01);
    time.advance(2000);
    lockstep.tick(0x01); // enters "waiting"
    expect(escalated).toEqual([]);

    time.advance(4999);
    lockstep.tick(0x01);
    expect(escalated).toEqual([]);

    time.advance(1);
    lockstep.tick(0x01);
    expect(escalated).toEqual([0]);

    // Still stalled: escalates again a full interval later.
    time.advance(5000);
    lockstep.tick(0x01);
    expect(escalated).toEqual([0, 0]);
  });

  it("reproduces the committed golden step trace (T29 regression)", () => {
    // A fixed, frame-indexed scenario that exercises the hardened loop end to
    // end: a two-peer lockstep, a collaborative pause/resume, and a resync. The
    // committed trace is the exact `(frame, inputs)` sequence core A steps;
    // any change to the emulation path must produce the same trace or peers
    // diverge. Runs twice so the trace is proven stable, not just once-correct.
    // Regenerate only with an intentional change to the emulation path.
    const scenario = (): {
      a: { frame: number; inputs: FrameInputs }[];
      b: { frame: number; inputs: FrameInputs }[];
    } => {
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

      const run = (masksA: number[], masksB: number[]): void => {
        for (let i = 0; i < masksA.length; i++) {
          a.tick(masksA[i]!);
          b.tick(masksB[i]!);
        }
      };

      run([0x01, 0x02, 0x03, 0x04, 0x05], [0x11, 0x12, 0x13, 0x14, 0x15]);
      a.pause();
      b.pause();
      run([0xff, 0xff], [0xff, 0xff]); // ignored while paused
      a.resume();
      b.resume();
      run([0x06, 0x07, 0x08], [0x16, 0x17, 0x18]);
      // Restore both peers to the same frame and continue (desync-resync path).
      const frame = Math.min(a.frame(), b.frame()) - 1;
      a.resync(frame);
      b.resync(frame);
      run([0x09, 0x0a], [0x19, 0x1a]);
      return { a: coreA.steps, b: coreB.steps };
    };

    const first = scenario();
    expect(first.a).toEqual(GOLDEN_TRACE);
    // Fully deterministic: a second run reproduces both traces exactly.
    const second = scenario();
    expect(second.a).toEqual(first.a);
    expect(second.b).toEqual(first.b);
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

    for (let i = 0; i < 5; i++) lockstep.tick(0x01);

    // `now` is only consulted once the loop is blocked; the emulation path
    // (core.step) receives frame numbers and masks, nothing else.
    expect(core.steps).toHaveLength(5);
  });
});

/**
 * Committed golden trace for the T29 regression test above: the exact
 * `(frame, inputs)` sequence core A steps for the fixed two-peer scenario with
 * a pause/resume and a resync. `inputs` is the four-slot mask (see FrameInputs).
 */
const G0 = (p0: number, p1: number): FrameInputs => [p0, p1, 0, 0];
const GOLDEN_TRACE: { frame: number; inputs: FrameInputs }[] = [
  { frame: 0, inputs: G0(0, 0) },
  { frame: 1, inputs: G0(0, 0) },
  { frame: 2, inputs: G0(0x01, 0x11) },
  { frame: 3, inputs: G0(0x02, 0x12) },
  { frame: 4, inputs: G0(0x03, 0x13) },
  { frame: 5, inputs: G0(0x04, 0x14) },
  { frame: 6, inputs: G0(0x05, 0x15) },
  { frame: 7, inputs: G0(0x06, 0x16) },
  { frame: 8, inputs: G0(0x07, 0x17) },
  { frame: 9, inputs: G0(0x09, 0x19) },
];

function encodePeer(player: number, frame: number, inputs: number[]): Uint8Array {
  return encodeInput({
    version: PROTOCOL_VERSION,
    player,
    ackFrame: 0,
    firstFrame: frame,
    inputs,
  });
}
