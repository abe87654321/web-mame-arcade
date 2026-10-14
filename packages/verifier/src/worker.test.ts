import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { INPUT_LOG_VERSION, encodeInputLog, type InputLog } from "@wma/protocol";
import type { SlotScore } from "./job";
import type { VerifyJob } from "./job";
import type { PgPool } from "./db";
import { analyzeLog, ensureMatch, processJob, type WorkerOptions } from "./worker";

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

describe("analyzeLog / processJob anti-cheat (T36)", () => {
  const HASH = "a".repeat(64);
  const dirs: string[] = [];

  async function writeLog(col: number[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "wma-antichat-"));
    dirs.push(dir);
    const log: InputLog = {
      v: INPUT_LOG_VERSION,
      room: "room-abc",
      meta: {
        driver: "gridlee",
        core_hash: HASH,
        mame_commit: "b".repeat(40),
        rom_hash: HASH,
        dips: {},
        mode: "solo",
      },
      start: {
        frame: 0,
        input_delay: 0,
        players: [{ slot: 0, name: "alice" }],
        start_state_key: null,
      },
      end: { frame: col.length - 1, scores: [] },
      frames: col.map((mask) => [mask]),
    };
    const key = join("match", "room-abc", "1234.json.gz");
    await mkdir(dirname(join(dir, key)), { recursive: true });
    await writeFile(join(dir, key), gzipSync(encodeInputLog(log)));
    return dir;
  }

  function makePool() {
    const sqls: string[] = [];
    const pool: PgPool = {
      async query(sql) {
        sqls.push(sql);
        if (sql.includes("INSERT INTO games")) return { rows: [{ id: "7" }] };
        if (sql.includes("INSERT INTO matches")) return { rows: [{ id: "99" }] };
        return { rows: [] };
      },
      async end() {},
    };
    return { pool, sqls };
  }

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("records match_flags for a periodic log", async () => {
    const logDir = await writeLog(Array.from({ length: 800 }, (_, i) => i % 2));
    const { pool, sqls } = makePool();
    const opts: WorkerOptions = {
      redisUrl: "redis://localhost",
      mameBin: "/nonexistent/mame",
      romDir: "/roms",
      scoremapDir: "/scoremap",
      logDir,
      pgPool: pool,
      pinnedMameCommit: "b".repeat(40),
    };

    await processJob(opts, sampleJob);
    expect(sqls.some((sql) => sql.includes("INSERT INTO match_flags"))).toBe(true);
  });

  it("only writes match_flags — never a score or a status change (advisory)", async () => {
    const logDir = await writeLog(Array.from({ length: 800 }, (_, i) => i % 2));
    const { pool, sqls } = makePool();

    await analyzeLog({ logDir, pgPool: pool }, sampleJob, 99n);

    expect(sqls.some((sql) => sql.includes("INSERT INTO match_flags"))).toBe(true);
    expect(sqls.some((sql) => sql.includes("INSERT INTO scores"))).toBe(false);
    expect(sqls.some((sql) => sql.includes("UPDATE matches"))).toBe(false);
  });

  it("records no flags for a varied log", async () => {
    const holds = [3, 7, 4, 11, 5, 2, 8, 6];
    const col: number[] = [];
    for (let i = 0; col.length < 800; i++) {
      for (let k = 0; k < holds[i % holds.length]! && col.length < 800; k++) col.push(1);
      for (let k = 0; k < holds[(i * 3 + 1) % holds.length]! && col.length < 800; k++) col.push(0);
    }
    const logDir = await writeLog(col);
    const { pool, sqls } = makePool();
    const opts: WorkerOptions = {
      redisUrl: "redis://localhost",
      mameBin: "/nonexistent/mame",
      romDir: "/roms",
      scoremapDir: "/scoremap",
      logDir,
      pgPool: pool,
      pinnedMameCommit: "b".repeat(40),
    };

    await processJob(opts, sampleJob);
    expect(sqls.some((sql) => sql.includes("INSERT INTO match_flags"))).toBe(false);
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
