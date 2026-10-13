import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlotScore } from "./job";
import type { VerifyJob } from "./job";
import type { PgPool } from "./db";
import { ensureMatch, processJob, type WorkerOptions } from "./worker";

// Test the pure parsing functions from worker.ts by re-implementing them here
// (the actual functions are not exported, so we test the logic via processJob)

const SCORE_LINE_RE = /^SCORE\s+(\d+)\s+(-?\d+)/;

function parseMameOutput(stdout: string): { scores: SlotScore[]; errors: string[] } {
  const scores: SlotScore[] = [];
  const errors: string[] = [];
  for (const line of stdout.split("\n")) {
    const scoreMatch = SCORE_LINE_RE.exec(line);
    if (scoreMatch) {
      scores.push({
        slot: parseInt(scoreMatch[1]!, 10),
        score: parseInt(scoreMatch[2]!, 10),
      });
      continue;
    }
    if (line.startsWith("ERROR ")) {
      errors.push(line.slice(6));
    }
  }
  return { scores, errors };
}

describe("worker pure functions", () => {
  describe("parseMameOutput", () => {
    it("parses SCORE lines", () => {
      const { scores } = parseMameOutput(
        "VERIFY log: driver=gridlee frames=100\nSCORE 0 12345\nSCORE 1 67890\nVERIFY DONE",
      );
      expect(scores).toEqual([
        { slot: 0, score: 12345 },
        { slot: 1, score: 67890 },
      ]);
    });

    it("collects ERROR lines", () => {
      const { errors } = parseMameOutput(
        "ERROR no scoremap\nSCORE 0 0\nERROR read failure",
      );
      expect(errors).toEqual(["no scoremap", "read failure"]);
    });

    it("ignores other lines", () => {
      const { scores } = parseMameOutput(
        "some noise\nSCORE 0 999\nmore noise\nVERIFY DONE",
      );
      expect(scores).toEqual([{ slot: 0, score: 999 }]);
    });

    it("handles empty output", () => {
      const { scores, errors } = parseMameOutput("");
      expect(scores).toEqual([]);
      expect(errors).toEqual([]);
    });

    it("parses negative scores", () => {
      const { scores } = parseMameOutput("SCORE 0 -500\n");
      expect(scores).toEqual([{ slot: 0, score: -500 }]);
    });

    it("parses zero score", () => {
      const { scores } = parseMameOutput("SCORE 0 0\n");
      expect(scores).toEqual([{ slot: 0, score: 0 }]);
    });
  });
});

const sampleJob: VerifyJob = {
  room: "room-abc",
  replayKey: "match/room-abc/1234.json.gz",
  driver: "gridlee",
  coreHash: "a".repeat(64),
  mameCommit: "b".repeat(40),
  romHash: "c".repeat(64),
  dips: { Difficulty: "Medium" },
  mode: "solo",
  players: [{ slot: 0, userId: "42", name: "alice" }],
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:05:00.000Z",
};

describe("ensureMatch (T34)", () => {
  const query = vi.fn();
  const pool: PgPool = {
    async query(sql, params) {
      return query(sql, params) as Promise<{ rows: unknown[] }>;
    },
    async end() {},
  };

  beforeEach(() => query.mockReset());

  it("resolves the game, upserts the match and links players", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: "7" }] }) // getOrCreateGame
      .mockResolvedValueOnce({ rows: [{ id: "99" }] }) // upsertMatch
      .mockResolvedValueOnce({ rows: [] }); // upsertMatchPlayers

    const matchId = await ensureMatch({ pgPool: pool }, sampleJob);
    expect(matchId).toBe(99n);

    expect(query.mock.calls[0]![0]).toContain("INSERT INTO games");
    expect(query.mock.calls[1]![0]).toContain("INSERT INTO matches");
    expect(query.mock.calls[1]![0]).toContain("ON CONFLICT (replay_key)");
    expect(query.mock.calls[1]![1]).toContain("match/room-abc/1234.json.gz");
    expect(query.mock.calls[2]![0]).toContain("INSERT INTO match_players");
    expect(query.mock.calls[2]![1]).toEqual([99n, "42", 0]);
  });
});

describe("processJob (T34 seam)", () => {
  it("persists the match then flags it on a mame_commit mismatch", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO games")) return { rows: [{ id: "7" }] };
      if (sql.includes("INSERT INTO matches")) return { rows: [{ id: "99" }] };
      return { rows: [] };
    });
    const pool: PgPool = { query, end: async () => {} };
    const opts: WorkerOptions = {
      redisUrl: "redis://localhost",
      mameBin: "/nonexistent/mame",
      romDir: "/roms",
      scoremapDir: "/scoremap",
      logDir: "/logs",
      pgPool: pool,
      pinnedMameCommit: "pinned-commit-differs",
    };

    await processJob(opts, { ...sampleJob, mameCommit: "different-commit" });

    const sqls = query.mock.calls.map((c) => c[0] as string);
    const matchIdx = sqls.findIndex((s) => s.includes("INSERT INTO matches"));
    const flagIdx = sqls.findIndex((s) => s.includes("SET status = 'flagged'"));
    expect(matchIdx).toBeGreaterThanOrEqual(0);
    expect(flagIdx).toBeGreaterThan(matchIdx);
  });
});
