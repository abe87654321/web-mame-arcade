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

describe("match upsert (T34)", async () => {
  const { getOrCreateGame, upsertMatch, upsertMatchPlayers } = await import("./db");
  beforeEach(() => mockQuery.mockReset());

  it("upserts a game and returns its id", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "7" }] });
    const id = await getOrCreateGame(mockPool, { driver: "gridlee", coreVersion: "a".repeat(64) });
    expect(id).toBe(7);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (driver) DO UPDATE SET core_version"),
      ["gridlee", "a".repeat(64)],
    );
  });

  it("upserts a match by replay_key and returns its id", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "99" }] });
    const id = await upsertMatch(mockPool, {
      gameId: 7,
      mode: "solo",
      coreVersion: "a".repeat(64),
      mameCommit: "b".repeat(40),
      romHash: "c".repeat(64),
      dips: { Difficulty: "Medium" },
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:05:00.000Z",
      replayKey: "match/room/1.json.gz",
      status: "ended",
    });
    expect(id).toBe(99n);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("ON CONFLICT (replay_key) DO UPDATE");
    expect(params[5]).toBe(JSON.stringify({ Difficulty: "Medium" }));
    expect(params[8]).toBe("match/room/1.json.gz");
  });

  it("links players idempotently", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await upsertMatchPlayers(mockPool, 99n, [
      { slot: 0, userId: "42" },
      { slot: 1, userId: "43" },
    ]);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (match_id, slot) DO NOTHING"),
      [99n, "42", 0],
    );
  });
});
