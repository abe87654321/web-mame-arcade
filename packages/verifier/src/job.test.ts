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
    };
    expect(job.room).toBe("room-abc");
    expect(job.driver).toBe("gridlee");
  });

  it("SlotScore has required fields", () => {
    const score: SlotScore = { slot: 0, score: 12345 };
    expect(score.slot).toBe(0);
    expect(score.score).toBe(12345);
  });
});
