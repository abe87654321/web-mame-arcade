import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PgPool } from "./pg";
import {
  createUser,
  findGameByDriver,
  findUserByName,
  getMatch,
  listBoard,
  listGames,
  upsertGame,
} from "./db";

const mockQuery = vi.fn();
const pool: PgPool = {
  async query(sql, params) {
    return mockQuery(sql, params) as Promise<{ rows: unknown[] }>;
  },
  async end() {},
};

beforeEach(() => mockQuery.mockReset());

describe("users", () => {
  it("createUser returns the mapped row", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "5", name: "alice", password_hash: "scrypt$aa$bb", country: null }],
    });
    const user = await createUser(pool, "alice", "scrypt$aa$bb");
    expect(user).toEqual({
      id: 5n,
      name: "alice",
      passwordHash: "scrypt$aa$bb",
      country: null,
    });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO users"),
      ["alice", "scrypt$aa$bb"],
    );
  });

  it("findUserByName returns null when missing", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await findUserByName(pool, "ghost")).toBeNull();
  });
});

describe("games", () => {
  it("listGames maps rows", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          driver: "gridlee",
          title: "Gridlee",
          core_version: "a".repeat(64),
          supports_save: true,
          netplay_mode: "lockstep",
          max_players: 2,
          rom_licensed: true,
        },
      ],
    });
    const games = await listGames(pool);
    expect(games[0]).toMatchObject({ driver: "gridlee", coreVersion: "a".repeat(64) });
  });

  it("findGameByDriver returns null when missing", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await findGameByDriver(pool, "nope")).toBeNull();
  });

  it("upsertGame passes catalogue fields in order", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await upsertGame(pool, {
      driver: "gridlee",
      title: "Gridlee",
      coreVersion: "c".repeat(64),
      supportsSave: true,
      netplayMode: "lockstep",
      maxPlayers: 2,
      romLicensed: true,
    });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (driver) DO UPDATE"),
      ["gridlee", "Gridlee", "c".repeat(64), true, "lockstep", 2, true],
    );
  });
});

describe("leaderboard", () => {
  it("filters by game and optional since, ordered by score", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          score: "100",
          user_id: "5",
          user_name: "alice",
          match_id: "9",
          replay_key: "match/r/1.json.gz",
          verified_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const board = await listBoard(pool, 1, "2026-01-01T00:00:00.000Z", 50);
    expect(board[0]).toEqual({
      score: 100n,
      userId: 5n,
      userName: "alice",
      matchId: 9n,
      replayKey: "match/r/1.json.gz",
      achievedAt: "2026-01-01T00:00:00.000Z",
    });
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("ORDER BY s.score DESC");
    expect(params).toEqual([1, "2026-01-01T00:00:00.000Z", 50]);
  });
});

describe("getMatch", () => {
  it("returns null when the match is missing", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getMatch(pool, 1n)).toBeNull();
  });

  it("returns match, players and scores", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: "9",
            game_id: 1,
            driver: "gridlee",
            mode: "solo",
            core_version: "c".repeat(64),
            mame_commit: "b".repeat(40),
            rom_hash: "d".repeat(64),
            dip_settings: {},
            started_at: "2026-01-01T00:00:00.000Z",
            ended_at: "2026-01-01T00:05:00.000Z",
            replay_key: "match/r/1.json.gz",
            status: "verified",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ slot: 0, user_id: "5", name: "alice" }],
      })
      .mockResolvedValueOnce({
        rows: [{ user_id: "5", score: "100", verified_at: "2026-01-01T00:06:00.000Z" }],
      });

    const detail = await getMatch(pool, 9n);
    expect(detail?.match).toMatchObject({ id: 9n, driver: "gridlee", status: "verified" });
    expect(detail?.players).toEqual([{ slot: 0, userId: 5n, name: "alice" }]);
    expect(detail?.scores).toEqual([
      { userId: 5n, score: 100n, verifiedAt: "2026-01-01T00:06:00.000Z" },
    ]);
  });
});
