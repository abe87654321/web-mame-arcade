import { describe, expect, it } from "vitest";
import { deserializeJob, redisJobKey, serializeJob } from "./redis-queue";
import type { VerifyJob } from "./job";

const sampleJob: VerifyJob = {
  room: "room-abc",
  replayKey: "match/room-abc/1234.json.gz",
  driver: "gridlee",
  coreHash:
    "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  mameCommit: "b67e5bcb0b895c0e451e342068b6651af1307d0d",
};

describe("redis-queue", () => {
  describe("redisJobKey", () => {
    it("returns the verify:jobs list key", () => {
      expect(redisJobKey()).toBe("verify:jobs");
    });
  });

  describe("serializeJob / deserializeJob", () => {
    it("round-trips a VerifyJob", () => {
      const json = serializeJob(sampleJob);
      const parsed = deserializeJob(json);
      expect(parsed).toEqual(sampleJob);
    });

    it("throws on malformed JSON", () => {
      expect(() => deserializeJob("not json")).toThrow();
    });
  });
});
