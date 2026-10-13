import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PgPool } from "./db";

const mockQuery = vi.fn();

const mockPool: PgPool = {
  async query(sql, params) {
    return mockQuery(sql, params) as Promise<{ rows: unknown[] }>;
  },
  async end() {},
};

describe("db module", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  describe("insertVerifiedScore", async () => {
    const { insertVerifiedScore } = await import("./db");

    it("inserts a score with ON CONFLICT DO NOTHING", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await insertVerifiedScore(mockPool, 1n, 2n, 3, 10000n);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO scores"),
        [1n, 2n, 3, 10000n],
      );
    });
  });

  describe("flagMatch", async () => {
    const { flagMatch } = await import("./db");

    it("updates match status to flagged", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await flagMatch(mockPool, "match/room/123.json.gz");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE matches SET status = 'flagged'"),
        ["match/room/123.json.gz"],
      );
    });
  });

  describe("markMatchVerified", async () => {
    const { markMatchVerified } = await import("./db");

    it("updates match status to verified", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await markMatchVerified(mockPool, "match/room/123.json.gz");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE matches SET status = 'verified'"),
        ["match/room/123.json.gz"],
      );
    });
  });

  describe("findMatchByReplayKey", async () => {
    const { findMatchByReplayKey } = await import("./db");

    it("returns null when no match found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await findMatchByReplayKey(mockPool, "match/room/123.json.gz");
      expect(result).toBeNull();
    });

    it("returns match info when found", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: "42", game_id: "7" }],
      });
      const result = await findMatchByReplayKey(mockPool, "match/room/123.json.gz");
      expect(result).toEqual({
        matchId: 42n,
        gameId: 7,
        userId: 0n,
      });
    });
  });

  describe("getMatchPlayers", async () => {
    const { getMatchPlayers } = await import("./db");

    it("returns players ordered by slot", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { user_id: "100", slot: 0 },
          { user_id: "101", slot: 1 },
        ],
      });
      const result = await getMatchPlayers(mockPool, 42n);
      expect(result).toEqual([
        { userId: 100n, slot: 0 },
        { userId: 101n, slot: 1 },
      ]);
    });
  });
});
