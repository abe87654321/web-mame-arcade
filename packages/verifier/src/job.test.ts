import { describe, expect, it } from "vitest";
import type { VerifyJob, SlotScore } from "./job";

describe("job types", () => {
  it("VerifyJob has required fields", () => {
    const job: VerifyJob = {
      room: "room-abc",
      replayKey: "match/room-abc/123.json.gz",
      driver: "gridlee",
      coreHash:
        "a".repeat(64),
      mameCommit: "b".repeat(40),
      romHash: "c".repeat(64),
      dips: { Difficulty: "Medium" },
      mode: "solo",
      players: [{ slot: 0, userId: "42", name: "alice" }],
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:05:00.000Z",
    };
    expect(job.room).toBe("room-abc");
    expect(job.driver).toBe("gridlee");
    expect(job.players[0]!.userId).toBe("42");
  });

  it("SlotScore has required fields", () => {
    const score: SlotScore = { slot: 0, score: 12345 };
    expect(score.slot).toBe(0);
    expect(score.score).toBe(12345);
  });
});
